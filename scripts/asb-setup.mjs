import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { install, nextSteps, status } from './asb-bridge.mjs';
import { collect, engineReady, execFileAsync, firewallState, format, linuxFirewallLines, readText, rootCommand } from './asb-doctor.mjs';
import { main as engineMain } from './asb-engine.mjs';
import { api, networkText } from './asb-group.mjs';
import { findRunningService } from './asb-instance.mjs';
import { main as serviceMain } from './asb-service.mjs';

const usage = 'Usage: asb setup [--yes] [--only board|bridge] [--address <address>]...';
const failure = (message) => Object.assign(new Error(message), { exitCode: 1 });
const KIND_NAMES = { lan: 'home network', zerotier: 'ZeroTier', tailscale: 'Tailscale' };

function parseArgs(args) {
  const parsed = { yes: false, only: null, addresses: [] };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--yes' && !parsed.yes) parsed.yes = true;
    else if (args[index] === '--only' && !parsed.only && ['board', 'bridge'].includes(args[index + 1])) parsed.only = args[++index];
    else if (args[index] === '--address' && args[index + 1] && !args[index + 1].startsWith('--')) parsed.addresses.push(args[++index]);
    else return null;
  }
  return parsed.only === 'bridge' && parsed.addresses.length ? null : parsed;
}

export const firewallCommand = (addresses, port, node) => `New-NetFirewallRule -DisplayName "ASB engine" -Direction Inbound -Action Allow `
  + `-Protocol TCP -LocalPort ${port} -LocalAddress ${addresses.join(',')} -Program "${node}"`;

async function chooseAddresses(current, parsed, { ask, print }) {
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
  const answer = await ask(`Turn on network access for which addresses? Enter the numbers [${defaults}]: `);
  if (!answer) return fallback;
  const numbers = answer.split(/[\s,]+/).map(Number);
  if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > listed.length) || new Set(numbers).size !== numbers.length) {
    throw failure(`Enter numbers from 1 to ${listed.length}.`);
  }
  return numbers.map((number) => listed[number - 1]);
}

async function run(parsed, context) {
  const { env, platform, print, installService, installEngine, find, waitMs, node, doctor, execFile, read } = context;
  // 0. Check the system, as asb doctor does.
  if (platform === 'linux' || platform === 'win32') {
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
  } else if (platform === 'linux') {
    // Plan 13 step 4: the firewalld or ufw rule for the chosen addresses.
    const state = await firewallState({ execFile, readFile: read, env });
    const chosen = addresses.map((address) => current.addresses.find((item) => item.address === address));
    const { lines } = await linuxFirewallLines(state, chosen, saved.port, { execFile, root: await rootCommand(env), env });
    for (const line of lines) print(line);
  }
}

