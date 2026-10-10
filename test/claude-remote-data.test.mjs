import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { loadClaudeRemoteThreads, loadSwitchboardClaudeThreads, parseClaudeRemoteBody, parseClaudeRemoteBodyAsync,
  shutdownClaudeRemoteParser, claudeRemoteDeepLink, getClaudeRemoteCacheStats,
  invalidateClaudeRemoteData, isClaudeRemoteCacheEvent } from '../src/claude-remote-data.mjs';
import { loadSwitchboardDashboard, buildSwitchboardDashboard, openSwitchboardThread, PendingTracker,
  switchboardWatchPaths } from '../src/switchboard.mjs';

const now = Date.parse('2026-10-07T14:00:00Z');
const localId = 'local_123e4567-e89b-12d3-a456-426614174000';
const cursor = (time) => Buffer.from(String(BigInt(time) * 1_000_000n)).toString('base64');
const row = (id = 'cse_01Example', extra = {}) => ({ id, title: 'Remote task', created_at: new Date(now - 10_000).toISOString(),
  updated_at: new Date(now).toISOString(), last_event_at: new Date(now).toISOString(),
  environment_kind: 'bridge', connection_status: 'connected', status: 'active', worker_status: 'running', unread: true, ...extra });
const frame = (event, data, id = '') => `event: ${event}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const watch = (rows, time = now) => rows.map((value) => frame('added', value)).join('') + frame('sync', {}, cursor(time));

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-remote-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function cacheFile(appDir, key, body, { incomplete = false, mtimeMs = now } = {}) {
  const root = path.join(appDir, 'Cache', 'Cache_Data');
  await mkdir(root, { recursive: true });
  const keyBytes = Buffer.from(key);
  const header = Buffer.alloc(24); header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(keyBytes.length, 12);
  const footer = Buffer.alloc(24); footer.writeBigUInt64LE(0xf4fa6f45970d41d8n);
  const headers = Buffer.from('HTTP/1.1 200 OK\0set-cookie: forbidden-cookie\0authorization: forbidden-token\0');
  const tail = Buffer.alloc(24); tail.writeBigUInt64LE(0xf4fa6f45970d41d8n); tail.writeUInt32LE(2, 8); tail.writeUInt32LE(headers.length, 16);
  const encoded = Buffer.isBuffer(body) ? body : zlib.gzipSync(Buffer.from(body));
  const bytes = incomplete ? Buffer.concat([header, keyBytes, encoded.subarray(0, -8), Buffer.alloc(4096)])
    : Buffer.concat([header, keyBytes, encoded, footer, headers, createHash('sha256').update(keyBytes).digest(), tail]);
  const name = `${createHash('sha1').update(keyBytes).digest().subarray(0, 8).reverse().toString('hex')}_0`;
  const file = path.join(root, name);
  await writeFile(file, bytes); await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('remote parser projects metadata, follows complete SSE frames, and bounds ID routes', () => {
  const value = row('cse_01Safe', { config: { sources: [{ type: 'git', url: 'https://github.com/example/orchid.git' },
    { type: 'git', url: 'https://token@github.com/example/private.git' }] },
  participants: [{ account_id: 'forbidden-account' }], external_metadata: { pending_action: { input: 'forbidden-question' } } });
  const parsed = parseClaudeRemoteBody(zlib.gzipSync(watch([value]) + frame('changed', { ...value, title: 'Newest' })
    + 'event: changed\ndata: {"id":"cse_01Safe","title":"half-written"'));
  assert.equal(parsed.records.get(value.id).title, 'Newest');
  assert.equal(parsed.records.get(value.id).projectName, 'orchid');
  assert.equal(parsed.observedAtMs, now);
  assert.equal(JSON.stringify([...parsed.records.values()]).includes('forbidden'), false);
  assert.equal(claudeRemoteDeepLink(value.id), 'claude://code/cse_01Safe');
  for (const id of ['local_legacy', 'cse_x?prompt=bad', 'session_/../new', `cse_${'a'.repeat(129)}`, 'https://example.com']) {
    assert.equal(claudeRemoteDeepLink(id), '');
  }
  assert.equal(parseClaudeRemoteBody(Buffer.alloc(8 * 1024 * 1024 + 1)), null);
  const bomb = zlib.gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x61));
  assert.equal(parseClaudeRemoteBody(bomb), null);
});

test('worker parsing matches the pure parser for approved bodies, partial frames, and byte limits', async () => {
  const list = Buffer.from(JSON.stringify({ data: [row()], resume_token: cursor(now) }));
  const events = Buffer.from(watch([row()]) + frame('changed', row(undefined, { title: 'Changed' }))
    + 'event: changed\ndata: {"id":"cse_01Example","title":"unfinished"');
  const partial = zlib.gzipSync(events).subarray(0, -8);
  const complete = Buffer.from(watch([row()]));
  const exactDecodedLimit = zlib.gzipSync(Buffer.concat([
    Buffer.from(`:${'a'.repeat(16 * 1024 * 1024 - complete.length - 3)}\n\n`), complete,
  ]));
  const cases = [
    [list, { kind: 'list' }], [zlib.gzipSync(list), { kind: 'list' }],
    [events, { kind: 'watch', startCursor: cursor(now - 1000), mtimeMs: now }],
    [zlib.gzipSync(events), {}], [partial, { incomplete: true }], [partial, {}],
    [events, { incomplete: true }], [Buffer.from('invalid JSON'), { kind: 'list' }],
    [Buffer.from([0x1f, 0x8b, 0]), {}], [Buffer.alloc(8 * 1024 * 1024 + 1), {}],
    [exactDecodedLimit, {}], [zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)), {}],
    [Buffer.from(frame('added', row()) + frame('sync', {}, 'invalid-cursor')), {}],
  ];
  if (zlib.zstdCompressSync) cases.push([zlib.zstdCompressSync(list), { kind: 'list' }]);
  for (const [body, options] of cases) {
    const before = Buffer.from(body);
    assert.deepEqual(await parseClaudeRemoteBodyAsync(body, options), parseClaudeRemoteBody(body, options));
    assert.deepEqual(body, before);
  }
  assert.equal((await parseClaudeRemoteBodyAsync(exactDecodedLimit)).records.size, 1);
});

test('the shared worker bounds queued bodies, cancels jobs, and recovers after an unexpected exit', async () => {
  const body = Buffer.from(watch([row()]));
  await parseClaudeRemoteBodyAsync(body);
  const before = getClaudeRemoteCacheStats();
  await parseClaudeRemoteBodyAsync(body);
  assert.equal(getClaudeRemoteCacheStats().parserStarts, before.parserStarts);

  const pending = Array.from({ length: 512 }, () => parseClaudeRemoteBodyAsync(body));
  const settled = Promise.allSettled(pending);
  await assert.rejects(parseClaudeRemoteBodyAsync(body), /queue is full/);
  await shutdownClaudeRemoteParser();
  assert.ok((await settled).every((result) => result.status === 'rejected'));
  assert.equal(getClaudeRemoteCacheStats().parserPending, 0);

  const large = Buffer.alloc(8 * 1024 * 1024);
  const largeJobs = Array.from({ length: 6 }, () => parseClaudeRemoteBodyAsync(large));
  const largeSettled = Promise.allSettled(largeJobs);
  await assert.rejects(parseClaudeRemoteBodyAsync(large), /queue is full/);
  await shutdownClaudeRemoteParser();
  assert.ok((await largeSettled).every((result) => result.status === 'rejected'));
  assert.equal(getClaudeRemoteCacheStats().pendingBodyBytes, 0);

  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function () { void this.terminate(); };
  try { await assert.rejects(parseClaudeRemoteBodyAsync(body), /remote cache parser stopped/); }
  finally { Worker.prototype.postMessage = postMessage; }
  assert.deepEqual(await parseClaudeRemoteBodyAsync(body), parseClaudeRemoteBody(body));
  await assert.rejects(parseClaudeRemoteBodyAsync(body, { mtimeMs: () => 0 }), /remote cache parser stopped/);
  assert.deepEqual(await parseClaudeRemoteBodyAsync(body), parseClaudeRemoteBody(body));
});

test('pending parser work finishes and an idle worker does not keep Node alive', () => {
  const moduleUrl = new URL('../src/claude-remote-data.mjs', import.meta.url).href;
  const script = `import { parseClaudeRemoteBodyAsync } from ${JSON.stringify(moduleUrl)};
    parseClaudeRemoteBodyAsync(Buffer.from(${JSON.stringify(watch([row()]))}))
      .then((result) => process.stdout.write(String(result.records.size)));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '1');
});

