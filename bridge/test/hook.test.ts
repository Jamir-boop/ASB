import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { Database } from 'bun:sqlite';
import { Bridge } from '../src/bridge';
import { inbox, peers, processStart, socketPath } from '../src/claude';
import { receiver as desktopReceiver } from './desktop-fixture';
import { staleReceiver } from './stale-receiver-fixture';
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

// stopped: the receiver cannot run its own close() before the hook's kill, as on Windows, where SIGTERM ends a process at once.
posix.each(['running', 'stopped'] as const)('SessionEnd with a %s receiver sends one exited idle notice and one expired notice', async receiverState => {
  const root = mkdtempSync('/tmp/uds-end-');
  const codexHome = join(root, 'codex');
  const configDir = join(root, 'claude');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  const desktop = await desktopReceiver('idle', false, false, codexHome);
  const threadId = desktop.threadId;
  const hook = async (hook_event_name: 'SessionStart' | 'SessionEnd', expectedError?: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/hook.ts')], {
      env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir, XDG_RUNTIME_DIR: root, CLAUDE_CODE_TMPDIR: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ session_id: threadId, cwd: root, hook_event_name }));
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expectedError) expect({ code, err }).toEqual({ code: 1, err: `${expectedError}\n` });
    else expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
  };
  // Two agents with an inbox each: one sends a held message, the other waits for an idle notice.
  const agents: { frames: Record<string, unknown>[]; address: string; close: () => Promise<void> }[] = [];
  for (const name of ['held', 'waiting']) {
    const folder = join(root, name);
    mkdirSync(folder, { mode: 0o700 });
    const child = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    const frames: Record<string, unknown>[] = [];
    const box = await inbox(folder, frame => { frames.push(frame as Record<string, unknown>); }, `${child.pid}.sock`);
    writeFileSync(join(configDir, 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: randomUUID(),
      messagingSocketPath: socketPath(box.address), cwd: '/tmp', peerProtocol: 1, peerFeatures: ['notify_idle'],
      procStart: await processStart(child.pid) }), { mode: 0o600 });
    agents.push({ frames, address: box.address, close: async () => { await box.close(); child.kill(); } });
  }
  const [heldAgent, waitingAgent] = agents as [typeof agents[0], typeof agents[0]];
  const transmit = async (from: string, frame: Record<string, unknown>) => {
    const path = peers(configDir).find(peer => peer.sessionId === threadId)?.messagingSocketPath;
    if (!path) throw new Error('No receiver');
    const socket = net.createConnection(path);
    await once(socket, 'connect');
    socket.end(JSON.stringify({ msgV: 1, from, ...frame }) + '\n');
    await once(socket, 'close');
  };
  const db = () => new Database(join(codexHome, 'plugin-state', 'asb-bridge', `${threadId}.sqlite`));
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(10);
    expect(condition()).toBe(true);
  };
  try {
    await hook('SessionStart');
    const state = db();
    try {
      state.run("UPDATE inbound_policy SET policy='hold' WHERE singleton=1");
      const messageId = randomUUID();
      await transmit(heldAgent.address, { type: 'user', msg_id: messageId, session_id: threadId,
        message: { role: 'user', content: '<cross-session-message from-mode="prompting">hello</cross-session-message>' } });
      await until(() => state.query("SELECT 1 FROM messages WHERE id=? AND status='held'").get(messageId) !== null);
      const subscription = randomUUID();
      await transmit(waitingAgent.address, { type: 'control', action: 'notify_when_idle', msg_id: subscription, from_mode: 'prompting' });
      await until(() => state.query("SELECT 1 FROM idle_requests WHERE id=? AND status='waiting'").get(subscription) !== null);
      const notices = (frames: Record<string, unknown>[], action: string) => frames.filter(frame => frame.action === action);
      const receiverPid = peers(configDir).find(peer => peer.sessionId === threadId)?.pid;
      if (!receiverPid) throw new Error('No receiver');
      if (receiverState === 'stopped') {
        process.kill(receiverPid, 'SIGSTOP');
        await hook('SessionEnd', 'Receiver did not stop');
        // The hook alone sent the notices; the receiver's close() runs after SIGCONT and must not repeat them.
        await until(() => notices(waitingAgent.frames, 'peer_idle_notice').length === 1
          && notices(heldAgent.frames, 'peer_message_status').length === 2);
        process.kill(receiverPid, 'SIGCONT');
        await until(() => !peers(configDir).some(peer => peer.sessionId === threadId));
      } else await hook('SessionEnd');
      expect(peers(configDir).some(peer => peer.sessionId === threadId)).toBe(false);
      await Bun.sleep(200);
      expect(notices(waitingAgent.frames, 'peer_idle_notice')).toHaveLength(1);
      expect(notices(waitingAgent.frames, 'peer_idle_notice')[0]).toMatchObject({ orig_msg_id: subscription, state: 'exited' });
      // The held receipt came at once; the end adds exactly one expired notice.
      expect(notices(heldAgent.frames, 'peer_message_status').map(frame => [frame.orig_msg_id, frame.status]))
        .toEqual([[messageId, 'held'], [messageId, 'expired']]);
      expect(notices(heldAgent.frames, 'peer_idle_notice')).toHaveLength(0);
      expect(notices(waitingAgent.frames, 'peer_message_status')).toHaveLength(0);
    } finally { state.close(); }
  } finally {
    for (const peer of peers(configDir)) if (peer.sessionId === threadId) { process.kill(peer.pid, 'SIGTERM'); process.kill(peer.pid, 'SIGCONT'); }
    for (const agent of agents) await agent.close();
    await desktop.close(false);
    rmSync(root, { recursive: true });
  }
}, 15000);

