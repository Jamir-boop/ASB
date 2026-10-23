import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PLAYERS } from '../src/asb-sounds.mjs';
import { detectFamily, FAMILIES, installCommand, nodeRoute, parseOsRelease } from '../src/linux-distros.mjs';
import { atLeast, BOARD_FLOORS, boardCheck, engineCheck, nodeFacts, pythonCandidates, shortVersion } from '../src/linux-system.mjs';
import { bunOnPath, findBun, findExecutable, runtimeDir } from '../src/platform-paths.mjs';
import { RUN_KEY } from './asb-engine.mjs';
import { api as groupApi } from './asb-group.mjs';
import { findRunningService } from './asb-instance.mjs';
import { autostartMarker, autostartPath, unitMarker, unitPath } from './asb-service.mjs';

// asb doctor (plan L5): it checks the system and prints the install commands. It never runs them.
export const execFileAsync = promisify(execFileCallback);
const USAGE = 'Usage: asb doctor [--json]';
const GROUPS = ['Engine', 'Window', 'Options'];
// The needs in words, for systems without an install command.
const LABELS = { node: 'Node.js 20 or later', sqlite: 'sqlite3', openssl: 'openssl', xdg: 'xdg-utils', gi: 'PyGObject', gtk: 'GTK 4.12 or later',
  adw: 'Libadwaita 1.4 or later', gicairo: 'PyGObject cairo support', qrcode: 'Python qrcode', sound: PLAYERS.map(([name]) => name).join(' or ') };
const GENTOO_NOTE = 'Build gui-libs/gtk and gui-libs/libadwaita with USE=introspection, dev-python/pygobject with USE=cairo, '
  + 'and media-video/pipewire with USE=extra (for pw-play).';
const RESTART_NOTE = 'Restart the computer to use the new packages.';
const FLAKE_LINE = 'Use the flake: nix profile install github:Jamir-boop/ASB';
// The firewall lines go into a root shell, so only these names get a command (plan 13 step 6).
const INTERFACE_NAME = /^[A-Za-z0-9._@-]{1,15}$/;
const ZONE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// The Windows board runs on MSYS2 UCRT64. The board Python gives the MSYS2 folder, else it is the default folder of MSYS2_PYTHON (src/linux-system.mjs).
// MSYS2 does not support a folder with a space, so the pacman command has no quotes.
const MSYS2_ROOT = 'C:\\msys64';
const MSYS2_PYTHON_FILE = /^(.+)\\ucrt64\\bin\\python\.exe$/i;
const WINGET_MSYS2 = ['winget', 'install', '--id', 'MSYS2.MSYS2', '-e'];
const MSYS2_PACKAGES = ['mingw-w64-ucrt-x86_64-python-gobject', 'mingw-w64-ucrt-x86_64-gtk4', 'mingw-w64-ucrt-x86_64-libadwaita'];

export async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

// The root command for the printed commands: doas only when doas is found and sudo is not.
export const rootCommand = async (env = process.env) => await findExecutable('doas', { env }) && !await findExecutable('sudo', { env }) ? 'doas' : 'sudo';

