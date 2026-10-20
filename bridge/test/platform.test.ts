import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { inbox, peers, register, sendFrames, socketPath, type Frame } from '../src/claude';
import { outboundServer, refreshReceiver, sendBound, sendBoundViaReceiver } from '../src/outbound';
import { checkPeerSocket, checkSocketFile, inboxPath, keyName, outboxPath, ownedJson, pidDomain, pipeProof, privateDirectory, processStart, type WindowsApi } from '../src/platform';

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
}, 30000);

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

// A fake Win32 api for pipeProof: the server is PID 7, started at 123, the same user; the pipe handle is 40n.
// A write request larger than `free` takes 0 bytes, as a NOWAIT write larger than the free pipe buffer did on the Windows CI runner.
function fakeApi(change: Partial<Record<keyof WindowsApi, (...args: never[]) => unknown>> = {}, writeSizes: number[] = [], incoming: string[] = [], free = Infinity) {
  const calls: { name: string; args: unknown[] }[] = [];
  const written: Uint8Array[] = [];
  let open = true;
  const base: Record<string, (...args: never[]) => unknown> = {
    CreateFileW: () => 40n,
    GetNamedPipeServerProcessId: (_pipe: bigint, out: Uint32Array) => { out[0] = 7; return 1; },
    OpenProcess: () => 8,
    GetProcessTimes: (_handle: number, creation: BigUint64Array) => { creation[0] = 123n; return true; },
    OpenProcessToken: (_process: number, _access: number, out: BigUint64Array) => { out[0] = 9n; return 1; },
    GetTokenInformation: () => 1,
    EqualSid: () => 1,
    SetNamedPipeHandleState: () => 1,
    WriteFile: (_pipe: bigint, bytes: Uint8Array, count: number, done: Uint32Array) => {
      const size = count > free ? 0 : Math.min(writeSizes.shift() ?? count, count);
      written.push(bytes.slice(0, size));
      done[0] = size;
      return 1;
    },
    PeekNamedPipe: (_pipe: bigint, _buffer: null, _size: number, _read: null, available: Uint32Array) => {
      available[0] = incoming.length ? Buffer.byteLength(incoming[0]!) : 0;
      return incoming.length || open ? 1 : 0;
    },
    ReadFile: (_pipe: bigint, buffer: Uint8Array, count: number, done: Uint32Array) => {
      const chunk = Buffer.from(incoming.shift()!);
      buffer.set(chunk.subarray(0, count));
      if (chunk.length > count) incoming.unshift(chunk.subarray(count).toString());
      done[0] = Math.min(chunk.length, count);
      return 1;
    },
    CloseHandle: () => true,
    ...change,
  };
  const api = Object.fromEntries(Object.entries(base).map(([name, call]) =>
    [name, (...args: never[]) => { calls.push({ name, args }); return call(...args); }])) as unknown as WindowsApi;
  return { api, calls, written, names: () => calls.map(call => call.name), shut() { open = false; } };
}
const outPipe = `\\\\.\\pipe\\LOCAL\\asb-out-${hex}`;
const peerPipe = `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}`;

test('pipeProof refuses a path that is not a cc-msg or an asb-out pipe before it opens anything', () => {
  for (const bad of ['\\\\.\\pipe\\codex-ipc', `\\\\.\\pipe\\LOCAL\\asb-out-${hex.toUpperCase()}`, `\\\\.\\pipe\\asb-out-${hex}`,
    `\\\\.\\pipe\\LOCAL\\asb-out-${hex}0`, '/tmp/a.sock', `\\\\.\\pipe\\LOCAL\\cc-msg-${hex}\\..\\x`]) {
    const fake = fakeApi();
    expect(() => pipeProof(bad, 7, '123', fake.api)).toThrow('Invalid peer socket');
    expect(fake.calls).toEqual([]);
  }
});

