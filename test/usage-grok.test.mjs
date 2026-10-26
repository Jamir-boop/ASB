import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGrokLine } from '../src/usage-grok.mjs';

const at = 1_790_000_000_123;
const counts = { inputTokens: 100.9, cachedReadTokens: 30, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 9 };
const turn = (usage = counts, extra = {}) => ({ timestamp: 1_790_000_000, params: { sessionId: 's1',
  _meta: { agentTimestampMs: at }, update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage }, ...extra } });
const parse = (value) => parseGrokLine(JSON.stringify(value));

test('a completed turn returns all models in order with disjoint tokens and keys', () => {
  const records = parse(turn({ modelUsage: { 'grok-test-a': counts, 'grok-test-b': { ...counts, inputTokens: 2 }, '': counts, invalid: null } }));
  assert.deepEqual(records, [
    { app: 'grok', timestampMs: at, model: 'grok-test-a', tokens: { uncached: 60, cacheRead: 30, cacheWrite: 10, output: 20 }, dedupeKey: 's1:p1:grok-test-a' },
    { app: 'grok', timestampMs: at, model: 'grok-test-b', tokens: { uncached: 0, cacheRead: 30, cacheWrite: 10, output: 20 }, dedupeKey: 's1:p1:grok-test-b' },
  ]);
});

test('top-level fallback, timestamp fallback, and missing prompt id', () => {
  const line = turn();
  delete line.params.update.prompt_id;
  assert.deepEqual(parse(line), [{ app: 'grok', timestampMs: at, model: 'grok',
    tokens: { uncached: 60, cacheRead: 30, cacheWrite: 10, output: 20 }, dedupeKey: null }]);
  delete line.params._meta;
  assert.equal(parse(line)[0].timestampMs, line.timestamp * 1000);
  line.timestamp = at;
  assert.equal(parse(line)[0].timestampMs, at);
  delete line.timestamp;
  assert.deepEqual(parse(line), []);
});

test('invalid, incomplete, and empty turns have no usage; costs have no effect', () => {
  assert.deepEqual(parseGrokLine('{broken'), []);
  assert.deepEqual(parse(turn({}, { update: { sessionUpdate: 'turn_started', usage: counts } })), []);
  for (const usage of [{}, { inputTokens: -3, outputTokens: '4', cachedReadTokens: null }, []]) assert.deepEqual(parse(turn(usage)), []);
  const line = turn();
  const before = parse(line);
  line.params.update.usage = { ...counts, costUsdTicks: 900_000_000 };
  assert.deepEqual(parse(line), before);
  line.params.update.usage = { modelUsage: { 'grok-test': { ...counts, costUsdTicks: 1 } } };
  const perModel = parse(line);
  line.params.update.usage.modelUsage['grok-test'].costUsdTicks = 999;
  assert.deepEqual(parse(line), perModel);
});
