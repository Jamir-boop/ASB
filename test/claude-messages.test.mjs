import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeMessages } from '../src/claude-messages.mjs';

const nowMs = Date.parse('2026-10-20T12:30:00Z');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sent = (id, name = 'SendMessage', to = 'beta-helper', message = 'Synthetic body.') => ({ type: 'assistant', sessionId: uuid(1),
  timestamp: new Date(nowMs - 1000).toISOString(), message: { content: [{ type: 'tool_use', name, id, input: { to, message } }] } });
const envelope = (body = 'Synthetic body.') => `<cross-session-message from="local_${uuid(1)}" name="alpha-main">\n${body}\n</cross-session-message>`;
const received = (id, body) => ({ type: 'user', isMeta: true, uuid: id, sessionId: uuid(2), timestamp: new Date(nowMs).toISOString(),
  message: { content: `Another session sent this:\n${envelope(body)}\n\nA synthetic permission note.` } });
const lines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-claude-messages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'projects'), folder = path.join(root, 'synthetic-project');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${uuid(1)}.jsonl`), stats = {};
  const sources = [{ enabled: true, provider: 'claude-desktop-code', projectsDir: root },
    { enabled: true, provider: 'claude-desktop-code', projectsDir: path.join(root, '.') }];
  const reader = createClaudeMessages({ readSources: async () => sources, now: () => nowMs, stats });
  return { dir, root, folder, file, stats, reader };
}

test('sends accept all tool name forms and skip subagents, empty bodies, and copied API records', async (t) => {
  const { file, folder, reader } = await fixture(t);
  const events = ['SendMessage', 'mcp__ccd_session_mgmt__send_message', 'mcp__abc__def_SendMessage'].map((name, i) => sent(`call-${i}`, name));
  events[1].message.content[0].input.session_id = `local_${uuid(2)}`;
  delete events[1].message.content[0].input.to;
  events.push(sent('skip-main', 'SendMessage', 'main'), sent('skip-agent', 'SendMessage', 'a0123456789abcdef'), sent('skip-empty', 'SendMessage', 'beta-helper', ' '),
    { ...sent('skip-blob'), type: 'api-request-blob' }, { ...sent('skip-shape'), type: 'api-request-shape' },
    sent('call-3', 'SendMessage', 'uds:/run/user/1000/cc-socks/synthetic.sock'));
  await writeFile(file, lines(events));
  const subagents = path.join(folder, uuid(1), 'subagents');
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(subagents, 'agent-synthetic.jsonl'), lines([sent('skip-deep')]));
  const rows = await reader.records(nowMs - 60_000);
  assert.deepEqual(rows.map((row) => row.id), ['claude:call-0', 'claude:call-1', 'claude:call-2', 'claude:call-3']);
  assert.deepEqual(rows.map((row) => row.label), ['beta-helper', '', 'beta-helper', '']);
  assert.deepEqual(rows.map((row) => row.to), ['beta-helper', `local_${uuid(2)}`, 'beta-helper', 'uds:']);
  assert.equal(await reader.text(rows[0]), 'Synthetic body.');
});

test('failed result forms change the send status, including an appended result', async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, lines([sent('failure-a'), sent('failure-b')]));
  await reader.records(0);
  await appendFile(file, lines([{ type: 'user', toolUseResult: { success: false }, message: { content: [{ type: 'tool_result', tool_use_id: 'failure-a' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'failure-b', content: '{"success":false,"error":"Synthetic failure"}' }] } }]));
  assert.deepEqual((await reader.records(0)).map(({ status, reason }) => [status, reason]), [['not-sent', 'Not sent'], ['not-sent', 'Not sent']]);
});

test('both delivery forms strip notes, preserve the last closing tag, and reject quoted or duplicate records', async (t) => {
  const { file, reader } = await fixture(t);
  const incoming = received(uuid(3), 'One\n</cross-session-message>\nTwo');
  const attachment = { type: 'attachment', uuid: uuid(4), timestamp: new Date(nowMs).toISOString(), attachment: { type: 'queued_command',
    prompt: `  <cross-session-message from="uds:synthetic" from-session="${uuid(5)}" from-name=" beta-helper ">\nQueued body.\n</cross-session-message>  ` } };
  await writeFile(file, lines([incoming, attachment, { ...incoming, type: 'queue-operation' }, { ...received(uuid(6)), isMeta: false },
    { ...received(uuid(7)), message: { content: `<quoted>\n${envelope()}` } }]));
  const rows = await reader.records(0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.from), [`local_${uuid(1)}`, uuid(5)]);
  assert.deepEqual(rows.map((row) => row.label), ['alpha-main', 'beta-helper']);
  assert.deepEqual(await Promise.all(rows.map(reader.text)), ['One\n</cross-session-message>\nTwo', 'Queued body.']);
});

test('forked IDs count once; concurrent requests scan once and unchanged files read no bytes', async (t) => {
  const { file, folder, reader, stats } = await fixture(t);
  const body = lines([sent('same-call'), received(uuid(3))]);
  await writeFile(file, body);
  await writeFile(path.join(folder, `${uuid(9)}.jsonl`), body);
  const [a, b] = await Promise.all([reader.records(0), reader.records(0)]);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  assert.equal(stats.readBytes, 2 * (Buffer.byteLength(body) + 64));
  const bytes = stats.readBytes;
  await reader.records(0);
  assert.equal(stats.readBytes, bytes);
});

test('append reads only new complete lines, rewrite rereads, and text checks hashes and code point length', async (t) => {
  const { file, reader, stats } = await fixture(t);
  await writeFile(file, lines([sent('long-call', 'SendMessage', 'beta-helper', '😀'.repeat(2100))]));
  const [old] = await reader.records(0);
  assert.equal(await reader.text(old), `${'😀'.repeat(1999)}…`);
  let bytes = stats.readBytes;
  const appended = lines([sent('appended-call')]);
  await appendFile(file, appended.slice(0, -1));
  assert.equal((await reader.records(0)).length, 1);
  assert.equal(stats.readBytes - bytes, 64 + Buffer.byteLength(appended) - 1);
  bytes = stats.readBytes;
  await appendFile(file, '\n');
  assert.equal((await reader.records(0)).length, 2);
  assert.equal(stats.readBytes - bytes, 64 + Buffer.byteLength(appended));
  const replacement = lines([sent('long-call', 'SendMessage', 'beta-helper', 'Changed body.')]);
  await writeFile(file, replacement);
  assert.equal(await reader.text(old), null);
  bytes = stats.readBytes;
  assert.equal((await reader.records(0)).length, 1);
  assert.equal(stats.readBytes - bytes, 64 + Buffer.byteLength(replacement));
});

test('old records are omitted and old files are not read', async (t) => {
  const { file, reader, stats } = await fixture(t);
  await writeFile(file, lines([sent('old-record')]));
  assert.deepEqual(await reader.records(nowMs), []);
  await utimes(file, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
  const bytes = stats.readBytes;
  assert.deepEqual(await reader.records(nowMs - 30_000), []);
  assert.equal(stats.readBytes, bytes);
});

test('default root uses the selected home and disabled sources do not scan', async (t) => {
  const { dir } = await fixture(t);
  const folder = path.join(dir, '.claude', 'projects', 'synthetic-project');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${uuid(1)}.jsonl`), lines([sent('default-call')]));
  const sources = [{ enabled: true, provider: 'claude-desktop-code' }];
  const reader = createClaudeMessages({ readSources: async () => sources, homeDir: dir, now: () => nowMs });
  assert.equal((await reader.records(0)).length, 1);
  sources[0].enabled = false;
  assert.deepEqual(await reader.records(0), []);
});

