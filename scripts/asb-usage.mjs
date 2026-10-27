// `asb usage export <file>`, `asb usage import <file>`, and `asb usage backup`: the permanent usage ledger of the running engine
// (src/usage-ledger.mjs) and its daily backups (src/usage-backup.mjs).
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readServiceRuntime, requestInstance } from './asb-instance.mjs';

const usage = 'Usage: asb usage export <file> | import <file> | backup [now | on | off] [--time HH:MM] [--keep N] [--folder <path>|default]';
const NO_BACKUPS = 'This ASB engine has no usage backups. Update ASB, then start it again.';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_BYTES = 64 * 1024 * 1024;
const failure = (message) => Object.assign(new Error(message), { exitCode: 1 });
const number = (value) => value.toLocaleString('en-US');
const plural = (value, word) => `${number(value)} ${word}${value === 1 ? '' : 's'}`;

async function request(env, platform, route, { notFound, ...options } = {}) {
  const runtime = await readServiceRuntime(env, platform);
  if (!runtime) throw failure('ASB is not running. Start it: asb engine start.');
  let reply;
  try { reply = await requestInstance(runtime, route, { timeoutMs: 60_000, ...options }); }
  catch (error) { throw failure(error.message); }
  if (reply.statusCode === 404 && notFound) throw failure(notFound);
  if (reply.statusCode !== 200) throw failure(typeof reply.body?.error === 'string' ? reply.body.error : `ASB returned HTTP ${reply.statusCode}.`);
  return reply.body;
}

async function exportUsage(file, { env, platform, print }) {
  if (await stat(file).then(() => true, (error) => error.code !== 'ENOENT')) throw failure(`${file} exists. Choose a new file name.`);
  const document = await request(env, platform, '/api/usage/export', { maxBytes: MAX_BYTES });
  await writeFile(file, JSON.stringify(document), { flag: 'wx', mode: 0o600 });
  const hours = document.machines.reduce((sum, machine) => sum + machine.records.length, 0);
  print(`Saved the usage of ${plural(document.machines.length, 'machine')} (${plural(hours, 'hour')}) to ${file}.`);
}

async function importUsage(file, { env, platform, print }) {
  const info = await stat(file).catch(() => null);
  if (!info) throw failure(`Cannot read ${file}.`);
  if (info.size > MAX_BYTES) throw failure('The file is too large for an ASB usage export.');
  let document;
  try { document = JSON.parse(await readFile(file, 'utf8')); } catch { throw failure('This file is not an ASB usage export.'); }
  const { machines } = await request(env, platform, '/api/usage/import', { method: 'POST', body: document });
  print(`Imported the usage of ${plural(machines.length, 'machine')}: ${machines.map((machine) => `${machine.name} (${plural(machine.hours, 'hour')})`).join(', ')}.`);
}

const pad = (value) => String(value).padStart(2, '0');
const stamp = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const size = (bytes) => bytes < 1024 ? plural(bytes, 'byte') : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function printStatus(status, print) {
  const keeps = status.keep === 1 ? 'Keeps 1 file.' : `Keeps the last ${status.keep} files.`;
  print(`Daily backup: ${status.enabled ? `on, at ${status.time}` : 'off'}. ${keeps}`);
  print(`Folder: ${status.path}${status.folder === '' ? ' (default)' : ''}`);
  if (status.enabled) print(status.nextAtMs > Date.now() ? `Next backup: ${stamp(status.nextAtMs)}.` : 'Next backup: in a few minutes.');
  if (status.running) print('A backup is running.');
  if (!status.files.length) print('Backups: none yet.');
  else {
    print('Backups:');
    for (const file of status.files) print(`  ${file.name}  ${stamp(file.modifiedAtMs)}  ${size(file.bytes)}`);
  }
  if (status.lastError) print(`Last backup failed (${stamp(status.lastError.atMs)}): ${status.lastError.message}`);
}

// The options of `backup on|off`, or null for a usage error.
function backupOptions(rest) {
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    if (!['--time', '--keep', '--folder'].includes(name) || Object.hasOwn(options, name) || index + 1 >= rest.length || rest[index + 1].startsWith('--')) return null;
    options[name] = rest[index + 1];
  }
  return options;
}

async function backupCommand(action, options, { env, platform, print }) {
  if (action === 'now') {
    const { made } = await request(env, platform, '/api/usage/backup/now', { method: 'POST', body: {}, timeoutMs: 120_000, notFound: NO_BACKUPS });
    print(`Saved the usage of ${plural(made.machines, 'machine')} (${plural(made.hours, 'hour')}) to ${made.path}.`);
    return;
  }
  let status = await request(env, platform, '/api/usage/backup', { notFound: NO_BACKUPS });
  if (action) {
    const body = { enabled: action === 'on', time: options['--time'] ?? status.time,
      keep: options['--keep'] === undefined ? status.keep : Number(options['--keep']),
      folder: options['--folder'] === undefined ? status.folder : options['--folder'] === 'default' ? '' : path.resolve(options['--folder']) };
    status = await request(env, platform, '/api/usage/backup/settings', { method: 'POST', body, notFound: NO_BACKUPS });
  }
  printStatus(status, print);
}

export async function main(args = process.argv.slice(2), { env = process.env, print = (line) => process.stdout.write(`${line}\n`),
  printError = (line) => process.stderr.write(`${line}\n`), platform = process.platform } = {}) {
  const [command, file, ...rest] = args;
  let task;
  if (command === 'backup') {
    const action = ['now', 'on', 'off'].includes(args[1]) ? args[1] : undefined;
    const words = args.slice(action ? 2 : 1);
    const options = backupOptions(words);
    if (!options || (!['on', 'off'].includes(action) && words.length)) { printError(usage); return 2; }
    if (options['--time'] !== undefined && !TIME.test(options['--time'])) { printError('asb usage: Use --time as HH:MM, for example 03:00.'); return 2; }
    if (options['--keep'] !== undefined && !(/^\d+$/.test(options['--keep']) && Number(options['--keep']) >= 1 && Number(options['--keep']) <= 30)) {
      printError('asb usage: Use --keep with a number from 1 to 30.');
      return 2;
    }
    task = () => backupCommand(action, options, { env, platform, print });
  } else {
    if (!['export', 'import'].includes(command) || !file || rest.length) { printError(usage); return 2; }
    task = () => (command === 'export' ? exportUsage : importUsage)(file, { env, platform, print });
  }
  try {
    await task();
    return 0;
  } catch (error) {
    printError(`asb usage: ${error.message}`);
    return error.exitCode || 1;
  }
}
