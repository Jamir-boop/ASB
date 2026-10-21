import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_FLOORS, boardCheck, boardCheckFile, cachedBoardCheck, engineCheck, forgetBoardCheck, probePython, pythonCandidates, PYTHON_PROBE } from '../src/linux-system.mjs';

// No test runs a real Python: execFile is a fake, and PATH holds stub files that no test runs.
async function stubs(t, names) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-linux-system-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  for (const name of names) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { directory, bin };
}
const probe = (values) => JSON.stringify({ python: '3.13.5', gi: '3.50.0', gtk: [4, 18, 6], adw: [1, 7, 6], glib: [2, 84, 4],
  cairo: true, qrcode: true, trayHost: true, ...values });
const fakeExec = (outputs, calls = []) => async (file, args, options) => {
  calls.push([file, args, options]);
  if (!(file in outputs)) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
  return { stdout: `${outputs[file]}\n`, stderr: '' };
};

test('Python candidates: ASB_PYTHON alone, else /usr/bin/python3, then PATH, without duplicates', async (t) => {
  const { directory, bin } = await stubs(t, ['python3']);
  const system = path.join(directory, 'system-python3');
  await writeFile(system, '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(await pythonCandidates({ ASB_PYTHON: '/opt/python/bin/python3', PATH: bin }, { system }), ['/opt/python/bin/python3']);
  assert.deepEqual(await pythonCandidates({ PATH: bin }, { system }), [system, path.join(bin, 'python3')]);
  // A relative ASB_PYTHON is ignored.
  assert.deepEqual(await pythonCandidates({ ASB_PYTHON: 'python3', PATH: bin }, { system }), [system, path.join(bin, 'python3')]);
  assert.deepEqual(await pythonCandidates({ PATH: bin }, { system: path.join(bin, 'python3') }), [path.join(bin, 'python3')]);
  // NixOS and Guix: no /usr/bin/python3.
  assert.deepEqual(await pythonCandidates({ PATH: bin }, { system: path.join(directory, 'missing') }), [path.join(bin, 'python3')]);
  assert.deepEqual(await pythonCandidates({ PATH: '' }, { system: path.join(directory, 'missing') }), []);
});

test('probePython runs the probe with a 5 s timeout and reads one JSON object', async () => {
  const calls = [];
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  assert.deepEqual(await probePython('/usr/bin/python3', { execFile: fakeExec({ '/usr/bin/python3': probe({}) }, calls), env }),
    JSON.parse(probe({})));
  assert.deepEqual(calls, [['/usr/bin/python3', ['-c', PYTHON_PROBE], { env, timeout: 5000 }]]);
  assert.equal(await probePython('/bin/false', { execFile: fakeExec({}) }), null);
  assert.equal(await probePython('/x', { execFile: fakeExec({ '/x': 'Traceback' }) }), null);
  for (const text of ["'Gtk', '4.0'", "'Adw', '1'", "require_foreign('cairo')", 'import qrcode', 'NameHasOwner', 'org.kde.StatusNotifierWatcher',
    "os.environ.get('DBUS_SESSION_BUS_ADDRESS')", 'Gio.DBusCallFlags.NONE, 1000, None']) assert.ok(PYTHON_PROBE.includes(text), text);
});

test('boardCheck uses the first Python with PyGObject and checks the floors', async () => {
  assert.deepEqual(BOARD_FLOORS, { python: [3, 9], gtk: [4, 12], adw: [1, 4] });
  const check = (outputs, candidates = Object.keys(outputs)) => boardCheck({ env: {}, execFile: fakeExec(outputs), candidates });
  assert.deepEqual(await check({ '/a': probe({}) }), { ok: true, python: '/a', versions: JSON.parse(probe({})), reason: '' });
  // Missing gi: the next candidate has it.
  const second = await check({ '/a': probe({ gi: null, gtk: null, adw: null }), '/b': probe({ python: '3.12.1' }) });
  assert.deepEqual([second.ok, second.python, second.versions.python], [true, '/b', '3.12.1']);
  const noGi = await check({ '/a': probe({ gi: null, gtk: null, adw: null }) });
  assert.deepEqual([noGi.ok, noGi.python, noGi.versions.gi, noGi.reason], [false, '/a', null, 'PyGObject is not installed.']);
  const old = await check({ '/a': probe({ gtk: [4, 8, 3], adw: [1, 2, 2] }) });
  assert.deepEqual([old.ok, old.python, old.reason], [false, '/a', 'GTK 4.8 is older than 4.12. Libadwaita 1.2 is older than 1.4.']);
  assert.equal((await check({ '/a': probe({ gtk: [4, 12, 3], adw: [1, 4, 2], python: '3.9.25' }) })).ok, true);
  assert.equal((await check({ '/a': probe({ python: '3.8.10' }) })).reason, 'Python 3.8 is older than 3.9.');
  assert.equal((await check({ '/a': probe({ adw: null }) })).reason, 'Libadwaita is not installed.');
  assert.deepEqual(await check({}, ['/bin/false']), { ok: false, python: null, versions: null, reason: 'Python 3 does not run.' });
  assert.deepEqual(await check({}, []), { ok: false, python: null, versions: null, reason: 'Python 3 is not installed.' });
});

test('engineCheck needs Node.js 20, SQLite, openssl, and xdg-open on PATH', async (t) => {
  const { bin } = await stubs(t, ['sqlite3', 'openssl', 'xdg-open']);
  const node = { path: '/usr/bin/node', version: '24.11.1', sqlite: true };
  const ok = await engineCheck({ env: { PATH: bin }, node });
  assert.deepEqual(ok, { ok: true, reason: '', node, sqlite3: '', openssl: path.join(bin, 'openssl'), xdgOpen: path.join(bin, 'xdg-open') });
  const sqlite3 = await engineCheck({ env: { PATH: bin }, node: { ...node, version: '20.19.2', sqlite: false } });
  assert.deepEqual([sqlite3.ok, sqlite3.sqlite3], [true, path.join(bin, 'sqlite3')]);
  const empty = await engineCheck({ env: { PATH: '' }, node: { ...node, version: '18.19.0', sqlite: false } });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'Node.js 18.19.0 is older than 20. ASB needs Node.js with built-in SQLite (22.13 or later) or the sqlite3 command. '
    + 'openssl is not installed. xdg-open is not installed (xdg-utils).');
  assert.match((await engineCheck({ env: { PATH: bin }, node: null })).reason, /^Node\.js is not installed\.$/);
});

