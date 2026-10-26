import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createActivityMessages, messageText, periodBuckets, statusGroup, statusReason } from '../src/activity-messages.mjs';
import { createAsbServer } from '../src/asb-server.mjs';
import { createMachineGroup, saveGroup } from '../src/machine-group.mjs';
import { exportBody, exportLocalSessions, mergePeerRows, validActivity, validExport } from '../src/machine-peers.mjs';
import { buildSwitchboardDashboard, createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

// Synthetic IDs, names, and texts only.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const msg = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nowMs = Date.parse('2026-10-20T12:30:00.000Z');
const seconds = (ms) => Math.floor(ms / 1000);
const A = { machineId: 'a'.repeat(16), name: 'engine-a' };
const B = { machineId: 'b'.repeat(16), name: 'engine-b' };
// Codex tasks X (1) and Y (2), a Claude Desktop Code session (4) with the CLI session ID 3, and an OpenCode session.
const X = uuid(1), Y = uuid(2), CLI = uuid(3), STRANGER = uuid(99);
const CLAUDE_ROW = `claude-desktop-code:local_${uuid(4)}`;
const threads = () => [
  { id: X, externalId: X, provider: 'codex', title: 'beta task', updatedAtMs: nowMs },
  { id: Y, externalId: Y, provider: 'codex', title: 'Alpha task', updatedAtMs: nowMs },
  { id: CLAUDE_ROW, externalId: `local_${uuid(4)}`, provider: 'claude-desktop-code', source: 'claude-desktop-code', cliSessionId: CLI,
    title: 'Claude task', updatedAtMs: nowMs },
];
const board = (machine = A) => buildSwitchboardDashboard(threads(), [], nowMs, { machineId: machine.machineId, machineName: machine.name });

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-activity-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sources = [{ id: 'codex', provider: 'codex', dataDir: path.join(dir, 'codex'), enabled: true },
    { id: 'claude', provider: 'claude-desktop-code', dataDir: path.join(dir, 'claude'), enabled: true },
    { id: 'opencode', provider: 'opencode', dataDir: path.join(dir, 'opencode'), enabled: true },
    { id: 'off', provider: 'codex', dataDir: path.join(dir, 'off'), enabled: false }];
  const folder = (source) => path.join(source === 'opencode' ? path.join(dir, 'oc-state') : path.join(dir, source), 'plugin-state', 'asb-bridge');
  // One bridge database like bridge/src/bridge.ts makes: `kind: false` makes the table of an older bridge.
  const bridge = async (source, owner, rows, { kind = true } = {}) => {
    await mkdir(folder(source), { recursive: true });
    const database = new DatabaseSync(path.join(folder(source), `${owner}.sqlite`));
    database.exec(`create table if not exists messages (id text primary key, peer_id text not null, direction text not null, text text not null,
      status text not null, turn_id text, created_at integer not null${kind ? ", kind text not null default 'message', status_reason text" : ''});`);
    const insert = database.prepare(kind ? 'insert into messages (id, peer_id, direction, text, status, created_at, kind, status_reason) values (?, ?, ?, ?, ?, ?, ?, ?)'
      : 'insert into messages (id, peer_id, direction, text, status, created_at) values (?, ?, ?, ?, ?, ?)');
    for (const row of rows) {
      const values = [row.id, row.peer, row.direction, row.text ?? 'Synthetic text.', row.status, seconds(row.atMs ?? nowMs - 60_000)];
      insert.run(...(kind ? [...values, row.kind ?? 'message', row.reason ?? null] : values));
    }
    database.close();
  };
  const service = (extra = {}) => createActivityMessages({ readSources: async () => sources, dashboard: async () => board(), machine: () => A,
    now: () => nowMs, openCodeStateDir: () => path.join(dir, 'oc-state'), ...extra });
  return { dir, sources, bridge, service, folder };
}