test('a 30-day scan survives a 24-hour request without rereading retained files', async (t) => {
  const { file, folder, reader, stats } = await fixture(t);
  const oldAt = nowMs - 7 * 86_400_000;
  await writeFile(file, lines([{ ...sent('retained-call'), timestamp: new Date(oldAt).toISOString() }]));
  await utimes(file, new Date(oldAt), new Date(oldAt));
  await writeFile(path.join(folder, `${uuid(9)}.jsonl`), lines([sent('recent-call')]));
  const first = await reader.records(nowMs - 30 * 86_400_000);
  assert.equal(first.length, 2);
  const bytes = stats.readBytes;
  assert.deepEqual((await reader.records(nowMs - 86_400_000)).map((row) => row.id), ['claude:recent-call']);
  assert.deepEqual(await reader.records(nowMs - 30 * 86_400_000), first);
  assert.equal(stats.readBytes - bytes, 0);
});

test('byte marker scans handle split markers and candidate lines larger than three chunks', async (t) => {
  const { file, reader } = await fixture(t);
  const chunk = 1024 * 1024;
  const event = JSON.stringify(sent('split-marker'));
  const markerAt = event.indexOf('SendMessage');
  const noise = JSON.stringify({ type: 'synthetic-noise', padding: 'x'.repeat(chunk - markerAt - 45) }) + '\n';
  const padding = ' '.repeat(chunk - markerAt - 4 - Buffer.byteLength(noise)) + '\n';
  const long = sent('long-candidate', 'SendMessage', 'beta-helper', 'x'.repeat(3 * chunk + 100));
  const data = noise + padding + event + '\n' + lines([long, received(uuid(30), 'After the long line.')]);
  assert.equal(data.indexOf('SendMessage'), chunk - 3);
  await writeFile(file, data);
  const rows = await reader.records(0);
  assert.deepEqual(rows.map((row) => row.id).sort(), [`claude:${uuid(30)}`, 'claude:long-candidate', 'claude:split-marker'].sort());
  const texts = new Map(await Promise.all(rows.map(async (row) => [row.id, await reader.text(row)])));
  assert.equal(texts.get('claude:split-marker'), 'Synthetic body.');
  assert.equal(texts.get('claude:long-candidate'), `${'x'.repeat(1999)}…`);
  assert.equal(texts.get(`claude:${uuid(30)}`), 'After the long line.');
});

