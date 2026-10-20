// Reader positions on disk: a new engine resumes the Codex lifecycle scans where the last engine stopped.
// The file holds numbers, booleans, fixed kinds, IDs, and keyed digests: no message text and no path.
// A missing, damaged, old, or foreign file, or a record that does not agree with its log, gives the full read of a new engine.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { rolloutPositionRecords, useRolloutPositions, validRolloutRecord } from './codex-data.mjs';

export const READER_POSITIONS_VERSION = 1;
export const MAX_POSITION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_POSITION_RECORDS = 5000;
export const MAX_POSITION_RECORD_BYTES = 256 * 1024;
export const MAX_POSITION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const POSITION_SAVE_INTERVAL_MS = 10 * 60 * 1000;
const KEY_WAIT_MS = 3_000;
const HEX32 = /^[0-9a-f]{32}$/;
const KEY_CHECK = 'asb reader positions key check';

// A change to the reader code can change what a byte means for the lifecycle, so it drops the records of that reader.
export function readerCodeHash(...names) {
  const hash = createHash('sha256');
  for (const name of names) hash.update(readFileSync(new URL(name, import.meta.url)));
  return hash.digest('hex');
}

class UnsafeFolder extends Error {}

const owned = (info, platform) => platform === 'win32' || !process.getuid || info.uid === process.getuid();

// The positions folder must be a real folder of this user. Linux also needs mode 0700: a save sets it, a load needs it.
async function checkFolder(directory, platform, repair) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || !owned(info, platform)) throw new UnsafeFolder();
  if (platform === 'win32' || (info.mode & 0o777) === 0o700) return true;
  if (!repair) return false;
  await fs.chmod(directory, 0o700);
  return true;
}

async function readPrivateFile(file, platform, maxFileBytes) {
  if (!(await checkFolder(path.dirname(file), platform, false))) return null;
  // Windows has no O_NOFOLLOW, so a link check comes first there.
  if (platform === 'win32' && (await fs.lstat(file)).isSymbolicLink()) return null;
  const handle = await fs.open(file, platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !owned(info, platform) || (platform !== 'win32' && (info.mode & 0o777) !== 0o600)
      || info.size > maxFileBytes) return null;
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export function createReaderPositions({ file, key, platform = process.platform, now = Date.now, log = console.error,
  keyWaitMs = KEY_WAIT_MS, maxFileBytes = MAX_POSITION_FILE_BYTES, codexCode = () => readerCodeHash('./codex-data.mjs', './data-cache.mjs') } = {}) {
  let loading = null, hmacKey = null, off = false, code = '', written = '', writtenAtMs = null, write = Promise.resolve();
  // Counts for the performance view and the tests: valid records at load, and records that a reader took.
  const counts = { loaded: 0, taken: 0 };
  // Saved records that no reader took in this run, by key.
  const saved = new Map();
  const digest = (value) => createHmac('sha256', hmacKey).update(value).digest().subarray(0, 16).toString('hex');
  const recordKey = (filePath) => digest(`codex\0${filePath}`);
  const turnOff = () => {
    if (!off) log('ASB does not use its reader positions: the cache folder is a link or belongs to another user.');
    off = true;
    useRolloutPositions(null);
  };
  const usable = (record, atMs) => record && typeof record === 'object' && HEX32.test(record.k) && HEX32.test(record.guard)
    && Number.isFinite(record.atMs) && record.atMs >= 0 && atMs - record.atMs <= MAX_POSITION_AGE_MS && validRolloutRecord(record);

  const load = async () => {
    let text;
    try { text = await readPrivateFile(file, platform, maxFileBytes); }
    catch (error) {
      if (error instanceof UnsafeFolder) turnOff();
      return;
    }
    let value;
    try { value = JSON.parse(text); } catch { return; }
    if (value?.version !== READER_POSITIONS_VERSION || value.keyCheck !== digest(KEY_CHECK) || value.codex?.code !== code
      || !Array.isArray(value.codex.records)) return;
    const atMs = now();
    for (const record of value.codex.records) {
      if (usable(record, atMs) && !(saved.get(record.k)?.atMs > record.atMs)) saved.set(record.k, record);
    }
    counts.loaded = saved.size;
  };

  const ready = () => loading ||= (async () => {
    let timer;
    // A referenced timer: the wait must keep the event loop alive until the key or the time limit comes.
    const wait = new Promise((resolve) => { timer = setTimeout(resolve, keyWaitMs, null); });
    try { hmacKey = await Promise.race([Promise.resolve().then(key), wait]); }
    catch { hmacKey = null; }
    finally { clearTimeout(timer); }
    // No key, no positions: the readers read as today, and this run saves nothing.
    if (!Buffer.isBuffer(hmacKey) || !hmacKey.length) { hmacKey = null; return; }
    try {
      code = codexCode();
      await load();
    } catch { hmacKey = null; return; }
    if (off) return;
    useRolloutPositions({
      digest,
      take: (filePath) => {
        const k = recordKey(filePath);
        const record = saved.get(k) ?? null;
        saved.delete(k);
        if (record) counts.taken += 1;
        return record;
      },
    });
  })();

  // One synchronous step: the cache entries do not change after they are saved, and a running scan cannot change this list.
  const serialize = (atMs) => {
    const records = new Map(saved);
    for (const [filePath, entry] of rolloutPositionRecords()) {
      const record = { k: recordKey(filePath), ...entry, guard: digest(entry.guard) };
      // A record with an ID that is not a plain ID is not written: that log gets a full read at the next start.
      if (usable(record, atMs)) records.set(record.k, record);
    }
    const head = `{"version":${READER_POSITIONS_VERSION},"keyCheck":"${digest(KEY_CHECK)}","codex":{"code":"${code}","records":[`;
    const kept = [];
    let bytes = head.length + 3;
    for (const record of [...records.values()].sort((a, b) => b.atMs - a.atMs)) {
      if (kept.length >= MAX_POSITION_RECORDS) break;
      const text = JSON.stringify(record);
      if (text.length > MAX_POSITION_RECORD_BYTES) continue;
      if (bytes + text.length + 1 > maxFileBytes) break;
      kept.push(text);
      bytes += text.length + 1;
    }
    return `${head}${kept.join(',')}]}}`;
  };

  const writeFile = async (text) => {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await checkFolder(directory, platform, true);
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  };

  const save = (force) => {
    if (!loading) return write;
    // Writes run one at a time, and the chain never rejects.
    return write = write.then(async () => {
      await loading;
      if (!hmacKey || off) return;
      const atMs = now();
      if (!force && writtenAtMs !== null && atMs - writtenAtMs < POSITION_SAVE_INTERVAL_MS) return;
      const text = serialize(atMs);
      if (text === written) return;
      writtenAtMs = atMs;
      await writeFile(text);
      written = text;
    }).catch((error) => {
      if (error instanceof UnsafeFolder) turnOff();
      else log('ASB cannot save its reader positions. It keeps the old file.');
    });
  };

  return { ready, scanDone: () => save(false), flush: () => save(true), stats: () => ({ ...counts }) };
}
