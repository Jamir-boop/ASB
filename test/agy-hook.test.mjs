import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyHookSetup } from '../scripts/asb-agent.mjs';
import { agyHookEntry, agyHookLine, agyHookState, agySettingsFile, agyTitleEntry, agyTitleState, changeAgyTitle } from '../src/agy-hook.mjs';

// Every run has a temp HOME with a made-up `.gemini` folder or a temp `--file`; no test reads or writes the real agy files.
const agent = fileURLToPath(new URL('../scripts/asb-agent.mjs', import.meta.url));
const launcherFile = fileURLToPath(new URL('../scripts/asb', import.meta.url));
const LAUNCHER = '/opt/asb-test/bin/asb';
const ID = '9d482c79-a221-41ba-96c9-1c571ac0565b';
const SHELLS = ['/bin/sh', '/bin/bash'];
const EVENTS = [['PreToolUse', '{"decision":"ask"}'], ['Stop', '{}']];

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-hook-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { HOME: dir, PATH: '/usr/bin:/bin', ASB_INSTALLED_LAUNCHER: LAUNCHER };
  return { dir, env, gemini: path.join(dir, '.gemini'), file: path.join(dir, '.gemini', 'config', 'hooks.json'), titleFile: agySettingsFile(dir) };
}

async function local(env, args, options = {}) {
  const out = [];
  const err = [];
  const code = await agyHookSetup(args, { env, log: (line) => out.push(line), error: (line) => err.push(line), ...options });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const run = (file, args, { env = {}, input = '' } = {}) => new Promise((resolve, reject) => {
  const started = Date.now();
  const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
  // The child may exit before it reads stdin.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
const line = (shell, launcher, event, options = {}) => run(shell, ['-c', agyHookLine(launcher, event)], { env: { PATH: '/usr/bin:/bin' }, ...options });
const stub = async (dir, name, text) => {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  return file;
};
const tree = async (dir) => Promise.all((await readdir(dir, { recursive: true })).sort().map(async (name) => {
  const info = await lstat(path.join(dir, name));
  return [name, info.ino, info.mode, info.size, info.mtimeMs, info.isFile() ? await readFile(path.join(dir, name), 'utf8') : ''];
}));
// The command lines of the processes that hold `marker`.
async function processesWith(marker) {
  const found = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const text = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
    if (text.includes(marker)) found.push(text);
  }
  return found;
}

test('the installed line is the exact rule text for each event', () => {
  assert.equal(agyHookLine('/opt/x/asb', 'PreToolUse'),
    `out=$(timeout 5 '/opt/x/asb' agent agy-hook PreToolUse 2>/dev/null); if [ -n "$out" ]; then printf '%s' "$out"; else printf '%s' '{"decision":"ask"}'; fi`);
  assert.equal(agyHookLine('/opt/x/asb', 'Stop'),
    `out=$(timeout 5 '/opt/x/asb' agent agy-hook Stop 2>/dev/null); if [ -n "$out" ]; then printf '%s' "$out"; else printf '%s' '{}'; fi`);
  const plain = (event) => [{ type: 'command', command: agyHookLine(LAUNCHER, event), timeout: 10 }];
  const tool = (event) => [{ matcher: '^(ask_question|run_command|edit_file|write_file)$', hooks: plain(event) }];
  assert.deepEqual(agyHookEntry(LAUNCHER), { SessionStart: plain('SessionStart'), PreInvocation: plain('PreInvocation'), Stop: plain('Stop'),
    PreToolUse: tool('PreToolUse'), PostToolUse: tool('PostToolUse') });
  assert.deepEqual(Object.keys(agyHookEntry(LAUNCHER)), ['SessionStart', 'PreInvocation', 'Stop', 'PreToolUse', 'PostToolUse']);
  // An entry with the old ^ask_question$ matcher reads as changed.
  const oldEntry = { ...agyHookEntry(LAUNCHER), PreToolUse: [{ matcher: '^ask_question$', hooks: plain('PreToolUse') }],
    PostToolUse: [{ matcher: '^ask_question$', hooks: plain('PostToolUse') }] };
  assert.equal(agyHookState({ asb: oldEntry }, LAUNCHER), 'changed');
});

test('under dash and bash: a missing launcher, a kill after the reply, exit 1, a reply, and stdin each give one reply and exit 0', async (t) => {
  const { dir } = await home(t);
  const killed = await stub(dir, 'killed', `printf '%s' '{"made":"up"}'\nkill -9 $$`);
  const failed = await stub(dir, 'failed', 'exit 1');
  const replies = await stub(dir, 'replies', `printf '%s\\n' '{"made":"reply"}'`);
  const hashes = await stub(dir, 'hashes', `sha256sum > '${dir}/hash'`);
  for (const shell of SHELLS) {
    for (const [event, neutral] of EVENTS) {
      const label = `${shell} ${event}`;
      for (const [launcher, output] of [[path.join(dir, 'missing'), neutral], [killed, '{"made":"up"}'], [failed, neutral], [replies, '{"made":"reply"}']]) {
        const result = await line(shell, launcher, event);
        assert.deepEqual([result.code, result.stdout], [0, output], `${label} ${path.basename(launcher)}`);
      }
      const input = `{"made-up":"${label}"}`;
      const result = await line(shell, hashes, event, { input });
      assert.deepEqual([result.code, result.stdout], [0, neutral], label);
      assert.equal((await readFile(path.join(dir, 'hash'), 'utf8')).split(' ')[0], createHash('sha256').update(input).digest('hex'), label);
    }
  }
});

test('a launcher whose sh child sleeps gives the neutral reply in under 6 s and leaves no process', async (t) => {
  const { dir } = await home(t);
  // The shape of scripts/asb: a sh script with a child (no exec). The odd seconds make the sleep findable.
  const sleeper = await stub(dir, 'sleeper', 'sleep 30.0713\nprintf x');
  for (const shell of SHELLS) {
    const result = await line(shell, sleeper, 'PreToolUse');
    assert.deepEqual([result.code, result.stdout], [0, '{"decision":"ask"}'], shell);
    assert.ok(result.ms < 6000, `${shell}: ${result.ms} ms`);
    assert.deepEqual([...await processesWith(sleeper), ...await processesWith('30.0713')], [], shell);
  }
});

test('without timeout on PATH the line gives the neutral reply and exit 0', async (t) => {
  const { dir } = await home(t);
  const replies = await stub(dir, 'replies', `printf '%s' '{"made":"reply"}'`);
  const empty = path.join(dir, 'empty-path');
  await mkdir(empty);
  for (const shell of SHELLS) {
    for (const [event, neutral] of EVENTS) {
      const result = await line(shell, replies, event, { env: { PATH: empty } });
      assert.deepEqual([result.code, result.stdout], [0, neutral], `${shell} ${event}`);
    }
  }
});

test('the real client under the installed line writes one record and prints its reply once', { skip: process.platform === 'win32' }, async (t) => {
  const { dir } = await home(t);
  const launcher = await realpath(launcherFile);
  const env = { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_RUNTIME_DIR: path.join(dir, 'runtime'), XDG_DATA_HOME: path.join(dir, 'data'), ASB_NODE: process.execPath };
  const ws = path.join(dir, 'ws');
  for (const [event, reply, fields] of [['PreInvocation', '{}', {}],
    ['PreToolUse', '{"decision":"ask"}', { toolCall: { id: 'call-1', name: 'ask_question', args: {} } }]]) {
    const input = JSON.stringify({ hookEventName: event, conversationId: ID, workspacePaths: [ws], lastUserInput: 'made-up prompt', ...fields });
    const result = await run('/bin/sh', ['-c', agyHookLine(launcher, event)], { env, input });
    assert.deepEqual([result.code, result.stdout], [0, reply], event);
  }
  const records = path.join(dir, 'state', 'asb', 'agy');
  assert.deepEqual(await readdir(records), [`${ID}.json`]);
  assert.equal(JSON.parse(await readFile(path.join(records, `${ID}.json`), 'utf8')).state, 'question');
});

test('install refuses without ~/.gemini and makes nothing', async (t) => {
  const { dir, env } = await home(t);
  const before = await tree(dir);
  assert.deepEqual(await local(env, ['install']), { code: 1, stdout: '', stderr: 'agy has not run for this user (no ~/.gemini).' });
  assert.deepEqual(await tree(dir), before);
  assert.deepEqual(await local(env, ['status']), { code: 0, stdout: 'agy hook (~/.gemini/config/hooks.json): not installed\nagy title (~/.gemini/antigravity-cli/settings.json): not installed', stderr: '' });
  assert.deepEqual(await local(env, ['remove']), { code: 0, stdout: 'agy hook (~/.gemini/config/hooks.json): not installed\nagy title (~/.gemini/antigravity-cli/settings.json): not installed', stderr: '' });
  assert.deepEqual(await tree(dir), before);
});

test('install makes the config folder 0700 and the file 0600 with only the asb key; a second install changes nothing; remove leaves {}', async (t) => {
  const { gemini, file, titleFile, env } = await home(t);
  await mkdir(gemini, { mode: 0o755 });
  const result = await run(process.execPath, [agent, 'agy-hook', 'install'], { env });
  assert.deepEqual([result.code, result.stdout], [0, 'agy hook (~/.gemini/config/hooks.json): installed\nagy title (~/.gemini/antigravity-cli/settings.json): no agy\n']);
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify({ asb: agyHookEntry(LAUNCHER) }, null, 2)}\n`);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(gemini)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(path.dirname(file)), ['hooks.json']);
  const before = await tree(gemini);
  assert.deepEqual(await local(env, ['install', '--json']), { code: 0, stdout: JSON.stringify({ targets: [{ file, result: 'unchanged', kind: 'hooks' }, { file: titleFile, result: 'no agy', kind: 'title' }] }), stderr: '' });
  assert.deepEqual(await tree(gemini), before);
  assert.equal((await local(env, ['remove'])).stdout, 'agy hook (~/.gemini/config/hooks.json): removed\nagy title (~/.gemini/antigravity-cli/settings.json): not installed');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {});
});

test('install keeps the other keys in order, the mode, and a backup made once; remove gives back the value', async (t) => {
  const { dir, env } = await home(t);
  const file = path.join(dir, 'ws', '.agents', 'hooks.json');
  await mkdir(path.dirname(file), { recursive: true });
  const value = { theirs: { Stop: [{ type: 'command', command: '/usr/local/bin/made-up' }] }, asb: { Stop: [] }, last: { made: 'up' } };
  await writeFile(file, JSON.stringify(value));
  await chmod(file, 0o640);
  assert.equal((await local(env, ['status', '--file', file])).stdout, `agy hook (~${file.slice(dir.length)}): changed\nagy title (~/.gemini/antigravity-cli/settings.json): not installed`);
  assert.equal((await local(env, ['install', '--file', file])).code, 0);
  const installed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(installed), ['theirs', 'asb', 'last']);
  assert.deepEqual(installed, { ...value, asb: agyHookEntry(LAUNCHER) });
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(await readFile(`${file}.asb-backup`, 'utf8'), JSON.stringify(value));
  assert.equal((await local(env, ['remove', '--file', file])).code, 0);
  const removed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual([Object.keys(removed), removed], [['theirs', 'last'], { theirs: value.theirs, last: value.last }]);
  assert.equal((await local(env, ['install', '--file', file])).code, 0);
  assert.equal(await readFile(`${file}.asb-backup`, 'utf8'), JSON.stringify(value));
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['hooks.json', 'hooks.json.asb-backup']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))), ['theirs', 'last', 'asb']);
});

test('status reports each state; --json gives one object; the state without a launcher takes the launcher of the entry', async (t) => {
  const { dir, titleFile, env } = await home(t);
  const file = path.join(dir, 'c', 'hooks.json');
  const status = async (text) => {
    if (text !== undefined) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
    return JSON.parse((await local(env, ['status', '--json', '--file', file])).stdout);
  };
  assert.deepEqual(await status(), { targets: [{ file, state: 'not installed', kind: 'hooks' }, { file: titleFile, state: 'not installed', kind: 'title' }] });
  assert.equal((await status('{"made":"up"}')).targets[0].state, 'not installed');
  assert.equal((await status(JSON.stringify({ asb: agyHookEntry(LAUNCHER) }))).targets[0].state, 'installed');
  assert.equal((await status(JSON.stringify({ asb: agyHookEntry('/other/asb') }))).targets[0].state, 'changed');
  const edited = agyHookEntry(LAUNCHER);
  edited.Stop[0].timeout = 30;
  assert.equal((await status(JSON.stringify({ asb: edited }))).targets[0].state, 'changed');
  assert.equal((await status('[]')).targets[0].state, 'invalid settings');
  assert.equal(agyHookState({ asb: agyHookEntry('/other/asb') }, ''), 'installed');
  assert.equal(agyHookState({ asb: { ...agyHookEntry('/other/asb'), Extra: [] } }, ''), 'changed');
  assert.equal(agyHookState({ asb: null }, ''), 'changed');
  assert.equal(agyHookState({}, ''), 'not installed');
});

test('a write between the read and the rename changes nothing and asks for a new run', async (t) => {
  const { dir, env } = await home(t);
  const file = path.join(dir, 'race', 'hooks.json');
  await mkdir(path.dirname(file));
  for (const [action, value, titleOut] of [['install', { made: 'up' }, 'no agy'], ['remove', { asb: agyHookEntry(LAUNCHER) }, 'not installed']]) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    const result = await local(env, [action, '--file', file], { beforeRename: () => appendFile(file, ' ') });
    assert.deepEqual(result, { code: 1, stdout: `agy hook (~${file.slice(dir.length)}): settings changed\nagy title (~/.gemini/antigravity-cli/settings.json): ${titleOut}`, stderr: 'Settings changed during the install. Run it again.' });
    assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(value)} `);
    assert.deepEqual(await readdir(path.dirname(file)), ['hooks.json']);
  }
});

