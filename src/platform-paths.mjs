import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The ASB folders for each system (plan 14.2). Linux values stay as before: a relative XDG value is used as it is.
// Each branch uses its own path rules, so tests can check both systems on either one.
const windowsBase = (env, name, home, fallback) => typeof env[name] === 'string' && path.win32.isAbsolute(env[name])
  ? env[name] : path.win32.join(home, 'AppData', fallback);

export function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(windowsBase(env, 'APPDATA', home, 'Roaming'), 'asb');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'asb');
}

export function stateDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(windowsBase(env, 'LOCALAPPDATA', home, 'Local'), 'asb', 'state');
  return path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'), 'asb');
}

// Linux uses an absolute XDG_RUNTIME_DIR. Without it, asb/run in an absolute XDG_STATE_HOME, else in <home>/.local/state
// (plan L7, the same rule as ASB Bridge). stateDir keeps the old rule for the logs.
const absolute = (value) => typeof value === 'string' && path.posix.isAbsolute(value);
export function runtimeDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(windowsBase(env, 'LOCALAPPDATA', home, 'Local'), 'asb', 'run');
  return absolute(env.XDG_RUNTIME_DIR) ? path.posix.join(env.XDG_RUNTIME_DIR, 'asb')
    : path.posix.join(absolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.posix.join(home, '.local', 'state'), 'asb', 'run');
}

// The cache folder: the rule of scripts/asb-board.py on Linux, where only an absolute XDG_CACHE_HOME counts.
export function cacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(windowsBase(env, 'LOCALAPPDATA', home, 'Local'), 'asb', 'cache');
  return path.posix.join(absolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.posix.join(home, '.cache'), 'asb');
}

// A regular file; other systems than Windows also need the execute bit.
async function executableFile(file, platform) {
  try {
    await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return (await stat(file)).isFile();
  } catch (error) {
    if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

// The PATH search of a shell, with the file it found ('' when none). Windows splits PATH with ';' and tries
// each PATHEXT extension; other systems need the execute bit. scripts/asb-bridge.mjs has the same search.
export async function findExecutable(name, { platform = process.platform, env = process.env, searchPath = env.PATH || '', cwd = process.cwd() } = {}) {
  const windows = platform === 'win32';
  const names = windows ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => name + extension.toLowerCase()) : [name];
  for (const directory of searchPath.split(windows ? ';' : path.delimiter)) {
    for (const candidate of names) {
      const file = path.resolve(cwd, directory, candidate);
      if (await executableFile(file, platform)) return file;
    }
  }
  return '';
}

// The folders where the Bun installer puts bun: <BUN_INSTALL>/bin, then <home>/.bun/bin (Windows: USERPROFILE, else HOME).
// Only an absolute path counts. The engine can start with a shorter PATH than the user shell (HKCU Run at sign-in, a systemd
// user service), and the installer adds this folder to the user PATH only.
export function bunFolders({ platform = process.platform, env = process.env } = {}) {
  const windows = platform === 'win32';
  const flavor = windows ? path.win32 : path.posix;
  const home = env[windows ? 'USERPROFILE' : 'HOME'];
  return [...new Set([env.BUN_INSTALL, home && flavor.join(home, '.bun')]
    .filter((root) => typeof root === 'string' && flavor.isAbsolute(root)).map((root) => flavor.join(root, 'bin')))];
}

// The Bun file for the engine ('' when none): PATH first, then the folders of bunFolders. `check` tells if a file can run.
export async function findBun({ platform = process.platform, env = process.env, check = executableFile } = {}) {
  const onPath = await findExecutable('bun', { platform, env });
  if (onPath) return onPath;
  for (const folder of bunFolders({ platform, env })) {
    const file = (platform === 'win32' ? path.win32 : path.posix).join(folder, platform === 'win32' ? 'bun.exe' : 'bun');
    if (await check(file, platform)) return file;
  }
  return '';
}

// The text for "no Bun": it names the folders that findBun tried after PATH.
export const bunNotFound = (folders) => `Bun was not found on PATH${folders.length ? ` or in ${folders.join(' or ')}` : ''}.`;
