import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

// Synthetic sources, models, and machines only. Tests never use the network.
const HOUR = 3_600_000;
const TOKEN = 'd'.repeat(64);
const self = { machineId: 'a'.repeat(16), machineName: 'engine-a' };
const hourMs = Math.floor(Date.now() / HOUR) * HOUR - HOUR;

async function setup(t, extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-usage-routes-'));
  const projects = path.join(home, '.claude', 'projects');
  await mkdir(path.join(projects, 'project'), { recursive: true });
  await writeFile(path.join(projects, 'project', 'a.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: new Date(hourMs + 60_000).toISOString(),
    requestId: 'r-1', message: { id: 'm-1', model: 'claude-test-5', content: [],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 7 } } })}\n`);
  const sources = [{ id: 'claude-desktop-code', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(home, 'claude-app'), projectsDir: projects }];
  const fetches = [];
  const server = createSwitchboardServer({ pendingTracker: new PendingTracker(false), palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: { read: async () => sources }, loadDashboard: async () => ({ providers: [], threads: [] }), sourceToken: TOKEN,
    machineIdentity: () => self, usageFetch: async (url) => { fetches.push(url); throw new Error('offline'); },
    usageCacheDir: path.join(home, '.cache', 'asb'), usageHomeDir: home, usageLedgerFile: path.join(home, '.config', 'asb', 'usage', 'usage-ledger.json'), ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // One cleanup: the ledger stops before its folder goes.
  t.after(async () => {
    await server.usageLedger.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, { method = 'GET', body, token = TOKEN } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { origin: base, ...(token ? { 'X-ASB-Source-Token': token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body });
    return { status: response.status, cache: response.headers.get('cache-control'), json: await response.json() };
  };
  return { base, call, fetches };
}

const document = (machines) => JSON.stringify({ format: 'asb-usage-export', version: 1, exportedAtMs: Date.now(), machines });

test('the usage export and import routes need the source token, and export then import round-trips', async (t) => {
  const { call, fetches } = await setup(t);
  for (const [route, method, error] of [['/api/usage/export', 'GET', 'Use the current ASB source token to export usage.'],
    ['/api/usage/import', 'POST', 'Use the current ASB source token to import usage.']]) {
    for (const token of ['', 'e'.repeat(64)]) {
      const reply = await call(route, { method, token, ...(method === 'POST' ? { body: document([]) } : {}) });
      assert.deepEqual([reply.status, reply.json], [403, { error }], `${route} ${token}`);
    }
  }
  const exported = await call('/api/usage/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.cache, 'no-store');
  assert.deepEqual(exported.json.machines, [{ machineId: self.machineId, name: 'engine-a', records: [[hourMs, 'claude', 'claude-test-5', 10, 1000, 50, 7]] }]);
  const imported = await call('/api/usage/import', { method: 'POST', body: document([{ machineId: 'c'.repeat(16), name: 'retired',
    records: [[hourMs, 'codex', 'gpt-test-1', 1, 2, 3, 4], [hourMs, 'codex', 'gpt-test-1', 1, 2, 3, 5]] }]) });
  assert.deepEqual([imported.status, imported.cache, imported.json], [200, 'no-store', { machines: [{ machineId: 'c'.repeat(16), name: 'retired', hours: 1 }] }]);
  assert.deepEqual((await call('/api/usage/export')).json.machines.map((machine) => machine.name), ['engine-a', 'retired']);
  assert.equal(fetches.length, 0);
});

test('a bad import file gives 400, a large one 413, and a server without the ledger has no routes', async (t) => {
  const { base, call } = await setup(t, { maxUsageImportBytes: 1024 });
  // The read route takes GET only, and the action route POST only.
  for (const [route, method, allow] of [['/api/usage/export', 'POST', 'GET'], ['/api/usage/import', 'GET', 'POST']]) {
    const response = await fetch(`${base}${route}`, { method, headers: { origin: base, 'X-ASB-Source-Token': TOKEN } });
    assert.deepEqual([response.status, response.headers.get('allow')], [405, allow], route);
  }
  const bad = { error: 'This file is not an ASB usage export.' };
  for (const body of ['{', '[]', document([]), document([{ machineId: 'c'.repeat(16), name: 'retired', records: [[hourMs + 1, 'codex', 'm', 1, 1, 1, 1]] }]),
    document([{ machineId: 'C'.repeat(16), name: 'retired', records: [] }]), JSON.stringify({ format: 'asb-usage-export', version: 2, exportedAtMs: 1, machines: [] })]) {
    const reply = await call('/api/usage/import', { method: 'POST', body });
    assert.deepEqual([reply.status, reply.json], [400, bad], body);
  }
  const large = await call('/api/usage/import', { method: 'POST', body: document([{ machineId: 'c'.repeat(16), name: 'retired',
    records: Array.from({ length: 40 }, () => [hourMs, 'codex', 'gpt-test-1', 1, 2, 3, 4]) }]) });
  assert.deepEqual([large.status, large.json], [413, { error: 'The file is too large for an ASB usage export.' }]);

  const off = await setup(t, { usageLedgerFile: '' });
  for (const [route, method] of [['/api/usage/export', 'GET'], ['/api/usage/import', 'POST']]) {
    const reply = await off.call(route, { method, ...(method === 'POST' ? { body: document([]) } : {}) });
    assert.deepEqual([reply.status, reply.json], [404, { error: 'Route is not available in ASB.' }], route);
  }
});

test('export without a machine ID gives 409 with its message', async (t) => {
  const { call } = await setup(t, { machineIdentity: () => ({ machineId: '', machineName: 'engine-a' }) });
  const reply = await call('/api/usage/export');
  assert.deepEqual([reply.status, reply.json], [409, { error: 'ASB has no machine ID yet. Start ASB again.' }]);
});
