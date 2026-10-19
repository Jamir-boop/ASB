import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { checkSocket, findPeer, findPeerProcess, peerAddress, peers, privateDirectory, processStart, register, sendFrames, sessionName } from '../src/claude';

// The local user is the trust boundary: a sender address is not an identity. These tests bend one
// property of an otherwise valid peer and expect discovery or sending to reject it.
async function fixture(socketName = `${process.pid}.sock`) {
  const root = mkdtempSync('/tmp/uds-trust-');
  const configDir = join(root, 'claude');
  const sessions = join(configDir, 'sessions');
  const directory = join(root, 's');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const socketPath = join(directory, socketName);
  const frames: unknown[] = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        frames.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  chmodSync(socketPath, 0o600);
  const sessionId = randomUUID();
  const procStart = await processStart(process.pid);
  const write = (record: Record<string, unknown>, file = `${process.pid}.json`) =>
    writeFileSync(join(sessions, file), JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: socketPath,
      cwd: root, peerProtocol: 1, peerFeatures: [], procStart, ...record }), { mode: 0o600 });
  write({});
  const frame = { msgV: 1, type: 'user', msg_id: randomUUID(), from: 'uds:/dev/null',
    message: { role: 'user', content: 'trust probe' } };
  return { root, configDir, sessions, directory, socketPath, sessionId, procStart, write, frame, frames,
    peer: () => peers(configDir)[0],
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    } };
}

test('discovery drops a session record with a mismatched registry filename or missing socket', async () => {
  const f = await fixture();
  try {
    expect(f.peer()?.sessionId).toBe(f.sessionId);

    // A second file claiming this process would let one live session answer under two identities.
    f.write({}, '999999.json');
    expect(peers(f.configDir).map(peer => peer.sessionId)).toEqual([f.sessionId]);
    rmSync(join(f.sessions, '999999.json'));

    // A missing socket makes the registration unreachable.
    f.write({ messagingSocketPath: join(f.sessions, '..', 's', 'somebody-else.sock') });
    expect(peers(f.configDir)).toEqual([]);
  } finally { await f.close(); }
});

