import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createActivityUsage, LEDGER_FIRST_MS, LEDGER_REFRESH_MS, RELEASE_AFTER_MS, SAVE_INTERVAL_MS } from '../src/activity-usage.mjs';
import { usageLedgerPath } from '../src/usage-ledger.mjs';
import { parseRateTable, priceTokens } from '../src/usage-pricing.mjs';

// Synthetic transcripts, models, and machines only. Tests never use the network: the price download is a fake fetch.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = Math.floor(Date.now() / HOUR) * HOUR + 30 * 60_000;
const SELF = 'a'.repeat(16);
const MEMBER = 'b'.repeat(16);
const OTHER = 'c'.repeat(16);
const windows = process.platform === 'win32';
const iso = (ms) => new Date(ms).toISOString();
const claudeLine = (atMs, id, output) => JSON.stringify({ type: 'assistant', timestamp: iso(atMs), requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-test-5', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: output } } });
const tokens = (uncached, cacheRead, cacheWrite, output) => ({ uncached, cacheRead, cacheWrite, output });
const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;
// The records of one machine without the price fields, for exact token checks.
const withoutScan = ({ scan: _scan, ...rest }) => rest;
const sums = (report, machineId = SELF) => report.records.filter((record) => record.machineId === machineId)
  .map(({ app, model, bucket, tokens: value }) => [app, model, bucket, value]);

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-ledger-'));
  const services = [];
  t.after(async () => {
    for (const usage of services) await usage.stop();
    await Promise.all(services.flatMap((usage) => [usage.idle(), usage.pricesIdle()]));
    await fs.chmod(path.join(root, 'config', 'asb', 'usage'), 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const projects = path.join(root, 'claude', 'projects', 'project');
  await fs.mkdir(projects, { recursive: true });
  const fetches = [];
  const fetch = async (url) => {
    fetches.push(url);
    return new Response(JSON.stringify({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
      cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } }));
  };
  const sources = [{ id: 'claude-desktop-code', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(root, 'claude-app'),
    projectsDir: path.dirname(projects) }];
  const ledgerFile = path.join(root, 'config', 'asb', 'usage', 'usage-ledger.json');
  const clock = { ms: BASE };
  const logs = [];
  const service = (extra = {}) => {
    const usage = createActivityUsage({ readSources: async () => sources, machine: { machineId: SELF, name: 'engine-a' },
      cacheDir: path.join(root, 'cache'), now: () => clock.ms, fetch, homeDir: root, env: {}, log: (line) => logs.push(line), ledgerFile, ...extra });
    services.push(usage);
    return usage;
  };
  const write = (name, lines) => fs.writeFile(path.join(projects, name), `${lines.join('\n')}\n`);
  return { root, projects, fetches, ledgerFile, clock, logs, service, write };
}

// One full scan and a fresh price table.
async function settle(usage) {
  await usage.refresh();
  usage.report('30d');
  await usage.pricesIdle();
}

test('usageLedgerPath is the usage folder of the ASB config folder on each system', () => {
  assert.equal(usageLedgerPath({ XDG_CONFIG_HOME: '/config' }, 'linux'), '/config/asb/usage/usage-ledger.json');
  assert.equal(usageLedgerPath({ APPDATA: 'D:\\Roaming' }, 'win32'), 'D:\\Roaming\\asb\\usage\\usage-ledger.json');
});

test('without a ledger file nothing changes: a deleted transcript drops out, and no config file appears', async (t) => {
  const { root, projects, write, service } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const usage = service({ ledgerFile: '' });
  assert.equal(usage.exportAll, undefined);
  assert.equal(usage.importAll, undefined);
  usage.start();
  await settle(usage);
  assert.equal(sums(usage.report('30d')).length, 1);
  await fs.rm(path.join(projects, 'a.jsonl'));
  await usage.refresh();
  assert.deepEqual(usage.report('30d').records, []);
  assert.deepEqual(usage.localHourly('all').usage, []);
  await usage.stop();
  await usage.flush();
  await assert.rejects(fs.access(path.join(root, 'config')), { code: 'ENOENT' });
});

test('a deleted transcript keeps its tokens and cost in report and localHourly, with no double count', async (t) => {
  const { projects, write, service, ledgerFile } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7), claudeLine(BASE - 3 * DAY, 2, 9)]);
  await write('b.jsonl', [claudeLine(BASE - HOUR, 3, 11)]);
  const usage = service();
  await settle(usage);
  const before = { all: usage.report('all'), month: usage.report('30d'), hourly: usage.localHourly('all') };
  // Exact totals: two messages in the last hour, one three days ago.
  assert.deepEqual(before.hourly.usage.map(({ hourMs, tokens: value }) => [hourMs, value]),
    [[hourOf(BASE - 3 * DAY), tokens(10, 1000, 50, 9)], [hourOf(BASE - HOUR), tokens(20, 2000, 100, 18)]]);
  assert.equal(sums(before.month).reduce((sum, [, , , value]) => sum + value.output, 0), 27);
  await fs.rm(path.join(projects, 'a.jsonl'));
  await usage.refresh();
  assert.deepEqual(withoutScan(usage.report('all')), withoutScan(before.all));
  assert.deepEqual(withoutScan(usage.report('30d')), withoutScan(before.month));
  assert.deepEqual(usage.localHourly('all').usage, before.hourly.usage);
  // The kept message comes back: per hour the larger value, never a sum.
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7), claudeLine(BASE - 3 * DAY, 2, 9)]);
  await usage.refresh();
  assert.deepEqual(withoutScan(usage.report('30d')), withoutScan(before.month));
  assert.deepEqual(usage.localHourly('all').usage, before.hourly.usage);
  // A new engine with the same ledger and no transcripts shows the same totals after its scan.
  await fs.rm(path.join(projects, 'a.jsonl'));
  await fs.rm(path.join(projects, 'b.jsonl'));
  await usage.stop();
  const next = service({ cacheDir: path.join(path.dirname(ledgerFile), 'other-cache') });
  await settle(next);
  assert.deepEqual(sums(next.report('30d')), sums(before.month));
  assert.deepEqual(next.report('30d').records.map((record) => record.cost), before.month.records.map((record) => record.cost));
  assert.deepEqual(next.localHourly('all').usage, before.hourly.usage);
});

