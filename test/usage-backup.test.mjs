import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEDGER_FIRST_MS } from '../src/activity-usage.mjs';
import { BACKUP_CHECK_MS, BACKUP_FIRST_MS, createUsageBackup, DEFAULT_BACKUP_SETTINGS, usageBackupPath } from '../src/usage-backup.mjs';

// Synthetic machines and temp folders only. Dates and times are local, built with the same local Date methods as the module.
const windows = process.platform === 'win32';
const MINUTE = 60_000;
const SELF = '5eed0c0d00000000';
const ID8 = SELF.slice(0, 8);
const at = (hours, minutes = 0, day = 27) => new Date(2026, 9, day, hours, minutes, 0, 0).getTime();
const pad = (value) => String(value).padStart(2, '0');
const dateOf = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const TODAY = dateOf(at(12));
const fileName = (date = TODAY, name = 'atlas', id8 = ID8) => `asb-usage-${name}-${id8}-${date}.json`;
const HOUR = 3_600_000;
const documentAt = (exportedAtMs) => ({ format: 'asb-usage-export', version: 1, exportedAtMs, machines: [
  { machineId: SELF, name: 'atlas', records: [[Date.UTC(2026, 9, 1), 'codex', 'gpt-test-1', 1, 2, 3, 4], [Date.UTC(2026, 9, 1) + HOUR, 'claude', 'claude-test-5', 1, 0, 0, 1]] },
  { machineId: 'b'.repeat(16), name: 'homeLP', records: [[Date.UTC(2026, 9, 2), 'codex', 'gpt-test-1', 5, 0, 0, 1]] }] });
// Real waits for the fake timers and exports, which run after file reads.
const until = async (condition) => {
  for (let index = 0; index < 500 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(condition());
};
const mode = async (file) => (await fs.stat(file)).mode & 0o777;
// Wraps fs.open: the handles of temporary files log writeFile, sync, and close, and writeFile can fail.
function watchTemporaryWrites(t, steps, fail = null) {
  const open = fs.open;
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { steps.push('rename'); return rename(...args); });
  return t.mock.method(fs, 'open', async (file, ...rest) => {
    const handle = await open(file, ...rest);
    if (!String(file).endsWith('.tmp')) return handle;
    steps.push(`open ${rest[0]} ${rest[1]}`);
    for (const name of ['writeFile', 'sync', 'close']) {
      const original = handle[name].bind(handle);
      handle[name] = async (...args) => {
        steps.push(name);
        if (name === 'writeFile' && fail) throw fail;
        return original(...args);
      };
    }
    return handle;
  });
}

async function setup(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-usage-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'config', 'asb', 'usage', 'usage-backup.json');
  const defaultFolder = path.join(root, 'config', 'asb', 'usage', 'backups');
  const clock = { ms: at(12) };
  const logs = [];
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timeouts.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
  };
  const exports = { calls: 0, next: null };
  const exportAll = async () => {
    exports.calls += 1;
    if (exports.next) return exports.next();
    return documentAt(clock.ms);
  };
  const make = (options = {}) => createUsageBackup({ settingsFile, exportAll, now: () => clock.ms, log: (line) => logs.push(line), timers, ...extra, ...options });
  const active = () => timeouts.filter((timer) => !timer.cleared);
  return { root, settingsFile, defaultFolder, clock, logs, timeouts, active, exports, make };
}

test('usageBackupPath and the default folder on Linux and Windows', async (t) => {
  assert.equal(usageBackupPath({ XDG_CONFIG_HOME: '/config' }, 'linux'), '/config/asb/usage/usage-backup.json');
  assert.equal(usageBackupPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), 'C:\\Users\\u\\AppData\\Roaming\\asb\\usage\\usage-backup.json');
  const { make, settingsFile } = await setup(t);
  assert.equal((await make().status()).defaultPath, path.join(path.dirname(settingsFile), 'backups'));
  const win = createUsageBackup({ settingsFile: 'C:\\Users\\u\\AppData\\Roaming\\asb\\usage\\usage-backup.json', exportAll: async () => null,
    platform: 'win32', log: () => {} });
  const status = await win.status();
  assert.deepEqual([status.path, status.defaultPath, status.files], ['C:\\Users\\u\\AppData\\Roaming\\asb\\usage\\backups',
    'C:\\Users\\u\\AppData\\Roaming\\asb\\usage\\backups', []]);
});

