import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASB_APP_ID } from '../scripts/asb-icon.mjs';
import { build, pkgbuild, rpmSpec, RUNTIME_FILES, writePayload } from '../scripts/asb-package.mjs';

// The release formats other than the .deb: the RPM, the PKGBUILD, and the Nix flake. These tests need Linux tools, so the Windows CI list does not run them.
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8')).version;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const has = (command) => {
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
};
const temporaryFolder = async (t, name) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), `asb-${name}-`));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
};
const regularFiles = async (root) => {
  const files = [];
  for (const name of await readdir(root, { recursive: true })) if ((await lstat(path.join(root, name))).isFile()) files.push(name);
  return files.sort();
};
const LAUNCHER = '#!/bin/sh\nexport ASB_SYSTEM_INSTALL=1\nexport ASB_INSTALLED_LAUNCHER=/usr/bin/asb\nexec /usr/lib/asb/scripts/asb "$@"\n';
const SPEC_REQUIRES = ['(nodejs >= 20 or nodejs-default or nodejs22 or nodejs24)', '(sqlite or sqlite3)', 'openssl', 'xdg-utils'];
const SPEC_RECOMMENDS = ['(python3-gobject or python313-gobject)', 'python3', '(gobject-introspection if python3-gobject)', 'python313-gobject-cairo',
  '(gtk4 >= 4.12 or typelib-1_0-Gtk-4_0 >= 4.12)', '(libglvnd-gles if gtk4)', '(libadwaita >= 1.4 or typelib-1_0-Adw-1 >= 1.4)', '(python3-qrcode-core or python313-qrcode)',
  '(pipewire-utils or pipewire-tools or pulseaudio-utils or alsa-utils)'];

test('the RPM spec has the fields, the dependencies, and the file list of the plan', () => {
  const spec = rpmSpec('1.9.0');
  const tags = {};
  for (const [, name, value] of spec.matchAll(/^([A-Za-z]+): +(.+)$/gm)) (tags[name] ??= []).push(value);
  assert.deepEqual(tags, { Name: ['asb'], Version: ['1.9.0'], Release: ['1'], Summary: ['Local session switch board for Codex and Claude Desktop Code'],
    License: ['MIT'], URL: ['https://github.com/Jamir-boop/ASB'], BuildArch: ['noarch'], AutoReqProv: ['no'], Requires: SPEC_REQUIRES, Recommends: SPEC_RECOMMENDS });
  assert.ok(spec.startsWith('%global debug_package %{nil}\n%global __os_install_post %{nil}\n%global _build_id_links none\nName:'));
  assert.ok(spec.includes('\n%install\ncp -a %{payload}/. %{buildroot}/\n'));
  assert.ok(spec.endsWith(`\n%files\n/usr/lib/asb\n/usr/bin/asb\n/usr/share/applications/${ASB_APP_ID}.desktop\n/usr/share/icons/hicolor/scalable/apps/${ASB_APP_ID}.svg\n`
    + '%license /usr/share/licenses/asb/LICENSE\n'));
  assert.match(rpmSpec('2.10.3'), /^Version: {8}2\.10\.3$/m);
});

