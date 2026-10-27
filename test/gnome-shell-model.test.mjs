import assert from 'node:assert/strict';
import test from 'node:test';
import * as model from '../gnome-shell/model.js';
import {runtimeDir} from '../src/platform-paths.mjs';

const row = (extra = {}) => ({id: 'sample/1', title: 'Sample task', app: 'Example', provider: 'codex',
  kind: 'question', machine: 0, atMs: 60000, canOpen: true, ...extra});
const machine = (extra = {}) => ({name: 'alpha', self: true, online: true, total: 8, needs: 1, working: 2, ...extra});
const state = (extra = {}) => ({needs: 1, working: 2, total: 8, needsRows: [row()], workingRows: [row()], machines: [machine()], ...extra});
const runtime = (extra = {}) => JSON.stringify({pid: 123, port: 4567, schema: 1, sourceToken: 'a'.repeat(64), ...extra});
const trust = () => ({dir: {type: 'directory', uid: 1000, mode: 0o700, size: 4096},
  file: {type: 'regular', uid: 1000, mode: 0o600, size: 200}});

test('the model has exactly the contract exports', () => {
  assert.deepEqual(Object.keys(model).sort(), ['MACHINE_HUES', 'machineHue', 'providerIcon', 'runtimePath', 'parseRuntime',
    'runtimeTrusted', 'panelState', 'timeText', 'accessibleName', 'kindMark', 'rowAccessibleName', 'moreText',
    'createEventParser', 'nextFetchDelay', 'contrastInk', 'mixWhite'].sort());
});

test('machine hues repeat in board order and reject non-indices', () => {
  assert.deepEqual(model.MACHINE_HUES, ['#a28caa', '#7cc48a', '#5fb3b3', '#d6a15e', '#e38fb0', '#b4b86c']);
  for (let i = 0; i < 100; i++) assert.equal(model.machineHue(i), model.MACHINE_HUES[i % 6]);
  for (const value of [-1, 0.5, '1', undefined, null, NaN, Infinity]) assert.equal(model.machineHue(value), null);
});

test('provider icons follow the board fallback', () => {
  assert.equal(model.providerIcon('codex'), 'asb-openai-symbolic.svg');
  assert.equal(model.providerIcon('opencode'), 'asb-opencode-symbolic.svg');
  for (const value of ['claude-desktop-code', 'other', '', null]) assert.equal(model.providerIcon(value), 'asb-claude-symbolic.svg');
});

test('runtime paths match the Linux engine including relative XDG values', () => {
  for (const env of [{}, {XDG_RUNTIME_DIR: '/run/user/1000'}, {XDG_RUNTIME_DIR: '/run/user/1000/'},
    {XDG_RUNTIME_DIR: 'relative', XDG_STATE_HOME: '/state'}, {XDG_RUNTIME_DIR: '', XDG_STATE_HOME: 'relative'},
    {XDG_RUNTIME_DIR: '/'}, {XDG_STATE_HOME: '/state/../saved//'}]) {
    assert.equal(model.runtimePath(env, '/home/example'), `${runtimeDir(env, 'linux', '/home/example')}/service.json`);
  }
});

test('runtime parser accepts only exact schema, bounds, and lowercase token', () => {
  assert.deepEqual(model.parseRuntime(runtime()), {pid: 123, port: 4567, token: 'a'.repeat(64)});
  for (const extra of [{pid: 1, port: 1}, {pid: 2147483647, port: 65535}]) assert.ok(model.parseRuntime(runtime(extra)));
  for (const text of ['', '{', 'null', '[]', '1', '"value"', '{}', runtime({extra: true}),
    JSON.stringify({pid: 1, port: 2, schema: 1})]) assert.equal(model.parseRuntime(text), null);
  for (const [key, values] of Object.entries({pid: [0, -1, 2147483648, 1.5, '1', null], port: [0, -1, 65536, 2.5, '2', null],
    schema: [0, 2, '1', null], sourceToken: ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 123, null]})) {
    for (const value of values) assert.equal(model.parseRuntime(runtime({[key]: value})), null, `${key}: ${value}`);
  }
});

