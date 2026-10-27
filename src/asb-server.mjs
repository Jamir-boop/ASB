import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DashboardSnapshot } from './dashboard-snapshot.mjs';
import { DEFAULT_PUBLIC_DIR, exactKeys, parseBooleanSearchParam, readJsonBody, sendJson, serveStatic, threadNotFound } from './local-http.mjs';

const PALETTE_KEYS = ['background', 'text', 'accent', 'muted', 'divider', 'success', 'warning'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_REVISION = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ACTIVITY_PERIODS = ['24h', '7d', '30d', '90d', 'all'];
// A seat ID of the activity routes: a dashboard row ID or unknown:<machine ID>, with no control character.
const SEAT = /^[^\x00-\x1f\x7f]{1,512}$/;
// The sending task of an exact send: exactly its runtime session ID and its absolute config folder.
const validCaller = (caller) => Boolean(caller) && typeof caller === 'object' && !Array.isArray(caller)
  && Object.keys(caller).sort().join(',') === 'configDir,runtimeSessionId'
  && typeof caller.runtimeSessionId === 'string' && UUID.test(caller.runtimeSessionId)
  && typeof caller.configDir === 'string' && caller.configDir.length <= 4096 && path.isAbsolute(caller.configDir);

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

export function panelSummary(dashboard, machines) {
  const rows = (Array.isArray(dashboard.threads) ? dashboard.threads : []).filter((row) => row.archived !== true);
  const summary = { needs: 0, working: 0, total: rows.length, needsRows: [], workingRows: [],
    machines: machines.map((machine) => ({ name: String(machine.name || ''), self: machine.self === true,
      online: machine.online === true, total: 0, needs: 0, working: 0 })) };
  const text = (value) => typeof value === 'string' && value.length > 0;
  const timestamp = (value) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  for (const row of rows) {
    const index = machines.findIndex((machine) => machine.machineId === row.machineId);
    const machine = index >= 0 ? index : row.remote !== true ? 0 : -1;
    const needs = row.pending === true, working = row.state === 'working';
    if (needs) summary.needs += 1;
    if (working) summary.working += 1;
    if (summary.machines[machine]) {
      summary.machines[machine].total += 1;
      if (needs) summary.machines[machine].needs += 1;
      if (working) summary.machines[machine].working += 1;
    }
    const item = { id: String(row.id), title: text(row.title) ? row.title : text(row.projectName) ? row.projectName : 'Untitled session',
      app: text(row.sourceLabel) ? row.sourceLabel : text(row.providerLabel) ? row.providerLabel : '',
      provider: text(row.provider) ? row.provider : 'codex' };
    const atMs = timestamp(row.updatedAtMs);
    if (needs) summary.needsRows.push({ ...item,
      kind: row.pendingSource === 'user-action' ? 'approval' : row.pendingSource === 'user-question' ? 'question' : row.alert === true ? 'failed' : 'done',
      machine, atMs, canOpen: row.canOpen === true });
    if (working) summary.workingRows.push({ ...item, machine,
      atMs: Number.isFinite(row.workingSinceMs) && row.workingSinceMs > 0 ? Math.floor(row.workingSinceMs) : atMs,
      canOpen: row.canOpen === true });
  }
  const newest = (a, b) => b.atMs - a.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  summary.needsRows = summary.needsRows.sort(newest).slice(0, 6);
  summary.workingRows = summary.workingRows.sort(newest).slice(0, 6);
  return summary;
}

export function createAsbServer({
  markUnreadThread = null, markReadThread = null, setUnreadSettings = null, pinThread = null, discardThread = null, drawerThread = null, muteThread = null,
  listSources = null, updateSource = null, removeSource = null, sourceToken = '', phoneGateway = null, machineGroup = null, serviceMode = false, onStop = null,
  machineRelay = null, bridgeCoverage = null, activityMessages = null, activityUsage = null, panelMachines = null, readSources = async () => [], resolveSession = null, resolveBound = null, listReferences = null, sendMember = null,
  appVersion = '', rootDir = '', sourcesPath = '', maxUsageImportBytes = 64 * 1024 * 1024, readSourcesRevision = async () => null,
  palettePath = '', publicDir = DEFAULT_PUBLIC_DIR, now = Date.now, ...snapshotOptions
} = {}) {
  const snapshot = new DashboardSnapshot({ serviceMode, now, ...snapshotOptions });
  const expectedSourceToken = Buffer.from(String(sourceToken || ''));
  const sourceTokenAllowed = (request) => {
    const given = Buffer.from(String(request.headers['x-asb-source-token'] || ''));
    return !expectedSourceToken.length || (given.length === expectedSourceToken.length && timingSafeEqual(given, expectedSourceToken));
  };
  let dashboardNotModified = 0;
  let savedList = null;
  const uiClients = new Map();
  const closedUiClients = new Map();
  const expireUiClients = () => {
    for (const [id, client] of uiClients) if (now() - client.reportedAtMs >= 45_000) uiClients.delete(id);
    for (const [id, closedAtMs] of closedUiClients) if (now() - closedAtMs >= 45_000) closedUiClients.delete(id);
  };
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
  const readBody = async (request, limit) => {
    try { return await readJsonBody(request, limit); }
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
    const localAction = url.pathname.match(/^\/api\/threads\/([^/]+)\/(mark-unread|mark-read|pin|unpin|move-pin|discard-result|keep-result|drawer-in|drawer-out|mute|unmute)$/);
    const unreadSettingsRoute = url.pathname === '/api/settings/unread';
    const sourcesRoute = url.pathname === '/api/sources' && Boolean(listSources);
    const removeSourceMatch = removeSource && url.pathname.match(/^\/api\/sources\/([a-z0-9][a-z0-9-]{0,79})\/remove$/);
    const agentStatusRoute = url.pathname === '/api/agent/status';
    const agentUiRoute = url.pathname === '/api/agent/ui';
    const phoneReadRoute = phoneGateway && ['/api/phone', '/api/service'].includes(url.pathname);
    const phoneRevoke = phoneGateway && url.pathname.match(/^\/api\/phone\/devices\/([a-f0-9]{12})\/revoke$/);
    const phoneActionRoute = phoneGateway && (['/api/phone/settings', '/api/phone/pairing'].includes(url.pathname) || Boolean(phoneRevoke));
    const groupRoute = machineGroup && url.pathname.match(/^\/api\/group(?:\/(invite|join|remove|leave))?$/);
    const bridgeRoute = bridgeCoverage && url.pathname.match(/^\/api\/bridge(?:\/(install))?$/);
    // The receipt route exists only when the relay can send exact receipts.
    const relayRoute = machineRelay && url.pathname.match(machineRelay.sendReceipt ? /^\/api\/relay\/(homes|remote-peers|send|receipt)$/
      : /^\/api\/relay\/(homes|remote-peers|send)$/)?.[1];
    // The activity reads (contract 2); each exists only when the engine gives its service.
    const activityRoute = url.pathname.match(/^\/api\/activity\/(messages|thread|usage)$/)?.[1];
    const activityReady = activityRoute === 'usage' ? Boolean(activityUsage) : Boolean(activityRoute) && Boolean(activityMessages);
    const panelRoute = Boolean(panelMachines) && url.pathname === '/api/panel';
    const usageExportRoute = typeof activityUsage?.exportAll === 'function' && url.pathname === '/api/usage/export';
    const usageImportRoute = typeof activityUsage?.importAll === 'function' && url.pathname === '/api/usage/import';
    const backupReady = typeof activityUsage?.backup?.status === 'function';
    const usageBackupRoute = backupReady && url.pathname === '/api/usage/backup';
    const usageBackupAction = backupReady ? url.pathname.match(/^\/api\/usage\/backup\/(settings|now)$/)?.[1] : undefined;
    const eventRoute = url.pathname === '/api/events';
    const paletteRoute = url.pathname === '/api/palette';
    const engineStopRoute = Boolean(onStop) && url.pathname === '/api/engine/stop';
    const showWindowRoute = url.pathname === '/api/engine/show-window';
    const resolveRoute = Boolean(resolveSession) && url.pathname === '/api/agent/resolve-session';
    const resolveBoundRoute = Boolean(resolveBound) && url.pathname === '/api/agent/resolve-bound';
    const sendMemberRoute = Boolean(sendMember) && url.pathname === '/api/agent/send-member';
    const listReferencesRoute = Boolean(listReferences) && url.pathname === '/api/agent/list-references';
    const actionRoute = /^\/api\/threads\/[^/]+\/open$/.test(url.pathname) || Boolean(localAction) || unreadSettingsRoute
      || (sourcesRoute && request.method !== 'GET') || Boolean(removeSourceMatch) || phoneActionRoute || paletteRoute || agentUiRoute || engineStopRoute || showWindowRoute || resolveRoute || resolveBoundRoute || listReferencesRoute || sendMemberRoute
      || Boolean(groupRoute?.[1]) || Boolean(bridgeRoute?.[1]) || ['send', 'receipt'].includes(relayRoute) || usageImportRoute || Boolean(usageBackupAction);
    const staticRoutes = ['/', '/switchboard.html', '/switchboard.js', '/switchboard.css', '/icon.svg'];
    const readApiRoute = url.pathname === '/api/dashboard' || panelRoute || eventRoute || (sourcesRoute && request.method === 'GET') || phoneReadRoute || agentStatusRoute
      || Boolean(groupRoute && !groupRoute[1]) || Boolean(bridgeRoute && !bridgeRoute[1]) || ['homes', 'remote-peers'].includes(relayRoute) || activityReady || usageExportRoute || usageBackupRoute;
    const readRoute = readApiRoute || staticRoutes.includes(url.pathname);
    if (usageBackupRoute || usageBackupAction) response.setHeader('Cache-Control', 'no-store');
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
    // The ASB top-bar extension (gnome-shell/): three counts, the newest rows, and the machines.
    if (panelRoute) {
      response.setHeader('Cache-Control', 'no-store');
      try {
        const [dashboard, machines] = await Promise.all([loadSharedDashboard(), panelMachines()]);
        sendJson(response, 200, { ...panelSummary(dashboard, machines), accent: palette?.colors.accent || '' });
      } catch { sendJson(response, 500, { error: 'ASB cannot read the sessions.' }); }
      return;
    }
    if (activityReady) {
      response.setHeader('Cache-Control', 'no-store');
      const params = url.searchParams;
      const period = params.get('period') ?? (activityRoute === 'usage' ? '30d' : '7d');
      if (!(activityRoute === 'usage' ? ACTIVITY_PERIODS : ACTIVITY_PERIODS.slice(0, 3)).includes(period)) {
        sendJson(response, 400, { error: 'Invalid period.' });
        return;
      }
      let query = null;
      if (activityRoute === 'thread') {
        const names = [...new Set(params.keys())].filter((name) => name !== 'period').sort().join(',');
        const seat = (name) => params.getAll(name).length === 1 && SEAT.test(params.get(name));
        query = names === 'seat' && seat('seat') ? { seat: params.get('seat') } : names === 'a,b' && seat('a') && seat('b')
          ? { a: params.get('a'), b: params.get('b') } : null;
        if (!query) {
          sendJson(response, 400, { error: 'Invalid session.' });
          return;
        }
      }
      // Read-only: the bridge databases, the cached rows, and the member replies.
      try {
        sendJson(response, 200, activityRoute === 'usage' ? await activityUsage.report(period)
          : activityRoute === 'thread' ? await activityMessages.thread(period, query) : await activityMessages.report(period));
      } catch { sendJson(response, 500, { error: 'Cannot read the ASB activity.' }); }
      return;
    }
    // The usage ledger file of `asb usage export` and `asb usage import`.
    if (usageExportRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to export usage.' });
        return;
      }
      try { sendJson(response, 200, await activityUsage.exportAll()); }
      catch (error) { sendJson(response, error.statusCode === 409 ? 409 : 500, { error: error.statusCode === 409 ? error.message : 'ASB cannot export the usage.' }); }
      return;
    }
    if (usageImportRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to import usage.' });
        return;
      }
      let body;
      try { body = await readBody(request, maxUsageImportBytes); } catch (error) {
        sendJson(response, error.statusCode === 413 ? 413 : 400, { error: error.statusCode === 413 ? 'The file is too large for an ASB usage export.' : 'This file is not an ASB usage export.' });
        return;
      }
      try { sendJson(response, 200, await activityUsage.importAll(body)); }
      catch (error) { sendJson(response, error.statusCode === 400 ? 400 : 500, { error: error.statusCode === 400 ? 'This file is not an ASB usage export.' : 'ASB cannot import the usage.' }); }
      return;
    }
    // The daily usage backups (src/usage-backup.mjs).
    if (usageBackupRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to read usage backups.' });
        return;
      }
      try { sendJson(response, 200, await activityUsage.backup.status()); }
      catch { sendJson(response, 500, { error: 'ASB cannot read the usage backups.' }); }
      return;
    }
    if (usageBackupAction === 'settings') {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to change usage backups.' });
        return;
      }
      let body;
      try { body = await readBody(request, 8 * 1024); } catch {
        sendJson(response, 400, { error: 'Invalid backup settings.' });
        return;
      }
      try { sendJson(response, 200, await activityUsage.backup.saveSettings(body)); }
      catch (error) { sendJson(response, error.statusCode === 400 ? 400 : 500, { error: error.statusCode === 400 ? error.message : 'ASB cannot save the backup settings.' }); }
      return;
    }
    if (usageBackupAction === 'now') {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to back up usage.' });
        return;
      }
      let body;
      try { body = await readBody(request, 1024); } catch { body = null; }
      if (!exactKeys(body, [])) {
        sendJson(response, 400, { error: 'Invalid backup request.' });
        return;
      }
      try { sendJson(response, 200, await activityUsage.backup.runNow()); }
      catch (error) {
        const known = [409, 500].includes(error.statusCode);
        sendJson(response, known ? error.statusCode : 500, { error: known ? error.message : 'ASB cannot make the usage backup.' });
      }
      return;
    }
    if (engineStopRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to stop ASB.' });
        return;
      }
      let body;
      try { body = await readBody(request); } catch (error) { sendJson(response, error.statusCode || 500, { error: 'Invalid stop request.' }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
        sendJson(response, 400, { error: 'Invalid stop request.' });
        return;
      }
      // The reply goes out before the engine closes its connections.
      response.once('close', () => onStop());
      sendJson(response, 200, { stopping: true });
      return;
    }
    if (showWindowRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to open an ASB window.' });
        return;
      }
      let body;
      try { body = await readBody(request, 1024); } catch { body = null; }
      if (!exactKeys(body, ['window']) || !['messages', 'usage'].includes(body.window)) {
        sendJson(response, 400, { error: 'Invalid window request.' });
        return;
      }
      expireUiClients();
      if (!uiClients.size) {
        sendJson(response, 200, { shown: false });
        return;
      }
      // Each report re-inserts its client, so the last key is the board that reported last.
      snapshot.broadcastEvent('show-window', { window: body.window, clientId: [...uiClients.keys()].at(-1) });
      sendJson(response, 200, { shown: true });
      return;
    }
    if (bridgeRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!bridgeRoute[1]) {
        try { sendJson(response, 200, await bridgeCoverage.status({ force: url.searchParams.get('refresh') === '1' })); }
        catch { sendJson(response, 500, { error: 'ASB cannot check ASB Bridge.' }); }
        return;
      }
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token to install ASB Bridge.' });
        return;
      }
      let body;
      try { body = await readBody(request, 4 * 1024); } catch (error) { sendJson(response, error.statusCode === 413 ? 413 : 400, { error: 'Invalid install request.' }); return; }
      try {
        const result = await bridgeCoverage.install(body);
        sendJson(response, result.status, result.body);
      } catch { sendJson(response, 500, { error: 'ASB cannot install ASB Bridge.' }); }
      return;
    }
    if (sendMemberRoute) {
      // The delivery budget counts from here, so the body read and the dashboard wait use it too.
      const startedAtMs = now();
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token for agent access.' });
        return;
      }
      let body;
      try { body = await readBody(request, 2 * 1024 * 1024); } catch (error) { sendJson(response, error.statusCode === 413 ? 413 : 400, { error: 'Invalid send request.' }); return; }
      const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : 'invalid';
      if (fields !== 'caller,message,mode,reference,remainingMs' || typeof body.reference !== 'string' || !validCaller(body.caller)
        || !['prompting', 'bypass', 'unknown'].includes(body.mode)
        || !Number.isInteger(body.remainingMs) || body.remainingMs < 0 || body.remainingMs > 20_000) {
        sendJson(response, 400, { error: 'Invalid send request.' });
        return;
      }
      // The cached rows and the caller registry, then the member's resolve and deliver routes; no state write here.
      try {
        const dashboard = await dashboardForRequest();
        sendJson(response, 200, await sendMember({ reference: body.reference, caller: { runtimeSessionId: body.caller.runtimeSessionId,
          configDir: body.caller.configDir }, mode: body.mode, message: body.message, remainingMs: Math.max(0, body.remainingMs - (now() - startedAtMs)) }, dashboard));
      }
      catch { sendJson(response, 500, { error: 'Cannot send the message.' }); }
      return;
    }
    if (resolveRoute || resolveBoundRoute || listReferencesRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token for agent access.' });
        return;
      }
      let body;
      try { body = await readBody(request, 8 * 1024); } catch (error) { sendJson(response, error.statusCode === 413 ? 413 : 400, { error: 'Invalid resolve request.' }); return; }
      if (listReferencesRoute) {
        if (!exactKeys(body, ['caller'], ['hostCheck', 'pipeProof']) || !validCaller(body.caller)
          || (Object.hasOwn(body, 'hostCheck') && body.hostCheck !== true)
          || (Object.hasOwn(body, 'pipeProof') && body.pipeProof !== true)) {
          sendJson(response, 400, { error: 'Invalid resolve request.' });
          return;
        }
        // Reads the cached rows, the registries, and the relay lists; no key file, no socket, no state write.
        try { sendJson(response, 200, await listReferences({ caller: { runtimeSessionId: body.caller.runtimeSessionId, configDir: body.caller.configDir },
          ...(body.pipeProof === true ? { pipeProof: true } : {}), ...(body.hostCheck === true ? { hostCheck: true } : {}) }, await dashboardForRequest())); }
        catch { sendJson(response, 500, { error: 'Cannot resolve the session reference.' }); }
        return;
      }
      if (resolveBoundRoute) {
        const caller = body?.caller;
        if (!exactKeys(body, ['caller', 'msgId', 'reference', 'remainingMs'], ['hostCheck', 'pipeProof'])
          || (Object.hasOwn(body, 'pipeProof') && body.pipeProof !== true) || (Object.hasOwn(body, 'hostCheck') && body.hostCheck !== true)
          || typeof body.reference !== 'string' || !validCaller(caller)
          || typeof body.msgId !== 'string' || !UUID.test(body.msgId)
          || !Number.isInteger(body.remainingMs) || body.remainingMs < 0 || body.remainingMs > 20_000) {
          sendJson(response, 400, { error: 'Invalid resolve request.' });
          return;
        }
        // Reads the cached rows and the registries; no key file, no socket, no state write.
        try { sendJson(response, 200, await resolveBound({ reference: body.reference, caller: { runtimeSessionId: caller.runtimeSessionId,
          configDir: caller.configDir }, msgId: body.msgId, remainingMs: body.remainingMs, ...(body.pipeProof === true ? { pipeProof: true } : {}),
          ...(body.hostCheck === true ? { hostCheck: true } : {}) },
          await dashboardForRequest())); }
        catch { sendJson(response, 500, { error: 'Cannot resolve the session reference.' }); }
        return;
      }
      if (!exactKeys(body, ['reference'], ['configDir', 'sourceId']) || typeof body.reference !== 'string'
        || (Object.hasOwn(body, 'sourceId') && (typeof body.sourceId !== 'string' || !SOURCE_ID.test(body.sourceId)))
        || (Object.hasOwn(body, 'configDir') && (typeof body.configDir !== 'string' || body.configDir.length > 4096 || !path.isAbsolute(body.configDir)))) {
        sendJson(response, 400, { error: 'Invalid resolve request.' });
        return;
      }
      // Read-only: the cached dashboard, never a forced scan.
      try { sendJson(response, 200, await resolveSession({ reference: body.reference, ...(Object.hasOwn(body, 'sourceId') ? { sourceId: body.sourceId } : {}),
        ...(Object.hasOwn(body, 'configDir') ? { configDir: body.configDir } : {}) }, await dashboardForRequest())); }
      catch { sendJson(response, 500, { error: 'Cannot resolve the session reference.' }); }
      return;
    }
    if (agentStatusRoute || agentUiRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the current ASB source token for agent access.' });
        return;
      }
      try {
        expireUiClients();
        if (agentStatusRoute) {
          sendJson(response, 200, { apiVersion: 1, pid: process.pid, mode: serviceMode ? 'service' : 'desktop',
            appVersion, rootDir, sourcesPath, sourcesRevision: await readSourcesRevision(),
            backendRevision: snapshot.cachedDashboard()?.sourcesRevision ?? null,
            ui: { clients: [...uiClients.values()] } });
        } else {
          const body = await readBody(request);
          const revision = (value) => value === null || typeof value === 'string' && SOURCE_REVISION.test(value);
          const closed = exactKeys(body, ['clientId', 'closed']) && body.closed === true;
          const active = exactKeys(body, ['clientId', 'dirty', 'profilesRevision', 'profilesVisible', 'sourcesRevision'])
            && revision(body.sourcesRevision) && revision(body.profilesRevision)
            && typeof body.profilesVisible === 'boolean' && typeof body.dirty === 'boolean';
          if ((!closed && !active) || typeof body.clientId !== 'string' || !UUID.test(body.clientId)) {
            sendJson(response, 400, { error: 'Invalid ASB UI report.' });
            return;
          }
          const reportedAtMs = now();
          if (closed) {
            uiClients.delete(body.clientId);
            closedUiClients.set(body.clientId, reportedAtMs);
            while (closedUiClients.size > 16) closedUiClients.delete(closedUiClients.keys().next().value);
          } else if (!closedUiClients.has(body.clientId)) {
            // A report still in flight must not reopen a closed window.
            uiClients.delete(body.clientId);
            uiClients.set(body.clientId, { ...body, reportedAtMs });
            while (uiClients.size > 16) uiClients.delete(uiClients.keys().next().value);
          }
          sendJson(response, 200, { received: true, reportedAtMs });
        }
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.statusCode === 400 ? 'Invalid ASB UI report.' : 'Cannot read ASB agent state.' });
      }
      return;
    }
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
    if (groupRoute) {
      response.setHeader('Cache-Control', 'no-store');
      if (!sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use machine group actions from ASB.' });
        return;
      }
      try {
        const action = groupRoute[1];
        let result;
        if (!action) {
          result = await machineGroup.status();
          // Only a group with another machine runs the relay.
          if (machineRelay?.status && result.members.some((member) => !member.isSelf)) result = { ...result, relay: machineRelay.status() };
        } else {
          const body = await readBody(request);
          const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : 'invalid';
          const valid = action === 'join' ? fields === 'link,name' && typeof body.link === 'string' && typeof body.name === 'string'
            : action === 'remove' ? fields === 'machineId' && typeof body.machineId === 'string' : fields === '';
          if (!valid) {
            sendJson(response, 400, { error: 'Invalid machine group action.' });
            return;
          }
          result = action === 'invite' ? await machineGroup.invite() : action === 'join' ? await machineGroup.join(body)
            : action === 'remove' ? await machineGroup.remove(body.machineId) : await machineGroup.leave();
          invalidateDashboard('asb-group', { hard: false });
        }
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof SyntaxError) sendJson(response, 400, { error: 'Invalid machine group action.' });
        else if ([400, 409, 502].includes(error.statusCode)) {
          sendJson(response, error.statusCode, { error: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) });
        } else sendJson(response, error.statusCode === 413 ? 413 : 500, { error: 'Cannot update the ASB machine group.' });
      }
      return;
    }
    if (relayRoute) {
      response.setHeader('Cache-Control', 'no-store');
      // Only the engine's relay process holds the token.
      if (!expectedSourceToken.length || !sourceTokenAllowed(request)) {
        sendJson(response, 403, { error: 'Use the relay routes from the ASB message relay.' });
        return;
      }
      try {
        if (relayRoute === 'homes') sendJson(response, 200, await machineRelay.homes(await readSources()));
        else if (relayRoute === 'remote-peers') sendJson(response, 200, machineRelay.remotePeers());
        else if (relayRoute === 'receipt') {
          const result = await machineRelay.sendReceipt(await readBody(request, 64 * 1024));
          sendJson(response, result.status, result.body);
        } else {
          const result = await machineRelay.send(await readBody(request, 2 * 1024 * 1024));
          sendJson(response, result.status, result.body);
        }
      } catch (error) {
        if (error instanceof SyntaxError || error.statusCode === 400) sendJson(response, 400, { error: 'Invalid relay request.' });
        else sendJson(response, error.statusCode === 413 ? 413 : 500, { error: 'Cannot answer the relay request.' });
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
        let savedRevision;
        if (actionRoute) {
          const body = await readBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).join(',') !== (removeSourceMatch ? '' : 'source')) {
            sendJson(response, 400, { error: 'Invalid app source action.' });
            return;
          }
          const match = request.headers['if-match'];
          if (match !== undefined && (typeof match !== 'string' || !/^"[a-f0-9]{64}"$/.test(match))) {
            sendJson(response, 400, { error: 'If-Match must contain one quoted app source revision.' });
            return;
          }
          const revision = match?.slice(1, -1);
          savedRevision = removeSourceMatch ? await removeSource(removeSourceMatch[1], revision) : await updateSource(body.source, revision);
          invalidateDashboard('asb-sources');
        }
        const dashboard = await dashboardForRequest({ force: actionRoute });
        sendJson(response, 200, { ...(actionRoute ? { changed: true, savedRevision } : {}), ...await listSources(dashboard) });
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error instanceof SyntaxError ? 'Invalid app source action.'
          : [400, 409].includes(error.statusCode) ? error.message : 'Cannot update the ASB profiles.' });
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
        // Discard also takes exactly {"next":true}: it arms the next task of an Idle row.
        const nextDiscard = action === 'discard-result' && fields === 'next' && body.next === true;
        let threadId = null;
        try { threadId = decodeURIComponent(localAction[1]); } catch {}
        if (threadId === null || (action === 'move-pin' && !validMove) || (action !== 'move-pin' && fields !== '' && !nextDiscard)) {
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
          await discardThread(thread, action === 'discard-result', nextDiscard);
          invalidateDashboard('asb-discard', { hard: false, dirty: false });
          sendJson(response, 200, { changed: true, threadId: thread.id, thread });
        } else if (action === 'drawer-in' || action === 'drawer-out') {
          await drawerThread(thread, action === 'drawer-in');
          invalidateDashboard('asb-drawer', { hard: false, dirty: false });
          sendJson(response, 200, { changed: true, threadId: thread.id, thread });
        } else if (action === 'mute' || action === 'unmute') {
          await muteThread(thread, action === 'mute');
          invalidateDashboard('asb-mute', { hard: false, dirty: false });
          sendJson(response, 200, { changed: true, threadId: thread.id, thread });
        } else {
          if (body.targetId && !await findThreadForAction(body.targetId)) { threadNotFound(response); return; }
          const pinnedOrder = await pinThread(thread, action, body);
          invalidateDashboard('asb-pins');
          sendJson(response, 200, { changed: true, threadId: thread.id, pinnedOrder });
        }
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.statusCode === 400 && error.expose ? error.message
          : 'Cannot update this ASB session.' });
      }
      return;
    }
    if (url.pathname === '/') request.url = '/switchboard.html';
    if (url.pathname === '/api/events') { snapshot.serveEvents(request, response); return; }

    if (url.pathname === '/api/dashboard') {
      try {
        const dashboard = await loadSharedDashboard({ force: parseBooleanSearchParam(url.searchParams.get('force')) });
        // The rows can change in place between scans, and each such change moves the snapshot revision. The saved list and its tag are for
        // one dashboard object, one revision, and one palette. The key is read in the same step as the list is made, so a later change
        // always moves it. The weak reference keeps an old dashboard object from living on in the saved list.
        const { generatedAtMs } = dashboard;
        const revision = snapshot.revision();
        if (savedList?.revision !== revision || savedList.palette !== palette || savedList.dashboard.deref() !== dashboard) {
          const { generatedAtMs: _, performance: __, ...rows } = dashboard;
          // `summary` keeps the list from being empty.
          const list = JSON.stringify({ ...rows, summary: { ...(rows.summary || {}) }, palette });
          savedList = { revision, palette, dashboard: new WeakRef(dashboard), list,
            etag: `"${createHash('sha256').update(list).digest('base64url')}"` };
        }
        const { list, etag } = savedList;
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
  server.boardOpen = () => { expireUiClients(); return uiClients.size > 0; };
  // The machine group reads the dashboard for its export and refreshes it after a member's new rows.
  server.dashboardForRequest = dashboardForRequest;
  server.invalidateDashboard = invalidateDashboard;
  return server;
}
