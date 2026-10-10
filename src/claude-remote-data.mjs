import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { claudeDesktopCodeDeepLink, defaultClaudeAppDir, loadClaudeDesktopCodeThreads } from './claude-data.mjs';

const INITIAL_MAGIC = 0xfcfb6d1ba7725c30n;
const FINAL_MAGIC = 0xf4fa6f45970d41d8n;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 5000;
const MAX_INDEX_ENTRIES = 50_000;
const MAX_RESPONSES = 512;
const MAX_PENDING_BODY_BYTES = 6 * MAX_BODY_BYTES;
const ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const caches = new Map();
const metrics = { keyReads: 0, bodyReads: 0, directoryReads: 0, parserStarts: 0, parserJobs: 0 };
const parserQueue = [];
let parserWorker = null, parserRequest = null, parserJob = null, pendingBodyBytes = 0, parserGeneration = 0;

export function claudeRemoteDeepLink(id) {
  return typeof id === 'string' && /^(?:cse|session)_[A-Za-z0-9_-]{1,128}$/.test(id)
    ? `claude://code/${encodeURIComponent(id)}` : '';
}

function signature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function timestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function cursorTime(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{4,80}={0,2}$/.test(value)) return 0;
  const decoded = Buffer.from(value, 'base64').toString('ascii');
  if (!/^\d{18,20}$/.test(decoded)) return 0;
  const time = Number(BigInt(decoded) / 1_000_000n);
  return Number.isSafeInteger(time) && time > 0 ? time : 0;
}

function sourceKey(key) {
  if (!/^1\/0\/https:\/\/claude\.ai\//.test(key)) return null;
  try {
    const url = new URL(key.slice(4));
    if (url.origin !== 'https://claude.ai' || url.username || url.password || url.hash) return null;
    const kind = url.pathname === '/v1/code/sessions' ? 'list'
      : url.pathname === '/v1/code/sessions/watch' ? 'watch' : '';
    if (!kind || [...url.searchParams.keys()].some((name) => ![
      'limit', 'statuses', 'exclude_tags', 'resume_token', 'include_trigger_sessions',
    ].includes(name))) return null;
    return { kind, startCursor: url.searchParams.get('resume_token') || '' };
  } catch { return null; }
}

function projectName(config) {
  const names = [];
  for (const source of Array.isArray(config?.sources) ? config.sources.slice(0, 20) : []) {
    if (source?.type !== 'git' || typeof source.url !== 'string') continue;
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
      const name = path.posix.basename(url.pathname).replace(/\.git$/, '');
      if (name && name.length <= 128 && !/[\x00-\x1f\x7f]/.test(name)) names.push(name);
    } catch { /* Repository metadata can be absent or incomplete. */ }
  }
  return [...new Set(names)].join(', ').slice(0, 140);
}

function enumValue(value, prefix) {
  return typeof value === 'string' ? value.replace(new RegExp(`^${prefix}`), '').toLowerCase() : '';
}

function sessionRecord(value) {
  if (!value || typeof value !== 'object' || !claudeRemoteDeepLink(value.id)) return null;
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
    projectName: projectName(value.config),
    workerStatus: enumValue(value.worker_status, 'WORKER_STATUS_'),
    sessionStatus: enumValue(value.status, 'SESSION_STATUS_'),
    connectionStatus: enumValue(value.connection_status, 'CONNECTION_STATUS_'),
    environmentKind: typeof value.environment_kind === 'string' ? value.environment_kind : '',
    unread: typeof value.unread === 'boolean' ? value.unread : null,
    createdAtMs: timestamp(value.created_at),
    updatedAtMs: timestamp(value.updated_at) || timestamp(value.last_event_at) || timestamp(value.created_at),
    eventAtMs: timestamp(value.last_event_at),
    statusBucket: typeof value.status_bucket === 'string' ? value.status_bucket : '',
  };
}

function decodeBody(body, incomplete) {
  const options = { maxOutputLength: MAX_DECODED_BYTES };
  if (body[0] === 0x1f && body[1] === 0x8b) {
    return zlib.gunzipSync(body, { ...options, ...(incomplete ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {}) }).toString('utf8');
  }
  if (body.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
    return zlib.zstdDecompressSync?.(body, options).toString('utf8') || '';
  }
  if (body.length > MAX_DECODED_BYTES || incomplete) return '';
  return body.toString('utf8');
}

