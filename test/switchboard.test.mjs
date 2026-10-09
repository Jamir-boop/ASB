import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { defaultClaudeAppDir, normalizeClaudeDesktopCodeSession, loadClaudeDesktopCodeThreads, parseClaudeJsonlSignals } from '../src/claude-data.mjs';
import { loadCodexDashboard, readThreads, discoverCodexStateDatabase, parseRolloutSignals, readRolloutSignals, getCodexCacheStats, codexNativeReadStatus } from '../src/codex-data.mjs';
import { buildSwitchboardDashboard, createSwitchboardServer, loadSwitchboardDashboard, openSwitchboardThread, switchboardStatus, PendingTracker } from '../src/switchboard.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';
const localId = `local_${id}`;
const now = Date.parse('2026-10-07T14:00:00Z');
const jsonl = (events) => events.map(JSON.stringify).join('\n');
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function codexDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`create table threads (
    id text primary key, rollout_path text, created_at integer, updated_at integer,
    created_at_ms integer, updated_at_ms integer, source text, model_provider text,
    cwd text, title text, sandbox_policy text, approval_mode text, tokens_used integer,
    archived integer, git_sha text, git_branch text, git_origin_url text, cli_version text,
    first_user_message text, agent_nickname text, agent_role text, memory_mode text,
    model text, reasoning_effort text, name text, is_pinned integer, thread_source text,
    originator text, agent_path text, creator_account_id text, creator_user_id text
  );`);
  return database;
}

test('Linux Claude uses the XDG directory and opens the original local session', async () => {
  assert.equal(defaultClaudeAppDir('linux', '/home/test', {}), '/home/test/.config/Claude');
  assert.equal(defaultClaudeAppDir('linux', '/home/test', { XDG_CONFIG_HOME: '/config' }), '/config/Claude');
  assert.equal(defaultClaudeAppDir('darwin', '/Users/test', {}), '/Users/test/Library/Application Support/Claude');
  const thread = normalizeClaudeDesktopCodeSession({ sessionId: localId, cliSessionId: id, title: 'One task' }, {}, now);
  assert.equal(thread.appDeepLink, `claude://code/continue?session=${localId}`);
  const calls = [];
  const row = buildSwitchboardDashboard([thread], [], now).threads[0];
  const result = await openSwitchboardThread(row, { platform: 'linux', runCommand: async (...args) => { calls.push(args); return {}; } });
  assert.equal(result.opened, true);
  assert.equal(calls[0][0], 'xdg-open');
  assert.deepEqual(calls[0][1], [`claude://code/continue?session=${localId}`]);
  const legacy = normalizeClaudeDesktopCodeSession({ sessionId: 'local_legacy', cliSessionId: id }, {}, now);
  assert.equal(legacy.appDeepLink, `claude://resume?session=${id}`);
  assert.equal(buildSwitchboardDashboard([legacy], [], now).threads[0].canOpen, false);
});

test('Claude recursively reads local metadata, keeps archives, and deduplicates CLI IDs', async (t) => {
  const dir = await temp(t);
  const sessions = path.join(dir, 'app', 'claude-code-sessions', 'nested');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'local_one.json'), JSON.stringify({ sessionId: localId, cliSessionId: id, title: 'Older', lastActivityAt: now - 1000 }));
  await writeFile(path.join(sessions, 'local_two.json'), JSON.stringify({ sessionId: localId, cliSessionId: id, title: 'Newest', isArchived: true, lastActivityAt: now + 100_000 }));
  for (const filename of ['local_one.json', 'local_two.json']) await utimes(path.join(sessions, filename), now / 1000, now / 1000);
  await writeFile(path.join(sessions, 'ignored.json'), JSON.stringify({ sessionId: 'private', cliSessionId: 'other' }));
  const result = await loadClaudeDesktopCodeThreads({ appDir: path.join(dir, 'app'), projectsDir: path.join(dir, 'projects'), nowMs: now });
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].title, 'Newest');
  assert.equal(result.threads[0].archived, true);
  assert.equal(buildSwitchboardDashboard(result.threads, [], now).threads[0].state, 'unknown');
});

test('states use lifecycle and transcript signals, never archive or timestamp alone', () => {
  const started = parseRolloutSignals(jsonl([{ timestamp: new Date(now - 1000).toISOString(), payload: { type: 'task_started' } }]));
  assert.equal(switchboardStatus({ lifecycleRunning: started.agentRunning, agentActivityAtMs: started.agentActivityAtMs }, now).state, 'working');
  for (const type of ['task_complete', 'turn_aborted']) {
    const ended = parseRolloutSignals(jsonl([{ timestamp: new Date(now).toISOString(), payload: { type } }]));
    assert.equal(switchboardStatus({ lifecycleRunning: ended.agentRunning, latestUserMessageAtMs: now }, now).state, 'idle');
  }
  assert.equal(switchboardStatus({ lifecycleRunning: true, agentActivityAtMs: now - 7 * 3_600_000 }, now).state, 'unknown');
  assert.equal(switchboardStatus({ archived: false, updatedAtMs: now }, now).state, 'unknown');
  assert.equal(switchboardStatus({ awaitingPermission: true }, now).state, 'waiting');
  const signals = parseClaudeJsonlSignals(jsonl([{ type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { content: 'Run the project checks' } }]));
  const thread = normalizeClaudeDesktopCodeSession({ sessionId: localId }, { signals }, now);
  assert.equal(switchboardStatus(thread, now).state, 'working');
  signals.latestAgentFinalAtMs = now;
  assert.equal(switchboardStatus(normalizeClaudeDesktopCodeSession({ sessionId: localId }, { signals }, now), now).state, 'idle');
});

test('the board keeps root app/project data and excludes nested or internal agents', () => {
  const rows = buildSwitchboardDashboard([
    { id, provider: 'codex', title: 'Root', cwd: '/work/ASB', pinned: true },
    { id: 'child', provider: 'codex', isSubagent: true, parentThreadId: id },
    { id: 'nested', provider: 'codex', isSubagent: true, parentThreadId: 'child' },
    { id: 'internal', provider: 'codex', threadSource: 'subagent' },
    { id: 'review', provider: 'codex', threadSource: 'guardian_review' },
  ], [], now).threads;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subagentCount, 2);
  assert.equal(rows[0].projectName, 'ASB');
  assert.equal(rows[0].pinned, undefined);
});

test('Working start time uses the current Codex task or Claude request and stays zero without that signal', () => {
  const codex = parseRolloutSignals(jsonl([{ timestamp: new Date(now - 5_000).toISOString(), payload: { type: 'task_started' } }]));
  const claude = normalizeClaudeDesktopCodeSession({ sessionId: localId }, { signals: parseClaudeJsonlSignals(jsonl([
    { type: 'user', timestamp: new Date(now - 3_000).toISOString(), message: { content: 'Start' } },
  ])) }, now);
  const rows = buildSwitchboardDashboard([
    { id: 'codex', provider: 'codex', ...codex, lifecycleRunning: codex.agentRunning, goalCreatedAtMs: now - 50_000 },
    claude,
    { id: 'idle', provider: 'codex', lifecycleRunning: false, agentStartedAtMs: now - 5_000 },
    { id: 'unknown', provider: 'codex', lifecycleRunning: true, agentActivityAtMs: now - 7 * 3_600_000, agentStartedAtMs: now - 7 * 3_600_000 },
    { id: 'missing', provider: 'codex', lifecycleRunning: true, agentActivityAtMs: now, goalCreatedAtMs: now - 50_000 },
  ], [], now).threads;
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const ordered = ['codex', claude.id, 'idle', 'unknown', 'missing'].map((identity) => byId[identity]);
  assert.deepEqual(ordered.map((row) => row.workingSinceMs), [now - 5_000, now - 3_000, 0, 0, 0]);
  assert.deepEqual(ordered.map((row) => row.state), ['working', 'working', 'idle', 'unknown', 'working']);
  assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', ...codex, lifecycleRunning: true }], [], now + 2_000).threads[0].workingSinceMs,
    byId.codex.workingSinceMs);
});

test('the ASB scan sets its own reader limits over caller options', async () => {
  let codexOptions;
  let claudeOptions;
  const dashboard = await loadSwitchboardDashboard({ nowMs: now,
    codexOptions: { maxRollouts: 1, codexNativeReadEnabled: false },
    claudeOptions: { maxCount: 1, strictMetadataRead: false },
    loadCodex: async (options) => { codexOptions = options; return { threads: [] }; },
    loadClaude: async (options) => { claudeOptions = options; return { threads: [] }; },
  });
  assert.equal(codexOptions.maxRollouts, 5000);
  assert.equal(codexOptions.codexNativeReadEnabled, true);
  assert.equal(claudeOptions.maxCount, 5000);
  assert.equal(claudeOptions.strictMetadataRead, true);
  assert.equal(dashboard.providers.length, 2);
});

test('ASB refreshes Claude transcript stats and discovers newly created transcripts on each scan', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(projectsDir);
  await writeFile(path.join(appDir, 'claude-code-sessions', 'local_one.json'), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  const transcript = path.join(projectsDir, `${id}.jsonl`);
  const scan = (nowMs) => loadSwitchboardDashboard({ nowMs, loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir, projectsDir } });
  assert.equal((await scan(now)).threads[0].state, 'unknown');
  await writeFile(transcript, jsonl([{ type: 'user', timestamp: new Date(now).toISOString(), message: { content: 'Start' } }]) + '\n');
  assert.equal((await scan(now + 999)).threads[0].state, 'working');
  assert.equal((await scan(now + 1_000)).threads[0].state, 'working');
  await writeFile(transcript, jsonl([{ type: 'result', timestamp: new Date(now + 1_001).toISOString() }]) + '\n', { flag: 'a' });
  assert.equal((await scan(now + 1_999)).threads[0].state, 'idle');
  assert.equal((await scan(now + 2_000)).threads[0].state, 'idle');
});

test('Claude roots include only explicitly linked child work and observe its final completion', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  const projectDir = path.join(projectsDir, 'project');
  const subagents = path.join(projectDir, id, 'subagents');
  const rootPath = path.join(projectDir, `${id}.jsonl`);
  const childPath = path.join(subagents, 'agent-linked.jsonl');
  const event = (type, offset, extra) => ({ type, timestamp: new Date(now + offset).toISOString(), ...extra });
  const launch = (agentId, offset) => [
    event('assistant', offset, { message: { content: [{ type: 'tool_use', id: agentId, name: 'Agent', input: { run_in_background: true } }] } }),
    event('user', offset + 1, { message: { content: [{ type: 'tool_result', tool_use_id: agentId }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId } }),
  ];
  const final = (offset) => event('assistant', offset, { message: { stop_reason: 'end_turn', content: 'Complete.' } });
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  await writeFile(rootPath, jsonl([
    event('user', -10_000, { message: { content: 'Start the work.' } }), ...launch('linked', -9_000), final(-8_000),
  ]) + '\n');
  await writeFile(childPath, jsonl([
    event('assistant', -7_000, { sessionId: id, isSidechain: true, agentId: 'linked',
      message: { content: [{ type: 'thinking', thinking: 'private child body' }] } }),
    event('user', -6_000, { message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: 'private result' }] } }),
  ]) + '\n');
  await writeFile(path.join(subagents, 'agent-unrelated.jsonl'), jsonl([
    event('assistant', -1_000, { message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  ]) + '\n');
  const otherSubagents = path.join(projectsDir, 'other-project', id, 'subagents');
  await mkdir(otherSubagents, { recursive: true });
  await writeFile(path.join(otherSubagents, 'agent-linked.jsonl'), jsonl([
    event('assistant', -1_000, { sessionId: id, message: { content: [{ type: 'thinking' }] } }),
  ]) + '\n');
  const scan = async (time = now) => buildSwitchboardDashboard((await loadClaudeDesktopCodeThreads({
    appDir, projectsDir, nowMs: time,
  })).threads, [], time);
  const tracker = new PendingTracker(false);
  const active = await tracker.observe(await scan());
  assert.equal(active.threads.length, 1);
  assert.equal(active.threads[0].subagentCount, 2);
  assert.equal(active.threads[0].state, 'working');
  assert.equal(active.threads[0].workingSinceMs, now - 10_000);
  assert.equal(active.threads[0].completionAtMs, 0);
  assert.equal(active.threads[0].pending, false);
  assert.equal(active.nextStatusCheckAtMs, now - 6_000 + 6 * 3_600_000 + 1);
  const discardTracker = new PendingTracker(false);
  const discardWorking = await discardTracker.observe(await scan());
  await discardTracker.setDiscard(discardWorking.threads[0], true);
  assert.equal((await scan(now + 7 * 3_600_000)).threads[0].state, 'unknown');
  assert.doesNotMatch(JSON.stringify(active), /agent-linked|private child body|private result|subagents/);
  await tracker.markUnread(active.threads[0].id);
  const unreadWorking = await tracker.observe(await scan());
  assert.equal(unreadWorking.threads[0].state, 'working');
  assert.equal(unreadWorking.threads[0].manualUnread, true);
  assert.deepEqual([unreadWorking.threads[0].unread, unreadWorking.threads[0].pending, unreadWorking.threads[0].pendingSource], [false, false, '']);
  await tracker.acknowledge(active.threads[0].id);
  await writeFile(childPath, jsonl([final(100)]) + '\n', { flag: 'a' });
  const complete = await tracker.observe(await scan(now + 100));
  assert.equal(complete.threads[0].state, 'idle');
  assert.equal(complete.threads[0].completionAtMs, now + 100);
  assert.equal(complete.threads[0].completionAttention, true);
  const discardComplete = (await discardTracker.observe(await scan(now + 100))).threads[0];
  assert.deepEqual([discardComplete.state, discardComplete.discardResult, discardComplete.pending, discardComplete.unread], ['idle', false, false, false]);
  assert.equal((await scan(now + 101)).threads[0].state, 'idle');
  await tracker.acknowledge(active.threads[0].id);
  await writeFile(rootPath, jsonl([
    event('user', 200, { message: { content: 'Start the next task.' } }), ...launch('later', 210),
  ]) + '\n', { flag: 'a' });
  assert.equal((await scan(now + 220)).threads[0].state, 'working');
  await writeFile(rootPath, jsonl([final(230)]) + '\n', { flag: 'a' });
  assert.equal((await scan(now + 240)).threads[0].state, 'unknown');
  const laterPath = path.join(subagents, 'agent-later.jsonl');
  await writeFile(laterPath, jsonl([event('assistant', 250, { message: { content: [{ type: 'tool_use', name: 'Bash' }], stop_reason: 'tool_use' } })]) + '\n');
  const discovered = await tracker.observe(await scan(now + 250));
  assert.equal(discovered.threads[0].state, 'working');
  assert.equal(discovered.threads[0].subagentCount, 3);
  assert.equal(discovered.threads[0].workingSinceMs, now + 200);
  for (const terminal of [{ type: 'result', terminal_reason: 'interrupted' }, { type: 'result', is_error: true }]) {
    await writeFile(laterPath, jsonl([event('assistant', 280, { message: { content: [{ type: 'thinking' }] } })]) + '\n');
    await tracker.observe(await scan(now + 280));
    await writeFile(laterPath, jsonl([event(terminal.type, 300, terminal)]) + '\n');
    const ended = (await tracker.observe(await scan(now + 300))).threads[0];
    assert.equal(ended.state, 'idle');
    assert.equal(ended.completionAtMs, 0);
    assert.equal(ended.lastOutcome, terminal.is_error ? 'failed' : 'stopped');
    assert.equal(ended.pending, Boolean(terminal.is_error));
    assert.equal(ended.failedAttention, Boolean(terminal.is_error));
    await tracker.acknowledge(ended.id);
  }
});

