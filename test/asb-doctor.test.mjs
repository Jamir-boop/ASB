import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect, engineReady, firewallState, format, linuxFirewallLines, main, shellText } from '../scripts/asb-doctor.mjs';
import { PYTHON_PROBE } from '../src/linux-system.mjs';

// Each test fakes the system: os-release text, stub files on PATH (never run), the Node.js facts, and execFile.
const PYTHON = '/opt/python3';
const RELEASES = {
  debian13: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nID=debian\n',
  fedora44: 'NAME="Fedora Linux"\nVERSION_ID=44\nID=fedora\nPRETTY_NAME="Fedora Linux 44 (Workstation Edition)"\n',
  ubuntu2204: 'PRETTY_NAME="Ubuntu 22.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n',
  ubuntu2404: 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
  alma9: 'NAME="AlmaLinux"\nVERSION_ID="9.8"\nID="almalinux"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="AlmaLinux 9.8 (Olive Jaguar)"\n',
  nixos: 'NAME=NixOS\nID=nixos\nVERSION_ID="26.05"\nPRETTY_NAME="NixOS 26.05 (Yarara)"\n',
  arch: 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n',
  silverblue: 'NAME="Fedora Linux"\nVERSION_ID=44\nID=fedora\nVARIANT_ID=silverblue\nPRETTY_NAME="Fedora Linux 44.20261020.0 (Silverblue)"\n',
  gentoo: 'NAME=Gentoo\nID=gentoo\nPRETTY_NAME="Gentoo Linux"\n',
};
const ALL_BINS = ['sqlite3', 'openssl', 'xdg-open', 'pw-play', 'bun', 'sudo'];
const NODE24 = { path: '/usr/bin/node', version: '24.11.1', sqlite: true };
const probe = (values) => JSON.stringify({ python: '3.13.5', gi: '3.50.0', gtk: [4, 18, 6], adw: [1, 7, 6], glib: [2, 84, 4],
  cairo: true, qrcode: true, trayHost: true, ...values });

const UNIT = '/home/test/.config/systemd/user/asb.service';
const ENTRY = '/home/test/.config/autostart/asb-engine.desktop';

// The link fakes: `links` is the desktop file of each scheme (null: xdg-mime is missing, an Error: xdg-mime fails).
// XDG_MIME is the two queries that doctor runs.
const LINKS = { codex: 'chatgpt.desktop', claude: 'com.anthropic.Claude.desktop' };
const XDG_MIME = ['codex', 'claude'].map((scheme) => ['xdg-mime', 'query', 'default', `x-scheme-handler/${scheme}`]);

// The firewall fakes: `phone` is the /api/phone reply of the running engine (null: no engine), `firewalld` the --state output
// (null: firewall-cmd is missing), and `zones` the zone of each interface.
async function fakeSystem(t, { release, bins = ALL_BINS, values = {}, node = NODE24, ostree = false, files = {}, env = {}, phone = null,
  firewalld = null, zones = {}, links = LINKS }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  for (const name of bins) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const calls = [];
  const reads = [];
  const requests = [];
  const runtime = { pid: 1234, port: 4629 };
  const deps = {
    find: async () => (phone ? runtime : null),
    api: async (record, route) => {
      requests.push([record, route]);
      if (phone instanceof Error) throw phone;
      return phone;
    },
    env: { PATH: bin, ASB_PYTHON: PYTHON, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', XDG_CONFIG_HOME: '/home/test/.config',
      XDG_RUNTIME_DIR: '/run/user/1000', ...env }, node,
    read: async (file) => { reads.push(file); return file === '/etc/os-release' ? RELEASES[release] : files[file] ?? ''; },
    exists: async (file) => { reads.push(file); return file === '/run/ostree-booted' && ostree; },
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      if (file === PYTHON) return { stdout: `${probe(values)}\n` };
      if (file === path.join(bin, 'openssl')) return { stdout: 'OpenSSL 3.5.1 1 Jul 2025\n' };
      if (file === 'xdg-mime' && links !== null) {
        if (links instanceof Error) throw links;
        const handler = links[args[2].replace('x-scheme-handler/', '')];
        return { stdout: handler ? `${handler}\n` : '' };
      }
      if (file === 'firewall-cmd' && firewalld !== null) {
        if (args[0] === '--state') {
          if (firewalld === 'running') return { stdout: 'running\n' };
          throw Object.assign(new Error('Command failed'), { code: 252, stdout: `${firewalld}\n` });
        }
        const name = args[0].replace('--get-zone-of-interface=', '');
        if (zones[name]) return { stdout: `${zones[name]}\n` };
        throw Object.assign(new Error('Command failed'), { code: 2, stdout: 'no zone\n' });
      }
      throw Object.assign(new Error(`Unexpected program: ${file}`), { code: 'ENOENT' });
    },
  };
  const run = async (argv = []) => {
    const out = [];
    const code = await main(argv, { ...deps, log: (line) => out.push(line), error: (line) => out.push(`error: ${line}`) });
    return { code, out };
  };
  return { bin, calls, reads, requests, runtime, deps, run, lines: async () => format(await collect(deps)) };
}

