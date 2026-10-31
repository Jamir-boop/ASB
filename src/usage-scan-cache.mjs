// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/usage/usageScanCache.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps the per-file cache by size and change time, and a refresh that reads only the new bytes of a grown file.
// The file on disk is private: keys are SHA-256 digests of the paths, and values are numbers, model names, the reader
// state, and digests of the record IDs (Claude message and request IDs, Grok session and prompt IDs, Pi entry IDs).
// No path, title, folder name, or message text.
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { claudeUsageFormat } from './usage-claude.mjs';
import { codexUsageFormat } from './usage-codex.mjs';
import { grokUsageFormat } from './usage-grok.mjs';
import { piUsageFormat } from './usage-pi.mjs';

// Version 2 keeps all history; version 3 keeps the larger counts of a repeated key. Older caches are read again once.
export const USAGE_CACHE_VERSION = 3;
export const MAX_CACHE_FILES = 10_000;
export const GUARD_LENGTH = 64;
export const QUARTER_HOUR_MS = 15 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;
// The usage cache text goes to gzip in slices, so a save holds no Buffer copy of the whole text.
export const CACHE_SLICE_CHARS = 1024 * 1024;
const YIELD_AFTER_MS = 25;
// The usage scan rests 3 times the CPU time of its work, so it uses at most about a third of one core; one rest is at most MAX_REST_MS.
export const SCAN_REST_RATIO = 3;
export const MAX_REST_MS = 200;
const FORMATS = { codex: codexUsageFormat, claude: claudeUsageFormat, grok: grokUsageFormat, pi: piUsageFormat };
const HEX32 = /^[0-9a-f]{32}$/;

export const pathKey = (file) => createHash('sha256').update(file).digest('hex');
const digest = (value) => createHash('sha256').update(value).digest('base64url').slice(0, 22);
const guardHash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 32);

const processCpuMs = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };

// Gives the event loop a turn at least every YIELD_AFTER_MS of work. With a restRatio, the turn is a wait of
// restRatio times the CPU time of the process since the last wait, at most MAX_REST_MS. The CPU time counts all threads:
// the thread pool reads, hashes, and unzips files at the same time as the main thread. The wait keeps the event loop
// alive, because a caller that waits for the scan can have nothing else running (Node 22 then ends with the scan pending).
export function createYielder(now = Date.now, { restRatio = 0, timers = { setTimeout }, cpuMs = processCpuMs } = {}) {
  let last = now();
  let lastCpu = restRatio ? cpuMs() : 0;
  return async () => {
    if (now() - last < YIELD_AFTER_MS) return;
    const restMs = restRatio ? Math.min(MAX_REST_MS, Math.round((cpuMs() - lastCpu) * restRatio)) : 0;
    await new Promise((resolve) => {
      if (restMs > 0) timers.setTimeout(resolve, restMs);
      else setImmediate(resolve);
    });
    last = now();
    if (restRatio) lastCpu = cpuMs();
  };
}

// A record is [quarter hour, model, uncached, cacheRead, cacheWrite, output, key digest or null].
// Parts with no key in the same quarter hour and model are one record, so a Codex rollout keeps a few records.
// A repeated key keeps its first quarter hour and model and the larger counts: early lines of a streamed reply count less output.
function addRecord(entry, record, seen) {
  const quarter = Math.floor(record.timestampMs / QUARTER_HOUR_MS);
  const { uncached, cacheRead, cacheWrite, output } = record.tokens;
  if (record.dedupeKey !== null) {
    const key = digest(record.dedupeKey);
    const kept = seen.get(key);
    if (kept) {
      [uncached, cacheRead, cacheWrite, output].forEach((value, index) => { kept[index + 2] = Math.max(kept[index + 2], value); });
      return;
    }
    const tuple = [quarter, record.model, uncached, cacheRead, cacheWrite, output, key];
    seen.set(key, tuple);
    entry.records.push(tuple);
    return;
  }
  const last = entry.records.at(-1);
  if (last && last[0] === quarter && last[1] === record.model && last[6] === null) {
    last[2] += uncached; last[3] += cacheRead; last[4] += cacheWrite; last[5] += output;
  } else entry.records.push([quarter, record.model, uncached, cacheRead, cacheWrite, output, null]);
}

// Only lines with a marker are parsed, in file order: the Codex reader state depends on the order.
function readLines(data, format, entry, seen) {
  const starts = new Set();
  for (const marker of format.markerBytes ||= format.markers.map((text) => Buffer.from(text))) {
    let at = data.indexOf(marker);
    while (at !== -1) {
      starts.add(at === 0 ? 0 : data.lastIndexOf(10, at - 1) + 1);
      at = data.indexOf(marker, data.indexOf(10, at) + 1);
    }
  }
  for (const start of [...starts].sort((a, b) => a - b)) {
    const record = format.parseLine(data.toString('utf8', start, data.indexOf(10, start)), entry.state);
    if (Array.isArray(record)) {
      for (const part of record) addRecord(entry, part, seen);
    } else if (record) addRecord(entry, record, seen);
  }
}

