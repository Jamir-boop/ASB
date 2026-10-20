import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { readRolloutSignals, useRolloutPositions } from '../src/codex-data.mjs';
import { createReaderPositions, MAX_POSITION_FILE_BYTES, MAX_POSITION_RECORD_BYTES, MAX_POSITION_RECORDS,
  POSITION_SAVE_INTERVAL_MS } from '../src/reader-positions.mjs';
import { rolloutWriter, seededRandom } from './rollout-writer.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('..', import.meta.url).href;
const WRITER = new URL('./rollout-writer.mjs', import.meta.url).href;
const KEY = 'a1'.repeat(32);
const NOW_MS = Date.parse('2026-10-08T12:00:00Z');
const MARKERS = ['MARKERPROMPT', 'MARKERREPLY', 'MARKERQUESTION', 'MARKEROUTPUT', 'MARKERFOLDER', 'MARKERDIR', 'MARKERCWD'];
const posix = process.platform !== 'win32';

// One engine in its own process: the reader caches start empty, as in a new engine.
// `files`: rollouts to read in order (with an optional append and second read). `dashboard`: a Codex source to load.
const ENGINE = `
const config = JSON.parse(process.env.ASB_CONFIG);
const codex = await import(new URL('src/codex-data.mjs', process.env.ASB_ROOT));
const logs = [];
let positions = null;
if (config.file) {
  const { createReaderPositions } = await import(new URL('src/reader-positions.mjs', process.env.ASB_ROOT));
  positions = createReaderPositions({ file: config.file, key: async () => config.key ? Buffer.from(config.key, 'hex') : null,
    log: (line) => logs.push(line) });
  await positions.ready();
}
const bytes = () => { const stats = codex.getCodexCacheStats().rolloutSignals; return stats.lifecycleBytesRead + stats.bytesRead; };
const out = { files: [], logs };
for (const file of config.files || []) {
  const before = bytes();
  const signals = await codex.readRolloutSignals(file.path, { initialBytes: file.tail, maxBytes: file.tail });
  out.files.push({ signals, bytes: bytes() - before });
}
if (config.dashboard) {
  const { loadSwitchboardDashboard } = await import(new URL('src/switchboard.mjs', process.env.ASB_ROOT));
  const before = bytes();
  const dashboard = await loadSwitchboardDashboard({ nowMs: config.nowMs, codexOptions: config.dashboard,
    loadClaude: async () => ({ provider: { installed: false, status: 'missing' }, threads: [] }) });
  out.threads = dashboard.threads;
  out.dashboardBytes = bytes() - before;
}
if (positions) { await positions.flush(); out.stats = positions.stats(); }
process.stdout.write(JSON.stringify(out));
`;

async function engine(config, root = ROOT) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', ENGINE], {
    env: { ...process.env, ASB_ROOT: root, ASB_CONFIG: JSON.stringify(config) }, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-reader-positions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const event = (atMs, payload) => JSON.stringify({ type: 'event_msg', timestamp: new Date(atMs).toISOString(), payload });
// Lines with no lifecycle event, no question, and no turn boundary, so the tail never gives the lifecycle.
const filler = (atMs, bytes) => {
  const lines = [];
  for (let size = 0; size < bytes; size += 1100) lines.push(event(atMs, { type: 'tool_output', text: `MARKEROUTPUT ${'x'.repeat(1024)}` }));
  return lines;
};
const jsonl = (lines) => `${lines.join('\n')}\n`;

// Random rollouts of the scan tests, with a prefix that is larger than the tail.
async function randomRollouts(directory, count, seedBase) {
  const files = [];
  for (let seed = 1; seed <= count; seed += 1) {
    const writer = rolloutWriter(seededRandom(seedBase + seed));
    const tail = writer.pick([512, 1024, 4096]);
    const filePath = path.join(directory, `${seed}.jsonl`);
    const part = () => [...writer.events(5 + Math.floor(writer.random() * 60)),
      ...[() => [writer.lifecycle()], () => writer.quiet(tail), () => []][Math.floor(writer.random() * 3)]()];
    await fs.writeFile(filePath, writer.finish(writer.join([...writer.quiet(tail * 40), ...part()])));
    files.push({ path: filePath, tail, append: () => fs.appendFile(filePath, writer.finish(writer.join(part()))) });
  }
  return files;
}

