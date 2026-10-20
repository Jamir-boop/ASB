import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PLAYERS } from '../src/asb-sounds.mjs';
import { detectFamily, FAMILIES, installCommand, nodeRoute, parseOsRelease } from '../src/linux-distros.mjs';
import { atLeast, BOARD_FLOORS, boardCheck, engineCheck, pythonCandidates, shortVersion } from '../src/linux-system.mjs';
import { findExecutable, runtimeDir } from '../src/platform-paths.mjs';
import { autostartMarker, autostartPath, unitMarker, unitPath } from './asb-service.mjs';

// asb doctor (plan L5): it checks the system and prints the install commands. It never runs them.
const execFileAsync = promisify(execFileCallback);
const USAGE = 'Usage: asb doctor [--json]';
const GROUPS = ['Engine', 'Window', 'Options'];
// The needs in words, for systems without an install command.
const LABELS = { node: 'Node.js 20 or later', sqlite: 'sqlite3', openssl: 'openssl', xdg: 'xdg-utils', gi: 'PyGObject', gtk: 'GTK 4.12 or later',
  adw: 'Libadwaita 1.4 or later', gicairo: 'PyGObject cairo support', qrcode: 'Python qrcode', sound: PLAYERS.map(([name]) => name).join(' or ') };
const GENTOO_NOTE = 'Build gui-libs/gtk and gui-libs/libadwaita with USE=introspection, dev-python/pygobject with USE=cairo, '
  + 'and media-video/pipewire with USE=extra (for pw-play).';
const RESTART_NOTE = 'Restart the computer to use the new packages.';
const FLAKE_LINE = 'Use the flake: nix profile install github:Jamir-boop/ASB';

async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

// The engine can run when every Engine check is ok.
export const engineReady = (data) => data.checks.filter((check) => check.group === 'Engine').every((check) => check.status === 'ok');

export async function collect({ env = process.env, execFile = execFileAsync, read = readText, exists: present = exists, node } = {}) {
  const release = parseOsRelease(await read('/etc/os-release'));
  const { family, mode } = detectFamily(release, { ostreeBooted: await present('/run/ostree-booted') });
  const system = { name: release.PRETTY_NAME || release.NAME || 'Linux', id: release.ID || null, versionId: release.VERSION_ID || null, family, mode };
  const root = await findExecutable('doas', { env }) && !await findExecutable('sudo', { env }) ? 'doas' : 'sudo';
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
  const candidates = await pythonCandidates(env);
  const board = await boardCheck({ env, execFile, candidates });
  const versions = board.versions;
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
  const bun = await findExecutable('bun', { env });
  add('bun', 'Options', bun ? 'ok' : 'info', bun ? `Bun (${bun}), for ASB Bridge` : 'Bun: not found. ASB Bridge needs it.');
  // Doctor only reads the two autostart files (plan 12.1). A file counts when it has the ASB marker.
  const marked = async (file, marker) => (await read(file).catch(() => '')).split('\n').includes(marker);
  const unit = await marked(unitPath(env), unitMarker);
  const entry = await marked(autostartPath(env), autostartMarker);
  const autostart = unit ? 'systemd user service' : entry ? 'XDG autostart' : '';
  add('autostart', 'Options', autostart ? 'ok' : 'info', `Autostart: ${autostart || 'not installed'}`);
  const fallback = !(typeof env.XDG_RUNTIME_DIR === 'string' && path.posix.isAbsolute(env.XDG_RUNTIME_DIR));
  add('runtime', 'Options', fallback ? 'info' : 'ok', `Runtime folder: ${runtimeDir(env)}${fallback ? ' (XDG_RUNTIME_DIR is not set)' : ''}`);

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
