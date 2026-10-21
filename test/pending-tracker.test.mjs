import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSwitchboardDashboard, createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';
const now = Date.parse('2026-10-07T14:00:00Z');
const HOUR = 3_600_000;
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-tracker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const claude = (extra) => ({ id, externalId: `local_${id}`, provider: 'claude-desktop-code', nativeUnread: null, ...extra });
const plain = (state, extra = {}) => ({ providers: [], threads: [{ id, state, nativeUnread: null, completionAtMs: 0, ...extra }] });
const stateWarning = (dashboard) => dashboard.providers.find((provider) => provider.id === 'asb-state');

test('Persistent unread defaults to on without a state file', async (t) => {
  const transient = new PendingTracker(false);
  assert.equal(transient.persistentUnread, true);
  assert.equal((await transient.observe(plain('idle'))).persistentUnread, true);

  const statePath = path.join(await temp(t), 'pending.json');
  const fresh = new PendingTracker(statePath);
  await fresh.load();
  assert.equal(fresh.persistentUnread, true);
  assert.equal(fresh.warning, '');
  await assert.rejects(stat(statePath), { code: 'ENOENT' });
  assert.equal((await fresh.observe(plain('idle'))).persistentUnread, true);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).persistentUnread, true);
});

test('legacy and invalid unread settings use the default and saved booleans keep their choice', async (t) => {
  const dir = await temp(t);
  for (const [setting, expected] of [[undefined, true], [null, true], ['false', true], [0, true], [1, true],
    [{}, true], [[], true], [false, false], [true, true]]) {
    const statePath = path.join(dir, `${JSON.stringify(setting)}.json`);
    const content = JSON.stringify({ version: 1, persistentUnread: setting, pinnedOrder: [id],
      records: { [id]: { seen: 10, working: 0, pending: 10, ack: 0 } } });
    await writeFile(statePath, content);
    const tracker = new PendingTracker(statePath);
    const loaded = await tracker.observe(plain('idle', { completionAtMs: 10 }));
    assert.equal(loaded.persistentUnread, expected, String(setting));
    assert.equal(stateWarning(loaded), undefined, String(setting));
    assert.deepEqual(loaded.pinnedOrder, [id]);
    assert.deepEqual([loaded.threads[0].completionAttention, loaded.threads[0].unread], [true, true]);
    await tracker.markUnread(id);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).persistentUnread, expected);
    assert.equal((await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 10 }))).persistentUnread, expected);
  }
});

test('the default preserves attention on open, Read clears it, and settings persist both choices', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  await tracker.observe(plain('working'));
  const server = createSwitchboardServer({ pendingTracker: tracker, openThread: async () => ({ opened: true }),
    loadDashboard: async () => plain('idle', { completionAtMs: 10, canOpen: true, provider: 'codex', appDeepLink: `codex://threads/${id}` }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(body) });
  const dashboard = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  const first = await dashboard();
  assert.equal(first.persistentUnread, true);
  assert.deepEqual([first.threads[0].unread, first.threads[0].retainedUnread], [true, true]);
  assert.equal((await post(`/api/threads/${id}/open`)).status, 200);
  assert.equal((await dashboard()).threads[0].unread, true);
  const read = await post(`/api/threads/${id}/mark-read`);
  assert.equal(read.status, 200);
  assert.deepEqual([(await read.json()).thread.unread, (await dashboard()).threads[0].pending], [false, false]);
  for (const enabled of [false, true]) {
    const settings = await post('/api/settings/unread', { persistentUnread: enabled });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).persistentUnread, enabled);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).persistentUnread, enabled);
    assert.equal((await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 10 }))).persistentUnread, enabled);
    assert.equal((await post(`/api/threads/${id}/mark-unread`)).status, 200);
    assert.equal((await post(`/api/threads/${id}/open`)).status, 200);
    assert.equal((await dashboard()).threads[0].unread, enabled);
  }
});

