import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_SESSION_FIELDS, CLAUDE_SESSION_METADATA_FIELDS, CLAUDE_SESSION_SPAWNED_FIELDS, loadClaudeDesktopCodeThreads, normalizeClaudeDesktopCodeSession,
  pickClaudeSession, readClaudeSessionFile,
} from '../src/claude-data.mjs';
import {
  CODEX_GLOBAL_STATE_KEYS, codexNativeReadStatus, getCodexCacheStats, parseCodexGlobalState, readCodexGlobalState,
} from '../src/codex-data.mjs';

const nowMs = Date.parse('2026-10-21T12:00:00Z');
const CLI_ID = '123e4567-e89b-12d3-a456-426614174000';
// Many fields that no reader reads, with a marker: a copy of one in a cache entry is a leak.
const extraFields = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`extra${index}`, {
  note: `PRIVATE-${index} ${'x'.repeat(500)}`, list: [1, 2, 3] }]));
const fullSession = () => ({
  sessionId: 'local_full', id: 'local_other', cliSessionId: CLI_ID, originCwd: '/work/origin', cwd: '/work/other',
  lastActivityAt: nowMs - 60_000, createdAt: '2026-10-21T10:00:00Z', title: 'Full title', name: 'Name', displayName: 'Display',
  conversationTitle: 'Conversation', model: 'claude-synthetic', isArchived: true, priorCliSessionIds: ['prior-1', 'not valid!'],
  bridgeSessionIds: ['session_abc', 'wrong'], permissionMode: 'acceptEdits', completedTurns: 7,
  metadata: { title: 'Meta title', name: 'Meta name', note: 'PRIVATE-metadata' },
  spawnedFrom: { btw: true, sideSession: true, userFork: true, sessionId: 'local_parent', taskId: 'task_1',
    title: 'PRIVATE-parent (fork)', name: 'PRIVATE-fork' }, ...extraFields,
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-cache-fields-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the Claude session cache keeps only the fields that the readers read', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'local_full.json');
  const full = fullSession();
  await writeFile(filePath, JSON.stringify(full));
  const fileStat = await stat(filePath);
  assert.ok(fileStat.size > 90_000);
  const cached = await readClaudeSessionFile(filePath, fileStat);
  assert.deepEqual(Object.keys(cached).sort(), [...CLAUDE_SESSION_FIELDS, 'metadata', 'spawnedFrom'].sort());
  assert.deepEqual(Object.keys(cached.metadata).sort(), [...CLAUDE_SESSION_METADATA_FIELDS].sort());
  assert.deepEqual(cached.spawnedFrom, { btw: true });
  assert.ok(JSON.stringify(cached).length < 1000);
  assert.equal(JSON.stringify(cached).includes('PRIVATE'), false);
  // The next read gives the cached object, so the cache holds the picked object and not the parsed file.
  assert.equal(await readClaudeSessionFile(filePath, fileStat), cached);
  // A field that the file lacks is not added.
  assert.deepEqual(pickClaudeSession({ title: 'Only', extra: 1, metadata: { other: 1 } }), { title: 'Only', metadata: {} });
  assert.deepEqual(pickClaudeSession({ title: null, model: '' }), { title: null, model: '' });
});

test('the Claude readers read the same values from the picked session', () => {
  const full = fullSession();
  const expected = normalizeClaudeDesktopCodeSession(full, {}, nowMs);
  assert.equal(expected.externalId, 'local_full');
  assert.equal(expected.title, 'Full title');
  assert.equal(expected.cwd, '/work/origin');
  assert.equal(expected.model, 'claude-synthetic');
  assert.equal(expected.archived, true);
  assert.equal(expected.sideChat, true);
  assert.deepEqual(expected.priorCliSessionIds, ['prior-1']);
  assert.deepEqual(expected.bridgeSessionIds, ['session_abc']);
  assert.equal(expected.permissionMode, 'acceptEdits');
  assert.equal(expected.completedTurns, 7);
  // Each step removes one more field, so the fallbacks and nested fields of the readers run.
  const variant = { ...full };
  for (const name of [...CLAUDE_SESSION_FIELDS, 'metadata', 'spawnedFrom']) {
    assert.deepEqual(normalizeClaudeDesktopCodeSession(pickClaudeSession(variant), {}, nowMs),
      normalizeClaudeDesktopCodeSession(variant, {}, nowMs), `before the removal of ${name}`);
    delete variant[name];
  }
  assert.deepEqual(normalizeClaudeDesktopCodeSession(pickClaudeSession(variant), {}, nowMs).title, 'General coding session');
  // Odd values of the title sources and nested fields.
  for (const odd of [{ title: 42 }, { title: ['a', 'b'] }, { metadata: 'text', name: 'Name' }, { metadata: [], name: 'Name' },
    { metadata: null, name: 'Name' }, { metadata: { title: 'Meta title' } }, { metadata: { name: ' Meta\n name ' }, title: '' },
    { spawnedFrom: 'text' }, { spawnedFrom: null }, { spawnedFrom: [] }, { spawnedFrom: { btw: 'true' } }, { spawnedFrom: { btw: true } }]) {
    assert.equal(normalizeClaudeDesktopCodeSession({ sessionId: 'local_odd', ...odd }, {}, nowMs).sideChat, odd.spawnedFrom?.btw === true);
    assert.deepEqual(normalizeClaudeDesktopCodeSession(pickClaudeSession({ sessionId: 'local_odd', ...odd }), {}, nowMs),
      normalizeClaudeDesktopCodeSession({ sessionId: 'local_odd', ...odd }, {}, nowMs), JSON.stringify(odd));
  }
});