test('a bridge to bridge message with an out row and an in row is one record, and the receiver status wins', async (t) => {
  const { bridge, service } = await home(t);
  await bridge('codex', X, [{ id: msg(1), peer: Y, direction: 'out', status: 'socket-written', atMs: nowMs - 60_000 }]);
  await bridge('codex', Y, [{ id: msg(1), peer: X, direction: 'in', status: 'steered', atMs: nowMs - 59_000 }]);
  const report = await service().report('7d');
  assert.deepEqual(report.messages, [{ id: msg(1), from: X, to: Y, atMs: seconds(nowMs - 60_000) * 1000, status: 'accepted', reason: '', local: true }]);
  assert.deepEqual(await service().localRecords('7d'), [{ id: msg(1), from: X, to: Y, atMs: seconds(nowMs - 60_000) * 1000, status: 'accepted',
    reason: '', direction: 'both' }]);
});

test('Claude endpoints count: a message from Claude has only the in row, a message to Claude only the out row', async (t) => {
  const { bridge, service } = await home(t);
  await bridge('codex', Y, [{ id: msg(2), peer: CLI, direction: 'in', status: 'started' }]);
  await bridge('codex', X, [{ id: msg(3), peer: CLI, direction: 'out', status: 'socket-written', atMs: nowMs - 30_000 }]);
  const report = await service().report('24h');
  assert.deepEqual(report.messages.map(({ id, from, to, status }) => [id, from, to, status]),
    [[msg(2), CLAUDE_ROW, Y, 'accepted'], [msg(3), X, CLAUDE_ROW, 'written']]);
  assert.deepEqual(report.seats.find((seat) => seat.id === CLAUDE_ROW), { id: CLAUDE_ROW, title: 'Claude task', app: 'claude', machineId: A.machineId, order: 2 });
});

test('idle notices stay out, and a file with no kind column counts every row', async (t) => {
  const { bridge, service } = await home(t);
  await bridge('codex', X, [{ id: msg(4), peer: Y, direction: 'out', status: 'delivered' },
    { id: msg(5), peer: Y, direction: 'out', status: 'delivered', kind: 'idle-notice' },
    { id: msg(6), peer: Y, direction: 'out', status: 'delivered', kind: 'subscription-expired' }]);
  await bridge('claude', uuid(7), [{ id: msg(8), peer: X, direction: 'in', status: 'held' }, { id: msg(9), peer: X, direction: 'out', status: 'not-sent' }], { kind: false });
  const messages = (await service().report('7d')).messages;
  assert.deepEqual(messages.map((item) => [item.id, item.status, item.reason]).sort(),
    [[msg(4), 'accepted', ''], [msg(8), 'held', ''], [msg(9), 'not-sent', 'Not sent']]);
});

test('a broken database file is skipped and never fails the report', async (t) => {
  const { bridge, service, folder } = await home(t);
  await bridge('codex', X, [{ id: msg(10), peer: Y, direction: 'out', status: 'delivered' }]);
  await writeFile(path.join(folder('codex'), `${uuid(11)}.sqlite`), 'not a database');
  await writeFile(path.join(folder('codex'), 'notes.sqlite'), 'not a session');
  assert.deepEqual((await service().report('7d')).messages.map((item) => item.id), [msg(10)]);
});

test('every bridge status maps to its group and every reason follows the contract', () => {
  for (const [status, group] of [['accepted', 'accepted'], ['started', 'accepted'], ['steered', 'accepted'], ['delivered', 'accepted'], ['socket-written', 'written'],
    ['pending', 'written'], ['held', 'held'], ['not-sent', 'not-sent'], ['refused', 'not-sent'], ['denied', 'not-sent'], ['dropped', 'not-sent'],
    ['expired', 'not-sent'], ['unknown', 'unknown'], ['something-new', 'unknown'], [null, 'unknown']]) {
    for (const direction of ['in', 'out']) assert.equal(statusGroup(status, direction), group, `${status} ${direction}`);
  }
  assert.equal(statusGroup('submitting', 'in'), 'written');
  assert.equal(statusGroup('submitting', 'out'), 'unknown');
  for (const [status, text, reason] of [['refused', 'x', 'Refused'], ['denied', null, 'Denied'], ['dropped', '', 'Dropped'], ['expired', '', 'Expired'],
    ['not-sent', 'workLP is not reachable. Nothing sent.', 'Machine offline'], ['not-sent', 'Message too large: 2 MiB.', 'Too large'],
    ['not-sent', 'Too many messages to this session.', 'Rate limited'], ['not-sent', 'The session refused the message. Nothing sent.', 'Refused'],
    ['not-sent', 'Some other text.', 'Not sent'], ['not-sent', null, 'Not sent'], ['held', 'Too many messages', ''], ['delivered', 'x', ''],
    ['unknown', 'is not reachable. Nothing sent.', '']]) {
    assert.equal(statusReason(status, text), reason, `${status} ${text}`);
  }
});

