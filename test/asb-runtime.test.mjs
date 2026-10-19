import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAsbServer } from '../src/asb-server.mjs';
import { runOpener, scopedCommand } from '../src/session-opener.mjs';
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
      assert.deepEqual(calls, [[command, args, { timeout: 5000 }]]);
    }
  }
});

test('openers under systemd run in their own user scope', () => {
  const wrapped = ['systemd-run', '--user', '--scope', '--collect', '--quiet', '--', 'xdg-open', 'claude://code/x'];
  assert.deepEqual(scopedCommand('xdg-open', ['claude://code/x'], { env: { INVOCATION_ID: 'abc' }, platform: 'linux' }),
    { command: wrapped[0], args: wrapped.slice(1) });
  assert.deepEqual(scopedCommand('xdg-open', ['claude://code/x'], { env: {}, platform: 'linux' }), { command: 'xdg-open', args: ['claude://code/x'] });
  assert.deepEqual(scopedCommand('open', ['claude://code/x'], { env: { INVOCATION_ID: 'abc' }, platform: 'darwin' }), { command: 'open', args: ['claude://code/x'] });
});

// The fake opener runs outside systemd, so no real scope starts.
async function openerFixture(t, body) {
  const invocation = Object.hasOwn(process.env, 'INVOCATION_ID') ? process.env.INVOCATION_ID : undefined;
  delete process.env.INVOCATION_ID;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-opener-'));
  t.after(async () => {
    if (invocation !== undefined) process.env.INVOCATION_ID = invocation;
    // Only the app that this fake opener started, also after a timeout; then the folder.
    const pid = Number(await readFile(path.join(dir, 'app.pid'), 'utf8').catch(() => ''));
    if (pid > 0) try { process.kill(pid); } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const script = path.join(dir, 'opener');
  await writeFile(script, `#!/bin/sh\n${body}\n`);
  await chmod(script, 0o755);
  return { dir, script };
}

test('an opener that starts a long-running app finishes when the opener exits', { timeout: 5000 }, async (t) => {
  // The app inherits the opener's stdio, as xdg-open passes it to Claude Desktop or ChatGPT.
  const { dir, script } = await openerFixture(t, 'sleep 30 &\necho "$!" > "$1"\necho output\nexit 0');
  const pidFile = path.join(dir, 'app.pid');
  const started = Date.now();
  await runOpener(script, [pidFile], { timeout: 5000 });
  assert.ok(Date.now() - started < 2000, `The open took ${Date.now() - started} ms.`);
});

test('a failed opener rejects with its exit code', async (t) => {
  const { script } = await openerFixture(t, 'exit 4');
  await assert.rejects(runOpener(script, [], { timeout: 5000 }), /exit code 4/);
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