async function setupBridge({ bridgeStatus, bridgeInstall, print }) {
  let state;
  try { state = await bridgeStatus(); }
  catch (error) { throw failure(`ASB cannot check ASB Bridge: ${error.message}`); }
  if (!state.codex.length && !state.claude.detected && !state.opencode.detected) {
    print('ASB did not find Codex, Claude Code, or OpenCode on this PC. To install ASB Bridge later, run: asb setup --only bridge');
    return false;
  }
  let failed = false;
  let existing = false;
  const installed = { codex: false, claude: false, opencode: false };
  const warn = (home, message) => { print(`Warning: ${home}: ${message}`); failed = true; };
  for (const item of state.codex) {
    const home = item.home;
    if (item.plugin.installed) { print(`Codex ${home}: already installed`); existing = true; }
    else if (item.warning) warn(home, item.warning);
    else if (item.bunOnAppServerPath === false) warn(home, 'a running Codex cannot find Bun. Make Bun visible to desktop apps and restart Codex, then run asb setup --only bridge.');
    else {
      try {
        const result = (await bridgeInstall({ codexHomes: [home] })).codex[0];
        if (result.skipped) warn(home, result.warning);
        else if (result.installed) { print(`Codex ${home}: installed`); installed.codex = true; }
      } catch (error) { warn(home, error.message); }
    }
  }
  if (state.claude.detected) {
    const { home, skill } = state.claude;
    if (skill === 'ok' || skill === 'modified') { print(`Claude ${home}: already installed`); existing = true; }
    else if (skill === 'foreign') warn(home, 'skills/bridge is not from ASB. Setup does not change it.');
    else if (skill === 'missing') {
      try { await bridgeInstall({ claudeHome: home }); print(`Claude ${home}: installed`); installed.claude = true; }
      catch (error) { warn(home, error.message); }
    }
  }
  if (state.opencode.detected) {
    const { config, plugin, warning } = state.opencode;
    if (plugin === 'ok' || plugin === 'modified') { print(`OpenCode ${config}: already installed`); existing = true; }
    else if (plugin === 'foreign') warn(config, 'plugins/asb-bridge is not from ASB. Setup does not change it.');
    else if (plugin === 'missing' && warning) warn(config, warning);
    else if (plugin === 'missing') {
      try {
        const result = await bridgeInstall({ opencode: true, opencodeConfig: config });
        print(`OpenCode ${config}: installed ${result.opencode.version}`); installed.opencode = true;
      } catch (error) { warn(config, error.message); }
    }
  }
  if (Object.values(installed).some(Boolean)) for (const line of nextSteps(installed).split('\n')) print(line);
  if (existing) print('Setup does not change an existing ASB Bridge. To see its state, run: asb bridge status');
  return failed;
}

export async function main(args = process.argv.slice(2), { env = process.env, platform = process.platform, input = process.stdin,
  output = process.stdout, print = (line) => output.write(`${line}\n`), printError = (line) => process.stderr.write(`${line}\n`),
  installService = serviceMain, installEngine = (argv) => engineMain(argv, { platform, env }), find = findRunningService,
  node = process.execPath, waitMs = 20_000, doctor = () => collect({ env, platform, firewall: false }), execFile = execFileAsync, read = readText,
  bridgeStatus = () => status({ platform }), bridgeInstall = (options) => install({ platform, ...options }) } = {}) {
  const parsed = parseArgs(args);
  if (!parsed) { printError(usage); return 2; }
  let prompt;
  let answers;
  const ask = async (question) => {
    if (!prompt) {
      prompt = createInterface({ input, terminal: false });
      answers = prompt[Symbol.asyncIterator]();
    }
    output.write(question);
    try { return String((await answers.next()).value ?? '').trim(); }
    catch { return ''; }
  };
  try {
    let parts = parsed.only || 'both';
    if (!parsed.only && !parsed.yes) {
      for (const line of ['Set up which parts of ASB?', '  1. Board and bridge', '  2. Board only', '  3. Bridge only']) print(line);
      const answer = await ask('Enter a number [1]: ');
      if (answer && !['1', '2', '3'].includes(answer)) throw failure('Enter a number from 1 to 3.');
      parts = { 2: 'board', 3: 'bridge' }[answer] || 'both';
      if (parts === 'bridge' && parsed.addresses.length) throw failure('Bridge only does not use --address.');
    }
    if (parts !== 'bridge') await run(parsed, { env, platform, ask, print, installService, installEngine, find, waitMs, node, doctor, execFile, read });
    const failed = parts !== 'board' && await setupBridge({ bridgeStatus, bridgeInstall, print });
    if (parts === 'bridge') print('The board is not set up. To add it, run: asb setup --only board');
    else {
      if (parts === 'board') print('To add ASB Bridge later, run: asb setup --only bridge');
      print(platform === 'win32' ? 'On a machine in the group: asb group invite. Here: asb group join --name <name>, then paste the link.'
        : "On a machine in the group: asb group invite. Here: asb group join '<link>' --name <name>.");
    }
    if (failed) throw failure('ASB Bridge is not installed for every app. Fix the warnings above, then run asb setup --only bridge.');
    return 0;
  } catch (error) { printError(`asb setup: ${error.message}`); return error.exitCode || 1; }
  finally { prompt?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
