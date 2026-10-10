import { execFile } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { rememberBounded, sameFileSignature, SourceCache, statSignature } from './data-cache.mjs';
import { enrichThreadRuntime } from './insights.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export function defaultClaudeAppDir(platform = process.platform, homeDir = os.homedir(), env = process.env) {
  if (platform === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Claude');
  return path.join(homeDir, 'Library', 'Application Support', 'Claude');
}
const DEFAULT_CLAUDE_APP_DIR = defaultClaudeAppDir();
const DEFAULT_MAX_COUNT = 80;
const DEFAULT_MAX_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_ASB_SESSION_COUNT = 5000;
const SIGNAL_CONCURRENCY = 6;
const CLAUDE_APPEND_GUARD_BYTES = 64;
const CLAUDE_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const CLAUDE_DESKTOP_CODE_DEFAULT_TITLE = 'General coding session';
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const claudeProjectIndexCacheByDir = new Map();
const claudeProjectIndexReads = new Map();
const claudeSignalReads = new Map();
const claudeJsonlSignalCache = new SourceCache(MAX_ASB_SESSION_COUNT);
const claudeMetadataCache = new SourceCache(MAX_ASB_SESSION_COUNT);
const claudeFileIndexCache = new Map();
let claudeFileIndexGeneration = 0;
let claudeSourceRoots = new Set();
const claudeCacheMetrics = {
  projectIndexHits: 0,
  projectIndexMisses: 0,
  projectIndexWrites: 0,
  jsonlSignalHits: 0,
  jsonlSignalMisses: 0,
  jsonlSignalWrites: 0,
  jsonlSignalEvictions: 0,
  jsonlSignalBytesRead: 0,
  metadataHits: 0,
  metadataMisses: 0,
  metadataBytesRead: 0,
  fileIndexHits: 0,
  fileIndexWalks: 0,
};

const CLAUDE_DESKTOP_CODE_PROVIDER = {
  id: 'claude-desktop-code',
  label: 'Claude Desktop Code',
};

function coerceNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function getClaudeCacheStats() {
  return {
    projectIndex: {
      entries: claudeProjectIndexCacheByDir.size,
      hits: claudeCacheMetrics.projectIndexHits,
      misses: claudeCacheMetrics.projectIndexMisses,
      writes: claudeCacheMetrics.projectIndexWrites,
    },
    jsonlSignals: {
      entries: claudeJsonlSignalCache.size,
      limit: claudeJsonlSignalCache.limit,
      hits: claudeCacheMetrics.jsonlSignalHits,
      misses: claudeCacheMetrics.jsonlSignalMisses,
      writes: claudeCacheMetrics.jsonlSignalWrites,
      evictions: claudeCacheMetrics.jsonlSignalEvictions,
      bytesRead: claudeCacheMetrics.jsonlSignalBytesRead,
    },
    metadata: {
      entries: claudeMetadataCache.size,
      hits: claudeCacheMetrics.metadataHits,
      misses: claudeCacheMetrics.metadataMisses,
      bytesRead: claudeCacheMetrics.metadataBytesRead,
    },
    fileIndex: {
      entries: claudeFileIndexCache.size,
      hits: claudeCacheMetrics.fileIndexHits,
      walks: claudeCacheMetrics.fileIndexWalks,
    },
  };
}

function timestampToMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (number <= 0) return 0;
    return number > 1_000_000_000_000 ? number : number * 1000;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function compactInlineText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function truncateText(value = '', maxLength = 140) {
  const text = compactInlineText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

// Each non-empty user text is a prompt, except the local command records that Claude Code writes itself.
function isUserPromptText(text = '') {
  return Boolean(text.trim()) && !/^\s*<(?:local-command-caveat|command-name|local-command-stdout)>/.test(text);
}

function contentText(content, { includeToolResults = false } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'tool_result' && !includeToolResults) return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string' && (includeToolResults || item.type !== 'tool_result')) {
        return item.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isPermissionToolUse(item) {
  const name = String(item?.name || item?.tool || '');
  return /(^AskUserQuestion$|^ExitPlanMode$|permission|approval|request.*directory|request.*folder|allow_cowork_file_delete|ask.*user)/i.test(name);
}

function toolUseTitle(item) {
  const name = String(item?.name || item?.tool || '工具调用');
  if (name === 'AskUserQuestion') return '向用户提问';
  if (name.includes('request_cowork_directory')) return '请求选择文件夹';
  if (name.includes('allow_cowork_file_delete')) return '请求删除文件';
  return name.replace(/^mcp__/, '').replaceAll('__', ' / ');
}

function initialSignals() {
  return {
    sessionId: '',
    cwd: '',
    entrypoint: '',
    version: '',
    model: '',
    gitBranch: '',
    firstUserMessage: '',
    latestUserMessage: '',
    latestMeaningfulUserMessage: '',
    latestUserMessageAtMs: null,
    latestAgentFinalAtMs: null,
    latestMessageKind: '',
    lastAgentMessage: '',
    oldestEventAtMs: null,
    latestEventAtMs: null,
    pendingToolsById: new Map(),
    pendingToolAtMs: 0,
    lifecycle: initialClaudeLifecycle(),
  };
}

function initialClaudeLifecycle() {
  return { running: null, startedAtMs: 0, activityAtMs: 0, eventAtMs: 0, kind: '', finalAtMs: 0,
    endedAtMs: 0, endKind: '',
    agents: new Map(), agentTools: new Map() };
}

function applyClaudeLifecycle(lifecycle, event, timestampMs) {
  if (!timestampMs) return;
  const content = event.message?.content;
  const text = contentText(content).trim();
  const result = event.toolUseResult;
  const launched = event.type === 'user' && result?.isAsync === true && result.status === 'async_launched'
    && /^[A-Za-z0-9_-]+$/.test(String(result.agentId || ''));
  // A message to an ended subagent starts it again in the background, with the same ID and transcript.
  const resumed = event.type === 'user' && result?.success === true && typeof result.resumedAgentId === 'string'
    && /^[A-Za-z0-9_-]+$/.test(result.resumedAgentId);
  // A background workflow has no agent ID. Its notification has the task ID, and its logs are in the folder of the run ID.
  const workflow = !launched && !resumed && event.type === 'user' && result?.status === 'async_launched'
    && [result.taskId, result.runId].every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id));
  if (launched || resumed || workflow) {
    const toolId = Array.isArray(content) ? content.find((item) => item?.type === 'tool_result')?.tool_use_id : '';
    const tool = lifecycle.agentTools.get(toolId);
    if (workflow ? tool?.workflow : tool || resumed) rememberBounded(lifecycle.agents, workflow ? result.taskId : resumed ? result.resumedAgentId : result.agentId, {
      launchedAtMs: timestampMs, startedAtMs: tool?.startedAtMs || timestampMs,
      requestStartedAtMs: tool ? tool.requestStartedAtMs : lifecycle.startedAtMs, endedAtMs: 0, kind: '',
      ...(workflow ? { runId: result.runId } : {}),
    }, MAX_ASB_SESSION_COUNT);
  }
  // A busy chat gets the notification as a queued attachment. Its timestamp is the end of the task, not the delivery.
  const notice = event.type === 'user' ? text : event.type === 'attachment' && event.attachment?.type === 'queued_command'
    && typeof event.attachment.prompt === 'string' ? event.attachment.prompt.trim() : '';
  if (notice.startsWith('<task-notification>')) {
    const agentId = notice.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const status = notice.match(/<status>([^<]+)<\/status>/)?.[1];
    const agent = lifecycle.agents.get(agentId);
    if (agent && timestampMs >= agent.launchedAtMs && ['completed', 'failed', 'cancelled', 'aborted', 'stopped', 'killed'].includes(status)) {
      agent.endedAtMs = timestampMs;
      agent.kind = status === 'completed' ? 'task_complete' : status === 'failed' ? 'failed' : 'cancelled';
    }
    return;
  }
  if (timestampMs < lifecycle.eventAtMs) return;
  const kind = event.type === 'system' ? event.subtype : event.type;
  const stopReason = String(firstPresent(event.message?.stop_reason, event.message?.stopReason,
    event.stop_reason, event.stopReason) || '').toLowerCase();
  const interrupted = event.type === 'user' && /^\[Request interrupted by user(?: for tool use)?\]$/.test(text);
  const cancelled = interrupted || ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'aborted', 'interrupted'].includes(kind)
    || (event.type === 'result' && ['interrupted', 'cancelled', 'aborted'].includes(event.terminal_reason));
  const failed = event.type === 'result' && event.is_error;
  // The app runs a tool call also after a stop reason such as refusal, so a record with a tool call is not the end of a turn.
  const completed = event.type === 'result' || kind === 'stop_hook_summary' || kind === 'task_complete'
    || (event.type === 'assistant' && ['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(stopReason)
      && !(Array.isArray(content) && content.some((item) => item?.type === 'tool_use')));
  if (cancelled || failed || completed) {
    lifecycle.running = false;
    lifecycle.eventAtMs = timestampMs;
    lifecycle.kind = cancelled ? 'cancelled' : failed ? 'failed' : 'task_complete';
    lifecycle.endedAtMs = timestampMs;
    lifecycle.endKind = lifecycle.kind;
    lifecycle.finalAtMs = cancelled || failed ? 0 : timestampMs;
    return;
  }
  // A message that starts an ended subagent again is a meta record in the transcript of that subagent.
  // The summary of a context compaction is not a prompt: the task and its start time continue.
  const humanStart = event.type === 'user' && !event.isCompactSummary
    && (!event.isMeta || (event.isSidechain === true && lifecycle.running !== true)) && isUserPromptText(text);
  const activeAssistant = event.type === 'assistant' && (stopReason === 'tool_use'
    || (Array.isArray(content) && content.some((item) => ['thinking', 'tool_use'].includes(item?.type))));
  if (humanStart || kind === 'task_started' || activeAssistant) {
    if (humanStart || lifecycle.running !== true) lifecycle.startedAtMs = timestampMs;
    lifecycle.running = true;
    lifecycle.kind = 'task_started';
    lifecycle.eventAtMs = timestampMs;
  }
  if (lifecycle.running === true && ['user', 'assistant'].includes(event.type)) lifecycle.activityAtMs = timestampMs;
  if (kind === 'task_started') lifecycle.activityAtMs = timestampMs;
  if (event.type === 'assistant' && Array.isArray(content)) {
    for (const tool of content) {
      if (tool?.type === 'tool_use' && ['Agent', 'Task', 'SendMessage', 'Workflow'].includes(tool.name) && tool.id) {
        rememberBounded(lifecycle.agentTools, tool.id, { startedAtMs: timestampMs,
          requestStartedAtMs: lifecycle.startedAtMs, workflow: tool.name === 'Workflow' }, MAX_ASB_SESSION_COUNT);
      }
    }
  }
}

function rememberTimestamp(signals, timestampMs) {
  if (!timestampMs) return;
  signals.oldestEventAtMs = signals.oldestEventAtMs
    ? Math.min(signals.oldestEventAtMs, timestampMs)
    : timestampMs;
  signals.latestEventAtMs = Math.max(signals.latestEventAtMs || 0, timestampMs);
}

