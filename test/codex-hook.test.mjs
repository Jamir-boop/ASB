import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execute } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { codexHook } from '../scripts/asb-agent.mjs';

const execFile = promisify(execute);
const agent = fileURLToPath(new URL('../scripts/asb-agent.mjs', import.meta.url));
const LAUNCHER = '/opt/asb-test/bin/asb';
const COMMAND = `${LAUNCHER} agent codex-wait`;
const ENTRY = { matcher: '^Bash$', hooks: [{ type: 'command', command: COMMAND, timeout: 45 }] };
const OLD = { matcher: '^Bash$', hooks: [{ ...ENTRY.hooks[0], command: '/opt/old asb agent codex-wait' }] };
const THEIRS = { matcher: '^Bash$', hooks: [{ type: 'command', command: '/opt/check' }] };
const value = (...items) => ({ hooks: { PermissionRequest: items } });

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-codex-hook-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'run'), PATH: '/usr/bin:/bin', ASB_INSTALLED_LAUNCHER: LAUNCHER };
  const target = async (name, content) => {
    const dir = path.join(home, name);
    const file = path.join(dir, 'hooks.json');
    await mkdir(dir);
    if (content !== undefined) await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
    return { dir, file, read: async () => JSON.parse(await readFile(file, 'utf8')) };
  };
  const local = async (action, dir, options = {}, ...args) => {
    const out = [];
    const err = [];
    const code = await codexHook([action, '--codex-home', dir, ...args], { env, log: (line) => out.push(line), error: (line) => err.push(line), ...options });
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  };
  return { home, env, target, local };
}

const mode = async (file) => (await stat(file)).mode & 0o777;