test('the Debian and RPM payloads differ only in the license path, and both have the launcher that sets ASB_INSTALLED_LAUNCHER', async (t) => {
  const temporary = await temporaryFolder(t, 'payload');
  const deb = path.join(temporary, 'deb');
  const rpm = path.join(temporary, 'rpm');
  await writePayload(deb, sourceRoot, 'usr/share/doc/asb/copyright');
  await writePayload(rpm, sourceRoot, 'usr/share/licenses/asb/LICENSE');
  const [debFiles, rpmFiles] = [await regularFiles(deb), await regularFiles(rpm)];
  assert.deepEqual(debFiles.filter((file) => !file.startsWith('usr/share/doc/')), rpmFiles.filter((file) => !file.startsWith('usr/share/licenses/')));
  assert.deepEqual(debFiles.filter((file) => file.startsWith('usr/share/doc/')), ['usr/share/doc/asb/copyright']);
  assert.deepEqual(rpmFiles.filter((file) => file.startsWith('usr/share/licenses/')), ['usr/share/licenses/asb/LICENSE']);
  assert.deepEqual(rpmFiles.filter((file) => file.startsWith('usr/lib/asb/')).map((file) => file.slice('usr/lib/asb/'.length)), RUNTIME_FILES);
  const license = await readFile(path.join(sourceRoot, 'LICENSE'));
  assert.deepEqual(await readFile(path.join(deb, 'usr/share/doc/asb/copyright')), license);
  assert.deepEqual(await readFile(path.join(rpm, 'usr/share/licenses/asb/LICENSE')), license);
  for (const root of [deb, rpm]) {
    assert.equal(await readFile(path.join(root, 'usr/bin/asb'), 'utf8'), LAUNCHER);
    assert.equal((await lstat(path.join(root, 'usr/bin/asb'))).mode & 0o100, 0o100);
  }
  assert.equal(await readFile(path.join(deb, 'usr/share/applications', `${ASB_APP_ID}.desktop`), 'utf8'),
    await readFile(path.join(rpm, 'usr/share/applications', `${ASB_APP_ID}.desktop`), 'utf8'));
});

