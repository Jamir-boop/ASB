import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DashboardSnapshot } from '../src/dashboard-snapshot.mjs';
import { createAsbServer } from '../src/asb-server.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { useClaudeQuestionText } from '../src/claude-data.mjs';
import { createClaudeQuestions } from '../src/claude-questions.mjs';
import { createSwitchboardServer, loadSwitchboardDashboard } from '../src/switchboard.mjs';

const REVISION = 'a'.repeat(64);
const MACHINE = '0123456789abcdef';
const now = Date.now;
const fileFor = (root) => path.join(root, 'asb', 'last-list.json');

async function until(predicate) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Expected asynchronous work to finish.');
}

// A made-up list; the member row and its message stand for a machine group.
const dashboard = (threads) => ({ generatedAtMs: now(), providers: [{ id: 'codex', label: 'Codex', status: 'ok' }],
  threads: threads || [
    { id: 'local-1', title: 'Synthetic one', cwd: '/made-up/one', state: 'idle', pending: true, updatedAtMs: now() - 1_000 },
    { id: 'local-2', title: 'Synthetic two', cwd: '/made-up/two', state: 'working', pending: false, updatedAtMs: now() - 2_000 },
    { id: 'm:ffffffffffffffff:r', title: 'Member row', remote: true, state: 'working', pending: true, updatedAtMs: now() },
  ],
  messages: [{ from: 'local-1', to: 'local-2', atMs: now() - 500 }, { from: 'm:ffffffffffffffff:r', to: 'local-1', atMs: now() - 400 }],
  pinnedOrder: ['local-1', 'm:ffffffffffffffff:r'], persistentUnread: true });

// The temporary state folder: `<root>/asb` holds the saved file, as the engine's state folder does.
async function stateFolder(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asb-saved-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await mkdir(path.join(root, 'asb'), { recursive: true, mode: 0o700 });
  await chmod(path.join(root, 'asb'), 0o700);
  return root;
}

// A scan with no watches that ends at once; `loadDashboard` waits on the gate of the caller when it gives one.
async function snapshot(t, root, { machine = MACHINE, revision = REVISION, load = async () => dashboard(), serviceMode = true } = {}) {
  const loads = [];
  const instance = new DashboardSnapshot({ serviceMode, now,
    dashboardWatchPaths: [], savedListFile: fileFor(root), savedListMachineId: () => machine, readSourcesRevision: async () => revision,
    loadDashboard: async () => { loads.push(now()); return load(); } });
  const closed = [];
  // The snapshot reads the saved file when the server listens, so the stub calls that callback at once.
  instance.attach({ once: (event, callback) => { if (event === 'listening') callback(); }, on: () => {}, close: () => closed.push(true),
    address: () => ({ port: 1 }) });
  t.after(() => instance.attach({ once: () => {}, on: () => {}, close() {} }));
  return { instance, loads, file: fileFor(root) };
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function serveServer(t, root, { serviceMode = true, playSound, panelMachines, load } = {}) {
  const sounds = [];
  const server = createAsbServer({ serviceMode, now, dashboardWatchPaths: [], savedListFile: fileFor(root),
    savedListMachineId: () => MACHINE, readSourcesRevision: async () => REVISION, playSound: playSound || ((kind) => sounds.push(kind)),
    panelMachines, loadDashboard: load || (async () => dashboard()) });
  return { server, base: await listen(t, server), sounds };
}

// A saved file exactly as the engine writes it, for the tests that do not need a first scan.
async function saveFile(root, value, { mode = 0o600, folderMode = 0o700 } = {}) {
  const file = fileFor(root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), folderMode);
  await writeFile(file, JSON.stringify(value), { mode });
  await chmod(file, mode);
  return file;
}
const savedRecord = (list, overrides = {}) => ({ version: 1, machineId: MACHINE, sourcesRevision: REVISION, savedAtMs: now() - 5_000,
  list: list || { providers: [{ id: 'codex', label: 'Codex', status: 'ok' }], threads: [{ id: 'saved-1', title: 'Saved', state: 'idle', pending: true }],
    summary: { needs: 1, working: 0, total: 1 }, sourcesRevision: REVISION }, ...overrides });

