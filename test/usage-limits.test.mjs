import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invalidateClaudeData, loadClaudeDesktopCodeThreads, parseClaudeJsonlSignals } from '../src/claude-data.mjs';
import { loadCodexDashboard, parseRolloutSignals, readRolloutSignals } from '../src/codex-data.mjs';
import { buildSwitchboardDashboard, PendingTracker } from '../src/switchboard.mjs';

const id = '123e4567-e89b-12d3-a456-426614174000';
const now = Date.parse('2026-10-07T14:00:00Z');
const resetSeconds = Math.floor(now / 1000) + 3600;
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-usage-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Codex rollout records. The shapes follow the real token_count and task_complete records.
const codex = (offset, payload) => ({ timestamp: new Date(now + offset).toISOString(), type: 'event_msg', payload });
const window = (usedPercent, resetsAt = resetSeconds, windowMinutes = 300) =>
  ({ used_percent: usedPercent, window_minutes: windowMinutes, resets_at: resetsAt });
const tokenCount = (offset, primary, secondary = window(29, resetSeconds + 100_000, 10080), credits = null) => codex(offset, {
  type: 'token_count', info: { total_token_usage: { input_tokens: 10 } },
  rate_limits: { limit_id: 'codex', limit_name: null, primary, secondary, credits, individual_limit: null,
    spend_control_reached: null, plan_type: 'plus', rate_limit_reached_type: null },
});
const started = (offset) => codex(offset, { type: 'task_started' });
const complete = (offset) => codex(offset, { type: 'task_complete', last_agent_message: null });
const failed = (offset, kind = 'usage_limit_exceeded') => codex(offset, { type: 'task_complete', last_agent_message: null,
  error: { codex_error_info: kind, message: 'Synthetic error text.' } });
const filler = (offset) => codex(offset, { type: 'tool_output', text: 'x'.repeat(200) });
const fillers = (from, count) => Array.from({ length: count }, (_, index) => filler(from + index));
const resetMs = resetSeconds * 1000;
const limitOf = (records) => parseRolloutSignals(jsonl(records)).limitResetsAtMs;

// A failed turn writes this record. It has no windows.
const premium = (offset) => codex(offset, {
  type: 'token_count', info: { total_token_usage: { input_tokens: 10 } },
  rate_limits: { limit_id: 'premium', limit_name: null, primary: null, secondary: null, credits: null, individual_limit: null,
    spend_control_reached: null, plan_type: null, rate_limit_reached_type: null },
});
// Pro accounts have only a weekly primary window.
const proCount = (offset, primary) => codex(offset, {
  type: 'token_count', info: { total_token_usage: { input_tokens: 10 } },
  rate_limits: { limit_id: 'codex', limit_name: null, primary, secondary: null, credits: null, individual_limit: null,
    spend_control_reached: null, plan_type: 'pro', rate_limit_reached_type: null },
});

test('Codex gives a reset only for a turn that ended with the usage-limit error', () => {
  // Accounts with credits keep working past a full window.
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(100), undefined, { has_credits: true, unlimited: false, balance: '5' }),
    complete(-7000)]), 0);
  // Codex stops the turn before a window shows 100 percent, and the failed turn writes a premium record with no windows.
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(98)), premium(-7100), failed(-7000)]), resetMs);
  assert.equal(limitOf([started(-9000), premium(-7100), failed(-7000)]), 0);
  // A Pro weekly window gives a reset days away.
  const proResetSeconds = Math.floor(now / 1000) + 5 * 24 * 3600;
  assert.equal(limitOf([started(-9000), proCount(-8000, window(97, proResetSeconds, 10080)), premium(-7100), failed(-7000)]),
    proResetSeconds * 1000);
  // The most-used window wins, and on a tie the later reset wins.
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(92), window(95, resetSeconds + 50, 10080)), failed(-7000)]),
    (resetSeconds + 50) * 1000);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(90, resetSeconds + 5), window(90, resetSeconds + 9, 10080)), failed(-7000)]),
    (resetSeconds + 9) * 1000);
  // The newest window record wins, also when an older one was fuller.
  assert.equal(limitOf([started(-9000), tokenCount(-8500, window(100, resetSeconds + 900)), tokenCount(-8000, window(95)), premium(-7500),
    failed(-7000)]), resetMs);
  // A window that resets at or before the stop does not count, so a less-used full window that resets later wins.
  const stopSeconds = Math.floor((now - 7000) / 1000);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(101, stopSeconds), window(100, resetSeconds, 10080)), failed(-7000)]), resetMs);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(99, stopSeconds), window(98, resetSeconds, 10080)), failed(-7000)]), resetMs);
  // A record far below the refusal level cannot explain the stop, so it gives no days-away reset.
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(40), window(60, resetSeconds + 4 * 24 * 3600, 10080)), premium(-7100),
    failed(-7000)]), 0);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(89.9)), failed(-7000)]), 0);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(90)), failed(-7000)]), resetMs);
  // An error-only retry turn uses the window record of an earlier turn.
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(97)), complete(-7000), started(-6000), failed(-5900)]), resetMs);
  // A stop with no known reset, a running turn, a later normal end, and other errors give no limit.
  const stop = parseRolloutSignals(jsonl([started(-9000), failed(-8900)]));
  assert.deepEqual([stop.limitStopped, stop.limitResetsAtMs], [true, 0]);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(97)), failed(-7000), started(-6000)]), 0);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(97)), failed(-7000), started(-6000), complete(-5000)]), 0);
  for (const kind of ['cyber_policy', 'server_overloaded', null]) {
    assert.equal(limitOf([started(-9000), tokenCount(-8000, window(97)), failed(-7000, kind)]), 0, String(kind));
  }
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(97)), codex(-7000, { type: 'task_complete', error: 'usage_limit_exceeded' })]), 0);
  assert.equal(limitOf([started(-9000), tokenCount(-8000, window(97)), failed(-7000), codex(-6000, { type: 'turn_aborted' })]), 0);
});