test('the report gives the status reason group, never the status_reason text', async (t) => {
  const { bridge, service } = await home(t);
  await bridge('codex', X, [{ id: msg(12), peer: Y, direction: 'out', status: 'not-sent', reason: 'workLP is not reachable. Nothing sent.' }]);
  const report = await service().report('7d');
  assert.deepEqual([report.messages[0].status, report.messages[0].reason], ['not-sent', 'Machine offline']);
  assert.equal(JSON.stringify(report).includes('workLP'), false);
});

test('periods have local buckets: 24 hours up to the local hour of now, days at local midnights', () => {
  const now = new Date(nowMs);
  const hour = periodBuckets('24h', nowMs);
  assert.equal(hour.unit, 'hour');
  assert.equal(hour.startsMs.length, 24);
  assert.ok(hour.startsMs.at(-1) <= nowMs && nowMs < hour.startsMs.at(-1) + 3_600_000);
  assert.deepEqual([new Date(hour.startsMs.at(-1)).getHours(), new Date(hour.startsMs.at(-1)).getMinutes()], [now.getHours(), 0]);
  for (const [period, count] of [['7d', 7], ['30d', 30], ['90d', 90]]) {
    const { unit, startsMs } = periodBuckets(period, nowMs);
    assert.deepEqual([unit, startsMs.length], ['day', count]);
    assert.equal(startsMs.at(-1), new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime());
    assert.ok(startsMs.every((start) => new Date(start).getHours() === 0 && new Date(start).getMinutes() === 0));
  }
});

