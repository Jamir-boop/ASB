import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findOpenCodeKittyWindow, openCodeWindowTitle } from '../src/opencode-kitty.mjs';
import { openSwitchboardThread } from '../src/switchboard.mjs';

// A fake /proc: each entry is pid -> { comm, ppid, args, env, cwd }.
async function fakeProc(t, entries) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-oc-proc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [pid, { comm, ppid, args = [], env = {}, cwd }] of Object.entries(entries)) {
    await mkdir(path.join(dir, pid));
    await writeFile(path.join(dir, pid, 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 4377321 0\n`);
    await writeFile(path.join(dir, pid, 'cmdline'), args.map((arg) => `${arg}\0`).join(''));
    await writeFile(path.join(dir, pid, 'environ'),
      Object.entries({ ...env, HOME: '/home/x', SECRET_TOKEN: 'nope' }).map(([key, value]) => `${key}=${value}\0`).join(''));
    if (cwd) await symlink(cwd, path.join(dir, pid, 'cwd'));
  }
  return dir;
}

const kittyEnv = (kittyPid, windowId) => ({ KITTY_WINDOW_ID: windowId, KITTY_LISTEN_ON: `unix:@kitty-${kittyPid}` });
const tui = (args, kittyPid, windowId = '1', extra = {}) => ({ comm: 'opencode', ppid: 300, args, env: kittyEnv(kittyPid, windowId), ...extra });
const chain = (kittyPid) => ({ 300: { comm: 'bash', ppid: kittyPid }, [kittyPid]: { comm: 'kitty', ppid: 1 } });

test('a TUI with the session argument matches, with each accepted form', async (t) => {
  for (const args of [['/usr/bin/opencode', '--session', 'ses_a'], ['/usr/bin/opencode', '--session=ses_a'],
    ['/usr/bin/opencode', '-s', 'ses_a'], ['/usr/bin/opencode', '-s=ses_a']]) {
    const procDir = await fakeProc(t, { 400: tui(args, 200, '7'), ...chain(200) });
    assert.deepEqual(await findOpenCodeKittyWindow({ id: 'ses_a', title: 'A', cwd: '/work', procDir }),
      { pid: 400, args, listenOn: 'unix:@kitty-200', windowId: '7' }, args.join(' '));
    const other = await findOpenCodeKittyWindow({ id: 'ses_b', title: '', cwd: '/work', procDir });
    assert.equal(other, null, args.join(' '));
  }
});

test('rule 2 matches by folder and window title, with the 40-character cut', async (t) => {
  const long = 'x'.repeat(50);
  const procDir = await fakeProc(t, { 400: tui(['/usr/bin/opencode'], 200, '7', { cwd: '/work/a' }), ...chain(200) });
  const exec = async (args) => {
    if (args.includes('ls')) return JSON.stringify([{ tabs: [{ windows: [{ id: 7, title: openCodeWindowTitle('Fix the parser') }] }] }]);
    throw new Error('unexpected');
  };
  assert.equal((await findOpenCodeKittyWindow({ id: 'ses_a', title: 'Fix the parser', cwd: '/work/a', procDir, exec }))?.windowId, '7');
  assert.equal(await findOpenCodeKittyWindow({ id: 'ses_a', title: 'Another title', cwd: '/work/a', procDir, exec }), null);
  assert.equal(await findOpenCodeKittyWindow({ id: 'ses_a', title: 'Fix the parser', cwd: '/work/b', procDir, exec }), null);
  assert.equal(await findOpenCodeKittyWindow({ id: 'ses_a', title: '', cwd: '/work/a', procDir, exec }), null);
  const cut = async (args) => JSON.stringify([{ tabs: [{ windows: [{ id: 7, title: openCodeWindowTitle(long) }] }] }]);
  assert.equal(openCodeWindowTitle(long), `OC | ${'x'.repeat(37)}…`);
  assert.equal((await findOpenCodeKittyWindow({ id: 'ses_a', title: long, cwd: '/work/a', procDir, exec: cut }))?.windowId, '7');
});

test('a serve process, a non-kitty parent, and a bad listen-on give no match', async (t) => {
  const exec = async () => JSON.stringify([{ tabs: [{ windows: [{ id: 1, title: 'OC | A' }] }] }]);
  let procDir = await fakeProc(t, { 400: tui(['/usr/bin/opencode', 'serve', '--service'], 200, '7', { cwd: '/work' }), ...chain(200) });
  assert.equal(await findOpenCodeKittyWindow({ id: 'ses_a', title: 'A', cwd: '/work', procDir, exec }), null);
  procDir = await fakeProc(t, { 400: tui(['/usr/bin/opencode'], 200, '7', { cwd: '/work' }), 300: { comm: 'bash', ppid: 1 } });
  assert.equal(await findOpenCodeKittyWindow({ id: 'ses_a', title: 'A', cwd: '/work', procDir, exec }), null);
  procDir = await fakeProc(t, { 400: tui(['/usr/bin/opencode'], 999, '7', { cwd: '/work' }), ...chain(200) });
  assert.equal(await findOpenCodeKittyWindow({ id: 'ses_a', title: 'A', cwd: '/work', procDir, exec }), null);
});

test('the caller sees only a match or null, never another environment key', async (t) => {
  const procDir = await fakeProc(t, { 400: tui(['/usr/bin/opencode', '--session', 'ses_a'], 200, '7'), ...chain(200) });
  const result = await findOpenCodeKittyWindow({ id: 'ses_a', title: 'A', cwd: '/work', procDir });
  assert.deepEqual(Object.keys(result).sort(), ['args', 'listenOn', 'pid', 'windowId']);
  assert.equal(JSON.stringify(result).includes('SECRET_TOKEN'), false);
  assert.equal(JSON.stringify(result).includes('HOME'), false);
});

test('the open focuses a matching window, and starts a new one when the focus fails or nothing matches', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-oc-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const procDir = await fakeProc(t, { 400: tui(['/usr/bin/opencode', '--session', 'ses_a'], 200, '7'), ...chain(200) });
  const thread = { id: 'ses_a', externalId: 'ses_a', provider: 'opencode', source: 'opencode-db', title: 'A', cwd: dir,
    createdAtMs: 1, updatedAtMs: 2, lifecycleRunning: false, opensInKitty: true };
  const programs = async () => ({ kitty: '/usr/bin/kitty', opencode: '/usr/bin/opencode' });
  const spawns = [];
  const spawn = (command, args, options) => {
    spawns.push([command, args, options]);
    const child = { once: (event, fn) => { if (event === 'spawn') fn(); return child; }, unref: () => {} };
    return child;
  };
  const calls = [];
  const exec = async (args) => { calls.push(args); return ''; };
  const result = await openSwitchboardThread(thread, { findPrograms: programs, spawn, procDir, exec });
  assert.deepEqual([result.opened, result.method], [true, 'opencode-kitty-focus']);
  assert.deepEqual(calls, [['@', '--to', 'unix:@kitty-200', 'focus-window', '--match', 'id:7']]);
  assert.equal(spawns.length, 0);
  calls.length = 0;
  const failing = async () => { throw new Error('kitty refused'); };
  const spawned = await openSwitchboardThread(thread, { findPrograms: programs, spawn, procDir, exec: failing });
  assert.deepEqual([spawned.opened, spawned.method], [true, 'opencode-kitty']);
  assert.deepEqual(spawns, [['/usr/bin/kitty', ['--directory', dir, '/usr/bin/opencode', '--session', 'ses_a'], { detached: true, stdio: 'ignore' }]]);
  const empty = await fakeProc(t, { 300: { comm: 'bash', ppid: 1 } });
  const fresh = await openSwitchboardThread(thread, { findPrograms: programs, spawn, procDir: empty, exec });
  assert.equal(fresh.method, 'opencode-kitty');
});
