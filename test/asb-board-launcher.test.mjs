import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherSource = fileURLToPath(new URL('../scripts/asb-board.py', import.meta.url));
const hasPython = (() => { try { execFileSync('python3', ['-c', '0'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const stub = (word) => `import sys\n\n\ndef main():\n    print(__name__, __file__, sys.argv[0], "${word}")\n    return 3\n`;

async function compiled(folder) {
  const files = await readdir(folder, { recursive: true }).catch(() => []);
  return files.filter((file) => /(^|\/)asb-native\.cpython-[^/]+\.pyc$/.test(file)).map((file) => path.join(folder, file));
}

test('the board launcher keeps the compiled board code only in the private cache folder', {
  skip: process.platform !== 'linux' || !hasPython ? 'Linux with python3' : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-board-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts');
  await mkdir(scripts);
  const launcher = path.join(scripts, 'asb-board.py');
  const board = path.join(scripts, 'asb-native.py');
  await copyFile(launcherSource, launcher);
  await writeFile(board, stub('one'));
  const home = path.join(directory, 'home');
  const run = (cacheHome) => spawnSync('python3', [launcher], {
    cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_CACHE_HOME: cacheHome },
  });
  const cacheHome = path.join(directory, 'cache');
  const pycache = path.join(cacheHome, 'asb/pycache');

  const first = run(cacheHome);
  assert.equal(first.status, 3, first.stderr);
  assert.equal(first.stdout, `asb_native ${board} ${launcher} one\n`);
  const [file] = await compiled(pycache);
  assert.equal((await compiled(pycache)).length, 1);
  assert.equal((await stat(pycache)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(scripts)).sort(), ['asb-board.py', 'asb-native.py']);

  const before = await stat(file);
  const second = run(cacheHome);
  assert.equal(second.status, 3, second.stderr);
  assert.equal(second.stdout, first.stdout);
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);

  // Another size, so the timestamp check sees the change in the same second too.
  await writeFile(board, stub('changed'));
  const third = run(cacheHome);
  assert.equal(third.status, 3, third.stderr);
  assert.equal(third.stdout, `asb_native ${board} ${launcher} changed\n`);
  assert.equal((await compiled(pycache)).length, 1);
  assert.notEqual((await stat(file)).ino, before.ino);

  // A cache folder that cannot exist: the board still runs and writes nothing next to its source.
  const blocker = path.join(directory, 'file');
  await writeFile(blocker, '');
  const blocked = run(path.join(blocker, 'cache'));
  assert.equal(blocked.status, 3, blocked.stderr);
  assert.equal(blocked.stdout, third.stdout);
  assert.deepEqual((await readdir(scripts)).sort(), ['asb-board.py', 'asb-native.py']);

  // A relative XDG_CACHE_HOME is not used.
  const relative = run('relative-cache');
  assert.equal(relative.status, 3, relative.stderr);
  assert.equal((await compiled(path.join(home, '.cache/asb/pycache'))).length, 1);
  assert.ok(!(await readdir(directory)).includes('relative-cache'));
  assert.deepEqual((await readdir(scripts)).sort(), ['asb-board.py', 'asb-native.py']);
});
