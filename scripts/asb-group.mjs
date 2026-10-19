import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { groupPath, parseJoinLink } from '../src/machine-group.mjs';
import { phoneTlsDir } from '../src/phone-gateway.mjs';
import { findRunningService, readServiceRuntime, requestInstance } from './asb-instance.mjs';

const usage = `Usage: asb group status [--json] | invite | join <link> [--name <name>] [--yes] | remove <name> | leave | reset-identity
       asb network status [--json] | enable <address>... | disable`;
const failure = (message, code = 1) => Object.assign(new Error(message), { exitCode: code });
const grouped = (fingerprint) => fingerprint.match(/.{1,4}/g).join(' ');

function parseArgs(args) {
  const [area, command, ...rest] = args;
  const plain = (count) => rest.length === count;
  if (area === 'group') {
    if (command === 'status' && (plain(0) || rest.join() === '--json')) return { area, command, json: rest.length === 1 };
    if (['invite', 'leave', 'reset-identity'].includes(command) && plain(0)) return { area, command };
    if (command === 'remove' && plain(1) && !rest[0].startsWith('--')) return { area, command, name: rest[0] };
    if (command === 'join' && rest[0] && !rest[0].startsWith('--')) {
      const parsed = { area, command, link: rest[0], name: '', yes: false };
      for (let index = 1; index < rest.length; index += 1) {
        if (rest[index] === '--yes' && !parsed.yes) parsed.yes = true;
        else if (rest[index] === '--name' && !parsed.name && rest[index + 1] && !rest[index + 1].startsWith('--')) parsed.name = rest[++index];
        else return null;
      }
      return parsed;
    }
  }
  if (area === 'network') {
    if (command === 'status' && (plain(0) || rest.join() === '--json')) return { area, command, json: rest.length === 1 };
    if (command === 'disable' && plain(0)) return { area, command };
    if (command === 'enable' && rest.length && rest.every((item) => !item.startsWith('--'))) return { area, command, addresses: rest };
  }
  return null;
}

async function api(runtime, route, options = {}) {
  let reply;
  try { reply = await requestInstance(runtime, route, { timeoutMs: 15_000, ...options }); }
  catch (error) { throw failure(error.message); }
  if (reply.statusCode !== 200) {
    const error = failure(typeof reply.body?.error === 'string' ? reply.body.error : `ASB returned HTTP ${reply.statusCode}.`);
    if (typeof reply.body?.suggestion === 'string') error.suggestion = reply.body.suggestion;
    throw error;
  }
  return reply.body;
}

function groupText(value) {
  if (!value.groupId) {
    return [`This machine is not in a group. Its suggested name is ${value.self.name}.`,
      `Network access: ${value.networkEnabled ? 'on' : 'off'}.`].join('\n');
  }
  const members = value.members.map((member) => `  ${member.name} (${member.machineId.slice(0, 8)}): ${member.isSelf ? 'this machine'
    : member.online ? 'online' : `offline${member.lastOkAtMs ? `, last seen ${new Date(member.lastOkAtMs).toLocaleString()}` : ''}`}`
    + ` ${member.addresses.map((item) => `${item.kind}:${item.address}`).join(', ')}`);
  return [`Group ${value.groupId}. This machine: ${value.self.name} (${value.self.machineId.slice(0, 8)}).`,
    `Network access: ${value.networkEnabled ? 'on' : 'off'}.`, 'Machines:', ...members,
    `Phones: ${value.phones.length ? value.phones.map((phone) => phone.name).join(', ') : 'none'}.`].join('\n');
}

const networkText = (value) => !value.enabled ? 'Network access is off.'
  : `Network access is on, port ${value.port}: ${value.listening.length ? value.listening.map((item) => `${item.address} (${item.kind})`).join(', ')
    : 'not listening now'}.${value.error ? ` ${value.error}` : ''}`;

// The end of the input (Ctrl-D) counts as no.
async function confirm(input, output, question) {
  const prompt = createInterface({ input, output, terminal: false });
  const closed = new Promise((resolve) => prompt.once('close', () => resolve('')));
  try { return /^y(es)?$/i.test(String(await Promise.race([prompt.question(question), closed])).trim()); }
  catch { return false; }
  finally { prompt.close(); }
}

