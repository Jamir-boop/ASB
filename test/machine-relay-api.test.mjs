import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createAsbServer } from '../src/asb-server.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { createRelaySupervisor, EXACT_REASONS, RELAY_STOPPED, relayHomes, validPeerList, validRelayBody, validRelayReply, writeOutbox } from '../src/machine-relay.mjs';
import { formatReference } from '../src/session-references.mjs';
import { notSentMessage } from '../src/session-targets.mjs';

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

// Exact member sends (v2): the sending side (sendExact) and the member side (peerResolveExact, peerDeliverExact).
const SCOPE_TAG = 'c'.repeat(32);
const target = () => ({ sourceId: 'codex', scopeTag: SCOPE_TAG, type: 'codex', appId: ID });
const identity = (machineId = B) => ({ reference: formatReference({ machineId, ...target() }), machineId, ...target() });
const exactSender = () => ({ sessionId: ID2, name: 'codex-task', mode: 'prompting', agent: 'codex' });
const exactMessage = () => ({ msgId: ID, text: 'hello', hopChain: ['1'.repeat(24)] });

test('every exact member reason has a not-sent message', () => {
  for (const reason of EXACT_REASONS) assert.match(notSentMessage(reason) ?? '', /^[^—]+\.$/, reason);
});

test('sendExact resolves first, then makes at most one deliver to the reference machine only, with honest outcomes', async (t) => {
  const requests = [];
  let resolve = async () => ({ status: 200, body: { api: 2, outcome: 'ready' }, address: '10.0.0.9' });
  let deliver = async (options) => ({ status: 200, body: { api: 2, msgId: options.body.message.msgId, outcome: 'submitted' }, address: '10.0.0.9' });
  const f = await supervisorFixture(t, { group: fakeGroup([B, 'c'.repeat(16)]), supervisor: { request: async (options) => {
    requests.push(options);
    return options.path === '/peer/v2/resolve-session' ? resolve(options) : deliver(options);
  } } });
  f.group.states[0].lastAddress = '10.0.0.2';
  f.group.states[1].online = false;
  // Each send has a new msgId: a msgId that already has an attempt is refused.
  let sentMessage;
  const send = (edit = {}) => f.supervisor.sendExact({ identity: identity(), sender: exactSender(),
    message: sentMessage = { ...exactMessage(), msgId: randomUUID() }, remainingMs: 10_000, ...edit });
  const notSent = (reason) => ({ outcome: 'not-sent', reason });

  assert.deepEqual(await send(), { outcome: 'submitted' });
  assert.equal(requests.length, 2);
  const [resolved, delivered] = requests;
  assert.deepEqual([resolved.path, resolved.method, resolved.timeoutMs, resolved.lastAddress, resolved.member.machineId, resolved.tls],
    ['/peer/v2/resolve-session', 'POST', 4_000, '10.0.0.2', B, { fingerprint: 'own' }]);
  assert.deepEqual(resolved.body, { api: 2, target: target() });
  // The deliver goes to the address that answered the resolve.
  assert.deepEqual([delivered.path, delivered.method, delivered.timeoutMs, delivered.lastAddress, delivered.member.machineId],
    ['/peer/v2/deliver', 'POST', 10_000, '10.0.0.9', B]);
  assert.deepEqual(delivered.body, { api: 2, target: target(), sender: { ...exactSender(), machineId: A }, message: sentMessage, remainingMs: 9_000 });
  requests.length = 0;
  assert.deepEqual(await send({ remainingMs: 5_000 }), { outcome: 'submitted' });
  assert.deepEqual([requests[1].timeoutMs, requests[1].body.remainingMs], [5_000, 4_000]);

  // No request for a machine that is not another member, or for an offline member.
  requests.length = 0;
  assert.deepEqual(await send({ identity: identity('f'.repeat(16)) }), notSent('unknown-machine'));
  assert.deepEqual(await send({ identity: identity(A) }), notSent('unknown-machine'));
  assert.deepEqual(await send({ identity: identity('c'.repeat(16)) }), notSent('machine-offline'));
  assert.deepEqual(requests, []);
  // A short budget or a body that fails the v2 check: the resolve only.
  for (const [edit, reason] of [[{ remainingMs: 1_000 }, 'binding-expired'], [{ remainingMs: 0 }, 'binding-expired'],
    [{ sender: { ...exactSender(), name: '' } }, 'invalid-request'], [{ message: { ...exactMessage(), text: '' } }, 'invalid-request']]) {
    requests.length = 0;
    assert.deepEqual(await send(edit), notSent(reason));
    assert.deepEqual(requests.map((item) => item.path), ['/peer/v2/resolve-session']);
  }

  const failure = (handedOff) => async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', handedOff }); };
  const answer = (status, body) => async () => ({ status, body, address: '10.0.0.9' });
  // The resolve: no text went out, so every result is not-sent.
  for (const [reply, reason] of [
    [async () => { throw new Error('no-address'); }, 'machine-offline'], [failure(false), 'machine-offline'],
    [answer(404, { error: 'x' }), 'peer-upgrade-required'],
    ...[400, 401, 403, 410, 429].map((status) => [answer(status, { error: 'x' }), 'refused']),
    [answer(200, { api: 2, outcome: 'unavailable', reason: 'not-live' }), 'not-live'],
    [answer(200, { api: 2, outcome: 'unavailable', reason: 'relay-unavailable' }), 'relay-unavailable'],
    [failure(true), 'capability-unknown'], [answer(500, { error: 'x' }), 'capability-unknown'], [answer(413, {}), 'capability-unknown'],
    [answer(200, { api: 2, outcome: 'ready', extra: 1 }), 'capability-unknown'], [answer(200, { api: 1, outcome: 'ready' }), 'capability-unknown'],
    [answer(200, { api: 2, outcome: 'unavailable', reason: 'weird' }), 'capability-unknown'], [answer(200, null), 'capability-unknown'],
  ]) {
    resolve = reply;
    requests.length = 0;
    assert.deepEqual(await send(), notSent(reason), reason);
    assert.deepEqual(requests.map((item) => item.path), ['/peer/v2/resolve-session']);
  }
  resolve = answer(200, { api: 2, outcome: 'ready' });
  // The deliver.
  const valid = (outcome, reason) => async (options) => ({ status: 200, address: '10.0.0.9',
    body: { api: 2, msgId: options.body.message.msgId, outcome, ...(reason ? { reason } : {}) } });
  for (const [reply, result] of [
    [failure(false), notSent('machine-offline')], [failure(true), { outcome: 'unknown' }],
    [async () => { throw Object.assign(new Error('invalid-json'), { handedOff: true }); }, { outcome: 'unknown' }],
    [answer(404, { error: 'x' }), notSent('peer-upgrade-required')],
    ...[400, 401, 403, 410, 429].map((status) => [answer(status, { error: 'x' }), notSent('refused')]),
    [answer(413, { error: 'x' }), notSent('too-large')],
    [valid('submitted'), { outcome: 'submitted' }], [valid('unknown'), { outcome: 'unknown' }],
    [valid('not-sent', 'target-changed'), notSent('target-changed')], [valid('not-sent', 'rate-limited'), notSent('rate-limited')],
    [valid('not-sent', 'weird'), { outcome: 'unknown' }], [valid('submitted', 'x'), { outcome: 'unknown' }],
    [answer(200, { api: 2, msgId: ID2, outcome: 'submitted' }), { outcome: 'unknown' }],
    [answer(200, { api: 2, outcome: 'submitted' }), { outcome: 'unknown' }],
    [answer(500, { error: 'x' }), { outcome: 'unknown' }], [answer(502, null), { outcome: 'unknown' }],
  ]) {
    deliver = reply;
    requests.length = 0;
    assert.deepEqual(await send(), result);
    assert.deepEqual(requests.map((item) => [item.path, item.member.machineId]), [['/peer/v2/resolve-session', B], ['/peer/v2/deliver', B]]);
  }
});

