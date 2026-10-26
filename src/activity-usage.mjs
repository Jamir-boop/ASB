// The token usage of this machine for the Usage board (activity contract 2.3 and 4). It reads the Codex rollouts, the
// Claude transcripts, and the OpenCode database of the enabled sources, read-only. The scan is lazy: the first call
// starts it in the background and gets the records found so far. A refresh reads only the new bytes of a grown file,
// and a private disk cache keeps the results across engine restarts. Only report() loads the LiteLLM prices (24-hour disk cache).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheDir as defaultCacheDir } from './platform-paths.mjs';
import { aggregateBuckets, aggregateHourly, periodBuckets, USAGE_PERIODS } from './usage-aggregation.mjs';
import { readOpenCodeUsage } from './usage-opencode.mjs';
import { createRateLoader } from './usage-rates.mjs';
import { createYielder, loadUsageCache, pathKey, pruneScanCache, QUARTER_HOUR_MS, saveUsageCache, scanFile } from './usage-scan-cache.mjs';

export { USAGE_PERIODS };
export const USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REFRESH_MS = 10_000;
// Live transcripts change in almost every scan; a missed save costs only a read of the new bytes after a restart.
export const SAVE_INTERVAL_MS = 5 * 60 * 1000;
// The newest hourly records of a member reply.
export const MAX_HOURLY_RECORDS = 50_000;
const TOKEN_TYPES = ['uncached', 'cacheRead', 'cacheWrite', 'output'];

// A member record comes from another machine: only plain names, an hour, and token counts are used.
const validMemberRecord = (record) => typeof record?.app === 'string' && typeof record.model === 'string'
  && Number.isFinite(record.hourMs) && TOKEN_TYPES.every((type) => Number.isFinite(record.tokens?.[type]) && record.tokens[type] >= 0);

// The transcript folders of the enabled sources: Codex rollouts and Claude projects (Claude Desktop Code and the CLI).
function usageRoots(sources, homeDir) {
  const roots = new Map();
  const databases = new Set();
  for (const source of sources) {
    if (!source?.enabled) continue;
    if (source.provider === 'codex') roots.set(path.resolve(source.dataDir, 'sessions'), 'codex');
    else if (source.provider === 'claude-desktop-code') roots.set(path.resolve(source.projectsDir || path.join(homeDir, '.claude', 'projects')), 'claude');
    else if (source.provider === 'opencode') databases.add(path.resolve(source.dataDir));
  }
  return { roots, databases };
}

async function listTranscripts(root, app, cutoffMs, files, pause) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await listTranscripts(file, app, cutoffMs, files, pause);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await fs.stat(file).catch(() => null);
      if (info && info.mtimeMs >= cutoffMs) files.push({ file, app, info });
    }
    await pause();
  }
}