test('Debian 13 with all checks ok prints the checks of Appendix D and no commands', async (t) => {
  const system = await fakeSystem(t, { release: 'debian13', node: { path: '/usr/bin/node', version: '20.19.2', sqlite: false } });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out, [
    'ASB doctor: Debian GNU/Linux 13 (trixie), family debian',
    '',
    'Engine',
    '  ok       Node.js 20.19.2 (/usr/bin/node)',
    `  ok       sqlite3 (${system.bin}/sqlite3)`,
    '  ok       openssl 3.5.1',
    `  ok       xdg-open (${system.bin}/xdg-open)`,
    'Window',
    `  ok       PyGObject 3.50.0 (Python 3.13.5, ${PYTHON})`,
    '  ok       GTK 4.18.6',
    '  ok       Libadwaita 1.7.6',
    'Options',
    '  ok       QR code',
    '  ok       Sounds (pw-play)',
    '  ok       Tray host',
    `  ok       Bun (${system.bin}/bun), for ASB Bridge`,
    '  info     Autostart: not installed',
    '  ok       Runtime folder: /run/user/1000/asb',
    '  ok       Links: codex: chatgpt.desktop, claude: com.anthropic.Claude.desktop',
  ]);
  // collect runs only the Python probe, openssl version, and the two xdg-mime queries, and reads only os-release, the ostree marker,
  // and the two autostart files.
  assert.deepEqual(system.calls, [[path.join(system.bin, 'openssl'), 'version'], [PYTHON, '-c', PYTHON_PROBE], ...XDG_MIME]);
  assert.deepEqual(system.reads, ['/etc/os-release', '/run/ostree-booted', UNIT, ENTRY]);
});

test('Fedora without the board packages prints one sudo dnf install line', async (t) => {
  const system = await fakeSystem(t, { release: 'fedora44', bins: ['openssl', 'xdg-open', 'pw-play', 'sudo'],
    values: { python: '3.14.8', gi: null, gtk: null, adw: null, glib: null, cairo: false, qrcode: false, trayHost: null } });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out, [
    'ASB doctor: Fedora Linux 44 (Workstation Edition), family fedora',
    '',
    'Engine',
    '  ok       Node.js 24.11.1 (/usr/bin/node), built-in SQLite',
    '  ok       openssl 3.5.1',
    `  ok       xdg-open (${system.bin}/xdg-open)`,
    'Window',
    `  missing  PyGObject (Python 3.14.8, ${PYTHON})`,
    '  missing  GTK 4',
    '  missing  Libadwaita',
    'Options',
    '  missing  QR code (Python qrcode)',
    '  ok       Sounds (pw-play)',
    '  info     Tray host: not checked (needs PyGObject and a session bus)',
    '  info     Bun: not found. ASB Bridge needs it.',
    '  info     Autostart: not installed',
    '  ok       Runtime folder: /run/user/1000/asb',
    '  ok       Links: codex: chatgpt.desktop, claude: com.anthropic.Claude.desktop',
    '',
    'Install the missing packages:',
    '  sudo dnf install python3-gobject gtk4 gobject-introspection libglvnd-gles libadwaita',
    'Optional:',
    '  sudo dnf install python3-qrcode-core',
  ]);
  assert.equal(out.filter((line) => line.includes('sudo dnf install')).length, 2);
});

test('Ubuntu 22.04 runs without the window and gets no board packages', async (t) => {
  const system = await fakeSystem(t, { release: 'ubuntu2204', values: { python: '3.10.12', gi: '3.42.1', gtk: [4, 6, 9], adw: [1, 1, 7], trayHost: false } });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out.slice(6, 18), [
    'Window',
    `  ok       PyGObject 3.42.1 (Python 3.10.12, ${PYTHON})`,
    '  old      GTK 4.6.9, needs 4.12 or later',
    '  old      Libadwaita 1.1.7, needs 1.4 or later',
    'Options',
    '  ok       QR code',
    '  ok       Sounds (pw-play)',
    '  info     Tray host: none found. On GNOME, add the AppIndicator extension.',
    `  ok       Bun (${system.bin}/bun), for ASB Bridge`,
    '  info     Autostart: not installed',
    '  ok       Runtime folder: /run/user/1000/asb',
    '  ok       Links: codex: chatgpt.desktop, claude: com.anthropic.Claude.desktop',
  ]);
  assert.deepEqual(out.slice(18), ['', 'This system has GTK 4.6 and Libadwaita 1.1. The ASB window needs GTK 4.12 and Libadwaita 1.4, '
    + 'so ASB runs without its window. The phone and your other machines still show this machine\'s sessions.']);
  const data = await collect(system.deps);
  assert.deepEqual(data.board, { ok: false, reason: 'GTK 4.6 is older than 4.12. Libadwaita 1.1 is older than 1.4.' });
  assert.deepEqual(data.commands, { required: null, optional: null, node: null, firewall: [] });
});

