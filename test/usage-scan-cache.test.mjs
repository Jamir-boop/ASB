import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE_SLICE_CHARS, createYielder, decodeScanCache, encodeScanCache, loadUsageCache, MAX_REST_MS, pathKey, saveUsageCache, scanFile, SCAN_REST_RATIO } from '../src/usage-scan-cache.mjs';

const posix = process.platform !== 'win32';
const at = Date.parse('2026-10-20T10:00:00Z');
const stamp = (offsetMs) => new Date(at + offsetMs).toISOString();
const turn = (model) => JSON.stringify({ type: 'turn_context', timestamp: stamp(0), payload: { type: 'turn_context', model, cwd: 'SECRETFOLDER' } });
const usage = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output,
  reasoning_output_tokens: 0, total_tokens: input + output });
const count = (last, total, offsetMs = 1000) => JSON.stringify({ type: 'event_msg', timestamp: stamp(offsetMs),
  payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } });
const text = JSON.stringify({ type: 'response_item', timestamp: stamp(0), payload: { type: 'message', content: 'SECRETTEXT '.repeat(50) } });

async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-scan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const sum = (entry) => entry.records.reduce((total, record) => total + record[5], 0);

test('a grown file reads only its new bytes, with the model carried over', async (t) => {
  const file = path.join(await folder(t), 'rollout.jsonl');
  const head = [JSON.stringify({ type: 'session_meta', timestamp: stamp(0), payload: { id: 'session-1' } }), turn('gpt-test-1'),
    text, count(usage(100, 20), usage(100, 20)), text].join('\n') + '\n';
  await fs.writeFile(file, head);
  const stats = {};
  const first = await scanFile(file, await fs.stat(file), undefined, 'codex', { stats });
  assert.equal(stats.bytesRead, head.length + 64);
  assert.equal(first.offset, head.length);
  assert.equal(sum(first), 20);
  // Unchanged: no read at all.
  assert.equal(await scanFile(file, await fs.stat(file), first, 'codex', { stats }), first);
  assert.equal(stats.bytesRead, head.length + 64);
  // Appended lines, and an unterminated line that waits for its newline.
  const tail = `${count(usage(10, 5), usage(110, 25), 2000)}\n${text}\n`;
  const partial = count(usage(10, 7), usage(120, 32), 3000);
  await fs.appendFile(file, tail + partial);
  const second = await scanFile(file, await fs.stat(file), first, 'codex', { stats });
  assert.equal(stats.bytesRead - (head.length + 64), 64 + tail.length + partial.length);
  assert.equal(second.offset, head.length + tail.length);
  assert.equal(sum(second), 25);
  assert.equal(second.records[0][1], 'gpt-test-1');
  assert.equal(sum(first), 20, 'the old entry does not change');
  await fs.appendFile(file, '\n');
  const third = await scanFile(file, await fs.stat(file), second, 'codex', { stats });
  assert.equal(sum(third), 32);
});

test('a truncated file, or one whose first bytes changed, is read again from 0', async (t) => {
  const file = path.join(await folder(t), 'rollout.jsonl');
  const lines = [turn('gpt-test-1'), count(usage(100, 20), usage(100, 20)), count(usage(10, 5), usage(110, 25), 2000)];
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  const first = await scanFile(file, await fs.stat(file), undefined, 'codex');
  assert.equal(sum(first), 25);
  const shorter = `${lines.slice(0, 2).join('\n')}\n`;
  await fs.writeFile(file, shorter);
  const stats = {};
  const truncated = await scanFile(file, await fs.stat(file), first, 'codex', { stats });
  assert.equal(stats.bytesRead, shorter.length + 64);
  assert.equal(sum(truncated), 20);
  const rewritten = `${[JSON.stringify({ type: 'session_meta', timestamp: stamp(5), payload: { id: 'other' } }), turn('gpt-test-2'), count(usage(100, 9), usage(100, 9))].join('\n')}\n${'x'.repeat(first.size)}\n`;
  await fs.writeFile(file, rewritten);
  const changed = await scanFile(file, await fs.stat(file), first, 'codex');
  assert.deepEqual([changed.records.length, changed.records[0][1], sum(changed)], [1, 'gpt-test-2', 9]);
});

