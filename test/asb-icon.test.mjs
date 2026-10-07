import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ASB_APP_ID, registerAppIcon } from '../scripts/asb-icon.mjs';

const sourceIcon = new URL('../assets/icons/local.asb.AgentSwitchBoard.svg', import.meta.url);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, projectName = 'project') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asb-icon-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, projectName);
  await mkdir(path.join(projectRoot, 'assets', 'icons'), { recursive: true });
  await mkdir(path.join(projectRoot, 'scripts'));
  await copyFile(sourceIcon, path.join(projectRoot, 'assets', 'icons', `${ASB_APP_ID}.svg`));
  await writeFile(path.join(projectRoot, 'scripts', 'asb-desktop.mjs'), '// Disposable launcher fixture.\n');
  return { root, projectRoot, dataDir: path.join(root, 'data'), nodeExecutable: process.execPath };
}

test('ASB uses the unchanged approved Palatine Mark B', async () => {
  assert.equal(digest(await readFile(sourceIcon)), 'c5c9c4472ef283ef8c3eaa1ff3f4758f5e52bb642ed91a3997b36f0a27bf41a0');
});

test('registration writes only the two ASB files under the selected data directory', async (t) => {
  const options = await fixture(t);
  const applications = path.join(options.dataDir, 'applications');
  const icons = path.join(options.dataDir, 'icons', 'hicolor', 'scalable', 'apps');
  await mkdir(applications, { recursive: true });
  await mkdir(icons, { recursive: true });
  await writeFile(path.join(applications, 'other.desktop'), 'User launcher\n');
  await writeFile(path.join(icons, 'other.svg'), 'User icon\n');
  const result = await registerAppIcon(options);
  assert.equal(result.status, 'installed');
  assert.equal(result.iconPath, path.join(icons, `${ASB_APP_ID}.svg`));
  assert.equal(result.desktopPath, path.join(applications, `${ASB_APP_ID}.desktop`));
  assert.deepEqual(await readFile(result.iconPath), await readFile(sourceIcon));
  assert.deepEqual((await readdir(applications)).sort(), [`${ASB_APP_ID}.desktop`, 'other.desktop'].sort());
  assert.deepEqual((await readdir(icons)).sort(), [`${ASB_APP_ID}.svg`, 'other.svg'].sort());
  assert.equal(await readFile(path.join(applications, 'other.desktop'), 'utf8'), 'User launcher\n');
  assert.equal(await readFile(path.join(icons, 'other.svg'), 'utf8'), 'User icon\n');
  const desktop = await readFile(result.desktopPath, 'utf8');
  assert.match(desktop, /^\[Desktop Entry\]\n/);
  assert.ok(desktop.includes(`Exec="${process.execPath}" "${path.join(options.projectRoot, 'scripts', 'asb-desktop.mjs')}"\n`));
  for (const line of ['Type=Application', 'Name=ASB', 'GenericName=Agent Switch Board', `Icon=${result.iconPath}`, 'Terminal=false', `StartupWMClass=${ASB_APP_ID}`]) {
    assert.ok(desktop.split('\n').includes(line), line);
  }
  assert.ok(!desktop.includes('Autostart'));
  assert.equal((await stat(result.desktopPath)).mode & 0o700, 0o600);
});

test('registration uses an absolute XDG_DATA_HOME in an isolated process', async (t) => {
  const options = await fixture(t);
  const helper = new URL('../scripts/asb-icon.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { registerAppIcon } from ${JSON.stringify(helper)}; console.log(JSON.stringify(await registerAppIcon({ projectRoot: process.argv[1] })));`,
    options.projectRoot], { env: { ...process.env, XDG_DATA_HOME: options.dataDir }, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.status, 'installed');
  assert.equal(result.iconPath, path.join(options.dataDir, 'icons', 'hicolor', 'scalable', 'apps', `${ASB_APP_ID}.svg`));
  assert.equal(result.desktopPath, path.join(options.dataDir, 'applications', `${ASB_APP_ID}.desktop`));
});

