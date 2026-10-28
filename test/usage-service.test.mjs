import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createActivityUsage } from '../src/activity-usage.mjs';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR + 30 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const machine = { machineId: 'machine-test-1', name: 'test-machine' };

const codexRollout = (atMs, outputs) => {
  const lines = [JSON.stringify({ type: 'session_meta', timestamp: iso(atMs), payload: { id: `s-${atMs}`, cwd: 'SECRETFOLDER' } }),
    JSON.stringify({ type: 'turn_context', timestamp: iso(atMs), payload: { type: 'turn_context', model: 'gpt-test-1' } })];
  let input = 0, output = 0;
  outputs.forEach((value, index) => {
    input += 100; output += value;
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: iso(atMs + (index + 1) * 1000), payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: value, total_tokens: 100 + value },
      total_token_usage: { input_tokens: input, cached_input_tokens: 40 * (index + 1), output_tokens: output, total_tokens: input + output } } } }));
  });
  return `${lines.join('\n')}\n`;
};
const claudeLine = (atMs, id, output, filler = 0) => JSON.stringify({ type: 'assistant', timestamp: iso(atMs), requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-test-5', content: [{ type: 'text', text: 'SECRETTEXT'.repeat(filler) }],
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: output } } });

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-service-'));
  const services = [];
  // A report starts a price load that can still write into the cache folder after the test; on Windows the folder then cannot go.
  t.after(async () => {
    await Promise.all(services.flatMap((usage) => [usage.idle(), usage.pricesIdle()]));
    await fs.rm(root, { recursive: true, force: true });
  });
  const codexHome = path.join(root, 'codex');
  const projects = path.join(root, 'claude', 'projects');
  const openCode = path.join(root, 'opencode');
  await fs.mkdir(path.join(codexHome, 'sessions', '2026', '10'), { recursive: true });
  await fs.mkdir(path.join(projects, 'SECRETFOLDER'), { recursive: true });
  await fs.mkdir(openCode);
  // A fake LiteLLM download: tests never use the network.
  const fetches = [];
  const fetch = async (url) => {
    fetches.push(url);
    return new Response(JSON.stringify({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
      cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } }));
  };
  const sources = [
    { id: 'codex', provider: 'codex', enabled: true, dataDir: codexHome },
    { id: 'claude-desktop-code', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(root, 'claude-app'), projectsDir: projects },
    { id: 'claude-cli', provider: 'claude-desktop-code', enabled: true, dataDir: path.join(root, 'claude-app-2'), projectsDir: projects },
    { id: 'opencode', provider: 'opencode', enabled: true, dataDir: openCode },
    { id: 'off', provider: 'codex', enabled: false, dataDir: path.join(root, 'off') },
  ];
  const service = (extra = {}) => {
    const usage = createActivityUsage({ readSources: async () => sources, machine, cacheDir: path.join(root, 'cache'),
      now: () => NOW, fetch, homeDir: root, env: {}, log: () => {}, ...extra });
    services.push(usage);
    return usage;
  };
  return { root, codexHome, projects, openCode, fetches, service };
}

async function waitComplete(usage) {
  while (!usage.report('30d').scan.complete) await usage.idle();
}