test('a follow-up message in the armed Claude task keeps Discard, and a new task after an end clears it', async (t) => {
  const tracker = new PendingTracker(path.join(await temp(t), 'pending.json'));
  const running = (start, end) => buildSwitchboardDashboard([claude({ lifecycleRunning: true, agentActivityAtMs: now + start,
    agentStartedAtMs: now + start, latestTaskStartedAtMs: now + start, latestTaskEndedAtMs: now + end,
    latestTaskEndKind: 'task_complete' })], [], now + 1000);
  const first = await tracker.observe(running(0, -900));
  assert.equal(first.threads[0].state, 'working');
  await tracker.setDiscard(first.threads[0], true);
  const followUp = (await tracker.observe(running(50, -900))).threads[0];
  assert.deepEqual([followUp.state, followUp.discardResult], ['working', true]);
  const ended = (await tracker.observe(buildSwitchboardDashboard([claude({ lifecycleRunning: false,
    latestLifecycleKind: 'task_complete', latestLifecycleAtMs: now + 100, latestTaskStartedAtMs: now + 50,
    latestTaskEndedAtMs: now + 100, latestTaskEndKind: 'task_complete' })], [], now + 1000))).threads[0];
  assert.deepEqual([ended.state, ended.discardResult, ended.unread, ended.pending], ['idle', false, false, false]);

  const again = await tracker.observe(running(200, 100));
  await tracker.setDiscard(again.threads[0], true);
  assert.equal((await tracker.observe(running(400, 300))).threads[0].discardResult, false);
});

test('a next-task arm on an idle Claude chat keeps a follow-up message in its task, and a new task after an end clears it', async (t) => {
  const tracker = new PendingTracker(path.join(await temp(t), 'pending.json'));
  const running = (start, end) => buildSwitchboardDashboard([claude({ lifecycleRunning: true, agentActivityAtMs: now + start,
    agentStartedAtMs: now + start, latestTaskStartedAtMs: now + start, latestTaskEndedAtMs: now + end,
    latestTaskEndKind: 'task_complete' })], [], now + 1000);
  const idle = await tracker.observe(buildSwitchboardDashboard([claude({ lifecycleRunning: false, latestLifecycleKind: 'task_complete',
    latestLifecycleAtMs: now - 900, latestTaskStartedAtMs: now - 1000, latestTaskEndedAtMs: now - 900, latestTaskEndKind: 'task_complete' })],
  [], now + 1000));
  assert.equal(idle.threads[0].state, 'idle');
  await tracker.setDiscard(idle.threads[0], true, true);
  assert.equal(idle.threads[0].discardResult, true);
  const started = (await tracker.observe(running(0, -900))).threads[0];
  assert.deepEqual([started.state, started.discardResult], ['working', true]);
  const followUp = (await tracker.observe(running(50, -900))).threads[0];
  assert.deepEqual([followUp.state, followUp.discardResult], ['working', true]);
  const next = (await tracker.observe(running(400, 300))).threads[0];
  assert.deepEqual([next.state, next.discardResult, next.pending], ['working', false, false]);
});

test('a Claude permission or question wait expires after six hours', async () => {
  const wait = (age, tool) => claude({ lifecycleRunning: true, agentActivityAtMs: now - age, awaitingPermission: true,
    pendingToolCount: 1, pendingTools: [{ tool }], pendingToolAtMs: now - age, awaitingUserInput: tool === 'AskUserQuestion',
    latestUserQuestionAtMs: tool === 'AskUserQuestion' ? now - age : 0 });
  for (const tool of ['ExitPlanMode', 'AskUserQuestion']) {
    const stale = (await new PendingTracker(false).observe(buildSwitchboardDashboard([wait(72 * HOUR, tool)], [], now))).threads[0];
    assert.deepEqual([stale.state, stale.actionRequired, stale.questionPending, stale.pending], ['unknown', false, false, false], tool);
    const board = buildSwitchboardDashboard([wait(HOUR, tool)], [], now);
    const recent = (await new PendingTracker(false).observe(board)).threads[0];
    assert.deepEqual([recent.state, recent.pending], ['waiting', true], tool);
    assert.equal(board.nextStatusCheckAtMs, now + 5 * HOUR + 1);
  }
  const untimed = buildSwitchboardDashboard([claude({ awaitingPermission: true, pendingToolCount: 1 })], [], now).threads[0];
  assert.deepEqual([untimed.state, untimed.actionRequired], ['waiting', true]);
});

