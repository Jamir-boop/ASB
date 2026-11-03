import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSwitchboardDashboard, createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';
const now = Date.parse('2026-10-07T14:00:00Z');
const HOUR = 3_600_000;
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-tracker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const claude = (extra) => ({ id, externalId: `local_${id}`, provider: 'claude-desktop-code', nativeUnread: null, ...extra });
const plain = (state, extra = {}) => ({ providers: [], threads: [{ id, state, nativeUnread: null, completionAtMs: 0, ...extra }] });
const stateWarning = (dashboard) => dashboard.providers.find((provider) => provider.id === 'asb-state');

test('Persistent unread defaults to on without a state file', async (t) => {
  const transient = new PendingTracker(false);
  assert.equal(transient.persistentUnread, true);
  assert.equal((await transient.observe(plain('idle'))).persistentUnread, true);

  const statePath = path.join(await temp(t), 'pending.json');
  const fresh = new PendingTracker(statePath);
  await fresh.load();
  assert.equal(fresh.persistentUnread, true);
  assert.equal(fresh.warning, '');
  await assert.rejects(stat(statePath), { code: 'ENOENT' });
  assert.equal((await fresh.observe(plain('idle'))).persistentUnread, true);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).persistentUnread, true);
});

test('legacy and invalid unread settings use the default and saved booleans keep their choice', async (t) => {
  const dir = await temp(t);
  for (const [setting, expected] of [[undefined, true], [null, true], ['false', true], [0, true], [1, true],
    [{}, true], [[], true], [false, false], [true, true]]) {
    const statePath = path.join(dir, `${JSON.stringify(setting)}.json`);
    const content = JSON.stringify({ version: 1, persistentUnread: setting, pinnedOrder: [id],
      records: { [id]: { seen: 10, working: 0, pending: 10, ack: 0 } } });
    await writeFile(statePath, content);
    const tracker = new PendingTracker(statePath);
    const loaded = await tracker.observe(plain('idle', { completionAtMs: 10 }));
    assert.equal(loaded.persistentUnread, expected, String(setting));
    assert.equal(stateWarning(loaded), undefined, String(setting));
    assert.deepEqual(loaded.pinnedOrder, [id]);
    assert.deepEqual([loaded.threads[0].completionAttention, loaded.threads[0].unread], [true, true]);
    await tracker.markUnread(id);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).persistentUnread, expected);
    assert.equal((await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 10 }))).persistentUnread, expected);
  }
});

test('the default preserves attention on open, Read clears it, and settings persist both choices', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  await tracker.observe(plain('working'));
  const server = createSwitchboardServer({ pendingTracker: tracker, openThread: async () => ({ opened: true }),
    loadDashboard: async () => plain('idle', { completionAtMs: 10, canOpen: true, provider: 'codex', appDeepLink: `codex://threads/${id}` }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(body) });
  const dashboard = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  const first = await dashboard();
  assert.equal(first.persistentUnread, true);
  assert.deepEqual([first.threads[0].unread, first.threads[0].retainedUnread], [true, true]);
  assert.equal((await post(`/api/threads/${id}/open`)).status, 200);
  assert.equal((await dashboard()).threads[0].unread, true);
  const read = await post(`/api/threads/${id}/mark-read`);
  assert.equal(read.status, 200);
  assert.deepEqual([(await read.json()).thread.unread, (await dashboard()).threads[0].pending], [false, false]);
  for (const enabled of [false, true]) {
    const settings = await post('/api/settings/unread', { persistentUnread: enabled });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).persistentUnread, enabled);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).persistentUnread, enabled);
    assert.equal((await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 10 }))).persistentUnread, enabled);
    assert.equal((await post(`/api/threads/${id}/mark-unread`)).status, 200);
    assert.equal((await post(`/api/threads/${id}/open`)).status, 200);
    assert.equal((await dashboard()).threads[0].unread, enabled);
  }
});

test('a follow-up message in the armed Claude task keeps Discard, and a new task after an end clears it', async (t) => {
  const tracker = new PendingTracker(path.join(await temp(t), 'pending.json'));
  const running = (start, end) => buildSwitchboardDashboard([claude({ lifecycleRunning: true, agentActivityAtMs: now + start,
    agentStartedAtMs: now + start, latestTaskStartedAtMs: now + start, latestTaskEndedAtMs: now + end,
    latestTaskEndKind: 'task_complete' })], [], now + 1000);
  const first = await tracker.observe(running(0, -900));
  assert.equal(first.threads[0].state, 'working');
  await tracker.setDiscard(first.threads[0], true);
  const followUp = (await tracker.observe(running(50, -900))).threads[0];
  assert.deepEqual([followUp.state, followUp.discardResult], ['working', true]);
  const ended = (await tracker.observe(buildSwitchboardDashboard([claude({ lifecycleRunning: false,
    latestLifecycleKind: 'task_complete', latestLifecycleAtMs: now + 100, latestTaskStartedAtMs: now + 50,
    latestTaskEndedAtMs: now + 100, latestTaskEndKind: 'task_complete' })], [], now + 1000))).threads[0];
  assert.deepEqual([ended.state, ended.discardResult, ended.unread, ended.pending], ['idle', false, false, false]);

  const again = await tracker.observe(running(200, 100));
  await tracker.setDiscard(again.threads[0], true);
  assert.equal((await tracker.observe(running(400, 300))).threads[0].discardResult, false);
});

test('a next-task arm on an idle Claude chat keeps a follow-up message in its task, and a new task after an end clears it', async (t) => {
  const tracker = new PendingTracker(path.join(await temp(t), 'pending.json'));
  const running = (start, end) => buildSwitchboardDashboard([claude({ lifecycleRunning: true, agentActivityAtMs: now + start,
    agentStartedAtMs: now + start, latestTaskStartedAtMs: now + start, latestTaskEndedAtMs: now + end,
    latestTaskEndKind: 'task_complete' })], [], now + 1000);
  const idle = await tracker.observe(buildSwitchboardDashboard([claude({ lifecycleRunning: false, latestLifecycleKind: 'task_complete',
    latestLifecycleAtMs: now - 900, latestTaskStartedAtMs: now - 1000, latestTaskEndedAtMs: now - 900, latestTaskEndKind: 'task_complete' })],
  [], now + 1000));
  assert.equal(idle.threads[0].state, 'idle');
  await tracker.setDiscard(idle.threads[0], true, true);
  assert.equal(idle.threads[0].discardResult, true);
  const started = (await tracker.observe(running(0, -900))).threads[0];
  assert.deepEqual([started.state, started.discardResult], ['working', true]);
  const followUp = (await tracker.observe(running(50, -900))).threads[0];
  assert.deepEqual([followUp.state, followUp.discardResult], ['working', true]);
  const next = (await tracker.observe(running(400, 300))).threads[0];
  assert.deepEqual([next.state, next.discardResult, next.pending], ['working', false, false]);
});

test('a Claude permission or question wait expires after six hours', async () => {
  const wait = (age, tool) => claude({ lifecycleRunning: true, agentActivityAtMs: now - age, awaitingPermission: true,
    pendingToolCount: 1, pendingTools: [{ tool }], pendingToolAtMs: now - age, awaitingUserInput: tool === 'AskUserQuestion',
    latestUserQuestionAtMs: tool === 'AskUserQuestion' ? now - age : 0 });
  for (const tool of ['ExitPlanMode', 'AskUserQuestion']) {
    const stale = (await new PendingTracker(false).observe(buildSwitchboardDashboard([wait(72 * HOUR, tool)], [], now))).threads[0];
    assert.deepEqual([stale.state, stale.actionRequired, stale.questionPending, stale.pending], ['unknown', false, false, false], tool);
    const board = buildSwitchboardDashboard([wait(HOUR, tool)], [], now);
    const recent = (await new PendingTracker(false).observe(board)).threads[0];
    assert.deepEqual([recent.state, recent.pending], ['waiting', true], tool);
    assert.equal(board.nextStatusCheckAtMs, now + 5 * HOUR + 1);
  }
  const untimed = buildSwitchboardDashboard([claude({ awaitingPermission: true, pendingToolCount: 1 })], [], now).threads[0];
  assert.deepEqual([untimed.state, untimed.actionRequired], ['waiting', true]);
});

