import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { processStart } from '../src/claude-registry.mjs';
import { AppSourceRegistry, appSourcesRevision } from '../src/app-sources.mjs';
import { createAsbServer } from '../src/asb-server.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';

const sqlite = await import('node:sqlite').catch(() => null);

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
  const { builtin, name, sessionCount, status, message, sourceNumber, sourceCount, ...source } = initial.sources[0];
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

const RESOLVE = '/api/agent/resolve-session';
const MACHINE_ID = '0123456789abcdef';
const SESSION = '11111111-1111-4111-8111-111111111111';

test('the resolve route is a token-only POST action with exact Host, Origin, and fetch site', async (t) => {
  const calls = [];
  const actions = [];
  const spy = (name) => async () => { actions.push(name); };
  const { request } = await serve(t, { resolveSession: async (body, dashboard) => { calls.push({ body, threads: dashboard.threads.length });
    return { apiVersion: 1, ok: true, form: 'short', identity: null, display: null, location: null, availability: 'not-found' }; },
  markUnreadThread: spy('mark-unread'), markReadThread: spy('mark-read'), pinThread: spy('pin'), discardThread: spy('discard'),
  drawerThread: spy('drawer'), muteThread: spy('mute'), updateSource: spy('update'), removeSource: spy('remove'), onStop: spy('stop'),
  openThreadInCodex: spy('open'), openThreadInClaude: spy('open') });
  const body = { reference: `codex/${SESSION}` };
  for (const token of ['', 'window-tokem']) assert.equal((await request(RESOLVE, { method: 'POST', token, body })).status, 403);
  for (const headers of [{ host: 'example.invalid' }, { host: '127.0.0.1' }, { origin: 'https://example.invalid' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }]) {
    assert.equal((await request(RESOLVE, { method: 'POST', body, headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await request(RESOLVE, { method: 'POST', body, origin: null })).status, 403);
  const get = await request(RESOLVE);
  assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST']);
  for (const invalid of ['{', 'null', '[]', '"x"', '{}', { reference: 1 }, { reference: null }, { reference: 'x', extra: 1 },
    { reference: 'x', sourceId: 'Bad' }, { reference: 'x', sourceId: 1 }, { reference: 'x', sourceId: '' }, { sourceId: 'codex' },
    { reference: 'x', sourceId: 'a'.repeat(81) }]) {
    const response = await request(RESOLVE, { method: 'POST', body: invalid });
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.deepEqual(response.json(), { error: 'Invalid resolve request.' });
  }
  assert.equal((await request(RESOLVE, { method: 'POST', body: { reference: 'x'.repeat(8 * 1024) } })).status, 413);
  assert.deepEqual(calls, []);
  const reply = await request(RESOLVE, { method: 'POST', body });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.equal(reply.json().availability, 'not-found');
  await request(RESOLVE, { method: 'POST', body: { ...body, sourceId: 'work-2' }, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual(calls, [{ body, threads: 0 }, { body: { ...body, sourceId: 'work-2' }, threads: 0 }]);
  assert.deepEqual(actions, []);
  // A server with no resolver has no route; a server with no configured token refuses it.
  assert.equal((await (await serve(t)).request(RESOLVE, { method: 'POST', body })).status, 404);
  const open = await serve(t, { sourceToken: '', resolveSession: async () => { throw new Error('must not run'); } });
  assert.equal((await open.request(RESOLVE, { method: 'POST', body })).status, 403);
});

test('the engine resolves a full reference from its cached rows and writes no state', async (t) => {
  const { homeDir, registry } = await fixture(t);
  const pendingStatePath = path.join(homeDir, 'pending.json');
  const tag = () => 'ab'.repeat(16);
  let loads = 0;
  const { request } = await serve(t, { switchboard: true, sourceRegistry: registry, pendingStatePath,
    machineIdentity: () => ({ machineId: MACHINE_ID, machineName: 'synthetic-pc' }), referenceScopes: () => tag,
    machineGroup: { status: async () => ({ members: [{ machineId: MACHINE_ID, name: 'synthetic-pc', online: true, isSelf: true }] }), merge: () => {} },
    loadDashboard: async () => { loads += 1; return { providers: [], threads: [{ id: SESSION, externalId: SESSION, provider: 'codex',
      providerLabel: 'Codex', surface: 'app', sourceId: 'codex', sourceName: 'codex', state: 'idle', title: 'Secret title',
      cwd: '/synthetic/private' }] }; } });
  const board = (await request('/api/dashboard')).json();
  const reference = board.threads[0].reference;
  assert.equal(reference, `asb:1/${MACHINE_ID}/codex/${'ab'.repeat(16)}/codex:${SESSION}`);
  const before = await readFile(pendingStatePath, 'utf8').catch((error) => error.code);
  const reply = await request(RESOLVE, { method: 'POST', body: { reference } });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json(), { apiVersion: 1, ok: true, form: 'full',
    identity: { reference, machineId: MACHINE_ID, sourceId: 'codex', scopeTag: 'ab'.repeat(16), type: 'codex', appId: SESSION },
    display: { machineName: 'synthetic-pc', sourceName: 'codex', providerLabel: 'Codex' }, location: 'local', availability: 'found' });
  assert.equal(reply.text.includes('Secret title') || reply.text.includes('/synthetic/'), false);
  const short = (await request(RESOLVE, { method: 'POST', body: { reference: `codex/${SESSION}`, sourceId: 'codex' } })).json();
  assert.deepEqual([short.form, short.availability, short.identity.reference], ['short', 'found', reference]);
  const failed = await request(RESOLVE, { method: 'POST', body: { reference, sourceId: 'opencode' } });
  assert.deepEqual([failed.status, failed.json().ok, failed.json().code], [200, false, 'scope-mismatch']);
  assert.equal(loads, 1, 'the resolver uses the cached dashboard');
  assert.equal(await readFile(pendingStatePath, 'utf8').catch((error) => error.code), before);
});

const BOUND = '/api/agent/resolve-bound';
const CALLER = '55555555-5555-4555-8555-555555555555';
const MSG = '66666666-6666-4666-8666-666666666666';
const boundBody = (fields = {}) => ({ reference: `asb:1/${MACHINE_ID}/codex/${'ab'.repeat(16)}/codex:${SESSION}`,
  caller: { runtimeSessionId: CALLER, configDir: '/synthetic/claude' }, msgId: MSG, remainingMs: 10_000, ...fields });

test('the resolve-bound route is a token-only POST action with an exact body', async (t) => {
  const calls = [];
  const { request } = await serve(t, { resolveBound: async (body, dashboard) => { calls.push({ body, threads: dashboard.threads.length });
    return { apiVersion: 1, ok: false, code: 'not-live', message: 'The target session has no live receiver now.' }; } });
  const body = boundBody();
  for (const token of ['', 'window-tokem']) assert.equal((await request(BOUND, { method: 'POST', token, body })).status, 403);
  for (const headers of [{ host: 'example.invalid' }, { origin: 'https://example.invalid' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' }]) {
    assert.equal((await request(BOUND, { method: 'POST', body, headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await request(BOUND, { method: 'POST', body, origin: null })).status, 403);
  const get = await request(BOUND);
  assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST']);
  const caller = body.caller;
  for (const invalid of ['{', 'null', '[]', '{}', { ...body, extra: 1 }, { reference: body.reference, caller, msgId: MSG },
    { ...body, reference: 1 }, { ...body, caller: null }, { ...body, caller: [] }, { ...body, caller: { ...caller, extra: 1 } },
    { ...body, caller: { configDir: caller.configDir } }, { ...body, caller: { ...caller, runtimeSessionId: 'x' } },
    { ...body, caller: { ...caller, configDir: 'relative/dir' } }, { ...body, caller: { ...caller, configDir: 7 } },
    { ...body, caller: { ...caller, configDir: `/${'x'.repeat(4096)}` } }, { ...body, msgId: 'x' }, { ...body, msgId: null },
    { ...body, remainingMs: -1 }, { ...body, remainingMs: 20_001 }, { ...body, remainingMs: 1.5 }, { ...body, remainingMs: '10' }]) {
    const response = await request(BOUND, { method: 'POST', body: invalid });
    assert.equal(response.status, 400, JSON.stringify(invalid).slice(0, 200));
    assert.deepEqual(response.json(), { error: 'Invalid resolve request.' });
  }
  assert.equal((await request(BOUND, { method: 'POST', body: { ...body, reference: 'x'.repeat(8 * 1024) } })).status, 413);
  assert.deepEqual(calls, []);
  for (const remainingMs of [0, 20_000]) {
    const reply = await request(BOUND, { method: 'POST', body: { ...body, remainingMs } });
    assert.deepEqual([reply.status, reply.headers.get('cache-control'), reply.json().code], [200, 'no-store', 'not-live']);
  }
  assert.deepEqual(calls, [{ body: { ...body, remainingMs: 0 }, threads: 0 }, { body: { ...body, remainingMs: 20_000 }, threads: 0 }]);
  const failing = await serve(t, { resolveBound: async () => { throw new Error('/synthetic/secret'); } });
  const error = await failing.request(BOUND, { method: 'POST', body });
  assert.deepEqual([error.status, error.headers.get('cache-control'), error.json()], [500, 'no-store', { error: 'Cannot resolve the session reference.' }]);
  // A server with no binder has no route; a server with no configured token refuses it.
  assert.equal((await (await serve(t)).request(BOUND, { method: 'POST', body })).status, 404);
  const open = await serve(t, { sourceToken: '', resolveBound: async () => { throw new Error('must not run'); } });
  assert.equal((await open.request(BOUND, { method: 'POST', body })).status, 403);
});

test('the engine binds a live local codex or CLI target from a private registry and writes no state', {
  skip: process.platform !== 'linux' || !sqlite ? 'needs Linux and node:sqlite' : false }, async (t) => {
  const { homeDir, registry } = await fixture(t);
  const pendingStatePath = path.join(homeDir, 'pending.json');
  const CLI = '77777777-7777-4777-8777-777777777777';
  const sessions = path.join(homeDir, '.claude', 'sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const children = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
  t.after(() => { for (const child of children) child.kill(); });
  const [codexChild, cliChild] = children;
  const starts = [];
  for (const pid of [process.pid, codexChild.pid, cliChild.pid]) {
    let start = null;
    for (let tries = 0; start === null && tries < 100; tries += 1) { start = await processStart(pid); if (start === null) await new Promise((resolve) => setTimeout(resolve, 10)); }
    starts.push(start);
  }
  const write = (pid, fields) => writeFile(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, name: 'Secret name', cwd: '/synthetic/private',
    peerProtocol: 1, messagingSocketPath: `/synthetic/s/${pid}.sock`, ...fields }), { mode: 0o600 });
  await write(process.pid, { sessionId: CALLER, procStart: starts[0], entrypoint: 'codex-asb-bridge' });
  await write(codexChild.pid, { sessionId: SESSION, procStart: starts[1], entrypoint: 'codex-asb-bridge' });
  await write(cliChild.pid, { sessionId: CLI, procStart: starts[2], entrypoint: 'cli' });
  const stateDir = path.join(homeDir, '.codex', 'plugin-state', 'asb-bridge');
  await mkdir(stateDir, { recursive: true });
  const database = new sqlite.DatabaseSync(path.join(stateDir, `${SESSION}.sqlite`));
  database.exec('CREATE TABLE receiver (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, proc_start TEXT NOT NULL)');
  database.prepare('INSERT INTO receiver VALUES (1, ?, ?)').run(codexChild.pid, starts[1]);
  database.close();
  const { request } = await serve(t, { switchboard: true, sourceRegistry: registry, pendingStatePath,
    machineIdentity: () => ({ machineId: MACHINE_ID, machineName: 'synthetic-pc' }), referenceScopes: () => () => 'ab'.repeat(16),
    machineGroup: { status: async () => ({ members: [{ machineId: MACHINE_ID, name: 'synthetic-pc', online: true, isSelf: true }] }), merge: () => {} },
    loadDashboard: async () => ({ providers: [], threads: [
      { id: SESSION, externalId: SESSION, provider: 'codex', providerLabel: 'Codex', surface: 'app', sourceId: 'codex', sourceName: 'codex', state: 'idle', title: 'Secret title' },
      { id: `cli:${CLI}`, externalId: CLI, provider: 'claude-desktop-code', providerLabel: 'Claude Code CLI', surface: 'cli', sourceId: 'claude-desktop-code',
        sourceName: 'claude-desktop-code', state: 'idle', title: 'Secret title' }] }) });
  const references = (await request('/api/dashboard')).json().threads.map((row) => row.reference);
  assert.equal(references.length, 2);
  const before = await readFile(pendingStatePath, 'utf8').catch((error) => error.code);
  const bind = async (reference) => {
    const reply = await request(BOUND, { method: 'POST', body: boundBody({ reference, caller: { runtimeSessionId: CALLER, configDir: path.join(homeDir, '.claude') } }) });
    assert.equal(reply.status, 200);
    assert.equal(/Secret|private/.test(reply.text), false);
    return reply.json();
  };
  const root = await realpath(sessions);
  const [codexReply, cliReply] = [await bind(references[0]), await bind(references[1])];
  assert.equal(codexReply.pid, process.pid);
  assert.equal(codexReply.binding.expiresAtMs - Date.now() <= 10_000, true);
  assert.deepEqual({ ...codexReply.binding, expiresAtMs: 0 }, { registryHome: root, runtimeSessionId: SESSION, pid: codexChild.pid, procStart: starts[1],
    messagingSocketPath: `/synthetic/s/${codexChild.pid}.sock`, msgId: MSG, expiresAtMs: 0 });
  assert.deepEqual({ ...cliReply.binding, expiresAtMs: 0 }, { registryHome: root, runtimeSessionId: CLI, pid: cliChild.pid, procStart: starts[2],
    messagingSocketPath: `/synthetic/s/${cliChild.pid}.sock`, msgId: MSG, expiresAtMs: 0 });
  await chmod(sessions, 0o755);
  assert.equal((await bind(references[1])).code, 'caller-unregistered');
  await chmod(sessions, 0o700);
  await write(cliChild.pid, { sessionId: CLI, procStart: starts[2], entrypoint: 'cli', peerProtocol: undefined });
  assert.equal((await bind(references[1])).code, 'not-live');
  assert.equal(await readFile(pendingStatePath, 'utf8').catch((error) => error.code), before);
});
