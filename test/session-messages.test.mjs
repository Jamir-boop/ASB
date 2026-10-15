import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invalidateClaudeData, loadClaudeDesktopCodeThreads } from '../src/claude-data.mjs';
import { loadCodexDashboard, readBridgeMessages } from '../src/codex-data.mjs';
import { buildSwitchboardDashboard, loadSwitchboardDashboard, resolveSessionMessages } from '../src/switchboard.mjs';

const nowMs = Date.parse('2026-10-15T10:00:00.000Z');
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = (n) => `local_${uuid(n)}`;
const SYSTEM_LINE = 'A message from another session arrived.';
const tag = (attributes, body = 'SECRET-BODY') => `<cross-session-message ${attributes}>${body}</cross-session-message>`;
const at = (offset) => new Date(nowMs + offset).toISOString();
const meta = (offset, content, extra = {}) => ({ type: 'user', isMeta: true, message: { role: 'user', content }, timestamp: at(offset), ...extra });
const metaTag = (offset, attributes) => meta(offset, `${SYSTEM_LINE}\n${tag(attributes)}`);
const queued = (offset, prompt) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt }, timestamp: at(offset) });

async function temporaryDirectory(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function claudeFixture(t, records, { maxBytes = 8 * 1024 * 1024, metadata = {} } = {}) {
  const dir = await temporaryDirectory(t, 'asb-session-messages-claude-');
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
  const file = path.join(projectsDir, 'project', `${uuid(900)}.jsonl`);
  const metadataPath = path.join(appDir, 'claude-code-sessions', `${local(1)}.json`);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(metadataPath, JSON.stringify({ sessionId: local(1), cliSessionId: uuid(900), cwd: '/tmp/synthetic-work',
    createdAt: nowMs - 200_000, lastActivityAt: nowMs, ...metadata }));
  await utimes(metadataPath, nowMs / 1000, nowMs / 1000);
  await writeFile(file, jsonl(records));
  return { file, load: async () => (await loadClaudeDesktopCodeThreads({ appDir, projectsDir, maxBytes, nowMs })).threads[0] };
}

test('Claude reads both delivery forms of a session message and keeps only the sender and the time', async (t) => {
  const records = [
    metaTag(-60_000, `from="uds:/run/user/1000/cc-socks/1.sock" from-session="${local(2)}" from-name="SECRET-NAME" from-mode="prompting"`),
    queued(-50_000, tag(`from-mode="prompting" from-session="${uuid(3)}" from="uds:/run/user/1000/cc-socks/2.sock" hop-chain="a,b"`)),
    metaTag(-40_000, 'from="bridge:session_Abc123" from-name="remote"'),
    queued(-35_000, tag(`from="${local(4)}"`)),
    metaTag(-30_000, 'from="bridge:cse_X9" from-session="not-an-id"'),
    // None of these is a delivery record of a message.
    meta(-29_000, `<task-notification>\n<task-id>t1</task-id>\n<summary>${tag(`from-session="${local(5)}"`)}</summary>\n</task-notification>`),
    meta(-28_000, `${'x'.repeat(250)}\n${tag(`from-session="${local(5)}"`)}`),
    meta(-27_000, `Quoted: <quote>${tag(`from-session="${local(5)}"`)}</quote>`),
    { type: 'user', message: { role: 'user', content: tag(`from-session="${local(5)}"`) }, timestamp: at(-26_000) },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: tag(`from-session="${local(5)}"`) }] }, timestamp: at(-25_000) },
    metaTag(-24_000, 'from="uds:/run/user/1000/cc-socks/3.sock" from-name="peer"'),
    metaTag(-23_000, 'from="local_123" from-session="session_abc"'),
    metaTag(-22_000, 'from="bridge:session_bad-token"'),
    queued(-21_000, `Note ${tag(`from-session="${local(5)}"`)}`),
  ];
  const fixture = await claudeFixture(t, records, { metadata: { priorCliSessionIds: [uuid(7), 42, '', 'bad id!'] } });
  const thread = await fixture.load();
  assert.deepEqual(thread.incomingMessages, [
    { from: local(2), atMs: nowMs - 60_000 },
    { from: uuid(3), atMs: nowMs - 50_000 },
    { from: 'bridge:session_Abc123', atMs: nowMs - 40_000 },
    { from: local(4), atMs: nowMs - 35_000 },
    { from: 'bridge:cse_X9', atMs: nowMs - 30_000 },
  ]);
  assert.deepEqual(thread.priorCliSessionIds, [uuid(7)]);

  // The dashboard gets only row ID pairs and times: no body, sender name, or socket address.
  const sender = { id: `claude-desktop-code:${local(2)}`, externalId: local(2), provider: 'claude-desktop-code',
    source: 'claude-desktop-code', title: 'Sender', updatedAtMs: nowMs };
  const board = buildSwitchboardDashboard([thread, sender], [], nowMs);
  assert.deepEqual(board.messages, [{ from: sender.id, to: thread.id, atMs: nowMs - 60_000 }]);
  const json = JSON.stringify(board);
  for (const secret of ['SECRET-BODY', 'SECRET-NAME', 'uds:', 'cc-socks', 'incomingMessages', 'priorCliSessionIds']) {
    assert.equal(json.includes(secret), false, secret);
  }
});

