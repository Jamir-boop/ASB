import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCodexDashboard, invalidateCodexData } from './codex-data.mjs';
import { defaultClaudeAppDir, invalidateClaudeData, openClaudeThread } from './claude-data.mjs';
import { loadSwitchboardClaudeThreads, claudeRemoteDeepLink, claudeRemoteStatus,
  invalidateClaudeRemoteData, isClaudeRemoteCacheEvent } from './claude-remote-data.mjs';
import { normalizeDashboardThreads } from './insights.mjs';
import { createAsbServer } from './asb-server.mjs';
import { openThreadInCodex } from './session-opener.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const QUESTION_AT = Symbol('ASB question timestamp');
const READ_FIELDS = ['questionSeen', 'questionAck', 'nativeAt', 'nativeAck', 'nativeSeen'];
const RETAINED_SOURCES = ['native-unread', 'observed-completion', 'user-question'];

export function switchboardRefreshInterval(dashboard) {
  return dashboard.threads?.some((row) => !row.archived && isSwitchboardRoot(row) && row.state === 'working') ? 2_000 : 5_000;
}

export function switchboardWatchPaths({ homeDir = os.homedir(), appDir = defaultClaudeAppDir(),
  codexDir = path.join(homeDir, '.codex'), projectsDir = path.join(homeDir, '.claude', 'projects') } = {}) {
  const directoryOrFile = (pattern) => (filename, event) => !filename || pattern.test(path.basename(filename))
    || (event === 'rename' && !path.extname(path.basename(filename)));
  return [
    { path: codexDir, source: 'codex', acceptEvent: (filename) => !filename
      || /^(state_\d+\.sqlite(?:-wal)?|session_index\.jsonl|\.codex-global-state\.json|sessions)$/.test(filename) },
    { path: path.join(codexDir, 'sessions'), source: 'codex', recursive: true,
      acceptEvent: directoryOrFile(/^rollout-.*\.jsonl$/) },
    { path: path.join(appDir, 'claude-code-sessions'), source: 'claude', recursive: true,
      acceptEvent: directoryOrFile(/^local_.*\.json$/) },
    { path: path.join(appDir, 'Cache', 'Cache_Data'), source: 'claude', optional: true,
      acceptEvent: (filename, event) => isClaudeRemoteCacheEvent(path.join(appDir, 'Cache', 'Cache_Data'), filename, event) },
    { path: projectsDir, source: 'claude', recursive: true, acceptEvent: directoryOrFile(/\.jsonl$/) },
  ];
}

function retainUnread(record, source) {
  if (record && RETAINED_SOURCES.indexOf(source) > RETAINED_SOURCES.indexOf(record.retained)) record.retained = source;
}

export function isSwitchboardRoot(thread) {
  return !thread.isSubagent && !['subagent', 'guardian_review'].includes(thread.threadSource);
}