test('report and localHourly match the contract shapes, with dedupe, cost, and Unpriced', async (t) => {
  const { root, codexHome, projects, openCode, fetches, service } = await setup(t);
  await fs.writeFile(path.join(codexHome, 'sessions', '2026', '10', 'rollout-a.jsonl'), codexRollout(NOW - 2 * HOUR, [20, 30]));
  await fs.writeFile(path.join(projects, 'SECRETFOLDER', 'a.jsonl'),
    `${[claudeLine(NOW - HOUR, 1, 7), claudeLine(NOW - HOUR, 1, 7), claudeLine(NOW - 40 * 24 * HOUR, 2, 9)].join('\n')}\n`);
  // A resumed transcript with a copy of message 1.
  await fs.writeFile(path.join(projects, 'SECRETFOLDER', 'b.jsonl'), `${claudeLine(NOW - HOUR, 1, 7)}\n`);
  const db = new DatabaseSync(path.join(openCode, 'opencode.db'));
  db.exec('create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)');
  db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run('x', 's', 'assistant', 0, NOW - HOUR, NOW - HOUR,
    JSON.stringify({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, model: { id: 'oc-test', providerID: 'p' } }));
  db.close();

  // The member route never loads prices.
  const member = service({ cacheDir: path.join(root, 'member-cache') });
  assert.deepEqual(member.localHourly('24h').scan, { complete: false, files: 0, scannedFiles: 0 });
  await member.idle();
  assert.equal(member.localHourly('24h').usage.length, 3);
  assert.equal(fetches.length, 0);

  const usage = service();
  const first = usage.report('30d');
  assert.equal(first.scan.complete, false);
  assert.deepEqual(first.prices, { source: 'LiteLLM', status: 'loading', fetchedAtMs: null, models: 0 });
  await waitComplete(usage);
  await usage.pricesIdle();
  const report = usage.report('30d');
  assert.deepEqual(Object.keys(report), ['period', 'nowMs', 'buckets', 'machines', 'records', 'prices', 'scan']);
  assert.equal(report.period, '30d');
  assert.equal(report.nowMs, NOW);
  assert.equal(report.buckets.unit, 'day');
  assert.equal(report.buckets.startsMs.length, 30);
  assert.deepEqual(report.machines, [{ machineId: 'machine-test-1', name: 'test-machine', self: true, state: 'local', lastReportAtMs: 0 }]);
  assert.deepEqual(report.prices, { source: 'LiteLLM', status: 'fresh', fetchedAtMs: NOW, models: 1 });
  assert.equal(fetches.length, 1);
  assert.deepEqual(report.scan, { complete: true, files: 3, scannedFiles: 3 });
  const byApp = Object.fromEntries(report.records.map((record) => [record.app, record]));
  assert.equal(report.records.length, 3);
  for (const record of report.records) {
    assert.deepEqual(Object.keys(record), ['machineId', 'app', 'model', 'maker', 'bucket', 'tokens', 'cost']);
    assert.deepEqual(Object.keys(record.tokens), ['uncached', 'cacheRead', 'cacheWrite', 'output']);
    assert.equal(record.machineId, 'machine-test-1');
  }
  // Claude: message 1 counts once over both files; message 2 is older than 30 days.
  assert.deepEqual(byApp.claude.tokens, { uncached: 10, cacheRead: 1000, cacheWrite: 50, output: 7 });
  assert.deepEqual(byApp.claude.cost, { uncached: 0.00005, cacheRead: 0.0005, cacheWrite: 0.000313, output: 0.000175, total: 0.001038, savings: 0.0045 });
  assert.deepEqual(byApp.codex.tokens, { uncached: 120, cacheRead: 80, cacheWrite: 0, output: 50 });
  assert.equal(byApp.codex.cost, null);
  assert.deepEqual(byApp.opencode.tokens, { uncached: 1, cacheRead: 4, cacheWrite: 5, output: 5 });
  assert.equal(usage.report('90d').records.find((record) => record.app === 'claude' && record.tokens.output === 9)?.app, 'claude');

  const hourly = usage.localHourly('24h');
  assert.deepEqual(Object.keys(hourly), ['usage', 'scan']);
  assert.deepEqual(hourly.scan, { complete: true, files: 3, scannedFiles: 3 });
  for (const record of hourly.usage) {
    assert.deepEqual(Object.keys(record), ['app', 'model', 'hourMs', 'tokens']);
    assert.equal(record.hourMs % HOUR, 0);
  }
  assert.deepEqual(hourly.usage.map(({ app, hourMs, tokens }) => [app, hourMs, tokens.output]).sort(),
    [['claude', NOW - 30 * 60_000 - HOUR, 7], ['codex', NOW - 30 * 60_000 - 2 * HOUR, 50], ['opencode', NOW - 30 * 60_000 - HOUR, 5]].sort());
  assert.ok(!JSON.stringify([report, hourly]).includes('SECRET'));
  assert.throws(() => usage.report('1y'), /Invalid period/);

  // A new engine starts warm from the disk cache; a deleted file drops out after the next full scan.
  await fs.rm(path.join(codexHome, 'sessions', '2026', '10', 'rollout-a.jsonl'));
  const warm = service();
  assert.equal(warm.report('30d').scan.complete, false);
  await warm.idle();
  await warm.pricesIdle();
  assert.equal(warm.stats.bytesRead, 0, 'unchanged files are not read again');
  const after = warm.report('30d');
  assert.deepEqual(after.scan, { complete: true, files: 2, scannedFiles: 2 });
  assert.deepEqual(after.records.map((record) => record.app).sort(), ['claude', 'opencode']);
  assert.equal(after.prices.status, 'cached');
  assert.equal(fetches.length, 1, 'rates younger than 24 hours come from the disk cache');
  const saved = JSON.parse(gunzipSync(await fs.readFile(path.join(root, 'cache', 'usage', 'usage-cache.json.gz'))).toString('utf8'));
  assert.equal(Object.keys(saved.files).length, 2);
});

