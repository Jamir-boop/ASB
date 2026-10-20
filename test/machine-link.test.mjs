import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestInstance } from '../scripts/asb-instance.mjs';
import { createMachineGroup, groupPath } from '../src/machine-group.mjs';
import { peerRequest } from '../src/machine-peers.mjs';
import { createRelaySupervisor } from '../src/machine-relay.mjs';
import { createPhoneGateway, phoneSettingsPath, phoneTlsDir } from '../src/phone-gateway.mjs';
import { buildSwitchboardDashboard, createSwitchboardServer } from '../src/switchboard.mjs';

let hasOpenSsl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenSsl = false; }
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = (n) => `local_${uuid(n)}`;

async function waitFor(check, what) {
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await delay(10)) if (await check()) return;
  assert.fail(`Timed out waiting for ${what}.`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The pollers run on these timers; a test fires the sessions poll and waits until the poller schedules the next one.
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (run, ms) => { const handle = { run, ms, unref() {} }; pending.push(handle); return handle; },
    clearTimeout: (handle) => { const index = pending.indexOf(handle); if (index >= 0) pending.splice(index, 1); },
    async fireSessions() {
      const handle = pending.findLast((item) => [2000, 5000, 10_000].includes(item.ms));
      assert.ok(handle, `no sessions timer in ${pending.map((item) => item.ms)}`);
      pending.splice(pending.indexOf(handle), 1);
      const count = pending.length;
      handle.run();
      await waitFor(() => pending.length > count, 'the next sessions poll');
    },
  };
}

async function engine(t, name, address, clock, peer = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), `asb-link-${name}-`));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') };
  const timers = fakeTimers();
  const sounds = [];
  const logs = [];
  const fixture = { threads: [] };
  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  let server;
  let machineId = '';
  const group = createMachineGroup({ file: groupPath(env), gateway: () => gateway, server: () => server, asbVersion: 'test', now: () => clock.now,
    addressOk: () => true, hostName: name, timers, log: (line) => logs.push(line),
    onChange: () => server.invalidateDashboard('peer-sessions', { hard: false }) });
  const gateway = createPhoneGateway({ localPort: port, asbVersion: 'test', settingsPath: phoneSettingsPath(env), tlsDir: phoneTlsDir(env),
    listAddresses: () => [{ address, interface: 'lo', kind: 'lan' }], peer: { ...group.peer, ...peer },
    onPhonePaired: group.onPhonePaired, onPhoneRevoked: group.onPhoneRevoked });
  server = createSwitchboardServer({ sourceToken: token, phoneGateway: gateway, machineGroup: group, serviceMode: true,
    playSound: (kind) => sounds.push(kind), pendingStatePath: path.join(home, 'pending.json'), palettePath: false,
    machineIdentity: () => ({ machineId, machineName: group.selfName() }),
    loadDashboard: async ({ machine }) => buildSwitchboardDashboard(fixture.threads, [], clock.now, machine) });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  await gateway.start();
  const gatewayPort = await freePort();
  assert.equal((await gateway.updateSettings({ enabled: true, bindAddresses: [address], port: gatewayPort })).running, true);
  machineId = await gateway.identity();
  await group.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await group.stop();
    await gateway.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(stop);
  const api = async (route, options = {}) => {
    const reply = await requestInstance({ port, sourceToken: token }, route, { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, ...options });
    return { status: reply.statusCode, body: reply.body };
  };
  return { name, home, env, port, gatewayPort, server, gateway, group, timers, sounds, logs, fixture, stop, api, machineId };
}

const working = (n, nowMs, extra = {}) => ({ id: `claude-desktop-code:${local(n)}`, externalId: local(n), provider: 'claude-desktop-code',
  source: 'claude-desktop-code', title: `Task ${n}`, cwd: `/work/${n}`, updatedAtMs: nowMs - 1000, lifecycleRunning: true,
  agentStartedAtMs: nowMs - 5000, agentActivityAtMs: nowMs - 1000, latestLifecycleAtMs: nowMs - 1000, ...extra });
const done = (n, nowMs, extra = {}) => ({ ...working(n, nowMs, extra), lifecycleRunning: false, latestLifecycleKind: 'task_complete',
  latestLifecycleAtMs: nowMs - 500, latestTaskEndedAtMs: nowMs - 500, latestAgentFinalAtMs: nowMs - 500, updatedAtMs: nowMs - 500 });