test('large compressed watches leave the event loop responsive during decode and parse', async (t) => {
  const one = frame('changed', row('cse_synthetic', { title: 'Synthetic '.repeat(14) }));
  const body = zlib.gzipSync(one.repeat(Math.floor(15 * 1024 * 1024 / Buffer.byteLength(one)))
    + frame('sync', {}, cursor(now)));
  await parseClaudeRemoteBodyAsync(Buffer.from(watch([row()])));
  async function measure(parse) {
    let ticksDuringParse = 0, maxDelayMs = 0, last = performance.now(), complete = false;
    const timer = setInterval(() => {
      const time = performance.now();
      maxDelayMs = Math.max(maxDelayMs, time - last - 2); last = time;
      if (!complete) ticksDuringParse += 1;
    }, 2);
    try {
      const start = performance.now();
      assert.equal((await parse(body)).records.size, 1);
      const totalMs = performance.now() - start;
      complete = true;
      await new Promise((resolve) => setTimeout(resolve, 4));
      return { ticksDuringParse, totalMs, maxDelayMs };
    } finally { clearInterval(timer); }
  }
  const synchronous = await measure(parseClaudeRemoteBody);
  const worker = await measure(parseClaudeRemoteBodyAsync);
  assert.equal(synchronous.ticksDuringParse, 0);
  assert.ok(worker.ticksDuringParse >= 2);
  t.diagnostic(JSON.stringify({ synchronous, worker }));
});

