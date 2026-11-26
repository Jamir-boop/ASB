import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { querySqliteJson } from '../src/codex-data.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { defaultOpenCodeStateDir, invalidateOpenCodeData, loadOpenCodeDashboard, opencodeBridgeId, OPENCODE_APPROVAL_WAIT } from '../src/opencode-data.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

const now = Date.parse('2026-10-19T12:00:00Z');
const minute = 60 * 1000;
const hour = 60 * minute;
const SESSION_COLUMNS = ['id', 'project_id', 'parent_id', 'slug', 'directory', 'title', 'time_created', 'time_updated',
  'time_archived', 'time_suspended', 'time_idle', 'time_viewed', 'idle_outcome'];
const PART_COLUMNS = ['message_id', 'session_id', 'ordinal', 'type', 'call_id', 'time_created', 'time_updated', 'data'];
const SECRET = 'fake-token-do-not-read';
const PROMPT = 'private prompt text';

function createDatabase(databasePath, { sessionColumns = SESSION_COLUMNS, session = true, parts = false,
  partColumns = PART_COLUMNS, wal = false } = {}) {
  const database = new DatabaseSync(databasePath);
  if (wal) database.exec('pragma journal_mode = wal');
  if (session) database.exec(`create table session_v2 (${sessionColumns.map((name) => `${name} ${name.startsWith('time_') ? 'integer' : 'text'}`).join(', ')})`);
  database.exec(`create table session_message (id text, session_id text, type text, seq integer, time_created integer,
    time_updated integer, data text)`);
  if (parts) database.exec(`create table session_part (${partColumns.map((name) => `${name} ${name.startsWith('time_') ? 'integer' : 'text'}`).join(', ')})`);
  database.exec('create table account (id text, access_token text)');
  database.prepare('insert into account values (?, ?)').run('acc_1', SECRET);
  return database;
}

