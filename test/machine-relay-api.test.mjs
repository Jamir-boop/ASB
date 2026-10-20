import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createAsbServer } from '../src/asb-server.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { createRelaySupervisor, RELAY_STOPPED, relayHomes, validPeerList, validRelayBody, validRelayReply } from '../src/machine-relay.mjs';

const A = 'a'.repeat(16);
const B = 'b'.repeat(16);
const ID = '123e4567-e89b-12d3-a456-426614174000';
const ID2 = '123e4567-e89b-12d3-a456-426614174001';
const TOKEN = 'd'.repeat(64);
const message = () => ({ targetSessionId: ID, sender: { machineId: A, sessionId: ID2, name: 'claude-task', mode: 'prompting', agent: 'claude' },
  message: { msgId: ID, text: 'hello', hopChain: ['1'.repeat(24)] } });
const control = () => ({ targetSessionId: ID, sender: { machineId: A, sessionId: ID2, name: 'codex-task', mode: 'unknown', agent: 'codex' },
  control: { action: 'peer_message_status', orig_msg_id: ID, status: 'delivered' } });

async function until(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-relay-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the relay body has exactly the plan 9.7 keys and types', () => {
  assert.equal(validRelayBody(message()), true);
  assert.equal(validRelayBody(control()), true);
  assert.equal(validRelayBody({ ...message(), machineId: B }, { withMachine: true }), true);
  assert.equal(validRelayBody({ ...message(), machineId: B }), false);
  assert.equal(validRelayBody(message(), { withMachine: true }), false);
  const full = control();
  Object.assign(full.control, { status_detail: 'refused', reason: 'r'.repeat(1000), drop_reason: 'queue-full', dropped_msg_ids: Array(256).fill(ID) });
  assert.equal(validRelayBody(full), true);
  const change = (base, edit) => { const value = base(); edit(value); return validRelayBody(value); };
  for (const edit of [
    (value) => { value.extra = 1; }, (value) => { delete value.message; }, (value) => { value.control = control().control; },
    (value) => { value.targetSessionId = 'not-a-uuid'; }, (value) => { value.sender.machineId = 'A'.repeat(16); },
    (value) => { value.sender.machineId = 'a'.repeat(15); }, (value) => { value.sender.sessionId = 1; }, (value) => { value.sender.name = ''; },
    (value) => { value.sender.name = 'n'.repeat(129); }, (value) => { value.sender.name = 'line\nbreak'; }, (value) => { value.sender.name = 'c1\x85'; },
    (value) => { value.sender.mode = 'auto'; }, (value) => { value.sender.agent = 'opencode'; }, (value) => { value.sender.extra = true; },
    (value) => { delete value.sender.mode; }, (value) => { value.message.msgId = 'x'; }, (value) => { value.message.text = ''; },
    (value) => { value.message.text = 'x'.repeat(1_048_577); }, (value) => { value.message.text = 5; },
    (value) => { value.message.hopChain = Array(33).fill('1'.repeat(24)); }, (value) => { value.message.hopChain = ['1'.repeat(23)]; },
    (value) => { value.message.hopChain = ['G'.repeat(24)]; }, (value) => { value.message.hopChain = 'x'; }, (value) => { value.message.extra = 1; },
  ]) assert.equal(change(message, edit), false, edit.toString());
  assert.equal(change(message, (value) => { value.message.text = 'x'.repeat(1_048_576); value.message.hopChain = Array(32).fill('1'.repeat(24)); }), true);
  assert.equal(change(message, (value) => { value.sender.name = 'n'.repeat(128); }), true);
  for (const edit of [
    (value) => { value.control.action = 'notify_when_idle'; }, (value) => { value.control.orig_msg_id = 'x'; }, (value) => { value.control.status = 'busy'; },
    (value) => { value.control.status_detail = 'd'.repeat(65); }, (value) => { value.control.reason = 'r'.repeat(1001); },
    (value) => { value.control.drop_reason = 'd'.repeat(65); }, (value) => { value.control.dropped_msg_ids = Array(257).fill(ID); },
    (value) => { value.control.dropped_msg_ids = ['x']; }, (value) => { value.control.reason = 1; }, (value) => { value.control.msg_id = ID; },
  ]) assert.equal(change(control, edit), false, edit.toString());
  for (const value of [null, [], 'x', {}]) assert.equal(validRelayBody(value), false);
});

