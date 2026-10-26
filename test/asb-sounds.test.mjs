import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { BIT_DONE, BIT_FAILED, BIT_INPUT, SOUND_DIR, WINDOWS_PLAYER_ARGS, createSoundPlayer, createSoundWatcher, soundBaseline, soundBits, soundEvents } from '../src/asb-sounds.mjs';
import { mergePeerRows } from '../src/machine-peers.mjs';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

const now = Date.parse('2026-10-07T14:00:00Z');
const row = (fields = {}) => ({ id: 'a', ...fields });
const kinds = (events) => events.map((event) => [event.row.id, event.kind]);

test('sound bits follow the phone rules', () => {
  assert.equal(soundBits(row({ completionAttention: true })), BIT_DONE);
  assert.equal(soundBits(row({ failedAttention: true })), BIT_FAILED);
  assert.equal(soundBits(row({ questionAttention: true })), BIT_INPUT);
  assert.equal(soundBits(row({ actionRequired: true, actionAttention: true })), BIT_INPUT);
  // A read approval keeps its required action but plays nothing.
  assert.equal(soundBits(row({ actionRequired: true, actionAttention: false })), 0);
  assert.equal(soundBits(row({ archived: true, completionAttention: true, actionAttention: true })), 0);
  assert.equal(soundBits(row({ nativeAttention: true, state: 'idle' })), BIT_DONE);
  assert.equal(soundBits(row({ nativeAttention: true, state: 'working' })), 0);
  assert.equal(soundBits(row({ nativeAttention: true, state: 'idle', lastOutcome: 'failed' })), BIT_FAILED);
});

test('a row missing from one update keeps its baseline bits', () => {
  const done = [row({ completionAttention: true }), row({ id: 'b' })];
  const skipped = soundBaseline(soundBaseline(null, done, now), [row({ id: 'b' })], now);
  assert.equal(skipped.get('a'), BIT_DONE);
  assert.deepEqual(soundEvents(skipped, done, now), []);
});

test('sound events need a baseline and fire only newly set bits', () => {
  const done = [row({ completionAttention: true })];
  assert.deepEqual(soundEvents(null, done, now), []);
  assert.deepEqual(kinds(soundEvents(new Map(), done, now)), [['a', BIT_DONE]]);
  assert.deepEqual(soundEvents(soundBaseline(null, done, now), done, now), []);
  const both = [row({ completionAttention: true, actionAttention: true }), row({ id: 'b', failedAttention: true })];
  assert.deepEqual(kinds(soundEvents(soundBaseline(null, done, now), both, now)), [['a', BIT_INPUT], ['b', BIT_FAILED]]);
  assert.deepEqual(soundEvents(new Map(), [row({ archived: true, completionAttention: true })], now), []);
});

test('a usage-limit stop plays Failed once and the reset plays nothing', () => {
  const limit = now + 60_000;
  const stopped = [row({ state: 'idle', lastOutcome: 'limit', failedAttention: true, limitResetsAtMs: limit })];
  const baseline = soundBaseline(null, [row({ state: 'working' })], now);
  assert.deepEqual(kinds(soundEvents(baseline, stopped, now)), [['a', BIT_FAILED]]);
  const during = soundBaseline(baseline, stopped, now);
  assert.deepEqual(soundEvents(during, stopped, now + 1), []);
  assert.deepEqual(soundEvents(during, [{ ...stopped[0], limitResetsAtMs: 0 }], limit), []);
  assert.equal(soundBits(row({ state: 'idle', lastOutcome: 'limit', nativeAttention: true })), BIT_FAILED);
  assert.deepEqual(kinds(soundEvents(new Map(), [row({ actionAttention: true, limitResetsAtMs: limit })], now)), [['a', BIT_INPUT]]);
});

