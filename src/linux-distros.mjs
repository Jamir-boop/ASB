import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The package table of each Linux family: one source for asb doctor, the README, and CI.
// `install` and `ci` have no root prefix; a null package means that another package of the family includes it.
const family = (ids, install, ci, packages) => ({ ids, like: [...ids], install, ci, packages });
const row = (node, sqlite, openssl, xdg, gi, gtk, adw, gicairo, qrcode, sound, xvfb, dbus, font) =>
  ({ node, sqlite, openssl, xdg, gi, gtk, adw, gicairo, qrcode, sound, xvfb, dbus, font });

export const FAMILIES = {
  debian: family(['debian', 'ubuntu'], ['apt', 'install'], ['apt-get', 'install', '-y'],
    row('nodejs', 'sqlite3', 'openssl', 'xdg-utils', 'python3-gi', 'gir1.2-gtk-4.0', 'gir1.2-adw-1', 'python3-gi-cairo', 'python3-qrcode',
      'pipewire-bin', ['xvfb', 'xauth'], 'dbus', 'fonts-dejavu-core')),
  // libglvnd-gles: GTK 4.20 aborts in libepoxy without libGLESv2.so.2, and the gtk4 package does not require it.
  fedora: family(['fedora', 'rhel', 'centos'], ['dnf', 'install'], ['dnf', 'install', '-y'],
    row('nodejs', 'sqlite', 'openssl', 'xdg-utils', 'python3-gobject', ['gtk4', 'gobject-introspection', 'libglvnd-gles'], 'libadwaita', null,
      'python3-qrcode-core', 'pipewire-utils', 'xorg-x11-server-Xvfb', 'dbus-daemon', 'dejavu-sans-fonts')),
  opensuse: family(['opensuse', 'suse'], ['zypper', 'install'], ['zypper', '--non-interactive', 'install'],
    row('nodejs-default', 'sqlite3', 'openssl', 'xdg-utils', ['python3', 'python313-gobject'], 'typelib-1_0-Gtk-4_0', 'typelib-1_0-Adw-1',
      'python313-gobject-cairo', 'python313-qrcode', 'pipewire-tools', 'xvfb-run', 'dbus-1-daemon', 'dejavu-fonts')),
  arch: family(['arch', 'artix'], ['pacman', '-S', '--needed'], ['pacman', '-S', '--needed', '--noconfirm'],
    row('nodejs', 'sqlite', 'openssl', 'xdg-utils', 'python-gobject', 'gtk4', 'libadwaita', 'python-cairo', 'python-qrcode',
      'pipewire-audio', 'xorg-server-xvfb', 'dbus', 'ttf-dejavu')),
  alpine: family(['alpine'], ['apk', 'add'], ['apk', 'add'],
    row('nodejs', 'sqlite', 'openssl', 'xdg-utils', 'py3-gobject3', 'gtk4.0', 'libadwaita', 'py3-cairo', 'py3-qrcode',
      'pipewire-tools', 'xvfb-run', 'dbus', 'font-dejavu')),
  void: family(['void'], ['xbps-install', '-S'], ['xbps-install', '-S', '-y'],
    row('nodejs', 'sqlite', 'openssl', 'xdg-utils', 'python3-gobject', 'gtk4', 'libadwaita', null, 'python3-qrcode',
      'pipewire', ['xorg-server-xvfb', 'xvfb-run'], 'dbus', 'dejavu-fonts-ttf')),
  gentoo: family(['gentoo'], ['emerge', '--ask', '--noreplace'], null,
    row('net-libs/nodejs', 'dev-db/sqlite', 'dev-libs/openssl', 'x11-misc/xdg-utils', 'dev-python/pygobject', 'gui-libs/gtk',
      'gui-libs/libadwaita', null, 'dev-python/qrcode', 'media-video/pipewire', null, null, null)),
  solus: family(['solus'], ['eopkg', 'install'], null,
    row('nodejs', 'sqlite3', 'openssl', 'xdg-utils', 'python-gobject', 'libgtk-4', 'libadwaita', null, 'python-qrcode',
      'pipewire', null, null, null)),
  // The flake brings everything.
  nixos: family(['nixos'], null, null, null),
};

