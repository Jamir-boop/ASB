import path from 'node:path';
import { stripWindowsVerbatimPath } from './platform-paths.mjs';
import { subagentInfo } from './thread-classification.mjs';

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

// Sets the runtime fields on a thread that the caller owns.
function applyThreadRuntime(thread, nowMs) {
  const startedAtMs = hasActiveCurrentTurn(thread, nowMs)
    ? currentTurnStartedAtMs(thread)
    : 0;
  thread.currentTurnStartedAtMs = startedAtMs || null;
  thread.currentTurnElapsedMs = startedAtMs ? Math.max(0, nowMs - startedAtMs) : 0;
  thread.status = inferThreadStatus(thread, nowMs);
  return thread;
}

export function enrichThreadRuntime(thread, nowMs = Date.now()) {
  return applyThreadRuntime({ ...thread }, nowMs);
}

// `titleByThreadId` is the Codex session index (thread ID to title). With it, a thread that has no name of its own gets the title of its entry,
// and only a thread that has an entry is in the Codex sidebar. Without it, the fields of the row decide.
export function normalizeThread(row, nowMs = Date.now(), titleByThreadId = null) {
  const cwd = stripWindowsVerbatimPath(row.cwd || '');
  const id = String(row.id || '');
  const archived = Boolean(coerceNumber(row.archived));
  const updatedAtMs = unixValueToMs(row.updated_at_ms ?? row.updated_at);
  const createdAtMs = unixValueToMs(row.created_at_ms ?? row.created_at);
  const projectName = cwd ? path.basename(cwd) : '未知项目';
  const source = String(row.source || '');
  const isCodexCli = ['cli', 'terminal', 'tui'].includes(source.toLowerCase());
  const inCodexSidebar = titleByThreadId ? titleByThreadId.has(id) : coerceBoolean(row.in_codex_sidebar ?? row.inCodexSidebar, true);
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
    title: row.name || titleByThreadId?.get(id) || row.thread_name || row.title || '',
    desktopName: row.name || '',
    cwd,
    projectName,
    source,
    model: row.model || row.model_provider || '',
    reasoningEffort: row.reasoning_effort || '',
    tokensUsed: coerceNumber(row.tokens_used),
    hasUnreadTurn: Boolean(coerceNumber(row.has_unread_turn ?? row.hasUnreadTurn ?? row.awaiting_review ?? row.awaitingReview)),
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

  return applyThreadRuntime(thread, nowMs);
}

const NO_THREADS = Object.freeze([]);

// The subagent tree of a list of threads. It reads only `id`, `isSubagent`, and `parentThreadId`, and it changes no thread.
// `descendantsFor(id)` gives the threads below a thread (each child, then the threads below it). Do not change this list.
export function threadTree(threads) {
  const byId = new Map();
  for (const thread of threads) byId.set(thread.id, thread);
  const childrenByParent = new Map();

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId || '';
    if (!thread.isSubagent || !parentThreadId) continue;

    const children = childrenByParent.get(parentThreadId);
    if (children) children.push(thread);
    else childrenByParent.set(parentThreadId, [thread]);
  }

  const descendantsById = new Map();
  // The threads on the path of the walk now: a thread that is its own ancestor ends the walk.
  const visiting = new Set();
  function descendantsFor(threadId) {
    if (descendantsById.has(threadId)) return descendantsById.get(threadId);
    const children = childrenByParent.get(threadId);
    if (!children || visiting.has(threadId)) return NO_THREADS;

    visiting.add(threadId);
    const descendants = [];
    const seen = new Set();
    for (const child of children) {
      if (!seen.has(child.id)) {
        descendants.push(child);
        seen.add(child.id);
      }
      for (const nested of descendantsFor(child.id)) {
        if (seen.has(nested.id)) continue;
        descendants.push(nested);
        seen.add(nested.id);
      }
    }
    visiting.delete(threadId);
    descendantsById.set(threadId, descendants);
    return descendants;
  }

  return { byId, childrenByParent, descendantsFor };
}

// Adds the fields of the subagent tree to the threads. The caller owns the threads (`normalizeDashboardThreads` made them),
// so each thread gets its fields in place. No added field is a field that this function reads.
function attachThreadRelationships(threads) {
  const { byId, childrenByParent, descendantsFor } = threadTree(threads);

  function hostThreadIdFor(thread) {
    let current = thread;
    let seen = null;
    while (current?.isSubagent && current.parentThreadId && !seen?.has(current.id)) {
      (seen ||= new Set()).add(current.id);
      const parent = byId.get(current.parentThreadId);
      if (!parent) return current.parentThreadId;
      current = parent;
    }
    return current?.id || thread.parentThreadId || thread.id;
  }

  for (const thread of threads) {
    const children = childrenByParent.get(thread.id) || NO_THREADS;
    const descendants = descendantsFor(thread.id);
    const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : null;
    let groupUpdatedAtMs = Math.max(coerceNumber(thread.updatedAtMs), coerceNumber(thread.embeddedSubagentUpdatedAtMs));
    let embeddedSubagentCount = coerceNumber(thread.embeddedSubagentCount);
    for (const member of descendants) {
      groupUpdatedAtMs = Math.max(groupUpdatedAtMs, coerceNumber(member.updatedAtMs), coerceNumber(member.embeddedSubagentUpdatedAtMs));
      embeddedSubagentCount += coerceNumber(member.embeddedSubagentCount);
    }

    thread.parentThreadTitle = parent?.title || '';
    thread.parentThreadProjectName = parent?.projectName || '';
    thread.parentThreadProviderLabel = parent?.providerLabel || '';
    thread.childThreadIds = children.map((child) => child.id);
    thread.descendantThreadIds = descendants.map((child) => child.id);
    thread.subagentCount = descendants.length + embeddedSubagentCount;
    thread.hostThreadId = hostThreadIdFor(thread);
    thread.groupUpdatedAtMs = groupUpdatedAtMs;
  }
  return threads;
}

export function normalizeDashboardThreads(threads, nowMs = Date.now()) {
  return attachThreadRelationships(threads
    .map((thread) => enrichThreadRuntime(thread, nowMs))
    .sort((a, b) => coerceNumber(b.updatedAtMs) - coerceNumber(a.updatedAtMs)));
}

export function enrichThreads(rows, nowMs = Date.now(), titleByThreadId = null) {
  return rows.map((row) => normalizeThread(row, nowMs, titleByThreadId));
}