const fileConfig = (files) => files.map((file) => ({ path: file.path, tail: file.tail }));

test('a new engine with saved reader positions shows the same rows as a full read', async (t) => {
  const home = await temporaryDirectory(t);
  const sessions = path.join(home, 'MARKERDIR', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const at = (minutes) => NOW_MS - minutes * 60_000;
  const big = 6 * 1024 * 1024;
  const question = { type: 'function_call', name: 'request_user_input_async', call_id: 'call_q1',
    arguments: JSON.stringify({ questions: [{ id: 'one', question: 'MARKERQUESTION?' }] }) };
  const window = { type: 'token_count', rate_limits: { primary: { used_percent: 98, resets_at: (NOW_MS + 3_600_000) / 1000 } } };
  const scenarios = {
    working: [event(at(30), { type: 'user_message', message: 'MARKERPROMPT start' }), event(at(29), { type: 'task_started' }), ...filler(at(1), big)],
    done: [event(at(90), { type: 'task_started' }), event(at(80), { type: 'agent_message', message: 'MARKERREPLY', phase: 'final_answer' }),
      event(at(80), { type: 'task_complete' }), ...filler(at(70), big)],
    failed: [event(at(90), { type: 'task_started' }), event(at(85), { type: 'task_complete', error: { message: 'MARKERREPLY' } }), ...filler(at(80), big)],
    aborted: [event(at(90), { type: 'task_started' }), event(at(85), { type: 'turn_aborted' }), ...filler(at(80), big)],
    question: [event(at(20), { type: 'task_started' }), event(at(19), question),
      event(at(19), { type: 'function_call_output', call_id: 'call_q1', output: JSON.stringify({ accepted: true, note: 'MARKEROUTPUT' }) }),
      ...filler(at(2), big)],
    limited: [event(at(50), { type: 'task_started' }), event(at(49), window),
      event(at(48), { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded', message: 'MARKERREPLY' } }), ...filler(at(47), big)],
    unfinished: [event(at(40), { type: 'task_started' }), ...filler(at(3), big), '{"type":"event_msg","payload":{"type":"task_comp'],
  };
  const appends = {
    working: [event(at(1), { type: 'task_complete' })],
    done: [event(at(5), { type: 'task_started' }), ...filler(at(1), 4096)],
    question: [event(at(1), { type: 'user_message', message: `<send_user_message_question_reply>${JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', 'call_q1', 0]), answer: 'MARKERPROMPT' }])}</send_user_message_question_reply>` }),
    ...filler(at(1), 2048)],
    unfinished: ['lete"}}', ...filler(at(2), 2048)],
  };
  const databasePath = path.join(home, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`create table threads(id text primary key, rollout_path text, cwd text, title text, source text,
    created_at_ms integer, updated_at_ms integer, archived integer);`);
  const insert = database.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, 0)');
  for (const [index, [name, lines]] of Object.entries(scenarios).entries()) {
    const rolloutPath = path.join(sessions, `rollout-${name}.jsonl`);
    // The unfinished scenario ends without a newline.
    await fs.writeFile(rolloutPath, name === 'unfinished' ? lines.join('\n') : jsonl(lines));
    insert.run(`0000000${index}-0000-4000-8000-000000000000`, rolloutPath, path.join(home, 'MARKERCWD', name), name, 'vscode', at(100), at(index));
  }
  database.close();
  const dashboard = { databasePath, sessionIndexPath: path.join(home, 'session_index.jsonl'), globalStatePath: path.join(home, 'global.json') };
  const file = path.join(home, 'cache', 'asb', 'readers', 'positions.json');

  const a = await engine({ file, key: KEY, dashboard, nowMs: NOW_MS });
  assert.equal(a.threads.length, 7);
  assert.equal(a.stats.loaded, 0);
  for (const [name, lines] of Object.entries(appends)) {
    await fs.appendFile(path.join(sessions, `rollout-${name}.jsonl`), name === 'unfinished' ? jsonl(lines) : jsonl(lines));
  }
  const b = await engine({ file, key: KEY, dashboard, nowMs: NOW_MS });
  const c = await engine({ dashboard, nowMs: NOW_MS });
  assert.deepEqual(b.threads, c.threads);
  const states = Object.fromEntries(c.threads.map((row) => [row.title, row.state]));
  assert.deepEqual(states, { working: 'idle', done: 'working', failed: 'idle', aborted: 'idle', question: 'working', limited: 'idle', unfinished: 'idle' });
  assert.equal(c.threads.find((row) => row.title === 'limited').limitResetsAtMs, NOW_MS + 3_600_000);
  assert.equal(c.threads.find((row) => row.title === 'failed').lastOutcome, 'failed');
  assert.ok(b.stats.taken >= 7, `taken: ${b.stats.taken}`);
  assert.ok(b.dashboardBytes * 10 < c.dashboardBytes, `bytes B ${b.dashboardBytes}, C ${c.dashboardBytes}`);
  t.diagnostic(`bytes read: run B ${b.dashboardBytes}, run C ${c.dashboardBytes}`);
  // Before the appends, the rows of run A are the rows of a full read too: a working row and a pending question.
  assert.equal(a.threads.find((row) => row.title === 'working').state, 'working');
  assert.equal(a.threads.find((row) => row.title === 'question').questionPending, true);
});

test('Codex lifecycle positions from disk give the result of a full pass after appends', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await randomRollouts(directory, 120, 0);
  const file = path.join(directory, 'readers', 'positions.json');
  await engine({ file, key: KEY, files: fileConfig(files) });
  for (const rollout of files) await rollout.append();
  const b = await engine({ file, key: KEY, files: fileConfig(files) });
  const c = await engine({ files: fileConfig(files) });
  assert.deepEqual(b.files.map((item) => item.signals), c.files.map((item) => item.signals));
  assert.ok(b.stats.taken >= 60, `taken: ${b.stats.taken}`);
  const total = (run) => run.files.reduce((sum, item) => sum + item.bytes, 0);
  assert.ok(total(b) < total(c), `B ${total(b)}, C ${total(c)}`);
});

// Measured on main (ba1ecdc) with the same synthetic set: the reader with no positions reads the same bytes and gives the same signals.
// To measure again: ASB_HEAD_ROOT=file:///<copy of main>/ node --test --test-name-pattern="same bytes" test/reader-positions.test.mjs
const HEAD_OFF = { lifecycleBytes: 3371140, tailBytes: 240640, digest: 'a3b5109d052b681c8c87b7a68b86c63ff2d7d5bc65c082f8fd3e5bb5cb4281de' };

test('with no positions the Codex reader reads the same bytes and gives the same signals as before positions', async (t) => {
  const directory = await temporaryDirectory(t);
  const script = `
const codex = await import(new URL('src/codex-data.mjs', process.env.ASB_ROOT));
const { rolloutWriter, seededRandom } = await import(process.env.ASB_WRITER);
const fs = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const results = [];
for (let seed = 1; seed <= 60; seed += 1) {
  const writer = rolloutWriter(seededRandom(5000 + seed));
  const tail = writer.pick([512, 1024, 4096]);
  const file = process.env.ASB_DIR + '/' + seed + '.jsonl';
  await fs.writeFile(file, writer.finish(writer.join([...writer.quiet(tail * 20), ...writer.events(40)])));
  results.push(await codex.readRolloutSignals(file, { initialBytes: tail, maxBytes: tail }));
  await fs.appendFile(file, writer.finish(writer.join(writer.events(20))));
  results.push(await codex.readRolloutSignals(file, { initialBytes: tail, maxBytes: tail }));
}
const stats = codex.getCodexCacheStats().rolloutSignals;
process.stdout.write(JSON.stringify({ lifecycleBytes: stats.lifecycleBytesRead, tailBytes: stats.bytesRead,
  digest: createHash('sha256').update(JSON.stringify(results)).digest('hex') }));
`;
  const root = process.env.ASB_HEAD_ROOT || ROOT;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, ASB_ROOT: root, ASB_WRITER: WRITER, ASB_DIR: directory } });
  const actual = JSON.parse(stdout);
  if (process.env.ASB_HEAD_ROOT) t.diagnostic(stdout);
  else assert.deepEqual(actual, HEAD_OFF);
});