const KEYS = Object.keys(FAMILIES.debian.packages);
const TRANSACTIONAL = { fedora: ['rpm-ostree', 'install'], opensuse: ['transactional-update', 'pkg', 'install'] };
const RHEL_IDS = ['rhel', 'centos', 'almalinux', 'rocky', 'ol'];
const NODESOURCE_TEXT = 'Install Node.js 24 from NodeSource (https://github.com/nodesource/distributions), then run asb doctor again.';
const ARCHIVE_TEXT = 'Unpack the Linux archive from https://nodejs.org/en/download into ~/.local, so that ~/.local/bin/node exists.';

// One os-release(5) value with the shell quotes removed. The text is never run.
function unquote(value) {
  let out = '';
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'") quote = ''; else out += char;
    } else if (char === '\\' && index + 1 < value.length && (quote !== '"' || '$"\\`'.includes(value[index + 1]))) {
      index += 1;
      out += value[index];
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (quote === '"' && char === '"') quote = '';
    else out += char;
  }
  return out;
}

export function parseOsRelease(text) {
  const entries = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue; // Comments and empty lines do not match.
    const value = unquote(match[2]);
    entries.push([match[1], match[1] === 'ID_LIKE' ? value.split(/\s+/).filter(Boolean) : value]);
  }
  return Object.fromEntries(entries);
}

export function detectFamily(release, { ostreeBooted = false } = {}) {
  const like = Array.isArray(release.ID_LIKE) ? release.ID_LIKE : [];
  const name = Object.keys(FAMILIES).find((key) => FAMILIES[key].ids.includes(release.ID))
    ?? like.map((value) => Object.keys(FAMILIES).find((key) => FAMILIES[key].like.includes(value))).find(Boolean);
  if (!name) return { family: null, mode: 'normal' };
  const mode = ostreeBooted || ['opensuse-microos', 'opensuse-aeon', 'opensuse-kalpa'].includes(release.ID) ? 'transactional'
    : release.ID === 'steamos' ? 'readonly' : 'normal';
  return { family: name, mode };
}

// The package names of the keys, in key order, without duplicates.
function packageNames(name, keys) {
  const packages = FAMILIES[name]?.packages;
  if (!packages) return [];
  const names = [];
  for (const key of keys) {
    if (!KEYS.includes(key)) throw new Error(`Unknown package key: ${key}`);
    for (const item of [packages[key]].flat()) if (item && !names.includes(item)) names.push(item);
  }
  return names;
}

// The command words that install the packages of the keys. ASB only prints it; it never runs it.
export function installCommand(name, keys, { mode = 'normal', root = 'sudo' } = {}) {
  if (!['sudo', 'doas'].includes(root)) throw new Error(`Unknown root command: ${root}`);
  const words = mode === 'transactional' ? TRANSACTIONAL[name] : mode === 'normal' ? FAMILIES[name]?.install : null;
  const names = packageNames(name, keys);
  return words && names.length ? [root, ...words, ...names] : null;
}

export function nodeRoute(release, name, { mode = 'normal' } = {}) {
  if (mode === 'readonly') return { text: ARCHIVE_TEXT };
  const like = Array.isArray(release.ID_LIKE) ? release.ID_LIKE : [];
  const major = String(release.VERSION_ID ?? '').split('.')[0];
  if ((RHEL_IDS.includes(release.ID) || like.includes('rhel')) && major === '9') return { command: ['dnf', 'module', 'install', 'nodejs:24'] };
  if (name === 'debian') return { text: NODESOURCE_TEXT };
  return null;
}

const USAGE = 'Usage: node src/linux-distros.mjs detect | <family> <key>...';

// CI runs as root, so the CLI prints the ci words without a root prefix.
function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === 'detect') {
    let text = '';
    try { text = readFileSync('/etc/os-release', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { family: name, mode } = detectFamily(parseOsRelease(text), { ostreeBooted: existsSync('/run/ostree-booted') });
    console.log(`${name ?? 'none'} ${mode}`);
    return 0;
  }
  const [name, ...keys] = argv;
  if (!Object.hasOwn(FAMILIES, name ?? '') || !keys.length || keys.some((key) => !KEYS.includes(key))) {
    console.error(USAGE);
    return 2;
  }
  if (!FAMILIES[name].ci) {
    console.error(`The ${name} family has no CI install command.`);
    return 1;
  }
  console.log([...FAMILIES[name].ci, ...packageNames(name, keys)].join(' '));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
