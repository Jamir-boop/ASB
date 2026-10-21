import { test, expect } from 'bun:test';
import { mkdirSync, chmodSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CancelledNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from '../src/bridge';
import { findPeer, frameSchema, hopChain, inbox, maxLineLength, peerAddress, peers, sendFrames, sessionName, socketPath, userFrame } from '../src/claude';
import { receiver } from './desktop-fixture';
import { outboxPath } from '../src/platform';
import { appServer } from './app-server-fixture';
import { fakeEngine } from './engine-fixture';
import { processStart } from '../src/claude';
// POSIX only on Windows CI: Unix socket files, /tmp, and file modes.
const posix = test.skipIf(process.platform === 'win32');
// The ASB engine runs only on Linux and Windows, and these tests use Unix sockets.
const linux = test.skipIf(process.platform !== 'linux');

async function fixture(prefix = '/tmp/uds-protocol-') {
  const root = mkdtempSync(prefix);
  const desktop = await receiver('idle', false, false, root);
  const configDir = join(root, 'claude');
  const stateDir = join(root, 'plugin-state', 'asb-bridge');
  const directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const peerId = randomUUID();
  const peerPath = join(directory, `${process.ppid}.sock`);
  const frames: z.infer<typeof frameSchema>[] = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        frames.push(frameSchema.parse(JSON.parse(buffer.slice(0, end))));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  server.listen(peerPath);
  await once(server, 'listening');
  chmodSync(peerPath, 0o600);
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath, cwd: root, peerProtocol: 1, peerFeatures: ['notify_idle'],
    startedAt: 1700000000000,
  }));
  const bridge = new Bridge(desktop.threadId, configDir, stateDir, desktop.path);
  await bridge.start(directory, root, bridge.beginSession());
  bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
  const db = new Database(join(stateDir, `${desktop.threadId}.sqlite`));
  const submittedInputId = (index = 0) => {
    const params = z.object({ clientUserMessageId: z.string().optional(),
      turnStart: z.object({ request: z.object({ clientUserMessageId: z.string() }) }).optional() }).parse(desktop.submissions[index]?.params);
    return z.string().parse(params.clientUserMessageId ?? params.turnStart?.request.clientUserMessageId);
  };
  const textItem = z.object({ text: z.string() });
  const deliveredText = (index = 0) => {
    const params = z.object({ input: z.array(textItem).optional(), turnStart: z.object({ request: z.object({ input: z.array(textItem) }) }).optional() })
      .parse(desktop.submissions[index]?.params);
    return z.string().parse((params.input ?? params.turnStart?.request.input)?.[0]?.text);
  };
  // Gives the peer's registry row this name, or removes the row.
  const rename = (name?: string) => {
    const path = join(configDir, 'sessions', `${process.ppid}.json`);
    if (name === undefined) rmSync(path);
    else writeFileSync(path, JSON.stringify({ pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath, cwd: root, name,
      peerProtocol: 1, peerFeatures: ['notify_idle'], startedAt: 1700000000000 }));
  };
  const transmit = async (frame: Record<string, unknown>) => {
    const path = peers(configDir).find(peer => peer.sessionId === desktop.threadId)?.messagingSocketPath;
    if (!path) throw new Error('No receiver');
    const socket = net.createConnection(path);
    await once(socket, 'connect');
    socket.end(JSON.stringify({ msgV: 1, from: `uds:${peerPath}`, ...frame }) + '\n');
    await once(socket, 'close');
  };
  return { bridge, desktop, db, peerId, peerPath, frames, root, configDir, transmit, submittedInputId, deliveredText, rename,
    async message(mode?: string, text: string = randomUUID()) {
      const id = randomUUID();
      await transmit({ type: 'user', msg_id: id, session_id: desktop.threadId,
        message: { role: 'user', content: mode === undefined ? text : `<cross-session-message from-mode="${mode}">${text}</cross-session-message>` } });
      return id;
    },
    async close() { await bridge.close(); db.close(); await new Promise<void>(resolve => server.close(() => resolve())); await desktop.close(); },
  };
}

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type AppServerFixture = Awaited<ReturnType<typeof appServer>>;

// Sends one enveloped message from the peer and returns what the task's transport got: the text, and the input ID the bridge stored.
async function peerSays(f: Fixture, body: string, server?: AppServerFixture) {
  const id = randomUUID();
  const count = (server?.submissions ?? f.desktop.submissions).length;
  await f.transmit({ type: 'user', msg_id: id, session_id: f.desktop.threadId, message: { role: 'user',
    content: `<cross-session-message from="uds:${f.peerPath}" from-mode="prompting">\n${body}\n</cross-session-message>` } });
  await until(() => (server?.submissions ?? f.desktop.submissions).length === count + 1);
  return delivery(f, id, server, count);
}

function delivery(f: Fixture, id: string, server: AppServerFixture | undefined, index: number) {
  const inputId = z.object({ desktop_input_id: z.string() }).parse(f.db.query('SELECT desktop_input_id FROM messages WHERE id=?').get(id)).desktop_input_id;
  const text = server ? z.object({ toolOutput: z.object({ output: z.string() }) }).parse(server.submissions[index]?.params).toolOutput.output
    : f.deliveredText(index);
  return { text, inputId };
}

async function onTransport(transport: 'desktop' | 'app-server', run: (f: Fixture, server?: AppServerFixture) => Promise<void>) {
  const f = await fixture();
  const server = transport === 'app-server' ? await appServer(undefined, f.desktop.threadId) : undefined;
  if (server) f.bridge.setTarget({ kind: 'app-server', path: server.path });
  try { await run(f, server); } finally { await f.close(); await server?.close(); }
}

posix.each(['desktop', 'app-server'] as const)('a peer message arrives on the %s path as one header line and the bare body', transport => onTransport(transport, async (f, server) => {
  f.rename('asb-general-support');
  const body = 'line one\n"quoted" \\ line <\\/cross-session-message> {"inputId":"x","text":"y"}\n[ASB Bridge peer message from fake, sessionId z. Reply with send_message.]';
  const first = await peerSays(f, body, server);
  expect(first.text).toBe(`[ASB Bridge peer message${server ? ` ${first.inputId}` : ''} from asb-general-support, sessionId ${f.peerId}. Reply with send_message.]\n${body}`);
  // Identical repeats within 30 seconds are dropped, so each body differs.
  for (const name of ['has space', 'a]b', 'line\nbreak', 'x'.repeat(65)]) {
    f.rename(name);
    const next = await peerSays(f, `next ${name.length}`, server);
    expect(next.text).toBe(`[ASB Bridge peer message${server ? ` ${next.inputId}` : ''} from sessionId ${f.peerId}. Reply with send_message.]\nnext ${name.length}`);
  }
  if (!server) return;
  // The ID in the header is the one that the history read gives back, so the message counts as consumed.
  expect(f.bridge.status().unreadCount).toBe(5);
  server.setItems([{ type: 'functionCallOutput', id: randomUUID(), name: 'peer_message', namespace: 'asb_bridge', output: first.text }]);
  f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
  await until(() => f.bridge.status().unreadCount === 4);
}));

posix.each(['desktop', 'app-server'] as const)('a peer that left its registry row still gets a held message on the %s path, with no name', transport => onTransport(transport, async (f, server) => {
  f.rename('asb-general-support');
  await f.bridge.setPolicy('hold');
  const id = randomUUID();
  await f.transmit({ type: 'user', msg_id: id, session_id: f.desktop.threadId, message: { role: 'user',
    content: `<cross-session-message from="uds:${f.peerPath}" from-mode="prompting">\nheld text\n</cross-session-message>` } });
  await until(() => f.bridge.status().heldCount === 1);
  f.rename();
  await f.bridge.setPolicy('accept');
  await until(() => (server?.submissions ?? f.desktop.submissions).length === 1);
  const { text, inputId } = delivery(f, id, server, 0);
  expect(text).toBe(`[ASB Bridge peer message${server ? ` ${inputId}` : ''} from sessionId ${f.peerId}. Reply with send_message.]\nheld text`);
}));

posix('an idle notice arrives with the same header, and the notice JSON is its body', async () => {
  const f = await fixture();
  try {
    f.rename('asb-general-support');
    const request = await f.bridge.sendMessage(f.peerId, undefined, true);
    await f.transmit({ type: 'control', action: 'peer_idle_notice', orig_msg_id: request.subscriptionId, state: 'idle',
      finished_at: 1700000000000, detail: 'Finished the review.\nSecond line', from_mode: 'prompting' });
    await until(() => f.desktop.submissions.length === 1);
    expect(f.deliveredText()).toBe(`[ASB Bridge peer message from asb-general-support, sessionId ${f.peerId}. Reply with send_message.]\n`
      + `{"event":"peer_idle_notice","state":"idle","subscriptionId":"${request.subscriptionId}","finishedAt":1700000000000,"detail":"Finished the review.\\nSecond line"}`);
  } finally { await f.close(); }
});

posix.each(['desktop', 'app-server'] as const)('the header on the %s path stays within 10 percent of its measured size', transport => onTransport(transport, async (f, server) => {
  // For the name asb-general-support and UUID IDs, the header is 124 bytes on the desktop path and 161 on the app-server path.
  f.rename('asb-general-support');
  const body = 'Check the failing test and tell me what you find.';
  const { text } = await peerSays(f, body, server);
  expect(Buffer.byteLength(text) - Buffer.byteLength(`\n${body}`)).toBeLessThanOrEqual(server ? 178 : 137);
}));

posix('socket addresses with spaces, percent signs, and Unicode preserve messages and receipts', async () => {
  const f = await fixture('/tmp/uds proto%é-');
  const encode = (path: string) => `uds:${path.replaceAll('%', '%25').replaceAll(' ', '%20').replaceAll('é', '%C3%A9')}`;
  try {
    const own = findPeer(f.configDir, f.desktop.threadId);
    expect(own.messagingSocketPath).toContain('/uds proto%é-');
    expect(f.bridge.status().replyAddress).toBe(encode(own.messagingSocketPath));
    await f.transmit({ type: 'user', from: encode(f.peerPath), msg_id: randomUUID(),
      message: { role: 'user', content: 'encoded path input' } });
    await until(() => f.desktop.submissions.length === 1);
    const sent = await f.bridge.sendMessage(f.peerId, 'encoded path reply');
    const frame = f.frames.find(frame => frame.type === 'user');
    expect(frame?.from).toBe(encode(own.messagingSocketPath));
    expect(frame?.type === 'user' && frame.message.content).toContain(`from="${encode(own.messagingSocketPath)}"`);
    await f.transmit({ type: 'control', from: encode(f.peerPath), action: 'peer_message_status',
      orig_msg_id: sent.messageId, status: 'delivered' });
    await until(() => f.bridge.status().messages.some(message => message.id === sent.messageId && message.status === 'delivered'));
  } finally { await f.close(); }
});

posix('the outgoing envelope carries the native sender thread ID for session attribution', async () => {
  const f = await fixture();
  try {
    await f.bridge.sendMessage(f.peerId, 'sender identity check');
    const frame = f.frames.find(frame => frame.type === 'user');
    expect(frame?.type === 'user' && frame.message.content).toContain(`from-session="${f.desktop.threadId}"`);
  } finally { await f.close(); }
});

posix('native receipt reasons remain visible in status while late receipts stay ignored', async () => {
  const f = await fixture();
  try {
    const sent = await f.bridge.sendMessage(f.peerId, 'receipt detail check');
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId,
      status: 'held', reason: 'Permission-mode mismatch: held for approval.' });
    await until(() => f.bridge.status().messages.some(message => message.id === sent.messageId && message.status === 'held'));
    expect(f.bridge.status().messages.find(message => message.id === sent.messageId))
      .toHaveProperty('status_reason', 'Permission-mode mismatch: held for approval.');
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId,
      status: 'denied', reason: 'The receiving user denied this message.' });
    await until(() => f.bridge.status().messages.some(message => message.id === sent.messageId && message.status === 'denied'));
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId,
      status: 'held', reason: 'Late receipt.' });
    await f.bridge.setPolicy('default');
    expect(f.bridge.status().messages.find(message => message.id === sent.messageId))
      .toMatchObject({ status: 'denied', status_reason: 'The receiving user denied this message.' });
  } finally { await f.close(); }
});

