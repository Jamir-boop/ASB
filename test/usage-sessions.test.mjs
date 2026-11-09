// The usage of each session (decision D18): the session sums of the engine, the member sessions of contract 4, and the
// sessions part of the report. Synthetic transcripts, databases, and IDs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityUsage, sessionIdOf, TOP_SESSIONS } from '../src/activity-usage.mjs';
import { MAX_MEMBER_SESSIONS, memberSessions, periodBuckets, priceSessions, sessionSums, topSessions, validSessions } from '../src/usage-aggregation.mjs';
import { priceTokens } from '../src/usage-pricing.mjs';
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
  const { sessions, none } = sessionSums(parts, 10, 30);
  assert.deepEqual(sessions, [
    { app: 'claude', id: 'a', models: [{ model: 'm', tokens: tokens(4) }] },
    { app: 'claude', id: 'b', models: [{ model: 'm', tokens: tokens(5) }] }]);
  assert.deepEqual(none, tokens(6));
});

test('priceSessions prices each model with the function of the records: a model with no price gives unpriced and only the priced part', () => {
  const tokens = (output) => ({ uncached: 1, cacheRead: 2, cacheWrite: 3, output });
  const rates = new Map([['m', { input: 1, output: 2 }]]);
  assert.deepEqual(priceSessions([{ app: 'claude', id: 'a', title: 't', models: [{ model: 'm', tokens: tokens(4) }, { model: 'x', tokens: tokens(1) }] },
    { app: 'claude', id: 'b', title: 't', models: [{ model: 'm', tokens: tokens(4) }] }], rates), [
    { app: 'claude', id: 'a', title: 't', tokens: { uncached: 2, cacheRead: 4, cacheWrite: 6, output: 5 }, cost: priceTokens(rates, 'm', tokens(4)).total, unpriced: true },
    { app: 'claude', id: 'b', title: 't', tokens: tokens(4), cost: priceTokens(rates, 'm', tokens(4)).total }]);
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
  // The member reply: the same sums over its hours, with titles and the tokens of each model, no cost.
  const hourly = usage.localHourly('7d', { title });
  assert.equal(hourly.sessions.length, 7);
  assert.equal(hourly.sessions.find((item) => item.id === uuid(1)).title, 'release-plan');
  assert.deepEqual(hourly.sessions.find((item) => item.id === uuid(1)).models.map((item) => Object.keys(item)), [['model', 'tokens']]);
  assert.ok(hourly.sessions.every((item) => Object.keys(item).join() === 'id,app,title,models'));

  // A member with no price table: its reply has no cost, and the asking side prices its sessions with the table of its records.
  const member = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'member-cache'), now: () => NOW, refreshMs: Infinity,
    log: () => {}, fetch: async () => { throw new Error('offline'); }, machine: { machineId: MEMBER, name: 'laptop' }, readSources: async () => [
      { enabled: true, provider: 'codex', dataDir: path.join(root, 'codex') },
      { enabled: true, provider: 'claude-desktop-code', projectsDir: path.join(root, 'projects') }] });
  t.after(() => Promise.all([member.idle(), member.pricesIdle()]));
  await member.refresh();
  const reply = member.localHourly('24h', { title });
  assert.ok(reply.sessions.length > 0 && !JSON.stringify(reply.sessions).includes('cost'));
  const asked = usage.report('24h', [{ machineId: MEMBER, name: 'laptop', state: 'online', usage: reply.usage, sessions: reply.sessions }], { title });
  const memberRows = asked.sessions.rows.filter((row) => row.machineId === MEMBER && row.app === 'claude');
  const memberRecords = asked.records.filter((record) => record.machineId === MEMBER && record.app === 'claude');
  assert.equal(memberRows.length, 2);
  assert.ok(memberRows.every((row) => row.cost > 0 && !row.unpriced));
  assert.ok(Math.abs(memberRows.reduce((sum, row) => sum + row.cost, 0) - memberRecords.reduce((sum, record) => sum + record.cost.total, 0)) < 1e-5);
  // A member session with two models, one with no price: unpriced, and the cost of the priced model only.
  const claudeTokens = { uncached: 10, cacheRead: 100, cacheWrite: 5, output: 7 };
  const two = usage.report('24h', [{ machineId: MEMBER, name: 'laptop', state: 'online', usage: [], sessions: [
    { id: 'two', app: 'claude', title: 'docs', models: [{ model: 'claude-test-5', tokens: claudeTokens }, { model: 'no-price-test', tokens: claudeTokens }] },
    { id: 'one', app: 'claude', title: 'docs', models: [{ model: 'claude-test-5', tokens: claudeTokens }] }] }]).sessions.rows
    .filter((row) => row.machineId === MEMBER);
  const byId = Object.fromEntries(two.map((row) => [row.id, row]));
  assert.ok(byId.one.cost > 0 && !byId.one.unpriced);
  assert.deepEqual([byId.two.cost, byId.two.unpriced, byId.two.tokens.output], [byId.one.cost, true, 14]);
});