test('a state file that ASB cannot use in full is kept as .bad before the first save', async (t) => {
  const dir = await temp(t);
  const record = { seen: 0, working: 0, pending: 0, ack: 0 };
  const cases = {
    cut: '{"version":1,"records":{"one":{"seen":0,"wor',
    version: JSON.stringify({ version: 2, records: { one: record }, pinnedOrder: ['one'] }),
    record: JSON.stringify({ version: 1, records: { one: record, two: { ...record, ack: null } }, pinnedOrder: ['one', 'two'] }),
  };
  for (const [name, content] of Object.entries(cases)) {
    const statePath = path.join(dir, name, 'pending.json');
    await mkdir(path.dirname(statePath));
    await writeFile(statePath, content);
    await writeFile(`${statePath}.bad`, 'older copy');
    const tracker = new PendingTracker(statePath);
    const dashboard = await tracker.observe(plain('idle', { completionAtMs: 5 }));
    assert.match(stateWarning(dashboard)?.message || '', /could not read its Pending state/, name);
    assert.equal(await readFile(`${statePath}.bad`, 'utf8'), content, name);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 1, name);
    if (name === 'record') assert.deepEqual(dashboard.pinnedOrder, ['one']);
    assert.ok(stateWarning(await tracker.observe(plain('idle', { completionAtMs: 6 }))), name);
  }
  const statePath = path.join(dir, 'valid.json');
  await writeFile(statePath, cases.record.replace('null', '0'));
  const dashboard = await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 5 }));
  assert.equal(stateWarning(dashboard), undefined);
  assert.deepEqual(dashboard.pinnedOrder, ['one', 'two']);
  await assert.rejects(stat(`${statePath}.bad`), { code: 'ENOENT' });
  const absent = path.join(dir, 'absent.json');
  assert.equal(stateWarning(await new PendingTracker(absent).observe(plain('idle', { completionAtMs: 5 }))), undefined);
  await assert.rejects(stat(`${absent}.bad`), { code: 'ENOENT' });
});

test('a task that ends after a Waiting scan gets its completion or failure dot', async () => {
  for (const [end, attention] of [[{ completionAtMs: 10 }, 'completionAttention'], [{ failedAtMs: 10 }, 'failedAttention']]) {
    const tracker = new PendingTracker(false);
    await tracker.observe(plain('idle'));
    await tracker.observe(plain('working'));
    await tracker.observe(plain('waiting'));
    const ended = (await tracker.observe(plain('idle', end))).threads[0];
    assert.deepEqual([ended[attention], ended.unread, ended.pending], [true, true, true], attention);
  }
});

test('an injected dashboard load gets no default watchers on the home session stores', async (t) => {
  const home = await temp(t);
  await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = oldHome; });
  assert.equal(os.homedir(), home);
  const watched = [];
  const server = createSwitchboardServer({ pendingStatePath: false, loadDashboard: async () => plain('idle'),
    watchDashboardPath: (target) => { watched.push(target); return { close() {} }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  await delay(100);
  assert.deepEqual(watched, []);
});

test('the save warning clears after a later successful save', async (t) => {
  const dir = await temp(t);
  const tracker = new PendingTracker(path.join(dir, 'pending.json'));
  const blocker = `${tracker.statePath}.${process.pid}.tmp`;
  await mkdir(blocker);
  assert.match(stateWarning(await tracker.observe(plain('idle', { completionAtMs: 5 })))?.message || '', /cannot save Pending state/);
  await rm(blocker, { recursive: true });
  assert.equal(stateWarning(await tracker.observe(plain('idle', { completionAtMs: 5 }))), undefined);
  assert.equal(JSON.parse(await readFile(tracker.statePath, 'utf8')).version, 1);
});

// Mute: a muted session takes the discarded-success path for each task that ends with success after Mute is on.
const scanRow = async (tracker, state, extra) => (await tracker.observe(plain(state, extra))).threads[0];
async function mutedTracker(statePath = false, before = {}) {
  const tracker = new PendingTracker(statePath);
  const row = await scanRow(tracker, 'idle', before);
  await tracker.setMuted(row, true);
  assert.equal(row.muted, true);
  return tracker;
}
const attention = (row) => [row.unread, row.pending, row.completionAttention, row.nativeAttention, row.failedAttention,
  row.questionAttention, row.pendingSource];

test('a muted session stays read when a task ends with success, also with a late native unread', async () => {
  for (const persistent of [true, false]) {
    const tracker = await mutedTracker();
    await tracker.setPersistentUnread(persistent, { threads: [] });
    await scanRow(tracker, 'working');
    const ended = await scanRow(tracker, 'idle', { completionAtMs: 10 });
    assert.deepEqual(attention(ended), [false, false, false, false, false, false, ''], `persistent ${persistent}`);
    assert.deepEqual([ended.muted, ended.retainedUnread], [true, false]);
    assert.deepEqual(attention(await scanRow(tracker, 'idle', { completionAtMs: 10 })), attention(ended));
    // The app sets its own unread for the same task in a later scan.
    const late = await scanRow(tracker, 'idle', { completionAtMs: 10, nativeUnread: true });
    assert.deepEqual(attention(late), attention(ended), `late native, persistent ${persistent}`);
  }
  const tracker = await mutedTracker(false, { nativeUnread: false });
  await scanRow(tracker, 'working', { nativeUnread: false });
  for (let scan = 0; scan < 2; scan += 1) {
    const row = await scanRow(tracker, 'idle', { completionAtMs: 10, nativeUnread: true });
    assert.deepEqual([row.nativeAttention, row.unread, row.pending], [false, false, false], `native in scan ${scan}`);
  }
});

test('a muted failure, question with no time, and manual Unread stay hidden until Unmute and then show', async () => {
  for (const end of [{ failedAtMs: 10 }, { completionAtMs: 5, failedAtMs: 10 }]) {
    const tracker = await mutedTracker();
    await scanRow(tracker, 'working');
    const failed = await scanRow(tracker, 'idle', end);
    assert.deepEqual([failed.failedAttention, failed.unread, failed.pendingSource], [false, false, ''], JSON.stringify(end));
    await tracker.setMuted(failed, false);
    assert.deepEqual([failed.failedAttention, failed.unread, failed.pendingSource], [true, true, 'observed-failure'], JSON.stringify(end));
  }
  const asked = await mutedTracker();
  const question = await scanRow(asked, 'waiting', { questionPending: true });
  assert.deepEqual([question.questionAttention, question.pending, question.questionPending, question.state], [false, false, true, 'waiting']);
  await asked.setMuted(question, false);
  assert.deepEqual([question.questionAttention, question.pending], [true, true]);
  const marked = await mutedTracker();
  await marked.markUnread(id);
  const manual = await scanRow(marked, 'idle');
  assert.deepEqual([manual.manualUnread, manual.unread, manual.pendingSource], [false, false, '']);
  await marked.setMuted(manual, false);
  assert.deepEqual([manual.manualUnread, manual.unread, manual.pendingSource], [true, true, 'manual-unread']);
});

test('Mute hides an older dot, and a later muted success clears only an older success dot', async () => {
  const marks = {
    success: async (tracker) => { await scanRow(tracker, 'working'); return scanRow(tracker, 'idle', { completionAtMs: 10 }); },
    failure: async (tracker) => { await scanRow(tracker, 'working'); return scanRow(tracker, 'idle', { failedAtMs: 10 }); },
    manual: async (tracker) => { await tracker.markUnread(id); return scanRow(tracker, 'idle'); },
  };
  for (const [name, mark] of Object.entries(marks)) {
    const tracker = new PendingTracker(false);
    await scanRow(tracker, 'idle');
    const dot = await mark(tracker);
    assert.equal(dot.unread, true, name);
    await tracker.setMuted(dot, true);
    assert.deepEqual([dot.muted, dot.unread], [true, false], `${name} right after Mute`);
    const same = name === 'manual' ? {} : name === 'success' ? { completionAtMs: 10 } : { failedAtMs: 10 };
    for (let scan = 0; scan < 2; scan += 1) assert.equal((await scanRow(tracker, 'idle', same)).unread, false, `${name} scan ${scan}`);
    await scanRow(tracker, 'working', same);
    const later = await scanRow(tracker, 'idle', { ...same, completionAtMs: 20 });
    assert.deepEqual([later.completionAttention, later.unread], [false, false], name);
    await tracker.setMuted(later, false);
    assert.equal(later.unread, name !== 'success', `${name} after a later muted success`);
    assert.equal((await scanRow(tracker, 'idle', { ...same, completionAtMs: 20 })).unread, name !== 'success', `${name} next scan`);
  }
});

test('Unmute gives the next completion its dot', async () => {
  const tracker = await mutedTracker();
  await scanRow(tracker, 'working');
  const muted = await scanRow(tracker, 'idle', { completionAtMs: 10 });
  await tracker.setMuted(muted, false);
  assert.deepEqual([muted.muted, muted.unread], [false, false]);
  await scanRow(tracker, 'working', { completionAtMs: 10 });
  const ended = await scanRow(tracker, 'idle', { completionAtMs: 20 });
  assert.deepEqual([ended.muted, ended.unread, ended.completionAttention], [false, true, true]);
  await assert.rejects(new PendingTracker(false).setMuted({ id }, true), { statusCode: 400, message: 'This session is not known to ASB.' });
});

test('pending.json keeps Mute across save and load, and a bad value loads as 0', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  await mutedTracker(statePath);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.records[id].muted, 1);
  const restarted = await scanRow(new PendingTracker(statePath), 'idle');
  assert.equal(restarted.muted, true);
  for (const muted of ['1', 7, -1, true, null, 0]) {
    await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], muted } } }));
    const invalid = new PendingTracker(statePath);
    const loaded = await invalid.observe(plain('idle'));
    assert.deepEqual([invalid.records[id].muted, loaded.threads[0].muted, stateWarning(loaded)], [0, false, undefined], JSON.stringify(muted));
  }
  const fresh = new PendingTracker(false);
  assert.equal((await scanRow(fresh, 'idle')).muted, false);
  assert.equal(fresh.records[id].muted, 0);
});

