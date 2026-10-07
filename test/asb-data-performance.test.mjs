import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  getCodexCacheStats, loadCodexDashboard, parseRolloutSignals, readCodexPinnedThreadIds, readRolloutSignals,
} from '../src/codex-data.mjs';
import {
  getClaudeCacheStats, invalidateClaudeData, loadClaudeDesktopCodeThreads, parseClaudeJsonlSignals,
} from '../src/claude-data.mjs';
import { buildDashboard, normalizeDashboardThreads } from '../src/insights.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';

const nowMs = Date.parse('2026-10-07T12:00:00Z');
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const codexEvent = (payload, time = nowMs) => ({ type: 'event_msg', timestamp: new Date(time).toISOString(), payload });
const question = { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'ask', arguments: JSON.stringify({ questions: [{ id: 'one' }] }) };

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-data-performance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('ASB parses lifecycle and questions without token, quota, or artifact passes', async (t) => {
  const directory = await temporaryDirectory(t);
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const prefix = jsonl([
    codexEvent({ type: 'user_message', message: 'Start this task.' }, nowMs - 1000),
    codexEvent({ type: 'task_started' }, nowMs - 900),
    codexEvent(question, nowMs - 800),
    codexEvent({ type: 'function_call_output', call_id: 'ask', output: '{"accepted":true}' }, nowMs - 700),
    codexEvent({ type: 'tool_output', text: 'x'.repeat(4096) }, nowMs - 600),
  ]);
  await fs.writeFile(rolloutPath, prefix + jsonl([codexEvent({ type: 'agent_message', message: 'Still working.' })]));
  const options = { asbMode: true, initialBytes: 256, maxBytes: 256, todayStartMs: nowMs - 10_000 };
  const first = await readRolloutSignals(rolloutPath, options);
  assert.equal(first.agentRunning, true);
  assert.equal(first.agentStartedAtMs, nowMs - 900);
  assert.equal(first.awaitingUserInput, true);
  assert.equal(first.userQuestionBlocking, false);
  const before = getCodexCacheStats().rolloutSignals;
  await fs.appendFile(rolloutPath, jsonl([codexEvent({ type: 'user_message', message: 'Continue with this change.' }, nowMs + 100)]));
  const resumed = await readRolloutSignals(rolloutPath, options);
  assert.equal(resumed.awaitingUserInput, false);
  assert.equal(resumed.agentStartedAtMs, first.agentStartedAtMs);
  assert.ok(getCodexCacheStats().rolloutSignals.lifecycleBytesRead - before.lifecycleBytesRead < 512);
  await fs.appendFile(rolloutPath, jsonl([codexEvent({ type: 'turn_aborted' }, nowMs + 200)]));
  const aborted = await readRolloutSignals(rolloutPath, options);
  assert.equal(aborted.agentRunning, false);
  assert.equal(aborted.latestLifecycleKind, 'turn_aborted');

  const records = jsonl([
    codexEvent({ type: 'token_count', info: { total_token_usage: { total_tokens: 900 }, last_token_usage: { total_tokens: 90 } }, rate_limits: { primary: { used_percent: 5 } } }),
    codexEvent({ type: 'agent_message', phase: 'final_answer', message: 'Saved /tmp/result.html' }),
  ]);
  const full = parseRolloutSignals(records, { todayStartMs: nowMs - 1 });
  const scoped = parseRolloutSignals(records, { asbMode: true, todayStartMs: nowMs - 1 });
  assert.equal(full.totalTokenUsage.total_tokens, 900);
  assert.ok(full.artifacts.total > 0);
  assert.equal(scoped.totalTokenUsage, null);
  assert.equal(scoped.rateLimits, null);
  assert.equal(scoped.todayTokenUsage, 0);
  assert.equal(scoped.artifacts.total, 0);
  assert.equal(scoped.latestAgentFinalAtMs, full.latestAgentFinalAtMs);
});

