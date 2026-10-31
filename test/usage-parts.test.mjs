// The parts are summed once per change (per app, model, and quarter hour): the reports must give exactly the records of the
// single parts. Synthetic transcripts and databases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityUsage, MAX_HOURLY_RECORDS } from '../src/activity-usage.mjs';
import { aggregateBuckets, aggregateHourly, periodBuckets, USAGE_PERIODS } from '../src/usage-aggregation.mjs';
import { readOpenCodeUsage } from '../src/usage-opencode.mjs';
import { loadUsageCache, QUARTER_HOUR_MS } from '../src/usage-scan-cache.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12, 7, 31);
const claudeLine = (atMs, id, output) => JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(), requestId: `r-${id}`,
  message: { id: `m-${id}`, model: id.startsWith('b') ? 'claude-test-b' : 'claude-test-a',
    usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: output } } });

// A copy of allParts() before the parts were summed: every record of the cache, by file key, then OpenCode with its own time.
// A repeated key is one part: the first copy gives its app, model, and time, and each count is the largest of all copies.
function singleParts(cache, openCode) {
  const list = [];
  const keyed = new Map();
  for (const key of [...cache.keys()].sort()) {
    const { app, records } = cache.get(key);
    for (const [quarter, model, uncached, cacheRead, cacheWrite, output, dedupeKey] of records) {
      const tokens = { uncached, cacheRead, cacheWrite, output };
      const kept = keyed.get(dedupeKey);
      if (kept) for (const type of Object.keys(tokens)) kept.tokens[type] = Math.max(kept.tokens[type], tokens[type]);
      else {
        const part = { app, model, atMs: quarter * QUARTER_HOUR_MS, tokens, key: dedupeKey };
        if (dedupeKey !== null) keyed.set(dedupeKey, part);
        list.push(part);
      }
    }
  }
  for (const record of openCode) list.push({ ...record, atMs: record.timestampMs, key: null });
  return list;
}

const ZONES = { UTC: 0, 'America/New_York': 240, 'Asia/Kathmandu': -345 };

test('summed parts give the same report and localHourly records as the single parts, in three time zones', { skip: !sqlite }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-parts-'));
  const zone = process.env.TZ;
  t.after(async () => {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    await fs.rm(root, { recursive: true, force: true });
  });
  const projects = path.join(root, 'projects');
  const openCodeDir = path.join(root, 'opencode');
  await fs.mkdir(projects);
  await fs.mkdir(openCodeDir);
  // Two copies of each of two keys: whichever file comes first, one key has its first copy outside the 24h window.
  const lines = (name, first, second, output) => [claudeLine(NOW - 40 * DAY, first, output), claudeLine(NOW - 2 * HOUR, second, output + 2),
    ...Array.from({ length: 40 }, (_, index) => claudeLine(NOW - index * 37 * 60_000 - index * index * 3 * HOUR, `${name}${index}`, index + 1))];
  await fs.writeFile(path.join(projects, 'x.jsonl'), `${lines('a', 'k1', 'k2', 11).join('\n')}\n`);
  await fs.writeFile(path.join(projects, 'y.jsonl'), `${lines('b', 'k2', 'k1', 17).join('\n')}\n`);
  const db = new sqlite.DatabaseSync(path.join(openCodeDir, 'opencode.db'));
  db.exec('create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)');
  const insert = db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)');
  // Times inside quarter hours, also a few milliseconds before and after an hour.
  [NOW - HOUR, NOW - 7 * 60_000, Date.UTC(2026, 9, 20, 9, 59, 59, 999), Date.UTC(2026, 9, 20, 10, 0, 0, 1), NOW - 3 * DAY - 14 * 60_000,
    Date.UTC(2026, 6, 31, 23, 52), Date.UTC(2026, 7, 1, 0, 3)].forEach((atMs, index) => insert.run(`o${index}`, 's', 'assistant', index, atMs, atMs,
    JSON.stringify({ tokens: { input: index + 1, output: 2, reasoning: 1, cache: { read: 4, write: index } }, model: { id: `oc-${index % 2}` } })));
  db.close();
  const cacheDir = path.join(root, 'cache');
  const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir, now: () => NOW, refreshMs: Infinity, log: () => {},
    fetch: async () => { throw new Error('offline'); },
    readSources: async () => [{ enabled: true, provider: 'claude-desktop-code', projectsDir: projects }, { enabled: true, provider: 'opencode', dataDir: openCodeDir }] });
  t.after(() => Promise.all([usage.idle(), usage.pricesIdle()]));
  await usage.refresh();
  const parts = singleParts(await loadUsageCache(path.join(cacheDir, 'usage', 'usage-cache.json.gz')), await readOpenCodeUsage(openCodeDir, 0));
  assert.equal(parts.filter((part) => part.app === 'claude').length, 82);
  assert.equal(parts.filter((part) => part.app === 'opencode').length, 7);
  let zones = 0;
  for (const [name, offset] of Object.entries(ZONES)) {
    process.env.TZ = name;
    if (new Date(NOW).getTimezoneOffset() !== offset) continue;
    zones += 1;
    for (const period of Object.keys(USAGE_PERIODS)) {
      const firstMs = period === 'all' ? Math.min(...parts.map((part) => part.atMs)) : null;
      const expected = aggregateBuckets(parts, { ...periodBuckets(period, NOW, firstMs), rates: new Map() });
      const report = usage.report(period);
      assert.deepEqual(report.buckets.startsMs, periodBuckets(period, NOW, firstMs).startsMs, `${name} ${period}`);
      assert.deepEqual(report.records.map(({ app, model, bucket, tokens, cost }) => ({ app, model, bucket, tokens, cost })), expected, `${name} ${period}`);
      const days = USAGE_PERIODS[period].unit === 'hour' ? 1 : USAGE_PERIODS[period].count;
      const sinceMs = period === 'all' ? 0 : Math.floor((NOW - days * DAY - HOUR) / HOUR) * HOUR;
      assert.deepEqual(usage.localHourly(period).usage, aggregateHourly(parts, sinceMs, NOW + HOUR).slice(-MAX_HOURLY_RECORDS), `${name} ${period}`);
    }
  }
  assert.ok(zones >= 1);
  // The parts were built once for all the calls above, one for each repeated key; these single parts are in different quarter hours.
  assert.equal(usage.stats.partBuilds, 1);
  assert.equal(usage.stats.parts, parts.length);
});

