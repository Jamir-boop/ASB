import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFamily, FAMILIES, installCommand, nodeRoute, parseOsRelease } from '../src/linux-distros.mjs';
import { findExecutable } from '../src/platform-paths.mjs';

// os-release fixtures in the format of each distribution, cut to the lines that matter.
const RELEASES = {
  'debian-12': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\nID=debian\n',
  'debian-13': 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION="13 (trixie)"\nID=debian\nHOME_URL="https://www.debian.org/"\n',
  'ubuntu-24.04': 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=noble\n',
  'mint-22': 'NAME="Linux Mint"\nVERSION="22.1 (Xia)"\nID=linuxmint\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Linux Mint 22.1"\nVERSION_ID="22.1"\n',
  'pop-24.04': 'NAME="Pop!_OS"\nVERSION="24.04 LTS"\nID=pop\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Pop!_OS 24.04 LTS"\nVERSION_ID="24.04"\n',
  'fedora-44': 'NAME="Fedora Linux"\nVERSION="44 (Workstation Edition)"\nID=fedora\nVERSION_ID=44\nPRETTY_NAME="Fedora Linux 44 (Workstation Edition)"\nVARIANT_ID=workstation\n',
  silverblue: 'NAME="Fedora Linux"\nVERSION="44 (Silverblue)"\nID=fedora\nVERSION_ID=44\nPRETTY_NAME="Fedora Linux 44 (Silverblue)"\nVARIANT_ID=silverblue\nOSTREE_VERSION=\'44.20261015.0\'\n',
  'rhel-9': 'NAME="Red Hat Enterprise Linux"\nVERSION="9.8 (Plow)"\nID="rhel"\nID_LIKE="fedora"\nVERSION_ID="9.8"\nPRETTY_NAME="Red Hat Enterprise Linux 9.8 (Plow)"\n',
  'alma-9': 'NAME="AlmaLinux"\nVERSION="9.8 (Olive Jaguarundi)"\nID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.8"\nPLATFORM_ID="platform:el9"\n',
  'alma-10': 'NAME="AlmaLinux"\nVERSION="10.1 (Heliotrope Lion)"\nID="almalinux"\nID_LIKE="rhel centos fedora"\nVERSION_ID="10.1"\nPLATFORM_ID="platform:el10"\n',
  'rocky-9': 'NAME="Rocky Linux"\nVERSION="9.8 (Blue Onyx)"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.8"\n',
  'oracle-9': 'NAME="Oracle Linux Server"\nVERSION="9.8"\nID="ol"\nID_LIKE="fedora"\nVARIANT="Server"\nVERSION_ID="9.8"\n',
  'centos-stream-9': 'NAME="CentOS Stream"\nVERSION="9"\nID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="9"\nPLATFORM_ID="platform:el9"\n',
  tumbleweed: 'NAME="openSUSE Tumbleweed"\n# VERSION="20261018"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\nVERSION_ID="20261018"\n',
  'leap-16': 'NAME="openSUSE Leap"\nVERSION="16.0"\nID="opensuse-leap"\nID_LIKE="suse opensuse"\nVERSION_ID="16.0"\n',
  aeon: 'NAME="openSUSE Aeon"\nID="opensuse-aeon"\nID_LIKE="suse opensuse opensuse-tumbleweed microos opensuse-microos"\nVERSION_ID="20261018"\n',
  arch: 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\nANSI_COLOR="38;2;23;147;209"\n',
  manjaro: 'NAME="Manjaro Linux"\nPRETTY_NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\nBUILD_ID=rolling\n',
  endeavouros: 'NAME=\'EndeavourOS\'\nPRETTY_NAME=\'EndeavourOS\'\nID=\'endeavouros\'\nID_LIKE=\'arch\'\nBUILD_ID=\'2025.03.19\'\n',
  artix: 'NAME="Artix Linux"\nPRETTY_NAME="Artix Linux"\nID=artix\nBUILD_ID=rolling\n',
  steamos: 'NAME="SteamOS"\nPRETTY_NAME="SteamOS"\nVERSION_CODENAME=holo\nID=steamos\nID_LIKE=arch\nVARIANT_ID=steamdeck\nVERSION_ID=3.8.2\n',
  alpine: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.24.0\nPRETTY_NAME="Alpine Linux v3.24"\n',
  void: 'NAME="Void"\nID="void"\nPRETTY_NAME="Void Linux"\nDISTRIB_ID="void"\n',
  gentoo: 'NAME=Gentoo\nID=gentoo\nPRETTY_NAME="Gentoo Linux"\nVERSION_ID="2.18"\n',
  solus: 'NAME="Solus"\nVERSION="4.8"\nID="solus"\nVERSION_ID="4.8"\nPRETTY_NAME="Solus 4.8 Opportunity"\n',
  nixos: 'ANSI_COLOR="0;38;2;126;186;228"\nID=nixos\nNAME=NixOS\nPRETTY_NAME="NixOS 26.05 (Yarara)"\nVERSION_ID="26.05"\n',
  unknown: 'NAME="Haiku-like"\nID=somethingelse\nID_LIKE="nothing known"\nVERSION_ID=1\n',
};
const release = (name) => parseOsRelease(RELEASES[name]);
const ALL_KEYS = ['node', 'sqlite', 'openssl', 'xdg', 'gi', 'gtk', 'adw', 'gicairo', 'qrcode', 'sound', 'xvfb', 'dbus', 'font'];
const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../src/linux-distros.mjs', import.meta.url)), ...args], { encoding: 'utf8' });