test('the watcher plays one sound per update with Needs input first and the first update silent', () => {
  const played = [];
  const watch = createSoundWatcher((kind) => played.push(kind));
  watch({ threads: [row({ completionAttention: true })] }, now);
  assert.deepEqual(played, []);
  watch({ threads: [row({ completionAttention: true }), row({ id: 'b', failedAttention: true }), row({ id: 'c', questionAttention: true })] }, now);
  assert.deepEqual(played, [BIT_INPUT]);
  watch({ threads: [row({ completionAttention: true }), row({ id: 'b', failedAttention: true }), row({ id: 'c', questionAttention: true }),
    row({ id: 'd', completionAttention: true }), row({ id: 'e', failedAttention: true })] }, now);
  assert.deepEqual(played, [BIT_INPUT, BIT_FAILED]);
  watch({ threads: [row({ id: 'f', completionAttention: true })] }, now);
  assert.deepEqual(played, [BIT_INPUT, BIT_FAILED, BIT_DONE]);
  watch({ threads: [row({ id: 'f', completionAttention: true })] }, now);
  assert.equal(played.length, 3);
});

function fakeSpawn(missing = [], exitCode = 0) {
  const calls = [];
  const spawn = (program, args, options) => {
    calls.push([program, args, options]);
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    if (missing.includes(program)) process.nextTick(() => child.emit('error', Object.assign(new Error(`spawn ${program} ENOENT`), { code: 'ENOENT' })));
    else process.nextTick(() => child.emit('exit', exitCode));
    return child;
  };
  return { calls, spawn };
}

test('the player runs pw-play detached with the ASB name and the phone file for each kind', async () => {
  const { calls, spawn } = fakeSpawn();
  const logs = [];
  const play = createSoundPlayer({ platform: 'linux', spawn, log: (line) => logs.push(line) });
  play(BIT_DONE);
  play(BIT_INPUT);
  play(BIT_FAILED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(([program, args]) => [program, ...args]), ['opencode_staplebops_01.wav', 'opencode_staplebops_02.wav', 'opencode_nope_03.wav']
    .map((file) => ['pw-play', '--media-role', 'Notification', '-P', '{ application.name = "ASB" }', `${SOUND_DIR}${file}`]));
  assert.deepEqual(calls[0][2], { detached: true, stdio: 'ignore' });
  assert.deepEqual(logs, []);
});

test('the player falls back to paplay and reports one line when no player exists', async () => {
  const fallback = fakeSpawn(['pw-play']);
  const play = createSoundPlayer({ platform: 'linux', spawn: fallback.spawn, log: () => assert.fail('paplay works') });
  play(BIT_DONE);
  await new Promise((resolve) => setImmediate(resolve));
  play(BIT_FAILED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fallback.calls.map(([program, args]) => [program, ...args]), [
    ['pw-play', '--media-role', 'Notification', '-P', '{ application.name = "ASB" }', `${SOUND_DIR}opencode_staplebops_01.wav`],
    ['paplay', '--client-name=ASB', '--property=media.role=event', `${SOUND_DIR}opencode_staplebops_01.wav`],
    ['paplay', '--client-name=ASB', '--property=media.role=event', `${SOUND_DIR}opencode_nope_03.wav`],
  ]);
  const none = fakeSpawn(['pw-play', 'paplay', 'aplay']);
  const logs = [];
  const silent = createSoundPlayer({ platform: 'linux', spawn: none.spawn, log: (line) => logs.push(line) });
  silent(BIT_DONE);
  await new Promise((resolve) => setImmediate(resolve));
  silent(BIT_INPUT);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(none.calls.length, 3);
  assert.deepEqual(logs, ['ASB cannot play sounds: install pw-play (PipeWire), paplay (PulseAudio), or aplay (ALSA). Run asb doctor for the command.']);
  const throwing = createSoundPlayer({ platform: 'linux', spawn: () => { throw new Error('Synthetic spawn failure'); }, log: (line) => logs.push(line) });
  assert.doesNotThrow(() => { throwing(BIT_DONE); throwing(BIT_DONE); });
  assert.deepEqual(logs.slice(1), ['ASB cannot play a sound with pw-play: Synthetic spawn failure']);
});

