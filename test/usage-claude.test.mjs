// Cases from T3 Code's claudeUsage.test.ts (MIT, Copyright (c) 2026 T3 Tools Inc.), and the one count per message and request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateHourly } from '../src/usage-aggregation.mjs';
import { claudeUsageFormat, parseClaudeLine } from '../src/usage-claude.mjs';
import { QUARTER_HOUR_MS, scanFile } from '../src/usage-scan-cache.mjs';

const claudeLine = ({ messageId, requestId, contentType = 'text', model = 'claude-test-5', outputTokens = 286,
  timestamp = '2026-08-07T04:05:13.944Z' }) => JSON.stringify({
  type: 'assistant', timestamp, sessionId: 'session-a', ...(requestId ? { requestId } : {}),
  message: { id: messageId, role: 'assistant', model, content: [{ type: contentType, text: 'SECRETTEXT' }],
    usage: { input_tokens: 2, cache_creation_input_tokens: 66818, cache_read_input_tokens: 1000, output_tokens: outputTokens } },
});

test('extracts the token parts with the cache parts and a dedupe key', () => {
  const record = parseClaudeLine(claudeLine({ messageId: 'msg_1' }));
  assert.deepEqual(record, { app: 'claude', timestampMs: Date.parse('2026-08-07T04:05:13.944Z'), model: 'claude-test-5',
    tokens: { uncached: 2, cacheRead: 1000, cacheWrite: 66818, output: 286 }, dedupeKey: 'msg_1:' });
  assert.equal(parseClaudeLine(claudeLine({ messageId: 'msg_1', requestId: 'req_1' })).dedupeKey, 'msg_1:req_1');
});

test('gives every content block of one message the same dedupe key', () => {
  const text = parseClaudeLine(claudeLine({ messageId: 'msg_2', contentType: 'text' }));
  const toolUse = parseClaudeLine(claudeLine({ messageId: 'msg_2', contentType: 'tool_use' }));
  assert.equal(text.dedupeKey, toolUse.dedupeKey);
  assert.deepEqual(text.tokens, toolUse.tokens);
});

test('skips local placeholders but keeps real zero-token responses', () => {
  const zero = { type: 'assistant', timestamp: '2026-08-07T04:05:13.944Z', message: { model: 'claude-test-5', usage: { input_tokens: 0, output_tokens: 0 } } };
  assert.deepEqual(parseClaudeLine(JSON.stringify(zero)).tokens, { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.equal(parseClaudeLine(JSON.stringify({ ...zero, message: { ...zero.message, model: '<synthetic>' } })), null);
  assert.equal(parseClaudeLine(JSON.stringify({ ...zero, type: 'user' })), null);
  assert.deepEqual(claudeUsageFormat.markers, ['"usage"']);
});

test('duplicate lines of one message and request count once with the final output count, in a file and across files', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-claude-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  // The lines of one streamed reply: the early lines have a partial output count.
  const lines = [
    claudeLine({ messageId: 'msg_a', requestId: 'req_a', contentType: 'thinking', outputTokens: 5 }),
    claudeLine({ messageId: 'msg_a', requestId: 'req_a', contentType: 'text', outputTokens: 40 }),
    claudeLine({ messageId: 'msg_a', requestId: 'req_a', contentType: 'tool_use', outputTokens: 120 }),
    JSON.stringify({ type: 'user', message: { content: 'SECRETTEXT' } }),
    claudeLine({ messageId: 'msg_b', requestId: 'req_b', outputTokens: 14 }),
  ];
  const first = path.join(folder, 'first.jsonl');
  await fs.writeFile(first, `${lines.join('\n')}\n`);
  const entry = await scanFile(first, await fs.stat(first), undefined, 'claude');
  assert.equal(entry.records.length, 2);
  assert.deepEqual(entry.records.map((record) => record.slice(2, 6)), [[2, 1000, 66818, 120], [2, 1000, 66818, 14]]);
  // A resumed transcript copies msg_a: the whole scan counts it once.
  const copy = path.join(folder, 'copy.jsonl');
  await fs.writeFile(copy, `${lines[1]}\n`);
  const copied = await scanFile(copy, await fs.stat(copy), undefined, 'claude');
  const parts = [...entry.records, ...copied.records].map(([quarter, model, uncached, cacheRead, cacheWrite, output, key]) =>
    ({ app: 'claude', model, atMs: quarter * QUARTER_HOUR_MS, tokens: { uncached, cacheRead, cacheWrite, output }, key }));
  const hourly = aggregateHourly(parts, 0, Date.parse('2026-09-01T00:00:00Z'));
  assert.deepEqual(hourly, [{ app: 'claude', model: 'claude-test-5', hourMs: Date.parse('2026-08-07T04:00:00Z'),
    tokens: { uncached: 4, cacheRead: 2000, cacheWrite: 133636, output: 134 } }]);
});

const tierLine = (usage, { messageId = 'msg_t', requestId = 'req_t' } = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-08-07T04:05:13.944Z',
  ...(requestId ? { requestId } : {}), message: { ...(messageId ? { id: messageId } : {}), model: 'claude-test-5', usage } });
