import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { createActivityUsage } from '../src/activity-usage.mjs';
import { scanFile } from '../src/usage-scan-cache.mjs';

const supported = typeof zlib.createZstdDecompress === 'function' && typeof zlib.zstdCompressSync === 'function';
const NOW = Date.now();
const timestamp = new Date(NOW - 60_000).toISOString();
const rollout = (output) => [JSON.stringify({ type: 'turn_context', timestamp, payload: { model: 'gpt-test' } }),
  JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: output, total_tokens: 10 + output },
    total_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: output, total_tokens: 10 + output },
  } } })].join('\n');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-zstd-'));
  const services = [];
  t.after(async () => {
    await Promise.all(services.flatMap((usage) => [usage.idle(), usage.pricesIdle()]));
    await fs.rm(root, { recursive: true, force: true });
  });
  const service = () => {
    const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'cache'), now: () => NOW,
      readSources: async () => [{ enabled: true, provider: 'codex', dataDir: root }],
      fetch: async () => { throw new Error('offline'); } });
    services.push(usage);
    return usage;
  };
  return { root, service };
}

test('compressed records match plain records, including a final unterminated line', { skip: !supported }, async (t) => {
  const { root } = await setup(t);
  const plain = path.join(root, 'a.jsonl');
  const compressed = `${plain}.zst`;
  await fs.writeFile(plain, `${rollout(5)}\n`);
  const bytes = zlib.zstdCompressSync(rollout(5));
  await fs.writeFile(compressed, bytes);
  const first = await scanFile(plain, await fs.stat(plain), undefined, 'codex');
  const stats = {};
  const second = await scanFile(compressed, await fs.stat(compressed), undefined, 'codex', { stats });
  assert.deepEqual(second.records, first.records);
  assert.deepEqual(second.state, first.state);
  assert.equal(second.offset, bytes.length);
  assert.equal(second.guardLength, Math.min(64, bytes.length));
  assert.equal(stats.bytesRead, bytes.length + second.guardLength);
  const read = stats.bytesRead;
  assert.equal(await scanFile(compressed, await fs.stat(compressed), second, 'codex', { stats }), second);
  assert.equal(stats.bytesRead, read);
  await fs.writeFile(compressed, zlib.zstdCompressSync(rollout(700)));
  const changed = await scanFile(compressed, await fs.stat(compressed), second, 'codex', { stats });
  assert.equal(changed.records[0][5], 700);
  assert.ok(stats.bytesRead > read);
  assert.equal(second.records[0][5], 5);
});

test('plain wins over its compressed copy; archived and valid files survive a corrupt stream', { skip: !supported }, async (t) => {
  const { root, service } = await setup(t);
  await fs.mkdir(path.join(root, 'sessions'));
  await fs.mkdir(path.join(root, 'archived_sessions'));
  await fs.writeFile(path.join(root, 'sessions', 'a.jsonl'), `${rollout(5)}\n`);
  await fs.writeFile(path.join(root, 'sessions', 'a.jsonl.zst'), zlib.zstdCompressSync(rollout(99)));
  const archived = path.join(root, 'archived_sessions', 'b.jsonl.zst');
  await fs.writeFile(archived, zlib.zstdCompressSync(rollout(7)));
  await fs.writeFile(path.join(root, 'sessions', 'bad.jsonl.zst'), 'broken');
  const usage = service();
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage[0].tokens.output, 12);
  const read = usage.stats.bytesRead;
  await usage.refresh();
  assert.equal(usage.stats.bytesRead, read + 6, 'only the corrupt file is read again');
  await fs.writeFile(archived, zlib.zstdCompressSync(rollout(80)));
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage[0].tokens.output, 85);
  await fs.writeFile(archived, 'broken');
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage[0].tokens.output, 5, 'a corrupt replacement does not retain old usage');
});

test('streaming yields between decompressed chunks and handles an input error', { skip: !supported }, async (t) => {
  const { root } = await setup(t);
  const file = path.join(root, 'many.jsonl.zst');
  const filler = JSON.stringify({ type: 'user', text: 'synthetic '.repeat(1000) });
  await fs.writeFile(file, zlib.zstdCompressSync(`${Array(100).fill(filler).join('\n')}\n${rollout(9)}`));
  let pauses = 0;
  const entry = await scanFile(file, await fs.stat(file), undefined, 'codex', { pause: async () => { pauses += 1; } });
  assert.ok(pauses > 2);
  assert.equal(entry.records[0][5], 9);
  await assert.rejects(scanFile(path.join(root, 'missing.jsonl.zst'), await fs.stat(file), undefined, 'codex'));
});
