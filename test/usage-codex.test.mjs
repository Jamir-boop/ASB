// Cases from T3 Code's codexUsage.test.ts (MIT, Copyright (c) 2026 T3 Tools Inc.), without the service tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialCodexScanState, parseCodexLine } from '../src/usage-codex.mjs';

const turnContext = (model = 'gpt-test-1', timestamp = '2026-08-01T05:17:42.694Z') =>
  JSON.stringify({ type: 'turn_context', timestamp, payload: { type: 'turn_context', model } });
const counters = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const counted = (last, total, extra = {}, timestamp = '2026-08-01T05:17:49.919Z') => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total, ...extra } } });
const tokenCount = (input, cached, output, reasoning) => counted({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning });

test('cumulative token_count totals become per-request deltas with the turn_context model', () => {
  const state = initialCodexScanState();
  assert.equal(parseCodexLine(turnContext('gpt-test-1'), state), null);
  const first = parseCodexLine(counted({ ...counters(1000, 100), cached_input_tokens: 600 }, { ...counters(1000, 100), cached_input_tokens: 600 }), state);
  assert.deepEqual(first, { app: 'codex', timestampMs: Date.parse('2026-08-01T05:17:49.919Z'), model: 'gpt-test-1',
    tokens: { uncached: 400, cacheRead: 600, cacheWrite: 0, output: 100 }, dedupeKey: null });
  // The second request: the totals grow by exactly the request.
  const second = parseCodexLine(counted({ ...counters(500, 50), cached_input_tokens: 300 },
    { ...counters(1500, 150), cached_input_tokens: 900 }), state);
  assert.deepEqual(second.tokens, { uncached: 200, cacheRead: 300, cacheWrite: 0, output: 50 });
  // A re-emitted snapshot with the same totals is not a new request.
  assert.equal(parseCodexLine(counted({ ...counters(500, 50), cached_input_tokens: 300 }, { ...counters(1500, 150), cached_input_tokens: 900 }), state), null);
});

test('a model change mid-file carries the new model forward', () => {
  const state = initialCodexScanState();
  parseCodexLine(turnContext('gpt-test-1'), state);
  assert.equal(parseCodexLine(counted(counters(100, 20), counters(100, 20)), state).model, 'gpt-test-1');
  parseCodexLine(turnContext('gpt-test-2'), state);
  const after = parseCodexLine(counted(counters(10, 2), counters(110, 22)), state);
  assert.equal(after.model, 'gpt-test-2');
  assert.equal(after.tokens.output, 2);
  // A turn_context with no model keeps the last one.
  parseCodexLine(JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context' } }), state);
  assert.equal(parseCodexLine(counted(counters(5, 1), counters(115, 23)), state).model, 'gpt-test-2');
});

test('attributes usage and keeps reasoning inside output', () => {
  const state = initialCodexScanState();
  parseCodexLine(turnContext(), state);
  const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);
  assert.deepEqual(record.tokens, { uncached: 19239 - 11008, cacheRead: 11008, cacheWrite: 0, output: 299 });
});

test('skips a repeated token_count so deltas are not double counted', () => {
  const state = initialCodexScanState();
  parseCodexLine(turnContext(), state);
  assert.notEqual(parseCodexLine(tokenCount(100, 0, 10, 0), state), null);
  assert.equal(parseCodexLine(tokenCount(100, 0, 10, 0), state), null);
});

test('does not consume counters before the model and timestamp are valid', () => {
  const state = initialCodexScanState();
  assert.equal(parseCodexLine(tokenCount(100, 0, 10, 0), state), null);
  parseCodexLine(turnContext(), state);
  assert.notEqual(parseCodexLine(tokenCount(100, 0, 10, 0), state), null);
  const cumulativeState = initialCodexScanState();
  const line = counted(counters(100, 20), counters(100, 20));
  assert.equal(parseCodexLine(line, cumulativeState), null);
  parseCodexLine(turnContext(), cumulativeState);
  assert.equal(parseCodexLine(line.replace('2026-08-01T05:17:49.919Z', 'invalid'), cumulativeState), null);
  assert.equal(parseCodexLine(line, cumulativeState).tokens.output, 20);
  assert.equal(cumulativeState.malformedRecords, 0);
});

for (const initialCumulative of [false, true]) {
  test(`does not rebill legacy requests or drop the next cumulative delta (initial cumulative=${initialCumulative})`, () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext(), state);
    const first = counters(100, 20);
    assert.equal(parseCodexLine(counted(first, initialCumulative ? first : undefined), state).tokens.output, 20);
    assert.equal(parseCodexLine(counted(first), state), null);
    assert.equal(parseCodexLine(counted(counters(20, 5)), state).tokens.output, 5);
    assert.equal(parseCodexLine(counted(counters(20, 5), counters(120, 25)), state), null);
    assert.equal(parseCodexLine(counted(counters(10, 2), counters(130, 27)), state).tokens.output, 2);
    assert.equal(state.malformedRecords, 0);
  });
}

