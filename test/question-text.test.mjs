import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudePositionRecords, loadClaudeDesktopCodeThreads, parseClaudeJsonlSignals, useClaudePositions, useClaudeQuestionText } from '../src/claude-data.mjs';
import { exportLocalSessions } from '../src/machine-peers.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { createSwitchboardServer, loadSwitchboardDashboard } from '../src/switchboard.mjs';

// Made-up data only.
const jsonl = (events) => events.map(JSON.stringify).join('\n');
const QUESTION = 'Synthetic question: pick the blue or the green widget?';
const at = (nowMs, offset) => new Date(nowMs + offset).toISOString();
const ask = (nowMs, offset, id, input) => ({ type: 'assistant', timestamp: at(nowMs, offset),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } });
const answer = (nowMs, offset, id) => ({ type: 'user', timestamp: at(nowMs, offset),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Synthetic answer' }] } });
const questionOf = (text) => parseClaudeJsonlSignals(text).pendingTools.find((tool) => tool.tool === 'AskUserQuestion')?.question;

test('a pending AskUserQuestion keeps its first question text only while the switch is on', (t) => {
  t.after(() => useClaudeQuestionText(false));
  const nowMs = Date.parse('2026-11-17T10:00:00Z');
  const pending = jsonl([ask(nowMs, 0, 'ask-1', { questions: [{ question: `  ${QUESTION}  `, options: [{ label: 'Synthetic option' }] }, { question: 'Second' }] })]);
  assert.equal(questionOf(pending), undefined);
  useClaudeQuestionText(true);
  assert.equal(questionOf(pending), QUESTION);
  // Nothing else from the tool input is kept.
  assert.deepEqual(Object.keys(parseClaudeJsonlSignals(pending).pendingTools[0]).sort(),
    ['id', 'kind', 'question', 'signalAtMs', 'status', 'title', 'tool']);
  assert.equal(questionOf(jsonl([ask(nowMs, 0, 'ask-1', { question: 'Synthetic flat question?' })])), 'Synthetic flat question?');
  assert.equal(questionOf(jsonl([ask(nowMs, 0, 'ask-1', { questions: [{ question: '   ' }] })])), undefined);
  assert.equal(questionOf(jsonl([ask(nowMs, 0, 'ask-1', {})])), undefined);
  // 400 characters: cut at a word, at most 300 with `...`.
  const long = `${'word '.repeat(80)}`.trim();
  const cut = questionOf(jsonl([ask(nowMs, 0, 'ask-1', { questions: [{ question: long }] })]));
  assert.ok(cut.length <= 300 && cut.endsWith('word...') && long.startsWith(cut.slice(0, -3)), cut);
  const oneWord = questionOf(jsonl([ask(nowMs, 0, 'ask-1', { questions: [{ question: 'x'.repeat(400) }] })]));
  assert.equal(oneWord, `${'x'.repeat(297)}...`);
  // An answered question and a wrap-up question keep no text.
  assert.equal(questionOf(jsonl([ask(nowMs, 0, 'ask-1', { questions: [{ question: QUESTION }] }), answer(nowMs, 1000, 'ask-1')])), undefined);
  const wrapUp = parseClaudeJsonlSignals(jsonl([
    { type: 'user', timestamp: at(nowMs, 0), message: { role: 'user', content: 'Synthetic task' } },
    { type: 'assistant', timestamp: at(nowMs, 1000), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'wrap',
      name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Synthetic recap', ask: QUESTION } }] } },
    { type: 'user', timestamp: at(nowMs, 2000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wrap', content: 'ok' }] } },
  ]));
  const wrapAsk = wrapUp.pendingTools.find((tool) => tool.tool === 'AskUserQuestion');
  assert.ok(wrapAsk);
  assert.equal(wrapAsk.question, undefined);
  assert.equal(JSON.stringify(wrapUp).includes('Synthetic question'), false);
});

async function claudeHome(t, nowMs, lines) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-question-text-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const sessionId = 'cccccccc-dddd-4eee-8fff-000000000001';
  const project = path.join(homeDir, '.claude', 'projects', 'synthetic-project');
  await mkdir(project, { recursive: true });
  const transcript = path.join(project, `${sessionId}.jsonl`);
  await writeFile(transcript, jsonl([
    { type: 'user', timestamp: at(nowMs, -60_000), sessionId, cwd: '/work/synthetic', entrypoint: 'cli', message: { role: 'user', content: 'Synthetic task' } },
    ...lines,
  ]) + '\n');
  await utimes(transcript, nowMs / 1000, nowMs / 1000);
  return { homeDir, transcript, project, sessionId };
}

test('the dashboard sends questionText only with text=1, only for a pending question, and never elsewhere', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  const nowMs = Date.now();
  const { homeDir } = await claudeHome(t, nowMs, [ask(nowMs, -30_000, 'ask-1', { questions: [{ question: QUESTION }] })]);
  const registry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  const server = createSwitchboardServer({ pendingStatePath: false, palettePath: '', dashboardWatchPaths: [], sourceRegistry: registry,
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => {
    const response = await fetch(base + route);
    const text = await response.text();
    return { etag: response.headers.get('etag'), text, json: JSON.parse(text) };
  };
  // The list part of a reply: all but the time and the counters.
  const list = ({ json }) => { const { generatedAtMs: _, performance: __, ...rest } = json; return JSON.stringify(rest); };
  const rows = (reply) => reply.json.threads.filter((row) => row.provider === 'claude-desktop-code');

  const before = await get('/api/dashboard');
  assert.equal(rows(before).length, 1);
  assert.equal(rows(before)[0].questionPending, true);
  assert.equal(before.text.includes('questionText'), false);
  // The switch off: text=1 gets no question text.
  assert.equal((await get('/api/dashboard?text=1')).text.includes('questionText'), false);

  useClaudeQuestionText(true);
  server.invalidateDashboard('phone-text');
  const withText = await get('/api/dashboard?text=1');
  assert.equal(rows(withText)[0].questionText, QUESTION);
  const plain = await get('/api/dashboard');
  assert.equal(plain.text.includes('questionText'), false);
  assert.equal(plain.text.includes(QUESTION), false);
  // Without text=1 the reply is the same as before, with the same tag; each variant has its own tag.
  assert.equal(list(plain), list(before));
  assert.equal(plain.etag, before.etag);
  assert.equal(plain.etag, `"${createHash('sha256').update(list(plain)).digest('base64url')}"`);
  assert.notEqual(withText.etag, plain.etag);
  assert.equal((await fetch(`${base}/api/dashboard?text=1`, { headers: { 'if-none-match': withText.etag } })).status, 304);
  assert.equal((await fetch(`${base}/api/dashboard`, { headers: { 'if-none-match': withText.etag } })).status, 200);
  // The top bar and the member export never carry it.
  assert.equal((await get('/api/panel')).text.includes(QUESTION), false);
  const exported = exportLocalSessions(await server.dashboardForRequest(), { machineId: 'm-1', name: 'Synthetic PC' });
  assert.equal(JSON.stringify(exported).includes(QUESTION), false);

  // After the switch goes off, the next dashboard has no question text (no old cache entry).
  useClaudeQuestionText(false);
  server.invalidateDashboard('phone-text');
  const after = await get('/api/dashboard?text=1');
  assert.equal(after.text.includes('questionText'), false);
  assert.equal(after.text.includes(QUESTION), false);
});

test('an answered question leaves the text=1 reply with the plain list while the switch stays on', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const nowMs = Date.now();
  const { homeDir, transcript } = await claudeHome(t, nowMs, [ask(nowMs, -30_000, 'ask-1', { questions: [{ question: QUESTION }] })]);
  const registry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  const server = createSwitchboardServer({ pendingStatePath: false, palettePath: '', dashboardWatchPaths: [], sourceRegistry: registry,
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => {
    const response = await fetch(base + route, { headers: { 'accept-encoding': 'gzip' } });
    return { etag: response.headers.get('etag'), text: await response.text() };
  };
  assert.equal((await get('/api/dashboard?text=1')).text.includes(QUESTION), true);
  await appendFile(transcript, `${JSON.stringify(answer(nowMs, -10_000, 'ask-1'))}\n`);
  await utimes(transcript, nowMs / 1000 + 1, nowMs / 1000 + 1);
  server.invalidateDashboard('synthetic-answer');
  const answered = await get('/api/dashboard?text=1');
  assert.equal(answered.text.includes(QUESTION), false);
  // With no pending question, text=1 gets the plain list and tag.
  assert.equal(answered.etag, (await get('/api/dashboard')).etag);
});

test('a saved reader record never holds question text, and with the switch off no text is kept', async (t) => {
  t.after(() => { useClaudeQuestionText(false); useClaudePositions(null); });
  useClaudePositions({ take: () => null, digest: (bytes) => createHash('sha256').update(bytes).digest('hex') });
  const nowMs = Date.now();
  const filler = Array.from({ length: 20 }, (_, index) => ({ type: 'progress', timestamp: at(nowMs, -50_000 + index), data: 'x'.repeat(1024) }));
  const { homeDir, sessionId } = await claudeHome(t, nowMs, [...filler, ask(nowMs, -30_000, 'ask-1', { questions: [{ question: QUESTION }] })]);
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  const appDir = path.join(homeDir, 'Claude');
  const sessions = path.join(appDir, 'claude-code-sessions');
  await mkdir(sessions, { recursive: true });
  const metadata = path.join(sessions, 'local_00000000-0000-4000-8000-000000000001.json');
  await writeFile(metadata, JSON.stringify({ sessionId: 'local_00000000-0000-4000-8000-000000000001', cliSessionId: sessionId,
    cwd: '/work/synthetic', createdAt: nowMs - 120_000, lastActivityAt: nowMs }));
  await utimes(metadata, nowMs / 1000, nowMs / 1000);
  for (const on of [true, false]) {
    useClaudeQuestionText(on);
    const { threads } = await loadClaudeDesktopCodeThreads({ appDir, projectsDir, maxBytes: 4096, nowMs });
    assert.equal(threads.length, 1);
    const kept = threads[0].pendingTools.find((tool) => tool.tool === 'AskUserQuestion');
    assert.equal(kept.question, on ? QUESTION : undefined);
    if (!on) assert.equal(JSON.stringify(threads).includes('Synthetic question'), false);
    const records = claudePositionRecords();
    assert.ok(records.length >= 1);
    assert.equal(JSON.stringify(records).includes('Synthetic question'), false);
  }
});
