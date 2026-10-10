import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getClaudeCacheStats,
  invalidateClaudeData,
  loadClaudeDesktopCodeThreads,
  normalizeClaudeDesktopCodeSession,
  openClaudeThread,
  parseClaudeJsonlSignals,
} from '../src/claude-data.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

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
  assert.equal(signals.latestUserMessage, '帮我检查这个项目');
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

  assert.equal(signals.latestUserMessage, '跑一下测试');
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

  assert.equal(signals.lastAgentMessage, '我会先拆分任务，然后继续改代码。');
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

  assert.equal(signals.lastAgentMessage, '回测已经跑完，可以查看结果。');
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

  assert.equal(signals.lastAgentMessage, '报告已生成。');
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
  assert.equal(result.threads[0].embeddedSubagentUpdatedAtMs > 0, true);
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
    const notice = event('user', -7000, { message: { content:
      `<task-notification><task-id>background</task-id><status>${status}</status></task-notification>` } });
    // The root ended before the child: the child end is the group end.
    assert.deepEqual(await load([...launched, rootEnd(-8000), notice]), [false, kind, kind, nowMs - 7000], status);
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
    assert.deepEqual(await step([resumeNotice(-44_000, 'kid')], [resumeEnd(-45_000)]), [false, 'idle'], `end ${maxBytes}`);

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
    assert.deepEqual(await step([resumeNotice(-24_000, 'kid')], [resumeEnd(-25_000)]), [false, 'idle'], `second end ${maxBytes}`);
    // In the main transcript, a meta record starts no task.
    assert.deepEqual(await step([resumeEvent('user', -23_000, { isMeta: true, message: { content: 'A note.' } })]), [false, 'idle'], `meta ${maxBytes}`);
    assert.deepEqual(await step(sendMessage(-20_000, resumeResult('kid')), [resumeMessage(-19_950)]), [true, 'working'], `second resume ${maxBytes}`);
    const before = getClaudeCacheStats().jsonlSignals.bytesRead;
    const failed = [resumeNotice(-15_000, 'kid', 'failed')];
    assert.deepEqual(await step(failed), [false, 'idle'], `third end ${maxBytes}`);
    // Only the guard and the appended part of the main transcript are read.
    if (maxBytes) assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead - before, 64 + Buffer.byteLength(jsonl(failed)));
  }
});

test('a resume of an Agent child whose launch is not in the transcript makes its chat Working', async (t) => {
  for (const call of [true, false]) {
    const { step } = await resumeFixture(t, 'old', [resumeEvent('user', -50_000, { message: { content: 'Ask the old task for more.' } }),
      ...sendMessage(-49_000, resumeResult('old'), call)], [resumeEnd(-55_000), resumePrompt(-48_800), resumeWork(-48_500)]);
    assert.deepEqual(await step(), [true, 'working'], String(call));
    // A stopped child writes no end record: only the notification ends its link.
    assert.deepEqual(await step([resumeNotice(-40_000, 'old', call ? 'completed' : 'stopped')], call ? [resumeEnd(-41_000)] : []),
      [false, 'idle'], String(call));
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
    assert.deepEqual(await busy.step([resumeNotice(-20_000, 'kid')], [resumeEnd(-21_000)]), [false, 'idle'], `end ${maxBytes}`);

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
  assert.deepEqual(await step([resumeNotice(-40_000, 'kid')]), [false, 'idle']);
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
      assert.deepEqual(await step([resumeNotice(-15_000, 'wf_run1'), resumeNotice(-14_000, 'a1')]), [true, 'working'], `other ID ${index} ${maxBytes}`);
      assert.deepEqual(await step([notice]), [false, 'idle'], `end ${index} ${maxBytes}`);
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
  assert.deepEqual(await step([resumeNotice(-9_000, 'wtask0002')]), [false, 'idle'], 'new task ID');
});