export function parseClaudeRemoteBody(body, { kind = 'watch', startCursor = '', incomplete = false, mtimeMs = 0 } = {}) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BODY_BYTES) return null;
  let text;
  try { text = decodeBody(body, incomplete); } catch { return null; }
  const records = new Map();
  let lastCursor = '', observedAtMs = 0, invalidReceipt = false;
  const remember = (value, removed = false) => {
    const row = removed ? (claudeRemoteDeepLink(value?.id) ? { id: value.id, removed: true } : null) : sessionRecord(value);
    if (!row) return;
    records.delete(row.id);
    records.set(row.id, row);
    if (records.size > MAX_SESSIONS) records.delete(records.keys().next().value);
  };
  if (kind === 'list') {
    let value;
    try { value = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(value?.data)) return null;
    value.data.slice(0, MAX_SESSIONS).forEach((row) => remember(row));
    lastCursor = typeof value.resume_token === 'string' ? value.resume_token : '';
    observedAtMs = cursorTime(lastCursor);
    invalidReceipt = Boolean(lastCursor && !observedAtMs);
  } else {
    // Only complete SSE frames are observations; a half-written frame is retried on the next read.
    for (const frame of text.split(/\r?\n\r?\n/).slice(0, -1)) {
      const fields = { event: '', id: '', data: [] };
      for (const line of frame.split(/\r?\n/)) {
        const match = line.match(/^(event|id|data): ?(.*)$/);
        if (match) match[1] === 'data' ? fields.data.push(match[2]) : fields[match[1]] = match[2];
      }
      if (fields.id || fields.event === 'sync') {
        const receipt = cursorTime(fields.id);
        if (!receipt) invalidReceipt = true;
        else { lastCursor = fields.id; observedAtMs = Math.max(observedAtMs, receipt); }
      }
      if (!['added', 'changed', 'removed', 'deleted'].includes(fields.event)) continue;
      try { remember(JSON.parse(fields.data.join('\n')), ['removed', 'deleted'].includes(fields.event)); } catch { /* Ignore an incomplete source frame. */ }
    }
  }
  if (!text || (!records.size && !lastCursor)) return null;
  return { kind, startCursor, lastCursor, observedAtMs: invalidReceipt ? 0 : observedAtMs || mtimeMs, mtimeMs, records };
}

function parserError() {
  return new Error('The remote cache parser stopped. Retry the source scan.');
}

function finishParserRequest(result, failed = false) {
  const request = parserRequest;
  if (!request) return;
  parserRequest = null;
  clearTimeout(request.timer);
  parserWorker?.unref();
  failed ? request.reject(parserError()) : request.resolve(result);
}

function parseInWorker(body, options, generation) {
  if (generation !== parserGeneration) return Promise.reject(parserError());
  return new Promise((resolve, reject) => {
    try {
      if (!parserWorker) {
        const worker = new Worker(new URL(import.meta.url), { workerData: 'claude-remote-parser', env: {}, execArgv: [] });
        parserWorker = worker;
        metrics.parserStarts += 1;
        worker.on('message', (message) => {
          if (parserWorker === worker) finishParserRequest(message?.result, message?.failed || !message || !('result' in message));
        });
        const stopped = () => {
          if (parserWorker !== worker) return;
          parserWorker = null;
          finishParserRequest(null, true);
        };
        worker.on('error', stopped);
        worker.on('exit', stopped);
      }
      const worker = parserWorker;
      parserRequest = { resolve, reject, timer: setTimeout(() => {
        if (parserWorker !== worker) return;
        parserWorker = null;
        finishParserRequest(null, true);
        void worker.terminate();
      }, 30_000) };
      worker.ref();
      metrics.parserJobs += 1;
      worker.postMessage({ body, options });
    } catch {
      if (parserRequest) finishParserRequest(null, true);
      else reject(parserError());
    }
  });
}