test('the player tries pw-play, then paplay, then aplay, and keeps aplay for later sounds', async () => {
  const { calls, spawn } = fakeSpawn(['pw-play', 'paplay']);
  const play = createSoundPlayer({ platform: 'linux', spawn, log: () => assert.fail('aplay works') });
  play(BIT_DONE);
  await new Promise((resolve) => setImmediate(resolve));
  play(BIT_FAILED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(([program, args]) => [program, ...args]), [
    ['pw-play', '--media-role', 'Notification', '-P', '{ application.name = "ASB" }', `${SOUND_DIR}opencode_staplebops_01.wav`],
    ['paplay', '--client-name=ASB', '--property=media.role=event', `${SOUND_DIR}opencode_staplebops_01.wav`],
    ['aplay', '-q', `${SOUND_DIR}opencode_staplebops_01.wav`],
    ['aplay', '-q', `${SOUND_DIR}opencode_nope_03.wav`],
  ]);
  assert.deepEqual(calls[2][2], { detached: true, stdio: 'ignore' });
});

// A fake powershell.exe: a child whose stdin records the writes.
function fakePowerShell() {
  const calls = [];
  const children = [];
  const spawn = (program, args, options) => {
    calls.push([program, args, options]);
    const child = Object.assign(new EventEmitter(), { unref() { this.unrefed = true; } });
    child.stdin = Object.assign(new EventEmitter(), { written: [], ended: false, unref() { this.unrefed = true; },
      write(text) { this.written.push(text); return true; }, end() { this.ended = true; } });
    children.push(child);
    return child;
  };
  return { calls, children, spawn };
}

const winDir = 'C:\\asb\\assets\\sounds\\';
const winLine = (file) => `${winDir}${file}\n`;
const DONE_LINE = winLine('opencode_staplebops_01.wav');

test('the win32 player keeps one hidden powershell.exe and sends it each path on stdin, never in the arguments', () => {
  const { calls, children, spawn } = fakePowerShell();
  const logs = [];
  const play = createSoundPlayer({ platform: 'win32', spawn, log: (line) => logs.push(line), dir: winDir });
  play(BIT_DONE);
  play(BIT_INPUT);
  play(BIT_FAILED);
  play(BIT_DONE);
  assert.equal(calls.length, 1);
  const [program, args, options] = calls[0];
  assert.equal(program, 'powershell.exe');
  assert.deepEqual(args, WINDOWS_PLAYER_ARGS);
  assert.deepEqual([args.length, ...args.slice(0, 3)], [4, '-NoProfile', '-NonInteractive', '-Command']);
  assert.doesNotMatch(args.join(' '), /\.wav|asb|sounds/i);
  // Hidden, not detached (a detached child on Windows gets its own console), no shell, no path in the environment, stdin is a pipe.
  assert.deepEqual(options, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  assert.deepEqual(children[0].stdin.written,
    [DONE_LINE, winLine('opencode_staplebops_02.wav'), winLine('opencode_nope_03.wav'), DONE_LINE]);
  // The engine can exit at once: the child and its stdin pipe do not keep it alive.
  assert.equal(children[0].unrefed && children[0].stdin.unrefed, true);
  assert.deepEqual(logs, []);
});

test('the win32 player closes its process after 5 minutes with no sound, and the next sound starts a new one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, children, spawn } = fakePowerShell();
  const play = createSoundPlayer({ platform: 'win32', spawn, log: () => assert.fail('no failure'), dir: winDir });
  play(BIT_DONE);
  t.mock.timers.tick(299_000);
  play(BIT_DONE);
  // The second sound restarts the idle time.
  t.mock.timers.tick(299_000);
  assert.equal(children[0].stdin.ended, false);
  t.mock.timers.tick(1_000);
  assert.equal(children[0].stdin.ended, true);
  assert.equal(calls.length, 1);
  play(BIT_FAILED);
  assert.equal(calls.length, 2);
  assert.deepEqual(children[1].stdin.written, [winLine('opencode_nope_03.wav')]);
  // The first process exits late. That must not touch the second one.
  children[0].emit('exit', 0);
  play(BIT_DONE);
  assert.deepEqual([calls.length, children[1].stdin.written.length], [2, 2]);
});

