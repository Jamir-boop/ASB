import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASB_APP_ID } from '../scripts/asb-icon.mjs';
import { build, checkRuntime, install, RUNTIME_FILES, uninstall } from '../scripts/asb-package.mjs';

test('release runtime includes the Claude remote reader imported by the switchboard', () => {
  assert.ok(RUNTIME_FILES.includes('src/claude-remote-data.mjs'));
});

test('release runtime includes the drawer glyph of the native row panel', () => {
  assert.ok(RUNTIME_FILES.includes('assets/icons/asb-drawer-symbolic.svg'));
});

test('release runtime includes the filter glyph of the native toolbar', () => {
  assert.ok(RUNTIME_FILES.includes('assets/icons/asb-filter-symbolic.svg'));
});

test('release runtime includes the card copy kind glyphs', () => {
  assert.ok(RUNTIME_FILES.includes('assets/icons/asb-link-symbolic.svg'));
  assert.ok(RUNTIME_FILES.includes('assets/icons/asb-globe-symbolic.svg'));
});

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

// The launcher starts a detached engine; it gets a private runtime folder and a fake systemctl, and the test stops it.
async function isolatedEngine(t, directory) {
  const runtimeDir = path.join(directory, 'runtime');
  const fakeBin = path.join(directory, 'fake-bin');
  await mkdir(runtimeDir, { mode: 0o700 });
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'systemctl'), '#!/bin/sh\necho disabled\nexit 1\n', { mode: 0o755 });
  const engines = [];
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stop = async () => {
    const runtime = JSON.parse(await readFile(path.join(runtimeDir, 'asb/service.json'), 'utf8'));
    engines.push(runtime.pid);
    process.kill(runtime.pid, 'SIGTERM');
    for (let tries = 0; tries < 100 && alive(runtime.pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(runtime.pid), false);
  };
  t.after(() => { for (const pid of engines) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  return { fakeBin, stop, env: { XDG_RUNTIME_DIR: runtimeDir, ASB_TRAY: '0' } };
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bridgeRuntimeFiles = [
  '.agents/plugins/marketplace.json', 'bridge/.codex-plugin/plugin.json', 'bridge/.mcp.json',
  'bridge/hooks/hooks.json', 'bridge/dist/server.js', 'bridge/dist/hook.js', 'bridge/dist/relay.js',
  'bridge/dist/opencode.js', 'bridge/LICENSE',
  'bridge/agent-skills/claude/bridge/SKILL.md', 'bridge/agent-skills/codex/bridge/SKILL.md',
  'bridge/agent-skills/opencode/bridge/SKILL.md',
  'bridge/agent-skills/codex/bridge/agents/openai.yaml', 'scripts/asb-bridge.mjs',
].sort();

test('the bridge runtime whitelist has exactly the fourteen required files', () => {
  assert.deepEqual(RUNTIME_FILES.filter((file) => file.startsWith('bridge/')
    || file === '.agents/plugins/marketplace.json' || file === 'scripts/asb-bridge.mjs'), bridgeRuntimeFiles);
});

test('agent commands and shared discovery are in the runtime payload', () => {
  for (const file of ['scripts/asb-agent.mjs', 'scripts/asb-instance.mjs']) assert.ok(RUNTIME_FILES.includes(file));
});

test('ASB payload imports are complete', async () => {
  for (const file of RUNTIME_FILES.filter((name) => name.endsWith('.mjs'))) {
    const source = await readFile(path.join(sourceRoot, file), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1] || match[2] || match[3];
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${file}: ${specifier}`);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      assert.ok(RUNTIME_FILES.includes(dependency), `${file}: missing ${dependency}`);
    }
  }
});

test('release payloads are reproducible and the user installer preserves other files and ASB state', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux packaging check.');
  try { execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' }); }
  catch { return t.skip('dpkg-deb is not installed.'); }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-package-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'))).version;
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const previousMask = process.umask(0o022);
  let artifacts, second;
  try {
    // The warning about a missing rpmbuild has its own test (asb-package-formats.test.mjs).
    artifacts = await build({ sourceRoot, outputDir: path.join(temporary, 'first'), warn: () => {} });
    process.umask(0o077);
    second = await build({ sourceRoot, outputDir: path.join(temporary, 'second'), warn: () => {} });
  } finally { process.umask(previousMask); }
  // The RPM is built only when rpmbuild exists. The PKGBUILD always follows. The loop below then compares the RPM bytes of the two builds too.
  let rpmbuild = true;
  try { execFileSync('rpmbuild', ['--version'], { stdio: 'ignore' }); } catch { rpmbuild = false; }
  const names = [`asb_${version}_all.deb`, `asb-${version}-linux.tar.gz`, ...rpmbuild ? [`asb-${version}-1.noarch.rpm`] : [], 'PKGBUILD'];
  for (const built of [artifacts, second]) assert.deepEqual(built.map((file) => path.basename(file)), names);
  for (let i = 0; i < artifacts.length; i++) assert.equal(sha256(await readFile(artifacts[i])), sha256(await readFile(second[i])));
  const sums = await readFile(path.join(temporary, 'first', 'SHA256SUMS'), 'utf8');
  assert.deepEqual(sums.trim().split('\n').map((line) => line.slice(66)), names);
  for (const file of artifacts) assert.ok(sums.includes(`${sha256(await readFile(file))}  ${path.basename(file)}\n`));
  const archiveFiles = execFileSync('tar', ['-tzf', artifacts[1]], { encoding: 'utf8' }).trim().split('\n').filter((name) => !name.endsWith('/'));
  assert.deepEqual(archiveFiles.sort(), RUNTIME_FILES.map((file) => `asb-${version}/${file}`).sort());
  const [debVersion, architecture, depends, recommends] = execFileSync('dpkg-deb', ['-f', artifacts[0], 'Version', 'Architecture', 'Depends', 'Recommends'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(debVersion, `Version: ${version}`);
  assert.equal(architecture, 'Architecture: all');
  assert.equal(depends, 'Depends: nodejs (>= 20), sqlite3, xdg-utils, openssl');
  // The board libraries are weak dependencies: a release with an old GTK still installs the engine.
  assert.equal(recommends, 'Recommends: python3-gi, python3-gi-cairo, gir1.2-gtk-4.0 (>= 4.12), gir1.2-adw-1 (>= 1.4), python3-qrcode, pipewire-bin | pulseaudio-utils | alsa-utils');
  const extracted = path.join(temporary, 'deb');
  execFileSync('dpkg-deb', ['-x', artifacts[0], extracted]);
  const control = path.join(temporary, 'control');
  execFileSync('dpkg-deb', ['-e', artifacts[0], control]);
  assert.deepEqual(await readdir(control), ['control']);
  const portable = path.join(temporary, 'portable');
  await mkdir(portable);
  execFileSync('tar', ['-xzf', artifacts[1], '-C', portable]);
  for (const payload of [path.join(extracted, 'usr/lib/asb'), path.join(portable, `asb-${version}`)]) {
    const files = await Promise.all((await readdir(payload, { recursive: true })).map(async (file) =>
      (await lstat(path.join(payload, file))).isFile() ? file : null));
    assert.deepEqual(files.filter(Boolean).sort(), RUNTIME_FILES);
    for (const file of bridgeRuntimeFiles) {
      assert.deepEqual(await readFile(path.join(payload, file)), await readFile(path.join(sourceRoot, file)));
    }
    for (const file of ['src', 'test', 'node_modules', 'scripts', 'package.json', 'bun.lock', 'README.md', 'STARTUP.md', 'PROTOCOL-COVERAGE.md', 'COMPARISON.md']) {
      await assert.rejects(lstat(path.join(payload, 'bridge', file)), { code: 'ENOENT' });
    }
    execFileSync(process.execPath, ['--input-type=module', '-e', 'await import("./src/switchboard.mjs"); await import("./scripts/asb-package.mjs");'], { cwd: payload, stdio: 'pipe' });
    assert.equal((await lstat(path.join(payload, 'scripts/asb'))).mode & 0o777, 0o755);
  }
  // The Debian chain: desktop entry, /usr/bin/asb, /usr/lib/asb/scripts/asb, asb-desktop.mjs.
  const wrapper = await readFile(path.join(extracted, 'usr/bin/asb'), 'utf8');
  assert.equal(wrapper, '#!/bin/sh\nexport ASB_SYSTEM_INSTALL=1\nexport ASB_INSTALLED_LAUNCHER=/usr/bin/asb\nexec /usr/lib/asb/scripts/asb "$@"\n');
  // Both values reach the program that the wrapper runs, so the tray, the service, and the autostart entry use /usr/bin/asb
  // and write no per-user app entry. The test runs env in place of /usr/lib/asb/scripts/asb.
  const exported = execFileSync('/bin/sh', ['-c', wrapper.replace('/usr/lib/asb/scripts/asb', '/usr/bin/env')], { env: {}, encoding: 'utf8' }).split('\n');
  assert.ok(exported.includes('ASB_SYSTEM_INSTALL=1'), exported.join('\n'));
  assert.ok(exported.includes('ASB_INSTALLED_LAUNCHER=/usr/bin/asb'), exported.join('\n'));
  const exec = (await readFile(path.join(extracted, 'usr/share/applications', `${ASB_APP_ID}.desktop`), 'utf8')).split('\n').find((line) => line.startsWith('Exec=')).slice(5);
  assert.equal(exec, '/usr/bin/asb');
  assert.ok((await lstat(path.join(extracted, exec))).isFile());
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  await new Promise((resolve) => holder.close(resolve));
  const launchHome = path.join(temporary, 'launch-home');
  const engine = await isolatedEngine(t, temporary);
  // A fake Python with a full board answers the probe, so the chain opens the (fake) window.
  const fakePython = path.join(temporary, 'fake-python');
  await writeFile(fakePython, `#!/bin/sh\nif [ "\${1:-}" = -c ]; then printf '%s\\n' '${JSON.stringify({ python: '3.13.5', gi: '3.50.0', gtk: [4, 18, 6],
    adw: [1, 7, 6], glib: [2, 84, 4], cairo: true, qrcode: true, trayHost: null })}'; fi\n`, { mode: 0o755 });
  const launched = execFileSync(path.join(extracted, 'usr/lib/asb/scripts/asb'), [], { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...engine.env,
    ASB_SYSTEM_INSTALL: '1', ASB_NODE: process.execPath, ASB_PYTHON: fakePython, PATH: `${engine.fakeBin}:/usr/bin:/bin`, PORT: String(port), HOME: launchHome,
    XDG_DATA_HOME: path.join(launchHome, 'data'), XDG_CONFIG_HOME: path.join(launchHome, 'config'), XDG_STATE_HOME: path.join(launchHome, 'state'),
    XDG_CACHE_HOME: path.join(launchHome, 'cache'), CODEX_HOME: path.join(launchHome, 'codex'), CLAUDE_APP_DIR: path.join(launchHome, 'claude'),
    CLAUDE_CODE_CONFIG_DIR: path.join(launchHome, 'claude-code'),
  } });
  await engine.stop();
  assert.ok(launched.includes(`ASB: http://127.0.0.1:${port}\n`), launched);
  await assert.rejects(lstat(path.join(launchHome, 'data/applications')), { code: 'ENOENT' });
  assert.equal((await lstat(path.join(extracted, 'usr/bin/asb'))).mode & 0o777, 0o755);
  assert.equal(sha256(await readFile(path.join(extracted, 'usr/share/icons/hicolor/scalable/apps', `${ASB_APP_ID}.svg`))), 'c5c9c4472ef283ef8c3eaa1ff3f4758f5e52bb642ed91a3997b36f0a27bf41a0');

  const home = path.join(temporary, 'home');
  const dataDir = path.join(home, '.local/share');
  const binDir = path.join(home, '.local/bin');
  const runtime = { nodeExecutable: process.execPath, pythonExecutable: '/usr/bin/python3' };
  const options = { sourceRoot, dataDir, binDir, check: async () => runtime };
  await assert.rejects(install({ ...options, check: async () => { throw new Error('Missing GTK.'); } }), /Missing GTK/);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
  await mkdir(binDir, { recursive: true });
  const unrelated = path.join(temporary, 'unrelated');
  await writeFile(unrelated, 'User file\n');
  await symlink(unrelated, path.join(binDir, 'asb'));
  await assert.rejects(install(options), /linked or non-file/);
  assert.equal(await readFile(unrelated, 'utf8'), 'User file\n');
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' });
  await rm(path.join(binDir, 'asb'));
  await writeFile(path.join(binDir, 'asb'), '#!/bin/sh\n# User launcher\n');
  await assert.rejects(install(options), /will not replace this launcher/);
  await rm(path.join(binDir, 'asb'));
  await mkdir(path.join(dataDir, 'applications'), { recursive: true });
  await writeFile(path.join(dataDir, 'applications', 'other.desktop'), 'User launcher\n');
  await mkdir(path.join(dataDir, 'icons'), { recursive: true });
  await symlink(temporary, path.join(dataDir, 'icons', 'hicolor'));
  await assert.rejects(install(options), /linked or non-directory/);
  await rm(path.join(dataDir, 'icons', 'hicolor'));
  const configDir = path.join(home, '.config');
  const stateDir = path.join(home, '.local/state');
  await mkdir(path.join(configDir, 'asb'), { recursive: true });
  await mkdir(path.join(stateDir, 'asb'), { recursive: true });
  await writeFile(path.join(configDir, 'asb', 'layout.json'), '{"view":"comfortable","columnWidth":240}\n');
  await writeFile(path.join(stateDir, 'asb', 'pending.json'), '{"pins":["saved"],"unread":["saved"]}\n');
  const result = await install(options);
  assert.equal(result.directory, path.join(dataDir, 'asb', 'releases', version));
  assert.equal(result.launcher, path.join(binDir, 'asb'));
  assert.equal((await lstat(result.launcher)).mode & 0o777, 0o755);
  assert.ok((await readFile(path.join(dataDir, 'applications', `${ASB_APP_ID}.desktop`), 'utf8')).includes(`Exec="${result.launcher}"\n`));
  await install(options);
  assert.deepEqual(await readdir(path.join(dataDir, 'asb', 'releases')), [version]);
  // A launcher must work from GNOME's short PATH and an unrelated directory.
  const removed = JSON.parse(execFileSync(result.launcher, ['--package', 'uninstall'], {
    cwd: temporary, encoding: 'utf8', env: { ...process.env, HOME: home, XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir, PATH: '/nonexistent' },
  }));
  assert.deepEqual(removed.kept, []);
  assert.match(removed.message, /settings, pins, and unread state were kept/i);
  assert.equal(await readFile(path.join(stateDir, 'asb', 'pending.json'), 'utf8'), '{"pins":["saved"],"unread":["saved"]}\n');
  assert.equal(await readFile(path.join(configDir, 'asb', 'layout.json'), 'utf8'), '{"view":"comfortable","columnWidth":240}\n');
  assert.equal(await readFile(path.join(dataDir, 'applications', 'other.desktop'), 'utf8'), 'User launcher\n');
  await assert.rejects(lstat(result.launcher), { code: 'ENOENT' });
  await install(options);
  const desktop = path.join(dataDir, 'applications', `${ASB_APP_ID}.desktop`);
  await writeFile(desktop, 'User replacement\n');
  assert.ok((await uninstall(options)).kept.includes(desktop));
  assert.equal(await readFile(desktop, 'utf8'), 'User replacement\n');
});

