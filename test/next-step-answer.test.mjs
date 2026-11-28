// The P2a next-step question: the reader keeps the ask text in memory only, a local Desktop Code row shows the card, the answer
// route runs the contract checks and sends one `/deliver-bound` frame, the gateway sets the device headers, and a member answer runs
// the member's own checks. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { createClaudeQuestions } from '../src/claude-questions.mjs';
import { loadClaudeDesktopCodeThreads, nextStepQuestion, parseClaudeJsonlSignals, useClaudeQuestionText } from '../src/claude-data.mjs';
import { exportLocalSessions, validExport } from '../src/machine-peers.mjs';
import { createRelaySupervisor } from '../src/machine-relay.mjs';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { buildSwitchboardDashboard, createSwitchboardServer, loadSwitchboardDashboard, NEXT_STEP } from '../src/switchboard.mjs';
import { createMachineGroup, saveGroup } from '../src/machine-group.mjs';

const TOKEN = 'c'.repeat(64);
const MACHINE = '0123456789abcdef';
const SCOPE = 'ab'.repeat(16);
const CLI = '11111111-1111-4111-8111-111111111111';
const LOCAL = `local_${CLI}`;
const WRAP = 'wrap-1';
const ASK = 'Synthetic wrap-up ask: which way?';
const REQUEST_ID = createHash('sha256').update(`next-step\0${CLI}\0${WRAP}`).digest('hex').slice(0, 32);

// Made-up transcripts: a task, a wrap-up tool_use with an ask and actions, and its tool_result that ends the turn.
const at = (nowMs, offset) => new Date(nowMs + offset).toISOString();
const jsonl = (events) => events.map(JSON.stringify).join('\n');
const prompt = (nowMs, offset) => ({ type: 'user', timestamp: at(nowMs, offset), sessionId: CLI, cwd: '/work/synthetic', entrypoint: 'cli',
  message: { role: 'user', content: 'Synthetic task' } });
const wrapUp = (nowMs, offset, input, id = WRAP) => ({ type: 'assistant', timestamp: at(nowMs, offset),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input }] } });
const wrapResult = (nowMs, offset, id = WRAP) => ({ type: 'user', timestamp: at(nowMs, offset),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const ACTIONS = [{ label: 'Go on' }, { label: 'Stop here' }, { label: 'Commit', action: 'commit' }];

function transcript(nowMs, options = {}) {
  const ask = options.ask === undefined ? ASK : options.ask;
  return [...(options.task === false ? [] : [prompt(nowMs, -60_000)]),
    ...(ask === null ? [] : [wrapUp(nowMs, -30_000, { recap: 'Synthetic recap', ask, actions: options.actions === undefined ? ACTIONS : options.actions })]),
    ...(options.withResult === false ? [] : [wrapResult(nowMs, -20_000)]),
    ...(options.later ? [prompt(nowMs, -10_000)] : [])];
}

async function claudeSource(t, nowMs, options = {}) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-next-step-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  // The default folders of the builtin source (it names no dataDir), so the registry reads this home.
  const appDir = path.join(homeDir, '.config', 'Claude');
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  const sessions = path.join(appDir, 'claude-code-sessions');
  const project = path.join(projectsDir, `project-${options.name || 'one'}`);
  await mkdir(sessions, { recursive: true });
  await mkdir(project, { recursive: true });
  const file = path.join(project, `${CLI}.jsonl`);
  await writeFile(file, `${jsonl(transcript(nowMs, options))}\n`);
  await utimes(file, nowMs / 1000, nowMs / 1000);
  const metadata = path.join(sessions, `${LOCAL}.json`);
  await writeFile(metadata, JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI, originCwd: '/work/synthetic', createdAt: nowMs - 120_000, lastActivityAt: nowMs }));
  await utimes(metadata, nowMs / 1000, nowMs / 1000);
  return { homeDir, appDir, projectsDir, file, sessions, project };
}

