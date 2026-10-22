import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { cachedBoardCheck as realCachedBoardCheck, forgetBoardCheck as realForgetBoardCheck } from '../src/linux-system.mjs';

const launcherUrl = new URL('../scripts/asb-desktop.mjs', import.meta.url);
// The script body runs in a context with fake modules; its main() is called as the file entry would.
const launcher = (await readFile(launcherUrl, 'utf8')).replace(/^import[^\n]*\n/gm, '').replace(/^export /m, '')
  .replace(/\nif \(process\.argv\[1\][^\n]*\n$/, '\nmain();\n').replaceAll('import.meta.url', 'launcherUrl');
const engine = { pid: 12, port: 23456, sourceToken: 'service-token' };
// No test runs the real Python probe. As the real check does, an absolute ASB_PYTHON is the only candidate.
const cachedBoardCheck = async ({ env }) => ({ ok: true, python: env.ASB_PYTHON || '/opt/python3' });
// The cache itself is tested in test/linux-system.test.mjs; here it is a stand-in, and a test replaces forgetBoardCheck to see the calls.
const boardFakes = { cachedBoardCheck, forgetBoardCheck() {} };
const pick = (watch) => ({ setInterval: watch.setInterval, clearInterval: watch.clearInterval });
// The engine watch timer is captured; tests run its callback by hand.
const timers = () => {
  const watch = { callbacks: [], cleared: [] };
  watch.setInterval = (callback, delay) => { assert.equal(delay, 2000); watch.callbacks.push(callback); return `timer-${watch.callbacks.length}`; };
  watch.clearInterval = (timer) => watch.cleared.push(timer);
  return watch;
};

// The window stand-in: stdin keeps what the launcher writes (a real child process has a pipe there).
const fakeWindow = (exitCode = 0) => Object.assign(new EventEmitter(), {
  exitCode, kills: [], kill(signal) { this.kills.push(signal); },
  stdin: { handlers: [], written: [], on(name, handler) { this.handlers.push(name); }, end(text) { this.written.push(text); } },
});
const addressLine = `${JSON.stringify({ url: 'http://127.0.0.1:23456', token: 'service-token' })}\n`;

test('the window gets the engine URL and token on stdin, never in its arguments or environment, and its exit code without stopping the engine', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = {};
  let registered = 0;
  let starts = 0;
  const native = fakeWindow();
  const spawnCalls = [];
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => { starts += 1; return engine; },
    registerAppIcon: async () => { registered += 1; return {}; },
    console: { log() {}, error() {}, warn() {} },
    spawn: (program, args, options) => {
      assert.equal(program, '/opt/python3');
      assert.match(args[0], /asb-board\.py$/);
      assert.equal(args[1], '-');
      assert.equal(args.length, 2);
      // The options come from another realm, so the comparison goes through JSON.
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { stdio: ['pipe', 'inherit', 'inherit'] });
      spawnCalls.push([program, args, options]);
      return native;
    },
  });
  assert.equal(registered, 1);
  // One JSON line on the pipe, and the pipe ends after it. No part of the address is in the arguments or the options.
  assert.deepEqual(native.stdin.written, [addressLine]);
  assert.deepEqual(native.stdin.handlers, ['error']);
  assert.doesNotMatch(JSON.stringify(spawnCalls), /service-token|23456/);
  native.emit('exit', 3, null);
  assert.equal(owner.exitCode, 3);
  assert.equal(starts, 1);
});

test('a failed board check keeps the engine, registers nothing, opens no window, and exits 3', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_PYTHON: '/bin/false' };
  const steps = [];
  const errors = [];
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    startEngine: async () => { steps.push('engine'); return engine; },
    cachedBoardCheck: async ({ env }) => { steps.push(['board', env.ASB_PYTHON]); return { ok: false, python: null, versions: null, reason: 'Python 3 does not run.' }; },
    registerAppIcon: async () => assert.fail('An engine-only run registers no icon.'),
    console: { log() {}, error(message) { errors.push(message); }, warn() {} },
    spawn: () => assert.fail('No window may start.'),
  });
  assert.deepEqual(steps, ['engine', ['board', '/bin/false']]);
  assert.deepEqual(errors, ['ASB runs without its window on this system: Python 3 does not run. The engine runs for the phone and your other machines. '
    + 'Run asb doctor for details.']);
  assert.equal(owner.exitCode, 3);
});

