import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAsbServer } from '../src/asb-server.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';

const deviceId = 'a1b2c3d4e5f6';
const routes = [
  ['/api/phone', 'GET'], ['/api/service', 'GET'], ['/api/phone/settings', 'POST'],
  ['/api/phone/pairing', 'POST'], [`/api/phone/devices/${deviceId}/revoke`, 'POST'],
];
const configuration = { enabled: true, bindAddresses: ['192.168.50.4', '100.101.102.103'], port: 4630 };
function fakeGateway() {
  let state = { ...configuration, addresses: [{ address: '192.168.50.4', interface: 'enp0s1', kind: 'lan' },
    { address: '10.147.17.4', interface: 'ztabcdef12', kind: 'zerotier' },
    { address: '100.101.102.103', interface: 'tailscale0', kind: 'tailscale' }], running: true,
    error: '', warning: '', fingerprint: 'b'.repeat(64),
    devices: [{ id: deviceId, name: 'Phone', createdAtMs: 1, lastSeenAtMs: 2 }], pairing: { expiresAtMs: 0 } };
  const calls = [];
  const pairing = { uri: 'asb://pair?v=2&a=lan%3A192.168.50.4&c=synthetic', expiresAtMs: 600_000 };
  const gateway = {
    status: async () => { calls.push(['status']); return structuredClone(state); },
    updateSettings: async (value) => { calls.push(['settings', value]); state = { ...state, ...value }; return structuredClone(state); },
    createPairing: async () => { calls.push(['pairing']); return pairing; },
    revokeDevice: async (id) => { calls.push(['revoke', id]); state.devices = state.devices.filter((device) => device.id !== id); return structuredClone(state); },
  };
  return { gateway, calls, pairing };
}