test('buckets stay on local hours and midnights across a DST change (America/New_York)', () => {
  const script = `import { periodBuckets } from ${JSON.stringify(new URL('../src/activity-messages.mjs', import.meta.url).href)};
    const now = Date.parse('2026-11-02T18:30:00.000Z');
    const days = periodBuckets('7d', now).startsMs;
    const hours = periodBuckets('24h', Date.parse('2026-11-01T10:20:00.000Z')).startsMs;
    console.log(JSON.stringify({ days: days.map((ms) => [new Date(ms).getDate(), new Date(ms).getHours(), new Date(ms).getMinutes()]),
      dayGaps: days.slice(1).map((ms, index) => (ms - days[index]) / 3600000), hours: hours.map((ms) => new Date(ms).getMinutes()),
      hourGaps: [...new Set(hours.slice(1).map((ms, index) => ms - hours[index]))], last: hours.at(-1), localHours: hours.map((ms) => new Date(ms).getHours()) }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' } }).toString());
  assert.deepEqual(out.days, [27, 28, 29, 30, 31, 1, 2].map((date) => [date, 0, 0]));
  // The day of the change has 25 hours.
  assert.deepEqual(out.dayGaps, [24, 24, 24, 24, 24, 25]);
  assert.equal(out.hours.length, 24);
  assert.ok(out.hours.every((minute) => minute === 0));
  assert.deepEqual(out.hourGaps, [3_600_000]);
  assert.equal(out.last, Date.parse('2026-11-01T10:00:00.000Z'));
  // 01:00 shows two times: once in daylight time, once in standard time.
  assert.equal(out.localHours.filter((hour) => hour === 1).length, 2);
});

test('seats: row IDs for known endpoints, unknown:<machine> for others, by title then ID; machines list this machine first', async (t) => {
  const { bridge, service } = await home(t);
  await bridge('codex', X, [{ id: msg(20), peer: Y, direction: 'out', status: 'delivered' }, { id: msg(21), peer: STRANGER, direction: 'out', status: 'delivered' }]);
  const group = { activity: async (period) => {
    assert.equal(period, '7d');
    return [{ machineId: 'c'.repeat(16), name: 'zeta', state: 'online', lastReportAtMs: nowMs - 1000, messages: [], usage: [], scan: {} },
      { machineId: B.machineId, name: 'Alpha', state: 'offline', lastReportAtMs: 0, messages: [], usage: [], scan: {} }];
  } };
  // The group gives its members in name order.
  const members = await group.activity('7d');
  group.activity = async () => [members[1], members[0]];
  const report = await service({ group }).report('7d');
  assert.deepEqual(Object.keys(report), ['period', 'nowMs', 'buckets', 'machines', 'seats', 'messages', 'truncated']);
  assert.deepEqual(report.machines, [{ machineId: A.machineId, name: 'engine-a', self: true, state: 'local', lastReportAtMs: 0 },
    { machineId: B.machineId, name: 'Alpha', self: false, state: 'offline', lastReportAtMs: 0 },
    { machineId: 'c'.repeat(16), name: 'zeta', self: false, state: 'online', lastReportAtMs: nowMs - 1000 }]);
  assert.deepEqual(report.seats, [
    { id: Y, title: 'Alpha task', app: 'codex', machineId: A.machineId, order: 0 },
    { id: X, title: 'beta task', app: 'codex', machineId: A.machineId, order: 1 },
    { id: `unknown:${A.machineId}`, title: 'Other sessions', app: '', machineId: A.machineId, order: 2 }]);
  assert.deepEqual(report.messages.map((item) => item.to), [Y, `unknown:${A.machineId}`]);
  assert.deepEqual([report.period, report.nowMs, report.truncated, report.buckets.startsMs.length], ['7d', nowMs, false, 7]);
});

test('a thread has the newest 60 messages oldest first, the total, local text without the envelope, and a 2,000 character cap', async (t) => {
  const { bridge, service } = await home(t);
  const rows = Array.from({ length: 65 }, (_, index) => ({ id: msg(100 + index), peer: Y, direction: 'out', status: 'delivered',
    atMs: nowMs - (65 - index) * 60_000, text: `<cross-session-message from="Synthetic">\nMessage ${index}.\n</cross-session-message>` }));
  rows[64].text = 'z'.repeat(2500);
  await bridge('codex', X, rows);
  await bridge('codex', Y, [{ id: msg(200), peer: CLI, direction: 'out', status: 'delivered', atMs: nowMs - 10_000, text: 'To Claude.' }]);
  const group = { activity: async () => [{ machineId: B.machineId, name: 'engine-b', state: 'online', lastReportAtMs: nowMs,
    messages: [{ id: msg(300), from: uuid(50), to: Y, atMs: nowMs - 5000, status: 'accepted', reason: '', direction: 'out' }], usage: [], scan: {} }] };
  const pair = await service({ group }).thread('7d', { a: Y, b: X });
  assert.equal(pair.total, 65);
  assert.equal(pair.messages.length, 60);
  assert.deepEqual(pair.messages[0], { id: msg(105), from: X, to: Y, atMs: seconds(nowMs - 60 * 60_000) * 1000, status: 'accepted', reason: '',
    text: 'Message 5.' });
  assert.equal(pair.messages.at(-1).text, `${'z'.repeat(1999)}…`);
  assert.equal(Array.from(pair.messages.at(-1).text).length, 2000);
  const seat = await service({ group }).thread('7d', { seat: Y });
  assert.equal(seat.total, 67);
  assert.deepEqual(seat.messages.slice(-2).map(({ from, to, text }) => [from, to, text]),
    [[Y, CLAUDE_ROW, 'To Claude.'], [`unknown:${B.machineId}`, Y, null]]);
  assert.deepEqual(await service({ group }).thread('7d', { seat: `unknown:${'f'.repeat(16)}` }), { total: 0, messages: [] });
  assert.equal(messageText('<cross-session-message from="x">\nHello\n</cross-session-message>\n'), 'Hello');
  assert.equal(messageText('<cross-session-message from="x">\nOne\nTwo\n</cross-session-message>'), 'One\nTwo');
  assert.equal(messageText('Plain\n</cross-session-message>'), 'Plain');
});

test('the group merge: one record per ID with the receiver status, offline members keep their last records, and member replies have no text', async (t) => {
  const { dir, bridge, service } = await home(t);
  // Engine A (this one) sent message 400 from X to a session of engine B; B has the receiver row.
  await bridge('codex', X, [{ id: msg(400), peer: uuid(60), direction: 'out', status: 'socket-written', atMs: nowMs - 120_000, text: 'Secret fixture text.' }]);
  const exported = exportLocalSessions(buildSwitchboardDashboard([{ id: uuid(60), externalId: uuid(60), provider: 'codex', title: 'Remote task',
    updatedAtMs: nowMs }], [], nowMs, { machineId: B.machineId, machineName: B.name }), B, nowMs);
  const dashboard = board();
  mergePeerRows(dashboard, [{ member: { ...B, certFingerprint: 'b'.repeat(64) }, online: true, lastOkAtMs: nowMs,
    sessions: validExport(JSON.parse(exportBody(exported).body), B) }], A, nowMs);
  const remoteRow = `m:${B.machineId}:${uuid(60)}`;
  assert.ok(dashboard.threads.some((row) => row.id === remoteRow));
  // The real machine group asks the member; the clock moves for the 30 s cache.
  let clock = nowMs;
  let answer = { status: 200, body: { messages: [
    { id: msg(400), from: X, to: uuid(60), atMs: nowMs - 119_000, status: 'accepted', reason: '', direction: 'in', text: 'Leak' },
    { id: msg(401), from: uuid(60), to: uuid(61), atMs: nowMs - 60_000, status: 'held', reason: '', direction: 'out' },
    { id: msg(402), from: uuid(60), to: X, atMs: nowMs - 50_000, status: 'bogus', reason: '', direction: 'out' }], usage: [], scan: { complete: true, files: 0, scannedFiles: 0 } } };
  const calls = [];
  const request = async (options) => {
    calls.push(options.path);
    if (options.path.startsWith('/peer/v1/activity')) {
      assert.deepEqual([options.maxBytes, options.timeoutMs], [16 * 1024 * 1024, 5000]);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return { status: 503, body: null };
  };
  const file = path.join(dir, 'group.json');
  const member = (letter, name) => ({ machineId: letter.repeat(16), name, certFingerprint: letter.repeat(64),
    addresses: [{ kind: 'lan', address: `member-${letter}` }], port: 4630, addedBy: 'a'.repeat(16), addedAtMs: 10 });
  await saveGroup(file, { schema: 1, groupId: '0123456789abcdef', self: { machineId: A.machineId, name: A.name }, members: [member('a', A.name), member('b', B.name)],
    removed: [], phones: [], removedPhones: [] });
  const gateway = { credentials: async () => ({ key: '', cert: '', fingerprint: 'a'.repeat(64) }) };
  const machineGroup = createMachineGroup({ file, gateway: () => gateway, request, timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} },
    hostName: 'pc', log: () => {}, now: () => clock, addressOk: () => true });
  await machineGroup.start();
  t.after(() => machineGroup.stop());
  machineGroup.peerStates()[0].online = true;
  const activity = service({ group: machineGroup, dashboard: async () => dashboard, now: () => clock });
  const first = await activity.report('7d');
  assert.deepEqual(first.messages, [
    { id: msg(400), from: X, to: remoteRow, atMs: seconds(nowMs - 120_000) * 1000, status: 'accepted', reason: '', local: true },
    { id: msg(401), from: remoteRow, to: `unknown:${B.machineId}`, atMs: nowMs - 60_000, status: 'held', reason: '', local: false }]);
  assert.deepEqual(first.machines[1], { machineId: B.machineId, name: B.name, self: false, state: 'online', lastReportAtMs: nowMs });
  assert.equal(first.seats.find((seat) => seat.id === remoteRow).machineId, B.machineId);
  assert.equal(JSON.stringify(first).includes('Leak'), false);
  // 30 s cache: no second request.
  clock += 10_000;
  await activity.report('7d');
  assert.equal(calls.filter((item) => item.startsWith('/peer/v1/activity')).length, 1);
  assert.equal(calls.find((item) => item.startsWith('/peer/v1/activity')), '/peer/v1/activity?period=7d');
  // The member stops answering: it is offline and keeps its last records and report time.
  answer = new Error('timeout');
  clock += 30_000;
  const offline = await activity.report('7d');
  assert.equal(calls.filter((item) => item.startsWith('/peer/v1/activity')).length, 2);
  assert.deepEqual(offline.machines[1], { machineId: B.machineId, name: B.name, self: false, state: 'offline', lastReportAtMs: nowMs });
  assert.deepEqual(offline.messages.map((item) => [item.id, item.status]), [[msg(400), 'accepted'], [msg(401), 'held']]);
  // The member reply of this engine: local records only, no text key, no fixture text.
  const reply = await activity.memberReply('7d');
  assert.deepEqual(reply, { messages: [{ id: msg(400), from: X, to: uuid(60), atMs: seconds(nowMs - 120_000) * 1000, status: 'written', reason: '', direction: 'out' }],
    usage: [], scan: { complete: true, files: 0, scannedFiles: 0 } });
  const text = JSON.stringify(reply);
  assert.equal(text.includes('Secret fixture text'), false);
  assert.equal(text.includes('"text"'), false);
  // The usage part comes from the usage service when it is there.
  const usage = [{ app: 'codex', model: 'gpt-5', hourMs: nowMs - 3_600_000, tokens: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } }];
  const withUsage = service({ activityUsage: { localHourly: async (period) => ({ usage: period === '90d' ? usage : [], scan: { complete: false, files: 9, scannedFiles: 3 } }) } });
  assert.deepEqual(await withUsage.memberReply('90d'), { messages: (await withUsage.localRecords('90d')), usage, scan: { complete: false, files: 9, scannedFiles: 3 } });
  assert.deepEqual(validActivity({ messages: [{ id: 'x', from: 'a', to: 'b', atMs: 1, status: 'held', reason: '', direction: 'in', text: 'T' }], usage: [] }).messages,
    [{ id: 'x', from: 'a', to: 'b', atMs: 1, status: 'held', reason: '', direction: 'in' }]);
  assert.equal(validActivity({ messages: {} }), null);
});

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the activity routes check the period, the seats, and the read checks, and send no-store', async (t) => {
  const calls = [];
  const activityMessages = { report: async (period) => { calls.push(['report', period]); return { period }; },
    thread: async (period, query) => { calls.push(['thread', period, query]); return { total: 0, messages: [] }; } };
  const base = await listen(t, createAsbServer({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), activityMessages }));
  const get = (route, headers = {}) => fetch(base + route, { headers });
  for (const route of ['/api/activity/messages?period=24h', '/api/activity/messages', '/api/activity/thread?period=30d&seat=x',
    '/api/activity/thread?a=x&b=m%3Aaaaa%3Ay']) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, [['report', '24h'], ['report', '7d'], ['thread', '30d', { seat: 'x' }], ['thread', '7d', { a: 'x', b: 'm:aaaa:y' }]]);
  for (const route of ['/api/activity/messages?period=90d', '/api/activity/messages?period=1y', '/api/activity/thread?period=&seat=x']) {
    const response = await get(route);
    assert.deepEqual([response.status, await response.json(), response.headers.get('cache-control')], [400, { error: 'Invalid period.' }, 'no-store'], route);
  }
  for (const route of ['/api/activity/thread', '/api/activity/thread?seat=', '/api/activity/thread?a=x', '/api/activity/thread?seat=x&a=y&b=z',
    '/api/activity/thread?seat=x&seat=y', '/api/activity/thread?seat=x%0Ay', `/api/activity/thread?seat=${'x'.repeat(513)}`, '/api/activity/thread?seat=x&extra=1']) {
    const response = await get(route);
    assert.deepEqual([response.status, await response.json()], [400, { error: 'Invalid session.' }], route);
  }
  assert.equal(calls.length, 4);
  assert.equal((await get('/api/activity/messages', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await get('/api/activity/messages', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${base}/api/activity/messages`, { method: 'POST', headers: { Origin: base } })).status, 405);
  // No usage service: the usage route does not exist.
  assert.equal((await get('/api/activity/usage?period=30d')).status, 404);
  assert.equal(calls.length, 4);
  const periods = [];
  const usageBase = await listen(t, createAsbServer({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }),
    activityUsage: { report: async (period) => { periods.push(period); return { period }; } } }));
  const usage = await fetch(`${usageBase}/api/activity/usage?period=90d`);
  assert.deepEqual([usage.status, await usage.json(), usage.headers.get('cache-control')], [200, { period: '90d' }, 'no-store']);
  assert.equal((await fetch(`${usageBase}/api/activity/usage`)).status, 200);
  assert.equal((await fetch(`${usageBase}/api/activity/usage?period=1y`)).status, 400);
  assert.deepEqual(periods, ['90d', '30d']);
  // Without the messages service the message routes do not exist.
  assert.equal((await fetch(`${usageBase}/api/activity/messages`)).status, 404);
  assert.equal((await fetch(`${usageBase}/api/activity/thread?seat=x`)).status, 404);
});

