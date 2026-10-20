import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as turn } from 'node:timers/promises';
import { findRunningService, readServiceRuntime, serviceUnit } from '../scripts/asb-service.mjs';
import { engineLogPath, shouldStartTray, startEngine, trayLauncher } from '../scripts/asb-engine.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';
import { RUNTIME_FILES } from '../scripts/asb-package.mjs';

const serviceScript = fileURLToPath(new URL('../scripts/asb-service.mjs', import.meta.url));
const desktopScript = fileURLToPath(new URL('../scripts/asb-desktop.mjs', import.meta.url));
const engineScript = fileURLToPath(new URL('../scripts/asb-engine.mjs', import.meta.url));
const launcherScript = fileURLToPath(new URL('../scripts/asb', import.meta.url));

async function freePort() {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));
  return port;
}

const probeLine = (values = {}) => JSON.stringify({ python: '3.13.5', gi: '3.50.0', gtk: [4, 18, 6], adw: [1, 7, 6], glib: [2, 84, 4],
  cairo: true, qrcode: true, trayHost: null, ...values });
// A shell script that answers the board probe with ASB_FAKE_PROBE (else a full board), then runs the rest.
const fakePython = (rest = '') => `#!/bin/sh\nif [ "\${1:-}" = -c ]; then\n  if [ -n "\${ASB_FAKE_PROBE:-}" ]; then printf '%s\\n' "$ASB_FAKE_PROBE"; `
  + `else printf '%s\\n' '${probeLine()}'; fi\n  exit 0\nfi\n${rest}`;

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
    CLAUDE_CODE_CONFIG_DIR: path.join(home, 'claude-code'), ASB_SYSTEM_INSTALL: '1', ASB_PYTHON: path.join(home, 'bin/fake-python'),
    ASB_NODE: process.execPath, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, ASB_SYSTEMCTL_LOG: path.join(home, 'systemctl.jsonl'),
    PORT: String(await freePort()), ASB_TRAY: '0' };
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  await mkdir(path.join(home, 'bin'));
  // The fake Python answers the board probe (ASB_FAKE_PROBE, else a full board); as the window it exits at once.
  await writeFile(env.ASB_PYTHON, fakePython(), { mode: 0o755 });
  await writeFile(path.join(home, 'bin/systemctl'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.ASB_SYSTEMCTL_LOG, JSON.stringify(args)+'\\n');\nif (process.env.ASB_SYSTEMCTL_FAIL && args.includes(process.env.ASB_SYSTEMCTL_FAIL)) process.exit(1);\nif (args.includes('is-active')) console.log('active');\nif (args.includes('show')) console.log('1');\n`, { mode: 0o755 });
  const launch = (args, extra = {}, program = process.execPath) => {
    // As scripts/asb.mjs does: Node.js 22 prints the SQLite ExperimentalWarning on stderr.
    const child = spawn(program, program === process.execPath ? ['--disable-warning=ExperimentalWarning', ...args] : args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function ready(child, prefix = 'ASB service:') {
  if (child.output.includes(prefix)) return;
  await new Promise((resolve, reject) => {
    const data = () => { if (child.output.includes(prefix)) { cleanup(); resolve(); } };
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

test('the board launcher attaches to a running engine, and a second engine refuses to start', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const service = f.launch([engineScript, 'run']);
  await ready(service);
  const runtime = await readServiceRuntime(f.env);
  assert.deepEqual(await findRunningService(f.env), runtime);
  const desktop = f.launch([desktopScript]);
  assert.equal((await desktop.closed)[0], 0, desktop.errors);
  assert.match(desktop.output, new RegExp(`ASB: http://127\\.0\\.0\\.1:${runtime.port}`));
  assert.equal(service.exitCode, null);
  assert.deepEqual(await findRunningService(f.env), runtime);
  assert.deepEqual(await f.systemctlCalls(), []);
  const second = f.launch([engineScript, 'run'], { PORT: String(await freePort()) });
  assert.equal((await second.closed)[0], 1);
  assert.match(second.errors, /belongs to a running process/);
  assert.deepEqual(await readServiceRuntime(f.env), runtime);
});