test('Node.js 18 prints only the route and exits 1', async (t) => {
  const system = await fakeSystem(t, { release: 'ubuntu2404', node: { path: '/usr/bin/node', version: '18.19.1', sqlite: false },
    values: { gtk: [4, 14, 5], adw: [1, 5, 0] } });
  const { code, out } = await system.run();
  assert.equal(code, 1);
  assert.equal(out[3], '  old      Node.js 18.19.1 (/usr/bin/node), needs 20 or later');
  assert.deepEqual(out.slice(-3), ['', 'Node.js 18.19.1 is older than 20. Install Node.js 20 or later:',
    '  Install Node.js 24 from NodeSource (https://github.com/nodesource/distributions), then run asb doctor again.']);
  assert.ok(!out.some((line) => line.includes('apt install') || line === 'Install the missing packages:'));
});

test('AlmaLinux 9 without Node.js prints the module command first and no nodejs package', async (t) => {
  const system = await fakeSystem(t, { release: 'alma9', node: null, bins: ['sqlite3', 'xdg-open', 'pw-play', 'sudo'],
    values: { python: '3.9.25', gi: '3.40.1', gtk: [4, 12, 3], adw: [1, 4, 2] } });
  const { code, out } = await system.run();
  assert.equal(code, 1);
  assert.deepEqual(out.slice(2, 7), ['Engine', '  missing  Node.js', `  ok       sqlite3 (${system.bin}/sqlite3)`, '  missing  openssl',
    `  ok       xdg-open (${system.bin}/xdg-open)`]);
  assert.deepEqual(out.slice(out.indexOf('Install the missing packages:')), ['Install the missing packages:',
    '  sudo dnf module install nodejs:24', '  sudo dnf install openssl']);
  // Only the Python probe and the two xdg-mime queries ran: openssl is missing.
  assert.deepEqual(system.calls, [[PYTHON, '-c', PYTHON_PROBE], ...XDG_MIME]);
  const json = await system.run(['--json']);
  assert.equal(json.code, 1);
  const data = JSON.parse(json.out.join('\n'));
  assert.deepEqual(Object.keys(data), ['schema', 'system', 'checks', 'board', 'commands']);
  assert.equal(data.schema, 1);
  assert.deepEqual(data.system, { name: 'AlmaLinux 9.8 (Olive Jaguar)', id: 'almalinux', versionId: '9.8', family: 'fedora', mode: 'normal' });
  assert.deepEqual(data.commands, { required: ['sudo', 'dnf', 'install', 'openssl'], optional: null,
    node: ['sudo', 'dnf', 'module', 'install', 'nodejs:24'], firewall: [] });
  assert.deepEqual(data.checks[0], { id: 'node', group: 'Engine', status: 'missing', detail: 'Node.js' });
  assert.deepEqual(data.board, { ok: true, reason: '' });
});

test('Debian without Node.js adds nodejs to the required command and prints the route under it', async (t) => {
  const system = await fakeSystem(t, { release: 'debian13', node: null, bins: ['xdg-open', 'openssl', 'pw-play', 'sudo'] });
  const { code, out } = await system.run();
  assert.equal(code, 1);
  assert.deepEqual(out.slice(out.indexOf('Install the missing packages:')), ['Install the missing packages:', '  sudo apt install nodejs sqlite3',
    'If this Node.js is older than 20:', '  Install Node.js 24 from NodeSource (https://github.com/nodesource/distributions), then run asb doctor again.']);
});

test('NixOS prints the needs in words and the flake line', async (t) => {
  const system = await fakeSystem(t, { release: 'nixos', values: { gi: null, gtk: null, adw: null, cairo: false, qrcode: false, trayHost: null } });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.equal(out[0], 'ASB doctor: NixOS 26.05 (Yarara), family nixos');
  assert.deepEqual(out.slice(out.indexOf('Install the missing packages:')), ['Install the missing packages:',
    '  PyGObject, GTK 4.12 or later, Libadwaita 1.4 or later', 'Optional:', '  PyGObject cairo support, Python qrcode',
    'Use the flake: nix profile install github:Jamir-boop/ASB']);
  const all = await fakeSystem(t, { release: 'nixos' });
  assert.ok(!(await all.lines()).some((line) => line.includes('flake')));
});

test('the root command is doas only when doas is found and sudo is not', async (t) => {
  const values = { qrcode: false };
  const doas = await fakeSystem(t, { release: 'arch', bins: ['openssl', 'xdg-open', 'pw-play', 'doas'], values });
  assert.deepEqual((await doas.lines()).slice(-2), ['Optional:', '  doas pacman -S --needed python-qrcode']);
  const both = await fakeSystem(t, { release: 'arch', bins: ['openssl', 'xdg-open', 'pw-play', 'doas', 'sudo'], values });
  assert.deepEqual((await both.lines()).slice(-1), ['  sudo pacman -S --needed python-qrcode']);
  const none = await fakeSystem(t, { release: 'arch', bins: ['openssl', 'xdg-open', 'pw-play'], values });
  assert.deepEqual((await none.lines()).slice(-1), ['  sudo pacman -S --needed python-qrcode']);
});

