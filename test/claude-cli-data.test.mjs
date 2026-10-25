import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fsPromises } from 'node:fs';
import { appendFile, chmod, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadClaudeCliThreads } from '../src/claude-cli-data.mjs';
import { loadSwitchboardClaudeThreads } from '../src/claude-remote-data.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

async function configHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-claude-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectsDir = path.join(home, 'projects');
  await mkdir(path.join(projectsDir, 'project'), { recursive: true });
  await mkdir(path.join(home, 'sessions'));
  return { home, projectsDir };
}

// A finished CLI turn; `extra` records come before it. `openMs` writes only the prompt, that long before now: a task that is still open.
async function transcript(projectsDir, sessionId, { nowMs, entrypoint = 'cli', extra = [], ageMs = 0, openMs = 0 } = {}) {
  const at = (offset) => new Date(nowMs - ageMs + offset).toISOString();
  const file = path.join(projectsDir, 'project', `${sessionId}.jsonl`);
  await writeFile(file, jsonl([...extra,
    { type: 'user', timestamp: at(openMs ? -openMs : -60_000), sessionId, cwd: '/work/cli', entrypoint, message: { role: 'user', content: 'Secret prompt text' } },
    ...(openMs ? [] : [{ type: 'assistant', timestamp: at(-50_000), sessionId, message: { role: 'assistant', stop_reason: 'end_turn', content: 'Done.' } }]),
  ]));
  if (ageMs) await utimes(file, (nowMs - ageMs) / 1000, (nowMs - ageMs) / 1000);
  return file;
}

async function liveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  await once(child, 'spawn');
  return child.pid;
}

async function record(home, pid, fields) {
  await writeFile(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, procStart: await processStart(pid),
    name: '', cwd: '/work/live', entrypoint: 'cli', kind: 'interactive', startedAt: Date.now() - 120_000, status: 'idle', ...fields }));
}

test('Claude CLI rows come from live registry records and recent CLI transcripts only', async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  await transcript(projectsDir, 'live-with-transcript', { nowMs });
  await record(home, process.pid, { sessionId: 'live-with-transcript', name: 'Registry name', bridgeSessionId: 'session_01Bridge' });
  await record(home, await liveProcess(t), { sessionId: 'live-without-transcript', name: '' });
  await record(home, await liveProcess(t), { sessionId: 'live-desktop', name: 'Desktop', entrypoint: 'claude-desktop' });
  await transcript(projectsDir, 'recent-cli', { nowMs, ageMs: DAY_MS });
  await transcript(projectsDir, 'old-cli', { nowMs, ageMs: 8 * DAY_MS });
  await transcript(projectsDir, 'desktop-owned', { nowMs });
  await transcript(projectsDir, 'sdk-session', { nowMs, entrypoint: 'sdk-ts' });
  await mkdir(path.join(projectsDir, 'project', 'recent-cli', 'subagents'), { recursive: true });
  await writeFile(path.join(projectsDir, 'project', 'recent-cli', 'subagents', 'agent-child.jsonl'), jsonl([
    { type: 'user', timestamp: new Date(nowMs - 1000).toISOString(), sessionId: 'agent-child', entrypoint: 'cli', isSidechain: true,
      message: { role: 'user', content: 'Child prompt' } }]));
  const { threads } = await loadClaudeCliThreads({ projectsDir, nowMs, desktopSessionIds: new Set(['desktop-owned']) });
  const byId = new Map(threads.map((thread) => [thread.externalId, thread]));
  assert.deepEqual([...byId.keys()].sort(), ['live-with-transcript', 'live-without-transcript', 'recent-cli']);
  const live = byId.get('live-with-transcript');
  assert.deepEqual([live.id, live.provider, live.providerLabel, live.source, live.surface, live.canOpen, live.title, live.cwd,
    live.projectName, live.cliSessionId, live.cliNoTranscript], ['cli:live-with-transcript', 'claude-desktop-code', 'Claude Code CLI',
    'claude-cli', 'cli', false, 'Registry name', '/work/live', 'live', 'live-with-transcript', false]);
  assert.deepEqual(live.bridgeSessionIds, ['session_01Bridge']);
  const empty = byId.get('live-without-transcript');
  assert.deepEqual([empty.cliNoTranscript, empty.cwd, empty.title], [true, '/work/live', 'Claude Code session live-wit']);
  const recent = byId.get('recent-cli');
  assert.deepEqual([recent.cwd, recent.bridgeSessionIds, recent.embeddedSubagentCount], ['/work/cli', [], 1]);
  assert.equal(JSON.stringify(threads.map((thread) => thread.title)).includes('Secret prompt'), false);
  const board = buildSwitchboardDashboard(threads, [], nowMs);
  const rows = new Map(board.threads.map((row) => [row.externalId, row]));
  assert.deepEqual([rows.get('live-without-transcript').state, rows.get('live-without-transcript').reason],
    ['idle', 'The CLI session has no task yet.']);
  assert.deepEqual([rows.get('recent-cli').state, rows.get('recent-cli').surface, rows.get('recent-cli').canOpen], ['idle', 'cli', false]);
  // A live old transcript still shows; a registry `waiting` record gives Waiting.
  await transcript(projectsDir, 'live-with-transcript', { nowMs, ageMs: 9 * DAY_MS });
  await record(home, process.pid, { sessionId: 'live-with-transcript', name: 'Registry name', status: 'waiting',
    waitingFor: 'permission prompt', statusUpdatedAt: nowMs - 1000 });
  const waiting = buildSwitchboardDashboard((await loadClaudeCliThreads({ projectsDir, nowMs })).threads, [], nowMs)
    .threads.find((row) => row.externalId === 'live-with-transcript');
  assert.deepEqual([waiting.state, waiting.reason], ['waiting', 'Claude waits for your permission.']);
});

