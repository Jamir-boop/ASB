// The P2 message path: the loopback and gateway routes run the contract replies in order and send one `/deliver-bound` frame, the
// rows carry `canMessage`/`messageReason` only while the message switch is ready (one registry read per scan), the relay starts
// with no member while a phone path is ready, and the chat marks a phone turn. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { createSwitchboardServer, loadSwitchboardDashboard } from '../src/switchboard.mjs';
import { createRelaySupervisor } from '../src/machine-relay.mjs';
import { parseClaudeChat } from '../src/claude-chat.mjs';

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const TOKEN = 'c'.repeat(64);
const MACHINE = '0123456789abcdef';
const SCOPE = 'ab'.repeat(16);
const CLI = '11111111-1111-4111-8111-111111111111';
const LOCAL = `local_${CLI}`;
const MSG = '22222222-2222-4222-8222-222222222222';

// The engine-side identity of a phone: the same shape that the message route builds.
const phoneSessionId = (deviceId) => {
  const hex = createHash('sha256').update(`phone\0${deviceId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
};

// The rules that relay.js `deliverBound` checks before its write: the first frame's ID is the binding's ID, the binding is not
// expired, and its bound fields are a live record's. A refusal is `not-sent` with the code that the route maps.
function deliverBoundRefusal(binding, message, nowMs = Date.now()) {
  if (!binding || !message || binding.msgId !== message.msgId) return 'target-changed';
  if (!Number.isInteger(binding.pid) || binding.pid <= 0 || typeof binding.procStart !== 'string' || !binding.procStart
    || typeof binding.messagingSocketPath !== 'string' || !binding.messagingSocketPath) return 'target-changed';
  if (!Number.isInteger(binding.expiresAtMs) || nowMs >= binding.expiresAtMs) return 'binding-expired';
  return null;
}

// One made-up engine with a Desktop row: the binder proves a live inbox, and the relay records each `/deliver-bound` frame.
async function fixture(t, options = {}) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-phone-msg-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  // The source registry root that the inbox read resolves (the injected reader gives the records).
  await mkdir(path.join(homeDir, '.claude', 'sessions'), { recursive: true });
  const registry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  const desktop = (index) => ({ id: `local:${index}`, externalId: `local_${'0'.repeat(7)}${index}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    provider: 'claude-desktop-code', providerLabel: 'Claude Desktop Code', surface: 'app', state: 'idle', title: `Synthetic ${index}`,
    sourceId: 'claude-desktop-code', sourceName: 'claude-desktop-code', updatedAtMs: 1_000 + index });
  const rows = options.rows ?? [desktop(1), desktop(2)];
  const state = { relay: options.relay !== false, bind: options.bind !== false, outcome: 'submitted', reason: undefined, reads: 0, slowMs: 0,
    message: options.message !== false };
  const frames = [];
  const bindings = [];
  const machineRelay = {
    running: () => state.relay,
    deliverBoundPhone: async (binding, sender, message) => {
      // One turn of the loop between the bind and the write, so a second POST can reach the in-flight check in between.
      await new Promise((resolve) => setImmediate(resolve));
      if (state.slowMs) await new Promise((resolve) => setTimeout(resolve, state.slowMs));
      const refusal = deliverBoundRefusal(binding, message);
      if (refusal) return { outcome: 'not-sent', reason: refusal };
      if (state.outcome !== 'not-sent') frames.push({ binding, sender, message });
      return state.outcome === 'not-sent' ? { outcome: 'not-sent', reason: state.reason } : { outcome: state.outcome };
    },
  };
  // The live inboxes of the one read per scan, as registry records (the injected reader gives them, not a real registry).
  const inboxIds = options.inboxIds ?? [rows[0]?.externalId].filter(Boolean);
  const liveInboxRead = async () => {
    state.reads += 1;
    return inboxIds.map((hostSessionId) => ({ entrypoint: 'claude-desktop', hostSessionId, messagingSocketPath: `/synthetic/${hostSessionId}.sock` }));
  };
  const singleton = { generatedAtMs: Date.now(), providers: [], threads: rows };
  const server = createSwitchboardServer({ sourceToken: TOKEN, pendingStatePath: false, palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: registry, machineIdentity: () => ({ machineId: MACHINE, machineName: 'synthetic-pc' }), referenceScopes: () => () => SCOPE,
    machineRelay, messageReady: () => state.message, readClaudeRegistryFolder: liveInboxRead,
    onMessage: (on) => { state.message = on; },
    bindMemberTarget: async (request) => {
      bindings.push(request);
      if (!state.bind) return { ok: false, code: 'not-live' };
      return { apiVersion: 1, ok: true, pid: process.pid, binding: { registryHome: '/synthetic/sessions',
        runtimeSessionId: '22222222-2222-4222-8222-222222222222', pid: 4242, procStart: '100', messagingSocketPath: '/tmp/synthetic.sock',
        msgId: request?.msgId ?? MSG, hostSessionId: LOCAL, expiresAtMs: Date.now() + 10_000 } };
    },
    loadDashboard: async (loadOptions) => {
      const loaded = await loadSwitchboardDashboard({ ...loadOptions, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) });
      // `options.reuse`: the same row objects at every scan, as a reused cache row or a member export gives them.
      if (options.reuse) { singleton.threads = rows; return singleton; }
      Object.defineProperty(loaded, 'threads', { value: rows.map((row) => ({ ...row })), configurable: true });
      return loaded;
    } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rowsOf = async (query = '') => JSON.parse(await (await fetch(`${base}/api/dashboard${query}`)).text()).threads;
  const row = async (index = 0) => (await rowsOf()).find((item) => item.id === rows[index].id);
  const send = async (body, headers = {}, index = 0) => fetch(`${base}/api/threads/${encodeURIComponent(rows[index].id)}/message`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { server, base, rows, rowsOf, row, send, frames, bindings, state, homeDir };
}

const newMessage = (overrides = {}) => ({ messageId: 'a'.repeat(32), text: 'Hello from the phone.', ...overrides });

test('the rows carry canMessage and messageReason only while the message switch is ready, with one registry read per scan', async (t) => {
  const f = await fixture(t);
  // Off (the default): neither field, so an old app shows no composer.
  const off = await fixture(t, { message: false });
  assert.equal((await off.row()).canMessage, undefined);
  assert.equal((await off.row()).messageReason, undefined);
  // On: a local Desktop row with a live inbox and a running relay can message.
  const row = await f.row();
  assert.deepEqual([row.canMessage, row.messageReason], [true, undefined]);
  // A row with no live inbox: not-live.
  assert.deepEqual(await (await fixture(t, { inboxIds: [] })).row().then((value) => [value.canMessage, value.messageReason]), [false, 'not-live']);
  // No relay: relay.
  assert.deepEqual(await (await fixture(t, { relay: false })).row().then((value) => [value.canMessage, value.messageReason]), [false, 'relay']);
  // Other providers, a CLI row, and a member row: unsupported.
  const mixed = await fixture(t, { rows: [
    { id: 'codex:1', externalId: MSG, provider: 'codex', providerLabel: 'Codex', surface: 'app', state: 'idle', title: 'Codex', updatedAtMs: 2_000 },
    { id: 'cli:1', externalId: CLI, provider: 'claude-desktop-code', providerLabel: 'Claude Code CLI', surface: 'cli', state: 'idle', title: 'CLI', updatedAtMs: 1_500 },
    { id: 'local:no-surface', externalId: 'local_00000000-0000-4000-8000-000000000005', provider: 'claude-desktop-code', providerLabel: 'Claude Desktop Code',
      state: 'idle', title: 'No surface', updatedAtMs: 1_400 },
    { id: `m:${MACHINE}:local:9`, externalId: 'local_00000000-0000-4000-8000-000000000009', provider: 'claude-desktop-code', providerLabel: 'Claude Desktop Code',
      surface: 'app', state: 'idle', title: 'Member', machineId: 'ffffffffffffffff', remote: true, updatedAtMs: 1_000 }] });
  const reasons = Object.fromEntries((await mixed.rowsOf()).map((item) => [item.id, [item.canMessage, item.messageReason]]));
  assert.deepEqual(reasons, { 'codex:1': [false, 'unsupported'], 'cli:1': [false, 'unsupported'], 'local:no-surface': [false, 'unsupported'],
    [`m:${MACHINE}:local:9`]: [false, 'unsupported'] });
});

test('50 Desktop rows take one registry read per scan', async (t) => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ id: `local:${index}`, externalId: `local_${'0'.repeat(7)}${index}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    provider: 'claude-desktop-code', providerLabel: 'Claude Desktop Code', surface: 'app', state: 'idle', title: `Desktop ${index}`,
    sourceId: 'claude-desktop-code', sourceName: 'claude-desktop-code', updatedAtMs: 10_000 + index }));
  const f = await fixture(t, { rows, inboxIds: rows.map((item) => item.externalId) });
  await f.rowsOf('?force=1');
  assert.equal(f.state.reads, 1, 'one read for 50 rows');
  assert.equal((await f.rowsOf('?force=1')).every((item) => item.canMessage === true), true);
});

test('the message route runs the contract replies in order and sends one frame with the exact text', async (t) => {
  const f = await fixture(t);
  // 404 at the match and after the token check when the switch is off.
  const off = await fixture(t, { message: false });
  const offReply = await off.send(newMessage());
  assert.deepEqual([offReply.status, await offReply.json()], [404, { error: 'Route is not available.' }]);
  assert.equal((await off.rowsOf()).some((item) => 'canMessage' in item), false);
  // 400: a bad shape or a bad text.
  for (const body of [{}, { messageId: 'a'.repeat(32) }, { messageId: 'A'.repeat(32), text: 'x' }, { messageId: 'a'.repeat(31), text: 'x' },
    { messageId: 'a'.repeat(32), text: 'x', extra: 1 }, { messageId: 1, text: 'x' }, { messageId: 'a'.repeat(32), text: '' },
    { messageId: 'a'.repeat(32), text: '   ' }, { messageId: 'a'.repeat(32), text: 'bell\x07' }, { messageId: 'a'.repeat(32), text: 'esc\x1b[31m' },
    { messageId: 'a'.repeat(32), text: 1 }, [], 'null', '{']) {
    const reply = await f.send(body);
    assert.deepEqual([reply.status, await reply.json()], [400, { error: 'Invalid message.' }], JSON.stringify(body));
  }
  // 413: above 4000 code points (after trim).
  const long = await f.send(newMessage({ text: `  ${'é'.repeat(4001)}  ` }));
  assert.deepEqual([long.status, await long.json()], [413, { error: 'The message is too long.' }]);
  assert.equal((await f.send(newMessage({ messageId: '9'.repeat(32), text: 'é'.repeat(4000) }))).status, 200);
  f.frames.length = 0;
  // 409 for a row that cannot take a message: a member row and an unknown row.
  const memberReply = await fetch(`${f.base}/api/threads/${encodeURIComponent(`m:${MACHINE}:x`)}/message`, { method: 'POST',
    headers: { origin: f.base, 'content-type': 'application/json' }, body: JSON.stringify(newMessage({ messageId: 'b'.repeat(32) })) });
  assert.deepEqual([memberReply.status, await memberReply.json()], [409, { error: 'This session cannot get messages from the phone.' }]);
  assert.equal((await f.send(newMessage({ messageId: 'b'.repeat(32) }), {}, 1)).status, 200);
  f.frames.length = 0;
  // 200: one frame, the exact text, the loopback device, and the Phone sender.
  const sent = await f.send(newMessage());
  assert.deepEqual([sent.status, await sent.json()], [200, { sent: true }]);
  assert.equal(f.frames.length, 1);
  const [frame] = f.frames;
  assert.deepEqual(frame.sender, { machineId: MACHINE, sessionId: phoneSessionId('loopback'), name: 'Phone', mode: 'unknown', agent: 'phone' });
  assert.deepEqual(frame.message.hopChain, []);
  assert.equal(frame.message.text, "[Sent from the owner's phone (phone) through ASB.]\nHello from the phone.");
  assert.equal(Buffer.byteLength(frame.message.text) > 0, true);
  // A newline and a tab stay as they are.
  const multi = await f.send(newMessage({ messageId: 'c'.repeat(32), text: 'line one\nline\ttwo' }));
  assert.equal(multi.status, 200);
  assert.ok(f.frames[1].message.text.endsWith('\nline one\nline\ttwo'));
});

test('the stored 200 for a repeated messageId sends no second frame, and two concurrent POSTs give one relay call', async (t) => {
  const f = await fixture(t);
  f.state.slowMs = 50;
  const message = newMessage();
  const first = await f.send(message);
  assert.deepEqual([first.status, await first.json()], [200, { sent: true }]);
  assert.equal(f.frames.length, 1);
  // The repeated ID gives the stored reply, with one relay call in total.
  const again = await f.send(message);
  assert.deepEqual([again.status, await again.json()], [200, { sent: true }]);
  assert.equal(f.frames.length, 1);
  // Two concurrent POSTs with one ID: one 200, one "being sent", and one frame.
  const id = 'd'.repeat(32);
  const [one, two] = await Promise.all([f.send(newMessage({ messageId: id })), f.send(newMessage({ messageId: id }))]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const refused = one.status === 409 ? one : two;
  assert.deepEqual(await refused.json(), { error: 'This message is being sent.' });
  assert.equal(f.frames.length, 2);
  // The same ID on another row is a new send (the once list is keyed by thread ID and messageId).
  const other = await f.send(message, {}, 1);
  assert.deepEqual([other.status, await other.json()], [200, { sent: true }]);
  assert.equal(f.frames.length, 3);
});

test('the rate limit is 6 messages in 60 s per device and not for another device', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index += 1) assert.equal((await f.send(newMessage({ messageId: index.toString(16).padStart(32, '0') }))).status, 200);
  const over = await f.send(newMessage({ messageId: 'f'.repeat(32) }));
  assert.deepEqual([over.status, await over.json()], [429, { error: 'Too many messages. Try again in a minute.' }]);
  assert.equal(f.frames.length, 6);
  // Another device is not limited.
  const other = await f.send(newMessage({ messageId: 'e'.repeat(32) }), { 'x-asb-phone-device-id': 'a'.repeat(12), 'x-asb-phone-device-name': 'Pixel' });
  assert.equal(other.status, 200);
  assert.equal(f.frames.length, 7);
});

test('the 409 replies for no live inbox and no relay, and the not-sent mappings', async (t) => {
  const message = newMessage({ messageId: '1'.repeat(32) });
  const offline = await fixture(t, { bind: false });
  assert.deepEqual([(await offline.send(message)).status, offline.frames.length], [409, 0]);
  assert.deepEqual(await (await offline.send(message)).json(), { error: 'Open the session on the PC to send a message.' });
  const relayOff = await fixture(t, { relay: false });
  assert.deepEqual(await (await relayOff.send(message)).json(), { error: 'Cannot send now: the ASB message relay is not running on the PC.' });
  for (const [reason, status, error] of [['target-unavailable', 409, 'Open the session on the PC to send a message.'],
    ['target-changed', 409, 'Open the session on the PC to send a message.'], ['rate-limited', 429, 'Too many messages. Try again in a minute.'],
    ['binding-expired', 409, 'Cannot send now. Try again on the PC.'], ['relay-unavailable', 409, 'Cannot send now. Try again on the PC.']]) {
    const stopped = await fixture(t);
    stopped.state.outcome = 'not-sent';
    stopped.state.reason = reason;
    const reply = await stopped.send(message);
    assert.deepEqual([reply.status, (await reply.json()).error], [status, error], reason);
    // The mark goes on not-sent: a retry reaches the relay again.
    stopped.state.outcome = 'submitted';
    assert.equal((await stopped.send(message)).status, 200);
    assert.equal(stopped.frames.length, 1);
  }
  // An unknown outcome: 200, and the ID stays, so a retry gives the stored 200 with one frame.
  const unknown = await fixture(t);
  unknown.state.outcome = 'unknown';
  const first = await unknown.send(message);
  assert.deepEqual([first.status, await first.json()], [200, { sent: true }]);
  assert.deepEqual([(await unknown.send(message)).status, unknown.frames.length], [200, 1]);
});

test('the frame checks a mismatched binding ID as target-changed, as relay.js does', async (t) => {
  // The fake relay makes the real check: two IDs would fail here, so the binding and the message must carry one ID.
  const f = await fixture(t);
  assert.equal((await f.send(newMessage())).status, 200);
  const { binding, message } = f.frames[0];
  assert.equal(binding.msgId, message.msgId);
  const live = f.bindings.filter((request) => request.msgId === binding.msgId);
  assert.equal(live.length, 1);
});

test('the gateway sets both device headers on the message proxy and drops any copy from the phone', async (t) => {
  const upstream = [];
  const local = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    upstream.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"sent":true}');
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => local.close(resolve)));
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-phone-msg-gateway-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let messageReady = false;
  const gateway = createPhoneGateway({ localPort: local.address().port, asbVersion: 'test', settingsPath: path.join(home, 'phone.json'),
    tlsDir: path.join(home, 'tls'), listAddresses: () => [{ address: '127.0.0.1', interface: 'lo', kind: 'lan' }], hostName: 'synthetic-pc' });
  await gateway.start();
  const port = await freePort();
  messageReady = await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port, sendText: true, message: true });
  assert.equal(gateway.messageReady(), true, messageReady.error);
  t.after(() => gateway.stop());
  const info = await gateway.createPairing();
  const code = new URL(info.uri).searchParams.get('c');
  const call = (route, options) => new Promise((resolve, reject) => {
    const client = https.request({ host: '127.0.0.1', port, path: route, rejectUnauthorized: false, agent: false, ...options }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    client.on('error', reject);
    client.end(options.body);
  });
  const paired = JSON.parse((await call('/phone/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Test phone' }) })).text);
  const body = { messageId: 'a'.repeat(32), text: 'Hello.' };
  const reply = await call(`/phone/v1/threads/${encodeURIComponent(LOCAL)}/message`, { method: 'POST',
    headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json', 'x-asb-phone-device-id': 'ffffffffffff',
      'x-asb-phone-device-name': 'Fake%20phone' }, body: JSON.stringify(body) });
  assert.equal(reply.status, 200);
  const sent = upstream.at(-1);
  assert.equal(sent.url, `/api/threads/${encodeURIComponent(LOCAL)}/message`);
  assert.equal(sent.headers['x-asb-phone-device-id'], paired.deviceId);
  assert.equal(decodeURIComponent(sent.headers['x-asb-phone-device-name']), 'Test phone');
  // A switch change to off gives 404 at the route, before and after the token, and nothing reaches the PC.
  await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port, message: false });
  const route = `/phone/v1/threads/${encodeURIComponent(LOCAL)}/message`;
  const calls = upstream.length;
  for (const token of [undefined, paired.token]) {
    const off = await call(route, { method: 'POST', ...(token ? { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } } : {}),
      body: JSON.stringify(body) });
    assert.deepEqual([off.status, JSON.parse(off.text)], [404, { error: 'Route is not available.' }]);
  }
  assert.equal(upstream.length, calls);
  // Only POST reaches it.
  assert.equal((await call(route, { headers: { authorization: `Bearer ${paired.token}` } })).status, 404);
  // No member route and no GET.
  assert.equal((await call(`/peer/v1/threads/${encodeURIComponent(LOCAL)}/message`, { method: 'POST',
    headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 404);
});

test('the relay starts with no member while the message switch and a Desktop source are on, and a change checks it', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-phone-msg-relay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'bridge', 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'bridge', 'dist', 'relay.js'), '');
  await writeFile(path.join(dir, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(path.join(dir, 'bin', 'cat'), '#!/bin/sh\n', { mode: 0o755 });
  const spawns = [];
  const state = { message: true, desktop: true };
  const group = { self: () => ({ machineId: MACHINE, name: 'alpha' }), selfName: () => 'alpha', peerStates: () => [], tls: async () => ({ fingerprint: 'own' }) };
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const fakeChild = () => {
    const value = new EventEmitter();
    Object.assign(value, { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
    value.kill = () => { setImmediate(() => value.emit('exit', 0, null)); return true; };
    return value;
  };
  const supervisor = createRelaySupervisor({ group, port: 4659, sourceToken: TOKEN, root: dir, platform: 'linux',
    env: { PATH: path.join(dir, 'bin'), XDG_RUNTIME_DIR: path.join(dir, 'run') }, log: () => {}, firstLineMs: 200, stopMs: 50,
    forAnswers: async () => state.message && state.desktop,
    spawn: () => {
      const value = fakeChild();
      spawns.push(value);
      setImmediate(() => value.stdout.write(`${JSON.stringify({ port: 1, token: 'e'.repeat(64) })}\n`));
      return value;
    } });
  t.after(() => supervisor.stop());
  state.message = false;
  await supervisor.start();
  assert.equal(spawns.length, 0, 'no relay with the message switch off');
  state.message = true;
  await supervisor.check();
  assert.equal(spawns.length, 1, 'the relay starts for messages');
  assert.equal(supervisor.running(), true);
  state.desktop = false;
  await supervisor.check();
  assert.equal(supervisor.running(), false);
});

test('the chat marks a phone message turn with fromPhone, and no other peer turn', () => {
  const at = (second) => `2026-11-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  const peer = (second, name, body) => ({ type: 'attachment', timestamp: at(second), attachment: { type: 'queued_command', origin: { kind: 'peer', name, body } } });
  const line = "[Sent from the owner's phone (Pixel) through ASB.]\nHello.";
  const turns = parseClaudeChat(JSON.stringify(peer(1, 'Phone', line)) + '\n'
    + JSON.stringify(peer(2, 'Phone-2', line)) + '\n'
    + JSON.stringify(peer(3, 'Phone', 'A peer without the first line.')) + '\n'
    + JSON.stringify(peer(4, 'Desk', line)) + '\n'
    + JSON.stringify(peer(5, 'Phone-x', line)) + '\n'
    + JSON.stringify(peer(6, 'Phone-2',
      "[Sent from the owner's phone (Pixel) through ASB. It answers your question: \"Go on?\"]\nGo on")) + '\n');
  assert.deepEqual(turns.map((turn) => [turn.name, turn.fromPhone]), [
    ['Phone', true], ['Phone-2', true], ['Phone', undefined], ['Desk', undefined], ['Phone-x', undefined], ['Phone-2', true]]);
});