function addSession(database, row) {
  const columns = Object.keys(row);
  database.prepare(`insert into session_v2 (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

function addMessage(database, sessionId, atMs) {
  database.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
    .run(`msg_${sessionId}_${atMs}`, sessionId, 'assistant', 1, atMs, atMs, JSON.stringify({ text: PROMPT }));
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'asb-opencode-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, databasePath: path.join(dataDir, 'opencode.db') };
}

function recordingQuery() {
  const sql = [];
  const query = (databasePath, text) => { sql.push(text); return querySqliteJson(databasePath, text); };
  return { sql, query };
}

const base = { directory: '/work/app', time_created: now - 2 * hour, time_updated: now - 2 * hour };

function seed(database) {
  addSession(database, { ...base, id: 'ses_working', title: 'Working session', slug: 'brave-otter',
    time_suspended: now - 10 * minute, time_idle: now - hour, idle_outcome: 'succeeded', time_viewed: now - hour });
  addMessage(database, 'ses_working', now - 2 * minute);
  addSession(database, { ...base, id: 'ses_child', parent_id: 'ses_working', title: 'Child', slug: 'tiny-crab' });
  addMessage(database, 'ses_child', now - minute);
  addSession(database, { ...base, id: 'ses_stale', title: 'Stale claim', slug: 'old-whale', time_suspended: now - 9 * hour });
  addMessage(database, 'ses_stale', now - 8 * hour);
  addSession(database, { ...base, id: 'ses_done', title: 'Done', slug: 'calm-squid', time_idle: now - 5 * minute,
    idle_outcome: 'succeeded' });
  addSession(database, { ...base, id: 'ses_failed', title: 'Failed', slug: 'red-fox', time_idle: now - 6 * minute,
    idle_outcome: 'failed', time_viewed: now - minute });
  addSession(database, { ...base, id: 'ses_stopped', title: 'Stopped', slug: 'still-pond', time_idle: now - 7 * minute,
    idle_outcome: 'interrupted', time_viewed: now - 8 * minute });
  addSession(database, { ...base, id: 'ses_new', title: '', slug: 'quiet-moth' });
  addSession(database, { ...base, id: 'ses_archived', title: 'Archived', slug: 'gray-owl', time_idle: now - 3 * hour,
    idle_outcome: 'succeeded', time_viewed: now - 2 * hour, time_archived: now - hour });
}

test('OpenCode roots map to threads and rows with states, outcomes, unread, archive, and subagents', async (t) => {
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath);
  seed(database);
  database.close();
  const { sql, query } = recordingQuery();
  const result = await loadOpenCodeDashboard({ dataDir, nowMs: now, query });
  assert.deepEqual(result.provider, { installed: true, status: 'ready', message: '', threadCount: 7 });
  const threads = Object.fromEntries(result.threads.map((thread) => [thread.id, thread]));
  assert.equal(threads.ses_child, undefined);
  assert.deepEqual(threads.ses_working, {
    id: 'ses_working', externalId: 'ses_working', provider: 'opencode', source: 'opencode-db',
    title: 'Working session', cwd: '/work/app', archived: false, createdAtMs: now - 2 * hour,
    updatedAtMs: now - minute, embeddedSubagentCount: 1, lifecycleRunning: true,
    agentStartedAtMs: now - 10 * minute, agentActivityAtMs: now - minute, latestLifecycleKind: 'task_complete',
    latestLifecycleAtMs: now - hour, latestTaskEndedAtMs: now - hour, nativeUnread: false, readStatus: 'read',
  });
  assert.equal(threads.ses_new.title, 'quiet-moth');
  assert.equal(threads.ses_new.nativeUnread, null);
  assert.equal(threads.ses_new.readStatus, 'unknown');
  assert.equal(threads.ses_new.lifecycleRunning, false);
  assert.equal(threads.ses_done.readStatus, 'unread');
  assert.equal(threads.ses_stopped.nativeUnread, true);
  assert.equal(threads.ses_stopped.latestLifecycleKind, 'turn_aborted');
  assert.equal(threads.ses_failed.latestLifecycleKind, 'failed');
  assert.equal(threads.ses_archived.archived, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(PROMPT), false);
  // Only the background count query and the quota query read message data, inside SQLite: they return IDs, kinds, counts,
  // and one error type.
  for (const text of sql) assert.doesNotMatch(text, /\b(?:account|control_account|credential|kv)\b/i);
  for (const text of sql.filter((text) => !/^with tool_parts as \(/.test(text)
    && !/^select s\.id as id, json_extract\(case when json_valid\(m\.data\) then m\.data end, '\$\.error\.type'\) as error_type\s/.test(text))) {
    assert.doesNotMatch(text, /\bdata\b/i);
  }
  assert.ok(sql.some((text) => /from session_message/.test(text)));

  const rows = Object.fromEntries(buildSwitchboardDashboard(result.threads, [], now).threads.map((row) => [row.id, row]));
  assert.equal(rows.ses_child, undefined);
  assert.equal(rows.ses_working.state, 'working');
  assert.equal(rows.ses_working.workingSinceMs, now - 10 * minute);
  assert.equal(rows.ses_working.subagentCount, 1);
  assert.equal(rows.ses_working.lastOutcome, '');
  assert.deepEqual([rows.ses_stale.state, rows.ses_stale.reason], ['unknown', 'The last task has no recent signal.']);
  for (const id of ['ses_done', 'ses_failed', 'ses_stopped', 'ses_new', 'ses_archived']) assert.equal(rows[id].state, 'idle');
  assert.deepEqual([rows.ses_done.lastOutcome, rows.ses_done.completionAtMs, rows.ses_done.failedAtMs], ['', now - 5 * minute, 0]);
  assert.deepEqual([rows.ses_failed.lastOutcome, rows.ses_failed.completionAtMs, rows.ses_failed.failedAtMs], ['failed', 0, now - 6 * minute]);
  assert.deepEqual([rows.ses_stopped.lastOutcome, rows.ses_stopped.completionAtMs, rows.ses_stopped.failedAtMs], ['stopped', 0, 0]);
  assert.deepEqual([rows.ses_done.nativeUnread, rows.ses_failed.nativeUnread, rows.ses_new.nativeUnread], [true, false, null]);
  assert.deepEqual([rows.ses_done.readStatus, rows.ses_failed.readStatus, rows.ses_new.readStatus], ['unread', 'read', 'unknown']);
  assert.equal(rows.ses_archived.archived, true);
  for (const row of Object.values(rows)) {
    assert.deepEqual([row.provider, row.providerLabel, row.canOpen, row.appDeepLink], ['opencode', 'OpenCode', false, '']);
    assert.equal(row.questionPending, false);
    assert.equal(row.actionRequired, false);
  }
});

test('OpenCode rows count open background shells and busy background subagents', async (t) => {
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath);
  const part = (shellID, background = true, status = 'completed') => ({ type: 'tool', id: `call_${shellID}`, name: 'shell',
    state: { status, input: { command: PROMPT, ...(background ? { background: true } : {}) }, metadata: { shellID, status: 'running' } } });
  // A foreground shell in progress has no shell ID.
  const foreground = { type: 'tool', id: 'call_fore', name: 'shell', state: { status: 'running', input: { command: PROMPT }, metadata: {} } };
  let seq = 0;
  const message = (sessionId, type, data, atMs = now - minute) => database.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
    .run(`msg_${seq += 1}`, sessionId, type, seq, atMs, atMs, typeof data === 'string' ? data : JSON.stringify(data));
  const subagent = (sessionID, background) => ({ type: 'tool', id: `call_${sessionID}`, name: 'subagent',
    state: { status: 'running', input: { prompt: PROMPT, background }, metadata: { sessionID } } });
  const end = (sessionId, shellID) => message(sessionId, 'synthetic', { text: PROMPT, description: PROMPT,
    metadata: { source: 'shell', shellID, jobID: 'job_1', state: 'completed', exit: 0, truncated: false } });
  for (const id of ['ses_main', 'ses_quiet', 'ses_old']) addSession(database, { ...base, id, title: id, time_idle: now - hour });
  // Two open shells (one that OpenCode moved to the background with no input background), one ended shell, a shell in the
  // foreground, and a shell with an error in the root; one open shell in a child.
  message('ses_main', 'assistant', { content: [{ type: 'text', text: PROMPT }, part('sh_open1'), part('sh_auto', false), part('sh_ended'),
    foreground, part('sh_error', false, 'error')] });
  end('ses_main', 'sh_ended');
  addSession(database, { ...base, id: 'ses_busy', parent_id: 'ses_main', time_suspended: now - minute });
  addSession(database, { ...base, id: 'ses_idle', parent_id: 'ses_main', time_idle: now - minute });
  // A foreground subagent call also suspends its child, so only a background call counts.
  addSession(database, { ...base, id: 'ses_fore', parent_id: 'ses_main', time_suspended: now - minute });
  message('ses_main', 'assistant', { content: [subagent('ses_busy', true), subagent('ses_idle', true), subagent('ses_fore', false)] });
  message('ses_busy', 'assistant', { content: [part('sh_open2')] });
  // An end in another session does not end a shell; a shell or subagent call older than the 24-hour window does not count.
  message('ses_quiet', 'assistant', { content: [part('sh_other')] });
  end('ses_main', 'sh_other');
  message('ses_old', 'assistant', { content: [part('sh_old')] }, now - 25 * hour);
  addSession(database, { ...base, id: 'ses_old_child', parent_id: 'ses_old', time_suspended: now - minute });
  message('ses_old', 'assistant', { content: [subagent('ses_old_child', true)] }, now - 25 * hour);
  // A message that is not valid JSON does not fail the load.
  message('ses_quiet', 'assistant', '{"content": [{"type": "tool", "name": "shell", "state": {"metadata": {"shellID": "sh_bad"');
  message('ses_quiet', 'synthetic', '{"metadata": {"source": "shell", "shellID": "sh_other"');
  database.close();
  const { threads } = await loadOpenCodeDashboard({ dataDir, nowMs: now });
  const counts = Object.fromEntries(buildSwitchboardDashboard(threads, [], now).threads
    .map((row) => [row.id, [row.backgroundCommands, row.backgroundAgents]]));
  assert.deepEqual(counts, { ses_main: [3, 1], ses_quiet: [1, undefined], ses_old: [undefined, undefined] });
  assert.equal(JSON.stringify(threads).includes(PROMPT), false);
});

test('OpenCode counts background agents and shells from session_part tool rows', async (t) => {
  invalidateOpenCodeData();
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath, { parts: true });
  const shell = (shellID) => ({ type: 'tool', id: `call_${shellID}`, name: 'shell',
    state: { status: 'completed', input: { command: PROMPT }, metadata: { shellID, status: 'running' } } });
  const subagent = (sessionID) => ({ type: 'tool', id: `call_${sessionID}`, name: 'subagent',
    state: { status: 'completed', input: { agent: 'build', description: PROMPT, prompt: PROMPT },
      metadata: { sessionID, status: 'running' } } });
  let seq = 0;
  const part = (sessionId, value, atMs = now - minute) => database.prepare(`insert into session_part
    (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`msg_${seq += 1}`, sessionId, seq, 'tool', `call_${seq}`, atMs, atMs,
      typeof value === 'string' ? value : JSON.stringify(value));
  const end = (sessionId, shellID) => database.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
    .run(`msg_end_${shellID}`, sessionId, 'synthetic', seq += 1, now - minute, now - minute,
      JSON.stringify({ metadata: { source: 'shell', shellID } }));
  addSession(database, { ...base, id: 'ses_main', title: 'Main', time_idle: now - hour });
  addSession(database, { ...base, id: 'ses_shell', title: 'Shell', time_idle: now - hour });
  addSession(database, { ...base, id: 'ses_none', title: 'No busy child', time_idle: now - hour });
  addSession(database, { ...base, id: 'ses_busy', parent_id: 'ses_main', time_suspended: now - minute });
  addSession(database, { ...base, id: 'ses_idle', parent_id: 'ses_none', time_idle: now - minute });
  part('ses_main', subagent('ses_busy'));
  part('ses_main', subagent('ses_idle'));
  part('ses_shell', shell('sh_open'));
  part('ses_shell', shell('sh_ended'));
  end('ses_shell', 'sh_ended');
  part('ses_shell', shell('sh_old'), now - 25 * hour);
  part('ses_shell', '{"type":"tool","name":"shell","state":{"metadata":{"shellID":"sh_bad"');
  database.close();
  const { threads } = await loadOpenCodeDashboard({ dataDir, nowMs: now });
  const byId = Object.fromEntries(threads.map((row) => [row.id, row]));
  assert.equal(byId.ses_main.backgroundAgents, 1);
  assert.equal(byId.ses_shell.backgroundCommands, 1);
  assert.equal('backgroundAgents' in byId.ses_none, false);
  assert.equal('backgroundCommands' in byId.ses_none, false);
  assert.equal(JSON.stringify(threads).includes(PROMPT), false);
  invalidateOpenCodeData();
});