const timedScan = async (tracker, atMs, state = 'idle', extra = {}) =>
  (await tracker.observe({ ...plain(state, extra), generatedAtMs: atMs })).threads[0];
const timedTracker = async (untilMs = now + HOUR) => {
  const tracker = new PendingTracker(false);
  const row = await timedScan(tracker, now);
  await tracker.setMuted(row, true, untilMs);
  return tracker;
};

test('a question that the session asks after the start of a mute gets through, and the rest stays hidden', async () => {
  for (const until of [now + HOUR, 0]) {
    for (const manual of [false, true]) {
      for (const end of ['read', 'mute-again']) {
        const tracker = new PendingTracker(false);
        const row = await timedScan(tracker, now);
        if (manual) await tracker.markUnread(id);
        await tracker.setMuted(row, true, until, now);
        const scan = async (askedAt, scanAt) => (await tracker.observe(buildSwitchboardDashboard([
          claude({ lifecycleRunning: true, agentActivityAtMs: askedAt, awaitingPermission: true,
            pendingToolCount: 1, pendingTools: [{ tool: 'AskUserQuestion' }], pendingToolAtMs: askedAt,
            awaitingUserInput: true, latestUserQuestionAtMs: askedAt }),
        ], [], scanAt))).threads[0];
        for (const askedAt of [now - 5, now]) {
          const hidden = await scan(askedAt, now + 10);
          assert.deepEqual([hidden.questionAttention, hidden.pending, hidden.pendingSource, hidden.questionPending, hidden.state],
            [false, false, '', true, 'waiting']);
        }
        const asked = await scan(now + 1, now + 10);
        assert.deepEqual([asked.questionAttention, asked.pending, asked.pendingSource, asked.unread, asked.alert,
          asked.actionAttention, asked.manualUnread, asked.muted, asked.mutedAtMs, asked.mutedUntilMs],
        [true, true, 'user-question', false, false, false, false, true, now, until]);
        if (end === 'read') {
          await tracker.acknowledge(id);
          const read = await scan(now + 1, now + 20);
          assert.deepEqual([read.questionAttention, read.pending, read.muted], [false, false, true]);
        } else {
          await tracker.setMuted(asked, false);
          await tracker.setMuted(asked, true, until, now + 50);
          const muted = await scan(now + 1, now + 60);
          assert.deepEqual([muted.questionAttention, muted.pending, muted.muted], [false, false, true]);
        }
      }
    }
  }
});

test('a permission request that the session makes after the start of a mute gets through, and the rest stays hidden', async () => {
  for (const until of [now + HOUR, 0]) {
    const tracker = new PendingTracker(false);
    const row = await timedScan(tracker, now);
    await tracker.setMuted(row, true, until, now);
    const scan = async (t, scanAt) => (await tracker.observe(buildSwitchboardDashboard([
      claude({ lifecycleRunning: true, agentActivityAtMs: t, awaitingPermission: true,
        pendingToolCount: 1, pendingTools: [{ tool: 'Bash' }], pendingToolAtMs: t }),
    ], [], scanAt))).threads[0];
    for (const t of [now - 5, now]) {
      const hidden = await scan(t, now + 10);
      assert.deepEqual([hidden.actionAttention, hidden.pending, hidden.pendingSource, hidden.actionRequired, hidden.state],
        [false, false, '', true, 'waiting']);
    }
    const requested = await scan(now + 1, now + 10);
    assert.deepEqual([requested.actionAttention, requested.pending, requested.pendingSource, requested.unread, requested.alert,
      requested.questionAttention, requested.questionPending, requested.muted, requested.mutedAtMs, requested.mutedUntilMs],
    [true, true, 'user-action', false, false, false, false, true, now, until]);
    await tracker.acknowledge(id);
    const read = await scan(now + 1, now + 20);
    assert.deepEqual([read.actionAttention, read.pending, read.muted], [false, false, true]);
    await timedScan(tracker, now + 30);
    const next = await scan(now + 40, now + 50);
    assert.deepEqual([next.actionAttention, next.pendingSource], [true, 'user-action']);
    await tracker.setMuted(next, false);
    await tracker.setMuted(next, true, until, now + 60);
    const muted = await scan(now + 40, now + 70);
    assert.deepEqual([muted.actionAttention, muted.pending], [false, false]);
  }
});

test('a mute without mutedAt from an older pending.json lets each permission request through', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  await mutedTracker(statePath);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  delete saved.records[id].mutedAt;
  await writeFile(statePath, JSON.stringify(saved));
  const tracker = new PendingTracker(statePath);
  const row = await scanRow(tracker, 'waiting', {});
  assert.deepEqual([row.muted, row.mutedAtMs, row.actionAttention, row.pending, row.pendingSource],
    [true, 0, true, true, 'user-action']);
});

test('a mute without mutedAt from an older pending.json lets each question through', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  await mutedTracker(statePath);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  delete saved.records[id].mutedAt;
  await writeFile(statePath, JSON.stringify(saved));
  const tracker = new PendingTracker(statePath);
  const row = await scanRow(tracker, 'waiting', { questionPending: true });
  assert.deepEqual([row.muted, row.mutedAtMs, row.questionAttention, row.pending, row.pendingSource],
    [true, 0, true, true, 'user-question']);
});

test('a timed mute silences success before its end but not at or after it', async () => {
  const until = now + HOUR;
  for (const end of [until - 1, until, until + 1]) {
    const tracker = await timedTracker(until);
    await timedScan(tracker, now, 'working');
    const row = await timedScan(tracker, end, 'idle', { completionAtMs: end });
    assert.deepEqual([row.unread, row.completionAttention], [end >= until, end >= until], String(end));
    assert.equal(tracker.records[id].mutedUntil, until);
  }
});

test('a success first seen after a timed mute ends is still read when it ended before the end', async () => {
  const until = now + HOUR;
  for (const nativeUnread of [null, true]) {
    const tracker = await timedTracker(until);
    await timedScan(tracker, now, 'working');
    // A scan after expiry with no result must not clear the end time.
    await timedScan(tracker, until, 'working');
    const row = await timedScan(tracker, until + HOUR, 'idle', { completionAtMs: until - 1, nativeUnread });
    assert.deepEqual([row.muted, row.mutedUntilMs, row.unread, row.pending], [false, 0, false, false]);
    assert.equal(tracker.records[id].discardedAt, until - 1);
    const late = await timedScan(tracker, until + 2 * HOUR, 'idle', { completionAtMs: until - 1, nativeUnread: true });
    assert.equal(late.unread, false);
  }
});