async function tokenCountParses(read) {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = (...values) => {
    if (String(values[0]).includes('"token_count"')) count += 1;
    return parse(...values);
  };
  try {
    return { value: await read(), count };
  } finally {
    JSON.parse = parse;
  }
}

test('Codex lifecycle scan parses only token_count lines with a window and its appends give the full result', async (t) => {
  const dir = await temp(t);
  const filePath = path.join(dir, 'rollout.jsonl');
  const options = { initialBytes: 2048, maxBytes: 2048 };
  // The tail has no lifecycle event, so the reader scans the full log.
  await writeFile(filePath, jsonl([started(-90_000), ...Array.from({ length: 500 }, (_, index) => tokenCount(-89_000 + index, window(index % 100))),
    tokenCount(-60_000, window(100)), premium(-59_500), complete(-59_000), ...fillers(-50_000, 20)]));
  const first = await tokenCountParses(() => readRolloutSignals(filePath, options));
  assert.deepEqual([first.value.agentRunning, first.value.limitResetsAtMs, first.count], [false, 0, 501]);

  await appendFile(filePath, jsonl([started(-40_000), tokenCount(-39_500, window(95)), premium(-39_200), failed(-39_000), ...fillers(-30_000, 20)]));
  const appended = await tokenCountParses(() => readRolloutSignals(filePath, options));
  assert.equal(appended.count, 1);
  assert.deepEqual([appended.value.agentRunning, appended.value.limitResetsAtMs], [false, resetMs]);

  const copy = path.join(dir, 'copy.jsonl');
  await copyFile(filePath, copy);
  const full = await tokenCountParses(() => readRolloutSignals(copy, options));
  assert.equal(full.count, 502);
  assert.deepEqual(appended.value, full.value);
});

test('Codex finds the window record before the tail when the tail has the stop', async (t) => {
  const dir = await temp(t);
  const filePath = path.join(dir, 'rollout.jsonl');
  const records = [started(-90_000), tokenCount(-89_000, window(96)), complete(-88_000), ...fillers(-80_000, 20),
    started(-6000), premium(-5950), failed(-5900)];
  await writeFile(filePath, jsonl(records));
  const signals = await readRolloutSignals(filePath, { initialBytes: 2048, maxBytes: 2048 });
  assert.deepEqual([signals.agentRunning, signals.limitResetsAtMs], [false, resetMs]);
  assert.deepEqual(signals, Object.fromEntries(Object.entries(parseRolloutSignals(jsonl(records)))));
});

