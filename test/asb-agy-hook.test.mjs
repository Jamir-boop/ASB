import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { agyHook, agyNextState, agyProcess, agyTitle } from '../scripts/asb-agy-hook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = '9d482c79-a221-41ba-96c9-1c571ac0565b';
const MARKER = 'made-up-marker-7f3a';
const stat22 = (pid, comm, parent, ticks) => `${pid} (${comm}) S ${parent} ${Array(17).fill('0').join(' ')} ${ticks} 0 0\n`;
// A made-up process tree: hook -> sh 500 -> agy 400.
const agyTree = (comm = 'agy') => async (pid, name) => {
  const files = { '500/stat': stat22(500, 'sh', 400, '111'), '400/comm': `${comm}\n`, '400/stat': stat22(400, comm, 300, '4377321') };
  if (!(`${pid}/${name}` in files)) throw Object.assign(new Error('no such process'), { code: 'ENOENT' });
  return files[`${pid}/${name}`];
};

async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-hook-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(homeDir, 'state'), KITTY_WINDOW_ID: '2', KITTY_PID: '3280986',
    KITTY_LISTEN_ON: `unix:${path.join(homeDir, 'kitty.sock')}` };
  const dir = path.join(homeDir, 'state', 'asb', 'agy');
  const file = path.join(dir, `${ID}.json`);
  const run = async (event, fields = {}, options = {}) => {
    const output = [];
    const hook = { hookEventName: event, conversationId: ID, workspacePaths: [path.join(homeDir, 'ws')], cwd: path.join(homeDir, 'ws'),
      transcriptPath: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', ID, 'transcript.jsonl'),
      artifactDirectoryPath: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', ID), modelName: 'made-up-model',
      lastUserInput: `${MARKER} prompt`, callerContext: `${MARKER} context`, stepIdx: 1, invocationNum: 1, initialNumSteps: 0, ...fields };
    const code = await agyHook([event], { stdin: Readable.from([Buffer.from(options.stdin ?? JSON.stringify(hook))]), write: (text) => output.push(text),
      env: options.env || env, homeDir, nowMs: options.nowMs ?? 1_000, parentPid: 500, read: options.read || agyTree(), writeRecord: options.writeRecord });
    return { code, output: output.join('') };
  };
  const record = async () => JSON.parse(await readFile(file, 'utf8'));
  return { homeDir, env, dir, file, run, record };
}

const ask = (name, extra = {}) => ({ toolCall: { id: 'call-1', name, args: { questions: [{ question: `${MARKER} question` }], CommandLine: `${MARKER} cmd` } }, ...extra });