test('the table has the nine families with every key', () => {
  assert.deepEqual(Object.keys(FAMILIES), ['debian', 'fedora', 'opensuse', 'arch', 'alpine', 'void', 'gentoo', 'solus', 'nixos']);
  for (const [name, item] of Object.entries(FAMILIES)) {
    assert.deepEqual(item.like, item.ids, name);
    if (name !== 'nixos') assert.deepEqual(Object.keys(item.packages), ALL_KEYS, name);
  }
  assert.deepEqual(FAMILIES.nixos, { ids: ['nixos'], like: ['nixos'], install: null, ci: null, packages: null });
  assert.deepEqual(FAMILIES.fedora.ids, ['fedora', 'rhel', 'centos']);
  assert.equal(FAMILIES.gentoo.ci, null);
  assert.equal(FAMILIES.solus.ci, null);
  assert.equal(FAMILIES.gentoo.packages.xvfb, null);
  assert.equal(FAMILIES.arch.packages.gicairo, null);
});

test('the package names match the package table', () => {
  // One line per key; columns debian fedora opensuse arch alpine void gentoo solus; '-' is null, '+' joins two names.
  const table = `
node nodejs nodejs nodejs-default nodejs nodejs nodejs net-libs/nodejs nodejs
sqlite sqlite3 sqlite sqlite3 sqlite sqlite sqlite dev-db/sqlite sqlite3
openssl openssl openssl openssl openssl openssl openssl dev-libs/openssl openssl
xdg xdg-utils xdg-utils xdg-utils xdg-utils xdg-utils xdg-utils x11-misc/xdg-utils xdg-utils
gi python3-gi python3-gobject python313-gobject python-gobject py3-gobject3 python3-gobject dev-python/pygobject python-gobject
gtk gir1.2-gtk-4.0 gtk4 typelib-1_0-Gtk-4_0 gtk4 gtk4.0 gtk4 gui-libs/gtk libgtk-4
adw gir1.2-adw-1 libadwaita typelib-1_0-Adw-1 libadwaita libadwaita libadwaita gui-libs/libadwaita libadwaita
gicairo python3-gi-cairo - python313-gobject-cairo - - - - -
qrcode python3-qrcode python3-qrcode-core python313-qrcode python-qrcode py3-qrcode python3-qrcode dev-python/qrcode python-qrcode
sound pipewire-bin pipewire-utils pipewire-tools pipewire-audio pipewire-tools pipewire media-video/pipewire pipewire
xvfb xvfb+xauth xorg-x11-server-Xvfb xvfb-run xorg-server-xvfb xvfb-run xorg-server-xvfb+xvfb-run - -
dbus dbus dbus-daemon dbus-1 dbus dbus dbus - -
font fonts-dejavu-core dejavu-sans-fonts dejavu-fonts ttf-dejavu font-dejavu dejavu-fonts-ttf - -`;
  const columns = ['debian', 'fedora', 'opensuse', 'arch', 'alpine', 'void', 'gentoo', 'solus'];
  const lines = table.trim().split('\n').map((line) => line.split(' '));
  assert.deepEqual(lines.map(([key]) => key), ALL_KEYS);
  for (const [key, ...cells] of lines) {
    columns.forEach((name, index) => assert.deepEqual(FAMILIES[name].packages[key],
      cells[index] === '-' ? null : cells[index].includes('+') ? cells[index].split('+') : cells[index], `${name} ${key}`));
  }
  assert.deepEqual(Object.fromEntries(columns.map((name) => [name, [FAMILIES[name].install, FAMILIES[name].ci]])), {
    debian: [['apt', 'install'], ['apt-get', 'install', '-y']], fedora: [['dnf', 'install'], ['dnf', 'install', '-y']],
    opensuse: [['zypper', 'install'], ['zypper', '--non-interactive', 'install']],
    arch: [['pacman', '-S', '--needed'], ['pacman', '-S', '--needed', '--noconfirm']], alpine: [['apk', 'add'], ['apk', 'add']],
    void: [['xbps-install', '-S'], ['xbps-install', '-S', '-y']], gentoo: [['emerge', '--ask', '--noreplace'], null], solus: [['eopkg', 'install'], null],
  });
  assert.deepEqual(Object.fromEntries(columns.map((name) => [name, FAMILIES[name].ids])), { debian: ['debian', 'ubuntu'],
    fedora: ['fedora', 'rhel', 'centos'], opensuse: ['opensuse', 'suse'], arch: ['arch', 'artix'], alpine: ['alpine'], void: ['void'],
    gentoo: ['gentoo'], solus: ['solus'] });
});