test('Claude keeps the last 20 incoming messages in file order', async (t) => {
  const records = Array.from({ length: 25 }, (_, index) => metaTag(-100_000 + index * 1000, `from-session="${local(100 + index)}"`));
  const thread = await (await claudeFixture(t, records)).load();
  assert.equal(thread.incomingMessages.length, 20);
  assert.deepEqual(thread.incomingMessages[0], { from: local(105), atMs: nowMs - 95_000 });
  assert.deepEqual(thread.incomingMessages.at(-1), { from: local(124), atMs: nowMs - 76_000 });
});

test('appended Claude messages match a full read, and a large file keeps messages before the tail', async (t) => {
  const prompt = (offset) => ({ type: 'user', message: { role: 'user', content: 'Start a synthetic task.' }, timestamp: at(offset) });
  const end = (offset) => ({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }, timestamp: at(offset) });
  const records = [prompt(-100_000)];
  const incremental = await claudeFixture(t, records), full = await claudeFixture(t, records);
  await incremental.load();
  const steps = [
    [metaTag(-90_000, `from-session="${local(2)}"`)],
    [end(-89_000), queued(-88_000, tag(`from-session="${uuid(3)}"`))],
    // An older timestamp than the last lifecycle event still counts in file order.
    [metaTag(-95_000, 'from="bridge:session_Abc"'), prompt(-80_000)],
    Array.from({ length: 22 }, (_, index) => metaTag(-70_000 + index, `from-session="${local(200 + index)}"`)),
  ];
  for (const [index, appended] of steps.entries()) {
    records.push(...appended);
    await appendFile(incremental.file, jsonl(appended));
    invalidateClaudeData({ filePath: incremental.file });
    await writeFile(`${full.file}.replacement`, jsonl(records));
    await rename(`${full.file}.replacement`, full.file);
    const actual = await incremental.load(), expected = await full.load();
    assert.deepEqual(actual, expected, `step ${index}`);
    assert.ok(actual.incomingMessages.length > 0, `step ${index}`);
  }

  const padding = Array.from({ length: 40 }, (_, index) => ({ type: 'progress', data: 'x'.repeat(256), timestamp: at(-50_000 + index) }));
  const large = await claudeFixture(t, [prompt(-100_000), metaTag(-90_000, `from-session="${local(2)}"`), ...padding], { maxBytes: 1024 });
  assert.deepEqual((await large.load()).incomingMessages, [{ from: local(2), atMs: nowMs - 90_000 }]);
});

function bridgeDatabase(codexDir, threadId, { kind = true, wal = false } = {}) {
  const database = new DatabaseSync(path.join(codexDir, 'plugin-state', 'asb-bridge', `${threadId}.sqlite`));
  if (wal) database.exec('pragma journal_mode=WAL;');
  // No `text` column: a reader that selects it fails.
  database.exec(`create table messages(id integer primary key, peer_id text, direction text, status text, turn_id text,
    created_at integer, peer_address text, peer_start integer, from_mode text, expires_at integer${kind ? ', kind text' : ''},
    drop_reason text, status_reason text, awaiting_input integer, native_input_id text, desktop_input_id text);`);
  const insert = database.prepare(`insert into messages(peer_id, direction, status, created_at, peer_address${kind ? ', kind' : ''})
    values (?, ?, ?, ?, 'uds:/run/user/1000/cc-socks/9.sock'${kind ? ', ?' : ''})`);
  return { database, add: (...rows) => { for (const row of rows) insert.run(...(kind ? row : row.slice(0, 4))); } };
}

