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
const tray = fileURLToPath(new URL('../scripts/asb-tray.ps1', import.meta.url));
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

// The ids of the board processes below one root process. The board gets its engine URL and token on stdin, so its command line is only
// `<python> asb-board.py -`, the same for every ASB on the PC: a match on the command line alone would also find the board of the user's own
// ASB. A board is found by ancestry instead. A process that has ended still shows as the ParentProcessId of its children, so the walk also
// starts from the PID of a process that has ended (the PowerShell process of the Start menu command waits at most 30 s for the launcher,
// so it can end before the board).
const descendantBoards = (processes, rootPid) => {
  const children = new Map();
  for (const { ProcessId: pid, ParentProcessId: parent } of processes) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const below = new Set([rootPid]);
  for (const pid of below) for (const child of children.get(pid) ?? []) below.add(child);
  return processes.filter(({ ProcessId: pid, CommandLine: line }) => pid !== rootPid && below.has(pid) && String(line ?? '').includes('asb-board.py'))
    .map(({ ProcessId: pid }) => pid);
};
// One read of all processes. An unreadable list throws, so that no check passes because the finder saw nothing.
const boardPids = (rootPid) => descendantBoards(JSON.parse(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine)'],
{ encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).stdout), rootPid);
// The boards that are still below the root after up to 25 s (the 2 s PID check, the 20 s reconnect wait, and cleanup).
async function boardsLeft(rootPid) {
  let left = boardPids(rootPid);
  for (const deadline = Date.now() + 25_000; left.length && Date.now() < deadline;) { await delay(500); left = boardPids(rootPid); }
  return left;
}

// Not skipped: the tree walk needs no Windows. The list is a synthetic process list.
test('the board finder returns only the boards below the root, also from a root that has ended, and never another ASB', () => {
  const board = 'C:\\msys64\\ucrt64\\bin\\python.exe C:\\asb\\scripts\\asb-board.py -';
  const list = [
    { ProcessId: 0, ParentProcessId: 0, CommandLine: null },
    // The root 5 has ended: it is not in the list, but its child, the launcher, names it. A helper is between the launcher and a second board.
    { ProcessId: 10, ParentProcessId: 5, CommandLine: 'node.exe C:\\asb\\scripts\\asb.mjs' },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: board },
    { ProcessId: 12, ParentProcessId: 10, CommandLine: 'helper.exe' },
    { ProcessId: 13, ParentProcessId: 12, CommandLine: board },
    // Another ASB (the user's own) has the same board command line and other ancestors. A process with no command line is no board.
    { ProcessId: 20, ParentProcessId: 1, CommandLine: 'node.exe C:\\asb\\scripts\\asb.mjs' },
    { ProcessId: 21, ParentProcessId: 20, CommandLine: board },
    { ProcessId: 22, ParentProcessId: 10, CommandLine: null },
    // A PID that is its own parent must not loop.
    { ProcessId: 30, ParentProcessId: 30, CommandLine: board },
  ];
  assert.deepEqual(descendantBoards(list, 5), [11, 13]);
  assert.deepEqual(descendantBoards(list, 10), [11, 13]);
  assert.deepEqual(descendantBoards(list, 12), [13]);
  assert.deepEqual(descendantBoards(list, 11), []);
  assert.deepEqual(descendantBoards(list, 20), [21]);
  assert.deepEqual(descendantBoards(list, 30), []);
  assert.deepEqual(descendantBoards(list, 99), []);
  assert.deepEqual(descendantBoards([], 5), []);
});