test('relay replies and member peer lists are checked strictly', () => {
  assert.equal(validRelayReply({ ok: true, outcome: 'socket-written' }), true);
  for (const reason of ['machine-offline', 'target-unavailable', 'too-large', 'rate-limited', 'refused']) assert.equal(validRelayReply({ ok: false, reason }), true);
  for (const value of [{ ok: true }, { ok: false, reason: 'other' }, { ok: true, outcome: 'socket-written', extra: 1 }, { ok: 'true', outcome: 'socket-written' }, null]) {
    assert.equal(validRelayReply(value), false);
  }
  const good = { sessionId: ID, name: 'task', agent: 'codex', status: 'idle', remoteControl: false };
  assert.deepEqual(validPeerList({ peers: [good, { ...good, extra: 1 }, { ...good, name: '' }, { ...good, agent: 'opencode' },
    { ...good, status: 's'.repeat(33) }, { ...good, remoteControl: 'no' }, { ...good, sessionId: 'x' }] }), [good]);
  assert.equal(validPeerList({ peers: Array(257).fill(good) }), null);
  assert.equal(validPeerList({ peers: [], extra: 1 }), null);
  assert.equal(validPeerList([]), null);
});

test('the homes list dedupes real folders, keeps the first override, adds the default homes, and reads Remote Control', async (t) => {
  const dir = await temporary(t);
  const homeDir = path.join(dir, 'home');
  const work = path.join(dir, 'work');
  const extra = path.join(dir, 'extra');
  for (const folder of [path.join(homeDir, '.claude', 'sessions'), path.join(work, 'sessions'), extra]) await mkdir(folder, { recursive: true });
  await symlink(work, path.join(dir, 'work-link'));
  const procStart = await processStart(process.pid);
  await writeFile(path.join(work, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId: ID, name: 'task',
    bridgeSessionId: 'session_remote' }));
  // A proxy row does not count as Remote Control.
  await writeFile(path.join(homeDir, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId: ID2,
    name: 'proxy', entrypoint: 'asb-relay', bridgeSessionId: 'session_proxy' }));
  const claude = (projectsDir, extraFields = {}) => ({ provider: 'claude-desktop-code', enabled: true, projectsDir, ...extraFields });
  const sources = [
    { provider: 'codex', enabled: true, dataDir: path.join(dir, 'codex') },
    claude(path.join(dir, 'work-link', 'projects'), { remoteClaude: 'native' }),
    claude(path.join(work, 'projects'), { remoteClaude: 'bridge' }),
    claude(path.join(dir, 'missing', 'projects')),
    claude(path.join(extra, 'projects'), { enabled: false }),
  ];
  const homes = await relayHomes(sources, { homeDir, env: { CLAUDE_CONFIG_DIR: extra } });
  assert.deepEqual(homes, [
    { path: work, remoteClaude: 'native', hasRemoteControl: true },
    { path: path.join(homeDir, '.claude'), remoteClaude: 'auto', hasRemoteControl: false },
    { path: extra, remoteClaude: 'auto', hasRemoteControl: false },
  ]);
  assert.deepEqual((await relayHomes([], { homeDir: dir, env: { CLAUDE_CONFIG_DIR: 'extra' } })), []);
});

test('the homes list uses a sessions folder once when a profile links it to the default home', async (t) => {
  const dir = await temporary(t);
  const homeDir = path.join(dir, 'home');
  const profile = path.join(dir, 'profile');
  await mkdir(path.join(homeDir, '.claude', 'sessions'), { recursive: true });
  await mkdir(profile);
  await symlink(path.join(homeDir, '.claude', 'sessions'), path.join(profile, 'sessions'));
  const sources = [{ provider: 'claude-desktop-code', enabled: true, projectsDir: path.join(profile, 'projects'), remoteClaude: 'bridge' }];
  assert.deepEqual(await relayHomes(sources, { homeDir, env: {} }), [{ path: profile, remoteClaude: 'bridge', hasRemoteControl: false }]);
});

// A child process double: it prints `line`, and exits with `exitCode` when that is set.
function fakeChild({ line, exitCode = null, ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, signals: [] });
  const finish = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.stdout.end();
    child.emit('exit', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    if (!(signal === 'SIGTERM' && ignoreTerm)) setImmediate(() => finish(null, signal));
    return true;
  };
  setImmediate(() => {
    if (line !== undefined) child.stdout.write(`${line}\n`);
    if (exitCode !== null) setImmediate(() => finish(exitCode, null));
  });
  return child;
}