test('stale Claude child work does not replace a fresh root start or keep a cancelled request Waiting', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  const childDir = path.join(projectsDir, id, 'subagents');
  const rootPath = path.join(projectsDir, `${id}.jsonl`);
  const event = (type, offset, extra) => ({ type, timestamp: new Date(now + offset).toISOString(), ...extra });
  const old = -7 * 3_600_000;
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(childDir, { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  await writeFile(rootPath, jsonl([
    event('user', old - 100, { message: { content: 'Run the old work.' } }),
    event('assistant', old, { message: { content: [{ type: 'tool_use', id: 'old-launch', name: 'Agent' }] } }),
    event('user', old + 1, { message: { content: [{ type: 'tool_result', tool_use_id: 'old-launch' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'old' } }),
    event('assistant', old + 2, { message: { stop_reason: 'end_turn', content: 'Launched.' } }),
    event('user', -100, { message: { content: 'Run the fresh work.' } }),
  ]) + '\n');
  await writeFile(path.join(childDir, 'agent-old.jsonl'), jsonl([
    event('assistant', old + 3, { message: { content: [{ type: 'thinking' }] } }),
  ]) + '\n');
  const scan = async () => buildSwitchboardDashboard((await loadClaudeDesktopCodeThreads({
    appDir, projectsDir, nowMs: now,
  })).threads, [], now);
  const active = (await scan()).threads[0];
  assert.equal(active.state, 'working');
  assert.equal(active.workingSinceMs, now - 100);
  await writeFile(rootPath, jsonl([event('assistant', -50, { message: { stop_reason: 'end_turn', content: 'Fresh work done.' } })]) + '\n', { flag: 'a' });
  assert.equal((await scan()).threads[0].state, 'unknown');
  await writeFile(path.join(childDir, 'agent-old.jsonl'), jsonl([event('result', -20, { terminal_reason: 'interrupted' })]) + '\n', { flag: 'a' });
  assert.equal((await scan()).threads[0].state, 'idle');
  await writeFile(rootPath, jsonl([
    event('user', -10, { message: { content: 'Start a request with a question.' } }),
    event('assistant', -5, { message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion' }] } }),
    event('user', -1, { message: { content: '[Request interrupted by user]' } }),
  ]) + '\n', { flag: 'a' });
  const cancelled = (await scan()).threads[0];
  assert.equal(cancelled.state, 'idle');
  assert.equal(cancelled.completionAtMs, 0);
});

test('a Working row hides stored unread marks, keeps them for later, and shows only question attention', async () => {
  const tracker = new PendingTracker(false);
  const board = (state, question = false) => {
    const questionRow = buildSwitchboardDashboard([{ id: 'question', provider: 'codex', lifecycleRunning: true,
      agentActivityAtMs: now, awaitingUserInput: question, latestUserQuestionAtMs: now }], [], now).threads[0];
    return { providers: [], threads: [
      { id: 'retained', state, nativeUnread: null, completionAtMs: state === 'idle' ? now : 0 },
      { id: 'native', state, nativeUnread: true }, { id: 'manual', state, nativeUnread: false }, questionRow,
    ] };
  };
  await tracker.setPersistentUnread(true, await tracker.observe(board('working')));
  await tracker.observe(board('idle'));
  await tracker.markUnread('manual');
  const working = await tracker.observe(board('working', true));
  assert.deepEqual(working.threads.map((row) => [row.id, row.state, row.unread, row.pending, row.pendingSource]), [
    ['retained', 'working', false, false, ''], ['native', 'working', false, false, ''],
    ['manual', 'working', false, false, ''], ['question', 'working', false, true, 'user-question']]);
  assert.deepEqual(working.threads.slice(0, 3).map((row) => [row.retainedUnreadSource, row.nativeAttention, row.manualUnread]),
    [['observed-completion', false, false], ['native-unread', true, false], ['', false, true]]);
  const idle = await tracker.observe(board('idle'));
  assert.deepEqual(idle.threads.slice(0, 3).map((row) => [row.unread, row.pending, row.pendingSource]),
    [[true, true, 'observed-completion'], [true, true, 'native-unread'], [true, true, 'manual-unread']]);
});

test('a pending Claude AskUserQuestion gives question attention, and Working only while a linked child works', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  const subagents = path.join(projectsDir, 'project', id, 'subagents');
  const rootPath = path.join(projectsDir, 'project', `${id}.jsonl`);
  const event = (type, offset, extra) => ({ type, timestamp: new Date(now + offset).toISOString(), ...extra });
  const use = (toolId, name, offset) => event('assistant', offset, { message: { content: [{ type: 'tool_use', id: toolId, name }] } });
  const result = (toolId, offset, extra) => event('user', offset, { message: { content: [{ type: 'tool_result', tool_use_id: toolId }] }, ...extra });
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  const tracker = new PendingTracker(false);
  const scan = async (events) => {
    if (events) await writeFile(rootPath, jsonl(events) + '\n', { flag: 'a' });
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs: now });
    return { thread: threads[0], row: (await tracker.observe(buildSwitchboardDashboard(threads, [], now))).threads[0] };
  };
  const attention = ({ row }) => [row.state, row.questionPending, row.questionAttention, row.unread, row.pending, row.pendingSource];
  const blocking = await scan([event('user', -10_000, { message: { content: 'Start the work.' } }),
    use('linked', 'Agent', -9_000), result('linked', -8_999, { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'linked' } }),
    use('ask', 'AskUserQuestion', -5_000)]);
  assert.deepEqual(attention(blocking), ['waiting', true, true, false, true, 'user-question']);
  assert.deepEqual([blocking.thread.awaitingPermission, blocking.thread.pendingToolCount, blocking.thread.awaitingUserInput,
    blocking.thread.latestUserQuestionAtMs], [true, 1, true, now - 5_000]);
  await writeFile(path.join(subagents, 'agent-linked.jsonl'),
    jsonl([event('assistant', -4_000, { sessionId: id, isSidechain: true, agentId: 'linked', message: { content: [{ type: 'thinking' }] } })]) + '\n');
  const nonBlocking = await scan();
  assert.deepEqual(attention(nonBlocking), ['working', true, true, false, true, 'user-question']);
  assert.equal(nonBlocking.thread.awaitingPermission, true);
  const permission = await scan([use('permission', 'request_permission', -3_000)]);
  assert.deepEqual([permission.row.state, permission.row.actionRequired, permission.row.pending], ['waiting', true, true]);
  await tracker.acknowledge(permission.row.id);
  const permissionRead = (await scan()).row;
  assert.deepEqual([permissionRead.questionAttention, permissionRead.actionRequired, permissionRead.pending], [false, true, true]);
  const plan = await scan([result('permission', -2_800), use('plan', 'ExitPlanMode', -2_500)]);
  assert.deepEqual([plan.row.state, plan.row.actionRequired, plan.row.pending, plan.thread.questionNonBlocking], ['waiting', true, true, false]);
  const answered = await scan([result('plan', -2_000), result('ask', -1_000)]);
  assert.deepEqual(attention(answered), ['working', false, false, false, false, '']);
  assert.equal(answered.thread.awaitingUserInput, false);
});

test('ASB shares concurrent loads and uses the active fallback clock without forced scans', async (t) => {
  let clock = now;
  let loads = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const server = createSwitchboardServer({ now: () => clock, pendingStatePath: false, dashboardWatchPaths: [], loadDashboard: async () => {
    loads += 1;
    started.resolve();
    await release.promise;
    return { generatedAtMs: clock, providers: [], threads: [{ id, state: loads === 1 ? 'working' : 'idle', nativeUnread: null,
      completionAtMs: loads === 1 ? 0 : clock }] };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  const first = scan();
  await started.promise;
  const received = Promise.withResolvers();
  server.once('request', received.resolve);
  const concurrent = scan();
  await received.promise;
  release.resolve();
  const snapshots = await Promise.all([first, concurrent]);
  assert.equal(loads, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.threads[0].state === 'working'));
  clock += 1_999;
  assert.equal((await scan()).threads[0].state, 'working');
  assert.equal(loads, 1);
  clock += 1;
  const next = await scan();
  assert.equal(loads, 2);
  assert.equal(next.threads[0].state, 'idle');
  assert.equal(next.threads[0].completionAttention, true);
  await scan();
  assert.equal(loads, 2);
});

test('the web view uses the adaptive clock, pauses when hidden, and skips overlapping or unchanged redraws', async () => {
  let requests = 0;
  let redraws = 0;
  let clock = now;
  let interval;
  let intervalMs;
  const release = Promise.withResolvers();
  const node = () => ({ value: 'all', checked: false, dataset: {}, addEventListener() {}, setAttribute() {}, append() {},
    replaceChildren() { redraws += 1; }, querySelectorAll() { return []; } });
  const nodes = Object.fromEntries(['search', 'app', 'status', 'archive', 'refresh', 'count', 'updated', 'notice', 'sessions'].map((key) => [key, node()]));
  nodes.search.value = '';
  const document = { hidden: false, getElementById: (key) => nodes[key], addEventListener() {}, createElement: node, createDocumentFragment: node };
  const board = { generatedAtMs: now, providers: [], threads: [] };
  const context = vm.createContext({ document, Date: class extends Date { static now() { return clock; } },
    window: { addEventListener() {} }, clearTimeout() {},
    setTimeout(callback, milliseconds) { interval = callback; intervalMs = milliseconds; },
    fetch: async () => { requests += 1; await release.promise; return { ok: true, json: async () => structuredClone(board) }; },
  });
  vm.runInContext(await readFile(new URL('../public/switchboard.js', import.meta.url), 'utf8'), context);
  await vm.runInContext('refresh()', context);
  assert.equal(requests, 1);
  assert.equal(redraws, 0);
  release.resolve();
  await new Promise(setImmediate);
  assert.equal(redraws, 1);
  assert.equal(intervalMs, 250);
  const previousUpdated = nodes.updated.textContent;
  board.generatedAtMs += 60_000;
  interval();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(intervalMs, 5_000);
  assert.equal(redraws, 1);
  assert.equal(nodes.updated.dateTime, new Date(board.generatedAtMs).toISOString());
  assert.notEqual(nodes.updated.textContent, previousUpdated);
  document.hidden = true;
  interval();
  assert.equal(requests, 2);
  document.hidden = false;
  board.providers.push({ id: 'codex', message: 'Changed source' });
  interval();
  await new Promise(setImmediate);
  assert.equal(redraws, 2);
  clock += 60_000;
  interval();
  await new Promise(setImmediate);
  assert.equal(redraws, 3);
});

test('ASB reports unavailable or corrupt Claude metadata without a ready status', async (t) => {
  const dir = await temp(t);
  const missing = await loadSwitchboardDashboard({ loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir: dir, projectsDir: path.join(dir, 'projects') } });
  assert.equal(missing.providers[1].status, 'error');
  const sessions = path.join(dir, 'claude-code-sessions');
  await mkdir(sessions);
  await writeFile(path.join(sessions, 'local_bad.json'), '{');
  const corrupt = await loadSwitchboardDashboard({ loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir: dir, projectsDir: path.join(dir, 'projects') } });
  assert.equal(corrupt.providers[1].status, 'error');
  await writeFile(path.join(sessions, 'local_good.json'), JSON.stringify({ sessionId: localId, title: 'Good' }));
  const partial = await loadSwitchboardDashboard({ loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir: dir, projectsDir: path.join(dir, 'projects') } });
  assert.equal(partial.providers[1].status, 'warning');
  assert.equal(partial.threads.length, 1);
  assert.equal(partial.threads[0].state, 'unknown');
});

