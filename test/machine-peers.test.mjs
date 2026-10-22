import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { addressOrder, closePeerAgents, createPeerPoller, EXPORT_FIELDS, exportBody, exportLocalSessions, MAX_REPLY_BYTES, mergePeerRows,
  PEER_IDLE_SOCKET_MS, peerRequest, validExport } from '../src/machine-peers.mjs';
import { buildSwitchboardDashboard, OFFLINE_MEMBER } from '../src/switchboard.mjs';

let hasOpenSsl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenSsl = false; }
const tlsTest = (name, run) => test(name, { skip: hasOpenSsl ? false : 'openssl is not on PATH.' }, run);
const nowMs = Date.parse('2026-10-19T10:00:00.000Z');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = (n) => `local_${uuid(n)}`;
const A = { machineId: 'a'.repeat(16), name: 'engine-a' };
const B = { machineId: 'b'.repeat(16), name: 'engine-b' };
const claude = (n, extra = {}) => ({ id: `claude-desktop-code:${local(n)}`, externalId: local(n), provider: 'claude-desktop-code',
  source: 'claude-desktop-code', title: `Task ${n}`, cwd: `/work/${n}`, updatedAtMs: nowMs - 1000, ...extra });
const board = (threads, machine) => buildSwitchboardDashboard(threads, [], nowMs, { machineId: machine.machineId, machineName: machine.name });

// Engine B runs session 5; engine A sees it also as a claude.ai remote-cache row and exchanges messages with it.
const boardB = () => board([
  claude(5, { cliSessionId: uuid(950), bridgeSessionIds: ['session_Tok'], lifecycleRunning: true, agentStartedAtMs: nowMs - 5000,
    agentActivityAtMs: nowMs - 1000, latestLifecycleAtMs: nowMs - 1000, incomingMessages: [{ from: local(1), atMs: nowMs - 20_000 }] }),
  { id: 'claude-desktop-code:session_Other', externalId: 'session_Other', provider: 'claude-desktop-code', source: 'claude-remote-cache',
    title: 'Cached elsewhere', updatedAtMs: nowMs },
], B);
const boardA = () => board([
  claude(1, { cliSessionId: uuid(901), incomingMessages: [{ from: uuid(950), atMs: nowMs - 10_000 }, { from: 'unknown-key', atMs: nowMs - 9000 }] }),
  { id: 'claude-desktop-code:session_Tok', externalId: 'session_Tok', provider: 'claude-desktop-code', source: 'claude-remote-cache',
    title: 'B through claude.ai', updatedAtMs: nowMs },
  claude(3, { incomingMessages: [{ from: 'bridge:session_Tok', atMs: nowMs - 5000 }] }),
], A);
const peerState = (exported, extra = {}) => ({ member: { ...B, certFingerprint: 'b'.repeat(64) }, online: true, lastOkAtMs: nowMs - 1000,
  sessions: validExport(JSON.parse(exportBody(exported).body), B), error: '', ...extra });

test('the export has only local rows with whitelisted fields, their keys, and the incoming messages from other machines', () => {
  const exported = exportLocalSessions(boardB(), B, nowMs);
  assert.deepEqual(Object.keys(exported), ['api', 'machineId', 'name', 'generatedAtMs', 'refreshIntervalMs', 'rows', 'keys', 'incoming']);
  assert.deepEqual([exported.api, exported.machineId, exported.name, exported.generatedAtMs, exported.refreshIntervalMs], [1, B.machineId, 'engine-b', nowMs, 2000]);
  assert.deepEqual(exported.rows.map((row) => row.id), [`claude-desktop-code:${local(5)}`]);
  const [row] = exported.rows;
  assert.deepEqual(Object.keys(row).filter((key) => !Object.hasOwn(EXPORT_FIELDS, key)), []);
  assert.deepEqual([row.state, row.title, row.providerLabel, row.surface], ['working', 'Task 5', 'Claude Desktop Code', 'app']);
  for (const key of ['machineId', 'machineName', 'remote', 'globalId', 'remoteCache', 'canOpen', 'appDeepLink', 'pending']) assert.equal(key in row, false, key);
  assert.deepEqual(Object.keys(exported.keys), [row.id]);
  assert.deepEqual(exported.keys[row.id].sort(), ['bridge:cse_Tok', 'bridge:session_Tok', local(5), uuid(950)].sort());
  assert.deepEqual(exported.incoming, [{ to: row.id, from: local(1), atMs: nowMs - 20_000 }]);
  // The tag leaves out the time, so the same rows give the same tag.
  assert.equal(exportBody(exported).etag, exportBody({ ...exported, generatedAtMs: nowMs + 5 }).etag);
  assert.notEqual(exportBody(exported).etag, exportBody({ ...exported, rows: [] }).etag);
  assert.equal(JSON.stringify(exportLocalSessions({ threads: [], messages: [] }, B, nowMs).keys), '{}');
});

