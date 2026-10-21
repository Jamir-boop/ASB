import { execFile as execFileCallback, spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createSwitchboardServer, switchboardPort } from '../src/switchboard.mjs';
import { createMachineGroup } from '../src/machine-group.mjs';
import { createRelaySupervisor } from '../src/machine-relay.mjs';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { createSoundPlayer } from '../src/asb-sounds.mjs';
import { boardCheck } from '../src/linux-system.mjs';
import { cacheDir, configDir, runtimeDir, stateDir } from '../src/platform-paths.mjs';
import { createReaderPositions } from '../src/reader-positions.mjs';
import { findRunningService, prepareInstanceRuntime, protectWindowsFolder, publishInstanceRuntime,
  removeInstanceRuntime, requestInstance } from './asb-instance.mjs';

const execFileAsync = promisify(execFileCallback);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// Plan P12: the HKCU Run value starts the hidden tray script, and the tray starts and watches the engine.
export const trayArguments = (root = ROOT, node = process.execPath) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', path.win32.join(root, 'scripts', 'asb-tray.ps1'), node];
export const trayCommand = (root = ROOT, node = process.execPath) => {
  const args = trayArguments(root, node);
  return ['powershell.exe', ...args.slice(0, -2), `"${args.at(-2)}"`, `"${args.at(-1)}"`].join(' ');
};
// S7 follow-up: a detached child has no console, and powershell.exe then exits at once. A short PowerShell starts the tray
// with Start-Process instead, so the tray gets its own hidden console and outlives this command.
export const trayStartArguments = ['-NoProfile', '-NonInteractive', '-Command',
  'Start-Process -FilePath powershell.exe -ArgumentList $env:ASB_TRAY_ARGS -WindowStyle Hidden'];
// The tray starts the engine in a hidden console, which is a TTY, so the tray also sets ASB_ENGINE_LOG.
export const writesEngineLog = (env, isTTY = process.stdout.isTTY) => !isTTY || env.ASB_ENGINE_LOG === '1';

export const shouldStartTray = (env, platform = process.platform) => platform === 'linux' && Boolean(env.DBUS_SESSION_BUS_ADDRESS) && env.ASB_TRAY !== '0';
export const trayLauncher = (env) => typeof env.ASB_INSTALLED_LAUNCHER === 'string' && path.isAbsolute(env.ASB_INSTALLED_LAUNCHER)
  ? env.ASB_INSTALLED_LAUNCHER : fileURLToPath(new URL('./asb', import.meta.url));
export const engineLogPath = (env, platform = process.platform) => path.join(stateDir(env, platform), 'engine.log');
// The folders that the Windows engine limits to the user with icacls.
export const engineFolders = (env, platform = process.platform) => [configDir(env, platform), stateDir(env, platform), runtimeDir(env, platform),
  cacheDir(env, platform)];
export const readerPositionsPath = (env, platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix)
  .join(cacheDir(env, platform), 'readers', 'positions.json');