async function run(parsed, { env, input, output, print }) {
  if (parsed.command === 'reset-identity') {
    if (await findRunningService(env)) throw failure('Stop ASB first: asb engine stop.');
    if (await stat(groupPath(env)).then(() => true, () => false)) throw failure('Leave the group first: asb group leave.');
    for (const name of ['key.pem', 'cert.pem']) await rm(path.join(phoneTlsDir(env), name), { force: true });
    print('Identity reset. Paired phones must pair again.');
    return;
  }
  const runtime = await readServiceRuntime(env);
  if (!runtime) throw failure('ASB is not running. Start it: asb engine start.');
  if (parsed.area === 'network') {
    const current = await api(runtime, '/api/phone');
    if (parsed.command === 'status') { print(parsed.json ? JSON.stringify(current) : networkText(current)); return; }
    const listed = current.addresses.map((item) => item.address);
    if (parsed.command === 'enable') {
      const missing = parsed.addresses.filter((address) => !listed.includes(address));
      if (missing.length || new Set(parsed.addresses).size !== parsed.addresses.length) {
        throw failure(`Choose network addresses on this PC: ${listed.join(', ') || 'none found'}.`);
      }
    }
    const body = parsed.command === 'enable' ? { enabled: true, bindAddresses: parsed.addresses, port: current.port }
      // The server accepts only addresses that are on this PC now.
      : { enabled: false, bindAddresses: current.bindAddresses.filter((address) => listed.includes(address)), port: current.port };
    print(networkText(await api(runtime, '/api/phone/settings', { method: 'POST', body })));
    return;
  }
  if (parsed.command === 'status') {
    const value = await api(runtime, '/api/group');
    print(parsed.json ? JSON.stringify(value) : groupText(value));
  } else if (parsed.command === 'invite') {
    const value = await api(runtime, '/api/group/invite', { method: 'POST', body: {} });
    print([`Join link: ${value.link}`, `Fingerprint: ${grouped(value.fingerprint)}`,
      `The link works one time until ${new Date(value.expiresAtMs).toLocaleTimeString()}.`,
      'On the other machine, run: asb group join \'<link>\''].join('\n'));
  } else if (parsed.command === 'join') {
    // The engine checks the link fully; this parse only shows what the user must compare.
    const link = parseJoinLink(parsed.link, { addressOk: () => true });
    if (!link) throw failure('This join link is not valid.');
    print(`Inviter: ${link.name}\nFingerprint: ${grouped(link.fingerprint)}`);
    if (!parsed.yes && !await confirm(input, output, 'Does the other machine show this fingerprint? [y/N] ')) throw failure('ASB did not join the group.');
    try { await api(runtime, '/api/group/join', { method: 'POST', body: { link: parsed.link, name: parsed.name }, timeoutMs: 60_000 }); }
    catch (error) {
      if (error.suggestion) error.message += ` Use another name, for example: --name ${error.suggestion}`;
      throw error;
    }
    print(`This machine joined the group of ${link.name}.`);
  } else if (parsed.command === 'remove') {
    const value = await api(runtime, '/api/group');
    const member = value.members.find((item) => item.name.toLowerCase() === parsed.name.toLowerCase());
    if (!member) throw failure(`No machine named ${parsed.name} is in the group.`);
    await api(runtime, '/api/group/remove', { method: 'POST', body: { machineId: member.machineId } });
    print(`${member.name} was removed from the group.`);
  } else {
    await api(runtime, '/api/group/leave', { method: 'POST', body: {}, timeoutMs: 30_000 });
    print('This machine left the group.');
  }
}

export async function main(args = process.argv.slice(2), { env = process.env, input = process.stdin, output = process.stdout,
  print = (line) => output.write(`${line}\n`), printError = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const parsed = parseArgs(args);
  if (!parsed) { printError(usage); return 2; }
  try { await run(parsed, { env, input, output, print }); return 0; }
  catch (error) { printError(`asb ${parsed.area}: ${error.message}`); return error.exitCode || 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
