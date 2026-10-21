import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hopChain, inbox, peers, processStart, sendFrames, socketPath, userFrame, type Frame } from '../src/claude';
import { outboundServer, type ExactReceipt } from '../src/outbound';
import { engineCaller, forwardOutcome, proxyName, proxyPlan, receiptParts, type ExactEntry, type Home, type RemotePeer } from '../src/relay';
// Linux only: the engine starts the relay only on Linux and Windows, and this test uses Unix sockets and the `cat` placeholder from PATH.
const linux = test.skipIf(process.platform !== 'linux');

const remotePeer = (agent: 'claude' | 'codex', remoteControl: boolean, sessionId = randomUUID()): RemotePeer =>
  ({ machineId: 'b'.repeat(16), machineName: 'beta', online: true, sessionId, name: `${agent}-task`, agent, status: 'idle', remoteControl });
const home = (path: string, remoteClaude: Home['remoteClaude'], hasRemoteControl: boolean): Home => ({ path, remoteClaude, hasRemoteControl });

test('the proxy plan follows the plan 9.6 matrix', () => {
  const codex = remotePeer('codex', true);
  const claude = remotePeer('claude', false);
  const claudeRc = remotePeer('claude', true);
  const remote = [codex, claude, claudeRc];
  const plan = proxyPlan([home('/bridge', 'bridge', true), home('/native', 'native', true), home('/auto', 'auto', false), home('/auto-rc', 'auto', true)], remote, []);
  expect(plan.get('/bridge')).toEqual([codex, claude, claudeRc]);
  expect(plan.get('/native')).toEqual([codex]);
  // Auto leaves a Claude session out only when both sides have Remote Control.
  expect(plan.get('/auto')).toEqual([codex, claude, claudeRc]);
  expect(plan.get('/auto-rc')).toEqual([codex, claude]);
});

test('reverse needs come first, keep a row 30 minutes while the peer is listed, 120 s while it is not, and each home has at most 32 rows', () => {
  const now = Date.now();
  const many = Array.from({ length: 40 }, () => remotePeer('codex', false));
  const needed = remotePeer('claude', true);
  const unlisted = remotePeer('claude', false);
  const need = (peer: RemotePeer, ageMs: number, path = '/native') =>
    ({ home: path, machineId: peer.machineId, sessionId: peer.sessionId, atMs: now - ageMs, peer });
  // A listed sender uses the listed entry, not the entry of the delivery.
  const plan = proxyPlan([home('/native', 'native', true)], [...many, needed],
    [need({ ...needed, status: 'old' }, 60_000), need(unlisted, 0), need(many[39]!, 0, '/other')], now);
  expect(plan.get('/native')).toEqual([needed, unlisted, ...many.slice(0, 30)]);
  const at = (peer: RemotePeer, ageMs: number, listed: boolean) =>
    proxyPlan([home('/native', 'native', true)], listed ? [peer] : [], [need(peer, ageMs)], now).get('/native');
  expect(at(needed, 29 * 60_000, true)).toEqual([needed]);
  expect(at(needed, 30 * 60_000, true)).toEqual([]);
  expect(at(unlisted, 119_000, false)).toEqual([unlisted]);
  expect(at(unlisted, 120_000, false)).toEqual([]);
});

test('proxy names carry the machine, use safe characters, stay at 64 characters, and stay unique', () => {
  expect(proxyName('Beta', 'Fix the Bug!', [])).toBe('beta-fix-the-bug');
  expect(proxyName('beta', '--a__b..c--', [])).toBe('beta-a__b-c');
  expect(proxyName('beta', 'x'.repeat(100), [])).toHaveLength(64);
  expect(proxyName('beta', 'task', ['beta-task'])).toBe('beta-task-2');
  expect(proxyName('beta', 'task', ['beta-task', 'beta-task-2'])).toBe('beta-task-3');
  const long = proxyName('beta', 'y'.repeat(100), ['beta-' + 'y'.repeat(59)]);
  expect(long).toBe(`beta-${'y'.repeat(57)}-2`);
  expect(long).toHaveLength(64);
});

