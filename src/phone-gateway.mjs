import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { sendJson } from './local-http.mjs';

export const PHONE_API_VERSION = 1;
export const DEFAULT_PHONE_PORT = 4630;
const execFileAsync = promisify(execFile);
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
const controls = /[\x00-\x1f\x7f-\x9f]/;
const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const defaults = () => ({ schema: 2, enabled: false, bindAddresses: [], port: DEFAULT_PHONE_PORT, devices: [] });
const KINDS = ['lan', 'zerotier', 'tailscale'];
const validPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => left.length === right.length && timingSafeEqual(left, right);

export function phoneSettingsPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'asb', 'phone.json');
}

export function phoneTlsDir(env = process.env) {
  return path.join(path.dirname(phoneSettingsPath(env)), 'phone-tls');
}

function privateIPv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

// 100.64.0.0/10 is also carrier NAT and hotspot space, so it counts only on a Tailscale interface.
function tailscaleIPv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function addressKind(name, address) {
  if (name.startsWith('tailscale') && tailscaleIPv4(address)) return 'tailscale';
  if (!privateIPv4(address)) return '';
  return name.startsWith('zt') ? 'zerotier' : 'lan';
}

export function listPhoneAddresses(interfaces = os.networkInterfaces()) {
  return Object.keys(interfaces).sort().flatMap((name) => (interfaces[name] || [])
    .filter((entry) => ['IPv4', 4].includes(entry.family))
    .map((entry) => ({ address: entry.address, interface: name, kind: addressKind(name, entry.address) }))
    .filter((entry) => entry.kind))
    .sort((left, right) => KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind));
}

export function isAllowedRemote(address, kind = 'lan') {
  if (typeof address !== 'string') return false;
  const ipv4 = address.replace(/^::ffff:/i, '');
  if (kind === 'tailscale') return tailscaleIPv4(ipv4) || privateIPv4(ipv4);
  return address === '::1' || ipv4 === '127.0.0.1' || privateIPv4(ipv4);
}

const validAddresses = (value) => Array.isArray(value) && value.length <= 8
  && value.every((address) => typeof address === 'string') && new Set(value).size === value.length;

function validSettings(value) {
  return (value?.schema === 1 ? fields(value, ['schema', 'enabled', 'bindAddress', 'port', 'devices']) && typeof value.bindAddress === 'string'
    : fields(value, ['schema', 'enabled', 'bindAddresses', 'port', 'devices']) && value.schema === 2 && validAddresses(value.bindAddresses))
    && typeof value.enabled === 'boolean' && validPort(value.port)
    && Array.isArray(value.devices) && value.devices.length <= 8 && value.devices.every((device) =>
      fields(device, ['id', 'name', 'tokenSha256', 'createdAtMs', 'lastSeenAtMs'])
      && typeof device.id === 'string' && /^[a-f0-9]{12}$/.test(device.id)
      && typeof device.name === 'string' && Array.from(device.name).length >= 1 && Array.from(device.name).length <= 64 && !controls.test(device.name)
      && typeof device.tokenSha256 === 'string' && /^[a-f0-9]{64}$/.test(device.tokenSha256)
      && Number.isSafeInteger(device.createdAtMs) && device.createdAtMs >= 0
      && Number.isSafeInteger(device.lastSeenAtMs) && device.lastSeenAtMs >= 0)
    && new Set(value.devices.map((device) => device.id)).size === value.devices.length
    && new Set(value.devices.map((device) => device.tokenSha256)).size === value.devices.length;
}

// A missing header means identity; gzip (or *) with q=0 refuses gzip.
export function acceptsGzip(header) {
  if (typeof header !== 'string') return false;
  const weights = new Map();
  for (const part of header.split(',')) {
    const [coding, ...params] = part.split(';').map((item) => item.trim().toLowerCase());
    const q = params.find((item) => item.startsWith('q='));
    weights.set(coding, q === undefined ? 1 : Number(q.slice(2)));
  }
  return (weights.get('gzip') ?? weights.get('*') ?? 0) > 0;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        chunks.length = 0;
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request aborted.')));
  });
}