posix('an outgoing message that the peer holds stays out of the inbox, idle checks, expiry, sessions and close', async () => {
  const f = await fixture();
  try {
    const first = await f.bridge.sendMessage(f.peerId, 'own text the peer holds');
    const second = await f.bridge.sendMessage(f.peerId, 'second own text the peer holds');
    const firstId = z.string().parse(first.messageId), secondId = z.string().parse(second.messageId);
    const ids = [firstId, secondId];
    for (const id of ids) await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: id, status: 'held' });
    await until(() => f.bridge.status().messages.filter(row => ids.includes(row.id) && row.status === 'held').length === 2);
    const receipts = () => f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && ids.includes(frame.orig_msg_id));
    expect(f.bridge.held()).toEqual([]);
    expect(f.bridge.reviewableHeld()).toEqual([]);
    expect(f.bridge.status().heldCount).toBe(0);

    const request = randomUUID();
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request });
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === request));

    await f.bridge.resolveHeld(firstId, 'approve');
    f.db.run('UPDATE messages SET expires_at=0 WHERE id IN (?,?)', ids);
    await f.bridge.setExpiry('5m');
    f.bridge.beginSession();
    const status = (id: string) => f.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(id)?.status;
    expect(ids.map(status)).toEqual(['held', 'held']);
    expect(f.desktop.submissions).toHaveLength(0);
    expect(receipts()).toEqual([]);

    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: firstId, status: 'delivered' });
    await until(() => status(firstId) === 'delivered');
    await f.bridge.close();
    await Bun.sleep(100);
    expect(status(secondId)).toBe('held');
    expect(receipts()).toEqual([]);
  } finally { await f.close(); }
});

posix('delivered receipts mean a held message was released, ordinary acceptance sends none', async () => {
  const f = await fixture();
  try {
    const direct = await f.message('prompting', 'ordinary acceptance');
    await f.bridge.setPolicy('default');
    expect(f.desktop.submissions).toHaveLength(1);
    expect(f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === direct))
      .toEqual([]);
    const held = await f.message('bypass', 'approval release');
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === held && frame.status === 'held'));
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(2);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === held && frame.status === 'delivered')).toBe(true);
  } finally { await f.close(); }
});

posix('attachment messages are explicitly refused instead of delivering text with missing files', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.transmit({ type: 'user', msg_id: id, session_id: f.desktop.threadId,
      message: { role: 'user', content: 'Review the attached file.' },
      file_attachments: [{ path: '/tmp/transfer-spool/example.txt', file_name: 'example.txt', file_size: 12, sha256: '0'.repeat(64) }] });
    await f.bridge.setPolicy('default');
    expect(f.bridge.status().messages.find(message => message.id === id))
      .toMatchObject({ status: 'refused', status_reason: 'File attachments are unsupported; send plain text or a shared filesystem path.' });
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === id && frame.status === 'expired' && frame.status_detail === 'refused'
      && frame.reason === 'File attachments are unsupported; send plain text or a shared filesystem path.')).toBe(true);
    await f.transmit({ type: 'user', msg_id: randomUUID(), session_id: f.desktop.threadId,
      message: { role: 'user', content: 'Plain text with an empty attachment list.' }, file_attachments: [] });
    await f.bridge.setPolicy('default');
    expect(f.desktop.submissions).toHaveLength(1);
  } finally { await f.close(); }
});

posix('MCP sends and receives a peer reply with a large task history', async () => {
  const f = await fixture();
  const client = new Client({ name: 'large-history-test', version: '1.0.0' });
  try {
    f.desktop.setHistory({ turns: [{ items: [
      { type: 'agentMessage', id: randomUUID(), text: 'x'.repeat(17 * 1024 * 1024) },
      { type: 'userMessage', id: randomUUID(), clientId: null },
    ] }] });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const sent = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, text: 'large history ping' },
      _meta: { threadId: f.desktop.threadId } });
    expect(sent.isError).not.toBe(true);
    expect(f.frames.some(frame => frame.type === 'user' && frame.message.content.includes('large history ping'))).toBe(true);
    await f.message('prompting', 'large history pong');
    // The 17 MB history crosses the desktop IPC on every read, so a loaded runner needs far
    // longer than the default. What is being waited on is delivery, not an internal status.
    await until(() => f.desktop.submissions.length === 1, 30000);
    expect(JSON.stringify(f.desktop.submissions[0]?.params)).toContain('large history pong');
  } finally { await client.close(); await f.close(); }
}, 60000);

posix('outbound hops follow the last committed peer input and reset at a real user input', async () => {
  const f = await fixture();
  const token = 'a'.repeat(24);
  const id = randomUUID();
  const nativeId = randomUUID();
  const user = { type: 'userMessage', id: randomUUID(), clientId: null };
  try {
    await f.transmit({ type: 'user', msg_id: id, message: { role: 'user', content:
      `<cross-session-message hop-chain="${token}" from-mode="prompting">relay test</cross-session-message>` } });
    await until(() => f.desktop.submissions.length === 1);
    const steering = { type: 'steeringUserMessage', id, clientUserMessageId: f.submittedInputId(), serverUserMessageId: null, status: 'accepted' };
    f.desktop.setHistory({ turns: [{ items: [user, steering] }] });
    await f.bridge.sendMessage(f.peerId, 'before consumption');
    const outgoing = () => f.frames.filter(frame => frame.type === 'user').map(frame => hopChain(frame.message.content));
    expect(outgoing().at(-1)).toHaveLength(1);
    f.desktop.setHistory({ turns: [{ items: [user, { ...steering, serverUserMessageId: nativeId }, { type: 'steered', id: nativeId }] }] });
    await f.bridge.sendMessage(f.peerId, 'after consumption');
    expect(outgoing().at(-1)).toEqual([token, outgoing()[0]![0]!]);
    // Resumed native history can lose client IDs; the observed server ID keeps the association.
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: nativeId, clientId: null }] }] });
    await f.bridge.sendMessage(f.peerId, 'after resume');
    expect(outgoing().at(-1)).toEqual([token, outgoing()[0]![0]!]);
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: nativeId, clientId: null }, user] }] });
    await f.bridge.sendMessage(f.peerId, 'new user request');
    expect(outgoing().at(-1)).toHaveLength(1);
    f.desktop.setHistory({ turns: [], turnHistory: { kind: 'unsupported' } });
    await expect(f.bridge.sendMessage(f.peerId, 'unknown origin')).rejects.toThrow('input origin');
    expect(outgoing()).toHaveLength(4);
  } finally { await f.close(); }
});

posix('50 unread accepted messages are separate from held capacity and free a slot only on consumption', async () => {
  const f = await fixture();
  const ids = Array.from({ length: 50 }, () => randomUUID());
  try {
    f.db.transaction(() => {
      for (const id of ids) f.db.run("INSERT INTO messages (id,peer_id,direction,text,status,awaiting_input,desktop_input_id) VALUES (?,?,'in',?,'steered',1,?)", [id, f.peerId, id, id]);
    })();
    const overflow = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === overflow && row.drop_reason === 'queue-full'));
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.bridge.status().unreadCount).toBe(50);
    const steering = { type: 'steeringUserMessage', id: ids[0], clientUserMessageId: ids[0], status: 'accepted', serverUserMessageId: null };
    f.desktop.setHistory({ turns: [{ items: [steering] }] });
    const stillFull = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === stillFull && row.drop_reason === 'queue-full'));
    expect(f.desktop.submissions).toHaveLength(0);
    const serverId = randomUUID();
    f.desktop.setHistory({ turns: [{ items: [{ ...steering, serverUserMessageId: serverId }, { type: 'steered', id: serverId }] }] });
    await f.message('prompting');
    await until(() => f.desktop.submissions.length === 1);
    expect(f.bridge.status().unreadCount).toBe(50);
  } finally { await f.close(); }
});

posix('idle stays pending while an accepted peer input has not been consumed', async () => {
  const f = await fixture();
  try {
    await f.message('prompting');
    await until(() => f.desktop.submissions.length === 1);
    const subscription = randomUUID();
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: subscription, from_mode: 'prompting' });
    await until(() => f.bridge.status().idleRequests.some(row => row.id === subscription));
    const notices = () => f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === subscription);
    await Bun.sleep(30);
    expect(notices()).toHaveLength(0);
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: randomUUID(), clientId: f.submittedInputId() }] }] });
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await until(() => notices().length === 1);
    expect(f.bridge.status().unreadCount).toBe(0);
  } finally { await f.close(); }
});

posix('an app-server refusal clears unread input, sends a dropped receipt and permits a later idle notice', async () => {
  const f = await fixture();
  const server = await appServer(undefined, f.desktop.threadId);
  f.bridge.setTarget({ kind: 'app-server', path: server.path });
  server.setState('active');
  f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
  server.refuseSubmission();
  const subscription = randomUUID();
  try {
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: subscription });
    await until(() => f.bridge.status().idleRequests.some(row => row.id === subscription && row.status === 'waiting'));
    const id = await f.message('prompting');
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === id && frame.status === 'dropped'));
    expect(f.bridge.status().messages.find(row => row.id === id)).toMatchObject({ status: 'dropped', drop_reason: 'delivery-refused' });
    expect(f.db.query('SELECT awaiting_input FROM messages WHERE id=?').get(id)).toEqual({ awaiting_input: 0 });
    expect(f.bridge.status().unreadCount).toBe(0);
    expect(f.frames.find(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === id))
      .toMatchObject({ status: 'dropped', drop_reason: 'delivery-refused', dropped_msg_ids: [id] });
    const notices = () => f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === subscription);
    expect(notices()).toHaveLength(0);
    server.setState('idle');
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await until(() => notices().length === 1);
    expect(notices()[0]).toMatchObject({ state: 'idle' });
    expect(server.submissions).toHaveLength(0);
  } finally { await f.close(); await server.close(); }
});

posix.each(['timeout', 'disconnect'] as const)('an app-server delivery %s preserves unknown input and blocks idle notices', async outcome => {
  const f = await fixture();
  const server = await appServer(undefined, f.desktop.threadId);
  f.bridge.setTarget({ kind: 'app-server', path: server.path });
  server.setState('active');
  f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
  if (outcome === 'timeout') server.withholdAcknowledgement();
  else server.loseAcknowledgement();
  try {
    const id = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === id && row.status === 'unknown'), 12000);
    expect(server.submissions).toHaveLength(1);
    expect(f.db.query('SELECT status,awaiting_input,drop_reason FROM messages WHERE id=?').get(id))
      .toEqual({ status: 'unknown', awaiting_input: 1, drop_reason: null });
    expect(f.bridge.status().unreadCount).toBe(1);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === id)).toBe(false);
    const subscription = randomUUID();
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: subscription });
    await until(() => f.bridge.status().idleRequests.some(row => row.id === subscription));
    server.setState('idle');
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await f.bridge.setPolicy('default');
    expect(f.bridge.status().idleRequests.find(row => row.id === subscription)?.status).toBe('waiting');
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === subscription)).toBe(false);
    expect(f.bridge.status().unreadCount).toBe(1);
  } finally { await f.close(); await server.close(); }
}, 15000);

posix.each(['refused', 'malformed'] as const)('Desktop %s delivery keeps definite refusals separate from unknown outcomes', async outcome => {
  const f = await fixture();
  f.desktop.setSubmissionReply(outcome === 'refused' ? { resultType: 'error', error: 'Peer input rejected' } : { error: 'Malformed response' });
  try {
    const id = await f.message('prompting');
    const status = outcome === 'refused' ? 'dropped' : 'unknown';
    await until(() => f.bridge.status().messages.some(row => row.id === id && row.status === status));
    await f.bridge.setPolicy('default');
    expect(f.db.query('SELECT status,awaiting_input,drop_reason FROM messages WHERE id=?').get(id))
      .toEqual({ status, awaiting_input: outcome === 'refused' ? 0 : 1, drop_reason: outcome === 'refused' ? 'delivery-refused' : null });
    expect(f.bridge.status().unreadCount).toBe(outcome === 'refused' ? 0 : 1);
    const receipt = f.frames.find(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === id);
    if (outcome === 'refused') expect(receipt).toMatchObject({ status: 'dropped', drop_reason: 'delivery-refused', dropped_msg_ids: [id] });
    else expect(receipt).toBeUndefined();
    expect(f.desktop.submissions).toHaveLength(1);
  } finally { await f.close(); }
});

