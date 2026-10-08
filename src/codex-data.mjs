import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { rememberBounded, sameFileSignature, statSignature } from './data-cache.mjs';
import { buildDashboard, enrichThreads, normalizeDashboardThreads } from './insights.mjs';
import { GOVERNANCE_CONFIG } from './governance.mjs';
import {
  addTokenBreakdowns,
  emptyTokenBreakdown,
  normalizeTokenBreakdown,
} from './token-usage.mjs';

const execFileAsync = promisify(execFile);
const nativeSqlite = import('node:sqlite').catch(() => null);
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_SESSION_INDEX = path.join(DEFAULT_CODEX_DIR, 'session_index.jsonl');
const DEFAULT_SESSIONS_DIR = path.join(DEFAULT_CODEX_DIR, 'sessions');
const DEFAULT_GLOBAL_STATE = path.join(DEFAULT_CODEX_DIR, '.codex-global-state.json');
const CODEX_PINNED_THREAD_IDS_KEY = 'pinned-thread-ids';
const DEFAULT_AUTH_PATH = path.join(DEFAULT_CODEX_DIR, 'auth.json');
const DEFAULT_CODEX_BACKEND_API_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_RESET_CREDITS_PATH = '/wham/rate-limit-reset-credits';
const DEFAULT_THREAD_LIMIT = 5000;
const DEFAULT_ORPHAN_ROLLOUT_LIMIT = 160;
const DEFAULT_INITIAL_ROLLOUT_BYTES = 512 * 1024;
const DEFAULT_MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ROLLOUT_SIGNAL_CACHE_LIMIT = 256;
const DEFAULT_WORK_METRIC_CACHE_LIMIT = 48;
const DEFAULT_ROLLOUT_SIGNAL_CONCURRENCY = 6;
const DEFAULT_WORK_METRIC_SCAN_CONCURRENCY = 2;
const DEFAULT_WORK_METRIC_CACHE_PATH = path.join(
  os.homedir(),
  '.agent-mission-control',
  'codex-work-metrics-v1.json',
);
const WORK_METRIC_CACHE_VERSION = 1;
const DEFAULT_RESET_CREDITS_TIMEOUT_MS = 30000;
const DEFAULT_RESET_CREDITS_CACHE_TTL_MS = 10 * 60 * 1000;
const COMPLETION_HINT = /(\bdone\b|\bcompleted?\b|ready for review|handoff|完成|已完成|验收|交付|交接|可以看|可以试)/i;
const DISPLAY_TITLE_LENGTH = 140;
const LOW_SIGNAL_USER_MESSAGE = /^(继续|继续吧|你继续|你继续吧|好的|好的好的|可以|可以的|行|ok|okay|收到|嗯|嗯嗯|先这样)$/iu;
const ROLLOUT_FILE_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const ROLLOUT_LIFECYCLE_EVENT_RE = /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|turn_cancelled|task_cancelled|cancelled)"/;
const ARTIFACT_SUMMARY_LIMIT = 3;
const QUESTION_HISTORY_COMPLETE = Symbol('question history complete');
const MEDIA_PLACEHOLDERS = ['[图片]', '[视频]', '[音频]', '[文件]'];
const IMAGE_ARTIFACT_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const VIDEO_ARTIFACT_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);
const AUDIO_ARTIFACT_EXTENSIONS = new Set(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'wav']);
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
let rolloutSignalCacheLimit = DEFAULT_ROLLOUT_SIGNAL_CACHE_LIMIT;
const workMetricCache = new Map();
const workMetricPersistence = {
  path: '',
  loaded: false,
  loadPromise: null,
  writePromise: null,
  dirty: false,
};
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
  workMetricHits: 0,
  workMetricMisses: 0,
  workMetricFullScans: 0,
  workMetricIncrementalScans: 0,
  workMetricBytesRead: 0,
  workMetricPersistentLoads: 0,
  workMetricPersistentWrites: 0,
  workMetricPersistentEntries: 0,
};
const resetCreditsCache = {
  key: '',
  value: null,
  fetchedAtMs: 0,
  pending: null,
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

async function commandVersion(command, args, runCommand = execFileAsync) {
  const { stdout, stderr } = await runCommand(command, args, { timeout: 5000 });
  return String(stdout || stderr || '').trim();
}

async function readCodexAuth(authPath = DEFAULT_AUTH_PATH) {
  try {
    return JSON.parse(await fs.readFile(authPath, 'utf8'));
  } catch {
    return null;
  }
}

function accountIdFromAccessToken(accessToken = '') {
  const [, payload] = String(accessToken).split('.');
  if (!payload) return '';

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const auth = parsed?.['https://api.openai.com/auth'];
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '';
  } catch {
    return '';
  }
}

function backendUrl(baseUrl, route) {
  return `${String(baseUrl || DEFAULT_CODEX_BACKEND_API_BASE_URL).replace(/\/+$/, '')}/${String(route).replace(/^\/+/, '')}`;
}

