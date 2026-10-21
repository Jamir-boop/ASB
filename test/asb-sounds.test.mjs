import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BIT_DONE, BIT_FAILED, BIT_INPUT, SOUND_DIR, createSoundPlayer, createSoundWatcher, soundBaseline, soundBits, soundEvents } from '../src/asb-sounds.mjs';
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

function fakeSpawn(missing = []) {
  const calls = [];
  const spawn = (program, args, options) => {
    calls.push([program, args, options]);
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    if (missing.includes(program)) process.nextTick(() => child.emit('error', Object.assign(new Error(`spawn ${program} ENOENT`), { code: 'ENOENT' })));
    else process.nextTick(() => child.emit('exit', 0));
    return child;
  };
  return { calls, spawn };
}

test('the player runs pw-play detached with the ASB name and the phone file for each kind', async () => {
  const { calls, spawn } = fakeSpawn();
  const logs = [];
  const play = createSoundPlayer({ spawn, log: (line) => logs.push(line) });
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
  const play = createSoundPlayer({ spawn: fallback.spawn, log: () => assert.fail('paplay works') });
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
  const silent = createSoundPlayer({ spawn: none.spawn, log: (line) => logs.push(line) });
  silent(BIT_DONE);
  await new Promise((resolve) => setImmediate(resolve));
  silent(BIT_INPUT);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(none.calls.length, 3);
  assert.deepEqual(logs, ['ASB cannot play sounds: install pw-play (PipeWire), paplay (PulseAudio), or aplay (ALSA). Run asb doctor for the command.']);
  const throwing = createSoundPlayer({ spawn: () => { throw new Error('Synthetic spawn failure'); }, log: (line) => logs.push(line) });
  assert.doesNotThrow(() => { throwing(BIT_DONE); throwing(BIT_DONE); });
  assert.deepEqual(logs.slice(1), ['ASB cannot play a sound with pw-play: Synthetic spawn failure']);
});

test('the player tries pw-play, then paplay, then aplay, and keeps aplay for later sounds', async () => {
  const { calls, spawn } = fakeSpawn(['pw-play', 'paplay']);
  const play = createSoundPlayer({ spawn, log: () => assert.fail('aplay works') });
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
