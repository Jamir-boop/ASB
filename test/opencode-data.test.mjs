import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { querySqliteJson } from '../src/codex-data.mjs';
import { invalidateOpenCodeData, loadOpenCodeDashboard } from '../src/opencode-data.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

const now = Date.parse('2026-10-19T12:00:00Z');
const minute = 60 * 1000;
const hour = 60 * minute;
const SESSION_COLUMNS = ['id', 'project_id', 'parent_id', 'slug', 'directory', 'title', 'time_created', 'time_updated',
  'time_archived', 'time_suspended', 'time_idle', 'time_viewed', 'idle_outcome'];
const SECRET = 'fake-token-do-not-read';
const PROMPT = 'private prompt text';

function createDatabase(databasePath, { sessionColumns = SESSION_COLUMNS, session = true, wal = false } = {}) {
  const database = new DatabaseSync(databasePath);
  if (wal) database.exec('pragma journal_mode = wal');
  if (session) database.exec(`create table session_v2 (${sessionColumns.map((name) => `${name} ${name.startsWith('time_') ? 'integer' : 'text'}`).join(', ')})`);
  database.exec(`create table session_message (id text, session_id text, type text, seq integer, time_created integer,
    time_updated integer, data text)`);
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
  for (const text of sql) assert.doesNotMatch(text, /\b(?:account|control_account|credential|kv|data)\b/i);
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