test('the switchboard server reads the registered bridge folders and passes the usage service on', async (t) => {
  const { bridge, sources } = await home(t);
  await bridge('codex', X, [{ id: msg(500), peer: Y, direction: 'out', status: 'delivered', atMs: Date.now() - 60_000 }]);
  const periods = [];
  const server = createSwitchboardServer({ pendingTracker: new PendingTracker(false), palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: { read: async () => sources.filter((source) => source.provider === 'codex') },
    loadDashboard: async () => buildSwitchboardDashboard(threads(), [], Date.now(), { machineId: A.machineId, machineName: A.name }),
    machineIdentity: () => ({ machineId: A.machineId, machineName: A.name }),
    activityUsage: { report: async (period) => { periods.push(period); return { period }; } } });
  const base = await listen(t, server);
  const report = await (await fetch(`${base}/api/activity/messages?period=30d`)).json();
  assert.deepEqual(report.messages.map(({ id, from, to }) => [id, from, to]), [[msg(500), X, Y]]);
  assert.deepEqual(report.machines, [{ machineId: A.machineId, name: A.name, self: true, state: 'local', lastReportAtMs: 0 }]);
  const thread = await (await fetch(`${base}/api/activity/thread?period=30d&a=${X}&b=${Y}`)).json();
  assert.deepEqual(thread.messages.map((item) => item.text), ['Synthetic text.']);
  assert.deepEqual(await (await fetch(`${base}/api/activity/usage?period=7d`)).json(), { period: '7d' });
  assert.deepEqual(periods, ['7d']);
  assert.deepEqual((await server.activityMember('24h')).messages.map((item) => item.direction), ['out']);
});

test('500 bridge databases read cold under 5 s and warm from the cache under 300 ms', async (t) => {
  const { bridge, service } = await home(t);
  for (let index = 0; index < 500; index += 1) {
    await bridge('codex', uuid(1000 + index), [{ id: msg(1000 + index), peer: X, direction: 'out', status: 'delivered', atMs: nowMs - index * 1000 },
      { id: msg(5000 + index), peer: Y, direction: 'in', status: 'steered', atMs: nowMs - index * 1000 }]);
  }
  const activity = service();
  let started = performance.now();
  const cold = await activity.report('30d');
  const coldMs = performance.now() - started;
  started = performance.now();
  const warm = await activity.report('30d');
  const warmMs = performance.now() - started;
  console.log(`# activity speed: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);
  assert.equal(cold.messages.length, 1000);
  assert.deepEqual(warm, cold);
  assert.ok(coldMs < 5000, `cold ${coldMs}`);
  assert.ok(warmMs < 300, `warm ${warmMs}`);
});
