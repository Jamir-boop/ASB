import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadCodexDashboard, readThreadRows, readThreads } from '../src/codex-data.mjs';
import { enrichThreadRuntime, enrichThreads, normalizeDashboardThreads, normalizeThread, threadTree } from '../src/insights.mjs';
import { buildSwitchboardDashboard, isSwitchboardRoot, loadSwitchboardDashboard } from '../src/switchboard.mjs';

// A scan builds its rows in place on objects that the scan made. These tests give the scan frozen objects where a reader keeps
// objects between scans (the thread query result, the rows of OpenCode, the session index): a write to one of them throws.

const nowMs = Date.parse('2026-08-01T12:00:00.000Z');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}

// A Map that a scan only reads, like the kept session index.
function readOnlyMap(entries) {
  const map = new Map(entries);
  for (const name of ['set', 'delete', 'clear']) Object.defineProperty(map, name, { value() { throw new TypeError(`Map.${name} on a kept map`); } });
  return map;
}

const RELATIONSHIP_FIELDS = ['parentThreadTitle', 'parentThreadProjectName', 'parentThreadProviderLabel', 'childThreadIds',
  'descendantThreadIds', 'subagentCount', 'hostThreadId', 'groupUpdatedAtMs'];

// A root with a tree below it, a loop, and a thread whose parent is not in the list.
function threadFamily() {
  const sub = (id, parentThreadId, updatedAtMs, extra = {}) => ({ id, externalId: id, provider: 'codex', providerLabel: 'Codex', title: `Title ${id}`,
    projectName: `project-${id}`, isSubagent: true, parentThreadId, updatedAtMs, ...extra });
  return [
    { id: 'root', externalId: 'root', provider: 'codex', providerLabel: 'Codex', title: 'Title root', projectName: 'project-root', updatedAtMs: 100 },
    sub('a', 'root', 90, { embeddedSubagentCount: 1 }),
    sub('b', 'a', 120, { embeddedSubagentUpdatedAtMs: 130 }),
    sub('c', 'root', 80),
    sub('x', 'y', 50),
    sub('y', 'x', 40),
    sub('o', 'gone', 30),
  ];
}

test('the subagent tree lists the threads below each thread, also with a loop, and changes no thread', () => {
  const threads = deepFreeze(threadFamily());
  const { descendantsFor } = threadTree(threads);
  const ids = (id) => descendantsFor(id).map((thread) => thread.id);
  assert.deepEqual(ids('root'), ['a', 'b', 'c']);
  assert.deepEqual(ids('a'), ['b']);
  assert.deepEqual(ids('b'), []);
  assert.deepEqual(ids('nobody'), []);
  // A loop ends at the thread that starts it, and the walk of a thread does not change the walk of the next.
  assert.deepEqual(ids('x'), ['y', 'x']);
  assert.deepEqual(ids('y'), ['x']);
  assert.deepEqual(ids('gone'), ['o']);
  assert.deepEqual(ids('root'), ['a', 'b', 'c']);
});

test('dashboard threads get one copy each, with the relationship fields after the runtime fields, and the input stays as it was', () => {
  const input = deepFreeze(threadFamily());
  const threads = normalizeDashboardThreads(input, nowMs);
  // Sorted by time, newest first.
  assert.deepEqual(threads.map((thread) => thread.id), ['b', 'root', 'a', 'c', 'x', 'y', 'o']);
  for (const thread of threads) assert.equal(input.includes(thread), false);
  for (const thread of threads) {
    assert.deepEqual(Object.keys(thread).slice(-11), ['currentTurnStartedAtMs', 'currentTurnElapsedMs', 'status', ...RELATIONSHIP_FIELDS]);
  }
  const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]));
  assert.deepEqual(byId.root.childThreadIds, ['a', 'c']);
  assert.deepEqual(byId.root.descendantThreadIds, ['a', 'b', 'c']);
  // Three listed threads and one embedded subagent; the newest time of the group is the embedded time of `b`.
  assert.equal(byId.root.subagentCount, 4);
  assert.equal(byId.root.groupUpdatedAtMs, 130);
  assert.equal(byId.root.hostThreadId, 'root');
  assert.equal(byId.b.hostThreadId, 'root');
  assert.equal(byId.a.parentThreadTitle, 'Title root');
  assert.equal(byId.a.parentThreadProjectName, 'project-root');
  assert.equal(byId.a.parentThreadProviderLabel, 'Codex');
  assert.equal(byId.root.parentThreadTitle, '');
  // A thread with a missing parent, and a loop, each stop at a thread of their own.
  assert.equal(byId.o.hostThreadId, 'gone');
  assert.equal(byId.o.parentThreadTitle, '');
  assert.equal(byId.x.hostThreadId, 'x');
  assert.equal(byId.y.hostThreadId, 'y');
  assert.deepEqual(byId.x.descendantThreadIds, ['y', 'x']);
  // Lists of the result are the lists of that thread only.
  assert.notEqual(byId.root.childThreadIds, byId.a.childThreadIds);
});

