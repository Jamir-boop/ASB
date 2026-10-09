import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsPromises, { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { DashboardSnapshot } from '../src/dashboard-snapshot.mjs';

// The snapshot imports stat and readdir by name: the counters replace the built-in exports for this test process.
const calls = { stat: 0, readdir: 0 };
let countedRoot = '\0';
for (const name of ['stat', 'readdir']) {
  const original = fsPromises[name];
  fsPromises[name] = (target, ...args) => {
    if (String(target).startsWith(countedRoot)) calls[name] += 1;
    return original(target, ...args);
  };
}
syncBuiltinESMExports();

async function until(predicate) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail('Expected asynchronous work to finish.');
}

async function fixture(t, { watchPaths, realWatch = false, acceptEvent } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-watchers-'));
  const root = path.join(dir, 'sessions');
  await mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await mkdir(path.join(root, 'c'));
  const paths = watchPaths ? watchPaths(dir, root) : [{ path: root, source: 'codex', recursive: true, acceptEvent }];
  const watches = [];
  const timers = [];
  let clock = Date.parse('2026-10-09T10:00:00Z');
  let loads = 0;
  const openAtLoad = [];
  const open = () => watches.filter((item) => !item.watcher.closed).map((item) => item.target).sort();
  const snapshot = new DashboardSnapshot({
    dashboardWatchPaths: () => paths, dashboardPlatform: 'linux', now: () => clock,
    dashboardSetTimeout(callback, milliseconds) { const timer = { callback, milliseconds, unref() {} }; timers.push(timer); return timer; },
    dashboardClearTimeout() {},
    loadDashboard: async () => { loads += 1; openAtLoad.push(open()); return { threads: [] }; },
    ...(realWatch ? {} : { watchDashboardPath(target, options, callback) {
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; };
      watches.push({ target, options, callback, watcher });
      return watcher;
    } }),
  });
  const server = new EventEmitter();
  server.close = () => {};
  snapshot.attach(server);
  t.after(async () => { server.close(); countedRoot = '\0'; await rm(dir, { recursive: true, force: true }); });
  server.emit('listening');
  const retryTimer = () => timers.findLast((timer) => timer.milliseconds === 5_000);
  await until(retryTimer);
  countedRoot = dir;
  calls.stat = 0;
  calls.readdir = 0;
  const performanceNow = () => snapshot.performanceSnapshot().dashboard;
  return { dir, root, paths, watches, snapshot, performanceNow, open, openAtLoad, loads: () => loads,
    advance(milliseconds) { clock += milliseconds; },
    // Runs the 5 s retry timer once, at its due time.
    async tick() { clock += 5_000; await retryTimer().callback(); },
    emit(target, event, filename) { watches.findLast((item) => item.target === target && !item.watcher.closed).callback(event, filename); },
    async dirtyLoad() { assert.equal(performanceNow().dirty, true); await snapshot.loadSharedDashboard(); },
  };
}

test('steady state: dirty loads, change events, and retry ticks cause no stat, readdir, or walk', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.open(), [f.root, path.join(f.root, 'a'), path.join(f.root, 'a', 'b'), path.join(f.root, 'c')]);
  assert.ok(f.watches.every((item) => item.options.recursive === false));
  assert.deepEqual([f.performanceNow().watchWalks, f.performanceNow().watchCoverage], [1, true]);
  for (let round = 0; round < 5; round += 1) {
    f.emit(path.join(f.root, 'a', 'b'), 'change', 'rollout-a.jsonl');
    await f.dirtyLoad();
    await f.tick();
  }
  assert.equal(f.loads(), 5);
  assert.deepEqual(calls, { stat: 0, readdir: 0 });
  assert.equal(f.performanceNow().watchWalks, 1);
  assert.equal(f.watches.length, 4);
});