// The kept board check (the window launcher only). A fake execFile counts the probes; the Python files are stubs that no test runs.
async function keptCheck(t) {
  const { directory } = await stubs(t, []);
  const python = path.join(directory, 'python3');
  await writeFile(python, '#!/bin/sh\n', { mode: 0o755 });
  const file = path.join(directory, 'cache', 'asb', 'board-check.json');
  const calls = [];
  const run = (options = {}) => cachedBoardCheck({ env: {}, platform: 'linux', candidates: [python], file, version: '1.10.0',
    execFile: fakeExec({ [python]: probe({}) }, calls), ...options });
  // The number of probes that one call runs.
  const probes = async (options) => { const before = calls.length; await run(options); return calls.length - before; };
  return { directory, python, file, calls, run, probes };
}

test('the kept board check file is board-check.json in the cache folder', () => {
  assert.equal(boardCheckFile({ XDG_CACHE_HOME: '/x/cache' }, 'linux'), '/x/cache/asb/board-check.json');
  assert.equal(boardCheckFile({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32'), 'C:\\Users\\a\\AppData\\Local\\asb\\cache\\board-check.json');
});

test('a good board check is kept with its key, and the next start skips the probe', async (t) => {
  const { python, file, calls, run } = await keptCheck(t);
  const first = await run();
  assert.deepEqual([first.ok, first.python, calls.length], [true, python, 1]);
  const kept = JSON.parse(await readFile(file, 'utf8'));
  const { size, mtimeMs } = await stat(python);
  assert.deepEqual(kept, { python, versions: JSON.parse(probe({})), key: { version: '1.10.0', platform: 'linux', candidates: [python], size, mtimeMs } });
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o700, 0o700);
  }
  // No temporary file stays.
  assert.deepEqual(await readdir(path.dirname(file)), ['board-check.json']);
  assert.deepEqual(await run(), first);
  assert.equal(calls.length, 1);
});

test('the kept board check uses the cache folder and the ASB version of the package by default', async (t) => {
  const { directory, python } = await keptCheck(t);
  const calls = [];
  const options = { env: { XDG_CACHE_HOME: path.join(directory, 'xdg') }, platform: 'linux', candidates: [python], execFile: fakeExec({ [python]: probe({}) }, calls) };
  await cachedBoardCheck(options);
  await cachedBoardCheck(options);
  assert.equal(calls.length, 1);
  const { version } = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const kept = JSON.parse(await readFile(path.join(directory, 'xdg', 'asb', 'board-check.json'), 'utf8'));
  assert.equal(kept.key.version, version);
});

test('each part of the key makes the next start probe again', async (t) => {
  const { directory, python, run, probes } = await keptCheck(t);
  const other = path.join(directory, 'other-python3');
  await writeFile(other, '#!/bin/sh\n', { mode: 0o755 });
  // After each change, the first call probes and keeps a new file; the next call uses it.
  const changes = {
    'the ASB version': () => ({ version: '1.11.0' }),
    'the system': () => ({ platform: 'win32' }),
    'the Python candidates': () => ({ candidates: [python, other] }),
    'the size of the Python file': async () => { await appendFile(python, '# one more line\n'); },
    'the time of the Python file': async () => { await utimes(python, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z')); },
  };
  for (const [name, change] of Object.entries(changes)) {
    await run();
    assert.equal(await probes(), 0, `${name}: the start key is good`);
    const options = await change();
    assert.equal(await probes(options), 1, name);
    assert.equal(await probes(options), 0, `${name}: a new key is kept`);
  }
});

test('a kept file that names a Python outside the candidates, or a Python file that is gone, makes the next start probe', async (t) => {
  const { directory, python, file, run, probes } = await keptCheck(t);
  const other = path.join(directory, 'other-python3');
  await writeFile(other, '#!/bin/sh\n', { mode: 0o755 });
  await run();
  // The key of the other file, with the other file named as the Python: it is not a candidate, so the check probes.
  const { size, mtimeMs } = await stat(other);
  const kept = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...kept, python: other, key: { ...kept.key, size, mtimeMs } }));
  assert.equal(await probes(), 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).python, python);
  await rm(python);
  const gone = await run();
  assert.deepEqual([gone.ok, gone.python], [true, python]);
  assert.equal(await probes(), 1);
});

