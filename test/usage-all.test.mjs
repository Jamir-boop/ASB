import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityUsage } from '../src/activity-usage.mjs';
import { pathKey, saveUsageCache, scanFile } from '../src/usage-scan-cache.mjs';

const NOW = new Date(2026, 9, 20, 12, 30).getTime();
const OLD = NOW - 120 * 24 * 3_600_000;
const tokens = { uncached: 2, cacheRead: 3, cacheWrite: 4, output: 5 };
const line = (at, id) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), requestId: id,
  message: { id, model: 'claude-test', usage: { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens: 5 } } });

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-all-'));
  const projects = path.join(root, 'projects');
  await fs.mkdir(projects);
  const services = [];
  t.after(async () => {
    await Promise.all(services.flatMap((usage) => [usage.idle(), usage.pricesIdle()]));
    await fs.rm(root, { recursive: true, force: true });
  });
  const service = (extra = {}) => {
    const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'cache'), now: () => NOW,
      readSources: async () => [{ enabled: true, provider: 'claude-desktop-code', projectsDir: projects }],
      refreshMs: Infinity, fetch: async () => { throw new Error('offline'); }, ...extra });
    services.push(usage);
    return usage;
  };
  return { root, projects, service };
}

test('All time uses local and member months, including a 120-day-old transcript and its old hour', async (t) => {
  const { projects, service } = await setup(t);
  const file = path.join(projects, 'old.jsonl');
  await fs.writeFile(file, `${line(OLD, 'old')}\n`);
  await fs.utimes(file, new Date(OLD), new Date(OLD));
  const usage = service();
  await usage.refresh();
  const memberAt = new Date(2025, 11, 15, 12).getTime();
  const report = usage.report('all', [{ machineId: 'member', usage: [
    { app: 'pi', model: 'mimo-test', hourMs: memberAt, tokens },
    { app: 'pi', model: 'invalid', hourMs: 0, tokens: { output: 'bad' } },
  ] }]);
  assert.equal(report.buckets.unit, 'month');
  assert.equal(report.buckets.startsMs[0], new Date(2025, 11, 1).getTime());
  assert.equal(report.buckets.startsMs.at(-1), new Date(2026, 9, 1).getTime());
  assert.equal(report.records.length, 2);
  const local = report.records.find((record) => record.app === 'claude');
  assert.equal(report.buckets.startsMs[local.bucket], new Date(new Date(OLD).getFullYear(), new Date(OLD).getMonth(), 1).getTime());
  assert.equal(report.records.find((record) => record.machineId === 'member').bucket, 0);
  assert.deepEqual(usage.report('90d').records, []);
  assert.deepEqual(usage.localHourly('all').usage, [{ app: 'claude', model: 'claude-test', hourMs: Math.floor(OLD / 3_600_000) * 3_600_000, tokens }]);
  assert.deepEqual(usage.localHourly('90d').usage, []);
});

test('All time starts at the first real usage: bad member hours and zero-token parts add no month', async (t) => {
  const { projects, service } = await setup(t);
  const zero = JSON.stringify({ type: 'assistant', timestamp: new Date(2026, 0, 10).toISOString(), requestId: 'zero',
    message: { id: 'zero', model: 'claude-test', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } });
  await fs.writeFile(path.join(projects, 'a.jsonl'), `${zero}\n${line(new Date(2026, 2, 10).getTime(), 'march')}\n`);
  const usage = service();
  await usage.refresh();
  const zeroTokens = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const report = usage.report('all', [{ machineId: 'member', usage: [0, -1e17, 8.64e15 + 1].map((hourMs) => ({ app: 'pi', model: 'm', hourMs, tokens }))
    .concat({ app: 'pi', model: 'm', hourMs: new Date(2025, 5, 1).getTime(), tokens: zeroTokens }) }]);
  assert.deepEqual(report.buckets.startsMs, Array.from({ length: 8 }, (_, index) => new Date(2026, 2 + index, 1).getTime()));
  assert.deepEqual(report.records.filter((record) => record.machineId === '').map((record) => record.bucket), [0]);
  // The member hours before 2020 fall before the first bucket and are dropped.
  assert.equal(report.records.filter((record) => record.machineId === 'member' && record.bucket !== 7).length, 0);
});

test('All time with no records has one current month', async (t) => {
  const { service } = await setup(t);
  const usage = service();
  await usage.refresh();
  const report = usage.report('all');
  assert.deepEqual(report.buckets, { unit: 'month', startsMs: [new Date(2026, 9, 1).getTime()] });
  assert.deepEqual(report.records, []);
});

test('the newest file limit is applied before reading and unchanged scans read no bytes', async (t) => {
  const { projects, service } = await setup(t);
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(projects, `${index}.jsonl`);
    await fs.writeFile(file, `${line(OLD, `id-${index}`)}\n`);
    await fs.utimes(file, new Date(OLD + index * 1000), new Date(OLD + index * 1000));
  }
  const usage = service({ maxCacheFiles: 2 });
  await usage.refresh();
  assert.equal(usage.localHourly('all').scan.files, 2);
  assert.equal(usage.localHourly('all').usage[0].tokens.output, 10);
  const bytes = usage.stats.bytesRead;
  assert.ok(bytes > 0);
  await usage.refresh();
  assert.equal(usage.stats.bytesRead, bytes);
  const warm = service({ maxCacheFiles: 2 });
  await warm.refresh();
  assert.equal(warm.stats.bytesRead, 0);
  assert.equal(warm.localHourly('all').usage[0].tokens.output, 10);
});

test('version 1 pruned caches rebuild an unchanged file and recover its old record', async (t) => {
  const { root, projects, service } = await setup(t);
  const transcript = path.join(projects, 'old.jsonl');
  const text = `${line(OLD, 'old')}\n`;
  await fs.writeFile(transcript, text);
  const entry = await scanFile(transcript, await fs.stat(transcript), undefined, 'claude');
  entry.records = [];
  const file = path.join(root, 'cache', 'usage', 'usage-cache.json');
  await saveUsageCache(file, new Map([[pathKey(transcript), entry]]));
  const oldCache = JSON.parse(await fs.readFile(file, 'utf8'));
  oldCache.version = 1;
  await fs.writeFile(file, JSON.stringify(oldCache));
  const usage = service();
  await usage.refresh();
  assert.ok(usage.stats.bytesRead >= Buffer.byteLength(text));
  assert.deepEqual(usage.report('all').records[0].tokens, tokens);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
});
