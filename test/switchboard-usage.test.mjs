import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

// Synthetic sources, models, and machines only. Tests never use the network: the price download is a fake fetch.
const HOUR = 3_600_000;
const self = { machineId: 'a'.repeat(16), machineName: 'engine-a' };
const member = (usage) => ({ machineId: 'b'.repeat(16), name: 'engine-b', state: 'online', lastReportAtMs: Date.now(), messages: [], usage,
  scan: { complete: true, files: 1, scannedFiles: 1 } });

async function setup(t, extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-switchboard-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projects = path.join(home, '.claude', 'projects');
  await mkdir(path.join(projects, 'project'), { recursive: true });
  const atMs = Date.now() - HOUR;
  await writeFile(path.join(projects, 'project', 'a.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(),
    requestId: 'r-1', message: { id: 'm-1', model: 'claude-test-5', content: [],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 7 } } })}\n`);
  const sources = [{ id: 'claude-desktop-code', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(home, 'claude-app'), projectsDir: projects }];
  const fetches = [];
  const usageFetch = async (url) => {
    fetches.push(url);
    return new Response(JSON.stringify({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
      cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } }));
  };
  const cacheDir = path.join(home, '.cache', 'asb');
  const server = createSwitchboardServer({ pendingTracker: new PendingTracker(false), palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: { read: async () => sources }, loadDashboard: async () => ({ providers: [], threads: [] }),
    machineIdentity: () => self, usageFetch, usageCacheDir: cacheDir, usageHomeDir: home, ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // The scan and the download run in the background: ask again until both end.
  const usage = async (period = '7d') => {
    for (let round = 0; round < 200; round += 1) {
      const response = await fetch(`${base}/api/activity/usage?period=${period}`);
      assert.equal(response.status, 200);
      const reply = await response.json();
      if (reply.scan.complete && reply.prices.status === 'fresh') return reply;
      await delay(10);
    }
    throw new Error('The usage scan did not end.');
  };
  return { usage, fetches, cacheDir };
}

test('the switchboard usage route reads the registered Claude source and prices it with the fake download', async (t) => {
  const { usage, fetches } = await setup(t);
  const reply = await usage();
  assert.deepEqual(Object.keys(reply).sort(), ['buckets', 'machines', 'nowMs', 'period', 'prices', 'records', 'scan']);
  assert.equal(reply.period, '7d');
  assert.deepEqual(reply.machines, [{ machineId: self.machineId, name: self.machineName, self: true, state: 'local', lastReportAtMs: 0 }]);
  assert.equal(reply.records.length, 1);
  assert.deepEqual([reply.records[0].machineId, reply.records[0].app, reply.records[0].model], [self.machineId, 'claude', 'claude-test-5']);
  assert.deepEqual(reply.records[0].tokens, { uncached: 10, cacheRead: 1000, cacheWrite: 50, output: 7 });
  assert.ok(reply.records[0].cost.total > 0);
  assert.equal(reply.prices.status, 'fresh');
  assert.equal(reply.prices.models, 1);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /litellm/);
});

test('the usage reply adds the group members, and a failed member read gives the local reply only', async (t) => {
  const record = { app: 'codex', model: 'gpt-test-1', hourMs: Math.floor(Date.now() / HOUR) * HOUR - HOUR,
    tokens: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } };
  const periods = [];
  const group = await setup(t, { machineGroup: { activity: async (period) => { periods.push(period); return [member([record])]; } } });
  const reply = await group.usage();
  assert.deepEqual(reply.machines.map((machine) => [machine.machineId, machine.name, machine.self, machine.state]),
    [[self.machineId, self.machineName, true, 'local'], ['b'.repeat(16), 'engine-b', false, 'online']]);
  const remote = reply.records.filter((item) => item.machineId === 'b'.repeat(16));
  assert.deepEqual(remote.map((item) => [item.app, item.model, item.tokens]), [['codex', 'gpt-test-1', record.tokens]]);
  assert.ok(periods.every((period) => period === '7d') && periods.length > 0);

  const failed = await setup(t, { machineGroup: { activity: async () => { throw new Error('offline'); } } });
  const local = await failed.usage();
  assert.deepEqual(local.machines.map((machine) => machine.machineId), [self.machineId]);
  assert.deepEqual(local.records.map((item) => item.machineId), [self.machineId]);
});

test('creating the switchboard server starts no usage scan and no price download', async (t) => {
  const { fetches, cacheDir } = await setup(t);
  await delay(100);
  assert.equal(fetches.length, 0);
  await assert.rejects(access(path.join(cacheDir, 'usage', 'usage-cache.json')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(cacheDir, 'usage')), { code: 'ENOENT' });
});
