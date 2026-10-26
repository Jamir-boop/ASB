import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityUsage } from '../src/activity-usage.mjs';

const sqlite = await import('node:sqlite').catch(() => null);
const NOW = Date.now();
const timestamp = new Date(NOW - 60_000).toISOString();
const secret = 'SECRET-TEXT-1234';
const grok = JSON.stringify({ timestamp: NOW - 60_000, params: { sessionId: 's-test', update: {
  sessionUpdate: 'turn_completed', prompt_id: 'p-test', usage: { inputTokens: 9, outputTokens: 3 }, text: secret } } });
const pi = JSON.stringify({ type: 'message', id: 'p-test', timestamp,
  message: { role: 'assistant', provider: 'test', model: 'mimo-test', usage: { input: 4, output: 2 }, text: secret } });

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-roots-'));
  const services = [];
  t.after(async () => {
    await Promise.all(services.flatMap((service) => [service.idle(), service.pricesIdle()]));
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name, text) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${text}\n`);
  };
  const service = (options = {}) => {
    const usage = createActivityUsage({ homeDir: root, env: {}, cacheDir: path.join(root, 'cache'), now: () => NOW,
      refreshMs: Infinity, fetch: async () => { throw new Error('offline'); }, ...options });
    services.push(usage);
    return usage;
  };
  return { root, write, service };
}

test('default Grok and Pi roots, exact Grok file name, and archived Codex usage', async (t) => {
  const { root, write, service } = await setup(t);
  await write('.grok/sessions/a/updates.jsonl', grok);
  await write('.grok/sessions/a/chat_history.jsonl', grok);
  await write('.pi/agent/sessions/x.jsonl', pi);
  await write('codex/archived_sessions/old.jsonl', [
    JSON.stringify({ type: 'turn_context', timestamp, payload: { model: 'gpt-test' } }),
    JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      total_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } } }),
  ].join('\n'));
  const source = { enabled: true, provider: 'codex', dataDir: path.join(root, 'codex') };
  const usage = service({ readSources: async () => [source, { ...source }] });
  await usage.refresh();
  const report = usage.report('7d', [{ machineId: 'member', usage: [
    { app: 'pi', model: 'mimo-v2.6-pro', hourMs: NOW - 3_600_000, tokens: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
  ] }]);
  assert.equal(report.scan.files, 3);
  assert.deepEqual(report.records.filter((row) => row.machineId !== 'member').map((row) => row.app).sort(), ['codex', 'grok', 'pi']);
  assert.equal(report.records.find((row) => row.app === 'grok').tokens.uncached, 9);
  for (const row of report.records) {
    assert.deepEqual(Object.keys(row), ['machineId', 'app', 'model', 'maker', 'bucket', 'tokens', 'cost']);
  }
  assert.equal(report.records.find((row) => row.machineId === 'member').maker, 'Xiaomi MiMo');
  assert.equal(report.records.find((row) => row.app === 'codex').maker, 'OpenAI');
});

test('environment roots expand home and the explicit Pi session directory wins', async (t) => {
  const { write, service } = await setup(t);
  await write('grok-custom/sessions/a/updates.jsonl', grok);
  await write('pi-agent/sessions/a.jsonl', pi);
  const fromAgent = service({ env: { GROK_HOME: ' ~/grok-custom ', PI_CODING_AGENT_DIR: '~/pi-agent' } });
  await fromAgent.refresh();
  assert.deepEqual(fromAgent.localHourly('24h').usage.map((row) => row.app).sort(), ['grok', 'pi']);
  await write('pi-explicit/x.jsonl', pi);
  const explicit = service({ env: { PI_CODING_AGENT_DIR: '~/missing', PI_CODING_AGENT_SESSION_DIR: ' ~/pi-explicit ' } });
  await explicit.refresh();
  assert.equal(explicit.localHourly('24h').usage.find((row) => row.app === 'pi').tokens.uncached, 4);
});

test('scan cache and report never retain message text or transcript paths', { skip: !sqlite }, async (t) => {
  const { root, write, service } = await setup(t);
  await write('.grok/sessions/a/updates.jsonl', grok);
  await write('.pi/agent/sessions/x.jsonl', pi);
  const dataDir = path.join(root, 'opencode');
  await fs.mkdir(dataDir);
  const db = new sqlite.DatabaseSync(path.join(dataDir, 'opencode.db'));
  db.exec('create table message (id text, data text, time_created integer)');
  db.prepare('insert into message values (?, ?, ?)').run('m-test', JSON.stringify({ role: 'assistant',
    modelID: 'grok-test', tokens: { input: 3 }, text: secret }), NOW - 60_000);
  db.close();
  const usage = service({ readSources: async () => [{ enabled: true, provider: 'opencode', dataDir }] });
  await usage.refresh();
  const report = usage.report('7d');
  assert.equal(report.records.length, 3);
  const cache = await fs.readFile(path.join(root, 'cache', 'usage', 'usage-cache.json'), 'utf8');
  for (const value of [cache, JSON.stringify(report)]) {
    assert.equal(value.includes(secret), false);
    assert.equal(value.includes(root), false);
  }
});

test('OpenCode refresh detects new, changed, and removed named databases', { skip: !sqlite }, async (t) => {
  const { root, service } = await setup(t);
  const dataDir = path.join(root, 'opencode');
  await fs.mkdir(dataDir);
  const usage = service({ readSources: async () => [{ enabled: true, provider: 'opencode', dataDir }] });
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage.length, 0);
  const file = path.join(dataDir, 'opencode-beta.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('pragma journal_mode = WAL; pragma wal_autocheckpoint = 0; create table message (id text, data text)');
  const insert = db.prepare('insert into message values (?, ?)');
  const data = JSON.stringify({ role: 'assistant', modelID: 'grok-test', time: { created: NOW - 60_000 }, tokens: { input: 1 } });
  insert.run('m1', data);
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage[0].tokens.uncached, 1);
  const pages = usage.stats.openCodePages;
  await usage.refresh();
  assert.equal(usage.stats.openCodePages, pages);
  insert.run('m2', data);
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage[0].tokens.uncached, 2);
  db.close();
  await fs.rm(file);
  await usage.refresh();
  assert.equal(usage.localHourly('24h').usage.length, 0);
});
