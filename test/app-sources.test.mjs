import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppSourceRegistry, MAX_APP_SOURCES, numberAppSources, validateSourceLauncher } from '../src/app-sources.mjs';
import { buildSwitchboardDashboard, createSwitchboardServer, loadSwitchboardDashboard, openSwitchboardThread, PendingTracker } from '../src/switchboard.mjs';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const child = '123e4567-e89b-12d3-a456-426614174001';
const now = Date.parse('2026-10-07T14:00:00Z');
const execFileAsync = promisify(execFile);
async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-sources-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const registry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  const launcher = path.join(homeDir, '.local', 'bin', 'chatgpt-personal');
  const source = (dataDir, extra = {}) => ({ provider: 'codex', label: 'Second app', dataDir, launcher, enabled: true, ...extra });
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { homeDir, registry, source, launcher };
}
async function serve(t, options) {
  const server = createSwitchboardServer({ pendingStatePath: false, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, post: (route, body, headers = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }) };
}

test('source edits validate local app paths, protect defaults, and save only ASB settings with owner access', async (t) => {
  const { registry, homeDir, source, launcher } = await fixture(t);
  const dataDir = path.join(homeDir, 'second');
  await mkdir(dataDir);
  for (const change of [
    { enabled: 'yes' }, { label: '' }, { label: 'x'.repeat(81) }, { label: 'line\nbreak' }, { dataDir: '~/.codex' },
    { dataDir: '/tmp/line\nbreak' }, { dataDir: `/${'a'.repeat(4096)}` }, { launcher: '' },
    { launcher: '/bin/sh' }, { launcher: '/bin/echo' }, { launcher: `${launcher}\n` },
    { launcher: path.join(homeDir, 'chatgpt-missing') }, { environment: {} }, { command: 'echo' }, { projectsDir: homeDir },
    { id: 'new-client-id' }, ...[null, 'true', 1, [], {}].map((showMarker) => ({ showMarker })),
    ...[null, false, 8296, [], {}, '', '#abc', '#8296b480', '8296b4', '#8296b4\n', ' #8296b4',
      'red', 'var(--accent)', 'url(file:///tmp/color)'].map((color) => ({ color })),
  ]) await assert.rejects(registry.update(source(dataDir, change)), { statusCode: 400 });
  await chmod(launcher, 0o644);
  await assert.rejects(registry.update(source(dataDir, { launcher })), { statusCode: 400 });
  await chmod(launcher, 0o755);
  const shellAlias = path.join(homeDir, 'codex-shell');
  await symlink('/bin/sh', shellAlias);
  await assert.rejects(validateSourceLauncher(shellAlias), { statusCode: 400 });
  await registry.update(source(dataDir, { launcher, label: '  Personal  ' }));
  const records = await registry.read();
  const added = records.find((item) => !item.builtin);
  assert.match(added.id, /^codex-[a-f0-9-]+$/);
  assert.equal(added.label, 'Personal');
  assert.equal((await stat(registry.configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(registry.configPath))).mode & 0o777, 0o700);
  const restored = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  assert.deepEqual(await restored.read(), records);
  await assert.rejects(registry.remove('codex'), { statusCode: 400 });
  await assert.rejects(registry.update({ ...records[0], builtin: undefined }), { statusCode: 400 });
  const { builtin, ...builtinEdit } = records[0];
  await assert.rejects(registry.update({ ...builtinEdit, provider: 'claude-desktop-code' }), { statusCode: 400 });
  await registry.update({ ...builtinEdit, enabled: false });
  assert.equal((await registry.read())[0].enabled, false);
  await registry.remove(added.id);
  assert.equal((await registry.read()).length, 2);
});

