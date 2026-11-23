import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instanceRuntimePath, requestInstance } from '../scripts/asb-instance.mjs';
import { createAsbServer } from '../src/asb-server.mjs';
import { createClaudeQuestions } from '../src/claude-questions.mjs';

const client = new URL('../scripts/asb-agent.mjs', import.meta.url);
const token = 'a'.repeat(64);
const requestId = 'b'.repeat(32);
const input = { hook_event_name: 'PermissionRequest', session_id: 'codex-test-thread', tool_name: 'Bash', cwd: '/made-up/folder name',
  tool_input: { command: 'printf "two words\\n"\ntrue', marker: 'not sent' } };
const body = { provider: 'codex', sessionKey: input.session_id, approval: { kind: 'tool', title: 'Allow a shell command?', note: true,
  display: [{ label: 'Command', text: input.tool_input.command, mono: true }, { label: 'Folder', text: input.cwd, mono: true }] } };
const EMPTY = { code: 0, stdout: '', stderr: '' };

async function fixture(t, server = null) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-codex-wait-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'run'),
    USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  const runtime = { schema: 1, pid: process.pid, sourceToken: token };
  if (server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    runtime.port = server.address().port;
    const file = instanceRuntimePath(env);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(runtime), { mode: 0o600 });
  }
  const run = (hook = input, codexWaitMs, provider = 'codex') => new Promise((resolve, reject) => {
    const args = codexWaitMs === undefined ? [fileURLToPath(client), `${provider}-wait`] : ['--input-type=module', '-e',
      `import { claudeWait } from ${JSON.stringify(client.href)}; await claudeWait('codex', { codexWaitMs: ${codexWaitMs} });`];
    const child = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env, timeout: 7000 }, (error, stdout, stderr) => {
      if (error && !Number.isInteger(error.code)) reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(typeof hook === 'string' ? hook : JSON.stringify(hook));
  });
  return { runtime, run };
}

async function stub(t, answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      requests.push([req.method, req.url, req.headers['x-asb-source-token'], text ? JSON.parse(text) : null]);
      const json = (value, status = 200) => { res.writeHead(status); res.end(JSON.stringify(value)); };
      answer(req.url, json, requests.length, res);
    });
  });
  return { ...await fixture(t, server), requests };
}

for (const [decision, note, expected] of [
  ['allow', undefined, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'],
  ['deny', undefined, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the phone."}}}\n'],
  ['deny', 'Use a different folder.', '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the phone: Use a different folder."}}}\n'],
]) {
  test(`Codex ${decision} ${note ? 'with' : 'without'} a note uses exact output bytes and only the approval fields`, async (t) => {
    const { run, requests } = await stub(t, (_url, json, count) => json(count === 1 ? { wait: true, requestId } : { state: 'answered', decision, note }));
    assert.deepEqual(await run(), { ...EMPTY, stdout: expected });
    assert.deepEqual(requests, [['POST', '/api/agent/wait', token, body], ['POST', `/api/agent/wait/${requestId}`, token, null]]);
  });
}

test('wait false, closed, rejected, and invalid replies end the hook without output', async (t) => {
  for (const [opened, polled, count] of [[{ wait: false }, null, 1], [{ wait: true, requestId }, { state: 'closed' }, 2],
    [{ wait: true, requestId: 'bad' }, null, 1], [{ wait: true, requestId }, { state: 'answered', decision: 'unknown' }, 2]]) {
    const { run, requests } = await stub(t, (_url, json, count) => json(count === 1 ? opened : polled));
    assert.deepEqual(await run(), EMPTY);
    assert.equal(requests.length, count);
  }
  const { run, requests } = await stub(t, (_url, json) => json({ error: 'Invalid approval.' }, 400));
  assert.deepEqual(await run(), EMPTY);
  assert.equal(requests.length, 1);
});

test('no engine ends the hook without output', async (t) => {
  const { run } = await fixture(t);
  assert.deepEqual(await run(), EMPTY);
});

test('invalid input, other tools, hidden characters, and excess stdin send no request', async (t) => {
  const { run, requests } = await stub(t, (_url, json) => json({ wait: false }));
  for (const hook of [null, '{', { ...input, hook_event_name: 'PreToolUse' }, { ...input, session_id: '' },
    { ...input, session_id: 42 }, { ...input, tool_name: 'Read' }, { ...input, tool_name: 'AskUserQuestion' }, { ...input, cwd: false },
    { ...input, cwd: '/a\x1b/b' }, { ...input, tool_input: { command: 'safe\u202eunsafe' } }, { ...input, pad: ' '.repeat(256 * 1024) }]) {
    assert.deepEqual(await run(hook), EMPTY);
  }
  assert.deepEqual(requests, []);
});

test('a command over 4,000 characters is refused by the client and by the engine store', async (t) => {
  const { run, requests } = await stub(t, (_url, json) => json({ wait: false }));
  const command = 'x'.repeat(4001);
  assert.deepEqual(await run({ ...input, tool_input: { command } }), EMPTY);
  assert.deepEqual(requests, []);
  const store = createClaudeQuestions();
  const engine = createAsbServer({ sourceToken: token, pendingStatePath: false, claudeQuestions: store, approveEnabled: () => true,
    phoneSeenWithin: async () => true, loadDashboard: async () => ({ providers: [], threads: [] }) });
  const { runtime } = await fixture(t, engine);
  const display = [{ ...body.approval.display[0], text: command }, body.approval.display[1]];
  const result = await requestInstance(runtime, '/api/agent/wait', { method: 'POST', body: { ...body, approval: { ...body.approval, display } } });
  assert.deepEqual(result, { statusCode: 400, body: { error: 'Invalid approval.' } });
  assert.equal(store.forSession('codex', input.session_id), null);
});

test('one total deadline cuts a second held poll short, with no decision output', async (t) => {
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const { run, requests } = await stub(t, (_url, json, count, response) => {
    if (count === 1) json({ wait: true, requestId });
    else if (count === 2) setTimeout(() => json({ state: 'open' }), 160);
    else {
      const timer = setTimeout(() => json({ state: 'answered', decision: 'allow' }), 250);
      response.on('close', () => { clearTimeout(timer); disconnected(); });
    }
  });
  assert.deepEqual(await run(input, 350), EMPTY);
  assert.deepEqual(requests.map(([, route]) => route), ['/api/agent/wait', `/api/agent/wait/${requestId}`, `/api/agent/wait/${requestId}`]);
  await closed;
});

test('the Claude question hook opens and polls the same engine route as the Codex client', async (t) => {
  const questions = [{ question: 'Which item?', header: 'Item', options: [{ label: 'One', description: 'First item' }], multiSelect: false }];
  const answers = { 'Which item?': 'One' };
  const { run, requests } = await stub(t, (_url, json, count) => json(count === 1 ? { wait: true, requestId } : { state: 'answered', answers }));
  assert.deepEqual(await run({ ...input, tool_name: 'AskUserQuestion', tool_input: { questions } }, undefined, 'claude'),
    { code: 0, stderr: '', stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { questions, answers } } } })}\n` });
  assert.deepEqual(requests, [['POST', '/api/agent/wait', token, { provider: 'claude', sessionKey: input.session_id, question: { questions } }],
    ['POST', `/api/agent/wait/${requestId}`, token, null]]);
});
