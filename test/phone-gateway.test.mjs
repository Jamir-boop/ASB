import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createPhoneGateway, DEFAULT_PHONE_PORT, PHONE_API_VERSION, phoneSettingsPath, phoneTlsDir,
  listPhoneAddresses, isAllowedRemote, acceptsGzip } from '../src/phone-gateway.mjs';
import { RUNTIME_FILES } from '../scripts/asb-package.mjs';
import { createMachineGroup } from '../src/machine-group.mjs';
import { closePeerAgents, PEER_IDLE_SOCKET_MS, peerRequest } from '../src/machine-peers.mjs';

let hasOpenSsl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenSsl = false; }
const gatewayTest = (name, run) => test(name, { skip: hasOpenSsl ? false : 'openssl is not on PATH.' }, run);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const settings = (extra = {}) => ({ schema: 2, enabled: false, bindAddresses: [], port: DEFAULT_PHONE_PORT, devices: [], ...extra });
const loopback = () => [{ address: '127.0.0.1', interface: 'lo', kind: 'lan' }];

async function storage(t, cleanup = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-phone-test-'));
  if (cleanup) t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_RUNTIME_DIR: path.join(home, 'runtime') };
  return { home, env, settingsPath: phoneSettingsPath(env), tlsDir: phoneTlsDir(env) };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function close(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function fixture(t, options = {}) {
  const store = await storage(t, false);
  const records = [];
  const local = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    records.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
    if (options.reply) options.reply(request, response);
    else { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); }
  });
  const localPort = await listen(local);
  let gateway;
  t.after(async () => {
    try { await gateway?.stop(); }
    finally {
      try { await close(local); }
      finally { await rm(store.home, { recursive: true, force: true }); }
    }
  });
  let clock = 1_000_000;
  const args = { localPort, asbVersion: '1.8.1', ...store, hostName: 'Test PC & lab', now: () => clock,
    listAddresses: loopback, ...options.gateway };
  gateway = createPhoneGateway(args);
  await gateway.start();
  const port = await freePort();
  if (options.enabled !== false) {
    const status = await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port });
    assert.equal(status.running, true, status.error);
  }
  const request = (route, { method = 'GET', token, body, headers = {}, tls = {}, host = '127.0.0.1' } = {}) => new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const client = https.request({ host, port, path: route, method, rejectUnauthorized: false, agent: false,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...tls }, (response) => {
      const fingerprint = response.socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase();
      const protocol = response.socket.getProtocol();
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString();
        resolve({ status: response.statusCode, headers: response.headers, raw, text,
          json: text.startsWith('{') ? JSON.parse(text) : null, fingerprint, protocol });
      });
    });
    client.on('error', reject);
    client.setTimeout(5000, () => client.destroy(new Error('Test request timed out.')));
    client.end(raw);
  });
  const pair = async (deviceName = 'Test phone') => {
    const info = await gateway.createPairing();
    const code = new URL(info.uri).searchParams.get('c');
    return { ...(await request('/phone/v1/pair', { method: 'POST', body: { code, deviceName } })), code, info };
  };
  return { ...store, gateway, args, request, pair, records, local, localPort, port,
    setNow: (value) => { clock = value; }, advance: (amount) => { clock += amount; } };
}

test('phone defaults keep the listener off and paths use HOME when XDG_CONFIG_HOME is empty', async (t) => {
  const store = await storage(t);
  const gateway = createPhoneGateway({ localPort: 12345, asbVersion: '1.8.1', ...store, listAddresses: () => [] });
  t.after(() => gateway.stop());
  assert.equal(phoneSettingsPath({ HOME: store.home, XDG_CONFIG_HOME: '' }), path.join(store.home, '.config/asb/phone.json'));
  assert.equal(phoneTlsDir({ HOME: store.home }), path.join(store.home, '.config/asb/phone-tls'));
  assert.equal(PHONE_API_VERSION, 1);
  assert.deepEqual(await gateway.start(), { enabled: false, bindAddresses: [], port: 4630, addresses: [], listening: [], running: false,
    error: '', warning: '', fingerprint: '', devices: [], pairing: { expiresAtMs: 0 } });
  await assert.rejects(gateway.createPairing(), { statusCode: 400, message: 'Turn on phone access first.' });
  await assert.rejects(stat(store.settingsPath), { code: 'ENOENT' });
  assert.ok(RUNTIME_FILES.includes('src/phone-gateway.mjs'));
});

test('invalid phone settings replace phone.json.bad and set a warning', async (t) => {
  const store = await storage(t);
  await mkdir(path.dirname(store.settingsPath), { recursive: true });
  const device = { id: 'a'.repeat(12), name: 'Phone', tokenSha256: 'b'.repeat(64), createdAtMs: 0, lastSeenAtMs: 0 };
  for (const bad of ['{', 'null', ...[
    { schema: 1 }, { schema: 3 }, { bindAddress: '' }, { enabled: 1 }, { bindAddresses: '' }, { bindAddresses: [1] },
    { bindAddresses: ['10.0.0.1', '10.0.0.1'] }, { bindAddresses: Array.from({ length: 9 }, (_, i) => `10.0.0.${i}`) },
    { port: 1023 }, { port: 65536 }, { port: 4630.5 },
    { extra: true }, { devices: {} }, { devices: Array(9).fill(device) }, { devices: [null] },
    ...[{ id: 'ABC' }, { name: '' }, { name: 'x'.repeat(65) }, { name: 'line\nbreak' },
      { name: '\u0085' }, { tokenSha256: 'A'.repeat(64) }, { createdAtMs: -1 }, { lastSeenAtMs: 1.5 }, { token: 'secret' }]
      .map((extra) => ({ devices: [{ ...device, ...extra }] })),
    { devices: [device, device] },
  ].map((extra) => JSON.stringify(settings(extra)))]) {
    await writeFile(store.settingsPath, bad);
    await writeFile(`${store.settingsPath}.bad`, 'old');
    const gateway = createPhoneGateway({ localPort: 12345, asbVersion: '1.8.1', ...store, listAddresses: () => [] });
    const status = await gateway.start();
    assert.equal(status.warning, 'ASB moved an invalid phone.json to phone.json.bad.');
    assert.equal(status.enabled, false);
    assert.deepEqual(status.devices, []);
    assert.equal(await readFile(`${store.settingsPath}.bad`, 'utf8'), bad);
    await assert.rejects(stat(store.settingsPath), { code: 'ENOENT' });
    await gateway.stop();
  }
});