test('a transcript that falls out of the newest-file limit still counts', async (t) => {
  const { projects, write, service } = await setup(t);
  await write('old.jsonl', [claudeLine(BASE - 2 * DAY, 1, 5)]);
  await fs.utimes(path.join(projects, 'old.jsonl'), new Date(BASE - 2 * DAY), new Date(BASE - 2 * DAY));
  const usage = service({ maxCacheFiles: 1 });
  const plain = service({ maxCacheFiles: 1, ledgerFile: '', cacheDir: path.join(projects, '..', 'plain-cache') });
  await settle(usage);
  await settle(plain);
  await write('new.jsonl', [claudeLine(BASE - HOUR, 2, 6)]);
  await usage.refresh();
  await plain.refresh();
  assert.deepEqual(usage.localHourly('all').usage.map(({ hourMs, tokens: value }) => [hourMs, value.output]), [[hourOf(BASE - 2 * DAY), 5], [hourOf(BASE - HOUR), 6]]);
  assert.equal(sums(usage.report('30d')).reduce((sum, [, , , value]) => sum + value.output, 0), 11);
  assert.deepEqual(plain.localHourly('all').usage.map(({ tokens: value }) => value.output), [6]);
});

test('the ledger file is private, saved after the first scan, at most once in five minutes, after an import, and on stop', async (t) => {
  const { write, service, ledgerFile, clock } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const usage = service();
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, 1);
  if (!windows) {
    assert.equal((await fs.stat(ledgerFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(ledgerFile))).mode & 0o777, 0o700);
  }
  // Growth less than five minutes after the last save waits; no growth never saves.
  clock.ms += 60_000;
  await write('b.jsonl', [claudeLine(BASE - 2 * HOUR, 2, 3), claudeLine(BASE - 2 * HOUR, 3, 4)]);
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, 1);
  clock.ms = BASE + SAVE_INTERVAL_MS - 1;
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, 1);
  clock.ms += 1;
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, 2);
  clock.ms += 2 * SAVE_INTERVAL_MS;
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, 2);
  await usage.importAll({ format: 'asb-usage-export', version: 1, exportedAtMs: BASE, machines: [{ machineId: OTHER, name: 'retired',
    records: [[hourOf(BASE - DAY), 'codex', 'gpt-test-1', 1, 2, 3, 4]] }] });
  assert.equal(usage.stats.ledgerSaves, 3);
  await write('c.jsonl', [claudeLine(BASE - 5 * HOUR, 4, 1)]);
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, 3);
  await usage.stop();
  assert.equal(usage.stats.ledgerSaves, 4);
  const saved = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  assert.deepEqual(saved, { version: 1, self: { machineId: SELF, name: 'engine-a', records: [
    [hourOf(BASE - 5 * HOUR), 'claude', 'claude-test-5', 10, 1000, 50, 1],
    [hourOf(BASE - 2 * HOUR), 'claude', 'claude-test-5', 20, 2000, 100, 7],
    [hourOf(BASE - HOUR), 'claude', 'claude-test-5', 10, 1000, 50, 7]] },
  machines: [{ machineId: OTHER, name: 'retired', exportedAtMs: BASE, records: [[hourOf(BASE - DAY), 'codex', 'gpt-test-1', 1, 2, 3, 4]] }] });
});

test('a corrupt ledger is set aside unchanged and replaced; when that fails, no ledger is written in the run', async (t) => {
  const { write, service, ledgerFile, logs } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const folder = path.dirname(ledgerFile);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const corrupt = JSON.stringify({ version: 1, self: { machineId: SELF, name: 'engine-a', records: [[BASE, 'claude', 'm', 1, 1, 1, 1]] }, machines: [] });
  await fs.writeFile(ledgerFile, corrupt, { mode: 0o600 });
  const usage = service();
  await usage.refresh();
  const aside = (await fs.readdir(folder)).filter((name) => name !== 'usage-ledger.json' && name !== 'usage-tiers.json');
  assert.deepEqual(aside, [`usage-ledger.${BASE}.bad.json`]);
  assert.equal(await fs.readFile(path.join(folder, aside[0]), 'utf8'), corrupt);
  assert.deepEqual(logs, [`ASB set aside an unreadable usage ledger: usage-ledger.${BASE}.bad.json.`]);
  assert.equal(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).self.records.length, 1);
  await usage.stop();
  if (windows) return;
  // A read-only folder: the file cannot be renamed, so it stays as it is.
  await fs.rm(path.join(folder, aside[0]));
  await fs.writeFile(ledgerFile, '{', { mode: 0o600 });
  await fs.chmod(folder, 0o500);
  logs.length = 0;
  const blocked = service({ cacheDir: path.join(folder, '..', 'blocked-cache') });
  await blocked.refresh();
  await write('b.jsonl', [claudeLine(BASE - 2 * HOUR, 2, 3)]);
  await blocked.refresh();
  await assert.rejects(blocked.importAll({ format: 'asb-usage-export', version: 1, exportedAtMs: BASE, machines: [{ machineId: OTHER, name: 'retired', records: [] }] }), { statusCode: 500, message: 'ASB could not save the usage ledger. Keep the export file and try again.' });
  await blocked.stop();
  assert.deepEqual(logs, ['ASB cannot set aside its unreadable usage ledger. It saves no usage history now.']);
  assert.equal(blocked.stats.ledgerSaves, 0);
  assert.deepEqual(await fs.readdir(folder), ['usage-ledger.json', 'usage-tiers.json']);
  assert.equal(await fs.readFile(ledgerFile, 'utf8'), '{');
  // The history still shows in this run.
  assert.equal(blocked.localHourly('all').usage.length, 2);
});

const exportFile = (machines, exportedAtMs = BASE - DAY) => ({ format: 'asb-usage-export', version: 1, exportedAtMs, machines });

test('imported machines show after the members, merge by max with members and self, and a second import changes nothing', async (t) => {
  const { write, service } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const usage = service();
  await settle(usage);
  const memberHour = hourOf(BASE - 2 * HOUR);
  const members = [{ machineId: MEMBER, name: 'engine-b', state: 'online', lastReportAtMs: BASE - 1000,
    usage: [{ app: 'codex', model: 'gpt-test-1', hourMs: memberHour, tokens: tokens(1, 2, 3, 4) }], scan: { complete: true, files: 1, scannedFiles: 1 } }];
  const document = exportFile([
    { machineId: OTHER, name: 'zeta', records: [[hourOf(BASE - 3 * DAY), 'codex', 'gpt-test-1', 100, 0, 0, 5], [hourOf(BASE - 3 * DAY), 'codex', 'gpt-test-1', 50, 1, 0, 5]] },
    { machineId: MEMBER, name: 'engine-b', records: [[memberHour, 'codex', 'gpt-test-1', 1, 5, 0, 4], [hourOf(BASE - 4 * DAY), 'codex', 'gpt-test-1', 0, 0, 0, 2]] },
    { machineId: SELF, name: 'engine-a', records: [[hourOf(BASE - 5 * DAY), 'claude', 'claude-test-5', 1, 0, 0, 1]] },
  ]);
  assert.deepEqual(await usage.importAll(document), { machines: [{ machineId: OTHER, name: 'zeta', hours: 1 },
    { machineId: MEMBER, name: 'engine-b', hours: 2 }, { machineId: SELF, name: 'engine-a', hours: 1 }] });
  const report = usage.report('30d', members);
  assert.deepEqual(report.machines, [{ machineId: SELF, name: 'engine-a', self: true, state: 'local', lastReportAtMs: 0 },
    { machineId: MEMBER, name: 'engine-b', self: false, state: 'online', lastReportAtMs: BASE - 1000 },
    { machineId: OTHER, name: 'zeta', self: false, state: 'offline', lastReportAtMs: BASE - DAY }]);
  const bucket = (ms) => report.buckets.startsMs.findLastIndex((start) => start <= ms);
  assert.deepEqual(sums(report, OTHER), [['codex', 'gpt-test-1', bucket(BASE - 3 * DAY), tokens(100, 1, 0, 5)]]);
  // The member: the larger value per type, not a sum.
  assert.deepEqual(sums(report, MEMBER), [['codex', 'gpt-test-1', bucket(BASE - 4 * DAY), tokens(0, 0, 0, 2)],
    ['codex', 'gpt-test-1', bucket(memberHour), tokens(1, 5, 3, 4)]]);
  // The imported copy of this machine joins its own records.
  assert.deepEqual(sums(report), [['claude', 'claude-test-5', bucket(BASE - 5 * DAY), tokens(1, 0, 0, 1)],
    ['claude', 'claude-test-5', bucket(BASE - HOUR), tokens(10, 1000, 50, 7)]]);
  await usage.importAll(document);
  assert.deepEqual(usage.report('30d', members), report);
  assert.deepEqual(usage.report('all', members).machines.map((item) => item.machineId), [SELF, MEMBER, OTHER]);
});

