import { isAutomationThread, isSubagentThread } from './thread-classification.mjs';
import {
  addTokenBreakdowns,
  tokenBreakdownWithFallbackTotal,
} from './token-usage.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TITLE_RE = /(?:^|[\s:：/（(\[【_-])(恢复|继续|续跑|挂起|暂停|resume(?:d)?|continu(?:e|ed|ation)|recover(?:y|ed)?|suspend(?:ed)?|paused?|follow[ -]?up)(?:$|[\s:：/）)\]】_-])/iu;
const PLACEHOLDER_TITLE_RE = /^(未命名任务|未命名|untitled(?: task)?|new thread)$/iu;

export const GOVERNANCE_CONFIG = Object.freeze({
  activeWindowDays: 7,
  cleanupDefaultDays: 30,
  staleDayOptions: Object.freeze([30, 60, 90]),
  wipLimit: 5,
  similarTitleThreshold: 0.52,
  maxSimilarThreads: 3,
  similarTitleCandidateLimit: 80,
  titleMaxChars: 512,
  rolloutMetricScanLimit: 12,
  longRun: Object.freeze({
    minCompactions: 4,
    minToolCalls: 300,
    minAgentTasks: 20,
    maxUserInputToTaskRatio: 0.12,
    minUserInputAllowance: 5,
    maxProgressToToolRatio: 0.02,
    minProgressAllowance: 3,
    criticalCompactions: 12,
    criticalToolCalls: 2_000,
    criticalAgentTasks: 50,
  }),
});

const CATEGORY_META = Object.freeze({
  active: {
    label: '推进中',
    description: `最近 ${GOVERNANCE_CONFIG.activeWindowDays} 天仍在推进，或有明确运行信号。`,
  },
  waiting: {
    label: '等待中',
    description: '有明确的用户确认、审核、授权或外部条件等待信号。',
  },
  automation: {
    label: '自动化',
    description: '由自动化标记或自动化上下文识别，独立于主任务 WIP。',
  },
  cleanup: {
    label: '清理候选',
    description: '长期未更新、非 canonical 重复、恢复副本或有明确完成证据的子代理。',
  },
  dormant: {
    label: '近期未推进',
    description: `超过 ${GOVERNANCE_CONFIG.activeWindowDays} 天未推进，但尚未达到默认清理阈值。`,
  },
  archived: {
    label: '已归档',
    description: '上游状态已明确标记归档。',
  },
});

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function compactText(value = '') {
  return String(value).trim().replace(/\s+/g, ' ');
}

function compactTitleText(value = '') {
  return compactText(String(value).slice(0, GOVERNANCE_CONFIG.titleMaxChars));
}

function projectKey(thread = {}) {
  return String(thread.cwd || thread.projectName || '未知项目');
}

export function normalizeGovernanceTitle(value = '') {
  return compactText(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[\s:：/\\|—–_-]+/g, ' ')
    .trim();
}

function normalizeSimilarGovernanceTitle(value = '') {
  return normalizeGovernanceTitle(compactTitleText(value));
}

function usableDuplicateTitle(normalized = '') {
  return normalized.length >= 4 && !PLACEHOLDER_TITLE_RE.test(normalized);
}

function ageDays(thread, nowMs) {
  const updatedAtMs = number(thread?.updatedAtMs);
  if (updatedAtMs <= 0) return null;
  return Math.max(0, Math.floor((nowMs - updatedAtMs) / DAY_MS));
}

function waitingEvidence(thread = {}) {
  const evidence = [];
  const pendingToolCount = Math.max(
    number(thread.openCodePendingToolCount),
    number(thread.pendingToolCount),
    Array.isArray(thread.openCodePendingTools) ? thread.openCodePendingTools.length : 0,
    Array.isArray(thread.pendingTools) ? thread.pendingTools.length : 0,
  );

  if (thread.awaitingPermission || pendingToolCount > 0) {
    evidence.push({
      code: 'permission',
      label: '等待授权',
      detail: pendingToolCount > 0 ? `${pendingToolCount} 个待授权工具调用` : 'Provider 明确报告等待授权',
    });
  }
  if (thread.hasUnreadTurn || thread.awaitingReview) {
    evidence.push({
      code: 'review',
      label: '等待审核',
      detail: '上游有未读或待验收信号',
    });
  }
  if (thread.waitingExternal || thread.awaitingExternal) {
    evidence.push({
      code: 'external',
      label: '等待外部条件',
      detail: 'Provider 明确报告外部条件未满足',
    });
  }
  return evidence;
}