test('the stage command copies the runtime files to a new or an empty folder and refuses a missing folder', async (t) => {
  const temporary = await temporaryFolder(t, 'stage');
  const packageScript = path.join(sourceRoot, 'scripts/asb-package.mjs');
  const run = (...args) => execFileSync(process.execPath, [packageScript, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const fresh = path.join(temporary, 'new/nested');
  const empty = path.join(temporary, 'empty');
  await mkdir(empty);
  for (const folder of [fresh, empty, fresh]) {
    assert.deepEqual(JSON.parse(run('stage', folder)), { directory: folder, files: RUNTIME_FILES.length });
    assert.deepEqual(await regularFiles(folder), RUNTIME_FILES);
    assert.equal((await lstat(path.join(folder, 'scripts/asb'))).mode & 0o777, 0o755);
    assert.equal((await lstat(path.join(folder, 'package.json'))).mode & 0o777, 0o644);
    assert.deepEqual(await readFile(path.join(folder, 'scripts/asb-package.mjs')), await readFile(packageScript));
  }
  for (const args of [['stage'], ['stage', ''], ['stage', path.join(temporary, 'extra'), 'more']]) {
    assert.throws(() => run(...args), (error) => error.status === 1 && /Use: asb-package\.mjs build\|install\|uninstall\|check\|stage <folder>/.test(String(error.stderr)));
  }
  await assert.rejects(lstat(path.join(temporary, 'extra')), { code: 'ENOENT' });
});

test('the Nix package stages the runtime files and wraps the launcher like the Debian package', async (t) => {
  const nix = await readFile(path.join(sourceRoot, 'nix/package.nix'), 'utf8');
  for (const word of ['node scripts/asb-package.mjs stage $out/lib/asb', '--set ASB_SYSTEM_INSTALL 1', '--set ASB_INSTALLED_LAUNCHER $out/bin/asb',
    '--set ASB_NODE ${nodejs_24}/bin/node', '--set ASB_PYTHON ${python}/bin/python3', '--prefix PATH : ${tools}', '"\'\'${gappsWrapperArgs[@]}"',
    'dontWrapGApps = true;', 'makeWrapper $out/lib/asb/scripts/asb $out/bin/asb', 'ps.pygobject3', 'ps.pycairo', 'ps.qrcode', 'stdenvNoCC.mkDerivation',
    `install -Dm644 assets/icons/${ASB_APP_ID}.svg`]) assert.ok(nix.includes(word), word);
  const list = (head) => nix.match(new RegExp(`${head} \\[([^\\]]*)\\]`))[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(list('nativeBuildInputs ='), ['nodejs_24', 'makeWrapper', 'wrapGAppsHook4', 'gobject-introspection']);
  assert.deepEqual(list('buildInputs ='), ['gtk4', 'libadwaita']);
  assert.deepEqual(list('tools = lib\\.makeBinPath'), ['xdg-utils', 'openssl', 'sqlite', 'pipewire', 'alsa-utils']);
  // The gapps arguments exist only after the install phase, so the wrapper is made in postFixup.
  assert.ok(nix.indexOf('postFixup = \'\'') < nix.indexOf('makeWrapper $out/lib/asb'));
  // The desktop entry is the Debian one. Only the two paths are store paths.
  const nixEntry = nix.match(/<<EOF\n([\s\S]*?)\n    EOF\n/)[1].replace(/^ {4}/gm, '');
  const temporary = await temporaryFolder(t, 'nix-entry');
  await writePayload(temporary, sourceRoot, 'usr/share/doc/asb/copyright');
  const debEntry = await readFile(path.join(temporary, 'usr/share/applications', `${ASB_APP_ID}.desktop`), 'utf8');
  const keep = (text) => text.trim().split('\n').filter((line) => !/^(Exec|Icon)=/.test(line));
  assert.deepEqual(keep(nixEntry), keep(debEntry));
  assert.ok(nixEntry.includes('Exec=$out/bin/asb\n') && nixEntry.includes(`Icon=$out/share/icons/hicolor/scalable/apps/${ASB_APP_ID}.svg\n`));
  const flake = await readFile(path.join(sourceRoot, 'flake.nix'), 'utf8');
  for (const word of ['github:NixOS/nixpkgs/nixos-26.05', '"x86_64-linux"', '"aarch64-linux"', 'callPackage ./nix/package.nix', 'packages = ', 'apps = ',
    '/bin/asb"']) assert.ok(flake.includes(word), word);
  // The npm package, the portable archive, and the packages ship no Nix file, lock file, or build output.
  assert.deepEqual(RUNTIME_FILES.filter((file) => /^(nix|dist)\/|^flake\./.test(file)), []);
});

// A fake rpmbuild in front of PATH records the call and the payload, and makes the file that rpmbuild would make. The test then needs no RPM tools.
test('the build runs rpmbuild with the reproducible settings on a payload with fixed modes and times', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux packaging check.');
  if (!has('dpkg-deb')) return t.skip('dpkg-deb is not installed.');
  const temporary = await temporaryFolder(t, 'fake-rpmbuild');
  const fakeBin = path.join(temporary, 'bin');
  const seenFile = path.join(temporary, 'seen.json');
  const rpmName = `asb-${version}-1.noarch.rpm`;
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'rpmbuild'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
const define = (name) => args.find((value) => value.startsWith(name + ' ')).slice(name.length + 1);
const payload = define('payload');
const stat = (name) => { const s = fs.lstatSync(payload + '/' + name); return [name, s.mode & 0o7777, s.mtimeMs / 1000, s.isDirectory()]; };
const files = fs.readdirSync(payload, { recursive: true }).map(stat).concat([stat('')]);
fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ epoch: process.env.SOURCE_DATE_EPOCH, args, spec: fs.readFileSync(args.at(-1), 'utf8'), files }));
fs.mkdirSync(define('_topdir') + '/RPMS/noarch', { recursive: true });
fs.writeFileSync(define('_topdir') + '/RPMS/noarch/${rpmName}', 'fake rpm\\n');
`, { mode: 0o755 });
  const environment = { PATH: process.env.PATH, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH };
  t.after(() => { for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.PATH = `${fakeBin}:${environment.PATH}`;
  process.env.SOURCE_DATE_EPOCH = '1700000000';
  const outputDir = path.join(temporary, 'dist');
  const warnings = [];
  const artifacts = await build({ sourceRoot, outputDir, warn: (line) => warnings.push(line) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(artifacts.map((file) => path.basename(file)), [`asb_${version}_all.deb`, `asb-${version}-linux.tar.gz`, rpmName, 'PKGBUILD']);
  assert.equal(await readFile(artifacts[2], 'utf8'), 'fake rpm\n');
  assert.ok((await readFile(path.join(outputDir, 'SHA256SUMS'), 'utf8')).includes(`${sha256('fake rpm\n')}  ${rpmName}\n`));
  const seen = JSON.parse(await readFile(seenFile, 'utf8'));
  assert.equal(seen.epoch, '1700000000');
  const top = seen.args[2].slice('_topdir '.length);
  const payload = seen.args[10].slice('payload '.length);
  assert.deepEqual(seen.args, ['-bb', '--define', `_topdir ${top}`, '--define', '_buildhost reproducible', '--define', 'use_source_date_epoch_as_buildtime 1',
    '--define', 'clamp_mtime_to_source_date_epoch 1', '--define', `payload ${payload}`, path.join(top, 'SPECS', 'asb.spec')]);
  assert.ok(path.isAbsolute(top) && path.isAbsolute(payload) && top !== payload);
  assert.equal(seen.spec, rpmSpec(version));
  // The payload has the file and folder modes and the times of the .deb.
  const executables = ['usr/bin/asb', 'usr/lib/asb/scripts/asb', 'usr/lib/asb/scripts/asb.mjs', 'usr/lib/asb/install.sh', 'usr/lib/asb/uninstall.sh'];
  assert.ok(seen.files.length > RUNTIME_FILES.length);
  for (const [name, mode, mtime, directory] of seen.files) {
    assert.equal(mode, directory || executables.includes(name) ? 0o755 : 0o644, name);
    assert.equal(mtime, 1700000000, name);
  }
  assert.ok(seen.files.some(([name]) => name === 'usr/share/licenses/asb/LICENSE'));
});

test('the build makes the PKGBUILD from the archive hash, and the RPM when rpmbuild exists', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux packaging check.');
  if (!has('dpkg-deb')) return t.skip('dpkg-deb is not installed.');
  const temporary = await temporaryFolder(t, 'formats');
  const outputDir = path.join(temporary, 'dist');
  const warnings = [];
  const previousMask = process.umask(0o022);
  let artifacts;
  try { artifacts = await build({ sourceRoot, outputDir, warn: (line) => warnings.push(line) }); } finally { process.umask(previousMask); }
  const rpmbuild = has('rpmbuild');
  const rpmName = `asb-${version}-1.noarch.rpm`;
  const names = artifacts.map((file) => path.basename(file));
  assert.deepEqual(names, [`asb_${version}_all.deb`, `asb-${version}-linux.tar.gz`, ...rpmbuild ? [rpmName] : [], 'PKGBUILD']);
  // Without rpmbuild: one line, and no RPM in the artifacts, in SHA256SUMS, or in the output folder.
  assert.deepEqual(warnings, rpmbuild ? [] : ['ASB build: rpmbuild is not installed, so the build makes no RPM.']);
  assert.deepEqual((await readdir(outputDir)).sort(), [...names, 'SHA256SUMS'].sort());
  const sums = (await readFile(path.join(outputDir, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.deepEqual(sums, await Promise.all(artifacts.map(async (file) => `${sha256(await readFile(file))}  ${path.basename(file)}`)));
  const [debFile, archive] = artifacts;
  const archiveHash = sha256(await readFile(archive));
  const debRoot = path.join(temporary, 'deb');
  execFileSync('dpkg-deb', ['-x', debFile, debRoot]);

  await t.test('the PKGBUILD has the version, the archive hash, and the wrapper lines', async () => {
    const recipe = await readFile(artifacts.at(-1), 'utf8');
    assert.equal(recipe, pkgbuild(version, archiveHash));
    for (const line of [`pkgver=${version}`, `sha256sums=('${archiveHash}')`, 'depends=(\'nodejs\' \'openssl\' \'xdg-utils\' \'python-gobject\' \'gtk4\' \'libadwaita\')',
      'source=("https://github.com/Jamir-boop/ASB/releases/download/v${pkgver}/asb-${pkgver}-linux.tar.gz")',
      '  printf \'%s\\n\' \'#!/bin/sh\' \'export ASB_SYSTEM_INSTALL=1\' \'export ASB_INSTALLED_LAUNCHER=/usr/bin/asb\' \'exec /usr/lib/asb/scripts/asb "$@"\' > asb.sh',
      '  install -Dm755 asb.sh "$pkgdir/usr/bin/asb"']) assert.ok(recipe.split('\n').includes(line), line);
  });

  await t.test('bash accepts the PKGBUILD, and its package() makes the files of the Debian package', { skip: has('bash') ? false : 'bash is not installed.' }, async () => {
    const recipe = artifacts.at(-1);
    execFileSync('bash', ['-n', recipe]);
    const srcdir = path.join(temporary, 'srcdir');
    const pkgdir = path.join(temporary, 'pkgdir');
    await mkdir(srcdir);
    execFileSync('tar', ['-xzf', archive, '-C', srcdir]);
    execFileSync('bash', ['-euc', '. "$1"; cd "$2"; pkgdir=$3; package', 'bash', recipe, srcdir, pkgdir]);
    // The printf line gives the same launcher as the .deb.
    assert.equal(await readFile(path.join(pkgdir, 'usr/bin/asb'), 'utf8'), LAUNCHER);
    assert.equal(await readFile(path.join(pkgdir, 'usr/bin/asb'), 'utf8'), await readFile(path.join(debRoot, 'usr/bin/asb'), 'utf8'));
    assert.equal((await lstat(path.join(pkgdir, 'usr/bin/asb'))).mode & 0o777, 0o755);
    for (const file of [`usr/share/applications/${ASB_APP_ID}.desktop`, `usr/share/icons/hicolor/scalable/apps/${ASB_APP_ID}.svg`]) {
      assert.deepEqual(await readFile(path.join(pkgdir, file)), await readFile(path.join(debRoot, file)), file);
    }
    assert.deepEqual(await readFile(path.join(pkgdir, 'usr/share/licenses/asb/LICENSE')), await readFile(path.join(sourceRoot, 'LICENSE')));
    assert.deepEqual((await regularFiles(path.join(pkgdir, 'usr/lib/asb'))), RUNTIME_FILES);
  });

  const skipRpm = !rpmbuild ? 'rpmbuild is not installed.' : has('rpm') ? false : 'rpm is not installed.';
  await t.test('the RPM has the dependencies and the files of the plan', { skip: skipRpm }, async () => {
    const rpm = artifacts[2];
    const query = (...args) => execFileSync('rpm', ['-qp', ...args, rpm], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').sort();
    // rpm adds its own rpmlib(...) requirements.
    assert.deepEqual(query('--requires').filter((line) => !line.startsWith('rpmlib(')), [...SPEC_REQUIRES].sort());
    assert.deepEqual(query('--recommends'), [...SPEC_RECOMMENDS].sort());
    assert.deepEqual(query('--qf', '%{NAME} %{VERSION} %{RELEASE} %{ARCH}\\n'), [`asb ${version} 1 noarch`]);
    const files = Object.fromEntries(query('--qf', '[%{FILENAMES} %{FILEMODES:octal}\\n]').map((line) => line.split(' ')).filter(([, mode]) => mode.startsWith('100')));
    assert.deepEqual(Object.keys(files).sort(), [...RUNTIME_FILES.map((file) => `/usr/lib/asb/${file}`), '/usr/bin/asb', `/usr/share/applications/${ASB_APP_ID}.desktop`,
      `/usr/share/icons/hicolor/scalable/apps/${ASB_APP_ID}.svg`, '/usr/share/licenses/asb/LICENSE'].sort());
    assert.equal(files['/usr/bin/asb'], '100755');
    assert.equal(files['/usr/lib/asb/scripts/asb'], '100755');
    assert.equal(files['/usr/share/licenses/asb/LICENSE'], '100644');
  });
});
