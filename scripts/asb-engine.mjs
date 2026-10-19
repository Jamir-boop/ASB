import { execFile as execFileCallback, spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createSwitchboardServer, switchboardPort } from '../src/switchboard.mjs';
import { createMachineGroup } from '../src/machine-group.mjs';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { createSoundPlayer } from '../src/asb-sounds.mjs';
import { findRunningService, instanceRuntimePath, prepareInstanceRuntime, publishInstanceRuntime, removeInstanceRuntime, requestInstance } from './asb-instance.mjs';

const execFileAsync = promisify(execFileCallback);

export const shouldStartTray = (env, platform = process.platform) => platform === 'linux' && Boolean(env.DBUS_SESSION_BUS_ADDRESS) && env.ASB_TRAY !== '0';
export const trayLauncher = (env) => typeof env.ASB_INSTALLED_LAUNCHER === 'string' && path.isAbsolute(env.ASB_INSTALLED_LAUNCHER)
  ? env.ASB_INSTALLED_LAUNCHER : fileURLToPath(new URL('./asb', import.meta.url));
export const engineLogPath = (env) => path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'asb', 'engine.log');

export async function runEngine({ env = process.env } = {}) {
  const prepared = await prepareInstanceRuntime(env);
  let runtimeRecord;
  const port = switchboardPort(env.PORT);
  const sourceToken = randomBytes(32).toString('hex');
  const asbVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  // Decision B: the group reads the gateway and the server lazily, so it is made first.
  const group = createMachineGroup({ gateway: () => gateway, server: () => server, asbVersion,
    onChange: () => server.invalidateDashboard('peer-sessions', { hard: false }) });
  const gateway = createPhoneGateway({ localPort: port, asbVersion, peer: group.peer,
    onPhonePaired: group.onPhonePaired, onPhoneRevoked: group.onPhoneRevoked });
  let machineId = '';
  const server = createSwitchboardServer({ sourceToken, phoneGateway: gateway, machineGroup: group, serviceMode: true, playSound: createSoundPlayer(),
    machineIdentity: () => ({ machineId, machineName: group.selfName() }),
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
        step = 'tray stop';
        tray?.kill('SIGTERM');
        try {
          step = 'manifest removal';
          await removeInstanceRuntime(runtimeRecord);
        } finally {
          const closed = new Promise((resolve) => server.close(resolve));
          server.closeAllConnections();
          try {
            step = 'machine links stop';
            await group.stop();
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
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    if (stopping) return;
    try {
      await gateway.start();
      const status = await gateway.status();
      if (status.error) console.error(`Cannot start ASB phone access: ${status.error}`);
    } catch (error) { console.error(`Cannot start ASB phone access: ${error.message}`); }
    machineId = await gateway.identity().catch(() => '');
    if (stopping) return;
    try { await group.start(); } catch (error) { console.error(`Cannot start the ASB machine group: ${error.message}`); }
    if (stopping) return;
    runtimeRecord = await publishInstanceRuntime(prepared, { schema: 1, pid: process.pid, port, sourceToken });
    if (!stopping && shouldStartTray(env)) {
      tray = spawnProcess(env.ASB_PYTHON || '/usr/bin/python3', [fileURLToPath(new URL('./asb-tray.py', import.meta.url))], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...env, ASB_ENGINE_PID: String(process.pid), ASB_ENGINE_URL: `http://127.0.0.1:${port}`, ASB_SOURCE_TOKEN: sourceToken, ASB_LAUNCHER: trayLauncher(env) },
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
  if (!instanceRuntimePath(env)) throw new Error('ASB cannot start its engine: XDG_RUNTIME_DIR must be an absolute folder.');
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

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw new Error('The ASB engine requires Linux.');
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
  if (!runtime) { console.log('ASB engine is not running.'); return 0; }
  const reply = await requestInstance(runtime, '/api/engine/stop', { method: 'POST', body: {} });
  if (reply.statusCode !== 200) throw new Error(reply.body?.error || `The ASB engine refused the stop (HTTP ${reply.statusCode}).`);
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await delay(100)) {
    try { process.kill(runtime.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      console.log('ASB engine stopped.');
      return 0;
    }
  }
  throw new Error('The ASB engine did not stop in 10 s.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`ASB engine: ${error.message}`); process.exitCode = 1; }
}
