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
  clearInterval(engineWatch);
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
  // The board check runs while the engine starts. Its result comes before the icon registration, so that a run without the window writes nothing.
  // A good result is kept in the cache folder until the board fails (forgetBoard), so that most starts skip the Python probe.
  const [service, board] = await Promise.all([windows ? startWindowsEngine() : startEngine(), cachedBoardCheck({ env: process.env })]);
  if (stopping) return;
  if (!board.ok) {
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
  const url = `http://127.0.0.1:${service.port}`;
  window = spawn(board.python, [fileURLToPath(new URL('./asb-board.py', import.meta.url)), url], {
    stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ASB_SOURCE_TOKEN: service.sourceToken },
    ...(windows ? { windowsHide: true } : {}),
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
  // The window closes when its engine stops, for example after Quit ASB in the tray; a restarted engine has a new token.
  engineWatch = setInterval(() => {
    try { process.kill(service.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') stop(0); }
  }, 2000);
  console.log(`ASB: ${url}`);
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