function codexResetCreditsEnabled(value = process.env.AMC_CODEX_RESET_CREDITS) {
  const normalized = String(value ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

async function fetchCodexResetCredits({
  authPath = DEFAULT_AUTH_PATH,
  apiBaseUrl = DEFAULT_CODEX_BACKEND_API_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_RESET_CREDITS_TIMEOUT_MS,
  nowMs = Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') return null;

  const auth = await readCodexAuth(authPath);
  const accessToken = auth?.tokens?.access_token || auth?.access_token || '';
  if (!accessToken) return null;

  const accountId = auth?.tokens?.account_id || auth?.account_id || accountIdFromAccessToken(accessToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetchImpl(backendUrl(apiBaseUrl, CODEX_RESET_CREDITS_PATH), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        'OAI-Language': 'zh-CN',
        originator: 'Codex Desktop',
        'User-Agent': 'Agent Mission Control',
      },
      signal: controller.signal,
    });

    if (!response?.ok) return null;
    const payload = await response.json();
    return {
      ...payload,
      observedAtMs: nowMs,
      source: 'chatgpt-wham-rate-limit-reset-credits',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readCodexResetCredits({
  useCache = false,
  refreshInBackground = false,
  cacheTtlMs = DEFAULT_RESET_CREDITS_CACHE_TTL_MS,
  nowMs = Date.now(),
  ...options
} = {}) {
  const cacheKey = [
    options.authPath || DEFAULT_AUTH_PATH,
    options.apiBaseUrl || DEFAULT_CODEX_BACKEND_API_BASE_URL,
  ].join('|');
  const hasUsableCache = resetCreditsCache.value
    && resetCreditsCache.key === cacheKey
    && nowMs - resetCreditsCache.fetchedAtMs < cacheTtlMs;
  if (useCache && hasUsableCache) return resetCreditsCache.value;

  const refresh = () => {
    if (!resetCreditsCache.pending || resetCreditsCache.key !== cacheKey) {
      resetCreditsCache.key = cacheKey;
      resetCreditsCache.pending = fetchCodexResetCredits({ ...options, nowMs })
        .then((value) => {
          if (value) {
            resetCreditsCache.key = cacheKey;
            resetCreditsCache.value = value;
            resetCreditsCache.fetchedAtMs = nowMs;
          }
          return value;
        })
        .finally(() => {
          resetCreditsCache.pending = null;
        });
    }
    return resetCreditsCache.pending;
  };

  if (useCache && refreshInBackground) {
    refresh().catch(() => null);
    return resetCreditsCache.value;
  }

  return refresh();
}

export async function loadCodexCliProvider({
  runCommand = execFileAsync,
  threadCount = 0,
} = {}) {
  const version = await commandVersion('codex', ['--version'], runCommand).catch(() => '');

  return {
    id: 'codex-cli',
    label: 'Codex CLI',
    installed: Boolean(version),
    cliInstalled: Boolean(version),
    status: version ? 'ready' : 'missing',
    message: version
      ? `已检测到 ${version}${threadCount ? `，读取 ${threadCount} 个 CLI 任务` : '；任务由 Codex 本地库统一读取'}`
      : '未检测到 codex CLI',
    threadCount,
  };
}

export function parseSessionIndex(jsonlText = '') {
  const titleByThreadId = new Map();

  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue;

    try {
      const record = JSON.parse(line);
      if (record?.id && typeof record.thread_name === 'string' && record.thread_name.trim()) {
        titleByThreadId.set(String(record.id), record.thread_name.trim());
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

export async function readCodexPinnedThreadIds(globalStatePath = DEFAULT_GLOBAL_STATE) {
  return parseCodexPinnedThreadIds(await readCodexGlobalState(globalStatePath));
}

export function codexNativeReadStatus(thread, globalState) {
  const unknown = { nativeUnread: null, readStatus: 'unknown' };
  if (!thread.creatorAccountId || !thread.creatorUserId) return unknown;
  const state = globalState?.['electron-thread-read-state-v1'];
  const identities = state?.unreadByIdentity;
  if (state?.version !== 1 || !identities || Object.keys(identities).length !== 1) return unknown;
  const identity = createHash('sha256').update(JSON.stringify(['chatgpt', thread.creatorAccountId, thread.creatorUserId])).digest('hex');
  const hostKey = `local:${createHash('sha256').update(JSON.stringify(['local', 'local', null])).digest('hex')}`;
  const unread = identities[identity]?.[hostKey];
  if (!Array.isArray(unread) || unread.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return unknown;
  const nativeUnread = unread.includes(thread.id);
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
      threads.sandbox_policy as sandbox_policy,
      threads.approval_mode as approval_mode,
      threads.tokens_used as tokens_used,
      threads.archived as archived,
      threads.git_sha as git_sha,
      threads.git_branch as git_branch,
      threads.git_origin_url as git_origin_url,
      threads.cli_version as cli_version,
      threads.first_user_message as first_user_message,
      threads.agent_nickname as agent_nickname,
      threads.agent_role as agent_role,
      threads.memory_mode as memory_mode,
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

function rolloutThreadId(filePath = '') {
  const match = path.basename(filePath).match(ROLLOUT_FILE_RE);
  return match?.[1] || '';
}

async function collectRecentRolloutFiles(sessionsDir, limit = DEFAULT_ORPHAN_ROLLOUT_LIMIT) {
  if (Number(limit) <= 0) return [];
  const safeFileLimit = safeLimit(limit);
  if (!sessionsDir || safeFileLimit <= 0) return [];

  const files = [];
  const stack = [sessionsDir];

  while (stack.length) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }

    for (const entry of entries) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile() || !ROLLOUT_FILE_RE.test(entry.name)) continue;

      try {
        const fileStat = await fs.stat(filePath);
        files.push({ filePath, stat: fileStat, mtimeMs: Number(fileStat.mtimeMs || 0) });
      } catch {
        // The rollout can disappear while Codex rotates files; skip it this pass.
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath))
    .slice(0, safeFileLimit);
}

async function readFileStart(filePath, maxBytes = 128 * 1024, fileStat = null) {
  const stat = fileStat || await fs.stat(filePath);
  const length = Math.min(Math.max(0, Number(stat.size || 0)), maxBytes);
  if (!length) return '';

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseRolloutSessionMetadata(jsonlText = '') {
  const metadata = {
    id: '',
    cwd: '',
    source: '',
    modelProvider: '',
    model: '',
    cliVersion: '',
    gitSha: '',
    gitBranch: '',
    gitOriginUrl: '',
    createdAtMs: 0,
    latestEventAtMs: 0,
  };

  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const timestampMs = eventTimestampMs(event);
    if (timestampMs) {
      metadata.createdAtMs ||= timestampMs;
      metadata.latestEventAtMs = Math.max(metadata.latestEventAtMs, timestampMs);
    }

    if (event?.type === 'session_meta') {
      const session = event.payload && typeof event.payload === 'object' ? event.payload : event;
      metadata.id ||= String(session.id || '');
      metadata.cwd ||= session.cwd || '';
      metadata.source ||= session.source || session.thread_source || '';
      metadata.modelProvider ||= session.model_provider || '';
      metadata.model ||= typeof session.model === 'string' ? session.model : '';
      metadata.cliVersion ||= session.cli_version || '';
      metadata.gitSha ||= session.git?.sha || session.git_sha || '';
      metadata.gitBranch ||= session.git?.branch || session.git_branch || '';
      metadata.gitOriginUrl ||= session.git?.origin_url || session.git_origin_url || '';
      continue;
    }

    if (event?.type === 'turn_context') {
      metadata.cwd ||= event.cwd || '';
      metadata.model ||= typeof event.model === 'string' ? event.model : '';
    }
  }

  return metadata;
}

async function readRolloutOnlyThreadRows({
  sessionsDir = DEFAULT_SESSIONS_DIR,
  existingThreadIds = new Set(),
  existingRolloutPaths = new Set(),
  limit = DEFAULT_ORPHAN_ROLLOUT_LIMIT,
} = {}) {
  const candidates = await collectRecentRolloutFiles(sessionsDir, limit);
  const rows = [];

  for (const candidate of candidates) {
    const fileId = rolloutThreadId(candidate.filePath);
    if (!fileId) continue;
    if (existingThreadIds.has(fileId) || existingRolloutPaths.has(candidate.filePath)) continue;

    const header = await readFileStart(candidate.filePath, 128 * 1024, candidate.stat).catch(() => '');
    const metadata = parseRolloutSessionMetadata(header);
    const id = metadata.id || fileId;
    if (!id || existingThreadIds.has(id)) continue;

    const createdAtMs = metadata.createdAtMs
      || Number(candidate.stat.birthtimeMs || 0)
      || Number(candidate.stat.mtimeMs || 0);
    const updatedAtMs = Math.max(
      metadata.latestEventAtMs || 0,
      Number(candidate.stat.mtimeMs || 0),
      createdAtMs,
    );

    rows.push({
      id,
      rollout_path: candidate.filePath,
      created_at: Math.floor(createdAtMs / 1000),
      updated_at: Math.floor(updatedAtMs / 1000),
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
      source: metadata.source || 'vscode',
      model_provider: metadata.modelProvider || '',
      cwd: metadata.cwd || '',
      title: '',
      sandbox_policy: '',
      approval_mode: '',
      tokens_used: 0,
      archived: 0,
      git_sha: metadata.gitSha || '',
      git_branch: metadata.gitBranch || '',
      git_origin_url: metadata.gitOriginUrl || '',
      cli_version: metadata.cliVersion || '',
      first_user_message: '',
      agent_nickname: '',
      agent_role: '',
      memory_mode: 'enabled',
      model: metadata.model || metadata.modelProvider || '',
      reasoning_effort: '',
    });
    existingThreadIds.add(id);
    existingRolloutPaths.add(candidate.filePath);
  }

  return rows;
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

function artifactTitleForUrl(url = '') {
  try {
    const parsed = new URL(url);
    const fileName = artifactFileName(parsed.pathname);
    return fileName || parsed.hostname || url;
  } catch {
    return url;
  }
}

function artifactTypeForTarget({ path: artifactPath = '', url = '', title = '' } = {}) {
  const extension = artifactExtension(title || artifactPath || url);
  const isImage = IMAGE_ARTIFACT_EXTENSIONS.has(extension);
  if (url) return isImage ? 'image' : 'link';
  if (isImage) return 'image';
  if (['html', 'htm'].includes(extension)) return 'html';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  return 'file';
}

function artifactLabelForType(type = '') {
  if (type === 'image') return '图片';
  if (type === 'html') return 'HTML';
  if (type === 'markdown') return 'Markdown';
  if (type === 'link') return 'URL';
  return '文件';
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

function extractUrlArtifactTargets(text = '') {
  const items = [];
  const markdownLinkRanges = [];
  const addUrl = (rawUrl) => {
    const url = cleanArtifactTarget(rawUrl);
    if (!url) return;
    items.push({
      url,
      title: artifactTitleForUrl(url),
    });
  };

  const markdownLinkPattern = /\[[^\]\n]*\]\(\s*(https?:\/\/[^\s<>"'`)]+)(?:\s+["'][^"']*["'])?\s*\)/gi;
  for (const match of text.matchAll(markdownLinkPattern)) {
    addUrl(match[1]);
    markdownLinkRanges.push([match.index, match.index + match[0].length]);
  }

  const isInMarkdownLink = (index) => markdownLinkRanges.some(([start, end]) => index >= start && index < end);
  const urlPattern = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  for (const match of text.matchAll(urlPattern)) {
    if (isInMarkdownLink(match.index)) continue;
    addUrl(match[0]);
  }
  return items;
}

function createArtifactRecord({ target, source, turn, atMs, sequence }) {
  const type = artifactTypeForTarget(target);
  const title = target.title || artifactFileName(target.path) || artifactTitleForUrl(target.url) || artifactLabelForType(type);
  return {
    id: `artifact-${sequence + 1}`,
    type,
    typeLabel: artifactLabelForType(type),
    title,
    source,
    turn,
    atMs: atMs || null,
    path: target.path || '',
    url: target.url || '',
    extension: artifactExtension(title || target.path || target.url),
    sequence,
  };
}

function compareArtifactsDesc(a, b) {
  return Number(b.atMs || 0) - Number(a.atMs || 0)
    || Number(b.sequence || 0) - Number(a.sequence || 0);
}

function summarizeRolloutArtifacts(items, limit = ARTIFACT_SUMMARY_LIMIT) {
  const sorted = [...items].sort(compareArtifactsDesc);
  const typeCounts = {};
  for (const item of sorted) {
    typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
  }

  return {
    total: sorted.length,
    latestAtMs: sorted[0]?.atMs || null,
    typeCounts,
    items: sorted.slice(0, limit),
  };
}

function groupRolloutArtifactTurns(items) {
  const byTurn = new Map();
  for (const item of items) {
    const turn = Number(item.turn || 0) || 1;
    const group = byTurn.get(turn) || {
      turn,
      atMs: item.atMs || null,
      items: [],
    };
    group.atMs = Math.max(Number(group.atMs || 0), Number(item.atMs || 0)) || group.atMs;
    group.items.push(item);
    byTurn.set(turn, group);
  }

  return [...byTurn.values()]
    .map((turn) => ({
      ...turn,
      items: turn.items.sort(compareArtifactsDesc),
    }))
    .sort((a, b) => Number(b.atMs || 0) - Number(a.atMs || 0) || Number(b.turn || 0) - Number(a.turn || 0));
}

export function parseRolloutArtifacts(jsonlText = '') {
  const items = [];
  const seen = new Set();
  let turn = 0;
  let sequence = 0;

  const addTarget = (target, source, atMs) => {
    const safeTurn = Math.max(1, turn || 1);
    const key = [
      safeTurn,
      source,
      target.path ? `path:${target.path.toLowerCase()}` : '',
      target.url ? `url:${target.url.toLowerCase()}` : '',
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    items.push(createArtifactRecord({
      target,
      source,
      turn: safeTurn,
      atMs,
      sequence,
    }));
    sequence += 1;
  };

  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = event.payload || event;
    if (payload?.type === 'user_message') turn += 1;
    if (payload?.type !== 'user_message' && payload?.type !== 'agent_message') continue;

    const text = payloadText(payload);
    if (!text) continue;

    const source = payload.type === 'user_message' ? 'user' : 'agent';
    const timestampMs = eventTimestampMs(event);
    for (const target of extractLocalArtifactTargets(text)) {
      addTarget(target, source, timestampMs);
    }
    for (const target of extractUrlArtifactTargets(text)) {
      addTarget(target, source, timestampMs);
    }
  }

  const sortedItems = items.sort(compareArtifactsDesc);
  return {
    ...summarizeRolloutArtifacts(sortedItems, sortedItems.length),
    items: sortedItems,
    turns: groupRolloutArtifactTurns(sortedItems),
  };
}

function compactInlineText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function textAfterCodexRequestHeading(value = '') {
  const text = String(value || '');
  const match = text.match(/^##\s+My request for Codex:\s*$/im);
  if (!match) return text;
  return text.slice((match.index || 0) + match[0].length);
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

function externalLinkPlaceholderText(value = '') {
  return String(value || '')
    .replace(/\[[^\]\n]*\]\(\s*https?:\/\/[^\s<>"'`)]+(?:\s+["'][^"']*["'])?\s*\)/gi, ' [外部链接] ')
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, ' [外部链接] ');
}

function extensionPlaceholder(extension = '') {
  const normalized = String(extension || '').toLowerCase();
  if (IMAGE_ARTIFACT_EXTENSIONS.has(normalized)) return '[图片]';
  if (VIDEO_ARTIFACT_EXTENSIONS.has(normalized)) return '[视频]';
  if (AUDIO_ARTIFACT_EXTENSIONS.has(normalized)) return '[音频]';
  return normalized ? '[文件]' : '';
}

function richAttachmentPlaceholders(value = '') {
  const raw = String(value || '');
  const placeholders = new Set();

  if (/<image\b/i.test(raw)) placeholders.add('[图片]');
  for (const target of extractLocalArtifactTargets(raw)) {
    const extension = artifactExtension(target.title || target.path);
    const placeholder = extensionPlaceholder(extension);
    if (placeholder) placeholders.add(placeholder);
  }

  return [...placeholders];
}

function isImageOnlyTitle(value = '') {
  const text = compactInlineText(value);
  if (!text) return false;
  return new RegExp(`^[^\\s]+\\.(?:${[...IMAGE_ARTIFACT_EXTENSIONS].join('|')})(?:\\s*[·-]\\s*(?:图片|image))?$`, 'iu').test(text);
}

function codexDisplayText(value = '') {
  const raw = String(value || '');
  if (!raw.trim()) return '';

  const attachmentPlaceholders = richAttachmentPlaceholders(raw);
  const body = compactInlineText(externalLinkPlaceholderText(
    stripCodexRichMessageScaffold(textAfterCodexRequestHeading(raw)),
  ));
  const leadingPlaceholders = attachmentPlaceholders.filter((placeholder) => !body.includes(placeholder));
  const displayText = compactInlineText([...leadingPlaceholders, body].filter(Boolean).join(' '));

  if (displayText) return displayText;
  if (isImageOnlyTitle(raw)) return '[图片]';
  return compactInlineText(externalLinkPlaceholderText(stripCodexRichMessageScaffold(raw)));
}

function leadingMediaPlaceholders(value = '') {
  const placeholders = [];
  let text = compactInlineText(value);

  while (text) {
    const placeholder = MEDIA_PLACEHOLDERS.find((candidate) => text.startsWith(candidate));
    if (!placeholder) break;
    placeholders.push(placeholder);
    text = compactInlineText(text.slice(placeholder.length));
  }

  return placeholders;
}

function titleWithSignalPlaceholders(title = '', signals = {}) {
  const context = codexDisplayText(signals.latestMeaningfulUserMessage)
    || codexDisplayText(signals.latestUserMessage)
    || codexDisplayText(signals.firstUserMessage);
  const missingPlaceholders = leadingMediaPlaceholders(context)
    .filter((placeholder) => !title.includes(placeholder));
  return compactInlineText([...missingPlaceholders, title].filter(Boolean).join(' '));
}

function truncateText(value = '', maxLength = DISPLAY_TITLE_LENGTH) {
  const text = compactInlineText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isMeaningfulUserMessage(value = '') {
  const text = compactInlineText(value);
  if (text.length < 8) return false;
  return !LOW_SIGNAL_USER_MESSAGE.test(text);
}

function isPlaceholderStoredTitle(value = '') {
  const text = compactInlineText(value);
  return !text || text === '未命名任务' || isImageOnlyTitle(text);
}

export function deriveCodexThreadTitle(storedTitle, signals = {}) {
  const title = codexDisplayText(storedTitle);
  if (!isPlaceholderStoredTitle(storedTitle)) {
    return truncateText(titleWithSignalPlaceholders(title, signals));
  }

  const rolloutTitle = codexDisplayText(signals.latestMeaningfulUserMessage)
    || codexDisplayText(signals.latestUserMessage)
    || codexDisplayText(signals.firstUserMessage);
  return truncateText(rolloutTitle || title || '未命名任务');
}

function eventTimestampMs(event) {
  const timestamp = Date.parse(event?.timestamp || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== 'object') return null;

  const usedPercent = finiteNumberOrNull(
    window.used_percent
    ?? window.usedPercent
    ?? window.used_percentage,
  );
  if (usedPercent === null) return null;

  return {
    ...window,
    used_percent: usedPercent,
  };
}

function normalizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;

  const primary = normalizeRateLimitWindow(rateLimits.primary);
  const secondary = normalizeRateLimitWindow(rateLimits.secondary);
  if (!primary && !secondary) return null;

  const normalized = { ...rateLimits };
  if (primary) {
    normalized.primary = primary;
  } else {
    delete normalized.primary;
  }

  if (secondary) {
    normalized.secondary = secondary;
  } else {
    delete normalized.secondary;
  }

  return normalized;
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
    workMetrics: {
      entries: workMetricCache.size,
      limit: DEFAULT_WORK_METRIC_CACHE_LIMIT,
      hits: codexCacheMetrics.workMetricHits,
      misses: codexCacheMetrics.workMetricMisses,
      fullScans: codexCacheMetrics.workMetricFullScans,
      incrementalScans: codexCacheMetrics.workMetricIncrementalScans,
      bytesRead: codexCacheMetrics.workMetricBytesRead,
      persistentLoads: codexCacheMetrics.workMetricPersistentLoads,
      persistentWrites: codexCacheMetrics.workMetricPersistentWrites,
      persistentEntries: codexCacheMetrics.workMetricPersistentEntries,
    },
  };
}

const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'web_search_call',
  'tool_search_call',
  'mcp_tool_call',
]);
const TEST_CALL_RE = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest)\b|\b(?:cargo|go|mvn|gradle\w*)\s+test\b)/iu;
const STATIC_CHECK_CALL_RE = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|check|typecheck)\b|\b(?:eslint|tsc|ruff\s+check)\b)/iu;
const BUILD_CALL_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/iu;
const LOCAL_HTTP_CALL_RE = /\bcurl\b[^\n]*(?:127\.0\.0\.1|localhost)/iu;
const WORK_METRIC_LINE_RE = /"(?:turn_context|context_compacted|task_started|task_complete|user_message|thread_goal_updated|function_call|custom_tool_call|web_search_call|tool_search_call|mcp_tool_call)"/;

function workMetricPayloadText(payload = {}) {
  const values = [payload.name, payload.tool, payload.arguments, payload.input, payload.command];
  return values.map((value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }).join('\n');
}

function verificationKind(payload = {}) {
  const name = String(payload.name || payload.tool || '').toLowerCase();
  if (name.includes('view_image')) return 'visual';
  if (/(?:browser|screenshot|playwright|cypress)/.test(name)) return 'browser';
  if (name !== 'exec_command' && name.includes('test')) return 'tests';
  if (name !== 'exec_command' && /(?:lint|check|verify)/.test(name)) return 'static-check';
  if (name !== 'exec_command' && name.includes('build')) return 'build';
  const text = workMetricPayloadText(payload);
  if (TEST_CALL_RE.test(text)) return 'tests';
  if (STATIC_CHECK_CALL_RE.test(text)) return 'static-check';
  if (BUILD_CALL_RE.test(text)) return 'build';
  if (LOCAL_HTTP_CALL_RE.test(text)) return 'local-http';
  return '';
}

function emptyWorkMetrics() {
  return {
    scope: 'full-rollout',
    compactionCount: 0,
    toolCallCount: 0,
    agentTaskCount: 0,
    completedAgentTaskCount: 0,
    agentTurnCount: 0,
    userInputCount: 0,
    verificationSignalCount: 0,
    verificationCallCount: 0,
    verificationKinds: [],
    goalCompletionCount: 0,
  };
}

function applyWorkMetricLine(metrics, verificationKinds, line) {
  if (!WORK_METRIC_LINE_RE.test(line)) return true;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  const payload = event.payload || event;
  const payloadType = String(payload?.type || '');
  if (event.type === 'turn_context') metrics.agentTurnCount += 1;
  if (payloadType === 'context_compacted') metrics.compactionCount += 1;
  if (payloadType === 'task_started') metrics.agentTaskCount += 1;
  if (payloadType === 'task_complete') metrics.completedAgentTaskCount += 1;
  if (payloadType === 'user_message') metrics.userInputCount += 1;
  if (TOOL_CALL_TYPES.has(payloadType) || (payloadType.endsWith('_call') && !payloadType.endsWith('_call_output'))) {
    metrics.toolCallCount += 1;
    const kind = verificationKind(payload);
    if (kind) {
      metrics.verificationCallCount += 1;
      verificationKinds.add(kind);
    }
  }
  if (payloadType === 'thread_goal_updated') {
    const status = String(payload.status || payload.goal?.status || '').toLowerCase();
    if (['complete', 'completed', 'achieved'].includes(status)) metrics.goalCompletionCount += 1;
  }
  return true;
}

async function scanWorkMetricRange(rolloutPath, {
  start = 0,
  sourceSize = 0,
  metrics = emptyWorkMetrics(),
  verificationKinds = new Set(),
} = {}) {
  let pending = '';
  const input = createReadStream(rolloutPath, {
    encoding: 'utf8',
    start,
  });

  for await (const chunk of input) {
    pending += chunk;
    let newlineAt = pending.indexOf('\n');
    while (newlineAt !== -1) {
      const line = pending.slice(0, newlineAt).replace(/\r$/, '');
      applyWorkMetricLine(metrics, verificationKinds, line);
      pending = pending.slice(newlineAt + 1);
      newlineAt = pending.indexOf('\n');
    }
  }

  let processedBytes = sourceSize;
  if (pending) {
    const finalLine = pending.replace(/\r$/, '');
    let complete = false;
    try {
      JSON.parse(finalLine);
      complete = true;
    } catch {
      // A writer may still be appending the final JSONL record. Re-read it next time.
    }
    if (complete) {
      applyWorkMetricLine(metrics, verificationKinds, finalLine);
    } else {
      processedBytes = Math.max(start, sourceSize - Buffer.byteLength(pending));
    }
  }

  metrics.verificationKinds = [...verificationKinds].sort();
  metrics.verificationSignalCount = metrics.verificationKinds.length;
  return {
    metrics,
    processedBytes,
    bytesRead: Math.max(0, sourceSize - start),
  };
}

function validWorkMetricCacheEntry(entry) {
  return Boolean(
    entry
    && typeof entry.path === 'string'
    && entry.path
    && Number.isFinite(Number(entry.sourceSize))
    && Number.isFinite(Number(entry.processedBytes))
    && entry.metrics
    && typeof entry.metrics === 'object',
  );
}

export async function loadWorkMetricCacheFile(
  cachePath,
  { cache = new Map(), cacheLimit = DEFAULT_WORK_METRIC_CACHE_LIMIT } = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { cache, loadedEntries: 0 };
    throw error;
  }

  if (Number(parsed?.version) !== WORK_METRIC_CACHE_VERSION || !Array.isArray(parsed?.entries)) {
    return { cache, loadedEntries: 0 };
  }

  let loadedEntries = 0;
  for (const entry of parsed.entries) {
    if (!validWorkMetricCacheEntry(entry)) continue;
    const { path: rolloutPath, ...cached } = entry;
    rememberBounded(cache, rolloutPath, {
      ...cached,
      metrics: {
        ...emptyWorkMetrics(),
        ...cached.metrics,
        verificationKinds: Array.isArray(cached.metrics?.verificationKinds)
          ? [...cached.metrics.verificationKinds]
          : [],
      },
    }, cacheLimit);
    loadedEntries += 1;
  }
  return { cache, loadedEntries };
}

export async function writeWorkMetricCacheFile(
  cachePath,
  { cache = new Map(), cacheLimit = DEFAULT_WORK_METRIC_CACHE_LIMIT } = {},
) {
  const entries = [...cache.entries()]
    .slice(-Math.max(0, cacheLimit))
    .map(([rolloutPath, cached]) => ({
      path: rolloutPath,
      ...cached,
    }))
    .filter(validWorkMetricCacheEntry);
  const payload = `${JSON.stringify({
    version: WORK_METRIC_CACHE_VERSION,
    entries,
  })}\n`;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, payload, { mode: 0o600 });
    await fs.rename(temporaryPath, cachePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { writtenEntries: entries.length };
}

async function ensurePersistentWorkMetricCache(cachePath) {
  if (!cachePath) return;
  if (workMetricPersistence.loaded && workMetricPersistence.path === cachePath) return;
  if (!workMetricPersistence.loadPromise) {
    workMetricPersistence.path = cachePath;
    workMetricPersistence.loadPromise = loadWorkMetricCacheFile(cachePath, {
      cache: workMetricCache,
      cacheLimit: DEFAULT_WORK_METRIC_CACHE_LIMIT,
    })
      .then(({ loadedEntries }) => {
        workMetricPersistence.loaded = true;
        codexCacheMetrics.workMetricPersistentLoads += 1;
        codexCacheMetrics.workMetricPersistentEntries = loadedEntries;
      })
      .catch(() => {
        workMetricPersistence.loaded = true;
        codexCacheMetrics.workMetricPersistentLoads += 1;
        codexCacheMetrics.workMetricPersistentEntries = 0;
      })
      .finally(() => {
        workMetricPersistence.loadPromise = null;
      });
  }
  return workMetricPersistence.loadPromise;
}

async function persistWorkMetricCache(cachePath) {
  if (!cachePath || !workMetricPersistence.dirty) return;
  if (!workMetricPersistence.writePromise) {
    workMetricPersistence.writePromise = (async () => {
      do {
        workMetricPersistence.dirty = false;
        const { writtenEntries } = await writeWorkMetricCacheFile(cachePath, {
          cache: workMetricCache,
          cacheLimit: DEFAULT_WORK_METRIC_CACHE_LIMIT,
        });
        codexCacheMetrics.workMetricPersistentWrites += 1;
        codexCacheMetrics.workMetricPersistentEntries = writtenEntries;
      } while (workMetricPersistence.dirty);
    })()
      .catch(() => {
        workMetricPersistence.dirty = true;
      })
      .finally(() => {
        workMetricPersistence.writePromise = null;
      });
  }
  return workMetricPersistence.writePromise;
}

export async function scanRolloutWorkMetrics(
  rolloutPath,
  { cache = workMetricCache, cacheLimit = DEFAULT_WORK_METRIC_CACHE_LIMIT } = {},
) {
  if (!rolloutPath) return emptyWorkMetrics();
  const stat = await fs.stat(rolloutPath);
  const signature = statSignature(stat);
  const cached = cache?.get(rolloutPath);
  if (cached && cached.sourceSize === signature.size && cached.mtimeMs === signature.mtimeMs) {
    codexCacheMetrics.workMetricHits += 1;
    return cached.metrics;
  }
  codexCacheMetrics.workMetricMisses += 1;

  const canResume = Boolean(
    cached
    && cached.dev === signature.dev
    && cached.ino === signature.ino
    && signature.size >= cached.sourceSize
    && Number(cached.processedBytes) >= 0
    && Number(cached.processedBytes) <= signature.size,
  );
  const start = canResume ? Number(cached.processedBytes) : 0;
  const metrics = canResume
    ? {
      ...cached.metrics,
      verificationKinds: [...(cached.metrics?.verificationKinds || [])],
    }
    : emptyWorkMetrics();
  const verificationKinds = new Set(metrics.verificationKinds);

  if (canResume) {
    codexCacheMetrics.workMetricIncrementalScans += 1;
  } else {
    codexCacheMetrics.workMetricFullScans += 1;
  }

  const result = await scanWorkMetricRange(rolloutPath, {
    start,
    sourceSize: signature.size,
    metrics,
    verificationKinds,
  });
  codexCacheMetrics.workMetricBytesRead += result.bytesRead;

  rememberBounded(cache, rolloutPath, {
    ...signature,
    sourceSize: signature.size,
    processedBytes: result.processedBytes,
    lastScanStart: start,
    metrics: result.metrics,
  }, cacheLimit);
  if (cache === workMetricCache) workMetricPersistence.dirty = true;
  return result.metrics;
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
  };
}

function applyRolloutLifecycleEvent(lifecycle, eventType, timestampMs) {
  if (eventType === 'task_started') {
    lifecycle.agentRunning = true;
    lifecycle.agentStartedAtMs = timestampMs || null;
    lifecycle.agentActivityAtMs = timestampMs || lifecycle.agentActivityAtMs;
    lifecycle.latestLifecycleAtMs = timestampMs || lifecycle.latestLifecycleAtMs;
    lifecycle.latestLifecycleKind = eventType;
    return;
  }

  if (['task_complete', 'turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled'].includes(eventType)) {
    lifecycle.agentRunning = false;
    lifecycle.agentStartedAtMs = null;
    lifecycle.agentActivityAtMs = timestampMs || lifecycle.agentActivityAtMs;
    lifecycle.latestLifecycleAtMs = timestampMs || lifecycle.latestLifecycleAtMs;
    lifecycle.latestLifecycleKind = eventType;
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
  if (['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled'].includes(payload?.type)) {
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
      if (!internalGoal && codexDisplayText(humanText).trim()) {
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

export function parseRolloutSignals(jsonlText, { todayStartMs = 0, asbMode = false } = {}) {
  const todayStart = Number(todayStartMs || 0);
  const seenTodayTokenEvents = new Set();
  const questions = new Map();
  const signals = {
    totalTokenUsage: null,
    lastTokenUsage: null,
    totalTokenBreakdown: emptyTokenBreakdown(),
    lastTokenBreakdown: emptyTokenBreakdown(),
    todayTokenBreakdown: emptyTokenBreakdown(),
    modelContextWindow: null,
    rateLimits: null,
    latestRateLimitAtMs: null,
    latestRateLimitSignalAtMs: null,
    rateLimitStale: false,
    rateLimitStaleAtMs: null,
    todayTokenUsage: 0,
    completionHint: false,
    latestAgentFinalAtMs: null,
    latestUserMessageAtMs: null,
    latestMessageKind: '',
    firstUserMessage: '',
    latestUserMessage: '',
    latestMeaningfulUserMessage: '',
    lastAgentMessage: '',
    artifacts: {
      total: 0,
      latestAtMs: null,
      typeCounts: {},
      items: [],
    },
    ...emptyRolloutLifecycle(),
    oldestEventAtMs: null,
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

    const payload = event.payload || event;
    const timestampMs = eventTimestampMs(event);
    if (timestampMs) {
      signals.oldestEventAtMs = signals.oldestEventAtMs
        ? Math.min(signals.oldestEventAtMs, timestampMs)
        : timestampMs;
      signals.latestEventAtMs = Math.max(signals.latestEventAtMs || 0, timestampMs);
    }

    applyRolloutLifecycleEvent(signals, payload?.type, timestampMs);
    if (applyUserQuestionEvent(questions, payload, timestampMs) && asbMode) signals[QUESTION_HISTORY_COMPLETE] = true;

    if (payload?.type === 'token_count') {
      if (asbMode) continue;
      signals.totalTokenUsage = payload.info?.total_token_usage || null;
      signals.lastTokenUsage = payload.info?.last_token_usage || null;
      signals.totalTokenBreakdown = normalizeTokenBreakdown(signals.totalTokenUsage);
      signals.lastTokenBreakdown = normalizeTokenBreakdown(signals.lastTokenUsage);
      signals.modelContextWindow = payload.info?.model_context_window || null;

      if (Object.prototype.hasOwnProperty.call(payload, 'rate_limits')) {
        const signalAtMs = timestampMs || signals.latestRateLimitSignalAtMs;
        signals.latestRateLimitSignalAtMs = signalAtMs;

        const rateLimits = normalizeRateLimits(payload.rate_limits);
        if (rateLimits) {
          signals.rateLimits = rateLimits;
          signals.latestRateLimitAtMs = timestampMs || signals.latestRateLimitAtMs;
          signals.rateLimitStale = false;
          signals.rateLimitStaleAtMs = null;
        } else {
          signals.rateLimitStale = true;
          signals.rateLimitStaleAtMs = signalAtMs || signals.rateLimitStaleAtMs;
        }
      }

      const todayTokens = Number(payload.info?.last_token_usage?.total_tokens || 0);
      const totalTokens = Number(payload.info?.total_token_usage?.total_tokens || 0);
      if (todayStart && timestampMs >= todayStart && todayTokens > 0) {
        const eventKey = `${totalTokens}:${todayTokens}`;
        if (!seenTodayTokenEvents.has(eventKey)) {
          seenTodayTokenEvents.add(eventKey);
          signals.todayTokenUsage += todayTokens;
          signals.todayTokenBreakdown = addTokenBreakdowns(
            signals.todayTokenBreakdown,
            signals.lastTokenBreakdown,
          );
        }
      }
      continue;
    }

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
        const compactText = truncateText(codexDisplayText(text), 500);
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

  if (!asbMode) signals.artifacts = summarizeRolloutArtifacts(parseRolloutArtifacts(jsonlText).items);
  Object.assign(signals, questionSignals(questions));
  return finalizeRolloutLifecycle(signals);
}

async function scanRolloutLifecycle(rolloutPath, fileStat = null, cacheLimit = DEFAULT_ROLLOUT_SIGNAL_CACHE_LIMIT) {
  const stat = fileStat || await fs.stat(rolloutPath);
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
        const payload = event.payload || event;
        applyRolloutLifecycleEvent(lifecycle, payload?.type, eventTimestampMs(event));
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

function coversToday(signals, tail, todayStartMs) {
  if (!todayStartMs) return true;
  if (tail.start === 0) return true;
  return Boolean(signals.oldestEventAtMs && signals.oldestEventAtMs <= todayStartMs);
}

function needsMoreRateLimitHistory(signals, bytesToRead, fileSize, maxBytes) {
  return Boolean(
    signals.rateLimitStale
    && !signals.rateLimits
    && bytesToRead < fileSize
    && bytesToRead < maxBytes,
  );
}

export async function readRolloutSignals(
  rolloutPath,
  {
    initialBytes = DEFAULT_INITIAL_ROLLOUT_BYTES,
    maxBytes = DEFAULT_MAX_ROLLOUT_BYTES,
    todayStartMs = 0,
    asbMode = false,
    signalCache = rolloutSignalCache,
    signalCacheLimit = asbMode ? DEFAULT_THREAD_LIMIT : DEFAULT_ROLLOUT_SIGNAL_CACHE_LIMIT,
  } = {},
) {
  const parseOptions = { todayStartMs: asbMode ? 0 : todayStartMs, asbMode };
  if (!rolloutPath) return parseRolloutSignals('', parseOptions);

  try {
    const stat = await fs.stat(rolloutPath);
    const signature = statSignature(stat);
    const requestedLimit = Math.min(DEFAULT_THREAD_LIMIT, Math.max(0, Number(signalCacheLimit) || 0));
    if (signalCache === rolloutSignalCache) rolloutSignalCacheLimit = requestedLimit;
    const cacheLimit = requestedLimit;
    const cacheKey = `${rolloutPath}\0${parseOptions.todayStartMs}\0${initialBytes}\0${maxBytes}\0${asbMode}`;
    const cached = signalCache?.get(cacheKey);
    if (cached && sameFileSignature(cached.signature, signature)) {
      codexCacheMetrics.rolloutSignalHits += 1;
      return cached.signals;
    }
    codexCacheMetrics.rolloutSignalMisses += 1;

    let bytesToRead = Math.min(Math.max(1, initialBytes), maxBytes, stat.size);
    let signals = parseRolloutSignals('', parseOptions);
    let tailStart = 0;
    while (bytesToRead > 0) {
      const tail = await readTail(rolloutPath, bytesToRead, stat);
      tailStart = tail.start;
      codexCacheMetrics.rolloutSignalBytesRead += tail.bytesRead;
      signals = parseRolloutSignals(tail.text, parseOptions);
      const needsQuotaHistory = !asbMode && needsMoreRateLimitHistory(signals, bytesToRead, stat.size, maxBytes);
      if ((hasTurnBoundary(signals) && coversToday(signals, tail, parseOptions.todayStartMs) && !needsQuotaHistory)
        || bytesToRead >= stat.size || bytesToRead >= maxBytes) break;
      const nextBytes = Math.min(bytesToRead * 2, maxBytes, stat.size);
      if (nextBytes === bytesToRead) break;
      bytesToRead = nextBytes;
    }
    // A human message or an abort clears all earlier questions. Otherwise keep the full history scan.
    if (tailStart > 0 && !(asbMode && signals.agentRunning !== null && signals[QUESTION_HISTORY_COMPLETE])) {
      const activity = await scanRolloutLifecycle(rolloutPath, stat, cacheLimit);
      signals = finalizeRolloutLifecycle({ ...signals, ...(signals.agentRunning === null ? activity : {}),
        awaitingUserInput: activity.awaitingUserInput, userQuestionBlocking: activity.userQuestionBlocking,
        latestUserQuestionAtMs: activity.latestUserQuestionAtMs, latestBlockingQuestionAtMs: activity.latestBlockingQuestionAtMs });
    }
    delete signals[QUESTION_HISTORY_COMPLETE];
    rememberBounded(signalCache, cacheKey, { signature, signals }, cacheLimit,
      codexCacheMetrics, 'rolloutSignalWrites', 'rolloutSignalEvictions');
    return signals;
  } catch {
    return parseRolloutSignals('', parseOptions);
  }
}

async function attachRolloutSignals(threads, {
  asbMode = false,
  maxRollouts = asbMode ? DEFAULT_THREAD_LIMIT : 48,
  signalCacheLimit = asbMode ? DEFAULT_THREAD_LIMIT : DEFAULT_ROLLOUT_SIGNAL_CACHE_LIMIT,
  rolloutThreadFilter = () => true,
  maxGovernanceRollouts = asbMode ? 0 : GOVERNANCE_CONFIG.rolloutMetricScanLimit,
  rolloutSignalConcurrency = DEFAULT_ROLLOUT_SIGNAL_CONCURRENCY,
  governanceScanConcurrency = DEFAULT_WORK_METRIC_SCAN_CONCURRENCY,
  workMetricCachePath = '',
  initialRolloutBytes = DEFAULT_INITIAL_ROLLOUT_BYTES,
  maxRolloutBytes = DEFAULT_MAX_ROLLOUT_BYTES,
  todayStartMs = 0,
} = {}) {
  const enriched = threads.map((thread) => ({ ...thread }));
  await ensurePersistentWorkMetricCache(workMetricCachePath);
  const linkedIds = new Set(asbMode ? normalizeDashboardThreads(enriched)
    .filter(rolloutThreadFilter).flatMap((thread) => thread.descendantThreadIds) : []);
  const candidates = enriched
    .filter((thread) => thread.rolloutPath && (rolloutThreadFilter(thread) || (!thread.archived && linkedIds.has(thread.id))))
    .slice(0, maxRollouts);
  const governanceCandidates = enriched
    .filter((thread) => thread.rolloutPath && !thread.archived)
    .sort((a, b) => Number(b.tokensUsed || 0) - Number(a.tokensUsed || 0))
    .slice(0, Math.max(0, Number(maxGovernanceRollouts || 0)));

  const [results, governanceResults] = await Promise.all([
    mapSettledWithConcurrency(
      candidates,
      rolloutSignalConcurrency,
      (thread) => readRolloutSignals(thread.rolloutPath, {
        initialBytes: initialRolloutBytes,
        maxBytes: maxRolloutBytes,
        todayStartMs,
        asbMode,
        signalCacheLimit,
      }),
    ),
    mapSettledWithConcurrency(
      governanceCandidates,
      governanceScanConcurrency,
      (thread) => scanRolloutWorkMetrics(thread.rolloutPath),
    ),
  ]);

  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;

    const thread = candidates[index];
    thread.totalTokenUsage = result.value.totalTokenUsage;
    thread.lastTokenUsage = result.value.lastTokenUsage;
    thread.tokenBreakdown = result.value.totalTokenBreakdown;
    thread.lastTokenBreakdown = result.value.lastTokenBreakdown;
    thread.todayTokenBreakdown = result.value.todayTokenBreakdown;
    thread.modelContextWindow = result.value.modelContextWindow;
    thread.rateLimits = result.value.rateLimits;
    thread.rateLimitUpdatedAtMs = result.value.latestRateLimitAtMs;
    thread.rateLimitActivityAtMs = result.value.latestRateLimitAtMs;
    thread.latestRateLimitSignalAtMs = result.value.latestRateLimitSignalAtMs;
    thread.rateLimitStale = result.value.rateLimitStale;
    thread.rateLimitStaleAtMs = result.value.rateLimitStaleAtMs;
    thread.todayTokenUsage = result.value.todayTokenUsage;
    thread.completionHint = result.value.completionHint;
    thread.latestAgentFinalAtMs = result.value.latestAgentFinalAtMs;
    thread.latestUserMessageAtMs = result.value.latestUserMessageAtMs;
    thread.latestMessageKind = result.value.latestMessageKind;
    thread.firstUserMessage = result.value.firstUserMessage;
    thread.latestUserMessage = result.value.latestUserMessage;
    thread.latestMeaningfulUserMessage = result.value.latestMeaningfulUserMessage;
    thread.lastAgentMessage = result.value.lastAgentMessage;
    thread.artifacts = result.value.artifacts;
    thread.latestLifecycleAtMs = result.value.latestLifecycleAtMs;
    thread.latestLifecycleKind = result.value.latestLifecycleKind;
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
    thread.title = thread.desktopName || deriveCodexThreadTitle(thread.title, result.value);
  });

  governanceResults.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    governanceCandidates[index].workMetrics = result.value;
  });
  await persistWorkMetricCache(workMetricCachePath);

  return enriched;
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isCodexProviderThread(thread = {}) {
  const provider = String(thread.provider || thread.source || '').toLowerCase();
  return provider === 'codex' || provider === 'codex-cli' || provider === '';
}

export async function getCodexThreadArtifacts({ thread } = {}) {
  if (!thread) throw httpError('Thread not found', 404);
  if (!isCodexProviderThread(thread)) {
    throw httpError('Artifacts are currently available for Codex threads only', 422);
  }
  if (!thread.rolloutPath) {
    throw httpError('Codex artifacts require a rollout path', 422);
  }

  try {
    const text = await fs.readFile(thread.rolloutPath, 'utf8');
    return {
      threadId: thread.id || '',
      artifacts: parseRolloutArtifacts(text),
    };
  } catch (error) {
    throw httpError(`Unable to read Codex rollout artifacts: ${error.message}`, 422);
  }
}

export async function loadCodexDashboard(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const rows = await readThreads(options);
  const rolloutOnlyRows = await readRolloutOnlyThreadRows({
    sessionsDir: options.sessionsDir || DEFAULT_SESSIONS_DIR,
    existingThreadIds: new Set(rows.map((row) => String(row.id || '')).filter(Boolean)),
    existingRolloutPaths: new Set(rows.map((row) => String(row.rollout_path || '')).filter(Boolean)),
    limit: options.maxOrphanRollouts ?? (options.asbMode ? 0 : DEFAULT_ORPHAN_ROLLOUT_LIMIT),
  });
  const sessionIndex = await readSessionIndex(options.sessionIndexPath || DEFAULT_SESSION_INDEX);
  const globalState = await readCodexGlobalState(options.globalStatePath || DEFAULT_GLOBAL_STATE).catch(() => ({}));
  const pinnedThreadIds = parseCodexPinnedThreadIds(globalState);
  const indexedRows = applySessionIndexTitles([...rows, ...rolloutOnlyRows]
    .sort((a, b) => threadRowUpdatedAtMs(b) - threadRowUpdatedAtMs(a)), sessionIndex);
  const pinnedRows = applyCodexPinnedThreadIds(indexedRows, pinnedThreadIds);
  const threads = enrichThreads(pinnedRows, nowMs);
  if (options.codexNativeReadEnabled) {
    for (const thread of threads) Object.assign(thread, codexNativeReadStatus(thread, globalState));
  }
  const shouldReadCodexResetCredits = options.asbMode || options.codexResetCreditsEnabled === false
    ? false
    : codexResetCreditsEnabled(options.codexResetCreditsEnabled);
  const usesDefaultWorkMetricSources = !options.databasePath
    && !options.sessionsDir
    && !options.sessionIndexPath
    && !options.globalStatePath;
  const workMetricCachePath = options.asbMode || options.workMetricCachePath === false
    ? ''
    : (
      options.workMetricCachePath
      || (usesDefaultWorkMetricSources ? DEFAULT_WORK_METRIC_CACHE_PATH : '')
    );
  const [enrichedThreads, codexResetCredits] = await Promise.all([
    attachRolloutSignals(threads, {
      ...options,
      workMetricCachePath,
      todayStartMs: options.todayStartMs || todayStart.getTime(),
    }),
    options.codexResetCredits === undefined
      ? (shouldReadCodexResetCredits ? readCodexResetCredits({
        ...options,
        nowMs,
        useCache: true,
        refreshInBackground: true,
      }) : Promise.resolve(null))
      : Promise.resolve(options.codexResetCredits),
  ]);
  return options.asbMode ? { generatedAtMs: nowMs, threads: enrichedThreads }
    : buildDashboard(enrichedThreads, nowMs, { codexResetCredits });
}