// The record key of the file format: the first 16 bytes of HMAC-SHA-256 of `codex\0<path>`.
const recordKey = (filePath, key = KEY) => createHmac('sha256', Buffer.from(key, 'hex')).update(`codex\0${filePath}`).digest().subarray(0, 16).toString('hex');

// Rollouts whose tail has no lifecycle event, so each read scans the full log and each log gets a record.
async function plainRollouts(directory, count, bytes = 100 * 1024) {
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const filePath = path.join(directory, `plain-${index}.jsonl`);
    await fs.writeFile(filePath, jsonl([event(NOW_MS - 600_000, { type: 'task_started' }),
      event(NOW_MS - 590_000, { type: 'user_message', message: 'MARKERPROMPT' }), ...filler(NOW_MS - 500_000, bytes)]));
    files.push({ path: filePath, tail: 4096,
      append: () => fs.appendFile(filePath, jsonl([event(NOW_MS - 1000, { type: 'task_complete' }), ...filler(NOW_MS, 2048)])) });
  }
  return files;
}

const readSaved = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeSaved = (file, value) => fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });

test('a saved record that does not agree with its log gives a full read and the same result', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 7);
  const file = path.join(directory, 'readers', 'positions.json');
  await engine({ file, key: KEY, files: fileConfig(files) });
  const saved = await readSaved(file);
  assert.equal(saved.codex.records.length, 7);
  const [truncated, replaced, touched, guarded, otherDevice, swapped, control] = files;
  const recordFor = (rollout) => saved.codex.records.find((record) => record.k === recordKey(rollout.path));
  const guardSize = recordFor(guarded).size;
  for (const rollout of [truncated, replaced, guarded, otherDevice, swapped, control]) await rollout.append();
  // Truncation and growth with the same inode.
  const bytes = await fs.readFile(truncated.path);
  await fs.writeFile(truncated.path, bytes.subarray(0, 1000));
  await fs.appendFile(truncated.path, bytes.subarray(990));
  // A new file with the old name.
  await fs.writeFile(`${replaced.path}.new`, await fs.readFile(replaced.path));
  await fs.rename(`${replaced.path}.new`, replaced.path);
  // The same size with a new modification time.
  const old = await fs.stat(touched.path);
  await fs.utimes(touched.path, old.atime, new Date(old.mtimeMs + 5000));
  // One changed byte in the guard bytes of a log that also grew.
  const handle = await fs.open(guarded.path, 'r+');
  await handle.write(Buffer.from('y'), 0, 1, guardSize - 10);
  await handle.close();
  // Another device for one record, and the keys of two records swapped.
  recordFor(otherDevice).dev += 1;
  const swapA = recordFor(swapped), swapB = recordFor(control);
  const controlRecord = structuredClone(swapB);
  [swapA.k, swapB.k] = [swapB.k, swapA.k];
  await writeSaved(file, saved);
  const b = await engine({ file, key: KEY, files: fileConfig(files) });
  const c = await engine({ files: fileConfig(files) });
  assert.deepEqual(b.files.map((item) => item.signals), c.files.map((item) => item.signals));
  for (const [index, rollout] of files.entries()) {
    assert.ok(b.files[index].bytes >= (await fs.stat(rollout.path)).size, `full read of log ${index}`);
  }
  // The control log with its own record resumes and reads only its tail and new bytes.
  await fs.rm(file);
  await writeSaved(file, { ...saved, codex: { ...saved.codex, records: [controlRecord] } });
  await control.append();
  const resumed = await engine({ file, key: KEY, files: fileConfig([control]) });
  const full = await engine({ files: fileConfig([control]) });
  assert.deepEqual(resumed.files[0].signals, full.files[0].signals);
  assert.ok(resumed.files[0].bytes < 32 * 1024, `resumed bytes: ${resumed.files[0].bytes}`);
});