async function readExactly(handle, length, position, stats) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  stats.bytesRead = (stats.bytesRead || 0) + done;
  return buffer.subarray(0, done);
}

async function scanCompressed(file, info, format, handle, stats, pause) {
  const entry = { app: format.app, size: info.size, mtimeMs: info.mtimeMs, offset: info.size,
    guardLength: Math.min(GUARD_LENGTH, info.size), state: format.initialState(), records: [] };
  const seen = new Map();
  const input = createReadStream(file);
  input.on('data', (chunk) => { stats.bytesRead = (stats.bytesRead || 0) + chunk.length; });
  await pipeline(input, zlib.createZstdDecompress({ chunkSize: CHUNK_BYTES }), async (stream) => {
    let pending = [];
    for await (const chunk of stream) {
      const newline = chunk.lastIndexOf(10);
      if (newline === -1) pending.push(chunk);
      else {
        const data = pending.length ? Buffer.concat([...pending, chunk.subarray(0, newline + 1)]) : chunk.subarray(0, newline + 1);
        readLines(data, format, entry, seen);
        pending = newline + 1 < chunk.length ? [chunk.subarray(newline + 1)] : [];
      }
      await pause();
    }
    if (pending.length) readLines(Buffer.concat([...pending, Buffer.from('\n')]), format, entry, seen);
  });
  entry.guardHash = guardHash(await readExactly(handle, entry.guardLength, 0, stats));
  return entry;
}

// Reads the usage of one transcript. An unchanged file gives the old entry with no read. A grown file whose first bytes
// did not change is read from its offset; a shorter file, or one whose first bytes changed, is read again from 0.
// Live files need a newline for their last line; compressed files also count their last line at end of stream.
export async function scanFile(file, info, previous, app, { stats = {}, pause = createYielder() } = {}) {
  const format = FORMATS[app];
  const same = previous?.app === app;
  if (same && previous.size === info.size && previous.mtimeMs === info.mtimeMs) return previous;
  const handle = await fs.open(file, 'r');
  try {
    if (file.endsWith('.zst')) return await scanCompressed(file, info, format, handle, stats, pause);
    let entry = null;
    if (same && previous.offset <= info.size && previous.guardLength <= previous.offset
      && guardHash(await readExactly(handle, previous.guardLength, 0, stats)) === previous.guardHash) {
      entry = { ...previous, state: structuredClone(previous.state), records: previous.records.map((record) => record.slice()) };
    }
    entry ||= { app, size: 0, mtimeMs: 0, offset: 0, guardLength: 0, guardHash: guardHash(Buffer.alloc(0)),
      state: format.initialState(), records: [] };
    const seen = new Map(entry.records.filter((record) => record[6]).map((record) => [record[6], record]));
    let pending = [];
    let position = entry.offset;
    while (position < info.size) {
      const chunk = await readExactly(handle, Math.min(CHUNK_BYTES, info.size - position), position, stats);
      if (!chunk.length) break;
      position += chunk.length;
      const newline = chunk.lastIndexOf(10);
      if (newline === -1) { pending.push(chunk); continue; }
      const data = pending.length ? Buffer.concat([...pending, chunk.subarray(0, newline + 1)]) : chunk.subarray(0, newline + 1);
      readLines(data, format, entry, seen);
      entry.offset += data.length;
      pending = newline + 1 < chunk.length ? [chunk.subarray(newline + 1)] : [];
      await pause();
    }
    const guardLength = Math.min(GUARD_LENGTH, entry.offset);
    if (guardLength !== entry.guardLength) {
      entry.guardLength = guardLength;
      entry.guardHash = guardHash(await readExactly(handle, guardLength, 0, stats));
    }
    entry.size = info.size;
    entry.mtimeMs = info.mtimeMs;
    return entry;
  } finally { await handle.close(); }
}

