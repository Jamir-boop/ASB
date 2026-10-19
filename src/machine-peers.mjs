// The machine group's session export, the merge of peer rows, the pinned TLS client, and the poller of each member.
import { createHash } from 'node:crypto';
import https from 'node:https';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { sessionMessageKeys, sortSessionMessages, switchboardRefreshInterval } from './switchboard.mjs';
import { SESSION_MESSAGE_WINDOW_MS } from './codex-data.mjs';

const gunzipAsync = promisify(gunzip);
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;
export const OFFLINE_KEEP_MS = 600_000;
const KIND_ORDER = ['lan', 'zerotier', 'tailscale'];
const BACKOFF_MS = [5_000, 10_000, 30_000];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// The row fields that go to group members (plan 9.2), with their types.
const STRING = (value) => typeof value === 'string' && value.length <= 4096;
const NUMBER = (value) => typeof value === 'number' && Number.isFinite(value);
const BOOLEAN = (value) => typeof value === 'boolean';
export const EXPORT_FIELDS = {
  id: STRING, externalId: STRING, provider: STRING, providerLabel: STRING, surface: (value) => ['app', 'cli'].includes(value),
  title: STRING, cwd: STRING, projectName: STRING, archived: BOOLEAN, updatedAtMs: NUMBER, subagentCount: NUMBER,
  state: (value) => ['working', 'waiting', 'idle', 'unknown'].includes(value), reason: STRING, workingSinceMs: NUMBER,
  nativeUnread: (value) => value === null || BOOLEAN(value), readStatus: STRING, questionPending: BOOLEAN, actionRequired: BOOLEAN,
  lastOutcome: STRING, failedAtMs: NUMBER, completionAtMs: NUMBER, limitResetsAtMs: NUMBER,
  sourceId: STRING, sourceLabel: STRING, sourceColor: (value) => value === null || STRING(value), sourceShowMarker: BOOLEAN, sourceCount: NUMBER,
};
const pick = (row) => Object.fromEntries(Object.keys(EXPORT_FIELDS).filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));

// Plan 9.2: the local rows only, with their native message keys and the incoming messages from senders on other machines.
export function exportLocalSessions(dashboard, self, nowMs = Date.now()) {
  const rows = (dashboard.threads || []).filter((row) => !row.remote && !row.remoteCache).map(pick);
  const ids = new Set(rows.map((row) => row.id));
  const { keysByRow, unresolved } = sessionMessageKeys(dashboard);
  const keys = Object.fromEntries([...keysByRow].filter(([id]) => ids.has(id)));
  const incoming = unresolved.filter((message) => ids.has(message.to)).map(({ to, from, atMs }) => ({ to, from, atMs }));
  return { api: 1, machineId: self.machineId, name: self.name, generatedAtMs: nowMs,
    refreshIntervalMs: switchboardRefreshInterval(dashboard), rows, keys, incoming };
}

// The JSON body and its tag. The tag leaves out the time, so an unchanged list gives 304.
export function exportBody(exported) {
  const { generatedAtMs: _, ...content } = exported;
  return { body: JSON.stringify(exported), etag: `"${sha256(JSON.stringify(content))}"` };
}

// A reply from a member: only valid rows and the whitelisted fields.
export function validExport(value, member) {
  if (!value || typeof value !== 'object' || value.api !== 1 || value.machineId !== member.machineId || !Array.isArray(value.rows)
    || value.rows.length > 5000 || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys) || !Array.isArray(value.incoming)) return null;
  const rows = value.rows.filter((row) => row && typeof row === 'object' && typeof row.id === 'string' && row.id && row.id.length <= 512
    && Object.keys(EXPORT_FIELDS).every((key) => row[key] === undefined || EXPORT_FIELDS[key](row[key]))).map(pick);
  const ids = new Set(rows.map((row) => row.id));
  const keys = Object.fromEntries(Object.entries(value.keys).filter(([id, list]) => ids.has(id) && Array.isArray(list))
    .map(([id, list]) => [id, list.filter((key) => typeof key === 'string' && key && key.length <= 300).slice(0, 64)]));
  const incoming = value.incoming.filter((message) => message && ids.has(message.to) && typeof message.from === 'string'
    && message.from && message.from.length <= 300 && NUMBER(message.atMs)).slice(0, 500)
    .map(({ to, from, atMs }) => ({ to, from, atMs }));
  return { refreshIntervalMs: value.refreshIntervalMs === 2_000 ? 2_000 : 5_000, rows, keys, incoming };
}

