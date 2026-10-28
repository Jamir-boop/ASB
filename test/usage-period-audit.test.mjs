import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PERIODS, periodBuckets as messageBuckets } from '../src/activity-messages.mjs';
import { USAGE_PERIODS, periodBuckets } from '../src/usage-aggregation.mjs';

for (const [zone, times, expected] of [
  ['America/New_York', ['2026-11-01T06:03:00Z', '2026-11-01T06:59:00Z'], '2026-11-01T06:00:00Z'],
  ['Europe/Berlin', ['2026-10-25T01:30:00Z'], '2026-10-25T01:00:00Z'],
]) {
  test(`the repeated hour stays current in ${zone}`, () => {
    const script = `import assert from 'node:assert/strict';
      import { periodBuckets } from ${JSON.stringify(new URL('../src/usage-aggregation.mjs', import.meta.url).href)};
      for (const time of ${JSON.stringify(times)}) {
        const now = Date.parse(time);
        const buckets = periodBuckets('24h', now);
        assert.equal(buckets.startsMs.at(-1), Date.parse(${JSON.stringify(expected)}));
        assert.ok(now < buckets.endMs);
      }`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: zone } });
  });
}

test('shared message periods keep their units counts and bucket starts', () => {
  const expected = { '24h': { unit: 'hour', count: 24 }, '7d': { unit: 'day', count: 7 },
    '30d': { unit: 'day', count: 30 }, '90d': { unit: 'day', count: 90 } };
  for (const [period, value] of Object.entries(expected)) {
    assert.deepEqual(PERIODS[period], value);
    assert.deepEqual(USAGE_PERIODS[period], value);
    for (const time of ['2026-01-01T12:34:56Z', '2026-11-01T06:30:00Z']) {
      const usage = periodBuckets(period, Date.parse(time));
      const messages = messageBuckets(period, Date.parse(time));
      assert.deepEqual({ unit: messages.unit, startsMs: messages.startsMs }, { unit: usage.unit, startsMs: usage.startsMs });
    }
  }
});