test('settings: defaults without a file; an invalid file gives the defaults, logs once, and stays as it was', async (t) => {
  const { make, settingsFile, defaultFolder, logs } = await setup(t);
  const status = await make().status();
  assert.deepEqual(status, { ...DEFAULT_BACKUP_SETTINGS, path: defaultFolder, defaultPath: defaultFolder, nextAtMs: at(3),
    running: false, files: [], lastError: null });
  assert.deepEqual(Object.keys(status), ['enabled', 'time', 'keep', 'folder', 'path', 'defaultPath', 'nextAtMs', 'running', 'files', 'lastError']);
  assert.deepEqual(logs, []);
  await assert.rejects(fs.stat(settingsFile), { code: 'ENOENT' });
  for (const raw of ['{', '[]', JSON.stringify({ version: 1, enabled: true, time: '3:00', keep: 5, folder: '' }),
    JSON.stringify({ version: 2, ...DEFAULT_BACKUP_SETTINGS }), JSON.stringify({ version: 1, ...DEFAULT_BACKUP_SETTINGS, extra: 1 }),
    JSON.stringify({ version: 1, ...DEFAULT_BACKUP_SETTINGS, folder: 'relative' })]) {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, raw);
    logs.length = 0;
    const backup = make();
    assert.deepEqual((await backup.status()).time, '03:00', raw);
    await backup.status();
    assert.deepEqual(logs, ['ASB cannot read its usage backup settings. It uses the defaults.'], raw);
    assert.equal(await fs.readFile(settingsFile, 'utf8'), raw);
  }
});

test('saveSettings checks every value and writes the exact private file', async (t) => {
  const { make, root, settingsFile } = await setup(t);
  const backup = make();
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'x');
  const good = { enabled: false, time: '02:30', keep: 3, folder: '' };
  const cases = [[{ ...good, extra: 1 }, 'Invalid backup settings.'], [{ enabled: false, time: '02:30', keep: 3 }, 'Invalid backup settings.'],
    [{ ...good, time: '3:00' }, 'Invalid backup settings.'], [{ ...good, time: '24:00' }, 'Invalid backup settings.'],
    [{ ...good, keep: 0 }, 'Invalid backup settings.'], [{ ...good, keep: 31 }, 'Invalid backup settings.'], [{ ...good, keep: 2.5 }, 'Invalid backup settings.'],
    [{ ...good, enabled: 'yes' }, 'Invalid backup settings.'], [null, 'Invalid backup settings.'], [{ ...good, folder: `${root}/a\nb` }, 'Invalid backup settings.'],
    [{ ...good, folder: 'relative/path' }, 'Use a full folder path.'], [{ ...good, folder: path.join(root, 'missing') }, 'This folder does not exist.'],
    [{ ...good, folder: file }, 'This folder does not exist.']];
  for (const [body, message] of cases) {
    await assert.rejects(backup.saveSettings(body), (error) => error.statusCode === 400 && error.message === message, JSON.stringify(body));
  }
  await assert.rejects(fs.stat(settingsFile), { code: 'ENOENT' });
  const status = await backup.saveSettings(good);
  assert.deepEqual([status.enabled, status.time, status.keep, status.folder, status.nextAtMs], [false, '02:30', 3, '', null]);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), '{"version":1,"enabled":false,"time":"02:30","keep":3,"folder":""}');
  if (!windows) assert.equal(await mode(settingsFile), 0o600);
  // A custom folder is normalized, and a new instance reads the file.
  const status2 = await backup.saveSettings({ ...good, folder: `${root}${path.sep}.${path.sep}` });
  assert.equal(status2.folder, path.normalize(`${root}${path.sep}`));
  assert.equal((await make().status()).folder, status2.folder);
});

test('the due rule: the time, a file of today under any name of this machine, the switch, and folders do not count', async (t) => {
  const { make, clock, exports, defaultFolder } = await setup(t);
  const backup = make();
  clock.ms = at(2, 59);
  await backup.check();
  assert.equal(exports.calls, 0);
  clock.ms = at(3);
  await backup.check();
  assert.equal(exports.calls, 1);
  assert.deepEqual(await fs.readdir(defaultFolder), [fileName()]);
  await backup.check();
  assert.equal(exports.calls, 1);
  // A renamed machine: the old file of today still counts.
  await fs.rename(path.join(defaultFolder, fileName()), path.join(defaultFolder, fileName(TODAY, 'oldname')));
  await backup.check();
  assert.equal(exports.calls, 1);
  // A folder with today's name is not a backup.
  await fs.rm(path.join(defaultFolder, fileName(TODAY, 'oldname')));
  await fs.mkdir(path.join(defaultFolder, fileName(TODAY, 'folder')));
  clock.ms = at(23, 59);
  await backup.check();
  assert.equal(exports.calls, 2);
  // Off: no backup.
  const off = make();
  await off.saveSettings({ enabled: false, time: '03:00', keep: 5, folder: '' });
  clock.ms = at(4, 0, 28);
  await off.check();
  assert.equal(exports.calls, 2);
});