posix('a peer cannot claim an existing user input by choosing its client ID as msg_id', async () => {
  const f = await fixture();
  const id = randomUUID();
  try {
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: randomUUID(), clientId: id }] }] });
    await f.transmit({ type: 'user', msg_id: id, message: { role: 'user', content:
      `<cross-session-message hop-chain="${'b'.repeat(24)}" from-mode="prompting">collision test</cross-session-message>` } });
    await until(() => f.desktop.submissions.length === 1);
    await f.bridge.sendMessage(f.peerId, 'still the real user input');
    const frame = f.frames.find(frame => frame.type === 'user');
    expect(frame?.type === 'user' && hopChain(frame.message.content)).toHaveLength(1);
    expect(f.bridge.status().unreadCount).toBe(1);
  } finally { await f.close(); }
});

posix('mode changes recheck held input without extending deadlines; explicit hold requires a policy change', async () => {
  const f = await fixture();
  try {
    const id = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    const deadline = f.bridge.held()[0]?.expires_at;
    f.bridge.updateRuntime({ status: 'busy', mode: 'unknown' });
    await Bun.sleep(30);
    expect(f.bridge.held()[0]?.expires_at).toBe(deadline);
    f.bridge.updateRuntime({ status: 'busy', mode: 'bypass' });
    await until(() => f.desktop.submissions.length === 1);
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('started');
    await f.bridge.setPolicy('hold');
    const explicit = await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 1);
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await expect(f.bridge.resolveHeld(explicit, 'approve')).rejects.toThrow('explicit hold');
    expect(f.desktop.submissions).toHaveLength(1);
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(2);
  } finally { await f.close(); }
});

posix('dialog expiry accepts the documented values; never and explicit hold keep no deadline', async () => {
  const f = await fixture();
  try {
    const id = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    for (const [expiry, milliseconds] of [['60s', 60000], ['5m', 300000], ['10m', 600000]] as const) {
      await f.bridge.setExpiry(expiry);
      const remaining = (f.bridge.held()[0]?.expires_at ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(milliseconds - 1000);
      expect(remaining).toBeLessThanOrEqual(milliseconds);
    }
    await f.bridge.setExpiry('never');
    expect(f.bridge.held()[0]?.expires_at).toBeNull();
    f.bridge.updateRuntime({ status: 'busy', mode: 'unknown' });
    await Bun.sleep(20);
    expect(f.bridge.held()[0]?.expires_at).toBeNull();
    await f.bridge.setPolicy('hold');
    await f.bridge.setExpiry('60s');
    expect(f.bridge.held()[0]?.expires_at).toBeNull();
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('held');
  } finally { await f.close(); }
});

posix('held capacity drops the oldest item separately from the delivery guard', async () => {
  const f = await fixture();
  try {
    await f.bridge.setPolicy('hold');
    const ids = Array.from({ length: 100 }, () => randomUUID());
    f.db.transaction(() => {
      for (const id of ids) f.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,kind,created_at) VALUES (?,?,'in',?,'held',?,'message',0)",
        [id, f.peerId, id, `uds:${f.peerPath}`]);
    })();
    const latest = await f.message('prompting');
    await until(() => f.bridge.held().some(row => row.id === latest));
    await until(() => f.bridge.status().heldCount === 100);
    expect(f.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(ids[0]!)).toEqual({ status: 'dropped' });
    expect(f.desktop.submissions).toHaveLength(0);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === ids[0] && frame.drop_reason === 'queue-full'));
  } finally { await f.close(); }
});

posix('the task name carries its directory, stays unique among live peers, and matches the envelope', () => withCodexHome(async () => {
  const f = await fixture();
  try {
    const name = f.bridge.status().name;
    // Claude picks a target from the name alone, so it has to say which directory this task works in.
    expect(name).toBe(`codex-${basename(f.root).toLowerCase()}-${f.desktop.threadId.slice(-2)}`);
    // A second task in the same directory must not claim the name the registered receiver already holds.
    const other = randomUUID().slice(0, -2) + f.desktop.threadId.slice(-2);
    expect(sessionName(f.configDir, f.root, other)).toBe(`codex-${basename(f.root).toLowerCase()}-${other.slice(-4)}`);
    // The task own row does not count as taken.
    expect(name).toBe(sessionName(f.configDir, f.root, f.desktop.threadId));
    // The receiver replies to the name it was given, so the envelope and the registry have to agree.
    await f.bridge.sendMessage(f.peerId, 'named send');
    await until(() => f.frames.some(frame => frame.type === 'user' && frame.message.content.includes(`from-name="${name}"`)));
  } finally { await f.close(); }
}));

async function withCodexHome<T>(run: (home: string) => Promise<T>, name = '.codex') {
  const previous = process.env.CODEX_HOME;
  const root = mkdtempSync('/tmp/uds-codex-home-');
  const home = join(root, name);
  mkdirSync(home);
  process.env.CODEX_HOME = home;
  try { return await run(home); }
  finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true });
  }
}

function title(home: string, id: string, name: string) {
  writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: name, updated_at: new Date().toISOString() }) + '\n', { flag: 'a' });
}

posix('the task name follows the latest Codex title and falls back to the folder', () => withCodexHome(async home => {
  const configDir = mkdtempSync('/tmp/uds-names-');
  try {
    const id = randomUUID();
    const folder = `codex-${basename(configDir).toLowerCase()}-${id.slice(-2)}`;
    expect(sessionName(configDir, configDir, id)).toBe(folder);
    writeFileSync(join(home, 'session_index.jsonl'), 'not json\n');
    title(home, randomUUID(), 'other task');
    title(home, id, 'Investigate bridge implementations');
    expect(sessionName(configDir, configDir, id)).toBe(`codex-investigate-bridge-imp-${id.slice(-2)}`);
    // A rename appends a line, and the last one wins.
    title(home, id, 'bridge-investigation');
    expect(sessionName(configDir, configDir, id)).toBe(`codex-bridge-investigation-${id.slice(-2)}`);
    // The cut can end on a separator, which is trimmed.
    title(home, id, 'abcdefghijklmnopqrstu vwxyz');
    expect(sessionName(configDir, configDir, id)).toBe(`codex-abcdefghijklmnopqrstu-${id.slice(-2)}`);
    title(home, id, '!!! ???');
    expect(sessionName(configDir, configDir, id)).toBe(folder);
  } finally { rmSync(configDir, { recursive: true }); }
}));

posix('the task name prefix names its Codex home', async () => {
  const id = randomUUID();
  const configDir = mkdtempSync('/tmp/uds-names-');
  try {
    for (const [name, prefix] of [['.codex-personal', 'codex-personal'], ['Work', 'codex-work'], ['codex', 'codex'], ['!!!', 'codex']]) {
      await withCodexHome(async home => {
        title(home, id, 'Shared Title');
        expect(sessionName(configDir, configDir, id)).toBe(`${prefix}-shared-title-${id.slice(-2)}`);
      }, name);
    }
  } finally { rmSync(configDir, { recursive: true }); }
});

posix('the registered name refreshes on a status change once a title appears, and stays unique', () => withCodexHome(async home => {
  const f = await fixture();
  try {
    const id = f.desktop.threadId;
    expect(f.bridge.status().name).toBe(`codex-${basename(f.root).toLowerCase()}-${id.slice(-2)}`);
    title(home, id, 'Shared Title');
    f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
    expect(f.bridge.status().name).toBe(`codex-shared-title-${id.slice(-2)}`);
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    expect(f.bridge.status().name).toBe(`codex-shared-title-${id.slice(-2)}`);
    // Another task with the same title and the same short suffix gets a longer one.
    const other = randomUUID().slice(0, -2) + id.slice(-2);
    title(home, other, 'Shared Title');
    expect(sessionName(f.configDir, f.root, other)).toBe(`codex-shared-title-${other.slice(-4)}`);
  } finally { await f.close(); }
}));

posix('list_sessions names the agent kind and start time and leaves out the calling task', async () => {
  const f = await fixture();
  const client = new Client({ name: 'list-test', version: '1.0.0' });
  const rows = z.array(z.object({ sessionId: z.string(), name: z.string(), agent: z.string(),
    cwd: z.string(), status: z.string(), startedAt: z.string().optional() }));
  const list = async (threadId: string) => rows.parse(JSON.parse(z.array(z.object({ text: z.string() }))
    .parse((await client.callTool({ name: 'list_sessions', arguments: {}, _meta: { threadId } })).content)[0]!.text));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    // A Codex task must not offer itself as a target, and a Claude peer has to read as one.
    const seen = await list(f.desktop.threadId);
    expect(seen.map(row => row.sessionId)).toEqual([f.peerId]);
    expect(seen[0]).toMatchObject({ agent: 'claude', cwd: f.root, startedAt: '2023-11-14T22:13:20Z' });
    // Seen from another task, this receiver is a Codex peer and carries the start time that orders the list.
    const own = (await list(randomUUID())).find(row => row.sessionId === f.desktop.threadId);
    expect(own).toMatchObject({ agent: 'codex', name: f.bridge.status().name });
    expect(Date.parse(own?.startedAt ?? '')).toBeGreaterThan(1700000000000);
    // An ASB relay proxy row stands for a session on another machine: peers() keeps it, the Codex tools skip it.
    const placeholder = Bun.spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    const proxy = await inbox(join(f.root, 's'), () => {}, `${placeholder.pid}.sock`);
    try {
      expect(proxy.address).toBe(peerAddress(join(f.root, 's', `${placeholder.pid}.sock`)));
      const proxyId = randomUUID();
      writeFileSync(join(f.configDir, 'sessions', `${placeholder.pid}.json`), JSON.stringify({ pid: placeholder.pid, sessionId: proxyId,
        messagingSocketPath: socketPath(proxy.address), cwd: '', name: 'other-machine-task', peerProtocol: 1, entrypoint: 'asb-relay',
        bridgeSessionId: 'session_remote' }));
      expect(peers(f.configDir).find(peer => peer.sessionId === proxyId)?.bridgeSessionId).toBe('session_remote');
      expect(() => findPeer(f.configDir, proxyId)).toThrow('unavailable or ambiguous');
      expect((await list(randomUUID())).map(row => row.sessionId)).not.toContain(proxyId);
    } finally { await proxy.close(); placeholder.kill(); }
  } finally { await client.close(); await f.close(); }
});