test('timed mute row fields expire by the clock even without a scan', async () => {
  const until = now + HOUR;
  const tracker = await timedTracker(until);
  const row = await timedScan(tracker, until - 1);
  assert.deepEqual([row.muted, row.mutedUntilMs], [true, until]);
  for (const atMs of [until, until + 1]) {
    tracker.apply(row, atMs);
    assert.deepEqual([row.muted, row.mutedUntilMs], [false, 0]);
    const scanned = await timedScan(tracker, atMs);
    assert.deepEqual([scanned.muted, scanned.mutedUntilMs], [false, 0]);
    assert.deepEqual([tracker.records[id].muted, tracker.records[id].mutedUntil], [1, until]);
  }
  await tracker.setMuted(row, true);
  tracker.apply(row, until + HOUR);
  assert.deepEqual([row.muted, row.mutedUntilMs], [true, 0]);
  const unknown = { id: 'unknown' };
  tracker.apply(unknown, now);
  assert.deepEqual([unknown.muted, unknown.mutedUntilMs], [false, 0]);
});

test('a timed-muted failure, question with no time, and manual Unread stay hidden until the mute ends', async () => {
  const tracker = await timedTracker();
  await timedScan(tracker, now, 'working');
  const failed = await timedScan(tracker, now + 10, 'idle', { failedAtMs: now + 10 });
  assert.deepEqual([failed.muted, failed.failedAttention, failed.unread], [true, false, false]);
  const failedEnd = await timedScan(tracker, now + HOUR, 'idle', { failedAtMs: now + 10 });
  assert.deepEqual([failedEnd.muted, failedEnd.failedAttention, failedEnd.unread], [false, true, true]);
  // A question that starts while the mute is on.
  const asked = await timedTracker();
  const question = await timedScan(asked, now + 10, 'waiting', { questionPending: true });
  assert.deepEqual([question.muted, question.questionAttention, question.pending, question.questionPending], [true, false, false, true]);
  const questionEnd = await timedScan(asked, now + HOUR, 'waiting', { questionPending: true });
  assert.deepEqual([questionEnd.muted, questionEnd.questionAttention, questionEnd.pending, questionEnd.pendingSource], [false, true, true, 'user-question']);
  const marked = await timedTracker();
  await marked.markUnread(id);
  const manual = await timedScan(marked, now + 10);
  assert.deepEqual([manual.muted, manual.manualUnread, manual.unread], [true, false, false]);
  const manualEnd = await timedScan(marked, now + HOUR);
  assert.deepEqual([manualEnd.muted, manualEnd.manualUnread, manualEnd.unread], [false, true, true]);
});

const ATTENTION_FLAGS = ['manualUnread', 'questionAttention', 'actionAttention', 'nativeAttention', 'failedAttention', 'completionAttention', 'retainedUnread'];
const shown = (row) => Object.fromEntries([...ATTENTION_FLAGS, 'unread', 'pending', 'alert', 'pendingSource', 'retainedUnreadSource',
  'state', 'questionPending', 'actionRequired'].map((key) => [key, row[key]]));
const withoutMute = ({ muted, mutedUntil, mutedAt, ...rest }) => rest;
// Each source of attention: the scans that make it, and whether Persistent unread is on.
const ATTENTION_CASES = {
  question: { flag: 'questionAttention', persistent: false, scan: ['waiting', { questionPending: true }] },
  permission: { flag: 'actionAttention', persistent: false, scan: ['waiting', {}] },
  completion: { flag: 'completionAttention', persistent: false, before: ['working', {}], scan: ['idle', { completionAtMs: now - 5 }] },
  failure: { flag: 'failedAttention', persistent: false, before: ['working', {}], scan: ['idle', { failedAtMs: now - 5 }] },
  native: { flag: 'nativeAttention', persistent: false, scan: ['idle', { nativeUnread: true }] },
  manual: { flag: 'manualUnread', persistent: false, manual: true, scan: ['idle', {}] },
  retained: { flag: 'retainedUnread', persistent: true, before: ['working', {}], scan: ['idle', { completionAtMs: now - 5 }] },
};
const attentionTracker = async ({ persistent, before, manual, scan }) => {
  const tracker = new PendingTracker(false);
  await tracker.setPersistentUnread(persistent, { threads: [] });
  await timedScan(tracker, now - 20, 'idle');
  if (before) await timedScan(tracker, now - 10, ...before);
  if (manual) await tracker.markUnread(id);
  await timedScan(tracker, now - 5, ...scan);
  return { tracker, plainRow: await timedScan(tracker, now - 5, ...scan) };
};

test('a muted row asks for nothing for each source of attention, its records do not change, and the end gives it back', async () => {
  for (const [name, attentionCase] of Object.entries(ATTENTION_CASES)) {
    for (const until of [now + HOUR, 0]) {
      const label = `${name} until ${until}`;
      const { scan } = attentionCase;
      const { tracker, plainRow } = await attentionTracker(attentionCase);
      assert.deepEqual([plainRow[attentionCase.flag], plainRow.pending], [true, true], label);
      const unmuted = shown(plainRow);
      const record = structuredClone(tracker.records[id]);
      await tracker.setMuted(plainRow, true, until, now);
      const muted = await timedScan(tracker, now + 10, ...scan);
      assert.deepEqual([muted.muted, muted.mutedUntilMs, muted.mutedAtMs], [true, until, now], label);
      assert.deepEqual(shown(muted), { ...unmuted, ...Object.fromEntries(ATTENTION_FLAGS.map((key) => [key, false])),
        unread: false, pending: false, alert: false, pendingSource: '', retainedUnreadSource: '' }, label);
      assert.deepEqual(withoutMute(tracker.records[id]), withoutMute(record), label);
      assert.deepEqual([tracker.records[id].muted, tracker.records[id].mutedUntil, tracker.records[id].mutedAt], [1, until, now], label);
      // The end, by time or with Unmute, gives back what the row shows without a mute.
      if (until) {
        for (const atMs of [until, until + 1]) {
          const ended = await timedScan(tracker, atMs, ...scan);
          assert.deepEqual(shown(ended), unmuted, `${label} at ${atMs}`);
          assert.deepEqual([ended.muted, ended.mutedUntilMs, ended.mutedAtMs], [false, 0, 0], `${label} at ${atMs}`);
        }
      } else {
        await tracker.setMuted(muted, false);
        const ended = await timedScan(tracker, now + 20, ...scan);
        assert.deepEqual(shown(ended), unmuted, label);
        assert.deepEqual([ended.muted, ended.mutedUntilMs, ended.mutedAtMs], [false, 0, 0], label);
      }
    }
  }
});

test('Mute saves its start time in mutedAt, Unmute clears it, and pending.json keeps only a valid value', async (t) => {
  const before = Date.now();
  const tracker = new PendingTracker(false);
  const row = await timedScan(tracker, now);
  assert.equal(tracker.records[id].mutedAt, 0);
  await tracker.setMuted(row, true);
  assert.equal(tracker.records[id].mutedAt >= before && tracker.records[id].mutedAt <= Date.now(), true);
  await tracker.setMuted(row, true, now + HOUR, now - 7);
  assert.equal(tracker.records[id].mutedAt, now - 7);
  tracker.apply(row, now);
  assert.deepEqual([row.muted, row.mutedAtMs, row.mutedUntilMs], [true, now - 7, now + HOUR]);
  tracker.apply(row, now + HOUR);
  assert.deepEqual([row.muted, row.mutedAtMs], [false, 0]);
  await tracker.setMuted(row, false);
  assert.equal(tracker.records[id].mutedAt, 0);

  const statePath = path.join(await temp(t), 'pending.json');
  const saving = new PendingTracker(statePath);
  const savingRow = await timedScan(saving, now);
  await saving.setMuted(savingRow, true, now + HOUR, now - 7);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.records[id].mutedAt, now - 7);
  const loaded = new PendingTracker(statePath);
  assert.equal((await timedScan(loaded, now)).mutedAtMs, now - 7);
  assert.equal(loaded.records[id].mutedAt, now - 7);
  for (const [muted, mutedAt] of [[1, -1], [1, 3.5], [1, '5'], [1, null], [1, undefined], [0, now - 7]]) {
    await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], muted, mutedAt } } }));
    const invalid = new PendingTracker(statePath);
    const result = await timedScan(invalid, now);
    assert.deepEqual([invalid.records[id].mutedAt, result.mutedAtMs, invalid.warning], [0, 0, ''], JSON.stringify([muted, mutedAt]));
  }
  await saving.setMuted(savingRow, false);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, 'utf8')).records[id], 'mutedAt'), false);
});