test('a rename event for a new directory attaches it and its nested directory without a full walk', async (t) => {
  // The filter drops every event: structure work must not depend on it.
  const f = await fixture(t, { acceptEvent: () => false });
  await mkdir(path.join(f.root, 'new', 'nested'), { recursive: true });
  f.emit(f.root, 'rename', 'new');
  assert.equal(f.performanceNow().dirty, false);
  await f.tick();
  assert.deepEqual(f.open(), [f.root, path.join(f.root, 'a'), path.join(f.root, 'a', 'b'), path.join(f.root, 'c'),
    path.join(f.root, 'new'), path.join(f.root, 'new', 'nested')]);
  assert.equal(f.performanceNow().watchWalks, 1);
  // One stat for the event entry, then one stat and one readdir for each new directory.
  assert.deepEqual(calls, { stat: 3, readdir: 2 });
  await mkdir(path.join(f.root, 'new', 'nested', 'deep'));
  f.emit(path.join(f.root, 'new', 'nested'), 'rename', 'deep');
  await f.tick();
  assert.ok(f.open().includes(path.join(f.root, 'new', 'nested', 'deep')));
  assert.equal(f.performanceNow().watchWalks, 1);
});

test('the scan that follows a directory creation event has the new watcher before it loads', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'new'));
  f.emit(f.root, 'rename', 'new');
  await f.dirtyLoad();
  assert.equal(f.openAtLoad.length, 1);
  assert.ok(f.openAtLoad[0].includes(path.join(f.root, 'new')));
  assert.equal(f.performanceNow().watchWalks, 1);
});

test('a rename event for a removed directory closes its watcher and those of its descendants', async (t) => {
  const f = await fixture(t);
  const removed = f.watches.filter((item) => item.target.startsWith(path.join(f.root, 'a')));
  assert.equal(removed.length, 2);
  await rm(path.join(f.root, 'a'), { recursive: true });
  f.emit(f.root, 'rename', 'a');
  await f.dirtyLoad();
  assert.ok(removed.every((item) => item.watcher.closed));
  assert.deepEqual(f.open(), [f.root, path.join(f.root, 'c')]);
  assert.deepEqual(calls, { stat: 1, readdir: 0 });
  assert.equal(f.performanceNow().watchWalks, 1);
});

test('rename events for plain and vanished files cost one stat each and attach nothing', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'c', 'rollout-new.jsonl'), '{}\n');
  f.emit(path.join(f.root, 'c'), 'rename', 'rollout-new.jsonl');
  await f.dirtyLoad();
  assert.deepEqual(calls, { stat: 1, readdir: 0 });
  // An atomic save: the temporary name is gone and the final name is a file.
  f.emit(path.join(f.root, 'c'), 'rename', 'rollout-new.jsonl.tmp');
  f.emit(path.join(f.root, 'c'), 'rename', 'rollout-new.jsonl');
  await f.dirtyLoad();
  assert.deepEqual(calls, { stat: 3, readdir: 0 });
  assert.equal(f.watches.length, 4);
  assert.ok(f.watches.every((item) => !item.watcher.closed));
  assert.equal(f.performanceNow().watchWalks, 1);
});

test('a large structure burst falls back to one full walk', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'burst'));
  for (let index = 0; index < 500; index += 1) f.emit(f.root, 'rename', index ? `file-${index}.tmp` : 'burst');
  await f.dirtyLoad();
  assert.equal(f.performanceNow().watchWalks, 2);
  assert.ok(f.open().includes(path.join(f.root, 'burst')));
  // The walk costs one stat and one readdir for each of the five directories, and nothing for the 500 entries.
  assert.deepEqual(calls, { stat: 5, readdir: 5 });
});

test('the safety-net walk runs after 60 s and not before, on the retry timer and before a dirty load', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'silent'));
  for (let count = 0; count < 11; count += 1) await f.tick();
  assert.equal(f.performanceNow().watchWalks, 1);
  assert.deepEqual(calls, { stat: 0, readdir: 0 });
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 2);
  assert.ok(f.open().includes(path.join(f.root, 'silent')));
  f.advance(59_999);
  f.emit(f.root, 'change', 'rollout-a.jsonl');
  await f.dirtyLoad();
  assert.equal(f.performanceNow().watchWalks, 2);
  f.advance(1);
  f.emit(f.root, 'change', 'rollout-a.jsonl');
  await f.dirtyLoad();
  assert.equal(f.performanceNow().watchWalks, 3);
});

