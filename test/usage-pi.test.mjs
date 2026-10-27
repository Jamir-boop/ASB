import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePiLine } from '../src/usage-pi.mjs';
import { parseRateTable, priceTokens } from '../src/usage-pricing.mjs';

const timestamp = '2026-10-20T12:00:00Z';
const usage = { input: 10.9, cacheRead: 20, cacheWrite: 3, output: 8, reasoning: 2, cost: { total: 50 } };
const identity = { id: 'entry-a', timestamp };
const message = { role: 'assistant', provider: 'provider-test', model: 'model-test', usage };
const parse = (entry) => parsePiLine(JSON.stringify(entry));

// The record model is the bare name that LiteLLM prices; the provider stays in the dedupe key only.
function check(entry, model, keyModel = model) {
  assert.deepEqual(parse(entry), [{ app: 'pi', timestampMs: Date.parse(timestamp), model,
    tokens: { uncached: 10, cacheRead: 20, cacheWrite: 3, output: 8 },
    dedupeKey: JSON.stringify(['pi', identity.id, timestamp, keyModel]) }]);
}

test('assistant model attribution and usage records', () => {
  check({ ...identity, type: 'message', message: { ...message, responseModel: 'actual-test' } }, 'actual-test', 'provider-test/actual-test');
  check({ ...identity, type: 'message', message }, 'model-test', 'provider-test/model-test');
  check({ ...identity, type: 'usage', provider: 'provider-test', model: 'model-test', usage }, 'model-test', 'provider-test/model-test');
});

test('Pi usage is priced by its bare model name, and two providers keep two dedupe keys', () => {
  const entry = (provider) => ({ ...identity, type: 'message', message: { ...message, provider, model: 'claude-sonnet-4-5' } });
  const [record] = parse(entry('anthropic'));
  assert.equal(record.model, 'claude-sonnet-4-5');
  const table = parseRateTable({ 'claude-sonnet-4-5': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } });
  assert.equal(priceTokens(table, record.model, record.tokens).total, 0.000049);
  assert.notEqual(parse(entry('openrouter'))[0].dedupeKey, record.dedupeKey);
});

test('tool and summary entries have no model attribution', () => {
  check({ ...identity, type: 'message', message: { role: 'toolResult', usage } }, 'Tools/summaries');
  for (const type of ['compaction', 'branch_summary']) check({ ...identity, type, usage }, 'Tools/summaries');
});

test('only the Entry union with valid identity, time, and usage is accepted', () => {
  const valid = { ...identity, type: 'message', message };
  const invalid = [
    { ...valid, message: { ...message, usage: {} } }, { type: 'session', id: 'session-test' },
    { ...valid, id: undefined }, { ...valid, id: '' }, { ...valid, timestamp: 'bad' }, { ...valid, timestamp: 123 },
    { ...valid, message: { ...message, usage: [] } }, { ...valid, message: { ...message, role: 'user' } },
    { ...valid, message: { ...message, provider: '' } }, { ...valid, message: { ...message, model: '' } },
    { ...valid, message: { ...message, responseModel: '' } }, { ...valid, message: { ...message, responseModel: null } },
    { ...valid, message: { ...message, usage: { input: 2, cost: [] } } }, null,
  ];
  for (const entry of invalid) assert.deepEqual(parse(entry), []);
  assert.deepEqual(parsePiLine('{broken'), []);
});
