import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AGY_FOCUS_ERROR, agyFocusTarget, focusAgyInKitty, loadAntigravityDashboard } from '../src/antigravity-data.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { createSwitchboardServer, loadSwitchboardDashboard } from '../src/switchboard.mjs';

// Made-up data only. The only kitty here is a stub script on a temp PATH; no real kitty gets a command.
const now = Date.now();
const TOKEN = 'c'.repeat(64);
const id = (n) => `${String(n).padStart(8, '0')}-b221-41ba-96c9-1c571ac0565b`;

// A fake /proc: each entry is pid -> [comm, ppid, state].
async function fakeProc(t, entries) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-proc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [pid, [comm, ppid, state = 'S']] of Object.entries(entries)) {
    await mkdir(path.join(dir, pid));
    await writeFile(path.join(dir, pid, 'stat'), `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 4377321 0\n`);
  }
  return dir;
}

const record = (fields = {}) => ({ conversationId: id(1), workspace: '/work/ws', state: 'idle', stateAtMs: now - 1000, createdAtMs: now - 5000,
  agyPid: 400, agyStartTicks: '4377321', kittyWindowId: '1', kittyPid: '200', kittyListenOn: 'unix:@kitty-200', ...fields });

test('rule 2: only a live kitty of this user that is an ancestor of agy, with a checked socket, can focus', async (t) => {
  const procDir = await fakeProc(t, { 400: ['agy', 300], 300: ['bash', 200], 200: ['kitty', 1], 201: ['bash', 1], 202: ['kitty', 1, 'Z'] });
  const target = (fields) => agyFocusTarget(record(fields), { procDir });
  assert.deepEqual(await target(), { listenOn: 'unix:@kitty-200', windowId: '1' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-sock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 'kitty.sock');
  const server = net.createServer().listen(socket);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  assert.deepEqual(await target({ kittyListenOn: `unix:${socket}` }), { listenOn: `unix:${socket}`, windowId: '1' });
  await writeFile(path.join(dir, 'plain'), '');
  const cases = {
    'dead kitty': { kittyPid: '209', kittyListenOn: 'unix:@kitty-209' },
    'wrong comm': { kittyPid: '201', kittyListenOn: 'unix:@kitty-201' },
    'zombie kitty': { kittyPid: '202', kittyListenOn: 'unix:@kitty-202' },
    'not a socket': { kittyListenOn: `unix:${path.join(dir, 'plain')}` },
    'no file': { kittyListenOn: `unix:${path.join(dir, 'none')}` },
    'abstract name without the PID': { kittyListenOn: 'unix:@kitty-999' },
    'abstract name with a longer PID': { kittyListenOn: 'unix:@kitty-2000' },
    'non-digit window ID': { kittyWindowId: '1a' },
    'no window ID': { kittyWindowId: undefined },
    'non-digit kitty PID': { kittyPid: '20x' },
    'leading dash': { kittyListenOn: '-unix:@kitty-200' },
    'control character': { kittyListenOn: 'unix:@kitty-200\n' },
  };
  for (const [name, fields] of Object.entries(cases)) assert.equal(await target(fields), null, name);
  // A socket of another user (root's system bus here, when this system has one).
  const rootSocket = '/run/dbus/system_bus_socket';
  if (process.getuid() !== 0 && existsSync(rootSocket)) {
    assert.equal(await target({ kittyListenOn: `unix:${rootSocket}` }), null);
  }
});

test('rule 2: a kitty that is not an ancestor, or one more than 8 levels up, cannot focus', async (t) => {
  // Kitty 200 is the 9th parent of agy 400 (301 to 308 between); kitty 210 is the 8th parent of agy 502 (511 to 517 between).
  const chain = { 400: ['agy', 301], 200: ['kitty', 1], 210: ['kitty', 1], 220: ['kitty', 1], 600: ['agy', 1], 502: ['agy', 511] };
  for (let n = 301; n <= 308; n++) chain[n] = ['sh', n === 308 ? 200 : n + 1];
  for (let n = 511; n <= 517; n++) chain[n] = ['sh', n === 517 ? 210 : n + 1];
  const procDir = await fakeProc(t, chain);
  const target = (fields) => agyFocusTarget(record(fields), { procDir });
  assert.equal(await target({ agyPid: 400 }), null, '9 levels');
  assert.equal(await target({ agyPid: 600 }), null, 'not an ancestor');
  assert.equal(await target({ agyPid: 600, kittyPid: '220', kittyListenOn: 'unix:@kitty-220' }), null, 'another kitty');
  assert.notEqual(await target({ agyPid: 502, kittyPid: '210', kittyListenOn: 'unix:@kitty-210' }), null, '8 levels');
});

test('the loader gives canFocus only to a live record that passes rule 2, and no kitty field', async (t) => {
  const procDir = await fakeProc(t, { 400: ['agy', 200], 200: ['kitty', 1] });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-focus-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const put = (n, fields) => writeFile(path.join(dataDir, `${id(n)}.json`), JSON.stringify(record({ conversationId: id(n), workspace: dataDir, ...fields })),
    { mode: 0o600 });
  await put(1, {});
  await put(2, { agyStartTicks: '999' });
  await put(3, { kittyListenOn: 'unix:@kitty-77' });
  await put(4, { kittyWindowId: undefined });
  const { threads } = await loadAntigravityDashboard({ dataDir, nowMs: now, procDir, startOf: async (pid) => (pid === 400 ? '4377321' : null) });
  const byId = Object.fromEntries(threads.map((thread) => [thread.externalId, thread]));
  assert.deepEqual([id(1), id(2), id(3), id(4)].map((key) => byId[key]?.canFocus), [true, undefined, undefined, undefined]);
  for (const thread of threads) assert.equal(Object.keys(thread).some((key) => key.startsWith('kitty')), false);
});

// A stub `kitty`: with `@` it logs its argv and acts on the mode file; else it runs its arguments as a child (an agy under a shell).
async function stubKitty(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-kitty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const log = path.join(dir, 'argv.log');
  const mode = path.join(dir, 'mode');
  await writeFile(path.join(bin, 'kitty'), `#!/bin/sh
if [ "$1" = "@" ]; then
  printf '%s\\n' "$@" > '${log}'
  case "$(cat '${mode}' 2>/dev/null)" in fail) exit 3 ;; sleep) exec sleep 10 ;; esac
  exit 0
fi
"$@"
exit $?
`);
  await chmod(path.join(bin, 'kitty'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  // The made-up session: kitty -> sh -> sleep (the agy PID).
  let agy = 0;
  const kitty = spawn(path.join(bin, 'kitty'), ['sh', '-c', 'sleep 60; :'], { stdio: 'ignore' });
  t.after(() => { for (const pid of [agy, kitty.pid]) try { if (pid) process.kill(pid, 'SIGKILL'); } catch {} });
  for (let i = 0; i < 100 && !agy; i++) {
    await delay(50);
    const shell = Number((await readFile(`/proc/${kitty.pid}/task/${kitty.pid}/children`, 'utf8').catch(() => '')).trim().split(' ')[0]);
    if (shell) agy = Number((await readFile(`/proc/${shell}/task/${shell}/children`, 'utf8').catch(() => '')).trim().split(' ')[0]);
  }
  assert.ok(agy, 'the stub session started');
  return { kittyPid: kitty.pid, agy, log, mode, argv: () => readFile(log, 'utf8').then((text) => text.trim().split('\n'), () => null) };
}

test('open focuses the kitty window with the exact argv; failures give the one open error and run nothing else', async (t) => {
  const stub = await stubKitty(t);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-open-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const listenOn = `unix:@kitty-${stub.kittyPid}-synthetic`;
  const put = (fields) => writeFile(path.join(dataDir, `${id(1)}.json`), JSON.stringify(record({ workspace: dataDir, agyPid: stub.agy,
    agyStartTicks: undefined, kittyPid: String(stub.kittyPid), kittyListenOn: listenOn, kittyWindowId: '7', ...fields })), { mode: 0o600 });
  await put({ agyStartTicks: await processStart(stub.agy) });
  const open = () => focusAgyInKitty({ dataDir, id: id(1) });
  assert.deepEqual(await open(), { opened: true, method: 'antigravity-kitty-focus' });
  assert.deepEqual(await stub.argv(), ['@', '--to', listenOn, 'focus-window', '--match', 'id:7']);
  await writeFile(stub.mode, 'fail');
  await assert.rejects(open(), { message: AGY_FOCUS_ERROR });
  await writeFile(stub.mode, 'sleep');
  const started = Date.now();
  await assert.rejects(open(), { message: AGY_FOCUS_ERROR });
  assert.ok(Date.now() - started < 6000, 'the 3 s timeout');
  await writeFile(stub.mode, '');
  await rm(stub.log, { force: true });
  for (const fields of [{ kittyListenOn: '-unix:@x' }, { kittyListenOn: `unix:@kitty-${stub.kittyPid}\u001b` }, { agyStartTicks: '1' },
    { kittyListenOn: 'unix:@kitty-1' }]) {
    await put({ agyStartTicks: await processStart(stub.agy), ...fields });
    await assert.rejects(open(), { message: AGY_FOCUS_ERROR }, JSON.stringify(fields));
    assert.equal(await stub.argv(), null, JSON.stringify(fields));
  }
  await assert.rejects(focusAgyInKitty({ dataDir, id: '../x' }), { message: AGY_FOCUS_ERROR });
});

test('the engine row has canFocus and no kitty data, opens through the route, and checks rule 2 again at the open', async (t) => {
  const stub = await stubKitty(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-engine-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sources = new AppSourceRegistry({ homeDir: home, env: {}, platform: 'linux', discoverPersonal: false });
  const dataDir = (await sources.read()).find((source) => source.id === 'antigravity').dataDir;
  await mkdir(dataDir, { recursive: true });
  const listenOn = `unix:@kitty-${stub.kittyPid}-markerlisten`;
  const put = (n, fields = {}) => writeFile(path.join(dataDir, `${id(n)}.json`), JSON.stringify(record({ conversationId: id(n), workspace: home,
    stateAtMs: Date.now() - 1000, agyPid: stub.agy, kittyPid: String(stub.kittyPid), kittyListenOn: listenOn, kittyWindowId: '987654321', ...fields })),
  { mode: 0o600 });
  await put(1, { agyStartTicks: await processStart(stub.agy) });
  await put(2, { agyStartTicks: await processStart(stub.agy), kittyWindowId: undefined, kittyPid: undefined, kittyListenOn: undefined });
  const empty = async () => ({ threads: [] });
  const server = createSwitchboardServer({ sourceToken: TOKEN, pendingStatePath: false, palettePath: '', dashboardWatchPaths: [], sourceRegistry: sources,
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, loadCodex: empty, loadClaude: empty, loadOpenCode: empty }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const keys = (value) => (value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keys(item)]) : []);
  for (const query of ['', '?text=1', '?force=1&text=1']) {
    const text = await (await fetch(`${base}/api/dashboard${query}`)).text();
    for (const marker of ['987654321', 'markerlisten', `"${stub.kittyPid}"`]) assert.equal(text.includes(marker), false, `${query} ${marker}`);
    assert.equal(keys(JSON.parse(text)).some((key) => /^kitty/i.test(key)), false, query);
    const rows = Object.fromEntries(JSON.parse(text).threads.map((row) => [row.externalId, row]));
    assert.deepEqual([rows[id(1)].canFocus, rows[id(1)].canOpen, rows[id(1)].appDeepLink], [true, true, '']);
    assert.deepEqual(['canFocus' in rows[id(2)], rows[id(2)].canOpen], [false, false]);
  }
  const open = (n) => fetch(`${base}/api/threads/${encodeURIComponent(`agy:${id(n)}`)}/open`,
    { method: 'POST', headers: { origin: base, 'X-ASB-Source-Token': TOKEN, 'content-type': 'application/json' }, body: '{}' });
  let reply = await open(1);
  assert.deepEqual([reply.status, (await reply.json()).method], [200, 'antigravity-kitty-focus']);
  assert.deepEqual(await stub.argv(), ['@', '--to', listenOn, 'focus-window', '--match', 'id:987654321']);
  reply = await open(2);
  assert.equal(reply.status, 500);
  assert.equal((await reply.json()).detail, 'This session cannot open from ASB.');
  // The agy process ends after the list: the open checks again and runs nothing.
  await rm(stub.log, { force: true });
  process.kill(stub.agy, 'SIGKILL');
  for (let i = 0; i < 40 && await processStart(stub.agy); i++) await delay(50);
  reply = await open(1);
  assert.equal(reply.status, 500);
  assert.equal((await reply.json()).detail, AGY_FOCUS_ERROR);
  assert.equal(await stub.argv(), null);
});