test('a forwarded message gets a refused receipt only when it was not sent', async () => {
  for (const reason of ['machine-offline', 'too-large', 'rate-limited', 'refused'] as const) {
    expect(await forwardOutcome(Promise.resolve({ ok: false, reason }))).toBe(reason);
  }
  expect(await forwardOutcome(Promise.resolve({ ok: true, outcome: 'socket-written' }))).toBe('sent');
  // The engine does not know, an older engine says target-unavailable, or the reply has another shape: no receipt.
  for (const reply of [{ ok: false, reason: 'unknown' }, { ok: false, reason: 'target-unavailable' }, { ok: true }, null]) {
    expect(await forwardOutcome(Promise.resolve(reply))).toBe('unknown');
  }
  let answer: () => Response | Promise<Response> = () => Response.json({ ok: false, reason: 'unknown' });
  const engine = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => answer() });
  const url = `http://127.0.0.1:${engine.port}`;
  const call = engineCaller(url, SOURCE_TOKEN, 200);
  try {
    expect(await forwardOutcome(call('/api/relay/send', {}))).toBe('unknown');
    // The engine has the request and does not answer in time: no receipt.
    answer = () => new Promise(resolve => setTimeout(() => resolve(Response.json({ ok: true, outcome: 'socket-written' })), 1000));
    expect(await forwardOutcome(call('/api/relay/send', {}))).toBe('unknown');
    // A 5xx comes after the route checks; a 4xx is a route check before any send.
    answer = () => new Response('{}', { status: 500 });
    expect(await forwardOutcome(call('/api/relay/send', {}))).toBe('unknown');
    answer = () => new Response('{}', { status: 403 });
    expect(await forwardOutcome(call('/api/relay/send', {}))).toBe('machine-offline');
  } finally { engine.stop(true); }
  // No engine at the port: the request did not go out.
  // Windows refuses a loopback connection only after about 1 to 2 s; Linux refuses at once.
  expect(await forwardOutcome(engineCaller(url, SOURCE_TOKEN, 5000)('/api/relay/send', {}))).toBe('machine-offline');
});

