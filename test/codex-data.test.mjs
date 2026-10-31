import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  loadCodexDashboard,
  parseSessionIndex,
  parseRolloutSignals,
  readThreads,
  readRolloutSignals,
} from '../src/codex-data.mjs';
import { enrichThreads } from '../src/insights.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

async function createCodexStateDb(rowCount) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-state-'));
  const databasePath = path.join(dir, 'state.sqlite');
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const number = index + 1;
    const timestamp = 1_800_000_000_000 - index;
    return `(
      'thread-${number}',
      '/tmp/rollout-${number}.jsonl',
      ${Math.floor(timestamp / 1000)},
      ${Math.floor(timestamp / 1000)},
      'vscode',
      'openai',
      '/tmp/project',
      'Thread ${number}',
      'workspace-write',
      'never',
      ${number},
      0,
      '',
      '',
      '',
      '0.0.0',
      '',
      null,
      null,
      'enabled',
      'gpt-5.5',
      '',
      ${timestamp},
      ${timestamp}
    )`;
  }).join(',');

  const insertSql = rows ? `
    insert into threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, tokens_used, archived, git_sha, git_branch,
      git_origin_url, cli_version, first_user_message, agent_nickname, agent_role,
      memory_mode, model, reasoning_effort, created_at_ms, updated_at_ms
    ) values ${rows};
  ` : '';

  const sql = `
    create table threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      source text not null,
      model_provider text not null,
      cwd text not null,
      title text not null,
      sandbox_policy text not null,
      approval_mode text not null,
      tokens_used integer not null default 0,
      archived integer not null default 0,
      git_sha text,
      git_branch text,
      git_origin_url text,
      cli_version text not null default '',
      first_user_message text not null default '',
      agent_nickname text,
      agent_role text,
      memory_mode text not null default 'enabled',
      model text,
      reasoning_effort text,
      created_at_ms integer,
      updated_at_ms integer
    );
    ${insertSql}
  `;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }

  return databasePath;
}

test('reads the full Codex thread window by default for the dashboard', async () => {
  const databasePath = await createCodexStateDb(181);

  const rows = await readThreads({ databasePath });

  assert.equal(rows.length, 181);
});

test('keeps completion signals and ignores token-count events in rollout jsonl', () => {
  const jsonl = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 12,
            reasoning_output_tokens: 3,
            total_tokens: 112,
          },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: {
            used_percent: 6,
            window_minutes: 300,
            resets_at: 1777373828,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T06:35:08.583Z',
      type: 'response_item',
      payload: { type: 'agent_message', text: 'Done. Ready for review.', phase: 'final_answer' },
    }),
  ].join('\n');

  const signals = parseRolloutSignals(jsonl);

  for (const key of ['totalTokenUsage', 'totalTokenBreakdown', 'todayTokenUsage', 'rateLimits', 'modelContextWindow', 'artifacts']) {
    assert.equal(Object.hasOwn(signals, key), false);
  }
  assert.equal(signals.agentRunning, true);
  assert.equal(signals.latestAgentFinalAtMs, 1777444508583);
});

test('tracks a later user message after an agent final answer', () => {
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-04-29T06:35:08.583Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T06:36:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '再改一下' },
    }),
  ].join('\n');

  const signals = parseRolloutSignals(jsonl);

  assert.equal(signals.latestAgentFinalAtMs, 1777444508583);
  assert.equal(signals.latestUserMessageAtMs, 1777444560000);
});

test('parses Codex session index titles used by the sidebar', () => {
  const index = parseSessionIndex([
    JSON.stringify({
      id: '123e4567-e89b-42d3-a456-426614174003',
      thread_name: '调研 /goal 新命令',
      updated_at: '2026-05-08T14:04:31.849624Z',
    }),
    '{bad json}',
    JSON.stringify({ id: 'empty', thread_name: '' }),
  ].join('\n'));

  assert.equal(index.get('123e4567-e89b-42d3-a456-426614174003'), '调研 /goal 新命令');
  assert.equal(index.has('empty'), false);
});