test('the engine replaces a stale runtime file and removes it on stop', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await writeRuntime(f, { schema: 1, pid: 2147483647, port: Number(f.env.PORT), sourceToken: 'a'.repeat(64) });
  const child = f.launch([engineScript, 'run']);
  await ready(child);
  assert.equal((await readServiceRuntime(f.env)).pid, child.pid);
  child.kill('SIGTERM');
  assert.equal((await child.closed)[0], 0, child.errors);
  await assert.rejects(stat(f.runtime), { code: 'ENOENT' });
});

test('the engine keeps malformed runtime metadata and refuses to start', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.runtime), { recursive: true, mode: 0o700 });
  await writeFile(f.runtime, '{', { mode: 0o600 });
  const refused = f.launch([engineScript, 'run']);
  assert.equal((await refused.closed)[0], 1);
  assert.match(refused.errors, /kept an invalid service.json/);
  assert.equal(await readFile(f.runtime, 'utf8'), '{');
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

test('a cleanup step that never ends stops the service 5 s after the signal and logs the step', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const preload = path.join(f.home, 'hang-removal.mjs');
  await writeFile(preload, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst remove=fs.promises.rm;\nfs.promises.rm=(file,...args)=>String(file).endsWith('/service.json')?new Promise(()=>{}):remove(file,...args);\nsyncBuiltinESMExports();\n`);
  const child = f.launch(['--import', preload, serviceScript, 'run']);
  await ready(child);
  const started = Date.now();
  child.kill('SIGTERM');
  assert.equal((await child.closed)[0], 1);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500 && elapsed <= 9000, `The service stopped after ${elapsed} ms.`);
  assert.match(child.errors, /ASB engine is still running 5 s after SIGTERM\. Pending cleanup step: manifest removal\. Open resources: .*TCPServerWrap/);
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

test('the engine helpers choose the tray, the tray launcher, and the log path', () => {
  const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' };
  assert.equal(shouldStartTray(bus, 'linux'), true);
  assert.equal(shouldStartTray({ ...bus, ASB_TRAY: '0' }, 'linux'), false);
  assert.equal(shouldStartTray({}, 'linux'), false);
  assert.equal(shouldStartTray(bus, 'win32'), false);
  assert.equal(trayLauncher({ ASB_INSTALLED_LAUNCHER: '/opt/asb/bin/asb' }), '/opt/asb/bin/asb');
  for (const env of [{}, { ASB_INSTALLED_LAUNCHER: 'bin/asb' }]) assert.equal(trayLauncher(env), launcherScript);
  assert.equal(engineLogPath({ XDG_STATE_HOME: '/state' }), '/state/asb/engine.log');
  assert.equal(engineLogPath({}), path.join(os.homedir(), '.local/state/asb/engine.log'));
});

test('engine start uses the enabled user service, a detached engine, or the running engine', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-engine-start-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime') };
  const runtime = { schema: 1, pid: 12, port: 23456, sourceToken: 'a'.repeat(64) };
  const fake = ({ enabled = false, startFails = false, answerAt = 3 } = {}) => {
    const calls = [];
    let finds = 0;
    return { calls, options: { env, intervalMs: 1,
      execFile: async (program, args) => {
        calls.push([program, ...args]);
        if (args[1] === 'is-enabled') { if (!enabled) throw Object.assign(new Error('disabled'), { stdout: 'disabled\n' }); return { stdout: 'enabled\n' }; }
        if (startFails) throw new Error('Synthetic start failure');
        return { stdout: '' };
      },
      spawn: (program, args, options) => {
        calls.push(['spawn', program, ...args]);
        assert.equal(options.detached, true);
        assert.equal(options.env, env);
        assert.equal(options.stdio[0], 'ignore');
        assert.ok(Number.isInteger(options.stdio[1]) && options.stdio[1] === options.stdio[2]);
        const child = new EventEmitter();
        child.unref = () => calls.push(['unref']);
        return child;
      },
      find: async () => (finds++ === answerAt ? runtime : null) } };
  };
  const enabled = fake({ enabled: true });
  assert.equal(await startEngine(enabled.options), runtime);
  assert.deepEqual(enabled.calls, [['systemctl', '--user', 'is-enabled', 'asb.service'], ['systemctl', '--user', 'start', 'asb.service']]);
  const log = path.join(env.XDG_STATE_HOME, 'asb/engine.log');
  const detached = fake();
  assert.equal(await startEngine(detached.options), runtime);
  assert.deepEqual(detached.calls, [['systemctl', '--user', 'is-enabled', 'asb.service'], ['spawn', process.execPath, engineScript, 'run'], ['unref']]);
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  await writeFile(log, 'old output');
  await assert.rejects(startEngine({ ...fake({ answerAt: -1 }).options, timeoutMs: 50 }), { message: `ASB cannot start its engine. See ${log}.` });
  assert.equal(await readFile(log, 'utf8'), '');
  await assert.rejects(startEngine(fake({ enabled: true, startFails: true }).options),
    { message: 'ASB cannot start its engine. See journalctl --user -u asb.service.' });
  const running = fake({ answerAt: 0 });
  assert.equal(await startEngine(running.options), runtime);
  assert.deepEqual(running.calls, []);
  for (const XDG_RUNTIME_DIR of [undefined, '', 'relative']) {
    const missing = fake({ answerAt: 0 });
    await assert.rejects(startEngine({ ...missing.options, env: { ...env, XDG_RUNTIME_DIR }, find: async () => assert.fail('No runtime folder.') }),
      { message: 'ASB cannot start its engine: XDG_RUNTIME_DIR must be an absolute folder.' });
    assert.deepEqual(missing.calls, []);
  }
});

test('the engine stop route needs the token, a local POST, and an empty body, then the engine exits 0', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const child = f.launch([engineScript, 'run']);
  await ready(child);
  const runtime = await readServiceRuntime(f.env);
  const base = `http://127.0.0.1:${runtime.port}`;
  const stop = (options = {}) => fetch(`${base}/api/engine/stop`, { method: 'POST', body: '{}',
    ...options, headers: { origin: base, 'content-type': 'application/json', 'X-ASB-Source-Token': runtime.sourceToken, ...options.headers } });
  assert.equal((await stop({ headers: { 'X-ASB-Source-Token': '' } })).status, 403);
  assert.ok(await findRunningService(f.env));
  assert.equal((await fetch(`${base}/api/engine/stop`, { headers: { 'X-ASB-Source-Token': runtime.sourceToken } })).status, 405);
  assert.equal((await stop({ headers: { origin: 'http://example.com' } })).status, 403);
  const invalid = await stop({ body: '{"x":1}' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  assert.ok(await findRunningService(f.env));
  const stopped = await stop();
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { stopping: true });
  assert.equal((await child.closed)[0], 0, child.errors);
  await assert.rejects(stat(f.runtime), { code: 'ENOENT' });
});

test('engine status and stop work through the shell launcher with a detached engine', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const child = f.launch([engineScript, 'run']);
  await ready(child);
  const engine = async (args) => {
    const command = f.launch(['engine', ...args], {}, launcherScript);
    const [code] = await command.closed;
    return { code, stdout: command.output, stderr: command.errors };
  };
  const running = await engine(['status']);
  assert.equal(running.code, 0, running.stderr);
  assert.equal(running.stdout, `ASB engine: running. PID ${child.pid}, port ${f.env.PORT}, detached.\n`);
  const stopped = await engine(['stop']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.stdout, 'ASB engine stopped.\n');
  assert.equal((await child.closed)[0], 0, child.errors);
  const missing = await engine(['status']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, 'ASB engine: not running.\n');
  assert.equal((await engine(['stop'])).stdout, 'ASB engine is not running.\n');
  const usage = await engine(['restart']);
  assert.equal(usage.code, 2);
  assert.equal(usage.stderr, 'Usage: asb engine run|start|stop|status\n');
  assert.deepEqual(await f.systemctlCalls(), [['--user', 'show', '-p', 'MainPID', '--value', 'asb.service']]);
});

