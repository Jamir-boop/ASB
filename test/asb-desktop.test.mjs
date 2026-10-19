import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const launcherUrl = new URL('../scripts/asb-desktop.mjs', import.meta.url);
const launcher = (await readFile(launcherUrl, 'utf8')).replace(/^import[^\n]*\n/gm, '')
  .replaceAll('import.meta.url', 'launcherUrl');
// The launcher gets a silent player; tests never play sound.
const silentPlayer = () => {};
const runtimeStubs = { prepareInstanceRuntime: async () => null, publishInstanceRuntime: async () => null, removeInstanceRuntimeSync: () => {} };
const disabledGateway = () => ({ start: async () => {}, status: async () => ({ error: '' }), stop: async () => {} });

for (const exitCode of [0, 1]) test(`launcher exit ${exitCode} stops its owned synthetic native process`, { timeout: 5_000 }, async (t) => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const server = new EventEmitter();
  let closed = 0;
  server.listen = (_port, _host, callback) => callback();
  server.close = () => { closed += 1; };
  server.closeAllConnections = () => {};
  let native;
  t.after(() => { if (native?.exitCode === null && native?.signalCode === null) native.kill('SIGKILL'); });
  const launch = vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes, readFileSync,
    ...runtimeStubs, findRunningService: async () => null, createPhoneGateway: disabledGateway,
    createSoundPlayer: () => silentPlayer, createSwitchboardServer: () => server, switchboardPort: () => 4629, registerAppIcon: async () => {},
    console: { log() {}, error() {}, warn() {} },
    spawn: (_program, args) => {
      assert.match(args[0], /asb-native\.py$/);
      assert.equal(args[1], 'http://127.0.0.1:4629');
      native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} });
      return native;
    },
  });
  await launch;
  const exited = once(native, 'exit');
  await once(native, 'spawn');
  owner.emit('exit', exitCode);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
  assert.equal(owner.exitCode, exitCode);
  assert.equal(closed, 1);
});

test('icon registration failure keeps its message and still launches the owned native child', { timeout: 5_000 }, async (t) => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_PYTHON: '/bin/true' };
  const server = new EventEmitter();
  let native;
  let closed = 0;
  let sourceToken;
  const errors = [];
  const printed = [];
  server.listen = (_port, host, callback) => { assert.equal(host, '127.0.0.1'); callback(); };
  server.close = () => { closed += 1; };
  server.closeAllConnections = () => {};
  t.after(() => { if (native?.exitCode === null && native?.signalCode === null) native.kill('SIGKILL'); });
  const launch = vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes, readFileSync,
    ...runtimeStubs, findRunningService: async () => null, createPhoneGateway: disabledGateway,
    createSoundPlayer: () => silentPlayer, createSwitchboardServer: (options) => { sourceToken = options.sourceToken; return server; }, switchboardPort: () => 4629,
    registerAppIcon: async () => { throw new Error('Synthetic registration failure'); },
    console: { log(message) { printed.push(message); }, error(message) { errors.push(message); }, warn(message) { printed.push(message); } },
    spawn: (program, args, options) => {
      assert.equal(program, '/bin/true');
      // The window child and the server share one app source token for each run.
      assert.match(sourceToken, /^[0-9a-f]{64}$/);
      assert.deepEqual({ ...options.env }, { ASB_PYTHON: '/bin/true', ASB_SOURCE_TOKEN: sourceToken });
      native = spawn(program, args, { stdio: 'ignore', env: {} });
      return native;
    },
  });
  await launch;
  assert.ok(native);
  const [code, signal] = await once(native, 'exit');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.deepEqual(errors, ['Cannot register the ASB icon: Synthetic registration failure']);
  assert.deepEqual(printed, ['ASB: http://127.0.0.1:4629']);
  assert.equal(owner.exitCode, 0);
  assert.equal(closed, 1);
});

test('isolated desktop launcher exits 1 on a busy port and 0 on a free port without GTK', { timeout: 10_000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-launcher-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const port = holder.address().port;
  const launch = async () => {
    const child = spawn(process.execPath, [fileURLToPath(launcherUrl)], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ASB_SYSTEM_INSTALL: '1', ASB_PYTHON: '/bin/true', PORT: String(port),
      HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
      XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
      CODEX_HOME: path.join(home, 'codex'), CLAUDE_APP_DIR: path.join(home, 'claude'),
      CLAUDE_CODE_CONFIG_DIR: path.join(home, 'claude-code'),
    } });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, 'close');
    return { code, signal, stdout, stderr };
  };
  try {
    const busy = await launch();
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, new RegExp(`Port ${port} is in use`));
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
  const free = await launch();
  assert.equal(free.code, 0);
  assert.equal(free.signal, null);
  assert.match(free.stdout, new RegExp(`ASB: http://127\\.0\\.0\\.1:${port}`));
});