test('a state file that ASB cannot use in full is kept as .bad before the first save', async (t) => {
  const dir = await temp(t);
  const record = { seen: 0, working: 0, pending: 0, ack: 0 };
  const cases = {
    cut: '{"version":1,"records":{"one":{"seen":0,"wor',
    version: JSON.stringify({ version: 2, records: { one: record }, pinnedOrder: ['one'] }),
    record: JSON.stringify({ version: 1, records: { one: record, two: { ...record, ack: null } }, pinnedOrder: ['one', 'two'] }),
  };
  for (const [name, content] of Object.entries(cases)) {
    const statePath = path.join(dir, name, 'pending.json');
    await mkdir(path.dirname(statePath));
    await writeFile(statePath, content);
    await writeFile(`${statePath}.bad`, 'older copy');
    const tracker = new PendingTracker(statePath);
    const dashboard = await tracker.observe(plain('idle', { completionAtMs: 5 }));
    assert.match(stateWarning(dashboard)?.message || '', /could not read its Pending state/, name);
    assert.equal(await readFile(`${statePath}.bad`, 'utf8'), content, name);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 1, name);
    if (name === 'record') assert.deepEqual(dashboard.pinnedOrder, ['one']);
    assert.ok(stateWarning(await tracker.observe(plain('idle', { completionAtMs: 6 }))), name);
  }
  const statePath = path.join(dir, 'valid.json');
  await writeFile(statePath, cases.record.replace('null', '0'));
  const dashboard = await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 5 }));
  assert.equal(stateWarning(dashboard), undefined);
  assert.deepEqual(dashboard.pinnedOrder, ['one', 'two']);
  await assert.rejects(stat(`${statePath}.bad`), { code: 'ENOENT' });
  const absent = path.join(dir, 'absent.json');
  assert.equal(stateWarning(await new PendingTracker(absent).observe(plain('idle', { completionAtMs: 5 }))), undefined);
  await assert.rejects(stat(`${absent}.bad`), { code: 'ENOENT' });
});

test('a task that ends after a Waiting scan gets its completion or failure dot', async () => {
  for (const [end, attention] of [[{ completionAtMs: 10 }, 'completionAttention'], [{ failedAtMs: 10 }, 'failedAttention']]) {
    const tracker = new PendingTracker(false);
    await tracker.observe(plain('idle'));
    await tracker.observe(plain('working'));
    await tracker.observe(plain('waiting'));
    const ended = (await tracker.observe(plain('idle', end))).threads[0];
    assert.deepEqual([ended[attention], ended.unread, ended.pending], [true, true, true], attention);
  }
});

