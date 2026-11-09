// The usage of each session (decision D18): the session sums of the engine, the member sessions of contract 4, and the
// sessions part of the report. Synthetic transcripts, databases, and IDs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityUsage, sessionIdOf, TOP_SESSIONS } from '../src/activity-usage.mjs';
import { periodBuckets, sessionSums, topSessions, validSessions } from '../src/usage-aggregation.mjs';
import { validActivity } from '../src/machine-peers.mjs';
import { buildSwitchboardDashboard, usageSessionTitles } from '../src/switchboard.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12, 7, 31);
const iso = (ms) => new Date(ms).toISOString();
const SELF = 'a'.repeat(16);
const MEMBER = 'b'.repeat(16);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TYPES = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
const tokenTotal = (tokens) => TYPES.reduce((sum, type) => sum + tokens[type], 0);

const claudeLine = (atMs, id, output) => JSON.stringify({ type: 'assistant', timestamp: iso(atMs), requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-test-5', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: output } } });
const codexRollout = (atMs, output) => [
  JSON.stringify({ type: 'turn_context', timestamp: iso(atMs), payload: { model: 'gpt-test-1' } }),
  JSON.stringify({ type: 'event_msg', timestamp: iso(atMs + 1000), payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 40, output_tokens: output, total_tokens: 40 + output },
    total_token_usage: { input_tokens: 40, output_tokens: output, total_tokens: 40 + output } } } }),
].join('\n');
const grokLine = (atMs) => JSON.stringify({ timestamp: atMs, params: { sessionId: 'g-test', update: {
  sessionUpdate: 'turn_completed', prompt_id: 'p-1', usage: { inputTokens: 9, outputTokens: 3 } } } });
const piLine = (atMs) => JSON.stringify({ type: 'message', id: 'pi-1', timestamp: iso(atMs),
  message: { role: 'assistant', provider: 'test', model: 'mimo-test', usage: { input: 4, output: 2 } } });

test('sessionIdOf reads the session ID of each transcript path', () => {
  const root = path.join(os.tmpdir(), 'asb-session-ids');
  assert.equal(sessionIdOf(path.join(root, 'sessions', '2026', '10', `rollout-2026-10-20T10-00-00-${uuid(1)}.jsonl`), 'codex'), uuid(1));
  assert.equal(sessionIdOf(path.join(root, 'archived_sessions', `rollout-2026-10-20T10-00-00-${uuid(2)}.jsonl.zst`), 'codex'), uuid(2));
  assert.equal(sessionIdOf(path.join(root, 'sessions', 'rollout-old.jsonl'), 'codex'), '');
  assert.equal(sessionIdOf(path.join(root, 'projects', 'p', `${uuid(3)}.jsonl`), 'claude'), uuid(3));
  assert.equal(sessionIdOf(path.join(root, 'projects', 'p', uuid(3), 'subagents', 'agent-a1.jsonl'), 'claude'), uuid(3));
  assert.equal(sessionIdOf(path.join(root, '.grok', 'sessions', 'g-7', 'updates.jsonl'), 'grok'), 'g-7');
  assert.equal(sessionIdOf(path.join(root, '.pi', 'agent', 'sessions', 'w', `2026-10-20T10-00-00-000Z_${uuid(4)}.jsonl`), 'pi'), uuid(4));
  assert.equal(sessionIdOf(path.join(root, '.pi', 'agent', 'sessions', 'w', 'plain.jsonl'), 'pi'), 'plain');
});

test('sessionSums uses the dedupe of the records and the period bounds, and the sessions plus none give the total', () => {
  const tokens = (output) => ({ uncached: 1, cacheRead: 2, cacheWrite: 3, output });
  const parts = [
    { app: 'claude', model: 'm', atMs: 10, tokens: tokens(4), key: 'k', session: 'a' },
    // A resumed copy of key k: the first part wins.
    { app: 'claude', model: 'm', atMs: 10, tokens: tokens(9), key: 'k', session: 'b' },
    { app: 'claude', model: 'm', atMs: 20, tokens: tokens(5), key: null, session: 'b' },
    { app: 'codex', model: 'x', atMs: 20, tokens: tokens(6), key: null, session: '' },
    // On the end bound: outside.
    { app: 'claude', model: 'm', atMs: 30, tokens: tokens(7), key: null, session: 'a' },
    // Before the start bound: outside.
    { app: 'claude', model: 'm', atMs: 9, tokens: tokens(8), key: null, session: 'a' },
  ];
  const rates = new Map([['m', { input: 1, output: 2 }]]);
  const { sessions, none } = sessionSums(parts, 10, 30, rates);
  assert.deepEqual(sessions, [
    { app: 'claude', id: 'a', tokens: tokens(4), cost: 1 + 2 + 3 + 8 },
    { app: 'claude', id: 'b', tokens: tokens(5), cost: 1 + 2 + 3 + 10 }]);
  assert.deepEqual(none, tokens(6));
  // A model with no price gives unpriced and only the priced part as cost.
  assert.deepEqual(sessionSums([{ app: 'codex', model: 'x', atMs: 10, tokens: tokens(1), session: 's' }], 0, 99, rates).sessions,
    [{ app: 'codex', id: 's', tokens: tokens(1), cost: 0, unpriced: true }]);
});

