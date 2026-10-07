import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOVERNANCE_CONFIG,
  buildGovernanceModel,
  buildLongRunAlert,
  governanceTitleSimilarity,
} from '../src/governance.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.UTC(2026, 6, 17, 8);

function thread(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    title: '任务',
    cwd: '/workspace/demo',
    projectName: 'demo',
    updatedAtMs: nowMs - DAY_MS,
    status: 'idle',
    archived: false,
    tokensUsed: 0,
    tokenBreakdown: null,
    artifacts: { total: 0, items: [] },
    ...overrides,
  };
}

test('classifies governance lanes from explicit evidence without treating notLoaded as completion', () => {
  const model = buildGovernanceModel([
    thread({ id: 'active', status: 'running' }),
    thread({ id: 'waiting', hasUnreadTurn: true }),
    thread({ id: 'automation', isAutomation: true }),
    thread({ id: 'cleanup', updatedAtMs: nowMs - 45 * DAY_MS }),
    thread({ id: 'dormant', updatedAtMs: nowMs - 12 * DAY_MS, notLoaded: true }),
    thread({ id: 'archived', archived: true }),
  ], nowMs);
  const categories = Object.fromEntries(model.threads.map((item) => [item.id, item.governanceCategory]));

  assert.deepEqual(categories, {
    active: 'active',
    waiting: 'waiting',
    automation: 'automation',
    cleanup: 'cleanup',
    dormant: 'dormant',
    archived: 'archived',
  });
  assert.match(model.governance.method.note, /notLoaded.+不等于已完成/);
});

test('finds exact duplicates, recovery copies, similar clues, and a canonical thread inside one project', () => {
  const model = buildGovernanceModel([
    thread({ id: 'canonical', title: '发布 Agent 控制台', status: 'running', updatedAtMs: nowMs }),
    thread({ id: 'duplicate', title: '发布 Agent 控制台', updatedAtMs: nowMs - 40 * DAY_MS }),
    thread({ id: 'resume', title: '恢复：发布 Agent 控制台窄屏验收', updatedAtMs: nowMs - 35 * DAY_MS }),
    thread({ id: 'other-project', title: '发布 Agent 控制台', cwd: '/workspace/other', projectName: 'other' }),
  ], nowMs);
  const duplicate = model.threads.find((item) => item.id === 'duplicate');
  const resume = model.threads.find((item) => item.id === 'resume');

  assert.equal(duplicate.canonicalThread.id, 'canonical');
  assert.ok(duplicate.cleanupReasons.some((reason) => reason.code === 'exact-duplicate'));
  assert.ok(resume.cleanupReasons.some((reason) => reason.code === 'recovery-copy'));
  assert.ok(resume.similarThreads.some((item) => item.id === 'canonical'));
  assert.ok(governanceTitleSimilarity('恢复 发布控制台验收', '发布控制台验收') >= GOVERNANCE_CONFIG.similarTitleThreshold);
});

test('does not treat long titles with different suffixes as exact duplicates', () => {
  const sharedPrefix = '超长任务'.repeat(160);
  const model = buildGovernanceModel([
    thread({ id: 'long-a', title: `${sharedPrefix} A`, updatedAtMs: nowMs - 45 * DAY_MS }),
    thread({ id: 'long-b', title: `${sharedPrefix} B`, updatedAtMs: nowMs - 45 * DAY_MS }),
  ], nowMs);

  for (const item of model.threads) {
    assert.equal(item.cleanupReasons.some((reason) => reason.code === 'exact-duplicate'), false);
  }
});

test('uses explicit completion evidence for sub-agent cleanup candidates', () => {
  const model = buildGovernanceModel([
    thread({
      id: 'child',
      isSubagent: true,
      parentThreadId: 'host',
      agentRunning: false,
      latestUserMessageAtMs: nowMs - 10_000,
      latestAgentFinalAtMs: nowMs - 1_000,
    }),
  ], nowMs);

  assert.equal(model.threads[0].governanceCategory, 'cleanup');
  assert.ok(model.threads[0].cleanupReasons.some((reason) => reason.code === 'completed-subagent'));
});

test('keeps WIP at advisory five active main tasks and excludes sub-agents', () => {
  const threads = Array.from({ length: 7 }, (_, index) => thread({ id: `host-${index}`, status: 'running' }));
  threads.push(thread({ id: 'child', status: 'running', isSubagent: true, parentThreadId: 'host-0' }));
  const model = buildGovernanceModel(threads, nowMs);

  assert.equal(model.governance.wip.activeMainCount, 7);
  assert.equal(model.governance.wip.recommendedLimit, 5);
  assert.equal(model.governance.wip.overBy, 2);
  assert.match(model.governance.wip.advisory, /不是强制规则/);
});

test('long-run alert needs churn plus weak feedback and progress, not high tokens alone', () => {
  const highTokensOnly = thread({
    tokensUsed: 900_000_000,
    workMetrics: {
      scope: 'full-rollout',
      compactionCount: 0,
      toolCallCount: 2,
      agentTaskCount: 1,
      agentTurnCount: 1,
      userInputCount: 1,
      verificationSignalCount: 1,
      goalCompletionCount: 1,
    },
  });
  const runaway = thread({
    tokensUsed: 500_000_000,
    workMetrics: {
      scope: 'full-rollout',
      compactionCount: 60,
      toolCallCount: 4_200,
      agentTaskCount: 197,
      agentTurnCount: 256,
      userInputCount: 4,
      verificationSignalCount: 2,
      goalCompletionCount: 0,
    },
  });

  assert.equal(buildLongRunAlert(highTokensOnly), null);
  const alert = buildLongRunAlert(runaway);
  assert.equal(alert.severity, 'critical');
  assert.match(alert.explanation, /4200 次工具调用/);
  assert.equal(alert.suggestions.length, 4);
});

test('portfolio aggregates archived ratio, sub-agents, cost split, artifacts, and recent actions', () => {
  const model = buildGovernanceModel([
    thread({
      id: 'one',
      status: 'running',
      tokensUsed: 130,
      tokenBreakdown: { total: 130, input: 20, cacheRead: 80, cacheWrite: 5, output: 15, reasoning: 10, uncategorized: 0 },
      artifacts: { total: 1, latestAtMs: nowMs, items: [{ id: 'a', title: 'report.md', type: 'markdown', atMs: nowMs }] },
    }),
    thread({ id: 'two', archived: true, isSubagent: true, parentThreadId: 'one', tokensUsed: 70 }),
  ], nowMs);
  const project = model.portfolio[0];

  assert.equal(project.taskCount, 2);
  assert.equal(project.archivedRatio, 0.5);
  assert.equal(project.subagentCount, 1);
  assert.equal(project.costBreakdown.cachedInput, 80);
  assert.equal(project.costBreakdown.nonCachedInput, 20);
  assert.equal(project.representativeArtifacts[0].title, 'report.md');
  assert.equal(project.latestActions[0].id, 'one');
});

test('keeps similar-title governance bounded for large same-project histories', () => {
  const threads = Array.from({ length: 1_000 }, (_, index) => thread({
    id: `history-${index}`,
    title: `历史任务 ${index} 独特标题`,
    updatedAtMs: nowMs - (40 * DAY_MS) - index,
  }));
  const startedAt = performance.now();

  const model = buildGovernanceModel(threads, nowMs);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(model.threads.length, 1_000);
  assert.ok(elapsedMs < 1_000, `expected bounded governance work, took ${Math.round(elapsedMs)}ms`);
});