test('the scan is lazy and does not block the event loop', async (t) => {
  const { projects, service } = await setup(t);
  // About 100 MB of transcripts: text lines, and 40,000 usage lines with text inside.
  const filler = JSON.stringify({ type: 'user', message: { content: 'SECRETTEXT'.repeat(200) } });
  let expected = 0;
  for (let file = 0; file < 40; file += 1) {
    const lines = [];
    for (let line = 0; line < 1000; line += 1) {
      lines.push(filler, claudeLine(NOW - HOUR, `${file}-${line}`, line + 1, 50));
      expected += line + 1;
    }
    await fs.writeFile(path.join(projects, 'SECRETFOLDER', `t${file}.jsonl`), `${lines.join('\n')}\n`);
  }
  const usage = service();
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const at = Date.now();
    maxGap = Math.max(maxGap, at - last);
    last = at;
  }, 10);
  t.after(() => clearInterval(timer));
  const started = Date.now();
  const first = usage.report('7d');
  assert.ok(Date.now() - started < 50, 'the first report returns at once');
  assert.equal(first.scan.complete, false);
  assert.deepEqual(first.records, []);
  await waitComplete(usage);
  clearInterval(timer);
  t.diagnostic(`scan ${Date.now() - started} ms, ${usage.stats.bytesRead} bytes, longest timer gap ${maxGap} ms`);
  assert.ok(maxGap <= 200, `the longest timer gap was ${maxGap} ms`);
  const report = usage.report('7d');
  assert.deepEqual(report.scan, { complete: true, files: 40, scannedFiles: 40 });
  assert.equal(report.records.reduce((sum, record) => sum + record.tokens.output, 0), expected);
});

test('report merges the group members into local buckets, machines, and the scan sum', async (t) => {
  const { projects, service } = await setup(t);
  // NOW is the middle of the current hour, so a minute before it is today at any time of day (an hour before can be yesterday).
  await fs.writeFile(path.join(projects, 'SECRETFOLDER', 'a.jsonl'), `${claudeLine(NOW - 60_000, 1, 7)}\n`);
  const usage = service();
  usage.report('7d');
  await usage.idle();
  await usage.pricesIdle();
  const { startsMs } = usage.report('7d').buckets;
  const tokens = (output) => ({ uncached: 1, cacheRead: 2, cacheWrite: 3, output });
  const hour = (bucket, offset = 0) => Math.floor(startsMs[bucket] / HOUR) * HOUR + HOUR + offset * HOUR;
  const members = [
    { machineId: 'machine-test-2', name: 'alpha', state: 'online', lastReportAtMs: NOW - 1000, scan: { complete: true, files: 5, scannedFiles: 5 },
      usage: [
        { app: 'codex', model: 'gpt-test-1', hourMs: hour(2), tokens: tokens(10) },
        { app: 'codex', model: 'gpt-test-1', hourMs: hour(2, 3), tokens: tokens(5) },
        { app: 'claude', model: 'claude-test-5', hourMs: hour(6), tokens: tokens(4) },
        // Before the first bucket: dropped.
        { app: 'codex', model: 'gpt-test-1', hourMs: startsMs[0] - 2 * HOUR, tokens: tokens(99) },
        // Not a valid record: dropped.
        { app: 'codex', model: 'gpt-test-1', hourMs: hour(3), tokens: { uncached: 'x' } },
      ] },
    { machineId: 'machine-test-3', name: 'beta', state: 'offline', lastReportAtMs: NOW - 86_400_000,
      scan: { complete: false, files: 7, scannedFiles: 3 }, usage: [{ app: 'opencode', model: 'oc-test', hourMs: hour(0), tokens: tokens(1) }] },
  ];
  const report = usage.report('7d', members);
  assert.deepEqual(report.machines, [
    { machineId: 'machine-test-1', name: 'test-machine', self: true, state: 'local', lastReportAtMs: 0 },
    { machineId: 'machine-test-2', name: 'alpha', self: false, state: 'online', lastReportAtMs: NOW - 1000 },
    { machineId: 'machine-test-3', name: 'beta', self: false, state: 'offline', lastReportAtMs: NOW - 86_400_000 },
  ]);
  assert.deepEqual(report.records.map(({ machineId, app, bucket, tokens: { output }, cost }) => [machineId, app, bucket, output, cost === null]), [
    ['machine-test-1', 'claude', 6, 7, false],
    ['machine-test-2', 'codex', 2, 15, true],
    ['machine-test-2', 'claude', 6, 4, false],
    ['machine-test-3', 'opencode', 0, 1, true],
  ]);
  assert.deepEqual(report.records[2].cost,
    { uncached: 0.000005, cacheRead: 0.000001, cacheWrite: 0.000019, output: 0.0001, total: 0.000125, savings: 0.000009 });
  assert.deepEqual(report.scan, { complete: false, files: 13, scannedFiles: 9 });
  assert.deepEqual(usage.report('7d', members.slice(0, 1)).scan, { complete: true, files: 6, scannedFiles: 6 });
});