test('image-based systems and Gentoo print their notes after the commands', async (t) => {
  const values = { qrcode: false };
  const atomic = await fakeSystem(t, { release: 'silverblue', ostree: true, values, bins: ['openssl', 'xdg-open', 'pw-play', 'sudo'] });
  const atomicLines = await atomic.lines();
  assert.equal(atomicLines[0], 'ASB doctor: Fedora Linux 44.20261020.0 (Silverblue), family fedora, transactional');
  assert.deepEqual(atomicLines.slice(-3), ['Optional:', '  sudo rpm-ostree install python3-qrcode-core', 'Restart the computer to use the new packages.']);
  const gentoo = await fakeSystem(t, { release: 'gentoo', values, bins: ['openssl', 'xdg-open', 'pw-play', 'sudo'] });
  assert.deepEqual((await gentoo.lines()).slice(-2), ['  sudo emerge --ask --noreplace dev-python/qrcode', 'Build gui-libs/gtk and gui-libs/libadwaita '
    + 'with USE=introspection, dev-python/pygobject with USE=cairo, and media-video/pipewire with USE=extra (for pw-play).']);
});

test('Autostart counts only a file with the ASB marker, and the runtime folder shows the fallback', async (t) => {
  // The last two lines before Links.
  const autostart = async (files, env) => (await (await fakeSystem(t, { release: 'debian13', files, env })).lines()).slice(-3, -1);
  assert.deepEqual(await autostart({ [UNIT]: '# Generated by ASB: asb.service\n[Unit]\n' }),
    ['  ok       Autostart: systemd user service', '  ok       Runtime folder: /run/user/1000/asb']);
  assert.deepEqual((await autostart({ [ENTRY]: '[Desktop Entry]\n# Generated by ASB: engine autostart\n' }))[0], '  ok       Autostart: XDG autostart');
  assert.deepEqual((await autostart({ [UNIT]: '[Service]\nExecStart=/bin/true\n', [ENTRY]: '[Desktop Entry]\nExec=/bin/true\n' }))[0],
    '  info     Autostart: not installed');
  for (const XDG_RUNTIME_DIR of [undefined, '', 'relative']) {
    assert.deepEqual((await autostart({}, { XDG_RUNTIME_DIR, XDG_STATE_HOME: '/home/test/.local/state' }))[1],
      '  info     Runtime folder: /home/test/.local/state/asb/run (XDG_RUNTIME_DIR is not set)');
  }
  // The other XDG_CONFIG_HOME gives the other files.
  const system = await fakeSystem(t, { release: 'debian13', env: { XDG_CONFIG_HOME: '/config' } });
  await collect(system.deps);
  assert.deepEqual(system.reads.slice(-2), ['/config/systemd/user/asb.service', '/config/autostart/asb-engine.desktop']);
});

test('Links shows the desktop file of the codex and claude handlers, in the text and in the JSON', async (t) => {
  const system = await fakeSystem(t, { release: 'debian13' });
  const { code, out } = await system.run();
  const detail = 'Links: codex: chatgpt.desktop, claude: com.anthropic.Claude.desktop';
  assert.equal(code, 0);
  assert.equal(out.at(-1), `  ok       ${detail}`);
  const { checks } = JSON.parse((await system.run(['--json'])).out.join('\n'));
  assert.deepEqual(checks.slice(-2).map((check) => check.id), ['runtime', 'links']);
  assert.deepEqual(checks.at(-1), { id: 'links', group: 'Options', status: 'ok', detail });
  // Only the first line of the answer counts, trimmed.
  const lines = await (await fakeSystem(t, { release: 'debian13', links: { ...LINKS, codex: ' chatgpt.desktop \nother.desktop' } })).lines();
  assert.equal(lines.at(-1), `  ok       ${detail}`);
});

test('Links gives the info line for an app with empty output and keeps the handler of the other app', async (t) => {
  for (const [app, line] of [
    ['codex', '  info     Links: codex: none: ASB cannot open codex sessions until the app handles codex: links, claude: com.anthropic.Claude.desktop'],
    ['claude', '  info     Links: codex: chatgpt.desktop, claude: none: ASB cannot open claude sessions until the app handles claude: links'],
  ]) {
    const system = await fakeSystem(t, { release: 'debian13', links: { ...LINKS, [app]: '' } });
    const { code, out } = await system.run();
    assert.equal(code, 0);
    assert.equal(out.at(-1), line);
    assert.equal(JSON.parse((await system.run(['--json'])).out.join('\n')).checks.at(-1).status, 'info');
  }
});

test('Links gives the info line for both apps when xdg-mime is missing or fails', async (t) => {
  const both = '  info     Links: codex: none: ASB cannot open codex sessions until the app handles codex: links, '
    + 'claude: none: ASB cannot open claude sessions until the app handles claude: links';
  const missing = await fakeSystem(t, { release: 'debian13', links: null });
  const failed = await fakeSystem(t, { release: 'debian13', links: Object.assign(new Error('Command failed'), { code: 1, stdout: '' }) });
  for (const system of [missing, failed]) {
    const { code, out } = await system.run();
    assert.equal(code, 0);
    assert.equal(out.at(-1), both);
    assert.equal(JSON.parse((await system.run(['--json'])).out.join('\n')).checks.at(-1).status, 'info');
  }
});

