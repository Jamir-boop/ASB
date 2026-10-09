import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install } from '../scripts/asb-package.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const check = async () => ({ nodeExecutable: process.execPath, pythonExecutable: '/usr/bin/python3' });
const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-package-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the launcher exports its checked stable Node candidate and the installer keeps its quoted path', async (t) => {
  const directory = await temporaryDirectory(t);
  const candidate = path.join(directory, "stable node's path");
  await symlink(process.execPath, candidate);
  const scripts = path.join(directory, 'source/scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(path.join(sourceRoot, 'scripts/asb'), path.join(scripts, 'asb'));
  await writeFile(path.join(scripts, 'asb-package.mjs'), 'console.log(JSON.stringify({ node: process.env.ASB_NODE, args: process.argv.slice(2) }));\n');
  const checked = JSON.parse(execFileSync(path.join(scripts, 'asb'), ['--package', 'uninstall', '--synthetic-flag'], {
    encoding: 'utf8', env: { ...process.env, ASB_NODE: candidate },
  }));
  assert.equal(checked.node, candidate);
  assert.deepEqual(checked.args, ['uninstall', '--synthetic-flag']);
  // A source run passes no installed launcher, so it cannot replace an installed GNOME entry.
  await writeFile(path.join(scripts, 'asb-desktop.mjs'), 'console.log(JSON.stringify({ launcher: process.env.ASB_INSTALLED_LAUNCHER ?? null }));\n');
  const { ASB_INSTALLED_LAUNCHER: _installed, ...sourceEnv } = process.env;
  assert.deepEqual(JSON.parse(execFileSync(path.join(scripts, 'asb'), [], { encoding: 'utf8', env: { ...sourceEnv, ASB_NODE: candidate } })), { launcher: null });
  const previousNode = process.env.ASB_NODE;
  t.after(() => { if (previousNode === undefined) delete process.env.ASB_NODE; else process.env.ASB_NODE = previousNode; });
  process.env.ASB_NODE = checked.node;
  const result = await install({ sourceRoot, dataDir: path.join(directory, 'data'), binDir: path.join(directory, 'bin'), check });
  const wrapper = await readFile(result.launcher, 'utf8');
  assert.equal(result.nodeExecutable, candidate);
  assert.ok(wrapper.includes(`export ASB_NODE=${shellQuote(candidate)}\n`));
  assert.ok(wrapper.endsWith(`\nexec ${shellQuote(path.join(result.directory, 'scripts/asb'))} "$@"\n`));
  assert.ok(!/PATH=/.test(wrapper), wrapper);
  execFileSync('/bin/sh', ['-n', result.launcher]);
});

test('the installer falls back to its checked process for relative or unavailable Node candidates', async (t) => {
  const directory = await temporaryDirectory(t);
  const previousNode = process.env.ASB_NODE;
  t.after(() => { if (previousNode === undefined) delete process.env.ASB_NODE; else process.env.ASB_NODE = previousNode; });
  const nonExecutable = path.join(directory, 'not-executable');
  await writeFile(nonExecutable, 'Synthetic non-executable file.\n', { mode: 0o644 });
  for (const [index, candidate] of ['relative-node', path.join(directory, 'missing-node'), nonExecutable, directory].entries()) {
    process.env.ASB_NODE = candidate;
    const result = await install({ sourceRoot, dataDir: path.join(directory, `data-${index}`), binDir: path.join(directory, `bin-${index}`), check });
    assert.equal(result.nodeExecutable, process.execPath);
    assert.ok((await readFile(result.launcher, 'utf8')).includes(`export ASB_NODE=${shellQuote(process.execPath)}\n`));
  }
});