test('every rule of the import file has a failing case', async (t) => {
  const { service } = await setup(t);
  const usage = service();
  const record = [hourOf(BASE - HOUR), 'codex', 'gpt-test-1', 1, 2, 3, 4];
  const machine = (extra = {}) => ({ machineId: OTHER, name: 'retired', records: [record], ...extra });
  const withRecord = (value) => exportFile([machine({ records: [value] })]);
  const { exportedAtMs: _drop, ...noTime } = exportFile([machine()]);
  const cases = [null, [], 'text', noTime, { ...exportFile([machine()]), extra: 1 }, { ...exportFile([machine()]), format: 'other' },
    { ...exportFile([machine()]), version: 2 }, exportFile([machine()], 0), exportFile([machine()], 1.5), exportFile([machine()], Number.MAX_SAFE_INTEGER + 2),
    exportFile({}), exportFile([]), exportFile(Array.from({ length: 65 }, () => machine())), exportFile([null]),
    exportFile([{ machineId: OTHER, name: 'retired' }]), exportFile([machine({ extra: 1 })]), exportFile([machine({ machineId: 'C'.repeat(16) })]),
    exportFile([machine({ machineId: 'c'.repeat(15) })]), exportFile([machine({ machineId: 7 })]), exportFile([machine({ name: '-bad' })]),
    exportFile([machine({ name: 'x'.repeat(33) })]), exportFile([machine({ records: {} })]),
    exportFile([machine({ records: Array.from({ length: 500_001 }, () => record) })]),
    withRecord({}), withRecord(record.slice(0, 6)), withRecord([...record, 1]), withRecord([record[0] + 0.5, ...record.slice(1)]),
    withRecord([String(record[0]), ...record.slice(1)]), withRecord([record[0] + 60_000, ...record.slice(1)]),
    withRecord([Date.UTC(2019, 11, 31, 23), ...record.slice(1)]), withRecord([hourOf(BASE) + 2 * DAY, ...record.slice(1)]),
    withRecord([record[0], 'Codex', ...record.slice(2)]), withRecord([record[0], '1codex', ...record.slice(2)]),
    withRecord([record[0], `c${'x'.repeat(64)}`, ...record.slice(2)]), withRecord([record[0], 3, ...record.slice(2)]),
    withRecord([...record.slice(0, 2), '', ...record.slice(3)]), withRecord([...record.slice(0, 2), 'm'.repeat(201), ...record.slice(3)]),
    withRecord([...record.slice(0, 2), 'gpt\ntest', ...record.slice(3)]), withRecord([...record.slice(0, 2), 5, ...record.slice(3)]),
    withRecord([...record.slice(0, 3), -1, 2, 3, 4]), withRecord([...record.slice(0, 4), 2.5, 3, 4]),
    withRecord([...record.slice(0, 5), '3', 4]), withRecord([...record.slice(0, 6), Number.MAX_SAFE_INTEGER + 1])];
  for (const [index, value] of cases.entries()) {
    await assert.rejects(usage.importAll(value), (error) => error.statusCode === 400 && error.message === 'This file is not an ASB usage export.', `case ${index}`);
  }
  // The limits themselves pass.
  const edge = exportFile([machine({ name: 'x'.repeat(32), records: [[Date.UTC(2020, 0, 1), `c${'x'.repeat(63)}`, 'm'.repeat(200), 0, 0, 0, Number.MAX_SAFE_INTEGER]] })]);
  assert.deepEqual(await usage.importAll(edge), { machines: [{ machineId: OTHER, name: 'x'.repeat(32), hours: 1 }] });
});

