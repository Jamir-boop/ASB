import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { inbox, peers, register, sendFrames, socketPath, type Frame } from '../src/claude';
import { outboundServer, refreshReceiver } from '../src/outbound';
import { checkPeerSocket, checkSocketFile, inboxPath, keyName, outboxPath, ownedJson, pidDomain, privateDirectory, processStart } from '../src/platform';

const windows = process.platform === 'win32';
const hex = 'ab'.repeat(16);
// Unix socket paths have a 104-byte limit, so POSIX tests stay in /tmp.
const temporary = (prefix: string) => mkdtempSync(join(windows ? tmpdir() : '/tmp', prefix));

async function until<T>(read: () => T | undefined | false, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await Bun.sleep(20);
  }
}

test('a Windows peer socket must be a cc-msg pipe', () => {
  for (const good of [`\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`, `\\\\.\\pipe\\cc-msg-${hex}`, `\\\\.\\PIPE\\local\\CC-MSG-${hex.toUpperCase()}`]) {
    expect(() => checkPeerSocket(good, 'win32')).not.toThrow();
  }
  for (const bad of ['\\\\.\\pipe\\codex-ipc', `\\\\.\\pipe\\LOCAL\\cc-msg-${hex.slice(1)}`, `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}0`,
    `\\\\.\\pipe\\OTHER\\cc-msg-${hex}`, `\\\\.\\pipe\\LOCAL\\cc-msg-${'g'.repeat(32)}`, `C:\\pipe\\cc-msg-${hex}`, `/tmp/cc-msg-${hex}`]) {
    expect(() => checkPeerSocket(bad, 'win32')).toThrow('Invalid peer socket');
  }
});

test('key names hash a pipe as lower case and a socket path as it is', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  expect(keyName(42, `\\\\.\\PIPE\\LOCAL\\CC-MSG-${hex.toUpperCase()}`)).toBe(`42.${sha(`\\\\.\\pipe\\local\\cc-msg-${hex}`)}.key`);
  expect(keyName(42, '/run/user/1000/cc-socks/A.sock')).toBe(`42.${sha('/run/user/1000/cc-socks/A.sock')}.key`);
});

test('inbox and outbox paths follow each system', () => {
  expect(inboxPath('/run/x', '7.sock', 'linux')).toBe(join('/run/x', '7.sock'));
  const pipe = inboxPath('', undefined, 'win32');
  expect(pipe).toMatch(/^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/);
  expect(inboxPath('', undefined, 'win32')).not.toBe(pipe);
  expect(outboxPath('/run/x/7.sock', 'linux')).toBe('/run/x/7.out');
  expect(outboxPath(`\\\\.\\pipe\\LOCAL\\cc-msg-${hex.toUpperCase()}`, 'win32')).toBe(`\\\\.\\pipe\\LOCAL\\asb-out-${hex}`);
  expect(() => outboxPath('\\\\.\\pipe\\codex-ipc', 'win32')).toThrow('Invalid peer socket');
});