test('the timers: the first check, the next checks, the exact backup time, a save, and stop', async (t) => {
  assert.ok(BACKUP_FIRST_MS >= LEDGER_FIRST_MS + 5 * 60 * 1000);
  const { make, clock, timeouts, active, exports } = await setup(t);
  clock.ms = at(1);
  const backup = make();
  await backup.start();
  await backup.start();
  assert.deepEqual(timeouts.map((timer) => timer.ms), [BACKUP_FIRST_MS]);
  clock.ms = at(1, 10);
  // The fired timer is done.
  timeouts[0].cleared = true;
  timeouts[0].fn();
  await until(() => active().length === 1);
  assert.deepEqual(active().map((timer) => timer.ms), [BACKUP_CHECK_MS]);
  clock.ms = at(2, 55);
  await backup.check();
  assert.deepEqual(active().map((timer) => timer.ms), [5 * MINUTE]);
  assert.equal(exports.calls, 0);
  // A save reschedules with the same rule: 02:57 is 2 minutes ahead.
  await backup.saveSettings({ enabled: true, time: '02:57', keep: 5, folder: '' });
  assert.deepEqual(active().map((timer) => timer.ms), [2 * MINUTE]);
  clock.ms = at(2, 57);
  await backup.check();
  assert.equal(exports.calls, 1);
  assert.deepEqual(active().map((timer) => timer.ms), [BACKUP_CHECK_MS]);
  const last = active()[0];
  await backup.stop();
  assert.deepEqual(active(), []);
  assert.equal(last.cleared, true);
  const count = timeouts.length;
  await backup.check();
  await backup.saveSettings({ enabled: true, time: '03:00', keep: 5, folder: '' });
  assert.equal(timeouts.length, count);
  assert.equal(exports.calls, 1);
  // Before start(), a save schedules nothing.
  await make().saveSettings({ enabled: true, time: '03:00', keep: 5, folder: '' });
  assert.equal(timeouts.length, count);
});

test('the file name, the content, the modes, and a custom folder that is never made or changed', async (t) => {
  const { make, root, defaultFolder, clock } = await setup(t);
  const backup = make();
  const reply = await backup.runNow();
  const file = path.join(defaultFolder, fileName());
  assert.deepEqual(reply.made, { name: fileName(), path: file, machines: 2, hours: 3 });
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(documentAt(clock.ms)));
  assert.deepEqual(reply.files.map((item) => [item.name, item.date, item.bytes]), [[fileName(), TODAY, JSON.stringify(documentAt(clock.ms)).length]]);
  if (!windows) {
    assert.equal(await mode(file), 0o600);
    assert.equal(await mode(defaultFolder), 0o700);
  }
  const custom = path.join(root, 'custom');
  await fs.mkdir(custom);
  if (!windows) await fs.chmod(custom, 0o755);
  await backup.saveSettings({ enabled: true, time: '03:00', keep: 5, folder: custom });
  const steps = [];
  const watch = watchTemporaryWrites(t, steps);
  const made = (await backup.runNow()).made;
  watch.mock.restore();
  fs.rename.mock.restore();
  assert.deepEqual(steps, [`open wx ${0o600}`, 'writeFile', 'sync', 'close', 'rename']);
  assert.equal(made.path, path.join(custom, fileName()));
  assert.deepEqual(await fs.readdir(custom), [fileName()]);
  if (!windows) {
    assert.equal(await mode(made.path), 0o600);
    assert.equal(await mode(custom), 0o755);
  }
  // A missing custom folder is never made.
  await fs.rm(custom, { recursive: true });
  await assert.rejects(backup.runNow(), (error) => error.statusCode === 500 && error.message === `The backup folder does not exist: ${custom}.`);
  await assert.rejects(fs.stat(custom), { code: 'ENOENT' });
});

