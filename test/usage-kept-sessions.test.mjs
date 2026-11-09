// The kept session sums: the session parts of the last completed scan stay after a release and while a local session
// works, and the private sessions file gives them to the next engine run before its first scan. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createActivityUsage, RELEASE_AFTER_MS, SAVE_INTERVAL_MS } from '../src/activity-usage.mjs';
import { loadUsageSessions } from '../src/usage-scan-cache.mjs';

const HOUR = 3_600_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR + 30 * 60_000;
const SELF = 'a'.repeat(16);
const posix = process.platform !== 'win32';
const iso = (ms) => new Date(ms).toISOString();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TITLES = { [uuid(1)]: 'Made-up plan alpha', [uuid(2)]: 'Made-up plan beta' };
const claudeLine = (atMs, id, output) => JSON.stringify({ type: 'assistant', timestamp: iso(atMs), requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-test-5', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: output } } });
const title = (app, id) => TITLES[id] || '';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-kept-'));
  const services = [];
  t.after(async () => {
    for (const usage of services) await usage.stop();
    await Promise.all(services.flatMap((usage) => [usage.idle(), usage.pricesIdle()]));
    await fs.rm(root, { recursive: true, force: true });
  });
  const projects = path.join(root, 'claude', 'projects', 'project');
  await fs.mkdir(projects, { recursive: true });
  const fetch = async () => new Response(JSON.stringify({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } }));
  const sources = [{ id: 'claude-desktop-code', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(root, 'claude-app'),
    projectsDir: path.dirname(projects) }];
  const ledgerFile = path.join(root, 'config', 'asb', 'usage', 'usage-ledger.json');
  const cacheDir = path.join(root, 'cache');
  const sessionsFile = path.join(cacheDir, 'usage', 'usage-sessions.json.gz');
  const clock = { ms: BASE };
  const logs = [];
  const pending = [];
  const timers = {
    setTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; pending.push(timer); return timer; },
    clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index !== -1) pending.splice(index, 1); },
  };
  const state = { busy: false };
  const service = (extra = {}) => {
    const usage = createActivityUsage({ readSources: async () => sources, machine: { machineId: SELF, name: 'engine-a' }, cacheDir,
      now: () => clock.ms, fetch, homeDir: root, env: {}, log: (line) => logs.push(line), ledgerFile, timers,
      busy: () => state.busy, changes: () => 1, ...extra });
    services.push(usage);
    return usage;
  };
  const write = (id, lines) => fs.writeFile(path.join(projects, `${id}.jsonl`), `${lines.join('\n')}\n`);
  await write(uuid(1), [claudeLine(BASE - HOUR, 1, 7), claudeLine(BASE - 2 * HOUR, 2, 9)]);
  await write(uuid(2), [claudeLine(BASE - 3 * HOUR, 3, 5)]);
  return { root, projects, cacheDir, sessionsFile, clock, logs, pending, state, service, write };
}

// The local sessions of a report: rows (ID, title, tokens, cost) and the count.
const local = (report) => ({
  rows: report.sessions.rows.filter((row) => row.machineId === SELF).map(({ id, app, title: name, tokens, cost }) => ({ id, app, title: name, tokens, cost })),
  count: report.sessions.counts[SELF],
});
const ids = (report) => local(report).rows.map((row) => row.id).sort();

// A first engine run: one completed scan (not busy) that saves the sessions file.
async function firstRun(context) {
  const usage = context.service();
  await usage.ready();
  usage.report('all', [], { title });
  await usage.idle();
  assert.equal(usage.stats.scans, 1);
  const report = usage.report('all', [], { title });
  assert.deepEqual(ids(report), [uuid(1), uuid(2)]);
  return { usage, before: local(report) };
}

test('the session sums stay after a release while a local session works, in report and localHourly', async (t) => {
  const context = await setup(t);
  const { usage, before } = await firstRun(context);
  assert.deepEqual(before.rows.map((row) => row.title).sort(), Object.values(TITLES).sort());
  context.state.busy = true;
  // The release timer of the last ask fires 2 minutes later: the scan cache leaves memory.
  const index = context.pending.findIndex((timer) => timer.delayMs === RELEASE_AFTER_MS);
  assert.notEqual(index, -1);
  const [timer] = context.pending.splice(index, 1);
  context.clock.ms += RELEASE_AFTER_MS;
  await timer.callback();
  assert.equal(usage.stats.releases, 1);
  const after = usage.report('all', [], { title });
  await usage.idle();
  assert.equal(usage.stats.scans, 1);
  assert.deepEqual(local(after), before);
  const hourly = usage.localHourly('all', { title });
  await usage.idle();
  assert.equal(usage.stats.scans, 1);
  assert.deepEqual(hourly.sessions.map((session) => session.id).sort(), [uuid(1), uuid(2)]);
  assert.deepEqual(hourly.sessions.find((session) => session.id === uuid(2)).models,
    [{ model: 'claude-test-5', tokens: { uncached: 10, cacheRead: 1000, cacheWrite: 50, output: 5 } }]);
  // The private file: mode 0600 in a 0700 folder, with no title, path, or home folder.
  if (posix) {
    assert.equal((await fs.stat(context.sessionsFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(context.sessionsFile))).mode & 0o777, 0o700);
  }
  const text = gunzipSync(await fs.readFile(context.sessionsFile)).toString('utf8');
  assert.ok(text.includes(uuid(1)) && text.includes(uuid(2)));
  for (const secret of ['title', path.sep, '/', context.root, ...Object.values(TITLES)]) assert.equal(text.includes(secret), false, secret);
});