test('export lists this machine, the members, then the imported-only machines, once each, sorted; 409 without a machine ID', async (t) => {
  const { root, write, service, fetches } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7), claudeLine(BASE - 3 * DAY, 2, 9)]);
  const usage = service();
  await usage.importAll(exportFile([
    { machineId: 'e'.repeat(16), name: 'Zulu', records: [[hourOf(BASE - DAY), 'codex', 'gpt-b', 1, 1, 1, 1]] },
    { machineId: OTHER, name: 'alpha', records: [[hourOf(BASE - DAY), 'pi', 'b', 1, 0, 0, 0], [hourOf(BASE - DAY), 'codex', 'z', 2, 0, 0, 0], [hourOf(BASE - 2 * DAY), 'pi', 'a', 3, 0, 0, 0]] },
    { machineId: MEMBER, name: 'engine-b', records: [[hourOf(BASE - DAY), 'codex', 'gpt-a', 0, 0, 0, 9]] },
  ]));
  const member = (machineId, name, usageRecords) => ({ machineId, name, state: 'online', lastReportAtMs: BASE, usage: usageRecords });
  const document = await usage.exportAll([
    member(SELF, 'engine-a', [{ app: 'codex', model: 'gpt-x', hourMs: hourOf(BASE), tokens: tokens(1, 1, 1, 1) }]),
    member('d'.repeat(16), 'empty', []),
    member(MEMBER, 'engine-b', [{ app: 'codex', model: 'gpt-a', hourMs: hourOf(BASE - DAY), tokens: tokens(5, 0, 0, 1) }]),
    member(MEMBER, 'engine-b', [{ app: 'codex', model: 'gpt-a', hourMs: hourOf(BASE - DAY), tokens: tokens(7, 0, 0, 1) }]),
  ]);
  assert.deepEqual(Object.keys(document), ['format', 'version', 'exportedAtMs', 'machines']);
  assert.deepEqual([document.format, document.version, document.exportedAtMs], ['asb-usage-export', 1, BASE]);
  assert.deepEqual(document.machines, [
    { machineId: SELF, name: 'engine-a', records: [[hourOf(BASE - 3 * DAY), 'claude', 'claude-test-5', 10, 1000, 50, 9], [hourOf(BASE - HOUR), 'claude', 'claude-test-5', 10, 1000, 50, 7]] },
    // Both replies of the member went into the ledger: the larger value of each.
    { machineId: MEMBER, name: 'engine-b', records: [[hourOf(BASE - DAY), 'codex', 'gpt-a', 7, 0, 0, 9]] },
    { machineId: OTHER, name: 'alpha', records: [[hourOf(BASE - 2 * DAY), 'pi', 'a', 3, 0, 0, 0], [hourOf(BASE - DAY), 'codex', 'z', 2, 0, 0, 0], [hourOf(BASE - DAY), 'pi', 'b', 1, 0, 0, 0]] },
    { machineId: 'e'.repeat(16), name: 'Zulu', records: [[hourOf(BASE - DAY), 'codex', 'gpt-b', 1, 1, 1, 1]] }]);
  // The export is a valid import file.
  assert.equal((await usage.importAll(document)).machines.length, 4);
  const anonymous = service({ machine: {}, cacheDir: path.join(root, 'anonymous-cache'), ledgerFile: path.join(root, 'anonymous', 'usage-ledger.json') });
  await assert.rejects(anonymous.exportAll([]), (error) => error.statusCode === 409 && error.message === 'ASB has no machine ID yet. Start ASB again.');
  assert.equal(fetches.length, 0);
});

test('the background refresh scans after ten minutes, then each hour, frees the scan cache when nobody asks, and stops cleanly', async (t) => {
  const { root, write, service, clock, fetches } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7), claudeLine(BASE - 3 * DAY, 2, 9)]);
  const pending = [];
  const timers = {
    setTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; pending.push(timer); return timer; },
    clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index !== -1) pending.splice(index, 1); },
  };
  // Runs the one pending ledger timer; the clock moves by its delay, less the time that the test already moved it.
  // The release timers of the usage requests stay pending (a separate test fires them).
  const fire = async (movedMs = 0) => {
    const ticks = pending.filter((timer) => timer.delayMs !== RELEASE_AFTER_MS);
    assert.equal(ticks.length, 1);
    const [timer] = pending.splice(pending.indexOf(ticks[0]), 1);
    clock.ms += timer.delayMs - movedMs;
    await timer.callback();
    return timer.delayMs;
  };
  const usage = service({ timers });
  const expected = service({ ledgerFile: '', cacheDir: path.join(root, 'expected-cache') });
  usage.start();
  usage.start();
  assert.deepEqual(pending.map((timer) => timer.delayMs), [LEDGER_FIRST_MS]);
  assert.equal(usage.stats.scans, 0);
  assert.equal(await fire(), LEDGER_FIRST_MS);
  assert.equal(usage.stats.scans, 1);
  assert.equal(usage.stats.releases, 1);
  assert.equal(usage.stats.ledgerSaves, 1);
  assert.deepEqual(pending.map((timer) => timer.delayMs), [LEDGER_REFRESH_MS]);
  assert.equal(fetches.length, 0);
  // The ledger alone gives the same totals right away, and again after the scan reads the cache.
  await settle(expected);
  expected.report('all');
  const reference = sums(expected.report('all'));
  // A report more than refreshMs after the last scan starts a new one.
  clock.ms += 10_000;
  const right = usage.report('all');
  assert.equal(usage.stats.scans, 1);
  assert.deepEqual(sums(right), reference);
  await usage.idle();
  assert.equal(usage.stats.scans, 2);
  assert.deepEqual(sums(usage.report('all')), reference);
  // An ask in the last 2 minutes keeps the cache.
  clock.ms += LEDGER_REFRESH_MS - 60_000;
  usage.localHourly('24h');
  await usage.idle();
  assert.equal(await fire(LEDGER_REFRESH_MS - 60_000), LEDGER_REFRESH_MS);
  assert.equal(usage.stats.scans, 4);
  assert.equal(usage.stats.releases, 1);
  await fire();
  assert.equal(usage.stats.releases, 2);
  // stop() clears the timer and saves the growth that waits for the five-minute interval.
  await write('b.jsonl', [claudeLine(BASE - 2 * HOUR, 3, 1)]);
  await usage.refresh();
  const saves = usage.stats.ledgerSaves;
  await write('c.jsonl', [claudeLine(BASE - 4 * HOUR, 4, 1)]);
  await usage.refresh();
  assert.equal(usage.stats.ledgerSaves, saves);
  await usage.stop();
  assert.deepEqual(pending, []);
  assert.equal(usage.stats.ledgerSaves, saves + 1);
  usage.start();
  assert.deepEqual(pending, []);
});

for (const scenario of ['idle', 'maximum wait', 'stop', 'report', 'localHourly', 'exportAll', 'importAll']) {
  test(`a busy ledger tick waits: ${scenario}`, async (t) => {
    const { write, service, clock, fetches } = await setup(t);
    await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
    const pending = [];
    const timers = {
      setTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; pending.push(timer); return timer; },
      clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index !== -1) pending.splice(index, 1); },
    };
    const fire = async (delayMs) => {
      const index = pending.findIndex((timer) => timer.delayMs === delayMs);
      assert.notEqual(index, -1);
      const [timer] = pending.splice(index, 1);
      clock.ms += delayMs;
      await timer.callback();
    };
    let busy = true;
    const usage = service({ timers, busy: () => busy });
    usage.start();
    await fire(LEDGER_FIRST_MS);
    assert.equal(usage.stats.scans, 0);
    assert.deepEqual(pending.map((timer) => timer.delayMs), [60_000]);
    if (scenario === 'stop') {
      const waiting = pending[0];
      await usage.stop();
      assert.deepEqual(pending, []);
      await waiting.callback();
      assert.equal(usage.stats.scans, 0);
      return;
    }
    if (scenario === 'maximum wait') {
      for (let minute = 1; minute < 60; minute += 1) {
        await fire(60_000);
        assert.equal(usage.stats.scans, 0);
      }
    } else if (scenario === 'idle') {
      await fire(60_000);
      assert.equal(usage.stats.scans, 0);
      busy = false;
    } else {
      if (scenario === 'report') usage.report('all');
      if (scenario === 'localHourly') usage.localHourly('all');
      if (scenario === 'exportAll') await usage.exportAll();
      if (scenario === 'importAll') {
        // Imports merge the ledger at once, without starting a transcript scan.
        await usage.importAll(exportFile([{ machineId: OTHER, name: 'retired', records: [] }], clock.ms));
        assert.equal(usage.stats.scans, 0);
        assert.equal(usage.stats.ledgerSaves, 1);
      } else {
        await usage.idle();
        assert.equal(usage.stats.scans, 1);
      }
      assert.ok(pending.some((timer) => timer.delayMs === 60_000));
      return;
    }
    await fire(60_000);
    assert.equal(usage.stats.scans, 1);
    assert.equal(fetches.length, 0);
    assert.deepEqual(pending.map((timer) => timer.delayMs), [LEDGER_REFRESH_MS]);
    // The next due tick has its own full waiting limit.
    busy = true;
    await fire(LEDGER_REFRESH_MS);
    assert.equal(usage.stats.scans, 1);
    assert.deepEqual(pending.map((timer) => timer.delayMs), [60_000]);
  });
}