async function codexHome(t, rollouts) {
  const dir = await temp(t);
  const dbPath = path.join(dir, 'state_5.sqlite');
  const database = new DatabaseSync(dbPath);
  database.exec(`create table threads (
    id text primary key, rollout_path text, created_at integer, updated_at integer,
    created_at_ms integer, updated_at_ms integer, source text, model_provider text,
    cwd text, title text, sandbox_policy text, approval_mode text, tokens_used integer,
    archived integer, git_sha text, git_branch text, git_origin_url text, cli_version text,
    first_user_message text, agent_nickname text, agent_role text, memory_mode text,
    model text, reasoning_effort text, name text, is_pinned integer, thread_source text,
    originator text, agent_path text, creator_account_id text, creator_user_id text
  );`);
  const insert = database.prepare('insert into threads (id, source, cwd, title, thread_source, archived, updated_at_ms, rollout_path) values (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [index, records] of rollouts.entries()) {
    const rollout = path.join(dir, `rollout-${index}.jsonl`);
    await writeFile(rollout, jsonl(records));
    insert.run(id.replace(/0$/, String(index)), 'vscode', '/work/ASB', `Synthetic ${index}`, 'user', 0, now - index, rollout);
  }
  database.close();
  const { threads } = await loadCodexDashboard({ databasePath: dbPath, sessionIndexPath: path.join(dir, 'absent-index'),
    globalStatePath: path.join(dir, 'absent-state'), nowMs: now });
  return new Map(threads.map((thread) => [thread.id, thread]));
}

test('Codex rows use the profile reset for a stop without its own window record, only while the reset is in the future', async (t) => {
  const threads = await codexHome(t, [
    [started(-9000), premium(-1100), failed(-1000)],
    [started(-9000), tokenCount(-6500, window(96, resetSeconds + 60)), complete(-6000)],
    [started(-9000), tokenCount(-8000, window(98, resetSeconds - 60)), premium(-7100), failed(-7000)],
    [started(-9000), complete(-8900)],
  ]);
  const limits = [0, 1, 2, 3].map((index) => threads.get(id.replace(/0$/, String(index))).limitResetsAtMs);
  assert.deepEqual(limits, [(resetSeconds + 60) * 1000, 0, (resetSeconds - 60) * 1000, 0]);
  const board = buildSwitchboardDashboard([...threads.values()], [], now);
  const row = board.threads.find((item) => item.id === id);
  assert.deepEqual([row.state, row.limitResetsAtMs], ['idle', (resetSeconds + 60) * 1000]);
  for (const item of board.threads) assert.equal(Object.keys(item).some((key) => key !== 'limitResetsAtMs' && key.startsWith('limit')), false);
  assert.equal(buildSwitchboardDashboard([...threads.values()], [], (resetSeconds + 60) * 1000).threads
    .find((item) => item.id === id).limitResetsAtMs, 0);

  // A stop with no known reset in the whole home gives no limit.
  const alone = await codexHome(t, [[started(-9000), failed(-8900)], [started(-9000), complete(-8900)]]);
  assert.deepEqual([...alone.values()].map((thread) => thread.limitResetsAtMs), [0, 0]);
});

// A full window seen a day ago, with a reset after that stop but before now.
const day = 24 * 3600 * 1000;
const oldResetSeconds = Math.floor((now - day) / 1000) + 5 * 3600;
const oldStop = [started(-day), tokenCount(-day + 1000, window(100, oldResetSeconds)), failed(-day + 2000)];

test('Codex counts its own reset only when it is after the stop', () => {
  // A retry fails at once and writes no new window record, so the old reset is stale.
  assert.equal(limitOf([...oldStop, started(-60_000), failed(-59_000)]), 0);
  assert.equal(limitOf(oldStop), oldResetSeconds * 1000);
});

test('Codex rows use the newest home window record at or before the stop', async (t) => {
  const threads = await codexHome(t, [
    [started(-70_000), failed(-59_000)],
    [started(-90_000), tokenCount(-80_000, window(97)), complete(-79_000)],
    // A newer record after the stop of thread 0 does not count for it.
    [started(-9000), tokenCount(-8000, window(100, resetSeconds + 900)), failed(-7000)],
  ]);
  assert.deepEqual([0, 1, 2].map((index) => threads.get(id.replace(/0$/, String(index))).limitResetsAtMs),
    [resetMs, 0, (resetSeconds + 900) * 1000]);

  // The newest record at or before the stop has a reset at or before the stop, so a newer future reset does not count.
  const stale = await codexHome(t, [
    [started(-70_000), tokenCount(-60_000, window(98, Math.floor((now - 30_000) / 1000))), complete(-50_000)],
    [started(-40_000), failed(-30_000)],
    [started(-25_000), tokenCount(-20_000, window(100)), failed(-10_000)],
  ]);
  assert.deepEqual([0, 1, 2].map((index) => stale.get(id.replace(/0$/, String(index))).limitResetsAtMs), [0, 0, resetMs]);

  // A low own snapshot does not explain a stop after the other session that was near the limit works again.
  const stopOffset = -2 * 3600 * 1000;
  const resumed = await codexHome(t, [
    [started(stopOffset - 7_300_000), tokenCount(stopOffset - 7_200_000, window(40, resetSeconds - 3600),
      window(60, resetSeconds + 4 * 24 * 3600, 10080)), complete(stopOffset - 7_100_000), started(stopOffset - 1000), premium(stopOffset - 500),
    failed(stopOffset)],
    [started(stopOffset - 900_000), tokenCount(stopOffset - 600_000, window(97, resetSeconds - 3600)), complete(stopOffset - 500_000),
      started(-30 * 60_000), tokenCount(-29 * 60_000, window(2, resetSeconds + 4 * 3600)), complete(-28 * 60_000)],
  ]);
  assert.equal(resumed.get(id).limitResetsAtMs, 0);
});

