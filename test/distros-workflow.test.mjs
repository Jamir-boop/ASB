import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// distros.yml is read as text, because ASB has no YAML library. A Windows checkout has CRLF line ends.
const workflow = (await readFile(new URL('../.github/workflows/distros.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const script = fileURLToPath(new URL('./distro-check.sh', import.meta.url));

// The lines of each job, by its name (a key with two spaces of indent under jobs).
const jobs = {};
let current = null;
for (const line of workflow.slice(workflow.indexOf('\njobs:\n')).split('\n')) {
  const match = /^ {2}([a-z][a-z0-9-]*):$/.exec(line);
  if (match) current = jobs[match[1]] = [];
  else if (current) current.push(line);
}

// The matrix rows: `- { job: x, image: 'y', ... }` lines.
const rows = (lines) => lines.filter((line) => line.startsWith('          - { job:')).map((line) => Object.fromEntries(
  line.replace(/^\s*- \{ /, '').replace(/ \}$/, '').split(', ').map((pair) => {
    const colon = pair.indexOf(': ');
    return [pair.slice(0, colon), pair.slice(colon + 2).replace(/^'(.*)'$/, '$1')];
  })));

const PACKAGES = { debian: 'deb', fedora: 'rpm', opensuse: 'rpm', arch: 'pkgbuild', alpine: 'none', void: 'none' };

test('the check job has the rows of the probe job, each with the package of its family', () => {
  assert.ok(jobs.check, 'The check job is missing.');
  const probe = rows(jobs.probe);
  const check = rows(jobs.check);
  assert.equal(probe.length, 16);
  // The same job, image, runner, family, tier, node, and window, in the same order.
  assert.deepEqual(check.map(({ package: _package, ...row }) => row), probe);
  for (const row of check) assert.equal(row.package, PACKAGES[row.family], row.job);
});

test('the check job needs the build job, and the nix job exists', () => {
  assert.ok(jobs.build, 'The build job is missing.');
  assert.ok(jobs.nix, 'The nix job is missing.');
  assert.ok(jobs.check?.includes('    needs: build'));
  assert.ok(jobs.check.some((line) => line.includes('sh -eu /asb/test/distro-check.sh "$FAMILY" "$TIER" "$PACKAGE"')));
  assert.ok(jobs.check.some((line) => line.includes('-e ASB_DISTRO_CHECK=1')));
});

// The script installs packages, so these runs must stop at its guard and change nothing.
const run = (env) => spawnSync('sh', [script, 'debian', 'board', 'none'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('distro-check.sh is valid POSIX sh', { skip: process.platform === 'win32' }, () => {
  assert.equal(spawnSync('sh', ['-n', script], { encoding: 'utf8' }).status, 0);
});

test('distro-check.sh stops with code 2 without ASB_DISTRO_CHECK=1', { skip: process.platform === 'win32' }, () => {
  const result = run({});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ASB_DISTRO_CHECK=1/);
  assert.equal(result.stdout, '');
});

// As root with ASB_DISTRO_CHECK=1, the script would run. Never do that on a real PC.
test('distro-check.sh stops with code 2 for a user other than root', { skip: process.platform === 'win32' || process.getuid() === 0 }, () => {
  const result = run({ ASB_DISTRO_CHECK: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /root/);
  assert.equal(result.stdout, '');
});
