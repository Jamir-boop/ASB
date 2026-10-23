// Engine memory settings. A scan makes much garbage. V8 keeps the freed pages and glibc keeps the freed blocks, so the engine
// holds several times more memory than its live data needs. Three settings give most of it back:
// 1. a full GC of the "last resort" kind, which makes V8 release its free pages (createMemoryTrim);
// 2. a smaller V8 young generation (ENGINE_NODE_FLAGS, a Node argument: it has no effect at run time);
// 3. glibc settings that return freed blocks to the system (MALLOC_ENV, read by glibc at process start).
// The launcher scripts/asb, the detached start in scripts/asb-engine.mjs, and the Windows tray scripts/asb-tray.ps1 pass 2 and 3.
import v8 from 'node:v8';
import vm from 'node:vm';

export const ENGINE_NODE_FLAGS = ['--max-semi-space-size=16'];
export const MALLOC_ENV = { MALLOC_ARENA_MAX: '2', MALLOC_MMAP_THRESHOLD_: '131072', MALLOC_TRIM_THRESHOLD_: '131072' };
// A trim takes about 15 ms, and the next scan costs about 75 ms more CPU than usual, because the freed pages must be mapped again.
// So a trim must pay: it runs only when the memory is at least GROWTH_BYTES above the level after the last trim (or above the lowest
// level since then). It runs at the earliest SETTLE_MS after a scan end (the answers of the scan are garbage by then), and at most
// once in INTERVAL_MS. A trim after each scan (at most once in 5 s) took more CPU and saved little more memory.
export const TRIM_INTERVAL_MS = 30_000;
export const TRIM_SETTLE_MS = 3_000;
export const TRIM_GROWTH_BYTES = 128 * 1024 * 1024;

// The engine must not pass the glibc settings on: the message relay, the tray, and the apps that ASB opens have their own needs.
export function forgetMallocEnv(...targets) {
  for (const env of targets) for (const name of Object.keys(MALLOC_ENV)) delete env[name];
}

// The gc function without the --expose-gc argument; null when the engine cannot make it. Node.js 20 (V8 11) ignores the flavor, so a
// trim there is a plain full GC and frees no pages: V8 12 and later is needed.
function lastResortGc() {
  try {
    if (Number.parseInt(process.versions.v8, 10) < 12) return null;
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return () => gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
  } catch { return null; }
}

export function createMemoryTrim({ gc = lastResortGc(), rss = () => process.memoryUsage.rss(), intervalMs = TRIM_INTERVAL_MS,
  settleMs = TRIM_SETTLE_MS, growthBytes = TRIM_GROWTH_BYTES, now = () => performance.now(), setTimer = setTimeout } = {}) {
  let timer = null;
  let lastAt = -Infinity;
  // The memory after the last trim, or the lowest memory since then (V8 can also give memory back by itself). 0: no trim yet.
  let floor = 0;
  const run = () => {
    timer = null;
    // A failed trim is no engine error: the memory stays until the next GC.
    try {
      const used = rss();
      if (floor && used < floor) floor = used;
      if (floor && used - floor < growthBytes) return;
      lastAt = now();
      gc();
      floor = rss();
    } catch { /* Nothing to do. */ }
  };
  return {
    // One timer covers every scan end before it fires.
    scanEnded() {
      if (!gc || timer) return;
      timer = setTimer(run, Math.max(settleMs, lastAt + intervalMs - now()));
      timer.unref?.();
    },
  };
}
