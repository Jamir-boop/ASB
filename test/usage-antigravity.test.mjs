import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravityRoots, expandHome, readAntigravityUsage } from '../src/usage-antigravity.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const AT = 1_790_000_000_000;
const varint = (value) => {
  const bytes = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte + (value > 0 ? 128 : 0));
  } while (value > 0);
  return bytes;
};
const num = (field, value) => [...varint(field * 8), ...varint(value)];
const bytes = (field, value) => [...varint(field * 8 + 2), ...varint(value.length), ...value];
const text = (field, value) => bytes(field, [...Buffer.from(value)]);
const stamp = (ms) => [...num(1, Math.floor(ms / 1000)), ...num(2, (ms % 1000) * 1_000_000)];
const usage = (id, input = 10, extra = []) => [...num(2, input), ...num(3, 20), ...num(4, 3), ...num(5, 4), ...text(11, id), ...extra];
const generation = (counts, name = 'Gemini Test High', at = AT) => bytes(1, [
  ...bytes(4, counts), ...text(19, name), ...(at === null ? [] : bytes(9, bytes(4, stamp(at)))),
]);
const step = (counts, name = '', at = AT, timeField = 8) => [
  ...bytes(9, counts), ...bytes(24, text(12, name)), ...(at === null ? [] : bytes(timeField, stamp(at))),
];

async function setup(t) {
  // The roots are real paths: on Windows CI the temp folder has a short 8.3 name (RUNNER~1).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asb-antigravity-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seed = async (name, generations = [], steps = [], trajectory = null) => {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new sqlite.DatabaseSync(file);
    db.exec('create table gen_metadata (idx integer, data blob); create table steps (idx integer, metadata blob)');
    for (const [index, blob] of generations.entries()) db.prepare('insert into gen_metadata values (?, ?)').run(index, new Uint8Array(blob));
    for (const [index, blob] of steps.entries()) db.prepare('insert into steps values (?, ?)').run(index, blob === null ? null : new Uint8Array(blob));
    if (trajectory !== null) {
      db.exec('create table trajectory_metadata_blob (data blob)');
      db.prepare('insert into trajectory_metadata_blob values (?)').run(new Uint8Array(bytes(2, stamp(trajectory))));
    }
    db.close();
    return file;
  };
  return { dir, seed };
}

test('generation, step, retry, model IDs, names, and each timestamp fallback', { skip: !sqlite }, async (t) => {
  const { dir, seed } = await setup(t);
  const retry = bytes(28, bytes(2, usage('retry', 7, num(1, 1026))));
  await seed('a.db', [generation(usage('generation'), 'Claude 4.5 Sonnet (Thinking)', AT + 123)], [
    [...step(usage('step', 11, [...num(9, 15), ...num(10, 9)]), 'Gemini Test High', AT + 500), ...retry],
    step(usage('step-time-1'), 'Named Model Medium', AT + 700, 1),
    step(usage('trajectory'), 'Grok Test Low', null),
  ], AT + 900);
  const file = await seed('b.db', [generation(usage('mtime'), 'Gemini Fallback', null)]);
  const mtime = (await fs.stat(file)).mtimeMs;
  const records = await readAntigravityUsage([dir], 0);
  assert.equal(records.length, 6);
  assert.deepEqual(records[0], { app: 'antigravity', timestampMs: AT + 500, model: 'gemini-test',
    tokens: { uncached: 11, cacheRead: 4, cacheWrite: 3, output: 24 }, dedupeKey: null });
  assert.equal(records[1].model, 'claude-opus-4-6');
  assert.equal(records[1].tokens.uncached, 7);
  assert.equal(records[2].model, 'named-model');
  assert.equal(records[2].timestampMs, AT + 700);
  assert.equal(records[3].timestampMs, AT + 900);
  assert.equal(records[4].model, 'claude-sonnet-4-5');
  assert.equal(records[4].timestampMs, AT + 123);
  assert.equal(records[5].timestampMs, mtime);
  assert.equal((await readAntigravityUsage([dir], mtime + 1)).length, 0);
});

test('union-find merges shared keys across roots and keeps max counts and the best time', { skip: !sqlite }, async (t) => {
  const { dir, seed } = await setup(t);
  await seed('root-a/a.db', [generation(usage('response-a', 10), 'First Model High', null)]);
  await seed('root-b/b.db', [generation([...num(2, 40), ...num(3, 50), ...text(11, 'response-b'), ...text(12, 'request-b')], 'Second Model', AT + 1000)]);
  await seed('root-b/c.db', [], [step([...num(2, 20), ...num(5, 30), ...num(4, 12), ...text(11, 'response-a'), ...text(12, 'request-b')], 'Third Model', AT)]);
  const cache = new Map();
  let opens = 0;
  const open = (file) => { opens += 1; return new sqlite.DatabaseSync(file, { readOnly: true }); };
  const roots = [path.join(dir, 'root-a'), path.join(dir, 'root-b')];
  const records = await readAntigravityUsage(roots, 0, { cache, open });
  assert.deepEqual(records, [{ app: 'antigravity', timestampMs: AT, model: 'first-model',
    tokens: { uncached: 40, cacheRead: 30, cacheWrite: 12, output: 50 }, dedupeKey: null }]);
  assert.equal(opens, 3);
  // No database changed: the same result array, so the usage engine keeps its parts.
  assert.equal(await readAntigravityUsage(roots, 0, { cache, open }), records);
  assert.equal(opens, 3);
  const file = path.join(dir, 'root-a', 'a.db');
  const writer = new sqlite.DatabaseSync(file);
  writer.prepare('insert into gen_metadata values (?, ?)').run(1, new Uint8Array(generation(usage('new-key'), 'New Model')));
  writer.close();
  // The file time can stay in the same clock tick as the seed, and the size can stay: move the time on, as a later write does.
  const later = new Date(Date.now() + 2000);
  await fs.utimes(file, later, later);
  const changed = await readAntigravityUsage(roots, 0, { cache, open });
  assert.equal(changed.length, 2);
  assert.notEqual(changed, records);
  assert.equal(opens, 4);
  await fs.rm(file);
  assert.notEqual(await readAntigravityUsage(roots, 0, { cache, open }), changed);
  assert.equal(cache.has(file), false);
});