test('observe makes the end of the earliest active timed mute the next status check when it is earlier', async () => {
  const rows = (atMs) => ({ generatedAtMs: atMs, providers: [],
    threads: ['a', 'b', 'c'].map((rowId) => ({ id: rowId, state: 'idle', nativeUnread: null, completionAtMs: 0 })) });
  const tracker = new PendingTracker(false);
  const first = await tracker.observe(rows(now));
  assert.equal(first.nextStatusCheckAtMs, undefined);
  await tracker.setMuted(first.threads[0], true, now + 2 * HOUR, now);
  await tracker.setMuted(first.threads[1], true, now + HOUR, now);
  await tracker.setMuted(first.threads[2], true, 0, now);
  assert.equal((await tracker.observe(rows(now))).nextStatusCheckAtMs, now + HOUR);
  const built = rows(now);
  Object.defineProperty(built, 'nextStatusCheckAtMs', { value: now + 3 * HOUR, configurable: true });
  assert.equal((await tracker.observe(built)).nextStatusCheckAtMs, now + HOUR);
  const earlier = rows(now);
  Object.defineProperty(earlier, 'nextStatusCheckAtMs', { value: now + 60_000, configurable: true });
  assert.equal((await tracker.observe(earlier)).nextStatusCheckAtMs, now + 60_000);
  // An expired end and an Always mute add nothing.
  assert.equal((await tracker.observe(rows(now + HOUR))).nextStatusCheckAtMs, now + 2 * HOUR);
  assert.equal((await tracker.observe(rows(now + 2 * HOUR))).nextStatusCheckAtMs, undefined);
});

test('pending.json keeps a timed mute and loads invalid end times as 0', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  const row = await timedScan(tracker, now);
  assert.equal(tracker.records[id].mutedUntil, 0);
  await tracker.setMuted(row, true, now + HOUR);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.records[id].mutedUntil, now + HOUR);
  const loaded = new PendingTracker(statePath);
  const active = await timedScan(loaded, now);
  assert.deepEqual([loaded.records[id].mutedUntil, active.muted, active.mutedUntilMs], [now + HOUR, true, now + HOUR]);
  for (const [muted, mutedUntil] of [[1, -1], [1, '3600000'], [1, 3600000.5], [1, Number.MAX_SAFE_INTEGER + 1],
    [1, 0], [1, null], [1, undefined], [0, now + HOUR]]) {
    await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], muted, mutedUntil } } }));
    const invalid = new PendingTracker(statePath);
    const result = await timedScan(invalid, now);
    assert.deepEqual([invalid.records[id].mutedUntil, result.muted, result.mutedUntilMs, invalid.warning], [0, muted === 1, 0, ''], JSON.stringify([muted, mutedUntil]));
  }
  await tracker.setMuted(row, false);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath, 'utf8')).records[id], 'mutedUntil'), false);
});

test('Unmute clears a timed mute and a new Mute replaces its end', async () => {
  const tracker = await timedTracker();
  const row = await timedScan(tracker, now);
  for (const end of [now + 8 * HOUR, now + HOUR, 0]) {
    await tracker.setMuted(row, true, end);
    tracker.apply(row, now);
    assert.deepEqual([tracker.records[id].muted, tracker.records[id].mutedUntil, row.muted, row.mutedUntilMs], [1, end, true, end]);
  }
  await tracker.setMuted(row, true, now + HOUR);
  await tracker.setMuted(row, false);
  assert.deepEqual([tracker.records[id].muted, tracker.records[id].mutedUntil, row.muted, row.mutedUntilMs], [0, 0, false, 0]);
});

test('prune keeps an unseen active timed mute but drops it at its end', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const old = { seen: 0, working: 0, pending: 0, ack: 0, lastSeen: now - 31 * 86_400_000, muted: 1 };
  await writeFile(statePath, JSON.stringify({ version: 1, records: {
    active: { ...old, mutedUntil: now + HOUR }, ended: { ...old, mutedUntil: now - 1 }, boundary: { ...old, mutedUntil: now },
  } }));
  const tracker = new PendingTracker(statePath);
  await tracker.observe({ providers: [], threads: [], generatedAtMs: now });
  assert.deepEqual(Object.keys(tracker.records), ['active']);
  assert.equal(tracker.records.active.mutedUntil, now + HOUR);
  await tracker.observe({ providers: [], threads: [], generatedAtMs: now + HOUR });
  assert.deepEqual(Object.keys(tracker.records), []);
});

test('mute and unmute are local session actions with an empty body', async (t) => {
  const tracker = new PendingTracker(false);
  const server = createSwitchboardServer({ pendingTracker: tracker, dashboardWatchPaths: [], openThread: async () => ({ opened: true }),
    loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', state: 'idle', nativeUnread: null, completionAtMs: 0 }] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (action, body = '{}', thread = id) => fetch(`${base}/api/threads/${thread}/${action}`, { method: 'POST', headers: { Origin: base }, body });
  const reply = async (response) => [response.status, await response.json()];
  for (const action of ['mute', 'unmute']) {
    assert.equal((await post(action, '{"enabled":true}')).status, 400, action);
    assert.equal((await post(action, '[]')).status, 400, action);
    assert.deepEqual(await reply(await post(action, '{}', 'missing')), await reply(await post('mark-read', '{}', 'missing')), action);
    assert.equal((await post(action, '{}', 'missing')).status, 404, action);
  }
  const muted = await (await post('mute')).json();
  assert.deepEqual([muted.changed, muted.threadId, muted.thread.muted], [true, id, true]);
  assert.equal((await (await fetch(`${base}/api/dashboard`)).json()).threads[0].muted, true);
  const unmuted = await (await post('unmute')).json();
  assert.deepEqual([unmuted.changed, unmuted.threadId, unmuted.thread.muted], [true, id, false]);
  assert.equal(tracker.records[id].muted, 0);
});

const DAY = 24 * HOUR;
const live = (atMs, ids = ['live']) => ({ generatedAtMs: atMs, providers: [],
  threads: ids.map((rowId) => ({ id: rowId, state: 'idle', nativeUnread: null, completionAtMs: 0 })) });
const savedRecords = async (statePath) => Object.keys(JSON.parse(await readFile(statePath, 'utf8')).records).sort();

test('a record that ASB did not see for 30 days goes, and a pin, a mark, the drawer, Mute, or a Discard keeps it', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const old = { seen: 0, working: 0, pending: 0, ack: 0, lastSeen: now - 31 * DAY };
  const records = { plain: old, working: { ...old, working: 1 }, read: { ...old, seen: 9, pending: 9, ack: 9 },
    pinned: old, manual: { ...old, manual: 1 }, drawer: { ...old, drawer: 1 }, muted: { ...old, muted: 1 }, discard: { ...old, discard: 1 },
    retained: { ...old, retained: 'observed-completion' }, unread: { ...old, seen: 5, pending: 5 }, question: { ...old, questionSeen: 3 },
    native: { ...old, nativeAt: 3 }, recent: { ...old, lastSeen: now - 29 * DAY } };
  await writeFile(statePath, JSON.stringify({ version: 1, persistentUnread: true, pinnedOrder: ['pinned'], records }));
  const tracker = new PendingTracker(statePath);
  const dashboard = await tracker.observe(live(now));
  assert.deepEqual(await savedRecords(statePath), ['discard', 'drawer', 'live', 'manual', 'muted', 'native', 'pinned', 'question', 'recent', 'retained', 'unread']);
  assert.deepEqual(Object.keys(tracker.records).sort(), await savedRecords(statePath));
  assert.deepEqual([dashboard.pinnedOrder, stateWarning(dashboard)], [['pinned'], undefined]);
  // A kept record keeps its marks and its old time of sight. A record that is 29 days old goes 2 days later.
  const unread = JSON.parse(await readFile(statePath, 'utf8')).records.unread;
  assert.deepEqual([unread.seen, unread.pending, unread.ack, unread.lastSeen], [5, 5, 0, now - 31 * DAY]);
  await tracker.observe(live(now + 2 * DAY));
  assert.deepEqual(await savedRecords(statePath), ['discard', 'drawer', 'live', 'manual', 'muted', 'native', 'pinned', 'question', 'retained', 'unread']);
});

test('a record from an older ASB with no time of sight stays for 30 days from the first load', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const start = Date.now();
  await writeFile(statePath, JSON.stringify({ version: 1, persistentUnread: true, pinnedOrder: [], records: { legacy: { seen: 1, working: 0, pending: 0, ack: 0 } } }));
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(start));
  assert.equal(tracker.records.legacy.lastSeen >= start, true);
  await tracker.observe(live(start + 29 * DAY));
  assert.deepEqual(Object.keys(tracker.records).sort(), ['legacy', 'live']);
  await tracker.observe(live(start + 31 * DAY));
  assert.deepEqual(await savedRecords(statePath), ['live']);
});