// The engine-side identity of a phone: the same shape that the answer route builds.
const phoneSessionId = (deviceId) => {
  const hex = createHash('sha256').update(`phone\0${deviceId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
};

// One made-up engine with one next-step row: the binder proves a live inbox, the relay records each `/deliver-bound` frame.
async function rowFixture(t, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  // The transcript options (ask, actions, withResult) go to the writer; the card options stay for the engine.
  const source = await claudeSource(t, nowMs, { ask: options.ask, actions: options.actions, withResult: options.withResult, later: options.later, name: options.name });
  const registry = new AppSourceRegistry({ homeDir: source.homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  const state = { relay: options.relay !== false, bind: options.bind !== false, outcome: 'submitted', reason: undefined };
  const frames = [];
  const bindings = [];
  const machineRelay = {
    running: () => state.relay,
    deliverBoundPhone: async (binding, sender, message) => {
      // One turn of the loop between the bind and the write, so a second POST can reach the in-flight check in between.
      await new Promise((resolve) => setImmediate(resolve));
      // A not-sent result wrote nothing: only a real write is a frame here.
      if (state.outcome !== 'not-sent') frames.push({ binding, sender, message });
      return state.outcome === 'not-sent' ? { outcome: 'not-sent', reason: state.reason } : { outcome: state.outcome };
    },
  };
  const store = options.claudeQuestions || null;
  const server = createSwitchboardServer({ sourceToken: TOKEN, pendingStatePath: false, palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: registry, answerEnabled: () => options.answer !== false, phonePaired: async () => true,
    ...(store ? { claudeQuestions: store } : {}),
    machineIdentity: () => ({ machineId: MACHINE, machineName: 'synthetic-pc' }), referenceScopes: () => () => SCOPE,
    machineRelay,
    bindMemberTarget: async (request) => {
      bindings.push(request);
      if (!state.bind) return { ok: false, code: 'not-live' };
      return { apiVersion: 1, ok: true, pid: process.pid, binding: { registryHome: path.join(source.homeDir, '.claude', 'sessions'),
        runtimeSessionId: '22222222-2222-4222-8222-222222222222', pid: 4242, procStart: '100', messagingSocketPath: '/tmp/synthetic.sock',
        msgId: request?.msgId ?? '33333333-3333-4333-8333-333333333333', hostSessionId: LOCAL, expiresAtMs: Date.now() + 10_000 } };
    },
    loadDashboard: (loadOptions) => loadSwitchboardDashboard({ ...loadOptions, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = async (query = '?text=1') => JSON.parse(await (await fetch(`${base}/api/dashboard${query}`)).text()).threads;
  const id = (await rows()).find((row) => row.provider === 'claude-desktop-code')?.id;
  const card = async () => (await rows()).find((row) => row.id === id)?.question;
  // The card's own ID, even after a test changes it: the route reads the card live from the row.
  const cardId = async () => (await card())?.requestId;
  const answer = async (answers, headers = {}, requestId) => fetch(`${base}/api/threads/${encodeURIComponent(id)}/answer`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ requestId: requestId ?? await cardId(), answers }) });
  return { server, base, source, rows, id, card, answer, frames, bindings, state, store };
}

test('the reader keeps the ask, reply labels, and app actions in memory only, only while question text is on', (t) => {
  t.after(() => useClaudeQuestionText(false));
  const nowMs = Date.parse('2026-11-28T10:00:00Z');
  const text = jsonl(transcript(nowMs));
  // The switch off: no card.
  assert.equal(nextStepQuestion({ pendingTools: parseClaudeJsonlSignals(text).pendingTools, cliSessionId: CLI }), null);
  // Before the wrap-up result, the turn still runs: no card.
  assert.equal(nextStepQuestion({ pendingTools: parseClaudeJsonlSignals(jsonl(transcript(nowMs, { withResult: false }))).pendingTools, cliSessionId: CLI }), null);
  useClaudeQuestionText(true);
  const signals = parseClaudeJsonlSignals(text);
  assert.deepEqual(nextStepQuestion({ pendingTools: signals.pendingTools, cliSessionId: CLI }),
    { requestId: REQUEST_ID, kind: 'next-step', appActions: ['Commit'], ask: ASK,
      questions: [{ question: ASK, header: '', options: [{ label: 'Go on', description: '' }, { label: 'Stop here', description: '' }],
        multiSelect: false, allowOther: true }] });
  // The signals keep the pending tool textless: the ask text never rides on the row state or a saved record.
  const tool = signals.pendingTools.find((item) => item.tool === 'AskUserQuestion');
  assert.deepEqual(Object.keys(tool).sort(), ['id', 'kind', 'signalAtMs', 'status', 'title', 'tool']);
  assert.equal(JSON.stringify(signals).includes('Synthetic wrap-up ask'), false);
});

test('a wrap-up with no ask gives no card, a later user turn clears it, and the ask and labels are limited', (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const nowMs = Date.parse('2026-11-28T10:00:00Z');
  const card = (testOptions) => nextStepQuestion({ pendingTools: parseClaudeJsonlSignals(jsonl(transcript(nowMs, testOptions))).pendingTools, cliSessionId: CLI });
  assert.equal(card({ ask: '   ' }), null);
  assert.equal(card({ ask: null }), null);
  assert.equal(card({ later: true }), null);
  // An ask of 2500 code points is cut to 2000.
  assert.equal([...card({ ask: 'é'.repeat(2500) }).questions[0].question].length, 2000);
  // Labels: an empty, a too-long, and a duplicate label give no entry; at most 8.
  const labels = ['A', 'A', '', 'x'.repeat(201), ...Array.from({ length: 9 }, (_, index) => `L${index}`)];
  assert.deepEqual(card({ actions: labels.map((label) => ({ label })) }).questions[0].options.map((option) => option.label),
    ['A', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  // No actions: an empty option list, Other only.
  assert.deepEqual(card({ actions: [] }).questions[0].options, []);
});

test('the row shows the next-step card with the contract shape, only for a local Desktop row, the switch, and no hook record', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const f = await rowFixture(t);
  const card = await f.card();
  assert.deepEqual(card, { requestId: REQUEST_ID, kind: 'next-step', live: true,
    questions: [{ question: ASK, header: '', options: [{ label: 'Go on', description: '' }, { label: 'Stop here', description: '' }],
      multiSelect: false, allowOther: true }], appActions: ['Commit'] });
  // No live inbox: `live` false and the liveness line.
  assert.deepEqual(await (await rowFixture(t, { bind: false })).card(), { ...card, live: false, unavailable: 'Open the session on the PC to answer.' });
  // No relay: `live` false and the relay line.
  assert.deepEqual(await (await rowFixture(t, { relay: false })).card(), { ...card, live: false, unavailable: 'Answer on the PC: the ASB message relay is not running.' });
  // The switch off: no card, and no ask text in the list.
  const off = await rowFixture(t, { answer: false });
  assert.equal(await off.card(), undefined);
  assert.equal((await off.rows()).some((row) => JSON.stringify(row).includes('Synthetic wrap-up ask')), false);
  // A hook record open for the row: the hook card path, never a second card.
  const store = createClaudeQuestions();
  const hooked = await rowFixture(t, { claudeQuestions: store });
  const { requestId } = store.open({ provider: 'claude', sessionKey: CLI, questions: [{ question: 'Hook question?', options: [{ label: 'Yes' }] }] });
  assert.deepEqual(await hooked.card(), { requestId, questions: [{ question: 'Hook question?', options: [{ label: 'Yes' }], multiSelect: false }] });
  // An answer with the next-step request ID while the hook record is open: closed, since the hook card has its own ID now.
  assert.equal((await hooked.answer([{ selected: ['Go on'] }], {}, REQUEST_ID)).status, 409);
  assert.equal(hooked.frames.length, 0);
});

test('the answer route runs the contract replies and sends one frame with the exact text', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const f = await rowFixture(t);
  // 400: both a label and Other, neither, an unknown label, two items, an extra key, an empty list.
  for (const answers of [[{ selected: ['Go on'], other: 'x' }], [{ selected: [] }], [{ selected: ['Not an option'] }], [],
    [{ selected: ['Go on'] }, { selected: ['Stop here'] }], [{ selected: ['Go on'], extra: 1 }], [{ other: 'x' }],
    [{ selected: ['Go on'], other: 'x'.repeat(4001) }], [{ selected: [], other: 'bell\x07' }]]) {
    const response = await f.answer(answers);
    assert.deepEqual([response.status, (await response.json()).error], [400, 'Invalid answer.'], JSON.stringify(answers));
  }
  // 409 for an unknown request ID.
  assert.equal((await f.answer([{ selected: ['Go on'] }], {}, '0'.repeat(32))).status, 409);
  // The live flag reads the binder during the dashboard build, before these POSTs.
  assert.equal(f.frames.length, 0, 'nothing sent before all checks pass');
  // 200 for a selected label: one frame, the exact text, the phone sender, the loopback device.
  const sent = await f.answer([{ selected: ['Go on'] }]);
  assert.deepEqual([sent.status, await sent.json()], [200, { answered: true }]);
  assert.equal(f.frames.length, 1);
  const [frame] = f.frames;
  assert.deepEqual(frame.sender, { machineId: MACHINE, sessionId: phoneSessionId('loopback'), name: 'Phone', mode: 'unknown', agent: 'phone' });
  assert.deepEqual(frame.message.hopChain, []);
  assert.equal(frame.message.text, `[Sent from the owner's phone (phone) through ASB. It answers your question: "${ASK}"]\nGo on`);
  assert.ok(frame.message.text.includes(`"${ASK}"`), 'a quote stays as it is');
  // An "Other" answer is the reply text as typed, with a newline and a tab allowed.
  const other = await rowFixture(t);
  assert.equal((await other.answer([{ selected: [], other: 'line one\nline two\ttab' }])).status, 200);
  assert.ok(other.frames[0].message.text.endsWith('\nline one\nline two\ttab'));
  // The same request again: 409 Already answered, and no second frame.
  assert.deepEqual([(await f.answer([{ selected: ['Stop here'] }])).status, (await (await f.answer([{ selected: ['Stop here'] }])).json()).error,
    f.frames.length], [409, 'Already answered.', 1]);
});

test('the frame text follows the contract for a quote, a newline, a tab, 300 characters, and the device names', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const nowMs = Date.now();
  // An ask with a newline, a tab, a quote, and 30 words: one line, cut to 200 code points, with the quote as it is.
  const longAsk = `${'word '.repeat(30)}\n\twith "a quote"`;
  const f = await rowFixture(t, { nowMs, ask: longAsk, actions: [{ label: 'Go on' }] });
  assert.equal((await f.answer([{ selected: ['Go on'] }])).status, 200);
  const flat = [...longAsk.replace(/[\n\t]/g, ' ').trim()].slice(0, 200).join('');
  assert.equal(f.frames[0].message.text, `[Sent from the owner's phone (phone) through ASB. It answers your question: "${flat}"]\nGo on`);
  // A 300-character ask is cut to 200 in the line.
  const long = await rowFixture(t, { nowMs, ask: 'x'.repeat(300) });
  assert.equal((await long.answer([{ selected: [], other: 'do it' }])).status, 200);
  assert.equal(long.frames[0].message.text, `[Sent from the owner's phone (phone) through ASB. It answers your question: "${'x'.repeat(200)}"]\ndo it`);
  // The device names: brackets and a control character go, non-ASCII stays, cut to 64; an empty name is `phone`.
  for (const [name, expected] of [['Pixel [7]\x07 é', 'Pixel 7 é'], ['', 'phone'], ['é'.repeat(80), 'é'.repeat(64)]]) {
    const device = await rowFixture(t, { nowMs });
    assert.equal((await device.answer([{ selected: ['Go on'] }], { 'x-asb-phone-device-id': 'a'.repeat(12),
      'x-asb-phone-device-name': encodeURIComponent(name) })).status, 200);
    assert.equal(device.frames[0].message.text, `[Sent from the owner's phone (${expected}) through ASB. It answers your question: "${ASK}"]\nGo on`);
    assert.equal(device.frames[0].sender.sessionId, phoneSessionId('a'.repeat(12)));
    assert.match(device.frames[0].sender.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('two concurrent POSTs give one relay call, and the in-flight mark goes away only on not-sent', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const f = await rowFixture(t);
  const answers = [{ selected: ['Go on'] }];
  const [one, two] = await Promise.all([f.answer(answers), f.answer(answers)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(f.frames.length, 1);
  // A not-sent result: 429 for the rate limit, and the mark goes away, so a retry sends.
  const limited = await rowFixture(t);
  limited.state.outcome = 'not-sent';
  limited.state.reason = 'rate-limited';
  assert.deepEqual([(await limited.answer(answers)).status, (await (await limited.answer(answers)).json()).error], [429, 'Too many answers. Try again in a minute.']);
  limited.state.outcome = 'submitted';
  assert.equal((await limited.answer(answers)).status, 200);
  // The first (not-sent) call and the retry: the not-sent one is not a frame.
  assert.equal(limited.frames.length, 1);
  // The other not-sent reasons.
  for (const [reason, expected] of [['target-unavailable', 'Open the session on the PC to answer.'], ['target-changed', 'Open the session on the PC to answer.'],
    ['binding-expired', 'Cannot send now. Answer on the PC.'], ['relay-unavailable', 'Cannot send now. Answer on the PC.']]) {
    const stopped = await rowFixture(t);
    stopped.state.outcome = 'not-sent';
    stopped.state.reason = reason;
    const response = await stopped.answer(answers);
    assert.deepEqual([response.status, (await response.json()).error], [409, expected], reason);
  }
});

test('the answer route answers 409 for an offline inbox and a stopped relay, and 200 once for an unknown outcome', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const answers = [{ selected: ['Go on'] }];
  const offline = await rowFixture(t, { bind: false });
  assert.deepEqual([(await offline.answer(answers)).status, offline.frames.length], [409, 0]);
  const relayOff = await rowFixture(t, { relay: false });
  const relayResponse = await relayOff.answer(answers);
  assert.deepEqual([relayResponse.status, (await relayResponse.json()).error], [409, 'Cannot send now: the ASB message relay is not running on the PC.']);
  // An unknown outcome: 200, and a retry keeps 409 (the ID stays), with one frame.
  const unknown = await rowFixture(t);
  unknown.state.outcome = 'unknown';
  const first = await unknown.answer(answers);
  assert.deepEqual([first.status, await first.json()], [200, { answered: true }]);
  assert.deepEqual([(await unknown.answer(answers)).status, unknown.frames.length], [409, 1]);
});

test('the gateway sets both device headers on the answer proxy and drops any copy from the phone', async (t) => {
  const upstream = [];
  const local = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    upstream.push({ url: request.url, headers: request.headers });
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end('{"error":"This question is closed."}');
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => local.close(resolve)));
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-next-step-gateway-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const gateway = createPhoneGateway({ localPort: local.address().port, asbVersion: 'test', settingsPath: path.join(home, 'phone.json'),
    tlsDir: path.join(home, 'tls'), listAddresses: () => [{ address: '127.0.0.1', interface: 'lo', kind: 'lan' }], hostName: 'synthetic-pc' });
  await gateway.start();
  const port = 46_390 + Math.floor(Math.random() * 200);
  assert.equal((await gateway.updateSettings({ enabled: true, bindAddresses: ['127.0.0.1'], port, sendText: true, answer: true })).running, true);
  t.after(() => gateway.stop());
  const info = await gateway.createPairing();
  const code = new URL(info.uri).searchParams.get('c');
  const call = (route, options) => new Promise((resolve, reject) => {
    const client = https.request({ host: '127.0.0.1', port, path: route, rejectUnauthorized: false, agent: false, ...options }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    client.on('error', reject);
    client.end(options.body);
  });
  const paired = JSON.parse((await call('/phone/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'Test phone' }) })).text);
  const reply = await call(`/phone/v1/threads/${encodeURIComponent(LOCAL)}/answer`, { method: 'POST',
    headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json', 'x-asb-phone-device-id': 'ffffffffffff',
      'x-asb-phone-device-name': 'Fake%20phone' }, body: JSON.stringify({ requestId: REQUEST_ID, answers: [{ selected: ['Go on'] }] }) });
  assert.equal(reply.status, 409);
  const sent = upstream.at(-1);
  assert.equal(sent.headers['x-asb-phone-device-id'], paired.deviceId);
  assert.equal(decodeURIComponent(sent.headers['x-asb-phone-device-name']), 'Test phone');
});

test('the relay starts with no member while answers are ready and a Desktop source is on, and drops a phone receipt', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-next-step-relay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'bridge', 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'bridge', 'dist', 'relay.js'), '');
  await writeFile(path.join(dir, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(path.join(dir, 'bin', 'cat'), '#!/bin/sh\n', { mode: 0o755 });
  const spawns = [];
  const logs = [];
  const state = { answers: true, desktop: true };
  const group = { self: () => ({ machineId: MACHINE, name: 'alpha' }), selfName: () => 'alpha', peerStates: () => [], tls: async () => ({ fingerprint: 'own' }) };
  const fakeChild = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, signals: [] });
    child.kill = (signal = 'SIGTERM') => {
      child.signals.push(signal);
      setImmediate(() => { Object.assign(child, { exitCode: null, signalCode: signal }); child.stdout.end(); child.emit('exit', null, signal); });
      return true;
    };
    return child;
  };
  const supervisor = createRelaySupervisor({ group, port: 4659, sourceToken: TOKEN, root: dir, platform: 'linux',
    env: { PATH: path.join(dir, 'bin'), XDG_RUNTIME_DIR: path.join(dir, 'run') }, log: (line) => logs.push(line), firstLineMs: 200, stopMs: 50,
    forAnswers: async () => state.answers && state.desktop,
    spawn: () => {
      const child = fakeChild();
      spawns.push(child);
      setImmediate(() => child.stdout.write(`${JSON.stringify({ port: 1, token: 'e'.repeat(64) })}\n`));
      return child;
    } });
  t.after(() => supervisor.stop());
  // No member and the switch off: no relay.
  state.answers = false;
  await supervisor.start();
  assert.equal(spawns.length, 0, 'no relay with the switch off');
  // The switch on with a Desktop source: the relay starts with no member.
  state.answers = true;
  await supervisor.check();
  assert.equal(spawns.length, 1, 'the relay starts for answers');
  assert.equal(supervisor.running(), true);
  // A Desktop source off: the relay stops.
  state.desktop = false;
  await supervisor.check();
  assert.equal(supervisor.running(), false);
  // A receipt of a phone answer names this machine: there is no member, so nothing goes out and nothing is logged.
  const control = { action: 'peer_message_status', orig_msg_id: '44444444-4444-4444-8444-444444444444', status: 'delivered' };
  assert.deepEqual(await supervisor.sendReceipt({ machineId: MACHINE, control }), { status: 200, body: { sent: false } });
  assert.deepEqual(logs, []);
});

// The 1.19.0 checkedPhoneRequest rules, copied as the fixture of the contract's Group members test: an unknown kind gives null,
// so an old home keeps the row and shows no card.
function checkedPhoneRequest119(value) {
  if (typeof value?.requestId !== 'string' || !/^[0-9a-f]{32}$/.test(value.requestId)) return null;
  const { kind, requestId } = value;
  if (kind === 'question') return { kind, requestId, questions: value.questions };
  if (kind === 'approval') return { kind, requestId, approval: value.approval };
  return null;
}

test('a member exports the card; the 1.19.0 validator keeps the row and drops it, the new one keeps it', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const nowMs = Date.now();
  const source = await claudeSource(t, nowMs);
  const { threads } = await loadClaudeDesktopCodeThreads({ appDir: source.appDir, projectsDir: source.projectsDir, nowMs });
  // The card as the dashboard build makes it: `nextStepQuestion` plus the live flag (its own check is on the answer route).
  const card = { ...nextStepQuestion(threads[0]), live: true };
  const built = buildSwitchboardDashboard(threads.map((thread) => ({ ...thread, sourceId: 'claude-desktop-code', sourceLabel: 'Claude Desktop Code' })),
    [], nowMs, { machineId: MACHINE, machineName: 'synthetic-pc' });
  const row = built.threads.find((item) => item.provider === 'claude-desktop-code');
  // A card is attached to a local row with a reference: add both, as the engine scan does.
  Object.defineProperty(row, NEXT_STEP, { value: card });
  row.reference = `asb:1/${MACHINE}/claude-desktop-code/${SCOPE}/claude-local:${LOCAL}`;
  const exported = exportLocalSessions({ threads: [row], messages: [] }, { machineId: MACHINE, name: 'synthetic-pc' }, nowMs);
  assert.equal(exported.rows[0].phoneRequest, undefined, 'the plain export keeps no card');
  assert.equal(JSON.stringify(exported).includes('Synthetic wrap-up ask'), false);
  // The group sessions reply adds the card to the export rows (machine-group.mjs), under the member's own answer switch.
  const accepted = validExport({ ...exported, rows: [{ ...exported.rows[0], phoneRequest: card }] }, { machineId: MACHINE });
  assert.deepEqual(accepted.rows[0].phoneRequest, { kind: 'next-step', requestId: REQUEST_ID, live: true, appActions: ['Commit'],
    questions: [{ question: ASK, header: '', options: [{ label: 'Go on', description: '' }, { label: 'Stop here', description: '' }],
      multiSelect: false, allowOther: true }] });
  assert.equal(accepted.rows[0].id, exported.rows[0].id);
  // The 1.19.0 rules drop only the card; the row stays.
  assert.equal(checkedPhoneRequest119(accepted.rows[0].phoneRequest), null);
  // A bad field drops only the card.
  for (const bad of [{ ...card, live: 'yes' }, { ...card, questions: [{ question: ASK, options: [] }] }, { ...card, appActions: ['x'.repeat(201)] }]) {
    const dropped = validExport({ ...exported, rows: [{ ...exported.rows[0], phoneRequest: bad }] }, { machineId: MACHINE });
    assert.equal(dropped.rows[0].phoneRequest, undefined, JSON.stringify(bad));
    assert.equal(dropped.rows[0].id, exported.rows[0].id);
  }
});

