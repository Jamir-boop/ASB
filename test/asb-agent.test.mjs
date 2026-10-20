import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppSourceRegistry, appSourcesRevision } from '../src/app-sources.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';
import { findRunningService, readServiceRuntime } from '../scripts/asb-instance.mjs';

const script = fileURLToPath(new URL('../scripts/asb-agent.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../scripts/asb', import.meta.url));
const clientId = '11111111-1111-4111-8111-111111111111';

async function fixture(t, mode = 'desktop', { onScan } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-agent-test-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
    XDG_RUNTIME_DIR: path.join(home, 'runtime'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    CODEX_HOME: path.join(home, 'codex'), CLAUDE_APP_DIR: path.join(home, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, 'claude-code'),
    CLAUDE_CODE_CONFIG_DIR: path.join(home, 'claude-code'), ASB_NODE: process.execPath, PATH: '/usr/bin:/bin' };
  const registry = new AppSourceRegistry({ homeDir: home, env, discoverPersonal: false });
  const server = createSwitchboardServer({ sourceToken: 'a'.repeat(64), sourceRegistry: registry, serviceMode: mode === 'service',
    phoneGateway: {}, pendingStatePath: false, palettePath: false,
    loadDashboard: async ({ sources }) => {
      await onScan?.(sources);
      return { providers: sources.map((source) => ({ id: source.id, status: 'ok' })), threads: [] };
    } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const port = server.address().port;
  const runtime = path.join(env.XDG_RUNTIME_DIR, 'asb/service.json');
  const manifest = { schema: 1, pid: process.pid, port, sourceToken: 'a'.repeat(64) };
  await mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(runtime), 0o700);
  await writeFile(runtime, JSON.stringify(manifest), { mode: 0o600 });
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  const appLauncher = path.join(bin, 'chatgpt-test');
  await writeFile(appLauncher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const dataDir = path.join(home, 'profile');
  await mkdir(dataDir);
  const input = path.join(home, 'source.json');
  const posts = [];
  server.on('request', (request) => {
    if (request.method === 'POST' && request.url.startsWith('/api/sources')) posts.push({ route: request.url, revision: request.headers['if-match'] });
  });
  const command = async (args, { stdin, shell = false, extraEnv = {} } = {}) => {
    // As scripts/asb.mjs does: Node.js 22 prints the SQLite ExperimentalWarning on stderr.
    const child = spawn(shell ? launcher : process.execPath, shell ? ['agent', ...args] : ['--disable-warning=ExperimentalWarning', script, ...args],
      { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(stdin);
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null);
    assert.ok(!stdout.includes(manifest.sourceToken) && !stderr.includes(manifest.sourceToken), 'The source token must stay private.');
    return { code, stdout, stderr, result: args.includes('--json') ? JSON.parse((code ? stderr : stdout).trim().split('\n').at(-1)) : undefined };
  };
  const jsonFile = async (value) => { await writeFile(input, JSON.stringify(value)); return input; };
  const reportUi = async (overrides = {}) => {
    const revision = appSourcesRevision(await registry.read());
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/ui`, { method: 'POST', headers: {
      'X-ASB-Source-Token': manifest.sourceToken, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, sourcesRevision: revision, profilesRevision: revision, profilesVisible: true, dirty: false, ...overrides }) });
    assert.equal(response.status, 200);
  };
  return { home, env, registry, server, port, runtime, manifest, dataDir, appLauncher, input, posts, command, jsonFile, reportUi };
}

for (const mode of ['desktop', 'service']) test(`agent status authenticates the ${mode} instance and shell dispatch`, async (t) => {
  const f = await fixture(t, mode);
  const reply = await f.command(['status', '--json'], { shell: true });
  assert.equal(reply.code, 0, reply.stderr);
  assert.equal(reply.result.instance.mode, mode);
  assert.equal(reply.result.instance.pid, process.pid);
  assert.equal(reply.result.instance.sourcesPath, f.registry.configPath);
  assert.equal(await findRunningService(f.env) !== null, mode === 'service');
  assert.match((await f.command(['status'])).stdout, new RegExp(`${mode}, PID ${process.pid}`));
});

test('agent source commands preserve partial fields and repeat without duplicate writes', async (t) => {
  const f = await fixture(t);
  const list = await f.command(['sources', 'list', '--json']);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(list.result.sources.map((item) => item.provider), ['codex', 'claude-desktop-code', 'opencode']);
  const source = { provider: 'codex', label: 'Test profile', dataDir: f.dataDir, launcher: f.appLauncher,
    enabled: true, color: '#A28CAA', showMarker: false };
  await f.jsonFile(source);
  const added = await f.command(['sources', 'add', '--file', f.input, '--json']);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.result.changed, true);
  assert.equal(added.result.verification.saved.status, 'verified');
  assert.equal(added.result.verification.backend.status, 'verified');
  assert.equal(added.result.verification.ui.status, 'not-open');
  assert.equal(f.posts[0].revision, `"${list.result.revision}"`);
  const id = added.result.source.id;
  const alias = path.join(f.home, 'alias');
  await symlink(f.dataDir, alias);
  const repeated = await f.command(['sources', 'add', '--file', '-','--json'], { stdin: JSON.stringify({ ...source, dataDir: alias }) });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(repeated.result.changed, false);
  assert.equal(f.posts.length, 1);
  await f.jsonFile({ ...source, label: 'Other label' });
  const duplicate = await f.command(['sources', 'add', '--file', f.input, '--json']);
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.result.error.code, 'source_exists');
  assert.match(duplicate.result.error.message, new RegExp(`sources update ${id}`));
  assert.equal(f.posts.length, 1);
  await f.jsonFile({ enabled: false });
  const updated = await f.command(['sources', 'update', id, '--file', f.input, '--json']);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(updated.result.source.enabled, false);
  for (const field of ['provider', 'label', 'dataDir', 'launcher', 'showMarker']) assert.equal(updated.result.source[field], source[field]);
  assert.equal(updated.result.source.color, '#a28caa');
  const fetched = await f.command(['sources', 'get', id, '--json']);
  assert.equal(fetched.result.source.label, source.label);
  const repeatUpdate = await f.command(['sources', 'update', id, '--file', f.input, '--json']);
  assert.equal(repeatUpdate.result.changed, false);
  assert.equal(f.posts.length, 2);
  const removed = await f.command(['sources', 'remove', id, '--json']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.result.changed, true);
  assert.equal((await f.command(['sources', 'remove', id, '--json'])).result.changed, false);
  assert.equal(f.posts.length, 3);
  assert.equal((await f.command(['sources', 'get', id, '--json'])).result.error.code, 'source_not_found');
  assert.equal((await f.registry.read()).length, 3);
});

test('agent repeats Add for a missing source folder without duplicate writes', async (t) => {
  const f = await fixture(t);
  const dataDir = path.join(f.home, 'missing-profile');
  const source = { provider: 'codex', label: 'Missing profile', dataDir: `${dataDir}/`, launcher: f.appLauncher, enabled: true };
  await f.jsonFile(source);
  const added = await f.command(['sources', 'add', '--file', f.input, '--json']);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.result.changed, true);
  assert.equal(added.result.source.dataDir, dataDir);
  for (const suffix of ['/', '/.']) {
    await f.jsonFile({ ...source, dataDir: `${dataDir}${suffix}` });
    const repeated = await f.command(['sources', 'add', '--file', f.input, '--json']);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(repeated.result.changed, false);
    assert.equal(repeated.result.source.id, added.result.source.id);
    assert.equal(f.posts.length, 1);
  }
});

test('agent changes an additional Claude source to Codex without its transcript folder', async (t) => {
  const f = await fixture(t);
  const source = { provider: 'claude-desktop-code', label: 'Test profile', dataDir: f.dataDir, launcher: f.appLauncher,
    enabled: true, projectsDir: path.join(f.home, 'projects'), color: '#123456', showMarker: false };
  await f.jsonFile(source);
  const added = await f.command(['sources', 'add', '--file', f.input, '--json']);
  assert.equal(added.code, 0, added.stderr);
  const id = added.result.source.id;
  const codexLauncher = path.join(f.home, 'bin', 'codex-test');
  await writeFile(codexLauncher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const input = { provider: 'codex', dataDir: path.join(f.home, 'codex-profile'), launcher: codexLauncher };
  await f.jsonFile({ ...input, projectsDir: source.projectsDir });
  const invalid = await f.command(['sources', 'update', id, '--file', f.input, '--json']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.result.error.code, 'invalid_source');
  assert.equal((await f.registry.read()).find((item) => item.id === id).provider, source.provider);
  await f.jsonFile(input);
  const updated = await f.command(['sources', 'update', id, '--file', f.input, '--json']);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(updated.result.changed, true);
  assert.equal(updated.result.verification.saved.status, 'verified');
  assert.equal(updated.result.verification.backend.status, 'verified');
  const saved = (await f.registry.read()).find((item) => item.id === id);
  for (const result of [updated.result.source, saved]) {
    assert.equal(result.id, id);
    assert.equal(Object.hasOwn(result, 'projectsDir'), false);
    for (const field of ['provider', 'dataDir', 'launcher']) assert.equal(result[field], input[field]);
    for (const field of ['label', 'enabled', 'color', 'showMarker']) assert.equal(result[field], source[field]);
  }
});

test('agent rejects unsafe or stale discovery without changing source files', async (t) => {
  const f = await fixture(t);
  for (const value of [{ ...f.manifest, pid: process.pid + 1 }, { ...f.manifest, sourceToken: 'b'.repeat(64) },
    { ...f.manifest, unexpected: true }, 'x'.repeat(5000), '{']) {
    await writeFile(f.runtime, typeof value === 'string' ? value : JSON.stringify(value));
    const reply = await f.command(['status', '--json']);
    assert.equal(reply.code, 1);
  }
  await writeFile(f.runtime, JSON.stringify(f.manifest));
  const foreignOwner = path.join(f.home, 'foreign-owner.mjs');
  await writeFile(foreignOwner, 'process.getuid = () => 98765;\n');
  assert.equal((await f.command(['status', '--json'], { extraEnv: { NODE_OPTIONS: `--import=${foreignOwner}` } })).code, 1);
  await chmod(f.runtime, 0o644);
  assert.equal(await readServiceRuntime(f.env), null);
  assert.equal((await f.command(['sources', 'list', '--json'])).code, 1);
  assert.equal(f.posts.length, 0);
  await assert.rejects(readFile(f.registry.configPath), { code: 'ENOENT' });
});

test('agent rejects strict command and input errors before source writes', async (t) => {
  const f = await fixture(t);
  const bad = [[], ['status', '--file', 'x'], ['status', '--json', '--json'], ['sources', 'get'], ['sources', 'remove', '../bad'],
    ['sources', 'add'], ['sources', 'add', '--file', f.input, 'extra'], ['sources', 'update', 'codex', '--file']];
  for (const args of bad) {
    const reply = await f.command([...args, '--json']);
    assert.equal(reply.code, 2, reply.stderr);
    assert.equal(reply.result.error.code, 'usage');
  }
  for (const value of [{ id: 'codex', label: 'Changed' }, { builtin: false }, { sourceToken: 'secret' }, {}, [], null]) {
    await f.jsonFile(value);
    assert.equal((await f.command(['sources', 'update', 'codex', '--file', f.input, '--json'])).result.error.code, 'invalid_input');
  }
  await writeFile(f.input, '{');
  assert.equal((await f.command(['sources', 'add', '--file', f.input, '--json'])).result.error.code, 'invalid_input');
  await writeFile(f.input, 'x'.repeat(65 * 1024));
  assert.equal((await f.command(['sources', 'add', '--file', f.input, '--json'])).result.error.code, 'invalid_input');
  assert.equal(f.posts.length, 0);
  await assert.rejects(readFile(f.registry.configPath), { code: 'ENOENT' });
});

test('agent selects sources by id or name and rejects ambiguous names', async (t) => {
  const f = await fixture(t);
  await f.jsonFile({ provider: 'codex', label: 'Work Profile', dataDir: f.dataDir, launcher: f.appLauncher });
  const added = await f.command(['sources', 'add', '--file', f.input, '--json']);
  assert.equal(added.code, 0, added.stderr);
  const { id } = added.result.source;
  assert.equal(added.result.source.name, 'work-profile');
  const got = await f.command(['sources', 'get', 'work-profile', '--json']);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.result.source.id, id);
  assert.match((await f.command(['sources', 'list'])).stdout, new RegExp(`^${id}\twork-profile\tcodex\tenabled\tWork Profile\t`, 'm'));
  await f.jsonFile({ color: '#123456' });
  const updated = await f.command(['sources', 'update', 'work-profile', '--file', f.input, '--json']);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal((await f.registry.read()).find((source) => source.id === id).color, '#123456');
  const removed = await f.command(['sources', 'remove', 'work-profile', '--json']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(f.posts.at(-1).route, `/api/sources/${id}/remove`);
  assert.equal((await f.registry.read()).some((source) => source.id === id), false);
  // Settings saved before names existed can hold the same label twice, or a label that names another source's id.
  const legacy = (id, label) => ({ id, provider: 'codex', label, dataDir: path.join(f.home, id), launcher: f.appLauncher, enabled: true });
  const defaults = (await f.registry.read()).map(({ builtin, ...source }) => source);
  await writeFile(f.registry.configPath, JSON.stringify({ version: 1, sources: [...defaults,
    legacy('codex-a', 'Same'), legacy('codex-b', 'Same'), legacy('codex-c', 'Claude Desktop Code')] }));
  const exact = await f.command(['sources', 'get', 'claude-desktop-code', '--json']);
  assert.equal(exact.code, 0, exact.stderr);
  assert.equal(exact.result.source.provider, 'claude-desktop-code');
  const before = f.posts.length;
  for (const args of [['get', 'same'], ['remove', 'same'], ['update', 'same', '--file', f.input]]) {
    const ambiguous = await f.command(['sources', ...args, '--json']);
    assert.equal(ambiguous.code, 1);
    assert.equal(ambiguous.result.error.code, 'source_ambiguous');
    assert.equal(ambiguous.result.error.message, 'More than one app source uses the name same. Use its id.');
  }
  assert.equal(f.posts.length, before);
});

test('agent peers lists live Claude registry agents by app instance without other environment values', async (t) => {
  const f = await fixture(t);
  const secret = 'asb-env-sentinel-7f3a';
  const auth = 'asb-auth-sentinel-9c1d';
  const children = [];
  t.after(() => Promise.all(children.map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  })));
  const start = async (env) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { [secret]: secret, ...env }, stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    const procStart = (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ').pop().split(' ')[19];
    return { pid: child.pid, procStart, child };
  };
  const dir = async (...parts) => { const value = path.join(f.home, ...parts); await mkdir(value, { recursive: true }); return value; };
  for (const home of ['.codex', '.codex-personal', '.codex-other']) await writeFile(path.join(await dir(home), 'config.toml'), '');
  const sessions = await dir('.claude', 'sessions');
  await dir('claude-proxy');
  await symlink('../.claude/sessions', path.join(f.home, 'claude-proxy', 'sessions'));
  const elsewhere = await dir('elsewhere');
  await f.registry.update({ provider: 'codex', label: 'ChatGPT Personal', dataDir: path.join(f.home, '.codex-personal'), launcher: f.appLauncher, enabled: true });
  const missingHome = path.join(f.home, 'missing-home');
  await f.registry.update({ provider: 'codex', label: 'Missing Home', dataDir: missingHome, launcher: f.appLauncher, enabled: true });
  await f.registry.update({ provider: 'claude-desktop-code', label: 'Claude Proxy', dataDir: await dir('claude-proxy-app'),
    projectsDir: path.join(f.home, 'claude-proxy', 'projects'), launcher: f.appLauncher, enabled: true });
  const record = async (peer, fields) => writeFile(path.join(sessions, `${peer.pid}.json`), JSON.stringify({ pid: peer.pid, procStart: peer.procStart,
    sessionId: randomUUID(), cwd: f.home, status: 'idle', kind: 'interactive', peerToken: auth, messagingSocketPath: path.join(f.home, 's.sock'), ...fields }));
  const claudeDefault = await start({});
  const claudeProxy = await start({ CLAUDE_CONFIG_DIR: path.join(f.home, 'claude-proxy') });
  const codexDefault = await start({ CLAUDE_CONFIG_DIR: 'unused-relative' });
  const codexPersonal = await start({ CODEX_HOME: path.join(f.home, '.codex-personal') });
  const stray = await start({ CLAUDE_CONFIG_DIR: elsewhere });
  const lost = await start({ CODEX_HOME: missingHome });
  const relative = await start({ CLAUDE_CONFIG_DIR: 'relative-home' });
  const restarted = await start({});
  const dead = await start({});
  dead.child.kill();
  await once(dead.child, 'exit');
  await record(claudeDefault, { name: 'dup-name', entrypoint: 'claude-desktop', cwd: `${f.home}\nnext` });
  await record(claudeProxy, { name: 'dup-name', entrypoint: 'cli' });
  await record(codexDefault, { name: 'codex-task', entrypoint: 'codex-asb-bridge' });
  await record(codexPersonal, { name: 'codex-personal-task', entrypoint: 'codex-asb-bridge' });
  await record(stray, { name: 'stray', entrypoint: 'cli' });
  await record(lost, { name: 'lost-task', entrypoint: 'codex-asb-bridge' });
  await record(relative, { name: 'relative', entrypoint: 'cli' });
  await record(restarted, { name: 'restarted', procStart: '1' });
  await record(dead, { name: 'dead' });
  await writeFile(path.join(sessions, `${claudeDefault.pid}.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: auth }));
  const reply = await f.command(['peers', '--json']);
  assert.equal(reply.code, 0, reply.stderr);
  assert.ok(!reply.stdout.includes(secret) && !reply.stdout.includes(auth));
  assert.deepEqual(reply.result.peers.map(({ address, pid, duplicate }) => [address, pid, duplicate]), [
    ['chatgpt-personal/codex-personal-task', codexPersonal.pid, false],
    ['claude-desktop-code/dup-name', claudeDefault.pid, true],
    ['claude-proxy/dup-name', claudeProxy.pid, true],
    ['codex/codex-task', codexDefault.pid, false],
    ['missing-home/lost-task', lost.pid, false],
    ['unknown/relative', relative.pid, false],
    ['unknown/stray', stray.pid, false],
  ]);
  const peer = reply.result.peers[3];
  assert.deepEqual(Object.keys(peer), ['instance', 'name', 'address', 'sessionId', 'pid', 'status', 'cwd', 'kind', 'entrypoint', 'duplicate']);
  assert.deepEqual({ ...peer, sessionId: typeof peer.sessionId }, { instance: 'codex', name: 'codex-task', address: 'codex/codex-task', sessionId: 'string',
    pid: codexDefault.pid, status: 'idle', cwd: f.home, kind: 'interactive', entrypoint: 'codex-asb-bridge', duplicate: false });
  assert.deepEqual(reply.result.notInAsb, [{ provider: 'claude-desktop-code', home: await realpath(elsewhere) },
    { provider: 'codex', home: await realpath(path.join(f.home, '.codex-other')) }]);
  const human = await f.command(['peers']);
  assert.equal(human.code, 0, human.stderr);
  const lines = human.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 10);
  assert.equal(lines[1], `claude-desktop-code/dup-name\tidle\tpid ${claudeDefault.pid}\t${f.home}\\x0anext\tduplicate name`);
  assert.deepEqual(lines.slice(7), ['Not in ASB:', `  claude-desktop-code\t${await realpath(elsewhere)}`, `  codex\t${await realpath(path.join(f.home, '.codex-other'))}`]);
});