for (const platform of ['linux', 'win32']) test(`on ${platform} the launcher picks its engine start, the icon rule, and the window spawn options`, async () => {
  const windows = platform === 'win32';
  const owner = new EventEmitter();
  owner.platform = platform;
  owner.env = {};
  const calls = [];
  const watch = timers();
  const native = fakeWindow();
  let spawned;
  await vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => { calls.push('startEngine'); return engine; },
    startWindowsEngine: async () => { calls.push('startWindowsEngine'); return engine; },
    registerAppIcon: async () => { calls.push('registerAppIcon'); return {}; },
    console: { log() {}, error() {}, warn() {} },
    spawn: (program, args, options) => { spawned = [program, args, options]; return native; },
  });
  // Windows starts the engine through its tray and registers no icon; Linux spawn options have no windowsHide.
  assert.deepEqual(calls, windows ? ['startWindowsEngine'] : ['startEngine', 'registerAppIcon']);
  assert.deepEqual(Object.keys(spawned[2]).sort(), windows ? ['stdio', 'windowsHide'] : ['stdio']);
  assert.equal(spawned[1][1], '-');
  assert.deepEqual(native.stdin.written, [addressLine]);
  if (windows) assert.equal(spawned[2].windowsHide, true);
  assert.equal(watch.callbacks.length, 1);
  native.emit('exit', 0, null);
  assert.deepEqual(watch.cleared, ['timer-1']);
  assert.equal(owner.exitCode, 0);
});

test('a failed board check on Windows keeps the engine, opens no window, and exits 3', async () => {
  const owner = new EventEmitter();
  owner.platform = 'win32';
  owner.env = {};
  const errors = [];
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    startEngine: async () => assert.fail('Windows starts the engine through its tray.'),
    startWindowsEngine: async () => engine,
    cachedBoardCheck: async () => ({ ok: false, python: null, versions: null, reason: 'Python 3 is not installed.' }),
    registerAppIcon: async () => assert.fail('Windows registers no icon.'),
    console: { log() {}, error(message) { errors.push(message); }, warn() {} },
    spawn: () => assert.fail('No window may start.'),
  });
  assert.deepEqual(errors, ['ASB runs without its window on this system: Python 3 is not installed. The engine runs for the phone and your other machines. '
    + 'Run asb doctor for details.']);
  assert.equal(owner.exitCode, 3);
});

test('another system gets the launcher error and exit 1', () => {
  const owner = new EventEmitter();
  owner.platform = 'darwin';
  owner.exit = (code) => { throw new Error(`exit ${code}`); };
  const errors = [];
  assert.throws(() => vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => assert.fail('No engine starts.'), startWindowsEngine: async () => assert.fail('No engine starts.'),
    registerAppIcon: async () => assert.fail('No icon.'), console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    spawn: () => assert.fail('No window may start.'),
  }), /^Error: exit 1$/);
  assert.deepEqual(errors, ['The ASB desktop launcher requires Linux or Windows. Use npm start and open the local address.']);
});

test('an engine that cannot start after the window started stops the window, prints its log path once, exits 1, and sends no address', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const errors = [];
  const engineStart = Promise.withResolvers();
  const native = fakeWindow(null);
  const spawned = Promise.withResolvers();
  const watch = timers();
  const launch = vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: () => engineStart.promise,
    registerAppIcon: async () => assert.fail('A system install registers no icon.'),
    console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    spawn: () => { spawned.resolve(); return native; },
  });
  await spawned.promise;
  assert.deepEqual(errors, []);
  engineStart.reject(new Error('ASB cannot start its engine. See /x/engine.log.'));
  await launch;
  assert.deepEqual(errors, ['ASB cannot start its engine. See /x/engine.log.']);
  assert.deepEqual(native.kills, ['SIGTERM']);
  assert.deepEqual(native.stdin.written, []);
  assert.equal(owner.exitCode, 1);
  // The stopped window ends with the signal of the stop: that is no board failure, and it keeps the exit code.
  native.emit('exit', null, 'SIGTERM');
  assert.equal(owner.exitCode, 1);
  assert.equal(watch.callbacks.length, 0);
});

