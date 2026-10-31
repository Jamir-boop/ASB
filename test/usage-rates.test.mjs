// The LiteLLM rate loading with a fake fetch: these tests never use the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRateLoader, LITELLM_RATES_API_URL, LITELLM_RATES_URL, MAX_RATES_BYTES, RATES_TTL_MS } from '../src/usage-rates.mjs';

const posix = process.platform !== 'win32';
const DOCUMENT = { 'gpt-test-1': { input_cost_per_token: 1e-6, output_cost_per_token: 4e-6, cache_read_input_token_cost: 1e-7, mode: 'chat' },
  'claude-test-5': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 } };

async function setup(t, replies) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-rates-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let nowMs = Date.parse('2026-10-26T12:00:00Z');
  const fetch = async (url, options) => {
    calls.push({ url, accept: options.headers.accept, signal: options.signal });
    const reply = replies.shift() ?? 'fail';
    if (typeof reply === 'function') return reply();
    if (reply === 'fail') throw new Error('offline');
    return reply;
  };
  const file = path.join(dir, 'usage', 'usage-model-rates.json');
  const loader = () => createRateLoader({ file, fetch, now: () => nowMs });
  return { file, calls, loader, advance: (ms) => { nowMs += ms; }, now: () => nowMs };
}
const ok = (body = DOCUMENT) => new Response(typeof body === 'string' ? body : JSON.stringify(body));

test('the main URL gives fresh rates, saved privately with only the time and the models', async (t) => {
  const { file, calls, loader, now } = await setup(t, [ok()]);
  const rates = loader();
  assert.deepEqual(rates.pricing(), { source: 'LiteLLM', status: 'unavailable', fetchedAtMs: null, models: 0 });
  rates.ensure();
  assert.equal(rates.pricing().status, 'loading');
  await rates.idle();
  assert.deepEqual(rates.pricing(), { source: 'LiteLLM', status: 'fresh', fetchedAtMs: now(), models: 2 });
  assert.deepEqual(calls.map(({ url, accept }) => [url, accept]), [[LITELLM_RATES_URL, 'application/json']]);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.deepEqual(rates.table().get('claude-test-5'), { input: 3e-6, output: 1.5e-5, cacheRead: null, cacheWrite: null, cacheWrite1h: null,
    above200k: null, above272k: null });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['version', 'fetchedAtMs', 'models']);
  assert.equal(saved.version, 2);
  assert.deepEqual(Object.keys(saved.models).sort(), ['claude-test-5', 'gpt-test-1']);
  if (posix) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
  // Within 24 hours a new call loads nothing.
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 1);
});

test('a failed main URL tries the GitHub API URL with the raw Accept header', async (t) => {
  const { calls, loader } = await setup(t, [new Response('no', { status: 503 }), ok()]);
  const rates = loader();
  rates.ensure();
  await rates.idle();
  assert.deepEqual(calls.map(({ url, accept }) => [url, accept]),
    [[LITELLM_RATES_URL, 'application/json'], [LITELLM_RATES_API_URL, 'application/vnd.github.raw+json']]);
  assert.equal(rates.pricing().status, 'fresh');
});

test('both URLs failing gives unavailable, and no new try within 60 s', async (t) => {
  const { calls, loader, advance } = await setup(t, ['fail', ok('{"broken":')]);
  const rates = loader();
  rates.ensure();
  await rates.idle();
  assert.deepEqual(rates.pricing(), { source: 'LiteLLM', status: 'unavailable', fetchedAtMs: null, models: 0 });
  assert.equal(calls.length, 2);
  advance(59_000);
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 2);
  advance(2_000);
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 4, 'a new try asks both URLs again');
});

test('after a failure, the status is unavailable in the same tick during the retry floor, and loading only during a real try', async (t) => {
  const replies = [];
  const { calls, loader, advance } = await setup(t, replies);
  const rates = loader();
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 2);
  for (const step of [1_000, 29_000, 29_000]) {
    advance(step);
    rates.ensure();
    assert.equal(rates.pricing().status, 'unavailable');
    await rates.idle();
  }
  assert.equal(calls.length, 2);
  advance(2_000);
  let release;
  replies.push(() => new Promise((resolve) => { release = () => resolve(new Response('no', { status: 500 })); }));
  rates.ensure();
  assert.equal(rates.pricing().status, 'loading');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 3);
  assert.equal(rates.pricing().status, 'loading');
  release();
  await rates.idle();
  assert.equal(calls.length, 4);
  assert.equal(rates.pricing().status, 'unavailable');
});