test('each event gives its state, keeps createdAtMs, and replies with the neutral reply', async (t) => {
  const { run, record, homeDir } = await fixture(t);
  const steps = [
    ['SessionStart', {}, '{}', 'idle'],
    ['PreInvocation', {}, '{}', 'working'],
    ['PreToolUse', ask('ask_question'), '{"decision":"ask"}', 'question'],
    ['PostToolUse', ask('ask_question', { error: '' }), '{}', 'working'],
    ['Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, executionNum: 1, continuationActive: false }, '{}', 'done'],
  ];
  let nowMs = 1_000;
  for (const [event, fields, reply, state] of steps) {
    nowMs += 1_000;
    const result = await run(event, fields, { nowMs });
    assert.deepEqual(result, { code: 0, output: `${reply}\n` });
    const saved = await record();
    assert.deepEqual([saved.state, saved.stateAtMs, saved.createdAtMs], [state, nowMs, 2_000]);
  }
  assert.deepEqual(await record(), { conversationId: ID, workspace: path.join(homeDir, 'ws'), state: 'done', stateAtMs: 6_000, event: 'Stop', createdAtMs: 2_000,
    agyPid: 400, agyStartTicks: '4377321', kittyWindowId: '2', kittyPid: '3280986', kittyListenOn: `unix:${path.join(homeDir, 'kitty.sock')}`,
    transcriptMtimePath: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', ID, 'transcript.jsonl') });
});

test('a subagent record keeps its parent ID across events and saves only a valid name', async (t) => {
  const { run, record } = await fixture(t);
  const parentConversationId = '42B74C00-A221-41BA-96C9-1C571AC0565B';
  for (const parent of [undefined, ID.toUpperCase(), '../bad-id']) {
    await run('SessionStart', { parentConversationId: parent, agentName: 'research' });
    const saved = await record();
    assert.equal('parentConversationId' in saved, false);
    assert.equal('agentName' in saved, false);
  }
  await run('SessionStart', { parentConversationId, agentName: ' research ' });
  let saved = await record();
  assert.deepEqual([saved.parentConversationId, saved.agentName], [parentConversationId.toLowerCase(), 'research']);
  await run('PreInvocation');
  saved = await record();
  assert.equal(saved.parentConversationId, parentConversationId.toLowerCase());
  for (const agentName of ['a'.repeat(81), 'a\x00b', 'a\x9fb', `a${String.fromCodePoint(0x202e)}b`]) {
    await run('PreInvocation', { parentConversationId, agentName });
    saved = await record();
    assert.equal(saved.parentConversationId, parentConversationId.toLowerCase());
    assert.equal('agentName' in saved, false);
  }
});

test('a new conversation in the agy process of one working root conversation is its subagent', async (t) => {
  const { run, record, dir } = await fixture(t);
  const PARENT = '42b74c00-a221-41ba-96c9-1c571ac0565b';
  const OTHER = '5e1f0a11-a221-41ba-96c9-1c571ac0565b';
  const saved = async (id) => JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
  const otherTree = async (pid, name) => name === 'stat' && pid === 400 ? stat22(400, 'agy', 300, '999') : agyTree()(pid, name);
  // Parent done: no parent. Then working in another agy process: no parent.
  await run('Stop', { conversationId: PARENT, fullyIdle: true });
  await run('SessionStart');
  assert.equal('parentConversationId' in await record(), false);
  await rm(path.join(dir, `${ID}.json`));
  await run('PreInvocation', { conversationId: PARENT }, { read: otherTree });
  await run('SessionStart');
  assert.equal('parentConversationId' in await record(), false);
  // Working root in the same process: the new conversation is its subagent, and keeps it after the parent stops.
  await rm(path.join(dir, `${ID}.json`));
  await run('PreInvocation', { conversationId: PARENT });
  await run('SessionStart');
  assert.equal((await record()).parentConversationId, PARENT);
  await run('Stop', { conversationId: PARENT, fullyIdle: true });
  await run('PreInvocation');
  assert.equal((await record()).parentConversationId, PARENT);
  // A working subagent is not a parent: a third conversation goes under the root only.
  await run('PreInvocation', { conversationId: PARENT });
  await run('SessionStart', { conversationId: OTHER });
  assert.equal((await saved(OTHER)).parentConversationId, PARENT);
  // An old record without a parent stays a root; two working roots give no parent.
  await rm(path.join(dir, `${OTHER}.json`));
  await run('Stop', { conversationId: PARENT, fullyIdle: true });
  await run('PreInvocation', { conversationId: OTHER });
  assert.equal('parentConversationId' in await saved(OTHER), false);
  await run('PreInvocation', { conversationId: PARENT });
  await rm(path.join(dir, `${ID}.json`));
  await run('SessionStart');
  assert.equal('parentConversationId' in await record(), false);
});

test('Stop with fullyIdle false keeps working with background, an error gives failed with no text, and other tools change nothing', async (t) => {
  const { run, record } = await fixture(t);
  await run('PreInvocation');
  await run('Stop', { error: '', fullyIdle: false }, { nowMs: 2_000 });
  assert.deepEqual([(await record()).state, (await record()).background], ['working', true]);
  await run('PreInvocation', {}, { nowMs: 3_000 });
  assert.equal((await record()).background, undefined);
  assert.deepEqual(await run('PreToolUse', ask('run_command'), { nowMs: 4_000 }), { code: 0, output: '{"decision":"ask"}\n' });
  assert.deepEqual(await run('PostToolUse', ask('run_command'), { nowMs: 5_000 }), { code: 0, output: '{}\n' });
  assert.deepEqual(await run('PostInvocation', {}, { nowMs: 5_500 }), { code: 0, output: '{}\n' });
  assert.equal((await record()).stateAtMs, 3_000);
  await run('Stop', { error: `${MARKER} error`, fullyIdle: true }, { nowMs: 6_000 });
  assert.equal((await record()).state, 'failed');
});

test('no prompt, answer, tool input, error, model, or artifact text is in any record file', async (t) => {
  const { run, dir } = await fixture(t);
  await run('SessionStart');
  await run('PreToolUse', ask('ask_question'));
  await run('PostToolUse', ask('ask_question', { error: `${MARKER} error` }));
  await run('Stop', { error: `${MARKER} error`, fullyIdle: true });
  for (const name of await readdir(dir)) {
    const text = await readFile(path.join(dir, name), 'utf8');
    for (const word of [MARKER, 'made-up-model', 'lastUserInput', 'callerContext', 'artifact', 'toolCall', 'error']) assert.equal(text.includes(word), false, word);
  }
});

test('the record folder is made 0700 and the file 0600, through a temp file', async (t) => {
  const { run, dir, file } = await fixture(t);
  await run('SessionStart');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), [`${ID}.json`]);
});

test('bad input, a non-UUID ID, a bad workspace, an unwritable state folder, and a throw all still give the reply and exit 0', async (t) => {
  const { run, dir, homeDir, env } = await fixture(t);
  for (const [event, options, fields] of [
    ['PreToolUse', { stdin: 'not json' }], ['Stop', { stdin: '[]' }], ['PreInvocation', { stdin: 'x'.repeat(300 * 1024) }],
    ['PreInvocation', {}, { conversationId: '../escape' }], ['PreInvocation', {}, { hookEventName: 'Stop' }],
    ['PreInvocation', {}, { workspacePaths: ['relative'], cwd: 'also-relative' }],
  ]) assert.deepEqual(await run(event, fields, options), { code: 0, output: `${event === 'PreToolUse' ? '{"decision":"ask"}' : '{}'}\n` });
  await assert.rejects(stat(dir), { code: 'ENOENT' });
  await writeFile(path.join(homeDir, 'flat'), 'x');
  assert.deepEqual(await run('PreToolUse', ask('ask_question'), { env: { ...env, XDG_STATE_HOME: path.join(homeDir, 'flat') } }),
    { code: 0, output: '{"decision":"ask"}\n' });
  assert.deepEqual(await run('PreToolUse', ask('ask_question'), { writeRecord: () => { throw new Error('forced'); } }),
    { code: 0, output: '{"decision":"ask"}\n' });
});

test('a grandparent that is not agy gives no PID, and bad kitty values are left out', async (t) => {
  const { run, record, env } = await fixture(t);
  await run('SessionStart', {}, { read: agyTree('bash'), env: { ...env, KITTY_WINDOW_ID: '2;rm', KITTY_PID: '-1', KITTY_LISTEN_ON: 'tcp:localhost:1' } });
  const saved = await record();
  for (const key of ['agyPid', 'agyStartTicks', 'kittyWindowId', 'kittyPid', 'kittyListenOn']) assert.equal(key in saved, false, key);
  await run('SessionStart', { transcriptPath: '/etc/passwd', workspacePaths: [] }, { env: { ...env, KITTY_LISTEN_ON: 'unix:@kitty-1' } });
  const next = await record();
  assert.deepEqual([next.kittyListenOn, 'transcriptMtimePath' in next, next.workspace], ['unix:@kitty-1', false, path.join(path.dirname(env.XDG_STATE_HOME), 'ws')]);
  assert.equal(await agyProcess(999_999_999), null);
});

test('asb agent agy-hook prints the neutral reply and exits 0 as a real process', async (t) => {
  const { homeDir, env } = await fixture(t);
  const call = (event, input) => new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ROOT, 'scripts', 'asb-agent.mjs'), 'agy-hook', event],
      { env: { PATH: process.env.PATH, HOME: homeDir, XDG_STATE_HOME: env.XDG_STATE_HOME } }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
    child.stdin.end(input);
  });
  assert.deepEqual(await call('PreToolUse', 'not json'), { code: 0, stdout: '{"decision":"ask"}\n' });
  const hook = { hookEventName: 'PreInvocation', conversationId: ID, workspacePaths: [path.join(homeDir, 'ws')], lastUserInput: MARKER };
  assert.deepEqual(await call('PreInvocation', JSON.stringify(hook)), { code: 0, stdout: '{}\n' });
  const saved = JSON.parse(await readFile(path.join(env.XDG_STATE_HOME, 'asb', 'agy', `${ID}.json`), 'utf8'));
  assert.deepEqual([saved.state, 'agyPid' in saved], ['working', false]);
});

