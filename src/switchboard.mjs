import path from 'node:path';
import os from 'node:os';
import { promises as fs, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCodexDashboard, invalidateCodexData, discoverCodexStateDatabase, querySqliteJson, retainCodexDataScopes, SESSION_MESSAGE_WINDOW_MS } from './codex-data.mjs';
import { DEFAULT_CLAUDE_PROJECTS_DIR, defaultClaudeAppDir, invalidateClaudeData, openClaudeThread, retainClaudeDataSources } from './claude-data.mjs';
import { loadSwitchboardClaudeThreads, claudeRemoteDeepLink, claudeRemoteStatus,
  invalidateClaudeRemoteData, isClaudeRemoteCacheEvent, shutdownClaudeRemoteParser } from './claude-remote-data.mjs';
import { normalizeDashboardThreads } from './insights.mjs';
import { loadOpenCodeDashboard, invalidateOpenCodeData, retainOpenCodeDataScopes, opencodeBridgeId, defaultOpenCodeStateDir } from './opencode-data.mjs';
import { createAsbServer } from './asb-server.mjs';
import { createBridgeCoverage } from './bridge-coverage.mjs';
import { createActivityMessages } from './activity-messages.mjs';
import { createClaudeMessages } from './claude-messages.mjs';
import { createActivityUsage } from './activity-usage.mjs';
import { createUsageBackup } from './usage-backup.mjs';
import { createSoundPlayer, createSoundWatcher } from './asb-sounds.mjs';
import { openThreadInCodex, scopedCommand } from './session-opener.mjs';
import { AppSourceRegistry, appSourcesRevision, numberAppSources, sourceName, validateSourceLauncher } from './app-sources.mjs';
import { cacheDir, stateDir } from './platform-paths.mjs';
import { rowReference, shortReference } from './session-references.mjs';
import { MEMBER_MESSAGE_KEYS } from './machine-peers.mjs';
import { CLI_SESSION_IDS, bindLocalTarget, bindMemberTarget, memberTarget, notSentMessage, referencesForList, resolveSessionReference } from './session-targets.mjs';
import { readLiveClaudeRegistry } from './claude-registry.mjs';
import { spawn } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const QUESTION_AT = Symbol('ASB question timestamp');
const ACTION_AT = Symbol('ASB required action timestamp');
const SOURCE_DIR = Symbol('ASB session store');
// A CLI row that more than one source lists, with no single source of origin.
const SHARED_CLI = Symbol('ASB shared CLI session');
const DISCARD_TASK = Symbol('ASB discard task signals');
// A member row that shows as Unknown only because the member is offline: its state is not new, so the tracker and the sounds keep their last values.
export const OFFLINE_MEMBER = Symbol('ASB offline member row');
const READ_FIELDS = ['questionSeen', 'questionAck', 'actionSeen', 'actionAck', 'nativeAt', 'nativeAck', 'nativeSeen',
  'discard', 'discardedAt', 'discardStart', 'discardEnd', 'discardNative', 'drawerSeen'];
const RETAINED_SOURCES = ['native-unread', 'observed-completion', 'observed-failure'];
// A record that ASB did not see for 30 days goes. The time of the last sight is the start of a UTC day. It moves at most once a day, and for all rows
// at the same scan, so a scan does not rewrite pending.json for it, and the first scan of a day rewrites the file once.
const RECORD_KEEP_MS = 30 * 86_400_000;
const RECORD_TOUCH_MS = 86_400_000;
// pending.json has each record without the fields that hold their default (0 or the empty string). The loader reads a missing field as that default,
// also the loader of ASB 1.10.0. These five are always saved: ASB 1.10.0 rejects a record that lacks one of the first four, and `lastSeen` has no default.
const ALWAYS_SAVED = new Set(['seen', 'working', 'pending', 'ack', 'lastSeen']);
const STOPPED_KINDS = ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled'];
const MESSAGE_KEYS = Symbol('ASB session message keys');
const TITLE_LIMIT = 300;
const MAX_SESSION_MESSAGES = 50;
const BRIDGE_ALIAS = /^(?:session|cse)_([A-Za-z0-9_-]{1,128})$/;
// The Codex thread sources of terminal tasks; `src/insights.mjs` also treats `terminal` and `tui` as CLI.
const CODEX_CLI_SOURCES = ['cli', 'exec', 'terminal', 'tui'];
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_VERSION = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;

// A stored title can hold a whole prompt; a row and its tooltip show only the start.
function capTitle(title) {
  if (title.length <= TITLE_LIMIT) return title;
  const points = [...title];
  return points.length > TITLE_LIMIT ? `${points.slice(0, TITLE_LIMIT - 1).join('')}…` : title;
}

// The short host name, safe for a card label.
export function localMachineName(hostName = os.hostname()) {
  return String(hostName || '').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'This PC';
}

export function switchboardRefreshInterval(dashboard) {
  return dashboard.threads?.some((row) => !row.archived && isSwitchboardRoot(row) && row.state === 'working') ? 2_000 : 5_000;
}

export function switchboardWatchPaths({ homeDir = os.homedir(), appDir = defaultClaudeAppDir(),
  codexDir = path.join(homeDir, '.codex'), projectsDir = path.join(homeDir, '.claude', 'projects'),
  openCodeDir = path.join(process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'opencode') } = {}) {
  const directoryOrFile = (pattern) => (filename, event) => !filename || pattern.test(path.basename(filename))
    || (event === 'rename' && !path.extname(path.basename(filename)));
  return [
    { path: codexDir, source: 'codex', acceptEvent: (filename) => !filename
      || /^(state_\d+\.sqlite(?:-wal)?|session_index\.jsonl|\.codex-global-state\.json|sessions)$/.test(filename) },
    { path: path.join(codexDir, 'sessions'), source: 'codex', recursive: true,
      acceptEvent: directoryOrFile(/^rollout-.*\.jsonl$/) },
    // A PC with only Claude Code CLI has no Claude app folder.
    { path: path.join(appDir, 'claude-code-sessions'), source: 'claude', recursive: true, optional: true,
      acceptEvent: directoryOrFile(/^local_.*\.json$/) },
    { path: path.join(appDir, 'Cache', 'Cache_Data'), source: 'claude', optional: true,
      acceptEvent: (filename, event) => isClaudeRemoteCacheEvent(path.join(appDir, 'Cache', 'Cache_Data'), filename, event) },
    { path: projectsDir, source: 'claude', recursive: true, acceptEvent: directoryOrFile(/\.jsonl$/) },
    { path: path.join(path.dirname(projectsDir), 'sessions'), source: 'claude', optional: true,
      acceptEvent: directoryOrFile(/^[1-9][0-9]*\.json$/) },
    { path: openCodeDir, source: 'opencode', optional: true,
      acceptEvent: (filename) => !filename || /^opencode\.db(?:-wal)?$/.test(filename) },
  ];
}

export function isSwitchboardRoot(thread) {
  return !thread.isSubagent && !thread.sideChat && !['subagent', 'guardian_review'].includes(thread.threadSource);
}

// A pending Claude tool with a known time is current for six hours only.
function pendingToolStale(thread, nowMs) {
  const pendingAt = Number(thread.pendingToolAtMs || 0);
  return pendingAt > 0 && nowMs - pendingAt > ACTIVITY_WINDOW_MS;
}

export function switchboardStatus(thread, nowMs = Date.now()) {
  if (thread.source === 'claude-remote-cache') return claudeRemoteStatus(thread, nowMs);
  const questionAt = Number(thread.latestBlockingQuestionAtMs || 0);
  if (thread.userQuestionBlocking && questionAt >= Number(thread.latestLifecycleAtMs || 0)
    && nowMs - questionAt <= ACTIVITY_WINDOW_MS) {
    return { state: 'waiting', reason: 'The current tool is waiting for an answer.' };
  }
  if ((thread.awaitingPermission || thread.pendingToolCount) && !thread.questionNonBlocking && !pendingToolStale(thread, nowMs)) {
    return { state: 'waiting', reason: !thread.liveWaitingFor ? 'A user action is required.'
      : thread.liveWaitingFor === 'input needed' ? 'Claude waits for your answer.' : 'Claude waits for your permission.' };
  }
  if (thread.groupChildWaiting) return { state: 'waiting', reason: 'A linked child is waiting for an answer.' };
  if (thread.cliNoTranscript) return { state: 'idle', reason: 'The CLI session has no task yet.' };
  if (thread.lifecycleRunning === false) return { state: 'idle', reason: 'The last task ended.' };
  if (thread.lifecycleRunning === true) {
    if (thread.cliProcessEnded) return { state: 'unknown', reason: 'The CLI process ended during a task.' };
    const activityAtMs = Number(thread.agentActivityAtMs ?? thread.latestLifecycleAtMs);
    return activityAtMs > 0 && nowMs - activityAtMs <= ACTIVITY_WINDOW_MS
      ? { state: 'working', reason: 'The local log has an open task.' }
      : { state: 'unknown', reason: 'The last task has no recent signal.' };
  }
  if (thread.childWorkUnknown) return { state: 'unknown', reason: 'A linked child has no current task signal.' };
  const userAt = Number(thread.latestUserMessageAtMs || 0);
  const finalAt = Number(thread.latestAgentFinalAtMs || 0);
  if (finalAt && finalAt >= userAt) return { state: 'idle', reason: 'The last response ended.' };
  if (thread.provider === 'claude-desktop-code' && userAt > finalAt
    && nowMs - Number(thread.transcriptActivityAtMs || 0) <= ACTIVITY_WINDOW_MS) {
    return { state: 'working', reason: 'The local transcript has an open request.' };
  }
  return { state: 'unknown', reason: 'No current task signal is available.' };
}

