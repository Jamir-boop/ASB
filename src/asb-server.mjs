import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DashboardSnapshot } from './dashboard-snapshot.mjs';
import { DEFAULT_PUBLIC_DIR, parseBooleanSearchParam, readJsonBody, sendJson, serveStatic, threadNotFound } from './local-http.mjs';

const PALETTE_KEYS = ['background', 'text', 'accent', 'muted', 'divider', 'success', 'warning'];

// Returns the palette with lowercase colors in a fixed key order, or null when the value is not exactly a palette.
function validPalette(value) {
  const object = (item) => item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'colors,mode' || !['gnome', 'custom'].includes(value.mode)
    || !object(value.colors) || Object.keys(value.colors).sort().join(',') !== [...PALETTE_KEYS].sort().join(',')
    || !Object.values(value.colors).every((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) return null;
  return { mode: value.mode, colors: Object.fromEntries(PALETTE_KEYS.map((key) => [key, value.colors[key].toLowerCase()])) };
}

function readPalette(palettePath) {
  if (!palettePath) return null;
  try {
    const palette = validPalette(JSON.parse(readFileSync(palettePath, 'utf8')));
    if (palette) return palette;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
  }
  console.warn('ASB could not read its saved palette. The phone gets the palette at the next window theme apply.');
  return null;
}

export function createAsbServer({
  markUnreadThread = null, markReadThread = null, setUnreadSettings = null, pinThread = null, discardThread = null, drawerThread = null,
  listSources = null, updateSource = null, removeSource = null, sourceToken = '', phoneGateway = null, serviceMode = false,
  palettePath = '', publicDir = DEFAULT_PUBLIC_DIR, ...snapshotOptions
} = {}) {
  const snapshot = new DashboardSnapshot({ serviceMode, ...snapshotOptions });
  const expectedSourceToken = Buffer.from(String(sourceToken || ''));
  const sourceTokenAllowed = (request) => {
    const given = Buffer.from(String(request.headers['x-asb-source-token'] || ''));
    return !expectedSourceToken.length || (given.length === expectedSourceToken.length && timingSafeEqual(given, expectedSourceToken));
  };
  let dashboardNotModified = 0;
  let palette = readPalette(palettePath);
  let paletteWrite = Promise.resolve();
  // Saves run one at a time; the memory value changes only after the file has the new value.
  const savePalette = (value) => paletteWrite = paletteWrite.catch(() => {}).then(async () => {
    const content = JSON.stringify(value);
    if (content === JSON.stringify(palette)) return false;
    if (palettePath) {
      await mkdir(path.dirname(palettePath), { recursive: true, mode: 0o700 });
      const temporary = `${palettePath}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, palettePath);
    }
    palette = value;
    return true;
  });
  const readBody = async (request) => {
    try { return await readJsonBody(request); }
    catch (error) { if (error instanceof SyntaxError) error.statusCode = 400; throw error; }
  };
  const { dashboardForRequest, loadSharedDashboard, invalidateDashboard, performanceSnapshot,
    openThreadOnce } = snapshot;
  const findThreadForAction = async (threadId, force = false) => (await dashboardForRequest({ force })).threads?.find((thread) => thread.id === threadId) || null;
  const server = http.createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { sendJson(response, 400, { error: 'Invalid request URL.' }); return; }
    const address = server.address();
    const expectedHost = `127.0.0.1:${address?.port}`;
    if (request.headers.host !== expectedHost) {
      sendJson(response, 403, { error: 'Use the local ASB address.' });
      return;
    }
    const localAction = url.pathname.match(/^\/api\/threads\/([^/]+)\/(mark-unread|mark-read|pin|unpin|move-pin|discard-result|keep-result|drawer-in|drawer-out)$/);
    const unreadSettingsRoute = url.pathname === '/api/settings/unread';
    const sourcesRoute = url.pathname === '/api/sources' && Boolean(listSources);
    const removeSourceMatch = removeSource && url.pathname.match(/^\/api\/sources\/([a-z0-9][a-z0-9-]{0,79})\/remove$/);
    const phoneReadRoute = phoneGateway && ['/api/phone', '/api/service'].includes(url.pathname);
    const phoneRevoke = phoneGateway && url.pathname.match(/^\/api\/phone\/devices\/([a-f0-9]{12})\/revoke$/);
    const phoneActionRoute = phoneGateway && (['/api/phone/settings', '/api/phone/pairing'].includes(url.pathname) || Boolean(phoneRevoke));
    const eventRoute = url.pathname === '/api/events';
    const paletteRoute = url.pathname === '/api/palette';
    const actionRoute = /^\/api\/threads\/[^/]+\/open$/.test(url.pathname) || Boolean(localAction) || unreadSettingsRoute
      || (sourcesRoute && request.method !== 'GET') || Boolean(removeSourceMatch) || phoneActionRoute || paletteRoute;
    const staticRoutes = ['/', '/switchboard.html', '/switchboard.js', '/switchboard.css', '/icon.svg'];
    const readApiRoute = url.pathname === '/api/dashboard' || eventRoute || (sourcesRoute && request.method === 'GET') || phoneReadRoute;
    const readRoute = readApiRoute || staticRoutes.includes(url.pathname);
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
    if (readApiRoute && ((request.headers.origin !== undefined && request.headers.origin !== `http://${expectedHost}`)
      || !['same-origin', 'none', undefined].includes(request.headers['sec-fetch-site']))) {
      sendJson(response, 403, { error: 'Use the local ASB API.' });
      return;
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (phoneReadRoute || phoneActionRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use phone access settings from the ASB window.' });
        return;
      }
      try {
        let result;
        if (phoneReadRoute) result = url.pathname === '/api/service' ? { service: Boolean(serviceMode), pid: process.pid } : await phoneGateway.status();
        else {
          const body = await readBody(request);
          const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : 'invalid';
          if (fields !== (url.pathname === '/api/phone/settings' ? 'bindAddresses,enabled,port' : '')) {
            sendJson(response, 400, { error: 'Invalid phone action.' });
            return;
          }
          if (url.pathname === '/api/phone/settings') {
            const addresses = body.bindAddresses;
            if (typeof body.enabled !== 'boolean' || !Array.isArray(addresses) || addresses.length > 8
              || !addresses.every((value) => typeof value === 'string') || new Set(addresses).size !== addresses.length
              || !Number.isInteger(body.port) || body.port < 1024 || body.port > 65535 || body.port === address.port) {
              sendJson(response, 400, { error: 'Invalid phone settings. Choose up to eight different addresses and a port from 1024 to 65535 that is different from the ASB port.' });
              return;
            }
            const listed = (await phoneGateway.status()).addresses;
            if ((body.enabled && !addresses.length) || !addresses.every((value) => listed.some((item) => item.address === value))) {
              sendJson(response, 400, { error: 'Choose a phone address on this PC.' });
              return;
            }
            result = await phoneGateway.updateSettings(body);
          } else result = phoneRevoke ? await phoneGateway.revokeDevice(phoneRevoke[1]) : await phoneGateway.createPairing();
        }
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error instanceof SyntaxError ? 'Invalid phone action.'
          : error.statusCode === 400 ? error.message : 'Cannot update ASB phone access.' });
      }
      return;
    }
    if (paletteRoute) {
      // Local programs can forge Host and Origin; only the ASB window holds the launcher's token.
      if (!sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the palette route from the ASB window.' });
        return;
      }
      try {
        const value = validPalette(await readBody(request));
        if (!value) {
          sendJson(response, 400, { error: 'Invalid ASB palette.' });
          return;
        }
        const changed = await savePalette(value);
        if (changed) invalidateDashboard('asb-palette', { hard: false, dirty: false });
        sendJson(response, 200, { changed });
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error instanceof SyntaxError ? 'Invalid ASB palette.' : 'Cannot save the ASB palette.' });
      }
      return;
    }
    if (sourcesRoute || removeSourceMatch) {
      // Local programs can forge Host and Origin; only the ASB window holds the launcher's token.
      if (actionRoute && !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use app source actions from the ASB window.' });
        return;
      }
      try {
        if (actionRoute) {
          const body = await readBody(request);
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
        sendJson(response, error.statusCode || 500, { error: error instanceof SyntaxError ? 'Invalid app source action.'
          : error.statusCode === 400 ? error.message : 'Cannot update ASB app sources.' });
      }
      return;
    }
    if (unreadSettingsRoute) {
      try {
        const body = await readBody(request);
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
        const body = await readBody(request);
        const action = localAction[2];
        const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : 'invalid';
        const validMove = fields === 'direction' && ['up', 'down'].includes(body.direction)
          || fields === 'placement,targetId' && typeof body.targetId === 'string' && ['before', 'after'].includes(body.placement);
        let threadId = null;
        try { threadId = decodeURIComponent(localAction[1]); } catch {}
        if (threadId === null || (action === 'move-pin' && !validMove) || (action !== 'move-pin' && fields !== '')) {
          sendJson(response, 400, { error: 'Invalid ASB session action.' });
          return;
        }
        const discardAction = action === 'discard-result' || action === 'keep-result';
        const thread = await findThreadForAction(threadId, action === 'discard-result');
        if (!thread) { threadNotFound(response); return; }
        if (action === 'mark-unread') {
          await markUnreadThread(thread);
          invalidateDashboard('asb-unread', { hard: false, dirty: false });
          sendJson(response, 200, { marked: true, threadId: thread.id, thread });
        } else if (action === 'mark-read') {
          await markReadThread(thread);
          invalidateDashboard('asb-read', { hard: false, dirty: false });
          sendJson(response, 200, { changed: true, threadId: thread.id, thread });
        } else if (discardAction) {
          await discardThread(thread, action === 'discard-result');
          invalidateDashboard('asb-discard', { hard: false, dirty: false });
          sendJson(response, 200, { changed: true, threadId: thread.id, thread });
        } else if (action === 'drawer-in' || action === 'drawer-out') {
          await drawerThread(thread, action === 'drawer-in');
          invalidateDashboard('asb-drawer', { hard: false, dirty: false });
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
        const dashboard = await dashboardForRequest({ force: parseBooleanSearchParam(url.searchParams.get('force')) });
        // The rows can change in place between scans, so the tag comes from the content of each reply.
        const { generatedAtMs, performance: _, ...rows } = dashboard;
        const content = { ...rows, palette };
        const list = JSON.stringify(content);
        const etag = `"${createHash('sha256').update(list).digest('base64url')}"`;
        const headers = { etag, 'cache-control': 'no-store' };
        if (request.headers['if-none-match'] === etag) {
          dashboardNotModified += 1;
          response.writeHead(304, headers);
          response.end();
          return;
        }
        const performance = performanceSnapshot();
        performance.dashboard.notModified = dashboardNotModified;
        const rest = JSON.stringify({ generatedAtMs, performance });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers });
        // The list is serialized one time for the tag and the body; `summary` keeps it from being empty.
        response.end(`${rest.slice(0, -1)},${list.slice(1)}`);
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
      try {
        await readBody(request);
        const thread = await findThreadForAction(decodeURIComponent(openThreadMatch[1]));
        if (!thread) { threadNotFound(response); return; }
        const result = await openThreadOnce(thread);
        // A scan can replace the snapshot while the open command runs; the next read must show the acknowledgment.
        if (result.opened) invalidateDashboard('asb-open', { hard: false });
        sendJson(response, 200, {
          opened: result.opened, method: result.method,
          threadId: thread.id, provider: thread.provider || 'codex', appDeepLink: thread.appDeepLink,
        });
      } catch (error) {
        if (error instanceof SyntaxError && error.statusCode === 400) sendJson(response, 400, { error: 'Invalid ASB session action.' });
        else sendJson(response, 500, { error: 'Failed to open thread', detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await serveStatic(request, response, publicDir);
  });
  snapshot.attach(server);
  return server;
}
