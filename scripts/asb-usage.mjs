// `asb usage export <file>` and `asb usage import <file>`: the permanent usage ledger of the running engine (src/usage-ledger.mjs).
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readServiceRuntime, requestInstance } from './asb-instance.mjs';

const usage = 'Usage: asb usage export <file> | import <file>';
const MAX_BYTES = 64 * 1024 * 1024;
const failure = (message) => Object.assign(new Error(message), { exitCode: 1 });
const number = (value) => value.toLocaleString('en-US');
const plural = (value, word) => `${number(value)} ${word}${value === 1 ? '' : 's'}`;

async function request(env, platform, route, options) {
  const runtime = await readServiceRuntime(env, platform);
  if (!runtime) throw failure('ASB is not running. Start it: asb engine start.');
  let reply;
  try { reply = await requestInstance(runtime, route, { timeoutMs: 60_000, ...options }); }
  catch (error) { throw failure(error.message); }
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

export async function main(args = process.argv.slice(2), { env = process.env, print = (line) => process.stdout.write(`${line}\n`),
  printError = (line) => process.stderr.write(`${line}\n`), platform = process.platform } = {}) {
  const [command, file, ...rest] = args;
  if (!['export', 'import'].includes(command) || !file || rest.length) { printError(usage); return 2; }
  try {
    await (command === 'export' ? exportUsage : importUsage)(file, { env, platform, print });
    return 0;
  } catch (error) {
    printError(`asb usage: ${error.message}`);
    return error.exitCode || 1;
  }
}