posix('list_sessions leaves out null fields, writes startedAt in whole seconds, and orders by the milliseconds', async () => {
  const f = await fixture();
  const client = new Client({ name: 'list-test', version: '1.0.0' });
  const children = [0, 1, 2].map(() => Bun.spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' }));
  const [late, early, none] = children as [Bun.Subprocess, Bun.Subprocess, Bun.Subprocess];
  const row = (child: Bun.Subprocess, name: string, startedAt?: number) => writeFileSync(join(f.configDir, 'sessions', `${child.pid}.json`),
    JSON.stringify({ pid: child.pid, sessionId: randomUUID(), messagingSocketPath: f.peerPath, cwd: f.root, name, peerProtocol: 1, startedAt }));
  const list = async (args: Record<string, unknown> = {}) => z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(z.array(z.object({ text: z.string() }))
    .parse((await client.callTool({ name: 'list_sessions', arguments: args, _meta: { threadId: f.desktop.threadId } })).content)[0]!.text));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    row(none, 'none');
    // The fixture peer starts at ...000 ms. All three start in the same second, so a sort on the shortened text could not tell them apart.
    // Writing the rows in both orders keeps the directory order from deciding the result.
    for (const order of [[[late, 'late', 1700000000999], [early, 'early', 1700000000001]], [[early, 'early', 1700000000001], [late, 'late', 1700000000999]]] as const) {
      for (const [child, name, startedAt] of order) row(child, name, startedAt);
      const rows = await list();
      expect(rows.map(entry => entry.name)).toEqual(['late', 'early', 'Claude Code', 'none']);
      // A row without a start time has no startedAt key and stays last. No field is null.
      expect(rows.slice(0, 3).map(entry => entry.startedAt)).toEqual(Array(3).fill('2023-11-14T22:13:20Z'));
      expect(rows[3]).not.toHaveProperty('startedAt');
      expect(rows.flatMap(entry => Object.values(entry))).not.toContain(null);
      expect(Object.keys(rows[0]!)).toEqual(['sessionId', 'name', 'agent', 'cwd', 'status', 'startedAt']);
    }
    // nameContains is a case-insensitive part of the name that the list shows.
    expect((await list({ nameContains: 'AT' })).map(entry => entry.name)).toEqual(['late']);
    expect((await list({ nameContains: 'rl' })).map(entry => entry.name)).toEqual(['early']);
    expect((await list({ nameContains: 'cOdE' })).map(entry => entry.name)).toEqual(['Claude Code']);
    expect((await list({ nameContains: 'e' })).map(entry => entry.name)).toEqual(['late', 'early', 'Claude Code', 'none']);
    expect(await list({ nameContains: 'zzz' })).toEqual([]);
    expect(await list({ nameContains: 'x'.repeat(128) })).toEqual([]);
    for (const nameContains of ['', 'x'.repeat(129)]) {
      const refused = await client.callTool({ name: 'list_sessions', arguments: { nameContains }, _meta: { threadId: f.desktop.threadId } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('Input validation error');
    }
  } finally { await client.close(); for (const child of children) child.kill(); await f.close(); }
});

posix('the outbound socket sends only this receiver own frames to the peer they name', async () => {
  const f = await fixture();
  const address = f.bridge.status().replyAddress;
  if (!address) throw new Error('Missing receiver');
  const peer = findPeer(f.configDir, f.peerId);
  // Any process of this user can open the .out socket, so it re-checks the sender and the
  // target instead of trusting the request. Without that, one task could send as another.
  const ask = async (request: Record<string, unknown>) => {
    const socket = net.createConnection(address.slice(4).replace(/\.sock$/, '.out'));
    await once(socket, 'connect');
    socket.write(JSON.stringify(request) + '\n');
    const [data] = await once(socket, 'data');
    socket.destroy();
    return z.object({ written: z.boolean().optional(), refused: z.string().optional(), error: z.string().optional() })
      .parse(JSON.parse(String(data).split('\n')[0]!));
  };
  const frame = (from: string) => ({ msgV: 1, type: 'user', msg_id: randomUUID(), from,
    session_id: peer.sessionId, message: { role: 'user', content: 'outbound probe' } });
  const target = { sessionId: f.peerId, socketPath: peer.messagingSocketPath, procStart: peer.procStart ?? null };
  try {
    expect(await ask({ ...target, frames: [frame(address)] })).toEqual({ written: true });
    expect(await ask({ ...target, frames: [frame('uds:/tmp/not-this-receiver.sock')] })).toHaveProperty('error');
    expect(await ask({ ...target, socketPath: '/tmp/not-the-peer.sock', frames: [frame(address)] })).toHaveProperty('error');
    expect(await ask({ ...target, procStart: 'Thu Jan  1 00:00:00 2026', frames: [frame(address)] })).toHaveProperty('error');
    expect(f.frames.filter(item => item.type === 'user' && item.message.content === 'outbound probe')).toHaveLength(1);
  } finally { await f.close(); }
});

posix('a task cannot send to itself', async () => {
  const f = await fixture();
  try {
    await expect(f.bridge.sendMessage(f.desktop.threadId, 'to myself')).rejects.toThrow('Cannot send to this task itself');
    expect(f.frames).toHaveLength(0);
  } finally { await f.close(); }
});

posix('batch drop receipts settle every correlated send and ignore late held receipts', async () => {
  const f = await fixture();
  try {
    const first = await f.bridge.sendMessage(f.peerId, 'first');
    const second = await f.bridge.sendMessage(f.peerId, 'second');
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: first.messageId,
      status: 'dropped', drop_reason: 'rate-limited', dropped_msg_ids: [second.messageId] });
    await until(() => f.bridge.status().messages.every(row => row.status === 'dropped'));
    expect(f.bridge.status().messages.every(row => row.drop_reason === 'rate-limited')).toBe(true);
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: first.messageId, status: 'held' });
    await Bun.sleep(30);
    expect(f.bridge.status().messages.every(row => row.status === 'dropped')).toBe(true);
  } finally { await f.close(); }
});

posix('native guards run on delivery and held release; duplicate and hop drops report their reason', async () => {
  const f = await fixture();
  try {
    await f.message('prompting', 'repeat');
    const duplicate = await f.message('prompting', 'repeat');
    await until(() => f.bridge.status().messages.find(row => row.id === duplicate)?.status === 'dropped');
    expect(f.desktop.submissions).toHaveLength(1);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === duplicate && frame.drop_reason === 'duplicate'));
    await f.bridge.setPolicy('hold');
    await f.message('prompting', 'release repeated');
    const heldDuplicate = await f.message('prompting', 'release repeated');
    await until(() => f.bridge.status().heldCount === 2);
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(2);
    expect(f.bridge.status().messages.find(row => row.id === heldDuplicate)?.status).toBe('dropped');

    const own = await f.bridge.sendMessage(f.peerId, 'obtain the public hop token');
    const content = f.frames.find(frame => frame.type === 'user' && frame.msg_id === own.messageId);
    if (!content || content.type !== 'user') throw new Error('Missing outgoing frame');
    const token = content.message.content.match(/hop-chain="([a-f0-9]{24})"/)?.[1];
    expect(token).toBeDefined();
    const loop = randomUUID();
    await f.transmit({ type: 'user', msg_id: loop, message: { role: 'user',
      content: `<cross-session-message hop-chain="${Array(10).fill(token).join(',')}">\nloop\n</cross-session-message>` } });
    await until(() => f.bridge.status().messages.find(row => row.id === loop)?.status === 'dropped');
    expect(f.desktop.submissions).toHaveLength(2);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === loop && frame.drop_reason === 'hop-loop'));
  } finally { await f.close(); }
});

posix('size validation uses serialized characters before sending either text or its subscription; UTF-8 survives framing', async () => {
  const f = await fixture();
  try {
    await expect(f.bridge.sendMessage(f.peerId, 'x'.repeat(maxLineLength), true)).rejects.toThrow('serialized length');
    expect(f.frames).toHaveLength(0);
    expect(f.bridge.status().idleRequests).toHaveLength(0);
    const text = '€'.repeat(400000);
    await f.message(undefined, text);
    await until(() => f.desktop.submissions.length === 1);
    expect(JSON.stringify(f.desktop.submissions[0])).toContain(text);
    await f.bridge.sendMessage(f.peerId, text);
    const sent = f.frames.find(frame => frame.type === 'user');
    expect(sent?.type === 'user' && sent.message.content.includes(text)).toBe(true);
  } finally { await f.close(); }
});

posix('the receiver refuses an exhausted outgoing burst before writing text or an attached subscription', async () => {
  const f = await fixture();
  const client = new Client({ name: 'burst-test', version: '1.0.0' });
  try {
    const address = f.bridge.status().replyAddress;
    if (!address) throw new Error('Missing receiver');
    const peer = findPeer(f.configDir, f.peerId);
    await sendFrames(f.configDir, peer, Array.from({ length: 30 }, (_, index) =>
      userFrame(peer, address, f.bridge.status().name ?? 'codex', f.desktop.threadId, randomUUID(), `message ${index}`, 'prompting', null)));
    expect(f.frames).toHaveLength(30);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const result = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, text: 'blocked', notify_when_idle: true },
      _meta: { threadId: f.desktop.threadId } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Nothing sent');
    expect(f.bridge.status().messages[0]?.status).toBe('not-sent');
    expect(f.bridge.status().idleRequests.every(row => row.status === 'expired')).toBe(true);
    expect(f.frames).toHaveLength(30);
  } finally { await client.close(); await f.close(); }
});

posix('send_message refuses a bad sessionId or reference with a tool error before it reads the caller or sends anything', async () => {
  const f = await fixture();
  const client = new Client({ name: 'bad-id-test', version: '1.0.0' });
  const reference = `asb:1/${'a'.repeat(16)}/codex/${'ab'.repeat(16)}/codex:${randomUUID()}`;
  const total = () => f.db.query<{ total: number }, []>('SELECT (SELECT count(*) FROM messages)+(SELECT count(*) FROM idle_requests) AS total').get()!.total;
  const sessionError = 'Input validation error: sessionId must be a UUID from list_sessions. Nothing sent.';
  const referenceError = 'Input validation error: reference must be a full session reference (asb:1/...). Nothing sent.';
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const refusals: [Record<string, unknown>, string][] = [
      [{ sessionId: 'not-a-uuid' }, sessionError], [{ sessionId: `${f.peerId} ` }, sessionError], [{ sessionId: '12345678-1234-0234-8234-123456789012' }, sessionError],
      [{ sessionId: 'x'.repeat(100_000) }, sessionError], [{ sessionId: 'not-a-uuid', notify_when_idle: true }, sessionError],
      [{ sessionId: 'not-a-uuid', reference }, sessionError], [{ sessionId: f.peerId, reference: 'asb:1/ x' }, referenceError],
      [{ reference: `codex/${randomUUID()}` }, referenceError], [{ reference: 'asb:1/ x' }, referenceError], [{ reference: `asb:${'x'.repeat(381)}` }, referenceError],
    ];
    for (const [fields, text] of refusals) {
      for (const meta of [{ threadId: f.desktop.threadId }, undefined]) {
        // Without a thread ID in _meta the caller check would fail: the format check comes first.
        const answer = await client.callTool({ name: 'send_message', arguments: { ...fields, text: 'hello' }, ...(meta ? { _meta: meta } : {}) });
        expect(answer.isError).toBe(true);
        expect(answer.content).toEqual([{ type: 'text', text }]);
      }
    }
    // Nothing went to the peer socket or to the task, and no message or idle row exists.
    expect([f.frames.length, f.desktop.submissions.length, total()]).toEqual([0, 0, 0]);
    // The same run does send when the values are good, so the checks above would have seen a frame.
    const sent = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, text: 'hello' }, _meta: { threadId: f.desktop.threadId } });
    expect(sent.isError).not.toBe(true);
    await until(() => f.frames.some(frame => frame.type === 'user'));
    expect(total()).toBe(1);
  } finally { await client.close(); await f.close(); }
});

posix('native mode defaults hold mismatches; user decisions release once, refuse and expire without model input', async () => {
  const f = await fixture();
  try {
    const held = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    expect(f.desktop.submissions).toHaveLength(0);
    await f.bridge.resolveHeld(held, 'approve');
    await f.bridge.resolveHeld(held, 'approve');
    expect(f.desktop.submissions).toHaveLength(1);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.status === 'delivered'));

    f.bridge.updateRuntime({ status: 'idle', mode: 'bypass' });
    await f.message();
    await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 2);
    await f.message('bypass');
    await until(() => f.desktop.submissions.length === 2);
    await f.bridge.setPolicy('hold');
    expect(f.db.query('SELECT 1 FROM messages WHERE status=\'held\' AND expires_at IS NOT NULL').get()).toBeNull();
    await f.bridge.setPolicy('refuse');
    expect(f.bridge.status().heldCount).toBe(0);
    expect(f.bridge.status().messages.filter(row => row.status === 'refused')).toHaveLength(2);
    const refused = await f.message('bypass');
    await until(() => f.bridge.status().messages.some(row => row.id === refused && row.status === 'refused'));
    expect(f.desktop.submissions).toHaveLength(2);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === refused && frame.status === 'expired' && frame.status_detail === 'refused'));

    await f.bridge.setPolicy('default');
    const expired = await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 1);
    f.db.run('UPDATE messages SET expires_at=0 WHERE id=?', [expired]);
    await f.bridge.resolveHeld(expired, 'approve');
    expect(f.bridge.status().messages.find(row => row.id === expired)?.status).toBe('expired');
    expect(f.desktop.submissions).toHaveLength(2);
    expect(peers(f.configDir).find(peer => peer.sessionId === f.desktop.threadId)?.status).toBe('idle');
  } finally { await f.close(); }
}, 10000);