test('native SQLite works without the CLI, preserves desktop name/pin, and reads only', async (t) => {
  const dir = await temp(t);
  const dbPath = path.join(dir, 'state_7.sqlite');
  const rollout = path.join(dir, 'rollout.jsonl');
  await writeFile(rollout, jsonl([{ timestamp: new Date(now).toISOString(), payload: { type: 'task_complete' } }]));
  const database = codexDatabase(dbPath);
  database.prepare('insert into threads (id, source, cwd, title, name, is_pinned, thread_source, archived, updated_at_ms, rollout_path) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'vscode', '/work/ASB', 'Old prompt', 'Desktop name', 1, 'user', 0, now, rollout);
  database.prepare('update threads set creator_account_id = ?, creator_user_id = ?').run('test-account', 'test-user');
  database.close();
  await writeFile(path.join(dir, 'state_2.sqlite'), 'not a database');
  assert.equal(await discoverCodexStateDatabase(dir), dbPath);
  const before = await readFile(dbPath);
  const beforeStat = await stat(dbPath);
  const rows = await readThreads({ databasePath: dbPath });
  assert.equal(rows[0].name, 'Desktop name');
  assert.equal(rows[0].is_pinned, 1);
  assert.equal(rows[0].creator_account_id, 'test-account');
  const oldPath = process.env.PATH;
  process.env.PATH = '/no-asb-tools';
  t.after(() => { process.env.PATH = oldPath; });
  const dashboard = await loadCodexDashboard({ databasePath: dbPath, sessionIndexPath: path.join(dir, 'absent-index'), globalStatePath: path.join(dir, 'absent-state'),
    authPath: path.join(dir, 'never-read-auth'), fetchImpl: () => assert.fail('Network call'),
    nowMs: now,
  });
  process.env.PATH = oldPath;
  assert.equal(dashboard.threads[0].title, 'Desktop name');
  assert.equal(dashboard.threads[0].pinned, true);
  assert.equal(dashboard.threads[0].lifecycleRunning, false);
  assert.equal(buildSwitchboardDashboard(dashboard.threads, [], now).threads[0].completionAtMs, now);
  assert.deepEqual(await readFile(dbPath), before);
  assert.equal((await stat(dbPath)).mtimeMs, beforeStat.mtimeMs);
  await assert.rejects(readThreads({ databasePath: path.join(dir, 'missing.sqlite') }));
  await assert.rejects(stat(path.join(dir, 'missing.sqlite')), { code: 'ENOENT' });
});

test('Codex roots read linked nested lifecycle, hold completion, and ignore archived or unrelated work', async (t) => {
  const dir = await temp(t);
  const dbPath = path.join(dir, 'state_9.sqlite');
  const childId = id.replace(/0$/, '1');
  const nestedId = id.replace(/0$/, '2');
  const archivedId = id.replace(/0$/, '3');
  const unrelatedId = id.replace(/0$/, '4');
  const orphanId = id.replace(/0$/, '5');
  const internalId = id.replace(/0$/, '6');
  const rollout = (identity) => path.join(dir, `rollout-private-child-${identity}.jsonl`);
  const event = (type, offset) => ({ timestamp: new Date(now + offset).toISOString(), payload: { type } });
  const append = (identity, events) => writeFile(rollout(identity), jsonl(events) + '\n', { flag: 'a' });
  const database = codexDatabase(dbPath);
  const insert = database.prepare('insert into threads (id, source, cwd, title, thread_source, archived, updated_at_ms, rollout_path) values (?, ?, ?, ?, ?, ?, ?, ?)');
  const childSource = (parent) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } });
  for (const [identity, source, archived] of [[id, 'vscode', 0], [childId, childSource(id), 0],
    [nestedId, childSource(childId), 0], [archivedId, childSource(id), 1],
    [unrelatedId, childSource('absent-root'), 0], [internalId, 'subagent', 0]]) {
    insert.run(identity, source, identity === id ? '/work/ASB' : '/private-child-folder',
      identity === id ? 'Root' : 'private child title', identity === id ? 'user' : 'subagent', archived, now, rollout(identity));
  }
  database.close();
  await append(id, [event('task_started', -10_000), event('task_complete', -8_000)]);
  await append(childId, [event('task_started', -7_000), event('task_complete', -6_000)]);
  await append(nestedId, [event('task_started', -5_000), { timestamp: new Date(now - 4_000).toISOString(),
    type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: 'private child prompt' } }]);
  for (const identity of [archivedId, unrelatedId, orphanId, internalId]) await append(identity, [event('task_started', -1_000)]);
  const beforeDatabase = await readFile(dbPath);
  const scan = (time = now) => loadSwitchboardDashboard({ nowMs: time,
    codexOptions: { databasePath: dbPath, sessionIndexPath: path.join(dir, 'missing-index'),
      globalStatePath: path.join(dir, 'missing-state'), fetchImpl: () => assert.fail('Network call') },
    loadClaude: async () => ({ threads: [] }),
  });
  const tracker = new PendingTracker(false);
  const beforeMetrics = getCodexCacheStats().rolloutSignals;
  const active = await tracker.observe(await scan());
  assert.equal(active.threads.length, 1);
  assert.equal(active.threads[0].state, 'working');
  assert.equal(active.threads[0].workingSinceMs, now - 5_000);
  assert.equal(active.threads[0].completionAtMs, 0);
  assert.equal(active.threads[0].pending, false);
  assert.equal(active.refreshIntervalMs, 2_000);
  assert.equal(active.nextStatusCheckAtMs, now - 4_000 + 6 * 3_600_000 + 1);
  assert.doesNotMatch(JSON.stringify(active), /private child|private-child|absent-root/);
  for (const identity of [childId, nestedId, archivedId, unrelatedId, orphanId, internalId]) assert.ok(!JSON.stringify(active).includes(identity));
  const afterMetrics = getCodexCacheStats().rolloutSignals;
  assert.equal(afterMetrics.misses - beforeMetrics.misses, 3);
  assert.equal((await scan(now + 2_000)).threads[0].workingSinceMs, now - 5_000);
  assert.equal(getCodexCacheStats().rolloutSignals.bytesRead, afterMetrics.bytesRead);
  assert.ok(getCodexCacheStats().rolloutSignals.hits >= afterMetrics.hits + 3);
  const stale = await scan(now + 7 * 3_600_000);
  assert.equal(stale.threads[0].state, 'unknown');
  assert.equal(stale.threads[0].workingSinceMs, 0);
  assert.equal(stale.threads[0].completionAtMs, 0);
  await append(nestedId, [event('task_complete', 100)]);
  const complete = await tracker.observe(await scan(now + 100));
  assert.equal(complete.threads[0].state, 'idle');
  assert.equal(complete.threads[0].completionAtMs, now + 100);
  assert.equal(complete.threads[0].completionAttention, true);
  assert.equal(complete.refreshIntervalMs, 5_000);
  await tracker.acknowledge(id);
  await append(nestedId, [event('task_started', 200)]);
  await tracker.observe(await scan(now + 200));
  await append(id, [event('task_started', 210), event('task_complete', 220)]);
  const rootEnded = await tracker.observe(await scan(now + 220));
  assert.equal(rootEnded.threads[0].state, 'working');
  assert.equal(rootEnded.threads[0].completionAtMs, 0);
  assert.equal(rootEnded.threads[0].pending, false);
  await append(nestedId, [event('turn_cancelled', 230)]);
  const cancelled = await tracker.observe(await scan(now + 230));
  assert.equal(cancelled.threads[0].state, 'idle');
  assert.equal(cancelled.threads[0].completionAtMs, 0);
  assert.equal(cancelled.threads[0].pending, false);
  assert.equal(cancelled.threads[0].lastOutcome, 'stopped');
  await append(nestedId, [event('task_started', 240)]);
  await tracker.observe(await scan(now + 240));
  await append(nestedId, [event('task_complete', 250)]);
  const afterCancellation = await tracker.observe(await scan(now + 250));
  assert.equal(afterCancellation.threads[0].completionAtMs, now + 250);
  assert.equal(afterCancellation.threads[0].completionAttention, true);
  await tracker.acknowledge(id);
  await append(nestedId, [event('task_started', 260)]);
  await tracker.observe(await scan(now + 260));
  await append(nestedId, [{ timestamp: new Date(now + 270).toISOString(), payload: {
    type: 'task_complete', error: { message: 'Synthetic terminal error', codex_error_info: 'other' },
  } }]);
  const failed = (await tracker.observe(await scan(now + 270))).threads[0];
  assert.deepEqual([failed.state, failed.lastOutcome, failed.failedAttention, failed.pending], ['idle', 'failed', true, true]);
  assert.equal(failed.failedAtMs, now + 270);
  assert.equal(failed.completionAtMs, 0);
  assert.doesNotMatch(JSON.stringify(failed), /Synthetic terminal error|codex_error_info/);
  await tracker.acknowledge(id);
  await rm(rollout(nestedId));
  const missing = await scan(now + 300);
  assert.equal(missing.threads[0].state, 'unknown');
  assert.equal(missing.threads[0].completionAtMs, 0);
  await writeFile(rollout(childId), jsonl([event('task_started', -7 * 3_600_000)]) + '\n');
  await append(id, [event('task_started', 310)]);
  const fresh = await scan(now + 310);
  assert.equal(fresh.threads[0].state, 'working');
  assert.equal(fresh.threads[0].workingSinceMs, now + 310);
  await append(id, [event('task_complete', 320)]);
  assert.equal((await scan(now + 320)).threads[0].state, 'unknown');
  await append(nestedId, [event('task_complete', 330)]);
  assert.equal((await scan(now + 330)).threads[0].state, 'unknown');
  await append(childId, [event('task_cancelled', 340)]);
  const lastCancelled = await tracker.observe(await scan(now + 340));
  assert.equal(lastCancelled.threads[0].state, 'idle');
  assert.equal(lastCancelled.threads[0].completionAtMs, 0);
  assert.equal(lastCancelled.threads[0].pending, false);
  assert.deepEqual(await readFile(dbPath), beforeDatabase);
});

test('Codex group timing expires each open member and preserves root question and read signals', async () => {
  const root = { id, provider: 'codex', lifecycleRunning: true, agentStartedAtMs: now - 100,
    agentActivityAtMs: now, latestLifecycleAtMs: now - 100, latestLifecycleKind: 'task_started', nativeUnread: false, readStatus: 'read' };
  const child = { id: 'child', provider: 'codex', isSubagent: true, parentThreadId: id,
    lifecycleRunning: true, agentStartedAtMs: now - 6 * 3_600_000, agentActivityAtMs: now - 6 * 3_600_000 + 100,
    latestLifecycleAtMs: now - 6 * 3_600_000, latestLifecycleKind: 'task_started', nativeUnread: true };
  const beforeExpiry = buildSwitchboardDashboard([root, child], [], now);
  assert.equal(beforeExpiry.threads[0].workingSinceMs, child.agentStartedAtMs);
  assert.equal(beforeExpiry.nextStatusCheckAtMs, now + 101);
  const afterExpiry = buildSwitchboardDashboard([root, child], [], now + 101);
  assert.equal(afterExpiry.threads[0].state, 'working');
  assert.equal(afterExpiry.threads[0].workingSinceMs, root.agentStartedAtMs);
  assert.equal(afterExpiry.threads[0].nativeUnread, false);
  assert.equal(afterExpiry.threads[0].readStatus, 'read');
  const currentQuestion = { ...root, awaitingUserInput: true, userQuestionBlocking: true,
    latestUserQuestionAtMs: now - 50, latestBlockingQuestionAtMs: now - 50 };
  const endedChild = { ...child, lifecycleRunning: false, latestLifecycleAtMs: now - 10, latestLifecycleKind: 'task_complete' };
  assert.equal(buildSwitchboardDashboard([currentQuestion, endedChild], [], now).threads[0].state, 'waiting');
  const tracker = new PendingTracker(false);
  const asyncQuestion = await tracker.observe(buildSwitchboardDashboard([{ ...currentQuestion, userQuestionBlocking: false }, child], [], now));
  assert.equal(asyncQuestion.threads[0].state, 'working');
  assert.equal(asyncQuestion.threads[0].pendingSource, 'user-question');
  assert.equal(asyncQuestion.threads[0].completionAtMs, 0);
  const childQuestion = { ...child, agentStartedAtMs: now - 20, agentActivityAtMs: now - 10, latestLifecycleAtMs: now - 20,
    awaitingUserInput: true, userQuestionBlocking: true, latestUserQuestionAtMs: now - 10, latestBlockingQuestionAtMs: now - 10 };
  const idleRoot = { ...root, lifecycleRunning: false, latestLifecycleAtMs: now - 30, latestLifecycleKind: 'task_complete' };
  const missingActivity = buildSwitchboardDashboard([idleRoot,
    { ...child, agentActivityAtMs: 0, latestLifecycleAtMs: 0, agentStartedAtMs: 0 }], [], now);
  assert.equal(missingActivity.threads[0].state, 'unknown');
  assert.equal(missingActivity.threads[0].workingSinceMs, 0);
  assert.equal(missingActivity.nextStatusCheckAtMs, Infinity);
  const blockedGroup = await new PendingTracker(false).observe(buildSwitchboardDashboard([idleRoot, childQuestion], [], now));
  assert.equal(blockedGroup.threads[0].state, 'waiting');
  assert.equal(blockedGroup.threads[0].pendingSource, 'user-question');
  assert.equal(buildSwitchboardDashboard([root, childQuestion], [], now).threads[0].state, 'working');
  const childAsyncGroup = await new PendingTracker(false).observe(buildSwitchboardDashboard([idleRoot,
    { ...childQuestion, userQuestionBlocking: false }], [], now));
  assert.equal(childAsyncGroup.threads[0].state, 'working');
  assert.equal(childAsyncGroup.threads[0].pendingSource, 'user-question');
});

