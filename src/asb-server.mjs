import http from 'node:http';
import { DashboardSnapshot } from './dashboard-snapshot.mjs';
import { DEFAULT_PUBLIC_DIR, parseBooleanSearchParam, readJsonBody, sendJson, serveStatic, threadNotFound } from './local-http.mjs';
import { resumeCommandForResponse } from './session-opener.mjs';

export function createAsbServer({
  markUnreadThread = null, markReadThread = null, setUnreadSettings = null, pinThread = null,
  listSources = null, updateSource = null, removeSource = null,
  notificationCenter = null,
  publicDir = DEFAULT_PUBLIC_DIR, ...snapshotOptions
} = {}) {
  const snapshot = new DashboardSnapshot({ ...snapshotOptions, notificationCenter });
  const { dashboardForRequest, loadSharedDashboard, invalidateDashboard, performanceSnapshot,
    notificationsForDashboard, openThreadOnce } = snapshot;
  const findThreadForAction = async (threadId) => (await dashboardForRequest()).threads?.find((thread) => thread.id === threadId) || null;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const address = server.address();
    const expectedHost = `127.0.0.1:${address?.port}`;
    if (request.headers.host !== expectedHost) {
      sendJson(response, 403, { error: 'Use the local ASB address.' });
      return;
    }
    const localAction = url.pathname.match(/^\/api\/threads\/([^/]+)\/(mark-unread|mark-read|pin|unpin|move-pin)$/);
    const unreadSettingsRoute = url.pathname === '/api/settings/unread';
    const sourcesRoute = url.pathname === '/api/sources' && Boolean(listSources);
    const removeSourceMatch = removeSource && url.pathname.match(/^\/api\/sources\/([a-z0-9][a-z0-9-]{0,79})\/remove$/);
    const eventRoute = url.pathname === '/api/events';
    const actionRoute = /^\/api\/threads\/[^/]+\/open$/.test(url.pathname) || Boolean(localAction) || unreadSettingsRoute
      || (sourcesRoute && request.method !== 'GET') || Boolean(removeSourceMatch);
    const staticRoutes = ['/', '/switchboard.html', '/switchboard.js', '/switchboard.css', '/icon.svg'];
    const readRoute = url.pathname === '/api/dashboard' || eventRoute || (sourcesRoute && request.method === 'GET') || staticRoutes.includes(url.pathname);
    if (!readRoute && !actionRoute) {
      sendJson(response, 404, { error: 'Route is not available in ASB.' });
      return;
    }
    if ((readRoute && request.method !== 'GET') || (actionRoute && request.method !== 'POST')) {
      response.writeHead(405, { allow: actionRoute ? 'POST' : 'GET' });
      response.end('Method not allowed');
      return;
    }
    if (actionRoute && (request.headers.origin !== `http://${expectedHost}`
      || !['same-origin', undefined].includes(request.headers['sec-fetch-site']))) {
      sendJson(response, 403, { error: 'Use session actions from ASB.' });
      return;
    }
    if (eventRoute && ((request.headers.origin && request.headers.origin !== `http://${expectedHost}`)
      || !['same-origin', 'none', undefined].includes(request.headers['sec-fetch-site']))) {
      sendJson(response, 403, { error: 'Use the local ASB event stream.' });
      return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (sourcesRoute || removeSourceMatch) {
      try {
        if (actionRoute) {
          const body = await readJsonBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).join(',') !== (removeSourceMatch ? '' : 'source')) {
            sendJson(response, 400, { error: 'Invalid app source action.' });
            return;
          }
          if (removeSourceMatch) await removeSource(removeSourceMatch[1]);
          else await updateSource(body.source);
          invalidateDashboard('asb-sources');
        }
        const dashboard = await dashboardForRequest({ force: actionRoute });
        sendJson(response, 200, { ...(actionRoute ? { changed: true } : {}), ...await listSources(dashboard) });
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.statusCode === 400 ? error.message : 'Cannot update ASB app sources.' });
      }
      return;
    }
    if (unreadSettingsRoute) {
      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'persistentUnread'
          || typeof body.persistentUnread !== 'boolean') {
          sendJson(response, 400, { error: 'Invalid ASB unread setting.' });
          return;
        }
        const dashboard = snapshot.cachedDashboard() || await loadSharedDashboard();
        await setUnreadSettings(body.persistentUnread, dashboard);
        invalidateDashboard('asb-unread-settings');
        sendJson(response, 200, { changed: true, persistentUnread: body.persistentUnread, dashboard });
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: 'Cannot update the ASB unread setting.' });
      }
      return;
    }
    if (localAction) {
      try {
        const body = await readJsonBody(request);
        const action = localAction[2];
        const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : 'invalid';
        const validMove = fields === 'direction' && ['up', 'down'].includes(body.direction)
          || fields === 'placement,targetId' && typeof body.targetId === 'string' && ['before', 'after'].includes(body.placement);
        if ((action === 'move-pin' && !validMove) || (action !== 'move-pin' && fields !== '')) {
          sendJson(response, 400, { error: 'Invalid ASB session action.' });
          return;
        }
        const thread = await findThreadForAction(decodeURIComponent(localAction[1]));
        if (!thread) { threadNotFound(response); return; }
        if (action === 'mark-unread') {
          await markUnreadThread(thread);
          invalidateDashboard('asb-unread', { hard: false, dirty: false });
          sendJson(response, 200, { marked: true, threadId: thread.id, thread });
        } else if (action === 'mark-read') {
          await markReadThread(thread);
          invalidateDashboard('asb-read', { hard: false, dirty: false });
          sendJson(response, 200, { changed: true, threadId: thread.id, thread });
        } else {
          if (body.targetId && !await findThreadForAction(body.targetId)) { threadNotFound(response); return; }
          const pinnedOrder = await pinThread(thread, action, body);
          invalidateDashboard('asb-pins');
          sendJson(response, 200, { changed: true, threadId: thread.id, pinnedOrder });
        }
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: 'Cannot update this ASB session.' });
      }
      return;
    }
    if (url.pathname === '/') request.url = '/switchboard.html';
    if (url.pathname === '/api/events') { snapshot.serveEvents(request, response); return; }

    if (url.pathname === '/api/dashboard') {
      try {
        const force = parseBooleanSearchParam(url.searchParams.get('force'))
          || parseBooleanSearchParam(url.searchParams.get('refresh'));
        const dashboard = await dashboardForRequest({ force });
        if (notificationCenter) {
          dashboard.notifications = await notificationsForDashboard(dashboard, { force });
          dashboard.summary = {
            ...dashboard.summary,
            inboxCount: dashboard.notifications.summary.activeCount,
          };
        }
        dashboard.performance = performanceSnapshot();
        sendJson(response, 200, dashboard);
      } catch (error) {
        sendJson(response, 500, {
          error: 'Failed to load dashboard data',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const openThreadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/open$/);
    if (openThreadMatch) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end('Method not allowed');
        return;
      }

      try {
        const body = await readJsonBody(request);
        const threadId = decodeURIComponent(openThreadMatch[1]);
        const thread = await findThreadForAction(threadId);

        if (!thread) {
          threadNotFound(response);
          return;
        }

        const result = await openThreadOnce(thread);
        const notification = body.markNotificationDone && body.notificationId && notificationCenter
          ? await notificationCenter.updateNotification(String(body.notificationId), { status: 'done' })
          : null;
        if (notification) invalidateDashboard('notification-update');
        sendJson(response, 200, {
          ...result,
          threadId: thread.id,
          provider: thread.provider || 'codex',
          appDeepLink: thread.appDeepLink,
          resumeCommand: resumeCommandForResponse(thread),
          ...(notification ? { notification } : {}),
        });
      } catch (error) {
        sendJson(response, 500, {
          error: 'Failed to open thread',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    await serveStatic(request, response, publicDir);
  });
  snapshot.attach(server);
  return server;
}