test('the window starts before the engine is ready and gets the address when the engine is ready', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const engineStart = Promise.withResolvers();
  const boardStart = Promise.withResolvers();
  const started = [];
  const spawned = [];
  const printed = [];
  const native = fakeWindow();
  const watch = timers();
  const launch = vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    startEngine: () => { started.push('engine'); return engineStart.promise; },
    cachedBoardCheck: () => { started.push('board'); return boardStart.promise; }, forgetBoardCheck() {},
    registerAppIcon: async () => {},
    console: { log: (message) => printed.push(message), error() {}, warn() {} },
    spawn: (program) => { spawned.push(program); return native; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['engine', 'board']);
  assert.deepEqual(spawned, []);
  // The good board check starts the window while the engine still starts: it has no address yet.
  boardStart.resolve({ ok: true, python: '/opt/python3' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spawned, ['/opt/python3']);
  assert.deepEqual(native.stdin.written, []);
  assert.deepEqual(printed, []);
  assert.equal(watch.callbacks.length, 0);
  engineStart.resolve(engine);
  await launch;
  assert.deepEqual(spawned, ['/opt/python3']);
  assert.deepEqual(native.stdin.written, [addressLine]);
  assert.deepEqual(printed, ['ASB: http://127.0.0.1:23456']);
  assert.equal(watch.callbacks.length, 1);
  native.emit('exit', 3, null);
  assert.equal(owner.exitCode, 3);
});

test('a window that ends before the engine is ready keeps its exit code, clears the saved board check, and gets no address', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const engineStart = Promise.withResolvers();
  const spawned = Promise.withResolvers();
  const native = fakeWindow(null);
  const forgotten = [];
  const printed = [];
  const watch = timers();
  const launch = vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    forgetBoardCheck: () => forgotten.push('forgotten'),
    startEngine: () => engineStart.promise, registerAppIcon: async () => {},
    console: { log: (message) => printed.push(message), error() {}, warn() {} },
    spawn: () => { spawned.resolve(); return native; },
  });
  await spawned.promise;
  native.emit('exit', 1, null);
  assert.deepEqual(forgotten, ['forgotten']);
  assert.equal(owner.exitCode, 1);
  engineStart.resolve(engine);
  await launch;
  // The ended window gets no address and the launcher starts no watch, but the line still names the engine.
  assert.deepEqual(native.stdin.written, []);
  assert.equal(watch.callbacks.length, 0);
  assert.deepEqual(printed, ['ASB: http://127.0.0.1:23456']);
  assert.equal(owner.exitCode, 1);
});

test('an engine that cannot start before the board check ends opens no window', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const errors = [];
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => { throw new Error('ASB cannot start its engine. See /x/engine.log.'); },
    cachedBoardCheck: () => new Promise(() => {}),
    registerAppIcon: async () => assert.fail('The engine did not start.'),
    console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    spawn: () => assert.fail('The engine did not start.'),
  });
  assert.deepEqual(errors, ['ASB cannot start its engine. See /x/engine.log.']);
  assert.equal(owner.exitCode, 1);
});

test('an engine that cannot start while the board check runs prints one message, and the late board failure is not unhandled', async (t) => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = {};
  const board = Promise.withResolvers();
  const errors = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    startEngine: async () => { throw new Error('ASB cannot start its engine. See /x/engine.log.'); },
    cachedBoardCheck: () => board.promise,
    registerAppIcon: async () => assert.fail('The engine did not start.'),
    console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    spawn: () => assert.fail('The engine did not start.'),
  });
  board.reject(new Error('Synthetic board failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['ASB cannot start its engine. See /x/engine.log.']);
  assert.deepEqual(unhandled, []);
  assert.equal(owner.exitCode, 1);
});

