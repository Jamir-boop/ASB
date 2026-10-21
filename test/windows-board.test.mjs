import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { findRunningService } from '../scripts/asb-instance.mjs';

// The Windows board smoke test (the board-windows CI job): the real launcher and the real GTK board against a fake engine.
// Needs MSYS2 Python with GTK in a signed-in desktop session, so it is not in test/windows-tests.json.
const asb = fileURLToPath(new URL('../scripts/asb.mjs', import.meta.url));
const now = Date.now();
const row = (id, provider, title, cwd, state, age, extra = {}) => ({ id, provider, canOpen: true, title, cwd, state, updatedAtMs: now - age,
  providerLabel: provider === 'codex' ? 'Codex' : 'Claude Desktop Code', projectName: cwd.split('\\').pop(), ...extra });
const dashboard = { generatedAtMs: now, persistentUnread: false,
  providers: [{ id: 'codex', label: 'Codex', message: '' }, { id: 'claude-desktop-code', label: 'Claude Desktop Code', message: '' }],
  threads: [
    row('first', 'codex', 'Verify native session switching', 'C:\\example\\ASB', 'working', 0),
    row('second', 'codex', 'Check keyboard focus after refresh', 'C:\\example\\ASB', 'idle', 60_000, { pending: true, unread: true, pendingSource: 'observed-completion' }),
    row('claude:local_mock', 'claude-desktop-code', 'Choose the folder for the next check', 'C:\\example\\Notes', 'waiting', 120_000,
      { pending: true, pendingSource: 'user-action', actionRequired: true }),
    row('claude:local_done', 'claude-desktop-code', 'Completed setup', 'C:\\example\\Notes', 'idle', 3_600_000),
  ] };

// The engine for the board: it answers as the service, serves the dashboard, and writes the runtime file that the launcher reads.
const fakeEngine = (runtimeFile, sourceToken) => `
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const runtimeFile = ${JSON.stringify(runtimeFile)};
const dashboard = ${JSON.stringify(dashboard)};
const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
const server = http.createServer((request, response) => {
  request.resume();
  const route = request.url.split('?')[0];
  if (route === '/api/service') send(response, 200, { service: true, pid: process.pid });
  else if (route === '/api/dashboard') send(response, 200, dashboard);
  else if (route === '/api/events') send(response, 404, {});
  else send(response, 200, {});
});
server.listen(0, '127.0.0.1', () => {
  mkdirSync(path.dirname(runtimeFile), { recursive: true });
  writeFileSync(runtimeFile, JSON.stringify({ schema: 1, pid: process.pid, port: server.address().port, sourceToken: ${JSON.stringify(sourceToken)} }));
  console.log('ready');
});
`;

test('the board opens its window against an engine and closes when the engine stops', {
  skip: process.platform === 'win32' && process.env.ASB_BOARD_SMOKE === '1' ? false
    : 'Windows with MSYS2 GTK in a desktop session: set ASB_BOARD_SMOKE=1 (and ASB_PYTHON)',
  timeout: 150_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-board-smoke-'));
  const children = [];
  // On Windows, child.kill() ends only that process, so taskkill /t also ends the board that a failed run leaves.
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const local = path.join(directory, 'local');
  const image = path.join(directory, 'board.png');
  const script = path.join(directory, 'fake-engine.mjs');
  await writeFile(script, fakeEngine(path.join(local, 'asb', 'run', 'service.json'), 'ab'.repeat(32)));

  const engine = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  children.push(engine);
  const [line] = await Promise.race([once(engine.stdout, 'data'), once(engine, 'exit').then(() => [''])]);
  assert.match(String(line), /ready/, 'The fake engine did not start.');
  // Without a running engine, the launcher would start the real tray, so the test checks the launcher's own lookup first.
  assert.equal((await findRunningService({ LOCALAPPDATA: local }, 'win32'))?.pid, engine.pid, 'The launcher cannot find the fake engine.');

  const launcher = spawn(process.execPath, [asb], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: local, APPDATA: path.join(directory, 'roaming'), ASB_SNAPSHOT: image } });
  children.push(launcher);
  let output = '';
  launcher.stdout.on('data', (chunk) => { output += `[stdout] ${chunk}`; });
  launcher.stderr.on('data', (chunk) => { output += `[stderr] ${chunk}`; });
  const exited = new Promise((resolve) => launcher.once('exit', (code, signal) => resolve({ code, signal })));

  const saved = async () => (await stat(image).catch(() => null))?.size > 0;
  for (const deadline = Date.now() + 90_000; !(await saved()) && launcher.exitCode === null && Date.now() < deadline;) await delay(250);
  assert.ok(await saved(), `The board saved no window image.\n${output}`);

  // The launcher watches the engine process and closes the board when it is gone.
  engine.kill();
  const closed = await Promise.race([exited, delay(20_000, null, { ref: false })]);
  assert.deepEqual(closed, { code: 0, signal: null }, `The launcher did not exit with code 0 within 20 s after the engine stopped.\n${output}`);
});