test('a scan moves the time of sight to the start of the UTC day at most once a day, so it does not rewrite pending.json, and a row seen each day is never dropped', async (t) => {
  const dir = await temp(t);
  const statePath = path.join(dir, 'pending.json');
  const tracker = new PendingTracker(statePath);
  const midnight = Math.floor(now / DAY) * DAY;
  await tracker.observe(live(now));
  const first = await readFile(statePath, 'utf8');
  assert.equal(JSON.parse(first).records.live.lastSeen, midnight);
  // `now` is 14:00 UTC: the UTC day goes on for 10 hours.
  for (const offset of [2_000, HOUR, 9 * HOUR]) {
    await tracker.observe(live(now + offset));
    assert.equal(await readFile(statePath, 'utf8'), first, String(offset));
  }
  assert.equal(tracker.writeCount, 1);
  await tracker.observe(live(now + 10 * HOUR));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).records.live.lastSeen, midnight + DAY);
  assert.equal(tracker.writeCount, 2);
  // 'daily' is seen each day, 'gap' only on the first day.
  const other = path.join(dir, 'other.json');
  const days = new PendingTracker(other);
  await days.observe(live(now, ['daily', 'gap']));
  for (let day = 1; day <= 40; day += 1) await days.observe(live(now + day * DAY, ['daily']));
  assert.deepEqual(await savedRecords(other), ['daily']);
});

test('rows that appeared at different times move their time of sight in one write a day', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  const midnight = Math.floor(now / DAY) * DAY;
  await tracker.observe(live(now, ['a']));
  await tracker.observe(live(now + 1000, ['a', 'b']));
  await tracker.observe(live(now + 5000, ['a', 'b', 'c']));
  assert.equal(tracker.writeCount, 3);
  for (let scan = 0; scan < 5; scan += 1) await tracker.observe(live(now + 10 * HOUR + scan * 2000, ['a', 'b', 'c']));
  assert.equal(tracker.writeCount, 4);
  assert.deepEqual(Object.values(JSON.parse(await readFile(statePath, 'utf8')).records).map((record) => record.lastSeen), Array(3).fill(midnight + DAY));
});

test('the records of a machine that left the group go with their pins, and nothing goes while the members are not known', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  const rows = [`m:${a}:one`, `m:${a}:two`, `m:${b}:one`, 'codex:local', `m:${b}`];
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(now, rows));
  await tracker.setPinned(`m:${b}:one`, true);
  await tracker.setPinned(`m:${a}:one`, true);
  await tracker.markUnread(`m:${b}:two`);
  // The rows are not in the next dashboards, so only the member rule can drop their records.
  for (const members of [null, undefined]) {
    await tracker.observe(live(now + 1000, ['live']), members);
    assert.deepEqual(Object.keys(tracker.records).sort(), [...rows, 'live'].sort());
  }
  const present = await tracker.observe(live(now + 2000, ['live']), [a, 'c'.repeat(16)]);
  assert.deepEqual(Object.keys(tracker.records).sort(), [`m:${a}:one`, `m:${a}:two`, `m:${b}`, 'codex:local', 'live'].sort());
  assert.deepEqual(present.pinnedOrder, [`m:${a}:one`]);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, [`m:${a}:one`]);
  // A row that is still in the scan keeps its record, also when its machine is not in the list.
  await tracker.observe(live(now + 3000, [`m:${a}:one`]), [b]);
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, `m:${b}`, 'codex:local', 'live'].sort());
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, [`m:${a}:one`]);
  await tracker.observe(live(now + 4000, ['live']), [b]);
  assert.deepEqual(await savedRecords(statePath), [`m:${b}`, 'codex:local', 'live'].sort());
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, []);
});

