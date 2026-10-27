import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

// Synthetic sources, models, and machines only. Tests never use the network.
const HOUR = 3_600_000;
const TOKEN = 'd'.repeat(64);
const self = { machineId: 'a'.repeat(16), machineName: 'engine-a' };
const hourMs = Math.floor(Date.now() / HOUR) * HOUR - HOUR;

async function setup(t, extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-backup-routes-'));
  const projects = path.join(home, '.claude', 'projects');
  await mkdir(path.join(projects, 'project'), { recursive: true });
  await writeFile(path.join(projects, 'project', 'a.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: new Date(hourMs + 60_000).toISOString(),
    requestId: 'r-1', message: { id: 'm-1', model: 'claude-test-5', content: [],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 7 } } })}\n`);
  const sources = [{ id: 'claude-desktop-code', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(home, 'claude-app'), projectsDir: projects }];
  const config = path.join(home, '.config', 'asb', 'usage');
  const server = createSwitchboardServer({ pendingTracker: new PendingTracker(false), palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: { read: async () => sources }, loadDashboard: async () => ({ providers: [], threads: [] }), sourceToken: TOKEN,
    machineIdentity: () => self, usageFetch: async () => { throw new Error('offline'); },
    usageCacheDir: path.join(home, '.cache', 'asb'), usageHomeDir: home, usageLedgerFile: path.join(config, 'usage-ledger.json'),
    usageBackupFile: path.join(config, 'usage-backup.json'), ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
  return { home, config, base, call };
}

const settings = (extra = {}) => JSON.stringify({ enabled: true, time: '03:00', keep: 5, folder: '', ...extra });

test('the backup routes need the source token and send no-store', async (t) => {
  const { call } = await setup(t);
  for (const [route, method, error] of [['/api/usage/backup', 'GET', 'Use the current ASB source token to read usage backups.'],
    ['/api/usage/backup/settings', 'POST', 'Use the current ASB source token to change usage backups.'],
    ['/api/usage/backup/now', 'POST', 'Use the current ASB source token to back up usage.']]) {
    for (const token of ['', 'e'.repeat(64)]) {
      const reply = await call(route, { method, token, ...(method === 'POST' ? { body: route.endsWith('now') ? '{}' : settings() } : {}) });
      assert.deepEqual([reply.status, reply.cache, reply.json], [403, 'no-store', { error }], `${route} ${token}`);
    }
  }
});

test('read the defaults, save settings, and back up now', async (t) => {
  const { home, base, config, call } = await setup(t);
  // The read route takes GET only, and the action routes POST only.
  for (const [route, method, allow] of [['/api/usage/backup', 'POST', 'GET'], ['/api/usage/backup/settings', 'GET', 'POST'], ['/api/usage/backup/now', 'GET', 'POST']]) {
    const response = await fetch(`${base}${route}`, { method, headers: { origin: base, 'X-ASB-Source-Token': TOKEN } });
    assert.deepEqual([response.status, response.headers.get('allow')], [405, allow], route);
  }
  const folder = path.join(config, 'backups');
  const defaults = await call('/api/usage/backup');
  assert.equal(defaults.status, 200);
  assert.equal(defaults.cache, 'no-store');
  assert.deepEqual({ ...defaults.json, nextAtMs: null }, { enabled: true, time: '03:00', keep: 5, folder: '', path: folder, defaultPath: folder,
    nextAtMs: null, running: false, files: [], lastError: null });
  assert.ok(Number.isSafeInteger(defaults.json.nextAtMs));

  for (const [body, error] of [['{', 'Invalid backup settings.'], [settings({ extra: 1 }), 'Invalid backup settings.'], [settings({ keep: 31 }), 'Invalid backup settings.'],
    [settings({ folder: 'relative' }), 'Use a full folder path.'], [settings({ folder: path.join(home, 'missing') }), 'This folder does not exist.'],
    [JSON.stringify({ folder: 'x'.repeat(9000) }), 'Invalid backup settings.']]) {
    const reply = await call('/api/usage/backup/settings', { method: 'POST', body });
    assert.deepEqual([reply.status, reply.cache, reply.json], [400, 'no-store', { error }], body.slice(0, 40));
  }
  const saved = await call('/api/usage/backup/settings', { method: 'POST', body: settings({ enabled: false, keep: 2 }) });
  assert.deepEqual([saved.status, saved.json.enabled, saved.json.keep, saved.json.nextAtMs], [200, false, 2, null]);
  assert.equal(await readFile(path.join(config, 'usage-backup.json'), 'utf8'), '{"version":1,"enabled":false,"time":"03:00","keep":2,"folder":""}');

  for (const body of ['{"x":1}', '[]', '{']) {
    const reply = await call('/api/usage/backup/now', { method: 'POST', body });
    assert.deepEqual([reply.status, reply.json], [400, { error: 'Invalid backup request.' }], body);
  }
  const now = await call('/api/usage/backup/now', { method: 'POST', body: '{}' });
  assert.equal(now.status, 200);
  assert.equal(now.cache, 'no-store');
  assert.deepEqual(await readdir(folder), [now.json.made.name]);
  assert.match(now.json.made.name, /^asb-usage-engine-a-aaaaaaaa-\d{4}-\d{2}-\d{2}\.json$/);
  assert.deepEqual(now.json.made, { name: now.json.made.name, path: path.join(folder, now.json.made.name), machines: 1, hours: 1 });
  assert.deepEqual(now.json.files.map((file) => file.name), [now.json.made.name]);
  assert.ok(now.json.files.every((file) => Number.isSafeInteger(file.modifiedAtMs)));
  const document = JSON.parse(await readFile(now.json.made.path, 'utf8'));
  assert.deepEqual(document.machines, [{ machineId: self.machineId, name: 'engine-a', records: [[hourMs, 'claude', 'claude-test-5', 10, 1000, 50, 7]] }]);
  if (process.platform !== 'win32') assert.equal((await stat(now.json.made.path)).mode & 0o777, 0o600);
});

test('back up now without a machine ID gives 409, and a missing custom folder 500', async (t) => {
  const { home, call } = await setup(t, { machineIdentity: () => ({ machineId: '', machineName: 'engine-a' }) });
  const conflict = await call('/api/usage/backup/now', { method: 'POST', body: '{}' });
  assert.deepEqual([conflict.status, conflict.json], [409, { error: 'ASB has no machine ID yet. Start ASB again.' }]);
  const custom = path.join(home, 'custom');
  await mkdir(custom);
  assert.equal((await call('/api/usage/backup/settings', { method: 'POST', body: settings({ folder: custom }) })).status, 200);
  await rm(custom, { recursive: true });
  const missing = await call('/api/usage/backup/now', { method: 'POST', body: '{}' });
  assert.deepEqual([missing.status, missing.json], [500, { error: `The backup folder does not exist: ${custom}.` }]);
});

test('no backup routes without the ledger file or the backup file', async (t) => {
  for (const extra of [{ usageLedgerFile: '' }, { usageBackupFile: '' }]) {
    const { call } = await setup(t, extra);
    for (const [route, method] of [['/api/usage/backup', 'GET'], ['/api/usage/backup/settings', 'POST'], ['/api/usage/backup/now', 'POST']]) {
      const reply = await call(route, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.deepEqual([reply.status, reply.json], [404, { error: 'Route is not available in ASB.' }], `${route} ${JSON.stringify(extra)}`);
    }
  }
});

test('the backup export is group-aware and keeps saved members when they go offline', async (t) => {
  const record = { hourMs, app: 'codex', model: 'gpt-test-1', tokens: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } };
  let online = true;
  const periods = [];
  const member = { machineId: 'b'.repeat(16), name: 'homeLP', lastReportAtMs: Date.now(), usage: [record] };
  const { call } = await setup(t, { machineGroup: { activity: async (period) => {
    periods.push(period);
    return [{ ...member, state: online ? 'online' : 'offline', usage: online ? member.usage : [], lastReportAtMs: online ? member.lastReportAtMs : 0 }];
  } } });
  const first = await call('/api/usage/backup/now', { method: 'POST', body: '{}' });
  assert.deepEqual([first.status, first.json.made.machines, first.json.made.hours], [200, 2, 2]);
  online = false;
  const second = await call('/api/usage/backup/now', { method: 'POST', body: '{}' });
  assert.deepEqual([second.status, second.json.made.machines, second.json.made.hours], [200, 2, 2]);
  const document = JSON.parse(await readFile(second.json.made.path, 'utf8'));
  assert.deepEqual(document.machines[1], { machineId: member.machineId, name: member.name, records: [[hourMs, 'codex', 'gpt-test-1', 1, 2, 3, 4]] });
  assert.deepEqual(periods, ['all', 'all']);
});

test('the backup routes map service failures, and reject a large now body', async (t) => {
  const failure = async () => { throw new Error('synthetic'); };
  const { call } = await setup(t, { activityUsage: { backup: { status: failure, saveSettings: failure, runNow: failure } } });
  for (const [route, method, body, error] of [['/api/usage/backup', 'GET', undefined, 'ASB cannot read the usage backups.'],
    ['/api/usage/backup/settings', 'POST', settings(), 'ASB cannot save the backup settings.'],
    ['/api/usage/backup/now', 'POST', '{}', 'ASB cannot make the usage backup.']]) {
    const reply = await call(route, { method, body });
    assert.deepEqual([reply.status, reply.cache, reply.json], [500, 'no-store', { error }], route);
  }
  const large = await call('/api/usage/backup/now', { method: 'POST', body: JSON.stringify({ x: 'x'.repeat(1024) }) });
  assert.deepEqual([large.status, large.cache, large.json], [400, 'no-store', { error: 'Invalid backup request.' }]);
});