test('OpenCode uses old message parts when session_part is absent or lacks a used column', async (t) => {
  const old = { type: 'tool', id: 'call_old', name: 'subagent', state: { status: 'running',
    input: { prompt: PROMPT, background: true }, metadata: { sessionID: 'ses_busy' } } };
  const shell = { type: 'tool', id: 'call_shell', name: 'shell', state: { status: 'completed',
    input: { command: PROMPT }, metadata: { shellID: 'sh_old', status: 'running' } } };
  for (const parts of [false, true]) {
    invalidateOpenCodeData();
    const { dataDir, databasePath } = await fixture(t);
    const database = createDatabase(databasePath, { parts, partColumns: parts ? PART_COLUMNS.filter((name) => name !== 'time_created') : PART_COLUMNS });
    addSession(database, { ...base, id: 'ses_main', title: 'Main', time_idle: now - hour });
    addSession(database, { ...base, id: 'ses_busy', parent_id: 'ses_main', time_suspended: now - minute });
    database.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
      .run('msg_old', 'ses_main', 'assistant', 1, now - minute, now - minute, JSON.stringify({ content: [old, shell] }));
    database.close();
    const { threads } = await loadOpenCodeDashboard({ dataDir, nowMs: now });
    assert.equal(threads[0].backgroundAgents, 1);
    assert.equal(threads[0].backgroundCommands, 1);
  }
  invalidateOpenCodeData();
});