test('the scan cache goes 2 minutes after the last usage request, saved when it changed, never during a scan', async (t) => {
  const { write, service, clock } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const pending = [];
  const timers = {
    setTimeout: (callback, delayMs) => { const timer = { callback, delayMs, atMs: clock.ms }; pending.push(timer); return timer; },
    clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index !== -1) pending.splice(index, 1); },
  };
  // Runs the one pending release timer at its time.
  const fire = async () => {
    assert.equal(pending.length, 1);
    const [timer] = pending.splice(0, 1);
    assert.equal(timer.delayMs, RELEASE_AFTER_MS);
    clock.ms = timer.atMs + timer.delayMs;
    await timer.callback();
    return timer;
  };
  const until = async (check) => { for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
  assert.equal(RELEASE_AFTER_MS, 2 * 60 * 1000);
  const usage = service({ timers });
  usage.localHourly('all');
  await usage.idle();
  assert.equal(pending.length, 1);
  // A grown file within the save interval leaves the cache changed and not saved.
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7), claudeLine(BASE - 2 * HOUR, 2, 5)]);
  clock.ms += 10_000;
  await usage.refresh();
  const saves = usage.stats.saves;
  const before = usage.localHourly('all').usage;
  assert.equal(before.length, 2);
  await usage.idle();
  // An ask 1 minute later moves the release to 3 minutes after the first ask; there is one timer at most.
  clock.ms += 60_000;
  usage.localHourly('all');
  await usage.idle();
  assert.equal(pending.length, 1);
  assert.equal((await fire()).atMs + RELEASE_AFTER_MS, BASE + 70_000 + RELEASE_AFTER_MS);
  assert.equal(usage.stats.releases, 1);
  assert.equal(usage.stats.saves, saves + 1);
  assert.deepEqual(pending, []);
  // The ledger shows the same totals at once; a new scan reads the cache file again, not the transcripts.
  const read = usage.stats.bytesRead;
  assert.deepEqual(usage.localHourly('all').usage, before);
  await usage.idle();
  assert.equal(usage.stats.bytesRead, read);
  assert.deepEqual(usage.localHourly('all').usage, before);
  // A release time during a scan waits for the scan to end.
  clock.ms += 10_000;
  usage.localHourly('all');
  const [during] = pending.splice(0, 1);
  clock.ms = during.atMs + during.delayMs;
  await during.callback();
  assert.equal(usage.stats.releases, 1);
  await usage.idle();
  await until(() => usage.stats.releases === 2);
  assert.equal(usage.stats.releases, 2);
  // stop() leaves no release timer.
  usage.localHourly('all');
  assert.equal(pending.length, 1);
  await usage.stop();
  assert.deepEqual(pending, []);
});

test('the background refresh keeps the usage of the online members each hour, and a failing group changes nothing', async (t) => {
  const { service, clock, ledgerFile } = await setup(t);
  const pending = [];
  const timers = {
    setTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; pending.push(timer); return timer; },
    clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index !== -1) pending.splice(index, 1); },
  };
  // Runs the one pending timer; the clock moves by its delay, less the time that the test already moved it.
  const fire = async (movedMs = 0) => {
    assert.equal(pending.length, 1);
    const [timer] = pending.splice(0, 1);
    clock.ms += timer.delayMs - movedMs;
    await timer.callback();
    return timer.delayMs;
  };
  const hour = hourOf(BASE - 2 * HOUR);
  let replies = [{ machineId: MEMBER, name: 'engine-b', state: 'online', lastReportAtMs: BASE - 1000,
    usage: [{ hourMs: hour, app: 'codex', model: 'gpt-test-1', tokens: tokens(1, 2, 3, 4) }] }];
  let calls = 0;
  let fail = false;
  const members = async () => { calls += 1; if (fail) throw new Error('offline'); return replies; };
  const usage = service({ timers, members });
  usage.start();
  await fire();
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).machines, [
    { machineId: MEMBER, name: 'engine-b', exportedAtMs: BASE - 1000, records: [[hour, 'codex', 'gpt-test-1', 1, 2, 3, 4]] },
  ]);
  replies = [{ machineId: MEMBER, name: 'engine-b', state: 'online', lastReportAtMs: BASE + HOUR, usage: [
    { hourMs: hour, app: 'codex', model: 'gpt-test-1', tokens: tokens(5, 2, 3, 4) },
    { hourMs: hour + HOUR, app: 'codex', model: 'gpt-test-1', tokens: tokens(0, 0, 0, 9) },
  ] }];
  await fire();
  assert.equal(calls, 2);
  const saved = await fs.readFile(ledgerFile, 'utf8');
  assert.deepEqual(JSON.parse(saved).machines, [
    { machineId: MEMBER, name: 'engine-b', exportedAtMs: BASE + HOUR, records: [
      [hour, 'codex', 'gpt-test-1', 5, 2, 3, 4], [hour + HOUR, 'codex', 'gpt-test-1', 0, 0, 0, 9],
    ] },
  ]);
  fail = true;
  await fire();
  assert.equal(calls, 3);
  assert.equal(await fs.readFile(ledgerFile, 'utf8'), saved);
  assert.deepEqual(pending.map((timer) => timer.delayMs), [LEDGER_REFRESH_MS]);
  await usage.stop();
  const withoutLedger = service({ timers, members, ledgerFile: '' });
  withoutLedger.start();
  assert.deepEqual(pending, []);
  assert.equal(calls, 3);
});

test('background scans and exports never download prices; only report does', async (t) => {
  const { write, service, fetches } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const pending = [];
  const usage = service({ timers: { setTimeout: (callback) => { pending.push(callback); return {}; }, clearTimeout: () => {} } });
  usage.start();
  await pending.shift()();
  await usage.exportAll([]);
  usage.localHourly('all');
  await usage.idle();
  assert.equal(fetches.length, 0);
  usage.report('all');
  await usage.pricesIdle();
  assert.equal(fetches.length, 1);
});

