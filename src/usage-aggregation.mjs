// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/usage/usageAggregation.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps the totals per app and model in hourly and daily buckets, with one count per dedupe key over the whole scan.
// Its buckets are local hours and local calendar days (the activity contract), and its input is token parts per quarter hour.
import { priceTokens } from './usage-pricing.mjs';

const HOUR_MS = 60 * 60 * 1000;
export const USAGE_PERIODS = { '24h': { unit: 'hour', count: 24 }, '7d': { unit: 'day', count: 7 },
  '30d': { unit: 'day', count: 30 }, '90d': { unit: 'day', count: 90 }, all: { unit: 'month' } };

// Bucket starts, oldest first, and the end of the last bucket. Day starts use local date arithmetic, so they are DST safe.
export function periodBuckets(period, nowMs, firstMs = null) {
  const { unit, count } = USAGE_PERIODS[period];
  const now = new Date(nowMs);
  if (unit === 'month') {
    const first = new Date(firstMs !== null && firstMs <= nowMs ? firstMs : nowMs);
    const year = first.getFullYear(), month = first.getMonth();
    const months = (now.getFullYear() - year) * 12 + now.getMonth() - month + 1;
    return { unit, startsMs: Array.from({ length: months }, (_, index) => new Date(year, month + index, 1).getTime()),
      endMs: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() };
  }
  if (unit === 'hour') {
    const last = nowMs - ((now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds());
    return { unit, startsMs: Array.from({ length: count }, (_, index) => last - (count - 1 - index) * HOUR_MS), endMs: last + HOUR_MS };
  }
  const day = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime();
  return { unit, startsMs: Array.from({ length: count }, (_, index) => day(index - count + 1)), endMs: day(1) };
}

// The index of the bucket that holds timeMs, or -1 outside [startsMs[0], endMs).
export function bucketIndex(startsMs, endMs, timeMs) {
  if (timeMs < startsMs[0] || timeMs >= endMs) return -1;
  let low = 0, high = startsMs.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (startsMs[middle] <= timeMs) low = middle; else high = middle - 1;
  }
  return low;
}

const emptyTokens = () => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
function addTokens(sum, tokens) {
  sum.uncached += tokens.uncached;
  sum.cacheRead += tokens.cacheRead;
  sum.cacheWrite += tokens.cacheWrite;
  sum.output += tokens.output;
}

// Parts are { app, model, atMs, tokens, key }. Deduplicates across the whole scan: Claude copies records into
// resumed and forked transcripts. The first part of a key wins, so the caller gives the parts in a stable order.
function sumParts(parts, slotOf) {
  const seen = new Set();
  const sums = new Map();
  for (const part of parts) {
    if (part.key !== null && part.key !== undefined) {
      if (seen.has(part.key)) continue;
      seen.add(part.key);
    }
    const slot = slotOf(part.atMs);
    if (slot === null) continue;
    const id = `${part.app}\0${part.model}\0${slot}`;
    let sum = sums.get(id);
    if (!sum) sums.set(id, sum = { app: part.app, model: part.model, slot, tokens: emptyTokens() });
    addTokens(sum.tokens, part.tokens);
  }
  return [...sums.values()].filter(({ tokens }) => tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output > 0);
}

const order = (a, b) => a.slot - b.slot || a.app.localeCompare(b.app) || a.model.localeCompare(b.model);

// Records per (app, model, local bucket) with tokens and the cost of the price table (null when Unpriced).
export function aggregateBuckets(parts, { startsMs, endMs, rates }) {
  return sumParts(parts, (atMs) => {
    const index = bucketIndex(startsMs, endMs, atMs);
    return index === -1 ? null : index;
  }).sort(order).map(({ app, model, slot, tokens }) => ({ app, model, bucket: slot, tokens, cost: priceTokens(rates, model, tokens) }));
}

// Records per (app, model, UTC hour start) with tokens only, for the hours in [sinceMs, untilMs).
export function aggregateHourly(parts, sinceMs, untilMs) {
  return sumParts(parts, (atMs) => atMs < sinceMs || atMs >= untilMs ? null : Math.floor(atMs / HOUR_MS) * HOUR_MS)
    .sort(order).map(({ app, model, slot, tokens }) => ({ app, model, hourMs: slot, tokens }));
}