posix('idle subscriptions are one-shot, do not start the watched task and ignore unsolicited or expired notices', async () => {
  const f = await fixture();
  try {
    const request = randomUUID();
    f.desktop.setState('active');
    f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request, from_mode: 'prompting' });
    await until(() => f.bridge.status().idleRequests.length === 1);
    expect(f.frames).toHaveLength(0);
    f.desktop.setState('idle');
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === request));
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request });
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await Bun.sleep(200);
    expect(f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice')).toHaveLength(1);
    expect(f.desktop.submissions).toHaveLength(0);

    const outgoing = await f.bridge.sendMessage(f.peerId, undefined, true);
    expect(outgoing.messageId).toBeNull();
    const notice = { type: 'control', action: 'peer_idle_notice', orig_msg_id: outgoing.subscriptionId, state: 'idle', finished_at: Date.now(), from_mode: 'prompting' };
    await f.transmit({ ...notice, orig_msg_id: randomUUID() });
    await f.transmit(notice);
    await until(() => f.desktop.submissions.length === 1);
    await f.transmit(notice);
    const next = await f.bridge.sendMessage(f.peerId, undefined, true);
    f.db.run('UPDATE idle_requests SET expires_at=0 WHERE id=?', [next.subscriptionId]);
    await f.transmit({ ...notice, orig_msg_id: next.subscriptionId });
    await Bun.sleep(200);
    expect(f.desktop.submissions).toHaveLength(2);
    expect(JSON.stringify(f.desktop.submissions[1])).toContain('idle_subscription_expired');
    expect(JSON.stringify(f.desktop.submissions[1])).not.toContain('peer_idle_notice');
  } finally { await f.close(); }
});

posix('regular receiver shutdown expires held input and sends one exited notice to a waiting subscriber', async () => {
  const f = await fixture();
  try {
    const message = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    const request = randomUUID();
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request });
    await until(() => f.bridge.status().idleRequests.length === 1);
    expect(f.desktop.submissions).toHaveLength(0);
    await f.bridge.close();
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === request && frame.state === 'exited'));
    expect(f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice')).toHaveLength(1);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === message && frame.status === 'expired')).toBe(true);
    expect(f.desktop.submissions).toHaveLength(0);
  } finally { await f.close(); }
});

posix('a held idle notice stays outside model input, even after accept; an expired subscription reports once', async () => {
  const f = await fixture();
  try {
    await f.bridge.setPolicy('hold');
    const request = await f.bridge.sendMessage(f.peerId, undefined, true);
    await f.transmit({ type: 'control', action: 'peer_idle_notice', orig_msg_id: request.subscriptionId,
      state: 'idle', detail: 'Private peer summary', from_mode: 'prompting' });
    await until(() => f.bridge.status().idleRequests.some(row => row.status === 'received'));
    expect(f.bridge.status().heldCount).toBe(0);
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(0);
    const expired = await f.bridge.sendMessage(f.peerId, undefined, true);
    f.db.run('UPDATE idle_requests SET expires_at=0 WHERE id=?', [expired.subscriptionId]);
    f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
    await until(() => f.desktop.submissions.length === 1);
    expect(JSON.stringify(f.desktop.submissions)).toContain('idle_subscription_expired');
    expect(JSON.stringify(f.desktop.submissions)).not.toContain('Private peer summary');
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await Bun.sleep(50);
    expect(f.desktop.submissions).toHaveLength(1);
  } finally { await f.close(); }
});