test('agent reports a revision conflict without overwriting a concurrent edit', async (t) => {
  const f = await fixture(t);
  const original = f.registry.update.bind(f.registry);
  let conflict = true;
  f.registry.update = async (source, revision) => {
    if (conflict) {
      conflict = false;
      const current = (await f.registry.read()).find((source) => source.id === 'codex');
      const { builtin, ...saved } = current;
      await original({ ...saved, label: 'Concurrent edit' });
    }
    return original(source, revision);
  };
  await f.jsonFile({ label: 'CLI edit' });
  const reply = await f.command(['sources', 'update', 'codex', '--file', f.input, '--json']);
  assert.equal(reply.code, 1);
  assert.equal(reply.result.error.code, 'revision_conflict');
  assert.equal((await f.registry.read()).find((source) => source.id === 'codex').label, 'Concurrent edit');
  assert.equal(f.posts.length, 1);
});

test('agent verifies its own write revision when another client saves during the dashboard scan', async (t) => {
  const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 10_000).unref();
  })]);
  const scan = Promise.withResolvers();
  const scanStarted = Promise.withResolvers();
  const secondSaved = Promise.withResolvers();
  const f = await fixture(t, 'desktop', { onScan: async (sources) => {
    if (sources.find((source) => source.id === 'codex').label !== 'First') return;
    scanStarted.resolve(sources);
    await scan.promise;
  } });
  const original = f.registry.update.bind(f.registry);
  f.registry.update = async (source, revision) => {
    const saved = await original(source, revision).catch((error) => {
      if (source?.label === 'Second') secondSaved.reject(error);
      throw error;
    });
    if (source?.label === 'Second') secondSaved.resolve();
    return saved;
  };
  t.after(() => scan.resolve());
  await f.jsonFile({ label: 'First' });
  const cli = f.command(['sources', 'update', 'codex', '--file', f.input, '--json']);
  let other;
  try {
    const held = await within(scanStarted.promise, 'the CLI save scan');
    const r1 = appSourcesRevision(held);
    const { builtin, ...codex } = held.find((source) => source.id === 'codex');
    other = fetch(`http://127.0.0.1:${f.port}/api/sources`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
      'X-ASB-Source-Token': f.manifest.sourceToken, origin: `http://127.0.0.1:${f.port}`, 'content-type': 'application/json',
      'If-Match': `"${r1}"` }, body: JSON.stringify({ source: { ...codex, label: 'Second' } }) });
    await within(secondSaved.promise, 'the second save');
    const r2 = appSourcesRevision(await f.registry.read());
    scan.resolve();
    const response = await other;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).savedRevision, r2);
    const reply = await within(cli, 'the CLI');
    assert.equal(reply.code, 1);
    assert.equal(reply.result.ok, false);
    assert.equal(reply.result.verification.saved.status, 'changed-after-write');
    assert.equal(reply.result.verification.saved.revision, r2);
    assert.equal(reply.result.revision, r1);
    assert.notEqual(r1, r2);
    const current = await f.registry.read();
    assert.equal(appSourcesRevision(current), r2);
    assert.equal(current.find((source) => source.id === 'codex').label, 'Second');
  } finally {
    scan.resolve();
    await within(Promise.allSettled([cli, other]), 'request cleanup').catch(() => {});
  }
});