async function bridgeDirectory(t) {
  const codexDir = await temporaryDirectory(t, 'asb-session-messages-codex-');
  await mkdir(path.join(codexDir, 'plugin-state', 'asb-bridge'), { recursive: true });
  return codexDir;
}

const byTime = (messages) => [...messages].sort((a, b) => a.atMs - b.atMs || a.from.localeCompare(b.from));

test('the bridge reader keeps delivered incoming messages and never reads the message text', async (t) => {
  const codexDir = await bridgeDirectory(t);
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const withKind = bridgeDatabase(codexDir, uuid(1));
  withKind.add(
    [uuid(10), 'in', 'accepted', seconds - 10, 'message'],
    [uuid(11), 'in', 'started', seconds - 20, 'message'],
    [uuid(12), 'in', 'steered', seconds - 30, 'message'],
    [uuid(13), 'in', 'queued', seconds - 5, 'message'],
    [uuid(14), 'in', 'dropped', seconds - 5, 'message'],
    [uuid(15), 'out', 'accepted', seconds - 5, 'message'],
    [uuid(16), 'in', 'accepted', seconds - 5, 'idle-notice'],
    [uuid(17), 'in', 'accepted', seconds - 5, 'subscription-expired'],
    ['not-a-uuid', 'in', 'accepted', seconds - 5, 'message'],
    [uuid(18), 'in', 'accepted', seconds - 500, 'message'],
  );
  withKind.database.close();
  const withoutKind = bridgeDatabase(codexDir, uuid(2), { kind: false });
  withoutKind.add([uuid(20), 'in', 'accepted', seconds - 1]);
  withoutKind.database.close();
  // A database with an old file time is not opened, though its rows are in the window.
  const old = bridgeDatabase(codexDir, uuid(3));
  old.add([uuid(30), 'in', 'accepted', seconds - 1, 'message']);
  old.database.close();
  const oldPath = path.join(codexDir, 'plugin-state', 'asb-bridge', `${uuid(3)}.sqlite`);
  await utimes(oldPath, (now - 600_000) / 1000, (now - 600_000) / 1000);
  // Files that are not a readable thread database are skipped.
  await writeFile(path.join(codexDir, 'plugin-state', 'asb-bridge', `${uuid(4)}.sqlite`), 'not a database');
  await writeFile(path.join(codexDir, 'plugin-state', 'asb-bridge', 'notes.sqlite'), 'not a thread');

  const messages = await readBridgeMessages(codexDir, now - 120_000);
  assert.deepEqual(byTime(messages), [
    { to: uuid(1), from: uuid(12), atMs: (seconds - 30) * 1000 },
    { to: uuid(1), from: uuid(11), atMs: (seconds - 20) * 1000 },
    { to: uuid(1), from: uuid(10), atMs: (seconds - 10) * 1000 },
    { to: uuid(2), from: uuid(20), atMs: (seconds - 1) * 1000 },
  ]);
  // A later window start filters the cached rows.
  assert.deepEqual(byTime(await readBridgeMessages(codexDir, (seconds - 15) * 1000)).map((message) => message.from), [uuid(10), uuid(20)]);
  assert.deepEqual(await readBridgeMessages(path.join(codexDir, 'missing'), now - 120_000), []);
});

test('the bridge reader sees a row that an open WAL writer adds', async (t) => {
  const codexDir = await bridgeDirectory(t);
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const writer = bridgeDatabase(codexDir, uuid(1), { wal: true });
  t.after(() => writer.database.close());
  writer.add([uuid(10), 'in', 'accepted', seconds - 2, 'message']);
  assert.deepEqual(await readBridgeMessages(codexDir, now - 120_000), [{ to: uuid(1), from: uuid(10), atMs: (seconds - 2) * 1000 }]);
  writer.add([uuid(11), 'in', 'accepted', seconds - 1, 'message']);
  assert.deepEqual(byTime(await readBridgeMessages(codexDir, now - 120_000)).map((message) => message.from), [uuid(10), uuid(11)]);
});