test('Links runs only xdg-mime, with the two read-only queries', async (t) => {
  for (const links of [LINKS, null, new Error('Command failed')]) {
    const system = await fakeSystem(t, { release: 'debian13', links });
    await collect(system.deps);
    // The two probes before it are openssl and Python.
    assert.deepEqual(system.calls.slice(2), XDG_MIME);
  }
});

test('doctor exit codes, usage, and the read-only programs', async (t) => {
  const forbidden = /^(sudo|doas|pkexec|rpm-ostree|transactional-update|apt|apt-get|dnf|zypper|pacman|apk|xbps-install|emerge|eopkg|firewall-cmd|ufw)$/;
  const runs = [];
  for (const options of [{ release: 'debian13' }, { release: 'fedora44', values: { gi: null, gtk: null, adw: null, qrcode: false } },
    { release: 'alma9', node: null }, { release: 'silverblue', ostree: true, values: { qrcode: false } }]) {
    const system = await fakeSystem(t, options);
    const { code } = await system.run();
    runs.push(code);
    for (const [file] of system.calls) {
      assert.ok([PYTHON, path.join(system.bin, 'openssl'), 'xdg-mime'].includes(file), file);
      assert.doesNotMatch(path.basename(file), forbidden);
    }
    assert.deepEqual(system.calls.filter(([file]) => file === 'xdg-mime'), XDG_MIME);
  }
  assert.deepEqual(runs, [0, 0, 1, 0]);
  const system = await fakeSystem(t, { release: 'debian13' });
  assert.deepEqual(await system.run(['--yaml']), { code: 2, out: ['error: Usage: asb doctor [--json]'] });
  assert.deepEqual(await system.run(['--json', '--json']), { code: 2, out: ['error: Usage: asb doctor [--json]'] });
  assert.deepEqual(system.calls, []);
  assert.equal(engineReady({ checks: [{ group: 'Engine', status: 'old' }, { group: 'Window', status: 'ok' }] }), false);
  assert.equal(engineReady({ checks: [{ group: 'Engine', status: 'ok' }, { group: 'Window', status: 'missing' }] }), true);
});

// Phase 4: the firewall lines. The fake engine reply has one selected address on wlp2s0.
const UFW = '/etc/ufw/ufw.conf';
const PHONE = { enabled: true, bindAddresses: ['192.168.1.20'], port: 4630,
  addresses: [{ address: '192.168.1.20', interface: 'wlp2s0', kind: 'lan' }, { address: '10.147.0.1', interface: 'ztabc', kind: 'zerotier' }] };
const FEDORA_BARE = { release: 'fedora44', bins: ['openssl', 'xdg-open', 'pw-play', 'sudo'],
  values: { python: '3.14.8', gi: null, gtk: null, adw: null, glib: null, cairo: false, qrcode: false, trayHost: null } };
const NOTE = (address) => `ASB found an unusual interface or zone name, so it prints no firewall command for ${address}.`;

test('firewalld with a zone prints the rule of Appendix D after the Optional block, and runs only the read-only queries', async (t) => {
  const system = await fakeSystem(t, { ...FEDORA_BARE, phone: PHONE, firewalld: 'running', zones: { wlp2s0: 'public' } });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out.slice(out.indexOf('Install the missing packages:')), [
    'Install the missing packages:',
    '  sudo dnf install python3-gobject gtk4 gobject-introspection libglvnd-gles libadwaita',
    'Optional:',
    '  sudo dnf install python3-qrcode-core',
    'Phone access and machine links through firewalld:',
    '  sudo firewall-cmd --permanent --zone=public --add-rich-rule=\'rule family="ipv4" destination address="192.168.1.20" port port="4630" protocol="tcp" accept\'',
    '  sudo firewall-cmd --reload',
  ]);
  // Every program that doctor ran: only the read-only queries.
  assert.deepEqual(system.calls, [[path.join(system.bin, 'openssl'), 'version'], [PYTHON, '-c', PYTHON_PROBE], ...XDG_MIME,
    ['firewall-cmd', '--state'], ['firewall-cmd', '--get-zone-of-interface=wlp2s0']]);
  assert.deepEqual(system.requests, [[system.runtime, '/api/phone']]);
  const json = JSON.parse((await system.run(['--json'])).out.join('\n'));
  assert.deepEqual(json.commands.firewall, [['sudo', 'firewall-cmd', '--permanent', '--zone=public',
    '--add-rich-rule=rule family="ipv4" destination address="192.168.1.20" port port="4630" protocol="tcp" accept'], ['sudo', 'firewall-cmd', '--reload']]);
});