export function createPhoneGateway({ localPort, asbVersion, settingsPath = phoneSettingsPath(), tlsDir = phoneTlsDir(),
  now = Date.now, openssl = 'openssl', hostName = os.hostname(), listAddresses = listPhoneAddresses }) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw invalid('Invalid ASB port.');
  let settings = defaults();
  let loaded = false;
  let listeners = [];
  let fingerprint = '';
  let error = '';
  let warning = '';
  let pairing = null;
  let dirty = false;
  let work = Promise.resolve();
  const seenSavedAt = new Map();
  const failures = new Map();
  const sockets = new Set();
  const upstreams = new Set();
  const serialize = (action) => {
    const result = work.catch(() => {}).then(action);
    work = result;
    return result;
  };

  async function load() {
    if (loaded) return;
    let raw;
    try { raw = await fs.readFile(settingsPath, 'utf8'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; loaded = true; return; }
    let value;
    try { value = JSON.parse(raw); } catch {}
    if (!validSettings(value)) {
      await fs.rename(settingsPath, `${settingsPath}.bad`);
      warning = 'ASB moved an invalid phone.json to phone.json.bad.';
    } else {
      await fs.chmod(settingsPath, 0o600);
      // Schema 1 had one address; the next save writes schema 2.
      const { bindAddress, ...rest } = value;
      settings = value.schema === 1 ? { ...rest, schema: 2, bindAddresses: bindAddress ? [bindAddress] : [] } : value;
      for (const device of settings.devices) seenSavedAt.set(device.id, device.lastSeenAtMs);
    }
    loaded = true;
  }

  async function save(next = settings) {
    const temporary = `${settingsPath}.tmp`;
    await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    await fs.rm(temporary, { force: true });
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, settingsPath);
    } finally { await fs.rm(temporary, { force: true }); }
    settings = next;
    dirty = false;
  }

  function activePairing() {
    if (pairing && now() >= pairing.expiresAtMs) pairing = null;
    return pairing;
  }

  const listening = () => listeners.filter((item) => item.server.listening).map(({ kind, address }) => ({ kind, address }));

  function status() {
    return { enabled: settings.enabled, bindAddresses: [...settings.bindAddresses], port: settings.port,
      addresses: listAddresses().map(({ address, interface: name, kind }) => ({ address, interface: name, kind })),
      listening: listening(), running: listening().length > 0, error, warning, fingerprint,
      devices: settings.devices.map(({ id, name, createdAtMs, lastSeenAtMs }) => ({ id, name, createdAtMs, lastSeenAtMs })),
      pairing: { expiresAtMs: activePairing()?.expiresAtMs || 0 } };
  }

  async function closeListener() {
    pairing = null;
    const previous = listeners;
    listeners = [];
    if (!previous.length) return;
    const closed = Promise.all(previous.map(({ server }) => new Promise((resolve) => {
      if (server.listening) server.close(resolve); else resolve();
    })));
    for (const upstream of upstreams) upstream.destroy();
    for (const socket of sockets) socket.destroy();
    await closed;
  }

  async function certificate() {
    await fs.mkdir(tlsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(tlsDir, 0o700);
    const keyPath = path.join(tlsDir, 'key.pem');
    const certPath = path.join(tlsDir, 'cert.pem');
    const present = await Promise.all([keyPath, certPath].map((file) => fs.access(file).then(() => true, (cause) => {
      if (cause.code !== 'ENOENT') throw cause;
      return false;
    })));
    if (!present.every(Boolean)) {
      try {
        await execFileAsync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
          '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', '/CN=ASB phone gateway'], { timeout: 20_000 });
      } catch (cause) {
        await Promise.all([keyPath, certPath].map((file) => fs.rm(file, { force: true })));
        throw cause;
      }
    }
    await Promise.all([keyPath, certPath].map((file) => fs.chmod(file, 0o600)));
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
    return { key, cert };
  }

  async function restart() {
    await closeListener();
    error = '';
    if (!settings.enabled) return;
    const listed = listAddresses();
    const missing = settings.bindAddresses.filter((address) => !listed.some((item) => item.address === address));
    if (missing.length) {
      error = missing.length === 1 ? `The phone address ${missing[0]} is not on this PC now. Choose another address.`
        : `The phone addresses ${missing.join(', ')} are not on this PC now. Choose other addresses.`;
    }
    const selected = listed.filter(({ address }) => settings.bindAddresses.includes(address));
    if (!selected.length) return;
    // https.Server ignores a `secureContext` option, so every listener gets the same key and certificate.
    let options;
    try { options = { ...(await certificate()), minVersion: 'TLSv1.3' }; }
    catch { fingerprint = ''; error = 'ASB cannot create the phone certificate. Install openssl.'; return; }
    const group = selected.map(({ address, kind }) => {
      const server = https.createServer(options, (request, response) => { handle(request, response, group, kind); });
      server.requestTimeout = 15_000;
      server.headersTimeout = 10_000;
      // The app does not retry failed requests, so it must drop idle connections first (it keeps them 30 s).
      server.keepAliveTimeout = 65_000;
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      server.on('error', (cause) => {
        const text = cause.code === 'EADDRINUSE' ? `Port ${settings.port} is in use.` : 'ASB cannot start phone access.';
        if (!error.includes(text)) error = [error, text].filter(Boolean).join(' ');
      });
      return { server, address, kind };
    });
    listeners = group;
    await Promise.all(group.map(({ server, address }) => new Promise((resolve) => {
      server.once('error', resolve);
      server.listen(settings.port, address, resolve);
    })));
    if (!listening().length) await closeListener();
  }

  function throttled(address) {
    const record = failures.get(address);
    return record && record.blockedUntil > now();
  }

  function failed(address) {
    const time = now();
    let record = failures.get(address);
    if (!record) {
      if (failures.size >= 256) failures.delete(failures.keys().next().value);
      record = { times: [], blockedUntil: 0 };
      failures.set(address, record);
    }
    record.times = record.times.filter((at) => at > time - 60_000);
    record.times.push(time);
    if (record.times.length >= 20) record.blockedUntil = time + 60_000;
  }

  function proxy(request, response, target, body, dashboard) {
    const headers = { host: `127.0.0.1:${localPort}` };
    if (request.method === 'POST') Object.assign(headers, { origin: `http://127.0.0.1:${localPort}`, 'content-type': 'application/json' });
    if (request.headers['if-none-match']) headers['if-none-match'] = request.headers['if-none-match'];
    const unavailable = () => {
      if (response.destroyed) return;
      // A started gzip stream can still flush into the reply, so a gzip reply always ends this way.
      if (response.headersSent || response.hasHeader('content-encoding')) response.destroy();
      else sendJson(response, 502, { error: 'ASB is not answering.' });
    };
    const upstream = http.request({ host: '127.0.0.1', port: localPort, method: request.method, path: target, headers }, (reply) => {
      for (const name of ['content-type', 'etag']) if (reply.headers[name] !== undefined) response.setHeader(name, reply.headers[name]);
      response.statusCode = reply.statusCode;
      reply.on('error', unavailable);
      if (dashboard) response.setHeader('vary', 'Accept-Encoding');
      if (dashboard && reply.statusCode === 200 && acceptsGzip(request.headers['accept-encoding'])) {
        response.setHeader('content-encoding', 'gzip');
        const gzip = createGzip();
        gzip.on('error', unavailable);
        response.on('close', () => gzip.destroy());
        reply.pipe(gzip).pipe(response);
      } else reply.pipe(response);
    });
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', unavailable);
    upstream.setTimeout(30_000, () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    upstream.end(body);
  }

  async function handle(request, response, group, kind) {
    const address = request.socket.remoteAddress;
    if (!isAllowedRemote(address, kind)) { request.socket.destroy(); return; }
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    let pairRoute = false;
    const reject = (code, message) => {
      if (code === 401 || pairRoute) failed(address);
      request.resume();
      sendJson(response, code, { error: message });
    };
    if (throttled(address)) { reject(429, 'Too many failed attempts. Wait one minute.'); return; }
    let url;
    try { url = new URL(request.url, 'https://asb'); }
    catch { reject(400, 'Invalid request URL.'); return; }
    pairRoute = url.pathname === '/phone/v1/pair';
    const match = url.pathname.match(/^\/phone\/v1\/threads\/([^/]{1,512})\/(open|mark-read|mark-unread|pin|unpin|move-pin|discard-result|keep-result|drawer-in|drawer-out)$/);
    const hello = url.pathname === '/phone/v1/hello';
    const dashboard = url.pathname === '/phone/v1/dashboard';
    const unread = url.pathname === '/phone/v1/settings/unread';
    if (!pairRoute && !hello && !dashboard && !unread && !match) { reject(404, 'Route is not available.'); return; }
    const method = hello || dashboard ? 'GET' : 'POST';
    if (request.method !== method) { response.setHeader('allow', method); reject(405, 'Method not allowed.'); return; }
    try {
      let device;
      if (!pairRoute) {
        device = await serialize(async () => {
          const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
          if (!token) return null;
          const digest = Buffer.from(hash(token), 'hex');
          const found = settings.devices.find((item) => equal(digest, Buffer.from(item.tokenSha256, 'hex')));
          if (!found) return null;
          found.lastSeenAtMs = now();
          dirty = true;
          if (now() - (seenSavedAt.get(found.id) || 0) >= 600_000) {
            seenSavedAt.set(found.id, now());
            try { await save(); } catch { error = 'ASB cannot save phone settings.'; }
          }
          return found;
        });
        if (!device) { reject(401, 'This phone is not paired with ASB.'); return; }
      }
      if (response.destroyed || group !== listeners) return;
      const body = request.method === 'POST' ? await readBody(request) : null;
      if (pairRoute) {
        let value;
        try { value = JSON.parse(body.toString('utf8')); } catch {}
        if (!fields(value, ['code', 'deviceName']) || typeof value.code !== 'string' || typeof value.deviceName !== 'string') {
          reject(400, 'Invalid pairing request.'); return;
        }
        await serialize(async () => {
          if (response.destroyed || group !== listeners) return;
          const current = activePairing();
          if (!current || !equal(Buffer.from(value.code), Buffer.from(current.code))) {
            if (current && ++current.failures >= 8) pairing = null;
            reject(403, 'This pairing code is not valid. Make a new one in ASB.'); return;
          }
          if (settings.devices.length >= 8) { reject(409, 'Remove a paired phone in ASB first.'); return; }
          const token = randomBytes(32).toString('base64url');
          let id;
          do { id = randomBytes(6).toString('hex'); } while (settings.devices.some((item) => item.id === id));
          const name = Array.from(value.deviceName.trim().replace(/[\x00-\x1f\x7f-\x9f]/g, '')).slice(0, 64).join('') || 'Phone';
          await save({ ...settings, devices: [...settings.devices, { id, name, tokenSha256: hash(token), createdAtMs: now(), lastSeenAtMs: 0 }] });
          pairing = null;
          sendJson(response, 200, { deviceId: id, token, serverName: hostName, asbVersion, api: PHONE_API_VERSION });
        });
      } else if (hello) {
        sendJson(response, 200, { api: PHONE_API_VERSION, asbVersion, deviceId: device.id, serverName: hostName,
          addresses: listening(), port: settings.port });
      } else {
        const target = dashboard ? `/api/dashboard${url.searchParams.get('force') === '1' ? '?force=1' : ''}`
          : unread ? '/api/settings/unread' : `/api/threads/${match[1]}/${match[2]}`;
        proxy(request, response, target, body, dashboard);
      }
    } catch (cause) {
      if (!response.destroyed) reject(cause.statusCode === 413 ? 413 : 500,
        cause.statusCode === 413 ? 'Request body too large.' : 'ASB cannot save phone settings.');
    }
  }

  return {
    start: () => serialize(async () => { await load(); await restart(); return status(); }),
    stop: () => serialize(async () => { await closeListener(); if (dirty) await save(); }),
    status: () => serialize(async () => { await load(); return status(); }),
    updateSettings: (value) => serialize(async () => {
      await load();
      if (!fields(value, ['enabled', 'bindAddresses', 'port']) || typeof value.enabled !== 'boolean' || !validAddresses(value.bindAddresses)) {
        throw invalid('Invalid phone settings.');
      }
      if (!validPort(value.port) || value.port === localPort) throw invalid('The phone port must be from 1024 to 65535 and different from the ASB port.');
      const listed = listAddresses();
      if ((value.enabled && !value.bindAddresses.length)
        || !value.bindAddresses.every((address) => listed.some((item) => item.address === address))) {
        throw invalid('Choose a phone address on this PC.');
      }
      await save({ ...settings, ...value, bindAddresses: [...value.bindAddresses] });
      await restart();
      return status();
    }),
    createPairing: () => serialize(async () => {
      const addresses = listening();
      if (!addresses.length) throw invalid('Turn on phone access first.');
      pairing = { code: randomBytes(20).toString('base64url'), expiresAtMs: now() + 600_000, failures: 0 };
      const values = { v: 2, a: addresses.map(({ kind, address }) => `${kind}:${address}`).join(','), p: settings.port,
        f: fingerprint, c: pairing.code, n: hostName };
      return { uri: `asb://pair?${Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`,
        expiresAtMs: pairing.expiresAtMs };
    }),
    revokeDevice: (id) => serialize(async () => {
      await load();
      if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw invalid('Invalid phone ID.');
      await save({ ...settings, devices: settings.devices.filter((device) => device.id !== id) });
      seenSavedAt.delete(id);
      return status();
    }),
  };
}