// Plan 13.4.3: add the rows of each member to this engine's dashboard, in place.
export function mergePeerRows(dashboard, peerStates, self, nowMs = Date.now()) {
  const local = sessionMessageKeys(dashboard);
  const peerRows = [];
  const peerKeys = [];
  const peerIncoming = [];
  for (const peer of peerStates) {
    const { member, sessions } = peer;
    if (!sessions || !peer.lastOkAtMs || member.machineId === self.machineId) continue;
    const offline = !peer.online;
    if (offline && nowMs - peer.lastOkAtMs >= OFFLINE_KEEP_MS) continue;
    const rowId = (id) => `m:${member.machineId}:${id}`;
    for (const row of sessions.rows) {
      peerRows.push({ ...row, id: rowId(row.id), machineId: member.machineId, machineName: member.name, remote: true,
        globalId: `${member.machineId}:${row.id}`, remoteCache: false, canOpen: false, appDeepLink: '',
        ...(offline ? { state: 'unknown', reason: `${member.name} is not reachable.`, workingSinceMs: 0 } : {}) });
    }
    for (const [id, keys] of Object.entries(sessions.keys)) peerKeys.push([rowId(id), keys]);
    for (const message of sessions.incoming) peerIncoming.push({ ...message, to: rowId(message.to) });
  }
  // A remote-cache row is the claude.ai view of a session that a member runs: the member's row replaces it.
  const peerBridge = new Map(peerKeys.flatMap(([rowId, keys]) => keys.filter((key) => key.startsWith('bridge:')).map((key) => [key, rowId])));
  const replaced = new Map();
  for (const row of dashboard.threads) {
    const key = row.remoteCache ? (local.keysByRow.get(row.id) || []).find((item) => peerBridge.has(item)) : undefined;
    if (key) replaced.set(row.id, peerBridge.get(key));
  }
  dashboard.threads = [...dashboard.threads.filter((row) => !replaced.has(row.id)), ...peerRows];
  const rowIds = new Set(dashboard.threads.map((row) => row.id));
  const lookup = new Map(local.ambiguous.map((key) => [key, null]));
  const add = (key, rowId) => { if (key) lookup.set(key, lookup.has(key) && lookup.get(key) !== rowId ? null : rowId); };
  for (const [rowId, keys] of local.keysByRow) for (const key of keys) add(key, replaced.get(rowId) || rowId);
  for (const [rowId, keys] of peerKeys) for (const key of keys) add(key, rowId);
  const sinceMs = nowMs - SESSION_MESSAGE_WINDOW_MS;
  const messages = new Map();
  const keep = (from, to, atMs) => {
    if (from && from !== to && rowIds.has(from) && rowIds.has(to) && atMs >= sinceMs && atMs <= nowMs + 5_000) {
      messages.set(`${from}\0${to}\0${atMs}`, { from, to, atMs });
    }
  };
  for (const { from, to, atMs } of dashboard.messages || []) keep(replaced.get(from) || from, replaced.get(to) || to, atMs);
  for (const { from, to, atMs } of [...local.unresolved, ...peerIncoming]) keep(lookup.get(from), replaced.get(to) || to, atMs);
  dashboard.messages = sortSessionMessages([...messages.values()]);
  dashboard.refreshIntervalMs = switchboardRefreshInterval(dashboard);
  return dashboard;
}