// A made-up chain from the parent up: [pid, comm, parent PID]; a PID that is not in it gives a read error.
const chain = (rows) => async (pid, name) => {
  const row = rows.find(([id]) => id === pid);
  if (!row) throw Object.assign(new Error('no such process'), { code: 'ENOENT' });
  return name === 'comm' ? `${row[1]}\n` : stat22(row[0], row[1], row[2], `${row[0]}000`);
};

test('the client walk finds the first agy ancestor of the dash, bash, and old trees, and stops at 8 levels, PID 1, or a read error', async () => {
  const agy = { agyPid: 400, agyStartTicks: '400000' };
  // dash: agy -> sh -> sh (subshell) -> timeout -> sh (scripts/asb) -> node.
  assert.deepEqual(await agyProcess(504, chain([[504, 'sh', 503], [503, 'timeout', 502], [502, 'sh', 501], [501, 'sh', 400], [400, 'agy', 300]])), agy);
  // bash runs the last command of the subshell in place: agy -> bash -> timeout -> sh -> node.
  assert.deepEqual(await agyProcess(503, chain([[503, 'sh', 502], [502, 'timeout', 501], [501, 'bash', 400], [400, 'agy', 300]])), agy);
  assert.deepEqual(await agyProcess(500, chain([[500, 'sh', 400], [400, 'agy', 300]])), agy);
  // agy eight levels above the parent is the last place that counts.
  const deep = (levels) => chain([...Array.from({ length: levels }, (_, index) => [600 + index, 'sh', index === levels - 1 ? 400 : 601 + index]),
    [400, 'agy', 300]]);
  assert.deepEqual(await agyProcess(600, deep(8)), agy);
  assert.equal(await agyProcess(600, deep(9)), null);
  assert.equal(await agyProcess(502, chain([[502, 'sh', 501], [501, 'bash', 1], [1, 'agy', 0]])), null);
  assert.equal(await agyProcess(502, chain([[502, 'sh', 501], [501, 'bash', 0]])), null);
  assert.equal(await agyProcess(502, chain([[502, 'sh', 501], [501, 'bash', 450]])), null);
  const tree = chain([[502, 'sh', 400], [400, 'agy', 300]]);
  assert.equal(await agyProcess(502, async (pid, name) => {
    if (pid === 400 && name === 'stat') throw new Error('read error');
    return tree(pid, name);
  }), null);
});