function fakeGroup(members = [B]) {
  const states = members.map((machineId) => ({ online: true, member: { machineId, name: machineId === B ? 'beta' : 'gamma',
    certFingerprint: machineId + 'f'.repeat(48), addresses: [{ kind: 'lan', address: '10.0.0.2' }], port: 4630 } }));
  return { states, self: () => ({ machineId: A, name: 'alpha' }), selfName: () => 'alpha', peerStates: () => states, tls: async () => ({ fingerprint: 'own' }) };
}

// A root with bridge/dist/relay.js, a PATH with an executable `bun`, and a runtime folder.
async function supervisorFixture(t, options = {}) {
  const dir = await temporary(t);
  await mkdir(path.join(dir, 'bridge', 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'bridge', 'dist', 'relay.js'), '');
  await writeFile(path.join(dir, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
  const spawns = [];
  const logs = [];
  const group = options.group || fakeGroup();
  const supervisor = createRelaySupervisor({ group, port: 4659, sourceToken: TOKEN, root: dir, platform: 'linux',
    env: { PATH: path.join(dir, 'bin'), XDG_RUNTIME_DIR: path.join(dir, 'run') }, log: (line) => logs.push(line), firstLineMs: 200, stopMs: 50,
    catPath: '/usr/bin/cat', ...options.supervisor,
    spawn: (command, args, spawnOptions) => {
      const child = (options.child || (() => fakeChild({ line: JSON.stringify({ port: 1, token: 'e'.repeat(64) }) })))(spawns.length);
      spawns.push({ command, args, options: spawnOptions, child });
      return child;
    } });
  t.after(() => supervisor.stop());
  return { dir, spawns, logs, group, supervisor };
}

test('the supervisor starts the relay only when every start condition holds', async (t) => {
  for (const [name, change] of [
    ['no other member', async (f) => { f.group.states.length = 0; }],
    ['no bun', async (f) => { await rm(path.join(f.dir, 'bin', 'bun')); }],
    ['no relay.js', async (f) => { await rm(path.join(f.dir, 'bridge', 'dist', 'relay.js')); }],
  ]) {
    const f = await supervisorFixture(t);
    await change(f);
    await f.supervisor.start();
    assert.equal(f.spawns.length, 0, name);
  }
  for (const supervisor of [{ platform: 'win32' }, { catPath: '/nonexistent/cat' }]) {
    const f = await supervisorFixture(t, { supervisor });
    await f.supervisor.start();
    assert.equal(f.spawns.length, 0, JSON.stringify(supervisor));
  }
  const f = await supervisorFixture(t);
  await f.supervisor.start();
  assert.equal(f.spawns.length, 1);
  const [spawned] = f.spawns;
  assert.equal(spawned.command, path.join(f.dir, 'bin', 'bun'));
  assert.deepEqual(spawned.args, [path.join(f.dir, 'bridge', 'dist', 'relay.js')]);
  assert.deepEqual(spawned.options.stdio, ['pipe', 'pipe', 'inherit']);
  assert.deepEqual([spawned.options.env.ASB_ENGINE_URL, spawned.options.env.ASB_SOURCE_TOKEN, spawned.options.env.ASB_RELAY_DIR],
    ['http://127.0.0.1:4659', TOKEN, path.join(f.dir, 'run', 'asb', 'relay')]);
  assert.equal(f.supervisor.running(), true);
  // The condition ends: SIGTERM, then SIGKILL when the relay does not exit.
  f.group.states.length = 0;
  await f.supervisor.check();
  assert.deepEqual(spawned.child.signals, ['SIGTERM']);
  assert.equal(f.supervisor.running(), false);
  const stubborn = await supervisorFixture(t, { child: () => fakeChild({ line: JSON.stringify({ port: 1, token: 'e'.repeat(64) }), ignoreTerm: true }) });
  await stubborn.supervisor.start();
  await stubborn.supervisor.stop();
  assert.deepEqual(stubborn.spawns[0].child.signals, ['SIGTERM', 'SIGKILL']);
});

test('a wrong first line or a crash restarts the relay at most 5 times in 10 minutes', async (t) => {
  for (const line of ['{"port":0,"token":"' + 'e'.repeat(64) + '"}', '{"port":1,"token":"short"}', 'not json', undefined]) {
    const f = await supervisorFixture(t, { child: (index) => index ? fakeChild({ line: JSON.stringify({ port: 1, token: 'e'.repeat(64) }) }) : fakeChild({ line }) });
    await f.supervisor.start();
    await until(() => f.supervisor.running());
    assert.equal(f.spawns.length, 2, String(line));
    assert.deepEqual(f.spawns[0].child.signals, ['SIGKILL']);
  }
  const f = await supervisorFixture(t, { child: () => fakeChild({ line: JSON.stringify({ port: 1, token: 'e'.repeat(64) }), exitCode: 1 }) });
  await f.supervisor.start();
  await until(() => f.logs.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.spawns.length, 6);
  assert.deepEqual(f.logs, [RELAY_STOPPED]);
  await f.supervisor.check();
  assert.equal(f.spawns.length, 6);
  // The condition goes false and true again: the relay may start again.
  const states = [...f.group.states];
  f.group.states.length = 0;
  await f.supervisor.check();
  f.group.states.push(...states);
  await f.supervisor.check();
  assert.equal(f.spawns.length, 7);
  // A clean exit is not a crash.
  const clean = await supervisorFixture(t, { child: () => fakeChild({ line: JSON.stringify({ port: 1, token: 'e'.repeat(64) }), exitCode: 0 }) });
  await clean.supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clean.spawns.length, 1);
});

// A fake relay process: its HTTP routes, behind the token that its first line gives.
async function fakeRelay(t, routes) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, host: request.headers.host,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined });
    const [status, body] = routes[`${request.method} ${request.url}`] || [404, { error: 'Not found.' }];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, line: JSON.stringify({ port: server.address().port, token: 'e'.repeat(64) }), port: server.address().port };
}