test('concurrent remote scans coalesce and shutdown cancels queued response reads', async (t) => {
  const appDir = await temp(t);
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch', watch([row()]));
  const before = getClaudeRemoteCacheStats();
  const scans = await Promise.all(Array.from({ length: 8 }, () => loadClaudeRemoteThreads({ appDir, nowMs: now })));
  assert.ok(scans.every((result) => result.threads.length === 1));
  assert.equal(getClaudeRemoteCacheStats().bodyReads - before.bodyReads, 1);
  assert.equal(getClaudeRemoteCacheStats().parserJobs - before.parserJobs, 1);
  const warm = getClaudeRemoteCacheStats();
  await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.equal(getClaudeRemoteCacheStats().bodyReads, warm.bodyReads);

  const other = await temp(t);
  for (let index = 0; index < 12; index += 1) await cacheFile(other,
    `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - index - 1))}`,
    watch([row(`cse_${index}`)]));
  const postMessage = Worker.prototype.postMessage;
  let stopped;
  const closing = new Promise((resolve) => { stopped = resolve; });
  Worker.prototype.postMessage = function (...args) {
    const result = postMessage.apply(this, args);
    stopped(shutdownClaudeRemoteParser());
    return result;
  };
  const scan = loadClaudeRemoteThreads({ appDir: other, nowMs: now });
  const rejected = assert.rejects(scan, /remote cache parser stopped/);
  try { await closing; await rejected; }
  finally { Worker.prototype.postMessage = postMessage; }
  assert.equal(getClaudeRemoteCacheStats().parserPending, 0);
  assert.equal((await loadClaudeRemoteThreads({ appDir: other, nowMs: now })).threads.length, 1);
});

