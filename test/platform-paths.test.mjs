import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bunFolders, bunNotFound, cacheDir, configDir, findBun, runtimeDir, stateDir } from '../src/platform-paths.mjs';
import { addressKind, listPhoneAddresses, tlsFiles, WINDOWS_CERTIFICATE_SCRIPT } from '../src/phone-gateway.mjs';
import { defaultClaudeAppDir } from '../src/claude-data.mjs';
import { openCommandForUrl } from '../src/session-opener.mjs';
import { validateSourceLauncher } from '../src/app-sources.mjs';
import { RUN_KEY, trayArguments, trayCommand } from '../scripts/asb-engine.mjs';
import { firewallCommand } from '../scripts/asb-setup.mjs';
import { windowsNodeOk } from '../scripts/asb.mjs';

// Platform-neutral checks: they also run in the Windows CI job (test/windows-tests.json).

test('the ASB folders keep the Linux values and use APPDATA and LOCALAPPDATA on Windows', () => {
  const home = '/home/test';
  for (const env of [{}, { XDG_CONFIG_HOME: '/config', XDG_STATE_HOME: '/state', XDG_RUNTIME_DIR: '/run/user/1000' },
    { XDG_CONFIG_HOME: 'relative', XDG_STATE_HOME: 'relative-state', XDG_RUNTIME_DIR: 'relative-run' }]) {
    // The old expressions, byte for byte.
    assert.equal(configDir(env, 'linux', home), path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'asb'));
    assert.equal(stateDir(env, 'linux', home), path.posix.join(env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state'), 'asb'));
    // Without an absolute XDG_RUNTIME_DIR, the run folder in stateDir (plan L7).
    assert.equal(runtimeDir(env, 'linux', home), typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.startsWith('/')
      ? path.posix.join(env.XDG_RUNTIME_DIR, 'asb') : path.posix.join(env.XDG_STATE_HOME?.startsWith('/') ? env.XDG_STATE_HOME : '/home/test/.local/state', 'asb', 'run'));
  }
  assert.equal(configDir({}, 'linux', home), '/home/test/.config/asb');
  assert.equal(stateDir({}, 'linux', home), '/home/test/.local/state/asb');
  assert.equal(runtimeDir({}, 'linux', home), '/home/test/.local/state/asb/run');
  assert.equal(runtimeDir({ XDG_STATE_HOME: '/state', XDG_RUNTIME_DIR: '' }, 'linux', home), '/state/asb/run');
  // A relative XDG_STATE_HOME is not used for the runtime folder (the ASB Bridge rule); stateDir keeps it.
  assert.equal(runtimeDir({ XDG_STATE_HOME: 'relative-state' }, 'linux', home), '/home/test/.local/state/asb/run');
  assert.equal(stateDir({ XDG_STATE_HOME: 'relative-state' }, 'linux', home), 'relative-state/asb');
  const winHome = 'C:\\Users\\test';
  const env = { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local', XDG_CONFIG_HOME: '/ignored' };
  assert.equal(configDir(env, 'win32', winHome), 'D:\\Roaming\\asb');
  assert.equal(stateDir(env, 'win32', winHome), 'D:\\Local\\asb\\state');
  assert.equal(runtimeDir(env, 'win32', winHome), 'D:\\Local\\asb\\run');
  for (const missing of [{}, { APPDATA: 'relative', LOCALAPPDATA: '' }]) {
    assert.equal(configDir(missing, 'win32', winHome), 'C:\\Users\\test\\AppData\\Roaming\\asb');
    assert.equal(stateDir(missing, 'win32', winHome), 'C:\\Users\\test\\AppData\\Local\\asb\\state');
    assert.equal(runtimeDir(missing, 'win32', winHome), 'C:\\Users\\test\\AppData\\Local\\asb\\run');
  }
});

test('the cache folder follows the board launcher on Linux and is in LOCALAPPDATA on Windows', () => {
  const home = '/home/test';
  // Only an absolute XDG_CACHE_HOME counts, as in scripts/asb-board.py.
  assert.equal(cacheDir({}, 'linux', home), '/home/test/.cache/asb');
  assert.equal(cacheDir({ XDG_CACHE_HOME: '/cache' }, 'linux', home), '/cache/asb');
  assert.equal(cacheDir({ XDG_CACHE_HOME: 'relative-cache' }, 'linux', home), '/home/test/.cache/asb');
  assert.equal(cacheDir({ LOCALAPPDATA: 'D:\\Local', XDG_CACHE_HOME: '/ignored' }, 'win32', 'C:\\Users\\test'), 'D:\\Local\\asb\\cache');
  assert.equal(cacheDir({ LOCALAPPDATA: 'relative' }, 'win32', 'C:\\Users\\test'), 'C:\\Users\\test\\AppData\\Local\\asb\\cache');
});

test('the Bun folders are BUN_INSTALL/bin, then the user .bun/bin, and only an absolute path counts', () => {
  const folders = (platform, env) => bunFolders({ platform, env });
  assert.deepEqual(folders('linux', { HOME: '/home/a' }), ['/home/a/.bun/bin']);
  assert.deepEqual(folders('linux', { HOME: '/home/a', BUN_INSTALL: '/opt/bun' }), ['/opt/bun/bin', '/home/a/.bun/bin']);
  // The Bun installer sets BUN_INSTALL to the default folder: one entry.
  assert.deepEqual(folders('linux', { HOME: '/home/a', BUN_INSTALL: '/home/a/.bun' }), ['/home/a/.bun/bin']);
  assert.deepEqual(folders('linux', { HOME: 'relative', BUN_INSTALL: 'bun' }), []);
  assert.deepEqual(folders('linux', { HOME: '', BUN_INSTALL: '' }), []);
  assert.deepEqual(folders('linux', { USERPROFILE: 'C:\\Users\\a' }), []);
  assert.deepEqual(folders('win32', { USERPROFILE: 'C:\\Users\\a' }), ['C:\\Users\\a\\.bun\\bin']);
  assert.deepEqual(folders('win32', { USERPROFILE: 'C:\\Users\\a', BUN_INSTALL: 'D:\\tools\\bun' }), ['D:\\tools\\bun\\bin', 'C:\\Users\\a\\.bun\\bin']);
  assert.deepEqual(folders('win32', { HOME: '/home/a', BUN_INSTALL: 'bun' }), []);
  assert.equal(bunNotFound([]), 'Bun was not found on PATH.');
  assert.equal(bunNotFound(['/a/bin', '/b/bin']), 'Bun was not found on PATH or in /a/bin or /b/bin.');
});

// A PATH folder that does not exist, so that only the standard folders can give a Bun.
const NO_PATH = path.join(os.tmpdir(), 'asb-no-bun-folder');

test('on Windows the Bun lookup tries bun.exe in BUN_INSTALL\\bin, then in USERPROFILE\\.bun\\bin, with the file check of the caller', async () => {
  const files = new Set(['D:\\tools\\bun\\bin\\bun.exe', 'C:\\Users\\a\\.bun\\bin\\bun.exe']);
  const seen = [];
  const check = async (file, platform) => { seen.push([file, platform]); return files.has(file); };
  const env = { PATH: NO_PATH, USERPROFILE: 'C:\\Users\\a', BUN_INSTALL: 'D:\\tools\\bun' };
  assert.equal(await findBun({ platform: 'win32', env, check }), 'D:\\tools\\bun\\bin\\bun.exe');
  assert.deepEqual(seen, [['D:\\tools\\bun\\bin\\bun.exe', 'win32']]);
  files.delete('D:\\tools\\bun\\bin\\bun.exe');
  assert.equal(await findBun({ platform: 'win32', env, check }), 'C:\\Users\\a\\.bun\\bin\\bun.exe');
  files.clear();
  assert.equal(await findBun({ platform: 'win32', env, check }), '');
  // A relative BUN_INSTALL and a missing USERPROFILE give no candidate at all.
  seen.length = 0;
  assert.equal(await findBun({ platform: 'win32', env: { PATH: NO_PATH, BUN_INSTALL: 'bun' }, check }), '');
  assert.deepEqual(seen, []);
  files.add('/home/a/.bun/bin/bun');
  assert.equal(await findBun({ platform: 'linux', env: { PATH: NO_PATH, HOME: '/home/a' }, check }), '/home/a/.bun/bin/bun');
  assert.deepEqual(seen, [['/home/a/.bun/bin/bun', 'linux']]);
});

test('the Bun lookup takes PATH first, then BUN_INSTALL/bin, then ~/.bun/bin, and only a regular file that can run counts', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asb-bun-lookup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bun = async (folder, mode = 0o755) => {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'bun'), '#!/bin/sh\n', { mode });
    return path.join(folder, 'bun');
  };
  const [pathFolder, installFolder, homeFolder] = [path.join(dir, 'bin'), path.join(dir, 'install'), path.join(dir, 'home')];
  const find = () => findBun({ platform: 'linux', env: { PATH: pathFolder, BUN_INSTALL: installFolder, HOME: homeFolder } });
  assert.equal(await find(), '');
  const standard = await bun(path.join(homeFolder, '.bun', 'bin'), 0o644);
  // A file without the execute bit does not count, and neither does a folder named bun.
  assert.equal(await find(), '');
  await chmod(standard, 0o755);
  assert.equal(await find(), standard);
  const install = await bun(path.join(installFolder, 'bin'));
  assert.equal(await find(), install);
  await rm(install);
  await mkdir(install);
  assert.equal(await find(), standard);
  const onPath = await bun(pathFolder);
  assert.equal(await find(), onPath);
});

