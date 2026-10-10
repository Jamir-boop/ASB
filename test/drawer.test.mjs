import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-drawer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const plain = (state, extra = {}) => ({ providers: [], threads: [{ id, state, nativeUnread: null, completionAtMs: 0, ...extra }] });
const scan = async (tracker, state, extra) => (await tracker.observe(plain(state, extra))).threads[0];
const view = (row) => [row.drawer, row.unread, row.pending];
const stateWarning = (dashboard) => dashboard.providers.find((provider) => provider.id === 'asb-state');
const refused = (tracker, row, enabled) => assert.rejects(tracker.setDrawer(row, enabled), { statusCode: 400 });
// An observed completion at 10 that is put in the drawer.
async function drawn(tracker = new PendingTracker(false)) {
  await scan(tracker, 'idle');
  await scan(tracker, 'working');
  const row = await scan(tracker, 'idle', { completionAtMs: 10 });
  assert.deepEqual(view(row), [false, true, true]);
  await tracker.setDrawer(row, true);
  return { tracker, row };
}

test('a drawer card is read in the list, keeps its mark fields, and survives a scan and a restart', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const { tracker, row } = await drawn(new PendingTracker(statePath));
  const marks = (value) => [value.manualUnread, value.nativeAttention, value.completionAttention, value.failedAttention,
    value.retainedUnread, value.retainedUnreadSource, value.pendingSource];
  assert.deepEqual(view(row), [true, false, false]);
  assert.deepEqual(marks(row), [false, false, true, false, false, '', 'observed-completion']);
  const again = await scan(tracker, 'idle', { completionAtMs: 10 });
  assert.deepEqual([view(again), marks(again)], [[true, false, false], marks(row)]);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual([saved.version, saved.records[id].drawer, saved.records[id].drawerSeen], [1, 1, 10]);
  assert.deepEqual(Object.keys(saved.records[id]).filter((key) => /^drawer/.test(key)).sort(), ['drawer', 'drawerSeen']);
  const restarted = await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 10 }));
  assert.deepEqual([view(restarted.threads[0]), stateWarning(restarted)], [[true, false, false], undefined]);

  // Values of the two fields that an unreleased build wrote are ignored.
  await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], drawerPending: 'private', drawerNative: -5 } } }));
  const older = new PendingTracker(statePath);
  const kept = await older.observe(plain('idle', { completionAtMs: 10 }));
  assert.deepEqual([view(kept.threads[0]), stateWarning(kept)], [[true, false, false], undefined]);
  assert.deepEqual(Object.keys(older.records[id]).filter((key) => /^drawer/.test(key)).sort(), ['drawer', 'drawerSeen']);

  for (const [drawer, drawerSeen] of [['1', 10], [7, 10], [-1, 10], [true, 10], [1, '10'], [1, -1], [1, null]]) {
    await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], drawer, drawerSeen } } }));
    const invalid = new PendingTracker(statePath);
    await invalid.load();
    const name = JSON.stringify([drawer, drawerSeen]);
    assert.deepEqual([invalid.records[id].drawer, invalid.records[id].drawerSeen], drawer === 1 ? [1, 0] : [0, 10], name);
    const loaded = await invalid.observe(plain('idle', { completionAtMs: 10 }));
    assert.deepEqual([view(loaded.threads[0]), stateWarning(loaded), invalid.records[id].drawer], [[false, true, true], undefined, 0], name);
  }
});

test('put and take-out write the state file at once', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const stored = async () => { const record = JSON.parse(await readFile(statePath, 'utf8')).records[id]; return [record.drawer, record.drawerSeen]; };
  const { tracker, row } = await drawn(new PendingTracker(statePath));
  assert.deepEqual(await stored(), [1, 10]);
  await tracker.setDrawer(row, false);
  assert.deepEqual(await stored(), [0, 10]);
});

