import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppSourceRegistry, appSourcesRevision } from '../src/app-sources.mjs';
import { createAsbServer } from '../src/asb-server.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';

const clientId = '123e4567-e89b-12d3-a456-426614174000';
const report = { clientId, sourcesRevision: 'a'.repeat(64), profilesRevision: null, profilesVisible: false, dirty: false };
async function serve(t, { switchboard = false, ...options } = {}) {
  const server = (switchboard ? createSwitchboardServer : createAsbServer)({ sourceToken: 'window-token',
    pendingStatePath: false, dashboardWatchPaths: [], loadDashboard: async () => ({ providers: [], threads: [] }), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', body = {}, token = 'window-token', origin = base, headers = {} } = {}) => new Promise((resolve, reject) => {
    const client = http.request(`${base}${route}`, { method, agent: false,
      headers: { ...(token ? { 'x-asb-source-token': token } : {}), ...(method === 'POST' && origin !== null ? { origin } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: new Headers(response.headers), text,
          json: () => JSON.parse(text) });
      });
    });
    client.on('error', reject);
    client.end(method === 'POST' ? typeof body === 'string' ? body : JSON.stringify(body) : undefined);
  });
  return { request, base };
}

async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-agent-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const registry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  return { homeDir, registry };
}

test('agent status returns saved and cached revisions separately with runtime metadata and no token', async (t) => {
  const { registry } = await fixture(t);
  const sources = await registry.read();
  let loads = 0;
  const { request } = await serve(t, { switchboard: true, sourceRegistry: registry,
    loadDashboard: async ({ sources: loaded }) => { loads += 1; return { providers: [], threads: [], labels: loaded.map((source) => source.label) }; } });
  const initial = await request('/api/agent/status');
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const status = initial.json();
  const rootDir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  assert.deepEqual(status, { apiVersion: 1, pid: process.pid, mode: 'desktop',
    appVersion: JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).version,
    rootDir, sourcesPath: registry.configPath, sourcesRevision: appSourcesRevision(sources), backendRevision: null, ui: { clients: [] } });
  assert.equal(initial.text.includes('window-token'), false);
  assert.equal(loads, 0);
  const dashboard = (await request('/api/dashboard')).json();
  assert.equal(dashboard.sourcesRevision, status.sourcesRevision);
  const { builtin, ...edit } = sources[0];
  await registry.update({ ...edit, label: 'Changed profile' });
  const changed = (await request('/api/agent/status')).json();
  assert.notEqual(changed.sourcesRevision, status.sourcesRevision);
  assert.equal(changed.backendRevision, status.sourcesRevision);
  assert.equal(loads, 1);
  const fresh = (await request('/api/dashboard?force=1')).json();
  assert.equal(fresh.sourcesRevision, changed.sourcesRevision);
  assert.equal(fresh.labels[0], 'Changed profile');
  assert.equal((await request('/api/agent/status')).json().backendRevision, fresh.sourcesRevision);
});

test('a dashboard revision describes the source settings received by its scan', async (t) => {
  const { registry } = await fixture(t);
  const sources = await registry.read();
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { request } = await serve(t, { switchboard: true, sourceRegistry: registry,
    loadDashboard: async ({ sources: loaded }) => { started.resolve(); await gate.promise; return { providers: [], threads: [], label: loaded[0].label }; } });
  const pending = request('/api/dashboard');
  await started.promise;
  const { builtin, ...edit } = sources[0];
  await registry.update({ ...edit, label: 'New profile' });
  gate.resolve();
  const dashboard = (await pending).json();
  assert.equal(dashboard.label, sources[0].label);
  assert.equal(dashboard.sourcesRevision, appSourcesRevision(sources));
  assert.notEqual(dashboard.sourcesRevision, appSourcesRevision(await registry.read()));
});

test('agent routes require a configured nonempty token and the correct request token', async (t) => {
  for (const sourceToken of ['window-token', '']) {
    const { request } = await serve(t, { sourceToken });
    for (const [route, method] of [['/api/agent/status', 'GET'], ['/api/agent/ui', 'POST']]) {
      for (const token of ['', 'window-tokem', 'window-token-long']) {
        assert.equal((await request(route, { method, token, body: report })).status, 403);
      }
      assert.equal((await request(route, { method, body: report })).status, sourceToken ? 200 : 403);
    }
  }
});