test('Claude CLI recent lists use the last turn, not a recently touched file', async (t) => {
  const nowMs = Date.now();
  const { projectsDir } = await configHome(t);
  const old = await transcript(projectsDir, 'touched-old', { nowMs, ageMs: 8 * DAY_MS });
  await utimes(old, nowMs / 1000, nowMs / 1000);
  await transcript(projectsDir, 'recent-turn', { nowMs, ageMs: DAY_MS });
  const { threads } = await loadClaudeCliThreads({ projectsDir, nowMs });
  assert.deepEqual(threads.map((thread) => thread.externalId), ['recent-turn']);
});

test('Claude CLI live records keep old turns with recently touched files', { skip: process.platform !== 'linux' }, async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  for (const id of ['live-old', 'not-live-old']) {
    const file = await transcript(projectsDir, id, { nowMs, ageMs: 8 * DAY_MS });
    await utimes(file, nowMs / 1000, nowMs / 1000);
  }
  await record(home, process.pid, { sessionId: 'live-old' });
  const { threads } = await loadClaudeCliThreads({ projectsDir, nowMs });
  assert.deepEqual(threads.map((thread) => [thread.externalId, thread.updatedAtMs]),
    [['live-old', nowMs - 8 * DAY_MS - 50_000]]);
});

test('Claude CLI titles use the registry name, then the title records, then a fallback, never prompt text', async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  const titleRecord = (type, field, value) => ({ type, [field]: value, sessionId: 'x' });
  await transcript(projectsDir, 'named', { nowMs, extra: [titleRecord('custom-title', 'customTitle', 'Custom')] });
  await record(home, process.pid, { sessionId: 'named', name: '  Registry\n  name ' });
  await transcript(projectsDir, 'custom', { nowMs, extra: [titleRecord('custom-title', 'customTitle', 'First'),
    titleRecord('agent-name', 'agentName', 'Agent'), titleRecord('custom-title', 'customTitle', 'Last custom')] });
  await transcript(projectsDir, 'agent', { nowMs, extra: [titleRecord('agent-name', 'agentName', 'Agent name'),
    titleRecord('custom-title', 'customTitle', 42)] });
  await transcript(projectsDir, '0123456789-fallback', { nowMs });
  const titles = Object.fromEntries((await loadClaudeCliThreads({ projectsDir, nowMs })).threads
    .map((thread) => [thread.externalId, thread.title]));
  assert.deepEqual(titles, { named: 'Registry name', custom: 'Last custom', agent: 'Agent name',
    '0123456789-fallback': 'Claude Code session 01234567' });
});

