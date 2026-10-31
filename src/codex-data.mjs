import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { rememberBounded, sameFileSignature, SourceCache, statSignature } from './data-cache.mjs';
import { enrichThreads, threadTree } from './insights.mjs';

const execFileAsync = promisify(execFile);
const nativeSqlite = import('node:sqlite').catch(() => null);
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_SESSION_INDEX = path.join(DEFAULT_CODEX_DIR, 'session_index.jsonl');
const DEFAULT_GLOBAL_STATE = path.join(DEFAULT_CODEX_DIR, '.codex-global-state.json');
const CODEX_LOCAL_READ_HOST = `local:${createHash('sha256').update(JSON.stringify(['local', 'local', null])).digest('hex')}`;
const DEFAULT_THREAD_LIMIT = 5000;
// A stored title can hold a whole prompt. A row shows 300 characters (TITLE_LIMIT in switchboard.mjs); one more shows that the title was cut.
const TITLE_READ_CHARS = 301;
const DEFAULT_INITIAL_ROLLOUT_BYTES = 512 * 1024;
const DEFAULT_MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const ROLLOUT_SIGNAL_CONCURRENCY = 6;
const ROLLOUT_LIFECYCLE_EVENT_RE = /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|turn_cancelled|task_cancelled|cancelled)"/;
// A token_count line with a usage window. Lines without one cannot change the window record of a scan, so they are not parsed.
const ROLLOUT_LIMIT_WINDOW_RE = /"used_percent"\s*:\s*-?\d/;
// Entries that are not activity. The app writes `thread_settings_applied` when a chat opens, with no turn, and Codex moves
// threads.updated_at with it. The meta and context records are also not a turn: a turn has its own start and end entries.
const ROLLOUT_NO_TURN_ENTRIES = new Set(['thread_settings_applied', 'session_meta', 'turn_context']);
// Codex refused at 94-98 percent in the observed logs. A window below this level cannot explain a stop.
const LIMIT_STOP_USED_PERCENT = 90;
const QUESTION_HISTORY_COMPLETE = Symbol('question history complete');
const ROLLOUT_UNREADABLE = Symbol('rollout log cannot be read');
const ROLLOUT_UNREADABLE_MESSAGE = 'ASB cannot read the Codex session logs, so Codex cards show Unknown.';
const ROLLOUT_SCAN_CHUNK_BYTES = 1024 * 1024;
const ROLLOUT_SCAN_OVERLAP_BYTES = 256;
// The line breaks of node:readline, without the line feed that the scan splits on first.
const ROLLOUT_LINE_BREAK_RE = /[\r\u2028\u2029]/;
const QUESTION_CALL_NEEDLE = Buffer.from('request_user_input');
const QUESTION_CALL_PREFIX_BYTES = 128;
// shortcut: a "name" key written with JSON escapes is not found, upgrade if a Codex writer emits one. Whitespace that fills the window counts as a hit.
const QUESTION_CALL_PREFIX_RE = /(?:"name"\s*:|[\s:]{100})\s*"(?:functions\.)?$/;
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
const rolloutSignalCache = new SourceCache(DEFAULT_THREAD_LIMIT);
const rolloutActivityCache = new SourceCache(DEFAULT_THREAD_LIMIT);
const codexMetadataCache = new SourceCache(32);
const bridgeMessageCache = new SourceCache(DEFAULT_THREAD_LIMIT);
// The last thread query result of each state database, with its file signature and limit.
const threadQueryCache = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRIDGE_DELIVERED_STATUSES = new Set(['accepted', 'started', 'steered']);
export const SESSION_MESSAGE_WINDOW_MS = 2 * 60 * 1000;
const codexNativeReadCache = new WeakMap();
const codexCreatorIdentityCache = new Map();
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