test('a quote, a control character, or a relative launcher, win32, and no launcher are refused with no write', async (t) => {
  const { gemini, env } = await home(t);
  await mkdir(gemini);
  const before = await tree(gemini);
  const refused = 'The installed launcher path has a quote or a control character. The agy hook cannot use it.';
  assert.deepEqual(await local({ ...env, ASB_INSTALLED_LAUNCHER: "/opt/it's/asb" }, ['install']), { code: 1, stdout: '', stderr: refused });
  assert.deepEqual(await local({ ...env, ASB_INSTALLED_LAUNCHER: '/opt/a\nb/asb' }, ['install']), { code: 1, stdout: '', stderr: refused });
  const noLauncher = { code: 1, stdout: '', stderr: 'Run agy-hook install from the installed asb (ASB_INSTALLED_LAUNCHER is not set).' };
  assert.deepEqual(await local({ ...env, ASB_INSTALLED_LAUNCHER: 'relative/asb' }, ['install']), noLauncher);
  assert.deepEqual(await local({ HOME: env.HOME }, ['install']), noLauncher);
  assert.deepEqual(await local(env, ['install'], { platform: 'win32' }), { code: 1, stdout: '', stderr: 'The agy hook works on Linux only for now.' });
  assert.deepEqual(await tree(gemini), before);
});