function codexGroupLifecycle(thread, byId, nowMs) {
  if (!['codex', 'codex-cli'].includes(thread.provider)) return thread;
  const children = thread.descendantThreadIds.map((id) => byId.get(id))
    .filter((child) => child && !child.archived && ['codex', 'codex-cli'].includes(child.provider));
  if (!children.length) return thread;
  const work = [thread, ...children];
  const active = work.filter((member) => member.lifecycleRunning === true);
  const recent = active.filter((member) => Number(member.agentActivityAtMs || member.latestLifecycleAtMs) > 0
    && nowMs - Number(member.agentActivityAtMs || member.latestLifecycleAtMs) <= ACTIVITY_WINDOW_MS);
  const starts = recent.map((member) => Number(member.agentStartedAtMs || 0)).filter((value) => value > 0);
  const blocked = (member) => member.userQuestionBlocking
    && Number(member.latestBlockingQuestionAtMs || 0) >= Number(member.latestLifecycleAtMs || 0)
    && nowMs - Number(member.latestBlockingQuestionAtMs || 0) <= ACTIVITY_WINDOW_MS;
  const blockedChildren = children.filter(blocked);
  const expirySignals = [...recent.map((member) => Number(member.agentActivityAtMs || member.latestLifecycleAtMs)),
    ...blockedChildren.map((member) => Number(member.latestBlockingQuestionAtMs || 0))];
  const unknown = children.some((child) => child.lifecycleRunning == null);
  const latestEnd = work.filter((member) => member.lifecycleRunning === false)
    .sort((a, b) => Number(b.latestLifecycleAtMs || 0) - Number(a.latestLifecycleAtMs || 0))[0];
  const lastEnded = work.map((member) => ({
    atMs: Number(member.latestTaskEndedAtMs || (member.lifecycleRunning === false ? member.latestLifecycleAtMs : 0) || 0),
    kind: member.latestTaskEndKind || (member.lifecycleRunning === false ? member.latestLifecycleKind : ''),
  })).filter((end) => end.atMs).sort((a, b) => b.atMs - a.atMs)[0];
  const groupEnded = !unknown && lastEnded && active.every((member) => {
    const start = Number(member.latestTaskStartedAtMs || member.agentStartedAtMs || 0);
    const linkedStart = member === thread || member.latestTaskEndedAtMs ? start
      : Math.min(Number(member.createdAtMs || 0), start);
    return linkedStart > lastEnded.atMs;
  });
  return { ...thread,
    lifecycleRunning: active.length ? true : unknown ? undefined : thread.lifecycleRunning,
    childWorkUnknown: unknown,
    groupChildWaiting: blockedChildren.length > 0 && !recent.some((member) => !blocked(member)),
    awaitingUserInput: work.some((member) => member.awaitingUserInput),
    latestUserQuestionAtMs: Math.max(0, ...work.filter((member) => member.awaitingUserInput).map((member) => Number(member.latestUserQuestionAtMs || 0))),
    agentStartedAtMs: starts.length ? Math.min(...starts) : 0,
    agentActivityAtMs: active.length ? Math.max(...active.map((member) => Number(member.agentActivityAtMs || member.latestLifecycleAtMs || 0))) : 0,
    groupStatusActivityAtMs: expirySignals.length ? Math.min(...expirySignals) : 0,
    groupTaskEndedAtMs: groupEnded ? lastEnded.atMs : 0,
    groupTaskEndKind: groupEnded ? lastEnded.kind : '',
    latestLifecycleKind: active.length || unknown ? 'task_started' : latestEnd?.latestLifecycleKind || '',
    latestLifecycleAtMs: active.length || unknown ? thread.latestLifecycleAtMs : latestEnd?.latestLifecycleAtMs || 0,
    groupCompletionAtMs: active.length || unknown || ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed'].includes(latestEnd?.latestLifecycleKind) ? 0
      : Math.max(0, ...work.map((member) => Math.max(member.latestLifecycleKind === 'task_complete' ? Number(member.latestLifecycleAtMs || 0) : 0,
        Number(member.latestAgentFinalAtMs || 0)))),
  };
}

// Newest sent row time first, then the row ID: two scans with the same sent values give the same order.
export const byRowTime = (a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The same keys with equal values. `same(key, x, y)` compares two values that are not equal.
function sameFields(a, b, same) {
  let count = 0;
  for (const key in a) {
    count += 1;
    const x = a[key], y = b[key];
    if (x === y ? x === undefined && !(key in b) : !same(key, x, y)) return false;
  }
  for (const key in b) count -= 1;
  return count === 0;
}
const plainObject = (value) => Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
// Arrays with the same items: equal values, or plain objects with the same keys and equal values (for example, the incoming messages).
const sameItems = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, index) => x === b[index]
  || plainObject(x) && plainObject(b[index]) && sameFields(x, b[index], () => false));
// The thread fields of a row. `currentTurnElapsedMs` changes at each scan, and no row reads it.
const sameRowThread = (a, b) => sameFields(a, b, (key, x, y) => key === 'currentTurnElapsedMs' ? key in b : sameItems(x, y));

// The non-enumerable fields of a row, for its copies.
function hiddenFields(row) {
  const fields = {};
  for (const symbol of Object.getOwnPropertySymbols(row)) fields[symbol] = Object.getOwnPropertyDescriptor(row, symbol);
  return fields;
}

// The times at which the rules of one row can change with no input change: the six-hour windows, the child end grace,
// the approval check, and the limit reset. `nextStatusCheckAtMs` is the earliest of all rows.
function rowStatusTimes(thread, row) {
  return [thread.latestBlockingQuestionAtMs, thread.groupStatusActivityAtMs, thread.pendingToolAtMs,
    thread.source === 'claude-remote-cache' ? thread.remoteObservedAtMs : 0,
    thread.lifecycleRunning === true ? thread.agentActivityAtMs ?? thread.latestLifecycleAtMs : 0,
    thread.provider === 'claude-desktop-code' && thread.lifecycleRunning == null ? thread.transcriptActivityAtMs : 0]
    .map((value) => Number(value || 0) + ACTIVITY_WINDOW_MS + 1)
    .concat(Number(thread.childEndGraceAtMs || 0) + 1, Number(thread.approvalCheckAtMs || 0) + 1, row.limitResetsAtMs);
}