function completedSubagentEvidence(thread = {}) {
  if (!isSubagentThread(thread)) return null;
  const goalStatus = String(thread.goalStatus || '').toLowerCase();
  if (['complete', 'completed', 'achieved'].includes(goalStatus)) {
    return '子代理 goal 已明确完成';
  }
  if (
    thread.agentRunning === false
    && number(thread.latestAgentFinalAtMs) > 0
    && number(thread.latestAgentFinalAtMs) >= number(thread.latestUserMessageAtMs)
  ) {
    return '子代理有结束运行与 final answer 证据';
  }
  return null;
}

function canonicalComparator(a, b) {
  const priority = (thread) => (
    (thread.archived ? -1_000 : 0)
    + (thread.status === 'running' ? 300 : 0)
    + (waitingEvidence(thread).length ? 180 : 0)
    + (!isSubagentThread(thread) ? 80 : 0)
    + (number(thread.artifacts?.total) > 0 ? 20 : 0)
  );
  return priority(b) - priority(a)
    || number(b.updatedAtMs) - number(a.updatedAtMs)
    || number(b.tokensUsed) - number(a.tokensUsed)
    || String(a.id || '').localeCompare(String(b.id || ''));
}

function exactDuplicateContext(threads) {
  const groups = new Map();
  for (const thread of threads) {
    const normalizedTitle = normalizeGovernanceTitle(thread.title);
    if (thread.archived || !usableDuplicateTitle(normalizedTitle)) continue;
    const key = `${projectKey(thread)}\0${normalizedTitle}`;
    const group = groups.get(key) || [];
    group.push(thread);
    groups.set(key, group);
  }

  const result = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(canonicalComparator);
    const canonical = sorted[0];
    for (const thread of sorted) {
      result.set(thread.id, {
        count: sorted.length,
        canonical,
        isCanonical: thread.id === canonical.id,
      });
    }
  }
  return result;
}

function titleTokensFromNormalized(normalized = '') {
  const tokens = new Set(normalized.match(/[a-z0-9]+|[\p{Script=Han}]{2}/gu) || []);
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, '')];
  for (let index = 0; index < han.length - 1; index += 1) {
    tokens.add(`${han[index]}${han[index + 1]}`);
  }
  return tokens;
}

function prepareGovernanceTitle(value = '') {
  const normalized = normalizeSimilarGovernanceTitle(value);
  return {
    normalized,
    tokens: titleTokensFromNormalized(normalized),
  };
}

function preparedTitleSimilarity(first, second) {
  if (!first.normalized || !second.normalized) return 0;
  if (first.normalized === second.normalized) return 1;
  const shorter = first.normalized.length <= second.normalized.length
    ? first.normalized
    : second.normalized;
  const longer = shorter === first.normalized ? second.normalized : first.normalized;
  if (shorter.length >= 8 && longer.includes(shorter)) {
    return Math.min(0.94, shorter.length / longer.length + 0.2);
  }

  if (!first.tokens.size || !second.tokens.size) return 0;
  let intersection = 0;
  for (const token of first.tokens) {
    if (second.tokens.has(token)) intersection += 1;
  }
  return intersection / (first.tokens.size + second.tokens.size - intersection);
}

export function governanceTitleSimilarity(a = '', b = '') {
  return preparedTitleSimilarity(
    prepareGovernanceTitle(a),
    prepareGovernanceTitle(b),
  );
}

