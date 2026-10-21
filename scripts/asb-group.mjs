import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { groupPath, parseJoinLink } from '../src/machine-group.mjs';
import { phoneTlsDir, tlsFiles } from '../src/phone-gateway.mjs';
import { bunNotFound } from '../src/platform-paths.mjs';
import { findRunningService, readServiceRuntime, requestInstance } from './asb-instance.mjs';

const usage = `Usage: asb group status [--json] | invite | join [<link>] [--name <name>] [--yes] | remove <name> | leave | reset-identity
       asb network status [--json] | enable <address>... | disable
       asb phone status [--json] | pair | remove <name> | remove --id <id>`;
const failure = (message, code = 1) => Object.assign(new Error(message), { exitCode: code });
const grouped = (fingerprint) => fingerprint.match(/.{1,4}/g).join(' ');

function parseArgs(args) {
  const [area, command, ...rest] = args;
  const plain = (count) => rest.length === count;
  if (area === 'group') {
    if (command === 'status' && (plain(0) || rest.join() === '--json')) return { area, command, json: rest.length === 1 };
    if (['invite', 'leave', 'reset-identity'].includes(command) && plain(0)) return { area, command };
    if (command === 'remove' && plain(1) && !rest[0].startsWith('--')) return { area, command, name: rest[0] };
    if (command === 'join') {
      // With no link, join asks for it (cmd.exe splits a typed link at each &).
      const hasLink = Boolean(rest[0]) && !rest[0].startsWith('--');
      const parsed = { area, command, link: hasLink ? rest[0] : '', name: '', yes: false };
      for (let index = hasLink ? 1 : 0; index < rest.length; index += 1) {
        if (rest[index] === '--yes' && !parsed.yes) parsed.yes = true;
        else if (rest[index] === '--name' && !parsed.name && rest[index + 1] && !rest[index + 1].startsWith('--')) parsed.name = rest[++index];
        else return null;
      }
      return parsed;
    }
  }
  if (area === 'phone') {
    if (command === 'status' && (plain(0) || rest.join() === '--json')) return { area, command, json: rest.length === 1 };
    if (command === 'pair' && plain(0)) return { area, command };
    if (command === 'remove' && plain(1) && !rest[0].startsWith('--')) return { area, command, name: rest[0] };
    if (command === 'remove' && plain(2) && rest[0] === '--id') return { area, command, id: rest[1] };
  }
  if (area === 'network') {
    if (command === 'status' && (plain(0) || rest.join() === '--json')) return { area, command, json: rest.length === 1 };
    if (command === 'disable' && plain(0)) return { area, command };
    if (command === 'enable' && rest.length && rest.every((item) => !item.startsWith('--'))) return { area, command, addresses: rest };
  }
  return null;
}

export async function api(runtime, route, options = {}) {
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

// The engine sends `relay` only for a group with another machine (src/machine-relay.mjs, status).
function relayText({ state, bunFolders = [] }) {
  if (state === 'running') return 'Message relay: running.';
  if (state === 'stopped') return 'Message relay: stopped after 5 restarts in 10 minutes.';
  return `Message relay: not running.${state === 'no-bun' ? ` ${bunNotFound(bunFolders)}` : ''}`;
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
    `Phones: ${value.phones.length ? value.phones.map((phone) => phone.name).join(', ') : 'none'}.`,
    ...(value.relay ? [relayText(value.relay)] : [])].join('\n');
}

export const networkText = (value) => !value.enabled ? 'Network access is off.'
  : `Network access is on, port ${value.port}: ${value.listening.length ? value.listening.map((item) => `${item.address} (${item.kind})`).join(', ')
    : 'not listening now'}.${value.error ? ` ${value.error}` : ''}`;

function phoneText(value) {
  const phones = value.devices.map((device) => `  ${device.name} (${device.id}): paired ${new Date(device.createdAtMs).toLocaleDateString()}, `
    + `last seen ${device.lastSeenAtMs ? new Date(device.lastSeenAtMs).toLocaleString() : 'never'}`);
  return [networkText(value), phones.length ? 'Paired phones:' : 'Paired phones: none.', ...phones].join('\n');
}