test('parseOsRelease removes shell quotes and skips comments and empty lines without running the text', () => {
  const text = '# comment\n\nID=debian\nNAME="Debian \\"GNU\\" \\$HOME \\\\ \\x"\nA=\'single $(id) "x"\'\nB=un\\ quoted\nC="a"\'b\'c\n'
    + 'ID_LIKE="  rhel   centos fedora "\nnot a line\n  D = no\nE=\n=F\n';
  assert.deepEqual(parseOsRelease(text), { ID: 'debian', NAME: 'Debian "GNU" $HOME \\ \\x', A: 'single $(id) "x"', B: 'un quoted', C: 'abc',
    ID_LIKE: ['rhel', 'centos', 'fedora'], E: '' });
  assert.deepEqual(parseOsRelease('ID_LIKE=arch\r\nID=manjaro\r\n'), { ID_LIKE: ['arch'], ID: 'manjaro' });
  assert.deepEqual(parseOsRelease('__proto__=x\n').__proto__, 'x');
});

test('detectFamily matches ID first, then ID_LIKE, and gives the mode', () => {
  const expected = {
    'debian-12': 'debian', 'debian-13': 'debian', 'ubuntu-24.04': 'debian', 'mint-22': 'debian', 'pop-24.04': 'debian',
    'fedora-44': 'fedora', silverblue: 'fedora', 'rhel-9': 'fedora', 'alma-9': 'fedora', 'alma-10': 'fedora', 'rocky-9': 'fedora',
    'oracle-9': 'fedora', 'centos-stream-9': 'fedora', tumbleweed: 'opensuse', 'leap-16': 'opensuse', aeon: 'opensuse', arch: 'arch',
    manjaro: 'arch', endeavouros: 'arch', artix: 'arch', steamos: 'arch', alpine: 'alpine', void: 'void', gentoo: 'gentoo',
    solus: 'solus', nixos: 'nixos', unknown: null,
  };
  for (const [name, family] of Object.entries(expected)) {
    const mode = name === 'aeon' ? 'transactional' : name === 'steamos' ? 'readonly' : 'normal';
    assert.deepEqual(detectFamily(release(name)), { family, mode }, name);
  }
  assert.deepEqual(detectFamily(release('silverblue'), { ostreeBooted: true }), { family: 'fedora', mode: 'transactional' });
  for (const id of ['opensuse-microos', 'opensuse-kalpa']) {
    assert.deepEqual(detectFamily({ ID: id, ID_LIKE: ['suse', 'opensuse'] }), { family: 'opensuse', mode: 'transactional' });
  }
  // ID wins over ID_LIKE.
  assert.deepEqual(detectFamily({ ID: 'ubuntu', ID_LIKE: ['arch'] }), { family: 'debian', mode: 'normal' });
  assert.deepEqual(detectFamily({ ID: 'x', ID_LIKE: ['nothing', 'suse', 'debian'] }), { family: 'opensuse', mode: 'normal' });
  assert.deepEqual(detectFamily(release('unknown'), { ostreeBooted: true }), { family: null, mode: 'normal' });
  assert.deepEqual(detectFamily({}), { family: null, mode: 'normal' });
});