test('newest cursor chain excludes old login streams and applies changes and deletions', async (t) => {
  const appDir = await temp(t);
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions?limit=100', JSON.stringify({
    data: [row('cse_01Retained'), row('cse_01Removed')], resume_token: cursor(now - 2000),
  }), { mtimeMs: now - 2000 });
  await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - 2000))}`,
    frame('changed', row('cse_01Retained', { worker_status: 'idle', title: 'Latest title' }))
      + frame('removed', { id: 'cse_01Removed' }) + frame('sync', {}, cursor(now)));
  await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - 9000))}`,
    watch([row('cse_01OldLogin')], now - 8000), { mtimeMs: now - 8000 });
  const result = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.equal(result.partial, false);
  assert.deepEqual(result.threads.map((thread) => thread.externalId), ['cse_01Retained']);
  assert.equal(result.threads[0].title, 'Latest title');
  assert.equal(buildSwitchboardDashboard(result.threads, [], now).threads[0].state, 'idle');
  const later = await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now + 1000))}`,
    watch([row('cse_01CurrentOnly')], now + 2000), { mtimeMs: now + 2000 });
  const current = await loadClaudeRemoteThreads({ appDir, nowMs: now + 2000 });
  assert.equal(current.partial, true);
  assert.deepEqual(current.threads.map((thread) => thread.externalId), ['cse_01CurrentOnly']);
  assert.equal(isClaudeRemoteCacheEvent(path.dirname(later), path.basename(later), 'change'), true);
});

test('response budget retains a full-list cursor chain and caps projected unique sessions', async (t) => {
  const appDir = await temp(t);
  const rows = Array.from({ length: 5000 }, (_, index) => row(`cse_${index}`));
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions?limit=5000', JSON.stringify({
    data: rows, resume_token: cursor(now - 2000),
  }), { mtimeMs: now - 2000 });
  await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - 2000))}`,
    frame('changed', row('cse_0', { title: 'Updated task', worker_status: 'idle' })) + frame('sync', {}, cursor(now)));
  const result = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.equal(result.partial, false);
  assert.equal(result.threads.length, 5000);
  assert.equal(new Set(result.threads.map((thread) => thread.externalId)).size, 5000);
  assert.equal(result.threads.find((thread) => thread.externalId === 'cse_0').title, 'Updated task');
  assert.equal(result.threads.find((thread) => thread.externalId === 'cse_0').remoteWorkerStatus, 'idle');
  await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now))}`,
    watch([row('cse_5000')], now + 1000), { mtimeMs: now + 1000 });
  const capped = await loadClaudeRemoteThreads({ appDir, nowMs: now + 1000 });
  assert.equal(capped.partial, false);
  assert.equal(capped.threads.length, 5000);
  assert.equal(capped.threads.find((thread) => thread.externalId === 'cse_0').title, 'Updated task');
  const before = getClaudeRemoteCacheStats();
  await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - 5000))}`,
    watch([row('cse_01OldLogin')], now - 4000), { mtimeMs: now - 4000 });
  const current = await loadClaudeRemoteThreads({ appDir, nowMs: now + 1000 });
  assert.equal(current.partial, false);
  assert.equal(current.threads.length, 5000);
  assert.equal(getClaudeRemoteCacheStats().responseEntries, before.responseEntries);
  assert.equal(getClaudeRemoteCacheStats().sessionEntries, before.sessionEntries);
});

test('open gzip watch entries are read without a closed footer and unrelated writes reuse the key index', async (t) => {
  const appDir = await temp(t);
  const file = await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch?exclude_tags=-', watch([row()]), { incomplete: true });
  await cacheFile(appDir, '1/0/https://claude.ai/api/oauth/organizations/private/oauth_tokens', JSON.stringify({ token: 'forbidden-auth' }));
  const first = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.equal(first.threads.length, 1);
  const before = getClaudeRemoteCacheStats();
  await loadClaudeRemoteThreads({ appDir, nowMs: now + 1 });
  const warm = getClaudeRemoteCacheStats();
  assert.equal(warm.keyReads, before.keyReads);
  assert.equal(warm.bodyReads, before.bodyReads);
  assert.equal(warm.directoryReads, before.directoryReads);
  const unrelated = await cacheFile(appDir, '1/0/https://claude.ai/api/account', '{}');
  assert.equal(isClaudeRemoteCacheEvent(path.dirname(file), path.basename(unrelated), 'change'), false);
  await loadClaudeRemoteThreads({ appDir, nowMs: now + 2 });
  const after = getClaudeRemoteCacheStats();
  assert.equal(after.keyReads - warm.keyReads, 1);
  assert.equal(after.bodyReads, warm.bodyReads);
  invalidateClaudeRemoteData({ filePath: file });
  await loadClaudeRemoteThreads({ appDir, nowMs: now + 3 });
  assert.equal(getClaudeRemoteCacheStats().bodyReads - after.bodyReads, 1);
  assert.equal(JSON.stringify(first).includes('forbidden'), false);
});