test('the win32 player starts a new process after an exit or a stdin error, and reports a failure once', () => {
  const { calls, children, spawn } = fakePowerShell();
  const logs = [];
  const play = createSoundPlayer({ platform: 'win32', spawn, log: (line) => logs.push(line), dir: winDir });
  play(BIT_DONE);
  children[0].emit('exit', 0);
  play(BIT_DONE);
  assert.deepEqual([calls.length, logs], [2, []]);
  children[1].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  play(BIT_DONE);
  assert.equal(calls.length, 3);
  assert.deepEqual(children[2].stdin.written, [DONE_LINE]);
  children[2].emit('exit', 1);
  children[2].stdin.emit('error', new Error('write EPIPE'));
  play(BIT_DONE);
  children[3].emit('exit', 2);
  assert.deepEqual([calls.length, logs], [4, ['ASB cannot play a sound with powershell.exe: write EPIPE']]);
  const failed = fakePowerShell();
  const codes = [];
  const again = createSoundPlayer({ platform: 'win32', spawn: failed.spawn, log: (line) => codes.push(line), dir: winDir });
  again(BIT_DONE);
  failed.children[0].emit('exit', 1);
  again(BIT_DONE);
  failed.children[1].emit('exit', 1);
  assert.deepEqual(codes, ['ASB cannot play a sound: powershell.exe exited with code 1.']);
});

test('the win32 player reports Windows PowerShell once when it is missing, and a failed spawn never throws', () => {
  const { calls, children, spawn } = fakePowerShell();
  const logs = [];
  const play = createSoundPlayer({ platform: 'win32', spawn, log: (line) => logs.push(line), dir: winDir });
  play(BIT_DONE);
  children[0].emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
  children[0].stdin.emit('error', new Error('Socket is closed'));
  play(BIT_FAILED);
  assert.deepEqual([calls.length, logs], [1, ['ASB cannot play sounds: Windows PowerShell was not found.']]);
  const other = fakePowerShell();
  const texts = [];
  const second = createSoundPlayer({ platform: 'win32', spawn: other.spawn, log: (line) => texts.push(line), dir: winDir });
  second(BIT_DONE);
  other.children[0].emit('error', Object.assign(new Error('spawn powershell.exe EACCES'), { code: 'EACCES' }));
  second(BIT_DONE);
  assert.deepEqual([other.calls.length, texts], [2, ['ASB cannot play a sound with powershell.exe: spawn powershell.exe EACCES']]);
  const throwing = createSoundPlayer({ platform: 'win32', spawn: () => { throw new Error('Synthetic spawn failure'); }, log: (line) => texts.push(line), dir: winDir });
  assert.doesNotThrow(() => { throwing(BIT_DONE); throwing(BIT_DONE); });
  assert.deepEqual(texts.slice(1), ['ASB cannot play a sound with powershell.exe: Synthetic spawn failure']);
});

// These two tests use real child processes, so they check what a fake cannot: the real ENOENT order, and the unref calls.
test('the win32 player reports the missing program of a real failed spawn, not its closed stdin', async () => {
  const logs = [];
  const play = createSoundPlayer({ platform: 'win32', dir: winDir, log: (line) => logs.push(line),
    spawn: (program, args, options) => spawnProcess('asb-missing-program', args, options) });
  play(BIT_DONE);
  play(BIT_DONE);
  await new Promise((resolve) => setTimeout(resolve, 50));
  play(BIT_DONE);
  assert.deepEqual(logs, ['ASB cannot play sounds: Windows PowerShell was not found.']);
});

test('a process that played a Windows sound exits at once while its player waits for more paths', async () => {
  const module = new URL('../src/asb-sounds.mjs', import.meta.url).href;
  const reader = "process.stdin.on('data', () => {}).on('end', () => process.exit(0))";
  const script = `import { spawn } from 'node:child_process';
    import { createSoundPlayer } from ${JSON.stringify(module)};
    const play = createSoundPlayer({ platform: 'win32', dir: '', log: console.error,
      spawn: (program, args, options) => spawn(process.execPath, ['-e', ${JSON.stringify(reader)}], options) });
    play(1);`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
});