// `workingStarts` is the engine's map of row ID -> the row time of the first scan in which the row was Working.
// `rowCache` is the engine's map of row ID -> the last built row: a row whose thread fields and machine are the same, and whose status
// times did not pass, is a copy of that row. A kept Working row keeps its `workingStarts` entry, because each scan since its build kept it
// Working. With no cache, each row is built.
export function buildSwitchboardDashboard(threads, providers = [], nowMs = Date.now(),
  machine = { machineId: '', machineName: localMachineName() }, workingStarts = new Map(), rowCache = null) {
  const normalizedThreads = normalizeDashboardThreads(threads, nowMs);
  const byId = new Map(normalizedThreads.map((thread) => [thread.id, thread]));
  const roots = normalizedThreads.filter(isSwitchboardRoot).map((thread) => codexGroupLifecycle(thread, byId, nowMs));
  const keptRows = new Map();
  const statusTimes = new Map();
  const board = {
    generatedAtMs: nowMs,
    providers,
    threads: roots.map((thread) => {
      const kept = rowCache?.get(thread.id);
      // A remote cache row has a clock skew rule with no status time, so it is always built.
      // The copy ends 1 ms before the earliest status time, so a time with a fraction of a millisecond cannot keep a row past a rule change.
      if (kept && thread.source !== 'claude-remote-cache' && nowMs >= kept.builtAtMs && nowMs + 1 < kept.validUntilMs
        && kept.machineId === machine.machineId && kept.machineName === machine.machineName && sameRowThread(kept.thread, thread)) {
        keptRows.set(thread.id, kept);
        statusTimes.set(thread.id, kept.statusTimes);
        return Object.defineProperties({ ...kept.row }, kept.hidden);
      }
      const isCodex = ['codex', 'codex-cli'].includes(thread.provider);
      const externalId = thread.externalId || thread.id;
      const validCodex = isCodex && UUID.test(externalId);
      const validClaude = thread.provider === 'claude-desktop-code'
        && String(thread.externalId).startsWith('local_') && UUID.test(String(thread.externalId).slice(6));
      const appDeepLink = validCodex ? `codex://threads/${externalId}`
        : validClaude ? `claude://code/continue?session=${encodeURIComponent(thread.externalId)}`
          : thread.provider === 'claude-desktop-code' && thread.source === 'claude-remote-cache'
            ? claudeRemoteDeepLink(thread.externalId) : '';
      const surface = isCodex ? (CODEX_CLI_SOURCES.includes(String(thread.source).toLowerCase()) ? 'cli' : 'app')
        : thread.surface === 'cli' ? 'cli' : 'app';
      // A CLI session or a session on another machine shows as a card but never opens from ASB.
      const viewOnly = surface === 'cli' || thread.remote === true;
      const status = switchboardStatus(thread, nowMs);
      const startedAtMs = Number(thread.lifecycleRunning === true ? thread.agentStartedAtMs
        : thread.provider === 'claude-desktop-code' ? thread.latestUserMessageAtMs : 0);
      const lastOutcome = status.state !== 'idle' ? '' : STOPPED_KINDS.includes(thread.latestLifecycleKind) ? 'stopped'
        : Number(thread.limitStoppedAtMs) > 0 || Number(thread.limitResetsAtMs) > 0 ? 'limit'
          : thread.latestLifecycleKind === 'failed' ? 'failed' : '';
      const updatedAtMs = Number(thread.groupUpdatedAtMs || thread.updatedAtMs || 0);
      const workingSinceMs = status.state === 'working' && Number.isFinite(startedAtMs) ? Math.max(0, startedAtMs) : 0;
      if (status.state === 'working' && !workingStarts.has(thread.id)) workingStarts.set(thread.id, updatedAtMs);
      const row = {
        id: thread.id,
        externalId,
        ...(thread.sourceId ? { sourceId: thread.sourceId, sourceLabel: thread.sourceLabel, sourceName: thread.sourceName,
          sourceNumber: thread.sourceNumber, sourceCount: thread.sourceCount, sourceColor: thread.sourceColor,
          sourceShowMarker: thread.sourceShowMarker } : {}),
        provider: isCodex ? 'codex' : thread.provider,
        providerLabel: isCodex ? (surface === 'cli' ? 'Codex CLI' : 'Codex') : thread.provider === 'opencode' ? 'OpenCode'
          : surface === 'cli' ? 'Claude Code CLI' : 'Claude Desktop Code',
        surface,
        machineId: machine.machineId,
        machineName: machine.machineName,
        remote: false,
        globalId: machine.machineId ? `${machine.machineId}:${thread.id}` : '',
        remoteCache: thread.source === 'claude-remote-cache',
        title: capTitle(thread.title || 'Untitled session'),
        cwd: thread.cwd || '',
        projectName: thread.cwd ? path.basename(thread.cwd) || thread.cwd
          : thread.source === 'claude-remote-cache' ? thread.projectName || 'No project' : 'No project',
        archived: Boolean(thread.archived),
        // A working row changes its last event time each scan; its turn start keeps the list tag.
        updatedAtMs: status.state !== 'working' ? updatedAtMs : workingSinceMs > 0 ? workingSinceMs : workingStarts.get(thread.id),
        subagentCount: Number(thread.subagentCount || 0),
        ...status,
        workingSinceMs,
        nativeUnread: thread.source === 'claude-remote-cache' && status.state === 'unknown' ? null : thread.nativeUnread ?? null,
        readStatus: thread.source === 'claude-remote-cache' && status.state === 'unknown' ? 'unknown' : thread.readStatus || 'unknown',
        questionPending: Boolean(thread.awaitingUserInput) && !pendingToolStale(thread, nowMs),
        actionRequired: status.state === 'waiting' && (thread.source === 'claude-remote-cache'
          || (thread.pendingTools || []).some((tool) => tool.tool !== 'AskUserQuestion')
          || (thread.awaitingPermission && !thread.awaitingUserInput)),
        lastOutcome,
        failedAtMs: ['failed', 'limit'].includes(lastOutcome) ? Number(thread.latestLifecycleAtMs || 0) : 0,
        completionAtMs: lastOutcome === 'limit' ? 0 : thread.groupCompletionAtMs ?? (['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed'].includes(thread.latestLifecycleKind) ? 0
          : Math.max(thread.latestLifecycleKind === 'task_complete' ? Number(thread.latestLifecycleAtMs || 0) : 0,
            Number(thread.latestAgentFinalAtMs || 0))),
        canOpen: !viewOnly && Boolean(appDeepLink) && thread.sourceCanOpen !== false,
        appDeepLink: viewOnly ? '' : appDeepLink,
      };
      // A usage limit stopped the session, and its reset is still in the future.
      const limit = Number(thread.limitResetsAtMs || 0);
      row.limitResetsAtMs = limit > nowMs && status.state !== 'working' && !(status.state === 'waiting' && row.actionRequired) ? limit : 0;
      Object.defineProperty(row, QUESTION_AT, { value: Number(thread.latestUserQuestionAtMs || 0) });
      Object.defineProperty(row, ACTION_AT, { value: Number(thread.pendingToolAtMs || 0) });
      Object.defineProperty(row, DISCARD_TASK, { value: {
        atMs: thread.groupTaskEndedAtMs ?? Number(thread.latestTaskEndedAtMs || (thread.lifecycleRunning === false ? thread.latestLifecycleAtMs : 0)
          || row.completionAtMs || row.failedAtMs || 0),
        kind: lastOutcome === 'limit' ? 'failed' : thread.groupTaskEndKind ?? (thread.latestTaskEndKind || (thread.lifecycleRunning === false ? thread.latestLifecycleKind : '')
          || (row.failedAtMs ? 'failed' : row.completionAtMs ? 'task_complete' : '')),
        rootStart: Number(thread.latestTaskStartedAtMs || thread.agentStartedAtMs || 0),
        rootEnd: Number(thread.latestTaskEndedAtMs || (thread.lifecycleRunning === false ? thread.latestLifecycleAtMs : 0) || 0),
      } });
      if (thread.sourceDataDir) Object.defineProperty(row, SOURCE_DIR, { value: thread.sourceDataDir });
      if (thread.cliSharedSource) Object.defineProperty(row, SHARED_CLI, { value: true });
      // Only this engine's reference binder reads these IDs; row JSON (dashboard API, phone, members) never has them.
      if (thread.provider === 'claude-desktop-code' && thread.source !== 'claude-remote-cache') Object.defineProperty(row, CLI_SESSION_IDS,
        { value: [thread.cliSessionId, ...(thread.priorCliSessionIds || [])].filter((id) => typeof id === 'string' && id) });
      const times = rowStatusTimes(thread, row);
      statusTimes.set(thread.id, times);
      // The kept row is a copy, so that the engine's in-place changes do not reach it.
      if (rowCache) keptRows.set(thread.id, { thread, row: { ...row }, hidden: hiddenFields(row), statusTimes: times, builtAtMs: nowMs,
        validUntilMs: Math.min(...times.filter((value) => value > nowMs)), machineId: machine.machineId, machineName: machine.machineName });
      return row;
    }).sort(byRowTime),
  };
  if (rowCache) {
    rowCache.clear();
    for (const [id, entry] of keptRows) rowCache.set(id, entry);
  }
  const working = new Set(board.threads.filter((row) => row.state === 'working').map((row) => row.id));
  for (const id of workingStarts.keys()) if (!working.has(id)) workingStarts.delete(id);
  let nextStatusCheckAtMs = Infinity;
  for (const times of statusTimes.values()) for (const value of times) if (value > nowMs && value < nextStatusCheckAtMs) nextStatusCheckAtMs = value;
  Object.defineProperty(board, 'nextStatusCheckAtMs', { value: nextStatusCheckAtMs });
  board.refreshIntervalMs = switchboardRefreshInterval(board);
  board.messages = resolveSessionMessages(normalizedThreads, board.threads,
    { sinceMs: nowMs - SESSION_MESSAGE_WINDOW_MS, untilMs: nowMs + 5_000 });
  Object.defineProperty(board, MESSAGE_KEYS, { value: board.messages[MESSAGE_KEYS] });
  return board;
}

// The native message keys of each row and the incoming messages whose sender is not a local key, for the machine group.
export function sessionMessageKeys(dashboard) {
  return dashboard?.[MESSAGE_KEYS] || { keysByRow: new Map(), ambiguous: [], unresolved: [] };
}

// The native session key -> row ID map of [key, row ID] pairs, in order. A key of two rows maps to null, and stays null.
export function sessionKeyLookup(pairs) {
  const lookup = new Map();
  for (const [key, rowId] of pairs) if (key) lookup.set(key, lookup.has(key) && lookup.get(key) !== rowId ? null : rowId);
  return lookup;
}