test('the entry names the real path of the launcher', async (t) => {
  const { dir, gemini, file, env } = await home(t);
  await mkdir(gemini);
  await mkdir(path.join(dir, 'real'));
  const real = await stub(path.join(dir, 'real'), 'asb', 'exit 0');
  await symlink(real, path.join(dir, 'link-asb'));
  const linked = { ...env, ASB_INSTALLED_LAUNCHER: path.join(dir, 'link-asb') };
  assert.equal((await local(linked, ['install'])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).asb, agyHookEntry(real));
  assert.equal((await local(linked, ['status'])).stdout, 'agy hook (~/.gemini/config/hooks.json): installed\nagy title (~/.gemini/antigravity-cli/settings.json): not installed');
});

test('a file too big, not an object, not JSON, or a dangling link is refused with no write; a bad command line gives 2', async (t) => {
  const { dir, env } = await home(t);
  const folder = path.join(dir, 'bad');
  await mkdir(folder);
  const file = path.join(folder, 'hooks.json');
  for (const text of [`{"made":"${'x'.repeat(4 * 1024 * 1024)}"}`, '[]', '"text"', 'null', 'not json {']) {
    await writeFile(file, text);
    const before = await tree(folder);
    for (const [action, titleOut] of [['install', 'no agy'], ['remove', 'not installed']]) {
      assert.deepEqual(await local(env, [action, '--file', file]), { code: 1, stdout: `agy hook (~${file.slice(dir.length)}): invalid settings\nagy title (~/.gemini/antigravity-cli/settings.json): ${titleOut}`, stderr: '' }, text.slice(0, 20));
    }
    assert.deepEqual(await tree(folder), before);
  }
  await rm(file);
  await symlink(path.join(folder, 'missing.json'), file);
  assert.equal((await local(env, ['install', '--file', file])).stdout, `agy hook (~${file.slice(dir.length)}): invalid settings\nagy title (~/.gemini/antigravity-cli/settings.json): no agy`);
  for (const args of [[], ['wipe'], ['install', '--file'], ['install', '--file', 'relative.json'], ['status', '--json', '--json'], ['install', '--dir', file]]) {
    assert.equal((await local(env, args)).code, 2, args.join(' '));
  }
});