test('the member routes of an exact send bind first, clamp the deadline, and never answer 404', async (t) => {
  const caller = B + 'f'.repeat(48);
  const binds = [];
  let binder = async (request) => ({ apiVersion: 1, ok: true, pid: 1, binding: { registryHome: '/synthetic/sessions', runtimeSessionId: ID, pid: 5,
    procStart: '50', messagingSocketPath: '/synthetic/5.sock', msgId: request.msgId, expiresAtMs: clock + 10_000 } });
  let clock = 1_000_000;
  let clockStep = null;
  // The member list polls of a running relay get no answer: no network in this test.
  const options = { now: () => clockStep ? clockStep() : clock, bindTarget: async (request) => { binds.push(request); return binder(request); },
    request: async () => { throw new Error('offline'); } };
  const results = [];
  const check = async (promise, expected) => { const result = await promise; results.push(result); assert.deepEqual(result, expected); };
  const reference = formatReference({ machineId: A, ...target() });
  const deliverBody = () => ({ api: 2, target: target(), sender: { ...exactSender(), machineId: B }, message: exactMessage(), remainingMs: 9_000 });
  const ok = (outcome, reason) => ({ status: 200, body: { api: 2, msgId: ID, outcome, ...(reason ? { reason } : {}) } });
  const unavailable = (reason) => ({ status: 200, body: { api: 2, outcome: 'unavailable', reason } });
  const invalid = { status: 400, body: { error: 'Invalid relay request.' } };

  // No relay.
  const f = await supervisorFixture(t, { group: fakeGroup([]), supervisor: options });
  for (const body of [{ api: 2, target: target(), extra: 1 }, { api: 1, target: target() }, { api: 2, target: { ...target(), appId: 'x' } },
    { api: 2, target: { ...target(), type: 'claude-local' } }, { api: 2, target: { ...target(), sourceId: 7 } }, { api: 2 }, null]) {
    await check(f.supervisor.peerResolveExact(body, caller), invalid);
  }
  assert.deepEqual(binds, []);
  await check(f.supervisor.peerResolveExact({ api: 2, target: target() }, caller), unavailable('relay-unavailable'));
  assert.equal(binds[0].reference, reference);
  assert.match(binds[0].msgId, /^[0-9a-f-]{36}$/);
  assert.equal(binds[0].remainingMs, 0);
  binder = async () => ({ apiVersion: 1, ok: false, code: 'not-live', message: 'x' });
  await check(f.supervisor.peerResolveExact({ api: 2, target: target() }, caller), unavailable('not-live'));
  binder = async () => ({ apiVersion: 1, ok: false, code: 'caller-unregistered', message: 'x' });
  await check(f.supervisor.peerResolveExact({ api: 2, target: target() }, caller), unavailable('target-unavailable'));
  binder = async () => { throw new Error('boom'); };
  await check(f.supervisor.peerResolveExact({ api: 2, target: target() }, caller), unavailable('target-unavailable'));

  binds.length = 0;
  for (const edit of [(body) => { body.extra = 1; }, (body) => { body.remainingMs = 10_001; }, (body) => { body.remainingMs = 1.5; },
    (body) => { body.api = 1; }, (body) => { body.sender.name = 'a\nb'; }, (body) => { body.message.hopChain = 'x'; }, (body) => { body.target.appId = 'x'; }]) {
    const body = deliverBody();
    edit(body);
    await check(f.supervisor.peerDeliverExact(body, caller), invalid);
  }
  await check(f.supervisor.peerDeliverExact({ ...deliverBody(), sender: { ...exactSender(), machineId: A } }, caller),
    { status: 403, body: { error: 'The sender machine does not match.' } });
  assert.deepEqual(binds, []);
  await check(f.supervisor.peerDeliverExact(deliverBody(), caller), ok('not-sent', 'target-unavailable'));
  binder = async () => ({ apiVersion: 1, ok: false, code: 'target-changed', message: 'x' });
  await check(f.supervisor.peerDeliverExact(deliverBody(), caller), ok('not-sent', 'target-changed'));
  binder = async () => ({ apiVersion: 1, ok: false, code: 'scope-required', message: 'x' });
  await check(f.supervisor.peerDeliverExact(deliverBody(), caller), ok('not-sent', 'target-unavailable'));
  binder = async (request) => ({ apiVersion: 1, ok: true, pid: 1, binding: { registryHome: '/synthetic/sessions', runtimeSessionId: ID, pid: 5,
    procStart: '50', messagingSocketPath: '/synthetic/5.sock', msgId: request.msgId, expiresAtMs: clock + 10_000 } });
  await check(f.supervisor.peerDeliverExact(deliverBody(), caller), ok('not-sent', 'relay-unavailable'));
  // The member deadline is min(remainingMs - 500, 8 s); the binding must end 5.5 s before it.
  assert.deepEqual(binds.at(-1), { reference, msgId: ID, remainingMs: 8_000 });
  binds.length = 0;
  for (const remainingMs of [6_000, 500, 0]) await check(f.supervisor.peerDeliverExact({ ...deliverBody(), remainingMs }, caller), ok('not-sent', 'binding-expired'));

  // With a relay.
  const relay = await fakeRelay(t, { 'POST /deliver-bound': [200, { outcome: 'submitted' }] });
  const live = await supervisorFixture(t, { child: () => fakeChild({ line: relay.line }), supervisor: options });
  await live.supervisor.start();
  await check(live.supervisor.peerResolveExact({ api: 2, target: target() }, caller), { status: 200, body: { api: 2, outcome: 'ready' } });
  await check(live.supervisor.peerDeliverExact(deliverBody(), caller), ok('submitted'));
  const sent = relay.calls.at(-1);
  assert.deepEqual([sent.method, sent.url], ['POST', '/deliver-bound']);
  assert.deepEqual(sent.body, { binding: { registryHome: '/synthetic/sessions', runtimeSessionId: ID, pid: 5, procStart: '50',
    messagingSocketPath: '/synthetic/5.sock', msgId: ID, expiresAtMs: clock + 2_500 }, sender: { ...exactSender(), machineId: B }, message: exactMessage() });
  // A short remainingMs: the relay write must end before the member deadline.
  await check(live.supervisor.peerDeliverExact({ ...deliverBody(), remainingMs: 6_100 }, caller), ok('submitted'));
  assert.equal(relay.calls.at(-1).body.binding.expiresAtMs, clock + 100);
  binds.length = 0;
  const count = relay.calls.length;
  await check(live.supervisor.peerDeliverExact({ ...deliverBody(), remainingMs: 6_000 }, caller), ok('not-sent', 'binding-expired'));
  assert.equal(relay.calls.length, count);

  const replies = async (routes) => {
    const other = await fakeRelay(t, routes);
    const fixture = await supervisorFixture(t, { child: () => fakeChild({ line: other.line }), supervisor: options });
    await fixture.supervisor.start();
    return fixture.supervisor.peerDeliverExact(deliverBody(), caller);
  };
  // An older relay.js has no /deliver-bound route (404); 400 and 401 are its checks before any write.
  await check(replies({}), ok('not-sent', 'relay-unavailable'));
  await check(replies({ 'POST /deliver-bound': [400, { error: 'x' }] }), ok('not-sent', 'relay-unavailable'));
  await check(replies({ 'POST /deliver-bound': [401, { error: 'x' }] }), ok('not-sent', 'relay-unavailable'));
  await check(replies({ 'POST /deliver-bound': [500, { error: 'x' }] }), ok('unknown'));
  await check(replies({ 'POST /deliver-bound': [200, { outcome: 'not-sent', reason: 'target-changed' }] }), ok('not-sent', 'target-changed'));
  await check(replies({ 'POST /deliver-bound': [200, { outcome: 'unknown' }] }), ok('unknown'));
  for (const body of [{ outcome: 'not-sent', reason: 'weird' }, { outcome: 'submitted', extra: 1 }, { ok: true }, null]) {
    await check(replies({ 'POST /deliver-bound': [200, body] }), ok('unknown'));
  }

  // A relay that does not answer: unknown when the member deadline ends. The clock jumps forward after the binding check,
  // so the relay call has 100 ms left.
  const hang = http.createServer(() => {});
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { hang.closeAllConnections(); hang.close(resolve); }));
  const slow = await supervisorFixture(t, { supervisor: options,
    child: () => fakeChild({ line: JSON.stringify({ port: hang.address().port, token: 'e'.repeat(64) }) }) });
  await slow.supervisor.start();
  let reads = 0;
  clockStep = () => clock + (++reads >= 4 ? 7_900 : 0);
  const started = Date.now();
  await check(slow.supervisor.peerDeliverExact(deliverBody(), caller), ok('unknown'));
  clockStep = null;
  assert.ok(Date.now() - started < 2_000);
  for (const result of results) assert.notEqual(result.status, 404);
});