// A fake session: a live placeholder process, a private socket in its own folder, and its registry row.
async function fakeSession(configDir: string, folder: string, entrypoint?: string) {
  mkdirSync(folder, { mode: 0o700 });
  // macOS has cat only in /bin, so the placeholder comes from PATH.
  const child = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
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

// SessionStart for a task whose registry row and database row name a dead receiver, while an unrelated process has the PID.
async function startOverStaleRow(procStart?: string) {
  const root = mkdtempSync('/tmp/uds-stale-');
  const configDir = join(root, 'claude');
  const stateDir = join(root, 'plugin-state', 'asb-bridge');
  const databasePath = (id: string) => join(stateDir, `${id}.sqlite`);
  const desktop = await desktopReceiver('idle', false, false, root);
  const stale = await staleReceiver(configDir, join(root, 'old'), desktop.threadId, procStart);
  const rows = () => peers(configDir).filter(peer => peer.sessionId === desktop.threadId && peer.entrypoint === 'codex-asb-bridge').map(peer => peer.pid);
  try {
    // The receiver table of the dead receiver, as a crash leaves it.
    await new Bridge(desktop.threadId, configDir, stateDir, desktop.path).close();
    const seed = new Database(databasePath(desktop.threadId));
    try { seed.run('INSERT INTO receiver VALUES (1,?,?)', [stale.pid, 'a previous process with this PID']); }
    finally { seed.close(); }
    const child = Bun.spawn([process.execPath, process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts')], {
      env: { ...process.env, CODEX_HOME: root, CLAUDE_CONFIG_DIR: configDir, XDG_RUNTIME_DIR: root, CLAUDE_CODE_TMPDIR: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ session_id: desktop.threadId, cwd: root, hook_event_name: 'SessionStart' }));
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const after = new Database(databasePath(desktop.threadId), { readonly: true });
    try {
      return { code, out, err, stalePid: stale.pid, rows: rows(), oldRow: existsSync(stale.row), oldKey: existsSync(stale.key), alive: stale.alive(),
        databasePid: after.query<{ pid: number }, []>('SELECT pid FROM receiver WHERE singleton=1').get()?.pid };
    } finally { after.close(); }
  } finally {
    const pids = rows().filter(pid => pid !== stale.pid);
    for (const pid of pids) process.kill(pid, 'SIGTERM');
    const running = (pid: number) => { try { return process.kill(pid, 0); } catch { return false; } };
    // A receiver removes its row before it closes its SQLite file, so wait for the processes before the root goes.
    for (const deadline = Date.now() + 3000; pids.some(running) && Date.now() < deadline;) await Bun.sleep(10);
    await stale.close();
    await desktop.close();
  }
}

posix('SessionStart removes the row and key file of a dead receiver whose PID another process has, and starts a new receiver', async () => {
  const result = await startOverStaleRow('a previous process with this PID');
  expect({ code: result.code, out: result.out, err: result.err }).toEqual({ code: 0, out: '', err: '' });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).not.toBe(result.stalePid);
  expect(result.databasePid).toBe(result.rows[0]);
  expect([result.oldRow, result.oldKey]).toEqual([false, false]);
  // The other process is never signaled.
  expect(result.alive).toBe(true);
}, 15000);

posix('SessionStart still fails for a receiver row with no start time, and keeps its row, key file and process', async () => {
  const result = await startOverStaleRow(undefined);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain('Receiver process identity changed');
  expect(result.rows).toEqual([result.stalePid]);
  expect([result.oldRow, result.oldKey, result.alive]).toEqual([true, true, true]);
}, 15000);
