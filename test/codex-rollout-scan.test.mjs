import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCodexCacheStats, parseRolloutSignals, readRolloutSignals, readTail } from '../src/codex-data.mjs';

// The scan reads 1 MiB first, then keeps 256 bytes of overlap in each later read.
const CHUNK_BORDERS = [1024 * 1024, 2 * 1024 * 1024 - 256];
const LIFECYCLE_KEYS = ['agentRunning', 'agentStartedAtMs', 'agentActivityAtMs', 'latestLifecycleAtMs', 'latestLifecycleKind',
  'latestTaskStartedAtMs', 'latestTaskEndedAtMs', 'latestTaskEndKind'];
const QUESTION_KEYS = ['awaitingUserInput', 'userQuestionBlocking', 'latestUserQuestionAtMs', 'latestBlockingQuestionAtMs'];
const CALL_IDS = ['call_a', 'call_b', 'call_c'];
const WORDS = ['plain text', '日本語のテキスト', 'émoji 🚀 naïve', 'request_user_input in prose', '中文说明', 'Ünïcödé ✓'];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent of the scan: one pass of the tail and one pass of the whole file, merged by the rule of readRolloutSignals().
async function expectedSignals(filePath, tailBytes) {
  const tail = await readTail(filePath, tailBytes);
  const expected = Object.fromEntries(Object.entries(parseRolloutSignals(tail.text)));
  if (tail.start === 0) return expected;
  const whole = parseRolloutSignals(await fs.readFile(filePath, 'utf8'));
  const lifecycleFromWhole = expected.agentRunning === null;
  for (const key of lifecycleFromWhole ? [...LIFECYCLE_KEYS, ...QUESTION_KEYS] : QUESTION_KEYS) expected[key] = whole[key];
  if (lifecycleFromWhole && expected.agentRunning === true) {
    expected.agentActivityAtMs = Math.max(expected.agentStartedAtMs, expected.latestEventAtMs || 0);
  }
  return expected;
}

