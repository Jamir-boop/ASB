import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTrim, ENGINE_NODE_FLAGS, forgetMallocEnv, MALLOC_ENV, TRIM_GROWTH_BYTES, TRIM_INTERVAL_MS, TRIM_SETTLE_MS } from '../src/memory-trim.mjs';

const MB = 1024 * 1024;

// A clock and a timer list: the test moves the time, and a timer runs when the time reaches it. Platform-neutral (test/windows-tests.json).
function fakeTime() {
  const time = { at: 0, timers: [] };
  time.now = () => time.at;
  time.setTimer = (run, ms) => {
    const timer = { run, due: time.at + ms, unref() { timer.unrefed = true; } };
    time.timers.push(timer);
    return timer;
  };
  time.advance = (ms) => {
    const end = time.at + ms;
    for (;;) {
      const next = time.timers.filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      time.timers.splice(time.timers.indexOf(next), 1);
      time.at = next.due;
      next.run();
    }
    time.at = end;
  };
  return time;
}

// The memory is `used` bytes. By default it grows 100 MB each second, so every check finds enough growth; a trim sets it to `afterTrim`.
const trimmer = ({ growthPerSecond = 100 * MB, afterTrim = 100 * MB, ...options } = {}) => {
  const time = fakeTime();
  const calls = [];
  const memory = { base: 100 * MB, since: 0 };
  memory.rss = () => memory.base + growthPerSecond * ((time.at - memory.since) / 1000);
  const gc = () => { calls.push(time.at); memory.base = afterTrim; memory.since = time.at; };
  const trim = createMemoryTrim({ gc, rss: memory.rss, now: time.now, setTimer: time.setTimer, ...options });
  return { time, calls, trim, memory };
};

test('the engine settings are the measured ones', () => {
  assert.deepEqual(ENGINE_NODE_FLAGS, ['--max-semi-space-size=16']);
  assert.deepEqual(MALLOC_ENV, { MALLOC_ARENA_MAX: '2', MALLOC_MMAP_THRESHOLD_: '131072', MALLOC_TRIM_THRESHOLD_: '131072' });
  assert.deepEqual([TRIM_INTERVAL_MS, TRIM_SETTLE_MS, TRIM_GROWTH_BYTES], [30_000, 3_000, 128 * MB]);
});

test('no trim runs before the settle time, then one trim runs after a scan end', () => {
  const { time, calls, trim } = trimmer();
  time.advance(60_000);
  assert.deepEqual(calls, [], 'no scan, no trim');
  trim.scanEnded();
  time.advance(TRIM_SETTLE_MS - 1);
  assert.deepEqual(calls, []);
  time.advance(1);
  assert.deepEqual(calls, [60_000 + TRIM_SETTLE_MS]);
  time.advance(10 * TRIM_INTERVAL_MS);
  assert.equal(calls.length, 1, 'no scan end, no second trim');
});

test('scan ends before the timer fires share one trim, and the timer never keeps the process', () => {
  const { time, calls, trim } = trimmer();
  trim.scanEnded();
  trim.scanEnded();
  time.advance(100);
  trim.scanEnded();
  assert.equal(time.timers.length, 1);
  assert.equal(time.timers[0].unrefed, true);
  time.advance(TRIM_SETTLE_MS);
  assert.equal(calls.length, 1);
});

test('a burst of scans gets at most one trim in each interval, and the last scan end gets a trim', () => {
  const { time, calls, trim } = trimmer({ intervalMs: 5000, settleMs: 1000 });
  // A scan end each 100 ms for 12 s.
  for (let step = 0; step < 120; step += 1) {
    trim.scanEnded();
    time.advance(100);
  }
  assert.deepEqual(calls, [1000, 6000, 11_000]);
  // The last scan end was at 11 900 ms, after the trim at 11 000 ms: the next trim comes at the end of the interval.
  time.advance(10_000);
  assert.deepEqual(calls, [1000, 6000, 11_000, 16_000]);
  // A scan end after a long wait needs only the settle time.
  time.advance(60_000);
  const before = calls.length;
  trim.scanEnded();
  time.advance(999);
  assert.equal(calls.length, before);
  time.advance(1);
  assert.equal(calls.length, before + 1);
});