test('the export interval counts only the exported rows, and archived rows stay out with their keys and messages', () => {
  const others = [{ id: 'm:member:row', remote: true, state: 'working' }, { id: 'cache', remoteCache: true, state: 'working' }];
  assert.equal(exportLocalSessions({ threads: [...others, { id: 'local', state: 'idle' }], messages: [] }, B, nowMs).refreshIntervalMs, 5000);
  assert.equal(exportLocalSessions({ threads: [...others, { id: 'local', state: 'working' }], messages: [] }, B, nowMs).refreshIntervalMs, 2000);
  const archived = `claude-desktop-code:${local(7)}`;
  const withArchived = board([claude(7, { archived: true, cliSessionId: uuid(970), incomingMessages: [{ from: 'unknown-key', atMs: nowMs - 3000 }] }),
    claude(8, { incomingMessages: [{ from: 'other-key', atMs: nowMs - 2000 }] })], B);
  assert.equal(withArchived.threads.find((row) => row.id === archived).archived, true);
  const exported = exportLocalSessions(withArchived, B, nowMs);
  assert.deepEqual(exported.rows.map((row) => row.id), [`claude-desktop-code:${local(8)}`]);
  assert.deepEqual(Object.keys(exported.keys), [`claude-desktop-code:${local(8)}`]);
  assert.deepEqual(exported.incoming, [{ to: `claude-desktop-code:${local(8)}`, from: 'other-key', atMs: nowMs - 2000 }]);
});

test('a received export keeps only valid rows and whitelisted fields', () => {
  const exported = exportLocalSessions(boardB(), B, nowMs);
  assert.equal(validExport({ ...exported, machineId: A.machineId }, B), null);
  assert.equal(validExport({ ...exported, api: 2 }, B), null);
  assert.equal(validExport({ ...exported, rows: {} }, B), null);
  const value = validExport({ ...exported, refreshIntervalMs: 1, rows: [...exported.rows, { id: 'bad', state: 'exploded' }, { title: 'no id' },
    { id: 'extra', title: 'Extra', secret: 'drop me' }], keys: { ...exported.keys, extra: [42, 'k'], missing: ['x'] },
    incoming: [...exported.incoming, { to: 'missing', from: 'k', atMs: 1 }, { to: 'extra', from: '', atMs: 1 }] }, B);
  assert.deepEqual(value.rows.map((row) => row.id), [exported.rows[0].id, 'extra']);
  assert.equal('secret' in value.rows[1], false);
  assert.deepEqual([value.refreshIntervalMs, value.keys.extra, value.keys.missing, value.incoming.length], [5000, ['k'], undefined, 1]);
});

test('a long list sends only its newest rows, so a member does not drop the whole reply', () => {
  // Row 1 is the newest and the row `count` is the oldest. The oldest row has an incoming message from another machine.
  const long = (count, size) => {
    const threads = Array.from({ length: count }, (_, index) => claude(index + 1, { title: `Task ${index + 1} ${'t'.repeat(size)}`,
      cwd: `/work/${'d'.repeat(size)}/${index + 1}`, updatedAtMs: nowMs - 1000 * (index + 1), cliSessionId: uuid(10_000 + index) })).reverse();
    threads[0].incomingMessages = [{ from: 'unknown-key', atMs: nowMs - 1000 }];
    return exportLocalSessions(board(threads, B), B, nowMs);
  };
  // What a member reads from the reply: it must fit in MAX_REPLY_BYTES, and it holds the newest rows 1 to N with their keys.
  const received = (exported) => {
    const { body } = exportBody(exported);
    assert.ok(Buffer.byteLength(body) < MAX_REPLY_BYTES);
    const value = validExport(JSON.parse(body), B);
    assert.deepEqual(value.rows.map((row) => row.id).sort(), Array.from({ length: value.rows.length }, (_, index) => `claude-desktop-code:${local(index + 1)}`).sort());
    assert.equal(Object.keys(value.keys).length, value.rows.length);
    return value;
  };
  // 4400 rows of about 1.2 KB are more than 4 MiB. The message for the oldest row is cut with its row.
  const heavy = long(4400, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(heavy)) > MAX_REPLY_BYTES);
  const kept = received(heavy);
  assert.ok(kept.rows.length > 2500 && kept.rows.length < 4400, String(kept.rows.length));
  assert.deepEqual(kept.incoming, []);
  // More than 5000 rows are cut to 5000, also when they are small.
  const many = { ...long(1, 1), rows: Array.from({ length: 5300 }, (_, index) => ({ id: `claude-desktop-code:${local(index + 1)}`, title: 'Short', state: 'idle',
    updatedAtMs: nowMs - 1000 * (index + 1) })).reverse(), keys: {}, incoming: [] };
  assert.equal(many.rows.length, 5300);
  const cut = validExport(JSON.parse(exportBody(many).body), B);
  assert.deepEqual([cut.rows.length, cut.rows[0].id, cut.rows.at(-1).id], [5000, `claude-desktop-code:${local(5000)}`, `claude-desktop-code:${local(1)}`]);
  // A list that fits is sent as it is, with its incoming messages.
  const small = long(30, 20);
  assert.equal(exportBody(small).body, JSON.stringify(small));
  assert.equal(received(small).incoming.length, 1);
});