function startParserJob() {
  if (parserJob || !parserQueue.length) return;
  const job = parserQueue.shift();
  parserJob = job;
  const generation = parserGeneration;
  const finish = () => {
    pendingBodyBytes -= job.bytes;
    parserJob = null;
    startParserJob();
  };
  Promise.resolve().then(() => job.run(generation)).then(
    (result) => { finish(); job.resolve(result); },
    (error) => { finish(); job.reject(error); },
  );
}

function queueParserJob(run, bytes = 0) {
  if (parserQueue.length + Number(Boolean(parserJob)) >= MAX_RESPONSES
    || pendingBodyBytes + bytes > MAX_PENDING_BODY_BYTES) {
    return Promise.reject(new Error('The remote cache parser queue is full. Retry the source scan.'));
  }
  return new Promise((resolve, reject) => {
    pendingBodyBytes += bytes;
    parserQueue.push({ run, bytes, resolve, reject });
    startParserJob();
  });
}

export function parseClaudeRemoteBodyAsync(body, { kind = 'watch', startCursor = '', incomplete = false, mtimeMs = 0 } = {}) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BODY_BYTES) return Promise.resolve(null);
  return queueParserJob((generation) => parseInWorker(body, { kind, startCursor, incomplete, mtimeMs }, generation), body.length);
}

export async function shutdownClaudeRemoteParser() {
  parserGeneration += 1;
  for (const job of parserQueue.splice(0)) { pendingBodyBytes -= job.bytes; job.reject(parserError()); }
  const worker = parserWorker;
  parserWorker = null;
  finishParserRequest(null, true);
  await worker?.terminate();
}

async function readBytes(file, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}

async function readKey(file) {
  const header = await readBytes(file, 24, 0);
  if (!header || header.readBigUInt64LE(0) !== INITIAL_MAGIC) return { retry: true };
  if (header.readUInt32LE(8) !== 5) return null;
  const length = header.readUInt32LE(12);
  if (!length || length > 2048) return null;
  const key = await readBytes(file, length, 24);
  metrics.keyReads += 1;
  return key ? { ...sourceKey(key.toString('utf8')), bodyStart: 24 + length } : { retry: true };
}

function readResponse(filePath, key, generation) {
  if (generation !== parserGeneration) return Promise.reject(parserError());
  // Queue the read too, so concurrent source scans do not retain large bodies behind the worker.
  return queueParserJob(() => readResponseBody(filePath, key, generation));
}

async function readResponseBody(filePath, key, generation) {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    const currentKey = await readKey(file);
    if (!currentKey?.kind || currentKey.kind !== key.kind || currentKey.bodyStart !== key.bodyStart
      || currentKey.startCursor !== key.startCursor) return null;
    if (stat.size < key.bodyStart + 24) return null;
    const footer = await readBytes(file, 24, stat.size - 24);
    if (!footer) return null;
    const complete = footer.readBigUInt64LE(0) === FINAL_MAGIC;
    let bodyEnd;
    if (complete) {
      const flags = footer.readUInt32LE(8);
      if (flags & ~3) return null;
      bodyEnd = stat.size - 24 - (flags & 2 ? 32 : 0) - footer.readUInt32LE(16) - 24;
      const bodyFooter = bodyEnd >= key.bodyStart ? await readBytes(file, 24, bodyEnd) : null;
      if (!bodyFooter || bodyFooter.readBigUInt64LE(0) !== FINAL_MAGIC) return null;
    } else {
      // Chromium keeps stream-0 HTTP headers in memory until Close. Open gzip watches have a zero-filled reserved tail.
      if (key.kind !== 'watch' || footer.some((byte) => byte !== 0)) return null;
      bodyEnd = stat.size - 24;
    }
    const length = bodyEnd - key.bodyStart;
    if (length <= 0 || length > MAX_BODY_BYTES) return null;
    let body = await readBytes(file, length, key.bodyStart);
    if (!body || signature(stat) !== signature(await file.stat())) return null;
    if (!complete) {
      let end = body.length;
      while (end > 0 && body[end - 1] === 0) end -= 1;
      body = body.subarray(0, end);
      if (body[0] !== 0x1f || body[1] !== 0x8b) return null;
      const marker = Buffer.alloc(8); marker.writeBigUInt64LE(FINAL_MAGIC);
      if (body.includes(marker)) return null;
    }
    metrics.bodyReads += 1;
    return await parseInWorker(body, { kind: key.kind, startCursor: key.startCursor,
      incomplete: !complete, mtimeMs: stat.mtimeMs }, generation);
  } finally { await file.close(); }
}

