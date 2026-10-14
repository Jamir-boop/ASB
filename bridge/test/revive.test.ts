import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import net from 'node:net';
import { once } from 'node:events';
import { peers } from '../src/claude';
import { Bridge } from '../src/bridge';

test('a restart revives receivers of registered threads only, and concurrent starters leave one receiver', async () => {
  const root = mkdtempSync('/tmp/uds-revive-');
  const codexHome = join(root, 'codex');
  const configDir = join(root, 'claude');
  const stateDir = join(codexHome, 'plugin-state', 'claude-uds-bridge');
  const ipcPath = join(codexHome, 'ipc', 'ipc.sock');
  mkdirSync(join(codexHome, 'ipc'), { recursive: true, mode: 0o700 });
  const owned = new Set<string>();
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
        buffer = buffer.subarray(length + 4);
        if (request.method === 'thread-stream-following-changed') {
          if (request.params.following) write({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
            params: { conversationId: request.params.conversationId, change: { type: 'snapshot',
              conversationState: { cwd: root, threadRuntimeStatus: { type: 'idle' }, currentPermissions: { approvalPolicy: 'on-request' } } } } });
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
    try { return db.query<{ active: number }, []>('SELECT active FROM lifecycle WHERE singleton=1').get()?.active; }
    finally { db.close(); }
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