export function switchboardStatus(thread, nowMs = Date.now()) {
  if (thread.source === 'claude-remote-cache') return claudeRemoteStatus(thread, nowMs);
  const questionAt = Number(thread.latestBlockingQuestionAtMs || 0);
  if (thread.userQuestionBlocking && questionAt >= Number(thread.latestLifecycleAtMs || 0)
    && nowMs - questionAt <= ACTIVITY_WINDOW_MS) {
    return { state: 'waiting', reason: 'The current tool is waiting for an answer.' };
  }
  if (thread.awaitingPermission || thread.pendingToolCount || thread.awaitingReview) {
    return { state: 'waiting', reason: 'A user action is required.' };
  }
  if (thread.lifecycleRunning === false) return { state: 'idle', reason: 'The last task ended.' };
  if (thread.lifecycleRunning === true) {
    return nowMs - Number(thread.agentActivityAtMs || thread.latestLifecycleAtMs) <= ACTIVITY_WINDOW_MS
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

export function buildSwitchboardDashboard(threads, providers = [], nowMs = Date.now()) {
  const normalizedThreads = normalizeDashboardThreads(threads, nowMs);
  const board = {
    generatedAtMs: nowMs,
    providers,
    threads: normalizedThreads.filter(isSwitchboardRoot).map((thread) => {
      const isCodex = ['codex', 'codex-cli'].includes(thread.provider);
      const validCodex = isCodex && UUID.test(thread.id);
      const validClaude = thread.provider === 'claude-desktop-code'
        && String(thread.externalId).startsWith('local_') && UUID.test(String(thread.externalId).slice(6));
      const appDeepLink = validCodex ? `codex://threads/${thread.id}`
        : validClaude ? `claude://code/continue?session=${encodeURIComponent(thread.externalId)}`
          : thread.provider === 'claude-desktop-code' && thread.source === 'claude-remote-cache'
            ? claudeRemoteDeepLink(thread.externalId) : '';
      const status = switchboardStatus(thread, nowMs);
      const startedAtMs = Number(thread.lifecycleRunning === true ? thread.agentStartedAtMs
        : thread.provider === 'claude-desktop-code' ? thread.latestUserMessageAtMs : 0);
      const row = {
        id: thread.id,
        externalId: thread.externalId,
        provider: isCodex ? 'codex' : thread.provider,
        providerLabel: isCodex ? 'Codex' : 'Claude Desktop Code',
        title: thread.title || 'Untitled session',
        cwd: thread.cwd || '',
        projectName: thread.cwd ? path.basename(thread.cwd) || thread.cwd
          : thread.source === 'claude-remote-cache' ? thread.projectName || 'No project' : 'No project',
        archived: Boolean(thread.archived),
        updatedAtMs: Number(thread.groupUpdatedAtMs || thread.updatedAtMs || 0),
        subagentCount: Number(thread.subagentCount || 0),
        ...status,
        workingSinceMs: status.state === 'working' && Number.isFinite(startedAtMs) ? Math.max(0, startedAtMs) : 0,
        nativeUnread: thread.source === 'claude-remote-cache' && status.state === 'unknown' ? null : thread.nativeUnread ?? null,
        readStatus: thread.source === 'claude-remote-cache' && status.state === 'unknown' ? 'unknown' : thread.readStatus || 'unknown',
        questionPending: Boolean(thread.awaitingUserInput),
        completionAtMs: ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed'].includes(thread.latestLifecycleKind) ? 0
          : Math.max(thread.latestLifecycleKind === 'task_complete' ? Number(thread.latestLifecycleAtMs || 0) : 0,
            Number(thread.latestAgentFinalAtMs || 0)),
        canOpen: Boolean(appDeepLink),
        appDeepLink,
      };
      Object.defineProperty(row, QUESTION_AT, { value: Number(thread.latestUserQuestionAtMs || 0) });
      return row;
    }),
  };
  const expiries = normalizedThreads.filter(isSwitchboardRoot).flatMap((thread) => [thread.latestBlockingQuestionAtMs,
    thread.source === 'claude-remote-cache' ? thread.remoteObservedAtMs : 0,
    thread.lifecycleRunning === true ? thread.agentActivityAtMs || thread.latestLifecycleAtMs : 0,
    thread.provider === 'claude-desktop-code' && thread.lifecycleRunning == null ? thread.transcriptActivityAtMs : 0])
    .map((value) => Number(value || 0) + ACTIVITY_WINDOW_MS + 1).filter((value) => value > nowMs);
  Object.defineProperty(board, 'nextStatusCheckAtMs', { value: expiries.length ? Math.min(...expiries) : Infinity });
  board.refreshIntervalMs = switchboardRefreshInterval(board);
  return board;
}

export async function loadSwitchboardDashboard({
  nowMs = Date.now(),
  loadCodex = loadCodexDashboard,
  loadClaude = loadSwitchboardClaudeThreads,
  codexOptions = {},
  claudeOptions = {},
} = {}) {
  const results = await Promise.allSettled([
    loadCodex({
      ...codexOptions, nowMs,
      codexResetCreditsEnabled: false,
      codexNativeReadEnabled: true,
      workMetricCachePath: false,
      maxGovernanceRollouts: 0,
      maxOrphanRollouts: 0,
      maxRollouts: 5000,
      rolloutThreadFilter: isSwitchboardRoot,
      initialRolloutBytes: 64 * 1024,
      maxRolloutBytes: 256 * 1024,
      asbMode: true,
    }),
    loadClaude({ fileIndexCacheTtlMs: 1_000, ...claudeOptions, nowMs, maxCount: 5000, usageCache: null, strictMetadataRead: true, asbMode: true }),
  ]);
  const labels = ['Codex', 'Claude Desktop Code'];
  const ids = ['codex', 'claude-desktop-code'];
  const providers = results.map((result, index) => {
    const provider = result.status === 'fulfilled' ? result.value.provider : null;
    const status = result.status !== 'fulfilled' || provider?.status === 'error' ? 'error'
      : provider?.status === 'warning' ? 'warning' : provider?.installed === false ? 'missing' : 'ready';
    return {
      id: ids[index], label: labels[index], status,
        message: status === 'error' ? `Cannot read ${labels[index]} sessions. Check the local session store.`
          : status === 'warning' ? provider?.message || `Some ${labels[index]} session files cannot be read.` : '',
    };
  });
  return buildSwitchboardDashboard(results.flatMap((result) => result.status === 'fulfilled' ? result.value.threads || [] : []), providers, nowMs);
}

export async function openSwitchboardThread(thread, options = {}) {
  const valid = (thread.provider === 'codex' && UUID.test(thread.id)
    && thread.appDeepLink === `codex://threads/${thread.id}`)
    || (thread.provider === 'claude-desktop-code' && UUID.test(String(thread.externalId).slice(6))
      && thread.externalId.startsWith('local_')
      && thread.appDeepLink === `claude://code/continue?session=${encodeURIComponent(thread.externalId)}`)
    || (thread.provider === 'claude-desktop-code' && Boolean(claudeRemoteDeepLink(thread.externalId))
      && thread.appDeepLink === claudeRemoteDeepLink(thread.externalId));
  if (!thread.canOpen || !valid) throw new Error('This session has no direct desktop link.');
  return thread.provider === 'codex' ? openThreadInCodex(thread, options) : openClaudeThread(thread, options);
}

export class PendingTracker {
  constructor(statePath = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'asb', 'pending.json')) {
    this.statePath = statePath;
    this.records = Object.create(null);
    this.pinnedOrder = [];
    this.persistentUnread = false;
    this.loaded = false;
    this.saved = '';
    this.write = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.statePath) return;
    try {
      const value = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (value?.version === 1 && value.records && typeof value.records === 'object') {
        this.persistentUnread = value.persistentUnread === true;
        for (const [id, record] of Object.entries(value.records)) {
          if (['seen', 'working', 'pending', 'ack'].every((key) => Number.isFinite(record?.[key]) && record[key] >= 0)) {
            this.records[id] = { ...Object.fromEntries(['seen', 'working', 'pending', 'ack'].map((key) => [key, record[key]])),
              manual: record.manual === 1 ? 1 : 0, retained: RETAINED_SOURCES.includes(record.retained) ? record.retained : '' };
            for (const key of READ_FIELDS) this.records[id][key] = Number.isFinite(record[key]) && record[key] >= 0 ? record[key] : 0;
          }
        }
        if (Array.isArray(value.pinnedOrder)) {
          this.pinnedOrder = [...new Set(value.pinnedOrder.filter((id) => typeof id === 'string' && this.records[id]))];
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = 'ASB could not read its Pending state. New completions will still be tracked.';
    }
    this.saved = JSON.stringify({ records: this.records, pinnedOrder: this.pinnedOrder, persistentUnread: this.persistentUnread });
  }

  async save() {
    const content = JSON.stringify({ records: this.records, pinnedOrder: this.pinnedOrder, persistentUnread: this.persistentUnread });
    if (!this.statePath || content === this.saved) return;
    this.saved = content;
    this.write = this.write.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, ...JSON.parse(content) }), { mode: 0o600 });
      await fs.rename(temporary, this.statePath);
    });
    try { await this.write; } catch { this.saved = ''; this.warning = 'ASB cannot save Pending state. Check its local state folder.'; }
  }

  async observe(dashboard) {
    await this.load();
    for (const row of dashboard.threads) {
      const completion = Number(row.completionAtMs || 0);
      let record = this.records[row.id];
      if (!record) record = this.records[row.id] = { seen: completion, working: 0, pending: 0, ack: 0, manual: 0, retained: '',
        questionSeen: 0, questionAck: 0, nativeAt: 0, nativeAck: 0, nativeSeen: 0 };
      if (row.questionPending) record.questionSeen = Math.max(record.questionSeen, row[QUESTION_AT] || 1);
      if (row.nativeUnread === true && (!record.nativeSeen || completion > record.seen)) {
        record.nativeAt = Math.max(record.nativeAt + 1, Number(dashboard.generatedAtMs || Date.now()), completion);
      }
      if (row.nativeUnread !== null && row.nativeUnread !== undefined) record.nativeSeen = row.nativeUnread ? 1 : 0;
      if (row.archived) record.working = 0;
      else if (row.state === 'working') record.working = 1;
      else if (row.state === 'idle') {
        if (record.working && completion > record.seen) record.pending = completion;
        record.working = 0;
        if (row.nativeUnread === false && !this.persistentUnread) record.ack = Math.max(record.ack, record.pending);
      } else record.working = 0;
      record.seen = Math.max(record.seen, completion);
      this.apply(row);
    }
    await this.save();
    dashboard.pinnedOrder = [...this.pinnedOrder];
    dashboard.persistentUnread = this.persistentUnread;
    if (this.warning) dashboard.providers.push({ id: 'asb-state', label: 'ASB', status: 'warning', message: this.warning });
    return dashboard;
  }

  apply(row) {
    const record = this.records[row.id];
    row.pinIndex = this.pinnedOrder.indexOf(row.id);
    row.pinned = row.pinIndex >= 0;
    row.manualUnread = record?.manual === 1;
    row.questionAttention = Boolean(row.questionPending && record?.questionSeen > record?.questionAck);
    row.nativeAttention = Boolean(row.nativeUnread === true && record?.nativeAt > record?.nativeAck);
    row.completionAttention = Boolean(!row.archived && row.state === 'idle' && row.nativeUnread === null && record?.pending > record?.ack);
    if (this.persistentUnread && record) {
      retainUnread(record, row.questionAttention ? 'user-question'
        : !row.archived && row.state === 'idle' && record.pending > record.ack ? 'observed-completion'
          : row.nativeAttention ? 'native-unread' : '');
    }
    row.retainedUnread = Boolean(record?.retained);
    row.retainedUnreadSource = record?.retained || '';
    row.pending = row.manualUnread || row.questionAttention || (row.retainedUnread && (row.retainedUnreadSource !== 'native-unread' || row.state === 'idle'))
      || (!row.archived && ((row.state === 'waiting' && !row.questionPending) || (row.state === 'idle' && (
      row.nativeAttention || row.completionAttention))));
    row.unread = row.manualUnread || row.nativeAttention || row.completionAttention || row.retainedUnread;
    row.pendingSource = row.questionAttention ? 'user-question' : row.manualUnread ? 'manual-unread' : row.retainedUnread ? row.retainedUnreadSource
      : row.pending && row.state === 'waiting' ? 'user-action' : row.unread
      ? row.nativeAttention ? 'native-unread' : 'observed-completion' : '';
  }

  async setPersistentUnread(enabled, dashboard) {
    await this.load();
    this.persistentUnread = enabled;
    for (const row of dashboard.threads) {
      const record = this.records[row.id];
      if (enabled) retainUnread(record, row.questionAttention ? 'user-question'
        : row.completionAttention ? 'observed-completion' : row.nativeAttention ? 'native-unread' : '');
      this.apply(row);
    }
    dashboard.persistentUnread = enabled;
    await this.save();
  }

  async markUnread(id) {
    await this.load();
    if (this.records[id]) this.records[id].manual = 1;
    await this.save();
  }

  async setPinned(id, pinned) {
    await this.load();
    if (!this.records[id]) throw Object.assign(new Error('This session is not known to ASB.'), { statusCode: 400 });
    if (pinned && !this.pinnedOrder.includes(id)) this.pinnedOrder.push(id);
    if (!pinned) this.pinnedOrder = this.pinnedOrder.filter((value) => value !== id);
    await this.save();
    return [...this.pinnedOrder];
  }

  async movePin(id, body) {
    await this.load();
    const index = this.pinnedOrder.indexOf(id);
    if (index < 0) throw Object.assign(new Error('Only ASB pins can be reordered.'), { statusCode: 400 });
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
    await this.save();
    return [...this.pinnedOrder];
  }

  async acknowledge(id) {
    await this.load();
    const record = this.records[id];
    if (record) {
      record.ack = Math.max(record.ack, record.pending, record.seen);
      record.manual = 0;
      record.retained = '';
      record.questionAck = record.questionSeen;
      record.nativeAck = record.nativeAt;
    }
    await this.save();
  }
}