test('ASB allows only its view, session reads, and same-origin stored-session opens', async (t) => {
  const calls = [];
  const server = createSwitchboardServer({ pendingStatePath: false, loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', canOpen: true, appDeepLink: `codex://threads/${id}` }] }),
    openThread: async (thread) => { calls.push(thread); return { opened: true }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = `${base}/api/threads/${id}/open`;
  assert.equal((await fetch(base)).status, 200);
  assert.match(await (await fetch(base)).text(), /Agent Switch Board/);
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 200);
  for (const route of ['/api/reviews', '/api/search', '/api/notifications', '/api/model-services/bailian-snapshot', '/api/prompt-packs', '/index.html', '/app.js']) {
    assert.equal((await fetch(`${base}${route}`, { method: 'POST', body: '{}' })).status, 404, route);
  }
  assert.equal((await fetch(`${base}/api/dashboard`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(open)).status, 405);
  assert.equal((await fetch(open, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(open, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(open, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/threads/missing/open`, { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 404);
  assert.equal((await fetch(open, { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ command: 'bad', appDeepLink: 'https://example.com' }) })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].appDeepLink, `codex://threads/${id}`);
  const rebinding = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/dashboard`, { headers: { Host: `attacker.test:${server.address().port}` } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rebinding, 403);
});

test('Codex native read status matches one metadata identity and the exact local host only', () => {
  const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const identity = digest(['chatgpt', 'test-account', 'test-user']);
  const localHost = `local:${digest(['local', 'local', null])}`;
  const thread = { id, creatorAccountId: 'test-account', creatorUserId: 'test-user' };
  const state = (namespaces, identities = {}) => ({ 'electron-thread-read-state-v1': {
    version: 1, unreadByIdentity: { [identity]: namespaces, ...identities },
  } });
  assert.deepEqual(codexNativeReadStatus(thread, state({ [localHost]: [id] })), { nativeUnread: true, readStatus: 'unread' });
  assert.deepEqual(codexNativeReadStatus(thread, state({ [localHost]: [], 'durable:elsewhere': [id] })), { nativeUnread: false, readStatus: 'read' });
  for (const invalid of [state({ 'durable:elsewhere': [id] }), state({ 'local:other': [id] }), state({ [localHost]: [42] }),
    state({ [localHost]: [id] }, { 'other-identity': { [localHost]: [id] } }), {}]) {
    assert.equal(codexNativeReadStatus(thread, invalid).readStatus, 'unknown');
  }
  assert.equal(codexNativeReadStatus({ ...thread, creatorUserId: 'other' }, state({ [localHost]: [id] })).readStatus, 'unknown');
  assert.equal(codexNativeReadStatus({ id }, state({ [localHost]: [id] })).readStatus, 'unknown');
  const roots = buildSwitchboardDashboard([{ ...thread, provider: 'codex', title: 'Root', nativeUnread: false },
    { id: 'internal', provider: 'codex', threadSource: 'subagent', nativeUnread: true }], [], now);
  assert.equal(roots.threads.length, 1);
  assert.equal(roots.threads[0].nativeUnread, false);
  assert.ok(!JSON.stringify(roots).includes('test-account'));
  assert.ok(!JSON.stringify(roots).includes('creator'));
});

test('Pending observes complete scans, preserves native truth, and persists completion acknowledgments', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'asb', 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = (rows) => ({ providers: [], threads: rows.map((row) => ({ nativeUnread: null, completionAtMs: 0, updatedAtMs: now, ...row })) });
  const first = await tracker.observe(board([{ id: 'old', state: 'idle', completionAtMs: 100 },
    { id: 'hidden', state: 'working' }, { id: 'native-working', state: 'working', nativeUnread: true },
    { id: 'native-unread', state: 'idle', nativeUnread: true }, { id: 'native-read', state: 'idle', nativeUnread: false },
    { id: 'waiting', state: 'waiting' }, { id: 'unknown', state: 'unknown', nativeUnread: true }]));
  assert.equal(first.threads[0].pending, false);
  assert.equal(first.threads[2].pending, false);
  assert.equal(first.threads[2].state, 'working');
  assert.equal(first.threads[2].nativeAttention, true);
  assert.equal(first.threads[2].unread, false);
  assert.equal(first.threads[2].pendingSource, '');
  assert.equal(first.threads[3].pendingSource, 'native-unread');
  assert.equal(first.threads[4].pending, false);
  assert.equal(first.threads[5].pending, true);
  assert.equal(first.threads[5].state, 'waiting');
  assert.equal(first.threads[6].pending, true);
  const completed = await tracker.observe(board([{ id: 'hidden', state: 'idle', completionAtMs: 200 }]));
  assert.equal(completed.threads[0].pendingSource, 'observed-completion');
  assert.equal(completed.threads[0].unread, true);
  const restarted = new PendingTracker(statePath);
  assert.equal((await restarted.observe(board([{ id: 'hidden', state: 'idle', completionAtMs: 200 }]))).threads[0].pending, true);
  await restarted.acknowledge('hidden');
  assert.equal((await new PendingTracker(statePath).observe(board([{ id: 'hidden', state: 'idle', completionAtMs: 200 }]))).threads[0].pending, false);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(Object.keys(saved.records.hidden).sort(), ['ack', 'discard', 'discardEnd', 'discardNative', 'discardStart', 'discardedAt',
    'manual', 'nativeAck', 'nativeAt', 'nativeSeen', 'pending', 'pendingKind', 'questionAck', 'questionSeen', 'retained', 'seen', 'working']);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  await tracker.observe(board([{ id: 'aborted', state: 'working' }]));
  assert.equal((await tracker.observe(board([{ id: 'aborted', state: 'idle', completionAtMs: 0 }]))).threads[0].pending, false);
  const aborted = parseRolloutSignals(jsonl([
    { timestamp: new Date(now - 1000).toISOString(), payload: { type: 'agent_message', phase: 'final_answer', message: 'Old reply' } },
    { timestamp: new Date(now).toISOString(), payload: { type: 'turn_aborted' } },
  ]));
  assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', lifecycleRunning: false, ...aborted }], [], now).threads[0].completionAtMs, 0);
  for (const kind of ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled']) {
    const ended = parseRolloutSignals(jsonl([{ timestamp: new Date(now).toISOString(), payload: { type: kind } }]));
    assert.equal(ended.agentRunning, false);
    assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', ...ended }], [], now).threads[0].completionAtMs, 0);
  }
  const emptyComplete = parseRolloutSignals(jsonl([{ timestamp: new Date(now).toISOString(), payload: { type: 'task_complete', last_agent_message: '' } }]));
  assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', ...emptyComplete }], [], now).threads[0].completionAtMs, now);
  await tracker.observe(board([{ id: 'archive', state: 'working' }, { id: 'stale', state: 'working' }]));
  await tracker.observe(board([{ id: 'stale', state: 'unknown' }]));
  const excluded = await tracker.observe(board([{ id: 'archive', state: 'idle', archived: true, nativeUnread: true, completionAtMs: 300 },
    { id: 'stale', state: 'idle', completionAtMs: 300 }]));
  assert.equal(excluded.threads[0].pending, true);
  assert.equal(excluded.threads[0].unread, true);
  assert.equal(excluded.threads[0].pendingSource, 'native-unread');
  assert.equal(excluded.threads[1].pending, false);
});

test('Working activity does not rewrite Pending state, and legacy Working timestamps still track completion', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = (state, at) => ({ providers: [], threads: [{ id, state, nativeUnread: null, updatedAtMs: at, completionAtMs: state === 'idle' ? at : 0 }] });
  await tracker.observe(board('working', now));
  const before = await stat(statePath);
  const content = await readFile(statePath, 'utf8');
  await tracker.observe(board('working', now + 2_000));
  await tracker.observe(board('working', now + 4_000));
  assert.equal(await readFile(statePath, 'utf8'), content);
  assert.equal((await stat(statePath)).ino, before.ino);
  assert.equal((await stat(statePath)).mtimeMs, before.mtimeMs);
  assert.equal(JSON.parse(content).records[id].working, 1);
  assert.equal((await tracker.observe(board('idle', now + 6_000))).threads[0].completionAttention, true);
  const legacyPath = path.join(dir, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({ version: 1, records: { [id]: { seen: 0, working: now, pending: 0, ack: 0 } } }));
  const legacy = new PendingTracker(legacyPath);
  assert.equal((await legacy.observe(board('idle', now + 6_000))).threads[0].completionAttention, true);
  await legacy.acknowledge(id);
  assert.equal((await new PendingTracker(legacyPath).observe(board('idle', now + 6_000))).threads[0].completionAttention, false);
});

test('persistent unread retains native, question, and observed completion dots with their sources through restart', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = (native = true, question = true, completion = false) => {
    const questionRow = buildSwitchboardDashboard([{ id: 'question', provider: 'codex', lifecycleRunning: true,
      agentActivityAtMs: now, awaitingUserInput: question, latestUserQuestionAtMs: now }], [], now).threads[0];
    return { providers: [], threads: [
      { id: 'native', state: 'working', nativeUnread: native, readStatus: native ? 'unread' : 'read' },
      { id: 'completion', state: completion ? 'idle' : 'working', nativeUnread: false, completionAtMs: completion ? now : 0 },
      questionRow,
    ] };
  };
  const existing = await tracker.observe(board());
  assert.equal(existing.persistentUnread, false);
  await tracker.setPinned('native', true);
  await tracker.setPersistentUnread(true, existing);
  const completed = await tracker.observe(board(true, true, true));
  assert.deepEqual(completed.threads.map((row) => row.retainedUnreadSource), ['native-unread', 'observed-completion', 'user-question']);
  assert.ok(completed.threads.every((row) => row.retainedUnread && !row.manualUnread));
  assert.deepEqual(completed.threads.map((row) => [row.state, row.unread, row.pending, row.pendingSource]),
    [['working', false, false, ''], ['idle', true, true, 'observed-completion'], ['working', false, true, 'user-question']]);
  const clearedSource = await tracker.observe(board(false, false, true));
  assert.deepEqual(clearedSource.threads.map((row) => [row.unread, row.pending]), [[false, false], [true, true], [false, false]]);
  assert.ok(clearedSource.threads.every((row) => row.retainedUnread));
  assert.equal(clearedSource.threads[0].nativeUnread, false);
  assert.equal(clearedSource.threads[0].nativeAttention, false);
  assert.equal(clearedSource.threads[2].questionAttention, false);
  const restarted = new PendingTracker(statePath);
  const restored = await restarted.observe(board(false, false, true));
  assert.equal(restored.persistentUnread, true);
  assert.deepEqual(restored.pinnedOrder, ['native']);
  assert.ok(restored.threads.every((row) => row.retainedUnread));
  const before = await stat(statePath);
  const content = await readFile(statePath, 'utf8');
  await restarted.observe(board(false, false, true));
  await restarted.observe(board(false, false, true));
  assert.equal(await readFile(statePath, 'utf8'), content);
  assert.equal((await stat(statePath)).ino, before.ino);
  assert.equal((await stat(statePath)).mtimeMs, before.mtimeMs);
  await restarted.setPersistentUnread(false, restored);
  assert.ok(restored.threads.every((row) => row.retainedUnread));
  assert.equal((await new PendingTracker(statePath).observe(board(false, false, true))).persistentUnread, false);
});

test('persistent native attention promotes new question and completion sources without relatching acknowledged events', async () => {
  const tracker = new PendingTracker(false);
  const board = ({ question = false, completion = 0, native = true, running = true } = {}) => buildSwitchboardDashboard([
    { id, provider: 'codex', nativeUnread: native, lifecycleRunning: running, agentActivityAtMs: now,
      awaitingUserInput: question, latestUserQuestionAtMs: question ? now + 1 : 0, latestAgentFinalAtMs: completion },
  ], [], now + 10);
  const first = await tracker.observe(board());
  await tracker.setPersistentUnread(true, first);
  assert.equal(first.threads[0].retainedUnreadSource, 'native-unread');
  assert.equal((await tracker.observe(board({ question: true }))).threads[0].retainedUnreadSource, 'user-question');
  const resolved = (await tracker.observe(board())).threads[0];
  assert.equal(resolved.state, 'working');
  assert.equal(resolved.pending, false);
  assert.equal(resolved.unread, false);
  assert.equal(resolved.retainedUnreadSource, 'user-question');
  await tracker.acknowledge(id);
  const read = (await tracker.observe(board({ question: true }))).threads[0];
  assert.equal(read.unread, false);
  assert.equal(read.pending, false);
  await tracker.observe(board({ native: false }));
  assert.equal((await tracker.observe(board())).threads[0].retainedUnreadSource, 'native-unread');
  assert.equal((await tracker.observe(board({ completion: now + 2, running: false }))).threads[0].retainedUnreadSource, 'observed-completion');
  assert.equal((await tracker.observe(board({ completion: now + 2 }))).threads[0].pending, false);
  assert.equal((await tracker.observe(board({ completion: now + 2, running: false }))).threads[0].pending, true);
});

test('Read clears persistent attention without changing execution, and only new source events add it again', async () => {
  const tracker = new PendingTracker(false);
  const board = (native = true, completion = 0, questionAt = now) => buildSwitchboardDashboard([
    { id: 'native', provider: 'codex', nativeUnread: native, lifecycleRunning: true, agentActivityAtMs: now,
      latestAgentFinalAtMs: completion },
    { id: 'question', provider: 'codex', nativeUnread: false, lifecycleRunning: true, agentActivityAtMs: now,
      awaitingUserInput: true, latestUserQuestionAtMs: questionAt, userQuestionBlocking: true, latestBlockingQuestionAtMs: questionAt },
    { id: 'completion', provider: 'codex', nativeUnread: false, lifecycleRunning: !completion, agentActivityAtMs: now,
      latestAgentFinalAtMs: completion },
  ], [], now + 10);
  const existing = await tracker.observe(board());
  await tracker.setPersistentUnread(true, existing);
  await tracker.observe(board(true, now + 1));
  for (const identity of ['native', 'question', 'completion']) await tracker.acknowledge(identity);
  const read = await tracker.observe(board(true, now + 1));
  assert.ok(read.threads.every((row) => !row.unread && !row.retainedUnread && !row.questionAttention));
  assert.deepEqual(read.threads.map((row) => row.state), ['working', 'waiting', 'idle']);
  assert.equal(read.threads[0].nativeUnread, true);
  assert.equal(read.threads[1].questionPending, true);
  await tracker.observe(board(false, now + 1));
  const newNative = await tracker.observe(board(true, now + 1));
  assert.equal(newNative.threads[0].retainedUnreadSource, 'native-unread');
  const newQuestion = await tracker.observe(board(true, now + 1, now + 2));
  assert.equal(newQuestion.threads[1].retainedUnreadSource, 'user-question');
  await tracker.acknowledge('native');
  assert.equal((await tracker.observe(board(true, now + 3, now + 2))).threads[0].retainedUnread, true);
  await tracker.acknowledge('completion');
  await tracker.observe(board(true, 0, now + 2));
  assert.equal((await tracker.observe(board(true, now + 4, now + 2))).threads[2].retainedUnreadSource, 'observed-completion');
});

test('ASB unread settings seed cached dots, preserve them on open, and restore open acknowledgments when disabled', async (t) => {
  const tracker = new PendingTracker(false);
  let native = true;
  let loads = 0;
  const server = createSwitchboardServer({ pendingTracker: tracker,
    loadDashboard: async () => { loads += 1; return { providers: [], threads: [{ id, state: 'unknown', nativeUnread: native,
      canOpen: true, provider: 'codex', appDeepLink: `codex://threads/${id}` }] }; }, openThread: async () => ({ opened: true }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(body) }).then((response) => response.json());
  const scan = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  assert.equal((await scan()).threads[0].unread, true);
  native = false;
  const enabled = await post('/api/settings/unread', { persistentUnread: true });
  assert.equal(loads, 1);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.persistentUnread, true);
  assert.equal(enabled.dashboard.threads[0].retainedUnread, true);
  assert.equal((await scan()).threads[0].nativeUnread, false);
  await post(`/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, true);
  const read = await post(`/api/threads/${id}/mark-read`);
  assert.equal(read.changed, true);
  assert.equal(read.thread.unread, false);
  assert.equal(read.thread.state, 'unknown');
  await post(`/api/threads/${id}/mark-unread`);
  await post(`/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].manualUnread, true);
  const disabled = await post('/api/settings/unread', { persistentUnread: false });
  assert.equal(disabled.dashboard.threads[0].unread, true);
  await post(`/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, false);
});

test('ASB unread routes require a local origin, exact bodies, known IDs, and POST', async (t) => {
  const server = createSwitchboardServer({ pendingStatePath: false, loadDashboard: async () => ({ providers: [], threads: [{ id, state: 'idle', nativeUnread: false }] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = '/api/settings/unread';
  const read = `/api/threads/${id}/mark-read`;
  const post = (route, body, headers = { Origin: base }) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  for (const route of [settings, read]) {
    assert.equal((await fetch(`${base}${route}`)).status, 405);
    assert.equal((await post(route, {}, {})).status, 403);
    assert.equal((await post(route, {}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(route, {}, { Origin: base, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const request = http.request(`${base}${route}`, { method: 'POST', headers: { Origin: base, Host: 'attacker.test' } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(wrongHost, 403);
  }
  for (const body of [{}, [], null, { persistentUnread: 'true' }, { persistentUnread: 1 }, { persistentUnread: true, extra: true }]) {
    assert.equal((await post(settings, body)).status, 400);
  }
  for (const body of [[], null, { read: true }, { command: 'bad' }]) assert.equal((await post(read, body)).status, 400);
  assert.equal((await post('/api/threads/missing/mark-read', {})).status, 404);
  assert.equal((await post(settings, { persistentUnread: true })).status, 200);
  assert.equal((await post(read, {})).status, 200);
});

test('only successful stored-session opens acknowledge fallback Pending', async (t) => {
  const tracker = new PendingTracker(false);
  await tracker.observe({ providers: [], threads: [{ id, state: 'working', nativeUnread: null, completionAtMs: 0 }] });
  let result = 'failed';
  const server = createSwitchboardServer({ pendingTracker: tracker,
    loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', state: 'idle', nativeUnread: null, completionAtMs: 200, canOpen: true, appDeepLink: `codex://threads/${id}` }] }),
    openThread: async () => { if (result === 'throw') throw new Error('Mock open failed'); return { opened: result === 'success' }; },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = async () => (await (await fetch(`${base}/api/dashboard`)).json()).threads[0].pending;
  const open = () => fetch(`${base}/api/threads/${id}/open`, { method: 'POST', headers: { Origin: base }, body: '{}' });
  assert.equal(await pending(), true);
  await open();
  assert.equal(await pending(), true);
  result = 'throw';
  assert.equal((await open()).status, 500);
  assert.equal(await pending(), true);
  result = 'success';
  assert.equal((await open()).status, 200);
  assert.equal(await pending(), false);
});

test('manual unread has one stored-session action, persists over native reads, and clears only after a successful open', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = () => ({ providers: [], threads: [
    { id, provider: 'codex', state: 'idle', nativeUnread: false, canOpen: true, appDeepLink: `codex://threads/${id}` },
    { id: 'working', state: 'working', nativeUnread: false },
    { id: 'unknown', state: 'unknown', nativeUnread: null },
  ] });
  let opened = false;
  const server = createSwitchboardServer({ pendingTracker: tracker, loadDashboard: async () => board(),
    openThread: async () => ({ opened }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `${base}/api/threads/${id}/mark-unread`;
  const post = (url, headers = { Origin: base }, body = '{}') => fetch(url, { method: 'POST', headers, body });
  assert.equal((await fetch(route)).status, 405);
  assert.equal((await post(route, {})).status, 403);
  assert.equal((await post(route, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(route, { Origin: base, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request(route, { method: 'POST', headers: { Origin: base, Host: 'attacker.test' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal((await post(`${base}/api/threads/missing/mark-unread`)).status, 404);
  assert.equal((await post(route, { Origin: base }, '{"command":"bad","url":"https://example.com"}')).status, 400);
  assert.equal((await post(route)).status, 200);
  const scan = () => fetch(`${base}/api/dashboard?force=1`).then((response) => response.json());
  let dashboard = await scan();
  assert.equal(dashboard.threads[0].pendingSource, 'manual-unread');
  assert.equal(dashboard.threads[0].nativeUnread, false);
  assert.equal(dashboard.threads[0].unread, true);
  await post(`${base}/api/threads/working/mark-unread`);
  await post(`${base}/api/threads/unknown/mark-unread`);
  dashboard = await scan();
  assert.deepEqual(dashboard.threads.map((row) => [row.state, row.pending, row.unread]), [['idle', true, true], ['working', false, false], ['unknown', true, true]]);
  const restarted = new PendingTracker(statePath);
  assert.ok((await restarted.observe(board())).threads.every((row) => row.manualUnread));
  await post(`${base}/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, true);
  opened = true;
  await post(`${base}/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, false);
  assert.equal((await new PendingTracker(statePath).observe(board())).threads[0].manualUnread, false);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(statePath, 'utf8'))).includes('provider'));
});

test('ASB pins persist independently, use the full order, and reject unsafe local actions', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const rows = ['a', 'hidden', 'b', 'read', 'native-pin'].map((value) => ({ id: value, state: 'idle', nativeUnread: false, pinned: value === 'native-pin' }));
  const board = () => ({ providers: [], threads: structuredClone(rows) });
  const tracker = new PendingTracker(statePath);
  const server = createSwitchboardServer({ pendingTracker: tracker, loadDashboard: async () => board() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (identity, action, body = {}, origin = base) => fetch(`${base}/api/threads/${identity}/${action}`, {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body),
  });
  const scan = () => fetch(`${base}/api/dashboard`).then((result) => result.json());
  assert.ok((await scan()).threads.every((row) => !row.pinned));
  for (const value of ['a', 'hidden', 'b']) assert.equal((await post(value, 'pin')).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['a', 'hidden', 'b']);
  assert.equal((await post('a', 'move-pin', { targetId: 'b', placement: 'after' })).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['hidden', 'b', 'a']);
  assert.equal((await post('a', 'move-pin', { direction: 'up' })).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['hidden', 'a', 'b']);
  assert.equal((await post('hidden', 'unpin')).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['a', 'b']);
  const restarted = await new PendingTracker(statePath).observe(board());
  assert.deepEqual(restarted.pinnedOrder, ['a', 'b']);
  assert.deepEqual(restarted.threads.filter((row) => row.pinned).map((row) => [row.id, row.pinIndex]), [['a', 0], ['b', 1]]);
  assert.equal((await fetch(`${base}/api/threads/a/pin`)).status, 405);
  assert.equal((await post('a', 'pin', {}, 'https://example.com')).status, 403);
  assert.equal((await post('unknown', 'pin')).status, 404);
  assert.equal((await post('a', 'pin', { command: 'bad' })).status, 400);
  assert.equal((await post('a', 'move-pin', { targetId: 'unknown', placement: 'before' })).status, 404);
  assert.equal((await post('a', 'move-pin', { targetId: 'read', placement: 'before' })).status, 400);
  assert.equal((await post('read', 'move-pin', { direction: 'up' })).status, 400);
  assert.equal((await post('a', 'move-pin', { direction: 'left' })).status, 400);
  assert.deepEqual((await scan()).pinnedOrder, ['a', 'b']);
});

const questionCall = (name, callId, count = 1) => ({ type: 'response_item', timestamp: new Date(now).toISOString(), payload: {
  type: 'function_call', name, call_id: callId, arguments: JSON.stringify({ questions: Array.from({ length: count }, () => ({ title: 'PRIVATE QUESTION BODY' })) }),
} });
const questionOutput = (callId, value) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(value) } });
const questionReply = (callId, index) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text:
  `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', callId, index]), question: 'PRIVATE QUESTION BODY', answer: 'PRIVATE ANSWER BODY' }])}</send_user_message_question_reply>`,
}] } });

test('Codex user-question events track sync resolution and all async answers, never ordinary prose', async (t) => {
  const sync = questionCall('functions.request_user_input', 'sync');
  assert.equal(parseRolloutSignals(jsonl([sync])).awaitingUserInput, true);
  assert.equal(parseRolloutSignals(jsonl([sync, questionOutput('sync', { answers: {} })])).awaitingUserInput, false);
  const events = [questionCall('request_user_input_async', 'async', 3), questionOutput('async', { accepted: true }),
    { timestamp: new Date(now + 1).toISOString(), payload: { type: 'task_complete' } }];
  assert.equal(parseRolloutSignals(jsonl(events)).awaitingUserInput, true);
  events.push(questionReply('async', 0), questionReply('async', 1));
  assert.equal(parseRolloutSignals(jsonl(events)).awaitingUserInput, true);
  const tracker = new PendingTracker(false);
  const signals = parseRolloutSignals(jsonl(events));
  const dashboard = await tracker.observe(buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: false, readStatus: 'read',
    lifecycleRunning: signals.agentRunning, ...signals }], [], now));
  assert.equal(dashboard.threads[0].state, 'idle');
  assert.equal(dashboard.threads[0].questionPending, true);
  assert.equal(dashboard.threads[0].pendingSource, 'user-question');
  assert.ok(!JSON.stringify(dashboard).includes('PRIVATE'));
  await tracker.acknowledge(id);
  tracker.apply(dashboard.threads[0]);
  assert.equal(dashboard.threads[0].pending, false);
  const questionServer = createSwitchboardServer({ pendingTracker: tracker,
    loadDashboard: async () => buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: false, readStatus: 'read',
      lifecycleRunning: signals.agentRunning, ...signals }], [], now), openThread: async () => ({ opened: true }),
  });
  await new Promise((resolve) => questionServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { questionServer.closeAllConnections(); return new Promise((resolve) => questionServer.close(resolve)); });
  const questionBase = `http://127.0.0.1:${questionServer.address().port}`;
  assert.equal((await fetch(`${questionBase}/api/threads/${id}/open`, { method: 'POST', headers: { Origin: questionBase }, body: '{}' })).status, 200);
  const afterOpen = await (await fetch(`${questionBase}/api/dashboard?force=1`)).json();
  assert.equal(afterOpen.threads[0].questionPending, true);
  assert.equal(afterOpen.threads[0].pending, false);
  assert.equal(afterOpen.threads[0].state, 'idle');
  events.push(questionReply('async', 2));
  assert.equal(parseRolloutSignals(jsonl(events)).awaitingUserInput, false);
  for (const type of ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled']) {
    assert.equal(parseRolloutSignals(jsonl([sync, { payload: { type } }])).awaitingUserInput, false);
  }
  assert.equal(parseRolloutSignals(jsonl([questionCall('request_user_input_async', 'failed'), questionOutput('failed', { accepted: false })])).awaitingUserInput, false);
  assert.equal(parseRolloutSignals(jsonl([{ payload: { type: 'agent_message', message: 'Can you answer this?' } },
    questionCall('functions.exec', 'ordinary')])).awaitingUserInput, false);
  const dir = await temp(t);
  const rollout = path.join(dir, 'questions.jsonl');
  await writeFile(rollout, jsonl(events.slice(0, 3)) + '\n' + jsonl(Array.from({ length: 200 }, () => ({ payload: { type: 'agent_message', message: 'x'.repeat(1000) } }))) + '\n');
  const options = { initialBytes: 1024, maxBytes: 2048 };
  assert.equal((await readRolloutSignals(rollout, options)).awaitingUserInput, true);
  await writeFile(rollout, jsonl([questionReply('async', 0), questionReply('async', 1)]) + '\n', { flag: 'a' });
  assert.equal((await readRolloutSignals(rollout, options)).awaitingUserInput, true);
  await writeFile(rollout, jsonl([questionReply('async', 2)]), { flag: 'a' });
  assert.equal((await readRolloutSignals(rollout, options)).awaitingUserInput, false);
});

