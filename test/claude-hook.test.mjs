import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHook } from '../scripts/asb-agent.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { HOOK_TIMEOUT } from '../src/claude-hook.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';

// Every run has a temp HOME, a temp ASB config dir, and temp target dirs with made-up settings files.
const agent = fileURLToPath(new URL('../scripts/asb-agent.mjs', import.meta.url));
const launcherFile = fileURLToPath(new URL('../scripts/asb', import.meta.url));
const LAUNCHER = '/opt/asb-test/bin/asb';
const COMMAND = `${LAUNCHER} agent claude-wait`;
const ENTRY = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: COMMAND, timeout: HOOK_TIMEOUT }] };
const OLD = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/old/place/asb agent claude-wait', timeout: 900 }] };
const BASH = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/check-bash' }] };
const ASK_OTHER = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/usr/local/bin/notify-question', timeout: 30 }] };

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-claude-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_RUNTIME_DIR: path.join(dir, 'runtime'),
    XDG_DATA_HOME: path.join(dir, 'data'), PATH: '/usr/bin:/bin', ASB_NODE: process.execPath, ASB_INSTALLED_LAUNCHER: LAUNCHER };
  return { dir, env };
}

async function target(base, name, settings) {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  if (settings !== undefined) await writeFile(path.join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2), { mode: 0o600 });
  return dir;
}

const cli = (env, args, input = '') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [agent, 'claude-hook', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});

