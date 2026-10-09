import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { rememberBounded, sameFileSignature, statSignature } from './data-cache.mjs';
import { enrichThreads, normalizeDashboardThreads } from './insights.mjs';

const execFileAsync = promisify(execFile);
const nativeSqlite = import('node:sqlite').catch(() => null);
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_SESSION_INDEX = path.join(DEFAULT_CODEX_DIR, 'session_index.jsonl');
const DEFAULT_GLOBAL_STATE = path.join(DEFAULT_CODEX_DIR, '.codex-global-state.json');
const CODEX_PINNED_THREAD_IDS_KEY = 'pinned-thread-ids';
const CODEX_LOCAL_READ_HOST = `local:${createHash('sha256').update(JSON.stringify(['local', 'local', null])).digest('hex')}`;
const DEFAULT_THREAD_LIMIT = 5000;
const DEFAULT_INITIAL_ROLLOUT_BYTES = 512 * 1024;
const DEFAULT_MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const ROLLOUT_SIGNAL_CONCURRENCY = 6;
const COMPLETION_HINT = /(\bdone\b|\bcompleted?\b|ready for review|handoff|完成|已完成|验收|交付|交接|可以看|可以试)/i;
const LOW_SIGNAL_USER_MESSAGE = /^(继续|继续吧|你继续|你继续吧|好的|好的好的|可以|可以的|行|ok|okay|收到|嗯|嗯嗯|先这样)$/iu;
const ROLLOUT_LIFECYCLE_EVENT_RE = /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|turn_cancelled|task_cancelled|cancelled)"/;
const QUESTION_HISTORY_COMPLETE = Symbol('question history complete');
const LOCAL_ARTIFACT_EXTENSIONS = [
  'avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp',
  'html', 'htm', 'md', 'markdown', 'mdx', 'pdf',
  'doc', 'docx', 'pages', 'rtf', 'csv', 'numbers', 'xls', 'xlsx',
  'key', 'ppt', 'pptx', 'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm',
  'aac', 'aiff', 'flac', 'm4a', 'mp3', 'wav',
  'zip', 'gz', 'rar', 'tar', 'tgz', '7z',
  'txt', 'log', 'css', 'go', 'java', 'js', 'json', 'jsx', 'mjs', 'py', 'rs', 'sh', 'ts', 'tsx', 'xml', 'yaml', 'yml',
];
const LOCAL_ARTIFACT_EXTENSION_RE = LOCAL_ARTIFACT_EXTENSIONS.join('|');
const rolloutSignalCache = new Map();
const rolloutActivityCache = new Map();
const codexMetadataCache = new Map();
const codexNativeReadCache = new WeakMap();
const codexCreatorIdentityCache = new Map();
let rolloutSignalCacheLimit = DEFAULT_THREAD_LIMIT;
const codexCacheMetrics = {
  rolloutSignalHits: 0,
  rolloutSignalMisses: 0,
  rolloutSignalWrites: 0,
  rolloutSignalEvictions: 0,
  rolloutSignalBytesRead: 0,
  lifecycleBytesRead: 0,
  lifecycleHits: 0,
  metadataHits: 0,
  metadataMisses: 0,
  metadataBytesRead: 0,
};

function safeLimit(limit) {
  const number = Number.parseInt(limit, 10);
  if (!Number.isFinite(number)) return DEFAULT_THREAD_LIMIT;
  return Math.min(Math.max(number, 1), DEFAULT_THREAD_LIMIT);
}

async function querySqliteJson(databasePath, sql) {
  const sqlite = await nativeSqlite;
  if (sqlite?.DatabaseSync) {
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  }
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', databasePath, sql], {
    maxBuffer: 20 * 1024 * 1024,
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

export function parseSessionIndex(jsonlText = '') {
  const titleByThreadId = new Map();

  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue;

    try {
      const record = JSON.parse(line);
      if (record?.id && typeof record.thread_name === 'string' && record.thread_name.trim()) {
        titleByThreadId.set(String(record.id), record.thread_name);
      }
    } catch {
      // Ignore partial/corrupt lines; the sqlite title remains a fallback.
    }
  }

  return titleByThreadId;
}