test('Codex human resumption supersedes old questions while goal work and partial replies preserve attention', async (t) => {
  const lifecycle = (type, at) => ({ timestamp: new Date(at).toISOString(), payload: { type } });
  const user = (message, at, extra = {}) => ({ timestamp: new Date(at).toISOString(), payload: { type: 'user_message', message, ...extra } });
  const async = [questionCall('request_user_input_async', 'resume', 3), questionOutput('resume', { accepted: true })];
  const status = (events) => {
    const signals = parseRolloutSignals(jsonl(events));
    return { signals, row: buildSwitchboardDashboard([{ id, provider: 'codex', lifecycleRunning: signals.agentRunning, ...signals }], [], now).threads[0] };
  };
  for (const message of ['ok', 'yes', 'go']) {
    const current = status([...async, lifecycle('task_complete', now + 1), lifecycle('task_started', now + 2), user(message, now + 3)]);
    assert.equal(current.signals.awaitingUserInput, false);
    assert.equal(current.row.state, 'working');
    assert.equal(status([...async, user(message, now + 1), lifecycle('task_complete', now + 2)]).row.state, 'idle');
  }
  const automatic = [...async, lifecycle('task_complete', now + 1), lifecycle('task_started', now + 2), user(
    '<codex_internal_context source="goal">Continue working toward the active thread goal.</codex_internal_context>', now + 3,
    { internal_chat_message_metadata_passthrough: { content_item_kinds: ['goal.internal_context'] } }), questionReply('resume', 0)];
  assert.equal(status(automatic).signals.awaitingUserInput, true);
  assert.equal(status(automatic).row.state, 'working');
  assert.equal(status([...automatic, questionReply('resume', 1)]).signals.awaitingUserInput, true);
  assert.equal(status([...automatic, questionReply('resume', 1), questionReply('resume', 2)]).signals.awaitingUserInput, false);
  const blocking = status([lifecycle('task_started', now - 1), questionCall('functions.request_user_input', 'blocking')]);
  assert.equal(blocking.row.state, 'waiting');
  assert.equal(status([lifecycle('task_started', now - 1), questionCall('functions.request_user_input', 'blocking'), lifecycle('task_complete', now + 1)]).row.state, 'idle');
  const oldSync = { ...questionCall('request_user_input', 'old-sync'), timestamp: new Date(now - 1000).toISOString() };
  assert.equal(status([oldSync, lifecycle('task_complete', now - 800), lifecycle('task_started', now - 600),
    questionCall('request_user_input_async', 'new-async'), questionOutput('new-async', { accepted: true })]).row.state, 'working');
  const ambient = { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text:
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['additional_content.codex_apps_open_page'] } } };
  assert.equal(status([...automatic, ambient, questionReply('resume', 1)]).signals.awaitingUserInput, true);
  const dir = await temp(t);
  const rollout = path.join(dir, 'resume.jsonl');
  const padding = jsonl(Array.from({ length: 100 }, () => ({ payload: { type: 'agent_message', message: 'x'.repeat(1000) } })));
  await writeFile(rollout, jsonl([...async, lifecycle('task_complete', now + 1), lifecycle('task_started', now + 2), user('ok', now + 3)]) + '\n' + padding + '\n');
  const signals = await readRolloutSignals(rollout, { initialBytes: 1024, maxBytes: 2048 });
  assert.equal(signals.awaitingUserInput, false);
  assert.equal(signals.agentRunning, true);
});

