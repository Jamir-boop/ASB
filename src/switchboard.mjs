import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCodexDashboard, invalidateCodexData, discoverCodexStateDatabase } from './codex-data.mjs';
import { defaultClaudeAppDir, invalidateClaudeData, openClaudeThread } from './claude-data.mjs';
import { loadSwitchboardClaudeThreads, claudeRemoteDeepLink, claudeRemoteStatus,
  invalidateClaudeRemoteData, isClaudeRemoteCacheEvent } from './claude-remote-data.mjs';
import { normalizeDashboardThreads } from './insights.mjs';
import { createAsbServer } from './asb-server.mjs';
import { openThreadInCodex } from './session-opener.mjs';
import { AppSourceRegistry, numberAppSources, validateSourceLauncher } from './app-sources.mjs';
import { spawn } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const QUESTION_AT = Symbol('ASB question timestamp');
const SOURCE_DIR = Symbol('ASB session store');
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
  if (thread.groupChildWaiting) return { state: 'waiting', reason: 'A linked child is waiting for an answer.' };
  if (thread.lifecycleRunning === false) return { state: 'idle', reason: 'The last task ended.' };
  if (thread.lifecycleRunning === true) {
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
  return { ...thread,
    lifecycleRunning: active.length ? true : unknown ? undefined : thread.lifecycleRunning,
    childWorkUnknown: unknown,
    groupChildWaiting: blockedChildren.length > 0 && !recent.some((member) => !blocked(member)),
    awaitingUserInput: work.some((member) => member.awaitingUserInput),
    latestUserQuestionAtMs: Math.max(0, ...work.filter((member) => member.awaitingUserInput).map((member) => Number(member.latestUserQuestionAtMs || 0))),
    agentStartedAtMs: starts.length ? Math.min(...starts) : 0,
    agentActivityAtMs: active.length ? Math.max(...active.map((member) => Number(member.agentActivityAtMs || member.latestLifecycleAtMs || 0))) : 0,
    groupStatusActivityAtMs: expirySignals.length ? Math.min(...expirySignals) : 0,
    groupCompletionAtMs: active.length || unknown || ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed'].includes(latestEnd?.latestLifecycleKind) ? 0
      : Math.max(0, ...work.map((member) => Math.max(member.latestLifecycleKind === 'task_complete' ? Number(member.latestLifecycleAtMs || 0) : 0,
        Number(member.latestAgentFinalAtMs || 0)))),
  };
}

export function buildSwitchboardDashboard(threads, providers = [], nowMs = Date.now()) {
  const normalizedThreads = normalizeDashboardThreads(threads, nowMs);
  const byId = new Map(normalizedThreads.map((thread) => [thread.id, thread]));
  const roots = normalizedThreads.filter(isSwitchboardRoot).map((thread) => codexGroupLifecycle(thread, byId, nowMs));
  const board = {
    generatedAtMs: nowMs,
    providers,
    threads: roots.map((thread) => {
      const isCodex = ['codex', 'codex-cli'].includes(thread.provider);
      const externalId = thread.externalId || thread.id;
      const validCodex = isCodex && UUID.test(externalId);
      const validClaude = thread.provider === 'claude-desktop-code'
        && String(thread.externalId).startsWith('local_') && UUID.test(String(thread.externalId).slice(6));
      const appDeepLink = validCodex ? `codex://threads/${externalId}`
        : validClaude ? `claude://code/continue?session=${encodeURIComponent(thread.externalId)}`
          : thread.provider === 'claude-desktop-code' && thread.source === 'claude-remote-cache'
            ? claudeRemoteDeepLink(thread.externalId) : '';
      const status = switchboardStatus(thread, nowMs);
      const startedAtMs = Number(thread.lifecycleRunning === true ? thread.agentStartedAtMs
        : thread.provider === 'claude-desktop-code' ? thread.latestUserMessageAtMs : 0);
      const row = {
        id: thread.id,
        externalId,
        ...(thread.sourceId ? { sourceId: thread.sourceId, sourceLabel: thread.sourceLabel,
          sourceNumber: thread.sourceNumber, sourceCount: thread.sourceCount, sourceColor: thread.sourceColor,
          sourceShowMarker: thread.sourceShowMarker } : {}),
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
        completionAtMs: thread.groupCompletionAtMs ?? (['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed'].includes(thread.latestLifecycleKind) ? 0
          : Math.max(thread.latestLifecycleKind === 'task_complete' ? Number(thread.latestLifecycleAtMs || 0) : 0,
            Number(thread.latestAgentFinalAtMs || 0))),
        canOpen: Boolean(appDeepLink) && thread.sourceCanOpen !== false,
        appDeepLink,
      };
      Object.defineProperty(row, QUESTION_AT, { value: Number(thread.latestUserQuestionAtMs || 0) });
      if (thread.sourceDataDir) Object.defineProperty(row, SOURCE_DIR, { value: thread.sourceDataDir });
      return row;
    }),
  };
  const expiries = roots.flatMap((thread) => [thread.latestBlockingQuestionAtMs, thread.groupStatusActivityAtMs,
    thread.source === 'claude-remote-cache' ? thread.remoteObservedAtMs : 0,
    thread.lifecycleRunning === true ? thread.agentActivityAtMs ?? thread.latestLifecycleAtMs : 0,
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
  sources = null,
} = {}) {
  const inputs = sources ? numberAppSources(sources) : [
    { id: 'codex', provider: 'codex', label: 'Codex', enabled: true },
    { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude Desktop Code', enabled: true },
  ];
  const results = await Promise.allSettled(inputs.map(async (source) => {
    if (!source.enabled) return null;
    let sourceOptions = {};
    if (sources) {
      if (!(await fs.stat(source.dataDir)).isDirectory()) throw new Error('The source path is not a directory.');
      sourceOptions = source.provider === 'codex' ? {
        databasePath: await discoverCodexStateDatabase(source.dataDir),
        sessionsDir: path.join(source.dataDir, 'sessions'),
        sessionIndexPath: path.join(source.dataDir, 'session_index.jsonl'),
        globalStatePath: path.join(source.dataDir, '.codex-global-state.json'),
      } : { appDir: source.dataDir, projectsDir: source.projectsDir || path.join(os.homedir(), '.claude', 'projects') };
      if (source.provider === 'codex' && loadCodex === loadCodexDashboard) await fs.stat(sourceOptions.databasePath);
    }
    return source.provider === 'codex' ? loadCodex({
      ...codexOptions, ...sourceOptions, nowMs,
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
    }) : loadClaude({ fileIndexCacheTtlMs: 1_000, ...claudeOptions, ...sourceOptions,
      nowMs, maxCount: 5000, usageCache: null, strictMetadataRead: true, asbMode: true });
  }));
  const providers = results.map((result, index) => {
    const source = inputs[index];
    const provider = result.status === 'fulfilled' ? result.value?.provider : null;
    const missingLauncher = sources && !source.builtin && !source.launcher;
    const status = !source.enabled ? 'disabled' : missingLauncher ? 'error'
      : sources && result.status === 'rejected' && result.reason?.code === 'ENOENT' ? 'missing'
      : result.status !== 'fulfilled' || provider?.status === 'error' ? 'error'
        : provider?.status === 'warning' ? 'warning' : provider?.installed === false ? 'missing' : 'ready';
    return { id: source.id, label: source.label, status,
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
        externalId: thread.externalId || thread.id, sourceId: source.id, sourceLabel: source.label,
        sourceNumber: source.sourceNumber, sourceCount: source.sourceCount, sourceColor: source.color,
        sourceShowMarker: source.showMarker,
        sourceCanOpen: source.builtin || Boolean(source.launcher), sourceDataDir: source.dataDir };
    });
  });
  return buildSwitchboardDashboard(threads, providers, nowMs);
}

