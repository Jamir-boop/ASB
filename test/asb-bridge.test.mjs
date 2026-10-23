import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codexBunOnPath, commandLine, executable, hasOldPlugin, linkClaudeRegistry, opencodePaths, parseDebugPaths, skillState } from '../scripts/asb-bridge.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts/asb-bridge.mjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
function runScript(script, args, env, options) {
  const code = `const { main } = await import(${JSON.stringify(pathToFileURL(script).href)}); try { process.exitCode = await main(process.argv.slice(1), ${JSON.stringify(options)}); } catch (error) { console.error('ASB Bridge failed: ' + error.message); process.exitCode = 1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { encoding: 'utf8', env });
}
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-bridge-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home'), bin = path.join(temporary, 'bin'), log = path.join(temporary, 'calls.log'), procRoot = path.join(temporary, 'proc');
  for (const directory of [bin, procRoot, ...['.codex', '.codex-personal', '.codex-other', '.claude'].map((name) => path.join(home, name))]) await mkdir(directory, { recursive: true });
  const codex = path.join(home, '.codex'), personal = path.join(home, '.codex-personal'), claude = path.join(home, '.claude');
  for (const directory of [codex, personal]) await writeFile(path.join(directory, 'config.toml'), '# Synthetic config\n');
  for (const name of ['codex', 'bun', 'claude']) await writeFile(path.join(bin, name), `#!/bin/sh\nprintf '%s|%s|%s\\n' '${name}' "\${CODEX_HOME-}" "$*" >> "$BRIDGE_LOG"\nif [ "\${1-}" = --version ]; then printf '%s\\n' '${name} 2.1.224'; fi\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_RUNTIME_DIR: path.join(temporary, 'run'), PATH: `${bin}:/usr/bin:/bin`, BRIDGE_LOG: log };
  const run = (args, extra = {}, options = {}) => runScript(SCRIPT, args, { ...env, ...extra }, { procRoot, platform: 'linux', ...options });
  const processRow = async (pid, values, args = ['/usr/bin/codex', 'app-server']) => {
    const directory = path.join(procRoot, String(pid));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'cmdline'), `${args.join('\0')}\0`);
    if (values) await writeFile(path.join(directory, 'environ'), `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\0')}\0`);
    return directory;
  };
  const calls = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { temporary, home, bin, log, codex, personal, claude, env, procRoot, run, processRow, calls };
}
function passed(result) { assert.equal(result.status, 0, result.stderr); }
async function outdatedSkill(directory) {
  const file = path.join(directory, 'SKILL.md');
  const bytes = Buffer.concat([await readFile(file), Buffer.from('x')]);
  await writeFile(file, bytes);
  const recordFile = path.join(directory, '.asb-bridge.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  record.files['SKILL.md'] = digest(bytes);
  await writeFile(recordFile, JSON.stringify(record));
}

for (const provider of ['claude', 'codex', 'opencode']) {
  test(`bridge status distinguishes current and out-of-date ${provider} skills`, async (t) => {
    const f = await fixture(t);
    const home = provider === 'claude' ? f.claude : provider === 'codex' ? f.personal : path.join(f.env.XDG_CONFIG_HOME, 'opencode');
    const args = provider === 'codex' ? ['--codex-home', home] : [`--${provider}`];
    const directory = path.join(home, 'skills/bridge');
    const report = () => {
      const result = f.run(['status', '--json']);
      passed(result);
      const status = JSON.parse(result.stdout);
      return provider === 'codex' ? status.codex.find((item) => item.home === home) : status[provider];
    };
    assert.equal(report().skill, 'missing');
    assert.equal(report().skillCurrent, null);
    passed(f.run(['install', ...args]));
    assert.equal(report().skill, 'ok');
    assert.equal(report().skillCurrent, true);
    const current = f.run(['status']);
    passed(current);
    assert.ok(current.stdout.split('\n').some((line) => line.includes(home) && line.includes('skill ok (current)')));
    await outdatedSkill(directory);
    assert.equal(report().skill, 'ok');
    assert.equal(report().skillCurrent, false);
    const outdated = f.run(['status']);
    passed(outdated);
    assert.ok(outdated.stdout.split('\n').some((line) => line.includes(home) && line.includes(`skill ok (out of date: run asb bridge install ${args.join(' ')})`)));
    await writeFile(path.join(directory, 'SKILL.md'), 'User edit\n');
    assert.equal(report().skill, 'modified');
    assert.equal(report().skillCurrent, null);
    const modified = f.run(['status']);
    passed(modified);
    assert.ok(modified.stdout.split('\n').some((line) => line.includes(home) && line.includes('skill modified;')));
  });
}

test('bridge install updates an out-of-date Claude skill without force', async (t) => {
  const f = await fixture(t);
  passed(f.run(['install', '--claude']));
  await outdatedSkill(path.join(f.claude, 'skills/bridge'));
  const before = f.run(['status', '--json']);
  passed(before);
  assert.equal(JSON.parse(before.stdout).claude.skill, 'ok');
  assert.equal(JSON.parse(before.stdout).claude.skillCurrent, false);
  passed(f.run(['install', '--claude']));
  const after = f.run(['status', '--json']);
  passed(after);
  assert.equal(JSON.parse(after.stdout).claude.skill, 'ok');
  assert.equal(JSON.parse(after.stdout).claude.skillCurrent, true);
  await owned(path.join(f.claude, 'skills/bridge'), 'claude');
});

async function owned(directory, provider) {
  const record = JSON.parse(await readFile(path.join(directory, '.asb-bridge.json'), 'utf8'));
  assert.equal(record.owner, 'asb-bridge');
  const expected = provider === 'codex' ? ['SKILL.md', 'agents/openai.yaml'] : ['SKILL.md'];
  assert.deepEqual(Object.keys(record.files).sort(), expected);
  for (const file of expected) {
    const bytes = await readFile(path.join(directory, file));
    assert.equal(record.files[file], digest(bytes));
    assert.deepEqual(bytes, await readFile(path.join(ROOT, 'bridge/agent-skills', provider, 'bridge', file)));
  }
  assert.equal((await lstat(path.join(directory, '.asb-bridge.json'))).mode & 0o777, 0o600);
  assert.equal(await skillState(directory), 'ok');
}

test('bridge mutations without targets show detected targets and usage without calls or writes', async (t) => {
  const f = await fixture(t), before = await snapshot(f.home);
  for (const args of [['install'], ['uninstall'], ['install', '--force']]) {
    const result = f.run(args);
    passed(result);
    assert.match(result.stdout, /Use: asb bridge/);
    assert.ok(result.stdout.includes(f.codex) && result.stdout.includes(f.personal) && result.stdout.includes(f.claude));
    assert.ok(!result.stdout.includes('.codex-other'));
    assert.deepEqual(await f.calls(), []);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('bridge installs explicit Codex and Claude skills through the selected Codex home', async (t) => {
  const f = await fixture(t);
  const result = f.run(['install', '--codex-home', f.personal, '--claude']);
  passed(result);
  assert.deepEqual(await f.calls(), [`codex|${f.personal}|plugin marketplace add ${ROOT}`, `codex|${f.personal}|plugin add asb-bridge@asb`]);
  await owned(path.join(f.personal, 'skills/bridge'), 'codex');
  await owned(path.join(f.claude, 'skills/bridge'), 'claude');
  await assert.rejects(lstat(path.join(f.codex, 'skills')), { code: 'ENOENT' });
  assert.match(result.stdout, /trust both hooks/);
  assert.match(result.stdout, /Use \$bridge in Codex and \/bridge in Claude Code/);
});

for (const [label, platform, reason, windowsHint] of [
  ['A: Windows access denied', 'win32', 'Error: Access is denied. (os error 5)', true],
  ['B: Linux access denied', 'linux', 'Error: Access is denied. (os error 5)', false],
  ['C: Windows other error', 'win32', 'Error: something else', false],
  ['G: Windows file in use', 'win32', 'Error: The process cannot access the file because it is being used by another process. (os error 32)', true],
]) {
  test(`bridge install continues after a Codex command failure (${label})`, async (t) => {
    const f = await fixture(t), opencode = path.join(f.home, '.config/opencode');
    await writeFile(path.join(f.bin, 'codex'), `${await readFile(path.join(f.bin, 'codex'), 'utf8')}if [ "$CODEX_HOME" = "$BRIDGE_FAIL_HOME" ] && [ "$*" = 'plugin add asb-bridge@asb' ]; then printf '%s\\n' "$BRIDGE_FAIL_REASON" >&2; exit 1; fi\n`);
    const result = f.run(['install', '--codex-home', f.personal, '--codex-home', f.codex, '--claude', '--opencode', '--opencode-config', opencode],
      { BRIDGE_FAIL_HOME: f.personal, BRIDGE_FAIL_REASON: reason }, { platform });
    assert.equal(result.status, 1);
    const hint = windowsHint ? ' On Windows, a running Codex keeps the plugin folder in use: close Codex, then run asb bridge install again.' : '';
    assert.equal(result.stderr, `Warning: ${f.personal}: codex plugin add asb-bridge@asb failed. ${reason}${hint}\n`);
    assert.ok(result.stdout.includes(`Codex ${f.codex}: installed\n`));
    assert.ok(result.stdout.includes(`Claude ${f.claude}: installed\n`));
    assert.ok(result.stdout.includes(`OpenCode ${opencode}: installed `));
    assert.match(result.stdout, /After an ASB upgrade, run `asb bridge install` again\./);
    await owned(path.join(f.codex, 'skills/bridge'), 'codex');
    await owned(path.join(f.claude, 'skills/bridge'), 'claude');
    await owned(path.join(opencode, 'skills/bridge'), 'opencode');
    assert.equal(await skillState(path.join(opencode, 'plugins/asb-bridge')), 'ok');
    assert.equal(existsSync(path.join(f.personal, 'skills/bridge')), false);
    assert.deepEqual(await f.calls(), [
      `codex|${f.personal}|plugin marketplace add ${ROOT}`, `codex|${f.personal}|plugin add asb-bridge@asb`,
      `codex|${f.codex}|plugin marketplace add ${ROOT}`, `codex|${f.codex}|plugin add asb-bridge@asb`,
    ]);
  });
}

for (const [label, platform, reason, windowsHint] of [
  ['D: Windows access denied', 'win32', 'Error: Access is denied. (os error 5)', true],
  ['E: Linux access denied', 'linux', 'Error: Access is denied. (os error 5)', false],
  ['F: Windows other error', 'win32', 'Error: something else', false],
  ['H: Windows file in use', 'win32', 'Error: The process cannot access the file because it is being used by another process. (os error 32)', true],
]) {
  test(`bridge uninstall continues after a Codex command failure (${label})`, async (t) => {
    const f = await fixture(t), opencode = path.join(f.home, '.config/opencode');
    await writeFile(path.join(f.bin, 'codex'), `${await readFile(path.join(f.bin, 'codex'), 'utf8')}if [ "$CODEX_HOME" = "$BRIDGE_FAIL_HOME" ] && [ "$*" = 'plugin remove asb-bridge@asb' ]; then printf '%s\\n' "$BRIDGE_FAIL_REASON" >&2; exit 1; fi\n`);
    const targets = ['--codex-home', f.personal, '--codex-home', f.codex, '--claude', '--opencode', '--opencode-config', opencode];
    const env = { BRIDGE_FAIL_HOME: f.personal, BRIDGE_FAIL_REASON: reason };
    passed(f.run(['install', ...targets], env, { platform }));
    await rm(f.log);
    const result = f.run(['uninstall', ...targets], env, { platform });
    assert.equal(result.status, 1);
    const hint = windowsHint ? ' On Windows, a running Codex keeps the plugin folder in use: close Codex, then run asb bridge uninstall again.' : '';
    assert.equal(result.stderr, `Warning: ${f.personal}: codex plugin remove asb-bridge@asb failed. ${reason}${hint}\n`);
    assert.ok(result.stdout.includes(`Codex ${f.codex}: removed; message history stays at ${path.join(f.codex, 'plugin-state/asb-bridge')}\n`));
    assert.ok(result.stdout.includes(`Claude ${f.claude}: removed\n`));
    assert.ok(result.stdout.includes(`OpenCode ${opencode}: removed; message history stays at ${path.join(f.home, '.local/state/opencode/plugin-state/asb-bridge')}\n`));
    await owned(path.join(f.personal, 'skills/bridge'), 'codex');
    for (const directory of [f.codex, f.claude, opencode]) assert.equal(existsSync(path.join(directory, 'skills/bridge')), false);
    assert.equal(existsSync(path.join(opencode, 'plugins/asb-bridge')), false);
    assert.deepEqual(await f.calls(), [
      `codex|${f.personal}|plugin remove asb-bridge@asb`,
      `codex|${f.codex}|plugin remove asb-bridge@asb`, `codex|${f.codex}|plugin marketplace remove asb`,
    ]);
  });
}

test('Codex failures show only the last nonempty stderr line, capped at 200 characters', async (t) => {
  const f = await fixture(t), stderr = path.join(f.temporary, 'stderr.txt');
  await writeFile(path.join(f.bin, 'codex'), '#!/bin/sh\nprintf \'%s|%s|%s\\n\' codex "$CODEX_HOME" "$*" >> "$BRIDGE_LOG"\ncat "$BRIDGE_STDERR" >&2\nexit 1\n', { mode: 0o755 });
  const before = await snapshot(f.home);
  for (const [output, reason] of [
    ['first diagnostic\n\n  final reason  \r\n \t\n', 'final reason'],
    [`previous line\n${'x'.repeat(250)}\n`, 'x'.repeat(200)],
    ['', ''],
  ]) {
    await writeFile(stderr, output);
    const result = f.run(['install', '--codex-home', f.codex], { BRIDGE_STDERR: stderr, BRIDGE_PRIVATE_VALUE: 'synthetic-private-value' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `Warning: ${f.codex}: codex plugin marketplace add failed.${reason ? ` ${reason}` : ''}\n`);
    assert.ok(!result.stderr.includes('synthetic-private-value'));
    assert.equal((await f.calls()).at(-1), `codex|${f.codex}|plugin marketplace add ${ROOT}`);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('bridge install is repeatable and replaces only a changed marketplace source', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.codex, 'config.toml'), '[marketplaces.asb]\nsource_type = "local"\nsource = "/old/asb"\n');
  passed(f.run(['install', '--codex-home', f.codex, '--claude']));
  const first = await snapshot(f.home);
  passed(f.run(['install', '--codex-home', f.codex, '--claude']));
  assert.deepEqual(await snapshot(f.home), first);
  assert.equal((await f.calls()).filter((line) => line.endsWith('plugin marketplace remove asb')).length, 2);
  await writeFile(path.join(f.codex, 'config.toml'), `[marketplaces.asb]\nsource_type = "local"\nsource = ${JSON.stringify(ROOT)}\n`);
  await rm(f.log);
  passed(f.run(['install', '--codex-home', f.codex]));
  assert.deepEqual(await f.calls(), [`codex|${f.codex}|plugin marketplace add ${ROOT}`, `codex|${f.codex}|plugin add asb-bridge@asb`]);
});

test('foreign bridge skills refuse before plugin changes and force replaces the intended tree', async (t) => {
  const f = await fixture(t), directory = path.join(f.codex, 'skills/bridge');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), 'User skill\n');
  await writeFile(path.join(directory, 'extra.txt'), 'User file\n');
  const before = await snapshot(f.home), refused = f.run(['install', '--codex-home', f.codex]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /foreign bridge skill/);
  assert.deepEqual(await snapshot(f.home), before);
  assert.deepEqual(await f.calls(), []);
  passed(f.run(['install', '--codex-home', f.codex, '--force']));
  await owned(directory, 'codex');
  await assert.rejects(lstat(path.join(directory, 'extra.txt')), { code: 'ENOENT' });
});

test('old plugin homes are skipped with the migration warning without plugin or skill writes', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.codex, 'config.toml'), '[plugins."claude-uds-bridge@leonkohli"]\nenabled = true\n');
  const before = await snapshot(f.home), result = f.run(['install', '--codex-home', f.codex]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the old claude-uds-bridge plugin is installed here; run bridge\/scripts\/migrate-from-claude-uds-bridge.mjs first/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
});

test('retained old hook trust permits install and does not report the old plugin', async (t) => {
  const f = await fixture(t);
  const config = '[hooks.state."claude-uds-bridge@leonkohli:hooks/hooks.json:session_start:0:0"]\ntrusted = true\n[hooks.state."claude-uds-bridge@leonkohli:hooks/hooks.json:session_end:0:0"]\ntrusted = true\n';
  await writeFile(path.join(f.codex, 'config.toml'), config);
  assert.equal(hasOldPlugin(config), false);
  passed(f.run(['install', '--codex-home', f.codex]));
  assert.deepEqual(await f.calls(), [`codex|${f.codex}|plugin marketplace add ${ROOT}`, `codex|${f.codex}|plugin add asb-bridge@asb`]);
  await owned(path.join(f.codex, 'skills/bridge'), 'codex');
  assert.equal(await readFile(path.join(f.codex, 'config.toml'), 'utf8'), config);
  await rm(f.log);
  const before = await snapshot(f.home), result = f.run(['status', '--json']);
  passed(result);
  const report = JSON.parse(result.stdout).codex.find((item) => item.home === f.codex);
  assert.equal(report.oldPlugin, false);
  assert.equal(report.warning, null);
  assert.deepEqual(await snapshot(f.home), before);
  assert.equal(await readFile(path.join(f.codex, 'config.toml'), 'utf8'), config);
  assert.ok((await f.calls()).every((line) => line.endsWith('|--version')));
});

test('missing Bun refuses a Codex install before any target change', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.bin, 'bun'));
  const before = await snapshot(f.home), result = f.run(['install', '--codex-home', f.codex, '--claude'], { PATH: f.bin });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs bun on PATH/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
  passed(f.run(['install', '--claude']));
  await owned(path.join(f.claude, 'skills/bridge'), 'claude');
});

