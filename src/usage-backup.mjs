// Daily usage backups: the export document of every machine (src/activity-usage.mjs exportAll) in a folder, one file per
// local day, and only the newest files of this machine are kept. Other files in the folder are never touched.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configDir } from './platform-paths.mjs';
import { validName } from './machine-group.mjs';
import { MACHINE_ID } from './usage-ledger.mjs';
import { writePrivateJson } from './usage-scan-cache.mjs';

// Five minutes after the first ledger read (LEDGER_FIRST_MS), so machines that restart together (an update) answer with their usage.
export const BACKUP_FIRST_MS = 15 * 60 * 1000;
export const BACKUP_CHECK_MS = 15 * 60 * 1000;
export const DEFAULT_BACKUP_SETTINGS = Object.freeze({ enabled: true, time: '03:00', keep: 5, folder: '' });
const SETTINGS_VERSION = 1;
const KEYS = ['enabled', 'time', 'keep', 'folder'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const ID8 = /^[0-9a-f]{8}$/;
const MAX_FILES = 100;
const FAILED = 'ASB cannot make the usage backup.';

const paths = (platform) => platform === 'win32' ? path.win32 : path.posix;

export function usageBackupPath(env = process.env, platform = process.platform) {
  return paths(platform).join(configDir(env, platform), 'usage', 'usage-backup.json');
}

const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const pad = (value) => String(value).padStart(2, '0');
const localDate = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
// The backup time of the local day of nowMs, plus days.
const backupTime = (nowMs, time, days = 0) => {
  const date = new Date(nowMs);
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hours, minutes, 0, 0).getTime();
};
const reason = (error) => ['EACCES', 'EPERM'].includes(error?.code) ? 'no permission' : error?.code === 'ENOSPC' ? 'the disk is full'
  : error?.code === 'EROFS' ? 'the disk is read-only' : error?.code ? `error ${error.code}` : 'an error';
const text = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// The settings without the version, or null. The folder is '' (the default folder) or an absolute path.
function validSettings(value) {
  if (!exact(value, KEYS) || typeof value.enabled !== 'boolean' || typeof value.time !== 'string' || !TIME.test(value.time)
    || !Number.isInteger(value.keep) || value.keep < 1 || value.keep > 30 || typeof value.folder !== 'string'
    || value.folder.length > 1024 || CONTROL.test(value.folder)) return null;
  return { enabled: value.enabled, time: value.time, keep: value.keep, folder: value.folder };
}