test('Desktop Entry Exec treats reserved path characters as argument text', async (t) => {
  const options = await fixture(t, 'project $(touch bad); & %f');
  options.nodeExecutable = path.join(options.root, 'node "$HOME" `echo` \\backslash %U');
  await symlink(process.execPath, options.nodeExecutable);
  const result = await registerAppIcon(options);
  const exec = (await readFile(result.desktopPath, 'utf8')).split('\n').find((line) => line.startsWith('Exec='));
  const escapedNode = 'node \\\\"\\\\$HOME\\\\" \\\\`echo\\\\` \\\\\\\\backslash %%U';
  const escapedProject = 'project \\\\$(touch bad); & %%f/scripts/asb-desktop.mjs';
  assert.equal(exec, 'Exec="' + options.root + '/' + escapedNode + '" "' + options.root + '/' + escapedProject + '"');
  assert.ok(!exec.includes('/bin/sh'));
  assert.deepEqual((await readdir(options.root)).sort(), ['data', 'node "$HOME" `echo` \\backslash %U', 'project $(touch bad); & %f'].sort());
});

test('registration is idempotent and updates only files that changed', async (t) => {
  const options = await fixture(t);
  const installed = await registerAppIcon(options);
  const iconStat = await stat(installed.iconPath, { bigint: true });
  const desktopStat = await stat(installed.desktopPath, { bigint: true });
  assert.equal((await registerAppIcon(options)).status, 'unchanged');
  assert.equal((await stat(installed.iconPath, { bigint: true })).mtimeNs, iconStat.mtimeNs);
  assert.equal((await stat(installed.desktopPath, { bigint: true })).mtimeNs, desktopStat.mtimeNs);
  options.nodeExecutable = path.join(options.root, 'another node');
  await symlink(process.execPath, options.nodeExecutable);
  assert.equal((await registerAppIcon(options)).status, 'updated');
  assert.ok((await readFile(installed.desktopPath, 'utf8')).includes(`Exec="${options.nodeExecutable}" `));
  assert.equal((await stat(installed.iconPath, { bigint: true })).mtimeNs, iconStat.mtimeNs);
});

test('registration replaces an owned themed icon entry with an escaped absolute file icon', async (t) => {
  const options = await fixture(t);
  options.dataDir = path.join(options.root, 'data "quoted" \\ $HOME %f');
  const installed = await registerAppIcon(options);
  const iconStat = await stat(installed.iconPath, { bigint: true });
  const desktop = await readFile(installed.desktopPath, 'utf8');
  const iconLine = desktop.split('\n').find((line) => line.startsWith('Icon='));
  const expected = path.join(options.root, 'data "quoted" \\\\ $HOME %f', 'icons', 'hicolor', 'scalable', 'apps', `${ASB_APP_ID}.svg`);
  assert.equal(iconLine, `Icon=${expected}`);
  await writeFile(installed.desktopPath, desktop.replace(iconLine, `Icon=${ASB_APP_ID}`));
  assert.equal((await registerAppIcon(options)).status, 'updated');
  assert.equal((await readFile(installed.desktopPath, 'utf8')).split('\n').find((line) => line.startsWith('Icon=')), iconLine);
  assert.equal((await stat(installed.iconPath, { bigint: true })).mtimeNs, iconStat.mtimeNs);
  assert.equal((await registerAppIcon(options)).status, 'unchanged');
});