// Exact member receipts: the sending engine keeps its attempts; the target member sends the control variant of /peer/v2/deliver.
const RETURN_TO = { runtimeSessionId: ID2, pid: 4242, procStart: '4242000', messagingSocketPath: '/synthetic/run/4242.sock' };
const receiptControl = (orig, fields = {}) => ({ api: 2, control: { action: 'peer_message_status', orig_msg_id: orig, status: 'delivered', ...fields } });

async function receiptFixture(t, { deliver } = {}) {
  const clock = { now: 1_000_000 };
  const requests = [];
  const writes = [];
  let write = async () => 1;
  const f = await supervisorFixture(t, { group: fakeGroup([B, 'c'.repeat(16)]), supervisor: { now: () => clock.now,
    outbox: async (...args) => { writes.push(args); return write(...args); },
    request: async (options) => {
      requests.push(options);
      if (options.path === '/peer/v2/resolve-session') return { status: 200, body: { api: 2, outcome: 'ready' }, address: '10.0.0.9' };
      return (deliver ?? (async () => ({ status: 200, body: { api: 2, msgId: options.body.message.msgId, outcome: 'submitted' } })))(options);
    } } });
  const send = (msgId, { reference = identity().reference, returnTo = RETURN_TO } = {}) => f.supervisor.sendExact({ identity: { ...identity(), reference },
    sender: exactSender(), message: { ...exactMessage(), msgId }, remainingMs: 10_000, returnTo });
  return { ...f, clock, requests, writes, send, setWrite(value) { write = value; } };
}