test('package commands reject extra arguments before checks or writes and install only prints the bridge hint', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-package-bridge-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  for (const file of RUNTIME_FILES) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await copyFile(path.join(sourceRoot, file), path.join(source, file));
  }
  // Exercise the real argument parser with a display-free runtime check.
  const packageScript = path.join(source, 'scripts/asb-package.mjs');
  const code = await readFile(packageScript, 'utf8');
  const start = code.indexOf('export async function checkRuntime(');
  const end = code.indexOf('\nfunction locations(', start);
  assert.ok(start >= 0 && end > start);
  await writeFile(packageScript, code.slice(0, start)
    + 'export async function checkRuntime() { await writeFile(process.env.ASB_PACKAGE_TEST_LOG, "runtime\\n", { flag: "a" }); return { nodeExecutable: process.execPath, pythonExecutable: "/usr/bin/python3" }; }\n'
    + code.slice(end));
  await writeFile(path.join(source, 'scripts/asb-bridge.mjs'),
    'import { appendFileSync } from "node:fs"; appendFileSync(process.env.ASB_PACKAGE_TEST_LOG, "bridge\\n");\n');
  const home = path.join(temporary, 'home');
  const log = path.join(temporary, 'actions.log');
  const staged = path.join(temporary, 'staged');
  const codexHome = path.join(home, ".codex home's $(not-a-command)");
  const claudeHome = path.join(home, '.claude');
  const env = { ...process.env, ASB_NODE: process.execPath, HOME: home, PATH: '/usr/bin:/bin',
    XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
    ASB_PACKAGE_TEST_LOG: log };
  // As scripts/asb.mjs does: Node.js 22 prints the SQLite ExperimentalWarning on stderr.
  const run = (args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', packageScript, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  for (const args of [[], ['unknown'], ['constructor'], ['install', '--bridge-codex-home'],
    ['install', '--bridge-codex-home', codexHome], ['install', '--bridge-codex-home', '--bridge-claude'],
    ['install', '--bridge-codex-home', ''], ['install', '--bridge-claude'],
    ['install', '--bridge-codex-home', codexHome, '--bridge-claude'], ['install', '--all'],
    ['build', '--bridge-claude'], ['uninstall', '--bridge-claude'], ['check', '--bridge-claude'],
    ['stage'], ['stage', ''], ['stage', staged, 'extra'], ['stage', staged, ''], ['build', staged], ['check', staged]]) {
    assert.throws(() => run(args), (error) => error.status === 1 && /Use: asb-package\.mjs build\|install\|uninstall\|check\|stage <folder>/.test(String(error.stderr)));
    await assert.rejects(lstat(log), { code: 'ENOENT' });
    await assert.rejects(lstat(home), { code: 'ENOENT' });
    await assert.rejects(lstat(staged), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(source, 'dist')), { code: 'ENOENT' });
  }
  const optional = 'Optional: run "asb bridge install --all" to let your Claude Code and Codex chats message each other.';
  assert.equal(run(['install']).split('\n').filter((line) => line === optional).length, 1);
  assert.equal(await readFile(log, 'utf8'), 'runtime\n');
  for (const directory of [codexHome, claudeHome]) await assert.rejects(lstat(directory), { code: 'ENOENT' });
  const version = JSON.parse(await readFile(path.join(source, 'package.json'))).version;
  const installedRoot = path.join(env.XDG_DATA_HOME, 'asb/releases', version);
  assert.ok((await lstat(path.join(home, '.local/bin/asb'))).isFile());
  await assert.rejects(lstat(path.join(env.XDG_DATA_HOME, 'asb/.install-lock')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.dirname(installedRoot)), [version]);
});