// Maps the native session IDs of the sources to row IDs, and returns only row ID pairs and times.
export function resolveSessionMessages(threads, rows, { sinceMs, untilMs }) {
  const rowIds = new Set(rows.map((row) => row.id));
  const rowOf = (thread) => rowIds.has(thread.id) ? thread.id : rowIds.has(thread.hostThreadId) ? thread.hostThreadId : '';
  const pairs = [];
  const add = (key, rowId) => pairs.push([key, rowId]);
  const addBridge = (alias, rowId) => {
    const token = typeof alias === 'string' ? alias.match(BRIDGE_ALIAS)?.[1] : '';
    if (token) for (const prefix of ['session', 'cse']) add(`bridge:${prefix}_${token}`, rowId);
  };
  for (const thread of threads) {
    const rowId = rowOf(thread);
    if (!rowId) continue;
    const externalId = String(thread.externalId || thread.id || '');
    add(externalId, rowId);
    if (thread.provider === 'opencode') add(opencodeBridgeId(externalId), rowId);
    if (thread.provider !== 'claude-desktop-code') continue;
    if (thread.source === 'claude-remote-cache') { addBridge(externalId, rowId); continue; }
    add(String(thread.cliSessionId || ''), rowId);
    for (const id of Array.isArray(thread.priorCliSessionIds) ? thread.priorCliSessionIds : []) add(String(id || ''), rowId);
    for (const alias of Array.isArray(thread.bridgeSessionIds) ? thread.bridgeSessionIds : []) addBridge(alias, rowId);
  }
  const lookup = sessionKeyLookup(pairs);
  const messages = new Map();
  const unresolved = new Map();
  for (const thread of threads) {
    if (!Array.isArray(thread.incomingMessages)) continue;
    const to = rowOf(thread);
    for (const message of to ? thread.incomingMessages : []) {
      const key = String(message?.from || '');
      const from = lookup.get(key);
      const atMs = Number(message?.atMs);
      if (!(atMs >= sinceMs && atMs <= untilMs)) continue;
      // A sender that is not a local key can be a session on another machine.
      if (from === undefined && key) unresolved.set(`${key}\0${to}\0${atMs}`, { to, from: key, atMs });
      if (!from || from === to) continue;
      messages.set(`${from}\0${to}\0${atMs}`, { from, to, atMs });
    }
  }
  const keysByRow = new Map();
  for (const [key, rowId] of lookup) if (rowId) keysByRow.set(rowId, [...(keysByRow.get(rowId) || []), key]);
  const result = sortSessionMessages([...messages.values()]);
  const ambiguous = [...lookup].filter(([, rowId]) => rowId === null).map(([key]) => key);
  Object.defineProperty(result, MESSAGE_KEYS, { value: { keysByRow, ambiguous, unresolved: [...unresolved.values()] } });
  return result;
}

// Sorted by time, then sender and receiver row IDs; the newest 50.
export function sortSessionMessages(messages) {
  return messages.sort((a, b) => a.atMs - b.atMs || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
    || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)).slice(-MAX_SESSION_MESSAGES);
}

function sourceCacheScope(source) {
  return source.provider !== 'claude-desktop-code' ? source.dataDir
    : `${source.dataDir}\0${source.projectsDir || path.join(os.homedir(), '.claude', 'projects')}`;
}

function retainSourceCaches(sources) {
  const enabled = sources.filter((source) => source.enabled);
  // OpenCode rows read their receiver databases through the Codex bridge message cache, with the OpenCode source scope.
  retainCodexDataScopes(enabled.filter((source) => source.provider === 'codex' || source.provider === 'opencode').map(sourceCacheScope));
  retainOpenCodeDataScopes(enabled.filter((source) => source.provider === 'opencode').map(sourceCacheScope));
  retainClaudeDataSources(enabled.filter((source) => source.provider === 'claude-desktop-code').map((source) => ({
    cacheScope: sourceCacheScope(source), appDir: source.dataDir,
    projectsDir: source.projectsDir || path.join(os.homedir(), '.claude', 'projects'),
  })));
}