test('the board opens its window against an engine and closes after the reconnect timeout, and the Start menu command opens it too', {
  skip: process.platform === 'win32' && process.env.ASB_BOARD_SMOKE === '1' ? false
    : 'Windows with MSYS2 GTK in a desktop session: set ASB_BOARD_SMOKE=1 (and ASB_PYTHON)',
  timeout: 300_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-board-smoke-'));
  const children = [];
  const roots = [];
  // On Windows, child.kill() ends only that process, so taskkill /t also ends the board that a failed run leaves. The launcher that the
  // Start menu command starts is not a child of this test, so its board is found by ancestry from the PowerShell process that the test
  // starts for the command (the root); the launcher then ends too. No other board is touched, also not the board of the user's own ASB.
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    }
    for (const root of roots) for (const pid of boardPids(root)) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const local = path.join(directory, 'local');
  const image = path.join(directory, 'board.png');
  const script = path.join(directory, 'fake-engine.mjs');
  await writeFile(script, fakeEngine(path.join(local, 'asb', 'run', 'service.json'), 'ab'.repeat(32)));

  // Each fake engine writes the runtime file of the launcher, so it replaces the engine before it.
  const startEngine = async () => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    children.push(child);
    const [line] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => [''])]);
    assert.match(String(line), /ready/, 'The fake engine did not start.');
    // Without a running engine, the launcher would start the real tray, so the test checks the launcher's own lookup first.
    const runtime = await findRunningService({ LOCALAPPDATA: local }, 'win32');
    assert.equal(runtime?.pid, child.pid, 'The launcher cannot find the fake engine.');
    return { child };
  };
  const environment = (file) => ({ ...process.env, LOCALAPPDATA: local, APPDATA: path.join(directory, 'roaming'), ASB_SNAPSHOT: file });
  const saved = async (file) => (await stat(file).catch(() => null))?.size > 0;

  const { child: engine } = await startEngine();
  const launcher = spawn(process.execPath, [asb], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: environment(image) });
  children.push(launcher);
  roots.push(launcher.pid);
  let output = '';
  launcher.stdout.on('data', (chunk) => { output += `[stdout] ${chunk}`; });
  launcher.stderr.on('data', (chunk) => { output += `[stderr] ${chunk}`; });
  const exited = new Promise((resolve) => launcher.once('exit', (code, signal) => resolve({ code, signal })));

  for (const deadline = Date.now() + 90_000; !(await saved(image)) && launcher.exitCode === null && Date.now() < deadline;) await delay(250);
  assert.ok(await saved(image), `The board saved no window image.\n${output}`);
  // The board is a child of the launcher. The finder must see it now, so that the check after the stop means something.
  assert.ok(boardPids(launcher.pid).length > 0, 'The test cannot find the board of the launcher.');

  // With no replacement engine, the launcher closes the board after its reconnect wait.
  engine.kill();
  const closed = await Promise.race([exited, delay(25_000, null, { ref: false })]);
  assert.deepEqual(closed, { code: 0, signal: null }, `The launcher did not exit with code 0 within 25 s after the engine stopped.\n${output}`);
  assert.deepEqual(await boardsLeft(launcher.pid), [], 'The board of the launcher did not close within 25 s after its engine stopped.');

  // The Start menu link runs this command. The tray script starts the launcher with no console and waits at most 30 s for its exit, and an
  // open board keeps the launcher running, so the test waits for the image.
  // The launcher is a child of the PowerShell process (the root), and the board is a child of the launcher.
  const startMenuImage = path.join(directory, 'board-start-menu.png');
  const { child: second } = await startEngine();
  const menu = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tray, process.execPath, '-Open'],
    { stdio: 'ignore', windowsHide: true, env: environment(startMenuImage) });
  assert.ok(menu.pid, 'The Start menu command did not start.');
  // After a failure the command can still wait for its launcher or show its message box, so the cleanup ends it too.
  children.push(menu);
  roots.push(menu.pid);
  for (const deadline = Date.now() + 90_000; !(await saved(startMenuImage)) && Date.now() < deadline;) await delay(250);
  assert.ok(await saved(startMenuImage), 'The Start menu command saved no window image.');
  assert.ok(boardPids(menu.pid).length > 0, 'The test cannot find the board of the Start menu command.');

  // The launcher that the command started also closes its board after the reconnect wait.
  second.kill();
  assert.deepEqual(await boardsLeft(menu.pid), [], 'The board of the Start menu command did not close within 25 s after its engine stopped.');
});
