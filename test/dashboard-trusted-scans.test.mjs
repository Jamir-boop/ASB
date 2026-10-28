import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { processStart } from '../src/claude-registry.mjs';
import { loadSwitchboardClaudeThreads } from '../src/claude-remote-data.mjs';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { DashboardSnapshot, reuseCheck } from '../src/dashboard-snapshot.mjs';
import { loadClaudeDesktopCodeThreads, invalidateClaudeData } from '../src/claude-data.mjs';
import { invalidateCodexData } from '../src/codex-data.mjs';
import { loadSwitchboardDashboard, switchboardWatchPaths } from '../src/switchboard.mjs';

let countedRoot = '\0';
const stats = [];
const reads = [];
for (const [name, calls] of [['stat', stats], ['open', reads], ['readFile', reads]]) {
  const original = fs[name];
  fs[name] = (target, ...args) => {
    if (String(target).startsWith(countedRoot)) calls.push(String(target));
    return original(target, ...args);
  };
}
syncBuiltinESMExports();

const jsonl = (...records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const uuid = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await delay(2);
  }
  assert.fail('Expected the snapshot to finish loading.');
}

async function fixture(t, { codexCount = 3, claudeCount = 3, serviceMode = true, covered = true, statusAfterMs = Infinity, loadClaude = loadClaudeDesktopCodeThreads, setup = async () => {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-trusted-scans-'));
  const codexDir = path.join(dir, 'codex');
  const appDir = path.join(dir, 'app');
  const projectsDir = path.join(dir, 'claude', 'projects');
  const project = path.join(projectsDir, 'project');
  const metadata = path.join(appDir, 'claude-code-sessions');
  const sessions = path.join(codexDir, 'sessions');
  await Promise.all([sessions, metadata, project].map((folder) => fs.mkdir(folder, { recursive: true })));
  let clock = Date.parse('2026-10-25T10:00:00Z');
  const start = clock;
  const databasePath = path.join(codexDir, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('create table threads (id text primary key, rollout_path text, title text, cwd text, created_at integer, updated_at integer, archived integer);');
  const insert = database.prepare('insert into threads values (?, ?, ?, ?, ?, ?, 0)');
  const rollouts = Array.from({ length: codexCount }, (_, index) => path.join(sessions, `rollout-${index}.jsonl`));
  for (const [index, file] of rollouts.entries()) insert.run(`codex-${index}`, file, `Task ${index}`, '/made-up/project', clock / 1000, clock / 1000);
  database.close();
  await fs.writeFile(path.join(codexDir, 'session_index.jsonl'), '');
  await fs.writeFile(path.join(codexDir, '.codex-global-state.json'), '{}');
  const transcripts = Array.from({ length: claudeCount }, (_, index) => path.join(project, `${uuid(index)}.jsonl`));
  const metadataFiles = Array.from({ length: claudeCount }, (_, index) => path.join(metadata, `local_${uuid(index)}.json`));
  await Promise.all(rollouts.map((file) => fs.writeFile(file, jsonl(
    { type: 'event_msg', timestamp: new Date(clock).toISOString(), payload: { type: 'task_complete' } },
  ))));
  await Promise.all(transcripts.map(async (file, index) => {
    await fs.writeFile(file, jsonl({ type: 'user', timestamp: new Date(clock).toISOString(), sessionId: uuid(index),
      message: { role: 'user', content: 'Made-up task' } },
    { type: 'result', timestamp: new Date(clock).toISOString(), subtype: 'success' }));
    await fs.writeFile(metadataFiles[index], JSON.stringify({ sessionId: `local_${uuid(index)}`, cliSessionId: uuid(index),
      title: `Task ${index}`, cwd: '/made-up/project', createdAt: clock, lastActivityAt: clock }));
  }));
  await setup({ dir, project, projectsDir, transcripts, metadataFiles, clock });
  const sources = [
    { id: 'codex', provider: 'codex', label: 'Codex', enabled: true, builtin: true, dataDir: codexDir },
    { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude', enabled: true, builtin: true, dataDir: appDir, projectsDir },
  ];
  const watches = [];
  const timers = [];
  const scans = [];
  let failLoad = false;
  const snapshot = new DashboardSnapshot({
    serviceMode, now: () => clock, dashboardPlatform: 'linux',
    dashboardWatchPaths: covered ? switchboardWatchPaths({ codexDir, appDir, projectsDir, openCodeDir: path.join(dir, 'opencode') }) : [],
    dashboardSetTimeout(callback, milliseconds) { const timer = { callback, milliseconds, unref() {} }; timers.push(timer); return timer; },
    dashboardClearTimeout() {},
    watchDashboardPath(target, options, callback) {
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; };
      watches.push({ target, callback, watcher });
      return watcher;
    },
    dashboardSourceChanged(source, hint) {
      if (source === 'codex') invalidateCodexData(hint);
      else invalidateClaudeData(hint);
    },
    async loadDashboard({ sourceScans } = {}) {
      if (failLoad) { failLoad = false; throw new Error('Made-up scan failure'); }
      scans.push({ at: clock - start, sourceScans });
      const dashboard = await loadSwitchboardDashboard({ sources, nowMs: clock, sourceScans, loadClaude });
      return Number.isFinite(statusAfterMs) ? { ...dashboard, nextStatusCheckAtMs: clock < start + statusAfterMs ? start + statusAfterMs : Infinity } : dashboard;
    },
  });
  const server = new EventEmitter();
  server.close = () => {};
  snapshot.attach(server);
  t.after(async () => { server.close(); countedRoot = '\0'; await fs.rm(dir, { recursive: true, force: true }); });
  server.emit('listening');
  if (covered) await until(() => snapshot.performanceSnapshot().dashboard.watchCoverage);
  await snapshot.loadSharedDashboard({ force: true });
  countedRoot = dir;
  const reset = () => { stats.length = 0; reads.length = 0; };
  const emit = (file, event = 'change') => {
    const root = path.dirname(file);
    const watcher = watches.findLast((entry) => entry.target === root && !entry.watcher.closed);
    assert.ok(watcher, `No watcher for ${root}`);
    watcher.callback(event, path.basename(file));
  };
  return { dir, codexDir, appDir, projectsDir, project, metadata, sessions, rollouts, transcripts, metadataFiles, databasePath,
    snapshot, scans, watches, timers, reset, emit, failNextLoad() { failLoad = true; },
    advance(ms) { clock += ms; },
    async scan() { snapshot.invalidateDashboard('peer-sessions', { hard: false }); return snapshot.loadSharedDashboard(); },
    async codexEdit(index, kind = 'task_started') {
      await fs.appendFile(rollouts[index], jsonl({ type: 'event_msg', timestamp: new Date(clock).toISOString(), payload: { type: kind } }));
    },
    async claudeEdit(index) {
      await fs.appendFile(transcripts[index], jsonl({ type: 'user', timestamp: new Date(clock).toISOString(),
        message: { role: 'user', content: 'Made-up next task' } }));
    },
  };
}

const sessionStats = (f) => stats.filter((file) => file.startsWith(`${f.sessions}${path.sep}`)
  || file.startsWith(`${f.project}${path.sep}`) || file.startsWith(`${f.metadata}${path.sep}`));
const lastScan = (f) => f.scans.at(-1).sourceScans;

test('trusted scans stat only the hinted rollout in 700 Codex and 100 Claude sessions, with equal rows', async (t) => {
  const f = await fixture(t, { codexCount: 700, claudeCount: 100 });
  f.reset();
  const baseline = await f.snapshot.loadSharedDashboard({ force: true });
  const fullStats = stats.length;
  assert.equal(sessionStats(f).length, 900);
  f.advance(3_000);
  await f.codexEdit(0);
  f.emit(f.rollouts[0]);
  f.reset();
  const trusted = await f.snapshot.loadSharedDashboard();
  assert.deepEqual(sessionStats(f), [f.rollouts[0]], 'A trusted scan must stat only the hinted session file.');
  assert.equal(trusted.threads.find((row) => row.id === 'codex-0').state, 'working');
  assert.deepEqual(trusted.threads.filter((row) => row.id !== 'codex-0'), baseline.threads.filter((row) => row.id !== 'codex-0'));
  const trustedStats = stats.length;
  const trustedFiles = stats.filter((file) => path.extname(file));
  assert.deepEqual(trustedFiles.sort(), [f.rollouts[0], f.databasePath, f.databasePath, `${f.databasePath}-wal`,
    path.join(f.codexDir, 'session_index.jsonl'), path.join(f.codexDir, '.codex-global-state.json')].sort());
  assert.ok(reads.every((file) => !f.rollouts.slice(1).includes(file) && !f.transcripts.includes(file) && !f.metadataFiles.includes(file)));
  assert.deepEqual(trusted, await f.snapshot.loadSharedDashboard({ force: true }));
  t.diagnostic(`700 rollouts + 100 transcripts + 100 metadata files: full=${fullStats} stat calls, trusted=${trustedStats} stat calls; trusted session stats=1.`);

  for (let round = 0; round < 3; round += 1) {
    f.advance(3_000);
    await f.codexEdit(round, round % 2 ? 'task_started' : 'task_complete');
    await f.claudeEdit(round);
    f.emit(f.rollouts[round]);
    f.emit(f.transcripts[round]);
    const rows = await f.snapshot.loadSharedDashboard();
    assert.deepEqual(rows, await f.snapshot.loadSharedDashboard({ force: true }));
  }
});

test('trusted no-file scans miss an unreported edit only until the service full-scan deadline', async (t) => {
  const f = await fixture(t);
  f.advance(3_000);
  f.reset();
  await f.scan();
  assert.equal(sessionStats(f).length, 0, 'A peer-only scan must reuse cached session files.');
  await f.codexEdit(0);
  await f.claudeEdit(0);
  f.advance(3_000);
  const late = await f.scan();
  assert.notEqual(late.threads.find((row) => row.id === 'codex-0').state, 'working');
  assert.notEqual(late.threads.find((row) => row.externalId === `local_${uuid(0)}`).state, 'working');
  // At rest the deadline is 5 min.
  f.advance(294_000);
  f.reset();
  const recovered = await f.snapshot.loadSharedDashboard();
  assert.equal(recovered.threads.find((row) => row.id === 'codex-0').state, 'working');
  assert.equal(recovered.threads.find((row) => row.externalId === `local_${uuid(0)}`).state, 'working');
  assert.equal(sessionStats(f).length, 9);
  assert.equal(lastScan(f).codex, null);
  assert.equal(lastScan(f).claude, null);

  const expiring = await fixture(t, { statusAfterMs: 299_000 });
  expiring.advance(299_000);
  expiring.reset();
  await expiring.timers.find((timer) => timer.milliseconds === 299_000).callback();
  assert.equal(sessionStats(expiring).length, 0);
  assert.equal(expiring.timers.at(-1).milliseconds, 1_000, 'A status scan must not delay the safety scan.');
  expiring.advance(1_000);
  expiring.reset();
  await expiring.timers.at(-1).callback();
  assert.equal(sessionStats(expiring).length, 9);
});

test('a lost append of an active rollout is found by the 30 s source check without a full scan', async (t) => {
  const f = await fixture(t);
  f.advance(3_000);
  await f.codexEdit(0);
  f.emit(f.rollouts[0]);
  assert.equal((await f.snapshot.loadSharedDashboard()).threads.find((row) => row.id === 'codex-0').state, 'working');
  await f.codexEdit(0, 'task_complete');
  f.advance(30_000);
  f.reset();
  await f.timers.findLast((timer) => timer.milliseconds === 30_000).callback();
  assert.equal(f.snapshot.cachedDashboard().threads.find((row) => row.id === 'codex-0').state, 'idle');
  assert.ok(lastScan(f).codex);
  assert.deepEqual(stats.filter((file) => f.rollouts.includes(file)), [f.rollouts[0], f.rollouts[0]]);
});

test('a Waiting rollout with a lost append is checked without a Working row', async (t) => {
  const f = await fixture(t);
  f.advance(3_000);
  await f.codexEdit(0);
  await fs.appendFile(f.rollouts[0], jsonl({ type: 'response_item', timestamp: '2026-10-25T10:00:03Z', payload: {
    type: 'function_call', name: 'request_user_input', call_id: 'question', arguments: JSON.stringify({ questions: [{ id: 'one' }] }) } }));
  f.emit(f.rollouts[0]);
  assert.equal((await f.snapshot.loadSharedDashboard()).threads.find((row) => row.id === 'codex-0').state, 'waiting');
  f.advance(1_000);
  await f.codexEdit(0, 'task_complete');
  f.advance(29_000);
  await f.timers.findLast((timer) => timer.milliseconds === 30_000).callback();
  assert.equal(f.snapshot.cachedDashboard().threads.find((row) => row.id === 'codex-0').state, 'idle');
});

test('an ended registry process with no file event makes its CLI card leave Working within 30 s', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  const start = await processStart(child.pid);
  const f = await fixture(t, { codexCount: 0, claudeCount: 1, loadClaude: loadSwitchboardClaudeThreads,
    async setup({ projectsDir, transcripts, metadataFiles, clock }) {
      await fs.unlink(metadataFiles[0]);
      await fs.writeFile(transcripts[0], jsonl({ type: 'user', entrypoint: 'cli', timestamp: new Date(clock - 60_000).toISOString(),
        message: { role: 'user', content: 'Made-up open task' } }));
      const root = path.join(path.dirname(projectsDir), 'sessions');
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(path.join(root, `${child.pid}.json`), JSON.stringify({ pid: child.pid, procStart: start, name: 'Made-up CLI', sessionId: uuid(0), entrypoint: 'cli' }), { mode: 0o600 });
    } });
  assert.equal(f.snapshot.cachedDashboard().threads[0].state, 'working');
  const ended = once(child, 'exit');
  child.kill();
  await ended;
  f.advance(30_000);
  await f.timers.findLast((timer) => timer.milliseconds === 30_000).callback();
  assert.equal(f.snapshot.cachedDashboard().threads[0].state, 'unknown');
  assert.equal(f.snapshot.cachedDashboard().threads[0].reason, 'The CLI process ended during a task.');
});

test('unknown hints, coverage loss, hard invalidation, force, and desktop deadlines give full scans', async (t) => {
  const f = await fixture(t);
  f.advance(3_000);
  f.reset();
  await f.scan();
  assert.equal(sessionStats(f).length, 0, 'A covered scan must first use the trusted path.');
  f.watches.find((entry) => entry.target === f.sessions).callback('change', null);
  f.reset();
  await f.snapshot.loadSharedDashboard();
  assert.equal(lastScan(f).codex, null);
  assert.ok(lastScan(f).claude);
  assert.equal(stats.filter((file) => f.rollouts.includes(file)).length, 3);
  assert.equal(stats.filter((file) => f.transcripts.includes(file) || f.metadataFiles.includes(file)).length, 0);
  f.reset();
  f.snapshot.invalidateDashboard('sources-change');
  await f.snapshot.loadSharedDashboard();
  assert.equal(sessionStats(f).length, 9);
  f.reset();
  await f.snapshot.loadSharedDashboard({ force: true });
  assert.equal(sessionStats(f).length, 9);
  f.watches.find((entry) => entry.target === f.sessions).watcher.emit('error', new Error('Made-up watcher failure'));
  f.reset();
  await f.snapshot.loadSharedDashboard();
  assert.equal(sessionStats(f).length, 9);
  assert.equal(lastScan(f).claude, null);

  const uncovered = await fixture(t, { covered: false });
  uncovered.advance(3_000);
  uncovered.reset();
  await uncovered.scan();
  assert.equal(sessionStats(uncovered).length, 9);

  const desktop = await fixture(t, { serviceMode: false });
  desktop.advance(3_000);
  desktop.reset();
  await desktop.scan();
  assert.equal(sessionStats(desktop).length, 0);
  desktop.advance(2_000);
  desktop.reset();
  await desktop.snapshot.loadSharedDashboard();
  assert.equal(sessionStats(desktop).length, 9);
});

test('events each second cannot move the full-scan deadline, and rename hints read new rollouts', async (t) => {
  const f = await fixture(t);
  f.advance(1_000);
  await f.codexEdit(0);
  f.emit(f.rollouts[0]);
  f.reset();
  await f.snapshot.loadSharedDashboard();
  assert.deepEqual(sessionStats(f), [f.rollouts[0]], 'An exact event must first use the trusted path.');
  for (let second = 2; second <= 40; second += 1) {
    f.advance(1_000);
    await f.codexEdit(0);
    f.emit(f.rollouts[0]);
    await f.snapshot.loadSharedDashboard();
  }
  const full = f.scans.filter((scan) => scan.at > 0 && scan.sourceScans.codex === null);
  assert.equal(full.length, 0, 'Working rows keep the 5 minute full-scan deadline.');
  const file = path.join(f.sessions, 'rollout-new.jsonl');
  await fs.writeFile(file, jsonl({ type: 'event_msg', timestamp: '2026-10-25T10:00:40Z', payload: { type: 'task_started' } }));
  const db = new DatabaseSync(f.databasePath);
  db.prepare('insert into threads values (?, ?, ?, ?, ?, ?, 0)').run('new', file, 'New task', '/made-up/project', 1792922440, 1792922440);
  db.close();
  f.advance(3_000);
  f.emit(file, 'rename');
  f.reset();
  const rows = await f.snapshot.loadSharedDashboard();
  assert.ok(stats.includes(file));
  assert.ok(reads.includes(file));
  assert.equal(rows.threads.find((row) => row.id === 'new').state, 'working');
  const outside = path.join(f.dir, 'unwatched.jsonl');
  await fs.rename(file, outside);
  const moved = new DatabaseSync(f.databasePath);
  moved.prepare('update threads set rollout_path = ? where id = ?').run(outside, 'new');
  moved.close();
  f.advance(3_000);
  await f.scan();
  await fs.appendFile(outside, jsonl({ type: 'event_msg', timestamp: '2026-10-25T10:00:46Z', payload: { type: 'task_complete' } }));
  f.advance(3_000);
  f.reset();
  const outsideRows = await f.scan();
  assert.ok(stats.includes(outside));
  assert.equal(outsideRows.threads.find((row) => row.id === 'new').state, 'idle');

  const removed = new DatabaseSync(f.databasePath);
  removed.prepare('delete from threads where id = ?').run('codex-1');
  removed.close();
  await f.codexEdit(1);
  f.emit(f.rollouts[1]);
  f.advance(3_000);
  await f.snapshot.loadSharedDashboard();
  const restored = new DatabaseSync(f.databasePath);
  restored.prepare('insert into threads values (?, ?, ?, ?, ?, ?, 0)').run('codex-1', f.rollouts[1], 'Restored task', '/made-up/project', 1792922440, 1792922440);
  restored.close();
  f.emit(f.databasePath);
  f.advance(3_000);
  const restoredRows = await f.snapshot.loadSharedDashboard();
  assert.equal(restoredRows.threads.find((row) => row.id === 'codex-1').state, 'working', 'An unread hint must stay invalid until its rollout is checked.');
});

test('trusted Claude scans preserve copied-root, workflow, child-log, and metadata file-time decisions', async (t) => {
  let copiedRoot, workflow, endedChild;
  const f = await fixture(t, { codexCount: 1, claudeCount: 4,
    async setup({ project, projectsDir, transcripts, metadataFiles, clock }) {
      const event = (type, offset, fields) => ({ type, timestamp: new Date(clock + offset).toISOString(), ...fields });
      const prompt = (offset) => event('user', offset, { message: { content: 'Made-up task' } });
      const end = (offset) => event('assistant', offset, { message: { stop_reason: 'end_turn', content: 'Done.' } });
      copiedRoot = path.join(projectsDir, 'copy', `${uuid(0)}.jsonl`);
      await fs.mkdir(path.dirname(copiedRoot));
      await fs.writeFile(copiedRoot, jsonl(prompt(-40_000)));
      await fs.utimes(transcripts[0], new Date(clock - 60_000), new Date(clock - 60_000));
      await fs.utimes(copiedRoot, new Date(clock - 40_000), new Date(clock - 40_000));
      const launch = (name, result) => jsonl(prompt(-50_000), event('assistant', -49_000, {
        message: { content: [{ type: 'tool_use', id: 'launch', name, input: { run_in_background: true } }] },
      }), event('user', -48_900, { message: { content: [{ type: 'tool_result', tool_use_id: 'launch' }] }, toolUseResult: result }), end(-48_000));
      await fs.writeFile(transcripts[1], launch('Workflow', { status: 'async_launched', taskId: 'task1', runId: 'wf_run1' }));
      workflow = path.join(project, uuid(1), 'subagents', 'workflows', 'wf_run1', 'journal.jsonl');
      await fs.mkdir(path.dirname(workflow), { recursive: true });
      await fs.writeFile(workflow, '{}\n');
      await fs.utimes(workflow, new Date(clock - 20_000), new Date(clock - 20_000));
      await fs.writeFile(transcripts[2], '{}\n');
      await fs.writeFile(metadataFiles[2], JSON.stringify({ sessionId: `local_${uuid(2)}`, cliSessionId: uuid(2), title: 'No turn yet' }));
      await fs.utimes(metadataFiles[2], new Date(clock - 10_000), new Date(clock - 10_000));
      await fs.writeFile(transcripts[3], launch('Agent', { status: 'async_launched', isAsync: true, agentId: 'kid' }));
      for (const [folder, records, offset] of [['old-a', [prompt(-48_800), end(-45_000)], -30_000], ['old-b', [prompt(-48_800)], -20_000]]) {
        const child = path.join(project, folder, 'subagents', 'agent-kid.jsonl');
        await fs.mkdir(path.dirname(child), { recursive: true });
        await fs.writeFile(child, jsonl(...records));
        await fs.utimes(child, new Date(clock + offset), new Date(clock + offset));
        if (folder === 'old-a') endedChild = child;
      }
    },
  });
  const baseline = await f.snapshot.loadSharedDashboard({ force: true });
  const row = (dashboard, index) => dashboard.threads.find((item) => item.externalId === `local_${uuid(index)}`);
  assert.deepEqual([0, 1, 3].map((index) => row(baseline, index).state), ['working', 'working', 'working']);
  f.advance(3_000);
  f.reset();
  const cached = await f.scan();
  assert.equal(sessionStats(f).length, 0, 'File-time decisions must reuse unhinted cached stats.');
  assert.equal(stats.filter((file) => [copiedRoot, workflow, endedChild].includes(file)).length, 0);
  assert.deepEqual(cached, await f.snapshot.loadSharedDashboard({ force: true }));

  const at = new Date('2026-10-25T10:00:03Z');
  for (const file of [f.transcripts[0], endedChild, f.metadataFiles[2]]) {
    await fs.utimes(file, at, at);
    f.emit(file);
  }
  const old = new Date('2026-10-25T09:59:00Z');
  await fs.utimes(workflow, old, old);
  f.emit(workflow);
  f.advance(3_000);
  f.reset();
  const changed = await f.snapshot.loadSharedDashboard();
  assert.ok(lastScan(f).claude);
  assert.deepEqual([0, 1, 3].map((index) => row(changed, index).state), ['idle', 'unknown', 'idle']);
  assert.equal(row(changed, 2).updatedAtMs, at.getTime());
  assert.ok(stats.every((file) => !f.transcripts.slice(1).includes(file)));
  assert.deepEqual(changed, await f.snapshot.loadSharedDashboard({ force: true }));
});

test('a failed due full scan makes the service poll wait for the retry window, then scan in full', async (t) => {
  const f = await fixture(t);
  const pollTimer = () => f.timers.findLast((timer) => timer.callback.name === 'pollServiceDashboard');
  f.advance(300_000);
  f.failNextLoad();
  await assert.rejects(f.snapshot.loadSharedDashboard(), /Made-up scan failure/);
  const scans = f.scans.length;
  f.advance(1_000);
  await pollTimer().callback();
  assert.ok(pollTimer().milliseconds >= 4_000, `The poll must wait for the retry window, not ${pollTimer().milliseconds} ms.`);
  assert.equal(f.scans.length, scans);
  f.advance(4_000);
  f.reset();
  await pollTimer().callback();
  assert.equal(f.scans.length, scans + 1);
  assert.deepEqual(lastScan(f), { codex: null, claude: null });
  assert.equal(sessionStats(f).length, 9);
});

// The reuse check before its precomputed keys: each call resolved the path and made the hint and root prefixes again.
function resolvingReuseCheck({ platform, changed, directories, recursive }) {
  const watchKey = (filePath) => platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
  const directoryKeys = new Set(directories.map(watchKey));
  const recursiveKeys = recursive.map(watchKey);
  const changedKeys = changed.map(watchKey);
  return (filePath) => {
    const target = watchKey(filePath);
    return !changedKeys.some((hint) => target === hint || target.startsWith(`${hint}${path.sep}`))
      && (directoryKeys.has(target) || directoryKeys.has(path.dirname(target))
        || recursiveKeys.some((root) => target.startsWith(`${root}${path.sep}`)));
  };
}

test('the reuse check gives the answers of a check that resolves each path, and resolves no normal POSIX path', (t) => {
  const watch = {
    changed: ['/made-up/projects/p1/changed.jsonl', '/made-up/projects/p2/', '/made-up/Projects/p3'],
    directories: ['/made-up/projects', '/made-up/projects/p1', '/made-up/projects/p2', '/made-up/Projects/p3', '/made-up/app/sessions/'],
    recursive: ['/made-up/codex/sessions'],
  };
  const paths = ['/made-up/projects/p1/changed.jsonl', '/made-up/projects/p1/changed.jsonl/inner', '/made-up/projects/p1/changed.jsonlx',
    '/made-up/projects/p1/other.jsonl', '/made-up/projects/p1', '/made-up/projects/p2/a.jsonl', '/made-up/projects/p2',
    '/made-up/projects/p1/deep/file.jsonl', '/made-up/codex/sessions/2026/10/27/rollout.jsonl', '/made-up/codex/sessions',
    '/made-up/codex/sessionsx/a.jsonl', '/made-up/outside/a.jsonl', '/', '/made-up/projects/p1/../p1/other.jsonl',
    '/made-up/projects/p1/./other.jsonl', '/made-up/projects/p1/other.jsonl/', '/made-up//projects/p1/other.jsonl',
    '/made-up/projects/p1/../p2/a.jsonl', '/made-up/projects/p1/.hidden.jsonl', '/made-up/projects/p1/..b.jsonl',
    '/MADE-UP/PROJECTS/P1/OTHER.JSONL', '/made-up/projects/P3/a.jsonl', '/made-up/Projects/p3/a.jsonl', '/made-up/app/sessions/x.json',
    'relative/a.jsonl'];
  for (const platform of ['linux', 'win32']) {
    const expected = resolvingReuseCheck({ platform, ...watch });
    const actual = reuseCheck({ platform, ...watch });
    for (const target of [...paths, ...paths]) assert.equal(actual(target), expected(target), `${platform} ${target}`);
  }
  const check = reuseCheck({ platform: 'linux', ...watch });
  const resolve = t.mock.method(path, 'resolve');
  for (const target of ['/made-up/projects/p1/other.jsonl', '/made-up/projects/p1', '/made-up/codex/sessions/2026/10/27/rollout.jsonl']) check(target);
  assert.equal(resolve.mock.callCount(), 0);
  check('/made-up/projects/p1/../p1/other.jsonl');
  assert.equal(resolve.mock.callCount(), 1);
});