test('installCommand gives the names in key order without duplicates, after the root prefix', () => {
  assert.deepEqual(installCommand('debian', ALL_KEYS), ['sudo', 'apt', 'install', 'nodejs', 'sqlite3', 'openssl', 'xdg-utils', 'python3-gi',
    'gir1.2-gtk-4.0', 'gir1.2-adw-1', 'python3-gi-cairo', 'python3-qrcode', 'pipewire-bin', 'xvfb', 'xauth', 'dbus', 'fonts-dejavu-core']);
  assert.deepEqual(installCommand('fedora', ['gi', 'gtk', 'adw', 'gicairo', 'qrcode']),
    ['sudo', 'dnf', 'install', 'python3-gobject', 'gtk4', 'libadwaita', 'python3-qrcode-core']);
  assert.deepEqual(installCommand('opensuse', ['node', 'gi']), ['sudo', 'zypper', 'install', 'nodejs-default', 'python313-gobject']);
  assert.deepEqual(installCommand('arch', ['sound', 'node'], { root: 'doas' }), ['doas', 'pacman', '-S', '--needed', 'pipewire-audio', 'nodejs']);
  assert.deepEqual(installCommand('alpine', ['gtk', 'gtk', 'xvfb']), ['sudo', 'apk', 'add', 'gtk4.0', 'xvfb-run']);
  assert.deepEqual(installCommand('void', ['xvfb', 'sound', 'xvfb']), ['sudo', 'xbps-install', '-S', 'xorg-server-xvfb', 'xvfb-run', 'pipewire']);
  assert.deepEqual(installCommand('gentoo', ['gtk', 'xvfb']), ['sudo', 'emerge', '--ask', '--noreplace', 'gui-libs/gtk']);
  assert.deepEqual(installCommand('solus', ['gtk', 'font'], { root: 'doas' }), ['doas', 'eopkg', 'install', 'libgtk-4']);
  assert.deepEqual(installCommand('fedora', ['gi', 'gtk'], { mode: 'transactional' }), ['sudo', 'rpm-ostree', 'install', 'python3-gobject', 'gtk4']);
  assert.deepEqual(installCommand('opensuse', ['adw'], { mode: 'transactional', root: 'doas' }),
    ['doas', 'transactional-update', 'pkg', 'install', 'typelib-1_0-Adw-1']);
  for (const [name, options] of [['arch', { mode: 'readonly' }], ['debian', { mode: 'transactional' }], ['nixos', {}], ['nixos', { mode: 'transactional' }],
    ['unknown', {}], [null, {}], ['fedora', { mode: 'other' }]]) assert.equal(installCommand(name, ['node'], options), null, `${name} ${options.mode}`);
  assert.equal(installCommand('fedora', ['gicairo']), null);
  assert.equal(installCommand('debian', []), null);
  assert.throws(() => installCommand('debian', ['nope']), /Unknown package key/);
  assert.throws(() => installCommand('debian', ['node'], { root: 'pkexec' }), /Unknown root command/);
});