test('the Codex dashboard attaches incoming bridge messages to the receiving thread', async (t) => {
  const codexDir = await bridgeDirectory(t);
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const databasePath = path.join(codexDir, 'state_5.sqlite');
  const state = new DatabaseSync(databasePath);
  state.exec(`create table threads(id text primary key, rollout_path text default '', created_at integer, updated_at integer,
    source text default 'vscode', model_provider text, cwd text, title text, tokens_used integer, archived integer, git_sha text,
    git_branch text, git_origin_url text, agent_nickname text, agent_role text, model text, reasoning_effort text,
    created_at_ms integer, updated_at_ms integer);
    insert into threads(id, title, created_at_ms, updated_at_ms) values ('${uuid(1)}', 'Receiver', ${now}, ${now}),
      ('${uuid(2)}', 'Other', ${now}, ${now});`);
  state.close();
  const bridge = bridgeDatabase(codexDir, uuid(1));
  bridge.add([uuid(2), 'in', 'accepted', seconds - 3, 'message']);
  bridge.database.close();
  const dashboard = await loadCodexDashboard({ databasePath, sessionIndexPath: path.join(codexDir, 'session_index.jsonl'),
    globalStatePath: path.join(codexDir, 'global.json'), nowMs: now });
  assert.deepEqual(Object.keys(dashboard), ['generatedAtMs', 'threads']);
  assert.deepEqual(dashboard.threads.find((thread) => thread.id === uuid(1)).incomingMessages, [{ from: uuid(2), atMs: (seconds - 3) * 1000 }]);
  assert.equal(Object.hasOwn(dashboard.threads.find((thread) => thread.id === uuid(2)), 'incomingMessages'), false);
  const board = buildSwitchboardDashboard(dashboard.threads, [], now);
  assert.deepEqual(board.messages, [{ from: uuid(2), to: uuid(1), atMs: (seconds - 3) * 1000 }]);
});

const claudeThread = (n, extra = {}) => ({ id: `claude-desktop-code:${local(n)}`, externalId: local(n), provider: 'claude-desktop-code',
  source: 'claude-desktop-code', title: `Claude ${n}`, updatedAtMs: nowMs, cliSessionId: '', ...extra });
const codexThread = (n, extra = {}) => ({ id: uuid(n), provider: 'codex', title: `Codex ${n}`, updatedAtMs: nowMs, ...extra });

test('session messages resolve each pair type to dashboard rows and drop the rest', () => {
  const A = `claude-desktop-code:${local(1)}`, B = `claude-desktop-code:${local(2)}`, X = uuid(201), Y = uuid(202);
  const threads = [
    claudeThread(1, { cliSessionId: uuid(101), priorCliSessionIds: [uuid(102), uuid(150)], bridgeSessionIds: ['session_AbC1'],
      incomingMessages: [
        { from: local(2), atMs: nowMs - 1000 },
        { from: local(2), atMs: nowMs - 1000 },
        { from: uuid(201), atMs: nowMs - 2000 },
        { from: 'bridge:session_Rem0te', atMs: nowMs - 3000 },
        { from: local(1), atMs: nowMs - 4000 },
        { from: uuid(999), atMs: nowMs - 4100 },
        { from: local(9), atMs: nowMs - 4200 },
        { from: local(2), atMs: nowMs - 120_001 },
        { from: local(2), atMs: nowMs + 5001 },
      ] }),
    claudeThread(2, { cliSessionId: uuid(103), priorCliSessionIds: [uuid(150)], bridgeSessionIds: ['cse_Bb2'],
      incomingMessages: [{ from: 'bridge:cse_AbC1', atMs: nowMs - 9000 }, { from: local(1), atMs: nowMs + 5000 }] }),
    codexThread(201, { incomingMessages: [
      { from: uuid(101), atMs: nowMs - 5000 },
      { from: uuid(102), atMs: nowMs - 6000 },
      { from: uuid(202), atMs: nowMs - 7000 },
      { from: uuid(203), atMs: nowMs - 7500 },
      { from: uuid(150), atMs: nowMs - 7600 },
    ] }),
    codexThread(202),
    codexThread(203, { isSubagent: true, parentThreadId: uuid(202), incomingMessages: [{ from: local(2), atMs: nowMs - 8000 }] }),
    { id: 'claude-desktop-code:session_Rem0te', externalId: 'session_Rem0te', provider: 'claude-desktop-code',
      source: 'claude-remote-cache', title: 'Remote', updatedAtMs: nowMs,
      incomingMessages: [{ from: local(1), atMs: nowMs - 9500 }] },
    // A subagent whose host is not on the board is not a row.
    claudeThread(9, { isSubagent: true, parentThreadId: 'claude-desktop-code:missing', incomingMessages: [{ from: local(1), atMs: nowMs - 100 }] }),
  ];
  const board = buildSwitchboardDashboard(threads, [], nowMs);
  const R = 'claude-desktop-code:session_Rem0te';
  assert.deepEqual(board.messages, [
    { from: A, to: R, atMs: nowMs - 9500 },
    { from: A, to: B, atMs: nowMs - 9000 },
    { from: B, to: Y, atMs: nowMs - 8000 },
    { from: Y, to: X, atMs: nowMs - 7500 },
    { from: Y, to: X, atMs: nowMs - 7000 },
    { from: A, to: X, atMs: nowMs - 6000 },
    { from: A, to: X, atMs: nowMs - 5000 },
    { from: R, to: A, atMs: nowMs - 3000 },
    { from: X, to: A, atMs: nowMs - 2000 },
    { from: B, to: A, atMs: nowMs - 1000 },
    { from: A, to: B, atMs: nowMs + 5000 },
  ]);
  for (const row of board.threads) {
    assert.equal(Object.hasOwn(row, 'incomingMessages'), false, row.id);
    assert.equal(Object.hasOwn(row, 'priorCliSessionIds'), false, row.id);
  }
  assert.deepEqual(buildSwitchboardDashboard([codexThread(1)], [], nowMs).messages, []);
});

