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

// Linux needs an absolute XDG_RUNTIME_DIR; without it there is no runtime folder (null).
export function runtimeDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(windowsBase(env, 'LOCALAPPDATA', home, 'Local'), 'asb', 'run');
  return typeof env.XDG_RUNTIME_DIR === 'string' && path.posix.isAbsolute(env.XDG_RUNTIME_DIR) ? path.posix.join(env.XDG_RUNTIME_DIR, 'asb') : null;
}
