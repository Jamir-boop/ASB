import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadClaudeDesktopCodeThreads,
  normalizeClaudeDesktopCodeSession,
  openClaudeThread,
  parseClaudeJsonlSignals,
} from '../src/claude-data.mjs';

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
