import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { defaultClaudeAppDir, normalizeClaudeDesktopCodeSession, loadClaudeDesktopCodeThreads, parseClaudeJsonlSignals } from '../src/claude-data.mjs';
import { loadCodexDashboard, readThreads, discoverCodexStateDatabase, parseRolloutSignals, readRolloutSignals, getCodexCacheStats, codexNativeReadStatus } from '../src/codex-data.mjs';
import { buildSwitchboardDashboard, createSwitchboardServer, loadSwitchboardDashboard, openSwitchboardThread, switchboardStatus, PendingTracker } from '../src/switchboard.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';
const localId = `local_${id}`;
const now = Date.parse('2026-10-07T14:00:00Z');
const jsonl = (events) => events.map(JSON.stringify).join('\n');
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function codexDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`create table threads (
    id text primary key, rollout_path text, created_at integer, updated_at integer,
    created_at_ms integer, updated_at_ms integer, source text, model_provider text,
    cwd text, title text, sandbox_policy text, approval_mode text, tokens_used integer,
    archived integer, git_sha text, git_branch text, git_origin_url text, cli_version text,
    first_user_message text, agent_nickname text, agent_role text, memory_mode text,
    model text, reasoning_effort text, name text, is_pinned integer, thread_source text,
    originator text, agent_path text, creator_account_id text, creator_user_id text
  );`);
  return database;
}

test('Linux Claude uses the XDG directory and opens the original local session', async () => {
  assert.equal(defaultClaudeAppDir('linux', '/home/test', {}), '/home/test/.config/Claude');
  assert.equal(defaultClaudeAppDir('linux', '/home/test', { XDG_CONFIG_HOME: '/config' }), '/config/Claude');
  assert.equal(defaultClaudeAppDir('darwin', '/Users/test', {}), '/Users/test/Library/Application Support/Claude');
  const thread = normalizeClaudeDesktopCodeSession({ sessionId: localId, cliSessionId: id, title: 'One task' }, {}, now);
  assert.equal(thread.appDeepLink, `claude://code/continue?session=${localId}`);
  const calls = [];
  const row = buildSwitchboardDashboard([thread], [], now).threads[0];
  const result = await openSwitchboardThread(row, { platform: 'linux', runCommand: async (...args) => { calls.push(args); return {}; } });
  assert.equal(result.opened, true);
  assert.equal(calls[0][0], 'xdg-open');
  assert.deepEqual(calls[0][1], [`claude://code/continue?session=${localId}`]);
  const legacy = normalizeClaudeDesktopCodeSession({ sessionId: 'local_legacy', cliSessionId: id }, {}, now);
  assert.equal(legacy.appDeepLink, `claude://resume?session=${id}`);
  assert.equal(buildSwitchboardDashboard([legacy], [], now).threads[0].canOpen, false);
});

test('Claude recursively reads local metadata, keeps archives, and deduplicates CLI IDs', async (t) => {
  const dir = await temp(t);
  const sessions = path.join(dir, 'app', 'claude-code-sessions', 'nested');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'local_one.json'), JSON.stringify({ sessionId: localId, cliSessionId: id, title: 'Older', lastActivityAt: now - 1000 }));
  await writeFile(path.join(sessions, 'local_two.json'), JSON.stringify({ sessionId: localId, cliSessionId: id, title: 'Newest', isArchived: true, lastActivityAt: now + 100_000 }));
  await writeFile(path.join(sessions, 'ignored.json'), JSON.stringify({ sessionId: 'private', cliSessionId: 'other' }));
  const result = await loadClaudeDesktopCodeThreads({ appDir: path.join(dir, 'app'), projectFiles: new Map(), usageCache: null, nowMs: now });
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].title, 'Newest');
  assert.equal(result.threads[0].archived, true);
  assert.equal(buildSwitchboardDashboard(result.threads, [], now).threads[0].state, 'unknown');
});

test('states use lifecycle and transcript signals, never archive or timestamp alone', () => {
  const started = parseRolloutSignals(jsonl([{ timestamp: new Date(now - 1000).toISOString(), payload: { type: 'task_started' } }]));
  assert.equal(switchboardStatus({ lifecycleRunning: started.agentRunning, agentActivityAtMs: started.agentActivityAtMs }, now).state, 'working');
  for (const type of ['task_complete', 'turn_aborted']) {
    const ended = parseRolloutSignals(jsonl([{ timestamp: new Date(now).toISOString(), payload: { type } }]));
    assert.equal(switchboardStatus({ lifecycleRunning: ended.agentRunning, latestUserMessageAtMs: now }, now).state, 'idle');
  }
  assert.equal(switchboardStatus({ lifecycleRunning: true, agentActivityAtMs: now - 7 * 3_600_000 }, now).state, 'unknown');
  assert.equal(switchboardStatus({ archived: false, updatedAtMs: now }, now).state, 'unknown');
  assert.equal(switchboardStatus({ awaitingPermission: true }, now).state, 'waiting');
  const signals = parseClaudeJsonlSignals(jsonl([{ type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { content: 'Run the project checks' } }]));
  const thread = normalizeClaudeDesktopCodeSession({ sessionId: localId }, { signals }, now);
  assert.equal(switchboardStatus(thread, now).state, 'working');
  signals.latestAgentFinalAtMs = now;
  assert.equal(switchboardStatus(normalizeClaudeDesktopCodeSession({ sessionId: localId }, { signals }, now), now).state, 'idle');
});

test('the board keeps root app/project data and excludes nested or internal agents', () => {
  const rows = buildSwitchboardDashboard([
    { id, provider: 'codex', title: 'Root', cwd: '/work/ASB', pinned: true },
    { id: 'child', provider: 'codex', isSubagent: true, parentThreadId: id },
    { id: 'nested', provider: 'codex', isSubagent: true, parentThreadId: 'child' },
    { id: 'internal', provider: 'codex', threadSource: 'subagent' },
    { id: 'review', provider: 'codex', threadSource: 'guardian_review' },
  ], [], now).threads;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subagentCount, 2);
  assert.equal(rows[0].projectName, 'ASB');
  assert.equal(rows[0].pinned, undefined);
});