test('a missing, damaged, or other file makes the next start probe and keep a good file', async (t) => {
  const { python, file, probes } = await keptCheck(t);
  await probes();
  const good = JSON.parse(await readFile(file, 'utf8'));
  const bad = [undefined, '', '{', 'null', '[]', '{}', '"text"', JSON.stringify({ ...good, key: null }), JSON.stringify({ ...good, key: { ...good.key, size: -1 } }),
    JSON.stringify({ ...good, versions: null }), JSON.stringify({ ...good, versions: {} }), JSON.stringify({ ...good, python: 5 }),
    JSON.stringify({ ...good, python: '/bin/sh' }), JSON.stringify({ key: good.key })];
  for (const text of bad) {
    if (text === undefined) await rm(file); else await writeFile(file, text);
    assert.equal(await probes(), 1, String(text));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), good, String(text));
    assert.equal(await probes(), 0);
  }
  assert.equal(good.python, python);
});

test('a file that cannot be read or written never stops the check', async (t) => {
  const { directory, python, file, calls, run } = await keptCheck(t);
  // A folder in place of the file.
  await mkdir(file, { recursive: true });
  assert.equal((await run()).ok, true);
  assert.equal((await stat(file)).isDirectory(), true);
  assert.deepEqual(await readdir(file), []);
  assert.equal((await run()).ok, true);
  assert.equal(calls.length, 2);
  // A cache folder that cannot exist.
  const blocker = path.join(directory, 'blocker');
  await writeFile(blocker, '');
  const blocked = await run({ file: path.join(blocker, 'cache', 'board-check.json') });
  assert.deepEqual([blocked.ok, blocked.python, calls.length], [true, python, 3]);
  assert.deepEqual(await readdir(directory), ['bin', 'blocker', 'cache', 'python3']);
});

