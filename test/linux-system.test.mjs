import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BOARD_FLOORS, boardCheck, engineCheck, probePython, pythonCandidates, PYTHON_PROBE } from '../src/linux-system.mjs';

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