test('an injected dashboard load gets no default watchers on the home session stores', async (t) => {
  const home = await temp(t);
  await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = oldHome; });
  assert.equal(os.homedir(), home);
  const watched = [];
  const server = createSwitchboardServer({ pendingStatePath: false, loadDashboard: async () => plain('idle'),
    watchDashboardPath: (target) => { watched.push(target); return { close() {} }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  await delay(100);
  assert.deepEqual(watched, []);
});

test('the save warning clears after a later successful save', async (t) => {
  const dir = await temp(t);
  const tracker = new PendingTracker(path.join(dir, 'pending.json'));
  const blocker = `${tracker.statePath}.${process.pid}.tmp`;
  await mkdir(blocker);
  assert.match(stateWarning(await tracker.observe(plain('idle', { completionAtMs: 5 })))?.message || '', /cannot save Pending state/);
  await rm(blocker, { recursive: true });
  assert.equal(stateWarning(await tracker.observe(plain('idle', { completionAtMs: 5 }))), undefined);
  assert.equal(JSON.parse(await readFile(tracker.statePath, 'utf8')).version, 1);
});

// Mute: a muted session takes the discarded-success path for each task that ends with success after Mute is on.
const scanRow = async (tracker, state, extra) => (await tracker.observe(plain(state, extra))).threads[0];
async function mutedTracker(statePath = false, before = {}) {
  const tracker = new PendingTracker(statePath);
  const row = await scanRow(tracker, 'idle', before);
  await tracker.setMuted(row, true);
  assert.equal(row.muted, true);
  return tracker;
}
const attention = (row) => [row.unread, row.pending, row.completionAttention, row.nativeAttention, row.failedAttention,
  row.questionAttention, row.pendingSource];

test('a muted session stays read when a task ends with success, also with a late native unread', async () => {
  for (const persistent of [true, false]) {
    const tracker = await mutedTracker();
    await tracker.setPersistentUnread(persistent, { threads: [] });
    await scanRow(tracker, 'working');
    const ended = await scanRow(tracker, 'idle', { completionAtMs: 10 });
    assert.deepEqual(attention(ended), [false, false, false, false, false, false, ''], `persistent ${persistent}`);
    assert.deepEqual([ended.muted, ended.retainedUnread], [true, false]);
    assert.deepEqual(attention(await scanRow(tracker, 'idle', { completionAtMs: 10 })), attention(ended));
    // The app sets its own unread for the same task in a later scan.
    const late = await scanRow(tracker, 'idle', { completionAtMs: 10, nativeUnread: true });
    assert.deepEqual(attention(late), attention(ended), `late native, persistent ${persistent}`);
  }
  const tracker = await mutedTracker(false, { nativeUnread: false });
  await scanRow(tracker, 'working', { nativeUnread: false });
  for (let scan = 0; scan < 2; scan += 1) {
    const row = await scanRow(tracker, 'idle', { completionAtMs: 10, nativeUnread: true });
    assert.deepEqual([row.nativeAttention, row.unread, row.pending], [false, false, false], `native in scan ${scan}`);
  }
});

test('a muted failure, question, and manual Unread still show', async () => {
  for (const end of [{ failedAtMs: 10 }, { completionAtMs: 5, failedAtMs: 10 }]) {
    const tracker = await mutedTracker();
    await scanRow(tracker, 'working');
    const failed = await scanRow(tracker, 'idle', end);
    assert.deepEqual([failed.failedAttention, failed.unread, failed.pendingSource], [true, true, 'observed-failure'], JSON.stringify(end));
  }
  const asked = await mutedTracker();
  const question = await scanRow(asked, 'waiting', { questionPending: true });
  assert.deepEqual([question.questionAttention, question.pending], [true, true]);
  const marked = await mutedTracker();
  await marked.markUnread(id);
  const manual = await scanRow(marked, 'idle');
  assert.deepEqual([manual.manualUnread, manual.unread, manual.pendingSource], [true, true, 'manual-unread']);
});

test('Mute keeps an older dot until a later muted success clears only an older success dot', async () => {
  const marks = {
    success: async (tracker) => { await scanRow(tracker, 'working'); return scanRow(tracker, 'idle', { completionAtMs: 10 }); },
    failure: async (tracker) => { await scanRow(tracker, 'working'); return scanRow(tracker, 'idle', { failedAtMs: 10 }); },
    manual: async (tracker) => { await tracker.markUnread(id); return scanRow(tracker, 'idle'); },
  };
  for (const [name, mark] of Object.entries(marks)) {
    const tracker = new PendingTracker(false);
    await scanRow(tracker, 'idle');
    const dot = await mark(tracker);
    assert.equal(dot.unread, true, name);
    await tracker.setMuted(dot, true);
    assert.deepEqual([dot.muted, dot.unread], [true, true], `${name} right after Mute`);
    const same = name === 'manual' ? {} : name === 'success' ? { completionAtMs: 10 } : { failedAtMs: 10 };
    for (let scan = 0; scan < 2; scan += 1) assert.equal((await scanRow(tracker, 'idle', same)).unread, true, `${name} scan ${scan}`);
    await scanRow(tracker, 'working', same);
    const later = await scanRow(tracker, 'idle', { ...same, completionAtMs: 20 });
    assert.equal(later.completionAttention, false, name);
    assert.equal(later.unread, name !== 'success', `${name} after a later muted success`);
    assert.equal((await scanRow(tracker, 'idle', { ...same, completionAtMs: 20 })).unread, name !== 'success', `${name} next scan`);
  }
});

test('Unmute gives the next completion its dot', async () => {
  const tracker = await mutedTracker();
  await scanRow(tracker, 'working');
  const muted = await scanRow(tracker, 'idle', { completionAtMs: 10 });
  await tracker.setMuted(muted, false);
  assert.deepEqual([muted.muted, muted.unread], [false, false]);
  await scanRow(tracker, 'working', { completionAtMs: 10 });
  const ended = await scanRow(tracker, 'idle', { completionAtMs: 20 });
  assert.deepEqual([ended.muted, ended.unread, ended.completionAttention], [false, true, true]);
  await assert.rejects(new PendingTracker(false).setMuted({ id }, true), { statusCode: 400, message: 'This session is not known to ASB.' });
});

test('pending.json keeps Mute across save and load, and a bad value loads as 0', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  await mutedTracker(statePath);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.records[id].muted, 1);
  const restarted = await scanRow(new PendingTracker(statePath), 'idle');
  assert.equal(restarted.muted, true);
  for (const muted of ['1', 7, -1, true, null, 0]) {
    await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], muted } } }));
    const invalid = new PendingTracker(statePath);
    const loaded = await invalid.observe(plain('idle'));
    assert.deepEqual([invalid.records[id].muted, loaded.threads[0].muted, stateWarning(loaded)], [0, false, undefined], JSON.stringify(muted));
  }
  const fresh = new PendingTracker(false);
  assert.equal((await scanRow(fresh, 'idle')).muted, false);
  assert.equal(fresh.records[id].muted, 0);
});