export function buildLongRunAlert(thread = {}, config = GOVERNANCE_CONFIG) {
  const metrics = thread.workMetrics;
  if (!metrics || metrics.scope !== 'full-rollout') return null;

  const thresholds = config.longRun;
  const compactionCount = number(metrics.compactionCount);
  const toolCallCount = number(metrics.toolCallCount);
  const agentTaskCount = number(metrics.agentTaskCount);
  const agentTurnCount = number(metrics.agentTurnCount);
  const userInputCount = number(metrics.userInputCount);
  const verificationSignalCount = number(metrics.verificationSignalCount);
  const verificationCallCount = number(metrics.verificationCallCount, verificationSignalCount);
  const goalCompletionCount = number(metrics.goalCompletionCount);
  const artifactCount = number(thread.artifacts?.total);
  const progressSignalCount = verificationSignalCount + goalCompletionCount + artifactCount;
  const userAllowance = Math.max(
    thresholds.minUserInputAllowance,
    Math.ceil(agentTaskCount * thresholds.maxUserInputToTaskRatio),
  );
  const progressAllowance = Math.max(
    thresholds.minProgressAllowance,
    Math.ceil(toolCallCount * thresholds.maxProgressToToolRatio),
  );

  const highIteration = compactionCount >= thresholds.minCompactions
    && toolCallCount >= thresholds.minToolCalls
    && agentTaskCount >= thresholds.minAgentTasks;
  const lowFeedback = userInputCount <= userAllowance;
  const lowProgress = progressSignalCount <= progressAllowance;
  if (!highIteration || !lowFeedback || !lowProgress) return null;

  const critical = compactionCount >= thresholds.criticalCompactions
    && toolCallCount >= thresholds.criticalToolCalls
    && agentTaskCount >= thresholds.criticalAgentTasks;
  return {
    severity: critical ? 'critical' : 'warning',
    code: 'iteration-without-feedback',
    title: critical ? '目标失控风险高' : '长线程进展信号偏弱',
    explanation: `检测到 ${toolCallCount} 次工具调用、${compactionCount} 次压缩和 ${agentTaskCount} 个 agent task，但只有 ${userInputCount} 次用户输入与 ${progressSignalCount} 个产物/验证/目标完成信号。`,
    evidence: {
      compactionCount,
      toolCallCount,
      agentTaskCount,
      agentTurnCount,
      userInputCount,
      verificationSignalCount,
      verificationCallCount,
      verificationKinds: Array.isArray(metrics.verificationKinds) ? metrics.verificationKinds : [],
      goalCompletionCount,
      artifactCount,
      totalTokens: number(thread.tokensUsed),
      tokenBreakdown: thread.tokenBreakdown || null,
    },
    suggestions: [
      '先写阶段小结与剩余验收指标',
      '把下一阶段拆到新任务，保留原线程作为证据',
      '写入 STATUS / HANDOFF 产物',
      '停止没有可验证指标的继续扩展',
    ],
  };
}

function initialAssessment(thread, nowMs, duplicates) {
  const staleDays = ageDays(thread, nowMs);
  const waiting = waitingEvidence(thread);
  const duplicate = duplicates.get(thread.id);
  const cleanupReasons = [];
  const evidence = [];
  const recoveryTitle = RECOVERY_TITLE_RE.test(compactTitleText(thread.title));
  const completedSubagent = completedSubagentEvidence(thread);

  if (staleDays !== null && staleDays >= GOVERNANCE_CONFIG.cleanupDefaultDays) {
    cleanupReasons.push({
      code: 'stale',
      label: `超过 ${GOVERNANCE_CONFIG.cleanupDefaultDays} 天未更新`,
      detail: `最后更新于 ${staleDays} 天前`,
    });
  }
  if (duplicate && !duplicate.isCanonical) {
    cleanupReasons.push({
      code: 'exact-duplicate',
      label: '精确同标题重复',
      detail: `同项目共 ${duplicate.count} 个同标题任务`,
    });
  }
  if (recoveryTitle && staleDays !== null && staleDays >= GOVERNANCE_CONFIG.activeWindowDays) {
    cleanupReasons.push({
      code: 'recovery-copy',
      label: '恢复 / 继续 / 挂起类任务',
      detail: '标题包含恢复、继续、挂起或相近线索',
    });
  }
  if (completedSubagent) {
    cleanupReasons.push({
      code: 'completed-subagent',
      label: '已完成子代理候选',
      detail: completedSubagent,
    });
  }

  let category = 'dormant';
  if (thread.archived) {
    category = 'archived';
    evidence.push({ code: 'archived', label: '已归档', detail: '上游 archived 标记为真' });
  } else if (isAutomationThread(thread)) {
    category = 'automation';
    evidence.push({ code: 'automation', label: '自动化', detail: '自动化字段或上下文标记命中' });
  } else if (waiting.length) {
    category = 'waiting';
    evidence.push(...waiting);
  } else if (cleanupReasons.length) {
    category = 'cleanup';
    evidence.push(...cleanupReasons);
  } else if (thread.status === 'running' || (staleDays !== null && staleDays <= GOVERNANCE_CONFIG.activeWindowDays)) {
    category = 'active';
    evidence.push({
      code: thread.status === 'running' ? 'running' : 'recent',
      label: thread.status === 'running' ? '正在运行' : '近期推进',
      detail: thread.status === 'running' ? '有当前轮运行证据' : `最后更新于 ${staleDays} 天前`,
    });
  } else {
    evidence.push({
      code: 'dormant',
      label: '近期未推进',
      detail: staleDays === null ? '缺少可靠更新时间，不推断为已完成' : `最后更新于 ${staleDays} 天前`,
    });
  }

  const canonical = duplicate?.canonical && duplicate.canonical.id !== thread.id
    ? duplicate.canonical
    : null;
  return {
    ...thread,
    governanceCategory: category,
    governanceLabel: CATEGORY_META[category].label,
    governanceEvidence: evidence,
    cleanupReasons,
    staleDays,
    recoveryTitle,
    canonicalThread: canonical ? {
      id: canonical.id,
      title: canonical.title,
      updatedAtMs: canonical.updatedAtMs,
      projectName: canonical.projectName,
    } : null,
    similarThreads: [],
    longRunAlert: buildLongRunAlert(thread),
  };
}