test('sendExact saves its attempt before the deliver, deletes it on not-sent, and refuses a repeated msgId with no request', async (t) => {
  const caller = B + 'f'.repeat(48);
  let during = null;
  let deliver = async (options) => ({ status: 200, body: { api: 2, msgId: options.body.message.msgId, outcome: 'submitted' } });
  const f = await receiptFixture(t, { deliver: async (options) => {
    // The receipt can come before the reply of the deliver.
    during = await f.supervisor.peerDeliverExact(receiptControl(options.body.message.msgId), caller);
    return deliver(options);
  } });
  const first = randomUUID();
  assert.deepEqual(await f.send(first), { outcome: 'submitted' });
  assert.deepEqual(during.body, { api: 2, msgId: first, outcome: 'submitted' });
  assert.equal(f.writes.length, 1);
  f.requests.length = 0;
  assert.deepEqual(await f.send(first), { outcome: 'not-sent', reason: 'invalid-request' });
  assert.deepEqual(f.requests, []);
  // An unknown outcome keeps the attempt; a not-sent result deletes it, so its receipt and a new send of the msgId are as new.
  deliver = async () => ({ status: 500, body: { error: 'x' } });
  const unknown = randomUUID();
  assert.deepEqual(await f.send(unknown), { outcome: 'unknown' });
  assert.deepEqual(await f.send(unknown), { outcome: 'not-sent', reason: 'invalid-request' });
  deliver = async () => ({ status: 403, body: { error: 'x' } });
  const refused = randomUUID();
  assert.deepEqual(await f.send(refused), { outcome: 'not-sent', reason: 'refused' });
  f.writes.length = 0;
  assert.deepEqual((await f.supervisor.peerDeliverExact(receiptControl(refused), caller)).body, { api: 2, msgId: refused, outcome: 'not-sent', reason: 'binding-expired' });
  assert.deepEqual(f.writes, []);
  f.requests.length = 0;
  assert.deepEqual(await f.send(refused), { outcome: 'not-sent', reason: 'refused' });
  assert.deepEqual(f.requests.map((item) => item.path), ['/peer/v2/resolve-session', '/peer/v2/deliver']);
  // An attempt lives 30 minutes.
  deliver = async (options) => ({ status: 200, body: { api: 2, msgId: options.body.message.msgId, outcome: 'submitted' } });
  f.clock.now += 30 * 60_000;
  assert.deepEqual(await f.send(first), { outcome: 'submitted' });
  // At most 1024 attempts: the oldest goes out first.
  const ids = Array.from({ length: 1024 }, () => randomUUID());
  for (const id of ids) await f.send(id);
  f.writes.length = 0;
  assert.equal((await f.supervisor.peerDeliverExact(receiptControl(first), caller)).body.outcome, 'not-sent');
  assert.equal((await f.supervisor.peerDeliverExact(receiptControl(ids[0]), caller)).body.outcome, 'submitted');
  assert.equal(f.writes.length, 1);
});

