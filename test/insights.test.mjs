import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferThreadStatus,
  normalizeDashboardThreads,
  normalizeThread,
} from '../src/insights.mjs';

test('normalizes sqlite thread rows into dashboard thread objects', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const thread = normalizeThread({
    id,
    title: 'Build report',
    cwd: '/Users/example/Documents/bilibili toy',
    source: 'vscode',
    model: 'gpt-5.5',
    reasoning_effort: 'medium',
    tokens_used: 1200,
    has_unread_turn: 1,
    archived: 0,
    created_at: 1777420000,
    updated_at: 1777423600,
    rollout_path: '/tmp/rollout.jsonl',
    git_branch: 'main',
  }, 1777427200000);

  assert.equal(thread.id, id);
  assert.equal(thread.externalId, id);
  assert.equal(thread.provider, 'codex');
  assert.equal(thread.providerLabel, 'Codex');
  assert.equal(thread.projectName, 'bilibili toy');
  assert.equal(thread.tokensUsed, 1200);
  assert.equal(thread.archived, false);
  assert.equal(thread.hasUnreadTurn, true);
  assert.equal(thread.status, 'warm');
  assert.equal(thread.createdAtMs, 1777420000000);
  assert.equal(thread.updatedAtMs, 1777423600000);
  assert.equal(thread.appDeepLink, `codex://threads/${id}`);
  assert.equal(thread.canOpen, true);
  assert.equal(thread.openLabel, '打开');
  assert.equal(thread.defaultOpenMode, 'codex-deeplink');
  assert.equal(thread.inCodexSidebar, true);
});

test('uses desktop deep link for Codex threads missing from the sidebar index', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const thread = normalizeThread({
    id,
    title: 'Old hidden thread',
    cwd: '/Users/example/Documents/work',
    source: 'vscode',
    in_codex_sidebar: 0,
    archived: 0,
    created_at: 1777420000,
    updated_at: 1777423600,
  }, 1777427200000);

  assert.equal(thread.provider, 'codex');
  assert.equal(thread.inCodexSidebar, false);
  assert.equal(thread.appDeepLink, `codex://threads/${id}`);
  assert.equal(thread.defaultOpenMode, 'codex-deeplink');
  assert.equal(thread.openLabel, '打开');
});

test('prefers Codex sidebar thread names over stale sqlite titles', () => {
  const thread = normalizeThread({
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'OK，上述信息生成html并发布toy',
    thread_name: '调研 /goal 新命令',
    cwd: '/Users/example/Documents/work',
    archived: 0,
    created_at: 1777420000,
    updated_at: 1777423600,
  }, 1777427200000);

  assert.equal(thread.title, '调研 /goal 新命令');
});

test('marks Codex automation threads even when sidebar title hides the automation prefix', () => {
  const thread = normalizeThread({
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Automation: Codex Project Folder Check\nAutomation ID: codex-project-folder-check',
    thread_name: 'Codex Project Folder Check',
    cwd: '/Users/example/Documents/work',
    archived: 0,
    created_at: 1777420000,
    updated_at: 1777423600,
  }, 1777427200000);

  assert.equal(thread.title, 'Codex Project Folder Check');
  assert.equal(thread.isAutomation, true);
});

