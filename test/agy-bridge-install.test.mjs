import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyHookEntry } from '../src/agy-hook.mjs';
import { coverageApps } from '../src/bridge-coverage.mjs';

const CLI = fileURLToPath(new URL('../scripts/asb-bridge.mjs', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'), runtime = path.join(home, 'run');
  const configDir = path.join(home, '.gemini/config');
  const config = path.join(configDir, 'mcp_config.json');
  const install = path.join(home, '.local/share/asb-bridge/agy');
  for (const dir of [bin, runtime, configDir]) await mkdir(dir, { recursive: true });
  const installHook = () => writeFile(path.join(configDir, 'hooks.json'), JSON.stringify({ asb: agyHookEntry('/synthetic/asb') }));
  const fake = async () => writeFile(path.join(bin, 'agy'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== '1') process.exit(4);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
const file = process.env.MCP_FILE;
const text = fs.readFileSync(file, 'utf8');
const value = text.trim() ? JSON.parse(text) : { mcpServers: {} };
if (args[0] !== 'mcp') process.exit(2);
const [,, name, command, bundle] = args;
if (args[1] === 'add' && name === 'asb-bridge' && command && bundle && args.length === 5) {
  value.mcpServers[name] = { command, args: [bundle] };
} else if (args[1] === 'remove' && name === 'asb-bridge') {
  delete value.mcpServers[name];
} else if (args[1] === 'list') {
  for (const [id, entry] of Object.entries(value.mcpServers)) console.log(id + '  stdio  enabled  ' + entry.command);
  process.exit(0);
} else process.exit(3);
fs.writeFileSync(file, JSON.stringify(value));
`, { mode: 0o755 });
  const bun = () => writeFile(path.join(bin, 'bun'), '#!/bin/sh\n[ "$1" != --version ] || echo 1.4.2\n', { mode: 0o755 });
  const source = Buffer.from(JSON.stringify({ mcpServers: { fixture: { command: '/somewhere', secret: 'never-print-this-value' } } }));
  await writeFile(config, source, { mode: 0o600 });
  const log = path.join(home, 'commands');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { HOME: home, PATH: bin,
    XDG_RUNTIME_DIR: runtime, MCP_FILE: config, CALLS: log } });
  return { home, bin, runtime, config, install, installHook, fake, bun, source, log, run };
}

test('agy install refuses missing agy, bun, and hook without writes', async (t) => {
  const f = await fixture(t);
  for (const [setup, message] of [[() => {}, /needs agy/], [f.fake, /needs bun/], [f.bun, /Install the ASB agy hook first/]]) {
    await setup();
    const result = f.run('install', '--agy');
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.deepEqual(await readFile(f.config), f.source);
    await assert.rejects(stat(f.install), { code: 'ENOENT' });
    await assert.rejects(stat(`${f.config}.asb-backup`), { code: 'ENOENT' });
  }
});

test('agy install backs up once, records the digest, and uses only the agy CLI to edit config', async (t) => {
  const f = await fixture(t);
  await f.fake(); await f.bun(); await f.installHook();
  const bundle = path.join(f.install, 'agy.js'), backup = `${f.config}.asb-backup`;
  for (let i = 0; i < 2; i++) {
    const before = await readFile(f.config);
    const result = f.run('install', '--agy');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`agy MCP before: keys .*; sha256 ${sha(before)}`));
    assert.match(result.stdout, new RegExp(`agy MCP after: keys .*; sha256 ${sha(await readFile(f.config))}`));
    assert.doesNotMatch(result.stdout, /never-print-this-value/);
    assert.deepEqual(await readFile(backup), f.source);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
  }
  const owner = JSON.parse(await readFile(path.join(f.install, '.asb-bridge.json'), 'utf8'));
  assert.deepEqual(owner, { owner: 'asb-bridge', files: { 'agy.js': sha(await readFile(bundle)) } });
  const status = () => {
    const result = f.run('status', '--json');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const report = status();
  assert.equal(report.agy.registered, true);
  assert.equal(report.agy.versionMatches, true);
  const [app] = coverageApps(report, [{ enabled: true, id: 'antigravity', provider: 'antigravity' }], []);
  assert.deepEqual([app.state, app.command], ['ready', 'asb bridge install --agy']);
  await writeFile(bundle, 'changed');
  assert.equal(status().agy.files, 'modified');
  const config = JSON.parse(await readFile(f.config, 'utf8'));
  config.mcpServers['asb-bridge'].args = ['/foreign/agy.js'];
  await writeFile(f.config, JSON.stringify(config));
  assert.equal(status().agy.registered, false);
  config.mcpServers['asb-bridge'].args = [bundle];
  await writeFile(f.config, JSON.stringify(config));
  const mailbox = path.join(f.runtime, 'asb-agy-mailbox');
  await mkdir(mailbox, { mode: 0o700 });
  await writeFile(path.join(mailbox, 'test.msg'), 'fixture');
  const removed = f.run('uninstall', '--agy', '--force');
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(stat(f.install), { code: 'ENOENT' });
  await assert.rejects(stat(mailbox), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.config), f.source);
  assert.deepEqual((await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse), [
    ['mcp', 'add', 'asb-bridge', path.join(f.bin, 'bun'), bundle], ['mcp', 'add', 'asb-bridge', path.join(f.bin, 'bun'), bundle],
    ['mcp', 'list'], ['mcp', 'list'], ['mcp', 'list'], ['mcp', 'remove', 'asb-bridge'],
  ]);
});

test('agy install accepts empty or whitespace-only config and keeps its exact backup and digest', async (t) => {
  for (const text of ['', ' \n\t']) {
    const f = await fixture(t);
    await writeFile(f.config, text);
    await f.fake(); await f.bun(); await f.installHook();
    const installed = f.run('install', '--agy');
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(installed.stdout.split('\n').includes(`agy MCP before: keys []; sha256 ${sha(text)}`));
    assert.equal(await readFile(`${f.config}.asb-backup`, 'utf8'), text);
    assert.equal((await stat(`${f.config}.asb-backup`)).mode & 0o777, 0o600);
    const status = f.run('status', '--json');
    assert.equal(status.status, 0, status.stderr);
    const { registered, enabled, versionMatches } = JSON.parse(status.stdout).agy;
    assert.deepEqual({ registered, enabled, versionMatches }, { registered: true, enabled: true, versionMatches: true });
    assert.deepEqual((await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse), [
      ['mcp', 'add', 'asb-bridge', path.join(f.bin, 'bun'), path.join(f.install, 'agy.js')], ['mcp', 'list'],
    ]);
  }
});
