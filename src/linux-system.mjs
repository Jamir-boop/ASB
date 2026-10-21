import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, rmSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cacheDir, findExecutable } from './platform-paths.mjs';

// The tools that ASB needs on Linux (plan L1, L3). Every PATH search uses findExecutable.
const execFileAsync = promisify(execFileCallback);
export const SYSTEM_PYTHON = '/usr/bin/python3';
// The default MSYS2 UCRT64 install; it has GTK 4 and Libadwaita for the board.
export const MSYS2_PYTHON = 'C:\\msys64\\ucrt64\\bin\\python.exe';
export const BOARD_FLOORS = { python: [3, 9], gtk: [4, 12], adw: [1, 4] };

// One JSON object on stdout. It must run on old Python releases too, so that doctor can report their version.
// GTK and Libadwaita import without a display.
export const PYTHON_PROBE = `import json, os, sys
r = {'python': '%d.%d.%d' % tuple(sys.version_info[:3]), 'gi': None, 'gtk': None, 'adw': None, 'glib': None,
     'cairo': False, 'qrcode': False, 'trayHost': None}
try:
    import qrcode
    r['qrcode'] = True
except Exception:
    pass
try:
    import gi
    r['gi'] = gi.__version__
except Exception:
    gi = None
if gi is not None:
    try:
        from gi.repository import GLib, Gio
        r['glib'] = [GLib.MAJOR_VERSION, GLib.MINOR_VERSION, GLib.MICRO_VERSION]
        if os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
            try:
                bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                reply = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
                                      GLib.Variant('(s)', ('org.kde.StatusNotifierWatcher',)), GLib.VariantType.new('(b)'),
                                      Gio.DBusCallFlags.NONE, 1000, None)
                r['trayHost'] = bool(reply.unpack()[0])
            except Exception:
                pass
    except Exception:
        pass
    try:
        gi.require_version('Gtk', '4.0')
        from gi.repository import Gtk
        r['gtk'] = [Gtk.get_major_version(), Gtk.get_minor_version(), Gtk.get_micro_version()]
    except Exception:
        pass
    try:
        gi.require_version('Adw', '1')
        from gi.repository import Adw
        r['adw'] = [Adw.get_major_version(), Adw.get_minor_version(), Adw.get_micro_version()]
    except Exception:
        pass
    try:
        gi.require_foreign('cairo')
        r['cairo'] = True
    except Exception:
        pass
print(json.dumps(r))
`;

const parts = (value) => (Array.isArray(value) ? value : String(value).split('.')).map(Number);
// True when the version is at least the floor (major, minor).
export const atLeast = (value, [major, minor]) => {
  const [a = 0, b = 0] = parts(value);
  return a > major || (a === major && b >= minor);
};
export const shortVersion = (value) => parts(value).slice(0, 2).join('.');

async function isExecutableFile(file) {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch { return false; }
}

// An absolute ASB_PYTHON is the only candidate; the user or a package chose it.
// Else /usr/bin/python3 then python3 on PATH; on win32, MSYS2 Python then python on PATH (PATHEXT).
export async function pythonCandidates(env = process.env, { platform = process.platform,
  system = platform === 'win32' ? MSYS2_PYTHON : SYSTEM_PYTHON } = {}) {
  const windows = platform === 'win32';
  if (typeof env.ASB_PYTHON === 'string' && (windows ? path.win32 : path).isAbsolute(env.ASB_PYTHON)) return [env.ASB_PYTHON];
  const candidates = [];
  if (await isExecutableFile(system)) candidates.push(system);
  const found = await findExecutable(windows ? 'python' : 'python3', { platform, env });
  if (found && !candidates.includes(found)) candidates.push(found);
  return candidates;
}

// The probe result, or null when this Python does not run or prints no JSON object.
export async function probePython(python, { execFile = execFileAsync, env = process.env } = {}) {
  try {
    const { stdout } = await execFile(python, ['-c', PYTHON_PROBE], { env, timeout: 5000 });
    const value = JSON.parse(String(stdout));
    return value && typeof value === 'object' && typeof value.python === 'string' ? value : null;
  } catch { return null; }
}