test('normalizes Codex sub-agent spawn metadata', () => {
  const thread = normalizeThread({
    id: '223e4567-e89b-12d3-a456-426614174000',
    title: 'Review strategy',
    cwd: '/Users/example/Documents/work',
    source: '{"subagent":{"thread_spawn":{"parent_thread_id":"123e4567-e89b-12d3-a456-426614174000","depth":1,"agent_nickname":"Dirac","agent_role":"explorer"}}}',
    archived: 0,
    created_at: 1777420000,
    updated_at: 1777423600,
  }, 1777427200000);

  assert.equal(thread.isSubagent, true);
  assert.equal(thread.parentThreadId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(thread.subagentDepth, 1);
  assert.equal(thread.agentNickname, 'Dirac');
  assert.equal(thread.agentRole, 'explorer');
});

test('infers running, fresh, warm, idle, and archived thread statuses', () => {
  const now = 1777427200000;

  assert.equal(inferThreadStatus({
    archived: false,
    updatedAtMs: now,
    latestUserMessageAtMs: now - 10 * 60 * 1000,
    latestAgentFinalAtMs: now - 20 * 60 * 1000,
  }, now), 'running');
  assert.equal(inferThreadStatus({
    archived: false,
    updatedAtMs: now - 2 * 24 * 60 * 60 * 1000,
    latestUserMessageAtMs: now - 2 * 24 * 60 * 60 * 1000,
    latestAgentFinalAtMs: now - 2 * 24 * 60 * 60 * 1000 - 60_000,
  }, now), 'idle');
  assert.equal(inferThreadStatus({ archived: false, updatedAtMs: now - 5 * 60 * 1000 }, now), 'fresh');
  assert.equal(inferThreadStatus({ archived: false, updatedAtMs: now - 2 * 60 * 60 * 1000 }, now), 'warm');
  assert.equal(inferThreadStatus({ archived: false, updatedAtMs: now - 2 * 24 * 60 * 60 * 1000 }, now), 'idle');
  assert.equal(inferThreadStatus({ archived: true, updatedAtMs: now }, now), 'archived');
});

test('uses active Codex goals as an explicit running signal', () => {
  const now = 1777427200000;
  const thread = normalizeThread({
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Goal loop',
    cwd: '/Users/example/Documents/work',
    source: 'cli',
    archived: 0,
    created_at_ms: now - 4 * 60 * 60 * 1000,
    updated_at_ms: now - 60_000,
    goal_id: 'goal-1',
    goal_status: 'active',
    goal_created_at_ms: now - 2 * 60 * 60 * 1000,
    goal_updated_at_ms: now - 30_000,
    goal_tokens_used: 1000,
    goal_time_used_seconds: 7200,
  }, now);

  assert.equal(thread.provider, 'codex-cli');
  assert.equal(thread.activeGoal, true);
  assert.equal(thread.status, 'running');
  assert.equal(thread.currentTurnStartedAtMs, now - 2 * 60 * 60 * 1000);
  assert.equal(thread.currentTurnElapsedMs, 2 * 60 * 60 * 1000);

  const threads = normalizeDashboardThreads([
    {
      ...thread,
      latestUserMessageAtMs: now - 90 * 60 * 1000,
      latestAgentFinalAtMs: now - 60_000,
      latestMessageKind: 'agent',
    },
  ], now);

  assert.equal(threads[0].status, 'running');
});

test('attaches sub-agent threads to their host thread metadata', () => {
  const now = 1777427200000;
  const threads = normalizeDashboardThreads([
    {
      id: 'host-thread',
      title: 'Host task',
      cwd: '/a',
      projectName: 'a',
      tokensUsed: 100,
      archived: false,
      updatedAtMs: now - 120_000,
    },
    {
      id: 'subagent-thread',
      title: 'Worker task',
      cwd: '/a',
      projectName: 'a',
      source: '{"subagent":{"thread_spawn":{"parent_thread_id":"host-thread","agent_nickname":"Dirac","agent_role":"explorer"}}}',
      isSubagent: true,
      parentThreadId: 'host-thread',
      tokensUsed: 10,
      archived: false,
      updatedAtMs: now - 30_000,
    },
  ], now);

  const host = threads.find((thread) => thread.id === 'host-thread');
  const subagent = threads.find((thread) => thread.id === 'subagent-thread');

  assert.equal(host.subagentCount, 1);
  assert.deepEqual(host.childThreadIds, ['subagent-thread']);
  assert.equal(host.groupUpdatedAtMs, now - 30_000);
  assert.equal(subagent.parentThreadTitle, 'Host task');
  assert.equal(subagent.parentThreadProjectName, 'a');
});

test('rolls embedded and nested sub-agent activity up to the root host', () => {
  const now = 1777427200000;
  const threads = normalizeDashboardThreads([
    {
      id: 'host-thread',
      title: 'Host task',
      cwd: '/a',
      projectName: 'a',
      archived: false,
      updatedAtMs: now - 180_000,
      embeddedSubagentCount: 2,
      embeddedSubagentUpdatedAtMs: now - 40_000,
    },
    {
      id: 'subagent-a',
      title: 'Nested host',
      cwd: '/a',
      projectName: 'a',
      archived: false,
      isSubagent: true,
      parentThreadId: 'host-thread',
      updatedAtMs: now - 120_000,
      embeddedSubagentCount: 1,
      embeddedSubagentUpdatedAtMs: now - 20_000,
    },
    {
      id: 'subagent-b',
      title: 'Nested worker',
      cwd: '/a',
      projectName: 'a',
      archived: false,
      isSubagent: true,
      parentThreadId: 'subagent-a',
      updatedAtMs: now - 10_000,
      latestUserMessageAtMs: now - 10_000,
      latestAgentFinalAtMs: now - 30_000,
    },
  ], now);

  const host = threads.find((thread) => thread.id === 'host-thread');
  const nested = threads.find((thread) => thread.id === 'subagent-b');

  assert.equal(host.subagentCount, 5);
  assert.deepEqual(host.childThreadIds, ['subagent-a']);
  assert.deepEqual(host.descendantThreadIds, ['subagent-a', 'subagent-b']);
  assert.equal(host.groupUpdatedAtMs, now - 10_000);
  assert.equal(nested.hostThreadId, 'host-thread');
});

test('uses explicit provider running signals for thread status', () => {
  const now = 1777427200000;
  const threads = normalizeDashboardThreads([
    {
      id: 'claude-active',
      title: 'Claude active loop',
      cwd: '/a',
      projectName: 'a',
      provider: 'claude-desktop-code',
      tokensUsed: 100,
      archived: false,
      updatedAtMs: now - 30 * 60 * 1000,
      latestUserMessageAtMs: now - 2 * 60 * 60 * 1000,
      latestAgentFinalAtMs: now - 90 * 60 * 1000,
      agentRunning: true,
      agentStartedAtMs: now - 2 * 60 * 60 * 1000,
      agentActivityAtMs: now - 30 * 60 * 1000,
    },
    {
      id: 'claude-stale',
      title: 'Claude stale loop',
      cwd: '/b',
      projectName: 'b',
      provider: 'claude-desktop-code',
      tokensUsed: 100,
      archived: false,
      updatedAtMs: now - 7 * 60 * 60 * 1000,
      agentRunning: true,
      agentStartedAtMs: now - 8 * 60 * 60 * 1000,
      agentActivityAtMs: now - 7 * 60 * 60 * 1000,
    },
  ], now);

  const active = threads.find((thread) => thread.id === 'claude-active');
  const stale = threads.find((thread) => thread.id === 'claude-stale');

  assert.equal(active.status, 'running');
  assert.equal(active.currentTurnStartedAtMs, now - 2 * 60 * 60 * 1000);
  assert.equal(stale.status, 'idle');
});

test('does not use provider-level quota refresh as Claude turn activity', () => {
  const now = 1777427200000;
  const threads = normalizeDashboardThreads([
    {
      id: 'claude-stale-cache',
      title: 'Claude stale loop with fresh quota',
      cwd: '/b',
      projectName: 'b',
      provider: 'claude-desktop-code',
      providerLabel: 'Claude Desktop Code',
      model: 'claude-opus-4-6',
      tokensUsed: 100,
      archived: false,
      updatedAtMs: now - 17 * 24 * 60 * 60 * 1000,
      agentRunning: true,
      agentStartedAtMs: now - 17 * 24 * 60 * 60 * 1000,
      agentActivityAtMs: now - 17 * 24 * 60 * 60 * 1000,
      rateLimitUpdatedAtMs: now - 1_000,
      rateLimitActivityAtMs: null,
      rateLimits: {
        primary: { used_percent: 40, window_minutes: 300, resets_at: 1777430000 },
      },
    },
  ], now);

  const stale = threads.find((thread) => thread.id === 'claude-stale-cache');
  assert.equal(stale.status, 'idle');
  assert.equal(stale.currentTurnStartedAtMs, null);
});
