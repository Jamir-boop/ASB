import path from 'node:path';
import { isAutomationThread, subagentInfo } from './thread-classification.mjs';

const FRESH_WINDOW_MS = 15 * 60 * 1000;
const WARM_WINDOW_MS = 6 * 60 * 60 * 1000;
const RUNNING_ACTIVITY_WINDOW_MS = WARM_WINDOW_MS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coerceNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function coerceBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  }
  return Boolean(coerceNumber(value));
}

function unixValueToMs(value) {
  const number = coerceNumber(value);
  if (number <= 0) return 0;
  return number > 1_000_000_000_000 ? number : number * 1000;
}

function currentTurnStartedAtMs(thread) {
  if (['claude-code-cli', 'claude-desktop-code'].includes(thread.provider)
    && (thread.lifecycleRunning === false || (thread.childWorkUnknown && thread.lifecycleRunning !== true))) return 0;
  if (thread.agentRunning || thread.isAgentRunning) {
    return coerceNumber(
      thread.currentTurnStartedAtMs
      || thread.agentStartedAtMs
      || thread.latestUserMessageAtMs
      || thread.createdAtMs
      || thread.updatedAtMs,
    );
  }

  const userAtMs = coerceNumber(thread.currentTurnStartedAtMs || thread.latestUserMessageAtMs);
  const finalAtMs = coerceNumber(thread.latestAgentFinalAtMs);
  return userAtMs > 0 && userAtMs > finalAtMs ? userAtMs : 0;
}

function currentTurnActivityAtMs(thread) {
  const startedAtMs = currentTurnStartedAtMs(thread);
  if (!startedAtMs) return 0;
  const rateLimitActivityAtMs = Object.prototype.hasOwnProperty.call(thread, 'rateLimitActivityAtMs')
    ? coerceNumber(thread.rateLimitActivityAtMs)
    : coerceNumber(thread.rateLimitUpdatedAtMs);

  return Math.max(
    startedAtMs,
    coerceNumber(thread.updatedAtMs),
    coerceNumber(thread.agentActivityAtMs),
    rateLimitActivityAtMs,
  );
}

function hasActiveCurrentTurn(thread, nowMs) {
  if (['claude-code-cli', 'claude-desktop-code'].includes(thread.provider) && thread.lifecycleRunning === true) {
    const activityAtMs = coerceNumber(thread.agentActivityAtMs);
    return activityAtMs > 0 && Math.max(0, nowMs - activityAtMs) <= RUNNING_ACTIVITY_WINDOW_MS;
  }
  const activityAtMs = currentTurnActivityAtMs(thread);
  return activityAtMs > 0 && Math.max(0, nowMs - activityAtMs) <= RUNNING_ACTIVITY_WINDOW_MS;
}

export function inferThreadStatus(thread, nowMs = Date.now()) {
  if (thread.archived) return 'archived';
  if (hasActiveCurrentTurn(thread, nowMs)) return 'running';

  const ageMs = Math.max(0, nowMs - coerceNumber(thread.updatedAtMs));
  if (ageMs <= FRESH_WINDOW_MS) return 'fresh';
  if (ageMs <= WARM_WINDOW_MS) return 'warm';
  return 'idle';
}

export function enrichThreadRuntime(thread, nowMs = Date.now()) {
  const startedAtMs = hasActiveCurrentTurn(thread, nowMs)
    ? currentTurnStartedAtMs(thread)
    : 0;
  const runtimeThread = {
    ...thread,
    currentTurnStartedAtMs: startedAtMs || null,
    currentTurnElapsedMs: startedAtMs ? Math.max(0, nowMs - startedAtMs) : 0,
  };

  return {
    ...runtimeThread,
    status: inferThreadStatus(runtimeThread, nowMs),
  };
}