export async function openSwitchboardThread(thread, options = {}) {
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
    const launchOptions = { detached: true, stdio: 'ignore' };
    if (options.runCommand) await options.runCommand(launcher, [thread.appDeepLink], launchOptions);
    else await new Promise((resolve, reject) => {
      const app = spawn(launcher, [thread.appDeepLink], launchOptions);
      app.once('error', reject);
      app.once('spawn', () => { app.unref(); resolve(); });
    });
    return { opened: true, method: `${thread.provider}-source-launcher` };
  }
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
  const registry = options.sourceRegistry || new AppSourceRegistry(options.sourceRegistryOptions);
  const registeredLoad = !options.loadDashboard || Boolean(options.sourceRegistry);
  const sourceWatchPaths = async () => {
    const sources = await registry.read();
    return [
      ...(registry.configPath ? [{ path: path.dirname(registry.configPath), optional: true,
        acceptEvent: (filename) => !filename || filename === path.basename(registry.configPath) }] : []),
      ...sources.filter((source) => source.enabled).flatMap((source) => switchboardWatchPaths(
        source.provider === 'codex' ? { codexDir: source.dataDir }
          : { appDir: source.dataDir, projectsDir: source.projectsDir }).filter((spec) =>
            spec.source === (source.provider === 'codex' ? 'codex' : 'claude'))),
    ];
  };
  return createAsbServer({
    dashboardAdaptiveRefresh: true,
    dashboardEventMinIntervalMs: 0,
    dashboardWatchDebounceMs: 250,
    dashboardWatchPaths: registeredLoad ? sourceWatchPaths : switchboardWatchPaths(),
    dashboardSourceChanged: (source, hint) => {
      if (source === 'codex') invalidateCodexData(hint);
      else { invalidateClaudeData(hint); invalidateClaudeRemoteData(hint); }
    },
    ...options,
    loadDashboard: async () => {
      const dashboard = await tracker.observe(await load(registeredLoad ? { sources: await registry.read() } : undefined));
      if (registeredLoad && registry.warning) dashboard.providers.push({ id: 'asb-sources', label: 'ASB', status: 'warning', message: registry.warning });
      dashboard.refreshIntervalMs = switchboardRefreshInterval(dashboard);
      return dashboard;
    },
    listSources: (dashboard) => registry.report(dashboard),
    updateSource: async (source) => { await registry.update(source); invalidateCodexData(); invalidateClaudeData(); invalidateClaudeRemoteData(); },
    removeSource: async (id) => { await registry.remove(id); invalidateCodexData(); invalidateClaudeData(); invalidateClaudeRemoteData(); },
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