test('a client whose stdin never closes ends at 3 s with exit 0 and the neutral reply', { skip: process.platform === 'win32' }, async (t) => {
  const { homeDir, env } = await fixture(t);
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ROOT, 'scripts', 'asb-agent.mjs'), 'agy-hook', 'PreToolUse'],
      { env: { PATH: process.env.PATH, HOME: homeDir, XDG_STATE_HOME: env.XDG_STATE_HOME } }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
    child.stdin.write('{"made-up":');
  });
  const ms = Date.now() - started;
  assert.deepEqual(result, { code: 0, stdout: '{"decision":"ask"}\n' });
  assert.ok(ms >= 2900 && ms < 3500, `${ms} ms`);
});

const INPUT = '16a48bd1-8ff3-41c6-8c77-fd1124d4aa7a';
const BODY = '[ASB Bridge peer message from fixture.]\nSecond\tline';
async function mailbox(t) {
  const f = await fixture(t);
  const env = { ...f.env, XDG_RUNTIME_DIR: f.homeDir };
  const dir = path.join(f.homeDir, 'asb-agy-mailbox');
  await mkdir(dir, { mode: 0o700 });
  const base = path.join(dir, ID);
  const put = (data = { id: INPUT, text: BODY }, file = `${base}.msg`) => writeFile(file, JSON.stringify(data), { mode: 0o600 });
  const stop = (fields = {}, options = {}) => f.run('Stop', { fullyIdle: true, ...fields }, { env, ...options });
  return { ...f, env, dir, base, put, stop };
}

