import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { answersFor, createClaudeQuestions } from '../src/claude-questions.mjs';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { exportLocalSessions } from '../src/machine-peers.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { createSwitchboardServer, loadSwitchboardDashboard, QUESTION_SESSIONS } from '../src/switchboard.mjs';

// Made-up data only.
const agentScript = fileURLToPath(new URL('../scripts/asb-agent.mjs', import.meta.url));
const TOKEN = 'b'.repeat(64);
const SECRET_QUESTION = 'Synthetic phone question: the teal or the amber gadget?';
const SECRET_ANSWER = 'Synthetic teal gadget';
const one = (overrides = {}) => ({ question: 'Synthetic question?', header: 'Pick', options: [{ label: 'A', description: 'First' }, { label: 'B' }], ...overrides });
const clock = (start = 1_000_000) => { const value = { now: start }; return Object.assign(() => value.now, { advance: (ms) => { value.now += ms; } }); };

test('the store checks each limit', () => {
  const store = createClaudeQuestions();
  let session = 0;
  const ok = (questions) => assert.match(store.open({ provider: 'claude', sessionKey: `s-${session += 1}`, questions }).requestId, /^[0-9a-f]{32}$/);
  const bad = (questions) => assert.throws(() => store.open({ provider: 'claude', sessionKey: 'bad', questions }), (error) => error.statusCode === 400 && error.message === 'Invalid question.');
  ok([one()]); ok([one(), one(), one(), one()]); bad([]); bad([one(), one(), one(), one(), one()]); bad('x');
  ok([one({ question: 'q'.repeat(2000) })]); bad([one({ question: 'q'.repeat(2001) })]); bad([one({ question: '' })]);
  ok([one({ question: 'Line one\nline two' })]); ok([one({ question: 'Tab\there' })]); bad([one({ question: 'Bell\x07' })]);
  ok([one({ header: 'h'.repeat(100) })]); ok([one({ header: '' })]); bad([one({ header: 'h'.repeat(101) })]); bad([one({ header: 'Line\nbreak' })]);
  ok([one({ options: Array.from({ length: 8 }, (_, index) => ({ label: `L${index}` })) })]);
  bad([one({ options: Array.from({ length: 9 }, (_, index) => ({ label: `L${index}` })) })]); bad([one({ options: [] })]);
  ok([one({ options: [{ label: 'l'.repeat(200) }] })]); bad([one({ options: [{ label: 'l'.repeat(201) }] })]); bad([one({ options: [{ label: '' }] })]);
  bad([one({ options: [{ label: 'A' }, { label: 'A' }] })]); bad([one({ options: [{ label: 'Line\nbreak' }] })]);
  ok([one({ options: [{ label: 'A', description: 'd'.repeat(1000) }] })]); bad([one({ options: [{ label: 'A', description: 'd'.repeat(1001) }] })]);
  ok([one({ options: [{ label: 'A', description: 'Two\nlines' }] })]); bad([one({ options: [{ label: 'A', description: 'Bell\x07' }] })]);
  ok([one({ options: [{ label: 'A', description: 'Tab\there' }] })]); bad([one({ header: 'Tab\there' })]); bad([one({ options: [{ label: 'Tab\there' }] })]);
  ok([one({ multiSelect: true })]); bad([one({ multiSelect: 'yes' })]);
  // Only the known keys, and multiSelect false when missing.
  const { requestId } = store.open({ provider: 'claude', sessionKey: 'copy', questions: [{ ...one({ extra: 'x' }), options: [{ label: 'A', other: 1 }] }] });
  assert.deepEqual(store.forSession('claude', 'copy').questions, [{ question: 'Synthetic question?', header: 'Pick', options: [{ label: 'A' }], multiSelect: false }]);
  assert.equal(store.forSession('claude', 'copy').requestId, requestId);
});

test('the store keeps one open request per session and at most 32', () => {
  const store = createClaudeQuestions();
  const first = store.open({ provider: 'claude', sessionKey: 's1', questions: [one()] });
  const second = store.open({ provider: 'claude', sessionKey: 's1', questions: [one()] });
  assert.equal(store.forSession('claude', 's1').requestId, second.requestId);
  assert.equal(store.openRecords().length, 1);
  assert.notEqual(first.requestId, second.requestId);
  for (let index = 2; index <= 32; index += 1) store.open({ provider: 'claude', sessionKey: `s${index}`, questions: [one()] });
  assert.throws(() => store.open({ provider: 'claude', sessionKey: 's33', questions: [one()] }), (error) => error.statusCode === 503 && error.message === 'Too many open questions.');
  // A new request of a session with an open one replaces it, also at the limit.
  assert.ok(store.open({ provider: 'claude', sessionKey: 's5', questions: [one()] }).requestId);
});