test('pipeProof opens the pipe for read and write, unshared, with identification only, and sets PIPE_NOWAIT', () => {
  for (const path of [peerPipe, outPipe]) {
    const fake = fakeApi();
    pipeProof(path, 7, '123', fake.api).close();
    const [create, ...rest] = fake.calls;
    expect(create!.name).toBe('CreateFileW');
    expect(Buffer.from(create!.args[0] as Uint8Array).toString('utf16le')).toBe(`${path}\0`);
    expect(create!.args.slice(1)).toEqual([0xC0000000, 0, null, 3, 0x00110000, null]);
    expect([...rest.find(call => call.name === 'SetNamedPipeHandleState')!.args[1] as Uint32Array]).toEqual([1]);
    expect(rest.filter(call => call.name === 'CloseHandle').map(call => call.args[0])).toContainEqual(40n);
  }
});

test('each failed pipeProof check throws, closes the pipe, and never writes or sets the pipe state', () => {
  const failures: [string, Parameters<typeof fakeApi>[0], string][] = [
    ['another server PID', { GetNamedPipeServerProcessId: (_pipe: bigint, out: Uint32Array) => { out[0] = 8; return 1; } }, '123'],
    ['no server PID', { GetNamedPipeServerProcessId: () => 0 }, '123'],
    ['another creation time', {}, '124'],
    ['no creation time', { GetProcessTimes: () => false }, '123'],
    ['another user', { EqualSid: () => 0 }, '123'],
    ['no token', { OpenProcessToken: () => 0 }, '123'],
    ['no token user', { GetTokenInformation: () => 0 }, '123'],
    ['OpenProcess fails', { OpenProcess: () => null }, '123'],
  ];
  for (const [name, change, procStart] of failures) {
    const fake = fakeApi(change);
    expect(() => pipeProof(outPipe, 7, procStart, fake.api), name).toThrow();
    expect(fake.calls.filter(call => call.name === 'CloseHandle').map(call => call.args[0]), name).toContainEqual(40n);
    expect(fake.names(), name).not.toContain('WriteFile');
    expect(fake.names(), name).not.toContain('SetNamedPipeHandleState');
  }
  for (const handle of [-1n, 0n]) {
    const fake = fakeApi({ CreateFileW: () => handle });
    expect(() => pipeProof(outPipe, 7, '123', fake.api)).toThrow();
    expect(fake.names()).toEqual(['CreateFileW']);
  }
});

test('a proved pipe writes the auth line first and continues partial and empty writes at the right offset', async () => {
  const fake = fakeApi({}, [3, 0, 5, 0, 7]);
  const pipe = pipeProof(peerPipe, 7, '123', fake.api);
  const text = JSON.stringify({ type: 'auth', token: hex }) + '\n' + JSON.stringify({ msgV: 1, type: 'user' }) + '\n';
  const bytes = Buffer.from(text);
  await pipe.write(bytes, AbortSignal.timeout(5000));
  const writes = fake.calls.filter(call => call.name === 'WriteFile');
  expect(Buffer.from(writes[0]!.args[1] as Uint8Array).toString().startsWith('{"type":"auth"')).toBe(true);
  let offset = 0;
  for (const [index, call] of writes.entries()) {
    expect(Buffer.from(call.args[1] as Uint8Array).equals(bytes.subarray(offset))).toBe(true);
    expect(call.args[2]).toBe(bytes.length - offset);
    offset += fake.written[index]!.length;
  }
  expect(fake.written.slice(0, 5).map(chunk => chunk.length)).toEqual([3, 0, 5, 0, 7]);
  expect(Buffer.concat(fake.written).toString()).toBe(text);
  pipe.close();
  pipe.close();
  expect(fake.calls.filter(call => call.name === 'CloseHandle' && call.args[0] === 40n)).toHaveLength(1);
});