export function createSwitchboardServer(options = {}) {
  const tracker = options.pendingTracker || new PendingTracker(options.pendingStatePath);
  const load = options.loadDashboard || loadSwitchboardDashboard;
  const open = options.openThread || openSwitchboardThread;
  return createAsbServer({
    dashboardAdaptiveRefresh: true,
    dashboardEventMinIntervalMs: 0,
    dashboardWatchDebounceMs: 250,
    dashboardWatchPaths: switchboardWatchPaths(),
    dashboardSourceChanged: (source, hint) => {
      if (source === 'codex') invalidateCodexData(hint);
      else { invalidateClaudeData(hint); invalidateClaudeRemoteData(hint); }
    },
    ...options,
    loadDashboard: async () => {
      const dashboard = await tracker.observe(await load());
      dashboard.refreshIntervalMs = switchboardRefreshInterval(dashboard);
      return dashboard;
    },
    markUnreadThread: async (thread) => {
      await tracker.markUnread(thread.id);
      tracker.apply(thread);
    },
    markReadThread: async (thread) => {
      await tracker.acknowledge(thread.id);
      tracker.apply(thread);
    },
    setUnreadSettings: (enabled, dashboard) => tracker.setPersistentUnread(enabled, dashboard),
    pinThread: async (thread, action, body) => {
      const order = action === 'move-pin' ? await tracker.movePin(thread.id, body)
        : await tracker.setPinned(thread.id, action === 'pin');
      tracker.apply(thread);
      return order;
    },
    openThread: async (thread) => {
      const result = await open(thread);
      if (result.opened && !tracker.persistentUnread) {
        await tracker.acknowledge(thread.id);
        tracker.apply(thread);
      }
      return result;
    },
    notificationCenter: null,
    monitorNotifications: false,
  });
}

export function switchboardPort(value = process.env.PORT || '4629') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return port;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = switchboardPort();
  const server = createSwitchboardServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `ASB cannot start. Port ${port} is in use.` : `ASB cannot start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`ASB: http://127.0.0.1:${port}`);
  });
}