// `native` and `run` are for tests: they cannot unload node:sqlite or run a real sqlite3.
export async function querySqliteJson(databasePath, sql, { native = nativeSqlite, run = execFileAsync } = {}) {
  const sqlite = await native;
  if (sqlite?.DatabaseSync) {
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  }
  // `-init` with the null device skips ~/.sqliterc, which can print text that is not JSON.
  const { stdout } = await run('sqlite3', ['-init', os.devNull, '-readonly', '-json', databasePath, sql], {
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

async function readSessionIndex(sessionIndexPath = DEFAULT_SESSION_INDEX, cacheScope = '') {
  try {
    return await readCodexMetadata(sessionIndexPath, parseSessionIndex, cacheScope);
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
}

// The keys of the Codex global state that ASB reads (`codexNativeReadStatus`). The file has about 1 MB and 46 keys: the cache keeps only these.
// A reader of a new key must add its name here: the test of this list reads the keys of the reader.
export const CODEX_GLOBAL_STATE_KEYS = ['electron-thread-read-state-v1'];

// Not an object (for example `null`): the value stays, so the reader sees the same as before.
export function parseCodexGlobalState(text) {
  const state = JSON.parse(text);
  if (!state || typeof state !== 'object') return state;
  return Object.fromEntries(CODEX_GLOBAL_STATE_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
}

export async function readCodexGlobalState(globalStatePath = DEFAULT_GLOBAL_STATE, cacheScope = '') {
  try {
    return await readCodexMetadata(globalStatePath, parseCodexGlobalState, cacheScope);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function readCodexMetadata(filePath, parse, cacheScope) {
  const signature = statSignature(await fs.stat(filePath));
  const cached = codexMetadataCache.get(filePath, cacheScope);
  if (cached && sameFileSignature(cached.signature, signature)) {
    codexCacheMetrics.metadataHits += 1;
    return cached.value;
  }
  codexCacheMetrics.metadataMisses += 1;
  const text = await fs.readFile(filePath, 'utf8');
  codexCacheMetrics.metadataBytesRead += Buffer.byteLength(text);
  const value = parse(text);
  codexMetadataCache.remember(filePath, { signature, value }, cacheScope);
  return value;
}

export function invalidateCodexData({ filePath = '' } = {}) {
  for (const [key, cached] of rolloutSignalCache) {
    if (!filePath || key.startsWith(`${filePath}\0`) || key.startsWith(`${filePath}${path.sep}`)) cached.invalidated = true;
  }
  for (const cache of [codexMetadataCache, bridgeMessageCache]) {
    if (filePath) cache.delete(filePath);
    else cache.clear();
  }
  if (filePath) threadQueryCache.delete(filePath.replace(/-wal$/, ''));
  else threadQueryCache.clear();
}

export function retainCodexDataScopes(scopes) {
  for (const cache of [rolloutSignalCache, rolloutActivityCache, codexMetadataCache, bridgeMessageCache]) cache.retainScopes(scopes);
}

function sameBridgeSignature(a, b) {
  return sameFileSignature(a.main, b.main) && (a.wal && b.wal ? sameFileSignature(a.wal, b.wal) : a.wal === b.wal);
}

// The receiver view of ASB Bridge: one database for each receiving Codex thread. The message text is never selected.
async function readBridgeFile(filePath, to, sinceMs, cacheScope) {
  const [main, wal] = await Promise.all([fs.stat(filePath), fs.stat(`${filePath}-wal`).catch(() => null)]);
  if (Math.max(main.mtimeMs, wal?.mtimeMs || 0) < sinceMs) return [];
  // A WAL append does not change the main file.
  const signature = { main: statSignature(main), wal: wal ? statSignature(wal) : null };
  const since = Math.floor(sinceMs / 1000);
  const cached = bridgeMessageCache.get(filePath, cacheScope);
  if (cached && sameBridgeSignature(cached.signature, signature) && since >= cached.since) {
    return cached.messages.filter((message) => message.atMs >= since * 1000);
  }
  const columns = new Set((await querySqliteJson(filePath, 'pragma table_info(messages);')).map((row) => row.name));
  let messages = [];
  if (['peer_id', 'direction', 'status', 'created_at'].every((name) => columns.has(name))) {
    const hasKind = columns.has('kind');
    const rows = await querySqliteJson(filePath, `select peer_id, status, created_at${hasKind ? ', kind' : ''}
      from messages where direction = 'in' and created_at >= ${since};`);
    messages = rows.filter((row) => BRIDGE_DELIVERED_STATUSES.has(row.status) && (!hasKind || row.kind === 'message')
      && typeof row.peer_id === 'string' && UUID_RE.test(row.peer_id) && Number.isFinite(Number(row.created_at)))
      .map((row) => ({ to, from: row.peer_id, atMs: Number(row.created_at) * 1000 }));
  }
  bridgeMessageCache.remember(filePath, { signature, since, messages }, cacheScope);
  return messages;
}

export async function readBridgeMessages(codexDir, sinceMs, cacheScope = '') {
  const directory = path.join(codexDir, 'plugin-state', 'asb-bridge');
  const names = await fs.readdir(directory).catch(() => []);
  const results = await Promise.all(names.map((name) => {
    const to = name.endsWith('.sqlite') ? name.slice(0, -'.sqlite'.length) : '';
    if (!UUID_RE.test(to)) return [];
    // A read error on one database skips only that database.
    return readBridgeFile(path.join(directory, name), to, sinceMs, cacheScope).catch(() => []);
  }));
  return results.flat();
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

function readThreadsSql(cappedLimit, { includeGoals = true, columns = new Set() } = {}) {
  // A column that a Codex migration dropped reads as null, so the scan survives the change.
  const threadColumns = ['rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'source',
    'model_provider', 'cwd', 'title', 'tokens_used', 'archived', 'git_sha', 'git_branch', 'git_origin_url',
    'agent_nickname', 'agent_role', 'model', 'reasoning_effort',
    'name', 'thread_source', 'originator', 'agent_path', 'creator_account_id', 'creator_user_id']
    .map((name) => !columns.has(name) ? `null as ${name}`
      : name === 'title' ? `substr(threads.title, 1, ${TITLE_READ_CHARS}) as title` : `threads.${name} as ${name}`)
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
      ${threadColumns},
      ${goalColumns}
    from threads
    ${goalJoin}
    order by updated_at_ms desc, updated_at desc
    limit ${cappedLimit};
  `;
}

export async function discoverCodexStateDatabase(codexDir = DEFAULT_CODEX_DIR) {
  const files = await fs.readdir(codexDir).catch(() => []);
  const latest = files.filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  return latest ? path.join(codexDir, latest) : path.join(codexDir, 'state_5.sqlite');
}

// The signature of the database and its WAL file, or '' while a file changed in the last second:
// a later write in the same timestamp can keep the same size and time (the racy index case).
async function threadDatabaseSignature(databasePath) {
  const files = await Promise.all([fs.stat(databasePath), fs.stat(`${databasePath}-wal`).catch(() => null)]);
  const statAtMs = Date.now();
  if (files.some((info) => info && !(statAtMs - info.mtimeMs > 1_000))) return '';
  return JSON.stringify(files.map((info) => info && [info.dev, info.ino, info.size, info.mtimeMs]));
}

// The rows of the kept result. The list and the rows belong to the cache and are frozen: a write to them fails at once.
export async function readThreadRows({ databasePath, limit = DEFAULT_THREAD_LIMIT } = {}) {
  databasePath ||= await discoverCodexStateDatabase();
  const cappedLimit = safeLimit(limit);
  // The stat comes before the queries, so a write during the queries changes the next signature.
  const signature = await threadDatabaseSignature(databasePath);
  const kept = threadQueryCache.get(databasePath);
  if (signature && kept?.signature === signature && kept.limit === cappedLimit) return kept.rows;
  const columns = new Set((await querySqliteJson(databasePath, 'pragma table_info(threads);')).map((row) => row.name));
  const sql = readThreadsSql(cappedLimit, { includeGoals: true, columns });

  let rows;
  try {
    rows = await querySqliteJson(databasePath, sql);
  } catch {
    // Codex can drop or change thread_goals; read the threads without goals, and report only that error.
    rows = await querySqliteJson(databasePath, readThreadsSql(cappedLimit, { includeGoals: false, columns }));
  }
  for (const row of rows) Object.freeze(row);
  Object.freeze(rows);
  threadQueryCache.set(databasePath, { signature, limit: cappedLimit, rows });
  return rows;
}

// Each caller gets its own row objects.
export async function readThreads(options) {
  return (await readThreadRows(options)).map((row) => ({ ...row }));
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

function stripCodexRichMessageScaffold(value = '') {
  return String(value || '')
    .replace(/<image\b[\s\S]*?<\/image>/gi, ' ')
    .replace(/<image\b[^>]*>/gi, ' ')
    .replace(/<\/image>/gi, ' ')
    .replace(/^#\s+Files mentioned by the user:\s*$/gim, ' ')
    .replace(/^##\s+[^:\n#]+?\.[A-Za-z0-9]{1,12}\s*:\s*(?:file:\/\/|~\/|\/|[A-Za-z]:[\\/]).*$/gim, ' ')
    .replace(/^##\s+My request for Codex:\s*$/gim, ' ');
}

function eventTimestampMs(event) {
  const timestamp = Date.parse(event?.timestamp || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getCodexCacheStats() {
  return {
    rolloutSignals: {
      entries: rolloutSignalCache.size,
      limit: rolloutSignalCache.limit,
      lifecycleEntries: rolloutActivityCache.size,
      lifecycleLimit: rolloutActivityCache.limit,
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
    // A usage limit stopped the latest turn.
    limitStopped: false,
    limitStoppedAtMs: 0,
    // The newest token_count with a window: its time and its windows as [usedPercent, resetsAtMs]. Codex can stop a turn before a window shows 100 percent.
    limitWindowAtMs: 0,
    limitWindows: [],
    limitResetsAtMs: 0,
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
    lifecycle.limitStopped = false;
    lifecycle.limitStoppedAtMs = 0;
    return;
  }

  if (eventType === 'token_count') {
    const windows = [payload.rate_limits?.primary, payload.rate_limits?.secondary].filter((window) => window && typeof window === 'object');
    if (windows.length) {
      lifecycle.limitWindowAtMs = timestampMs || 0;
      lifecycle.limitWindows = windows.map((window) => [Number(window.used_percent) || 0, Number(window.resets_at) * 1000 || 0]);
    }
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
    // Only the error kind is read, never the error message.
    lifecycle.limitStopped = eventType === 'task_complete' && payload.error?.codex_error_info === 'usage_limit_exceeded';
    lifecycle.limitStoppedAtMs = lifecycle.limitStopped ? timestampMs || 0 : 0;
  }
}

// The reset of the most-used window (on a tie the later reset) among the windows that reset after the stop and are near the refusal level, else 0.
function limitStopResetsAtMs(windows, stoppedAtMs) {
  return windows.filter(([used, resetsAtMs]) => used >= LIMIT_STOP_USED_PERCENT && resetsAtMs > stoppedAtMs)
    .reduce((best, item) => item[0] > best[0] || (item[0] === best[0] && item[1] > best[1]) ? item : best, [0, 0])[1];
}

function finalizeRolloutLifecycle(signals) {
  // Only an ended turn can be stopped by a usage limit. The window record must be at or before the stop.
  signals.limitResetsAtMs = signals.agentRunning === false && signals.limitStopped
    && signals.limitWindowAtMs && signals.limitWindowAtMs <= signals.limitStoppedAtMs
    ? limitStopResetsAtMs(signals.limitWindows || [], signals.limitStoppedAtMs) : 0;
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
    latestAgentFinalAtMs: null,
    latestUserMessageAtMs: null,
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
    if (timestampMs && !ROLLOUT_NO_TURN_ENTRIES.has(event.type) && !ROLLOUT_NO_TURN_ENTRIES.has(payload?.type)) {
      signals.latestEventAtMs = Math.max(signals.latestEventAtMs || 0, timestampMs);
    }

    applyRolloutLifecycleEvent(signals, payload, timestampMs);
    if (applyUserQuestionEvent(questions, payload, timestampMs)) signals[QUESTION_HISTORY_COMPLETE] = true;

    if (payload?.type === 'agent_message') {
      if (payload.phase === 'final_answer') signals.latestAgentFinalAtMs = timestampMs || signals.latestAgentFinalAtMs;
      continue;
    }

    if (payload?.type === 'user_message') {
      signals.latestUserMessageAtMs = timestampMs || signals.latestUserMessageAtMs;
    }
  }

  Object.assign(signals, questionSignals(questions));
  return finalizeRolloutLifecycle(signals);
}

// Returns where line processing must resume: the start of the line with the next question call, else of an unfinished last line, else `size`.
async function findQuestionCallLine(handle, buffer, start, size) {
  let lineStart = start, keep = 0;
  for (let pos = start; pos < size;) {
    const { bytesRead } = await handle.read(buffer, keep, Math.min(buffer.length - keep, size - pos), pos);
    if (!bytesRead) break;
    codexCacheMetrics.lifecycleBytesRead += bytesRead;
    const chunk = buffer.subarray(0, keep + bytesRead), base = pos - keep;
    for (let hit = chunk.indexOf(QUESTION_CALL_NEEDLE, Math.max(0, keep - QUESTION_CALL_NEEDLE.length + 1)); hit >= 0; hit = chunk.indexOf(QUESTION_CALL_NEEDLE, hit + 1)) {
      if (!QUESTION_CALL_PREFIX_RE.test(chunk.latin1Slice(Math.max(0, hit - QUESTION_CALL_PREFIX_BYTES), hit))) continue;
      const newline = chunk.lastIndexOf(10, hit);
      return newline < 0 ? lineStart : Math.max(lineStart, base + newline + 1);
    }
    const newline = chunk.lastIndexOf(10);
    if (newline >= 0) lineStart = Math.max(lineStart, base + newline + 1);
    pos += bytesRead;
    keep = Math.min(chunk.length, ROLLOUT_SCAN_OVERLAP_BYTES);
    buffer.copyWithin(0, chunk.length - keep, chunk.length);
  }
  return lineStart;
}

// Reader positions on disk (src/reader-positions.mjs). Only the engine sets them; without them the reader keeps all state in memory.
const ROLLOUT_POSITION_ID_RE = /^[A-Za-z0-9_:-]{1,160}$/;
const ROLLOUT_POSITION_KINDS = new Set(['', 'task_started', 'task_complete', 'turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed']);
const ROLLOUT_POSITION_KEYS = ['atMs', 'ctimeMs', 'dev', 'full', 'guard', 'guardBytes', 'ino', 'k', 'lifecycle', 'mtimeMs', 'offset', 'questions', 'size'].join();
const ROLLOUT_LIFECYCLE_NAMES = Object.keys(emptyRolloutLifecycle());
const ROLLOUT_LIFECYCLE_KEYS = [...ROLLOUT_LIFECYCLE_NAMES].sort().join();
// The other fields of the signals of a tail read: times and the open-question flags.
const ROLLOUT_TAIL_NAMES = ['awaitingUserInput', 'latestAgentFinalAtMs', 'latestBlockingQuestionAtMs', 'latestEventAtMs',
  'latestUserMessageAtMs', 'latestUserQuestionAtMs', 'userQuestionBlocking'];
const ROLLOUT_TAIL_KEYS = [...ROLLOUT_TAIL_NAMES].sort().join();
const ROLLOUT_TAIL_POSITION_KEYS = ['atMs', 'ctimeMs', 'dev', 'guard', 'guardBytes', 'ino', 'initialBytes', 'k', 'lifecycle', 'maxBytes',
  'mtimeMs', 'size', 'tail'].sort().join();
let rolloutPositions = null;
let rolloutTailPositions = null;

// `source` is { take(filePath) -> saved record or null, digest(bytes) -> hex }, or null to turn the positions off.
export function useRolloutPositions(source) {
  rolloutPositions = source;
}

// The same for the saved signals of unchanged logs.
export function useRolloutTailPositions(source) {
  rolloutTailPositions = source;
}

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const count = (value) => Number.isInteger(value) && value >= 0;

// The 13 lifecycle fields of a checkpoint or of a tail result: numbers, booleans, and fixed kinds.
function validRolloutLifecycle(life) {
  return Boolean(life) && typeof life === 'object' && Object.keys(life).sort().join() === ROLLOUT_LIFECYCLE_KEYS
    && [true, false, null].includes(life.agentRunning)
    && [life.agentStartedAtMs, life.agentActivityAtMs, life.latestLifecycleAtMs].every((value) => value === null || finiteNumber(value))
    && [life.latestTaskStartedAtMs, life.latestTaskEndedAtMs, life.limitStoppedAtMs, life.limitWindowAtMs, life.limitResetsAtMs].every(finiteNumber)
    && ROLLOUT_POSITION_KINDS.has(life.latestLifecycleKind) && ROLLOUT_POSITION_KINDS.has(life.latestTaskEndKind)
    && typeof life.limitStopped === 'boolean' && Array.isArray(life.limitWindows) && life.limitWindows.length <= 2
    && life.limitWindows.every((window) => Array.isArray(window) && window.length === 2 && window.every(finiteNumber));
}

// The checks of one saved record at save and at load: numbers, booleans, fixed kinds, and IDs, never text or paths.
// reader-positions.mjs checks `k`, `guard`, and `atMs`.
export function validRolloutRecord(record) {
  if (!record || typeof record !== 'object' || Object.keys(record).sort().join() !== ROLLOUT_POSITION_KEYS) return false;
  const { lifecycle: life, questions } = record;
  if (![record.dev, record.ino, record.size, record.offset, record.guardBytes].every(count) || record.offset > record.size
    || record.guardBytes !== Math.min(64, record.size) || !finiteNumber(record.mtimeMs) || !finiteNumber(record.ctimeMs)
    || typeof record.full !== 'boolean') return false;
  if (!validRolloutLifecycle(life)) return false;
  return Array.isArray(questions) && new Set(questions.map((question) => question?.[0])).size === questions.length
    && questions.every((question) => Array.isArray(question) && question.length === 4 && typeof question[0] === 'string'
      && ROLLOUT_POSITION_ID_RE.test(question[0]) && [0, 1].includes(question[1]) && finiteNumber(question[2])
      && Array.isArray(question[3]) && question[3].every(count));
}

// The lifecycle checkpoints that a new engine can resume from, as plain records with the raw guard bytes (memory only).
export function rolloutPositionRecords() {
  const records = [];
  for (const [filePath, entry] of rolloutActivityCache) {
    if (!Buffer.isBuffer(entry.guard) || !finiteNumber(entry.atMs)) continue;
    records.push([filePath, { atMs: entry.atMs, dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs, offset: entry.offset, guard: entry.guard, guardBytes: entry.guard.length, full: entry.full,
      lifecycle: { ...entry.lifecycle, limitWindows: entry.lifecycle.limitWindows.map((window) => [...window]) },
      questions: [...entry.questions].map(([id, question]) => [id, question.async ? 1 : 0, question.atMs, [...question.remaining]]) }]);
  }
  return records;
}

// The checks of one saved tail result: the lifecycle and the other fields of the signals, with no text. The record is used only for a log with
// the same file signature, the same tail limits, and the same guard bytes.
export function validRolloutTailRecord(record) {
  if (!record || typeof record !== 'object' || Object.keys(record).sort().join() !== ROLLOUT_TAIL_POSITION_KEYS) return false;
  const { lifecycle, tail } = record;
  if (![record.dev, record.ino, record.size, record.guardBytes, record.initialBytes, record.maxBytes].every(count) || record.size < 1
    || record.guardBytes !== Math.min(64, record.size) || !finiteNumber(record.mtimeMs) || !finiteNumber(record.ctimeMs)
    || !validRolloutLifecycle(lifecycle)) return false;
  return Boolean(tail) && typeof tail === 'object' && Object.keys(tail).sort().join() === ROLLOUT_TAIL_KEYS
    && [tail.latestAgentFinalAtMs, tail.latestUserMessageAtMs, tail.latestEventAtMs].every((value) => value === null || finiteNumber(value))
    && typeof tail.awaitingUserInput === 'boolean' && typeof tail.userQuestionBlocking === 'boolean'
    && finiteNumber(tail.latestUserQuestionAtMs) && finiteNumber(tail.latestBlockingQuestionAtMs);
}

// The tail results that a new engine can use again, as plain records with the raw guard bytes (memory only): one for each log, the newest.
export function rolloutTailRecords() {
  const newest = new Map();
  for (const [cacheKey, entry] of rolloutSignalCache) {
    if (!Buffer.isBuffer(entry.guard) || !finiteNumber(entry.atMs)) continue;
    const [filePath, initialBytes, maxBytes] = cacheKey.split('\0');
    if (newest.get(filePath)?.atMs >= entry.atMs) continue;
    const { signals, signature } = entry;
    newest.set(filePath, { atMs: entry.atMs, dev: signature.dev, ino: signature.ino, size: signature.size, mtimeMs: signature.mtimeMs,
      ctimeMs: signature.ctimeMs, guard: entry.guard, guardBytes: entry.guard.length, initialBytes: Number(initialBytes), maxBytes: Number(maxBytes),
      lifecycle: { ...Object.fromEntries(ROLLOUT_LIFECYCLE_NAMES.map((name) => [name, signals[name]])),
        limitWindows: (signals.limitWindows || []).map((window) => [...window]) },
      tail: Object.fromEntries(ROLLOUT_TAIL_NAMES.map((name) => [name, signals[name]])) });
  }
  return [...newest];
}

// The saved signals of a log with no tail result in memory, or null. The log must be the same file with the same size and times,
// the same tail limits, and the same last bytes. The result is new objects, so the cache entry never shares state with the record.
async function savedRolloutTail(rolloutPath, stat, initialBytes, maxBytes) {
  const record = rolloutTailPositions.take(rolloutPath);
  const now = statSignature(stat);
  if (!record || !validRolloutTailRecord(record) || record.initialBytes !== initialBytes || record.maxBytes !== maxBytes
    || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((name) => record[name] !== now[name])) return null;
  const guard = Buffer.alloc(record.guardBytes);
  const handle = await fs.open(rolloutPath, 'r');
  try {
    const { bytesRead } = await handle.read(guard, 0, guard.length, record.size - guard.length);
    codexCacheMetrics.rolloutSignalBytesRead += bytesRead;
    if (bytesRead !== guard.length || rolloutTailPositions.digest(guard) !== record.guard) return null;
  } finally {
    await handle.close();
  }
  return { guard, signals: { ...record.tail, ...record.lifecycle, limitWindows: record.lifecycle.limitWindows.map((window) => [...window]) } };
}

// A saved checkpoint for a file with no checkpoint in memory, after the full-read checks of the design (section 3, rules 2-6).
async function savedRolloutPosition(rolloutPath, stat) {
  const record = rolloutPositions.take(rolloutPath);
  const now = statSignature(stat);
  if (!record || !validRolloutRecord(record) || record.dev !== now.dev || record.ino !== now.ino || now.size < record.size
    || (now.size === record.size && (record.mtimeMs !== now.mtimeMs || record.ctimeMs !== now.ctimeMs))) return null;
  const guard = Buffer.alloc(record.guardBytes);
  const handle = await fs.open(rolloutPath, 'r');
  try {
    const { bytesRead } = await handle.read(guard, 0, guard.length, record.size - guard.length);
    codexCacheMetrics.lifecycleBytesRead += bytesRead;
    if (bytesRead !== guard.length || rolloutPositions.digest(guard) !== record.guard) return null;
  } finally {
    await handle.close();
  }
  return { size: record.size, mtimeMs: record.mtimeMs, dev: record.dev, ino: record.ino, ctimeMs: record.ctimeMs,
    offset: record.offset, lifecycle: { ...record.lifecycle }, full: record.full, atMs: Date.now(), guard,
    questions: new Map(record.questions.map(([id, async, atMs, remaining]) => [id, { async: async === 1, atMs, remaining: new Set(remaining) }])) };
}

async function scanRolloutLifecycle(rolloutPath, stat, cacheLimit, needLifecycle = true, cacheScope = '') {
  let cached = rolloutActivityCache.get(rolloutPath, cacheScope, cacheLimit);
  if (!cached && rolloutPositions) {
    cached = await savedRolloutPosition(rolloutPath, stat).catch(() => null);
    // A seed that is not read again stays in memory, so the next save keeps it.
    if (cached) rolloutActivityCache.remember(rolloutPath, cached, cacheScope, cacheLimit);
  }
  // A question-only checkpoint has no valid lifecycle, so a caller that needs the lifecycle scans again from the start.
  const append = cached && (cached.full || !needLifecycle) && cached.ino === stat.ino && cached.dev === stat.dev && stat.size >= cached.size
    && (stat.size > cached.size || (stat.mtimeMs === cached.mtimeMs && stat.ctimeMs === cached.ctimeMs));
  const full = needLifecycle || Boolean(append && cached.full);
  // Copies: a cache entry never changes after it is saved, so a save during a scan cannot get state past its offset.
  const lifecycle = append ? structuredClone(cached.lifecycle) : emptyRolloutLifecycle();
  const questions = append ? structuredClone(cached.questions) : new Map();
  const start = append ? cached.offset : 0;
  if (start === stat.size) {
    codexCacheMetrics.lifecycleHits += 1;
    return { ...lifecycle, ...questionSignals(questions) };
  }
  const applyLines = (text) => {
    for (const line of text.split(ROLLOUT_LINE_BREAK_RE)) {
      if (!ROLLOUT_LIFECYCLE_EVENT_RE.test(line) && !ROLLOUT_LIMIT_WINDOW_RE.test(line) && !/request_user_input|function_call_output|send_user_message_question_reply|"type"\s*:\s*"user_message"|"role"\s*:\s*"user"/.test(line)) continue;

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
  };
  const buffer = Buffer.allocUnsafe(Math.min(ROLLOUT_SCAN_CHUNK_BYTES, stat.size - start + ROLLOUT_SCAN_OVERLAP_BYTES));
  const partial = [];
  let guard = null;
  const handle = await fs.open(rolloutPath, 'r');

  try {
    for (let pos = start; pos < stat.size;) {
      // Only a real question call changes an empty question map, so the bytes before the next call need no line parsing.
      if (!full && !questions.size && !partial.length) pos = await findQuestionCallLine(handle, buffer, pos, stat.size);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - pos), pos);
      if (!bytesRead) break;
      codexCacheMetrics.lifecycleBytesRead += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      do {
        const newline = chunk.indexOf(10, from);
        if (newline < 0) {
          partial.push(Buffer.from(chunk.subarray(from)));
          from = bytesRead;
          break;
        }
        applyLines(partial.length ? Buffer.concat([...partial.splice(0), chunk.subarray(from, newline)]).toString() : chunk.toString('utf8', from, newline));
        from = newline + 1;
      } while (from < bytesRead && (full || questions.size));
      pos += from;
    }
    // The guard of a saved position: the bytes before the scanned size. Read only when the positions are on.
    if (rolloutPositions) {
      guard = Buffer.alloc(Math.min(64, stat.size));
      const { bytesRead } = await handle.read(guard, 0, guard.length, stat.size - guard.length);
      codexCacheMetrics.lifecycleBytesRead += bytesRead;
      if (bytesRead !== guard.length) guard = null;
    }
  } finally {
    await handle.close();
  }

  // The last line without a newline is applied now and read again after the next append.
  const lastLine = Buffer.concat(partial).toString();
  applyLines(lastLine);
  const pieces = lastLine.split(ROLLOUT_LINE_BREAK_RE);
  const offset = stat.size - (lastLine.endsWith('\r') ? 0 : Buffer.byteLength(pieces.at(-1) || pieces.at(-2) || ''));
  rolloutActivityCache.remember(rolloutPath, { ...statSignature(stat), offset, lifecycle, questions, full,
    ...(guard ? { atMs: Date.now(), guard } : {}) }, cacheScope, cacheLimit);
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
    // The last bytes of the file as read: the guard of a saved result (memory only).
    const guard = bytesRead === length ? Buffer.from(buffer.subarray(Math.max(0, bytesRead - 64), bytesRead)) : null;
    if (start === 0) return { text, start, size: stat.size, bytesRead, guard };

    const firstNewline = text.indexOf('\n');
    return {
      text: firstNewline >= 0 ? text.slice(firstNewline + 1) : text,
      start,
      size: stat.size,
      bytesRead,
      guard,
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
    cacheScope = '',
    fileScan = null,
  } = {},
) {
  if (!rolloutPath) return parseRolloutSignals('');

  try {
    const cacheLimit = Math.min(DEFAULT_THREAD_LIMIT, Math.max(0, Number(signalCacheLimit) || 0));
    const cacheKey = `${rolloutPath}\0${initialBytes}\0${maxBytes}`;
    const cached = rolloutSignalCache.get(cacheKey, cacheScope, cacheLimit);
    const reuse = cached && !cached.invalidated && fileScan?.canReuse(rolloutPath);
    if (cached && !reuse) cached.invalidated = true;
    const stat = reuse ? cached.signature : await fs.stat(rolloutPath);
    fileScan?.statusFiles?.set(rolloutPath, stat);
    const signature = statSignature(stat);
    if (cached && sameFileSignature(cached.signature, signature)) {
      cached.invalidated = false;
      rolloutActivityCache.get(rolloutPath, cacheScope, cacheLimit);
      codexCacheMetrics.rolloutSignalHits += 1;
      return cached.signals;
    }
    // With no result in memory, the saved result of an unchanged log is this result: no tail is read.
    const saved = !cached && rolloutTailPositions ? await savedRolloutTail(rolloutPath, stat, initialBytes, maxBytes).catch(() => null) : null;
    if (saved) {
      rolloutSignalCache.remember(cacheKey, { signature, signals: saved.signals, atMs: Date.now(), guard: saved.guard }, cacheScope, cacheLimit,
        codexCacheMetrics, 'rolloutSignalWrites', 'rolloutSignalEvictions');
      rolloutActivityCache.get(rolloutPath, cacheScope, cacheLimit);
      codexCacheMetrics.rolloutSignalHits += 1;
      return saved.signals;
    }
    codexCacheMetrics.rolloutSignalMisses += 1;

    let bytesToRead = Math.min(Math.max(1, initialBytes), maxBytes, stat.size);
    let signals = parseRolloutSignals('');
    let tailStart = 0;
    let guard = null;
    while (bytesToRead > 0) {
      const tail = await readTail(rolloutPath, bytesToRead, stat);
      tailStart = tail.start;
      guard = tail.guard;
      codexCacheMetrics.rolloutSignalBytesRead += tail.bytesRead;
      signals = parseRolloutSignals(tail.text);
      if (hasTurnBoundary(signals) || bytesToRead >= stat.size || bytesToRead >= maxBytes) break;
      const nextBytes = Math.min(bytesToRead * 2, maxBytes, stat.size);
      if (nextBytes === bytesToRead) break;
      bytesToRead = nextBytes;
    }
    // A human message or an abort clears all earlier questions. Otherwise keep the full history scan.
    // A stop without a window record in the tail needs the newest window record of the whole log.
    const limitBeforeTail = signals.limitWindowAtMs === 0 && signals.agentRunning === false && signals.limitStopped;
    if (tailStart > 0 && (limitBeforeTail || !(signals.agentRunning !== null && signals[QUESTION_HISTORY_COMPLETE]))) {
      const activity = await scanRolloutLifecycle(rolloutPath, stat, cacheLimit, signals.agentRunning === null || limitBeforeTail, cacheScope);
      signals = finalizeRolloutLifecycle({ ...signals, ...(signals.agentRunning === null ? activity : {}),
        ...(limitBeforeTail ? { limitWindowAtMs: activity.limitWindowAtMs, limitWindows: activity.limitWindows } : {}),
        awaitingUserInput: activity.awaitingUserInput, userQuestionBlocking: activity.userQuestionBlocking,
        latestUserQuestionAtMs: activity.latestUserQuestionAtMs, latestBlockingQuestionAtMs: activity.latestBlockingQuestionAtMs });
    }
    delete signals[QUESTION_HISTORY_COMPLETE];
    // The entry does not change after this, so a save of the positions never sees a result that a running read changes.
    rolloutSignalCache.remember(cacheKey, { signature, signals, ...(rolloutTailPositions && guard ? { atMs: Date.now(), guard } : {}) },
      cacheScope, cacheLimit, codexCacheMetrics, 'rolloutSignalWrites', 'rolloutSignalEvictions');
    return signals;
  } catch {
    // The empty signals show the card as Unknown. The mark lets the source status say why.
    return Object.assign(parseRolloutSignals(''), { [ROLLOUT_UNREADABLE]: true });
  }
}

async function attachRolloutSignals(threads, {
  maxRollouts = DEFAULT_THREAD_LIMIT,
  signalCacheLimit = DEFAULT_THREAD_LIMIT,
  cacheScope = '',
  rolloutThreadFilter = () => true,
  fileScan = null,
  initialRolloutBytes = DEFAULT_INITIAL_ROLLOUT_BYTES,
  maxRolloutBytes = DEFAULT_MAX_ROLLOUT_BYTES,
} = {}) {
  // The threads are new objects of this scan (`enrichThreads` made them), so the signals go on them in place.
  const enriched = threads;
  const { descendantsFor } = threadTree(enriched);
  const linkedIds = new Set();
  for (const thread of enriched) {
    if (rolloutThreadFilter(thread)) for (const child of descendantsFor(thread.id)) linkedIds.add(child.id);
  }
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
      cacheScope,
      fileScan,
    }),
  );

  // The logs of unarchived roots tell whether the reader works. An archived row can have a log that Codex moved.
  const rootResults = results.filter((result, index) => !candidates[index].archived && rolloutThreadFilter(candidates[index]));
  const logsUnreadable = rootResults.length > 0
    && rootResults.every((result) => result.status !== 'fulfilled' || result.value[ROLLOUT_UNREADABLE]);

  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;

    const thread = candidates[index];
    // The row time is the last turn entry of the rollout. The database time stays when the rollout has no turn entry.
    thread.updatedAtMs = Number(result.value.latestEventAtMs || result.value.latestLifecycleAtMs || 0) || thread.updatedAtMs;
    thread.latestAgentFinalAtMs = result.value.latestAgentFinalAtMs;
    thread.latestUserMessageAtMs = result.value.latestUserMessageAtMs;
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
    thread.limitResetsAtMs = Number(result.value.limitResetsAtMs || 0);
    thread.limitWindowAtMs = Number(result.value.limitWindowAtMs || 0);
    thread.limitWindows = result.value.limitWindows || [];
    thread.limitStopped = result.value.agentRunning === false && Boolean(result.value.limitStopped);
    thread.limitStoppedAtMs = thread.limitStopped ? Number(result.value.limitStoppedAtMs || 0) : 0;
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

  return { threads: enriched, logsUnreadable };
}

// Callers can pass old dashboard options (asbMode, maxOrphanRollouts, and so on). They have no effect.
export async function loadCodexDashboard(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const databasePath = options.databasePath || await discoverCodexStateDatabase();
  const rows = await readThreadRows({ ...options, databasePath });
  const sessionIndexValue = await readSessionIndex(options.sessionIndexPath || DEFAULT_SESSION_INDEX, options.cacheScope);
  const globalStateValue = await readCodexGlobalState(options.globalStatePath || DEFAULT_GLOBAL_STATE, options.cacheScope).catch(() => ({}));
  // The inputs come from caches keyed by file signatures, so the same objects mean unchanged files.
  const key = 'codex';
  const kept = options.fileScan?.loaderCache?.get(key);
  const settings = JSON.stringify([databasePath, options.sessionIndexPath, options.globalStatePath, options.maxRollouts,
    options.initialRolloutBytes, options.maxRolloutBytes, options.codexNativeReadEnabled]);
  if (kept && kept.settings === settings && kept.rows === rows && kept.sessionIndex === sessionIndexValue && kept.globalState === globalStateValue
    && kept.filter === options.rolloutThreadFilter && nowMs >= kept.atMs && nowMs < kept.untilMs
    && options.fileScan.unchanged?.(path.dirname(databasePath)) && [...kept.files.keys()].every(options.fileScan.canReuse)) {
    for (const [file, info] of kept.files) options.fileScan.statusFiles.set(file, info);
    return kept.result;
  }
  const sessionIndex = sessionIndexValue;
  const globalState = globalStateValue;
  // The kept rows are read only: the sort gets a copy of the list, and the threads are new objects.
  const threads = enrichThreads([...rows].sort((a, b) => threadRowUpdatedAtMs(b) - threadRowUpdatedAtMs(a)), sessionIndex);
  if (options.codexNativeReadEnabled) {
    for (const thread of threads) Object.assign(thread, codexNativeReadStatus(thread, globalState));
  }
  const { threads: enriched, logsUnreadable } = await attachRolloutSignals(threads, options);
  // A stop uses the newest window record at or before it, of any session of the same Codex home: a retry can fail with no record of its own.
  const windowRecords = enriched.filter((thread) => thread.limitWindowAtMs > 0);
  for (const thread of enriched) {
    if (!thread.limitStopped) continue;
    // The own record comes first, so it wins a tie.
    const record = [thread, ...windowRecords].reduce((best, item) => item.limitWindowAtMs <= thread.limitStoppedAtMs
      && item.limitWindowAtMs > (best?.limitWindowAtMs || 0) ? item : best, null);
    thread.limitResetsAtMs = record ? limitStopResetsAtMs(record.limitWindows, thread.limitStoppedAtMs) : 0;
  }
  const incoming = new Map();
  for (const { to, from, atMs } of await readBridgeMessages(path.dirname(databasePath), nowMs - SESSION_MESSAGE_WINDOW_MS, options.cacheScope)) {
    incoming.set(to, [...(incoming.get(to) || []), { from, atMs }]);
  }
  for (const thread of enriched) if (incoming.has(thread.id)) thread.incomingMessages = incoming.get(thread.id);
  const result = { generatedAtMs: nowMs, threads: enriched,
    ...(logsUnreadable ? { provider: { installed: true, status: 'warning', message: ROLLOUT_UNREADABLE_MESSAGE } } : {}) };
  // An incoming message shows from 5 s before its time to the end of its window, so the loader runs again at those times.
  const untilMs = Math.min(...enriched.flatMap((thread) => (thread.incomingMessages || [])
    .flatMap((message) => [message.atMs - 5_000, message.atMs + SESSION_MESSAGE_WINDOW_MS])).map((time) => time + 1).filter((time) => time > nowMs));
  options.fileScan?.loaderCache?.set(key, { result, settings, rows, sessionIndex, globalState, filter: options.rolloutThreadFilter, atMs: nowMs, untilMs,
    files: new Map(options.fileScan.statusFiles) });
  return result;
}