test('the settings route takes the message switch and refuses it without message text with 400', async (t) => {
  const { createAsbServer } = await import('../src/asb-server.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-phone-msg-settings-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const gateway = createPhoneGateway({ localPort: 12345, asbVersion: 'test', settingsPath: path.join(home, 'phone.json'),
    tlsDir: path.join(home, 'tls'), listAddresses: () => [] });
  await gateway.start();
  t.after(() => gateway.stop());
  const server = createAsbServer({ sourceToken: TOKEN, phoneGateway: gateway, pendingStatePath: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/phone/settings`, { method: 'POST',
    headers: { 'x-asb-source-token': TOKEN, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const baseBody = { enabled: false, bindAddresses: [], port: 4630 };
  // message true with sendText off: the gateway's 400 text through the route.
  const refused = await post({ ...baseBody, message: true });
  assert.deepEqual([refused.status, await refused.json()], [400, { error: 'Turn on message text first.' }]);
  // A non-boolean message is an invalid phone action.
  assert.deepEqual([(await post({ ...baseBody, message: 1 })).status], [400]);
  // On, and the status and the hello-like read carry it.
  assert.equal((await post({ ...baseBody, sendText: true, message: true })).status, 200);
  const status = await (await fetch(`${base}/api/phone`, { headers: { 'x-asb-source-token': TOKEN } })).json();
  assert.deepEqual([status.sendText, status.message], [true, true]);
});

// The P2 feature on one server, with the same row objects at every scan (a reused cache row, a member export): the switch off
// clears both fields of those rows, and a row that gains or loses a reason never keeps the old text.
test('reused rows never keep canMessage or messageReason', async (t) => {
  const f = await fixture(t, { reuse: true, relay: false });
  // On, the relay down: the live row can message, the row without an inbox says not-live.
  const first = await f.rowsOf('?force=1');
  assert.deepEqual(first.map((row) => [row.canMessage, row.messageReason]), [[false, 'relay'], [false, 'not-live']]);
  // The relay up: the same rows, and no row keeps an old reason.
  f.state.relay = true;
  assert.deepEqual((await f.rowsOf('?force=1')).map((row) => [row.canMessage, row.messageReason]), [[true, undefined], [false, 'not-live']]);
  // The switch off on the same server and rows (the gateway's onMessage calls it): no row has either field at the next scan.
  f.state.message = false;
  f.server.invalidateDashboard('phone-message');
  for (const row of await f.rowsOf('?force=1')) assert.deepEqual([row.id, 'canMessage' in row, 'messageReason' in row], [row.id, false, false]);
  // On again with the relay down: relay; relay up: true with no reason.
  f.state.message = true;
  f.state.relay = false;
  assert.deepEqual((await f.rowsOf('?force=1')).map((row) => [row.canMessage, row.messageReason]), [[false, 'relay'], [false, 'not-live']]);
  f.state.relay = true;
  assert.deepEqual((await f.rowsOf('?force=1')).map((row) => [row.canMessage, row.messageReason]), [[true, undefined], [false, 'not-live']]);
});