test('mute and unmute are local session actions with an empty body', async (t) => {
  const tracker = new PendingTracker(false);
  const server = createSwitchboardServer({ pendingTracker: tracker, dashboardWatchPaths: [], openThread: async () => ({ opened: true }),
    loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', state: 'idle', nativeUnread: null, completionAtMs: 0 }] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (action, body = '{}', thread = id) => fetch(`${base}/api/threads/${thread}/${action}`, { method: 'POST', headers: { Origin: base }, body });
  const reply = async (response) => [response.status, await response.json()];
  for (const action of ['mute', 'unmute']) {
    assert.equal((await post(action, '{"enabled":true}')).status, 400, action);
    assert.equal((await post(action, '[]')).status, 400, action);
    assert.deepEqual(await reply(await post(action, '{}', 'missing')), await reply(await post('mark-read', '{}', 'missing')), action);
    assert.equal((await post(action, '{}', 'missing')).status, 404, action);
  }
  const muted = await (await post('mute')).json();
  assert.deepEqual([muted.changed, muted.threadId, muted.thread.muted], [true, id, true]);
  assert.equal((await (await fetch(`${base}/api/dashboard`)).json()).threads[0].muted, true);
  const unmuted = await (await post('unmute')).json();
  assert.deepEqual([unmuted.changed, unmuted.threadId, unmuted.thread.muted], [true, id, false]);
  assert.equal(tracker.records[id].muted, 0);
});

const DAY = 24 * HOUR;
const live = (atMs, ids = ['live']) => ({ generatedAtMs: atMs, providers: [],
  threads: ids.map((rowId) => ({ id: rowId, state: 'idle', nativeUnread: null, completionAtMs: 0 })) });
const savedRecords = async (statePath) => Object.keys(JSON.parse(await readFile(statePath, 'utf8')).records).sort();

test('a record that ASB did not see for 30 days goes, and a pin, a mark, the drawer, Mute, or a Discard keeps it', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const old = { seen: 0, working: 0, pending: 0, ack: 0, lastSeen: now - 31 * DAY };
  const records = { plain: old, working: { ...old, working: 1 }, read: { ...old, seen: 9, pending: 9, ack: 9 },
    pinned: old, manual: { ...old, manual: 1 }, drawer: { ...old, drawer: 1 }, muted: { ...old, muted: 1 }, discard: { ...old, discard: 1 },
    retained: { ...old, retained: 'observed-completion' }, unread: { ...old, seen: 5, pending: 5 }, question: { ...old, questionSeen: 3 },
    native: { ...old, nativeAt: 3 }, recent: { ...old, lastSeen: now - 29 * DAY } };
  await writeFile(statePath, JSON.stringify({ version: 1, persistentUnread: true, pinnedOrder: ['pinned'], records }));
  const tracker = new PendingTracker(statePath);
  const dashboard = await tracker.observe(live(now));
  assert.deepEqual(await savedRecords(statePath), ['discard', 'drawer', 'live', 'manual', 'muted', 'native', 'pinned', 'question', 'recent', 'retained', 'unread']);
  assert.deepEqual(Object.keys(tracker.records).sort(), await savedRecords(statePath));
  assert.deepEqual([dashboard.pinnedOrder, stateWarning(dashboard)], [['pinned'], undefined]);
  // A kept record keeps its marks and its old time of sight. A record that is 29 days old goes 2 days later.
  const unread = JSON.parse(await readFile(statePath, 'utf8')).records.unread;
  assert.deepEqual([unread.seen, unread.pending, unread.ack, unread.lastSeen], [5, 5, 0, now - 31 * DAY]);
  await tracker.observe(live(now + 2 * DAY));
  assert.deepEqual(await savedRecords(statePath), ['discard', 'drawer', 'live', 'manual', 'muted', 'native', 'pinned', 'question', 'retained', 'unread']);
});

test('a record from an older ASB with no time of sight stays for 30 days from the first load', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const start = Date.now();
  await writeFile(statePath, JSON.stringify({ version: 1, persistentUnread: true, pinnedOrder: [], records: { legacy: { seen: 1, working: 0, pending: 0, ack: 0 } } }));
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(start));
  assert.equal(tracker.records.legacy.lastSeen >= start, true);
  await tracker.observe(live(start + 29 * DAY));
  assert.deepEqual(Object.keys(tracker.records).sort(), ['legacy', 'live']);
  await tracker.observe(live(start + 31 * DAY));
  assert.deepEqual(await savedRecords(statePath), ['live']);
});