test('fresh and stale dashboard replies carry positions counters or null', async (t) => {
  const stats = { fileBytes: 120, maxFileBytes: 1024,
    sections: { claude: { written: 1, droppedByCount: 2, droppedByRecordBytes: 3, droppedByFileLimit: 4 } } };
  const scanning = { ready: async () => {}, scanDone() {} };
  for (const readerPositions of [undefined, scanning, { ...scanning, saveStats: () => stats }]) {
    const root = await stateFolder(t);
    await saveFile(root, savedRecord());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const base = await listen(t, createSwitchboardServer({ serviceMode: true, readerPositions, pendingStatePath: false,
      palettePath: '', savedListFile: fileFor(root), savedListMachineId: () => MACHINE, readSourcesRevision: async () => REVISION,
      loadDashboard: async () => { await gate; return dashboard(); } }));
    const expected = readerPositions?.saveStats ? stats : null;
    try {
      const stale = await (await fetch(`${base}/api/dashboard?stale=1`)).json();
      assert.equal(stale.stale, true);
      assert.deepEqual(stale.performance.positions, expected);
    } finally { release(); }
    const fresh = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal('stale' in fresh, false);
    assert.deepEqual(fresh.performance.positions, expected);
  }
});

// The same pending AskUserQuestion transcript and Desktop session metadata as the question-text tests.
async function questionSource(root) {
  const atMs = now();
  const cliSessionId = 'cccccccc-dddd-4eee-8fff-000000000001';
  const sessionId = 'local_00000000-0000-4000-8000-000000000001';
  const sourceRegistry = new AppSourceRegistry({ homeDir: root, env: {}, platform: 'linux', discoverPersonal: false });
  const source = (await sourceRegistry.read()).find(({ id }) => id === 'claude-desktop-code');
  const project = path.join(source.projectsDir, 'synthetic-project');
  const sessions = path.join(source.dataDir, 'claude-code-sessions');
  await mkdir(project, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const iso = (offset) => new Date(atMs + offset).toISOString();
  const cwd = path.join(root, 'synthetic-work');
  await writeFile(path.join(project, `${cliSessionId}.jsonl`), [
    { type: 'user', timestamp: iso(-60_000), sessionId: cliSessionId, cwd, entrypoint: 'cli', message: { role: 'user', content: 'Synthetic task' } },
    { type: 'assistant', timestamp: iso(-30_000), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion',
      input: { questions: [{ question: 'MARKERQUESTION' }] } }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(sessions, `${sessionId}.json`), JSON.stringify({ sessionId, cliSessionId, cwd, title: 'Synthetic chat',
    createdAt: atMs - 120_000, lastActivityAt: atMs }));
  const options = { serviceMode: true, sourceRegistry, dashboardWatchPaths: [], pendingStatePath: false, palettePath: '',
    savedListFile: fileFor(root), savedListMachineId: () => MACHINE, now: () => atMs,
    loadDashboard: (args) => loadSwitchboardDashboard({ ...args, nowMs: atMs }) };
  return { cliSessionId, options };
}

test('a restarted snapshot serves the same local rows as the scan that saved them', async (t) => {
  const root = await stateFolder(t);
  const { options } = await questionSource(root);
  const base = await listen(t, createSwitchboardServer(options));
  const full = await (await fetch(`${base}/api/dashboard`)).json();
  const local = full.threads.filter((row) => !row.remote);
  assert.equal(local.length, 1);
  assert.equal(local[0].questionPending, true);
  await until(() => readFile(fileFor(root), 'utf8').catch(() => ''));

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const restarted = await listen(t, createSwitchboardServer({ ...options,
    loadDashboard: async (args) => { await gate; return options.loadDashboard(args); } }));
  try {
    const saved = await (await fetch(`${restarted}/api/dashboard?stale=1`)).json();
    assert.equal(saved.stale, true);
    assert.deepEqual(saved.threads, local);
  } finally { release(); }
  await (await fetch(`${restarted}/api/dashboard`)).json();
});

test('the saved list contains neither pending question nor approval text with the phone text switch off or on', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  for (const sendText of [false, true]) {
    useClaudeQuestionText(sendText);
    const root = await stateFolder(t);
    const { cliSessionId, options } = await questionSource(root);
    const claudeQuestions = createClaudeQuestions({ now: options.now });
    const { requestId } = claudeQuestions.open({ provider: 'claude', sessionKey: cliSessionId,
      approval: { kind: 'tool', title: 'Allow a shell command?', display: [{ label: 'Command', text: 'MARKERAPPROVAL', mono: true }], note: false } });
    const base = await listen(t, createSwitchboardServer({ ...options, claudeQuestions }));
    const live = await (await fetch(`${base}/api/dashboard?text=1`)).json();
    const [row] = live.threads;
    assert.equal(row.questionPending, true);
    assert.equal(row.questionText, sendText ? 'MARKERQUESTION' : undefined);
    assert.equal(row.approval?.requestId, requestId);
    assert.equal(row.approval.display[0].text, 'MARKERAPPROVAL');
    let saved;
    await until(async () => (saved = await readFile(fileFor(root), 'utf8').catch(() => '')));
    assert.deepEqual(JSON.parse(saved).list.threads.map(({ id }) => id), [row.id]);
    assert.doesNotMatch(saved, /MARKERQUESTION|MARKERAPPROVAL/);
  }
});

test('a scan saves the private list: 0600 in 0700, with the version, machine, revision, and no member rows', async (t) => {
  const root = await stateFolder(t);
  const { instance, file } = await snapshot(t, root);
  await instance.loadSharedDashboard({ force: true });
  await until(async () => readFile(file, 'utf8').catch(() => ''));
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['list', 'machineId', 'savedAtMs', 'sourcesRevision', 'version']);
  assert.equal(saved.version, 1);
  assert.equal(saved.machineId, MACHINE);
  assert.equal(saved.sourcesRevision, REVISION);
  assert.deepEqual(saved.list.threads.map((row) => row.id), ['local-1', 'local-2']);
  assert.deepEqual(saved.list.messages.map((item) => item.from), ['local-1']);
  assert.deepEqual(saved.list.pinnedOrder, ['local-1']);
  assert.deepEqual(saved.list.summary, { needs: 1, working: 1, total: 2 });
  assert.equal('performance' in saved.list, false);
  assert.equal('generatedAtMs' in saved.list, false);
});

