import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasOldPlugin, skillState } from '../scripts/asb-bridge.mjs';

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
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-bridge-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'home'), bin = path.join(temporary, 'bin'), log = path.join(temporary, 'calls.log');
  for (const directory of [bin, ...['.codex', '.codex-personal', '.codex-other', '.claude'].map((name) => path.join(home, name))]) await mkdir(directory, { recursive: true });
  const codex = path.join(home, '.codex'), personal = path.join(home, '.codex-personal'), claude = path.join(home, '.claude');
  for (const directory of [codex, personal]) await writeFile(path.join(directory, 'config.toml'), '# Synthetic config\n');
  for (const name of ['codex', 'bun', 'claude']) await writeFile(path.join(bin, name), `#!/bin/sh\nprintf '%s|%s|%s\\n' '${name}' "\${CODEX_HOME-}" "$*" >> "$BRIDGE_LOG"\nif [ "\${1-}" = --version ]; then printf '%s\\n' '${name} 2.1.224'; fi\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PATH: `${bin}:/usr/bin:/bin`, BRIDGE_LOG: log };
  const run = (args, extra = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const calls = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { temporary, home, bin, log, codex, personal, claude, env, run, calls };
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
  const before = await snapshot(f.home), result = f.run(['install', '--codex-home', f.codex, '--claude']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs bun on PATH/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
  const uninstall = f.run(['uninstall', '--codex-home', f.codex]);
  assert.equal(uninstall.status, 1);
  assert.match(uninstall.stderr, /needs bun on PATH/);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await snapshot(f.home), before);
  passed(f.run(['install', '--claude']));
  await owned(path.join(f.claude, 'skills/bridge'), 'claude');
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
  await mkdir(path.join(f.codex, 'plugins/cache/asb/asb-bridge/0.3.0'), { recursive: true });
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
  assert.deepEqual(codex.plugin, { installed: true, enabled: true, versions: ['0.3.0'], version: '0.3.0', expectedVersion: '0.3.0', versionMatches: true });
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
  const run = (args) => spawnSync(process.execPath, [path.join(root, 'scripts/asb-bridge.mjs'), ...args], { encoding: 'utf8', env: f.env });
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
