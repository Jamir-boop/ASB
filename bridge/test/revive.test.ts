import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import net from 'node:net';
import { once } from 'node:events';
import { peers } from '../src/claude';
import { Bridge } from '../src/bridge';
import { appServer } from './app-server-fixture';
import { receiver as desktopReceiver } from './desktop-fixture';
import type { Target } from '../src/codex';
// POSIX only on Windows CI: Unix socket files, /tmp, and signals.
const posix = test.skipIf(process.platform === 'win32');

function previousReceiver(root: string, threadId: string, target: Target, endedAt?: number) {
  const stateDir = join(root, 'plugin-state', 'asb-bridge');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(stateDir, `${threadId}.sqlite`));
  try {
    db.exec(`CREATE TABLE transport (singleton INTEGER PRIMARY KEY,kind TEXT,path TEXT);
      CREATE TABLE lifecycle (singleton INTEGER PRIMARY KEY,generation TEXT,active INTEGER${endedAt === undefined ? '' : ',ended_at INTEGER'});`);
    db.run('INSERT INTO transport VALUES (1,?,?)', [target.kind, target.path]);
    db.run(`INSERT INTO lifecycle VALUES (1,?,0${endedAt === undefined ? '' : ',?'} )`,
      endedAt === undefined ? [randomUUID()] : [randomUUID(), endedAt]);
  } finally { db.close(); }
}

async function revive(root: string) {
  const child = Bun.spawn([process.execPath, process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts'), '--revive'],
    { env: { ...process.env, CODEX_HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), XDG_RUNTIME_DIR: root },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
}

async function stopReceivers(root: string) {
  const configDir = join(root, 'claude');
  const pids = peers(configDir).map(peer => peer.pid);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 3000;
  // A receiver removes its row before it closes its SQLite file, so wait for the processes before the test removes root.
  while ((peers(configDir).length || pids.some(alive)) && Date.now() < deadline) await Bun.sleep(10);
  expect(peers(configDir)).toHaveLength(0);
}

async function desktopThreads(codexHome: string, cwd = codexHome) {
  const ipcPath = join(codexHome, 'ipc', 'ipc.sock');
  mkdirSync(join(codexHome, 'ipc'), { recursive: true, mode: 0o700 });
  const owned = new Set<string>();
  const requests: { method: string; params: { conversationId?: string; following?: boolean } }[] = [];
  const clients = new Set<net.Socket>();
  const desktop = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const write = (packet: unknown) => {
      const body = Buffer.from(JSON.stringify(packet));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      socket.write(frame);
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE();
        const request = JSON.parse(buffer.subarray(4, length + 4).toString());
        requests.push(request);
        buffer = buffer.subarray(length + 4);
        if (request.method === 'thread-stream-following-changed') {
          if (request.params.following) write({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
            params: { conversationId: request.params.conversationId, change: { type: 'snapshot',
              conversationState: { cwd, threadRuntimeStatus: { type: 'idle' }, currentPermissions: { approvalPolicy: 'on-request' } } } } });
        } else if (request.method === 'thread-owner-discovery' && !owned.has(request.params.conversationId)) {
          write({ type: 'response', requestId: request.requestId, resultType: 'error', error: 'no-client-found' });
        } else write({ type: 'response', requestId: request.requestId, handledByClientId: 'owner', resultType: 'success',
          result: request.method === 'initialize' ? { clientId: randomUUID() } : { supportsUntrustedAppInput: true } });
      }
    });
  });
  desktop.listen(ipcPath);
  await once(desktop, 'listening');
  chmodSync(ipcPath, 0o600);
  return { ipcPath, owned, requests, clients, desktop };
}

