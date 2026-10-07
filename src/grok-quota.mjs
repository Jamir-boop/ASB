import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCindyProviderSecret } from './cindy-safe-storage.mjs';

export const DEFAULT_GROK_QUOTA_CACHE_PATH = path.join(
  os.homedir(),
  '.agent-mission-control',
  'grok-quota.json',
);

const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';
const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_CACHE_MS = 60_000;
const quotaCache = new Map();
const quotaInFlight = new Map();

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 100) return null;
  return Math.round(number * 100) / 100;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (number <= 0) return null;
    return number > 1_000_000_000_000 ? Math.floor(number) : Math.floor(number * 1000);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeLabel(value, fallback = '', maxLength = 64) {
  const label = String(value || '').trim().replaceAll(/[\u0000-\u001f\u007f]/g, ' ');
  return (label || fallback).slice(0, maxLength);
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomicPrivate(filePath, value) {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readCindyGrokCredential({ cindyDataDir, runCommand, nowMs = Date.now() }) {
  const encodedCredential = await readCindyProviderSecret({
    cindyDataDir,
    providerId: 'xai',
    storageKeys: ['provider_key_xai'],
    runCommand,
  });
  if (!encodedCredential) return null;
  const credential = JSON.parse(encodedCredential);
  const accessToken = typeof credential?.access_token === 'string'
    && credential.access_token.length >= 16
    && credential.access_token.length <= 16 * 1024
    ? credential.access_token
    : '';
  const expiresAtMs = timestampMs(credential?.expires_at);
  if (!accessToken || (expiresAtMs !== null && expiresAtMs <= nowMs)) return null;

  return { accessToken, expiresAtMs };
}

async function responseJson(response, label) {
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status || 'unknown'}`);
  const contentLength = finiteNumber(response.headers?.get?.('content-length'));
  if (contentLength !== null && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response is too large`);
  }
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} response is invalid`);
  }
  return value;
}

function normalizeProductUsage(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const product = safeLabel(item?.product || item?.productName || item?.name, '', 64);
    const usagePercent = percent(item?.usagePercent ?? item?.usedPercent);
    return product && usagePercent !== null ? { product, usagePercent } : null;
  }).filter(Boolean);
}

export function normalizeGrokQuota({ settings, billing: billingPayload, nowMs = Date.now() }) {
  const billing = billingPayload?.config && typeof billingPayload.config === 'object'
    ? billingPayload.config
    : billingPayload;
  if (!billing || typeof billing !== 'object' || Array.isArray(billing)) {
    throw new Error('Grok billing response is invalid');
  }
  const usedPercent = percent(billing.creditUsagePercent);
  if (usedPercent === null) throw new Error('Grok billing response has no weekly quota');
  const currentPeriod = billing.currentPeriod && typeof billing.currentPeriod === 'object'
    ? billing.currentPeriod
    : null;
  const resetsAtMs = timestampMs(currentPeriod?.end ?? billing.billingPeriodEnd);
  const prepaidRaw = billing.prepaidBalance;
  const prepaidBalance = finiteNumber(
    prepaidRaw && typeof prepaidRaw === 'object' ? prepaidRaw.val : prepaidRaw,
  );

  return {
    version: 1,
    savedAtMs: Math.floor(nowMs),
    snapshot: {
      planName: safeLabel(settings?.subscription_tier_display, 'X 会员额度', 64),
      observedAtMs: Math.floor(nowMs),
      usedPercent,
      availablePercent: Math.round((100 - usedPercent) * 100) / 100,
      resetsAtMs,
      productUsage: normalizeProductUsage(billing.productUsage),
      prepaidBalance,
    },
  };
}

export async function fetchGrokQuota({ accessToken, fetchImpl, nowMs = Date.now() }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': '1.0.3',
    'x-grok-client-mode': 'interactive',
  };
  const request = (url) => fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(8000),
  });
  const [settingsResponse, billingResponse] = await Promise.all([
    request(SETTINGS_URL),
    request(BILLING_URL),
  ]);
  const [settings, billing] = await Promise.all([
    responseJson(settingsResponse, 'Grok settings'),
    responseJson(billingResponse, 'Grok billing'),
  ]);
  return normalizeGrokQuota({ settings, billing, nowMs });
}

export async function readGrokQuotaCache(cachePath = DEFAULT_GROK_QUOTA_CACHE_PATH) {
  if (!cachePath) return null;
  const cached = await readJson(cachePath, null);
  try {
    if (cached?.version !== 1 || !cached.snapshot || typeof cached.snapshot !== 'object') return null;
    const usedPercent = percent(cached.snapshot.usedPercent);
    const savedAtMs = timestampMs(cached.savedAtMs);
    const observedAtMs = timestampMs(cached.snapshot.observedAtMs);
    if (usedPercent === null || savedAtMs === null || observedAtMs === null) return null;
    return {
      version: 1,
      savedAtMs,
      snapshot: {
        planName: safeLabel(cached.snapshot.planName, 'X 会员额度', 64),
        observedAtMs,
        usedPercent,
        availablePercent: Math.round((100 - usedPercent) * 100) / 100,
        resetsAtMs: timestampMs(cached.snapshot.resetsAtMs),
        productUsage: normalizeProductUsage(cached.snapshot.productUsage),
        prepaidBalance: finiteNumber(cached.snapshot.prepaidBalance),
      },
    };
  } catch {
    return null;
  }
}

export async function loadGrokQuota(options = {}) {
  const {
    cindyDataDir,
    fetchImpl = globalThis.fetch,
    runCommand,
    nowMs = Date.now(),
    cacheMs = DEFAULT_CACHE_MS,
    cachePath = DEFAULT_GROK_QUOTA_CACHE_PATH,
    enabled = true,
    credentialReader = readCindyGrokCredential,
  } = options;
  const persistent = await readGrokQuotaCache(cachePath);
  if (!enabled || !cindyDataDir || typeof fetchImpl !== 'function' || typeof runCommand !== 'function') {
    return persistent ? { ...persistent, freshness: 'cached' } : null;
  }

  const cacheKey = `${cindyDataDir}\0${cachePath || ''}`;
  const memory = quotaCache.get(cacheKey);
  if (cacheMs > 0 && memory?.expiresAtMs > nowMs) return memory.value;
  if (cacheMs > 0 && quotaInFlight.has(cacheKey)) return quotaInFlight.get(cacheKey);

  const pending = (async () => {
    try {
      const credential = await credentialReader({ cindyDataDir, runCommand, nowMs });
      if (!credential?.accessToken) return persistent ? { ...persistent, freshness: 'cached' } : null;
      const live = await fetchGrokQuota({
        accessToken: credential.accessToken,
        fetchImpl,
        nowMs,
      });
      await writeJsonAtomicPrivate(cachePath, live).catch(() => {});
      return { ...live, freshness: 'live' };
    } catch {
      return persistent ? { ...persistent, freshness: 'cached' } : null;
    }
  })();

  if (cacheMs > 0) quotaInFlight.set(cacheKey, pending);
  try {
    const value = await pending;
    if (cacheMs > 0) {
      quotaCache.set(cacheKey, { value, expiresAtMs: nowMs + cacheMs });
    }
    return value;
  } finally {
    if (quotaInFlight.get(cacheKey) === pending) quotaInFlight.delete(cacheKey);
  }
}