function rolloutWriter(random) {
  let time = Date.parse('2026-10-07T12:00:00Z');
  const pick = (list) => list[Math.floor(random() * list.length)];
  const text = (minimum = 0) => {
    let value = '';
    do value += `${pick(WORDS)} `; while (value.length < minimum || random() < 0.7);
    return value;
  };
  const line = (payload) => JSON.stringify({ type: 'event_msg', timestamp: new Date(time += 1000).toISOString(), payload });
  const call = (name = `${pick(['', 'functions.'])}request_user_input${pick(['', '_async'])}`) => {
    const value = line({ type: 'function_call', name, call_id: pick(CALL_IDS),
      arguments: JSON.stringify({ questions: Array.from({ length: 1 + Math.floor(random() * 2) }, (_, index) => ({ id: `q${index}` })) }) });
    return random() < 0.2 ? value.replace('"name":"', '"name" : "') : value;
  };
  const filler = (minimum = 0) => line({ type: pick(['tool_output', 'agent_message', 'token_count']), text: text(minimum) });
  // Some rollouts have few question calls, so the question map stays empty for long ranges.
  const kinds = [
    [pick([0.5, 3, 10]), call],
    [8, () => line({ type: 'function_call_output', call_id: pick(CALL_IDS),
      output: pick(['{"accepted":true}', '{"accepted":true}', '{"accepted":false}', '{"accepted":true,"error":"closed"}', 'not json', text()]) })],
    [5, () => line({ type: 'user_message', message: `<send_user_message_question_reply>${JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', pick(CALL_IDS), Math.floor(random() * 2)]), answer: text() },
    ])}</send_user_message_question_reply>` })],
    [2, () => line({ type: 'user_message', message: `Please continue. ${text()}` })],
    [1, () => line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Check this again. ${text()}` }] })],
    [4, () => line({ type: 'user_message', message: `<codex_internal_context>${text()}</codex_internal_context>` })],
    [1, () => line({ type: 'turn_aborted' })],
    [1, () => line({ type: 'task_complete', error: { message: 'failed' } })],
    [3, () => line({ type: 'task_complete' })],
    [4, () => line({ type: 'task_started' })],
    [6, () => line({ type: 'agent_message', message: `Call request_user_input when the name is "request_user_input". ${text()}` })],
    [6, () => line({ type: 'tool_output', text: JSON.stringify({ type: 'function_call', name: pick(['request_user_input', 'functions.request_user_input_async']), call_id: 'call_a', arguments: '{"questions":[{}]}' }) })],
    [3, () => line({ type: 'function_call', name: 'exec_command', call_id: pick(CALL_IDS), arguments: '{"cmd":"grep request_user_input"}' })],
    [3, () => call().slice(0, -1 - Math.floor(random() * 40))],
    [2, () => `{"type":"event_msg","payload":{"type":"task_started"`],
    [30, filler],
  ];
  const total = kinds.reduce((sum, [weight]) => sum + weight, 0);
  const event = () => {
    let at = random() * total;
    return kinds.find(([weight]) => (at -= weight) < 0)[1]();
  };
  const crlfRate = pick([0, 0, 0.3, 1]);
  const join = (lines) => Buffer.from(lines.map((value) => `${value}${random() < crlfRate ? '\r\n' : '\n'}`).join(''));
  let rest = Buffer.alloc(0);
  // Sometimes the result has a last line without a newline. The next call writes the missing bytes first.
  const finish = (buffer) => {
    const lastLine = buffer.lastIndexOf(10, buffer.length - 2) + 1;
    const cut = [buffer.length, buffer.length, buffer.length - (buffer.at(-2) === 13 ? 2 : 1),
      lastLine + 1 + Math.floor(random() * (buffer.length - lastLine - 1))][Math.floor(random() * 4)];
    const result = Buffer.concat([rest, buffer.subarray(0, cut)]);
    rest = buffer.subarray(cut);
    return result;
  };
  return {
    random, pick, call, filler, join, finish,
    lifecycle: () => line({ type: pick(['task_started', 'task_complete']) }),
    events: (count) => Array.from({ length: count }, event),
    // Lines without a lifecycle event that are longer than the tail.
    quiet: (bytes) => {
      const lines = [];
      for (let size = 0; size <= bytes; size += lines.at(-1).length + 2) lines.push(filler());
      return lines;
    },
  };
}

async function assertScan(filePath, tailBytes, label) {
  const actual = await readRolloutSignals(filePath, { initialBytes: tailBytes, maxBytes: tailBytes });
  assert.deepEqual(actual, await expectedSignals(filePath, tailBytes), label);
  return actual;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-rollout-scan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Codex rollout scan gives the result of a full pass for random rollouts and appends', async (t) => {
  const directory = await temporaryDirectory(t);
  const seen = { lifecycleFromScan: 0, questionOnly: 0, questionOnlyAppend: 0, lifecycleAfterQuestionOnly: 0, awaiting: 0, appends: 0 };
  for (let seed = 1; seed <= 320; seed += 1) {
    const writer = rolloutWriter(seededRandom(seed));
    const tailBytes = writer.pick([512, 1024, 4096]);
    const filePath = path.join(directory, `${seed}.jsonl`);
    const part = () => [
      ...writer.events(5 + Math.floor(writer.random() * 60)),
      // The tail has a lifecycle event, has no lifecycle event, or is random.
      ...[() => [writer.lifecycle(), ...Array.from({ length: Math.floor(writer.random() * 3) }, () => writer.filler())],
        () => [writer.lifecycle()], () => writer.quiet(tailBytes), () => []][Math.floor(writer.random() * 4)](),
    ];
    await fs.writeFile(filePath, writer.finish(writer.join([...writer.quiet(tailBytes * 2), ...part()])));
    let checkpoint = '';
    for (let step = 0; step <= seed % 4; step += 1) {
      if (step) {
        await fs.appendFile(filePath, writer.finish(writer.join(part())));
        seen.appends += 1;
      }
      const tail = parseRolloutSignals((await readTail(filePath, tailBytes)).text);
      const actual = await assertScan(filePath, tailBytes, `seed ${seed} step ${step}`);
      if (actual.awaitingUserInput) seen.awaiting += 1;
      if (tail.agentRunning === null) {
        seen.lifecycleFromScan += 1;
        if (checkpoint === 'question') seen.lifecycleAfterQuestionOnly += 1;
        checkpoint = 'full';
      } else if (checkpoint !== 'full' && !Object.getOwnPropertySymbols(tail).length) {
        // The tail has the lifecycle but not the full question history, and no full checkpoint exists.
        seen[checkpoint ? 'questionOnlyAppend' : 'questionOnly'] += 1;
        checkpoint = 'question';
      }
    }
  }
  for (const [name, count] of Object.entries(seen)) assert.ok(count >= 40, `${name}: ${count}`);
});

test('Codex rollout scan finds question calls that cross a read border', async (t) => {
  const directory = await temporaryDirectory(t);
  let awaiting = 0;
  for (let seed = 1; seed <= 36; seed += 1) {
    const writer = rolloutWriter(seededRandom(1000 + seed));
    const filePath = path.join(directory, `${seed}.jsonl`);
    const head = writer.join([...writer.events(seed % 3 ? 0 : 20), JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: 'stop' } })]);
    const call = writer.call();
    const needleAt = call.indexOf('request_user_input');
    // The border is in the needle, in the bytes before it, or immediately after it.
    const border = CHUNK_BORDERS[seed % 2] - Math.floor(writer.random() * 60) + 30;
    const padLine = JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', text: '' } });
    const pad = 'x'.repeat(border - head.length - padLine.length - 1 - needleAt);
    const body = Buffer.concat([head, Buffer.from(`${padLine.replace('""', `"${pad}"`)}\n`), writer.join([call]),
      writer.join([JSON.stringify({ type: 'event_msg', timestamp: '2026-10-08T12:00:00Z', payload: { type: 'task_started' } }),
        ...(seed % 4 ? [] : writer.events(10)), ...(seed % 5 ? [] : writer.quiet(4096))])]);
    assert.equal(body.indexOf('request_user_input', head.length + pad.length), border);
    await fs.writeFile(filePath, body);
    if ((await assertScan(filePath, 2048, `border seed ${seed}`)).awaitingUserInput) awaiting += 1;
  }
  assert.ok(awaiting >= 20, `awaiting: ${awaiting}`);
});

test('Codex rollout scan does not parse lines before the tail when no question call exists', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'large.jsonl');
  const writer = rolloutWriter(seededRandom(7));
  const record = (payload) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-07T12:00:00Z', payload });
  const lines = [];
  for (let index = 0; index < 6000; index += 1) {
    lines.push(
      record({ type: 'function_call_output', call_id: `call_${index}`, output: 'x'.repeat(400) }),
      record({ type: 'agent_message', message: 'Call request_user_input when the name is "request_user_input".' }),
      record({ type: 'tool_output', text: JSON.stringify({ name: 'request_user_input', call_id: 'call_a' }) }),
      record({ type: 'user_message', message: 'Please continue.' }),
      record({ type: 'task_complete' }),
    );
  }
  lines.push(...writer.quiet(2048), record({ type: 'task_started' }), writer.filler());
  await fs.writeFile(filePath, writer.join(lines));
  const { size } = await fs.stat(filePath);
  assert.ok(size > 3 * 1024 * 1024);
  const tailLines = (await readTail(filePath, 2048)).text.split('\n').filter((line) => line.trim()).length;
  const expected = await expectedSignals(filePath, 2048);
  assert.equal(expected.agentRunning, true);

  const before = getCodexCacheStats().rolloutSignals;
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...values) => {
    parsed += 1;
    return parse(...values);
  };
  let actual;
  try {
    actual = await readRolloutSignals(filePath, { initialBytes: 2048, maxBytes: 2048 });
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(actual, expected);
  assert.equal(parsed, tailLines);
  assert.equal(getCodexCacheStats().rolloutSignals.lifecycleBytesRead - before.lifecycleBytesRead, size);
});