test('remote states require explicit fresh metadata; cloud does not require a bridge connection', async (t) => {
  const appDir = await temp(t);
  const values = [row('cse_01Running'), row('cse_01Waiting', { worker_status: 'requires_action' }),
    row('cse_01Idle', { worker_status: 'idle' }), row('cse_01Unknown', { worker_status: 'WORKER_STATUS_UNSPECIFIED' }),
    row('cse_01Disconnected', { connection_status: 'disconnected' }),
    row('cse_01Cloud', { environment_kind: 'anthropic_cloud', connection_status: undefined }),
    row('cse_01Archived', { status: 'archived', worker_status: 'idle' }),
    row('cse_01Failed', { status: 'failed', worker_status: 'idle' })];
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch', watch(values));
  const result = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  const board = buildSwitchboardDashboard(result.threads, [], now);
  const rows = Object.fromEntries(board.threads.map((value) => [value.externalId, value]));
  assert.deepEqual(values.map((value) => rows[value.id].state), ['working', 'waiting', 'idle', 'unknown', 'unknown', 'working', 'idle', 'idle']);
  assert.deepEqual([rows.cse_01Failed.lastOutcome, rows.cse_01Failed.failedAtMs, rows.cse_01Failed.completionAtMs], ['failed', now, 0]);
  assert.equal(rows.cse_01Archived.archived, true);
  assert.equal(rows.cse_01Running.workingSinceMs, 0);
  assert.equal(rows.cse_01Running.cwd, '');
  assert.equal(rows.cse_01Running.projectName, 'No project');
  assert.equal(board.refreshIntervalMs, 2000);
  const stale = buildSwitchboardDashboard(result.threads, [], now + 7 * 3_600_000);
  assert.ok(stale.threads.every((value) => value.state === 'unknown' && value.nativeUnread === null));
  assert.equal(stale.refreshIntervalMs, 5000);
  const tracker = new PendingTracker(false);
  await tracker.observe(board);
  assert.equal(rows.cse_01Running.pending, false);
  assert.equal(rows.cse_01Idle.pending, true);
  await tracker.markUnread(rows.cse_01Running.id); tracker.apply(rows.cse_01Running);
  assert.equal(rows.cse_01Running.state, 'working'); assert.equal(rows.cse_01Running.manualUnread, true);
  assert.equal(rows.cse_01Running.pending, false); assert.equal(rows.cse_01Running.unread, false);
  await tracker.setPinned(rows.cse_01Running.id, true); tracker.apply(rows.cse_01Running);
  assert.equal(rows.cse_01Running.pinned, true);
});

test('default source merges local aliases, retains each source on failure, and validates remote opens', async (t) => {
  const appDir = await temp(t);
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch', watch([row('session_01Twin'), row('cse_01Remote')]));
  const scan = () => loadSwitchboardDashboard({ nowMs: now, loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir, projectsDir: path.join(appDir, 'projects') } });
  const remoteOnly = await scan();
  assert.equal(remoteOnly.threads.length, 2); assert.equal(remoteOnly.providers[1].status, 'warning');
  const localDir = path.join(appDir, 'claude-code-sessions'); await mkdir(localDir);
  await writeFile(path.join(localDir, `${localId}.json`), JSON.stringify({ sessionId: localId, title: 'Local task', bridgeSessionIds: ['session_01Twin'] }));
  const mixed = await scan();
  assert.equal(mixed.threads.length, 2);
  assert.deepEqual(new Set(mixed.threads.map((value) => value.externalId)), new Set([localId, 'cse_01Remote']));
  assert.equal(JSON.stringify(mixed).includes('bridgeSessionIds'), false);
  const remote = mixed.threads.find((value) => value.externalId === 'cse_01Remote');
  const calls = [];
  assert.equal((await openSwitchboardThread(remote, { platform: 'linux', runCommand: async (...args) => { calls.push(args); return {}; } })).opened, true);
  assert.deepEqual(calls[0].slice(0, 2), ['xdg-open', ['claude://code/cse_01Remote']]);
  await assert.rejects(openSwitchboardThread({ ...remote, appDeepLink: 'claude://code/new?prompt=bad' }), /no direct desktop link/);
  assert.ok(switchboardWatchPaths({ appDir }).some((entry) => entry.path === path.join(appDir, 'Cache', 'Cache_Data')));
  await rm(path.join(appDir, 'Cache', 'Cache_Data'), { recursive: true });
  await writeFile(path.join(appDir, 'Cache', 'Cache_Data'), 'not a directory');
  const localOnly = await scan();
  assert.equal(localOnly.threads.length, 1); assert.equal(localOnly.threads[0].externalId, localId);
  assert.equal(localOnly.providers[1].status, 'warning');
  const injected = await loadSwitchboardDashboard({ nowMs: now, loadCodex: async () => ({ threads: [] }), loadClaude: async () => ({ threads: [] }) });
  assert.equal(injected.threads.length, 0);
});

