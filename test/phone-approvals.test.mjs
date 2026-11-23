import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CODEX_FIRST_MS, createClaudeQuestions, PROVIDERS } from '../src/claude-questions.mjs';
import { applyBridgeWaits } from '../src/codex-data.mjs';
import { BIT_INPUT } from '../src/asb-sounds.mjs';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { CLI_SESSION_IDS } from '../src/session-targets.mjs';
import { processStart } from '../src/claude-registry.mjs';
import { ACTION_AT, buildSwitchboardDashboard, createSwitchboardServer, loadSwitchboardDashboard } from '../src/switchboard.mjs';
import { OPENCODE_APPROVAL_WAIT } from '../src/opencode-data.mjs';
import { claudeApproval } from '../scripts/asb-agent.mjs';

// Made-up data only.
let hasOpenSsl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenSsl = false; }
const gatewayTest = (name, run) => test(name, { skip: hasOpenSsl ? false : 'openssl is not on PATH.' }, run);
const agentScript = fileURLToPath(new URL('../scripts/asb-agent.mjs', import.meta.url));
const TOKEN = 'b'.repeat(64);
const SESSION = 'cccccccc-dddd-4eee-8fff-000000000007';
const approval = (overrides = {}) => ({ kind: 'tool', title: 'Allow Bash?', display: [{ label: 'Command', text: 'echo synthetic', mono: true }], note: true, ...overrides });
const clock = (start = 1_000_000) => { const value = { now: start }; return Object.assign(() => value.now, { advance: (ms) => { value.now += ms; } }); };
const permission = (tool_name, tool_input, extra = {}) => ({ session_id: SESSION, transcript_path: '/work/none.jsonl', cwd: '/work', prompt_id: 'p-1',
  permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name, tool_input, ...extra });
const allowJson = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n';
const denyJson = (message) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })}\n`;

test('the Claude display shows each tool shape with its limits, and no content', () => {
  const display = (name, input, extra) => claudeApproval(permission(name, input, extra));
  assert.deepEqual(display('Bash', { command: 'ls -la /work', description: 'List the files' }), { kind: 'tool', title: 'Allow Bash?', note: true,
    display: [{ label: 'Command', text: 'ls -la /work', mono: true }, { label: 'Description', text: 'List the files', mono: false }] });
  assert.deepEqual(display('Bash', { command: 'ls' }).display, [{ label: 'Command', text: 'ls', mono: true }]);
  // The description is cut with … at 500; a control character in it is removed, a newline stays.
  const long = display('Bash', { command: 'ls', description: `${'d'.repeat(600)}` }).display[1].text;
  assert.deepEqual([long.length, long.endsWith('…')], [500, true]);
  assert.equal(display('Bash', { command: 'ls', description: 'a\x1bb\nc' }).display[1].text, 'ab\nc');
  // The invisible and direction marks are removed from a Description and a Query.
  assert.equal(display('Bash', { command: 'ls', description: 'safe\u202etxt.exe\u200b\u0085\ufeff' }).display[1].text, 'safetxt.exe');
  assert.equal(display('WebSearch', { query: 'a\u2066b\u2069' }).display[0].text, 'ab');
  // The command is shown whole or not at all.
  assert.equal(display('Bash', { command: 'x'.repeat(4000) }).display[0].text.length, 4000);
  assert.equal(display('Bash', { command: 'x'.repeat(4001) }), null);
  assert.equal(display('Bash', { command: 'echo \x1b[31mred' }), null);
  assert.equal(display('Bash', { command: 'two\nlines\tok' }).display[0].text, 'two\nlines\tok');
  assert.equal(display('Bash', {}), null);
  const write = display('Write', { file_path: '/work/a.txt', content: 'Secret file content' });
  assert.deepEqual(write.display, [{ label: 'File', text: '/work/a.txt', mono: true }, { label: 'Size', text: '19 characters', mono: false }]);
  assert.equal(JSON.stringify(write).includes('Secret'), false);
  const edit = display('Edit', { file_path: '/work/a.txt', old_string: 'Secret old', new_string: 'Secret newer', replace_all: true });
  assert.deepEqual(edit.display, [{ label: 'File', text: '/work/a.txt', mono: true }, { label: 'Change', text: '10 to 12 characters, all matches', mono: false }]);
  assert.equal(JSON.stringify(edit).includes('Secret'), false);
  assert.equal(display('Edit', { file_path: '/work/a.txt', old_string: 'a', new_string: '', replace_all: false }).display[1].text, '1 to 0 characters');
  assert.equal(display('Write', { file_path: `/work/${'p'.repeat(4000)}` }), null);
  assert.equal(display('Edit', { file_path: '/work/a\x07.txt' }), null);
  assert.deepEqual(display('NotebookEdit', { notebook_path: '/work/n.ipynb', new_source: 'Secret cell' }).display, [{ label: 'File', text: '/work/n.ipynb', mono: true }]);
  assert.equal(display('NotebookEdit', { notebook_path: '/work/\x1bn.ipynb' }), null);
  const fetched = display('WebFetch', { url: 'https://example.com/x', prompt: 'Secret prompt' });
  assert.deepEqual(fetched.display, [{ label: 'URL', text: 'https://example.com/x', mono: true }]);
  assert.equal(JSON.stringify(fetched).includes('Secret'), false);
  assert.equal(display('WebFetch', { url: `https://example.com/${'u'.repeat(2000)}` }), null);
  assert.equal(display('WebFetch', { url: 'https://example.com/\x00' }), null);
  assert.equal(display('WebSearch', { query: 'q'.repeat(700) }).display[0].text.length, 500);
  // MCP: the server name and the input key names, never the values.
  assert.deepEqual(display('mcp__spike__echo_test', { text: 'Secret value', count: 2 }, { mcp_server: { name: 'spike', source: 'x' } }).display,
    [{ label: 'Server', text: 'spike', mono: false }, { label: 'Input', text: 'text, count', mono: false }]);
  assert.equal(display('mcp__other__tool', {}).display[0].text, 'other');
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, 'Secret']));
  const keys = display('mcp__spike__echo_test', many).display[1].text.split(', ');
  assert.deepEqual([keys.length, keys[0], keys[19], keys[20]], [21, 'k0', 'k19', '…']);
  assert.deepEqual(display('SyntheticTool', { alpha: 'Secret', beta: 1 }).display, [{ label: 'Input', text: 'alpha, beta', mono: false }]);
  // A subagent call says so in the title.
  assert.equal(display('Bash', { command: 'ls' }, { agent_id: 'a-1', agent_type: 'general-purpose' }).title, 'Allow Bash for a subagent?');
  // Each built approval passes the engine check.
  const store = createClaudeQuestions();
  for (const built of [write, edit, fetched, display('Bash', { command: 'x'.repeat(4000), description: 'd'.repeat(600) })]) {
    assert.ok(store.open({ provider: 'claude', sessionKey: `s-${Math.random()}`, approval: built }).requestId);
  }
});