test('bridge uninstall works without Bun and still requires Codex', async (t) => {
  const f = await fixture(t);
  passed(f.run(['install', '--codex-home', f.codex]));
  await rm(path.join(f.bin, 'bun'));
  await rm(f.log);
  passed(f.run(['uninstall', '--codex-home', f.codex], { PATH: f.bin }));
  assert.deepEqual(await f.calls(), [`codex|${f.codex}|plugin remove asb-bridge@asb`, `codex|${f.codex}|plugin marketplace remove asb`]);
  await assert.rejects(lstat(path.join(f.codex, 'skills/bridge')), { code: 'ENOENT' });
  await rm(path.join(f.bin, 'codex'));
  await rm(f.log);
  const before = await snapshot(f.home), refused = f.run(['uninstall', '--codex-home', f.codex], { PATH: f.bin });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /needs codex on PATH/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
});

test('bridge uninstall removes owned skills and retains message history and foreign skills', async (t) => {
  const f = await fixture(t);
  passed(f.run(['install', '--codex-home', f.codex, '--claude']));
  const history = path.join(f.codex, 'plugin-state/asb-bridge');
  await mkdir(history, { recursive: true });
  await writeFile(path.join(history, 'history.sqlite'), 'Synthetic history\n');
  await rm(f.log);
  const result = f.run(['uninstall', '--codex-home', f.codex, '--claude']);
  passed(result);
  assert.deepEqual(await f.calls(), [`codex|${f.codex}|plugin remove asb-bridge@asb`, `codex|${f.codex}|plugin marketplace remove asb`]);
  for (const home of [f.codex, f.claude]) await assert.rejects(lstat(path.join(home, 'skills/bridge')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(history, 'history.sqlite'), 'utf8'), 'Synthetic history\n');
  assert.match(result.stdout, /message history stays/);
  await mkdir(path.join(f.personal, 'skills/bridge'), { recursive: true });
  await writeFile(path.join(f.personal, 'skills/bridge/SKILL.md'), 'Foreign skill\n');
  await rm(f.log);
  const before = await snapshot(f.home), refused = f.run(['uninstall', '--codex-home', f.personal]);
  assert.equal(refused.status, 1);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
  passed(f.run(['uninstall', '--codex-home', f.personal, '--force']));
  await assert.rejects(lstat(path.join(f.personal, 'skills/bridge')), { code: 'ENOENT' });
});