async function readSessionIndex(sessionIndexPath = DEFAULT_SESSION_INDEX) {
  try {
    return await readCodexMetadata(sessionIndexPath, parseSessionIndex);
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
}

export function applySessionIndexTitles(rows, titleByThreadId) {
  return rows.map((row) => ({
    ...row,
    thread_name: row.name || titleByThreadId.get(String(row.id || '')) || row.thread_name,
    in_codex_sidebar: titleByThreadId.has(String(row.id || '')),
  }));
}

export function parseCodexPinnedThreadIds(globalState = {}) {
  const rawIds = Array.isArray(globalState?.[CODEX_PINNED_THREAD_IDS_KEY])
    ? globalState[CODEX_PINNED_THREAD_IDS_KEY]
    : [];
  const seen = new Set();
  const threadIds = [];

  for (const rawId of rawIds) {
    if (typeof rawId !== 'string') continue;
    const threadId = rawId.trim();
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    threadIds.push(threadId);
  }

  return threadIds;
}

async function readCodexGlobalState(globalStatePath = DEFAULT_GLOBAL_STATE) {
  try {
    return await readCodexMetadata(globalStatePath, JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function readCodexMetadata(filePath, parse) {
  const signature = statSignature(await fs.stat(filePath));
  const cached = codexMetadataCache.get(filePath);
  if (cached && sameFileSignature(cached.signature, signature)) {
    codexCacheMetrics.metadataHits += 1;
    return cached.value;
  }
  codexCacheMetrics.metadataMisses += 1;
  const text = await fs.readFile(filePath, 'utf8');
  codexCacheMetrics.metadataBytesRead += Buffer.byteLength(text);
  const value = parse(text);
  rememberBounded(codexMetadataCache, filePath, { signature, value }, 32);
  return value;
}

export function invalidateCodexData({ filePath = '' } = {}) {
  if (filePath) codexMetadataCache.delete(filePath);
  else codexMetadataCache.clear();
}

export function codexNativeReadStatus(thread, globalState) {
  const unknown = { nativeUnread: null, readStatus: 'unknown' };
  if (!thread.creatorAccountId || !thread.creatorUserId) return unknown;
  if (!globalState || typeof globalState !== 'object') return unknown;
  let cached = codexNativeReadCache.get(globalState);
  if (!cached) {
    const state = globalState['electron-thread-read-state-v1'];
    const identities = state?.unreadByIdentity;
    const keys = identities ? Object.keys(identities) : [];
    const identity = state?.version === 1 && keys.length === 1 ? keys[0] : '';
    const unread = identity ? identities[identity]?.[CODEX_LOCAL_READ_HOST] : null;
    cached = { identity, unread: Array.isArray(unread)
      && !unread.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ? new Set(unread) : null };
    codexNativeReadCache.set(globalState, cached);
  }
  if (!cached.unread) return unknown;
  const creator = JSON.stringify(['chatgpt', thread.creatorAccountId, thread.creatorUserId]);
  let identity = codexCreatorIdentityCache.get(creator);
  if (!identity) {
    identity = createHash('sha256').update(creator).digest('hex');
    rememberBounded(codexCreatorIdentityCache, creator, identity, 32);
  }
  if (cached.identity !== identity) return unknown;
  const nativeUnread = cached.unread.has(thread.id);
  return { nativeUnread, readStatus: nativeUnread ? 'unread' : 'read' };
}

export function applyCodexPinnedThreadIds(rows, pinnedThreadIds = []) {
  const pinned = new Set(pinnedThreadIds.map(String));
  return rows.map((row) => ({
    ...row,
    pinned: row.is_pinned == null ? pinned.has(String(row.id || '')) : Boolean(Number(row.is_pinned)),
  }));
}

function readThreadsSql(cappedLimit, { includeGoals = true, columns = new Set() } = {}) {
  const desktopColumns = ['name', 'is_pinned', 'thread_source', 'originator', 'agent_path', 'creator_account_id', 'creator_user_id']
    .map((name) => columns.has(name) ? `threads.${name} as ${name}` : `null as ${name}`)
    .join(',\n      ');
  const goalColumns = includeGoals ? `
      tg.goal_id as goal_id,
      tg.status as goal_status,
      tg.token_budget as goal_token_budget,
      tg.tokens_used as goal_tokens_used,
      tg.time_used_seconds as goal_time_used_seconds,
      tg.created_at_ms as goal_created_at_ms,
      tg.updated_at_ms as goal_updated_at_ms` : `
      null as goal_id,
      null as goal_status,
      null as goal_token_budget,
      null as goal_tokens_used,
      null as goal_time_used_seconds,
      null as goal_created_at_ms,
      null as goal_updated_at_ms`;
  const goalJoin = includeGoals ? 'left join thread_goals tg on tg.thread_id = threads.id' : '';

  return `
    select
      threads.id as id,
      threads.rollout_path as rollout_path,
      threads.created_at as created_at,
      threads.updated_at as updated_at,
      threads.created_at_ms as created_at_ms,
      threads.updated_at_ms as updated_at_ms,
      threads.source as source,
      threads.model_provider as model_provider,
      threads.cwd as cwd,
      threads.title as title,
      threads.tokens_used as tokens_used,
      threads.archived as archived,
      threads.git_sha as git_sha,
      threads.git_branch as git_branch,
      threads.git_origin_url as git_origin_url,
      threads.agent_nickname as agent_nickname,
      threads.agent_role as agent_role,
      threads.model as model,
      threads.reasoning_effort as reasoning_effort,
      ${desktopColumns},
      ${goalColumns}
    from threads
    ${goalJoin}
    order by threads.updated_at_ms desc, threads.updated_at desc
    limit ${cappedLimit};
  `;
}

function isMissingThreadGoalsTable(error) {
  const text = `${error?.stderr || ''}\n${error?.message || ''}`;
  return text.includes('no such table: thread_goals');
}

export async function discoverCodexStateDatabase(codexDir = DEFAULT_CODEX_DIR) {
  const files = await fs.readdir(codexDir).catch(() => []);
  const latest = files.filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  return latest ? path.join(codexDir, latest) : path.join(codexDir, 'state_5.sqlite');
}

export async function readThreads({ databasePath, limit = DEFAULT_THREAD_LIMIT } = {}) {
  databasePath ||= await discoverCodexStateDatabase();
  const cappedLimit = safeLimit(limit);
  const columns = new Set((await querySqliteJson(databasePath, 'pragma table_info(threads);')).map((row) => row.name));
  const sql = readThreadsSql(cappedLimit, { includeGoals: true, columns });

  try {
    return await querySqliteJson(databasePath, sql);
  } catch (error) {
    if (isMissingThreadGoalsTable(error)) {
      return querySqliteJson(databasePath, readThreadsSql(cappedLimit, { includeGoals: false, columns }));
    }
    throw error;
  }
}

function threadRowUpdatedAtMs(row = {}) {
  const updatedAtMs = Number(row.updated_at_ms);
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) return updatedAtMs;

  const updatedAt = Number(row.updated_at);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 0;
  return updatedAt > 10_000_000_000 ? updatedAt : updatedAt * 1000;
}

function payloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .join('\n');
  }
  return '';
}

function cleanArtifactTarget(value = '') {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/^["'(<]+|[>"')\],.;!?，。；！）】》]+$/g, '');
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the source text if it is not URL encoded.
  }
  return text.trim();
}

function localArtifactPath(value = '') {
  const cleaned = cleanArtifactTarget(value);
  if (cleaned.startsWith('//')) return '';

  const text = cleaned
    .replace(/^file:\/+/, '/')
    .replace(/\\/g, '/')
    .split(/[?#]/)[0];
  return /^(?:~\/|\/|[A-Za-z]:\/)/.test(text) ? text : '';
}

function artifactExtension(value = '') {
  const cleanValue = cleanArtifactTarget(value).split(/[?#]/)[0];
  const match = cleanValue.match(/\.([A-Za-z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : '';
}

function artifactFileName(value = '') {
  const cleanValue = cleanArtifactTarget(value)
    .replace(/^file:\/+/, '/')
    .replace(/\\/g, '/')
    .split(/[?#]/)[0];
  const fileName = path.posix.basename(cleanValue);
  return artifactExtension(fileName) ? fileName : '';
}

function extractLocalArtifactTargets(text = '') {
  const items = [];
  const add = (name, rawPath) => {
    const artifactPath = localArtifactPath(rawPath || name);
    const title = artifactFileName(name) || artifactFileName(artifactPath);
    if (!artifactPath || !title) return;
    items.push({ path: artifactPath, title });
  };

  const fileHeadingPattern = /##\s+([^:\n#]+?\.[A-Za-z0-9]{1,12})\s*:\s*((?:file:\/\/|~\/|\/|[A-Za-z]:[\\/])[^#\n\r]*?)(?=(?:\s+##\s)|(?:\s+#\s)|\n|$)/g;
  for (const match of text.matchAll(fileHeadingPattern)) {
    add(match[1], match[2]);
  }

  const imagePathPattern = /<image\b[^>]*\bpath=(["'])(.*?)\1[^>]*>/gi;
  for (const match of text.matchAll(imagePathPattern)) {
    add('', match[2]);
  }

  const standalonePathPattern = new RegExp(
    `(?:^|[\\s(["'\`:：])((?:file:\\/\\/|~\\/|\\/|[A-Za-z]:[\\\\/])[^"'\`<>\\n\\r]*?\\.(?:${LOCAL_ARTIFACT_EXTENSION_RE}))(?=$|[\\s)"'\`<>，。；,;!?])`,
    'gi',
  );
  for (const match of text.matchAll(standalonePathPattern)) {
    add('', match[1]);
  }

  return items;
}

function compactInlineText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function stripCodexRichMessageScaffold(value = '') {
  return String(value || '')
    .replace(/<image\b[\s\S]*?<\/image>/gi, ' ')
    .replace(/<image\b[^>]*>/gi, ' ')
    .replace(/<\/image>/gi, ' ')
    .replace(/^#\s+Files mentioned by the user:\s*$/gim, ' ')
    .replace(/^##\s+[^:\n#]+?\.[A-Za-z0-9]{1,12}\s*:\s*(?:file:\/\/|~\/|\/|[A-Za-z]:[\\/]).*$/gim, ' ')
    .replace(/^##\s+My request for Codex:\s*$/gim, ' ');
}

function truncateText(value = '', maxLength = 500) {
  const text = compactInlineText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isMeaningfulUserMessage(value = '') {
  const text = compactInlineText(value);
  if (text.length < 8) return false;
  return !LOW_SIGNAL_USER_MESSAGE.test(text);
}

function eventTimestampMs(event) {
  const timestamp = Date.parse(event?.timestamp || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getCodexCacheStats() {
  return {
    rolloutSignals: {
      entries: rolloutSignalCache.size,
      limit: rolloutSignalCacheLimit,
      hits: codexCacheMetrics.rolloutSignalHits,
      misses: codexCacheMetrics.rolloutSignalMisses,
      writes: codexCacheMetrics.rolloutSignalWrites,
      evictions: codexCacheMetrics.rolloutSignalEvictions,
      bytesRead: codexCacheMetrics.rolloutSignalBytesRead,
      lifecycleBytesRead: codexCacheMetrics.lifecycleBytesRead,
      lifecycleHits: codexCacheMetrics.lifecycleHits,
    },
    metadata: {
      entries: codexMetadataCache.size,
      hits: codexCacheMetrics.metadataHits,
      misses: codexCacheMetrics.metadataMisses,
      bytesRead: codexCacheMetrics.metadataBytesRead,
    },
  };
}

async function mapSettledWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    items.length,
    Math.max(1, Number.parseInt(concurrency, 10) || 1),
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function emptyRolloutLifecycle() {
  return {
    agentRunning: null,
    agentStartedAtMs: null,
    agentActivityAtMs: null,
    latestLifecycleAtMs: null,
    latestLifecycleKind: '',
    latestTaskStartedAtMs: 0,
    latestTaskEndedAtMs: 0,
    latestTaskEndKind: '',
  };
}

function applyRolloutLifecycleEvent(lifecycle, payload, timestampMs) {
  const eventType = payload?.type;
  if (eventType === 'task_started') {
    lifecycle.agentRunning = true;
    lifecycle.agentStartedAtMs = timestampMs || null;
    lifecycle.agentActivityAtMs = timestampMs || lifecycle.agentActivityAtMs;
    lifecycle.latestLifecycleAtMs = timestampMs || lifecycle.latestLifecycleAtMs;
    lifecycle.latestLifecycleKind = eventType;
    lifecycle.latestTaskStartedAtMs = timestampMs || lifecycle.latestTaskStartedAtMs;
    return;
  }

  if (['task_complete', 'turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled'].includes(eventType)) {
    lifecycle.agentRunning = false;
    lifecycle.agentStartedAtMs = null;
    lifecycle.agentActivityAtMs = timestampMs || lifecycle.agentActivityAtMs;
    lifecycle.latestLifecycleAtMs = timestampMs || lifecycle.latestLifecycleAtMs;
    lifecycle.latestLifecycleKind = eventType === 'task_complete' && payload.error != null ? 'failed' : eventType;
    lifecycle.latestTaskEndedAtMs = timestampMs || lifecycle.latestTaskEndedAtMs;
    lifecycle.latestTaskEndKind = lifecycle.latestLifecycleKind;
  }
}

function finalizeRolloutLifecycle(signals) {
  if (signals.agentRunning === true) {
    signals.agentActivityAtMs = Math.max(
      Number(signals.agentStartedAtMs || 0),
      Number(signals.agentActivityAtMs || 0),
      Number(signals.latestEventAtMs || 0),
    ) || null;
  }
  return signals;
}

function questionSignals(questions) {
  return {
    awaitingUserInput: questions.size > 0,
    userQuestionBlocking: [...questions.values()].some((question) => !question.async),
    latestUserQuestionAtMs: Math.max(0, ...[...questions.values()].map((question) => question.atMs)),
    latestBlockingQuestionAtMs: Math.max(0, ...[...questions.values()].filter((question) => !question.async).map((question) => question.atMs)),
  };
}

function applyUserQuestionEvent(questions, payload, atMs = 0) {
  if (['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled'].includes(payload?.type)
    || (payload?.type === 'task_complete' && payload.error != null)) {
    questions.clear();
    return true;
  }
  if (payload?.type === 'function_call' && /^(?:functions\.)?request_user_input(?:_async)?$/.test(payload.name || '') && typeof payload.call_id === 'string' && payload.call_id) {
    try {
      const args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments;
      if (Array.isArray(args?.questions) && args.questions.length && !questions.has(payload.call_id)) {
        questions.set(payload.call_id, { async: payload.name.endsWith('_async'), atMs, remaining: new Set(args.questions.map((_, index) => index)) });
      }
    } catch { /* Invalid calls are not proof of a pending question. */ }
  } else if (payload?.type === 'function_call_output' && questions.has(payload.call_id)) {
    const question = questions.get(payload.call_id);
    let result;
    try { result = typeof payload.output === 'string' ? JSON.parse(payload.output) : payload.output; } catch { result = null; }
    if (!question.async || result?.accepted !== true || result.error) questions.delete(payload.call_id);
  } else if (payload?.type === 'user_message' || (payload?.type === 'message' && payload.role === 'user')) {
    const text = payloadText(payload);
    const replies = [...text.matchAll(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/g)];
    const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
    if (!replies.length) {
      const internalGoal = (Array.isArray(kinds) && kinds.length && kinds.every((kind) =>
        kind === 'goal.internal_context' || kind === 'additional_content.codex_apps_open_page'))
        || /^\s*<codex_internal_context\b/.test(text);
      const humanText = text.replace(/<(codex_internal_context|environment_context|turn_context|user_instructions|instructions|system-reminder|external_codex_apps_open_page)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
      if (!internalGoal && (/<image\b/i.test(humanText) || stripCodexRichMessageScaffold(humanText).trim()
        || extractLocalArtifactTargets(humanText).length)) {
        questions.clear();
        return true;
      }
      return;
    }
    for (const match of replies) {
      try {
        const replies = JSON.parse(match[1]);
        if (!Array.isArray(replies)) continue;
        for (const reply of replies) {
          const [name, callId, index] = JSON.parse(reply.questionItemId);
          const question = questions.get(callId);
          if (name !== 'request_user_input_async' || !question?.async || !Number.isInteger(index)) continue;
          question.remaining.delete(index);
          if (!question.remaining.size) questions.delete(callId);
        }
      } catch { /* Ignore malformed replies. */ }
    }
  }
}

export function parseRolloutSignals(jsonlText) {
  const questions = new Map();
  const signals = {
    completionHint: false,
    latestAgentFinalAtMs: null,
    latestUserMessageAtMs: null,
    latestMessageKind: '',
    firstUserMessage: '',
    latestUserMessage: '',
    latestMeaningfulUserMessage: '',
    lastAgentMessage: '',
    ...emptyRolloutLifecycle(),
    latestEventAtMs: null,
  };

  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    const payload = event.payload || event;
    const timestampMs = eventTimestampMs(event);
    if (timestampMs) signals.latestEventAtMs = Math.max(signals.latestEventAtMs || 0, timestampMs);

    applyRolloutLifecycleEvent(signals, payload, timestampMs);
    if (applyUserQuestionEvent(questions, payload, timestampMs)) signals[QUESTION_HISTORY_COMPLETE] = true;

    if (payload?.type === 'agent_message') {
      const text = payloadText(payload);
      if (text) signals.lastAgentMessage = text.slice(0, 500);
      if (payload.phase === 'final_answer' || COMPLETION_HINT.test(text)) {
        signals.completionHint = true;
      }
      if (payload.phase === 'final_answer') {
        signals.latestAgentFinalAtMs = timestampMs || signals.latestAgentFinalAtMs;
        signals.latestMessageKind = 'agent';
      } else if (text) {
        signals.latestMessageKind = 'agent';
      }
      continue;
    }

    if (payload?.type === 'user_message') {
      const text = payloadText(payload);
      if (text) {
        const compactText = truncateText(text);
        signals.firstUserMessage ||= compactText;
        signals.latestUserMessage = compactText;
        if (isMeaningfulUserMessage(text)) {
          signals.latestMeaningfulUserMessage = compactText;
        }
      }
      signals.latestUserMessageAtMs = timestampMs || signals.latestUserMessageAtMs;
      signals.latestMessageKind = 'user';
    }
  }

  Object.assign(signals, questionSignals(questions));
  return finalizeRolloutLifecycle(signals);
}

async function scanRolloutLifecycle(rolloutPath, stat, cacheLimit) {
  const cached = rolloutActivityCache.get(rolloutPath);
  const append = cached && cached.ino === stat.ino && cached.dev === stat.dev && stat.size >= cached.size
    && (stat.size > cached.size || (stat.mtimeMs === cached.mtimeMs && stat.ctimeMs === cached.ctimeMs));
  const lifecycle = append ? cached.lifecycle : emptyRolloutLifecycle();
  const questions = append ? cached.questions : new Map();
  const start = append ? cached.offset : 0;
  if (start === stat.size) {
    codexCacheMetrics.lifecycleHits += 1;
    return { ...lifecycle, ...questionSignals(questions) };
  }
  codexCacheMetrics.lifecycleBytesRead += stat.size - start;
  const input = createReadStream(rolloutPath, { encoding: 'utf8', start, end: stat.size - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lastLine = '', suffix = '';
  input.on('data', (chunk) => { suffix = chunk.slice(-2); });

  try {
    for await (const line of lines) {
      lastLine = line;
      if (!ROLLOUT_LIFECYCLE_EVENT_RE.test(line) && !/request_user_input|function_call_output|send_user_message_question_reply|"type"\s*:\s*"user_message"|"role"\s*:\s*"user"/.test(line)) continue;

      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object') continue;
        const payload = event.payload || event;
        applyRolloutLifecycleEvent(lifecycle, payload, eventTimestampMs(event));
        applyUserQuestionEvent(questions, payload, eventTimestampMs(event));
      } catch {
        // Ignore partial/corrupt lines, consistent with the main rollout parser.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  const offset = /[\r\n]$/.test(suffix) ? stat.size : stat.size - Buffer.byteLength(lastLine);
  rememberBounded(rolloutActivityCache, rolloutPath, { ...statSignature(stat), offset, lifecycle, questions }, cacheLimit);
  return { ...lifecycle, ...questionSignals(questions) };
}

export async function readTail(filePath, maxBytes = DEFAULT_MAX_ROLLOUT_BYTES, fileStat = null) {
  const stat = fileStat || await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const handle = await fs.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return { text, start, size: stat.size, bytesRead };

    const firstNewline = text.indexOf('\n');
    return {
      text: firstNewline >= 0 ? text.slice(firstNewline + 1) : text,
      start,
      size: stat.size,
      bytesRead,
    };
  } finally {
    await handle.close();
  }
}

function hasTurnBoundary(signals) {
  return Boolean(signals.latestUserMessageAtMs || signals.latestAgentFinalAtMs);
}

export async function readRolloutSignals(
  rolloutPath,
  {
    initialBytes = DEFAULT_INITIAL_ROLLOUT_BYTES,
    maxBytes = DEFAULT_MAX_ROLLOUT_BYTES,
    signalCacheLimit = DEFAULT_THREAD_LIMIT,
  } = {},
) {
  if (!rolloutPath) return parseRolloutSignals('');

  try {
    const stat = await fs.stat(rolloutPath);
    const signature = statSignature(stat);
    const cacheLimit = Math.min(DEFAULT_THREAD_LIMIT, Math.max(0, Number(signalCacheLimit) || 0));
    rolloutSignalCacheLimit = cacheLimit;
    const cacheKey = `${rolloutPath}\0${initialBytes}\0${maxBytes}`;
    const cached = rolloutSignalCache.get(cacheKey);
    if (cached && sameFileSignature(cached.signature, signature)) {
      codexCacheMetrics.rolloutSignalHits += 1;
      return cached.signals;
    }
    codexCacheMetrics.rolloutSignalMisses += 1;

    let bytesToRead = Math.min(Math.max(1, initialBytes), maxBytes, stat.size);
    let signals = parseRolloutSignals('');
    let tailStart = 0;
    while (bytesToRead > 0) {
      const tail = await readTail(rolloutPath, bytesToRead, stat);
      tailStart = tail.start;
      codexCacheMetrics.rolloutSignalBytesRead += tail.bytesRead;
      signals = parseRolloutSignals(tail.text);
      if (hasTurnBoundary(signals) || bytesToRead >= stat.size || bytesToRead >= maxBytes) break;
      const nextBytes = Math.min(bytesToRead * 2, maxBytes, stat.size);
      if (nextBytes === bytesToRead) break;
      bytesToRead = nextBytes;
    }
    // A human message or an abort clears all earlier questions. Otherwise keep the full history scan.
    if (tailStart > 0 && !(signals.agentRunning !== null && signals[QUESTION_HISTORY_COMPLETE])) {
      const activity = await scanRolloutLifecycle(rolloutPath, stat, cacheLimit);
      signals = finalizeRolloutLifecycle({ ...signals, ...(signals.agentRunning === null ? activity : {}),
        awaitingUserInput: activity.awaitingUserInput, userQuestionBlocking: activity.userQuestionBlocking,
        latestUserQuestionAtMs: activity.latestUserQuestionAtMs, latestBlockingQuestionAtMs: activity.latestBlockingQuestionAtMs });
    }
    delete signals[QUESTION_HISTORY_COMPLETE];
    rememberBounded(rolloutSignalCache, cacheKey, { signature, signals }, cacheLimit,
      codexCacheMetrics, 'rolloutSignalWrites', 'rolloutSignalEvictions');
    return signals;
  } catch {
    return parseRolloutSignals('');
  }
}

async function attachRolloutSignals(threads, {
  maxRollouts = DEFAULT_THREAD_LIMIT,
  signalCacheLimit = DEFAULT_THREAD_LIMIT,
  rolloutThreadFilter = () => true,
  initialRolloutBytes = DEFAULT_INITIAL_ROLLOUT_BYTES,
  maxRolloutBytes = DEFAULT_MAX_ROLLOUT_BYTES,
} = {}) {
  const enriched = threads.map((thread) => ({ ...thread }));
  const linkedIds = new Set(normalizeDashboardThreads(enriched)
    .filter(rolloutThreadFilter).flatMap((thread) => thread.descendantThreadIds));
  const candidates = enriched
    .filter((thread) => thread.rolloutPath && (rolloutThreadFilter(thread) || (!thread.archived && linkedIds.has(thread.id))))
    .slice(0, maxRollouts);

  const results = await mapSettledWithConcurrency(
    candidates,
    ROLLOUT_SIGNAL_CONCURRENCY,
    (thread) => readRolloutSignals(thread.rolloutPath, {
      initialBytes: initialRolloutBytes,
      maxBytes: maxRolloutBytes,
      signalCacheLimit,
    }),
  );

  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;

    const thread = candidates[index];
    thread.completionHint = result.value.completionHint;
    thread.latestAgentFinalAtMs = result.value.latestAgentFinalAtMs;
    thread.latestUserMessageAtMs = result.value.latestUserMessageAtMs;
    thread.latestMessageKind = result.value.latestMessageKind;
    thread.firstUserMessage = result.value.firstUserMessage;
    thread.latestUserMessage = result.value.latestUserMessage;
    thread.latestMeaningfulUserMessage = result.value.latestMeaningfulUserMessage;
    thread.lastAgentMessage = result.value.lastAgentMessage;
    thread.latestLifecycleAtMs = result.value.latestLifecycleAtMs;
    thread.latestLifecycleKind = result.value.latestLifecycleKind;
    thread.latestTaskStartedAtMs = result.value.latestTaskStartedAtMs;
    thread.latestTaskEndedAtMs = result.value.latestTaskEndedAtMs;
    thread.latestTaskEndKind = result.value.latestTaskEndKind;
    thread.awaitingUserInput = Boolean(result.value.awaitingUserInput);
    thread.userQuestionBlocking = Boolean(result.value.userQuestionBlocking);
    thread.latestUserQuestionAtMs = Number(result.value.latestUserQuestionAtMs || 0);
    thread.latestBlockingQuestionAtMs = Number(result.value.latestBlockingQuestionAtMs || 0);
    thread.lifecycleRunning = result.value.agentRunning;
    if (result.value.agentRunning === true) {
      thread.agentRunning = true;
      thread.agentStartedAtMs = result.value.agentStartedAtMs;
      thread.agentActivityAtMs = result.value.agentActivityAtMs;
    } else if (result.value.agentRunning === false && !thread.activeGoal) {
      thread.agentRunning = false;
      thread.agentStartedAtMs = null;
      thread.agentActivityAtMs = result.value.agentActivityAtMs;
    }
  });

  return enriched;
}

// Callers can pass old dashboard options (asbMode, maxOrphanRollouts, and so on). They have no effect.
export async function loadCodexDashboard(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const rows = await readThreads(options);
  const sessionIndex = await readSessionIndex(options.sessionIndexPath || DEFAULT_SESSION_INDEX);
  const globalState = await readCodexGlobalState(options.globalStatePath || DEFAULT_GLOBAL_STATE).catch(() => ({}));
  const pinnedThreadIds = parseCodexPinnedThreadIds(globalState);
  const indexedRows = applySessionIndexTitles(rows
    .sort((a, b) => threadRowUpdatedAtMs(b) - threadRowUpdatedAtMs(a)), sessionIndex);
  const pinnedRows = applyCodexPinnedThreadIds(indexedRows, pinnedThreadIds);
  const threads = enrichThreads(pinnedRows, nowMs);
  if (options.codexNativeReadEnabled) {
    for (const thread of threads) Object.assign(thread, codexNativeReadStatus(thread, globalState));
  }
  return { generatedAtMs: nowMs, threads: await attachRolloutSignals(threads, options) };
}
