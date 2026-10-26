import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { querySqliteJson } from '../src/codex-data.mjs';
import { openCodeUsageSql, readOpenCodeUsage } from '../src/usage-opencode.mjs';

const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
const SINCE = Date.parse('2026-10-01T00:00:00Z');
const secret = 'SECRET-TEXT-1234';
const counts = { input: 100, output: 40, reasoning: 10, cache: { read: 500, write: 20 } };

async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-opencode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function privateSql(sql) {
  assert.doesNotMatch(sql.replace(/json_(?:extract|type)\(data, '[^']*'\)/g, 'field'), /\bdata\b/);
}

const cliQuery = (file, sql) => querySqliteJson(file, sql, { native: null, run: async (command, args) => {
  assert.equal(command, 'sqlite3');
  assert.ok(args.includes('-readonly'));
  const db = new DatabaseSync(args.at(-2), { readOnly: true });
  try { return { stdout: JSON.stringify(db.prepare(args.at(-1)).all()) }; }
  finally { db.close(); }
} });

async function makeDatabase(t) {
  const dir = await folder(t);
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('create table session_message (id text, type text, time_created integer, data text)');
  const insert = db.prepare('insert into session_message values (?, ?, ?, ?)');
  const row = (id, type, created, data) => insert.run(id, type, created, JSON.stringify(data));
  row('m1', 'assistant', SINCE, { tokens: counts, model: { modelID: 'claude-test-5', id: 'wrong' }, time: { created: SINCE + 5000 } });
  row('m2', 'assistant', SINCE + 7200000, { tokens: counts, model: { id: 'gpt-test-1' } });
  row('m3', 'assistant', SINCE, { tokens: counts, model: 'gpt-test-2', content: secret.repeat(200_000), time: { created: SINCE + 9000 } });
  row('old', 'assistant', SINCE - 1000, { tokens: counts, model: 'gpt-test-1', time: { created: SINCE - 1000 } });
  row('user', 'user', SINCE, { tokens: counts, model: 'gpt-test-1', content: secret });
  row('empty', 'assistant', SINCE, { model: 'gpt-test-1' });
  db.close();
  return dir;
}

test('reads only token fields of assistant rows and the injected CLI path still works', { skip: !DatabaseSync }, async (t) => {
  const dir = await makeDatabase(t);
  const answers = [];
  const records = await readOpenCodeUsage(dir, SINCE, { native: null, query: async (file, sql) => {
    privateSql(sql);
    const rows = await cliQuery(file, sql);
    answers.push(JSON.stringify(rows));
    return rows;
  } });
  const tokens = { uncached: 100, cacheRead: 500, cacheWrite: 20, output: 50 };
  assert.deepEqual(records.sort((a, b) => a.timestampMs - b.timestampMs), [
    { app: 'opencode', timestampMs: SINCE + 5000, model: 'claude-test-5', tokens, dedupeKey: null },
    { app: 'opencode', timestampMs: SINCE + 9000, model: 'gpt-test-2', tokens, dedupeKey: null },
    { app: 'opencode', timestampMs: SINCE + 7200000, model: 'gpt-test-1', tokens, dedupeKey: null },
  ]);
  assert.equal(answers.length, 3);
  assert.ok(answers.every((answer) => !answer.includes(secret) && answer.length < 2000));
});

test('SQL uses JSON fields, never a bare data value, for both table layouts', () => {
  for (const table of ['session_message', 'message']) for (const timeCreated of [true, false]) {
    const sql = openCodeUsageSql(SINCE, { table, timeCreated, paged: true });
    privateSql(sql);
    assert.match(sql, new RegExp(`>= ${SINCE}`));
    assert.match(sql, /rowid > \? and rowid <= \?/);
    assert.equal(sql.includes('time_created'), timeCreated);
    assert.ok(sql.includes(table === 'message' ? "json_extract(data, '$.role') = 'assistant'" : "type = 'assistant'"));
  }
});

test('both tables and named databases count each id once in priority order', { skip: !DatabaseSync }, async (t) => {
  const dir = await makeDatabase(t);
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('create table message (id text, data text, time_created integer)');
  const insert = db.prepare('insert into message values (?, ?, ?)');
  const data = { role: 'assistant', modelID: 'grok-test', tokens: { input: 7, output: 2 } };
  insert.run('m1', JSON.stringify(data), SINCE + 1000);
  insert.run('only-message', JSON.stringify(data), SINCE + 1000);
  insert.run(null, JSON.stringify(data), SINCE + 1000);
  insert.run('user-message', JSON.stringify({ ...data, role: 'user' }), SINCE + 1000);
  db.close();
  const beta = new DatabaseSync(path.join(dir, 'opencode-beta.db'));
  beta.exec('create table message (id text, data text)');
  const other = { ...data, time: { created: SINCE + 1000 } };
  beta.prepare('insert into message values (?, ?)').run('only-message', JSON.stringify(other));
  beta.prepare('insert into message values (?, ?)').run('beta', JSON.stringify(other));
  beta.close();
  const records = await readOpenCodeUsage(dir, SINCE);
  assert.equal(records.length, 6);
  assert.deepEqual(records.slice(3).map((row) => [row.model, row.tokens.uncached]), Array(3).fill(['grok-test', 7]));
  assert.equal(records[0].model, 'claude-test-5');
  const cli = await readOpenCodeUsage(dir, SINCE, { native: null, query: async (file, sql) => {
    privateSql(sql);
    return cliQuery(file, sql);
  } });
  assert.deepEqual(cli, records);
});

test('5000 rows use three pages and mid-scan appends wait for the next read', { skip: !DatabaseSync }, async (t) => {
  const dir = await folder(t);
  const writer = new DatabaseSync(path.join(dir, 'opencode.db'));
  writer.exec('pragma journal_mode = WAL; create table session_message (id text, type text, data text)');
  const insert = writer.prepare('insert into session_message (rowid, id, type, data) values (?, ?, ?, ?)');
  const data = JSON.stringify({ model: 'grok-test', time: { created: SINCE }, tokens: { input: 1 } });
  writer.exec('begin');
  for (let index = 0; index < 5000; index += 1) insert.run(index - 10, `m${index}`, 'assistant', data);
  writer.exec('commit');
  let pauses = 0, opens = 0;
  const records = await readOpenCodeUsage(dir, SINCE, { open: (file) => {
    opens += 1;
    const db = new DatabaseSync(file, { readOnly: true });
    return { exec: (sql) => db.exec(sql), close: () => db.close(), prepare: (sql) => { privateSql(sql); return db.prepare(sql); } };
  }, pause: async () => {
    pauses += 1;
    if (pauses === 1) insert.run(6000, 'later', 'assistant', data);
  } });
  writer.close();
  assert.equal(opens, 1);
  assert.equal(pauses, 3);
  assert.equal(records.length, 5000);
  assert.equal(records.reduce((sum, row) => sum + row.tokens.uncached, 0), 5000);
  assert.equal((await readOpenCodeUsage(dir, SINCE)).length, 5001);
});

test('database discovery skips links and non-files', { skip: process.platform === 'win32' || !DatabaseSync }, async (t) => {
  const dir = await makeDatabase(t);
  await fs.symlink(path.join(dir, 'opencode.db'), path.join(dir, 'opencode-link.db'));
  await fs.mkdir(path.join(dir, 'opencode-folder.db'));
  assert.equal((await readOpenCodeUsage(dir, SINCE)).length, 3);
});
