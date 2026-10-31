import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { once } from 'node:events';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyClaudeAppApproval,
  applyLiveClaudeStatus,
  claudeTitle,
  getClaudeCacheStats,
  invalidateClaudeData,
  loadClaudeDesktopCodeThreads,
  normalizeClaudeDesktopCodeSession,
  openClaudeThread,
  parseClaudeJsonlSignals,
} from '../src/claude-data.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { buildSwitchboardDashboard, PendingTracker } from '../src/switchboard.mjs';

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

test('parses Claude JSONL session fields and pending user prompts', () => {
  const signals = parseClaudeJsonlSignals(jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T02:00:00.000Z',
      sessionId: 'ses_cli',
      cwd: '/Users/example/work',
      entrypoint: 'cli',
      message: { role: 'user', content: '帮我检查这个项目' },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:01:00.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'tool_use',
            id: 'tool_ask',
            name: 'AskUserQuestion',
            input: { question: '可以运行测试吗？' },
          },
        ],
      },
    },
  ]));

  assert.equal(signals.sessionId, 'ses_cli');
  assert.equal(signals.cwd, '/Users/example/work');
  assert.equal(signals.model, 'claude-sonnet-4-6');
  assert.equal(signals.latestAgentFinalAtMs, null);
  assert.equal(signals.pendingToolCount, 1);
  assert.equal(signals.pendingTools[0].title, '向用户提问');
  assert.equal(signals.pendingTools[0].kind, 'permission');
});

test('ignores ordinary unresolved Claude tool uses as user pending work', () => {
  const signals = parseClaudeJsonlSignals(jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T02:00:00.000Z',
      sessionId: 'ses_cli',
      cwd: '/Users/example/work',
      message: { role: 'user', content: '跑一下测试' },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:01:00.000Z',
      message: {
        id: 'msg_tool',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'tool_use',
            id: 'tool_bash',
            name: 'Bash',
            input: {
              command: 'npm test',
              description: 'Run test suite',
            },
          },
        ],
      },
    },
  ]));

  assert.equal(signals.latestAgentFinalAtMs, null);
  assert.equal(signals.pendingToolCount, 0);
  assert.equal(signals.pendingToolAtMs, 0);
  assert.deepEqual(signals.pendingTools, []);
});

test('keeps ordinary Claude tool results out of user pending work', () => {
  const resolvedByToolResult = parseClaudeJsonlSignals(jsonl([
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:01:00.000Z',
      message: {
        id: 'msg_tool',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_bash',
            name: 'Bash',
            input: { description: 'Run test suite' },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-05-09T02:02:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_bash',
            content: 'ok',
          },
        ],
      },
    },
  ]));

  const resolvedByResult = parseClaudeJsonlSignals(jsonl([
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:01:00.000Z',
      message: {
        id: 'msg_tool',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_bash',
            name: 'Bash',
            input: { description: 'Run test suite' },
          },
        ],
      },
    },
    {
      type: 'result',
      timestamp: '2026-05-09T02:03:00.000Z',
      terminal_reason: 'completed',
    },
  ]));

  assert.equal(resolvedByToolResult.pendingToolCount, 0);
  assert.equal(resolvedByToolResult.pendingToolAtMs, 0);
  assert.equal(resolvedByResult.pendingToolCount, 0);
  assert.equal(resolvedByResult.pendingToolAtMs, 0);
});

test('does not treat intermediate Claude text before tool work as a completed turn', () => {
  const signals = parseClaudeJsonlSignals(jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T02:00:00.000Z',
      sessionId: 'ses_cli',
      cwd: '/Users/example/work',
      message: { role: 'user', content: '继续实现这个模块' },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:01:00.000Z',
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: '我会先拆分任务，然后继续改代码。' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:02:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_edit',
            name: 'Edit',
            input: { file_path: '/Users/example/work/app.js' },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-05-09T02:03:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_edit',
            content: 'ok',
          },
        ],
      },
    },
  ]));
  const thread = normalizeClaudeDesktopCodeSession({
    sessionId: 'local_active',
    cliSessionId: '123e4567-e89b-12d3-a456-426614174000',
    originCwd: '/Users/example/work',
    lastActivityAt: Date.parse('2026-05-09T02:03:00.000Z'),
  }, {
    signals,
  }, Date.parse('2026-05-09T02:04:00.000Z'));

  assert.equal(signals.latestAgentFinalAtMs, null);
  assert.equal(thread.status, 'running');
  assert.equal(thread.currentTurnStartedAtMs, Date.parse('2026-05-09T02:00:00.000Z'));
});

test('uses Claude assistant end_turn events as completed-turn markers', () => {
  const signals = parseClaudeJsonlSignals(jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T02:00:00.000Z',
      sessionId: 'ses_cli',
      cwd: '/Users/example/work',
      message: { role: 'user', content: '跑一次回测' },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:03:00.000Z',
      sessionId: 'ses_cli',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '回测已经跑完，可以查看结果。' }],
      },
    },
  ]));
  const thread = normalizeClaudeDesktopCodeSession({
    sessionId: 'local_done',
    cliSessionId: '123e4567-e89b-12d3-a456-426614174000',
    originCwd: '/Users/example/work',
    lastActivityAt: Date.parse('2026-05-09T02:03:00.000Z'),
  }, {
    signals,
  }, Date.parse('2026-05-09T03:00:00.000Z'));

  assert.equal(signals.latestAgentFinalAtMs, Date.parse('2026-05-09T02:03:00.000Z'));
  assert.equal(thread.status, 'warm');
  assert.equal(thread.currentTurnStartedAtMs, null);
});

test('uses Claude stop hook summaries as completed-turn markers', () => {
  const signals = parseClaudeJsonlSignals(jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T02:00:00.000Z',
      sessionId: 'ses_cli',
      cwd: '/Users/example/work',
      message: { role: 'user', content: '生成报告' },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-09T02:02:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '报告已生成。' }],
      },
    },
    {
      type: 'system',
      subtype: 'stop_hook_summary',
      timestamp: '2026-05-09T02:03:00.000Z',
      sessionId: 'ses_cli',
    },
  ]));

  assert.equal(signals.latestAgentFinalAtMs, Date.parse('2026-05-09T02:03:00.000Z'));
  assert.equal(signals.latestMessageKind, 'agent');
});

test('folds Claude subagent transcripts into their Desktop Code host', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-subagents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'projects', '-Users-example-project');
  const metadataDir = path.join(root, 'Claude', 'claude-code-sessions');
  const hostSessionId = '123e4567-e89b-12d3-a456-426614174000';
  const hostPath = path.join(projectDir, `${hostSessionId}.jsonl`);
  const subagentDir = path.join(projectDir, hostSessionId, 'subagents');
  await mkdir(subagentDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });
  await writeFile(path.join(metadataDir, 'local_host.json'), JSON.stringify({ sessionId: 'local_host', cliSessionId: hostSessionId }));
  await writeFile(hostPath, jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T01:00:00.000Z',
      sessionId: hostSessionId,
      cwd: '/Users/example/project',
      message: { role: 'user', content: 'Host task' },
    },
  ]));
  await writeFile(path.join(subagentDir, 'agent-reviewer.jsonl'), jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T01:05:00.000Z',
      sessionId: hostSessionId,
      isSidechain: true,
      agentId: 'reviewer',
      cwd: '/Users/example/project',
      message: { role: 'user', content: 'Read-only review' },
    },
  ]));

  const result = await loadClaudeDesktopCodeThreads({
    appDir: path.join(root, 'Claude'),
    projectsDir: path.join(root, 'projects'),
    maxCount: 20,
    nowMs: Date.parse('2026-05-09T02:00:00.000Z'),
  });

  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].id, 'claude-desktop-code:local_host');
  assert.equal(result.threads[0].embeddedSubagentCount, 1);
  // The file time of a child log is not a time: the log has no link from the root, and the group has no child turn time.
  assert.equal(result.threads[0].embeddedSubagentUpdatedAtMs, null);
});

test('deduplicates Claude Desktop Code metadata that points at the same CLI session', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-desktop-code-dedupe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projectsDir = path.join(dir, 'projects');
  const projectDir = path.join(projectsDir, '-Users-example-project');
  const appDir = path.join(dir, 'Claude');
  const desktopDir = path.join(appDir, 'claude-code-sessions', 'account', 'workspace');
  const cliSessionId = 'cli_shared';
  await mkdir(projectDir, { recursive: true });
  await mkdir(desktopDir, { recursive: true });
  await writeFile(path.join(projectDir, `${cliSessionId}.jsonl`), jsonl([
    {
      type: 'assistant',
      timestamp: '2026-05-09T01:12:00.000Z',
      sessionId: cliSessionId,
      cwd: '/Users/example/project',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_pending',
            name: 'Bash',
            input: { description: 'Check status' },
          },
        ],
      },
    },
  ]));
  await writeFile(path.join(desktopDir, 'local_old.json'), JSON.stringify({
    sessionId: 'local_old',
    cliSessionId,
    originCwd: '/Users/example/project',
    createdAt: Date.parse('2026-05-09T01:00:00.000Z'),
    lastActivityAt: Date.parse('2026-05-09T01:05:00.000Z'),
    title: 'Older duplicate',
  }));
  await writeFile(path.join(desktopDir, 'local_new.json'), JSON.stringify({
    sessionId: 'local_new',
    cliSessionId,
    originCwd: '/Users/example/project',
    createdAt: Date.parse('2026-05-09T01:00:00.000Z'),
    lastActivityAt: Date.parse('2026-05-09T01:10:00.000Z'),
    title: 'Newer duplicate',
  }));
  // Two quick writes often get the same mtime (coarse file clock); then the order of the stat replies picked the kept file.
  for (const [name, atMs] of [['local_old', Date.parse('2026-05-09T01:05:00.000Z')], ['local_new', Date.parse('2026-05-09T01:10:00.000Z')]]) {
    await utimes(path.join(desktopDir, `${name}.json`), atMs / 1000, atMs / 1000);
  }

  const result = await loadClaudeDesktopCodeThreads({
    appDir,
    projectsDir,
    nowMs: Date.parse('2026-05-09T03:00:00.000Z'),
  });
  const desktopThreads = result.threads;

  assert.equal(desktopThreads.length, 1);
  assert.equal(desktopThreads[0].id, 'claude-desktop-code:local_new');
  assert.equal(desktopThreads[0].pendingToolCount, 0);
});

test('reads no Claude Desktop waiting-input record as a second session', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-desktop-code-waiting-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude');
  const desktopDir = path.join(appDir, 'claude-code-sessions', 'account', 'workspace');
  // Claude Desktop keeps the messages that wait for a busy session in waiting-input/, in a file with the session ID.
  await mkdir(path.join(desktopDir, 'waiting-input'), { recursive: true });
  await writeFile(path.join(desktopDir, 'local_busy.json'), JSON.stringify({ sessionId: 'local_busy', cliSessionId: 'cli_busy',
    createdAt: Date.parse('2026-05-09T01:00:00.000Z'), lastActivityAt: Date.parse('2026-05-09T01:05:00.000Z'), title: 'Busy task' }));
  await writeFile(path.join(desktopDir, 'waiting-input', 'local_busy.json'), JSON.stringify({ v: 1, sessionId: 'local_busy',
    savedAt: Date.parse('2026-05-09T01:06:00.000Z'), entries: [], cleanShutdown: false }));

  const result = await loadClaudeDesktopCodeThreads({ appDir, projectsDir: path.join(dir, 'projects'),
    nowMs: Date.parse('2026-05-09T03:00:00.000Z') });
  assert.deepEqual(result.threads.map((thread) => [thread.id, thread.title]), [['claude-desktop-code:local_busy', 'Busy task']]);
});

