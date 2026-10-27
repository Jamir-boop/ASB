import test from 'node:test';
import assert from 'node:assert/strict';
import { panelSummary } from '../src/asb-server.mjs';

const machines = [{ machineId: 'alpha', name: 'Alpha', self: true, online: true },
  { machineId: 'bravo', name: 'Bravo', self: false, online: false }];

const freeze = (value) => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};

test('panel summary excludes archives, counts all rows, and assigns machine indexes without exposing IDs', () => {
  const dashboard = freeze({ threads: [
    { id: 'a', machineId: 'bravo', pending: true, state: 'working', remote: true },
    { id: 'b', machineId: 'unknown', pending: true, state: 'idle' },
    { id: 'c', machineId: 'unknown', remote: true, state: 'working' },
    { id: 'd', machineId: 'alpha', pending: 'true', state: 'idle', archived: false },
    { id: 'e', machineId: 'bravo', pending: true, state: 'working', archived: true },
    { id: 'f', machineId: 'alpha', pending: true, state: 'working', archived: 'true' },
  ] });
  const summary = panelSummary(dashboard, freeze(structuredClone(machines)));
  assert.deepEqual([summary.needs, summary.working, summary.total], [3, 3, 5]);
  assert.deepEqual(summary.needsRows.map(({ id, machine }) => [id, machine]), [['a', 1], ['b', 0], ['f', 0]]);
  assert.deepEqual(summary.workingRows.map(({ id, machine }) => [id, machine]), [['a', 1], ['c', -1], ['f', 0]]);
  assert.deepEqual(summary.machines, [
    { name: 'Alpha', self: true, online: true, total: 3, needs: 2, working: 1 },
    { name: 'Bravo', self: false, online: false, total: 1, needs: 1, working: 1 },
  ]);
  assert.equal(JSON.stringify(summary).includes('machineId'), false);
});

test('panel lists sort by floored time then plain string ID and stop at six without reducing counts', () => {
  const threads = ['g', 'f', 'e', 'd', 'c', 'a', 'B'].map((id) => ({ id, pending: true, state: 'working', updatedAtMs: 10.9 }));
  threads[0].updatedAtMs = 20.1;
  threads[1].updatedAtMs = 15;
  const summary = panelSummary({ threads }, machines);
  assert.deepEqual([summary.needs, summary.working, summary.total], [7, 7, 7]);
  for (const rows of [summary.needsRows, summary.workingRows]) {
    assert.deepEqual(rows.map(({ id, atMs }) => [id, atMs]), [['g', 20], ['f', 15], ['B', 10], ['a', 10], ['c', 10], ['d', 10]]);
  }
});

test('working rows use the working start time or the validated update time', () => {
  const threads = [
    { id: 'a', workingSinceMs: 31.9, updatedAtMs: 90 },
    { id: 'b', workingSinceMs: 0, updatedAtMs: 21.9 },
    { id: 'c', updatedAtMs: 11.9 },
    { id: 'd', workingSinceMs: Infinity, updatedAtMs: '10' },
    { id: 'e', workingSinceMs: -1, updatedAtMs: -1 },
    { id: 'f', workingSinceMs: '99', updatedAtMs: NaN },
  ].map((row) => ({ ...row, pending: true, state: 'working' }));
  const summary = panelSummary({ threads }, machines);
  assert.deepEqual(summary.workingRows.map(({ id, atMs }) => [id, atMs]), [['a', 31], ['b', 21], ['c', 11], ['d', 0], ['e', 0], ['f', 0]]);
  assert.equal(summary.needsRows.find((row) => row.id === 'a').atMs, 90);
  for (const updatedAtMs of [undefined, Infinity, -Infinity, NaN, -1, '12', null]) {
    assert.equal(panelSummary({ threads: [{ id: 'a', pending: true, updatedAtMs }] }, machines).needsRows[0].atMs, 0);
  }
});

test('panel kinds prefer approval and question over the failed flag', () => {
  const threads = [
    { id: 'a', pendingSource: 'user-action', alert: true },
    { id: 'b', pendingSource: 'user-question', alert: true },
    { id: 'c', alert: true },
    { id: 'd', alert: 'true' },
    { id: 'e', pendingSource: 'user-question' },
  ].map((row) => ({ ...row, pending: true, state: 'working' }));
  const summary = panelSummary({ threads }, machines);
  assert.deepEqual(summary.needsRows.map((row) => row.kind), ['approval', 'question', 'failed', 'done', 'question']);
  assert.deepEqual(summary.workingRows.map((row) => row.id), summary.needsRows.map((row) => row.id));
  assert.ok(summary.workingRows.every((row) => !Object.hasOwn(row, 'kind')));
});

test('panel row text fallbacks and canOpen use exact types', () => {
  const threads = [
    { id: 1, title: 'Alpha', projectName: 'ignored', sourceLabel: 'App', providerLabel: 'ignored', provider: 'bravo', canOpen: true },
    { id: 2, title: '', projectName: 'Bravo', sourceLabel: 1, providerLabel: 'Provider', provider: '', canOpen: 1 },
    { id: 3, title: false, projectName: '', sourceLabel: '', providerLabel: false, provider: null, canOpen: 'true' },
  ].map((row) => ({ ...row, pending: true, updatedAtMs: '99' }));
  assert.deepEqual(panelSummary({ threads }, machines).needsRows, [
    { id: '1', title: 'Alpha', app: 'App', provider: 'bravo', kind: 'done', machine: 0, atMs: 0, canOpen: true },
    { id: '2', title: 'Bravo', app: 'Provider', provider: 'codex', kind: 'done', machine: 0, atMs: 0, canOpen: false },
    { id: '3', title: 'Untitled session', app: '', provider: 'codex', kind: 'done', machine: 0, atMs: 0, canOpen: false },
  ]);
});

test('missing or invalid threads give empty lists and machines with normalized values and zero counts', () => {
  for (const threads of [undefined, null, {}, 'alpha']) {
    const summary = panelSummary({ threads }, [{ machineId: 'alpha', name: 42, self: 1, online: 'true' }, { machineId: 'bravo' }]);
    assert.deepEqual(summary, { needs: 0, working: 0, total: 0, needsRows: [], workingRows: [], machines: [
      { name: '42', self: false, online: false, total: 0, needs: 0, working: 0 },
      { name: '', self: false, online: false, total: 0, needs: 0, working: 0 },
    ] });
  }
});

test('panel reply and nested objects have exactly the contract keys in order', () => {
  const summary = panelSummary({ threads: [{ id: 'a', title: 'Alpha', sourceLabel: 'App', provider: 'bravo', pending: true,
    state: 'working', updatedAtMs: 12.9, workingSinceMs: 10.9, canOpen: true }] }, machines.slice(0, 1));
  assert.equal(JSON.stringify(summary), '{"needs":1,"working":1,"total":1,"needsRows":[{"id":"a","title":"Alpha","app":"App","provider":"bravo","kind":"done","machine":0,"atMs":12,"canOpen":true}],"workingRows":[{"id":"a","title":"Alpha","app":"App","provider":"bravo","machine":0,"atMs":10,"canOpen":true}],"machines":[{"name":"Alpha","self":true,"online":true,"total":1,"needs":1,"working":1}]}');
});
