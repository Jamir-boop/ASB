import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
  const { request, pair, port } = await fixture(t);
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
  assert.deepEqual(response.json, { api: 1, asbVersion: '1.8.1', deviceId: paired.deviceId, serverName: 'Test PC & lab',
    addresses: [{ kind: 'lan', address: '127.0.0.1' }], port });
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
  for (const route of ['/phone/v1/sources', '/api/dashboard', '/api/palette', '/phone/v1/palette', '/phone/v1/threads/x/delete', '/phone/v1/settings/phone',
    '/phone/v1/threads//open', `/phone/v1/threads/${'x'.repeat(513)}/open`, '/phone/v1/threads/x/y/open']) {
    const response = await request(route, { method: 'POST', token, body: {} });
    assert.equal(response.status, 404, route);
    assert.equal(response.json.error, 'Route is not available.');
  }
  for (const route of ['/api/sources', '/api/phone', '/api/phone/settings', '/api/palette']) {
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
  assert.equal(status.error, 'The phone address 192.168.50.4 is not on this PC now. Choose another address.');
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
  assert.equal(status.error, 'The phone address 192.168.1.2 is not on this PC now. Choose another address.');
  await writeFile(store.settingsPath, JSON.stringify(settings({ enabled: true, bindAddresses: ['192.168.1.2', '10.147.17.4'], port })));
  const both = createPhoneGateway({ localPort, asbVersion: '1.8.1', ...store, listAddresses: () => [] });
  assert.equal((await both.start()).error, 'The phone addresses 192.168.1.2, 10.147.17.4 are not on this PC now. Choose other addresses.');
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