test('Codex applies the stop-time rule in the full scan before the tail, and its appends give the full result', async (t) => {
  const dir = await temp(t);
  const filePath = path.join(dir, 'rollout.jsonl');
  const options = { initialBytes: 2048, maxBytes: 2048 };
  const records = [...oldStop, ...fillers(-80_000, 20), started(-6000), failed(-5900)];
  await writeFile(filePath, jsonl(records));
  const first = await readRolloutSignals(filePath, options);
  assert.deepEqual([first.agentRunning, first.limitStopped, first.limitResetsAtMs], [false, true, 0]);
  assert.deepEqual(first, Object.fromEntries(Object.entries(parseRolloutSignals(jsonl(records)))));

  await appendFile(filePath, jsonl([...fillers(-5000, 20), started(-4000), failed(-3900)]));
  const appended = await tokenCountParses(() => readRolloutSignals(filePath, options));
  assert.equal(appended.count, 0);
  const copy = path.join(dir, 'copy.jsonl');
  await copyFile(filePath, copy);
  const full = await readRolloutSignals(copy, options);
  assert.deepEqual([full.limitResetsAtMs, full.limitStoppedAtMs], [0, now - 3900]);
  assert.deepEqual(appended.value, full);
});

// Claude transcript records. The shape follows the real usage-limit error record.
const claude = (type, offset, extra = {}) => ({ type, timestamp: new Date(now + offset).toISOString(), ...extra });
const prompt = (offset) => claude('user', offset, { message: { role: 'user', content: 'Continue this work.' } });
const answer = (offset) => claude('assistant', offset, { message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } });
const limitError = (offset, quotaLimits = { status: 'rejected', rateLimitType: 'seven_day', resetsAt: resetSeconds,
  isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', unifiedRateLimitFallbackAvailable: false }) =>
  claude('assistant', offset, { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, ...(quotaLimits ? { quotaLimits } : {}),
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit · resets 4pm" }] } });

test('Claude transcripts give the reset only from a usage-limit error record with quotaLimits', () => {
  const limit = (records) => parseClaudeJsonlSignals(jsonl(records)).lifecycle.limitResetsAtMs;
  assert.equal(limit([prompt(-5000), limitError(-4000)]), resetSeconds * 1000);
  assert.equal(limit([prompt(-5000), limitError(-4000, null)]), 0);
  assert.equal(limit([prompt(-5000), limitError(-4000, { status: 'rejected', resetsAt: String(resetSeconds) })]), 0);
  assert.equal(limit([prompt(-5000), limitError(-4000), answer(-3000)]), 0);
  assert.equal(limit([prompt(-5000), limitError(-4000), prompt(-3000)]), 0);
  assert.equal(limit([prompt(-5000), answer(-4500), limitError(-4000)]), resetSeconds * 1000);
});

test('Claude Desktop threads carry the limit, also from the full lifecycle scan of a large transcript', async (t) => {
  const dir = await temp(t);
  const appDir = path.join(dir, 'Claude'), projectsDir = path.join(dir, 'projects');
  const file = path.join(projectsDir, 'project', 'cli_root.jsonl');
  const metadata = path.join(appDir, 'claude-code-sessions', `local_${id}.json`);
  await mkdir(path.dirname(metadata), { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(metadata, JSON.stringify({ sessionId: `local_${id}`, cliSessionId: 'cli_root', cwd: '/tmp/synthetic-work',
    createdAt: now - 200_000, lastActivityAt: now }));
  await utimes(metadata, now / 1000, now / 1000);
  const progress = Array.from({ length: 40 }, (_, index) => claude('progress', -9000 + index, { data: 'x'.repeat(512) }));
  await writeFile(file, jsonl([prompt(-10_000), ...progress, limitError(-4000), ...progress.map((record) => ({ ...record, timestamp: new Date(now - 3000).toISOString() }))]));
  for (const maxBytes of [8 * 1024 * 1024, 256]) {
    invalidateClaudeData();
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, maxBytes, nowMs: now });
    assert.equal(threads[0].limitResetsAtMs, resetSeconds * 1000, `maxBytes ${maxBytes}`);
    const [row] = buildSwitchboardDashboard(threads, [], now).threads;
    assert.deepEqual([row.state, row.limitResetsAtMs], ['idle', resetSeconds * 1000], `maxBytes ${maxBytes}`);
  }
  await appendFile(file, jsonl([prompt(-2000)]));
  invalidateClaudeData();
  const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, maxBytes: 256, nowMs: now });
  assert.equal(threads[0].limitResetsAtMs, 0);
  assert.equal(buildSwitchboardDashboard(threads, [], now).threads[0].limitResetsAtMs, 0);
});

test('a limited row hides its unread mark until the reset and adds the reset to the status check', async () => {
  const resetMs = now + 3_600_000;
  const thread = (extra = {}) => ({ id, externalId: id, provider: 'codex', title: 'Synthetic', cwd: '/work/ASB', updatedAtMs: now - 60_000,
    lifecycleRunning: false, latestLifecycleKind: 'task_complete', latestLifecycleAtMs: now - 60_000, latestTaskEndedAtMs: now - 60_000,
    latestTaskEndKind: 'task_complete', limitResetsAtMs: resetMs, ...extra });
  const board = buildSwitchboardDashboard([thread()], [], now);
  assert.equal(board.threads[0].limitResetsAtMs, resetMs);
  assert.equal(board.nextStatusCheckAtMs, resetMs);
  const plain = buildSwitchboardDashboard([thread({ limitResetsAtMs: 0 })], [], now);
  // The row JSON has only the one new field.
  const rowKeys = ['id', 'externalId', 'provider', 'providerLabel', 'surface', 'machineId', 'machineName', 'remote', 'globalId',
    'remoteCache', 'title', 'cwd', 'projectName', 'archived', 'updatedAtMs',
    'subagentCount', 'state', 'reason', 'workingSinceMs', 'nativeUnread', 'readStatus', 'questionPending', 'actionRequired',
    'lastOutcome', 'failedAtMs', 'completionAtMs', 'canOpen', 'appDeepLink', 'limitResetsAtMs'];
  assert.deepEqual(Object.keys(board.threads[0]), rowKeys);
  assert.deepEqual(Object.keys(plain.threads[0]), rowKeys);
  assert.equal(plain.threads[0].limitResetsAtMs, 0);
  assert.ok(plain.nextStatusCheckAtMs > resetMs);
  // A Working row and a row with a required action are not limited.
  assert.equal(buildSwitchboardDashboard([thread({ lifecycleRunning: true, agentActivityAtMs: now - 1000, agentStartedAtMs: now - 5000 })], [], now)
    .threads[0].limitResetsAtMs, 0);
  assert.equal(buildSwitchboardDashboard([thread({ provider: 'claude-desktop-code', externalId: `local_${id}`, awaitingPermission: true,
    pendingToolCount: 1, pendingToolAtMs: now - 1000, pendingTools: [{ tool: 'Bash', signalAtMs: now - 1000 }] })], [], now).threads[0].limitResetsAtMs, 0);

  const tracker = new PendingTracker(false);
  await tracker.observe(buildSwitchboardDashboard([thread({ lifecycleRunning: true, agentActivityAtMs: now - 70_000,
    agentStartedAtMs: now - 90_000, latestLifecycleKind: 'task_started', limitResetsAtMs: 0 })], [], now - 65_000));
  const limited = (await tracker.observe(buildSwitchboardDashboard([thread()], [], now))).threads[0];
  assert.equal(limited.state, 'idle');
  assert.equal(limited.completionAttention, true);
  assert.deepEqual([limited.unread, limited.pending, limited.pendingSource], [false, false, '']);
  const after = (await tracker.observe(buildSwitchboardDashboard([thread()], [], resetMs))).threads[0];
  assert.equal(after.limitResetsAtMs, 0);
  assert.deepEqual([after.unread, after.pending, after.pendingSource], [true, true, 'observed-completion']);
});
