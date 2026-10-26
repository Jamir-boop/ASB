// Local buckets per the activity contract, in a time zone with DST.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBuckets, aggregateHourly, bucketIndex, periodBuckets } from '../src/usage-aggregation.mjs';
import { parseRateTable } from '../src/usage-pricing.mjs';

const HOUR = 3_600_000;
const zoneWorks = new Date(2026, 10, 1, 12).getTimezoneOffset() === 300 && new Date(2026, 9, 31, 12).getTimezoneOffset() === 240;
const skip = zoneWorks ? false : 'this system ignores TZ=America/New_York';
const tokens = (output) => ({ uncached: 10, cacheRead: 100, cacheWrite: 0, output });
const part = (atMs, extra = {}) => ({ app: 'claude', model: 'claude-test-5', atMs, tokens: tokens(5), key: null, ...extra });

test('day buckets are local midnights across the DST end, today last', { skip }, () => {
  const nowMs = new Date(2026, 10, 3, 12, 0).getTime();
  const { unit, startsMs, endMs } = periodBuckets('7d', nowMs);
  assert.equal(unit, 'day');
  assert.equal(startsMs.length, 7);
  assert.deepEqual(startsMs, [28, 29, 30, 31].map((day) => new Date(2026, 9, day).getTime())
    .concat([1, 2, 3].map((day) => new Date(2026, 10, day).getTime())));
  // 1 November 2026 has 25 hours in New York.
  assert.equal(startsMs[5] - startsMs[4], 25 * HOUR);
  assert.equal(endMs, new Date(2026, 10, 4).getTime());
  assert.equal(periodBuckets('30d', nowMs).startsMs.length, 30);
  assert.equal(periodBuckets('90d', nowMs).startsMs.length, 90);
  // 23:30 on 1 November is in its day; 00:10 on 2 November is in the next one.
  assert.equal(bucketIndex(startsMs, endMs, new Date(2026, 10, 1, 23, 30).getTime()), 4);
  assert.equal(bucketIndex(startsMs, endMs, new Date(2026, 10, 2, 0, 10).getTime()), 5);
  assert.equal(bucketIndex(startsMs, endMs, startsMs[0] - 1), -1);
  assert.equal(bucketIndex(startsMs, endMs, endMs), -1);
});

test('24 hourly buckets end at the local hour of now, across the repeated hour', { skip }, () => {
  const nowMs = new Date(2026, 10, 1, 12, 40).getTime();
  const { unit, startsMs, endMs } = periodBuckets('24h', nowMs);
  assert.equal(unit, 'hour');
  assert.equal(startsMs.length, 24);
  assert.equal(startsMs[23], new Date(2026, 10, 1, 12).getTime());
  assert.equal(endMs, startsMs[23] + HOUR);
  for (let index = 1; index < 24; index += 1) assert.equal(startsMs[index] - startsMs[index - 1], HOUR);
  // The local hour 01:00 shows twice (EDT, then EST).
  assert.equal(startsMs.filter((start) => new Date(start).getHours() === 1).length, 2);
});

test('totals per app, model, and local bucket, with cost and Unpriced', { skip }, () => {
  const nowMs = new Date(2026, 10, 3, 12, 0).getTime();
  const { startsMs, endMs } = periodBuckets('7d', nowMs);
  const rates = parseRateTable({ 'claude-test-5': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e-7 } });
  const parts = [
    part(new Date(2026, 10, 1, 23, 30).getTime()),
    part(new Date(2026, 10, 1, 1, 15).getTime()),
    part(new Date(2026, 10, 2, 0, 10).getTime()),
    part(new Date(2026, 10, 2, 0, 20).getTime(), { app: 'codex', model: 'unknown-test' }),
    part(new Date(2026, 9, 1).getTime()),
    // A copied Claude message counts once.
    part(new Date(2026, 10, 3, 9).getTime(), { key: 'k1' }),
    part(new Date(2026, 10, 3, 10).getTime(), { key: 'k1' }),
  ];
  const records = aggregateBuckets(parts, { startsMs, endMs, rates });
  assert.deepEqual(records.map(({ app, model, bucket, tokens: { output } }) => [app, model, bucket, output]), [
    ['claude', 'claude-test-5', 4, 10],
    ['claude', 'claude-test-5', 5, 5],
    ['codex', 'unknown-test', 5, 5],
    ['claude', 'claude-test-5', 6, 5],
  ]);
  assert.deepEqual(records[0].cost, { uncached: 0.00002, cacheRead: 0.00002, cacheWrite: 0, output: 0.00002, total: 0.00006, savings: 0.00018 });
  assert.equal(records[2].cost, null);
});

test('hourly parts use UTC hour starts in the window', () => {
  const at = Date.parse('2026-11-01T05:40:00Z');
  const hourly = aggregateHourly([part(at), part(at + 10 * 60_000), part(at + HOUR), part(at - 10 * HOUR)], at - HOUR, at + 2 * HOUR);
  assert.deepEqual(hourly.map(({ hourMs, tokens: { output } }) => [new Date(hourMs).toISOString(), output]),
    [['2026-11-01T05:00:00.000Z', 10], ['2026-11-01T06:00:00.000Z', 5]]);
});