test('the member routes use the relay, check the sender machine, and answer without a relay', async (t) => {
  const f = await supervisorFixture(t, { group: fakeGroup([]) });
  const caller = B + 'f'.repeat(48);
  assert.deepEqual(await f.supervisor.peerPeers(), { status: 200, body: { peers: [] } });
  assert.deepEqual(await f.supervisor.peerDeliver({ ...message(), extra: 1 }, caller), { status: 400, body: { error: 'Invalid relay request.' } });
  assert.deepEqual(await f.supervisor.peerDeliver(message(), caller), { status: 403, body: { error: 'The sender machine does not match.' } });
  const fromB = message();
  fromB.sender.machineId = B;
  assert.deepEqual(await f.supervisor.peerDeliver(fromB, caller), { status: 200, body: { ok: false, reason: 'target-unavailable' } });
  await assert.rejects(f.supervisor.relayRequest('/peers'), { code: 'relay-unavailable' });

  const peer = { sessionId: ID, name: 'task', agent: 'claude', status: 'idle', remoteControl: true };
  const relay = await fakeRelay(t, { 'GET /peers': [200, { peers: [peer, { ...peer, name: '' }] }], 'POST /deliver': [200, { ok: false, reason: 'rate-limited' }] });
  const live = await supervisorFixture(t, { child: () => fakeChild({ line: relay.line }) });
  await live.supervisor.start();
  assert.deepEqual(await live.supervisor.peerPeers(), { status: 200, body: { peers: [peer] } });
  assert.deepEqual(await live.supervisor.peerDeliver(fromB, caller), { status: 200, body: { ok: false, reason: 'rate-limited' } });
  assert.deepEqual(relay.calls.map(({ method, url, authorization, host }) => [method, url, authorization, host]), [
    ['GET', '/peers', `Bearer ${'e'.repeat(64)}`, `127.0.0.1:${relay.port}`], ['POST', '/deliver', `Bearer ${'e'.repeat(64)}`, `127.0.0.1:${relay.port}`]]);
  assert.deepEqual(relay.calls[1].body, fromB);
  // A reply of another shape is not passed on.
  const odd = await fakeRelay(t, { 'POST /deliver': [200, { ok: true }] });
  const oddLive = await supervisorFixture(t, { child: () => fakeChild({ line: odd.line }) });
  await oddLive.supervisor.start();
  assert.deepEqual(await oddLive.supervisor.peerDeliver(fromB, caller), { status: 200, body: { ok: false, reason: 'target-unavailable' } });
});