test('firewalld without a zone, ufw, ufw turned off, and no firewall', async (t) => {
  const tail = async (options) => {
    const system = await fakeSystem(t, { release: 'debian13', phone: { ...PHONE, bindAddresses: ['192.168.1.20', '10.147.0.1'] }, ...options });
    const data = await collect(system.deps);
    return { lines: format(data).slice(18), firewall: data.commands.firewall, reads: system.reads };
  };
  const rule = (address) => `--add-rich-rule='rule family="ipv4" destination address="${address}" port port="4630" protocol="tcp" accept'`;
  assert.deepEqual((await tail({ firewalld: 'running' })).lines, ['', 'Phone access and machine links through firewalld:',
    `  sudo firewall-cmd --permanent ${rule('192.168.1.20')}`, `  sudo firewall-cmd --permanent ${rule('10.147.0.1')}`, '  sudo firewall-cmd --reload']);
  const ufw = await tail({ firewalld: 'not running', files: { [UFW]: '# comment\nENABLED=yes\nLOGLEVEL=low\n' } });
  assert.deepEqual(ufw.lines, ['', 'Phone access and machine links through ufw:', '  sudo ufw allow in on wlp2s0 to 192.168.1.20 port 4630 proto tcp',
    '  sudo ufw allow in on ztabc to 10.147.0.1 port 4630 proto tcp']);
  assert.deepEqual(ufw.firewall[0], ['sudo', 'ufw', 'allow', 'in', 'on', 'wlp2s0', 'to', '192.168.1.20', 'port', '4630', 'proto', 'tcp']);
  assert.ok(ufw.reads.includes(UFW));
  for (const options of [{ files: { [UFW]: 'ENABLED=no\n' } }, {}]) {
    const none = await tail(options);
    assert.deepEqual([none.lines, none.firewall], [[], []]);
  }
});

test('the firewall lines use doas, and an unusual name or port gives the note and no command', async (t) => {
  const doas = await fakeSystem(t, { release: 'debian13', bins: ['openssl', 'xdg-open', 'pw-play', 'bun', 'sqlite3', 'doas'], phone: PHONE,
    files: { [UFW]: 'ENABLED=yes\n' } });
  assert.deepEqual((await doas.lines()).slice(-1), ['  doas ufw allow in on wlp2s0 to 192.168.1.20 port 4630 proto tcp']);
  const odd = { ...PHONE, bindAddresses: ['192.168.1.20', '10.147.0.1'],
    addresses: [{ address: '192.168.1.20', interface: 'wlan0;reboot', kind: 'lan' }, { address: '10.147.0.1', interface: 'ztabc', kind: 'zerotier' }] };
  const system = await fakeSystem(t, { release: 'debian13', phone: odd, firewalld: 'running', zones: { ztabc: 'trusted zone' } });
  const data = await collect(system.deps);
  assert.deepEqual(format(data).slice(-3), ['Phone access and machine links through firewalld:', NOTE('192.168.1.20'), NOTE('10.147.0.1')]);
  assert.deepEqual(data.commands.firewall, []);
  // The unusual interface name goes to no program.
  assert.deepEqual(system.calls.slice(2 + XDG_MIME.length), [['firewall-cmd', '--state'], ['firewall-cmd', '--get-zone-of-interface=ztabc']]);
  const port = await fakeSystem(t, { release: 'debian13', phone: { ...PHONE, port: 70000 }, files: { [UFW]: 'ENABLED=yes\n' } });
  assert.deepEqual((await port.lines()).slice(-2), ['Phone access and machine links through ufw:', NOTE('192.168.1.20')]);
});

test('doctor prints no firewall lines when the engine is off, access is off, or the request fails', async (t) => {
  const firewall = { firewalld: 'running', zones: { wlp2s0: 'public' } };
  for (const phone of [null, { ...PHONE, enabled: false }, { ...PHONE, bindAddresses: ['192.168.1.99'] }, new Error('ASB did not reply.')]) {
    const system = await fakeSystem(t, { release: 'debian13', phone, ...firewall });
    const { code, out } = await system.run();
    assert.equal(code, 0);
    assert.ok(!out.some((line) => line.includes('firewall') || line.startsWith('error')), String(phone));
    assert.deepEqual(system.calls.slice(2 + XDG_MIME.length), []);
    assert.equal(system.requests.length, phone ? 1 : 0);
  }
  // Setup step 0 leaves out the firewall part.
  const system = await fakeSystem(t, { release: 'debian13', phone: PHONE, ...firewall });
  assert.deepEqual((await collect({ ...system.deps, firewall: false })).commands.firewall, []);
  assert.deepEqual(system.requests, []);
});

test('the firewall functions without the engine', async () => {
  assert.equal(await firewallState({ execFile: async () => { throw Object.assign(new Error('spawn firewall-cmd ENOENT'), { code: 'ENOENT' }); },
    readFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }), 'none');
  assert.equal(await firewallState({ execFile: async () => ({ stdout: 'running\n' }), readFile: async () => 'ENABLED=yes\n' }), 'firewalld');
  assert.deepEqual(await linuxFirewallLines('none', [{ address: '192.168.1.20', interface: 'wlp2s0' }], 4630,
    { execFile: async () => { throw new Error('not called'); } }), { commands: [], lines: [] });
  assert.equal(shellText(['echo', "it's", 'a b', 'plain']), "echo 'it'\\''s' 'a b' plain");
});