test('a second backup of the same day replaces the file, and rotation touches only the files of this machine', async (t) => {
  const { make, defaultFolder, clock, exports } = await setup(t);
  const backup = make();
  await backup.runNow();
  clock.ms += MINUTE;
  await backup.runNow();
  assert.equal(exports.calls, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(defaultFolder, fileName()), 'utf8')).exportedAtMs, clock.ms);
  await backup.saveSettings({ enabled: true, time: '03:00', keep: 3, folder: '' });
  const older = [1, 2, 3, 4, 5, 6].map((days) => fileName(dateOf(at(12, 0, 27 - days)), days === 2 ? 'oldname' : 'atlas'));
  const others = [fileName(TODAY, 'other', 'bbbbbbbb'), fileName(dateOf(at(12, 0, 1)), 'other', 'bbbbbbbb'), 'notes.txt', `${fileName()}.tmp`];
  for (const name of [...older, ...others]) await fs.writeFile(path.join(defaultFolder, name), '{}');
  await fs.mkdir(path.join(defaultFolder, fileName(dateOf(at(12, 0, 1)))));
  await backup.runNow();
  assert.deepEqual((await fs.readdir(defaultFolder)).sort(), [fileName(), older[0], older[1], ...others, fileName(dateOf(at(12, 0, 1)))].sort());
  assert.deepEqual((await backup.status()).files.map((item) => item.name), [fileName(), older[0], older[1]]);
});

test('errors at backup time set lastError, a success clears it, and a repeated scheduled failure logs once', async (t) => {
  const { make, root, defaultFolder, clock, exports, logs } = await setup(t);
  const backup = make();
  // A directory where today's file goes.
  await fs.mkdir(path.join(defaultFolder, fileName()), { recursive: true });
  await assert.rejects(backup.runNow(), (error) => error.statusCode === 500 && error.message.startsWith(`ASB cannot write the backup to ${defaultFolder}: `));
  if (!windows) assert.equal((await backup.status()).lastError.message, `ASB cannot write the backup to ${defaultFolder}: error EISDIR.`);
  assert.equal((await backup.status()).lastError.atMs, clock.ms);
  assert.deepEqual(logs, []);
  await fs.rm(path.join(defaultFolder, fileName()), { recursive: true });
  exports.next = async () => { throw Object.assign(new Error('ASB has no machine ID yet. Start ASB again.'), { statusCode: 409 }); };
  await assert.rejects(backup.runNow(), (error) => error.statusCode === 409 && error.message === 'ASB has no machine ID yet. Start ASB again.');
  exports.next = async () => { throw new Error('boom'); };
  await assert.rejects(backup.runNow(), (error) => error.statusCode === 500 && error.message === 'ASB cannot make the usage backup.');
  assert.deepEqual((await backup.status()).lastError, { atMs: clock.ms, message: 'ASB cannot make the usage backup.' });
  exports.next = null;
  await backup.runNow();
  assert.equal((await backup.status()).lastError, null);
  // A missing custom folder fails before any export.
  const custom = path.join(root, 'custom');
  await fs.mkdir(custom);
  await backup.saveSettings({ enabled: true, time: '03:00', keep: 5, folder: custom });
  await fs.rm(custom, { recursive: true });
  const calls = exports.calls;
  clock.ms = at(12, 0, 28);
  await backup.check();
  await backup.check();
  assert.equal(exports.calls, calls);
  assert.deepEqual(logs, [`The backup folder does not exist: ${custom}.`]);
  // A success resets the logged message, so the next failure logs again.
  await fs.mkdir(custom);
  await backup.check();
  assert.equal(exports.calls, calls + 1);
  await fs.rm(custom, { recursive: true });
  clock.ms = at(12, 0, 29);
  await backup.check();
  assert.deepEqual(logs, [`The backup folder does not exist: ${custom}.`, `The backup folder does not exist: ${custom}.`]);
});

test('two backups at the same time share one export and one result', async (t) => {
  const { make, exports } = await setup(t);
  const backup = make();
  let release;
  exports.next = () => new Promise((resolve) => { release = () => resolve(documentAt(Date.now())); });
  const first = backup.runNow();
  const second = backup.runNow();
  await until(() => release);
  assert.equal((await backup.status()).running, true);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(exports.calls, 1);
  assert.deepEqual(a.made, b.made);
});

test('stop during the export writes nothing', async (t) => {
  const { make, exports, defaultFolder } = await setup(t);
  const backup = make();
  let release;
  exports.next = () => new Promise((resolve) => { release = () => resolve(documentAt(Date.now())); });
  const pending = backup.runNow();
  await until(() => release);
  await backup.stop();
  release();
  assert.equal((await pending).made, null);
  await assert.rejects(fs.stat(defaultFolder), { code: 'ENOENT' });
});

