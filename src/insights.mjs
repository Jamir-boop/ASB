import path from 'node:path';
import { stripWindowsVerbatimPath } from './platform-paths.mjs';
import { subagentInfo } from './thread-classification.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coerceNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unixValueToMs(value) {
  const number = coerceNumber(value);
  if (number <= 0) return 0;
  return number > 1_000_000_000_000 ? number : number * 1000;
}

// `titleByThreadId` is the Codex session index (thread ID to title). A thread that has no name of its own gets the title of its entry.
export function normalizeThread(row, titleByThreadId = null) {
  const cwd = stripWindowsVerbatimPath(row.cwd || '');
  const id = String(row.id || '');
  const archived = Boolean(coerceNumber(row.archived));
  const updatedAtMs = unixValueToMs(row.updated_at_ms ?? row.updated_at);
  const createdAtMs = unixValueToMs(row.created_at_ms ?? row.created_at);
  const projectName = cwd ? path.basename(cwd) : '未知项目';
  const source = String(row.source || '');
  const isCodexCli = ['cli', 'terminal', 'tui'].includes(source.toLowerCase());
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
    cwd,
    projectName,
    source,
    model: row.model || row.model_provider || '',
    reasoningEffort: row.reasoning_effort || '',
    tokensUsed: coerceNumber(row.tokens_used),
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

  return thread;
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

export function normalizeDashboardThreads(threads) {
  return attachThreadRelationships(threads
    .map((thread) => ({ ...thread }))
    .sort((a, b) => coerceNumber(b.updatedAtMs) - coerceNumber(a.updatedAtMs)));
}

export function enrichThreads(rows, titleByThreadId = null) {
  return rows.map((row) => normalizeThread(row, titleByThreadId));
}
