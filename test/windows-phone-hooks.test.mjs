import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeHook, codexHook } from '../scripts/asb-agent.mjs';
import { instanceRuntimePath } from '../scripts/asb-instance.mjs';

const profiles = [
  { run: claudeHook, folder: '.claude', option: '--config-dir', file: 'settings.json', wait: 'claude-wait', matcher: '*', timeout: 21600 },
  { run: codexHook, folder: '.codex', option: '--codex-home', file: 'hooks.json', wait: 'codex-wait', matcher: '^Bash$', timeout: 45 },
];

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-win-hooks-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { USERPROFILE: home, HOME: path.join(home, 'ignored'), APPDATA: path.join(home, "Sam's roaming"), PATH: '' };
  const npm = path.join(env.APPDATA, 'npm');
  const launcher = path.join(npm, 'asb.cmd');
  await mkdir(npm, { recursive: true });
  await writeFile(launcher, '');
  const call = async (run, args, extra = {}) => {
    let stdout = '', stderr = '';
    const code = await run([...args, '--json'], { platform: 'win32', env: { ...env, ...extra }, log: (line) => { stdout = line; },
      error: (line) => { stderr = line; } });
    return { code, targets: stdout ? JSON.parse(stdout).targets : [], stderr };
  };
  return { home, env, launcher, call };
}

const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo own hook' }] }] } };

for (const { run, folder, option, file, wait, matcher, timeout } of profiles) {
  const claude = wait === 'claude-wait';
  test(`Windows ${wait} installer uses the npm launcher and keeps the first backup`, async (t) => {
    const { home, launcher, call } = await fixture(t);
    const dir = path.join(home, folder);
    await mkdir(dir);
    const target = path.join(dir, file);
    const backup = `${target}.asb-backup`;
    const old = JSON.stringify(original);
    await writeFile(target, old);
    const result = (value) => ({ code: 0, targets: [{ dir, result: value }], stderr: '' });
    const status = (state) => ({ code: 0, targets: [{ dir, state }], stderr: '' });
    const flags = [option, dir];
    // Default target selection uses USERPROFILE, not HOME.
    assert.deepEqual(await call(run, ['status']), status('not installed'));
    assert.deepEqual(await call(run, ['install', ...flags]), result('installed'));
    const config = await read(target);
    const command = claude ? `& '${launcher.replaceAll("'", "''")}' agent ${wait}` : `"${launcher}" agent ${wait}`;
    assert.deepEqual(config, { hooks: { ...original.hooks, PermissionRequest: [{ matcher, hooks: [
      { type: 'command', command, timeout, ...(claude ? { shell: 'powershell', onFailure: 'continue' } : {}) },
    ] }] } });
    assert.deepEqual(await call(run, ['status', ...flags]), status('installed'));
    assert.deepEqual(await call(run, ['status', ...flags], { ASB_INSTALLED_LAUNCHER: 'D:\\Other\\asb.cmd' }), status('other launcher'));
    assert.deepEqual(await call(run, ['install', ...flags]), result('unchanged'));
    if (claude) {
      config.hooks.PermissionRequest[0].hooks[0].shell = 'bash';
      await writeFile(target, JSON.stringify(config));
      assert.deepEqual(await call(run, ['status', ...flags]), status('other launcher'));
      assert.deepEqual(await call(run, ['install', ...flags]), result('installed'));
    }
    assert.deepEqual(await call(run, ['remove', ...flags], { APPDATA: path.join(home, 'missing') }), result('removed'));
    assert.deepEqual(await read(target), original);
    assert.equal(await readFile(backup, 'utf8'), old);
  });
}

test('Windows hook install finds a custom PATH prefix and refuses unsafe or missing launchers', async (t) => {
  const { home, launcher, call } = await fixture(t);
  const dir = path.join(home, 'explicit');
  await mkdir(dir);
  const args = ['install', '--codex-home', dir];
  const APPDATA = path.join(home, 'missing');
  assert.deepEqual(await call(codexHook, args, { APPDATA }), { code: 1, targets: [],
    stderr: 'ASB cannot find asb.cmd. Install ASB with npm and put its launcher on PATH.' });
  assert.deepEqual(await call(codexHook, args, { ASB_INSTALLED_LAUNCHER: 'D:\\%variable%\\asb.cmd' }), { code: 1, targets: [],
    stderr: 'The installed launcher path has a shell or control character. The hook cannot use it.' });
  assert.deepEqual(await call(codexHook, args, { APPDATA, PATH: path.dirname(launcher) }),
    { code: 0, targets: [{ dir, result: 'installed' }], stderr: '' });
  assert.equal((await read(path.join(dir, 'hooks.json'))).hooks.PermissionRequest[0].hooks[0].command, `"${launcher}" agent codex-wait`);
});

test('the Windows wait clients and engine use the Local AppData runtime path', () => {
  assert.equal(instanceRuntimePath({ LOCALAPPDATA: 'D:\\App Data\\Local', XDG_RUNTIME_DIR: '/other' }, 'win32'),
    'D:\\App Data\\Local\\asb\\run\\service.json');
});

test('the installed command passes stdin and args through real Windows shells', { skip: process.platform !== 'win32' }, async (t) => {
  const { home, launcher, call } = await fixture(t);
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "%~dp0test.cjs" %*\r\n`);
  await writeFile(path.join(path.dirname(launcher), 'test.cjs'),
    "console.log(JSON.stringify([process.argv.slice(2), require('node:fs').readFileSync(0, 'utf8')]));\n");
  const root = process.env.SystemRoot || 'C:\\Windows';
  const system = path.join(root, 'System32');
  const env = { SystemRoot: root, ComSpec: path.join(system, 'cmd.exe'), USERPROFILE: home, TEMP: home, TMP: home };
  const input = '{"hook_event_name":"PermissionRequest"}\n';
  for (const { run, folder, option, file, wait } of profiles) {
    const dir = path.join(home, folder);
    await mkdir(dir);
    assert.equal((await call(run, ['install', option, dir])).code, 0);
    const [{ hooks: [hook] }] = (await read(path.join(dir, file))).hooks.PermissionRequest;
    const shell = hook.shell === 'powershell' ? path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : env.ComSpec;
    const args = hook.shell === 'powershell'
      ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(hook.command, 'utf16le').toString('base64')]
      : ['/d', '/C', `"${hook.command}"`];
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(shell, args, { env, cwd: home, timeout: 5000, windowsHide: true, windowsVerbatimArguments: shell === env.ComSpec },
        (error, stdout, stderr) => error || stderr ? reject(error || new Error(stderr)) : resolve(stdout));
      child.stdin.on('error', reject);
      child.stdin.end(input);
    });
    assert.deepEqual(JSON.parse(stdout), [['agent', wait], input]);
  }
});