test('the call to the relay has one total deadline, also after the reply headers', async (t) => {
  const server = http.createServer((request, response) => {
    // Headers, part of the body, and then nothing.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const f = await supervisorFixture(t, { child: () => fakeChild({ line: JSON.stringify({ port: server.address().port, token: 'e'.repeat(64) }) }) });
  await f.supervisor.start();
  const started = Date.now();
  await assert.rejects(f.supervisor.relayRequest('/deliver', { method: 'POST', body: message(), timeoutMs: 150 }),
    { code: 'relay-unavailable', message: 'The message relay did not answer.' });
  assert.ok(Date.now() - started < 1000);
});

test('send and remote-peers use the member lists: offline at once, and errors map to the plan 2.3 reasons', async (t) => {
  const relay = await fakeRelay(t, {});
  let clock = 1_000_000;
  const requests = [];
  const listed = { sessionId: ID, name: 'codex-task', agent: 'codex', status: 'busy', remoteControl: false };
  let deliver = async () => ({ status: 200, body: { ok: true, outcome: 'socket-written' } });
  const f = await supervisorFixture(t, { group: fakeGroup([B, 'c'.repeat(16)]), child: () => fakeChild({ line: relay.line }), supervisor: { now: () => clock,
    request: async (options) => {
      requests.push(options);
      if (options.path === '/peer/v1/peers') {
        if (options.member.machineId !== B) throw new Error('timeout');
        return { status: 200, body: { peers: [listed, { bad: true }] } };
      }
      return deliver(options);
    } } });
  await f.supervisor.start();
  await until(() => f.supervisor.remotePeers().peers.length === 1);
  assert.deepEqual(f.supervisor.remotePeers(), { peers: [{ machineId: B, machineName: 'beta', online: true, ...listed }] });
  assert.deepEqual(requests.filter((item) => item.path === '/peer/v1/peers').map((item) => item.tls), [{ fingerprint: 'own' }, { fingerprint: 'own' }]);

  const send = (edit = () => {}) => { const body = { ...message(), machineId: B }; edit(body); return f.supervisor.send(body); };
  const ok = { status: 200, body: { ok: true, outcome: 'socket-written' } };
  assert.deepEqual(await send(), ok);
  const forwarded = requests.at(-1);
  assert.deepEqual([forwarded.path, forwarded.method, forwarded.timeoutMs, forwarded.member.machineId, forwarded.lastAddress], ['/peer/v1/deliver', 'POST', 10_000, B, undefined]);
  // The delivery goes first to the address that the read-only polls proved.
  f.group.states[0].lastAddress = '10.0.0.3';
  assert.deepEqual(await send(), ok);
  assert.equal(requests.at(-1).lastAddress, '10.0.0.3');
  assert.deepEqual(forwarded.body, message());
  assert.deepEqual(await send((body) => { body.extra = 1; }), { status: 400, body: { error: 'Invalid relay request.' } });
  assert.deepEqual(await send((body) => { body.sender.machineId = B; }), { status: 400, body: { error: 'Invalid relay request.' } });
  for (const machineId of [A, 'f'.repeat(16)]) assert.deepEqual(await send((body) => { body.machineId = machineId; }), { status: 200, body: { ok: false, reason: 'refused' } });
  // The member without a peer list is offline: no request.
  const count = requests.length;
  assert.deepEqual(await send((body) => { body.machineId = 'c'.repeat(16); }), { status: 200, body: { ok: false, reason: 'machine-offline' } });
  assert.equal(requests.filter((item) => item.path === '/peer/v1/deliver').length, requests.slice(0, count).filter((item) => item.path === '/peer/v1/deliver').length);
  // Plan 8.1, 8.4: "not sent" only with proof; `unknown` when the member can have the message.
  const failure = (handedOff) => async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', handedOff }); };
  const answer = (status, body) => async () => ({ status, body });
  for (const [reply, reason] of [
    [async () => { throw new Error('timeout'); }, 'machine-offline'],
    [failure(false), 'machine-offline'],
    [failure(true), 'unknown'],
    [async () => { throw Object.assign(new Error('invalid-json'), { handedOff: true }); }, 'unknown'],
    ...[400, 401, 403, 410].map((status) => [answer(status, { error: 'x' }), 'refused']),
    ...[404, 413, 429, 500, 502].map((status) => [answer(status, { error: 'x' }), 'unknown']),
    [answer(200, { ok: true }), 'unknown'],
    [answer(200, null), 'unknown'],
    [answer(200, { ok: false, reason: 'unknown' }), 'unknown'],
    [answer(200, { ok: false, reason: 'too-large' }), 'too-large'],
    [answer(200, { ok: false, reason: 'rate-limited' }), 'rate-limited'],
    [answer(200, { ok: false, reason: 'target-unavailable' }), 'unknown'],
    [answer(200, { ok: false, reason: 'refused' }), 'unknown'],
    [answer(200, { ok: false, reason: 'machine-offline' }), 'unknown'],
  ]) {
    deliver = reply;
    assert.deepEqual(await send(), { status: 200, body: { ok: false, reason } });
  }
  deliver = answer(200, { ok: true, outcome: 'socket-written' });
  assert.deepEqual(await send(), ok);
  // A list older than 15 s, or a poller that says offline, is offline.
  deliver = async () => { throw new Error('must not be called'); };
  clock += 16_000;
  assert.deepEqual(f.supervisor.remotePeers(), { peers: [] });
  assert.deepEqual(await send(), { status: 200, body: { ok: false, reason: 'machine-offline' } });
  clock -= 16_000;
  f.group.states[0].online = false;
  assert.deepEqual(f.supervisor.remotePeers(), { peers: [] });
  assert.deepEqual(await send(), { status: 200, body: { ok: false, reason: 'machine-offline' } });
});

test('the loopback relay routes need the source token, local Host, and local Origin for send', async (t) => {
  const sent = [];
  const machineRelay = {
    homes: async (sources) => ({ machineId: A, machineName: 'alpha', homes: sources }),
    remotePeers: () => ({ peers: [] }),
    send: async (body) => { sent.push(body); return { status: 200, body: { ok: false, reason: 'machine-offline' } }; },
  };
  const server = createAsbServer({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), sourceToken: TOKEN,
    machineRelay, readSources: async () => ['source'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', token = TOKEN, origin, body, host } = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${base}${route}`, { method, headers: { ...(token ? { 'x-asb-source-token': token } : {}), ...(origin ? { origin } : {}),
      ...(host ? { host } : {}), 'content-type': 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, json: /json/.test(response.headers['content-type']) ? JSON.parse(Buffer.concat(chunks)) : null }));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const homes = await call('/api/relay/homes');
  assert.deepEqual([homes.status, homes.json, homes.headers['cache-control']], [200, { machineId: A, machineName: 'alpha', homes: ['source'] }, 'no-store']);
  assert.deepEqual((await call('/api/relay/remote-peers')).json, { peers: [] });
  for (const route of ['/api/relay/homes', '/api/relay/remote-peers']) {
    assert.equal((await call(route, { token: '' })).status, 403);
    assert.equal((await call(route, { token: 'e'.repeat(64) })).status, 403);
    assert.equal((await call(route, { host: `localhost:${server.address().port}` })).status, 403);
    assert.equal((await call(route, { method: 'POST', origin: base, body: {} })).status, 405);
  }
  const body = { text: 'x'.repeat(200_000) };
  assert.equal((await call('/api/relay/send', { method: 'POST', body })).status, 403);
  assert.equal((await call('/api/relay/send', { method: 'POST', body, origin: 'http://example.com' })).status, 403);
  assert.equal((await call('/api/relay/send', { method: 'POST', body, origin: base, token: '' })).status, 403);
  assert.equal((await call('/api/relay/send')).status, 405);
  assert.equal(sent.length, 0);
  const reply = await call('/api/relay/send', { method: 'POST', body, origin: base });
  assert.deepEqual([reply.status, reply.json, reply.headers['cache-control']], [200, { ok: false, reason: 'machine-offline' }, 'no-store']);
  assert.deepEqual(sent, [body]);
  assert.equal((await call('/api/relay/send', { method: 'POST', body: { text: 'x'.repeat(2 * 1024 * 1024) }, origin: base })).status, 413);
  // A server without the relay has no relay routes.
  const plain = createAsbServer({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), sourceToken: TOKEN });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { plain.closeAllConnections(); plain.close(resolve); }));
  assert.equal((await fetch(`http://127.0.0.1:${plain.address().port}/api/relay/homes`, { headers: { 'x-asb-source-token': TOKEN } })).status, 404);
});