test('the store checks an approval and keeps one record per session of any kind', () => {
  const store = createClaudeQuestions();
  let n = 0;
  const ok = (value) => assert.ok(store.open({ provider: 'claude', sessionKey: `s-${n += 1}`, approval: value }).requestId);
  const bad = (value) => assert.throws(() => store.open({ provider: 'claude', sessionKey: 'bad', approval: value }), { statusCode: 400, message: 'Invalid approval.' });
  ok(approval()); ok(approval({ kind: 'plan', note: false, display: [] }));
  ok(approval({ title: 't'.repeat(300) })); bad(approval({ title: 't'.repeat(301) })); bad(approval({ title: '' })); bad(approval({ title: 'a\nb' }));
  bad(approval({ kind: 'other' })); bad(approval({ note: 'yes' })); bad({ ...approval(), extra: 1 }); bad('x');
  ok(approval({ display: Array.from({ length: 8 }, () => ({ label: 'L', text: 'x'.repeat(1000), mono: false })) }));
  bad(approval({ display: Array.from({ length: 9 }, () => ({ label: 'L', text: '', mono: false })) }));
  bad(approval({ display: Array.from({ length: 3 }, () => ({ label: 'L', text: 'x'.repeat(3000), mono: false })) }));
  ok(approval({ display: [{ label: 'l'.repeat(40), text: 'x'.repeat(4000), mono: true }] }));
  bad(approval({ display: [{ label: 'l'.repeat(41), text: '', mono: true }] })); bad(approval({ display: [{ label: '', text: '', mono: true }] }));
  bad(approval({ display: [{ label: 'L', text: 'x'.repeat(4001), mono: true }] })); bad(approval({ display: [{ label: 'L', text: 'a\x1b', mono: true }] }));
  ok(approval({ display: [{ label: 'L', text: 'a\tb\nc', mono: true }] })); bad(approval({ display: [{ label: 'L\t', text: '', mono: true }] }));
  bad(approval({ display: [{ label: 'L', text: '', mono: 1 }] })); bad(approval({ display: [{ label: 'L', text: '', mono: true, extra: 1 }] }));
  assert.throws(() => store.open({ provider: 'claude', sessionKey: 'x', questions: [], approval: approval() }), { statusCode: 400 });
  assert.throws(() => store.open({ provider: 'other', sessionKey: 'x', approval: approval() }), { statusCode: 400 });
  assert.throws(() => store.open({ provider: 'claude', sessionKey: '', approval: approval() }), { statusCode: 400 });
  // One record per (provider, session), any kind; the same key of another provider is another session.
  const fresh = createClaudeQuestions();
  const question = fresh.open({ provider: 'claude', sessionKey: 's', questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }).requestId;
  const asked = fresh.open({ provider: 'claude', sessionKey: 's', approval: approval() }).requestId;
  fresh.open({ provider: 'codex', sessionKey: 's', approval: approval() });
  assert.equal(fresh.forSession('claude', 's').requestId, asked);
  assert.equal(fresh.forSession('claude', 's').kind, 'approval');
  assert.deepEqual(fresh.forSession('claude', 's').approval, approval());
  assert.equal(fresh.openRecords().length, 2);
  assert.ok(fresh.wait(question, 0));
  // MAX_OPEN 32 for both kinds together.
  for (let index = 0; index < 15; index += 1) fresh.open({ provider: 'claude', sessionKey: `q${index}`, questions: [{ question: 'Q?', options: [{ label: 'A' }] }] });
  for (let index = 0; index < 15; index += 1) fresh.open({ provider: 'opencode', sessionKey: `a${index}`, approval: approval() });
  assert.equal(fresh.openRecords().length, 32);
  assert.throws(() => fresh.open({ provider: 'antigravity', sessionKey: 'z', approval: approval() }), { statusCode: 503 });
  // closeAll(kind) closes only that kind.
  fresh.closeAll('approval');
  assert.deepEqual([...new Set(fresh.openRecords().map((record) => record.kind))], ['question']);
  fresh.closeAll();
  assert.equal(fresh.openRecords().length, 0);
});

test('an approval answer gives the decision to its wait, and reconcile closes it by its own set', async () => {
  const now = clock();
  const store = createClaudeQuestions({ now });
  const allow = store.open({ provider: 'claude', sessionKey: 's1', approval: approval() }).requestId;
  const held = store.wait(allow, 20_000);
  assert.equal(store.answer(allow, { decision: 'allow' }), true);
  assert.deepEqual(await held, { state: 'answered', decision: 'allow' });
  const deny = store.open({ provider: 'claude', sessionKey: 's1', approval: approval() }).requestId;
  store.answer(deny, { decision: 'deny', note: 'Synthetic note' });
  assert.deepEqual(await store.wait(deny, 0), { state: 'answered', decision: 'deny', note: 'Synthetic note' });
  // Approvals: the raw set, the 30 s grace, seenPending. The question set does not close an approval, nor the other way round.
  const seen = store.open({ provider: 'claude', sessionKey: 'seen', approval: approval() }).requestId;
  const unseen = store.open({ provider: 'claude', sessionKey: 'unseen', approval: approval() }).requestId;
  const question = store.open({ provider: 'claude', sessionKey: 'question', questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }).requestId;
  const opencode = store.open({ provider: 'opencode', sessionKey: 'seen', approval: approval() }).requestId;
  store.reconcile('claude', 'approval', new Set(['seen']));
  store.reconcile('claude', 'question', new Set(['question']));
  assert.equal(store.forSession('claude', 'seen').seenPending, true);
  now.advance(10_000);
  store.reconcile('claude', 'approval', new Set(['question']));
  assert.deepEqual(await store.wait(seen, 0), { state: 'closed' });
  assert.equal(store.forSession('claude', 'unseen').requestId, unseen);
  assert.equal(store.forSession('claude', 'question').requestId, question);
  now.advance(20_001);
  store.reconcile('claude', 'approval', new Set());
  assert.equal(store.forSession('claude', 'unseen'), null);
  assert.equal(store.forSession('claude', 'question').requestId, question);
  // A provider with no reconcile set keeps its record (only the other rules close it).
  assert.equal(store.forSession('opencode', 'seen').requestId, opencode);
  // Sweep closes an approval with no wait for 60 s.
  now.advance(60_001);
  store.sweep();
  assert.equal(store.forSession('opencode', 'seen'), null);
});

test('the socket rule closes a record whose client left and keeps one that polls again in time', async () => {
  for (const kind of ['question', 'approval']) {
    const store = createClaudeQuestions({ socketGraceMs: 80 });
    const payload = kind === 'question' ? { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } : { approval: approval() };
    const { requestId } = store.open({ provider: 'claude', sessionKey: 's', ...payload });
    const first = new AbortController();
    const poll = store.wait(requestId, 20_000, first.signal);
    first.abort();
    assert.deepEqual(await poll, { state: 'open' });
    await delay(40);
    // A new poll inside the grace keeps it.
    const second = new AbortController();
    const kept = store.wait(requestId, 20_000, second.signal);
    await delay(120);
    assert.equal(store.forSession('claude', 's')?.requestId, requestId, kind);
    second.abort();
    await kept;
    await delay(150);
    assert.equal(store.forSession('claude', 's'), null, kind);
    assert.deepEqual(await store.wait(requestId, 0), { state: 'closed' });
  }
});

test('Codex expires in 28 s on answer, poll, and list reads without waiting for a sweep', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = clock();
  const store = createClaudeQuestions({ now });
  const open = (provider = 'codex') => store.open({ provider, sessionKey: 's', approval: approval() }).requestId;
  const decision = { decision: 'allow' };
  assert.equal(CODEX_FIRST_MS, 28_000);
  let id = open();
  assert.equal(store.forSession('codex', 's').deadlineAtMs, now() + CODEX_FIRST_MS);
  now.advance(27_900);
  assert.equal(store.answer(id, decision), true);
  assert.deepEqual(await store.wait(id, 0), { state: 'answered', ...decision });
  id = open();
  now.advance(28_100);
  assert.equal(store.answer(id, decision), false); // No list read or sweep before the late answer.
  assert.deepEqual(await store.wait(id, 0), { state: 'closed' });
  id = open();
  now.advance(28_100);
  assert.deepEqual(await store.wait(id, 0), { state: 'closed' });
  id = open();
  now.advance(28_100);
  assert.deepEqual(store.openRecords(), []);
  assert.deepEqual(await store.wait(id, 0), { state: 'closed' });
  id = open();
  now.advance(27_900);
  t.mock.timers.tick(27_900);
  const held = store.wait(id, 25_000);
  now.advance(101);
  t.mock.timers.tick(101);
  assert.deepEqual(await held, { state: 'closed' });
  const other = open('opencode');
  now.advance(28_100);
  assert.equal(store.forSession('opencode', 's').deadlineAtMs, undefined);
  assert.equal(store.answer(other, decision), true);
});