function handleUserEvent(signals, event, timestampMs) {
  if (event.isMeta) return;

  const content = event.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const toolUseId = item?.tool_use_id || item?.toolUseId;
      if (item?.type === 'tool_result' && toolUseId) {
        signals.pendingToolsById.delete(String(toolUseId));
      }
    }
  }

  const text = contentText(content);
  if (isUserPromptText(text)) {
    const compactText = truncateText(text, 500);
    signals.firstUserMessage ||= compactText;
    signals.latestUserMessage = compactText;
    signals.latestMeaningfulUserMessage = compactText;
    signals.latestUserMessageAtMs = timestampMs || signals.latestUserMessageAtMs;
    signals.latestMessageKind = 'user';
  }
}

function handleAssistantEvent(signals, event, timestampMs) {
  const message = event.message || {};
  const text = contentText(message.content);
  const hasText = Boolean(compactInlineText(text));
  const stopReason = String(firstPresent(
    message.stop_reason,
    message.stopReason,
    event.stop_reason,
    event.stopReason,
  ) || '').toLowerCase();

  if (message.model) signals.model = String(message.model);

  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item?.type !== 'tool_use' || !item.id || !isPermissionToolUse(item)) continue;
      signals.pendingToolsById.set(String(item.id), {
        id: String(item.id),
        tool: String(item.name || 'tool'),
        title: toolUseTitle(item),
        status: 'pending',
        kind: 'permission',
        signalAtMs: timestampMs,
      });
      // Retain the newest 5000 permission signals, so an append-only stream cannot grow this map without limit.
      if (signals.pendingToolsById.size > MAX_ASB_SESSION_COUNT) {
        const oldest = [...signals.pendingToolsById.values()].reduce((a, b) => a.signalAtMs <= b.signalAtMs ? a : b);
        signals.pendingToolsById.delete(oldest.id);
      }
      signals.pendingToolAtMs = Math.max(signals.pendingToolAtMs, timestampMs);
    }
  }

  if (hasText) {
    signals.lastAgentMessage = truncateText(text, 500);
    signals.latestMessageKind = 'agent';
  }

  if (['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(stopReason)) {
    rememberAgentCompletion(signals, timestampMs);
  }
}

function rememberAgentCompletion(signals, timestampMs) {
  signals.latestAgentFinalAtMs = timestampMs || signals.latestAgentFinalAtMs;
  signals.latestMessageKind = 'agent';
}

function handleResultEvent(signals, event, timestampMs) {
  signals.pendingToolsById.clear();
  signals.pendingToolAtMs = 0;

  if (event.result) {
    signals.lastAgentMessage = truncateText(event.result, 500);
  }

  if (!event.is_error && event.terminal_reason !== 'interrupted') {
    rememberAgentCompletion(signals, timestampMs);
  }
}

function applyClaudeSignalLine(signals, line, lifecycleOnly = false) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event || typeof event !== 'object') return;
  if (lifecycleOnly) {
    applyClaudeLifecycle(signals.lifecycle, event, timestampToMs(event.timestamp || event._audit_timestamp));
    return;
  }
  const timestampMs = timestampToMs(event.timestamp || event._audit_timestamp);
  rememberTimestamp(signals, timestampMs);
  applyClaudeLifecycle(signals.lifecycle, event, timestampMs);
  if (signals.lifecycle.eventAtMs === timestampMs && ['cancelled', 'failed'].includes(signals.lifecycle.kind)) {
    signals.pendingToolsById.clear();
    signals.pendingToolAtMs = 0;
  }

  signals.sessionId ||= String(event.sessionId || event.session_id || '');
  signals.cwd ||= String(event.cwd || '');
  signals.entrypoint ||= String(event.entrypoint || event.client_platform || '');
  signals.version ||= String(event.version || event.claude_code_version || '');
  signals.gitBranch ||= String(event.gitBranch || event.git_branch || '');

  if (event.type === 'user') {
    handleUserEvent(signals, event, timestampMs);
    return;
  }

  if (event.type === 'assistant') {
    handleAssistantEvent(signals, event, timestampMs);
    return;
  }

  if (event.type === 'result') {
    handleResultEvent(signals, event, timestampMs);
    return;
  }

  if (event.type === 'system' && event.subtype === 'stop_hook_summary') {
    rememberAgentCompletion(signals, timestampMs);
    return;
  }

  if (event.type === 'system' && event.subtype === 'init') {
    signals.cwd ||= String(event.cwd || '');
    signals.model ||= String(event.model || '');
    signals.version ||= String(event.claude_code_version || '');
  }
}

function finishClaudeSignals(signals) {
  const pendingTools = [...signals.pendingToolsById.values()]
    .sort((a, b) => coerceNumber(b.signalAtMs) - coerceNumber(a.signalAtMs));
  const pendingToolAtMs = pendingTools
    .reduce((latest, tool) => Math.max(latest, coerceNumber(tool.signalAtMs)), 0);
  return {
    ...signals,
    pendingToolsById: undefined,
    pendingToolAtMs,
    pendingTools,
    pendingToolCount: pendingTools.length,
  };
}

export function parseClaudeJsonlSignals(jsonlText = '') {
  const signals = initialSignals();
  for (const line of String(jsonlText).split('\n')) applyClaudeSignalLine(signals, line);
  return finishClaudeSignals(signals);
}

async function readTailText(filePath, maxBytes = DEFAULT_MAX_JSONL_BYTES, fileStat = null) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = fileStat || await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return { text: '', offset: 0, guard: Buffer.alloc(0) };

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    claudeCacheMetrics.jsonlSignalBytesRead += bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    let text = bytes.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return { text, offset: start + bytes.lastIndexOf(10) + 1,
      guard: Buffer.from(bytes.subarray(-CLAUDE_APPEND_GUARD_BYTES)) };
  } finally {
    await handle.close();
  }
}