test('Working start time uses the current Codex task or Claude request and stays zero without that signal', () => {
  const codex = parseRolloutSignals(jsonl([{ timestamp: new Date(now - 5_000).toISOString(), payload: { type: 'task_started' } }]));
  const claude = normalizeClaudeDesktopCodeSession({ sessionId: localId }, { signals: parseClaudeJsonlSignals(jsonl([
    { type: 'user', timestamp: new Date(now - 3_000).toISOString(), message: { content: 'Start' } },
  ])) }, now);
  const rows = buildSwitchboardDashboard([
    { id: 'codex', provider: 'codex', ...codex, lifecycleRunning: codex.agentRunning, goalCreatedAtMs: now - 50_000 },
    claude,
    { id: 'idle', provider: 'codex', lifecycleRunning: false, agentStartedAtMs: now - 5_000 },
    { id: 'unknown', provider: 'codex', lifecycleRunning: true, agentActivityAtMs: now - 7 * 3_600_000, agentStartedAtMs: now - 7 * 3_600_000 },
    { id: 'missing', provider: 'codex', lifecycleRunning: true, agentActivityAtMs: now, goalCreatedAtMs: now - 50_000 },
  ], [], now).threads;
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const ordered = ['codex', claude.id, 'idle', 'unknown', 'missing'].map((identity) => byId[identity]);
  assert.deepEqual(ordered.map((row) => row.workingSinceMs), [now - 5_000, now - 3_000, 0, 0, 0]);
  assert.deepEqual(ordered.map((row) => row.state), ['working', 'working', 'idle', 'unknown', 'working']);
  assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', ...codex, lifecycleRunning: true }], [], now + 2_000).threads[0].workingSinceMs,
    byId.codex.workingSinceMs);
});

test('the ASB scan explicitly disables auth, usage cache, and metric scans or writes', async () => {
  let codexOptions;
  let claudeOptions;
  const dashboard = await loadSwitchboardDashboard({ nowMs: now,
    codexOptions: { codexResetCreditsEnabled: true, maxGovernanceRollouts: 50, workMetricCachePath: '/bad' },
    claudeOptions: { usageCache: 'bad' },
    loadCodex: async (options) => { codexOptions = options; return { threads: [] }; },
    loadClaude: async (options) => { claudeOptions = options; return { threads: [] }; },
  });
  assert.equal(codexOptions.codexResetCreditsEnabled, false);
  assert.equal(codexOptions.workMetricCachePath, false);
  assert.equal(codexOptions.maxGovernanceRollouts, 0);
  assert.equal(codexOptions.maxOrphanRollouts, 0);
  assert.equal(claudeOptions.usageCache, null);
  assert.equal(claudeOptions.fileIndexCacheTtlMs, 1_000);
  assert.equal(dashboard.providers.length, 2);
});

test('ASB refreshes Claude transcript stats and discovers newly created transcripts on each scan', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'projects');
  await mkdir(path.join(appDir, 'claude-code-sessions'), { recursive: true });
  await mkdir(projectsDir);
  await writeFile(path.join(appDir, 'claude-code-sessions', 'local_one.json'), JSON.stringify({ sessionId: localId, cliSessionId: id }));
  const transcript = path.join(projectsDir, `${id}.jsonl`);
  const scan = (nowMs) => loadSwitchboardDashboard({ nowMs, loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir, projectsDir } });
  assert.equal((await scan(now)).threads[0].state, 'unknown');
  await writeFile(transcript, jsonl([{ type: 'user', timestamp: new Date(now).toISOString(), message: { content: 'Start' } }]) + '\n');
  assert.equal((await scan(now + 999)).threads[0].state, 'working');
  assert.equal((await scan(now + 1_000)).threads[0].state, 'working');
  await writeFile(transcript, jsonl([{ type: 'result', timestamp: new Date(now + 1_001).toISOString() }]) + '\n', { flag: 'a' });
  assert.equal((await scan(now + 1_999)).threads[0].state, 'idle');
  assert.equal((await scan(now + 2_000)).threads[0].state, 'idle');
});

test('ASB shares concurrent loads and uses the active fallback clock without forced scans', async (t) => {
  let clock = now;
  let loads = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const server = createSwitchboardServer({ now: () => clock, pendingStatePath: false, dashboardWatchPaths: [], loadDashboard: async () => {
    loads += 1;
    started.resolve();
    await release.promise;
    return { generatedAtMs: clock, providers: [], threads: [{ id, state: loads === 1 ? 'working' : 'idle', nativeUnread: null,
      completionAtMs: loads === 1 ? 0 : clock }] };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  const first = scan();
  await started.promise;
  const received = Promise.withResolvers();
  server.once('request', received.resolve);
  const concurrent = scan();
  await received.promise;
  release.resolve();
  const snapshots = await Promise.all([first, concurrent]);
  assert.equal(loads, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.threads[0].state === 'working'));
  clock += 1_999;
  assert.equal((await scan()).threads[0].state, 'working');
  assert.equal(loads, 1);
  clock += 1;
  const next = await scan();
  assert.equal(loads, 2);
  assert.equal(next.threads[0].state, 'idle');
  assert.equal(next.threads[0].completionAttention, true);
  await scan();
  assert.equal(loads, 2);
});

test('the web view uses the adaptive clock, pauses when hidden, and skips overlapping or unchanged redraws', async () => {
  let requests = 0;
  let redraws = 0;
  let clock = now;
  let interval;
  let intervalMs;
  const release = Promise.withResolvers();
  const node = () => ({ value: 'all', checked: false, dataset: {}, addEventListener() {}, setAttribute() {}, append() {},
    replaceChildren() { redraws += 1; }, querySelectorAll() { return []; } });
  const nodes = Object.fromEntries(['search', 'app', 'status', 'archive', 'refresh', 'count', 'updated', 'notice', 'sessions'].map((key) => [key, node()]));
  nodes.search.value = '';
  const document = { hidden: false, getElementById: (key) => nodes[key], addEventListener() {}, createElement: node, createDocumentFragment: node };
  const board = { generatedAtMs: now, providers: [], threads: [] };
  const context = vm.createContext({ document, Date: class extends Date { static now() { return clock; } },
    window: { addEventListener() {} }, clearTimeout() {},
    setTimeout(callback, milliseconds) { interval = callback; intervalMs = milliseconds; },
    fetch: async () => { requests += 1; await release.promise; return { ok: true, json: async () => structuredClone(board) }; },
  });
  vm.runInContext(await readFile(new URL('../public/switchboard.js', import.meta.url), 'utf8'), context);
  await vm.runInContext('refresh()', context);
  assert.equal(requests, 1);
  assert.equal(redraws, 0);
  release.resolve();
  await new Promise(setImmediate);
  assert.equal(redraws, 1);
  assert.equal(intervalMs, 250);
  const previousUpdated = nodes.updated.textContent;
  board.generatedAtMs += 60_000;
  interval();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(intervalMs, 5_000);
  assert.equal(redraws, 1);
  assert.equal(nodes.updated.dateTime, new Date(board.generatedAtMs).toISOString());
  assert.notEqual(nodes.updated.textContent, previousUpdated);
  document.hidden = true;
  interval();
  assert.equal(requests, 2);
  document.hidden = false;
  board.providers.push({ id: 'codex', message: 'Changed source' });
  interval();
  await new Promise(setImmediate);
  assert.equal(redraws, 2);
  clock += 60_000;
  interval();
  await new Promise(setImmediate);
  assert.equal(redraws, 3);
});

test('ASB reports unavailable or corrupt Claude metadata without a ready status', async (t) => {
  const dir = await temp(t);
  const missing = await loadSwitchboardDashboard({ loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir: dir, projectFiles: new Map() } });
  assert.equal(missing.providers[1].status, 'error');
  const sessions = path.join(dir, 'claude-code-sessions');
  await mkdir(sessions);
  await writeFile(path.join(sessions, 'local_bad.json'), '{');
  const corrupt = await loadSwitchboardDashboard({ loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir: dir, projectFiles: new Map() } });
  assert.equal(corrupt.providers[1].status, 'error');
  await writeFile(path.join(sessions, 'local_good.json'), JSON.stringify({ sessionId: localId, title: 'Good' }));
  const partial = await loadSwitchboardDashboard({ loadCodex: async () => ({ threads: [] }), claudeOptions: { appDir: dir, projectFiles: new Map() } });
  assert.equal(partial.providers[1].status, 'warning');
  assert.equal(partial.threads.length, 1);
  assert.equal(partial.threads[0].state, 'unknown');
});