test('successful ASB opens acknowledge question/native attention without changing execution, and acknowledgment survives refresh/restart', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const events = [questionCall('request_user_input_async', 'attention'), questionOutput('attention', { accepted: true }),
    { timestamp: new Date(now + 1).toISOString(), payload: { type: 'task_started' } }];
  const signals = parseRolloutSignals(jsonl(events));
  let native = true;
  let completion = 0;
  const board = () => buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: native, readStatus: native ? 'unread' : 'read',
    lifecycleRunning: signals.agentRunning, ...signals, latestAgentFinalAtMs: completion }], [], now + 2);
  const tracker = new PendingTracker(statePath);
  let opened = false;
  const server = createSwitchboardServer({ pendingTracker: tracker, loadDashboard: async () => board(), openThread: async () => ({ opened }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = () => fetch(`${base}/api/dashboard?force=1`).then((response) => response.json()).then((dashboard) => dashboard.threads[0]);
  const open = () => fetch(`${base}/api/threads/${id}/open`, { method: 'POST', headers: { Origin: base }, body: '{}' });
  let row = await scan();
  assert.equal(row.state, 'working');
  assert.equal(row.questionAttention, true);
  assert.equal(row.nativeAttention, true);
  await open();
  assert.equal((await scan()).questionAttention, true);
  opened = true;
  await open();
  row = await scan();
  assert.equal(row.state, 'working');
  assert.equal(row.questionPending, true);
  assert.equal(row.questionAttention, false);
  assert.equal(row.nativeUnread, true);
  assert.equal(row.nativeAttention, false);
  assert.equal(row.unread, false);
  assert.equal(row.pending, false);
  assert.ok(!JSON.stringify(row).includes('latestUserQuestionAtMs'));
  const restarted = await new PendingTracker(statePath).observe(board());
  assert.equal(restarted.threads[0].questionAttention, false);
  assert.equal(restarted.threads[0].nativeAttention, false);
  native = false; await scan(); native = true;
  assert.equal((await scan()).nativeAttention, true);
  await open(); completion = now + 3;
  assert.equal((await scan()).nativeAttention, true);
  const sync = parseRolloutSignals(jsonl([questionCall('request_user_input', 'sync-ack')]));
  const syncBoard = buildSwitchboardDashboard([{ id: 'sync', provider: 'codex', ...sync }], [], now);
  const syncTracker = new PendingTracker(false);
  await syncTracker.observe(syncBoard);
  await syncTracker.acknowledge('sync'); syncTracker.apply(syncBoard.threads[0]);
  assert.equal(syncBoard.threads[0].state, 'waiting');
  assert.equal(syncBoard.threads[0].questionAttention, false);
  const completionTracker = new PendingTracker(false);
  const completionBoard = () => buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: null,
    lifecycleRunning: signals.agentRunning, ...signals }], [], now + 2);
  await completionTracker.observe(completionBoard());
  await completionTracker.acknowledge(id);
  const ended = parseRolloutSignals(jsonl([...events,
    { timestamp: new Date(now + 4).toISOString(), payload: { type: 'task_complete' } }]));
  const completed = await completionTracker.observe(buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: null,
    lifecycleRunning: ended.agentRunning, ...ended }], [], now + 5));
  assert.equal(completed.threads[0].questionPending, true);
  assert.equal(completed.threads[0].questionAttention, false);
  assert.equal(completed.threads[0].state, 'idle');
  assert.equal(completed.threads[0].completionAttention, true);
  assert.equal(completed.threads[0].unread, true);
});

test('terminal Codex errors survive cached lifecycle reads and resolve questions without exposing error text', async (t) => {
  const dir = await temp(t);
  const rollout = path.join(dir, 'rollout-synthetic.jsonl');
  const event = (type, offset, extra = {}) => ({ timestamp: new Date(now + offset).toISOString(), payload: { type, ...extra } });
  const events = [event('task_started', -100), questionCall('request_user_input_async', 'terminal-question'),
    event('task_complete', 10, { error: { message: 'Synthetic failure text', codex_error_info: 'other' } })];
  const parsed = parseRolloutSignals(jsonl(events));
  assert.deepEqual([parsed.agentRunning, parsed.latestLifecycleKind, parsed.awaitingUserInput], [false, 'failed', false]);
  await writeFile(rollout, jsonl(events) + '\n');
  const cached = await readRolloutSignals(rollout, { initialBytes: 32 });
  assert.deepEqual([cached.agentRunning, cached.latestLifecycleKind, cached.latestLifecycleAtMs], [false, 'failed', now + 10]);
  const historical = (await new PendingTracker(false).observe(buildSwitchboardDashboard([
    { id, provider: 'codex', nativeUnread: null, lifecycleRunning: cached.agentRunning, ...cached },
  ], [], now + 10))).threads[0];
  assert.deepEqual([historical.state, historical.lastOutcome, historical.unread, historical.pending], ['idle', 'failed', false, false]);
  await writeFile(rollout, jsonl([event('task_started', 20), event('task_complete', 30, { error: null })]) + '\n', { flag: 'a' });
  const success = await readRolloutSignals(rollout, { initialBytes: 32 });
  assert.equal(success.latestLifecycleKind, 'task_complete');
  assert.equal(success.latestLifecycleAtMs, now + 30);
  await writeFile(rollout, jsonl([event('task_started', 40)]) + '\n', { flag: 'a' });
  const nextTask = await readRolloutSignals(rollout, { initialBytes: 32 });
  assert.deepEqual([nextTask.latestTaskStartedAtMs, nextTask.latestTaskEndedAtMs, nextTask.latestTaskEndKind], [now + 40, now + 30, 'task_complete']);
});