test('Stop claims once after the record write, and its next Stop leaves the next file in place', async (t) => {
  const { put, stop, base, record } = await mailbox(t);
  await put();
  const replies = await Promise.all([stop(), stop()]);
  assert.deepEqual(replies.map(r => JSON.parse(r.output)).filter(reply => reply.decision), [{ decision: 'continue', reason: BODY }]);
  assert.equal((await record()).event, 'Stop');
  assert.equal(await readFile(`${base}.taken`, 'utf8'), INPUT);
  assert.equal((await stat(`${base}.taken`)).mode & 0o777, 0o600);
  // Two concurrent Stops can use up the guard. Set it again to test the next Stop in order.
  await writeFile(`${base}.continued`, '', { mode: 0o600 });
  await rm(`${base}.taken`);
  await put();
  assert.deepEqual(await stop(), { code: 0, output: '{}\n' });
  assert.equal(JSON.parse(await readFile(`${base}.msg`, 'utf8')).id, INPUT);
  await assert.rejects(stat(`${base}.continued`), { code: 'ENOENT' });
  assert.equal((await stop()).output, `${JSON.stringify({ decision: 'continue', reason: BODY })}\n`);
});

test('Stop skips continuationActive, unsafe files and controls and stays neutral on every fault', async (t) => {
  const { dir, put, stop, base, run, env } = await mailbox(t);
  await put();
  assert.equal((await stop({ continuationActive: true })).output, '{}\n');
  assert.equal((await run('PreInvocation', {}, { env })).output, '{}\n');
  assert.equal((await stop({}, { writeRecord: () => { throw new Error('fixture'); } })).output, '{}\n');
  assert.equal(JSON.parse(await readFile(`${base}.msg`, 'utf8')).id, INPUT);
  await chmod(dir, 0o755);
  assert.equal((await stop()).output, '{}\n');
  await chmod(dir, 0o700);
  const outside = path.join(path.dirname(dir), 'untouched');
  await put(undefined, outside);
  await rm(`${base}.msg`);
  await symlink(outside, `${base}.msg`);
  assert.equal((await stop()).output, '{}\n');
  assert.equal(JSON.parse(await readFile(outside, 'utf8')).id, INPUT);
  await writeFile(`${base}.msg`, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });
  assert.equal((await stop()).output, '{}\n');
  await put();
  await utimes(`${base}.msg`, new Date(0), new Date(0));
  assert.equal((await stop()).output, '{}\n');
  await writeFile(`${base}.msg`, 'not json', { mode: 0o600 });
  assert.equal((await stop()).output, '{}\n');
  await put({ id: INPUT, text: 'bad\x9b' });
  assert.equal((await stop()).output, '{}\n');
  await put();
  await mkdir(`${base}.taken`, { mode: 0o700 });
  assert.equal((await stop()).output, '{}\n');
  await assert.rejects(stat(`${base}.continued`), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dir), [path.basename(`${base}.taken`)]);
});

test('Stop replaces a stale taken marker and continues with the new input', async (t) => {
  const { base, dir, put, stop } = await mailbox(t);
  await put();
  await writeFile(`${base}.taken`, 'previous', { mode: 0o600 });
  assert.deepEqual(JSON.parse((await stop()).output), { decision: 'continue', reason: BODY });
  assert.equal(await readFile(`${base}.taken`, 'utf8'), INPUT);
  assert.equal((await stat(`${base}.taken`)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).sort(), [path.basename(`${base}.continued`), path.basename(`${base}.taken`)]);
});