for (const failure of ['', 'reported', 'thrown']) test(`launcher owns the phone gateway and keeps the window available (${failure || 'success'})`, async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const calls = [];
  const errors = [];
  const gateway = {
    start: async () => { calls.push('start'); if (failure === 'thrown') throw new Error('Synthetic start failure'); },
    status: async () => ({ error: failure === 'reported' ? 'Synthetic certificate failure' : '' }),
    stop: async () => { calls.push('stop'); },
  };
  const server = new EventEmitter();
  server.listen = (port, host, callback) => {
    assert.equal(port, 12345);
    assert.equal(host, '127.0.0.1');
    calls.push('listen');
    callback();
  };
  server.close = () => calls.push('close');
  server.closeAllConnections = () => {};
  const launch = vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes, readFileSync,
    switchboardPort: () => 12345, registerAppIcon: async () => {},
    ...runtimeStubs, findRunningService: async () => null, createPhoneGateway: (options) => {
      assert.deepEqual({ ...options }, { localPort: 12345, asbVersion: '1.8.1' });
      calls.push('create-gateway');
      return gateway;
    },
    createSoundPlayer: () => silentPlayer, createSwitchboardServer: (options) => {
      assert.equal(options.phoneGateway, gateway);
      assert.equal(options.playSound, silentPlayer);
      assert.match(options.sourceToken, /^[0-9a-f]{64}$/);
      calls.push('create-server');
      return server;
    },
    console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    spawn: () => {
      calls.push('window');
      const native = new EventEmitter();
      native.exitCode = null;
      native.kill = (signal) => calls.push(signal);
      return native;
    },
  });
  await launch;
  assert.deepEqual(calls, ['create-gateway', 'create-server', 'listen', 'start', 'window']);
  assert.deepEqual(errors, failure ? [`Cannot start ASB phone access: Synthetic ${failure === 'reported' ? 'certificate' : 'start'} failure`] : []);
  owner.emit('SIGTERM');
  owner.emit('exit', 0);
  assert.deepEqual(calls.slice(-3), ['SIGTERM', 'close', 'stop']);
});

test('a stop during gateway startup cannot launch a window later', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const starting = Promise.withResolvers();
  const started = Promise.withResolvers();
  let stopped = 0;
  const server = new EventEmitter();
  server.listen = (_port, _host, callback) => callback();
  server.close = () => {};
  server.closeAllConnections = () => {};
  const launch = vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes, readFileSync,
    ...runtimeStubs, findRunningService: async () => null, createPhoneGateway: () => ({ start: () => { started.resolve(); return starting.promise; }, status: async () => ({ error: '' }), stop: async () => { stopped += 1; } }),
    createSoundPlayer: () => silentPlayer, createSwitchboardServer: () => server, switchboardPort: () => 12345, registerAppIcon: async () => {},
    console: { log() {}, error() {}, warn() {} }, spawn: () => assert.fail('The launcher already stopped.'),
  });
  await started.promise;
  owner.emit('SIGTERM');
  starting.resolve();
  await launch;
  assert.equal(stopped, 1);
});

test('an attached desktop gives the window the service URL and token without owning listeners', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = {};
  let registered = 0;
  const native = new EventEmitter();
  native.exitCode = 0;
  await vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes,
    switchboardPort: () => 12345,
    ...runtimeStubs, findRunningService: async () => ({ pid: 12, port: 23456, sourceToken: 'service-token' }),
    createPhoneGateway: () => assert.fail('The service owns its gateway.'),
    createSwitchboardServer: () => assert.fail('The service owns its loopback server.'),
    registerAppIcon: async () => { registered += 1; return {}; },
    console: { log() {}, error() {}, warn() {} },
    spawn: (_program, args, options) => {
      assert.equal(args[1], 'http://127.0.0.1:23456');
      assert.equal(options.env.ASB_SOURCE_TOKEN, 'service-token');
      return native;
    },
  });
  assert.equal(registered, 1);
  native.emit('exit', 3, null);
  assert.equal(owner.exitCode, 3);
});