test('the network kinds know the Linux and Windows adapter names', () => {
  for (const [name, address, kind] of [['tailscale0', '100.101.102.103', 'tailscale'], ['Tailscale', '100.101.102.103', 'tailscale'],
    ['ztabc123', '10.147.20.1', 'zerotier'], ['ZeroTier One [8056c2e21c000001]', '10.147.20.1', 'zerotier'],
    ['Ethernet', '192.168.1.24', 'lan'], ['enp3s0', '192.168.1.24', 'lan'], ['Wi-Fi', '172.16.0.4', 'lan'],
    ['Ethernet', '100.101.102.103', ''], ['Tailscale', '8.8.8.8', ''], ['ZeroTier One [x]', '8.8.8.8', '']]) {
    assert.equal(addressKind(name, address), kind, `${name} ${address}`);
  }
  assert.deepEqual(listPhoneAddresses({ 'ZeroTier One [8056c2e21c000001]': [{ family: 'IPv4', address: '10.147.20.1' }],
    Ethernet: [{ family: 'IPv4', address: '192.168.1.24' }, { family: 'IPv6', address: 'fe80::1' }],
    Tailscale: [{ family: 'IPv4', address: '100.101.102.103' }] }).map((item) => item.kind), ['lan', 'zerotier', 'tailscale']);
});