posix('the lifecycle hook opens held dialogs without model calls and shares manual review', async () => {
  const f = await fixture();
  const dialogs: { text: string; answer: ReturnType<typeof Promise.withResolvers<{ action: 'accept' | 'cancel'; content?: { decision: string } }>> }[] = [];
  const client = new Client({ name: 'automatic-dialog-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    const answer = Promise.withResolvers<{ action: 'accept' | 'cancel'; content?: { decision: string } }>();
    dialogs.push({ text: request.params.message, answer });
    return answer.promise;
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const started = await client.callTool({ name: 'session_start', arguments: { cwd: f.root }, _meta: { threadId: f.desktop.threadId } });
    expect(started).not.toHaveProperty('isError', true);
    const id = await f.message('bypass', 'private held payload');
    await until(() => dialogs.length === 1, 4000);
    expect(dialogs[0]?.text).toContain('private held payload');
    expect(f.desktop.submissions).toHaveLength(0);
    const manual = client.callTool({ name: 'inbox', arguments: { view: 'held' }, _meta: { threadId: f.desktop.threadId } });
    expect((await client.callTool({ name: 'status', arguments: {}, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    expect(dialogs).toHaveLength(1);
    dialogs[0]!.answer.resolve({ action: 'accept', content: { decision: 'approve' } });
    const reviewed = await manual;
    expect(reviewed.isError).not.toBe(true);
    expect(JSON.parse(z.array(z.object({ text: z.string() })).parse(reviewed.content)[0]!.text))
      .toMatchObject({ action: 'accept', messageId: id });
    expect(JSON.stringify(reviewed)).not.toContain('private held payload');
    await until(() => f.desktop.submissions.length === 1);
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('started');
    const denied = await f.message('bypass');
    await until(() => dialogs.length === 2, 4000);
    dialogs[1]!.answer.resolve({ action: 'cancel' });
    await until(() => f.bridge.status().messages.find(row => row.id === denied)?.status === 'denied');
    await f.bridge.setPolicy('hold');
    const held = await f.message('bypass');
    await until(() => f.bridge.status().messages.find(row => row.id === held)?.status === 'held');
    expect(f.bridge.reviewableHeld()).toEqual([]);
    const blocked = await client.callTool({ name: 'inbox', arguments: { view: 'held' }, _meta: { threadId: f.desktop.threadId } });
    expect(blocked.isError).not.toBe(true);
    expect(JSON.stringify(blocked)).toContain('Explicit hold only releases after the user changes the policy.');
    expect(dialogs).toHaveLength(2);
  } finally { await client.close(); await f.close(); }
}, 15000);

posix('automatic dialogs cancel on expiry and transport failures leave messages held', async () => {
  const f = await fixture();
  const requests: string[] = [];
  let cancellations = 0;
  const aborted = Promise.withResolvers<void>();
  let fail = false;
  const client = new Client({ name: 'dialog-expiry-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  // SDK 1.30 ignores cancellation of request ID 0; observe the actual wire notification.
  client.setNotificationHandler(CancelledNotificationSchema, async () => { cancellations++; aborted.resolve(); });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    requests.push(request.params.message);
    if (fail) throw new Error('Fixture transport failure');
    await aborted.promise;
    return { action: 'cancel' };
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    expect((await client.callTool({ name: 'session_start', arguments: { cwd: f.root }, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    const id = await f.message('bypass');
    await until(() => requests.length === 1, 4000);
    f.db.run('UPDATE messages SET expires_at=? WHERE id=?', [Date.now() - 1, id]);
    await until(() => cancellations === 1, 4000);
    await f.bridge.resolveHeld(id, 'approve');
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('expired');
    expect(f.desktop.submissions).toHaveLength(0);
    fail = true;
    const failed = await f.message('bypass', 'failed held message');
    await until(() => requests.length === 2, 4000);
    const next = await f.message('bypass', 'next held message');
    await until(() => requests.length === 3, 4000);
    expect(requests[2]).toContain('next held message');
    expect(requests.filter(text => text.includes('failed held message'))).toHaveLength(1);
    expect(f.bridge.status().messages.find(row => row.id === failed)?.status).toBe('held');
    expect(f.bridge.status().messages.find(row => row.id === next)?.status).toBe('held');
    expect(f.desktop.submissions).toHaveLength(0);
  } finally { await client.close(); await f.close(); }
}, 15000);

posix('MCP cancellation leaves policy alone but denies a default-held message', async () => {
  const f = await fixture();
  let action: 'accept' | 'cancel' = 'cancel';
  let content: Record<string, string> = { policy: 'hold' };
  const client = new Client({ name: 'user-dialog-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action, ...(action === 'accept' ? { content } : {}) }));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const subscription = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, notify_when_idle: true }, _meta: { threadId: f.desktop.threadId } });
    expect(subscription.isError).not.toBe(true);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'notify_when_idle' && frame.from === f.bridge.status().replyAddress)).toBe(true);
    const call = () => client.callTool({ name: 'inbox', arguments: { view: 'policy' }, _meta: { threadId: f.desktop.threadId } });
    expect((await call()).isError).not.toBe(true);
    expect(f.bridge.policy()).toBe('default');
    const held = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    expect((await client.callTool({ name: 'inbox', arguments: { view: 'held' }, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    expect(f.bridge.status().messages.find(row => row.id === held)?.status).toBe('denied');
    action = 'accept';
    expect((await call()).isError).not.toBe(true);
    expect(f.bridge.policy()).toBe('hold');
    await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 1);
    expect(f.desktop.submissions).toHaveLength(0);
    content = { expiry: '60s' };
    expect((await client.callTool({ name: 'inbox', arguments: { view: 'expiry' }, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    expect(f.bridge.dialogExpiry()).toBe('60s');
    // The receiver owns the deadline even after the MCP process closes.
    await f.bridge.setPolicy('default');
    const deadlineMessage = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    f.db.run('UPDATE messages SET expires_at=? WHERE id=?', [Date.now() + 500, deadlineMessage]);
    content = { policy: 'default' };
    expect((await call()).isError).not.toBe(true);
    await client.close();
    await until(() => f.bridge.status().messages.find(row => row.id === deadlineMessage)?.status === 'expired');
  } finally { await client.close(); await f.close(); }
});

posix('text frames with priority now or later are delivered like next', async () => {
  const f = await fixture();
  try {
    for (const priority of ['now', 'later', 'next']) {
      await f.transmit({ type: 'user', msg_id: randomUUID(), session_id: f.desktop.threadId, priority,
        message: { role: 'user', content: `priority ${priority}` } });
    }
    await f.bridge.setPolicy('default');
    await until(() => f.desktop.submissions.length === 3);
  } finally { await f.close(); }
});

posix('control frames addressed to another session are ignored, matching ones are applied', async () => {
  const f = await fixture();
  try {
    const sent = await f.bridge.sendMessage(f.peerId, 'receipt target');
    const receipt = { type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId, status: 'denied' };
    await f.transmit({ ...receipt, session_id: randomUUID() });
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: randomUUID(), session_id: randomUUID() });
    await f.bridge.setPolicy('default');
    expect(f.bridge.status().messages.find(message => message.id === sent.messageId)?.status).toBe('socket-written');
    expect(f.bridge.status().idleRequests).toEqual([]);
    await f.transmit({ ...receipt, session_id: f.desktop.threadId });
    await until(() => f.bridge.status().messages.some(message => message.id === sent.messageId && message.status === 'denied'));
  } finally { await f.close(); }
});

posix('a peer that changes its sessionId keeps its receipts, idle notices and outgoing receipts', async () => {
  const f = await fixture();
  const cleared = randomUUID();
  const clear = () => writeFileSync(join(f.configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId: cleared, messagingSocketPath: f.peerPath, cwd: f.root, peerProtocol: 1,
    peerFeatures: ['notify_idle'], startedAt: 1700000000000 }));
  try {
    const sent = await f.bridge.sendMessage(f.peerId, 'before clear', true);
    const subscription = f.bridge.status().idleRequests[0]?.id;
    if (!subscription) throw new Error('Missing subscription');
    const held = await f.message('bypass', 'held before clear');
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === held && frame.status === 'held'));
    clear();
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId, status: 'denied' });
    await until(() => f.bridge.status().messages.some(message => message.id === sent.messageId && message.status === 'denied'));
    await f.transmit({ type: 'control', action: 'peer_idle_notice', orig_msg_id: subscription, state: 'idle' });
    await until(() => f.bridge.status().idleRequests.some(request => request.id === subscription && request.status === 'received'));
    await f.bridge.setPolicy('accept');
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === held && frame.status === 'delivered'));
    expect(JSON.stringify(f.desktop.submissions)).toContain(cleared);
  } finally { await f.close(); }
});

posix('a leading auth line from a peer is ignored and the frame after it is delivered', async () => {
  const f = await fixture();
  try {
    const path = peers(f.configDir).find(peer => peer.sessionId === f.desktop.threadId)?.messagingSocketPath;
    if (!path) throw new Error('No receiver');
    const socket = net.createConnection(path);
    await once(socket, 'connect');
    socket.end(JSON.stringify({ type: 'auth', token: '0123456789abcdef0123456789abcdef' }) + '\n'
      + JSON.stringify({ msgV: 1, type: 'user', msg_id: randomUUID(), from: `uds:${f.peerPath}`, session_id: f.desktop.threadId,
        message: { role: 'user', content: 'after auth' } }) + '\n');
    await once(socket, 'close');
    await f.bridge.setPolicy('default');
    await until(() => f.desktop.submissions.length === 1);
  } finally { await f.close(); }
});

// Plan 16.4: sessions on other machines of the group, through a fake engine in the test runtime folder.
const remoteSession = (sessionId = randomUUID()) => ({ machineId: 'b'.repeat(16), machineName: 'beta', online: true, sessionId,
  name: 'codex-task', agent: 'codex', status: 'idle', remoteControl: false });
const runtimeDir = () => z.string().parse(process.env.XDG_RUNTIME_DIR);

linux('list_sessions adds the sessions on other machines after the local ones, and only the local ones without an engine', async () => {
  const f = await fixture();
  const client = new Client({ name: 'list-test', version: '1.0.0' });
  const caller = randomUUID();
  const remote = remoteSession();
  const engine = fakeEngine(runtimeDir(), () => ({ peers: [{ ...remote, sessionId: f.peerId }, remoteSession(caller), { ...remote, name: '' }, remote] }));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const list = async () => JSON.parse(z.array(z.object({ text: z.string() }))
      .parse((await client.callTool({ name: 'list_sessions', arguments: {}, _meta: { threadId: caller } })).content)[0]!.text);
    const rows = await list();
    expect(rows.map((row: { sessionId: string }) => row.sessionId)).toEqual([f.desktop.threadId, f.peerId, remote.sessionId]);
    expect(rows[2]).toEqual({ sessionId: remote.sessionId, name: 'beta-codex-task', agent: 'codex', status: 'idle', remote: true, machine: 'beta' });
    expect(engine.calls.map(call => call.route).sort()).toEqual(['/api/agent/list-references', '/api/relay/remote-peers']);
    engine.close();
    expect((await list()).map((row: { sessionId: string }) => row.sessionId)).toEqual([f.desktop.threadId, f.peerId]);
  } finally { engine.close(); await client.close(); await f.close(); }
});

linux('list_sessions adds the reference or its reason to each entry, and keeps a remote entry with a local ID only with a reference', async () => {
  const f = await fixture();
  const client = new Client({ name: 'list-test', version: '1.0.0' });
  const caller = randomUUID();
  const remote = remoteSession();
  const gamma = { ...remote, machineId: 'c'.repeat(16), machineName: 'gamma' };
  const peers = [remote, { ...remote, sessionId: f.peerId }, { ...gamma, sessionId: f.peerId }, remoteSession(caller), { ...gamma, sessionId: caller }];
  const ref = (machineId: string, appId: string) => `asb:1/${machineId}/codex/${'ab'.repeat(16)}/codex:${appId}`;
  let references: unknown = null;
  const engine = fakeEngine(runtimeDir(), route => route === '/api/relay/remote-peers' ? { peers } : references ?? new Response('{}', { status: 404 }));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const text = async () => z.array(z.object({ text: z.string() }))
      .parse((await client.callTool({ name: 'list_sessions', arguments: {}, _meta: { threadId: caller } })).content)[0]!.text;
    const localRows = JSON.parse(await text()).slice(0, 2) as Record<string, unknown>[];
    const remoteRow = (peer: typeof remote) => ({ sessionId: peer.sessionId, name: `${peer.machineName}-${peer.name}`, agent: peer.agent,
      status: peer.status, remote: true, machine: peer.machineName });
    // An older engine (404), another reply, or no engine: the same bytes as before.
    const before = JSON.stringify([...localRows, remoteRow(remote)]);
    expect(await text()).toBe(before);
    references = { apiVersion: 1, ok: false, code: 'caller-unregistered', message: 'x.' };
    expect(await text()).toBe(before);
    references = { apiVersion: 1, ok: true, pid: process.pid + 1, local: [{ sessionId: f.peerId, reference: ref('a'.repeat(16), f.peerId) }], remote: [] };
    expect(await text()).toBe(before);
    references = { apiVersion: 1, ok: true, pid: process.pid,
      local: [{ sessionId: f.peerId, reference: ref('a'.repeat(16), f.peerId) }, { sessionId: f.desktop.threadId, referenceUnavailable: 'not-mapped' }],
      remote: [{ machineId: remote.machineId, sessionId: remote.sessionId, reference: ref(remote.machineId, remote.sessionId) },
        { machineId: remote.machineId, sessionId: f.peerId, reference: ref(remote.machineId, f.peerId) },
        { machineId: gamma.machineId, sessionId: f.peerId, referenceUnavailable: 'not-found' },
        { machineId: gamma.machineId, sessionId: caller, reference: ref(gamma.machineId, caller) }] };
    expect(JSON.parse(await text())).toEqual([
      { ...localRows[0], referenceUnavailable: 'not-mapped' }, { ...localRows[1], reference: ref('a'.repeat(16), f.peerId) },
      { ...remoteRow(remote), reference: ref(remote.machineId, remote.sessionId) },
      { ...remoteRow({ ...remote, sessionId: f.peerId }), reference: ref(remote.machineId, f.peerId) },
      { ...remoteRow({ ...gamma, sessionId: caller }), reference: ref(gamma.machineId, caller) }]);
    expect(engine.calls.find(call => call.route === '/api/agent/list-references')).toMatchObject({ method: 'POST',
      body: { caller: { runtimeSessionId: caller, configDir: f.configDir } } });
    engine.close();
    expect(await text()).toBe(JSON.stringify(localRows));
  } finally { engine.close(); await client.close(); await f.close(); }
});

linux('list_sessions nameContains matches the name that the list shows for local and remote rows, and keeps the reference', async () => {
  const f = await fixture();
  const client = new Client({ name: 'list-test', version: '1.0.0' });
  const caller = randomUUID();
  const beta = remoteSession();
  const gamma = { ...remoteSession(), machineId: 'c'.repeat(16), machineName: 'Gamma', name: 'Review' };
  const reference = `asb:1/${gamma.machineId}/codex/${'ab'.repeat(16)}/codex:${gamma.sessionId}`;
  const engine = fakeEngine(runtimeDir(), route => route === '/api/relay/remote-peers' ? { peers: [beta, gamma] }
    : { apiVersion: 1, ok: true, pid: process.pid, local: [], remote: [{ machineId: gamma.machineId, sessionId: gamma.sessionId, reference }] });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const list = async (args: Record<string, unknown> = {}) => z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(z.array(z.object({ text: z.string() }))
      .parse((await client.callTool({ name: 'list_sessions', arguments: args, _meta: { threadId: caller } })).content)[0]!.text));
    const all = await list();
    expect(all.map(entry => entry.sessionId)).toEqual([f.desktop.threadId, f.peerId, beta.sessionId, gamma.sessionId]);
    // Remote rows have no cwd and no startedAt key, and no field is null.
    expect(all[2]).toEqual({ sessionId: beta.sessionId, name: 'beta-codex-task', agent: 'codex', status: 'idle', remote: true, machine: 'beta' });
    expect(all.flatMap(entry => Object.values(entry))).not.toContain(null);
    // The remote name that the list shows is <machine>-<name>: the filter reads the machine part too, and keeps the reference.
    expect(await list({ nameContains: 'GAMMA-rev' })).toEqual([{ sessionId: gamma.sessionId, name: 'Gamma-Review', agent: 'codex', status: 'idle',
      remote: true, machine: 'Gamma', reference }]);
    expect((await list({ nameContains: 'gamma' })).map(entry => entry.sessionId)).toEqual([gamma.sessionId]);
    expect((await list({ nameContains: 'BETA-codex-TASK' })).map(entry => entry.sessionId)).toEqual([beta.sessionId]);
    expect((await list({ nameContains: 'claude code' })).map(entry => entry.sessionId)).toEqual([f.peerId]);
    expect(await list({ nameContains: 'machine' })).toEqual([]);
  } finally { engine.close(); await client.close(); await f.close(); }
});

linux('a send to a remote session goes to the engine with the relay body, and each refusal reason has its text', async () => {
  const f = await fixture();
  const remote = remoteSession();
  let reply: unknown = { ok: true, outcome: 'socket-written' };
  const engine = fakeEngine(runtimeDir(), route => route === '/api/relay/remote-peers' ? { peers: [remote] }
    : route === '/api/relay/homes' ? { machineId: 'a'.repeat(16), machineName: 'alpha', homes: [] } : reply);
  const row = (id: string) => f.db.query<{ status: string; status_reason: string | null; peer_address: string | null }, [string]>(
    'SELECT status,status_reason,peer_address FROM messages WHERE id=?').get(id);
  try {
    const sent = await f.bridge.sendMessage(remote.sessionId, 'to beta');
    const hop = f.db.query<{ hop_token: string }, []>('SELECT hop_token FROM runtime').get()!.hop_token;
    expect(sent).toMatchObject({ subscriptionId: null, status: 'socket-written' });
    const body = engine.calls.find(call => call.route === '/api/relay/send')!.body;
    expect(body).toEqual({ machineId: remote.machineId, targetSessionId: remote.sessionId,
      sender: { machineId: 'a'.repeat(16), sessionId: f.desktop.threadId, name: f.bridge.status().name, mode: 'prompting', agent: 'codex' },
      message: { msgId: sent.messageId, text: 'to beta', hopChain: [hop] } });
    expect(row(z.string().parse(sent.messageId))).toEqual({ status: 'socket-written', status_reason: null, peer_address: null });
    for (const [reason, text] of [['machine-offline', 'beta is not reachable. Nothing sent.'], ['too-large', 'Message too large for the other machine. Nothing sent.'],
      ['rate-limited', 'Too many messages to this session just now. Nothing sent; wait or batch the text.'], ['refused', 'beta refused the message. Nothing sent.']]) {
      reply = { ok: false, reason };
      await expect(f.bridge.sendMessage(remote.sessionId, `refused ${reason}`)).rejects.toThrow(text!);
      const id = z.string().parse((engine.calls.at(-1)!.body as { message: { msgId: string } }).message.msgId);
      expect(row(id)).toMatchObject({ status: 'not-sent', status_reason: text });
    }
    // An outcome that is not known: the engine says so, an older engine says target-unavailable, an engine error, or another reply shape.
    for (const answer of [{ ok: false, reason: 'unknown' }, { ok: false, reason: 'target-unavailable' }, new Response('{}', { status: 500 }), { ok: true }]) {
      reply = answer;
      await expect(f.bridge.sendMessage(remote.sessionId, 'unknown outcome')).rejects.toThrow('Send outcome unknown');
      const id = z.string().parse((engine.calls.at(-1)!.body as { message: { msgId: string } }).message.msgId);
      expect(row(id)?.status).toBe('unknown');
    }
    const sends = engine.calls.filter(call => call.route === '/api/relay/send').length;
    await expect(f.bridge.sendMessage(remote.sessionId, undefined, true)).rejects.toThrow('Idle subscriptions do not work across machines yet.');
    await expect(f.bridge.sendMessage(remote.sessionId, 'x'.repeat(maxLineLength))).rejects.toThrow('Message too large');
    expect(engine.calls.filter(call => call.route === '/api/relay/send')).toHaveLength(sends);
    // Without the engine, an unknown session keeps the local error.
    engine.close();
    await expect(f.bridge.sendMessage(remote.sessionId, 'no engine')).rejects.toThrow('unavailable or ambiguous');
  } finally { engine.close(); await f.close(); }
});

linux('a session ID goes to the local match, or to exactly one other machine; else nothing is sent', async () => {
  const f = await fixture();
  const remote = remoteSession();
  let listed: unknown = { peers: [remote, { ...remote, machineId: 'c'.repeat(16), machineName: 'gamma' }] };
  const engine = fakeEngine(runtimeDir(), route => route === '/api/relay/remote-peers' ? listed
    : route === '/api/relay/homes' ? { machineId: 'a'.repeat(16), machineName: 'alpha', homes: [] } : { ok: true, outcome: 'socket-written' });
  const routes = () => engine.calls.map(call => call.route);
  try {
    // A local match never asks the engine, also when another machine lists the same ID.
    listed = { peers: [{ ...remote, sessionId: f.peerId }] };
    await f.bridge.sendMessage(f.peerId, 'local');
    expect(routes()).toEqual([]);
    // Two other machines with the ID: refused, and nothing goes to the engine.
    listed = { peers: [remote, { ...remote, machineId: 'c'.repeat(16), machineName: 'gamma' }] };
    await expect(f.bridge.sendMessage(remote.sessionId, 'two')).rejects.toThrow(`More than one other machine has session ${remote.sessionId}. Nothing sent.`);
    // The engine cannot list the other machines: an explicit error, not "not found".
    listed = new Response('{}', { status: 500 });
    await expect(f.bridge.sendMessage(remote.sessionId, 'no list')).rejects.toThrow('ASB cannot list the sessions on the other machines. Nothing sent.');
    expect(routes()).toEqual(['/api/relay/remote-peers', '/api/relay/remote-peers']);
    // The same machine listed twice is still one match.
    listed = { peers: [remote, remote] };
    expect(await f.bridge.sendMessage(remote.sessionId, 'one')).toMatchObject({ status: 'socket-written' });
    expect(routes().filter(route => route === '/api/relay/send')).toHaveLength(1);
  } finally { engine.close(); await f.close(); }
});

linux('a remote send records the proxy row address, so a receipt through the proxy row updates it', async () => {
  const f = await fixture();
  const remote = remoteSession();
  const engine = fakeEngine(runtimeDir(), route => route === '/api/relay/remote-peers' ? { peers: [remote] }
    : route === '/api/relay/homes' ? { machineId: 'a'.repeat(16), machineName: 'alpha', homes: [] } : { ok: true, outcome: 'socket-written' });
  const placeholder = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  const proxy = await inbox(join(f.root, 's'), () => {}, `${placeholder.pid}.sock`);
  try {
    writeFileSync(join(f.configDir, 'sessions', `${placeholder.pid}.json`), JSON.stringify({ pid: placeholder.pid, sessionId: remote.sessionId,
      messagingSocketPath: socketPath(proxy.address), cwd: '', name: 'beta-codex-task', peerProtocol: 1, entrypoint: 'asb-relay',
      procStart: await processStart(placeholder.pid) }), { mode: 0o600 });
    const sent = await f.bridge.sendMessage(remote.sessionId, 'through the proxy row');
    const id = z.string().parse(sent.messageId);
    expect(f.db.query<{ peer_address: string }, [string]>('SELECT peer_address FROM messages WHERE id=?').get(id)?.peer_address).toBe(proxy.address);
    await f.transmit({ type: 'control', from: proxy.address, action: 'peer_message_status', orig_msg_id: id, status: 'delivered' });
    await until(() => f.bridge.status().messages.some(message => message.id === id && message.status === 'delivered'));
  } finally { engine.close(); await proxy.close(); placeholder.kill(); await f.close(); }
});

// Exact local sends by full reference: a fake engine binds the fixture peer, and the bridge checks the binding again at the write.
const REFERENCE = (appId: string) => `asb:1/${'a'.repeat(16)}/claude-desktop-code/${'ab'.repeat(16)}/claude-cli:${appId}`;
type BindingReply = { apiVersion: 1; ok: true; pid: number; binding: Record<string, unknown> };

async function exact(f: Awaited<ReturnType<typeof fixture>>) {
  const procStart = z.string().parse(await processStart(process.ppid));
  const record = (fields: Record<string, unknown> = {}) => writeFileSync(join(f.configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId: f.peerId, messagingSocketPath: f.peerPath, cwd: f.root, peerProtocol: 1, peerFeatures: ['notify_idle'],
    startedAt: 1700000000000, entrypoint: 'cli', procStart, ...fields }), { mode: 0o600 });
  record();
  const binding = (msgId: string, fields: Record<string, unknown> = {}) => ({ registryHome: realpathSync(join(f.configDir, 'sessions')),
    runtimeSessionId: f.peerId, pid: process.ppid, procStart, messagingSocketPath: f.peerPath, msgId, expiresAtMs: Date.now() + 10_000, ...fields });
  let reply: (body: { msgId: string }) => unknown = body => ({ apiVersion: 1, ok: true, pid: process.pid, binding: binding(body.msgId) } satisfies BindingReply);
  const engine = fakeEngine(runtimeDir(), (route, body) => route === '/api/agent/resolve-bound' ? reply(body as { msgId: string }) : new Response('{}', { status: 404 }));
  const row = (id: string) => f.db.query<{ peer_id: string; peer_address: string | null; peer_start: string | null; status: string }, [string]>(
    'SELECT peer_id,peer_address,peer_start,status FROM messages WHERE id=?').get(id);
  const rows = () => f.db.query<{ total: number }, []>('SELECT (SELECT count(*) FROM messages)+(SELECT count(*) FROM idle_requests) AS total').get()!.total;
  return { procStart, record, binding, engine, row, rows, setReply(value: typeof reply) { reply = value; } };
}

linux('B2: an exact send through the real outbox socket binds once, writes one frame, and keeps receipts', async () => {
  const f = await fixture();
  const x = await exact(f);
  const client = new Client({ name: 'exact-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const sent = await client.callTool({ name: 'send_message', arguments: { reference: REFERENCE(f.peerId), text: 'exact hello' },
      _meta: { threadId: f.desktop.threadId } });
    expect(sent.isError).not.toBe(true);
    const value = JSON.parse(z.array(z.object({ text: z.string() })).parse(sent.content)[0]!.text);
    expect(value).toEqual({ messageId: expect.any(String), subscriptionId: null, status: 'socket-written' });
    expect(x.engine.calls.map(call => [call.method, call.route])).toEqual([['POST', '/api/agent/resolve-bound']]);
    expect(x.engine.calls[0]!.body).toEqual({ reference: REFERENCE(f.peerId), caller: { runtimeSessionId: f.desktop.threadId, configDir: f.configDir },
      msgId: value.messageId, remainingMs: 10_000 });
    const users = f.frames.filter(frame => frame.type === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ msg_id: value.messageId, session_id: f.peerId });
    expect(x.row(value.messageId)).toEqual({ peer_id: f.peerId, peer_address: peerAddress(f.peerPath), peer_start: x.procStart, status: 'socket-written' });
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: value.messageId, status: 'denied' });
    await until(() => x.row(value.messageId)?.status === 'denied');
  } finally { await client.close(); x.engine.close(); await f.close(); }
});