test('PreToolUse replies before stdin is read; a Stop with open stdin prints once at the hard exit', async (t) => {
  const output = [];
  await agyHook(['PreToolUse'], { stdin: { async *[Symbol.asyncIterator]() {
    assert.deepEqual(output, ['{"decision":"ask"}\n']);
    yield Buffer.from('null');
  } }, write: line => output.push(line) });
  assert.equal(output.length, 1);
  const { homeDir, env } = await fixture(t);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'asb-agent.mjs'), 'agy-hook', 'Stop'],
    { env: { PATH: process.env.PATH, HOME: homeDir, XDG_STATE_HOME: env.XDG_STATE_HOME } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stdin.write('{');
  assert.deepEqual(await once(child, 'close'), [0, null]);
  assert.equal(stdout, '{}\n');
});

test('agyTitle writes <id>.title (0600), skips unchanged rewrites, and replaces on rename', async (t) => {
  const { homeDir, env, dir } = await fixture(t);
  const titleFile = path.join(dir, `${ID}.title`);
  const runTitle = async (payload) => {
    const out = [];
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const code = await agyTitle({ stdin: Readable.from([Buffer.from(text)]), write: (chunk) => out.push(chunk), env, homeDir });
    return { code, output: out.join('') };
  };
  assert.deepEqual(await runTitle({ conversation_id: ID.toUpperCase(), conversation_title: '  asb-agy-w  ', workspace: path.join(homeDir, 'ws') }),
    { code: 0, output: 'asb-agy-w' });
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const first = await stat(titleFile);
  assert.equal(first.mode & 0o777, 0o600);
  assert.equal(await readFile(titleFile, 'utf8'), 'asb-agy-w');
  assert.deepEqual(await runTitle({ conversation_id: ID, conversation_title: 'asb-agy-w', workspace: path.join(homeDir, 'ws') }),
    { code: 0, output: 'asb-agy-w' });
  const second = await stat(titleFile);
  assert.deepEqual([second.ino, second.mtimeMs], [first.ino, first.mtimeMs]);
  assert.deepEqual(await runTitle({ conversation_id: ID, conversation_title: 'renamed-session', workspace: path.join(homeDir, 'ws') }),
    { code: 0, output: 'renamed-session' });
  assert.equal(await readFile(titleFile, 'utf8'), 'renamed-session');
  // Real process dispatch via asb-agent.mjs agy-title
  const dispatched = await new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ROOT, 'scripts', 'asb-agent.mjs'), 'agy-title'],
      { env: { PATH: process.env.PATH, HOME: homeDir, XDG_STATE_HOME: env.XDG_STATE_HOME } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(JSON.stringify({ conversation_id: ID, conversation_title: 'cli-renamed', workspace: path.join(homeDir, 'ws') }));
  });
  assert.deepEqual(dispatched, { code: 0, stdout: 'cli-renamed', stderr: '' });
  assert.equal(await readFile(titleFile, 'utf8'), 'cli-renamed');
});