test('takes the titles of the Codex sidebar index, and the own name of a thread wins', () => {
  const rows = [
    { id: 'visible-thread', title: 'Stored title' },
    { id: 'hidden-thread', title: 'Old title' },
    { id: 'named-thread', name: 'Own name', title: 'Stored title' },
  ];
  const before = JSON.stringify(rows);
  const threads = enrichThreads(rows, new Map([
    ['visible-thread', 'Sidebar title'],
    ['named-thread', 'Sidebar title'],
  ]));

  assert.equal(threads[0].title, 'Sidebar title');
  assert.equal(threads[1].title, 'Old title');
  // The own name of a thread wins over the index.
  assert.equal(threads[2].title, 'Own name');
  // The rows are read only: the kept result of the database query is made of such rows.
  assert.equal(JSON.stringify(rows), before);
});

test('keeps a thread in progress when commentary follows the latest user message', () => {
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-04-29T06:35:08.583Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:00:52.131Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '增加运行状态' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:01:13.213Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '我先看一下。', phase: 'commentary' },
    }),
  ].join('\n');

  const signals = parseRolloutSignals(jsonl);

  assert.equal(signals.latestAgentFinalAtMs, 1777444508583);
  assert.equal(signals.latestUserMessageAtMs, 1777446052131);
});

test('ignores malformed rollout jsonl lines', () => {
  const signals = parseRolloutSignals('{bad json}\n{"type":"event_msg","payload":{"type":"message"}}');

  assert.equal(signals.agentRunning, null);
});

test('skips rollout jsonl lines that parse to a non-object', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-non-object-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const started = JSON.stringify({ timestamp: '2026-04-29T07:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } });
  const junk = ['null', '5', '"text"', 'true', '[]'].join('\n');

  assert.equal(parseRolloutSignals(`${junk}\n${started}\n${junk}`).agentRunning, true);

  // The start is before the bounded tail, so the lifecycle scan must also skip the lines.
  const rolloutPath = path.join(dir, 'rollout.jsonl');
  await fs.writeFile(rolloutPath, [junk, started, junk,
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'x'.repeat(4096) } }), junk].join('\n'));
  const signals = await readRolloutSignals(rolloutPath, { initialBytes: 128, maxBytes: 512 });
  assert.equal(signals.agentRunning, true);
  assert.equal(signals.agentStartedAtMs, Date.parse('2026-04-29T07:00:00.000Z'));
});

test('a long user message of paths resolves questions without the path scan', () => {
  const message = Array.from({ length: 8000 }, (_, index) => `/tmp/synthetic/folder-${index}/file`).join(' ');
  assert.ok(message.length > 200 * 1024);
  const jsonl = [
    { payload: { type: 'task_started' } },
    { payload: { type: 'function_call', name: 'request_user_input', call_id: 'synthetic-question',
      arguments: JSON.stringify({ questions: [{ id: 'one' }] }) } },
    { payload: { type: 'user_message', message } },
  ].map(JSON.stringify).join('\n');
  const startedAt = performance.now();
  const signals = parseRolloutSignals(jsonl);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(signals.awaitingUserInput, false);
  assert.ok(elapsedMs < 200, `parse took ${elapsedMs.toFixed(0)} ms`);
});

test('expands the rollout tail when bulky output hides the latest user turn', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const rolloutPath = path.join(dir, 'rollout.jsonl');
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-04-29T06:35:08.583Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:00:52.131Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '继续改状态' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:01:00.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'x'.repeat(2048) },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:01:13.213Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '我先看一下。', phase: 'commentary' },
    }),
  ].join('\n');

  await fs.writeFile(rolloutPath, jsonl);

  const signals = await readRolloutSignals(rolloutPath, {
    initialBytes: 128,
    maxBytes: 8192,
  });

  assert.equal(signals.latestAgentFinalAtMs, 1777444508583);
  assert.equal(signals.latestUserMessageAtMs, 1777446052131);
});