const ledgerText = (selfRecords, machines = []) => JSON.stringify({ version: 1, self: { machineId: SELF, name: 'engine-a', records: selfRecords }, machines });

test('a ledger with open modes loads and becomes private; a linked ledger is kept as it is and never written', { skip: windows }, async (t) => {
  const { root, write, service, ledgerFile, logs } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const folder = path.dirname(ledgerFile);
  await fs.mkdir(folder, { recursive: true });
  await fs.chmod(folder, 0o755);
  await fs.writeFile(ledgerFile, ledgerText([[hourOf(BASE - 3 * DAY), 'claude', 'claude-test-5', 1, 2, 3, 4]]));
  await fs.chmod(ledgerFile, 0o644);
  const usage = service();
  await usage.refresh();
  assert.deepEqual(usage.localHourly('all').usage.map(({ hourMs }) => hourMs), [hourOf(BASE - 3 * DAY), hourOf(BASE - HOUR)]);
  assert.deepEqual(await fs.readdir(folder), ['usage-ledger.json', 'usage-tiers.json']);
  assert.equal((await fs.stat(ledgerFile)).mode & 0o777, 0o600);
  assert.equal(usage.stats.ledgerSaves, 1);
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  assert.deepEqual(logs, []);
  await usage.stop();

  // A link at the ledger path: not read, not renamed, not replaced.
  const target = path.join(root, 'elsewhere.json');
  const text = ledgerText([[hourOf(BASE - 2 * DAY), 'claude', 'claude-test-5', 1, 2, 3, 4]]);
  await fs.writeFile(target, text, { mode: 0o600 });
  await fs.rm(ledgerFile);
  await fs.symlink(target, ledgerFile);
  const linked = service({ cacheDir: path.join(root, 'linked-cache') });
  await linked.refresh();
  await write('b.jsonl', [claudeLine(BASE - 2 * HOUR, 2, 3)]);
  await linked.refresh();
  await assert.rejects(linked.importAll(exportFile([{ machineId: OTHER, name: 'retired', records: [] }])), { statusCode: 500, message: 'ASB could not save the usage ledger. Keep the export file and try again.' });
  await linked.stop();
  assert.ok(!linked.localHourly('all').usage.some(({ hourMs }) => hourMs === hourOf(BASE - 2 * DAY)));
  assert.deepEqual(logs, ['ASB cannot read its usage ledger. It saves no usage history now.']);
  assert.equal(linked.stats.ledgerSaves, 0);
  assert.deepEqual(await fs.readdir(folder), ['usage-ledger.json', 'usage-tiers.json']);
  assert.equal(await fs.readlink(ledgerFile), target);
  assert.equal(await fs.readFile(target, 'utf8'), text);
});

test('records after the clock in the ledger file load, and its export leaves them out and still imports', async (t) => {
  const { service, ledgerFile } = await setup(t);
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const late = hourOf(BASE + 2 * DAY);
  const early = hourOf(BASE - DAY);
  await fs.writeFile(ledgerFile, ledgerText([[early, 'claude', 'claude-test-5', 1, 0, 0, 1], [late, 'claude', 'claude-test-5', 1, 0, 0, 1]],
    [{ machineId: OTHER, name: 'retired', exportedAtMs: BASE, records: [[early, 'codex', 'gpt-test-1', 1, 0, 0, 1], [late, 'codex', 'gpt-test-1', 1, 0, 0, 1]] }]), { mode: 0o600 });
  const usage = service();
  const document = await usage.exportAll([]);
  assert.deepEqual(await fs.readdir(path.dirname(ledgerFile)), ['usage-ledger.json', 'usage-tiers.json']);
  assert.deepEqual(document.machines.map(({ machineId, records }) => [machineId, records.map((record) => record[0])]), [[SELF, [early]], [OTHER, [early]]]);
  assert.equal((await usage.importAll(document)).machines.length, 2);
});

test('the export gives this machine a group name, so it imports', async (t) => {
  const { service } = await setup(t);
  const usage = service({ machine: { machineId: SELF, name: 'This PC' } });
  await usage.importAll(exportFile([{ machineId: OTHER, name: 'retired', records: [[hourOf(BASE - DAY), 'codex', 'gpt-test-1', 1, 0, 0, 1]] }]));
  const document = await usage.exportAll([]);
  assert.equal(document.machines[0].name, 'ThisPC');
  assert.deepEqual((await usage.importAll(document)).machines.map(({ name }) => name), ['ThisPC', 'retired']);
});

test('stop does not wait for a scan that has not read its files', async (t) => {
  const { write, service, ledgerFile } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const usage = service();
  usage.refresh();
  await usage.stop();
  assert.equal(usage.stats.scans, 0);
  const saved = await fs.readFile(ledgerFile, 'utf8').then(JSON.parse, () => null);
  assert.deepEqual(saved?.self.records ?? [], []);
});

test('member replies go into the ledger once, so an offline member stays in report and export after a restart', async (t) => {
  const { root, ledgerFile, service } = await setup(t);
  const usage = service();
  await settle(usage);
  const hour = hourOf(BASE - 2 * HOUR);
  const reply = [{ app: 'codex', model: 'gpt-test-1', hourMs: hour, tokens: tokens(1, 2, 3, 4) }];
  const online = { machineId: MEMBER, name: 'engine-b', state: 'online', lastReportAtMs: BASE - 1000, usage: reply, scan: { complete: true, files: 1, scannedFiles: 1 } };
  usage.report('30d', [online]);
  await usage.flush();
  const saves = usage.stats.ledgerSaves;
  const saved = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  assert.deepEqual(saved.machines, [{ machineId: MEMBER, name: 'engine-b', exportedAtMs: BASE - 1000, records: [[hour, 'codex', 'gpt-test-1', 1, 2, 3, 4]] }]);
  // The same reply array merges once: even a record added to it is not read again, and the next flush saves nothing (stats.ledgerSaves stays).
  reply.push({ app: 'codex', model: 'gpt-test-2', hourMs: hour, tokens: tokens(1, 1, 1, 1) });
  usage.report('30d', [online]);
  await usage.exportAll([online]);
  await usage.flush();
  assert.equal(usage.stats.ledgerSaves, saves);
  reply.pop();

  const restarted = service({ cacheDir: path.join(root, 'cache-2') });
  await settle(restarted);
  const offline = { machineId: MEMBER, name: 'engine-b', state: 'offline', lastReportAtMs: 0, usage: [], scan: { complete: true, files: 0, scannedFiles: 0 } };
  const report = restarted.report('all', [offline]);
  assert.deepEqual(report.machines.find((item) => item.machineId === MEMBER), { machineId: MEMBER, name: 'engine-b', self: false, state: 'offline', lastReportAtMs: 0 });
  assert.deepEqual(sums(report, MEMBER).map(([app, model, , value]) => [app, model, value]), [['codex', 'gpt-test-1', tokens(1, 2, 3, 4)]]);
  assert.deepEqual((await restarted.exportAll([offline])).machines.find((item) => item.machineId === MEMBER),
    { machineId: MEMBER, name: 'engine-b', records: [[hour, 'codex', 'gpt-test-1', 1, 2, 3, 4]] });
});

