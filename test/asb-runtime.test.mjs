import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAsbServer } from '../src/asb-server.mjs';
import { openSwitchboardThread } from '../src/switchboard.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const localId = `local_${id}`;
const sessions = [
  { id, provider: 'codex', canOpen: true, appDeepLink: `codex://threads/${id}` },
  { id: `claude:${localId}`, externalId: localId, provider: 'claude-desktop-code', canOpen: true,
    appDeepLink: `claude://code/continue?session=${localId}` },
  ...['cse_observed-session', 'session_observed-session'].map((externalId) => ({
    id: `claude:${externalId}`, externalId, provider: 'claude-desktop-code', canOpen: true,
    appDeepLink: `claude://code/${externalId}`,
  })),
];

test('ASB keeps all validated existing-session URL commands and opener results', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const thread of sessions) {
      const calls = [];
      const result = await openSwitchboardThread(thread, { platform, runCommand: async (...args) => calls.push(args) });
      const codex = thread.provider === 'codex';
      assert.deepEqual([result.opened, result.method], [true, codex ? 'codex-deeplink' : 'claude-desktop-deeplink']);
      if (codex) assert.deepEqual(Object.keys(result), ['opened', 'method']);
      const command = platform === 'linux' ? 'xdg-open' : platform === 'darwin' ? 'open' : 'cmd';
      const args = platform === 'win32' ? ['/c', 'start', '', thread.appDeepLink] : [thread.appDeepLink];
      assert.deepEqual(calls, [codex ? [command, args, { timeout: 5000 }] : [command, args]]);
    }
  }
});

test('ASB rejects changed IDs, providers, links, and unavailable opens before it runs a command', async () => {
  const invalid = sessions.flatMap((thread) => [
    { ...thread, canOpen: false },
    { ...thread, appDeepLink: 'https://example.com' },
    { ...thread, appDeepLink: `${thread.appDeepLink}?command=bad` },
    { ...thread, provider: 'opencode' },
    thread.provider === 'codex' ? { ...thread, id: 'unknown' } : { ...thread, externalId: 'unknown' },
  ]);
  let calls = 0;
  for (const thread of invalid) {
    await assert.rejects(openSwitchboardThread(thread, { runCommand: async () => { calls += 1; } }), /no direct desktop link/);
  }
  assert.equal(calls, 0);
});

const status = (base, route, headers = {}) => new Promise((resolve, reject) => {
  const request = http.get(base + route, { headers }, (response) => {
    resolve(response.statusCode);
    response.destroy();
  });
  request.on('error', reject);
});

test('ASB read APIs reject cross-site requests before source loading and preserve native/browser reads', async (t) => {
  let loads = 0;
  let sourceLists = 0;
  const server = createAsbServer({ dashboardWatchPaths: [],
    loadDashboard: async () => { loads += 1; return { providers: [], threads: [] }; },
    listSources: async () => { sourceLists += 1; return { sources: [] }; },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const routes = ['/api/dashboard', '/api/dashboard?force=1', '/api/sources', '/api/events'];
  const blocked = [
    { Origin: 'https://example.com' }, { Origin: 'null' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': '' },
    { Origin: base, 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const route of routes) for (const headers of blocked) assert.equal(await status(base, route, headers), 403);
  assert.equal(loads, 0);
  assert.equal(sourceLists, 0);
  assert.equal(await status(base, '/api/dashboard'), 200);
  assert.equal(loads, 1);
  for (const route of routes) for (const headers of [{}, { Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    { 'Sec-Fetch-Site': 'none' }, { Origin: base }]) assert.equal(await status(base, route, headers), 200);
  const beforeAssets = loads;
  assert.equal(await status(base, '/', { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' }), 200);
  assert.equal(await status(base, '/switchboard.js', { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' }), 200);
  assert.equal(loads, beforeAssets);
});
