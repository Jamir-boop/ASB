import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { enrichThreadRuntime } from './insights.mjs';
import {
  emptyTokenBreakdown,
  tokenBreakdownWithFallbackTotal,
} from './token-usage.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_CINDY_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Cindy');
const DEFAULT_MAX_COUNT = 500;
const CINDY_PROVIDER = {
  id: 'cindy',
  label: 'Cindy',
};
const RAW_HARNESS_PROVIDERS = new Set([
  'claude-code-cli',
  'claude-desktop-code',
  'codex',
  'codex-cli',
  'pi',
]);

function coerceNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampToMs(value) {
  const number = coerceNumber(value);
  if (number <= 0) return 0;
  return number > 1_000_000_000_000 ? number : number * 1000;
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function parseRows(stdout) {
  try {
    const value = JSON.parse(String(stdout || '[]'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function findCindyDatabase(dataDir = DEFAULT_CINDY_DATA_DIR) {
  let names = [];
  try {
    names = await fs.readdir(dataDir);
  } catch {
    return '';
  }

  const candidates = names
    .filter((name) => /^cindy-.*\.db$/i.test(name))
    .sort();
  return candidates.length ? path.join(dataDir, candidates.at(-1)) : '';
}

async function querySqlite(databasePath, sql, runCommand = execFileAsync) {
  if (!databasePath) return [];
  const { stdout } = await runCommand('sqlite3', ['-readonly', '-json', databasePath, sql], {
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseRows(stdout);
}

function harnessInfo(agentKind) {
  const normalized = String(agentKind || '').trim().toLowerCase();
  if (normalized === 'cc' || normalized === 'claude' || normalized === 'claude-code') {
    return { id: 'claude-code', label: 'Claude Code' };
  }
  if (normalized === 'codex') return { id: 'codex', label: 'Codex' };
  if (normalized === 'pi') return { id: 'pi', label: 'Pi' };
  return { id: normalized || 'agent', label: normalized || 'Agent' };
}

function projectNameForSession(row, cwd) {
  if (String(row.workspace_kind || '').toLowerCase() === 'dialogue') return 'Cindy 对话';
  return cwd ? (path.basename(cwd) || 'Cindy') : 'Cindy';
}

function workerIsRunning(status) {
  return ['active', 'busy', 'running', 'working'].includes(String(status || '').toLowerCase());
}

export function normalizeCindySession(row = {}, nowMs = Date.now()) {
  const sessionId = String(row.id || '');
  const harness = harnessInfo(row.agent_kind);
  const cwd = String(row.working_dir || '');
  const sessionStatus = String(row.status || 'active').toLowerCase();
  const archived = sessionStatus === 'archived';
  const createdAtMs = timestampToMs(row.created_at);
  const sessionUpdatedAtMs = timestampToMs(row.updated_at);
  const workerUpdatedAtMs = timestampToMs(row.worker_updated_at);
  const embeddedSubagentUpdatedAtMs = timestampToMs(row.embedded_subagent_updated_at);
  const activeTurnStartedAtMs = timestampToMs(row.active_turn_started_at);
  const lastTurnEndedAtMs = timestampToMs(row.last_turn_ended_at);
  const embeddedSubagentCount = coerceNumber(row.embedded_subagent_count);
  const embeddedSubagentRunningCount = coerceNumber(row.embedded_subagent_running_count);
  const workerRunning = workerIsRunning(row.worker_status);
  const agentRunning = !archived && (
    (activeTurnStartedAtMs > 0 && activeTurnStartedAtMs > lastTurnEndedAtMs)
    || embeddedSubagentRunningCount > 0
    || workerRunning
  );
  const updatedAtMs = Math.max(
    sessionUpdatedAtMs,
    workerUpdatedAtMs,
    embeddedSubagentUpdatedAtMs,
  ) || createdAtMs || nowMs;
  const leadSessionId = String(row.lead_session_id || '');
  const collaborationRole = String(row.orca_role || '').toLowerCase();
  const isWorker = collaborationRole === 'worker' || Boolean(row.worker_id);
  const isSubagent = isWorker;
  const parentThreadId = isWorker && leadSessionId ? `cindy:${leadSessionId}` : '';
  const deepLink = sessionId ? `cindy://session/${encodeURIComponent(sessionId)}` : '';
  const tokensUsed = coerceNumber(row.total_token_usage);
  const thread = {
    id: sessionId ? `cindy:${sessionId}` : '',
    externalId: sessionId,
    provider: CINDY_PROVIDER.id,
    providerLabel: `Cindy · ${harness.label}`,
    frontend: 'cindy',
    frontendLabel: 'Cindy',
    harness: harness.id,
    harnessLabel: harness.label,
    harnessSessionId: String(row.sdk_session_id || ''),
    title: String(row.title || 'Cindy 任务'),
    cwd,
    projectName: projectNameForSession(row, cwd),
    source: `cindy-${harness.id}`,
    model: String(row.model || ''),
    reasoningEffort: '',
    tokensUsed,
    todayTokenUsage: 0,
    tokenBreakdown: tokenBreakdownWithFallbackTotal(emptyTokenBreakdown(), tokensUsed),
    todayTokenBreakdown: emptyTokenBreakdown(),
    hasUnreadTurn: false,
    awaitingPermission: false,
    awaitingReview: false,
    archived,
    createdAtMs: createdAtMs || updatedAtMs,
    updatedAtMs,
    rolloutPath: '',
    gitBranch: '',
    gitSha: '',
    gitOriginUrl: '',
    appDeepLink: deepLink,
    canOpen: Boolean(deepLink),
    openLabel: '打开',
    defaultOpenMode: 'cindy-deeplink',
    resumeCommand: deepLink ? `open ${shellQuote(deepLink)}` : '',
    workspaceKind: String(row.workspace_kind || ''),
    collaborationRole,
    isSubagent,
    parentThreadId,
    agentNickname: String(row.worker_label || ''),
    agentRole: String(row.worker_role || ''),
    workerStatus: String(row.worker_status || ''),
    embeddedSubagentCount,
    embeddedSubagentRunningCount,
    embeddedSubagentUpdatedAtMs: embeddedSubagentUpdatedAtMs || null,
    agentRunning,
    agentStartedAtMs: agentRunning
      ? (activeTurnStartedAtMs || embeddedSubagentUpdatedAtMs || workerUpdatedAtMs || updatedAtMs)
      : null,
    agentActivityAtMs: agentRunning ? updatedAtMs : null,
  };

  return enrichThreadRuntime(thread, nowMs);
}

const CINDY_SESSION_SQL = `
  SELECT
    s.id,
    s.title,
    s.working_dir,
    s.model,
    s.status,
    s.sdk_session_id,
    s.total_token_usage,
    s.created_at,
    s.updated_at,
    s.agent_kind,
    s.source,
    s.orca_role,
    s.workspace_kind,
    s.active_turn_started_at,
    s.last_turn_ended_at,
    w.id AS worker_id,
    w.status AS worker_status,
    w.label AS worker_label,
    w.role AS worker_role,
    w.updated_at AS worker_updated_at,
    t.lead_session_id,
    (
      SELECT COUNT(*)
      FROM subagent_runs sr
      WHERE sr.session_id = s.id AND sr.deleted_at IS NULL
    ) AS embedded_subagent_count,
    (
      SELECT COUNT(*)
      FROM subagent_runs sr
      WHERE sr.session_id = s.id
        AND sr.deleted_at IS NULL
        AND lower(sr.status) = 'running'
    ) AS embedded_subagent_running_count,
    (
      SELECT MAX(sr.updated_at)
      FROM subagent_runs sr
      WHERE sr.session_id = s.id AND sr.deleted_at IS NULL
    ) AS embedded_subagent_updated_at
  FROM sessions s
  LEFT JOIN orca_workers w ON w.session_id = s.id
  LEFT JOIN orca_teams t ON t.id = w.team_id
  WHERE lower(s.status) <> 'deleted'
  ORDER BY MAX(
    s.updated_at,
    COALESCE(w.updated_at, 0),
    COALESCE((
      SELECT MAX(sr.updated_at)
      FROM subagent_runs sr
      WHERE sr.session_id = s.id AND sr.deleted_at IS NULL
    ), 0)
  ) DESC
  LIMIT ?;
`;

export async function loadCindyThreads({
  cindyDataDir = DEFAULT_CINDY_DATA_DIR,
  cindyDatabasePath = '',
  maxCount = DEFAULT_MAX_COUNT,
  nowMs = Date.now(),
  runCommand = execFileAsync,
} = {}) {
  const databasePath = cindyDatabasePath || await findCindyDatabase(cindyDataDir);
  if (!databasePath) {
    return {
      provider: {
        ...CINDY_PROVIDER,
        installed: false,
        status: 'missing',
        message: '未检测到 Cindy 会话数据',
        threadCount: 0,
      },
      threads: [],
      ownedHarnessSessionIds: [],
      databasePath: '',
    };
  }

  const safeLimit = Math.max(1, Math.min(5000, Math.floor(coerceNumber(maxCount, DEFAULT_MAX_COUNT))));
  try {
    const [rows, ownedRows] = await Promise.all([
      querySqlite(databasePath, CINDY_SESSION_SQL.replace('LIMIT ?;', `LIMIT ${safeLimit};`), runCommand),
      querySqlite(
        databasePath,
        "SELECT sdk_session_id FROM sessions WHERE sdk_session_id IS NOT NULL AND sdk_session_id <> '';",
        runCommand,
      ),
    ]);
    const threads = rows
      .map((row) => normalizeCindySession(row, nowMs))
      .filter((thread) => thread.id);
    const hostCount = threads.filter((thread) => !thread.isSubagent).length;
    const workerCount = threads.length - hostCount;

    return {
      provider: {
        ...CINDY_PROVIDER,
        installed: true,
        desktopInstalled: true,
        status: 'ready',
        message: `已读取 ${hostCount} 个 Cindy 任务${workerCount ? `，归拢 ${workerCount} 个 Worker` : ''}`,
        threadCount: threads.length,
        hostThreadCount: hostCount,
        workerThreadCount: workerCount,
      },
      threads,
      ownedHarnessSessionIds: ownedRows.map((row) => String(row.sdk_session_id || '')).filter(Boolean),
      databasePath,
    };
  } catch (error) {
    return {
      provider: {
        ...CINDY_PROVIDER,
        installed: true,
        status: 'error',
        message: `Cindy 会话读取失败：${error instanceof Error ? error.message : String(error)}`,
        threadCount: 0,
      },
      threads: [],
      ownedHarnessSessionIds: [],
      databasePath,
    };
  }
}

function rawHarnessSessionId(thread) {
  return String(
    thread?.harnessSessionId
    || thread?.cliSessionId
    || thread?.externalId
    || '',
  );
}

function mergeHarnessTelemetry(owner, harnessThreads) {
  if (!harnessThreads.length) return owner;
  const mostRecent = [...harnessThreads]
    .sort((left, right) => coerceNumber(right.updatedAtMs) - coerceNumber(left.updatedAtMs))[0];
  const mostComplete = [...harnessThreads]
    .sort((left, right) => coerceNumber(right.tokensUsed) - coerceNumber(left.tokensUsed))[0];
  const embeddedSubagentCount = Math.max(
    coerceNumber(owner.embeddedSubagentCount),
    ...harnessThreads.map((thread) => coerceNumber(thread.embeddedSubagentCount)),
  );
  const embeddedSubagentUpdatedAtMs = Math.max(
    coerceNumber(owner.embeddedSubagentUpdatedAtMs),
    ...harnessThreads.map((thread) => coerceNumber(thread.embeddedSubagentUpdatedAtMs)),
  );

  return {
    ...owner,
    tokensUsed: coerceNumber(owner.tokensUsed) || coerceNumber(mostComplete.tokensUsed),
    todayTokenUsage: coerceNumber(owner.todayTokenUsage) || coerceNumber(mostComplete.todayTokenUsage),
    tokenBreakdown: coerceNumber(owner.tokensUsed) > 0 ? owner.tokenBreakdown : mostComplete.tokenBreakdown,
    todayTokenBreakdown: coerceNumber(owner.todayTokenUsage) > 0
      ? owner.todayTokenBreakdown
      : mostComplete.todayTokenBreakdown,
    rateLimits: owner.rateLimits || mostRecent.rateLimits || null,
    rateLimitUpdatedAtMs: owner.rateLimitUpdatedAtMs || mostRecent.rateLimitUpdatedAtMs || null,
    rateLimitActivityAtMs: owner.rateLimitActivityAtMs || mostRecent.rateLimitActivityAtMs || null,
    firstUserMessage: owner.firstUserMessage || mostRecent.firstUserMessage || '',
    latestUserMessage: owner.latestUserMessage || mostRecent.latestUserMessage || '',
    latestMeaningfulUserMessage: owner.latestMeaningfulUserMessage || mostRecent.latestMeaningfulUserMessage || '',
    lastAgentMessage: owner.lastAgentMessage || mostRecent.lastAgentMessage || '',
    latestUserMessageAtMs: owner.latestUserMessageAtMs || mostRecent.latestUserMessageAtMs || null,
    latestAgentFinalAtMs: owner.latestAgentFinalAtMs || mostRecent.latestAgentFinalAtMs || null,
    pendingTools: owner.pendingTools || mostRecent.pendingTools || [],
    pendingToolCount: coerceNumber(owner.pendingToolCount) || coerceNumber(mostRecent.pendingToolCount),
    awaitingPermission: Boolean(owner.awaitingPermission || mostRecent.awaitingPermission),
    gitBranch: owner.gitBranch || mostRecent.gitBranch || '',
    embeddedSubagentCount,
    embeddedSubagentUpdatedAtMs: embeddedSubagentUpdatedAtMs || null,
    updatedAtMs: Math.max(coerceNumber(owner.updatedAtMs), coerceNumber(mostRecent.updatedAtMs)),
    agentActivityAtMs: Math.max(coerceNumber(owner.agentActivityAtMs), coerceNumber(mostRecent.updatedAtMs)) || null,
  };
}

export function reconcileCindyOwnedHarnessThreads(rawThreads = [], cindyResult = {}) {
  const ownedIds = new Set((cindyResult.ownedHarnessSessionIds || []).map(String).filter(Boolean));
  const harnessThreadsById = new Map();
  const independent = [];

  for (const thread of rawThreads) {
    const harnessSessionId = rawHarnessSessionId(thread);
    if (RAW_HARNESS_PROVIDERS.has(thread?.provider) && ownedIds.has(harnessSessionId)) {
      const matches = harnessThreadsById.get(harnessSessionId) || [];
      matches.push(thread);
      harnessThreadsById.set(harnessSessionId, matches);
      continue;
    }
    independent.push(thread);
  }

  const owners = (cindyResult.threads || []).map((thread) => mergeHarnessTelemetry(
    thread,
    harnessThreadsById.get(String(thread.harnessSessionId || '')) || [],
  ));
  return [...independent, ...owners];
}