test('ASB retains more than 256 Codex signals and lifecycle checkpoints', async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = Array.from({ length: 300 }, (_, index) => path.join(directory, `${index}.jsonl`));
  const records = jsonl([
    codexEvent({ type: 'task_started' }, nowMs - 1000), codexEvent(question, nowMs - 900),
    codexEvent({ type: 'tool_output', text: 'x'.repeat(2048) }),
    codexEvent({ type: 'agent_message', message: 'Working.' }),
  ]);
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, records)));
  const options = { asbMode: true, initialBytes: 128, maxBytes: 128 };
  for (const filePath of paths) await readRolloutSignals(filePath, options);
  const before = getCodexCacheStats().rolloutSignals;
  for (const filePath of paths) assert.equal((await readRolloutSignals(filePath, options)).awaitingUserInput, true);
  const after = getCodexCacheStats().rolloutSignals;
  assert.equal(after.hits - before.hits, paths.length);
  assert.equal(after.bytesRead, before.bytesRead);
  assert.equal(after.lifecycleBytesRead, before.lifecycleBytesRead);
  assert.ok(after.entries <= after.limit && after.limit <= 5000);
});

test('ASB keeps incomplete JSONL and partial async answers across lifecycle append scans', async (t) => {
  const directory = await temporaryDirectory(t);
  const rolloutPath = path.join(directory, 'partial.jsonl');
  await fs.writeFile(rolloutPath, jsonl([
    codexEvent({ type: 'task_started' }, nowMs - 1000),
    codexEvent({ type: 'tool_output', text: 'x'.repeat(2048) }),
  ]));
  const ask = jsonl([codexEvent({ ...question, arguments: JSON.stringify({ questions: [{ id: 'one' }, { id: 'two' }] }) })]);
  const half = Math.floor(ask.length / 2);
  const options = { asbMode: true, initialBytes: 512, maxBytes: 512 };
  await fs.appendFile(rolloutPath, ask.slice(0, half));
  assert.equal((await readRolloutSignals(rolloutPath, options)).awaitingUserInput, false);
  await fs.appendFile(rolloutPath, ask.slice(half));
  assert.equal((await readRolloutSignals(rolloutPath, options)).awaitingUserInput, true);
  const reply = (index) => codexEvent({ type: 'user_message', message: `<send_user_message_question_reply>${JSON.stringify([
    { questionItemId: JSON.stringify(['request_user_input_async', 'ask', index]), answer: 'Yes' },
  ])}</send_user_message_question_reply>` });
  await fs.appendFile(rolloutPath, jsonl([reply(0)]));
  assert.equal((await readRolloutSignals(rolloutPath, options)).awaitingUserInput, true);
  await fs.appendFile(rolloutPath, jsonl([reply(1)]));
  const finished = await readRolloutSignals(rolloutPath, options);
  assert.equal(finished.awaitingUserInput, false);
  assert.equal(finished.agentStartedAtMs, nowMs - 1000);
});

test('ASB does not grow the tail to count today tokens when lifecycle and question history are complete', async (t) => {
  const directory = await temporaryDirectory(t);
  const rolloutPath = path.join(directory, 'today.jsonl');
  await fs.writeFile(rolloutPath, jsonl([
    codexEvent({ type: 'token_count', info: { last_token_usage: { total_tokens: 123 } } }, nowMs - 10_000),
    codexEvent({ type: 'tool_output', text: 'x'.repeat(4096) }, nowMs - 9000),
    codexEvent({ type: 'user_message', message: 'A new request.' }, nowMs - 1000),
    codexEvent({ type: 'task_started' }, nowMs - 900),
  ]));
  const before = getCodexCacheStats().rolloutSignals;
  const signals = await readRolloutSignals(rolloutPath, { asbMode: true, initialBytes: 512, maxBytes: 8192, todayStartMs: nowMs - 20_000 });
  const after = getCodexCacheStats().rolloutSignals;
  assert.equal(after.bytesRead - before.bytesRead, 512);
  assert.equal(after.lifecycleBytesRead, before.lifecycleBytesRead);
  assert.equal(signals.agentStartedAtMs, nowMs - 900);
  assert.equal(signals.todayTokenUsage, 0);
});