test('OpenCode background counts end 24 hours after the earliest counted start with no database change', async (t) => {
  invalidateOpenCodeData();
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath);
  const shell = (shellID) => ({ type: 'tool', id: `call_${shellID}`, name: 'shell',
    state: { status: 'completed', input: { command: PROMPT }, metadata: { shellID, status: 'running' } } });
  const subagent = (sessionID) => ({ type: 'tool', id: `call_${sessionID}`, name: 'subagent',
    state: { status: 'running', input: { prompt: PROMPT, background: true }, metadata: { sessionID } } });
  let seq = 0;
  const message = (sessionId, content, atMs) => database.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
    .run(`msg_${seq += 1}`, sessionId, 'assistant', seq, atMs, atMs, JSON.stringify({ content }));
  addSession(database, { ...base, id: 'ses_main', title: 'Main', time_idle: now - hour });
  addSession(database, { ...base, id: 'ses_busy', parent_id: 'ses_main', time_suspended: now - minute });
  // The subagent starts first, so its start sets the deadline for both counts.
  message('ses_main', [subagent('ses_busy')], now - 23 * hour);
  message('ses_main', [shell('sh_open')], now - 2 * hour);
  database.close();
  const deadline = now - 23 * hour + 24 * hour + 1;
  const { sql, query } = recordingQuery();
  const load = async (nowMs) => {
    const result = await loadOpenCodeDashboard({ dataDir, nowMs, query });
    const board = buildSwitchboardDashboard(result.threads, [], nowMs);
    return [board.threads.map((row) => [row.backgroundCommands, row.backgroundAgents]), board.nextStatusCheckAtMs];
  };
  assert.deepEqual(await load(now), [[[1, 1]], deadline]);
  const queries = sql.length;
  assert.deepEqual(await load(deadline - 1), [[[1, 1]], deadline], 'the kept result shows before the deadline');
  assert.equal(sql.length, queries, 'the kept result reads nothing');
  const [counts, next] = await load(deadline);
  assert.deepEqual(counts, [[1, undefined]], 'the subagent call left the window; the shell counts');
  assert.ok(sql.length > queries, 'the load at the deadline runs the query again');
  assert.equal(next, now - 2 * hour + 24 * hour + 1);
  const later = now - 2 * hour + 24 * hour + 1;
  const [none, after] = await load(later);
  assert.deepEqual(none, [[undefined, undefined]]);
  assert.ok(!(after <= later), 'no busy loop: the next check is later or absent');
  invalidateOpenCodeData();
});

