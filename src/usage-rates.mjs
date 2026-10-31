// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/usage/UsageService.ts (the rate loading), commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// The LiteLLM price list, downloaded at run time with a 24-hour disk cache. A load never blocks a reply: the caller gets
// the rates it has now, and a download runs in the background. The disk cache holds only the parsed rates per model.
// Version 2 has the tier rates; an older cache gives its rates until the download at once replaces it.
import { parseRateTable, rateTableFromModels, rateTableModels } from './usage-pricing.mjs';
import { readPrivateJson, writePrivateJson } from './usage-scan-cache.mjs';

export const LITELLM_RATES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const LITELLM_RATES_API_URL = 'https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main';
export const RATES_TTL_MS = 24 * 60 * 60 * 1000;
export const RATES_REFRESH_FLOOR_MS = 60 * 1000;
export const RATES_FETCH_TIMEOUT_MS = 10_000;
export const MAX_RATES_BYTES = 32 * 1024 * 1024;

async function readLimitedText(response) {
  if (Number(response.headers?.get?.('content-length')) > MAX_RATES_BYTES) throw new Error('The price list is too large.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RATES_BYTES) throw new Error('The price list is too large.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RATES_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('The price list is too large.');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRateLoader({ file, fetch = globalThis.fetch, now = Date.now, platform = process.platform } = {}) {
  let rates = new Map();
  let fetchedAtMs = null;
  let lastFailedAtMs = null;
  let status = 'unavailable';
  let diskRead = false;
  let oldCache = false;
  let running = null;
  // True only while the disk read or a download runs: a load that returns at once (TTL, retry floor) is not loading.
  let busy = false;

  // A non-2xx reply, a timeout, a body above MAX_RATES_BYTES, a JSON error, or a table with no model gives null.
  async function fetchRates(url, accept) {
    try {
      const response = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(RATES_FETCH_TIMEOUT_MS) });
      if (!response.ok) return null;
      const parsed = parseRateTable(JSON.parse(await readLimitedText(response)));
      return parsed.size > 0 ? parsed : null;
    } catch { return null; }
  }

  async function loadRates() {
    const startMs = now();
    if (fetchedAtMs !== null && !oldCache && startMs - fetchedAtMs < RATES_TTL_MS) return;
    if (!diskRead) {
      diskRead = true;
      busy = true;
      const saved = await readPrivateJson(file, { platform }).finally(() => { busy = false; });
      const parsed = rateTableFromModels(saved?.models);
      if (Number.isFinite(saved?.fetchedAtMs) && parsed.size > 0) {
        rates = parsed;
        fetchedAtMs = saved.fetchedAtMs;
        status = 'cached';
        oldCache = saved.version !== 2;
        if (!oldCache && startMs - fetchedAtMs < RATES_TTL_MS) return;
      }
    }
    if (lastFailedAtMs !== null && startMs - lastFailedAtMs < RATES_REFRESH_FLOOR_MS) return;
    busy = true;
    // fetchRates never throws.
    const fetched = await fetchRates(LITELLM_RATES_URL, 'application/json')
      ?? await fetchRates(LITELLM_RATES_API_URL, 'application/vnd.github.raw+json');
    busy = false;
    if (fetched === null) {
      lastFailedAtMs = now();
      if (rates.size > 0) status = 'cached';
      return;
    }
    rates = fetched;
    fetchedAtMs = startMs;
    oldCache = false;
    lastFailedAtMs = null;
    status = 'fresh';
    await writePrivateJson(file, { version: 2, fetchedAtMs: startMs, models: rateTableModels(fetched) }, { platform }).catch(() => {});
  }

  return {
    // Starts a load when none runs; it does nothing while the rates are younger than 24 hours.
    ensure() {
      running ||= loadRates().catch(() => {}).finally(() => { running = null; });
    },
    table: () => rates,
    pricing: () => ({ source: 'LiteLLM', status: rates.size === 0 ? (busy ? 'loading' : 'unavailable') : status,
      fetchedAtMs: rates.size === 0 ? null : fetchedAtMs, models: rates.size }),
    idle: () => running || Promise.resolve(),
  };
}