test('the install check refuses without the engine tier and continues without the window', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-package-check-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, 'bin');
  await mkdir(bin);
  for (const name of ['sqlite3', 'openssl', 'xdg-open']) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { PATH: bin, ASB_PYTHON: '/opt/python3' };
  const node = { path: '/usr/bin/node', version: '20.19.2', sqlite: false };
  const probe = (values) => async (file, args) => {
    assert.deepEqual([file, args[0]], ['/opt/python3', '-c']);
    return { stdout: JSON.stringify({ python: '3.11.2', gi: null, gtk: null, adw: null, glib: null, cairo: false, qrcode: false, trayHost: null, ...values }) };
  };
  const check = async (values) => {
    const warnings = [];
    const result = await checkRuntime({ env, platform: 'linux', node, execFile: probe(values), warn: (line) => warnings.push(line) });
    return { result, warnings };
  };
  const board = await check({ gi: '3.42.2', gtk: [4, 18, 0], adw: [1, 7, 0] });
  assert.deepEqual([board.result.pythonExecutable, board.result.sqliteDirectory, board.result.boardOk, board.warnings], ['/opt/python3', bin, true, []]);
  const old = await check({ gi: '3.42.2', gtk: [4, 8, 3], adw: [1, 2, 2] });
  // Old GTK with PyGObject keeps the Python for the tray.
  assert.deepEqual([old.result.pythonExecutable, old.result.boardOk], ['/opt/python3', false]);
  assert.deepEqual(old.warnings, ['ASB will run without its window: GTK 4.8 is older than 4.12. Libadwaita 1.2 is older than 1.4. Run asb doctor for details.']);
  const noGi = await check({});
  assert.deepEqual([noGi.result.pythonExecutable, noGi.result.boardOk], [null, false]);
  assert.deepEqual(noGi.warnings, ['ASB will run without its window: PyGObject is not installed. Run asb doctor for details.']);
  await rm(path.join(bin, 'openssl'));
  await assert.rejects(checkRuntime({ env, platform: 'linux', node, execFile: probe({}), warn: () => {} }), /^Error: openssl is not installed\.$/);
  await assert.rejects(checkRuntime({ env, platform: 'linux', node: { ...node, version: '18.19.0' }, execFile: probe({}) }), /Node\.js 18\.19\.0 is older than 20\./);

  // The launcher sets ASB_PYTHON only for a Python with PyGObject.
  for (const pythonExecutable of [null, '/opt/python3']) {
    const dataDir = path.join(temporary, `data-${Boolean(pythonExecutable)}`);
    const result = await install({ sourceRoot, dataDir, binDir: path.join(dataDir, 'bin'),
      check: async () => ({ nodeExecutable: process.execPath, pythonExecutable }) });
    const wrapper = await readFile(result.launcher, 'utf8');
    assert.equal(wrapper.includes('ASB_PYTHON'), Boolean(pythonExecutable), wrapper);
    if (pythonExecutable) assert.ok(wrapper.includes("export ASB_PYTHON='/opt/python3'\n"));
  }
});