test('owned JSON and private folders refuse a too-large file and a file as a folder on each system', () => {
  const root = temporary('asb-platform-');
  try {
    const file = join(root, 'a.json');
    writeFileSync(file, JSON.stringify({ a: 1 }), { mode: 0o600 });
    for (const platform of ['linux', 'win32']) {
      if (platform === 'linux' && windows) continue;
      expect(ownedJson(file, 4096, platform)).toEqual({ a: 1 });
      expect(() => ownedJson(file, 4, platform)).toThrow('Invalid local metadata file');
      expect(() => ownedJson(root, 4096, platform)).toThrow();
      expect(() => privateDirectory(root, platform)).not.toThrow();
      expect(() => privateDirectory(file, platform)).toThrow('must be private');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the Windows app-server socket check finds the entry by name in its private folder', () => {
  const root = temporary('asb-platform-sock-');
  try {
    const path = join(root, 'app-server-control.sock');
    expect(() => checkSocketFile(path, 'win32')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    mkdirSync(path);
    expect(() => checkSocketFile(path, 'win32')).toThrow('Invalid socket path');
    rmSync(path, { recursive: true });
    writeFileSync(path, '', { mode: 0o600 });
    expect(() => checkSocketFile(path, 'win32')).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Symbolic links need extra rights on Windows.
test.skipIf(windows)('owned JSON and private folders refuse a symbolic link with the Linux and the Windows rules', () => {
  const root = temporary('asb-platform-link-');
  try {
    writeFileSync(join(root, 'a.json'), '{}', { mode: 0o600 });
    mkdirSync(join(root, 'd'), { mode: 0o700 });
    symlinkSync(join(root, 'a.json'), join(root, 'link.json'));
    symlinkSync(join(root, 'd'), join(root, 'link'));
    for (const platform of ['linux', 'win32']) {
      expect(() => ownedJson(join(root, 'link.json'), 4096, platform)).toThrow();
      expect(() => privateDirectory(join(root, 'link'), platform)).toThrow('must be private');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('processStart gives the start time that the system records', async () => {
  if (process.platform === 'linux') {
    const field22 = (await Bun.file(`/proc/${process.pid}/stat`).text()).split(') ').pop()!.split(' ')[19]!;
    expect(await processStart(process.pid)).toBe(field22);
  } else if (windows) {
    const child = Bun.spawn(['powershell', '-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`], { stdout: 'pipe', stderr: 'ignore' });
    expect(await processStart(process.pid)).toBe((await new Response(child.stdout).text()).trim());
    await expect(processStart(2 ** 31 - 2)).rejects.toThrow('Cannot verify receiver process');
  }
});

test('pidDomain names the Windows host and macOS, and Linux has none', () => {
  expect(pidDomain('win32')).toBe(`win32:${hostname().toLowerCase()}`);
  expect(pidDomain('darwin')).toBe('darwin');
  expect(pidDomain('linux')).toBeUndefined();
});

// A registered receiver with a token, as the Bridge makes it on Windows (plan 17.2).
async function receiver() {
  const root = temporary('asb-platform-trip-');
  const configDir = join(root, 'claude');
  const directory = join(root, 's');
  mkdirSync(directory, { mode: 0o700 });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'codex');
  const token = randomBytes(16).toString('hex');
  const frames: Frame[] = [];
  const listener = await inbox(directory, frame => frames.push(frame), undefined, { token });
  const registration = await register(configDir, randomUUID(), listener.address, root, 'idle', token);
  const frame = (content: string) => ({ msgV: 1, type: 'user', msg_id: randomUUID(), from: 'uds:/dev/null', message: { role: 'user', content } });
  return { root, configDir, token, frames, frame, listener, registration, path: socketPath(listener.address),
    async close() {
      try { registration.close(); } catch { /* A test closed it. */ }
      await listener.close();
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    } };
}

async function rawSend(path: string, text: string) {
  const socket = net.createConnection(path);
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.end(text);
  await once(socket, 'close');
}

test('a registered receiver with a key file gets frames only after the right auth line', async () => {
  const f = await receiver();
  try {
    const sessions = join(f.configDir, 'sessions');
    const [peer] = peers(f.configDir);
    expect(peer?.messagingSocketPath).toBe(f.path);
    const keyFile = join(sessions, keyName(process.pid, f.path));
    expect(await Bun.file(keyFile).json()).toEqual({ peerToken: f.token, procStart: await processStart(process.pid), ...(pidDomain() ? { pidDomain: pidDomain() } : {}) });
    if (!windows) expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(sessions).filter(name => name.includes('.tmp.'))).toEqual([]);
    if (windows) expect(f.path).toMatch(/^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/);

    await rawSend(f.path, JSON.stringify(f.frame('no auth')) + '\n');
    await rawSend(f.path, JSON.stringify({ type: 'auth', token: 'f'.repeat(32) }) + '\n' + JSON.stringify(f.frame('wrong token')) + '\n');
    await rawSend(f.path, JSON.stringify({ type: 'auth', token: f.token.slice(1) }) + '\n' + JSON.stringify(f.frame('short token')) + '\n');
    expect(await sendFrames(f.configDir, peer!, [f.frame('through')])).toBe(true);
    await until(() => f.frames.length);
    await Bun.sleep(100);
    expect(f.frames.map(frame => frame.type === 'user' && frame.message.content)).toEqual(['through']);

    f.registration.close();
    expect(existsSync(keyFile)).toBe(false);
    expect(peers(f.configDir)).toEqual([]);
  } finally { await f.close(); }
});

test('a missing key file sends without auth elsewhere and refuses on Windows', async () => {
  const f = await receiver();
  try {
    const [peer] = peers(f.configDir);
    rmSync(join(f.configDir, 'sessions', keyName(process.pid, f.path)));
    const sent = sendFrames(f.configDir, peer!, [f.frame('no key')]);
    if (windows) await expect(sent).rejects.toThrow('Claude peer key is missing; list sessions again');
    else {
      // The inbox has a token, so the frame without the auth line does not get through.
      expect(await sent).toBe(true);
      await Bun.sleep(100);
      expect(f.frames).toEqual([]);
    }
  } finally { await f.close(); }
});

test('the outbound server needs the auth line when it has a token', async () => {
  const f = await receiver();
  let requests = 0;
  const close = await outboundServer(outboxPath(f.path), f.configDir, f.listener.address, () => true, () => { requests++; }, windows ? f.token : undefined);
  try {
    const [self] = peers(f.configDir);
    // The client reads the token from the receiver's key file on Windows only.
    await refreshReceiver(f.configDir, self!);
    expect(requests).toBe(1);
  } finally { await close(); await f.close(); }
  const g = await receiver();
  const closeG = await outboundServer(outboxPath(g.path), g.configDir, g.listener.address, () => true, () => { requests++; }, g.token);
  try {
    for (const lines of [[{ type: 'refresh' }], [{ type: 'auth', token: 'f'.repeat(32) }, { type: 'refresh' }]]) {
      const socket = net.createConnection(outboxPath(g.path));
      socket.on('error', () => {});
      await once(socket, 'connect');
      let reply = '';
      socket.on('data', chunk => { reply += chunk; });
      socket.write(lines.map(line => JSON.stringify(line) + '\n').join(''));
      await once(socket, 'close');
      expect(reply).toBe('');
    }
    const socket = net.createConnection(outboxPath(g.path));
    await once(socket, 'connect');
    let reply = '';
    socket.on('data', chunk => { reply += chunk; });
    socket.write(JSON.stringify({ type: 'auth', token: g.token }) + '\n' + JSON.stringify({ type: 'refresh' }) + '\n');
    await once(socket, 'close');
    expect(JSON.parse(reply)).toEqual({ refreshed: true });
    expect(requests).toBe(2);
  } finally { await closeG(); await g.close(); }
});