test('session messages sort by time, sender, and receiver, and keep the newest 50', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const threads = [
    { id: 'a', externalId: uuid(1), provider: 'codex', incomingMessages: Array.from({ length: 60 }, (_, index) => ({ from: uuid(2), atMs: 1000 + index })) },
    { id: 'b', externalId: uuid(2), provider: 'codex', incomingMessages: [{ from: uuid(3), atMs: 1059 }, { from: uuid(1), atMs: 1059 }] },
    { id: 'c', externalId: uuid(3), provider: 'codex', incomingMessages: [{ from: uuid(1), atMs: 1059 }] },
  ];
  const messages = resolveSessionMessages(threads, rows, { sinceMs: 0, untilMs: 2000 });
  assert.equal(messages.length, 50);
  assert.deepEqual(messages[0], { from: 'b', to: 'a', atMs: 1013 });
  assert.deepEqual(messages.slice(-4), [
    { from: 'a', to: 'b', atMs: 1059 }, { from: 'a', to: 'c', atMs: 1059 },
    { from: 'b', to: 'a', atMs: 1059 }, { from: 'c', to: 'b', atMs: 1059 },
  ]);
});

test('session messages use the scoped row IDs of a non-builtin source', async (t) => {
  const dir = await temporaryDirectory(t, 'asb-session-messages-sources-');
  const dirs = Object.fromEntries(await Promise.all(['codex', 'work', 'claude'].map(async (name) => {
    await mkdir(path.join(dir, name)); return [name, path.join(dir, name)];
  })));
  t.after(() => loadSwitchboardDashboard({ sources: [] }));
  const board = await loadSwitchboardDashboard({
    nowMs,
    sources: [
      { id: 'codex', provider: 'codex', label: 'Codex', enabled: true, builtin: true, dataDir: dirs.codex },
      { id: 'work', provider: 'codex', label: 'Work', enabled: true, builtin: false, launcher: '/bin/true', dataDir: dirs.work },
      { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude', enabled: true, builtin: true,
        dataDir: dirs.claude, projectsDir: path.join(dir, 'projects') },
    ],
    loadCodex: async ({ databasePath }) => ({ threads: path.dirname(databasePath) === dirs.work
      ? [codexThread(301, { incomingMessages: [{ from: local(1), atMs: nowMs - 2000 }] })] : [] }),
    loadClaude: async () => ({ threads: [claudeThread(1, { incomingMessages: [{ from: uuid(301), atMs: nowMs - 1000 }] })] }),
  });
  assert.deepEqual(board.messages, [
    { from: `claude-desktop-code:${local(1)}`, to: `work:${uuid(301)}`, atMs: nowMs - 2000 },
    { from: `work:${uuid(301)}`, to: `claude-desktop-code:${local(1)}`, atMs: nowMs - 1000 },
  ]);
});