test('an install without the board writes no icon or desktop entry, and uninstall removes the rest', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-package-engine-only-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, 'data');
  const options = { sourceRoot, dataDir, binDir: path.join(temporary, 'bin'),
    check: async () => ({ nodeExecutable: process.execPath, pythonExecutable: '/opt/python3', boardOk: false }) };
  const result = await install(options);
  const icon = path.join(dataDir, 'icons/hicolor/scalable/apps', `${ASB_APP_ID}.svg`);
  const desktop = path.join(dataDir, 'applications', `${ASB_APP_ID}.desktop`);
  for (const file of [icon, desktop]) await assert.rejects(lstat(file), { code: 'ENOENT' });
  const record = JSON.parse(await readFile(path.join(dataDir, 'asb/install.json'), 'utf8'));
  assert.deepEqual(Object.keys(record.files), ['launcher']);
  const removed = await uninstall(options);
  assert.deepEqual(removed.kept, []);
  assert.deepEqual(removed.removed, [result.directory, result.launcher]);
  await assert.rejects(lstat(path.join(dataDir, 'asb')), { code: 'ENOENT' });
  await assert.rejects(lstat(result.launcher), { code: 'ENOENT' });
});

test('an install without the board removes the icon and desktop entry of a board install, but keeps an edited entry', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-package-board-to-engine-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const edited of [false, true]) {
    const dataDir = path.join(temporary, `data-${edited}`);
    const options = { sourceRoot, dataDir, binDir: path.join(temporary, `bin-${edited}`) };
    const runtime = { nodeExecutable: process.execPath, pythonExecutable: '/opt/python3' };
    const icon = path.join(dataDir, 'icons/hicolor/scalable/apps', `${ASB_APP_ID}.svg`);
    const desktop = path.join(dataDir, 'applications', `${ASB_APP_ID}.desktop`);
    await install({ ...options, check: async () => ({ ...runtime, boardOk: true }) });
    for (const file of [icon, desktop]) assert.ok((await lstat(file)).isFile());
    if (edited) await writeFile(desktop, 'User edit.\n');
    const result = await install({ ...options, check: async () => ({ ...runtime, boardOk: false }) });
    await assert.rejects(lstat(icon), { code: 'ENOENT' });
    if (edited) assert.equal(await readFile(desktop, 'utf8'), 'User edit.\n');
    else await assert.rejects(lstat(desktop), { code: 'ENOENT' });
    const record = JSON.parse(await readFile(path.join(dataDir, 'asb/install.json'), 'utf8'));
    assert.deepEqual(Object.keys(record.files), ['launcher']);
    const removed = await uninstall(options);
    // An edited entry is not ASB's own: uninstall keeps it and the install record.
    assert.deepEqual(removed.kept, edited ? [desktop] : []);
    assert.deepEqual(removed.removed, [result.directory, result.launcher]);
    if (edited) assert.equal(await readFile(desktop, 'utf8'), 'User edit.\n');
    else await assert.rejects(lstat(path.join(dataDir, 'asb')), { code: 'ENOENT' });
  }
});