async function phone(runtime, parsed, print) {
  if (parsed.command === 'pair') {
    const value = await api(runtime, '/api/phone/pairing', { method: 'POST', body: {} });
    print([`Pairing link: ${value.uri}`, `The link works one time until ${new Date(value.expiresAtMs).toLocaleTimeString()}.`,
      'Scan it as a QR code or paste it in the ASB app on the phone.'].join('\n'));
    return;
  }
  const current = await api(runtime, '/api/phone');
  if (parsed.command === 'status') { print(parsed.json ? JSON.stringify(current) : phoneText(current)); return; }
  const matches = parsed.id !== undefined ? current.devices.filter((device) => device.id === parsed.id)
    : current.devices.filter((device) => device.name.toLowerCase() === parsed.name.toLowerCase());
  if (!matches.length) throw failure(parsed.id !== undefined ? `No phone with the ID ${parsed.id} is paired.` : `No phone named ${parsed.name} is paired.`);
  if (matches.length > 1) {
    throw failure(`More than one phone is named ${parsed.name}: ${matches.map((device) => device.id).join(', ')}. Use asb phone remove --id <id>.`);
  }
  await api(runtime, `/api/phone/devices/${matches[0].id}/revoke`, { method: 'POST', body: {} });
  print(`${matches[0].name} was removed.`);
}

// One reader for all questions of a command: its line iterator keeps a piped answer until the next question.
// The end of the input (Ctrl-D) gives an empty answer, which counts as no.
function questions(input, output) {
  let prompt = null;
  let lines = null;
  return {
    async ask(question) {
      if (!prompt) { prompt = createInterface({ input, terminal: false }); lines = prompt[Symbol.asyncIterator](); }
      output.write(question);
      try { const { value, done } = await lines.next(); return done ? '' : String(value).trim(); }
      catch { return ''; }
    },
    close: () => prompt?.close(),
  };
}

async function run(parsed, { env, input, output, print, platform }) {
  if (parsed.command === 'reset-identity') {
    if (await findRunningService(env, platform)) throw failure('Stop ASB first: asb engine stop.');
    if (await stat(groupPath(env)).then(() => true, () => false)) throw failure('Leave the group first: asb group leave.');
    for (const name of tlsFiles(platform)) await rm(path.join(phoneTlsDir(env, platform), name), { force: true });
    print('Identity reset. Paired phones must pair again.');
    return;
  }
  const runtime = await readServiceRuntime(env, platform);
  if (!runtime) throw failure('ASB is not running. Start it: asb engine start.');
  if (parsed.area === 'phone') { await phone(runtime, parsed, print); return; }
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
      'On the other machine, run: asb group join \'<link>\'', 'On Windows, run asb group join and paste the link when it asks.'].join('\n'));
  } else if (parsed.command === 'join') {
    const prompt = questions(input, output);
    let link;
    try {
      const text = parsed.link || await prompt.ask('Paste the join link: ');
      if (!text) throw failure('No join link.');
      // The engine checks the link fully; this parse only shows what the user must compare.
      link = parseJoinLink(text, { addressOk: () => true });
      if (!link) throw failure('This join link is not valid.');
      parsed.link = text;
      print(`Inviter: ${link.name}\nFingerprint: ${grouped(link.fingerprint)}`);
      if (!parsed.yes && !/^y(es)?$/i.test(await prompt.ask('Does the other machine show this fingerprint? [y/N] '))) throw failure('ASB did not join the group.');
    } finally { prompt.close(); }
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
  print = (line) => output.write(`${line}\n`), printError = (line) => process.stderr.write(`${line}\n`), platform = process.platform } = {}) {
  const parsed = parseArgs(args);
  if (!parsed) { printError(usage); return 2; }
  try { await run(parsed, { env, input, output, print, platform }); return 0; }
  catch (error) { printError(`asb ${parsed.area}: ${error.message}`); return error.exitCode || 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
