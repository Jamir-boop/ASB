import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { collect, engineReady, format } from './asb-doctor.mjs';
import { main as engineMain } from './asb-engine.mjs';
import { api, networkText } from './asb-group.mjs';
import { findRunningService } from './asb-instance.mjs';
import { main as serviceMain } from './asb-service.mjs';

const usage = 'Usage: asb setup [--yes] [--address <address>]...';
const failure = (message) => Object.assign(new Error(message), { exitCode: 1 });
const KIND_NAMES = { lan: 'home network', zerotier: 'ZeroTier', tailscale: 'Tailscale' };

function parseArgs(args) {
  const parsed = { yes: false, addresses: [] };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--yes' && !parsed.yes) parsed.yes = true;
    else if (args[index] === '--address' && args[index + 1] && !args[index + 1].startsWith('--')) parsed.addresses.push(args[++index]);
    else return null;
  }
  return parsed;
}

// The end of the input (Ctrl-D) gives an empty answer.
async function ask(input, output, question) {
  const prompt = createInterface({ input, output, terminal: false });
  const closed = new Promise((resolve) => prompt.once('close', () => resolve('')));
  try { return String(await Promise.race([prompt.question(question), closed])).trim(); }
  catch { return ''; }
  finally { prompt.close(); }
}

export const firewallCommand = (addresses, port, node) => `New-NetFirewallRule -DisplayName "ASB engine" -Direction Inbound -Action Allow `
  + `-Protocol TCP -LocalPort ${port} -LocalAddress ${addresses.join(',')} -Program "${node}"`;

async function chooseAddresses(current, parsed, { input, output, print }) {
  const listed = current.addresses.map((item) => item.address);
  if (!listed.length) throw failure('No private network address is on this PC. Connect to a network, then run asb setup again.');
  if (parsed.addresses.length) {
    if (parsed.addresses.some((address) => !listed.includes(address)) || new Set(parsed.addresses).size !== parsed.addresses.length) {
      throw failure(`Choose network addresses on this PC: ${listed.join(', ')}.`);
    }
    return parsed.addresses;
  }
  const kept = current.enabled ? current.bindAddresses.filter((address) => listed.includes(address)) : [];
  const fallback = kept.length ? kept : [(current.addresses.find((item) => item.kind === 'lan') || current.addresses[0]).address];
  if (parsed.yes) return fallback;
  print('Network addresses on this PC:');
  current.addresses.forEach((item, index) => print(`  ${index + 1}. ${item.address} (${KIND_NAMES[item.kind] || item.kind}, ${item.interface})`));
  const defaults = fallback.map((address) => listed.indexOf(address) + 1).join(' ');
  const answer = await ask(input, output, `Turn on network access for which addresses? Enter the numbers [${defaults}]: `);
  if (!answer) return fallback;
  const numbers = answer.split(/[\s,]+/).map(Number);
  if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > listed.length) || new Set(numbers).size !== numbers.length) {
    throw failure(`Enter numbers from 1 to ${listed.length}.`);
  }
  return numbers.map((number) => listed[number - 1]);
}

async function run(parsed, context) {
  const { env, platform, print, installService, installEngine, find, waitMs, node, doctor } = context;
  // 0. Check the system, as asb doctor does.
  if (platform === 'linux') {
    const data = await doctor();
    for (const line of format(data)) print(line);
    if (!engineReady(data)) throw failure('The ASB engine cannot run on this system. Install the missing packages, then run asb setup again.');
  }
  // 1. Autostart, then wait for the engine.
  const code = platform === 'win32' ? await installEngine(['install']) : await installService(['install']);
  if (code) throw failure('ASB cannot install its autostart.');
  let runtime = null;
  for (const deadline = Date.now() + waitMs; !(runtime = await find(env, platform)) && Date.now() < deadline;) await delay(200);
  if (!runtime) throw failure('The ASB engine does not answer. Check asb engine status.');
  // 2. Network access, as asb network enable does.
  const current = await api(runtime, '/api/phone');
  const addresses = await chooseAddresses(current, parsed, context);
  const saved = await api(runtime, '/api/phone/settings', { method: 'POST', body: { enabled: true, bindAddresses: addresses, port: current.port } });
  print(networkText(saved));
  // 3. Plan P15: ASB prints the firewall rule and never runs it.
  if (platform === 'win32') {
    print('Run this command in an administrator PowerShell to let other machines and phones reach ASB:');
    print(`  ${firewallCommand(addresses, saved.port, node)}`);
    print('Windows can already allow node.exe on private networks; then this rule is not needed.');
  }
  // 4. The bridge, and 5. the group.
  print(platform === 'win32' ? 'The bridge is not available on Windows yet.' : 'To let agents send messages, run: asb bridge install --all');
  print(platform === 'win32' ? 'On a machine in the group: asb group invite. Here: asb group join --name <name>, then paste the link.'
    : "On a machine in the group: asb group invite. Here: asb group join '<link>' --name <name>.");
}

export async function main(args = process.argv.slice(2), { env = process.env, platform = process.platform, input = process.stdin,
  output = process.stdout, print = (line) => output.write(`${line}\n`), printError = (line) => process.stderr.write(`${line}\n`),
  installService = serviceMain, installEngine = (argv) => engineMain(argv, { platform, env }), find = findRunningService,
  node = process.execPath, waitMs = 20_000, doctor = () => collect({ env }) } = {}) {
  const parsed = parseArgs(args);
  if (!parsed) { printError(usage); return 2; }
  try {
    await run(parsed, { env, platform, input, output, print, installService, installEngine, find, waitMs, node, doctor });
    return 0;
  } catch (error) { printError(`asb setup: ${error.message}`); return error.exitCode || 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