test('GNOME resolves the registered file icon with a stale Shell theme cache', async (t) => {
  if (process.platform !== 'linux') return t.skip('GNOME check requires Linux.');
  const options = await fixture(t);
  options.dataDir = path.join(options.root, 'data "quoted" \\ $HOME %f');
  const installed = await registerAppIcon(options);
  const python = `import sys
try:
    import gi
    gi.require_version('St', '16')
    from gi.repository import St, Gio
except (ImportError, ValueError):
    sys.exit(77)
from pathlib import Path
import shutil
desktop, source = map(Path, sys.argv[1:])
app = Gio.DesktopAppInfo.new_from_filename(str(desktop))
assert app.get_id() == 'local.asb.AgentSwitchBoard.desktop'
assert app.get_startup_wm_class() == 'local.asb.AgentSwitchBoard'
assert app.should_show()
icon = app.get_icon()
assert isinstance(icon, Gio.FileIcon)
icon_path = Path(icon.get_file().get_path())
assert icon_path.name == 'local.asb.AgentSwitchBoard.svg'
theme = St.IconTheme.new()
theme.set_search_path([str(icon_path.parents[3]), '/usr/share/icons'])
icon_path.unlink()
assert theme.lookup_icon('local.asb.AgentSwitchBoard', 64, 0) is None
hicolor_mtime = icon_path.parents[2].stat().st_mtime_ns
shutil.copyfile(source, icon_path)
assert icon_path.parents[2].stat().st_mtime_ns == hicolor_mtime
assert not theme.rescan_if_needed()
assert theme.lookup_icon('local.asb.AgentSwitchBoard', 64, 0) is None
fresh = St.IconTheme.new()
fresh.set_search_path([str(icon_path.parents[3]), '/usr/share/icons'])
assert fresh.lookup_icon('local.asb.AgentSwitchBoard', 64, 0) is not None
info = theme.lookup_by_gicon(icon, 64, 0)
assert info.get_filename() == str(icon_path)
pixbuf = info.load_icon()
assert (pixbuf.get_width(), pixbuf.get_height()) == (64, 64)
print('Registered FileIcon loads in the stale GNOME Shell theme.')
`;
  const nativePaths = '/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-16';
  try {
    const output = execFileSync('python3', ['-c', python, installed.desktopPath, path.join(options.projectRoot, 'assets', 'icons', `${ASB_APP_ID}.svg`)], {
      env: { ...process.env, XDG_DATA_HOME: options.dataDir,
        GI_TYPELIB_PATH: [nativePaths, process.env.GI_TYPELIB_PATH].filter(Boolean).join(':'),
        LD_LIBRARY_PATH: [nativePaths, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }, encoding: 'utf8',
    });
    assert.match(output, /FileIcon loads in the stale GNOME Shell theme/);
  } catch (error) {
    if (error.code === 'ENOENT' || error.status === 77) return t.skip('GNOME 48 St bindings are not installed.');
    throw error;
  }
});

test('registration preserves a pre-existing launcher before writing an icon', async (t) => {
  const options = await fixture(t);
  const desktopPath = path.join(options.dataDir, 'applications', `${ASB_APP_ID}.desktop`);
  await mkdir(path.dirname(desktopPath), { recursive: true });
  const original = '[Desktop Entry]\nType=Application\nName=My ASB\nExec=/usr/bin/true\n';
  await writeFile(desktopPath, original);
  const result = await registerAppIcon(options);
  assert.equal(result.status, 'conflict');
  assert.match(result.message, /Rename or remove/);
  assert.equal(await readFile(desktopPath, 'utf8'), original);
  await assert.rejects(stat(result.iconPath), { code: 'ENOENT' });
});

test('registration preserves a pre-existing icon and refuses a linked launcher', async (t) => {
  const options = await fixture(t);
  const iconPath = path.join(options.dataDir, 'icons', 'hicolor', 'scalable', 'apps', `${ASB_APP_ID}.svg`);
  const desktopPath = path.join(options.dataDir, 'applications', `${ASB_APP_ID}.desktop`);
  await mkdir(path.dirname(iconPath), { recursive: true });
  await writeFile(iconPath, 'User icon\n');
  assert.equal((await registerAppIcon(options)).status, 'conflict');
  assert.equal(await readFile(iconPath, 'utf8'), 'User icon\n');
  await assert.rejects(stat(desktopPath), { code: 'ENOENT' });
  await rm(iconPath);
  const userLauncher = path.join(options.root, 'user.desktop');
  await writeFile(userLauncher, '# Generated by ASB: local.asb.AgentSwitchBoard\nUser content\n');
  await mkdir(path.dirname(desktopPath), { recursive: true });
  await symlink(userLauncher, desktopPath);
  assert.equal((await registerAppIcon(options)).status, 'conflict');
  assert.equal(await readFile(userLauncher, 'utf8'), '# Generated by ASB: local.asb.AgentSwitchBoard\nUser content\n');
  await assert.rejects(stat(iconPath), { code: 'ENOENT' });
});

test('invalid paths and missing source files do not create destination files', async (t) => {
  const options = await fixture(t);
  await assert.rejects(registerAppIcon({ ...options, dataDir: 'relative' }), /absolute path/);
  await assert.rejects(registerAppIcon({ ...options, projectRoot: `${options.projectRoot}\nExec=bad` }), /control characters/);
  await assert.rejects(registerAppIcon({ ...options, nodeExecutable: '/node=bad' }), /cannot contain/);
  await rm(path.join(options.projectRoot, 'assets', 'icons', `${ASB_APP_ID}.svg`));
  await assert.rejects(registerAppIcon(options), { code: 'ENOENT' });
  await assert.rejects(stat(options.dataDir), { code: 'ENOENT' });
});