test('safe unknown install-record files stay managed and edited, linked, or unlisted files stay protected', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-managed-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const options = { sourceRoot, dataDir: path.join(temporary, 'data'), binDir: path.join(temporary, 'bin'),
    check: async () => ({ nodeExecutable: process.execPath, pythonExecutable: '/usr/bin/python3' }) };
  const current = await install(options);
  const manifestPath = path.join(options.dataDir, 'asb/install.json');
  const name = 'extras/.synthetic-managed.txt';
  const managedPath = path.join(current.directory, name);
  const bytes = Buffer.from('Synthetic managed file.\n');
  const seedManaged = async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(managedPath, bytes);
    manifest.releases[current.version][name] = sha256(bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  };
  await seedManaged();
  await install(options);
  await assert.rejects(lstat(managedPath), { code: 'ENOENT' });
  await seedManaged();
  await writeFile(managedPath, 'User edit.\n');
  await assert.rejects(install(options), /edited release file/);
  assert.ok((await uninstall(options)).kept.includes(current.directory));
  assert.equal(await readFile(managedPath, 'utf8'), 'User edit.\n');
  await writeFile(managedPath, bytes);
  const unlisted = path.join(current.directory, 'user-file.txt');
  await writeFile(unlisted, 'User file.\n');
  await assert.rejects(install(options), /contains other files/);
  assert.ok((await uninstall(options)).kept.includes(current.directory));
  await rm(unlisted);
  const outside = path.join(temporary, 'outside.txt');
  await writeFile(outside, 'Outside file.\n');
  await rm(managedPath);
  await symlink(outside, managedPath);
  await assert.rejects(install(options), /linked or non-file/);
  assert.ok((await uninstall(options)).kept.includes(current.directory));
  assert.equal(await readFile(outside, 'utf8'), 'Outside file.\n');
  await rm(managedPath);
  await writeFile(managedPath, bytes);
  assert.deepEqual((await uninstall(options)).kept, []);
  await assert.rejects(lstat(current.directory), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(options.dataDir, 'asb')), { code: 'ENOENT' });
  assert.equal(await readFile(outside, 'utf8'), 'Outside file.\n');
});