test('agyTitle writes no file and prints fallback for missing/invalid titles, bad ID, bad JSON, >64 KiB, and no workspace', async (t) => {
  const { homeDir, env, dir } = await fixture(t);
  const ws = path.join(homeDir, 'my-ws');
  const runTitle = async (payload) => {
    const out = [];
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const code = await agyTitle({ stdin: Readable.from([Buffer.from(text)]), write: (chunk) => out.push(chunk), env, homeDir });
    return { code, output: out.join('') };
  };
  for (const [payload, expected] of [
    [{ conversation_id: ID, workspace: ws }, 'agy · my-ws'],
    [{ conversation_id: ID, conversation_title: '   ', cwd: ws }, 'agy · my-ws'],
    [{ conversation_id: ID, conversation_title: 'a'.repeat(201), workspace: ws }, 'agy · my-ws'],
    [{ conversation_id: ID, conversation_title: 'bell\u0007here', workspace: ws }, 'agy · my-ws'],
    [{ conversation_id: ID, conversation_title: 'bidi\u202ehere', workspace: ws }, 'agy · my-ws'],
    [{ conversation_id: '../escape', conversation_title: 'valid-name', workspace: ws }, 'agy · my-ws'],
    ['not json {', 'agy'],
    [JSON.stringify({ conversation_id: ID, conversation_title: 'valid-name', workspace: ws, pad: 'x'.repeat(65 * 1024) }), 'agy'],
    [{ conversation_id: ID, workspace: 'relative-path', cwd: 'also-relative' }, 'agy'],
    [{ conversation_id: ID }, 'agy'],
  ]) {
    assert.deepEqual(await runTitle(payload), { code: 0, output: expected });
  }
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

test('agyTitle never stores or prints email, quota, or other extra fields', async (t) => {
  const { homeDir, env, dir } = await fixture(t);
  const out = [];
  const secretEmail = 'owner-secret@example.invalid';
  const secretQuota = 'quota-token-9999';
  const payload = {
    conversation_id: ID, conversation_title: 'safe-name', workspace: path.join(homeDir, 'ws'),
    email: secretEmail, quota: { remaining: secretQuota }, model: 'secret-model-xyz',
  };
  const code = await agyTitle({ stdin: Readable.from([Buffer.from(JSON.stringify(payload))]), write: (chunk) => out.push(chunk), env, homeDir });
  assert.deepEqual({ code, output: out.join('') }, { code: 0, output: 'safe-name' });
  const files = await readdir(dir);
  assert.deepEqual(files, [`${ID}.title`]);
  const text = await readFile(path.join(dir, files[0]), 'utf8');
  for (const leak of [secretEmail, secretQuota, 'secret-model-xyz']) {
    assert.equal(text.includes(leak), false, leak);
    assert.equal(out.join('').includes(leak), false, leak);
  }
});

test('PreToolUse ask_question posts mapped questions for one and two questions, skips other tools, and ignores POST failure', async (t) => {
  const { homeDir, env, record } = await fixture(t);
  const posted = [];
  const callHook = async (event, fields, postQuestion = async (body) => { posted.push(body); }) => {
    const out = [];
    const hook = { hookEventName: event, conversationId: ID.toUpperCase(), workspacePaths: [path.join(homeDir, 'ws')], ...fields };
    const code = await agyHook([event], { stdin: Readable.from([Buffer.from(JSON.stringify(hook))]), write: (text) => out.push(text),
      env, homeDir, nowMs: 2_000, parentPid: 500, read: agyTree(), postQuestion });
    return { code, output: out.join('') };
  };
  // One question
  assert.deepEqual(await callHook('PreToolUse', {
    toolCall: { id: 'c1', name: 'ask_question', args: { questions: [{ question: 'Pick a fruit', options: ['Kiwi', 'Plum'], is_multi_select: false }] } },
  }), { code: 0, output: '{"decision":"ask"}\n' });
  assert.deepEqual(posted[0], {
    provider: 'antigravity',
    sessionKey: ID,
    question: { questions: [{ question: 'Pick a fruit', options: [{ label: 'Kiwi' }, { label: 'Plum' }], multiSelect: false }] },
  });
  // Two questions with multi-select
  assert.deepEqual(await callHook('PreToolUse', {
    toolCall: { id: 'c2', name: 'ask_question', args: { questions: [
      { question: 'Pick a fruit', options: ['Kiwi', 'Plum'], is_multi_select: false },
      { question: 'Pick toppings', options: ['Salt', 'Lime'], is_multi_select: true },
    ] } },
  }), { code: 0, output: '{"decision":"ask"}\n' });
  assert.deepEqual(posted[1], {
    provider: 'antigravity',
    sessionKey: ID,
    question: { questions: [
      { question: 'Pick a fruit', options: [{ label: 'Kiwi' }, { label: 'Plum' }], multiSelect: false },
      { question: 'Pick toppings', options: [{ label: 'Salt' }, { label: 'Lime' }], multiSelect: true },
    ] },
  });
  // Other tools and PostToolUse do not POST
  const countBefore = posted.length;
  await callHook('PreToolUse', { toolCall: { id: 'c3', name: 'read_file', args: { Path: '/tmp/a' } } });
  await callHook('PostToolUse', { toolCall: { id: 'c1', name: 'ask_question', args: {} } });
  assert.equal(posted.length, countBefore);
  // Failing POST still writes the record, replies neutral, and exits 0
  assert.deepEqual(await callHook('PreToolUse', {
    toolCall: { id: 'c4', name: 'ask_question', args: { questions: [{ question: 'Color?', options: ['Red', 'Blue'], is_multi_select: false }] } },
  }, async () => { throw new Error('engine down'); }), { code: 0, output: '{"decision":"ask"}\n' });
  assert.equal((await record()).state, 'question');
});

test('PreToolUse run_command, write_file, and edit_file post approval cards without content/edit text and skip other tools', async (t) => {
  const { homeDir, env } = await fixture(t);
  const posted = [];
  const callHook = async (toolCall) => {
    const out = [];
    const hook = { hookEventName: 'PreToolUse', conversationId: ID.toUpperCase(), workspacePaths: [path.join(homeDir, 'ws')], toolCall };
    const code = await agyHook(['PreToolUse'], { stdin: Readable.from([Buffer.from(JSON.stringify(hook))]), write: (text) => out.push(text),
      env, homeDir, nowMs: 2_000, parentPid: 500, read: agyTree(), postWait: async (body) => { posted.push(body); } });
    return { code, output: out.join('') };
  };
  assert.deepEqual(await callHook({ id: 't1', name: 'run_command', args: { CommandLine: 'touch asb-probe.txt', WaitMsBeforeAsync: 5000, toolSummary: 'Touch' } }),
    { code: 0, output: '{"decision":"ask"}\n' });
  assert.deepEqual(await callHook({ id: 't2', name: 'write_file', args: { Path: '/tmp/ws/a.txt', Content: 'secret-content-xyz' } }),
    { code: 0, output: '{"decision":"ask"}\n' });
  assert.deepEqual(await callHook({ id: 't3', name: 'edit_file', args: { Path: '/tmp/ws/b.txt', Target: 'secret-old', Replacement: 'secret-new' } }),
    { code: 0, output: '{"decision":"ask"}\n' });
  await callHook({ id: 't4', name: 'read_file', args: { Path: '/tmp/ws/c.txt' } });
  await callHook({ id: 't5', name: 'run_command', args: { CommandLine: 'echo \u202ebad' } });
  assert.deepEqual(posted, [
    { provider: 'antigravity', sessionKey: ID, approval: { kind: 'tool', title: 'Allow a shell command?', display: [{ label: 'Command', text: 'touch asb-probe.txt', mono: true }], note: false } },
    { provider: 'antigravity', sessionKey: ID, approval: { kind: 'tool', title: 'Allow a new file?', display: [{ label: 'File', text: '/tmp/ws/a.txt', mono: true }, { label: 'Size', text: '18 characters', mono: false }], note: false } },
    { provider: 'antigravity', sessionKey: ID, approval: { kind: 'tool', title: 'Allow a file edit?', display: [{ label: 'File', text: '/tmp/ws/b.txt', mono: true }], note: false } },
  ]);
  const serialized = JSON.stringify(posted);
  for (const secret of ['secret-content-xyz', 'secret-old', 'secret-new']) assert.equal(serialized.includes(secret), false, secret);
  // PreToolUse and PostToolUse of the three approval tools change no record state (agyNextState gives null).
  for (const name of ['run_command', 'edit_file', 'write_file']) {
    assert.equal(agyNextState({ hookEventName: 'PreToolUse', toolCall: { name } }), null, name);
    assert.equal(agyNextState({ hookEventName: 'PostToolUse', toolCall: { name } }), null, name);
  }
});
