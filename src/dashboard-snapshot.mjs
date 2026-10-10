import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getClaudeCacheStats } from './claude-data.mjs';
import { getCodexCacheStats } from './codex-data.mjs';
import { durationSince, hitRatePercent, positiveInteger } from './local-http.mjs';

const DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS = 500;

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
    loadDashboard,
    openThread,
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
    let dashboardLastScanStartedAtMs = -Infinity;
    let dashboardRetryAfterMs = 0;
    let dashboardClosed = false;
    let dashboardWatchCoverage = false;
    let dashboardWatchRetryTimer = null;
    let dashboardWatchReconcilePromise = null;
    let dashboardWatchWalkedAtMs = -Infinity;
    let dashboardWatchWalkedPaths = '';
    const dashboardWatchFailures = new Map();
    let dashboardWatchDesired = new Set();
    const dashboardWatchStructure = new Map();
    const adaptiveWatchers = new Map();
    const dashboardSourceHints = new Map();
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
      const cacheTtlMs = dashboardWatchCoverage ? 5_000
        : dashboardCache?.dashboard?.refreshIntervalMs === 2_000 ? 2_000 : 5_000;

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
      const refreshIntervalMs = dashboardCache?.dashboard?.refreshIntervalMs === 2_000 ? 2_000 : 5_000;
      const cacheTtlMs = dashboardWatchCoverage ? 5_000 : refreshIntervalMs;
      const clockExpired = now() >= Number(dashboardCache?.dashboard?.nextStatusCheckAtMs || Infinity);
      const busyThrottled = dashboardDirty && refreshIntervalMs === 2_000
        && now() - dashboardLastScanStartedAtMs < 2_000;
      const cacheValid = !clockExpired && ((!dashboardDirty && cacheAgeMs < cacheTtlMs) || busyThrottled);
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
            return loadDashboard();
          })
          .then((dashboard) => {
            serverMetrics.dashboardLoadCount += 1;
            serverMetrics.dashboardLastLoadMs = durationSince(startedAtMs);
            serverMetrics.dashboardLastLoadedAtMs = now();
            dashboardCache = {
              dashboard,
              cachedAtMs: now(),
            };
            dashboardRetryAfterMs = 0;
            if (generation === dashboardGeneration) dashboardDirty = false;
            return dashboard;
          })
          .catch((error) => {
            dashboardDirty = true;
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

    const invalidateDashboard = (reason = 'dashboard-change', { hard = true, dirty = true } = {}) => {
      if (dirty) dashboardDirty = true;
      // A scan in flight predates this change and must not clear the dirty mark.
      if (hard || dirty) dashboardGeneration += 1;
      if (hard) {
        dashboardCache = null;
        serverMetrics.dashboardHardInvalidations += 1;
      } else {
        serverMetrics.dashboardSoftInvalidations += 1;
      }
      serverMetrics.dashboardLastInvalidatedAtMs = now();
      dashboardEventVersion += 1;
      broadcastDashboardEvent('dashboard', { version: dashboardEventVersion, reason, sources: { ...dashboardSources } });
      dashboardSources.codex = false;
      dashboardSources.claude = false;
    };

    const scheduleDashboardInvalidation = (reason = 'dashboard-change') => {
      dashboardDirty = true;
      dashboardInvalidationReason = reason;
      if (dashboardInvalidationTimer) return;

      const busy = dashboardCache?.dashboard?.refreshIntervalMs === 2_000;
      const delayMs = Math.max(dashboardWatchDebounceMs, dashboardRetryAfterMs - now(),
        busy ? 2_000 - (now() - dashboardLastScanStartedAtMs) : 0);
      dashboardInvalidationTimer = dashboardSetTimeout(() => {
        dashboardInvalidationTimer = null;
        if (dashboardClosed) return;
        if (dashboardLoadPromise) return;
        // One shared follow-up scan covers the burst before clients read the snapshot.
        if (dashboardCache && dashboardDirty && dashboardEventClients.size) {
          loadSharedDashboard().then(() => {
            if (!dashboardClosed) invalidateDashboard(dashboardInvalidationReason, { hard: false, dirty: false });
          }).catch(() => {
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
      })().finally(() => { dashboardWatchReconcilePromise = null; });
      return dashboardWatchReconcilePromise;
    };

    const retryAdaptiveWatchers = async () => {
      try { await reconcileAdaptiveWatchers(); } catch { dashboardWatchCoverage = false; }
      if (dashboardClosed) return;
      dashboardWatchRetryTimer = dashboardSetTimeout(retryAdaptiveWatchers, 5_000);
      dashboardWatchRetryTimer.unref?.();
    };

    const dashboardForRequest = async (options = {}) => {
      const dashboard = await loadSharedDashboard(options);
      return {
        ...dashboard,
        summary: { ...(dashboard.summary || {}) },
      };
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
      serveEvents: (request, response) => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write('\n');
        dashboardEventClients.add(response);
        sendDashboardEvent(response, 'connected', {
          version: dashboardEventVersion, reason: 'connected', sources: { codex: false, claude: false },
        });
        request.on('close', () => {
          dashboardEventClients.delete(response);
        });
      },
      attach: (server) => {
        if (typeof dashboardWatchPaths === 'function' || dashboardWatchPaths?.length) server.once('listening', retryAdaptiveWatchers);

        const closeDashboardResources = () => {
          dashboardClosed = true;
          if (dashboardInvalidationTimer) dashboardClearTimeout(dashboardInvalidationTimer);
          if (dashboardWatchRetryTimer) dashboardClearTimeout(dashboardWatchRetryTimer);
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