test('the Claude session fields list has every field that the readers read, and no other', () => {
  const read = new Set();
  const readMetadata = new Set();
  const readSpawned = new Set();
  const recorder = (names, nested = null) => new Proxy({}, { get: (_target, name) => {
    if (typeof name !== 'string') return undefined;
    names.add(name);
    return nested?.[name];
  } });
  normalizeClaudeDesktopCodeSession(recorder(read, { metadata: recorder(readMetadata), spawnedFrom: recorder(readSpawned) }), {}, nowMs);
  // The transcript lookup of `loadClaudeDesktopCodeThreads` reads `cliSessionId`, which `normalizeClaudeDesktopCodeSession` reads too.
  assert.deepEqual([...read].sort(), [...CLAUDE_SESSION_FIELDS, 'metadata', 'spawnedFrom'].sort());
  assert.deepEqual([...readMetadata].sort(), [...CLAUDE_SESSION_METADATA_FIELDS].sort());
  assert.deepEqual([...readSpawned].sort(), [...CLAUDE_SESSION_SPAWNED_FIELDS].sort());
});

test('the Claude scan gives the same rows from a large session file, and fails the same for a bad file', async (t) => {
  const directory = await temporaryDirectory(t);
  const appDir = path.join(directory, 'app');
  const projectsDir = path.join(directory, 'projects');
  const sessions = path.join(appDir, 'claude-code-sessions', 'account');
  await mkdir(sessions, { recursive: true });
  await mkdir(path.join(projectsDir, 'project'), { recursive: true });
  await writeFile(path.join(sessions, 'local_full.json'), JSON.stringify(fullSession()));
  // The transcript is found through `cliSessionId`; its Git branch shows that the scan read it.
  await writeFile(path.join(projectsDir, 'project', `${CLI_ID}.jsonl`), `${JSON.stringify({ type: 'assistant',
    timestamp: new Date(nowMs - 3_600_000).toISOString(), gitBranch: 'synthetic-branch',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic.' }] } })}\n`);
  const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, nowMs });
  assert.equal(threads.length, 1);
  const [thread] = threads;
  assert.deepEqual(
    { id: thread.id, title: thread.title, cwd: thread.cwd, projectName: thread.projectName, model: thread.model, archived: thread.archived,
      cliSessionId: thread.cliSessionId, priorCliSessionIds: thread.priorCliSessionIds, bridgeSessionIds: thread.bridgeSessionIds,
      permissionMode: thread.permissionMode, completedTurns: thread.completedTurns, createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs, gitBranch: thread.gitBranch },
    { id: 'claude-desktop-code:local_full', title: 'Full title', cwd: '/work/origin', projectName: 'origin', model: 'claude-synthetic',
      archived: true, cliSessionId: CLI_ID, priorCliSessionIds: ['prior-1'], bridgeSessionIds: ['session_abc'],
      permissionMode: 'acceptEdits', completedTurns: 7, createdAtMs: Date.parse('2026-10-21T10:00:00Z'), updatedAtMs: nowMs - 60_000,
      gitBranch: 'synthetic-branch' });
  // A file that holds `null` is a read error, and a file that holds a number is skipped.
  const bad = path.join(directory, 'bad');
  await mkdir(path.join(bad, 'claude-code-sessions', 'account'), { recursive: true });
  await writeFile(path.join(bad, 'claude-code-sessions', 'account', 'local_null.json'), 'null');
  const options = { appDir: bad, projectsDir, nowMs, strictMetadataRead: true };
  const nullFile = await loadClaudeDesktopCodeThreads(options);
  assert.equal(nullFile.provider.metadataReadErrors, 1);
  assert.equal(nullFile.threads.length, 0);
  await writeFile(path.join(bad, 'claude-code-sessions', 'account', 'local_null.json'), '5');
  const numberFile = await loadClaudeDesktopCodeThreads(options);
  assert.equal(numberFile.provider.metadataReadErrors, 0);
  assert.equal(numberFile.threads.length, 0);
});