test('the 5 s retry walks while coverage is incomplete and stops when it is complete', async (t) => {
  const f = await fixture(t, { watchPaths: (dir, root) => [{ path: root, source: 'codex', recursive: true },
    { path: path.join(dir, 'late'), source: 'claude', recursive: true }] });
  assert.equal(f.performanceNow().watchCoverage, false);
  await f.tick();
  await f.tick();
  assert.deepEqual([f.performanceNow().watchWalks, f.performanceNow().watchCoverage], [3, false]);
  await mkdir(path.join(f.dir, 'late'));
  await f.tick();
  assert.deepEqual([f.performanceNow().watchWalks, f.performanceNow().watchCoverage], [4, true]);
  calls.stat = 0;
  calls.readdir = 0;
  for (let count = 0; count < 5; count += 1) await f.tick();
  assert.equal(f.performanceNow().watchWalks, 4);
  assert.deepEqual(calls, { stat: 0, readdir: 0 });
});

test('a watcher error and a watch root that reports its own name each cause one full walk', async (t) => {
  const f = await fixture(t);
  const failed = f.watches.find((item) => item.target === path.join(f.root, 'c'));
  failed.watcher.emit('error', new Error('Watch failed'));
  assert.equal(f.performanceNow().watchCoverage, false);
  await f.tick();
  assert.deepEqual([f.performanceNow().watchWalks, f.performanceNow().watchCoverage], [2, true]);
  assert.equal(f.open().length, 4);
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 2);
  f.emit(f.root, 'rename', path.basename(f.root));
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 3);
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 3);
});

test('a changed watch path list and a restored optional path each trigger a walk', async (t) => {
  const f = await fixture(t, { watchPaths: (dir, root) => [{ path: root, source: 'codex', recursive: true },
    { path: path.join(dir, 'cache'), source: 'claude', optional: true }] });
  assert.deepEqual([f.performanceNow().watchWalks, f.performanceNow().watchCoverage], [1, true]);
  await f.tick();
  // A missing optional path costs one stat for each reconcile until it exists.
  assert.deepEqual(calls, { stat: 1, readdir: 0 });
  assert.equal(f.performanceNow().watchWalks, 1);
  await mkdir(path.join(f.dir, 'cache'));
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 2);
  assert.ok(f.open().includes(path.join(f.dir, 'cache')));
  calls.stat = 0;
  await f.tick();
  assert.deepEqual([f.performanceNow().watchWalks, calls.stat], [2, 0]);
  await mkdir(path.join(f.dir, 'extra'));
  f.paths.push({ path: path.join(f.dir, 'extra'), source: 'claude' });
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 3);
  assert.ok(f.open().includes(path.join(f.dir, 'extra')));
  f.paths.pop();
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 4);
  assert.ok(!f.open().includes(path.join(f.dir, 'extra')));
  await f.tick();
  assert.equal(f.performanceNow().watchWalks, 4);
});

test('real linux watches follow a new directory, a file written into it at once, and a replaced root', { skip: process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t, { realWatch: true });
  const dirty = () => f.performanceNow().dirty;
  const created = path.join(f.root, '2026');
  await mkdir(created);
  await writeFile(path.join(created, 'rollout-early.jsonl'), '{}\n');
  await until(dirty);
  await f.snapshot.loadSharedDashboard();
  assert.equal(f.performanceNow().watchWalks, 1);
  await until(async () => { if (dirty()) await f.snapshot.loadSharedDashboard(); return !dirty(); });
  await writeFile(path.join(created, 'rollout-late.jsonl'), '{}\n');
  await until(dirty);
  await rm(created, { recursive: true });
  await until(async () => { if (dirty()) await f.snapshot.loadSharedDashboard(); return !dirty(); });
  assert.equal(f.performanceNow().watchWalks, 1);
  await rename(f.root, `${f.root}-old`);
  await mkdir(f.root);
  await until(dirty);
  await until(async () => { if (dirty()) await f.snapshot.loadSharedDashboard(); return !dirty(); });
  assert.equal(f.performanceNow().watchWalks, 2);
  await writeFile(path.join(f.root, 'rollout-new-root.jsonl'), '{}\n');
  await until(dirty);
});
