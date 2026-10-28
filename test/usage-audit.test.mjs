import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityUsage } from '../src/activity-usage.mjs';

const NOW = Date.parse('2026-10-27T12:30:00Z');
const HOUR = Date.parse('2026-10-27T11:00:00Z');
const SELF = 'a'.repeat(16), OLD = 'b'.repeat(16), MEMBER = 'c'.repeat(16);
const tokens = (uncached, cacheRead = 0, cacheWrite = 0, output = 0) => ({ uncached, cacheRead, cacheWrite, output });
const document = (machines, exportedAtMs = NOW) => ({ format: 'asb-usage-export', version: 1, exportedAtMs, machines });
const row = (uncached, cacheRead = 0, cacheWrite = 0, output = 0) => [HOUR, 'codex', 'gpt-test-1', uncached, cacheRead, cacheWrite, output];

async function setup(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-audit-'));
  const ledgerFile = path.join(root, 'usage', 'usage-ledger.json');
  const clock = { ms: NOW };
  const usage = createActivityUsage({ machine: { machineId: SELF, name: 'desk' }, homeDir: root, env: {},
    cacheDir: path.join(root, 'cache'), ledgerFile, now: () => clock.ms, fetch: async () => new Response('{}'), ...extra });
  t.after(async () => { await usage.stop(); await usage.pricesIdle(); await fs.rm(root, { recursive: true, force: true }); });
  return { usage, root, ledgerFile, clock };
}

test('a rejoined member counts once and caches its original reply array', async (t) => {
  const { usage } = await setup(t);
  await usage.importAll(document([{ machineId: OLD, name: 'Laptop', records: [row(1000, 0, 0, 100)] }]));
  await usage.refresh();
  const member = { machineId: MEMBER, name: 'laptop', state: 'online', usage: [
    { app: 'codex', model: 'gpt-test-1', hourMs: HOUR, tokens: tokens(1000, 0, 0, 100) }, { app: null },
  ] };
  const report = usage.report('all', [member]);
  assert.equal(report.records.reduce((sum, record) => sum + Object.values(record.tokens).reduce((a, b) => a + b, 0), 0), 1100);
  assert.deepEqual(report.machines.filter((machine) => machine.name.toLowerCase() === 'laptop').map(({ state }) => state), ['online']);
  const builds = usage.stats.memberBuilds;
  usage.report('all', [member]);
  assert.equal(usage.stats.memberBuilds, builds);
  assert.equal(builds, 1);
  assert.equal((await usage.exportAll([member])).machines.filter((machine) => machine.name.toLowerCase() === 'laptop').length, 1);
  await usage.importAll(document([{ machineId: OLD, name: 'Laptop', records: [row(1200, 0, 0, 100)] }]));
  assert.equal(usage.report('all', [member]).records[0].tokens.uncached, 1200);
  assert.equal(usage.stats.memberBuilds, builds + 1);
});

test('imported-only identities merge by max and select newest export then larger ID', async (t) => {
  const { usage } = await setup(t);
  await usage.importAll(document([{ machineId: OLD, name: 'Laptop', records: [row(1000, 2, 0, 100)] }], NOW - 2000));
  await usage.importAll(document([{ machineId: MEMBER, name: 'laptop', records: [row(900, 0, 3, 110)] }], NOW - 1000));
  await usage.refresh();
  const report = usage.report('all');
  assert.deepEqual(report.machines.slice(1), [{ machineId: MEMBER, name: 'laptop', self: false, state: 'offline', lastReportAtMs: NOW - 1000 }]);
  assert.deepEqual(report.records.map(({ tokens }) => tokens), [tokens(1000, 2, 3, 110)]);
  assert.deepEqual((await usage.exportAll()).machines.slice(1), [{ machineId: MEMBER, name: 'laptop', records: [row(1000, 2, 3, 110)] }]);
  await usage.importAll(document([{ machineId: OLD, name: 'Laptop', records: [] }], NOW - 1000));
  assert.equal(usage.report('all').machines[1].machineId, MEMBER);
});

test('two members with different names keep separate usage', async (t) => {
  const { usage } = await setup(t);
  await usage.refresh();
  const members = [OLD, MEMBER].map((machineId, index) => ({ machineId, name: `member-${index}`, state: 'online',
    usage: [{ app: 'codex', model: 'gpt-test-1', hourMs: HOUR, tokens: tokens(index + 1) }] }));
  assert.deepEqual(usage.report('all', members).records.map(({ machineId, tokens }) => [machineId, tokens.uncached]), [[OLD, 1], [MEMBER, 2]]);
  assert.deepEqual((await usage.exportAll(members)).machines.slice(1).map(({ name }) => name), ['member-0', 'member-1']);
});

test('a Codex archive race counts a rollout once in each scan and the saved ledger', async (t) => {
  const sources = [];
  const { usage, root, ledgerFile } = await setup(t, { readSources: async () => sources });
  const dataDir = path.join(root, 'codex');
  const sessions = path.join(dataDir, 'sessions');
  const archived = path.join(dataDir, 'archived_sessions');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(archived);
  sources.push({ provider: 'codex', enabled: true, dataDir });
  const name = 'rollout-synthetic.jsonl';
  await fs.writeFile(path.join(sessions, name), [
    { type: 'turn_context', timestamp: new Date(HOUR).toISOString(), payload: { model: 'gpt-test-1' } },
    { type: 'event_msg', timestamp: new Date(HOUR).toISOString(), payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100 },
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100 },
    } } },
  ].map(JSON.stringify).join('\n') + '\n');
  await usage.refresh();
  const readdir = fs.readdir;
  let moved = false;
  t.mock.method(fs, 'readdir', async (folder, ...args) => {
    if (folder === archived && !moved) { moved = true; await fs.rename(path.join(sessions, name), path.join(archived, name)); }
    return readdir(folder, ...args);
  });
  const check = () => assert.deepEqual(usage.localHourly('all').usage.map(({ tokens }) => tokens), [tokens(1000, 0, 0, 100)]);
  await usage.refresh();
  assert.equal(moved, true);
  check();
  await usage.refresh();
  check();
  await usage.flush();
  const saved = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  assert.deepEqual(saved.self.records, [row(1000, 0, 0, 100)]);
});