// A made-up engine: one Claude Code CLI session (`SESSION`) plus threads from other apps, and a registry record of this process
// when `registry` is given.
async function engine(t, { store = createClaudeQuestions(), extraRows = [], codexThreads = [], registry, onLoad, ...serverOptions } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-approvals-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const nowMs = Date.now();
  const project = path.join(home, '.claude', 'projects', 'synthetic-project');
  await mkdir(project, { recursive: true });
  const transcript = path.join(project, `${SESSION}.jsonl`);
  await writeFile(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date(nowMs - 60_000).toISOString(), sessionId: SESSION, cwd: '/work/synthetic',
    entrypoint: 'cli', message: { role: 'user', content: 'Synthetic task' } })}\n`);
  await utimes(transcript, nowMs / 1000, nowMs / 1000);
  const sessions = path.join(home, '.claude', 'sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const procStart = await processStart(process.pid);
  const writeRegistry = (fields) => writeFile(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId: SESSION,
    name: 'synthetic', cwd: '/work/synthetic', entrypoint: 'cli', kind: 'interactive', startedAt: nowMs - 120_000, ...fields }), { mode: 0o600 });
  if (registry) await writeRegistry(registry);
  if (codexThreads.length) await mkdir(path.join(home, '.codex'));
  const sources = new AppSourceRegistry({ homeDir: home, env: {}, platform: 'linux', discoverPersonal: false });
  const server = createSwitchboardServer({ sourceToken: TOKEN, pendingStatePath: false, palettePath: '', dashboardWatchPaths: [], sourceRegistry: sources,
    claudeQuestions: store, answerEnabled: () => true, approveEnabled: () => true, phonePaired: async () => true,
    loadDashboard: async (options) => {
      onLoad?.();
      const board = await loadSwitchboardDashboard({ ...options, loadCodex: async () => ({ threads: codexThreads }), loadOpenCode: async () => ({ threads: [] }) });
      board.threads.push(...extraRows.map((row) => ({ ...board.threads[0], ...row })));
      return board;
    },
    ...serverOptions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body, { headers = {}, raw } = {}) => fetch(base + route, { method: 'POST',
    headers: { origin: base, 'X-ASB-Source-Token': TOKEN, 'content-type': 'application/json', ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const rows = async (query = '?text=1') => JSON.parse(await (await fetch(`${base}/api/dashboard${query}`)).text()).threads;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { home, server, port, base, post, rows, store, writeRegistry, row: `cli:${SESSION}` };
}

const answerRoute = (row) => `/api/threads/${encodeURIComponent(row)}/answer`;
const codexTool = (sessionKey) => ({ provider: 'codex', sessionKey, approval: approval() });
const openWait = async (e, body) => (await e.post('/api/agent/wait', body)).json();

test('Codex requires approval and a phone seen in the last 60 s; other providers still require pairing', async (t) => {
  const now = clock();
  let approve = false;
  let devices = [{ lastSeenAtMs: now() }];
  const e = await engine(t, { now, approveEnabled: () => approve, phoneGateway: { devices: async () => devices },
    phonePaired: async () => devices.length > 0 });
  for (const [on, seenAgo, codex, other] of [[false, 0, false, false], [true, null, false, false],
    [true, 61_000, false, true], [true, 59_000, true, true], [true, 60_000, true, true]]) {
    approve = on;
    devices = seenAgo === null ? [] : [{ lastSeenAtMs: now() - seenAgo }];
    for (const provider of PROVIDERS) {
      const result = await openWait(e, { provider, sessionKey: SESSION, approval: approval() });
      if (provider === 'codex' ? codex : other) assert.match(result.requestId, /^[a-f0-9]{32}$/);
      else assert.deepEqual(result, { wait: false }, `${provider}, ${on}, ${seenAgo}`);
    }
    e.store.closeAll();
  }
});

test('the first load closes Codex waits with no local row and schedules at most one follow-up', async (t) => {
  let loads = 0;
  const e = await engine(t, { serviceMode: true, dashboardWatchDebounceMs: 100, onLoad: () => { loads += 1; },
    phoneSeenWithin: async () => true,
    codexThreads: [{ id: 'local-row', externalId: 'local', provider: 'codex', lifecycleRunning: false }],
    extraRows: [{ id: 'remote-row', externalId: 'elsewhere', provider: 'codex', remote: true, state: 'idle' }] });
  await e.server.dashboardForRequest();
  const before = loads;
  const local = await openWait(e, codexTool('local'));
  // The first command of a new session can come with no card if its thread is not yet in the reader.
  const missing = await openWait(e, codexTool('not-listed-yet'));
  const remote = await openWait(e, codexTool('elsewhere'));
  const poll = async ({ requestId }) => (await e.post(`/api/agent/wait/${requestId}`)).json();
  assert.deepEqual(await Promise.all([poll(missing), poll(remote)]), [{ state: 'closed' }, { state: 'closed' }]);
  assert.equal(loads, before + 1);
  assert.equal(e.store.forSession('codex', 'local')?.requestId, local.requestId);
  await delay(500);
  assert.ok(loads <= before + 2, `Expected at most two loads, got ${loads - before}.`);
});

test('the Codex phone hold gives the same row and input sound as a bridge approval wait', async (t) => {
  const now = clock(Date.now());
  const thread = { id: 'codex-row', externalId: 'codex-key', provider: 'codex-cli', source: 'cli', lifecycleRunning: true,
    updatedAtMs: now() - 10_000, latestLifecycleAtMs: now() - 10_000, agentStartedAtMs: now() - 10_000 };
  const bridgeThreads = [thread];
  const phoneSounds = [], bridgeSounds = [];
  const store = createClaudeQuestions({ now });
  const phone = await engine(t, { store, phoneSeenWithin: async () => true, codexThreads: [thread], playSound: (kind) => phoneSounds.push(kind) });
  const bridge = await engine(t, { codexThreads: bridgeThreads, playSound: (kind) => bridgeSounds.push(kind) });
  const row = async (e) => (await e.server.dashboardForRequest({ force: true })).threads.find(({ id }) => id === thread.id);
  const baseline = await row(phone);
  assert.equal(baseline.state, 'working');
  assert.deepEqual(await row(bridge), baseline);
  const { requestId } = await openWait(phone, codexTool(thread.externalId));
  bridgeThreads[0] = applyBridgeWaits(thread, { approvals: 1, approvalAtMs: now() });
  const overlaid = await row(phone);
  const expected = await row(bridge);
  assert.deepEqual(overlaid, expected);
  assert.deepEqual([overlaid.state, overlaid.pending, overlaid.actionRequired, overlaid.actionAttention], ['waiting', true, true, true]);
  assert.equal(overlaid[ACTION_AT], expected[ACTION_AT]);
  assert.equal(overlaid[ACTION_AT], now());
  assert.deepEqual(phoneSounds, [BIT_INPUT]);
  assert.deepEqual(phoneSounds, bridgeSounds);
  assert.equal((await phone.post(answerRoute(thread.id), { requestId, decision: 'allow' })).status, 200);
  bridgeThreads[0] = thread;
  const ended = await row(phone);
  assert.deepEqual(ended, await row(bridge));
  assert.deepEqual(ended, baseline);
  assert.equal(ended[ACTION_AT], baseline[ACTION_AT]);
  assert.deepEqual(phoneSounds, [BIT_INPUT]);
});

test('Codex alone sends one soft invalidation per open, answer, and close', async (t) => {
  const now = clock();
  const store = createClaudeQuestions({ now, socketGraceMs: 20 });
  const e = await engine(t, { store, phoneSeenWithin: async () => true,
    codexThreads: [{ id: 'codex-key', provider: 'codex', lifecycleRunning: false }] });
  let text = '';
  const events = http.get(`${e.base}/api/events`, (response) => response.on('data', (chunk) => { text += chunk; }));
  events.on('error', () => {});
  t.after(() => events.destroy());
  const waitFor = async (predicate) => {
    const until = Date.now() + 3000;
    while (!predicate() && Date.now() < until) await delay(5);
    assert.ok(predicate(), text);
  };
  const changes = () => (text.match(/"reason":"asb-agent-wait"/g) || []).length;
  const open = () => openWait(e, codexTool('codex-key'));
  await waitFor(() => text.includes('event: connected'));
  let expected = 1;
  let { requestId } = await open();
  await waitFor(() => changes() === expected);
  assert.equal((await e.post(answerRoute('codex-key'), { requestId, decision: 'allow' })).status, 200);
  expected += 1;
  await waitFor(() => changes() === expected);
  for (const close of [
    (id) => { store.close(id); store.close(id); },
    (id) => { now.advance(28_100); return store.wait(id, 0); },
    async (id) => {
      const left = new AbortController();
      const held = store.wait(id, 25_000, left.signal);
      left.abort();
      await held;
    },
  ]) {
    ({ requestId } = await open());
    expected += 1;
    await waitFor(() => changes() === expected);
    await close(requestId);
    expected += 1;
    await waitFor(() => changes() === expected);
    assert.deepEqual(await store.wait(requestId, 0), { state: 'closed' });
  }
  for (const provider of ['claude', 'opencode', 'antigravity']) {
    const other = await openWait(e, { ...codexTool('unlisted'), provider });
    assert.equal(other.wait, true);
    store.close(other.requestId);
  }
  const barrier = () => text.includes('"reason":"test-barrier"');
  e.server.invalidateDashboard('test-barrier', { hard: false, dirty: false });
  await waitFor(barrier);
  assert.equal(changes(), expected);
});

test('the contract: a record of each provider and kind gives the same row field and takes the same answer body', async (t) => {
  const others = { codex: 'codex', opencode: 'opencode', antigravity: 'antigravity' };
  const e = await engine(t, { phoneSeenWithin: async () => true, answerAgy: async () => true,
    extraRows: Object.entries(others).map(([provider]) => ({ id: `row-${provider}`, provider, externalId: `key-${provider}` })) });
  // The made-up rows of other apps have no CLI session IDs: a record is for the row's own ID in that app.
  const rowOf = { claude: e.row, ...Object.fromEntries(Object.keys(others).map((provider) => [provider, `row-${provider}`])) };
  const keyOf = { claude: SESSION, ...Object.fromEntries(Object.keys(others).map((provider) => [provider, `key-${provider}`])) };
  assert.deepEqual(Object.keys(rowOf).sort(), [...PROVIDERS].sort());
  for (const provider of PROVIDERS) {
    const opened = await (await e.post('/api/agent/wait', { provider, sessionKey: keyOf[provider], approval: approval() })).json();
    assert.equal(opened.wait, true, provider);
    const row = (await e.rows()).find((item) => item.id === rowOf[provider]);
    assert.deepEqual(row.approval, { requestId: opened.requestId, ...approval() }, provider);
    assert.equal('question' in row, false);
    const poll = e.post(`/api/agent/wait/${opened.requestId}`);
    const reply = await e.post(answerRoute(rowOf[provider]), { requestId: opened.requestId, decision: 'deny', note: 'Synthetic reason' });
    assert.deepEqual([reply.status, await reply.json()], [200, { answered: true }], provider);
    assert.deepEqual(await (await poll).json(), { state: 'answered', decision: 'deny', note: 'Synthetic reason' });
    const questions = [{ question: 'Synthetic?', options: [{ label: 'A' }], multiSelect: false }];
    const asked = await (await e.post('/api/agent/wait', { provider, sessionKey: keyOf[provider], question: { questions } })).json();
    const questionRow = (await e.rows()).find((item) => item.id === rowOf[provider]);
    assert.deepEqual(questionRow.question, { requestId: asked.requestId, questions }, provider);
    assert.equal('approval' in questionRow, false);
    assert.equal((await e.post(answerRoute(rowOf[provider]), { requestId: asked.requestId, answers: [{ selected: ['A'] }] })).status, 200, provider);
    assert.deepEqual(JSON.parse(JSON.stringify(await e.store.wait(asked.requestId, 0))), { state: 'answered', answers: { 'Synthetic?': 'A' } });
  }
  // The old claude-wait alias and its poll still work.
  const old = await (await e.post('/api/agent/claude-wait', { sessionId: SESSION, questions: [{ question: 'Old?', options: [{ label: 'A' }] }] })).json();
  assert.equal(old.wait, true);
  assert.deepEqual((await e.rows()).find((item) => item.id === e.row).question.requestId, old.requestId);
  const oldPoll = e.post(`/api/agent/claude-wait/${old.requestId}`);
  assert.equal((await e.post(answerRoute(e.row), { requestId: old.requestId, answers: [{ selected: ['A'] }] })).status, 200);
  assert.deepEqual(await (await oldPoll).json(), { state: 'answered', answers: { 'Old?': 'A' } });
});

test('the wait route checks the body and the switch of each kind', async (t) => {
  let answer = true, approve = false, paired = true;
  const e = await engine(t, { answerEnabled: () => answer, approveEnabled: () => approve, phonePaired: async () => paired });
  const ask = { provider: 'claude', sessionKey: SESSION, question: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } };
  const tool = { provider: 'claude', sessionKey: SESSION, approval: approval() };
  const json = async (body) => { const reply = await e.post('/api/agent/wait', body); return [reply.status, await reply.json()]; };
  assert.equal((await e.post('/api/agent/wait', tool, { headers: { 'X-ASB-Source-Token': '' } })).status, 403);
  assert.equal((await e.post('/api/agent/wait', tool, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.deepEqual(await json(tool), [200, { wait: false }]);
  assert.equal((await json(ask))[1].wait, true);
  answer = false; approve = true;
  assert.deepEqual(await json(ask), [200, { wait: false }]);
  assert.equal((await json(tool))[1].wait, true);
  paired = false;
  assert.deepEqual(await json(tool), [200, { wait: false }]);
  paired = true; answer = true;
  for (const body of [{ ...tool, extra: 1 }, { ...tool, provider: 'other' }, { ...tool, sessionKey: 'bad key' }, { ...tool, sessionKey: 'x'.repeat(129) },
    { provider: 'claude', sessionKey: SESSION }, { ...tool, question: ask.question }, { ...ask, question: { questions: ask.question.questions, extra: 1 } },
    { sessionId: SESSION, questions: ask.question.questions }, { ...tool, approval: { ...approval(), extra: 1 } }, { ...tool, approval: approval({ title: '' }) }]) {
    assert.equal((await e.post('/api/agent/wait', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await json({ ...tool, approval: approval({ title: '' }) }), [400, { error: 'Invalid approval.' }]);
  // The old alias takes only its own body.
  assert.equal((await e.post('/api/agent/claude-wait', tool)).status, 400);
  assert.equal((await e.post(`/api/agent/wait/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${e.base}/api/agent/wait`)).status, 405);
});

test('the answer route checks a decision against the open approval of its row', async (t) => {
  let approve = true;
  const e = await engine(t, { approveEnabled: () => approve });
  const open = async (value = approval()) => (await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: value })).json()).requestId;
  const post = (body) => e.post(answerRoute(e.row), body);
  const check = async (body, status, reply) => {
    const response = await post(body);
    assert.deepEqual([response.status, await response.json()], [status, reply], JSON.stringify(body));
  };
  let id = await open();
  for (const body of [{ requestId: id, decision: 'maybe' }, { requestId: id, decision: 'allow', note: 'x' }, { requestId: id, decision: 'deny', note: '' },
    { requestId: id, decision: 'deny', note: 'n'.repeat(501) }, { requestId: id, decision: 'deny', note: 'a\x1b' }, { requestId: id, decision: 'deny', note: 1 },
    { requestId: id, decision: 'allow', extra: 1 }, { requestId: id, decision: 'allow', answers: [] }, { decision: 'allow' }]) {
    await check(body, 400, { error: 'Invalid answer.' });
  }
  // An answers body for an approval, and a wrong ID: closed.
  await check({ requestId: id, answers: [{ selected: ['A'] }] }, 409, { error: 'This question is closed.' });
  await check({ requestId: '0'.repeat(32), decision: 'allow' }, 409, { error: 'This question is closed.' });
  approve = false;
  await check({ requestId: id, decision: 'allow' }, 409, { error: 'This question is closed.' });
  approve = true;
  await check({ requestId: id, decision: 'deny', note: 'n'.repeat(500) }, 200, { answered: true });
  assert.deepEqual(await e.store.wait(id, 0), { state: 'answered', decision: 'deny', note: 'n'.repeat(500) });
  await check({ requestId: id, decision: 'allow' }, 409, { error: 'This question is closed.' });
  // A note only when the record takes one.
  id = await open(approval({ note: false }));
  await check({ requestId: id, decision: 'deny', note: 'x' }, 400, { error: 'Invalid answer.' });
  await check({ requestId: id, decision: 'deny' }, 200, { answered: true });
  id = await open();
  await check({ requestId: id, decision: 'allow' }, 200, { answered: true });
  assert.deepEqual(await e.store.wait(id, 0), { state: 'answered', decision: 'allow' });
  id = await open();
  e.store.close(id);
  await check({ requestId: id, decision: 'allow' }, 409, { error: 'This question is closed.' });
  // A decision body for an open question: closed.
  const asked = (await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION,
    question: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } })).json()).requestId;
  await check({ requestId: asked, decision: 'allow' }, 409, { error: 'This question is closed.' });
});

test('only the text=1 list has the approval field', async (t) => {
  const e = await engine(t);
  const before = await (await fetch(`${e.base}/api/dashboard?text=1`)).text();
  const { requestId } = await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: approval() })).json();
  const row = (await e.rows()).find((item) => item.id === e.row);
  assert.deepEqual(row.approval, { requestId, kind: 'tool', title: 'Allow Bash?', display: approval().display, note: true });
  assert.equal('question' in row, false);
  const plain = (await e.rows('')).find((item) => item.id === e.row);
  assert.equal('approval' in plain || 'question' in plain, false);
  assert.equal((await (await fetch(`${e.base}/api/panel`)).text()).includes('echo synthetic'), false);
  e.store.close(requestId);
  assert.equal(await (await fetch(`${e.base}/api/dashboard?text=1`)).text().then((text) => text.includes('echo synthetic')), false);
  assert.ok(before);
});

test('an OpenCode approval stays open while its Bridge counts the request, and closes after the grace when it does not', async (t) => {
  const time = clock(Date.now());
  const store = createClaudeQuestions({ now: time });
  let counted = false;
  // A made-up OpenCode row: the Bridge wait gives it the approval mark (src/opencode-data.mjs).
  const opencodeRow = () => buildSwitchboardDashboard([{ id: 'ses_synthetic', externalId: 'ses_synthetic', provider: 'opencode', source: 'opencode-db',
    title: 'Synthetic', cwd: '/work/synthetic', createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 1_000,
    ...(counted ? { awaitingPermission: true, pendingToolAtMs: Date.now() - 1_000, [OPENCODE_APPROVAL_WAIT]: true } : {}) }], [], Date.now()).threads;
  const e = await engine(t, { store, loadDashboard: async (options) => {
    const board = await loadSwitchboardDashboard({ ...options, loadCodex: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) });
    board.threads.push(...opencodeRow());
    return board;
  } });
  const open = async () => (await (await e.post('/api/agent/wait', { provider: 'opencode', sessionKey: 'ses_synthetic', approval: approval() })).json()).requestId;
  const load = () => e.server.dashboardForRequest({ force: true });
  counted = true;
  const first = await open();
  await load();
  assert.equal(store.forSession('opencode', 'ses_synthetic').seenPending, true);
  time.advance(31_000);
  await load();
  assert.equal(store.forSession('opencode', 'ses_synthetic')?.requestId, first);
  // The Bridge no longer counts it (a PC answer, or the turn ended): the next load closes it.
  counted = false;
  await load();
  assert.deepEqual(await store.wait(first, 0), { state: 'closed' });
  // A record that the Bridge never counts stays for the grace, then closes; the Claude sets do not close it.
  const second = await open();
  time.advance(29_000);
  await load();
  assert.equal(store.forSession('opencode', 'ses_synthetic')?.requestId, second);
  time.advance(2_000);
  await load();
  assert.deepEqual(await store.wait(second, 0), { state: 'closed' });
});

test('the raw registry wait, not the row state with its grace, keeps a Claude approval open', async (t) => {
  // statusUpdatedAt is now: the row is still in its 10 s grace, but the raw wait counts.
  const e = await engine(t, { registry: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() } });
  const { requestId } = await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: approval() })).json();
  const dashboard = await e.server.dashboardForRequest({ force: true });
  assert.notEqual(dashboard.threads.find((row) => row.id === e.row).state, 'waiting');
  assert.equal(e.store.forSession('claude', SESSION).seenPending, true);
  assert.equal(JSON.stringify(dashboard).includes('permission'), false);
  // The PC answered: busy. The next load closes the record.
  await delay(20);
  await e.writeRegistry({ status: 'busy', statusUpdatedAt: Date.now(), extra: 'changed size' });
  await e.server.dashboardForRequest({ force: true });
  assert.deepEqual(await e.store.wait(requestId, 0), { state: 'closed' });
  // An open question (input needed) is not an approval wait.
  await e.writeRegistry({ status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: Date.now() });
  const other = createClaudeQuestions();
  const second = await engine(t, { store: other, registry: { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: Date.now() } });
  await second.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: approval() });
  await second.server.dashboardForRequest({ force: true });
  assert.equal(other.forSession('claude', SESSION).seenPending, false);
});

test('a held wait whose client is gone closes its record after the socket grace', async (t) => {
  const e = await engine(t, { store: createClaudeQuestions({ socketGraceMs: 100 }) });
  const { requestId } = await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: approval() })).json();
  const controller = new AbortController();
  const gone = fetch(`${e.base}/api/agent/wait/${requestId}`, { method: 'POST', signal: controller.signal,
    headers: { origin: e.base, 'X-ASB-Source-Token': TOKEN } }).catch(() => 'aborted');
  await delay(50);
  controller.abort();
  assert.equal(await gone, 'aborted');
  const deadline = Date.now() + 3_000;
  while (e.store.forSession('claude', SESSION) && Date.now() < deadline) await delay(20);
  assert.equal(e.store.forSession('claude', SESSION), null);
  assert.deepEqual(await (await e.post(`/api/agent/wait/${requestId}`)).json(), { state: 'closed' });
});

// The hook client against a made-up engine: `reply(route)` gives [status, body].
async function hook(t, reply, { runtime = true, port } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-approval-hook-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests = [];
  let server = null;
  if (reply) {
    server = http.createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push({ route: request.url, body: raw ? JSON.parse(raw) : undefined });
      const [status, value] = await reply(request.url);
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
  const env = { HOME: home, XDG_RUNTIME_DIR: runDir, XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'), PATH: '/usr/bin:/bin' };
  const run = async (stdin, args = [agentScript, 'claude-wait']) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
    const [code] = await once(child, 'close');
    return { code, stdout, stderr, ms: performance.now() - started };
  };
  return { home, run, requests };
}

const quiet = (result) => ({ code: result.code, stdout: result.stdout, stderr: result.stderr });
const none = { code: 0, stdout: '', stderr: '' };

test('the hook prints the exact allow and deny decisions of the phone', async (t) => {
  const answered = (value) => hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'e'.repeat(32) }]
    : [200, { state: 'answered', ...value }]);
  const bash = permission('Bash', { command: 'echo synthetic', description: 'Say it' });
  const allow = await answered({ decision: 'allow' });
  assert.deepEqual(quiet(await allow.run(bash)), { ...none, stdout: allowJson });
  assert.deepEqual(allow.requests.map((request) => request.route), ['/api/agent/wait', `/api/agent/wait/${'e'.repeat(32)}`]);
  assert.deepEqual(allow.requests[0].body, { provider: 'claude', sessionKey: SESSION, approval: claudeApproval(bash) });
  assert.equal(JSON.stringify(allow.requests[0].body).includes('prompt_id'), false);
  assert.deepEqual(quiet(await (await answered({ decision: 'deny' })).run(bash)), { ...none, stdout: denyJson('Denied from the phone.') });
  assert.deepEqual(quiet(await (await answered({ decision: 'deny', note: 'Use the test folder' })).run(bash)),
    { ...none, stdout: denyJson('Denied from the phone: Use the test folder') });
  // An answer that is not a decision prints nothing.
  assert.deepEqual(quiet(await (await answered({ decision: 'maybe' })).run(bash)), none);
  assert.deepEqual(quiet(await (await answered({ answers: { q: 'A' } })).run(bash)), none);
});

test('the hook registers nothing for a request the phone cannot show whole, for a plan it cannot show or a subagent plan, and for bad stdin', async (t) => {
  const h = await hook(t, () => [200, { wait: true, requestId: 'a'.repeat(32) }]);
  for (const stdin of [permission('Bash', { command: 'x'.repeat(4001) }), permission('Bash', { command: 'echo \x1b[0m' }),
    permission('Write', { file_path: `/${'p'.repeat(4000)}`, content: '' }), permission('Edit', { file_path: '/a\x1bb' }),
    permission('NotebookEdit', { notebook_path: '/n\x07' }), permission('WebFetch', { url: `https://example.com/${'u'.repeat(2000)}`, prompt: 'x' }),
    permission('WebFetch', { url: 'https://example.com/\x1b' }),
    // A direction or invisible mark could make the shown text differ from the real one.
    permission('Bash', { command: 'echo \u202egnp.exe' }), permission('Write', { file_path: '/work/\u202etxt.sh', content: '' }),
    permission('WebFetch', { url: 'https://example.com/\u202e' }), permission('Synthetic\u202eTool', {}),
    permission('Bash', { command: 'rm\u200b -rf x' }), permission('Bash', { command: 'echo \u0085' }), permission('Bash', { command: '\ufeffls' }),
    permission('ExitPlanMode', { plan: 'p'.repeat(16_001), planFilePath: '/p.md' }), permission('ExitPlanMode', { plan: 'Synthetic \u202eplan' }),
    permission('ExitPlanMode', { plan: 'Synthetic\u200bplan' }), permission('ExitPlanMode', { plan: '\ufeffSynthetic plan' }),
    permission('ExitPlanMode', { plan: 5 }), permission('ExitPlanMode', { plan: ['Synthetic plan'] }), permission('ExitPlanMode', { plan: '' }),
    permission('ExitPlanMode', { planFilePath: '/p.md' }), permission('ExitPlanMode', { plan: 'Synthetic plan' }, { agent_id: 'a-1', agent_type: 'Plan' }),
    permission('Bash', { command: 'ls' }, { hook_event_name: 'PreToolUse' }), permission('Bash', { command: 'ls' }, { session_id: '' }),
    permission('AskUserQuestion', 'x'), '{bad', '[]', 'x'.repeat(256 * 1024 + 1)]) {
    assert.deepEqual(quiet(await h.run(stdin)), none, typeof stdin === 'string' ? stdin.slice(0, 20) : stdin.tool_name);
  }
  assert.equal(h.requests.length, 0);
  // AskUserQuestion goes on as before, through the new route with its question body.
  const questions = [{ question: 'Pick?', options: [{ label: 'A' }] }];
  const asked = await hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'f'.repeat(32) }]
    : [200, { state: 'answered', answers: { 'Pick?': 'A' } }]);
  const result = await asked.run(permission('AskUserQuestion', { questions }));
  assert.equal(result.stdout, `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":${JSON.stringify(questions)},"answers":{"Pick?":"A"}}}}}\n`);
  assert.deepEqual(asked.requests[0].body, { provider: 'claude', sessionKey: SESSION, question: { questions } });
});