test('the report keeps the 50 sessions with the most cost and the 50 with the most tokens of each machine, and counts all', () => {
  const tokens = (uncached) => ({ uncached, cacheRead: 0, cacheWrite: 0, output: 0 });
  const sessions = Array.from({ length: 120 }, (_, n) => ({ id: `s${String(n).padStart(3, '0')}`, app: 'codex', title: `task ${n}`,
    models: [{ model: 'free-test', tokens: tokens(10_000 - n) }] }));
  const usage = createActivityUsage({ machine: { machineId: SELF, name: 'desk' }, now: () => NOW, fetch: async () => { throw new Error('offline'); },
    cacheDir: path.join(os.tmpdir(), 'asb-usage-sessions-none'), log: () => {}, refreshMs: Infinity });
  const usageRecords = [{ app: 'codex', model: 'free-test', hourMs: Math.floor(NOW / HOUR) * HOUR - HOUR,
    tokens: tokens(sessions.reduce((sum, item) => sum + item.models[0].tokens.uncached, 0) + 77) }];
  const report = usage.report('24h', [{ machineId: MEMBER, name: 'laptop', state: 'online', usage: usageRecords, sessions }]);
  const member = report.sessions.rows.filter((row) => row.machineId === MEMBER);
  // With no prices every cost is 0, so the cost order is the token order: one list of 50.
  assert.equal(member.length, TOP_SESSIONS);
  assert.deepEqual(member.map((row) => row.id).sort(), sessions.slice(0, 50).map((item) => item.id));
  assert.deepEqual(report.sessions.counts, { [MEMBER]: 120 });
  // The usage of the member's records that no session holds.
  assert.deepEqual(report.sessions.none[MEMBER].tokens, tokens(77));
  assert.deepEqual(Object.keys(member[0]), ['machineId', 'id', 'app', 'title', 'tokens', 'cost', 'unpriced']);
  // With a cost order that differs from the token order, the union has 50 + 50 rows.
  const priced = sessions.map((item, n) => ({ ...item, tokens: tokens(10_000 - n), cost: n }));
  const top = topSessions(priced, TOP_SESSIONS);
  assert.equal(top.length, 2 * TOP_SESSIONS);
  assert.deepEqual(top.map((row) => row.id).sort(), [...sessions.slice(0, 50), ...sessions.slice(70)].map((item) => item.id).sort());
  // Ties go to the title, then the ID.
  const tied = [{ id: 'b', title: 'x' }, { id: 'a', title: 'x' }, { id: 'c', title: 'w' }].map((item) => ({ ...item, app: 'pi', tokens: tokens(1), cost: 0 }));
  assert.deepEqual(topSessions(tied, 2).map((item) => item.id), ['c', 'a']);
});