test('the switchboard server plays the injected player once after a Working to Idle completion', async (t) => {
  let clock = now;
  let loads = 0;
  const played = [];
  const server = createSwitchboardServer({ now: () => clock, pendingStatePath: false, dashboardWatchPaths: [], playSound: (kind) => played.push(kind),
    loadDashboard: async () => {
      loads += 1;
      return { generatedAtMs: clock, providers: [], threads: [{ id: 'a', state: loads === 1 ? 'working' : 'idle', nativeUnread: null,
        completionAtMs: loads === 1 ? 0 : clock }] };
    } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const scan = () => fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`).then((response) => response.json());
  assert.equal((await scan()).threads[0].state, 'working');
  assert.deepEqual(played, []);
  clock += 2_000;
  assert.equal((await scan()).threads[0].completionAttention, true);
  clock += 2_000;
  await scan();
  assert.ok(loads >= 2);
  assert.deepEqual(played, [BIT_DONE]);
});

test('a muted session plays no Done sound but still plays Failed and Needs input', async () => {
  const thread = (state, extra = {}) => ({ providers: [], threads: [{ id: 'a', state, nativeUnread: null, completionAtMs: 0, ...extra }] });
  const events = async (end) => {
    const tracker = new PendingTracker(false);
    const [first] = (await tracker.observe(thread('idle'))).threads;
    await tracker.setMuted(first, true);
    const baseline = soundBaseline(null, (await tracker.observe(thread('working'))).threads, now);
    return kinds(soundEvents(baseline, (await tracker.observe(end)).threads, now));
  };
  assert.deepEqual(await events(thread('idle', { completionAtMs: 10 })), []);
  assert.deepEqual(await events(thread('idle', { completionAtMs: 10, nativeUnread: true })), []);
  assert.deepEqual(await events(thread('idle', { failedAtMs: 10 })), [['a', BIT_FAILED]]);
  assert.deepEqual(await events(thread('waiting', { questionPending: true })), [['a', BIT_INPUT]]);
});

test('a next-task Discard on an Idle session plays no Done sound but still plays Failed', async () => {
  const thread = (state, extra = {}) => ({ providers: [], threads: [{ id: 'a', state, nativeUnread: null, completionAtMs: 0, ...extra }] });
  const events = async (end, seenWorking) => {
    const tracker = new PendingTracker(false);
    const [first] = (await tracker.observe(thread('idle'))).threads;
    await tracker.setDiscard(first, true, true);
    const baseline = soundBaseline(null, (await tracker.observe(thread(seenWorking ? 'working' : 'idle'))).threads, now);
    return kinds(soundEvents(baseline, (await tracker.observe(end)).threads, now));
  };
  for (const seenWorking of [true, false]) {
    assert.deepEqual(await events(thread('idle', { completionAtMs: 10 }), seenWorking), []);
    assert.deepEqual(await events(thread('idle', { completionAtMs: 10, nativeUnread: true }), seenWorking), []);
    assert.deepEqual(await events(thread('idle', { failedAtMs: 10, lastOutcome: 'failed' }), seenWorking), [['a', BIT_FAILED]]);
  }
});

test('a watcher that cannot play moves its baseline and plays only new events later', () => {
  const played = [];
  let open = false;
  const watch = createSoundWatcher((kind) => played.push(kind), () => open);
  watch({ threads: [] }, now);
  watch({ threads: [row({ completionAttention: true })] }, now);
  assert.deepEqual(played, []);
  open = true;
  watch({ threads: [row({ completionAttention: true })] }, now);
  assert.deepEqual(played, []);
  watch({ threads: [row({ completionAttention: true }), row({ id: 'b', failedAttention: true })] }, now);
  assert.deepEqual(played, [BIT_FAILED]);
});

for (const reported of [false, true]) test(`the engine plays a completion sound only with a reporting window (${reported ? 'window' : 'no window'})`, async (t) => {
  let clock = now;
  let loads = 0;
  const played = [];
  const server = createSwitchboardServer({ serviceMode: true, sourceToken: 'window-token', now: () => clock, pendingStatePath: false,
    dashboardWatchPaths: [], playSound: (kind) => played.push(kind),
    loadDashboard: async () => {
      loads += 1;
      return { generatedAtMs: clock, providers: [], threads: [{ id: 'a', state: loads === 1 ? 'working' : 'idle', nativeUnread: null,
        completionAtMs: loads === 1 ? 0 : clock }] };
    } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = () => fetch(`${base}/api/dashboard`).then((response) => response.json());
  assert.equal((await scan()).threads[0].state, 'working');
  if (reported) {
    const report = { clientId: '123e4567-e89b-12d3-a456-426614174000', sourcesRevision: null, profilesRevision: null, profilesVisible: false, dirty: false };
    const response = await fetch(`${base}/api/agent/ui`, { method: 'POST', body: JSON.stringify(report),
      headers: { origin: base, 'content-type': 'application/json', 'x-asb-source-token': 'window-token' } });
    assert.equal(response.status, 200);
  }
  clock += 2_000;
  assert.equal((await scan()).threads[0].completionAttention, true);
  clock += 2_000;
  await scan();
  assert.ok(loads >= 2);
  assert.deepEqual(played, reported ? [BIT_DONE] : []);
});

test('the first rows of a member machine are its baseline; its later rows play', () => {
  const played = [];
  const watch = createSoundWatcher((kind) => played.push(kind));
  const own = row({ id: 'own' });
  const member = { id: 'm:b:1', remote: true, machineId: 'b', completionAttention: true };
  watch({ threads: [own] }, now);
  watch({ threads: [own, member] }, now);
  assert.deepEqual(played, []);
  watch({ threads: [own, member, { id: 'm:b:2', remote: true, machineId: 'b', questionAttention: true }] }, now);
  assert.deepEqual(played, [BIT_INPUT]);
});

// One member row through the real merge, the tracker, and the sounds of the server. `at` sets the state of the member and its poller.
async function memberServer(t) {
  let clock = now;
  const played = [];
  const peer = { member: { machineId: 'b'.repeat(16), name: 'engine-b', certFingerprint: 'b'.repeat(64) }, online: true, lastOkAtMs: clock,
    sessions: { rows: [], keys: {}, incoming: [] } };
  const server = createSwitchboardServer({ now: () => clock, pendingStatePath: false, dashboardWatchPaths: [], playSound: (kind) => played.push(kind),
    machineGroup: { merge: (dashboard) => mergePeerRows(dashboard, [peer], { machineId: 'a'.repeat(16) }, clock) },
    loadDashboard: async () => ({ generatedAtMs: clock, providers: [], threads: [] }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const at = async ({ state, completionAtMs = 0, online = true }) => {
    clock += 10_000;
    peer.online = online;
    if (online) peer.lastOkAtMs = clock;
    peer.sessions.rows = [{ id: 'task', externalId: 'task', provider: 'codex', providerLabel: 'Codex', title: 'Task', state, nativeUnread: null,
      completionAtMs, updatedAtMs: clock }];
    server.invalidateDashboard('test', { hard: true });
    const dashboard = await (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`)).json();
    return dashboard.threads.find((thread) => thread.id === `m:${peer.member.machineId}:task`);
  };
  return { at, played };
}