test('a runtime copy is a new object, and a thread of normalizeThread has its runtime fields in the object it returns', () => {
  const thread = deepFreeze({ id: 'one', provider: 'codex', updatedAtMs: nowMs - 1_000, agentRunning: true, agentStartedAtMs: nowMs - 5_000, agentActivityAtMs: nowMs });
  const copy = enrichThreadRuntime(thread, nowMs);
  assert.notEqual(copy, thread);
  assert.deepEqual([copy.status, copy.currentTurnStartedAtMs, copy.currentTurnElapsedMs], ['running', nowMs - 5_000, 5_000]);
  // Again on the copy: the fields keep their place and take the new values.
  const again = enrichThreadRuntime(copy, nowMs + 1_000);
  assert.deepEqual(Object.keys(again), Object.keys(copy));
  assert.equal(again.currentTurnElapsedMs, 6_000);

  const row = deepFreeze({ id: uuid(1), title: 'Stored', source: 'vscode', updated_at_ms: nowMs, archived: 0 });
  const index = readOnlyMap([[uuid(1), 'Sidebar title']]);
  const normalized = normalizeThread(row, nowMs, index);
  assert.deepEqual([normalized.title, normalized.inCodexSidebar], ['Sidebar title', true]);
  assert.deepEqual(Object.keys(normalized).slice(-3), ['currentTurnStartedAtMs', 'currentTurnElapsedMs', 'status']);
  assert.deepEqual(enrichThreads([row], nowMs, index), [normalized]);
  // With no index, the row says whether the thread is in the sidebar.
  assert.equal(normalizeThread(row, nowMs).inCodexSidebar, true);
  assert.equal(normalizeThread({ ...row, in_codex_sidebar: 0 }, nowMs).inCodexSidebar, false);
});

async function temporaryDirectory(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the dashboard of frozen reader results is the same in each scan, with or without separate stores', async (t) => {
  const dir = await temporaryDirectory(t, 'asb-scan-read-only-');
  const dirs = {};
  for (const name of ['codex', 'work', 'claude', 'claude-two', 'opencode']) await mkdir(dirs[name] = path.join(dir, name));
  const thread = (id, extra = {}) => ({ id, externalId: id, title: `Title ${id}`, cwd: `/tmp/synthetic-${id}`, archived: false,
    createdAtMs: nowMs - 100_000, updatedAtMs: nowMs - 10_000, ...extra });
  const codex = (n, extra = {}) => thread(uuid(n), { provider: 'codex', providerLabel: 'Codex', source: 'vscode', lifecycleRunning: false,
    latestLifecycleKind: 'task_complete', latestLifecycleAtMs: nowMs - 10_000, ...extra });
  const claude = (n, extra = {}) => thread(`local_${uuid(n)}`, { provider: 'claude-desktop-code', providerLabel: 'Claude Desktop Code', source: 'claude-desktop',
    lifecycleRunning: false, ...extra });
  const cli = thread('cli-session', { id: 'cli:cli-session', provider: 'claude-desktop-code', providerLabel: 'Claude Code CLI', source: 'claude-cli',
    surface: 'cli', cliNoTranscript: true, lifecycleRunning: false });
  // The readers return the same objects in each scan, as the OpenCode reader does with its kept result.
  const results = deepFreeze({
    codex: { threads: [codex(1), codex(2, { isSubagent: true, parentThreadId: uuid(1), lifecycleRunning: true, agentRunning: true,
      agentStartedAtMs: nowMs - 5_000, agentActivityAtMs: nowMs - 1_000 }), codex(3, { threadSource: 'subagent' })] },
    work: { threads: [codex(1, { title: 'Work root' }), codex(4, { isSubagent: true, parentThreadId: uuid(1) })] },
    claude: { threads: [claude(1, { incomingMessages: [{ from: uuid(1), atMs: nowMs - 2_000 }] }), cli] },
    'claude-two': { threads: [cli] },
    opencode: { threads: [thread('ses_one', { provider: 'opencode', source: 'opencode-db', embeddedSubagentCount: 2, lifecycleRunning: false })] },
  });
  const sourceOf = (id, provider, extra = {}) => ({ id, provider, label: id, enabled: true, builtin: false, launcher: '/bin/true', dataDir: dirs[id], ...extra });
  const sources = [sourceOf('codex', 'codex', { builtin: true, launcher: '' }), sourceOf('work', 'codex'),
    sourceOf('claude', 'claude-desktop-code', { builtin: true, launcher: '', projectsDir: path.join(dir, 'projects') }),
    sourceOf('claude-two', 'claude-desktop-code', { projectsDir: path.join(dir, 'projects') }), sourceOf('opencode', 'opencode', { builtin: true, launcher: '' })];
  t.after(() => loadSwitchboardDashboard({ sources: [] }));
  const loaders = {
    loadCodex: async ({ databasePath }) => results[path.basename(path.dirname(databasePath))],
    loadClaude: async ({ appDir }) => results[path.basename(appDir)],
    loadOpenCode: async () => results.opencode,
  };
  const withSources = () => loadSwitchboardDashboard({ nowMs, sources, ...loaders });
  const first = await withSources();
  // The rows are the roots. The Codex subagent and the Codex row with the subagent source are not rows. Two stores list one CLI session with
  // no transcript: one row stays, from the first store.
  assert.deepEqual(first.threads.map((row) => row.id).sort(),
    [uuid(1), `work:${uuid(1)}`, `local_${uuid(1)}`, 'cli:cli-session', 'ses_one'].sort());
  assert.deepEqual(await withSources(), first);
  assert.equal(first.threads.find((row) => row.id === uuid(1)).subagentCount, 1);
  assert.equal(first.threads.find((row) => row.id === `work:${uuid(1)}`).subagentCount, 1);
  assert.equal(first.threads.find((row) => row.id === 'ses_one').subagentCount, 2);

  // With no stores, the threads of the readers go to the dashboard as they are.
  const plain = () => loadSwitchboardDashboard({ nowMs, loadCodex: async () => results.codex, loadClaude: async () => results.claude,
    loadOpenCode: async () => results.opencode });
  const alone = await plain();
  assert.deepEqual(alone.threads.map((row) => row.id).sort(), [uuid(1), `local_${uuid(1)}`, 'cli:cli-session'].sort());
  assert.deepEqual(await plain(), alone);
  // The same threads, given to the builder directly.
  assert.deepEqual(buildSwitchboardDashboard(results.codex.threads, [], nowMs).threads.map((row) => row.id), [uuid(1)]);
});