test('the installed command starts ASB through the shipped launcher, keeps the caller PATH order, and survives a removed Node', { timeout: 20_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const home = path.join(directory, 'home');
  const dataDir = path.join(home, '.local/share');
  const first = path.join(directory, 'first');
  await mkdir(path.join(home, '.local/bin'), { recursive: true });
  await mkdir(first);
  await symlink(process.execPath, path.join(home, '.local/bin/node'));
  const candidate = path.join(directory, 'node');
  await symlink(process.execPath, candidate);
  const window = path.join(directory, 'window');
  await writeFile(window, '#!/bin/sh\nprintf \'PATH=%s\\n\' "$PATH"\n', { mode: 0o755 });
  const previousNode = process.env.ASB_NODE;
  t.after(() => { if (previousNode === undefined) delete process.env.ASB_NODE; else process.env.ASB_NODE = previousNode; });
  process.env.ASB_NODE = candidate;
  const sqliteDirectory = path.join(directory, "sqlite's folder");
  const result = await install({ sourceRoot, dataDir, binDir: path.join(directory, 'bin'),
    check: async () => ({ nodeExecutable: process.execPath, pythonExecutable: window, sqliteDirectory }) });
  assert.equal((await lstat(path.join(result.directory, 'scripts/asb'))).mode & 0o777, 0o755);
  const wrapper = await readFile(result.launcher, 'utf8');
  assert.ok(wrapper.includes(`export PATH="\${PATH:+$PATH:}"${shellQuote(sqliteDirectory)}\n`), wrapper);
  assert.ok(!/PATH=["']?\//.test(wrapper), wrapper);
  for (const removed of [false, true]) {
    if (removed) await rm(candidate);
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const { port } = holder.address();
    await new Promise((resolve) => holder.close(resolve));
    const stdout = execFileSync(result.launcher, [], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: `${first}:/usr/bin:/bin`, PORT: String(port), HOME: home, XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
      CODEX_HOME: path.join(home, 'codex'), CLAUDE_APP_DIR: path.join(home, 'claude'), CLAUDE_CODE_CONFIG_DIR: path.join(home, 'claude-code'),
    } });
    assert.ok(stdout.includes(`ASB: http://127.0.0.1:${port}\n`), stdout);
    assert.ok(stdout.includes(`PATH=${first}:/usr/bin:/bin:${sqliteDirectory}:`), stdout);
  }
});

test('an existing install lock names the recovery folder and keeps another install staging', async (t) => {
  const directory = await temporaryDirectory(t);
  const dataDir = path.join(directory, 'data');
  const lock = path.join(dataDir, 'asb/.install-lock');
  const staging = path.join(dataDir, 'asb/releases/.install-other');
  await mkdir(lock, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(lock, 'owner'), 'Other install.\n');
  await writeFile(path.join(staging, 'owner'), 'Other staging.\n');
  await assert.rejects(install({ sourceRoot, dataDir, binDir: path.join(directory, 'bin'), check }), (error) => {
    assert.ok(error.message.includes(lock));
    assert.match(error.message, /If no install is active, remove this folder and retry/);
    return true;
  });
  assert.equal(await readFile(path.join(lock, 'owner'), 'utf8'), 'Other install.\n');
  assert.equal(await readFile(path.join(staging, 'owner'), 'utf8'), 'Other staging.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} cleans this install lock and staging after pending writes and preserves a previous install`, { timeout: 10_000 }, async (t) => {
    const directory = await temporaryDirectory(t);
    const dataDir = path.join(directory, 'data');
    const binDir = path.join(directory, 'bin');
    const releases = path.join(dataDir, 'asb/releases');
    await mkdir(releases, { recursive: true });
    await mkdir(binDir);
    // The previous wrapper names another Node, so a rollback without the launcher restore changes its bytes.
    const otherNode = path.join(directory, 'other-node');
    await symlink(process.execPath, otherNode);
    const previousNode = process.env.ASB_NODE;
    process.env.ASB_NODE = otherNode;
    let previous;
    try { previous = signal === 'SIGTERM' ? await install({ sourceRoot, dataDir, binDir, check }) : null; }
    finally { if (previousNode === undefined) delete process.env.ASB_NODE; else process.env.ASB_NODE = previousNode; }
    const savedFiles = previous ? [previous.launcher, path.join(dataDir, 'asb/install.json'), path.join(previous.directory, 'package.json')] : [];
    const saved = await Promise.all(savedFiles.map((file) => readFile(file)));
    const observed = previous ? binDir : releases;
    const script = `
      import { watch } from 'node:fs';
      import { install } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'scripts/asb-package.mjs')).href)};
      const watcher = watch(${JSON.stringify(observed)}, (event, filename) => {
        if (${previous ? "filename === 'asb'" : "String(filename).startsWith('.install-')"}) {
          watcher.close();
          process.kill(process.pid, ${JSON.stringify(signal)});
        }
      });
      try {
        await install({ sourceRoot: ${JSON.stringify(sourceRoot)}, dataDir: ${JSON.stringify(dataDir)}, binDir: ${JSON.stringify(binDir)},
          check: async () => ({ nodeExecutable: process.execPath, pythonExecutable: '/usr/bin/python3' }) });
        console.error('Unexpected install completion.');
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
        process.exitCode = error.signal === 'SIGINT' ? 130 : error.signal === 'SIGTERM' ? 143 : 1;
      } finally { watcher.close(); }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ASB_NODE: '' } });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    assert.equal(code, signal === 'SIGINT' ? 130 : 143, stderr);
    assert.ok(stderr.includes(`ASB install cancelled by ${signal}.`), stderr);
    await assert.rejects(lstat(path.join(dataDir, 'asb/.install-lock')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(releases), previous ? [path.basename(previous.directory)] : []);
    for (const [index, file] of savedFiles.entries()) assert.deepEqual(await readFile(file), saved[index]);
    if (!previous) await assert.rejects(lstat(path.join(binDir, 'asb')), { code: 'ENOENT' });
  });
}