test('only a stored drawer value of 1 with a live mark loads as in the drawer', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  await drawn(new PendingTracker(statePath));
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual([saved.records[id].drawer, saved.records[id].drawerSeen], [1, 10]);
  for (const [drawer, expected] of [[1, [true, false, false]], [7, [false, true, true]]]) {
    await writeFile(statePath, JSON.stringify({ ...saved, records: { [id]: { ...saved.records[id], drawer } } }));
    const loaded = await new PendingTracker(statePath).observe(plain('idle', { completionAtMs: 10 }));
    assert.deepEqual([view(loaded.threads[0]), stateWarning(loaded)], [expected, undefined], String(drawer));
  }
});

test('a card with an observed failure mark goes in the drawer and stays there', async () => {
  const tracker = new PendingTracker(false);
  await scan(tracker, 'idle');
  await scan(tracker, 'working');
  const failed = await scan(tracker, 'idle', { failedAtMs: 10 });
  assert.deepEqual([view(failed), failed.failedAttention, failed.pendingSource], [[false, true, true], true, 'observed-failure']);
  await tracker.setDrawer(failed, true);
  assert.deepEqual(view(failed), [true, false, false]);
  for (const round of [1, 2]) {
    const again = await scan(tracker, 'idle', { failedAtMs: 10 });
    assert.deepEqual([view(again), again.failedAttention, tracker.records[id].drawer], [[true, false, false], true, 1], String(round));
  }
});

test('the user takes a card out of the drawer as a normal unread card', async () => {
  const { tracker, row } = await drawn();
  await tracker.setDrawer(row, false);
  assert.deepEqual(view(row), [false, true, true]);
  assert.deepEqual(view(await scan(tracker, 'idle', { completionAtMs: 10 })), [false, true, true]);
  await refused(tracker, row, false);
});

test('new attention takes a card out of the drawer', async (t) => {
  const dir = await temp(t);
  const flag = async (tracker) => JSON.parse(await readFile(tracker.statePath, 'utf8')).records[id].drawer;
  for (const [name, end, attention] of [['completion', { completionAtMs: 20 }, 'completionAttention'],
    ['failure', { completionAtMs: 10, failedAtMs: 20 }, 'failedAttention']]) {
    const { tracker } = await drawn(new PendingTracker(path.join(dir, `${name}.json`)));
    assert.deepEqual(view(await scan(tracker, 'working', { completionAtMs: 10 })), [true, false, false], name);
    const ended = await scan(tracker, 'idle', end);
    assert.deepEqual([view(ended), ended[attention], await flag(tracker)], [[false, true, true], true, 0], name);
  }

  const native = new PendingTracker(path.join(dir, 'native.json'));
  const unread = await scan(native, 'idle', { nativeUnread: true });
  assert.deepEqual([view(unread), unread.nativeAttention], [[false, true, true], true]);
  await native.setDrawer(unread, true);
  assert.deepEqual(view(await scan(native, 'idle', { nativeUnread: true })), [true, false, false]);
  const raised = await scan(native, 'idle', { nativeUnread: true, completionAtMs: 30 });
  assert.deepEqual([view(raised), raised.nativeAttention, await flag(native)], [[false, true, true], true, 0]);

  // A task that starts and ends between two scans has no Working scan.
  for (const [name, end] of [['fast completion', { completionAtMs: 20 }], ['fast failure', { failedAtMs: 20 }]]) {
    const fast = new PendingTracker(path.join(dir, `${name}.json`));
    await scan(fast, 'idle');
    await fast.markUnread(id);
    await fast.setDrawer(await scan(fast, 'idle'), true);
    assert.deepEqual(view(await scan(fast, 'idle')), [true, false, false], name);
    const ended = await scan(fast, 'idle', end);
    assert.deepEqual([view(ended), ended.manualUnread, await flag(fast)], [[false, true, true], true, 0], name);
  }

  const { tracker } = await drawn(new PendingTracker(path.join(dir, 'question.json')));
  const asked = await scan(tracker, 'waiting', { completionAtMs: 10, questionPending: true });
  assert.deepEqual([asked.drawer, asked.pending, asked.questionAttention, asked.pendingSource, await flag(tracker)],
    [false, true, true, 'user-question', 0]);
});