test('nodeRoute gives the Node.js route of each release', () => {
  const nodesource = { text: 'Install Node.js 24 from NodeSource (https://github.com/nodesource/distributions), then run asb doctor again.' };
  const archive = { text: 'Unpack the Linux archive from https://nodejs.org/en/download into ~/.local, so that ~/.local/bin/node exists.' };
  const module = { command: ['dnf', 'module', 'install', 'nodejs:24'] };
  const route = (name, mode) => nodeRoute(release(name), detectFamily(release(name)).family, { mode: mode ?? detectFamily(release(name)).mode });
  for (const name of ['debian-12', 'debian-13', 'ubuntu-24.04', 'mint-22', 'pop-24.04']) assert.deepEqual(route(name), nodesource, name);
  for (const name of ['rhel-9', 'alma-9', 'rocky-9', 'oracle-9', 'centos-stream-9']) assert.deepEqual(route(name), module, name);
  assert.deepEqual(route('steamos'), archive);
  for (const name of ['alma-10', 'fedora-44', 'silverblue', 'tumbleweed', 'arch', 'alpine', 'nixos', 'unknown']) assert.equal(route(name), null, name);
  // The major version is the part before the first dot, not a prefix.
  for (const version of ['90', '19', '9x', '', undefined]) assert.equal(nodeRoute({ ID: 'rocky', VERSION_ID: version }, 'fedora'), null, version);
  assert.deepEqual(nodeRoute({ ID: 'eurolinux', ID_LIKE: ['rhel'], VERSION_ID: '9' }, 'fedora'), module);
  assert.deepEqual(nodeRoute({ ID: 'fedora', VERSION_ID: '9' }, 'fedora'), null);
  assert.deepEqual(nodeRoute({ ID: 'ubuntu', VERSION_ID: '9' }, 'debian', { mode: 'readonly' }), archive);
});

test('the CLI prints the CI command, refuses families without one, and prints usage', () => {
  const debian = cli('debian', ...ALL_KEYS);
  assert.equal(debian.status, 0);
  assert.equal(debian.stdout, 'apt-get install -y nodejs sqlite3 openssl xdg-utils python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 python3-gi-cairo '
    + 'python3-qrcode pipewire-bin xvfb xauth dbus fonts-dejavu-core\n');
  const ci = { fedora: 'dnf install -y', opensuse: 'zypper --non-interactive install', arch: 'pacman -S --needed --noconfirm',
    alpine: 'apk add', void: 'xbps-install -S -y' };
  for (const [name, words] of Object.entries(ci)) assert.equal(cli(name, 'openssl').stdout, `${words} openssl\n`, name);
  assert.equal(cli('fedora', 'gi', 'gtk', 'adw', 'qrcode').stdout, 'dnf install -y python3-gobject gtk4 libadwaita python3-qrcode-core\n');
  for (const name of ['gentoo', 'solus', 'nixos']) {
    const result = cli(name, 'node');
    assert.deepEqual([result.status, result.stdout], [1, ''], name);
  }
  for (const args of [[], ['nonsense'], ['debian'], ['debian', 'nope'], ['detect', 'x'], ['constructor', 'node']]) {
    const result = cli(...args);
    assert.deepEqual([result.status, result.stdout], [2, ''], args.join(' '));
    assert.match(result.stderr, /^Usage: /);
  }
  const detect = cli('detect');
  assert.equal(detect.status, 0);
  assert.match(detect.stdout, /^(debian|fedora|opensuse|arch|alpine|void|gentoo|solus|nixos|none) (normal|transactional|readonly)\n$/);
});

