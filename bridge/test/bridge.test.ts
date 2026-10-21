import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { Bridge } from '../src/bridge';
import { peers } from '../src/claude';
import { Database } from 'bun:sqlite';
import { fakeEngine } from './engine-fixture';
// POSIX only on Windows CI: Unix socket files and file modes.
const posix = test.skipIf(process.platform === 'win32');
const linux = test.skipIf(process.platform !== 'linux');

posix('MCP accepts supported caller metadata and rejects unused aliases and a different task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-mcp-'));
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dir, '../src/server.ts')],
      env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } }));
    const missing = await client.callTool({ name: 'status', arguments: {} });
    expect(missing.isError).toBe(true);
    const id = randomUUID();
    for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id']) {
      const rejected = await client.callTool({ name: 'status', arguments: {}, _meta: { [key]: id } });
      expect(rejected.isError).toBe(true);
    }
    for (const meta of [
      { 'x-codex-turn-metadata': JSON.stringify({ thread_id: id }) },
      { 'x-codex-turn-metadata': { thread_id: id } },
      { threadId: id }, { thread_id: id },
    ]) {
      const valid = await client.callTool({ name: 'status', arguments: {}, _meta: meta });
      expect(valid.isError).not.toBe(true);
      const body = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(valid);
      expect(z.object({ threadId: z.uuid() }).parse(JSON.parse(body.content[0]?.text ?? '')).threadId).toBe(id);
    }
    const foreign = await client.callTool({ name: 'status', arguments: {}, _meta: { threadId: randomUUID() } });
    expect(foreign.isError).toBe(true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true });
  }
});

posix('the status tool returns the five latest message rows without null fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-mcp-'));
  const id = randomUUID();
  const bridge = new Bridge(id, root, join(root, 'plugin-state', 'asb-bridge'), join(root, 'unavailable.sock'));
  await bridge.close();
  const db = new Database(join(root, 'plugin-state', 'asb-bridge', `${id}.sqlite`));
  for (let index = 0; index < 7; index++) {
    db.run("INSERT INTO messages (id,peer_id,direction,text,status,created_at) VALUES (?,?,'out','text','unknown',?)", [String(index), randomUUID(), index]);
  }
  db.close();
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(import.meta.dir, '../src/server.ts')], env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } }));
    const body = z.object({ content: z.array(z.object({ text: z.string() })) })
      .parse(await client.callTool({ name: 'status', arguments: {}, _meta: { threadId: id } }));
    const state = JSON.parse(body.content[0]?.text ?? '');
    expect(state.messages.map((row: { id: string }) => row.id)).toEqual(['6', '5', '4', '3', '2']);
    expect(state.messages[0]).toEqual({ id: '6', peer_id: expect.any(String), direction: 'out', status: 'unknown' });
    expect(state).toMatchObject({ threadId: id, name: null, replyAddress: null });
  } finally {
    await client.close();
    rmSync(root, { recursive: true });
  }
});

posix('upgrading the inbox preserves existing queue records without relabelling their IDs as turns', async () => {
  const root = mkdtempSync('/tmp/uds-upgrade-');
  const threadId = randomUUID();
  const messageId = randomUUID();
  const old = new Database(join(root, `${threadId}.sqlite`));
  old.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, peer_id TEXT, direction TEXT, text TEXT, status TEXT, queue_id TEXT, created_at INTEGER)');
  old.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?)', [messageId, randomUUID(), 'in', 'old message', 'queued', randomUUID(), 1]);
  old.close();
  const bridge = new Bridge(threadId, root, root, join(root, 'unavailable.sock'));
  try {
    expect(bridge.status().messages[0]).toMatchObject({ id: messageId, status: 'queued', turn_id: null });
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true });
  }
});

