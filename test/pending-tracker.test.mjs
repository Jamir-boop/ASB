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
