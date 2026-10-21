import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BIT_DONE, BIT_FAILED, BIT_INPUT, SOUND_DIR, createSoundPlayer, createSoundWatcher, soundBaseline, soundBits, soundEvents } from '../src/asb-sounds.mjs';
import { mergePeerRows } from '../src/machine-peers.mjs';
import { createSwitchboardServer, PendingTracker } from '../src/switchboard.mjs';

const now = Date.parse('2026-10-07T14:00:00Z');
const row = (fields = {}) => ({ id: 'a', ...fields });
const kinds = (events) => events.map((event) => [event.row.id, event.kind]);

test('sound bits follow the phone rules', () => {
  assert.equal(soundBits(row({ completionAttention: true })), BIT_DONE);
  assert.equal(soundBits(row({ failedAttention: true })), BIT_FAILED);
  assert.equal(soundBits(row({ questionAttention: true })), BIT_INPUT);
  assert.equal(soundBits(row({ actionRequired: true })), BIT_INPUT);
  assert.equal(soundBits(row({ archived: true, completionAttention: true, actionRequired: true })), 0);
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
  const both = [row({ completionAttention: true, actionRequired: true }), row({ id: 'b', failedAttention: true })];
  assert.deepEqual(kinds(soundEvents(soundBaseline(null, done, now), both, now)), [['a', BIT_INPUT], ['b', BIT_FAILED]]);
  assert.deepEqual(soundEvents(new Map(), [row({ archived: true, completionAttention: true })], now), []);
});

test('a limited row plays only Needs input until its first update after the limit', () => {
  const limit = now + 60_000;
  const limitedDone = [row({ completionAttention: true, limitResetsAtMs: limit })];
  assert.deepEqual(soundEvents(new Map(), limitedDone, now), []);
  assert.deepEqual(kinds(soundEvents(new Map(), [row({ actionRequired: true, limitResetsAtMs: limit })], now)), [['a', BIT_INPUT]]);
  // The limited baseline keeps Done, so the restored attention after the reset stays silent.
  const during = soundBaseline(soundBaseline(null, [row({ completionAttention: true })], now), [row({ limitResetsAtMs: limit })], now);
  assert.equal(during.get('a') & BIT_DONE, BIT_DONE);
  const after = [row({ completionAttention: true })];
  assert.deepEqual(soundEvents(during, after, limit + 1), []);
  // A row that was limited at the previous update is still silent for Done.
  const restored = soundBaseline(null, [row({ limitResetsAtMs: limit })], now);
  assert.deepEqual(soundEvents(restored, after, limit + 1), []);
  const next = soundBaseline(restored, after, limit + 1);
  assert.deepEqual(kinds(soundEvents(next, [row({ completionAttention: true, failedAttention: true })], limit + 2)), [['a', BIT_FAILED]]);
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

test('the win32 player runs powershell.exe with the file only in ASB_SOUND, hidden, not detached, and with no shell', async () => {
  const { calls, spawn } = fakeSpawn();
  const logs = [];
  const dir = 'C:\\asb\\assets\\sounds\\';
  const play = createSoundPlayer({ platform: 'win32', spawn, log: (line) => logs.push(line), dir });
  play(BIT_DONE);
  play(BIT_INPUT);
  play(BIT_FAILED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  for (const [index, file] of ['opencode_staplebops_01.wav', 'opencode_staplebops_02.wav', 'opencode_nope_03.wav'].entries()) {
    const [program, args, options] = calls[index];
    assert.equal(program, 'powershell.exe');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', '(New-Object Media.SoundPlayer $env:ASB_SOUND).PlaySync()']);
    assert.equal(options.env.ASB_SOUND, `${dir}${file}`);
    assert.deepEqual({ ...options.env, ASB_SOUND: '' }, { ...process.env, ASB_SOUND: '' });
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    assert.ok(!('detached' in options));
    assert.ok(!('shell' in options));
    assert.ok(!args.some((arg) => arg.includes(file)));
  }
  assert.equal(calls[0][2].env.ASB_SOUND.startsWith(dir), true);
  assert.deepEqual(logs, []);
});

test('the win32 player reports one line when powershell.exe is missing, and uses the existing texts for other failures', async () => {
  const dir = 'C:\\sounds\\';
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const missing = fakeSpawn(['powershell.exe']);
  const logs = [];
  const play = createSoundPlayer({ platform: 'win32', spawn: missing.spawn, log: (line) => logs.push(line), dir });
  play(BIT_DONE);
  await tick();
  play(BIT_FAILED);
  await tick();
  assert.equal(missing.calls.length, 1);
  assert.deepEqual(logs, ['ASB cannot play sounds: Windows PowerShell was not found.']);
  const exited = fakeSpawn([], 1);
  const codes = [];
  createSoundPlayer({ platform: 'win32', spawn: exited.spawn, log: (line) => codes.push(line), dir })(BIT_DONE);
  await tick();
  assert.deepEqual(codes, ['ASB cannot play a sound: powershell.exe exited with code 1.']);
  const throwing = createSoundPlayer({ platform: 'win32', spawn: () => { throw new Error('Synthetic spawn failure'); }, log: (line) => codes.push(line), dir });
  assert.doesNotThrow(() => { throwing(BIT_DONE); throwing(BIT_DONE); });
  assert.deepEqual(codes.slice(1), ['ASB cannot play a sound with powershell.exe: Synthetic spawn failure']);
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