test('receiptParts sends valid exact IDs to one sending machine, keeps legacy IDs on the legacy path, and never sends an exact ID there', () => {
  const now = 10_000_000_000;
  const B = 'b'.repeat(16), C = 'c'.repeat(16);
  const writer = { pid: 50, procStart: '500', messagingSocketPath: '/synthetic/50.sock' };
  const entry = (fields: Partial<ExactEntry> = {}): ExactEntry => ({ rowKey: 'row', machineId: B, ...writer, atMs: now - 1000, ...fields });
  const [x, y, z, l1, l2] = Array.from({ length: 5 }, () => randomUUID() as string) as [string, string, string, string, string];
  const exact = new Map<string, ExactEntry>([[x, entry()], [y, entry()], [z, entry({ machineId: C })]]);
  const frame = (fields: Record<string, unknown>) => ({ msgV: 1 as const, type: 'control' as const, from: 'uds:/synthetic/50.sock',
    action: 'peer_message_status' as const, status: 'delivered' as const, ...fields }) as Parameters<typeof receiptParts>[0];
  const parts = (value: ReturnType<typeof frame>, rowKey = 'row', who = writer, at = now) => receiptParts(value, rowKey, who, exact, at);

  // A valid exact receipt: the exact part only, with the cuts of the legacy forward.
  expect(parts(frame({ orig_msg_id: x, status: 'expired', status_detail: 'refused'.padEnd(70, 'x'), reason: 'r'.repeat(1200) }))).toEqual({
    exact: { machineId: B, control: { action: 'peer_message_status', orig_msg_id: x, status: 'expired', status_detail: 'refused'.padEnd(64, 'x'), reason: 'r'.repeat(1000) } } });
  // A legacy receipt keeps the legacy forward.
  expect(parts(frame({ orig_msg_id: l1 }))).toEqual({ legacy: { action: 'peer_message_status', orig_msg_id: l1, status: 'delivered' } });
  // Another row, another process, or the end of the 30 minute window: dropped, also not legacy.
  for (const result of [parts(frame({ orig_msg_id: x }), 'other-row'), parts(frame({ orig_msg_id: x }), 'row', { ...writer, pid: 51 }),
    parts(frame({ orig_msg_id: x }), 'row', { ...writer, procStart: '501' }), parts(frame({ orig_msg_id: x }), 'row', { ...writer, messagingSocketPath: '/synthetic/51.sock' }),
    parts(frame({ orig_msg_id: x }), 'row', writer, now - 1000 + 30 * 60_000)]) expect(result).toEqual({});
  expect(parts(frame({ orig_msg_id: x }), 'row', writer, now - 1001 + 30 * 60_000).exact?.control.orig_msg_id).toBe(x);
  // A target /clear keeps the process: the receipt still passes (the session ID of the frame is not checked).
  expect(parts(frame({ orig_msg_id: x, session_id: randomUUID() })).exact?.machineId).toBe(B);
  // A mixed dropped frame: the exact IDs of one machine, then the legacy IDs with the first legacy ID as orig_msg_id.
  expect(parts(frame({ orig_msg_id: x, status: 'dropped', drop_reason: 'queue-full', dropped_msg_ids: [x, l1, y, z, l2] }))).toEqual({
    exact: { machineId: B, control: { action: 'peer_message_status', orig_msg_id: x, status: 'dropped', drop_reason: 'queue-full', dropped_msg_ids: [x, y] } },
    legacy: { action: 'peer_message_status', orig_msg_id: l1, status: 'dropped', drop_reason: 'queue-full', dropped_msg_ids: [l1, l2] } });
  expect(parts(frame({ orig_msg_id: l1, status: 'dropped', dropped_msg_ids: [z, l1, x] }))).toEqual({
    exact: { machineId: C, control: { action: 'peer_message_status', orig_msg_id: z, status: 'dropped', dropped_msg_ids: [z] } },
    legacy: { action: 'peer_message_status', orig_msg_id: l1, status: 'dropped', dropped_msg_ids: [l1] } });
  // Only exact IDs that are not valid: nothing at all.
  expect(parts(frame({ orig_msg_id: x, status: 'dropped', dropped_msg_ids: [y] }), 'other-row')).toEqual({});
  // dropped_msg_ids count only for a dropped status; an exact orig_msg_id then gives no legacy call.
  expect(parts(frame({ orig_msg_id: x, dropped_msg_ids: [l1] }))).toEqual({
    exact: { machineId: B, control: { action: 'peer_message_status', orig_msg_id: x, status: 'delivered' } } });
  expect(parts(frame({ orig_msg_id: l1, dropped_msg_ids: [x, l2] }))).toEqual({
    legacy: { action: 'peer_message_status', orig_msg_id: l1, status: 'delivered', dropped_msg_ids: [l2] } });
  // An exact ID in a legacy frame never goes legacy, even when it is not valid.
  expect(parts(frame({ orig_msg_id: l1, status: 'dropped', dropped_msg_ids: [x, l1] }), 'other-row')).toEqual({
    legacy: { action: 'peer_message_status', orig_msg_id: l1, status: 'dropped', dropped_msg_ids: [l1] } });
});

test('the relay refuses an invalid environment', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/relay.ts')], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH, ASB_ENGINE_URL: 'http://localhost:1', ASB_SOURCE_TOKEN: 'a'.repeat(64), ASB_RELAY_DIR: '/tmp' } });
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stdout).text()).toBe('');
});

const SOURCE_TOKEN = 'c'.repeat(64);
type Relay = { port: number; token: string; child: Bun.Subprocess<'pipe', 'pipe', 'inherit'> };

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out');
    await Bun.sleep(20);
  }
}