test('the engine starts the tray with its environment, stops it, and survives a tray failure', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const record = path.join(f.home, 'tray.env');
  const tray = path.join(f.home, 'fake-tray');
  await writeFile(tray, fakePython(`printf '%s\\n' "$ASB_ENGINE_PID" "$ASB_ENGINE_URL" "$ASB_LAUNCHER" "\${#ASB_SOURCE_TOKEN}" "$1" "\${ASB_BOARD-unset}" > "${record}.tmp"\nmv "${record}.tmp" "${record}"\n[ -n "$ASB_TRAY_FAIL" ] && exit 3\nexec sleep 60\n`), { mode: 0o755 });
  const extra = { ASB_TRAY: '', ASB_PYTHON: tray, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', ASB_INSTALLED_LAUNCHER: '/opt/asb/bin/asb' };
  const recorded = async () => {
    for (let tries = 0; tries < 100; tries += 1) {
      const text = await readFile(record, 'utf8').catch(() => null);
      if (text) return text.trim().split('\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('The tray did not start.');
  };
  const child = f.launch([engineScript, 'run'], extra);
  await ready(child);
  const values = await recorded();
  assert.deepEqual(values.slice(0, 4), [String(child.pid), `http://127.0.0.1:${f.env.PORT}`, '/opt/asb/bin/asb', '64']);
  assert.ok(values[4].endsWith('/scripts/asb-tray.py'));
  // A full board: the tray gets no ASB_BOARD.
  assert.equal(values[5], 'unset');
  const trayPid = Number((await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/)[0]);
  assert.ok(trayPid > 0);
  const runtime = await readServiceRuntime(f.env);
  const base = `http://127.0.0.1:${runtime.port}`;
  const reply = await fetch(`${base}/api/engine/stop`, { method: 'POST', body: '{}',
    headers: { origin: base, 'content-type': 'application/json', 'X-ASB-Source-Token': runtime.sourceToken } });
  assert.equal(reply.status, 200);
  assert.equal((await child.closed)[0], 0, child.errors);
  assert.throws(() => process.kill(trayPid, 0), { code: 'ESRCH' });
  await rm(record);
  const failing = f.launch([engineScript, 'run'], { ...extra, ASB_TRAY_FAIL: '1' });
  await ready(failing);
  await recorded();
  for (let tries = 0; tries < 100 && !failing.errors.includes('exit code 3'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(failing.errors, 'ASB tray icon stopped with exit code 3.\n');
  assert.ok(await findRunningService(f.env));
});

test('without the board the tray gets ASB_BOARD=0, and without PyGObject no tray starts', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const record = path.join(f.home, 'tray.env');
  const tray = path.join(f.home, 'fake-tray');
  await writeFile(tray, fakePython(`printf '%s\\n' "\${ASB_BOARD-unset}" > "${record}.tmp"\nmv "${record}.tmp" "${record}"\nexec sleep 60\n`), { mode: 0o755 });
  const extra = { ASB_TRAY: '', ASB_PYTHON: tray, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', ASB_INSTALLED_LAUNCHER: '/opt/asb/bin/asb' };
  const stopEngine = async (child) => {
    const runtime = await readServiceRuntime(f.env);
    const base = `http://127.0.0.1:${runtime.port}`;
    const reply = await fetch(`${base}/api/engine/stop`, { method: 'POST', body: '{}',
      headers: { origin: base, 'content-type': 'application/json', 'X-ASB-Source-Token': runtime.sourceToken } });
    assert.equal(reply.status, 200);
    assert.equal((await child.closed)[0], 0, child.errors);
  };
  // Old GTK with PyGObject: the tray starts without Open ASB.
  const old = f.launch([engineScript, 'run'], { ...extra, ASB_FAKE_PROBE: probeLine({ gtk: [4, 8, 3], adw: [1, 2, 2] }) });
  await ready(old);
  let text = null;
  for (let tries = 0; tries < 100 && !text; tries += 1) {
    text = await readFile(record, 'utf8').catch(() => null);
    if (!text) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(text, '0\n');
  assert.equal(old.errors, '');
  await stopEngine(old);
  await rm(record);
  // No PyGObject: no tray, one error line, and the engine keeps running.
  const none = f.launch([engineScript, 'run'], { ...extra, ASB_FAKE_PROBE: probeLine({ gi: null, gtk: null, adw: null, glib: null }) });
  await ready(none);
  assert.equal(none.errors, 'ASB cannot start its tray icon: no Python 3 with PyGObject was found.\n');
  assert.equal(none.exitCode, null);
  assert.ok(await findRunningService(f.env));
  await assert.rejects(readFile(record), { code: 'ENOENT' });
  await stopEngine(none);
});