// The Windows fakes: Python and reg never run. `msys2` is whether pacman.exe exists, `autostart` whether the Run value exists (an Error: reg fails),
// and `python` the MSYS2 Python of ASB_PYTHON (null: ASB_PYTHON is not set, so no Python is found).
const WIN_PYTHON = 'C:\\msys64\\ucrt64\\bin\\python.exe';
const PACMAN = 'C:\\msys64\\usr\\bin\\pacman.exe';
const WIN_NODE = { path: 'C:\\Program Files\\nodejs\\node.exe', version: '24.11.1', sqlite: true };
const WIN_PACKAGES = 'mingw-w64-ucrt-x86_64-python-gobject mingw-w64-ucrt-x86_64-gtk4 mingw-w64-ucrt-x86_64-libadwaita';
const RUN_QUERY = ['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'ASB'];
const WIN_SYSTEM = { name: os.version() || 'Windows', id: null, versionId: os.release(), family: 'windows', mode: 'normal' };
const NO_RUN_VALUE = Object.assign(new Error('ERROR: The system was unable to find the specified registry key or value.'), { code: 1 });

async function fakeWindows(t, { bins = ['bun.exe'], values = {}, node = WIN_NODE, msys2 = true, autostart = true, python = WIN_PYTHON } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-doctor-win-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of bins) await writeFile(path.join(directory, name), '');
  const calls = [];
  const reads = [];
  const deps = {
    platform: 'win32', node, env: { PATH: directory, ...(python && { ASB_PYTHON: python }) },
    exists: async (file) => { reads.push(file); return file === PACMAN && msys2; },
    // Windows reads no os-release and asks no engine for the firewall.
    read: async (file) => { throw new Error(`Unexpected read: ${file}`); },
    find: async () => { throw new Error('Unexpected engine lookup'); },
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      if (file === WIN_PYTHON) return { stdout: `${probe({ python: '3.12.7', qrcode: false, trayHost: null, ...values })}\n` };
      if (file === 'reg' && autostart === true) return { stdout: '    ASB    REG_SZ    powershell.exe\n' };
      if (file === 'reg') throw autostart;
      throw Object.assign(new Error(`Unexpected program: ${file}`), { code: 'ENOENT' });
    },
  };
  const run = async (argv = []) => {
    const out = [];
    const code = await main(argv, { ...deps, log: (line) => out.push(line), error: (line) => out.push(`error: ${line}`) });
    return { code, out };
  };
  return { directory, calls, reads, deps, run, lines: async () => format(await collect(deps)) };
}

test('Windows with the board ready prints the Windows checks and no commands', async (t) => {
  const system = await fakeWindows(t);
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out, [
    `ASB doctor: ${WIN_SYSTEM.name}, family windows`,
    '',
    'Engine',
    '  ok       Node.js 24.11.1 (C:\\Program Files\\nodejs\\node.exe), built-in SQLite',
    'Window',
    `  ok       PyGObject 3.50.0 (Python 3.12.7, ${WIN_PYTHON})`,
    '  ok       GTK 4.18.6',
    '  ok       Libadwaita 1.7.6',
    'Options',
    '  info     QR code: not available (MSYS2 has no Python qrcode package)',
    `  ok       Bun (${path.join(system.directory, 'bun.exe')}), for ASB Bridge`,
    '  ok       Autostart: Windows Run value',
  ]);
  // Only the Python probe and the Run value query run. Nothing asks for pacman.exe when the board is ready.
  assert.deepEqual(system.calls, [[WIN_PYTHON, '-c', PYTHON_PROBE], RUN_QUERY]);
  assert.deepEqual(system.reads, []);
  const data = await collect(system.deps);
  assert.deepEqual(data.system, WIN_SYSTEM);
  assert.deepEqual(data.board, { ok: true, reason: '' });
  assert.deepEqual(data.commands, { required: null, optional: null, node: null, firewall: [], msys2: null });
  assert.deepEqual(data.advice, []);
  const json = await system.run(['--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(json.out.join('\n'))), ['schema', 'system', 'checks', 'board', 'commands']);
});

test('Windows without MSYS2 prints the winget line, then the pacman line, and still exits 0', async (t) => {
  const system = await fakeWindows(t, { msys2: false, python: null, autostart: NO_RUN_VALUE });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out.slice(2), [
    'Engine',
    '  ok       Node.js 24.11.1 (C:\\Program Files\\nodejs\\node.exe), built-in SQLite',
    'Window',
    '  missing  Python 3',
    '  missing  PyGObject',
    '  missing  GTK 4',
    '  missing  Libadwaita',
    'Options',
    '  info     QR code: not available (MSYS2 has no Python qrcode package)',
    `  ok       Bun (${path.join(system.directory, 'bun.exe')}), for ASB Bridge`,
    '  info     Autostart: not installed',
    '',
    'Install MSYS2 and the board packages:',
    '  winget install --id MSYS2.MSYS2 -e',
    `  ${PACMAN} -S --needed ${WIN_PACKAGES}`,
  ]);
  // No Python was found, so the probe never ran. ASB prints the commands and never runs them.
  assert.deepEqual(system.calls, [RUN_QUERY]);
  assert.deepEqual(system.reads, [PACMAN]);
  const data = await collect(system.deps);
  assert.deepEqual(data.board, { ok: false, reason: 'Python 3 is not installed.' });
  assert.deepEqual(data.commands, { required: [PACMAN, '-S', '--needed', ...WIN_PACKAGES.split(' ')], optional: null, node: null, firewall: [],
    msys2: ['winget', 'install', '--id', 'MSYS2.MSYS2', '-e'] });
  // A Python that does not run is named in the row.
  const broken = await fakeWindows(t, { msys2: false });
  broken.deps.execFile = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  assert.equal(format(await collect(broken.deps))[5], `  missing  Python 3 (${WIN_PYTHON} does not run)`);
});