test('install records reject traversal, ambiguous separators, controls, versions, and malformed hashes before removal', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asb-record-shape-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, 'data');
  const manifestPath = path.join(dataDir, 'asb/install.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const outside = path.join(temporary, 'outside.txt');
  await writeFile(outside, 'Outside file.\n');
  const record = (name, hash = 'a'.repeat(64), release = '1.3.0') => ({
    appId: ASB_APP_ID, schema: 1, version: '1.3.0', releases: { [release]: { [name]: hash } }, files: {},
  });
  const invalid = ['', '.', '..', '../outside.txt', 'src/../outside.txt', '/outside.txt', './file', 'src/./file',
    'src//file', 'src/', 'src\\file', 'C:/file', 'C:file', 'src/\u0000file', 'src/\nfile', 'src/%2e%2e/file']
    .map((name) => record(name));
  invalid.push(record('file', 'invalid'), record('file', 'A'.repeat(64)), record('file', ['a'.repeat(64)]),
    record('file', 'a'.repeat(64), '../outside'), { ...record('file'), version: '../outside' });
  for (const value of invalid) {
    const bytes = `${JSON.stringify(value)}\n`;
    await writeFile(manifestPath, bytes);
    await assert.rejects(uninstall({ dataDir, binDir: path.join(temporary, 'bin') }), /install record/);
    assert.equal(await readFile(manifestPath, 'utf8'), bytes);
    assert.equal(await readFile(outside, 'utf8'), 'Outside file.\n');
  }
});

