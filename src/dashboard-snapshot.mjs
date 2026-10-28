import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getClaudeCacheStats } from './claude-data.mjs';
import { getCodexCacheStats } from './codex-data.mjs';
import { durationSince, hitRatePercent, positiveInteger } from './local-http.mjs';

const DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS = 500;
// Service mode with full watch coverage: watch events, peer changes, and status expiries start scans; this is the safety scan.
const SERVICE_SAFETY_SCAN_MS = 30_000;
// The safety scan at rest: full watch coverage and no local Working row.
const SERVICE_REST_SCAN_MS = 300_000;
// The scan interval comes from the local rows; the JSON interval also counts member rows, for the board and the phone.
const scanIntervalMs = (dashboard) => (dashboard?.localRefreshIntervalMs ?? dashboard?.refreshIntervalMs) === 2_000 ? 2_000 : 5_000;
// The list content of a dashboard: all of it but the time and the counters. `summary` keeps the list from being empty.
const contentText = (dashboard) => {
  const { generatedAtMs: _, performance: __, ...rows } = dashboard;
  return JSON.stringify({ ...rows, summary: { ...(rows.summary || {}) } });
};

export class DashboardSnapshot {
  constructor({
    dashboardWatchPaths = [],
    dashboardSourceChanged = () => {},
    watchDashboardPath = watch,
    dashboardSetTimeout = setTimeout,
    dashboardClearTimeout = clearTimeout,
    dashboardPlatform = process.platform,
    dashboardWatchDebounceMs = positiveInteger(
      process.env.DASHBOARD_WATCH_DEBOUNCE_MS,
      DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS,
    ),
    now = Date.now,
    serviceMode = false,
    loadDashboard,
    openThread,
    // Extra fields of each `dashboard` event (the panel tag); the events keep their order.
    dashboardEventFields = null,
  } = {}) {
    const getWatchPaths = async () => typeof dashboardWatchPaths === 'function' ? await dashboardWatchPaths() : dashboardWatchPaths || [];
    let dashboardLoadPromise = null;
    let dashboardForcedFollowUp = null;
    let dashboardCache = null;
    const dashboardEventClients = new Set();
    let dashboardEventVersion = 0;
    let dashboardInvalidationTimer = null;
    let dashboardInvalidationReason = 'file-change';
    let dashboardDirty = false;
    let dashboardGeneration = 0;
    // Moves with each scan that changed the list and with each invalidation. Each in-place change of a cached row ends in an invalidation, so the revision shows it.
    let dashboardRevision = 0;
    // The list content of the cached dashboard at one revision; an in-place change moves the revision, so the text is made again.
    let listState = null;
    const listText = (dashboard) => {
      if (listState?.dashboard === dashboard && listState.revision === dashboardRevision) return listState.text;
      const text = contentText(dashboard);
      if (dashboard === dashboardCache?.dashboard) listState = { dashboard, revision: dashboardRevision, text };
      return text;
    };
    let dashboardLastScanStartedAtMs = -Infinity;
    let dashboardRetryAfterMs = 0;
    let dashboardClosed = false;
    let dashboardWatchCoverage = false;
    let dashboardWatchRetryTimer = null;
    let dashboardServiceTimer = null;
    let dashboardServiceDueAtMs = Infinity;
    let dashboardWatchReconcilePromise = null;
    let dashboardWatchWalkedAtMs = -Infinity;
    let dashboardWatchWalkedPaths = '';
    const dashboardWatchFailures = new Map();
    let dashboardWatchDesired = new Set();
    const dashboardWatchStructure = new Map();
    const adaptiveWatchers = new Map();
    const dashboardSourceHints = new Map();
    const dashboardFullScans = new Map();
    let dashboardWatchEpoch = 0;
    // The last scan decides between rest and work, so a change takes effect at the next scan.
    const fullScanIntervalMs = () => !serviceMode ? 5_000
      : dashboardWatchCoverage && dashboardCache && scanIntervalMs(dashboardCache.dashboard) !== 2_000 ? SERVICE_REST_SCAN_MS : SERVICE_SAFETY_SCAN_MS;
    const fullScanDue = () => ['codex', 'claude'].some((source) => {
      const age = now() - (dashboardFullScans.get(source)?.atMs ?? -Infinity);
      return age < 0 || age >= fullScanIntervalMs();
    });
    const dashboardSources = { codex: false, claude: false };
    const threadOpenPromises = new Map();
    const serverMetrics = {
      dashboardCacheHits: 0,
      dashboardCacheMisses: 0,
      dashboardCoalescedLoads: 0,
      dashboardLoadCount: 0,
      dashboardLoadErrors: 0,
      dashboardLastLoadMs: null,
      dashboardLastLoadedAtMs: null,
      dashboardSoftInvalidations: 0,
      dashboardHardInvalidations: 0,
      dashboardLastInvalidatedAtMs: null,
      dashboardWatchWalks: 0,
    };

    const performanceSnapshot = () => {
      const memory = process.memoryUsage();
      const dashboardCacheAgeMs = dashboardCache?.cachedAtMs ? Math.max(0, now() - dashboardCache.cachedAtMs) : null;
      const cacheTtlMs = !dashboardWatchCoverage ? scanIntervalMs(dashboardCache?.dashboard)
        : fullScanIntervalMs();

      return {
        generatedAtMs: now(),
        process: {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
        },
        dashboard: {
          cacheTtlMs,
          cacheAgeMs: dashboardCacheAgeMs,
          cached: dashboardCacheAgeMs !== null && dashboardCacheAgeMs < cacheTtlMs,
          hits: serverMetrics.dashboardCacheHits,
          misses: serverMetrics.dashboardCacheMisses,
          hitRatePercent: hitRatePercent(
            serverMetrics.dashboardCacheHits,
            serverMetrics.dashboardCacheMisses,
          ),
          coalescedLoads: serverMetrics.dashboardCoalescedLoads,
          loadCount: serverMetrics.dashboardLoadCount,
          errorCount: serverMetrics.dashboardLoadErrors,
          lastLoadMs: serverMetrics.dashboardLastLoadMs,
          lastLoadedAtMs: serverMetrics.dashboardLastLoadedAtMs,
          dirty: dashboardDirty,
          watchCoverage: dashboardWatchCoverage,
          watchWalks: serverMetrics.dashboardWatchWalks,
          softInvalidations: serverMetrics.dashboardSoftInvalidations,
          hardInvalidations: serverMetrics.dashboardHardInvalidations,
          lastInvalidatedAtMs: serverMetrics.dashboardLastInvalidatedAtMs,
        },
        caches: {
          codex: getCodexCacheStats(),
          claude: getClaudeCacheStats(),
        },
      };
    };

    const loadSharedDashboard = ({ force = false } = {}) => {
      const cachedAtMs = Number(dashboardCache?.cachedAtMs || 0);
      const cacheAgeMs = now() - cachedAtMs;
      const refreshIntervalMs = scanIntervalMs(dashboardCache?.dashboard);
      const cacheTtlMs = !dashboardWatchCoverage ? refreshIntervalMs : fullScanIntervalMs();
      const clockExpired = now() >= Number(dashboardCache?.dashboard?.nextStatusCheckAtMs || Infinity);
      const busyThrottled = dashboardDirty && refreshIntervalMs === 2_000
        && now() - dashboardLastScanStartedAtMs < 2_000;
      const cacheValid = !fullScanDue() && !clockExpired && ((!dashboardDirty && cacheAgeMs < cacheTtlMs) || busyThrottled);
      if (!force && dashboardCache?.dashboard && cacheAgeMs >= 0
        && (cacheValid || now() < dashboardRetryAfterMs)) {
        serverMetrics.dashboardCacheHits += 1;
        return Promise.resolve(dashboardCache.dashboard);
      }
      if (force && dashboardLoadPromise) {
        // The scan in flight can predate the caller's change: forced callers share one scan that starts after it.
        serverMetrics.dashboardCoalescedLoads += 1;
        return dashboardForcedFollowUp ||= dashboardLoadPromise.catch(() => {}).then(() => {
          dashboardForcedFollowUp = null;
          return loadSharedDashboard({ force: true });
        });
      }

      if (!dashboardLoadPromise) {
        serverMetrics.dashboardCacheMisses += 1;
        const startedAtMs = Date.now();
        dashboardLastScanStartedAtMs = now();
        const generation = dashboardGeneration;
        const hints = [...dashboardSourceHints];
        let reason = 'status-check';
        dashboardSourceHints.clear();
        dashboardLoadPromise = Promise.resolve()
          .then(async () => {
            if (dashboardDirty) {
              await reconcileAdaptiveWatchers();
              // A reconcile in flight can predate the structure event that made this scan dirty.
              if (dashboardWatchStructure.size) await reconcileAdaptiveWatchers();
            }
            for (const [source, files] of hints) {
              for (const [filePath, index] of files) await dashboardSourceChanged(source, { filePath, index });
            }
            reason = dashboardDirty ? dashboardInvalidationReason : 'status-check';
            const scanEpoch = dashboardWatchEpoch;
            const scanAtMs = now();
            const sourceScans = {};
            for (const source of ['codex', 'claude']) {
              const previous = dashboardFullScans.get(source);
              const files = new Map(hints).get(source) || new Map();
              const age = scanAtMs - (previous?.atMs ?? -Infinity);
              const trusted = !force && dashboardWatchCoverage && previous?.epoch === scanEpoch
                && age >= 0 && age < fullScanIntervalMs() && !files.has('');
              const watchKey = (filePath) => dashboardPlatform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
              const watched = [...adaptiveWatchers].filter(([, entry]) => entry.spec.source === source);
              const directories = new Set(watched.map(([root]) => watchKey(root)));
              const recursive = watched.filter(([, entry]) => entry.spec.recursive && !entry.spec.manualRecursive).map(([root]) => watchKey(root));
              const changed = [...files.keys()].map(watchKey);
              // shortcut: a lost watch event leaves a card late until the next full scan (30 s in service mode while a row works, 5 min at rest), go back to full scans if watch events prove unreliable
              sourceScans[source] = trusted ? { canReuse: (filePath) => {
                const target = watchKey(filePath);
                return !changed.some((hint) => target === hint || target.startsWith(`${hint}${path.sep}`))
                  && (directories.has(target) || directories.has(path.dirname(target))
                    || recursive.some((root) => target.startsWith(`${root}${path.sep}`)));
              } } : null;
            }
            const dashboard = await loadDashboard({ sourceScans });
            for (const source of ['codex', 'claude']) if (!sourceScans[source]) {
              dashboardFullScans.set(source, { atMs: scanAtMs, epoch: dashboardWatchCoverage && scanEpoch === dashboardWatchEpoch ? scanEpoch : null });
            }
            return dashboard;
          })
          .then((dashboard) => {
            serverMetrics.dashboardLoadCount += 1;
            serverMetrics.dashboardLastLoadMs = durationSince(startedAtMs);
            serverMetrics.dashboardLastLoadedAtMs = now();
            // Only a scan that changed the list moves the revision and tells the clients, also a timer scan.
            const text = contentText(dashboard);
            const changed = !dashboardCache || text !== listText(dashboardCache.dashboard);
            dashboardCache = {
              dashboard,
              cachedAtMs: now(),
            };
            if (changed) dashboardRevision += 1;
            listState = { dashboard, revision: dashboardRevision, text };
            dashboardRetryAfterMs = 0;
            if (generation === dashboardGeneration) dashboardDirty = false;
            if (changed) {
              serverMetrics.dashboardSoftInvalidations += 1;
              announceDashboard(reason);
            } else dashboardSources.codex = dashboardSources.claude = false;
            // A scan that starts the work brings a 5 min timer of the rest forward; the poll's own scan sets its timer itself.
            if (dashboardServiceTimer && !dashboardClosed && now() + serviceDelay(dashboard) < dashboardServiceDueAtMs) armServiceTimer(serviceDelay(dashboard));
            return dashboard;
          })
          .catch((error) => {
            dashboardDirty = true;
            dashboardWatchEpoch += 1;
            dashboardRetryAfterMs = now() + 5_000;
            serverMetrics.dashboardLoadErrors += 1;
            serverMetrics.dashboardLastLoadMs = durationSince(startedAtMs);
            throw error;
          })
          .finally(() => {
            dashboardLoadPromise = null;
            if (dashboardDirty && !dashboardClosed) scheduleDashboardInvalidation('file-change');
          });
      } else {
        serverMetrics.dashboardCoalescedLoads += 1;
      }
      return dashboardLoadPromise;
    };

    const sendDashboardEvent = (response, event, payload) => {
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const broadcastDashboardEvent = (event, payload) => {
      for (const client of dashboardEventClients) {
        sendDashboardEvent(client, event, payload);
      }
    };

    let dashboardEvents = Promise.resolve();
    const announceDashboard = (reason) => {
      serverMetrics.dashboardLastInvalidatedAtMs = now();
      dashboardEventVersion += 1;
      const payload = { version: dashboardEventVersion, reason, sources: { ...dashboardSources } };
      dashboardSources.codex = false;
      dashboardSources.claude = false;
      if (!dashboardEventFields) { broadcastDashboardEvent('dashboard', payload); return; }
      dashboardEvents = dashboardEvents.then(dashboardEventFields).catch(() => ({}))
        .then((fields) => broadcastDashboardEvent('dashboard', { ...payload, ...fields }));
    };

    const invalidateDashboard = (reason = 'dashboard-change', { hard = true, dirty = true } = {}) => {
      // A soft dirty change leaves the cached rows as they are (the next scan shows it), so their list text stays.
      const keepText = !hard && dirty && listState?.revision === dashboardRevision;
      // First, so a client that gets the event below reads the new revision.
      dashboardRevision += 1;
      if (keepText) listState.revision = dashboardRevision;
      if (dirty) dashboardDirty = true;
      // A scan in flight predates this change and must not clear the dirty mark.
      if (hard || dirty) dashboardGeneration += 1;
      if (hard) {
        dashboardWatchEpoch += 1;
        dashboardFullScans.clear();
        dashboardCache = listState = null;
        serverMetrics.dashboardHardInvalidations += 1;
      } else {
        serverMetrics.dashboardSoftInvalidations += 1;
      }
      announceDashboard(reason);
      // No file event follows a peer change: the service gets the follow-up scan of a source event, also with no reader.
      if (serviceMode && dirty && !hard && !dashboardClosed) scheduleDashboardInvalidation(reason);
    };

    const scheduleDashboardInvalidation = (reason = 'dashboard-change') => {
      dashboardDirty = true;
      dashboardInvalidationReason = reason;
      if (dashboardInvalidationTimer) return;

      const busy = scanIntervalMs(dashboardCache?.dashboard) === 2_000;
      const delayMs = Math.max(dashboardWatchDebounceMs, dashboardRetryAfterMs - now(),
        busy ? 2_000 - (now() - dashboardLastScanStartedAtMs) : 0);
      dashboardInvalidationTimer = dashboardSetTimeout(() => {
        dashboardInvalidationTimer = null;
        if (dashboardClosed) return;
        if (dashboardLoadPromise) return;
        // One shared follow-up scan covers the burst before clients read the snapshot.
        // The scan sends the event itself, only when the list changed.
        if (dashboardCache && dashboardDirty && (dashboardEventClients.size || serviceMode)) {
          loadSharedDashboard().catch(() => {
            if (!dashboardClosed) invalidateDashboard('source-unavailable', { hard: false });
          });
        } else invalidateDashboard(dashboardInvalidationReason, { hard: false, dirty: false });
      }, Math.max(0, delayMs));
      dashboardInvalidationTimer.unref?.();
    };

    const sourceChanged = (spec, event, rawFilename, targetPath = spec.path) => {
      if (dashboardClosed) return;
      const filename = rawFilename == null ? '' : String(rawFilename);
      if (spec.acceptEvent && !spec.acceptEvent(filename, event)) return;
      const filePath = filename ? path.resolve(targetPath, filename) : '';
      if (filename && (path.isAbsolute(filename) || path.relative(targetPath, filePath).startsWith('..'))) return;
      dashboardGeneration += 1;
      if (['codex', 'claude'].includes(spec.source)) {
        dashboardSources[spec.source] = true;
        let files = dashboardSourceHints.get(spec.source);
        if (!files) dashboardSourceHints.set(spec.source, files = new Map());
        if (!files.has('')) {
          // A large burst needs one provider index check, with no unbounded filename queue.
          if (!filePath || files.size >= 128) { files.clear(); files.set('', true); }
          else files.set(filePath, files.get(filePath) || event === 'rename');
        }
      }
      if (!spec.source) dashboardWatchEpoch += 1;
      scheduleDashboardInvalidation('file-change');
    };

    const structureChanged = (spec, event, rawFilename, targetPath) => {
      if (dashboardClosed || event !== 'rename' || rawFilename == null) return;
      const filePath = path.join(targetPath, String(rawFilename));
      // A removed or replaced watch root reports its own name; only a full walk can follow it.
      if (targetPath === spec.path && String(rawFilename) === path.basename(targetPath)) dashboardWatchWalkedAtMs = -Infinity;
      if (!spec.manualRecursive || path.dirname(filePath) !== targetPath || dashboardWatchWalkedAtMs === -Infinity) return;
      // A large burst needs one full walk, with no unbounded structure queue.
      if (dashboardWatchStructure.size >= 64) { dashboardWatchStructure.clear(); dashboardWatchWalkedAtMs = -Infinity; }
      else dashboardWatchStructure.set(filePath, spec);
    };

    const attach = async (targetPath, spec, recursive) => {
      if (dashboardClosed) return false;
      const info = await stat(targetPath);
      if (dashboardClosed) return false;
      dashboardWatchDesired.add(targetPath);
      const signature = `${info.dev}:${info.ino}`;
      const previous = adaptiveWatchers.get(targetPath);
      if (previous?.signature === signature && previous?.spec?.source === spec.source) return true;
      if (previous) dashboardWatchEpoch += 1;
      previous?.watcher.close?.();
      adaptiveWatchers.delete(targetPath);
      const watcher = watchDashboardPath(targetPath, { recursive }, (event, filename) => {
        if (adaptiveWatchers.get(targetPath)?.watcher !== watcher) return;
        // The spec filter can drop a directory event, so structure work comes first.
        structureChanged(spec, event, filename, targetPath);
        sourceChanged(spec, event, filename, targetPath);
      });
      adaptiveWatchers.set(targetPath, { watcher, signature, spec });
      watcher.on?.('error', () => {
        if (adaptiveWatchers.get(targetPath)?.watcher !== watcher) return;
        watcher.close?.();
        adaptiveWatchers.delete(targetPath);
        dashboardWatchFailures.set(spec.path, true);
        dashboardWatchCoverage = false;
        dashboardWatchEpoch += 1;
        sourceChanged(spec, 'rename', null);
      });
      return true;
    };
    const attachDirectories = async (targetPath, spec) => {
      await attach(targetPath, spec, false);
      const entries = await readdir(targetPath, { withFileTypes: true });
      for (const entry of entries) if (entry.isDirectory()) await attachDirectories(path.join(targetPath, entry.name), spec);
    };

    // Returns false when only a full walk can restore coverage.
    const applyWatchStructure = async () => {
      try {
        for (const [targetPath, spec] of dashboardWatchStructure) {
          dashboardWatchStructure.delete(targetPath);
          const info = await stat(targetPath).catch((error) => {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
          });
          if (dashboardClosed) return true;
          if (info?.isDirectory()) await attachDirectories(targetPath, spec);
          else for (const [watchedPath, entry] of adaptiveWatchers) {
            if (watchedPath !== targetPath && !watchedPath.startsWith(`${targetPath}${path.sep}`)) continue;
            entry.watcher.close?.();
            adaptiveWatchers.delete(watchedPath);
          }
        }
        return dashboardWatchWalkedAtMs !== -Infinity;
      } catch { return false; }
    };

    const reconcileAdaptiveWatchers = () => {
      if (dashboardWatchReconcilePromise || dashboardClosed) return dashboardWatchReconcilePromise;
      dashboardWatchReconcilePromise = (async () => {
        const watchPaths = await getWatchPaths();
        const walkedPaths = JSON.stringify(watchPaths.map((entry) => typeof entry === 'string' ? [entry]
          : [entry?.path, entry?.source, entry?.recursive, entry?.optional]));
        if (dashboardWatchWalkedPaths && walkedPaths !== dashboardWatchWalkedPaths) dashboardWatchEpoch += 1;
        const walkAgeMs = now() - dashboardWatchWalkedAtMs;
        // The directory set almost never changes: events keep it current, and a full walk is the 60 s safety net.
        const reuse = (dashboardWatchCoverage || dashboardWatchFailures.size > 0)
          && walkedPaths === dashboardWatchWalkedPaths && walkAgeMs >= 0 && walkAgeMs < 60_000
          && await applyWatchStructure();
        if (reuse && !dashboardWatchFailures.size) return;
        if (dashboardClosed) return;
        if (!reuse) {
          serverMetrics.dashboardWatchWalks += 1;
          dashboardWatchWalkedAtMs = now();
          dashboardWatchWalkedPaths = walkedPaths;
          dashboardWatchStructure.clear();
          dashboardWatchFailures.clear();
        }
        const failedPaths = new Set(dashboardWatchFailures.keys());
        const desired = dashboardWatchDesired = new Set(reuse ? [...adaptiveWatchers]
          .filter(([, entry]) => !failedPaths.has(entry.spec.path)).map(([targetPath]) => targetPath) : []);
        let recovered = false;
        for (const entry of watchPaths) {
          const spec = typeof entry === 'string' ? { path: entry } : entry;
          if (!spec?.path || (reuse && !failedPaths.has(spec.path))) continue;
          dashboardWatchFailures.delete(spec.path);
          // Linux recursive watches cost one inotify watch per file; directory watches still report file appends.
          if (spec.recursive && (dashboardPlatform === 'linux' || adaptiveWatchers.get(spec.path)?.spec?.manualRecursive)) spec.manualRecursive = true;
          try {
            if (spec.recursive && spec.manualRecursive) await attachDirectories(spec.path, spec);
            else {
              try { await attach(spec.path, spec, Boolean(spec.recursive)); }
              catch (error) {
                if (!spec.recursive || !['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'ERR_FEATURE_UNAVAILABLE', 'ERR_INVALID_ARG_VALUE'].includes(error.code)) throw error;
                spec.manualRecursive = true;
                await attachDirectories(spec.path, spec);
              }
            }
            recovered = true;
          } catch (error) {
            dashboardWatchFailures.set(spec.path, !(spec.optional && error.code === 'ENOENT'));
          }
        }
        for (const [targetPath, entry] of adaptiveWatchers) {
          if (!desired.has(targetPath) || dashboardClosed) { entry.watcher.close?.(); adaptiveWatchers.delete(targetPath); }
        }
        if (reuse && recovered) serverMetrics.dashboardWatchWalks += 1;
        dashboardWatchCoverage = !dashboardClosed && Boolean(watchPaths.length)
          && ![...dashboardWatchFailures.values()].some(Boolean);
        if (!dashboardWatchCoverage) dashboardWatchEpoch += 1;
      })().finally(() => { dashboardWatchReconcilePromise = null; });
      return dashboardWatchReconcilePromise;
    };

    const retryAdaptiveWatchers = async () => {
      try { await reconcileAdaptiveWatchers(); } catch { dashboardWatchCoverage = false; dashboardWatchEpoch += 1; }
      if (dashboardClosed) return;
      dashboardWatchRetryTimer = dashboardSetTimeout(retryAdaptiveWatchers, 5_000);
      dashboardWatchRetryTimer.unref?.();
    };

    const serviceDelay = (dashboard) => !dashboardWatchCoverage ? scanIntervalMs(dashboard)
      : Math.max(0, dashboardRetryAfterMs - now(), Math.min(...[...dashboardFullScans.values()].map((scan) => scan.atMs + fullScanIntervalMs() - now()),
        Math.max(2_000, Number(dashboard.nextStatusCheckAtMs || Infinity) - now())));
    const armServiceTimer = (delay) => {
      if (dashboardServiceTimer) dashboardClearTimeout(dashboardServiceTimer);
      dashboardServiceDueAtMs = now() + delay;
      dashboardServiceTimer = dashboardSetTimeout(pollServiceDashboard, delay);
      dashboardServiceTimer.unref?.();
    };
    const pollServiceDashboard = async () => {
      if (dashboardClosed) return;
      dashboardServiceTimer = null;
      let delay = 5_000;
      try { delay = serviceDelay(await loadSharedDashboard()); } catch {}
      if (dashboardClosed) return;
      armServiceTimer(delay);
    };

    const dashboardForRequest = async (options = {}) => {
      const dashboard = await loadSharedDashboard(options);
      const result = {
        ...dashboard,
        summary: { ...(dashboard.summary || {}) },
      };
      for (const symbol of Object.getOwnPropertySymbols(dashboard)) Object.defineProperty(result, symbol, Object.getOwnPropertyDescriptor(dashboard, symbol));
      return result;
    };

    const openThreadOnce = (thread) => {
      const threadKey = `${thread.provider || 'codex'}:${thread.id || thread.externalId || ''}`;
      if (!threadOpenPromises.has(threadKey)) {
        threadOpenPromises.set(
          threadKey,
          Promise.resolve()
            .then(() => openThread(thread))
            .finally(() => {
              threadOpenPromises.delete(threadKey);
            }),
        );
      }

      return threadOpenPromises.get(threadKey);
    };

    Object.assign(this, {
      dashboardForRequest, loadSharedDashboard, invalidateDashboard, performanceSnapshot, openThreadOnce,
      cachedDashboard: () => dashboardCache?.dashboard,
      listText,
      revision: () => dashboardRevision,
      broadcastEvent: (event, payload) => broadcastDashboardEvent(event, payload),
      serveEvents: (request, response, connected = {}) => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write('\n');
        dashboardEventClients.add(response);
        sendDashboardEvent(response, 'connected', {
          version: dashboardEventVersion, reason: 'connected', sources: { codex: false, claude: false }, listEvents: serviceMode, ...connected,
        });
        request.on('close', () => {
          dashboardEventClients.delete(response);
        });
      },
      attach: (server) => {
        if (serviceMode) server.once('listening', pollServiceDashboard);
        if (typeof dashboardWatchPaths === 'function' || dashboardWatchPaths?.length) server.once('listening', retryAdaptiveWatchers);

        const closeDashboardResources = () => {
          dashboardClosed = true;
          if (dashboardInvalidationTimer) dashboardClearTimeout(dashboardInvalidationTimer);
          if (dashboardWatchRetryTimer) dashboardClearTimeout(dashboardWatchRetryTimer);
          if (dashboardServiceTimer) dashboardClearTimeout(dashboardServiceTimer);
          for (const entry of adaptiveWatchers.values()) entry.watcher.close?.();
          adaptiveWatchers.clear();
          for (const client of dashboardEventClients) client.end();
          dashboardEventClients.clear();
        };
        server.once('close', closeDashboardResources);
        const close = server.close.bind(server);
        server.close = (...args) => { closeDashboardResources(); return close(...args); };
      },
    });
  }
}