test('a drawer card keeps its place through one scan that cannot show its mark', async () => {
  for (const away of [{ state: 'working' }, { state: 'waiting' }, { state: 'unknown' }, { state: 'idle', archived: true }]) {
    const { tracker } = await drawn();
    const name = JSON.stringify(away);
    const { state, ...extra } = away;
    const hidden = await scan(tracker, state, { completionAtMs: 10, questionPending: false, ...extra });
    assert.deepEqual([hidden.drawer, hidden.unread, hidden.completionAttention], [true, false, false], name);
    assert.equal(tracker.records[id].drawer, 1, name);
    const back = await scan(tracker, 'idle', { completionAtMs: 10 });
    assert.deepEqual([view(back), back.completionAttention], [[true, false, false], true], name);
  }
});

test('an unknown or raised native read state with no new result keeps a card in the drawer', async () => {
  const native = new PendingTracker(false);
  await native.setDrawer(await scan(native, 'idle', { nativeUnread: true }), true);
  const nativeAt = native.records[id].nativeAt;
  for (const nativeUnread of [null, true, undefined, true]) {
    assert.deepEqual(view(await scan(native, 'idle', { nativeUnread })), [true, false, false], String(nativeUnread));
    assert.equal(native.records[id].nativeAt, nativeAt, String(nativeUnread));
  }

  const { tracker } = await drawn();
  const raised = await scan(tracker, 'idle', { completionAtMs: 10, nativeUnread: true });
  assert.deepEqual([view(raised), raised.nativeAttention, tracker.records[id].drawer], [[true, false, false], true, 1]);
});

test('a discarded result is not new attention for a drawer card', async () => {
  const marks = { manual: async (tracker) => { await scan(tracker, 'idle'); await tracker.markUnread(id); return {}; },
    completion: async (tracker) => { await scan(tracker, 'idle'); await scan(tracker, 'working'); return { completionAtMs: 10 }; },
    native: async () => ({ nativeUnread: true }) };
  for (const [name, mark] of Object.entries(marks)) {
    const tracker = new PendingTracker(false);
    const extra = await mark(tracker);
    const unread = await scan(tracker, 'idle', extra);
    assert.deepEqual(view(unread), [false, true, true], name);
    await tracker.setDrawer(unread, true);
    const working = await scan(tracker, 'working', extra);
    assert.deepEqual([working.drawer, working.unread], [true, false], name);
    await tracker.setDiscard(working, true);
    const ended = await scan(tracker, 'idle', { ...extra, completionAtMs: 30 });
    assert.deepEqual(view(ended), name === 'manual' ? [true, false, false] : [false, false, false], name);
    assert.deepEqual(view(await scan(tracker, 'idle', { ...extra, completionAtMs: 30 })), view(ended), name);
  }
});

test('a drawer card leaves the drawer when its mark is gone in the original app', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const native = new PendingTracker(statePath);
  await native.setDrawer(await scan(native, 'idle', { nativeUnread: true }), true);
  assert.deepEqual(view(await scan(native, 'idle', { nativeUnread: true })), [true, false, false]);
  assert.deepEqual(view(await scan(native, 'idle', { nativeUnread: false })), [false, false, false]);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).records[id].drawer, 0);

  for (const persistent of [false, true]) {
    const tracker = new PendingTracker(false);
    if (persistent) await tracker.setPersistentUnread(true, { threads: [] });
    await drawn(tracker);
    const read = await scan(tracker, 'idle', { completionAtMs: 10, nativeUnread: false });
    assert.deepEqual([view(read), read.retainedUnread], persistent ? [[true, false, false], true] : [[false, false, false], false], String(persistent));
    assert.equal(tracker.records[id].drawer, persistent ? 1 : 0);
  }
});

test('Read and Unread take a card out of the drawer', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const { tracker, row } = await drawn(new PendingTracker(statePath));
  await tracker.acknowledge(id); tracker.apply(row);
  assert.deepEqual(view(row), [false, false, false]);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).records[id].drawer, 0);
  assert.deepEqual(view(await scan(tracker, 'idle', { completionAtMs: 10 })), [false, false, false]);

  const manual = await drawn();
  await manual.tracker.markUnread(id); manual.tracker.apply(manual.row);
  assert.deepEqual([view(manual.row), manual.row.manualUnread], [[false, true, true], true]);
  assert.equal(manual.tracker.records[id].drawer, 0);
});