test('a scan that changed nothing keeps the parts, and a changed file builds them again', { skip: !sqlite }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-parts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const openCodeDir = path.join(root, 'opencode');
  await fs.mkdir(projects);
  await fs.mkdir(openCodeDir);
  const file = path.join(projects, 'a.jsonl');
  await fs.writeFile(file, `${claudeLine(NOW - HOUR, 'a1', 5)}\n`);
  const db = new sqlite.DatabaseSync(path.join(openCodeDir, 'opencode.db'));
  db.exec('create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)');
  db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run('o', 's', 'assistant', 0, NOW - HOUR, NOW - HOUR,
    JSON.stringify({ tokens: { input: 1, output: 2 }, model: { id: 'oc-test' } }));
  db.close();
  const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'cache'), now: () => NOW, refreshMs: Infinity,
    log: () => {}, fetch: async () => { throw new Error('offline'); },
    readSources: async () => [{ enabled: true, provider: 'claude-desktop-code', projectsDir: projects }, { enabled: true, provider: 'opencode', dataDir: openCodeDir }] });
  t.after(() => Promise.all([usage.idle(), usage.pricesIdle()]));
  await usage.refresh();
  assert.equal(usage.report('24h').records.length, 2);
  assert.equal(usage.stats.partBuilds, 1);
  await usage.refresh();
  assert.equal(usage.report('24h').records.length, 2);
  assert.equal(usage.stats.partBuilds, 1);
  await fs.appendFile(file, `${claudeLine(NOW - HOUR, 'a2', 5)}\n`);
  await usage.refresh();
  assert.equal(usage.report('24h').records[0].tokens.output, 10);
  assert.equal(usage.stats.partBuilds, 2);
});

test('two transcript files with the same message key count it once with the larger counts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-parts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  await fs.mkdir(projects);
  // The resumed copy ended while the reply still streamed (output 50); the original has the final count (output 120).
  await fs.writeFile(path.join(projects, 'a.jsonl'), `${claudeLine(NOW - HOUR, 'k', 50)}\n`);
  await fs.writeFile(path.join(projects, 'b.jsonl'), `${claudeLine(NOW - HOUR, 'k', 120)}\n`);
  const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'cache'), now: () => NOW, refreshMs: Infinity,
    log: () => {}, fetch: async () => { throw new Error('offline'); },
    readSources: async () => [{ enabled: true, provider: 'claude-desktop-code', projectsDir: projects }] });
  t.after(() => Promise.all([usage.idle(), usage.pricesIdle()]));
  await usage.refresh();
  assert.deepEqual(usage.report('24h').records.map(({ tokens }) => tokens), [{ uncached: 3, cacheRead: 5, cacheWrite: 7, output: 120 }]);
  assert.deepEqual(usage.localHourly('24h').usage.map(({ tokens }) => tokens), [{ uncached: 3, cacheRead: 5, cacheWrite: 7, output: 120 }]);
});