test('a proved pipe splits a large write into 4096-byte requests at the right offsets, also after partial and empty writes', async () => {
  const fake = fakeApi({}, [4096, 0, 1000], [], 4096);
  const bytes = new Uint8Array(10_000).map((_, index) => index % 251);
  await pipeProof(peerPipe, 7, '123', fake.api).write(bytes, AbortSignal.timeout(1000));
  const requests = fake.calls.filter(call => call.name === 'WriteFile')
    .map(call => [(call.args[1] as Uint8Array).byteOffset - bytes.byteOffset, (call.args[1] as Uint8Array).length, call.args[2]]);
  expect(requests).toEqual([[0, 4096, 4096], [4096, 4096, 4096], [4096, 4096, 4096], [5096, 4096, 4096], [9192, 808, 808]]);
  expect(fake.written.map(chunk => chunk.length)).toEqual([4096, 0, 1000, 4096, 808]);
  expect(Buffer.concat(fake.written).equals(bytes)).toBe(true);
});

test('a proved pipe write stops on an aborted signal and on a failed WriteFile', async () => {
  const aborted = fakeApi();
  await expect(pipeProof(peerPipe, 7, '123', aborted.api).write(Buffer.from('x\n'), AbortSignal.abort())).rejects.toThrow();
  expect(aborted.names()).not.toContain('WriteFile');
  const stuck = fakeApi({}, Array(1000).fill(0));
  await expect(pipeProof(peerPipe, 7, '123', stuck.api).write(Buffer.from('x\n'), AbortSignal.timeout(50))).rejects.toThrow();
  const failed = fakeApi({ WriteFile: () => 0 });
  await expect(pipeProof(peerPipe, 7, '123', failed.api).write(Buffer.from('x\n'), AbortSignal.timeout(5000))).rejects.toThrow('Pipe write failed');
});

test('a proved pipe reads the first line, stops at maxBytes, and throws when the pipe closes with no line', async () => {
  const reply = fakeApi({}, [], ['{"writ', 'ten":true}\nrest']);
  expect(await pipeProof(outPipe, 7, '123', reply.api).readLine(1024, AbortSignal.timeout(5000))).toBe('{"written":true}');
  const long = fakeApi({}, [], ['abcdefgh']);
  await expect(pipeProof(outPipe, 7, '123', long.api).readLine(4, AbortSignal.timeout(5000))).rejects.toThrow('Pipe line too long');
  expect(long.calls.filter(call => call.name === 'ReadFile').map(call => call.args[2])).toEqual([4]);
  const closed = fakeApi({}, [], ['no newline']);
  closed.shut();
  await expect(pipeProof(outPipe, 7, '123', closed.api).readLine(1024, AbortSignal.timeout(5000))).rejects.toThrow('Pipe closed before a full line');
  const slow = fakeApi();
  await expect(pipeProof(outPipe, 7, '123', slow.api).readLine(1024, AbortSignal.timeout(50))).rejects.toThrow();
});

// The bridge-windows CI job runs these with the real Win32 api.
const windowsOnly = test.skipIf(!windows);
const userFrame = (from: string, sessionId: string, content: string, id = randomUUID()) =>
  ({ msgV: 1, type: 'user', msg_id: id, from, session_id: sessionId, message: { role: 'user', content } });

windowsOnly('a proved sendFrames delivers the frame after the auth line, and a frame of about 1 MiB arrives whole', async () => {
  const f = await receiver();
  try {
    const [peer] = peers(f.configDir);
    expect(await sendFrames(f.configDir, peer!, [f.frame('proved')], { prove: true })).toBe(true);
    const big = 'x'.repeat(1_040_000);
    expect(await sendFrames(f.configDir, peer!, [f.frame(big)], { prove: true })).toBe(true);
    await until(() => f.frames.length === 2, 20000);
    expect(f.frames.map(frame => frame.type === 'user' && frame.message.content)).toEqual(['proved', big]);
  } finally { await f.close(); }
}, 60000);