test('a task of a member that ends during a short outage gets its mark and one Done sound when the member is back', async (t) => {
  const { at, played } = await memberServer(t);
  assert.equal((await at({ state: 'working' })).state, 'working');
  // Three polls fail: the rows of the member are Unknown.
  for (let scan = 0; scan < 3; scan += 1) assert.deepEqual([(await at({ state: 'working', online: false })).state, played], ['unknown', []]);
  // The task ended while the member was away.
  const back = await at({ state: 'idle', completionAtMs: now + 35_000 });
  assert.deepEqual([back.state, back.completionAttention, back.pending], ['idle', true, true]);
  assert.deepEqual(played, [BIT_DONE]);
  await at({ state: 'idle', completionAtMs: now + 35_000 });
  assert.deepEqual(played, [BIT_DONE]);
});

test('a task of a member that ended before a short outage plays no Done sound again when the member is back', async (t) => {
  const { at, played } = await memberServer(t);
  await at({ state: 'working' });
  const done = await at({ state: 'idle', completionAtMs: now + 5_000 });
  assert.deepEqual([done.completionAttention, played], [true, [BIT_DONE]]);
  for (let scan = 0; scan < 3; scan += 1) assert.equal((await at({ state: 'idle', completionAtMs: now + 5_000, online: false })).state, 'unknown');
  const back = await at({ state: 'idle', completionAtMs: now + 5_000 });
  assert.deepEqual([back.state, back.completionAttention, played], ['idle', true, [BIT_DONE]]);
});
