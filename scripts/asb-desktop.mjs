import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startEngine } from './asb-engine.mjs';
import { registerAppIcon } from './asb-icon.mjs';

if (process.platform !== 'linux') {
  console.error('The ASB desktop launcher requires Linux. Use npm start and open the local address.');
  process.exit(1);
}
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

async function start() {
  const service = await startEngine();
  if (stopping) return;
  try {
    if (process.env.ASB_SYSTEM_INSTALL !== '1') {
      const registration = await registerAppIcon({ launcherExecutable: process.env.ASB_INSTALLED_LAUNCHER });
      if (registration.message) console.warn(registration.message);
    }
  } catch (error) {
    console.error(`Cannot register the ASB icon: ${error.message}`);
  }
  if (stopping) return;
  const url = `http://127.0.0.1:${service.port}`;
  window = spawn(process.env.ASB_PYTHON || '/usr/bin/python3', [fileURLToPath(new URL('./asb-native.py', import.meta.url)), url], {
    stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ASB_SOURCE_TOKEN: service.sourceToken },
  });
  window.once('error', (error) => {
    console.error(`Cannot open the native ASB window: ${error.message}. Use system Python 3 or npm start for the web view.`);
    stop(1);
  });
  window.once('exit', (code, signal) => stop(signal ? 1 : code || 0));
  // The window closes when its engine stops, for example after Quit ASB in the tray; a restarted engine has a new token.
  engineWatch = setInterval(() => {
    try { process.kill(service.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') stop(0); }
  }, 2000);
  console.log(`ASB: ${url}`);
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
process.once('exit', stop);
start().catch((error) => {
  console.error(error.message.startsWith('ASB cannot') ? error.message : `ASB cannot start: ${error.message}`);
  stop(1);
});
