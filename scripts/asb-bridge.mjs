import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const NEXT_STEPS = 'Next: open Codex, go to Plugins > ASB Bridge, and trust both hooks. Then restart Codex.\nUse $bridge in Codex and /bridge in Claude Code when you want the usage guide.\nAfter an ASB upgrade, run `asb bridge install` again.';
const USAGE = 'Use: asb bridge status [--json]\n     asb bridge install (--all | --codex-home <path> ... | --claude) [--force]\n     asb bridge uninstall (--all | --codex-home <path> ... | --claude) [--force]\n     asb bridge link-claude <profile-home> <shared-home>';
const RECORD = '.asb-bridge.json';
const OLD_PLUGIN = 'claude-uds-bridge@leonkohli';
const OLD_WARNING = 'the old claude-uds-bridge plugin is installed here; run bridge/scripts/migrate-from-claude-uds-bridge.mjs first';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const defaultClaudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const safeRelativeFile = (name) => name !== RECORD && name.split('/').every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..');

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Bridge paths must be absolute and have no control characters.');
  return path.resolve(value);
}
async function info(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function contents(file) {
  const entry = await info(file);
  if (!entry) return null;
  if (!entry.isFile()) throw new Error(`ASB will not use a linked or non-file path: ${file}`);
  return readFile(file);
}
async function safeParents(file) {
  for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const entry = await info(directory);
    if (entry && !entry.isDirectory()) throw new Error(`ASB will not write through a linked or non-directory path: ${directory}`);
  }
}
const sameFile = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;
async function registryDirectory(directory, privateMode = true) {
  const entry = await info(directory);
  if (!entry?.isDirectory() || entry.uid !== process.getuid?.() || (privateMode ? (entry.mode & 0o777) !== 0o700 : (entry.mode & 0o002))) {
    throw new Error(`Registry directory must be ${privateMode ? 'private (0700), ' : ''}owned by the current user, and not linked: ${directory}`);
  }
  return entry;
}
async function registryParents(file) {
  await safeParents(file);
  for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const entry = await info(directory);
    if (entry && (![0, process.getuid?.()].includes(entry.uid) || ((entry.mode & (directory === path.dirname(file) ? 0o002 : 0o022)) && !(entry.uid === 0 && (entry.mode & 0o1000))))) {
      throw new Error(`Unsafe registry parent: ${directory}`);
    }
  }
}
async function registryFiles(directory) {
  await registryDirectory(directory);
  const files = new Map();
  for (const name of (await readdir(directory)).sort()) {
    const key = /^[1-9][0-9]*\.[a-f0-9]{64}\.key$/.test(name);
    if (!key && !/^[1-9][0-9]*\.json$/.test(name)) throw new Error(`Unsupported registry entry: ${path.join(directory, name)}`);
    const file = path.join(directory, name), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.uid !== process.getuid?.() || entry.nlink !== 1 || (entry.mode & (key ? 0o077 : 0o002)) || entry.size > (key ? 4096 : 256 * 1024)) throw new Error(`Unsafe registry file: ${file}`);
      const bytes = await handle.readFile(), after = await handle.stat();
      if (!sameFile(entry, await info(file)) || entry.size !== after.size || entry.mtimeMs !== after.mtimeMs || entry.ctimeMs !== after.ctimeMs) throw new Error(`Registry changed during setup: ${directory}`);
      let row;
      try { row = JSON.parse(bytes); } catch { throw new Error(`Invalid registry JSON: ${file}`); }
      if (key ? !/^[a-f0-9]{32}$/.test(row?.peerToken) : !Number.isSafeInteger(row?.pid) || name !== `${row.pid}.json`) throw new Error(`Invalid registry entry: ${file}`);
      files.set(name, { bytes, entry });
    } finally { await handle.close(); }
  }
  return files;
}
function sameRegistry(left, right) {
  return left.size === right.size && [...left].every(([name, value]) => {
    const other = right.get(name);
    return other && sameFile(value.entry, other.entry) && value.entry.mtimeMs === other.entry.mtimeMs && value.entry.ctimeMs === other.entry.ctimeMs && value.bytes.equals(other.bytes);
  });
}
export async function linkClaudeRegistry(home, sharedHome) {
  home = absolute(home); sharedHome = absolute(sharedHome);
  const source = path.join(home, 'sessions'), target = path.join(sharedHome, 'sessions');
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) throw new Error('Registry paths must be separate and must not contain each other.');
  for (const file of [source, target]) await registryParents(file);
  for (const directory of [home, sharedHome]) await registryDirectory(directory, false);
  const targetDirectory = await registryDirectory(target), sourceDirectory = await info(source);
  if (sourceDirectory?.isSymbolicLink()) {
    if (sourceDirectory.uid !== process.getuid?.() || path.resolve(home, await readlink(source)) !== target) throw new Error(`Registry link has another target: ${source}`);
    await registryFiles(target);
    return { home, registry: target, backup: null, linked: false };
  }
  await registryDirectory(source);
  const original = await registryFiles(source), destination = await registryFiles(target), copied = new Map();
  for (const [name, value] of original) {
    if (destination.has(name) && !value.bytes.equals(destination.get(name).bytes)) throw new Error(`Conflicting registry file: ${name}`);
  }
  let holder, backup, moved = false, link;
  try {
    for (const [name, value] of original) {
      if (destination.has(name)) continue;
      const handle = await open(path.join(target, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const entry = await handle.stat();
        copied.set(name, { ...value, entry });
        await handle.writeFile(value.bytes);
      } finally { await handle.close(); }
    }
    if (!sameRegistry(original, await registryFiles(source))) throw new Error(`Registry changed during setup: ${source}`);
    if (!sameFile(sourceDirectory, await info(source)) || !sameFile(targetDirectory, await registryDirectory(target))) throw new Error('Registry directory changed during setup.');
    holder = await mkdtemp(path.join(home, '.asb-bridge-sessions-'));
    backup = path.join(holder, 'sessions');
    await rename(source, backup); moved = true;
    if (!sameFile(sourceDirectory, await info(backup)) || !sameRegistry(original, await registryFiles(backup))) throw new Error(`Registry changed during setup: ${backup}`);
    const merged = await registryFiles(target);
    if ([...original].some(([name, value]) => !merged.get(name)?.bytes.equals(value.bytes))) throw new Error(`Shared registry changed during setup: ${target}`);
    await symlink(target, source, 'dir');
    link = await info(source);
    if (!sameRegistry(original, await registryFiles(backup))) throw new Error(`Registry changed during setup: ${backup}`);
    if (!link?.isSymbolicLink() || !sameFile(link, await info(source)) || await readlink(source) !== target || !sameFile(targetDirectory, await registryDirectory(target))) throw new Error('Registry link changed during setup.');
    return { home, registry: target, backup, linked: true };
  } catch (error) {
    const retained = [];
    if (moved) {
      try {
        if (link && sameFile(link, await info(source)) && (await info(source))?.isSymbolicLink() && await readlink(source) === target) await unlink(source);
        if (await info(source)) throw new Error('The source path was created by another process.');
        if (!sameFile(sourceDirectory, await info(backup))) throw new Error('The backup directory changed.');
        await rename(backup, source); moved = false;
      } catch { retained.push(`Original registry backup kept at ${backup}.`); }
    }
    if (!moved && sameFile(targetDirectory, await info(target))) {
      for (const [name, value] of copied) {
        const file = path.join(target, name);
        try {
          if (!sameFile(value.entry, await info(file)) || !(await contents(file))?.equals(value.bytes) || !sameFile(value.entry, await info(file))) throw new Error('Copied file changed.');
          await unlink(file);
        } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') retained.push(`Shared registry file kept at ${file}.`); }
      }
    }
    if (holder && !moved) {
      try { await rmdir(holder); } catch { retained.push(`Backup folder kept at ${holder}.`); }
    }
    throw new Error(`${error.message}${retained.length ? ` ${retained.join(' ')}` : ''}`, { cause: error });
  }
}
async function treeFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await treeFiles(root, file));
    else files.push(file);
  }
  return files.sort();
}
export async function skillState(directory) {
  const entry = await info(directory);
  if (!entry) return 'missing';
  if (!entry.isDirectory()) return 'foreign';
  let record;
  try { record = JSON.parse(await contents(path.join(directory, RECORD))); }
  catch { return 'foreign'; }
  if (record?.owner !== 'asb-bridge' || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)
    || !Object.keys(record.files).length || Object.entries(record.files).some(([file, hash]) => !safeRelativeFile(file) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return 'foreign';
  try {
    if (JSON.stringify((await treeFiles(directory)).filter((file) => file !== RECORD)) !== JSON.stringify(Object.keys(record.files).sort())) return 'modified';
    for (const [file, hash] of Object.entries(record.files)) {
      if (digest(await contents(path.join(directory, file))) !== hash) return 'modified';
    }
  } catch { return 'modified'; }
  return 'ok';
}
async function checkSkill(directory, force) {
  await safeParents(path.join(directory, RECORD));
  const state = await skillState(directory);
  if (!force && !['ok', 'missing'].includes(state)) throw new Error(`ASB will not change a ${state} bridge skill: ${directory}. Use --force to replace it.`);
  return state;
}
async function skillFiles(source) {
  const files = await treeFiles(source);
  const bytes = new Map();
  for (const file of files) {
    if (!safeRelativeFile(file)) throw new Error(`Invalid bridge skill file: ${file}`);
    await safeParents(path.join(source, file));
    bytes.set(file, await contents(path.join(source, file)));
    if (!bytes.get(file)) throw new Error(`Missing bridge skill file: ${file}`);
  }
  if (!bytes.size) throw new Error(`Missing bridge skill files: ${source}`);
  return bytes;
}
async function copySkill(bytes, directory, force) {
  await checkSkill(directory, force);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const [file, value] of bytes) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), value, { flag: 'wx' });
  }
  await writeFile(path.join(directory, RECORD), `${JSON.stringify({ owner: 'asb-bridge', files: Object.fromEntries([...bytes].map(([file, value]) => [file, digest(value)])) }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
async function checkRoot(sourceRoot) {
  const root = absolute(sourceRoot);
  for (const file of ['.agents/plugins/marketplace.json', 'bridge/dist/server.js']) {
    if (!(await contents(path.join(root, file)))) throw new Error(`Missing ASB Bridge runtime file: ${file}`);
  }
  return root;
}
async function executable(name, searchPath = process.env.PATH || '', cwd = process.cwd()) {
  for (const directory of searchPath.split(path.delimiter)) {
    try {
      const file = path.resolve(cwd, directory, name);
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return true;
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return false;
}
export async function checkDependencies(names = ['bun', 'codex']) {
  for (const name of names) if (!(await executable(name))) throw new Error(`ASB Bridge needs ${name} on PATH.`);
}
export async function codexBunOnPath(home, options = {}) {
  if ((options.platform || process.platform) !== 'linux') return null;
  home = absolute(home);
  const procRoot = options.procRoot || '/proc';
  let processes;
  try { processes = await readdir(procRoot); }
  catch { return null; }
  let found = false, unknown = false;
  for (const pid of processes.filter((name) => /^\d+$/.test(name)).sort()) {
    const directory = path.join(procRoot, pid);
    let argv;
    try { argv = (await readFile(path.join(directory, 'cmdline'), 'utf8')).split('\0'); }
    catch { continue; }
    if (path.basename(argv[0]) !== 'codex' || !argv.slice(1).includes('app-server')) continue;
    const env = {};
    try {
      for (const field of (await readFile(path.join(directory, 'environ'), 'utf8')).split('\0')) {
        const key = field.slice(0, field.indexOf('='));
        if (['HOME', 'CODEX_HOME', 'PATH'].includes(key)) env[key] = field.slice(key.length + 1);
      }
    } catch { unknown = true; continue; }
    const processHome = env.CODEX_HOME || (path.isAbsolute(env.HOME || '') ? path.join(env.HOME, '.codex') : null);
    if (!processHome || !path.isAbsolute(processHome)) { unknown = true; continue; }
    if (path.resolve(processHome) !== home) continue;
    found = true;
    if (env.PATH === undefined) { unknown = true; continue; }
    let cwd = '/';
    try {
      if (env.PATH.split(path.delimiter).some((part) => !path.isAbsolute(part))) {
        cwd = await readlink(path.join(directory, 'cwd'));
        if (!path.isAbsolute(cwd)) { unknown = true; continue; }
      }
      if (!(await executable('bun', env.PATH, cwd))) return false;
    } catch { unknown = true; }
  }
  return found && !unknown ? true : null;
}
function warnBun(home) {
  console.warn(`Warning: ${home}: bun is missing from a running Codex app-server PATH. Codex cannot start or resume tasks. Run asb bridge uninstall --codex-home '${home.replaceAll("'", "'\\''")}', then make bun visible to desktop apps and restart Codex.`);
}
export function runCodex(home, args) {
  try { return execFileSync('codex', args, { env: { ...process.env, CODEX_HOME: absolute(home) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const reason = String(error.stderr || '').trim().split(/\r?\n/).at(-1).trim().slice(0, 200);
    throw new Error(`codex ${args.slice(0, 3).join(' ')} failed.${reason ? ` ${reason}` : ''}`);
  }
}
function sections(text) {
  const result = new Map();
  let current;
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) { current = header[1]; result.set(current, ''); }
    else if (current) result.set(current, `${result.get(current)}${line}\n`);
  }
  return result;
}
export function hasOldPlugin(config) {
  return sections(config).has(`plugins."${OLD_PLUGIN}"`);
}
function sourceValue(section = '') {
  const value = section.match(/^\s*source\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/m)?.[1];
  if (!value) return null;
  try { return value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value); }
  catch { return null; }
}
async function codexTarget(home, force) {
  home = absolute(home);
  for (const file of ['config.toml', 'plugins/cache/asb/asb-bridge/.check', 'plugins/marketplaces/asb/.check']) await safeParents(path.join(home, file));
  const config = (await contents(path.join(home, 'config.toml')))?.toString() || '';
  if (hasOldPlugin(config)) return { home, skipped: true, warning: OLD_WARNING };
  await checkSkill(path.join(home, 'skills/bridge'), force);
  return { home, config };
}
export async function installCodex(home, options = {}) {
  await checkDependencies();
  const root = await checkRoot(options.sourceRoot || ROOT);
  const target = await codexTarget(home, options.force);
  if (target.skipped) return target;
  const bytes = await skillFiles(path.join(root, 'bridge/agent-skills/codex/bridge'));
  const marketplace = sections(target.config).get('marketplaces.asb');
  // Codex 0.162.1 refuses a changed source; remove the named marketplace before add.
  if (marketplace !== undefined && sourceValue(marketplace) !== root) runCodex(target.home, ['plugin', 'marketplace', 'remove', 'asb']);
  runCodex(target.home, ['plugin', 'marketplace', 'add', root]);
  runCodex(target.home, ['plugin', 'add', 'asb-bridge@asb']);
  await copySkill(bytes, path.join(target.home, 'skills/bridge'), options.force);
  return { home: target.home, installed: true };
}
export async function installClaude(home = defaultClaudeHome(), options = {}) {
  const root = await checkRoot(options.sourceRoot || ROOT);
  home = absolute(home);
  await copySkill(await skillFiles(path.join(root, 'bridge/agent-skills/claude/bridge')), path.join(home, 'skills/bridge'), options.force);
  return { home, installed: true };
}
export async function detectTargets(options = {}) {
  const home = absolute(options.home || os.homedir());
  const codexHomes = [];
  for (const entry of await readdir(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.codex(?:-.+)?$/.test(entry.name)) continue;
    const directory = path.join(home, entry.name);
    if ((await info(path.join(directory, 'config.toml')))?.isFile()) codexHomes.push(directory);
  }
  const claudeHome = absolute(options.claudeHome || defaultClaudeHome());
  return { codexHomes: codexHomes.sort(), claudeHome: (await info(claudeHome))?.isDirectory() ? claudeHome : null };
}
export async function install(options = {}) {
  const codexHomes = [...new Set(options.codexHomes || [])];
  if (codexHomes.length) await checkDependencies();
  await checkRoot(options.sourceRoot || ROOT);
  const codex = [];
  for (const home of codexHomes) codex.push(await installCodex(home, options));
  const claude = options.claudeHome ? await installClaude(options.claudeHome, options) : null;
  return { codex, claude };
}
export async function uninstall(options = {}) {
  if (options.codexHomes?.length) await checkDependencies(['codex']);
  await checkRoot(options.sourceRoot || ROOT);
  const codex = [];
  for (const home of [...new Set(options.codexHomes || [])]) {
    const target = await codexTarget(home, options.force);
    if (target.skipped) { codex.push(target); continue; }
    runCodex(target.home, ['plugin', 'remove', 'asb-bridge@asb']);
    runCodex(target.home, ['plugin', 'marketplace', 'remove', 'asb']);
    await checkSkill(path.join(target.home, 'skills/bridge'), options.force);
    await rm(path.join(target.home, 'skills/bridge'), { recursive: true, force: true });
    codex.push({ home: target.home, removed: true, historyKept: path.join(target.home, 'plugin-state/asb-bridge') });
  }
  const claude = options.claudeHome ? { home: absolute(options.claudeHome), removed: true } : null;
  if (claude) {
    await checkSkill(path.join(claude.home, 'skills/bridge'), options.force);
    await rm(path.join(claude.home, 'skills/bridge'), { recursive: true, force: true });
  }
  return { codex, claude };
}
async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function toolVersion(name) {
  if (!(await executable(name))) return null;
  const codexHome = name === 'codex' ? await mkdtemp(path.join(os.tmpdir(), 'asb-bridge-version-')) : null;
  try { return execFileSync(name, ['--version'], { env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
  finally { if (codexHome) await rm(codexHome, { recursive: true, force: true }); }
}
export async function status(options = {}) {
  const targets = await detectTargets(options);
  const root = absolute(options.sourceRoot || ROOT);
  const expectedVersion = JSON.parse(await contents(path.join(root, 'bridge/.codex-plugin/plugin.json'))).version;
  const codex = [];
  for (const home of targets.codexHomes) {
    const config = (await contents(path.join(home, 'config.toml')))?.toString() || '';
    const parsed = sections(config), plugin = parsed.get('plugins."asb-bridge@asb"');
    const oldPlugin = hasOldPlugin(config);
    const versions = (await entries(path.join(home, 'plugins/cache/asb/asb-bridge'))).filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const version = versions.at(-1) || null;
    const hooks = Object.fromEntries(['session_start', 'session_end'].map((event) => [event, parsed.has(`hooks.state."asb-bridge@asb:hooks/hooks.json:${event}:0:0"`)]));
    codex.push({ home, marketplace: { installed: parsed.has('marketplaces.asb'), source: sourceValue(parsed.get('marketplaces.asb')) },
      plugin: { installed: plugin !== undefined, enabled: plugin?.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/m)?.[1] === 'true', versions, version, expectedVersion, versionMatches: version === expectedVersion },
      hooks, skill: await skillState(path.join(home, 'skills/bridge')), oldPlugin, warning: oldPlugin ? OLD_WARNING : null,
      bunOnAppServerPath: await codexBunOnPath(home, options),
      stateFiles: (await entries(path.join(home, 'plugin-state/asb-bridge'))).filter((entry) => entry.isFile()).length });
  }
  const claudeHome = absolute(options.claudeHome || defaultClaudeHome());
  let liveReceivers = 0;
  for (const entry of await entries(path.join(claudeHome, 'sessions'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(await contents(path.join(claudeHome, 'sessions', entry.name)));
      if (row.entrypoint !== 'codex-asb-bridge' || !Number.isInteger(row.pid) || row.pid <= 0) continue;
      try { process.kill(row.pid, 0); liveReceivers++; } catch (error) { if (error.code === 'EPERM') liveReceivers++; }
    } catch { /* A stale or partial registry row is not a live receiver. */ }
  }
  return { codex, claude: { home: claudeHome, detected: Boolean(targets.claudeHome), skill: await skillState(path.join(claudeHome, 'skills/bridge')), version: await toolVersion('claude'), requirement: 'Cross-session messaging needs Claude Code 2.1.224 or later.' },
    liveReceivers, versions: { bun: await toolVersion('bun'), codex: await toolVersion('codex') } };
}
export async function main(args = process.argv.slice(2), context = {}) {
  const command = args.shift() || 'status';
  if (command === 'link-claude') {
    if (args.length !== 2 || args.some((arg) => arg.startsWith('--'))) throw new Error(USAGE);
    const result = await linkClaudeRegistry(...args);
    console.log(`Claude ${result.home}: registry ${result.registry}; ${result.linked ? `linked; original registry backup ${result.backup}` : 'already linked'}`);
    return 0;
  }
  if (command === 'status') {
    if (args.length && (args.length !== 1 || args[0] !== '--json')) throw new Error(USAGE);
    const result = await status(context);
    if (args[0] === '--json') console.log(JSON.stringify(result));
    else {
      for (const item of result.codex) {
        console.log(`Codex ${item.home}: marketplace ${item.marketplace.source || 'missing'}; plugin ${item.plugin.installed ? item.plugin.enabled ? 'enabled' : 'disabled' : 'missing'}; version ${item.plugin.version || 'missing'} (${item.plugin.versionMatches ? 'current' : `expected ${item.plugin.expectedVersion}`}); hooks start=${item.hooks.session_start} end=${item.hooks.session_end}; skill ${item.skill}; state files ${item.stateFiles}; bun on app-server PATH=${item.bunOnAppServerPath}`);
        if (item.warning) console.log(`Warning: ${item.home}: ${item.warning}`);
      }
      console.log(`Claude ${result.claude.home}: skill ${result.claude.skill}; version ${result.claude.version || 'missing'}`);
      console.log(result.claude.requirement);
      console.log(`Live receivers: ${result.liveReceivers}; bun: ${result.versions.bun || 'missing'}; codex: ${result.versions.codex || 'missing'}`);
    }
    for (const item of result.codex) if (item.bunOnAppServerPath === false) warnBun(item.home);
    return 0;
  }
  if (!['install', 'uninstall'].includes(command)) throw new Error(USAGE);
  const options = { ...context, codexHomes: [] };
  let all = false, claude = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') all = true;
    else if (args[i] === '--claude') claude = true;
    else if (args[i] === '--force') options.force = true;
    else if (args[i] === '--codex-home' && args[i + 1] && !args[i + 1].startsWith('--')) options.codexHomes.push(absolute(args[++i]));
    else throw new Error(USAGE);
  }
  if (all && (claude || options.codexHomes.length)) throw new Error(USAGE);
  if (all || (!claude && !options.codexHomes.length)) {
    const targets = await detectTargets(context);
    if (!all) {
      console.log(`Detected Codex homes: ${targets.codexHomes.join(', ') || 'none'}\nDetected Claude home: ${targets.claudeHome || 'none'}\n${USAGE}`);
      return 0;
    }
    Object.assign(options, targets);
  } else if (claude) options.claudeHome = absolute(defaultClaudeHome());
  const result = await (command === 'install' ? install(options) : uninstall(options));
  let refused = false;
  for (const item of result.codex) {
    if (item.skipped) { console.error(`Warning: ${item.home}: ${item.warning}`); refused = true; }
    else {
      console.log(`Codex ${item.home}: ${command === 'install' ? 'installed' : `removed; message history stays at ${item.historyKept}`}`);
      if (command === 'install' && await codexBunOnPath(item.home, options) === false) warnBun(item.home);
    }
  }
  if (result.claude) console.log(`Claude ${result.claude.home}: ${command === 'install' ? 'installed' : 'removed'}`);
  if (command === 'install') console.log(NEXT_STEPS);
  return refused ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`ASB Bridge failed: ${error.message}`); process.exitCode = 1; }
}