const planOutput = (decision) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`;
const [TAB, NL, ESC, RLO, ZWSP, BOM] = [0x09, 0x0a, 0x1b, 0x202e, 0x200b, 0xfeff].map((code) => String.fromCharCode(code));
const AFTER = { label: 'After approval', text: 'Bypass permissions mode, if this session allows it', mono: false };
const BYPASS = [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }];

test('the Claude display of a plan: the whole plan up to 16,000 characters, never the file path', () => {
  const plan = `Step 1${TAB}make c.txt${NL}Step 2${TAB}check it`;
  const built = claudeApproval(permission('ExitPlanMode', { plan, planFilePath: '/work/plans/secret-slug.md' }, { permission_mode: 'plan' }));
  assert.deepEqual(built, { kind: 'plan', title: 'Approve this plan?', note: true, display: [{ label: 'Plan', text: plan, mono: false }, AFTER] });
  assert.equal(JSON.stringify(built).includes('secret-slug'), false);
  const longest = claudeApproval(permission('ExitPlanMode', { plan: 'p'.repeat(16_000) }));
  assert.equal(longest.display[0].text.length, 16_000);
  for (const input of [{ plan: 'p'.repeat(16_001) }, { plan: `a${RLO}b` }, { plan: `a${ZWSP}b` }, { plan: `${BOM}a` }, { plan: `a${ESC}b` }, { plan: 1 }, { plan: '' }, {}]) {
    assert.equal(claudeApproval(permission('ExitPlanMode', input)), null, JSON.stringify(input).slice(0, 40));
  }
  // Any agent_id key, also null, keeps a plan on the PC.
  assert.equal(claudeApproval(permission('ExitPlanMode', { plan }, { agent_id: null })), null);
  assert.ok(createClaudeQuestions().open({ provider: 'claude', sessionKey: 's', approval: longest }).requestId);
});

test('the engine takes one Plan text of up to 16,000 characters in a plan record and keeps the tool limits', () => {
  const store = createClaudeQuestions();
  let n = 0;
  const ok = (value) => assert.ok(store.open({ provider: 'claude', sessionKey: `p-${n += 1}`, approval: value }).requestId);
  const bad = (value) => assert.throws(() => store.open({ provider: 'claude', sessionKey: 'bad', approval: value }), { statusCode: 400, message: 'Invalid approval.' });
  const plan = (text, more = [AFTER]) => approval({ kind: 'plan', title: 'Approve this plan?', display: [{ label: 'Plan', text, mono: false }, ...more] });
  const other = (length, label = 'L') => ({ label, text: 'x'.repeat(length), mono: false });
  ok(plan('p'.repeat(16_000))); bad(plan('p'.repeat(16_001)));
  // 16,500 together; the other texts keep 4,000 each, and only one Plan text is long.
  ok(plan('p'.repeat(16_000), [other(500)])); bad(plan('p'.repeat(16_000), [other(501)]));
  bad(plan('p'.repeat(12_000), [other(4_001)])); bad(plan('p'.repeat(8_000), [other(8_000, 'Plan')]));
  bad(plan(`p${ESC}`));
  // A non-object item is refused, not thrown.
  for (const item of [null, 'Plan', ['Plan'], 1]) {
    bad(approval({ kind: 'plan', display: [item] })); bad(plan('p', [item]));
  }
  // A tool record: 4,000 per text and 8,000 together, also for a text called Plan.
  ok(approval({ display: [other(4_000, 'Plan')] })); bad(approval({ display: [other(4_001, 'Plan')] }));
  ok(approval({ display: [other(4_000, 'A'), other(4_000, 'B')] })); bad(approval({ display: [other(4_000, 'A'), other(4_000, 'B'), other(1, 'C')] }));
});

test('the hook gives a plan allow with the unchanged input and bypass mode, and a plan deny that keeps planning', async (t) => {
  const answered = (value) => hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'e'.repeat(32) }]
    : [200, { state: 'answered', ...value }]);
  const input = { plan: `Synthetic plan${NL}with two lines`, planFilePath: '/work/plans/p.md', syntheticUnknown: { nested: [1, 'two', null] }, flag: false };
  const stdin = permission('ExitPlanMode', input, { permission_mode: 'plan' });
  const allow = await answered({ decision: 'allow' });
  const result = await allow.run(stdin);
  assert.deepEqual(quiet(result), { ...none, stdout: planOutput({ behavior: 'allow', updatedInput: input, updatedPermissions: BYPASS }) });
  assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision.updatedInput, input);
  // The exact registration body, with no file path.
  assert.deepEqual(allow.requests[0], { route: '/api/agent/wait', body: { provider: 'claude', sessionKey: SESSION,
    approval: { kind: 'plan', title: 'Approve this plan?', display: [{ label: 'Plan', text: input.plan, mono: false }, AFTER], note: true } } });
  assert.equal(JSON.stringify(allow.requests).includes('/work/plans'), false);
  assert.deepEqual(quiet(await (await answered({ decision: 'deny' })).run(stdin)), { ...none, stdout: planOutput({ behavior: 'deny', message: 'Keep planning.' }) });
  assert.deepEqual(quiet(await (await answered({ decision: 'deny', note: 'Synthetic note.' })).run(stdin)),
    { ...none, stdout: planOutput({ behavior: 'deny', message: 'Keep planning: Synthetic note.' }) });
  // Extra fields in the engine reply change nothing, for a plan and for a tool.
  const extra = { mode: 'acceptEdits', updatedPermissions: [{ type: 'setMode', mode: 'plan', destination: 'userSettings' }], updatedInput: { plan: 'other' }, interrupt: true };
  assert.equal((await (await answered({ decision: 'allow', ...extra })).run(stdin)).stdout, result.stdout);
  assert.equal((await (await answered({ decision: 'deny', ...extra })).run(stdin)).stdout, planOutput({ behavior: 'deny', message: 'Keep planning.' }));
  const bash = permission('Bash', { command: 'echo synthetic' });
  assert.deepEqual(quiet(await (await answered({ decision: 'allow', ...extra })).run(bash)), { ...none, stdout: allowJson });
  assert.deepEqual(quiet(await (await answered({ decision: 'deny', ...extra })).run(bash)), { ...none, stdout: denyJson('Denied from the phone.') });
  // A Bash approval after the change: the A1 output exactly.
  assert.deepEqual(quiet(await (await answered({ decision: 'allow' })).run(bash)), { ...none, stdout: allowJson });
  assert.deepEqual(quiet(await (await answered({ decision: 'deny', note: 'n' })).run(bash)), { ...none, stdout: denyJson('Denied from the phone: n') });
  assert.deepEqual(quiet(await (await answered({ decision: 'maybe' })).run(stdin)), none);
  // A plan of 16,000 characters registers.
  const longest = await answered({ decision: 'deny' });
  await longest.run(permission('ExitPlanMode', { plan: 'p'.repeat(16_000) }));
  assert.equal(longest.requests[0].body.approval.display[0].text.length, 16_000);
});

test('an approval answer loads fresh, so a record whose session no longer waits is closed; a question keeps the cached row', async (t) => {
  let loads = 0;
  const e = await engine(t, { registry: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() }, onLoad: () => { loads += 1; } });
  const plan = approval({ kind: 'plan', title: 'Approve this plan?', display: [{ label: 'Plan', text: 'Synthetic plan', mono: false }, AFTER] });
  for (const [kind, body] of [['tool', approval()], ['plan', plan]]) {
    await e.writeRegistry({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now(), extra: `waiting ${kind}` });
    const { requestId } = await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: body })).json();
    await e.server.dashboardForRequest({ force: true });
    assert.equal(e.store.forSession('claude', SESSION).seenPending, true, kind);
    const poll = e.post(`/api/agent/wait/${requestId}`);
    // The PC answered: the raw registry no longer waits, but the cached row still has the approval.
    await delay(20);
    await e.writeRegistry({ status: 'busy', statusUpdatedAt: Date.now(), extra: `busy, changed size ${kind}` });
    assert.equal((await e.rows()).find((row) => row.id === e.row).approval?.requestId, requestId, kind);
    const reply = await e.post(answerRoute(e.row), { requestId, decision: 'allow' });
    assert.deepEqual([reply.status, await reply.json()], [409, { error: 'This question is closed.' }], kind);
    assert.deepEqual(await (await poll).json(), { state: 'closed' }, kind);
  }
  // A record whose session still waits: the forced load keeps it, and the answer goes through.
  await e.writeRegistry({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now(), extra: 'waiting again' });
  const { requestId } = await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: plan })).json();
  await e.server.dashboardForRequest({ force: true });
  const poll = e.post(`/api/agent/wait/${requestId}`);
  await e.rows();
  loads = 0;
  assert.equal((await e.post(answerRoute(e.row), { requestId, decision: 'allow' })).status, 200);
  assert.equal(loads, 1);
  assert.deepEqual(await (await poll).json(), { state: 'answered', decision: 'allow' });
  // A question answer uses the cached row: no load.
  const asked = (await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION,
    question: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } })).json()).requestId;
  await e.rows();
  loads = 0;
  assert.equal((await e.post(answerRoute(e.row), { requestId: asked, answers: [{ selected: ['A'] }] })).status, 200);
  assert.equal(loads, 0);
});

test('with the engine down, wait false, or a closed request the hook prints nothing at once', async (t) => {
  const bash = permission('Bash', { command: 'ls' });
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const down = await hook(t, null, { port: closedPort });
  // The client adds under 300 ms to a bare Node start.
  const bare = await down.run('', ['-e', '0']);
  const result = await down.run(bash);
  assert.deepEqual(quiet(result), none);
  assert.ok(result.ms - bare.ms < 300, `${result.ms - bare.ms} ms`);
  assert.deepEqual(quiet(await (await hook(t, null, { runtime: false })).run(bash)), none);
  assert.deepEqual(quiet(await (await hook(t, () => [200, { wait: false }])).run(bash)), none);
  assert.deepEqual(quiet(await (await hook(t, () => [500, { error: 'x' }])).run(bash)), none);
  assert.deepEqual(quiet(await (await hook(t, (route) => route === '/api/agent/wait' ? [200, { wait: true, requestId: 'a'.repeat(32) }]
    : [200, { state: 'closed' }])).run(bash)), none);
});

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

// The engine wiring (scripts/asb-engine.mjs) with a real phone gateway on loopback.
async function phoneEngine(t) {
  const store = createClaudeQuestions();
  let gateway = null;
  const e = await engine(t, { store, answerEnabled: () => gateway?.answerReady() === true, approveEnabled: () => gateway?.approveReady() === true });
  gateway = createPhoneGateway({ localPort: e.port, asbVersion: '0.0.0', settingsPath: path.join(e.home, 'config', 'asb', 'phone.json'),
    tlsDir: path.join(e.home, 'config', 'asb', 'phone-tls'), listAddresses: () => [{ address: '127.0.0.1', interface: 'lo', kind: 'lan' }],
    onAnswer: (on) => { if (!on) store.closeAll('question'); }, onApprove: (on) => { if (!on) store.closeAll('approval'); } });
  t.after(() => gateway.stop());
  await gateway.start();
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const settings = { enabled: true, bindAddresses: ['127.0.0.1'], port: probe.address().port, sendText: true, answer: true, approve: true };
  await new Promise((resolve) => probe.close(resolve));
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
  const answer = (body) => phone(`/phone/v1/threads/${encodeURIComponent(e.row)}/answer`, body, token);
  // The hook client of this engine for one stdin; it gives its stdout when it ends.
  const runtime = path.join(e.home, 'runtime');
  await mkdir(path.join(runtime, 'asb'), { recursive: true, mode: 0o700 });
  await chmod(path.join(runtime, 'asb'), 0o700);
  await writeFile(path.join(runtime, 'asb', 'service.json'), JSON.stringify({ schema: 1, pid: process.pid, port: e.port, sourceToken: TOKEN }), { mode: 0o600 });
  const client = (stdin) => {
    const child = spawn(process.execPath, [agentScript, 'claude-wait'], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: e.home, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: path.join(e.home, 'state'), XDG_CONFIG_HOME: path.join(e.home, 'config'),
        XDG_CACHE_HOME: path.join(e.home, 'cache'), PATH: '/usr/bin:/bin' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify(stdin));
    return once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  };
  const untilOpen = async () => {
    const deadline = Date.now() + 5_000;
    while (!store.forSession('claude', SESSION) && Date.now() < deadline) await delay(20);
    return store.forSession('claude', SESSION);
  };
  return { e, store, gateway, save, answer, client, untilOpen };
}

gatewayTest('each switch combination gates the decision and the answer bodies through the phone', async (t) => {
  const { e, store, save, answer } = await phoneEngine(t);
  const questions = [{ question: 'Q?', options: [{ label: 'A' }] }];
  const openApproval = async () => (await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: approval() })).json());
  const openQuestion = async () => (await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, question: { questions } })).json());
  for (const [change, decision, answers] of [[{ sendText: true, answer: true, approve: true }, true, true],
    [{ sendText: true, answer: true, approve: false }, false, true], [{ sendText: false, answer: undefined, approve: undefined }, false, false]]) {
    await save(change);
    const tool = await openApproval();
    assert.equal(tool.wait, decision, JSON.stringify(change));
    const reply = await answer({ requestId: tool.requestId || 'a'.repeat(32), decision: 'allow' });
    assert.equal(reply.status, decision ? 200 : 404, JSON.stringify(change));
    if (!decision) assert.deepEqual(reply.json, { error: 'Route is not available.' });
    const asked = await openQuestion();
    assert.equal(asked.wait, answers, JSON.stringify(change));
    const replied = await answer({ requestId: asked.requestId || 'a'.repeat(32), answers: [{ selected: ['A'] }] });
    assert.equal(replied.status, answers ? 200 : 404, JSON.stringify(change));
    store.closeAll();
  }
  // The gateway checks the decision shape; the engine checks the note against the record.
  await save({ sendText: true, answer: true, approve: true });
  const { requestId } = await openApproval();
  for (const body of [{ requestId, decision: 'yes' }, { requestId, decision: 'allow', note: 'x' }, { requestId, decision: 'deny', note: '' },
    { requestId, decision: 'deny', note: 'n'.repeat(501) }, { requestId, decision: 'deny', note: 'a\x1b' }, { requestId, decision: 'deny', extra: 1 },
    { requestId: 'A'.repeat(32), decision: 'deny' }]) {
    assert.deepEqual([(await answer(body)).status], [400], JSON.stringify(body));
  }
  assert.deepEqual([(await answer({ requestId, decision: 'deny', note: 'Synthetic\tnote' })).status], [200]);
  assert.deepEqual(await store.wait(requestId, 0), { state: 'answered', decision: 'deny', note: 'Synthetic\tnote' });
});

gatewayTest('the approve switch off closes the open approvals only; the hook then prints nothing', async (t) => {
  const { e, store, save, client, untilOpen } = await phoneEngine(t);
  // An omitted switch keeps its saved value, and a switch that it needs turns it off.
  for (const change of [{ approve: false }, { answer: false, approve: undefined }, { sendText: false, answer: undefined, approve: undefined }, { enabled: false }]) {
    await save({ enabled: true, sendText: true, answer: true, approve: true });
    const question = store.open({ provider: 'claude', sessionKey: 'other-session',
      questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }).requestId;
    const done = client(permission('Bash', { command: 'echo synthetic' }));
    assert.ok(await untilOpen(), JSON.stringify(change));
    await save(change);
    assert.equal(store.forSession('claude', SESSION), null, JSON.stringify(change));
    assert.deepEqual(await done, { code: 0, stdout: '', stderr: '' }, JSON.stringify(change));
    // The approve switch alone keeps the questions open.
    assert.equal(store.forSession('claude', 'other-session')?.requestId === question, change.approve === false, JSON.stringify(change));
    store.closeAll();
    assert.deepEqual(await (await e.post('/api/agent/wait', { provider: 'claude', sessionKey: SESSION, approval: approval() })).json(), { wait: false });
  }
});

gatewayTest('no approval text stays at rest or in a log after a phone deny with a note and an allow', async (t) => {
  const marker = 'ZQX7MARKER';
  const logged = [];
  const saved = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[name] = console[name];
    console[name] = (...args) => { logged.push(args.map(String).join(' ')); saved[name](...args); };
  }
  t.after(() => Object.assign(console, saved));
  const { e, answer, client, untilOpen } = await phoneEngine(t);
  let done = client(permission('Bash', { command: `echo ${marker}`, description: `Say ${marker}` }));
  let record = await untilOpen();
  assert.ok(record.approval.display.every((item) => item.text.includes(marker)));
  const row = (await e.rows()).find((item) => item.id === e.row);
  assert.ok(JSON.stringify(row.approval).includes(marker));
  assert.equal((await answer({ requestId: record.requestId, decision: 'deny', note: `Not ${marker}` })).status, 200);
  assert.deepEqual(await done, { code: 0, stdout: denyJson(`Denied from the phone: Not ${marker}`), stderr: '' });
  done = client(permission(`Synthetic${marker}Tool`, { field: marker }));
  record = await untilOpen();
  assert.equal(record.approval.title, `Allow Synthetic${marker}Tool?`);
  assert.equal((await answer({ requestId: record.requestId, decision: 'allow' })).status, 200);
  assert.deepEqual(await done, { code: 0, stdout: allowJson, stderr: '' });
  for (const file of await filesUnder(e.home)) assert.equal((await readFile(file, 'latin1')).includes(marker), false, file);
  for (const directory of [process.env.XDG_STATE_HOME, process.env.XDG_CACHE_HOME].filter(Boolean)) {
    for (const file of await filesUnder(directory)) assert.equal((await readFile(file, 'latin1')).includes(marker), false, file);
  }
  assert.equal(logged.some((line) => line.includes(marker)), false);
});