test('runtime trust checks type, owner, exact modes, and file size', () => {
  assert.equal(model.runtimeTrusted(trust(), 1000), true);
  const fullMode = trust(); fullMode.file.mode |= 0o100000; fullMode.dir.mode |= 0o40000;
  assert.equal(model.runtimeTrusted(fullMode, 1000), true);
  for (const key of ['dir', 'file']) {
    for (const extra of [{type: 'symlink'}, {type: key === 'dir' ? 'regular' : 'directory'}, {type: 'fifo'},
      {uid: 1001}, {mode: 0o777}, {mode: 0}, {mode: '0700'}, {mode: key === 'dir' ? 0o1700 : 0o1600}]) {
      const value = trust(); Object.assign(value[key], extra);
      assert.equal(model.runtimeTrusted(value, 1000), false);
    }
  }
  for (const size of [0, 4096]) { const value = trust(); value.file.size = size; assert.equal(model.runtimeTrusted(value, 1000), true); }
  for (const size of [-1, 4097, 0.5, '200', Infinity]) { const value = trust(); value.file.size = size; assert.equal(model.runtimeTrusted(value, 1000), false); }
  assert.equal(model.runtimeTrusted({dir: null, file: null}, 1000), false);
  assert.equal(model.runtimeTrusted(trust(), -1), false);
});

test('panel validates counts, array shapes, and every machine', () => {
  assert.equal(model.panelState(null), null);
  for (const key of ['needs', 'working', 'total']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])
      assert.equal(model.panelState(state({[key]: value})), null);
    assert.ok(model.panelState(state({[key]: Number.MAX_SAFE_INTEGER})));
  }
  for (const key of ['needsRows', 'workingRows', 'machines']) {
    for (const value of [null, {}, 'array', undefined]) assert.equal(model.panelState(state({[key]: value})), null);
  }
  assert.equal(model.panelState(state({machines: []})), null);
  assert.ok(model.panelState(state({machines: Array.from({length: 64}, () => machine())})));
  assert.equal(model.panelState(state({machines: Array.from({length: 65}, () => machine())})), null);
  for (const extra of [{name: 1}, {self: 1}, {online: 'yes'}, {total: -1}, {needs: 0.5}, {working: Number.MAX_SAFE_INTEGER + 1}])
    assert.equal(model.panelState(state({machines: [machine(), machine(extra)]})), null);
  assert.equal(model.panelState(state({machines: [null]})), null);
});