// Probe the candidates in order and use the first with PyGObject. Without one, `python` is the first Python that runs.
export async function boardCheck({ env = process.env, execFile = execFileAsync, candidates, platform = process.platform } = {}) {
  const list = candidates ?? await pythonCandidates(env, { platform });
  let python = null;
  let versions = null;
  for (const candidate of list) {
    const result = await probePython(candidate, { execFile, env });
    if (!result) continue;
    if (!versions) { python = candidate; versions = result; }
    if (result.gi) { python = candidate; versions = result; break; }
  }
  const reasons = [];
  if (!versions) reasons.push(list.length ? 'Python 3 does not run.' : 'Python 3 is not installed.');
  else {
    if (!atLeast(versions.python, BOARD_FLOORS.python)) reasons.push(`Python ${shortVersion(versions.python)} is older than 3.9.`);
    if (!versions.gi) reasons.push('PyGObject is not installed.');
    else {
      if (!versions.gtk) reasons.push('GTK 4 is not installed.');
      else if (!atLeast(versions.gtk, BOARD_FLOORS.gtk)) reasons.push(`GTK ${shortVersion(versions.gtk)} is older than 4.12.`);
      if (!versions.adw) reasons.push('Libadwaita is not installed.');
      else if (!atLeast(versions.adw, BOARD_FLOORS.adw)) reasons.push(`Libadwaita ${shortVersion(versions.adw)} is older than 1.4.`);
    }
  }
  return { ok: !reasons.length, python, versions, reason: reasons.join(' ') };
}

// Only the window launcher (scripts/asb-desktop.mjs) keeps a good board check, in the cache folder. doctor and setup always probe.
export const boardCheckFile = (env = process.env, platform = process.platform) =>
  (platform === 'win32' ? path.win32 : path.posix).join(cacheDir(env, platform), 'board-check.json');

// The kept check is good while this key is the same: the ASB version, the system, the Python candidates, and the size and time of the kept Python file.
async function boardKey({ version, platform, candidates, python }) {
  const { size, mtimeMs } = await stat(python);
  return { version, platform, candidates, size, mtimeMs };
}

// A good result, or a new `boardCheck` when the file is missing, not valid, or for other values. A failed check is never kept.
// A write error never stops the caller.
export async function cachedBoardCheck({ env = process.env, execFile = execFileAsync, platform = process.platform,
  candidates, file = boardCheckFile(env, platform), version } = {}) {
  const list = candidates ?? await pythonCandidates(env, { platform });
  let key;
  try {
    key = { version: version ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, platform, candidates: list };
    const kept = JSON.parse(await readFile(file, 'utf8'));
    // The Python must be a current candidate, so that the file cannot name a program of its own.
    if (list.includes(kept.python) && typeof kept.versions?.python === 'string'
      && JSON.stringify(kept.key) === JSON.stringify(await boardKey({ ...key, python: kept.python }))) {
      return { ok: true, python: kept.python, versions: kept.versions, reason: '' };
    }
  } catch { /* No usable file: probe. */ }
  const board = await boardCheck({ env, execFile, candidates: list, platform });
  if (board.ok && key) {
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const text = JSON.stringify({ python: board.python, versions: board.versions, key: await boardKey({ ...key, python: board.python }) });
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${text}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch { /* Without the file, the next start probes again. */ } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return board;
}

// The launcher calls this when the board ends with an error, so that the next start probes again. A missing file is not an error.
export const forgetBoardCheck = ({ env = process.env, platform = process.platform, file = boardCheckFile(env, platform) } = {}) =>
  rmSync(file, { force: true });

// The running Node.js: its path, version, and whether node:sqlite loads.
export async function nodeFacts() {
  let sqlite = true;
  try { await import('node:sqlite'); } catch { sqlite = false; }
  return { path: process.execPath, version: process.versions.node, sqlite };
}

// The engine tier (plan L1). `node` is the result of nodeFacts, or null when there is no Node.js.
export async function engineCheck({ env = process.env, node } = {}) {
  const facts = node === undefined ? await nodeFacts() : node;
  const reasons = [];
  if (!facts) reasons.push('Node.js is not installed.');
  else if (Number(facts.version.split('.')[0]) < 20) reasons.push(`Node.js ${facts.version} is older than 20.`);
  const sqlite3 = facts?.sqlite ? '' : await findExecutable('sqlite3', { env });
  if (!facts?.sqlite && !sqlite3) reasons.push('ASB needs Node.js with built-in SQLite (22.13 or later) or the sqlite3 command.');
  const openssl = await findExecutable('openssl', { env });
  if (!openssl) reasons.push('openssl is not installed.');
  const xdgOpen = await findExecutable('xdg-open', { env });
  if (!xdgOpen) reasons.push('xdg-open is not installed (xdg-utils).');
  return { ok: !reasons.length, reason: reasons.join(' '), node: facts, sqlite3, openssl, xdgOpen };
}
