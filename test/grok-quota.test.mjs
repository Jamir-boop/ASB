import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadGrokQuota,
  normalizeGrokQuota,
  readGrokQuotaCache,
} from '../src/grok-quota.mjs';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => value,
  };
}

test('normalizes only the Grok subscription quota fields used by the dashboard', () => {
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  const quota = normalizeGrokQuota({
    nowMs,
    settings: {
      subscription_tier_display: 'X Premium',
      privateAccountField: 'must-not-survive',
    },
    billing: {
      config: {
        creditUsagePercent: 56,
        currentPeriod: { end: Date.parse('2026-08-22T15:00:00.000Z') / 1000 },
        productUsage: [{ product: 'GrokBuild', usagePercent: 56, privateField: 'drop-me' }],
        prepaidBalance: { val: 0, privateField: 'drop-me' },
        privateBillingField: 'must-not-survive',
      },
    },
  });

  assert.deepEqual(quota, {
    version: 1,
    savedAtMs: nowMs,
    snapshot: {
      planName: 'X Premium',
      observedAtMs: nowMs,
      usedPercent: 56,
      availablePercent: 44,
      resetsAtMs: Date.parse('2026-08-22T15:00:00.000Z'),
      productUsage: [{ product: 'GrokBuild', usagePercent: 56 }],
      prepaidBalance: 0,
    },
  });
  assert.equal(JSON.stringify(quota).includes('private'), false);
  assert.equal(JSON.stringify(quota).includes('must-not-survive'), false);
});

test('uses the Cindy credential in memory and persists only a private sanitized Grok snapshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-quota-live-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'grok-quota.json');
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  const secret = 'local-cindy-oauth-secret-value';
  const calls = [];

  const quota = await loadGrokQuota({
    cindyDataDir: directory,
    cachePath,
    cacheMs: 0,
    nowMs,
    runCommand: async () => ({ stdout: '' }),
    credentialReader: async () => ({ accessToken: secret, expiresAtMs: nowMs + 60_000 }),
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/settings')) {
        return jsonResponse({ subscription_tier_display: 'X Premium' });
      }
      return jsonResponse({
        creditUsagePercent: 51,
        billingPeriodEnd: '2026-08-22T14:59:07.246Z',
        productUsage: [{ product: 'GrokBuild', usagePercent: 51 }],
        prepaidBalance: { val: 3.5 },
      });
    },
  });

  assert.equal(quota.freshness, 'live');
  assert.equal(quota.snapshot.availablePercent, 49);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.authorization === `Bearer ${secret}`), true);

  const cachedText = await fs.readFile(cachePath, 'utf8');
  const cachedStat = await fs.stat(cachePath);
  assert.equal(cachedText.includes(secret), false);
  assert.equal(cachedText.includes('Authorization'), false);
  assert.equal(cachedStat.mode & 0o077, 0);
  assert.deepEqual((await readGrokQuotaCache(cachePath)).snapshot.productUsage, [
    { product: 'GrokBuild', usagePercent: 51 },
  ]);
});

test('falls back to the last sanitized Grok snapshot without leaking fetch errors', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-quota-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'grok-quota.json');
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  await fs.writeFile(cachePath, JSON.stringify({
    version: 1,
    savedAtMs: nowMs - 60_000,
    snapshot: {
      planName: 'X Premium',
      observedAtMs: nowMs - 60_000,
      usedPercent: 40,
      availablePercent: 60,
      resetsAtMs: Date.parse('2026-08-22T15:00:00.000Z'),
      productUsage: [{ product: 'GrokBuild', usagePercent: 40 }],
      prepaidBalance: 0,
    },
  }));

  const quota = await loadGrokQuota({
    cindyDataDir: directory,
    cachePath,
    cacheMs: 0,
    nowMs,
    runCommand: async () => ({ stdout: '' }),
    credentialReader: async () => ({ accessToken: 'secret-that-must-not-leak' }),
    fetchImpl: async () => {
      throw new Error('upstream failed with secret-that-must-not-leak');
    },
  });

  assert.equal(quota.freshness, 'cached');
  assert.equal(quota.snapshot.availablePercent, 60);
  assert.equal(JSON.stringify(quota).includes('secret-that-must-not-leak'), false);
});