export async function loadSwitchboardDashboard({
  nowMs = Date.now(),
  loadCodex = loadCodexDashboard,
  loadClaude = loadSwitchboardClaudeThreads,
  loadOpenCode = loadOpenCodeDashboard,
  codexOptions = {},
  claudeOptions = {},
  sources = null,
  sourceScans = {},
  machine,
  workingStarts,
  rowCache = null,
} = {}) {
  const inputs = sources ? numberAppSources(sources) : [
    { id: 'codex', provider: 'codex', label: 'Codex', enabled: true },
    { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude Desktop Code', enabled: true },
  ];
  if (sources) retainSourceCaches(inputs);
  // The reads that the loaders of one scan share: the registry folders and the Claude project indexes.
  const registryReads = new Map();
  const results = await Promise.allSettled(inputs.map(async (source) => {
    if (!source.enabled) return null;
    let sourceOptions = {};
    if (sources) {
      // A Claude source also lists the Claude Code CLI sessions of its transcript folder, so its app folder can be absent (a PC with only the CLI).
      const info = await fs.stat(source.dataDir).catch((error) => {
        if (source.provider === 'claude-desktop-code' && error.code === 'ENOENT') return null;
        throw error;
      });
      if (info && !info.isDirectory()) throw new Error('The source path is not a directory.');
      sourceOptions = source.provider === 'codex' ? {
        databasePath: await discoverCodexStateDatabase(source.dataDir),
        sessionIndexPath: path.join(source.dataDir, 'session_index.jsonl'),
        globalStatePath: path.join(source.dataDir, '.codex-global-state.json'),
      } : source.provider === 'opencode' ? { dataDir: source.dataDir, stateDir: defaultOpenCodeStateDir() }
        : { appDir: source.dataDir, projectsDir: source.projectsDir || path.join(os.homedir(), '.claude', 'projects') };
      sourceOptions.cacheScope = sourceCacheScope(source);
      if (source.provider === 'codex' && loadCodex === loadCodexDashboard) await fs.stat(sourceOptions.databasePath);
    }
    if (source.provider === 'opencode') return loadOpenCode({ ...sourceOptions, nowMs, maxCount: 5000 });
    return source.provider === 'codex' ? loadCodex({
      ...codexOptions, ...sourceOptions, nowMs, fileScan: sourceScans.codex,
      codexNativeReadEnabled: true,
      maxRollouts: 5000,
      rolloutThreadFilter: isSwitchboardRoot,
      initialRolloutBytes: 64 * 1024,
      maxRolloutBytes: 256 * 1024,
    }) : loadClaude({ ...claudeOptions, ...sourceOptions, nowMs, fileScan: sourceScans.claude, registryReads, maxCount: 5000, strictMetadataRead: true });
  }));
  const providers = results.map((result, index) => {
    const source = inputs[index];
    const provider = result.status === 'fulfilled' ? result.value?.provider : null;
    const missingLauncher = sources && !source.builtin && !source.launcher;
    const status = !source.enabled ? 'disabled' : missingLauncher ? 'error'
      : sources && result.status === 'rejected' && result.reason?.code === 'ENOENT' ? 'missing'
      : result.status !== 'fulfilled' || provider?.status === 'error' ? 'error'
        : provider?.status === 'warning' ? 'warning' : provider?.installed === false ? 'missing' : 'ready';
    return { id: source.id, label: source.label, status, provider: source.provider, color: source.color,
      message: status === 'error' && missingLauncher ? `Select an installed app launcher for ${source.label}.`
        : status === 'error' ? `Cannot read ${source.label} sessions. Check the local session store.`
        : status === 'warning' ? provider?.message || `Some ${source.label} session files cannot be read.` : '' };
  });
  const threads = results.flatMap((result, index) => {
    if (result.status !== 'fulfilled' || !result.value) return [];
    const source = inputs[index];
    return (result.value.threads || []).map((thread) => {
      if (!sources) return thread;
      const scope = (id) => id && !source.builtin ? `${source.id}:${id}` : id;
      return { ...thread, id: scope(thread.id), parentThreadId: scope(thread.parentThreadId),
        externalId: thread.externalId || thread.id, sourceId: source.id, sourceLabel: source.label, sourceName: sourceName(source),
        sourceNumber: source.sourceNumber, sourceCount: source.sourceCount, sourceColor: source.color,
        sourceShowMarker: source.showMarker,
        sourceCanOpen: source.builtin || Boolean(source.launcher), sourceDataDir: source.dataDir };
    });
  });
  // Two Claude sources that share a registry folder (`asb bridge link-claude`) both list a live CLI session:
  // keep one row, the one with a transcript, else the first in source order.
  const cliRows = new Map();
  const cliCounts = new Map();
  for (const thread of threads) {
    if (thread.source !== 'claude-cli') continue;
    const kept = cliRows.get(thread.externalId);
    if (!kept || (kept.cliNoTranscript && !thread.cliNoTranscript)) cliRows.set(thread.externalId, thread);
    const [listings = 0, transcripts = 0] = cliCounts.get(thread.externalId) || [];
    cliCounts.set(thread.externalId, [listings + 1, transcripts + (thread.cliNoTranscript ? 0 : 1)]);
  }
  // The origin is known only when exactly one listing has a transcript; the first displayed source is not evidence.
  const unique = threads.filter((thread) => thread.source !== 'claude-cli' || cliRows.get(thread.externalId) === thread).map((thread) => {
    const [listings, transcripts] = thread.source === 'claude-cli' ? cliCounts.get(thread.externalId) : [];
    return listings > 1 && transcripts !== 1 ? { ...thread, cliSharedSource: true } : thread;
  });
  return buildSwitchboardDashboard(unique, providers, nowMs, machine, workingStarts, rowCache);
}

export async function openSwitchboardThread(thread, options = {}) {
  if (thread.provider === 'opencode') throw new Error('OpenCode cannot open one session from a link.');
  if (thread.surface === 'cli' || thread.remote === true) throw new Error('This session cannot open from ASB.');
  const externalId = thread.externalId || thread.id;
  const valid = (thread.provider === 'codex' && UUID.test(externalId)
    && thread.appDeepLink === `codex://threads/${externalId}`)
    || (thread.provider === 'claude-desktop-code' && UUID.test(String(thread.externalId).slice(6))
      && thread.externalId.startsWith('local_')
      && thread.appDeepLink === `claude://code/continue?session=${encodeURIComponent(thread.externalId)}`)
    || (thread.provider === 'claude-desktop-code' && Boolean(claudeRemoteDeepLink(thread.externalId))
      && thread.appDeepLink === claudeRemoteDeepLink(thread.externalId));
  if (!thread.canOpen || !valid) throw new Error('This session has no direct desktop link.');
  if (options.launcher) {
    const launcher = await validateSourceLauncher(options.launcher);
    const launchOptions = { detached: true, stdio: 'ignore', windowsHide: true };
    if (options.runCommand) await options.runCommand(launcher, [thread.appDeepLink], launchOptions);
    else await new Promise((resolve, reject) => {
      const scoped = scopedCommand(launcher, [thread.appDeepLink]);
      const app = spawn(scoped.command, scoped.args, launchOptions);
      app.once('error', reject);
      app.once('spawn', () => { app.unref(); resolve(); });
    });
    return { opened: true, method: `${thread.provider}-source-launcher` };
  }
  return thread.provider === 'codex' ? openThreadInCodex(thread, options) : openClaudeThread(thread, options);
}

// The records as pending.json has them: only the fields that do not hold their default.
function savedRecords(records) {
  const saved = Object.create(null);
  for (const id in records) {
    const record = saved[id] = {};
    for (const key in records[id]) if (ALWAYS_SAVED.has(key) || records[id][key] !== 0 && records[id][key] !== '') record[key] = records[id][key];
  }
  return saved;
}

export class PendingTracker {
  constructor(statePath = path.join(stateDir(), 'pending.json')) {
    this.statePath = statePath;
    this.records = Object.create(null);
    this.pinnedOrder = [];
    this.persistentUnread = true;
    this.loaded = false;
    // True while the records, the pin order, or Persistent unread differ from the saved file. Each code path that changes one of them sets it
    // (`set()` for a record field), so save() compares nothing. A scan that changes nothing writes nothing.
    this.dirty = false;
    // The number of finished file writes, for tests.
    this.writeCount = 0;
    this.write = Promise.resolve();
    this.readWarning = '';
    this.saveWarning = '';
    this.bad = false;
  }

  get warning() { return this.saveWarning || this.readWarning; }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.statePath) return;
    try {
      const value = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      this.bad = true;
      if (value?.version === 1 && value.records && typeof value.records === 'object') {
        this.bad = false;
        this.persistentUnread = value.persistentUnread !== false;
        for (const [id, record] of Object.entries(value.records)) {
          if (['seen', 'working', 'pending', 'ack'].every((key) => Number.isFinite(record?.[key]) && record[key] >= 0)) {
            this.records[id] = { ...Object.fromEntries(['seen', 'working', 'pending', 'ack'].map((key) => [key, record[key]])),
              manual: record.manual === 1 ? 1 : 0, retained: RETAINED_SOURCES.includes(record.retained) ? record.retained : '',
              pendingKind: record.pendingKind === 'failed' ? 'failed' : '' };
            for (const key of READ_FIELDS) this.records[id][key] = Number.isFinite(record[key]) && record[key] >= 0 ? record[key] : 0;
            this.records[id].discard = record.discard === 1 ? 1 : 0;
            this.records[id].discardNext = record.discard === 1 && record.discardNext === 1 ? 1 : 0;
            this.records[id].discardNative = record.discardNative === 1 ? 1 : 0;
            this.records[id].drawer = record.drawer === 1 ? 1 : 0;
            this.records[id].muted = record.muted === 1 ? 1 : 0;
            // A file from an older ASB has no time of sight: its records get the whole time from now.
            this.records[id].lastSeen = Number.isFinite(record.lastSeen) && record.lastSeen >= 0 ? record.lastSeen : Date.now();
          } else this.bad = true;
        }
        if (Array.isArray(value.pinnedOrder)) {
          this.pinnedOrder = [...new Set(value.pinnedOrder.filter((id) => typeof id === 'string' && this.records[id]))];
        }
      }
    } catch (error) {
      this.bad = error.code !== 'ENOENT';
    }
    if (this.bad) this.readWarning = 'ASB could not read its Pending state. New completions will still be tracked.';
  }

  // Changes one field of a record and marks the state as not saved. Object.is: a NaN that stays NaN is not a change.
  set(record, key, value) {
    if (Object.is(record[key], value)) return;
    record[key] = value;
    this.dirty = true;
  }

  retain(record, source) {
    if (record && RETAINED_SOURCES.indexOf(source) > RETAINED_SOURCES.indexOf(record.retained)) this.set(record, 'retained', source);
  }

  async save() {
    if (!this.statePath || !this.dirty) return;
    this.dirty = false;
    const content = JSON.stringify({ version: 1, records: savedRecords(this.records), pinnedOrder: this.pinnedOrder, persistentUnread: this.persistentUnread });
    this.write = this.write.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      // Keep the bytes of a state file that ASB could not use in full.
      if (this.bad) await fs.rename(this.statePath, `${this.statePath}.bad`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      this.bad = false;
      await fs.rename(temporary, this.statePath);
      this.writeCount += 1;
    });
    try { await this.write; this.saveWarning = ''; }
    catch { this.dirty = true; this.saveWarning = 'ASB cannot save Pending state. Check its local state folder.'; }
  }

  // `members` is the list of the machine IDs of the active group members, or null while the group is not known.
  async observe(dashboard, members = null) {
    await this.load();
    const nowMs = Number(dashboard.generatedAtMs || Date.now());
    const today = nowMs - nowMs % RECORD_TOUCH_MS;
    for (const row of dashboard.threads) {
      const completion = Math.max(Number(row.completionAtMs || 0), Number(row.failedAtMs || 0));
      let record = this.records[row.id];
      if (!record) {
        record = this.records[row.id] = { seen: completion, working: 0, pending: 0, ack: 0, manual: 0, retained: '', pendingKind: '',
          questionSeen: 0, questionAck: 0, actionSeen: 0, actionAck: 0, nativeAt: 0, nativeAck: 0, nativeSeen: 0,
          discard: 0, discardNext: 0, discardedAt: 0, discardStart: 0, discardEnd: 0, discardNative: 0,
          drawer: 0, drawerSeen: 0, muted: 0, lastSeen: today };
        this.dirty = true;
      }
      if (record.lastSeen < today) this.set(record, 'lastSeen', today);
      const task = row[DISCARD_TASK] || { atMs: completion, kind: row.lastOutcome === 'failed' ? 'failed' : completion ? 'task_complete' : '' };
      // A next-task arm is set on an Idle row. Only a task end after the arm ends it, also when a whole task ran between two scans.
      // When the row is Working, it becomes a current-task arm.
      const next = record.discard === 1 && record.discardNext === 1;
      const taskEnded = task.atMs > record.discardEnd;
      const newRoot = row.state === 'working' && task.rootStart > record.discardStart
        && task.rootEnd > record.discardStart && task.rootStart > task.rootEnd;
      const discardEnded = record.discard === 1 && (next ? (row.state === 'idle' || row.state === 'working') && taskEnded
        : row.state === 'idle' || row.state === 'working' && (taskEnded || newRoot));
      // A muted success takes the discarded-success path, so it leaves no new attention.
      const mutedSuccess = record.muted === 1 && row.state === 'idle' && !row.archived && completion > record.seen
        && task.kind !== 'failed' && !(Number(row.failedAtMs || 0) > Number(row.completionAtMs || 0));
      const discardedSuccess = discardEnded && taskEnded && task.kind === 'task_complete' || mutedSuccess;
      if (discardEnded) { this.set(record, 'discard', 0); this.set(record, 'discardNext', 0); }
      else if (next && row.state === 'working') { this.set(record, 'discardNext', 0); this.set(record, 'discardStart', task.rootStart || 0); }
      if (discardedSuccess) {
        this.set(record, 'discardedAt', task.atMs || completion);
        this.set(record, 'discardNative', 0);
        if (record.pendingKind !== 'failed') this.set(record, 'ack', Math.max(record.ack, record.pending));
        if (['native-unread', 'observed-completion'].includes(record.retained)) this.set(record, 'retained', '');
      }
      if (!discardedSuccess && record.discardedAt && Math.max(task.atMs || 0, completion) > record.discardedAt) {
        this.set(record, 'discardedAt', 0);
        this.set(record, 'discardNative', 0);
      }
      if (row.questionPending) this.set(record, 'questionSeen', Math.max(record.questionSeen, row[QUESTION_AT] || 1));
      // The read mark of a required action lasts for one wait: a member row has no wait time, so the mark goes when the wait ends.
      if (row.actionRequired ?? (row.state === 'waiting' && !row.questionPending)) {
        this.set(record, 'actionSeen', Math.max(record.actionSeen, row[ACTION_AT] || 1));
      } else if (!row[OFFLINE_MEMBER]) { this.set(record, 'actionSeen', 0); this.set(record, 'actionAck', 0); }
      if (row.nativeUnread === true && (!record.nativeSeen || completion > record.seen)) {
        this.set(record, 'nativeAt', Math.max(record.nativeAt + 1, Number(dashboard.generatedAtMs || Date.now()), completion));
      }
      if (row.nativeUnread !== null && row.nativeUnread !== undefined) this.set(record, 'nativeSeen', row.nativeUnread ? 1 : 0);
      // shortcut: The first late source-app manual Unread cannot be distinguished from completion unread, use a per-task read signal when one exists.
      if (row.nativeUnread === true && record.discardedAt > 0 && !record.discardNative
        && row.lastOutcome !== 'failed' && !row.failedAtMs && task.kind !== 'failed'
        && (task.atMs === record.discardedAt || completion === record.discardedAt)) {
        this.set(record, 'nativeAck', record.nativeAt);
        this.set(record, 'discardNative', 1);
        if (record.retained === 'native-unread') this.set(record, 'retained', '');
      }
      if (row.archived) this.set(record, 'working', 0);
      else if (row.state === 'working') this.set(record, 'working', 1);
      else if (row.state === 'idle') {
        if ((record.working || discardEnded) && !discardedSuccess && completion > record.seen) {
          this.set(record, 'pending', completion);
          this.set(record, 'pendingKind', row.failedAtMs > (row.completionAtMs || 0) ? 'failed' : '');
          if (record.retained === 'observed-failure' && record.pendingKind !== 'failed') this.set(record, 'retained', 'observed-completion');
        }
        this.set(record, 'working', 0);
        if (row.nativeUnread === false && !this.persistentUnread) this.set(record, 'ack', Math.max(record.ack, record.pending));
      } else if (row.state !== 'waiting' && !row[OFFLINE_MEMBER]) this.set(record, 'working', 0);
      this.set(record, 'seen', Math.max(record.seen, completion, discardedSuccess ? task.atMs : 0));
      // A result that the user discarded is not new attention for a drawer card.
      if (discardedSuccess) this.set(record, 'drawerSeen', record.seen);
      this.apply(row);
    }
    this.prune(nowMs, members, dashboard.threads);
    await this.save();
    dashboard.pinnedOrder = [...this.pinnedOrder];
    dashboard.persistentUnread = this.persistentUnread;
    if (this.warning) dashboard.providers.push({ id: 'asb-state', label: 'ASB', status: 'warning', message: this.warning });
    return dashboard;
  }

  // Drops the record of a row that ASB did not see for 30 days, unless it has a pin, a mark (unread, an unacknowledged result, question or native
  // unread, or an armed Discard), the drawer, or Mute. Also drops the records of the rows of a machine that is not in `members` (it left the group),
  // with their pins, but not the record of a row that is in this scan.
  prune(nowMs, members, rows) {
    const pinned = new Set(this.pinnedOrder);
    const active = members && new Set(members);
    const present = active && new Set(rows.map((row) => row.id));
    let dropped = false;
    for (const id in this.records) {
      const record = this.records[id];
      const machine = active && /^m:([a-f0-9]{16}):/.exec(id)?.[1];
      const kept = pinned.has(id) || record.manual === 1 || record.drawer === 1 || record.muted === 1 || record.discard === 1 || record.retained
        || record.pending > record.ack || record.questionSeen > record.questionAck || record.actionSeen > record.actionAck
        || record.nativeAt > record.nativeAck;
      if (machine && !active.has(machine) && !present.has(id) || nowMs - record.lastSeen > RECORD_KEEP_MS && !kept) { delete this.records[id]; dropped = true; }
    }
    // A pin always has a record, so only a dropped record can leave a pin without one.
    if (dropped) {
      this.pinnedOrder = this.pinnedOrder.filter((id) => this.records[id]);
      this.dirty = true;
    }
  }

  apply(row) {
    const record = this.records[row.id];
    row.actionRequired ??= row.state === 'waiting' && !row.questionPending;
    row.discardResult = record?.discard === 1 && (row.state === 'working' || row.state === 'idle' && record.discardNext === 1);
    row.pinIndex = this.pinnedOrder.indexOf(row.id);
    row.pinned = row.pinIndex >= 0;
    row.manualUnread = record?.manual === 1;
    row.questionAttention = Boolean(row.questionPending && record?.questionSeen > record?.questionAck);
    row.actionAttention = Boolean(row.actionRequired && (!record || record.actionSeen > record.actionAck));
    row.nativeAttention = Boolean(row.nativeUnread === true && record?.nativeAt > record?.nativeAck);
    const observedAttention = Boolean(!row.archived && row.state === 'idle' && row.nativeUnread === null && record?.pending > record?.ack);
    row.failedAttention = observedAttention && record?.pendingKind === 'failed';
    row.completionAttention = observedAttention && !row.failedAttention;
    if (this.persistentUnread && record) {
      this.retain(record, !row.archived && row.state === 'idle' && record.pending > record.ack
        ? record.pendingKind === 'failed' ? 'observed-failure' : 'observed-completion'
        : row.nativeAttention ? 'native-unread' : '');
    }
    row.retainedUnread = Boolean(record?.retained);
    row.retainedUnreadSource = record?.retained || '';
    // A chat that works or waits for the user leaves the drawer; an unknown read state for a time keeps its place.
    if (record?.drawer === 1 && (record.seen > record.drawerSeen || row.state === 'working' || row.questionAttention || row.actionAttention
      || !(record.manual === 1 || record.retained || record.pending > record.ack
        || row.nativeUnread !== false && record.nativeAt > record.nativeAck))) this.set(record, 'drawer', 0);
    row.drawer = record?.drawer === 1;
    row.muted = record?.muted === 1;
    // A Working row shows only question attention. Stored marks stay and show again after Working ends.
    const working = row.state === 'working';
    row.unread = !working && !row.drawer && (row.manualUnread || row.nativeAttention || row.completionAttention || row.failedAttention || row.retainedUnread);
    row.pending = Boolean(row.unread || row.questionAttention || row.actionAttention);
    row.pendingSource = row.actionAttention ? 'user-action' : row.questionAttention ? 'user-question' : working ? ''
      : row.manualUnread ? 'manual-unread' : row.retainedUnread ? row.retainedUnreadSource
        : row.nativeAttention ? 'native-unread' : row.failedAttention ? 'observed-failure' : row.completionAttention ? 'observed-completion' : '';
    row.alert = row.unread && (row.pendingSource === 'observed-failure'
      || (row.pendingSource === 'native-unread' && ['failed', 'limit'].includes(row.lastOutcome)));
  }

  async setPersistentUnread(enabled, dashboard) {
    await this.load();
    if (this.persistentUnread !== enabled) { this.persistentUnread = enabled; this.dirty = true; }
    for (const row of dashboard.threads) {
      const record = this.records[row.id];
      if (enabled) this.retain(record, row.failedAttention ? 'observed-failure' : row.completionAttention ? 'observed-completion' : row.nativeAttention ? 'native-unread' : '');
      this.apply(row);
    }
    dashboard.persistentUnread = enabled;
    await this.save();
  }

  async markUnread(id) {
    await this.load();
    if (this.records[id]) { this.set(this.records[id], 'manual', 1); this.set(this.records[id], 'drawer', 0); }
    await this.save();
  }

  async setDrawer(row, enabled) {
    await this.load();
    const record = this.records[row.id];
    if (!record) throw Object.assign(new Error('This session is not known to ASB.'), { statusCode: 400 });
    if (enabled && (row.unread !== true || row.questionAttention || row.actionRequired)) {
      throw Object.assign(new Error('The drawer takes only unread sessions.'), { statusCode: 400 });
    }
    if (!enabled && record.drawer !== 1) throw Object.assign(new Error('This session is not in the drawer.'), { statusCode: 400 });
    this.set(record, 'drawer', enabled ? 1 : 0);
    if (enabled) this.set(record, 'drawerSeen', record.seen);
    await this.save();
    this.apply(row);
  }

  async setMuted(row, enabled) {
    await this.load();
    const record = this.records[row.id];
    if (!record) throw Object.assign(new Error('This session is not known to ASB.'), { statusCode: 400 });
    this.set(record, 'muted', enabled ? 1 : 0);
    await this.save();
    this.apply(row);
  }

  // `next` also accepts an Idle row: the arm is then for the next task, and it keeps until a task ends after it.
  async setDiscard(row, enabled, next = false) {
    await this.load();
    if (enabled && row.state !== 'working' && !(next && row.state === 'idle')) {
      throw Object.assign(new Error(next ? 'Discard requires a Working or Idle task.' : 'Discard requires a Working task.'),
        { statusCode: 400, expose: next });
    }
    const record = this.records[row.id];
    if (!record) throw Object.assign(new Error('This session is not known to ASB.'), { statusCode: 400 });
    this.set(record, 'discard', enabled ? 1 : 0);
    this.set(record, 'discardNext', enabled && row.state === 'idle' ? 1 : 0);
    if (enabled) {
      this.set(record, 'discardStart', row[DISCARD_TASK]?.rootStart || 0);
      this.set(record, 'discardEnd', row[DISCARD_TASK]?.atMs || 0);
    }
    await this.save();
    this.apply(row);
  }

  async setPinned(id, pinned) {
    await this.load();
    if (!this.records[id]) throw Object.assign(new Error('This session is not known to ASB.'), { statusCode: 400 });
    if (pinned && !this.pinnedOrder.includes(id)) { this.pinnedOrder.push(id); this.dirty = true; }
    if (!pinned && this.pinnedOrder.includes(id)) { this.pinnedOrder = this.pinnedOrder.filter((value) => value !== id); this.dirty = true; }
    await this.save();
    return [...this.pinnedOrder];
  }

  async movePin(id, body) {
    await this.load();
    const index = this.pinnedOrder.indexOf(id);
    if (index < 0) throw Object.assign(new Error('Only ASB pins can be reordered.'), { statusCode: 400 });
    const before = [...this.pinnedOrder];
    if (body.direction) {
      const target = index + (body.direction === 'up' ? -1 : 1);
      if (target >= 0 && target < this.pinnedOrder.length) {
        [this.pinnedOrder[index], this.pinnedOrder[target]] = [this.pinnedOrder[target], this.pinnedOrder[index]];
      }
    } else {
      if (body.targetId === id || !this.pinnedOrder.includes(body.targetId)) {
        throw Object.assign(new Error('Drop on another ASB pin.'), { statusCode: 400 });
      }
      this.pinnedOrder.splice(index, 1);
      const target = this.pinnedOrder.indexOf(body.targetId) + (body.placement === 'after' ? 1 : 0);
      this.pinnedOrder.splice(target, 0, id);
    }
    if (this.pinnedOrder.some((value, position) => value !== before[position])) this.dirty = true;
    await this.save();
    return [...this.pinnedOrder];
  }

  async acknowledge(id) {
    await this.load();
    const record = this.records[id];
    if (record) {
      this.set(record, 'ack', Math.max(record.ack, record.pending, record.seen));
      this.set(record, 'manual', 0);
      this.set(record, 'retained', '');
      this.set(record, 'questionAck', record.questionSeen);
      this.set(record, 'actionAck', record.actionSeen);
      this.set(record, 'nativeAck', record.nativeAt);
      this.set(record, 'drawer', 0);
    }
    await this.save();
  }
}