// The last address that worked first, then LAN, ZeroTier, and Tailscale.
export function addressOrder(addresses, lastAddress = '') {
  return [...addresses].sort((left, right) => (right.address === lastAddress) - (left.address === lastAddress)
    || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
}

function requestOnce({ address, port, fingerprint, path, method, body, etag, tls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { request.destroy(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => done(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    // key and cert on Linux, pfx and passphrase on Windows; the own fingerprint is not a TLS option.
    const { fingerprint: _own, ...clientCertificate } = tls;
    const request = https.request({ host: address, port, path, method, agent: false, minVersion: 'TLSv1.3', rejectUnauthorized: false,
      ...clientCertificate,
      headers: { 'accept-encoding': 'gzip', ...(etag ? { 'if-none-match': etag } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) done(Object.assign(new Error('too-large'), { code: 'too-large' }));
        else chunks.push(chunk);
      });
      response.on('error', (error) => done(error));
      response.on('end', async () => {
        let data = Buffer.concat(chunks);
        try {
          if (response.headers['content-encoding'] === 'gzip') data = await gunzipAsync(data, { maxOutputLength: MAX_REPLY_BYTES });
        } catch { done(Object.assign(new Error('too-large'), { code: 'too-large' })); return; }
        let value = null;
        if (data.length) try { value = JSON.parse(data.toString('utf8')); } catch { done(new Error('invalid-json')); return; }
        done(null, { status: response.statusCode, etag: response.headers.etag || '', body: value, address });
      });
    });
    request.on('error', (error) => done(error));
    // The request goes out only after the server certificate matches the pin, so no code or header reaches another machine.
    request.on('socket', (socket) => socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      if (!raw || sha256(raw) !== fingerprint) { done(Object.assign(new Error('pin-mismatch'), { code: 'pin-mismatch' })); return; }
      request.end(bytes);
    }));
  });
}

// Tries the member addresses in order; returns { status, etag, body, address } of the first address that answers.
export async function peerRequest({ member, path, method = 'GET', body, etag, tls, timeoutMs = 4000, lastAddress = '' }) {
  let failure = new Error('no-address');
  for (const { address } of addressOrder(member.addresses, lastAddress)) {
    try { return await requestOnce({ address, port: member.port, fingerprint: member.certFingerprint, path, method, body, etag, tls, timeoutMs }); }
    catch (error) { failure = error; }
  }
  throw failure;
}

// One poller per member: sessions, group, and hello, each on its own timer.
export function createPeerPoller({ member, tls, validAddresses, request = peerRequest, onGroup = () => {}, onChange = () => {},
  onRemoved = () => {}, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  const state = { member: { ...member }, online: false, lastOkAtMs: 0, sessions: null, error: '' };
  let lastAddress = '';
  let etag = '';
  let failures = 0;
  let stopped = false;
  const handles = new Set();
  const later = (delayMs, run) => {
    if (stopped) return;
    const handle = timers.setTimeout(() => { handles.delete(handle); if (!stopped) run(); }, delayMs);
    handle?.unref?.();
    handles.add(handle);
  };
  const stop = () => { stopped = true; for (const handle of handles) timers.clearTimeout(handle); handles.clear(); };
  const call = async (path) => {
    const reply = await request({ member: state.member, path, etag: path === '/peer/v1/sessions' ? etag : undefined, tls: await tls(), lastAddress });
    lastAddress = reply.address || lastAddress;
    // The member removed this machine: poll no more.
    if (reply.status === 410) {
      if (!stopped) { stop(); onRemoved(); }
      throw new Error('removed');
    }
    return reply;
  };
  const pollSessions = async () => {
    let changed = false;
    try {
      const reply = await call('/peer/v1/sessions');
      if (reply.status === 200) {
        const sessions = validExport(reply.body, state.member);
        if (!sessions) throw new Error('invalid-reply');
        state.sessions = sessions;
        etag = reply.etag;
        changed = true;
      } else if (reply.status !== 304) throw new Error(`http-${reply.status}`);
      failures = 0;
      state.lastOkAtMs = now();
      state.error = '';
      if (!state.online) { state.online = true; changed = true; }
    } catch (error) {
      failures += 1;
      state.error = error.code || error.message;
      if (failures >= 3 && state.online) { state.online = false; changed = true; }
    }
    if (stopped) return;
    if (changed) onChange();
    later(failures ? BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] : Math.max(2_000, state.sessions?.refreshIntervalMs || 5_000), pollSessions);
  };
  const pollGroup = async () => {
    try {
      const reply = await call('/peer/v1/group');
      if (reply.status === 200 && !stopped) await onGroup(reply.body);
    } catch {}
    later(30_000, pollGroup);
  };
  const pollHello = async () => {
    try {
      const reply = await call('/peer/v1/hello');
      const value = reply.body;
      // The addresses stay in memory only; the next group merge keeps the saved ones.
      if (reply.status === 200 && value?.machineId === state.member.machineId && validAddresses(value.addresses) && Number.isInteger(value.port)) {
        state.member.addresses = value.addresses;
        state.member.port = value.port;
      }
    } catch {}
    later(60_000, pollHello);
  };
  return {
    state,
    start: () => { pollHello(); pollSessions(); later(30_000, pollGroup); },
    stop,
  };
}