test('status: nextAtMs today or tomorrow, null when off, and at most 100 files, newest first', async (t) => {
  const { make, defaultFolder, clock } = await setup(t, { machineId: () => SELF });
  const backup = make();
  clock.ms = at(1);
  assert.equal((await backup.status()).nextAtMs, at(3));
  clock.ms = at(12);
  assert.equal((await backup.status()).nextAtMs, at(3));
  await fs.mkdir(defaultFolder, { recursive: true });
  for (let days = 0; days < 105; days += 1) await fs.writeFile(path.join(defaultFolder, fileName(dateOf(at(12, 0, 27 - days)))), 'x'.repeat(days));
  const status = await backup.status();
  assert.equal(status.nextAtMs, at(3, 0, 28));
  assert.equal(status.files.length, 100);
  assert.deepEqual(status.files[0], { name: fileName(), date: TODAY, bytes: 0, modifiedAtMs: status.files[0].modifiedAtMs });
  assert.equal(status.files[0].modifiedAtMs, Math.floor((await fs.stat(path.join(defaultFolder, fileName()))).mtimeMs));
  assert.ok(status.files.every((file) => Number.isSafeInteger(file.modifiedAtMs)));
  assert.equal(status.files[99].date, dateOf(at(12, 0, 27 - 99)));
  await backup.saveSettings({ enabled: false, time: '03:00', keep: 5, folder: '' });
  assert.equal((await backup.status()).nextAtMs, null);
  // Without a machine ID, no files.
  assert.deepEqual((await make({ machineId: () => '' }).status()).files, []);
});

test('an unreadable settings path logs once and stays unchanged', async (t) => {
  const { make, settingsFile, logs } = await setup(t);
  await fs.mkdir(settingsFile, { recursive: true });
  const backup = make();
  assert.equal((await backup.status()).enabled, true);
  await backup.status();
  assert.deepEqual(logs, ['ASB cannot read its usage backup settings. It uses the defaults.']);
  assert.equal((await fs.stat(settingsFile)).isDirectory(), true);
});

test('write errors use the exact user reason, and leave no temporary file', async (t) => {
  const { make, defaultFolder, clock } = await setup(t);
  const backup = make();
  // Inject error codes, not modes: the test must also work as root.
  for (const [code, why] of [['EACCES', 'no permission'], ['EPERM', 'no permission'], ['ENOSPC', 'the disk is full'],
    ['EROFS', 'the disk is read-only'], ['EIO', 'error EIO'], [undefined, 'an error']]) {
    const steps = [];
    const mock = watchTemporaryWrites(t, steps, Object.assign(new Error('synthetic'), { code }));
    const message = `ASB cannot write the backup to ${defaultFolder}: ${why}.`;
    await assert.rejects(backup.runNow(), (error) => error.statusCode === 500 && error.message === message);
    assert.deepEqual((await backup.status()).lastError, { atMs: clock.ms, message });
    mock.mock.restore();
    fs.rename.mock.restore();
    assert.deepEqual(steps.slice(1), ['writeFile', 'close']);
    assert.deepEqual(await fs.readdir(defaultFolder), []);
  }
  await backup.runNow();
  assert.equal((await backup.status()).lastError, null);
});

test('rotation logs a delete failure once per file, ignores ENOENT, and never deletes the new file', async (t) => {
  const { make, defaultFolder, logs } = await setup(t);
  const backup = make();
  await backup.saveSettings({ enabled: true, time: '03:00', keep: 1, folder: '' });
  await backup.runNow();
  const old = fileName(dateOf(at(12, 0, 26)));
  const gone = fileName(dateOf(at(12, 0, 25)));
  for (const name of [old, gone]) await fs.writeFile(path.join(defaultFolder, name), '{}');
  const remove = fs.rm.bind(fs);
  const mock = t.mock.method(fs, 'rm', async (file, options) => {
    if (file === path.join(defaultFolder, old)) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    if (file === path.join(defaultFolder, gone)) throw Object.assign(new Error('synthetic'), { code: 'ENOENT' });
    return remove(file, options);
  });
  await backup.runNow();
  await backup.runNow();
  assert.deepEqual(logs, [`ASB cannot delete an old usage backup: ${old}.`]);
  assert.equal((await fs.stat(path.join(defaultFolder, fileName()))).isFile(), true);
  mock.mock.restore();
});

test('stop waits for a write and rotation that already started', async (t) => {
  const { make, defaultFolder } = await setup(t);
  const backup = make();
  let release;
  const rename = fs.rename.bind(fs);
  const mock = t.mock.method(fs, 'rename', async (...args) => {
    await new Promise((resolve) => { release = resolve; });
    return rename(...args);
  });
  const pending = backup.runNow();
  await until(() => release);
  let stopped = false;
  const stopping = backup.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  await pending;
  mock.mock.restore();
  assert.equal((await fs.stat(path.join(defaultFolder, fileName()))).isFile(), true);
});