function boundedResponses(cache, nowMs) {
  const ordered = [...cache.responses].sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
  const chain = new Set(currentResponseChain(ordered.slice(0, MAX_RESPONSES).map(([, response]) => response), nowMs));
  let count = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const [name, response] = ordered[index];
    count += response.records.size;
    // Cursor-linked updates can repeat records from the full list.
    if (index >= MAX_RESPONSES || count > MAX_SESSIONS && !chain.has(response)) cache.responses.delete(name);
  }
}

async function scanCache(root, cache, nowMs) {
  const generation = parserGeneration;
  const directory = await fs.stat(root);
  if (signature(directory) !== cache.directorySignature) {
    metrics.directoryReads += 1;
    const names = (await fs.readdir(root)).filter((name) => /^[a-f0-9]{16}_0$/.test(name));
    const present = new Set(names);
    for (const name of cache.keys.keys()) if (!present.has(name)) { cache.keys.delete(name); cache.responses.delete(name); }
    let next = 0;
    const unknown = names.filter((name) => !cache.keys.has(name)).slice(0, Math.max(0, MAX_INDEX_ENTRIES - cache.keys.size));
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < unknown.length && generation === parserGeneration) {
        const name = unknown[next++];
        let file;
        try {
          file = await fs.open(path.join(root, name), 'r');
          const stamp = signature(await file.stat());
          const key = await readKey(file);
          cache.keys.set(name, key?.kind ? { ...key, signature: '' }
            : key?.retry ? { retry: true, signature: stamp } : null);
        } catch { /* Cache entries can disappear during discovery. */ }
        finally { await file?.close(); }
      }
    }));
    if (generation !== parserGeneration) { cache.directorySignature = ''; throw parserError(); }
    cache.directorySignature = signature(directory);
  }
  const candidates = [...cache.keys].filter(([, key]) => key?.kind || key?.retry);
  let next = 0;
  const files = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < candidates.length && generation === parserGeneration) {
      const [name, storedKey] = candidates[next++], filePath = path.join(root, name);
      try {
        const stat = await fs.stat(filePath), stamp = signature(stat);
        let key = storedKey;
        if (key.retry) {
          if (key.signature === stamp) continue;
          const file = await fs.open(filePath, 'r');
          try { key = await readKey(file); } finally { await file.close(); }
          cache.keys.set(name, key?.kind ? key : key?.retry ? { ...key, signature: stamp } : null);
          if (!key?.kind) continue;
        }
        files.push({ name, key, filePath, stamp, mtimeMs: stat.mtimeMs });
      } catch { cache.responses.delete(name); cache.keys.delete(name); cache.directorySignature = ''; }
    }
  }));
  if (generation !== parserGeneration) { cache.directorySignature = ''; throw parserError(); }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < Math.min(files.length, MAX_RESPONSES) && generation === parserGeneration) {
      const { name, key, filePath, stamp } = files[next++];
      if (key.signature === stamp) continue;
      try {
        const response = await readResponse(filePath, key, generation);
        if (response) { cache.responses.set(name, response); boundedResponses(cache, nowMs); }
        else cache.responses.delete(name);
        key.signature = stamp;
      } catch { cache.responses.delete(name); cache.keys.delete(name); cache.directorySignature = ''; }
    }
  }));
  if (generation !== parserGeneration) { cache.directorySignature = ''; throw parserError(); }
  boundedResponses(cache, nowMs);
}

function currentResponseChain(responses, nowMs) {
  const valid = [...responses].filter((response) => Number.isFinite(response.observedAtMs)
    && response.observedAtMs > 0 && response.observedAtMs <= nowMs)
    .sort((a, b) => b.observedAtMs - a.observedAtMs || b.mtimeMs - a.mtimeMs);
  if (!valid.length) return [];
  const chain = [valid[0]], used = new Set(chain);
  while (chain[0].kind === 'watch' && chain[0].startCursor) {
    const previous = valid.find((candidate) => !used.has(candidate) && candidate.lastCursor
      && candidate.lastCursor === chain[0].startCursor && candidate.observedAtMs <= chain[0].observedAtMs);
    if (!previous) break;
    chain.unshift(previous); used.add(previous);
  }
  return chain;
}