test('desktop bridge session aliases match cse cache IDs and keep the local row identity', async (t) => {
  const appDir = await temp(t);
  const localDir = path.join(appDir, 'claude-code-sessions', 'account', 'organization');
  await mkdir(localDir, { recursive: true });
  const configId = 'local_123e4567-e89b-12d3-a456-426614174001';
  for (const metadata of [
    { sessionId: localId, cliSessionId: '123e4567-e89b-12d3-a456-426614174010',
      title: 'Build task', cwd: '/work/build', bridgeSessionIds: ['session_01Build'] },
    { sessionId: configId, cliSessionId: '123e4567-e89b-12d3-a456-426614174011',
      title: 'Config task', cwd: '/work/config', bridgeSessionIds: [
      'session_01ConfigFirst', 'session_01ConfigSecond', 'session_01ConfigPrevious', 'session_01ConfigCurrent',
    ] },
  ]) {
    await writeFile(path.join(localDir, `${metadata.sessionId}.json`), JSON.stringify({ ...metadata,
      lastActivityAt: now - 60_000, authorization: 'forbidden-local-token', config: { secret: 'forbidden-config' } }));
  }
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions?limit=100', JSON.stringify({ data: [
    row('cse_01Build', { title: 'Build task' }),
    row('cse_01ConfigPrevious', { title: 'Config task' }),
    row('cse_01ConfigCurrent', { title: 'Config task' }),
    row('cse_01Distinct', { title: 'Build task' }),
    row('cse_01Cloud', { title: 'Config task', environment_kind: 'anthropic_cloud', connection_status: undefined }),
  ], resume_token: cursor(now) }));
  const options = { appDir, projectsDir: path.join(appDir, 'projects'), maxCount: 5000,
    strictMetadataRead: true, nowMs: now };
  assert.equal((await loadClaudeRemoteThreads(options)).threads.length, 5);
  const merged = await loadSwitchboardClaudeThreads(options);
  assert.equal(merged.threads.length, 4);
  assert.equal(merged.provider.status, 'desktop');
  const board = buildSwitchboardDashboard(merged.threads, [], now);
  assert.deepEqual(new Set(board.threads.map((value) => value.externalId)), new Set([
    localId, configId, 'cse_01Distinct', 'cse_01Cloud',
  ]));
  const local = board.threads.find((value) => value.externalId === localId);
  assert.equal(local.cwd, '/work/build');
  assert.equal(local.appDeepLink, `claude://code/continue?session=${localId}`);
  assert.equal(local.state, 'unknown');
  const config = board.threads.find((value) => value.externalId === configId);
  assert.equal(config.cwd, '/work/config');
  assert.equal(config.appDeepLink, `claude://code/continue?session=${configId}`);
  assert.ok(board.threads.filter((value) => value.externalId.startsWith('cse_')).every((value) => value.state === 'working'));
  assert.equal(JSON.stringify(board).includes('bridgeSessionIds'), false);
  assert.equal(JSON.stringify(board).includes('forbidden'), false);
  const before = getClaudeRemoteCacheStats();
  assert.equal((await loadSwitchboardClaudeThreads(options)).threads.length, 4);
  const after = getClaudeRemoteCacheStats();
  assert.equal(after.bodyReads, before.bodyReads);
  assert.equal(after.keyReads, before.keyReads);
});