test('a missing, damaged, old, or foreign positions file gives full reads, and a bad record is dropped alone', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 3);
  const file = path.join(directory, 'readers', 'positions.json');
  await engine({ file, key: KEY, files: fileConfig(files) });
  const good = await fs.readFile(file, 'utf8');
  for (const rollout of files) await rollout.append();
  const full = await engine({ files: fileConfig(files) });
  const edit = (change) => { const copy = JSON.parse(good); change(copy); return copy; };
  const whole = {
    missing: null,
    empty: '',
    'bad JSON': '{"version":1,',
    'cut JSON': good.slice(0, Math.floor(good.length / 2)),
    'version 2': edit((copy) => { copy.version = 2; }),
    'other key check': edit((copy) => { copy.keyCheck = '0'.repeat(32); }),
    'other code hash': edit((copy) => { copy.codex.code = '0'.repeat(64); }),
    'too large': good + ' '.repeat(MAX_POSITION_FILE_BYTES),
  };
  for (const [name, content] of Object.entries(whole)) {
    await fs.rm(file, { force: true });
    if (content !== null) await writeSaved(file, content);
    const run = await engine({ file, key: KEY, files: fileConfig(files) });
    assert.equal(run.stats.taken, 0, name);
    assert.deepEqual(run.files.map((item) => item.signals), full.files.map((item) => item.signals), name);
  }
  // With another key, the same file is foreign.
  await fs.rm(file, { force: true });
  await writeSaved(file, good);
  assert.equal((await engine({ file, key: 'b2'.repeat(32), files: fileConfig(files) })).stats.taken, 0);
  const records = {
    'bad kind': (record) => { record.lifecycle.latestLifecycleKind = 'MARKERREPLY'; },
    'negative offset': (record) => { record.offset = -1; },
    'offset after size': (record) => { record.offset = record.size + 1; },
    'ID with a space': (record) => { record.questions = [['call one', 0, 1, [0]]]; },
    'text field': (record) => { record.note = 'MARKERPROMPT'; },
  };
  for (const [name, change] of Object.entries(records)) {
    await fs.rm(file, { force: true });
    await writeSaved(file, edit((copy) => change(copy.codex.records.find((record) => record.k === recordKey(files[1].path)))));
    const run = await engine({ file, key: KEY, files: fileConfig(files) });
    assert.deepEqual(run.stats, { loaded: 2, taken: 2 }, name);
    assert.deepEqual(run.files.map((item) => item.signals), full.files.map((item) => item.signals), name);
    assert.ok(run.files[1].bytes > run.files[0].bytes * 4, name);
  }
});