test('does not bill a context-window estimate or a post-compaction marker', () => {
  const state = initialCodexScanState();
  parseCodexLine(turnContext(), state);
  parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
  const estimate = { ...counters(0, 0), total_tokens: 1000 };
  assert.equal(parseCodexLine(counted({ ...estimate, total_tokens: 880 }, estimate, { model_context_window: 1000 }), state), null);
  assert.equal(parseCodexLine(counted(counters(10, 2), { ...counters(10, 2), total_tokens: 1012 }), state).tokens.output, 2);
  const marker = counted({ ...counters(0, 0), total_tokens: 26387 }, counters(0, 0), { model_context_window: 475000 });
  assert.equal(parseCodexLine(marker, state), null);
  assert.equal(parseCodexLine(counted(counters(30, 5), counters(30, 5)), state).tokens.output, 5);
  assert.equal(state.malformedRecords, 0);
});

test('bills the first request after a resume restarts the cumulative counters', () => {
  const state = initialCodexScanState();
  parseCodexLine(turnContext(), state);
  parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
  assert.equal(parseCodexLine(counted(counters(30, 5), counters(30, 5)), state).tokens.output, 5);
  assert.equal(parseCodexLine(counted(counters(10, 2), counters(40, 7)), state).tokens.output, 2);
});

for (const malformed of ['request', 'cumulative']) {
  test(`skips malformed ${malformed} counters and recovers`, () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext(), state);
    const request = counters(100, 20);
    parseCodexLine(counted(request, request), state);
    assert.equal(parseCodexLine(counted(malformed === 'request' ? { ...request, cached_input_tokens: -1 } : request,
      malformed === 'cumulative' ? { ...counters(200, 40), output_tokens: '40' } : counters(200, 40)), state), null);
    assert.equal(state.malformedRecords, 1);
    assert.equal(parseCodexLine(counted(request, malformed === 'request' ? counters(300, 60) : counters(200, 40)), state).tokens.output, 20);
  });
}

test('drops the re-stamped copied burst of a forked rollout and keeps the first real event', () => {
  const state = initialCodexScanState();
  const forkInstant = '2026-08-01T05:00:00.000Z';
  parseCodexLine(JSON.stringify({ type: 'session_meta', timestamp: forkInstant, payload: { type: 'session_meta', id: 'child', forked_from_id: 'parent' } }), state);
  parseCodexLine(JSON.stringify({ type: 'session_meta', timestamp: forkInstant, payload: { type: 'session_meta', id: 'parent' } }), state);
  parseCodexLine(turnContext('gpt-test-1', forkInstant), state);
  assert.equal(parseCodexLine(counted(counters(100, 10), counters(100, 10), {}, '2026-08-01T05:00:00.001Z'), state), null);
  assert.equal(parseCodexLine(counted(counters(200, 20), counters(300, 30), {}, '2026-08-01T05:00:00.002Z'), state), null);
  const real = parseCodexLine(counted(counters(200, 20), counters(500, 50), {}, '2026-08-01T05:00:06.000Z'), state);
  assert.equal(real.tokens.output, 20);
  assert.notEqual(parseCodexLine(counted(counters(400, 40), counters(900, 90), {}, '2026-08-01T05:00:06.100Z'), state), null);
  assert.equal(state.malformedRecords, 0);
});

test('recognizes subagent spawns without forked_from_id', () => {
  const state = initialCodexScanState();
  const spawnInstant = '2026-08-01T05:00:00.000Z';
  parseCodexLine(JSON.stringify({ type: 'session_meta', timestamp: spawnInstant,
    payload: { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } }), state);
  parseCodexLine(turnContext('gpt-test-1', spawnInstant), state);
  assert.equal(parseCodexLine(counted({ ...counters(100, 10) }, undefined, {}, '2026-08-01T05:00:00.001Z'), state), null);
});

test('a request above 272,000 or 200,000 input tokens gets its size tag at or after the tier start, and none before it', () => {
  const at = Date.parse('2026-08-01T05:17:49.919Z');
  const parse = (input, options) => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext('gpt-test-1'), state, options);
    return parseCodexLine(counted({ ...counters(input, 10), cached_input_tokens: 1000 }, { ...counters(input, 10), cached_input_tokens: 1000 }), state, options);
  };
  // The size counts the cached input too.
  assert.equal(parse(272_001, { tiersFromMs: at }).model, 'gpt-test-1[272k+]');
  assert.deepEqual(parse(272_001, { tiersFromMs: at }).tokens, { uncached: 271_001, cacheRead: 1000, cacheWrite: 0, output: 10 });
  assert.equal(parse(272_000, { tiersFromMs: at }).model, 'gpt-test-1[200k+]');
  assert.equal(parse(200_001, { tiersFromMs: 0 }).model, 'gpt-test-1[200k+]');
  assert.equal(parse(200_000, { tiersFromMs: 0 }).model, 'gpt-test-1');
  assert.equal(parse(300_000, { tiersFromMs: at + 1 }).model, 'gpt-test-1');
  assert.equal(parse(300_000).model, 'gpt-test-1');
});