test('bridge aliases reject malformed links and preserve remote rows with ambiguous local owners', async (t) => {
  const appDir = await temp(t);
  const localDir = path.join(appDir, 'claude-code-sessions');
  await mkdir(localDir);
  const metadata = [
    { bridgeSessionIds: ['session_01Ambiguous'] },
    { bridgeSessionIds: ['cse_01Ambiguous'] },
    { bridgeSessionIds: 'session_01String' },
    { bridgeSessionIds: { sessionId: 'session_01Object' } },
    { bridgeSessionIds: [null, 1, true, {}, ['session_01Nested'], 'session_01Bad?query',
      'forbidden-alias', `session_${'a'.repeat(129)}`, 'session_01Valid', 'session_01Valid', 'cse_01Valid'] },
    { bridgeSessionIds: ['session_01Cloud', 'cse_01CloudDirect', 'session_session_01Other'] },
    { sessionId: 'local_legacy', bridgeSessionIds: ['session_01InvalidOwner'] },
  ];
  for (let index = 0; index < metadata.length; index += 1) {
    const session = { sessionId: `local_123e4567-e89b-12d3-a456-42661417400${index}`, title: 'Same task', ...metadata[index] };
    await writeFile(path.join(localDir, `${session.sessionId}.json`), JSON.stringify(session));
  }
  const retained = ['cse_01Ambiguous', 'session_01Ambiguous', 'cse_01String', 'cse_01Object',
    'cse_01Nested', 'cse_01Bad', 'cse_01InvalidOwner', 'session_01Other', 'cse_01Cloud'];
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions?limit=100', JSON.stringify({ data: [
    ...retained.map((id) => row(id, { title: 'Same task',
      ...(id === 'cse_01Cloud' ? { environment_kind: 'anthropic_cloud' } : {}) })),
    row('cse_01Valid'), row('session_01Valid'), row('cse_01CloudDirect', { environment_kind: 'anthropic_cloud' }),
  ], resume_token: cursor(now) }));
  const merged = await loadSwitchboardClaudeThreads({ appDir, projectsDir: path.join(appDir, 'projects'), maxCount: 5000, strictMetadataRead: true, nowMs: now });
  assert.equal(merged.threads.filter((value) => value.source !== 'claude-remote-cache').length, metadata.length);
  assert.deepEqual(new Set(merged.threads.filter((value) => value.source === 'claude-remote-cache')
    .map((value) => value.externalId)), new Set(retained));
  assert.equal(JSON.stringify(buildSwitchboardDashboard(merged.threads, [], now)).includes('forbidden'), false);
});

test('zstd list responses use the built-in decoder when available', { skip: !zlib.zstdCompressSync }, () => {
  const value = { data: [row('cse_01Zstd')], resume_token: cursor(now) };
  const parsed = parseClaudeRemoteBody(zlib.zstdCompressSync(Buffer.from(JSON.stringify(value))), { kind: 'list' });
  assert.equal(parsed.records.size, 1); assert.equal(parsed.observedAtMs, now);
});

test('partial keys retry, changed targets revalidate their key, and source order wins after a deletion', async (t) => {
  const appDir = await temp(t);
  const key = '1/0/https://claude.ai/v1/code/sessions/watch?exclude_tags=-';
  const file = await cacheFile(appDir, key, watch([row('cse_01Recovered')]));
  await writeFile(file, Buffer.alloc(10));
  assert.equal((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads.length, 0);
  await cacheFile(appDir, key, watch([row('cse_01Recovered')]));
  assert.equal((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads.length, 1);
  const buffer = Buffer.alloc(500); await writeFile(file, buffer);
  assert.equal((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads.length, 0);
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions?limit=100', JSON.stringify({
    data: [row('cse_01Readded', { title: 'Before removal', updated_at: new Date(now - 2000).toISOString() })], resume_token: cursor(now - 1000),
  }), { mtimeMs: now - 1000 });
  await cacheFile(appDir, `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - 1000))}`,
    frame('removed', { id: 'cse_01Readded' }) + frame('added', row('cse_01Readded', { title: 'After re-add', updated_at: new Date(now - 3000).toISOString() }))
      + frame('changed', row('cse_01Readded', { title: 'Event receipt', updated_at: new Date(now - 3000).toISOString() }), cursor(now)));
  const result = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.equal(result.threads[0].title, 'Event receipt');
  assert.equal(result.partial, false);
});

test('the newest cache target beyond 512 entries is selected and future or invalid receipts are rejected', async (t) => {
  const appDir = await temp(t);
  for (let index = 0; index < 513; index += 1) await cacheFile(appDir,
    `1/0/https://claude.ai/v1/code/sessions/watch?resume_token=${encodeURIComponent(cursor(now - index - 1))}`,
    watch([row(`cse_${index}`)], now - index - 1), { mtimeMs: now - index - 1 });
  const newest = await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch?include_trigger_sessions=true', watch([row('cse_01Newest')]));
  assert.equal((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads[0].externalId, 'cse_01Newest');
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch?include_trigger_sessions=true', watch([row('cse_01Future')], now + 1));
  const future = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.ok(future.threads.every((value) => value.externalId !== 'cse_01Future'));
  await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch?include_trigger_sessions=true',
    frame('added', row('cse_01Invalid')) + frame('sync', {}, 'invalid-cursor'));
  const invalid = await loadClaudeRemoteThreads({ appDir, nowMs: now });
  assert.ok(invalid.threads.every((value) => value.externalId !== 'cse_01Invalid'));
  assert.ok(getClaudeRemoteCacheStats().responseEntries <= 32 * 512);
  assert.ok(getClaudeRemoteCacheStats().sessionEntries <= 32 * 512 * 5000);
  assert.equal(isClaudeRemoteCacheEvent(path.dirname(newest), path.basename(newest), 'change'), true);
});