test('the positions file keeps the newest 5000 records and at most 256 KiB for one record', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 1);
  const file = path.join(directory, 'readers', 'positions.json');
  await engine({ file, key: KEY, files: fileConfig(files) });
  const saved = await readSaved(file);
  const [template] = saved.codex.records;
  const atMs = Date.now();
  const copy = (index, extra = {}) => ({ ...structuredClone(template), k: randomBytes(16).toString('hex'), atMs: atMs - index * 1000, ...extra });
  saved.codex.records = [...Array.from({ length: 6000 }, (_, index) => copy(index)),
    copy(-1, { questions: [['call_big', 0, 1, Array.from({ length: 60_000 }, (_, index) => index)]] }),
    copy(-2, { atMs: atMs - 31 * 24 * 60 * 60 * 1000 })];
  await fs.rm(file);
  await writeSaved(file, saved);
  const run = await engine({ file, key: KEY, files: [] });
  assert.equal(run.stats.loaded, 6001);
  const kept = (await readSaved(file)).codex.records;
  assert.equal(kept.length, MAX_POSITION_RECORDS);
  assert.deepEqual(kept.map((record) => record.atMs), Array.from({ length: 5000 }, (_, index) => atMs - index * 1000));
  assert.ok(kept.every((record) => JSON.stringify(record).length <= MAX_POSITION_RECORD_BYTES));
});

// In this process: the positions of one engine, with an injected clock.
async function inProcess(t, directory, options = {}) {
  const logs = [];
  let clock = Date.now();
  const positions = createReaderPositions({ file: path.join(directory, 'readers', 'positions.json'), key: async () => Buffer.from(KEY, 'hex'),
    now: () => clock, log: (line) => logs.push(line), ...options });
  t.after(() => useRolloutPositions(null));
  await positions.ready();
  return { positions, logs, advance: (ms) => { clock += ms; } };
}