test('agent routes enforce local Host, Origin, fetch-site and exact methods', async (t) => {
  const { request, base } = await serve(t);
  for (const [route, method] of [['/api/agent/status', 'GET'], ['/api/agent/ui', 'POST']]) {
    for (const headers of [{ host: 'example.invalid' }, { origin: 'https://example.invalid' },
      { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await request(route, { method, body: report, headers })).status, 403);
    }
    const response = await request(route, { method: method === 'GET' ? 'POST' : 'GET' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), method);
  }
  for (const headers of [{}, { origin: base }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
    assert.equal((await request('/api/agent/status', { headers })).status, 200);
  }
  for (const extra of [{ origin: null }, { headers: { 'sec-fetch-site': 'none' } }]) {
    assert.equal((await request('/api/agent/ui', { method: 'POST', body: report, ...extra })).status, 403);
  }
});

test('UI reports reject unknown fields, invalid values, malformed JSON and large bodies', async (t) => {
  const { request } = await serve(t);
  const invalid = ['{', 'null', '[]', 'false', '{}', ...[
    { clientId: 'not-a-uuid' }, { clientId: null }, { sourcesRevision: 'old' }, { sourcesRevision: 1 },
    { sourcesRevision: 'A'.repeat(64) }, { profilesRevision: '' }, { profilesRevision: [] },
    { profilesVisible: 1 }, { dirty: 'true' }, { extra: true },
  ].map((change) => ({ ...report, ...change }))];
  for (const body of invalid) {
    const response = await request('/api/agent/ui', { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(response.json(), { error: 'Invalid ASB UI report.' });
  }
  assert.equal((await request('/api/agent/ui', { method: 'POST', body: ' '.repeat(64 * 1024 + 1) })).status, 413);
  assert.deepEqual((await request('/api/agent/status')).json().ui.clients, []);
});

test('UI reports replace each client, retain at most 16 recent clients, and expire at 45 seconds', async (t) => {
  let clock = 10_000;
  const { request } = await serve(t, { now: () => clock });
  const post = (body) => request('/api/agent/ui', { method: 'POST', body });
  assert.deepEqual((await post(report)).json(), { received: true, reportedAtMs: clock });
  clock += 1;
  const changed = { ...report, sourcesRevision: null, profilesRevision: 'b'.repeat(64), profilesVisible: true, dirty: true };
  await post(changed);
  assert.deepEqual((await request('/api/agent/status')).json().ui.clients, [{ ...changed, reportedAtMs: clock }]);
  for (let index = 1; index <= 16; index += 1) {
    clock += 1;
    await post({ ...report, clientId: `123e4567-e89b-12d3-a456-${String(index).padStart(12, '0')}` });
  }
  let clients = (await request('/api/agent/status')).json().ui.clients;
  assert.equal(clients.length, 16);
  assert.equal(clients.some((client) => client.clientId === clientId), false);
  clock += 44_999;
  clients = (await request('/api/agent/status')).json().ui.clients;
  assert.equal(clients.length, 1);
  clock += 1;
  assert.deepEqual((await request('/api/agent/status')).json().ui.clients, []);
});

test('agent status reports service mode and hides internal state errors', async (t) => {
  const { request } = await serve(t, { serviceMode: true, readSourcesRevision: async () => { throw new Error('private token'); } });
  const failed = await request('/api/agent/status');
  assert.equal(failed.status, 500);
  assert.equal(failed.text.includes('private token'), false);
  const service = await serve(t, { serviceMode: true });
  assert.equal((await service.request('/api/agent/status')).json().mode, 'service');
});

test('source API writes support quoted revisions, preserve stale edits and removals, and retain legacy writes', async (t) => {
  const { registry, homeDir } = await fixture(t);
  const { request } = await serve(t, { switchboard: true, sourceRegistry: registry });
  const initial = (await request('/api/sources')).json();
  const { builtin, sessionCount, status, message, sourceNumber, sourceCount, ...source } = initial.sources[0];
  const post = (route, body, match) => request(route, { method: 'POST', body, headers: match === undefined ? {} : { 'if-match': match } });
  for (const match of [initial.revision, '*', `W/"${initial.revision}"`, `"${initial.revision}", "${initial.revision}"`, '"old"']) {
    assert.equal((await post('/api/sources', { source }, match)).status, 400);
  }
  const changed = await post('/api/sources', { source: { ...source, label: 'Saved label', showMarker: false } }, `"${initial.revision}"`);
  assert.equal(changed.status, 200);
  const current = changed.json();
  assert.notEqual(current.revision, initial.revision);
  const saved = await readFile(registry.configPath, 'utf8');
  const stale = await post('/api/sources', { source: { ...source, label: 'Stale label' } }, `"${initial.revision}"`);
  assert.equal(stale.status, 409);
  assert.match(stale.json().error, /Reload Profiles/);
  assert.equal(await readFile(registry.configPath, 'utf8'), saved);
  assert.equal((await post('/api/sources/codex/remove', {}, `"${current.revision}"`)).status, 400);
  const launcher = path.join(homeDir, 'codex-extra');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const added = await post('/api/sources', { source: { provider: 'codex', label: 'Extra', dataDir: path.join(homeDir, 'extra'), launcher, enabled: true } });
  assert.equal(added.status, 200);
  const extra = added.json();
  const id = extra.sources.at(-1).id;
  const beforeRemove = await readFile(registry.configPath, 'utf8');
  assert.equal((await post(`/api/sources/${id}/remove`, {}, `"${current.revision}"`)).status, 409);
  assert.equal(await readFile(registry.configPath, 'utf8'), beforeRemove);
  assert.equal((await post(`/api/sources/${id}/remove`, {}, `"${extra.revision}"`)).status, 200);
  assert.equal((await post('/api/sources', { source: { ...source, label: 'Legacy edit' } })).status, 200);
  assert.equal((await registry.read())[0].label, 'Legacy edit');
  assert.equal((await registry.read())[0].showMarker, true);
});
