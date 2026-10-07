import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeBailianQuotaSnapshot,
  readBailianQuotaSnapshot,
  writeBailianQuotaSnapshot,
} from '../src/bailian-quota-bridge.mjs';

const NOW_MS = Date.parse('2026-08-21T10:30:00.000Z');

function validPayload(overrides = {}) {
  return {
    version: 1,
    planName: 'Pro 套餐',
    observedAt: '2026-08-21T10:29:28.000Z',
    planEndsAt: '2026-09-03T16:00:00.000Z',
    sevenDay: {
      usedPercent: 45.95,
      resetsAt: '2026-08-24T06:06:00.000Z',
    },
    ...overrides,
  };
}

test('normalizes only the Bailian fields that the dashboard needs', () => {
  assert.deepEqual(normalizeBailianQuotaSnapshot(validPayload(), { nowMs: NOW_MS }), {
    version: 1,
    savedAtMs: NOW_MS,
    snapshot: {
      planName: 'Pro 套餐',
      observedAtMs: Date.parse('2026-08-21T10:29:28.000Z'),
      planEndsAtMs: Date.parse('2026-09-03T16:00:00.000Z'),
      sevenDay: {
        usedPercent: 45.95,
        availablePercent: 54.05,
        resetsAtMs: Date.parse('2026-08-24T06:06:00.000Z'),
      },
    },
  });
});

test('rejects unknown or credential-shaped Bailian bridge fields', () => {
  assert.throws(
    () => normalizeBailianQuotaSnapshot(validPayload({ apiKey: 'sk-secret' }), { nowMs: NOW_MS }),
    /unsupported field/i,
  );
  assert.throws(
    () => normalizeBailianQuotaSnapshot({
      ...validPayload(),
      sevenDay: { ...validPayload().sevenDay, cookie: 'secret' },
    }, { nowMs: NOW_MS }),
    /unsupported field/i,
  );
});

test('rejects invalid percentages and stale observations', () => {
  assert.throws(
    () => normalizeBailianQuotaSnapshot({
      ...validPayload(),
      sevenDay: { ...validPayload().sevenDay, usedPercent: 101 },
    }, { nowMs: NOW_MS }),
    /usedPercent/i,
  );
  assert.throws(
    () => normalizeBailianQuotaSnapshot({
      ...validPayload(),
      observedAt: '2026-08-01T00:00:00.000Z',
    }, { nowMs: NOW_MS }),
    /observedAt/i,
  );
});

test('persists a private sanitized Bailian snapshot and reads it back', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bailian-quota-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'bailian-quota.json');

  await writeBailianQuotaSnapshot(cachePath, validPayload(), { nowMs: NOW_MS });
  const raw = await fs.readFile(cachePath, 'utf8');
  const mode = (await fs.stat(cachePath)).mode & 0o777;
  const cached = await readBailianQuotaSnapshot(cachePath);

  assert.equal(mode, 0o600);
  assert.equal(raw.includes('sk-'), false);
  assert.equal(raw.includes('cookie'), false);
  assert.equal(cached.snapshot.sevenDay.availablePercent, 54.05);
  assert.equal(cached.savedAtMs, NOW_MS);
});