posix('a restart revives receivers of registered threads only, and concurrent starters leave one receiver', async () => {
  const root = mkdtempSync('/tmp/uds-revive-');
  const codexHome = join(root, 'codex');
  const configDir = join(root, 'claude');
  const stateDir = join(codexHome, 'plugin-state', 'asb-bridge');
  const { ipcPath, owned, clients, desktop } = await desktopThreads(codexHome, root);
  const run = async (args: string[], stdin?: unknown) => {
    const entrypoint = process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts');
    const child = Bun.spawn([process.execPath, entrypoint, ...args], {
      env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir, XDG_RUNTIME_DIR: root, CLAUDE_CODE_TMPDIR: root },
      stdin: stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    if (stdin !== undefined && child.stdin) { child.stdin.write(JSON.stringify(stdin)); child.stdin.end(); }
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };
  const ok = { code: 0, out: '', err: '' };
  const hook = (id: string, hook_event_name: 'SessionStart' | 'SessionEnd') => run([], { session_id: id, cwd: root, hook_event_name });
  const revive = () => run(['--revive']);
  const live = (id: string) => peers(configDir).filter(peer => peer.sessionId === id);
  const active = (id: string) => {
    const db = new Database(join(stateDir, `${id}.sqlite`), { readonly: true });
    // A receiver that just stopped can still hold the lock while it closes its database (SQLITE_BUSY on the macOS runner).
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      return db.query<{ active: number }, []>('SELECT active FROM lifecycle WHERE singleton=1').get()?.active;
    } finally { db.close(); }
  };
  const registered = randomUUID();
  const neverStarted = randomUUID();
  const unowned = randomUUID();
  try {
    for (const id of [registered, neverStarted, unowned]) owned.add(id);
    for (const id of [registered, unowned]) {
      expect(await hook(id, 'SessionStart')).toEqual(ok);
      expect(await hook(id, 'SessionEnd')).toEqual(ok);
      expect(live(id)).toHaveLength(0);
      expect(active(id)).toBe(0);
    }
    // A lifecycle row without a transport row: no receiver ever started for this thread.
    const state = new Bridge(neverStarted, configDir, stateDir, ipcPath);
    state.beginSession();
    state.endSession();
    await state.close();
    owned.delete(unowned);

    expect(await revive()).toEqual(ok);
    expect(live(registered)).toHaveLength(1);
    expect(live(registered)[0]?.cwd).toBe(root);
    expect(active(registered)).toBe(1);
    expect(live(neverStarted)).toHaveLength(0);
    expect(active(neverStarted)).toBe(0);
    expect(live(unowned)).toHaveLength(0);
    expect(active(unowned)).toBe(0);

    // A live receiver is left alone.
    const first = live(registered)[0];
    expect(await revive()).toEqual(ok);
    expect(live(registered).map(peer => peer.pid)).toEqual([first!.pid]);

    for (let round = 0; round < 3; round++) {
      expect(await hook(registered, 'SessionEnd')).toEqual(ok);
      expect(await Promise.all([revive(), revive()])).toEqual([ok, ok]);
      expect(live(registered)).toHaveLength(1);
      expect(active(registered)).toBe(1);

      expect(await hook(registered, 'SessionEnd')).toEqual(ok);
      expect(await Promise.all([revive(), hook(registered, 'SessionStart')])).toEqual([ok, ok]);
      expect(live(registered)).toHaveLength(1);
      expect(active(registered)).toBe(1);
    }
    expect(peers(configDir)).toHaveLength(1);
  } finally {
    for (const peer of peers(configDir)) process.kill(peer.pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (peers(configDir).length > 0 && Date.now() < deadline) await Bun.sleep(10);
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => desktop.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
}, 30000);

posix('one loaded-thread query revives one old-schema receiver without probing earlier unloaded threads', async () => {
  const server = await appServer(mkdtempSync(join(tmpdir(), 'rv-app-')));
  const earlier = Array.from({ length: 50 }, () => randomUUID());
  try {
    for (const id of [server.threadId, ...earlier]) previousReceiver(server.root, id, { kind: 'app-server', path: server.path });
    await revive(server.root);
    expect(peers(join(server.root, 'claude')).map(peer => peer.sessionId)).toEqual([server.threadId]);
    expect(server.requests.filter(request => request.method === 'thread/loaded/list')).toHaveLength(1);
    expect(server.requests.filter(request => request.params.threadId).every(request => request.params.threadId === server.threadId)).toBe(true);
    expect(readdirSync(join(server.root, 'plugin-state', 'asb-bridge')).filter(file => file.endsWith('.sqlite'))).toHaveLength(51);
  } finally { await stopReceivers(server.root); await server.close(); }
});

posix('a loaded daemon list also permits a recent desktop receiver without probing other old receivers', async () => {
  const server = await appServer(mkdtempSync(join(tmpdir(), 'rv-mixed-')));
  const desktop = await desktopReceiver('idle', false, false, server.root);
  try {
    previousReceiver(server.root, server.threadId, { kind: 'app-server', path: server.path });
    previousReceiver(server.root, desktop.threadId, { kind: 'desktop', path: desktop.path }, Date.now());
    for (let i = 0; i < 20; i++) previousReceiver(server.root, randomUUID(), { kind: 'desktop', path: desktop.path }, 1);
    await revive(server.root);
    expect(peers(join(server.root, 'claude')).map(peer => peer.sessionId).sort()).toEqual([server.threadId, desktop.threadId].sort());
    expect(server.requests.filter(request => request.method === 'thread/loaded/list')).toHaveLength(1);
    expect(server.requests.filter(request => request.params.threadId).every(request =>
      request.params.threadId === server.threadId || request.params.threadId === desktop.threadId)).toBe(true);
    expect(desktop.requests.filter(request => request.method === 'thread-owner-discovery').every(request =>
      (request.params as { conversationId: string }).conversationId === desktop.threadId)).toBe(true);
  } finally { await stopReceivers(server.root); await desktop.close(false); await server.close(); }
});

posix('a new sweep revives three threads from an old shutdown burst with no app-server socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rv-burst-'));
  const fake = await desktopThreads(root);
  const burst = Date.UTC(2021, 0, 1);
  const threads = Array.from({ length: 3 }, () => randomUUID());
  const old = randomUUID();
  const legacy = randomUUID();
  try {
    mkdirSync(join(root, 'app-server-control'), { mode: 0o700 });
    for (const [index, id] of threads.entries()) previousReceiver(root, id, { kind: 'desktop', path: fake.ipcPath }, burst - index * 1000);
    previousReceiver(root, old, { kind: 'desktop', path: fake.ipcPath }, burst - 600000);
    previousReceiver(root, legacy, { kind: 'desktop', path: fake.ipcPath });
    for (const id of [...threads, old, legacy]) fake.owned.add(id);
    await revive(root);
    expect(peers(join(root, 'claude')).map(peer => peer.sessionId).sort()).toEqual(threads.sort());
    expect(new Set(fake.requests.filter(request => request.method === 'thread-owner-discovery')
      .map(request => request.params.conversationId))).toEqual(new Set(threads));
    expect(readdirSync(join(root, 'plugin-state', 'asb-bridge')).filter(file => file.endsWith('.sqlite'))).toHaveLength(5);
  } finally {
    await stopReceivers(root);
    for (const socket of fake.clients) socket.destroy();
    await new Promise<void>(resolve => fake.desktop.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
});

posix('a generic loaded-list error still permits bounded desktop recovery', async () => {
  const server = await appServer(mkdtempSync(join(tmpdir(), 'rv-list-error-')));
  const desktop = await desktopReceiver('idle', false, false, server.root);
  try {
    server.failLoadedList();
    server.setLoaded(false);
    const burst = Date.UTC(2021, 0, 1);
    previousReceiver(server.root, desktop.threadId, { kind: 'desktop', path: desktop.path }, burst);
    previousReceiver(server.root, randomUUID(), { kind: 'desktop', path: desktop.path }, burst - 600000);
    await revive(server.root);
    expect(peers(join(server.root, 'claude')).map(peer => peer.sessionId)).toEqual([desktop.threadId]);
    expect(server.requests.filter(request => request.method === 'thread/loaded/list')).toHaveLength(1);
    expect(desktop.requests.filter(request => request.method === 'thread-owner-discovery').every(request =>
      (request.params as { conversationId: string }).conversationId === desktop.threadId)).toBe(true);
  } finally { await stopReceivers(server.root); await desktop.close(false); await server.close(); }
});

posix('the desktop end burst includes its 30-second boundary and ignores invalid timestamps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rv-boundary-'));
  const desktop = await desktopReceiver('idle', false, false, root);
  const burst = Date.UTC(2021, 0, 1);
  const stateDir = join(root, 'plugin-state', 'asb-bridge');
  try {
    previousReceiver(root, desktop.threadId, { kind: 'desktop', path: desktop.path }, burst - 30000);
    previousReceiver(root, randomUUID(), { kind: 'desktop', path: desktop.path }, burst - 30001);
    for (const invalid of [0, -1, Date.now() + 60000, burst + 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      previousReceiver(root, randomUUID(), { kind: 'desktop', path: desktop.path }, invalid);
    }
    // A valid end in the same home sets the burst even when that state has no earlier receiver.
    const anchorId = randomUUID();
    const anchor = new Bridge(anchorId, join(root, 'claude'), stateDir, desktop.path);
    try { anchor.endSession(); } finally { await anchor.close(); }
    const db = new Database(join(stateDir, `${anchorId}.sqlite`));
    try { db.run('UPDATE lifecycle SET ended_at=? WHERE singleton=1', [burst]); }
    finally { db.close(); }
    await revive(root);
    expect(peers(join(root, 'claude')).map(peer => peer.sessionId)).toEqual([desktop.threadId]);
    expect(desktop.requests.filter(request => request.method === 'thread-owner-discovery').every(request =>
      (request.params as { conversationId: string }).conversationId === desktop.threadId)).toBe(true);
  } finally { await stopReceivers(root); await desktop.close(); }
});

