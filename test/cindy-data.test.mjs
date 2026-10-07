import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  loadCindyThreads,
  normalizeCindySession,
  reconcileCindyOwnedHarnessThreads,
} from '../src/cindy-data.mjs';
import { reconcileProviderThreadCounts } from '../src/dashboard.mjs';

const execFileAsync = promisify(execFile);

test('normalizes Cindy as the frontend while retaining the selected harness', () => {
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  const thread = normalizeCindySession({
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Review combat UI',
    working_dir: '/Users/example/game',
    model: 'chatgpt/gpt-5.6-sol',
    status: 'active',
    sdk_session_id: '223e4567-e89b-12d3-a456-426614174000',
    total_token_usage: 1200,
    created_at: nowMs - 60_000,
    updated_at: nowMs - 10_000,
    agent_kind: 'cc',
    active_turn_started_at: nowMs - 30_000,
    last_turn_ended_at: nowMs - 50_000,
    embedded_subagent_count: 3,
    embedded_subagent_running_count: 1,
    embedded_subagent_updated_at: nowMs - 5_000,
  }, nowMs);

  assert.equal(thread.provider, 'cindy');
  assert.equal(thread.providerLabel, 'Cindy · Claude Code');
  assert.equal(thread.frontend, 'cindy');
  assert.equal(thread.harness, 'claude-code');
  assert.equal(thread.harnessSessionId, '223e4567-e89b-12d3-a456-426614174000');
  assert.equal(thread.appDeepLink, 'cindy://session/123e4567-e89b-12d3-a456-426614174000');
  assert.equal(thread.defaultOpenMode, 'cindy-deeplink');
  assert.equal(thread.embeddedSubagentCount, 3);
  assert.equal(thread.embeddedSubagentRunningCount, 1);
  assert.equal(thread.status, 'running');
});

test('loads Cindy workers as children of their authoritative Orca lead', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-threads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'cindy-test.db');
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');

  await execFileAsync('sqlite3', [databasePath, `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      working_dir TEXT,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      orca_role TEXT,
      workspace_kind TEXT NOT NULL,
      active_turn_started_at INTEGER,
      last_turn_ended_at INTEGER
    );
    CREATE TABLE orca_teams (
      id TEXT PRIMARY KEY,
      lead_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE orca_workers (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      label TEXT,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    INSERT INTO sessions VALUES
      ('lead', 'Lead task', '/Users/example/game', 'gpt-5.6-sol', 'active', 'sdk-lead', 100, ${nowMs - 60_000}, ${nowMs - 20_000}, 'codex', 'desktop', 'lead', 'project', NULL, ${nowMs - 30_000}),
      ('worker', 'Worker task', '/Users/example/game', 'claude-sonnet-4-6', 'active', 'sdk-worker', 20, ${nowMs - 50_000}, ${nowMs - 10_000}, 'cc', 'desktop', 'worker', 'project', NULL, ${nowMs - 15_000});
    INSERT INTO orca_teams VALUES ('team', 'lead', 'active', ${nowMs - 60_000}, ${nowMs - 20_000});
    INSERT INTO orca_workers VALUES ('worker-row', 'team', 'worker', 'done', 'reviewer', 'reviewer', ${nowMs - 50_000}, ${nowMs - 10_000});
    INSERT INTO subagent_runs VALUES ('sub-1', 'lead', 'completed', ${nowMs - 5_000}, NULL);
  `]);

  const result = await loadCindyThreads({
    cindyDatabasePath: databasePath,
    nowMs,
  });
  const lead = result.threads.find((thread) => thread.id === 'cindy:lead');
  const worker = result.threads.find((thread) => thread.id === 'cindy:worker');

  assert.equal(result.provider.status, 'ready');
  assert.equal(lead.embeddedSubagentCount, 1);
  assert.equal(worker.isSubagent, true);
  assert.equal(worker.parentThreadId, 'cindy:lead');
  assert.equal(worker.agentNickname, 'reviewer');
  assert.equal(worker.agentRole, 'reviewer');
  assert.deepEqual(new Set(result.ownedHarnessSessionIds), new Set(['sdk-lead', 'sdk-worker']));
});

test('prefers the Cindy frontend over duplicate raw harness sessions', () => {
  const cindyThread = {
    id: 'cindy:lead',
    provider: 'cindy',
    harnessSessionId: 'sdk-lead',
  };
  const result = reconcileCindyOwnedHarnessThreads([
    { id: 'claude-code-cli:sdk-lead', provider: 'claude-code-cli', externalId: 'sdk-lead' },
    { id: 'codex-independent', provider: 'codex', externalId: 'codex-independent' },
  ], {
    threads: [cindyThread],
    ownedHarnessSessionIds: ['sdk-lead'],
  });

  assert.deepEqual(result.map((thread) => thread.id), ['codex-independent', 'cindy:lead']);
});

test('hides a raw harness provider when every session belongs to Cindy', () => {
  const providers = reconcileProviderThreadCounts([
    {
      id: 'claude-code-cli',
      label: 'Claude Code CLI',
      threadCount: 4,
      message: '已读取 4 个 CLI 任务',
    },
    { id: 'cindy', label: 'Cindy', threadCount: 1, message: '已读取 1 个 Cindy 任务' },
  ], [
    { id: 'cindy:lead', provider: 'cindy' },
  ]);

  assert.deepEqual(providers.map((provider) => provider.id), ['cindy']);
  assert.equal(providers[0].threadCount, 1);
});

test('keeps a raw harness provider only for independently owned sessions', () => {
  const providers = reconcileProviderThreadCounts([
    {
      id: 'claude-code-cli',
      label: 'Claude Code CLI',
      threadCount: 4,
      message: '已读取 4 个 CLI 任务',
    },
    { id: 'cindy', label: 'Cindy', threadCount: 1, message: '已读取 1 个 Cindy 任务' },
  ], [
    { id: 'claude-code-cli:standalone', provider: 'claude-code-cli' },
    { id: 'cindy:lead', provider: 'cindy' },
  ]);

  assert.equal(providers[0].id, 'claude-code-cli');
  assert.equal(providers[0].threadCount, 1);
  assert.match(providers[0].message, /1 个独立任务；3 个底层会话已归属宿主客户端/);
});