test('a failed board check is never kept', async (t) => {
  const { python, file, calls, run } = await keptCheck(t);
  const failing = fakeExec({ [python]: probe({ gi: null, gtk: null, adw: null }) }, calls);
  for (let count = 1; count <= 2; count += 1) {
    const board = await run({ execFile: failing });
    assert.deepEqual([board.ok, board.python, board.reason, calls.length], [false, python, 'PyGObject is not installed.', count]);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  }
  const noPython = await run({ candidates: [], execFile: failing });
  assert.deepEqual([noPython.ok, noPython.reason], [false, 'Python 3 is not installed.']);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  // A good file is not used again after the libraries are gone and the Python file changed.
  await run();
  await appendFile(python, '# changed\n');
  assert.equal((await run({ execFile: failing })).ok, false);
});

test('boardCheck, which doctor, setup, and the tray start use, neither reads nor writes the kept file', async (t) => {
  const { python, file, run } = await keptCheck(t);
  await run();
  const before = await readFile(file, 'utf8');
  const env = { XDG_CACHE_HOME: path.dirname(path.dirname(file)) };
  assert.equal(boardCheckFile(env, 'linux'), file);
  const calls = [];
  const check = () => boardCheck({ env, execFile: fakeExec({ [python]: probe({}) }, calls), candidates: [python], platform: 'linux' });
  for (let count = 1; count <= 2; count += 1) {
    assert.equal((await check()).ok, true);
    assert.equal(calls.length, count);
  }
  assert.equal(await readFile(file, 'utf8'), before);
  await rm(file);
  assert.equal((await check()).ok, true);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('only the window launcher asks for the kept board check', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const users = [];
  for (const folder of ['scripts', 'src']) {
    for (const name of (await readdir(path.join(root, folder))).sort()) {
      if (name.endsWith('.mjs') && (await readFile(path.join(root, folder, name), 'utf8')).includes('cachedBoardCheck')) users.push(`${folder}/${name}`);
    }
  }
  assert.deepEqual(users, ['scripts/asb-desktop.mjs', 'src/linux-system.mjs']);
});

test('forgetBoardCheck deletes the kept file and accepts a missing file', async (t) => {
  const { file, run } = await keptCheck(t);
  await run();
  await stat(file);
  forgetBoardCheck({ env: {}, platform: 'linux', file });
  await assert.rejects(stat(file), { code: 'ENOENT' });
  forgetBoardCheck({ env: {}, platform: 'linux', file });
  // The default file comes from the cache folder.
  const env = { XDG_CACHE_HOME: path.dirname(path.dirname(file)) };
  await run();
  forgetBoardCheck({ env, platform: 'linux' });
  await assert.rejects(stat(file), { code: 'ENOENT' });
  // A folder is no file: the error comes back to the caller.
  await mkdir(file);
  assert.throws(() => forgetBoardCheck({ file }), { code: /^(EISDIR|EPERM|ERR_FS_EISDIR)$/ });
});