export function createSwitchboardServer(options = {}) {
  const tracker = options.pendingTracker || new PendingTracker(options.pendingStatePath);
  const load = options.loadDashboard || loadSwitchboardDashboard;
  // Row ID -> the row time of the first scan in which the row was Working (buildSwitchboardDashboard keeps it).
  const workingStarts = new Map();
  // Row ID -> the last built row and its inputs, so a scan builds only the rows that changed (buildSwitchboardDashboard keeps it).
  const rowCache = new Map();
  const open = options.openThread || openSwitchboardThread;
  const registry = options.sourceRegistry || new AppSourceRegistry();
  const registeredLoad = !options.loadDashboard || Boolean(options.sourceRegistry);
  // Only real entry points pass a player, so tests and imports stay silent.
  // The engine plays sounds only while a native window reports itself; the npm start web view keeps playing them.
  let boardOpen = () => false;
  const sound = options.playSound ? createSoundWatcher(options.playSound, () => !options.serviceMode || boardOpen()) : null;
  // The scope tag of each registered source, made again only when the sources or the machine identity change.
  let scopes = { revision: null, tagger: null, tags: new Map() };
  const sourceScopes = (sources, tagger) => {
    const revision = sources ? appSourcesRevision(sources) : null;
    if (scopes.revision !== revision || scopes.tagger !== tagger) {
      scopes = { revision, tagger, tags: new Map(tagger && sources ? sources.map((source) => [source.id, tagger(source)]) : []) };
    }
    return scopes.tags;
  };
  // Read-only: the cached rows, the registered sources and tags, and the member list that the engine already has.
  const referenceContext = async (dashboard) => {
    const sources = registeredLoad ? await registry.read() : null;
    const machine = options.machineIdentity?.() || { machineId: '', machineName: localMachineName() };
    const tagger = machine.machineId ? options.referenceScopes?.() || null : null;
    const members = options.machineGroup ? (await options.machineGroup.status()).members.filter((member) => !member.isSelf) : [];
    return { threads: dashboard.threads || [], sources: sources || [], tags: sourceScopes(sources, tagger),
      machine: { machineId: tagger ? machine.machineId : '', machineName: machine.machineName }, members };
  };
  const platform = options.platform ?? process.platform;
  // The registry folder of the sending task, only when it is private to this user. Windows has no mode bits:
  // there ASB Bridge proves the user of the target at the write.
  const privateRegistry = async (configDir) => {
    try {
      const root = await fs.realpath(path.join(configDir, 'sessions'));
      const info = await fs.stat(root);
      if (platform === 'win32') return info.isDirectory() ? { root, records: await readLiveClaudeRegistry([root], { windows: true }) } : null;
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return null;
      return { root, records: await readLiveClaudeRegistry([root]) };
    } catch { return null; }
  };
  // The same registry root that src/claude-cli-data.mjs and src/claude-data.mjs read for a Claude source.
  const claudeRoot = (source) => fs.realpath(path.join(path.dirname(source.projectsDir || DEFAULT_CLAUDE_PROJECTS_DIR), 'sessions')).catch(() => null);
  const receiverClaim = async (source, appId) => (await querySqliteJson(path.join(source.dataDir, 'plugin-state', 'asb-bridge', `${appId}.sqlite`),
    'select pid, proc_start from receiver where singleton = 1;').catch(() => []))[0] ?? null;
  const boundIo = { platform, now: Date.now, pid: process.pid, registry: privateRegistry, claudeRoot, receiverClaim };
  // The homes where the receiving engine looks for the target of an exact member send: a CLI or Desktop Code session
  // only in its own source home, a Codex task in the homes that the relay serves.
  const targetHomes = async (type, source) => ['claude-cli', 'claude-local'].includes(type) ? [path.dirname(source.projectsDir || DEFAULT_CLAUDE_PROJECTS_DIR)]
    : options.machineRelay ? (await options.machineRelay.homes(registeredLoad ? await registry.read() : [])).homes.map((home) => home.path) : [];
  const sourceWatchPaths = async () => {
    const sources = await registry.read();
    retainSourceCaches(sources);
    return [
      ...(registry.configPath ? [{ path: path.dirname(registry.configPath), optional: true,
        acceptEvent: (filename) => !filename || filename === path.basename(registry.configPath) }] : []),
      ...sources.filter((source) => source.enabled).flatMap((source) => switchboardWatchPaths(
        source.provider === 'codex' ? { codexDir: source.dataDir } : source.provider === 'opencode' ? { openCodeDir: source.dataDir }
          : { appDir: source.dataDir, projectsDir: source.projectsDir }).filter((spec) =>
            spec.source === (['codex', 'opencode'].includes(source.provider) ? source.provider : 'claude'))),
    ];
  };
  // The check reads the rows of the server made below; it runs only after a request.
  const bridgeCoverage = typeof options.runBridgeCli === 'function' ? createBridgeCoverage({ runCli: options.runBridgeCli,
    readSources: () => registry.read(), readThreads: async () => (await server.dashboardForRequest()).threads || [],
    machine: () => {
      const identity = options.machineIdentity?.();
      return { machineId: identity?.machineId || '', name: identity?.machineName || localMachineName(), asbVersion: options.asbVersion || APP_VERSION };
    }, platform, group: options.machineGroup || null, relay: options.machineRelay || null }) : null;
  const activityMachine = () => {
    const identity = options.machineIdentity?.();
    return { machineId: identity?.machineId || '', name: identity?.machineName || localMachineName() };
  };
  const group = options.machineGroup || null;
  // Contract 2.3 and 4: the token usage of the registered sources and the group. It scans and downloads only when asked.
  // The fetch, cache, and home options are for tests only.
  const usage = options.activityUsage ? null : createActivityUsage({ readSources: async () => registeredLoad ? registry.read() : [],
    members: group ? () => group.activity('all') : null,
    machine: activityMachine, ...(options.usageFetch ? { fetch: options.usageFetch } : {}),
    ...(options.usageCacheDir ? { cacheDir: options.usageCacheDir } : {}),
    ...(options.usageHomeDir ? { homeDir: options.usageHomeDir, env: {} } : {}), ledgerFile: options.usageLedgerFile || '' });
  const activityUsage = options.activityUsage || {
    report: async (period) => usage.report(period, group ? await group.activity(period).catch(() => []) : []),
    localHourly: (period) => usage.localHourly(period),
    ...(usage.exportAll ? { exportAll: async () => usage.exportAll(group ? await group.activity('all').catch(() => []) : []),
      importAll: (document) => usage.importAll(document) } : {}),
  };
  // The daily backups use the group-aware export, so every member is in each file.
  const backup = usage?.exportAll && options.usageBackupFile ? createUsageBackup({ settingsFile: options.usageBackupFile,
    exportAll: () => activityUsage.exportAll(), machineId: () => activityMachine().machineId, platform }) : null;
  if (backup) activityUsage.backup = backup;
  // Contract 2.1, 2.2, and 4: the bridge databases of the registered sources, the cached rows (never a forced scan), and the group.
  const readMessageSources = async () => registeredLoad ? registry.read() : [];
  const claudeMessages = createClaudeMessages({ readSources: readMessageSources,
    stateFile: options.usageLedgerFile ? path.join(options.usageCacheDir || cacheDir(), 'usage', 'claude-message-cache.json') : '' });
  const activityMessages = createActivityMessages({ readSources: readMessageSources, claudeMessages,
    dashboard: () => server.dashboardForRequest(), machine: activityMachine, group, activityUsage });
  const server = createAsbServer({
    dashboardWatchDebounceMs: 250,
    appVersion: APP_VERSION,
    rootDir: ROOT_DIR,
    sourcesPath: registry.configPath,
    readSourcesRevision: async () => appSourcesRevision(await registry.read()),
    readSources: async () => registeredLoad ? registry.read() : [],
    palettePath: path.join(stateDir(), 'palette.json'),
    dashboardWatchPaths: registeredLoad ? sourceWatchPaths : [],
    dashboardSourceChanged: (source, hint) => {
      if (source === 'codex') invalidateCodexData(hint);
      else { invalidateClaudeData(hint); invalidateClaudeRemoteData(hint); }
    },
    panelMachines: async () => {
      const machine = activityMachine();
      const members = group ? (await group.status().catch(() => ({ members: [] }))).members : [];
      return [{ ...machine, self: true, online: true }, ...members.filter((member) => member.isSelf !== true)
        .map((member) => ({ machineId: member.machineId, name: member.name, self: false, online: member.online === true }))
        .sort((a, b) => {
          const left = `${a.name.toLowerCase()}\0${a.machineId}`, right = `${b.name.toLowerCase()}\0${b.machineId}`;
          return left < right ? -1 : left > right ? 1 : 0;
        })];
    },
    ...options,
    loadDashboard: async ({ sourceScans } = {}) => {
      const sources = registeredLoad ? await registry.read() : null;
      const machine = options.machineIdentity?.() || { machineId: '', machineName: localMachineName() };
      // Only the engine passes reader positions: the first scan waits for their load, and each scan can save them.
      await options.readerPositions?.ready();
      const loaded = await load({ ...(sources ? { sources } : {}), machine, sourceScans, workingStarts, rowCache });
      options.readerPositions?.scanDone();
      options.onScanDone?.();
      // The npm start server has no machine identity, so its rows get no full reference.
      const tagger = machine.machineId ? options.referenceScopes?.() || null : null;
      const tags = sourceScopes(sources, tagger);
      for (const row of loaded.threads || []) {
        if (row.remote) continue;
        // Only a registered source has a tag.
        const scopeTag = tags.get(row.sourceId);
        const sessionReference = shortReference(row);
        const reference = rowReference(row, { machineId: tagger ? machine.machineId : '', sourceId: row.sourceId, scopeTag });
        // A shared CLI row keeps the earlier reasons; it gets no reference and sends no scope tag, so a member cannot make one.
        Object.assign(row, row[SHARED_CLI] && reference.reference ? { referenceUnavailable: 'ambiguous-source' } : reference,
          scopeTag && !row[SHARED_CLI] ? { referenceScope: scopeTag } : {}, sessionReference ? { sessionReference } : {});
      }
      // Before the merge, the rows are local only: they set the scan interval of this engine.
      const localRefreshIntervalMs = switchboardRefreshInterval(loaded);
      options.machineGroup?.merge(loaded);
      const dashboard = await tracker.observe(loaded, options.machineGroup?.memberIds?.());
      dashboard.sourcesRevision = sources ? appSourcesRevision(sources) : null;
      // The sound baseline keeps the bits of an offline member's rows, so its return plays only what is new.
      sound?.({ ...dashboard, threads: dashboard.threads.filter((row) => !row[OFFLINE_MEMBER]) });
      if (registeredLoad && registry.warning) dashboard.providers.push({ id: 'asb-sources', label: 'ASB', status: 'warning', message: registry.warning });
      dashboard.refreshIntervalMs = switchboardRefreshInterval(dashboard);
      Object.defineProperty(dashboard, 'localRefreshIntervalMs', { value: localRefreshIntervalMs });
      return dashboard;
    },
    resolveSession: async (request, dashboard) => {
      const result = resolveSessionReference(request, await referenceContext(dashboard));
      if (!request.configDir || !result.ok || result.availability !== 'found' || !['local', 'member'].includes(result.location)
        || !result.identity) return result;
      const rows = dashboard.threads.filter((row) => row.reference === result.identity.reference);
      if (rows.length !== 1) return result;
      const keys = (result.location === 'local' ? sessionMessageKeys(dashboard).keysByRow : dashboard[MEMBER_MESSAGE_KEYS])?.get(rows[0].id);
      if (!keys?.length) return result;
      const registry = await privateRegistry(request.configDir);
      if (!registry) return result;
      const candidates = registry.records.filter((record) => (record.entrypoint === 'asb-relay') === (result.location === 'member')
        && keys.includes(record.sessionId));
      if (candidates.length !== 1) return result;
      const { name } = candidates[0];
      if (typeof name === 'string' && name.length && registry.records.filter((record) => record.name === name).length === 1) result.sendName = name;
      return result;
    },
    resolveBound: async (request, dashboard) => bindLocalTarget(request, await referenceContext(dashboard), boundIo),
    listReferences: async (request, dashboard) => referencesForList(request, await referenceContext(dashboard), boundIo,
      options.machineRelay?.remotePeers?.().peers ?? []),
    sendMember: async ({ reference, caller, mode, message, remainingMs }, dashboard) => {
      const startedAt = Date.now();
      const reply = (outcome, code) => ({ apiVersion: 1, pid: process.pid, msgId: message?.msgId ?? null, outcome,
        ...(outcome === 'not-sent' ? { code, message: notSentMessage(code) } : {}) });
      const target = await memberTarget({ reference, caller }, await referenceContext(dashboard), boundIo);
      if (!target.ok) return reply('not-sent', target.code);
      if (!options.machineRelay?.sendExact) return reply('not-sent', 'unknown-machine');
      const result = await options.machineRelay.sendExact({ identity: target.identity,
        sender: { sessionId: caller.runtimeSessionId, name: target.name, mode, agent: 'codex' }, message,
        remainingMs: Math.max(0, remainingMs - (Date.now() - startedAt)), returnTo: target.returnTo });
      return reply(result.outcome, result.reason);
    },
    listSources: (dashboard) => registry.report(dashboard),
    updateSource: async (source, revision) => { const saved = await registry.update(source, revision); retainSourceCaches(await registry.read()); invalidateCodexData(); invalidateClaudeData(); invalidateClaudeRemoteData(); invalidateOpenCodeData(); return saved; },
    removeSource: async (id, revision) => { const saved = await registry.remove(id, revision); retainSourceCaches(await registry.read()); invalidateCodexData(); invalidateClaudeData(); invalidateClaudeRemoteData(); invalidateOpenCodeData(); return saved; },
    markUnreadThread: async (thread) => {
      await tracker.markUnread(thread.id);
      tracker.apply(thread);
    },
    markReadThread: async (thread) => {
      await tracker.acknowledge(thread.id);
      tracker.apply(thread);
    },
    discardThread: (thread, enabled, next) => {
      if (thread.remote) throw Object.assign(new Error('Discard does not work on a session on another machine.'), { statusCode: 400, expose: true });
      return tracker.setDiscard(thread, enabled, next);
    },
    drawerThread: (thread, enabled) => tracker.setDrawer(thread, enabled),
    muteThread: (thread, enabled) => tracker.setMuted(thread, enabled),
    setUnreadSettings: (enabled, dashboard) => tracker.setPersistentUnread(enabled, dashboard),
    pinThread: async (thread, action, body) => {
      const order = action === 'move-pin' ? await tracker.movePin(thread.id, body)
        : await tracker.setPinned(thread.id, action === 'pin');
      tracker.apply(thread);
      return order;
    },
    openThread: async (thread) => {
      const source = registeredLoad ? (await registry.read()).find((item) => item.id === thread.sourceId && item.enabled) : null;
      if (registeredLoad && !source) throw new Error('This session source is no longer enabled.');
      if (source && !source.builtin && !source.launcher) throw new Error('This app profile needs its own installed app launcher.');
      if (source && (source.provider !== thread.provider || thread[SOURCE_DIR] && source.dataDir !== thread[SOURCE_DIR])) {
        throw new Error('This session source changed. Refresh ASB before opening it.');
      }
      const result = await open(thread, source ? { launcher: source.launcher } : {});
      if (result.opened && !tracker.persistentUnread) {
        await tracker.acknowledge(thread.id);
        tracker.apply(thread);
      }
      return result;
    },
    sourceToken: options.sourceToken || '',
    bridgeCoverage,
    activityMessages,
    activityUsage,
  });
  boardOpen = () => server.boardOpen();
  // The member route GET /peer/v1/bridge (src/phone-gateway.mjs).
  server.bridgeReport = () => bridgeCoverage ? bridgeCoverage.report() : Promise.resolve({ status: 404, body: { error: 'Route is not available.' } });
  // The member route GET /peer/v1/activity (src/phone-gateway.mjs): local records only, no text.
  server.activityMember = (period) => activityMessages.memberReply(period);
  // The engine starts the background usage ledger after its group, and saves the ledger first when it stops.
  server.usageLedger = { start: () => { usage?.start(); backup?.start(); },
    stop: async () => { await backup?.stop(); await (usage?.stop() ?? Promise.resolve()); } };
  // The receiving side of an exact member send (src/machine-relay.mjs): this engine's own binding, from the cached rows.
  server.bindMemberTarget = async (request) => bindMemberTarget(request, await referenceContext(await server.dashboardForRequest()), { ...boundIo, targetHomes });
  const close = server.close.bind(server);
  server.close = (...args) => {
    const result = close(...args);
    // The snapshot stops scans first. Cancel parser work before pending HTTP reads can delay close.
    shutdownClaudeRemoteParser().catch(() => {});
    return result;
  };
  return server;
}

export function switchboardPort(value = process.env.PORT || '4629') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return port;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = switchboardPort();
  const server = createSwitchboardServer({ playSound: createSoundPlayer() });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `ASB cannot start. Port ${port} is in use.` : `ASB cannot start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`ASB: http://127.0.0.1:${port}`);
  });
}
