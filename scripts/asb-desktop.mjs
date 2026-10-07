import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSwitchboardServer, switchboardPort } from '../src/switchboard.mjs';
import { registerAppIcon } from './asb-icon.mjs';

if (process.platform !== 'linux') {
  console.error('The ASB desktop launcher requires Linux. Use npm start and open the local address.');
  process.exit(1);
}
const port = switchboardPort();
const server = createSwitchboardServer();
let window;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (window && window.exitCode === null) window.kill('SIGTERM');
  server.close();
  server.closeAllConnections();
}
server.once('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `ASB cannot start. Port ${port} is in use.` : `ASB cannot start: ${error.message}`);
  stop(1);
});
server.listen(port, '127.0.0.1', async () => {
  try {
    if (process.env.ASB_SYSTEM_INSTALL !== '1') {
      const registration = await registerAppIcon({ launcherExecutable: process.env.ASB_INSTALLED_LAUNCHER });
      if (registration.message) console.warn(registration.message);
    }
  } catch (error) {
    console.error(`Cannot register the ASB icon: ${error.message}`);
    stop(1);
    return;
  }
  if (stopping) return;
  const url = `http://127.0.0.1:${port}`;
  window = spawn(process.env.ASB_PYTHON || '/usr/bin/python3', [fileURLToPath(new URL('./asb-native.py', import.meta.url)), url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  window.once('error', (error) => {
    console.error(`Cannot open the native ASB window: ${error.message}. Use system Python 3 or npm start for the web view.`);
    stop(1);
  });
  window.once('exit', (code, signal) => stop(signal ? 1 : code || 0));
  console.log(`ASB: ${url}`);
});
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