test('the Windows CI list names existing test files once, and the workflow runs that list', async () => {
  const list = JSON.parse(await readFile(new URL('./windows-tests.json', import.meta.url), 'utf8'));
  assert.ok(list.length > 0 && new Set(list).size === list.length);
  for (const file of list) {
    assert.match(file, /^test\/[a-z0-9-]+\.test\.mjs$/);
    assert.ok((await lstat(new URL(`../${file}`, import.meta.url))).isFile(), file);
  }
  for (const file of ['test/machine-group.test.mjs', 'test/machine-peers.test.mjs', 'test/platform-paths.test.mjs']) assert.ok(list.includes(file), file);
  const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("require('./test/windows-tests.json')"));
  assert.match(workflow, /runs-on: windows-latest/);
});

test('the npm package has the runtime files, the asb command, and no tests, documents, Android, or demo files', () => {
  const pkg = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0];
  const files = pkg.files.map((item) => item.path);
  for (const file of RUNTIME_FILES) assert.ok(files.includes(file), file);
  for (const file of ['scripts/asb.mjs', 'scripts/asb-tray.ps1', 'assets/icons/asb-tray-32.png', 'assets/icons/asb.ico']) assert.ok(files.includes(file), file);
  assert.deepEqual(files.filter((file) => /^(android|demo|docs|test|nix|dist|\.impeccable|bridge\/src|bridge\/test)\/|^flake\./.test(file)), []);
  // npm links bin files; the POSIX launcher needs the execute bit too.
  assert.ok(pkg.files.find((item) => item.path === 'scripts/asb.mjs').mode & 0o111);
});