posix('desktop revival skips old state and keeps the last end marker for retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rv-desktop-'));
  const desktop = await desktopReceiver('idle', false, false, root);
  const stateDir = join(root, 'plugin-state', 'asb-bridge');
  const state = new Bridge(desktop.threadId, join(root, 'claude'), stateDir, desktop.path);
  try {
    state.setTarget({ kind: 'desktop', path: desktop.path });
    state.beginSession();
    state.endSession();
    const db = new Database(join(stateDir, `${desktop.threadId}.sqlite`), { readonly: true });
    try {
      const endedAt = db.query<{ ended_at: number }, []>('SELECT ended_at FROM lifecycle').get()!.ended_at;
      state.beginSession();
      expect(db.query<{ ended_at: number }, []>('SELECT ended_at FROM lifecycle').get()!.ended_at).toBe(endedAt);
    } finally { db.close(); }
    for (let i = 0; i < 30; i++) previousReceiver(root, randomUUID(), { kind: 'desktop', path: desktop.path }, Date.now() - 600000);
    previousReceiver(root, randomUUID(), { kind: 'desktop', path: desktop.path });
    await revive(root);
    expect(peers(join(root, 'claude')).map(peer => peer.sessionId)).toEqual([desktop.threadId]);
    expect(desktop.requests.filter(request => request.method === 'thread-owner-discovery').every(request =>
      (request.params as { conversationId: string }).conversationId === desktop.threadId)).toBe(true);
  } finally { await state.close(); await stopReceivers(root); await desktop.close(); }
});

for (const method of ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed']) {
  posix(`desktop revival closes a probe stalled at ${method} within the total deadline`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-timeout-'));
    const desktop = await desktopReceiver('idle', false, false, root);
    try {
      desktop.stallAt(method);
      previousReceiver(root, desktop.threadId, { kind: 'desktop', path: desktop.path }, Date.now());
      const start = performance.now();
      await revive(root);
      expect(performance.now() - start).toBeLessThan(3000);
      expect(peers(join(root, 'claude'))).toHaveLength(0);
      const deadline = Date.now() + 500;
      while (desktop.connections() && Date.now() < deadline) await Bun.sleep(10);
      expect(desktop.connections()).toBe(0);
      expect(desktop.requests.filter(request => request.type === 'request').every(request => request.timeoutMs === 1000)).toBe(true);
    } finally { await desktop.close(); }
  });
}
