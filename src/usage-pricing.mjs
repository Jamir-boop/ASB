// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/usage/usagePricing.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps the standard rates of each model: transcripts give no speed tier that ASB keeps, and the aggregated records have
// no provider-reported cost. A rate is { input, output, cacheRead, cacheWrite } in USD per token, with null for a missing cache rate.

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Omits LiteLLM's above_272k_tokens, flex, and batches variants, which transcripts do not record.
function readTokenRates(entry) {
  const input = finiteNumber(entry.input_cost_per_token);
  const output = finiteNumber(entry.output_cost_per_token);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: finiteNumber(entry.cache_read_input_token_cost),
    cacheWrite: finiteNumber(entry.cache_creation_input_token_cost) };
}

const sameTokenRates = (a, b) => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead
  && a.cacheWrite === b.cacheWrite;

const normalizeRateKey = (model) => model.trim().toLowerCase();

function bareModelName(key) {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

// Price Claude's bracketed context variants at the base tier, the only name the rate table knows.
function stripVariantSuffix(key) {
  const bracket = key.indexOf('[');
  return bracket === -1 ? key : key.slice(0, bracket);
}

// The rate table of a LiteLLM price document. Drops models missing input or output rates to avoid understating cost.
export function parseRateTable(document) {
  const table = new Map();
  if (typeof document !== 'object' || document === null) return table;
  for (const [name, entry] of Object.entries(document)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rates = readTokenRates(entry);
    const key = normalizeRateKey(name);
    if (rates !== null && key.length) table.set(key, rates);
  }
  // A bare name gets the rate of its qualified entries only when they all agree.
  const aliasCandidates = new Map();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const held = aliasCandidates.get(alias);
    if (held === undefined) aliasCandidates.set(alias, rate);
    else if (held !== null && !sameTokenRates(held, rate)) aliasCandidates.set(alias, null);
  }
  for (const [alias, rate] of aliasCandidates) if (rate !== null) table.set(alias, rate);
  return table;
}

const cacheRate = (value) => value === null || finiteNumber(value) !== null;

// The rate table of the ASB disk cache: the `models` object that rateTableModels made.
export function rateTableFromModels(models) {
  const table = new Map();
  if (typeof models !== 'object' || models === null) return table;
  for (const [key, rate] of Object.entries(models)) {
    if (finiteNumber(rate?.input) === null || finiteNumber(rate.output) === null || !cacheRate(rate.cacheRead) || !cacheRate(rate.cacheWrite)) continue;
    table.set(key, { input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite });
  }
  return table;
}

export const rateTableModels = (table) => Object.fromEntries(table);

// Synthetic messages are unbilled; bare family names are generation-ambiguous and remain unpriced.
const UNPRICEABLE_MODELS = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable']);

// Immutable tables permit caching rates across lookups.
const resolvedRates = new WeakMap();

export function lookupRate(table, model) {
  let resolved = resolvedRates.get(table);
  if (!resolved) resolvedRates.set(table, resolved = new Map());
  let rate = resolved.get(model);
  if (rate === undefined) {
    const key = stripVariantSuffix(normalizeRateKey(model));
    const bareName = bareModelName(key);
    rate = bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName) ? null : table.get(key) ?? null;
    resolved.set(model, rate);
  }
  return rate;
}

const roundUsd = (value) => Math.round(value * 1e6) / 1e6;

// USD by token type, the total, and the cache savings; null for a model with no rate (Unpriced).
// Missing cache rates fall back to input pricing; Anthropic normally discounts reads and charges extra for writes.
export function priceTokens(table, model, tokens) {
  const rate = lookupRate(table, model);
  if (rate === null) return null;
  const cacheRead = rate.cacheRead ?? rate.input;
  const cost = {
    uncached: tokens.uncached * rate.input,
    cacheRead: tokens.cacheRead * cacheRead,
    cacheWrite: tokens.cacheWrite * (rate.cacheWrite ?? rate.input),
    output: tokens.output * rate.output,
  };
  const total = cost.uncached + cost.cacheRead + cost.cacheWrite + cost.output;
  return { uncached: roundUsd(cost.uncached), cacheRead: roundUsd(cost.cacheRead), cacheWrite: roundUsd(cost.cacheWrite),
    output: roundUsd(cost.output), total: roundUsd(total), savings: roundUsd(tokens.cacheRead * (rate.input - cacheRead)) };
}