test('a scan end right after a trim waits for the rest of the interval', () => {
  const { time, calls, trim } = trimmer({ intervalMs: 5000, settleMs: 1000 });
  trim.scanEnded();
  time.advance(1000);
  assert.deepEqual(calls, [1000]);
  time.advance(200);
  trim.scanEnded();
  time.advance(4799);
  assert.deepEqual(calls, [1000]);
  time.advance(1);
  assert.deepEqual(calls, [1000, 6000]);
});

// A trim costs CPU, so it runs only when the memory is growthBytes above the level after the last trim (or the lowest level since).
test('a trim runs only when the memory grew enough above the level after the last trim', () => {
  const { time, calls, trim, memory } = trimmer({ growthPerSecond: 0, afterTrim: 100 * MB, intervalMs: 1000, settleMs: 100, growthBytes: 64 * MB });
  const scan = () => { trim.scanEnded(); time.advance(2000); };
  // The first check has no level yet: it trims, also when the memory is small.
  memory.base = 10 * MB;
  scan();
  assert.equal(calls.length, 1);
  assert.equal(memory.rss(), 100 * MB);
  // 50 MB above the level: no trim. 70 MB above: a trim.
  memory.base = 150 * MB;
  scan();
  assert.equal(calls.length, 1);
  memory.base = 170 * MB;
  scan();
  assert.equal(calls.length, 2);
  // V8 gave memory back by itself (80 MB): the level goes down to it, so 140 MB (60 MB above) is no trim and 150 MB (70 MB above) is.
  memory.base = 80 * MB;
  scan();
  memory.base = 140 * MB;
  scan();
  assert.equal(calls.length, 2);
  memory.base = 150 * MB;
  scan();
  assert.equal(calls.length, 3);
});

test('without a gc function no timer starts and nothing throws', () => {
  const { time, calls, trim } = trimmer({ gc: null });
  trim.scanEnded();
  trim.scanEnded();
  assert.equal(time.timers.length, 0);
  time.advance(60_000);
  assert.deepEqual(calls, []);
});

test('a gc function or a memory reader that throws does not throw out of the timer, and the next scan end plans a new trim', () => {
  let attempts = 0;
  const time = fakeTime();
  const trim = createMemoryTrim({ gc: () => { attempts += 1; throw new Error('Synthetic gc failure'); }, rss: () => 500 * MB, now: time.now, setTimer: time.setTimer });
  trim.scanEnded();
  assert.doesNotThrow(() => time.advance(TRIM_SETTLE_MS));
  assert.equal(attempts, 1);
  trim.scanEnded();
  assert.equal(time.timers.length, 1);
  assert.doesNotThrow(() => time.advance(TRIM_INTERVAL_MS));
  assert.equal(attempts, 2);
  const unreadable = fakeTime();
  const calls = [];
  const second = createMemoryTrim({ gc: () => calls.push('gc'), rss: () => { throw new Error('Synthetic read failure'); }, now: unreadable.now, setTimer: unreadable.setTimer });
  second.scanEnded();
  assert.doesNotThrow(() => unreadable.advance(TRIM_SETTLE_MS));
  assert.deepEqual(calls, []);
  second.scanEnded();
  assert.equal(unreadable.timers.length, 1);
});

// V8 12 (Node.js 22 and later) knows the last-resort flavor. Node.js 20 gets no trim, because its trim would free no page.
test('the default gc function exists on V8 12 and later, runs without error, and does not put gc on the global object', () => {
  const time = fakeTime();
  const trim = createMemoryTrim({ rss: () => 500 * MB, now: time.now, setTimer: time.setTimer });
  trim.scanEnded();
  assert.equal(time.timers.length, Number.parseInt(process.versions.v8, 10) >= 12 ? 1 : 0);
  assert.doesNotThrow(() => time.advance(TRIM_SETTLE_MS));
  assert.equal(typeof globalThis.gc, 'undefined');
});

test('forgetMallocEnv removes the glibc settings from each environment object and keeps the others', () => {
  const first = { ...MALLOC_ENV, PATH: '/usr/bin', MALLOC_CHECK_: '3' };
  const second = { ...MALLOC_ENV, HOME: '/home/synthetic' };
  const third = { HOME: '/home/synthetic' };
  forgetMallocEnv(first, second, third);
  assert.deepEqual(first, { PATH: '/usr/bin', MALLOC_CHECK_: '3' });
  assert.deepEqual(second, { HOME: '/home/synthetic' });
  assert.deepEqual(third, { HOME: '/home/synthetic' });
  // The same object twice is no error (the engine passes process.env and its env, which are one object).
  forgetMallocEnv(first, first);
});
