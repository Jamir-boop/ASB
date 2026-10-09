import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAsbServer } from '../src/asb-server.mjs';
import { DashboardSnapshot } from '../src/dashboard-snapshot.mjs';

async function serve(t, options) {
  const server = createAsbServer({ dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, post: (route, body = '{}', headers = {}) => fetch(base + route, { method: 'POST', headers: { Origin: base, ...headers }, body }) };
}

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