test('a member answer runs the member\'s own checks: its switch, its inbox, its relay, its in-flight list', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const answers = [{ selected: ['Go on'] }];
  const body = (requestId = REQUEST_ID) => ({ requestId, answers });
  // The member's own answer lacks a live inbox: its route says so, not the home.
  const noInbox = await rowFixture(t, { bind: false });
  assert.deepEqual(await noInbox.server.answerLocalThread(noInbox.id, body()),
    { status: 409, body: { error: 'Open the session on the PC to answer.' } });
  // The member's own relay is off.
  const noRelay = await rowFixture(t, { relay: false });
  assert.deepEqual(await noRelay.server.answerLocalThread(noRelay.id, body()),
    { status: 409, body: { error: 'Cannot send now: the ASB message relay is not running on the PC.' } });
  // The member's own answer switch is off: the row has no card, so the answer is closed.
  const off = await rowFixture(t, { answer: false });
  assert.deepEqual(await off.server.answerLocalThread(off.id, body()), { status: 409, body: { error: 'This question is closed.' } });
  // Its own in-flight list: one send, then Already answered, with one frame.
  const member = await rowFixture(t);
  const [one, two] = await Promise.all([member.server.answerLocalThread(member.id, body()), member.server.answerLocalThread(member.id, body())]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(member.frames.length, 1);
  // A remote row is closed on the local route (its own home answers it).
  const remote = await rowFixture(t);
  const remoteRow = { ...(await remote.rows()).find((row) => row.id === remote.id), remote: true, id: `m:${MACHINE}:${remote.id}` };
  remote.server.dashboardForRequest = async () => ({ threads: [remoteRow] });
  assert.deepEqual(await remote.server.answerLocalThread(remoteRow.id, body()), { status: 409, body: { error: 'This question is closed.' } });
});