test('bridge status reports configuration, version, trust, skill ownership and live receivers read-only', async (t) => {
  const f = await fixture(t);
  passed(f.run(['install', '--codex-home', f.codex, '--claude']));
  const expectedVersion = JSON.parse(await readFile(path.join(ROOT, 'bridge/.codex-plugin/plugin.json'), 'utf8')).version;
  await mkdir(path.join(f.codex, 'plugins/cache/asb/asb-bridge', expectedVersion), { recursive: true });
  await mkdir(path.join(f.codex, 'plugin-state/asb-bridge'), { recursive: true });
  await writeFile(path.join(f.codex, 'plugin-state/asb-bridge/task.sqlite'), 'Synthetic state\n');
  await writeFile(path.join(f.codex, 'config.toml'), `[marketplaces.asb]\nsource_type = "local"\nsource = ${JSON.stringify(ROOT)}\n[plugins."asb-bridge@asb"]\nenabled = true\n[hooks.state."asb-bridge@asb:hooks/hooks.json:session_start:0:0"]\n[hooks.state."asb-bridge@asb:hooks/hooks.json:session_end:0:0"]\n`);
  await writeFile(path.join(f.personal, 'config.toml'), '[plugins."claude-uds-bridge@leonkohli"]\nenabled = true\n');
  await mkdir(path.join(f.claude, 'sessions'));
  for (const [file, row] of Object.entries({ live: { entrypoint: 'codex-asb-bridge', pid: process.pid }, unrelated: { entrypoint: 'other', pid: process.pid }, stale: { entrypoint: 'codex-asb-bridge', pid: 2147483647 }, invalid: { entrypoint: 'codex-asb-bridge', pid: -1 } })) await writeFile(path.join(f.claude, 'sessions', `${file}.json`), JSON.stringify(row));
  await writeFile(path.join(f.claude, 'sessions/broken.json'), '{');
  await rm(f.log);
  const before = await snapshot(f.home), result = f.run(['status', '--json']);
  passed(result);
  const report = JSON.parse(result.stdout), codex = report.codex.find((item) => item.home === f.codex);
  assert.deepEqual(codex.marketplace, { installed: true, source: ROOT });
  assert.deepEqual(codex.plugin, { installed: true, enabled: true, versions: [expectedVersion], version: expectedVersion, expectedVersion, versionMatches: true });
  assert.deepEqual(codex.hooks, { session_start: true, session_end: true });
  assert.equal(codex.skill, 'ok');
  assert.equal(codex.stateFiles, 1);
  assert.equal(report.codex.find((item) => item.home === f.personal).oldPlugin, true);
  assert.match(report.codex.find((item) => item.home === f.personal).warning, /migrate-from-claude-uds-bridge/);
  assert.equal(report.claude.skill, 'ok');
  assert.equal(report.claude.version, 'claude 2.1.224');
  assert.match(report.claude.requirement, /2\.1\.224/);
  assert.equal(report.liveReceivers, 1);
  assert.deepEqual(report.versions, { bun: 'bun 2.1.224', codex: 'codex 2.1.224', opencode: null });
  assert.equal(report.opencode.plugin, 'missing');
  assert.equal(report.opencode.expectedVersion, expectedVersion);
  assert.equal(report.opencode.versionMatches, false);
  assert.equal(report.opencode.liveReceivers, 0);
  assert.ok((await f.calls()).every((line) => line.endsWith('|--version')));
  assert.deepEqual(await snapshot(f.home), before);
});

