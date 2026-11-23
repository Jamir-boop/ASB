import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { agyHook, agyProcess } from '../scripts/asb-agy-hook.mjs';

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
      lastUserInput: `${MARKER} prompt`, stepIdx: 1, invocationNum: 1, initialNumSteps: 0, ...fields };
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
  assert.deepEqual(await record(), { conversationId: ID, workspace: path.join(homeDir, 'ws'), state: 'done', stateAtMs: 6_000, createdAtMs: 2_000,
    agyPid: 400, agyStartTicks: '4377321', kittyWindowId: '2', kittyPid: '3280986', kittyListenOn: `unix:${path.join(homeDir, 'kitty.sock')}`,
    transcriptMtimePath: path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', ID, 'transcript.jsonl') });
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
    for (const word of [MARKER, 'made-up-model', 'lastUserInput', 'artifact', 'toolCall', 'error']) assert.equal(text.includes(word), false, word);
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