test('a scan moves the time of sight at most once a day, so it does not rewrite pending.json, and a row seen each day is never dropped', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(now));
  const first = await readFile(statePath, 'utf8');
  for (const offset of [2_000, HOUR, 23 * HOUR]) {
    await tracker.observe(live(now + offset));
    assert.equal(await readFile(statePath, 'utf8'), first, String(offset));
  }
  await tracker.observe(live(now + DAY));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).records.live.lastSeen, now + DAY);
  // 'daily' is seen each day, 'gap' only on the first day.
  await tracker.observe(live(now, ['daily', 'gap']));
  for (let day = 1; day <= 40; day += 1) await tracker.observe(live(now + day * DAY, ['daily']));
  assert.deepEqual(await savedRecords(statePath), ['daily']);
});

test('the records of a machine that left the group go with their pins, and nothing goes while the members are not known', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  const rows = [`m:${a}:one`, `m:${a}:two`, `m:${b}:one`, 'codex:local', `m:${b}`];
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(now, rows));
  await tracker.setPinned(`m:${b}:one`, true);
  await tracker.setPinned(`m:${a}:one`, true);
  await tracker.markUnread(`m:${b}:two`);
  // The rows are not in the next dashboards, so only the member rule can drop their records.
  for (const members of [null, undefined]) {
    await tracker.observe(live(now + 1000, ['live']), members);
    assert.deepEqual(Object.keys(tracker.records).sort(), [...rows, 'live'].sort());
  }
  const present = await tracker.observe(live(now + 2000, ['live']), [a, 'c'.repeat(16)]);
  assert.deepEqual(Object.keys(tracker.records).sort(), [`m:${a}:one`, `m:${a}:two`, `m:${b}`, 'codex:local', 'live'].sort());
  assert.deepEqual(present.pinnedOrder, [`m:${a}:one`]);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, [`m:${a}:one`]);
  // A row that is still in the scan keeps its record, also when its machine is not in the list.
  await tracker.observe(live(now + 3000, [`m:${a}:one`]), [b]);
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, `m:${b}`, 'codex:local', 'live'].sort());
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, [`m:${a}:one`]);
  await tracker.observe(live(now + 4000, ['live']), [b]);
  assert.deepEqual(await savedRecords(statePath), [`m:${b}`, 'codex:local', 'live'].sort());
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, []);
});

test('the server gives the tracker the group members, so the records of a member that left go at the next scan', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  let members = [a, b];
  // The merge lists the rows of the members that are in the group only.
  const server = createSwitchboardServer({ pendingStatePath: statePath, dashboardWatchPaths: [], machineGroup: { merge: (dashboard) => dashboard, memberIds: () => members },
    loadDashboard: async () => live(Date.now(), [`m:${a}:one`, ...members.includes(b) ? [`m:${b}:one`] : [], 'codex:local']) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const scan = async () => {
    server.invalidateDashboard('test', { hard: true });
    await (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`)).json();
  };
  await scan();
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, `m:${b}:one`, 'codex:local'].sort());
  members = [a];
  await scan();
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, 'codex:local'].sort());
});