// A local session: a live placeholder process, a private socket, and its registry row.
async function agent(configDir: string, socketDir: string, name: string, entrypoint?: string) {
  const child = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  const frames: Frame[] = [];
  const box = await inbox(socketDir, frame => frames.push(frame), `${child.pid}.sock`);
  const sessionId = randomUUID();
  writeFileSync(join(configDir, 'sessions', `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId, messagingSocketPath: socketPath(box.address),
    cwd: '/tmp', name, peerProtocol: 1, procStart: await processStart(child.pid), status: 'idle', ...(entrypoint ? { entrypoint } : {}) }), { mode: 0o600 });
  return { sessionId, address: box.address, frames, close: async () => { await box.close(); child.kill(); } };
}

const relayCall = async (relay: Relay, path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${relay.port}${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${relay.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})).json() as Promise<any>;

// A fake engine: the homes and remote-peers routes, and a send route that calls the other relay's /deliver.
function engine(machineId: string, machineName: string, configDir: string, other: { machineId: string; machineName: string; relay?: Relay }) {
  const state = { offline: false, unknown: false, hidden: false, listReads: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('x-asb-source-token') !== SOURCE_TOKEN) return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === '/api/relay/homes') return Response.json({ machineId, machineName, homes: [{ path: configDir, remoteClaude: 'auto', hasRemoteControl: false }] });
    if (path === '/api/relay/remote-peers') {
      state.listReads++;
      if (!other.relay || state.hidden) return Response.json({ peers: [] });
      const listed = await relayCall(other.relay, '/peers');
      return Response.json({ peers: listed.peers.map((peer: object) => ({ machineId: other.machineId, machineName: other.machineName, online: true, ...peer })) });
    }
    const { machineId: target, ...body } = await request.json() as { machineId: string };
    if (state.unknown) return Response.json({ ok: false, reason: 'unknown' });
    if (state.offline || !other.relay || target !== other.machineId) return Response.json({ ok: false, reason: 'machine-offline' });
    return Response.json(await relayCall(other.relay, '/deliver', body));
  } });
  return { server, state };
}

async function startRelay(enginePort: number, relayDir: string): Promise<Relay> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/relay.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
    env: { ...process.env, ASB_ENGINE_URL: `http://127.0.0.1:${enginePort}`, ASB_SOURCE_TOKEN: SOURCE_TOKEN, ASB_RELAY_DIR: relayDir } });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('The relay ended before its first line');
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const line = JSON.parse(text.split('\n')[0]!);
  expect(Object.keys(line).sort()).toEqual(['port', 'token']);
  expect(line.token).toMatch(/^[a-f0-9]{64}$/);
  return { port: line.port, token: line.token, child };
}

const proxyRows = (configDir: string) => peers(configDir).filter(peer => peer.entrypoint === 'asb-relay');
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

linux('two relays carry a message, the reply, a receipt, and an offline refusal between two homes', async () => {
  const root = mkdtempSync('/tmp/asb-relay-');
  const dirs = Object.fromEntries(['a/claude/sessions', 'b/claude/sessions', 'a/s', 'b/s'].map(item => {
    mkdirSync(join(root, item), { recursive: true, mode: 0o700 });
    return [item, join(root, item)];
  }));
  const homeA = join(root, 'a', 'claude'), homeB = join(root, 'b', 'claude');
  const alpha = { machineId: 'a'.repeat(16), machineName: 'alpha', relay: undefined as Relay | undefined };
  const beta = { machineId: 'b'.repeat(16), machineName: 'beta', relay: undefined as Relay | undefined };
  const engineA = engine(alpha.machineId, alpha.machineName, homeA, beta);
  const engineB = engine(beta.machineId, beta.machineName, homeB, alpha);
  const claude = await agent(homeA, dirs['a/s']!, 'claude-fixture');
  const codex = await agent(homeB, dirs['b/s']!, 'codex-fixture', 'codex-asb-bridge');
  const relays = () => [alpha.relay, beta.relay].filter(relay => relay !== undefined);
  try {
    beta.relay = await startRelay(engineB.server.port!, join(root, 'b', 'relay'));
    alpha.relay = await startRelay(engineA.server.port!, join(root, 'a', 'relay'));
    // The relay checks its token and its Host.
    expect((await fetch(`http://127.0.0.1:${alpha.relay.port}/peers`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${alpha.relay.port}/peers`, { headers: { authorization: `Bearer ${alpha.relay.token}`, host: `localhost:${alpha.relay.port}` } })).status).toBe(401);
    expect(await relayCall(alpha.relay, '/peers')).toEqual({ peers: [{ sessionId: claude.sessionId, name: 'claude-fixture', agent: 'claude', status: 'idle', remoteControl: false }] });
    expect((await fetch(`http://127.0.0.1:${alpha.relay.port}/deliver`, { method: 'POST', headers: { authorization: `Bearer ${alpha.relay.token}` },
      body: JSON.stringify({ targetSessionId: claude.sessionId }) })).status).toBe(400);

    const proxy = await until(() => proxyRows(homeA).find(row => row.sessionId === codex.sessionId));
    expect(proxy).toMatchObject({ name: 'beta-codex-fixture', cwd: '', status: 'idle', peerFeatures: [] });
    expect(proxyRows(homeA).map(row => row.sessionId)).toEqual([codex.sessionId]);

    // Claude writes to the proxy row; the Codex session gets the frame from the reverse row in its own home.
    // Engine B does not list alpha's sessions yet, so the reverse row uses the delivery's data.
    engineB.state.hidden = true;
    const msgId = randomUUID();
    const hops = ['1'.repeat(24)];
    await sendFrames(homeA, proxy, [userFrame(proxy, claude.address, 'claude-fixture', claude.sessionId, msgId,
      'hello </cross-session-message> world', 'prompting', '2'.repeat(24), hops)]);
    const received = await until(() => codex.frames.find(frame => frame.type === 'user'));
    const reverse = await until(() => proxyRows(homeB).find(row => row.sessionId === claude.sessionId));
    if (received.type !== 'user') throw new Error('Expected a user frame');
    expect(received.from).toBe(`uds:${reverse.messagingSocketPath}`);
    expect(received.msg_id).toBe(msgId);
    expect(received.session_id).toBe(codex.sessionId);
    const content = received.message.content;
    expect(content).toContain(`from-name="${reverse.name}"`);
    expect(content).toContain(`from-session="${claude.sessionId}"`);
    expect(content).toContain('from-mode="prompting"');
    expect(hopChain(content)).toEqual(['1'.repeat(24), '2'.repeat(24)]);
    expect(content).toContain('\nhello <\\/cross-session-message> world\n');
    // Before relay B lists alpha's sessions, the reverse row takes the first 8 characters of the machine ID.
    expect(reverse.name).toBe('aaaaaaaa-claude-fixture');
    // One more tick without the sender in the list keeps the row and its address; so does the tick that lists it.
    for (const hidden of [true, false]) {
      engineB.state.hidden = hidden;
      const reads = engineB.state.listReads;
      await until(() => engineB.state.listReads > reads, 8000);
      await Bun.sleep(200);
      expect(proxyRows(homeB).find(row => row.sessionId === claude.sessionId)).toMatchObject({ pid: reverse.pid, messagingSocketPath: reverse.messagingSocketPath });
      expect(existsSync(reverse.messagingSocketPath)).toBe(true);
    }

    // The reply goes to the reverse row and reaches Claude from the proxy row.
    const replyId = randomUUID();
    await sendFrames(homeB, reverse, [userFrame(reverse, codex.address, 'codex-fixture', codex.sessionId, replyId, 'the reply', 'bypass', null, [])]);
    const reply = await until(() => claude.frames.find(frame => frame.type === 'user' && frame.msg_id === replyId));
    expect(reply.from).toBe(`uds:${proxy.messagingSocketPath}`);
    expect(reply.type === 'user' && reply.message.content).toContain('\nthe reply\n');

    // A receipt keeps the original message ID.
    await sendFrames(homeB, reverse, [{ msgV: 1, type: 'control', msg_id: randomUUID(), from: codex.address, session_id: claude.sessionId,
      action: 'peer_message_status', orig_msg_id: msgId, status: 'delivered' }]);
    const receipt = await until(() => claude.frames.find(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === msgId));
    expect(receipt).toMatchObject({ from: `uds:${proxy.messagingSocketPath}`, status: 'delivered' });

    // An unknown outcome gives no receipt; the offline refusal below comes after it.
    engineA.state.unknown = true;
    const unknownId = randomUUID();
    await sendFrames(homeA, proxy, [userFrame(proxy, claude.address, 'claude-fixture', claude.sessionId, unknownId, 'maybe', 'prompting', null, [])]);
    await Bun.sleep(300);
    engineA.state.unknown = false;
    // An offline machine: the sender gets the refusal at once.
    engineA.state.offline = true;
    const lostId = randomUUID();
    await sendFrames(homeA, proxy, [userFrame(proxy, claude.address, 'claude-fixture', claude.sessionId, lostId, 'lost', 'prompting', null, [])]);
    const refusal = await until(() => claude.frames.find(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === lostId), 3000);
    expect(refusal).toMatchObject({ from: `uds:${proxy.messagingSocketPath}`, status: 'expired', status_detail: 'refused', reason: 'beta is not reachable.' });
    expect(claude.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === unknownId)).toBe(false);
    engineA.state.offline = false;

    // A killed relay leaves rows and sockets; its placeholders exit, and the next relay removes what is left.
    const oldRows = proxyRows(homeA);
    const oldSockets = readdirSync(join(root, 'a', 'relay'));
    expect(oldSockets.length).toBeGreaterThan(0);
    alpha.relay.child.kill('SIGKILL');
    await alpha.relay.child.exited;
    alpha.relay = undefined;
    for (const row of oldRows) await until(() => gone(row.pid), 5000);
    expect(readdirSync(join(root, 'a', 'relay'))).toEqual(oldSockets);
    alpha.relay = await startRelay(engineA.server.port!, join(root, 'a', 'relay'));
    for (const row of oldRows) expect(existsSync(join(homeA, 'sessions', `${row.pid}.json`))).toBe(false);
    for (const file of oldSockets) expect(existsSync(join(root, 'a', 'relay', file))).toBe(false);

    // SIGTERM removes the relay's own rows and sockets.
    await until(() => proxyRows(homeA).length === 1);
    for (const relay of relays()) { relay.child.kill('SIGTERM'); expect(await relay.child.exited).toBe(0); }
    alpha.relay = beta.relay = undefined;
    expect(readdirSync(join(homeA, 'sessions')).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(join(homeB, 'sessions')).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(join(root, 'a', 'relay'))).toEqual([]);
    expect(readdirSync(join(root, 'b', 'relay'))).toEqual([]);
  } finally {
    for (const relay of relays()) relay.child.kill('SIGKILL');
    await claude.close();
    await codex.close();
    engineA.server.stop(true);
    engineB.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

linux('/deliver-bound writes one frame to the bound record only, and the receipt of an exact message stays on this machine', async () => {
  const root = mkdtempSync('/tmp/asb-relay-bound-');
  const dirs = Object.fromEntries(['h1/claude/sessions', 'h2/claude/sessions', 'h1/s', 'h2/s'].map(item => {
    mkdirSync(join(root, item), { recursive: true, mode: 0o700 });
    return [item, join(root, item)];
  }));
  const home1 = join(root, 'h1', 'claude'), home2 = join(root, 'h2', 'claude');
  const sends: any[] = [];
  const receipts: any[] = [];
  const engine = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('x-asb-source-token') !== SOURCE_TOKEN) return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === '/api/relay/homes') return Response.json({ machineId: 'a'.repeat(16), machineName: 'alpha',
      homes: [{ path: home1, remoteClaude: 'auto', hasRemoteControl: false }, { path: home2, remoteClaude: 'auto', hasRemoteControl: false }] });
    if (path === '/api/relay/remote-peers') return Response.json({ peers: [] });
    if (path === '/api/relay/receipt') {
      receipts.push(await request.json());
      return Response.json({ sent: true });
    }
    sends.push(await request.json());
    return Response.json({ ok: true, outcome: 'socket-written' });
  } });
  const first = await agent(home1, dirs['h1/s']!, 'cli-one', 'cli');
  const second = await agent(home2, dirs['h2/s']!, 'cli-two', 'cli');
  // Another live session in the bound home: its frames are not the receipts of the bound process.
  const third = await agent(home1, dirs['h1/s']!, 'cli-three', 'cli');
  // The same session UUID in two homes, as two config profiles can have.
  const row = (configDir: string) => peers(configDir).find(peer => peer.entrypoint !== 'asb-relay')!;
  const twin = row(home2);
  writeFileSync(join(home2, 'sessions', `${twin.pid}.json`), JSON.stringify({ ...twin, sessionId: first.sessionId }), { mode: 0o600 });
  const target = peers(home1).find(peer => peer.sessionId === first.sessionId)!;
  let relay: Relay | undefined;
  try {
    relay = await startRelay(engine.port!, join(root, 'relay'));
    const sender = { machineId: 'b'.repeat(16), sessionId: randomUUID(), name: 'codex-task', mode: 'prompting', agent: 'codex' };
    const binding = (fields: Record<string, unknown> = {}) => ({ registryHome: realpathSync(join(home1, 'sessions')), runtimeSessionId: first.sessionId,
      pid: target.pid, procStart: target.procStart, messagingSocketPath: target.messagingSocketPath, msgId: fields.msgId ?? msgId, expiresAtMs: Date.now() + 10_000, ...fields });
    const msgId = randomUUID();
    const message = (id = msgId) => ({ msgId: id, text: 'exact hello', hopChain: [] });
    const deliverBound = (body: unknown) => fetch(`http://127.0.0.1:${relay!.port}/deliver-bound`, { method: 'POST',
      headers: { authorization: `Bearer ${relay!.token}` }, body: JSON.stringify(body) });
    const changed = [{ pid: target.pid + 100_000 }, { procStart: 'other' }, { messagingSocketPath: '/tmp/other.sock' }, { runtimeSessionId: randomUUID() },
      { registryHome: realpathSync(join(home2, 'sessions')) }, { registryHome: '/tmp/none/sessions' }];
    for (const fields of changed) {
      expect(await (await deliverBound({ binding: binding(fields), sender, message: message() })).json()).toEqual({ outcome: 'not-sent', reason: 'target-changed' });
    }
    // The binding is for another message ID than the frame.
    expect(await (await deliverBound({ binding: binding({ msgId: randomUUID() }), sender, message: message() })).json())
      .toEqual({ outcome: 'not-sent', reason: 'target-changed' });
    expect(await (await deliverBound({ binding: binding({ expiresAtMs: Date.now() - 1 }), sender, message: message() })).json())
      .toEqual({ outcome: 'not-sent', reason: 'binding-expired' });
    for (const body of [{ binding: binding(), sender, message: message(), extra: 1 }, { binding: binding(), sender }, null]) {
      expect((await deliverBound(body)).status).toBe(400);
    }
    expect(first.frames).toEqual([]);
    expect(second.frames).toEqual([]);

    expect(await (await deliverBound({ binding: binding(), sender, message: message() })).json()).toEqual({ outcome: 'submitted' });
    const received = await until(() => first.frames.find(frame => frame.type === 'user'));
    const reverse = await until(() => proxyRows(home1).find(item => item.sessionId === sender.sessionId));
    if (received.type !== 'user') throw new Error('Expected a user frame');
    expect([received.msg_id, received.session_id, received.from]).toEqual([msgId, first.sessionId, `uds:${reverse.messagingSocketPath}`]);
    expect(received.message.content).toContain(`from-name="${reverse.name}"`);
    expect(received.message.content).toContain('\nexact hello\n');
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toEqual([]);
    // The v1 route still searches by session ID: two homes have it.
    expect(await relayCall(relay, '/deliver', { targetSessionId: first.sessionId, sender, message: message(randomUUID()) }))
      .toEqual({ ok: false, reason: 'target-unavailable' });

    // The receipt of the bound target goes to the engine's exact route only (one call, no /api/relay/send).
    const otherId = randomUUID();
    const receipt = (fields: Record<string, unknown>, from = first.address) => ({ msgV: 1, type: 'control', msg_id: randomUUID(), from,
      session_id: sender.sessionId, action: 'peer_message_status', ...fields });
    await sendFrames(home1, reverse, [receipt({ orig_msg_id: msgId, status: 'delivered' })]);
    await until(() => receipts.length > 0);
    await Bun.sleep(200);
    expect(receipts).toEqual([{ machineId: sender.machineId, control: { action: 'peer_message_status', orig_msg_id: msgId, status: 'delivered' } }]);
    expect(sends).toEqual([]);
    // Another agent writes the same ID to the reverse row: no call at all.
    await sendFrames(home1, reverse, [receipt({ orig_msg_id: msgId, status: 'denied' }, third.address)]);
    await Bun.sleep(300);
    expect(receipts).toHaveLength(1);
    expect(sends).toEqual([]);
    // A mixed frame: the exact ID on the exact route, the legacy ID on the legacy forward without the exact ID.
    await sendFrames(home1, reverse, [receipt({ orig_msg_id: otherId, status: 'dropped', drop_reason: 'queue-full', dropped_msg_ids: [msgId, otherId] })]);
    await until(() => sends.length > 0 && receipts.length > 1);
    await Bun.sleep(200);
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toEqual({ machineId: sender.machineId, control: { action: 'peer_message_status', orig_msg_id: msgId, status: 'dropped',
      drop_reason: 'queue-full', dropped_msg_ids: [msgId] } });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ machineId: sender.machineId, targetSessionId: sender.sessionId,
      control: { orig_msg_id: otherId, status: 'dropped', dropped_msg_ids: [otherId] } });
    // A new user message from the target keeps the legacy path.
    await sendFrames(home1, reverse, [userFrame(reverse, first.address, 'cli-one', first.sessionId, randomUUID(), 'answer', 'prompting', null, [])]);
    await until(() => sends.length > 1);
    expect(sends[1].message.text).toBe('answer');

    // The target answers with its receipt at once, inside the 150 ms flush of the relay write: the receipt is still exact.
    const fastId = randomUUID();
    const pending = deliverBound({ binding: binding({ msgId: fastId }), sender, message: message(fastId) });
    await until(() => first.frames.some(frame => frame.type === 'user' && frame.msg_id === fastId), 2000);
    await sendFrames(home1, reverse, [receipt({ orig_msg_id: fastId, status: 'delivered' })]);
    expect(await (await pending).json()).toEqual({ outcome: 'submitted' });
    await until(() => receipts.length > 2);
    await Bun.sleep(200);
    expect(receipts.at(-1)).toEqual({ machineId: sender.machineId, control: { action: 'peer_message_status', orig_msg_id: fastId, status: 'delivered' } });
    expect(receipts).toHaveLength(3);
    expect(sends).toHaveLength(2);
  } finally {
    relay?.child.kill('SIGKILL');
    await first.close();
    await second.close();
    await third.close();
    engine.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

linux('/outbox writes the receipt of an exact member send to the receiver outbox and checks its body strictly', async () => {
  const root = mkdtempSync('/tmp/asb-relay-outbox-');
  const socketDir = join(root, 's');
  mkdirSync(join(root, 'claude', 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { mode: 0o700 });
  const engine = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('x-asb-source-token') !== SOURCE_TOKEN) return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === '/api/relay/homes') return Response.json({ machineId: 'a'.repeat(16), machineName: 'alpha', homes: [] });
    return Response.json({ peers: [] });
  } });
  const receipts: ExactReceipt[] = [];
  const close = await outboundServer(join(socketDir, 'r.out'), join(root, 'claude'), 'uds:/dev/null', () => true, () => {}, undefined,
    receipt => { receipts.push(receipt); return 1; });
  let relay: Relay | undefined;
  try {
    relay = await startRelay(engine.port!, join(root, 'relay'));
    const exactReceipt = { runtimeSessionId: randomUUID(), pid: 4242, procStart: '4242000', reference: `asb:1/${'b'.repeat(16)}/x`,
      msgIds: [randomUUID()], status: 'delivered' as const };
    const body = (fields: Record<string, unknown> = {}) => ({ configDir: join(root, 'claude'), messagingSocketPath: join(socketDir, 'r.sock'),
      request: { exactReceipt }, ...fields });
    const outbox = (value: unknown) => fetch(`http://127.0.0.1:${relay!.port}/outbox`, { method: 'POST',
      headers: { authorization: `Bearer ${relay!.token}` }, body: JSON.stringify(value) });
    for (const value of [{ ...body(), extra: 1 }, body({ configDir: 'claude' }), body({ request: {} }), body({ request: { exactReceipt, frames: [] } }),
      body({ messagingSocketPath: '' }), body({ request: { exactReceipt: { ...exactReceipt, text: 'hello' } } }), null]) {
      expect((await outbox(value)).status).toBe(400);
    }
    expect(receipts).toEqual([]);
    expect(await (await outbox(body())).json()).toEqual({ applied: 1 });
    expect(receipts).toEqual([exactReceipt]);
    // No outbox next to this inbox: nothing went out.
    expect(await (await outbox(body({ messagingSocketPath: join(socketDir, 'missing.sock') }))).json()).toEqual({ outcome: 'not-sent' });
    expect(receipts).toHaveLength(1);
  } finally {
    relay?.child.kill('SIGKILL');
    await close();
    engine.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