// A word with a space or a quote gets single quotes, after its `--name=` part.
const shellWord = (word) => /[\s'"]/.test(word)
  ? word.replace(/^(--[A-Za-z-]+=)?([^]*)$/, (match, flag = '', rest) => `${flag}'${rest.replaceAll("'", "'\\''")}'`) : word;
export const shellText = (words) => words.map(shellWord).join(' ');

// Plan 13 step 1: the active firewall. A missing program or file means "not this firewall".
export async function firewallState({ execFile = execFileAsync, readFile = readText, env = process.env } = {}) {
  try {
    if (String((await execFile('firewall-cmd', ['--state'], { env, timeout: 5000 })).stdout).trim() === 'running') return 'firewalld';
  } catch {}
  let conf = '';
  try { conf = String(await readFile('/etc/ufw/ufw.conf')); } catch {}
  return conf.split('\n').some((line) => line.trim() === 'ENABLED=yes') ? 'ufw' : 'none';
}

// Plan 13 step 2: the rules for the addresses ({ address, interface }) as arrays of words, and the text lines. ASB only prints them.
export async function linuxFirewallLines(state, addresses, port, { execFile = execFileAsync, root = 'sudo', env = process.env } = {}) {
  const commands = [];
  const notes = [];
  if (state !== 'firewalld' && state !== 'ufw') return { commands, lines: [] };
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65535;
  for (const { address, interface: name } of addresses) {
    const usual = portOk && net.isIPv4(address) && typeof name === 'string' && INTERFACE_NAME.test(name);
    let zone = '';
    // A failed zone query (no zone) gives the rule without --zone.
    if (usual && state === 'firewalld') {
      try { zone = String((await execFile('firewall-cmd', [`--get-zone-of-interface=${name}`], { env, timeout: 5000 })).stdout).trim(); } catch {}
    }
    if (!usual || (zone && !ZONE_NAME.test(zone))) {
      notes.push(`ASB found an unusual interface or zone name, so it prints no firewall command for ${address}.`);
      continue;
    }
    commands.push(state === 'ufw' ? [root, 'ufw', 'allow', 'in', 'on', name, 'to', address, 'port', String(port), 'proto', 'tcp']
      : [root, 'firewall-cmd', '--permanent', ...(zone ? [`--zone=${zone}`] : []),
        `--add-rich-rule=rule family="ipv4" destination address="${address}" port port="${port}" protocol="tcp" accept`]);
  }
  if (state === 'firewalld' && commands.length) commands.push([root, 'firewall-cmd', '--reload']);
  const lines = commands.length || notes.length
    ? [`Phone access and machine links through ${state}:`, ...commands.map((words) => `  ${shellText(words)}`), ...notes] : [];
  return { commands, lines };
}

// The engine can run when every Engine check is ok.
export const engineReady = (data) => data.checks.filter((check) => check.group === 'Engine').every((check) => check.status === 'ok');

// The Window group rows, the same on Linux and Windows. It returns the keys of the missing packages and whether GTK or Libadwaita is too old.
function windowChecks(add, board, candidates) {
  const versions = board.versions;
  const required = [];
  const where = versions ? `Python ${versions.python}, ${board.python}` : '';
  if (!versions) add('python', 'Window', 'missing', candidates.length ? `Python 3 (${candidates.join(', ')} does not run)` : 'Python 3');
  else if (!atLeast(versions.python, BOARD_FLOORS.python)) add('python', 'Window', 'old', `Python ${versions.python} (${board.python}), needs 3.9 or later`);
  add('gi', 'Window', versions?.gi ? 'ok' : 'missing', versions?.gi ? `PyGObject ${versions.gi} (${where})` : versions ? `PyGObject (${where})` : 'PyGObject');
  if (!versions?.gi) required.push('gi');
  const library = (id, label, value, floor, missingLabel) => {
    if (!value) { add(id, 'Window', 'missing', missingLabel); return 'missing'; }
    const old = !atLeast(value, floor);
    add(id, 'Window', old ? 'old' : 'ok', `${label} ${value.join('.')}${old ? `, needs ${floor.join('.')} or later` : ''}`);
    return old ? 'old' : 'ok';
  };
  const gtk = library('gtk', 'GTK', versions?.gtk, BOARD_FLOORS.gtk, 'GTK 4');
  const adw = library('adw', 'Libadwaita', versions?.adw, BOARD_FLOORS.adw, 'Libadwaita');
  const librariesOld = gtk === 'old' || adw === 'old';
  if (!librariesOld) required.push(...[gtk === 'missing' && 'gtk', adw === 'missing' && 'adw'].filter(Boolean));
  return { required, librariesOld };
}

async function bunCheck(add, env, platform) {
  // The engine's lookup. A Codex task runs bun from the PATH of Codex, so a Bun in the standard folder only is still ok but is named.
  const bun = await findBun({ env, platform });
  const onPath = bun !== '' && bun === await bunOnPath({ env, platform });
  add('bun', 'Options', bun ? 'ok' : 'info', !bun ? 'Bun: not found. ASB Bridge needs it.' : onPath ? `Bun (${bun}), for ASB Bridge`
    : `Bun (${bun}), not on PATH. The message relay finds it. A Codex task needs it on PATH.`);
}

// Windows needs Node.js with built-in SQLite for the engine, and MSYS2 Python with PyGObject, GTK, and Libadwaita for the window.
async function collectWindows({ env, execFile, exists: present, node, platform }) {
  const system = { name: os.version() || 'Windows', id: null, versionId: os.release(), family: 'windows', mode: 'normal' };
  const checks = [];
  const add = (id, group, status, detail) => checks.push({ id, group, status, detail });

  // Engine
  const facts = node === undefined ? await nodeFacts() : node;
  if (!facts) add('node', 'Engine', 'missing', 'Node.js');
  else add('node', 'Engine', facts.sqlite ? 'ok' : 'old',
    `Node.js ${facts.version} (${facts.path}), ${facts.sqlite ? 'built-in SQLite' : 'needs 22.13 or later with built-in SQLite'}`);

  // Window
  const candidates = await pythonCandidates(env, { platform });
  const board = await boardCheck({ env, execFile, candidates });
  const { librariesOld } = windowChecks(add, board, candidates);

  // Options
  const qrcode = board.versions?.qrcode;
  add('qrcode', 'Options', qrcode ? 'ok' : 'info', qrcode ? 'QR code' : 'QR code: not available (MSYS2 has no Python qrcode package)');
  await bunCheck(add, env, platform);
  let autostart = true;
  try { await execFile('reg', ['query', RUN_KEY, '/v', 'ASB'], { env, timeout: 5000 }); } catch { autostart = false; }
  add('autostart', 'Options', autostart ? 'ok' : 'info', `Autostart: ${autostart ? 'Windows Run value' : 'not installed'}`);

  // Commands. ASB only prints them. Old libraries need -Syu, because pacman does not support a partial update.
  const commands = { required: null, optional: null, node: null, firewall: [], msys2: null };
  const advice = [];
  if (!board.ok) {
    const root = [board.python, ...candidates].map((file) => MSYS2_PYTHON_FILE.exec(file ?? '')?.[1]).find(Boolean) ?? MSYS2_ROOT;
    const pacman = `${root}\\usr\\bin\\pacman.exe`;
    commands.required = [pacman, librariesOld ? '-Syu' : '-S', '--needed', ...MSYS2_PACKAGES];
    if (!await present(pacman)) commands.msys2 = WINGET_MSYS2;
    advice.push(commands.msys2 ? 'Install MSYS2 and the board packages:' : 'Install the board packages:', ...[commands.msys2, commands.required].filter(Boolean).map((words) => `  ${words.join(' ')}`));
  }
  return { schema: 1, system, checks, board: { ok: board.ok, reason: board.reason }, commands, advice };
}

// `firewall: false` leaves out the firewall part (asb setup step 0).
export async function collect({ env = process.env, execFile = execFileAsync, read = readText, exists: present = exists, node,
  find = findRunningService, api = (runtime, route) => groupApi(runtime, route, { timeoutMs: 2000 }), firewall = true, platform = process.platform } = {}) {
  if (platform === 'win32') return collectWindows({ env, execFile, exists: present, node, platform });
  const release = parseOsRelease(await read('/etc/os-release'));
  const { family, mode } = detectFamily(release, { ostreeBooted: await present('/run/ostree-booted') });
  const system = { name: release.PRETTY_NAME || release.NAME || 'Linux', id: release.ID || null, versionId: release.VERSION_ID || null, family, mode };
  const root = await rootCommand(env);
  const checks = [];
  const add = (id, group, status, detail) => checks.push({ id, group, status, detail });
  const required = [];
  const optional = [];

  // Engine
  const engine = await engineCheck({ env, node });
  const facts = engine.node;
  const nodeOld = Boolean(facts) && !atLeast(facts.version, [20, 0]);
  if (!facts) add('node', 'Engine', 'missing', 'Node.js');
  else add('node', 'Engine', nodeOld ? 'old' : 'ok', `Node.js ${facts.version} (${facts.path})${nodeOld ? ', needs 20 or later'
    : facts.sqlite ? ', built-in SQLite' : ''}`);
  if (!facts?.sqlite) {
    add('sqlite3', 'Engine', engine.sqlite3 ? 'ok' : 'missing', engine.sqlite3 ? `sqlite3 (${engine.sqlite3})` : 'sqlite3');
    if (!engine.sqlite3) required.push('sqlite');
  }
  if (engine.openssl) {
    let version = '';
    // `OpenSSL 3.5.1 1 Jul 2025`: the second word is the version. When it does not run, doctor shows the path.
    try { version = String((await execFile(engine.openssl, ['version'], { env, timeout: 5000 })).stdout).trim().split(/\s+/)[1] || ''; } catch {}
    add('openssl', 'Engine', 'ok', version ? `openssl ${version}` : `openssl (${engine.openssl})`);
  } else { add('openssl', 'Engine', 'missing', 'openssl'); required.push('openssl'); }
  add('xdg-open', 'Engine', engine.xdgOpen ? 'ok' : 'missing', engine.xdgOpen ? `xdg-open (${engine.xdgOpen})` : 'xdg-open');
  if (!engine.xdgOpen) required.push('xdg');

  // Window
  const candidates = await pythonCandidates(env, { platform });
  const board = await boardCheck({ env, execFile, candidates });
  const versions = board.versions;
  const { required: windowRequired, librariesOld } = windowChecks(add, board, candidates);
  required.push(...windowRequired);

  // Options
  const qrMissing = [!versions?.qrcode && 'Python qrcode', versions?.gi && !versions.cairo && 'PyGObject cairo support'].filter(Boolean);
  add('qrcode', 'Options', qrMissing.length ? 'missing' : 'ok', qrMissing.length ? `QR code (${qrMissing.join(', ')})` : 'QR code');
  if (!versions?.cairo) optional.push('gicairo');
  if (!versions?.qrcode) optional.push('qrcode');
  let player = '';
  for (const [name] of PLAYERS) if (!player && await findExecutable(name, { env })) player = name;
  add('sounds', 'Options', player ? 'ok' : 'missing', player ? `Sounds (${player})` : `Sounds (${PLAYERS.map(([name]) => name).join(' or ')})`);
  if (!player) optional.push('sound');
  const trayHost = versions?.trayHost;
  add('tray', 'Options', trayHost ? 'ok' : 'info', trayHost ? 'Tray host'
    : trayHost === false ? 'Tray host: none found. On GNOME, add the AppIndicator extension.' : 'Tray host: not checked (needs PyGObject and a session bus)');
  await bunCheck(add, env, platform);
  // Doctor only reads the two autostart files (plan 12.1). A file counts when it has the ASB marker.
  const marked = async (file, marker) => (await read(file).catch(() => '')).split('\n').includes(marker);
  const unit = await marked(unitPath(env), unitMarker);
  const entry = await marked(autostartPath(env), autostartMarker);
  const autostart = unit ? 'systemd user service' : entry ? 'XDG autostart' : '';
  add('autostart', 'Options', autostart ? 'ok' : 'info', `Autostart: ${autostart || 'not installed'}`);
  const fallback = !(typeof env.XDG_RUNTIME_DIR === 'string' && path.posix.isAbsolute(env.XDG_RUNTIME_DIR));
  add('runtime', 'Options', fallback ? 'info' : 'ok', `Runtime folder: ${runtimeDir(env)}${fallback ? ' (XDG_RUNTIME_DIR is not set)' : ''}`);
  // Plan 15: the desktop file for the codex: and claude: links. A failed query or a missing xdg-mime means "no handler".
  const apps = ['codex', 'claude'];
  const handlers = await Promise.all(apps.map(async (app) => {
    try { return String((await execFile('xdg-mime', ['query', 'default', `x-scheme-handler/${app}`], { env, timeout: 5000 })).stdout).split('\n')[0].trim(); } catch { return ''; }
  }));
  add('links', 'Options', handlers.every(Boolean) ? 'ok' : 'info',
    `Links: ${apps.map((app, index) => `${app}: ${handlers[index] || `none: ASB cannot open ${app} sessions until the app handles ${app}: links`}`).join(', ')}`);

  // Commands (plan 10.2). ASB only prints them.
  const route = !facts || nodeOld ? nodeRoute(release, family, { mode }) : null;
  const nodeCommand = route?.command ? [root, ...route.command] : null;
  if (!facts && !nodeCommand) required.unshift('node');
  // A key without a package in the table comes with another package of the family.
  for (const keys of [required, optional]) {
    const packages = FAMILIES[family]?.packages;
    if (packages) keys.splice(0, keys.length, ...keys.filter((key) => packages[key] !== null));
  }
  const command = (keys) => keys.length ? installCommand(family, keys, { mode, root }) : null;
  const commands = { required: command(required), optional: command(optional), node: nodeCommand, firewall: [] };
  const advice = [];
  // A command when the family has one, else the needs in words.
  const text = (words, keys) => words ? words.join(' ') : keys.map((key) => LABELS[key]).join(', ');
  const install = [];
  if (!facts && nodeCommand) install.push(`  ${nodeCommand.join(' ')}`);
  if (required.length) install.push(`  ${text(commands.required, required)}`);
  if (install.length) advice.push('Install the missing packages:', ...install);
  if (!facts && route?.text) advice.push('If this Node.js is older than 20:', `  ${route.text}`);
  if (nodeOld) {
    if (!route) commands.node = command(['node']);
    advice.push(`Node.js ${facts.version} is older than 20. Install Node.js 20 or later:`, `  ${route?.text || text(commands.node, ['node'])}`);
  }
  if (librariesOld) {
    const name = (value) => value ? shortVersion(value) : 'none';
    advice.push(`This system has GTK ${name(versions.gtk)} and Libadwaita ${name(versions.adw)}. The ASB window needs GTK 4.12 and Libadwaita 1.4, `
      + 'so ASB runs without its window. The phone and your other machines still show this machine\'s sessions.');
  }
  if (optional.length) advice.push('Optional:', `  ${text(commands.optional, optional)}`);
  const anyCommand = Boolean(commands.required || commands.optional || commands.node);
  if (family === 'gentoo' && anyCommand) advice.push(GENTOO_NOTE);
  if (mode === 'transactional' && anyCommand) advice.push(RESTART_NOTE);
  if (family === 'nixos' && (required.length || optional.length || nodeOld)) advice.push(FLAKE_LINE);
  // Plan 13 step 3: the firewall lines for the selected addresses of the running engine. A failed request gives no lines.
  let phone = null;
  if (firewall) {
    try { const runtime = await find(env); phone = runtime ? await api(runtime, '/api/phone') : null; } catch {}
  }
  if (phone?.enabled === true && Array.isArray(phone.bindAddresses) && Array.isArray(phone.addresses)) {
    const entries = phone.bindAddresses.map((address) => phone.addresses.find((item) => item.address === address)).filter(Boolean);
    if (entries.length) {
      const state = await firewallState({ execFile, readFile: read, env });
      const { commands: rules, lines } = await linuxFirewallLines(state, entries, phone.port, { execFile, root, env });
      commands.firewall = rules;
      advice.push(...lines);
    }
  }
  return { schema: 1, system, checks, board: { ok: board.ok, reason: board.reason }, commands, advice };
}

export function format(data) {
  const { name, family, mode } = data.system;
  const lines = [`ASB doctor: ${name}, family ${family ?? 'unknown'}${mode === 'normal' ? '' : `, ${mode}`}`, ''];
  for (const group of GROUPS) {
    const rows = data.checks.filter((check) => check.group === group);
    if (rows.length) lines.push(group, ...rows.map((check) => `  ${check.status.padEnd(9)}${check.detail}`));
  }
  if (data.advice.length) lines.push('', ...data.advice);
  return lines;
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error, ...deps } = {}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--json')) { error(USAGE); return 2; }
  const data = await collect(deps);
  if (argv[0] === '--json') {
    const { schema, system, checks, board, commands } = data;
    log(JSON.stringify({ schema, system, checks, board, commands }, null, 2));
  } else for (const line of format(data)) log(line);
  return engineReady(data) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
