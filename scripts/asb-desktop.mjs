import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { findRunningService, readQuitMarker, requestInstance } from './asb-instance.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedBoardCheck, forgetBoardCheck } from '../src/linux-system.mjs';
import { startEngine, startWindowsEngine } from './asb-engine.mjs';
import { registerAppIcon } from './asb-icon.mjs';

let window;
let engineWatch;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  engineWatch?.();
  window?.stdin?.end();
  process.exitCode = code;
  if (window && window.exitCode === null) window.kill('SIGTERM');
}

// A board that fails may have lost its libraries after the check: the next start must probe again.
function forgetBoard() {
  try { forgetBoardCheck({ env: process.env }); }
  catch (error) { console.warn(`Cannot clear the saved board check: ${error.message}`); }
}

async function start() {
  const windows = process.platform === 'win32';
  const engine = windows ? startWindowsEngine() : startEngine();
  // The board check runs while the engine starts. Its result comes before the icon registration, so that a run without the window writes nothing.
  // A good result is kept in the cache folder until the board fails (forgetBoard), so that most starts skip the Python probe.
  // A failed engine start ends the launcher at once, also while the check runs.
  const checked = cachedBoardCheck({ env: process.env });
  const board = await Promise.race([checked, engine.then(() => checked)]);
  if (stopping) return;
  if (!board.ok) {
    await engine;
    if (stopping) return;
    console.error(`ASB runs without its window on this system: ${board.reason} The engine runs for the phone and your other machines. Run asb doctor for details.`);
    stop(3);
    return;
  }
  try {
    if (!windows && process.env.ASB_SYSTEM_INSTALL !== '1') {
      const registration = await registerAppIcon({ launcherExecutable: process.env.ASB_INSTALLED_LAUNCHER });
      if (registration.message) console.warn(registration.message);
    }
  } catch (error) {
    console.error(`Cannot register the ASB icon: ${error.message}`);
  }
  if (stopping) return;
  // The window starts while the engine starts, so that its slow GTK import overlaps the engine start. The argument "-" tells it to read the
  // engine URL and the source token from stdin: JSON lines, written when the engine is ready or restarts. Neither goes into an argument or a file.
  window = spawn(board.python, [fileURLToPath(new URL('./asb-board.py', import.meta.url)), '-'], {
    stdio: ['pipe', 'inherit', 'inherit'], ...(windows ? { windowsHide: true } : {}),
  });
  window.once('error', (error) => {
    console.error(`Cannot open the native ASB window: ${error.message}. Use system Python 3 or npm start for the web view.`);
    forgetBoard();
    stop(1);
  });
  window.once('exit', (code, signal) => {
    // A stop that the launcher asked for is no failure.
    if ((signal || code) && !stopping) forgetBoard();
    stop(signal ? 1 : code || 0);
  });
  // A window that ended before the line is read raises EPIPE here; its exit event reports it.
  window.stdin?.on('error', () => {});
  // A failed engine start stops the window through main().
  const service = await engine;
  const url = `http://127.0.0.1:${service.port}`;
  // A launcher that already stops (the window ended first) sends no address and starts no watch, but the line still names the engine.
  if (!stopping) {
    window.stdin.write(`${JSON.stringify({ url, token: service.sourceToken })}\n`);
    engineWatch = watchEngine(service, { window, stop });
  }
  console.log(`ASB: ${url}`);
}
// Discovery never starts an engine: an update must be able to stop and replace the installed engine.
export function watchEngine(service, { window, stop, env = process.env, platform = process.platform,
  find = () => findRunningService(env, platform), marker = () => readQuitMarker(env, platform),
  status = async (runtime) => {
    const reply = await requestInstance(runtime, '/api/agent/status');
    if (reply.statusCode !== 200) throw new Error('Cannot read ASB engine status.');
    return reply.body;
  }, alive = (pid) => process.kill(pid, 0), every = setInterval, clearEvery = clearInterval,
  later = setTimeout, clearLater = clearTimeout,
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  root = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  let interval, deadline, cancelled = false, busy = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (interval !== undefined) clearEvery(interval);
    if (deadline !== undefined) clearLater(deadline);
  };
  const finish = () => { if (!cancelled) { cancel(); stop(0); } };
  const watch = () => {
    interval = every(async () => {
      if (cancelled) return;
      try { alive(service.pid); return; }
      catch (error) { if (error.code !== 'ESRCH') return; }
      clearEvery(interval);
      interval = undefined;
      deadline = later(finish, 20_000);
      const quit = await marker();
      if (cancelled) return;
      if (quit?.token === createHash('sha256').update(service.sourceToken).digest('hex')) {
        finish();
        return;
      }
      interval = every(async () => {
        if (cancelled || busy) return;
        busy = true;
        try {
          const next = await find();
          if (cancelled || !next || next.pid === service.pid) return;
          const info = await status(next);
          if (cancelled) return;
          if (info?.appVersion !== version || typeof info.rootDir !== 'string' || path.resolve(info.rootDir) !== path.resolve(root)) {
            finish();
            return;
          }
          window.stdin.write(`${JSON.stringify({ url: `http://127.0.0.1:${next.port}`, token: next.sourceToken })}\n`);
          service = next;
          clearEvery(interval);
          clearLater(deadline);
          deadline = undefined;
          watch();
        } catch { if (!cancelled) finish(); }
        finally { busy = false; }
      }, 500);
    }, 2000);
  };
  watch();
  return cancel;
}

// Opens the board: starts the engine when it is not running, then the native window as its client.
export function main() {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    console.error('The ASB desktop launcher requires Linux or Windows. Use npm start and open the local address.');
    process.exit(1);
  }
  process.once('SIGINT', () => stop());
  process.once('SIGTERM', () => stop());
  process.once('exit', stop);
  return start().catch((error) => {
    console.error(error.message.startsWith('ASB cannot') ? error.message : `ASB cannot start: ${error.message}`);
    stop(1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