async function serve(t, { sourceToken = 'window-token', phoneGateway = null, serviceMode = false, switchboard = false } = {}) {
  let loads = 0;
  const server = (switchboard ? createSwitchboardServer : createAsbServer)({ phoneGateway, sourceToken, serviceMode,
    pendingStatePath: false, loadDashboard: async () => { loads += 1; return { providers: [], threads: [] }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const request = (route, { method = 'GET', body = {}, token = sourceToken, origin = base, headers = {} } = {}) => new Promise((resolve, reject) => {
    const client = http.request(`${base}${route}`, { method, agent: false,
      headers: { ...(token ? { 'x-asb-source-token': token } : {}), ...(method === 'POST' && origin !== null ? { origin } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: new Headers(response.headers),
          json: async () => JSON.parse(text), text: async () => text });
      });
    });
    client.on('error', reject);
    client.end(method === 'POST' ? typeof body === 'string' ? body : JSON.stringify(body) : undefined);
  });
  return { request, base, port, loads: () => loads };
}

test('phone status, settings, pairing, revoke, and service routes return the gateway response shapes', async (t) => {
  const { gateway, calls, pairing } = fakeGateway();
  const { request, loads } = await serve(t, { phoneGateway: gateway, switchboard: true });
  const status = await request('/api/phone');
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const initial = await status.json();
  assert.equal(initial.devices[0].id, deviceId);
  assert.equal(initial.changed, undefined);
  const changed = await request('/api/phone/settings', { method: 'POST', body: configuration });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), initial);
  const created = await request('/api/phone/pairing', { method: 'POST' });
  assert.deepEqual(await created.json(), pairing);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const revoked = await request(`/api/phone/devices/${deviceId}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await revoked.json()).devices, []);
  assert.deepEqual(await (await request('/api/service')).json(), { service: false, pid: process.pid });
  assert.deepEqual(calls, [['status'], ['status'], ['settings', configuration], ['pairing'], ['revoke', deviceId]]);
  assert.equal(loads(), 0);
});

test('all phone and service routes are absent without a gateway', async (t) => {
  const { request } = await serve(t, { serviceMode: true });
  for (const [route, method] of routes) assert.equal((await request(route, { method })).status, 404, route);
});

test('phone GET and POST routes require the window token when set', async (t) => {
  for (const sourceToken of ['window-token', '']) {
    const { gateway, calls } = fakeGateway();
    const { request } = await serve(t, { phoneGateway: gateway, sourceToken });
    for (const [route, method] of routes) {
      for (const token of ['', 'window-tokem', 'window-token-long']) {
        const response = await request(route, { method, token, body: configuration });
        if (sourceToken) {
          assert.equal(response.status, 403, `${method} ${route}`);
          assert.deepEqual(await response.json(), { error: 'Use phone access settings from the ASB window.' });
        } else assert.notEqual(response.status, 403, route);
      }
    }
    if (sourceToken) assert.deepEqual(calls, []);
    assert.equal((await request('/api/phone')).status, 200);
  }
});

test('phone GET routes apply Host, Origin and Sec-Fetch-Site checks before calling the gateway', async (t) => {
  const { gateway, calls } = fakeGateway();
  const { request, base } = await serve(t, { phoneGateway: gateway });
  for (const route of ['/api/phone', '/api/service']) {
    for (const headers of [{ host: 'example.invalid' }, { origin: 'https://example.invalid' },
      { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await request(route, { headers })).status, 403, JSON.stringify(headers));
    }
  }
  assert.deepEqual(calls, []);
  for (const headers of [{}, { origin: base }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
    assert.equal((await request('/api/phone', { headers })).status, 200);
  }
});

test('phone POST routes require local Host and Origin and reject cross-site requests', async (t) => {
  const { gateway, calls } = fakeGateway();
  const { request } = await serve(t, { phoneGateway: gateway });
  for (const [route, method] of routes.filter(([, method]) => method === 'POST')) {
    for (const extra of [{ origin: null }, { origin: 'https://example.invalid' }, { headers: { host: 'example.invalid' } },
      { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { 'sec-fetch-site': 'same-site' } }, { headers: { 'sec-fetch-site': 'none' } }]) {
      assert.equal((await request(route, { method, body: configuration, ...extra })).status, 403, `${route}: ${JSON.stringify(extra)}`);
    }
  }
  assert.deepEqual(calls, []);
  for (const headers of [{}, { 'sec-fetch-site': 'same-origin' }]) {
    assert.equal((await request('/api/phone/settings', { method: 'POST', body: configuration, headers })).status, 200);
  }
});

test('phone and service routes reject unsupported methods', async (t) => {
  const { gateway, calls } = fakeGateway();
  const { request } = await serve(t, { phoneGateway: gateway });
  for (const [route, allowed] of routes) {
    const response = await request(route, { method: allowed === 'GET' ? 'POST' : 'GET' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allowed);
  }
  assert.deepEqual(calls, []);
});

test('phone POST bodies reject malformed JSON, non-objects and unknown fields', async (t) => {
  const { gateway, calls } = fakeGateway();
  const { request } = await serve(t, { phoneGateway: gateway });
  for (const [route, method] of routes.filter(([, method]) => method === 'POST')) {
    for (const body of ['{', 'null', '[]', 'false', '"text"', '{"extra":true}', '{"enabled":true}']) {
      const response = await request(route, { method, body });
      assert.equal(response.status, 400, `${route}: ${body}`);
      assert.deepEqual(await response.json(), { error: 'Invalid phone action.' });
    }
  }
  assert.deepEqual(calls, []);
  assert.equal((await request('/api/phone/devices/../revoke', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/phone/devices/ABCDEF123456/revoke', { method: 'POST' })).status, 404);
});

test('phone settings validate booleans, available addresses, port bounds and the ASB port', async (t) => {
  const { gateway, calls } = fakeGateway();
  const { request, port } = await serve(t, { phoneGateway: gateway });
  for (const extra of [{ enabled: 1 }, { enabled: null }, { bindAddresses: '192.168.50.4' }, { bindAddresses: [1] }, { bindAddresses: [] },
    { bindAddresses: ['0.0.0.0'] }, { bindAddresses: ['8.8.8.8'] }, { bindAddresses: ['192.168.50.4', '192.168.50.5'] },
    { bindAddresses: ['192.168.50.4', '192.168.50.4'] }, { bindAddresses: Array(9).fill('192.168.50.4') },
    { bindAddress: '192.168.50.4' }, { port: 1023 }, { port: 65536 }, { port: 4630.5 }, { port: '4630' }, { port }, { extra: true }]) {
    assert.equal((await request('/api/phone/settings', { method: 'POST', body: { ...configuration, ...extra } })).status, 400, JSON.stringify(extra));
  }
  assert.equal(calls.some(([action]) => action === 'settings'), false);
  for (const body of [{ enabled: false, bindAddresses: [], port: 1024 }, { enabled: false, bindAddresses: ['10.147.17.4'], port: 1024 },
    { ...configuration, port: 65535 }]) {
    assert.equal((await request('/api/phone/settings', { method: 'POST', body })).status, 200);
  }
});

test('phone API preserves user errors and hides internal gateway errors', async (t) => {
  const { gateway } = fakeGateway();
  const { request } = await serve(t, { phoneGateway: gateway });
  gateway.createPairing = async () => { throw Object.assign(new Error('Turn on phone access first.'), { statusCode: 400 }); };
  const invalid = await request('/api/phone/pairing', { method: 'POST' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'Turn on phone access first.' });
  for (const action of ['status', 'updateSettings', 'revokeDevice']) gateway[action] = async () => { throw new Error('Private path and token'); };
  for (const [route, method] of [['/api/phone', 'GET'], ['/api/phone/settings', 'POST'], [`/api/phone/devices/${deviceId}/revoke`, 'POST']]) {
    const response = await request(route, { method, body: route.endsWith('/settings') ? configuration : {} });
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes('Private'), false);
  }
});

test('service metadata uses the serviceMode option', async (t) => {
  const { request } = await serve(t, { phoneGateway: fakeGateway().gateway, serviceMode: true });
  assert.deepEqual(await (await request('/api/service')).json(), { service: true, pid: process.pid });
});