test('Claude CLI rows keep the 500 newest transcripts', async (t) => {
  const nowMs = Date.now();
  const { projectsDir } = await configHome(t);
  for (let index = 0; index < 501; index += 1) {
    await transcript(projectsDir, `session-${String(index).padStart(3, '0')}`, { nowMs, ageMs: (index + 1) * 60_000 });
  }
  const { threads } = await loadClaudeCliThreads({ projectsDir, nowMs });
  assert.equal(threads.length, 500);
  assert.equal(threads.some((thread) => thread.externalId === 'session-500'), false);
  assert.ok(threads.some((thread) => thread.externalId === 'session-499'));
});

test('the Claude source adds CLI rows after the desktop rows and keeps desktop transcripts as desktop rows', async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  const appDir = path.join(home, 'app');
  await transcript(projectsDir, 'cli-only', { nowMs });
  await transcript(projectsDir, 'desktop-cli', { nowMs });
  await transcript(projectsDir, 'desktop-prior', { nowMs });
  // No desktop store: the CLI rows still load, with a warning.
  const alone = await loadSwitchboardClaudeThreads({ appDir, projectsDir, nowMs, strictMetadataRead: true });
  assert.deepEqual([alone.threads.map((thread) => thread.externalId).sort(), alone.provider.status],
    [['cli-only', 'desktop-cli', 'desktop-prior'], 'warning']);
  const sessions = path.join(appDir, 'claude-code-sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, 'local_00000000-0000-4000-8000-000000000001.json'), JSON.stringify({
    sessionId: 'local_00000000-0000-4000-8000-000000000001', cliSessionId: 'desktop-cli', priorCliSessionIds: ['desktop-prior'],
    title: 'Desktop chat', lastActivityAt: nowMs - 1000 }));
  const merged = await loadSwitchboardClaudeThreads({ appDir, projectsDir, nowMs, strictMetadataRead: true });
  assert.deepEqual(merged.threads.map((thread) => [thread.source, thread.externalId]), [
    ['claude-desktop-code', 'local_00000000-0000-4000-8000-000000000001'], ['claude-cli', 'cli-only']]);
});

test('a Claude CLI session with a transcript copy in more than one project folder gives one row from the newest copy', async (t) => {
  const nowMs = Date.now();
  const { projectsDir } = await configHome(t);
  const files = {};
  for (const [name, folder, title, ageMs] of [['old', 'a-old', 'Old copy', 60_000], ['current', 'z-new', 'Current copy', 1000]]) {
    files[name] = path.join(projectsDir, folder, 'moved.jsonl');
    await mkdir(path.dirname(files[name]), { recursive: true });
    await writeFile(files[name], jsonl([{ type: 'custom-title', customTitle: title, sessionId: 'moved' },
      { type: 'user', timestamp: new Date(nowMs - ageMs).toISOString(), sessionId: 'moved', cwd: '/work/cli', entrypoint: 'cli',
        message: { role: 'user', content: 'Prompt' } }]));
    await utimes(files[name], (nowMs - ageMs) / 1000, (nowMs - ageMs) / 1000);
  }
  // The old copy comes last in walk order, so a reader that keeps the last copy gets the old copy.
  const readdir = fsPromises.readdir;
  t.mock.method(fsPromises, 'readdir', async (directory, ...rest) => {
    if (directory === path.dirname(files.old)) await new Promise((resolve) => setTimeout(resolve, 20));
    return readdir(directory, ...rest);
  });
  const { threads } = await loadClaudeCliThreads({ projectsDir, nowMs });
  assert.deepEqual(threads.map((thread) => [thread.externalId, thread.title]), [['moved', 'Current copy']]);
});

