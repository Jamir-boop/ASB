import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralReply } from '../scripts/asb-agy-hook.mjs';
import { CHANGED, MAX_SETTINGS_BYTES, installedLauncher, object, writeTarget } from './claude-hook.mjs';
import { findExecutable } from './platform-paths.mjs';

// The agy hook (`asb agent agy-hook install|remove|status`): one top-level key `asb` in agy's hooks file, with the rules of the
// Claude Code installer. It never prints, logs, or returns other content of the file.
export const AGY_HOOK_TIMEOUT = 10;
export const NO_AGY = 'no agy';
const QUESTION_MATCHER = '^ask_question$';
const LINE_LAUNCHER = /^out=\$\(timeout 5 '([^'\x00-\x1f\x7f]+)' agent agy-hook /;
const TITLE_LAUNCHER = /^'([^'\x00-\x1f\x7f]+)' agent agy-title$/;
const INVALID = { state: 'invalid settings' };

export const agyHome = (env) => typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
export const agyHooksFile = (homeDir) => path.join(homeDir, '.gemini', 'config', 'hooks.json');
export const agySettingsFile = (homeDir) => path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
export const usableLauncher = (launcher) => path.isAbsolute(launcher) && !/['\x00-\x1f\x7f]/.test(launcher);
// The real path of the installed launcher ('' without one); a path that does not exist stays as it is.
export const agyLauncher = async (env) => {
  const launcher = installedLauncher(env);
  return launcher ? fs.realpath(launcher).catch(() => launcher) : '';
};

// A failed hook (exit 127, exit 1, a timeout) denies ask_question in agy, so the shell prints the neutral reply when the client
// printed nothing. `$( )` prints once: never a second reply after a client that printed and then died.
export const agyHookLine = (launcher, event) => `out=$(timeout 5 '${launcher}' agent agy-hook ${event} 2>/dev/null); `
  + `if [ -n "$out" ]; then printf '%s' "$out"; else printf '%s' '${neutralReply(event)}'; fi`;

export function agyHookEntry(launcher) {
  const hooks = (event) => [{ type: 'command', command: agyHookLine(launcher, event), timeout: AGY_HOOK_TIMEOUT }];
  return { SessionStart: hooks('SessionStart'), PreInvocation: hooks('PreInvocation'), Stop: hooks('Stop'),
    PreToolUse: [{ matcher: QUESTION_MATCHER, hooks: hooks('PreToolUse') }], PostToolUse: [{ matcher: QUESTION_MATCHER, hooks: hooks('PostToolUse') }] };
}

export const agyTitleEntry = (launcher) => ({ type: 'command', command: `'${launcher}' agent agy-title`, enabled: true });

// Without a launcher (a doctor outside the installed asb), the launcher of the entry itself counts.
export function agyHookState(value, launcher = '') {
  if (!object(value) || !Object.hasOwn(value, 'asb')) return 'not installed';
  const command = value.asb?.SessionStart?.[0]?.command;
  const used = launcher || (typeof command === 'string' && LINE_LAUNCHER.exec(command)?.[1]) || '';
  return used && JSON.stringify(value.asb) === JSON.stringify(agyHookEntry(used)) ? 'installed' : 'changed';
}

export function agyTitleState(value, launcher = '') {
  if (!object(value) || !Object.hasOwn(value, 'title')) return 'not installed';
  const command = value.title?.command;
  const used = launcher || (typeof command === 'string' && TITLE_LAUNCHER.exec(command)?.[1]) || '';
  return used && JSON.stringify(value.title) === JSON.stringify(agyTitleEntry(used)) ? 'installed' : 'other';
}

// The real file, its stat, and the parsed value (null: no file), or { state } for a file that cannot change.
async function readJsonFile(file) {
  const entry = await fs.lstat(file).catch((error) => error);
  if (entry instanceof Error) return entry.code === 'ENOENT' ? { file, info: null, value: null } : INVALID;
  try {
    // A dangling link fails here: no write.
    const real = await fs.realpath(file);
    const info = await fs.stat(real);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return INVALID;
    let value;
    try { value = JSON.parse(await fs.readFile(real, 'utf8')); } catch { return INVALID; }
    return object(value) ? { file: real, info, value } : INVALID;
  } catch { return INVALID; }
}

export async function agyHookStatus(file, { launcher = '' } = {}) {
  const target = await readJsonFile(file);
  return target.state || agyHookState(target.value, launcher);
}

export async function agyTitleStatus(file, { launcher = '' } = {}) {
  const target = await readJsonFile(file);
  return target.state || agyTitleState(target.value, launcher);
}

// `action` is 'install' or 'remove'. The folder above the file's folder (`~/.gemini`) must exist: agy made it.
export async function changeAgyHook(action, file, { launcher = '', beforeRename } = {}) {
  const config = path.dirname(file);
  if (action === 'install' && !(await fs.stat(path.dirname(config)).catch(() => null))?.isDirectory()) return NO_AGY;
  const target = await readJsonFile(file);
  if (target.state) return target.state;
  let next;
  if (action === 'install') {
    if (agyHookState(target.value, launcher) === 'installed') return 'unchanged';
    next = { ...target.value, asb: agyHookEntry(launcher) };
  } else {
    if (!target.value || !Object.hasOwn(target.value, 'asb')) return 'not installed';
    next = { ...target.value };
    delete next.asb;
  }
  // A failed write gives only its result, never the error text.
  try {
    if (!target.info) await fs.mkdir(config, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await writeTarget(target, next, { beforeRename });
  } catch (error) { return error === CHANGED ? 'settings changed' : 'cannot write'; }
  return action === 'install' ? 'installed' : 'removed';
}

// `action` is 'install' or 'remove'. The folder (`~/.gemini/antigravity-cli`) must exist; never replaces an owner's own title.
export async function changeAgyTitle(action, file, { launcher = '', beforeRename } = {}) {
  const folder = path.dirname(file);
  if (action === 'install' && !(await fs.stat(folder).catch(() => null))?.isDirectory()) return NO_AGY;
  const target = await readJsonFile(file);
  if (target.state) return target.state;
  let next;
  if (action === 'install') {
    const state = agyTitleState(target.value, launcher);
    if (state === 'installed') return 'unchanged';
    if (state === 'other') return 'other';
    next = { ...target.value, title: agyTitleEntry(launcher) };
  } else {
    const state = agyTitleState(target.value, '');
    if (state !== 'installed') return state;
    next = { ...target.value };
    delete next.title;
  }
  try {
    await writeTarget(target, next, { beforeRename });
  } catch (error) { return error === CHANGED ? 'settings changed' : 'cannot write'; }
  return action === 'install' ? 'installed' : 'removed';
}

// asb doctor (read only): a PC without agy and without our keys gets no line.
export async function agyHookDoctor(add, advice, { env = process.env } = {}) {
  const found = Boolean(await findExecutable('agy', { env }));
  const home = agyHome(env);
  const launcher = await agyLauncher(env);
  const state = await agyHookStatus(agyHooksFile(home), { launcher });
  const titleState = await agyTitleStatus(agySettingsFile(home), { launcher });
  if (!found && state === 'not installed' && titleState === 'not installed') return;
  add('agy', 'Options', found ? 'ok' : 'info', `agy: ${found ? 'found' : 'not found'}`);
  add('agy-hook', 'Options', state === 'installed' ? 'ok' : state === 'not installed' ? 'info' : 'warn', `agy hook: ${state}`);
  add('agy-title', 'Options', titleState === 'installed' ? 'ok' : titleState === 'not installed' || titleState === 'other' ? 'info' : 'warn', `agy title: ${titleState}`);
  if (found && state === 'not installed') advice.push('Install the agy hook:', '  asb agent agy-hook install');
}