test('the CLI also runs through a symlink', { skip: process.platform === 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-distros-link-'));
  try {
    const link = path.join(temporary, 'linux-distros.mjs');
    await symlink(fileURLToPath(new URL('../src/linux-distros.mjs', import.meta.url)), link);
    const direct = cli('detect');
    const linked = spawnSync(process.execPath, [link, 'detect'], { encoding: 'utf8' });
    assert.deepEqual([linked.status, linked.stdout], [direct.status, direct.stdout]);
    assert.notEqual(linked.stdout, '');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the probe prints valid JSON and fails when Node.js and Python are missing', { skip: process.platform === 'win32' || !existsSync('/bin/sh') }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-distro-probe-'));
  try {
    // Only the text and path tools of the probe: no node, python3, or other program.
    const bin = path.join(temporary, 'bin');
    await mkdir(bin);
    for (const tool of ['dirname', 'sed', 'tr', 'head']) {
      const file = await findExecutable(tool);
      assert.ok(file, tool);
      await symlink(file, path.join(bin, tool));
    }
    const out = path.join(temporary, 'probe.json');
    const result = spawnSync('/bin/sh', [fileURLToPath(new URL('./distro-probe.sh', import.meta.url)), 'engine', 'debian'],
      { encoding: 'utf8', env: { PATH: bin, ASB_PROBE_OUT: out } });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);
    for (const key of ['node', 'node_sqlite', 'detect', 'python', 'gi', 'gtk', 'adw', 'glib', 'cairo', 'qrcode']) assert.equal(data[key], null, key);
    assert.equal(data.ok, false);
    for (const error of ['node does not run.', 'openssl does not run.', 'xdg-open does not run.', 'Neither node:sqlite loads nor sqlite3 runs.',
      'The detected family is not debian.']) assert.ok(data.errors.includes(error), error);
    assert.equal(await readFile(out, 'utf8'), result.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Runs the board probe with stub node and python3 scripts (null for none) and only the text tools; gives the errors.
async function boardErrors(stubs) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-distro-probe-'));
  try {
    const bin = path.join(temporary, 'bin');
    await mkdir(bin);
    for (const tool of ['dirname', 'sed', 'tr', 'head']) await symlink(await findExecutable(tool), path.join(bin, tool));
    if (stubs) {
      const { node, python, gtk, adw } = stubs;
      await writeFile(path.join(bin, 'node'), `#!/bin/sh\ncase "$1" in --version) echo v${node} ;; -e) exit 1 ;; *) echo 'debian normal' ;; esac\n`, { mode: 0o755 });
      const [major, minor] = python.split('.');
      await writeFile(path.join(bin, 'python3'), `#!/bin/sh\necho '"python":"${python}","gi":"3.50.0","gtk":[${gtk.join(',')}],"adw":[${adw.join(',')}],`
        + `"glib":[2,80,0],"cairo":true,"qrcode":true'\necho '1 ${gtk[0]} ${gtk[1]} ${adw[0]} ${adw[1]} ${major} ${minor}'\n`, { mode: 0o755 });
    }
    const out = path.join(temporary, 'probe.json');
    const result = spawnSync('/bin/sh', [fileURLToPath(new URL('./distro-probe.sh', import.meta.url)), 'board', 'debian'],
      { encoding: 'utf8', env: { PATH: bin, ASB_PROBE_OUT: out } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(await readFile(out, 'utf8'), result.stdout);
    return JSON.parse(result.stdout).errors;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('the board probe checks the Node.js, Python, GTK, and Libadwaita floors', { skip: process.platform === 'win32' || !existsSync('/bin/sh') }, async () => {
  const floors = ['Node.js is older than 20.', 'Python is older than 3.9.', 'GTK is missing or older than 4.12.', 'Libadwaita is missing or older than 1.4.'];
  const atFloor = await boardErrors({ node: '20.0.0', python: '3.9.0', gtk: [4, 12, 0], adw: [1, 4, 0] });
  for (const error of [...floors, 'PyGObject is missing.', 'The detected family is not debian.']) assert.ok(!atFloor.includes(error), error);
  const below = await boardErrors({ node: '18.20.0', python: '3.8.10', gtk: [4, 10, 0], adw: [1, 3, 0] });
  for (const error of floors) assert.ok(below.includes(error), error);
  assert.ok(!below.includes('PyGObject is missing.'));
  const none = await boardErrors(null);
  assert.ok(none.includes('PyGObject is missing.'));
  for (const error of ['Python is older than 3.9.', 'Node.js is older than 20.']) assert.ok(!none.includes(error), error);
});