test('the file limit drops the oldest records first', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 30, 8 * 1024);
  const { positions } = await inProcess(t, directory, { maxFileBytes: 6000 });
  for (const rollout of files) await readRolloutSignals(rollout.path, { initialBytes: 4096, maxBytes: 4096 });
  await positions.flush();
  const file = path.join(directory, 'readers', 'positions.json');
  const { size } = await fs.stat(file);
  const kept = (await readSaved(file)).codex.records;
  assert.ok(size <= 6000 && kept.length > 2 && kept.length < 30, `${size} bytes, ${kept.length} records`);
  assert.deepEqual(kept.map((record) => record.atMs), kept.map((record) => record.atMs).sort((a, b) => b - a));
});

test('positions are saved once after the first scan, then at most once in 10 minutes when they changed, and at flush', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 2);
  const file = path.join(directory, 'readers', 'positions.json');
  const { positions, advance } = await inProcess(t, directory);
  // Each step removes the file, so a file after a step shows a write in that step.
  const wrote = async () => {
    const written = await fs.stat(file).then(() => true, () => false);
    await fs.rm(file, { force: true });
    return written;
  };
  await readRolloutSignals(files[0].path, { initialBytes: 4096, maxBytes: 4096 });
  await positions.scanDone();
  assert.equal(await wrote(), true, 'a write after the first scan');
  await readRolloutSignals(files[1].path, { initialBytes: 4096, maxBytes: 4096 });
  await positions.scanDone();
  assert.equal(await wrote(), false, 'no second write in 10 minutes');
  advance(POSITION_SAVE_INTERVAL_MS + 1);
  await positions.scanDone();
  assert.equal(await wrote(), true, 'a write of the change after 10 minutes');
  advance(POSITION_SAVE_INTERVAL_MS + 1);
  await positions.scanDone();
  assert.equal(await wrote(), false, 'no write when the text did not change');
  await files[0].append();
  await readRolloutSignals(files[0].path, { initialBytes: 4096, maxBytes: 4096 });
  await positions.flush();
  const keys = (await readSaved(file)).codex.records.map((record) => record.k);
  assert.ok(files.every((rollout) => keys.includes(recordKey(rollout.path))), 'flush writes a change at once');
});

test('a failed write logs one line and keeps the reader working; no key means no positions and no file', async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 1);
  const file = path.join(directory, 'readers', 'positions.json');
  await fs.mkdir(path.join(file, 'blocker'), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const { positions, logs } = await inProcess(t, directory);
  await readRolloutSignals(files[0].path, { initialBytes: 4096, maxBytes: 4096 });
  await positions.flush();
  assert.deepEqual(logs, ['ASB cannot save its reader positions. It keeps the old file.']);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['positions.json'], 'no temporary file stays');
  useRolloutPositions(null);
  const other = await temporaryDirectory(t);
  const noKey = createReaderPositions({ file: path.join(other, 'readers', 'positions.json'), key: () => new Promise(() => {}), keyWaitMs: 50 });
  await noKey.ready();
  await files[0].append();
  assert.equal((await readRolloutSignals(files[0].path, { initialBytes: 4096, maxBytes: 4096 })).agentRunning, false);
  await noKey.flush();
  await assert.rejects(fs.stat(path.join(other, 'readers')), { code: 'ENOENT' });
  assert.deepEqual(noKey.stats(), { loaded: 0, taken: 0 });
});