async function readJsonFile(filePath, fileStat = null, cacheScope = '') {
  const signature = statSignature(fileStat || await fs.stat(filePath));
  const cached = claudeMetadataCache.get(filePath, cacheScope);
  if (cached && sameFileSignature(cached.signature, signature)) {
    claudeCacheMetrics.metadataHits += 1;
    return cached.value;
  }
  claudeCacheMetrics.metadataMisses += 1;
  const text = await fs.readFile(filePath, 'utf8');
  claudeCacheMetrics.metadataBytesRead += Buffer.byteLength(text);
  const value = JSON.parse(text);
  claudeMetadataCache.remember(filePath, { signature, value }, cacheScope);
  return value;
}

async function walkFiles(root, predicate, output = [], onReadError = null, directories = null) {
  let entries = [];
  try {
    if (directories) directories.set(root, statSignature(await fs.stat(root)));
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    onReadError?.(error);
    return output;
  }

  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(filePath, predicate, output, onReadError, directories);
      return;
    }

    if (entry.isFile() && predicate(filePath, entry.name)) {
      try {
        const stat = await fs.stat(filePath);
        output.push({ filePath, stat });
      } catch (error) {
        onReadError?.(error);
        // Ignore files that disappear during a scan.
      }
    }
  }));

  return output;
}

async function indexedFiles(root, predicate, { onReadError = null, refreshStats = true } = {}) {
  const generation = claudeFileIndexGeneration;
  const cached = claudeFileIndexCache.get(root);
  if (cached) {
    const unchanged = await Promise.all([...cached.directories].map(async ([directory, signature]) => {
      try { return sameFileSignature(signature, statSignature(await fs.stat(directory))); }
      catch { return false; }
    }));
    if (unchanged.every(Boolean)) {
      claudeCacheMetrics.fileIndexHits += 1;
      if (!refreshStats) return cached.files;
      const files = await Promise.all(cached.files.map(async (entry) => {
        try { return { filePath: entry.filePath, stat: await fs.stat(entry.filePath) }; }
        catch (error) { onReadError?.(error); return null; }
      }));
      return files.filter(Boolean);
    }
  }
  claudeCacheMetrics.fileIndexWalks += 1;
  const directories = new Map();
  let errors = 0;
  const files = await walkFiles(root, predicate, [], (error) => { errors += 1; onReadError?.(error); }, directories);
  if (generation === claudeFileIndexGeneration) {
    if (!errors) rememberBounded(claudeFileIndexCache, root, { files, directories }, 32);
    else claudeFileIndexCache.delete(root);
  }
  return files;
}

export function invalidateClaudeData({ filePath = '', index = false } = {}) {
  if (!filePath || index) claudeFileIndexGeneration += 1;
  for (const [key, cached] of claudeJsonlSignalCache) {
    if (filePath && (key.startsWith(`${filePath}\0`) || key.startsWith(`${filePath}${path.sep}`))) cached.invalidated = true;
  }
  if (!filePath) {
    claudeMetadataCache.clear();
    claudeFileIndexCache.clear();
    claudeProjectIndexCacheByDir.clear();
    claudeProjectIndexReads.clear();
    return;
  }
  claudeMetadataCache.delete(filePath);
  if (index) for (const root of claudeProjectIndexReads.keys()) {
    if (filePath === root || filePath.startsWith(`${root}${path.sep}`)) claudeProjectIndexReads.delete(root);
  }
  for (const [root, cached] of claudeFileIndexCache) {
    if ((filePath === root || filePath.startsWith(`${root}${path.sep}`))
      && (index || !cached.files.some((entry) => entry.filePath === filePath))) {
      claudeFileIndexGeneration += 1;
      claudeFileIndexCache.delete(root);
      claudeProjectIndexReads.delete(root);
    }
  }
}