test('OpenCode card times use messages and idle time before record updates', async (t) => {
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath);
  for (const [id, idleAt, messageAt] of [['message', now - hour, now - minute],
    ['idle', now - minute, now - hour], ['missing', null, null], ['zero', 0, 0]]) {
    addSession(database, { ...base, id, time_updated: now, time_idle: idleAt });
    if (messageAt != null) addMessage(database, id, messageAt);
  }
  addSession(database, { ...base, id: 'child', parent_id: 'message' });
  addMessage(database, 'child', now - 1000);
  database.close();
  const { threads } = await loadOpenCodeDashboard({ dataDir, nowMs: now });
  assert.deepEqual(Object.fromEntries(threads.map((thread) => [thread.id, thread.updatedAtMs])),
    { message: now - 1000, idle: now - minute, missing: now, zero: now });
});

test('OpenCode reports a missing database, an old schema, and a missing column without rows', async (t) => {
  const { dataDir, databasePath } = await fixture(t);
  assert.deepEqual(await loadOpenCodeDashboard({ dataDir, nowMs: now }),
    { generatedAtMs: now, provider: { installed: false, status: 'missing', message: '' }, threads: [] });
  createDatabase(databasePath, { session: false }).close();
  const warning = { installed: true, status: 'warning', message: 'ASB reads OpenCode 2 sessions only. Update OpenCode.' };
  assert.deepEqual(await loadOpenCodeDashboard({ dataDir, nowMs: now }), { generatedAtMs: now, provider: warning, threads: [] });
  await rm(databasePath);
  const other = await fixture(t);
  const database = createDatabase(other.databasePath, { sessionColumns: SESSION_COLUMNS.filter((name) => name !== 'time_viewed') });
  addSession(database, { ...base, id: 'ses_one', title: 'One' });
  database.close();
  const { sql, query } = recordingQuery();
  assert.deepEqual(await loadOpenCodeDashboard({ dataDir: other.dataDir, nowMs: now, query }),
    { generatedAtMs: now, provider: warning, threads: [] });
  assert.equal(sql.some((text) => /from session_v2/.test(text)), false);
});