test('only valid members and records go into the ledger, and the saved file loads without being set aside', async (t) => {
  const { ledgerFile, service, root } = await setup(t);
  const usage = service();
  await settle(usage);
  const hour = hourOf(BASE - 2 * HOUR);
  const good = { app: 'codex', model: 'gpt-test-1', hourMs: hour, tokens: tokens(1, 2, 3, 4) };
  const member = (extra) => ({ machineId: MEMBER, name: 'engine-b', state: 'online', lastReportAtMs: BASE, usage: [good], ...extra });
  usage.report('30d', [
    member({ usage: [good, { ...good, tokens: tokens(1.5, 0, 0, 0) }, { ...good, hourMs: hour + 60_000 }, { ...good, app: 'Bad App' }] }),
    member({ machineId: OTHER, name: '-bad' }),
    member({ machineId: 'C'.repeat(16), name: 'upper' }),
    member({ machineId: 'd'.repeat(15), name: 'short' }),
    member({ machineId: SELF, name: 'engine-a', usage: [{ ...good, model: 'self-copy' }] }),
  ]);
  await usage.flush();
  const saved = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  assert.deepEqual(saved.machines, [{ machineId: MEMBER, name: 'engine-b', exportedAtMs: BASE, records: [[hour, 'codex', 'gpt-test-1', 1, 2, 3, 4]] }]);
  assert.equal(saved.self.records.some((record) => record[2] === 'self-copy'), false);
  const again = service({ cacheDir: path.join(root, 'cache-2') });
  await settle(again);
  assert.deepEqual((await again.exportAll([])).machines.map((item) => item.machineId), [SELF, MEMBER]);
  assert.deepEqual((await fs.readdir(path.dirname(ledgerFile))).filter((name) => name.endsWith('.bad.json')), []);
});

for (const method of ['report', 'localHourly']) {
  test(`ledger requests use saved totals while busy: ${method}`, async (t) => {
    const { service, write, clock, projects } = await setup(t);
    let busy = false, changes = 0;
    const options = { busy: () => busy, changes: () => changes };
    await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
    const usage = service(options);
    await usage.ready();
    await settle(usage);
    busy = true;
    changes += 1;
    clock.ms += LEDGER_REFRESH_MS;
    await fs.rm(path.join(projects, 'a.jsonl'));
    const check = (reply) => {
      assert.equal(reply.scan.complete, true);
      const records = method === 'report' ? reply.records : reply.usage;
      assert.equal(records.reduce((sum, row) => sum + row.tokens.output, 0), 7);
    };
    check(usage[method]('all'));
    await usage.idle();
    assert.equal(usage.stats.scans, 1);
    await usage.stop();
    const restarted = service(options);
    await restarted.ready();
    check(restarted[method]('all'));
    await restarted.idle();
    assert.equal(restarted.stats.scans, 0);
    assert.equal(restarted.stats.bytesRead, 0);
  });
}

test('a busy new install scans on its first ledger request', async (t) => {
  const { service, write } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  const usage = service({ busy: () => true, changes: () => 0 });
  await usage.ready();
  assert.equal(usage.report('all').scan.complete, false);
  await usage.idle();
  assert.equal(usage.stats.scans, 1);
  assert.equal(usage.localHourly('all').usage[0].tokens.output, 7);
});

