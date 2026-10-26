import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { querySqliteJson } from '../src/codex-data.mjs';
import { openCodeUsageSql, readOpenCodeUsage } from '../src/usage-opencode.mjs';

const SINCE = Date.parse('2026-10-01T00:00:00Z');

async function makeDatabase(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-opencode-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(folder, 'opencode.db'));
  db.exec(`create table session_message (id text primary key, session_id text, type text, seq integer,
    time_created integer, time_updated integer, data text)`);
  const insert = db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)');
  const row = (id, type, created, data) => insert.run(id, 's1', type, 0, created, created, JSON.stringify(data));
  const tokens = { input: 100, output: 40, reasoning: 10, cache: { read: 500, write: 20 } };
  // A model object with modelID, the time from data.
  row('m1', 'assistant', SINCE + 1000, { tokens, model: { modelID: 'claude-test-5', providerID: 'anthropic' }, cost: 0, time: { created: SINCE + 5000 } });
  // A model object with id (the shape of the current OpenCode), and no data time: time_created is the fallback.
  row('m2', 'assistant', SINCE + 7200000, { tokens, model: { id: 'gpt-test-1', providerID: 'openai', variant: 'x' } });
  // A model string, and a huge message text that the query must not return.
  row('m3', 'assistant', SINCE + 1000, { tokens, model: 'gpt-test-2', content: 'SECRETTEXT'.repeat(200_000), time: { created: SINCE + 9000 } });
  // Outside the period: skipped.
  row('m4', 'assistant', SINCE - 1000, { tokens, model: 'gpt-test-1', time: { created: SINCE - 1000 } });
  // Not an assistant row, and an assistant row with no tokens.
  row('m5', 'user', SINCE + 1000, { tokens, model: 'gpt-test-1', content: 'SECRETTEXT' });
  row('m6', 'assistant', SINCE + 1000, { model: 'gpt-test-1' });
  db.close();
  return folder;
}

test('reads the token parts of assistant rows of the period, never the message text', async (t) => {
  const folder = await makeDatabase(t);
  const answers = [];
  const query = async (file, sql) => {
    const rows = await querySqliteJson(file, sql);
    answers.push(JSON.stringify(rows));
    return rows;
  };
  const records = await readOpenCodeUsage(folder, SINCE, { query });
  const tokens = { uncached: 100, cacheRead: 500, cacheWrite: 20, output: 50 };
  assert.deepEqual(records.sort((a, b) => a.timestampMs - b.timestampMs), [
    { app: 'opencode', timestampMs: SINCE + 5000, model: 'claude-test-5', tokens, dedupeKey: null },
    { app: 'opencode', timestampMs: SINCE + 9000, model: 'gpt-test-2', tokens, dedupeKey: null },
    { app: 'opencode', timestampMs: SINCE + 7200000, model: 'gpt-test-1', tokens, dedupeKey: null },
  ]);
  assert.equal(answers.length, 1);
  assert.ok(!answers[0].includes('SECRETTEXT'));
  assert.ok(answers[0].length < 2000);
});

test('the query selects only JSON fields of data, never data whole', () => {
  const sql = openCodeUsageSql(SINCE);
  const uses = sql.match(/\bdata\b.{0,12}/g);
  assert.ok(uses.length > 0);
  for (const use of uses) assert.match(use, /^data, '\$\.(tokens|model|time)/);
  assert.match(sql, /type = 'assistant'/);
  assert.match(sql, new RegExp(`>= ${SINCE}`));
});