test('the merge adds the remote rows, replaces the remote-cache row, and joins messages across machines', () => {
  const dashboard = boardA();
  assert.deepEqual(dashboard.messages, [{ from: 'claude-desktop-code:session_Tok', to: `claude-desktop-code:${local(3)}`, atMs: nowMs - 5000 }]);
  assert.equal(dashboard.refreshIntervalMs, 5000);
  mergePeerRows(dashboard, [peerState(exportLocalSessions(boardB(), B, nowMs)), { ...peerState(exportLocalSessions(boardB(), B, nowMs)),
    member: { ...A, certFingerprint: 'a'.repeat(64) } }], A, nowMs);
  const remoteId = `m:${B.machineId}:claude-desktop-code:${local(5)}`;
  assert.deepEqual(dashboard.threads.map((row) => row.id), [`claude-desktop-code:${local(1)}`, `claude-desktop-code:${local(3)}`, remoteId]);
  const remote = dashboard.threads.at(-1);
  assert.deepEqual([remote.machineId, remote.machineName, remote.remote, remote.globalId, remote.remoteCache, remote.canOpen, remote.appDeepLink,
    remote.providerLabel, remote.surface, remote.state, remote.externalId],
  [B.machineId, 'engine-b', true, `${B.machineId}:claude-desktop-code:${local(5)}`, false, false, '', 'Claude Desktop Code', 'app', 'working', local(5)]);
  assert.deepEqual(dashboard.messages, [
    { from: `claude-desktop-code:${local(1)}`, to: remoteId, atMs: nowMs - 20_000 },
    { from: remoteId, to: `claude-desktop-code:${local(1)}`, atMs: nowMs - 10_000 },
    { from: remoteId, to: `claude-desktop-code:${local(3)}`, atMs: nowMs - 5000 },
  ]);
  assert.equal(dashboard.refreshIntervalMs, 2000);
});

test('members export their scope tag, and the observer makes the full reference from the pinned member only', () => {
  const tag = 'f'.repeat(32);
  const tagged = boardB();
  for (const row of tagged.threads) Object.assign(row, { sourceId: 'claude-desktop-code', referenceScope: tag,
    reference: 'asb:1/must/not/go', referenceUnavailable: 'x', sessionReference: 'x/y' });
  const exported = exportLocalSessions(tagged, B, nowMs);
  assert.equal(exported.rows[0].referenceScope, tag);
  assert.deepEqual(['reference', 'sessionReference'].filter((key) => key in exported.rows[0]), []);
  assert.equal(exported.rows[0].referenceUnavailable, 'x');
  // An invalid tag drops the row; a member-sent reference and machine ID are ignored.
  for (const referenceScope of ['F'.repeat(32), 'f'.repeat(31), 42, '']) {
    assert.deepEqual(validExport({ ...exported, rows: [{ ...exported.rows[0], referenceScope }] }, B).rows, []);
  }
  const hostile = { ...exported, rows: [{ ...exported.rows[0], reference: `asb:1/${A.machineId}/x/${tag}/claude-local:${local(9)}`,
    machineId: A.machineId, machineName: 'spoofed' }] };
  const merged = mergePeerRows(boardA(), [peerState(hostile)], A, nowMs);
  const remote = merged.threads.at(-1);
  assert.equal(remote.reference, `asb:1/${B.machineId}/claude-desktop-code/${tag}/claude-local:${local(5)}`);
  assert.deepEqual([remote.machineId, remote.machineName, 'referenceScope' in remote, 'referenceUnavailable' in remote],
    [B.machineId, 'engine-b', false, false]);
  // An old member sends no tag: its rows stay, with no full reference.
  const old = exportLocalSessions(boardB(), B, nowMs);
  const oldRemote = mergePeerRows(boardA(), [peerState(old)], A, nowMs).threads.at(-1);
  assert.deepEqual([oldRemote.id, oldRemote.reference, oldRemote.referenceUnavailable],
    [`m:${B.machineId}:claude-desktop-code:${local(5)}`, undefined, 'old-peer']);
  const bad = { ...exported, rows: [{ ...exported.rows[0], externalId: 'not-an-id' }] };
  assert.equal(mergePeerRows(boardA(), [peerState(bad)], A, nowMs).threads.at(-1).referenceUnavailable, 'invalid-app-id');
  // A member-sent code only blocks: with no tag, only 'ambiguous-source' replaces 'old-peer'.
  const { referenceScope: _tag, ...untagged } = exported.rows[0];
  const sent = (code) => mergePeerRows(boardA(), [peerState({ ...exported, rows: [{ ...untagged, referenceUnavailable: code }] })], A, nowMs)
    .threads.at(-1);
  assert.deepEqual([sent('ambiguous-source').referenceUnavailable, sent('ambiguous-source').reference], ['ambiguous-source', undefined]);
  for (const code of ['invalid-app-id', 'no-machine-identity', 'x']) assert.equal(sent(code).referenceUnavailable, 'old-peer', code);
  // With a tag and a valid ID, the observer makes its own reference and drops the member code.
  const own = mergePeerRows(boardA(), [peerState({ ...exported, rows: [{ ...exported.rows[0], referenceUnavailable: 'ambiguous-source' }] })],
    A, nowMs).threads.at(-1);
  assert.deepEqual([own.reference, own.referenceUnavailable], [remote.reference, undefined]);
});