test('a saved scan resumes after a restart, reads only appended bytes and saved message lines, and keeps no names or bodies', async (t) => {
  const { dir, root, file } = await fixture(t);
  const stateFile = path.join(dir, 'private', 'claude-message-cache.json');
  const sources = [{ enabled: true, provider: 'claude-desktop-code', projectsDir: root }];
  const create = (extra = {}) => createClaudeMessages({ readSources: async () => sources, now: () => nowMs, stateFile, ...extra });
  const first = lines([sent('persisted', 'SendMessage', 'private-target-name', 'Private message text.'), received(uuid(3), 'Private incoming text.')]);
  await writeFile(file, first);
  const expected = await create().records(0);
  const document = await readFile(stateFile, 'utf8');
  for (const text of ['Private message text.', 'Private incoming text.', 'private-target-name', 'alpha-main', dir]) assert.ok(!document.includes(text), text);
  if (process.platform !== 'win32') {
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
  }
  const stats = {};
  const reader = create({ stats });
  const appended = lines([sent('new-call')]);
  await appendFile(file, appended);
  const rows = await reader.records(0);
  assert.deepEqual(rows, await create({ stateFile: '' }).records(0));
  assert.deepEqual(rows.filter((row) => row.id !== 'claude:new-call'), expected);
  assert.equal(stats.linesRead, 2);
  assert.equal(stats.readBytes - stats.lineBytesRead, 64 + Buffer.byteLength(appended));
  const bytes = stats.readBytes;
  assert.deepEqual(await reader.records(0), rows);
  assert.equal(stats.readBytes, bytes);
  assert.equal(await reader.text(rows.find((row) => row.id === 'claude:persisted')), 'Private message text.');
});

test('saved scans reread a rewritten, shrunk, or replaced file, and ignore broken or old-version state', async (t) => {
  const { dir, root, file } = await fixture(t);
  const stateFile = path.join(dir, 'private', 'claude-message-cache.json');
  const sources = [{ enabled: true, provider: 'claude-desktop-code', projectsDir: root }];
  const create = (extra = {}) => createClaudeMessages({ readSources: async () => sources, now: () => nowMs, stateFile, ...extra });
  const original = lines([sent('first-call'), sent('other-call')]);
  for (const change of ['rewrite', 'shrink', 'replace', 'broken', 'version', 'invalid-row']) {
    await writeFile(file, original);
    await create().records(0);
    let body = original;
    if (change === 'rewrite') body = original.replaceAll('Synthetic body.', 'Different body.');
    if (change === 'shrink') body = lines([sent('short-call')]);
    if (change === 'replace') {
      body = original + lines([sent('replacement-call')]);
      await writeFile(`${file}.new`, body);
      await rename(`${file}.new`, file);
    } else if (change === 'broken') await writeFile(stateFile, 'broken');
    else if (change === 'version') await writeFile(stateFile, '{"version":0,"files":{}}');
    else if (change === 'invalid-row') {
      const document = JSON.parse(await readFile(stateFile, 'utf8'));
      Object.values(document.files)[0].rows[0][6] = -1;
      await writeFile(stateFile, JSON.stringify(document));
    } else await writeFile(file, body);
    if (['rewrite', 'shrink', 'replace'].includes(change)) await utimes(file, new Date(nowMs), new Date(nowMs));
    const stats = {};
    const rows = await create({ stats }).records(0);
    assert.deepEqual(rows, await create({ stateFile: '' }).records(0), change + JSON.stringify(stats));
    assert.equal(stats.readBytes, Buffer.byteLength(body) + 64, change);
    assert.equal(stats.linesRead || 0, 0, change);
  }
});

test('the message state saves changes at most once a minute, and a failed save keeps the changes for a retry', async (t) => {
  const { dir, root, file } = await fixture(t);
  const stateFile = path.join(dir, 'private', 'claude-message-cache.json');
  const clock = { ms: nowMs };
  const logs = [];
  const reader = createClaudeMessages({ readSources: async () => [{ enabled: true, provider: 'claude-desktop-code', projectsDir: root }],
    stateFile, now: () => clock.ms, log: (line) => logs.push(line) });
  await mkdir(stateFile, { recursive: true });
  await writeFile(file, lines([sent('initial')]));
  await reader.records(0);
  assert.equal(logs.length, 1);
  await rm(stateFile, { recursive: true });
  await reader.records(0);
  const first = await readFile(stateFile, 'utf8');
  await appendFile(file, lines([sent('appended')]));
  await reader.records(0);
  assert.equal(await readFile(stateFile, 'utf8'), first);
  clock.ms += 60_000;
  await reader.records(0);
  assert.notEqual(await readFile(stateFile, 'utf8'), first);
});