test('Codex metadata fingerprints detect replacement and database WAL writes', async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, 'state.sqlite');
  const database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  database.exec(`pragma journal_mode=WAL;
    create table threads(id text primary key, rollout_path text default '', created_at integer, updated_at integer,
      source text default 'vscode', model_provider text, cwd text, title text, sandbox_policy text, approval_mode text,
      tokens_used integer, archived integer, git_sha text, git_branch text, git_origin_url text, cli_version text,
      first_user_message text, agent_nickname text, agent_role text, memory_mode text, model text, reasoning_effort text,
      created_at_ms integer, updated_at_ms integer);
    insert into threads(id,title,created_at_ms,updated_at_ms) values('first','Old title',${nowMs},${nowMs});`);
  const sessionIndexPath = path.join(directory, 'session_index.jsonl');
  const globalStatePath = path.join(directory, 'global.json');
  await fs.writeFile(sessionIndexPath, jsonl([{ id: 'first', thread_name: 'Sidebar title' }]));
  await fs.writeFile(globalStatePath, JSON.stringify({ 'pinned-thread-ids': ['first'] }));
  const options = { databasePath, sessionIndexPath, globalStatePath, asbMode: true, nowMs };
  const first = await loadCodexDashboard(options);
  assert.equal(first.threads[0].title, 'Sidebar title');
  assert.equal(first.threads[0].pinned, true);
  assert.equal(first.summary, undefined);
  const before = getCodexCacheStats().metadata;
  await loadCodexDashboard(options);
  const warm = getCodexCacheStats().metadata;
  assert.equal(warm.bytesRead, before.bytesRead);
  assert.equal(warm.hits - before.hits, 2);
  const oldStat = await fs.stat(globalStatePath);
  const replacement = path.join(directory, 'replacement.json');
  await fs.writeFile(replacement, JSON.stringify({ 'pinned-thread-ids': ['other'] }));
  await fs.utimes(replacement, oldStat.atime, oldStat.mtime);
  await fs.rename(replacement, globalStatePath);
  const oldIndexStat = await fs.stat(sessionIndexPath);
  await fs.writeFile(sessionIndexPath, jsonl([{ id: 'first', thread_name: 'Renamed title' }]));
  // File systems can return the same timestamp for consecutive writes. Change it explicitly.
  await fs.utimes(sessionIndexPath, oldIndexStat.atime, (oldIndexStat.mtimeMs + 1000) / 1000);
  const changedIndexStat = await fs.stat(sessionIndexPath);
  assert.equal(changedIndexStat.size, oldIndexStat.size);
  assert.notEqual(changedIndexStat.mtimeMs, oldIndexStat.mtimeMs);
  database.exec(`insert into threads(id,title,created_at_ms,updated_at_ms) values('second','New from WAL',${nowMs},${nowMs + 1});`);
  const changed = await loadCodexDashboard(options);
  assert.equal(changed.threads.length, 2);
  assert.equal(changed.threads.find((thread) => thread.id === 'first').title, 'Renamed title');
  assert.equal(changed.threads.find((thread) => thread.id === 'first').pinned, false);
});

async function claudeFixture(directory, index) {
  const appDir = path.join(directory, 'app');
  const projectsDir = path.join(directory, 'projects');
  const cliSessionId = `session-${index}`;
  const metadataPath = path.join(appDir, 'claude-code-sessions', 'account', `local_${index}.json`);
  const transcriptPath = path.join(projectsDir, `project-${index}`, `${cliSessionId}.jsonl`);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify({ sessionId: `local_${index}`, cliSessionId, title: `Task ${index}`, cwd: '/tmp/work' }));
  await fs.writeFile(transcriptPath, jsonl([
    { type: 'user', timestamp: new Date(nowMs - 1000).toISOString(), message: { content: 'Do this work.' } },
    { type: 'assistant', timestamp: new Date(nowMs).toISOString(), message: { id: 'message', usage: { input_tokens: 123 }, content: [{ type: 'text', text: 'In progress.' }] } },
  ]));
  return { appDir, projectsDir, metadataPath, transcriptPath };
}