test('member rows get the checked short reference with the provider host, and none for an invalid ID', () => {
  const exported = exportLocalSessions(boardB(), B, nowMs);
  assert.equal(mergePeerRows(boardA(), [peerState(exported)], A, nowMs).threads.at(-1).sessionReference, `claude-desktop-code/${local(5)}`);
  for (const externalId of ['not-an-id', `${local(5)}\n`]) {
    const sessions = { ...exported, rows: [{ ...exported.rows[0], externalId }] };
    const remote = mergePeerRows(boardA(), [{ ...peerState(exported), sessions }], A, nowMs).threads.at(-1);
    assert.equal('sessionReference' in remote, false, JSON.stringify(externalId));
  }
});

test('an offline member gives Unknown rows with the note, and its rows leave after 10 minutes', () => {
  const exported = exportLocalSessions(boardB(), B, nowMs);
  const offline = mergePeerRows(boardA(), [peerState(exported, { online: false, lastOkAtMs: nowMs - 599_000 })], A, nowMs);
  const remote = offline.threads.at(-1);
  assert.deepEqual([remote.state, remote.reason, remote.workingSinceMs], ['unknown', 'engine-b is not reachable.', 0]);
  // The tracker and the sounds keep their last values for this row; an online member's row has no such mark.
  assert.equal(remote[OFFLINE_MEMBER], true);
  assert.equal(mergePeerRows(boardA(), [peerState(exported)], A, nowMs).threads.at(-1)[OFFLINE_MEMBER], undefined);
  assert.equal(offline.refreshIntervalMs, 5000);
  const gone = mergePeerRows(boardA(), [peerState(exported, { online: false, lastOkAtMs: nowMs - 600_000 })], A, nowMs);
  assert.deepEqual(gone.threads.map((row) => row.remote), [false, false, false]);
  assert.equal(gone.threads.some((row) => row.remoteCache), true);
  // A member that never answered adds nothing.
  assert.equal(mergePeerRows(boardA(), [peerState(exported, { lastOkAtMs: 0 })], A, nowMs).threads.length, 3);
});

test('addresses go in the order last good, LAN, ZeroTier, Tailscale', () => {
  const list = [{ kind: 'tailscale', address: '100.64.0.1' }, { kind: 'zerotier', address: '10.1.0.1' }, { kind: 'lan', address: '192.168.1.2' }];
  assert.deepEqual(addressOrder(list).map((item) => item.kind), ['lan', 'zerotier', 'tailscale']);
  assert.deepEqual(addressOrder(list, '100.64.0.1').map((item) => item.kind), ['tailscale', 'lan', 'zerotier']);
});