function attachSimilarThreads(threads) {
  const projects = new Map();
  const preparedTitles = new Map();
  for (const thread of threads) {
    preparedTitles.set(thread, prepareGovernanceTitle(thread.title));
    const key = projectKey(thread);
    const group = projects.get(key) || [];
    group.push(thread);
    projects.set(key, group);
  }

  for (const [key, group] of projects) {
    projects.set(key, group
      .filter((thread) => !thread.archived)
      .sort(canonicalComparator)
      .slice(0, GOVERNANCE_CONFIG.similarTitleCandidateLimit));
  }

  return threads.map((thread) => {
    if (!thread.cleanupReasons.length || thread.archived) return thread;
    const clues = (projects.get(projectKey(thread)) || [])
      .filter((candidate) => candidate.id !== thread.id)
      .map((candidate) => ({
        thread: candidate,
        similarity: preparedTitleSimilarity(
          preparedTitles.get(thread),
          preparedTitles.get(candidate),
        ),
      }))
      .filter((candidate) => candidate.similarity >= GOVERNANCE_CONFIG.similarTitleThreshold)
      .sort((a, b) => b.similarity - a.similarity
        || canonicalComparator(a.thread, b.thread))
      .slice(0, GOVERNANCE_CONFIG.maxSimilarThreads)
      .map(({ thread: candidate, similarity }) => ({
        id: candidate.id,
        title: candidate.title,
        updatedAtMs: candidate.updatedAtMs,
        similarity: Number(similarity.toFixed(2)),
        governanceCategory: candidate.governanceCategory,
      }));
    const canonicalThread = thread.canonicalThread || (clues[0] ? {
      id: clues[0].id,
      title: clues[0].title,
      updatedAtMs: clues[0].updatedAtMs,
      projectName: thread.projectName,
    } : null);
    return { ...thread, similarThreads: clues, canonicalThread };
  });
}

function governanceSummary(threads) {
  const categoryOrder = ['active', 'waiting', 'automation', 'cleanup', 'dormant', 'archived'];
  const lanes = categoryOrder.map((key) => ({
    key,
    ...CATEGORY_META[key],
    count: threads.filter((thread) => thread.governanceCategory === key).length,
  }));
  const activeMainCount = threads.filter((thread) => (
    thread.governanceCategory === 'active'
    && !isSubagentThread(thread)
  )).length;
  const cleanupThreads = threads.filter((thread) => thread.cleanupReasons.length && !thread.archived);
  const reasons = {};
  for (const thread of cleanupThreads) {
    for (const reason of thread.cleanupReasons) {
      reasons[reason.code] = number(reasons[reason.code]) + 1;
    }
  }

  return {
    config: GOVERNANCE_CONFIG,
    method: {
      title: '证据优先分类',
      note: 'notLoaded、缺少 transcript 或缺少最新信号都不等于已完成；只有归档标记、明确等待、时间、重复关系、运行/完成事件等证据参与分类。',
    },
    lanes,
    wip: {
      activeMainCount,
      recommendedLimit: GOVERNANCE_CONFIG.wipLimit,
      overBy: Math.max(0, activeMainCount - GOVERNANCE_CONFIG.wipLimit),
      advisory: `建议同时推进的 Active 主任务不超过 ${GOVERNANCE_CONFIG.wipLimit} 个；这是注意力预算建议，不是强制规则。`,
    },
    cleanup: {
      defaultStaleDays: GOVERNANCE_CONFIG.cleanupDefaultDays,
      staleDayOptions: GOVERNANCE_CONFIG.staleDayOptions,
      candidateCount: cleanupThreads.length,
      candidateIds: cleanupThreads.map((thread) => thread.id),
      reasonCounts: reasons,
      readOnly: true,
      capabilityNote: '当前只生成 dry-run 清单，不调用 Codex 归档、删除或移动接口。',
    },
    longRun: {
      alertCount: threads.filter((thread) => thread.longRunAlert).length,
      scannedCount: threads.filter((thread) => thread.workMetrics?.scope === 'full-rollout').length,
      ruleNote: '预警由工具/压缩/agent task、用户反馈和产物/验证信号共同决定，不按总 token 单独判定。',
    },
  };
}