gatewayTest('phone settings, TLS files, and new folders have owner-only modes and the TLS pin matches', async (t) => {
  const { gateway, request, settingsPath, tlsDir } = await fixture(t);
  for (const file of [settingsPath, path.join(tlsDir, 'key.pem'), path.join(tlsDir, 'cert.pem')]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600, file);
  }
  for (const folder of [path.dirname(settingsPath), tlsDir]) assert.equal((await stat(folder)).mode & 0o777, 0o700);
  const response = await request('/phone/v1/hello');
  assert.equal(response.fingerprint, (await gateway.status()).fingerprint);
  assert.equal(response.protocol, 'TLSv1.3');
  await assert.rejects(request('/phone/v1/hello', { tls: { maxVersion: 'TLSv1.2' } }));
  await chmod(settingsPath, 0o644);
  const restored = createPhoneGateway({ localPort: 12345, asbVersion: '1.8.1', settingsPath, tlsDir, listAddresses: () => [] });
  await restored.status();
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

gatewayTest('pairing is single-use, expires, replaces old codes, and ends after eight wrong codes', async (t) => {
  const { gateway, request, pair, advance } = await fixture(t);
  const first = await pair('  Test\nphone\u0085  ');
  assert.equal(first.status, 200);
  assert.match(first.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.json.deviceId, /^[a-f0-9]{12}$/);
  assert.deepEqual(Object.keys(first.json).sort(), ['api', 'asbVersion', 'deviceId', 'serverName', 'token']);
  const link = new URL(first.info.uri);
  assert.equal(link.searchParams.get('n'), 'Test PC & lab');
  assert.equal(link.searchParams.get('v'), '2');
  assert.equal(link.searchParams.get('a'), 'lan:127.0.0.1');
  assert.equal(link.searchParams.get('h'), null);
  assert.equal((await gateway.status()).devices[0].name, 'Testphone');
  const post = (code) => request('/phone/v1/pair', { method: 'POST', body: { code, deviceName: 'Phone' } });
  assert.equal((await post(first.code)).status, 403);
  const expired = await gateway.createPairing();
  advance(600_000);
  assert.equal((await post(new URL(expired.uri).searchParams.get('c'))).status, 403);
  assert.deepEqual((await gateway.status()).pairing, { expiresAtMs: 0 });
  const replaced = new URL((await gateway.createPairing()).uri).searchParams.get('c');
  const active = new URL((await gateway.createPairing()).uri).searchParams.get('c');
  assert.equal((await post(replaced)).status, 403);
  for (let i = 0; i < 7; i++) assert.equal((await post('wrong')).status, 403);
  assert.equal((await post(active)).status, 403);
  assert.equal((await gateway.status()).devices.length, 1);
  assert.equal((await pair('\n\u0000')).status, 200);
  assert.equal((await gateway.status()).devices[1].name, 'Phone');
  assert.equal((await pair('x'.repeat(80))).status, 200);
  assert.equal((await gateway.status()).devices[2].name.length, 64);
});

gatewayTest('eight paired devices prevent a ninth device', async (t) => {
  const { gateway, pair } = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await pair(`Phone ${i}`)).status, 200);
  const ninth = await pair();
  assert.equal(ninth.status, 409);
  assert.equal(ninth.json.error, 'Remove a paired phone in ASB first.');
  assert.equal((await gateway.status()).devices.length, 8);
});