async function identity(dir, name) {
  const key = path.join(dir, `${name}-key.pem`);
  const cert = path.join(dir, `${name}-cert.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key,
    '-out', cert, '-days', '2', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  return { ...tls, fingerprint: new X509Certificate(tls.cert).fingerprint256.replaceAll(':', '').toLowerCase() };
}

// `connections` has the TCP connection of every client that the server accepted, in order; `open()` has those that are not closed yet.
async function tlsServer(t, server, handler, options = {}) {
  const records = [];
  const connections = [];
  const listener = https.createServer({ key: server.key, cert: server.cert, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false, ...options },
    (request, response) => {
      const raw = request.socket.getPeerCertificate(true).raw;
      records.push({ url: request.url, method: request.method, headers: request.headers, client: raw ? createHash('sha256').update(raw).digest('hex') : '' });
      handler(request, response);
    });
  listener.on('connection', (socket) => connections.push(socket));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { listener.closeAllConnections(); listener.close(resolve); }));
  return { port: listener.address().port, records, listener, connections, open: () => connections.filter((socket) => !socket.destroyed) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what) {
  for (let round = 0; round < 200 && !condition(); round += 1) await sleep(10);
  assert.ok(condition(), `no change: ${what}`);
}
const memberAt = (server, port, extra = {}) => ({ machineId: server.fingerprint.slice(0, 16), certFingerprint: server.fingerprint, port,
  addresses: [{ kind: 'lan', address: '127.0.0.1' }], ...extra });

tlsTest('the peer client pins the server certificate, sends its own, and limits replies', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-peers-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [server, client, other] = await Promise.all([identity(dir, 'server'), identity(dir, 'client'), identity(dir, 'other')]);
  let reply = (request, response) => { response.setHeader('etag', '"e1"'); response.end(JSON.stringify({ path: request.url })); };
  const { port, records } = await tlsServer(t, server, (request, response) => reply(request, response));
  const member = (extra = {}) => ({ machineId: server.fingerprint.slice(0, 16), certFingerprint: server.fingerprint, port,
    addresses: [{ kind: 'lan', address: '127.0.0.1' }], ...extra });
  const ok = await peerRequest({ member: member(), path: '/peer/v1/hello', etag: '"e0"', tls: client });
  assert.deepEqual([ok.status, ok.etag, ok.body, ok.address], [200, '"e1"', { path: '/peer/v1/hello' }, '127.0.0.1']);
  assert.deepEqual([records[0].client, records[0].headers['if-none-match'], records[0].headers['accept-encoding']], [client.fingerprint, '"e0"', 'gzip']);
  // A wrong pin stops before the request goes out.
  await assert.rejects(peerRequest({ member: member({ certFingerprint: other.fingerprint }), path: '/peer/v1/join', method: 'POST',
    body: { code: 'secret' }, tls: client }), { code: 'pin-mismatch' });
  assert.equal(records.length, 1);
  // Addresses that do not answer are skipped in order; the working address comes back for the next request.
  const tried = await peerRequest({ member: member({ addresses: [{ kind: 'tailscale', address: '127.0.0.1' }, { kind: 'lan', address: '127.0.0.9' }] }),
    path: '/x', tls: client, timeoutMs: 1000 });
  assert.equal(tried.address, '127.0.0.1');
  const body = await peerRequest({ member: member(), path: '/post', method: 'POST', body: { left: 1 }, tls: client });
  assert.equal(body.status, 200);
  assert.equal(records.at(-1).headers['content-type'], 'application/json');
  reply = (request, response) => { response.setHeader('content-encoding', 'gzip'); response.end(gzipSync(JSON.stringify({ zipped: true }))); };
  assert.deepEqual((await peerRequest({ member: member(), path: '/gzip', tls: client })).body, { zipped: true });
  reply = (request, response) => { response.setHeader('content-encoding', 'gzip'); response.end(gzipSync(`"${'x'.repeat(4 * 1024 * 1024)}"`)); };
  await assert.rejects(peerRequest({ member: member(), path: '/bomb', tls: client }), { code: 'too-large' });
  reply = (request, response) => response.end(`"${'x'.repeat(4 * 1024 * 1024)}"`);
  await assert.rejects(peerRequest({ member: member(), path: '/large', tls: client }), { code: 'too-large' });
  reply = () => {};
  await assert.rejects(peerRequest({ member: member(), path: '/slow', tls: client, timeoutMs: 200 }), { code: 'timeout' });
});

tlsTest('a POST goes to the next address only when it did not go out; a GET tries each address', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-peers-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [server, client, other] = await Promise.all([identity(dir, 'server'), identity(dir, 'client'), identity(dir, 'other')]);
  let reply = () => {};
  const { port, records } = await tlsServer(t, server, (request, response) => reply(request, response));
  const twice = { machineId: server.fingerprint.slice(0, 16), certFingerprint: server.fingerprint, port,
    addresses: [{ kind: 'lan', address: '127.0.0.1' }, { kind: 'zerotier', address: '127.0.0.1' }] };
  // The first address takes the POST and does not answer: the second address does not get it.
  // The limits leave time for a slow loopback handshake or refusal on Windows (about 1 to 2 s).
  await assert.rejects(peerRequest({ member: twice, path: '/peer/v1/deliver', method: 'POST', body: { n: 1 }, tls: client, timeoutMs: 2000 }),
    (error) => error.code === 'timeout' && error.handedOff === true);
  assert.equal(records.length, 1);
  // A GET tries the next address after any failure.
  await assert.rejects(peerRequest({ member: twice, path: '/peer/v1/peers', tls: client, timeoutMs: 1000 }), { code: 'timeout' });
  assert.equal(records.length, 3);
  // A refused connection: the POST goes to the next address.
  reply = (request, response) => response.end(JSON.stringify({ ok: true }));
  const refused = { ...twice, addresses: [{ kind: 'lan', address: '127.0.0.9' }, { kind: 'zerotier', address: '127.0.0.1' }] };
  const second = await peerRequest({ member: refused, path: '/peer/v1/deliver', method: 'POST', body: { n: 2 }, tls: client, timeoutMs: 6000 });
  assert.deepEqual([second.status, second.address, records.length], [200, '127.0.0.1', 4]);
  // A wrong certificate at the first address: the request does not go out there, and the second address gets it.
  const pinned = await tlsServer(t, other, (request, response) => response.end(JSON.stringify({ ok: true })));
  const listener = pinned.listener;
  // The TLS socket of a connection takes the context of its time, so only later connections get the pinned certificate.
  listener.once('connection', () => listener.setSecureContext({ key: server.key, cert: server.cert }));
  let connections = 0;
  listener.on('connection', () => { connections += 1; });
  const third = await peerRequest({ member: { ...twice, port: pinned.port }, path: '/peer/v1/deliver', method: 'POST', body: { n: 3 }, tls: client, timeoutMs: 6000 });
  assert.deepEqual([third.status, pinned.records.length, connections], [200, 1, 2]);
});

tlsTest('a POST address that hangs before the handoff gets only its share of the time', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-peers-share-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [server, client] = await Promise.all([identity(dir, 'server'), identity(dir, 'client')]);
  const { port, records } = await tlsServer(t, server, (request, response) => response.end(JSON.stringify({ ok: true })));
  // A TCP listener that never starts TLS, on another loopback address with the same port.
  const sockets = new Set();
  const silent = net.createServer((socket) => { sockets.add(socket); socket.resume(); });
  const bound = await new Promise((resolve) => { silent.once('error', () => resolve(false)); silent.listen(port, '127.0.0.2', () => resolve(true)); });
  if (!bound) { t.skip('127.0.0.2 cannot be bound here.'); return; }
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); silent.close(resolve); }));
  const member = { machineId: server.fingerprint.slice(0, 16), certFingerprint: server.fingerprint, port,
    addresses: [{ kind: 'lan', address: '127.0.0.2' }, { kind: 'zerotier', address: '127.0.0.1' }] };
  const started = Date.now();
  const reply = await peerRequest({ member, path: '/peer/v1/deliver', method: 'POST', body: { n: 1 }, tls: client, timeoutMs: 4000 });
  assert.deepEqual([reply.status, reply.address, records.length], [200, '127.0.0.1', 1]);
  assert.ok(Date.now() - started < 4000);
  // A GET keeps its full timeout at each address, also before the handoff.
  const getStarted = Date.now();
  const listed = await peerRequest({ member, path: '/peer/v1/peers', tls: client, timeoutMs: 1000 });
  assert.equal(listed.address, '127.0.0.1');
  assert.ok(Date.now() - getStarted >= 950, `the GET left the first address after ${Date.now() - getStarted} ms`);
});

async function identities(t, prefix, ...names) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `asb-peers-${prefix}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return Promise.all(names.map((name) => identity(dir, name)));
}

tlsTest('GET requests keep one TLS connection for each address; POST requests always use a new one', async (t) => {
  const [server, client] = await identities(t, 'keep', 'server', 'client');
  let delayMs = 0;
  const { port, records, connections, open } = await tlsServer(t, server, (request, response) => {
    setTimeout(() => response.end(JSON.stringify({ path: request.url })), delayMs);
  });
  const member = memberAt(server, port);
  assert.ok(PEER_IDLE_SOCKET_MS < 65_000, 'a kept socket must close before the 65 s keep-alive timeout of the gateway');
  for (let n = 0; n < 5; n += 1) assert.deepEqual((await peerRequest({ member, path: `/peer/v1/sessions?n=${n}`, tls: client })).body, { path: `/peer/v1/sessions?n=${n}` });
  // One handshake for five GETs, and each one carries the client certificate.
  assert.deepEqual([records.length, connections.length, [...new Set(records.map((record) => record.client))]], [5, 1, [client.fingerprint]]);
  // A POST never takes the kept socket and never leaves one: a closed socket could fail after the hand-off.
  for (const n of [1, 2]) assert.equal((await peerRequest({ member, path: '/peer/v1/deliver', method: 'POST', body: { n }, tls: client })).status, 200);
  assert.equal(connections.length, 3);
  await peerRequest({ member, path: '/peer/v1/hello', tls: client });
  assert.equal(connections.length, 3);
  await until(() => open().length === 1, 'only the kept socket stays open');
  // Four GETs at the same time use four sockets; after they end, at most 2 sockets stay open.
  delayMs = 50;
  await Promise.all([1, 2, 3, 4].map((n) => peerRequest({ member, path: `/peer/v1/peers?n=${n}`, tls: client })));
  assert.equal(connections.length, 6);
  await until(() => open().length === 2, 'two kept sockets');
  await sleep(50);
  assert.equal(open().length, 2);
});

tlsTest('a kept connection serves only the pin and the client certificate that it passed with', async (t) => {
  const [server, client, other, second] = await identities(t, 'pins', 'server', 'client', 'other', 'second');
  const { port, records, connections, open } = await tlsServer(t, server, (request, response) => response.end('{}'));
  const get = (pin, tls) => peerRequest({ member: memberAt(server, port, { certFingerprint: pin }), path: '/peer/v1/hello', tls });
  await get(server.fingerprint, client);
  assert.deepEqual([records.length, connections.length, open().length], [1, 1, 1]);
  // Another pin for the same address and port: it never uses the kept socket. Its new connection fails at the pin before any request byte.
  await assert.rejects(get(other.fingerprint, client), { code: 'pin-mismatch' });
  assert.deepEqual([records.length, connections.length], [1, 2]);
  await until(() => open().length === 0, 'the sockets of the old pin close');
  await get(server.fingerprint, client);
  assert.deepEqual([records.length, connections.length, open().length], [2, 3, 1]);
  // Another client certificate with the same pin: a new connection with the new certificate, and the old socket closes.
  await get(server.fingerprint, second);
  assert.deepEqual([records.at(-1).client, connections.length], [second.fingerprint, 4]);
  await until(() => open().length === 1, 'the socket of the old client certificate closes');
  // The same client certificate in a new object keeps the connection.
  await get(server.fingerprint, { ...second });
  assert.deepEqual([connections.length, open().length], [4, 1]);
});

tlsTest('a server that changes its certificate is stopped at the pin on a new connection, before any request byte', async (t) => {
  const [server, client, other] = await identities(t, 'changed', 'server', 'client', 'other');
  const { port, records, listener, connections, open } = await tlsServer(t, server, (request, response) => response.end('{}'));
  const member = memberAt(server, port);
  await peerRequest({ member, path: '/peer/v1/hello', tls: client });
  // A connection keeps the certificate of its own handshake, so the kept socket still serves.
  listener.setSecureContext({ key: other.key, cert: other.cert });
  await peerRequest({ member, path: '/peer/v1/hello', tls: client });
  assert.deepEqual([records.length, connections.length], [2, 1]);
  // The server closes the kept socket. The next GET, on a new connection (or on the old socket and then a new one), meets the new certificate.
  for (const socket of open()) socket.destroy();
  await assert.rejects(peerRequest({ member, path: '/peer/v1/hello', tls: client }), { code: 'pin-mismatch' });
  assert.equal(records.length, 2);
  await assert.rejects(peerRequest({ member, path: '/peer/v1/hello', tls: client }), { code: 'pin-mismatch' });
  assert.equal(records.length, 2);
});

tlsTest('a GET that fails on a kept socket before any reply byte goes again one time on a new connection', async (t) => {
  const [server, client] = await identities(t, 'stale', 'server', 'client');
  let behavior = 'answer';
  const { port, records, connections } = await tlsServer(t, server, (request, response) => {
    const drop = behavior !== 'answer';
    if (behavior === 'drop-first') behavior = 'answer';
    if (drop) request.socket.destroy(); else response.end('{"ok":true}');
  });
  const member = memberAt(server, port);
  const get = (extra = {}) => peerRequest({ member, path: '/peer/v1/sessions', tls: client, ...extra });
  await get();
  // The member closes the kept socket as the request arrives: the retry on a new connection answers.
  behavior = 'drop-first';
  assert.deepEqual([(await get()).body, records.length, connections.length], [{ ok: true }, 3, 2]);
  // The retry connection is not kept: the next GET opens a kept one, and then the same. Now every request is dropped.
  await get();
  assert.equal(connections.length, 3);
  behavior = 'drop';
  const before = records.length;
  await assert.rejects(get(), { code: 'ECONNRESET' });
  assert.equal(records.length - before, 2, 'a kept socket gives the first try, a new connection the one retry');
  // With no kept socket the first try is on a new connection, so there is no retry.
  await assert.rejects(get(), { code: 'ECONNRESET' });
  assert.equal(records.length - before, 3);
  // A POST is never repeated; the error says that the request went out.
  await assert.rejects(peerRequest({ member, path: '/peer/v1/deliver', method: 'POST', body: { n: 1 }, tls: client }),
    (error) => error.code === 'ECONNRESET' && error.handedOff === true);
  assert.equal(records.length - before, 4);
});

tlsTest('the retry of a GET uses the rest of the same timeout', async (t) => {
  const [server, client] = await identities(t, 'budget', 'server', 'client');
  let behavior = 'answer';
  const { port } = await tlsServer(t, server, (request, response) => {
    if (behavior === 'answer') response.end('{}');
    else if (behavior === 'drop-then-hang') { behavior = 'hang'; request.socket.destroy(); }
  });
  const member = memberAt(server, port);
  await peerRequest({ member, path: '/peer/v1/sessions', tls: client });
  behavior = 'drop-then-hang';
  const startedAt = Date.now();
  await assert.rejects(peerRequest({ member, path: '/peer/v1/sessions', tls: client, timeoutMs: 600 }), { code: 'timeout' });
  const tookMs = Date.now() - startedAt;
  assert.ok(tookMs >= 550 && tookMs < 1100, `the GET and its retry took ${tookMs} ms`);
});

tlsTest('the peer client refuses a server below TLS 1.3, also with the kept connection', async (t) => {
  const [server, client] = await identities(t, 'old', 'server', 'client');
  const { port, records } = await tlsServer(t, server, (request, response) => response.end('{}'), { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
  for (const method of ['GET', 'POST']) {
    await assert.rejects(peerRequest({ member: memberAt(server, port), path: '/peer/v1/hello', method, ...(method === 'POST' ? { body: {} } : {}), tls: client }),
      (error) => !['timeout', 'pin-mismatch'].includes(error.code), method);
  }
  assert.equal(records.length, 0);
});

tlsTest('closePeerAgents and a stopped poller close the kept connections of that member only', async (t) => {
  const [server, client] = await identities(t, 'close', 'server', 'client');
  const { port, records, open } = await tlsServer(t, server, (request, response) => response.end('{}'));
  const member = memberAt(server, port);
  await peerRequest({ member, path: '/peer/v1/hello', tls: client });
  assert.equal(open().length, 1);
  closePeerAgents('f'.repeat(64));
  await sleep(50);
  assert.equal(open().length, 1);
  closePeerAgents(server.fingerprint);
  await until(() => open().length === 0, 'the kept socket closes');
  // The poller of a member that leaves the group, or of a stopped engine, closes its sockets when it stops.
  const poller = createPeerPoller({ member: { ...member, name: 'engine-s' }, tls: async () => client, validAddresses: () => true });
  poller.start();
  await until(() => records.length >= 3 && open().length >= 1, 'the first polls');
  poller.stop();
  await until(() => open().length === 0, 'the poller closes its sockets');
});

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (run, ms) => { const handle = { run, ms, unref() {} }; pending.push(handle); return handle; },
    clearTimeout: (handle) => { const index = pending.indexOf(handle); if (index >= 0) pending.splice(index, 1); },
    // Runs the newest timer (with this delay, if given) and waits for its request.
    async fire(ms) {
      const index = ms === undefined ? pending.length - 1 : pending.findLastIndex((handle) => handle.ms === ms);
      assert.ok(index >= 0, `no ${ms} ms timer in ${pending.map((handle) => handle.ms)}`);
      const [handle] = pending.splice(index, 1);
      handle.run();
      for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('a 410 from the member calls onRemoved one time and stops all polls', async () => {
  const timers = fakeTimers();
  const routes = [];
  let removed = 0;
  const poller = createPeerPoller({ member: { ...B, certFingerprint: 'b'.repeat(64), addresses: [{ kind: 'lan', address: '10.0.0.2' }], port: 4630 },
    tls: async () => ({}), timers, validAddresses: () => true, onRemoved: () => { removed += 1; },
    request: async ({ path: route }) => { routes.push(route); return { status: 410, body: { error: 'This machine was removed from the group.' } }; } });
  poller.start();
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([removed, routes.sort(), timers.pending], [1, ['/peer/v1/hello', '/peer/v1/sessions'], []]);
});

test('the poller backs off after failures, goes offline after 3, and comes back after one good reply', async () => {
  const timers = fakeTimers();
  const exported = exportLocalSessions(boardB(), B, nowMs);
  let clock = nowMs;
  const answers = [];
  const calls = [];
  const groups = [];
  let changes = 0;
  const request = async ({ path: route, etag }) => {
    calls.push({ route, etag });
    if (route === '/peer/v1/hello') return { status: 200, address: '10.0.0.2', body: { machineId: B.machineId, addresses: [{ kind: 'lan', address: '10.0.0.3' }], port: 4700 } };
    if (route === '/peer/v1/group') return { status: 200, body: { groupId: 'g' } };
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const poller = createPeerPoller({ member: { ...B, certFingerprint: 'b'.repeat(64), addresses: [{ kind: 'lan', address: '10.0.0.2' }], port: 4630 },
    tls: async () => ({}), request, timers, now: () => clock, onChange: () => { changes += 1; }, onGroup: (value) => groups.push(value),
    validAddresses: (value) => Array.isArray(value) });
  answers.push({ status: 200, etag: '"e1"', body: JSON.parse(exportBody(exported).body) });
  poller.start();
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([poller.state.online, poller.state.lastOkAtMs, poller.state.sessions.rows.length, changes], [true, nowMs, 1, 1]);
  assert.deepEqual([poller.state.member.addresses, poller.state.member.port], [[{ kind: 'lan', address: '10.0.0.3' }], 4700]);
  assert.deepEqual(timers.pending.map((handle) => handle.ms).sort((a, b) => a - b), [2000, 30_000, 60_000]);
  // 304 keeps the rows and sends the tag; no change.
  answers.push({ status: 304, etag: '"e1"' });
  clock += 2000;
  await timers.fire(2000);
  assert.deepEqual([calls.at(-1).etag, changes, poller.state.lastOkAtMs], ['"e1"', 1, nowMs + 2000]);
  for (const [delay, online] of [[5000, true], [10_000, true], [30_000, false], [30_000, false]]) {
    answers.push(Object.assign(new Error('down'), { code: 'timeout' }));
    await timers.fire();
    assert.equal(poller.state.online, online);
    assert.equal(timers.pending.at(-1).ms, delay);
  }
  assert.deepEqual([changes, poller.state.error], [2, 'timeout']);
  answers.push({ status: 200, etag: '"e2"', body: { ...JSON.parse(exportBody(exported).body), refreshIntervalMs: 5000 } });
  await timers.fire();
  assert.deepEqual([poller.state.online, changes, poller.state.error, timers.pending.at(-1).ms], [true, 3, '', 5000]);
  // An invalid export counts as a failed poll.
  answers.push({ status: 200, etag: '"e3"', body: { api: 1 } });
  await timers.fire();
  assert.deepEqual([poller.state.error, poller.state.sessions.rows.length, timers.pending.at(-1).ms], ['invalid-reply', 1, 5000]);
  await timers.fire(30_000);
  assert.deepEqual(groups, [{ groupId: 'g' }]);
  poller.stop();
  assert.deepEqual(timers.pending, []);
});

test('member text with a lone surrogate comes out well formed', () => {
  const exported = exportLocalSessions(board([claude(1)], B), B, nowMs);
  exported.rows[0].title = `Task \ud83d`;
  const title = validExport(exported, B).rows[0].title;
  assert.equal(title.isWellFormed(), true);
});

test('a bad member port rejects at once and leaves no timer that throws later', async () => {
  const member = { machineId: B.machineId, addresses: [{ kind: 'lan', address: '127.0.0.1' }], port: 70000, certFingerprint: 'f'.repeat(64) };
  await assert.rejects(peerRequest({ member, path: '/peer/v1/hello', tls: {}, timeoutMs: 20 }), { code: 'ERR_SOCKET_BAD_PORT' });
  await new Promise((resolve) => setTimeout(resolve, 50));
});