export function normalizeThread(row, nowMs = Date.now()) {
  const cwd = row.cwd || '';
  const id = String(row.id || '');
  const archived = Boolean(coerceNumber(row.archived));
  const updatedAtMs = unixValueToMs(row.updated_at_ms ?? row.updated_at);
  const createdAtMs = unixValueToMs(row.created_at_ms ?? row.created_at);
  const projectName = cwd ? path.basename(cwd) : '未知项目';
  const source = String(row.source || '');
  const isCodexCli = ['cli', 'terminal', 'tui'].includes(source.toLowerCase());
  const inCodexSidebar = coerceBoolean(row.in_codex_sidebar ?? row.inCodexSidebar, true);
  const defaultOpenMode = isCodexCli ? 'codex-cli-resume' : 'codex-deeplink';
  const subagent = subagentInfo(row);
  const goalStatus = String(row.goal_status || '').toLowerCase();
  const goalCreatedAtMs = unixValueToMs(row.goal_created_at_ms);
  const goalUpdatedAtMs = unixValueToMs(row.goal_updated_at_ms);
  const hasActiveGoal = goalStatus === 'active';
  const thread = {
    id,
    externalId: id,
    provider: isCodexCli ? 'codex-cli' : 'codex',
    providerLabel: isCodexCli ? 'Codex CLI' : 'Codex',
    title: row.name || row.thread_name || row.title || '',
    desktopName: row.name || '',
    cwd,
    projectName,
    source,
    model: row.model || row.model_provider || '',
    reasoningEffort: row.reasoning_effort || '',
    tokensUsed: coerceNumber(row.tokens_used),
    hasUnreadTurn: Boolean(coerceNumber(row.has_unread_turn ?? row.hasUnreadTurn ?? row.awaiting_review ?? row.awaitingReview)),
    pinned: coerceBoolean(row.pinned ?? row.is_pinned ?? row.isPinned, false),
    threadSource: row.thread_source || '',
    originator: row.originator || '',
    agentPath: row.agent_path || '',
    creatorAccountId: row.creator_account_id || '',
    creatorUserId: row.creator_user_id || '',
    archived,
    createdAtMs,
    updatedAtMs,
    rolloutPath: row.rollout_path || '',
    gitBranch: row.git_branch || '',
    gitSha: row.git_sha || '',
    gitOriginUrl: row.git_origin_url || '',
    appDeepLink: UUID_RE.test(id) ? `codex://threads/${id}` : '',
    canOpen: UUID_RE.test(id),
    openLabel: '打开',
    defaultOpenMode,
    inCodexSidebar,
    isAutomation: isAutomationThread(row),
    isSubagent: subagent.isSubagent,
    parentThreadId: subagent.parentThreadId,
    subagentDepth: subagent.depth,
    agentNickname: row.agent_nickname || subagent.agentNickname || '',
    agentRole: row.agent_role || subagent.agentRole || '',
    goalId: row.goal_id || '',
    goalStatus,
    goalTokenBudget: row.goal_token_budget == null ? null : coerceNumber(row.goal_token_budget),
    goalTokensUsed: coerceNumber(row.goal_tokens_used),
    goalTimeUsedSeconds: coerceNumber(row.goal_time_used_seconds),
    goalCreatedAtMs: goalCreatedAtMs || null,
    goalUpdatedAtMs: goalUpdatedAtMs || null,
    activeGoal: hasActiveGoal,
    agentRunning: hasActiveGoal,
    agentStartedAtMs: hasActiveGoal ? goalCreatedAtMs : null,
    agentActivityAtMs: hasActiveGoal ? (goalUpdatedAtMs || updatedAtMs) : null,
  };

  return {
    ...enrichThreadRuntime(thread, nowMs),
  };
}

function attachThreadRelationships(threads) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map();

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId || '';
    if (!thread.isSubagent || !parentThreadId) continue;

    const children = childrenByParent.get(parentThreadId) || [];
    children.push(thread);
    childrenByParent.set(parentThreadId, children);
  }

  const descendantsById = new Map();
  function descendantsFor(threadId, visiting = new Set()) {
    if (descendantsById.has(threadId)) return descendantsById.get(threadId);
    if (visiting.has(threadId)) return [];

    const nextVisiting = new Set(visiting);
    nextVisiting.add(threadId);
    const descendants = [];
    const seen = new Set();
    for (const child of childrenByParent.get(threadId) || []) {
      if (!seen.has(child.id)) {
        descendants.push(child);
        seen.add(child.id);
      }
      for (const nested of descendantsFor(child.id, nextVisiting)) {
        if (seen.has(nested.id)) continue;
        descendants.push(nested);
        seen.add(nested.id);
      }
    }
    descendantsById.set(threadId, descendants);
    return descendants;
  }

  function hostThreadIdFor(thread) {
    let current = thread;
    const seen = new Set();
    while (current?.isSubagent && current.parentThreadId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentThreadId);
      if (!parent) return current.parentThreadId;
      current = parent;
    }
    return current?.id || thread.parentThreadId || thread.id;
  }

  return threads.map((thread) => {
    const children = childrenByParent.get(thread.id) || [];
    const descendants = descendantsFor(thread.id);
    const groupMembers = [thread, ...descendants];
    const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : null;
    const groupUpdatedAtMs = Math.max(...groupMembers.flatMap((member) => [
      coerceNumber(member.updatedAtMs),
      coerceNumber(member.embeddedSubagentUpdatedAtMs),
    ]));
    const embeddedSubagentCount = groupMembers.reduce(
      (sum, member) => sum + coerceNumber(member.embeddedSubagentCount),
      0,
    );

    return {
      ...thread,
      parentThreadTitle: parent?.title || '',
      parentThreadProjectName: parent?.projectName || '',
      parentThreadProviderLabel: parent?.providerLabel || '',
      childThreadIds: children.map((child) => child.id),
      descendantThreadIds: descendants.map((child) => child.id),
      subagentCount: descendants.length + embeddedSubagentCount,
      hostThreadId: hostThreadIdFor(thread),
      groupUpdatedAtMs,
    };
  });
}

export function normalizeDashboardThreads(threads, nowMs = Date.now()) {
  return attachThreadRelationships(threads
    .map((thread) => enrichThreadRuntime(thread, nowMs))
    .sort((a, b) => coerceNumber(b.updatedAtMs) - coerceNumber(a.updatedAtMs)));
}

export function enrichThreads(rows, nowMs = Date.now()) {
  return rows.map((row) => normalizeThread(row, nowMs));
}
