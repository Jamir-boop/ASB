import { execFile } from 'node:child_process';
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { sendJson } from './local-http.mjs';
import { configDir } from './platform-paths.mjs';
import { scopeInput } from './session-references.mjs';
import { USAGE_PERIODS } from './usage-aggregation.mjs';

export const PHONE_API_VERSION = 1;
export const DEFAULT_PHONE_PORT = 4630;
const execFileAsync = promisify(execFile);
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });
const controls = /[\x00-\x1f\x7f-\x9f]/;
const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const defaults = () => ({ schema: 2, enabled: false, bindAddresses: [], port: DEFAULT_PHONE_PORT, devices: [] });
const KINDS = ['lan', 'zerotier', 'tailscale'];
// The periods of the activity routes; the message routes take the first three.
const ACTIVITY_PERIODS = Object.keys(USAGE_PERIODS);
const validPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => left.length === right.length && timingSafeEqual(left, right);

export function phoneSettingsPath(env = process.env, platform = process.platform) {
  return path.join(configDir(env, platform, env.HOME || os.homedir()), 'phone.json');
}

export function phoneTlsDir(env = process.env, platform = process.platform) {
  return path.join(path.dirname(phoneSettingsPath(env, platform)), 'phone-tls');
}

// The source scope tag of session references: a keyed digest of the configured source folders.
// The key comes with HKDF from the identity secret (the private key PEM on Linux, the PFX passphrase on Windows) and stays in memory.
export function referenceScopeTagger(secret) {
  if (!secret?.length) throw new Error('No machine identity secret.');
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'asb session reference scope v1', 32));
  return (source) => createHmac('sha256', key).update(scopeInput(source)).digest().subarray(0, 16).toString('hex');
}

// The key of the engine reader positions file: HKDF from the same identity secret, with its own label. It stays in memory.
export function readerPositionsKeyFrom(secret) {
  if (!secret?.length) throw new Error('No machine identity secret.');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'asb reader positions v1', 32));
}

// The files of the machine certificate: openssl PEM files on Linux, PowerShell exports on Windows (plan 14.4).
export const tlsFiles = (platform = process.platform) => platform === 'win32' ? ['cert.pfx', 'pfx-pass', 'cert.cer'] : ['key.pem', 'cert.pem'];

// Appendix B part 1. The folder and the passphrase come only from the environment, never from the script text.
export const WINDOWS_CERTIFICATE_SCRIPT = `$ErrorActionPreference = 'Stop'
$c = New-SelfSignedCertificate -Subject 'CN=ASB' -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy Exportable \`
  -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(10)
try {
  $p = ConvertTo-SecureString -String $env:ASB_PFX_PASS -AsPlainText -Force
  Export-PfxCertificate -Cert $c -FilePath (Join-Path $env:ASB_TLS_DIR 'cert.pfx') -Password $p | Out-Null
  Export-Certificate -Cert $c -FilePath (Join-Path $env:ASB_TLS_DIR 'cert.cer') -Type CERT | Out-Null
} finally { Remove-Item -LiteralPath $c.PSPath }`;

export function privateIPv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

// 100.64.0.0/10 is also carrier NAT and hotspot space, so it counts only on a Tailscale interface.
export function tailscaleIPv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