test('stable-file checks cover writes during discovery and response key validation', async (t) => {
  const appDir = await temp(t);
  const filePath = await cacheFile(appDir, '1/0/https://claude.ai/v1/code/sessions/watch', watch([row('cse_01Race')]));
  const complete = await readFile(filePath);
  const open = fs.open;
  let mode = 'discovery', keyReads = 0, changed = false, watchedPath = filePath;
  fs.open = async (...args) => {
    const file = await open(...args);
    if (args[0] !== watchedPath) return file;
    const read = file.read.bind(file);
    file.read = async (...readArgs) => {
      const result = await read(...readArgs);
      if (!changed && mode === 'discovery' && readArgs[3] === 0 && result.bytesRead === 10) {
        changed = true; await writeFile(watchedPath, complete);
      }
      if (mode === 'response' && readArgs[3] === 24 && ++keyReads === 2) {
        const invalid = Buffer.from(complete); invalid.fill(0, 0, 24);
        await writeFile(watchedPath, invalid);
      }
      return result;
    };
    return file;
  };
  try {
    await writeFile(filePath, Buffer.alloc(10));
    await loadClaudeRemoteThreads({ appDir, nowMs: now });
    assert.equal((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads.length, 1);
    const other = await temp(t);
    const otherPath = await cacheFile(other, '1/0/https://claude.ai/v1/code/sessions/watch', watch([row('cse_01Race')]));
    mode = 'response'; keyReads = 0; watchedPath = otherPath;
    assert.equal((await loadClaudeRemoteThreads({ appDir: other, nowMs: now })).threads.length, 0);
    assert.equal(keyReads, 2);
  } finally { fs.open = open; }
});

test('remote Discard uses explicit successful ends, clears generic Idle, and exposes missed-run limits', async (t) => {
  for (const terminal of ['completed', 'review_ready', 'generic', 'failed']) {
    const appDir = await temp(t);
    const key = '1/0/https://claude.ai/v1/code/sessions/watch';
    await cacheFile(appDir, key, watch([row()]));
    const tracker = new PendingTracker(false);
    const first = await tracker.observe(buildSwitchboardDashboard((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads, [], now));
    await tracker.setDiscard(first.threads[0], true);
    await cacheFile(appDir, key, watch([row(undefined, { worker_status: 'idle', status: terminal === 'failed' ? 'failed' : 'active',
      status_bucket: terminal, last_event_at: new Date(now + 10).toISOString() })], now + 10), { mtimeMs: now + 10 });
    const ended = (await tracker.observe(buildSwitchboardDashboard((await loadClaudeRemoteThreads({ appDir, nowMs: now + 10 })).threads, [], now + 10))).threads[0];
    assert.equal(ended.discardResult, false);
    assert.equal(ended.nativeUnread, true);
    assert.equal(ended.pending, ['generic', 'failed'].includes(terminal));
    assert.equal(tracker.records[ended.id].discard, 0);
  }
  const appDir = await temp(t);
  const key = '1/0/https://claude.ai/v1/code/sessions/watch';
  await cacheFile(appDir, key, watch([row()]));
  const tracker = new PendingTracker(false);
  const first = await tracker.observe(buildSwitchboardDashboard((await loadClaudeRemoteThreads({ appDir, nowMs: now })).threads, [], now));
  await tracker.setDiscard(first.threads[0], true);
  await cacheFile(appDir, key, watch([row(undefined, { last_event_at: new Date(now + 10).toISOString() })], now + 10), { mtimeMs: now + 10 });
  const stillRunning = (await tracker.observe(buildSwitchboardDashboard((await loadClaudeRemoteThreads({ appDir, nowMs: now + 10 })).threads, [], now + 10))).threads[0];
  assert.equal(stillRunning.discardResult, true);
});
