import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { inbox, peers, processStart, socketPath } from '../src/claude';
import { receiver as desktopReceiver } from './desktop-fixture';
// POSIX only on Windows CI: Unix socket files, /tmp, and signals.
const posix = test.skipIf(process.platform === 'win32');

posix('session hooks own one receiver per task, restore it after resume and clean up on Desktop disconnect', async () => {
  const root = mkdtempSync('/tmp/uds-life-');
  const codexHome = join(root, 'codex');
  const configDir = join(root, 'claude');
  const ipcDir = join(codexHome, 'ipc');
  mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'cc-socks'), { mode: 0o755 });
  const clients = new Set<net.Socket>();
  let pauseHandshake = false;
  let releaseHandshake: (() => void) | undefined;
  const handshakeSeen = Promise.withResolvers<void>();
  const desktop = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (buffer.length >= 4) {
      const length = buffer.readUInt32LE();
      if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      if (request.method === 'thread-stream-following-changed' && !request.params.following) continue;
      const body = Buffer.from(JSON.stringify(request.method === 'thread-stream-following-changed'
        ? { type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
          params: { conversationId: request.params.conversationId, change: { type: 'snapshot',
            conversationState: { cwd: root, threadRuntimeStatus: { type: 'idle' }, currentPermissions: { approvalPolicy: 'on-request' } } } } }
        : { type: 'response', requestId: request.requestId, handledByClientId: 'owner', resultType: 'success',
          result: request.method === 'initialize' ? { clientId: randomUUID() } : { supportsUntrustedAppInput: true } }));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      if (pauseHandshake && request.method === 'initialize') {
        releaseHandshake = () => socket.write(frame);
        handshakeSeen.resolve();
      } else socket.write(frame);
      }
    });
  });
  const ipcPath = join(ipcDir, 'ipc.sock');
  desktop.listen(ipcPath);
  await once(desktop, 'listening');
  chmodSync(ipcPath, 0o600);
  const threadId = randomUUID();
  const otherId = randomUUID();
  const hook = async (id: string, hook_event_name: 'SessionStart' | 'SessionEnd', expectedExit = 0) => {
    const entrypoint = process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts');
    const child = Bun.spawn([process.execPath, entrypoint], {
      // Both point at root, whose cc-socks is deliberately 0755, so the hook has to reject it
      // and fall back. A real XDG_RUNTIME_DIR would be private and the fallback would never run.
      env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir,
        XDG_RUNTIME_DIR: root, CLAUDE_CODE_TMPDIR: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ session_id: id, cwd: root, hook_event_name }));
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expectedExit === 0) expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
    else {
      expect(code).toBe(expectedExit);
      expect(err).toContain('Session ended or was replaced');
    }
  };
  const live = (id: string) => peers(configDir).filter(peer => peer.sessionId === id);
  try {
    await hook(threadId, 'SessionStart');
    const first = live(threadId)[0];
    expect(first).toBeDefined();
    expect(first?.cwd).toBe(root);
    expect(first?.messagingSocketPath).toStartWith(`/tmp/cc-socks-${process.getuid?.()}/`);
    await hook(threadId, 'SessionStart');
    expect(live(threadId)).toHaveLength(1);
    expect(live(threadId)[0]?.pid).toBe(first?.pid);
    await hook(otherId, 'SessionStart');
    expect(live(otherId)).toHaveLength(1);
    await hook(threadId, 'SessionEnd');
    expect(live(threadId)).toHaveLength(0);
    expect(existsSync(first!.messagingSocketPath)).toBe(false);
    expect(live(otherId)).toHaveLength(1);
    await hook(threadId, 'SessionStart');
    const crashed = live(threadId)[0];
    if (!crashed) throw new Error('Missing receiver before crash test');
    process.kill(crashed.pid, 'SIGKILL');
    const crashDeadline = Date.now() + 2000;
    while (live(threadId).length > 0 && Date.now() < crashDeadline) await Bun.sleep(10);
    await hook(threadId, 'SessionStart');
    const resumed = live(threadId)[0];
    expect(resumed?.sessionId).toBe(threadId);
    expect(resumed?.pid).not.toBe(crashed.pid);
    for (const socket of clients) socket.destroy();
    const deadline = Date.now() + 3000;
    while (peers(configDir).length > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(peers(configDir)).toHaveLength(0);
    expect(existsSync(resumed!.messagingSocketPath)).toBe(false);

    pauseHandshake = true;
    const racingId = randomUUID();
    const opening = hook(racingId, 'SessionStart', 1);
    await handshakeSeen.promise;
    await hook(racingId, 'SessionEnd');
    if (!releaseHandshake) throw new Error('Missing startup barrier');
    releaseHandshake();
    await opening;
    expect(live(racingId)).toHaveLength(0);
  } finally {
    for (const peer of peers(configDir)) process.kill(peer.pid, 'SIGTERM');
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => desktop.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
}, 15000);