export function encodeScanCache(cache) {
  const models = [];
  const index = new Map();
  const intern = (model) => {
    if (!index.has(model)) { index.set(model, models.length); models.push(model); }
    return index.get(model);
  };
  const files = {};
  for (const [key, entry] of cache) {
    files[key] = { s: entry.size, m: entry.mtimeMs, o: entry.offset, gl: entry.guardLength, gh: entry.guardHash, a: entry.app,
      cs: entry.state, r: entry.records.map(([quarter, model, ...rest]) => [quarter, intern(model), ...(rest[4] === null ? rest.slice(0, 4) : rest)]) };
  }
  return { version: USAGE_CACHE_VERSION, models, files };
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;

// Rejects a whole entry that is not valid: a partial survivor would look warm and hide usage until the file changes.
export function decodeScanCache(document) {
  const cache = new Map();
  if (document?.version !== USAGE_CACHE_VERSION || !Array.isArray(document.models)
    || !document.models.every((model) => typeof model === 'string') || typeof document.files !== 'object' || document.files === null) return cache;
  for (const [key, raw] of Object.entries(document.files)) {
    const format = FORMATS[raw?.a];
    if (!/^[0-9a-f]{64}$/.test(key) || !format || !Number.isFinite(raw.s) || !Number.isFinite(raw.m) || !count(raw.o)
      || !count(raw.gl) || raw.gl > GUARD_LENGTH || raw.gl > raw.o || !HEX32.test(raw.gh) || !format.validState(raw.cs)
      || !Array.isArray(raw.r)) continue;
    const records = [];
    for (const row of raw.r) {
      if (!Array.isArray(row) || (row.length !== 6 && row.length !== 7) || !row.slice(0, 6).every(count)
        || document.models[row[1]] === undefined || (row.length === 7 && typeof row[6] !== 'string')) break;
      records.push([row[0], document.models[row[1]], row[2], row[3], row[4], row[5], row[6] ?? null]);
    }
    if (records.length !== raw.r.length) continue;
    cache.set(key, { app: raw.a, size: raw.s, mtimeMs: raw.m, offset: raw.o, guardLength: raw.gl, guardHash: raw.gh, state: raw.cs, records });
  }
  return cache;
}

const owned = (info, platform) => platform === 'win32' || !process.getuid || info.uid === process.getuid();

// Read only a regular private file of this user.
async function readPrivateFile(file, { platform = process.platform } = {}, read = (handle) => handle.readFile()) {
  const folder = await fs.lstat(path.dirname(file));
  if (!folder.isDirectory() || !owned(folder, platform) || (platform !== 'win32' && (folder.mode & 0o777) !== 0o700)) return null;
  if (platform === 'win32' && (await fs.lstat(file)).isSymbolicLink()) return null;
  const handle = await fs.open(file, platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !owned(info, platform) || (platform !== 'win32' && (info.mode & 0o777) !== 0o600)) return null;
    return await read(handle);
  } finally { await handle.close(); }
}

export async function readPrivateJson(file, options) {
  try { return JSON.parse(await readPrivateFile(file, options)); } catch { return null; }
}

export async function loadUsageCache(file, options) {
  try { return decodeScanCache(JSON.parse(await readPrivateFile(file, options, gunzipText))); } catch (error) {
    if (error.code === 'ENOENT') return decodeScanCache(await readPrivateJson(file.replace(/\.gz$/, ''), options));
    return new Map();
  }
}

// The chunks are joined once and decoded once. At the 10,000-file cap, a string for each chunk cost about 33 MiB more RSS,
// and 16 KiB chunks about 10 MiB more than 1 MiB chunks.
async function gunzipText(handle) {
  const chunks = [];
  await pipeline(handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 }), zlib.createGunzip({ chunkSize: 1024 * 1024 }), async (source) => { for await (const chunk of source) chunks.push(chunk); });
  return Buffer.concat(chunks).toString('utf8');
}

function* slices(text) {
  for (let at = 0; at < text.length; at += CACHE_SLICE_CHARS) yield text.slice(at, at + CACHE_SLICE_CHARS);
}

// shortcut: the cache is one JSON document, so its encoding and parsing still block; use JSON lines with yields if that matters.
export async function saveUsageCache(file, cache, options) {
  const text = JSON.stringify(encodeScanCache(cache));
  await writePrivateFile(file, () => Readable.from(slices(text)).pipe(zlib.createGzip()), options);
  await fs.rm(file.replace(/\.gz$/, ''), { force: true });
}

// Mode 0600 in a 0700 folder, written atomically (a temporary file and a rename).
export const writePrivateJson = async (file, value, options) => writePrivateFile(file, JSON.stringify(value), options);

// The data is a string, or a function that gives a stream (made only when the folder checks passed).
async function writePrivateFile(file, data, { platform = process.platform } = {}) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await fs.lstat(directory);
  if (!folder.isDirectory() || !owned(folder, platform)) throw new Error('The usage cache folder is not a folder of this user.');
  if (platform !== 'win32' && (folder.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(temporary, platform === 'win32' ? 'wx'
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    // The sync before the rename: after a power cut the new name must not hold zeros.
    try {
      await handle.writeFile(typeof data === 'function' ? data() : data);
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