test('a failing price download gives unavailable after it ends', async (t) => {
  const { service } = await setup(t);
  const usage = service({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(usage.report('7d').prices.status, 'loading');
  await usage.pricesIdle();
  assert.deepEqual(usage.report('7d').prices, { source: 'LiteLLM', status: 'unavailable', fetchedAtMs: null, models: 0 });
  await usage.idle();
});

test('the disk cache is saved after the first scan, then at most once in 5 minutes', async (t) => {
  const { projects, service } = await setup(t);
  const file = path.join(projects, 'SECRETFOLDER', 'a.jsonl');
  await fs.writeFile(file, `${claudeLine(NOW - HOUR, 1, 7)}\n`);
  let clock = NOW;
  const usage = service({ now: () => clock });
  await usage.refresh();
  assert.equal(usage.stats.saves, 1);
  await fs.appendFile(file, `${claudeLine(NOW - HOUR, 2, 3)}\n`);
  clock += 60_000;
  await usage.refresh();
  assert.equal(usage.stats.saves, 1, 'a changed scan after 1 minute does not write');
  await fs.appendFile(file, `${claudeLine(NOW - HOUR, 3, 4)}\n`);
  clock += 4 * 60_000;
  await usage.refresh();
  assert.equal(usage.stats.saves, 2, 'a changed scan after 5 minutes writes');
  assert.equal(usage.report('7d').records[0].tokens.output, 14);
  // A restart with an unchanged cache writes nothing.
  const restart = service({ now: () => clock });
  await restart.refresh();
  assert.equal(restart.stats.bytesRead, 0);
  assert.equal(restart.stats.saves, 0);
  assert.equal(restart.report('7d').records[0].tokens.output, 14);
});

test('the OpenCode query runs again only when the database or its WAL changed', async (t) => {
  const { openCode, service } = await setup(t);
  const database = path.join(openCode, 'opencode.db');
  const db = new DatabaseSync(database);
  db.exec('create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)');
  db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run('x', 's', 'assistant', 0, NOW - HOUR, NOW - HOUR,
    JSON.stringify({ tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, model: 'oc-test' }));
  db.close();
  let clock = NOW;
  const usage = service({ now: () => clock });
  await usage.refresh();
  await usage.refresh();
  assert.equal(usage.stats.openCodeQueries, 1);
  assert.equal(usage.report('7d').records.find((record) => record.app === 'opencode').tokens.output, 2);
  await fs.writeFile(`${database}-wal`, '');
  clock += 60_000;
  await usage.refresh();
  assert.equal(usage.stats.openCodeQueries, 2);
  assert.equal(usage.report('7d').records.find((record) => record.app === 'opencode').tokens.output, 2);
});

test('localHourly keeps the newest 50,000 records', async (t) => {
  const { projects, service } = await setup(t);
  // 50,010 Claude messages in different quarter hours and models over the last 89 days.
  const lines = [];
  for (let index = 0; index < 50_010; index += 1) {
    lines.push(claudeLine(NOW - 2 * HOUR - Math.floor(index / 25) * HOUR, `x${index}`, 1).replace('claude-test-5', `claude-test-${index % 25}`));
  }
  await fs.writeFile(path.join(projects, 'SECRETFOLDER', 'many.jsonl'), `${lines.join('\n')}\n`);
  const usage = service();
  usage.localHourly('90d');
  await usage.idle();
  const { usage: records } = usage.localHourly('90d');
  assert.equal(records.length, 50_000);
  assert.equal(records.at(-1).hourMs, NOW - 30 * 60_000 - 2 * HOUR);
  assert.equal(records[0].hourMs, NOW - 30 * 60_000 - 2 * HOUR - 1999 * HOUR);
});