test('session sums of made-up Codex, Claude, Grok, Pi, and OpenCode transcripts, with board titles', { skip: !sqlite }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-sessions-'));
  const zone = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(async () => {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name, text) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${text}\n`);
  };
  const week = periodBuckets('7d', NOW).startsMs[0];
  await write(`codex/sessions/2026/10/rollout-2026-10-20T10-00-00-${uuid(1)}.jsonl`, codexRollout(NOW - HOUR, 30));
  // A rollout name with no session ID: usage with no session.
  await write('codex/sessions/2026/10/rollout-old.jsonl', codexRollout(NOW - 2 * HOUR, 11));
  await write(`projects/p/${uuid(2)}.jsonl`, [claudeLine(NOW - HOUR, 1, 7), claudeLine(NOW - 2 * HOUR, 2, 5)].join('\n'));
  // A resumed transcript with a copy of message 1, and one message of its own.
  await write(`projects/p/${uuid(3)}.jsonl`, [claudeLine(NOW - HOUR, 1, 7), claudeLine(NOW - 3 * HOUR, 3, 13)].join('\n'));
  // A subagent transcript belongs to the session folder above it.
  await write(`projects/p/${uuid(2)}/subagents/agent-a1.jsonl`, claudeLine(NOW - 4 * HOUR, 4, 17));
  // One message on the first 7d bucket start, one just before it.
  await write(`projects/p/${uuid(5)}.jsonl`, [claudeLine(week, 5, 19), claudeLine(week - 1, 6, 23)].join('\n'));
  await write('.grok/sessions/g-7/updates.jsonl', grokLine(NOW - HOUR));
  await write(`.pi/agent/sessions/w/2026-10-20T10-00-00-000Z_${uuid(4)}.jsonl`, piLine(NOW - HOUR));
  const openCodeDir = path.join(root, 'opencode');
  await fs.mkdir(openCodeDir);
  const db = new sqlite.DatabaseSync(path.join(openCodeDir, 'opencode.db'));
  db.exec('create table message (id text, data text, time_created integer)');
  db.prepare('insert into message values (?, ?, ?)').run('o1', JSON.stringify({ role: 'assistant', sessionID: 'ses_test1', modelID: 'oc-test',
    tokens: { input: 3, output: 4 } }), NOW - HOUR);
  db.close();
  const fetch = async () => new Response(JSON.stringify({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } }));
  const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'cache'), now: () => NOW, refreshMs: Infinity, log: () => {},
    fetch, machine: { machineId: SELF, name: 'desk' }, readSources: async () => [
      { enabled: true, provider: 'codex', dataDir: path.join(root, 'codex') },
      { enabled: true, provider: 'claude-desktop-code', projectsDir: path.join(root, 'projects') },
      { enabled: true, provider: 'opencode', dataDir: openCodeDir }] });
  t.after(() => Promise.all([usage.idle(), usage.pricesIdle()]));
  await usage.refresh();
  usage.report('7d');
  await usage.pricesIdle();
  const titles = { [`codex\0${uuid(1)}`]: 'release-plan', [`claude\0${uuid(2)}`]: 'docs', [`codex\0${uuid(2)}`]: 'wrong app' };
  const title = (app, id) => titles[`${app}\0${id}`] || '';
  const report = usage.report('7d', [], { title });
  const rows = Object.fromEntries(report.sessions.rows.map((row) => [`${row.app}/${row.id}`, row]));
  assert.deepEqual(Object.keys(rows).sort(), [`claude/${uuid(2)}`, `claude/${uuid(3)}`, `claude/${uuid(5)}`, `codex/${uuid(1)}`,
    'grok/g-7', 'opencode/ses_test1', `pi/${uuid(4)}`]);
  assert.deepEqual(report.sessions.counts, { [SELF]: 7 });
  assert.equal(rows[`codex/${uuid(1)}`].title, 'release-plan');
  assert.equal(rows[`claude/${uuid(2)}`].title, 'docs');
  assert.equal(rows[`claude/${uuid(3)}`].title, 'Unlisted session');
  assert.equal(rows['grok/g-7'].title, 'Unlisted session');
  // Message 1 counts once over both copies, and the subagent message in its parent session.
  assert.equal(rows[`claude/${uuid(2)}`].tokens.output + rows[`claude/${uuid(3)}`].tokens.output, 7 + 5 + 13 + 17);
  assert.ok([7 + 5 + 17, 5 + 17].includes(rows[`claude/${uuid(2)}`].tokens.output));
  // Period bounds: the message on the first bucket start counts, the one 1 ms before does not.
  assert.equal(rows[`claude/${uuid(5)}`].tokens.output, 19);
  assert.equal(usage.report('all', [], { title }).sessions.rows.find((row) => row.id === uuid(5)).tokens.output, 19 + 23);
  // Claude sessions are priced with the records' rates; the others have no price.
  const claudeCost = report.records.filter((record) => record.app === 'claude').reduce((sum, record) => sum + record.cost.total, 0);
  const sessionCost = report.sessions.rows.filter((row) => row.app === 'claude').reduce((sum, row) => sum + row.cost, 0);
  assert.ok(Math.abs(claudeCost - sessionCost) < 1e-5);
  assert.equal(rows[`codex/${uuid(1)}`].unpriced, true);
  // The session sums plus the usage with no session equal the local total, per token type.
  for (const type of TYPES) {
    const total = report.records.reduce((sum, record) => sum + record.tokens[type], 0);
    assert.equal(report.sessions.rows.reduce((sum, row) => sum + row.tokens[type], 0) + (report.sessions.none[SELF]?.tokens[type] || 0), total, type);
  }
  assert.equal(report.sessions.none[SELF].tokens.output, 11);
  // No transcript text or path becomes a title.
  assert.ok(!report.sessions.rows.some((row) => /projects|rollout|agent-a1/.test(row.title)));
  // The member reply: the same sums over its hours, with titles and costs.
  const hourly = usage.localHourly('7d', { title });
  assert.equal(hourly.sessions.length, 7);
  assert.equal(hourly.sessions.find((item) => item.id === uuid(1)).title, 'release-plan');
  assert.deepEqual(Object.keys(hourly.sessions.find((item) => item.id === uuid(2))), ['id', 'app', 'title', 'tokens', 'cost']);
});

test('the report keeps the 50 sessions with the most cost and the 50 with the most tokens of each machine, and counts all', () => {
  // 120 member sessions: cost rises with n, tokens fall with n, so the two top lists do not overlap.
  const sessions = Array.from({ length: 120 }, (_, n) => ({ id: `s${String(n).padStart(3, '0')}`, app: 'codex', title: `task ${n}`,
    tokens: { uncached: 1000 - n, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: n }));
  const usage = createActivityUsage({ machine: { machineId: SELF, name: 'desk' }, now: () => NOW, fetch: async () => { throw new Error('offline'); },
    cacheDir: path.join(os.tmpdir(), 'asb-usage-sessions-none'), log: () => {}, refreshMs: Infinity });
  const usageRecords = [{ app: 'codex', model: 'gpt-test-1', hourMs: Math.floor(NOW / HOUR) * HOUR - HOUR,
    tokens: { uncached: sessions.reduce((sum, item) => sum + item.tokens.uncached, 0) + 77, cacheRead: 0, cacheWrite: 0, output: 0 } }];
  const report = usage.report('24h', [{ machineId: MEMBER, name: 'laptop', state: 'online', usage: usageRecords, sessions }]);
  const member = report.sessions.rows.filter((row) => row.machineId === MEMBER);
  assert.equal(member.length, 2 * TOP_SESSIONS);
  assert.deepEqual(member.map((row) => row.id).sort(), [...sessions.slice(0, 50), ...sessions.slice(70)].map((item) => item.id).sort());
  assert.deepEqual(report.sessions.counts, { [MEMBER]: 120 });
  // The usage of the member's records that no session holds.
  assert.deepEqual(report.sessions.none[MEMBER].tokens, { uncached: 77, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.deepEqual(Object.keys(member[0]), ['machineId', 'id', 'app', 'title', 'tokens', 'cost']);
  // Ties go to the title, then the ID.
  const tied = [{ id: 'b', title: 'x' }, { id: 'a', title: 'x' }, { id: 'c', title: 'w' }].map((item) => ({ ...item, app: 'pi',
    tokens: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0 }));
  assert.deepEqual(topSessions(tied, 2).map((item) => item.id), ['c', 'a']);
});

test('member sessions: valid entries only, and a member that sends none has all its usage with no session', () => {
  const tokens = { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 };
  const good = { id: 'docs', app: 'claude', title: 'docs', tokens, cost: 1.5, unpriced: true, extra: 'dropped' };
  const kept = validSessions([good, { ...good, id: '' }, { ...good, id: 7 }, { ...good, title: 'x'.repeat(301) }, { ...good, title: 'x'.repeat(300) },
    { ...good, tokens: { ...tokens, output: -1 } }, { ...good, tokens: { ...tokens, output: Infinity } }, { ...good, tokens: { ...tokens, output: '4' } },
    { ...good, cost: Number.NaN }, { ...good, cost: undefined }, { ...good, app: null }, null, 'docs']);
  assert.deepEqual(kept, [{ id: 'docs', app: 'claude', title: 'docs', tokens, cost: 1.5, unpriced: true },
    { id: 'docs', app: 'claude', title: 'x'.repeat(300), tokens, cost: 1.5, unpriced: true }, { id: 'docs', app: 'claude', title: 'docs', tokens, unpriced: true }]);
  assert.equal(validSessions(Array.from({ length: 2500 }, () => good)).length, 2000);
  assert.deepEqual(validSessions('x'), []);
  // The member reply: sessions only when the member sends them (an older ASB sends none).
  assert.deepEqual(validActivity({ messages: [], usage: [], sessions: [good, { ...good, title: 5 }] }).sessions,
    [{ id: 'docs', app: 'claude', title: 'docs', tokens, cost: 1.5, unpriced: true }]);
  assert.equal(Object.hasOwn(validActivity({ messages: [], usage: [] }), 'sessions'), false);
  const usage = createActivityUsage({ machine: { machineId: SELF, name: 'desk' }, now: () => NOW, fetch: async () => { throw new Error('offline'); },
    cacheDir: path.join(os.tmpdir(), 'asb-usage-sessions-none'), log: () => {}, refreshMs: Infinity });
  const hourMs = Math.floor(NOW / HOUR) * HOUR - HOUR;
  const record = { app: 'claude', model: 'claude-test-5', hourMs, tokens };
  const report = usage.report('24h', [
    { machineId: MEMBER, name: 'laptop', state: 'online', usage: [record] },
    { machineId: 'c'.repeat(16), name: 'studio', state: 'online', usage: [record], sessions: [{ ...good, title: '' }, { id: 'bad' }] }]);
  assert.deepEqual(report.sessions.counts, { ['c'.repeat(16)]: 1 });
  assert.deepEqual(report.sessions.rows, [{ machineId: 'c'.repeat(16), id: 'docs', app: 'claude', title: 'Unlisted session', tokens, cost: 1.5, unpriced: true }]);
  assert.deepEqual(report.sessions.none, { [MEMBER]: { tokens, cost: 0 } });
});

test('a session takes the title of the local row of the same app and session ID', () => {
  const board = buildSwitchboardDashboard([
    { id: uuid(1), externalId: uuid(1), provider: 'codex', title: 'release-plan', updatedAtMs: NOW },
    { id: 'local-1', externalId: 'local-1', provider: 'claude-desktop-code', cliSessionId: uuid(2), priorCliSessionIds: [uuid(3)], title: 'docs', updatedAtMs: NOW },
    { id: 'ses_test1', externalId: 'ses_test1', provider: 'opencode', title: 'notes', updatedAtMs: NOW },
  ], [], NOW, { machineId: SELF, machineName: 'desk' });
  const title = usageSessionTitles(board);
  assert.deepEqual([title('codex', uuid(1)), title('claude', uuid(2)), title('claude', uuid(3)), title('opencode', 'ses_test1')],
    ['release-plan', 'docs', 'docs', 'notes']);
  // Another app with the same ID, an unknown ID, and no board give no title.
  assert.deepEqual([title('claude', uuid(1)), title('codex', uuid(9)), usageSessionTitles(null)('codex', uuid(1))], ['', '', '']);
});