test('the Windows certificate script takes the folder and passphrase only from the environment', () => {
  assert.deepEqual(tlsFiles('linux'), ['key.pem', 'cert.pem']);
  assert.deepEqual(tlsFiles('win32'), ['cert.pfx', 'pfx-pass', 'cert.cer']);
  assert.match(WINDOWS_CERTIFICATE_SCRIPT, /^\$ErrorActionPreference = 'Stop'\n/);
  assert.match(WINDOWS_CERTIFICATE_SCRIPT, /-KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy Exportable `\n  -CertStoreLocation Cert:\\CurrentUser\\My/);
  for (const part of ['$env:ASB_PFX_PASS', "Join-Path $env:ASB_TLS_DIR 'cert.pfx'", "Join-Path $env:ASB_TLS_DIR 'cert.cer'", '-Type CERT',
    '} finally { Remove-Item -LiteralPath $c.PSPath }']) assert.ok(WINDOWS_CERTIFICATE_SCRIPT.includes(part), part);
});

test('the Claude app folder on Windows is APPDATA, then the first Store package folder, else APPDATA', () => {
  const env = { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  const roaming = 'C:\\Users\\a\\AppData\\Roaming\\Claude';
  const packages = 'C:\\Users\\a\\AppData\\Local\\Packages';
  const store = (name) => `${packages}\\${name}\\LocalCache\\Roaming\\Claude`;
  const check = (existing, names) => defaultClaudeAppDir('win32', 'C:\\Users\\a', env, {
    exists: (file) => existing.includes(file), list: (folder) => { assert.equal(folder, packages); return names; } });
  assert.equal(check([roaming, store('Claude_b')], ['Claude_b']), roaming);
  assert.equal(check([store('Claude_a'), store('Claude_b')], ['Claude_b', 'Other', 'Claude_a']), store('Claude_a'));
  assert.equal(check([store('Claude_b')], ['Claude_a', 'Claude_b']), store('Claude_b'));
  assert.equal(check([], ['Claude_a']), roaming);
  assert.equal(defaultClaudeAppDir('win32', 'C:\\Users\\a', {}, { exists: () => false, list: () => { throw new Error('missing'); } }), roaming);
  assert.equal(defaultClaudeAppDir('linux', '/home/test', {}), '/home/test/.config/Claude');
});

test('a Windows session link must use plain URL characters, because cmd parses the others', () => {
  for (const url of ['codex://threads/019a2b3c-4d5e-7f60-8123-456789abcdef', 'claude://code/continue?session=local_0123abcd-0000-4000-8000-000000000000',
    'claude://claude.ai/code/session_01AbC']) {
    assert.deepEqual(openCommandForUrl(url, 'win32'), { command: 'cmd', args: ['/c', 'start', '', url] });
  }
  for (const url of ['codex://threads/a&calc', 'codex://threads/a|b', 'codex://threads/a^b', 'claude://x?a=%41', 'codex://a<b', 'codex://a>b',
    'codex://a"b', 'codex://a b', '://missing', '1codex://a']) {
    assert.throws(() => openCommandForUrl(url, 'win32'), /^Error: This session link cannot open on Windows\.$/, url);
  }
  assert.deepEqual(openCommandForUrl('codex://threads/a&b', 'linux'), { command: 'xdg-open', args: ['codex://threads/a&b'] });
});

test('a Windows launcher must be an existing .exe file with an app name; the execute bit is not checked', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'asb-launcher-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  for (const name of ['Claude.exe', 'ChatGPT.exe', 'codex.cmd', 'Claude']) await writeFile(path.join(folder, name), '', { mode: 0o644 });
  assert.equal(await validateSourceLauncher(path.join(folder, 'Claude.exe'), 'win32'), path.join(folder, 'Claude.exe'));
  assert.equal(await validateSourceLauncher(path.join(folder, 'ChatGPT.exe'), 'win32'), path.join(folder, 'ChatGPT.exe'));
  await assert.rejects(validateSourceLauncher(path.join(folder, 'Claude'), 'win32'), /Select an installed ChatGPT, Codex, or Claude launcher/);
  await assert.rejects(validateSourceLauncher(path.join(folder, 'codex.cmd'), 'win32'), /Select an installed/);
  await assert.rejects(validateSourceLauncher(path.join(folder, 'Codex.exe'), 'win32'), /must be an existing executable app file/);
  assert.equal(await validateSourceLauncher('', 'win32'), '');
});

test('the Run value starts the hidden tray script with the node.exe that runs ASB', () => {
  const root = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\agent-switch-board';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(RUN_KEY, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.deepEqual(trayArguments(root, node), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
    `${root}\\scripts\\asb-tray.ps1`, node]);
  assert.equal(trayCommand(root, node), 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '
    + `"${root}\\scripts\\asb-tray.ps1" "${node}"`);
});

test('setup prints a firewall rule with all selected addresses in one value, and Windows needs Node.js 22.13', () => {
  assert.equal(firewallCommand(['192.168.1.24', '10.147.20.1'], 4630, 'C:\\Program Files\\nodejs\\node.exe'),
    'New-NetFirewallRule -DisplayName "ASB engine" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4630 '
    + '-LocalAddress 192.168.1.24,10.147.20.1 -Program "C:\\Program Files\\nodejs\\node.exe"');
  for (const [version, ok] of [['22.12.0', false], ['22.13.0', true], ['22.20.1', true], ['20.19.0', false], ['24.0.0', true], ['23.1.0', true]]) {
    assert.equal(windowsNodeOk(version), ok, version);
  }
});
