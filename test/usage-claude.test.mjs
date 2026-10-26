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

test('duplicate lines of one message and request count once, in a file and across files', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-claude-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const lines = [
    claudeLine({ messageId: 'msg_a', requestId: 'req_a', contentType: 'thinking' }),
    claudeLine({ messageId: 'msg_a', requestId: 'req_a', contentType: 'text' }),
    claudeLine({ messageId: 'msg_a', requestId: 'req_a', contentType: 'tool_use' }),
    JSON.stringify({ type: 'user', message: { content: 'SECRETTEXT' } }),
    claudeLine({ messageId: 'msg_b', requestId: 'req_b', outputTokens: 14 }),
  ];
  const first = path.join(folder, 'first.jsonl');
  await fs.writeFile(first, `${lines.join('\n')}\n`);
  const entry = await scanFile(first, await fs.stat(first), undefined, 'claude');
  assert.equal(entry.records.length, 2);
  assert.deepEqual(entry.records.map((record) => record.slice(2, 6)), [[2, 1000, 66818, 286], [2, 1000, 66818, 14]]);
  // A resumed transcript copies msg_a: the whole scan counts it once.
  const copy = path.join(folder, 'copy.jsonl');
  await fs.writeFile(copy, `${lines[1]}\n`);
  const copied = await scanFile(copy, await fs.stat(copy), undefined, 'claude');
  const parts = [...entry.records, ...copied.records].map(([quarter, model, uncached, cacheRead, cacheWrite, output, key]) =>
    ({ app: 'claude', model, atMs: quarter * QUARTER_HOUR_MS, tokens: { uncached, cacheRead, cacheWrite, output }, key }));
  const hourly = aggregateHourly(parts, 0, Date.parse('2026-09-01T00:00:00Z'));
  assert.deepEqual(hourly, [{ app: 'claude', model: 'claude-test-5', hourMs: Date.parse('2026-08-07T04:00:00Z'),
    tokens: { uncached: 4, cacheRead: 2000, cacheWrite: 133636, output: 300 } }]);
});