test('bridge status reports Bun on each app-server PATH as true, false or null', async (t) => {
  const f = await fixture(t), withoutBun = path.join(f.temporary, 'desktop-bin');
  await mkdir(path.join(withoutBun, 'bun'), { recursive: true });
  await writeFile(path.join(f.home, '.codex-other/config.toml'), '# Synthetic config\n');
  await f.processRow(101, { HOME: f.home, PATH: f.bin, SYNTHETIC_SECRET: 'never-print-this' }, ['/usr/bin/codex', '--trace', 'app-server']);
  await f.processRow(102, { HOME: '/synthetic/other-home', CODEX_HOME: f.personal, PATH: withoutBun });
  await f.processRow(103, { HOME: f.home, CODEX_HOME: f.codex, PATH: withoutBun }, ['/usr/bin/echo', 'codex', 'app-server']);
  const before = await snapshot(f.home), result = f.run(['status', '--json']);
  passed(result);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.codex.map(({ home, bunOnAppServerPath }) => [home, bunOnAppServerPath]), [
    [f.codex, true], [path.join(f.home, '.codex-other'), null], [f.personal, false],
  ]);
  assert.match(result.stderr, /Warning: .*\.codex-personal: bun is missing from a running Codex app-server PATH/);
  assert.match(result.stderr, /Codex cannot start or resume tasks/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('never-print-this'));
  assert.deepEqual(await snapshot(f.home), before);
  const text = f.run(['status']);
  passed(text);
  assert.match(text.stdout, /bun on app-server PATH=true/);
  assert.match(text.stdout, /bun on app-server PATH=false/);
  assert.match(text.stdout, /bun on app-server PATH=null/);
  assert.equal(text.stderr, result.stderr);
});

test('app-server Bun lookup follows executable files and rejects directories and nonexecutables', async (t) => {
  const f = await fixture(t), bin = path.join(f.temporary, 'desktop-bin');
  await mkdir(bin);
  await symlink(path.join(f.bin, 'bun'), path.join(bin, 'bun'));
  await f.processRow(101, { HOME: f.home, PATH: bin });
  const check = () => codexBunOnPath(f.codex, { procRoot: f.procRoot, platform: 'linux' });
  assert.equal(await check(), true);
  await rm(path.join(bin, 'bun'));
  await symlink(f.bin, path.join(bin, 'bun'));
  assert.equal(await check(), false);
  await rm(path.join(bin, 'bun'));
  await writeFile(path.join(bin, 'bun'), '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(await check(), false);
  await chmod(path.join(bin, 'bun'), 0o755);
  assert.equal(await check(), true);
});

test('app-server Bun lookup uses its own working directory for relative and empty PATH entries', async (t) => {
  const f = await fixture(t), directory = await f.processRow(101, { HOME: f.home, PATH: 'bin' });
  const check = () => codexBunOnPath(f.codex, { procRoot: f.procRoot, platform: 'linux' });
  assert.equal(await check(), null);
  await symlink(f.temporary, path.join(directory, 'cwd'));
  assert.equal(await check(), true);
  await writeFile(path.join(directory, 'environ'), `HOME=${f.home}\0PATH=\0`);
  assert.equal(await check(), false);
  await rm(path.join(directory, 'cwd'));
  await symlink(f.bin, path.join(directory, 'cwd'));
  assert.equal(await check(), true);
});

test('app-server Bun lookup is conservative with multiple processes and unreadable data', async (t) => {
  const f = await fixture(t), withoutBun = path.join(f.temporary, 'desktop-bin');
  await mkdir(withoutBun);
  await f.processRow(101, { HOME: f.home, PATH: f.bin });
  const check = () => codexBunOnPath(f.codex, { procRoot: f.procRoot, platform: 'linux' });
  assert.equal(await check(), true);
  const unreadable = await f.processRow(102, null);
  await mkdir(path.join(unreadable, 'environ'));
  assert.equal(await check(), null);
  await f.processRow(103, { CODEX_HOME: f.codex, PATH: withoutBun });
  assert.equal(await check(), false);
  await f.processRow(103, { CODEX_HOME: f.personal, PATH: withoutBun });
  assert.equal(await check(), null);
  await rm(unreadable, { recursive: true });
  assert.equal(await check(), true);
  await writeFile(path.join(f.procRoot, '101/environ'), `HOME=${f.home}\0`);
  assert.equal(await check(), null);
  assert.equal(await codexBunOnPath(f.codex, { procRoot: path.join(f.temporary, 'missing'), platform: 'linux' }), null);
  const result = f.run(['status', '--json'], {}, { platform: 'darwin' });
  passed(result);
  assert.ok(JSON.parse(result.stdout).codex.every((item) => item.bunOnAppServerPath === null));
  assert.equal(result.stderr, '');
});

test('bridge install warns without failure when only the app-server PATH lacks Bun', async (t) => {
  const f = await fixture(t), withoutBun = path.join(f.temporary, 'desktop-bin');
  await mkdir(withoutBun);
  await f.processRow(101, { CODEX_HOME: f.codex, PATH: withoutBun });
  const result = f.run(['install', '--codex-home', f.codex]);
  passed(result);
  await owned(path.join(f.codex, 'skills/bridge'), 'codex');
  assert.match(result.stdout, /installed/);
  assert.match(result.stderr, /Warning: .*bun is missing from a running Codex app-server PATH/);
  assert.ok(result.stderr.includes(`asb bridge uninstall --codex-home '${f.codex}'`));
  assert.match(result.stderr, /restart Codex/);
});

test('Codex version checks use a temporary home and remove it after success and failure', async (t) => {
  const f = await fixture(t), temporaryRoot = path.join(f.temporary, 'version-tmp');
  await mkdir(temporaryRoot);
  await writeFile(path.join(f.bin, 'codex'), '#!/bin/sh\n[ -d "$CODEX_HOME" ] || exit 90\n[ "$BRIDGE_VERSION_SENTINEL" = preserved ] || exit 91\nprintf helper > "$CODEX_HOME/version-helper"\nprintf \'%s|%s|%s\\n\' codex "$CODEX_HOME" "$*" >> "$BRIDGE_LOG"\nif [ "$BRIDGE_VERSION_FAIL" = 1 ]; then exit 1; fi\nprintf \'codex 2.1.224\\n\'\n', { mode: 0o755 });
  const before = await snapshot(f.home), generated = [];
  for (const failure of ['0', '1']) {
    const result = f.run(['status', '--json'], { TMPDIR: temporaryRoot, BRIDGE_VERSION_FAIL: failure, BRIDGE_VERSION_SENTINEL: 'preserved' });
    passed(result);
    const report = JSON.parse(result.stdout), calls = await f.calls();
    assert.equal(report.versions.codex, failure === '0' ? 'codex 2.1.224' : null);
    assert.deepEqual(report.codex.map((item) => item.home), [f.codex, f.personal]);
    const [, directory, args] = calls.find((line) => line.startsWith('codex|')).split('|');
    assert.equal(args, '--version');
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('asb-bridge-version-'));
    generated.push(directory);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    assert.deepEqual(await readdir(temporaryRoot), []);
    assert.deepEqual(await snapshot(f.home), before);
    for (const tool of ['bun', 'claude']) assert.ok(calls.includes(`${tool}|${f.codex}|--version`));
    await rm(f.log);
  }
  assert.notEqual(generated[0], generated[1]);
});