function currentSnapshot(responses, nowMs) {
  // ponytail: only cached observations; complete remote coverage needs a supported app export or API.
  const chain = currentResponseChain(responses, nowMs);
  if (!chain.length) return { records: [], observedAtMs: 0, partial: false };
  const records = new Map();
  for (const response of chain) for (const record of response.records.values()) {
    if (record.removed) records.delete(record.id);
    else records.set(record.id, record);
  }
  return { records: [...records.values()].slice(0, MAX_SESSIONS), observedAtMs: chain.at(-1).observedAtMs,
    partial: chain[0].kind !== 'list' };
}

export function claudeRemoteStatus(thread, nowMs = Date.now()) {
  const observed = Number(thread.remoteObservedAtMs || 0);
  if (!observed || observed > nowMs || nowMs - observed > ACTIVITY_WINDOW_MS) {
    return { state: 'unknown', reason: 'The cached remote observation is missing or too old.' };
  }
  if (!['bridge', 'anthropic_cloud'].includes(thread.remoteEnvironmentKind)
    || !['active', 'archived', 'paused', 'failed'].includes(thread.remoteSessionStatus)) {
    return { state: 'unknown', reason: 'The cached remote session state is not known.' };
  }
  if (thread.remoteEnvironmentKind === 'bridge' && thread.remoteConnectionStatus !== 'connected') {
    return { state: 'unknown', reason: 'The cached Remote Control connection is not connected.' };
  }
  if (['paused', 'failed'].includes(thread.remoteSessionStatus)) return { state: 'idle', reason: 'The remote session stopped.' };
  if (thread.remoteWorkerStatus === 'running') return { state: 'working', reason: 'The cached remote worker is running.' };
  if (thread.remoteWorkerStatus === 'requires_action') return { state: 'waiting', reason: 'The cached remote worker requires a user action.' };
  if (thread.remoteWorkerStatus === 'idle') return { state: 'idle', reason: 'The cached remote worker is idle.' };
  return { state: 'unknown', reason: 'The cached remote worker state is not known.' };
}

export async function loadClaudeRemoteThreads({ appDir = defaultClaudeAppDir(), nowMs = Date.now() } = {}) {
  const root = path.join(appDir, 'Cache', 'Cache_Data');
  let cache = caches.get(root);
  if (!cache) {
    cache = { directorySignature: '', keys: new Map(), responses: new Map(), read: null };
    caches.set(root, cache);
    if (caches.size > 32) caches.delete(caches.keys().next().value);
  }
  if (!cache.read) cache.read = scanCache(root, cache, nowMs).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    cache.keys.clear(); cache.responses.clear(); cache.directorySignature = '';
  }).finally(() => { cache.read = null; });
  await cache.read;
  const snapshot = currentSnapshot(cache.responses.values(), nowMs);
  const threads = snapshot.records.map((record) => {
    const thread = {
      id: `claude-desktop-code:${record.id}`, externalId: record.id, provider: 'claude-desktop-code',
      providerLabel: 'Claude Desktop Code', source: 'claude-remote-cache', title: record.title || 'Untitled remote session',
      cwd: '', projectName: record.projectName, archived: record.sessionStatus === 'archived',
      createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs,
      remoteWorkerStatus: record.workerStatus, remoteSessionStatus: record.sessionStatus,
      remoteConnectionStatus: record.connectionStatus, remoteEnvironmentKind: record.environmentKind,
      remoteObservedAtMs: snapshot.observedAtMs, nativeUnread: record.unread,
      appDeepLink: claudeRemoteDeepLink(record.id),
    };
    const status = claudeRemoteStatus(thread, nowMs);
    if (status.state === 'unknown') thread.nativeUnread = null;
    thread.readStatus = thread.nativeUnread === null ? 'unknown' : thread.nativeUnread ? 'unread' : 'read';
    thread.latestAgentFinalAtMs = status.state === 'idle' && ['completed', 'review_ready'].includes(record.statusBucket)
      && record.sessionStatus !== 'failed' ? record.eventAtMs : 0;
    if (status.state === 'idle' && record.sessionStatus === 'failed') {
      thread.latestLifecycleKind = 'failed';
      thread.latestLifecycleAtMs = record.eventAtMs;
    }
    return thread;
  });
  return { threads, partial: snapshot.partial, provider: { installed: threads.length > 0, status: snapshot.partial ? 'warning' : 'desktop' } };
}

