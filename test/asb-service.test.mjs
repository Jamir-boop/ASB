import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as turn } from 'node:timers/promises';
import { findRunningService, readServiceRuntime, serviceUnit } from '../scripts/asb-service.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';
import { RUNTIME_FILES } from '../scripts/asb-package.mjs';

const serviceScript = fileURLToPath(new URL('../scripts/asb-service.mjs', import.meta.url));
const desktopScript = fileURLToPath(new URL('../scripts/asb-desktop.mjs', import.meta.url));
const launcherScript = fileURLToPath(new URL('../scripts/asb', import.meta.url));

async function freePort() {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));
  return port;
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-service-test-'));
  const children = [];
  t.after(async () => {
    try {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
          child.kill('SIGTERM');
          try { await child.closed; } finally { clearTimeout(kill); }
        }
      }));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_RUNTIME_DIR: path.join(home, 'runtime'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    CODEX_HOME: path.join(home, 'codex'), CLAUDE_APP_DIR: path.join(home, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, 'claude-code'),
    CLAUDE_CODE_CONFIG_DIR: path.join(home, 'claude-code'), ASB_SYSTEM_INSTALL: '1', ASB_PYTHON: '/bin/true',
    ASB_NODE: process.execPath, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, ASB_SYSTEMCTL_LOG: path.join(home, 'systemctl.jsonl'),
    PORT: String(await freePort()) };
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  await mkdir(path.join(home, 'bin'));
  await writeFile(path.join(home, 'bin/systemctl'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.ASB_SYSTEMCTL_LOG, JSON.stringify(args)+'\\n');\nif (process.env.ASB_SYSTEMCTL_FAIL && args.includes(process.env.ASB_SYSTEMCTL_FAIL)) process.exit(1);\nif (args.includes('is-active')) console.log('active');\n`, { mode: 0o755 });
  const launch = (args, extra = {}, program = process.execPath) => {
    const child = spawn(program, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.output = '';
    child.errors = '';
    child.stdout.on('data', (chunk) => { child.output += chunk; });
    child.stderr.on('data', (chunk) => { child.errors += chunk; });
    child.closed = once(child, 'close');
    return child;
  };
  const command = async (args, extra) => {
    const child = launch([serviceScript, ...args], extra);
    const [code, signal] = await child.closed;
    return { code, signal, stdout: child.output, stderr: child.errors };
  };
  const systemctlCalls = async () => (await readFile(env.ASB_SYSTEMCTL_LOG, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  })).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { home, env, launch, command, systemctlCalls,
    unit: path.join(env.XDG_CONFIG_HOME, 'systemd/user/asb.service'), runtime: path.join(env.XDG_RUNTIME_DIR, 'asb/service.json') };
}

async function ready(child) {
  if (child.output.includes('ASB service:')) return;
  await new Promise((resolve, reject) => {
    const data = () => { if (child.output.includes('ASB service:')) { cleanup(); resolve(); } };
    const close = () => { cleanup(); reject(new Error(`Service did not start: ${child.errors}`)); };
    const cleanup = () => { child.stdout.off('data', data); child.off('close', close); };
    child.stdout.on('data', data);
    child.once('close', close);
  });
}

async function writeRuntime(f, value, mode = 0o600) {
  await mkdir(path.dirname(f.runtime), { recursive: true, mode: 0o700 });
  await writeFile(f.runtime, JSON.stringify(value), { mode });
  await chmod(f.runtime, mode);
}

test('service units use validated absolute executables and preserve apps on service stop', async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.home, 'asb-link');
  await symlink(launcherScript, linked);
  const text = await serviceUnit({ launcherExecutable: linked });
  assert.ok(text.includes(`Environment=ASB_NODE=${process.execPath}\n`));
  assert.ok(text.includes(`ExecStart=${linked} service run\n`));
  for (const line of ['PartOf=graphical-session.target', 'After=graphical-session.target', 'WantedBy=graphical-session.target', 'KillMode=process']) {
    assert.ok(text.includes(`${line}\n`));
  }
  assert.ok(RUNTIME_FILES.includes('scripts/asb-service.mjs'));
  for (const bad of ['with space', 'with\nnewline', 'quote"', "quote'", 'percent%', 'back\\slash', 'dollar$']) {
    const value = path.join(f.home, bad);
    await writeFile(value, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await assert.rejects(serviceUnit({ launcherExecutable: value }), /must be absolute/);
    await assert.rejects(serviceUnit({ nodeExecutable: value }), /must be absolute/);
  }
  await assert.rejects(serviceUnit({ nodeExecutable: f.home }), /executable file/);
});

test('service install and uninstall use only fake systemctl in the required order', async (t) => {
  const f = await fixture(t);
  const installed = await f.command(['install']);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(await readFile(f.unit, 'utf8'), /^# Generated by ASB: asb.service\n/);
  assert.deepEqual(await f.systemctlCalls(), [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'asb.service']]);
  const removed = await f.command(['uninstall']);
  assert.equal(removed.code, 0, removed.stderr);
  await assert.rejects(stat(f.unit), { code: 'ENOENT' });
  assert.deepEqual((await f.systemctlCalls()).slice(-2), [['--user', 'disable', '--now', 'asb.service'], ['--user', 'daemon-reload']]);
});

test('a bad installed launcher path changes no unit or systemd state', async (t) => {
  const f = await fixture(t);
  const launcher = path.join(f.home, 'bad launcher');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const reply = await f.command(['install'], { ASB_INSTALLED_LAUNCHER: launcher });
  assert.equal(reply.code, 1);
  assert.match(reply.stderr, /launcher path must be absolute/);
  await assert.rejects(stat(f.unit), { code: 'ENOENT' });
  assert.deepEqual(await f.systemctlCalls(), []);
});

test('service commands keep unrelated or linked units and stop after a systemctl failure', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.unit), { recursive: true });
  await writeFile(f.unit, '[Service]\nExecStart=/bin/true\n');
  for (const command of ['install', 'uninstall']) {
    const reply = await f.command([command]);
    assert.equal(reply.code, 1);
    assert.match(reply.stderr, /unrelated service file/);
  }
  assert.deepEqual(await f.systemctlCalls(), []);
  const other = path.join(f.home, 'other');
  await writeFile(other, 'Keep this file.');
  await rm(f.unit);
  await symlink(other, f.unit);
  assert.equal((await f.command(['install'])).code, 1);
  assert.equal(await readFile(other, 'utf8'), 'Keep this file.');
  await rm(f.unit);
  const failed = await f.command(['install'], { ASB_SYSTEMCTL_FAIL: 'daemon-reload' });
  assert.equal(failed.code, 1);
  assert.deepEqual(await f.systemctlCalls(), [['--user', 'daemon-reload']]);
  assert.match(await readFile(f.unit, 'utf8'), /Generated by ASB/);
});

test('unknown service arguments print usage without writes and the shell dispatch reaches status', async (t) => {
  const f = await fixture(t);
  for (const args of [[], ['unknown'], ['install', '--extra']]) {
    const reply = await f.command(args);
    assert.equal(reply.code, 2);
    assert.match(reply.stderr, /Usage: asb service/);
  }
  assert.deepEqual(await f.systemctlCalls(), []);
  await assert.rejects(stat(f.env.XDG_CONFIG_HOME), { code: 'ENOENT' });
  const status = f.launch(['service', 'status'], {}, launcherScript);
  assert.equal((await status.closed)[0], 0, status.errors);
  assert.match(status.output, /active\nRuntime file: missing or invalid\./);
  assert.deepEqual(await f.systemctlCalls(), [['--user', 'is-active', 'asb.service']]);
});

test('service run needs an absolute existing runtime directory', async (t) => {
  const f = await fixture(t);
  for (const XDG_RUNTIME_DIR of ['', 'relative', path.join(f.home, 'missing')]) {
    const reply = await f.command(['run'], { XDG_RUNTIME_DIR });
    assert.equal(reply.code, 1);
    assert.match(reply.stderr, /absolute, existing XDG_RUNTIME_DIR/);
  }
  assert.deepEqual(await readdir(f.env.XDG_RUNTIME_DIR), []);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`service run protects its manifest and removes it on ${signal}`, { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const child = f.launch([serviceScript, 'run']);
  await ready(child);
  const runtime = await readServiceRuntime(f.env);
  assert.equal(runtime.pid, child.pid);
  assert.equal(runtime.port, Number(f.env.PORT));
  assert.match(runtime.sourceToken, /^[a-f0-9]{64}$/);
  assert.equal((await stat(f.runtime)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(f.runtime))).mode & 0o777, 0o700);
  const base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await fetch(`${base}/api/service`)).status, 403);
  const response = await fetch(`${base}/api/service`, { headers: { 'X-ASB-Source-Token': runtime.sourceToken } });
  assert.deepEqual(await response.json(), { service: true, pid: child.pid });
  child.kill(signal);
  assert.equal((await child.closed)[0], 0, child.errors);
  await assert.rejects(stat(f.runtime), { code: 'ENOENT' });
});

test('the desktop attaches without replacing or stopping the running service', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const service = f.launch([serviceScript, 'run']);
  await ready(service);
  const runtime = await readServiceRuntime(f.env);
  assert.deepEqual(await findRunningService(f.env), runtime);
  const desktop = f.launch([desktopScript]);
  assert.equal((await desktop.closed)[0], 0, desktop.errors);
  assert.match(desktop.output, new RegExp(`ASB: http://127\\.0\\.0\\.1:${runtime.port}`));
  assert.equal(service.exitCode, null);
  assert.deepEqual(await findRunningService(f.env), runtime);
  const second = await f.command(['run'], { PORT: String(await freePort()) });
  assert.equal(second.code, 1);
  assert.match(second.stderr, /belongs to a running process/);
  assert.deepEqual(await readServiceRuntime(f.env), runtime);
});

