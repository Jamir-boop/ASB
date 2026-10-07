import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASB_APP_ID } from '../scripts/asb-icon.mjs';
import { build, DEBIAN_DEPENDS, install, RUNTIME_FILES, uninstall } from '../scripts/asb-package.mjs';

test('release runtime includes the Claude remote reader imported by the switchboard', () => {
  assert.ok(RUNTIME_FILES.includes('src/claude-remote-data.mjs'));
});

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
    artifacts = await build({ sourceRoot, outputDir: path.join(temporary, 'first') });
    process.umask(0o077);
    second = await build({ sourceRoot, outputDir: path.join(temporary, 'second') });
  } finally { process.umask(previousMask); }
  for (let i = 0; i < artifacts.length; i++) assert.equal(sha256(await readFile(artifacts[i])), sha256(await readFile(second[i])));
  const sums = await readFile(path.join(temporary, 'first', 'SHA256SUMS'), 'utf8');
  for (const file of artifacts) assert.ok(sums.includes(`${sha256(await readFile(file))}  ${path.basename(file)}\n`));
  const archiveFiles = execFileSync('tar', ['-tzf', artifacts[1]], { encoding: 'utf8' }).trim().split('\n').filter((name) => !name.endsWith('/'));
  assert.deepEqual(archiveFiles.sort(), RUNTIME_FILES.map((file) => `asb-${version}/${file}`).sort());
  const [debVersion, architecture, depends] = execFileSync('dpkg-deb', ['-f', artifacts[0], 'Version', 'Architecture', 'Depends'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(debVersion, `Version: ${version}`);
  assert.equal(architecture, 'Architecture: all');
  assert.equal(depends, `Depends: ${DEBIAN_DEPENDS}`);
  const extracted = path.join(temporary, 'deb');
  execFileSync('dpkg-deb', ['-x', artifacts[0], extracted]);
  assert.match(await readFile(path.join(extracted, 'usr/bin/asb'), 'utf8'), /export ASB_SYSTEM_INSTALL=1/);
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
