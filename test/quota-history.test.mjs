import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachQuotaHistory } from '../src/quota-history.mjs';

function portfolio({ observedAtMs, usedPercent, resetsAtMs }) {
  return [{
    id: 'sample-service',
    observedAtMs,
    windows: [{
      id: 'monthly',
      kind: 'fixed',
      usedPercent,
      availablePercent: 100 - usedPercent,
      resetsAtMs,
      durationMs: 72 * 60 * 60 * 1000,
    }],
  }];
}

test('records sanitized quota samples and adds an explainable historical projection', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'quota-history.json');
  const firstObservedAtMs = Date.parse('2026-08-01T00:00:00.000Z');
  const secondObservedAtMs = firstObservedAtMs + 12 * 60 * 60 * 1000;
  const resetsAtMs = Date.parse('2026-08-03T00:00:00.000Z');

  const first = await attachQuotaHistory(portfolio({
    observedAtMs: firstObservedAtMs,
    usedPercent: 10,
    resetsAtMs,
  }), { filePath, nowMs: firstObservedAtMs });
  assert.equal(first[0].windows[0].history.sampleCount, 1);

  const second = await attachQuotaHistory(portfolio({
    observedAtMs: secondObservedAtMs,
    usedPercent: 20,
    resetsAtMs,
  }), { filePath, nowMs: secondObservedAtMs });
  assert.equal(second[0].windows[0].history.sampleCount, 2);
  assert.equal(second[0].windows[0].history.spanMs, 12 * 60 * 60 * 1000);
  assert.equal(second[0].windows[0].history.usedPercentPerDay, 20);
  assert.equal(second[0].windows[0].history.projectedAvailablePercent, 50);
  assert.equal(second[0].windows[0].history.confidence, 'low');

  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(saved.samples.length, 2);
  assert.deepEqual(Object.keys(saved.samples[0]).sort(), [
    'observedAtMs',
    'resetsAtMs',
    'serviceId',
    'usedPercent',
    'windowId',
  ]);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});