// A fake session: a live placeholder process, a private socket in its own folder, and its registry row.
async function fakeSession(configDir: string, folder: string, entrypoint?: string) {
  mkdirSync(folder, { mode: 0o700 });
  const child = Bun.spawn(['/usr/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  const box = await inbox(folder, () => {}, `${child.pid}.sock`);
  writeFileSync(join(configDir, 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: randomUUID(),
    messagingSocketPath: socketPath(box.address), cwd: '/tmp', peerProtocol: 1, procStart: await processStart(child.pid),
    ...(entrypoint ? { entrypoint } : {}) }), { mode: 0o600 });
  return async () => { await box.close(); child.kill(); };
}

// The folder of the new receiver socket, relative to a root whose cc-socks folder is the fallback, when the registry already holds the given live rows.
async function receiverFolder(rows: [folder: string, entrypoint?: string][]) {
  const root = mkdtempSync('/tmp/uds-folder-');
  const configDir = join(root, 'claude');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  const desktop = await desktopReceiver('idle', false, false, root);
  const closers: (() => Promise<void>)[] = [];
  const receivers = () => peers(configDir).filter(peer => peer.sessionId === desktop.threadId);
  try {
    for (const [folder, entrypoint] of rows) closers.push(await fakeSession(configDir, join(root, folder), entrypoint));
    const child = Bun.spawn([process.execPath, process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts')], {
      env: { ...process.env, CODEX_HOME: root, CLAUDE_CONFIG_DIR: configDir, XDG_RUNTIME_DIR: root, CLAUDE_CODE_TMPDIR: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ session_id: desktop.threadId, cwd: root, hook_event_name: 'SessionStart' }));
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
    expect(receivers()).toHaveLength(1);
    return relative(root, dirname(receivers()[0]!.messagingSocketPath));
  } finally {
    const pids = receivers().map(peer => peer.pid);
    for (const pid of pids) process.kill(pid, 'SIGTERM');
    const alive = (pid: number) => { try { return process.kill(pid, 0); } catch { return false; } };
    // A receiver removes its row before it closes its SQLite file, so wait for the processes before the root goes.
    for (const deadline = Date.now() + 3000; pids.some(alive) && Date.now() < deadline;) await Bun.sleep(10);
    for (const close of closers) await close();
    await desktop.close();
  }
}

// readdirSync orders the rows as the file system likes, so the old first-row choice failed here whatever the order was.
posix('a receiver socket never goes into the folder of a relay proxy or of another receiver', async () => {
  expect(await receiverFolder([['relay', 'asb-relay'], ['other', 'codex-asb-bridge']])).toBe('cc-socks');
}, 15000);

posix('a receiver socket goes into the folder of a native Claude row, not of a relay row', async () => {
  expect(await receiverFolder([['relay', 'asb-relay'], ['claude-socks']])).toBe('claude-socks');
}, 15000);
