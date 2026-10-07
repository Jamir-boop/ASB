import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSwitchboardDashboard, createSwitchboardServer, switchboardWatchPaths } from '../src/switchboard.mjs';

const epoch = Date.parse('2026-10-07T14:00:00Z');
const settle = () => new Promise(setImmediate);
async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('Expected asynchronous work to finish.');
}
function fakeClock() {
  let value = epoch;
  const timers = new Set();
  return {
    now: () => value,
    setTimeout(callback, delay) {
      const timer = { callback, at: value + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    timers,
    async advance(milliseconds) {
      const target = value + milliseconds;
      for (;;) {
        const timer = [...timers].filter((item) => item.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        timers.delete(timer);
        value = timer.at;
        await timer.callback();
        await settle();
      }
      value = target;
      await settle();
    },
  };
}
async function fixture(t, { load, watchPaths, watchImpl } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-refresh-'));
  const clock = fakeClock();
  const paths = watchPaths || switchboardWatchPaths({ homeDir: dir, appDir: path.join(dir, 'app') });
  for (const spec of paths) await mkdir(spec.path, { recursive: true });
  const watches = [];
  const hints = [];
  let loads = 0;
  const server = createSwitchboardServer({ now: clock.now, pendingStatePath: false,
    dashboardWatchPaths: paths,
    dashboardSetTimeout: clock.setTimeout, dashboardClearTimeout: clock.clearTimeout,
    dashboardSourceChanged: (source, hint) => hints.push({ source, ...hint }),
    watchDashboardPath(target, options, callback) {
      if (watchImpl) watchImpl(target, options);
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; };
      watches.push({ target, options, callback, watcher });
      return watcher;
    },
    loadDashboard: async () => {
      loads += 1;
      return load ? load(loads, clock) : { generatedAtMs: clock.now(), providers: [], threads: [{ id: 'one', state: 'working', nativeUnread: null }] };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await until(() => clock.timers.size);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, paths, clock, watches, hints, server, base, loads: () => loads,
    scan: () => fetch(`${base}/api/dashboard`).then((response) => response.json()),
    change: (filename = 'state_9.sqlite-wal', source = 'codex', event = 'change') => {
      const spec = paths.find((item) => item.source === source);
      watches.findLast((item) => item.target === spec.path && !item.watcher.closed).callback(event, filename);
    },
  };
}
async function events(t, fixture) {
  let text = '';
  const request = http.get(`${fixture.base}/api/events`, (response) => response.on('data', (chunk) => { text += chunk; }));
  request.on('error', () => {});
  t.after(() => request.destroy());
  await until(() => text.includes('event: connected'));
  return { text: () => text, request };
}

test('adaptive clock uses every unarchived root and expires Working without file events', async (t) => {
  const rows = [
    { id: 'pending', provider: 'codex', lifecycleRunning: false, nativeUnread: true },
    { id: 'waiting', provider: 'codex', awaitingPermission: true },
    { id: 'archive', provider: 'codex', archived: true, lifecycleRunning: true, agentActivityAtMs: epoch },
    { id: 'child', provider: 'codex', isSubagent: true, lifecycleRunning: true, agentActivityAtMs: epoch },
  ];
  assert.equal(buildSwitchboardDashboard(rows, [], epoch).refreshIntervalMs, 5_000);
  rows.push({ id: 'hidden-by-filter', provider: 'codex', lifecycleRunning: true, agentActivityAtMs: epoch - 6 * 3_600_000 + 1_000 });
  const board = buildSwitchboardDashboard(rows, [], epoch);
  assert.equal(board.refreshIntervalMs, 2_000);
  assert.equal(JSON.stringify(board).includes('nextStatusCheckAtMs'), false);
  const f = await fixture(t, { load: (_loads, clock) => buildSwitchboardDashboard(rows, [], clock.now()) });
  await f.scan();
  await f.clock.advance(1_001);
  assert.equal((await f.scan()).refreshIntervalMs, 5_000);
  assert.equal(f.loads(), 2);
});

test('healthy watchers reuse clean active scans and reconcile missed events at five seconds', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.scan()).performance.dashboard.watchCoverage, true);
  await f.clock.advance(2_000);
  await f.scan();
  await f.clock.advance(2_999);
  await f.scan();
  assert.equal(f.loads(), 1);
  await f.clock.advance(1);
  await f.scan();
  assert.equal(f.loads(), 2);
});

test('source bursts coalesce, cap busy scans, and emit only metadata', async (t) => {
  const f = await fixture(t);
  await f.scan();
  const stream = await events(t, f);
  f.change('auth.json');
  f.change('notifications.json');
  f.change('pending.json');
  f.change('state_9.sqlite-shm');
  await f.clock.advance(250);
  assert.equal(stream.text().includes('event: dashboard'), false);
  for (let count = 0; count < 151; count += 1) f.change();
  await f.clock.advance(1_749);
  await f.scan();
  assert.equal(f.loads(), 1);
  await f.clock.advance(1);
  await until(() => f.loads() === 2);
  await until(() => stream.text().includes('event: dashboard'));
  const payload = JSON.parse(stream.text().match(/event: dashboard\ndata: (.+)\n/)[1]);
  assert.deepEqual(Object.keys(payload).sort(), ['reason', 'sources', 'version']);
  assert.deepEqual(payload.sources, { codex: true, claude: false });
  assert.equal(stream.text().includes(f.dir), false);
  assert.equal(stream.text().includes('state_9'), false);
  assert.equal(f.hints.length, 1);
  assert.equal((await f.scan()).performance.dashboard.dirty, false);
});

test('idle source changes wake after debounce and preserve one follow-up during a scan', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { load: async (loads, clock) => {
    if (loads === 2) { started.resolve(); await release.promise; }
    return { generatedAtMs: clock.now(), providers: [], threads: [
      { id: 'one', state: 'idle', nativeUnread: null },
      ...(loads > 1 ? [{ id: 'new-session', state: loads === 2 ? 'working' : 'idle', nativeUnread: null }] : []),
    ] };
  } });
  assert.equal((await f.scan()).refreshIntervalMs, 5_000);
  await events(t, f);
  f.change('session_index.jsonl');
  await f.clock.advance(249);
  assert.equal(f.loads(), 1);
  await f.clock.advance(1);
  await started.promise;
  for (let count = 0; count < 50; count += 1) f.change('.codex-global-state.json');
  await f.clock.advance(250);
  assert.equal(f.loads(), 2);
  release.resolve();
  await until(() => f.clock.timers.size === 2);
  const current = await f.scan();
  assert.equal(current.performance.dashboard.dirty, true);
  assert.equal(current.refreshIntervalMs, 2_000);
  assert.equal(current.threads.find((row) => row.id === 'new-session').state, 'working');
  await f.clock.advance(1_750);
  await until(() => f.loads() === 3);
  assert.equal((await f.scan()).performance.dashboard.dirty, false);
  assert.equal(f.hints.length, 2);
  await f.clock.advance(250);
  assert.equal(f.loads(), 3);
});