test('normalizes Claude Desktop Code sessions with a desktop resume deep link', () => {
  const cliSessionId = '123e4567-e89b-12d3-a456-426614174000';
  const thread = normalizeClaudeDesktopCodeSession({
    sessionId: 'local_123',
    cliSessionId,
    originCwd: '/Users/example/project',
    createdAt: Date.parse('2026-05-09T01:00:00.000Z'),
    lastActivityAt: Date.parse('2026-05-09T01:10:00.000Z'),
    title: '桌面 Code 任务',
    model: 'claude-sonnet-4-6',
  }, {}, Date.parse('2026-05-09T03:00:00.000Z'));

  assert.equal(thread.provider, 'claude-desktop-code');
  assert.equal(thread.appDeepLink, `claude://resume?session=${cliSessionId}`);
  assert.equal(thread.cliSessionId, cliSessionId);
});

test('uses Claude Desktop Code panel default title for untitled task-notification sessions', () => {
  const signals = parseClaudeJsonlSignals(jsonl([
    {
      type: 'user',
      timestamp: '2026-05-09T02:00:00.000Z',
      sessionId: 'ses_cli',
      cwd: '/Users/example/project',
      message: {
        role: 'user',
        content: '<task-notification><task-id>abc</task-id><output-file>/tmp/out</output-file></task-notification>',
      },
    },
  ]));
  const thread = normalizeClaudeDesktopCodeSession({
    sessionId: 'local_untitled',
    cliSessionId: '123e4567-e89b-12d3-a456-426614174000',
    originCwd: '/Users/example/project',
    createdAt: Date.parse('2026-05-09T01:00:00.000Z'),
    lastActivityAt: Date.parse('2026-05-09T02:00:00.000Z'),
  }, {
    signals,
  }, Date.parse('2026-05-09T03:00:00.000Z'));

  assert.equal(thread.title, 'General coding session');
});

test('opens Claude Desktop Code sessions through the registered resume deep link', async () => {
  const cliSessionId = '123e4567-e89b-12d3-a456-426614174000';
  const appDeepLink = `claude://resume?session=${cliSessionId}`;
  const calls = [];
  const result = await openClaudeThread({
    provider: 'claude-desktop-code',
    externalId: 'local_123',
    cliSessionId,
    appDeepLink,
  }, {
    platform: 'darwin',
    runCommand: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'claude-desktop-deeplink');
  assert.deepEqual(calls[0], {
    command: 'open',
    args: [appDeepLink],
  });
});

test('rejects a Claude thread that has no desktop deep link and runs no command', async () => {
  const calls = [];
  const runCommand = async (...args) => { calls.push(args); };
  for (const thread of [
    { provider: 'claude-desktop-code', externalId: 'local_legacy', cliSessionId: 'not-a-uuid' },
    { provider: 'claude-code-cli', externalId: 'ses_cli', appDeepLink: 'claude://resume?session=ses_cli' },
  ]) await assert.rejects(openClaudeThread(thread, { platform: 'linux', runCommand }), /no direct desktop link/);
  assert.deepEqual(calls, []);
});

test('skips Claude JSONL lines that parse to a non-object', () => {
  const signals = parseClaudeJsonlSignals(`null\n7\n"text"\n${jsonl([
    { type: 'user', timestamp: '2026-05-09T02:00:00.000Z', sessionId: 'ses_cli', message: { content: 'Run the checks' } },
    { type: 'assistant', timestamp: '2026-05-09T02:01:00.000Z', message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion' }] } },
  ])}`);
  assert.equal(signals.sessionId, 'ses_cli');
  assert.equal(signals.lifecycle.running, true);
  assert.equal(signals.pendingToolCount, 1);
});

test('a linked async Agent child ends through a task notification', async (t) => {
  const nowMs = Date.parse('2026-05-09T03:00:00.000Z');
  const event = (type, offset, extra = {}) => ({ type, timestamp: new Date(nowMs + offset).toISOString(), ...extra });
  const launched = [
    event('user', -10_000, { message: { content: 'Start a background task.' } }),
    event('assistant', -9000, { message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { run_in_background: true } }] } }),
    event('user', -8900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'background' } }),
  ];
  const rootEnd = (offset) => event('assistant', offset, { message: { stop_reason: 'end_turn', content: 'Done.' } });
  const thinking = (offset) => event('assistant', offset, { message: { content: [{ type: 'thinking' }] } });
  const load = async (records) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-task-notification-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
    const childDir = path.join(projectsDir, 'project', 'cli_root', 'subagents');
    await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
    await mkdir(childDir, { recursive: true });
    await writeFile(path.join(appDir, 'claude-code-sessions', 'local_root.json'), JSON.stringify({ sessionId: 'local_root', cliSessionId: 'cli_root' }));
    await writeFile(path.join(projectsDir, 'project', 'cli_root.jsonl'), jsonl(records));
    // The child transcript has no end record: only the notification can close its work.
    await writeFile(path.join(childDir, 'agent-background.jsonl'), jsonl([thinking(-8500)]));
    const [thread] = (await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs })).threads;
    return [thread.lifecycleRunning, thread.latestLifecycleKind, thread.groupTaskEndKind, thread.groupTaskEndedAtMs];
  };
  assert.deepEqual(await load([...launched, rootEnd(-8000)]), [true, 'task_started', '', 0]);
  for (const [status, kind] of [['completed', 'task_complete'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['aborted', 'cancelled']]) {
    const text = `<task-notification><task-id>background</task-id><status>${status}</status></task-notification>`;
    const notice = event('user', -7000, { message: { content: text } });
    // The root ended before the child: the delivered notification starts a turn, and the reply sets the group outcome.
    assert.deepEqual(await load([...launched, rootEnd(-8000), notice]), [true, 'task_started', '', 0], status);
    assert.deepEqual(await load([...launched, rootEnd(-8000), notice, rootEnd(-6500)]),
      [false, 'task_complete', 'task_complete', nowMs - 6500], status);
    // A queued notification starts no turn: the child end is the group end.
    const queued = event('attachment', -7000, { attachment: { type: 'queued_command', prompt: text } });
    assert.deepEqual(await load([...launched, rootEnd(-8000), queued]), [false, kind, kind, nowMs - 7000], status);
    // The root continues after the notification: the group has open work and no end.
    assert.deepEqual(await load([...launched, notice, thinking(-6000)]), [true, 'task_started', '', 0], status);
    // The root ends after the notification: the later root end sets the group outcome.
    assert.deepEqual(await load([...launched, notice, thinking(-6000), rootEnd(-5000)]),
      [false, 'task_complete', 'task_complete', nowMs - 5000], status);
  }
});

const resumeNowMs = Date.parse('2026-05-09T04:00:00.000Z');
const resumeEvent = (type, offset, extra = {}) => ({ type, timestamp: new Date(resumeNowMs + offset).toISOString(), ...extra });
const resumeEnd = (offset) => resumeEvent('assistant', offset, { message: { stop_reason: 'end_turn', content: 'Done.' } });
const resumeWork = (offset) => resumeEvent('assistant', offset, { message: { content: [{ type: 'tool_use', id: `work${offset}`, name: 'Bash' }] } });
const resumePrompt = (offset) => resumeEvent('user', offset, { message: { content: 'Continue this work.' } });
// The first record of a resumed child in a real transcript: the message, as a meta record.
const resumeMessage = (offset) => resumeEvent('user', offset, { isMeta: true, isSidechain: true, message: { content: 'Continue this work.' } });
const resumeNotice = (offset, agentId, status = 'completed') => resumeEvent('user', offset, { message: { content:
  `<task-notification><task-id>${agentId}</task-id><status>${status}</status></task-notification>` } });
