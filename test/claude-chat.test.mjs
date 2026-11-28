import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as chat from '../src/claude-chat.mjs';
import { fitChatTurns, parseClaudeChat, readClaudeChat } from '../src/claude-chat.mjs';

const at = (second) => `2026-11-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const atMs = (second) => Date.parse(at(second));
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-claude-chat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'synthetic.jsonl') };
}

test('the reader builds the contract turns from one transcript and drops every other record kind', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, jsonl([
    { type: 'user', timestamp: at(1), message: { content: 'One made-up prompt.' } },
    { type: 'assistant', isSidechain: true, timestamp: at(2), message: { id: 'side', content: [{ type: 'text', text: 'SIDECHATMARK' }] } },
    { type: 'assistant', timestamp: at(3), message: { id: 'm1', content: [{ type: 'thinking', thinking: 'THINKMARK' }, { type: 'text', text: 'First part.' }] } },
    { type: 'assistant', timestamp: at(4), message: { id: 'm1', content: [{ type: 'text', text: 'Second part.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo TOOLMARK' } }] } },
    { type: 'user', timestamp: at(5), toolUseResult: { stdout: 'RESULTMARK' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULTMARK' }] } },
    { type: 'user', timestamp: at(6), message: { content: 'Two <system-reminder>REMINDERMARK</system-reminder> prompt.' } },
    { type: 'user', timestamp: at(7), message: { content: '<system-reminder>ALONEMARK</system-reminder>' } },
    { type: 'user', timestamp: at(8), message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMAGEMARK' } }] } },
    { type: 'user', timestamp: at(9), isCompactSummary: true, message: { content: 'SUMMARYMARK' } },
    { type: 'user', timestamp: at(10), message: { content: '<command-name>/clear</command-name>\n<local-command-stdout>COMMANDMARK</local-command-stdout>' } },
    { type: 'attachment', timestamp: at(11), attachment: { type: 'queued_command', origin: { kind: 'peer', name: 'Phone', body: 'Busy peer body.' } } },
    { type: 'user', timestamp: at(12), isMeta: true, origin: { kind: 'peer', name: 'Desk', body: 'Idle peer body.' }, message: { content: 'envelope' } },
    { type: 'assistant', timestamp: at(13), message: { id: 'm2', content: [{ type: 'text', text: 'Sending now.' },
      { type: 'tool_use', name: 'SendMessage', input: { to: 'Phone-7a [c6e30c]', message: 'Phone send body.' } },
      { type: 'tool_use', name: 'SendMessage', input: { to: 'asb-main', message: 'MAINMARK' } }] } },
  ]));
  const reply = await readClaudeChat(file);
  assert.deepEqual(reply, { turns: [
    { role: 'user', text: 'One made-up prompt.', atMs: atMs(1), cut: false },
    { role: 'assistant', text: 'First part.\n\nSecond part.', atMs: atMs(3), cut: false },
    { role: 'user', text: 'Two  prompt.', atMs: atMs(6), cut: false },
    { role: 'peer', name: 'Phone', text: 'Busy peer body.', atMs: atMs(11), cut: false },
    { role: 'peer', name: 'Desk', text: 'Idle peer body.', atMs: atMs(12), cut: false },
    { role: 'assistant', text: 'Sending now.', atMs: atMs(13), cut: false },
    { role: 'assistant', text: 'Phone send body.', atMs: atMs(13), cut: false },
  ], more: false });
  const text = JSON.stringify(reply);
  for (const marker of ['SIDECHATMARK', 'THINKMARK', 'TOOLMARK', 'RESULTMARK', 'REMINDERMARK', 'ALONEMARK', 'IMAGEMARK',
    'SUMMARYMARK', 'COMMANDMARK', 'MAINMARK', 'Bash', 'tool_use', 'tool_result']) assert.ok(!text.includes(marker), marker);
});

test('the reader keeps only the newest turns of the limit and sets more when older turns exist', async (t) => {
  const { file } = await fixture(t);
  const records = [];
  for (let n = 1; n <= 40; n++) records.push({ type: 'user', timestamp: at(n), message: { content: `Prompt ${n}.` } });
  await writeFile(file, jsonl(records));
  assert.deepEqual(await readClaudeChat(file, { limit: 1 }), { turns: [{ role: 'user', text: 'Prompt 40.', atMs: atMs(40), cut: false }], more: true });
  const newest = await readClaudeChat(file, { limit: 30 });
  assert.deepEqual(newest.turns.map((turn) => turn.text), Array.from({ length: 30 }, (_, i) => `Prompt ${i + 11}.`));
  assert.equal(newest.more, true);
  await writeFile(file, jsonl(records.slice(0, 3)));
  assert.deepEqual(await readClaudeChat(file), { turns: records.slice(0, 3).map((record, n) => ({ role: 'user', text: `Prompt ${n + 1}.`, atMs: atMs(n + 1), cut: false })),
    more: false });
});

test('a prompt above 2000 code points has cut true and exactly 2000 code points', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, jsonl([{ type: 'user', timestamp: at(1), message: { content: `${'𝄞'.repeat(1999)} tail` } },
    { type: 'user', timestamp: at(2), message: { content: `${'a'.repeat(2000)}` } },
    { type: 'user', timestamp: at(3), message: { content: `${'b'.repeat(1999)}` } }]));
  const reply = await readClaudeChat(file);
  assert.deepEqual(reply.turns.map((turn) => [turn.cut, [...turn.text].length]), [[true, 2000], [false, 2000], [false, 1999]]);
  assert.ok(reply.turns[0].text.endsWith('…'));
});

test('the reply stays under 256 KiB of JSON and drops the oldest turns with more true', async (t) => {
  const { file } = await fixture(t);
  // 2,000 control characters are 12 KB each in JSON, so 30 turns exceed the cap.
  const records = [];
  for (let n = 1; n <= 30; n++) records.push({ type: 'user', timestamp: at(n), message: { content: `\u0001`.repeat(2_000) } });
  await writeFile(file, jsonl(records));
  const reply = await readClaudeChat(file);
  assert.equal(reply.more, true);
  assert.ok(reply.turns.length >= 1 && reply.turns.length < 30);
  assert.ok(Buffer.byteLength(JSON.stringify({ api: 1, threadId: 'x'.repeat(512), ...reply })) <= 256 * 1024);
  assert.equal(reply.turns.at(-1).atMs, atMs(30));
  assert.equal(reply.turns.at(-1).cut, false);
  // The measure is the one of the reader, so a fitted list keeps every turn when the cap allows it.
  const measure = (turns, more) => Buffer.byteLength(JSON.stringify({ api: 1, threadId: 'x'.repeat(512), turns, more }));
  const small = Array.from({ length: 30 }, (_, n) => ({ role: 'user', text: 'short', atMs: n, cut: false }));
  assert.deepEqual(fitChatTurns(small, false, measure), { turns: small, more: false });
});

test('a transcript above 8 MiB reads only its tail and sets more true', async (t) => {
  const { file } = await fixture(t);
  const filler = Array.from({ length: 12_000 }, (_, n) => ({ type: 'file-history-snapshot', snapshot: { n, blob: `OLDESTMARKER${n}`.padEnd(1000, '.') } }));
  await writeFile(file, jsonl(filler.concat([{ type: 'user', timestamp: at(2), message: { content: 'Newest prompt.' } },
    { type: 'assistant', timestamp: at(3), message: { id: 'm9', content: [{ type: 'text', text: 'Newest reply.' }] } }])));
  const { size } = await stat(file);
  assert.ok(size > 8 * 1024 * 1024, String(size));
  const reply = await readClaudeChat(file);
  assert.equal(reply.more, true);
  assert.deepEqual(reply.turns.at(-2), { role: 'user', text: 'Newest prompt.', atMs: atMs(2), cut: false });
  assert.equal(reply.turns.at(-1).text, 'Newest reply.');
  assert.ok(!JSON.stringify(reply).includes('OLDESTMARKER'));
  assert.equal(reply.turns.length, 2);
});

test('the reader caches nothing and the module exports only functions', async (t) => {
  const { file } = await fixture(t);
  assert.deepEqual(Object.keys(chat).sort(), ['claudeChatFile', 'fitChatTurns', 'parseClaudeChat', 'readClaudeChat']);
  await writeFile(file, jsonl([{ type: 'user', timestamp: at(1), message: { content: 'First read.' } }]));
  assert.equal((await readClaudeChat(file)).turns[0].text, 'First read.');
  await writeFile(file, jsonl([{ type: 'user', timestamp: at(1), message: { content: 'Second read.' } }]));
  assert.equal((await readClaudeChat(file)).turns[0].text, 'Second read.');
  assert.deepEqual(parseClaudeChat('not json\n\n'), []);
});

test('a record that makes no turn does not end the assistant group of one message.id', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, jsonl([
    { type: 'assistant', timestamp: at(1), message: { id: 'm1', content: [{ type: 'text', text: 'A' }] } },
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULTMARK' }] } },
    { type: 'attachment', timestamp: at(3), attachment: { type: 'hook_success', hookName: 'HOOKMARK' } },
    { type: 'user', timestamp: at(4), isMeta: true, message: { content: 'METAMARK' } },
    { type: 'assistant', timestamp: at(5), message: { id: 'm1', content: [{ type: 'text', text: 'B' },
      { type: 'tool_use', name: 'SendMessage', input: { to: 'Phone', message: 'Send body.' } }] } },
  ]));
  const reply = await readClaudeChat(file);
  assert.deepEqual(reply, { turns: [
    { role: 'assistant', text: 'A\n\nB', atMs: atMs(1), cut: false },
    { role: 'assistant', text: 'Send body.', atMs: atMs(1), cut: false },
  ], more: false });
  const text = JSON.stringify(reply);
  for (const marker of ['RESULTMARK', 'HOOKMARK', 'METAMARK']) assert.ok(!text.includes(marker), marker);
});

test('a sidechain record makes no turn in any shape', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, jsonl([
    { type: 'user', timestamp: at(1), message: { content: 'Main prompt.' } },
    { type: 'user', isSidechain: true, timestamp: at(2), origin: { kind: 'peer', name: 'Phone', body: 'SIDEPEERMARK' }, message: { content: 'x' } },
    { type: 'attachment', isSidechain: true, timestamp: at(3), attachment: { type: 'queued_command', origin: { kind: 'peer', name: 'Desk', body: 'SIDEATTACHMARK' } } },
    { type: 'assistant', isSidechain: true, timestamp: at(4), message: { id: 'side', content: [{ type: 'text', text: 'SIDECHATMARK' }] } },
    { type: 'assistant', timestamp: at(5), message: { id: 'm1', content: [{ type: 'text', text: 'Main reply.' }] } },
  ]));
  const reply = await readClaudeChat(file);
  assert.deepEqual(reply.turns.map((turn) => [turn.role, turn.text]), [['user', 'Main prompt.'], ['assistant', 'Main reply.']]);
  assert.ok(!JSON.stringify(reply).includes('SIDE'));
});

test('only typed prompts are user turns: origins, skipped tags, and older-shape peer envelopes', async (t) => {
  const { file } = await fixture(t);
  const envelope = (attributes, body) => `<cross-session-message ${attributes}>\n${body}\n</cross-session-message>`;
  await writeFile(file, jsonl([
    { type: 'user', timestamp: at(1), origin: { kind: 'human' }, message: { content: 'Typed human prompt.' } },
    { type: 'user', timestamp: at(2), message: { content: 'Typed older prompt.' } },
    { type: 'user', timestamp: at(3), origin: { kind: 'human' }, message: { content: '<pasted_content>[Image #1]</pasted_content>' } },
    { type: 'user', timestamp: at(4), origin: { kind: 'task-notification' }, message: { content: '<task-notification>TASKMARK</task-notification>' } },
    { type: 'user', timestamp: at(5), origin: { kind: 'task-notification' }, message: { content: '<scheduled-task>SCHEDULEDMARK</scheduled-task>' } },
    { type: 'user', timestamp: at(6), origin: { kind: 'plugin' }, message: { content: '<command-message>PLUGINMARK</command-message>' } },
    { type: 'user', timestamp: at(7), origin: { kind: 'human' }, message: { content: '<bash-input>BASHTYPEMARK</bash-input>' } },
    { type: 'user', timestamp: at(8), origin: { kind: 'human' }, message: { content: '<command-name>/compact</command-name> COMMANDTYPEMARK' } },
    { type: 'user', timestamp: at(9), message: { content: '<side-sessions-event>SIDEEVENTMARK</side-sessions-event>' } },
    { type: 'user', timestamp: at(10), message: { content: '<local-command-stdout>STDOUTTYPEMARK</local-command-stdout>' } },
    { type: 'user', timestamp: at(11), origin: { kind: 'something-else' }, message: { content: 'UNKNOWNORIGINMARK' } },
    { type: 'user', timestamp: at(12), message: { content: envelope('from="agent:abc" from-name="Desk Peer" from-session="abc"', 'ENVELOPEBODYMARK') } },
    { type: 'user', timestamp: at(13), message: { content: envelope('from-session="abc"', 'NONAMEMARK') } },
  ]));
  const reply = await readClaudeChat(file);
  assert.deepEqual(reply, { turns: [
    { role: 'user', text: 'Typed human prompt.', atMs: atMs(1), cut: false },
    { role: 'user', text: 'Typed older prompt.', atMs: atMs(2), cut: false },
    { role: 'user', text: '<pasted_content>[Image #1]</pasted_content>', atMs: atMs(3), cut: false },
    { role: 'peer', name: 'Desk Peer', text: 'ENVELOPEBODYMARK', atMs: atMs(12), cut: false },
  ], more: false });
  const text = JSON.stringify(reply);
  for (const marker of ['TASKMARK', 'SCHEDULEDMARK', 'PLUGINMARK', 'BASHTYPEMARK', 'COMMANDTYPEMARK', 'SIDEEVENTMARK',
    'STDOUTTYPEMARK', 'UNKNOWNORIGINMARK', 'NONAMEMARK', 'from-session', 'from-name', 'cross-session-message']) {
    assert.ok(!text.includes(marker), marker);
  }
});