test('a failed read of a changed database is read again when the old fingerprint comes back', { skip: !sqlite }, async (t) => {
  const { dir, seed } = await setup(t);
  const a = await seed('a.db', [generation(usage('key-a', 10), 'Model A')]);
  await seed('b.db', [generation(usage('key-b', 20), 'Model B')]);
  const cache = new Map();
  let fail = false;
  const open = (file) => {
    if (fail && file === a) { fail = false; throw new Error('SQLITE_BUSY (synthetic)'); }
    return new sqlite.DatabaseSync(file, { readOnly: true });
  };
  const models = (records) => records.map((record) => record.model).sort();
  assert.deepEqual(models(await readAntigravityUsage([dir], 0, { cache, open })), ['model-a', 'model-b']);
  // Antigravity opens a.db: an empty WAL file changes the fingerprint, and this read fails.
  await fs.writeFile(`${a}-wal`, '');
  fail = true;
  assert.deepEqual(models(await readAntigravityUsage([dir], 0, { cache, open })), ['model-b']);
  // The WAL file goes with no write, so the fingerprint is the first one again.
  await fs.rm(`${a}-wal`);
  assert.deepEqual(models(await readAntigravityUsage([dir], 0, { cache, open })), ['model-a', 'model-b']);
});

test('broken files, missing tables, decode failures, and links do not hide other files', { skip: !sqlite }, async (t) => {
  const { dir, seed } = await setup(t);
  await fs.writeFile(path.join(dir, 'a.db'), 'not SQLite');
  const empty = new sqlite.DatabaseSync(path.join(dir, 'b.db'));
  empty.exec('create table unrelated (value integer)');
  empty.close();
  await seed('c.db', [generation(usage('valid-in-broken')), [10, 100]]);
  const good = await seed('nested/d.db', [generation(usage('good'), 'Grok Test')]);
  if (process.platform !== 'win32') {
    await fs.symlink(good, path.join(dir, 'link.db'));
    await fs.symlink(path.join(dir, 'nested'), path.join(dir, 'link-folder'));
  }
  const records = await readAntigravityUsage([dir], 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].model, 'grok-test');
});

test('generation and step pages use one transaction and close after decoding', { skip: !sqlite }, async (t) => {
  const { dir, seed } = await setup(t);
  await seed('a.db', [generation(usage('g1')), generation(usage('g2'))], Array.from({ length: 130 }, (_, i) => step(usage(`s${i}`))));
  const statements = [];
  let pauses = 0, closes = 0;
  const records = await readAntigravityUsage([dir], 0, { pause: async () => { pauses += 1; }, open: (file) => {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    return { exec: (sql) => { statements.push(sql); db.exec(sql); }, prepare: (sql) => db.prepare(sql), close: () => { closes += 1; db.close(); } };
  } });
  assert.equal(records.length, 132);
  assert.ok(pauses >= 4);
  assert.deepEqual(statements, ['PRAGMA busy_timeout = 100', 'BEGIN', 'COMMIT']);
  assert.equal(closes, 1);
  await seed('bad.db', [[10, 100]]);
  statements.length = 0;
  await readAntigravityUsage([dir], 0, { open: (file) => {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    return { exec: (sql) => { statements.push(sql); db.exec(sql); }, prepare: (sql) => db.prepare(sql), close: () => db.close() };
  } });
  assert.ok(statements.includes('ROLLBACK'));
});

test('configured and default roots use home expansion, conversations, and dedupe', async (t) => {
  const { dir } = await setup(t);
  const defaults = ['.gemini/antigravity', '.gemini/antigravity-cli', '.gemini/antigravity-ide', '.gemini/antigravity-backup', '.config/antigravity'];
  for (const name of defaults) await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.mkdir(path.join(dir, defaults[0], 'conversations'));
  assert.deepEqual(await antigravityRoots({}, dir), defaults.map((name, index) => path.join(dir, name, ...(index === 0 ? ['conversations'] : []))));
  await fs.mkdir(path.join(dir, 'one', 'conversations'), { recursive: true });
  await fs.mkdir(path.join(dir, 'two'));
  assert.deepEqual(await antigravityRoots({ ANTIGRAVITY_DATA_DIR: ' ~/one, ~/two, ~/one, ~/missing ' }, dir),
    [path.join(dir, 'one', 'conversations'), path.join(dir, 'two')]);
  assert.equal(expandHome('~', dir), dir);
  assert.equal(expandHome('~\\one', dir), path.join(dir, 'one'));
  assert.deepEqual(await readAntigravityUsage([dir], 0, { native: null }), []);
});