// The backup files of this machine: regular files only, any machine name, so a renamed machine still finds its old files.
async function machineFiles(folder, id8) {
  if (!ID8.test(id8)) return [];
  const pattern = new RegExp(`^asb-usage-[A-Za-z0-9][A-Za-z0-9._-]{0,31}-${id8}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  const files = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const match = entry.isFile() && pattern.exec(entry.name);
    if (match) files.push({ name: entry.name, date: match[1] });
  }
  return files.sort((a, b) => text(b.date, a.date) || text(a.name, b.name));
}

export function createUsageBackup({ settingsFile, exportAll, machineId = () => '', platform = process.platform, now = Date.now,
  log = console.error, timers = { setTimeout, clearTimeout } }) {
  const p = paths(platform);
  const defaultPath = p.join(p.dirname(settingsFile), 'backups');
  let settings = null;
  let settingsLoad = null;
  let knownId = '';
  let running = null;
  let writing = null;
  let lastError = null;
  let lastLogged = null;
  const rmLogged = new Set();
  let timer = null;
  let started = false;
  let stopped = false;

  const folderOf = (current) => current.folder || defaultPath;
  const id8 = () => (knownId || machineId() || '').slice(0, 8);

  // A missing file gives the defaults; a bad one too, with one log line, and it stays until the next save replaces it.
  function loadSettings() {
    if (settings) return Promise.resolve(settings);
    return settingsLoad ||= (async () => {
      let value = null;
      try { value = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch (error) {
        if (error.code === 'ENOENT') return { ...DEFAULT_BACKUP_SETTINGS };
      }
      const loaded = exact(value, ['version', ...KEYS]) && value.version === SETTINGS_VERSION
        ? validSettings(Object.fromEntries(KEYS.map((key) => [key, value[key]]))) : null;
      if (loaded && (loaded.folder === '' || p.isAbsolute(loaded.folder))) return loaded;
      log('ASB cannot read its usage backup settings. It uses the defaults.');
      return { ...DEFAULT_BACKUP_SETTINGS };
    })().then((value) => settings ||= value);
  }

  async function backup(startMs) {
    const current = await loadSettings();
    const folder = folderOf(current);
    if (current.folder) {
      const info = await fs.stat(folder).catch(() => null);
      if (!info?.isDirectory()) throw fail(500, `The backup folder does not exist: ${folder}.`);
    }
    let document;
    try { document = await exportAll(); } catch (error) {
      throw error?.statusCode === 409 ? fail(409, error.message) : fail(500, FAILED);
    }
    // A stop during the export: nothing is written.
    if (stopped) return null;
    const first = document?.machines?.[0];
    if (typeof first?.machineId !== 'string' || !MACHINE_ID.test(first.machineId) || !validName(first.name)) throw fail(500, FAILED);
    knownId = first.machineId;
    const name = `asb-usage-${first.name}-${knownId.slice(0, 8)}-${localDate(startMs)}.json`;
    const file = p.join(folder, name);
    writing = (async () => {
      try {
        if (!current.folder) await writePrivateJson(file, document, { platform });
        else {
          // A custom folder is the user's: it is never made and its mode stays.
          const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
          try {
            const handle = await fs.open(temporary, 'wx', 0o600);
            try {
              await handle.writeFile(JSON.stringify(document));
              await handle.sync();
            } finally { await handle.close(); }
            await fs.rename(temporary, file);
          } finally { await fs.rm(temporary, { force: true }); }
        }
      } catch (error) { throw fail(500, `ASB cannot write the backup to ${folder}: ${reason(error)}.`); }
      // Only after a good write; the new file is never in the list.
      const old = (await machineFiles(folder, knownId.slice(0, 8)).catch(() => [])).filter((item) => item.name !== name);
      for (const item of old.slice(current.keep - 1)) {
        await fs.rm(p.join(folder, item.name)).catch((error) => {
          if (error.code === 'ENOENT' || rmLogged.has(item.name)) return;
          rmLogged.add(item.name);
          log(`ASB cannot delete an old usage backup: ${item.name}.`);
        });
      }
    })();
    try { await writing; } finally { writing = null; }
    return { name, path: file, machines: document.machines.length, hours: document.machines.reduce((sum, machine) => sum + machine.records.length, 0) };
  }

  // One backup at a time: a second caller joins the running one.
  function run() {
    return running ||= (async () => {
      try {
        const made = await backup(now());
        if (made) { lastError = null; lastLogged = null; }
        return made;
      } catch (raw) {
        const error = raw?.statusCode ? raw : fail(500, FAILED);
        lastError = { atMs: now(), message: error.message };
        throw error;
      }
    })().finally(() => { running = null; });
  }

  async function hasToday(current) {
    const today = localDate(now());
    return (await machineFiles(folderOf(current), id8()).catch(() => [])).some((item) => item.date === today);
  }

  // At most BACKUP_CHECK_MS, and exactly at today's backup time when it comes sooner.
  function schedule(delayMs) {
    if (timer) timers.clearTimeout(timer);
    if (delayMs === undefined) {
      const untilTime = backupTime(now(), (settings || DEFAULT_BACKUP_SETTINGS).time) - now();
      delayMs = untilTime > 0 ? Math.min(BACKUP_CHECK_MS, untilTime) : BACKUP_CHECK_MS;
    }
    timer = timers.setTimeout(() => {
      timer = null;
      check().catch(() => {});
    }, delayMs);
    timer?.unref?.();
  }

  async function check() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    try {
      if (stopped) return;
      const current = await loadSettings();
      if (!current.enabled || now() < backupTime(now(), current.time) || await hasToday(current) || stopped) return;
      try { await run(); } catch (error) {
        // A failed scheduled backup logs only a new message.
        if (error.message !== lastLogged) {
          lastLogged = error.message;
          log(error.message);
        }
      }
    } finally {
      if (started && !stopped) schedule();
    }
  }

  async function status() {
    const current = await loadSettings();
    const folder = folderOf(current);
    const list = await machineFiles(folder, id8()).catch(() => []);
    const today = localDate(now());
    const files = [];
    for (const item of list.slice(0, MAX_FILES)) {
      const info = await fs.stat(p.join(folder, item.name)).catch(() => null);
      if (info) files.push({ name: item.name, date: item.date, bytes: info.size, modifiedAtMs: Math.floor(info.mtimeMs) });
    }
    return { enabled: current.enabled, time: current.time, keep: current.keep, folder: current.folder, path: folder, defaultPath,
      nextAtMs: current.enabled ? backupTime(now(), current.time, list.some((item) => item.date === today) ? 1 : 0) : null,
      running: Boolean(running), files, lastError };
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await loadSettings();
      if (!stopped) schedule(BACKUP_FIRST_MS);
    },
    // Waits only for a write and rotation that already started.
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      await writing?.catch(() => {});
    },
    status,
    async saveSettings(body) {
      const next = validSettings(body);
      if (!next) throw fail(400, 'Invalid backup settings.');
      if (next.folder) {
        if (!p.isAbsolute(next.folder)) throw fail(400, 'Use a full folder path.');
        next.folder = p.normalize(next.folder);
        const info = await fs.stat(next.folder).catch(() => null);
        if (!info?.isDirectory()) throw fail(400, 'This folder does not exist.');
      }
      // A load still running must not replace the new settings.
      await loadSettings();
      await writePrivateJson(settingsFile, { version: SETTINGS_VERSION, ...next }, { platform });
      settings = next;
      if (started && !stopped) schedule();
      return status();
    },
    // A backup now, also when the daily backup is off. The caller shows a failure, so nothing is logged.
    async runNow() {
      const made = await run();
      return { ...await status(), made };
    },
    check,
  };
}
