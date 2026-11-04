import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BIT_FAILED, soundBaseline, soundBits, soundEvents } from '../src/asb-sounds.mjs';
import { processStart, readLiveClaudeRegistry } from '../src/claude-registry.mjs';
import { exportBody, exportLocalSessions, mergePeerRows, validExport } from '../src/machine-peers.mjs';
import { buildSwitchboardDashboard, PendingTracker } from '../src/switchboard.mjs';

// A Claude Code process that ends during a task: an Unknown row with the attention of a failed Idle row.
const id = '123e4567-e89b-12d3-a456-426614174000';
const now = Date.parse('2026-11-04T10:00:00Z');
const REASON = 'The Claude Code process ended during a task.';
const claude = (extra) => ({ id, externalId: `local_${id}`, provider: 'claude-desktop-code', nativeUnread: null, title: 'Synthetic task',
  lifecycleRunning: true, agentStartedAtMs: now - 5000, agentActivityAtMs: now - 1000, transcriptActivityAtMs: now - 1000, ...extra });
const running = (extra = {}) => buildSwitchboardDashboard([claude(extra)], [], now);
const ended = (extra = {}) => running({ cliProcessEnded: true, ...extra });
const attention = (row) => [row.failedAttention, row.completionAttention, row.unread, row.pending, row.pendingSource, row.alert];

test('only a process end has processEnded, with the time of the last transcript activity and no outcome', () => {
  const [row] = ended().threads;
  assert.deepEqual([row.state, row.reason, row.processEnded, row.lastOutcome, row.failedAtMs, row.completionAtMs],
    ['unknown', REASON, true, '', now - 1000, 0]);
  assert.equal(ended({ transcriptActivityAtMs: undefined }).threads[0].failedAtMs, 0);
  for (const thread of [claude(), claude({ agentActivityAtMs: now - 7 * 3_600_000 }), claude({ lifecycleRunning: undefined, childWorkUnknown: true }),
    claude({ lifecycleRunning: undefined }), claude({ lifecycleRunning: false, latestLifecycleKind: 'failed', latestLifecycleAtMs: now })]) {
    assert.equal('processEnded' in buildSwitchboardDashboard([thread], [], now).threads[0], false);
  }
});

test('a Working Claude row whose process ends gets the failed attention and its sound once, and Read clears it', async () => {
  const tracker = new PendingTracker(false);
  const [working] = (await tracker.observe(running())).threads;
  assert.equal(working.state, 'working');
  const before = soundBaseline(null, [working], now);
  const [row] = (await tracker.observe(ended())).threads;
  assert.deepEqual([row.state, row.processEnded, row.lastOutcome], ['unknown', true, '']);
  assert.deepEqual(attention(row), [true, false, true, true, 'observed-failure', true]);
  assert.equal(soundBits(row), BIT_FAILED);
  assert.deepEqual(soundEvents(before, [row], now).map((event) => event.kind), [BIT_FAILED]);
  const [again] = (await tracker.observe(ended())).threads;
  assert.deepEqual(attention(again), attention(row));
  assert.deepEqual(soundEvents(soundBaseline(before, [row], now), [again], now), []);
  await tracker.acknowledge(id);
  const [read] = (await tracker.observe(ended())).threads;
  assert.deepEqual([read.state, read.reason, read.retainedUnread], ['unknown', REASON, false]);
  assert.deepEqual(attention(read), [false, false, false, false, '', false]);
});

test('a row that is processEnded at the first scan gets no attention', async () => {
  const [first] = (await new PendingTracker(false).observe(ended())).threads;
  assert.deepEqual([first.processEnded, soundBits(first)], [true, 0]);
  assert.deepEqual(attention(first), [false, false, false, false, '', false]);
});

test('a muted row gets no process-end attention until the mute ends; then it shows as a failure', async () => {
  const tracker = new PendingTracker(false);
  const [working] = (await tracker.observe(running())).threads;
  await tracker.setMuted(working, true, 0, now - 2000);
  const [muted] = (await tracker.observe(ended())).threads;
  assert.deepEqual([muted.muted, soundBits(muted)], [true, 0]);
  assert.deepEqual(attention(muted), [false, false, false, false, '', false]);
  await tracker.setMuted(muted, false);
  assert.deepEqual(attention(muted), [true, false, true, true, 'observed-failure', true]);
});

test('a Discard armed on the Working row does not hide a process end, and the drawer takes the row', async () => {
  const tracker = new PendingTracker(false);
  const [working] = (await tracker.observe(running())).threads;
  await tracker.setDiscard(working, true);
  const [row] = (await tracker.observe(ended())).threads;
  assert.deepEqual([row.discardResult, ...attention(row)], [false, true, false, true, true, 'observed-failure', true]);
  await tracker.setDrawer(row, true);
  assert.deepEqual([row.drawer, row.unread, row.alert], [true, false, false]);
});

