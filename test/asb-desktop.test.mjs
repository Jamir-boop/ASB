import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const launcherUrl = new URL('../scripts/asb-desktop.mjs', import.meta.url);
// The script body runs in a context with fake modules; its main() is called as the file entry would.
const launcher = (await readFile(launcherUrl, 'utf8')).replace(/^import[^\n]*\n/gm, '').replace(/^export /m, '')
  .replace(/\nif \(process\.argv\[1\][^\n]*\n$/, '\nmain();\n').replaceAll('import.meta.url', 'launcherUrl');
const engine = { pid: 12, port: 23456, sourceToken: 'service-token' };
// No test runs the real Python probe; without ASB_PYTHON the window uses the Python of this board check.
const boardCheck = async () => ({ ok: true, python: '/opt/python3' });
const pick = (watch) => ({ setInterval: watch.setInterval, clearInterval: watch.clearInterval });
// The engine watch timer is captured; tests run its callback by hand.
const timers = () => {
  const watch = { callbacks: [], cleared: [] };
  watch.setInterval = (callback, delay) => { assert.equal(delay, 2000); watch.callbacks.push(callback); return `timer-${watch.callbacks.length}`; };
  watch.clearInterval = (timer) => watch.cleared.push(timer);
  return watch;
};

test('the window gets the engine URL and token and its exit code without stopping the engine', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = {};
  let registered = 0;
  let starts = 0;
  const native = new EventEmitter();
  native.exitCode = 0;
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: async () => { starts += 1; return engine; },
    registerAppIcon: async () => { registered += 1; return {}; },
    console: { log() {}, error() {}, warn() {} },
    spawn: (program, args, options) => {
      assert.equal(program, '/opt/python3');
      assert.match(args[0], /asb-native\.py$/);
      assert.equal(args[1], 'http://127.0.0.1:23456');
      assert.equal(options.env.ASB_SOURCE_TOKEN, 'service-token');
      return native;
    },
  });
  assert.equal(registered, 1);
  native.emit('exit', 3, null);
  assert.equal(owner.exitCode, 3);
  assert.equal(starts, 1);
});

test('without a Python the window does not start and the launcher exits 1', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const errors = [];
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    boardCheck: async () => ({ ok: false, python: null }), startEngine: async () => engine,
    console: { log() {}, error(message) { errors.push(message); }, warn() {} },
    spawn: () => assert.fail('No window may start.'),
  });
  assert.deepEqual(errors, ['Cannot open the native ASB window: Python 3 was not found. Use system Python 3 or npm start for the web view.']);
  assert.equal(owner.exitCode, 1);
});

test('an engine that cannot start prints its log path, exits 1, and opens no window', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const errors = [];
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: async () => { throw new Error('ASB cannot start its engine. See /x/engine.log.'); },
    registerAppIcon: async () => assert.fail('The engine did not start.'),
    console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    spawn: () => assert.fail('The engine did not start.'),
  });
  assert.deepEqual(errors, ['ASB cannot start its engine. See /x/engine.log.']);
  assert.equal(owner.exitCode, 1);
});

for (const exitCode of [0, 1]) test(`launcher exit ${exitCode} stops its synthetic native process`, { timeout: 5_000 }, async (t) => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  let native;
  t.after(() => { if (native?.exitCode === null && native?.signalCode === null) native.kill('SIGKILL'); });
  const launch = vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: async () => engine, registerAppIcon: async () => {},
    console: { log() {}, error() {}, warn() {} },
    spawn: (_program, args) => {
      assert.match(args[0], /asb-native\.py$/);
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
});

test('icon registration failure keeps its message and still launches the window', { timeout: 5_000 }, async (t) => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_PYTHON: '/bin/true' };
  let native;
  const errors = [];
  const printed = [];
  t.after(() => { if (native?.exitCode === null && native?.signalCode === null) native.kill('SIGKILL'); });
  const launch = vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: async () => engine,
    registerAppIcon: async () => { throw new Error('Synthetic registration failure'); },
    console: { log(message) { printed.push(message); }, error(message) { errors.push(message); }, warn(message) { printed.push(message); } },
    spawn: (program, args, options) => {
      assert.equal(program, '/bin/true');
      assert.deepEqual({ ...options.env }, { ASB_PYTHON: '/bin/true', ASB_SOURCE_TOKEN: 'service-token' });
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
  assert.deepEqual(printed, ['ASB: http://127.0.0.1:23456']);
  assert.equal(owner.exitCode, 0);
});

test('a stop during engine startup cannot launch a window later', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const starting = Promise.withResolvers();
  const started = Promise.withResolvers();
  const launch = vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: () => { started.resolve(); return starting.promise; }, registerAppIcon: async () => {},
    console: { log() {}, error() {}, warn() {} }, spawn: () => assert.fail('The launcher already stopped.'),
  });
  await started.promise;
  owner.emit('SIGTERM');
  starting.resolve(engine);
  await launch;
  assert.equal(owner.exitCode, 0);
});

for (const failure of ['', 'ESRCH', 'EPERM']) test(`the engine watch ${failure === 'ESRCH' ? 'closes the window when the engine is gone' : `keeps the window while the engine lives (${failure || 'alive'})`}`, async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const checked = [];
  owner.kill = (pid, signal) => {
    checked.push([pid, signal]);
    if (failure) throw Object.assign(new Error(failure), { code: failure });
  };
  const watch = timers();
  const signals = [];
  const native = new EventEmitter();
  native.exitCode = null;
  native.kill = (signal) => signals.push(signal);
  await vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: async () => engine, registerAppIcon: async () => {}, console: { log() {}, error() {}, warn() {} },
    spawn: () => native,
  });
  assert.equal(watch.callbacks.length, 1);
  watch.callbacks[0]();
  assert.deepEqual(checked, [[12, 0]]);
  if (failure === 'ESRCH') {
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(owner.exitCode, 0);
    assert.deepEqual(watch.cleared, ['timer-1']);
  } else {
    assert.deepEqual(signals, []);
    assert.equal(owner.exitCode, undefined);
    assert.deepEqual(watch.cleared, []);
  }
});

test('a window that exits by itself clears the engine watch', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  owner.kill = () => assert.fail('The window exited first.');
  const watch = timers();
  const native = new EventEmitter();
  native.exitCode = null;
  native.kill = () => assert.fail('The window exited first.');
  await vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, boardCheck,
    startEngine: async () => engine, registerAppIcon: async () => {}, console: { log() {}, error() {}, warn() {} },
    spawn: () => native,
  });
  native.exitCode = 0;
  native.emit('exit', 0, null);
  assert.deepEqual(watch.cleared, ['timer-1']);
  assert.equal(owner.exitCode, 0);
});