windowsOnly('a proved bound send through the receiver outbox answers written, and the target gets the frame', async () => {
  const sender = await receiver();
  const target = await receiver();
  const close = await outboundServer(outboxPath(sender.path), target.configDir, sender.listener.address, () => true, () => {}, sender.token);
  try {
    const [self] = peers(sender.configDir);
    const [peer] = peers(target.configDir);
    const send = (content: string) => {
      const msgId = randomUUID();
      const binding = { registryHome: realpathSync(join(target.configDir, 'sessions')), runtimeSessionId: peer!.sessionId, pid: peer!.pid,
        procStart: peer!.procStart!, messagingSocketPath: peer!.messagingSocketPath, msgId, expiresAtMs: Date.now() + 10_000 };
      return sendBoundViaReceiver(sender.configDir, self!, binding, [userFrame(sender.listener.address, peer!.sessionId, content, msgId)]);
    };
    expect(await send('bound')).toBe(true);
    // Near the 1 MiB limit of one serialized frame (maxLineLength).
    const big = 'y'.repeat(1_040_000);
    expect(await send(big)).toBe(true);
    await until(() => target.frames.length === 2, 20000);
    expect(target.frames.map(frame => frame.type === 'user' && frame.message.content)).toEqual(['bound', big]);
  } finally { await close(); await sender.close(); await target.close(); }
}, 60000);

// A child Bun process serves a cc-msg pipe and prints the bytes of each connection when it closes.
async function pipeChild() {
  const path = inboxPath('', undefined, 'win32');
  const script = "const s=require('node:net').createServer(c=>{let n=0;c.on('data',d=>{n+=d.length});c.on('error',()=>{});"
    + "c.on('close',()=>console.log('closed:'+n))});s.listen(process.env.ASB_TEST_PIPE,()=>console.log('ready'))";
  const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, ASB_TEST_PIPE: path }, stdout: 'pipe', stderr: 'ignore' });
  let output = '';
  void (async () => { for await (const chunk of child.stdout) output += Buffer.from(chunk).toString(); })();
  await until(() => output.includes('ready'), 20000);
  return { child, path, closed: async () => Number((await until(() => /closed:(\d+)/.exec(output), 20000))[1]), reset() { output = 'ready'; } };
}

windowsOnly('a pipe served by another process or with another start time gets 0 bytes, and sendBound gives target-changed', async () => {
  const root = temporary('asb-platform-proof-');
  const configDir = join(root, 'claude');
  const sessions = join(configDir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const server = await pipeChild();
  try {
    const sessionId = randomUUID();
    const row = async (pid: number, procStart: string) => {
      for (const name of readdirSync(sessions)) rmSync(join(sessions, name));
      writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, messagingSocketPath: server.path, cwd: root, peerProtocol: 1, procStart }));
      writeFileSync(join(sessions, keyName(pid, server.path)), JSON.stringify({ peerToken: hex, procStart }));
      return { registryHome: realpathSync(sessions), runtimeSessionId: sessionId, pid, procStart, messagingSocketPath: server.path,
        msgId: randomUUID(), expiresAtMs: Date.now() + 10_000 };
    };
    const send = (binding: Awaited<ReturnType<typeof row>>) => sendBound(configDir, binding, [userFrame('uds:/dev/null', sessionId, 'probe', binding.msgId)], () => true);
    // The row names this process, but the child serves the pipe.
    await expect(send(await row(process.pid, await processStart(process.pid)))).rejects.toThrow('Nothing sent (target-changed).');
    expect(await server.closed()).toBe(0);
    // The right PID with another start time: the proof itself refuses.
    server.reset();
    expect(() => pipeProof(server.path, server.child.pid, '1')).toThrow();
    expect(await server.closed()).toBe(0);
    server.reset();
    await expect(send(await row(server.child.pid, '1'))).rejects.toThrow('Nothing sent (target-changed).');
    // The control: the row of the serving process passes, so the refusals above come from the proof.
    server.reset();
    expect(await send(await row(server.child.pid, await processStart(server.child.pid)))).toBe(true);
    expect(await server.closed()).toBeGreaterThan(0);
  } finally { server.child.kill(); await server.child.exited; rmSync(root, { recursive: true, force: true }); }
}, 90000);