test('bridge all selects only detected Codex homes with config and the existing Claude home', async (t) => {
  const f = await fixture(t);
  passed(f.run(['install', '--all']));
  for (const home of [f.codex, f.personal]) await owned(path.join(home, 'skills/bridge'), 'codex');
  await owned(path.join(f.claude, 'skills/bridge'), 'claude');
  assert.ok((await f.calls()).every((line) => !line.includes('.codex-other')));
  await assert.rejects(lstat(path.join(f.home, '.codex-other/skills')), { code: 'ENOENT' });
});

test('modified, unlisted and invalid ownership files refuse before external mutations', async (t) => {
  const f = await fixture(t), directory = path.join(f.codex, 'skills/bridge');
  passed(f.run(['install', '--codex-home', f.codex]));
  const initial = await readFile(path.join(directory, '.asb-bridge.json'), 'utf8');
  const variants = [
    async () => writeFile(path.join(directory, 'SKILL.md'), 'User edit\n'),
    async () => writeFile(path.join(directory, 'extra.txt'), 'User extra\n'),
    async () => rm(path.join(directory, 'agents/openai.yaml')),
    ...['../outside', '/outside', 'agents//file', 'agents/../outside', '.asb-bridge.json', 'agents\\file', 'agents/\nfile'].map((name) => async () => writeFile(path.join(directory, '.asb-bridge.json'), JSON.stringify({ owner: 'asb-bridge', files: { [name]: 'a'.repeat(64) } }))),
    async () => writeFile(path.join(directory, '.asb-bridge.json'), JSON.stringify({ owner: 'asb-bridge', files: {} })),
    async () => writeFile(path.join(directory, '.asb-bridge.json'), JSON.stringify({ owner: 'asb-bridge', files: { 'SKILL.md': 'invalid' } })),
    async () => writeFile(path.join(directory, '.asb-bridge.json'), '{'),
  ];
  for (const change of variants) {
    passed(f.run(['install', '--codex-home', f.codex, '--force']));
    assert.equal(await readFile(path.join(directory, '.asb-bridge.json'), 'utf8'), initial);
    await change();
    await rm(f.log);
    const before = await snapshot(f.home);
    for (const command of ['install', 'uninstall']) {
      const result = f.run([command, '--codex-home', f.codex]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /(?:foreign|modified) bridge skill/);
      assert.deepEqual(await f.calls(), []);
      assert.deepEqual(await snapshot(f.home), before);
    }
  }
});

test('linked skill destinations and parents are never followed, including with force', async (t) => {
  const f = await fixture(t), outside = path.join(f.temporary, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'SKILL.md'), 'Outside file\n');
  const beforeOutside = await snapshot(outside);
  for (const home of [f.codex, f.claude]) {
    for (const destination of ['skills', 'skills/bridge']) {
      const linked = path.join(home, destination);
      await mkdir(path.dirname(linked), { recursive: true });
      await symlink(outside, linked);
      const before = await snapshot(f.home);
      for (const command of ['install', 'uninstall']) {
        const result = f.run([command, ...(home === f.codex ? ['--codex-home', home] : ['--claude']), '--force']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /linked or non-directory/);
        assert.deepEqual(await f.calls(), []);
        assert.deepEqual(await snapshot(f.home), before);
        assert.deepEqual(await snapshot(outside), beforeOutside);
      }
      await rm(linked);
    }
  }
});

test('force removes internal skill links without removing outside files', async (t) => {
  const f = await fixture(t), directory = path.join(f.codex, 'skills/bridge'), outside = path.join(f.temporary, 'outside');
  passed(f.run(['install', '--codex-home', f.codex]));
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'Outside file\n');
  await symlink(outside, path.join(directory, 'linked-folder'));
  await symlink(path.join(outside, 'keep.txt'), path.join(directory, 'linked-file'));
  await rm(f.log);
  assert.equal(f.run(['install', '--codex-home', f.codex]).status, 1);
  assert.deepEqual(await f.calls(), []);
  passed(f.run(['install', '--codex-home', f.codex, '--force']));
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Outside file\n');
  await owned(directory, 'codex');
});

