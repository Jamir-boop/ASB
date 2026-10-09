import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const launcherUrl = new URL('../scripts/asb-desktop.mjs', import.meta.url);
const launcher = (await readFile(launcherUrl, 'utf8')).replace(/^import[^\n]*\n/gm, '')
  .replaceAll('import.meta.url', 'launcherUrl');

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
  vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes,
    createSwitchboardServer: () => server, switchboardPort: () => 4629, registerAppIcon: async () => {},
    console: { log() {}, error() {}, warn() {} },
    spawn: (_program, args) => {
      assert.match(args[0], /asb-native\.py$/);
      assert.equal(args[1], 'http://127.0.0.1:4629');
      native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} });
      return native;
    },
  });
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
  let ready;
  let native;
  let closed = 0;
  let sourceToken;
  const errors = [];
  const printed = [];
  server.listen = (_port, host, callback) => { assert.equal(host, '127.0.0.1'); ready = callback(); };
  server.close = () => { closed += 1; };
  server.closeAllConnections = () => {};
  t.after(() => { if (native?.exitCode === null && native?.signalCode === null) native.kill('SIGKILL'); });
  vm.runInNewContext(launcher, { process: owner, URL, launcherUrl: launcherUrl.href, fileURLToPath, randomBytes,
    createSwitchboardServer: (options) => { sourceToken = options.sourceToken; return server; }, switchboardPort: () => 4629,
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
  await ready;
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
