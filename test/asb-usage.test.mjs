import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/asb-usage.mjs';
import { instanceRuntimePath } from '../scripts/asb-instance.mjs';

// A fake engine on loopback with synthetic machines; the CLI finds it through a temp runtime record.
const token = 'c'.repeat(64);
const USAGE = 'Usage: asb usage export <file> | import <file> | backup [now | on | off] [--time HH:MM] [--keep N] [--folder <path>|default]';
const HOUR = 3_600_000;
const exported = { format: 'asb-usage-export', version: 1, exportedAtMs: 1_800_000_000_000, machines: [
  { machineId: 'a'.repeat(16), name: 'debian', records: Array.from({ length: 1200 }, (_, index) => [1_700_000_000_000 - (1_700_000_000_000 % HOUR) - index * HOUR, 'codex', 'gpt-test-1', 1, 0, 0, 1]) },
  { machineId: 'b'.repeat(16), name: 'homeLP', records: [[1_700_000_000_000 - (1_700_000_000_000 % HOUR), 'claude', 'claude-test-5', 1, 0, 0, 1]] }] };

async function fixture(t, { engine = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-usage-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'runtime'), LOCALAPPDATA: path.join(home, 'local') };
  const records = [];
  const replies = new Map([['GET /api/usage/export', [200, exported]],
    ['POST /api/usage/import', [200, { machines: [{ machineId: 'a'.repeat(16), name: 'debian', hours: 1200 }, { machineId: 'b'.repeat(16), name: 'homeLP', hours: 1 }] }]]]);
  if (engine) {
    const server = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      records.push({ route: `${request.method} ${request.url}`, token: request.headers['x-asb-source-token'], body: body ? JSON.parse(body) : undefined });
      const [status, value] = replies.get(`${request.method} ${request.url}`) || [404, { error: 'Route is not available in ASB.' }];
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const runtime = instanceRuntimePath(env);
    await mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(runtime), 0o700);
    await writeFile(runtime, JSON.stringify({ schema: 1, pid: process.pid, port: server.address().port, sourceToken: token }), { mode: 0o600 });
  }
  const run = async (args) => {
    const out = [];
    const err = [];
    const code = await main(args, { env, print: (line) => out.push(line), printError: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { home, records, replies, run };
}

test('asb usage checks its arguments', async (t) => {
  const { run, records } = await fixture(t);
  for (const args of [[], ['export'], ['import'], ['list', 'x'], ['export', 'a', 'b'], ['import', 'a', '--yes'],
    ['backup', 'x'], ['backup', '--time', '02:00'], ['backup', 'now', '--keep', '3'], ['backup', 'now', 'x'], ['backup', 'on', 'x'],
    ['backup', 'on', '--days', '3'], ['backup', 'on', '--keep', '3', '--keep', '4'], ['backup', 'on', '--time'], ['backup', 'off', '--folder']]) {
    assert.deepEqual(await run(args), { code: 2, out: '', err: USAGE }, args.join(' '));
  }
  assert.deepEqual(records, []);
});

test('asb usage export writes a private file with the engine reply and prints the summary', async (t) => {
  const { home, run, records, replies } = await fixture(t);
  const file = path.join(home, 'usage.json');
  assert.deepEqual(await run(['export', file]), { code: 0, out: `Saved the usage of 2 machines (1,201 hours) to ${file}.`, err: '' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), exported);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(records.map(({ route, token: value }) => [route, value]), [['GET /api/usage/export', token]]);
  // An existing file is never replaced.
  assert.deepEqual(await run(['export', file]), { code: 1, out: '', err: `asb usage: ${file} exists. Choose a new file name.` });
  assert.equal(records.length, 1);
  // One machine, and an engine error.
  replies.set('GET /api/usage/export', [200, { ...exported, machines: exported.machines.slice(1) }]);
  const one = path.join(home, 'one.json');
  assert.deepEqual(await run(['export', one]), { code: 0, out: `Saved the usage of 1 machine (1 hour) to ${one}.`, err: '' });
  replies.set('GET /api/usage/export', [409, { error: 'ASB has no machine ID yet. Start ASB again.' }]);
  const failed = path.join(home, 'failed.json');
  assert.deepEqual(await run(['export', failed]), { code: 1, out: '', err: 'asb usage: ASB has no machine ID yet. Start ASB again.' });
  await assert.rejects(stat(failed), { code: 'ENOENT' });
});

test('asb usage import posts the file and prints the machines', async (t) => {
  const { home, run, records, replies } = await fixture(t);
  const file = path.join(home, 'usage.json');
  await writeFile(file, JSON.stringify(exported));
  assert.deepEqual(await run(['import', file]), { code: 0, out: 'Imported the usage of 2 machines: debian (1,200 hours), homeLP (1 hour).', err: '' });
  assert.deepEqual(records.map(({ route, token: value, body }) => [route, value, body]), [['POST /api/usage/import', token, exported]]);
  replies.set('POST /api/usage/import', [200, { machines: [{ machineId: 'b'.repeat(16), name: 'homeLP', hours: 2 }] }]);
  assert.equal((await run(['import', file])).out, 'Imported the usage of 1 machine: homeLP (2 hours).');
  replies.set('POST /api/usage/import', [400, { error: 'This file is not an ASB usage export.' }]);
  assert.deepEqual(await run(['import', file]), { code: 1, out: '', err: 'asb usage: This file is not an ASB usage export.' });
});

test('asb usage import prints an unsaved ledger error and exits nonzero', async (t) => {
  const { home, run, replies } = await fixture(t);
  const file = path.join(home, 'usage.json');
  await writeFile(file, JSON.stringify({ format: 'asb-usage-export', version: 1, exportedAtMs: 1_800_000_000_000, machines: [] }));
  const message = 'ASB could not save the usage ledger. Keep the export file and try again.';
  replies.set('POST /api/usage/import', [500, { error: message }]);
  assert.deepEqual(await run(['import', file]), { code: 1, out: '', err: `asb usage: ${message}` });
});

test('asb usage import refuses a large file and a file that is not JSON before it asks the engine', async (t) => {
  const { home, run, records } = await fixture(t);
  const large = path.join(home, 'large.json');
  await writeFile(large, '');
  await truncate(large, 64 * 1024 * 1024 + 1);
  assert.deepEqual(await run(['import', large]), { code: 1, out: '', err: 'asb usage: The file is too large for an ASB usage export.' });
  const text = path.join(home, 'text.json');
  await writeFile(text, 'not json');
  assert.deepEqual(await run(['import', text]), { code: 1, out: '', err: 'asb usage: This file is not an ASB usage export.' });
  assert.deepEqual(await run(['import', path.join(home, 'missing.json')]), { code: 1, out: '', err: `asb usage: Cannot read ${path.join(home, 'missing.json')}.` });
  assert.deepEqual(records, []);
});

test('asb usage says when ASB is not running', async (t) => {
  const { home, run } = await fixture(t, { engine: false });
  const file = path.join(home, 'usage.json');
  assert.deepEqual(await run(['export', file]), { code: 1, out: '', err: 'asb usage: ASB is not running. Start it: asb engine start.' });
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await writeFile(file, JSON.stringify(exported));
  assert.deepEqual(await run(['import', file]), { code: 1, out: '', err: 'asb usage: ASB is not running. Start it: asb engine start.' });
});

const pad = (value) => String(value).padStart(2, '0');
const stamp = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const backupStatus = (extra = {}) => ({ enabled: true, time: '03:00', keep: 5, folder: '', path: '/home/u/.config/asb/usage/backups',
  defaultPath: '/home/u/.config/asb/usage/backups', nextAtMs: Date.now() + 86_400_000, running: false, files: [], lastError: null, ...extra });

test('asb usage backup prints the status lines', async (t) => {
  const { run, records, replies } = await fixture(t);
  const next = new Date(2030, 0, 2, 3, 0).getTime();
  replies.set('GET /api/usage/backup', [200, backupStatus({ nextAtMs: next })]);
  assert.deepEqual(await run(['backup']), { code: 0, err: '', out: ['Daily backup: on, at 03:00. Keeps the last 5 files.',
    'Folder: /home/u/.config/asb/usage/backups (default)', `Next backup: ${stamp(next)}.`, 'Backups: none yet.'].join('\n') });
  assert.deepEqual(records.map(({ route, token: value }) => [route, value]), [['GET /api/usage/backup', token]]);
  const modified = new Date(2026, 9, 27, 3, 0).getTime();
  const files = [512, 1003520, 1258291].map((bytes, index) => ({ name: `asb-usage-pc-5eed0c0d-2026-10-${27 - index}.json`, date: `2026-10-${27 - index}`, bytes, modifiedAtMs: modified }));
  const failedAt = new Date(2026, 9, 26, 3, 0).getTime();
  replies.set('GET /api/usage/backup', [200, backupStatus({ enabled: false, keep: 1, folder: '/data/backups', path: '/data/backups', nextAtMs: null,
    running: true, files, lastError: { atMs: failedAt, message: 'ASB cannot write the backup to /data/backups: the disk is full.' } })]);
  assert.deepEqual(await run(['backup']), { code: 0, err: '', out: ['Daily backup: off. Keeps 1 file.', 'Folder: /data/backups', 'A backup is running.', 'Backups:',
    `  asb-usage-pc-5eed0c0d-2026-10-27.json  ${stamp(modified)}  512 bytes`, `  asb-usage-pc-5eed0c0d-2026-10-26.json  ${stamp(modified)}  980 KB`,
    `  asb-usage-pc-5eed0c0d-2026-10-25.json  ${stamp(modified)}  1.2 MB`,
    `Last backup failed (${stamp(failedAt)}): ASB cannot write the backup to /data/backups: the disk is full.`].join('\n') });
  // A backup time that has passed: the next check makes it.
  replies.set('GET /api/usage/backup', [200, backupStatus({ nextAtMs: Date.now() - 60_000 })]);
  assert.match((await run(['backup'])).out, /\nNext backup: in a few minutes\.\n/);
});

test('asb usage backup now, on, and off', async (t) => {
  const { run, records, replies } = await fixture(t);
  replies.set('POST /api/usage/backup/now', [200, { ...backupStatus(), made: { name: 'a.json', path: '/home/u/.config/asb/usage/backups/a.json', machines: 2, hours: 3071 } }]);
  assert.deepEqual(await run(['backup', 'now']), { code: 0, err: '', out: 'Saved the usage of 2 machines (3,071 hours) to /home/u/.config/asb/usage/backups/a.json.' });
  replies.set('POST /api/usage/backup/now', [200, { ...backupStatus(), made: { name: 'a.json', path: '/b/a.json', machines: 1, hours: 1 } }]);
  assert.equal((await run(['backup', 'now'])).out, 'Saved the usage of 1 machine (1 hour) to /b/a.json.');
  assert.deepEqual(records.map(({ route, token: value, body }) => [route, value, body]), [['POST /api/usage/backup/now', token, {}], ['POST /api/usage/backup/now', token, {}]]);
  replies.set('POST /api/usage/backup/now', [409, { error: 'ASB has no machine ID yet. Start ASB again.' }]);
  assert.deepEqual(await run(['backup', 'now']), { code: 1, out: '', err: 'asb usage: ASB has no machine ID yet. Start ASB again.' });

  records.length = 0;
  replies.set('GET /api/usage/backup', [200, backupStatus({ folder: '/old', path: '/old' })]);
  replies.set('POST /api/usage/backup/settings', [200, backupStatus({ enabled: false, keep: 3 })]);
  const result = await run(['backup', 'on', '--time', '02:30', '--keep', '3', '--folder', 'rel']);
  assert.equal(result.code, 0);
  assert.equal(result.out.split('\n')[0], 'Daily backup: off. Keeps the last 3 files.');
  assert.deepEqual(records.map(({ route, body }) => [route, body]), [['GET /api/usage/backup', undefined],
    ['POST /api/usage/backup/settings', { enabled: true, time: '02:30', keep: 3, folder: path.resolve('rel') }]]);
  records.length = 0;
  await run(['backup', 'off', '--folder', 'default']);
  assert.deepEqual(records[1].body, { enabled: false, time: '03:00', keep: 5, folder: '' });
  records.length = 0;
  await run(['backup', 'on']);
  assert.deepEqual(records[1].body, { enabled: true, time: '03:00', keep: 5, folder: '/old' });
  replies.set('POST /api/usage/backup/settings', [400, { error: 'This folder does not exist.' }]);
  assert.deepEqual(await run(['backup', 'on', '--folder', '/missing']), { code: 1, out: '', err: 'asb usage: This folder does not exist.' });
});

test('asb usage backup checks its values and explains an engine without backups', async (t) => {
  const { run, records } = await fixture(t);
  for (const value of ['3:00', '24:00', '03:60', 'x']) {
    assert.deepEqual(await run(['backup', 'on', '--time', value]), { code: 2, out: '', err: 'asb usage: Use --time as HH:MM, for example 03:00.' }, value);
  }
  for (const value of ['0', '31', '2.5', 'x', '-1']) {
    assert.deepEqual(await run(['backup', 'off', '--keep', value]), { code: 2, out: '', err: 'asb usage: Use --keep with a number from 1 to 30.' }, value);
  }
  assert.deepEqual(records, []);
  // The fake engine has no backup routes: 404.
  for (const args of [['backup'], ['backup', 'now'], ['backup', 'on']]) {
    assert.deepEqual(await run(args), { code: 1, out: '', err: 'asb usage: This ASB engine has no usage backups. Update ASB, then start it again.' }, args.join(' '));
  }
});