linux('B3: a /clear before the write gives target-changed; a receipt after an exact send and a /clear still updates the row', async () => {
  const f = await fixture();
  const x = await exact(f);
  try {
    x.record({ sessionId: randomUUID() });
    await expect(f.bridge.sendReference(REFERENCE(f.peerId), 'before the write')).rejects.toThrow('Nothing sent (target-changed).');
    expect([f.frames.length, x.rows()]).toEqual([0, 0]);
    x.record();
    const sent = await f.bridge.sendReference(REFERENCE(f.peerId), 'exact before clear');
    x.record({ sessionId: randomUUID() });
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId, status: 'denied' });
    await until(() => x.row(z.string().parse(sent.messageId))?.status === 'denied');
  } finally { x.engine.close(); await f.close(); }
});

linux('B4: the outbox refuses a bound request with any changed field, msgId, or expiry before the write', async () => {
  const f = await fixture();
  const x = await exact(f);
  const address = z.string().parse(f.bridge.status().replyAddress);
  const ask = async (request: Record<string, unknown>) => {
    const socket = net.createConnection(address.slice(4).replace(/\.sock$/, '.out'));
    await once(socket, 'connect');
    socket.write(JSON.stringify(request) + '\n');
    const [data] = await once(socket, 'data');
    socket.destroy();
    return z.strictObject({ written: z.boolean().optional(), refused: z.string().optional(), error: z.string().optional() })
      .parse(JSON.parse(String(data).split('\n')[0]!));
  };
  const msgId = randomUUID();
  const frames = [{ msgV: 1, type: 'user', msg_id: msgId, from: address, session_id: f.peerId, message: { role: 'user', content: 'bound probe' } }];
  try {
    for (const [fields, code] of [[{ registryHome: f.root }, 'target-changed'], [{ runtimeSessionId: randomUUID() }, 'target-changed'],
      [{ pid: process.pid }, 'target-changed'], [{ procStart: 'another start' }, 'target-changed'], [{ messagingSocketPath: join(f.root, 'x.sock') }, 'target-changed'],
      [{ msgId: randomUUID() }, 'target-changed'], [{ expiresAtMs: Date.now() - 1 }, 'binding-expired']] as const) {
      expect(await ask({ binding: x.binding(msgId, fields), frames })).toEqual({ refused: expect.stringContaining(`Nothing sent (${code}).`) });
    }
    expect(await ask({ binding: x.binding(msgId), frames, sessionKey: 1 })).toHaveProperty('error');
    expect(await ask({ binding: { ...x.binding(msgId), extra: 1 }, frames })).toHaveProperty('error');
    expect(f.frames).toHaveLength(0);
    expect(await ask({ binding: x.binding(msgId), frames })).toEqual({ written: true });
    expect(f.frames).toHaveLength(1);
    // An expired binding at the write leaves a not-sent row.
    x.setReply(body => ({ apiVersion: 1, ok: true, pid: process.pid, binding: x.binding(body.msgId, { expiresAtMs: Date.now() - 1 }) }));
    await expect(f.bridge.sendReference(REFERENCE(f.peerId), 'too late')).rejects.toThrow('Nothing sent (binding-expired).');
    const id = z.object({ msgId: z.string() }).parse(x.engine.calls.at(-1)!.body).msgId;
    expect(x.row(id)?.status).toBe('not-sent');
    expect(f.frames).toHaveLength(1);
  } finally { x.engine.close(); await f.close(); }
});

linux('B5: a reference never falls back to the session ID, the remote peers, or the relay', async () => {
  const f = await fixture();
  const x = await exact(f);
  const ok = (body: { msgId: string }) => ({ apiVersion: 1, ok: true, pid: process.pid, binding: x.binding(body.msgId) });
  try {
    for (const [reply, text] of [
      [() => ({ apiVersion: 1, ok: false, code: 'remote-exact-unsupported', message: 'This reference is for a session on another machine.' }),
        'This reference is for a session on another machine. Nothing sent (remote-exact-unsupported).'],
      [() => new Response('{}', { status: 500 }), 'Nothing sent (engine-unavailable).'],
      [(body: { msgId: string }) => ({ ...ok(body), extra: 1 }), 'Nothing sent (engine-unavailable).'],
      [(body: { msgId: string }) => ({ ...ok(body), pid: process.pid + 1 }), 'Nothing sent (engine-unavailable).'],
      [() => ok({ msgId: randomUUID() }), 'Nothing sent (engine-unavailable).'],
    ] as const) {
      x.setReply(reply);
      await expect(f.bridge.sendReference(REFERENCE(f.peerId), 'no fallback')).rejects.toThrow(text);
    }
    x.engine.close();
    await expect(f.bridge.sendReference(REFERENCE(f.peerId), 'no engine')).rejects.toThrow('Nothing sent (engine-unavailable).');
    expect([f.frames.length, x.rows()]).toEqual([0, 0]);
    expect(x.engine.calls.every(call => call.route === '/api/agent/resolve-bound')).toBe(true);
  } finally { x.engine.close(); await f.close(); }
});

