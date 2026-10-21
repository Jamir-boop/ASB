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
// `files`: rollouts to read in order (with an optional append and second read). `dashboard`: a Codex source to load,
// with the Claude Desktop source `claude` when it is set. `claudeOnly`: a Claude Desktop source to load alone.
const ENGINE = `
const config = JSON.parse(process.env.ASB_CONFIG);
const codex = await import(new URL('src/codex-data.mjs', process.env.ASB_ROOT));
const claude = await import(new URL('src/claude-data.mjs', process.env.ASB_ROOT));
const claudeBytes = () => claude.getClaudeCacheStats().jsonlSignals.bytesRead;
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
  const before = bytes(), beforeClaude = claudeBytes();
  const dashboard = await loadSwitchboardDashboard({ nowMs: config.nowMs, codexOptions: config.dashboard,
    claudeOptions: config.claude, loadClaude: config.claude ? claude.loadClaudeDesktopCodeThreads
      : async () => ({ provider: { installed: false, status: 'missing' }, threads: [] }) });
  out.threads = dashboard.threads;
  out.providers = dashboard.providers;
  out.dashboardBytes = bytes() - before;
  out.claudeBytes = claudeBytes() - beforeClaude;
}
if (config.claudeOnly) {
  const before = claudeBytes();
  out.claudeThreads = (await claude.loadClaudeDesktopCodeThreads({ ...config.claudeOnly, nowMs: config.nowMs })).threads;
  out.claudeBytes = claudeBytes() - before;
}
if (positions) {
  await positions.flush();
  out.stats = positions.stats();
  out.codexStats = positions.stats('codex');
  out.claudeStats = positions.stats('claude');
}
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

// Claude Desktop transcripts. Each record has a git branch, and its text has markers for the privacy test.
const CLAUDE_MARKERS = [...MARKERS, 'MARKERTITLE', 'MARKERNAME', 'MARKERBRANCH', 'MARKERPROJECT'];
const claudeRecord = (type, atMs, extra = {}) => JSON.stringify({ type, timestamp: new Date(atMs).toISOString(), gitBranch: 'MARKERBRANCH', ...extra });
const claudePrompt = (atMs) => claudeRecord('user', atMs, { message: { role: 'user', content: 'MARKERPROMPT' } });
const claudeReply = (atMs) => claudeRecord('assistant', atMs, { message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'MARKERREPLY' }] } });
const claudeTool = (atMs, id, name = 'Bash', input = { command: 'MARKERPROMPT' }) =>
  claudeRecord('assistant', atMs, { message: { content: [{ type: 'tool_use', id, name, input }] } });
const claudeResult = (atMs, id, extra = {}) => claudeRecord('user', atMs,
  { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'MARKEROUTPUT' }] }, ...extra });
const claudeLaunch = (atMs, toolId, agentId) => [claudeTool(atMs, toolId, 'Agent', { prompt: 'MARKERPROMPT', run_in_background: true }),
  claudeResult(atMs + 100, toolId, { toolUseResult: { isAsync: true, status: 'async_launched', agentId } })];
const claudeNotice = (atMs, agentId, status) => claudeRecord('user', atMs,
  { message: { content: `<task-notification><task-id>${agentId}</task-id><status>${status}</status></task-notification>` } });
const claudeMessage = (atMs) => claudeRecord('user', atMs, { isMeta: true, message: { content:
  'MARKERPROMPT\n<cross-session-message from-session="local_00000000-0000-4000-8000-000000000001">MARKERPROMPT</cross-session-message>' } });
const claudeFailure = (atMs) => claudeRecord('result', atMs, { is_error: true, result: 'MARKERREPLY' });
const claudeLimit = (atMs, resetsAtMs) => claudeRecord('assistant', atMs, { isApiErrorMessage: true, error: 'rate_limit',
  quotaLimits: { status: 'rejected', resetsAt: resetsAtMs / 1000 }, message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'MARKERREPLY' }] } });
const claudeTitles = (atMs) => [claudeRecord('custom-title', atMs, { customTitle: 'MARKERTITLE' }), claudeRecord('agent-name', atMs, { agentName: 'MARKERNAME' })];
// Records with no lifecycle meaning, so the tail never gives the lifecycle.
const claudeFiller = (atMs, bytes) => {
  const lines = [];
  for (let size = 0; size < bytes; size += 1100) lines.push(claudeRecord('progress', atMs, { data: `MARKEROUTPUT ${'x'.repeat(1024)}` }));
  return lines;
};

// A Claude Desktop source in `home`: one session file and one transcript in the project folder for each name.
// A transcript is a list of lines, or a string for a transcript that does not end with a newline.
async function claudeSource(home, transcripts, maxBytes = 64 * 1024) {
  const appDir = path.join(home, 'Claude'), projectsDir = path.join(home, 'projects');
  const sessions = path.join(appDir, 'claude-code-sessions'), project = path.join(projectsDir, 'MARKERPROJECT');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  const paths = {};
  for (const [index, [name, lines]] of Object.entries(transcripts).entries()) {
    paths[name] = path.join(project, `cli-${name}.jsonl`);
    await fs.writeFile(paths[name], typeof lines === 'string' ? lines : jsonl(lines));
    const metadata = path.join(sessions, `local_${name}.json`);
    await fs.writeFile(metadata, JSON.stringify({ sessionId: `local_${name}`, cliSessionId: `cli-${name}`, cwd: path.join(home, 'MARKERCWD'),
      createdAt: NOW_MS - 200 * 60_000, lastActivityAt: NOW_MS - index * 60_000 }));
    await fs.utimes(metadata, NOW_MS / 1000, NOW_MS / 1000);
  }
  return { options: { appDir, projectsDir, maxBytes }, paths, project };
}
const claudeRow = (rows, name) => rows.find((row) => row.externalId === `local_${name}`);
// Rows with the same sort time come in the order their reads end, so the tests compare rows in ID order.
const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

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
  // Claude Desktop transcripts larger than the tail of 64 KiB, with the lifecycle event before the tail.
  const claudeBig = 2 * 1024 * 1024;
  const cut = claudeRecord('assistant', at(3), { message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'MARKERREPLY' }] } });
  const claudeScenarios = {
    cworking: [claudePrompt(at(30)), claudeTool(at(29), 'work'), ...claudeFiller(at(2), claudeBig)],
    cdone: [claudePrompt(at(90)), claudeReply(at(80)), ...claudeFiller(at(70), claudeBig)],
    cfailed: [claudePrompt(at(90)), claudeFailure(at(85)), ...claudeFiller(at(80), claudeBig)],
    cagent: [claudePrompt(at(60)), ...claudeLaunch(at(59), 'launch', 'kid'), claudeReply(at(58)), ...claudeFiller(at(5), claudeBig)],
    cquestion: [claudePrompt(at(20)), ...claudeFiller(at(19), claudeBig),
      claudeTool(at(2), 'ask', 'AskUserQuestion', { questions: [{ question: 'MARKERQUESTION?' }] })],
    climited: [claudePrompt(at(50)), claudeLimit(at(49), NOW_MS + 3_600_000), ...claudeFiller(at(48), claudeBig)],
    cmessages: [claudePrompt(at(70)), claudeReply(at(69)), claudeMessage(at(68)), claudeReply(at(67)), ...claudeTitles(at(67)),
      ...claudeFiller(at(66), claudeBig)],
    cunfinished: `${jsonl([claudePrompt(at(40)), claudeTool(at(39), 'work'), ...claudeFiller(at(3), claudeBig)])}${cut.slice(0, 40)}`,
  };
  const claudeAppends = {
    cworking: [claudeReply(at(1))],
    cdone: [claudePrompt(at(5)), ...claudeFiller(at(1), 4096)],
    cagent: [claudeNotice(at(2), 'kid', 'completed'), claudeReply(at(1))],
    cquestion: [claudeResult(at(1), 'ask'), ...claudeFiller(at(1), 2048)],
    cunfinished: [cut.slice(40), ...claudeFiller(at(2), 2048)],
  };
  const claude = await claudeSource(home, claudeScenarios);
  // A running background agent: its own transcript, written one minute ago.
  const child = path.join(claude.project, 'cli-cagent', 'subagents', 'agent-kid.jsonl');
  await fs.mkdir(path.dirname(child), { recursive: true });
  await fs.writeFile(child, jsonl([claudeRecord('user', at(4), { isMeta: true, isSidechain: true, message: { content: 'MARKERPROMPT' } }),
    claudeTool(at(1), 'child-work')]));
  await fs.utimes(child, at(1) / 1000, at(1) / 1000);

  const a = await engine({ file, key: KEY, dashboard, claude: claude.options, nowMs: NOW_MS });
  const codexRows = (run) => run.threads.filter((row) => !row.externalId?.startsWith('local_'));
  assert.equal(codexRows(a).length, 7);
  assert.equal(a.stats.loaded, 0);
  // Before the appends, the rows of run A are the rows of a full read too: a working row, a pending question, and a running agent.
  assert.equal(codexRows(a).find((row) => row.title === 'working').state, 'working');
  assert.equal(codexRows(a).find((row) => row.title === 'question').questionPending, true);
  assert.equal(claudeRow(a.threads, 'cworking').state, 'working');
  assert.equal(claudeRow(a.threads, 'cquestion').questionPending, true);
  assert.equal(claudeRow(a.threads, 'cagent').state, 'working');
  for (const [name, lines] of Object.entries(appends)) await fs.appendFile(path.join(sessions, `rollout-${name}.jsonl`), jsonl(lines));
  for (const [name, lines] of Object.entries(claudeAppends)) await fs.appendFile(claude.paths[name], jsonl(lines));
  const b = await engine({ file, key: KEY, dashboard, claude: claude.options, nowMs: NOW_MS });
  const c = await engine({ dashboard, claude: claude.options, nowMs: NOW_MS });
  assert.deepEqual(byId(b.threads), byId(c.threads));
  const states = Object.fromEntries(codexRows(c).map((row) => [row.title, row.state]));
  assert.deepEqual(states, { working: 'idle', done: 'working', failed: 'idle', aborted: 'idle', question: 'working', limited: 'idle', unfinished: 'idle' });
  assert.equal(codexRows(c).find((row) => row.title === 'limited').limitResetsAtMs, NOW_MS + 3_600_000);
  assert.equal(codexRows(c).find((row) => row.title === 'failed').lastOutcome, 'failed');
  const claudeStates = Object.fromEntries(Object.keys(claudeScenarios).map((name) => [name, claudeRow(c.threads, name).state]));
  assert.deepEqual(claudeStates, { cworking: 'idle', cdone: 'working', cfailed: 'idle', cagent: 'idle', cquestion: 'working',
    climited: 'idle', cmessages: 'idle', cunfinished: 'idle' });
  assert.equal(claudeRow(c.threads, 'climited').limitResetsAtMs, NOW_MS + 3_600_000);
  assert.equal(claudeRow(c.threads, 'cfailed').lastOutcome, 'failed');
  assert.equal(claudeRow(c.threads, 'cquestion').questionPending, false);
  assert.ok(b.codexStats.taken >= 7, `Codex taken: ${b.codexStats.taken}`);
  assert.equal(b.claudeStats.taken, 8);
  const total = (run) => run.dashboardBytes + run.claudeBytes;
  assert.ok(total(b) * 10 < total(c), `bytes B ${total(b)}, C ${total(c)}`);
  assert.ok(b.claudeBytes * 10 < c.claudeBytes, `Claude bytes B ${b.claudeBytes}, C ${c.claudeBytes}`);
  t.diagnostic(`bytes read: run B Codex ${b.dashboardBytes} Claude ${b.claudeBytes}, run C Codex ${c.dashboardBytes} Claude ${c.claudeBytes}`);
});

test('a new engine with saved reader positions gives the same Codex source status as a full read', async (t) => {
  const home = await temporaryDirectory(t);
  const sessions = path.join(home, 'MARKERDIR', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const at = (minutes) => NOW_MS - minutes * 60_000;
  // The 256 KiB tail of the dashboard has no lifecycle event, so each log is scanned in full and gets a saved record.
  const logs = ['one', 'two'].map((name) => path.join(sessions, `rollout-${name}.jsonl`));
  for (const log of logs) {
    await fs.writeFile(log, jsonl([event(at(30), { type: 'task_started' }), ...filler(at(1), 2 * 1024 * 1024)]));
  }
  const databasePath = path.join(home, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('create table threads(id text primary key, rollout_path text, source text, updated_at_ms integer, archived integer);');
  logs.forEach((log, index) => database.prepare('insert into threads values (?, ?, ?, ?, 0)')
    .run(`0000000${index}-0000-4000-8000-000000000000`, log, 'vscode', at(index)));
  database.close();
  const dashboard = { databasePath, sessionIndexPath: path.join(home, 'session_index.jsonl'), globalStatePath: path.join(home, 'global.json') };
  const file = path.join(home, 'cache', 'asb', 'readers', 'positions.json');
  const warning = { id: 'codex', label: 'Codex', status: 'warning', message: 'ASB cannot read the Codex session logs, so Codex cards show Unknown.' };
  const ready = { id: 'codex', label: 'Codex', status: 'ready', message: '' };
  const providers = (run) => run.providers.filter((provider) => provider.id === 'codex');

  const a = await engine({ file, key: KEY, dashboard, nowMs: NOW_MS });
  assert.deepEqual(providers(a), [ready]);
  for (const log of logs) await fs.appendFile(log, jsonl(filler(at(0.5), 4096)));
  // The new engine takes both saved positions, and a restored read is a read: the status is the status of a full read.
  const b = await engine({ file, key: KEY, dashboard, nowMs: NOW_MS });
  assert.ok(b.codexStats.taken >= 2, `Codex taken: ${b.codexStats.taken}`);
  assert.deepEqual(providers(b), [ready]);
  assert.deepEqual(providers(await engine({ dashboard, nowMs: NOW_MS })), [ready]);
  // A saved position does not hide a log that is gone.
  await fs.rm(logs[0]);
  assert.deepEqual(providers(await engine({ file, key: KEY, dashboard, nowMs: NOW_MS })), [ready]);
  await fs.rm(logs[1]);
  assert.deepEqual(providers(await engine({ file, key: KEY, dashboard, nowMs: NOW_MS })), [warning]);
  assert.deepEqual(providers(await engine({ dashboard, nowMs: NOW_MS })), [warning]);
});

test('a new engine with saved reader positions keeps the row time of the last turn after an open writes settings entries', async (t) => {
  const home = await temporaryDirectory(t);
  const sessions = path.join(home, 'MARKERDIR', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const at = (minutes) => NOW_MS - minutes * 60_000;
  const turn = (start, end) => [event(at(start), { type: 'task_started' }),
    event(at(end + 0.1), { type: 'agent_message', message: 'MARKERREPLY', phase: 'final_answer' }), event(at(end), { type: 'task_complete' })];
  // A settings entry has about 2 KB, so 160 of them are larger than the 256 KiB tail of the engine: its tail has no turn entry.
  const settings = (count, minutes) => Array.from({ length: count }, () => event(at(minutes), { type: 'thread_settings_applied',
    thread_id: 'synthetic', thread_settings: { text: `MARKERSETTINGS ${'x'.repeat(2000)}` } }));
  const scenarios = {
    many: [...turn(95, 80), ...settings(160, 30)],
    few: [...turn(100, 85), ...settings(10, 30)],
    later: [...turn(90, 75), ...settings(160, 30)],
  };
  const appends = { many: settings(5, 2), few: settings(3, 2), later: turn(1, 0.2) };
  const expected = { before: { many: at(80), few: at(85), later: at(75) }, after: { many: at(80), few: at(85), later: at(0.2) } };
  const databasePath = path.join(home, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`create table threads(id text primary key, rollout_path text, cwd text, title text, source text,
    created_at_ms integer, updated_at_ms integer, archived integer);`);
  const insert = database.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, 0)');
  for (const [index, [name, lines]] of Object.entries(scenarios).entries()) {
    const rolloutPath = path.join(sessions, `rollout-${name}.jsonl`);
    await fs.writeFile(rolloutPath, jsonl(lines));
    // The open moved the database time to one minute ago.
    insert.run(`0000000${index}-0000-4000-8000-000000000000`, rolloutPath, path.join(home, 'MARKERCWD', name), name, 'vscode', at(120), at(1));
  }
  database.close();
  const dashboard = { databasePath, sessionIndexPath: path.join(home, 'session_index.jsonl'), globalStatePath: path.join(home, 'global.json') };
  const file = path.join(home, 'cache', 'asb', 'readers', 'positions.json');
  const timeOf = (run) => Object.fromEntries(run.threads.filter((row) => row.title in scenarios).map((row) => [row.title, row.updatedAtMs]));

  const a = await engine({ file, key: KEY, dashboard, nowMs: NOW_MS });
  assert.deepEqual(timeOf(a), expected.before);
  for (const [name, lines] of Object.entries(appends)) await fs.appendFile(path.join(sessions, `rollout-${name}.jsonl`), jsonl(lines));
  const b = await engine({ file, key: KEY, dashboard, nowMs: NOW_MS });
  const c = await engine({ dashboard, nowMs: NOW_MS });
  assert.deepEqual(timeOf(c), expected.after, 'a full read');
  assert.deepEqual(timeOf(b), expected.after, 'a new engine with saved positions');
  assert.deepEqual(byId(b.threads), byId(c.threads));
  assert.ok(b.codexStats.taken >= 2, `Codex taken: ${b.codexStats.taken}`);
  const text = (await fs.readFile(file)).toString('latin1');
  for (const marker of [...MARKERS, 'MARKERSETTINGS', home, '/', '\\']) assert.equal(text.includes(marker), false, marker);
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

// Measured on main (ba1ecdc) with the same synthetic set: the reader with no positions reads the same bytes and gives the same signals,
// except the four text fields (`firstUserMessage`, `latestUserMessage`, `latestMeaningfulUserMessage`, `lastAgentMessage`) that the reader no longer keeps:
// the digest is the digest of the signals of 52a1849 with these four fields removed.
// To measure again: ASB_HEAD_ROOT=file:///<copy of main>/ node --test --test-name-pattern="same bytes" test/reader-positions.test.mjs
const HEAD_OFF = { lifecycleBytes: 3371140, tailBytes: 240640, digest: 'a1535b3488ff596dea3172c09fb0d6b1c928bc31c24223439724005fa0289476' };

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
const recordKey = (filePath, key = KEY, section = 'codex') => createHmac('sha256', Buffer.from(key, 'hex')).update(`${section}\0${filePath}`)
  .digest().subarray(0, 16).toString('hex');
const claudeKey = (filePath) => recordKey(filePath, KEY, 'claude');

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
  const claude = await plainClaude(directory, 1);
  await engine({ file, key: KEY, files: fileConfig(files), claudeOnly: claude.options, nowMs: NOW_MS });
  const saved = await readSaved(file);
  const [template] = saved.codex.records;
  const [claudeTemplate] = saved.claude.records;
  const atMs = Date.now();
  const copy = (index, extra = {}, from = template) => ({ ...structuredClone(from), k: randomBytes(16).toString('hex'), atMs: atMs - index * 1000, ...extra });
  saved.codex.records = [...Array.from({ length: 6000 }, (_, index) => copy(index)),
    copy(-1, { questions: [['call_big', 0, 1, Array.from({ length: 60_000 }, (_, index) => index)]] }),
    copy(-2, { atMs: atMs - 31 * 24 * 60 * 60 * 1000 })];
  // The Claude section has its own limit of records: its newest 5000 stay, also when they are older than the Codex records.
  saved.claude.records = Array.from({ length: 5050 }, (_, index) => copy(index + 0.5, {}, claudeTemplate));
  // The test file must stay under the file limit, or the load drops it all.
  assert.ok(JSON.stringify(saved).length < MAX_POSITION_FILE_BYTES - 256 * 1024);
  await fs.rm(file);
  await writeSaved(file, saved);
  const run = await engine({ file, key: KEY, files: [] });
  assert.deepEqual([run.codexStats.loaded, run.claudeStats.loaded], [6001, 5050]);
  const value = await readSaved(file);
  const kept = value.codex.records;
  assert.equal(kept.length, MAX_POSITION_RECORDS);
  assert.deepEqual(kept.map((record) => record.atMs), Array.from({ length: 5000 }, (_, index) => atMs - index * 1000));
  assert.ok(kept.every((record) => JSON.stringify(record).length <= MAX_POSITION_RECORD_BYTES));
  assert.deepEqual(value.claude.records.map((record) => record.atMs), Array.from({ length: 5000 }, (_, index) => atMs - (index + 0.5) * 1000));
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

// Random Claude transcripts: all kinds of records that a Claude record saves, with times that only go forward.
function claudeWriter(random) {
  let atMs = NOW_MS - 48 * 60 * 60_000, next = 0;
  const pick = (items) => items[Math.floor(random() * items.length)];
  const step = () => (atMs += 1000 + Math.floor(random() * 120_000));
  const agents = [], wrapUps = [];
  const kinds = [
    () => [claudePrompt(step())],
    () => [claudeReply(step())],
    () => [claudeTool(step(), `tool_${next += 1}`)],
    () => [claudeFailure(step())],
    () => [claudeRecord('system', step(), { subtype: 'turn_aborted' })],
    () => { agents.push(`agent_${next += 1}`); return claudeLaunch(step(), `launch_${next}`, agents.at(-1)); },
    () => (agents.length ? [claudeNotice(step(), pick(agents), pick(['completed', 'failed', 'killed']))] : []),
    () => [claudeMessage(step())],
    () => [claudeLimit(step(), atMs + 3_600_000)],
    () => { wrapUps.push(`wrap_${next += 1}`); return [claudeTool(step(), wrapUps.at(-1), 'mcp__ccd_turn__wrap_up', random() < 0.5 ? { ask: 'MARKERQUESTION' } : {})]; },
    () => (wrapUps.length ? [claudeResult(step(), pick(wrapUps))] : []),
    () => [claudeTool(step(), `ask_${next += 1}`, 'AskUserQuestion', { questions: [{ question: 'MARKERQUESTION?' }] })],
  ];
  return { random, events: (count) => Array.from({ length: count }, () => pick(kinds)()).flat(), filler: (bytes) => claudeFiller(atMs, bytes),
    reply: () => claudeReply(step()) };
}

test('Claude lifecycle positions from disk give the result of a full read after appends', async (t) => {
  const home = await temporaryDirectory(t);
  const writers = Array.from({ length: 40 }, (_, index) => claudeWriter(seededRandom(7000 + index)));
  const part = (writer) => [...writer.events(5 + Math.floor(writer.random() * 50)), ...writer.filler(Math.floor(writer.random() * 6000))];
  // Some transcripts end in the middle of a line, so the saved offset is before the end of the file.
  const cuts = writers.map((writer) => (writer.random() < 0.3 ? writer.reply() : ''));
  const claude = await claudeSource(home, Object.fromEntries(writers.map((writer, index) => [`r${index}`,
    `${jsonl([...part(writer), ...writer.filler(16 * 1024), ...part(writer)])}${cuts[index].slice(0, 30)}`])), 4096);
  const file = path.join(home, 'readers', 'positions.json');
  await engine({ file, key: KEY, claudeOnly: claude.options, nowMs: NOW_MS });
  for (const [index, writer] of writers.entries()) {
    await fs.appendFile(claude.paths[`r${index}`], `${cuts[index] ? `${cuts[index].slice(30)}\n` : ''}${jsonl(part(writer))}`);
  }
  const b = await engine({ file, key: KEY, claudeOnly: claude.options, nowMs: NOW_MS });
  const c = await engine({ claudeOnly: claude.options, nowMs: NOW_MS });
  assert.equal(c.claudeThreads.length, 40);
  assert.deepEqual(byId(b.claudeThreads), byId(c.claudeThreads));
  assert.deepEqual(b.claudeStats, { loaded: 40, taken: 40 });
  assert.ok(b.claudeBytes * 3 < c.claudeBytes, `B ${b.claudeBytes}, C ${c.claudeBytes}`);
});

// Measured with the same synthetic set: the reader with no positions reads the same bytes and gives the same rows as d9700f1,
// except `updatedAtMs` and `status` (the row time now ignores records with no turn, and the file time of the session file),
// and the four text fields that the reader no longer keeps (the digest is the digest of the rows of 52a1849 with these four fields removed).
// To measure again: ASB_HEAD_ROOT=file:///<copy of the same commit>/ node --test --test-name-pattern="Claude reader reads the same" test/reader-positions.test.mjs
const CLAUDE_HEAD_OFF = { bytes: 939657, digest: 'c5eb3445555838336ccdd132c60f902d3d1835b52d8056487d84b3ddfa102365' };

test('with no positions the Claude reader reads the same bytes and gives the same rows as before positions', async (t) => {
  const home = await temporaryDirectory(t);
  const writers = Array.from({ length: 30 }, (_, index) => claudeWriter(seededRandom(8000 + index)));
  const claude = await claudeSource(home, Object.fromEntries(writers.map((writer, index) => [`r${index}`,
    [...writer.events(30), ...writer.filler(12 * 1024), ...writer.events(20)]])), 4096);
  const script = `