test('peerReceipt checks the shape, then the attempt, the caller, the time, and the count, and writes once to the outbox', async (t) => {
  const caller = B + 'f'.repeat(48);
  const f = await receiptFixture(t);
  const [one, two, otherReference, otherReturn] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await f.send(one);
  await f.send(two);
  await f.send(otherReference, { reference: formatReference({ machineId: B, ...target(), appId: ID2 }) });
  await f.send(otherReturn, { returnTo: { ...RETURN_TO, pid: 4243 } });
  const receipt = (value) => f.supervisor.peerDeliverExact(value, caller);
  const invalid = { status: 400, body: { error: 'Invalid relay request.' } };
  for (const edit of [(value) => { value.api = 1; }, (value) => { value.control.action = 'notify_when_idle'; }, (value) => { value.control.status = 'busy'; },
    (value) => { value.control.orig_msg_id = 'x'; }, (value) => { value.control.text = 'hello'; }, (value) => { value.control.reason = 'r'.repeat(1001); },
    (value) => { value.control.dropped_msg_ids = ['x']; }, (value) => { value.control = null; }, (value) => { value.target = target(); },
    (value) => { value.message = exactMessage(); }, (value) => { value.remainingMs = 1000; }, (value) => { value.session_id = ID; }]) {
    const value = receiptControl(one);
    edit(value);
    assert.deepEqual(await receipt(value), invalid, edit.toString());
  }
  assert.deepEqual(f.writes, []);
  const expired = (orig) => ({ status: 200, body: { api: 2, msgId: orig, outcome: 'not-sent', reason: 'binding-expired' } });
  // The same reply for an unknown ID, another caller, and another member: no write.
  assert.deepEqual(await receipt(receiptControl(randomUUID())).then((reply) => reply.body.reason), 'binding-expired');
  assert.deepEqual(await f.supervisor.peerDeliverExact(receiptControl(one), 'c'.repeat(16) + 'f'.repeat(48)), expired(one));
  assert.deepEqual(await f.supervisor.peerDeliverExact(receiptControl(one), B + 'e'.repeat(48)), expired(one));
  assert.deepEqual(f.writes, []);

  // One valid write: the status fields, the reference, and the receiver of the sending task; never text.
  const fields = { status: 'expired', status_detail: 'refused', reason: 'Refused by the inbox policy.' };
  assert.deepEqual(await receipt(receiptControl(one, fields)), { status: 200, body: { api: 2, msgId: one, outcome: 'submitted' } });
  assert.deepEqual(f.writes, [[RETURN_TO.messagingSocketPath, { exactReceipt: { runtimeSessionId: ID2, pid: 4242, procStart: '4242000',
    reference: identity().reference, msgIds: [one], ...fields } }, 2_000]]);
  // dropped_msg_ids: only live attempts with the same reference and the same receiver; never for another status.
  f.writes.length = 0;
  await receipt(receiptControl(two, { status: 'dropped', drop_reason: 'queue-full', dropped_msg_ids: [two, one, otherReference, otherReturn, randomUUID()] }));
  assert.deepEqual(f.writes[0][1].exactReceipt.msgIds, [two, one]);
  assert.equal(f.writes[0][1].exactReceipt.drop_reason, 'queue-full');
  f.writes.length = 0;
  await receipt(receiptControl(two, { dropped_msg_ids: [one] }));
  assert.deepEqual(f.writes[0][1].exactReceipt.msgIds, [two]);
  // At most 4 controls for one attempt (a use as a dropped ID does not count): the fifth writes nothing.
  f.writes.length = 0;
  for (const _ of [3, 4]) assert.equal((await receipt(receiptControl(two))).body.outcome, 'submitted');
  assert.equal(f.writes.length, 2);
  assert.deepEqual(await receipt(receiptControl(two)), expired(two));
  assert.equal(f.writes.length, 2);
  // The outbox write: a failure before the connect is not-sent; after the write, unknown.
  f.setWrite(async () => { throw Object.assign(new Error('refused'), { unsent: true }); });
  assert.deepEqual((await receipt(receiptControl(otherReference))).body, { api: 2, msgId: otherReference, outcome: 'not-sent', reason: 'target-unavailable' });
  f.setWrite(async () => { throw new Error('closed'); });
  assert.deepEqual((await receipt(receiptControl(otherReference))).body, { api: 2, msgId: otherReference, outcome: 'unknown' });
  // After 30 minutes the attempt is gone.
  f.setWrite(async () => 1);
  f.writes.length = 0;
  f.clock.now += 30 * 60_000;
  assert.deepEqual(await receipt(receiptControl(otherReturn)), expired(otherReturn));
  assert.deepEqual(f.writes, []);
});