test('the member export carries processEnded, and the member row gets the same attention; an older member row gets none', async () => {
  const A = { machineId: 'a'.repeat(16), name: 'engine-a' };
  const B = { machineId: 'b'.repeat(16), name: 'engine-b' };
  const peer = (dashboard, strip = false) => {
    const exported = exportLocalSessions(dashboard, B, now);
    if (strip) for (const row of exported.rows) delete row.processEnded;
    return { member: { ...B, certFingerprint: 'b'.repeat(64) }, online: true, lastOkAtMs: now - 1000,
      sessions: validExport(JSON.parse(exportBody(exported).body), B), error: '' };
  };
  const merged = (dashboard, strip) => mergePeerRows({ threads: [], messages: [], providers: [] }, [peer(dashboard, strip)], A, now);
  assert.equal(exportLocalSessions(ended(), B, now).rows[0].processEnded, true);
  assert.equal('processEnded' in exportLocalSessions(running(), B, now).rows[0], false);
  assert.equal(validExport({ api: 1, machineId: B.machineId, rows: [{ id: 'x', processEnded: 'yes' }], keys: {}, incoming: [] }, B).rows.length, 0);
  for (const [strip, expected] of [[false, [true, false, true, true, 'observed-failure', true]], [true, [false, false, false, false, '', false]]]) {
    const tracker = new PendingTracker(false);
    await tracker.observe(merged(running(), strip));
    const [row] = (await tracker.observe(merged(ended(), strip))).threads;
    assert.deepEqual([row.remote, row.state, row.processEnded ?? false], [true, 'unknown', !strip]);
    assert.deepEqual(attention(row), expected, String(strip));
  }
});

test('a failed read of an existing registry file keeps its last parsed record; a missing file or an ended process drops it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asb-registry-fallback-'));
  const SESSION = '11111111-1111-4111-8111-111111111111';
  const file = (pid) => path.join(root, `${pid}.json`);
  const write = (pid, fields = {}) => writeFileSync(file(pid), JSON.stringify({ pid, sessionId: SESSION, name: 'synthetic',
    procStart: '133000000000000000', entrypoint: 'cli', ...fields }));
  let alive = new Set([101, 102]);
  const read = async () => (await readLiveClaudeRegistry([root], { windows: true, isAlive: (pid) => alive.has(pid), listPipes: async () => [] }))
    .map((record) => [record.pid, record.status]).sort();
  try {
    // 1. A file that is not settled yet (written just now) parses; a half-written copy then uses the last parsed record.
    write(101, { status: 'busy' });
    assert.deepEqual(await read(), [[101, 'busy']]);
    writeFileSync(file(101), '{"pid": 101, "sess');
    assert.deepEqual(await read(), [[101, 'busy']]);
    // 2. The fallback stays while the read keeps failing, and a valid write replaces it.
    assert.deepEqual(await read(), [[101, 'busy']]);
    write(101, { status: 'idle' });
    assert.deepEqual(await read(), [[101, 'idle']]);
    // 3. A file that never parsed gives no record.
    writeFileSync(file(102), 'not json');
    assert.deepEqual(await read(), [[101, 'idle']]);
    // 4. The process check runs on a fallback record: an ended process drops it.
    writeFileSync(file(101), '');
    assert.deepEqual(await read(), [[101, 'idle']]);
    alive = new Set([102]);
    assert.deepEqual(await read(), []);
    // 5. A missing file drops the record.
    alive = new Set([101]);
    write(101, { status: 'busy' });
    assert.deepEqual(await read(), [[101, 'busy']]);
    unlinkSync(file(101));
    assert.deepEqual(await read(), []);
    writeFileSync(file(101), 'not json');
    assert.deepEqual(await read(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the Linux registry read keeps a live record of this process through a failed parse', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asb-registry-linux-'));
  const target = path.join(root, `${process.pid}.json`);
  const start = await processStart(process.pid);
  try {
    writeFileSync(target, JSON.stringify({ pid: process.pid, sessionId: 's', name: 'synthetic', procStart: start }));
    assert.equal((await readLiveClaudeRegistry([root])).length, 1);
    writeFileSync(target, '{');
    assert.equal((await readLiveClaudeRegistry([root])).length, 1);
    writeFileSync(target, JSON.stringify({ pid: process.pid, sessionId: 's', name: 'synthetic', procStart: '1' }));
    assert.equal((await readLiveClaudeRegistry([root])).length, 0);
    writeFileSync(target, '{');
    // The last parsed record has the wrong start, so the process check drops it.
    assert.equal((await readLiveClaudeRegistry([root])).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