test('the Codex global state cache keeps only the keys that the reader reads', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, '.codex-global-state.json');
  const readState = { version: 1, unreadByIdentity: { 'identity-a': { 'local:host': [] } }, legacyMigration: { done: true } };
  const extraKeys = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`extra-key-${index}`, { note: `PRIVATE-${index} ${'x'.repeat(500)}` }]));
  await writeFile(filePath, JSON.stringify({ ...extraKeys, 'electron-thread-read-state-v1': readState }));
  assert.deepEqual(parseCodexGlobalState(JSON.stringify({ ...extraKeys, 'electron-thread-read-state-v1': readState })),
    { 'electron-thread-read-state-v1': readState });
  const before = getCodexCacheStats().metadata;
  const cached = await readCodexGlobalState(filePath);
  assert.deepEqual(Object.keys(cached), CODEX_GLOBAL_STATE_KEYS);
  assert.deepEqual(cached['electron-thread-read-state-v1'], readState);
  assert.equal(JSON.stringify(cached).includes('PRIVATE'), false);
  // The next read gives the cached object, so the cache holds the picked object and not the parsed file.
  assert.equal(await readCodexGlobalState(filePath), cached);
  const after = getCodexCacheStats().metadata;
  assert.equal(after.misses - before.misses, 1);
  assert.equal(after.hits - before.hits, 1);
  // A file without the key, a missing file, and a value that is not an object keep their old results.
  assert.deepEqual(parseCodexGlobalState(JSON.stringify(extraKeys)), {});
  assert.deepEqual(parseCodexGlobalState('[1, 2]'), {});
  assert.equal(parseCodexGlobalState('null'), null);
  assert.equal(parseCodexGlobalState('5'), 5);
  assert.deepEqual(await readCodexGlobalState(path.join(directory, 'absent')), {});
});

test('the Codex native read status is the same from the picked global state', () => {
  const digest = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const identity = digest(['chatgpt', 'synthetic-account', 'synthetic-user']);
  const localHost = `local:${digest(['local', 'local', null])}`;
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const thread = { id, creatorAccountId: 'synthetic-account', creatorUserId: 'synthetic-user' };
  const extra = { 'electron-persisted-atom-state': { note: 'x'.repeat(1000) }, 'thread-project-assignments': { [id]: 'project' } };
  const states = [
    { 'electron-thread-read-state-v1': { version: 1, unreadByIdentity: { [identity]: { [localHost]: [id] } } } },
    { 'electron-thread-read-state-v1': { version: 1, unreadByIdentity: { [identity]: { [localHost]: [] } } } },
    { 'electron-thread-read-state-v1': { version: 2, unreadByIdentity: { [identity]: { [localHost]: [id] } } } },
    { 'electron-thread-read-state-v1': { version: 1, unreadByIdentity: { [identity]: { 'local:other': [id] } } } },
    {},
  ];
  const statuses = [];
  for (const state of states) {
    const full = { ...extra, ...state };
    const picked = parseCodexGlobalState(JSON.stringify(full));
    const status = codexNativeReadStatus(thread, picked);
    assert.deepEqual(status, codexNativeReadStatus(thread, full));
    statuses.push(status.readStatus);
  }
  assert.deepEqual(statuses, ['unread', 'read', 'unknown', 'unknown', 'unknown']);
});

test('the Codex global state keys list has every key that the reader reads, and no other', () => {
  const read = new Set();
  const state = new Proxy({}, { get: (_target, name) => {
    if (typeof name === 'string') read.add(name);
    return undefined;
  } });
  codexNativeReadStatus({ id: 'thread', creatorAccountId: 'account', creatorUserId: 'user' }, state);
  assert.deepEqual([...read].sort(), [...CODEX_GLOBAL_STATE_KEYS].sort());
});