test('observed failed attention follows native read truth, acknowledgment and Persistent unread', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const board = (state, nativeUnread = null, at = now) => ({ providers: [], threads: [{ id, state, nativeUnread,
    completionAtMs: 0, failedAtMs: state === 'idle' ? at : 0, lastOutcome: state === 'idle' ? 'failed' : '' }] });
  const tracker = new PendingTracker(statePath);
  await tracker.observe(board('working'));
  const failed = await tracker.observe(board('idle'));
  assert.deepEqual([failed.threads[0].failedAttention, failed.threads[0].completionAttention, failed.threads[0].pendingSource],
    [true, false, 'observed-failure']);
  const restart = new PendingTracker(statePath);
  assert.equal((await restart.observe(board('idle'))).threads[0].failedAttention, true);
  await restart.setPersistentUnread(true, failed);
  const retained = (await restart.observe(board('working'))).threads[0];
  assert.deepEqual([retained.retainedUnreadSource, retained.unread, retained.pending], ['observed-failure', false, false]);
  assert.equal((await restart.observe(board('idle', null, now + 1))).threads[0].failedAttention, true);
  await restart.acknowledge(id);
  assert.equal((await restart.observe(board('idle', null, now + 1))).threads[0].pending, false);
  const saved = await readFile(statePath, 'utf8');
  assert.doesNotMatch(saved, /title|message|rollout|Synthetic/);
  for (const nativeUnread of [true, false]) {
    const native = new PendingTracker(false);
    await native.observe(board('working', nativeUnread));
    const row = (await native.observe(board('idle', nativeUnread))).threads[0];
    assert.equal(row.failedAttention, false);
    assert.equal(row.pending, nativeUnread);
  }
});

test('the last Codex group end sets failure or stop, while active work and later ends take priority', async () => {
  const childId = id.replace(/0$/, '1');
  const root = { id, provider: 'codex', nativeUnread: null, lifecycleRunning: false, latestLifecycleKind: 'task_complete', latestLifecycleAtMs: now - 100 };
  const child = { id: childId, provider: 'codex', parentThreadId: id, isSubagent: true, threadSource: 'subagent', lifecycleRunning: false,
    latestLifecycleKind: 'failed', latestLifecycleAtMs: now };
  const row = (rootExtra = {}, childExtra = {}) => buildSwitchboardDashboard([{ ...root, ...rootExtra }, { ...child, ...childExtra }], [], now + 100).threads[0];
  assert.deepEqual([row().state, row().lastOutcome, row().failedAtMs], ['idle', 'failed', now]);
  const rootQuestion = row({ awaitingUserInput: true, latestUserQuestionAtMs: now - 10 });
  assert.equal(rootQuestion.questionPending, true);
  const active = row({ lifecycleRunning: true, agentActivityAtMs: now + 50, latestLifecycleKind: 'task_started', latestLifecycleAtMs: now + 50 });
  assert.deepEqual([active.state, active.lastOutcome, active.failedAtMs], ['working', '', 0]);
  const completed = row({ latestLifecycleAtMs: now + 100 });
  assert.deepEqual([completed.state, completed.lastOutcome, completed.completionAtMs], ['idle', '', now + 100]);
  const stopped = row({ latestLifecycleKind: 'turn_aborted', latestLifecycleAtMs: now + 100 });
  assert.deepEqual([stopped.state, stopped.lastOutcome, stopped.completionAtMs, stopped.failedAtMs], ['idle', 'stopped', 0, 0]);
  const historical = (await new PendingTracker(false).observe({ providers: [], threads: [stopped] })).threads[0];
  assert.deepEqual([historical.unread, historical.pending], [false, false]);
});

test('fresh remote permission waits keep attention after Read and stale waits give Unknown', async () => {
  const thread = { id: 'claude-desktop-code:cse_example', externalId: 'cse_example', provider: 'claude-desktop-code',
    source: 'claude-remote-cache', remoteObservedAtMs: now, remoteEnvironmentKind: 'anthropic_cloud',
    remoteSessionStatus: 'active', remoteWorkerStatus: 'requires_action', nativeUnread: true };
  const tracker = new PendingTracker(false);
  const scan = (extra = {}, clock = now) => tracker.observe(buildSwitchboardDashboard([{ ...thread, ...extra }], [], clock));
  const waiting = (await scan()).threads[0];
  assert.deepEqual([waiting.state, waiting.actionRequired, waiting.pending], ['waiting', true, true]);
  await tracker.acknowledge(waiting.id);
  const read = (await scan()).threads[0];
  assert.deepEqual([read.unread, read.actionRequired, read.pending], [false, true, true]);
  assert.equal((await scan({ remoteWorkerStatus: 'idle' })).threads[0].pending, false);
  const stale = (await scan({}, now + 7 * 3_600_000)).threads[0];
  assert.deepEqual([stale.state, stale.actionRequired, stale.pending], ['unknown', false, false]);
});

test('browser rows show question, unread, then stop and name the actual end outcome', async () => {
  const node = () => ({ value: 'all', checked: false, dataset: {}, children: [], attributes: {},
    addEventListener() {}, setAttribute(key, value) { this.attributes[key] = value; },
    append(...children) { this.children.push(...children); }, replaceChildren() {}, querySelectorAll() { return []; } });
  const nodes = Object.fromEntries(['search', 'app', 'status', 'archive', 'refresh', 'count', 'updated', 'notice', 'sessions'].map((key) => [key, node()]));
  nodes.search.value = '';
  const document = { hidden: true, getElementById: (key) => nodes[key], addEventListener() {}, createElement: node,
    createDocumentFragment: node };
  const context = vm.createContext({ document, window: { addEventListener() {} }, clearTimeout() {}, setTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ generatedAtMs: now, providers: [], threads: [] }) }) });
  vm.runInContext(await readFile(new URL('../public/switchboard.js', import.meta.url), 'utf8'), context);
  for (const [extra, indicator, text] of [[{ lastOutcome: 'stopped' }, 'stop', 'Task stopped.'],
    [{ lastOutcome: 'stopped', unread: true }, 'dot', 'Task stopped.'],
    [{ lastOutcome: 'failed', unread: true, failedAttention: true }, 'dot', 'Task failed.'],
    [{ actionRequired: true, unread: true, questionAttention: true }, 'question', 'A user action is required in the original app.'],
    [{ questionAttention: true }, 'question', 'A question needs your answer.'],
    [{ completionAttention: true, unread: true }, 'dot', 'Task completed.']]) {
    context.rowData = { id, title: 'Synthetic', providerLabel: 'Codex', state: 'idle', canOpen: false, ...extra };
    const row = vm.runInContext('sessionRow(rowData)', context);
    assert.equal(row.children[1].className, `attention ${indicator}`);
    assert.ok(row.attributes['aria-label'].includes(text));
    assert.ok(row.title.includes(text));
  }
  context.rowData = { id, title: 'Synthetic', providerLabel: 'Codex', state: 'working', canOpen: false, unread: false, lastOutcome: '' };
  assert.equal(vm.runInContext('sessionRow(rowData)', context).children.length, 1);
});

const discardEvent = (type, offset, extra = {}) => ({ timestamp: new Date(now + offset).toISOString(), payload: { type, ...extra } });
function discardThread(events, extra = {}) {
  const signals = parseRolloutSignals(jsonl(events));
  return { id, provider: 'codex', nativeUnread: null, ...signals, lifecycleRunning: signals.agentRunning, ...extra };
}
const discardBoard = (events, extra = {}, children = []) => buildSwitchboardDashboard([discardThread(events, extra), ...children], [], now + 1000);

test('Discard is one shot and suppresses only the armed successful end, including Persistent unread', async () => {
  for (const persistent of [false, true]) for (const nativeUnread of [null, false, true]) {
    const tracker = new PendingTracker(false);
    const events = [discardEvent('task_started', 0)];
    const working = await tracker.observe(discardBoard(events, { nativeUnread }));
    await tracker.setPersistentUnread(persistent, working);
    await tracker.setDiscard(working.threads[0], true);
    assert.deepEqual([working.threads[0].discardResult, working.threads[0].unread, working.threads[0].pending], [true, false, false]);
    events.push(discardEvent('task_complete', 10));
    const ended = (await tracker.observe(discardBoard(events, { nativeUnread }))).threads[0];
    assert.deepEqual([ended.state, ended.discardResult, ended.unread, ended.pending, ended.retainedUnread], ['idle', false, false, false, false]);
    assert.equal(ended.nativeUnread, nativeUnread);
    events.push(discardEvent('task_started', 20));
    assert.equal((await tracker.observe(discardBoard(events, { nativeUnread }))).threads[0].discardResult, false);
    events.push(discardEvent('task_complete', 30));
    const next = (await tracker.observe(discardBoard(events, { nativeUnread }))).threads[0];
    assert.equal(next.pending, nativeUnread !== false || persistent);
  }
});

test('Discard preserves failed, question and manual attention and cancellation stays passive', async () => {
  for (const persistent of [false, true]) {
    const tracker = new PendingTracker(false);
    const events = [discardEvent('task_started', -100)];
    const working = await tracker.observe(discardBoard(events));
    await tracker.setPersistentUnread(persistent, working);
    await tracker.setDiscard(working.threads[0], true);
    events.push(questionCall('request_user_input_async', 'discard-question'));
    const question = (await tracker.observe(discardBoard(events))).threads[0];
    assert.deepEqual([question.discardResult, question.questionAttention, question.pending, question.unread], [true, true, true, false]);
    events.push(discardEvent('task_complete', 10, { error: { message: 'Synthetic error' } }));
    const failed = (await tracker.observe(discardBoard(events))).threads[0];
    assert.deepEqual([failed.discardResult, failed.failedAttention, failed.pending, failed.lastOutcome], [false, true, true, 'failed']);
    events.push(discardEvent('task_started', 20));
    const again = await tracker.observe(discardBoard(events));
    await tracker.setDiscard(again.threads[0], true);
    events.push(discardEvent('task_complete', 30));
    const keptFailure = (await tracker.observe(discardBoard(events))).threads[0];
    assert.equal(keptFailure.failedAttention, true);
    assert.equal(keptFailure.pending, true);
    await tracker.acknowledge(id);
    events.push(discardEvent('task_started', 40));
    const manual = await tracker.observe(discardBoard(events));
    await tracker.markUnread(id);
    await tracker.setDiscard(manual.threads[0], true);
    events.push(discardEvent('task_complete', 50));
    const manualEnd = (await tracker.observe(discardBoard(events))).threads[0];
    assert.deepEqual([manualEnd.manualUnread, manualEnd.unread, manualEnd.pending, manualEnd.discardResult], [true, true, true, false]);
    await tracker.acknowledge(id);
    events.push(discardEvent('task_started', 60));
    const stop = await tracker.observe(discardBoard(events));
    await tracker.setDiscard(stop.threads[0], true);
    events.push(discardEvent('turn_aborted', 70));
    const stopped = (await tracker.observe(discardBoard(events))).threads[0];
    assert.deepEqual([stopped.lastOutcome, stopped.pending, stopped.unread, stopped.discardResult], ['stopped', false, false, false]);
  }
});

test('Discard suppresses the first late native unread episode and preserves a later Read-to-Unread cycle', async () => {
  const tracker = new PendingTracker(false);
  const events = [discardEvent('task_started', 0)];
  const first = await tracker.observe(discardBoard(events, { nativeUnread: false }));
  await tracker.setPersistentUnread(true, first);
  await tracker.setDiscard(first.threads[0], true);
  events.push(discardEvent('task_complete', 10));
  assert.equal((await tracker.observe(discardBoard(events, { nativeUnread: false }))).threads[0].pending, false);
  const late = (await tracker.observe(discardBoard(events, { nativeUnread: true }))).threads[0];
  assert.deepEqual([late.nativeUnread, late.nativeAttention, late.unread, late.pending, late.retainedUnread], [true, false, false, false, false]);
  await tracker.observe(discardBoard(events, { nativeUnread: false }));
  const nextEpisode = (await tracker.observe(discardBoard(events, { nativeUnread: true }))).threads[0];
  assert.deepEqual([nextEpisode.nativeAttention, nextEpisode.pending], [true, true]);
});

test('Discard survives reload, Waiting and Unknown, validates numeric state, and clears on untimestamped Idle', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const working = await tracker.observe(discardBoard([discardEvent('task_started', -100)]));
  await tracker.setDiscard(working.threads[0], true);
  const restart = new PendingTracker(statePath);
  const waiting = await restart.observe(discardBoard([discardEvent('task_started', -100), questionCall('request_user_input', 'blocking-discard')]));
  assert.equal(waiting.threads[0].state, 'waiting');
  assert.equal(restart.records[id].discard, 1);
  const unknown = await restart.observe(buildSwitchboardDashboard([discardThread([discardEvent('task_started', -100)])], [], now + 7 * 3_600_000));
  assert.equal(unknown.threads[0].state, 'unknown');
  assert.equal(restart.records[id].discard, 1);
  const idle = (await restart.observe({ providers: [], threads: [{ id, state: 'idle', nativeUnread: true, completionAtMs: 0 }] })).threads[0];
  assert.deepEqual([restart.records[id].discard, idle.discardResult, idle.pending], [0, false, true]);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.version, 1);
  for (const key of ['discard', 'discardedAt', 'discardStart', 'discardEnd', 'discardNative']) assert.equal(typeof saved.records[id][key], 'number');
  saved.records[id].discard = '1'; saved.records[id].discardedAt = -1; saved.records[id].discardStart = 'private'; saved.records[id].discardNative = 3;
  await writeFile(statePath, JSON.stringify(saved));
  const invalid = new PendingTracker(statePath); await invalid.load();
  assert.deepEqual([invalid.records[id].discard, invalid.records[id].discardedAt, invalid.records[id].discardStart, invalid.records[id].discardNative], [0, 0, 0, 0]);
});