test('Codex CLI status, install and remove on an explicit home, with exact entry and mode for a new file', async (t) => {
  const { target, env } = await fixture(t);
  const { dir, file } = await target('codex-one');
  const args = ['--codex-home', dir, '--json'];
  const run = async (action) => JSON.parse((await execFile(process.execPath, ['--disable-warning=ExperimentalWarning', agent, 'codex-hook', action, ...args], { env })).stdout);
  assert.deepEqual(await run('status'), { targets: [{ dir, state: 'not installed' }] });
  assert.deepEqual(await run('install'), { targets: [{ dir, result: 'installed' }] });
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(value(ENTRY), null, 2)}\n`);
  assert.equal(await mode(file), 0o600);
  assert.deepEqual(await readdir(dir), ['hooks.json']);
  assert.deepEqual(await run('status'), { targets: [{ dir, state: 'installed' }] });
  assert.deepEqual(await run('remove'), { targets: [{ dir, result: 'removed' }] });
  assert.deepEqual(await run('remove'), { targets: [{ dir, result: 'not installed' }] });
});

test('replacing old and duplicate Codex hooks preserves other data and key order; mode and first backup stay', async (t) => {
  const { target, local } = await fixture(t);
  const shared = { matcher: 'Bash', before: 'keep', hooks: [THEIRS.hooks[0], OLD.hooks[0]], after: true };
  const empty = { matcher: 'Other', hooks: [] };
  const original = { one: 1, hooks: { SessionStart: [THEIRS], PermissionRequest: [empty, shared, ENTRY, THEIRS], Stop: [] }, two: 2 };
  const { dir, file, read } = await target('codex-two', original);
  await chmod(file, 0o664);
  assert.equal((await local('status', dir)).stdout, `Codex ${dir}: other launcher`);
  const tempModes = [];
  assert.equal((await local('install', dir, { beforeRename: async (temp) => tempModes.push([path.dirname(temp), await mode(temp)]) })).code, 0);
  const kept = [empty, { ...shared, hooks: [THEIRS.hooks[0]] }, THEIRS];
  const withItems = (PermissionRequest) => ({ ...original, hooks: { ...original.hooks, PermissionRequest } });
  assert.equal(JSON.stringify(await read()), JSON.stringify(withItems([empty, ENTRY, ...kept.slice(1)])));
  const backup = `${file}.asb-backup`;
  assert.deepEqual(tempModes, [[dir, 0o664]]);
  assert.equal(await mode(file), 0o664);
  assert.equal(await mode(backup), 0o664);
  assert.equal(await readFile(backup, 'utf8'), JSON.stringify(original));
  const before = await stat(file);
  assert.equal((await local('install', dir)).stdout, `Codex ${dir}: unchanged`);
  assert.equal((await stat(file)).ino, before.ino);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.equal((await local('remove', dir)).code, 0);
  assert.equal(JSON.stringify(await read()), JSON.stringify(withItems(kept)));
  assert.equal(await readFile(backup, 'utf8'), JSON.stringify(original));
  assert.deepEqual((await readdir(dir)).sort(), ['hooks.json', 'hooks.json.asb-backup']);
});

test('Codex status matches the command, matcher, timeout and number of ASB hooks', async (t) => {
  const { target, local } = await fixture(t);
  const wrongTimeout = { ...ENTRY, hooks: [{ ...ENTRY.hooks[0], timeout: 30 }] };
  const wrongType = { ...ENTRY, hooks: [{ ...ENTRY.hooks[0], type: 'prompt' }] };
  const cases = [[value(ENTRY, THEIRS), 'installed'], [value(THEIRS, wrongType), 'not installed'], [value(OLD), 'other launcher'],
    [value({ ...ENTRY, matcher: 'Bash' }), 'other launcher'], [value(wrongTimeout), 'other launcher'], [value(ENTRY, ENTRY), 'other launcher']];
  for (const [index, [input, state]] of cases.entries()) {
    const { dir } = await target(`state-${index}`, input);
    const status = await local('status', dir, {}, '--json');
    assert.deepEqual(JSON.parse(status.stdout), { targets: [{ dir, state }] });
    assert.equal(status.stderr, '');
  }
});

test('Codex status accepts any launcher if none is set', async (t) => {
  const { target, local, env } = await fixture(t);
  const { dir } = await target('unknown-launcher', value(OLD));
  delete env.ASB_INSTALLED_LAUNCHER;
  const status = await local('status', dir, {}, '--json');
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), { targets: [{ dir, state: 'installed' }] });
});

test('install and remove refuse an edit during a write, and install cannot overwrite a new file', async (t) => {
  const { target, local } = await fixture(t);
  for (const action of ['install', 'remove']) {
    const { dir, file } = await target(`race-${action}`, value(OLD));
    const original = await readFile(file, 'utf8');
    const result = await local(action, dir, { beforeRename: () => appendFile(file, ' ') });
    assert.deepEqual(result, { code: 1, stdout: `Codex ${dir}: settings changed`, stderr: 'Settings changed during the install. Run it again.' });
    assert.equal(await readFile(file, 'utf8'), `${original} `);
    assert.deepEqual(await readdir(dir), ['hooks.json']);
  }
  const { dir, file } = await target('race-create');
  const result = await local('install', dir, { beforeRename: () => writeFile(file, '{}') });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Settings changed during the install/);
  assert.equal(await readFile(file, 'utf8'), '{}');
  assert.deepEqual(await readdir(dir), ['hooks.json']);
});

test('invalid JSON, types, oversized files, and dangling links are refused without exposing contents', async (t) => {
  const { home, target, local } = await fixture(t);
  const invalid = ['{"made-up-secret":', '[]', 'null', '"x"', '{"hooks":[]}', '{"hooks":null}', '{"hooks":{"PermissionRequest":{}}}', '{}'.padEnd(4 * 1024 * 1024 + 1)];
  for (const [index, content] of invalid.entries()) {
    const { dir, file } = await target(`invalid-${index}`, content);
    for (const action of ['install', 'remove', 'status']) {
      const result = await local(action, dir);
      assert.deepEqual(result, { code: action === 'status' ? 0 : 1, stdout: `Codex ${dir}: invalid settings`, stderr: '' });
    }
    assert.equal(await readFile(file, 'utf8'), content);
    assert.deepEqual(await readdir(dir), ['hooks.json']);
  }
  const { dir, file } = await target('dangling');
  await symlink(path.join(home, 'missing-file'), file);
  assert.equal((await local('install', dir)).code, 1);
  assert.ok((await lstat(file)).isSymbolicLink());
  assert.deepEqual(await readdir(dir), ['hooks.json']);
});

test('shell characters are quoted; a single quote or a control in the launcher path is refused', async (t) => {
  const { home, target, local, env } = await fixture(t);
  const launcher = path.join(home, 'asb & $shell');
  await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const { dir, read } = await target('quoted');
  assert.equal((await local('install', dir, { env: { ...env, ASB_INSTALLED_LAUNCHER: launcher } })).code, 0);
  const { command } = (await read()).hooks.PermissionRequest[0].hooks[0];
  assert.equal(command, `'${launcher}' agent codex-wait`);
  assert.equal((await execFile('/bin/sh', ['-c', command], { cwd: home, env })).stdout, 'agent\ncodex-wait\n');
  const refused = await target('refused');
  for (const suffix of ["'", '\n', '\t', '\x7f', '\x9f']) {
    const result = await local('install', refused.dir, { env: { ...env, ASB_INSTALLED_LAUNCHER: `${launcher}${suffix}` } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /a quote or a control character/);
  }
  assert.deepEqual(await readdir(refused.dir), []);
});

test('install refuses Windows, no launcher and a missing home; bad options change nothing', async (t) => {
  const { home, target, local, env } = await fixture(t);
  const { dir } = await target('refusals');
  assert.deepEqual(await local('install', dir, { platform: 'win32' }), { code: 1, stdout: '', stderr: 'The Codex hook works on Linux only for now.' });
  for (const launcher of ['', 'relative/asb']) {
    const result = await local('install', dir, { env: { ...env, ASB_INSTALLED_LAUNCHER: launcher } });
    assert.deepEqual(result, { code: 1, stdout: '', stderr: 'Run codex-hook install from the installed asb (ASB_INSTALLED_LAUNCHER is not set).' });
  }
  for (const targetDir of ['relative', `${dir}\t`]) assert.equal((await local('install', targetDir)).code, 2);
  assert.equal((await local('install', dir, {}, '--json', '--json')).code, 2);
  assert.equal((await local('bogus', dir)).code, 2);
  assert.deepEqual(await readdir(dir), []);
  const missing = path.join(home, 'absent');
  const result = await local('install', missing, {}, '--json');
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), { targets: [{ dir: missing, result: 'not found' }] });
  assert.equal(result.stderr, `Codex has not run here (no ${missing}).`);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  const cli = await execFile(process.execPath, ['--disable-warning=ExperimentalWarning', agent, 'codex-hook', 'install', '--codex-home', missing], { env })
    .catch(({ code, stderr }) => ({ code, stderr }));
  assert.deepEqual(cli, { code: 1, stderr: 'Codex has not run here (no ~/absent).\n' });
});