test('a new engine run gives the saved sessions before its first scan, with no scan and no scan cache', async (t) => {
  const context = await setup(t);
  const { usage: first, before } = await firstRun(context);
  await first.stop();
  context.state.busy = true;
  const second = context.service();
  await second.ready();
  second.report('all', [], { title });
  // The first report starts the price load; the next one has the prices.
  await second.pricesIdle();
  const report = second.report('all', [], { title });
  await second.idle();
  assert.deepEqual(local(report), before);
  assert.equal(second.stats.scans, 0);
  assert.equal(second.stats.bytesRead, 0);
  // The parts of the scan cache: none, so the cache file was not loaded.
  assert.equal(second.stats.parts, 0);
  await second.stop();
  // Not busy: a report starts the first scan, and the report made before the scan completes has all saved sessions.
  context.state.busy = false;
  const third = context.service();
  await third.ready();
  const during = third.report('all', [], { title });
  assert.equal(during.scan.complete, false);
  const unpriced = ({ rows, count }) => ({ rows: rows.map(({ cost: _cost, ...row }) => row), count });
  assert.deepEqual(unpriced(local(during)), unpriced(before));
  await third.idle();
  assert.equal(third.stats.scans, 1);
  assert.deepEqual(local(third.report('all', [], { title })), before);
});

for (const scenario of ['damaged', 'other version', 'one invalid part']) {
  test(`a sessions file that is ${scenario} gives no sessions and no error, and the next scan makes it valid again`, async (t) => {
    const context = await setup(t);
    const { usage: first, before } = await firstRun(context);
    await first.stop();
    const document = JSON.parse(gunzipSync(await fs.readFile(context.sessionsFile)).toString('utf8'));
    assert.equal(document.version, 1);
    let data = Buffer.from('not gzip');
    if (scenario === 'other version') data = gzipSync(JSON.stringify({ ...document, version: 2 }));
    if (scenario === 'one invalid part') {
      document.parts[0][3] = -1;
      data = gzipSync(JSON.stringify(document));
    }
    await fs.writeFile(context.sessionsFile, data, { mode: 0o600 });
    await fs.chmod(context.sessionsFile, 0o600);
    assert.equal(await loadUsageSessions(context.sessionsFile), null);
    context.state.busy = true;
    const usage = context.service();
    await usage.ready();
    const report = usage.report('all', [], { title });
    await usage.idle();
    assert.equal(usage.stats.scans, 0);
    assert.deepEqual(local(report).rows, []);
    context.state.busy = false;
    usage.report('all', [], { title });
    await usage.idle();
    assert.equal(usage.stats.scans, 1);
    assert.deepEqual(local(usage.report('all', [], { title })), before);
    assert.deepEqual((await loadUsageSessions(context.sessionsFile)).map((part) => part.session).sort(), [uuid(1), uuid(1), uuid(2)]);
  });
}

test('a removed transcript leaves the sessions after the next scan, and the saved file does not hold its ID', async (t) => {
  const context = await setup(t);
  const { usage } = await firstRun(context);
  await fs.rm(path.join(context.projects, `${uuid(2)}.jsonl`));
  context.clock.ms += SAVE_INTERVAL_MS;
  await usage.refresh();
  assert.deepEqual(ids(usage.report('all', [], { title })), [uuid(1)]);
  const text = gunzipSync(await fs.readFile(context.sessionsFile)).toString('utf8');
  assert.equal(text.includes(uuid(2)), false);
  assert.ok(text.includes(uuid(1)));
});

test('a failed save of the sessions file logs one line, and the engine continues with its sessions', async (t) => {
  const context = await setup(t);
  // A folder in the place of the file: the rename fails.
  await fs.mkdir(context.sessionsFile, { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(context.sessionsFile), 0o700);
  const usage = context.service();
  await usage.ready();
  usage.report('all', [], { title });
  await usage.idle();
  assert.equal(usage.stats.scans, 1);
  assert.ok(context.logs.includes('ASB cannot save its usage sessions. It keeps the old file.'));
  assert.deepEqual(ids(usage.report('all', [], { title })), [uuid(1), uuid(2)]);
});
