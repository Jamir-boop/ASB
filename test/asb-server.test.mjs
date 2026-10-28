import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, gunzipSync } from 'node:zlib';
import { jsCrc32 } from '../src/local-http.mjs';
import { createAsbServer, panelSummary } from '../src/asb-server.mjs';
import { DashboardSnapshot } from '../src/dashboard-snapshot.mjs';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

async function serve(t, options, create = createAsbServer) {
  const server = create({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, post: (route, body = '{}', headers = {}) => fetch(base + route, { method: 'POST', headers: { Origin: base, ...headers }, body }) };
}

// The row counts each time that a JSON list holds it, so the count is the number of list serializations (and of action replies that hold it).
const counted = (counter, row) => Object.defineProperty(row, 'toJSON', { value() { counter.count += 1; return { ...this }; } });
// The tag of a parsed reply: the hash of all fields except `generatedAtMs` and `performance`, in the order of the reply.
const tagOf = ({ generatedAtMs: _, performance: __, ...list }) => `"${createHash('sha256').update(JSON.stringify(list)).digest('base64url')}"`;
// A dashboard read that checks the rule for every reply: the tag is the one of the body.
const dashboardReader = (base) => async (headers = {}, query = '') => {
  const response = await fetch(`${base}/api/dashboard${query}`, { headers });
  const etag = response.headers.get('etag');
  if (response.status === 304) return { status: 304, etag };
  const body = await response.json();
  assert.equal(etag, tagOf(body));
  return { status: response.status, etag, body };
};

test('app source changes need the window token when the launcher sets one', async (t) => {
  for (const sourceToken of ['window-token', '']) {
    const calls = [];
    const { base, post } = await serve(t, { sourceToken, listSources: async () => ({ sources: [] }),
      updateSource: async (source) => { calls.push(source); }, removeSource: async (id) => { calls.push(id); } });
    const routes = [['/api/sources', '{"source":{"id":"a"}}'], ['/api/sources/a/remove', '{}']];
    for (const [route, body] of routes) {
      for (const headers of [{}, { 'X-ASB-Source-Token': 'window-tokem' }, { 'X-ASB-Source-Token': 'window-token-long' }]) {
        const response = await post(route, body, headers);
        assert.equal(response.status, sourceToken ? 403 : 200);
        if (sourceToken) assert.deepEqual(await response.json(), { error: 'Use app source actions from the ASB window.' });
      }
      if (sourceToken) assert.deepEqual(calls, []);
      calls.length = 0;
      assert.equal((await post(route, body, { 'X-ASB-Source-Token': 'window-token' })).status, 200);
      assert.equal(calls.length, 1);
      calls.length = 0;
    }
    assert.equal((await fetch(`${base}/api/sources`)).status, 200);
    assert.equal((await post('/api/sources', '{}', { Origin: 'https://example.com', 'X-ASB-Source-Token': 'window-token' })).status, 403);
  }
});

test('unexpected source update and removal errors use the profile fallback', async (t) => {
  const fail = async () => { throw new Error('Synthetic failure'); };
  const { post } = await serve(t, { listSources: async () => ({ sources: [] }), updateSource: fail, removeSource: fail });
  for (const [route, body] of [['/api/sources', '{"source":{}}'], ['/api/sources/a/remove', '{}']]) {
    const response = await post(route, body);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Cannot update the ASB profiles.' });
  }
});

test('a successful open is not hidden by a scan that finished while the app opened', async (t) => {
  let acknowledged = false;
  let loads = 0;
  const { base, post } = await serve(t, {
    loadDashboard: async () => { loads += 1; return { providers: [], threads: [{ id: 'one', unread: !acknowledged }] }; },
    openThread: async (thread) => { await delay(300); acknowledged = true; thread.unread = false; return { opened: true, method: 'mock' }; },
  });
  const read = async (query = '') => (await (await fetch(`${base}/api/dashboard${query}`)).json()).threads[0].unread;
  assert.equal(await read(), true);
  const opening = post('/api/threads/one/open');
  await delay(50);
  assert.equal(await read('?force=1'), true);
  assert.deepEqual(await (await opening).json(), { opened: true, method: 'mock', threadId: 'one', provider: 'codex' });
  assert.equal(await read(), false);
  assert.equal(loads, 3);
});

test('forced reads during a scan share one scan that starts after them', async () => {
  let loads = 0;
  let value = 'old';
  let fail = false;
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const snapshot = new DashboardSnapshot({ loadDashboard: async () => {
    loads += 1;
    if (fail) { fail = false; throw new Error('Scan failed'); }
    const seen = value;
    started.resolve();
    await gate.promise;
    return { value: seen };
  } });
  const first = snapshot.loadSharedDashboard();
  await started.promise;
  value = 'new';
  const forced = [1, 2, 3].map(() => snapshot.loadSharedDashboard({ force: true }));
  gate.resolve();
  assert.equal((await first).value, 'old');
  assert.deepEqual((await Promise.all(forced)).map((dashboard) => dashboard.value), ['new', 'new', 'new']);
  assert.equal(loads, 2);
  await snapshot.loadSharedDashboard({ force: true });
  assert.equal(loads, 3);
  fail = true;
  const failing = snapshot.loadSharedDashboard({ force: true });
  const afterFailure = snapshot.loadSharedDashboard({ force: true });
  await assert.rejects(failing, /Scan failed/);
  assert.equal((await afterFailure).value, 'new');
  assert.equal(loads, 5);
});

test('a source change during a scan replies with a scan that started after the change', async (t) => {
  const sources = ['default'];
  const started = Promise.withResolvers();
  const changed = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { base, post } = await serve(t, {
    loadDashboard: async () => { const seen = [...sources]; started.resolve(); await gate.promise; return { providers: [], threads: [], seen }; },
    listSources: async (dashboard) => ({ sources: dashboard.seen }),
    updateSource: async (source) => { sources.push(source.id); changed.resolve(); },
  });
  const first = fetch(`${base}/api/dashboard`);
  await started.promise;
  const reply = post('/api/sources', '{"source":{"id":"added"}}');
  await changed.promise;
  await delay(20);
  gate.resolve();
  assert.deepEqual(await (await reply).json(), { changed: true, sources: ['default', 'added'] });
  await first;
});

test('the dashboard reply has a content tag and an equal tag gets 304 with no body', async (t) => {
  let loads = 0;
  let board;
  const reset = () => { board = { generatedAtMs: 1, providers: [{ id: 'codex', message: 'ok' }], threads: [{ id: 'one', title: 'A' }],
    refreshIntervalMs: 5_000, persistentUnread: false }; };
  reset();
  const { base } = await serve(t, { loadDashboard: async () => { loads += 1; return structuredClone(board); } });
  const get = (headers = {}, query = '?force=1') => fetch(`${base}/api/dashboard${query}`, { headers });
  const first = await get();
  const tag = first.headers.get('etag');
  const body = await first.json();
  assert.match(tag, /^"[A-Za-z0-9_-]{43}"$/);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body).sort(), ['generatedAtMs', 'palette', 'performance', 'persistentUnread', 'providers', 'refreshIntervalMs', 'summary', 'threads']);
  assert.deepEqual(body.threads, board.threads);
  assert.equal(body.performance.dashboard.notModified, 0);
  board.generatedAtMs = 2;
  const second = await get();
  assert.equal(second.headers.get('etag'), tag);
  assert.notEqual((await second.json()).performance.dashboard.loadCount, body.performance.dashboard.loadCount);
  assert.equal((await get({}, '')).headers.get('etag'), tag);

  const changes = [(b) => { b.threads[0].title = 'B'; }, (b) => { b.providers[0].message = 'Not found'; },
    (b) => { b.persistentUnread = true; }, (b) => { b.refreshIntervalMs = 2_000; },
    (b) => { b.messages = [{ from: 'two', to: 'one', atMs: 1 }]; }];
  for (const change of changes) {
    change(board);
    assert.notEqual((await get()).headers.get('etag'), tag, String(change));
    reset();
  }

  loads = 0;
  const same = await get({ 'If-None-Match': tag });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get('etag'), tag);
  assert.equal(same.headers.get('cache-control'), 'no-store');
  assert.equal(same.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await same.text(), '');
  assert.equal(loads, 1);
  assert.equal((await get({ 'If-None-Match': tag }, '')).status, 304);
  for (const headers of [{}, { 'If-None-Match': '"other"' }, { 'If-None-Match': tag.slice(1, -1) }]) {
    const reply = await get(headers);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('etag'), tag);
    assert.equal((await reply.json()).performance.dashboard.notModified, 2);
  }
  const refused = await get({ 'If-None-Match': tag, Origin: 'https://example.com' });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('etag'), null);
  assert.deepEqual(await refused.json(), { error: 'Use the local ASB API.' });
  assert.equal((await get({ 'If-None-Match': tag, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  board.threads[0].title = 'B';
  assert.equal((await get({ 'If-None-Match': tag })).status, 200);
});

const PALETTE = { mode: 'custom', colors: { background: '#101010', text: '#eeeeee', accent: '#3584e4', muted: '#888888',
  divider: '#333333', success: '#3584e4', warning: '#3584e4' } };

test('a repeated dashboard request serializes the list and hashes it one time, and each change to the list gives a new tag and body', async (t) => {
  const paletteDir = await mkdtemp(path.join(os.tmpdir(), 'asb-list-'));
  t.after(() => rm(paletteDir, { recursive: true, force: true }));
  const serialized = { count: 0 };
  let loads = 0;
  let title = 'A';
  const marks = {};
  // A session action keeps its mark for the next scan, and sets it on the cached row in place, as the tracker does.
  const mark = (values) => async (thread) => { Object.assign(marks, values); Object.assign(thread, marks); };
  // A fixed clock keeps the snapshot valid, so only the actions and the forced reads start a scan.
  const { server, base, post } = await serve(t, { sourceToken: 'window-token', palettePath: path.join(paletteDir, 'palette.json'), now: () => 1_760_000_000_000,
    loadDashboard: async () => { loads += 1; return { generatedAtMs: loads, providers: [], threads: [counted(serialized, { id: 'one', title, ...marks })] }; },
    markUnreadThread: mark({ unread: true }), markReadThread: mark({ unread: false }),
    drawerThread: async (thread, enabled) => mark({ drawer: enabled })(thread), muteThread: async (thread, enabled) => mark({ muted: enabled })(thread),
    discardThread: async (thread, enabled) => mark({ discardResult: enabled })(thread),
    pinThread: async (thread, action) => { await mark({ pinned: action === 'pin' })(thread); return []; } });
  const get = dashboardReader(base);

  const first = await get();
  assert.equal(serialized.count, 1);
  for (const headers of [{}, {}, { 'If-None-Match': '"other"' }]) {
    const again = await get(headers);
    assert.equal(again.etag, first.etag);
    assert.deepEqual(again.body.threads, first.body.threads);
    assert.equal(again.body.generatedAtMs, first.body.generatedAtMs);
  }
  assert.equal((await get({ 'If-None-Match': first.etag })).status, 304);
  assert.equal((await get({ 'If-None-Match': first.etag })).status, 304);
  assert.deepEqual([serialized.count, loads], [1, 1]);

  // Each action changes the cached row in place or makes a new scan; the reply that follows is made again one time.
  let previous = first;
  const actions = [['mark-unread', 'unread', true], ['mark-read', 'unread', false], ['drawer-in', 'drawer', true], ['drawer-out', 'drawer', false],
    ['mute', 'muted', true], ['unmute', 'muted', false], ['pin', 'pinned', true], ['unpin', 'pinned', false],
    ['discard-result', 'discardResult', true], ['keep-result', 'discardResult', false]];
  for (const [action, field, value] of actions) {
    assert.equal((await post(`/api/threads/one/${action}`)).status, 200, action);
    const count = serialized.count;
    const changed = await get();
    assert.equal(changed.body.threads[0][field], value, action);
    assert.notEqual(changed.etag, previous.etag, action);
    assert.equal(serialized.count, count + 1, action);
    const again = await get({ 'If-None-Match': changed.etag });
    assert.equal(again.status, 304, action);
    assert.equal((await get()).etag, changed.etag, action);
    assert.equal(serialized.count, count + 1, action);
    previous = changed;
  }

  // A new palette.
  assert.equal((await post('/api/palette', JSON.stringify(PALETTE), { 'X-ASB-Source-Token': 'window-token' })).status, 200);
  let count = serialized.count;
  const themed = await get({ 'If-None-Match': previous.etag });
  assert.equal(themed.status, 200);
  assert.deepEqual(themed.body.palette, PALETTE);
  assert.notEqual(themed.etag, previous.etag);
  assert.equal((await get()).etag, themed.etag);
  assert.equal(serialized.count, count + 1);

  // A change that the code makes to the cached row, with the invalidation that every such change needs.
  const [row] = (await server.dashboardForRequest()).threads;
  row.title = 'Direct';
  server.invalidateDashboard('test-in-place', { hard: false, dirty: false });
  count = serialized.count;
  const direct = await get();
  assert.equal(direct.body.threads[0].title, 'Direct');
  assert.notEqual(direct.etag, themed.etag);
  assert.equal((await get()).etag, direct.etag);
  assert.equal(serialized.count, count + 1);

  // A forced scan makes the list again, also when the content is the same as before the in-place change: the tag is then the same.
  count = serialized.count;
  const forced = await get({}, '?force=1');
  assert.equal(serialized.count, count + 1);
  assert.equal(forced.body.generatedAtMs, loads);
  assert.equal(forced.etag, themed.etag);
  assert.notEqual(forced.etag, direct.etag);
  title = 'B';
  const retitled = await get({ 'If-None-Match': forced.etag }, '?force=1');
  assert.equal(retitled.status, 200);
  assert.equal(retitled.body.threads[0].title, 'B');
  assert.equal((await get({ 'If-None-Match': retitled.etag })).status, 304);

  // A change of a source that the machine group or a peer reports: the next read scans and replies with the new list.
  title = 'C';
  server.invalidateDashboard('peer-sessions', { hard: false });
  count = serialized.count;
  const peer = await get();
  assert.equal(peer.body.threads[0].title, 'C');
  assert.notEqual(peer.etag, retitled.etag);
  assert.equal((await get()).etag, peer.etag);
  assert.equal(serialized.count, count + 1);
});

test('the session list goes gzip to a client that asks, compresses once per list, and stays the same for other clients', async (t) => {
  let title = 'Made-up 1';
  const rows = () => Array.from({ length: 200 }, (_, index) => ({ id: `row-${index}`, title: `${title} ${index}`, cwd: `/made-up/${index}` }));
  const { base } = await serve(t, { now: () => 1_760_000_000_000, loadDashboard: async () => ({ generatedAtMs: 7, providers: [], threads: rows() }) });
  const get = (headers = {}, query = '') => new Promise((resolve, reject) => {
    http.get(`${base}/api/dashboard${query}`, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const strip = ({ performance: _, ...list }) => list;
  const plain = await get();
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers.vary, undefined);
  const zipped = await get({ 'Accept-Encoding': 'gzip, deflate' });
  assert.deepEqual([zipped.status, zipped.headers['content-encoding'], zipped.headers.vary, zipped.headers.etag],
    [200, 'gzip', 'Accept-Encoding', plain.headers.etag]);
  assert.ok(zipped.body.length * 5 < plain.body.length);
  const unzipped = JSON.parse(gunzipSync(zipped.body));
  assert.deepEqual(strip(unzipped), strip(JSON.parse(plain.body)));
  // One gzip member: a browser and DecompressionStream read only the first member of a body.
  const streamed = await new Response(new Blob([zipped.body]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  assert.deepEqual(JSON.parse(streamed).threads, unzipped.threads);
  assert.equal(unzipped.performance.dashboard.compressedLists, 1);
  // The same list compresses no second time; a 304 and a refused gzip stay as they were.
  assert.equal(JSON.parse(gunzipSync((await get({ 'Accept-Encoding': 'gzip' })).body)).performance.dashboard.compressedLists, 1);
  const notModified = await get({ 'Accept-Encoding': 'gzip', 'If-None-Match': plain.headers.etag });
  assert.deepEqual([notModified.status, notModified.body.length, notModified.headers['content-encoding']], [304, 0, undefined]);
  assert.equal((await get({ 'Accept-Encoding': 'gzip;q=0, identity' })).headers['content-encoding'], undefined);
  title = 'Made-up 2';
  const changed = JSON.parse(gunzipSync((await get({ 'Accept-Encoding': 'gzip' }, '?force=1')).body));
  assert.equal(changed.threads[0].title, 'Made-up 2 0');
  assert.equal(changed.performance.dashboard.compressedLists, 2);
  // The CRC for Node.js before 20.15, as zlib computes it, also when it goes on from an earlier value.
  const [head, tail] = [Buffer.from('{"made":"up",'), Buffer.from('"tail":[1,2,3]}')];
  assert.equal(jsCrc32(tail, jsCrc32(head)), crc32(tail, crc32(head)));
});

test('a scan that returns the same object makes the list again', async (t) => {
  const board = { generatedAtMs: 1, providers: [], threads: [{ id: 'one', title: 'A' }] };
  const { base } = await serve(t, { loadDashboard: async () => board });
  const get = dashboardReader(base);
  const first = await get();
  board.threads[0].title = 'B';
  const second = await get({}, '?force=1');
  assert.equal(second.body.threads[0].title, 'B');
  assert.notEqual(second.etag, first.etag);
  assert.equal((await get({ 'If-None-Match': second.etag })).status, 304);
});

test('the session actions of the tracker change a cached row, and the next reply has the new row and tag', async (t) => {
  const serialized = { count: 0 };
  let loads = 0;
  const { base, post } = await serve(t, { pendingTracker: new PendingTracker(false), palettePath: '', now: () => 1_760_000_000_000,
    openThread: async () => ({ opened: true }),
    loadDashboard: async () => {
      loads += 1;
      return { generatedAtMs: loads, providers: [], threads: [counted(serialized, { id: 'one', provider: 'codex', state: 'idle', nativeUnread: null, completionAtMs: 0 })] };
    } }, createSwitchboardServer);
  const get = dashboardReader(base);
  let previous = await get();
  assert.equal(previous.body.threads[0].unread, false);
  // `scans`: the scans from the action to the next read. Most actions change the cached row in place and need none; Pin and Unpin
  // drop the snapshot, and Discard makes a scan before it arms.
  const actions = [['mark-unread', '{}', 0, (row) => row.unread && row.manualUnread], ['drawer-in', '{}', 0, (row) => row.drawer && !row.unread],
    ['drawer-out', '{}', 0, (row) => !row.drawer && row.unread], ['mark-read', '{}', 0, (row) => !row.unread && !row.manualUnread],
    ['mute', '{}', 0, (row) => row.muted], ['unmute', '{}', 0, (row) => !row.muted],
    ['pin', '{}', 1, (row) => row.pinned], ['unpin', '{}', 1, (row) => !row.pinned],
    ['discard-result', '{"next":true}', 1, (row) => row.discardResult], ['keep-result', '{}', 0, (row) => !row.discardResult]];
  for (const [action, body, scans, check] of actions) {
    const before = loads;
    assert.equal((await post(`/api/threads/one/${action}`, body)).status, 200, action);
    const count = serialized.count;
    const changed = await get();
    assert.ok(check(changed.body.threads[0]), action);
    assert.equal(loads - before, scans, action);
    assert.notEqual(changed.etag, previous.etag, action);
    assert.equal(serialized.count, count + 1, action);
    assert.equal((await get()).etag, changed.etag, action);
    assert.equal((await get({ 'If-None-Match': changed.etag })).status, 304, action);
    assert.equal(serialized.count, count + 1, action);
    previous = changed;
  }
});

test('malformed JSON bodies get 400 on every action route', async (t) => {
  let calls = 0;
  const count = async () => { calls += 1; return { opened: true }; };
  const { post } = await serve(t, { loadDashboard: async () => ({ providers: [], threads: [{ id: 'one' }] }),
    listSources: async () => ({ sources: [] }), updateSource: count, removeSource: count, setUnreadSettings: count,
    openThread: count, markReadThread: count });
  for (const route of ['/api/sources', '/api/sources/a/remove', '/api/settings/unread', '/api/threads/one/open', '/api/threads/one/mark-read']) {
    const response = await post(route, '{');
    assert.equal(response.status, 400, route);
    assert.equal(JSON.stringify(await response.json()).includes('JSON'), false);
  }
  assert.equal(calls, 0);
  assert.equal((await post('/api/threads/one/open', 'x'.repeat(70_000))).status, 500);
});

test('a static file that cannot be read does not stop the server', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'File modes do not stop this user from reading.' : false,
}, async (t) => {
  const publicDir = await mkdtemp(path.join(os.tmpdir(), 'asb-public-'));
  t.after(() => rm(publicDir, { recursive: true, force: true }));
  await writeFile(path.join(publicDir, 'switchboard.css'), 'body {}');
  await chmod(path.join(publicDir, 'switchboard.css'), 0o000);
  await writeFile(path.join(publicDir, 'switchboard.js'), '// ok');
  const { base } = await serve(t, { publicDir });
  await fetch(`${base}/switchboard.css`).then((response) => response.text()).catch(() => {});
  const response = await fetch(`${base}/switchboard.js`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '// ok');
});

test('ASB Bridge routes read the coverage and install with the source token', async (t) => {
  const calls = [];
  const bridgeCoverage = {
    status: async (options) => { calls.push(['status', options]); return { api: 1, expectedVersion: '1.2.0', machines: [] }; },
    install: async (body) => { calls.push(['install', body]); return { status: 202, body: { ok: true, output: 'done' } }; },
  };
  const { base, post } = await serve(t, { bridgeCoverage, sourceToken: 'token' });
  const read = await fetch(`${base}/api/bridge`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json(), { api: 1, expectedVersion: '1.2.0', machines: [] });
  assert.equal((await fetch(`${base}/api/bridge?refresh=1`)).status, 200);
  assert.equal((await fetch(`${base}/api/bridge`, { headers: { Origin: 'http://example.test' } })).status, 403);
  assert.equal((await fetch(`${base}/api/bridge`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post('/api/bridge')).status, 405);
  assert.deepEqual(calls, [['status', { force: false }], ['status', { force: true }]]);
  calls.length = 0;
  const get = await fetch(`${base}/api/bridge/install`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await fetch(`${base}/api/bridge/install`, { method: 'POST', headers: { 'x-asb-source-token': 'token' }, body: '{"all":true}' })).status, 403);
  for (const headers of [{}, { 'x-asb-source-token': 'wrong' }]) {
    const refused = await post('/api/bridge/install', '{"all":true}', headers);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'Use the current ASB source token to install ASB Bridge.' });
  }
  const invalid = await post('/api/bridge/install', '{bad', { 'x-asb-source-token': 'token' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'Invalid install request.' });
  assert.deepEqual(calls, []);
  const done = await post('/api/bridge/install', '{"sourceId":"codex"}', { 'x-asb-source-token': 'token' });
  assert.equal(done.status, 202);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await done.json(), { ok: true, output: 'done' });
  assert.deepEqual(calls, [['install', { sourceId: 'codex' }]]);
});

test('ASB Bridge routes are 404 without bridge coverage, and a failed status is 500 with a fixed text', async (t) => {
  const { base, post } = await serve(t, { sourceToken: 'token' });
  assert.equal((await fetch(`${base}/api/bridge`)).status, 404);
  assert.equal((await post('/api/bridge/install', '{"all":true}', { 'x-asb-source-token': 'token' })).status, 404);
  const failing = await serve(t, { bridgeCoverage: { status: async () => { throw new Error('/secret/path'); }, install: async () => ({}) } });
  const reply = await fetch(`${failing.base}/api/bridge`);
  assert.equal(reply.status, 500);
  assert.deepEqual(await reply.json(), { error: 'ASB cannot check ASB Bridge.' });
});

test('the switchboard server makes bridge coverage only with runBridgeCli and gives it the rows and machine', async (t) => {
  const source = { id: 'codex', provider: 'codex', enabled: true, label: 'Codex', dataDir: path.resolve('/synthetic/home/.codex') };
  const status = { codex: [], claude: { home: path.resolve('/synthetic/home/.claude') }, claudeHomes: [],
    opencode: { plugin: 'missing', expectedVersion: '1.2.0', liveReceiverSessions: [] }, liveReceiverSessions: ['r1'], versions: {} };
  const calls = [];
  const options = { pendingTracker: new PendingTracker(false), palettePath: '', sourceRegistry: { read: async () => [source] },
    machineIdentity: () => ({ machineId: 'm1', machineName: 'Desk' }),
    loadDashboard: async () => ({ providers: [], threads: [{ id: 'r1', provider: 'codex', sourceId: 'codex', state: 'idle' }] }) };
  const { base } = await serve(t, { ...options, runBridgeCli: async (args, opts) => { calls.push([args, opts]); return { code: 0, stdout: JSON.stringify(status), stderr: '' }; } },
    createSwitchboardServer);
  const reply = await (await fetch(`${base}/api/bridge`)).json();
  assert.deepEqual(calls, [[['status', '--json'], { timeoutMs: 30_000, env: {} }]]);
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(reply.expectedVersion, '1.2.0');
  assert.deepEqual([reply.machines[0].machineId, reply.machines[0].name, reply.machines[0].asbVersion, reply.machines[0].state], ['m1', 'Desk', version, 'ok']);
  assert.deepEqual(reply.machines[0].apps.map((app) => [app.sourceId, app.state, app.live]), [['codex', 'missing', 1]]);
  const plain = await serve(t, options, createSwitchboardServer);
  assert.equal((await fetch(`${plain.base}/api/bridge`)).status, 404);
});

test('a failed ASB Bridge install is 500 with a fixed text', async (t) => {
  const { post } = await serve(t, { sourceToken: 'token',
    bridgeCoverage: { status: async () => ({}), install: async () => { throw new Error('/secret/path'); } } });
  const reply = await post('/api/bridge/install', '{"all":true}', { 'x-asb-source-token': 'token' });
  assert.equal(reply.status, 500);
  assert.deepEqual(await reply.json(), { error: 'ASB cannot install ASB Bridge.' });
});

test('server.bridgeReport gives the member report with runBridgeCli, and 404 without it', async (t) => {
  const status = { codex: [], claude: { home: path.resolve('/synthetic/home/.claude') }, claudeHomes: [],
    opencode: { plugin: 'missing', expectedVersion: '1.2.0', liveReceiverSessions: [] }, liveReceiverSessions: [], versions: {} };
  const source = { id: 'opencode', provider: 'opencode', enabled: true, label: 'OpenCode', dataDir: path.resolve('/synthetic/home/.local/share/opencode') };
  const options = { pendingTracker: new PendingTracker(false), palettePath: '', sourceRegistry: { read: async () => [source] } };
  const { server } = await serve(t, { ...options, runBridgeCli: async () => ({ code: 0, stdout: JSON.stringify(status), stderr: '' }) }, createSwitchboardServer);
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const reply = await server.bridgeReport();
  assert.deepEqual(reply, { status: 200, body: { api: 1, asbVersion: version, checkedAtMs: reply.body.checkedAtMs, expectedVersion: '1.2.0',
    apps: [{ sourceId: 'opencode', label: 'OpenCode', provider: 'opencode', state: 'missing', version: null, live: 0, command: 'asb bridge install --opencode' }] } });
  const plain = await serve(t, options, createSwitchboardServer);
  assert.deepEqual(await plain.server.bridgeReport(), { status: 404, body: { error: 'Route is not available.' } });
});

test('the panel is a local GET route with a no-store summary of the shared dashboard', async (t) => {
  const dashboard = { providers: [], threads: [{ id: 'alpha', title: 'Alpha', pending: true, state: 'working', updatedAtMs: 12 }] };
  const machines = [{ machineId: 'alpha', name: 'Alpha', self: true, online: true }];
  let loads = 0, machineReads = 0;
  const { base, post } = await serve(t, { now: () => 100,
    loadDashboard: async () => { loads += 1; return dashboard; },
    panelMachines: async () => { machineReads += 1; return machines; } });
  await fetch(`${base}/api/dashboard`);
  for (const headers of [{}, { Origin: base, 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
    const response = await fetch(`${base}/api/panel?force=1`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await response.text(), JSON.stringify({ ...panelSummary(dashboard, machines), accent: '' }));
  }
  assert.equal(loads, 1);
  // Three reads and the panel tag of the first scan's event.
  assert.equal(machineReads, 4);
  const wrongMethod = await post('/api/panel');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  for (const headers of [{ Host: 'example.test' }, { Origin: 'http://example.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await new Promise((resolve, reject) => {
      http.get(`${base}/api/panel`, { headers }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: headers.Host ? 'Use the local ASB address.' : 'Use the local ASB API.' });
  }
});

test('each dashboard event carries the panel tag, which changes exactly when the panel reply changes', async (t) => {
  const paletteDir = await mkdtemp(path.join(os.tmpdir(), 'asb-panel-tag-'));
  t.after(() => rm(paletteDir, { recursive: true, force: true }));
  const machines = [{ machineId: 'alpha', name: 'Alpha', self: true, online: true }];
  const { server, base, post } = await serve(t, { now: () => 100, sourceToken: 'window-token', palettePath: path.join(paletteDir, 'palette.json'),
    loadDashboard: async () => ({ providers: [], threads: [{ id: 'alpha', title: 'Alpha', pending: true, state: 'working', updatedAtMs: 12 }] }),
    panelMachines: async () => machines });
  let text = '';
  const stream = http.get(`${base}/api/events`, (response) => response.on('data', (chunk) => { text += chunk; }));
  stream.on('error', () => {});
  t.after(() => stream.destroy());
  const tags = () => [...text.matchAll(/event: dashboard\ndata: (.+)\n/g)].map((match) => JSON.parse(match[1]).panel);
  const next = async (change) => {
    const count = tags().length;
    await change();
    for (let attempt = 0; attempt < 500 && tags().length === count; attempt += 1) await delay(2);
    assert.equal(tags().length, count + 1);
    const panel = await (await fetch(`${base}/api/panel`)).text();
    assert.equal(tags().at(-1), createHash('sha256').update(panel).digest('base64url').slice(0, 16));
    return tags().at(-1);
  };
  await fetch(`${base}/api/dashboard`);
  const first = await next(() => server.invalidateDashboard('made-up', { hard: false, dirty: false }));
  assert.match(first, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(await next(() => server.invalidateDashboard('made-up', { hard: false, dirty: false })), first);
  // A count changes.
  const counted = await next(async () => {
    (await server.dashboardForRequest()).threads[0].pending = false;
    server.invalidateDashboard('made-up', { hard: false, dirty: false });
  });
  assert.notEqual(counted, first);
  // The accent changes.
  const accented = await next(() => post('/api/palette', JSON.stringify(PALETTE), { 'X-ASB-Source-Token': 'window-token' }));
  assert.notEqual(accented, counted);
});

test('the panel is unavailable without panelMachines and hides dashboard and machine read failures', async (t) => {
  const plain = await serve(t, {});
  const missing = await fetch(`${plain.base}/api/panel`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Route is not available in ASB.' });
  const fail = async () => { throw new Error('synthetic failure'); };
  for (const options of [{ panelMachines: fail }, { panelMachines: async () => [], loadDashboard: fail }]) {
    const { base } = await serve(t, options);
    const response = await fetch(`${base}/api/panel`);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'ASB cannot read the sessions.' });
  }
});

test('the switchboard panel lists this machine first and sorts members by lowercase name and machine ID', async (t) => {
  const members = [
    { machineId: 'bravo', name: 'bravo', online: true },
    { machineId: 'charlie', name: 'Alpha', online: 1 },
    { machineId: 'alpha', name: 'alpha', online: false },
    { machineId: 'self', name: 'Self', isSelf: true, online: false },
  ];
  const group = { status: async () => ({ members }), merge: () => {} };
  const unavailable = { status: async () => { throw new Error('synthetic failure'); }, merge: () => {} };
  for (const machineGroup of [group, unavailable, null]) {
    const { base } = await serve(t, { pendingTracker: new PendingTracker(false), palettePath: '', machineGroup,
      activityUsage: {}, machineIdentity: () => ({ machineId: 'self', machineName: 'Self' }),
      loadDashboard: async () => ({ providers: [], threads: [
        { id: 'local', machineId: 'self', state: 'idle' },
        { id: 'remote', machineId: 'charlie', state: 'idle', remote: true },
      ] }) }, createSwitchboardServer);
    const response = await fetch(`${base}/api/panel`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const expected = [{ name: 'Self', self: true, online: true, total: 1, needs: 0, working: 0 }];
    if (machineGroup === group) expected.push(
      { name: 'alpha', self: false, online: false, total: 0, needs: 0, working: 0 },
      { name: 'Alpha', self: false, online: false, total: 1, needs: 0, working: 0 },
      { name: 'bravo', self: false, online: true, total: 0, needs: 0, working: 0 });
    assert.deepEqual(body.machines, expected);
  }
});

test('the panel appends the current saved accent on every read', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-panel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const palettePath = path.join(dir, 'palette.json');
  await writeFile(palettePath, JSON.stringify(PALETTE));
  const { base, post } = await serve(t, { palettePath, panelMachines: async () => [] });
  const first = await (await fetch(`${base}/api/panel`)).text();
  assert.equal(first, JSON.stringify({ ...panelSummary({ threads: [] }, []), accent: '#3584e4' }));
  const changed = { ...PALETTE, colors: { ...PALETTE.colors, accent: '#ABCDEF' } };
  assert.equal((await post('/api/palette', JSON.stringify(changed))).status, 200);
  const second = await (await fetch(`${base}/api/panel`)).text();
  assert.equal(second, JSON.stringify({ ...panelSummary({ threads: [] }, []), accent: '#abcdef' }));
});
