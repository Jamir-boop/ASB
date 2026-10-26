// Cases from T3 Code's usagePricing.test.ts (MIT, Copyright (c) 2026 T3 Tools Inc.) that apply to the standard rates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMaker, lookupRate, parseRateTable, priceTokens, rateTableFromModels, rateTableModels } from '../src/usage-pricing.mjs';

const rate = (input, cacheRead) => ({ input_cost_per_token: input, output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }) });
const tokens = { uncached: 1200, cacheRead: 54000, cacheWrite: 3000, output: 900 };

test('the cost formula on fixed rates, with the savings', () => {
  const table = parseRateTable({ 'claude-test-5': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6, mode: 'chat' } });
  assert.deepEqual(priceTokens(table, 'claude-test-5', tokens),
    { uncached: 0.006, cacheRead: 0.027, cacheWrite: 0.01875, output: 0.0225, total: 0.07425, savings: 0.243 });
});

test('a missing cache rate is null and falls back to the input rate', () => {
  const table = parseRateTable({ 'gpt-test-1': rate(1e-6) });
  assert.deepEqual(lookupRate(table, 'gpt-test-1'), { input: 1e-6, output: 1e-6 * 5, cacheRead: null, cacheWrite: null });
  const cost = priceTokens(table, 'gpt-test-1', tokens);
  assert.equal(cost.cacheRead, 0.054);
  assert.equal(cost.cacheWrite, 0.003);
  assert.equal(cost.savings, 0);
});

test('an unknown model, a bare family name, a synthetic model, and a model with no output rate are Unpriced', () => {
  const table = parseRateTable({ 'claude-test-5': rate(1e-6), opus: rate(1e-6), broken: { input_cost_per_token: 1e-6 },
    sample_spec: { input_cost_per_token: 'one', output_cost_per_token: 'two' } });
  assert.equal(priceTokens(table, 'kimi-test', tokens), null);
  assert.equal(priceTokens(table, 'opus', tokens), null);
  assert.equal(priceTokens(table, '<synthetic>', tokens), null);
  assert.equal(priceTokens(table, 'broken', tokens), null);
  assert.equal(table.size, 2);
});

test('matches the model name case-insensitively, trimmed, and without a bracketed variant', () => {
  const table = parseRateTable({ 'claude-test-5-1': rate(1e-5, 2.5e-7) });
  assert.deepEqual(lookupRate(table, 'claude-test-5-1[1m]'), lookupRate(table, 'claude-test-5-1'));
  assert.deepEqual(lookupRate(table, ' Claude-Test-5-1 '), lookupRate(table, 'claude-test-5-1'));
  assert.equal(lookupRate(table, 'anthropic/Claude-Test-5-1[1m]'), null);
});

test('keeps the canonical rate separate from a reseller in either order', () => {
  const canonical = ['claude-test-5', rate(1e-5, 1e-6)];
  const reseller = ['deepinfra/anthropic/claude-test-5', rate(1e-5)];
  for (const entries of [[canonical, reseller], [reseller, canonical]]) {
    const table = parseRateTable(Object.fromEntries(entries));
    assert.equal(lookupRate(table, 'claude-test-5').cacheRead, 1e-6);
    assert.equal(lookupRate(table, 'deepinfra/anthropic/claude-test-5').cacheRead, null);
    assert.equal(lookupRate(table, 'other/claude-test-5'), null);
  }
});

test('adds a bare alias when every qualified entry has the same rate, and leaves an ambiguous one unpriced', () => {
  const same = parseRateTable({ 'provider-a/example-model': rate(1), 'provider-b/example-model': rate(1) });
  assert.deepEqual(lookupRate(same, 'example-model'), lookupRate(same, 'provider-a/example-model'));
  const ambiguous = parseRateTable({ 'provider-a/example-model': rate(1), 'provider-b/example-model': rate(3) });
  assert.equal(lookupRate(ambiguous, 'provider-a/example-model').input, 1);
  assert.equal(lookupRate(ambiguous, 'provider-b/example-model').input, 3);
  assert.equal(lookupRate(ambiguous, 'example-model'), null);
});

test('the disk form of a table gives the same table, and bad entries are dropped', () => {
  const table = parseRateTable({ 'gpt-test-1': rate(1e-6, 1e-7), 'claude-test-5': rate(2e-6) });
  const models = JSON.parse(JSON.stringify(rateTableModels(table)));
  assert.deepEqual(rateTableFromModels(models), table);
  assert.equal(rateTableFromModels({ ...models, bad: { input: 1, output: 'x', cacheRead: null, cacheWrite: null } }).size, 2);
});


test('model makers follow every contract example and family rule', () => {
  const examples = {
    'claude-opus-5-5': 'Anthropic', opus: 'Anthropic', 'claude-opus-4-6[1m]': 'Anthropic',
    sonnet: 'Anthropic', haiku: 'Anthropic', fable: 'Anthropic', 'gpt-6.1-sol': 'OpenAI',
    'codex-auto-review': 'OpenAI', 'o3-mini': 'OpenAI', o4: 'OpenAI', o1: 'OpenAI', 'chatgpt-test': 'OpenAI',
    'omni-x': 'Other', 'anthropic/claude-sonnet-4-5': 'Anthropic', 'gemini-3.1-pro': 'Google', gemma: 'Google',
    grok: 'xAI', 'mimo-v2.6-pro': 'Xiaomi MiMo', 'kimi-k3': 'Moonshot AI', moonshot: 'Moonshot AI',
    'glm-5.3-flash-free': 'Z.ai', 'qwen3.7-plus': 'Qwen', 'deepseek-v4.1-flash-free': 'DeepSeek',
    'minimax-m3.1-flash-free': 'MiniMax', 'muse-spark-1.3-contributor-free': 'Meta', llama: 'Meta',
    'devstral-small': 'Mistral AI', mistral: 'Mistral AI', codestral: 'Mistral AI', magistral: 'Mistral AI',
    'space-bunny-free': 'Other', 'Tools/summaries': 'Other', '': 'Other', 'route/  GPT-Test[large]': 'OpenAI',
  };
  for (const [model, maker] of Object.entries(examples)) assert.equal(modelMaker(model), maker, model);
});

test('first-party aliases resolve reseller differences, including old cached tables', () => {
  const document = { 'xiaomi_mimo/mimo-v2.6-pro': rate(1e-7, 3.6e-9), 'opencode_go/mimo-v2.6-pro': rate(1e-7, 3.625e-9) };
  const table = parseRateTable(document);
  assert.deepEqual(table.get('mimo-v2.6-pro'), table.get('xiaomi_mimo/mimo-v2.6-pro'));
  const cached = Object.fromEntries([...table].filter(([key]) => key.includes('/')));
  assert.deepEqual(rateTableFromModels(cached).get('mimo-v2.6-pro'), table.get('xiaomi_mimo/mimo-v2.6-pro'));
  assert.equal(parseRateTable({ 'x/test': rate(1), 'y/test': rate(2) }).has('test'), false);
  assert.equal(parseRateTable({ 'gemini/test': rate(1), 'xai/test': rate(2) }).has('test'), false);
  assert.equal(parseRateTable({ 'route/xai/test': rate(1), 'y/test': rate(2) }).has('test'), false);
  assert.equal(parseRateTable({ 'x/test': rate(1), 'y/test': rate(1) }).get('test').input, 1);
  assert.equal(parseRateTable({ test: rate(3), 'gemini/test': rate(1), 'y/test': rate(2) }).get('test').input, 3);
});
