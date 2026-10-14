import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codexBunOnPath, hasOldPlugin, skillState } from '../scripts/asb-bridge.mjs';

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
    assert.equal(result.stderr, `ASB Bridge failed: codex plugin marketplace add failed.${reason ? ` ${reason}` : ''}\n`);
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
  assert.deepEqual(report.versions, { bun: 'bun 2.1.224', codex: 'codex 2.1.224' });
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