test('the positions file has no message text, path, folder name, or raw guard bytes', async (t) => {
  const home = await temporaryDirectory(t);
  const directory = path.join(home, 'MARKERFOLDER', 'MARKERDIR');
  await fs.mkdir(directory, { recursive: true });
  const files = await plainRollouts(directory, 2);
  const question = (id) => event(NOW_MS, { type: 'function_call', name: 'request_user_input_async', call_id: id,
    arguments: JSON.stringify({ questions: [{ id: 'one', question: 'MARKERQUESTION' }] }) });
  const answer = (id) => event(NOW_MS, { type: 'function_call_output', call_id: id, output: JSON.stringify({ accepted: true, text: 'MARKEROUTPUT' }) });
  await fs.appendFile(files[0].path, jsonl([question('call_ok'), answer('call_ok'),
    event(NOW_MS, { type: 'agent_message', message: 'MARKERREPLY' }), ...filler(NOW_MS, 8192)]));
  // A question ID that is not a plain ID: this log gets no record.
  await fs.appendFile(files[1].path, jsonl([question('call /MARKERFOLDER'), ...filler(NOW_MS, 8192)]));
  const file = path.join(home, 'cache', 'readers', 'positions.json');
  const run = await engine({ file, key: KEY, files: fileConfig(files) });
  assert.equal(run.files[0].signals.awaitingUserInput, true);
  assert.equal(run.files[1].signals.awaitingUserInput, true);
  const raw = await fs.readFile(file);
  const text = raw.toString('latin1');
  for (const marker of [...MARKERS, home, path.basename(home), '/', '\\']) assert.equal(text.includes(marker), false, marker);
  for (const rollout of files) {
    const guard = (await fs.readFile(rollout.path)).subarray(-64);
    assert.equal(raw.includes(guard), false);
    assert.equal(text.includes(guard.toString('hex')), false);
  }
  const value = JSON.parse(text);
  assert.deepEqual(value.codex.records.map((record) => record.k), [recordKey(files[0].path)]);
  const strings = [];
  const walk = (item) => {
    if (typeof item === 'string') strings.push(item);
    else if (item && typeof item === 'object') Object.values(item).forEach(walk);
  };
  walk(value);
  const kinds = new Set(['', 'task_started', 'task_complete', 'turn_aborted', 'turn_cancelled', 'task_cancelled', 'cancelled', 'failed']);
  for (const item of strings) assert.ok(/^[0-9a-f]{32}$|^[0-9a-f]{64}$/.test(item) || kinds.has(item) || /^call_[A-Za-z0-9_-]+$/.test(item), item);
  assert.ok(strings.includes('call_ok'));
});

test('the positions folder is 0700 and the file 0600; a link or a foreign owner turns the positions off', { skip: !posix }, async (t) => {
  const directory = await temporaryDirectory(t);
  const files = await plainRollouts(directory, 1);
  const readers = path.join(directory, 'readers');
  const file = path.join(readers, 'positions.json');
  await fs.mkdir(readers);
  await fs.chmod(readers, 0o755);
  // A file that is not private is not used, and the next save replaces it.
  await fs.writeFile(file, '{}');
  await fs.chmod(file, 0o644);
  const first = await inProcess(t, directory);
  assert.deepEqual(first.positions.stats(), { loaded: 0, taken: 0 });
  await readRolloutSignals(files[0].path, { initialBytes: 4096, maxBytes: 4096 });
  await first.positions.flush();
  assert.equal((await fs.stat(readers)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  useRolloutPositions(null);
  assert.ok((await engine({ file, key: KEY, files: [] })).stats.loaded >= 1);
  await fs.chmod(file, 0o644);
  assert.equal((await engine({ file, key: KEY, files: [] })).stats.loaded, 0, 'a file with mode 0644 is not loaded');
  await fs.chmod(file, 0o600);
  await fs.chmod(readers, 0o755);
  assert.equal((await engine({ file, key: KEY, files: [] })).stats.loaded, 0, 'a folder with mode 0755 is not used at load');
  await fs.chmod(readers, 0o700);
  // A link in place of the folder.
  const elsewhere = path.join(directory, 'elsewhere');
  await fs.mkdir(elsewhere, { mode: 0o700 });
  const linked = path.join(directory, 'linked');
  await fs.symlink(elsewhere, linked, 'dir');
  const viaLink = await engine({ file: path.join(linked, 'positions.json'), key: KEY, files: fileConfig(files) });
  assert.deepEqual(viaLink.logs, ['ASB does not use its reader positions: the cache folder is a link or belongs to another user.']);
  assert.deepEqual(await fs.readdir(elsewhere), []);
  // A foreign owner.
  const getuid = process.getuid;
  process.getuid = () => getuid() + 1;
  try {
    const foreign = await inProcess(t, directory);
    await foreign.positions.flush();
    assert.deepEqual(foreign.logs, ['ASB does not use its reader positions: the cache folder is a link or belongs to another user.']);
  } finally { process.getuid = getuid; }
});