test('OpenCode reuses its result until the database or its WAL changes, and never writes OpenCode files', async (t) => {
  const { dataDir, databasePath } = await fixture(t);
  const writer = createDatabase(databasePath, { wal: true });
  // Windows cannot remove an open database, and t.after hooks run in the order they were added, so the writer closes here.
  try {
    addSession(writer, { ...base, id: 'ses_one', title: 'One' });
    const { sql, query } = recordingQuery();
    const first = await loadOpenCodeDashboard({ dataDir, nowMs: now, cacheScope: dataDir, query });
    const count = sql.length;
    assert.equal(first.threads.length, 1);
    assert.equal(await loadOpenCodeDashboard({ dataDir, nowMs: now, cacheScope: dataDir, query }), first);
    assert.equal(sql.length, count);
    const main = await readFile(databasePath);
    addSession(writer, { ...base, id: 'ses_two', title: 'Two' });
    assert.deepEqual(await readFile(databasePath), main);
    const second = await loadOpenCodeDashboard({ dataDir, nowMs: now, cacheScope: dataDir, query });
    assert.deepEqual(second.threads.map((thread) => thread.id).sort(), ['ses_one', 'ses_two']);
    invalidateOpenCodeData();
    const third = await loadOpenCodeDashboard({ dataDir, nowMs: now, cacheScope: dataDir, query });
    assert.notEqual(third, second);
    assert.deepEqual(third.threads, second.threads);
    await writeFile(path.join(dataDir, 'auth.json'), SECRET);
    const wal = await readFile(`${databasePath}-wal`);
    await loadOpenCodeDashboard({ dataDir, nowMs: now, cacheScope: 'other', query });
    assert.deepEqual(await readFile(`${databasePath}-wal`), wal);
    assert.deepEqual(await readFile(databasePath), main);
  } finally { writer.close(); }
});

const bridgeIds = ['18284f68-b2c6-5cca-8fb7-12d5973743f9', '73d74cef-fea1-5f25-8922-19bb70b05a69'];
const sessionIds = ['ses_asbTestOpenCode01', 'ses_asbTestOpenCode02'];
const peerId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('OpenCode bridge IDs match the bridge UUID v5 vectors', () => {
  assert.deepEqual(sessionIds.map((id) => opencodeBridgeId(id)), bridgeIds);
});

test('OpenCode state defaults follow XDG_STATE_HOME or the supplied home', () => {
  assert.equal(defaultOpenCodeStateDir({ homeDir: '/h', env: {} }), path.join('/h', '.local', 'state', 'opencode'));
  assert.equal(defaultOpenCodeStateDir({ homeDir: '/h', env: { XDG_STATE_HOME: '/x' } }), path.join('/x', 'opencode'));
});

async function messageFixture(t) {
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath);
  for (const id of sessionIds) addSession(database, { ...base, id, title: id });
  database.close();
  const stateDir = path.join(dataDir, '.local', 'state', 'opencode');
  const directory = path.join(stateDir, 'plugin-state', 'asb-bridge');
  await mkdir(directory, { recursive: true });
  const writer = new DatabaseSync(path.join(directory, `${bridgeIds[0]}.sqlite`));
  writer.exec(`pragma journal_mode=WAL;
    create table messages(id integer primary key, peer_id text, direction text, text text, status text, created_at integer, kind text);`);
  const insert = writer.prepare('insert into messages(peer_id, direction, text, status, created_at, kind) values (?, ?, ?, ?, ?, ?)');
  const add = (n, direction, status, offset, kind = 'message') => insert.run(peerId(n), direction, PROMPT, status, now / 1000 + offset, kind);
  return { dataDir, stateDir, writer, add };
}

test('OpenCode attaches only delivered incoming bridge messages to the receiving session', async (t) => {
  const f = await messageFixture(t);
  try {
    f.add(1, 'in', 'started', -20);
    f.add(2, 'in', 'steered', -10);
    f.add(3, 'out', 'started', -9);
    f.add(4, 'in', 'dropped', -8);
    f.add(5, 'in', 'started', -7, 'idle-notice');
    f.add(6, 'in', 'started', -121);
    const result = await loadOpenCodeDashboard({ dataDir: f.dataDir, stateDir: f.stateDir, nowMs: now });
    assert.deepEqual(result.threads.find((thread) => thread.id === sessionIds[0]).incomingMessages,
      [{ from: peerId(1), atMs: now - 20_000 }, { from: peerId(2), atMs: now - 10_000 }]);
    assert.equal(Object.hasOwn(result.threads.find((thread) => thread.id === sessionIds[1]), 'incomingMessages'), false);
    assert.equal(JSON.stringify(result).includes(PROMPT), false);
  } finally { f.writer.close(); }
});