test('agent reports saved/backend evidence separately from current UI reports', async (t) => {
  const f = await fixture(t);
  await f.reportUi();
  const reports = [];
  const updateUi = (request, response) => {
    if (request.method === 'POST' && request.url === '/api/sources') response.once('finish', () => { reports.push(f.reportUi()); });
  };
  f.server.on('request', updateUi);
  await f.jsonFile({ showMarker: false });
  const reply = await f.command(['sources', 'update', 'codex', '--file', f.input, '--json']);
  await Promise.all(reports);
  assert.equal(reply.code, 0, reply.stderr);
  assert.equal(reply.result.verification.saved.status, 'verified');
  assert.equal(reply.result.verification.backend.status, 'verified');
  assert.equal(reply.result.verification.ui.status, 'verified');
  f.server.off('request', updateUi);
  await f.reportUi({ dirty: true });
  await f.jsonFile({ color: '#123456' });
  // A dirty editor must not count as visual confirmation.
  const dirty = await f.command(['sources', 'update', 'codex', '--file', f.input, '--json']);
  await Promise.all(reports);
  assert.equal(dirty.result.verification.saved.status, 'verified');
  assert.equal(dirty.result.verification.backend.status, 'verified');
  assert.equal(dirty.result.verification.ui.status, 'pending');
  assert.equal(dirty.result.verification.ui.clients[0].dirty, true);
  await f.reportUi({ sourcesRevision: '0'.repeat(64), profilesRevision: '0'.repeat(64) });
  await f.jsonFile({ enabled: false });
  const pending = await f.command(['sources', 'update', 'codex', '--file', f.input, '--json']);
  assert.equal(pending.code, 0, pending.stderr);
  assert.equal(pending.result.verification.saved.status, 'verified');
  assert.equal(pending.result.verification.backend.status, 'verified');
  assert.equal(pending.result.verification.ui.status, 'pending');
});

test('agent waits for a current dirty UI report after a source write', async (t) => {
  const f = await fixture(t);
  await f.reportUi({ dirty: true });
  let saved = false;
  let polls = 0;
  const reports = [];
  f.server.on('request', (request, response) => {
    if (request.method === 'POST' && request.url === '/api/sources') response.once('finish', () => { saved = true; });
    if (saved && request.url === '/api/agent/status' && ++polls === 2) {
      response.once('finish', () => { reports.push(f.reportUi({ dirty: true })); });
    }
  });
  await f.jsonFile({ showMarker: false });
  const reply = await f.command(['sources', 'update', 'codex', '--file', f.input, '--json']);
  await Promise.all(reports);
  assert.equal(reply.code, 0, reply.stderr);
  assert.ok(polls >= 3, 'The command must wait for a current UI report.');
  assert.equal(reply.result.verification.ui.status, 'dirty');
  const client = reply.result.verification.ui.clients[0];
  assert.equal(client.dirty, true);
  assert.equal(client.sourcesRevision, reply.result.revision);
  assert.equal(client.profilesRevision, reply.result.revision);
});