export function createActivityUsage({ readSources = async () => [], machine = {}, cacheDir = defaultCacheDir(), now = Date.now,
  fetch = globalThis.fetch, homeDir = os.homedir(), platform = process.platform, refreshMs = REFRESH_MS,
  log = console.error } = {}) {
  const cacheFile = path.join(cacheDir, 'usage', 'usage-cache.json');
  const stats = { bytesRead: 0, scans: 0, saves: 0, openCodeQueries: 0 };
  const progress = { complete: false, files: 0, scannedFiles: 0 };
  let cache = null;
  let openCode = [];
  let openCodeReads = new Map();
  let dirty = false;
  let lastSavedAtMs = null;
  let running = null;
  let lastScanEndMs = null;
  const rates = createRateLoader({ file: path.join(cacheDir, 'usage', 'usage-model-rates.json'), fetch, now, platform });
  let version = 0;
  let parts = null;

  async function runScan() {
    const pause = createYielder();
    cache ??= await loadUsageCache(cacheFile, { platform });
    version += 1;
    const cutoffMs = now() - USAGE_RETENTION_MS;
    const { roots, databases } = usageRoots(await readSources(), homeDir);
    const files = [];
    for (const [root, app] of roots) await listTranscripts(root, app, cutoffMs, files, pause);
    // The first scan shows its progress; a refresh keeps the counts of the last full scan until it ends.
    if (!progress.complete) Object.assign(progress, { files: files.length, scannedFiles: 0 });
    const seen = new Set();
    let changed = false;
    for (const { file, app, info } of files) {
      const key = pathKey(file);
      seen.add(key);
      const previous = cache.get(key);
      try {
        const entry = await scanFile(file, info, previous, app, { stats, pause });
        if (entry !== previous) { cache.set(key, entry); changed = true; version += 1; }
      } catch { /* A file that went away or cannot be read keeps its old entry, if any. */ }
      if (!progress.complete) progress.scannedFiles += 1;
    }
    const found = [];
    const queried = new Map();
    for (const dataDir of databases) {
      // The query is synchronous SQLite work: it runs again only when the database or its WAL changed.
      const database = path.join(dataDir, 'opencode.db');
      const signature = (await Promise.all([database, `${database}-wal`].map((file) => fs.stat(file)
        .then((info) => `${info.size}:${info.mtimeMs}`, () => 'null')))).join('|');
      let last = openCodeReads.get(dataDir);
      if (last?.signature !== signature) {
        let records = [];
        try { records = await readOpenCodeUsage(dataDir, cutoffMs); } catch { /* No database or another schema: no usage. */ }
        stats.openCodeQueries += 1;
        last = { signature, records };
      }
      queried.set(dataDir, last);
      found.push(...last.records);
    }
    openCodeReads = queried;
    openCode = found;
    for (const key of cache.keys()) if (!seen.has(key)) { cache.delete(key); changed = true; }
    pruneScanCache(cache, cutoffMs);
    version += 1;
    Object.assign(progress, { complete: true, files: files.length, scannedFiles: files.length });
    stats.scans += 1;
    dirty ||= changed;
    if (lastSavedAtMs === null || (dirty && now() - lastSavedAtMs >= SAVE_INTERVAL_MS)) {
      lastSavedAtMs = now();
      dirty = false;
      try { await saveUsageCache(cacheFile, cache, { platform }); stats.saves += 1; } catch { log('ASB cannot save its usage cache. It keeps the old file.'); }
    }
  }

  // Starts a scan when none runs and the last one ended at least refreshMs ago. Returns the running scan, if any.
  function ensureScan(force = false) {
    if (!running && (force || lastScanEndMs === null || now() - lastScanEndMs >= refreshMs)) {
      running = runScan().catch(() => log('ASB cannot read the token usage.')).finally(() => {
        running = null;
        lastScanEndMs = now();
      });
    }
    return running;
  }

  // Every token part in a stable order (by file key), so the first copy of a Claude message is always the same one.
  function allParts() {
    if (parts?.version === version && parts.openCode === openCode) return parts.list;
    const list = [];
    for (const key of [...(cache?.keys() || [])].sort()) {
      const { app, records } = cache.get(key);
      for (const [quarter, model, uncached, cacheRead, cacheWrite, output, dedupeKey] of records) {
        list.push({ app, model, atMs: quarter * QUARTER_HOUR_MS, tokens: { uncached, cacheRead, cacheWrite, output }, key: dedupeKey });
      }
    }
    for (const record of openCode) list.push({ ...record, atMs: record.timestampMs, key: null });
    parts = { version, openCode, list };
    return list;
  }

  const self = () => {
    const value = typeof machine === 'function' ? machine() : machine;
    return { machineId: value?.machineId || '', name: value?.name ?? value?.machineName ?? '' };
  };
  const checkPeriod = (period) => {
    if (!Object.hasOwn(USAGE_PERIODS, period)) throw new RangeError('Invalid period.');
  };

  return {
    // Contract 2.3: this machine, then the group members (already sorted by name, each with its last hourly usage reply).
    // A member record goes into the local bucket whose start is the last one at or before its hour; earlier ones are dropped.
    report(period, members = []) {
      checkPeriod(period);
      ensureScan();
      const nowMs = now();
      const { unit, startsMs, endMs } = periodBuckets(period, nowMs);
      rates.ensure();
      const table = rates.table();
      const { machineId, name } = self();
      const withMachine = (id) => ({ app, model, bucket, tokens, cost }) => ({ machineId: id, app, model, bucket, tokens, cost });
      const records = aggregateBuckets(allParts(), { startsMs, endMs, rates: table }).map(withMachine(machineId));
      const scan = { ...progress };
      for (const member of members) {
        const usage = (Array.isArray(member.usage) ? member.usage : []).filter(validMemberRecord)
          .map(({ app, model, hourMs, tokens }) => ({ app, model, atMs: hourMs, tokens, key: null }));
        records.push(...aggregateBuckets(usage, { startsMs, endMs: Infinity, rates: table }).map(withMachine(member.machineId)));
        // A member that never answered has no scan and adds nothing.
        if (member.scan) {
          scan.complete &&= member.scan.complete === true;
          scan.files += Number(member.scan.files) || 0;
          scan.scannedFiles += Number(member.scan.scannedFiles) || 0;
        }
      }
      return {
        period, nowMs, buckets: { unit, startsMs },
        machines: [{ machineId, name, self: true, state: 'local', lastReportAtMs: 0 }, ...members.map((member) => ({
          machineId: member.machineId, name: member.name, self: false, state: member.state, lastReportAtMs: member.lastReportAtMs || 0 }))],
        records,
        prices: rates.pricing(),
        scan,
      };
    },
    // The usage part of contract 4: UTC hours, tokens only. It starts early enough to fill the first local bucket of any time zone.
    localHourly(period) {
      checkPeriod(period);
      ensureScan();
      const nowMs = now();
      const days = USAGE_PERIODS[period].unit === 'hour' ? 1 : USAGE_PERIODS[period].count;
      const sinceMs = Math.floor((nowMs - days * DAY_MS - HOUR_MS) / HOUR_MS) * HOUR_MS;
      return { usage: aggregateHourly(allParts(), sinceMs, nowMs + HOUR_MS).slice(-MAX_HOURLY_RECORDS), scan: { ...progress } };
    },
    // For tests and the engine: start a scan now (or join the running one) and wait for it.
    refresh: () => ensureScan(true),
    idle: () => running || Promise.resolve(),
    pricesIdle: () => rates.idle(),
    stats,
  };
}
