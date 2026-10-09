import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applySessionIndexTitles,
  applyCodexPinnedThreadIds,
  parseCodexPinnedThreadIds,
  parseSessionIndex,
  parseRolloutSignals,
  readThreads,
  readRolloutSignals,
} from '../src/codex-data.mjs';

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
  assert.equal(signals.completionHint, true);
  assert.equal(signals.latestAgentFinalAtMs, 1777444508583);
  assert.equal(signals.latestMessageKind, 'agent');
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
  assert.equal(signals.latestMessageKind, 'user');
});

test('tracks first and latest meaningful Codex user text', () => {
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-04-29T06:30:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Please review the sample project and prepare a detailed report for the example team.',
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T06:35:08.583Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T06:36:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '继续' },
    }),
    JSON.stringify({
      timestamp: '2026-04-29T06:40:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Please include the updated sample data in the report.' },
    }),
  ].join('\n');

  const signals = parseRolloutSignals(jsonl);

  assert.equal(signals.firstUserMessage, 'Please review the sample project and prepare a detailed report for the example team.');
  assert.equal(signals.latestUserMessage, 'Please include the updated sample data in the report.');
  assert.equal(signals.latestMeaningfulUserMessage, 'Please include the updated sample data in the report.');
});

test('keeps bounded raw Codex user text with file, image, and link content', () => {
  const message = [
    '# Files mentioned by the user:',
    '## synthetic-image.png: /tmp/synthetic-image.png',
    '## My request for Codex:',
    'https://example.test/report',
    'Review the synthetic report.',
    '<image name="example" path="/tmp/synthetic-image.png"></image>',
  ].join('\n');
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-06-18T07:56:48.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message },
    }),
  ].join('\n');
  const signals = parseRolloutSignals(jsonl);
  assert.equal(signals.firstUserMessage, message.replace(/\s+/g, ' ').trim());
  assert.equal(signals.latestUserMessage, signals.firstUserMessage);
  assert.equal(signals.latestMeaningfulUserMessage, signals.firstUserMessage);
  assert.doesNotMatch(signals.firstUserMessage, /\[图片\]|\[外部链接\]|\[文件\]/);
  const long = parseRolloutSignals(JSON.stringify({ payload: { type: 'user_message', message: 'x'.repeat(600) } }));
  assert.equal(long.firstUserMessage, `${'x'.repeat(497)}...`);
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

test('marks threads missing from the Codex sidebar index', () => {
  const rows = applySessionIndexTitles([
    { id: 'visible-thread', title: 'Stored title' },
    { id: 'hidden-thread', title: 'Old title' },
  ], new Map([
    ['visible-thread', 'Sidebar title'],
  ]));

  assert.equal(rows[0].thread_name, 'Sidebar title');
  assert.equal(rows[0].in_codex_sidebar, true);
  assert.equal(rows[1].thread_name, undefined);
  assert.equal(rows[1].in_codex_sidebar, false);
});

test('reads Codex native pinned thread ids from global state', () => {
  assert.deepEqual(parseCodexPinnedThreadIds({
    'pinned-thread-ids': ['thread-a', '', 12, 'thread-b', 'thread-a'],
  }), ['thread-a', 'thread-b']);
  assert.deepEqual(parseCodexPinnedThreadIds({}), []);
});

test('marks rows with Codex native pinned state', () => {
  const rows = applyCodexPinnedThreadIds([
    { id: 'thread-a', title: 'A' },
    { id: 'thread-b', title: 'B' },
  ], ['thread-b']);

  assert.equal(rows[0].pinned, false);
  assert.equal(rows[1].pinned, true);
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
  assert.equal(signals.latestMessageKind, 'agent');
});

test('ignores malformed rollout jsonl lines', () => {
  const signals = parseRolloutSignals('{bad json}\n{"type":"event_msg","payload":{"type":"message"}}');

  assert.equal(signals.agentRunning, null);
  assert.equal(signals.completionHint, false);
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