test('OpenCode refreshes bridge messages on a database cache hit without changing earlier results', async (t) => {
  const f = await messageFixture(t);
  try {
    const options = { dataDir: f.dataDir, stateDir: f.stateDir, nowMs: now, cacheScope: f.dataDir };
    const { sql, query } = recordingQuery();
    const bare = await loadOpenCodeDashboard({ dataDir: f.dataDir, nowMs: now, cacheScope: f.dataDir, query });
    const queryCount = sql.length;
    f.add(1, 'in', 'started', -20);
    const first = await loadOpenCodeDashboard({ ...options, query });
    const entries = [{ from: peerId(1), atMs: now - 20_000 }];
    assert.deepEqual(first.threads.find((thread) => thread.id === sessionIds[0]).incomingMessages, entries);
    f.add(2, 'in', 'steered', -10);
    const second = await loadOpenCodeDashboard({ ...options, query });
    assert.deepEqual(second.threads.find((thread) => thread.id === sessionIds[0]).incomingMessages,
      [...entries, { from: peerId(2), atMs: now - 10_000 }]);
    assert.equal(sql.length, queryCount);
    assert.notEqual(second, first);
    assert.deepEqual(first.threads.find((thread) => thread.id === sessionIds[0]).incomingMessages, entries);
    assert.ok(bare.threads.every((thread) => !Object.hasOwn(thread, 'incomingMessages')));
    assert.equal(second.threads.find((thread) => thread.id === sessionIds[1]), bare.threads.find((thread) => thread.id === sessionIds[1]));
    assert.equal(await loadOpenCodeDashboard({ dataDir: f.dataDir, nowMs: now, cacheScope: f.dataDir, query }), bare);
  } finally { f.writer.close(); }
});

test('OpenCode without stateDir ignores a plugin database under the temporary home', async (t) => {
  const f = await messageFixture(t);
  try {
    f.add(1, 'in', 'started', -20);
    const result = await loadOpenCodeDashboard({ dataDir: f.dataDir, nowMs: now });
    assert.ok(result.threads.every((thread) => !Object.hasOwn(thread, 'incomingMessages')));
  } finally { f.writer.close(); }
});

test('OpenCode shows a provider.quota failure as a usage-limit stop with no reset, until a later run', async (t) => {
  const { dataDir, databasePath } = await fixture(t);
  const database = createDatabase(databasePath);
  let seq = 0;
  const reply = (sessionId, atMs, error, data = null) => database.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)')
    .run(`msg_${seq += 1}`, sessionId, 'assistant', seq, atMs, atMs,
      data ?? JSON.stringify({ text: PROMPT, ...(error ? { error: { type: error, message: PROMPT } } : {}) }));
  const failed = { ...base, time_idle: now - 5 * minute, idle_outcome: 'failed' };
  addSession(database, { ...failed, id: 'ses_quota' });
  reply('ses_quota', now - 7 * minute, 'provider.error');
  reply('ses_quota', now - 6 * minute, 'provider.quota');
  // A newer reply with another error, a provider error, a broken newest reply, and a quota stop that a new run or turn follows do not count.
  addSession(database, { ...failed, id: 'ses_old_quota' });
  reply('ses_old_quota', now - 7 * minute, 'provider.quota');
  reply('ses_old_quota', now - 6 * minute, 'aborted');
  addSession(database, { ...failed, id: 'ses_error' });
  reply('ses_error', now - 6 * minute, 'provider.error');
  addSession(database, { ...failed, id: 'ses_broken' });
  reply('ses_broken', now - 7 * minute, 'provider.quota');
  reply('ses_broken', now - 6 * minute, '', '{"error": {"type": "provider.quota"');
  addSession(database, { ...failed, id: 'ses_running', time_suspended: now - minute });
  reply('ses_running', now - 6 * minute, 'provider.quota');
  addSession(database, { ...base, id: 'ses_done', time_idle: now - minute, idle_outcome: 'succeeded' });
  reply('ses_done', now - 6 * minute, 'provider.quota');
  database.close();
  const { threads } = await loadOpenCodeDashboard({ dataDir, nowMs: now });
  const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  assert.deepEqual([byId.ses_quota.limitStopped, byId.ses_quota.limitStoppedAtMs, 'limitResetsAtMs' in byId.ses_quota],
    [true, now - 5 * minute, false]);
  for (const id of ['ses_old_quota', 'ses_error', 'ses_broken', 'ses_running', 'ses_done']) assert.equal('limitStopped' in byId[id], false, id);
  const rows = Object.fromEntries(buildSwitchboardDashboard(threads, [], now).threads.map((row) => [row.id, row]));
  assert.deepEqual([rows.ses_quota.state, rows.ses_quota.lastOutcome, rows.ses_quota.failedAtMs, rows.ses_quota.limitResetsAtMs],
    ['idle', 'limit', now - 5 * minute, 0]);
  assert.equal(rows.ses_error.lastOutcome, 'failed');
  assert.equal(rows.ses_running.state, 'working');
  assert.equal(JSON.stringify(threads).includes(PROMPT), false);
});