test('sendReceipt makes one control POST to the sending member only, and none for an offline or unknown member', async (t) => {
  const requests = [];
  let reply = async () => ({ status: 200, body: { api: 2, msgId: ID, outcome: 'submitted' } });
  const f = await supervisorFixture(t, { group: fakeGroup([B, 'c'.repeat(16)]), supervisor: { request: async (options) => { requests.push(options); return reply(); } } });
  f.group.states[0].lastAddress = '10.0.0.2';
  f.group.states[1].online = false;
  const control = { action: 'peer_message_status', orig_msg_id: ID, status: 'dropped', drop_reason: 'queue-full', dropped_msg_ids: [ID] };
  assert.deepEqual(await f.supervisor.sendReceipt({ machineId: B, control }), { status: 200, body: { sent: true } });
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].path, requests[0].method, requests[0].timeoutMs, requests[0].lastAddress, requests[0].member.machineId, requests[0].body],
    ['/peer/v2/deliver', 'POST', 4_000, '10.0.0.2', B, { api: 2, control }]);
  requests.length = 0;
  for (const machineId of ['c'.repeat(16), 'f'.repeat(16), A]) {
    assert.deepEqual(await f.supervisor.sendReceipt({ machineId, control }), { status: 200, body: { sent: false } });
  }
  for (const body of [{ machineId: B }, { machineId: B, control, extra: 1 }, { machineId: 'B'.repeat(16), control }, { machineId: B, control: { ...control, text: 'x' } },
    { machineId: B, control: { ...control, status: 'busy' } }, null]) {
    assert.deepEqual(await f.supervisor.sendReceipt(body), { status: 400, body: { error: 'Invalid relay request.' } });
  }
  assert.deepEqual(requests, []);
  reply = async () => { throw Object.assign(new Error('timeout'), { handedOff: true }); };
  assert.deepEqual((await f.supervisor.sendReceipt({ machineId: B, control })).body, { sent: true });
  reply = async () => { throw new Error('no-address'); };
  assert.deepEqual((await f.supervisor.sendReceipt({ machineId: B, control })).body, { sent: false });
  assert.equal(requests.length, 2);
});

