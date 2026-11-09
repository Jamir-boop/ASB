// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/usage/usageAggregation.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps the totals per app and model in hourly and daily buckets, with one count per dedupe key over the whole scan.
// Its buckets are local hours and local calendar days (the activity contract), and its input is token parts per quarter hour.
import { priceTokens } from './usage-pricing.mjs';

const HOUR_MS = 60 * 60 * 1000;
export const USAGE_PERIODS = { '24h': { unit: 'hour', count: 24 }, '7d': { unit: 'day', count: 7 },
  '30d': { unit: 'day', count: 30 }, '90d': { unit: 'day', count: 90 }, all: { unit: 'span' } };

// Bucket starts, oldest first, and the end of the last bucket. Day starts use local date arithmetic, so they are DST safe.
// All time picks its unit from the span of local calendar days from the first record to today, both counted:
// days up to 120, Monday weeks up to 731, months after that.
export function periodBuckets(period, nowMs, firstMs = null) {
  let { unit, count } = USAGE_PERIODS[period];
  const now = new Date(nowMs);
  if (unit === 'span') {
    const first = new Date(firstMs !== null && firstMs <= nowMs ? firstMs : nowMs);
    const firstDay = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    // Day numbers from the calendar fields: a DST day of 23 or 25 hours still counts as one.
    const span = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
      - Date.UTC(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate())) / (24 * HOUR_MS)) + 1;
    if (span <= 120) {
      const day = (offset) => new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + offset).getTime();
      return { unit: 'day', startsMs: Array.from({ length: span }, (_, index) => day(index)), endMs: day(span) };
    }
    if (span <= 731) {
      const monday = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - (date.getDay() + 6) % 7);
      const start = monday(firstDay), last = monday(now);
      const week = (offset) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * offset).getTime();
      const weeks = Math.round((Date.UTC(last.getFullYear(), last.getMonth(), last.getDate())
        - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / (7 * 24 * HOUR_MS)) + 1;
      return { unit: 'week', startsMs: Array.from({ length: weeks }, (_, index) => week(index)), endMs: week(weeks) };
    }
    unit = 'month';
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

const TOKEN_TYPES = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
const roundUsd = (value) => Math.round(value * 1e6) / 1e6;
export const tokenSum = (tokens) => tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output;

// The tokens of each session (part.session) and model in [sinceMs, untilMs), with the dedupe of sumParts, so the session sums
// and `none` (the parts with no session) add up to the records of the same parts. Each session is { app, id, models }, and
// models is [{ model, tokens }] with the model names of the records (tier tags kept).
export function sessionSums(parts, sinceMs, untilMs) {
  const seen = new Set();
  const sessions = new Map();
  const none = emptyTokens();
  for (const part of parts) {
    if (part.key !== null && part.key !== undefined) {
      if (seen.has(part.key)) continue;
      seen.add(part.key);
    }
    if (part.atMs < sinceMs || part.atMs >= untilMs) continue;
    if (!part.session) { addTokens(none, part.tokens); continue; }
    const id = `${part.app}\0${part.session}`;
    let sum = sessions.get(id);
    if (!sum) sessions.set(id, sum = { app: part.app, id: part.session, models: new Map() });
    let tokens = sum.models.get(part.model);
    if (!tokens) sum.models.set(part.model, tokens = emptyTokens());
    addTokens(tokens, part.tokens);
  }
  const list = [];
  for (const { app, id, models } of sessions.values()) {
    const kept = [...models].filter(([, tokens]) => tokenSum(tokens) > 0).map(([model, tokens]) => ({ model, tokens }));
    if (kept.length) list.push({ app, id, models: kept });
  }
  return { sessions: list, none };
}

// One pricing for the local and the member sessions, with the function of the records: tokens is the sum over the models,
// cost the priced part, and unpriced marks a session with tokens of a model that has no price. The models go away.
export function priceSessions(list, rates) {
  return list.map(({ models, ...session }) => {
    const tokens = emptyTokens();
    let cost = 0, unpriced = false;
    for (const { model, tokens: sum } of models) {
      addTokens(tokens, sum);
      const price = priceTokens(rates, model, sum);
      if (price) cost += price.total; else if (tokenSum(sum) > 0) unpriced = true;
    }
    return { ...session, tokens, cost: roundUsd(cost), ...(unpriced ? { unpriced: true } : {}) };
  });
}

const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const tie = (a, b) => byText(a.title, b.title) || byText(a.id, b.id) || byText(a.app, b.app);
const modelTokens = (session) => session.models.reduce((sum, { tokens }) => sum + tokenSum(tokens), 0);
// The union of the `count` priced sessions with the most cost and the `count` with the most tokens; ties go to the title, then the ID.
export function topSessions(list, count) {
  const byCost = [...list].sort((a, b) => b.cost - a.cost || tokenSum(b.tokens) - tokenSum(a.tokens) || tie(a, b)).slice(0, count);
  const byTokens = [...list].sort((a, b) => tokenSum(b.tokens) - tokenSum(a.tokens) || b.cost - a.cost || tie(a, b)).slice(0, count);
  return [...new Set([...byCost, ...byTokens])];
}

export const MAX_MEMBER_SESSIONS = 2000;
export const MAX_SESSION_MODELS = 16;
// The member reply: the MAX_MEMBER_SESSIONS sessions (with models, no cost) with the most tokens; ties go to the title, then the ID.
export const memberSessions = (list) => [...list].sort((a, b) => modelTokens(b) - modelTokens(a) || tie(a, b)).slice(0, MAX_MEMBER_SESSIONS);

const count = (value) => Number.isFinite(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.length <= 300;
const validModel = (item) => item && typeof item === 'object' && text(item.model) && item.model.length > 0
  && item.tokens && typeof item.tokens === 'object' && TOKEN_TYPES.every((type) => count(item.tokens[type]));
// The sessions of a member reply (contract 4): only plain strings, 1 to MAX_SESSION_MODELS models with finite counts of 0 or
// more, at most MAX_MEMBER_SESSIONS, and only the contract fields. The asking side prices them.
export function validSessions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && typeof item === 'object' && text(item.id) && item.id && text(item.app) && text(item.title)
    && Array.isArray(item.models) && item.models.length >= 1 && item.models.length <= MAX_SESSION_MODELS && item.models.every(validModel))
    .slice(0, MAX_MEMBER_SESSIONS)
    .map(({ id, app, title, models }) => ({ id, app, title, models: models.map(({ model, tokens }) =>
      ({ model, tokens: Object.fromEntries(TOKEN_TYPES.map((type) => [type, tokens[type]])) })) }));
}