for (const exitCode of [0, 1]) test(`launcher exit ${exitCode} stops its synthetic native process`, { timeout: 5_000 }, async (t) => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  let native;
  t.after(() => { if (native?.exitCode === null && native?.signalCode === null) native.kill('SIGKILL'); });
  // The synthetic window prints the line that it reads from its stdin pipe and then stays alive.
  const synthetic = `let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { text += chunk; })
    .on('end', () => process.stdout.write('line:' + text)); setInterval(() => {}, 1000)`;
  const launch = vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => engine, registerAppIcon: async () => {},
    console: { log() {}, error() {}, warn() {} },
    spawn: (_program, args, options) => {
      assert.match(args[0], /asb-board\.py$/);
      native = spawn(process.execPath, ['-e', synthetic], { stdio: [options.stdio[0], 'pipe', 'ignore'], env: {} });
      return native;
    },
  });
  await launch;
  const exited = once(native, 'exit');
  const [printed] = await once(native.stdout, 'data');
  assert.equal(String(printed), `line:${addressLine}`);
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
  const launch = vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => engine,
    registerAppIcon: async () => { throw new Error('Synthetic registration failure'); },
    console: { log(message) { printed.push(message); }, error(message) { errors.push(message); }, warn(message) { printed.push(message); } },
    spawn: (program, args, options) => {
      assert.equal(program, '/bin/true');
      assert.equal(options.env, undefined);
      native = spawn(program, args, { stdio: [options.stdio[0], 'ignore', 'ignore'], env: {} });
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

test('a stop during the board check cannot launch a window later', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const starting = Promise.withResolvers();
  const checking = Promise.withResolvers();
  const started = Promise.withResolvers();
  const launch = vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    startEngine: () => { started.resolve(); return starting.promise; }, registerAppIcon: async () => {},
    cachedBoardCheck: () => checking.promise, forgetBoardCheck() {},
    console: { log() {}, error() {}, warn() {} }, spawn: () => assert.fail('The launcher already stopped.'),
  });
  await started.promise;
  owner.emit('SIGTERM');
  checking.resolve({ ok: true, python: '/opt/python3' });
  starting.resolve(engine);
  await launch;
  assert.equal(owner.exitCode, 0);
});

test('a stop during engine startup stops the window that already started, and the engine address is never sent', async () => {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1' };
  const starting = Promise.withResolvers();
  const spawned = Promise.withResolvers();
  const native = fakeWindow(null);
  const watch = timers();
  const printed = [];
  const launch = vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: () => starting.promise, registerAppIcon: async () => {},
    console: { log: (message) => printed.push(message), error() {}, warn() {} },
    spawn: () => { spawned.resolve(); return native; },
  });
  await spawned.promise;
  owner.emit('SIGTERM');
  assert.deepEqual(native.kills, ['SIGTERM']);
  starting.resolve(engine);
  await launch;
  assert.deepEqual(native.stdin.written, []);
  assert.equal(watch.callbacks.length, 0);
  assert.deepEqual(printed, ['ASB: http://127.0.0.1:23456']);
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
  const native = fakeWindow(null);
  native.kill = (signal) => signals.push(signal);
  await vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
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
  const native = fakeWindow(null);
  native.kill = () => assert.fail('The window exited first.');
  await vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, ...boardFakes,
    startEngine: async () => engine, registerAppIcon: async () => {}, console: { log() {}, error() {}, warn() {} },
    spawn: () => native,
  });
  native.exitCode = 0;
  native.emit('exit', 0, null);
  assert.deepEqual(watch.cleared, ['timer-1']);
  assert.equal(owner.exitCode, 0);
});

// The launcher clears the saved board check when the board fails, so that the next start probes again (the cache itself is tested in test/linux-system.test.mjs).
async function openBoard({ forgetBoardCheck, warnings = [], windowEvent }) {
  const owner = new EventEmitter();
  owner.platform = 'linux';
  owner.env = { ASB_SYSTEM_INSTALL: '1', ASB_PYTHON: '/opt/python3' };
  const native = fakeWindow(null);
  const watch = timers();
  const asked = [];
  await vm.runInNewContext(launcher, { ...pick(watch), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
    startEngine: async () => engine, registerAppIcon: async () => {}, forgetBoardCheck,
    cachedBoardCheck: async (options) => { asked.push(options); return { ok: true, python: '/opt/python3' }; },
    console: { log() {}, error() {}, warn: (message) => warnings.push(message) }, spawn: () => native,
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].env, owner.env);
  windowEvent({ native, owner, watch });
  return owner;
}

