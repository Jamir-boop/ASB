// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/usage/usagePricing.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps the standard rates of each model and the long-request and 1-hour cache write rates: transcripts give no speed tier
// that ASB keeps, and the aggregated records have no provider-reported cost. A rate is { input, output, cacheRead, cacheWrite,
// cacheWrite1h, above200k, above272k } in USD per token, with null for a missing cache rate; a band (above200k, above272k) is
// null or { input, output, cacheRead, cacheWrite, cacheWrite1h }.

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

// The tag of a model name that the usage parsers give to tokens of a long request or a 1-hour cache write: its last bracket group.
export const TIER_TAG = /\[(?:200k\+|272k\+|1h|200k\+,1h|272k\+,1h)\]$/;
// The model name with the tag of a prompt size (input tokens with the cached ones) and of a 1-hour cache write.
export function tierModel(model, promptTokens, hour = false) {
  const tags = [promptTokens > 272_000 ? '272k+' : promptTokens > 200_000 ? '200k+' : '', hour ? '1h' : ''].filter(Boolean);
  return tags.length ? `${model}[${tags.join(',')}]` : model;
}

function readBand(entry, size) {
  const band = { input: finiteNumber(entry[`input_cost_per_token_above_${size}_tokens`]),
    output: finiteNumber(entry[`output_cost_per_token_above_${size}_tokens`]),
    cacheRead: finiteNumber(entry[`cache_read_input_token_cost_above_${size}_tokens`]),
    cacheWrite: finiteNumber(entry[`cache_creation_input_token_cost_above_${size}_tokens`]),
    cacheWrite1h: finiteNumber(entry[`cache_creation_input_token_cost_above_1hr_above_${size}_tokens`]) };
  return band.input === null || band.output === null ? null : band;
}

// Omits LiteLLM's flex, priority, and batches variants, which transcripts do not record.
function readTokenRates(entry) {
  const input = finiteNumber(entry.input_cost_per_token);
  const output = finiteNumber(entry.output_cost_per_token);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: finiteNumber(entry.cache_read_input_token_cost),
    cacheWrite: finiteNumber(entry.cache_creation_input_token_cost), cacheWrite1h: finiteNumber(entry.cache_creation_input_token_cost_above_1hr),
    above200k: readBand(entry, '200k'), above272k: readBand(entry, '272k') };
}

const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
const sameFields = (a, b) => RATE_FIELDS.every((field) => a[field] === b[field]);
const sameBand = (a, b) => a === b || (a !== null && b !== null && sameFields(a, b));
const sameTokenRates = (a, b) => sameFields(a, b) && sameBand(a.above200k, b.above200k) && sameBand(a.above272k, b.above272k);

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

// The LiteLLM provider of each model maker that sells its own models.
const MAKER_PROVIDERS = { Google: 'gemini', xAI: 'xai', 'Xiaomi MiMo': 'xiaomi_mimo', 'Moonshot AI': 'moonshot', 'Z.ai': 'zai',
  Qwen: 'dashscope', DeepSeek: 'deepseek', MiniMax: 'minimax', 'Mistral AI': 'mistral' };

function addBareAliases(table) {
  const candidates = new Map();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (!alias || alias === key || table.has(alias)) continue;
    if (!candidates.has(alias)) candidates.set(alias, []);
    candidates.get(alias).push({ key, rate });
  }
  for (const [alias, entries] of candidates) {
    if (entries.every(({ rate }) => sameTokenRates(rate, entries[0].rate))) table.set(alias, entries[0].rate);
    else {
      // The rate of the model's own company resolves reseller differences without guessing between resellers.
      const provider = MAKER_PROVIDERS[modelMaker(alias)];
      const own = provider && entries.find(({ key }) => key === `${provider}/${alias}`);
      if (own) table.set(alias, own.rate);
    }
  }
}

