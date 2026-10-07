import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { createSwitchboardServer, openSwitchboardThread } from '../src/switchboard.mjs';

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
      assert.deepEqual(result, {
        opened: true, method: codex ? 'codex-deeplink' : 'claude-desktop-deeplink',
        resumeCommand: codex ? `codex resume --no-alt-screen '${id}'`
          : thread.externalId.startsWith('local_') ? `open '${thread.appDeepLink}'` : `open ${thread.appDeepLink}`,
      });
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

test('the retained switchboardOnly option keeps injected notifications while ASB disables them', async (t) => {
  for (const asb of [false, true]) {
    let refreshes = 0;
    const updates = [];
    const monitored = Promise.withResolvers();
    const notifications = { summary: { activeCount: 1 }, items: [{ id: 'notice', status: 'active' }] };
    const options = {
      switchboardOnly: true, pendingStatePath: false, dashboardWatchPaths: [],
      reviewStore: null, searchIndex: null, monitorNotifications: true, notificationScanIntervalMs: 60_000,
      now: () => 1_000,
      loadDashboard: async () => ({ providers: [], summary: {}, threads: [{ ...sessions[0], state: 'idle' }] }),
      openThread: async () => ({ opened: true }),
      notificationCenter: {
        refresh: async () => { refreshes += 1; monitored.resolve(); return notifications; },
        updateNotification: async (notificationId, body) => {
          updates.push({ notificationId, body });
          return { id: notificationId, ...body };
        },
      },
    };
    const server = asb ? createSwitchboardServer(options) : createServer(options);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    if (!asb) await monitored.promise;
    const base = `http://127.0.0.1:${server.address().port}`;
    const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(refreshes, asb ? 0 : 1);
    assert.deepEqual(dashboard.notifications, asb ? undefined : notifications);
    assert.equal(dashboard.performance.notifications.refreshCount, asb ? 0 : 1);
    const opened = await (await fetch(`${base}/api/threads/${id}/open`, {
      method: 'POST', headers: { Origin: base }, body: JSON.stringify({ markNotificationDone: true, notificationId: 'notice' }),
    })).json();
    assert.equal(opened.opened, true);
    assert.deepEqual(opened.notification, asb ? undefined : { id: 'notice', status: 'done' });
    assert.deepEqual(updates, asb ? [] : [{ notificationId: 'notice', body: { status: 'done' } }]);
  }
});