const AT = Date.parse('2026-08-07T04:05:13.944Z');

test('a prompt above 200,000 or 272,000 tokens gets its size tag at or after the tier start, and none before it', () => {
  const usage = { input_tokens: 1000, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 9000, output_tokens: 7 };
  assert.equal(parseClaudeLine(tierLine(usage), null, { tiersFromMs: AT }).model, 'claude-test-5[200k+]');
  assert.equal(parseClaudeLine(tierLine({ ...usage, cache_read_input_tokens: 262_001 }), null, { tiersFromMs: AT }).model, 'claude-test-5[272k+]');
  assert.equal(parseClaudeLine(tierLine({ ...usage, cache_read_input_tokens: 190_000 }), null, { tiersFromMs: AT }).model, 'claude-test-5');
  assert.equal(parseClaudeLine(tierLine(usage), null, { tiersFromMs: AT + 1 }).model, 'claude-test-5');
  assert.equal(parseClaudeLine(tierLine(usage)).model, 'claude-test-5');
});

test('1-hour cache writes are a part of their own with the 1h tag and their own key', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } };
  const options = { tiersFromMs: AT };
  assert.deepEqual(parseClaudeLine(tierLine(usage), null, options), [
    { app: 'claude', timestampMs: AT, model: 'claude-test-5', tokens: { uncached: 10, cacheRead: 0, cacheWrite: 400, output: 5 }, dedupeKey: 'msg_t:req_t' },
    { app: 'claude', timestampMs: AT, model: 'claude-test-5[1h]', tokens: { uncached: 0, cacheRead: 0, cacheWrite: 600, output: 0 }, dedupeKey: 'msg_t:req_t:1h' }]);
  // With a size tag, the 1-hour part has both tags.
  const long = parseClaudeLine(tierLine({ ...usage, cache_read_input_tokens: 280_000 }), null, options);
  assert.deepEqual(long.map(({ model }) => model), ['claude-test-5[272k+]', 'claude-test-5[272k+,1h]']);
  // A base part with no tokens is left out, and a record with no key keeps a null key.
  assert.deepEqual(parseClaudeLine(tierLine({ cache_creation_input_tokens: 600, cache_creation: { ephemeral_1h_input_tokens: 600 } },
    { messageId: null, requestId: null }), null, options),
  [{ app: 'claude', timestampMs: AT, model: 'claude-test-5[1h]', tokens: { uncached: 0, cacheRead: 0, cacheWrite: 600, output: 0 }, dedupeKey: null }]);
  // More 1-hour tokens than cache writes, or none: no split.
  assert.equal(parseClaudeLine(tierLine({ ...usage, cache_creation: { ephemeral_1h_input_tokens: 1001 } }), null, options).tokens.cacheWrite, 1000);
  assert.equal(parseClaudeLine(tierLine({ ...usage, cache_creation: { ephemeral_1h_input_tokens: 0 } }), null, options).model, 'claude-test-5');
  // Before the tier start, or with no start: one untagged record.
  assert.deepEqual(parseClaudeLine(tierLine(usage), null, { tiersFromMs: AT + 1 }).tokens, { uncached: 10, cacheRead: 0, cacheWrite: 1000, output: 5 });
  assert.equal(Array.isArray(parseClaudeLine(tierLine(usage))), false);
});

test('the scan tags Claude records at or after its tier start and keeps the 1-hour part across repeated lines', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-claude-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 600 } };
  const file = path.join(folder, 'tiers.jsonl');
  await fs.writeFile(file, `${[tierLine(usage), tierLine({ ...usage, output_tokens: 90 })].join('\n')}\n`);
  const tagged = await scanFile(file, await fs.stat(file), undefined, 'claude', { tiersFromMs: AT });
  assert.deepEqual(tagged.records.map((record) => record.slice(1, 6)), [['claude-test-5', 10, 0, 400, 90], ['claude-test-5[1h]', 0, 0, 600, 0]]);
  const plain = await scanFile(file, await fs.stat(file), undefined, 'claude');
  assert.deepEqual(plain.records.map((record) => record.slice(1, 6)), [['claude-test-5', 10, 0, 1000, 90]]);
});