test('the save stays off the scan path: the scan ends before the write is tried', async (t) => {
  const root = await stateFolder(t);
  const { instance, file } = await snapshot(t, root);
  // The write goes to a later turn; the scan promise settles first, so a scan never waits for the file.
  await instance.loadSharedDashboard({ force: true });
  // The file appears after the scan, within the next turns.
  await until(async () => readFile(file, 'utf8').catch(() => ''));
});

test('a second scan with the same list writes nothing, and at most one write runs in 30 s', async (t) => {
  const root = await stateFolder(t);
  let list = dashboard();
  const { instance, file } = await snapshot(t, root, { load: async () => list });
  await instance.loadSharedDashboard({ force: true });
  await until(async () => readFile(file, 'utf8').catch(() => ''));
  const first = await stat(file);
  list = dashboard([...dashboard().threads.map((row) => ({ ...row, title: 'Changed' }))]);
  await instance.loadSharedDashboard({ force: true });
  await delay(100);
  // A changed list inside the 30 s window is not saved.
  assert.equal((await stat(file)).mtimeMs, first.mtimeMs);
});

test('npm start and a test without the option write nothing and read nothing', async (t) => {
  const root = await stateFolder(t);
  const before = savedRecord();
  await saveFile(root, before);
  const info = await stat(fileFor(root));
  const { instance } = await snapshot(t, root, { serviceMode: false });
  await instance.loadSharedDashboard({ force: true });
  await delay(50);
  // No saved list is served, and the file is unchanged: no read, no write.
  assert.equal(await instance.staleList(), null);
  assert.equal((await stat(fileFor(root))).mtimeMs, info.mtimeMs);
  assert.deepEqual(JSON.parse(await readFile(fileFor(root), 'utf8')), before);
});

test('a new engine answers ?stale=1 at once while a plain read waits for the first scan', async (t) => {
  const root = await stateFolder(t);
  const saved = savedRecord();
  await saveFile(root, saved);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { base, server } = await serveServer(t, root, { load: async () => { await gate; return dashboard([{ id: 'new', title: 'Fresh', state: 'idle' }]); } });
  const staleReply = await fetch(`${base}/api/dashboard?stale=1`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(staleReply.headers.get('content-encoding'), 'gzip');
  // fetch decodes the gzip body; the fields follow the palette of the list.
  const stale = await staleReply.json();
  assert.equal(stale.stale, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.savedAtMs, saved.savedAtMs);
  assert.deepEqual(stale.threads.map((row) => row.id), ['saved-1']);
  const waiting = fetch(`${base}/api/dashboard`);
  assert.equal(await Promise.race([waiting.then(() => 'done'), delay(100).then(() => 'waiting')]), 'waiting');
  release();
  const fresh = await (await waiting).json();
  assert.equal('stale' in fresh, false);
  assert.deepEqual(fresh.threads.map((row) => row.id), ['new']);
  // After the first scan, ?stale=1 gets the fresh list with no stale field.
  const later = await (await fetch(`${base}/api/dashboard?stale=1`)).json();
  assert.equal('stale' in later, false);
  assert.deepEqual(later.threads.map((row) => row.id), ['new']);
  server.close();
});

test('the stale reply has its own tag, and its tag never gives a 304 for the fresh list', async (t) => {
  const root = await stateFolder(t);
  const saved = savedRecord();
  await saveFile(root, saved);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { base } = await serveServer(t, root, { load: async () => { await gate; return dashboard([{ id: 'new', title: 'Fresh', state: 'idle' }]); } });
  const first = await fetch(`${base}/api/dashboard?stale=1`);
  const staleTag = first.headers.get('etag');
  const body = await first.json();
  const { stale, savedAtMs, performance, ...list } = body;
  const ownTag = `"${createHash('sha256').update('stale\0' + JSON.stringify({ ...list, palette: body.palette })).digest('base64url')}"`;
  assert.equal(staleTag, ownTag);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  // A stale tag never gives a 304: the saved time is not in the tag, and a stale reply is always complete.
  const again = await fetch(`${base}/api/dashboard?stale=1`, { headers: { 'If-None-Match': staleTag } });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('etag'), staleTag);
  release();
  const fresh = await fetch(`${base}/api/dashboard`, { headers: { 'If-None-Match': staleTag } });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.headers.get('etag'), staleTag);
});