test('the drawer takes only a card with an unread dot', async () => {
  const tracker = new PendingTracker(false);
  await refused(tracker, { id: 'absent', unread: true }, true);
  const read = await scan(tracker, 'idle');
  assert.equal(read.unread, false);
  await refused(tracker, read, true);
  await refused(tracker, read, false);
  await tracker.markUnread(id);
  const working = await scan(tracker, 'working');
  assert.deepEqual([working.manualUnread, working.unread], [true, false]);
  await refused(tracker, working, true);
  const question = await scan(tracker, 'waiting', { questionPending: true });
  assert.deepEqual([question.unread, question.questionAttention], [true, true]);
  await refused(tracker, question, true);
  await tracker.acknowledge(id); await tracker.markUnread(id);
  const action = await scan(tracker, 'waiting', { questionPending: false });
  assert.deepEqual([action.unread, action.actionRequired], [true, true]);
  await refused(tracker, action, true);
  const unread = await scan(tracker, 'idle');
  await tracker.setDrawer(unread, true);
  await refused(tracker, unread, true);
  assert.deepEqual([tracker.records[id].drawer, view(unread)], [1, [true, false, false]]);
});

async function serve(t, tracker) {
  const server = createSwitchboardServer({ pendingTracker: tracker, openThread: async () => ({ opened: true }),
    loadDashboard: async () => ({ providers: [], threads: [{ id, provider: 'codex', state: 'idle', nativeUnread: null, completionAtMs: 200,
      canOpen: true, appDeepLink: `codex://threads/${id}` }] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (action, body = '{}', headers = {}, thread = id) => fetch(`${base}/api/threads/${thread}/${action}`,
    { method: 'POST', headers: { Origin: base, ...headers }, body });
  return { base, post, row: async () => (await (await fetch(`${base}/api/dashboard`)).json()).threads[0] };
}
async function workingTracker() {
  const tracker = new PendingTracker(false);
  await tracker.observe(plain('working'));
  return tracker;
}

test('drawer-in and drawer-out are local session actions', async (t) => {
  const { post, row } = await serve(t, await workingTracker());
  assert.deepEqual(view(await row()), [false, true, true]);
  const reply = async (response) => [response.status, await response.json()];
  for (const action of ['drawer-in', 'drawer-out']) {
    assert.equal((await post(action, '{"enabled":true}')).status, 400, action);
    assert.equal((await post(action, '[]')).status, 400, action);
    assert.deepEqual(await reply(await post(action, '{}', {}, 'missing')), await reply(await post('mark-read', '{}', {}, 'missing')), action);
    assert.equal((await post(action, '{}', {}, 'missing')).status, 404, action);
    for (const headers of [{ Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.deepEqual(await reply(await post(action, '{}', headers)), await reply(await post('mark-read', '{}', headers)), action);
      assert.equal((await post(action, '{}', headers)).status, 403, action);
    }
  }
  assert.deepEqual(view(await row()), [false, true, true]);
  assert.deepEqual(await reply(await post('drawer-out')), [400, { error: 'Cannot update this ASB session.' }]);
  for (const action of ['drawer-in', 'mark-read', 'mark-unread', 'pin', 'discard-result']) {
    assert.deepEqual(await reply(await post(action, '{}', {}, '%E0%A4%A')), [400, { error: 'Invalid ASB session action.' }], action);
  }
  assert.deepEqual(view(await row()), [false, true, true]);

  const put = await (await post('drawer-in')).json();
  assert.deepEqual([put.changed, put.threadId, view(put.thread), put.thread.completionAttention], [true, id, [true, false, false], true]);
  assert.deepEqual(view(await row()), [true, false, false]);
  assert.equal((await post('drawer-in')).status, 400);
  const out = await (await post('drawer-out')).json();
  assert.deepEqual([out.changed, out.threadId, view(out.thread)], [true, id, [false, true, true]]);
  assert.deepEqual(view(await row()), [false, true, true]);

  await post('drawer-in');
  assert.deepEqual(view((await (await post('mark-read')).json()).thread), [false, false, false]);
  await post('mark-unread'); await post('drawer-in');
  assert.deepEqual(view(await row()), [true, false, false]);
  assert.deepEqual(view((await (await post('mark-unread')).json()).thread), [false, true, true]);
});

test('a successful drawer-in sends one dashboard event with the reason asb-drawer', async (t) => {
  const { base, post, row } = await serve(t, await workingTracker());
  await row();
  let text = '';
  const request = http.get(`${base}/api/events`, (response) => response.on('data', (chunk) => { text += chunk; }));
  request.on('error', () => {});
  t.after(() => request.destroy());
  const until = async (done) => { for (let tries = 0; tries < 200 && !done(); tries += 1) await delay(10); assert.ok(done()); };
  const dashboardEvents = () => [...text.matchAll(/event: dashboard\ndata: (.*)\n/g)].map((match) => JSON.parse(match[1]).reason);
  await until(() => text.includes('event: connected'));
  assert.equal((await post('drawer-in', '{"a":1}')).status, 400);
  assert.equal((await post('drawer-out')).status, 400);
  assert.equal((await post('drawer-in')).status, 200);
  await until(() => dashboardEvents().length > 0);
  await delay(50);
  assert.deepEqual(dashboardEvents(), ['asb-drawer']);
  assert.equal((await post('drawer-out')).status, 200);
  await until(() => dashboardEvents().length > 1);
  assert.deepEqual(dashboardEvents(), ['asb-drawer', 'asb-drawer']);
});

test('a successful open takes a card out of the drawer only when Persistent unread is off', async (t) => {
  for (const persistent of [false, true]) {
    const tracker = await workingTracker();
    const { post, row } = await serve(t, tracker);
    if (persistent) await tracker.setPersistentUnread(true, { threads: [await row()] });
    assert.equal((await post('drawer-in')).status, 200);
    assert.equal((await post('open')).status, 200);
    assert.deepEqual(view(await row()), persistent ? [true, false, false] : [false, false, false], String(persistent));
    assert.equal(tracker.records[id].drawer, persistent ? 1 : 0);
  }
});

test('a state file from 1.5.0 loads with no warning and keeps its marks, pins, and Discard', async (t) => {
  const statePath = path.join(await temp(t), 'pending.json');
  const record = { seen: 10, working: 0, pending: 0, ack: 0, manual: 0, retained: '', pendingKind: '', questionSeen: 0, questionAck: 0,
    nativeAt: 0, nativeAck: 0, nativeSeen: 0, discard: 0, discardedAt: 0, discardStart: 0, discardEnd: 0, discardNative: 0 };
  await writeFile(statePath, JSON.stringify({ version: 1, persistentUnread: false, pinnedOrder: ['done', 'manual'], records: {
    done: { ...record, pending: 10 }, manual: { ...record, manual: 1 }, armed: { ...record, working: 1, discard: 1, discardEnd: 10 }, read: record } }));
  const tracker = new PendingTracker(statePath);
  const thread = (name, state) => ({ id: name, state, nativeUnread: null, completionAtMs: 10 });
  const dashboard = await tracker.observe({ providers: [], threads: [thread('done', 'idle'), thread('manual', 'idle'),
    thread('armed', 'working'), thread('read', 'idle')] });
  assert.equal(stateWarning(dashboard), undefined);
  assert.deepEqual(dashboard.pinnedOrder, ['done', 'manual']);
  assert.deepEqual(dashboard.threads.map((row) => [row.id, row.unread, row.pending, row.drawer, row.pinned, row.discardResult, row.pendingSource]), [
    ['done', true, true, false, true, false, 'observed-completion'], ['manual', true, true, false, true, false, 'manual-unread'],
    ['armed', false, false, false, false, true, ''], ['read', false, false, false, false, false, '']]);
  for (const stored of Object.values(tracker.records)) assert.deepEqual([stored.drawer, stored.drawerSeen], [0, 0]);
  await assert.rejects(readFile(`${statePath}.bad`), { code: 'ENOENT' });
});