posix('registered peers can initiate contact; unknown senders and wrong targets are rejected and duplicates survive restart', async () => {
  const root = mkdtempSync('/tmp/uds-test-');
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const peerPath = join(directory, `${process.ppid}.sock`);
  const received: string[] = [];
  const peer = net.createServer(socket => socket.on('data', chunk => received.push(chunk.toString())));
  peer.listen(peerPath);
  await once(peer, 'listening');
  chmodSync(peerPath, 0o600);
  const sessionId = randomUUID();
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId, messagingSocketPath: peerPath, cwd: root, peerProtocol: 1,
  }));
  const threadId = randomUUID();
  let bridge = new Bridge(threadId, configDir, stateDir, join(root, 'unavailable.sock'));
  const messageId = randomUUID();
  const transmit = async (id: string, from = `uds:${peerPath}`, target = threadId) => {
    const address = bridge.status().replyAddress;
    if (!address) throw new Error('Missing test inbox');
    const socket = net.createConnection(address.slice(4));
    await once(socket, 'connect');
    socket.end(JSON.stringify({ msgV: 1, type: 'user', msg_id: id, from, session_id: target,
      message: { role: 'user', content: 'test payload' } }) + '\n');
    await once(socket, 'close');
  };
  try {
    await expect(bridge.sendMessage(sessionId, 'must not send without a reply address'))
      .rejects.toThrow('This Codex task has no active receiver');
    expect(received).toEqual([]);
    expect(bridge.status().messages).toEqual([]);
    await bridge.start(directory, root, bridge.beginSession());
    bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await transmit(randomUUID(), 'uds:/unselected.sock');
    await transmit(randomUUID(), `uds:${peerPath}`, randomUUID());
    await transmit(messageId);
    const deadline = Date.now() + 2000;
    while (bridge.status().messages[0]?.status !== 'unknown' && Date.now() < deadline) await Bun.sleep(10);
    expect(bridge.status().messages[0]?.status).toBe('unknown');
    await transmit(messageId);
    await bridge.close();
    bridge = new Bridge(threadId, configDir, stateDir, join(root, 'unavailable.sock'));
    await bridge.start(directory, root, bridge.beginSession());
    await transmit(messageId);
    const state = bridge.status();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: messageId, status: 'unknown', turn_id: null });
    expect(state.replyAddress).not.toBeNull();
    writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
      pid: process.ppid, sessionId, messagingSocketPath: peerPath, cwd: root, peerProtocol: 1,
      procStart: 'a previous process with this PID',
    }));
    await expect(bridge.sendMessage(sessionId, 'must not reach a recycled process')).rejects.toThrow();
    expect(received).toEqual([]);
  } finally {
    await bridge.close();
    expect(peers(configDir).some(peer => peer.sessionId === threadId)).toBe(false);
    await new Promise<void>(resolve => peer.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
});

