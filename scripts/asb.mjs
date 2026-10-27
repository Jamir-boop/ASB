#!/usr/bin/env node
// The one ASB command (plan 14.1). npm links it as `asb`; the POSIX launcher scripts/asb runs it after it finds Node.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NODE_HINT = 'ASB needs Node.js 20 or later and built-in SQLite or the sqlite3 command. Node.js 22.13 or later is recommended. '
  + 'Set ASB_NODE to its absolute executable path. Install help: https://github.com/Jamir-boop/ASB#nodejs';
export const WINDOWS_USAGE = 'Usage: asb [engine|agent|bridge|group|network|phone|usage|setup|doctor] ... '
  + 'Usage: asb usage export <file> | import <file> | backup [now | on | off] [--time HH:MM] [--keep N] [--folder <path>|default]';
export const LINUX_USAGE = 'Usage: asb [engine|agent|bridge|group|network|phone|usage|setup|service|doctor] ... With no command, asb opens the board. '
  + 'Usage: asb usage export <file> | import <file> | backup [now | on | off] [--time HH:MM] [--keep N] [--folder <path>|default]';

// The engine needs node:sqlite, and the sqlite3 command is rarely on Windows.
export const windowsNodeOk = (version) => {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
};

// Each command keeps the error text of its own script file.
const caught = (prefix, run) => run().catch((error) => { console.error(`${prefix}${error.message}`); return 1; });

export async function main(argv = process.argv.slice(2), { platform = process.platform, version = process.versions.node,
  load = (file) => import(file), error = console.error } = {}) {
  if (platform === 'win32' && !windowsNodeOk(version)) { error('ASB needs Node.js 22.13 or later on Windows.'); return 1; }
  // npm runs this file without scripts/asb, so the Linux floor is checked here too.
  if (platform === 'linux' && Number(version.split('.')[0]) < 20) { error(NODE_HINT); return 1; }
  const [command, ...rest] = argv;
  const script = (name) => load(new URL(`./${name}`, import.meta.url).href);
  if (command === 'engine') return caught('ASB engine: ', async () => (await script('asb-engine.mjs')).main(rest));
  if (command === 'agent') return (await script('asb-agent.mjs')).main(rest);
  if (command === 'bridge') return caught('ASB Bridge failed: ', async () => (await script('asb-bridge.mjs')).main(rest));
  if (['group', 'network', 'phone'].includes(command)) return (await script('asb-group.mjs')).main(argv);
  if (command === 'usage') return caught('ASB usage: ', async () => (await script('asb-usage.mjs')).main(rest));
  if (command === 'setup') return (await script('asb-setup.mjs')).main(rest);
  if (command === 'doctor') return caught('ASB doctor: ', async () => (await script('asb-doctor.mjs')).main(rest));
  if (platform === 'win32' && command !== undefined) { error(WINDOWS_USAGE); return 2; }
  if (command === 'service') return caught('ASB service: ', async () => (await script('asb-service.mjs')).main(rest));
  if (command === '--package') return (await script('asb-package.mjs')).main(rest);
  // Only no command opens the board, on Linux and on Windows. An unknown command must not start an engine.
  if (command !== undefined) { error(LINUX_USAGE); return 2; }
  (await script('asb-desktop.mjs')).main();
  return undefined;
}

// npm links bin files, so the entry check compares real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // node:sqlite is still experimental in Node.js 22 and early 24; its warning would print with every command.
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name !== 'ExperimentalWarning' || !/SQLite/.test(warning.message)) process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
  const code = await main();
  if (code !== undefined) process.exitCode = code;
}
