import { constants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AppSourceRegistry } from './app-sources.mjs';

// The hook installers never print, log, or return settings content.
export const HOOK_TIMEOUT = 21600;
export const QUESTIONS_ONLY = 'installed (questions only)';
export const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
export const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const installedLauncher = (env) => typeof env.ASB_INSTALLED_LAUNCHER === 'string' && path.isAbsolute(env.ASB_INSTALLED_LAUNCHER)
  ? env.ASB_INSTALLED_LAUNCHER : '';
// A dir under the home folder in `~` form, for text output.
export const homeForm = (dir, home = os.homedir()) => dir === home ? '~' : dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
// The hook command runs through a shell, so a launcher path with shell characters must be quoted.
const shellQuote = (word) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

// The config dir of each enabled Claude profile that ASB reads: the parent of its `projects` folder. The engine and the command use this list.
export const hookTargets = (sources) => [...new Set(sources.filter((source) => source.enabled === true && source.provider === 'claude-desktop-code'
  && typeof source.projectsDir === 'string' && path.isAbsolute(source.projectsDir) && path.basename(source.projectsDir) === 'projects')
  .map((source) => path.dirname(path.resolve(source.projectsDir))))];

// The targets of the saved ASB app sources, read only (no ChatGPT Personal discovery). HOME is the home folder of the engine too.
export const readHookTargets = async (env, platform, targets = hookTargets) => targets(await new AppSourceRegistry({ env, platform, discoverPersonal: false,
  homeDir: typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir() }).read());

// One target: { dir, state } for a target that cannot change, else the real file, its stat, and the parsed value (null: no file).
async function readTarget(dir, fileName) {
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) return { dir, state: 'not found' };
  const link = path.join(dir, fileName);
  const invalid = { dir, state: 'invalid settings' };
  const entry = await fs.lstat(link).catch((error) => error);
  if (entry instanceof Error) {
    if (entry.code !== 'ENOENT') return invalid;
    return { dir, key: path.join(await fs.realpath(dir).catch(() => dir), fileName), file: link, info: null, value: null };
  }
  try {
    // A dangling link fails here: no write.
    const file = await fs.realpath(link);
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return invalid;
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return invalid; }
    if (!object(value) || (value.hooks !== undefined && !object(value.hooks))
      || (value.hooks?.PermissionRequest !== undefined && !Array.isArray(value.hooks.PermissionRequest))) return invalid;
    return { dir, key: file, file, info, value };
  } catch { return invalid; }
}

export const CHANGED = Object.assign(new Error('Settings changed during the install. Run it again.'), { code: 'settings_changed' });