const claude = await import(new URL('src/claude-data.mjs', process.env.ASB_ROOT));
const fs = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const config = JSON.parse(process.env.ASB_CONFIG);
// Paths differ for each run and each platform, so a string with the test folder is left out. Rows go in ID order.
const rows = async () => JSON.stringify((await claude.loadClaudeDesktopCodeThreads({ ...config.options, nowMs: config.nowMs })).threads
  .sort((a, b) => a.id.localeCompare(b.id)), (key, value) => (typeof value === 'string' && value.includes(config.home) ? '' : value));
const times = async () => { for (const file of config.files) await fs.utimes(file, config.nowMs / 1000, config.nowMs / 1000); };
await times();
const results = [await rows()];
for (const [index, file] of config.files.entries()) await fs.appendFile(file, config.appends[index]);
await times();
results.push(await rows());
process.stdout.write(JSON.stringify({ bytes: claude.getClaudeCacheStats().jsonlSignals.bytesRead,
  digest: createHash('sha256').update(JSON.stringify(results)).digest('hex') }));
`;
  const files = writers.map((_, index) => claude.paths[`r${index}`]);
  const config = { options: claude.options, nowMs: NOW_MS, home, files, appends: writers.map((writer) => jsonl(writer.events(15))) };
  const root = process.env.ASB_HEAD_ROOT || ROOT;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, ASB_ROOT: root, ASB_CONFIG: JSON.stringify(config) }, maxBuffer: 64 * 1024 * 1024 });
  if (process.env.ASB_HEAD_ROOT) t.diagnostic(stdout);
  else assert.deepEqual(JSON.parse(stdout), CLAUDE_HEAD_OFF);
});

// Claude transcripts whose tail has no lifecycle record, so each read scans the full transcript and each transcript gets a record.
async function plainClaude(home, count, bytes = 100 * 1024) {
  const names = Array.from({ length: count }, (_, index) => `p${index}`);
  const claude = await claudeSource(home, Object.fromEntries(names.map((name) => [name, [claudePrompt(NOW_MS - 600_000),
    ...claudeLaunch(NOW_MS - 590_000, 'launch', 'kid'), claudeMessage(NOW_MS - 580_000), claudeTool(NOW_MS - 570_000, 'wrap', 'mcp__ccd_turn__wrap_up'),
    claudeTool(NOW_MS - 560_000, 'send', 'SendMessage'), ...claudeFiller(NOW_MS - 500_000, bytes)]])), 4096);
  const append = (name) => fs.appendFile(claude.paths[name], jsonl([claudeReply(NOW_MS - 1000), ...claudeFiller(NOW_MS, 2048)]));
  return { ...claude, names, append };
}

test('a saved Claude record that does not agree with its transcript gives a full read and the same rows', async (t) => {
  const home = await temporaryDirectory(t);
  const claude = await plainClaude(home, 7);
  const file = path.join(home, 'readers', 'positions.json');
  await engine({ file, key: KEY, claudeOnly: claude.options, nowMs: NOW_MS });
  const saved = await readSaved(file);
  assert.equal(saved.claude.records.length, 7);
  const [truncated, replaced, touched, guarded, otherDevice, swapped, control] = claude.names.map((name) => claude.paths[name]);
  const recordFor = (transcript) => saved.claude.records.find((record) => record.k === claudeKey(transcript));
  const guardSize = recordFor(guarded).size;
  // All transcripts grow, but the touched one keeps its size.
  for (const name of claude.names.filter((_, index) => index !== 2)) await claude.append(name);
  // Truncation and growth with the same inode.
  const bytes = await fs.readFile(truncated);
  await fs.writeFile(truncated, bytes.subarray(0, 1000));
  await fs.appendFile(truncated, bytes.subarray(990));
  // A new file with the old name.
  await fs.writeFile(`${replaced}.new`, await fs.readFile(replaced));
  await fs.rename(`${replaced}.new`, replaced);
  // The same size with a new modification time.
  const old = await fs.stat(touched);
  await fs.utimes(touched, old.atime, new Date(old.mtimeMs + 5000));
  // One changed byte in the guard bytes of a transcript that also grew.
  const handle = await fs.open(guarded, 'r+');
  await handle.write(Buffer.from('y'), 0, 1, guardSize - 10);
  await handle.close();
  // Another device for one record, and the keys of two records swapped.
  recordFor(otherDevice).dev += 1;
  const swapA = recordFor(swapped), swapB = recordFor(control);
  const controlRecord = structuredClone(swapB);
  [swapA.k, swapB.k] = [swapB.k, swapA.k];
  await writeSaved(file, saved);
  const b = await engine({ file, key: KEY, claudeOnly: claude.options, nowMs: NOW_MS });
  const c = await engine({ claudeOnly: claude.options, nowMs: NOW_MS });
  assert.deepEqual(byId(b.claudeThreads), byId(c.claudeThreads));
  let sizes = 0;
  for (const transcript of Object.values(claude.paths)) sizes += (await fs.stat(transcript)).size;
  assert.ok(b.claudeBytes >= sizes, `B ${b.claudeBytes}, sizes ${sizes}`);
  // The control transcript with its own record resumes and reads only its tail and new bytes.
  await fs.rm(file);
  await writeSaved(file, { ...saved, claude: { ...saved.claude, records: [controlRecord] } });
  await claude.append('p6');
  const resumed = await engine({ file, key: KEY, claudeOnly: claude.options, nowMs: NOW_MS });
  const full = await engine({ claudeOnly: claude.options, nowMs: NOW_MS });
  assert.deepEqual(byId(resumed.claudeThreads), byId(full.claudeThreads));
  assert.equal(resumed.claudeStats.taken, 1);
  assert.ok(full.claudeBytes - resumed.claudeBytes > (await fs.stat(control)).size - 32 * 1024,
    `resumed ${resumed.claudeBytes}, full ${full.claudeBytes}`);
});

test('a phase 1 file loads its Codex records; a bad Claude section or record drops only its own records', async (t) => {
  const home = await temporaryDirectory(t);
  const rollouts = await plainRollouts(home, 1);
  const claude = await plainClaude(home, 3);
  const file = path.join(home, 'readers', 'positions.json');
  const run = () => engine({ file, key: KEY, files: fileConfig(rollouts), claudeOnly: claude.options, nowMs: NOW_MS });
  await run();
  const good = await fs.readFile(file, 'utf8');
  assert.equal(JSON.parse(good).claude.records.length, 3);
  await rollouts[0].append();
  for (const name of claude.names) await claude.append(name);
  const full = await engine({ files: fileConfig(rollouts), claudeOnly: claude.options, nowMs: NOW_MS });
  const edit = (change) => { const copy = JSON.parse(good); change(copy); return copy; };
  const check = async (content, claudeStats, name) => {
    await fs.rm(file, { force: true });
    await writeSaved(file, content);
    const result = await run();
    assert.deepEqual([result.codexStats, result.claudeStats], [{ loaded: 1, taken: 1 }, claudeStats], name);
    assert.deepEqual(result.files.map((item) => item.signals), full.files.map((item) => item.signals), name);
    assert.deepEqual(byId(result.claudeThreads), byId(full.claudeThreads), name);
  };
  // A file of phase 1 has only the codex section.
  await check(edit((copy) => { delete copy.claude; }), { loaded: 0, taken: 0 }, 'phase 1 file');
  await check(edit((copy) => { copy.claude.code = '0'.repeat(64); }), { loaded: 0, taken: 0 }, 'other Claude code hash');
  await check(edit((copy) => { copy.claude.records = {}; }), { loaded: 0, taken: 0 }, 'Claude records not a list');
  const target = claudeKey(claude.paths.p1);
  const records = {
    'bad kind': (record) => { record.lifecycle.kind = 'MARKERREPLY'; },
    'bad agent kind': (record) => { record.lifecycle.agents[0][5] = 'working'; },
    'negative offset': (record) => { record.offset = -1; },
    'offset after size': (record) => { record.offset = record.size + 1; },
    'other guard size': (record) => { record.guardBytes = 63; },
    'agent ID with a space': (record) => { record.lifecycle.agents[0][0] = 'kid one'; },
    'tool ID with a slash': (record) => { record.lifecycle.agentTools[0][0] = 'launch/MARKERFOLDER'; },
    'two agents with one ID': (record) => { record.lifecycle.agents.push(record.lifecycle.agents[0]); },
    'short agent row': (record) => { record.lifecycle.agents[0].pop(); },
    'workflow not 0 or 1': (record) => { record.lifecycle.agentTools[0][3] = true; },
    'message sender with text': (record) => { record.lifecycle.messages[0][0] = 'MARKERPROMPT text'; },
    '21 messages': (record) => { record.lifecycle.messages = Array.from({ length: 21 }, (_, index) => [`local_${index}`, index]); },
    'text field': (record) => { record.note = 'MARKERPROMPT'; },
    'text in the lifecycle': (record) => { record.lifecycle.latestUserMessage = 'MARKERPROMPT'; },
  };
  for (const [name, change] of Object.entries(records)) {
    await check(edit((copy) => change(copy.claude.records.find((record) => record.k === target))), { loaded: 2, taken: 2 }, name);
  }
});

test('the Claude records have no message text, title, path, folder name, branch, or raw guard bytes', async (t) => {
  const home = path.join(await temporaryDirectory(t), 'MARKERFOLDER');
  const transcript = (toolId) => [claudePrompt(NOW_MS - 600_000), ...claudeTitles(NOW_MS - 599_000), claudeReply(NOW_MS - 598_000),
    claudePrompt(NOW_MS - 590_000), ...claudeLaunch(NOW_MS - 589_000, toolId, 'kid'), claudeMessage(NOW_MS - 580_000),
    claudeTool(NOW_MS - 570_000, 'wrap', 'mcp__ccd_turn__wrap_up', { ask: 'MARKERQUESTION' }), claudeResult(NOW_MS - 569_000, 'wrap'),
    claudeTool(NOW_MS - 560_000, 'ask', 'AskUserQuestion', { questions: [{ question: 'MARKERQUESTION?' }] }),
    ...claudeFiller(NOW_MS - 500_000, 16 * 1024)];
  // A tool ID with a space or a slash is not a plain ID: that transcript gets no record.
  const claude = await claudeSource(home, { ok: transcript('launch'), space: transcript('launch one'), slash: transcript('launch/MARKERFOLDER') }, 4096);
  const file = path.join(home, 'cache', 'readers', 'positions.json');
  const run = await engine({ file, key: KEY, claudeOnly: claude.options, nowMs: NOW_MS });
  assert.equal(run.claudeThreads.length, 3);
  const raw = await fs.readFile(file);
  const text = raw.toString('latin1');
  for (const marker of [...CLAUDE_MARKERS, 'MARKERFOLDER', home, path.basename(home), '/', '\\']) assert.equal(text.includes(marker), false, marker);
  for (const transcript of Object.values(claude.paths)) {
    const guard = (await fs.readFile(transcript)).subarray(-64);
    assert.equal(raw.includes(guard), false);
    assert.equal(text.includes(guard.toString('hex')), false);
  }
  const value = JSON.parse(text);
  assert.deepEqual(value.claude.records.map((record) => record.k), [claudeKey(claude.paths.ok)]);
  const { lifecycle } = value.claude.records[0];
  assert.deepEqual([lifecycle.agents.length, lifecycle.agentTools.length, lifecycle.wrapUps.length, lifecycle.messages.length], [1, 1, 1, 1]);
  const strings = [];
  const walk = (item) => {
    if (typeof item === 'string') strings.push(item);
    else if (item && typeof item === 'object') Object.values(item).forEach(walk);
  };
  walk(value.claude);
  const kinds = new Set(['', 'task_started', 'task_complete', 'failed', 'cancelled']);
  const ids = new Set(['kid', 'launch', 'wrap', 'local_00000000-0000-4000-8000-000000000001']);
  for (const item of strings) assert.ok(/^[0-9a-f]{32}$|^[0-9a-f]{64}$/.test(item) || kinds.has(item) || ids.has(item), item);
});