test('a stale desktop runtime file falls back to its owned server and stays intact', async (t) => {
  const f = await fixture(t);
  const stale = { schema: 1, pid: 2147483647, port: Number(f.env.PORT), sourceToken: 'a'.repeat(64) };
  await writeRuntime(f, stale);
  const desktop = f.launch([desktopScript]);
  assert.equal((await desktop.closed)[0], 0, desktop.errors);
  assert.match(desktop.output, /ASB: http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(await readServiceRuntime(f.env), stale);
});

test('runtime validation rejects malformed, unsafe, or linked manifests', async (t) => {
  const f = await fixture(t);
  const value = { schema: 1, pid: process.pid, port: 12345, sourceToken: 'a'.repeat(64) };
  for (const extra of [{ schema: 2 }, { pid: 0 }, { pid: 1.5 }, { port: 0 }, { port: 65536 }, { port: '12345' },
    { sourceToken: 'A'.repeat(64) }, { sourceToken: 'short' }, { extra: true }]) {
    await writeRuntime(f, { ...value, ...extra });
    assert.equal(await readServiceRuntime(f.env), null);
  }
  await writeRuntime(f, value, 0o644);
  assert.equal(await readServiceRuntime(f.env), null);
  await writeRuntime(f, value);
  await chmod(path.dirname(f.runtime), 0o755);
  assert.equal(await readServiceRuntime(f.env), null);
  await chmod(path.dirname(f.runtime), 0o700);
  const other = path.join(f.home, 'manifest');
  await writeFile(other, JSON.stringify(value), { mode: 0o600 });
  await rm(f.runtime);
  await symlink(other, f.runtime);
  assert.equal(await readServiceRuntime(f.env), null);
});

test('the service probe checks protected metadata and bounds malformed replies', async (t) => {
  const f = await fixture(t);
  let reply = { service: true, pid: process.pid };
  let status = 200;
  let hang = false;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-asb-source-token'], 'a'.repeat(64));
    assert.equal(request.headers.host, `127.0.0.1:${server.address().port}`);
    if (hang) return;
    response.writeHead(status);
    response.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const runtime = { schema: 1, pid: process.pid, port: server.address().port, sourceToken: 'a'.repeat(64) };
  await writeRuntime(f, runtime);
  assert.deepEqual(await findRunningService(f.env), runtime);
  for (const value of [{ service: false, pid: process.pid }, { service: true, pid: process.pid + 1 }, '{', 'x'.repeat(5000)]) {
    reply = value;
    assert.equal(await findRunningService(f.env), null);
  }
  status = 403;
  assert.equal(await findRunningService(f.env), null);
  hang = true;
  const startedAt = Date.now();
  assert.equal(await findRunningService(f.env), null);
  assert.ok(Date.now() - startedAt >= 1900);
  assert.ok(Date.now() - startedAt < 4500);
});

test('service shutdown keeps a replacement runtime manifest from another process', async (t) => {
  const f = await fixture(t);
  const child = f.launch([serviceScript, 'run']);
  await ready(child);
  const replacement = { schema: 1, pid: process.pid, port: 12345, sourceToken: 'b'.repeat(64) };
  await writeRuntime(f, replacement);
  child.kill('SIGTERM');
  assert.equal((await child.closed)[0], 0, child.errors);
  assert.deepEqual(await readServiceRuntime(f.env), replacement);
});

test('manifest removal failure still closes the service and reports the failed cleanup', async (t) => {
  const f = await fixture(t);
  const preload = path.join(f.home, 'fail-removal.mjs');
  await writeFile(preload, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst remove=fs.promises.rm;\nfs.promises.rm=async(file,...args)=>{if(String(file).endsWith('/service.json'))throw new Error('Synthetic manifest removal failure');return remove(file,...args);};\nsyncBuiltinESMExports();\n`);
  const child = f.launch(['--import', preload, serviceScript, 'run']);
  await ready(child);
  child.kill('SIGTERM');
  assert.equal((await child.closed)[0], 1);
  assert.match(child.errors, /Cannot stop ASB service: Synthetic manifest removal failure/);
  assert.ok(await stat(f.runtime));
  assert.equal(await findRunningService(f.env), null);
});

test('an unavailable phone gateway does not prevent the headless ASB server from starting', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.env.XDG_CONFIG_HOME, 'asb'), { recursive: true });
  await writeFile(path.join(f.env.XDG_CONFIG_HOME, 'asb/phone.json'), JSON.stringify({ schema: 1, enabled: true,
    bindAddress: '203.0.113.1', port: 4630, devices: [] }));
  const child = f.launch([serviceScript, 'run']);
  await ready(child);
  assert.match(child.errors, /Cannot start ASB phone access: The phone address/);
  assert.ok(await findRunningService(f.env));
});

test('service-only polling observes completion with no clients and close cancels the timer', async (t) => {
  let clock = 10_000;
  let state = 'working';
  const seen = [];
  const timers = new Set();
  const server = createSwitchboardServer({ serviceMode: true, pendingStatePath: false, now: () => clock,
    dashboardSetTimeout: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
    dashboardClearTimeout: (timer) => timers.delete(timer),
    loadDashboard: async () => {
      seen.push(state);
      return { providers: [], threads: [{ id: 'synthetic', state, nativeUnread: null, completionAtMs: state === 'idle' ? clock : 0 }] };
    } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  while (!timers.size) await turn();
  assert.deepEqual(seen, ['working']);
  const tick = async (delay) => {
    const timer = [...timers].find((timer) => timer.delay === delay);
    assert.ok(timer, `No ${delay} ms timer.`);
    timers.delete(timer);
    clock += delay;
    await timer.callback();
  };
  state = 'idle';
  await tick(2000);
  assert.deepEqual(seen, ['working', 'idle']);
  const dashboard = await (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`)).json();
  assert.equal(dashboard.threads[0].completionAttention, true);
  assert.equal(dashboard.threads[0].pending, true);
  assert.equal(dashboard.threads[0].unread, true);
  await tick(5000);
  assert.deepEqual(seen, ['working', 'idle', 'idle']);
  const stale = [...timers][0];
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(timers.size, 0);
  await stale.callback();
  assert.deepEqual(seen, ['working', 'idle', 'idle']);
});