// Writes the REAL file. A new file gets mode 0600 and is linked in place, so a file made at the same time stays.
export async function writeTarget(target, value, { beforeRename = async () => {} } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const mode = target.info ? target.info.mode & 0o7777 : 0o600;
  const temporary = path.join(path.dirname(target.file), `.${path.basename(target.file)}.${randomUUID()}.tmp`);
  const backup = `${target.file}.asb-backup`;
  let madeBackup = false;
  try {
    if (target.info) {
      try { await fs.copyFile(target.file, backup, constants.COPYFILE_EXCL); madeBackup = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await fs.writeFile(temporary, text, { flag: 'wx', mode });
    // The umask can take bits away at open; the file is never more open than the target before this.
    await fs.chmod(temporary, mode);
    await beforeRename(temporary);
    if (!target.info) {
      try { await fs.link(temporary, target.file); } catch (error) { throw error.code === 'EEXIST' ? CHANGED : error; }
      return;
    }
    const now = await fs.stat(target.file);
    if (now.mtimeMs !== target.info.mtimeMs || now.size !== target.info.size) throw CHANGED;
    await fs.rename(temporary, target.file);
    madeBackup = false;
  } catch (error) {
    if (madeBackup) await fs.rm(backup, { force: true }).catch(() => {});
    throw error;
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export function permissionRequestHook({ fileName, matcher, timeout, suffix, questionsMatcher }) {
  const hookCommand = (launcher) => `${shellQuote(launcher)}${suffix}`;
  const ours = (hook) => object(hook) && hook.type === 'command' && typeof hook.command === 'string' && hook.command.endsWith(suffix);
  const hasOurs = (item) => object(item) && Array.isArray(item.hooks) && item.hooks.some(ours);

  function hookState(value, command) {
    const found = [];
    for (const item of value?.hooks?.PermissionRequest || []) {
      if (hasOurs(item)) for (const hook of item.hooks.filter(ours)) found.push({ hook, matcher: item.matcher });
    }
    if (!found.length) return 'not installed';
    const [entry] = found;
    if (found.length !== 1 || entry.hook.timeout !== timeout
      || (command && entry.hook.command !== command)) return 'other launcher';
    return entry.matcher === matcher ? 'installed' : questionsMatcher && entry.matcher === questionsMatcher ? QUESTIONS_ONLY : 'other launcher';
  }

  // An item goes only when removing our hook makes its list empty.
  function withoutOurs(value) {
    const list = value?.hooks?.PermissionRequest;
    if (!Array.isArray(list) || !list.some(hasOurs)) return null;
    const next = [];
    let at = -1;
    for (const item of list) {
      if (!hasOurs(item)) { next.push(item); continue; }
      if (at < 0) at = next.length;
      const kept = item.hooks.filter((hook) => !ours(hook));
      if (kept.length) next.push({ ...item, hooks: kept });
    }
    return { list: next, at };
  }

  function installedValue(value, command) {
    const entry = { matcher, hooks: [{ type: 'command', command, timeout }] };
    if (value === null) return { hooks: { PermissionRequest: [entry] } };
    const { list, at } = withoutOurs(value) || { list: [...(value.hooks?.PermissionRequest || [])], at: -1 };
    list.splice(at < 0 ? list.length : at, 0, entry);
    return { ...value, hooks: { ...value.hooks, PermissionRequest: list } };
  }

  function removedValue(value) {
    const result = value && withoutOurs(value);
    if (!result) return null;
    const hooks = { ...value.hooks, PermissionRequest: result.list };
    if (!result.list.length) delete hooks.PermissionRequest;
    const next = { ...value, hooks };
    if (!Object.keys(hooks).length) delete next.hooks;
    return next;
  }

  async function status(dirs, { launcher = '' } = {}) {
    const command = launcher ? hookCommand(launcher) : '';
    return Promise.all(dirs.map(async (dir) => {
      const target = await readTarget(dir, fileName);
      return { dir, state: target.state || hookState(target.value, command) };
    }));
  }

  // Targets that share one real file get one write and the same result.
  async function change(action, dirs, { launcher = '', beforeRename } = {}) {
    const command = hookCommand(launcher);
    const targets = await Promise.all(dirs.map((dir) => readTarget(dir, fileName)));
    const done = new Map();
    const results = [];
    for (const target of targets) {
      if (target.state) { results.push({ dir: target.dir, result: target.state }); continue; }
      if (!done.has(target.key)) {
        done.set(target.key, (async () => {
          if (action === 'install' && hookState(target.value, command) === 'installed') return 'unchanged';
          const next = action === 'install' ? installedValue(target.value, command) : removedValue(target.value);
          if (!next) return 'not installed';
          // A failed write gives only its result, never the error text.
          try { await writeTarget(target, next, { beforeRename }); } catch (error) { return error === CHANGED ? 'settings changed' : 'cannot write'; }
          return action === 'install' ? 'installed' : 'removed';
        })());
      }
      results.push({ dir: target.dir, result: await done.get(target.key) });
    }
    return results;
  }

  return { hookCommand, hookState, installedValue, removedValue, status, change };
}

// The entry from before phone approvals still answers questions, so install replaces it in place.
export const { hookCommand, hookState, installedValue, removedValue, status: claudeHookStatus, change: changeClaudeHook } = permissionRequestHook({
  fileName: 'settings.json', matcher: '*', timeout: HOOK_TIMEOUT, suffix: ' agent claude-wait', questionsMatcher: 'AskUserQuestion',
});

export const CHANGED_MESSAGE = CHANGED.message;
