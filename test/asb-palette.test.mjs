import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAsbServer } from '../src/asb-server.mjs';

const gnome = { mode: 'gnome', colors: { background: '#242424', text: '#FFFFFF', accent: '#78AEED', muted: '#c8c8c8',
  divider: '#5b5b5b', success: '#8ff0a4', warning: '#f8e45c' } };
const lower = { mode: 'gnome', colors: { ...gnome.colors, text: '#ffffff', accent: '#78aeed' } };

async function serve(t, palettePath) {
  const server = createAsbServer({ sourceToken: 'window-token', palettePath, dashboardWatchPaths: [],
    loadDashboard: async () => ({ providers: [], threads: [] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', body = {}, token = 'window-token', origin = base, headers = {} } = {}) => new Promise((resolve, reject) => {
    const client = http.request(`${base}${route}`, { method, agent: false,
      headers: { ...(token ? { 'x-asb-source-token': token } : {}), ...(method === 'POST' && origin ? { origin } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, etag: response.headers.etag, json: () => JSON.parse(text) });
      });
    });
    client.on('error', reject);
    client.end(method === 'POST' ? typeof body === 'string' ? body : JSON.stringify(body) : undefined);
  });
  const publish = (body, options = {}) => request('/api/palette', { method: 'POST', body, ...options });
  return { base, request, publish };
}

async function temporaryPath(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-palette-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'state', 'asb', 'palette.json');
}

test('the palette route needs the window token, the ASB origin, and POST', async (t) => {
  const palettePath = await temporaryPath(t);
  const { request, publish } = await serve(t, palettePath);
  assert.equal((await publish(gnome, { token: '' })).status, 403);
  assert.equal((await publish(gnome, { token: 'other-token' })).status, 403);
  assert.equal((await publish(gnome, { origin: 'http://127.0.0.1:1' })).status, 403);
  assert.equal((await publish(gnome, { origin: null })).status, 403);
  assert.equal((await publish(gnome, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/palette')).status, 405);
  assert.equal((await publish(gnome, { headers: { host: 'localhost' } })).status, 403);
  await assert.rejects(stat(palettePath), { code: 'ENOENT' });
  assert.equal((await request('/api/dashboard')).json().palette, null);
});

test('the palette route accepts only an exact palette', async (t) => {
  const palettePath = await temporaryPath(t);
  const { publish } = await serve(t, palettePath);
  const invalid = [
    null, [], 'text', {}, { mode: 'gnome' }, { colors: gnome.colors },
    { ...gnome, extra: true }, { ...gnome, mode: 'dark' }, { ...gnome, colors: [] },
    { ...gnome, colors: { ...gnome.colors, extra: '#000000' } },
    { ...gnome, colors: Object.fromEntries(Object.entries(gnome.colors).filter(([key]) => key !== 'warning')) },
    ...['#fff', '#12345g', '123456', '#1234567', 'red', 0, null].map((value) => ({ ...gnome, colors: { ...gnome.colors, success: value } })),
  ];
  for (const body of invalid) assert.equal((await publish(body)).status, 400, JSON.stringify(body));
  assert.equal((await publish('{bad json')).status, 400);
  await assert.rejects(stat(palettePath), { code: 'ENOENT' });
});

test('a palette is saved lowercase with mode 0600, reported in the dashboard, and read again after a restart', async (t) => {
  const palettePath = await temporaryPath(t);
  const first = await serve(t, palettePath);
  const before = await first.request('/api/dashboard');
  assert.equal(before.json().palette, null);
  const events = await new Promise((resolve, reject) => {
    http.get(`${first.base}/api/events`, { agent: false }, resolve).on('error', reject);
  });
  let stream = '';
  const paletteEvent = new Promise((resolve) => events.on('data', (chunk) => {
    stream += chunk;
    if (stream.includes('"reason":"asb-palette"')) resolve();
  }));
  assert.deepEqual((await first.publish(gnome)).json(), { changed: true });
  await paletteEvent;
  events.destroy();
  assert.deepEqual(JSON.parse(await readFile(palettePath, 'utf8')), lower);
  assert.equal((await stat(palettePath)).mode & 0o777, 0o600);
  const after = await first.request('/api/dashboard');
  assert.deepEqual(after.json().palette, lower);
  assert.notEqual(after.etag, before.etag);
  assert.equal((await first.request('/api/dashboard', { headers: { 'if-none-match': after.etag } })).status, 304);
  assert.deepEqual((await first.publish(lower)).json(), { changed: false });
  const custom = { mode: 'custom', colors: { ...lower.colors, success: '#78aeed', warning: '#78aeed' } };
  assert.deepEqual((await first.publish(custom)).json(), { changed: true });
  assert.notEqual((await first.request('/api/dashboard')).etag, after.etag);

  const second = await serve(t, palettePath);
  assert.deepEqual((await second.request('/api/dashboard')).json().palette, custom);
});

test('a bad palette file gives a null palette and one warning, and the next publish replaces it', async (t) => {
  const palettePath = await temporaryPath(t);
  await mkdir(path.dirname(palettePath), { recursive: true });
  for (const content of ['{bad json', JSON.stringify({ ...lower, colors: { ...lower.colors, text: 'white' } })]) {
    await writeFile(palettePath, content, { mode: 0o600 });
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    const { request, publish } = await serve(t, palettePath);
    t.mock.restoreAll();
    assert.equal(warnings.length, 1);
    assert.equal((await request('/api/dashboard')).json().palette, null);
    assert.deepEqual((await publish(gnome)).json(), { changed: true });
    assert.deepEqual(JSON.parse(await readFile(palettePath, 'utf8')), lower);
  }
});