test('panel drops invalid rows, caps lists, sanitizes indices, and strips unknown keys', () => {
  const bad = [null, ...[{id: ''}, {id: 'x'.repeat(513)}, {id: 1}, {title: null}, {app: 1}, {provider: {}},
    {machine: -2}, {machine: 0.5}, {machine: '0'}, {atMs: -1}, {atMs: 1.5}, {atMs: Infinity},
    {atMs: Number.MAX_SAFE_INTEGER + 1}, {canOpen: 1}, {canOpen: undefined}].map(extra => row(extra))];
  const value = model.panelState(state({needsRows: [...bad, row({extra: 'strip'})], workingRows: [...bad, row({kind: 'bad'})], extra: 'strip'}));
  assert.equal(value.needsRows.length, 1);
  assert.equal(value.workingRows.length, 1);
  assert.equal('extra' in value.needsRows[0], false);
  assert.equal('kind' in value.workingRows[0], false);
  assert.equal('extra' in value, false);
  assert.equal(value.accent, '');
  for (const kind of ['approval', 'question', 'failed', 'done']) assert.equal(model.panelState(state({needsRows: [row({kind})]})).needsRows[0].kind, kind);
  for (const kind of ['', null, 'other', undefined]) assert.deepEqual(model.panelState(state({needsRows: [row({kind})]})).needsRows, []);
  for (const machineIndex of [-1, 1, 900]) assert.equal(model.panelState(state({needsRows: [row({machine: machineIndex})]})).needsRows[0].machine, -1);
  assert.equal(model.panelState(state({needsRows: [row({id: 'x'.repeat(512)})]})).needsRows.length, 1);
  const many = Array.from({length: 8}, (_, i) => row({id: String(i)}));
  const limited = model.panelState(state({needsRows: many, workingRows: many}));
  for (const list of [limited.needsRows, limited.workingRows]) assert.deepEqual(list.map(r => r.id), ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(Object.keys(limited.machines[0]), ['name', 'self', 'online', 'total', 'needs', 'working']);
});

test('panel keeps only a valid lowercase board accent', () => {
  for (const accent of ['#ffb900', '#000000', '#abcdef', '#ffffff']) assert.equal(model.panelState(state({accent})).accent, accent);
  for (const accent of ['', '#FFB900', '#fff', '#abcdef0', 'red', ' #abcdef', 123, null, undefined, {}])
    assert.equal(model.panelState(state({accent})).accent, '');
});

test('time labels cover boundaries and future dates', () => {
  for (const [minutes, expected] of [[-1, 'now'], [0, 'now'], [0.99, 'now'], [1, '1m'], [59, '59m'], [60, '1h'],
    [119, '1h'], [1439, '23h'], [1440, '1d'], [2880, '2d']]) assert.equal(model.timeText(60000, 60000 + minutes * 60000), expected);
});

test('accessible names include singulars and omit empty or solo machine parts', () => {
  assert.equal(model.accessibleName(null), 'ASB is not running');
  assert.equal(model.accessibleName(state()), 'ASB: 1 needs you, 2 working, 8 sessions');
  assert.equal(model.accessibleName(state({needs: 0, total: 1})), 'ASB: 0 need you, 2 working, 1 session');
  assert.equal(model.accessibleName(state({needs: 3})), 'ASB: 3 need you, 2 working, 8 sessions');
  const machines = [machine(), machine({name: 'bravo'})];
  assert.equal(model.rowAccessibleName(row(), machines, 120000, 'question'), 'Sample task, Example, alpha, question, 1m');
  assert.equal(model.rowAccessibleName(row(), machines.slice(0, 1), 60000, 'working'), 'Sample task, Example, working, now');
  assert.equal(model.rowAccessibleName(row({title: '', app: '', machine: -1}), machines, 60000, ''), 'now');
});

test('kind marks and more labels', () => {
  for (const kind of ['approval', 'question']) assert.equal(model.kindMark(kind), '?');
  assert.equal(model.kindMark('failed'), '!'); assert.equal(model.kindMark('done'), 'dot');
  assert.equal(model.moreText(9, 6), '3 more'); assert.equal(model.moreText(6, 6), null); assert.equal(model.moreText(0, 6), null);
});

test('event parser handles fields, comments, multiline data, resets, and line limits', () => {
  const parser = model.createEventParser();
  for (const line of [': comment', 'unknown: value', 'event: connected', 'data: one', 'data:  two']) assert.equal(parser.push(line), null);
  assert.deepEqual(parser.push(''), {event: 'connected', data: 'one\n two'});
  assert.equal(parser.push(''), null);
  parser.push('event: unused'); assert.equal(parser.push(''), null);
  parser.push('data:'); assert.deepEqual(parser.push(''), {event: '', data: ''});
  parser.push('data'); assert.deepEqual(parser.push(''), {event: '', data: ''});
  parser.push('event: first'); parser.push('event:dashboard'); parser.push('data:{}');
  assert.deepEqual(parser.push(''), {event: 'dashboard', data: '{}'});
  assert.equal(parser.push('x'.repeat(4096)), null);
  assert.throws(() => parser.push('x'.repeat(4097)), {message: 'The ASB event is too large.'});
});

test('fetch delay enforces default and explicit minimum gaps', () => {
  assert.equal(model.nextFetchDelay(1000, 1000), 1000);
  assert.equal(model.nextFetchDelay(1000, 1700), 300);
  assert.equal(model.nextFetchDelay(1000, 2000), 0);
  assert.equal(model.nextFetchDelay(1000, 3000), 0);
  assert.equal(model.nextFetchDelay(1000, 1100, 250), 150);
});

test('accent ink follows WCAG and white mixing rounds each channel', () => {
  for (const [hex, ink] of [['#ffb900', '#000000'], ['#ffffff', '#000000'], ['#000000', '#ffffff'],
    ['#0000ff', '#ffffff'], ['#777777', '#000000'], ['#767676', '#000000'], ['#757575', '#ffffff']]) assert.equal(model.contrastInk(hex), ink);
  assert.equal(model.mixWhite('#ffb900', 0.3), '#ffce4d');
  assert.equal(model.mixWhite('#123456', 0), '#123456');
  assert.equal(model.mixWhite('#123456', 1), '#ffffff');
  assert.equal(model.mixWhite('#000000', 0.5), '#808080');
  assert.equal(model.mixWhite('#ffffff', 0.3), '#ffffff');
});
