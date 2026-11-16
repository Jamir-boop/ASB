import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

const NO_ZSTD = !zlib.zstdCompressSync && 'Node has no zstd (before 22.15)';

test('a compressed Codex log gives the signals of its plain twin, and the plain log wins', { skip: NO_ZSTD }, async (t) => {
  const directory = await temporaryDirectory(t);
  let running = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const writer = rolloutWriter(seededRandom(5000 + seed));
    const body = writer.finish(writer.join([...writer.events(10 + seed), writer.lifecycle(), ...writer.quiet(1024)]));
    const plain = path.join(directory, `plain-${seed}.jsonl`);
    const packed = path.join(directory, `packed-${seed}.jsonl`);
    await fs.writeFile(plain, body);
    await fs.writeFile(`${packed}.zst`, zlib.zstdCompressSync(body));
    const expected = await readRolloutSignals(plain);
    if (expected.agentRunning === true) running += 1;
    assert.deepEqual(await readRolloutSignals(packed), expected, `seed ${seed}`);
  }
  assert.ok(running >= 5, `running: ${running}`);

  // Both files: the plain log is read, never the compressed one.
  const both = path.join(directory, 'both.jsonl');
  const line = (type) => `${JSON.stringify({ type: 'event_msg', timestamp: '2026-10-07T12:00:00Z', payload: { type } })}\n`;
  await fs.writeFile(both, line('task_started'));
  await fs.writeFile(`${both}.zst`, zlib.zstdCompressSync(line('task_complete')));
  const before = getCodexCacheStats().rolloutSignals.decompressions;
  assert.equal((await readRolloutSignals(both)).agentRunning, true);
  assert.equal(getCodexCacheStats().rolloutSignals.decompressions, before);
});

test('a warm scan of a compressed Codex log uses the cache, and a change decompresses again', { skip: NO_ZSTD }, async (t) => {
  const directory = await temporaryDirectory(t);
  const rolloutPath = path.join(directory, 'warm.jsonl');
  const line = (type) => `${JSON.stringify({ type: 'event_msg', timestamp: '2026-10-07T12:00:00Z', payload: { type } })}\n`;
  await fs.writeFile(`${rolloutPath}.zst`, zlib.zstdCompressSync(line('task_started')));
  const files = new Map();
  const fileScan = { canReuse: () => true, statusFiles: files };
  const decompressions = () => getCodexCacheStats().rolloutSignals.decompressions;
  const before = decompressions();
  assert.equal((await readRolloutSignals(rolloutPath, { cacheScope: 'zst-warm' })).agentRunning, true);
  assert.equal(decompressions(), before + 1);
  assert.equal((await readRolloutSignals(rolloutPath, { cacheScope: 'zst-warm' })).agentRunning, true);
  assert.equal((await readRolloutSignals(rolloutPath, { cacheScope: 'zst-warm', fileScan })).agentRunning, true);
  assert.equal(decompressions(), before + 1, 'a warm scan does not decompress');
  // The status check watches the compressed file, not the absent plain path.
  assert.deepEqual([...files.keys()], [`${rolloutPath}.zst`]);
  await fs.writeFile(`${rolloutPath}.zst`, zlib.zstdCompressSync(line('task_started') + line('task_complete')));
  assert.equal((await readRolloutSignals(rolloutPath, { cacheScope: 'zst-warm' })).agentRunning, false);
  assert.equal(decompressions(), before + 2);
});

test('a compressed Codex log is unreadable without zstd or when broken', async (t) => {
  const directory = await temporaryDirectory(t);
  const unreadable = (signals) => Object.getOwnPropertySymbols(signals).length === 1 && signals.agentRunning === null;
  const missing = path.join(directory, 'missing.jsonl');
  await fs.writeFile(`${missing}.zst`, zlib.zstdCompressSync ? zlib.zstdCompressSync('{}\n') : Buffer.from('synthetic'));
  // Node before 22.15 has no createZstdDecompress.
  const create = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  if (create) delete zlib.createZstdDecompress;
  try {
    assert.ok(unreadable(await readRolloutSignals(missing)));
  } finally {
    if (create) Object.defineProperty(zlib, 'createZstdDecompress', create);
  }
  const broken = path.join(directory, 'broken.jsonl');
  await fs.writeFile(`${broken}.zst`, Buffer.from('not a zstd frame'));
  assert.ok(unreadable(await readRolloutSignals(broken)));
  assert.ok(unreadable(await readRolloutSignals(path.join(directory, 'absent.jsonl'))));
});

test('a compressed Codex log larger than 16 MiB gives the signals of its whole text, and a line over 1 MiB is skipped', { skip: NO_ZSTD }, async (t) => {
  const directory = await temporaryDirectory(t);
  const line = (offset, payload) => JSON.stringify({ type: 'event_msg', timestamp: new Date(Date.parse('2026-10-07T12:00:00Z') + offset).toISOString(), payload });
  // 20 MiB of filler between a turn start and its end, a 2 MiB line with no signal, and an open question at the end.
  const filler = `${line(1000, { type: 'tool_output', text: 'x'.repeat(1000) })}\n`;
  const text = [line(0, { type: 'task_started' }), filler.repeat(20 * 1024).trimEnd(),
    JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', text: 'y'.repeat(2 * 1024 * 1024) } }),
    line(2000, { type: 'agent_message', message: 'Done.', phase: 'final_answer' }), line(3000, { type: 'task_complete' }),
    line(4000, { type: 'user_message', message: 'Please continue.' }), line(5000, { type: 'task_started' })].join('\n');
  assert.ok(text.length > 22 * 1024 * 1024);
  const rolloutPath = path.join(directory, 'large.jsonl');
  await fs.writeFile(`${rolloutPath}.zst`, zlib.zstdCompressSync(text));
  const expected = Object.fromEntries(Object.entries(parseRolloutSignals(text)));
  assert.equal(expected.agentRunning, true);
  const actual = await readRolloutSignals(rolloutPath);
  assert.deepEqual(actual, expected);
  assert.equal(Object.getOwnPropertySymbols(actual).length, 0);
});