test('the server gives the tracker the group members, so the records of a member that left go at the next scan', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const a = 'a'.repeat(16);
  const b = 'b'.repeat(16);
  let members = [a, b];
  // The merge lists the rows of the members that are in the group only.
  const server = createSwitchboardServer({ pendingStatePath: statePath, dashboardWatchPaths: [], machineGroup: { merge: (dashboard) => dashboard, memberIds: () => members },
    loadDashboard: async () => live(Date.now(), [`m:${a}:one`, ...members.includes(b) ? [`m:${b}:one`] : [], 'codex:local']) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const scan = async () => {
    server.invalidateDashboard('test', { hard: true });
    await (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`)).json();
  };
  await scan();
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, `m:${b}:one`, 'codex:local'].sort());
  members = [a];
  await scan();
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, 'codex:local'].sort());
});

test('with no group, the records and pins of the old members go at the next scan; before the group loads they stay', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const a = 'a'.repeat(16);
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(now, [`m:${a}:one`, 'codex:local']), [a]);
  await tracker.setPinned(`m:${a}:one`, true);
  await tracker.setPinned('codex:local', true);
  const before = await tracker.observe(live(now + 1000, ['codex:local']), null);
  assert.deepEqual(Object.keys(tracker.records).sort(), [`m:${a}:one`, 'codex:local'].sort());
  assert.deepEqual([...before.pinnedOrder].sort(), [`m:${a}:one`, 'codex:local'].sort());
  assert.deepEqual(await savedRecords(statePath), [`m:${a}:one`, 'codex:local'].sort());
  const after = await tracker.observe(live(now + 2000, ['codex:local']), []);
  assert.deepEqual(Object.keys(tracker.records), ['codex:local']);
  assert.deepEqual(after.pinnedOrder, ['codex:local']);
  assert.deepEqual(await savedRecords(statePath), ['codex:local']);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).pinnedOrder, ['codex:local']);
});

test('a scan that changes nothing serializes nothing, compares nothing, and writes nothing', async (t) => {
  const tracker = new PendingTracker(path.join(await temp(t), 'pending.json'));
  const states = ['idle', 'working', 'waiting', 'unknown'];
  const board = (atMs) => ({ generatedAtMs: atMs, providers: [], threads: Array.from({ length: 200 }, (_, index) => ({
    id: index % 5 === 0 ? `m:${'a'.repeat(16)}:row-${index}` : `row-${index}`, state: states[index % 4], archived: index % 17 === 0,
    nativeUnread: index % 3 === 0 ? index % 2 === 0 : null, completionAtMs: index * 1000, questionPending: index % 11 === 0 })) });
  await tracker.observe(board(now));
  await tracker.observe(board(now + 2000), ['a'.repeat(16)]);
  const writes = tracker.writeCount;
  const stringify = JSON.stringify;
  let serialized = 0;
  JSON.stringify = function (value, ...rest) {
    if (value && typeof value === 'object' && 'records' in value) serialized += 1;
    return stringify.call(this, value, ...rest);
  };
  try {
    for (let scan = 0; scan < 20; scan += 1) await tracker.observe(board(now + 4000 + scan * 2000), ['a'.repeat(16)]);
  } finally { JSON.stringify = stringify; }
  assert.deepEqual([serialized, tracker.writeCount, tracker.dirty], [0, writes, false]);
});

test('a call that changes nothing writes nothing, and a call that changes the pin order or Persistent unread writes', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  await tracker.observe(live(now, ['a', 'b', 'c']));
  await tracker.setPinned('a', true);
  await tracker.setPinned('b', true);
  const writes = tracker.writeCount;
  await tracker.setPinned('a', true);
  await tracker.setPinned('c', false);
  await tracker.movePin('a', { direction: 'up' });
  await tracker.movePin('b', { direction: 'down' });
  await tracker.movePin('a', { targetId: 'b', placement: 'before' });
  await tracker.setPersistentUnread(true, { threads: [] });
  await tracker.markUnread('missing');
  await tracker.acknowledge('missing');
  assert.equal(tracker.writeCount, writes);
  const pins = async () => JSON.parse(await readFile(statePath, 'utf8'));
  await tracker.setPinned('c', true);
  await tracker.movePin('c', { direction: 'up' });
  assert.deepEqual([tracker.writeCount, (await pins()).pinnedOrder], [writes + 2, ['a', 'c', 'b']]);
  await tracker.movePin('c', { targetId: 'b', placement: 'after' });
  await tracker.setPersistentUnread(false, { threads: [] });
  await tracker.setPinned('a', false);
  assert.deepEqual([tracker.writeCount, (await pins()).pinnedOrder, (await pins()).persistentUnread], [writes + 5, ['b', 'c'], false]);
});

// A small seeded random number generator, so that a failure repeats.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// What ASB 1.10.0 makes of one record in pending.json. This is its loader (`PendingTracker.load` in src/switchboard.mjs at the tag v1.10.0),
// copied. It returns null for a record that this loader rejects, and a null `lastSeen` for a record that gets the time of the load.
function loadAsV110(record) {
  const number = (value) => Number.isFinite(value) && value >= 0;
  if (!['seen', 'working', 'pending', 'ack'].every((key) => number(record?.[key]))) return null;
  const loaded = { seen: record.seen, working: record.working, pending: record.pending, ack: record.ack, manual: record.manual === 1 ? 1 : 0,
    retained: ['native-unread', 'observed-completion', 'observed-failure'].includes(record.retained) ? record.retained : '',
    pendingKind: record.pendingKind === 'failed' ? 'failed' : '' };
  for (const key of ['questionSeen', 'questionAck', 'nativeAt', 'nativeAck', 'nativeSeen', 'discard', 'discardedAt', 'discardStart', 'discardEnd',
    'discardNative', 'drawerSeen']) loaded[key] = number(record[key]) ? record[key] : 0;
  return Object.assign(loaded, { discard: record.discard === 1 ? 1 : 0, discardNative: record.discardNative === 1 ? 1 : 0,
    drawer: record.drawer === 1 ? 1 : 0, muted: record.muted === 1 ? 1 : 0, lastSeen: number(record.lastSeen) ? record.lastSeen : null });
}
const asV110 = (records) => Object.fromEntries(Object.entries(records).map(([key, record]) => [key, loadAsV110(record)]));
// `discardNext`, `actionSeen`, `actionAck`, `mutedUntil`, and `mutedAt` are newer than ASB 1.10.0, which ignores them.
const withoutNext = (records) => Object.fromEntries(Object.entries(records)
  .map(([key, { discardNext, actionSeen, actionAck, mutedUntil, mutedAt, ...record }]) => [key, record]));

// Watches the change marks of a tracker. `touched` has the record fields that changed through set(), and `marks` counts the times that other code set the
// flag (a new or dropped record, the pin order, Persistent unread).
function watchMarks(tracker) {
  const touched = new Map();
  const watch = { touched, marks: 0, snapshot: () => ({ records: new Map(Object.entries(tracker.records).map(([key, record]) => [key, { ...record }])),
    pins: [...tracker.pinnedOrder], persistentUnread: tracker.persistentUnread }) };
  let flag = tracker.dirty;
  let inSet = false;
  Object.defineProperty(tracker, 'dirty', { get: () => flag, set: (value) => { if (value && !inSet) watch.marks += 1; flag = value; } });
  const set = tracker.set;
  tracker.set = function (record, key, value) {
    const before = record[key];
    inSet = true;
    try { return set.call(this, record, key, value); } finally {
      inSet = false;
      if (!Object.is(before, record[key])) touched.set(record, new Set([...touched.get(record) || [], key]));
    }
  };
  // Throws when the state changed since `before` by a path that did not mark it.
  watch.verify = (before, label) => {
    let structural = false;
    for (const [key, record] of Object.entries(tracker.records)) {
      const old = before.records.get(key);
      if (!old) { structural = true; continue; }
      for (const field in record) {
        if (!Object.is(old[field], record[field])) assert.ok(touched.get(record)?.has(field), `${label}: ${key}.${field} changed without set()`);
      }
    }
    for (const key of before.records.keys()) if (!tracker.records[key]) structural = true;
    if (before.pins.join() !== tracker.pinnedOrder.join() || before.persistentUnread !== tracker.persistentUnread) structural = true;
    if (structural) assert.ok(watch.marks > 0, `${label}: a record, the pin order, or Persistent unread changed, and nothing set the flag`);
  };
  return watch;
}

// One call on a tracker that watchMarks() watches. The call must mark each change. After save(), a new tracker and ASB 1.10.0 must read the same state
// from the file. `saves` is true for a method that must save before it returns.
async function checkedStep(tracker, watch, label, run, saves = true) {
  await tracker.save();
  const before = watch.snapshot();
  watch.touched.clear();
  watch.marks = 0;
  const result = await run();
  watch.verify(before, label);
  if (saves) assert.equal(tracker.dirty, false, `${label}: saved before it returns`);
  await tracker.save();
  const fresh = new PendingTracker(tracker.statePath);
  await fresh.load();
  assert.deepEqual([fresh.records, fresh.pinnedOrder, fresh.persistentUnread, fresh.warning], [tracker.records, tracker.pinnedOrder, tracker.persistentUnread, ''], label);
  const file = JSON.parse(await readFile(tracker.statePath, 'utf8'));
  assert.deepEqual([asV110(file.records), file.pinnedOrder, file.persistentUnread], [withoutNext(tracker.records), tracker.pinnedOrder, tracker.persistentUnread], `${label} in ASB 1.10.0`);
  return result;
}

test('each path that changes a record, the pin order, or Persistent unread marks it, and the file means the same to this ASB and to ASB 1.10.0', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const tracker = new PendingTracker(statePath);
  const watch = watchMarks(tracker);
  const rand = seeded(20261021);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const member = 'a'.repeat(16);
  const ids = ['one', 'two', 'three', 'four', `m:${member}:five`, `m:${'b'.repeat(16)}:six`];
  const marks = new Map(ids.map((rowId) => [rowId, { completion: 0, failed: 0 }]));
  let clock = now;
  let rows = [];
  const scan = async () => {
    const threads = [];
    for (const [rowId, mark] of marks) {
      if (rand() < 0.15) continue;
      if (rand() < 0.3) mark.completion = clock;
      if (rand() < 0.1) mark.failed = clock;
      threads.push({ id: rowId, state: pick(['idle', 'idle', 'working', 'working', 'waiting', 'unknown']), archived: rand() < 0.05,
        nativeUnread: pick([null, null, true, false]), completionAtMs: mark.completion, failedAtMs: mark.failed, questionPending: rand() < 0.1,
        lastOutcome: mark.failed > mark.completion ? 'failed' : 'complete' });
    }
    rows = (await tracker.observe({ generatedAtMs: clock, providers: [], threads }, rand() < 0.3 ? [member] : null)).threads;
  };
  const row = () => pick(rows.length ? rows : [{ id: 'one' }]);
  const refused = (error) => { if (error.statusCode !== 400) throw error; };
  // The scan and each method that changes saved state. The first item is true for a method that saves before it returns.
  const operations = {
    scan: [true, scan],
    'scan up to 3 days later': [true, async () => { clock += Math.floor(rand() * 3 * DAY); await scan(); }],
    'scan 40 days later': [true, async () => { clock += 40 * DAY; await scan(); }],
    markUnread: [true, () => tracker.markUnread(pick(ids))],
    acknowledge: [true, () => tracker.acknowledge(pick(ids))],
    drawer: [false, () => tracker.setDrawer(row(), rand() < 0.6).catch(refused)],
    mute: [false, () => tracker.setMuted(row(), rand() < 0.6).catch(refused)],
    discard: [false, () => tracker.setDiscard(row(), rand() < 0.7, rand() < 0.5).catch(refused)],
    pin: [true, () => tracker.setPinned(pick(ids), rand() < 0.7).catch(refused)],
    movePin: [true, () => tracker.movePin(pick(ids), rand() < 0.5 ? { direction: pick(['up', 'down']) }
      : { targetId: pick(ids), placement: pick(['before', 'after']) }).catch(refused)],
    persistentUnread: [true, () => tracker.setPersistentUnread(rand() < 0.5, { threads: rows })],
    // apply() changes a record when the drawer or the retained mark must change. It does not save: the next save() does.
    apply: [false, () => tracker.apply(row())],
  };
  const names = [...Object.keys(operations), 'scan', 'scan', 'scan', 'scan'];
  const ran = new Set();
  await scan();
  for (let step = 0; step < 700; step += 1) {
    const name = step === 0 ? 'scan' : pick(names);
    ran.add(name);
    clock += 2000;
    await checkedStep(tracker, watch, `${step} ${name}`, operations[name][1], operations[name][0]);
  }
  assert.deepEqual([...ran].sort(), Object.keys(operations).sort());
  assert.ok(tracker.writeCount > 150, String(tracker.writeCount));
});

test('the Discard, drawer, and native paths that the random run reaches rarely mark their changes too', async (t) => {
  const dir = await temp(t);
  const start = (name) => {
    const tracker = new PendingTracker(path.join(dir, `${name}.json`));
    const watch = watchMarks(tracker);
    let row = null;
    const observe = (label, dashboard) => checkedStep(tracker, watch, label, async () => { row = (await tracker.observe(dashboard)).threads[0]; });
    return { tracker, observe, scanRow: (label, state, extra = {}) => observe(label, plain(state, extra)), row: () => row,
      call: (label, run) => checkedStep(tracker, watch, label, run, false) };
  };

  // A Discard of a Working task, its success, a late native Unread of the app, and a second Discard that ends with success.
  const native = start('native');
  await native.scanRow('idle', 'idle', { nativeUnread: false });
  await native.scanRow('working', 'working', { nativeUnread: false });
  await native.call('discard', () => native.tracker.setDiscard(native.row(), true));
  await native.scanRow('success', 'idle', { completionAtMs: 10, nativeUnread: false });
  await native.scanRow('late native unread', 'idle', { completionAtMs: 10, nativeUnread: true });
  assert.equal(native.tracker.records[id].discardNative, 1);
  await native.scanRow('working again', 'working', { completionAtMs: 10, nativeUnread: true });
  await native.call('discard again', () => native.tracker.setDiscard(native.row(), true));
  await native.scanRow('second success', 'idle', { completionAtMs: 20, nativeUnread: false });
  assert.deepEqual([native.tracker.records[id].discardNative, native.tracker.records[id].discardedAt], [0, 20]);

  // The drawer, then Unread.
  const drawer = start('drawer');
  await drawer.scanRow('idle', 'idle');
  await drawer.scanRow('working', 'working');
  await drawer.scanRow('ended', 'idle', { completionAtMs: 10 });
  await drawer.call('put in the drawer', () => drawer.tracker.setDrawer(drawer.row(), true));
  assert.equal(drawer.tracker.records[id].drawer, 1);
  await drawer.call('unread', () => drawer.tracker.markUnread(id));
  assert.deepEqual([drawer.tracker.records[id].drawer, drawer.tracker.records[id].manual], [0, 1]);

  // A Discard of the next task of an Idle Claude chat saves the start and the end of the task that it follows. A task that starts after it moves the start.
  const next = start('next');
  const board = (extra) => buildSwitchboardDashboard([claude(extra)], [], now + 1000);
  const running = (startAt, endAt) => board({ lifecycleRunning: true, agentActivityAtMs: now + startAt, agentStartedAtMs: now + startAt,
    latestTaskStartedAtMs: now + startAt, latestTaskEndedAtMs: now + endAt, latestTaskEndKind: 'task_complete' });
  await next.observe('idle', board({ lifecycleRunning: false, latestLifecycleKind: 'task_complete', latestLifecycleAtMs: now - 900,
    latestTaskStartedAtMs: now - 1000, latestTaskEndedAtMs: now - 900, latestTaskEndKind: 'task_complete' }));
  await next.call('discard next', () => next.tracker.setDiscard(next.row(), true, true));
  assert.deepEqual([next.tracker.records[id].discardStart, next.tracker.records[id].discardEnd, next.tracker.records[id].discardNext], [now - 1000, now - 900, 1]);
  await next.observe('the next task starts', running(0, -900));
  assert.deepEqual([next.tracker.records[id].discardStart, next.tracker.records[id].discardNext, next.tracker.records[id].discard], [now, 0, 1]);
});

test('pending.json has no field that holds its default, and it keeps the fields that ASB 1.10.0 needs', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const zero = { seen: 0, working: 0, pending: 0, ack: 0, manual: 0, retained: '', pendingKind: '', questionSeen: 0, questionAck: 0, actionSeen: 0, actionAck: 0,
    nativeAt: 0, nativeAck: 0, nativeSeen: 0, discard: 0, discardNext: 0, discardedAt: 0, discardStart: 0, discardEnd: 0, discardNative: 0, drawer: 0, drawerSeen: 0, muted: 0, lastSeen: 0 };
  const rich = { seen: 500, working: 1, pending: 400, ack: 300, manual: 1, retained: 'observed-failure', pendingKind: 'failed', questionSeen: 7, questionAck: 5,
    actionSeen: 16, actionAck: 15, nativeAt: 9, nativeAck: 8, nativeSeen: 1, discard: 1, discardNext: 1, discardedAt: 11, discardStart: 12, discardEnd: 13, discardNative: 1,
    drawer: 1, drawerSeen: 14, muted: 1, lastSeen: now };
  const some = { ...zero, seen: 20, retained: 'native-unread', nativeAt: 3, lastSeen: now };
  // A file in the full form, as an older ASB wrote it.
  const older = { version: 1, persistentUnread: false, pinnedOrder: ['some', 'rich'], records: { rich, zero, some } };
  await writeFile(statePath, JSON.stringify(older));
  const tracker = new PendingTracker(statePath);
  await tracker.markUnread('zero');
  const text = await readFile(statePath, 'utf8');
  const file = JSON.parse(text);
  assert.deepEqual(Object.keys(file), ['version', 'records', 'pinnedOrder', 'persistentUnread']);
  assert.deepEqual([file.version, file.pinnedOrder, file.persistentUnread], [1, ['some', 'rich'], false]);
  // The five fields stay also with the value 0. Every other field is there only with a value that is not its default.
  assert.deepEqual(file.records.zero, { seen: 0, working: 0, pending: 0, ack: 0, manual: 1, lastSeen: 0 });
  assert.deepEqual(file.records.some, { seen: 20, working: 0, pending: 0, ack: 0, retained: 'native-unread', nativeAt: 3, lastSeen: now });
  assert.deepEqual(file.records.rich, rich);
  assert.equal(text.includes('""'), false);
  // This ASB and ASB 1.10.0 read the same records as from the full form (with the one change that the call made).
  const expected = { rich: { ...rich, mutedUntil: 0, mutedAt: 0 }, zero: { ...zero, manual: 1, mutedUntil: 0, mutedAt: 0 }, some: { ...some, mutedUntil: 0, mutedAt: 0 } };
  const loaded = new PendingTracker(statePath);
  await loaded.load();
  assert.deepEqual([{ ...loaded.records }, loaded.warning], [expected, '']);
  assert.deepEqual(asV110(file.records), asV110(expected));
  assert.deepEqual(asV110(file.records), withoutNext(expected));
  // A file of 1300 idle records is under half of the full form.
  const many = new PendingTracker(path.join(path.dirname(statePath), 'many.json'));
  await many.observe(live(now, Array.from({ length: 1300 }, (_, index) => `0a1b2c3d-4e5f-4a6b-8c7d-${String(index).padStart(12, '0')}`)));
  const full = JSON.stringify({ version: 1, records: many.records, pinnedOrder: many.pinnedOrder, persistentUnread: many.persistentUnread });
  assert.ok((await stat(many.statePath)).size < full.length / 2, `${(await stat(many.statePath)).size} of ${full.length}`);
});
