import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hopChain, inbox, peers, processStart, sendFrames, socketPath, userFrame, type Frame } from '../src/claude';
import { proxyName, proxyPlan, type Home, type RemotePeer } from '../src/relay';
// POSIX only on Windows CI: Unix socket files and the /usr/bin/cat placeholder.
const posix = test.skipIf(process.platform === 'win32');

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
  const child = Bun.spawn(['/usr/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
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
  const state = { offline: false, hidden: false, listReads: 0 };
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

posix('two relays carry a message, the reply, a receipt, and an offline refusal between two homes', async () => {
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

    // An offline machine: the sender gets the refusal at once.
    engineA.state.offline = true;
    const lostId = randomUUID();
    await sendFrames(homeA, proxy, [userFrame(proxy, claude.address, 'claude-fixture', claude.sessionId, lostId, 'lost', 'prompting', null, [])]);
    const refusal = await until(() => claude.frames.find(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === lostId), 3000);
    expect(refusal).toMatchObject({ from: `uds:${proxy.messagingSocketPath}`, status: 'expired', status_detail: 'refused', reason: 'beta is not reachable.' });
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
