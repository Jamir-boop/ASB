import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getClaudeCacheStats } from './claude-data.mjs';
import { getCodexCacheStats } from './codex-data.mjs';
import { durationSince, hitRatePercent, positiveInteger } from './local-http.mjs';

const DEFAULT_DASHBOARD_CACHE_TTL_MS = 10_000;
const DEFAULT_NOTIFICATION_CACHE_TTL_MS = 30_000;
const DEFAULT_PENDING_SUMMARY_DASHBOARD_MAX_AGE_MS = 120_000;
const DEFAULT_DASHBOARD_EVENT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS = 500;

export class DashboardSnapshot {
  constructor({
    dashboardCacheTtlMs = positiveInteger(process.env.DASHBOARD_CACHE_TTL_MS, DEFAULT_DASHBOARD_CACHE_TTL_MS),
    dashboardWatchPaths = [],
    dashboardAdaptiveRefresh = false,
    dashboardSourceChanged = () => {},
    watchDashboardPath = watch,
    dashboardSetTimeout = setTimeout,
    dashboardClearTimeout = clearTimeout,
    dashboardEventMinIntervalMs = positiveInteger(
      process.env.DASHBOARD_EVENT_MIN_INTERVAL_MS,
      DEFAULT_DASHBOARD_EVENT_MIN_INTERVAL_MS,
    ),
    dashboardWatchDebounceMs = positiveInteger(
      process.env.DASHBOARD_WATCH_DEBOUNCE_MS,
      DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS,
    ),
    notificationCacheTtlMs = positiveInteger(process.env.NOTIFICATION_CACHE_TTL_MS, DEFAULT_NOTIFICATION_CACHE_TTL_MS),
    pendingSummaryDashboardMaxAgeMs = positiveInteger(
      process.env.PENDING_SUMMARY_DASHBOARD_MAX_AGE_MS,
      DEFAULT_PENDING_SUMMARY_DASHBOARD_MAX_AGE_MS,
    ),
    now = Date.now,
    loadDashboard,
    openThread,
    notificationCenter = null,
    monitorNotifications = false,
    notificationScanIntervalMs = 20_000,
  } = {}) {
    const getWatchPaths = async () => typeof dashboardWatchPaths === 'function' ? await dashboardWatchPaths() : dashboardWatchPaths || [];
    let dashboardLoadPromise = null;
    let notificationRefreshPromise = null;
    let dashboardCache = null;
    let notificationCache = null;
    const dashboardEventClients = new Set();
    const dashboardWatchers = [];
    let dashboardEventVersion = 0;
    let dashboardInvalidationTimer = null;
    let dashboardInvalidationReason = 'file-change';
    let dashboardLastEventAtMs = 0;
    let dashboardDirty = false;
    let dashboardGeneration = 0;
    let dashboardLastScanStartedAtMs = -Infinity;
    let dashboardRetryAfterMs = 0;
    let dashboardClosed = false;
    let dashboardWatchCoverage = false;
    let dashboardWatchRetryTimer = null;
    let dashboardWatchReconcilePromise = null;
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
      notificationCacheHits: 0,
      notificationCacheMisses: 0,
      notificationCoalescedRefreshes: 0,
      notificationRefreshCount: 0,
      notificationRefreshErrors: 0,
      notificationLastRefreshMs: null,
      notificationLastRefreshedAtMs: null,
    };