test('writeOutbox writes one line to the private outbox next to the inbox and reads one { applied } line', async (t) => {
  const dir = await temporary(t);
  const run = path.join(dir, 'run');
  await mkdir(run, { mode: 0o700 });
  const inbox = path.join(run, '77.sock');
  const lines = [];
  let answer = (socket) => socket.end('{"applied":2}\n');
  const server = net.createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) { lines.push(JSON.parse(text.split('\n')[0])); answer(socket); }
    });
  });
  await new Promise((resolve) => server.listen(path.join(run, '77.out'), resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  await chmod(path.join(run, '77.out'), 0o600);
  const request = { exactReceipt: { msgIds: [ID] } };
  assert.equal(await writeOutbox(inbox, request), 2);
  assert.deepEqual(lines, [request]);

  // Refused before any connect: the path rules and the mode rules.
  const unsent = async (promise) => assert.equal((await promise.then(() => null, (error) => error)).unsent, true);
  await writeFile(path.join(run, 'file.out'), '');
  await chmod(path.join(run, 'file.out'), 0o600);
  for (const bad of ['relative/77.sock', path.join(run, '77.out'), path.join(run, '77'), `${run}/../run/77.sock`, path.join(run, 'none.sock'),
    path.join(run, 'file.sock'), 7, undefined]) await unsent(writeOutbox(bad, request));
  await chmod(path.join(run, '77.out'), 0o660);
  await unsent(writeOutbox(inbox, request));
  await chmod(path.join(run, '77.out'), 0o600);
  await chmod(run, 0o755);
  await unsent(writeOutbox(inbox, request));
  await chmod(run, 0o700);
  // A stale socket file with no listener: the connect fails, so nothing was written.
  const stale = net.createServer();
  await new Promise((resolve) => stale.listen(path.join(run, '78.tmp'), resolve));
  await rename(path.join(run, '78.tmp'), path.join(run, '78.out'));
  await chmod(path.join(run, '78.out'), 0o600);
  await new Promise((resolve) => stale.close(resolve));
  assert.equal((await lstat(path.join(run, '78.out'))).isSocket(), true);
  await unsent(writeOutbox(path.join(run, '78.sock'), request));
  assert.equal(lines.length, 1);

  // After the write: a close, an invalid reply, or no reply in time is not `unsent`.
  const unknown = async (promise) => { const error = await promise.then(() => null, (value) => value); assert.ok(error); assert.notEqual(error.unsent, true); };
  answer = (socket) => socket.end();
  await unknown(writeOutbox(inbox, request));
  for (const reply of ['{"applied":-1}\n', '{"applied":1,"extra":1}\n', '{"error":"x"}\n', 'nope\n', `${'x'.repeat(70 * 1024)}`]) {
    answer = (socket) => socket.end(reply);
    await unknown(writeOutbox(inbox, request));
  }
  answer = () => {};
  const started = Date.now();
  await unknown(writeOutbox(inbox, request, 100));
  assert.ok(Date.now() - started < 1_000);
  assert.equal(lines.length, 8);
});