test('idle ledger requests scan only for local changes or 5 minutes since scan start, with the 10 second limit', async (t) => {
  const { service, write, clock } = await setup(t);
  await write('a.jsonl', [claudeLine(BASE - HOUR, 1, 7)]);
  let changes = 0;
  const usage = service({ changes: () => changes });
  await usage.ready();
  usage.report('all');
  await usage.idle();
  clock.ms += 10_000;
  usage.report('all');
  usage.localHourly('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 1);
  changes += 1;
  usage.localHourly('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 2);
  changes += 1;
  usage.report('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 2);
  clock.ms += 10_000;
  usage.report('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 3);
  clock.ms += 5 * 60_000 - 1;
  usage.report('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 3);
  clock.ms += 1;
  usage.localHourly('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 4);
});

test('ledger requests without changes keep the 10 second refresh rule', async (t) => {
  const { service, clock } = await setup(t);
  const usage = service({ busy: () => true });
  await usage.refresh();
  clock.ms += 10_000;
  usage.report('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 2);
  clock.ms += 10_000;
  usage.localHourly('all');
  await usage.idle();
  assert.equal(usage.stats.scans, 3);
});

test('the ledger tick and export still scan while request scans are gated', async (t) => {
  const { service, clock } = await setup(t);
  const pending = [];
  const usage = service({ changes: () => 0, timers: {
    setTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; pending.push(timer); return timer; },
    clearTimeout: (timer) => { const index = pending.indexOf(timer); if (index !== -1) pending.splice(index, 1); },
  } });
  await usage.ready();
  await usage.refresh();
  usage.start();
  const timer = pending.find((item) => item.delayMs === LEDGER_FIRST_MS);
  clock.ms += LEDGER_FIRST_MS;
  await timer.callback();
  assert.equal(usage.stats.scans, 2);
  await usage.exportAll();
  assert.equal(usage.stats.scans, 3);
});

const usageLine = (atMs, id, usage, model = 'claude-test-5') => JSON.stringify({ type: 'assistant', timestamp: iso(atMs), requestId: `r-${id}`,
  message: { id: `m-${id}`, model, content: [], usage } });
const LONG = { input_tokens: 10, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 50, output_tokens: 7 };
const tiersOf = async (ledgerFile) => JSON.parse(await fs.readFile(path.join(path.dirname(ledgerFile), 'usage-tiers.json'), 'utf8'));

test('the tier start: 0 for a ledger with no records of this machine, saved once and kept', async (t) => {
  const { root, write, service, ledgerFile } = await setup(t);
  await write('a.jsonl', [usageLine(BASE - HOUR, 1, LONG)]);
  const usage = service();
  await usage.refresh();
  assert.deepEqual(await tiersOf(ledgerFile), { version: 1, fromMs: 0 });
  assert.deepEqual(usage.localHourly('all').usage.map(({ model }) => model), ['claude-test-5[200k+]']);
  // The scan cache was loaded and saved with the start.
  assert.equal(JSON.parse(gunzipSync(await fs.readFile(path.join(root, 'cache', 'usage', 'usage-cache.json.gz'))).toString('utf8')).t, 0);
  await usage.stop();
  // The ledger now has records of this machine, but the saved start stays.
  const next = service({ cacheDir: path.join(path.dirname(ledgerFile), 'next-cache') });
  await next.refresh();
  assert.deepEqual(await tiersOf(ledgerFile), { version: 1, fromMs: 0 });
  assert.deepEqual(next.localHourly('all').usage.map(({ model }) => model), ['claude-test-5[200k+]']);
});

test('the tier start: the next UTC hour for an untagged ledger, the first tagged hour, and a new value for a bad file', async (t) => {
  const { service, ledgerFile, clock } = await setup(t);
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  const tiersFile = path.join(path.dirname(ledgerFile), 'usage-tiers.json');
  // Imported machines do not count.
  await fs.writeFile(ledgerFile, ledgerText([], [{ machineId: OTHER, name: 'retired', exportedAtMs: BASE, records: [[hourOf(BASE - DAY), 'codex', 'gpt-test-1', 1, 0, 0, 1]] }]), { mode: 0o600 });
  let usage = service();
  await usage.ready();
  assert.deepEqual(await tiersOf(ledgerFile), { version: 1, fromMs: 0 });
  await usage.stop();
  await fs.rm(tiersFile);
  await fs.writeFile(ledgerFile, ledgerText([[hourOf(BASE - DAY), 'claude', 'claude-test-5', 1, 0, 0, 1]]), { mode: 0o600 });
  usage = service();
  await usage.ready();
  assert.deepEqual(await tiersOf(ledgerFile), { version: 1, fromMs: hourOf(clock.ms) + HOUR });
  await usage.stop();
  for (const bad of [{ version: 1, fromMs: hourOf(BASE) + 1 }, { version: 2, fromMs: 0 }, { version: 1, fromMs: -HOUR }, { fromMs: 0 }]) {
    await fs.writeFile(tiersFile, JSON.stringify(bad), { mode: 0o600 });
    await fs.writeFile(ledgerFile, ledgerText([[hourOf(BASE - DAY), 'claude', 'claude-test-5', 1, 0, 0, 1],
      [hourOf(BASE - 3 * HOUR), 'claude', 'claude-test-5[1h]', 0, 0, 1, 0], [hourOf(BASE - 2 * HOUR), 'codex', 'gpt-test-1[272k+]', 1, 0, 0, 1]]), { mode: 0o600 });
    usage = service();
    await usage.ready();
    assert.deepEqual(await tiersOf(ledgerFile), { version: 1, fromMs: hourOf(BASE - 3 * HOUR) }, JSON.stringify(bad));
    await usage.stop();
  }
});

test('a failed save of the tier start logs once and keeps the value for the run', async (t) => {
  const { write, service, ledgerFile, logs } = await setup(t);
  await write('a.jsonl', [usageLine(BASE - HOUR, 1, LONG)]);
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (String(file).includes('usage-tiers.json.')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return open(file, ...args);
  });
  const usage = service();
  await usage.refresh();
  await usage.refresh();
  assert.deepEqual(logs, ['ASB cannot save the start of its usage price tiers. It keeps it for this run.']);
  assert.deepEqual(usage.localHourly('all').usage.map(({ model }) => model), ['claude-test-5[200k+]']);
});

test('without a ledger file the tiers start at 0 and no tier file is written', async (t) => {
  const { root, write, service } = await setup(t);
  await write('a.jsonl', [usageLine(BASE - HOUR, 1, LONG)]);
  const usage = service({ ledgerFile: '' });
  await usage.refresh();
  assert.deepEqual(usage.localHourly('all').usage.map(({ model }) => model), ['claude-test-5[200k+]']);
  await assert.rejects(fs.access(path.join(root, 'config')), { code: 'ENOENT' });
});

test('no double count: an untagged ledger hour before the tier start and the live scan of the same transcript count once', async (t) => {
  const { write, service, ledgerFile, clock } = await setup(t);
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
  // The ledger of the version before tier tags, and the transcript that it came from.
  await fs.writeFile(ledgerFile, ledgerText([[hourOf(BASE - HOUR), 'claude', 'claude-test-5', 10, 250_000, 50, 7]]), { mode: 0o600 });
  await write('a.jsonl', [usageLine(BASE - HOUR, 1, LONG)]);
  const usage = service();
  await settle(usage);
  assert.deepEqual(usage.localHourly('all').usage.map(({ model, tokens: value }) => [model, value]), [['claude-test-5', tokens(10, 250_000, 50, 7)]]);
  assert.deepEqual(sums(usage.report('30d')).map((record) => record[3]), [tokens(10, 250_000, 50, 7)]);
  // A new request after the tier start is tagged.
  clock.ms = hourOf(BASE) + HOUR + 60_000;
  await write('b.jsonl', [usageLine(clock.ms - 1000, 2, LONG)]);
  await usage.refresh();
  assert.deepEqual(usage.localHourly('all').usage.map(({ model, hourMs }) => [model, hourMs]),
    [['claude-test-5', hourOf(BASE - HOUR)], ['claude-test-5[200k+]', hourOf(BASE) + HOUR]]);
});

test('the report folds the tagged parts into their model with summed tokens and costs; localHourly and the export keep the tags', async (t) => {
  const { write, service } = await setup(t);
  const split = { input_tokens: 3, cache_creation_input_tokens: 1000, output_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 600 } };
  await write('a.jsonl', [usageLine(BASE - HOUR, 1, LONG), usageLine(BASE - HOUR, 2, split), claudeLine(BASE - HOUR, 3, 9),
    usageLine(BASE - HOUR, 4, LONG, 'unknown-test'), usageLine(BASE - HOUR, 5, split, 'unknown-test')]);
  const usage = service();
  await settle(usage);
  const hourly = usage.localHourly('all').usage;
  assert.deepEqual(hourly.map(({ model }) => model), ['claude-test-5', 'claude-test-5[1h]', 'claude-test-5[200k+]', 'unknown-test', 'unknown-test[1h]', 'unknown-test[200k+]']);
  assert.deepEqual((await usage.exportAll()).machines[0].records.map((record) => record[2]), hourly.map(({ model }) => model));
  const table = parseRateTable({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } });
  const parts = hourly.filter(({ model }) => model.startsWith('claude-test-5')).map(({ model, tokens: value }) => priceTokens(table, model, value));
  const records = usage.report('30d').records.filter((record) => record.machineId === SELF);
  assert.deepEqual(records.map(({ model, maker, tokens: value }) => [model, maker, value]), [
    ['claude-test-5', 'Anthropic', tokens(10 + 3 + 10, 250_000 + 1000, 50 + 400 + 600 + 50, 7 + 2 + 9)],
    ['unknown-test', 'Other', tokens(13, 250_000, 1050, 9)]]);
  assert.deepEqual(records[0].cost, Object.fromEntries(Object.keys(parts[0]).map((field) =>
    [field, Math.round(parts.reduce((sum, cost) => sum + cost[field], 0) * 1e6) / 1e6])));
  assert.equal(records[1].cost, null);
});