gatewayTest('bearer authentication needs the exact token and hello reports the paired device', async (t) => {
  const { request, pair, port, gateway } = await fixture(t);
  const paired = (await pair()).json;
  for (const authorization of ['', `Bearer ${randomBytes(32).toString('base64url')}`, `bearer ${paired.token}`,
    `Bearer ${paired.token}=`, `Bearer ${paired.token} extra`, 'Basic xxx']) {
    const response = await request('/phone/v1/hello', { headers: { authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.json.error, 'This phone is not paired with ASB.');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  const response = await request('/phone/v1/hello', { token: paired.token });
  assert.equal(response.status, 200);
  // No group: the machine ID is the first 16 fingerprint characters, and no other engine is listed.
  const machineId = (await gateway.status()).fingerprint.slice(0, 16);
  assert.match(machineId, /^[0-9a-f]{16}$/);
  assert.deepEqual(response.json, { api: 1, asbVersion: '1.8.1', deviceId: paired.deviceId, serverName: 'Test PC & lab',
    addresses: [{ kind: 'lan', address: '127.0.0.1' }], port, machineId, engines: [] });
});

gatewayTest('hello lists the group engines with the live values of this engine, also for a phone paired on another member', async (t) => {
  const sharedToken = randomBytes(32).toString('base64url');
  const other = { machineId: 'b'.repeat(16), name: 'homeLP', port: 4630, fingerprint: 'b'.repeat(64), addresses: [{ kind: 'zerotier', address: '10.147.0.2' }] };
  let self = null;
  const peer = { engines: () => [self, other].map((item) => structuredClone(item)),
    phones: () => [{ deviceId: 'shared-phone', name: 'Pixel', tokenHash: createHash('sha256').update(sharedToken).digest('hex') }] };
  const { request, pair, port, gateway } = await fixture(t, { gateway: { peer } });
  const fingerprint = (await gateway.status()).fingerprint;
  // The saved member entry of this engine is old; hello gives the listening addresses and the port of now.
  self = { machineId: fingerprint.slice(0, 16), name: 'debian', port: 4999, fingerprint, addresses: [{ kind: 'lan', address: '192.168.1.10' }] };
  const engines = [{ ...self, addresses: [{ kind: 'lan', address: '127.0.0.1' }], port }, other];
  const paired = (await pair()).json;
  const own = await request('/phone/v1/hello', { token: paired.token });
  assert.deepEqual(Object.keys(own.json), ['api', 'asbVersion', 'deviceId', 'serverName', 'addresses', 'port', 'machineId', 'engines']);
  assert.deepEqual([own.json.machineId, own.json.engines], [fingerprint.slice(0, 16), engines]);
  const shared = await request('/phone/v1/hello', { token: sharedToken });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.json, { ...own.json, deviceId: 'shared-phone' });
});

gatewayTest('twenty failures throttle the remote for one minute and use a sliding window', async (t) => {
  const { gateway, request, pair, advance } = await fixture(t);
  const paired = (await pair()).json;
  for (let i = 0; i < 10; i++) assert.equal((await request('/phone/v1/hello')).status, 401);
  advance(60_000);
  for (let i = 0; i < 19; i++) assert.equal((await request('/phone/v1/hello')).status, 401);
  assert.equal((await request('/phone/v1/pair', { method: 'POST', body: { code: 'wrong', deviceName: 'Phone' } })).status, 403);
  const blocked = await request('/phone/v1/hello', { token: paired.token });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'Too many failed attempts. Wait one minute.');
  advance(59_999);
  assert.equal((await request('/phone/v1/hello', { token: paired.token })).status, 429);
  advance(1);
  assert.equal((await request('/phone/v1/hello', { token: paired.token })).status, 200);
  assert.equal((await gateway.status()).devices.length, 1);
});

gatewayTest('the route allowlist blocks other APIs and checks methods before bearer auth', async (t) => {
  const { request, pair, records } = await fixture(t);
  const token = (await pair()).json.token;
  for (const route of ['/phone/v1/sources', '/api/dashboard', '/api/palette', '/phone/v1/palette', '/phone/v1/threads/x/delete', '/phone/v1/threads/x/mute', '/phone/v1/threads/x/unmute', '/phone/v1/settings/phone',
    '/phone/v1/threads//open', `/phone/v1/threads/${'x'.repeat(513)}/open`, '/phone/v1/threads/x/y/open']) {
    const response = await request(route, { method: 'POST', token, body: {} });
    assert.equal(response.status, 404, route);
    assert.equal(response.json.error, 'Route is not available.');
  }
  for (const route of ['/api/sources', '/api/phone', '/api/phone/settings', '/api/palette',
    '/api/agent/status', '/api/agent/ui', '/phone/v1/agent/status', '/phone/v1/agent/ui', '/api/engine/stop', '/phone/v1/engine/stop',
    '/api/agent/resolve-session', '/phone/v1/agent/resolve-session', '/api/agent/resolve-bound', '/phone/v1/agent/resolve-bound',
    '/api/agent/list-references', '/phone/v1/agent/list-references',
    '/api/relay/homes', '/api/relay/remote-peers', '/api/relay/send', '/phone/v1/relay/send',
    '/api/bridge', '/api/bridge/install', '/phone/v1/bridge', '/phone/v1/bridge/install']) {
    for (const method of ['GET', 'POST']) {
      const response = await request(route, { method, token, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(response.json.error, 'Route is not available.');
    }
  }
  for (const [route, method, allow] of [['/phone/v1/hello', 'POST', 'GET'], ['/phone/v1/dashboard', 'POST', 'GET'],
    ['/phone/v1/pair', 'GET', 'POST'], ['/phone/v1/settings/unread', 'GET', 'POST'], ['/phone/v1/threads/x/open', 'GET', 'POST']]) {
    const response = await request(route, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, allow);
  }
  assert.equal((await request('http://[')).status, 400);
  assert.deepEqual(records, []);
});

gatewayTest('the proxy adds local Host and Origin, strips other headers, and preserves ETag and 304', async (t) => {
  const { request, pair, records, localPort } = await fixture(t, { reply: (request, response) => {
    response.writeHead(request.headers['if-none-match'] === '"test"' ? 304 : 200,
      { etag: '"test"', 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'set-cookie': 'private=1', 'x-private': 'hidden' });
    response.end('{"ok":true}');
  } });
  const token = (await pair()).json.token;
  for (const action of ['open', 'mark-read', 'mark-unread', 'pin', 'unpin', 'move-pin', 'discard-result', 'keep-result', 'drawer-in', 'drawer-out']) {
    const body = action === 'move-pin' ? { targetId: 'next', placement: 'after' } : {};
    const response = await request(`/phone/v1/threads/source%3Aid/${action}?ignored=1`, { method: 'POST', token, body,
      headers: { cookie: 'secret=1', origin: 'https://untrusted.invalid', 'x-asb-source-token': 'secret', 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['x-private'], undefined);
    const recorded = records.at(-1);
    assert.equal(recorded.url, `/api/threads/source%3Aid/${action}`);
    assert.equal(recorded.headers.host, `127.0.0.1:${localPort}`);
    assert.equal(recorded.headers.origin, `http://127.0.0.1:${localPort}`);
    assert.equal(recorded.headers['content-type'], 'application/json');
    for (const name of ['authorization', 'cookie', 'x-asb-source-token', 'sec-fetch-site']) assert.equal(recorded.headers[name], undefined);
    assert.deepEqual(JSON.parse(recorded.body), body);
  }
  assert.equal((await request('/phone/v1/settings/unread', { method: 'POST', token, body: { persistentUnread: true } })).status, 200);
  assert.equal(records.at(-1).url, '/api/settings/unread');
  const cached = await request('/phone/v1/dashboard?force=1&extra=secret', { token, headers: { 'if-none-match': '"test"' } });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
  assert.equal(cached.headers.etag, '"test"');
  assert.equal(cached.headers['cache-control'], 'no-store');
  assert.equal(cached.headers['x-content-type-options'], 'nosniff');
  assert.equal(records.at(-1).url, '/api/dashboard?force=1');
  assert.equal(records.at(-1).headers['if-none-match'], '"test"');
  assert.equal(records.at(-1).headers.origin, undefined);
  await request('/phone/v1/dashboard?force=true&extra=secret', { token });
  assert.equal(records.at(-1).url, '/api/dashboard');
});

test('Accept-Encoding allows gzip only with a positive q-value for gzip, or for * when gzip is not listed', () => {
  for (const header of ['gzip', 'GZIP', 'gzip, deflate, br', 'br;q=1, gzip;q=0.5', '*', '*;q=0.1', 'gzip;q=1, *;q=0', 'deflate, gzip ; q=0.2']) {
    assert.equal(acceptsGzip(header), true, header);
  }
  for (const header of [undefined, '', 'identity', 'br, deflate', 'gzip;q=0', 'gzip;q=0.0', 'gzip; q=0', '*;q=0', 'gzip;q=0, *', 'gzip;q=abc']) {
    assert.equal(acceptsGzip(header), false, String(header));
  }
});

gatewayTest('the dashboard reply is gzip only when the phone accepts it and has Vary when the loopback server answers', async (t) => {
  const dashboard = JSON.stringify({ threads: Array.from({ length: 200 }, (_, i) => ({ id: `thread-${i}`, state: 'idle' })) });
  const { request, pair, local } = await fixture(t, { reply: (request, response) => {
    if (request.url.startsWith('/api/threads/')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(dashboard); return; }
    response.writeHead(request.headers['if-none-match'] === '"v1"' ? 304 : 200, { etag: '"v1"', 'content-type': 'application/json' });
    response.end(request.headers['if-none-match'] === '"v1"' ? undefined : dashboard);
  } });
  const token = (await pair()).json.token;
  const zipped = await request('/phone/v1/dashboard', { token, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.equal(zipped.headers.etag, '"v1"');
  assert.equal(zipped.headers['content-type'], 'application/json');
  assert.equal(gunzipSync(zipped.raw).toString(), dashboard);
  assert.ok(zipped.raw.length < dashboard.length / 5);
  for (const headers of [{}, { 'accept-encoding': 'gzip;q=0' }]) {
    const plain = await request('/phone/v1/dashboard', { token, headers });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    assert.equal(plain.headers.etag, '"v1"');
    assert.equal(plain.text, dashboard);
  }
  const cached = await request('/phone/v1/dashboard', { token, headers: { 'accept-encoding': 'gzip', 'if-none-match': '"v1"' } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers['content-encoding'], undefined);
  assert.equal(cached.headers.vary, 'Accept-Encoding');
  assert.equal(cached.headers.etag, '"v1"');
  assert.equal(cached.raw.length, 0);
  const action = await request('/phone/v1/threads/x/open', { method: 'POST', token, body: {}, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(action.status, 200);
  assert.equal(action.headers['content-encoding'], undefined);
  assert.equal(action.headers.vary, undefined);
  assert.equal(action.text, dashboard);
  await close(local);
  const failed = await request('/phone/v1/dashboard', { token, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(failed.status, 502);
  assert.equal(failed.headers['content-encoding'], undefined);
  assert.deepEqual(failed.json, { error: 'ASB is not answering.' });
});

gatewayTest('an upstream error after the gzip headers ends the phone reply', async (t) => {
  const { request, pair } = await fixture(t, { reply: (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    setTimeout(() => response.socket.destroy(), 50);
  } });
  const token = (await pair()).json.token;
  const started = performance.now();
  // The gateway must end the reply itself; the helper's 5 s timeout must not be what rejects.
  await assert.rejects(request('/phone/v1/dashboard', { token, headers: { 'accept-encoding': 'gzip' } }),
    (error) => error.message !== 'Test request timed out.');
  assert.ok(performance.now() - started < 2000, 'the phone reply must end soon after the upstream error');
});

test('remote addresses and interface discovery allow only loopback or RFC1918 IPv4 as specified', () => {
  for (const kind of ['lan', 'zerotier', undefined]) {
    for (const address of ['127.0.0.1', '::1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '::ffff:192.168.50.7', '::ffff:127.0.0.1', '::FFFF:10.1.2.3']) assert.equal(isAllowedRemote(address, kind), true, address);
    for (const address of ['8.8.8.8', '0.0.0.0', '127.0.0.2', '172.15.255.255', '172.32.0.0', '169.254.1.1', '100.101.102.103',
      '::ffff:100.64.0.1', '192.169.0.1', '192.168.1.256', '192.168.001.1', '::', 'fd00::1', '::ffff:8.8.8.8', '', null, 123]) {
      assert.equal(isAllowedRemote(address, kind), false, String(address));
    }
  }
  for (const address of ['100.64.0.0', '100.101.102.103', '100.127.255.255', '::ffff:100.101.102.103', '10.147.17.4', '192.168.50.7']) {
    assert.equal(isAllowedRemote(address, 'tailscale'), true, address);
  }
  for (const address of ['100.63.255.255', '100.128.0.0', '127.0.0.1', '::1', '::ffff:127.0.0.1', '8.8.8.8', '0.0.0.0', '', null]) {
    assert.equal(isAllowedRemote(address, 'tailscale'), false, String(address));
  }
  assert.deepEqual(listPhoneAddresses({
    tailscale0: [{ family: 'IPv4', address: '100.101.102.103' }, { family: 'IPv6', address: 'fd7a:115c:a1e0::1' }],
    ztabcdef12: [{ family: 'IPv4', address: '10.147.17.4' }, { family: 'IPv4', address: '100.80.0.1' }],
    enp0s1: [{ family: 'IPv4', address: '192.168.50.4' }, { family: 'IPv4', address: '8.8.8.8' }],
    wlan0: [{ family: 4, address: '172.16.1.2' }, { family: 'IPv4', address: '100.64.0.7' }, { family: 'IPv6', address: 'fd00::1' }],
    tailscale1: [{ family: 'IPv4', address: '8.8.4.4' }, { family: 'IPv4', address: '127.0.0.1' }],
    lo: [{ family: 'IPv4', address: '127.0.0.1' }], absent: undefined }),
  [{ address: '192.168.50.4', interface: 'enp0s1', kind: 'lan' }, { address: '172.16.1.2', interface: 'wlan0', kind: 'lan' },
    { address: '10.147.17.4', interface: 'ztabcdef12', kind: 'zerotier' },
    { address: '100.101.102.103', interface: 'tailscale0', kind: 'tailscale' }]);
});

test('a schema 1 phone.json loads as schema 2 and saves as schema 2 at the next save', async (t) => {
  const store = await storage(t);
  await mkdir(path.dirname(store.settingsPath), { recursive: true });
  const device = { id: 'a'.repeat(12), name: 'Phone', tokenSha256: 'b'.repeat(64), createdAtMs: 1, lastSeenAtMs: 2 };
  for (const [bindAddress, bindAddresses] of [['', []], ['192.168.50.4', ['192.168.50.4']]]) {
    const old = { schema: 1, enabled: false, bindAddress, port: 4631, devices: [device] };
    await writeFile(store.settingsPath, JSON.stringify(old));
    const gateway = createPhoneGateway({ localPort: 12345, asbVersion: '1.8.1', ...store, listAddresses: () => [] });
    const status = await gateway.start();
    assert.equal(status.warning, '');
    assert.deepEqual(status.bindAddresses, bindAddresses);
    assert.equal(status.port, 4631);
    assert.equal(status.devices[0].id, device.id);
    assert.deepEqual(JSON.parse(await readFile(store.settingsPath, 'utf8')), old);
    await gateway.revokeDevice('c'.repeat(12));
    assert.deepEqual(JSON.parse(await readFile(store.settingsPath, 'utf8')),
      { schema: 2, enabled: false, bindAddresses, port: 4631, devices: [device] });
    await gateway.stop();
  }
});

gatewayTest('several listeners share one certificate, skip a missing address, and check callers per kind', async (t) => {
  const { gateway, request, settingsPath, args, port } = await fixture(t, { enabled: false });
  await assert.rejects(gateway.createPairing(), { statusCode: 400 });
  await mkdir(path.dirname(settingsPath), { recursive: true });
  // Loopback stands in for real interfaces; the kind decides the caller rule.
  const listed = [{ address: '127.0.0.1', interface: 'enp0s1', kind: 'lan' },
    { address: '127.0.0.3', interface: 'ztabcdef12', kind: 'zerotier' },
    { address: '127.0.0.2', interface: 'tailscale0', kind: 'tailscale' }];
  await writeFile(settingsPath, JSON.stringify(settings({ enabled: true, port,
    bindAddresses: ['127.0.0.2', '192.168.50.4', '127.0.0.1', '127.0.0.3'] })));
  const multi = createPhoneGateway({ ...args, listAddresses: () => listed });
  t.after(() => multi.stop());
  const status = await multi.start();
  assert.equal(status.running, true);
  assert.equal(status.error, 'The phone address 192.168.50.4 is not on this PC now. ASB listens on it when it appears.');
  assert.deepEqual(status.listening, [{ kind: 'lan', address: '127.0.0.1' }, { kind: 'zerotier', address: '127.0.0.3' },
    { kind: 'tailscale', address: '127.0.0.2' }]);
  assert.deepEqual(status.addresses, listed);
  const info = await multi.createPairing();
  const link = new URL(info.uri);
  assert.deepEqual([...link.searchParams.keys()], ['v', 'a', 'p', 'f', 'c', 'n']);
  assert.equal(link.searchParams.get('v'), '2');
  assert.equal(link.searchParams.get('a'), 'lan:127.0.0.1,zerotier:127.0.0.3,tailscale:127.0.0.2');
  assert.ok(info.uri.includes('&a=lan%3A127.0.0.1%2Czerotier%3A127.0.0.3%2Ctailscale%3A127.0.0.2&'));
  assert.equal(link.searchParams.get('p'), String(port));
  assert.equal(link.searchParams.get('f'), status.fingerprint);
  const paired = await request('/phone/v1/pair', { method: 'POST', body: { code: link.searchParams.get('c'), deviceName: 'Phone' }, host: '127.0.0.3' });
  assert.equal(paired.status, 200);
  for (const host of ['127.0.0.1', '127.0.0.3']) {
    const hello = await request('/phone/v1/hello', { token: paired.json.token, host });
    assert.equal(hello.status, 200);
    assert.equal(hello.fingerprint, status.fingerprint);
    assert.equal(hello.protocol, 'TLSv1.3');
    assert.deepEqual(hello.json.addresses, status.listening);
    assert.equal(hello.json.port, port);
  }
  // A Tailscale listener does not accept loopback callers.
  await assert.rejects(request('/phone/v1/hello', { token: paired.json.token, host: '127.0.0.2' }));
  await multi.stop();
  assert.equal((await multi.status()).running, false);
  await assert.rejects(request('/phone/v1/hello', { token: paired.json.token, host: '127.0.0.3' }));
});

gatewayTest('revoking a device rejects its old token and persists across a new gateway', async (t) => {
  const { gateway, request, pair, settingsPath, args } = await fixture(t);
  const paired = (await pair()).json;
  assert.equal((await request('/phone/v1/hello', { token: paired.token })).status, 200);
  const status = await gateway.revokeDevice(paired.deviceId);
  assert.deepEqual(status.devices, []);
  assert.equal((await request('/phone/v1/hello', { token: paired.token })).status, 401);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).devices, []);
  const restored = createPhoneGateway(args);
  assert.deepEqual((await restored.status()).devices, []);
  await assert.rejects(gateway.revokeDevice('../phone.json'), { statusCode: 400 });
});

gatewayTest('status omits pairing codes, tokens and hashes and returns independent data', async (t) => {
  const { gateway, pair, settingsPath } = await fixture(t);
  const paired = await pair();
  const active = await gateway.createPairing();
  const status = await gateway.status();
  const text = JSON.stringify(status);
  for (const secret of ['"token"', 'tokenSha256', paired.json.token, sha256(paired.json.token), new URL(active.uri).searchParams.get('c')]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(status.pairing.expiresAtMs, active.expiresAtMs);
  status.devices[0].name = 'changed';
  status.addresses[0].address = '8.8.8.8';
  assert.equal((await gateway.status()).devices[0].name, 'Test phone');
  const persisted = await readFile(settingsPath, 'utf8');
  assert.equal(persisted.includes(paired.json.token), false);
  assert.equal(persisted.includes(sha256(paired.json.token)), true);
});

gatewayTest('pairing validation and byte limits reject malformed requests before proxying', async (t) => {
  const { gateway, request, pair, records } = await fixture(t);
  for (const body of ['{', 'null', '[]', '{}', '{"code":"a"}', '{"code":1,"deviceName":"Phone"}',
    '{"code":"a","deviceName":null}', '{"code":"a","deviceName":"Phone","extra":true}']) {
    const response = await request('/phone/v1/pair', { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.equal(response.json.error, 'Invalid pairing request.');
  }
  const { token } = (await pair()).json;
  for (const route of ['/phone/v1/pair', '/phone/v1/threads/x/open']) {
    const response = await request(route, { method: 'POST', token, body: 'é'.repeat(33_000) });
    assert.equal(response.status, 413);
    assert.equal(response.json.error, 'Request body too large.');
  }
  assert.equal((await request('/phone/v1/threads/x/open', { method: 'POST', token, body: Buffer.alloc(65_536, 32) })).status, 200);
  assert.equal(records.length, 1);
  assert.equal(Buffer.byteLength(records[0].body), 65_536);
  assert.equal((await gateway.status()).devices.length, 1);
});

gatewayTest('concurrent pairing cannot consume one code twice or exceed the device limit', async (t) => {
  const { gateway, request, pair } = await fixture(t);
  const code = new URL((await gateway.createPairing()).uri).searchParams.get('c');
  const post = () => request('/phone/v1/pair', { method: 'POST', body: { code, deviceName: 'Phone' } });
  assert.deepEqual((await Promise.all([post(), post()])).map((reply) => reply.status).sort(), [200, 403]);
  for (let i = 0; i < 6; i++) assert.equal((await pair()).status, 200);
  const last = new URL((await gateway.createPairing()).uri).searchParams.get('c');
  const replies = await Promise.all([1, 2, 3].map(() => request('/phone/v1/pair', { method: 'POST', body: { code: last, deviceName: 'Last' } })));
  assert.equal(replies.filter((reply) => reply.status === 200).length, 1);
  assert.equal((await gateway.status()).devices.length, 8);
});

gatewayTest('failed persistence does not pair or revoke a device and leaves pairing retryable', async (t) => {
  const { gateway, request, pair, settingsPath } = await fixture(t);
  const code = new URL((await gateway.createPairing()).uri).searchParams.get('c');
  await mkdir(`${settingsPath}.tmp`);
  const post = () => request('/phone/v1/pair', { method: 'POST', body: { code, deviceName: 'Phone' } });
  assert.equal((await post()).status, 500);
  assert.equal((await gateway.status()).devices.length, 0);
  await rm(`${settingsPath}.tmp`, { recursive: true });
  assert.equal((await post()).status, 200);
  const paired = (await pair()).json;
  await mkdir(`${settingsPath}.tmp`);
  await assert.rejects(gateway.revokeDevice(paired.deviceId));
  assert.equal((await gateway.status()).devices.length, 2);
  assert.equal((await request('/phone/v1/hello', { token: paired.token })).status, 200);
  await rm(`${settingsPath}.tmp`, { recursive: true });
});

gatewayTest('last-seen state saves at most once per ten minutes and flushes on stop', async (t) => {
  const { gateway, request, pair, settingsPath, advance } = await fixture(t);
  const paired = (await pair()).json;
  const storedSeen = async () => JSON.parse(await readFile(settingsPath, 'utf8')).devices[0].lastSeenAtMs;
  assert.equal(await storedSeen(), 0);
  await request('/phone/v1/hello', { token: paired.token });
  assert.equal(await storedSeen(), 1_000_000);
  advance(599_999);
  await request('/phone/v1/hello', { token: paired.token });
  assert.equal(await storedSeen(), 1_000_000);
  assert.equal((await gateway.status()).devices[0].lastSeenAtMs, 1_599_999);
  advance(1);
  await request('/phone/v1/hello', { token: paired.token });
  assert.equal(await storedSeen(), 1_600_000);
  advance(1);
  await request('/phone/v1/hello', { token: paired.token });
  await gateway.stop();
  assert.equal(await storedSeen(), 1_600_001);
  assert.equal((await gateway.status()).running, false);
  await assert.rejects(request('/phone/v1/hello', { token: paired.token }));
});

gatewayTest('settings reject unsupported addresses and ports, and a vanished address keeps the listener off', async (t) => {
  const { gateway, localPort, port } = await fixture(t);
  for (const extra of [{ enabled: 'true' }, { bindAddresses: ['0.0.0.0'] }, { bindAddresses: [] }, { bindAddresses: ['8.8.8.8'] },
    { bindAddresses: '127.0.0.1' }, { bindAddresses: ['127.0.0.1', '127.0.0.1'] }, { bindAddresses: ['127.0.0.1', '192.168.50.4'] },
    { bindAddress: '127.0.0.1' }, { port: 1023 }, { port: 65536 }, { port: localPort }, { port: 1234.5 }, { other: true }]) {
    await assert.rejects(gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port, ...extra }), { statusCode: 400 });
  }
  await assert.rejects(gateway.updateSettings({ enabled: false, bindAddresses: ['192.168.50.4'], port }), { statusCode: 400 });
  assert.equal((await gateway.status()).running, true);
  await gateway.updateSettings({ enabled: false, bindAddresses: [], port });
  assert.equal((await gateway.status()).running, false);
  const store = await storage(t);
  await mkdir(path.dirname(store.settingsPath), { recursive: true });
  await writeFile(store.settingsPath, JSON.stringify(settings({ enabled: true, bindAddresses: ['192.168.1.2'], port })));
  const missing = createPhoneGateway({ localPort, asbVersion: '1.8.1', ...store, listAddresses: () => [] });
  const status = await missing.start();
  assert.equal(status.running, false);
  assert.equal(status.error, 'The phone address 192.168.1.2 is not on this PC now. ASB listens on it when it appears.');
  await writeFile(store.settingsPath, JSON.stringify(settings({ enabled: true, bindAddresses: ['192.168.1.2', '10.147.17.4'], port })));
  const both = createPhoneGateway({ localPort, asbVersion: '1.8.1', ...store, listAddresses: () => [] });
  assert.equal((await both.start()).error, 'The phone addresses 192.168.1.2, 10.147.17.4 are not on this PC now. ASB listens on them when they appear.');
});

gatewayTest('a busy port and missing openssl leave the listener off with a useful error', async (t) => {
  const { gateway, localPort, args, port } = await fixture(t, { enabled: false });
  const occupied = net.createServer();
  const busyPort = await listen(occupied);
  t.after(() => close(occupied));
  assert.equal((await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port: busyPort })).error, `Port ${busyPort} is in use.`);
  assert.equal((await gateway.status()).running, false);
  assert.equal((await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port })).running, true);
  await gateway.stop();
  const store = await storage(t);
  const missing = createPhoneGateway({ ...args, ...store, localPort, openssl: path.join(store.home, 'missing-openssl') });
  t.after(() => missing.stop());
  const failed = await missing.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port });
  assert.equal(failed.running, false);
  assert.equal(failed.error, 'ASB cannot create the phone certificate. Install openssl.');
  assert.equal(failed.fingerprint, '');
  const restarted = createPhoneGateway({ ...args, ...store, openssl: path.join(store.home, 'missing-openssl') });
  assert.equal((await restarted.start()).error, failed.error);
  assert.equal((await restarted.status()).running, false);
});

gatewayTest('the address check binds a selected address that appears later and restarts only when the set changes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const created = t.mock.method(https, 'createServer');
  const { args, port } = await fixture(t, { enabled: false });
  const store = await storage(t);
  await mkdir(path.dirname(store.settingsPath), { recursive: true });
  await writeFile(store.settingsPath, JSON.stringify(settings({ enabled: true, port, bindAddresses: ['127.0.0.1', '127.0.0.3'] })));
  const lan = { address: '127.0.0.1', interface: 'enp0s1', kind: 'lan' };
  const zerotier = { address: '127.0.0.3', interface: 'ztabcdef12', kind: 'zerotier' };
  let listed = [lan];
  const gateway = createPhoneGateway({ ...args, ...store, listAddresses: () => listed });
  t.after(() => gateway.stop());
  let status = await gateway.start();
  assert.deepEqual(status.listening, [{ kind: 'lan', address: '127.0.0.1' }]);
  assert.equal(status.error, 'The phone address 127.0.0.3 is not on this PC now. ASB listens on it when it appears.');
  const before = created.mock.callCount();
  t.mock.timers.tick(90_000);
  assert.deepEqual((await gateway.status()).listening, [{ kind: 'lan', address: '127.0.0.1' }]);
  assert.equal(created.mock.callCount(), before);
  // A saved address that is absent now stays selected when the user applies the settings again.
  status = await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1', '127.0.0.3'], port });
  assert.deepEqual(status.bindAddresses, ['127.0.0.1', '127.0.0.3']);
  listed = [lan, zerotier];
  t.mock.timers.tick(29_999);
  assert.equal((await gateway.status()).listening.length, 1);
  t.mock.timers.tick(1);
  status = await gateway.status();
  assert.deepEqual(status.listening, [{ kind: 'lan', address: '127.0.0.1' }, { kind: 'zerotier', address: '127.0.0.3' }]);
  assert.equal(status.error, '');
  listed = [lan];
  t.mock.timers.tick(30_000);
  status = await gateway.status();
  assert.deepEqual(status.listening, [{ kind: 'lan', address: '127.0.0.1' }]);
  assert.match(status.error, /127\.0\.0\.3 is not on this PC now/);
  await gateway.stop();
  const stopped = created.mock.callCount();
  listed = [lan, zerotier];
  t.mock.timers.tick(60_000);
  assert.equal((await gateway.status()).running, false);
  assert.equal(created.mock.callCount(), stopped);
});

gatewayTest('the address check retries a busy port or a missing openssl only when the addresses change', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const created = t.mock.method(https, 'createServer');
  let listed = loopback();
  const { args, localPort } = await fixture(t, { enabled: false, gateway: { listAddresses: () => listed } });
  const occupied = net.createServer();
  const busyPort = await listen(occupied);
  t.after(() => close(occupied));
  const busy = createPhoneGateway({ ...args, ...(await storage(t)) });
  t.after(() => busy.stop());
  await busy.start();
  assert.equal((await busy.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port: busyPort })).error, `Port ${busyPort} is in use.`);
  const count = created.mock.callCount();
  t.mock.timers.tick(120_000);
  assert.equal((await busy.status()).error, `Port ${busyPort} is in use.`);
  assert.equal(created.mock.callCount(), count);
  listed = [];
  t.mock.timers.tick(30_000);
  await busy.status();
  assert.equal(created.mock.callCount(), count);
  listed = loopback();
  t.mock.timers.tick(30_000);
  assert.equal((await busy.status()).error, `Port ${busyPort} is in use.`);
  assert.equal(created.mock.callCount(), count + 1);
  await busy.stop();
  const store = await storage(t);
  const log = path.join(store.home, 'openssl.log');
  const openssl = path.join(store.home, 'openssl');
  await writeFile(openssl, `#!/bin/sh\necho run >> '${log}'\nexit 1\n`);
  await chmod(openssl, 0o755);
  const missing = createPhoneGateway({ ...args, ...store, localPort, openssl });
  t.after(() => missing.stop());
  await missing.start();
  assert.equal((await missing.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port: await freePort() })).error,
    'ASB cannot create the phone certificate. Install openssl.');
  const runs = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
  t.mock.timers.tick(120_000);
  await missing.status();
  assert.equal(await runs(), 1);
  listed = [...loopback(), { address: '127.0.0.3', interface: 'ztabcdef12', kind: 'zerotier' }];
  await missing.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1', '127.0.0.3'], port: await freePort() });
  assert.equal(await runs(), 2);
  listed = loopback();
  t.mock.timers.tick(30_000);
  await missing.status();
  assert.equal(await runs(), 3);
});

gatewayTest('existing certificates are reused and a missing key replaces both TLS files', async (t) => {
  const { gateway, tlsDir, args } = await fixture(t);
  const old = (await gateway.status()).fingerprint;
  await gateway.stop();
  const restored = createPhoneGateway({ ...args, openssl: '/does-not-exist' });
  t.after(() => restored.stop());
  assert.equal((await restored.start()).fingerprint, old);
  assert.equal((await restored.status()).running, true);
  await restored.stop();
  await rm(path.join(tlsDir, 'key.pem'));
  assert.equal((await gateway.start()).running, true);
  assert.notEqual((await gateway.status()).fingerprint, old);
});

gatewayTest('a failed loopback request gives 502 and stopping closes TLS handshakes', async (t) => {
  const { gateway, local, request, pair, port } = await fixture(t);
  const token = (await pair()).json.token;
  await close(local);
  const response = await request('/phone/v1/dashboard', { token });
  assert.equal(response.status, 502);
  assert.equal(response.json.error, 'ASB is not answering.');
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await gateway.stop();
  await closed;
  assert.equal((await gateway.status()).running, false);
});

gatewayTest('stopping closes a pending proxy request and its loopback connection', async (t) => {
  const started = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const { gateway, request, pair } = await fixture(t, { reply: (request, response) => {
    response.on('close', disconnected.resolve);
    started.resolve();
  } });
  const token = (await pair()).json.token;
  const pending = assert.rejects(request('/phone/v1/dashboard', { token }));
  await started.promise;
  await gateway.stop();
  await pending;
  await disconnected.promise;
});

gatewayTest('the machine identity is the first 16 fingerprint characters, also while phone access is off', async (t) => {
  const store = await storage(t);
  const gateway = createPhoneGateway({ localPort: 4629, asbVersion: '1.8.1', ...store, listAddresses: loopback });
  t.after(() => gateway.stop());
  await gateway.start();
  assert.equal((await gateway.status()).enabled, false);
  const id = await gateway.identity();
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, (await gateway.status()).fingerprint.slice(0, 16));
  assert.equal(await gateway.identity(), id);
  const failing = await storage(t);
  const openssl = path.join(failing.home, 'openssl');
  await writeFile(openssl, '#!/bin/sh\nexit 1\n');
  await chmod(openssl, 0o755);
  const missing = createPhoneGateway({ localPort: 4629, asbVersion: '1.8.1', ...failing, openssl, listAddresses: loopback });
  t.after(() => missing.stop());
  await missing.start();
  assert.equal(await missing.identity(), '');
});

