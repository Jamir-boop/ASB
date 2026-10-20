// Reader positions on disk: a new engine resumes the Codex and Claude lifecycle scans where the last engine stopped.
// The file holds numbers, booleans, fixed kinds, IDs, and keyed digests: no message text and no path.
// A missing, damaged, old, or foreign file, or a record that does not agree with its log, gives the full read of a new engine.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { claudePositionRecords, useClaudePositions, validClaudeRecord } from './claude-data.mjs';
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
  keyWaitMs = KEY_WAIT_MS, maxFileBytes = MAX_POSITION_FILE_BYTES, codexCode = () => readerCodeHash('./codex-data.mjs', './data-cache.mjs'),
  claudeCode = () => readerCodeHash('./claude-data.mjs', './data-cache.mjs') } = {}) {
  let loading = null, hmacKey = null, off = false, written = '', writtenAtMs = null, write = Promise.resolve();
  // One section for each reader, in file order. Each has its own code hash, record checks, and limit of records.
  // `saved` holds the records that no reader took in this run, by key; `loaded` and `taken` are counts for the tests.
  const sections = [
    { name: 'codex', codeOf: codexCode, valid: validRolloutRecord, records: rolloutPositionRecords, use: useRolloutPositions },
    { name: 'claude', codeOf: claudeCode, valid: validClaudeRecord, records: claudePositionRecords, use: useClaudePositions },
  ].map((section) => ({ ...section, code: '', saved: new Map(), loaded: 0, taken: 0 }));
  const digest = (value) => createHmac('sha256', hmacKey).update(value).digest().subarray(0, 16).toString('hex');
  const recordKey = (section, filePath) => digest(`${section.name}\0${filePath}`);
  const turnOff = () => {
    if (!off) log('ASB does not use its reader positions: the cache folder is a link or belongs to another user.');
    off = true;
    for (const section of sections) section.use(null);
  };
  const usable = (section, record, atMs) => record && typeof record === 'object' && HEX32.test(record.k) && HEX32.test(record.guard)
    && Number.isFinite(record.atMs) && record.atMs >= 0 && atMs - record.atMs <= MAX_POSITION_AGE_MS && section.valid(record);

  const load = async () => {
    let text;
    try { text = await readPrivateFile(file, platform, maxFileBytes); }
    catch (error) {
      if (error instanceof UnsafeFolder) turnOff();
      return;
    }
    let value;
    try { value = JSON.parse(text); } catch { return; }
    if (value?.version !== READER_POSITIONS_VERSION || value.keyCheck !== digest(KEY_CHECK)) return;
    const atMs = now();
    // A section with another code hash, or with no records (a file of phase 1 has no claude section), loads nothing.
    for (const section of sections) {
      const part = value[section.name];
      if (part?.code !== section.code || !Array.isArray(part.records)) continue;
      for (const record of part.records) {
        if (usable(section, record, atMs) && !(section.saved.get(record.k)?.atMs > record.atMs)) section.saved.set(record.k, record);
      }
      section.loaded = section.saved.size;
    }
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
      for (const section of sections) section.code = section.codeOf();
      await load();
    } catch { hmacKey = null; return; }
    if (off) return;
    for (const section of sections) {
      section.use({
        digest,
        take: (filePath) => {
          const k = recordKey(section, filePath);
          const record = section.saved.get(k) ?? null;
          section.saved.delete(k);
          if (record) section.taken += 1;
          return record;
        },
      });
    }
  })();

  // One synchronous step: the cache entries do not change after they are saved, and a running scan cannot change this list.
  const serialize = (atMs) => {
    const all = [];
    for (const section of sections) {
      const records = new Map(section.saved);
      for (const [filePath, entry] of section.records()) {
        const record = { k: recordKey(section, filePath), ...entry, guard: digest(entry.guard) };
        // A record with an ID that is not a plain ID is not written: that log gets a full read at the next start.
        if (usable(section, record, atMs)) records.set(record.k, record);
      }
      section.kept = [];
      for (const record of records.values()) all.push([section, record]);
    }
    const head = `{"version":${READER_POSITIONS_VERSION},"keyCheck":"${digest(KEY_CHECK)}"`;
    let bytes = head.length + 1 + sections.reduce((sum, section) => sum + section.name.length + section.code.length + 28, 0);
    // The newest records of both sections share the file limit; each section keeps at most its own count.
    for (const [section, record] of all.sort((a, b) => b[1].atMs - a[1].atMs)) {
      if (section.kept.length >= MAX_POSITION_RECORDS) continue;
      const text = JSON.stringify(record);
      if (text.length > MAX_POSITION_RECORD_BYTES) continue;
      if (bytes + text.length + 1 > maxFileBytes) break;
      section.kept.push(text);
      bytes += text.length + 1;
    }
    return `${head}${sections.map((section) => `,"${section.name}":{"code":"${section.code}","records":[${section.kept.join(',')}]}`).join('')}}`;
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

  // The counts of all sections, or of one section by name.
  const stats = (name) => sections.filter((section) => !name || section.name === name)
    .reduce((sum, section) => ({ loaded: sum.loaded + section.loaded, taken: sum.taken + section.taken }), { loaded: 0, taken: 0 });
  return { ready, scanDone: () => save(false), flush: () => save(true), stats };
}
