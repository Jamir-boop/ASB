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
let detach;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(detach);
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
  // A launcher that already stops (the window ended first) sends no address, but the line still names the engine.
  // The engine PID and the Node path let the board run the follow mode below when its engine goes away.
  if (!stopping) {
    window.stdin.write(`${JSON.stringify({ url, token: service.sourceToken, pid: service.pid, node: process.execPath })}\n`);
    // A board that fails in its first 30 s still clears the saved board check and gives its exit code. After that the launcher ends.
    detach = setTimeout(() => {
      if (stopping) return;
      window.stdin.end();
      window.removeAllListeners('exit');
      window.unref();
      window = undefined;
      process.exitCode = 0;
    }, 30_000);
  }
  console.log(`ASB: ${url}`);
}

// The follow mode of the board: after its engine went away, it says whether that engine still runs ("alive"), quit ("quit"), or another
// engine of this package answers ("moved"). Discovery never starts an engine: an update must be able to stop and replace the installed engine.
export async function followEngine(service, { env = process.env, platform = process.platform,
  find = () => findRunningService(env, platform), marker = () => readQuitMarker(env, platform),
  status = async (runtime) => {
    const reply = await requestInstance(runtime, '/api/agent/status');
    if (reply.statusCode !== 200) throw new Error('Cannot read ASB engine status.');
    return reply.body;
  }, alive = (pid) => process.kill(pid, 0), sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)), now = Date.now,
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  root = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  // A stopping engine closes its streams first and saves its state after that: its PID can live on for a second or more.
  for (const end = now() + 5_000; ;) {
    try { alive(service.pid); }
    catch (error) { if (error.code === 'ESRCH') break; }
    if (now() >= end) return { state: 'alive' };
    await sleep(100);
  }
  const quit = await marker();
  if (quit?.token === createHash('sha256').update(service.token).digest('hex')) return { state: 'quit' };
  const deadline = now() + 20_000;
  try {
    for (;;) {
      const next = await find();
      if (next && next.pid !== service.pid) {
        const info = await status(next);
        if (info?.appVersion !== version || typeof info.rootDir !== 'string' || path.resolve(info.rootDir) !== path.resolve(root)) return { state: 'quit' };
        return { state: 'moved', url: `http://127.0.0.1:${next.port}`, token: next.sourceToken, pid: next.pid };
      }
      if (now() >= deadline) return { state: 'quit' };
      await sleep(500);
    }
  } catch { return { state: 'quit' }; }
}

// Reads the line {"pid","token"} of the board (at most 4096 bytes), prints the follow result as one JSON line, and exits 0; a bad line exits 2.
export async function follow({ input = process.stdin, output = process.stdout, errors = console.error, options } = {}) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of input) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.includes(10) || bytes.length > 4097) break;
  }
  const end = bytes.indexOf(10);
  const line = end < 0 ? bytes : bytes.subarray(0, end);
  let value;
  try { value = line.length <= 4096 ? JSON.parse(line.toString('utf8')) : undefined; } catch {}
  if (!value || typeof value !== 'object' || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647
    || typeof value.token !== 'string' || !value.token) {
    errors('ASB follow mode needs one JSON line with the engine pid and token on stdin.');
    return 2;
  }
  output.write(`${JSON.stringify(await followEngine(value, options))}\n`);
  return 0;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.argv[2] === '--follow' ? follow().then((code) => { process.exitCode = code; }) : main();
