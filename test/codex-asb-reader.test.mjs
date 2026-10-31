import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexNativeReadStatus, invalidateCodexData, loadCodexDashboard, parseRolloutSignals, parseSessionIndex, querySqliteJson, readThreads } from '../src/codex-data.mjs';
import { normalizeThread } from '../src/insights.mjs';
import { buildSwitchboardDashboard, isSwitchboardRoot, loadSwitchboardDashboard } from '../src/switchboard.mjs';

test('ASB keeps raw Codex titles and desktop name priority without first_user_message', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-codex-titles-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'state.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`create table threads (
    id text primary key, rollout_path text, created_at integer, updated_at integer,
    created_at_ms integer, updated_at_ms integer, source text, model_provider text, cwd text,
    title text, sandbox_policy text, approval_mode text, tokens_used integer, archived integer,
    git_sha text, git_branch text, git_origin_url text, cli_version text,
    agent_nickname text, agent_role text, memory_mode text, model text, reasoning_effort text, name text
  )`);
  const nowMs = Date.parse('2026-08-01T12:00:00.000Z');
  const cases = [
    { title: 'https://example.test/report?view=1\n\nReview the report.' },
    { title: '/tmp/synthetic-report.pdf' },
    { title: 'synthetic-image.png' },
    { title: 'Stored title with a later image request' },
    { title: '' },
    { title: 'Stored title', sidebar: 'Sidebar title', name: '  Desktop name\nwith spacing  ' },
    { title: 'Stored fallback', sidebar: '  https://example.test/sidebar\nRaw name  ' },
  ];
  const insert = database.prepare(`insert into threads
    (id, rollout_path, title, name, source, created_at_ms, updated_at_ms, archived)
    values (?, ?, ?, ?, 'vscode', ?, ?, 0)`);
  const sessionIndex = [];
  try {
    for (const [index, item] of cases.entries()) {
      item.id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const rolloutPath = path.join(directory, `rollout-${item.id}.jsonl`);
      insert.run(item.id, rolloutPath, item.title, item.name || '', nowMs, nowMs);
      if (item.sidebar) sessionIndex.push(JSON.stringify({ id: item.id, thread_name: item.sidebar }));
      await fs.writeFile(rolloutPath, [
        { timestamp: new Date(nowMs - 2_000).toISOString(), type: 'event_msg',
          payload: { type: 'user_message', message: 'First synthetic user request.' } },
        { timestamp: new Date(nowMs - 1_000).toISOString(), type: 'event_msg',
          payload: { type: 'user_message', message: 'Later synthetic image request.\n<image name="example" path="/tmp/synthetic-image.png"></image>' } },
      ].map(JSON.stringify).join('\n'));
    }
  } finally {
    database.close();
  }
  const sessionIndexPath = path.join(directory, 'session_index.jsonl');
  await fs.writeFile(sessionIndexPath, sessionIndex.join('\n'));
  const rows = await readThreads({ databasePath });
  assert.equal(rows.length, cases.length);
  for (const column of ['first_user_message', 'sandbox_policy', 'approval_mode', 'cli_version', 'memory_mode']) {
    assert.equal(rows.some((row) => Object.hasOwn(row, column)), false);
  }
  const dashboard = await loadCodexDashboard({ databasePath, sessionIndexPath, globalStatePath: path.join(directory, 'missing-global-state.json'), nowMs });
  const board = buildSwitchboardDashboard(dashboard.threads, [], nowMs);
  for (const item of cases) {
    const thread = dashboard.threads.find((thread) => thread.id === item.id);
    const expected = item.name || item.sidebar || item.title;
    assert.equal(thread.title, expected);
    assert.equal(board.threads.find((thread) => thread.id === item.id).title, expected || 'Untitled session');
  }
});

test('the thread query reads at most 301 characters of a title, and the row cut stays the same', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-codex-long-title-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('create table threads (id text primary key, title text, updated_at_ms integer, archived integer)');
  // A character outside the BMP is one character for SQLite and for the row cut, not two.
  const titles = ['a'.repeat(299), '😀'.repeat(300), 'a'.repeat(301), '😀'.repeat(5000), 'b'.repeat(2_000_000)];
  const insert = database.prepare('insert into threads values (?, ?, ?, 0)');
  titles.forEach((title, index) => insert.run(`00000000-0000-4000-8000-00000000000${index + 1}`, title, 1_000 + index));
  database.close();
  const rows = await readThreads({ databasePath });
  assert.deepEqual(rows.map((row) => [...row.title].length).sort((a, b) => a - b), [299, 300, 301, 301, 301]);
  // A row from the cut text is the same as a row from the whole text.
  const board = buildSwitchboardDashboard(rows.map((row) => normalizeThread(row)), [], 0);
  const expected = (title) => [...title].length > 300 ? `${[...title].slice(0, 299).join('')}…` : title;
  assert.deepEqual(titles.map((title, index) => board.threads.find((row) => row.id.endsWith(`${index + 1}`)).title), titles.map(expected));
});

test('without node:sqlite the sqlite3 command skips the init file, so .sqliterc cannot break the JSON', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: ' [{"id":"one"}]\n' };
  };
  assert.deepEqual(await querySqliteJson('state.sqlite', 'select 1;', { native: null, run }), [{ id: 'one' }]);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]),
    [['sqlite3', ['-init', os.devNull, '-readonly', '-json', 'state.sqlite', 'select 1;']]]);
  assert.equal(calls[0].options.maxBuffer, 20 * 1024 * 1024);
});

test('the Codex source warns only when no unarchived root can read its session log', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-codex-logs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const nowMs = Date.parse('2026-08-01T12:00:00.000Z');
  const log = (name) => path.join(directory, `rollout-${name}.jsonl`);
  // A log with a turn, a log with no event that ASB reads, and an empty log. `gone` has no file.
  await fs.writeFile(log('turn'), `${JSON.stringify({ timestamp: new Date(nowMs).toISOString(), payload: { type: 'task_complete' } })}\n`);
  await fs.writeFile(log('quiet'), `${JSON.stringify({ payload: { type: 'token_count' } })}\n`);
  await fs.writeFile(log('empty'), '');
  const child = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: '00000000-0000-4000-8000-000000000001' } } });
  let store = 0;
  // Each case has its own database, so no kept query result is reused. A row is [log, archived, source].
  const load = async (rows) => {
    const databasePath = path.join(directory, `state_${store += 1}.sqlite`);
    const database = new DatabaseSync(databasePath);
    database.exec('create table threads (id text primary key, rollout_path text, source text, thread_source text, updated_at_ms integer, archived integer)');
    rows.forEach(([name, archived, source = 'vscode'], index) => database.prepare('insert into threads values (?, ?, ?, ?, ?, ?)')
      .run(`00000000-0000-4000-8000-00000000000${index + 1}`, log(name), source, source === child ? 'subagent' : 'user', nowMs, archived ? 1 : 0));
    database.close();
    const options = { databasePath, sessionIndexPath: path.join(directory, 'absent-index'),
      globalStatePath: path.join(directory, 'absent-state'), nowMs };
    const dashboard = await loadCodexDashboard({ ...options, rolloutThreadFilter: isSwitchboardRoot });
    const board = await loadSwitchboardDashboard({ nowMs, codexOptions: options,
      loadClaude: async () => ({ provider: { installed: false, status: 'missing' }, threads: [] }) });
    // The dashboard of the reader names a provider only for a warning.
    assert.equal(dashboard.provider?.status ?? 'ready', board.providers[0].status);
    return board.providers[0];
  };
  const message = 'ASB cannot read the Codex session logs, so Codex cards show Unknown.';
  const ready = { id: 'codex', label: 'Codex', status: 'ready', provider: 'codex', color: undefined, message: '' };
  const warning = { id: 'codex', label: 'Codex', status: 'warning', provider: 'codex', color: undefined, message };
  assert.deepEqual(await load([['gone'], ['gone']]), warning);
  assert.deepEqual(await load([['gone']]), warning);
  // A readable log, with or without an event, shows that the reader works. A broken log then shows only its own card.
  assert.deepEqual(await load([['gone'], ['turn']]), ready);
  assert.deepEqual(await load([['gone'], ['quiet']]), ready);
  assert.deepEqual(await load([['gone'], ['empty']]), ready);
  assert.deepEqual(await load([['turn'], ['quiet']]), ready);
  // No unarchived root: no rows, an archived row, or a child with no log.
  assert.deepEqual(await load([]), ready);
  assert.deepEqual(await load([['gone', true]]), ready);
  assert.deepEqual(await load([['turn'], ['gone', false, child]]), ready);
  assert.deepEqual(await load([['gone'], ['turn', false, child]]), warning);
  // The cards of an unreadable log stay, and show Unknown.
  const databasePath = path.join(directory, `state_${store}.sqlite`);
  const { threads } = await loadCodexDashboard({ databasePath, nowMs, rolloutThreadFilter: isSwitchboardRoot,
    sessionIndexPath: path.join(directory, 'absent-index'), globalStatePath: path.join(directory, 'absent-state') });
  const rows = buildSwitchboardDashboard(threads, [], nowMs).threads;
  assert.deepEqual(rows.map((row) => row.state), ['unknown']);
});

test('Codex titles keep the raw session-index name and an empty fallback', () => {
  const title = '  https://example.test/title\nRaw name  ';
  const indexText = JSON.stringify({ id: 'synthetic-thread', thread_name: title });
  assert.equal(parseSessionIndex(indexText).get('synthetic-thread'), title);
  assert.equal(normalizeThread({ title: '' }).title, '');
});

test('raw Codex attachment text resolves questions while scaffold and internal context keep them pending', () => {
  const question = { payload: { type: 'function_call', name: 'request_user_input', call_id: 'synthetic-question',
    arguments: JSON.stringify({ questions: [{ id: 'one' }] }) } };
  const signals = (message) => parseRolloutSignals([
    { payload: { type: 'task_started' } }, question, { payload: { type: 'user_message', message } },
  ].map(JSON.stringify).join('\n'));
  for (const message of ['https://example.test/report', '<image name="example" path="/tmp/synthetic.png"></image>',
    '# Files mentioned by the user:\n## synthetic.pdf: /tmp/synthetic.pdf']) {
    assert.equal(signals(message).awaitingUserInput, false);
    assert.equal(signals(message).agentRunning, true);
  }
  for (const message of ['# Files mentioned by the user:\n## My request for Codex:',
    '<environment_context>Synthetic context.</environment_context>',
    '<codex_internal_context source="goal">Synthetic continuation.</codex_internal_context>']) {
    assert.equal(signals(message).awaitingUserInput, true);
    assert.equal(signals(message).agentRunning, true);
  }
});

test('Codex cached native read status keeps identity, local host, UUID, and exact matching rules', () => {
  const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const identity = digest(['chatgpt', 'synthetic-account', 'synthetic-user']);
  const localHost = `local:${digest(['local', 'local', null])}`;
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const thread = { id, creatorAccountId: 'synthetic-account', creatorUserId: 'synthetic-user' };
  const state = (namespaces, extraIdentities = {}) => ({ 'electron-thread-read-state-v1': {
    version: 1, unreadByIdentity: { [identity]: namespaces, ...extraIdentities },
  } });
  const read = { nativeUnread: false, readStatus: 'read' };
  const unread = { nativeUnread: true, readStatus: 'unread' };
  const unknown = { nativeUnread: null, readStatus: 'unknown' };
  let stateReads = 0;
  const cachedState = {};
  Object.defineProperty(cachedState, 'electron-thread-read-state-v1', { get() {
    stateReads += 1;
    return { version: 1, unreadByIdentity: { [identity]: { [localHost]: [id] } } };
  } });
  assert.deepEqual(codexNativeReadStatus(thread, cachedState), unread);
  assert.deepEqual(codexNativeReadStatus({ ...thread, id: id.toUpperCase() }, cachedState), read);
  assert.deepEqual(codexNativeReadStatus(thread, cachedState), unread);
  assert.equal(stateReads, 1);
  assert.deepEqual(codexNativeReadStatus(thread, state({ [localHost]: [], 'durable:remote': [id] })), read);
  for (const invalid of [
    state({ 'durable:remote': [id] }), state({ 'local:other': [id] }),
    state({ [localHost]: [42] }), state({ [localHost]: ['not-a-uuid'] }),
    state({ [localHost]: [id] }, { 'other-identity': { [localHost]: [id] } }), {}, null,
    { 'electron-thread-read-state-v1': { version: 2, unreadByIdentity: { [identity]: { [localHost]: [id] } } } },
  ]) {
    assert.deepEqual(codexNativeReadStatus(thread, invalid), unknown);
    assert.deepEqual(codexNativeReadStatus(thread, invalid), unknown);
  }
  assert.deepEqual(codexNativeReadStatus({ ...thread, creatorUserId: 'other-user' }, cachedState), unknown);
  assert.deepEqual(codexNativeReadStatus({ id }, cachedState), unknown);
});

test('the thread query runs again only when the database signature changes or is too recent', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-codex-kept-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'state_5.sqlite');
  const setup = new DatabaseSync(databasePath);
  setup.exec(`create table threads (id text primary key, title text, updated_at_ms integer, archived integer);
    insert into threads values ('00000000-0000-4000-8000-000000000001', 'One', 1, 0);`);
  setup.close();
  // Same length titles keep the file size, and utimes puts back the same time: only the query can see the change.
  const retitle = async (title, mtimeSeconds) => {
    const database = new DatabaseSync(databasePath);
    database.prepare('update threads set title = ?').run(title);
    database.close();
    await fs.utimes(databasePath, mtimeSeconds, mtimeSeconds);
  };
  const title = async () => (await readThreads({ databasePath }))[0].title;
  const old = Math.floor(Date.now() / 1000) - 60;
  await fs.utimes(databasePath, old, old);
  const first = await readThreads({ databasePath });
  assert.equal(first[0].title, 'One');
  await retitle('Two', old);
  const second = await readThreads({ databasePath });
  assert.equal(second[0].title, 'One');
  // Each caller gets its own row objects.
  assert.notEqual(second[0], first[0]);
  second[0].title = 'Changed by a caller';
  assert.equal(await title(), 'One');
  // A changed time runs the query again.
  await fs.utimes(databasePath, old + 1, old + 1);
  assert.equal(await title(), 'Two');
  // A source event for the database or its WAL file drops the kept result.
  await retitle('Six', old + 1);
  assert.equal(await title(), 'Two');
  invalidateCodexData({ filePath: `${databasePath}-wal` });
  assert.equal(await title(), 'Six');
  // A file changed less than 1 s before the stat is not a stable signature. A time ahead of the clock counts
  // the same, and a slow test machine cannot make it older than 1 s.
  const recent = Date.now() / 1000 + 30;
  await retitle('Ten', recent);
  assert.equal(await title(), 'Ten');
  await retitle('Two', recent);
  assert.equal(await title(), 'Two');
});