test('finds an active task lifecycle before the bounded rollout tail', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-lifecycle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const rolloutPath = path.join(dir, 'rollout.jsonl');
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-04-29T07:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:01:00.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'x'.repeat(4096) },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T07:02:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 1600 },
          last_token_usage: { total_tokens: 100 },
        },
      },
    }),
  ].join('\n');

  await fs.writeFile(rolloutPath, jsonl);

  const signals = await readRolloutSignals(rolloutPath, {
    initialBytes: 128,
    maxBytes: 512,
  });

  assert.equal(signals.agentRunning, true);
  assert.equal(signals.agentStartedAtMs, Date.parse('2026-04-29T07:00:00.000Z'));
  assert.equal(signals.agentActivityAtMs, Date.parse('2026-04-29T07:02:00.000Z'));
});

async function createSyntheticDb(t, sql) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-codex-columns-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'state.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return { dir, databasePath };
}

test('reads Codex threads when the threads table lacks selected columns', async (t) => {
  const { dir, databasePath } = await createSyntheticDb(t, `
    create table threads (id text primary key, rollout_path text, title text, updated_at_ms integer);
    insert into threads values ('thread-1', '/tmp/missing-rollout.jsonl', 'Minimal thread', 1800000000000);
  `);

  const rows = await readThreads({ databasePath });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'thread-1');
  assert.equal(rows[0].title, 'Minimal thread');
  assert.equal(rows[0].tokens_used, null);
  assert.equal(rows[0].updated_at, null);

  const dashboard = await loadCodexDashboard({
    databasePath,
    sessionIndexPath: path.join(dir, 'missing-index.jsonl'),
    globalStatePath: path.join(dir, 'missing-global-state.json'),
    nowMs: 1_800_000_001_000,
  });
  assert.equal(dashboard.threads.find((thread) => thread.id === 'thread-1').title, 'Minimal thread');
});

test('reads Codex threads without goals when thread_goals lacks a goal column', async (t) => {
  const { databasePath } = await createSyntheticDb(t, `
    create table threads (id text primary key, rollout_path text, title text, updated_at_ms integer);
    insert into threads values ('thread-1', '/tmp/a.jsonl', 'First', 2), ('thread-2', '/tmp/b.jsonl', 'Second', 1);
    create table thread_goals (thread_id text, goal_id text, status text, tokens_used integer,
      time_used_seconds integer, created_at_ms integer, updated_at_ms integer);
    insert into thread_goals values ('thread-1', 'goal-1', 'active', 5, 6, 7, 8);
  `);

  const rows = await readThreads({ databasePath });
  assert.deepEqual(rows.map((row) => row.id), ['thread-1', 'thread-2']);
  for (const row of rows) {
    assert.equal(row.goal_id, null);
    assert.equal(row.goal_status, null);
  }
});

test('rollout entries that an open writes with no turn are not activity', () => {
  const entry = (offset, type, payload) => JSON.stringify({ timestamp: new Date(Date.parse('2026-10-08T12:00:00.000Z') + offset).toISOString(), type, payload });
  const lines = [
    entry(0, 'session_meta', { id: 'thread-1' }),
    entry(1000, 'event_msg', { type: 'task_started' }),
    entry(2000, 'turn_context', { turn_id: 'turn-1' }),
    entry(3000, 'event_msg', { type: 'agent_message', message: 'Done.', phase: 'final_answer' }),
    entry(4000, 'event_msg', { type: 'task_complete' }),
  ];
  const turnEndAtMs = Date.parse('2026-10-08T12:00:04.000Z');
  assert.equal(parseRolloutSignals(lines.join('\n')).latestEventAtMs, turnEndAtMs);
  const opened = [...lines,
    entry(60_000, 'event_msg', { type: 'thread_settings_applied', thread_id: 'thread-1', thread_settings: {} }),
    entry(120_000, 'session_meta', { id: 'thread-1' }),
    entry(180_000, 'turn_context', { turn_id: 'turn-2' }),
    // The flat form has the type at the top.
    JSON.stringify({ timestamp: '2026-10-08T13:00:00.000Z', type: 'thread_settings_applied' })];
  const signals = parseRolloutSignals(opened.join('\n'));
  assert.equal(signals.latestEventAtMs, turnEndAtMs);
  assert.equal(signals.latestLifecycleAtMs, turnEndAtMs);
  assert.equal(signals.agentRunning, false);
  // A rollout with no turn entry has no activity time.
  assert.equal(parseRolloutSignals(opened.slice(5).join('\n')).latestEventAtMs, null);
});