test('two engines join one group and show each other\'s sessions as remote cards', { skip: hasOpenSsl ? false : 'openssl is not on PATH.' }, async (t) => {
  const clock = { now: Date.now() };
  const a = await engine(t, 'engine-a', '127.0.0.2', clock);
  const b = await engine(t, 'engine-b', '127.0.0.3', clock);
  a.fixture.threads = [{ id: `claude-desktop-code:${local(1)}`, externalId: local(1), provider: 'claude-desktop-code', source: 'claude-desktop-code',
    title: 'A task', cwd: '/work/a', updatedAtMs: clock.now - 1000, cliSessionId: uuid(901),
    incomingMessages: [{ from: uuid(950), atMs: clock.now - 10_000 }] }];
  b.fixture.threads = [working(5, clock.now, { cliSessionId: uuid(950) })];

  // Not in a group yet; invite and join through the loopback API.
  const empty = await a.api('/api/group');
  assert.deepEqual(empty.body, { groupId: '', self: { machineId: a.machineId, name: 'engine-a' }, networkEnabled: true, members: [], phones: [] });
  assert.equal((await a.api('/api/group/invite', { method: 'POST', body: { extra: 1 } })).status, 400);
  const invite = await a.api('/api/group/invite', { method: 'POST', body: {} });
  assert.equal(invite.status, 200);
  assert.deepEqual(Object.keys(invite.body).sort(), ['expiresAtMs', 'fingerprint', 'link']);
  assert.equal(invite.body.fingerprint.slice(0, 16), a.machineId);
  assert.equal((await b.api('/api/group/join', { method: 'POST', body: { link: 'asb://join?v=1', name: '' } })).status, 400);
  const joined = await b.api('/api/group/join', { method: 'POST', body: { link: invite.body.link, name: 'engine-b' } });
  assert.deepEqual(joined, { status: 200, body: { joined: true, groupId: (await a.api('/api/group')).body.groupId } });
  assert.equal(((await stat(groupPath(b.env))).mode & 0o777), 0o600);
  const again = await b.api('/api/group/join', { method: 'POST', body: { link: invite.body.link, name: 'engine-b' } });
  assert.deepEqual(again, { status: 409, body: { error: 'Leave the current group first.' } });

  // A polls B until B answers as a member.
  await waitFor(() => a.timers.pending.some((item) => [2000, 5000].includes(item.ms)), 'the first poll of B');
  for (let round = 0; round < 3 && !a.group.peerStates()[0].online; round += 1) await a.timers.fireSessions();
  const status = (await a.api('/api/group')).body;
  assert.deepEqual(status.members.map((item) => [item.name, item.online, item.isSelf]), [['engine-a', true, true], ['engine-b', true, false]]);
  assert.deepEqual(status.members[1].addresses, [{ kind: 'lan', address: '127.0.0.3' }]);

  // Board open, so sounds play; the first dashboard is the sound baseline.
  assert.equal((await a.api('/api/agent/ui', { method: 'POST', body: { clientId: '11111111-1111-4111-8111-111111111111', dirty: false,
    profilesRevision: null, profilesVisible: false, sourcesRevision: null } })).status, 200);
  const dashboard = (await a.api('/api/dashboard?force=1')).body;
  const remoteId = `m:${b.machineId}:claude-desktop-code:${local(5)}`;
  const remote = dashboard.threads.find((row) => row.id === remoteId);
  assert.deepEqual([remote.remote, remote.machineName, remote.machineId, remote.canOpen, remote.appDeepLink, remote.state, remote.globalId],
    [true, 'engine-b', b.machineId, false, '', 'working', `${b.machineId}:claude-desktop-code:${local(5)}`]);
  assert.equal(dashboard.threads.find((row) => !row.remote).machineName, 'engine-a');
  assert.deepEqual(dashboard.messages, [{ from: remoteId, to: `claude-desktop-code:${local(1)}`, atMs: clock.now - 10_000 }]);
  assert.equal(dashboard.refreshIntervalMs, 2000);

  // Read and Pin change only A's pending.json; open and discard are refused.
  const encoded = encodeURIComponent(remoteId);
  const pendingB = await readFile(path.join(b.home, 'pending.json'), 'utf8');
  assert.equal((await a.api(`/api/threads/${encoded}/mark-read`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await a.api(`/api/threads/${encoded}/pin`, { method: 'POST', body: {} })).status, 200);
  const pending = JSON.parse(await readFile(path.join(a.home, 'pending.json'), 'utf8'));
  assert.ok(JSON.stringify(pending).includes(remoteId));
  assert.equal(await readFile(path.join(b.home, 'pending.json'), 'utf8'), pendingB);
  assert.equal(pendingB.includes('m:'), false);
  const opened = await a.api(`/api/threads/${encoded}/open`, { method: 'POST', body: {} });
  assert.deepEqual(opened, { status: 500, body: { error: 'Failed to open thread', detail: 'This session cannot open from ASB.' } });
  assert.deepEqual(await a.api(`/api/threads/${encoded}/discard-result`, { method: 'POST', body: {} }),
    { status: 400, body: { error: 'Discard does not work on a session on another machine.' } });

  // B finishes its task: A gets the new rows and plays the Done sound.
  b.fixture.threads = [done(5, clock.now, { cliSessionId: uuid(950) })];
  b.server.invalidateDashboard('test');
  assert.deepEqual(a.sounds, []);
  await a.timers.fireSessions();
  const finished = (await a.api('/api/dashboard?force=1')).body.threads.find((row) => row.id === remoteId);
  assert.deepEqual([finished.state, finished.completionAttention], ['idle', true]);
  assert.deepEqual(a.sounds, [1]);

  // The gateway does not serve the loopback group or engine routes.
  const credentials = await a.gateway.credentials();
  const member = { machineId: b.machineId, certFingerprint: (await b.gateway.credentials()).fingerprint,
    addresses: [{ kind: 'lan', address: '127.0.0.3' }], port: b.gatewayPort };
  for (const route of ['/api/group', '/api/group/invite', '/api/group/join', '/api/engine/stop', '/api/agent/status', '/api/agent/resolve-session', '/api/agent/resolve-bound',
    '/api/agent/send-member']) {
    for (const method of ['GET', 'POST']) {
      const reply = await peerRequest({ member, path: route, method, ...(method === 'POST' ? { body: {} } : {}), tls: credentials });
      assert.equal(reply.status, 404, `${method} ${route}`);
    }
  }

  // B stops answering: after 3 failed polls its rows are Unknown with the note, and they leave after 10 minutes.
  await b.gateway.stop();
  for (let round = 0; round < 3; round += 1) await a.timers.fireSessions();
  assert.equal(a.group.peerStates()[0].online, false);
  const offline = (await a.api('/api/dashboard?force=1')).body.threads.find((row) => row.id === remoteId);
  assert.deepEqual([offline.state, offline.reason], ['unknown', 'engine-b is not reachable.']);
  assert.equal((await a.api('/api/group')).body.members[1].online, false);
  clock.now += 600_000;
  assert.equal((await a.api('/api/dashboard?force=1')).body.threads.some((row) => row.remote), false);

  // B leaves: A gets the leave and drops B; B deletes group.json and keeps its certificate.
  assert.deepEqual(await b.api('/api/group/leave', { method: 'POST', body: {} }), { status: 200, body: { left: true } });
  await assert.rejects(stat(groupPath(b.env)), { code: 'ENOENT' });
  assert.equal((await b.api('/api/group')).body.groupId, '');
  assert.equal((await b.gateway.identity()), b.machineId);
  assert.deepEqual((await a.api('/api/group')).body.members.map((item) => item.name), ['engine-a']);
  assert.deepEqual(a.group.peerStates(), []);

  // A third machine joins and A removes it; A cannot remove itself.
  const c = await engine(t, 'engine-c', '127.0.0.4', clock);
  const link = (await a.api('/api/group/invite', { method: 'POST', body: {} })).body.link;
  assert.deepEqual(await c.api('/api/group/join', { method: 'POST', body: { link, name: 'Engine-A' } }),
    { status: 409, body: { error: 'Another machine in the group has this name.', suggestion: 'Engine-A-2' } });
  assert.equal((await c.api('/api/group/join', { method: 'POST', body: { link, name: '' } })).status, 200);
  await waitFor(() => c.timers.pending.some((item) => [2000, 5000, 10_000].includes(item.ms)), 'the first poll of A by C');
  assert.deepEqual((await a.api('/api/group')).body.members.map((item) => item.name), ['engine-a', 'engine-c']);
  assert.deepEqual(await a.api('/api/group/remove', { method: 'POST', body: { machineId: a.machineId } }),
    { status: 409, body: { error: 'Use asb group leave to leave the group.' } });
  const removed = await a.api('/api/group/remove', { method: 'POST', body: { machineId: c.machineId } });
  assert.deepEqual([removed.status, removed.body.members.map((item) => item.name)], [200, ['engine-a']]);
  assert.deepEqual(a.group.peerStates(), []);
  const group = JSON.parse(await readFile(groupPath(a.env), 'utf8'));
  assert.deepEqual(group.removed.map((item) => item.machineId).sort(), [b.machineId, c.machineId].sort());
  // In this group of two, the removed machine learns it at its next poll (410) and leaves.
  assert.equal((await stat(groupPath(c.env))).isFile(), true);
  const poll = c.timers.pending.findLast((item) => [2000, 5000, 10_000].includes(item.ms));
  c.timers.pending.splice(c.timers.pending.indexOf(poll), 1);
  poll.run();
  await waitFor(() => c.logs.length > 0, 'the removal on engine C');
  await assert.rejects(stat(groupPath(c.env)), { code: 'ENOENT' });
  assert.equal((await c.api('/api/group')).body.groupId, '');
  assert.deepEqual(c.timers.pending, []);
  assert.deepEqual([...a.logs, ...b.logs], []);
  assert.deepEqual(c.logs, ['ASB: this machine was removed from the machine group.']);
});

// Exact member sends over real mutual TLS: the sender's resolve, then one deliver, with the v2 functions of the member.
test('an exact member send asks an old member once with no text, and a new member gets one resolve and one deliver', { skip: hasOpenSsl ? false : 'openssl is not on PATH.' }, async (t) => {
  const clock = { now: Date.now() };
  const calls = [];
  const a = await engine(t, 'engine-a', '127.0.0.5', clock);
  const b = await engine(t, 'engine-b', '127.0.0.6', clock, {
    resolveExact: async (value, fingerprint) => { calls.push(['resolve', value, fingerprint]); return { status: 200, body: { api: 2, outcome: 'ready' } }; },
    deliverExact: async (value, fingerprint) => { calls.push(['deliver', value, fingerprint]);
      return { status: 200, body: { api: 2, msgId: value.message.msgId, outcome: 'submitted' } }; } });
  const old = await engine(t, 'engine-old', '127.0.0.7', clock);
  for (const member of [b, old]) {
    const invite = await a.api('/api/group/invite', { method: 'POST', body: {} });
    assert.equal((await member.api('/api/group/join', { method: 'POST', body: { link: invite.body.link, name: member.name } })).status, 200);
  }
  // Two pollers: each check fires the sessions timers that are due, until both members answer.
  await waitFor(() => {
    for (const handle of a.timers.pending.filter((item) => [2000, 5000, 10_000].includes(item.ms))) {
      a.timers.pending.splice(a.timers.pending.indexOf(handle), 1);
      handle.run();
    }
    return a.group.peerStates().length === 2 && a.group.peerStates().every((state) => state.online);
  }, 'both members online');
  const sent = [];
  const relay = createRelaySupervisor({ group: a.group, port: a.port, sourceToken: 'x', request: (options) => { sent.push(options); return peerRequest(options); } });
  const target = { sourceId: 'codex', scopeTag: 'c'.repeat(32), type: 'codex', appId: uuid(7) };
  const send = (machineId) => relay.sendExact({ identity: { reference: '', machineId, ...target },
    sender: { sessionId: uuid(8), name: 'codex-task', mode: 'prompting', agent: 'codex' }, message: { msgId: uuid(9), text: 'secret text', hopChain: [] },
    remainingMs: 10_000 });

  assert.deepEqual(await send(old.machineId), { outcome: 'not-sent', reason: 'peer-upgrade-required' });
  assert.deepEqual(sent.map((item) => [item.path, item.member.machineId]), [['/peer/v2/resolve-session', old.machineId]]);
  assert.equal(JSON.stringify(sent[0].body).includes('secret text'), false);
  sent.length = 0;
  assert.deepEqual(await send(b.machineId), { outcome: 'submitted' });
  assert.deepEqual(sent.map((item) => item.path), ['/peer/v2/resolve-session', '/peer/v2/deliver']);
  const fingerprint = (await a.gateway.credentials()).fingerprint;
  assert.deepEqual(calls.map(([route, , caller]) => [route, caller]), [['resolve', fingerprint], ['deliver', fingerprint]]);
  assert.deepEqual(calls[0][1], { api: 2, target });
  assert.deepEqual(calls[1][1], { api: 2, target, sender: { machineId: a.machineId, sessionId: uuid(8), name: 'codex-task', mode: 'prompting', agent: 'codex' },
    message: { msgId: uuid(9), text: 'secret text', hopChain: [] }, remainingMs: 9_000 });
});