test('native SQLite works without the CLI, preserves desktop name/pin, and reads only', async (t) => {
  const dir = await temp(t);
  const dbPath = path.join(dir, 'state_7.sqlite');
  const rollout = path.join(dir, 'rollout.jsonl');
  await writeFile(rollout, jsonl([{ timestamp: new Date(now).toISOString(), payload: { type: 'task_complete' } }]));
  const database = codexDatabase(dbPath);
  database.prepare('insert into threads (id, source, cwd, title, name, is_pinned, thread_source, archived, updated_at_ms, rollout_path) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'vscode', '/work/ASB', 'Old prompt', 'Desktop name', 1, 'user', 0, now, rollout);
  database.prepare('update threads set creator_account_id = ?, creator_user_id = ?').run('test-account', 'test-user');
  database.close();
  await writeFile(path.join(dir, 'state_2.sqlite'), 'not a database');
  assert.equal(await discoverCodexStateDatabase(dir), dbPath);
  const before = await readFile(dbPath);
  const beforeStat = await stat(dbPath);
  const rows = await readThreads({ databasePath: dbPath });
  assert.equal(rows[0].name, 'Desktop name');
  assert.equal(rows[0].is_pinned, 1);
  assert.equal(rows[0].creator_account_id, 'test-account');
  const oldPath = process.env.PATH;
  process.env.PATH = '/no-asb-tools';
  t.after(() => { process.env.PATH = oldPath; });
  const beforeMetrics = getCodexCacheStats();
  const dashboard = await loadCodexDashboard({ databasePath: dbPath, sessionsDir: dir,
    sessionIndexPath: path.join(dir, 'absent-index'), globalStatePath: path.join(dir, 'absent-state'),
    authPath: path.join(dir, 'never-read-auth'), fetchImpl: () => assert.fail('Network call'),
    codexResetCreditsEnabled: false, maxOrphanRollouts: 0, maxGovernanceRollouts: 0, workMetricCachePath: false, nowMs: now,
  });
  process.env.PATH = oldPath;
  assert.equal(dashboard.threads[0].title, 'Desktop name');
  assert.equal(dashboard.threads[0].pinned, true);
  assert.equal(dashboard.threads[0].lifecycleRunning, false);
  assert.equal(buildSwitchboardDashboard(dashboard.threads, [], now).threads[0].completionAtMs, now);
  assert.deepEqual(await readFile(dbPath), before);
  assert.equal((await stat(dbPath)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(getCodexCacheStats().workMetrics.fullScans, beforeMetrics.workMetrics.fullScans);
  await assert.rejects(readThreads({ databasePath: path.join(dir, 'missing.sqlite') }));
  await assert.rejects(stat(path.join(dir, 'missing.sqlite')), { code: 'ENOENT' });
});

test('ASB allows only its view, session reads, and same-origin stored-session opens', async (t) => {
  const calls = [];
  const server = createSwitchboardServer({ pendingStatePath: false, loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', canOpen: true, appDeepLink: `codex://threads/${id}` }] }),
    openThread: async (thread) => { calls.push(thread); return { opened: true }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = `${base}/api/threads/${id}/open`;
  assert.equal((await fetch(base)).status, 200);
  assert.match(await (await fetch(base)).text(), /Agent Switch Board/);
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 200);
  for (const route of ['/api/reviews', '/api/search', '/api/notifications', '/api/model-services/bailian-snapshot', '/api/prompt-packs', '/index.html', '/app.js']) {
    assert.equal((await fetch(`${base}${route}`, { method: 'POST', body: '{}' })).status, 404, route);
  }
  assert.equal((await fetch(`${base}/api/dashboard`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(open)).status, 405);
  assert.equal((await fetch(open, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(open, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(open, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/threads/missing/open`, { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 404);
  assert.equal((await fetch(open, { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ command: 'bad', appDeepLink: 'https://example.com' }) })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].appDeepLink, `codex://threads/${id}`);
  const rebinding = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/dashboard`, { headers: { Host: `attacker.test:${server.address().port}` } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rebinding, 403);
});

test('Codex native read status matches one metadata identity and the exact local host only', () => {
  const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const identity = digest(['chatgpt', 'test-account', 'test-user']);
  const localHost = `local:${digest(['local', 'local', null])}`;
  const thread = { id, creatorAccountId: 'test-account', creatorUserId: 'test-user' };
  const state = (namespaces, identities = {}) => ({ 'electron-thread-read-state-v1': {
    version: 1, unreadByIdentity: { [identity]: namespaces, ...identities },
  } });
  assert.deepEqual(codexNativeReadStatus(thread, state({ [localHost]: [id] })), { nativeUnread: true, readStatus: 'unread' });
  assert.deepEqual(codexNativeReadStatus(thread, state({ [localHost]: [], 'durable:elsewhere': [id] })), { nativeUnread: false, readStatus: 'read' });
  for (const invalid of [state({ 'durable:elsewhere': [id] }), state({ 'local:other': [id] }), state({ [localHost]: [42] }),
    state({ [localHost]: [id] }, { 'other-identity': { [localHost]: [id] } }), {}]) {
    assert.equal(codexNativeReadStatus(thread, invalid).readStatus, 'unknown');
  }
  assert.equal(codexNativeReadStatus({ ...thread, creatorUserId: 'other' }, state({ [localHost]: [id] })).readStatus, 'unknown');
  assert.equal(codexNativeReadStatus({ id }, state({ [localHost]: [id] })).readStatus, 'unknown');
  const roots = buildSwitchboardDashboard([{ ...thread, provider: 'codex', title: 'Root', nativeUnread: false },
    { id: 'internal', provider: 'codex', threadSource: 'subagent', nativeUnread: true }], [], now);
  assert.equal(roots.threads.length, 1);
  assert.equal(roots.threads[0].nativeUnread, false);
  assert.ok(!JSON.stringify(roots).includes('test-account'));
  assert.ok(!JSON.stringify(roots).includes('creator'));
});

test('Pending observes complete scans, preserves native truth, and persists completion acknowledgments', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'asb', 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = (rows) => ({ providers: [], threads: rows.map((row) => ({ nativeUnread: null, completionAtMs: 0, updatedAtMs: now, ...row })) });
  const first = await tracker.observe(board([{ id: 'old', state: 'idle', completionAtMs: 100 },
    { id: 'hidden', state: 'working' }, { id: 'native-working', state: 'working', nativeUnread: true },
    { id: 'native-unread', state: 'idle', nativeUnread: true }, { id: 'native-read', state: 'idle', nativeUnread: false },
    { id: 'waiting', state: 'waiting' }, { id: 'unknown', state: 'unknown', nativeUnread: true }]));
  assert.equal(first.threads[0].pending, false);
  assert.equal(first.threads[2].pending, false);
  assert.equal(first.threads[2].state, 'working');
  assert.equal(first.threads[2].unread, true);
  assert.equal(first.threads[2].pendingSource, 'native-unread');
  assert.equal(first.threads[3].pendingSource, 'native-unread');
  assert.equal(first.threads[4].pending, false);
  assert.equal(first.threads[5].pending, true);
  assert.equal(first.threads[5].state, 'waiting');
  assert.equal(first.threads[6].pending, false);
  const completed = await tracker.observe(board([{ id: 'hidden', state: 'idle', completionAtMs: 200 }]));
  assert.equal(completed.threads[0].pendingSource, 'observed-completion');
  assert.equal(completed.threads[0].unread, true);
  const restarted = new PendingTracker(statePath);
  assert.equal((await restarted.observe(board([{ id: 'hidden', state: 'idle', completionAtMs: 200 }]))).threads[0].pending, true);
  await restarted.acknowledge('hidden');
  assert.equal((await new PendingTracker(statePath).observe(board([{ id: 'hidden', state: 'idle', completionAtMs: 200 }]))).threads[0].pending, false);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(Object.keys(saved.records.hidden).sort(), ['ack', 'manual', 'nativeAck', 'nativeAt', 'nativeSeen', 'pending', 'questionAck', 'questionSeen', 'retained', 'seen', 'working']);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  await tracker.observe(board([{ id: 'aborted', state: 'working' }]));
  assert.equal((await tracker.observe(board([{ id: 'aborted', state: 'idle', completionAtMs: 0 }]))).threads[0].pending, false);
  const aborted = parseRolloutSignals(jsonl([
    { timestamp: new Date(now - 1000).toISOString(), payload: { type: 'agent_message', phase: 'final_answer', message: 'Old reply' } },
    { timestamp: new Date(now).toISOString(), payload: { type: 'turn_aborted' } },
  ]));
  assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', lifecycleRunning: false, ...aborted }], [], now).threads[0].completionAtMs, 0);
  for (const kind of ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled']) {
    const ended = parseRolloutSignals(jsonl([{ timestamp: new Date(now).toISOString(), payload: { type: kind } }]));
    assert.equal(ended.agentRunning, false);
    assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', ...ended }], [], now).threads[0].completionAtMs, 0);
  }
  const emptyComplete = parseRolloutSignals(jsonl([{ timestamp: new Date(now).toISOString(), payload: { type: 'task_complete', last_agent_message: '' } }]));
  assert.equal(buildSwitchboardDashboard([{ id, provider: 'codex', ...emptyComplete }], [], now).threads[0].completionAtMs, now);
  await tracker.observe(board([{ id: 'archive', state: 'working' }, { id: 'stale', state: 'working' }]));
  await tracker.observe(board([{ id: 'stale', state: 'unknown' }]));
  const excluded = await tracker.observe(board([{ id: 'archive', state: 'idle', archived: true, nativeUnread: true, completionAtMs: 300 },
    { id: 'stale', state: 'idle', completionAtMs: 300 }]));
  assert.equal(excluded.threads[0].pending, false);
  assert.equal(excluded.threads[0].unread, true);
  assert.equal(excluded.threads[0].pendingSource, 'native-unread');
  assert.equal(excluded.threads[1].pending, false);
});

test('Working activity does not rewrite Pending state, and legacy Working timestamps still track completion', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = (state, at) => ({ providers: [], threads: [{ id, state, nativeUnread: null, updatedAtMs: at, completionAtMs: state === 'idle' ? at : 0 }] });
  await tracker.observe(board('working', now));
  const before = await stat(statePath);
  const content = await readFile(statePath, 'utf8');
  await tracker.observe(board('working', now + 2_000));
  await tracker.observe(board('working', now + 4_000));
  assert.equal(await readFile(statePath, 'utf8'), content);
  assert.equal((await stat(statePath)).ino, before.ino);
  assert.equal((await stat(statePath)).mtimeMs, before.mtimeMs);
  assert.equal(JSON.parse(content).records[id].working, 1);
  assert.equal((await tracker.observe(board('idle', now + 6_000))).threads[0].completionAttention, true);
  const legacyPath = path.join(dir, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({ version: 1, records: { [id]: { seen: 0, working: now, pending: 0, ack: 0 } } }));
  const legacy = new PendingTracker(legacyPath);
  assert.equal((await legacy.observe(board('idle', now + 6_000))).threads[0].completionAttention, true);
  await legacy.acknowledge(id);
  assert.equal((await new PendingTracker(legacyPath).observe(board('idle', now + 6_000))).threads[0].completionAttention, false);
});

test('persistent unread retains native, question, and observed completion dots with their sources through restart', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = (native = true, question = true, completion = false) => {
    const questionRow = buildSwitchboardDashboard([{ id: 'question', provider: 'codex', lifecycleRunning: true,
      agentActivityAtMs: now, awaitingUserInput: question, latestUserQuestionAtMs: now }], [], now).threads[0];
    return { providers: [], threads: [
      { id: 'native', state: 'working', nativeUnread: native, readStatus: native ? 'unread' : 'read' },
      { id: 'completion', state: completion ? 'idle' : 'working', nativeUnread: false, completionAtMs: completion ? now : 0 },
      questionRow,
    ] };
  };
  const existing = await tracker.observe(board());
  assert.equal(existing.persistentUnread, false);
  await tracker.setPinned('native', true);
  await tracker.setPersistentUnread(true, existing);
  const completed = await tracker.observe(board(true, true, true));
  assert.deepEqual(completed.threads.map((row) => row.retainedUnreadSource), ['native-unread', 'observed-completion', 'user-question']);
  assert.ok(completed.threads.every((row) => row.unread && !row.manualUnread));
  assert.equal(completed.threads[0].state, 'working');
  assert.equal(completed.threads[0].pending, false);
  const clearedSource = await tracker.observe(board(false, false, true));
  assert.ok(clearedSource.threads.every((row) => row.unread));
  assert.equal(clearedSource.threads[0].nativeUnread, false);
  assert.equal(clearedSource.threads[0].nativeAttention, false);
  assert.equal(clearedSource.threads[2].questionAttention, false);
  const restarted = new PendingTracker(statePath);
  const restored = await restarted.observe(board(false, false, true));
  assert.equal(restored.persistentUnread, true);
  assert.deepEqual(restored.pinnedOrder, ['native']);
  assert.ok(restored.threads.every((row) => row.retainedUnread));
  const before = await stat(statePath);
  const content = await readFile(statePath, 'utf8');
  await restarted.observe(board(false, false, true));
  await restarted.observe(board(false, false, true));
  assert.equal(await readFile(statePath, 'utf8'), content);
  assert.equal((await stat(statePath)).ino, before.ino);
  assert.equal((await stat(statePath)).mtimeMs, before.mtimeMs);
  await restarted.setPersistentUnread(false, restored);
  assert.ok(restored.threads.every((row) => row.retainedUnread));
  assert.equal((await new PendingTracker(statePath).observe(board(false, false, true))).persistentUnread, false);
});

test('persistent native attention promotes new question and completion sources without relatching acknowledged events', async () => {
  const tracker = new PendingTracker(false);
  const board = ({ question = false, completion = 0, native = true, running = true } = {}) => buildSwitchboardDashboard([
    { id, provider: 'codex', nativeUnread: native, lifecycleRunning: running, agentActivityAtMs: now,
      awaitingUserInput: question, latestUserQuestionAtMs: question ? now + 1 : 0, latestAgentFinalAtMs: completion },
  ], [], now + 10);
  const first = await tracker.observe(board());
  await tracker.setPersistentUnread(true, first);
  assert.equal(first.threads[0].retainedUnreadSource, 'native-unread');
  assert.equal((await tracker.observe(board({ question: true }))).threads[0].retainedUnreadSource, 'user-question');
  const resolved = (await tracker.observe(board())).threads[0];
  assert.equal(resolved.state, 'working');
  assert.equal(resolved.pending, true);
  assert.equal(resolved.retainedUnreadSource, 'user-question');
  await tracker.acknowledge(id);
  const read = (await tracker.observe(board({ question: true }))).threads[0];
  assert.equal(read.unread, false);
  assert.equal(read.pending, false);
  await tracker.observe(board({ native: false }));
  assert.equal((await tracker.observe(board())).threads[0].retainedUnreadSource, 'native-unread');
  assert.equal((await tracker.observe(board({ completion: now + 2, running: false }))).threads[0].retainedUnreadSource, 'observed-completion');
  assert.equal((await tracker.observe(board({ completion: now + 2 }))).threads[0].pending, true);
});

test('Read clears persistent attention without changing execution, and only new source events add it again', async () => {
  const tracker = new PendingTracker(false);
  const board = (native = true, completion = 0, questionAt = now) => buildSwitchboardDashboard([
    { id: 'native', provider: 'codex', nativeUnread: native, lifecycleRunning: true, agentActivityAtMs: now,
      latestAgentFinalAtMs: completion },
    { id: 'question', provider: 'codex', nativeUnread: false, lifecycleRunning: true, agentActivityAtMs: now,
      awaitingUserInput: true, latestUserQuestionAtMs: questionAt, userQuestionBlocking: true, latestBlockingQuestionAtMs: questionAt },
    { id: 'completion', provider: 'codex', nativeUnread: false, lifecycleRunning: !completion, agentActivityAtMs: now,
      latestAgentFinalAtMs: completion },
  ], [], now + 10);
  const existing = await tracker.observe(board());
  await tracker.setPersistentUnread(true, existing);
  await tracker.observe(board(true, now + 1));
  for (const identity of ['native', 'question', 'completion']) await tracker.acknowledge(identity);
  const read = await tracker.observe(board(true, now + 1));
  assert.ok(read.threads.every((row) => !row.unread && !row.retainedUnread && !row.questionAttention));
  assert.deepEqual(read.threads.map((row) => row.state), ['working', 'waiting', 'idle']);
  assert.equal(read.threads[0].nativeUnread, true);
  assert.equal(read.threads[1].questionPending, true);
  await tracker.observe(board(false, now + 1));
  const newNative = await tracker.observe(board(true, now + 1));
  assert.equal(newNative.threads[0].retainedUnreadSource, 'native-unread');
  const newQuestion = await tracker.observe(board(true, now + 1, now + 2));
  assert.equal(newQuestion.threads[1].retainedUnreadSource, 'user-question');
  await tracker.acknowledge('native');
  assert.equal((await tracker.observe(board(true, now + 3, now + 2))).threads[0].retainedUnread, true);
  await tracker.acknowledge('completion');
  await tracker.observe(board(true, 0, now + 2));
  assert.equal((await tracker.observe(board(true, now + 4, now + 2))).threads[2].retainedUnreadSource, 'observed-completion');
});

test('ASB unread settings seed cached dots, preserve them on open, and restore open acknowledgments when disabled', async (t) => {
  const tracker = new PendingTracker(false);
  let native = true;
  let loads = 0;
  const server = createSwitchboardServer({ pendingTracker: tracker,
    loadDashboard: async () => { loads += 1; return { providers: [], threads: [{ id, state: 'working', nativeUnread: native,
      canOpen: true, provider: 'codex', appDeepLink: `codex://threads/${id}` }] }; }, openThread: async () => ({ opened: true }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(body) }).then((response) => response.json());
  const scan = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  assert.equal((await scan()).threads[0].unread, true);
  native = false;
  const enabled = await post('/api/settings/unread', { persistentUnread: true });
  assert.equal(loads, 1);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.persistentUnread, true);
  assert.equal(enabled.dashboard.threads[0].retainedUnread, true);
  assert.equal((await scan()).threads[0].nativeUnread, false);
  await post(`/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, true);
  const read = await post(`/api/threads/${id}/mark-read`);
  assert.equal(read.changed, true);
  assert.equal(read.thread.unread, false);
  assert.equal(read.thread.state, 'working');
  await post(`/api/threads/${id}/mark-unread`);
  await post(`/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].manualUnread, true);
  const disabled = await post('/api/settings/unread', { persistentUnread: false });
  assert.equal(disabled.dashboard.threads[0].unread, true);
  await post(`/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, false);
});

test('ASB unread routes require a local origin, exact bodies, known IDs, and POST', async (t) => {
  const server = createSwitchboardServer({ pendingStatePath: false, loadDashboard: async () => ({ providers: [], threads: [{ id, state: 'idle', nativeUnread: false }] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = '/api/settings/unread';
  const read = `/api/threads/${id}/mark-read`;
  const post = (route, body, headers = { Origin: base }) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  for (const route of [settings, read]) {
    assert.equal((await fetch(`${base}${route}`)).status, 405);
    assert.equal((await post(route, {}, {})).status, 403);
    assert.equal((await post(route, {}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(route, {}, { Origin: base, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const request = http.request(`${base}${route}`, { method: 'POST', headers: { Origin: base, Host: 'attacker.test' } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(wrongHost, 403);
  }
  for (const body of [{}, [], null, { persistentUnread: 'true' }, { persistentUnread: 1 }, { persistentUnread: true, extra: true }]) {
    assert.equal((await post(settings, body)).status, 400);
  }
  for (const body of [[], null, { read: true }, { command: 'bad' }]) assert.equal((await post(read, body)).status, 400);
  assert.equal((await post('/api/threads/missing/mark-read', {})).status, 404);
  assert.equal((await post(settings, { persistentUnread: true })).status, 200);
  assert.equal((await post(read, {})).status, 200);
});

test('only successful stored-session opens acknowledge fallback Pending', async (t) => {
  const tracker = new PendingTracker(false);
  await tracker.observe({ providers: [], threads: [{ id, state: 'working', nativeUnread: null, completionAtMs: 0 }] });
  let result = 'failed';
  const server = createSwitchboardServer({ pendingTracker: tracker,
    loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', state: 'idle', nativeUnread: null, completionAtMs: 200, canOpen: true, appDeepLink: `codex://threads/${id}` }] }),
    openThread: async () => { if (result === 'throw') throw new Error('Mock open failed'); return { opened: result === 'success' }; },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = async () => (await (await fetch(`${base}/api/dashboard`)).json()).threads[0].pending;
  const open = () => fetch(`${base}/api/threads/${id}/open`, { method: 'POST', headers: { Origin: base }, body: '{}' });
  assert.equal(await pending(), true);
  await open();
  assert.equal(await pending(), true);
  result = 'throw';
  assert.equal((await open()).status, 500);
  assert.equal(await pending(), true);
  result = 'success';
  assert.equal((await open()).status, 200);
  assert.equal(await pending(), false);
});

test('manual unread has one stored-session action, persists over native reads, and clears only after a successful open', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const board = () => ({ providers: [], threads: [
    { id, provider: 'codex', state: 'idle', nativeUnread: false, canOpen: true, appDeepLink: `codex://threads/${id}` },
    { id: 'working', state: 'working', nativeUnread: false },
    { id: 'unknown', state: 'unknown', nativeUnread: null },
  ] });
  let opened = false;
  const server = createSwitchboardServer({ pendingTracker: tracker, loadDashboard: async () => board(),
    openThread: async () => ({ opened }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `${base}/api/threads/${id}/mark-unread`;
  const post = (url, headers = { Origin: base }, body = '{}') => fetch(url, { method: 'POST', headers, body });
  assert.equal((await fetch(route)).status, 405);
  assert.equal((await post(route, {})).status, 403);
  assert.equal((await post(route, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(route, { Origin: base, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request(route, { method: 'POST', headers: { Origin: base, Host: 'attacker.test' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal((await post(`${base}/api/threads/missing/mark-unread`)).status, 404);
  assert.equal((await post(route, { Origin: base }, '{"command":"bad","url":"https://example.com"}')).status, 400);
  assert.equal((await post(route)).status, 200);
  const scan = () => fetch(`${base}/api/dashboard?force=1`).then((response) => response.json());
  let dashboard = await scan();
  assert.equal(dashboard.threads[0].pendingSource, 'manual-unread');
  assert.equal(dashboard.threads[0].nativeUnread, false);
  assert.equal(dashboard.threads[0].unread, true);
  await post(`${base}/api/threads/working/mark-unread`);
  await post(`${base}/api/threads/unknown/mark-unread`);
  dashboard = await scan();
  assert.deepEqual(dashboard.threads.map((row) => [row.state, row.pending, row.unread]), [['idle', true, true], ['working', true, true], ['unknown', true, true]]);
  const restarted = new PendingTracker(statePath);
  assert.ok((await restarted.observe(board())).threads.every((row) => row.manualUnread));
  await post(`${base}/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, true);
  opened = true;
  await post(`${base}/api/threads/${id}/open`);
  assert.equal((await scan()).threads[0].unread, false);
  assert.equal((await new PendingTracker(statePath).observe(board())).threads[0].manualUnread, false);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(statePath, 'utf8'))).includes('provider'));
});

test('ASB pins persist independently, use the full order, and reject unsafe local actions', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const rows = ['a', 'hidden', 'b', 'read', 'native-pin'].map((value) => ({ id: value, state: 'idle', nativeUnread: false, pinned: value === 'native-pin' }));
  const board = () => ({ providers: [], threads: structuredClone(rows) });
  const tracker = new PendingTracker(statePath);
  const server = createSwitchboardServer({ pendingTracker: tracker, loadDashboard: async () => board() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (identity, action, body = {}, origin = base) => fetch(`${base}/api/threads/${identity}/${action}`, {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body),
  });
  const scan = () => fetch(`${base}/api/dashboard`).then((result) => result.json());
  assert.ok((await scan()).threads.every((row) => !row.pinned));
  for (const value of ['a', 'hidden', 'b']) assert.equal((await post(value, 'pin')).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['a', 'hidden', 'b']);
  assert.equal((await post('a', 'move-pin', { targetId: 'b', placement: 'after' })).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['hidden', 'b', 'a']);
  assert.equal((await post('a', 'move-pin', { direction: 'up' })).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['hidden', 'a', 'b']);
  assert.equal((await post('hidden', 'unpin')).status, 200);
  assert.deepEqual((await scan()).pinnedOrder, ['a', 'b']);
  const restarted = await new PendingTracker(statePath).observe(board());
  assert.deepEqual(restarted.pinnedOrder, ['a', 'b']);
  assert.deepEqual(restarted.threads.filter((row) => row.pinned).map((row) => [row.id, row.pinIndex]), [['a', 0], ['b', 1]]);
  assert.equal((await fetch(`${base}/api/threads/a/pin`)).status, 405);
  assert.equal((await post('a', 'pin', {}, 'https://example.com')).status, 403);
  assert.equal((await post('unknown', 'pin')).status, 404);
  assert.equal((await post('a', 'pin', { command: 'bad' })).status, 400);
  assert.equal((await post('a', 'move-pin', { targetId: 'unknown', placement: 'before' })).status, 404);
  assert.equal((await post('a', 'move-pin', { targetId: 'read', placement: 'before' })).status, 400);
  assert.equal((await post('read', 'move-pin', { direction: 'up' })).status, 400);
  assert.equal((await post('a', 'move-pin', { direction: 'left' })).status, 400);
  assert.deepEqual((await scan()).pinnedOrder, ['a', 'b']);
});

const questionCall = (name, callId, count = 1) => ({ type: 'response_item', timestamp: new Date(now).toISOString(), payload: {
  type: 'function_call', name, call_id: callId, arguments: JSON.stringify({ questions: Array.from({ length: count }, () => ({ title: 'PRIVATE QUESTION BODY' })) }),
} });
const questionOutput = (callId, value) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(value) } });
const questionReply = (callId, index) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text:
  `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', callId, index]), question: 'PRIVATE QUESTION BODY', answer: 'PRIVATE ANSWER BODY' }])}</send_user_message_question_reply>`,
}] } });

test('Codex user-question events track sync resolution and all async answers, never ordinary prose', async (t) => {
  const sync = questionCall('functions.request_user_input', 'sync');
  assert.equal(parseRolloutSignals(jsonl([sync])).awaitingUserInput, true);
  assert.equal(parseRolloutSignals(jsonl([sync, questionOutput('sync', { answers: {} })])).awaitingUserInput, false);
  const events = [questionCall('request_user_input_async', 'async', 3), questionOutput('async', { accepted: true }),
    { timestamp: new Date(now + 1).toISOString(), payload: { type: 'task_complete' } }];
  assert.equal(parseRolloutSignals(jsonl(events)).awaitingUserInput, true);
  events.push(questionReply('async', 0), questionReply('async', 1));
  assert.equal(parseRolloutSignals(jsonl(events)).awaitingUserInput, true);
  const tracker = new PendingTracker(false);
  const signals = parseRolloutSignals(jsonl(events));
  const dashboard = await tracker.observe(buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: false, readStatus: 'read',
    lifecycleRunning: signals.agentRunning, ...signals }], [], now));
  assert.equal(dashboard.threads[0].state, 'idle');
  assert.equal(dashboard.threads[0].questionPending, true);
  assert.equal(dashboard.threads[0].pendingSource, 'user-question');
  assert.ok(!JSON.stringify(dashboard).includes('PRIVATE'));
  await tracker.acknowledge(id);
  tracker.apply(dashboard.threads[0]);
  assert.equal(dashboard.threads[0].pending, false);
  const questionServer = createSwitchboardServer({ pendingTracker: tracker,
    loadDashboard: async () => buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: false, readStatus: 'read',
      lifecycleRunning: signals.agentRunning, ...signals }], [], now), openThread: async () => ({ opened: true }),
  });
  await new Promise((resolve) => questionServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { questionServer.closeAllConnections(); return new Promise((resolve) => questionServer.close(resolve)); });
  const questionBase = `http://127.0.0.1:${questionServer.address().port}`;
  assert.equal((await fetch(`${questionBase}/api/threads/${id}/open`, { method: 'POST', headers: { Origin: questionBase }, body: '{}' })).status, 200);
  const afterOpen = await (await fetch(`${questionBase}/api/dashboard?force=1`)).json();
  assert.equal(afterOpen.threads[0].questionPending, true);
  assert.equal(afterOpen.threads[0].pending, false);
  assert.equal(afterOpen.threads[0].state, 'idle');
  events.push(questionReply('async', 2));
  assert.equal(parseRolloutSignals(jsonl(events)).awaitingUserInput, false);
  for (const type of ['turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled']) {
    assert.equal(parseRolloutSignals(jsonl([sync, { payload: { type } }])).awaitingUserInput, false);
  }
  assert.equal(parseRolloutSignals(jsonl([questionCall('request_user_input_async', 'failed'), questionOutput('failed', { accepted: false })])).awaitingUserInput, false);
  assert.equal(parseRolloutSignals(jsonl([{ payload: { type: 'agent_message', message: 'Can you answer this?' } },
    questionCall('functions.exec', 'ordinary')])).awaitingUserInput, false);
  const dir = await temp(t);
  const rollout = path.join(dir, 'questions.jsonl');
  await writeFile(rollout, jsonl(events.slice(0, 3)) + '\n' + jsonl(Array.from({ length: 200 }, () => ({ payload: { type: 'agent_message', message: 'x'.repeat(1000) } }))) + '\n');
  const options = { initialBytes: 1024, maxBytes: 2048 };
  assert.equal((await readRolloutSignals(rollout, options)).awaitingUserInput, true);
  await writeFile(rollout, jsonl([questionReply('async', 0), questionReply('async', 1)]) + '\n', { flag: 'a' });
  assert.equal((await readRolloutSignals(rollout, options)).awaitingUserInput, true);
  await writeFile(rollout, jsonl([questionReply('async', 2)]), { flag: 'a' });
  assert.equal((await readRolloutSignals(rollout, options)).awaitingUserInput, false);
});

test('Codex human resumption supersedes old questions while goal work and partial replies preserve attention', async (t) => {
  const lifecycle = (type, at) => ({ timestamp: new Date(at).toISOString(), payload: { type } });
  const user = (message, at, extra = {}) => ({ timestamp: new Date(at).toISOString(), payload: { type: 'user_message', message, ...extra } });
  const async = [questionCall('request_user_input_async', 'resume', 3), questionOutput('resume', { accepted: true })];
  const status = (events) => {
    const signals = parseRolloutSignals(jsonl(events));
    return { signals, row: buildSwitchboardDashboard([{ id, provider: 'codex', lifecycleRunning: signals.agentRunning, ...signals }], [], now).threads[0] };
  };
  for (const message of ['ok', 'yes', 'go']) {
    const current = status([...async, lifecycle('task_complete', now + 1), lifecycle('task_started', now + 2), user(message, now + 3)]);
    assert.equal(current.signals.awaitingUserInput, false);
    assert.equal(current.row.state, 'working');
    assert.equal(status([...async, user(message, now + 1), lifecycle('task_complete', now + 2)]).row.state, 'idle');
  }
  const automatic = [...async, lifecycle('task_complete', now + 1), lifecycle('task_started', now + 2), user(
    '<codex_internal_context source="goal">Continue working toward the active thread goal.</codex_internal_context>', now + 3,
    { internal_chat_message_metadata_passthrough: { content_item_kinds: ['goal.internal_context'] } }), questionReply('resume', 0)];
  assert.equal(status(automatic).signals.awaitingUserInput, true);
  assert.equal(status(automatic).row.state, 'working');
  assert.equal(status([...automatic, questionReply('resume', 1)]).signals.awaitingUserInput, true);
  assert.equal(status([...automatic, questionReply('resume', 1), questionReply('resume', 2)]).signals.awaitingUserInput, false);
  const blocking = status([lifecycle('task_started', now - 1), questionCall('functions.request_user_input', 'blocking')]);
  assert.equal(blocking.row.state, 'waiting');
  assert.equal(status([lifecycle('task_started', now - 1), questionCall('functions.request_user_input', 'blocking'), lifecycle('task_complete', now + 1)]).row.state, 'idle');
  const oldSync = { ...questionCall('request_user_input', 'old-sync'), timestamp: new Date(now - 1000).toISOString() };
  assert.equal(status([oldSync, lifecycle('task_complete', now - 800), lifecycle('task_started', now - 600),
    questionCall('request_user_input_async', 'new-async'), questionOutput('new-async', { accepted: true })]).row.state, 'working');
  const ambient = { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text:
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['additional_content.codex_apps_open_page'] } } };
  assert.equal(status([...automatic, ambient, questionReply('resume', 1)]).signals.awaitingUserInput, true);
  const dir = await temp(t);
  const rollout = path.join(dir, 'resume.jsonl');
  const padding = jsonl(Array.from({ length: 100 }, () => ({ payload: { type: 'agent_message', message: 'x'.repeat(1000) } })));
  await writeFile(rollout, jsonl([...async, lifecycle('task_complete', now + 1), lifecycle('task_started', now + 2), user('ok', now + 3)]) + '\n' + padding + '\n');
  const signals = await readRolloutSignals(rollout, { initialBytes: 1024, maxBytes: 2048 });
  assert.equal(signals.awaitingUserInput, false);
  assert.equal(signals.agentRunning, true);
});

test('successful ASB opens acknowledge question/native attention without changing execution, and acknowledgment survives refresh/restart', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const events = [questionCall('request_user_input_async', 'attention'), questionOutput('attention', { accepted: true }),
    { timestamp: new Date(now + 1).toISOString(), payload: { type: 'task_started' } }];
  const signals = parseRolloutSignals(jsonl(events));
  let native = true;
  let completion = 0;
  const board = () => buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: native, readStatus: native ? 'unread' : 'read',
    lifecycleRunning: signals.agentRunning, ...signals, latestAgentFinalAtMs: completion }], [], now + 2);
  const tracker = new PendingTracker(statePath);
  let opened = false;
  const server = createSwitchboardServer({ pendingTracker: tracker, loadDashboard: async () => board(), openThread: async () => ({ opened }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = () => fetch(`${base}/api/dashboard?force=1`).then((response) => response.json()).then((dashboard) => dashboard.threads[0]);
  const open = () => fetch(`${base}/api/threads/${id}/open`, { method: 'POST', headers: { Origin: base }, body: '{}' });
  let row = await scan();
  assert.equal(row.state, 'working');
  assert.equal(row.questionAttention, true);
  assert.equal(row.nativeAttention, true);
  await open();
  assert.equal((await scan()).questionAttention, true);
  opened = true;
  await open();
  row = await scan();
  assert.equal(row.state, 'working');
  assert.equal(row.questionPending, true);
  assert.equal(row.questionAttention, false);
  assert.equal(row.nativeUnread, true);
  assert.equal(row.nativeAttention, false);
  assert.equal(row.unread, false);
  assert.equal(row.pending, false);
  assert.ok(!JSON.stringify(row).includes('latestUserQuestionAtMs'));
  const restarted = await new PendingTracker(statePath).observe(board());
  assert.equal(restarted.threads[0].questionAttention, false);
  assert.equal(restarted.threads[0].nativeAttention, false);
  native = false; await scan(); native = true;
  assert.equal((await scan()).nativeAttention, true);
  await open(); completion = now + 3;
  assert.equal((await scan()).nativeAttention, true);
  const sync = parseRolloutSignals(jsonl([questionCall('request_user_input', 'sync-ack')]));
  const syncBoard = buildSwitchboardDashboard([{ id: 'sync', provider: 'codex', ...sync }], [], now);
  const syncTracker = new PendingTracker(false);
  await syncTracker.observe(syncBoard);
  await syncTracker.acknowledge('sync'); syncTracker.apply(syncBoard.threads[0]);
  assert.equal(syncBoard.threads[0].state, 'waiting');
  assert.equal(syncBoard.threads[0].questionAttention, false);
  const completionTracker = new PendingTracker(false);
  const completionBoard = () => buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: null,
    lifecycleRunning: signals.agentRunning, ...signals }], [], now + 2);
  await completionTracker.observe(completionBoard());
  await completionTracker.acknowledge(id);
  const ended = parseRolloutSignals(jsonl([...events,
    { timestamp: new Date(now + 4).toISOString(), payload: { type: 'task_complete' } }]));
  const completed = await completionTracker.observe(buildSwitchboardDashboard([{ id, provider: 'codex', nativeUnread: null,
    lifecycleRunning: ended.agentRunning, ...ended }], [], now + 5));
  assert.equal(completed.threads[0].questionPending, true);
  assert.equal(completed.threads[0].questionAttention, false);
  assert.equal(completed.threads[0].state, 'idle');
  assert.equal(completed.threads[0].completionAttention, true);
  assert.equal(completed.threads[0].unread, true);
});
