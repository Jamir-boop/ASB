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

// The PATH search of a shell, with the file it found ('' when none). Windows splits PATH with ';' and tries
// each PATHEXT extension; other systems need the execute bit. scripts/asb-bridge.mjs has the same search.
export async function findExecutable(name, { platform = process.platform, env = process.env, searchPath = env.PATH || '', cwd = process.cwd() } = {}) {
  const windows = platform === 'win32';
  const names = windows ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => name + extension.toLowerCase()) : [name];
  for (const directory of searchPath.split(windows ? ';' : path.delimiter)) {
    for (const candidate of names) {
      const file = path.resolve(cwd, directory, candidate);
      try {
        await access(file, windows ? constants.F_OK : constants.X_OK);
        if ((await stat(file)).isFile()) return file;
      } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
    }
  }
  return '';
}