test('a damaged, wrong, open, too large, or symlinked file is ignored, and the plain read waits', async (t) => {
  const before = savedRecord();
  const cases = [
    ['damaged JSON', async (root) => { await saveFile(root, before); await writeFile(fileFor(root), '{"version":1,'); }],
    ['wrong version', async (root) => saveFile(root, { ...before, version: 2 })],
    ['wrong machine', async (root) => saveFile(root, { ...before, machineId: 'ffffffffffffffff' })],
    ['other sources revision', async (root) => saveFile(root, { ...before, sourcesRevision: 'b'.repeat(64) })],
    ['an open file', async (root) => saveFile(root, before, { mode: 0o644 })],
    ['an open folder', async (root) => saveFile(root, before, { folderMode: 0o755 })],
    ['a symlink', async (root) => { const target = fileFor(root); await saveFile(root, before);
      const elsewhere = path.join(root, 'target.json'); await rename(target, elsewhere); await symlink(elsewhere, target); }],
    ['too large', async (root) => { await saveFile(root, before); await writeFile(fileFor(root), ' '.repeat(16 * 1024 * 1024 + 1)); }],
  ];
  for (const [name, prepare] of cases) {
    const root = await stateFolder(t);
    try { await prepare(root); } catch { continue; }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { base, server } = await serveServer(t, root, { load: async () => { await gate; return dashboard([{ id: 'new', title: 'Fresh', state: 'idle' }]); } });
    const waiting = fetch(`${base}/api/dashboard?stale=1`);
    assert.equal(await Promise.race([waiting.then(() => 'answered'), delay(100).then(() => 'waiting')]), 'waiting', name);
    release();
    const reply = await (await waiting).json();
    assert.equal('stale' in reply, false, name);
    server.close();
  }
});

test('a saved list plays no sound, adds nothing to the panel, and never moves Pending attention', async (t) => {
  const root = await stateFolder(t);
  await saveFile(root, savedRecord());
  let panelCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { base, sounds } = await serveServer(t, root, { panelMachines: async () => { panelCalls += 1; return []; },
    load: async () => { await gate; return dashboard([{ id: 'new', title: 'Fresh', state: 'idle', pending: true }]); } });
  const stale = await (await fetch(`${base}/api/dashboard?stale=1`)).json();
  assert.equal(stale.stale, true);
  // The saved list asked for no panel count and played no sound.
  assert.equal(panelCalls, 0);
  assert.deepEqual(sounds, []);
  release();
  const fresh = await (await fetch(`${base}/api/dashboard`)).json();
  assert.deepEqual(fresh.threads.map((row) => row.id), ['new']);
  await delay(50);
  assert.deepEqual(sounds, []);
});

test('the phone gateway query (force and text) never gets a stale reply', async (t) => {
  const root = await stateFolder(t);
  await saveFile(root, savedRecord());
  let release, started = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const { base } = await serveServer(t, root, { load: async () => { started = true; await gate; return dashboard([{ id: 'new', title: 'Fresh', state: 'idle' }]); } });
  const waiting = fetch(`${base}/api/dashboard?force=1&text=1`);
  await delay(50);
  assert.equal(started, true);
  release();
  const reply = await (await waiting).json();
  assert.equal('stale' in reply, false);
});

test('the startup list is the saved file once, and the first scan replaces it', async (t) => {
  const root = await stateFolder(t);
  const saved = savedRecord();
  await saveFile(root, saved);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { instance } = await snapshot(t, root, { load: async () => { await gate; return dashboard([{ id: "new", title: "Fresh", state: "idle" }]); } });
  // attach() starts the read, as the engine's listen does.
  await until(async () => {
    const value = await instance.staleList();
    return value;
  });
  const value = await instance.staleList();
  assert.equal(value.savedAtMs, saved.savedAtMs);
  assert.deepEqual(JSON.parse(value.text).threads.map((row) => row.id), ['saved-1']);
  release();
  await instance.loadSharedDashboard();
  assert.equal(await instance.staleList(), null);
});