export function modelMaker(model) {
  const name = stripVariantSuffix(bareModelName(typeof model === 'string' ? model : '').trim().toLowerCase());
  if (name.startsWith('claude') || ['opus', 'sonnet', 'haiku', 'fable'].includes(name)) return 'Anthropic';
  if (/^(gpt-|chatgpt|codex-|o[134](-|$))/.test(name)) return 'OpenAI';
  if (/^(gemini|gemma)/.test(name)) return 'Google';
  if (name.startsWith('grok')) return 'xAI';
  if (name.startsWith('mimo')) return 'Xiaomi MiMo';
  if (/^(kimi|moonshot)/.test(name)) return 'Moonshot AI';
  if (name.startsWith('glm')) return 'Z.ai';
  if (name.startsWith('qwen')) return 'Qwen';
  if (name.startsWith('deepseek')) return 'DeepSeek';
  if (name.startsWith('minimax')) return 'MiniMax';
  if (/^(llama|muse-spark)/.test(name)) return 'Meta';
  if (/^(mistral|codestral|devstral|magistral)/.test(name)) return 'Mistral AI';
  return 'Other';
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
  addBareAliases(table);
  return table;
}

const cacheRate = (value) => value === null || finiteNumber(value) !== null;
const validBand = (band) => band === null || (typeof band === 'object' && finiteNumber(band.input) !== null && finiteNumber(band.output) !== null
  && cacheRate(band.cacheRead) && cacheRate(band.cacheWrite) && cacheRate(band.cacheWrite1h));
const bandOf = (band) => band && { input: band.input, output: band.output, cacheRead: band.cacheRead, cacheWrite: band.cacheWrite, cacheWrite1h: band.cacheWrite1h };

// The rate table of the ASB disk cache: the `models` object that rateTableModels made. A missing tier field is null.
export function rateTableFromModels(models) {
  const table = new Map();
  if (typeof models !== 'object' || models === null) return table;
  for (const [key, rate] of Object.entries(models)) {
    if (finiteNumber(rate?.input) === null || finiteNumber(rate.output) === null || !cacheRate(rate.cacheRead) || !cacheRate(rate.cacheWrite)) continue;
    const { cacheWrite1h = null, above200k = null, above272k = null } = rate;
    if (!cacheRate(cacheWrite1h) || !validBand(above200k) || !validBand(above272k)) continue;
    table.set(key, { input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite, cacheWrite1h,
      above200k: bandOf(above200k), above272k: bandOf(above272k) });
  }
  addBareAliases(table);
  return table;
}

export const rateTableModels = (table) => Object.fromEntries(table);

// Synthetic messages are unbilled; bare family names are generation-ambiguous and remain unpriced.
const UNPRICEABLE_MODELS = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable']);

// Immutable tables permit caching rates across lookups.
const resolvedRates = new WeakMap();

// The rate of a tagged model is its tier rate: the band of its size tag (272k+ falls back to the 200k band), and the
// 1-hour cache write rate for a 1h tag. A missing tier rate falls back to the base rate.
function tierRate(base, tag) {
  const band = tag.includes('272k+') ? base.above272k ?? base.above200k : tag.includes('200k+') ? base.above200k : null;
  const rate = band ? { input: band.input, output: band.output, cacheRead: band.cacheRead ?? base.cacheRead,
    cacheWrite: band.cacheWrite ?? base.cacheWrite, cacheWrite1h: band.cacheWrite1h ?? base.cacheWrite1h } : base;
  return tag.includes('1h') ? { ...rate, cacheWrite: rate.cacheWrite1h ?? rate.cacheWrite } : rate;
}

export function lookupRate(table, model) {
  let resolved = resolvedRates.get(table);
  if (!resolved) resolvedRates.set(table, resolved = new Map());
  let rate = resolved.get(model);
  if (rate === undefined) {
    const key = stripVariantSuffix(normalizeRateKey(model));
    const bareName = bareModelName(key);
    // A prefix that LiteLLM does not know (z-ai/glm-5.2) takes the rate of the bare name, which the maker rule chose.
    rate = bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName) ? null : table.get(key) ?? table.get(bareName) ?? null;
    const tag = TIER_TAG.exec(model.trim())?.[0];
    if (rate && tag) rate = tierRate(rate, tag);
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