test('the loopback receipt route needs the source token, local Host, and local Origin, and exists only with sendReceipt', async (t) => {
  const requests = [];
  const f = await supervisorFixture(t, { supervisor: { request: async (options) => { requests.push(options); return { status: 200, body: {} }; } } });
  const machineRelay = { homes: async () => ({}), remotePeers: () => ({ peers: [] }), send: async () => ({ status: 200, body: {} }),
    sendReceipt: (body) => f.supervisor.sendReceipt(body) };
  const serve = async (relay) => {
    const server = createAsbServer({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), sourceToken: TOKEN, machineRelay: relay });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await serve(machineRelay);
  const call = (url, { method = 'POST', token = TOKEN, origin = new URL(url).origin, host, body } = {}) => new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { ...(token ? { 'x-asb-source-token': token } : {}), ...(origin ? { origin } : {}),
      ...(host ? { host } : {}), 'content-type': 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const route = `${base}/api/relay/receipt`;
  const body = { machineId: B, control: { action: 'peer_message_status', orig_msg_id: ID, status: 'delivered' } };
  for (const options of [{ token: '' }, { token: 'e'.repeat(64) }, { origin: '' }, { origin: 'http://example.com' }, { host: `localhost:${new URL(base).port}` }]) {
    assert.equal((await call(route, { body, ...options })).status, 403, JSON.stringify(options));
  }
  assert.equal((await call(route, { method: 'GET', origin: '' })).status, 405);
  for (const invalid of [{}, { ...body, extra: 1 }, { machineId: B, control: { ...body.control, text: 'x' } }, '{', null]) {
    assert.equal((await call(route, { body: invalid })).status, 400);
  }
  assert.equal((await call(route, { body: { ...body, control: { ...body.control, reason: 'x'.repeat(70 * 1024) } } })).status, 413);
  assert.deepEqual(requests, []);
  const reply = await call(route, { body });
  assert.deepEqual([reply.status, JSON.parse(reply.text), reply.headers['cache-control']], [200, { sent: true }, 'no-store']);
  assert.deepEqual(requests.map((item) => [item.path, item.body]), [['/peer/v2/deliver', { api: 2, control: body.control }]]);
  const { sendReceipt, ...older } = machineRelay;
  assert.equal(typeof sendReceipt, 'function');
  assert.equal((await call(`${await serve(older)}/api/relay/receipt`, { body })).status, 404);
});