// In this process the home folder is not the temp HOME, so the lines name the full dir.
async function local(env, args, options = {}) {
  const out = [];
  const err = [];
  const code = await claudeHook(args, { env, log: (line) => out.push(line), error: (line) => err.push(line), ...options });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const read = async (dir) => JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
const tree = async (dir) => Promise.all((await readdir(dir, { recursive: true })).sort().map(async (name) => {
  const info = await lstat(path.join(dir, name));
  return [name, info.ino, info.mode, info.size, info.mtimeMs, info.isFile() ? await readFile(path.join(dir, name), 'utf8') : ''];
}));
const ourCount = (value) => (value.hooks?.PermissionRequest || []).flatMap((item) => item.hooks || [])
  .filter((hook) => hook.command?.endsWith(' agent claude-wait')).length;

async function sourcesFile(env, profiles) {
  const sources = [{ id: 'codex', provider: 'codex', label: 'Codex', dataDir: path.join(env.HOME, '.codex'), launcher: '', enabled: true },
    ...profiles.map(([id, projectsDir, enabled = true], index) => ({ id, provider: 'claude-desktop-code', label: `Claude ${index}`,
      dataDir: path.join(env.HOME, `claude-app-${index}`), projectsDir, launcher: '', enabled }))];
  await mkdir(path.join(env.XDG_CONFIG_HOME, 'asb'), { recursive: true });
  await writeFile(path.join(env.XDG_CONFIG_HOME, 'asb', 'sources.json'), JSON.stringify({ version: 1, sources }));
}

test('install makes a missing settings file with mode 0600 and only the hook entry', async (t) => {
  const { dir, env } = await home(t);
  const config = await target(dir, 'claude-a');
  const result = await cli(env, ['install', '--config-dir', config]);
  assert.deepEqual(result, { code: 0, stdout: 'Claude ~/claude-a: installed\n', stderr: '' });
  assert.equal(await readFile(path.join(config, 'settings.json'), 'utf8'), `${JSON.stringify({ hooks: { PermissionRequest: [ENTRY] } }, null, 2)}\n`);
  assert.equal((await stat(path.join(config, 'settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(config), ['settings.json']);
  assert.deepEqual(JSON.parse((await cli(env, ['remove', '--json', '--config-dir', config])).stdout), { targets: [{ dir: config, result: 'removed' }] });
});

test('install on an empty object, on other hooks and keys, and on an old entry; a second install changes nothing', async (t) => {
  const { dir, env } = await home(t);
  const empty = await target(dir, 'empty', '{}');
  const other = { model: 'made-up', env: { MADE_UP: 'value' },
    hooks: { PreToolUse: [BASH], PermissionRequest: [BASH, ASK_OTHER] }, permissions: { allow: ['Read'] } };
  const others = await target(dir, 'others', other);
  const oldValue = { hooks: { PermissionRequest: [BASH, OLD, ASK_OTHER] } };
  const old = await target(dir, 'old', oldValue);
  assert.equal((await cli(env, ['status', '--config-dir', old])).stdout, 'Claude ~/old: other launcher\n');
  for (const config of [empty, others, old]) assert.equal((await cli(env, ['install', '--config-dir', config])).code, 0);
  assert.deepEqual(await read(empty), { hooks: { PermissionRequest: [ENTRY] } });
  assert.equal(await readFile(path.join(empty, 'settings.json.asb-backup'), 'utf8'), '{}');
  assert.deepEqual(await read(others), { ...other, hooks: { ...other.hooks, PermissionRequest: [BASH, ASK_OTHER, ENTRY] } });
  assert.deepEqual(await read(old), { hooks: { PermissionRequest: [BASH, ENTRY, ASK_OTHER] } });
  const before = await tree(others);
  const again = await cli(env, ['install', '--config-dir', others]);
  assert.deepEqual(again, { code: 0, stdout: 'Claude ~/others: unchanged\n', stderr: '' });
  assert.deepEqual(await tree(others), before);
  assert.deepEqual(JSON.parse(await readFile(path.join(others, 'settings.json.asb-backup'), 'utf8')), other);
});

test('invalid JSON and wrong types are refused: the file and the dir stay as they are', async (t) => {
  const { dir, env } = await home(t);
  for (const [index, text] of ['{bad', '[]', 'null', '"x"', '{"hooks":[]}', '{"hooks":{"PermissionRequest":{}}}', '{"hooks":null}'].entries()) {
    const config = await target(dir, `bad-${index}`, text);
    const before = await tree(config);
    for (const action of ['install', 'remove']) {
      assert.deepEqual(await cli(env, [action, '--config-dir', config]), { code: 1, stdout: `Claude ~/bad-${index}: invalid settings\n`, stderr: '' }, text);
    }
    assert.equal((await cli(env, ['status', '--config-dir', config])).code, 0);
    assert.deepEqual(await tree(config), before, text);
  }
});

test('no settings content and no JSON.parse message reach stdout, stderr, or --json', async (t) => {
  const { dir, env } = await home(t);
  const marker = 'MADE-UP-SECRET-7f3a';
  const broken = await target(dir, 'broken', `{"env":{"API_KEY":"${marker}`);
  const wrong = await target(dir, 'wrong', { env: { API_KEY: marker }, hooks: { PermissionRequest: `${marker}-broken` } });
  for (const config of [broken, wrong]) {
    for (const args of [['install'], ['remove'], ['status'], ['install', '--json'], ['remove', '--json'], ['status', '--json']]) {
      const [action, ...rest] = args;
      const result = await cli(env, [action, '--config-dir', config, ...rest]);
      const text = `${result.stdout}${result.stderr}`;
      assert.ok(!text.includes(marker), args.join(' '));
      assert.ok(!/Unexpected|position|SyntaxError/.test(text), args.join(' '));
    }
  }
  assert.deepEqual(JSON.parse((await cli(env, ['status', '--config-dir', wrong, '--json'])).stdout), { targets: [{ dir: wrong, state: 'invalid settings' }] });
});

test('install and remove change our hook objects, not whole items; two of our entries leave one', async (t) => {
  const { dir, env } = await home(t);
  const shared = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/usr/local/bin/log-question' }, OLD.hooks[0]] };
  const config = await target(dir, 'shared', { hooks: { PermissionRequest: [BASH, shared, OLD] } });
  assert.equal((await cli(env, ['install', '--config-dir', config])).code, 0);
  const installed = await read(config);
  assert.deepEqual(installed, { hooks: { PermissionRequest: [BASH, ENTRY, { ...shared, hooks: [shared.hooks[0]] }] } });
  assert.equal(ourCount(installed), 1);
  assert.equal((await cli(env, ['remove', '--config-dir', config])).stdout, 'Claude ~/shared: removed\n');
  assert.deepEqual(await read(config), { hooks: { PermissionRequest: [BASH, { ...shared, hooks: [shared.hooks[0]] }] } });
  const twice = await target(dir, 'twice', { hooks: { PermissionRequest: [ENTRY, ASK_OTHER, ENTRY] } });
  assert.equal((await cli(env, ['status', '--config-dir', twice])).stdout, 'Claude ~/twice: other launcher\n');
  assert.equal((await cli(env, ['install', '--config-dir', twice])).stdout, 'Claude ~/twice: installed\n');
  assert.deepEqual(await read(twice), { hooks: { PermissionRequest: [ENTRY, ASK_OTHER] } });
});

test('install then remove gives back the parsed value of a file with the key shape of a real one; the backup is made once', async (t) => {
  const { dir, env } = await home(t);
  const value = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`key${index}`, index % 3 ? `made-up-${index}` : { nested: [index, true, null] }]));
  value.env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/made-up', ANTHROPIC_AUTH_TOKEN: 'made-up-token', OTHER: '1' };
  value.hooks = { PreToolUse: [BASH] };
  assert.equal(Object.keys(value).length, 20);
  const config = await target(dir, 'shape', value);
  assert.equal((await cli(env, ['install', '--config-dir', config])).code, 0);
  assert.deepEqual(await read(config), { ...value, hooks: { PreToolUse: [BASH], PermissionRequest: [ENTRY] } });
  const backup = path.join(config, 'settings.json.asb-backup');
  const first = await stat(backup);
  assert.equal((await cli(env, ['remove', '--config-dir', config])).code, 0);
  assert.deepEqual(await read(config), value);
  assert.equal((await cli(env, ['install', '--config-dir', config])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), value);
  assert.equal((await stat(backup)).mtimeMs, first.mtimeMs);
});

test('remove deletes only our entries and only the containers that became empty because of it', async (t) => {
  const { dir, env } = await home(t);
  const cases = [
    [{ hooks: { PermissionRequest: [OLD] } }, {}, 'removed'],
    [{ hooks: { PermissionRequest: [ENTRY], PreToolUse: [BASH] } }, { hooks: { PreToolUse: [BASH] } }, 'removed'],
    [{ a: 1, hooks: { PermissionRequest: [BASH, ENTRY, ASK_OTHER] } }, { a: 1, hooks: { PermissionRequest: [BASH, ASK_OTHER] } }, 'removed'],
    [{ hooks: { PermissionRequest: [] } }, { hooks: { PermissionRequest: [] } }, 'not installed'],
    [{ hooks: {} }, { hooks: {} }, 'not installed'],
    [{ hooks: { PermissionRequest: [BASH] } }, { hooks: { PermissionRequest: [BASH] } }, 'not installed'],
  ];
  for (const [index, [before, after, result]] of cases.entries()) {
    const config = await target(dir, `case-${index}`, before);
    const listing = await tree(config);
    assert.deepEqual(await cli(env, ['remove', '--config-dir', config]), { code: 0, stdout: `Claude ~/case-${index}: ${result}\n`, stderr: '' });
    assert.deepEqual(await read(config), after);
    if (result === 'not installed') assert.deepEqual(await tree(config), listing);
  }
  const missing = await target(dir, 'missing');
  assert.deepEqual(await cli(env, ['remove', '--config-dir', missing]), { code: 0, stdout: 'Claude ~/missing: not installed\n', stderr: '' });
  assert.deepEqual(await readdir(missing), []);
});

test('status reports each state, and --json gives one object', async (t) => {
  const { dir, env } = await home(t);
  const installed = await target(dir, 'p-installed', { hooks: { PermissionRequest: [ENTRY] } });
  const none = await target(dir, 'p-none', { hooks: { PermissionRequest: [ASK_OTHER] } });
  const missing = await target(dir, 'p-missing');
  const other = await target(dir, 'p-other', { hooks: { PermissionRequest: [OLD] } });
  const timeout = await target(dir, 'p-timeout', { hooks: { PermissionRequest: [{ ...ENTRY, hooks: [{ ...ENTRY.hooks[0], timeout: 900 }] }] } });
  const invalid = await target(dir, 'p-invalid', '{');
  const expected = [[installed, 'installed'], [none, 'not installed'], [missing, 'not installed'], [other, 'other launcher'],
    [timeout, 'other launcher'], [invalid, 'invalid settings'], [path.join(dir, 'p-absent'), 'not found']];
  for (const [config, state] of expected) {
    assert.deepEqual(await cli(env, ['status', '--config-dir', config]), { code: 0, stdout: `Claude ~/${path.basename(config)}: ${state}\n`, stderr: '' });
    assert.deepEqual(JSON.parse((await cli(env, ['status', '--json', '--config-dir', config])).stdout), { targets: [{ dir: config, state }] });
  }
  const absent = await cli(env, ['install', '--config-dir', path.join(dir, 'p-absent')]);
  assert.equal(absent.stdout, 'Claude ~/p-absent: not found\n');
  await assert.rejects(stat(path.join(dir, 'p-absent')), { code: 'ENOENT' });
});

test('a relative --config-dir and a bad command line are refused', async (t) => {
  const { dir, env } = await home(t);
  const before = await tree(dir);
  for (const args of [['install', '--config-dir', 'claude'], ['status', '--config-dir', './claude'], ['install', '--config-dir'], ['bogus'], [],
    ['install', '--json', '--json'], ['install', '--other', dir]]) {
    const result = await cli(env, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await tree(dir), before);
});

test('without ASB_INSTALLED_LAUNCHER install is refused and writes nothing', async (t) => {
  const { dir, env } = await home(t);
  const config = await target(dir, 'claude', '{}');
  const before = await tree(dir);
  for (const launcher of [undefined, 'relative/asb']) {
    const next = { ...env };
    if (launcher === undefined) delete next.ASB_INSTALLED_LAUNCHER; else next.ASB_INSTALLED_LAUNCHER = launcher;
    assert.deepEqual(await cli(next, ['install', '--config-dir', config]),
      { code: 1, stdout: '', stderr: 'Run claude-hook install from the installed asb (ASB_INSTALLED_LAUNCHER is not set).\n' });
  }
  assert.deepEqual(await tree(dir), before);
});

test('the targets are the enabled Claude profiles of the ASB sources; the engine lists the same ones', async (t) => {
  const { dir, env } = await home(t);
  const first = await target(dir, 'profile-one');
  const second = await target(dir, 'profile-two', { hooks: { PermissionRequest: [ENTRY] } });
  await target(dir, 'profile-off');
  await target(dir, 'profile-transcripts');
  await sourcesFile(env, [['claude-desktop-code', path.join(first, 'projects')], ['claude-two', path.join(second, 'projects')],
    ['claude-off', path.join(dir, 'profile-off', 'projects'), false], ['claude-four', path.join(dir, 'profile-transcripts', 'transcripts')]]);
  const expected = [{ dir: first, state: 'not installed' }, { dir: second, state: 'installed' }];
  const previous = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  for (const claudeConfig of [undefined, path.join(dir, 'profile-off')]) {
    const next = claudeConfig ? { ...env, CLAUDE_CONFIG_DIR: claudeConfig } : env;
    if (claudeConfig) process.env.CLAUDE_CONFIG_DIR = claudeConfig; else delete process.env.CLAUDE_CONFIG_DIR;
    const command = JSON.parse((await cli(next, ['status', '--json'])).stdout).targets;
    assert.deepEqual(command, expected);
    const server = createSwitchboardServer({ sourceToken: 'a'.repeat(64), pendingStatePath: false, palettePath: false,
      sourceRegistry: new AppSourceRegistry({ homeDir: dir, env: next, discoverPersonal: false }),
      phoneGateway: { status: async () => ({ enabled: false }) }, loadDashboard: async () => ({ providers: [], threads: [] }) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const body = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/phone',
        headers: { 'x-asb-source-token': 'a'.repeat(64) } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve(JSON.parse(text)));
      }).on('error', reject));
      assert.deepEqual(body.claudeHook.map(({ dir: folder }) => folder), command.map(({ dir: folder }) => folder));
      // The engine of this test has no installed launcher unless the test runs from an installed asb.
      assert.deepEqual(body.claudeHook.map(({ state }) => state), ['not installed', process.env.ASB_INSTALLED_LAUNCHER ? 'other launcher' : 'installed']);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  assert.equal((await cli(env, ['install'])).stdout, 'Claude ~/profile-one: installed\nClaude ~/profile-two: unchanged\n');
  assert.deepEqual(await readdir(path.join(dir, 'profile-off')), []);
  assert.deepEqual(await readdir(path.join(dir, 'profile-transcripts')), []);
});

test('targets that share one real file through a link get one write and one backup; a dangling link is refused', async (t) => {
  const { dir, env } = await home(t);
  const linked = await target(dir, 'linked');
  const real = await target(dir, 'real', { model: 'made-up' });
  await symlink(path.join(real, 'settings.json'), path.join(linked, 'settings.json'));
  await sourcesFile(env, [['claude-desktop-code', path.join(linked, 'projects')], ['claude-real', path.join(real, 'projects')]]);
  assert.deepEqual(await cli(env, ['install']), { code: 0, stdout: 'Claude ~/linked: installed\nClaude ~/real: installed\n', stderr: '' });
  assert.ok((await lstat(path.join(linked, 'settings.json'))).isSymbolicLink());
  assert.equal(await readlink(path.join(linked, 'settings.json')), path.join(real, 'settings.json'));
  assert.deepEqual(await read(real), { model: 'made-up', hooks: { PermissionRequest: [ENTRY] } });
  assert.deepEqual((await readdir(real)).sort(), ['settings.json', 'settings.json.asb-backup']);
  assert.deepEqual(await readdir(linked), ['settings.json']);
  assert.equal((await cli(env, ['status'])).stdout, 'Claude ~/linked: installed\nClaude ~/real: installed\n');
  const dangling = await target(dir, 'dangling');
  await symlink(path.join(dir, 'nowhere', 'settings.json'), path.join(dangling, 'settings.json'));
  for (const action of ['install', 'remove', 'status']) {
    assert.equal((await cli(env, [action, '--config-dir', dangling])).stdout, 'Claude ~/dangling: invalid settings\n');
  }
  assert.deepEqual(await readdir(dangling), ['settings.json']);
  await assert.rejects(stat(path.join(dir, 'nowhere')), { code: 'ENOENT' });
});

test('under umask 022 the temporary file, the final file, and the backup keep mode 0600', async (t) => {
  const { dir, env } = await home(t);
  const old = process.umask(0o022);
  t.after(() => process.umask(old));
  const config = await target(dir, 'modes', { model: 'made-up' });
  await chmod(path.join(config, 'settings.json'), 0o600);
  const seen = [];
  const result = await local(env, ['install', '--config-dir', config], { beforeRename: async (file) => {
    seen.push([path.dirname(file), (await stat(file)).mode & 0o777]);
  } });
  assert.equal(result.code, 0);
  assert.deepEqual(seen, [[config, 0o600]]);
  assert.equal((await stat(path.join(config, 'settings.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(config, 'settings.json.asb-backup'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(config)).sort(), ['settings.json', 'settings.json.asb-backup']);
  // A group-writable file keeps its mode, also under the umask.
  const shared = await target(dir, 'shared', { model: 'made-up' });
  await chmod(path.join(shared, 'settings.json'), 0o664);
  assert.equal((await local(env, ['install', '--config-dir', shared])).code, 0);
  assert.equal((await stat(path.join(shared, 'settings.json'))).mode & 0o777, 0o664);
  assert.equal((await stat(path.join(shared, 'settings.json.asb-backup'))).mode & 0o777, 0o664);
});

test('the written command runs the launcher for every install path, also with shell characters', async (t) => {
  const { dir, env } = await home(t);
  for (const name of ['a$HOME', 'r&d', 'semi;colon', 'paren(x)', 'back`tick', 'pipe|x', 'gt>x', "it's", 'sp ace', 'star*', 'hash#', 'tilde~']) {
    const bin = path.join(dir, 'bin', name);
    await mkdir(bin, { recursive: true });
    const launcher = path.join(bin, 'asb');
    await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const config = await target(dir, `c-${Buffer.from(name).toString('hex')}`, { model: 'made-up' });
    const withLauncher = { ...env, ASB_INSTALLED_LAUNCHER: launcher };
    assert.equal((await local(withLauncher, ['install', '--config-dir', config])).code, 0, name);
    const { command } = (await read(config)).hooks.PermissionRequest[0].hooks[0];
    const work = await mkdtemp(path.join(dir, 'work-'));
    const run = await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd: work, env: { PATH: '/usr/bin:/bin' } });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    assert.deepEqual(run, { code: 0, stdout: 'agent\nclaude-wait\n' }, name);
    assert.deepEqual(await readdir(work), [], name);
    const status = await local(withLauncher, ['status', '--config-dir', config, '--json']);
    assert.equal(JSON.parse(status.stdout).targets[0].state, 'installed', name);
  }
});

test('a write between the read and the rename changes nothing and asks for a new run', async (t) => {
  const { dir, env } = await home(t);
  const config = await target(dir, 'race', { model: 'made-up' });
  const file = path.join(config, 'settings.json');
  for (const action of ['install', 'remove']) {
    if (action === 'remove') await writeFile(file, JSON.stringify({ hooks: { PermissionRequest: [ENTRY] } }), { mode: 0o600 });
    const before = await readFile(file, 'utf8');
    const result = await local(env, [action, '--config-dir', config], { beforeRename: () => appendFile(file, ' ') });
    assert.deepEqual(result, { code: 1, stdout: `Claude ${config}: settings changed`, stderr: 'Settings changed during the install. Run it again.' });
    assert.equal(await readFile(file, 'utf8'), `${before} `);
    assert.deepEqual(await readdir(config), ['settings.json']);
  }
});

test('on win32 install is refused, and status and remove work', async (t) => {
  const { dir, env } = await home(t);
  const config = await target(dir, 'windows', { hooks: { PermissionRequest: [ENTRY] } });
  const before = await tree(config);
  assert.deepEqual(await local(env, ['install', '--config-dir', config], { platform: 'win32' }),
    { code: 1, stdout: '', stderr: 'The Claude Code question hook works on Linux only for now.' });
  assert.deepEqual(await tree(config), before);
  assert.deepEqual(JSON.parse((await local(env, ['status', '--json', '--config-dir', config], { platform: 'win32' })).stdout),
    { targets: [{ dir: config, state: 'installed' }] });
  assert.equal((await local(env, ['remove', '--config-dir', config], { platform: 'win32' })).code, 0);
  assert.deepEqual(await read(config), {});
});

test('the written command runs the installed launcher: with bad stdin it exits 0 with no output', { skip: process.platform === 'win32' }, async (t) => {
  const { dir, env } = await home(t);
  const config = await target(dir, 'run');
  const installed = await cli({ ...env, ASB_INSTALLED_LAUNCHER: launcherFile }, ['install', '--config-dir', config]);
  assert.equal(installed.code, 0, installed.stderr);
  const [{ command }] = (await read(config)).hooks.PermissionRequest[0].hooks;
  assert.equal(command, `${launcherFile} agent claude-wait`);
  const ran = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end('not json {');
  });
  assert.deepEqual(ran, { code: 0, output: '' });
});