// PID 1 belongs to another user on a normal system: kill(1, 0) gives EPERM. In a container that runs as root it does not, and the test is moot.
const foreignPid = (() => {
  try { process.kill(1, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' && existsSync('/proc/1/stat'); }
})();

test.skipIf(!foreignPid)('a receiver start ignores the receiver row of a dead receiver whose PID another user has now', async () => {
  const root = mkdtempSync('/tmp/uds-eperm-');
  const configDir = join(root, 'config');
  const directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const threadId = randomUUID();
  const bridge = new Bridge(threadId, configDir, join(root, 'state'), join(root, 'unavailable.sock'));
  const database = new Database(join(root, 'state', `${threadId}.sqlite`));
  try {
    database.run('INSERT INTO receiver VALUES (1,1,?)', ['a previous process with this PID']);
    await bridge.start(directory, root, bridge.beginSession());
    expect(database.query('SELECT pid FROM receiver WHERE singleton=1').get()).toEqual({ pid: process.pid });
  } finally {
    database.close();
    await bridge.close();
    rmSync(root, { recursive: true });
  }
});

posix('a new Bridge waits for a lock that another process holds on its state database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-lock-'));
  const threadId = randomUUID();
  const holder = new Database(join(root, `${threadId}.sqlite`), { create: true });
  holder.exec('BEGIN EXCLUSIVE');
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      const { Bridge } = await import(${JSON.stringify(join(import.meta.dir, '../src/bridge.ts'))});
      process.stdout.write('ready\\n');
      try { await new Bridge(${JSON.stringify(threadId)}, ${JSON.stringify(root)}, ${JSON.stringify(root)}, ${JSON.stringify(join(root, 'unavailable.sock'))}).close(); console.log('opened'); }
      catch (error) { console.log(String(error)); process.exit(1); }`], { stdout: 'pipe', stderr: 'inherit' });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('ready\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    await Bun.sleep(100);
    holder.exec('COMMIT');
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) output += decoder.decode(chunk.value);
    expect({ code: await child.exited, output }).toEqual({ code: 0, output: 'ready\nopened\n' });
  } finally {
    holder.close();
    rmSync(root, { recursive: true });
  }
});

linux('B1: send_message takes exactly one of sessionId or a well-formed reference and asks the engine nothing otherwise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-mcp-'));
  const engine = fakeEngine(z.string().parse(process.env.XDG_RUNTIME_DIR), () => ({ apiVersion: 1, ok: false, code: 'not-found', message: 'No session.' }));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const reference = `asb:1/${'a'.repeat(16)}/codex/${'ab'.repeat(16)}/codex:${randomUUID()}`;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } }));
    for (const [fields, error] of [[{}, 'Give exactly one of sessionId or reference.'], [{ sessionId: randomUUID(), reference }, 'Give exactly one of sessionId or reference.'],
      [{ reference: `codex/${randomUUID()}` }, 'Input validation error'], [{ reference: 'asb:1/ x' }, 'Input validation error'],
      [{ reference: `asb:${'x'.repeat(381)}` }, 'Input validation error']] as const) {
      const answer = await client.callTool({ name: 'send_message', arguments: { ...fields, text: 'hello' }, _meta: { threadId: randomUUID() } });
      expect(answer.isError).toBe(true);
      expect(JSON.stringify(answer.content)).toContain(error);
    }
    expect(`asb:${'x'.repeat(381)}`).toHaveLength(385);
    expect(engine.calls).toEqual([]);
  } finally {
    await client.close();
    engine.close();
    rmSync(root, { recursive: true });
  }
});

// Windows only: the engine binds a Windows target only for a bridge that proves the pipe server, so the body asks for it.
// The Linux body stays exact (protocol.test.ts B2).
test.skipIf(process.platform !== 'win32')('on Windows, resolve-bound asks for a pipe proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asb-bound-windows-'));
  const local = z.string().parse(process.env.LOCALAPPDATA);
  const engine = fakeEngine(local, () => ({ apiVersion: 1, ok: false, code: 'not-found', message: 'No session.' }), join(local, 'asb', 'run'));
  const threadId = randomUUID();
  const configDir = join(root, 'claude');
  mkdirSync(join(configDir, 'sessions'), { recursive: true });
  writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: threadId,
    messagingSocketPath: `\\\\.\\pipe\\LOCAL\\cc-msg-${'ab'.repeat(16)}`, cwd: root, peerProtocol: 1, entrypoint: 'codex-asb-bridge' }));
  const bridge = new Bridge(threadId, configDir, join(root, 'state'), join(root, 'unavailable.sock'));
  const reference = `asb:1/${'a'.repeat(16)}/codex/${'ab'.repeat(16)}/codex:${randomUUID()}`;
  try {
    await expect(bridge.sendReference(reference, 'hello')).rejects.toThrow('No session. Nothing sent (not-found).');
    expect(engine.calls.map(call => [call.route, call.body])).toEqual([['/api/agent/resolve-bound', { reference,
      caller: { runtimeSessionId: threadId, configDir }, msgId: expect.any(String), remainingMs: 10_000, pipeProof: true }]]);
  } finally {
    await bridge.close();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});