test('a body above 32 MiB and a table with no model are failures', async (t) => {
  const huge = () => new Response(new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(1024 * 1024).fill(32);
      for (let index = 0; index <= MAX_RATES_BYTES / chunk.length; index += 1) controller.enqueue(chunk);
      controller.close();
    },
  }));
  const { calls, loader } = await setup(t, [huge, ok({ sample_spec: { mode: 'chat' } })]);
  const rates = loader();
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 2);
  assert.equal(rates.pricing().status, 'unavailable');
});

test('disk rates younger than 24 hours are used with no download; older ones start one in the background', async (t) => {
  const replies = [ok()];
  const { calls, loader, advance, now } = await setup(t, replies);
  const first = loader();
  first.ensure();
  await first.idle();
  const savedAt = now();
  advance(RATES_TTL_MS - 1000);
  const young = loader();
  young.ensure();
  await young.idle();
  assert.deepEqual(young.pricing(), { source: 'LiteLLM', status: 'cached', fetchedAtMs: savedAt, models: 2 });
  assert.equal(calls.length, 1);

  advance(2000);
  let release;
  replies.push(() => new Promise((resolve) => { release = () => resolve(ok()); }));
  const old = loader();
  old.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(old.pricing(), { source: 'LiteLLM', status: 'cached', fetchedAtMs: savedAt, models: 2 });
  assert.equal(calls.length, 2);
  release();
  await old.idle();
  assert.deepEqual(old.pricing(), { source: 'LiteLLM', status: 'fresh', fetchedAtMs: now(), models: 2 });
});

test('a broken disk cache is ignored and replaced', async (t) => {
  const { file, loader } = await setup(t, [ok()]);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, '{"fetchedAtMs":', { mode: 0o600 });
  const rates = loader();
  rates.ensure();
  await rates.idle();
  assert.equal(rates.pricing().status, 'fresh');
  assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).models).length, 2);
});

test('a fetch that never answers does not block: the reply says loading', async (t) => {
  const { loader } = await setup(t, [() => new Promise(() => {})]);
  const rates = loader();
  const started = Date.now();
  rates.ensure();
  assert.deepEqual(rates.pricing(), { source: 'LiteLLM', status: 'loading', fetchedAtMs: null, models: 0 });
  assert.ok(Date.now() - started < 50);
});

test('a disk cache without version 2 gives its rates at once and starts a download at once', async (t) => {
  const replies = [];
  const { file, calls, loader, now } = await setup(t, replies);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const savedAt = now() - 1000;
  await fs.writeFile(file, JSON.stringify({ fetchedAtMs: savedAt, models: { 'gpt-test-1': { input: 1e-6, output: 4e-6, cacheRead: 1e-7, cacheWrite: null } } }), { mode: 0o600 });
  let release;
  replies.push(() => new Promise((resolve) => { release = () => resolve(ok()); }));
  const rates = loader();
  rates.ensure();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.deepEqual(rates.pricing(), { source: 'LiteLLM', status: 'cached', fetchedAtMs: savedAt, models: 1 });
  assert.equal(rates.table().get('gpt-test-1').cacheWrite1h, null);
  release();
  await rates.idle();
  assert.deepEqual(rates.pricing(), { source: 'LiteLLM', status: 'fresh', fetchedAtMs: now(), models: 2 });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
  // The new version 2 cache keeps the 24-hour rule.
  const next = loader();
  next.ensure();
  await next.idle();
  assert.equal(next.pricing().status, 'cached');
  assert.equal(calls.length, 1);
});

test('an old disk cache whose download fails keeps its rates and tries again after the retry floor', async (t) => {
  const { file, calls, loader, advance } = await setup(t, ['fail', 'fail', ok()]);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ version: 1, fetchedAtMs: Date.parse('2026-10-26T11:00:00Z'), models: { 'gpt-test-1': { input: 1e-6, output: 4e-6, cacheRead: null, cacheWrite: null } } }), { mode: 0o600 });
  const rates = loader();
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 2);
  assert.equal(rates.pricing().status, 'cached');
  advance(61_000);
  rates.ensure();
  await rates.idle();
  assert.equal(calls.length, 3);
  assert.equal(rates.pricing().status, 'fresh');
});