async function clientIdentity(dir, name) {
  const key = path.join(dir, `${name}-key.pem`);
  const cert = path.join(dir, `${name}-cert.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key,
    '-out', cert, '-days', '2', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  return { tls, fingerprint: sha256(new X509Certificate(tls.cert).raw) };
}

// The gateway with the real machine group behind its peer routes, on a 127.0.0.x address.
async function peerFixture(t, options = {}) {
  let fx;
  const store = await storage(t);
  const exportBoard = { threads: [{ id: 'codex:1', externalId: '1', provider: 'codex', title: 'Shared row', state: 'idle', remote: false }], messages: [] };
  const logs = [];
  const group = createMachineGroup({ file: path.join(store.home, 'group.json'), gateway: () => fx.gateway, addressOk: () => true,
    hostName: 'debian', log: (line) => logs.push(line),
    server: () => ({ dashboardForRequest: async () => group.merge(structuredClone(exportBoard)) }) });
  const address = options.address || '127.0.0.2';
  fx = await fixture(t, { enabled: false, gateway: { peer: { ...group.peer, ...options.relay }, onPhonePaired: group.onPhonePaired, onPhoneRevoked: group.onPhoneRevoked,
    listAddresses: () => [{ address, interface: 'lo', kind: 'lan' }] } });
  await fx.gateway.updateSettings({ enabled: true, bindAddresses: [address], port: fx.port });
  await group.start();
  t.after(() => group.stop());
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-peer-certs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [joiner, stranger] = await Promise.all([clientIdentity(dir, 'joiner'), clientIdentity(dir, 'stranger')]);
  const peer = (route, { as, ...rest } = {}) => fx.request(route, { host: address, ...(as ? { tls: as.tls } : {}), ...rest });
  const joinBody = (code, name = 'laptop') => ({ code, name, addresses: [{ kind: 'lan', address: '127.0.0.9' }], port: 4999 });
  const code = async () => new URL((await group.invite()).link.replace('asb://', 'https://')).searchParams.get('c');
  const pair = async (deviceName) => {
    const value = new URL((await fx.gateway.createPairing()).uri).searchParams.get('c');
    return fx.request('/phone/v1/pair', { host: address, method: 'POST', body: { code: value, deviceName } });
  };
  return { ...fx, group, logs, joiner, stranger, peer, joinBody, code, pair };
}

gatewayTest('the machine group gives hello its active members, with this engine at its live addresses', async (t) => {
  const { group, peer, joiner, joinBody, code, pair, port, request } = await peerFixture(t);
  const phone = (await pair('Pixel')).json;
  const alone = await request('/phone/v1/hello', { host: '127.0.0.2', token: phone.token });
  assert.deepEqual(alone.json.engines, []);
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  const status = await group.status();
  const hello = await request('/phone/v1/hello', { host: '127.0.0.2', token: phone.token });
  assert.equal(hello.json.machineId, status.self.machineId);
  assert.deepEqual(hello.json.engines, [
    { machineId: status.self.machineId, name: 'debian', port, fingerprint: hello.fingerprint, addresses: [{ kind: 'lan', address: '127.0.0.2' }] },
    { machineId: joiner.fingerprint.slice(0, 16), name: 'laptop', port: 4999, fingerprint: joiner.fingerprint, addresses: [{ kind: 'lan', address: '127.0.0.9' }] }]);
});

gatewayTest('peer routes need a member certificate; join takes any certificate with a valid code', async (t) => {
  const { group, peer, joiner, stranger, joinBody, code, gateway, logs } = await peerFixture(t);
  assert.equal((await peer('/peer/v1/hello')).status, 401);
  assert.equal((await peer('/peer/v1/hello', { as: joiner })).status, 401);
  assert.equal((await peer('/peer/v1/hello', { method: 'POST', as: joiner })).status, 405);
  const first = await code();
  const join = (body, as = joiner) => peer('/peer/v1/join', { method: 'POST', as, body });
  assert.deepEqual([(await peer('/peer/v1/join', { method: 'POST', body: joinBody(first) })).status], [401]);
  assert.equal((await join({ ...joinBody(first), extra: 1 })).status, 400);
  const wrong = await join(joinBody('x'.repeat(27)));
  assert.deepEqual([wrong.status, wrong.json.error], [401, 'This join code is not valid. Make a new invite.']);
  const taken = await join(joinBody(first, 'DEBIAN'));
  assert.deepEqual([taken.status, taken.json], [409, { error: 'Another machine in the group has this name.', suggestion: 'DEBIAN-2' }]);
  const invalid = await join(joinBody(first, 'my laptop'));
  assert.deepEqual([invalid.status, invalid.json.suggestion], [409, 'mylaptop']);
  const joined = await join(joinBody(first));
  assert.equal(joined.status, 200);
  const status = await group.status();
  assert.deepEqual(Object.keys(joined.json), ['groupId', 'group']);
  assert.equal(joined.json.groupId, status.groupId);
  assert.equal('self' in joined.json.group, false);
  assert.deepEqual(joined.json.group.members.map((item) => [item.name, item.machineId]),
    [['debian', status.self.machineId], ['laptop', joiner.fingerprint.slice(0, 16)]]);
  // One use.
  assert.equal((await join(joinBody(first, 'again'), stranger)).status, 401);
  // A member gets the member routes.
  const hello = await peer('/peer/v1/hello', { as: joiner });
  assert.deepEqual([hello.status, hello.json.machineId, hello.json.name, hello.json.groupId, hello.json.api, hello.json.asbVersion],
    [200, status.self.machineId, 'debian', status.groupId, 1, '']);
  assert.deepEqual((await peer('/peer/v1/group', { as: joiner })).json, joined.json.group);
  assert.equal((await peer('/peer/v1/group', { as: stranger })).status, 401);
  const again = await join(joinBody(await code(), 'other'));
  assert.deepEqual([again.status, again.json.error], [409, 'This machine is already in the group.']);
  // Leave adds a tombstone; the machine cannot come back with the same certificate.
  assert.equal((await peer('/peer/v1/leave', { method: 'POST', as: joiner, body: { x: 1 } })).status, 400);
  assert.deepEqual((await peer('/peer/v1/leave', { method: 'POST', as: joiner, body: {} })).json, { left: true });
  assert.equal((await peer('/peer/v1/hello', { as: joiner })).status, 410);
  const removed = await join(joinBody(await code(), 'laptop'));
  assert.deepEqual([removed.status, removed.json.error], [409, 'This machine was removed. Reset its identity and join again.']);
  assert.deepEqual((await group.status()).members.map((item) => item.name), ['debian']);
  // Eight wrong codes void the invite.
  const last = await code();
  for (let index = 0; index < 8; index += 1) assert.equal((await join(joinBody('y'.repeat(27)), stranger)).status, 401);
  assert.equal((await join(joinBody(last, 'stranger'), stranger)).status, 401);
  assert.equal((await gateway.credentials()).fingerprint, (await gateway.status()).fingerprint);
  assert.deepEqual(logs, []);
});

gatewayTest('a removed certificate gets 410 on the member routes, and 410 does not count toward the throttle', async (t) => {
  const { group, peer, joiner, stranger, joinBody, code } = await peerFixture(t);
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  await group.remove((await group.status()).members.find((item) => item.name === 'laptop').machineId);
  for (const [route, method] of [['/peer/v1/hello', 'GET'], ['/peer/v1/group', 'GET'], ['/peer/v1/sessions', 'GET'], ['/peer/v1/leave', 'POST']]) {
    const reply = await peer(route, { method, as: joiner, ...(method === 'POST' ? { body: {} } : {}) });
    assert.deepEqual([reply.status, reply.json], [410, { error: 'This machine was removed from the group.' }], route);
  }
  for (let index = 0; index < 25; index += 1) assert.equal((await peer('/peer/v1/sessions', { as: joiner })).status, 410);
  assert.equal((await peer('/peer/v1/hello', { as: stranger })).status, 401);
  const again = await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code(), 'laptop') });
  assert.deepEqual([again.status, again.json.error], [409, 'This machine was removed. Reset its identity and join again.']);
});

gatewayTest('the relay member routes need a member certificate, check methods, and take up to 2 MiB for deliver', async (t) => {
  const calls = [];
  const relay = { peers: async () => ({ status: 200, body: { peers: [] } }),
    deliver: async (value, fingerprint) => { calls.push([value, fingerprint]); return { status: 403, body: { error: 'The sender machine does not match.' } }; } };
  const { peer, joiner, stranger, joinBody, code } = await peerFixture(t, { address: '127.0.0.4', relay });
  assert.equal((await peer('/peer/v1/peers', { as: stranger })).status, 401);
  assert.equal((await peer('/peer/v1/deliver', { method: 'POST', as: stranger, body: {} })).status, 401);
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  const listed = await peer('/peer/v1/peers', { as: joiner });
  assert.deepEqual([listed.status, listed.json, listed.headers['cache-control']], [200, { peers: [] }, 'no-store']);
  assert.equal((await peer('/peer/v1/peers', { method: 'POST', as: joiner, body: {} })).status, 405);
  assert.equal((await peer('/peer/v1/deliver', { as: joiner })).status, 405);
  // A body above 64 KiB passes on deliver; the relay gets the caller's certificate fingerprint.
  const large = { text: 'x'.repeat(1_500_000) };
  const reply = await peer('/peer/v1/deliver', { method: 'POST', as: joiner, body: large });
  assert.deepEqual([reply.status, reply.json], [403, { error: 'The sender machine does not match.' }]);
  assert.deepEqual(calls, [[large, joiner.fingerprint]]);
  assert.equal((await peer('/peer/v1/deliver', { method: 'POST', as: joiner, body: { text: 'x'.repeat(2 * 1024 * 1024) } })).status, 413);
  assert.equal(calls.length, 1);
});

gatewayTest('the exact member routes exist only with their function, use the member checks, and take up to 2 MiB for deliver', async (t) => {
  const calls = [];
  const relay = { resolveExact: async (value, fingerprint) => { calls.push(['resolve', value, fingerprint]); return { status: 200, body: { api: 2, outcome: 'ready' } }; },
    deliverExact: async (value, fingerprint) => { calls.push(['deliver', value, fingerprint]); return { status: 400, body: { error: 'Invalid relay request.' } }; } };
  const { group, peer, joiner, stranger, joinBody, code } = await peerFixture(t, { address: '127.0.0.5', relay });
  for (const route of ['/peer/v2/resolve-session', '/peer/v2/deliver']) assert.equal((await peer(route, { method: 'POST', as: stranger, body: {} })).status, 401);
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  const resolved = await peer('/peer/v2/resolve-session', { method: 'POST', as: joiner, body: { api: 2 } });
  assert.deepEqual([resolved.status, resolved.json, resolved.headers['cache-control']], [200, { api: 2, outcome: 'ready' }, 'no-store']);
  for (const route of ['/peer/v2/resolve-session', '/peer/v2/deliver']) assert.equal((await peer(route, { as: joiner })).status, 405);
  assert.equal((await peer('/peer/v2/resolve-session', { method: 'POST', as: joiner, body: { text: 'x'.repeat(70 * 1024) } })).status, 413);
  const large = { text: 'x'.repeat(1_500_000) };
  assert.deepEqual((await peer('/peer/v2/deliver', { method: 'POST', as: joiner, body: large })).json, { error: 'Invalid relay request.' });
  assert.equal((await peer('/peer/v2/deliver', { method: 'POST', as: joiner, body: { text: 'x'.repeat(2 * 1024 * 1024) } })).status, 413);
  assert.deepEqual(calls, [['resolve', { api: 2 }, joiner.fingerprint], ['deliver', large, joiner.fingerprint]]);
  // Every other /peer/v2 path is not a route.
  for (const route of ['/peer/v2/capabilities', '/peer/v2/peers', '/peer/v2/hello', '/peer/v2/deliver/x', '/peer/v2/']) {
    assert.equal((await peer(route, { method: 'POST', as: joiner, body: {} })).status, 404, route);
  }
  await group.remove((await group.status()).members.find((item) => item.name === 'laptop').machineId);
  for (const route of ['/peer/v2/resolve-session', '/peer/v2/deliver']) {
    assert.equal((await peer(route, { method: 'POST', as: joiner, body: {} })).status, 410, route);
  }
  assert.equal(calls.length, 2);
});

gatewayTest('an engine without the exact functions has no v2 routes: 404', async (t) => {
  const { peer, joiner, joinBody, code } = await peerFixture(t, { address: '127.0.0.6', relay: { resolveExact: async () => ({ status: 200, body: {} }) } });
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  assert.equal((await peer('/peer/v2/deliver', { method: 'POST', as: joiner, body: {} })).status, 404);
  assert.equal((await peer('/peer/v2/resolve-session', { method: 'POST', as: joiner, body: {} })).status, 200);
  const old = await peerFixture(t, { address: '127.0.0.7' });
  assert.equal((await old.peer('/peer/v1/join', { method: 'POST', as: old.joiner, body: old.joinBody(await old.code()) })).status, 200);
  for (const route of ['/peer/v2/resolve-session', '/peer/v2/deliver']) assert.equal((await old.peer(route, { method: 'POST', as: old.joiner, body: {} })).status, 404);
});

gatewayTest('a non-member certificate counts toward the throttle on peer routes', async (t) => {
  const { peer, stranger, advance } = await peerFixture(t);
  for (let index = 0; index < 20; index += 1) assert.equal((await peer('/peer/v1/sessions', { as: stranger })).status, 401);
  assert.equal((await peer('/peer/v1/sessions', { as: stranger })).status, 429);
  advance(60_000);
  assert.equal((await peer('/peer/v1/sessions', { as: stranger })).status, 401);
});

gatewayTest('the sessions route gives 304 for the same tag and gzip when the member accepts it', async (t) => {
  const { peer, joiner, joinBody, code } = await peerFixture(t, { address: '127.0.0.3' });
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  const plain = await peer('/peer/v1/sessions', { as: joiner });
  assert.deepEqual([plain.status, plain.headers.vary, plain.headers['content-encoding'], plain.headers['cache-control']],
    [200, 'Accept-Encoding', undefined, 'no-store']);
  assert.deepEqual([plain.json.api, plain.json.name, plain.json.rows.map((row) => row.title)], [1, 'debian', ['Shared row']]);
  assert.match(plain.headers.etag, /^"[a-f0-9]{64}"$/);
  const zipped = await peer('/peer/v1/sessions', { as: joiner, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(zipped.raw)).rows, plain.json.rows);
  const cached = await peer('/peer/v1/sessions', { as: joiner, headers: { 'if-none-match': plain.headers.etag } });
  assert.deepEqual([cached.status, cached.text, cached.headers.etag], [304, '', plain.headers.etag]);
});

gatewayTest('the gateway keeps the connection of the peer client between GET requests and keeps idle ones longer than the client does', async (t) => {
  // Every https listener that the gateway makes while the fixture starts.
  const servers = [];
  const create = https.createServer;
  https.createServer = (...args) => { const server = create.apply(https, args); servers.push(server); return server; };
  let fx;
  try { fx = await peerFixture(t, { address: '127.0.0.5' }); } finally { https.createServer = create; }
  const { peer, joiner, joinBody, code, gateway, port } = fx;
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  let connections = 0;
  for (const server of servers) server.on('secureConnection', () => { connections += 1; });
  const { fingerprint } = await gateway.credentials();
  const member = { machineId: fingerprint.slice(0, 16), certFingerprint: fingerprint, port, addresses: [{ kind: 'lan', address: '127.0.0.5' }] };
  t.after(() => closePeerAgents(fingerprint));
  const statuses = [];
  for (const route of ['/peer/v1/hello', '/peer/v1/group', '/peer/v1/sessions', '/peer/v1/sessions', '/peer/v1/hello']) {
    statuses.push((await peerRequest({ member, path: route, tls: joiner.tls })).status);
  }
  assert.deepEqual([statuses, connections], [[200, 200, 200, 200, 200], 1]);
  assert.ok(servers.length > 0 && servers.every((server) => server.keepAliveTimeout > PEER_IDLE_SOCKET_MS), String(servers.map((server) => server.keepAliveTimeout)));
});

gatewayTest('a group phone token works on the phone routes, and pairing and revoking follow the group', async (t) => {
  const { group, request, pair, gateway, records } = await peerFixture(t);
  const peerless = await fixture(t);
  assert.equal((await peerless.request('/peer/v1/hello')).status, 404);
  const before = (await pair('Before')).json;
  await group.invite();
  assert.deepEqual((await group.status()).phones.map((item) => item.name), ['Before']);
  const token = randomBytes(32).toString('base64url');
  await group.onPhonePaired({ id: 'abcdefabcdef', name: 'Shared', tokenSha256: sha256(token), createdAtMs: 1 });
  const hello = await request('/phone/v1/hello', { host: '127.0.0.2', token });
  assert.deepEqual([hello.status, hello.json.deviceId], [200, 'abcdefabcdef']);
  assert.equal((await request('/phone/v1/dashboard', { host: '127.0.0.2', token })).status, 200);
  assert.equal(records.at(-1).url, '/api/dashboard');
  assert.deepEqual((await gateway.status()).devices.map((item) => item.name), ['Before']);
  // A phone paired while in the group joins the group list; a revoked phone gets a tombstone.
  const after = (await pair('After')).json;
  assert.equal((await request('/phone/v1/hello', { host: '127.0.0.2', token: after.token })).status, 200);
  assert.deepEqual((await group.status()).phones.map((item) => item.name), ['Before', 'Shared', 'After']);
  assert.deepEqual((await gateway.devices()).map((item) => Object.keys(item).sort()), Array(2).fill(['createdAtMs', 'id', 'name', 'tokenSha256']));
  await gateway.revokeDevice(before.deviceId);
  assert.deepEqual((await group.status()).phones.map((item) => item.name), ['Shared', 'After']);
  assert.equal((await request('/phone/v1/hello', { host: '127.0.0.2', token: before.token })).status, 401);
});

gatewayTest('the member route /peer/v1/bridge gives the reply of peer.bridge to members only, and is 404 without it', async (t) => {
  let calls = 0;
  const relay = { bridge: async () => { calls += 1; return { status: 200, body: { api: 1, apps: [] } }; } };
  const { group, peer, joiner, stranger, joinBody, code } = await peerFixture(t, { address: '127.0.0.11', relay });
  assert.equal((await peer('/peer/v1/bridge', { as: stranger })).status, 401);
  assert.equal((await peer('/peer/v1/join', { method: 'POST', as: joiner, body: joinBody(await code()) })).status, 200);
  const reply = await peer('/peer/v1/bridge', { as: joiner });
  assert.deepEqual([reply.status, reply.json, reply.headers['cache-control']], [200, { api: 1, apps: [] }, 'no-store']);
  const post = await peer('/peer/v1/bridge', { method: 'POST', as: joiner, body: {} });
  assert.deepEqual([post.status, post.headers.allow], [405, 'GET']);
  assert.equal(calls, 1);
  await group.remove((await group.status()).members.find((item) => item.name === 'laptop').machineId);
  assert.equal((await peer('/peer/v1/bridge', { as: joiner })).status, 410);
  assert.equal(calls, 1);
  const old = await peerFixture(t, { address: '127.0.0.12' });
  assert.equal((await old.peer('/peer/v1/join', { method: 'POST', as: old.joiner, body: old.joinBody(await old.code()) })).status, 200);
  const missing = await old.peer('/peer/v1/bridge', { as: old.joiner });
  assert.deepEqual([missing.status, missing.json], [404, { error: 'Route is not available.' }]);
});
