import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDependencies, detectTargets, hasOldPlugin, installClaude, installCodex, NEXT_STEPS, ROOT, runCodex, skillState } from '../../scripts/asb-bridge.mjs';

const OLD_PLUGIN = 'claude-uds-bridge@leonkohli';
const USAGE = 'Use: node bridge/scripts/migrate-from-claude-uds-bridge.mjs [--apply] [--codex-home <path> ...]';
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Bridge paths must be absolute and have no control characters.');
  return path.resolve(value);
}
function info(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function safeParents(file) {
  for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const entry = info(directory);
    if (entry && !entry.isDirectory()) throw new Error(`Migration will not use a linked or non-directory path: ${directory}`);
  }
}
function safeFile(file) {
  safeParents(file);
  const entry = info(file);
  if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new Error(`Migration will not use a linked or non-file path: ${file}`);
  return entry;
}
function safeState(directory) {
  safeParents(directory);
  const entry = info(directory);
  if (!entry) return;
  if (!entry.isDirectory()) throw new Error(`Migration will not use a linked or non-directory state path: ${directory}`);
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name), child = info(file);
    if (child?.isDirectory()) safeState(file);
    else if (!child?.isFile() || child.nlink !== 1) throw new Error(`Migration will not use a linked or non-file state path: ${file}`);
  }
}
async function checkSkill(home) {
  const directory = path.join(home, 'skills/bridge');
  safeParents(path.join(directory, '.asb-bridge.json'));
  const state = await skillState(directory);
  if (!['ok', 'missing'].includes(state)) throw new Error(`Migration will not change a ${state} bridge skill: ${directory}`);
}
function runningCodex() {
  let output;
  try { output = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('Migration cannot check running processes with ps.'); }
  return output.split('\n').filter((line) => {
    const args = line.match(/^\s*\d+\s+(.+)$/)?.[1]?.trim().split(/\s+/);
    if (!args?.length) return false;
    const executable = path.basename(args[0]);
    return args[0] === '/usr/lib/chatgpt/ChatGPT' || executable === 'codex'
      || (['node', 'bun'].includes(executable) && args.slice(1).some((arg) => ['codex', 'codex.js'].includes(path.basename(arg))))
      || (args.includes('--receive') && args.some((arg) => arg.includes('claude-uds-bridge') && arg.endsWith('/dist/hook.js')));
  });
}
export async function main(args = process.argv.slice(2)) {
  const requested = [];
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--codex-home' && args[i + 1] && !args[i + 1].startsWith('--')) requested.push(absolute(args[++i]));
    else throw new Error(USAGE);
  }
  const refusals = [], homes = [];
  const check = async (action) => {
    try { await action(); }
    catch (error) { refusals.push(error.message); }
  };
  let candidates = [...new Set(requested)];
  if (!candidates.length) await check(async () => { candidates = (await detectTargets()).codexHomes; });
  for (const home of candidates) await check(() => {
    const file = path.join(home, 'config.toml');
    if (safeFile(file) && hasOldPlugin(readFileSync(file, 'utf8'))) homes.push(home);
  });
  if (!homes.length && !refusals.length) { console.log('Nothing to migrate.'); return 0; }
  const claudeHome = absolute(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  for (const home of homes) {
    console.log(`Codex ${home}:\n  codex plugin remove ${OLD_PLUGIN}\n  codex plugin marketplace remove leonkohli\n  Rename ${path.join(home, 'plugin-state/claude-uds-bridge')} to ${path.join(home, 'plugin-state/asb-bridge')} if the old state exists.\n  Install ASB Bridge and the $bridge skill.`);
  }
  if (homes.length) console.log(`Claude ${claudeHome}: install the /bridge skill once.`);
  await check(() => {
    const lines = runningCodex();
    if (lines.length) refusals.push(`Codex processes are running. Quit them before migration:\n${lines.join('\n')}`);
  });
  await check(checkDependencies);
  for (const file of ['.agents/plugins/marketplace.json', 'bridge/dist/server.js', 'bridge/agent-skills/codex/bridge/SKILL.md', 'bridge/agent-skills/codex/bridge/agents/openai.yaml', 'bridge/agent-skills/claude/bridge/SKILL.md']) {
    await check(() => { if (!safeFile(path.join(ROOT, file))) throw new Error(`Missing ASB Bridge runtime file: ${file}`); });
  }
  for (const home of homes) {
    for (const name of ['claude-uds-bridge', 'asb-bridge']) await check(() => safeState(path.join(home, 'plugin-state', name)));
    await check(() => {
      const target = path.join(home, 'plugin-state/asb-bridge');
      if (info(target)?.isDirectory() && readdirSync(target).length) throw new Error(`Target state folder is not empty: ${target}`);
    });
    for (const directory of ['plugins/cache/leonkohli/claude-uds-bridge', 'plugins/marketplaces/leonkohli', 'plugins/cache/asb/asb-bridge', 'plugins/marketplaces/asb']) {
      await check(() => safeParents(path.join(home, directory, '.check')));
    }
    await check(() => checkSkill(home));
  }
  if (homes.length) await check(() => checkSkill(claudeHome));
  if (refusals.length) { for (const reason of refusals) console.error(`Refused: ${reason}`); return 1; }
  if (!apply) { console.log('Dry run only. Use --apply to migrate.'); return 0; }
  for (const home of homes) {
    runCodex(home, ['plugin', 'remove', OLD_PLUGIN]);
    runCodex(home, ['plugin', 'marketplace', 'remove', 'leonkohli']);
    const oldState = path.join(home, 'plugin-state/claude-uds-bridge');
    if (info(oldState)) renameSync(oldState, path.join(home, 'plugin-state/asb-bridge'));
    const result = await installCodex(home);
    if (!result.installed) throw new Error(`Codex did not remove the old plugin from ${home}: ${result.warning}`);
    console.log(`Codex ${home}: migrated.`);
  }
  await installClaude(claudeHome);
  console.log(NEXT_STEPS);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`ASB Bridge migration failed: ${error.message}`); process.exitCode = 1; }
}
