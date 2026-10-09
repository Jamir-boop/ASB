import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexNativeReadStatus, loadCodexDashboard, parseRolloutSignals, parseSessionIndex, readThreads } from '../src/codex-data.mjs';
import { normalizeThread } from '../src/insights.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

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
    assert.equal(thread.firstUserMessage, 'First synthetic user request.');
    assert.equal(thread.latestUserMessage, 'Later synthetic image request. <image name="example" path="/tmp/synthetic-image.png"></image>');
    assert.equal(board.threads.find((thread) => thread.id === item.id).title, expected || 'Untitled session');
  }
});

test('Codex titles keep the raw session-index name and an empty fallback', () => {
  const title = '  https://example.test/title\nRaw name  ';
  const indexText = JSON.stringify({ id: 'synthetic-thread', thread_name: title });
  assert.equal(parseSessionIndex(indexText).get('synthetic-thread'), title);
  assert.equal(normalizeThread({ title: '' }, 0).title, '');
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