test('the member reply keeps the 2,000 sessions with the most tokens; ties go to the title, then the ID', () => {
  const tokens = (uncached) => ({ uncached, cacheRead: 0, cacheWrite: 0, output: 0 });
  const list = Array.from({ length: 2100 }, (_, n) => ({ id: `s${String(n).padStart(4, '0')}`, app: 'codex', title: n < 10 ? 'same' : `t${n}`,
    models: [{ model: 'm', tokens: tokens(n < 10 ? 5 : n) }] }));
  const kept = memberSessions(list);
  assert.equal(kept.length, MAX_MEMBER_SESSIONS);
  assert.equal(kept[0].id, 's2099');
  // The 100 with the fewest tokens go: the 10 ties (5 tokens) and n = 10 to 99.
  assert.deepEqual(kept.slice(-2).map((item) => item.id), ['s0101', 's0100']);
  assert.deepEqual(memberSessions(list.slice(0, 3).reverse()).map((item) => item.id), ['s0000', 's0001', 's0002']);
});

test('member sessions: valid entries only, and a member that sends none has all its usage with no session', () => {
  const tokens = { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 };
  const models = [{ model: 'claude-test-5', tokens, extra: 'dropped' }];
  const good = { id: 'docs', app: 'claude', title: 'docs', models, cost: 1.5, unpriced: true, tokens, extra: 'dropped' };
  const clean = { id: 'docs', app: 'claude', title: 'docs', models: [{ model: 'claude-test-5', tokens }] };
  const model = (change) => ({ ...good, models: [{ ...models[0], ...change }] });
  const kept = validSessions([good, { ...good, id: '' }, { ...good, id: 7 }, { ...good, title: 'x'.repeat(301) }, { ...good, title: 'x'.repeat(300) },
    { ...good, app: null }, { ...good, app: 'x'.repeat(301) }, { ...good, models: [] }, { ...good, models: undefined },
    { ...good, models: Array(17).fill(models[0]) }, { ...good, models: Array(16).fill(models[0]) },
    model({ model: '' }), model({ model: 'x'.repeat(301) }), model({ model: 5 }), model({ model: 'x'.repeat(300) }),
    model({ tokens: { ...tokens, output: -1 } }), model({ tokens: { ...tokens, output: Infinity } }), model({ tokens: { ...tokens, output: '4' } }),
    model({ tokens: { ...tokens, output: Number.NaN } }), model({ tokens: null }), null, 'docs']);
  assert.deepEqual(kept, [clean, { ...clean, title: 'x'.repeat(300) }, { ...clean, models: Array(16).fill(clean.models[0]) },
    { ...clean, models: [{ model: 'x'.repeat(300), tokens }] }]);
  assert.equal(validSessions(Array.from({ length: 2500 }, () => good)).length, 2000);
  assert.deepEqual(validSessions('x'), []);
  // The member reply: sessions only when the member sends them (an older ASB sends none).
  assert.deepEqual(validActivity({ messages: [], usage: [], sessions: [good, { ...good, title: 5 }] }).sessions, [clean]);
  assert.equal(Object.hasOwn(validActivity({ messages: [], usage: [] }), 'sessions'), false);
  const usage = createActivityUsage({ machine: { machineId: SELF, name: 'desk' }, now: () => NOW, fetch: async () => { throw new Error('offline'); },
    cacheDir: path.join(os.tmpdir(), 'asb-usage-sessions-none'), log: () => {}, refreshMs: Infinity });
  const hourMs = Math.floor(NOW / HOUR) * HOUR - HOUR;
  const record = { app: 'claude', model: 'claude-test-5', hourMs, tokens };
  const report = usage.report('24h', [
    { machineId: MEMBER, name: 'laptop', state: 'online', usage: [record] },
    { machineId: 'c'.repeat(16), name: 'studio', state: 'online', usage: [record], sessions: [{ ...good, title: '' }, { id: 'bad' }] }]);
  assert.deepEqual(report.sessions.counts, { ['c'.repeat(16)]: 1 });
  // No price table here: the model has no price, so the session is unpriced with cost 0.
  assert.deepEqual(report.sessions.rows, [{ machineId: 'c'.repeat(16), id: 'docs', app: 'claude', title: 'Unlisted session', tokens, cost: 0, unpriced: true }]);
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