test('Claude configuration override and CLI argument validation stay within explicit targets', async (t) => {
  const f = await fixture(t), override = path.join(f.temporary, 'claude-config');
  passed(f.run(['install', '--claude'], { CLAUDE_CONFIG_DIR: override }));
  await owned(path.join(override, 'skills/bridge'), 'claude');
  await assert.rejects(lstat(path.join(f.claude, 'skills')), { code: 'ENOENT' });
  const before = await snapshot(f.home);
  for (const args of [['install', '--codex-home'], ['install', '--codex-home', 'relative'], ['install', '--codex-home', `${f.codex}\n`], ['install', '--unknown'], ['install', '--all', '--claude'], ['status', '--force'], ['uninstall', '--json']]) {
    assert.equal(f.run(args).status, 1);
    assert.deepEqual(await f.calls(), []);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('status uses shipped plugin metadata without bridge package.json and missing root refuses writes', async (t) => {
  const f = await fixture(t), root = path.join(f.temporary, 'payload');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(SCRIPT, path.join(root, 'scripts/asb-bridge.mjs'));
  const run = (args) => runScript(path.join(root, 'scripts/asb-bridge.mjs'), args, f.env, { procRoot: f.procRoot, platform: 'linux' });
  const before = await snapshot(f.home), refusal = run(['install', '--codex-home', f.codex]);
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /Missing ASB Bridge runtime file/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
  const uninstall = run(['uninstall', '--codex-home', f.codex]);
  assert.equal(uninstall.status, 1);
  assert.match(uninstall.stderr, /Missing ASB Bridge runtime file/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
  await mkdir(path.join(root, 'bridge/.codex-plugin'), { recursive: true });
  await writeFile(path.join(root, 'bridge/.codex-plugin/plugin.json'), '{"version":"0.3.0"}\n');
  const result = run(['status', '--json']);
  passed(result);
  assert.equal(JSON.parse(result.stdout).codex[0].plugin.expectedVersion, '0.3.0');
  await assert.rejects(lstat(path.join(root, 'bridge/package.json')), { code: 'ENOENT' });
});

async function registryFixture(t) {
  const f = await fixture(t), shared = path.join(f.home, '.claude-shared');
  for (const directory of [f.home, f.claude]) await chmod(directory, 0o700);
  await mkdir(shared, { mode: 0o700 });
  const source = path.join(f.claude, 'sessions'), target = path.join(shared, 'sessions');
  for (const directory of [source, target]) await mkdir(directory, { mode: 0o700 });
  const key = `101.${'a'.repeat(64)}.key`;
  const rows = { '101.json': '{ "pid": 101, "sessionId": "synthetic-source" }\n', [key]: `{"peerToken":"${'b'.repeat(32)}","procStart":"101"}\n` };
  for (const [name, bytes] of Object.entries(rows)) await writeFile(path.join(source, name), bytes, { mode: 0o600 });
  await writeFile(path.join(target, '202.json'), '{"pid":202,"sessionId":"synthetic-target"}\n', { mode: 0o600 });
  const fault = async (code) => {
    const preload = path.join(f.temporary, 'fault.mjs');
    await writeFile(preload, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst source=${JSON.stringify(source)}, target=${JSON.stringify(target)};\n${code}\nsyncBuiltinESMExports();\n`);
    return f.run(['link-claude', f.claude, shared], { NODE_OPTIONS: `--import=${preload}` });
  };
  return { ...f, shared, source, target, key, rows, fault };
}

test('Claude registry linking preserves both registries, keeps a private original backup, and is repeatable', async (t) => {
  const f = await registryFixture(t), destination = await snapshot(f.target), original = await snapshot(f.source);
  for (const name of ['settings.json', 'credentials.json', 'transcript.jsonl']) await writeFile(path.join(f.claude, name), `Synthetic ${name}\n`);
  const result = await linkClaudeRegistry(f.claude, f.shared);
  assert.equal(result.registry, f.target);
  assert.equal(result.linked, true);
  assert.equal(await readlink(f.source), f.target);
  assert.deepEqual(await snapshot(result.backup), original);
  for (const directory of [path.dirname(result.backup), result.backup, f.target]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await snapshot(f.target), { ...destination, ...original });
  for (const name of Object.keys(f.rows)) assert.equal((await lstat(path.join(f.target, name))).mode & 0o777, 0o600);
  for (const name of ['settings.json', 'credentials.json', 'transcript.jsonl']) assert.equal(await readFile(path.join(f.claude, name), 'utf8'), `Synthetic ${name}\n`);
  const before = await snapshot(f.home);
  passed(f.run(['link-claude', f.claude, f.shared]));
  assert.deepEqual(await linkClaudeRegistry(f.claude, f.shared), { home: f.claude, registry: f.target, backup: null, linked: false });
  assert.deepEqual(await snapshot(f.home), before);
  assert.deepEqual(await f.calls(), []);
  passed(f.run(['uninstall', '--claude']));
  assert.deepEqual(await snapshot(f.target), { ...destination, ...original });
  assert.deepEqual(await snapshot(result.backup), original);
  assert.equal(await readlink(f.source), f.target);
});

test('Claude registry linking permits identical files and refuses conflicts before any write', async (t) => {
  const f = await registryFixture(t);
  await writeFile(path.join(f.target, '101.json'), '{"pid":101,"sessionId":"other"}\n', { mode: 0o600 });
  const before = await snapshot(f.home);
  await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /Conflicting registry file: 101.json/);
  assert.deepEqual(await snapshot(f.home), before);
  await writeFile(path.join(f.target, '101.json'), f.rows['101.json']);
  const existing = await lstat(path.join(f.target, '101.json'));
  await linkClaudeRegistry(f.claude, f.shared);
  assert.equal((await lstat(path.join(f.target, '101.json'))).ino, existing.ino);
});

test('Claude registry linking keeps owned 0755 and 0775 home permissions', async (t) => {
  for (const mode of [0o755, 0o775]) {
    const f = await registryFixture(t);
    for (const directory of [f.claude, f.shared]) await chmod(directory, mode);
    await linkClaudeRegistry(f.claude, f.shared);
    for (const directory of [f.claude, f.shared]) assert.equal((await lstat(directory)).mode & 0o777, mode);
  }
});

test('Claude registry linking accepts native 0664 JSON metadata and preserves existing permissions', async (t) => {
  const f = await registryFixture(t), source = path.join(f.source, '101.json'), target = path.join(f.target, '202.json');
  for (const file of [source, target]) await chmod(file, 0o664);
  const existing = await lstat(target), before = await snapshot(f.target);
  const result = await linkClaudeRegistry(f.claude, f.shared);
  assert.equal((await lstat(path.join(result.backup, '101.json'))).mode & 0o777, 0o664);
  assert.equal((await lstat(target)).mode & 0o777, 0o664);
  assert.equal((await lstat(target)).ino, existing.ino);
  assert.equal((await lstat(path.join(f.target, '101.json'))).mode & 0o777, 0o600);
  assert.equal((await snapshot(f.target))['202.json'], before['202.json']);
  assert.equal(await readFile(path.join(f.target, '101.json'), 'utf8'), f.rows['101.json']);
});

test('Claude registry linking refuses world-writable JSON metadata without permission changes', async (t) => {
  for (const side of ['source', 'target']) {
    const f = await registryFixture(t), file = path.join(f[side], side === 'source' ? '101.json' : '202.json');
    await chmod(file, 0o666);
    const before = await snapshot(f.home);
    await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /Unsafe registry file/);
    assert.equal((await lstat(file)).mode & 0o777, 0o666);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('Claude registry linking refuses group-readable or group-writable IPC keys', async (t) => {
  for (const side of ['source', 'target']) {
    for (const mode of [0o640, 0o620]) {
      const f = await registryFixture(t), file = path.join(f[side], f.key);
      if (side === 'target') await writeFile(file, f.rows[f.key], { mode: 0o600 });
      await chmod(file, mode);
      const before = await snapshot(f.home);
      await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /Unsafe registry file/);
      assert.equal((await lstat(file)).mode & 0o777, mode);
      assert.deepEqual(await snapshot(f.home), before);
    }
  }
});

test('Claude registry linking refuses unknown files, invalid JSON, nonfiles, and linked leaves', async (t) => {
  for (const kind of ['unknown', 'heartbeat', 'invalid', 'directory', 'link']) {
    const f = await registryFixture(t), file = path.join(f.source, kind === 'unknown' ? 'settings.json' : kind === 'heartbeat' ? '.heartbeat' : '303.json');
    if (kind === 'directory') await mkdir(file);
    else if (kind === 'link') await symlink(path.join(f.target, '202.json'), file);
    else await writeFile(file, kind === 'invalid' ? '{' : '{}', { mode: 0o600 });
    const before = await snapshot(f.home);
    await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /Unsupported registry entry|Invalid registry JSON|Unsafe registry file|ELOOP/);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('Claude registry linking refuses public targets, changed links, unsafe parents, and path containment', async (t) => {
  const f = await registryFixture(t);
  await chmod(f.target, 0o755);
  await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /private \(0700\)/);
  await chmod(f.target, 0o700);
  const alias = path.join(f.home, 'shared-alias');
  await symlink(f.shared, alias);
  await assert.rejects(linkClaudeRegistry(f.claude, alias), /linked or non-directory/);
  await assert.rejects(linkClaudeRegistry(f.claude, f.claude), /must not contain/);
  const nested = path.join(f.source, 'nested');
  await mkdir(path.join(nested, 'sessions'), { recursive: true, mode: 0o700 });
  await assert.rejects(linkClaudeRegistry(f.claude, nested), /must not contain/);
  await rm(nested, { recursive: true });
  await chmod(f.shared, 0o777);
  await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /Unsafe registry parent/);
  await chmod(f.shared, 0o700);
  await rm(f.source, { recursive: true });
  await symlink(f.claude, f.source);
  const before = await snapshot(f.home);
  await assert.rejects(linkClaudeRegistry(f.claude, f.shared), /Registry link has another target/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('Claude registry linking refuses a foreign owner', async (t) => {
  const f = await registryFixture(t), before = await snapshot(f.home);
  const result = await f.fault("const lstat=fs.promises.lstat;fs.promises.lstat=async(file,...args)=>{const row=await lstat(file,...args);if(file===target)row.uid++;return row;};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owned by the current user/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('Claude registry setup rolls back an insertion failure and removes only its own copies', async (t) => {
  const f = await registryFixture(t), before = await snapshot(f.home);
  const result = await f.fault("fs.promises.symlink=async()=>{throw new Error('Synthetic link failure');};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Synthetic link failure/);
  assert.deepEqual(await snapshot(f.home), before);
});

test('Claude registry setup refuses a concurrent target collision without overwriting its bytes', async (t) => {
  const f = await registryFixture(t), source = await snapshot(f.source);
  const result = await f.fault("const open=fs.promises.open;fs.promises.open=async(file,...args)=>{if(file===target+'/101.json'&&typeof args[0]==='number'&&(args[0]&fs.constants.O_EXCL))await fs.promises.writeFile(file,'{\"pid\":101,\"other\":true}\\n',{flag:'wx',mode:0o600});return open(file,...args);};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/);
  assert.deepEqual(await snapshot(f.source), source);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, '101.json'))), { pid: 101, other: true });
  await assert.rejects(lstat(path.join(f.target, f.key)), { code: 'ENOENT' });
});

test('Claude registry setup detects source changes before finalization and preserves the updated source', async (t) => {
  const f = await registryFixture(t), target = await snapshot(f.target);
  const result = await f.fault("const rename=fs.promises.rename; fs.promises.rename=async(from,to)=>{await rename(from,to);if(from===source)await fs.promises.writeFile(to+'/101.json','{\"pid\":101,\"changed\":true}\\n');};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Registry changed during setup/);
  assert.equal((await lstat(f.source)).isDirectory(), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.source, '101.json'))), { pid: 101, changed: true });
  assert.deepEqual(await snapshot(f.target), target);
});

test('Claude registry rollback preserves a changed shared copy instead of deleting another process update', async (t) => {
  const f = await registryFixture(t);
  const result = await f.fault("fs.promises.symlink=async()=>{await fs.promises.writeFile(target+'/101.json','{\"pid\":101,\"changed\":true}\\n');throw new Error('Synthetic link failure');};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Shared registry file kept at/);
  assert.equal((await lstat(f.source)).isDirectory(), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, '101.json'))), { pid: 101, changed: true });
  await assert.rejects(lstat(path.join(f.target, f.key)), { code: 'ENOENT' });
});

test('Claude registry setup never replaces a source path recreated during the link gap', async (t) => {
  const f = await registryFixture(t), original = await snapshot(f.source);
  const result = await f.fault("fs.promises.symlink=async(to,from)=>{await fs.promises.mkdir(from,{mode:0o700});await fs.promises.writeFile(from+'/303.json','{\"pid\":303}\\n',{mode:0o600});const error=new Error('Synthetic source path collision');error.code='EEXIST';throw error;};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Original registry backup kept at/);
  assert.deepEqual(await snapshot(f.source), { '303.json': Buffer.from('{"pid":303}\n').toString('base64') });
  const backup = (await readdir(f.claude)).find((name) => name.startsWith('.asb-bridge-sessions-'));
  assert.deepEqual(await snapshot(path.join(f.claude, backup, 'sessions')), original);
  for (const [name, bytes] of Object.entries(f.rows)) assert.equal(await readFile(path.join(f.target, name), 'utf8'), bytes);
});

test('Claude registry setup detects a source path replaced after link creation and keeps the backup', async (t) => {
  const f = await registryFixture(t), original = await snapshot(f.source);
  const result = await f.fault("const symlink=fs.promises.symlink;fs.promises.symlink=async(to,from,...args)=>{await symlink(to,from,...args);await fs.promises.unlink(from);await fs.promises.mkdir(from,{mode:0o700});};");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Registry link changed during setup.*Original registry backup kept at/);
  assert.deepEqual(await snapshot(f.source), {});
  const backup = (await readdir(f.claude)).find((name) => name.startsWith('.asb-bridge-sessions-'));
  assert.deepEqual(await snapshot(path.join(f.claude, backup, 'sessions')), original);
});

test('Claude registry CLI requires exactly two explicit absolute homes and never installs detected targets', async (t) => {
  const f = await registryFixture(t), before = await snapshot(f.home);
  for (const args of [[], [f.claude], [f.claude, f.shared, '--force'], ['--all', f.shared], ['relative', f.shared], [f.claude, `${f.shared}\n`]]) {
    const result = f.run(['link-claude', ...args]);
    assert.equal(result.status, 1);
    assert.deepEqual(await snapshot(f.home), before);
    assert.deepEqual(await f.calls(), []);
  }
});

test('OpenCode install writes the plugin bundle and skill and leaves opencode.json untouched', async (t) => {
  const f = await fixture(t);
  const opencodeConfig = path.join(f.env.XDG_CONFIG_HOME, 'opencode');
  const opencodeState = path.join(f.env.XDG_STATE_HOME, 'opencode');
  await mkdir(path.join(opencodeConfig, 'plugins'), { recursive: true });
  await writeFile(path.join(opencodeConfig, 'opencode.json'), '{"$schema":"https://opencode.ai/config.json"}\n');
  await writeFile(path.join(f.bin, 'opencode'), `#!/bin/sh\nif [ "\${1-}" = debug ] && [ "\${2-}" = paths ]; then printf 'config: %s\nstate: %s\n' '${opencodeConfig}' '${opencodeState}'; exit 0; fi\nprintf 'opencode 2.1.2\n'\n`, { mode: 0o755 });
  const before = await snapshot(f.home);
  const result = f.run(['install', '--opencode']);
  passed(result);
  assert.match(result.stdout, /OpenCode .*installed 0\.8\.0/);
  const plugin = path.join(opencodeConfig, 'plugins', 'asb-bridge');
  assert.equal(await skillState(plugin), 'ok');
  assert.equal(await skillState(path.join(opencodeConfig, 'skills/bridge')), 'ok');
  const packageJson = JSON.parse(await readFile(path.join(plugin, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'asb-bridge');
  assert.equal(packageJson.version, '0.8.0');
  assert.equal(packageJson.type, 'module');
  const baked = JSON.parse(await readFile(path.join(plugin, 'asb-bridge.json'), 'utf8'));
  assert.equal(baked.schema, 1);
  assert.equal(baked.claudeConfigDir, f.claude);
  assert.equal(baked.stateDir, path.join(opencodeState, 'plugin-state', 'asb-bridge'));
  const bundle = await readFile(path.join(plugin, 'index.js'), 'utf8');
  assert.ok(bundle.includes('asb.bridge') || bundle.includes('asb_bridge'));
  assert.equal(await readFile(path.join(opencodeConfig, 'opencode.json'), 'utf8'), '{"$schema":"https://opencode.ai/config.json"}\n');
  const after = await snapshot(f.home);
  const underConfig = (file) => file === '.config/opencode' || file.startsWith('.config/opencode/');
  for (const [file, value] of Object.entries(after)) if (!underConfig(file)) assert.equal(value, before[file], file);
  for (const file of Object.keys(before)) if (!underConfig(file)) assert.ok(file in after, file);
});

test('OpenCode install is repeatable and refuses modified or foreign folders without force', async (t) => {
  const f = await fixture(t);
  const opencodeConfig = path.join(f.env.XDG_CONFIG_HOME, 'opencode');
  await mkdir(opencodeConfig, { recursive: true });
  await writeFile(path.join(f.bin, 'opencode'), `#!/bin/sh\nif [ "\${1-}" = debug ]; then printf 'config: %s\nstate: %s\n' '${opencodeConfig}' '${path.join(f.env.XDG_STATE_HOME, 'opencode')}'; exit 0; fi\nprintf 'opencode 2.1.2\n'\n`, { mode: 0o755 });
  passed(f.run(['install', '--opencode']));
  passed(f.run(['install', '--opencode']));
  await writeFile(path.join(opencodeConfig, 'plugins', 'asb-bridge', 'index.js'), '// modified\n');
  const refused = f.run(['install', '--opencode']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /modified/);
  passed(f.run(['install', '--opencode', '--force']));
  assert.notEqual(await readFile(path.join(opencodeConfig, 'plugins', 'asb-bridge', 'index.js'), 'utf8'), '// modified\n');
});

test('OpenCode --all installs only when the config folder exists and uninstall removes the plugin and skill', async (t) => {
  const f = await fixture(t);
  const opencodeConfig = path.join(f.env.XDG_CONFIG_HOME, 'opencode');
  await writeFile(path.join(f.bin, 'opencode'), `#!/bin/sh\nif [ "\${1-}" = debug ]; then printf 'config: %s\nstate: %s\n' '${opencodeConfig}' '${path.join(f.env.XDG_STATE_HOME, 'opencode')}'; exit 0; fi\nprintf 'opencode 2.1.2\n'\n`, { mode: 0o755 });
  const missing = f.run(['install', '--all']);
  passed(missing);
  assert.ok(!existsSync(path.join(opencodeConfig, 'plugins', 'asb-bridge')));
  await mkdir(opencodeConfig, { recursive: true });
  const installed = f.run(['install', '--all']);
  passed(installed);
  assert.ok(existsSync(path.join(opencodeConfig, 'plugins', 'asb-bridge', 'index.js')));
  const removed = f.run(['uninstall', '--opencode']);
  passed(removed);
  assert.ok(!existsSync(path.join(opencodeConfig, 'plugins', 'asb-bridge')));
  assert.ok(!existsSync(path.join(opencodeConfig, 'skills', 'bridge')));
});

test('parseDebugPaths reads key: value and key=value lines with either line ending', () => {
  assert.deepEqual(parseDebugPaths('Config: /tmp/c\nstate = /tmp/s\n'), { config: '/tmp/c', state: '/tmp/s' });
  assert.deepEqual(parseDebugPaths('CONFIG=C:\\Users\\a\\AppData\\Roaming\\opencode\r\nState: C:\\Users\\a\\AppData\\Local\\opencode\r\n'),
    { config: 'C:\\Users\\a\\AppData\\Roaming\\opencode', state: 'C:\\Users\\a\\AppData\\Local\\opencode' });
  assert.deepEqual(parseDebugPaths(''), {});
  assert.deepEqual(parseDebugPaths(null), {});
  assert.deepEqual(parseDebugPaths('nonsense\nconfig: /tmp/only\n'), { config: '/tmp/only' });
});

test('opencodePaths prefers --opencode-config, then debug paths, then XDG', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-opencode-paths-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, 'bin');
  await mkdir(bin, { recursive: true });
  const home = path.join(temporary, 'home');
  await mkdir(home, { recursive: true });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state') };
  // 1. Explicit config wins and nothing is executed.
  assert.deepEqual(await opencodePaths({ opencodeConfig: '/tmp/explicit', env }), { config: path.resolve('/tmp/explicit'), state: path.resolve(path.join(home, '.local/state', 'opencode')) });
  // 2. No binary: XDG fallbacks.
  assert.deepEqual(await opencodePaths({ env }), {
    config: path.resolve(path.join(home, '.config', 'opencode')),
    state: path.resolve(path.join(home, '.local/state', 'opencode')),
  });
  // 3. A fake opencode that prints debug paths.
  await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nif [ "$1" = debug ] && [ "$2" = paths ]; then printf \'config: /tmp/from-debug\\nstate = /tmp/state-debug\\n\'; exit 0; fi\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await opencodePaths({ env }), { config: path.resolve('/tmp/from-debug'), state: path.resolve('/tmp/state-debug') });
  // 4. A failing binary falls back to XDG.
  await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await opencodePaths({ env }), {
    config: path.resolve(path.join(home, '.config', 'opencode')),
    state: path.resolve(path.join(home, '.local/state', 'opencode')),
  });
  // 5. Without XDG, the process home is the default (options.env.HOME is not read here).
  assert.deepEqual(await opencodePaths({ env: { PATH: '/usr/bin:/bin', HOME: home } }), {
    config: path.resolve(path.join(os.homedir(), '.config', 'opencode')),
    state: path.resolve(path.join(os.homedir(), '.local', 'state', 'opencode')),
  });
});

test('commandLine and executable handle the Windows shapes with an injected platform', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-win-shapes-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, 'bin');
  await mkdir(bin, { recursive: true });
  // commandLine: a plain exe is direct; a .cmd goes through cmd.exe.
  assert.deepEqual(commandLine('/tools/opencode.exe', ['debug', 'paths'], 'win32'), { command: '/tools/opencode.exe', args: ['debug', 'paths'], options: {} });
  assert.deepEqual(commandLine('C:\\tools\\opencode.cmd', ['debug', 'paths'], 'win32'),
    { command: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\tools\\opencode.cmd" "debug" "paths""'], options: { windowsVerbatimArguments: true } });
  assert.deepEqual(commandLine('/tools/opencode.sh', ['debug'], 'linux'), { command: '/tools/opencode.sh', args: ['debug'], options: {} });
  assert.throws(() => commandLine('C:\\tools\\bad&name.cmd', [], 'win32'));
  // executable: win32 uses PATHEXT and ';'; linux needs the execute bit.
  // PATHEXT is lowercased before the lookup, so the file name must be lowercase on a case-sensitive test host.
  await writeFile(path.join(bin, 'opencode.exe'), 'x', { mode: 0o644 });
  await writeFile(path.join(bin, 'other'), 'x', { mode: 0o755 });
  const win = await executable('opencode', { platform: 'win32', env: { PATH: bin, PATHEXT: '.COM;.EXE' }, searchPath: bin, cwd: temporary });
  assert.equal(win, path.join(bin, 'opencode.exe'));
  const lin = await executable('other', { platform: 'linux', env: { PATH: bin }, searchPath: bin, cwd: temporary });
  assert.equal(lin, path.join(bin, 'other'));
  assert.equal(await executable('missing', { platform: 'linux', env: { PATH: bin }, searchPath: bin, cwd: temporary }), '');
});

for (const [name, source, expected] of [
  ['drive', String.raw`\\?\C:\x\agent-switch-board`, String.raw`C:\x\agent-switch-board`],
  ['UNC', String.raw`\\?\UNC\server\share\agent-switch-board`, String.raw`\\server\share\agent-switch-board`],
  ['Linux', '/opt/agent-switch-board', '/opt/agent-switch-board'],
  ['other prefix', String.raw`\\?\Volume{test}\agent-switch-board`, String.raw`\\?\Volume{test}\agent-switch-board`],
]) {
  for (const format of ['text', 'json']) {
    test(`bridge status normalizes only Windows verbatim marketplace paths (${name}, ${format})`, async (t) => {
      const f = await fixture(t);
      await writeFile(path.join(f.codex, 'config.toml'), `[marketplaces.asb]\nsource = ${JSON.stringify(source)}\n`);
      const result = f.run(['status', ...(format === 'json' ? ['--json'] : [])], {}, { platform: 'win32' });
      passed(result);
      if (format === 'json') assert.equal(JSON.parse(result.stdout).codex.find(row => row.home === f.codex).marketplace.source, expected);
      else assert.ok(result.stdout.includes(`Codex ${f.codex}: marketplace ${expected};`), result.stdout);
    });
  }
}