test('OpenCode shows Bridge questions and approvals only for a live receiver', async (t) => {
  const f = await messageFixture(t);
  try {
    // On Windows a receiver counts while its PID lives (bridgeReceiverLive); the start time is a Linux /proc rule.
    const windows = process.platform === 'win32';
    const procStart = windows ? 'start' : await processStart(process.pid);
    assert.ok(procStart);
    f.writer.exec(`create table receiver(singleton integer primary key, pid integer not null, proc_start text not null);
      create table runtime(singleton integer primary key, status text not null, mode text not null,
        approvals integer not null default 0, questions integer not null default 0, approval_at integer, question_at integer);`);
    f.writer.prepare('insert into receiver values (1, ?, ?)').run(process.pid, procStart);
    f.writer.prepare("insert into runtime values (1, 'busy', 'prompting', 2, 1, ?, ?)").run(now - 2 * minute, now - minute);
    const load = () => loadOpenCodeDashboard({ dataDir: f.dataDir, stateDir: f.stateDir, nowMs: now });
    let thread = (await load()).threads.find((item) => item.id === sessionIds[0]);
    assert.equal(thread.awaitingPermission, true);
    assert.equal(thread[OPENCODE_APPROVAL_WAIT], true);
    assert.equal(thread.pendingToolAtMs, now - 2 * minute);
    assert.equal(thread.awaitingUserInput, true);
    assert.equal(thread.userQuestionBlocking, true);
    assert.equal(thread.latestBlockingQuestionAtMs, now - minute);
    assert.equal(thread.latestUserQuestionAtMs, now - minute);
    const other = (await load()).threads.find((item) => item.id === sessionIds[1]);
    assert.equal(Object.hasOwn(other, 'awaitingPermission'), false);
    assert.equal(OPENCODE_APPROVAL_WAIT in other, false);
    const board = buildSwitchboardDashboard((await load()).threads, [], now);
    const row = board.threads.find((item) => item.id === sessionIds[0]);
    assert.equal(row.state, 'waiting');
    assert.equal(row.questionPending, true);
    // An approval alone asks for an action.
    f.writer.exec('update runtime set questions = 0, question_at = null');
    thread = (await load()).threads.find((item) => item.id === sessionIds[0]);
    assert.equal(thread.awaitingUserInput, undefined);
    assert.equal(thread[OPENCODE_APPROVAL_WAIT], true);
    assert.equal(buildSwitchboardDashboard([thread], [], now).threads[0].actionRequired, true);
    // A question alone gives no approval mark (the engine closes the phone approval).
    f.writer.exec('update runtime set approvals = 0, approval_at = null, questions = 1, question_at = 1');
    assert.equal(OPENCODE_APPROVAL_WAIT in (await load()).threads.find((item) => item.id === sessionIds[0]), false);
    f.writer.exec('update runtime set approvals = 2, approval_at = 1, questions = 0, question_at = null');
    // A receiver process that ended, or a PID with another start time, gives no wait.
    if (!windows) {
      f.writer.prepare('update receiver set proc_start = ?').run(`${procStart}0`);
      thread = (await load()).threads.find((item) => item.id === sessionIds[0]);
      assert.equal(Object.hasOwn(thread, 'awaitingPermission'), false);
    }
  } finally { f.writer.close(); }
});