test('Discard follows the linked group, keeps a late first child, and does not carry through an end/start gap', async () => {
  const childId = id.replace(/0$/, '1');
  const child = (events, extra = {}) => discardThread(events, { id: childId, isSubagent: true, parentThreadId: id,
    threadSource: 'subagent', createdAtMs: now - 95, ...extra });
  const tracker = new PendingTracker(false);
  const rootEvents = [discardEvent('task_started', -100)];
  let childEvents = [discardEvent('task_started', -90)];
  const working = await tracker.observe(discardBoard(rootEvents, {}, [child(childEvents)]));
  await tracker.setDiscard(working.threads[0], true);
  rootEvents.push(discardEvent('task_complete', -80));
  const rootEnded = (await tracker.observe(discardBoard(rootEvents, {}, [child(childEvents)]))).threads[0];
  assert.deepEqual([rootEnded.state, rootEnded.workingSinceMs, rootEnded.discardResult], ['working', now - 90, true]);
  childEvents.push(discardEvent('task_complete', -70), discardEvent('task_started', -60));
  const gap = (await tracker.observe(discardBoard(rootEvents, {}, [child(childEvents)]))).threads[0];
  assert.deepEqual([gap.state, gap.discardResult, gap.pending], ['working', false, false]);
  childEvents.push(discardEvent('task_complete', -50));
  assert.equal((await tracker.observe(discardBoard(rootEvents, {}, [child(childEvents)]))).threads[0].completionAttention, true);

  const late = new PendingTracker(false);
  const openRoot = [discardEvent('task_started', 0)];
  const missing = child([], { createdAtMs: now + 1 });
  const initial = await late.observe(discardBoard(openRoot, {}, [missing]));
  await late.setDiscard(initial.threads[0], true);
  openRoot.push(discardEvent('task_complete', 10));
  assert.equal((await late.observe(discardBoard(openRoot, {}, [missing]))).threads[0].state, 'unknown');
  const lateChild = child([discardEvent('task_started', 20)], { createdAtMs: now + 1 });
  assert.equal((await late.observe(discardBoard(openRoot, {}, [lateChild]))).threads[0].discardResult, true);
  const noCreation = { ...lateChild, createdAtMs: 0 };
  assert.equal((await late.observe(discardBoard(openRoot, {}, [noCreation]))).threads[0].discardResult, true);
  openRoot.push(discardEvent('task_started', 30));
  assert.equal((await late.observe(discardBoard(openRoot, {}, [noCreation]))).threads[0].discardResult, false);

  const rootGap = new PendingTracker(false);
  const first = await rootGap.observe(discardBoard([discardEvent('task_started', 0)]));
  await rootGap.setDiscard(first.threads[0], true);
  const next = (await rootGap.observe(discardBoard([discardEvent('task_started', 0), discardEvent('task_complete', 10), discardEvent('task_started', 20)]))).threads[0];
  assert.deepEqual([next.state, next.discardResult, next.pending], ['working', false, false]);
});

test('Discard scans current Working evidence, Keep uses the cache, and both retain local action protection', async (t) => {
  const tracker = new PendingTracker(false);
  let state = 'working';
  let sourceError = false;
  const server = createSwitchboardServer({ pendingTracker: tracker, now: () => now, dashboardWatchPaths: [], loadDashboard: async () => {
    if (sourceError) throw new SyntaxError('Synthetic internal source error');
    return { providers: [], threads: [{ id, state, nativeUnread: null, completionAtMs: 0 },
      { id: 'idle', state: 'idle', nativeUnread: null, completionAtMs: 0 }] };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `${base}/api/threads/${id}/discard-result`;
  const post = (url = route, headers = { Origin: base }, body = '{}') => fetch(url, { method: 'POST', headers, body });
  assert.equal((await fetch(route)).status, 405);
  assert.equal((await post(route, {})).status, 403);
  assert.equal((await post(route, { Origin: 'https://example.com' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(route, { method: 'POST', headers: { Origin: base, Host: 'example.com' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(badHost, 403);
  const untouched = JSON.stringify(tracker.records);
  for (const body of ['null', '[]', '{"enabled":true}', '{broken']) {
    assert.equal((await post(route, { Origin: base }, body)).status, 400);
    assert.equal(JSON.stringify(tracker.records), untouched);
  }
  assert.equal((await post(`${base}/api/threads/missing/discard-result`)).status, 404);
  assert.equal((await post(`${base}/api/threads/idle/discard-result`)).status, 400);
  const armed = await (await post()).json();
  assert.deepEqual([armed.changed, armed.threadId, armed.thread.discardResult], [true, id, true]);
  const kept = await (await post(`${base}/api/threads/${id}/keep-result`)).json();
  assert.equal(kept.thread.discardResult, false);
  await tracker.markUnread(id);
  assert.equal((await post()).status, 200);
  state = 'idle';
  assert.equal((await post()).status, 400);
  assert.equal(tracker.records[id].manual, 1);
  assert.equal(tracker.records[id].discard, 0);
  sourceError = true;
  const beforeFailure = JSON.stringify(tracker.records);
  assert.equal((await post(`${base}/api/threads/${id}/keep-result`)).status, 200);
  assert.equal((await fetch(`${base}/api/dashboard?force=1`)).status, 500);
  assert.equal(JSON.stringify(tracker.records), beforeFailure);
});

test('an old Discard native mask cannot hide a same-time or later failed end', async () => {
  for (const offset of [10, 30]) {
    const tracker = new PendingTracker(false);
    const events = [discardEvent('task_started', 0)];
    const working = await tracker.observe(discardBoard(events, { nativeUnread: false }));
    await tracker.setDiscard(working.threads[0], true);
    events.push(discardEvent('task_complete', 10));
    await tracker.observe(discardBoard(events, { nativeUnread: false }));
    assert.equal(tracker.records[id].discardNative, 0);
    events.push(discardEvent('task_started', 20), discardEvent('task_complete', offset, { error: { message: 'Synthetic failure' } }));
    const failed = (await tracker.observe(discardBoard(events, { nativeUnread: true }))).threads[0];
    assert.deepEqual([failed.lastOutcome, failed.nativeAttention, failed.pending, failed.unread], ['failed', true, true, true]);
    if (offset > 10) assert.equal(tracker.records[id].discardedAt, 0);
  }
});

test('Claude cached root end/start evidence clears Discard across a missed Idle without changing native fields', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  const project = path.join(projectsDir, 'project');
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  const transcript = path.join(project, `${id}.jsonl`);
  const event = (type, offset, content) => ({ type, timestamp: new Date(now + offset).toISOString(), message: { content } });
  await writeFile(transcript, jsonl([event('user', 0, 'Start the synthetic task.')]) + '\n');
  const tracker = new PendingTracker(false);
  const scan = async () => {
    const source = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs: now + 100 });
    return tracker.observe(buildSwitchboardDashboard(source.threads, [], now + 100));
  };
  const first = await scan(); await tracker.setDiscard(first.threads[0], true);
  await writeFile(transcript, jsonl([{ type: 'result', timestamp: new Date(now + 10).toISOString() },
    event('user', 20, 'Start the next synthetic task.')]) + '\n', { flag: 'a' });
  const next = (await scan()).threads[0];
  assert.deepEqual([next.state, next.discardResult, next.pending, next.nativeUnread], ['working', false, false, null]);
  await writeFile(transcript, jsonl([{ type: 'result', timestamp: new Date(now + 30).toISOString() }]) + '\n', { flag: 'a' });
  assert.equal((await scan()).threads[0].completionAttention, true);
});

test('Claude late linked starts and child-only end/start gaps retain the timer and one-shot Discard semantics', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  const project = path.join(projectsDir, 'project');
  const childDir = path.join(project, id, 'subagents');
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(childDir, { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', `${localId}.json`), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  const root = path.join(project, `${id}.jsonl`);
  const child = path.join(childDir, 'agent-linked.jsonl');
  const event = (type, offset, extra = {}) => ({ type, timestamp: new Date(now + offset).toISOString(), ...extra });
  await writeFile(root, jsonl([
    event('user', 0, { message: { content: 'Start the synthetic task.' } }),
    event('assistant', 1, { message: { content: [{ type: 'tool_use', id: 'agent-tool', name: 'Agent' }] } }),
    event('user', 2, { message: { content: [{ type: 'tool_result', tool_use_id: 'agent-tool' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'linked' } }),
  ]) + '\n');
  const tracker = new PendingTracker(false);
  const scan = async () => tracker.observe(buildSwitchboardDashboard((await loadClaudeDesktopCodeThreads({
    appDir, projectsDir, nowMs: now + 100,
  })).threads, [], now + 100));
  const first = await scan(); await tracker.setDiscard(first.threads[0], true);
  await writeFile(root, jsonl([event('result', 10)]) + '\n', { flag: 'a' });
  assert.equal((await scan()).threads[0].state, 'unknown');
  assert.equal(tracker.records[first.threads[0].id].discard, 1);
  await writeFile(child, jsonl([event('assistant', 20, { message: { content: [{ type: 'thinking' }] } })]) + '\n');
  const late = (await scan()).threads[0];
  assert.deepEqual([late.state, late.discardResult, late.workingSinceMs], ['working', true, now]);
  await writeFile(child, jsonl([event('result', 30), event('user', 40, { message: { content: 'Next child task.' } })]) + '\n', { flag: 'a' });
  const next = (await scan()).threads[0];
  assert.deepEqual([next.state, next.discardResult, next.pending, next.workingSinceMs], ['working', false, false, now]);
  await writeFile(child, jsonl([event('result', 50)]) + '\n', { flag: 'a' });
  assert.equal((await scan()).threads[0].completionAttention, true);
});

test('Keep reuses warm snapshots while Discard rejects the reproduced two-ended-task cache gap', async (t) => {
  const tracker = new PendingTracker(false);
  let scans = 0;
  let sourceEvents = [discardEvent('task_started', 0)];
  const server = createSwitchboardServer({ pendingTracker: tracker, now: () => now + 1000, dashboardWatchPaths: [],
    loadDashboard: async () => { scans += 1; return discardBoard(sourceEvents); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (action) => fetch(`${base}/api/threads/${id}/${action}`, { method: 'POST', headers: { Origin: base }, body: '{}' });
  const warm = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(warm.threads[0].state, 'working');
  assert.equal(scans, 1);
  for (let click = 0; click < 3; click += 1) assert.equal((await post('keep-result')).status, 200);
  assert.equal(scans, 1);
  assert.equal((await post('discard-result')).status, 200);
  assert.equal(scans, 2);
  assert.equal(tracker.records[id].discard, 1);
  assert.equal((await post('keep-result')).status, 200);
  assert.equal(scans, 2);
  assert.equal(tracker.records[id].discard, 0);

  sourceEvents.push(discardEvent('task_complete', 10), discardEvent('task_started', 20), discardEvent('task_complete', 30));
  assert.equal((await post('keep-result')).status, 200);
  assert.equal(scans, 2);
  assert.equal((await post('discard-result')).status, 400);
  assert.equal(scans, 3);
  assert.equal(tracker.records[id].discard, 0);
  const ended = await (await fetch(`${base}/api/dashboard`)).json();
  assert.deepEqual([ended.threads[0].state, ended.threads[0].completionAtMs, ended.threads[0].unread], ['idle', now + 30, true]);
  assert.equal((await post('keep-result')).status, 200);
  assert.equal(scans, 3);
});

test('malformed raw request targets return 400 and leave the ASB server available', async (t) => {
  let loads = 0;
  const server = createSwitchboardServer({ pendingStatePath: false, dashboardWatchPaths: [],
    loadDashboard: async () => { loads += 1; return { providers: [], threads: [] }; },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const port = server.address().port;
  const response = await new Promise((resolve, reject) => {
    let text = '';
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.end(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => { text += chunk.toString(); });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal(loads, 0);
  const normal = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(normal.status, 200);
  assert.deepEqual((await normal.json()).threads, []);
  assert.equal(loads, 1);
});

test('npm start listens on loopback only', async (t) => {
  const dir = await temp(t);
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/switchboard.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: dir, PORT: String(port), XDG_STATE_HOME: path.join(dir, 'state'),
      XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data') } });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('\n')) break; }
  assert.equal(output.trim(), `ASB: http://127.0.0.1:${port}`);
  const connect = (host) => new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 2_000 }, () => { socket.destroy(); resolve('open'); });
    socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.on('error', (error) => resolve(error.code));
  });
  assert.equal(await connect('127.0.0.1'), 'open');
  const external = Object.values(os.networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal);
  if (external) assert.equal(await connect(external.address), 'ECONNREFUSED');
  else t.diagnostic('No non-loopback IPv4 address. The refused-connect assert did not run.');
});
