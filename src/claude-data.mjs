import { execFile } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';
import { enrichThreadRuntime } from './insights.mjs';
import {
  addTokenBreakdowns,
  emptyTokenBreakdown,
  normalizeTokenBreakdown,
} from './token-usage.mjs';

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
const DEFAULT_MAX_CACHE_COUNT = 400;
const DEFAULT_MAX_CACHE_ENTRY_BYTES = 5 * 1024 * 1024;
const DEFAULT_USAGE_CACHE_TTL_MS = 60_000;
const DEFAULT_FILE_INDEX_CACHE_TTL_MS = 30_000;
const DEFAULT_JSONL_SIGNAL_CACHE_LIMIT = 512;
const MAX_ASB_SESSION_COUNT = 5000;
const DEFAULT_SIGNAL_CONCURRENCY = 6;
const CLAUDE_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const CLAUDE_DESKTOP_CODE_DEFAULT_TITLE = 'General coding session';
const LOW_SIGNAL_USER_MESSAGE = /^(\.|继续|继续吧|你继续|你继续吧|好的|好的好的|可以|可以的|行|ok|okay|收到|嗯|嗯嗯)$/iu;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLAUDE_USAGE_CACHE_PATTERN = /https:\/\/claude\.ai\/api\/organizations\/([^/\0]+)\/usage\b/;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const claudeUsageCacheByKey = new Map();
const claudeProjectIndexCacheByDir = new Map();
const coworkSpacesCacheByAppDir = new Map();
const claudeJsonlSignalCache = new Map();
const claudeMetadataCache = new Map();
const claudeFileIndexCache = new Map();
let jsonlSignalCacheLimit = DEFAULT_JSONL_SIGNAL_CACHE_LIMIT;
const claudeCacheMetrics = {
  usageHits: 0,
  usageMisses: 0,
  usageWrites: 0,
  projectIndexHits: 0,
  projectIndexMisses: 0,
  projectIndexWrites: 0,
  coworkSpacesHits: 0,
  coworkSpacesMisses: 0,
  coworkSpacesWrites: 0,
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

export const CLAUDE_PROVIDER_IDS = new Set([
  'claude-code-cli',
  'claude-desktop-code',
  'claude-desktop-cowork',
]);

const CLAUDE_CODE_CLI_PROVIDER = {
  id: 'claude-code-cli',
  label: 'Claude Code CLI',
};

const CLAUDE_DESKTOP_CODE_PROVIDER = {
  id: 'claude-desktop-code',
  label: 'Claude Desktop Code',
};

const CLAUDE_DESKTOP_COWORK_PROVIDER = {
  id: 'claude-desktop-cowork',
  label: 'Claude Cowork',
};

function coerceNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function rememberBounded(cache, key, value, limit, metrics = null, writeKey = '', evictionKey = '') {
  if (!cache || limit <= 0) return;
  if (metrics && writeKey) metrics[writeKey] = coerceNumber(metrics[writeKey]) + 1;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    if (metrics && evictionKey) metrics[evictionKey] = coerceNumber(metrics[evictionKey]) + 1;
  }
}

function statSignature(stat) {
  return {
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0),
    ctimeMs: Number(stat?.ctimeMs || 0),
    dev: Number(stat?.dev || 0),
    ino: Number(stat?.ino || 0),
  };
}

function sameFileSignature(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
    && a.dev === b.dev && a.ino === b.ino;
}