for (const [name, event, failed, exitCode] of [
  ['exit 0', ['exit', 0, null], false, 0],
  ['exit 3', ['exit', 3, null], true, 3],
  ['exit 1', ['exit', 1, null], true, 1],
  ['a signal', ['exit', null, 'SIGSEGV'], true, 1],
  ['a start error', ['error', new Error('spawn ENOENT')], true, 1],
]) test(`${name} of the board ${failed ? 'clears' : 'keeps'} the saved board check and the launcher exit code is ${exitCode}`, async () => {
  const forgotten = [];
  let launcherProcess;
  const owner = await openBoard({ forgetBoardCheck: (options) => forgotten.push([options.env === launcherProcess.env, launcherProcess.exitCode]),
    windowEvent: ({ native, owner: current }) => { launcherProcess = current; native.emit(...event); } });
  // The call comes before the launcher sets its exit code, with the environment of the launcher.
  assert.deepEqual(forgotten, failed ? [[true, undefined]] : []);
  assert.equal(owner.exitCode, exitCode);
});

test('a stop that the launcher asked for keeps the saved board check', async () => {
  const forgotten = [];
  const owner = await openBoard({ forgetBoardCheck: (options) => forgotten.push(options), windowEvent: ({ native, owner: current, watch }) => {
    current.kill = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
    watch.callbacks[0]();
    native.emit('exit', null, 'SIGTERM');
  } });
  assert.deepEqual(forgotten, []);
  assert.equal(owner.exitCode, 0);
});

test('an error while the saved board check is cleared prints one warning and keeps the exit code of the board', async () => {
  let calls = 0;
  const warnings = [];
  const owner = await openBoard({ warnings, windowEvent: ({ native }) => native.emit('exit', 3, null),
    forgetBoardCheck: () => { calls += 1; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } });
  assert.equal(calls, 1);
  assert.deepEqual(warnings, ['Cannot clear the saved board check: EPERM: operation not permitted']);
  assert.equal(owner.exitCode, 3);
});

// The real saved check: a stub Python counts its probes.
test('with the real saved check, a good start skips the probe and a board error probes again', {
  skip: process.platform === 'win32' ? 'The stub Python is a shell script.' : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-desktop-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const python = path.join(directory, 'python3');
  const log = path.join(directory, 'probes');
  await writeFile(python, `#!/bin/sh\necho probe >> '${log}'\necho '{"python":"3.13.5","gi":"3.50.0","gtk":[4,18,6],"adw":[1,7,6]}'\n`);
  await chmod(python, 0o755);
  const cache = path.join(directory, 'cache');
  const probes = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const saved = async () => (await readdir(path.join(cache, 'asb')).catch(() => [])).join();
  const start = async (exit) => {
    const owner = new EventEmitter();
    owner.platform = 'linux';
    owner.env = { ASB_SYSTEM_INSTALL: '1', ASB_PYTHON: python, XDG_CACHE_HOME: cache };
    const native = fakeWindow(null);
    let program;
    await vm.runInNewContext(launcher, { ...pick(timers()), process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath,
      startEngine: async () => engine, registerAppIcon: async () => {},
      cachedBoardCheck: realCachedBoardCheck, forgetBoardCheck: realForgetBoardCheck,
      console: { log() {}, error() {}, warn() {} }, spawn: (file) => { program = file; return native; },
    });
    assert.equal(program, python);
    native.emit('exit', ...exit);
    return owner.exitCode;
  };
  assert.equal(await start([0, null]), 0);
  assert.deepEqual([await probes(), await saved()], [1, 'board-check.json']);
  assert.equal(await start([0, null]), 0);
  assert.equal(await probes(), 1);
  assert.equal(await start([3, null]), 3);
  assert.deepEqual([await probes(), await saved()], [1, '']);
  assert.equal(await start([0, null]), 0);
  assert.deepEqual([await probes(), await saved()], [2, 'board-check.json']);
});
