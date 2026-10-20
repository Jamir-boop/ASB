import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCodexCacheStats, parseRolloutSignals, readRolloutSignals, readTail } from '../src/codex-data.mjs';
import { expectedSignals, rolloutWriter, seededRandom } from './rollout-writer.mjs';

// The scan reads 1 MiB first, then keeps 256 bytes of overlap in each later read.
const CHUNK_BORDERS = [1024 * 1024, 2 * 1024 * 1024 - 256];

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