test('wait settles at once on an answer and a close, and after its time with open', async () => {
  const store = createClaudeQuestions();
  const { requestId } = store.open({ provider: 'claude', sessionKey: 's1', questions: [one()] });
  const started = Date.now();
  assert.deepEqual(await store.wait(requestId, 30), { state: 'open' });
  assert.ok(Date.now() - started >= 25);
  const held = store.wait(requestId, 20_000);
  assert.equal(store.answer(requestId, { 'Synthetic question?': 'A' }), true);
  assert.deepEqual(await held, { state: 'answered', answers: { 'Synthetic question?': 'A' } });
  assert.deepEqual(await store.wait(requestId, 20_000), { state: 'answered', answers: { 'Synthetic question?': 'A' } });
  assert.equal(store.answer(requestId, {}), false);
  const other = store.open({ provider: 'claude', sessionKey: 's2', questions: [one()] });
  const closing = store.wait(other.requestId, 20_000);
  store.close(other.requestId);
  assert.deepEqual(await closing, { state: 'closed' });
  assert.equal(store.answer(other.requestId, {}), false);
  assert.equal(store.wait('0'.repeat(32), 10), null);
  // An abort ends a held wait.
  const third = store.open({ provider: 'claude', sessionKey: 's3', questions: [one()] });
  const controller = new AbortController();
  const aborted = store.wait(third.requestId, 20_000, controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { state: 'open' });
  store.closeAll();
  assert.equal(store.openRecords().length, 0);
});

test('reconcile, sweep, and the drop follow their times', () => {
  const now = clock();
  const store = createClaudeQuestions({ now });
  const seen = store.open({ provider: 'claude', sessionKey: 'seen', questions: [one()] }).requestId;
  const unseen = store.open({ provider: 'claude', sessionKey: 'unseen', questions: [one()] }).requestId;
  store.reconcile('claude', 'question', new Set(['seen']));
  assert.equal(store.forSession('claude', 'seen').seenPending, true);
  now.advance(10_000);
  store.reconcile('claude', 'question', new Set());
  // Seen, then gone: closed. Never seen within 30 s: stays.
  assert.equal(store.forSession('claude', 'seen'), null);
  assert.equal(store.forSession('claude', 'unseen').requestId, unseen);
  now.advance(20_001);
  store.reconcile('claude', 'question', new Set());
  assert.equal(store.forSession('claude', 'unseen'), null);
  // A closed record answers a late poll for 60 s, then it is gone.
  assert.ok(store.wait(seen, 0));
  now.advance(49_000);
  assert.ok(store.wait(unseen, 0));
  now.advance(1_000);
  assert.equal(store.wait(seen, 0), null);
  now.advance(9_999);
  assert.ok(store.wait(unseen, 0));
  now.advance(1);
  assert.equal(store.wait(unseen, 0), null);
  assert.equal(store.hasRecords(), false);
  // Sweep: no wait for more than 60 s closes.
  const swept = store.open({ provider: 'claude', sessionKey: 'swept', questions: [one()] }).requestId;
  now.advance(60_000);
  store.sweep();
  assert.equal(store.forSession('claude', 'swept').requestId, swept);
  store.wait(swept, 0);
  now.advance(60_001);
  store.sweep();
  assert.equal(store.forSession('claude', 'swept'), null);
  // An answered record is dropped 60 s after its answer.
  const answered = store.open({ provider: 'claude', sessionKey: 'answered', questions: [one()] }).requestId;
  store.answer(answered, { q: 'A' });
  now.advance(60_000);
  assert.equal(store.wait(answered, 0), null);
});