    const performanceSnapshot = () => {
      const memory = process.memoryUsage();
      const dashboardCacheAgeMs = dashboardCache?.cachedAtMs ? Math.max(0, now() - dashboardCache.cachedAtMs) : null;
      const notificationCacheAgeMs = notificationCache?.cachedAtMs
        ? Math.max(0, now() - notificationCache.cachedAtMs)
        : null;
      const cacheTtlMs = dashboardAdaptiveRefresh ? dashboardWatchCoverage ? 5_000
        : dashboardCache?.dashboard?.refreshIntervalMs === 2_000 ? 2_000 : 5_000 : dashboardCacheTtlMs;

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
          ...(dashboardAdaptiveRefresh ? { watchCoverage: dashboardWatchCoverage } : {}),
          eventMinIntervalMs: dashboardEventMinIntervalMs,
          softInvalidations: serverMetrics.dashboardSoftInvalidations,
          hardInvalidations: serverMetrics.dashboardHardInvalidations,
          lastInvalidatedAtMs: serverMetrics.dashboardLastInvalidatedAtMs,
        },
        notifications: {
          cacheTtlMs: notificationCacheTtlMs,
          cacheAgeMs: notificationCacheAgeMs,
          cached: notificationCacheAgeMs !== null && notificationCacheAgeMs < notificationCacheTtlMs,
          hits: serverMetrics.notificationCacheHits,
          misses: serverMetrics.notificationCacheMisses,
          hitRatePercent: hitRatePercent(
            serverMetrics.notificationCacheHits,
            serverMetrics.notificationCacheMisses,
          ),
          coalescedRefreshes: serverMetrics.notificationCoalescedRefreshes,
          refreshCount: serverMetrics.notificationRefreshCount,
          errorCount: serverMetrics.notificationRefreshErrors,
          lastRefreshMs: serverMetrics.notificationLastRefreshMs,
          lastRefreshedAtMs: serverMetrics.notificationLastRefreshedAtMs,
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
      const cacheTtlMs = dashboardAdaptiveRefresh ? dashboardWatchCoverage ? 5_000 : refreshIntervalMs : dashboardCacheTtlMs;
      const clockExpired = dashboardAdaptiveRefresh && now() >= Number(dashboardCache?.dashboard?.nextStatusCheckAtMs || Infinity);
      const busyThrottled = dashboardAdaptiveRefresh && dashboardDirty && refreshIntervalMs === 2_000
        && now() - dashboardLastScanStartedAtMs < 2_000;
      const cacheValid = !clockExpired && (dashboardAdaptiveRefresh
        ? (!dashboardDirty && cacheAgeMs < cacheTtlMs) || busyThrottled : cacheAgeMs < cacheTtlMs);
      if (!force && dashboardCache?.dashboard && cacheAgeMs >= 0
        && (cacheValid || dashboardAdaptiveRefresh && now() < dashboardRetryAfterMs)) {
        serverMetrics.dashboardCacheHits += 1;
        return Promise.resolve(dashboardCache.dashboard);
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
            if (dashboardAdaptiveRefresh) {
              if (dashboardDirty) await reconcileAdaptiveWatchers();
              for (const [source, files] of hints) {
                for (const [filePath, index] of files) await dashboardSourceChanged(source, { filePath, index });
              }
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
            if (dashboardAdaptiveRefresh) { dashboardDirty = true; dashboardRetryAfterMs = now() + 5_000; }
            serverMetrics.dashboardLoadErrors += 1;
            serverMetrics.dashboardLastLoadMs = durationSince(startedAtMs);
            throw error;
          })
          .finally(() => {
            dashboardLoadPromise = null;
            if (dashboardAdaptiveRefresh && dashboardDirty && !dashboardClosed) scheduleDashboardInvalidation('file-change');
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
      if (hard) dashboardGeneration += 1;
      if (hard) {
        dashboardCache = null;
        notificationCache = null;
        serverMetrics.dashboardHardInvalidations += 1;
      } else {
        serverMetrics.dashboardSoftInvalidations += 1;
      }
      serverMetrics.dashboardLastInvalidatedAtMs = now();
      dashboardLastEventAtMs = now();
      dashboardEventVersion += 1;
      broadcastDashboardEvent('dashboard', dashboardAdaptiveRefresh ? {
        version: dashboardEventVersion,
        reason,
        sources: { ...dashboardSources },
      } : {
        version: dashboardEventVersion,
        reason,
        hard,
        observedAtMs: now(),
      });
      dashboardSources.codex = false;
      dashboardSources.claude = false;
    };

    const scheduleDashboardInvalidation = (reason = 'dashboard-change') => {
      dashboardDirty = true;
      dashboardInvalidationReason = reason;
      if (dashboardInvalidationTimer) return;

      if (dashboardAdaptiveRefresh) {
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
        return;
      }

      const elapsedMs = dashboardLastEventAtMs
        ? Math.max(0, now() - dashboardLastEventAtMs)
        : Number.POSITIVE_INFINITY;
      const throttleDelayMs = Number.isFinite(elapsedMs)
        ? Math.max(0, dashboardEventMinIntervalMs - elapsedMs)
        : 0;
      const delayMs = Math.max(dashboardWatchDebounceMs, throttleDelayMs);
      dashboardInvalidationTimer = dashboardSetTimeout(() => {
        dashboardInvalidationTimer = null;
        invalidateDashboard(dashboardInvalidationReason, { hard: false });
      }, delayMs);
      dashboardInvalidationTimer.unref?.();
    };

    const createDashboardWatchers = async () => {
      for (const entry of await getWatchPaths()) {
        const spec = typeof entry === 'string' ? { path: entry, recursive: false } : entry;
        const targetPath = spec?.path;
        if (!targetPath) continue;

        try {
          await stat(targetPath);
          const watcher = watchDashboardPath(targetPath, { recursive: Boolean(spec.recursive) }, () => {
            dashboardGeneration += 1;
            scheduleDashboardInvalidation('file-change');
          });
          watcher.on?.('error', () => {});
          dashboardWatchers.push(watcher);
        } catch {
          // Missing provider directories are expected when a provider is not installed.
        }
      }
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

    const reconcileAdaptiveWatchers = () => {
      if (dashboardWatchReconcilePromise || dashboardClosed) return dashboardWatchReconcilePromise;
      dashboardWatchReconcilePromise = (async () => {
        const watchPaths = await getWatchPaths();
        const desired = new Set();
        let covered = Boolean(watchPaths.length);
        const attach = async (targetPath, spec, recursive) => {
          if (dashboardClosed) return false;
          const info = await stat(targetPath);
          if (dashboardClosed) return false;
          desired.add(targetPath);
          const signature = `${info.dev}:${info.ino}`;
          const previous = adaptiveWatchers.get(targetPath);
          if (previous?.signature === signature && previous?.spec?.source === spec.source) return true;
          previous?.watcher.close?.();
          adaptiveWatchers.delete(targetPath);
          const watcher = watchDashboardPath(targetPath, { recursive }, (event, filename) => sourceChanged(spec, event, filename, targetPath));
          adaptiveWatchers.set(targetPath, { watcher, signature, spec });
          watcher.on?.('error', () => {
            if (adaptiveWatchers.get(targetPath)?.watcher !== watcher) return;
            watcher.close?.();
            adaptiveWatchers.delete(targetPath);
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
        for (const entry of watchPaths) {
          const spec = typeof entry === 'string' ? { path: entry } : entry;
          if (!spec?.path) continue;
          if (spec.recursive && adaptiveWatchers.get(spec.path)?.spec?.manualRecursive) spec.manualRecursive = true;
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
          } catch (error) {
            if (!(spec.optional && error.code === 'ENOENT')) covered = false;
          }
        }
        for (const [targetPath, entry] of adaptiveWatchers) {
          if (!desired.has(targetPath) || dashboardClosed) { entry.watcher.close?.(); adaptiveWatchers.delete(targetPath); }
        }
        dashboardWatchCoverage = !dashboardClosed && covered;
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

    const dashboardForPendingSummary = () => {
      const cachedAtMs = Number(dashboardCache?.cachedAtMs || 0);
      const cacheAgeMs = now() - cachedAtMs;
      if (
        dashboardCache?.dashboard
        && cacheAgeMs >= 0
        && cacheAgeMs <= pendingSummaryDashboardMaxAgeMs
      ) {
        serverMetrics.dashboardCacheHits += 1;
        return Promise.resolve(dashboardCache.dashboard);
      }

      return loadSharedDashboard();
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

    const notificationsForDashboard = async (dashboard, { force = false } = {}) => {
      if (!notificationCenter) return null;

      const cachedAtMs = Number(notificationCache?.cachedAtMs || 0);
      const cacheAgeMs = now() - cachedAtMs;
      if (!force && notificationCache?.notifications && cacheAgeMs >= 0 && cacheAgeMs < notificationCacheTtlMs) {
        serverMetrics.notificationCacheHits += 1;
        return notificationCache.notifications;
      }

      if (!notificationRefreshPromise) {
        serverMetrics.notificationCacheMisses += 1;
        const startedAtMs = Date.now();
        notificationRefreshPromise = Promise.resolve()
          .then(() => notificationCenter.refresh(dashboard))
          .then((notifications) => {
            serverMetrics.notificationRefreshCount += 1;
            serverMetrics.notificationLastRefreshMs = durationSince(startedAtMs);
            serverMetrics.notificationLastRefreshedAtMs = now();
            notificationCache = {
              notifications,
              cachedAtMs: now(),
            };
            return notifications;
          })
          .catch((error) => {
            serverMetrics.notificationRefreshErrors += 1;
            serverMetrics.notificationLastRefreshMs = durationSince(startedAtMs);
            throw error;
          })
          .finally(() => {
            notificationRefreshPromise = null;
          });
      } else {
        serverMetrics.notificationCoalescedRefreshes += 1;
      }
      return notificationRefreshPromise;
    };

    Object.assign(this, {
      dashboardForRequest, dashboardForPendingSummary, loadSharedDashboard,
      invalidateDashboard, performanceSnapshot, notificationsForDashboard, openThreadOnce,
      cachedDashboard: () => dashboardCache?.dashboard,
      serveEvents: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end('Method not allowed');
          return;
        }

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write('\n');
        dashboardEventClients.add(response);
        sendDashboardEvent(response, 'connected', dashboardAdaptiveRefresh ? {
          version: dashboardEventVersion, reason: 'connected', sources: { codex: false, claude: false },
        } : {
          version: dashboardEventVersion,
          observedAtMs: now(),
        });
        request.on('close', () => {
          dashboardEventClients.delete(response);
        });
        return;
      },
      attach: (server) => {
        if (dashboardAdaptiveRefresh && (typeof dashboardWatchPaths === 'function' || dashboardWatchPaths?.length)) {
          server.once('listening', retryAdaptiveWatchers);
        } else if (typeof dashboardWatchPaths === 'function' || dashboardWatchPaths?.length) {
          createDashboardWatchers().catch((error) => {
            console.warn('Dashboard watcher setup failed:', error instanceof Error ? error.message : String(error));
          });
        }

        const closeDashboardResources = () => {
          dashboardClosed = true;
          if (dashboardInvalidationTimer) dashboardClearTimeout(dashboardInvalidationTimer);
          if (dashboardWatchRetryTimer) dashboardClearTimeout(dashboardWatchRetryTimer);
          for (const watcher of dashboardWatchers) watcher.close?.();
          for (const entry of adaptiveWatchers.values()) entry.watcher.close?.();
          adaptiveWatchers.clear();
          for (const client of dashboardEventClients) client.end();
          dashboardEventClients.clear();
        };
        server.once('close', closeDashboardResources);
        if (dashboardAdaptiveRefresh) {
          const close = server.close.bind(server);
          server.close = (...args) => { closeDashboardResources(); return close(...args); };
        }

        if (monitorNotifications && notificationCenter) {
          let firstScan = true;
          const scan = async () => {
            try {
              const dashboard = await dashboardForRequest();
              await notificationsForDashboard(dashboard);
              firstScan = false;
            } catch (error) {
              console.warn('Notification scan failed:', error instanceof Error ? error.message : String(error));
            }
          };
          const timer = setInterval(scan, notificationScanIntervalMs);
          timer.unref?.();
          server.once('close', () => clearInterval(timer));
          scan();
        }
      },
    });
  }
}
