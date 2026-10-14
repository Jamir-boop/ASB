import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEXT_STEPS, ROOT, skillState } from '../scripts/asb-bridge.mjs';
import { main } from '../bridge/scripts/migrate-from-claude-uds-bridge.mjs';

const SCRIPT = fileURLToPath(new URL('../bridge/scripts/migrate-from-claude-uds-bridge.mjs', import.meta.url));
const OLD_CONFIG = '# Synthetic config\n[marketplaces.leonkohli]\nsource = "/synthetic/old"\n[plugins."claude-uds-bridge@leonkohli"]\nenabled = true\n[hooks.state."claude-uds-bridge@leonkohli:hooks/hooks.json:session_start:0:0"]\ntrusted = true\n';
async function snapshot(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { result[file] = 'directory'; Object.assign(result, await snapshot(directory, file)); }
    else if (entry.isSymbolicLink()) result[file] = `link:${await readlink(path.join(directory, file))}`;
    else result[file] = (await readFile(path.join(directory, file))).toString('base64');
  }
  return result;
}
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-bridge-migrate-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home'), bin = path.join(temporary, 'bin'), log = path.join(temporary, 'calls.log'), ps = path.join(temporary, 'ps.txt');
  const codex = path.join(home, '.codex'), personal = path.join(home, '.codex-personal'), claude = path.join(home, '.claude');
  for (const directory of [bin, codex, personal, claude, path.join(home, '.codex-other')]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(codex, 'config.toml'), OLD_CONFIG);
  await writeFile(path.join(personal, 'config.toml'), '# Synthetic current home\n');
  await mkdir(path.join(codex, 'plugin-state/claude-uds-bridge'), { recursive: true });
  await writeFile(path.join(codex, 'plugin-state/claude-uds-bridge/task.sqlite'), 'Synthetic message history\n');
  await writeFile(ps, '  PID COMMAND\n  101 /usr/bin/sleep 1\n');
  await writeFile(path.join(bin, 'ps'), '#!/bin/sh\n[ "$*" = "-eo pid,args" ] || exit 3\ncat "$BRIDGE_PS"\n', { mode: 0o755 });
  await writeFile(path.join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(bin, 'codex'), `#!/bin/sh\nprintf '%s|%s\\n' "$CODEX_HOME" "$*" >> "$BRIDGE_LOG"\nif [ "$*" = 'plugin remove claude-uds-bridge@leonkohli' ] || [ "$*" = 'plugin marketplace remove leonkohli' ]; then\n  awk -v command="$*" '\n    command == "plugin remove claude-uds-bridge@leonkohli" && /^\\[plugins\\."claude-uds-bridge@leonkohli"\\]/ { skip = 1; next }\n    command == "plugin marketplace remove leonkohli" && /^\\[marketplaces\\.leonkohli\\]/ { skip = 1; next }\n    /^\\[/ { skip = 0 }\n    !skip { print }\n  ' "$CODEX_HOME/config.toml" > "$CODEX_HOME/config.toml.tmp" || exit 4\n  mv "$CODEX_HOME/config.toml.tmp" "$CODEX_HOME/config.toml"\nfi\nif [ "$*" = 'plugin add asb-bridge@asb' ]; then\n  if [ -f "\${BRIDGE_FAIL_ADD-}" ]; then rm "$BRIDGE_FAIL_ADD"; exit 5; fi\n  if [ -f "\${BRIDGE_BLOCK_CLAUDE-}" ]; then rm "$BRIDGE_BLOCK_CLAUDE"; printf '%s\\n' 'Synthetic conflict' > "$CLAUDE_CONFIG_DIR/skills"; fi\nfi\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PATH: `${bin}:/usr/bin:/bin`, BRIDGE_LOG: log, BRIDGE_PS: ps };
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const calls = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { temporary, home, bin, log, ps, codex, personal, claude, env, run, calls };
}
function passed(result) { assert.equal(result.status, 0, result.stderr); }
async function unchanged(f, before) { assert.deepEqual(await f.calls(), []); assert.deepEqual(await snapshot(f.home), before); }

test('migration dry run selects only old plugin homes and changes nothing', async (t) => {
  const f = await fixture(t), before = await snapshot(f.home);
  for (const args of [[], ['--codex-home', f.codex, '--codex-home', f.personal, '--codex-home', f.codex]]) {
    const result = f.run(args);
    passed(result);
    assert.equal(result.stdout.split(`Codex ${f.codex}:`).length, 2);
    assert.ok(!result.stdout.includes(f.personal) && !result.stdout.includes('.codex-other'));
    for (const action of ['plugin remove claude-uds-bridge@leonkohli', 'plugin marketplace remove leonkohli', 'Rename ', 'Install ASB Bridge', 'install the /bridge skill once', 'Dry run only']) assert.ok(result.stdout.includes(action), action);
    assert.ok(result.stdout.indexOf('Keep ') < result.stdout.indexOf('plugin remove '));
    assert.ok(result.stdout.indexOf('Install ASB Bridge') < result.stdout.indexOf('install the /bridge skill once'));
    assert.ok(result.stdout.indexOf('install the /bridge skill once') < result.stdout.indexOf('Rename '));
    await unchanged(f, before);
  }
  assert.equal(typeof main, 'function');
});

test('migration selects an old plugin, old marketplace or old state independently', async (t) => {
  for (const signal of ['plugin', 'marketplace', 'state']) {
    const f = await fixture(t), home = signal === 'state' ? path.join(f.home, '.codex-other') : f.codex;
    await rm(path.join(f.codex, 'plugin-state/claude-uds-bridge'), { recursive: true });
    await writeFile(path.join(f.codex, 'config.toml'), signal === 'plugin' ? '[plugins."claude-uds-bridge@leonkohli"]\nenabled = true\n' : signal === 'marketplace' ? '[marketplaces.leonkohli]\nsource = "/synthetic/old"\n' : '# Synthetic current home\n');
    if (signal === 'state') await mkdir(path.join(home, 'plugin-state/claude-uds-bridge'), { recursive: true });
    const before = await snapshot(f.home), dry = f.run();
    passed(dry);
    assert.ok(dry.stdout.includes(`Codex ${home}:`));
    assert.equal(dry.stdout.includes('codex plugin remove claude-uds-bridge@leonkohli'), signal === 'plugin');
    assert.equal(dry.stdout.includes('codex plugin marketplace remove leonkohli'), signal === 'marketplace');
    await unchanged(f, before);
    passed(f.run(['--apply']));
    assert.deepEqual(await f.calls(), [
      ...(signal === 'plugin' ? [`${home}|plugin remove claude-uds-bridge@leonkohli`] : []),
      ...(signal === 'marketplace' ? [`${home}|plugin marketplace remove leonkohli`] : []),
      `${home}|plugin marketplace add ${path.resolve(ROOT)}`, `${home}|plugin add asb-bridge@asb`,
    ]);
    assert.equal(await skillState(path.join(home, 'skills/bridge')), 'ok');
    assert.deepEqual(await readdir(path.join(home, 'plugin-state/asb-bridge')), []);
    await rm(f.log);
    const after = await snapshot(f.home), second = f.run(['--apply']);
    passed(second);
    assert.equal(second.stdout, 'Nothing to migrate.\n');
    await unchanged(f, after);
  }
});

test('migration refuses all running Codex process forms and prints their lines', async (t) => {
  const f = await fixture(t), before = await snapshot(f.home);
  const lines = ['  201 /usr/lib/chatgpt/ChatGPT --no-sandbox', '  202 /opt/codex/bin/codex app-server --stdio', '  203 codex exec hello', '  204 /usr/bin/node /opt/codex/bin/codex.js resume', '  205 bun /synthetic/claude-uds-bridge/dist/hook.js --receive task'];
  for (const line of lines) {
    await writeFile(f.ps, `  PID COMMAND\n${line}\n`);
    for (const args of [[], ['--apply']]) {
      const result = f.run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Codex processes are running/);
      assert.ok(result.stderr.includes(line));
      await unchanged(f, before);
    }
  }
  await writeFile(f.ps, '  206 node /synthetic/migrate-from-claude-uds-bridge.mjs --codex-home /synthetic/.codex\n  207 bun /synthetic/asb-bridge/dist/hook.js --receive task\n  208 /usr/bin/echo codex app-server\n');
  passed(f.run());
  await unchanged(f, before);
});

test('migration apply uses normal installers and renames history without writing hook trust', async (t) => {
  const f = await fixture(t), history = path.join(f.codex, 'plugin-state/claude-uds-bridge/task.sqlite'), previous = await lstat(history);
  await writeFile(path.join(f.personal, 'config.toml'), OLD_CONFIG);
  const result = f.run(['--apply']);
  passed(result);
  assert.deepEqual(await f.calls(), [f.codex, f.personal].flatMap((home) => [`${home}|plugin remove claude-uds-bridge@leonkohli`, `${home}|plugin marketplace remove leonkohli`, `${home}|plugin marketplace add ${path.resolve(ROOT)}`, `${home}|plugin add asb-bridge@asb`]));
  const moved = path.join(f.codex, 'plugin-state/asb-bridge/task.sqlite');
  assert.equal(await readFile(moved, 'utf8'), 'Synthetic message history\n');
  assert.equal((await lstat(moved)).ino, previous.ino);
  await assert.rejects(lstat(history), { code: 'ENOENT' });
  for (const home of [f.codex, f.personal, f.claude]) assert.equal(await skillState(path.join(home, 'skills/bridge')), 'ok');
  for (const home of [f.codex, f.personal]) {
    const config = await readFile(path.join(home, 'config.toml'), 'utf8');
    assert.ok(!config.includes('[plugins."claude-uds-bridge@leonkohli"]'));
    assert.match(config, /\[hooks\.state\."claude-uds-bridge@leonkohli:/);
    assert.ok(!config.includes('[hooks.state."asb-bridge@asb:'));
  }
  assert.ok(result.stdout.endsWith(`${NEXT_STEPS}\n`));
});

test('migration retries a failed plugin add with and without old history', async (t) => {
  for (const oldExists of [true, false]) {
    const f = await fixture(t), old = path.join(f.codex, 'plugin-state/claude-uds-bridge'), target = path.join(f.codex, 'plugin-state/asb-bridge');
    const inode = (await lstat(path.join(old, 'task.sqlite'))).ino;
    if (!oldExists) await rm(old, { recursive: true });
    const fail = path.join(f.temporary, 'fail-add-once');
    await writeFile(fail, 'Synthetic failure\n');
    const failed = f.run(['--apply'], { BRIDGE_FAIL_ADD: fail });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /codex plugin add asb-bridge@asb failed/);
    assert.ok((await lstat(old)).isDirectory());
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.ok(!(await readFile(path.join(f.codex, 'config.toml'), 'utf8')).includes('[marketplaces.leonkohli]'));
    assert.ok(!(await readFile(path.join(f.codex, 'config.toml'), 'utf8')).includes('[plugins."claude-uds-bridge@leonkohli"]'));
    if (oldExists) assert.equal(await readFile(path.join(old, 'task.sqlite'), 'utf8'), 'Synthetic message history\n');
    else assert.deepEqual(await readdir(old), []);
    await rm(f.log);
    const before = await snapshot(f.home), dry = f.run();
    passed(dry);
    assert.ok(dry.stdout.includes(`Codex ${f.codex}:`));
    assert.ok(!dry.stdout.includes('codex plugin remove ') && !dry.stdout.includes('codex plugin marketplace remove leonkohli'));
    await unchanged(f, before);
    passed(f.run(['--apply'], { BRIDGE_FAIL_ADD: fail }));
    assert.deepEqual(await f.calls(), [`${f.codex}|plugin marketplace add ${path.resolve(ROOT)}`, `${f.codex}|plugin add asb-bridge@asb`]);
    for (const home of [f.codex, f.claude]) assert.equal(await skillState(path.join(home, 'skills/bridge')), 'ok');
    await assert.rejects(lstat(old), { code: 'ENOENT' });
    if (oldExists) {
      assert.equal(await readFile(path.join(target, 'task.sqlite'), 'utf8'), 'Synthetic message history\n');
      assert.equal((await lstat(path.join(target, 'task.sqlite'))).ino, inode);
    } else assert.deepEqual(await readdir(target), []);
  }
});

test('migration keeps every home for retry when Claude skill setup fails', async (t) => {
  const f = await fixture(t), block = path.join(f.temporary, 'block-claude-once');
  await writeFile(path.join(f.personal, 'config.toml'), OLD_CONFIG);
  await writeFile(block, 'Synthetic failure\n');
  const failed = f.run(['--apply'], { BRIDGE_BLOCK_CLAUDE: block });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ENOTDIR/);
  for (const home of [f.codex, f.personal]) {
    assert.ok((await lstat(path.join(home, 'plugin-state/claude-uds-bridge'))).isDirectory());
    await assert.rejects(lstat(path.join(home, 'plugin-state/asb-bridge')), { code: 'ENOENT' });
    assert.equal(await skillState(path.join(home, 'skills/bridge')), 'ok');
  }
  await rm(path.join(f.claude, 'skills'));
  await rm(f.log);
  passed(f.run(['--apply'], { BRIDGE_BLOCK_CLAUDE: block }));
  assert.deepEqual(await f.calls(), [f.codex, f.personal].flatMap((home) => [`${home}|plugin marketplace add ${path.resolve(ROOT)}`, `${home}|plugin add asb-bridge@asb`]));
  assert.equal(await readFile(path.join(f.codex, 'plugin-state/asb-bridge/task.sqlite'), 'utf8'), 'Synthetic message history\n');
  assert.deepEqual(await readdir(path.join(f.personal, 'plugin-state/asb-bridge')), []);
  assert.equal(await skillState(path.join(f.claude, 'skills/bridge')), 'ok');
});

test('migration second run is a no-op, including explicit homes and missing dependencies', async (t) => {
  const f = await fixture(t);
  passed(f.run(['--apply']));
  await rm(f.log);
  await rm(path.join(f.bin, 'codex'));
  await rm(path.join(f.bin, 'bun'));
  await writeFile(f.ps, '  301 codex app-server\n');
  const before = await snapshot(f.home);
  for (const args of [[], ['--apply'], ['--apply', '--codex-home', f.codex]]) {
    const result = f.run(args);
    passed(result);
    assert.equal(result.stdout, 'Nothing to migrate.\n');
    await unchanged(f, before);
  }
});

test('migration refuses a non-empty target in any home before it changes the first home', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.personal, 'config.toml'), OLD_CONFIG);
  await mkdir(path.join(f.personal, 'plugin-state/asb-bridge'), { recursive: true });
  await writeFile(path.join(f.personal, 'plugin-state/asb-bridge/keep.sqlite'), 'Synthetic new history\n');
  const before = await snapshot(f.home);
  for (const args of [[], ['--apply']]) {
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Target state folder is not empty/);
    assert.ok(result.stderr.includes(f.personal));
    assert.ok(result.stdout.includes(`Codex ${f.codex}`) && result.stdout.includes(`Codex ${f.personal}`));
    await unchanged(f, before);
  }
});

test('migration prints actions and all refusal categories together', async (t) => {
  const f = await fixture(t);
  await writeFile(f.ps, '  401 codex app-server\n');
  await rm(path.join(f.bin, 'bun'));
  await mkdir(path.join(f.codex, 'plugin-state/asb-bridge'));
  await writeFile(path.join(f.codex, 'plugin-state/asb-bridge/keep.sqlite'), 'Synthetic target\n');
  const before = await snapshot(f.home), result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Rename /);
  for (const reason of [/Codex processes are running/, /needs bun on PATH/, /Target state folder is not empty/]) assert.match(result.stderr, reason);
  await unchanged(f, before);
});

test('migration handles empty old and new state folders and absent old state', async (t) => {
  for (const oldExists of [true, false]) {
    const f = await fixture(t);
    await rm(path.join(f.codex, 'plugin-state/claude-uds-bridge'), { recursive: true });
    if (oldExists) await mkdir(path.join(f.codex, 'plugin-state/claude-uds-bridge'));
    await mkdir(path.join(f.codex, 'plugin-state/asb-bridge'));
    passed(f.run(['--apply']));
    assert.deepEqual(await readdir(path.join(f.codex, 'plugin-state/asb-bridge')), []);
    await assert.rejects(lstat(path.join(f.codex, 'plugin-state/claude-uds-bridge')), { code: 'ENOENT' });
  }
});

test('migration refuses linked state paths and files without changing outside data', async (t) => {
  const cases = ['plugin-state', 'plugin-state/claude-uds-bridge', 'plugin-state/asb-bridge', 'plugin-state/claude-uds-bridge/task.sqlite', 'hardlink'];
  for (const relative of cases) {
    const f = await fixture(t), outside = path.join(f.temporary, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.sqlite'), 'Synthetic outside history\n');
    const destination = path.join(f.codex, relative === 'hardlink' ? 'plugin-state/claude-uds-bridge/task.sqlite' : relative);
    await rm(destination, { recursive: true, force: true });
    if (relative === 'hardlink') await link(path.join(outside, 'keep.sqlite'), destination);
    else await symlink(relative.endsWith('.sqlite') ? path.join(outside, 'keep.sqlite') : outside, destination);
    const before = await snapshot(f.home), outsideBefore = await snapshot(outside);
    for (const args of [[], ['--apply']]) {
      const result = f.run(args);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /linked or non-(?:directory|file)/);
      await unchanged(f, before);
      assert.deepEqual(await snapshot(outside), outsideBefore);
    }
  }
});

test('migration refuses foreign, modified or linked skills in every target before plugin changes', async (t) => {
  for (const [provider, state] of [['codex', 'foreign'], ['claude', 'foreign'], ['claude', 'modified'], ['claude', 'linked']]) {
    const f = await fixture(t), home = provider === 'codex' ? f.personal : f.claude;
    if (provider === 'codex') await writeFile(path.join(home, 'config.toml'), OLD_CONFIG);
    await mkdir(path.join(home, 'skills/bridge'), { recursive: true });
    await writeFile(path.join(home, 'skills/bridge/SKILL.md'), 'Synthetic foreign skill\n');
    if (state === 'modified') await writeFile(path.join(home, 'skills/bridge/.asb-bridge.json'), JSON.stringify({ owner: 'asb-bridge', files: { 'SKILL.md': createHash('sha256').update('Synthetic original skill\n').digest('hex') } }));
    if (state === 'linked') {
      await rm(path.join(home, 'skills/bridge'), { recursive: true });
      await symlink(f.personal, path.join(home, 'skills/bridge'));
    }
    const before = await snapshot(f.home), result = f.run(['--apply']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /(?:foreign|modified) bridge skill|linked or non-directory/);
    await unchanged(f, before);
  }
});

test('migration refuses unsupported flags and paths before any change', async (t) => {
  const f = await fixture(t), before = await snapshot(f.home);
  for (const args of [['--force'], ['--codex-home'], ['--codex-home', 'relative'], ['--codex-home', `${f.codex}\n`], ['--all']]) {
    assert.equal(f.run(args).status, 1);
    await unchanged(f, before);
  }
});