const jsonl = (events) => events.map(JSON.stringify).join('\n');
const at = (nowMs, offset) => new Date(nowMs + offset).toISOString();
const ask = (nowMs, offset, id) => ({ type: 'assistant', timestamp: at(nowMs, offset),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: 'Pending marker', options: [{ label: 'X' }] }] } }] } });
const toolAnswer = (nowMs, offset, id) => ({ type: 'user', timestamp: at(nowMs, offset),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Synthetic result' }] } });

// A temp HOME with one Claude Code CLI session whose AskUserQuestion is pending (asked `askOffsetMs` ago).
async function engine(t, { askOffsetMs = -30_000, store, ...serverOptions } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-claude-questions-'));
  const nowMs = Date.now();
  const sessionId = 'cccccccc-dddd-4eee-8fff-000000000002';
  const project = path.join(home, '.claude', 'projects', 'synthetic-project');
  await mkdir(project, { recursive: true });
  const transcript = path.join(project, `${sessionId}.jsonl`);
  await writeFile(transcript, jsonl([
    { type: 'user', timestamp: at(nowMs, askOffsetMs - 30_000), sessionId, cwd: '/work/synthetic', entrypoint: 'cli', message: { role: 'user', content: 'Synthetic task' } },
    ask(nowMs, askOffsetMs, 'ask-1'),
  ]) + '\n');
  await utimes(transcript, nowMs / 1000, nowMs / 1000);
  const registry = new AppSourceRegistry({ homeDir: home, env: {}, platform: 'linux', discoverPersonal: false });
  let loads = 0;
  const server = createSwitchboardServer({ sourceToken: TOKEN, pendingStatePath: false, palettePath: '', dashboardWatchPaths: [], sourceRegistry: registry,
    ...(store ? { claudeQuestions: store } : {}), answerEnabled: () => true, phonePaired: async () => true,
    loadDashboard: (options) => { loads += 1; return loadSwitchboardDashboard({ ...options, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) }); },
    ...serverOptions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body, { headers = {}, raw } = {}) => fetch(base + route, { method: 'POST',
    headers: { origin: base, 'X-ASB-Source-Token': TOKEN, 'content-type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  return { home, server, port, base, post, sessionId, transcript, nowMs, loads: () => loads };
}

test('the claude-wait routes check the caller, the body, the gate, and the phone', async (t) => {
  const store = createClaudeQuestions();
  let gate = false, paired = true;
  const e = await engine(t, { store, answerEnabled: () => gate, phonePaired: async () => paired, claudeWaitMs: 50 });
  const body = { sessionId: e.sessionId, questions: [one()] };
  assert.equal((await e.post('/api/agent/claude-wait', body, { headers: { 'X-ASB-Source-Token': '' } })).status, 403);
  assert.equal((await e.post('/api/agent/claude-wait', body, { headers: { 'X-ASB-Source-Token': 'c'.repeat(64) } })).status, 403);
  assert.equal((await e.post('/api/agent/claude-wait', body, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await e.post('/api/agent/claude-wait', body, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const bad of [{ sessionId: e.sessionId }, { ...body, extra: 1 }, { ...body, sessionId: 'bad id' }, { ...body, sessionId: 'x'.repeat(129) }]) {
    assert.equal((await e.post('/api/agent/claude-wait', bad)).status, 400);
  }
  assert.equal((await e.post('/api/agent/claude-wait', undefined, { raw: '{bad' })).status, 400);
  assert.equal((await e.post('/api/agent/claude-wait', undefined, { raw: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  const gated = await e.post('/api/agent/claude-wait', body);
  assert.equal(gated.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await gated.json(), { wait: false });
  gate = true; paired = false;
  assert.deepEqual(await (await e.post('/api/agent/claude-wait', body)).json(), { wait: false });
  paired = true;
  const badQuestion = await e.post('/api/agent/claude-wait', { ...body, questions: [] });
  assert.equal(badQuestion.status, 400);
  assert.deepEqual(await badQuestion.json(), { error: 'Invalid question.' });
  const opened = await (await e.post('/api/agent/claude-wait', body)).json();
  assert.equal(opened.wait, true);
  assert.match(opened.requestId, /^[0-9a-f]{32}$/);
  assert.equal((await e.post(`/api/agent/claude-wait/${opened.requestId}`, undefined, { headers: { 'X-ASB-Source-Token': '' } })).status, 403);
  // The long poll gives open after its time.
  assert.deepEqual(await (await e.post(`/api/agent/claude-wait/${opened.requestId}`)).json(), { state: 'open' });
  assert.equal((await e.post(`/api/agent/claude-wait/${opened.requestId}`, { extra: 1 })).status, 400);
  const answered = e.post(`/api/agent/claude-wait/${opened.requestId}`);
  await delay(10);
  store.answer(opened.requestId, { 'Synthetic question?': 'A' });
  assert.deepEqual(await (await answered).json(), { state: 'answered', answers: { 'Synthetic question?': 'A' } });
  const next = await (await e.post('/api/agent/claude-wait', body)).json();
  store.close(next.requestId);
  assert.deepEqual(await (await e.post(`/api/agent/claude-wait/${next.requestId}`)).json(), { state: 'closed' });
  const unknown = await e.post(`/api/agent/claude-wait/${'0'.repeat(32)}`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Unknown question.' });
  assert.equal((await e.post(`/api/agent/claude-wait/${'g'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${e.base}/api/agent/claude-wait`)).status, 405);
});

test('a poll whose client leaves early ends its wait', async (t) => {
  const store = createClaudeQuestions();
  const e = await engine(t, { store });
  const { requestId } = await (await e.post('/api/agent/claude-wait', { sessionId: e.sessionId, questions: [one()] })).json();
  const controller = new AbortController();
  const poll = e.post(`/api/agent/claude-wait/${requestId}`).catch(() => {});
  const gone = fetch(`${e.base}/api/agent/claude-wait/${requestId}`, { method: 'POST', signal: controller.signal,
    headers: { origin: e.base, 'X-ASB-Source-Token': TOKEN } }).catch(() => 'aborted');
  await delay(50);
  controller.abort();
  assert.equal(await gone, 'aborted');
  store.answer(requestId, { 'Synthetic question?': 'B' });
  await poll;
});

test('text=1 carries the open question on its row; the plain list, the panel, and the export never do', async (t) => {
  const store = createClaudeQuestions();
  const e = await engine(t, { store });
  const get = async (route) => {
    const response = await fetch(e.base + route);
    return { etag: response.headers.get('etag'), text: await response.text() };
  };
  const before = await get('/api/dashboard?text=1');
  assert.equal(before.text.includes('"question"'), false);
  const opened = await (await e.post('/api/agent/claude-wait', { sessionId: e.sessionId, questions: [one({ question: SECRET_QUESTION })] })).json();
  const open = await get('/api/dashboard?text=1');
  assert.notEqual(open.etag, before.etag);
  const row = JSON.parse(open.text).threads.find((item) => item.id === `cli:${e.sessionId}`);
  assert.deepEqual(row.question, { requestId: opened.requestId, questions: [one({ question: SECRET_QUESTION, multiSelect: false })] });
  assert.equal(JSON.parse(open.text).threads.filter((item) => item.question).length, 1);
  assert.equal((await fetch(`${e.base}/api/dashboard?text=1`, { headers: { 'if-none-match': open.etag } })).status, 304);
  const plain = await get('/api/dashboard');
  assert.equal(plain.text.includes(SECRET_QUESTION), false);
  assert.equal(plain.etag, before.etag);
  assert.equal((await get('/api/panel')).text.includes(SECRET_QUESTION), false);
  const dashboard = await e.server.dashboardForRequest();
  assert.equal(JSON.stringify(dashboard).includes(SECRET_QUESTION), false);
  assert.equal(JSON.stringify(exportLocalSessions(dashboard, { machineId: 'm-1', name: 'Synthetic PC' })).includes(SECRET_QUESTION), false);
  store.close(opened.requestId);
  const closed = await get('/api/dashboard?text=1');
  assert.notEqual(closed.etag, open.etag);
  assert.equal(closed.text.includes(SECRET_QUESTION), false);
  assert.equal(closed.etag, before.etag);
});

test('with no client the engine closes a request that the PC answered, and loads nothing extra with no request', async (t) => {
  const store = createClaudeQuestions();
  const e = await engine(t, { store, claudeQuestionTickMs: 20, claudeQuestionReloadMs: 50 });
  await fetch(`${e.base}/api/dashboard`);
  const idle = e.loads();
  await delay(300);
  assert.equal(e.loads(), idle, 'no request: no extra load');
  const { requestId } = await (await e.post('/api/agent/claude-wait', { sessionId: e.sessionId, questions: [one()] })).json();
  // The engine itself loads the dashboard and sees the pending question.
  const deadline = Date.now() + 5_000;
  while (!store.forSession('claude', e.sessionId)?.seenPending && Date.now() < deadline) await delay(20);
  assert.ok(e.loads() > idle);
  assert.equal(store.forSession('claude', e.sessionId).seenPending, true);
  await appendFile(e.transcript, `${JSON.stringify(toolAnswer(e.nowMs, -1_000, 'ask-1'))}\n`);
  await utimes(e.transcript, e.nowMs / 1000 + 2, e.nowMs / 1000 + 2);
  const result = await Promise.race([e.post(`/api/agent/claude-wait/${requestId}`).then((reply) => reply.json()),
    delay(20_000, undefined, { ref: false }).then(() => ({ state: 'timeout' }))]);
  assert.deepEqual(result, { state: 'closed' });
  const after = e.loads();
  await delay(300);
  assert.equal(e.loads(), after, 'no open request: no extra load');
});

test('a question pending for more than six hours closes its request', async (t) => {
  const now = clock(Date.now());
  const store = createClaudeQuestions({ now });
  const e = await engine(t, { store, askOffsetMs: -7 * 60 * 60 * 1000 });
  const fresh = await engine(t, { store: createClaudeQuestions() });
  const row = async (server) => (await server.dashboardForRequest()).threads.find((item) => item.provider === 'claude-desktop-code');
  assert.ok((await row(fresh.server))[QUESTION_SESSIONS]);
  assert.equal((await row(e.server))[QUESTION_SESSIONS], undefined);
  const { requestId } = await (await e.post('/api/agent/claude-wait', { sessionId: e.sessionId, questions: [one()] })).json();
  now.advance(30_001);
  await e.server.dashboardForRequest({ force: true });
  assert.equal(store.forSession('claude', e.sessionId), null);
  assert.deepEqual(await store.wait(requestId, 0), { state: 'closed' });
});

// The hook client against a made-up engine: `reply(route)` gives [status, body, delayMs].
async function hook(t, reply, { runtime = true, port } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-claude-hook-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  let server = null;
  if (reply) {
    server = http.createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push({ route: request.url, body: raw ? JSON.parse(raw) : undefined, token: request.headers['x-asb-source-token'] });
      const [status, value, wait = 0] = await reply(request.url);
      if (wait) await delay(wait);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  }
  const runDir = path.join(home, 'runtime');
  if (runtime) {
    await mkdir(path.join(runDir, 'asb'), { recursive: true, mode: 0o700 });
    await chmod(path.join(runDir, 'asb'), 0o700);
    await writeFile(path.join(runDir, 'asb', 'service.json'), JSON.stringify({ schema: 1, pid: process.pid, port: port ?? server.address().port, sourceToken: TOKEN }), { mode: 0o600 });
  }
  const run = async (stdin) => {
    const child = spawn(process.execPath, [agentScript, 'claude-wait'], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: home, XDG_RUNTIME_DIR: runDir, XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config'), PATH: '/usr/bin:/bin' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  return { home, run, requests };
}

const hookInput = (questions, overrides = {}) => ({ session_id: 'cccccccc-dddd-4eee-8fff-000000000003', transcript_path: '/work/none.jsonl',
  permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions }, ...overrides });
const quiet = { code: 0, stdout: '', stderr: '' };

test('the hook prints nothing for bad stdin, wait false, an error, a closed request, and no engine', async (t) => {
  const h = await hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'a'.repeat(32) }] : [200, { state: 'closed' }]);
  for (const stdin of ['{bad', JSON.stringify([]), hookInput([one()], { hook_event_name: 'PreToolUse' }), hookInput([one()], { tool_name: 'Bash' }),
    hookInput([one()], { session_id: '' }), hookInput('x'), 'x'.repeat(256 * 1024 + 1)]) {
    assert.deepEqual(await h.run(stdin), quiet);
  }
  assert.equal(h.requests.length, 0);
  assert.deepEqual(await h.run(hookInput([one()])), quiet);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(await (await hook(t, () => [200, { wait: false }])).run(hookInput([one()])), quiet);
  assert.deepEqual(await (await hook(t, () => [500, { error: 'x' }])).run(hookInput([one()])), quiet);
  const restarted = await hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'a'.repeat(32) }] : [404, { error: 'Unknown question.' }]);
  assert.deepEqual(await restarted.run(hookInput([one()])), quiet);
  assert.deepEqual(await (await hook(t, null, { runtime: false })).run(hookInput([one()])), quiet);
  // A closed port: the engine is down.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.deepEqual(await (await hook(t, null, { port: closedPort })).run(hookInput([one()])), quiet);
});

test('the hook prints the exact decision for one and two questions, also after a slow first reply', async (t) => {
  const questions = [one({ question: 'Pick one?' })];
  let polls = 0;
  const h = await hook(t, (route) => {
    if (route === '/api/agent/wait') return [200, { wait: true, requestId: 'c'.repeat(32) }, 1_000];
    polls += 1;
    return polls < 2 ? [200, { state: 'open' }] : [200, { state: 'answered', answers: { 'Pick one?': 'A' } }];
  });
  const result = await h.run(hookInput(questions));
  assert.equal(result.stdout, `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":${JSON.stringify(questions)},"answers":{"Pick one?":"A"}}}}}\n`);
  assert.deepEqual([result.code, result.stderr], [0, '']);
  assert.deepEqual(h.requests[0].body, { provider: 'claude', sessionKey: 'cccccccc-dddd-4eee-8fff-000000000003', question: { questions } });
  assert.equal(h.requests[0].token, TOKEN);
  assert.deepEqual(h.requests.slice(1).map((request) => request.route), [`/api/agent/wait/${'c'.repeat(32)}`, `/api/agent/wait/${'c'.repeat(32)}`]);
  // The stdin questions go back unchanged, with their unknown keys.
  const two = [one({ question: 'Colors?', multiSelect: true, extra: 'kept' }), one({ question: 'Size?' })];
  const h2 = await hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'd'.repeat(32) }]
    : [200, { state: 'answered', answers: { 'Colors?': 'A, B', 'Size?': 'Large, typed' } }]);
  const second = await h2.run(hookInput(two));
  assert.deepEqual(JSON.parse(second.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow', updatedInput: { questions: two, answers: { 'Colors?': 'A, B', 'Size?': 'Large, typed' } } } } });
  assert.equal(second.stdout.split('\n').length, 2);
});

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

test('no question or answer text stays at rest after an open and an answer', async (t) => {
  const store = createClaudeQuestions();
  const e = await engine(t, { store });
  await mkdir(path.join(e.home, 'runtime', 'asb'), { recursive: true, mode: 0o700 });
  await chmod(path.join(e.home, 'runtime', 'asb'), 0o700);
  await writeFile(path.join(e.home, 'runtime', 'asb', 'service.json'), JSON.stringify({ schema: 1, pid: process.pid, port: e.port, sourceToken: TOKEN }), { mode: 0o600 });
  const child = spawn(process.execPath, [agentScript, 'claude-wait'], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: e.home, XDG_RUNTIME_DIR: path.join(e.home, 'runtime'), XDG_STATE_HOME: path.join(e.home, 'state'), XDG_CONFIG_HOME: path.join(e.home, 'config'),
      XDG_CACHE_HOME: path.join(e.home, 'cache'), PATH: '/usr/bin:/bin' } });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify(hookInput([one({ question: SECRET_QUESTION, options: [{ label: SECRET_ANSWER }] })], { session_id: e.sessionId })));
  const deadline = Date.now() + 5_000;
  while (!store.forSession('claude', e.sessionId) && Date.now() < deadline) await delay(20);
  const record = store.forSession('claude', e.sessionId);
  assert.ok(record);
  store.answer(record.requestId, { [SECRET_QUESTION]: SECRET_ANSWER });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.ok(stdout.includes(SECRET_ANSWER));
  for (const file of await filesUnder(e.home)) {
    const content = await readFile(file, 'utf8');
    assert.equal(content.includes(SECRET_QUESTION) || content.includes(SECRET_ANSWER), false, file);
  }
});

// The hook client against a test engine: it opens a request for `questions` and gives its stdout when it ends.
async function hookOn(e, questions) {
  await mkdir(path.join(e.home, 'runtime', 'asb'), { recursive: true, mode: 0o700 });
  await chmod(path.join(e.home, 'runtime', 'asb'), 0o700);
  await writeFile(path.join(e.home, 'runtime', 'asb', 'service.json'), JSON.stringify({ schema: 1, pid: process.pid, port: e.port, sourceToken: TOKEN }), { mode: 0o600 });
  const child = spawn(process.execPath, [agentScript, 'claude-wait'], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: e.home, XDG_RUNTIME_DIR: path.join(e.home, 'runtime'), XDG_STATE_HOME: path.join(e.home, 'state'), XDG_CONFIG_HOME: path.join(e.home, 'config'),
      XDG_CACHE_HOME: path.join(e.home, 'cache'), PATH: '/usr/bin:/bin' } });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify(hookInput(questions, { session_id: e.sessionId })));
  return { done: once(child, 'close').then(([code]) => ({ code, stdout })) };
}

const untilOpen = async (store, sessionId) => {
  const deadline = Date.now() + 5_000;
  while (!store.forSession('claude', sessionId) && Date.now() < deadline) await delay(20);
  return store.forSession('claude', sessionId);
};

test('the answer route checks the answer against the stored questions and builds the Claude answers', async (t) => {
  const store = createClaudeQuestions();
  let gate = true;
  const e = await engine(t, { store, answerEnabled: () => gate });
  const row = `/api/threads/${encodeURIComponent(`cli:${e.sessionId}`)}/answer`;
  const color = one({ question: 'Color?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true });
  const size = one({ question: 'Size?', options: [{ label: 'Small' }, { label: 'Large' }] });
  const open = async (questions) => (await (await e.post('/api/agent/claude-wait', { sessionId: e.sessionId, questions })).json()).requestId;
  const answer = (requestId, answers, options) => e.post(row, { requestId, answers }, options);
  // The store keeps the answers object without a prototype; the hook gets it as JSON.
  const result = async (requestId) => JSON.parse(JSON.stringify((await store.wait(requestId, 0)).answers));
  // One question, two with a multi-select, typed text alone, labels and typed text.
  let id = await open([one()]);
  const reply = await answer(id, [{ selected: ['B'] }]);
  assert.deepEqual([reply.status, reply.headers.get('cache-control'), await reply.json()], [200, 'no-store', { answered: true }]);
  assert.deepEqual(await result(id), { 'Synthetic question?': 'B' });
  id = await open([color, size]);
  assert.equal((await answer(id, [{ selected: ['A', 'B'] }, { selected: ['Large'] }])).status, 200);
  assert.deepEqual(await result(id), { 'Color?': 'A, B', 'Size?': 'Large' });
  id = await open([color, size]);
  assert.equal((await answer(id, [{ selected: [], other: 'Teal\tand\nnavy' }, { selected: [], other: 'Medium' }])).status, 200);
  assert.deepEqual(await result(id), { 'Color?': 'Teal\tand\nnavy', 'Size?': 'Medium' });
  id = await open([color]);
  assert.equal((await answer(id, [{ selected: ['C', 'A'], other: 'and teal' }])).status, 200);
  assert.deepEqual(await result(id), { 'Color?': 'C, A, and teal' });
  // 400: each item must fit its question; the request stays open.
  id = await open([color, size]);
  for (const answers of [[{ selected: ['A'] }], [{ selected: ['A'] }, { selected: ['Huge'] }], [{ selected: ['A', 'A'] }, { selected: ['Large'] }],
    [{ selected: ['A'] }, { selected: ['Small', 'Large'] }], [{ selected: ['A'] }, { selected: ['Large'], other: 'x' }], [{ selected: ['A'] }, { selected: [] }],
    [{ selected: [] }, { selected: ['Large'] }], [{ selected: ['A'], extra: 1 }, { selected: ['Large'] }], [{ selected: ['A'] }, { selected: [], other: '' }],
    [{ selected: ['A'] }, { selected: [], other: 'x'.repeat(2001) }], [{ selected: ['A'] }, { selected: [], other: 'Bell\x07' }],
    [{ selected: ['A'] }, { other: 'x' }], [{ selected: ['A'] }, null], [{ selected: ['A'] }, { selected: ['Large'] }, { selected: ['Large'] }], {}, 'x']) {
    const bad = await answer(id, answers);
    assert.deepEqual([bad.status, await bad.json()], [400, { error: 'Invalid answer.' }], JSON.stringify(answers));
  }
  for (const body of [{ requestId: id }, { answers: [] }, { requestId: id, answers: [], extra: 1 }, { requestId: 1, answers: [] }]) {
    assert.equal((await e.post(row, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await e.post(row, undefined, { raw: '{bad' })).status, 400);
  assert.equal((await e.post(row, undefined, { raw: 'x'.repeat(64 * 1024 + 1) })).status, 413);
  assert.equal(store.forSession('claude', e.sessionId).requestId, id);
  // 403 from another origin, 404 for an unknown row, 409 for a wrong ID, the gate off, an answered, and a closed request.
  assert.equal((await answer(id, [{ selected: ['A'] }, { selected: ['Large'] }], { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await answer(id, [{ selected: ['A'] }, { selected: ['Large'] }], { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await e.post('/api/threads/cli%3Anone/answer', { requestId: id, answers: [] })).status, 404);
  const closed = async (requestId) => {
    const response = await answer(requestId, [{ selected: ['A'] }, { selected: ['Large'] }]);
    assert.deepEqual([response.status, await response.json()], [409, { error: 'This question is closed.' }]);
  };
  await closed('0'.repeat(32));
  gate = false;
  await closed(id);
  gate = true;
  assert.equal((await answer(id, [{ selected: ['A'] }, { selected: ['Large'] }])).status, 200);
  await closed(id);
  id = await open([color, size]);
  store.close(id);
  await closed(id);
  // The upper limits: four answers with 2,000 non-ASCII characters of typed text each.
  const four = Array.from({ length: 4 }, (_, index) => one({ question: `Question ${index}?` }));
  id = await open(four);
  assert.equal((await answer(id, four.map(() => ({ selected: [], other: 'é'.repeat(2000) })))).status, 200);
  assert.deepEqual(await result(id), Object.fromEntries(four.map((item) => [item.question, 'é'.repeat(2000)])));
  assert.equal((await fetch(`${e.base}${row}`)).status, 405);
});

test('the hook prints the decision with the answers that the answer route built', async (t) => {
  const store = createClaudeQuestions();
  const e = await engine(t, { store });
  const questions = [one({ question: 'Colors?', multiSelect: true }), one({ question: 'Size?' })];
  const hooked = await hookOn(e, questions);
  const record = await untilOpen(store, e.sessionId);
  assert.ok(record);
  const reply = await e.post(`/api/threads/${encodeURIComponent(`cli:${e.sessionId}`)}/answer`,
    { requestId: record.requestId, answers: [{ selected: ['A', 'B'] }, { selected: [], other: 'Large, typed' }] });
  assert.equal(reply.status, 200);
  const { code, stdout } = await hooked.done;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow', updatedInput: { questions, answers: { 'Colors?': 'A, B', 'Size?': 'Large, typed' } } } } });
});

// The engine wiring (scripts/asb-engine.mjs) with a real phone gateway on loopback, as the gateway tests use it.
async function phoneEngine(t) {
  const store = createClaudeQuestions();
  let gateway = null;
  const e = await engine(t, { store, answerEnabled: () => gateway?.answerReady() === true });
  gateway = createPhoneGateway({ localPort: e.port, asbVersion: '0.0.0', settingsPath: path.join(e.home, 'config', 'asb', 'phone.json'),
    tlsDir: path.join(e.home, 'config', 'asb', 'phone-tls'), listAddresses: () => [{ address: '127.0.0.1', interface: 'lo', kind: 'lan' }],
    onAnswer: (on) => { if (!on) store.closeAll(); } });
  t.after(() => gateway.stop());
  await gateway.start();
  const free = async () => {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };
  const settings = { enabled: true, bindAddresses: ['127.0.0.1'], port: await free(), sendText: true, answer: true };
  // An undefined value leaves its key out of the body (the saved value stays).
  const save = (change) => { Object.assign(settings, change); return gateway.updateSettings(JSON.parse(JSON.stringify(settings))); };
  assert.equal((await save({})).running, true);
  const phone = (route, body, token) => new Promise((resolve, reject) => {
    const client = https.request({ host: '127.0.0.1', port: settings.port, path: route, method: 'POST', rejectUnauthorized: false, agent: false,
      headers: token ? { authorization: `Bearer ${token}` } : {} }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(text) }));
    });
    client.on('error', reject);
    client.end(JSON.stringify(body));
  });
  const code = new URL((await gateway.createPairing()).uri).searchParams.get('c');
  const { token } = (await phone('/phone/v1/pair', { code, deviceName: 'Synthetic phone' })).json;
  const answer = (requestId, answers) => phone(`/phone/v1/threads/${encodeURIComponent(`cli:${e.sessionId}`)}/answer`, { requestId, answers }, token);
  return { e, store, gateway, save, free, answer };
}

test('a saved switch change closes the open questions; a listener restart keeps them for the phone, with no text at rest', async (t) => {
  const { e, store, gateway, save, free, answer } = await phoneEngine(t);
  const questions = [one({ question: SECRET_QUESTION, options: [{ label: SECRET_ANSWER }, { label: 'Other synthetic gadget' }], multiSelect: true })];
  // A listener restart (a new port) keeps the open record; the phone answers it after the restart.
  let hooked = await hookOn(e, questions);
  let record = await untilOpen(store, e.sessionId);
  assert.ok(record);
  assert.equal((await save({ port: await free() })).running, true);
  assert.equal(store.forSession('claude', e.sessionId)?.requestId, record.requestId);
  const typed = 'Synthetic typed gadget note';
  const reply = await answer(record.requestId, [{ selected: [SECRET_ANSWER], other: typed }]);
  assert.deepEqual([reply.status, reply.json], [200, { answered: true }]);
  const done = await hooked.done;
  assert.deepEqual(JSON.parse(done.stdout).hookSpecificOutput.decision.updatedInput.answers, { [SECRET_QUESTION]: `${SECRET_ANSWER}, ${typed}` });
  // No question or answer text at rest in the temp HOME.
  for (const file of await filesUnder(e.home)) {
    const content = await readFile(file, 'latin1');
    assert.equal([SECRET_QUESTION, SECRET_ANSWER, typed].some((value) => content.includes(value)), false, file);
  }
  // Each saved off (answer, message text, phone access) closes the open record: the hook gets closed and prints nothing.
  for (const change of [{ answer: false }, { sendText: false, answer: undefined }, { enabled: false }]) {
    await save({ enabled: true, sendText: true, answer: true });
    assert.equal(gateway.answerReady(), true);
    hooked = await hookOn(e, questions);
    record = await untilOpen(store, e.sessionId);
    assert.ok(record, JSON.stringify(change));
    await save(change);
    assert.equal(store.forSession('claude', e.sessionId), null, JSON.stringify(change));
    assert.deepEqual(await hooked.done, { code: 0, stdout: '' }, JSON.stringify(change));
    // A new question does not wait while the switch is off.
    assert.deepEqual(await (await e.post('/api/agent/claude-wait', { sessionId: e.sessionId, questions })).json(), { wait: false });
  }
});

test('a question text that is an object key name keeps its answer', () => {
  const questions = [{ question: '__proto__', options: [{ label: 'A' }], multiSelect: false }];
  const answers = answersFor(questions, [{ selected: ['A'] }]);
  assert.equal(answers.__proto__, 'A');
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), JSON.parse('{"__proto__":"A"}'));
  assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(answers)), '__proto__'));
});