test('the group sessions reply carries the card under the member\'s own answer switch, and the home merges it', async (t) => {
  t.after(() => useClaudeQuestionText(false));
  useClaudeQuestionText(true);
  const nowMs = Date.now();
  const source = await claudeSource(t, nowMs);
  const registry = new AppSourceRegistry({ homeDir: source.homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  const store = createClaudeQuestions();
  const state = { answer: true, frames: [] };
  const machineRelay = { running: () => true, deliverBoundPhone: async (binding, sender, message) => { state.frames.push(message); return { outcome: 'submitted' }; } };
  const server = createSwitchboardServer({ sourceToken: TOKEN, pendingStatePath: false, palettePath: '', dashboardWatchPaths: [],
    sourceRegistry: registry, claudeQuestions: store, answerEnabled: () => state.answer, phonePaired: async () => true,
    machineIdentity: () => ({ machineId: MACHINE, machineName: 'synthetic-pc' }), referenceScopes: () => () => SCOPE, machineRelay,
    bindMemberTarget: async (request) => ({ apiVersion: 1, ok: true, pid: 1, binding: { registryHome: '/x', runtimeSessionId: '22222222-2222-4222-8222-222222222222',
      pid: 1, procStart: '1', messagingSocketPath: '/tmp/s.sock', msgId: request?.msgId, hostSessionId: LOCAL, expiresAtMs: Date.now() + 10_000 } }),
    loadDashboard: (loadOptions) => loadSwitchboardDashboard({ ...loadOptions, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  // The group gateway: one active member (its own), so the export has this machine's rows and no merge.
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-next-step-group-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'group.json');
  // The self member's certificate fingerprint starts with its machine ID (the group rules).
  const selfPrint = `${MACHINE}${'f'.repeat(48)}`;
  await saveGroup(file, { schema: 1, groupId: 'abc'.repeat(5) + 'd', self: { machineId: MACHINE, name: 'synthetic-pc' },
    members: [{ machineId: MACHINE, name: 'synthetic-pc', certFingerprint: selfPrint, addresses: [{ kind: 'lan', address: '192.168.0.1' }], port: 4630, addedBy: MACHINE, addedAtMs: 1 }],
    removed: [], phones: [{ deviceId: 'a'.repeat(12), name: 'Phone', tokenHash: 'e'.repeat(64), addedBy: MACHINE, addedAtMs: 1 }], removedPhones: [] });
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} };
  const gateway = { credentials: async () => ({ fingerprint: selfPrint }), status: async () => ({ running: false }),
    identity: async () => MACHINE, referenceScopes: async () => () => SCOPE,
    answerReady: () => state.answer, approveReady: () => false };
  const group = createMachineGroup({ file, gateway: () => gateway, server: () => server, timers, now: () => nowMs,
    request: async () => ({ status: 200, body: {} }) });
  await group.start();
  t.after(() => group.stop());
  // The export comes from the first dashboard scan (the merge fills it), as on the engine.
  const dashboard = await server.dashboardForRequest({ force: true });
  group.merge(dashboard, nowMs);
  const reply = await group.peer.sessions('');
  assert.equal(reply.status, 200);
  const exported = JSON.parse(reply.body);
  const row = exported.rows.find((item) => item.provider === 'claude-desktop-code');
  assert.ok(row);
  assert.equal(row.phoneRequest.kind, 'next-step');
  assert.equal(row.phoneRequest.live, true);
  // The home accepts it, and the row keeps the card (the 1.19.0 rules drop it and keep the row).
  const accepted = validExport(exported, { machineId: MACHINE });
  assert.ok(accepted);
  assert.ok(accepted.rows.find((item) => item.id === row.id).phoneRequest);
  // The switch off: the reply has no card.
  state.answer = false;
  const noCard = JSON.parse((await group.peer.sessions('')).body);
  assert.equal(noCard.rows.find((item) => item.id === row.id).phoneRequest, undefined);
});

test('the relay sends one bound phone message through /deliver-bound on its own loopback server', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-next-step-bound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'bridge', 'dist'), { recursive: true });
  await mkdir(path.join(dir, 'bin'));
  await writeFile(path.join(dir, 'bridge', 'dist', 'relay.js'), '');
  await writeFile(path.join(dir, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(path.join(dir, 'bin', 'cat'), '#!/bin/sh\n', { mode: 0o755 });
  // A fake relay: its loopback server records the body and answers a submitted outcome.
  const requests = [];
  const relayServer = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ outcome: 'submitted' }));
    });
  });
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => relayServer.close(resolve)));
  const group = { self: () => ({ machineId: MACHINE, name: 'alpha' }), selfName: () => 'alpha', peerStates: () => [], tls: async () => ({ fingerprint: 'own' }) };
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); return true; };
  const supervisor = createRelaySupervisor({ group, port: 4659, sourceToken: TOKEN, root: dir, platform: 'linux',
    env: { PATH: path.join(dir, 'bin'), XDG_RUNTIME_DIR: path.join(dir, 'run') }, log: () => {}, firstLineMs: 200, stopMs: 50,
    forAnswers: async () => true,
    spawn: () => {
      setImmediate(() => child.stdout.write(`${JSON.stringify({ port: relayServer.address().port, token: 'e'.repeat(64) })}\n`));
      return child;
    } });
  await supervisor.start();
  assert.equal(supervisor.running(), true);
  t.after(() => supervisor.stop());
  const binding = { registryHome: '/synthetic/claude/sessions', runtimeSessionId: '22222222-2222-4222-8222-222222222222', pid: 4242, procStart: '100',
    messagingSocketPath: '/tmp/synthetic.sock', msgId: '33333333-3333-4333-8333-333333333333', hostSessionId: LOCAL, expiresAtMs: Date.now() + 10_000 };
  const sender = { machineId: MACHINE, sessionId: phoneSessionId('a'.repeat(12)), name: 'Phone', mode: 'unknown', agent: 'phone' };
  const message = { msgId: '44444444-4444-4444-8444-444444444444', text: '[Sent from the owner\'s phone (Phone) through ASB.]\nGo on', hopChain: [] };
  assert.deepEqual(await supervisor.deliverBoundPhone(binding, sender, message), { outcome: 'submitted' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/deliver-bound');
  assert.equal(requests[0].headers.authorization, `Bearer ${'e'.repeat(64)}`);
  const body = JSON.parse(requests[0].body);
  assert.deepEqual([body.binding.msgId, body.sender.agent, body.message.msgId], [binding.msgId, 'phone', message.msgId]);
  // A relay that is not running: the route maps the error to the relay reply.
  await supervisor.stop();
  await assert.rejects(() => supervisor.deliverBoundPhone(binding, sender, message), (error) => error.code === 'relay-unavailable');
});