export function retainClaudeDataSources(sources) {
  for (const cache of [claudeJsonlSignalCache, claudeMetadataCache]) cache.retainScopes(sources.map((source) => source.cacheScope));
  const roots = new Set(sources.flatMap((source) => [path.join(source.appDir, 'claude-code-sessions'), source.projectsDir]));
  for (const root of claudeSourceRoots) {
    if (roots.has(root)) continue;
    claudeFileIndexGeneration += 1;
    claudeFileIndexCache.delete(root);
    claudeProjectIndexCacheByDir.delete(root);
    claudeProjectIndexReads.delete(root);
  }
  claudeSourceRoots = roots;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Number.parseInt(concurrency, 10) || 1)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function recentFiles(root, predicate, maxCount = DEFAULT_MAX_COUNT, onReadError = null) {
  return (await indexedFiles(root, predicate, { onReadError }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, maxCount);
}

export function claudeDesktopCodeDeepLink(cliSessionId, localSessionId = '') {
  if (/^local_[0-9a-f-]{36}$/i.test(localSessionId) && UUID_PATTERN.test(localSessionId.slice(6))) {
    return `claude://code/continue?session=${encodeURIComponent(localSessionId)}`;
  }
  const sessionId = String(cliSessionId || '');
  if (!UUID_PATTERN.test(sessionId)) return '';
  return `claude://resume?session=${encodeURIComponent(sessionId)}`;
}

function openCommandForUrl(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function deriveClaudeDesktopCodeTitle(session = {}) {
  const panelTitle = firstPresent(
    session.title,
    session.name,
    session.displayName,
    session.conversationTitle,
    session.metadata?.title,
    session.metadata?.name,
  );
  const title = compactInlineText(panelTitle);
  return truncateText(title || CLAUDE_DESKTOP_CODE_DEFAULT_TITLE);
}

function projectNameFromCwd(cwd, fallback) {
  if (!cwd) return fallback;
  return path.basename(cwd) || fallback;
}

function baseClaudeThread({
  id,
  externalId,
  provider,
  providerLabel,
  source,
  title,
  cwd,
  projectName,
  model,
  archived,
  createdAtMs,
  updatedAtMs,
  signals,
  canOpen = true,
  openLabel = '打开',
  extra = {},
}, nowMs) {
  const pendingTools = Array.isArray(signals?.pendingTools) ? signals.pendingTools : [];
  const questions = pendingTools.filter((tool) => tool.tool === 'AskUserQuestion');
  const thread = {
    id,
    externalId,
    provider,
    providerLabel,
    title,
    cwd,
    projectName,
    source,
    model: model || signals?.model || '',
    reasoningEffort: '',
    hasUnreadTurn: false,
    awaitingPermission: pendingTools.length > 0,
    awaitingReview: false,
    pendingTools,
    pendingToolCount: pendingTools.length,
    pendingToolAtMs: coerceNumber(signals?.pendingToolAtMs),
    awaitingUserInput: questions.length > 0,
    latestUserQuestionAtMs: Math.max(0, ...questions.map((tool) => coerceNumber(tool.signalAtMs))),
    questionNonBlocking: Boolean(signals?.questionNonBlocking),
    archived: Boolean(archived),
    createdAtMs: createdAtMs || updatedAtMs,
    updatedAtMs,
    latestAgentFinalAtMs: signals?.latestAgentFinalAtMs || null,
    latestUserMessageAtMs: signals?.latestUserMessageAtMs || null,
    latestMessageKind: signals?.latestMessageKind || '',
    lifecycleRunning: signals?.lifecycleRunning,
    agentRunning: signals?.lifecycleRunning === true,
    agentStartedAtMs: signals?.agentStartedAtMs || null,
    agentActivityAtMs: signals?.agentActivityAtMs || null,
    latestLifecycleAtMs: signals?.latestLifecycleAtMs || null,
    latestLifecycleKind: signals?.latestLifecycleKind || '',
    latestTaskStartedAtMs: signals?.latestTaskStartedAtMs || 0,
    latestTaskEndedAtMs: signals?.latestTaskEndedAtMs || 0,
    latestTaskEndKind: signals?.latestTaskEndKind || '',
    groupTaskEndedAtMs: signals?.groupTaskEndedAtMs || 0,
    groupTaskEndKind: signals?.groupTaskEndKind || '',
    childWorkUnknown: Boolean(signals?.childWorkUnknown),
    firstUserMessage: signals?.firstUserMessage || '',
    latestUserMessage: signals?.latestUserMessage || '',
    latestMeaningfulUserMessage: signals?.latestMeaningfulUserMessage || '',
    lastAgentMessage: signals?.lastAgentMessage || '',
    rolloutPath: '',
    gitBranch: signals?.gitBranch || '',
    gitSha: '',
    gitOriginUrl: '',
    appDeepLink: '',
    canOpen,
    openLabel,
    ...extra,
  };

  return enrichThreadRuntime(thread, nowMs);
}

function dedupeClaudeDesktopCodeThreads(threads) {
  const bySession = new Map();

  for (const thread of threads) {
    const key = thread.cliSessionId || thread.externalId || thread.id;
    const existing = bySession.get(key);
    if (!existing || coerceNumber(thread.updatedAtMs) > coerceNumber(existing.updatedAtMs)) {
      bySession.set(key, thread);
    }
  }

  return [...bySession.values()]
    .sort((a, b) => coerceNumber(b.updatedAtMs) - coerceNumber(a.updatedAtMs));
}

export function normalizeClaudeDesktopCodeSession(session, {
  signals = {},
  stat = {},
  subagentStats = {},
} = {}, nowMs = Date.now()) {
  const externalId = String(session.sessionId || session.id || '');
  const cliSessionId = String(session.cliSessionId || '');
  const cwd = String(session.originCwd || session.cwd || signals.cwd || '');
  const updatedAtMs = Math.max(
    timestampToMs(session.lastActivityAt),
    coerceNumber(signals.latestEventAtMs),
    coerceNumber(stat.mtimeMs),
  ) || nowMs;
  const createdAtMs = timestampToMs(session.createdAt)
    || coerceNumber(signals.oldestEventAtMs)
    || updatedAtMs;
  const appDeepLink = claudeDesktopCodeDeepLink(cliSessionId, externalId);

  return baseClaudeThread({
    id: `${CLAUDE_DESKTOP_CODE_PROVIDER.id}:${externalId}`,
    externalId,
    provider: CLAUDE_DESKTOP_CODE_PROVIDER.id,
    providerLabel: CLAUDE_DESKTOP_CODE_PROVIDER.label,
    source: 'claude-desktop-code',
    title: deriveClaudeDesktopCodeTitle(session),
    cwd,
    projectName: projectNameFromCwd(cwd, 'Claude Desktop Code'),
    model: session.model || signals.model,
    archived: Boolean(session.isArchived),
    createdAtMs,
    updatedAtMs,
    signals,
    extra: {
      appDeepLink,
      cliSessionId,
      bridgeSessionIds: Array.isArray(session.bridgeSessionIds)
        ? session.bridgeSessionIds.filter((id) => typeof id === 'string' && /^(?:cse|session)_[A-Za-z0-9_-]{1,128}$/.test(id)) : [],
      permissionMode: session.permissionMode || '',
      completedTurns: coerceNumber(session.completedTurns),
      transcriptActivityAtMs: coerceNumber(signals.latestEventAtMs) || null,
      embeddedSubagentCount: coerceNumber(subagentStats?.count),
      embeddedSubagentUpdatedAtMs: coerceNumber(subagentStats?.updatedAtMs) || null,
    },
  }, nowMs);
}

async function readSignalsForFile(filePath, options = {}) {
  const { maxBytes = DEFAULT_MAX_JSONL_BYTES } = options;
  const key = `${filePath}\0${maxBytes}`;
  const pending = claudeSignalReads.get(key);
  if (pending) {
    const signals = await pending;
    claudeJsonlSignalCache.get(key, options.cacheScope);
    claudeCacheMetrics.jsonlSignalHits += 1;
    return signals;
  }
  const read = readClaudeSignalFile(filePath, options);
  rememberBounded(claudeSignalReads, key, read, MAX_ASB_SESSION_COUNT);
  try { return await read; }
  finally { if (claudeSignalReads.get(key) === read) claudeSignalReads.delete(key); }
}

async function readClaudeSignalFile(filePath, { maxBytes = DEFAULT_MAX_JSONL_BYTES, cacheScope = '' } = {}) {
  try {
    // The cached file index does not refresh transcript stats, so each read gets a current one.
    const fileStat = await fs.stat(filePath);
    const signature = statSignature(fileStat);
    const cacheKey = `${filePath}\0${maxBytes}`;
    const cached = claudeJsonlSignalCache.get(cacheKey, cacheScope);
    if (
      cached
      && !cached.invalidated
      && sameFileSignature(cached.signature, signature)
    ) {
      claudeCacheMetrics.jsonlSignalHits += 1;
      return cached.signals;
    }
    claudeCacheMetrics.jsonlSignalMisses += 1;

    let parsed;
    const previous = cached?.signature;
    if (cached?.state && signature.size > previous.size && signature.ino === previous.ino && signature.dev === previous.dev) {
      const handle = await fs.open(filePath, 'r');
      let unchanged = false;
      try {
        const guard = Buffer.alloc(cached.guard.length);
        const { bytesRead } = await handle.read(guard, 0, guard.length, previous.size - guard.length);
        claudeCacheMetrics.jsonlSignalBytesRead += bytesRead;
        unchanged = bytesRead === guard.length && guard.equals(cached.guard);
      } finally {
        await handle.close();
      }
      // shortcut: bytes before the guard stay unchanged on append; use full verification if writers edit earlier records.
      if (unchanged) parsed = await scanClaudeSignalRecords(filePath, fileStat, structuredClone(cached.state), cached.offset,
        cached.guard.subarray(0, Math.max(0, cached.guard.length - (previous.size - cached.offset))));
    }
    if (!parsed) {
      const tail = await readTailText(filePath, maxBytes, fileStat);
      const state = initialSignals();
      const lastNewline = tail.text.lastIndexOf('\n');
      for (const line of tail.text.slice(0, lastNewline + 1).split('\n')) applyClaudeSignalLine(state, line);
      const visible = structuredClone(state);
      applyClaudeSignalLine(visible, tail.text.slice(lastNewline + 1));
      parsed = { state, signals: finishClaudeSignals(visible), offset: tail.offset, guard: tail.guard };
      if (fileStat.size > maxBytes) {
        const recovery = await scanClaudeSignalRecords(filePath, fileStat, initialSignals(), 0, Buffer.alloc(0), true);
        parsed.state.lifecycle = recovery.state.lifecycle;
        parsed.signals.lifecycle = recovery.signals.lifecycle;
        parsed.offset = recovery.offset;
        parsed.guard = recovery.guard;
      }
    }
    claudeJsonlSignalCache.remember(
      cacheKey,
      { signature, ...parsed },
      cacheScope,
      MAX_ASB_SESSION_COUNT,
      claudeCacheMetrics,
      'jsonlSignalWrites',
      'jsonlSignalEvictions',
    );
    return parsed.signals;
  } catch {
    return parseClaudeJsonlSignals('');
  }
}

async function scanClaudeSignalRecords(filePath, stat, state, start = 0, guard = Buffer.alloc(0), lifecycleOnly = false) {
  if (start === stat.size) return { state, signals: finishClaudeSignals(state), offset: start, guard };
  const input = createReadStream(filePath, { start, end: stat.size - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lastLine = '', readBytes = 0, offset = start;
  input.on('data', (chunk) => {
    const lastNewline = chunk.lastIndexOf(10);
    if (lastNewline >= 0) offset = start + readBytes + lastNewline + 1;
    readBytes += chunk.length;
    guard = Buffer.concat([guard, chunk.subarray(-CLAUDE_APPEND_GUARD_BYTES)]).subarray(-CLAUDE_APPEND_GUARD_BYTES);
  });
  try {
    for await (const line of lines) {
      applyClaudeSignalLine(state, lastLine, lifecycleOnly);
      lastLine = line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  claudeCacheMetrics.jsonlSignalBytesRead += readBytes;
  // A valid final record without a newline is visible, but it is not committed until its line is complete.
  const visible = offset === stat.size ? state : structuredClone(state);
  applyClaudeSignalLine(visible, lastLine, lifecycleOnly);
  return { state, signals: finishClaudeSignals(visible), offset, guard: Buffer.from(guard) };
}

async function readClaudeRootSignals(entry, subagents, options, agentLogs = new Map()) {
  const signals = await readSignalsForFile(entry.filePath, options);
  const root = signals.lifecycle;
  const childrenById = new Map((subagents || []).map((child) => [path.basename(child.filePath, '.jsonl'), child]));
  const work = [root];
  let unknown = false;
  let updatedAtMs = Math.max(0, ...(subagents || []).map((child) => coerceNumber(child.stat?.mtimeMs)));
  for (const [agentId, link] of root.agents) {
    if (link.endedAtMs) {
      work.push({ running: false, eventAtMs: link.endedAtMs, kind: link.kind,
        endedAtMs: link.endedAtMs, endKind: link.kind,
        finalAtMs: link.kind === 'task_complete' ? link.endedAtMs : 0 });
      continue;
    }
    if (link.runId) {
      // A run has no end record in its logs, so a current file time at or after the launch call is its open work.
      const logs = agentLogs.get(`${path.dirname(entry.filePath)}\nworkflows/${link.runId}`) || [];
      const ownDir = path.join(entry.filePath.slice(0, -'.jsonl'.length), 'subagents', 'workflows', link.runId);
      const own = logs.filter((log) => path.dirname(log.filePath) === ownDir);
      const atMs = Math.max(-1, ...await Promise.all((own.length ? own : logs).map(async (log) => (
        (await fs.stat(log.filePath).catch(() => null))?.mtimeMs ?? -1))));
      if (atMs < link.startedAtMs) unknown = true;
      else work.push({ running: true, kind: 'task_started', startedAtMs: link.requestStartedAtMs || link.startedAtMs,
        activityAtMs: atMs, eventAtMs: atMs });
      continue;
    }
    let child = childrenById.get(`agent-${agentId}`);
    if (!child) {
      // The app can give a chat a new session ID. The logs of its subagents stay in the folder of the old ID.
      // The cached file index does not refresh stats, so each candidate gets a current one.
      const candidates = agentLogs.get(`${path.dirname(entry.filePath)}\n${agentId}`) || [];
      if (candidates.length === 1) child = candidates[0];
      else {
        const logs = await Promise.all(candidates.map(async (log) => (
          { filePath: log.filePath, mtimeMs: (await fs.stat(log.filePath).catch(() => null))?.mtimeMs ?? -1 })));
        child = logs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      }
    }
    const childSignals = child ? await readSignalsForFile(child.filePath, options) : null;
    const lifecycle = childSignals?.lifecycle;
    updatedAtMs = Math.max(updatedAtMs, coerceNumber(childSignals?.latestEventAtMs));
    if (!lifecycle || lifecycle.running === null || lifecycle.eventAtMs < link.startedAtMs) {
      unknown = true;
      continue;
    }
    work.push({ ...lifecycle, startedAtMs: link.requestStartedAtMs || lifecycle.startedAtMs || link.startedAtMs,
      taskStartedAtMs: lifecycle.endedAtMs && lifecycle.startedAtMs > lifecycle.endedAtMs
        ? lifecycle.startedAtMs : link.requestStartedAtMs || lifecycle.startedAtMs || link.startedAtMs });
  }
  const active = work.filter((item) => item.running === true);
  const recent = active.filter((item) => coerceNumber(item.activityAtMs) > 0
    && (options.nowMs || Date.now()) - item.activityAtMs <= CLAUDE_ACTIVITY_WINDOW_MS);
  const latestEnd = work.filter((item) => item.running === false).sort((a, b) => b.eventAtMs - a.eventAtMs)[0];
  const lastEnded = work.filter((item) => item.endedAtMs).sort((a, b) => b.endedAtMs - a.endedAtMs)[0];
  const groupEnded = !unknown && lastEnded && active.every((item) => (item.taskStartedAtMs ?? item.startedAtMs) > lastEnded.endedAtMs);
  const running = active.length ? true : unknown ? undefined : root.running;
  return {
    signals: { ...signals,
      // Only AskUserQuestion is pending and a linked child has recent open work: the question does not stop the group.
      questionNonBlocking: signals.pendingTools.length > 0 && signals.pendingTools.every((tool) => tool.tool === 'AskUserQuestion')
        && recent.some((item) => item !== root),
      lifecycleRunning: running,
      childWorkUnknown: unknown,
      latestTaskStartedAtMs: root.startedAtMs,
      latestTaskEndedAtMs: root.endedAtMs,
      latestTaskEndKind: root.endKind,
      groupTaskEndedAtMs: groupEnded ? lastEnded.endedAtMs : 0,
      groupTaskEndKind: groupEnded ? lastEnded.endKind : '',
      agentStartedAtMs: recent.length ? Math.min(...recent.map((item) => item.startedAtMs).filter(Boolean)) : 0,
      agentActivityAtMs: active.length ? Math.max(...active.map((item) => item.activityAtMs)) : 0,
      latestLifecycleAtMs: active.length ? Math.max(...active.map((item) => item.eventAtMs)) : latestEnd?.eventAtMs || 0,
      latestLifecycleKind: active.length ? 'task_started' : latestEnd?.kind || '',
      latestAgentFinalAtMs: active.length || unknown ? 0 : latestEnd?.kind === 'task_complete'
        ? Math.max(...work.map((item) => item.finalAtMs || 0)) : signals.latestAgentFinalAtMs,
    },
    subagentStats: { count: subagents?.length || 0, updatedAtMs },
  };
}

async function indexClaudeProjectFiles(projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR) {
  const pending = claudeProjectIndexReads.get(projectsDir);
  if (pending) {
    claudeCacheMetrics.projectIndexHits += 1;
    return pending;
  }
  const read = (async () => {
    const files = await indexedFiles(projectsDir, (_filePath, name) => name.endsWith('.jsonl'), { refreshStats: false });
    const cached = claudeProjectIndexCacheByDir.get(projectsDir);
    if (cached?.sourceFiles === files) {
      claudeCacheMetrics.projectIndexHits += 1;
      return cached;
    }
    claudeCacheMetrics.projectIndexMisses += 1;
    const indexed = indexClaudeTranscripts(files);
    const result = { files: indexed, sourceFiles: files,
      subagentsBySession: claudeSubagentsByRoot(indexed.values()), agentLogs: claudeAgentLogs(indexed.values()) };
    if (claudeProjectIndexReads.get(projectsDir) === read) rememberBounded(claudeProjectIndexCacheByDir, projectsDir, result, 32,
      claudeCacheMetrics, 'projectIndexWrites');
    return result;
  })();
  rememberBounded(claudeProjectIndexReads, projectsDir, read, 32);
  try { return await read; }
  finally { if (claudeProjectIndexReads.get(projectsDir) === read) claudeProjectIndexReads.delete(projectsDir); }
}

function claudeSubagentParentSessionId(filePath = '') {
  const parentDir = path.dirname(filePath);
  if (path.basename(parentDir) !== 'subagents') return '';
  return path.basename(path.dirname(parentDir));
}

function indexClaudeTranscripts(entries) {
  // The logs of two workflow runs can have the same file name (`journal.jsonl`), so their key is the path.
  return new Map(entries.map((entry) => [claudeSubagentParentSessionId(entry.filePath)
    || path.basename(path.dirname(path.dirname(entry.filePath))) === 'workflows'
    ? entry.filePath : path.basename(entry.filePath, '.jsonl'), entry]));
}

function claudeSubagentsByRoot(entries) {
  const bySession = new Map();
  for (const entry of entries) {
    const parentSessionId = claudeSubagentParentSessionId(entry.filePath);
    if (!parentSessionId) continue;
    const rootPath = `${path.dirname(path.dirname(entry.filePath))}.jsonl`;
    const current = bySession.get(rootPath) || [];
    current.push(entry);
    bySession.set(rootPath, current);
  }
  return bySession;
}

function claudeAgentLogs(entries) {
  // Subagent logs have a project folder and agent ID key. Workflow logs have a project folder and run ID key.
  const agentLogs = new Map();
  for (const entry of entries) {
    const runDir = path.dirname(entry.filePath), flows = path.dirname(runDir);
    const run = path.basename(flows) === 'workflows' && claudeSubagentParentSessionId(flows);
    if (!run && !claudeSubagentParentSessionId(entry.filePath)) continue;
    const key = run ? `${path.dirname(path.dirname(path.dirname(flows)))}\nworkflows/${path.basename(runDir)}`
      : `${path.dirname(path.dirname(path.dirname(entry.filePath)))}\n${path.basename(entry.filePath, '.jsonl').replace(/^agent-/, '')}`;
    agentLogs.set(key, [...(agentLogs.get(key) || []), entry]);
  }
  return agentLogs;
}

// Old option names (asbMode, usageCache, fileIndexCacheTtlMs, todayStartMs, projectFiles) are accepted and ignored.
export async function loadClaudeDesktopCodeThreads({
  appDir = DEFAULT_CLAUDE_APP_DIR,
  projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR,
  maxCount = DEFAULT_MAX_COUNT,
  maxBytes = DEFAULT_MAX_JSONL_BYTES,
  nowMs = Date.now(),
  strictMetadataRead = false,
  cacheScope = '',
} = {}) {
  const root = path.join(appDir, 'claude-code-sessions');
  if (strictMetadataRead) await fs.stat(root);
  let metadataReadErrors = 0;
  const files = await recentFiles(root, (_filePath, name) => /^local_.*\.json$/.test(name), maxCount,
    strictMetadataRead ? () => { metadataReadErrors += 1; } : null);
  const { files: indexedProjectFiles, subagentsBySession, agentLogs } = await indexClaudeProjectFiles(projectsDir)
    .catch(() => ({ files: new Map(), subagentsBySession: new Map(), agentLogs: new Map() }));
  const parsed = await mapWithConcurrency(files, SIGNAL_CONCURRENCY, async (entry) => {
    try {
      const session = await readJsonFile(entry.filePath, entry.stat, cacheScope);
      const projectFile = indexedProjectFiles.get(String(session.cliSessionId || ''));
      const rootSignals = projectFile
        ? await readClaudeRootSignals(projectFile, subagentsBySession.get(projectFile.filePath), { maxBytes, nowMs, cacheScope }, agentLogs)
        : { signals: parseClaudeJsonlSignals('') };
      return { session, ...rootSignals, stat: entry.stat };
    } catch {
      metadataReadErrors += 1;
      return null;
    }
  });
  const threads = dedupeClaudeDesktopCodeThreads(parsed
    .filter(Boolean)
    .map((entry) => normalizeClaudeDesktopCodeSession(entry.session, entry, nowMs))
    .filter((thread) => thread.externalId));

  return {
    provider: {
      ...CLAUDE_DESKTOP_CODE_PROVIDER,
      installed: files.length > 0,
      desktopInstalled: files.length > 0,
      status: metadataReadErrors ? (threads.length ? 'warning' : 'error') : files.length ? 'desktop' : 'missing',
      metadataReadErrors,
      message: files.length
        ? `已读取 ${threads.length} 个 Claude Desktop Code 任务`
        : '未检测到 Claude Desktop Code 任务',
      threadCount: threads.length,
    },
    threads,
  };
}

export async function openClaudeThread(thread, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  const appDeepLink = thread.provider === 'claude-desktop-code'
    ? thread.appDeepLink || claudeDesktopCodeDeepLink(thread.cliSessionId, thread.externalId) : '';
  if (!appDeepLink) throw new Error('This session has no direct desktop link.');
  const { command, args } = openCommandForUrl(appDeepLink, platform);
  await runCommand(command, args);
  return {
    opened: true,
    method: 'claude-desktop-deeplink',
  };
}