export async function loadSwitchboardClaudeThreads(options = {}) {
  const results = await Promise.allSettled([loadClaudeDesktopCodeThreads(options), loadClaudeRemoteThreads(options)]);
  const local = results[0].status === 'fulfilled' ? results[0].value : null;
  const remote = results[1].status === 'fulfilled' ? results[1].value : null;
  if (!local && !remote?.threads.length) throw results[0].reason;
  if (local?.provider?.status === 'error' && !remote?.threads.length) return local;
  const localThreads = local?.threads || [];
  const aliases = new Map();
  for (const thread of localThreads) {
    if (!claudeDesktopCodeDeepLink('', thread.externalId)) continue;
    for (const alias of Array.isArray(thread.bridgeSessionIds) ? thread.bridgeSessionIds : []) {
      if (!claudeRemoteDeepLink(alias)) continue;
      // Desktop stores session_<token>; bridge cache rows can use cse_<token>.
      for (const key of [alias, `bridge:${alias.replace(/^(?:cse|session)_/, '')}`]) {
        aliases.set(key, aliases.has(key) && aliases.get(key) !== thread.id ? null : thread.id);
      }
    }
  }
  const threads = [...localThreads, ...(remote?.threads || []).filter((thread) => {
    const key = thread.remoteEnvironmentKind === 'bridge'
      ? `bridge:${thread.externalId.replace(/^(?:cse|session)_/, '')}` : thread.externalId;
    return !aliases.get(key);
  })];
  const warning = !local || local.provider?.status === 'warning' || local.provider?.status === 'error'
    || results[1].status === 'rejected' || remote?.partial;
  return { threads, provider: { ...local?.provider, installed: threads.length > 0,
    status: warning ? 'warning' : local?.provider?.status || 'desktop',
    message: remote?.partial ? 'The remote cache contains only observed sessions. Claude has not cached a complete list.' : '' } };
}

export function invalidateClaudeRemoteData({ filePath = '', index = false } = {}) {
  for (const [root, cache] of caches) {
    if (!filePath) { cache.directorySignature = ''; for (const key of cache.keys.values()) if (key) key.signature = ''; }
    else if (filePath === root || filePath.startsWith(`${root}${path.sep}`)) {
      const key = cache.keys.get(path.basename(filePath));
      if (key) key.signature = '';
      if (index || !cache.keys.has(path.basename(filePath))) cache.directorySignature = '';
    }
  }
}

export function isClaudeRemoteCacheEvent(root, filename, event) {
  if (!filename) return true;
  const name = path.basename(filename);
  return /^[a-f0-9]{16}_0$/.test(name) && (event === 'rename' || Boolean(caches.get(root)?.keys.get(name)?.kind));
}

// Read counters and cache sizes, for the tests of the read and size limits.
export function getClaudeRemoteCacheStats() {
  return { ...metrics,
    parserPending: parserQueue.length + Number(Boolean(parserJob)), pendingBodyBytes,
    responseEntries: [...caches.values()].reduce((sum, cache) => sum + cache.responses.size, 0),
    sessionEntries: [...caches.values()].reduce((sum, cache) => sum + [...cache.responses.values()]
      .reduce((count, response) => count + response.records.size, 0), 0) };
}

if (!isMainThread && workerData === 'claude-remote-parser') {
  parentPort.on('message', ({ body, options }) => {
    try {
      const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      parentPort.postMessage({ result: parseClaudeRemoteBody(bytes, options) });
    } catch { parentPort.postMessage({ failed: true }); }
  });
}
