// The token usage of this machine for the Usage board (activity contract 2.3 and 4). It reads the Codex rollouts, the
// Claude transcripts, and the OpenCode database of the enabled sources, read-only. The scan is lazy: the first call
// starts it in the background and gets the records found so far. A refresh reads only the new bytes of a grown file,
// and a private disk cache keeps the results across engine restarts. Only report() loads the LiteLLM prices (24-hour disk cache).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { cacheDir as defaultCacheDir } from './platform-paths.mjs';
import { aggregateBuckets, aggregateHourly, periodBuckets, USAGE_PERIODS } from './usage-aggregation.mjs';
import { antigravityRoots, expandHome, readAntigravityUsage } from './usage-antigravity.mjs';
import { modelMaker } from './usage-pricing.mjs';
import { openCodeDatabases, readOpenCodeUsage } from './usage-opencode.mjs';
import { createRateLoader } from './usage-rates.mjs';
import { suggestName, validName } from './machine-group.mjs';
import { encodeLedger, exportDocument, loadLedger, MACHINE_ID, mergeRecord, mergeRecords, readExport, recordKey, validRecord } from './usage-ledger.mjs';
import { createYielder, loadUsageCache, MAX_CACHE_FILES, pathKey, QUARTER_HOUR_MS, saveUsageCache, scanFile, SCAN_REST_RATIO, writePrivateJson } from './usage-scan-cache.mjs';

export { USAGE_PERIODS };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REFRESH_MS = 10_000;
// Live transcripts change in almost every scan; a missed save costs only a read of the new bytes after a restart.
export const SAVE_INTERVAL_MS = 5 * 60 * 1000;
// The newest hourly records of a member reply.
export const MAX_HOURLY_RECORDS = 50_000;
const TOKEN_TYPES = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
// The ledger: the first background scan, the next ones, and the idle time after the last usage request that frees the scan cache.
export const LEDGER_FIRST_MS = 10 * 60 * 1000;
export const LEDGER_REFRESH_MS = 60 * 60 * 1000;
export const RELEASE_AFTER_MS = 2 * 60 * 1000;
// No coding agent has usage before 2020: an earlier time is a bad value, and it must not make thousands of month bars.
const FIRST_USAGE_MS = Date.UTC(2020, 0, 1);

// A member record comes from another machine: only plain names, an hour, and token counts are used.
const validMemberRecord = (record) => typeof record?.app === 'string' && typeof record.model === 'string'
  && Number.isFinite(record.hourMs) && TOKEN_TYPES.every((type) => Number.isFinite(record.tokens?.[type]) && record.tokens[type] >= 0);

// The first source of each resolved transcript root owns that root.
function usageRoots(sources, homeDir, env) {
  const roots = new Map();
  const databases = new Set();
  const add = (root, app, fileName) => {
    root = path.resolve(root);
    if (!roots.has(root)) roots.set(root, { root, app, fileName });
  };
  for (const source of sources) {
    if (!source?.enabled) continue;
    if (source.provider === 'codex') {
      add(path.join(source.dataDir, 'sessions'), 'codex');
      add(path.join(source.dataDir, 'archived_sessions'), 'codex');
    } else if (source.provider === 'claude-desktop-code') add(source.projectsDir || path.join(homeDir, '.claude', 'projects'), 'claude');
    else if (source.provider === 'opencode') databases.add(path.resolve(source.dataDir));
  }
  add(path.resolve(expandHome(env.GROK_HOME?.trim() || path.join(homeDir, '.grok'), homeDir), 'sessions'), 'grok', 'updates.jsonl');
  const piSessions = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  add(piSessions ? expandHome(piSessions, homeDir)
    : path.resolve(expandHome(env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDir, '.pi', 'agent'), homeDir), 'sessions'), 'pi');
  return { roots: [...roots.values()], databases };
}