test('Windows with MSYS2 but without the board packages prints only the pacman line', async (t) => {
  const system = await fakeWindows(t, { values: { gi: null, gtk: null, adw: null, cairo: false } });
  const { code, out } = await system.run();
  assert.equal(code, 0);
  assert.deepEqual(out.slice(4, 9), ['Window', `  missing  PyGObject (Python 3.12.7, ${WIN_PYTHON})`, '  missing  GTK 4', '  missing  Libadwaita', 'Options']);
  assert.deepEqual(out.slice(-3), ['', 'Install the board packages:', `  ${PACMAN} -S --needed ${WIN_PACKAGES}`]);
  const data = await collect(system.deps);
  assert.equal(data.commands.msys2, null);
  assert.deepEqual(data.commands.required.slice(0, 3), [PACMAN, '-S', '--needed']);
  // PyGObject without GTK 4 or Libadwaita gets the same line.
  const half = await fakeWindows(t, { values: { gtk: null, adw: null } });
  assert.deepEqual((await half.lines()).slice(-2), ['Install the board packages:', `  ${PACMAN} -S --needed ${WIN_PACKAGES}`]);
});

test('Windows with GTK or Libadwaita too old prints the pacman update line', async (t) => {
  for (const values of [{ gtk: [4, 10, 5] }, { adw: [1, 3, 6] }, { gtk: [4, 10, 5], adw: [1, 3, 6] }]) {
    const system = await fakeWindows(t, { values });
    const lines = await system.lines();
    assert.deepEqual(lines.slice(-2), ['Install the board packages:', `  ${PACMAN} -Syu --needed ${WIN_PACKAGES}`]);
    assert.ok(lines.some((line) => /^  old      (GTK 4\.10\.5, needs 4\.12|Libadwaita 1\.3\.6, needs 1\.4) or later$/.test(line)), JSON.stringify(values));
    assert.deepEqual((await collect(system.deps)).commands.required.slice(0, 3), [PACMAN, '-Syu', '--needed']);
  }
  // The winget line comes first when pacman.exe is missing too.
  const system = await fakeWindows(t, { msys2: false, values: { gtk: [4, 10, 5] } });
  assert.deepEqual((await system.lines()).slice(-3), ['Install MSYS2 and the board packages:', '  winget install --id MSYS2.MSYS2 -e',
    `  ${PACMAN} -Syu --needed ${WIN_PACKAGES}`]);
});

test('Windows needs built-in SQLite for the engine and shows the QR code and the Run value as they are', async (t) => {
  const old = await fakeWindows(t, { node: { ...WIN_NODE, version: '22.12.0', sqlite: false } });
  const { code, out } = await old.run();
  assert.equal(code, 1);
  assert.equal(out[3], '  old      Node.js 22.12.0 (C:\\Program Files\\nodejs\\node.exe), needs 22.13 or later with built-in SQLite');
  const none = await fakeWindows(t, { node: null });
  assert.deepEqual([(await none.run()).code, (await none.lines())[3]], [1, '  missing  Node.js']);
  const full = await fakeWindows(t, { values: { qrcode: true }, bins: [], autostart: NO_RUN_VALUE });
  assert.deepEqual((await full.lines()).slice(-3), ['  ok       QR code', '  info     Bun: not found. ASB Bridge needs it.', '  info     Autostart: not installed']);
});

test('the Linux checks stay as they are, and the platform option picks the Windows checks', async (t) => {
  const system = await fakeSystem(t, { release: 'debian13' });
  const linux = await collect({ ...system.deps, platform: 'linux' });
  assert.deepEqual(linux, await collect(system.deps));
  assert.equal(linux.system.family, 'debian');
  assert.ok(linux.checks.some((check) => check.id === 'openssl'));
  assert.deepEqual(Object.keys(linux.commands), ['required', 'optional', 'node', 'firewall']);
  assert.ok(system.calls.every(([file]) => file !== 'reg'));
});