export async function runEngine({ env = process.env, platform = process.platform, execFile = execFileAsync } = {}) {
  if (platform === 'win32') {
    for (const folder of engineFolders(env, platform)) {
      mkdirSync(folder, { recursive: true });
      await protectWindowsFolder(folder, { env, execFile });
    }
  }
  const prepared = await prepareInstanceRuntime(env, { platform });
  let runtimeRecord;
  const port = switchboardPort(env.PORT);
  const sourceToken = randomBytes(32).toString('hex');
  const asbVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  // Decision B: the group reads the gateway and the server lazily, so it is made first.
  const group = createMachineGroup({ gateway: () => gateway, server: () => server, asbVersion,
    onChange: () => { server.invalidateDashboard('peer-sessions', { hard: false }); relay.check(); } });
  const relay = createRelaySupervisor({ group, port, sourceToken, env, platform, bindTarget: (request) => server.bindMemberTarget(request) });
  const gateway = createPhoneGateway({ localPort: port, asbVersion,
    peer: { ...group.peer, peers: () => relay.peerPeers(), deliver: (value, fingerprint) => relay.peerDeliver(value, fingerprint),
      resolveExact: (value, fingerprint) => relay.peerResolveExact(value, fingerprint), deliverExact: (value, fingerprint) => relay.peerDeliverExact(value, fingerprint) },
    onPhonePaired: group.onPhonePaired, onPhoneRevoked: group.onPhoneRevoked });
  const positions = createReaderPositions({ file: readerPositionsPath(env, platform), key: () => gateway.readerPositionsKey(), platform });
  let machineId = '';
  let referenceScopes = null;
  // Windows has no board, so it never plays sounds (phase 1 rule).
  const server = createSwitchboardServer({ sourceToken, phoneGateway: gateway, machineGroup: group, machineRelay: relay, serviceMode: true, platform,
    readerPositions: positions,
    playSound: platform === 'win32' ? undefined : createSoundPlayer(),
    machineIdentity: () => ({ machineId, machineName: group.selfName() }), referenceScopes: () => referenceScopes,
    onStop: () => shutdown('the stop request') });
  let stopping = false;
  let cleanup;
  let startup;
  let tray = null;
  let step = 'startup';
  const stop = () => {
    stopping = true;
    return cleanup ||= (async () => {
      try {
        await startup.catch(() => {});
        step = 'reader positions save';
        await positions.flush();
        step = 'tray stop';
        tray?.kill('SIGTERM');
        try {
          step = 'manifest removal';
          await removeInstanceRuntime(runtimeRecord);
        } finally {
          const closed = new Promise((resolve) => server.close(resolve));
          server.closeAllConnections();
          try {
            try {
              step = 'relay stop';
              await relay.stop();
            } finally {
              step = 'machine links stop';
              await group.stop();
            }
          } finally {
            step = 'phone access stop';
            try { await gateway.stop(); } finally {
              step = 'server close';
              await closed;
            }
          }
        }
      } finally { step = 'none'; }
    })();
  };
  const shutdown = (reason) => {
    // A cleanup step that never ends must not keep the engine until systemd kills it; a clean stop exits at once.
    setTimeout(() => {
      console.error(`ASB engine is still running 5 s after ${reason}. Pending cleanup step: ${step}. Open resources: ${process.getActiveResourcesInfo().join(', ') || 'none'}.`);
      process.exit(1);
    }, 5000).unref();
    stop().catch((error) => { console.error(`Cannot stop ASB service: ${error.message}`); process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  startup = (async () => {
    // The identity comes before the listen: a phone read right after it gets rows with a machine ID (the phone keys rows by it).
    machineId = await gateway.identity().catch(() => '');
    if (machineId) referenceScopes = await gateway.referenceScopes().catch(() => null);
    if (stopping) return;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    if (stopping) return;
    try {
      await gateway.start();
      const status = await gateway.status();
      if (status.error) console.error(`Cannot start ASB phone access: ${status.error}`);
    } catch (error) { console.error(`Cannot start ASB phone access: ${error.message}`); }
    if (stopping) return;
    try { await group.start(); } catch (error) { console.error(`Cannot start the ASB machine group: ${error.message}`); }
    if (stopping) return;
    relay.start().catch(() => console.error('ASB cannot start the message relay.'));
    runtimeRecord = await publishInstanceRuntime(prepared, { schema: 1, pid: process.pid, port, sourceToken });
    // The tray needs only GLib, so a Python with PyGObject is enough. Without the board, the tray has no Open ASB (ASB_BOARD=0).
    const wantTray = !stopping && shouldStartTray(env, platform);
    const board = wantTray ? await boardCheck({ env, execFile }) : null;
    const trayPython = board?.versions?.gi ? board.python : '';
    if (wantTray && !trayPython) console.error('ASB cannot start its tray icon: no Python 3 with PyGObject was found.');
    if (wantTray && trayPython && !stopping) {
      const { ASB_BOARD: _board, ...trayEnv } = env;
      tray = spawnProcess(trayPython, [fileURLToPath(new URL('./asb-tray.py', import.meta.url))], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...trayEnv, ...(board.ok ? {} : { ASB_BOARD: '0' }), ASB_ENGINE_PID: String(process.pid), ASB_ENGINE_URL: `http://127.0.0.1:${port}`,
          ASB_SOURCE_TOKEN: sourceToken, ASB_LAUNCHER: trayLauncher(env) },
      });
      tray.unref();
      tray.once('error', (error) => {
        console.error(`ASB cannot start its tray icon: ${error.message}`);
        tray = null;
      });
      tray.once('exit', (code) => {
        if (!stopping && code !== 0) console.error(`ASB tray icon stopped with exit code ${code}.`);
        tray = null;
      });
    }
    if (!stopping) console.log(`ASB service: http://127.0.0.1:${port}`);
  })();
  try { await startup; }
  catch (error) { await stop(); throw error; }
}

export async function startEngine({ env = process.env, execFile = execFileAsync, spawn = spawnProcess, find = findRunningService,
  timeoutMs = 10_000, intervalMs = 200 } = {}) {
  const running = await find(env);
  if (running) return running;
  let enabled = false;
  try { enabled = (await execFile('systemctl', ['--user', 'is-enabled', 'asb.service'])).stdout.trim() === 'enabled'; } catch {}
  let where;
  if (enabled) {
    try { await execFile('systemctl', ['--user', 'start', 'asb.service']); }
    catch { throw new Error('ASB cannot start its engine. See journalctl --user -u asb.service.'); }
    where = 'journalctl --user -u asb.service';
  } else {
    const log = engineLogPath(env);
    mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    const fd = openSync(log, 'w', 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], { detached: true, stdio: ['ignore', fd, fd], env });
      child.once('error', () => {});
      child.unref();
    } finally { closeSync(fd); }
    where = log;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(intervalMs);
    const runtime = await find(env);
    if (runtime) return runtime;
  }
  throw new Error(`ASB cannot start its engine. See ${where}.`);
}

