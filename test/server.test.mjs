import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createServer,
  defaultDashboardWatchPaths,
  hideInstalledPwaApp,
  openThreadInCodexCli,
  openThreadInProvider,
} from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
    server.once('error', reject);
  });
}

test('serves dashboard json from injected loader', async () => {
  const server = createServer({
    loadDashboard: async () => ({
      summary: { activeThreads: 1, inboxCount: 1 },
      threads: [{ id: 'abc', title: 'Thread' }],
      projects: [{ projectName: 'demo' }],
      inbox: [{ id: 'abc', reason: 'recent activity' }],
    }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/dashboard`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.summary.activeThreads, 1);
    assert.equal(body.threads[0].title, 'Thread');
    assert.equal(body.inbox[0].reason, 'recent activity');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('accepts only sanitized Bailian snapshots from Chrome extension origins', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'amc-bailian-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'bailian-quota.json');
  const nowMs = Date.parse('2026-08-21T10:30:00.000Z');
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const server = createServer({
    bailianQuotaCachePath: cachePath,
    now: () => nowMs,
  });
  const address = await listen(server);
  const url = `http://${address.address}:${address.port}/api/model-services/bailian-snapshot`;

  try {
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: extensionOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);

    const response = await fetch(url, {
      method: 'POST',
      headers: { Origin: extensionOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        planName: 'Pro 套餐',
        observedAt: '2026-08-21T10:29:28.000Z',
        planEndsAt: '2026-09-03T16:00:00.000Z',
        sevenDay: {
          usedPercent: 45.95,
          resetsAt: '2026-08-24T06:06:00.000Z',
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('access-control-allow-origin'), extensionOrigin);
    assert.equal(body.accepted, true);
    assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).snapshot.sevenDay.usedPercent, 45.95);

    const blocked = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(blocked.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('caches dashboard payloads and supports forced refresh aliases', async () => {
  let calls = 0;
  const server = createServer({
    loadDashboard: async () => ({
      summary: { calls: ++calls },
      threads: [],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const first = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    const second = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    const forced = await fetch(`${base}/api/dashboard?force=1`).then((response) => response.json());
    const refreshed = await fetch(`${base}/api/dashboard?refresh=1`).then((response) => response.json());

    assert.equal(first.summary.calls, 1);
    assert.equal(second.summary.calls, 1);
    assert.equal(forced.summary.calls, 2);
    assert.equal(refreshed.summary.calls, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves dashboard change notifications as server-sent events', async () => {
  const notificationCenter = {
    refresh: async () => ({ summary: { activeCount: 0 }, items: [] }),
    updateNotification: async (id, body) => ({ id, ...body }),
  };
  const server = createServer({
    notificationCenter,
    loadDashboard: async () => ({
      summary: { inboxCount: 0 },
      threads: [],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  const controller = new AbortController();
  try {
    const base = `http://${address.address}:${address.port}`;
    const eventResponse = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(eventResponse.status, 200);

    const eventTextPromise = (async () => {
      const reader = eventResponse.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: dashboard')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    })();

    const patchResponse = await fetch(`${base}/api/notifications/test-notification`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(patchResponse.status, 200);

    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Timed out waiting for dashboard event')), 2000);
    });
    const eventText = await Promise.race([eventTextPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    assert.match(eventText, /event: connected/);
    assert.match(eventText, /event: dashboard/);
    assert.match(eventText, /"reason":"notification-update"/);
  } finally {
    controller.abort();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('does not watch the notification store that dashboard refreshes write itself', () => {
  const homeDir = path.join(path.sep, 'Users', 'example');
  const watchPaths = defaultDashboardWatchPaths(homeDir)
    .map((entry) => (typeof entry === 'string' ? entry : entry.path));

  assert.equal(
    watchPaths.includes(path.join(homeDir, '.agent-mission-control', 'notifications.json')),
    false,
  );
  assert.equal(watchPaths.includes(path.join(homeDir, '.codex', 'sessions')), true);
  assert.equal(watchPaths.includes(path.join(homeDir, 'Library', 'Application Support', 'Cindy')), true);
  assert.equal(watchPaths.includes(path.join(homeDir, 'Library', 'Application Support', 'kimi-desktop', 'kimi-agent')), true);
});

test('file change events preserve the warm dashboard cache and do not force a rescan', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amc-dashboard-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const watchedPath = path.join(dir, 'provider-state.jsonl');
  await writeFile(watchedPath, '{}\n');
  let loadCalls = 0;
  const server = createServer({
    dashboardCacheTtlMs: 60_000,
    dashboardEventMinIntervalMs: 0,
    dashboardWatchDebounceMs: 10,
    dashboardWatchPaths: [watchedPath],
    loadDashboard: async () => ({
      summary: { loadCalls: ++loadCalls },
      threads: [],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  const controller = new AbortController();
  try {
    const base = `http://${address.address}:${address.port}`;
    await fetch(`${base}/api/dashboard`);
    const eventResponse = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = eventResponse.body.getReader();
    const decoder = new TextDecoder();
    let eventText = '';
    const eventPromise = (async () => {
      while (!eventText.includes('event: dashboard')) {
        const { done, value } = await reader.read();
        if (done) break;
        eventText += decoder.decode(value, { stream: true });
      }
      return eventText;
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(watchedPath, '{"updated":true}\n');
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Timed out waiting for file change event')), 2000);
    });
    const received = await Promise.race([eventPromise, timeout]);
    clearTimeout(timeoutId);

    const cached = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    const forced = await fetch(`${base}/api/dashboard?force=1`).then((response) => response.json());

    assert.match(received, /"reason":"file-change"/);
    assert.match(received, /"hard":false/);
    assert.equal(cached.summary.loadCalls, 1);
    assert.equal(forced.summary.loadCalls, 2);
    assert.equal(loadCalls, 2);
  } finally {
    controller.abort();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves search results from a dedicated search index', async () => {
  const calls = [];
  const searchIndex = {
    status: async () => ({ available: true, indexedAtMs: 0, threadCount: 0 }),
    indexDashboard: async (dashboard) => {
      calls.push({ method: 'indexDashboard', dashboard });
      return { indexedAtMs: 123, threadCount: dashboard.threads.length };
    },
    searchThreads: async (params) => {
      calls.push({ method: 'searchThreads', params });
      return {
        query: params.query,
        total: 1,
        items: [{ id: 'abc', title: 'Everything search' }],
      };
    },
    projectHistory: async () => ({ items: [] }),
  };
  const server = createServer({
    searchIndex,
    loadDashboard: async () => ({
      summary: {},
      threads: [{ id: 'abc', title: 'Everything search' }],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(
      `http://${address.address}:${address.port}/api/search?q=Everything&provider=codex&status=idle&project=%2Ftmp%2Fdemo&archived=1&limit=25`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.query, 'Everything');
    assert.equal(body.items[0].id, 'abc');
    assert.equal(calls[0].method, 'indexDashboard');
    assert.equal(calls[1].method, 'searchThreads');
    assert.deepEqual(calls[1].params, {
      query: 'Everything',
      provider: 'codex',
      status: 'idle',
      project: '/tmp/demo',
      includeArchived: true,
      includeSubagents: false,
      includeAutomations: false,
      limit: 25,
      cursor: '',
    });

    await fetch(`http://${address.address}:${address.port}/api/search?q=Everything&subagents=1`);
    assert.equal(calls.at(-1).method, 'searchThreads');
    assert.equal(calls.at(-1).params.includeSubagents, true);

    await fetch(`http://${address.address}:${address.port}/api/search?q=Everything&automations=1`);
    assert.equal(calls.at(-1).method, 'searchThreads');
    assert.equal(calls.at(-1).params.includeAutomations, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('hydrates Codex artifact summaries in search results', async () => {
  const artifactCalls = [];
  const searchIndex = {
    status: async () => ({ available: true, indexedAtMs: 1000, threadCount: 1 }),
    indexDashboard: async () => ({ indexedAtMs: 1000, threadCount: 1 }),
    searchThreads: async (params) => ({
      query: params.query,
      total: 2,
      items: [
        {
          id: 'codex-thread',
          provider: 'codex',
          title: 'Toy artifact thread',
          rolloutPath: '/tmp/rollout.jsonl',
          artifacts: { total: 0, items: [] },
        },
        {
          id: 'claude-thread',
          provider: 'claude-code-cli',
          title: 'Other result',
          rolloutPath: '/tmp/claude.jsonl',
        },
      ],
    }),
    projectHistory: async () => ({ items: [] }),
  };
  const server = createServer({
    now: () => 1000,
    searchIndex,
    loadDashboard: async () => ({
      summary: {},
      threads: [],
      projects: [],
      inbox: [],
    }),
    loadCodexThreadArtifacts: async ({ thread }) => {
      artifactCalls.push(thread.id);
      return {
        threadId: thread.id,
        artifacts: {
          total: 4,
          latestAtMs: 2000,
          typeCounts: { html: 2, image: 2 },
          items: [
            { id: 'artifact-4', type: 'html', title: 'index.html', source: 'agent', turn: 2 },
            { id: 'artifact-3', type: 'image', title: 'poster.png', source: 'agent', turn: 2 },
            { id: 'artifact-2', type: 'link', title: 'https://example.com/demo', source: 'user', turn: 1 },
            { id: 'artifact-1', type: 'markdown', title: 'notes.md', source: 'user', turn: 1 },
          ],
        },
      };
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/search?q=toy`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(artifactCalls, ['codex-thread']);
    assert.equal(body.items[0].artifacts.total, 4);
    assert.equal(body.items[0].artifacts.latestAtMs, 2000);
    assert.equal(body.items[0].artifacts.items.length, 3);
    assert.equal(body.items[0].artifacts.items[0].title, 'index.html');
    assert.equal(body.items[1].artifacts, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reports and rebuilds search index state', async () => {
  let indexed = false;
  const searchIndex = {
    status: async () => ({
      available: true,
      indexedAtMs: indexed ? 456 : 0,
      threadCount: indexed ? 2 : 0,
      databasePath: '/tmp/search.sqlite',
    }),
    indexDashboard: async (dashboard) => {
      indexed = true;
      return { indexedAtMs: 456, threadCount: dashboard.threads.length };
    },
    searchThreads: async () => ({ items: [], total: 0 }),
    projectHistory: async () => ({ items: [] }),
  };
  const server = createServer({
    searchIndex,
    loadDashboard: async () => ({
      summary: {},
      threads: [{ id: 'one' }, { id: 'two' }],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const beforeResponse = await fetch(`${base}/api/search/status`);
    const before = await beforeResponse.json();
    const rebuildResponse = await fetch(`${base}/api/search/reindex`, { method: 'POST' });
    const rebuilt = await rebuildResponse.json();
    const afterResponse = await fetch(`${base}/api/search/status`);
    const after = await afterResponse.json();

    assert.equal(beforeResponse.status, 200);
    assert.equal(before.threadCount, 0);
    assert.equal(rebuildResponse.status, 200);
    assert.equal(rebuilt.threadCount, 2);
    assert.equal(afterResponse.status, 200);
    assert.equal(after.threadCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rebuilds a fresh search index once when a non-empty query has no matches', async () => {
  const calls = [];
  let rebuilt = false;
  const searchIndex = {
    status: async () => ({
      available: true,
      indexedAtMs: rebuilt ? 2000 : 1000,
      threadCount: rebuilt ? 1 : 0,
    }),
    indexDashboard: async (dashboard) => {
      calls.push({ method: 'indexDashboard', threadCount: dashboard.threads.length });
      rebuilt = true;
      return { indexedAtMs: 2000, threadCount: dashboard.threads.length };
    },
    searchThreads: async (params) => {
      calls.push({ method: 'searchThreads', rebuilt, query: params.query });
      return rebuilt
        ? { query: params.query, total: 1, items: [{ id: 'fresh-thread', title: '布局简化' }] }
        : { query: params.query, total: 0, items: [] };
    },
    projectHistory: async () => ({ items: [] }),
  };
  const server = createServer({
    now: () => 2000,
    searchIndex,
    searchIndexMaxAgeMs: 60_000,
    loadDashboard: async () => ({
      summary: {},
      threads: [{ id: 'fresh-thread', title: '布局简化' }],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(
      `http://${address.address}:${address.port}/api/search?q=%E5%B8%83%E5%B1%80%E7%AE%80%E5%8C%96`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items[0].id, 'fresh-thread');
    assert.deepEqual(calls.map((call) => call.method), ['searchThreads', 'indexDashboard', 'searchThreads']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('coalesces concurrent search index rebuilds behind one writer', async () => {
  const calls = [];
  let indexed = false;
  let releaseIndexDashboard;
  let firstIndexDashboardStarted;
  const firstIndexDashboardStartedPromise = new Promise((resolve) => {
    firstIndexDashboardStarted = resolve;
  });
  const indexDashboardReleasePromise = new Promise((resolve) => {
    releaseIndexDashboard = resolve;
  });
  const searchIndex = {
    status: async () => ({
      available: true,
      indexedAtMs: indexed ? 2000 : 0,
      threadCount: indexed ? 1 : 0,
      needsRebuild: !indexed,
    }),
    indexDashboard: async (dashboard) => {
      calls.push({ method: 'indexDashboard', threadCount: dashboard.threads.length });
      firstIndexDashboardStarted();
      await indexDashboardReleasePromise;
      indexed = true;
      return { indexedAtMs: 2000, threadCount: dashboard.threads.length };
    },
    searchThreads: async (params) => {
      calls.push({ method: 'searchThreads', query: params.query });
      return { query: params.query, total: 1, items: [{ id: 'fresh-thread', title: '汇丰报告' }] };
    },
    projectHistory: async () => ({ items: [] }),
  };
  const server = createServer({
    now: () => 2000,
    searchIndex,
    searchIndexMaxAgeMs: 60_000,
    loadDashboard: async () => ({
      summary: {},
      threads: [{ id: 'fresh-thread', title: '汇丰报告' }],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const url = `http://${address.address}:${address.port}/api/search?q=%E6%B1%87%E4%B8%B0`;
    const firstResponsePromise = fetch(url);
    await firstIndexDashboardStartedPromise;
    const secondResponsePromise = fetch(url);

    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseIndexDashboard();

    const [firstResponse, secondResponse] = await Promise.all([firstResponsePromise, secondResponsePromise]);
    const [firstBody, secondBody] = await Promise.all([firstResponse.json(), secondResponse.json()]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstBody.items[0].id, 'fresh-thread');
    assert.equal(secondBody.items[0].id, 'fresh-thread');
    assert.equal(calls.filter((call) => call.method === 'indexDashboard').length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rebuilds a fresh search index when its version is stale', async () => {
  const calls = [];
  let rebuilt = false;
  const searchIndex = {
    status: async () => ({
      available: true,
      indexedAtMs: rebuilt ? 2000 : 1900,
      threadCount: 1,
      needsRebuild: !rebuilt,
    }),
    indexDashboard: async (dashboard) => {
      calls.push({ method: 'indexDashboard', threadCount: dashboard.threads.length });
      rebuilt = true;
      return { indexedAtMs: 2000, threadCount: dashboard.threads.length };
    },
    searchThreads: async (params) => {
      calls.push({ method: 'searchThreads', rebuilt, query: params.query });
      return { query: params.query, total: 1, items: [{ id: 'versioned-thread', title: '[图片] 设计师权限' }] };
    },
    projectHistory: async () => ({ items: [] }),
  };
  const server = createServer({
    now: () => 2000,
    searchIndex,
    searchIndexMaxAgeMs: 60_000,
    loadDashboard: async () => ({
      summary: {},
      threads: [{ id: 'versioned-thread', title: '[图片] 设计师权限' }],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/search?q=%E8%AE%BE%E8%AE%A1`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items[0].id, 'versioned-thread');
    assert.deepEqual(calls.map((call) => call.method), ['indexDashboard', 'searchThreads']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves project history from the search index', async () => {
  const calls = [];
  const searchIndex = {
    status: async () => ({ available: true, indexedAtMs: 999, threadCount: 2 }),
    indexDashboard: async () => ({ indexedAtMs: 999, threadCount: 2 }),
    searchThreads: async () => ({ items: [], total: 0 }),
    projectHistory: async (params) => {
      calls.push(params);
      return {
        items: [{
          cwd: '/tmp/demo',
          projectName: 'demo',
          threadCount: 2,
          activeThreadCount: 1,
          archivedThreadCount: 1,
        }],
      };
    },
  };
  const server = createServer({
    now: () => 2000,
    searchIndex,
    searchIndexMaxAgeMs: 60_000,
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/projects/history?limit=12&q=demo`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.items[0].projectName, 'demo');
    assert.deepEqual(calls[0], { limit: 12, query: 'demo' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves static index html', async () => {
  const server = createServer({
    loadDashboard: async () => ({ summary: {}, threads: [], projects: [], inbox: [] }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Agent 任务控制台/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves PWA assets with installable metadata', async () => {
  const server = createServer({
    loadDashboard: async () => ({ summary: {}, threads: [], projects: [], inbox: [] }),
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
    const manifest = await manifestResponse.json();
    const serviceWorkerResponse = await fetch(`${base}/service-worker.js`);
    const serviceWorker = await serviceWorkerResponse.text();
    const iconResponse = await fetch(`${base}/icon-192.png`);

    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get('content-type') || '', /application\/manifest\+json/);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.protocol_handlers[0].protocol, 'web+agentmissioncontrol');
    assert.equal(manifest.launch_handler.client_mode[0], 'focus-existing');
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
    assert.equal(serviceWorkerResponse.status, 200);
    assert.match(serviceWorkerResponse.headers.get('content-type') || '', /text\/javascript/);
    assert.match(serviceWorker, /pathname\.startsWith\('\/api\/'\)/);
    assert.equal(iconResponse.status, 200);
    assert.match(iconResponse.headers.get('content-type') || '', /image\/png/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves local image previews with image-only safeguards', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amc-local-preview-'));
  const pngPath = path.join(dir, 'codex-clipboard-preview.png');
  const textPath = path.join(dir, 'notes.txt');
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
  await writeFile(pngPath, pngBytes);
  await writeFile(textPath, 'private notes');

  const server = createServer({
    loadDashboard: async () => ({ summary: {}, threads: [], projects: [], inbox: [] }),
  });
  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const imageResponse = await fetch(`${base}/api/local-file-preview?path=${encodeURIComponent(pngPath)}`);
    const imageBody = Buffer.from(await imageResponse.arrayBuffer());
    const textResponse = await fetch(`${base}/api/local-file-preview?path=${encodeURIComponent(textPath)}`);
    const postResponse = await fetch(`${base}/api/local-file-preview?path=${encodeURIComponent(pngPath)}`, {
      method: 'POST',
    });
    const crossSiteResponse = await fetch(`${base}/api/local-file-preview?path=${encodeURIComponent(pngPath)}`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
    assert.equal(imageResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual(imageBody, pngBytes);
    assert.equal(textResponse.status, 415);
    assert.equal(postResponse.status, 405);
    assert.equal(crossSiteResponse.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves Codex thread artifacts lazily from rollout files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amc-artifacts-'));
  const rolloutPath = path.join(dir, 'rollout.jsonl');
  const htmlPath = path.join(dir, 'report.html');
  await writeFile(htmlPath, '<!doctype html><title>Report</title>');
  await writeFile(rolloutPath, [
    JSON.stringify({
      timestamp: '2026-06-17T08:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: `请看 https://example.com/input.png` },
    }),
    JSON.stringify({
      timestamp: '2026-06-17T08:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: `报告已生成：${htmlPath}`, phase: 'final_answer' },
    }),
  ].join('\n'));

  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [{ id: 'thread-1', provider: 'codex', title: 'Artifacts', rolloutPath }],
      projects: [],
      inbox: [],
    }),
  });
  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/thread-1/artifacts`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.threadId, 'thread-1');
    assert.equal(body.artifacts.total, 2);
    assert.deepEqual(body.artifacts.turns.map((turn) => turn.turn), [1]);
    assert.equal(body.artifacts.items[0].type, 'html');
    assert.equal(body.artifacts.items[0].path, htmlPath);
    assert.equal(body.artifacts.items[1].type, 'image');
    assert.equal(body.artifacts.items[1].url, 'https://example.com/input.png');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opens local artifact files through an injected opener', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amc-open-artifact-'));
  const htmlPath = path.join(dir, 'report.html');
  await writeFile(htmlPath, '<!doctype html><title>Report</title>');
  const resolvedHtmlPath = await realpath(htmlPath);

  const calls = [];
  const server = createServer({
    loadDashboard: async () => ({ summary: {}, threads: [], projects: [], inbox: [] }),
    openLocalFile: async (filePath) => {
      calls.push(filePath);
      return { opened: true, method: 'test-open' };
    },
  });
  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/local-file-open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: htmlPath }),
    });
    const body = await response.json();
    const crossSiteResponse = await fetch(`http://${address.address}:${address.port}/api/local-file-open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.com',
      },
      body: JSON.stringify({ path: htmlPath }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, { opened: true, method: 'test-open', path: resolvedHtmlPath });
    assert.deepEqual(calls, [resolvedHtmlPath]);
    assert.equal(crossSiteResponse.status, 403);
    assert.deepEqual(calls, [resolvedHtmlPath]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reports, opens, and hides the installed local PWA app through injected handlers', async () => {
  const calls = [];
  const server = createServer({
    getInstalledAppStatus: async () => ({ installed: true, method: 'macos-pwa-app' }),
    openInstalledApp: async () => {
      calls.push('open');
      return { opened: true, method: 'macos-pwa-app' };
    },
    hideInstalledApp: async () => {
      calls.push('hide');
      return { hidden: true, method: 'macos-pwa-app' };
    },
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const statusResponse = await fetch(`${base}/api/app/installed`);
    const status = await statusResponse.json();
    const openResponse = await fetch(`${base}/api/app/open-installed`, { method: 'POST' });
    const opened = await openResponse.json();
    const hideResponse = await fetch(`${base}/api/app/hide-installed`, { method: 'POST' });
    const hidden = await hideResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.deepEqual(status, { installed: true, method: 'macos-pwa-app' });
    assert.equal(openResponse.status, 200);
    assert.deepEqual(opened, { opened: true, method: 'macos-pwa-app' });
    assert.equal(hideResponse.status, 200);
    assert.deepEqual(hidden, { hidden: true, method: 'macos-pwa-app' });
    assert.deepEqual(calls, ['open', 'hide']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('hides installed PWA app through System Events without miniaturizing windows', async () => {
  const calls = [];
  const result = await hideInstalledPwaApp({
    platform: 'darwin',
    appDirs: [],
    appScriptNames: ['Agent Mission Control'],
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { hidden: true, method: 'macos-pwa-app' });
  assert.equal(calls[0].command, 'osascript');
  assert.match(calls[0].args.join('\n'), /id of application "Agent Mission Control"/);
  assert.match(calls[0].args.join('\n'), /bundle identifier is targetBundleId/);
  assert.doesNotMatch(calls[0].args.join('\n'), /miniaturized/);
});

test('hides installed PWA app by reading the bundle id from the installed app path', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'amc-pwa-app-'));
  const appPath = path.join(tempRoot, 'Agent 控制台.app');
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const calls = [];

  try {
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, '<plist></plist>');

    const result = await hideInstalledPwaApp({
      platform: 'darwin',
      appDirs: [tempRoot],
      appNames: ['Agent 控制台.app'],
      appScriptNames: ['Agent 控制台'],
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (command === 'plutil') {
          return { stdout: 'com.google.Chrome.app.agentmissioncontrol\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(result, { hidden: true, method: 'macos-pwa-app' });
    assert.deepEqual(calls.map((call) => call.command), ['plutil', 'osascript']);
    assert.deepEqual(calls[0].args, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath]);
    assert.match(calls[1].args.join('\n'), /set targetBundleId to "com\.google\.Chrome\.app\.agentmissioncontrol"/);
    assert.doesNotMatch(calls[1].args.join('\n'), /id of application/);
    assert.doesNotMatch(calls[1].args.join('\n'), /Agent 控制台/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('returns not found when the installed local PWA app cannot be opened', async () => {
  const server = createServer({
    openInstalledApp: async () => {
      const error = new Error('Installed Agent Mission Control app was not found');
      error.statusCode = 404;
      throw error;
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/app/open-installed`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Installed Agent Mission Control app was not found');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opens a known Codex thread through the injected opener', async () => {
  const thread = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Continue work',
    appDeepLink: 'codex://threads/123e4567-e89b-12d3-a456-426614174000',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  };
  const opened = [];
  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [thread],
      projects: [],
      inbox: [],
    }),
    openThread: async (selectedThread) => {
      opened.push(selectedThread);
      return { opened: true, method: 'test' };
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/${thread.id}/open`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].id, thread.id);
    assert.deepEqual(body, {
      opened: true,
      method: 'test',
      threadId: thread.id,
      provider: 'codex',
      appDeepLink: thread.appDeepLink,
      resumeCommand: "codex resume --no-alt-screen '123e4567-e89b-12d3-a456-426614174000'",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('coalesces concurrent open requests for the same thread', async () => {
  const thread = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Continue work',
    appDeepLink: 'codex://threads/123e4567-e89b-12d3-a456-426614174000',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  };
  const opened = [];
  let releaseOpen;
  let firstOpenStarted;
  const firstOpenStartedPromise = new Promise((resolve) => {
    firstOpenStarted = resolve;
  });
  const openReleasePromise = new Promise((resolve) => {
    releaseOpen = resolve;
  });
  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [thread],
      projects: [],
      inbox: [],
    }),
    openThread: async (selectedThread) => {
      opened.push(selectedThread.id);
      if (opened.length === 1) firstOpenStarted();
      await openReleasePromise;
      return { opened: true, method: 'test' };
    },
  });

  const address = await listen(server);
  try {
    const url = `http://${address.address}:${address.port}/api/threads/${thread.id}/open`;
    const firstResponsePromise = fetch(url, { method: 'POST' });
    await firstOpenStartedPromise;
    const secondResponsePromise = fetch(url, { method: 'POST' });

    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseOpen();

    const [firstResponse, secondResponse] = await Promise.all([firstResponsePromise, secondResponsePromise]);
    const [firstBody, secondBody] = await Promise.all([firstResponse.json(), secondResponse.json()]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstBody.method, 'test');
    assert.equal(secondBody.method, 'test');
    assert.deepEqual(opened, [thread.id]);
  } finally {
    releaseOpen?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opens indexed history threads when they are not in the dashboard snapshot', async () => {
  const indexedThread = {
    id: 'history-thread',
    provider: 'claude-code-cli',
    providerLabel: 'Claude Code CLI',
    title: 'Old investigation',
    resumeCommand: 'claude --resume history-thread',
  };
  const opened = [];
  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [],
      projects: [],
      inbox: [],
    }),
    searchIndex: {
      status: async () => ({ available: true, indexedAtMs: 123, threadCount: 1 }),
      indexDashboard: async () => ({ indexedAtMs: 123, threadCount: 1 }),
      searchThreads: async (params) => ({
        query: params.query,
        total: 1,
        items: [indexedThread],
      }),
      projectHistory: async () => ({ items: [] }),
    },
    openThread: async (selectedThread) => {
      opened.push(selectedThread);
      return { opened: false, method: 'copy-command' };
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/${indexedThread.id}/open`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(opened[0].id, indexedThread.id);
    assert.equal(body.resumeCommand, indexedThread.resumeCommand);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reveals a known thread location in the file manager', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amc-thread-reveal-'));
  const resolvedDir = await realpath(dir);
  const revealed = [];
  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [{
        id: 'thread-with-cwd',
        provider: 'codex',
        title: 'Show location',
        cwd: resolvedDir,
      }],
      projects: [],
      inbox: [],
    }),
    revealThread: async (selectedThread, targetPath) => {
      revealed.push({ selectedThread, targetPath });
      return { revealed: true, method: 'test-reveal' };
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/thread-with-cwd/reveal`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(revealed.length, 1);
    assert.equal(revealed[0].selectedThread.id, 'thread-with-cwd');
    assert.equal(revealed[0].targetPath, resolvedDir);
    assert.deepEqual(body, {
      revealed: true,
      method: 'test-reveal',
      threadId: 'thread-with-cwd',
      path: resolvedDir,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns not found when revealing an unknown thread', async () => {
  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [],
      projects: [],
      inbox: [],
    }),
    revealThread: async () => {
      throw new Error('should not reveal unknown threads');
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/missing/reveal`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Thread not found');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('saves prompt pack attachments in the local AMC prompt-pack directory', async () => {
  const promptPackRoot = await mkdtemp(path.join(os.tmpdir(), 'amc-prompt-packs-'));
  const server = createServer({
    promptPackRoot,
    loadDashboard: async () => ({
      summary: {},
      threads: [],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(
      `http://${address.address}:${address.port}/api/prompt-packs/pack-20260623-153012/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-amc-segment-id': 'A',
          'x-amc-attachment-id': 'A1',
          'x-amc-filename': encodeURIComponent('Home Screen?.png'),
        },
        body: Buffer.from('fake image bytes'),
      },
    );
    const body = await response.json();

    const expectedPath = path.join(
      promptPackRoot,
      'pack-20260623-153012',
      'attachments',
      'A1-home-screen.png',
    );
    assert.equal(response.status, 200);
    assert.equal(body.packId, 'pack-20260623-153012');
    assert.equal(body.segmentId, 'A');
    assert.equal(body.attachmentId, 'A1');
    assert.equal(body.path, expectedPath);
    assert.equal(body.fileName, 'A1-home-screen.png');
    assert.equal(body.contentType, 'image/png');
    assert.equal(body.size, 'fake image bytes'.length);
    assert.equal(await readFile(expectedPath, 'utf8'), 'fake image bytes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(promptPackRoot, { recursive: true, force: true });
  }
});

test('rejects invalid prompt pack ids before writing attachments', async () => {
  const promptPackRoot = await mkdtemp(path.join(os.tmpdir(), 'amc-prompt-packs-invalid-'));
  const server = createServer({
    promptPackRoot,
    loadDashboard: async () => ({
      summary: {},
      threads: [],
      projects: [],
      inbox: [],
    }),
  });

  const address = await listen(server);
  try {
    const response = await fetch(
      `http://${address.address}:${address.port}/api/prompt-packs/..%2Fbad/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-amc-filename': encodeURIComponent('../secret.txt'),
        },
        body: 'nope',
      },
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Prompt pack id is invalid');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(promptPackRoot, { recursive: true, force: true });
  }
});

test('focuses an existing Codex CLI Terminal tab on macOS', async () => {
  const calls = [];
  const result = await openThreadInCodexCli({
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'codex-cli',
    cwd: '/Users/example/project',
    rolloutPath: '/Users/example/.codex/sessions/rollout-123e4567-e89b-12d3-a456-426614174000.jsonl',
    status: 'running',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'ps') {
        return {
          stdout: [
            '123 1 ttys071 node /Users/example/.local/bin/codex',
            '124 123 ttys071 /Users/example/.local/lib/node_modules/@openai/codex/vendor/codex/codex',
          ].join('\n'),
        };
      }
      if (command === 'lsof') {
        return {
          stdout: [
            `p${args[1]}`,
            'fcwd',
            'n/Users/example/project',
            'f50',
            'n/Users/example/.codex/sessions/rollout-123e4567-e89b-12d3-a456-426614174000.jsonl',
          ].join('\n'),
        };
      }
      return { stdout: 'focused' };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'codex-terminal-existing');
  assert.equal(calls.at(-1).command, 'osascript');
  assert.match(calls.at(-1).args.join('\n'), /set targetTTY to "\/dev\/ttys071"/);
  assert.match(calls.at(-1).args.join('\n'), /set selected of terminalTab to true/);
  assert.match(calls.at(-1).args.join('\n'), /\bactivate\b/);
  assert.doesNotMatch(calls.at(-1).args.join('\n'), /do script/);
  assert.equal(calls.at(-1).options.timeout, 5000);
});

test('does not start a duplicate Codex CLI Terminal for running threads without a matching process', async () => {
  const calls = [];
  const result = await openThreadInCodexCli({
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'codex-cli',
    cwd: '/Users/example/project',
    status: 'running',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'ps') return { stdout: '' };
      return { stdout: '' };
    },
  });

  assert.equal(result.opened, false);
  assert.equal(result.method, 'copy-command');
  assert.deepEqual(calls.map((call) => call.command), ['ps']);
});

test('opens idle Codex CLI threads in a new Terminal resume session on macOS', async () => {
  const calls = [];
  const result = await openThreadInCodexCli({
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'codex-cli',
    cwd: '/Users/example/project',
    status: 'idle',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'ps') return { stdout: '' };
      return { stdout: '' };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'codex-terminal');
  assert.deepEqual(calls.map((call) => call.command), ['ps', 'osascript']);
  assert.match(calls.at(-1).args.join('\n'), /tell application "Terminal"/);
  assert.match(calls.at(-1).args.join('\n'), /\bactivate\b/);
  assert.match(
    calls.at(-1).args.join('\n'),
    /cd '\/Users\/example\/project' && codex resume --no-alt-screen '123e4567-e89b-12d3-a456-426614174000'/,
  );
  assert.equal(calls.at(-1).options.timeout, 5000);
});

test('opens Codex desktop history threads through the desktop deep link', async () => {
  const calls = [];
  const result = await openThreadInProvider({
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'codex',
    cwd: '/Users/example/project',
    status: 'idle',
    defaultOpenMode: 'codex-cli-resume',
    appDeepLink: 'codex://threads/123e4567-e89b-12d3-a456-426614174000',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '' };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'codex-deeplink');
  assert.deepEqual(calls.map((call) => call.command), ['open']);
  assert.deepEqual(calls[0].args, ['codex://threads/123e4567-e89b-12d3-a456-426614174000']);
});

test('opens Cindy-owned sessions in Cindy through the session deep link', async () => {
  const calls = [];
  const result = await openThreadInProvider({
    id: 'cindy:123e4567-e89b-12d3-a456-426614174000',
    provider: 'cindy',
    frontend: 'cindy',
    appDeepLink: 'cindy://session/123e4567-e89b-12d3-a456-426614174000',
    resumeCommand: "open 'cindy://session/123e4567-e89b-12d3-a456-426614174000'",
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '' };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'cindy-deeplink');
  assert.deepEqual(calls.map((call) => call.command), ['open']);
  assert.deepEqual(calls[0].args, ['cindy://session/123e4567-e89b-12d3-a456-426614174000']);
  assert.equal(calls[0].options.timeout, 5000);
});

test('opens Codex sidebar threads through the desktop deep link', async () => {
  const calls = [];
  const result = await openThreadInProvider({
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'codex',
    cwd: '/Users/example/project',
    status: 'idle',
    defaultOpenMode: 'codex-deeplink',
    appDeepLink: 'codex://threads/123e4567-e89b-12d3-a456-426614174000',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '' };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'codex-deeplink');
  assert.deepEqual(calls.map((call) => call.command), ['open']);
  assert.deepEqual(calls[0].args, ['codex://threads/123e4567-e89b-12d3-a456-426614174000']);
  assert.equal(calls[0].options.timeout, 5000);
});

test('opens Codex desktop threads through CLI resume even without a usable deep link', async () => {
  const calls = [];
  const result = await openThreadInProvider({
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'codex',
    cwd: '/Users/example/project',
    status: 'idle',
    defaultOpenMode: 'codex-deeplink',
    appDeepLink: '',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  }, {
    platform: 'darwin',
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'ps') return { stdout: '' };
      return { stdout: '' };
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.method, 'codex-terminal');
  assert.deepEqual(calls.map((call) => call.command), ['ps', 'osascript']);
  assert.match(
    calls.at(-1).args.join('\n'),
    /cd '\/Users\/example\/project' && codex resume --no-alt-screen '123e4567-e89b-12d3-a456-426614174000'/,
  );
});

test('marks the source notification done after opening from the inbox', async () => {
  const thread = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Continue work',
    appDeepLink: 'codex://threads/123e4567-e89b-12d3-a456-426614174000',
    resumeCommand: 'codex resume 123e4567-e89b-12d3-a456-426614174000',
  };
  const opened = [];
  const updates = [];
  const server = createServer({
    loadDashboard: async () => ({
      summary: {},
      threads: [thread],
      projects: [],
      inbox: [],
    }),
    openThread: async (selectedThread) => {
      opened.push(selectedThread);
      return { opened: true, method: 'test' };
    },
    notificationCenter: {
      refresh: async () => ({ summary: {}, settings: {}, items: [] }),
      updateNotification: async (id, patch) => {
        updates.push({ id, patch });
        return { id, status: patch.status };
      },
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/${thread.id}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notificationId: 'n1', markNotificationDone: true }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(opened.length, 1);
    assert.deepEqual(updates, [{ id: 'n1', patch: { status: 'done' } }]);
    assert.deepEqual(body.notification, { id: 'n1', status: 'done' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('does not open unknown thread ids', async () => {
  const server = createServer({
    loadDashboard: async () => ({ summary: {}, threads: [], projects: [], inbox: [] }),
    openThread: async () => {
      throw new Error('should not be called');
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/threads/missing/open`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Thread not found');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves actionable notifications from the notification center', async () => {
  const calls = [];
  const server = createServer({
    loadDashboard: async () => ({ summary: {}, threads: [{ id: 'abc' }], projects: [], inbox: [] }),
    notificationCenter: {
      refresh: async (dashboard, options) => {
        calls.push({ dashboard, options });
        return {
          summary: { activeCount: 1, unreadCount: 1 },
          settings: { desktopNotificationsEnabled: false },
          items: [{ id: 'n1', threadId: 'abc', status: 'unread' }],
        };
      },
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/notifications`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.summary.activeCount, 1);
    assert.equal(body.items[0].id, 'n1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dashboard.threads[0].id, 'abc');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('coalesces concurrent dashboard loads across API routes', async () => {
  let releaseLoad;
  let loadCalls = 0;
  let notificationRefreshCalls = 0;
  const loadStarted = [];
  const loadGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const server = createServer({
    loadDashboard: async () => {
      loadCalls += 1;
      loadStarted.push(loadCalls);
      await loadGate;
      return {
        summary: { activeThreads: 1 },
        threads: [{ id: 'abc' }],
        projects: [],
        inbox: [],
      };
    },
    notificationCenter: {
      refresh: async () => {
        notificationRefreshCalls += 1;
        return {
          summary: { activeCount: 0, unreadCount: 0 },
          settings: { desktopNotificationsEnabled: false },
          items: [],
        };
      },
    },
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const dashboardRequest = fetch(`${base}/api/dashboard`);
    const notificationsRequest = fetch(`${base}/api/notifications`);

    while (loadStarted.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(loadCalls, 1);

    releaseLoad();
    const [dashboardResponse, notificationsResponse] = await Promise.all([
      dashboardRequest,
      notificationsRequest,
    ]);

    assert.equal(dashboardResponse.status, 200);
    assert.equal(notificationsResponse.status, 200);
    assert.equal(loadCalls, 1);
    assert.equal(notificationRefreshCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reuses cached dashboard snapshots for repeated API reads within the TTL', async () => {
  let nowMs = 1_000;
  let loadCalls = 0;
  const server = createServer({
    dashboardCacheTtlMs: 60_000,
    now: () => nowMs,
    loadDashboard: async () => {
      loadCalls += 1;
      return {
        summary: { loadCalls },
        threads: [{ id: `thread-${loadCalls}` }],
        projects: [],
        inbox: [],
      };
    },
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const firstResponse = await fetch(`${base}/api/dashboard`);
    const first = await firstResponse.json();
    const secondResponse = await fetch(`${base}/api/pending-summary`);
    const second = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(first.summary.loadCalls, 1);
    assert.equal(second.runningHostThreadCount, 0);
    assert.equal(loadCalls, 1);

    nowMs += 60_001;
    const thirdResponse = await fetch(`${base}/api/dashboard`);
    const third = await thirdResponse.json();

    assert.equal(thirdResponse.status, 200);
    assert.equal(third.summary.loadCalls, 2);
    assert.equal(loadCalls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('pending summary reuses a recent stale dashboard snapshot instead of forcing a scan', async () => {
  let nowMs = 1_000;
  let loadCalls = 0;
  const server = createServer({
    dashboardCacheTtlMs: 10_000,
    pendingSummaryDashboardMaxAgeMs: 120_000,
    now: () => nowMs,
    loadDashboard: async () => {
      loadCalls += 1;
      return {
        summary: { runningHostThreads: loadCalls },
        threads: [{ id: `thread-${loadCalls}`, status: 'running' }],
        projects: [],
        inbox: [],
      };
    },
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const firstResponse = await fetch(`${base}/api/dashboard`);
    const first = await firstResponse.json();

    nowMs += 30_000;
    const summaryResponse = await fetch(`${base}/api/pending-summary`);
    const summary = await summaryResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(summaryResponse.status, 200);
    assert.equal(first.summary.runningHostThreads, 1);
    assert.equal(summary.runningHostThreadCount, 1);
    assert.equal(loadCalls, 1);

    nowMs += 120_001;
    const freshSummaryResponse = await fetch(`${base}/api/pending-summary`);
    const freshSummary = await freshSummaryResponse.json();

    assert.equal(freshSummaryResponse.status, 200);
    assert.equal(freshSummary.runningHostThreadCount, 2);
    assert.equal(loadCalls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reuses notification refreshes across dashboard scans by default', async () => {
  let nowMs = 1_000;
  let loadCalls = 0;
  let refreshCalls = 0;
  const server = createServer({
    now: () => nowMs,
    loadDashboard: async () => {
      loadCalls += 1;
      return {
        summary: { loadCalls },
        threads: [{ id: 'abc', updatedAtMs: nowMs }],
        projects: [],
        inbox: [],
      };
    },
    notificationCenter: {
      refresh: async () => {
        refreshCalls += 1;
        return {
          summary: { activeCount: 0, unreadCount: 0 },
          settings: { desktopNotificationsEnabled: false },
          items: [],
        };
      },
    },
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const firstResponse = await fetch(`${base}/api/dashboard`);
    nowMs += 10_001;
    const secondResponse = await fetch(`${base}/api/dashboard`);
    const second = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(loadCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(second.performance.notifications.cacheTtlMs, 30_000);
    assert.equal(second.performance.notifications.hits, 1);
    assert.equal(second.performance.notifications.refreshCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reports local performance metrics for scan time, memory, and cache behavior', async () => {
  let nowMs = 1_000;
  let loadCalls = 0;
  const server = createServer({
    dashboardCacheTtlMs: 10_000,
    now: () => nowMs,
    loadDashboard: async () => {
      loadCalls += 1;
      return {
        summary: {},
        threads: [],
        projects: [],
        inbox: [],
      };
    },
  });

  const address = await listen(server);
  try {
    const base = `http://${address.address}:${address.port}`;
    const firstResponse = await fetch(`${base}/api/dashboard`);
    const first = await firstResponse.json();
    nowMs += 1_000;
    const secondResponse = await fetch(`${base}/api/dashboard`);
    const second = await secondResponse.json();
    const metricsResponse = await fetch(`${base}/api/performance`);
    const metrics = await metricsResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(metricsResponse.status, 200);
    assert.equal(loadCalls, 1);
    assert.equal(first.performance.dashboard.loadCount, 1);
    assert.equal(second.performance.dashboard.hits, 1);
    assert.equal(metrics.dashboard.cacheTtlMs, 10_000);
    assert.equal(metrics.dashboard.loadCount, 1);
    assert.equal(metrics.dashboard.hits, 1);
    assert.equal(typeof metrics.process.rssBytes, 'number');
    assert.ok(metrics.caches.codex.rolloutSignals);
    assert.ok(metrics.caches.claude.jsonlSignals);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves a privacy-limited pending summary for the macOS menu bar', async () => {
  const server = createServer({
    loadDashboard: async () => ({
      summary: { runningHostThreads: 2 },
      threads: [
        { id: 'abc', status: 'running' },
        { id: 'done-thread', status: 'fresh' },
      ],
      projects: [],
      inbox: [],
    }),
    notificationCenter: {
      refresh: async () => ({
        summary: { activeCount: 3, unreadCount: 2 },
        settings: { desktopNotificationsEnabled: false },
        items: [
          { id: 'n1', threadId: 'abc', status: 'unread', source: 'codex-unread', threadTitle: 'private title' },
          { id: 'n2', threadId: 'abc', status: 'unread', source: 'opencode-permission', threadTitle: 'private title' },
          { id: 'n3', threadId: 'done-thread', status: 'read', source: 'observed-completion', threadTitle: 'private title' },
        ],
      }),
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/pending-summary`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.activeCount, 3);
    assert.equal(body.displayCount, 3);
    assert.equal(body.hardPendingCount, 3);
    assert.equal(body.progressCount, 1);
    assert.equal(body.runningHostThreadCount, 2);
    assert.equal(body.hostLabel, '2 Host 工作中');
    assert.equal(body.label, '3 待处理');
    assert.equal('items' in body, false);
    assert.equal(JSON.stringify(body).includes('private title'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeps the menu bar summary aligned with the dashboard when cached progress is stale', async () => {
  const server = createServer({
    loadDashboard: async () => ({
      summary: { runningHostThreads: 1 },
      threads: [{
        id: 'abc',
        status: 'running',
        currentTurnStartedAtMs: 1778420050000,
        latestUserMessageAtMs: 1778420050000,
      }],
      projects: [],
      inbox: [],
    }),
    notificationCenter: {
      refresh: async () => ({
        summary: { activeCount: 1, unreadCount: 1 },
        settings: { desktopNotificationsEnabled: false },
        items: [{
          id: 'n1',
          threadId: 'abc',
          status: 'unread',
          source: 'observed-completion',
          signalAtMs: 1778420000000,
          threadTitle: 'private title',
        }],
      }),
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/pending-summary`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.activeCount, 0);
    assert.equal(body.displayCount, 0);
    assert.equal(body.hardPendingCount, 0);
    assert.equal(body.progressCount, 0);
    assert.equal(body.runningHostThreadCount, 1);
    assert.equal(body.hostLabel, '1 Host 工作中');
    assert.equal(body.label, '暂无待处理');
    assert.equal(JSON.stringify(body).includes('private title'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('updates notification status through PATCH', async () => {
  const updates = [];
  const server = createServer({
    notificationCenter: {
      updateNotification: async (id, patch) => {
        updates.push({ id, patch });
        return { id, status: patch.status };
      },
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/notifications/n1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(updates, [{ id: 'n1', patch: { status: 'done' } }]);
    assert.equal(body.status, 'done');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeps desktop notification settings endpoint disabled', async () => {
  const settingsUpdates = [];
  const server = createServer({
    notificationCenter: {
      updateSettings: async (patch) => {
        settingsUpdates.push(patch);
        return { desktopNotificationsEnabled: patch.desktopNotificationsEnabled };
      },
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/notification-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desktopNotificationsEnabled: true }),
    });
    const body = await response.json();

    assert.equal(response.status, 410);
    assert.deepEqual(settingsUpdates, []);
    assert.equal(body.error, 'Desktop notifications are disabled');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeps manual desktop notification test endpoint disabled', async () => {
  const calls = [];
  const server = createServer({
    notificationCenter: {
      sendTestNotification: async () => {
        calls.push('test');
        return { sent: true };
      },
    },
  });

  const address = await listen(server);
  try {
    const response = await fetch(`http://${address.address}:${address.port}/api/notification-test`, {
      method: 'POST',
    });
    const body = await response.json();

    assert.equal(response.status, 410);
    assert.deepEqual(calls, []);
    assert.equal(body.error, 'Desktop notifications are disabled');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