// Linux names (tailscale0, zt...) and Windows adapter names (Tailscale, ZeroTier One [...]).
export function addressKind(name, address) {
  if (/^tailscale/i.test(name) && tailscaleIPv4(address)) return 'tailscale';
  if (!privateIPv4(address)) return '';
  return /^(zt|zerotier)/i.test(name) ? 'zerotier' : 'lan';
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

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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
  now = Date.now, openssl = 'openssl', hostName = os.hostname(), listAddresses = listPhoneAddresses,
  peer = null, onPhonePaired = () => {}, onPhoneRevoked = () => {}, platform = process.platform, env = process.env,
  execFile: run = execFileAsync }) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw invalid('Invalid ASB port.');
  let settings = defaults();
  let loaded = false;
  let listeners = [];
  let fingerprint = '';
  let error = '';
  let warning = '';
  let pairing = null;
  let dirty = false;
  let bound = '';
  let timer = null;
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

  // The selected addresses that are on this PC now, in the saved order.
  const available = (listed = listAddresses()) => settings.bindAddresses
    .filter((address) => listed.some((item) => item.address === address)).join(',');

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

  const exists = (file) => fs.access(file).then(() => true, (cause) => {
    if (cause.code !== 'ENOENT') throw cause;
    return false;
  });

  async function windowsCertificate() {
    const [pfxPath, passPath, cerPath] = tlsFiles('win32').map((name) => path.join(tlsDir, name));
    const files = [pfxPath, passPath, cerPath];
    if (!(await Promise.all(files.map(exists))).every(Boolean)) {
      try {
        await Promise.all(files.map((file) => fs.rm(file, { force: true })));
        const passphrase = randomBytes(32).toString('hex');
        await fs.writeFile(passPath, passphrase, { flag: 'wx', mode: 0o600 });
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CERTIFICATE_SCRIPT],
          { env: { ...env, ASB_TLS_DIR: tlsDir, ASB_PFX_PASS: passphrase }, windowsHide: true, timeout: 30_000 });
      } catch (cause) {
        await Promise.all(files.map((file) => fs.rm(file, { force: true })));
        throw cause;
      }
    }
    const [pfx, passphrase, cer] = await Promise.all(files.map((file) => fs.readFile(file)));
    fingerprint = new X509Certificate(cer).fingerprint256.replaceAll(':', '').toLowerCase();
    return { pfx, passphrase: passphrase.toString('utf8').trim() };
  }

  async function certificate() {
    await fs.mkdir(tlsDir, { recursive: true, mode: 0o700 });
    if (platform === 'win32') return windowsCertificate();
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
    bound = '';
    if (!settings.enabled) return;
    const listed = listAddresses();
    // A failed bind keeps this value, so the address check does not retry a busy port or a missing openssl.
    bound = available(listed);
    const missing = settings.bindAddresses.filter((address) => !listed.some((item) => item.address === address));
    if (missing.length) {
      error = missing.length === 1 ? `The phone address ${missing[0]} is not on this PC now. ASB listens on it when it appears.`
        : `The phone addresses ${missing.join(', ')} are not on this PC now. ASB listens on them when they appear.`;
    }
    const selected = listed.filter(({ address }) => settings.bindAddresses.includes(address));
    if (!selected.length) return;
    // https.Server ignores a `secureContext` option, so every listener gets the same key and certificate.
    let options;
    // Phones send no client certificate; group members send theirs, and the peer routes check it (plan 9.4).
    try { options = { ...(await certificate()), minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false }; }
    catch {
      fingerprint = '';
      error = platform === 'win32' ? 'ASB cannot create the phone certificate. Windows PowerShell failed.'
        : 'ASB cannot create the phone certificate. Install openssl.';
      return;
    }
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

  // The member routes of the machine group; only `join` takes a certificate that is not a member's.
  async function handlePeer(request, response, group, route, reject) {
    const method = ['join', 'leave', 'deliver', 'v2/resolve-session', 'v2/deliver'].includes(route) ? 'POST' : 'GET';
    if (request.method !== method) { response.setHeader('allow', method); reject(405, 'Method not allowed.'); return; }
    const raw = request.socket.getPeerCertificate(true)?.raw;
    const caller = raw ? hash(raw) : '';
    // A removed machine learns it from a member; this reply does not count toward the throttle.
    if (caller && route !== 'join' && peer.removedFingerprint(caller)) { request.resume(); sendJson(response, 410, { error: 'This machine was removed from the group.' }); return; }
    if (!caller || (route !== 'join' && !peer.memberFingerprint(caller))) { reject(401, 'This machine is not in the group.'); return; }
    try {
      // A relayed message can be 1 MiB of text (plan 9.7).
      const body = method === 'POST' ? await readBody(request, ['deliver', 'v2/deliver'].includes(route) ? 2 * 1024 * 1024 : 64 * 1024) : null;
      if (response.destroyed || group !== listeners) return;
      let value;
      try { value = body && JSON.parse(body.toString('utf8')); } catch {}
      let result;
      if (route === 'join') {
        if (!fields(value, ['code', 'name', 'addresses', 'port']) || typeof value.code !== 'string' || typeof value.name !== 'string') {
          reject(400, 'Invalid join request.'); return;
        }
        result = await peer.join(value, caller);
      } else if (route === 'leave') {
        if (!fields(value, [])) { reject(400, 'Invalid leave request.'); return; }
        result = await peer.leave(caller);
      } else if (route === 'peers') result = await peer.peers();
      else if (route === 'bridge') result = await peer.bridge();
      else if (route === 'deliver') result = await peer.deliver(value, caller);
      else if (route === 'v2/resolve-session') result = await peer.resolveExact(value, caller);
      else if (route === 'v2/deliver') result = await peer.deliverExact(value, caller);
      else if (route === 'sessions' || route === 'activity') {
        let answer;
        if (route === 'activity') {
          const period = new URL(request.url, 'https://asb').searchParams.get('period') ?? '7d';
          if (!ACTIVITY_PERIODS.includes(period)) { reject(400, 'Invalid period.'); return; }
          const { status, body } = await peer.activity(period);
          answer = { status, etag: '', body: JSON.stringify(body) };
        } else answer = await peer.sessions(request.headers['if-none-match']);
        if (response.destroyed) return;
        response.setHeader('vary', 'Accept-Encoding');
        if (answer.etag) response.setHeader('etag', answer.etag);
        if (answer.status === 304) { response.writeHead(304); response.end(); return; }
        const gzip = answer.status === 200 && acceptsGzip(request.headers['accept-encoding']);
        response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        if (!gzip) { response.end(answer.body); return; }
        const stream = createGzip();
        stream.on('error', () => response.destroy());
        stream.pipe(response);
        stream.end(answer.body);
        return;
      } else result = { status: 200, body: route === 'hello' ? await peer.hello() : await peer.group() };
      if (response.destroyed) return;
      if (result.status === 401) reject(401, result.body.error); else sendJson(response, result.status, result.body);
    } catch (cause) {
      if (!response.destroyed) reject(cause.statusCode === 413 ? 413 : 500, cause.statusCode === 413 ? 'Request body too large.' : 'ASB cannot answer.');
    }
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
    // The bridge route exists only when the engine gives its function.
    const peerRoute = peer && url.pathname.match(typeof peer.bridge === 'function' ? /^\/peer\/v1\/(join|hello|group|sessions|leave|peers|deliver|bridge|activity)$/
      : /^\/peer\/v1\/(join|hello|group|sessions|leave|peers|deliver|activity)$/);
    // The activity route exists only when the engine gives its function.
    if (peerRoute && (peerRoute[1] !== 'activity' || typeof peer.activity === 'function')) { await handlePeer(request, response, group, peerRoute[1], reject); return; }
    // The exact member routes (v2) exist only when the engine gives their function; every other /peer/v2 path is 404.
    const exactRoute = peer && url.pathname.match(/^\/peer\/v2\/(resolve-session|deliver)$/)?.[1];
    if (exactRoute && typeof peer[exactRoute === 'deliver' ? 'deliverExact' : 'resolveExact'] === 'function') {
      await handlePeer(request, response, group, `v2/${exactRoute}`, reject);
      return;
    }
    const match = url.pathname.match(/^\/phone\/v1\/threads\/([^/]{1,512})\/(open|mark-read|mark-unread|pin|unpin|move-pin|discard-result|keep-result|drawer-in|drawer-out)$/);
    const hello = url.pathname === '/phone/v1/hello';
    const dashboard = url.pathname === '/phone/v1/dashboard';
    const unread = url.pathname === '/phone/v1/settings/unread';
    // Contract 3: the two activity reads, never the thread.
    const activity = url.pathname.match(/^\/phone\/v1\/activity\/(messages|usage)$/)?.[1];
    if (!pairRoute && !hello && !dashboard && !unread && !match && !activity) { reject(404, 'Route is not available.'); return; }
    const method = hello || dashboard || activity ? 'GET' : 'POST';
    if (request.method !== method) { response.setHeader('allow', method); reject(405, 'Method not allowed.'); return; }
    try {
      let device;
      if (!pairRoute) {
        device = await serialize(async () => {
          const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
          if (!token) return null;
          const digest = Buffer.from(hash(token), 'hex');
          const found = settings.devices.find((item) => equal(digest, Buffer.from(item.tokenSha256, 'hex')));
          if (!found) {
            // A phone paired on another group member; its last-seen time is not saved here.
            const shared = peer?.phones().find((item) => equal(digest, Buffer.from(item.tokenHash, 'hex')));
            return shared ? { id: shared.deviceId, name: shared.name } : null;
          }
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
        let paired = null;
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
          paired = { id, name, tokenSha256: hash(token), createdAtMs: now() };
          await save({ ...settings, devices: [...settings.devices, { ...paired, lastSeenAtMs: 0 }] });
          pairing = null;
          sendJson(response, 200, { deviceId: id, token, serverName: hostName, asbVersion, api: PHONE_API_VERSION });
        });
        // After the queue: the hook can call `devices()`.
        if (paired) await onPhonePaired(paired);
      } else if (hello) {
        const machineId = fingerprint.slice(0, 16);
        sendJson(response, 200, { api: PHONE_API_VERSION, asbVersion, deviceId: device.id, serverName: hostName,
          addresses: listening(), port: settings.port, machineId,
          engines: (peer?.engines() || []).map((engine) => engine.machineId === machineId
            ? { ...engine, addresses: listening(), port: settings.port } : engine) });
      } else if (activity) {
        // Only a valid period goes on; every other query value stays here.
        const period = url.searchParams.get('period') ?? (activity === 'usage' ? '30d' : '7d');
        if (!(activity === 'usage' ? ACTIVITY_PERIODS : ACTIVITY_PERIODS.slice(0, 3)).includes(period)) { reject(400, 'Invalid period.'); return; }
        proxy(request, response, `/api/activity/${activity}?period=${period}${activity === 'messages' ? '&text=0' : ''}`, body, true);
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

  // An address can come or go after the start (ZeroTier often starts after ASB), so the listeners follow it.
  const checkAddresses = () => serialize(async () => {
    if (timer && settings.enabled && available() !== bound) await restart();
  }).catch(() => {});

  return {
    start: () => serialize(async () => {
      await load();
      await restart();
      timer ??= setInterval(checkAddresses, 30_000);
      timer.unref();
      return status();
    }),
    stop: () => serialize(async () => {
      clearInterval(timer);
      timer = null;
      await closeListener();
      if (dirty) await save();
    }),
    status: () => serialize(async () => { await load(); return status(); }),
    // The certificate is the machine identity, also while phone access is off: the ID is its first 16 fingerprint characters.
    identity: () => serialize(async () => {
      try { await certificate(); } catch { return ''; }
      return fingerprint.slice(0, 16);
    }),
    // The scope-tag function of the same identity, or null with no identity.
    referenceScopes: () => serialize(async () => {
      try {
        const material = await certificate();
        return referenceScopeTagger(platform === 'win32' ? material.passphrase : material.key);
      } catch { return null; }
    }),
    // The key of the reader positions file, or null with no identity.
    readerPositionsKey: () => serialize(async () => {
      try {
        const material = await certificate();
        return readerPositionsKeyFrom(platform === 'win32' ? material.passphrase : material.key);
      } catch { return null; }
    }),
    updateSettings: (value) => serialize(async () => {
      await load();
      if (!fields(value, ['enabled', 'bindAddresses', 'port']) || typeof value.enabled !== 'boolean' || !validAddresses(value.bindAddresses)) {
        throw invalid('Invalid phone settings.');
      }
      if (!validPort(value.port) || value.port === localPort) throw invalid('The phone port must be from 1024 to 65535 and different from the ASB port.');
      const listed = listAddresses();
      if ((value.enabled && !value.bindAddresses.length)
        // A saved address that is absent now can stay selected; it is bound only when it is on this PC again.
        || !value.bindAddresses.every((address) => listed.some((item) => item.address === address) || settings.bindAddresses.includes(address))) {
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
    revokeDevice: async (id) => {
      const result = await serialize(async () => {
        await load();
        if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw invalid('Invalid phone ID.');
        await save({ ...settings, devices: settings.devices.filter((device) => device.id !== id) });
        seenSavedAt.delete(id);
        return status();
      });
      await onPhoneRevoked(id);
      return result;
    },
    devices: () => serialize(async () => {
      await load();
      return settings.devices.map(({ id, name, tokenSha256, createdAtMs }) => ({ id, name, tokenSha256, createdAtMs }));
    }),
    credentials: () => serialize(async () => ({ ...(await certificate()), fingerprint })),
  };
}