test('profiles share one registry through a sessions directory link for registration, names, updates, and close', async () => {
  const f = await fixture();
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.root;
  try {
    const linked = join(f.root, 'proxy');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync('../claude/sessions', join(linked, 'sessions'));
    rmSync(join(f.sessions, `${process.pid}.json`));
    const registration = await register(linked, f.sessionId, peerAddress(f.socketPath), f.root, 'idle');
    const peer = findPeer(f.configDir, f.sessionId);
    expect(peers(f.configDir)).toEqual([peer]);
    expect(peers(linked)).toEqual([peer]);
    expect(findPeerProcess(linked, peerAddress(f.socketPath), f.procStart)).toEqual(peer);
    await expect(register(f.configDir, randomUUID(), peerAddress(f.socketPath), f.root, 'idle')).rejects.toHaveProperty('code', 'EEXIST');
    writeFileSync(join(f.root, 'session_index.jsonl'), JSON.stringify({ id: f.sessionId, thread_name: 'Shared Title' }) + '\n');
    registration.update('busy');
    const updated = findPeer(linked, f.sessionId);
    expect(updated).toMatchObject({ status: 'busy', name: `codex-shared-title-${f.sessionId.slice(-2)}` });
    expect(peers(f.configDir)).toEqual([updated]);
    const other = randomUUID().slice(0, -2) + f.sessionId.slice(-2);
    writeFileSync(join(f.root, 'session_index.jsonl'), JSON.stringify({ id: other, thread_name: 'Shared Title' }) + '\n', { flag: 'a' });
    expect(sessionName(linked, f.root, other)).toBe(`codex-shared-title-${other.slice(-4)}`);
    const recordPath = join(f.sessions, `${process.pid}.json`);
    const saved = join(f.root, 'saved.json');
    renameSync(recordPath, saved);
    symlinkSync(saved, recordPath);
    expect(() => registration.update('idle')).toThrow();
    expect(() => registration.close()).toThrow();
    rmSync(recordPath);
    renameSync(saved, recordPath);
    registration.close();
    expect(peers(f.configDir)).toEqual([]);
    expect(peers(linked)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await f.close();
  }
});

test('sending through a shared registry uses its native authentication key and refuses a linked key file', async () => {
  const f = await fixture();
  try {
    const linked = join(f.root, 'proxy');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(f.sessions, join(linked, 'sessions'));
    const hash = createHash('sha256').update(f.socketPath).digest('hex');
    const keyPath = join(f.sessions, `${process.pid}.${hash}.key`);
    const token = '0123456789abcdef0123456789abcdef';
    writeFileSync(keyPath, JSON.stringify({ peerToken: token, procStart: f.procStart }), { mode: 0o600 });
    expect(await sendFrames(linked, findPeer(linked, f.sessionId), [f.frame])).toBe(true);
    expect(f.frames).toEqual([{ type: 'auth', token }, f.frame]);
    const target = join(f.root, 'key.json');
    renameSync(keyPath, target);
    symlinkSync(target, keyPath);
    await expect(sendFrames(linked, findPeer(linked, f.sessionId), [f.frame])).rejects.toHaveProperty('code', 'ELOOP');
    expect(f.frames).toHaveLength(2);
  } finally { await f.close(); }
});

test.each(['public', 'wrong owner', 'file'])('registration refuses an unsafe shared registry target: %s', async kind => {
  const f = await fixture();
  let owner: ReturnType<typeof spyOn> | undefined;
  try {
    const linked = join(f.root, 'proxy');
    mkdirSync(linked, { mode: 0o700 });
    let target = f.sessions;
    if (kind === 'public') chmodSync(target, 0o755);
    if (kind === 'file') { target = join(f.root, 'file'); writeFileSync(target, 'unchanged', { mode: 0o600 }); }
    symlinkSync(target, join(linked, 'sessions'));
    rmSync(join(f.sessions, `${process.pid}.json`));
    if (kind === 'wrong owner') owner = spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    const registration = register(linked, randomUUID(), peerAddress(f.socketPath), f.root, 'idle');
    if (kind === 'file') await expect(registration).rejects.toThrow();
    else await expect(registration).rejects.toThrow('directory must be private and owned by the current user');
  } finally { owner?.mockRestore(); await f.close(); }
});

test('shared registry discovery refuses linked records and ambiguous identities without allowing linked socket or state directories', async () => {
  const f = await fixture();
  try {
    const linked = join(f.root, 'proxy');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(f.sessions, join(linked, 'sessions'));
    f.write({ pid: process.ppid }, `${process.ppid}.json`);
    expect(() => findPeer(linked, f.sessionId)).toThrow('unavailable or ambiguous');
    rmSync(join(f.sessions, `${process.ppid}.json`));
    const recordPath = join(f.sessions, `${process.pid}.json`);
    const target = join(f.root, 'record.json');
    renameSync(recordPath, target);
    symlinkSync(target, recordPath);
    expect(peers(linked)).toEqual([]);
    expect(JSON.parse(readFileSync(target, 'utf8')).sessionId).toBe(f.sessionId);
    const socketDirectory = join(f.root, 'socket-link');
    symlinkSync(f.directory, socketDirectory);
    expect(() => checkSocket(join(socketDirectory, `${process.pid}.sock`))).toThrow('directory must be private');
    expect(() => privateDirectory(socketDirectory)).toThrow('directory must be private');
  } finally { await f.close(); }
});

test('sending refuses a peer socket that other users can reach', async () => {
  const f = await fixture();
  try {
    const peer = f.peer();
    expect(peer).toBeDefined();
    expect(await sendFrames(f.configDir, peer!, [f.frame])).toBe(true);

    chmodSync(f.socketPath, 0o660);
    await expect(sendFrames(f.configDir, peer!, [f.frame])).rejects.toThrow('Invalid peer socket');
  } finally { await f.close(); }
});

test.each([`${process.pid}-f00d1234.sock`, 'abcdef0123456789.sock', 'custom socket%é.sock'])
  ('discovery and sending honor a registered native alternate socket path: %s', async socketName => {
    const f = await fixture(socketName);
    try {
      const peer = f.peer();
      expect(peer?.sessionId).toBe(f.sessionId);
      expect(peer?.messagingSocketPath).toBe(f.socketPath);
      expect(await sendFrames(f.configDir, peer!, [f.frame])).toBe(true);
    } finally { await f.close(); }
  });

test('sending refuses a peer whose process identity no longer matches', async () => {
  const f = await fixture();
  try {
    // A PID is reused after a session dies, so the recorded start time is what separates
    // the peer that registered from whatever process now holds its number.
    f.write({ procStart: 'Thu Jan  1 00:00:00 2026' });
    const peer = f.peer();
    expect(peer?.procStart).toBe('Thu Jan  1 00:00:00 2026');
    await expect(sendFrames(f.configDir, peer!, [f.frame])).rejects.toThrow('Peer process identity changed');
  } finally { await f.close(); }
});

test('processStart matches the start time Claude Code records on Linux', async () => {
  if (process.platform !== 'linux') return;
  const field22 = (await Bun.file(`/proc/${process.pid}/stat`).text()).split(') ').pop()!.split(' ')[19]!;
  expect(await processStart(process.pid)).toBe(field22);
  expect(await processStart(process.pid)).toMatch(/^[0-9]+$/);
});