test('watch failures use active fallback, retry missing stores, and follow atomic directory replacement', async (t) => {
  let fail = true;
  const f = await fixture(t, { watchImpl() { if (fail) throw new Error('Watch unavailable'); } });
  assert.equal((await f.scan()).performance.dashboard.watchCoverage, false);
  await f.clock.advance(1_999);
  await f.scan();
  assert.equal(f.loads(), 1);
  await f.clock.advance(1);
  await f.scan();
  assert.equal(f.loads(), 2);
  fail = false;
  await f.clock.advance(3_000);
  await until(() => f.watches.length === 4);
  const old = f.watches[0];
  await rename(old.target, `${old.target}-old`);
  await mkdir(old.target);
  for (const spec of f.paths) if (spec.path.startsWith(`${old.target}${path.sep}`)) await mkdir(spec.path, { recursive: true });
  await f.clock.advance(5_000);
  assert.equal(old.watcher.closed, true);
  assert.ok(f.watches.length > 4);
  const claudePath = f.paths.find((item) => item.source === 'claude').path;
  await rm(claudePath, { recursive: true });
  await f.clock.advance(5_000);
  assert.equal((await f.scan()).performance.dashboard.watchCoverage, false);
  await mkdir(claudePath);
  await f.clock.advance(5_000);
  assert.equal((await f.scan()).performance.dashboard.watchCoverage, true);
});

test('unsupported recursive watch covers new child directories and closes every owned resource', async (t) => {
  const f = await fixture(t, { watchImpl(_target, options) {
    if (options.recursive) throw Object.assign(new Error('Unsupported recursive watch'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  } });
  await f.scan();
  await events(t, f);
  const recursive = f.paths.find((item) => item.recursive);
  const childPath = path.join(recursive.path, '2026', '10');
  await mkdir(childPath, { recursive: true });
  f.watches.find((item) => item.target === recursive.path).callback('rename', '2026');
  await f.clock.advance(2_000);
  await until(() => f.watches.some((item) => item.target === childPath));
  await new Promise((resolve) => f.server.close(resolve));
  assert.ok(f.watches.every((item) => item.watcher.closed));
  assert.equal(f.clock.timers.size, 0);
});

test('watcher errors and failed scans retry without a tight loop', async (t) => {
  let fail = false;
  const f = await fixture(t, { load: (_loads, clock) => {
    if (fail) throw new Error('Local source unavailable');
    return { generatedAtMs: clock.now(), providers: [], threads: [{ id: 'one', state: 'idle', nativeUnread: null }] };
  } });
  await f.scan();
  await events(t, f);
  const old = f.watches[0];
  old.watcher.emit('error', new Error('Watch failed'));
  assert.equal(old.watcher.closed, true);
  fail = true;
  await f.clock.advance(250);
  await until(() => f.loads() === 2);
  await settle();
  for (let count = 0; count < 100; count += 1) f.change();
  await f.clock.advance(4_999);
  await f.scan();
  assert.equal(f.loads(), 2);
  fail = false;
  await f.clock.advance(1);
  await until(() => f.loads() === 3);
  assert.equal((await f.scan()).performance.dashboard.dirty, false);
});

test('ASB event streams enforce Host, Origin, method, and no CORS permissions', async (t) => {
  const f = await fixture(t);
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: f.base, 'Sec-Fetch-Site': 'cross-site' },
    { Origin: f.base.replace('http:', 'https:') }]) {
    const response = await fetch(`${f.base}/api/events`, { headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(await new Promise((resolve) => http.get(`${f.base}/api/events`, {
    headers: { Host: `attacker.test:${f.server.address().port}` },
  }, (response) => { response.resume(); resolve(response.statusCode); })), 403);
  assert.equal((await fetch(`${f.base}/api/events`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${f.base}/api/events`, { method: 'OPTIONS', headers: { Origin: f.base } })).status, 405);
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events`, { signal: controller.signal, headers: { Origin: f.base } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  controller.abort();
});