export async function stopRunning(runtime, log) {
  if (!runtime) { log('ASB engine is not running.'); return 0; }
  const reply = await requestInstance(runtime, '/api/engine/stop', { method: 'POST', body: {} });
  if (reply.statusCode !== 200) throw new Error(reply.body?.error || `The ASB engine refused the stop (HTTP ${reply.statusCode}).`);
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await delay(100)) {
    try { process.kill(runtime.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      log('ASB engine stopped.');
      return 0;
    }
  }
  throw new Error('The ASB engine did not stop in 10 s.');
}

// Starts the tray script now, which starts the engine, unless an engine already answers.
export async function startWindowsEngine({ env = process.env, spawn = spawnProcess, find = findRunningService, root = ROOT,
  node = process.execPath, timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const running = await find(env, 'win32');
  if (running) return running;
  // The Run value and this start use the same tray command text.
  const trayArgs = trayCommand(root, node).slice('powershell.exe '.length);
  const code = await new Promise((resolve) => {
    const child = spawn('powershell.exe', trayStartArguments, { windowsHide: true, stdio: 'ignore', env: { ...env, ASB_TRAY_ARGS: trayArgs } });
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error('ASB cannot start its tray. Windows PowerShell failed.');
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    await delay(intervalMs);
    const runtime = await find(env, 'win32');
    if (runtime) return runtime;
  }
  throw new Error(`ASB cannot start its engine. See ${engineLogPath(env, 'win32')}.`);
}

async function windowsMain(command, { env, execFile, spawn, find, log, root, node, timeoutMs }) {
  if (command === 'run') {
    // The messages of a tray engine go to the engine log, as a detached Linux engine does.
    if (writesEngineLog(env)) {
      const log = engineLogPath(env, 'win32');
      mkdirSync(path.dirname(log), { recursive: true });
      const file = createWriteStream(log, { flags: 'w' });
      for (const stream of [process.stdout, process.stderr]) stream.write = file.write.bind(file);
    }
    await runEngine({ env, platform: 'win32', execFile });
    return 0;
  }
  if (command === 'install' || command === 'start') {
    if (command === 'install') {
      // S7: PowerShell 5.1 drops the quotes of a native argument, so the Run value is written from Node.
      await execFile('reg', ['add', RUN_KEY, '/v', 'ASB', '/t', 'REG_SZ', '/d', trayCommand(root, node), '/f'], { windowsHide: true });
      log('ASB starts when you sign in to Windows.');
    }
    const runtime = await startWindowsEngine({ env, spawn, find, root, node, timeoutMs });
    log(`ASB engine: running. PID ${runtime.pid}, port ${runtime.port}.`);
    return 0;
  }
  if (command === 'uninstall') {
    let present = true;
    try { await execFile('reg', ['query', RUN_KEY, '/v', 'ASB'], { windowsHide: true }); } catch { present = false; }
    if (present) await execFile('reg', ['delete', RUN_KEY, '/v', 'ASB', '/f'], { windowsHide: true });
    log('ASB no longer starts when you sign in to Windows.');
    return stopRunning(await find(env, 'win32'), log);
  }
  const runtime = await find(env, 'win32');
  if (command === 'stop') return stopRunning(runtime, log);
  if (!runtime) { log('ASB engine: not running.'); return 1; }
  log(`ASB engine: running. PID ${runtime.pid}, port ${runtime.port}, tray.`);
  return 0;
}

export async function main(args = process.argv.slice(2), { platform = process.platform, env = process.env, execFile = execFileAsync,
  spawn = spawnProcess, find = findRunningService, log = console.log, error: logError = console.error, root = ROOT,
  node = process.execPath, timeoutMs } = {}) {
  if (platform === 'win32') {
    if (args.length !== 1 || !['run', 'start', 'stop', 'status', 'install', 'uninstall'].includes(args[0])) {
      logError('Usage: asb engine run|start|stop|status|install|uninstall');
      return 2;
    }
    return windowsMain(args[0], { env, execFile, spawn, find, log, root, node, timeoutMs });
  }
  if (platform !== 'linux') throw new Error('The ASB engine requires Linux or Windows.');
  if (args.length !== 1 || !['run', 'start', 'stop', 'status'].includes(args[0])) {
    console.error('Usage: asb engine run|start|stop|status');
    return 2;
  }
  if (args[0] === 'run') { await runEngine(); return 0; }
  if (args[0] === 'start') {
    const runtime = await startEngine();
    console.log(`ASB engine: running. PID ${runtime.pid}, port ${runtime.port}.`);
    return 0;
  }
  const runtime = await findRunningService();
  if (args[0] === 'status') {
    if (!runtime) { console.log('ASB engine: not running.'); return 1; }
    let mode = 'detached';
    try {
      if ((await execFileAsync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'asb.service'])).stdout.trim() === String(runtime.pid)) mode = 'user service';
    } catch {}
    console.log(`ASB engine: running. PID ${runtime.pid}, port ${runtime.port}, ${mode}.`);
    return 0;
  }
  return stopRunning(runtime, console.log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`ASB engine: ${error.message}`); process.exitCode = 1; }
}