async function listTranscripts(root, app, files, pause, fileName) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await listTranscripts(file, app, files, pause, fileName);
    // shortcut: Node.js before 22.15 has no zstd, so compressed Codex rollouts are not read; upgrade Node.js to read them.
    else if (entry.isFile() && (fileName ? entry.name === fileName : entry.name.endsWith('.jsonl')
      || (typeof zlib.createZstdDecompress === 'function' && entry.name.endsWith('.jsonl.zst') && !names.has(entry.name.slice(0, -4))))) {
      const info = await fs.stat(file).catch(() => null);
      if (info) files.push({ file, app, info });
    }
    await pause();
  }
}

export function createActivityUsage({ readSources = async () => [], machine = {}, cacheDir = defaultCacheDir(), now = Date.now,
  fetch = globalThis.fetch, homeDir = os.homedir(), env = process.env, platform = process.platform, refreshMs = REFRESH_MS,
  log = console.error, maxCacheFiles = MAX_CACHE_FILES, ledgerFile = '', members = null, busy = () => false, timers = { setTimeout, clearTimeout } } = {}) {
  const cacheFile = path.join(cacheDir, 'usage', 'usage-cache.json');
  const stats = { bytesRead: 0, scans: 0, saves: 0, openCodeQueries: 0, openCodePages: 0, partBuilds: 0, parts: 0, ledgerSaves: 0, releases: 0, memberBuilds: 0 };
  const progress = { complete: false, files: 0, scannedFiles: 0 };
  let cache = null;
  let openCode = [];
  let antigravity = [];
  const antigravityCache = new Map();
  let openCodeReads = new Map();
  let dirty = false;
  let lastSavedAtMs = null;
  let running = null;
  let lastScanEndMs = null;
  const rates = createRateLoader({ file: path.join(cacheDir, 'usage', 'usage-model-rates.json'), fetch, now, platform });
  let version = 0;
  let parts = null;
  // The ledger state; ledgerVersion changes with each change of the ledger records.
  let ledger = null;
  let ledgerLoad = null;
  let ledgerBlocked = false;
  let ledgerDirty = false;
  let ledgerSavedAtMs = null;
  let ledgerWrite = Promise.resolve();
  let ledgerVersion = 0;
  let derived = null;
  let lastAskMs = null;
  let timer = null;
  let releaseTimer = null;
  let started = false;
  let stopped = false;
  let ticking = null;
  let waitingSinceMs = null;
  // The member reply arrays already in the ledger: the group returns the same array until a new reply comes.
  const keptReplies = new WeakSet();
  const memberReplies = new WeakMap();

  async function runScan() {
    // The scan runs in the background (nobody waits for it), so it rests between its steps and leaves the CPU to other apps.
    const pause = createYielder(Date.now, { restRatio: SCAN_REST_RATIO });
    if (!cache) {
      cache = await loadUsageCache(cacheFile, { platform });
      version += 1;
    }
    if (ledgerFile) await ensureLedger();
    const { roots, databases } = usageRoots(await readSources(), homeDir, env);
    let files = [];
    for (const { root, app, fileName } of roots) await listTranscripts(root, app, files, pause, fileName);
    // Archiving can move a rollout between the two root listings; the archived path owns that file name.
    const codexFiles = new Map();
    for (const entry of files) {
      if (entry.app !== 'codex') continue;
      const name = path.basename(entry.file).replace(/\.zst$/, '');
      if (!codexFiles.has(name) || entry.file.split(path.sep).includes('archived_sessions')) codexFiles.set(name, entry);
    }
    files = files.filter((entry) => entry.app !== 'codex' || codexFiles.get(path.basename(entry.file).replace(/\.zst$/, '')) === entry);
    // shortcut: only the 10,000 newest transcript files count, so the scan and the cache stay bounded; raise MAX_CACHE_FILES if All time needs more.
    files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.file.localeCompare(b.file));
    files.splice(maxCacheFiles);
    // The first scan shows its progress; a refresh keeps the counts of the last full scan until it ends.
    if (!progress.complete) Object.assign(progress, { files: files.length, scannedFiles: 0 });
    const seen = new Set();
    let changed = false;
    for (const { file, app, info } of files) {
      // A stop must not wait for a long first scan; the stopped scan merges and saves nothing.
      if (stopped) return;
      const key = pathKey(file);
      seen.add(key);
      const previous = cache.get(key);
      try {
        const entry = await scanFile(file, info, previous, app, { stats, pause });
        if (entry !== previous) { cache.set(key, entry); changed = true; version += 1; }
      } catch {
        if (file.endsWith('.zst') && cache.delete(key)) { changed = true; version += 1; }
        // Other unreadable transcripts keep their old entry, if any.
      }
      if (!progress.complete) progress.scannedFiles += 1;
    }
    if (stopped) return;
    const found = [];
    const queried = new Map();
    let openCodeChanged = databases.size !== openCodeReads.size;
    for (const dataDir of databases) {
      const databaseFiles = await openCodeDatabases(dataDir);
      const signature = (await Promise.all(databaseFiles.map(async (database) => {
        const info = await Promise.all([database, `${database}-wal`].map((file) => fs.stat(file)
          .then((stat) => `${stat.size}:${stat.mtimeMs}`, () => 'null')));
        return `${path.basename(database)}:${info.join('|')}`;
      }))).join('/');
      let last = openCodeReads.get(dataDir);
      if (last?.signature !== signature && (!last || now() - last.readAtMs >= 60_000)) {
        let records = [];
        try { records = await readOpenCodeUsage(dataDir, 0, { stats, pause }); } catch { /* No database or another schema: no usage. */ }
        stats.openCodeQueries += 1;
        last = { signature, records, readAtMs: now() };
        openCodeChanged = true;
      }
      queried.set(dataDir, last);
      found.push(...last.records);
    }
    openCodeReads = queried;
    // The same arrays when nothing changed, so the next report keeps its parts.
    if (openCodeChanged) { openCode = found; version += 1; }
    antigravity = await readAntigravityUsage(await antigravityRoots(env, homeDir), 0, { cache: antigravityCache, pause });
    for (const key of cache.keys()) if (!seen.has(key)) { cache.delete(key); changed = true; version += 1; }
    Object.assign(progress, { complete: true, files: files.length, scannedFiles: files.length });
    stats.scans += 1;
    dirty ||= changed;
    if (dirty && (lastSavedAtMs === null || now() - lastSavedAtMs >= SAVE_INTERVAL_MS)) {
      lastSavedAtMs = now();
      dirty = false;
      try { await saveUsageCache(cacheFile, cache, { platform }); stats.saves += 1; } catch { log('ASB cannot save its usage cache. It keeps the old file.'); }
    }
    if (ledgerFile) {
      const nowMs = now();
      if (mergeRecords(ledger.self.records, liveHourly().filter((record) => validRecord(record, nowMs)))) changeLedger();
      adoptSelf();
      if (ledgerDirty && (ledgerSavedAtMs === null || nowMs - ledgerSavedAtMs >= SAVE_INTERVAL_MS)) await saveLedger();
    }
  }

  function ensureLedger() {
    return ledgerLoad ||= loadLedger(ledgerFile, { platform, now, log }).then((loaded) => {
      ({ ledger } = loaded);
      ledgerBlocked = loaded.blocked;
      changeLedger(false);
      adoptSelf();
    });
  }
  function changeLedger(dirty = true) {
    ledgerVersion += 1;
    ledgerDirty ||= dirty;
  }
  // The ledger keeps the current machine ID and name; an imported copy of this machine joins its own records.
  function adoptSelf() {
    const { machineId, name } = self();
    if (!machineId) return;
    if (ledger.self.machineId !== machineId || ledger.self.name !== name) {
      Object.assign(ledger.self, { machineId, name });
      changeLedger();
    }
    const copy = ledger.machines.get(machineId);
    if (copy) {
      mergeRecords(ledger.self.records, copy.records.values());
      ledger.machines.delete(machineId);
      changeLedger();
    }
  }
  // Saves run one at a time. A failed save keeps the changes for the next one.
  function saveLedger() {
    return ledgerWrite = ledgerWrite.then(async () => {
      if (!ledgerDirty || ledgerBlocked) return;
      ledgerDirty = false;
      ledgerSavedAtMs = now();
      try {
        await writePrivateJson(ledgerFile, encodeLedger(ledger), { platform });
        stats.ledgerSaves += 1;
      } catch {
        ledgerDirty = true;
        log('ASB cannot save its usage ledger. It keeps the old file.');
      }
    });
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

  // The token sums per (app, model, quarter hour), built once per change. Repeated dedupe keys count once: the files go in a
  // stable order (by file key), so the first copy of a Claude message is always the same one. Every bucket edge is on a
  // quarter hour, so the reports give the same records as with the single parts.
  function allParts() {
    if (parts?.version === version && parts.openCode === openCode && parts.antigravity === antigravity) return parts.list;
    const seen = new Set();
    const sums = new Map();
    const add = (app, model, quarter, uncached, cacheRead, cacheWrite, output) => {
      const id = `${app}\0${model}\0${quarter}`;
      const sum = sums.get(id);
      if (!sum) sums.set(id, { app, model, atMs: quarter * QUARTER_HOUR_MS, tokens: { uncached, cacheRead, cacheWrite, output } });
      else {
        sum.tokens.uncached += uncached; sum.tokens.cacheRead += cacheRead; sum.tokens.cacheWrite += cacheWrite; sum.tokens.output += output;
      }
    };
    for (const key of [...(cache?.keys() || [])].sort()) {
      const { app, records } = cache.get(key);
      for (const [quarter, model, uncached, cacheRead, cacheWrite, output, dedupeKey] of records) {
        if (dedupeKey !== null) {
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
        }
        add(app, model, quarter, uncached, cacheRead, cacheWrite, output);
      }
    }
    for (const { app, model, timestampMs, tokens } of [...openCode, ...antigravity]) {
      add(app, model, Math.floor(timestampMs / QUARTER_HOUR_MS), tokens.uncached, tokens.cacheRead, tokens.cacheWrite, tokens.output);
    }
    const list = [...sums.values()];
    parts = { version, openCode, antigravity, list };
    stats.partBuilds += 1;
    stats.parts = list.length;
    return list;
  }

  // The hourly records of the transcripts that exist now, for all hours.
  function liveHourly() {
    const list = allParts();
    if (derived?.list !== list) derived = { list, live: aggregateHourly(list, 0, Infinity), ledgerVersion: null };
    return derived.live;
  }
  // With the ledger: the hourly parts that only the ledger still has, and per key the larger of the live and ledger records.
  function ledgerViews() {
    const live = liveHourly();
    if (derived.ledgerVersion === ledgerVersion) return derived;
    const extras = [];
    const merged = new Map();
    mergeRecords(merged, live);
    if (ledger) {
      const byKey = new Map(live.map((record) => [recordKey(record.hourMs, record.app, record.model), record.tokens]));
      for (const [key, record] of ledger.self.records) {
        const tokens = Object.fromEntries(TOKEN_TYPES.map((type) => [type, Math.max(0, record.tokens[type] - (byKey.get(key)?.[type] ?? 0))]));
        if (TOKEN_TYPES.some((type) => tokens[type] > 0)) extras.push({ app: record.app, model: record.model, atMs: record.hourMs, tokens, key: null });
        mergeRecord(merged, record);
      }
    }
    const hourly = [...merged.values()].filter(({ tokens }) => TOKEN_TYPES.some((type) => tokens[type] > 0))
      .sort((a, b) => a.hourMs - b.hourMs || a.app.localeCompare(b.app) || a.model.localeCompare(b.model));
    return Object.assign(derived, { ledgerVersion, extras, hourly });
  }
  const localParts = () => ledgerFile ? [...allParts(), ...ledgerViews().extras] : allParts();
  // A member's reply records, with the larger values of its imported records.
  const memberUsage = (member) => {
    const usage = Array.isArray(member.usage) ? member.usage : [];
    const name = typeof member.name === 'string' ? member.name.toLowerCase() : '';
    const cached = memberReplies.get(usage);
    if (cached?.ledgerVersion === ledgerVersion && cached.machineId === member.machineId && cached.name === name) return cached.records;
    const merged = new Map();
    for (const imported of ledger?.machines.values() || []) {
      if (imported.machineId === member.machineId || (name && imported.name.toLowerCase() === name)) mergeRecords(merged, imported.records.values());
    }
    mergeRecords(merged, usage.filter(validMemberRecord));
    const records = [...merged.values()];
    memberReplies.set(usage, { ledgerVersion, machineId: member.machineId, name, records });
    stats.memberBuilds += 1;
    return records;
  };
  // The member replies go into the ledger, so a member that is offline after a restart stays in the report and the export.
  // Only valid records: one bad tuple would make the next load set the whole file aside.
  function keepMembers(members) {
    if (!ledger) return;
    const nowMs = now();
    const selfId = self().machineId;
    for (const member of members) {
      const usage = Array.isArray(member.usage) ? member.usage : [];
      if (!usage.length || keptReplies.has(usage) || typeof member.machineId !== 'string' || !MACHINE_ID.test(member.machineId)
        || !validName(member.name) || member.machineId === selfId) continue;
      keptReplies.add(usage);
      let target = ledger.machines.get(member.machineId);
      if (!target) ledger.machines.set(member.machineId, target = { machineId: member.machineId, name: member.name, exportedAtMs: 0, records: new Map() });
      const grew = mergeRecords(target.records, usage.filter((record) => validMemberRecord(record) && validRecord(record, nowMs)));
      const at = Number.isSafeInteger(member.lastReportAtMs) && member.lastReportAtMs > 0 ? member.lastReportAtMs : 0;
      if (grew || target.name !== member.name || at > target.exportedAtMs) {
        Object.assign(target, { name: member.name, exportedAtMs: Math.max(target.exportedAtMs, at) });
        changeLedger();
      }
    }
  }
  // The imported machines that are neither this machine nor a member, by name.
  const importedOnly = (members) => {
    const skip = new Set([self().machineId, ...members.map((member) => member.machineId)]);
    const names = new Set(members.filter((member) => typeof member.name === 'string').map((member) => member.name.toLowerCase()));
    const grouped = new Map();
    for (const machine of ledger?.machines.values() || []) {
      const name = machine.name.toLowerCase();
      if (skip.has(machine.machineId) || names.has(name)) continue;
      let target = grouped.get(name);
      if (!target) grouped.set(name, target = { ...machine, records: new Map() });
      mergeRecords(target.records, machine.records.values());
      if (machine.exportedAtMs > target.exportedAtMs || (machine.exportedAtMs === target.exportedAtMs && machine.machineId > target.machineId)) {
        Object.assign(target, { machineId: machine.machineId, name: machine.name, exportedAtMs: machine.exportedAtMs });
      }
    }
    return [...grouped.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.machineId < b.machineId ? -1 : 1));
  };
  // With a ledger, each usage request (re)starts one release timer; it fires when no request came for RELEASE_AFTER_MS.
  const ask = () => {
    lastAskMs = now();
    if (ledgerFile && !stopped) armRelease();
  };
  function armRelease() {
    if (releaseTimer) timers.clearTimeout(releaseTimer);
    releaseTimer = timers.setTimeout(releaseIdle, RELEASE_AFTER_MS);
    releaseTimer?.unref?.();
  }
  // A running scan keeps the cache; the check runs again when the scan ends, unless a new request restarted the timer.
  async function releaseIdle() {
    releaseTimer = null;
    if (stopped) return;
    if (running) {
      running.then(() => { if (!releaseTimer) return releaseIdle(); });
      return;
    }
    await release();
  }
  // Saves the scan cache when it changed and drops it from memory. The ledger keeps the totals, so the next report shows
  // them while a new scan reads the cache again.
  async function release() {
    if (running || !cache) return;
    if (dirty) {
      dirty = false;
      lastSavedAtMs = now();
      try { await saveUsageCache(cacheFile, cache, { platform }); stats.saves += 1; } catch { log('ASB cannot save its usage cache. It keeps the old file.'); }
    }
    if (!running && cache && (lastAskMs === null || now() - lastAskMs >= RELEASE_AFTER_MS)) {
      cache = null;
      parts = null;
      version += 1;
      stats.releases += 1;
    }
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    if (busy() && (waitingSinceMs === null || now() - waitingSinceMs < 60 * 60 * 1000)) {
      waitingSinceMs ??= now();
      schedule(60 * 1000);
      return;
    }
    waitingSinceMs = null;
    ticking = (async () => {
      await ensureScan(true);
      if (stopped) return;
      // The newest usage of the online members, so the ledger and the backups keep it while a member is offline.
      if (members) {
        const replies = await members().catch(() => []);
        if (stopped) return;
        keepMembers(replies);
        if (ledgerDirty) await saveLedger();
      }
      if (lastAskMs === null || now() - lastAskMs >= RELEASE_AFTER_MS) await release();
    })();
    await ticking;
    ticking = null;
    if (!stopped) schedule(LEDGER_REFRESH_MS);
  }
  function schedule(delayMs) {
    timer = timers.setTimeout(tick, delayMs);
    timer?.unref?.();
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
      ask();
      ensureScan();
      keepMembers(members);
      const nowMs = now();
      let firstMs = null;
      if (period === 'all') {
        const include = (atMs, tokens) => {
          if (atMs >= FIRST_USAGE_MS && TOKEN_TYPES.some((type) => tokens[type] > 0) && (firstMs === null || atMs < firstMs)) firstMs = atMs;
        };
        for (const part of localParts()) include(part.atMs, part.tokens);
        for (const member of members) {
          for (const record of Array.isArray(member.usage) ? member.usage : []) if (validMemberRecord(record)) include(record.hourMs, record.tokens);
        }
        for (const machine of ledger?.machines.values() || []) for (const record of machine.records.values()) include(record.hourMs, record.tokens);
      }
      const { unit, startsMs, endMs } = periodBuckets(period, nowMs, firstMs);
      rates.ensure();
      const table = rates.table();
      const { machineId, name } = self();
      const withMachine = (id) => ({ app, model, bucket, tokens, cost }) => ({ machineId: id, app, model, maker: modelMaker(model), bucket, tokens, cost });
      const records = aggregateBuckets(localParts(), { startsMs, endMs, rates: table }).map(withMachine(machineId));
      const scan = { ...progress };
      const addMachine = (id, usage) => records.push(...aggregateBuckets(usage.map(({ app, model, hourMs, tokens }) => ({ app, model, atMs: hourMs, tokens, key: null })),
        { startsMs, endMs: Infinity, rates: table }).map(withMachine(id)));
      for (const member of members) {
        addMachine(member.machineId, memberUsage(member));
        // A member that never answered has no scan and adds nothing.
        if (member.scan) {
          scan.complete &&= member.scan.complete === true;
          scan.files += Number(member.scan.files) || 0;
          scan.scannedFiles += Number(member.scan.scannedFiles) || 0;
        }
      }
      const imported = importedOnly(members);
      for (const machine of imported) addMachine(machine.machineId, [...machine.records.values()]);
      return {
        period, nowMs, buckets: { unit, startsMs },
        machines: [{ machineId, name, self: true, state: 'local', lastReportAtMs: 0 }, ...members.map((member) => ({
          machineId: member.machineId, name: member.name, self: false, state: member.state, lastReportAtMs: member.lastReportAtMs || 0 })),
        ...imported.map((machine) => ({ machineId: machine.machineId, name: machine.name, self: false, state: 'offline', lastReportAtMs: machine.exportedAtMs }))],
        records,
        prices: rates.pricing(),
        scan,
      };
    },
    // The usage part of contract 4: UTC hours, tokens only. It starts early enough to fill the first local bucket of any time zone.
    localHourly(period) {
      checkPeriod(period);
      ask();
      ensureScan();
      const nowMs = now();
      const days = USAGE_PERIODS[period].unit === 'hour' ? 1 : USAGE_PERIODS[period].count;
      const sinceMs = period === 'all' ? 0 : Math.floor((nowMs - days * DAY_MS - HOUR_MS) / HOUR_MS) * HOUR_MS;
      const usage = ledgerFile ? ledgerViews().hourly.filter((record) => record.hourMs >= sinceMs && record.hourMs < nowMs + HOUR_MS)
        : aggregateHourly(allParts(), sinceMs, nowMs + HOUR_MS);
      return { usage: usage.slice(-MAX_HOURLY_RECORDS), scan: { ...progress } };
    },
    ...(ledgerFile ? {
      // This machine, the members with records, then the imported-only machines: every hour, in the export file form.
      async exportAll(members = []) {
        ask();
        await ensureScan(true);
        ask();
        const { machineId, name } = self();
        if (!machineId) throw Object.assign(new Error('ASB has no machine ID yet. Start ASB again.'), { statusCode: 409 });
        keepMembers(members);
        const nowMs = now();
        const valid = (list) => list.filter((record) => validRecord(record, nowMs));
        // A host name that is not a group name (or `This PC`) would make this file fail its own import.
        const machines = [{ machineId, name: validName(name) ? name : suggestName(name), records: valid(ledgerViews().hourly) }];
        const listed = new Set([machineId]);
        for (const member of members) {
          if (listed.has(member.machineId)) continue;
          const records = valid(memberUsage(member));
          if (!records.length) continue;
          listed.add(member.machineId);
          machines.push({ machineId: member.machineId, name: member.name, records });
        }
        for (const machine of importedOnly(members)) {
          if (!listed.has(machine.machineId)) machines.push({ machineId: machine.machineId, name: machine.name, records: valid([...machine.records.values()]) });
        }
        return exportDocument(nowMs, machines);
      },
      async importAll(document) {
        ask();
        const machines = readExport(document, now());
        await ensureLedger();
        const selfId = self().machineId;
        for (const { machineId, name, records } of machines) {
          if (machineId === selfId) {
            if (mergeRecords(ledger.self.records, records.values())) changeLedger();
            continue;
          }
          let target = ledger.machines.get(machineId);
          if (!target) ledger.machines.set(machineId, target = { machineId, name, exportedAtMs: 0, records: new Map() });
          const grew = mergeRecords(target.records, records.values());
          if (grew || target.name !== name || target.exportedAtMs < document.exportedAtMs) {
            Object.assign(target, { name, exportedAtMs: Math.max(target.exportedAtMs, document.exportedAtMs) });
            changeLedger();
          }
        }
        await saveLedger();
        if (ledgerBlocked || ledgerDirty) throw Object.assign(new Error('ASB could not save the usage ledger. Keep the export file and try again.'), { statusCode: 500, expose: true });
        return { machines: machines.map(({ machineId, name, records }) => ({ machineId, name, hours: records.size })) };
      },
    } : {}),
    // The background ledger refresh waits for idle, at most an hour after it is due.
    start() {
      if (!ledgerFile || started) return;
      started = true;
      schedule(LEDGER_FIRST_MS);
    },
    async stop() {
      if (!ledgerFile) return;
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      if (releaseTimer) timers.clearTimeout(releaseTimer);
      timer = releaseTimer = null;
      await ticking;
      await running;
      await saveLedger();
    },
    flush: () => ledgerFile ? saveLedger() : Promise.resolve(),
    // For tests and the engine: start a scan now (or join the running one) and wait for it.
    refresh: () => ensureScan(true),
    idle: () => running || Promise.resolve(),
    pricesIdle: () => rates.idle(),
    stats,
  };
}