test('version 1 settings without colors or marker flags gain defaults without changing stored settings or profile IDs', async (t) => {
  const { registry, homeDir, source } = await fixture(t);
  const legacy = (await registry.read()).map(({ color, showMarker, ...record }) => record);
  legacy.push({ ...source(path.join(homeDir, 'personal'), { id: 'codex-personal' }), builtin: false },
    { ...source(path.join(homeDir, 'studio'), { id: 'claude-studio', provider: 'claude-desktop-code' }), builtin: false });
  await mkdir(path.dirname(registry.configPath), { recursive: true });
  const original = JSON.stringify({ version: 1, sources: legacy });
  await writeFile(registry.configPath, original);
  const migrated = await registry.read();
  assert.equal(await readFile(registry.configPath, 'utf8'), original);
  assert.deepEqual(migrated.map(({ color, showMarker, ...record }) => record), legacy);
  assert.ok(migrated.every((source) => source.showMarker === true));
  assert.ok(numberAppSources(legacy).every((source) => source.showMarker === true));
  assert.equal(migrated.find((item) => item.id === 'codex').color, '#8296b4');
  assert.equal(migrated.find((item) => item.id === 'codex-personal').color, '#b28f80');
  assert.equal(migrated.find((item) => item.id === 'claude-desktop-code').color, '#a28caa');
  for (const record of migrated) assert.match(record.color, /^#[0-9a-f]{6}$/);
  const colors = Object.fromEntries(migrated.map((item) => [item.id, item.color]));
  assert.deepEqual(Object.fromEntries(numberAppSources(legacy).map((item) => [item.id, item.color])), colors);
  const reordered = [...legacy].reverse().map((item) => ({ ...item, label: `Renamed ${item.label}` }));
  await writeFile(registry.configPath, JSON.stringify({ version: 1, sources: reordered }));
  const restored = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  assert.deepEqual(Object.fromEntries((await restored.read()).map((item) => [item.id, item.color])), colors);
  assert.deepEqual(Object.fromEntries((await registry.read()).map((item) => [item.id, item.color])), colors);
  assert.equal(numberAppSources(legacy.filter((item) => item.id === 'claude-studio'))[0].color, colors['claude-studio']);
});

test('profile colors and dot flags save and reload, preserve omitted edits, and remain isolated per source', async (t) => {
  const { registry, homeDir, source, launcher } = await fixture(t);
  const initial = await registry.read();
  await registry.update(source(path.join(homeDir, 'second'), { color: '#404040', showMarker: false }));
  await registry.update(source(path.join(homeDir, 'studio'), { provider: 'claude-desktop-code', color: '#899E91' }));
  const added = (await registry.read()).filter((item) => !item.builtin);
  assert.deepEqual(added.map((item) => item.color), ['#404040', '#899e91']);
  assert.deepEqual(added.map((item) => item.showMarker), [false, true]);
  const { builtin, color, showMarker, ...edit } = added[0];
  await registry.update({ ...edit, label: 'Renamed profile', enabled: false });
  let records = await registry.read();
  assert.equal(records.find((item) => item.id === edit.id).color, color);
  assert.equal(records.find((item) => item.id === edit.id).showMarker, false);
  const hiddenRegistry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  assert.deepEqual(await hiddenRegistry.read(), records);
  await registry.update({ ...edit, showMarker: true });
  records = await registry.read();
  assert.equal(records.find((item) => item.id === edit.id).color, color);
  assert.equal(records.find((item) => item.id === edit.id).showMarker, true);
  assert.equal(records.find((item) => item.id === edit.id).enabled, true);
  assert.deepEqual(records.filter((item) => item.builtin), initial);
  assert.equal(records.find((item) => item.id === added[1].id).color, '#899e91');
  const { builtin: defaultBuiltin, ...defaultEdit } = initial[0];
  for (const preset of ['#8296b4', '#b28f80', '#a28caa', '#899e91', '#000000', '#242424', '#666666', '#404040']) {
    await registry.update({ ...defaultEdit, color: preset });
    assert.equal((await registry.read()).find((item) => item.id === defaultEdit.id).color, preset);
  }
  records = await registry.read();
  const stored = JSON.parse(await readFile(registry.configPath, 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.sources, records);
  const restored = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux', discoverPersonal: false });
  assert.deepEqual(await restored.read(), records);
  stored.sources[0].color = '#12345g';
  await writeFile(registry.configPath, JSON.stringify(stored));
  assert.deepEqual(await registry.read(), records);
  assert.match(registry.warning, /last valid/);
  stored.sources[0] = { ...records[0], showMarker: 'false' };
  await writeFile(registry.configPath, JSON.stringify(stored));
  assert.deepEqual(await registry.read(), records);
  assert.match(registry.warning, /last valid/);
  assert.equal(await readFile(launcher, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('the registry rejects the same real store and caps source count, including disabled sources', async (t) => {
  const { registry, homeDir, source } = await fixture(t);
  const dataDir = path.join(homeDir, 'store');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'state_5.sqlite'), 'synthetic database identity');
  await registry.update(source(dataDir));
  const alias = path.join(homeDir, 'store-alias');
  await symlink(dataDir, alias);
  await assert.rejects(registry.update(source(alias, { enabled: false })), /already registered/);
  const linked = path.join(homeDir, 'linked');
  await mkdir(linked);
  await link(path.join(dataDir, 'state_5.sqlite'), path.join(linked, 'state_5.sqlite'));
  await assert.rejects(registry.update(source(linked)), /already registered/);
  for (let index = 3; index < MAX_APP_SOURCES; index += 1) await registry.update(source(path.join(homeDir, `missing-${index}`)));
  assert.equal((await registry.read()).length, MAX_APP_SOURCES);
  await assert.rejects(registry.update(source(path.join(homeDir, 'one-too-many'))), /up to 8/);
});

test('initial Personal discovery needs its known store and launcher, and never changes an existing registry', async (t) => {
  const { homeDir, launcher } = await fixture(t);
  const dataDir = path.join(homeDir, '.codex-personal');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'state_5.sqlite'), 'synthetic');
  const registry = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux' });
  const concurrent = await Promise.all([registry.read(), registry.read()]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  const personal = concurrent[0].find((item) => item.id === 'codex-personal');
  assert.equal(personal.dataDir, dataDir);
  assert.equal(personal.launcher, launcher);
  assert.equal(personal.label, 'ChatGPT Personal');
  assert.equal(personal.color, '#b28f80');
  assert.notEqual(personal.color, concurrent[0].find((item) => item.id === 'codex').color);
  await registry.remove(personal.id);
  assert.equal((await new AppSourceRegistry({ homeDir, env: {}, platform: 'linux' }).read()).length, 2);
  await rm(registry.configPath);
  await rm(launcher);
  const missingLauncher = new AppSourceRegistry({ homeDir, env: {}, platform: 'linux' });
  assert.equal((await missingLauncher.read()).length, 2);
  await assert.rejects(stat(registry.configPath), { code: 'ENOENT' });
});

test('invalid settings keep the last valid sources and failed persistence does not change live sources', async (t) => {
  const { registry, homeDir, source } = await fixture(t);
  await registry.update(source(path.join(homeDir, 'second')));
  const expected = await registry.read();
  await writeFile(registry.configPath, '{bad');
  assert.deepEqual(await registry.read(), expected);
  assert.match(registry.warning, /last valid/);
  await rm(registry.configPath);
  await mkdir(registry.configPath);
  await assert.rejects(registry.update(source(path.join(homeDir, 'third'))));
  assert.deepEqual(await registry.read(), expected);
  assert.deepEqual(await readFile(path.join(homeDir, '.local', 'bin', 'chatgpt-personal'), 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('settings that ASB cannot use are kept as .bad before the next save', async (t) => {
  const { registry, homeDir, source } = await fixture(t);
  await registry.update(source(path.join(homeDir, 'second')));
  const stored = JSON.parse(await readFile(registry.configPath, 'utf8'));
  for (const content of [JSON.stringify({ ...stored, extra: true }), '{"version":1,"sources":[']) {
    await writeFile(registry.configPath, content);
    await registry.read();
    assert.match(registry.warning, /last valid/);
    await registry.update(source(path.join(homeDir, `third-${content.length}`)));
    assert.equal(await readFile(`${registry.configPath}.bad`, 'utf8'), content);
    assert.equal(registry.warning, '');
    assert.deepEqual(JSON.parse(await readFile(registry.configPath, 'utf8')).sources, await registry.read());
  }
  await registry.remove((await registry.read())[2].id);
  assert.equal(await readFile(`${registry.configPath}.bad`, 'utf8'), '{"version":1,"sources":[');
});

test('separate stores scope lineage and attention while retaining original provider IDs and real open IDs', async (t) => {
  const { homeDir, registry, source } = await fixture(t);
  await mkdir(path.join(homeDir, '.codex'));
  const secondary = path.join(homeDir, 'second');
  await mkdir(secondary);
  await registry.update(source(secondary));
  const sources = await registry.read();
  const extra = sources.find((item) => !item.builtin);
  const calls = [];
  const dashboard = await loadSwitchboardDashboard({ sources, nowMs: now,
    loadCodex: async (options) => {
      calls.push(options);
      const second = options.sessionIndexPath === path.join(secondary, 'session_index.jsonl');
      return { threads: [
        { id: uuid, provider: 'codex', lifecycleRunning: false, latestLifecycleAtMs: now - 10_000, nativeUnread: true,
          account: 'private', launcher: '/bin/sh', title: second ? 'Second root' : 'Default root' },
        { id: child, provider: 'codex', isSubagent: true, parentThreadId: uuid,
          lifecycleRunning: second, agentStartedAtMs: now - 5_000, agentActivityAtMs: now,
          latestLifecycleAtMs: now - 5_000, latestLifecycleKind: second ? 'task_started' : 'task_complete' },
      ] };
    }, loadClaude: async () => { throw new Error('Must not read missing source'); },
  });
  const main = dashboard.threads.find((row) => row.id === uuid);
  const other = dashboard.threads.find((row) => row.id === `${extra.id}:${uuid}`);
  assert.equal(main.state, 'idle');
  assert.equal(other.state, 'working');
  assert.equal(main.subagentCount, 1);
  assert.equal(other.subagentCount, 1);
  assert.equal(other.workingSinceMs, now - 5_000);
  assert.equal(other.externalId, uuid);
  assert.equal(other.appDeepLink, `codex://threads/${uuid}`);
  assert.equal(other.canOpen, true);
  assert.equal(other.sourceLabel, 'Second app');
  assert.equal(main.sourceColor, sources.find((item) => item.id === 'codex').color);
  assert.equal(other.sourceColor, extra.color);
  assert.equal(main.sourceShowMarker, true);
  assert.equal(other.sourceShowMarker, true);
  assert.deepEqual([main.sourceNumber, main.sourceCount, other.sourceNumber, other.sourceCount], [1, 2, 2, 2]);
  assert.equal(JSON.stringify(other).includes('private'), false);
  assert.equal(JSON.stringify(other).includes('launcher'), false);
  assert.equal(JSON.stringify(other).includes(secondary), false);
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.equal(options.maxRollouts, 5000);
  }
  const tracker = new PendingTracker(false);
  await tracker.observe(dashboard);
  await tracker.markUnread(main.id);
  await tracker.setPinned(other.id, true);
  await tracker.acknowledge(other.id);
  tracker.apply(main);
  tracker.apply(other);
  assert.equal(main.manualUnread, true);
  assert.equal(main.pinned, false);
  assert.equal(other.unread, false);
  assert.equal(other.pinned, true);
  assert.deepEqual(tracker.pinnedOrder, [other.id]);
});

test('enabled sources load independently and Claude uses its registered profile and transcript root', async (t) => {
  const { homeDir, registry, source } = await fixture(t);
  const failed = path.join(homeDir, 'failed');
  const claudeDir = path.join(homeDir, 'claude-extra');
  const projectsDir = path.join(homeDir, 'claude-projects');
  await mkdir(failed);
  await mkdir(claudeDir);
  await registry.update(source(failed));
  await registry.update(source(path.join(homeDir, 'disabled'), { enabled: false }));
  await registry.update(source(claudeDir, { provider: 'claude-desktop-code', projectsDir }));
  const sources = await registry.read();
  const dashboard = await loadSwitchboardDashboard({ sources, nowMs: now,
    loadCodex: async () => { throw new Error('Bad sqlite'); },
    loadClaude: async (options) => {
      assert.equal(options.appDir, claudeDir);
      assert.equal(options.projectsDir, projectsDir);
      assert.equal(options.maxCount, 5000);
      return { threads: [{ id: `claude-desktop-code:local_${uuid}`, externalId: `local_${uuid}`,
        provider: 'claude-desktop-code', lifecycleRunning: false }] };
    },
  });
  assert.equal(dashboard.threads.length, 1);
  assert.match(dashboard.threads[0].id, /^claude-[a-f0-9-]+:claude-desktop-code:local_/);
  assert.equal(dashboard.threads[0].appDeepLink, `claude://code/continue?session=local_${uuid}`);
  assert.equal(dashboard.threads[0].sourceColor, sources.at(-1).color);
  const report = await registry.report(dashboard);
  assert.deepEqual(report.sources.map((item) => item.status), ['missing', 'missing', 'error', 'disabled', 'ready']);
  assert.equal(report.sources.at(-1).sessionCount, 1);
  assert.deepEqual(report.sources.map((item) => [item.sourceNumber, item.sourceCount]), [[1, 3], [1, 2], [2, 3], [3, 3], [2, 2]]);
  assert.deepEqual([dashboard.threads[0].sourceNumber, dashboard.threads[0].sourceCount], [2, 2]);
  dashboard.providers.at(-1).status = 'warning';
  assert.equal((await registry.report(dashboard)).sources.at(-1).status, 'warning');
});

test('registered Codex stores select their own database, names, globals, and lifecycle without source writes', async (t) => {
  const { homeDir, registry, source } = await fixture(t);
  const roots = [path.join(homeDir, '.codex'), path.join(homeDir, 'second')];
  const files = [];
  for (const [index, root] of roots.entries()) {
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    const databasePath = path.join(root, `state_${index ? 7 : 5}.sqlite`);
    const rolloutPath = path.join(root, 'sessions', `rollout-${uuid}.jsonl`);
    const database = new DatabaseSync(databasePath);
    const fields = ['id', 'rollout_path', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'source',
      'model_provider', 'cwd', 'title', 'sandbox_policy', 'approval_mode', 'tokens_used', 'archived', 'git_sha',
      'git_branch', 'git_origin_url', 'cli_version', 'first_user_message', 'agent_nickname', 'agent_role',
      'memory_mode', 'model', 'reasoning_effort'];
    database.exec(`create table threads (${fields.map((field) => `${field} text`).join(',')})`);
    database.prepare('insert into threads(id, rollout_path, title, source, created_at_ms, updated_at_ms, archived) values (?, ?, ?, ?, ?, ?, ?)')
      .run(uuid, rolloutPath, 'Database title', 'cli', now - 1000, now, 0);
    database.close();
    const indexPath = path.join(root, 'session_index.jsonl');
    const globalsPath = path.join(root, '.codex-global-state.json');
    const authPath = path.join(root, 'auth.json');
    await writeFile(indexPath, JSON.stringify({ id: uuid, thread_name: index ? 'Personal name' : 'Default name' }) + '\n');
    await writeFile(globalsPath, '{}');
    await writeFile(authPath, 'Do not read private credentials');
    await writeFile(rolloutPath, JSON.stringify({ type: 'event_msg', timestamp: new Date(now - 1000).toISOString(),
      payload: { type: index ? 'task_started' : 'task_complete' } }) + '\n');
    for (const file of [databasePath, indexPath, globalsPath, authPath, rolloutPath]) files.push({ file, bytes: await readFile(file) });
  }
  await registry.update(source(roots[1]));
  const registered = await loadSwitchboardDashboard({ sources: await registry.read(), nowMs: now });
  assert.equal(registered.threads.length, 2);
  assert.deepEqual(registered.threads.map((row) => row.title).sort(), ['Default name', 'Personal name']);
  assert.equal(registered.threads.find((row) => row.id === uuid).state, 'idle');
  assert.equal(registered.threads.find((row) => row.id !== uuid).state, 'working');
  const legacy = await loadSwitchboardDashboard({ nowMs: now, loadClaude: async () => ({ threads: [] }),
    codexOptions: { databasePath: path.join(roots[0], 'state_5.sqlite'),
      sessionIndexPath: path.join(roots[0], 'session_index.jsonl'), globalStatePath: path.join(roots[0], '.codex-global-state.json') } });
  const { sourceId, sourceLabel, sourceNumber, sourceCount, sourceColor, sourceShowMarker, ...defaultRow } = registered.threads.find((row) => row.id === uuid);
  assert.deepEqual(defaultRow, legacy.threads[0]);
  assert.equal(legacy.threads[0].sourceNumber, undefined);
  assert.equal(legacy.threads[0].sourceCount, undefined);
  assert.equal(legacy.threads[0].sourceColor, undefined);
  assert.equal(legacy.threads[0].sourceShowMarker, undefined);
  assert.equal(JSON.stringify(registered).includes('private credentials'), false);
  for (const { file, bytes } of files) assert.deepEqual(await readFile(file), bytes);
});

test('source launchers receive one validated app URL and default sources retain xdg-open', async (t) => {
  const { launcher } = await fixture(t);
  const calls = [];
  const runCommand = async (...args) => { calls.push(args); return {}; };
  const rows = buildSwitchboardDashboard([
    { id: `personal:${uuid}`, externalId: uuid, provider: 'codex' },
    { id: `extra:local_${uuid}`, externalId: `local_${uuid}`, provider: 'claude-desktop-code' },
    { id: 'extra:cse_token', externalId: 'cse_token', provider: 'claude-desktop-code', source: 'claude-remote-cache' },
  ], [], now).threads;
  for (const row of rows) {
    assert.equal((await openSwitchboardThread(row, { launcher, runCommand })).opened, true);
    assert.deepEqual(calls.at(-1), [launcher, [row.appDeepLink], { detached: true, stdio: 'ignore' }]);
  }
  assert.equal((await openSwitchboardThread(rows[0], { platform: 'linux', runCommand })).opened, true);
  assert.deepEqual(calls.at(-1), ['xdg-open', [`codex://threads/${uuid}`], { timeout: 5000 }]);
  const count = calls.length;
  await assert.rejects(openSwitchboardThread({ ...rows[0], externalId: `${uuid};echo bad` }, { launcher, runCommand }));
  await assert.rejects(openSwitchboardThread({ ...rows[0], appDeepLink: 'file:///tmp/private' }, { launcher, runCommand }));
  await assert.rejects(openSwitchboardThread(rows[0], { launcher: '/bin/sh', runCommand }));
  assert.equal(calls.length, count);
});

test('a source app stays alive after the opener exits and beyond the old launch timeout', async (t) => {
  const { homeDir, launcher } = await fixture(t);
  const startedPath = path.join(homeDir, 'started.json');
  const stoppedPath = path.join(homeDir, 'stopped');
  await writeFile(launcher, `#!${process.execPath}\n
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stoppedPath)}, 'stopped'); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const row = buildSwitchboardDashboard([{ id: uuid, provider: 'codex' }], [], now).threads[0];
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
import { openSwitchboardThread } from ${JSON.stringify(new URL('../src/switchboard.mjs', import.meta.url).href)};
console.log(JSON.stringify(await openSwitchboardThread(${JSON.stringify(row)}, { launcher: ${JSON.stringify(launcher)} })));
`], { timeout: 2000 });
    assert.deepEqual(JSON.parse(stdout), { opened: true, method: 'codex-source-launcher' });
    await delay(5200);
    const app = JSON.parse(await readFile(startedPath, 'utf8'));
    assert.deepEqual(app.args, [row.appDeepLink]);
    process.kill(app.pid, 0);
  } finally {
    const app = JSON.parse(await readFile(startedPath, 'utf8').catch(() => 'null'));
    if (app) {
      try { process.kill(app.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let attempt = 0; attempt < 100 && !await stat(stoppedPath).catch(() => null); attempt += 1) await delay(20);
      assert.equal(await readFile(stoppedPath, 'utf8'), 'stopped');
    }
  }
});

test('source spawn errors and missing launchers preserve ASB unread attention', async (t) => {
  const { homeDir, registry, source, launcher } = await fixture(t);
  const dataDir = path.join(homeDir, 'second');
  await mkdir(dataDir);
  await registry.update(source(dataDir));
  const tracker = new PendingTracker(false);
  const server = await serve(t, { sourceRegistry: registry, pendingTracker: tracker, dashboardWatchPaths: [],
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, nowMs: now,
      loadCodex: async () => ({ threads: [{ id: uuid, provider: 'codex' }] }), loadClaude: async () => ({ threads: [] }) }),
  });
  const row = (await (await fetch(`${server.base}/api/dashboard`)).json()).threads[0];
  const route = `/api/threads/${encodeURIComponent(row.id)}`;
  assert.equal((await server.post(`${route}/mark-unread`, {})).status, 200);
  await writeFile(launcher, `#!${path.join(homeDir, 'missing-interpreter')}\n`);
  const failed = await server.post(`${route}/open`, {});
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).detail, /ENOENT/);
  assert.ok(tracker.records[row.id].manual > 0);
  await rm(launcher);
  const missing = await server.post(`${route}/open`, {});
  assert.equal(missing.status, 500);
  assert.match((await missing.json()).detail, /existing executable/);
  assert.ok(tracker.records[row.id].manual > 0);
  assert.equal((await (await fetch(`${server.base}/api/dashboard`)).json()).threads[0].unread, true);
});

test('source APIs enforce exact bodies and local actions, refresh rows, and update owned watch paths', async (t) => {
  const { homeDir, registry, source, launcher } = await fixture(t);
  await mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true });
  await mkdir(path.dirname(registry.configPath), { recursive: true });
  const extraDir = path.join(homeDir, 'second');
  await mkdir(path.join(extraDir, 'sessions'), { recursive: true });
  const watches = [];
  const opens = [];
  const server = await serve(t, { sourceRegistry: registry,
    watchDashboardPath(target, _options, callback) {
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; };
      watches.push({ target, callback, watcher });
      return watcher;
    },
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, nowMs: now,
      loadCodex: async () => ({ threads: [{ id: uuid, provider: 'codex' }] }), loadClaude: async () => ({ threads: [] }) }),
    openThread: async (thread, options) => { opens.push({ thread, options }); return { opened: true }; },
  });
  const initialResponse = await fetch(`${server.base}/api/sources`);
  assert.equal(initialResponse.status, 200);
  const initialSources = (await initialResponse.json()).sources;
  assert.deepEqual(initialSources.map((item) => item.color), ['#8296b4', '#a28caa']);
  assert.ok(initialSources.every((item) => item.showMarker === true));
  const otherOrigin = await server.post('/api/sources', { source: source(extraDir) }, { origin: 'http://example.test' });
  assert.equal(otherOrigin.status, 403);
  assert.equal((await server.post('/api/sources', { source: source(extraDir) }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get(`${server.base}/api/sources`, { headers: { host: 'evil.test' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${server.base}/api/sources`, { method: 'PUT', headers: { origin: server.base } })).status, 405);
  for (const body of [null, [], {}, { source: source(extraDir), command: 'run' }, { source: { ...source(extraDir), args: ['bad'] } }]) {
    assert.equal((await server.post('/api/sources', body)).status, 400);
  }
  const response = await server.post('/api/sources', { source: source(extraDir, { launcher }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.changed, true);
  assert.equal(result.maxSources, MAX_APP_SOURCES);
  const added = result.sources.find((item) => !item.builtin);
  assert.equal(added.sessionCount, 1);
  assert.equal(added.status, 'ready');
  assert.deepEqual([added.sourceNumber, added.sourceCount], [2, 2]);
  assert.match(added.color, /^#[0-9a-f]{6}$/);
  for (const color of [null, false, 123, [], {}, '#abc', '#8296b480', 'var(--accent)', 'url(file:///tmp/color)']) {
    assert.equal((await server.post('/api/sources', { source: source(extraDir, { id: added.id, color }) })).status, 400);
  }
  for (const showMarker of [null, 'false', 0, [], {}]) {
    assert.equal((await server.post('/api/sources', { source: source(extraDir, { id: added.id, showMarker }) })).status, 400);
  }
  const colorResponse = await server.post('/api/sources', { source: source(extraDir, { id: added.id, color: '#404040', showMarker: false }) });
  assert.equal(colorResponse.status, 200);
  const changed = (await colorResponse.json()).sources.find((item) => item.id === added.id);
  assert.equal(changed.color, '#404040');
  assert.equal(changed.showMarker, false);
  assert.equal(changed.enabled, true);
  assert.equal((await server.post('/api/sources', { source: source(extraDir, { id: added.id }) })).status, 200);
  const freshSources = (await (await fetch(`${server.base}/api/sources`)).json()).sources;
  assert.equal(freshSources.find((item) => item.id === added.id).color, '#404040');
  assert.equal(freshSources.find((item) => item.id === added.id).showMarker, false);
  assert.equal(freshSources.find((item) => item.id === 'codex').color, initialSources[0].color);
  assert.equal(freshSources.find((item) => item.id === 'codex').showMarker, true);
  assert.ok(watches.some((item) => item.target === extraDir && !item.watcher.closed));
  const rowId = `${added.id}:${uuid}`;
  const dashboard = await (await fetch(`${server.base}/api/dashboard`)).json();
  assert.equal(dashboard.threads.find((row) => row.id === uuid).sourceId, 'codex');
  assert.equal(dashboard.threads.find((row) => row.id === rowId).sourceId, added.id);
  assert.equal(dashboard.threads.find((row) => row.id === uuid).sourceColor, initialSources[0].color);
  assert.equal(dashboard.threads.find((row) => row.id === rowId).sourceColor, '#404040');
  assert.equal(dashboard.threads.find((row) => row.id === rowId).sourceShowMarker, false);
  assert.equal(dashboard.threads.find((row) => row.id === uuid).sourceShowMarker, true);
  assert.equal((await server.post('/api/sources', { source: source(extraDir, { id: added.id, showMarker: true }) })).status, 200);
  const restoredDot = (await (await fetch(`${server.base}/api/dashboard`)).json()).threads.find((row) => row.id === rowId);
  assert.equal(restoredDot.sourceShowMarker, true);
  const { sourceShowMarker: _marker, ...restoredRow } = restoredDot;
  const { sourceShowMarker: _hiddenMarker, ...hiddenRow } = dashboard.threads.find((row) => row.id === rowId);
  assert.deepEqual(restoredRow, hiddenRow);
  assert.equal((await server.post(`/api/threads/${encodeURIComponent(rowId)}/open`, {})).status, 200);
  assert.equal(opens.at(-1).options.launcher, launcher);
  assert.equal(opens.at(-1).thread.externalId, uuid);
  assert.equal((await server.post('/api/sources/codex/remove', {})).status, 400);
  assert.equal((await server.post(`/api/sources/${added.id}/remove`, { force: true })).status, 400);
  assert.equal((await server.post(`/api/sources/${added.id}/remove`, {})).status, 200);
  assert.equal((await server.post(`/api/threads/${encodeURIComponent(rowId)}/open`, {})).status, 404);
  assert.ok(watches.filter((item) => item.target.startsWith(extraDir)).every((item) => item.watcher.closed));
});

test('the switchboard server requires the window token for app source edits', async (t) => {
  const { registry, homeDir, source } = await fixture(t);
  for (const name of ['first', 'second']) await mkdir(path.join(homeDir, name));
  await registry.update(source(path.join(homeDir, 'first')));
  const before = await readFile(registry.configPath, 'utf8');
  const { post } = await serve(t, { sourceToken: 'window-token', sourceRegistry: registry,
    pendingStatePath: path.join(homeDir, 'pending.json'), dashboardWatchPaths: [] });
  const body = { source: source(path.join(homeDir, 'second'), { label: 'Third app' }) };
  for (const route of ['/api/sources', `/api/sources/${(await registry.read())[2].id}/remove`]) {
    assert.equal((await post(route, route.endsWith('/remove') ? {} : body)).status, 403);
    assert.equal(await readFile(registry.configPath, 'utf8'), before);
  }
  assert.equal((await post('/api/sources', body, { 'X-ASB-Source-Token': 'window-token' })).status, 200);
  assert.equal(JSON.parse(await readFile(registry.configPath, 'utf8')).sources.length, JSON.parse(before).sources.length + 1);
});

test('external registry edits have a polling fallback and stale rows cannot open in a changed store', async (t) => {
  const { homeDir, registry, source } = await fixture(t);
  const dataDir = path.join(homeDir, 'second');
  const changedDir = path.join(homeDir, 'changed');
  await mkdir(dataDir);
  await mkdir(changedDir);
  await registry.update(source(dataDir));
  let clock = now;
  let opens = 0;
  const server = await serve(t, { sourceRegistry: registry, now: () => clock, dashboardWatchPaths: [],
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, nowMs: clock,
      loadCodex: async () => ({ threads: [{ id: uuid, provider: 'codex' }] }), loadClaude: async () => ({ threads: [] }) }),
    openThread: async () => { opens += 1; return { opened: true }; },
  });
  const initial = await (await fetch(`${server.base}/api/dashboard`)).json();
  const row = initial.threads[0];
  const stored = JSON.parse(await readFile(registry.configPath, 'utf8'));
  stored.sources.find((item) => !item.builtin).dataDir = changedDir;
  await writeFile(registry.configPath, JSON.stringify(stored));
  assert.equal((await server.post(`/api/threads/${encodeURIComponent(row.id)}/open`, {})).status, 500);
  assert.equal(opens, 0);
  clock += 5_001;
  assert.equal((await server.post(`/api/threads/${encodeURIComponent(row.id)}/open`, {})).status, 200);
  assert.equal(opens, 1);
  stored.sources.find((item) => !item.builtin).enabled = false;
  await writeFile(registry.configPath, JSON.stringify(stored));
  clock += 5_001;
  const fresh = await (await fetch(`${server.base}/api/dashboard`)).json();
  assert.equal(fresh.threads.length, 0);
  assert.equal((await (await fetch(`${server.base}/api/sources`)).json()).sources.at(-1).status, 'disabled');
});

test('dynamic source paths retain recursive fallback and discover new directories on the existing retry clock', async (t) => {
  const { homeDir, registry } = await fixture(t);
  const sessions = path.join(homeDir, '.codex', 'sessions');
  await mkdir(sessions, { recursive: true });
  const watches = [];
  const timers = [];
  let unsupported = 0;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  await serve(t, { sourceRegistry: registry, loadDashboard: async () => ({ threads: [], providers: [] }), dashboardPlatform: 'darwin',
    dashboardSetTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      ready();
      return timer;
    }, dashboardClearTimeout(timer) { timer.cancelled = true; },
    watchDashboardPath(target, options, callback) {
      if (options.recursive) {
        unsupported += 1;
        throw Object.assign(new Error('Recursive watch is unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
      }
      const watcher = new EventEmitter();
      watcher.close = () => { watcher.closed = true; };
      watches.push({ target, watcher, callback });
      return watcher;
    },
  });
  await started;
  assert.equal(unsupported, 1);
  const childDir = path.join(sessions, 'new', 'nested');
  await mkdir(childDir, { recursive: true });
  watches.find((item) => item.target === sessions).callback('rename', 'new');
  await timers.find((timer) => timer.milliseconds === 5000).callback();
  assert.ok(watches.some((item) => item.target === childDir));
  assert.equal(unsupported, 1);
  assert.ok(timers.filter((timer) => timer.milliseconds !== 5000).every((timer) => timer.milliseconds === 250));
});

test('an extra profile without a launcher retains its rows but cannot use the default URL handler', async (t) => {
  const { homeDir, registry, source, launcher } = await fixture(t);
  const dataDir = path.join(homeDir, 'second');
  await mkdir(dataDir);
  await registry.update(source(dataDir));
  const stored = JSON.parse(await readFile(registry.configPath, 'utf8'));
  const extra = stored.sources.find((item) => !item.builtin);
  let opens = 0;
  const server = await serve(t, { sourceRegistry: registry, dashboardWatchPaths: [],
    loadDashboard: (options) => loadSwitchboardDashboard({ ...options, nowMs: now,
      loadCodex: async () => ({ threads: [{ id: uuid, provider: 'codex' }] }), loadClaude: async () => ({ threads: [] }) }),
    openThread: async () => { opens += 1; return { opened: true }; },
  });
  const initial = await (await fetch(`${server.base}/api/dashboard`)).json();
  extra.launcher = '';
  await writeFile(registry.configPath, JSON.stringify(stored));
  assert.equal((await server.post(`/api/threads/${encodeURIComponent(initial.threads[0].id)}/open`, {})).status, 500);
  assert.equal(opens, 0);
  const dashboard = await loadSwitchboardDashboard({ sources: await registry.read(), nowMs: now,
    loadCodex: async () => ({ threads: [{ id: uuid, provider: 'codex' }] }), loadClaude: async () => ({ threads: [] }) });
  assert.equal(dashboard.threads.length, 1);
  assert.equal(dashboard.threads[0].canOpen, false);
  assert.equal((await registry.report(dashboard)).sources.at(-1).status, 'error');
  await assert.rejects(openSwitchboardThread(dashboard.threads[0], { runCommand: async () => { opens += 1; } }));
  assert.equal(opens, 0);
  const { builtin, ...edit } = extra;
  await registry.update({ ...edit, enabled: false });
  assert.equal((await registry.read()).at(-1).enabled, false);
  await assert.rejects(registry.update({ ...edit, enabled: true }), /own installed app launcher/);
  await registry.update({ ...edit, launcher });
  await rm(launcher);
  await registry.update({ ...edit, launcher, enabled: false });
  await assert.rejects(registry.update({ ...edit, launcher, enabled: true }), /existing executable/);
});