function projectCostBreakdown(breakdown = {}) {
  return {
    total: number(breakdown.total),
    cachedInput: number(breakdown.cacheRead),
    nonCachedInput: number(breakdown.input),
    cacheWrite: number(breakdown.cacheWrite),
    output: number(breakdown.output),
    reasoning: number(breakdown.reasoning),
    uncategorized: number(breakdown.uncategorized),
  };
}

function projectPortfolio(threads, nowMs) {
  const groups = new Map();
  for (const thread of threads) {
    const key = projectKey(thread);
    const existing = groups.get(key) || {
      id: key,
      cwd: thread.cwd || '',
      projectName: thread.projectName || '未知项目',
      threads: [],
    };
    existing.threads.push(thread);
    groups.set(key, existing);
  }

  return [...groups.values()].map((project) => {
    const all = [...project.threads].sort((a, b) => number(b.updatedAtMs) - number(a.updatedAtMs));
    const active = all.filter((thread) => thread.governanceCategory === 'active');
    const waiting = all.filter((thread) => thread.governanceCategory === 'waiting');
    const cleanup = all.filter((thread) => thread.governanceCategory === 'cleanup');
    const archived = all.filter((thread) => thread.archived);
    const tokenBreakdown = all.reduce((sum, thread) => addTokenBreakdowns(
      sum,
      tokenBreakdownWithFallbackTotal(thread.tokenBreakdown, thread.tokensUsed),
    ), addTokenBreakdowns());
    const artifacts = all.flatMap((thread) => (thread.artifacts?.items || []).map((artifact) => ({
      ...artifact,
      threadId: thread.id,
      threadTitle: thread.title,
      atMs: artifact.atMs || thread.artifacts?.latestAtMs || thread.updatedAtMs,
    }))).sort((a, b) => number(b.atMs) - number(a.atMs));
    const latestUpdatedAtMs = number(all[0]?.updatedAtMs);
    const recentCount = all.filter((thread) => {
      const days = ageDays(thread, nowMs);
      return !thread.archived && days !== null && days <= GOVERNANCE_CONFIG.activeWindowDays;
    }).length;
    const staleCount = all.filter((thread) => (
      !thread.archived && number(thread.staleDays, -1) >= GOVERNANCE_CONFIG.cleanupDefaultDays
    )).length;
    const longRunAlertCount = all.filter((thread) => thread.longRunAlert).length;
    const activeMainCount = active.filter((thread) => !isSubagentThread(thread)).length;
    const priorityScore = waiting.length * 100
      + longRunAlertCount * 60
      + activeMainCount * 20
      + recentCount * 4
      + Math.min(cleanup.length, 10);

    return {
      id: project.id,
      cwd: project.cwd,
      projectName: project.projectName,
      taskCount: all.length,
      activeCount: active.length,
      activeMainCount,
      recentCount,
      waitingCount: waiting.length,
      automationCount: all.filter((thread) => thread.governanceCategory === 'automation').length,
      cleanupCount: cleanup.length,
      staleCount,
      archivedCount: archived.length,
      archivedRatio: all.length ? archived.length / all.length : 0,
      subagentCount: all.filter(isSubagentThread).length,
      longRunAlertCount,
      latestUpdatedAtMs,
      tokenBreakdown,
      costBreakdown: projectCostBreakdown(tokenBreakdown),
      representativeArtifacts: artifacts.slice(0, 3),
      latestActions: all.slice(0, 3).map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAtMs: thread.updatedAtMs,
        category: thread.governanceCategory,
        categoryLabel: thread.governanceLabel,
        artifactCount: number(thread.artifacts?.total),
      })),
      candidateThreadIds: all.slice(0, 12).map((thread) => thread.id),
      priorityScore,
    };
  }).sort((a, b) => b.priorityScore - a.priorityScore
    || b.latestUpdatedAtMs - a.latestUpdatedAtMs
    || a.projectName.localeCompare(b.projectName));
}

export function buildGovernanceModel(threads = [], nowMs = Date.now()) {
  const duplicates = exactDuplicateContext(threads);
  const assessed = attachSimilarThreads(threads.map((thread) => initialAssessment(thread, nowMs, duplicates)));
  return {
    threads: assessed,
    governance: governanceSummary(assessed),
    portfolio: projectPortfolio(assessed, nowMs),
  };
}