test('the disk cache is private, keyed by hashes, and has no path, title, or text', async (t) => {
  const dir = await folder(t);
  const transcript = path.join(dir, 'SECRETFOLDER', 'SECRETTITLE.jsonl');
  await fs.mkdir(path.dirname(transcript));
  await fs.writeFile(transcript, `${[turn('gpt-test-1'), text, count(usage(100, 20), usage(100, 20))].join('\n')}\n`);
  const claude = path.join(dir, 'SECRETFOLDER', 'claude.jsonl');
  await fs.writeFile(claude, `${JSON.stringify({ type: 'assistant', timestamp: stamp(0), sessionId: 'SECRETSESSION', requestId: 'SECRETREQUEST',
    message: { id: 'SECRETMESSAGE', model: 'claude-test-5', content: [{ type: 'text', text: 'SECRETTEXT' }], usage: { input_tokens: 1, output_tokens: 2 } } })}\n`);
  const cache = new Map();
  cache.set(pathKey(transcript), await scanFile(transcript, await fs.stat(transcript), undefined, 'codex'));
  cache.set(pathKey(claude), await scanFile(claude, await fs.stat(claude), undefined, 'claude'));
  const file = path.join(dir, 'cache', 'usage', 'usage-cache.json.gz');
  await saveUsageCache(file, cache);
  if (posix) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
  const compressed = await fs.readFile(file);
  assert.deepEqual([...compressed.subarray(0, 2)], [0x1f, 0x8b]);
  const bytes = gunzipSync(compressed).toString('utf8');
  for (const secret of ['SECRET', dir, os.tmpdir(), 'rollout', '.jsonl', 'session-1']) assert.ok(!bytes.includes(secret), secret);
  assert.deepEqual(Object.keys(JSON.parse(bytes).files).sort(), [pathKey(transcript), pathKey(claude)].sort());
  for (const key of Object.keys(JSON.parse(bytes).files)) assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(await loadUsageCache(file), cache);
  assert.equal((await fs.readdir(path.dirname(file))).length, 1, 'no temporary file is left');
});

test('a cache larger than one gzip slice saves and loads equal', async (t) => {
  const file = path.join(await folder(t), 'usage', 'usage-cache.json.gz');
  const state = { model: 'gpt-test-1', lastUsageSignature: null, lastCumulativeUsage: null, malformedRecords: 0, sawSessionMeta: false,
    suppressingForkCopies: false, forkCopyAnchorMs: 0 };
  const cache = new Map(Array.from({ length: 8000 }, (_, index) => [pathKey(`made-up-${index}`), { app: 'codex', size: index, mtimeMs: index,
    offset: index, guardLength: 0, guardHash: 'a'.repeat(32), state,
    records: Array.from({ length: 10 }, (_, row) => [index + row, `gpt-test-${row % 3}`, row, 2, 3, index, `key-${index}-${row}`]) }]));
  assert.ok(JSON.stringify(encodeScanCache(cache)).length > 2 * CACHE_SLICE_CHARS);
  await saveUsageCache(file, cache);
  assert.deepEqual(await loadUsageCache(file), cache);
});

test('a broken or unsafe cache file is ignored and replaced', async (t) => {
  const dir = await folder(t);
  const file = path.join(dir, 'usage', 'usage-cache.json.gz');
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.writeFile(file, '{"version":1,"models":[', { mode: 0o600 });
  assert.equal((await loadUsageCache(file)).size, 0);
  const entry = { app: 'codex', size: 10, mtimeMs: 1, offset: 10, guardLength: 10, guardHash: 'a'.repeat(32),
    state: { model: 'gpt-test-1', lastUsageSignature: null, lastCumulativeUsage: null, malformedRecords: 0, sawSessionMeta: false,
      suppressingForkCopies: false, forkCopyAnchorMs: 0 }, records: [[1, 'gpt-test-1', 1, 2, 3, 4, null]] };
  await saveUsageCache(file, new Map([[pathKey('a'), entry]]));
  assert.equal((await loadUsageCache(file)).size, 1);
  // An entry with a bad record or a bad state is dropped whole.
  const encoded = encodeScanCache(new Map([[pathKey('a'), entry], [pathKey('b'), { ...entry, state: { model: 1 } }],
    [pathKey('c'), { ...entry, records: [[1, 'gpt-test-1', -1, 2, 3, 4, null]] }]]));
  assert.deepEqual([...decodeScanCache(encoded).keys()], [pathKey('a')]);
  if (posix) {
    await fs.chmod(file, 0o644);
    assert.equal((await loadUsageCache(file)).size, 0);
  }
});

test('a plain cache loads only without gzip and is removed only after a successful compressed save', async (t) => {
  const dir = await folder(t);
  const transcript = path.join(dir, 'a.jsonl');
  await fs.writeFile(transcript, `${turn('gpt-test-1')}\n${count(usage(10, 2), usage(10, 2))}\n`);
  const cache = new Map([[pathKey(transcript), await scanFile(transcript, await fs.stat(transcript), undefined, 'codex')]]);
  const file = path.join(dir, 'usage', 'usage-cache.json.gz');
  const old = file.slice(0, -3);
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.writeFile(old, JSON.stringify(encodeScanCache(cache)), { mode: 0o600 });
  assert.deepEqual(await loadUsageCache(file), cache);
  await fs.mkdir(file);
  await assert.rejects(saveUsageCache(file, cache));
  assert.deepEqual(JSON.parse(await fs.readFile(old, 'utf8')), encodeScanCache(cache));
  await fs.rmdir(file);
  await saveUsageCache(file, cache);
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
  assert.deepEqual(await loadUsageCache(file), cache);
  // A broken gzip must not fall back to an obsolete plain cache.
  await fs.writeFile(old, JSON.stringify(encodeScanCache(cache)), { mode: 0o600 });
  await fs.writeFile(file, 'not gzip');
  assert.equal((await loadUsageCache(file)).size, 0);
});