test('backend source events invalidate Codex and Claude metadata with identical file stats', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = await claudeFixture(directory, 1);
  const globalStatePath = path.join(directory, '.codex-global-state.json');
  await fs.writeFile(globalStatePath, JSON.stringify({ 'pinned-thread-ids': ['first'] }));
  const originalStat = fs.stat;
  const frozenStats = new Map(await Promise.all([globalStatePath, fixture.metadataPath].map(async (filePath) => [filePath, await fs.stat(filePath)])));
  t.mock.method(fs, 'stat', async (filePath, ...args) => frozenStats.get(filePath) || originalStat(filePath, ...args));
  const options = { appDir: fixture.appDir, projectsDir: fixture.projectsDir, nowMs, asbMode: true, usageCache: null };
  const callbacks = new Map();
  const server = createSwitchboardServer({
    pendingStatePath: false,
    now: () => nowMs,
    dashboardWatchPaths: [
      { path: directory, source: 'codex' },
      { path: path.dirname(fixture.metadataPath), source: 'claude' },
    ],
    dashboardSetTimeout: () => ({ unref() {} }),
    dashboardClearTimeout: () => {},
    watchDashboardPath(target, _options, callback) {
      callbacks.set(target, callback);
      const watcher = new EventEmitter();
      watcher.close = () => {};
      return watcher;
    },
    loadDashboard: async () => ({ generatedAtMs: nowMs, threads: [
      { id: 'codex', provider: 'codex', state: 'idle', title: (await readCodexPinnedThreadIds(globalStatePath)).join(',') },
      ...(await loadClaudeDesktopCodeThreads(options)).threads,
    ] }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const scan = () => fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`).then((response) => response.json());
  const first = await scan();
  assert.equal(first.threads[0].title, 'first');
  assert.equal(first.threads[1].title, 'Task 1');
  const before = { codex: getCodexCacheStats().metadata, claude: getClaudeCacheStats().metadata };
  await readCodexPinnedThreadIds(globalStatePath);
  await loadClaudeDesktopCodeThreads(options);
  assert.equal(getCodexCacheStats().metadata.bytesRead, before.codex.bytesRead);
  assert.equal(getClaudeCacheStats().metadata.bytesRead, before.claude.bytesRead);
  await fs.writeFile(globalStatePath, JSON.stringify({ 'pinned-thread-ids': ['other'] }));
  const metadata = await fs.readFile(fixture.metadataPath, 'utf8');
  await fs.writeFile(fixture.metadataPath, metadata.replace('Task 1', 'Task 2'));
  assert.deepEqual(await readCodexPinnedThreadIds(globalStatePath), ['first']);
  assert.equal((await loadClaudeDesktopCodeThreads(options)).threads[0].title, 'Task 1');
  callbacks.get(directory)('change', path.basename(globalStatePath));
  callbacks.get(path.dirname(fixture.metadataPath))('change', path.basename(fixture.metadataPath));
  const changed = await scan();
  assert.equal(changed.threads[0].title, 'other');
  assert.equal(changed.threads[1].title, 'Task 2');
  assert.equal(getCodexCacheStats().metadata.misses - before.codex.misses, 1);
  assert.equal(getClaudeCacheStats().metadata.misses - before.claude.misses, 1);
});

test('Claude ASB caches unchanged metadata and indices, detects new and renamed sessions', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = await claudeFixture(directory, 1);
  const options = { appDir: fixture.appDir, projectsDir: fixture.projectsDir, nowMs, asbMode: true, usageCache: null, strictMetadataRead: true };
  const first = await loadClaudeDesktopCodeThreads(options);
  assert.equal(first.threads[0].latestUserMessageAtMs, nowMs - 1000);
  assert.equal(first.threads[0].tokensUsed, 0);
  const before = getClaudeCacheStats();
  const warm = await loadClaudeDesktopCodeThreads({ ...options, nowMs: nowMs + 1000 });
  const after = getClaudeCacheStats();
  assert.equal(after.metadata.bytesRead, before.metadata.bytesRead);
  assert.equal(after.jsonlSignals.bytesRead, before.jsonlSignals.bytesRead);
  assert.equal(after.fileIndex.walks, before.fileIndex.walks);
  assert.equal(after.projectIndex.hits - before.projectIndex.hits, 1);
  assert.equal(warm.threads[0].latestUserMessageAtMs, first.threads[0].latestUserMessageAtMs);
  await fs.appendFile(fixture.transcriptPath, jsonl([{ type: 'assistant', timestamp: new Date(nowMs + 100).toISOString(), message: { stop_reason: 'end_turn', content: 'Done.' } }]));
  invalidateClaudeData({ filePath: fixture.transcriptPath });
  const complete = await loadClaudeDesktopCodeThreads(options);
  assert.equal(complete.threads[0].latestAgentFinalAtMs, nowMs + 100);
  assert.equal(getClaudeCacheStats().fileIndex.walks, before.fileIndex.walks);
  const renamed = fixture.metadataPath.replace('local_1.json', 'local_renamed.json');
  await fs.rename(fixture.metadataPath, renamed);
  await fs.writeFile(renamed, JSON.stringify({ sessionId: 'local_1', cliSessionId: 'session-1', title: 'New title' }));
  await claudeFixture(directory, 2);
  const added = await loadClaudeDesktopCodeThreads(options);
  assert.equal(added.threads.length, 2);
  assert.equal(added.threads.find((thread) => thread.externalId === 'local_1').title, 'New title');
  await fs.writeFile(renamed, '{invalid');
  const broken = await loadClaudeDesktopCodeThreads(options);
  assert.equal(broken.provider.status, 'warning');
  assert.equal(broken.provider.metadataReadErrors, 1);
  assert.equal(broken.threads.length, 1);
});

test('Claude ASB bounds parse concurrency and caches more than 512 sessions', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixtures = [];
  for (let index = 0; index < 520; index++) fixtures.push(await claudeFixture(directory, index));
  const { appDir, projectsDir } = fixtures[0];
  let active = 0, maximum = 0;
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(projectsDir)) {
      active += 1;
      maximum = Math.max(maximum, active);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => { try { return await originalClose(); } finally { active -= 1; } };
    }
    return handle;
  };
  try {
    const options = { appDir, projectsDir, maxCount: 5000, asbMode: true, usageCache: null, nowMs };
    assert.equal((await loadClaudeDesktopCodeThreads(options)).threads.length, fixtures.length);
    assert.ok(maximum <= 6);
    assert.equal(active, 0);
    const before = getClaudeCacheStats();
    await loadClaudeDesktopCodeThreads(options);
    const after = getClaudeCacheStats();
    assert.equal(after.jsonlSignals.hits - before.jsonlSignals.hits, fixtures.length);
    assert.equal(after.jsonlSignals.bytesRead, before.jsonlSignals.bytesRead);
    assert.equal(after.metadata.bytesRead, before.metadata.bytesRead);
    assert.ok(after.jsonlSignals.entries <= after.jsonlSignals.limit && after.jsonlSignals.limit <= 5000);
  } finally { fs.open = originalOpen; }
});

test('narrow normalization matches dashboard relationships and default Claude usage stays enabled', () => {
  const threads = [
    { id: 'host', updatedAtMs: nowMs, tokensUsed: 0 },
    { id: 'child', parentThreadId: 'host', isSubagent: true, updatedAtMs: nowMs + 1, tokensUsed: 0 },
  ];
  const narrow = normalizeDashboardThreads(threads, nowMs);
  const full = buildDashboard(threads, nowMs).threads;
  assert.deepEqual(narrow.map((thread) => [thread.id, thread.hostThreadId, thread.subagentCount, thread.groupUpdatedAtMs]),
    full.map((thread) => [thread.id, thread.hostThreadId, thread.subagentCount, thread.groupUpdatedAtMs]));
  const records = jsonl([{ type: 'assistant', timestamp: new Date(nowMs).toISOString(), message: { usage: { input_tokens: 123 }, stop_reason: 'end_turn', content: 'Done.' } }]);
  assert.equal(parseClaudeJsonlSignals(records).tokensUsed, 123);
  assert.equal(parseClaudeJsonlSignals(records, { asbMode: true }).tokensUsed, 0);
  assert.equal(parseClaudeJsonlSignals(records, { asbMode: true }).latestAgentFinalAtMs, nowMs);
});