test('Claude CLI rows keep the time of the last turn when a resume writes records with no turn', async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  const file = await transcript(projectsDir, 'resumed', { nowMs, ageMs: DAY_MS });
  const turnAtMs = nowMs - DAY_MS - 50_000;
  const rowTime = async () => (await loadClaudeCliThreads({ projectsDir, nowMs })).threads.find((thread) => thread.externalId === 'resumed').updatedAtMs;
  assert.equal(await rowTime(), turnAtMs);
  // A resume appends records with no turn: some have a new timestamp, and the file time is new.
  await appendFile(file, jsonl([
    { type: 'attachment', timestamp: new Date(nowMs - 1000).toISOString(), attachment: { type: 'hook_success' } },
    { type: 'queue-operation', timestamp: new Date(nowMs - 1000).toISOString(), operation: 'enqueue' },
    { type: 'last-prompt', sessionId: 'resumed' }]));
  await utimes(file, nowMs / 1000, nowMs / 1000);
  await record(home, process.pid, { sessionId: 'resumed', startedAt: nowMs - 500 });
  assert.equal(await rowTime(), turnAtMs, 'the file time, the new records, and the process start do not count');
  // A new turn is activity.
  await appendFile(file, jsonl([{ type: 'user', timestamp: new Date(nowMs - 100).toISOString(), sessionId: 'resumed', message: { role: 'user', content: 'Again' } }]));
  assert.equal(await rowTime(), nowMs - 100);
  // A live session with no transcript has only its start.
  await record(home, await liveProcess(t), { sessionId: 'fresh', startedAt: nowMs - 5000 });
  const fresh = (await loadClaudeCliThreads({ projectsDir, nowMs })).threads.find((thread) => thread.externalId === 'fresh');
  assert.deepEqual([fresh.cliNoTranscript, fresh.updatedAtMs], [true, nowMs - 5000]);
});

test('a Claude CLI card with an open task shows Unknown when no live process has its session, and the fast scan stops', async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  // The state, the reason, and the refresh interval of a board that has only this card.
  const check = async (dir, sessionId) => {
    const row = (await loadClaudeCliThreads({ projectsDir: dir, nowMs })).threads.find((thread) => thread.externalId === sessionId);
    const board = buildSwitchboardDashboard([row], [], nowMs);
    return [board.threads[0].state, board.threads[0].reason, board.refreshIntervalMs];
  };
  const working = ['working', 'The local log has an open task.', 2_000];
  await transcript(projectsDir, 'dead', { nowMs, openMs: 60_000 });
  await transcript(projectsDir, 'alive', { nowMs, openMs: 60_000 });
  await transcript(projectsDir, 'desktop-process', { nowMs, openMs: 60_000 });
  await transcript(projectsDir, 'fresh', { nowMs, openMs: 2_000 });
  await transcript(projectsDir, 'closed', { nowMs });
  await record(home, process.pid, { sessionId: 'alive' });
  // A live process of another entrypoint still runs the session, so it is not an ended process.
  await record(home, await liveProcess(t), { sessionId: 'desktop-process', entrypoint: 'claude-desktop' });
  // A record of a process that is gone is not a live record.
  await record(home, 2 ** 22 + 1, { sessionId: 'dead', procStart: '1' });
  assert.deepEqual(await check(projectsDir, 'dead'), ['unknown', 'The CLI process ended during a task.', 5_000]);
  assert.deepEqual(await check(projectsDir, 'alive'), working);
  assert.deepEqual(await check(projectsDir, 'desktop-process'), working);
  // A turn of the last seconds can come before the registry record that names its session.
  assert.deepEqual(await check(projectsDir, 'fresh'), working);
  // No open task: the card stays Idle, with or without a process.
  assert.deepEqual(await check(projectsDir, 'closed'), ['idle', 'The last task ended.', 5_000]);
  // The same transcript with no registry folder (an old CLI) keeps its state.
  const old = await configHome(t);
  await rm(path.join(old.home, 'sessions'), { recursive: true });
  await transcript(old.projectsDir, 'dead', { nowMs, openMs: 60_000 });
  assert.deepEqual(await check(old.projectsDir, 'dead'), working);
  // Only Linux has a registry reader, so another system keeps the state of the transcript.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try { assert.deepEqual(await check(projectsDir, 'dead'), working); } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a Claude CLI registry that cannot be read does not end the open tasks', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const nowMs = Date.now();
  const { home, projectsDir } = await configHome(t);
  await transcript(projectsDir, 'open', { nowMs, openMs: 60_000 });
  await chmod(path.join(home, 'sessions'), 0o000);
  try {
    const [row] = (await loadClaudeCliThreads({ projectsDir, nowMs })).threads;
    assert.deepEqual([row.externalId, buildSwitchboardDashboard([row], [], nowMs).threads[0].state], ['open', 'working']);
  } finally { await chmod(path.join(home, 'sessions'), 0o700); }
});