test('gzip caches reject links, foreign files, unsafe modes, and broken JSON', async (t) => {
  const dir = await folder(t);
  const transcript = path.join(dir, 'a.jsonl');
  await fs.writeFile(transcript, `${turn('gpt-test-1')}\n${count(usage(10, 2), usage(10, 2))}\n`);
  const cache = new Map([[pathKey(transcript), await scanFile(transcript, await fs.stat(transcript), undefined, 'codex')]]);
  const file = path.join(dir, 'usage', 'usage-cache.json.gz');
  await saveUsageCache(file, cache);
  assert.deepEqual([...((await fs.readFile(file)).subarray(0, 2))], [0x1f, 0x8b]);
  assert.deepEqual(await loadUsageCache(file), cache);
  const target = `${file}.target`;
  await fs.rename(file, target);
  if (posix) {
    await fs.symlink(target, file);
    assert.equal((await loadUsageCache(file)).size, 0);
    await fs.unlink(file);
  }
  await fs.rename(target, file);
  if (posix) {
    const open = fs.open;
    const mock = t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => ({ ...await stat(), isFile: () => true, uid: process.getuid() + 1 });
      return handle;
    });
    assert.equal((await loadUsageCache(file)).size, 0);
    mock.mock.restore();
    await fs.chmod(file, 0o644);
    assert.equal((await loadUsageCache(file)).size, 0);
    await fs.chmod(file, 0o600);
    await fs.chmod(path.dirname(file), 0o755);
    assert.equal((await loadUsageCache(file)).size, 0);
    await fs.chmod(path.dirname(file), 0o700);
  }
  await fs.writeFile(file, gzipSync('{broken JSON'));
  assert.equal((await loadUsageCache(file)).size, 0);
});

test('array parsers keep every record in order and both new formats survive the disk encoding', async (t) => {
  const dir = await folder(t);
  const grok = path.join(dir, 'updates.jsonl');
  await fs.writeFile(grok, `${JSON.stringify({ timestamp: at, params: { sessionId: 'a', update: {
    sessionUpdate: 'turn_completed', prompt_id: 'p', usage: { modelUsage: {
      'grok-test-a': { inputTokens: 3 }, 'grok-test-b': { outputTokens: 4 } } } } } })}\n`);
  const pi = path.join(dir, 'pi.jsonl');
  await fs.writeFile(pi, `${JSON.stringify({ type: 'usage', id: 'a', timestamp: stamp(0),
    provider: 'test', model: 'model-a', usage: { output: 5 } })}\n`);
  const first = await scanFile(grok, await fs.stat(grok), undefined, 'grok');
  assert.deepEqual(first.records.map((row) => [row[1], row[2], row[5]]), [['grok-test-a', 3, 0], ['grok-test-b', 0, 4]]);
  const second = await scanFile(pi, await fs.stat(pi), undefined, 'pi');
  const cache = new Map([[pathKey(grok), first], [pathKey(pi), second]]);
  const encoded = encodeScanCache(cache);
  assert.equal(encoded.version, 2);
  assert.deepEqual(decodeScanCache(JSON.parse(JSON.stringify(encoded))), cache);
});

test('the scan yielder rests 3 times the CPU time of its work, at most 200 ms; without a rest ratio it only gives a turn', async () => {
  assert.equal(SCAN_REST_RATIO, 3);
  assert.equal(MAX_REST_MS, 200);
  const clock = { ms: 0, cpu: 0 };
  const work = (ms, cpu = ms) => { clock.ms += ms; clock.cpu += cpu; };
  const waits = [];
  const timers = { setTimeout: (resolve, delayMs) => { waits.push(delayMs); clock.ms += delayMs; resolve(); return { unref() {} }; } };
  const pause = createYielder(() => clock.ms, { restRatio: SCAN_REST_RATIO, timers, cpuMs: () => clock.cpu });
  work(10);
  await pause();
  assert.deepEqual(waits, []);
  work(15);
  await pause();
  assert.deepEqual(waits, [75]);
  // The work counts from the end of the last wait, with the CPU time of all threads.
  work(30, 50);
  await pause();
  assert.deepEqual(waits, [75, 150]);
  // A long blocking step adds one short rest only.
  work(5_000);
  await pause();
  assert.deepEqual(waits, [75, 150, 200]);
  const fast = createYielder(() => clock.ms, { timers, cpuMs: () => clock.cpu });
  work(100);
  await fast();
  assert.deepEqual(waits, [75, 150, 200]);
});