// The main chat sends a message, gets its result, and ends its turn.
const sendMessage = (offset, toolUseResult, call = true) => [
  ...(call ? [resumeEvent('assistant', offset, { message: { content: [{ type: 'tool_use', id: `send${offset}`, name: 'SendMessage' }] } })] : []),
  resumeEvent('user', offset + 100, { message: { content: [{ type: 'tool_result', tool_use_id: `send${offset}` }] }, toolUseResult }),
  resumeEnd(offset + 1000),
];
const resumeResult = (agentId, success = true) => ({ message: 'Sent.', pin: null, resumedAgentId: agentId, success });
// The notification form of a busy chat. The timestamp is the end of the task, not the delivery time.
const queuedNotice = (offset, agentId, status = 'completed', attachment = {}) => {
  const { timestamp } = resumeEvent('attachment', offset);
  return { type: 'attachment', timestamp, attachment: { type: 'queued_command', commandMode: 'task-notification', timestamp,
    prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n${status ? `<status>${status}</status>\n` : ''}</task-notification>`, ...attachment } };
};
const resumeLaunch = (agentId) => [
  resumeEvent('user', -50_000, { message: { content: 'Start a background task.' } }),
  resumeEvent('assistant', -49_000, { message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { run_in_background: true } }] } }),
  resumeEvent('user', -48_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId } }),
  resumeEnd(-48_000),
];
// childFolder is relative to the projects folder. The default is the own folder of the root.
async function resumeFixture(t, agentId, records, childRecords, maxBytes, childFolder = 'project/cli_root') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-resumed-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
  const childDir = path.join(projectsDir, childFolder, 'subagents');
  const main = path.join(projectsDir, 'project', 'cli_root.jsonl'), child = path.join(childDir, `agent-${agentId}.jsonl`);
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(childDir, { recursive: true });
  await mkdir(path.dirname(main), { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', 'local_root.json'), JSON.stringify({ sessionId: 'local_root', cliSessionId: 'cli_root' }));
  await writeFile(main, jsonl([resumeEvent('progress', -60_000, { data: 'x'.repeat(2048) }), ...records]));
  await writeFile(child, jsonl(childRecords));
  return { projectsDir, step: async (mainRecords = [], moreChildRecords = []) => {
    if (mainRecords.length) await appendFile(main, jsonl(mainRecords));
    if (moreChildRecords.length) await appendFile(child, jsonl(moreChildRecords));
    invalidateClaudeData();
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs: resumeNowMs, ...(maxBytes ? { maxBytes } : {}) });
    return [threads[0].lifecycleRunning, buildSwitchboardDashboard(threads, [], resumeNowMs).threads[0].state];
  } };
}

async function signalFixture(t, records, maxBytes = 8 * 1024 * 1024) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-incremental-signals-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
  const file = path.join(projectsDir, 'project', 'cli_root.jsonl');
  const metadata = path.join(appDir, 'claude-code-sessions', 'local_root.json');
  await mkdir(path.dirname(metadata), { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(metadata, JSON.stringify({ sessionId: 'local_root', cliSessionId: 'cli_root',
    cwd: '/tmp/synthetic-work', createdAt: resumeNowMs - 200_000, lastActivityAt: resumeNowMs }));
  await utimes(metadata, resumeNowMs / 1000, resumeNowMs / 1000);
  await writeFile(file, typeof records === 'string' ? records : jsonl(records));
  return { file, projectsDir, load: async (nowMs = resumeNowMs) =>
    (await loadClaudeDesktopCodeThreads({ appDir, projectsDir, maxBytes, nowMs })).threads[0] };
}

test('appended Claude signals match a full read for questions, child links, compaction, and terminal events', async (t) => {
  const records = [resumePrompt(-100_000), resumeEvent('system', -99_900, { subtype: 'init', model: 'synthetic-model' })];
  const incremental = await signalFixture(t, records), full = await signalFixture(t, records);
  const ask = (offset, id, name = 'AskUserQuestion') => resumeEvent('assistant', offset,
    { message: { content: [{ type: 'tool_use', id, name }] } });
  const answer = (offset, id) => resumeEvent('user', offset,
    { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Yes.' }] } });
  for (const fixture of [incremental, full]) {
    const child = path.join(fixture.projectsDir, 'project', 'cli_root', 'subagents', 'agent-kid.jsonl');
    const workflow = path.join(fixture.projectsDir, 'project', 'cli_root', 'subagents', 'workflows', 'wf_run1', 'journal.jsonl');
    await mkdir(path.dirname(child), { recursive: true });
    await mkdir(path.dirname(workflow), { recursive: true });
    await writeFile(child, jsonl([resumeMessage(-96_800), resumeWork(-96_500)]));
    await writeFile(workflow, '{}\n');
    await utimes(child, (resumeNowMs - 96_500) / 1000, (resumeNowMs - 96_500) / 1000);
    await utimes(workflow, (resumeNowMs - 90_000) / 1000, (resumeNowMs - 90_000) / 1000);
  }
  await incremental.load();
  const steps = [
    [ask(-99_000, 'ask')], [answer(-98_000, 'ask')],
    [resumeEvent('assistant', -97_000, { message: { stop_reason: 'refusal',
      content: [{ type: 'tool_use', id: 'launch', name: 'Agent' }] } }),
    resumeEvent('user', -96_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'kid' } }), resumeEnd(-96_000)],
    [ask(-95_000, 'child-ask')], [queuedNotice(-94_000, 'kid', 'failed')], [answer(-93_500, 'child-ask')],
    [resumeEvent('assistant', -93_000, { message: { content: [{ type: 'tool_use', id: 'flow', name: 'Workflow' }] } }),
    resumeEvent('user', -92_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'flow' }] },
      toolUseResult: { status: 'async_launched', taskId: 'flow-task', runId: 'wf_run1' } }), resumeEnd(-92_000)],
    [queuedNotice(-91_000, 'flow-task', 'completed')], sendMessage(-90_000, resumeResult('kid')),
    [resumeNotice(-88_000, 'kid', 'stopped')], [resumePrompt(-87_000)],
    [resumeEvent('system', -40_000, { subtype: 'compact_boundary' }),
    resumeEvent('user', -40_000, { isCompactSummary: true, message: { content: 'A compact summary.' } }), resumeWork(-86_000)],
    [ask(-85_000, 'permission', 'ExitPlanMode')], [answer(-84_000, 'permission')],
    [resumeEvent('result', -83_000, { is_error: true, result: 'Synthetic failure.' })],
    [resumePrompt(-82_000), resumeEvent('system', -81_000, { subtype: 'turn_aborted' })],
    [resumePrompt(-80_000), resumeEnd(-79_000)],
  ];
  for (const [index, appended] of steps.entries()) {
    records.push(...appended);
    await appendFile(incremental.file, jsonl(appended));
    invalidateClaudeData({ filePath: incremental.file });
    await writeFile(`${full.file}.replacement`, jsonl(records));
    await rename(`${full.file}.replacement`, full.file);
    const actual = await incremental.load(), expected = await full.load();
    assert.deepEqual(actual, expected, `step ${index}`);
    assert.deepEqual(buildSwitchboardDashboard([actual], [], resumeNowMs).threads,
      buildSwitchboardDashboard([expected], [], resumeNowMs).threads, `dashboard step ${index}`);
    if (index === 3) assert.equal(actual.questionNonBlocking, true);
    if (index === 12) assert.equal(actual.pendingTools[0].tool, 'ExitPlanMode');
  }
});

test('Claude retains a loaded question beyond the tail until its result, and unchanged files read no bytes', async (t) => {
  const asked = resumeEvent('assistant', -49_000, { message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion' }] } });
  const fixture = await signalFixture(t, [resumePrompt(-50_000), asked], 256);
  assert.equal((await fixture.load()).pendingToolCount, 1);
  for (const offset of [-48_000, -47_000, -46_000]) {
    const appended = jsonl([resumeEvent('progress', offset, { data: 'x'.repeat(4096) })]);
    await appendFile(fixture.file, appended);
    invalidateClaudeData({ filePath: fixture.file });
    const before = getClaudeCacheStats().jsonlSignals.bytesRead;
    const thread = await fixture.load();
    assert.equal(thread.pendingToolCount, 1);
    assert.equal(thread.pendingToolAtMs, resumeNowMs - 49_000);
    assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead - before, 64 + Buffer.byteLength(appended));
  }
  const before = getClaudeCacheStats().jsonlSignals.bytesRead;
  await fixture.load();
  invalidateClaudeData();
  await fixture.load();
  assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead, before);
  await appendFile(fixture.file, jsonl([resumeEvent('user', -45_000,
    { message: { content: [{ type: 'tool_result', tool_use_id: 'ask', content: 'Yes.' }] } })]));
  assert.equal((await fixture.load()).pendingToolCount, 0);
  assert.equal(buildSwitchboardDashboard([await fixture.load(resumeNowMs + 7 * 60 * 60 * 1000)], [],
    resumeNowMs + 7 * 60 * 60 * 1000).threads[0].state, 'unknown');
});

test('Claude keeps valid newline-free final records visible and finishes partial UTF-8 records once', async (t) => {
  for (const maxBytes of [256, 8 * 1024 * 1024]) {
    const prompt = resumePrompt(-50_000), ask = resumeEvent('assistant', -49_000,
      { message: { content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion' }] } });
    const fixture = await signalFixture(t, jsonl([prompt]) + JSON.stringify(ask), maxBytes);
    assert.equal((await fixture.load()).pendingToolCount, 1, `first record ${maxBytes}`);
    const before = getClaudeCacheStats().jsonlSignals.bytesRead;
    await fixture.load();
    assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead, before);
    await appendFile(fixture.file, '  ');
    assert.equal((await fixture.load()).pendingToolCount, 1, `valid uncommitted record ${maxBytes}`);
    await appendFile(fixture.file, '\n');
    assert.equal((await fixture.load()).pendingToolCount, 1, `committed record ${maxBytes}`);
    const answer = Buffer.from(jsonl([resumeEvent('user', -48_000,
      { message: { content: [{ type: 'tool_result', tool_use_id: 'ask', content: '好' }] } })]));
    const split = answer.indexOf(Buffer.from('好')) + 1;
    await appendFile(fixture.file, answer.subarray(0, split));
    assert.equal((await fixture.load()).pendingToolCount, 1, `partial result ${maxBytes}`);
    await appendFile(fixture.file, answer.subarray(split));
    assert.equal((await fixture.load()).pendingToolCount, 0, `complete result ${maxBytes}`);
    await appendFile(fixture.file, JSON.stringify(resumeEnd(-47_000)));
    assert.equal((await fixture.load()).latestAgentFinalAtMs, resumeNowMs - 47_000, `newline-free end ${maxBytes}`);
    await appendFile(fixture.file, `\n${jsonl([resumePrompt(-46_000)])}`);
    const running = await fixture.load();
    assert.equal(running.lifecycleRunning, true);
    assert.equal(running.latestTaskStartedAtMs, resumeNowMs - 46_000);
  }
});

test('Claude bounds retained permissions and keeps the latest question when old events arrive later', async (t) => {
  const ask = (offset, id) => resumeEvent('assistant', offset,
    { message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion' }] } });
  const fixture = await signalFixture(t, [resumePrompt(-100_000), ask(-1000, 'latest')]);
  await fixture.load();
  await appendFile(fixture.file, jsonl(Array.from({ length: 5005 }, (_, index) => ask(-90_000 + index, `old-${index}`))));
  const retained = await fixture.load();
  assert.equal(retained.pendingToolCount, 5000);
  assert.equal(retained.pendingTools[0].id, 'latest');
  assert.equal(retained.pendingToolAtMs, resumeNowMs - 1000);
  await appendFile(fixture.file, jsonl([resumeEvent('user', -500,
    { message: { content: [{ type: 'tool_result', tool_use_id: 'latest', content: 'Yes.' }] } })]));
  const resolved = await fixture.load();
  assert.equal(resolved.pendingToolCount, 4999);
  assert.equal(resolved.pendingToolAtMs, resumeNowMs - 90_000 + 5004);
});

test('a resumed async Agent child makes its chat Working again until the next task notification', async (t) => {
  // With maxBytes 256 each step is an append to the cached lifecycle state of the reader.
  for (const maxBytes of [0, 256]) {
    const { step } = await resumeFixture(t, 'kid', [
      resumeEvent('user', -50_000, { message: { content: 'Start a background task.' } }),
      resumeEvent('assistant', -49_000, { message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { run_in_background: true } }] } }),
      resumeEvent('user', -48_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'kid' } }),
      resumeEnd(-48_000),
    ], [resumePrompt(-48_800), resumeWork(-48_500)], maxBytes);
    assert.deepEqual(await step(), [true, 'working'], `launch ${maxBytes}`);
    // The delivered notification starts a turn of the main chat; its reply ends the turn.
    assert.deepEqual(await step([resumeNotice(-44_000, 'kid')], [resumeEnd(-45_000)]), [true, 'working'], `notice ${maxBytes}`);
    assert.deepEqual(await step([resumeEnd(-43_500)]), [false, 'idle'], `end ${maxBytes}`);

    const others = [{ message: 'Queued.', pin: null, success: true }, { display: 'Sent.', message: 'Hello.', msg_id: 'msg_1', success: true },
      { display: 'Sent.', message: 'Hello.', success: true }, resumeResult('kid', false), resumeResult('kid.x'), resumeResult('kid/../kid'),
      { ...resumeResult('kid'), resumedAgentId: 7 }, { ...resumeResult('kid'), success: 'true' }];
    for (const [index, result] of others.entries()) {
      assert.deepEqual(await step(sendMessage(-43_000 + index * 1000, result)), [false, 'idle'], `${JSON.stringify(result)} ${maxBytes}`);
    }

    // Until the child writes its first new event, its work is unknown.
    assert.deepEqual(await step(sendMessage(-30_000, resumeResult('kid'))), [undefined, 'unknown'], `resume ${maxBytes}`);
    // The message record alone starts the task of the child.
    assert.deepEqual(await step([], [resumeMessage(-29_950)]), [true, 'working'], `message ${maxBytes}`);
    assert.deepEqual(await step([], [resumeWork(-27_000)]), [true, 'working'], `resumed ${maxBytes}`);
    assert.deepEqual(await step([resumeNotice(-24_000, 'kid'), resumeEnd(-23_500)], [resumeEnd(-25_000)]), [false, 'idle'], `second end ${maxBytes}`);
    // In the main transcript, a meta record starts no task.
    assert.deepEqual(await step([resumeEvent('user', -23_000, { isMeta: true, message: { content: 'A note.' } })]), [false, 'idle'], `meta ${maxBytes}`);
    assert.deepEqual(await step(sendMessage(-20_000, resumeResult('kid')), [resumeMessage(-19_950)]), [true, 'working'], `second resume ${maxBytes}`);
    const before = getClaudeCacheStats().jsonlSignals.bytesRead;
    const failed = [resumeNotice(-15_000, 'kid', 'failed'), resumeEnd(-14_500)];
    assert.deepEqual(await step(failed), [false, 'idle'], `third end ${maxBytes}`);
    // Only the guard and the appended part of the main transcript are read.
    if (maxBytes) assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead - before, 64 + Buffer.byteLength(jsonl(failed)));
  }
});

// The app moved the session into a worktree: it copied the transcript and its subagent logs into a new project folder.
// The old copy ends idle; only the new copy has the resume of the background Agent child.
async function movedSessionFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-moved-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', 'local_root.json'), JSON.stringify({ sessionId: 'local_root', cliSessionId: 'cli_root' }));
  const ended = [...resumeLaunch('kid'), resumeNotice(-44_000, 'kid'), resumeEnd(-43_500)];
  const childEnded = [resumePrompt(-48_800), resumeWork(-48_500), resumeEnd(-45_000)];
  const files = {};
  for (const [name, folder, records, childRecords, offset] of [['old', 'a-old', ended, childEnded, -40_000],
    ['current', 'z-new', [...ended, ...sendMessage(-20_000, resumeResult('kid'))], [...childEnded, resumeMessage(-19_950), resumeWork(-19_000)], -18_000]]) {
    const file = path.join(projectsDir, folder, 'cli_root.jsonl'), child = path.join(projectsDir, folder, 'cli_root', 'subagents', 'agent-kid.jsonl');
    await mkdir(path.dirname(child), { recursive: true });
    await writeFile(file, jsonl(records));
    await writeFile(child, jsonl(childRecords));
    await utimes(file, (resumeNowMs + offset) / 1000, (resumeNowMs + offset) / 1000);
    files[name] = file;
  }
  // The old copy comes last in walk order, so a reader that keeps the last copy gets the old state.
  const readdir = fsPromises.readdir;
  t.mock.method(fsPromises, 'readdir', async (directory, ...rest) => {
    if (directory === path.dirname(files.old)) await new Promise((resolve) => setTimeout(resolve, 20));
    return readdir(directory, ...rest);
  });
  return { files, load: async () => {
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs: resumeNowMs });
    return [threads[0].lifecycleRunning, buildSwitchboardDashboard(threads, [], resumeNowMs).threads[0].state];
  } };
}

test('a Claude Desktop session with a transcript copy in more than one project folder reads the newest copy', async (t) => {
  const fixture = await movedSessionFixture(t);
  assert.deepEqual(await fixture.load(), [true, 'working']);
});

test('the newest transcript copy comes from a current stat, not from the cached project index', async (t) => {
  const fixture = await movedSessionFixture(t);
  assert.deepEqual(await fixture.load(), [true, 'working']);
  await utimes(fixture.files.old, (resumeNowMs - 1000) / 1000, (resumeNowMs - 1000) / 1000);
  const hits = getClaudeCacheStats().projectIndex.hits;
  assert.deepEqual(await fixture.load(), [false, 'idle']);
  assert.equal(getClaudeCacheStats().projectIndex.hits, hits + 1);
});

test('a Claude Desktop session with one transcript copy gets no extra stat of its transcript', async (t) => {
  const { step, projectsDir } = await resumeFixture(t, 'kid', [...resumeLaunch('kid'), ...sendMessage(-20_000, resumeResult('kid'))],
    [resumeMessage(-19_950), resumeWork(-19_000)]);
  assert.deepEqual(await step(), [true, 'working']);
  const root = path.join(projectsDir, 'project', 'cli_root.jsonl'), stat = fsPromises.stat;
  let rootStats = 0;
  t.mock.method(fsPromises, 'stat', (filePath, ...rest) => {
    if (filePath === root) rootStats += 1;
    return stat(filePath, ...rest);
  });
  const { threads } = await loadClaudeDesktopCodeThreads({ appDir: path.join(projectsDir, '..', 'Claude'), projectsDir, nowMs: resumeNowMs });
  assert.equal(threads[0].lifecycleRunning, true);
  // The signal reader stats the transcript once; the copy lookup adds no stat.
  assert.equal(rootStats, 1);
});

test('a resume of an Agent child whose launch is not in the transcript makes its chat Working', async (t) => {
  for (const call of [true, false]) {
    const { step } = await resumeFixture(t, 'old', [resumeEvent('user', -50_000, { message: { content: 'Ask the old task for more.' } }),
      ...sendMessage(-49_000, resumeResult('old'), call)], [resumeEnd(-55_000), resumePrompt(-48_800), resumeWork(-48_500)]);
    assert.deepEqual(await step(), [true, 'working'], String(call));
    // A stopped child writes no end record: only the notification ends its link. A stopped notification starts no turn.
    assert.deepEqual(await step([resumeNotice(-40_000, 'old', call ? 'completed' : 'stopped'), ...(call ? [resumeEnd(-39_500)] : [])],
      call ? [resumeEnd(-41_000)] : []), [false, 'idle'], String(call));
  }
});

test('a queued task notification ends the link of its Agent child', async (t) => {
  for (const maxBytes of [0, 256]) {
    for (const status of ['completed', 'failed', 'stopped', 'killed']) {
      // The child log gets no end record: only the notification can end the link.
      const { step } = await resumeFixture(t, 'kid', resumeLaunch('kid'), [resumePrompt(-48_800), resumeWork(-48_500)], maxBytes);
      assert.deepEqual(await step(), [true, 'working'], `launch ${status} ${maxBytes}`);
      const others = [queuedNotice(-44_000, 'kid', ''), queuedNotice(-43_000, 'kid', status, { type: 'queued_note' }),
        queuedNotice(-42_000, 'kid', status, { prompt: [`<task-notification><task-id>kid</task-id><status>${status}</status></task-notification>`] })];
      for (const record of others) assert.deepEqual(await step([record]), [true, 'working'], `${JSON.stringify(record.attachment)} ${maxBytes}`);
      assert.deepEqual(await step([queuedNotice(-40_000, 'kid', status)]), [false, 'idle'], `${status} ${maxBytes}`);
    }
  }
});

// The state path false: the tracker never reads or writes a state file.
async function observeFixture(projectsDir, nowMs = resumeNowMs, tracker = new PendingTracker(false)) {
  const { threads } = await loadClaudeDesktopCodeThreads({ appDir: path.join(projectsDir, '..', 'Claude'), projectsDir, nowMs });
  const board = await tracker.observe(buildSwitchboardDashboard(threads, [], nowMs));
  return { thread: threads[0], row: board.threads[0], board };
}

test('a delivered task notification at an idle chat starts a turn, and its text-only reply ends it with a completion', async (t) => {
  for (const maxBytes of [0, 256]) {
    const { step, projectsDir } = await resumeFixture(t, 'kid', resumeLaunch('kid'),
      [resumePrompt(-48_800), resumeWork(-48_500), resumeEnd(-45_000)], maxBytes);
    const tracker = new PendingTracker(false);
    assert.deepEqual(await step(), [false, 'idle'], `before ${maxBytes}`);
    await observeFixture(projectsDir, resumeNowMs, tracker);
    assert.deepEqual(await step([resumeNotice(-44_000, 'kid')]), [true, 'working'], `notice ${maxBytes}`);
    const working = await observeFixture(projectsDir, resumeNowMs, tracker);
    assert.equal(working.thread.agentStartedAtMs, resumeNowMs - 44_000, `start ${maxBytes}`);
    assert.equal(working.row.unread, false, `not unread ${maxBytes}`);
    assert.deepEqual(await step([resumeEnd(-43_000)]), [false, 'idle'], `reply ${maxBytes}`);
    const ended = await observeFixture(projectsDir, resumeNowMs, tracker);
    assert.deepEqual([ended.row.completionAtMs, ended.row.completionAttention], [resumeNowMs - 43_000, true], `completion ${maxBytes}`);
  }
});

test('a next-task Discard armed at an idle chat covers the turn that a delivered task notification starts', async (t) => {
  for (const maxBytes of [0, 256]) {
    const { step, projectsDir } = await resumeFixture(t, 'kid', resumeLaunch('kid'),
      [resumePrompt(-48_800), resumeWork(-48_500), resumeEnd(-45_000)], maxBytes);
    const tracker = new PendingTracker(false);
    assert.deepEqual(await step(), [false, 'idle'], `before ${maxBytes}`);
    const idle = await observeFixture(projectsDir, resumeNowMs, tracker);
    await tracker.setDiscard(idle.row, true, true);
    assert.equal(idle.row.discardResult, true, `armed ${maxBytes}`);
    assert.deepEqual(await step([resumeNotice(-44_000, 'kid')]), [true, 'working'], `notice ${maxBytes}`);
    assert.equal((await observeFixture(projectsDir, resumeNowMs, tracker)).row.discardResult, true, `working ${maxBytes}`);
    assert.deepEqual(await step([resumeEnd(-43_000)]), [false, 'idle'], `reply ${maxBytes}`);
    const ended = await observeFixture(projectsDir, resumeNowMs, tracker);
    assert.deepEqual([ended.row.discardResult, ended.row.completionAttention, ended.row.unread, ended.row.pending], [false, false, false, false], `discarded ${maxBytes}`);
  }
});

test('a Discard armed while a background Agent runs survives the reply to its task notification', async (t) => {
  for (const maxBytes of [0, 256]) {
    for (const reply of [[resumeEnd(-43_000)], [resumeWork(-43_500), resumeEnd(-43_000)]]) {
      const { step, projectsDir } = await resumeFixture(t, 'kid', resumeLaunch('kid'), [resumePrompt(-48_800), resumeWork(-48_500)], maxBytes);
      const tracker = new PendingTracker(false);
      assert.deepEqual(await step(), [true, 'working'], `launch ${maxBytes}`);
      const armed = await observeFixture(projectsDir, resumeNowMs, tracker);
      await tracker.setDiscard(armed.row, true);
      assert.deepEqual(await step([resumeNotice(-44_000, 'kid')], [resumeEnd(-45_000)]), [true, 'working'], `notice ${maxBytes}`);
      const notice = await observeFixture(projectsDir, resumeNowMs, tracker);
      assert.equal(notice.row.discardResult, true, `still armed ${maxBytes}`);
      assert.deepEqual(await step(reply), [false, 'idle'], `reply ${maxBytes}`);
      const ended = await observeFixture(projectsDir, resumeNowMs, tracker);
      assert.deepEqual([ended.row.unread, ended.row.pending], [false, false], `discarded ${reply.length} ${maxBytes}`);
    }
  }
});

test('a stopped, killed, queued, or transcript-only task notification starts no turn', async (t) => {
  for (const maxBytes of [0, 256]) {
    for (const status of ['stopped', 'killed']) {
      // These usually get no reply, so they must not leave the chat Working.
      const { step } = await resumeFixture(t, 'kid', resumeLaunch('kid'), [resumePrompt(-48_800), resumeWork(-48_500)], maxBytes);
      assert.deepEqual(await step([resumeNotice(-44_000, 'kid', status)]), [false, 'idle'], `${status} ${maxBytes}`);
    }
    const copy = await resumeFixture(t, 'kid', resumeLaunch('kid'), [resumePrompt(-48_800), resumeWork(-48_500)], maxBytes);
    assert.deepEqual(await copy.step([{ ...resumeNotice(-44_000, 'kid'), queueTranscriptOnly: true }]), [false, 'idle'], `copy ${maxBytes}`);
    // A queued notification arrives while the chat runs: the turn and its start time continue.
    const busy = await resumeFixture(t, 'kid', [...resumeLaunch('kid'), resumePrompt(-30_000), resumeWork(-29_000)],
      [resumePrompt(-48_800), resumeWork(-48_500)], maxBytes);
    assert.deepEqual(await busy.step([queuedNotice(-28_000, 'kid')]), [true, 'working'], `queued ${maxBytes}`);
    assert.equal((await observeFixture(busy.projectsDir)).thread.latestTaskStartedAtMs, resumeNowMs - 30_000, `queued start ${maxBytes}`);
  }
});

test('a message from another session starts a turn only in an idle chat', async (t) => {
  const message = (offset) => resumeEvent('user', offset, { isMeta: true, message: { content:
    'Another session sent a message.\n<cross-session-message from-session="local_00000000-0000-4000-8000-000000000001">Hello.</cross-session-message>' } });
  const fixture = await signalFixture(t, [resumePrompt(-50_000), resumeEnd(-49_000)]);
  const tracker = new PendingTracker(false);
  await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
  await appendFile(fixture.file, jsonl([message(-40_000)]));
  const working = await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
  assert.deepEqual([working.thread.lifecycleRunning, working.row.state, working.thread.latestTaskStartedAtMs],
    [true, 'working', resumeNowMs - 40_000]);
  await appendFile(fixture.file, jsonl([resumeEnd(-39_000)]));
  const ended = await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
  assert.deepEqual([ended.row.state, ended.row.completionAtMs, ended.row.completionAttention], ['idle', resumeNowMs - 39_000, true]);
  // During a running turn the message does not move the start time.
  await appendFile(fixture.file, jsonl([resumePrompt(-30_000), resumeWork(-29_000), message(-28_000)]));
  const busy = await fixture.load();
  assert.deepEqual([busy.lifecycleRunning, busy.latestTaskStartedAtMs, busy.agentStartedAtMs], [true, resumeNowMs - 30_000, resumeNowMs - 30_000]);
});

test('a live Claude registry record in the waiting status shows a permission prompt or a question as Waiting', async (t) => {
  const fixture = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000)]);
  const sessions = path.join(path.dirname(fixture.projectsDir), 'sessions');
  await mkdir(sessions);
  const children = [];
  t.after(() => Promise.all(children.map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  })));
  const start = async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    return { child, pid: child.pid, procStart: (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ').pop().split(' ')[19] };
  };
  const record = (peer, fields = {}) => writeFile(path.join(sessions, `${peer.pid}.json`), JSON.stringify({ pid: peer.pid,
    procStart: peer.procStart, sessionId: 'other-cli', hostSessionId: 'local_root', name: 'synthetic', status: 'waiting',
    waitingFor: 'permission prompt', statusUpdatedAt: resumeNowMs - 21_000, ...fields }));
  const tracker = new PendingTracker(false);
  const view = async () => {
    const { thread, row } = await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
    return { thread, row, summary: [row.state, row.actionRequired, row.questionPending, row.questionAttention, row.pending] };
  };
  const working = ['working', false, false, false, false];
  // The open task is older than the start grace, so with no live record of the session its process ended.
  const ended = ['unknown', false, false, false, false];
  // An ordinary Bash call leaves no transcript wait signal; the empty registry has no live record.
  assert.deepEqual((await view()).summary, ended);
  const live = await start();
  await record(live);
  const permission = await view();
  assert.deepEqual(permission.summary, ['waiting', true, false, false, true]);
  assert.deepEqual([permission.row.reason, permission.row.pendingSource, permission.thread.liveWaitingFor, permission.thread.pendingToolAtMs],
    ['Claude waits for your permission.', 'user-action', 'permission prompt', resumeNowMs - 21_000]);
  // Each load starts from the transcript, so a later status leaves no stale overlay.
  await record(live, { status: 'busy', statusUpdatedAt: resumeNowMs - 20_900 });
  assert.deepEqual((await view()).summary, working);
  await record(live, { procStart: '1' });
  assert.deepEqual((await view()).summary, ended);
  const dead = await start();
  dead.child.kill();
  await once(dead.child, 'exit');
  await record(dead);
  assert.deepEqual((await view()).summary, ended);
  await record(live, { waitingFor: 'input needed', statusUpdatedAt: resumeNowMs - 20_800 });
  const question = await view();
  assert.deepEqual(question.summary, ['waiting', false, true, true, true]);
  assert.deepEqual([question.row.reason, question.row.pendingSource], ['Claude waits for your answer.', 'user-question']);
  await tracker.acknowledge(question.row.id);
  assert.equal((await view()).row.questionAttention, false);
  await record(live, { status: 'busy', statusUpdatedAt: resumeNowMs - 20_700 });
  await view();
  await record(live, { waitingFor: 'input needed', statusUpdatedAt: resumeNowMs - 20_600 });
  assert.equal((await view()).row.questionAttention, true);
  // Without a host match, the CLI session id selects records, and the newest one wins.
  const other = await start();
  await record(live, { hostSessionId: null, sessionId: 'cli_root', statusUpdatedAt: resumeNowMs - 20_500 });
  await record(other, { hostSessionId: null, sessionId: 'cli_root', status: 'busy', statusUpdatedAt: resumeNowMs - 20_400 });
  assert.equal((await view()).row.state, 'working');
  await record(live, { hostSessionId: null, sessionId: 'cli_root', statusUpdatedAt: resumeNowMs - 20_300 });
  assert.equal((await view()).row.actionRequired, true);
  // A host match wins over a newer CLI session match.
  await record(other, { status: 'busy', statusUpdatedAt: resumeNowMs - 21_000 });
  assert.equal((await view()).row.state, 'working');
});

test('a Desktop Code chat with an open task shows Unknown when no live process has its session, after the start grace', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async (t) => {
  const fixture = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000)]);
  const sessions = path.join(path.dirname(fixture.projectsDir), 'sessions');
  await mkdir(sessions);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  await once(child, 'spawn');
  const procStart = (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ').pop().split(' ')[19];
  // The only live record belongs to another session.
  await writeFile(path.join(sessions, `${child.pid}.json`), JSON.stringify({ pid: child.pid, procStart, sessionId: 'other-cli',
    hostSessionId: 'local_other', name: 'synthetic', status: 'busy', statusUpdatedAt: resumeNowMs - 21_000 }));
  const activityAtMs = resumeNowMs - 49_000;
  const view = async (nowMs) => {
    const { thread, row } = await observeFixture(fixture.projectsDir, nowMs);
    return [row.state, row.reason, thread.cliProcessEnded, thread.cliProcessCheckAtMs];
  };
  assert.deepEqual(await view(resumeNowMs), ['unknown', 'The Claude Code process ended during a task.', true, undefined]);
  // A turn of the last seconds can come before the registry record that names its session.
  assert.deepEqual((await view(activityAtMs + 5_000)).filter((_, index) => index !== 1), ['working', undefined, activityAtMs + 10_000]);
  // A registry that cannot be read marks nothing.
  await chmod(sessions, 0o000);
  try { assert.deepEqual((await view(resumeNowMs)).filter((_, index) => index !== 1), ['working', undefined, undefined]); }
  finally { await chmod(sessions, 0o700); }
});

// The Desktop app ends some turns with a wrap-up tool. Its result ends the turn; the app can write more records after it.
const wrapUp = (offset, id, ask) => [
  resumeEvent('assistant', offset, { message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up',
    input: { recap: 'SYNTHETIC_RECAP', ...(ask === undefined ? {} : { ask }),
      actions: [{ label: 'SYNTHETIC_LABEL', message: 'SYNTHETIC_MESSAGE' }] } }] } }),
  resumeEvent('user', offset + 100, { message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] } }),
];

test('a Claude wrap-up with a question waits for the answer, and the next prompt clears it', async (t) => {
  const fixture = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000), ...wrapUp(-40_000, 'wrap', 'SYNTHETIC_ASK?')]);
  const tracker = new PendingTracker(false);
  const asked = await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
  assert.deepEqual([asked.thread.lifecycleRunning, asked.thread.latestLifecycleKind, asked.thread.latestLifecycleAtMs],
    [false, 'task_complete', resumeNowMs - 39_900]);
  assert.deepEqual([asked.row.state, asked.row.questionPending, asked.row.questionAttention, asked.row.actionRequired,
    asked.row.pending, asked.row.pendingSource], ['waiting', true, true, false, true, 'user-question']);
  assert.equal(asked.thread.pendingToolAtMs, resumeNowMs - 39_900);
  assert.doesNotMatch(JSON.stringify([asked.thread, asked.row]), /SYNTHETIC_/);
  await appendFile(fixture.file, jsonl([resumePrompt(-30_000)]));
  const answered = await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
  assert.deepEqual([answered.row.state, answered.row.questionPending, answered.thread.pendingToolCount], ['working', false, 0]);
  // The question is current for six hours only, like a pending AskUserQuestion.
  const stale = await signalFixture(t, [resumePrompt(-50_000), ...wrapUp(-40_000, 'wrap', 'SYNTHETIC_ASK?')]);
  const later = resumeNowMs + 7 * 60 * 60 * 1000;
  assert.equal(buildSwitchboardDashboard([await stale.load(later)], [], later).threads[0].questionPending, false);
});

test('a Claude wrap-up without a question is a completion', async (t) => {
  for (const ask of [undefined, '', '  ']) {
    const fixture = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000)]);
    const tracker = new PendingTracker(false);
    await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
    await appendFile(fixture.file, jsonl(wrapUp(-40_000, 'wrap', ask)));
    const ended = await observeFixture(fixture.projectsDir, resumeNowMs, tracker);
    assert.deepEqual([ended.row.state, ended.row.questionPending, ended.thread.pendingToolCount, ended.row.completionAtMs,
      ended.row.completionAttention], ['idle', false, 0, resumeNowMs - 39_900, true], `ask ${JSON.stringify(ask)}`);
  }
});

test('a Claude wrap-up ends the turn in the lifecycle-only scan of a large file and in appended reads', async (t) => {
  const padding = resumeEvent('progress', -45_000, { data: 'x'.repeat(4096) });
  const large = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000), padding, ...wrapUp(-40_000, 'wrap', 'SYNTHETIC_ASK?')], 256);
  const small = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000), padding, ...wrapUp(-40_000, 'wrap', 'SYNTHETIC_ASK?')]);
  const [big, full] = [await large.load(), await small.load()];
  for (const key of ['lifecycleRunning', 'latestLifecycleKind', 'latestLifecycleAtMs', 'latestTaskEndedAtMs', 'latestTaskEndKind', 'latestAgentFinalAtMs']) {
    assert.deepEqual(big[key], full[key], key);
  }
  assert.equal(big.lifecycleRunning, false);
  const appended = await signalFixture(t, [resumePrompt(-50_000), resumeWork(-49_000), padding], 256);
  await appended.load();
  await appendFile(appended.file, jsonl(wrapUp(-40_000, 'wrap', 'SYNTHETIC_ASK?')));
  const thread = await appended.load();
  assert.deepEqual([thread.lifecycleRunning, buildSwitchboardDashboard([thread], [], resumeNowMs).threads[0].state], [false, 'waiting']);
});

test('a wake after a Claude wrap-up question clears the question and starts a turn', async (t) => {
  const message = resumeEvent('user', -30_000, { isMeta: true, message: { content:
    'Another session sent a message.\n<cross-session-message from-session="local_00000000-0000-4000-8000-000000000001">Hello.</cross-session-message>' } });
  for (const wake of [message, resumeNotice(-30_000, 'kid')]) {
    const fixture = await signalFixture(t, [resumePrompt(-50_000), ...wrapUp(-40_000, 'wrap', 'SYNTHETIC_ASK?')]);
    assert.equal((await fixture.load()).pendingToolCount, 1);
    await appendFile(fixture.file, jsonl([wake]));
    const thread = await fixture.load();
    assert.deepEqual([thread.lifecycleRunning, thread.pendingToolCount, buildSwitchboardDashboard([thread], [], resumeNowMs).threads[0].state],
      [true, 0, 'working']);
  }
});

test('a human prompt with only images starts a turn', async (t) => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } };
  const fixture = await signalFixture(t, [resumePrompt(-50_000), resumeEnd(-49_000)]);
  // An image in a tool result is not a prompt.
  await appendFile(fixture.file, jsonl([resumeEvent('user', -45_000, { message: { content: [{ type: 'tool_result', tool_use_id: 'x' }, image] } })]));
  assert.equal((await fixture.load()).lifecycleRunning, false);
  await appendFile(fixture.file, jsonl([resumeEvent('user', -40_000, { message: { content: [image] } })]));
  const thread = await fixture.load();
  assert.deepEqual([thread.lifecycleRunning, thread.latestTaskStartedAtMs], [true, resumeNowMs - 40_000]);
});

test('a linked child log that ended without a task notification keeps the chat Working for 10 s', async (t) => {
  for (const maxBytes of [0, 256]) {
    const { projectsDir } = await resumeFixture(t, 'kid', resumeLaunch('kid'),
      [resumePrompt(-48_800), resumeWork(-48_500), resumeEnd(-5_000)], maxBytes);
    const grace = await observeFixture(projectsDir);
    assert.deepEqual([grace.row.state, grace.thread.agentActivityAtMs, grace.thread.groupTaskEndedAtMs],
      ['working', resumeNowMs - 5_000, 0], `grace ${maxBytes}`);
    assert.equal(grace.board.nextStatusCheckAtMs, resumeNowMs - 5_000 + 10_001, `check ${maxBytes}`);
    assert.equal((await observeFixture(projectsDir, resumeNowMs + 5_000)).row.state, 'working', `last ${maxBytes}`);
    const ended = await observeFixture(projectsDir, resumeNowMs + 5_001);
    assert.deepEqual([ended.row.state, ended.thread.groupTaskEndedAtMs], ['idle', resumeNowMs - 5_000], `end ${maxBytes}`);
  }
});

test('a late queued task notification of an earlier run does not end a resumed Agent child', async (t) => {
  for (const maxBytes of [0, 256]) {
    const { step } = await resumeFixture(t, 'kid', resumeLaunch('kid'), [resumePrompt(-48_800), resumeWork(-48_500), resumeEnd(-45_000)], maxBytes);
    assert.deepEqual(await step(sendMessage(-30_000, resumeResult('kid')), [resumeMessage(-29_950), resumeWork(-29_000)]), [true, 'working'], `resume ${maxBytes}`);
    // The record is after the resume result in the file, but its time is the end of the first run.
    assert.deepEqual(await step([queuedNotice(-45_000, 'kid')]), [true, 'working'], `late ${maxBytes}`);
    assert.deepEqual(await step([queuedNotice(-20_000, 'kid')]), [false, 'idle'], `end ${maxBytes}`);
  }
});

test('a linked Agent child log in another session folder of the same project folder sets the chat state', async (t) => {
  const open = [resumePrompt(-48_800), resumeWork(-48_500)], ended = [...open, resumeEnd(-45_000)];
  const addLog = async (projectsDir, folder, records, mtime) => {
    const file = path.join(projectsDir, folder, 'subagents', 'agent-kid.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, jsonl(records));
    if (mtime) await utimes(file, mtime, mtime);
    return file;
  };
  for (const maxBytes of [0, 256]) {
    const { step } = await resumeFixture(t, 'kid', resumeLaunch('kid'), open, maxBytes, 'project/cli_old');
    assert.deepEqual(await step(), [true, 'working'], `open ${maxBytes}`);
    assert.deepEqual(await step([], [resumeEnd(-45_000)]), [false, 'idle'], `end ${maxBytes}`);

    // Two other session folders have the log: the newest mtime decides.
    const two = await resumeFixture(t, 'kid', resumeLaunch('kid'), ended, maxBytes, 'project/cli_a');
    const fileA = path.join(two.projectsDir, 'project', 'cli_a', 'subagents', 'agent-kid.jsonl');
    await utimes(fileA, 1000, 1000);
    const fileB = await addLog(two.projectsDir, 'project/cli_b', open, 2000);
    assert.deepEqual(await two.step(), [true, 'working'], `newest open ${maxBytes}`);
    // The file index is not cleared here: the reader must get the current mtime.
    await utimes(fileA, 3000, 3000);
    const load = async () => (await loadClaudeDesktopCodeThreads({ appDir: path.join(two.projectsDir, '..', 'Claude'),
      projectsDir: two.projectsDir, nowMs: resumeNowMs, ...(maxBytes ? { maxBytes } : {}) })).threads[0].lifecycleRunning;
    assert.equal(await load(), false, `newest ended ${maxBytes}`);
    await utimes(fileB, 4000, 4000);
    assert.equal(await load(), true, `newest open again ${maxBytes}`);

    // The own log of the root decides, also when another log is newer.
    for (const [own, other] of [[ended, open], [open, ended]]) {
      const both = await resumeFixture(t, 'kid', resumeLaunch('kid'), own, maxBytes);
      await utimes(path.join(both.projectsDir, 'project', 'cli_root', 'subagents', 'agent-kid.jsonl'), 1000, 1000);
      await addLog(both.projectsDir, 'project/cli_new', other, 2000);
      assert.deepEqual(await both.step(), own === open ? [true, 'working'] : [false, 'idle'], `own ${own === open} ${maxBytes}`);
    }

    // A log in a different project folder is not used.
    const far = await resumeFixture(t, 'kid', resumeLaunch('kid'), open, maxBytes, 'other-project/cli_old');
    assert.deepEqual(await far.step(), [undefined, 'unknown'], `other project ${maxBytes}`);
    // A log that the root does not link cannot change the chat.
    const loose = await resumeFixture(t, 'loose', [resumePrompt(-50_000), resumeEnd(-48_000)], open, maxBytes, 'project/cli_old');
    assert.deepEqual(await loose.step(), [false, 'idle'], `not linked ${maxBytes}`);
  }
});

test('a context compaction keeps the task, its start time, and the Agent calls that follow it', async (t) => {
  const boundary = (offset) => [resumeEvent('system', offset, { subtype: 'compact_boundary' }), resumeEvent('user', offset,
    { isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session continues an earlier conversation.' } })];
  const load = async ({ projectsDir }) => (await loadClaudeDesktopCodeThreads({ appDir: path.join(projectsDir, '..', 'Claude'), projectsDir,
    nowMs: resumeNowMs })).threads[0].agentStartedAtMs;
  for (const maxBytes of [0, 256]) {
    // As in a real transcript, the records of the open turn come after the summary and are older than the summary.
    const busy = await resumeFixture(t, 'kid', [resumeEvent('user', -90_000, { message: { content: 'Do a long task.' } }), resumeWork(-89_000),
      ...boundary(-40_000), resumeEvent('assistant', -60_000, { message: { content: [{ type: 'thinking', thinking: '' }] } }),
      resumeEvent('assistant', -59_000, { message: { content: [{ type: 'tool_use', id: 'launch', name: 'Agent', input: { run_in_background: true } }] } }),
      resumeEvent('user', -58_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'kid' } }),
    ], [resumePrompt(-58_800), resumeWork(-58_500)], maxBytes);
    assert.deepEqual(await busy.step(), [true, 'working'], `compaction ${maxBytes}`);
    assert.equal(await load(busy), resumeNowMs - 90_000, `start ${maxBytes}`);
    assert.deepEqual(await busy.step([resumeEnd(-30_000)]), [true, 'working'], `child after compaction ${maxBytes}`);
    assert.equal(await load(busy), resumeNowMs - 90_000, `child start ${maxBytes}`);
    assert.deepEqual(await busy.step([resumeNotice(-20_000, 'kid'), resumeEnd(-19_500)], [resumeEnd(-21_000)]), [false, 'idle'], `end ${maxBytes}`);

    const idle = await resumeFixture(t, 'none', [resumeEvent('user', -90_000, { message: { content: 'Hello.' } }), resumeEnd(-80_000),
      ...boundary(-40_000)], [], maxBytes);
    assert.deepEqual(await idle.step(), [false, 'idle'], `idle ${maxBytes}`);
  }
});

test('an assistant record with a tool call does not end the turn, also with the stop reason refusal', async (t) => {
  const refusal = (content) => [resumeEvent('user', -50_000, { message: { content: 'Start a background task.' } }),
    resumeEvent('assistant', -49_000, { message: { stop_reason: 'refusal', content } })];
  const { step } = await resumeFixture(t, 'kid', [...refusal([{ type: 'tool_use', id: 'launch', name: 'Agent', input: { run_in_background: true } }]),
    resumeEvent('user', -48_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'kid' } })], [resumePrompt(-48_800), resumeWork(-48_500)]);
  assert.deepEqual(await step(), [true, 'working']);
  // The main turn ends; the call of the refusal record made the link, so the child keeps the chat Working.
  assert.deepEqual(await step([resumeEnd(-48_000)]), [true, 'working']);
  assert.deepEqual(await step([resumeNotice(-40_000, 'kid'), resumeEnd(-39_500)]), [false, 'idle']);
  const plain = await resumeFixture(t, 'none', refusal([{ type: 'text', text: 'No.' }]), []);
  assert.deepEqual(await plain.step(), [false, 'idle']);
});

const workflowResult = (extra = {}) => ({ status: 'async_launched', taskId: 'wtask0001', runId: 'wf_run1', taskType: 'local_workflow', ...extra });
const workflowLaunch = (toolUseResult = workflowResult(), name = 'Workflow') => [
  resumeEvent('user', -50_000, { message: { content: 'Start a workflow.' } }),
  resumeEvent('assistant', -49_000, { message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'flow', name, input: { script: 'x' } }] } }),
  resumeEvent('user', -48_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'flow' }] }, toolUseResult }),
  resumeEnd(-48_000),
];
// folder is relative to the projects folder. offset is the file time of the two logs, relative to resumeNowMs.
async function workflowLogs(projectsDir, folder, offset, runId = 'wf_run1') {
  const dir = path.join(projectsDir, folder, 'subagents', 'workflows', runId);
  await mkdir(dir, { recursive: true });
  const files = ['agent-a1.jsonl', 'journal.jsonl'].map((name) => path.join(dir, name));
  const touch = async (ms) => { for (const file of files) await utimes(file, new Date(resumeNowMs + ms), new Date(resumeNowMs + ms)); };
  for (const file of files) await writeFile(file, jsonl([{ type: 'started' }]));
  await touch(offset);
  return touch;
}

test('a background workflow keeps its chat Working until the task notification', async (t) => {
  for (const maxBytes of [0, 256]) {
    for (const [index, notice] of [resumeNotice(-10_000, 'wtask0001'), resumeNotice(-10_000, 'wtask0001', 'failed'), resumeNotice(-10_000, 'wtask0001', 'stopped'),
      queuedNotice(-10_000, 'wtask0001'), queuedNotice(-10_000, 'wtask0001', 'failed'), queuedNotice(-10_000, 'wtask0001', 'stopped')].entries()) {
      const { step, projectsDir } = await resumeFixture(t, 'none', workflowLaunch(), [], maxBytes);
      // No folder of the run.
      assert.deepEqual(await step(), [undefined, 'unknown'], `no folder ${index} ${maxBytes}`);
      // All files are older than the launch call.
      const touch = await workflowLogs(projectsDir, 'project/cli_root', -49_500);
      assert.deepEqual(await step(), [undefined, 'unknown'], `old files ${index} ${maxBytes}`);
      await touch(-20_000);
      assert.deepEqual(await step(), [true, 'working'], `run ${index} ${maxBytes}`);
      const { threads } = await loadClaudeDesktopCodeThreads({ appDir: path.join(projectsDir, '..', 'Claude'), projectsDir,
        nowMs: resumeNowMs, ...(maxBytes ? { maxBytes } : {}) });
      assert.equal(threads[0].agentStartedAtMs, resumeNowMs - 50_000, `start ${index} ${maxBytes}`);
      assert.equal(threads[0].agentActivityAtMs, resumeNowMs - 20_000, `activity ${index} ${maxBytes}`);
      assert.deepEqual(await step([resumeNotice(-15_000, 'wf_run1'), resumeNotice(-14_000, 'a1'), resumeEnd(-13_500)]),
        [true, 'working'], `other ID ${index} ${maxBytes}`);
      // A delivered completed or failed notification gets a reply; a stopped one and a queued one start no turn.
      assert.deepEqual(await step([notice, ...(index < 2 ? [resumeEnd(-9_500)] : [])]), [false, 'idle'], `end ${index} ${maxBytes}`);
    }
  }
});

test('the folder of a workflow run in another session folder of the same project folder sets the chat state', async (t) => {
  for (const maxBytes of [0, 256]) {
    const other = await resumeFixture(t, 'none', workflowLaunch(), [], maxBytes);
    const touch = await workflowLogs(other.projectsDir, 'project/cli_old', -20_000);
    assert.deepEqual(await other.step(), [true, 'working'], `other folder ${maxBytes}`);
    // The file index is not cleared here: the reader must get the current file time.
    await touch(-49_500);
    assert.equal((await loadClaudeDesktopCodeThreads({ appDir: path.join(other.projectsDir, '..', 'Claude'), projectsDir: other.projectsDir,
      nowMs: resumeNowMs, ...(maxBytes ? { maxBytes } : {}) })).threads[0].lifecycleRunning, undefined, `current time ${maxBytes}`);

    // The own folder of the root decides, also when another folder is newer.
    for (const [own, far] of [[-49_500, -20_000], [-20_000, -49_500]]) {
      const both = await resumeFixture(t, 'none', workflowLaunch(), [], maxBytes);
      await workflowLogs(both.projectsDir, 'project/cli_root', own);
      await workflowLogs(both.projectsDir, 'project/cli_new', far);
      assert.deepEqual(await both.step(), own > far ? [true, 'working'] : [undefined, 'unknown'], `own ${own} ${maxBytes}`);
    }

    const different = await resumeFixture(t, 'none', workflowLaunch(), [], maxBytes);
    await workflowLogs(different.projectsDir, 'other-project/cli_old', -20_000);
    await workflowLogs(different.projectsDir, 'project/cli_old', -20_000, 'wf_run2');
    // A `workflows` folder that is not directly in a `subagents` folder is not the folder of a run.
    const stray = path.join(different.projectsDir, 'project', 'cli_old', 'other', 'workflows', 'wf_run1');
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, 'agent-a1.jsonl'), jsonl([{ type: 'started' }]));
    assert.deepEqual(await different.step(), [undefined, 'unknown'], `other project or run ${maxBytes}`);

    // A folder of a run that the root did not launch cannot change the chat.
    const loose = await resumeFixture(t, 'none', [resumePrompt(-50_000), resumeEnd(-48_000)], [], maxBytes);
    await workflowLogs(loose.projectsDir, 'project/cli_root', -20_000);
    assert.deepEqual(await loose.step(), [false, 'idle'], `not linked ${maxBytes}`);
  }
});

test('a launch result that is not a valid Workflow launch makes no link', async (t) => {
  const cases = [[workflowResult({ taskId: 'w/task' })], [workflowResult({ taskId: 7 })], [workflowResult({ taskId: undefined })],
    [workflowResult({ runId: 'wf.run1' })], [workflowResult({ runId: '../wf_run1' })], [workflowResult({ runId: undefined })],
    [workflowResult({ status: 'completed' })], [workflowResult(), 'Bash'], [workflowResult(), 'Agent']];
  for (const [index, [result, name]] of cases.entries()) {
    const { step, projectsDir } = await resumeFixture(t, 'none', workflowLaunch(result, name), []);
    await workflowLogs(projectsDir, 'project/cli_root', -20_000);
    assert.deepEqual(await step(), [false, 'idle'], String(index));
  }
  // A resumed run is a new launch result: it has its own link.
  const { step, projectsDir } = await resumeFixture(t, 'none', [...workflowLaunch(), resumeNotice(-40_000, 'wtask0001', 'stopped'),
    resumeEvent('user', -30_000, { message: { content: 'Continue the workflow.' } }),
    resumeEvent('assistant', -29_000, { message: { content: [{ type: 'tool_use', id: 'again', name: 'Workflow', input: { resumeFromRunId: 'wf_run1', scriptPath: 'x' } }] } }),
    resumeEvent('user', -28_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'again' }] }, toolUseResult: workflowResult({ taskId: 'wtask0002', runId: 'wf_run2' }) }),
    resumeEnd(-28_000)], []);
  await workflowLogs(projectsDir, 'project/cli_root', -41_000);
  await workflowLogs(projectsDir, 'project/cli_root', -20_000, 'wf_run2');
  assert.deepEqual(await step(), [true, 'working'], 'resumed run');
  assert.deepEqual(await step([resumeNotice(-10_000, 'wtask0001')]), [true, 'working'], 'old task ID');
  assert.deepEqual(await step([resumeNotice(-9_000, 'wtask0002'), resumeEnd(-8_500)]), [false, 'idle'], 'new task ID');
});

test('a Claude title cut keeps whole emoji', () => {
  const title = claudeTitle(`${'x'.repeat(136)}😀${'y'.repeat(9)}`);
  assert.equal(title.isWellFormed(), true);
  assert.equal(title, `${'x'.repeat(136)}😀...`);
});

test('the time of a Claude Desktop Code row is its last turn record, and the session file time is only the last fallback', () => {
  const turnAtMs = Date.parse('2026-05-09T02:00:00.000Z');
  const laterAtMs = Date.parse('2026-05-09T05:00:00.000Z');
  const session = { sessionId: 'local_clock', cliSessionId: '123e4567-e89b-12d3-a456-426614174000' };
  const signals = parseClaudeJsonlSignals(jsonl([
    { type: 'user', timestamp: new Date(turnAtMs - 60_000).toISOString(), message: { role: 'user', content: 'Synthetic prompt' } },
    { type: 'assistant', timestamp: new Date(turnAtMs).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: 'Done.' } },
    // Records that an open or a resume writes with a timestamp and no turn.
    { type: 'attachment', timestamp: new Date(laterAtMs).toISOString(), attachment: { type: 'hook_success' } },
    { type: 'queue-operation', timestamp: new Date(laterAtMs).toISOString(), operation: 'enqueue' },
    { type: 'pr-link', timestamp: new Date(laterAtMs).toISOString() },
    { type: 'last-prompt', sessionId: 'local_clock' },
  ]));
  assert.equal(signals.latestEventAtMs, turnAtMs);
  assert.equal(signals.oldestEventAtMs, turnAtMs - 60_000);
  const time = (fields, parts) => normalizeClaudeDesktopCodeSession({ ...session, ...fields }, parts, laterAtMs + 1000).updatedAtMs;
  assert.equal(time({}, { signals, stat: { mtimeMs: laterAtMs } }), turnAtMs, 'the file time does not count while the transcript has a turn');
  assert.equal(time({ lastActivityAt: turnAtMs - 5000, lastFocusedAt: laterAtMs, indexedAt: laterAtMs }, { signals, stat: { mtimeMs: laterAtMs } }),
    turnAtMs, 'the focus and index times do not count');
  assert.equal(time({ lastActivityAt: turnAtMs + 5000 }, { signals, stat: { mtimeMs: laterAtMs } }), turnAtMs + 5000, 'the app time can be newer than the transcript');
  assert.equal(time({}, { signals: parseClaudeJsonlSignals(''), stat: { mtimeMs: laterAtMs } }), laterAtMs, 'the file time is the last fallback');
  assert.equal(time({}, {}), laterAtMs + 1000, 'the clock is the fallback of the fallback');
});

test('opening a Claude Desktop Code session keeps the time and the place of its row until a new turn', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-open-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nowMs = Date.parse('2026-05-09T12:00:00.000Z');
  const at = (minutes) => nowMs - minutes * 60_000;
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects', 'project');
  const sessions = path.join(appDir, 'claude-code-sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(projectsDir, { recursive: true });
  const names = { old: '123e4567-e89b-12d3-a456-426614174001', recent: '123e4567-e89b-12d3-a456-426614174002' };
  const turn = (name, minutes) => [
    { type: 'user', timestamp: new Date(at(minutes + 1)).toISOString(), sessionId: names[name], message: { role: 'user', content: 'Synthetic prompt' } },
    { type: 'assistant', timestamp: new Date(at(minutes)).toISOString(), sessionId: names[name],
      message: { role: 'assistant', stop_reason: 'end_turn', content: 'Done.' } }];
  const metadata = (name, minutes, extra = {}) => writeFile(path.join(sessions, `local_${name}.json`), JSON.stringify({
    sessionId: `local_${name}`, cliSessionId: names[name], cwd: '/tmp/synthetic-work', createdAt: at(600), lastActivityAt: at(minutes), ...extra }));
  for (const [name, minutes] of [['old', 300], ['recent', 60]]) {
    await writeFile(path.join(projectsDir, `${names[name]}.jsonl`), jsonl(turn(name, minutes)));
    await metadata(name, minutes);
    await utimes(path.join(sessions, `local_${name}.json`), at(minutes) / 1000, at(minutes) / 1000);
  }
  const load = async () => {
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir: path.dirname(projectsDir), nowMs });
    return buildSwitchboardDashboard(threads, [], nowMs).threads.map((row) => [row.externalId, row.updatedAtMs]);
  };
  assert.deepEqual(await load(), [['local_recent', at(60)], ['local_old', at(300)]]);

  // The app opens the old session: it rewrites the session file and the transcript gets records with no turn.
  await metadata('old', 300, { lastFocusedAt: nowMs, indexedAt: nowMs });
  await utimes(path.join(sessions, 'local_old.json'), nowMs / 1000, nowMs / 1000);
  await appendFile(path.join(projectsDir, `${names.old}.jsonl`), jsonl([
    { type: 'attachment', timestamp: new Date(at(1)).toISOString(), attachment: { type: 'hook_success' } },
    { type: 'queue-operation', timestamp: new Date(at(1)).toISOString(), operation: 'enqueue' },
    { type: 'last-prompt', sessionId: names.old }]));
  assert.deepEqual(await load(), [['local_recent', at(60)], ['local_old', at(300)]], 'the read row keeps its time and place');

  // A new turn is activity: the time and the place move.
  await appendFile(path.join(projectsDir, `${names.old}.jsonl`), jsonl(turn('old', 0.5)));
  await metadata('old', 300, { lastFocusedAt: nowMs, indexedAt: nowMs });
  assert.deepEqual(await load(), [['local_old', at(0.5)], ['local_recent', at(60)]], 'a new turn moves the time and the card');
});

test('the group time of a Claude row follows the turn records of a linked child, not the file time of a child log', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-child-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
  const childDir = path.join(projectsDir, 'project', 'cli_root', 'subagents');
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(childDir, { recursive: true });
  await writeFile(path.join(appDir, 'claude-code-sessions', 'local_root.json'), JSON.stringify({ sessionId: 'local_root', cliSessionId: 'cli_root' }));
  await writeFile(path.join(projectsDir, 'project', 'cli_root.jsonl'), jsonl(resumeLaunch('kid')));
  // The linked child works until 30 seconds before the load. An unlinked child log has an older turn.
  await writeFile(path.join(childDir, 'agent-kid.jsonl'), jsonl([resumeMessage(-40_000), resumeWork(-30_000)]));
  await writeFile(path.join(childDir, 'agent-other.jsonl'), jsonl([resumeMessage(-45_000), resumeEnd(-44_000)]));
  const load = async () => {
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs: resumeNowMs });
    const row = buildSwitchboardDashboard(threads, [], resumeNowMs).threads[0];
    return [threads[0].updatedAtMs, threads[0].embeddedSubagentUpdatedAtMs, row.state, row.updatedAtMs];
  };
  // The app copies or opens the logs: all file times are now.
  for (const name of ['agent-kid.jsonl', 'agent-other.jsonl']) await utimes(path.join(childDir, name), resumeNowMs / 1000, resumeNowMs / 1000);
  // A Working row sends its turn start as its time.
  assert.deepEqual(await load(), [resumeNowMs - 48_000, resumeNowMs - 30_000, 'working', resumeNowMs - 50_000]);
  // A turn record of the child moves the time.
  await appendFile(path.join(childDir, 'agent-kid.jsonl'), jsonl([resumeEnd(-10_000)]));
  assert.deepEqual(await load(), [resumeNowMs - 48_000, resumeNowMs - 10_000, 'working', resumeNowMs - 50_000]);
});

test('app approval tool, process start, turn end, and grace rules', async (t) => {
  const atMs = new Date(2026, 9, 25, 7, 55, 48).getTime();
  const thread = { id: 'claude-desktop-code:local_approval', externalId: 'local_approval', provider: 'claude-desktop-code',
    transcriptActivityAtMs: atMs, pendingToolAtMs: atMs - 1000, lifecycleRunning: true };
  const approvals = (tool = 'browser:left_click') => new Map([[thread.externalId, { tool, atMs }]]);
  assert.equal(applyClaudeAppApproval(thread, new Map(), atMs + 20_000), thread);
  // The transcript already shows these tools.
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'mcp__synthetic__request_permission']) {
    assert.equal(applyClaudeAppApproval(thread, approvals(tool), atMs + 20_000), thread, tool);
  }
  // A live process that started after the request is a newer process.
  assert.equal(applyClaudeAppApproval(thread, approvals(), atMs + 20_000, atMs + 1000), thread);
  assert.equal(applyClaudeAppApproval(thread, approvals(), atMs + 20_000, atMs + 999).awaitingPermission, true);
  // A parallel tool result moves the transcript but does not end the turn.
  const parallel = { ...thread, transcriptActivityAtMs: atMs + 5000 };
  assert.equal(applyClaudeAppApproval(parallel, approvals(), atMs + 20_000).awaitingPermission, true);
  for (const field of ['latestAgentFinalAtMs', 'latestUserMessageAtMs', 'latestTaskEndedAtMs']) {
    const ended = { ...thread, [field]: atMs + 2000 };
    assert.equal(applyClaudeAppApproval(ended, approvals(), atMs + 20_000), ended, field);
    assert.equal(applyClaudeAppApproval({ ...thread, [field]: atMs + 1999 }, approvals(), atMs + 20_000).awaitingPermission, true, field);
  }
  for (const field of ['latestAgentFinalAtMs', 'latestUserMessageAtMs', 'latestTaskEndedAtMs']) {
    for (const offset of [-10_000, 999, 1000, null]) {
      await t.test(`${field}: child wait ${offset === null ? 'absent' : offset}`, () => {
        const ended = { ...thread, [field]: atMs + 5000, childWaitAtMs: offset === null ? 0 : atMs + offset };
        const actual = applyClaudeAppApproval(ended, approvals(), atMs + 20_000);
        if (offset === -10_000 || offset === 999) assert.equal(actual.awaitingPermission, true);
        else assert.equal(actual, ended);
      });
    }
  }
  assert.deepEqual(applyClaudeAppApproval(thread, approvals(), atMs + 9999), { ...thread, approvalCheckAtMs: atMs + 10_000 });
  const waiting = applyClaudeAppApproval(thread, approvals(), atMs + 10_000);
  assert.equal(waiting.awaitingPermission, true);
  assert.equal(waiting.questionNonBlocking, false);
  assert.equal(waiting.pendingToolAtMs, atMs);
  assert.equal(waiting.liveWaitingFor, 'permission prompt');
  // The status clock checks again every 5 s while the wait shows.
  assert.equal(waiting.approvalCheckAtMs, atMs + 15_000);
  assert.equal(applyClaudeAppApproval(thread, approvals(), atMs + 30_000).approvalCheckAtMs, atMs + 35_000);
  const newerTool = { ...thread, pendingToolAtMs: atMs + 1000 };
  assert.equal(applyClaudeAppApproval(newerTool, approvals(), atMs + 20_000).pendingToolAtMs, atMs + 1000);
  assert.equal(thread.awaitingPermission, undefined);
});

test('a live registry permission wait gets the 10 s grace, and a question does not', () => {
  const nowMs = new Date(2026, 9, 25, 7, 56, 0).getTime();
  const thread = { id: 'claude-desktop-code:local_grace', externalId: 'local_grace', provider: 'claude-desktop-code', lifecycleRunning: true };
  const records = (fields) => [{ hostSessionId: thread.externalId, status: 'waiting', waitingFor: 'permission prompt', ...fields }];
  assert.deepEqual(applyLiveClaudeStatus(thread, records({ statusUpdatedAt: nowMs - 9999 }), nowMs),
    { ...thread, approvalCheckAtMs: nowMs + 1 });
  const late = applyLiveClaudeStatus(thread, records({ statusUpdatedAt: nowMs - 10_000 }), nowMs);
  assert.deepEqual([late.awaitingPermission, late.pendingToolAtMs, late.approvalCheckAtMs], [true, nowMs - 10_000, undefined]);
  const question = applyLiveClaudeStatus(thread, records({ waitingFor: 'input needed', statusUpdatedAt: nowMs - 1000 }), nowMs);
  assert.deepEqual([question.awaitingPermission, question.awaitingUserInput], [true, true]);
  const noTime = applyLiveClaudeStatus(thread, records({ statusUpdatedAt: 0 }), nowMs);
  assert.deepEqual([noTime.awaitingPermission, noTime.pendingToolAtMs], [true, nowMs]);
});

test('desktop Claude loads an app approval for an open browser tool', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-approval-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude');
  const metadataDir = path.join(appDir, 'claude-code-sessions', 'account', 'organization');
  const projectsDir = path.join(dir, 'projects');
  const projectDir = path.join(projectsDir, 'synthetic-project');
  const sessionId = 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const cliSessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const atMs = new Date(2026, 9, 25, 7, 55, 48).getTime();
  await mkdir(metadataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(path.join(appDir, 'logs'));
  await writeFile(path.join(metadataDir, `${sessionId}.json`), JSON.stringify({ sessionId, cliSessionId }));
  await writeFile(path.join(projectDir, `${cliSessionId}.jsonl`), jsonl([
    { type: 'user', sessionId: cliSessionId, timestamp: new Date(atMs - 1000).toISOString(), message: { role: 'user', content: 'Synthetic browser task' } },
    { type: 'assistant', timestamp: new Date(atMs).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'synthetic_browser', name: 'mcp__Claude_Browser__browser_batch', input: {} },
    ] } },
  ]));
  await writeFile(path.join(appDir, 'logs', 'main.log'),
    `2026-10-25 07:55:48 [info] Emitted tool permission request 11111111-2222-4333-8444-555555555555 for browser:left_click in session ${sessionId}\n`);
  const result = (platform) => loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs: atMs + 20_000, platform });
  const load = async () => (await result()).threads[0];
  // With no live record, an approval does not count on Windows or Linux.
  assert.notEqual((await result('win32')).threads[0].awaitingPermission, true);
  assert.notEqual((await result('linux')).threads[0].awaitingPermission, true);
  if (process.platform === 'linux') {
    assert.notEqual((await load()).awaitingPermission, true, 'an ended process cannot leave an app approval wait');
    const registryDir = path.join(path.dirname(projectsDir), 'sessions');
    await mkdir(registryDir);
    await writeFile(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid,
      procStart: await processStart(process.pid), name: 'synthetic-approval', sessionId: cliSessionId,
      hostSessionId: sessionId, status: 'busy' }));
  }
  const thread = await load();
  assert.equal(thread.awaitingPermission, true);
  assert.equal(thread.liveWaitingFor, 'permission prompt');
  if (process.platform === 'linux') {
    const registryFile = path.join(path.dirname(projectsDir), 'sessions', `${process.pid}.json`);
    const record = JSON.parse(await readFile(registryFile, 'utf8'));
    await writeFile(registryFile, JSON.stringify({ ...record, startedAt: atMs + 1000 }));
    assert.notEqual((await load()).awaitingPermission, true, 'a request of an older process does not count');
    await writeFile(registryFile, JSON.stringify({ ...record, startedAt: atMs - 1000 }));
    assert.equal((await load()).awaitingPermission, true);
    await rm(registryFile);
    assert.notEqual((await load()).awaitingPermission, true, 'a lost live record clears the app approval wait');
  }
  assert.equal((await result()).provider.status, 'desktop');
  // Responses with no request line mean that the app changed the request form.
  const received = (id) => `2026-10-25 07:55:49 [info] Received permission response for ${id}: once (tool: Bash)\n`;
  await writeFile(path.join(appDir, 'logs', 'next.log'), received('11111111-2222-4333-8444-555555555555')
    + received('22222222-3333-4444-8555-666666666666') + received('33333333-4444-4555-8666-777777777777'));
  await rename(path.join(appDir, 'logs', 'next.log'), path.join(appDir, 'logs', 'main.log'));
  const warned = (await result()).provider;
  assert.deepEqual([warned.status, warned.message], ['warning', 'ASB cannot read the approvals in the Claude app log. Update ASB.']);
});

test('an approval of a background child that waits stays after the main turn ends', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-approval-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude');
  const metadataDir = path.join(appDir, 'claude-code-sessions', 'account', 'organization');
  const projectsDir = path.join(dir, 'projects');
  const projectDir = path.join(projectsDir, 'synthetic-project');
  const sessionId = 'local_cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
  const cliSessionId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  const requestId = '44444444-5555-4666-8777-888888888888';
  const atMs = resumeNowMs;
  const nowMs = atMs + 20_000;
  const logTime = (offset) => {
    const date = new Date(atMs + offset);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const childDir = path.join(projectDir, cliSessionId, 'subagents');
  await mkdir(metadataDir, { recursive: true });
  await mkdir(childDir, { recursive: true });
  await mkdir(path.join(appDir, 'logs'));
  await writeFile(path.join(metadataDir, `${sessionId}.json`), JSON.stringify({ sessionId, cliSessionId }));
  await writeFile(path.join(projectDir, `${cliSessionId}.jsonl`), jsonl([
    ...resumeLaunch('kid'), resumeNotice(4000, 'other'), resumePrompt(5000), resumeEnd(6000),
  ]));
  const childFile = path.join(childDir, 'agent-kid.jsonl');
  const childRecords = [resumeMessage(-47_000), resumeEvent('assistant', -10_000, { message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'synthetic_preview', name: 'mcp__Claude_Browser__preview_start', input: { url: 'https://synthetic.example' } },
  ] } })];
  await writeFile(childFile, jsonl(childRecords));
  const logFile = path.join(appDir, 'logs', 'main.log');
  await writeFile(logFile,
    `${logTime(0)} [info] Emitted tool permission request ${requestId} for browser:open_site in session ${sessionId}\n`);
  if (process.platform === 'linux') {
    const registryDir = path.join(path.dirname(projectsDir), 'sessions');
    await mkdir(registryDir);
    await writeFile(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid,
      procStart: await processStart(process.pid), name: 'synthetic-child-approval', sessionId: cliSessionId,
      hostSessionId: sessionId, status: 'busy', startedAt: atMs - 60_000 }));
  }
  const load = async () => (await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs })).threads;
  const threads = await load();
  assert.equal(threads[0].awaitingPermission, true);
  assert.equal(threads[0].childWaitAtMs, atMs - 10_000);
  assert.equal(threads[0].liveWaitingFor, 'permission prompt');
  assert.equal(buildSwitchboardDashboard(threads, [], nowMs).threads[0].state, 'waiting');
  await appendFile(childFile, jsonl([
    resumeEvent('user', 3000, { message: { content: [{ type: 'tool_result', tool_use_id: 'synthetic_preview', content: 'Opened.' }] } }),
    resumeEnd(3000),
  ]));
  assert.notEqual((await load())[0].awaitingPermission, true, 'the child finished after the approval');
  await writeFile(childFile, jsonl(childRecords));
  assert.equal((await load())[0].awaitingPermission, true, 'the restored child still waits');
  await appendFile(logFile,
    `${logTime(3000)} [info] Received permission response for ${requestId}: once (tool: browser:open_site)\n`);
  assert.notEqual((await load())[0].awaitingPermission, true, 'the app logged the approval response');
});

test('on Windows an app approval counts only with a live registry record, and the registry statuses apply as on Linux', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-approval-win-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'Claude');
  const metadataDir = path.join(appDir, 'claude-code-sessions', 'account', 'organization');
  const projectsDir = path.join(dir, 'projects');
  const projectDir = path.join(projectsDir, 'synthetic-project');
  const registryDir = path.join(path.dirname(projectsDir), 'sessions');
  const sessionId = 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const cliSessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const atMs = new Date(2026, 9, 25, 7, 55, 48).getTime();
  await mkdir(metadataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(path.join(appDir, 'logs'));
  await mkdir(registryDir);
  await writeFile(path.join(metadataDir, `${sessionId}.json`), JSON.stringify({ sessionId, cliSessionId }));
  await writeFile(path.join(projectDir, `${cliSessionId}.jsonl`), jsonl([
    { type: 'user', sessionId: cliSessionId, timestamp: new Date(atMs - 1000).toISOString(), message: { role: 'user', content: 'Synthetic browser task' } },
    { type: 'assistant', timestamp: new Date(atMs).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'synthetic_browser', name: 'mcp__Claude_Browser__browser_batch', input: {} },
    ] } },
  ]));
  const logFile = path.join(appDir, 'logs', 'main.log');
  await writeFile(logFile,
    `2026-10-25 07:55:48 [info] Emitted tool permission request 11111111-2222-4333-8444-555555555555 for browser:left_click in session ${sessionId}\n`);
  const registryFile = path.join(registryDir, `${process.pid}.json`);
  const record = JSON.stringify({ pid: process.pid, procStart: '133000000000000000', name: 'synthetic-approval', sessionId: cliSessionId,
    hostSessionId: sessionId, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: atMs - 5000, startedAt: atMs - 5000 });
  const load = async (nowMs = atMs + 20_000) => (await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs, platform: 'win32' })).threads[0];
  // (b) With no record file, the chat keeps its transcript state.
  const transcript = await load();
  assert.notEqual(transcript.awaitingPermission, true);
  // (a) With the record, the approval shows Waiting after the 10 s grace. The next app-log check in 5 s shows that the approval gave it.
  await writeFile(registryFile, record);
  const waiting = await load(atMs + 10_000);
  assert.equal(waiting.awaitingPermission, true);
  assert.equal(waiting.liveWaitingFor, 'permission prompt');
  assert.equal(waiting.approvalCheckAtMs, atMs + 15_000);
  // (c) With the record but no app-log request, the registry `waiting` status shows after its 10 s grace, as on Linux.
  await writeFile(logFile, '');
  assert.notEqual((await load(atMs - 5000 + 9_999)).awaitingPermission, true);
  const registryWait = await load(atMs - 5000 + 10_000);
  assert.equal(registryWait.awaitingPermission, true);
  assert.equal(registryWait.liveWaitingFor, 'permission prompt');
});
