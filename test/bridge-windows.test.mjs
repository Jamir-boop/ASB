import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { commandLine, executable, linkClaudeRegistry, main } from '../scripts/asb-bridge.mjs';
import { createRelaySupervisor } from '../src/machine-relay.mjs';
import { findExecutable } from '../src/platform-paths.mjs';

// The Windows rules of the bridge installer and the relay supervisor (plan 17.5, 17.6), with platform: 'win32' on any system.
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-bridge-windows-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the Windows PATH search splits PATH with ; and tries each PATHEXT extension in each folder', async (t) => {
  const dir = await temporary(t);
  const [first, second] = [path.join(dir, 'a'), path.join(dir, 'b')];
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, 'codex'), '');
  await mkdir(path.join(first, 'codex.exe'));
  await writeFile(path.join(second, 'codex.cmd'), '');
  const env = { PATH: `${first};${second}`, PATHEXT: '.EXE;.CMD' };
  // The installer keeps its own copy of the search, because it also runs without src/.
  for (const search of [findExecutable, executable]) {
    assert.equal(await search('codex', { platform: 'win32', env }), path.join(second, 'codex.cmd'));
    assert.equal(await search('codex', { platform: 'win32', env: { PATH: env.PATH, PATHEXT: '.BAT' } }), '');
    assert.equal(await search('bun', { platform: 'win32', env }), '');
  }
  await writeFile(path.join(second, 'codex.com'), '');
  for (const search of [findExecutable, executable]) {
    assert.equal(await search('codex', { platform: 'win32', env: { PATH: env.PATH } }), path.join(second, 'codex.com'));
  }
});

test('a codex.cmd runs through cmd.exe with each part quoted, and a part that cmd.exe would change is refused', () => {
  const file = 'C:\\Users\\a b\\AppData\\Roaming\\npm\\codex.cmd';
  assert.deepEqual(commandLine(file, ['plugin', 'marketplace', 'add', 'C:\\Program Files\\asb'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `""${file}" "plugin" "marketplace" "add" "C:\\Program Files\\asb""`],
    options: { windowsVerbatimArguments: true },
  });
  assert.equal(commandLine('C:\\x\\CODEX.BAT', ['--version'], 'win32').command, 'cmd.exe');
  for (const [platform, direct] of [['win32', 'C:\\x\\codex.exe'], ['linux', '/usr/bin/codex.cmd']]) {
    assert.deepEqual(commandLine(direct, ['--version'], platform), { command: direct, args: ['--version'], options: {} });
  }
  for (const bad of ['"', '%PATH%', '^', '&', '|', '<', '>', '!', '\r', '\n']) {
    assert.throws(() => commandLine(file, ['plugin', `C:\\a${bad}b`], 'win32'), /This path cannot go to codex\.cmd safely\./, JSON.stringify(bad));
    assert.throws(() => commandLine(`C:\\a${bad}b\\codex.cmd`, [], 'win32'), /This path cannot go to codex\.cmd safely\./, JSON.stringify(bad));
  }
});

test('linking Claude session folders is refused on Windows', async () => {
  const message = { message: 'Linking Claude session folders is not supported on Windows.' };
  await assert.rejects(linkClaudeRegistry('C:\\a', 'C:\\b', { platform: 'win32' }), message);
  await assert.rejects(main(['link-claude', 'C:\\a', 'C:\\b'], { platform: 'win32' }), message);
});

// A relay that writes its first line and exits when its stdin ends, as bridge/src/relay.ts does.
function fakeRelay({ exitOnStdinEnd = true } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, signals: [], stdinEnded: false });
  const finish = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.stdout.end();
    child.emit('exit', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => { child.signals.push(signal); setImmediate(() => finish(null, signal)); return true; };
  child.stdin.on('finish', () => { child.stdinEnded = true; if (exitOnStdinEnd) setImmediate(() => finish(0, null)); });
  setImmediate(() => child.stdout.write(`${JSON.stringify({ port: 1, token: 'e'.repeat(64) })}\n`));
  return child;
}

test('on Windows the supervisor finds bun.exe through PATHEXT and stops the relay by ending its stdin', async (t) => {
  for (const exitOnStdinEnd of [true, false]) {
    const dir = await temporary(t);
    await mkdir(path.join(dir, 'bridge', 'dist'), { recursive: true });
    await mkdir(path.join(dir, 'bin'));
    await writeFile(path.join(dir, 'bridge', 'dist', 'relay.js'), '');
    await writeFile(path.join(dir, 'bin', 'bun.exe'), '');
    await writeFile(path.join(dir, 'findstr.exe'), '');
    const states = [{ online: true, member: { machineId: 'b'.repeat(16), name: 'beta', certFingerprint: 'f'.repeat(64), addresses: [], port: 4630 } }];
    const group = { self: () => ({ machineId: 'a'.repeat(16) }), peerStates: () => states, tls: async () => ({}) };
    const spawns = [];
    const supervisor = createRelaySupervisor({ group, port: 4659, sourceToken: 'd'.repeat(64), root: dir, platform: 'win32',
      env: { PATH: path.join(dir, 'bin'), LOCALAPPDATA: dir }, catPath: path.join(dir, 'findstr.exe'), stopMs: 50,
      request: async () => ({ status: 500 }), log: () => {},
      spawn: (command, args, options) => { const child = fakeRelay({ exitOnStdinEnd }); spawns.push({ command, args, options, child }); return child; } });
    t.after(() => supervisor.stop());
    await supervisor.start();
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, path.join(dir, 'bin', 'bun.exe'));
    // runtimeDir uses Windows paths; the supervisor joins with the paths of the system it runs on.
    assert.equal(spawns[0].options.env.ASB_RELAY_DIR, path.join(path.win32.join(dir, 'asb', 'run'), 'relay'));
    assert.equal(supervisor.running(), true);
    states.length = 0;
    await supervisor.check();
    assert.equal(spawns[0].child.stdinEnded, true);
    assert.deepEqual(spawns[0].child.signals, exitOnStdinEnd ? [] : ['SIGKILL']);
    assert.equal(supervisor.running(), false);
  }
});