test('the kept thread query result is frozen and shared, and a scan of it changes nothing', async (t) => {
  const dir = await temporaryDirectory(t, 'asb-scan-kept-rows-');
  const databasePath = path.join(dir, 'state_5.sqlite');
  const rollout = path.join(dir, 'rollout-root.jsonl');
  const database = new DatabaseSync(databasePath);
  database.exec('create table threads (id text primary key, rollout_path text, source text, thread_source text, title text, updated_at_ms integer, archived integer)');
  const insert = database.prepare('insert into threads values (?, ?, ?, ?, ?, ?, 0)');
  const child = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: uuid(1) } } });
  insert.run(uuid(1), rollout, 'vscode', 'user', 'Root', nowMs - 3_000);
  insert.run(uuid(2), rollout, child, 'subagent', 'Child', nowMs - 2_000);
  insert.run(uuid(3), '', 'vscode', 'user', 'Other', nowMs - 1_000);
  database.close();
  await writeFile(rollout, `${JSON.stringify({ timestamp: new Date(nowMs - 1_000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic request.' } })}\n`);
  await utimes(databasePath, (nowMs - 60_000) / 1000, (nowMs - 60_000) / 1000);
  const sessionIndexPath = path.join(dir, 'session_index.jsonl');
  await writeFile(sessionIndexPath, `${JSON.stringify({ id: uuid(3), thread_name: 'Sidebar title' })}\n`);
  const options = { databasePath, sessionIndexPath, globalStatePath: path.join(dir, 'absent'), nowMs, rolloutThreadFilter: isSwitchboardRoot };

  const kept = await readThreadRows({ databasePath });
  assert.equal(kept.length, 3);
  assert.equal(Object.isFrozen(kept) && kept.every(Object.isFrozen), true);
  assert.throws(() => { kept[0].title = 'Changed'; }, TypeError);
  assert.throws(() => kept.sort(), TypeError);
  // A second read is the kept result itself, and a reader of the public function still gets its own rows.
  assert.equal(await readThreadRows({ databasePath }), kept);
  const own = await readThreads({ databasePath });
  assert.deepEqual(own, kept.map((row) => ({ ...row })));
  assert.equal(Object.isFrozen(own[0]), false);
  assert.notEqual(own[0], kept[0]);

  const first = await loadCodexDashboard(options);
  const second = await loadCodexDashboard(options);
  assert.deepEqual(second.threads, first.threads);
  assert.equal(await readThreadRows({ databasePath }), kept);
  // The signals of the log are on the thread, not on the row of the kept result.
  const thread = (id) => first.threads.find((item) => item.id === id);
  assert.equal(thread(uuid(1)).latestUserMessageAtMs > 0, true);
  assert.equal(Object.hasOwn(kept.find((row) => row.id === uuid(1)), 'latestUserMessageAtMs'), false);
  assert.deepEqual([thread(uuid(3)).title, thread(uuid(3)).inCodexSidebar, thread(uuid(1)).inCodexSidebar], ['Sidebar title', true, false]);
});