test('opening a Codex thread keeps the time and the place of its row until a new turn', async (t) => {
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
  const at = (minutes) => nowMs - minutes * 60_000;
  const entry = (minutes, payload, type = 'event_msg') => JSON.stringify({ timestamp: new Date(at(minutes)).toISOString(), type, payload });
  const turn = (start, end) => [entry(start, { type: 'task_started' }),
    entry(end + 0.1, { type: 'agent_message', message: 'Done.', phase: 'final_answer' }), entry(end, { type: 'task_complete' })];
  const settings = (minutes) => entry(minutes, { type: 'thread_settings_applied', thread_id: 'synthetic', thread_settings: {} });
  const { dir, databasePath } = await createSyntheticDb(t, `
    create table threads (id text primary key, rollout_path text, title text, source text, created_at_ms integer, updated_at_ms integer, archived integer);`);
  const rollouts = Object.fromEntries(['opened', 'other', 'bare'].map((name) => [name, path.join(dir, `rollout-${name}.jsonl`)]));
  const lines = (list) => `${list.join('\n')}\n`;
  await fs.writeFile(rollouts.opened, lines(turn(110, 100)));
  await fs.writeFile(rollouts.other, lines(turn(60, 50)));
  await fs.writeFile(rollouts.bare, lines([entry(120, { id: 'bare' }, 'session_meta'), settings(1)]));
  const database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  const insert = database.prepare('insert into threads values (?, ?, ?, ?, ?, ?, 0)');
  insert.run('opened', rollouts.opened, 'Opened', 'vscode', at(120), at(100));
  insert.run('other', rollouts.other, 'Other', 'vscode', at(120), at(50));
  insert.run('bare', rollouts.bare, 'Bare', 'vscode', at(120), at(1));
  insert.run('missing', path.join(dir, 'missing.jsonl'), 'Missing', 'vscode', at(120), at(7));
  const load = async () => {
    const { threads } = await loadCodexDashboard({ databasePath, sessionIndexPath: path.join(dir, 'index.jsonl'),
      globalStatePath: path.join(dir, 'global.json'), nowMs });
    return threads;
  };
  const order = async () => buildSwitchboardDashboard(await load(), [], nowMs).threads
    .filter((row) => ['opened', 'other'].includes(row.id)).map((row) => [row.id, row.updatedAtMs]);
  const times = async () => Object.fromEntries((await load()).map((thread) => [thread.id, thread.updatedAtMs]));
  assert.deepEqual(await times(), { opened: at(100), other: at(50), bare: at(1), missing: at(7) },
    'a rollout with no turn entry and a missing rollout keep the database time');
  assert.deepEqual(await order(), [['other', at(50)], ['opened', at(100)]]);

  // The app opens the old thread: it writes a settings entry, and Codex moves the database time.
  await fs.appendFile(rollouts.opened, lines([settings(1)]));
  database.prepare('update threads set updated_at_ms = ? where id = ?').run(at(1), 'opened');
  assert.deepEqual(await order(), [['other', at(50)], ['opened', at(100)]], 'the read row keeps its time and place');

  // A new turn is activity: the time and the place move.
  await fs.appendFile(rollouts.opened, lines(turn(0.5, 0.2)));
  database.prepare('update threads set updated_at_ms = ? where id = ?').run(at(0.2), 'opened');
  assert.deepEqual(await order(), [['opened', at(0.2)], ['other', at(50)]], 'a new turn moves the time and the card');
});