test('changeAgyTitle handles install, unchanged, owner title, remove, missing file, and missing folder', async (t) => {
  const { titleFile } = await home(t);
  const folder = path.dirname(titleFile);
  assert.equal(await changeAgyTitle('install', titleFile, { launcher: LAUNCHER }), 'no agy');
  assert.equal(await changeAgyTitle('remove', titleFile, { launcher: LAUNCHER }), 'not installed');
  await mkdir(folder, { recursive: true });
  // Missing settings.json in existing folder -> created with only title
  assert.equal(await changeAgyTitle('install', titleFile, { launcher: LAUNCHER }), 'installed');
  assert.deepEqual(JSON.parse(await readFile(titleFile, 'utf8')), { title: agyTitleEntry(LAUNCHER) });
  // Second install -> unchanged
  assert.equal(await changeAgyTitle('install', titleFile, { launcher: LAUNCHER }), 'unchanged');
  // Remove ours -> removed, other keys preserved
  await writeFile(titleFile, JSON.stringify({ theme: 'dark', title: agyTitleEntry(LAUNCHER), extra: 1 }));
  assert.equal(await changeAgyTitle('remove', titleFile, { launcher: LAUNCHER }), 'removed');
  assert.deepEqual(JSON.parse(await readFile(titleFile, 'utf8')), { theme: 'dark', extra: 1 });
  // Owner title of another shape -> other, bytes unchanged on install and remove
  const ownerRaw = '{"theme":"dark","title":{"type":"command","command":"echo hi","enabled":true}}\n';
  await writeFile(titleFile, ownerRaw);
  assert.equal(await changeAgyTitle('install', titleFile, { launcher: LAUNCHER }), 'other');
  assert.equal(await readFile(titleFile, 'utf8'), ownerRaw);
  assert.equal(await changeAgyTitle('remove', titleFile, { launcher: LAUNCHER }), 'other');
  assert.equal(await readFile(titleFile, 'utf8'), ownerRaw);
  assert.equal(agyTitleState({ title: agyTitleEntry('/other/asb') }, ''), 'installed');
  assert.equal(agyTitleState({ title: agyTitleEntry('/other/asb') }, LAUNCHER), 'other');
  assert.equal(agyTitleState({}, LAUNCHER), 'not installed');
});