linux('B6: an exact idle request needs notify_idle; with it the idle row is bound to the target process', async () => {
  const f = await fixture();
  const x = await exact(f);
  try {
    x.record({ peerFeatures: [] });
    await expect(f.bridge.sendReference(REFERENCE(f.peerId), undefined, true)).rejects.toThrow('Idle subscription unavailable');
    expect([f.frames.length, x.rows()]).toEqual([0, 0]);
    x.record();
    const sent = await f.bridge.sendReference(REFERENCE(f.peerId), undefined, true);
    expect(sent).toEqual({ messageId: null, subscriptionId: expect.any(String), status: 'socket-written' });
    expect(z.object({ msgId: z.string() }).parse(x.engine.calls.at(-1)!.body).msgId).toBe(z.string().parse(sent.subscriptionId));
    expect(f.db.query('SELECT peer_id,peer_address,peer_start,direction,status FROM idle_requests WHERE id=?').get(z.string().parse(sent.subscriptionId)))
      .toEqual({ peer_id: f.peerId, peer_address: peerAddress(f.peerPath), peer_start: x.procStart, direction: 'out', status: 'waiting' });
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'notify_when_idle' && frame.msg_id === sent.subscriptionId));
  } finally { x.engine.close(); await f.close(); }
});

linux('B7: a binding for this task itself is refused', async () => {
  const f = await fixture();
  const x = await exact(f);
  try {
    x.setReply(body => ({ apiVersion: 1, ok: true, pid: process.pid, binding: x.binding(body.msgId, { runtimeSessionId: f.desktop.threadId }) }));
    await expect(f.bridge.sendReference(REFERENCE(f.desktop.threadId), 'to myself')).rejects.toThrow('Cannot send to this task itself');
    expect([f.frames.length, x.rows()]).toEqual([0, 0]);
  } finally { x.engine.close(); await f.close(); }
});

// Exact member sends: the engine says member-target, and the bridge asks /api/agent/send-member once.
const MEMBER_REFERENCE = `asb:1/${'b'.repeat(16)}/codex/${'cd'.repeat(16)}/codex:${randomUUID()}`;

linux('B8: a member reference goes to send-member once; not-sent and unknown map honestly, and idle is refused', async () => {
  const f = await fixture();
  const ok = (body: { message: { msgId: string } }) => ({ apiVersion: 1, pid: process.pid, msgId: body.message.msgId, outcome: 'submitted' });
  let member: (body: { message: { msgId: string } }) => unknown = ok;
  const engine = fakeEngine(runtimeDir(), (route, body) => route === '/api/agent/resolve-bound'
    ? { apiVersion: 1, ok: false, code: 'member-target', message: 'This reference is for a session on another machine. This version of ASB Bridge cannot send to it.' }
    : route === '/api/agent/send-member' ? member(body as { message: { msgId: string } }) : new Response('{}', { status: 404 }));
  const row = (text: string) => f.db.query<{ id: string; peer_id: string; peer_address: string | null; peer_start: string | null; status: string;
    status_reason: string | null }, [string]>('SELECT id,peer_id,peer_address,peer_start,status,status_reason FROM messages WHERE text=?').get(text);
  const routes = () => engine.calls.map(call => call.route);
  try {
    const sent = await f.bridge.sendReference(MEMBER_REFERENCE, 'member hello');
    expect(sent).toEqual({ messageId: expect.any(String), subscriptionId: null, status: 'socket-written' });
    expect(routes()).toEqual(['/api/agent/resolve-bound', '/api/agent/send-member']);
    expect(z.object({ msgId: z.string() }).parse(engine.calls[0]!.body).msgId).toBe(z.string().parse(sent.messageId));
    expect(engine.calls[1]!.body).toEqual({ reference: MEMBER_REFERENCE, caller: { runtimeSessionId: f.desktop.threadId, configDir: f.configDir },
      mode: 'prompting', message: { msgId: sent.messageId, text: 'member hello', hopChain: expect.any(Array) }, remainingMs: 10_000 });
    expect(row('member hello')).toEqual({ id: z.string().parse(sent.messageId), peer_id: MEMBER_REFERENCE, peer_address: null, peer_start: null,
      status: 'socket-written', status_reason: null });
    // A receipt frame does not change the row: it has no peer address.
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: sent.messageId, status: 'denied' });
    await Bun.sleep(100);
    expect(row('member hello')?.status).toBe('socket-written');
    expect(f.frames).toHaveLength(0);

    member = body => ({ apiVersion: 1, pid: process.pid, msgId: body.message.msgId, outcome: 'not-sent', code: 'machine-offline',
      message: 'The member machine is not reachable now.' });
    const offline = 'The member machine is not reachable now. Nothing sent (machine-offline).';
    await expect(f.bridge.sendReference(MEMBER_REFERENCE, 'offline')).rejects.toThrow(offline);
    expect(row('offline')).toMatchObject({ status: 'not-sent', status_reason: offline });
    for (const [index, reply] of ([
      () => new Response('{}', { status: 500 }),
      body => ({ ...ok(body), pid: process.pid + 1 }),
      () => ({ ...ok({ message: { msgId: randomUUID() } }) }),
      body => ({ ...ok(body), extra: 1 }),
      body => ({ ...ok(body), outcome: 'not-sent' }),
      body => ({ ...ok(body), code: 'refused', message: 'x' }),
      () => null,
    ] as ((body: { message: { msgId: string } }) => unknown)[]).entries()) {
      member = reply;
      await expect(f.bridge.sendReference(MEMBER_REFERENCE, `unknown ${index}`)).rejects.toThrow(/^Send outcome unknown for [0-9a-f-]{36}; inspect status before sending again$/);
      expect(row(`unknown ${index}`)?.status).toBe('unknown');
    }

    const before = { calls: engine.calls.length, rows: f.db.query<{ total: number }, []>('SELECT count(*) AS total FROM messages').get()!.total };
    for (const text of [undefined, 'with idle']) {
      await expect(f.bridge.sendReference(MEMBER_REFERENCE, text, true))
        .rejects.toThrow('Idle subscriptions do not work across machines yet. Nothing sent (remote-idle-unsupported).');
    }
    expect(routes().slice(before.calls)).toEqual(['/api/agent/resolve-bound', '/api/agent/resolve-bound']);
    expect(f.db.query<{ total: number }, []>('SELECT (SELECT count(*) FROM messages)+(SELECT count(*) FROM idle_requests) AS total').get()!.total).toBe(before.rows);
    expect(routes().every(route => ['/api/agent/resolve-bound', '/api/agent/send-member'].includes(route))).toBe(true);
  } finally { engine.close(); await f.close(); }
});

linux('B9: an exactReceipt on the outbox updates only the member rows of this receiver process, and a final state stays', async () => {
  const f = await fixture();
  let outcome = 'submitted';
  const engine = fakeEngine(runtimeDir(), (route, body) => route === '/api/agent/resolve-bound'
    ? { apiVersion: 1, ok: false, code: 'member-target', message: 'This reference is for a session on another machine. This version of ASB Bridge cannot send to it.' }
    : route === '/api/agent/send-member' ? { apiVersion: 1, pid: process.pid, msgId: (body as { message: { msgId: string } }).message.msgId, outcome }
      : new Response('{}', { status: 404 }));
  const status = (id: string) => f.db.query<{ status: string; drop_reason: string | null; status_reason: string | null }, [string]>(
    'SELECT status,drop_reason,status_reason FROM messages WHERE id=?').get(id);
  const send = async (text: string) => z.string().parse((await f.bridge.sendReference(MEMBER_REFERENCE, text)).messageId);
  const procStart = z.string().parse(await processStart(process.pid));
  const outbox = async (request: unknown) => {
    const path = outboxPath(peers(f.configDir).find(peer => peer.sessionId === f.desktop.threadId)!.messagingSocketPath);
    const socket = net.createConnection(path);
    await once(socket, 'connect');
    socket.setEncoding('utf8');
    let text = '';
    socket.on('data', chunk => { text += chunk; });
    socket.write(JSON.stringify(request) + '\n');
    await once(socket, 'close');
    return JSON.parse(text.split('\n')[0]!);
  };
  const receipt = (msgIds: string[], fields: Record<string, unknown> = {}) => outbox({ exactReceipt: { runtimeSessionId: f.desktop.threadId,
    pid: process.pid, procStart, reference: MEMBER_REFERENCE, msgIds, status: 'delivered', ...fields } });
  try {
    const first = await send('first');
    expect(status(first)?.status).toBe('socket-written');
    expect(await receipt([first], { status: 'held' })).toEqual({ applied: 1 });
    expect(status(first)?.status).toBe('held');
    expect(await receipt([first])).toEqual({ applied: 1 });
    expect(status(first)?.status).toBe('delivered');
    // A final state stays.
    expect(await receipt([first], { status: 'held' })).toEqual({ applied: 0 });
    expect(status(first)?.status).toBe('delivered');

    // A receipt proves that the frame came to the target: unknown moves to its state.
    outcome = 'unknown';
    await expect(send('maybe')).rejects.toThrow(/^Send outcome unknown/);
    const maybe = z.string().parse(f.db.query<{ id: string }, []>("SELECT id FROM messages WHERE text='maybe'").get()?.id);
    expect(status(maybe)?.status).toBe('unknown');
    expect(await receipt([maybe])).toEqual({ applied: 1 });
    expect(status(maybe)?.status).toBe('delivered');
    outcome = 'submitted';

    const refused = await send('refused');
    expect(await receipt([refused], { status: 'expired', status_detail: 'refused', reason: 'Refused by the inbox policy.' })).toEqual({ applied: 1 });
    expect(status(refused)).toEqual({ status: 'refused', drop_reason: null, status_reason: 'Refused by the inbox policy.' });
    const [d1, d2] = [await send('drop one'), await send('drop two')];
    expect(await receipt([d1, d2], { status: 'dropped', drop_reason: 'queue-full' })).toEqual({ applied: 2 });
    expect([status(d1), status(d2)]).toEqual([{ status: 'dropped', drop_reason: 'queue-full', status_reason: null },
      { status: 'dropped', drop_reason: 'queue-full', status_reason: null }]);

    // An inbox frame with the same ID changes nothing: the row has no peer address.
    const quiet = await send('quiet');
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: quiet, status: 'denied' });
    await Bun.sleep(100);
    expect(status(quiet)?.status).toBe('socket-written');
    // Another thread, process, start, or reference: nothing.
    for (const fields of [{ runtimeSessionId: randomUUID() }, { pid: process.pid + 1 }, { procStart: `${procStart}0` },
      { reference: `asb:1/${'b'.repeat(16)}/codex/${'cd'.repeat(16)}/codex:${randomUUID()}` }]) {
      expect(await receipt([quiet], fields)).toEqual({ applied: 0 });
    }
    // A 5a local row (with a peer address) and a legacy remote row (the session ID as peer_id): nothing.
    const local = randomUUID(), legacy = randomUUID();
    f.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,peer_start) VALUES (?,?,'out','x','socket-written',?,NULL)",
      [local, MEMBER_REFERENCE, peerAddress(f.peerPath)]);
    f.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,peer_start) VALUES (?,?,'out','x','socket-written',NULL,NULL)",
      [legacy, randomUUID()]);
    expect(await receipt([local, legacy])).toEqual({ applied: 0 });
    expect([status(local)?.status, status(legacy)?.status, status(quiet)?.status]).toEqual(['socket-written', 'socket-written', 'socket-written']);
    // Another shape is refused.
    for (const request of [{ exactReceipt: { runtimeSessionId: f.desktop.threadId, pid: process.pid, procStart, reference: MEMBER_REFERENCE, msgIds: [quiet],
      status: 'delivered', extra: 1 } }, { exactReceipt: { runtimeSessionId: f.desktop.threadId, pid: process.pid, procStart, reference: 'codex:x',
      msgIds: [quiet], status: 'delivered' } }, { exactReceipt: { runtimeSessionId: f.desktop.threadId, pid: process.pid, procStart,
      reference: MEMBER_REFERENCE, msgIds: [], status: 'delivered' } }]) {
      expect(await outbox(request)).toEqual({ error: 'Local send failed; inspect status before retrying' });
    }
    expect(status(quiet)?.status).toBe('socket-written');
    expect(f.frames).toHaveLength(0);
  } finally { engine.close(); await f.close(); }
});
