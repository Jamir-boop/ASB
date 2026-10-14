import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const NEXT_STEPS = 'Next: open Codex, go to Plugins > ASB Bridge, and trust both hooks. Then restart Codex.\nUse $bridge in Codex and /bridge in Claude Code when you want the usage guide.\nAfter an ASB upgrade, run `asb bridge install` again.';
const USAGE = 'Use: asb bridge status [--json]\n     asb bridge install (--all | --codex-home <path> ... | --claude) [--force]\n     asb bridge uninstall (--all | --codex-home <path> ... | --claude) [--force]';
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
async function executable(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    try {
      const file = path.resolve(directory, name);
      await access(file, constants.X_OK);
      if ((await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) return true;
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return false;
}
export async function checkDependencies() {
  for (const name of ['bun', 'codex']) if (!(await executable(name))) throw new Error(`ASB Bridge needs ${name} on PATH.`);
}
export function runCodex(home, args) {
  try { return execFileSync('codex', args, { env: { ...process.env, CODEX_HOME: absolute(home) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error(`codex ${args.slice(0, 3).join(' ')} failed.`); }
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
  if (config.includes(OLD_PLUGIN)) return { home, skipped: true, warning: OLD_WARNING };
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
  if (options.codexHomes?.length) await checkDependencies();
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
  try { return execFileSync(name, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}
export async function status(options = {}) {
  const targets = await detectTargets(options);
  const root = absolute(options.sourceRoot || ROOT);
  const expectedVersion = JSON.parse(await contents(path.join(root, 'bridge/.codex-plugin/plugin.json'))).version;
  const codex = [];
  for (const home of targets.codexHomes) {
    const config = (await contents(path.join(home, 'config.toml')))?.toString() || '';
    const parsed = sections(config), plugin = parsed.get('plugins."asb-bridge@asb"');
    const versions = (await entries(path.join(home, 'plugins/cache/asb/asb-bridge'))).filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const version = versions.at(-1) || null;
    const hooks = Object.fromEntries(['session_start', 'session_end'].map((event) => [event, parsed.has(`hooks.state."asb-bridge@asb:hooks/hooks.json:${event}:0:0"`)]));
    codex.push({ home, marketplace: { installed: parsed.has('marketplaces.asb'), source: sourceValue(parsed.get('marketplaces.asb')) },
      plugin: { installed: plugin !== undefined, enabled: plugin?.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/m)?.[1] === 'true', versions, version, expectedVersion, versionMatches: version === expectedVersion },
      hooks, skill: await skillState(path.join(home, 'skills/bridge')), oldPlugin: config.includes(OLD_PLUGIN), warning: config.includes(OLD_PLUGIN) ? OLD_WARNING : null,
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
export async function main(args = process.argv.slice(2)) {
  const command = args.shift() || 'status';
  if (command === 'status') {
    if (args.length && (args.length !== 1 || args[0] !== '--json')) throw new Error(USAGE);
    const result = await status();
    if (args[0] === '--json') console.log(JSON.stringify(result));
    else {
      for (const item of result.codex) {
        console.log(`Codex ${item.home}: marketplace ${item.marketplace.source || 'missing'}; plugin ${item.plugin.installed ? item.plugin.enabled ? 'enabled' : 'disabled' : 'missing'}; version ${item.plugin.version || 'missing'} (${item.plugin.versionMatches ? 'current' : `expected ${item.plugin.expectedVersion}`}); hooks start=${item.hooks.session_start} end=${item.hooks.session_end}; skill ${item.skill}; state files ${item.stateFiles}`);
        if (item.warning) console.log(`Warning: ${item.home}: ${item.warning}`);
      }
      console.log(`Claude ${result.claude.home}: skill ${result.claude.skill}; version ${result.claude.version || 'missing'}`);
      console.log(result.claude.requirement);
      console.log(`Live receivers: ${result.liveReceivers}; bun: ${result.versions.bun || 'missing'}; codex: ${result.versions.codex || 'missing'}`);
    }
    return 0;
  }
  if (!['install', 'uninstall'].includes(command)) throw new Error(USAGE);
  const options = { codexHomes: [] };
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
    const targets = await detectTargets();
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
    else console.log(`Codex ${item.home}: ${command === 'install' ? 'installed' : `removed; message history stays at ${item.historyKept}`}`);
  }
  if (result.claude) console.log(`Claude ${result.claude.home}: ${command === 'install' ? 'installed' : 'removed'}`);
  if (command === 'install') console.log(NEXT_STEPS);
  return refused ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`ASB Bridge failed: ${error.message}`); process.exitCode = 1; }
}