test('agyHookSetup reports both targets in text and JSON and exits 1 on refused title write', async (t) => {
  const { gemini, file, titleFile, env } = await home(t);
  await mkdir(path.dirname(titleFile), { recursive: true });
  assert.deepEqual(await local(env, ['install']), {
    code: 0,
    stdout: 'agy hook (~/.gemini/config/hooks.json): installed\nagy title (~/.gemini/antigravity-cli/settings.json): installed',
    stderr: '',
  });
  assert.deepEqual(JSON.parse((await local(env, ['install', '--json'])).stdout), {
    targets: [{ file, result: 'unchanged', kind: 'hooks' }, { file: titleFile, result: 'unchanged', kind: 'title' }],
  });
  assert.deepEqual(JSON.parse((await local(env, ['status', '--json'])).stdout), {
    targets: [{ file, state: 'installed', kind: 'hooks' }, { file: titleFile, state: 'installed', kind: 'title' }],
  });
  assert.deepEqual(await local(env, ['remove']), {
    code: 0,
    stdout: 'agy hook (~/.gemini/config/hooks.json): removed\nagy title (~/.gemini/antigravity-cli/settings.json): removed',
    stderr: '',
  });
  // Owner title: install exits 0 with other
  await writeFile(titleFile, JSON.stringify({ title: { type: 'command', command: 'custom', enabled: true } }));
  assert.deepEqual(await local(env, ['install']), {
    code: 0,
    stdout: 'agy hook (~/.gemini/config/hooks.json): installed\nagy title (~/.gemini/antigravity-cli/settings.json): other',
    stderr: '',
  });
  // Invalid settings.json: exit 1
  await writeFile(titleFile, 'not json');
  assert.deepEqual(await local(env, ['install']), {
    code: 1,
    stdout: 'agy hook (~/.gemini/config/hooks.json): unchanged\nagy title (~/.gemini/antigravity-cli/settings.json): invalid settings',
    stderr: '',
  });
  assert.ok(gemini);
});