export function getClaudeCacheStats() {
  return {
    usageCache: {
      entries: claudeUsageCacheByKey.size,
      hits: claudeCacheMetrics.usageHits,
      misses: claudeCacheMetrics.usageMisses,
      writes: claudeCacheMetrics.usageWrites,
    },
    projectIndex: {
      entries: claudeProjectIndexCacheByDir.size,
      hits: claudeCacheMetrics.projectIndexHits,
      misses: claudeCacheMetrics.projectIndexMisses,
      writes: claudeCacheMetrics.projectIndexWrites,
    },
    coworkSpaces: {
      entries: coworkSpacesCacheByAppDir.size,
      hits: claudeCacheMetrics.coworkSpacesHits,
      misses: claudeCacheMetrics.coworkSpacesMisses,
      writes: claudeCacheMetrics.coworkSpacesWrites,
    },
    jsonlSignals: {
      entries: claudeJsonlSignalCache.size,
      limit: jsonlSignalCacheLimit,
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

function timestampToUnixSeconds(value) {
  const timestampMs = timestampToMs(value);
  return timestampMs ? Math.floor(timestampMs / 1000) : null;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function optionalBoolean(object, key) {
  return hasOwn(object, key) ? Boolean(object[key]) : null;
}

function shellQuote(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function appleScriptString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function compactInlineText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function truncateText(value = '', maxLength = 140) {
  const text = compactInlineText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isMeaningfulUserText(value = '') {
  const text = compactInlineText(value);
  if (text.length < 2) return false;
  if (LOW_SIGNAL_USER_MESSAGE.test(text)) return false;
  if (text.startsWith('<local-command-caveat>')) return false;
  return true;
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

function usageTokenTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;

  const direct = firstPresent(
    usage.total_tokens,
    usage.totalTokens,
    usage.total,
  );
  if (direct !== undefined) return coerceNumber(direct);

  const tokenTotal = [
    usage.input_tokens,
    usage.inputTokens,
    usage.output_tokens,
    usage.outputTokens,
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.reasoning_tokens,
    usage.reasoningTokens,
  ].reduce((sum, value) => sum + coerceNumber(value), 0);

  if (tokenTotal > 0) return tokenTotal;

  if (Array.isArray(usage.iterations)) {
    return usage.iterations.reduce((sum, item) => sum + usageTokenTotal(item), 0);
  }

  if (usage.modelUsage && typeof usage.modelUsage === 'object') {
    return Object.values(usage.modelUsage)
      .reduce((sum, item) => sum + usageTokenTotal(item), 0);
  }

  return 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeClaudeUsageWindow(window, windowMinutes) {
  if (!window || typeof window !== 'object') return null;

  const usedPercent = firstFiniteNumber(
    window.used_percent,
    window.usedPercentage,
    window.used_percentage,
    window.utilization,
  );
  if (usedPercent === null) return null;

  const resetsAt = timestampToUnixSeconds(firstPresent(
    window.resets_at,
    window.resetsAt,
    window.reset_at,
    window.resetAt,
  ));

  return {
    used_percent: usedPercent,
    resets_at: resetsAt,
    window_minutes: coerceNumber(window.window_minutes || window.windowMinutes, windowMinutes),
  };
}

function normalizeFirstClaudeUsageWindow(windowMinutes, ...windows) {
  for (const window of windows) {
    const normalized = normalizeClaudeUsageWindow(window, windowMinutes);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeClaudeUsageRateLimits(value) {
  if (!value || typeof value !== 'object') return null;

  const primary = normalizeFirstClaudeUsageWindow(
    300,
    value.primary,
    value.five_hour,
    value.fiveHour,
    value['5h'],
  );
  const secondary = normalizeFirstClaudeUsageWindow(
    10_080,
    value.secondary,
    value.seven_day,
    value.sevenDay,
    value['7d'],
    value.seven_day_cowork,
    value.sevenDayCowork,
    value.seven_day_opus,
    value.sevenDayOpus,
    value.seven_day_sonnet,
    value.sevenDaySonnet,
    value.seven_day_omelette,
    value.sevenDayOmelette,
  );

  if (!primary && !secondary) return null;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function rememberRateLimits(signals, value, timestampMs) {
  const rateLimits = normalizeClaudeUsageRateLimits(value);
  if (!rateLimits) return;

  signals.rateLimits = rateLimits;
  signals.latestRateLimitAtMs = timestampMs || signals.latestEventAtMs || signals.latestRateLimitAtMs;
  signals.latestThreadRateLimitAtMs = signals.latestRateLimitAtMs;
}

function rateLimitCandidates(event) {
  return [
    event?.rate_limits,
    event?.rateLimits,
    event?.payload?.rate_limits,
    event?.payload?.rateLimits,
    event?.message?.rate_limits,
    event?.message?.rateLimits,
    event?.status_line?.rate_limits,
    event?.statusLine?.rate_limits,
    event?.statusLine?.rateLimits,
  ].filter(Boolean);
}

function modelFromUsageModelUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return '';
  const [model] = Object.entries(modelUsage)
    .sort((a, b) => usageTokenTotal(b[1]) - usageTokenTotal(a[1]))[0] || [];
  return model || '';
}

function isPermissionToolUse(item) {
  const name = String(item?.name || item?.tool || '');
  return /(^AskUserQuestion$|permission|approval|request.*directory|request.*folder|allow_cowork_file_delete|ask.*user)/i.test(name);
}

function toolUseTitle(item) {
  const name = String(item?.name || item?.tool || '工具调用');
  if (name === 'AskUserQuestion') return '向用户提问';
  if (name.includes('request_cowork_directory')) return '请求选择文件夹';
  if (name.includes('allow_cowork_file_delete')) return '请求删除文件';
  return name.replace(/^mcp__/, '').replaceAll('__', ' / ');
}

function addUsage(signals, usage, timestampMs, usageKey, bucket = 'assistant') {
  const tokens = usageTokenTotal(usage);
  if (tokens <= 0 || signals.seenUsageKeys.has(usageKey)) return;

  signals.seenUsageKeys.add(usageKey);
  const tokenKey = bucket === 'result' ? 'resultTokensUsed' : 'assistantTokensUsed';
  const todayTokenKey = bucket === 'result' ? 'resultTodayTokenUsage' : 'assistantTodayTokenUsage';
  const breakdownKey = bucket === 'result' ? 'resultTokenBreakdown' : 'assistantTokenBreakdown';
  const todayBreakdownKey = bucket === 'result' ? 'resultTodayTokenBreakdown' : 'assistantTodayTokenBreakdown';
  const breakdown = normalizeTokenBreakdown(usage);
  signals[tokenKey] += tokens;
  signals[breakdownKey] = addTokenBreakdowns(signals[breakdownKey], breakdown);
  if (signals.todayStartMs && timestampMs >= signals.todayStartMs) {
    signals[todayTokenKey] += tokens;
    signals[todayBreakdownKey] = addTokenBreakdowns(signals[todayBreakdownKey], breakdown);
  }
}

function initialSignals(todayStartMs = 0) {
  return {
    todayStartMs,
    assistantTokensUsed: 0,
    assistantTodayTokenUsage: 0,
    assistantTokenBreakdown: emptyTokenBreakdown(),
    assistantTodayTokenBreakdown: emptyTokenBreakdown(),
    resultTokensUsed: 0,
    resultTodayTokenUsage: 0,
    resultTokenBreakdown: emptyTokenBreakdown(),
    resultTodayTokenBreakdown: emptyTokenBreakdown(),
    tokensUsed: 0,
    todayTokenUsage: 0,
    tokenBreakdown: emptyTokenBreakdown(),
    todayTokenBreakdown: emptyTokenBreakdown(),
    rateLimits: null,
    latestRateLimitAtMs: null,
    latestThreadRateLimitAtMs: null,
    seenUsageKeys: new Set(),
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
    agents: new Map(), agentTools: new Map() };
}

function applyClaudeLifecycle(lifecycle, event, timestampMs) {
  if (!timestampMs) return;
  const content = event.message?.content;
  const text = contentText(content).trim();
  const result = event.toolUseResult;
  if (event.type === 'user' && result?.isAsync === true && result.status === 'async_launched'
    && /^[A-Za-z0-9_-]+$/.test(String(result.agentId || ''))) {
    const toolId = Array.isArray(content) ? content.find((item) => item?.type === 'tool_result')?.tool_use_id : '';
    const tool = lifecycle.agentTools.get(toolId);
    if (tool) rememberBounded(lifecycle.agents, result.agentId, {
      launchedAtMs: timestampMs, startedAtMs: tool.startedAtMs,
      requestStartedAtMs: tool.requestStartedAtMs, endedAtMs: 0, kind: '',
    }, MAX_ASB_SESSION_COUNT);
  }
  if (event.type === 'user' && text.startsWith('<task-notification>')) {
    const agentId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const status = text.match(/<status>([^<]+)<\/status>/)?.[1];
    const agent = lifecycle.agents.get(agentId);
    if (agent && timestampMs >= agent.launchedAtMs && ['completed', 'failed', 'cancelled', 'aborted'].includes(status)) {
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
  const completed = event.type === 'result' || kind === 'stop_hook_summary' || kind === 'task_complete'
    || (event.type === 'assistant' && ['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(stopReason));
  if (cancelled || failed || completed) {
    lifecycle.running = false;
    lifecycle.eventAtMs = timestampMs;
    lifecycle.kind = cancelled ? 'cancelled' : failed ? 'failed' : 'task_complete';
    lifecycle.finalAtMs = cancelled || failed ? 0 : timestampMs;
    return;
  }
  const humanStart = event.type === 'user' && !event.isMeta && isMeaningfulUserText(text);
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
      if (tool?.type === 'tool_use' && ['Agent', 'Task'].includes(tool.name) && tool.id) {
        rememberBounded(lifecycle.agentTools, tool.id, { startedAtMs: timestampMs,
          requestStartedAtMs: lifecycle.startedAtMs }, MAX_ASB_SESSION_COUNT);
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
  if (text && isMeaningfulUserText(text)) {
    const compactText = truncateText(text, 500);
    signals.firstUserMessage ||= compactText;
    signals.latestUserMessage = compactText;
    signals.latestMeaningfulUserMessage = compactText;
    signals.latestUserMessageAtMs = timestampMs || signals.latestUserMessageAtMs;
    signals.latestMessageKind = 'user';
  }
}

function handleAssistantEvent(signals, event, timestampMs, asbMode = false) {
  const message = event.message || {};
  const messageId = message.id || event.uuid || '';
  const text = contentText(message.content);
  const hasText = Boolean(compactInlineText(text));
  const stopReason = String(firstPresent(
    message.stop_reason,
    message.stopReason,
    event.stop_reason,
    event.stopReason,
  ) || '').toLowerCase();

  if (message.model) signals.model = String(message.model);
  if (message.usage && !asbMode) {
    addUsage(signals, message.usage, timestampMs, `assistant:${messageId || timestampMs}:${JSON.stringify({
      i: message.usage.input_tokens,
      o: message.usage.output_tokens,
      cr: message.usage.cache_read_input_tokens,
      cc: message.usage.cache_creation_input_tokens,
    })}`);
  }

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

function handleResultEvent(signals, event, timestampMs, asbMode = false) {
  signals.pendingToolsById.clear();
  signals.pendingToolAtMs = 0;

  if (event.usage && !asbMode) {
    addUsage(signals, event.usage, timestampMs, `result:${event.uuid || event.session_id || timestampMs}`, 'result');
  }

  if (event.modelUsage) {
    signals.model ||= modelFromUsageModelUsage(event.modelUsage);
  }

  if (event.result) {
    signals.lastAgentMessage = truncateText(event.result, 500);
  }

  if (!event.is_error && event.terminal_reason !== 'interrupted') {
    rememberAgentCompletion(signals, timestampMs);
  }
}

export function parseClaudeJsonlSignals(jsonlText = '', { todayStartMs = 0, asbMode = false } = {}) {
  const signals = initialSignals(todayStartMs);

  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const timestampMs = timestampToMs(event.timestamp || event._audit_timestamp);
    rememberTimestamp(signals, timestampMs);
    applyClaudeLifecycle(signals.lifecycle, event, timestampMs);
    if (signals.lifecycle.eventAtMs === timestampMs && ['cancelled', 'failed'].includes(signals.lifecycle.kind)) {
      signals.pendingToolsById.clear();
      signals.pendingToolAtMs = 0;
    }
    if (!asbMode) for (const candidate of rateLimitCandidates(event)) {
      rememberRateLimits(signals, candidate, timestampMs);
    }

    signals.sessionId ||= String(event.sessionId || event.session_id || '');
    signals.cwd ||= String(event.cwd || '');
    signals.entrypoint ||= String(event.entrypoint || event.client_platform || '');
    signals.version ||= String(event.version || event.claude_code_version || '');
    signals.gitBranch ||= String(event.gitBranch || event.git_branch || '');

    if (event.type === 'user') {
      handleUserEvent(signals, event, timestampMs);
      continue;
    }

    if (event.type === 'assistant') {
      handleAssistantEvent(signals, event, timestampMs, asbMode);
      continue;
    }

    if (event.type === 'result') {
      handleResultEvent(signals, event, timestampMs, asbMode);
      continue;
    }

    if (event.type === 'system' && event.subtype === 'stop_hook_summary') {
      rememberAgentCompletion(signals, timestampMs);
      continue;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      signals.cwd ||= String(event.cwd || '');
      signals.model ||= String(event.model || '');
      signals.version ||= String(event.claude_code_version || '');
    }
  }

  const pendingTools = [...signals.pendingToolsById.values()]
    .sort((a, b) => coerceNumber(b.signalAtMs) - coerceNumber(a.signalAtMs));
  const pendingToolAtMs = pendingTools
    .reduce((latest, tool) => Math.max(latest, coerceNumber(tool.signalAtMs)), 0);
  const tokensUsed = signals.resultTokensUsed || signals.assistantTokensUsed;
  const todayTokenUsage = signals.resultTokensUsed
    ? signals.resultTodayTokenUsage
    : signals.assistantTodayTokenUsage;
  const tokenBreakdown = signals.resultTokensUsed
    ? signals.resultTokenBreakdown
    : signals.assistantTokenBreakdown;
  const todayTokenBreakdown = signals.resultTokensUsed
    ? signals.resultTodayTokenBreakdown
    : signals.assistantTodayTokenBreakdown;

  return {
    ...signals,
    tokensUsed,
    todayTokenUsage,
    tokenBreakdown,
    todayTokenBreakdown,
    seenUsageKeys: undefined,
    pendingToolsById: undefined,
    pendingToolAtMs,
    pendingTools,
    pendingToolCount: pendingTools.length,
  };
}

async function readTailText(filePath, maxBytes = DEFAULT_MAX_JSONL_BYTES, fileStat = null) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = fileStat || await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return '';

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    claudeCacheMetrics.jsonlSignalBytesRead += bytesRead;
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;

    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

async function readJsonFile(filePath, fileStat = null) {
  const signature = statSignature(fileStat || await fs.stat(filePath));
  const cached = claudeMetadataCache.get(filePath);
  if (cached && sameFileSignature(cached.signature, signature)) {
    claudeCacheMetrics.metadataHits += 1;
    return cached.value;
  }
  claudeCacheMetrics.metadataMisses += 1;
  const text = await fs.readFile(filePath, 'utf8');
  claudeCacheMetrics.metadataBytesRead += Buffer.byteLength(text);
  const value = JSON.parse(text);
  rememberBounded(claudeMetadataCache, filePath, { signature, value }, MAX_ASB_SESSION_COUNT);
  return value;
}

function firstJsonObjectText(text = '') {
  const start = String(text).indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return '';
}

function parseJsonObjectFromText(text = '') {
  const json = firstJsonObjectText(text);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function zstdFrames(buffer) {
  const positions = [];
  let offset = 0;
  while (offset >= 0 && offset < buffer.length) {
    const position = buffer.indexOf(ZSTD_MAGIC, offset);
    if (position < 0) break;
    positions.push(position);
    offset = position + 1;
  }
  return positions;
}

export function parseClaudeUsageCacheEntry(buffer, { filePath = '', mtimeMs = 0 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const text = buffer.toString('utf8');
  const usageMatch = text.match(CLAUDE_USAGE_CACHE_PATTERN);
  if (!usageMatch) return null;

  const bodyCandidates = [];
  for (const position of zstdFrames(buffer)) {
    if (!zlib.zstdDecompressSync) continue;
    try {
      bodyCandidates.push(zlib.zstdDecompressSync(buffer.subarray(position)).toString('utf8'));
    } catch {
      // Not every zstd-looking byte sequence is a complete cache body.
    }
  }
  bodyCandidates.push(text.slice(Math.max(0, usageMatch.index || 0)));

  for (const bodyText of bodyCandidates) {
    const payload = parseJsonObjectFromText(bodyText);
    const rateLimits = normalizeClaudeUsageRateLimits(payload);
    if (!rateLimits) continue;

    const dateMatch = text.match(/date:([^\0\r\n]+)/i);
    const observedAtMs = timestampToMs(dateMatch?.[1]) || coerceNumber(mtimeMs);
    return {
      source: 'claude-desktop-cache',
      sourcePath: filePath,
      organizationId: usageMatch[1],
      observedAtMs,
      payload,
      rateLimits,
    };
  }

  return null;
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
  if (!errors) rememberBounded(claudeFileIndexCache, root, { files, directories }, 32);
  else claudeFileIndexCache.delete(root);
  return files;
}

export function invalidateClaudeData({ filePath = '', index = false } = {}) {
  for (const [key, cached] of claudeJsonlSignalCache) {
    if (!filePath || key.startsWith(`${filePath}\0`) || key.startsWith(`${filePath}${path.sep}`)) cached.invalidated = true;
  }
  if (!filePath) {
    claudeMetadataCache.clear();
    claudeFileIndexCache.clear();
    claudeProjectIndexCacheByDir.clear();
    return;
  }
  claudeMetadataCache.delete(filePath);
  for (const [root, cached] of claudeFileIndexCache) {
    if ((filePath === root || filePath.startsWith(`${root}${path.sep}`))
      && (index || !cached.files.some((entry) => entry.filePath === filePath))) claudeFileIndexCache.delete(root);
  }
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

async function recentFiles(root, predicate, maxCount = DEFAULT_MAX_COUNT, onReadError = null, asbMode = false) {
  const files = asbMode ? await indexedFiles(root, predicate, { onReadError })
    : await walkFiles(root, predicate, [], onReadError);
  return files
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, maxCount);
}

export async function readClaudeUsageCache({
  appDir = DEFAULT_CLAUDE_APP_DIR,
  maxCount = DEFAULT_MAX_CACHE_COUNT,
  maxBytes = DEFAULT_MAX_CACHE_ENTRY_BYTES,
  cacheTtlMs = DEFAULT_USAGE_CACHE_TTL_MS,
  nowMs = Date.now(),
} = {}) {
  const cacheKey = `${appDir}\0${maxCount}\0${maxBytes}`;
  const ttlMs = nonNegativeInteger(cacheTtlMs, DEFAULT_USAGE_CACHE_TTL_MS);
  const cached = claudeUsageCacheByKey.get(cacheKey);
  if (ttlMs > 0 && cached && coerceNumber(cached.expiresAtMs) > nowMs) {
    claudeCacheMetrics.usageHits += 1;
    return cached.value;
  }
  claudeCacheMetrics.usageMisses += 1;

  const cacheDir = path.join(appDir, 'Cache', 'Cache_Data');
  const files = await recentFiles(cacheDir, (_filePath, name) => !name.startsWith('index'), maxCount);
  const entries = [];

  await Promise.all(files.map(async ({ filePath, stat }) => {
    if (stat.size <= 0 || stat.size > maxBytes) return;
    try {
      const entry = parseClaudeUsageCacheEntry(await fs.readFile(filePath), {
        filePath,
        mtimeMs: stat.mtimeMs,
      });
      if (entry) entries.push(entry);
    } catch {
      // Chromium cache entries can disappear or be partially written while Claude runs.
    }
  }));

  const latest = entries
    .sort((a, b) => coerceNumber(b.observedAtMs) - coerceNumber(a.observedAtMs))[0] || null;

  if (ttlMs > 0) {
    claudeUsageCacheByKey.set(cacheKey, {
      value: latest,
      expiresAtMs: nowMs + ttlMs,
    });
    claudeCacheMetrics.usageWrites += 1;
  }

  return latest;
}

async function commandVersion(command, args, runCommand = execFileAsync) {
  const { stdout, stderr } = await runCommand(command, args, { timeout: 5000 });
  return String(stdout || stderr || '').trim();
}

function claudeResumeCommand({ externalId, cwd }) {
  const command = `claude --resume ${shellQuote(externalId)}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

function claudeAppCommand() {
  return 'open -a Claude';
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

function deriveTitle(preferredTitle, signals, fallbackTitle) {
  const stored = compactInlineText(preferredTitle);
  if (stored && stored.length <= 96) return truncateText(stored);

  return truncateText(
    signals.latestMeaningfulUserMessage
    || signals.latestUserMessage
    || signals.firstUserMessage
    || stored
    || fallbackTitle,
  );
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

function selectedFolderPath(folder) {
  if (!folder) return '';
  if (typeof folder === 'string') return folder;
  return String(folder.path || folder.hostPath || '');
}

function isInternalClaudePath(cwd = '') {
  return cwd.startsWith('/sessions/')
    || cwd.includes('/Library/Application Support/Claude/local-agent-mode-sessions/');
}

function workspaceFromCoworkSession(session, space) {
  const selected = (Array.isArray(session.userSelectedFolders) ? session.userSelectedFolders : [])
    .map(selectedFolderPath)
    .find(Boolean);
  const approved = (Array.isArray(session.userApprovedFileAccessPaths) ? session.userApprovedFileAccessPaths : [])
    .map(selectedFolderPath)
    .find(Boolean);
  const spaceFolder = space?.folders?.map(selectedFolderPath)?.find(Boolean) || '';
  const cwd = String(session.cwd || '');

  if (selected) return selected;
  if (approved) return approved;
  if (spaceFolder) return spaceFolder;
  return isInternalClaudePath(cwd) ? '' : cwd;
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
  resumeCommand,
  canOpen = true,
  openLabel = '打开',
  extra = {},
}, nowMs) {
  const pendingTools = Array.isArray(signals?.pendingTools) ? signals.pendingTools : [];
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
    tokensUsed: coerceNumber(signals?.tokensUsed),
    todayTokenUsage: coerceNumber(signals?.todayTokenUsage),
    tokenBreakdown: signals?.tokenBreakdown || emptyTokenBreakdown(),
    todayTokenBreakdown: signals?.todayTokenBreakdown || emptyTokenBreakdown(),
    rateLimits: signals?.rateLimits || null,
    rateLimitUpdatedAtMs: coerceNumber(signals?.latestRateLimitAtMs) || null,
    rateLimitActivityAtMs: coerceNumber(signals?.latestThreadRateLimitAtMs) || null,
    hasUnreadTurn: false,
    awaitingPermission: pendingTools.length > 0,
    awaitingReview: false,
    pendingTools,
    pendingToolCount: pendingTools.length,
    pendingToolAtMs: coerceNumber(signals?.pendingToolAtMs),
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
    resumeCommand,
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

export function normalizeClaudeCodeCliSession({
  filePath = '',
  stat = {},
  signals = {},
  subagentStats = {},
}, nowMs = Date.now()) {
  const externalId = String(signals.sessionId || path.basename(filePath, '.jsonl') || '');
  const cwd = String(signals.cwd || '');
  const nestedStats = subagentStats || {};
  const embeddedSubagentUpdatedAtMs = coerceNumber(nestedStats.updatedAtMs);
  const updatedAtMs = Math.max(
    coerceNumber(signals.latestEventAtMs || stat.mtimeMs),
    embeddedSubagentUpdatedAtMs,
  ) || nowMs;
  const createdAtMs = coerceNumber(signals.oldestEventAtMs || stat.birthtimeMs || updatedAtMs);

  return baseClaudeThread({
    id: `${CLAUDE_CODE_CLI_PROVIDER.id}:${externalId}`,
    externalId,
    provider: CLAUDE_CODE_CLI_PROVIDER.id,
    providerLabel: CLAUDE_CODE_CLI_PROVIDER.label,
    source: 'claude-code-cli',
    title: deriveTitle('', signals, 'Claude Code 任务'),
    cwd,
    projectName: projectNameFromCwd(cwd, 'Claude Code'),
    model: signals.model,
    archived: false,
    createdAtMs,
    updatedAtMs,
    signals,
    resumeCommand: externalId ? claudeResumeCommand({ externalId, cwd }) : '',
    extra: {
      cliVersion: signals.version || '',
      entrypoint: signals.entrypoint || '',
      embeddedSubagentCount: coerceNumber(nestedStats.count),
      embeddedSubagentUpdatedAtMs: embeddedSubagentUpdatedAtMs || null,
    },
  }, nowMs);
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
  let resumeCommand = claudeAppCommand();
  if (appDeepLink) {
    resumeCommand = `open ${shellQuote(appDeepLink)}`;
  } else if (cliSessionId) {
    resumeCommand = claudeResumeCommand({ externalId: cliSessionId, cwd });
  }

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
    resumeCommand,
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

export function normalizeClaudeDesktopCoworkSession(session, {
  signals = {},
  stat = {},
  space = null,
} = {}, nowMs = Date.now()) {
  const externalId = String(session.sessionId || session.id || '');
  const workspace = workspaceFromCoworkSession(session, space);
  const projectName = space?.name
    || projectNameFromCwd(workspace, session.scheduledTaskId ? 'Claude 定时任务' : 'Claude Cowork');
  const updatedAtMs = Math.max(
    timestampToMs(session.lastActivityAt),
    coerceNumber(signals.latestEventAtMs),
    coerceNumber(stat.mtimeMs),
  ) || nowMs;
  const createdAtMs = timestampToMs(session.createdAt)
    || coerceNumber(signals.oldestEventAtMs)
    || updatedAtMs;
  const isAgentCompleted = optionalBoolean(session, 'isAgentCompleted');
  const agentRunning = isAgentCompleted === false;

  return baseClaudeThread({
    id: `${CLAUDE_DESKTOP_COWORK_PROVIDER.id}:${externalId}`,
    externalId,
    provider: CLAUDE_DESKTOP_COWORK_PROVIDER.id,
    providerLabel: CLAUDE_DESKTOP_COWORK_PROVIDER.label,
    source: session.hostLoopMode === false ? 'claude-desktop-local-agent' : 'claude-desktop-cowork',
    title: deriveTitle(session.title, signals, 'Claude Cowork 任务'),
    cwd: workspace || String(session.cwd || ''),
    projectName,
    model: session.model || signals.model,
    archived: Boolean(session.isArchived),
    createdAtMs,
    updatedAtMs,
    signals,
    resumeCommand: claudeAppCommand(),
    openLabel: '打开',
    extra: {
      cliSessionId: session.cliSessionId || '',
      processName: session.processName || '',
      spaceId: session.spaceId || '',
      scheduledTaskId: session.scheduledTaskId || '',
      isAgentCompleted,
      agentRunning,
      agentStartedAtMs: agentRunning
        ? coerceNumber(signals.latestUserMessageAtMs || createdAtMs || updatedAtMs)
        : null,
      agentActivityAtMs: agentRunning ? updatedAtMs : null,
    },
  }, nowMs);
}

async function readSignalsForFile(filePath, {
  todayStartMs,
  asbMode = false,
  maxBytes = DEFAULT_MAX_JSONL_BYTES,
  stat = null,
  signalCache = claudeJsonlSignalCache,
  signalCacheLimit = asbMode ? MAX_ASB_SESSION_COUNT : DEFAULT_JSONL_SIGNAL_CACHE_LIMIT,
} = {}) {
  try {
    const fileStat = stat || await fs.stat(filePath);
    const signature = statSignature(fileStat);
    const parseOptions = { todayStartMs: asbMode ? 0 : todayStartMs, asbMode };
    const requestedLimit = Math.min(MAX_ASB_SESSION_COUNT, Math.max(0, Number(signalCacheLimit) || 0));
    if (signalCache === claudeJsonlSignalCache) jsonlSignalCacheLimit = requestedLimit;
    const cacheLimit = requestedLimit;
    const cacheKey = `${filePath}\0${parseOptions.todayStartMs || 0}\0${maxBytes}\0${asbMode}`;
    const cached = signalCache?.get(cacheKey);
    if (
      cached
      && !cached.invalidated
      && sameFileSignature(cached.signature, signature)
    ) {
      claudeCacheMetrics.jsonlSignalHits += 1;
      return cached.signals;
    }
    claudeCacheMetrics.jsonlSignalMisses += 1;

    const signals = parseClaudeJsonlSignals(
      await readTailText(filePath, maxBytes, fileStat),
      parseOptions,
    );
    let lifecycleOffset;
    if (fileStat.size > maxBytes) {
      const recovery = await scanClaudeLifecycle(filePath, fileStat, cached);
      signals.lifecycle = recovery.lifecycle;
      lifecycleOffset = recovery.offset;
    }
    rememberBounded(
      signalCache,
      cacheKey,
      { signature, signals, lifecycleOffset },
      cacheLimit,
      claudeCacheMetrics,
      'jsonlSignalWrites',
      'jsonlSignalEvictions',
    );
    return signals;
  } catch {
    return parseClaudeJsonlSignals('', { todayStartMs, asbMode });
  }
}

async function scanClaudeLifecycle(filePath, stat, cached) {
  const previous = cached?.signature;
  const append = Number.isFinite(cached?.lifecycleOffset) && previous.ino === stat.ino && previous.dev === stat.dev
    && stat.size > previous.size;
  const lifecycle = append ? structuredClone(cached.signals.lifecycle) : initialClaudeLifecycle();
  const start = append ? cached.lifecycleOffset : 0;
  const input = createReadStream(filePath, { encoding: 'utf8', start, end: stat.size - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lastLine = '', suffix = '';
  input.on('data', (chunk) => { suffix = chunk.slice(-2); });
  try {
    for await (const line of lines) {
      lastLine = line;
      try {
        const event = JSON.parse(line);
        applyClaudeLifecycle(lifecycle, event, timestampToMs(event.timestamp || event._audit_timestamp));
      } catch {
        // Ignore partial or corrupt records, as in the transcript parser.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  claudeCacheMetrics.jsonlSignalBytesRead += stat.size - start;
  return { lifecycle, offset: /[\r\n]$/.test(suffix) ? stat.size : stat.size - Buffer.byteLength(lastLine) };
}

async function readClaudeRootSignals(entry, subagents, options) {
  const signals = await readSignalsForFile(entry.filePath, { ...options, stat: options.asbMode ? null : entry.stat });
  const root = signals.lifecycle;
  const childrenById = new Map((subagents || []).map((child) => [path.basename(child.filePath, '.jsonl'), child]));
  const work = [root];
  let unknown = false;
  let updatedAtMs = Math.max(0, ...(subagents || []).map((child) => coerceNumber(child.stat?.mtimeMs)));
  for (const [agentId, link] of root.agents) {
    if (link.endedAtMs) {
      work.push({ running: false, eventAtMs: link.endedAtMs, kind: link.kind,
        finalAtMs: link.kind === 'task_complete' ? link.endedAtMs : 0 });
      continue;
    }
    const child = childrenById.get(`agent-${agentId}`);
    const childSignals = child ? await readSignalsForFile(child.filePath, {
      ...options, stat: options.asbMode ? null : child.stat,
    }) : null;
    const lifecycle = childSignals?.lifecycle;
    updatedAtMs = Math.max(updatedAtMs, coerceNumber(childSignals?.latestEventAtMs));
    if (!lifecycle || lifecycle.running === null || lifecycle.eventAtMs < link.startedAtMs) {
      unknown = true;
      continue;
    }
    work.push({ ...lifecycle, startedAtMs: link.requestStartedAtMs || lifecycle.startedAtMs || link.startedAtMs });
  }
  const active = work.filter((item) => item.running === true);
  const recent = active.filter((item) => coerceNumber(item.activityAtMs) > 0
    && (options.nowMs || Date.now()) - item.activityAtMs <= CLAUDE_ACTIVITY_WINDOW_MS);
  const latestEnd = work.filter((item) => item.running === false).sort((a, b) => b.eventAtMs - a.eventAtMs)[0];
  const running = active.length ? true : unknown ? undefined : root.running;
  return {
    signals: { ...signals,
      lifecycleRunning: running,
      childWorkUnknown: unknown,
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

function mergeClaudeUsageCacheSignals(signals = {}, usageCache = null) {
  if (!usageCache?.rateLimits) return signals;

  const signalAtMs = coerceNumber(signals.latestRateLimitAtMs);
  const cacheAtMs = coerceNumber(usageCache.observedAtMs);
  if (signals.rateLimits && signalAtMs >= cacheAtMs) return signals;

  return {
    ...signals,
    rateLimits: usageCache.rateLimits,
    latestRateLimitAtMs: cacheAtMs || signalAtMs || signals.latestEventAtMs || null,
    latestThreadRateLimitAtMs: signals.latestThreadRateLimitAtMs || null,
  };
}

async function indexClaudeProjectFiles(
  projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR,
  {
    cacheTtlMs = DEFAULT_FILE_INDEX_CACHE_TTL_MS,
    nowMs = Date.now(),
    asbMode = false,
  } = {},
) {
  if (asbMode) {
    const files = await indexedFiles(projectsDir, (_filePath, name) => name.endsWith('.jsonl'), { refreshStats: false });
    const cached = claudeProjectIndexCacheByDir.get(projectsDir);
    if (cached?.sourceFiles === files) {
      claudeCacheMetrics.projectIndexHits += 1;
      return cached.files;
    }
    claudeCacheMetrics.projectIndexMisses += 1;
    const indexed = indexClaudeTranscripts(files);
    rememberBounded(claudeProjectIndexCacheByDir, projectsDir, { files: indexed, sourceFiles: files }, 32,
      claudeCacheMetrics, 'projectIndexWrites');
    return indexed;
  }
  const ttlMs = nonNegativeInteger(cacheTtlMs, DEFAULT_FILE_INDEX_CACHE_TTL_MS);
  const cached = claudeProjectIndexCacheByDir.get(projectsDir);
  if (ttlMs > 0 && cached && coerceNumber(cached.expiresAtMs) > nowMs) {
    claudeCacheMetrics.projectIndexHits += 1;
    return cached.files;
  }
  claudeCacheMetrics.projectIndexMisses += 1;

  const files = await walkFiles(projectsDir, (_filePath, name) => name.endsWith('.jsonl'));
  const indexed = indexClaudeTranscripts(files);
  if (ttlMs > 0) {
    claudeProjectIndexCacheByDir.set(projectsDir, {
      files: indexed,
      expiresAtMs: nowMs + ttlMs,
    });
    claudeCacheMetrics.projectIndexWrites += 1;
  }
  return indexed;
}

async function readCoworkSpaces(
  appDir = DEFAULT_CLAUDE_APP_DIR,
  {
    cacheTtlMs = DEFAULT_FILE_INDEX_CACHE_TTL_MS,
    nowMs = Date.now(),
  } = {},
) {
  const ttlMs = nonNegativeInteger(cacheTtlMs, DEFAULT_FILE_INDEX_CACHE_TTL_MS);
  const cached = coworkSpacesCacheByAppDir.get(appDir);
  if (ttlMs > 0 && cached && coerceNumber(cached.expiresAtMs) > nowMs) {
    claudeCacheMetrics.coworkSpacesHits += 1;
    return cached.spaces;
  }
  claudeCacheMetrics.coworkSpacesMisses += 1;

  const files = await walkFiles(
    path.join(appDir, 'local-agent-mode-sessions'),
    (_filePath, name) => name === 'spaces.json',
  );
  const spaces = new Map();

  await Promise.all(files.map(async ({ filePath }) => {
    try {
      const parsed = await readJsonFile(filePath);
      for (const space of parsed?.spaces || []) {
        if (space?.id) spaces.set(String(space.id), space);
      }
    } catch {
      // Spaces are metadata only; ignore partial writes.
    }
  }));

  if (ttlMs > 0) {
    coworkSpacesCacheByAppDir.set(appDir, {
      spaces,
      expiresAtMs: nowMs + ttlMs,
    });
    claudeCacheMetrics.coworkSpacesWrites += 1;
  }

  return spaces;
}

function recentEntries(entries, maxCount) {
  return [...entries]
    .sort((a, b) => coerceNumber(b.stat?.mtimeMs) - coerceNumber(a.stat?.mtimeMs))
    .slice(0, maxCount);
}

function claudeSubagentParentSessionId(filePath = '') {
  const parentDir = path.dirname(filePath);
  if (path.basename(parentDir) !== 'subagents') return '';
  return path.basename(path.dirname(parentDir));
}

function indexClaudeTranscripts(entries) {
  return new Map(entries.map((entry) => [claudeSubagentParentSessionId(entry.filePath)
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

export async function loadClaudeCodeCliThreads({
  projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR,
  maxCount = DEFAULT_MAX_COUNT,
  maxBytes = DEFAULT_MAX_JSONL_BYTES,
  excludeSessionIds = new Set(),
  projectFiles = null,
  nowMs = Date.now(),
  todayStartMs = 0,
  runCommand = execFileAsync,
} = {}) {
  const version = await commandVersion('claude', ['--version'], runCommand).catch(() => '');
  const candidates = projectFiles
    ? [...projectFiles.values()]
    : await walkFiles(projectsDir, (_filePath, name) => name.endsWith('.jsonl'));
  const subagentsBySession = claudeSubagentsByRoot(candidates);
  const files = recentEntries(
    candidates.filter((entry) => !claudeSubagentParentSessionId(entry.filePath)),
    maxCount,
  );
  const parsed = await mapWithConcurrency(files, DEFAULT_SIGNAL_CONCURRENCY, async (entry) => ({
    ...entry,
    ...await readClaudeRootSignals(entry, subagentsBySession.get(entry.filePath), { todayStartMs, maxBytes, nowMs }),
  }));
  const threads = parsed
    .map((entry) => normalizeClaudeCodeCliSession(entry, nowMs))
    .filter((thread) => (
      thread.externalId
      && !excludeSessionIds.has(thread.externalId)
    ))
    .slice(0, maxCount);

  return {
    provider: {
      ...CLAUDE_CODE_CLI_PROVIDER,
      installed: Boolean(version),
      cliInstalled: Boolean(version),
      status: version ? 'ready' : 'missing',
      message: version
        ? `已检测到 ${version}，读取 ${threads.length} 个 CLI 任务`
        : '未检测到 claude CLI',
      threadCount: threads.length,
    },
    threads,
  };
}

export async function loadClaudeDesktopCodeThreads({
  appDir = DEFAULT_CLAUDE_APP_DIR,
  projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR,
  maxCount = DEFAULT_MAX_COUNT,
  maxBytes = DEFAULT_MAX_JSONL_BYTES,
  nowMs = Date.now(),
  todayStartMs = 0,
  usageCache,
  projectFiles = null,
  fileIndexCacheTtlMs = DEFAULT_FILE_INDEX_CACHE_TTL_MS,
  usageCacheTtlMs = DEFAULT_USAGE_CACHE_TTL_MS,
  strictMetadataRead = false,
  asbMode = false,
  signalCacheLimit = asbMode ? MAX_ASB_SESSION_COUNT : DEFAULT_JSONL_SIGNAL_CACHE_LIMIT,
  signalConcurrency = DEFAULT_SIGNAL_CONCURRENCY,
} = {}) {
  const root = path.join(appDir, 'claude-code-sessions');
  if (strictMetadataRead) {
    if (asbMode) await fs.stat(root);
    else await fs.readdir(root);
  }
  let metadataReadErrors = 0;
  const files = await recentFiles(root, (_filePath, name) => /^local_.*\.json$/.test(name), maxCount,
    strictMetadataRead ? () => { metadataReadErrors += 1; } : null, asbMode);
  const indexedProjectFiles = projectFiles
    || await indexClaudeProjectFiles(projectsDir, {
      cacheTtlMs: fileIndexCacheTtlMs,
      nowMs,
      asbMode,
    }).catch(() => new Map());
  const desktopUsageCache = asbMode ? null : usageCache === undefined
    ? await readClaudeUsageCache({ appDir, cacheTtlMs: usageCacheTtlMs, nowMs }).catch(() => null)
    : usageCache;
  const subagentsBySession = claudeSubagentsByRoot(indexedProjectFiles.values());
  const parsed = await mapWithConcurrency(files, signalConcurrency, async (entry) => {
    try {
      const session = await readJsonFile(entry.filePath, entry.stat);
      const projectFile = indexedProjectFiles.get(String(session.cliSessionId || ''));
      const rootSignals = projectFile
        ? await readClaudeRootSignals(projectFile, subagentsBySession.get(projectFile.filePath), {
          todayStartMs, maxBytes, asbMode, signalCacheLimit, nowMs,
        })
        : { signals: parseClaudeJsonlSignals('', { todayStartMs, asbMode }) };
      return {
        session,
        ...rootSignals,
        signals: mergeClaudeUsageCacheSignals(rootSignals.signals, desktopUsageCache),
        stat: entry.stat,
      };
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

export async function loadClaudeDesktopCoworkThreads({
  appDir = DEFAULT_CLAUDE_APP_DIR,
  maxCount = DEFAULT_MAX_COUNT,
  maxBytes = DEFAULT_MAX_JSONL_BYTES,
  nowMs = Date.now(),
  todayStartMs = 0,
  usageCache,
  fileIndexCacheTtlMs = DEFAULT_FILE_INDEX_CACHE_TTL_MS,
  usageCacheTtlMs = DEFAULT_USAGE_CACHE_TTL_MS,
} = {}) {
  const root = path.join(appDir, 'local-agent-mode-sessions');
  const files = await recentFiles(root, (_filePath, name) => /^local_.*\.json$/.test(name), maxCount);
  const spaces = await readCoworkSpaces(appDir, {
    cacheTtlMs: fileIndexCacheTtlMs,
    nowMs,
  });
  const desktopUsageCache = usageCache === undefined
    ? await readClaudeUsageCache({ appDir, cacheTtlMs: usageCacheTtlMs, nowMs }).catch(() => null)
    : usageCache;
  const parsed = await Promise.all(files.map(async (entry) => {
    try {
      const session = await readJsonFile(entry.filePath);
      const auditPath = path.join(path.dirname(entry.filePath), path.basename(entry.filePath, '.json'), 'audit.jsonl');
      const signals = mergeClaudeUsageCacheSignals(
        await readSignalsForFile(auditPath, { todayStartMs, maxBytes }),
        desktopUsageCache,
      );
      return {
        session,
        signals,
        stat: entry.stat,
        space: spaces.get(String(session.spaceId || '')) || null,
      };
    } catch {
      return null;
    }
  }));
  const threads = parsed
    .filter(Boolean)
    .map((entry) => normalizeClaudeDesktopCoworkSession(entry.session, entry, nowMs))
    .filter((thread) => thread.externalId);
  const pendingPermissionCount = threads.filter((thread) => thread.awaitingPermission).length;

  return {
    provider: {
      ...CLAUDE_DESKTOP_COWORK_PROVIDER,
      installed: files.length > 0,
      desktopInstalled: files.length > 0,
      status: files.length ? 'desktop' : 'missing',
      message: files.length
        ? `已读取 ${threads.length} 个 Cowork 任务${pendingPermissionCount ? `，${pendingPermissionCount} 个等待处理` : ''}`
        : '未检测到 Claude Cowork 任务',
      threadCount: threads.length,
    },
    threads,
  };
}

export async function loadClaudeAgentThreads(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = options.todayStartMs || todayStart.getTime();
  const appDir = options.appDir || DEFAULT_CLAUDE_APP_DIR;
  const projectsDir = options.projectsDir || DEFAULT_CLAUDE_PROJECTS_DIR;
  const fileIndexCacheTtlMs = options.fileIndexCacheTtlMs ?? DEFAULT_FILE_INDEX_CACHE_TTL_MS;
  const usageCacheTtlMs = options.usageCacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS;
  const [projectFiles, usageCache] = await Promise.all([
    indexClaudeProjectFiles(projectsDir, {
      cacheTtlMs: fileIndexCacheTtlMs,
      nowMs,
    }).catch(() => new Map()),
    Object.prototype.hasOwnProperty.call(options, 'usageCache')
      ? Promise.resolve(options.usageCache)
      : readClaudeUsageCache({
        appDir,
        cacheTtlMs: usageCacheTtlMs,
        nowMs,
      }).catch(() => null),
  ]);

  const [desktopCodeResult, coworkResult] = await Promise.all([
    loadClaudeDesktopCodeThreads({
      ...options,
      appDir,
      projectsDir,
      nowMs,
      todayStartMs,
      usageCache,
      projectFiles,
      fileIndexCacheTtlMs,
      usageCacheTtlMs,
    }),
    loadClaudeDesktopCoworkThreads({
      ...options,
      appDir,
      nowMs,
      todayStartMs,
      usageCache,
      fileIndexCacheTtlMs,
      usageCacheTtlMs,
    }),
  ]);
  const desktopCliSessionIds = new Set(
    desktopCodeResult.threads
      .map((thread) => thread.cliSessionId)
      .filter(Boolean),
  );
  const cliResult = await loadClaudeCodeCliThreads({
    ...options,
    projectsDir,
    nowMs,
    todayStartMs,
    projectFiles,
    excludeSessionIds: desktopCliSessionIds,
  });

  return {
    providers: [
      cliResult.provider,
      desktopCodeResult.provider,
      coworkResult.provider,
    ],
    threads: [
      ...cliResult.threads,
      ...desktopCodeResult.threads,
      ...coworkResult.threads,
    ],
  };
}

export async function openClaudeThread(thread, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  if (thread.provider === 'claude-desktop-code') {
    const appDeepLink = thread.appDeepLink || claudeDesktopCodeDeepLink(thread.cliSessionId, thread.externalId);
    const resumeCommand = thread.resumeCommand
      || (appDeepLink ? `open ${shellQuote(appDeepLink)}` : claudeAppCommand());

    if (appDeepLink) {
      const { command, args } = openCommandForUrl(appDeepLink, platform);
      await runCommand(command, args);
      return {
        opened: true,
        method: 'claude-desktop-deeplink',
        resumeCommand,
      };
    }

    if (platform === 'darwin') {
      await runCommand('open', ['-a', 'Claude']);
      return {
        opened: true,
        method: 'claude-app',
        resumeCommand,
      };
    }

    return {
      opened: false,
      method: 'copy-command',
      resumeCommand,
    };
  }

  if (thread.provider === 'claude-desktop-cowork') {
    if (platform === 'darwin') {
      await runCommand('open', ['-a', 'Claude']);
      return {
        opened: true,
        method: 'claude-app',
        resumeCommand: thread.resumeCommand || claudeAppCommand(),
      };
    }

    return {
      opened: false,
      method: 'copy-command',
      resumeCommand: thread.resumeCommand || claudeAppCommand(),
    };
  }

  const resumeCommand = thread.resumeCommand || (thread.externalId
    ? claudeResumeCommand({ externalId: thread.externalId, cwd: thread.cwd })
    : '');
  if (!resumeCommand) {
    throw new Error('Claude 缺少 resume 命令');
  }

  if (platform === 'darwin') {
    await runCommand('osascript', [
      '-e',
      `tell application "Terminal" to do script "${appleScriptString(resumeCommand)}"`,
    ]);
    return {
      opened: true,
      method: 'claude-terminal',
      resumeCommand,
    };
  }

  return {
    opened: false,
    method: 'copy-command',
    resumeCommand,
  };
}
