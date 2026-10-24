import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BRIDGE_STATES, coverageApps, createBridgeCoverage, installCommand } from '../src/bridge-coverage.mjs';

const HOME = path.resolve('/synthetic/home');
const CODEX = path.join(HOME, '.codex');
const CLAUDE = path.join(HOME, '.claude');
const EXTRA = path.join(HOME, '.claude-work');
const OPTIONS = { platform: 'linux', homeDir: HOME };

const codexItem = (change = {}) => ({ home: CODEX, oldPlugin: false, skill: 'ok', skillCurrent: true, bunOnAppServerPath: true,
  plugin: { installed: true, enabled: true, version: '1.2.0', versionMatches: true }, hooks: { session_start: true, session_end: true }, ...change });
const report = (change = {}) => ({
  codex: [codexItem()],
  claude: { home: CLAUDE },
  claudeHomes: [{ home: CLAUDE, skill: 'ok', skillCurrent: true }, { home: EXTRA, skill: 'ok', skillCurrent: true }],
  opencode: { plugin: 'ok', warning: null, versionMatches: true, skillCurrent: true, version: '1.2.0', expectedVersion: '1.2.0', liveReceiverSessions: ['o1', 'o2'] },
  liveReceiverSessions: [],
  versions: { bun: 'bun 1.3.0' },
  ...change,
});
const SOURCES = {
  codex: { id: 'codex', provider: 'codex', enabled: true, label: 'Codex', dataDir: CODEX },
  claude: { id: 'claude', provider: 'claude-desktop-code', enabled: true, label: 'Claude', projectsDir: path.join(CLAUDE, 'projects') },
  work: { id: 'claude-work', provider: 'claude-desktop-code', enabled: true, label: 'Work', projectsDir: path.join(EXTRA, 'projects') },
  opencode: { id: 'opencode', provider: 'opencode', enabled: true, label: 'OpenCode', dataDir: path.join(HOME, '.local/share/opencode') },
};
const only = (status, source, threads = []) => coverageApps(status, [source], threads, OPTIONS)[0];

test('the bridge states are the brief list', () => {
  assert.deepEqual(BRIDGE_STATES, ['ready', 'update', 'hooks', 'off', 'nobun', 'missing', 'conflict', 'old-app', 'unknown']);
});

test('Codex rules 1 to 9 match in order', () => {
  const plugin = (change) => ({ plugin: { ...codexItem().plugin, ...change } });
  for (const [name, codex, state] of [
    ['1 no item', [], 'missing'],
    ['2 old plugin before all others', [codexItem({ oldPlugin: true, skill: 'foreign', ...plugin({ installed: false }) })], 'conflict'],
    ['3 foreign skill', [codexItem({ skill: 'foreign', ...plugin({ installed: false }) })], 'conflict'],
    ['3 modified skill', [codexItem({ skill: 'modified' })], 'conflict'],
    ['4 no plugin', [codexItem({ ...plugin({ installed: false, enabled: false }) })], 'missing'],
    ['5 disabled', [codexItem({ ...plugin({ enabled: false }), bunOnAppServerPath: false })], 'off'],
    ['6 no bun', [codexItem({ bunOnAppServerPath: false, ...plugin({ versionMatches: false }) })], 'nobun'],
    ['6 bun unknown is not nobun', [codexItem({ bunOnAppServerPath: null })], 'ready'],
    ['7 old version', [codexItem({ ...plugin({ versionMatches: false }), hooks: {} })], 'update'],
    ['7 old skill', [codexItem({ skillCurrent: false })], 'update'],
    ['7 skill current unknown', [codexItem({ skillCurrent: null })], 'update'],
    ['8 hooks', [codexItem({ hooks: { session_start: true, session_end: false } })], 'hooks'],
    ['9 ready', [codexItem()], 'ready'],
  ]) {
    const app = only(report({ codex }), SOURCES.codex);
    assert.equal(app.state, state, name);
    assert.equal(app.canInstall, ['missing', 'update'].includes(state), name);
  }
  const app = only(report(), SOURCES.codex);
  assert.deepEqual(app, { sourceId: 'codex', label: 'Codex', provider: 'codex', state: 'ready', version: '1.2.0', live: 0,
    install: { args: ['--codex-home', CODEX], env: {} }, command: 'asb bridge install --codex-home ~/.codex', canInstall: false });
  assert.equal(only(report({ codex: [] }), SOURCES.codex).version, null);
});

test('Claude rules 1 to 5 match in order for the default and an extra home', () => {
  for (const source of [SOURCES.claude, SOURCES.work]) {
    const home = source === SOURCES.claude ? CLAUDE : EXTRA;
    const item = (change) => ({ claudeHomes: [{ home, skill: 'ok', skillCurrent: true, ...change }] });
    for (const [name, change, state] of [
      ['1 no item', { claudeHomes: [] }, 'unknown'],
      ['1 no list', { claudeHomes: undefined }, 'unknown'],
      ['2 foreign', item({ skill: 'foreign', skillCurrent: null }), 'conflict'],
      ['2 modified', item({ skill: 'modified', skillCurrent: null }), 'conflict'],
      ['3 missing', item({ skill: 'missing', skillCurrent: null }), 'missing'],
      ['4 old', item({ skillCurrent: false }), 'update'],
      ['5 ready', item({}), 'ready'],
    ]) {
      const app = only(report(change), source);
      assert.equal(app.state, state, `${source.id} ${name}`);
      assert.equal(app.version, state === 'ready' ? '1.2.0' : null);
      assert.equal(app.live, null);
    }
  }
  const main = only(report(), SOURCES.claude), work = only(report(), SOURCES.work);
  assert.deepEqual(main.install, { args: ['--claude'], env: {} });
  assert.equal(main.command, 'asb bridge install --claude');
  assert.deepEqual(work.install, { args: ['--claude'], env: { CLAUDE_CONFIG_DIR: EXTRA } });
  assert.equal(work.command, 'CLAUDE_CONFIG_DIR=~/.claude-work asb bridge install --claude');
  // No projectsDir: the default Claude home.
  const fallback = only(report({ claudeHomes: [] }), { id: 'c', provider: 'claude-desktop-code', enabled: true, label: 'C' });
  assert.equal(fallback.state, 'unknown');
});

test('OpenCode rules 1 to 5 match in order', () => {
  const o = report().opencode;
  for (const [name, change, state] of [
    ['1 foreign', { plugin: 'foreign', warning: 'old', versionMatches: false }, 'conflict'],
    ['1 modified', { plugin: 'modified' }, 'conflict'],
    ['2 missing', { plugin: 'missing', warning: 'old' }, 'missing'],
    ['3 old app', { warning: 'OpenCode is older than 2.1.2; the ASB Bridge plugin will not load.', versionMatches: false }, 'old-app'],
    ['4 old version', { versionMatches: false }, 'update'],
    ['4 old skill', { skillCurrent: false }, 'update'],
    ['5 ready', {}, 'ready'],
  ]) assert.equal(only(report({ opencode: { ...o, ...change } }), SOURCES.opencode).state, state, name);
  const app = only(report(), SOURCES.opencode);
  assert.equal(app.version, '1.2.0');
  assert.equal(app.live, 2);
  assert.deepEqual(app.install, { args: ['--opencode'], env: {} });
  assert.equal(app.command, 'asb bridge install --opencode');
  assert.equal(only(report({ opencode: { ...o, version: undefined, liveReceiverSessions: undefined } }), SOURCES.opencode).live, 0);
});

test('disabled sources and other providers are left out; labels fall back to name and id', () => {
  const sources = [{ ...SOURCES.codex, enabled: false }, { id: 'x', provider: 'claude-cli', enabled: true, label: 'CLI' },
    { ...SOURCES.claude, enabled: 'yes' }, { ...SOURCES.opencode, label: '', name: 'Named' }, { ...SOURCES.work, label: '', name: '' }];
  const apps = coverageApps(report(), sources, [], OPTIONS);
  assert.deepEqual(apps.map((app) => [app.sourceId, app.label]), [['opencode', 'Named'], ['claude-work', 'claude-work']]);
});

test('live counts: Codex only its own receiver threads, Claude null, OpenCode all its ids', () => {
  const threads = [
    { id: 'a', provider: 'codex', sourceId: 'codex' },
    { id: 'row-b', externalId: 'b', provider: 'codex', sourceId: 'codex' },
    { id: 'c', provider: 'codex', sourceId: 'codex-personal' },
    { id: 'd', provider: 'codex' },
    { id: 'e', provider: 'claude-desktop-code', sourceId: 'codex' },
    { id: 'row-b2', externalId: 'row-b', provider: 'codex', sourceId: 'codex' },
  ];
  const status = report({ liveReceiverSessions: ['a', 'b', 'c', 'd', 'e', 'row-b', 'zzz'] });
  // a, b, row-b match; d belongs to source id "codex" through its provider fallback.
  assert.equal(only(status, SOURCES.codex, threads).live, 4);
  assert.equal(only(status, { ...SOURCES.codex, id: 'codex-personal' }, threads).live, 1);
  assert.equal(only(status, SOURCES.claude, threads).live, null);
  assert.equal(only(status, SOURCES.work, threads).live, null);
  assert.equal(only(status, SOURCES.opencode, threads).live, 2);
});

test('installCommand writes home-relative POSIX and PowerShell forms, else null', () => {
  const posix = { platform: 'linux', homeDir: '/home/u' };
  const codex = (home) => ({ provider: 'codex', install: { args: ['--codex-home', home], env: {} } });
  assert.equal(installCommand(codex('/home/u/.codex'), posix), 'asb bridge install --codex-home ~/.codex');
  assert.equal(installCommand(codex('/home/u/.codex-personal'), posix), 'asb bridge install --codex-home ~/.codex-personal');
  assert.equal(installCommand(codex('/home/u'), posix), 'asb bridge install --codex-home ~');
  assert.equal(installCommand(codex('/srv/.codex'), posix), null);
  assert.equal(installCommand(codex('/home/u/my codex'), posix), null);
  assert.equal(installCommand(codex('/home/u/$(x)'), posix), null);
  const claude = (env) => ({ provider: 'claude-desktop-code', install: { args: ['--claude'], env } });
  assert.equal(installCommand(claude({}), posix), 'asb bridge install --claude');
  assert.equal(installCommand(claude({ CLAUDE_CONFIG_DIR: '/home/u/.claude-work' }), posix), 'CLAUDE_CONFIG_DIR=~/.claude-work asb bridge install --claude');
  assert.equal(installCommand(claude({ CLAUDE_CONFIG_DIR: '/tmp/claude' }), posix), null);
  const win = { platform: 'win32', homeDir: 'C:\\Users\\u' };
  assert.equal(installCommand(codex('C:\\Users\\u\\.codex'), win), 'asb bridge install --codex-home "$env:USERPROFILE\\.codex"');
  assert.equal(installCommand(codex('C:\\Users\\u\\My Codex'), win), 'asb bridge install --codex-home "$env:USERPROFILE\\My Codex"');
  assert.equal(installCommand(codex('C:\\Users\\u'), win), 'asb bridge install --codex-home "$env:USERPROFILE"');
  assert.equal(installCommand(codex('D:\\codex'), win), null);
  assert.equal(installCommand(codex('C:\\Users\\u\\a$b'), win), null);
  assert.equal(installCommand(claude({ CLAUDE_CONFIG_DIR: 'C:\\Users\\u\\.claude-work' }), win), '$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-work"; asb bridge install --claude');
  assert.equal(installCommand(claude({}), win), 'asb bridge install --claude');
  assert.equal(installCommand({ provider: 'opencode', install: { args: ['--opencode'], env: {} } }, posix), 'asb bridge install --opencode');
});

function service(t, { status = report(), sources = Object.values(SOURCES), code = 0, stdout, run, ...options } = {}) {
  let time = 1_000;
  const calls = [];
  const runCli = run || (async (args, opts) => {
    calls.push({ args, opts });
    return { code, stdout: stdout ?? JSON.stringify(status), stderr: '' };
  });
  const coverage = createBridgeCoverage({ runCli: async (args, opts) => { if (run) calls.push({ args, opts }); return runCli(args, opts); },
    readSources: async () => sources, readThreads: async () => [], machine: () => ({ machineId: 'm1', name: 'Desk', asbVersion: '1.12.0' }),
    now: () => time, ...OPTIONS, ...options });
  return { coverage, calls, advance: (ms) => { time += ms; } };
}

test('the check runs the CLI once per ttl, again with force, and once for parallel calls', async (t) => {
  const s = service(t);
  const first = await s.coverage.local();
  assert.deepEqual(s.calls[0], { args: ['status', '--json', '--claude-home', CLAUDE, '--claude-home', EXTRA], opts: { timeoutMs: 30_000, env: {} } });
  assert.equal(first.expectedVersion, '1.2.0');
  assert.equal(first.bun, true);
  assert.equal(first.checkedAtMs, 1_000);
  assert.deepEqual(first.apps.map((app) => app.state), ['ready', 'ready', 'ready', 'ready']);
  s.advance(59_999);
  assert.equal(await s.coverage.local(), first);
  assert.equal(s.calls.length, 1);
  await s.coverage.local({ force: true });
  assert.equal(s.calls.length, 2);
  s.advance(60_000);
  const [a, b] = await Promise.all([s.coverage.local(), s.coverage.local({ force: true })]);
  assert.equal(a, b);
  assert.equal(s.calls.length, 3);
  const reply = await s.coverage.status();
  assert.deepEqual(reply, { api: 1, expectedVersion: '1.2.0', machines: [{ machineId: 'm1', name: 'Desk', isSelf: true, online: true,
    lastOkAtMs: reply.machines[0].lastOkAtMs, asbVersion: '1.12.0', state: 'ok', checking: false, checkedAtMs: a.checkedAtMs, apps: a.apps, live: null }] });
  assert.equal(s.calls.length, 3);
  await s.coverage.status({ force: true });
  assert.equal(s.calls.length, 4);
});

test('the same Claude home goes once to the CLI and disabled Claude sources are left out', async (t) => {
  const s = service(t, { sources: [SOURCES.claude, { ...SOURCES.claude, id: 'other' }, { ...SOURCES.work, enabled: false }] });
  await s.coverage.local();
  assert.deepEqual(s.calls[0].args, ['status', '--json', '--claude-home', CLAUDE]);
});

test('a slow CLI gives checking after waitMs and ok later', async (t) => {
  let finish;
  const s = service(t, { waitMs: 20, run: () => new Promise((resolve) => { finish = () => resolve({ code: 0, stdout: JSON.stringify(report()), stderr: '' }); }) });
  const early = await s.coverage.status();
  assert.equal(early.machines[0].state, 'checking');
  assert.equal(early.machines[0].checking, true);
  assert.deepEqual(early.machines[0].apps, []);
  assert.equal(early.machines[0].checkedAtMs, null);
  assert.equal(early.expectedVersion, '');
  finish();
  const later = await s.coverage.status();
  assert.equal(later.machines[0].state, 'ok');
  assert.equal(later.machines[0].checking, false);
  assert.equal(later.machines[0].apps.length, 4);
  assert.equal(s.calls.length, 1);
});

test('a failed check gives the fixed error text and no CLI output', async (t) => {
  for (const options of [{ code: 1, stdout: '/secret/path stack' }, { stdout: '{bad json /secret/path' }, { code: null, stdout: '' },
    { run: async () => { throw new Error('/secret/path'); } }]) {
    const s = service(t, options);
    const reply = await s.coverage.status();
    assert.deepEqual(Object.keys(reply.machines[0]).includes('error'), true);
    assert.equal(reply.machines[0].state, 'error');
    assert.equal(reply.machines[0].error, 'ASB cannot check ASB Bridge. Run asb bridge status in a terminal.');
    assert.deepEqual(reply.machines[0].apps, []);
    assert.ok(!JSON.stringify(reply).includes('secret'));
  }
});

test('install checks the body and gives 404 when nothing can install', async (t) => {
  const s = service(t);
  for (const body of [null, [], 'codex', {}, { sourceId: '' }, { sourceId: 'x'.repeat(81) }, { sourceId: 5 }, { all: false }, { all: 'true' },
    { sourceId: 'codex', all: true }, { sourceId: 'codex', extra: 1 }]) {
    assert.deepEqual(await s.coverage.install(body), { status: 400, body: { error: 'Invalid install request.' } }, JSON.stringify(body));
  }
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await s.coverage.install({ sourceId: 'codex' }), { status: 404, body: { error: 'This profile has nothing to install.' } });
  assert.deepEqual(await s.coverage.install({ sourceId: 'x'.repeat(80) }), { status: 404, body: { error: 'This profile has nothing to install.' } });
  assert.deepEqual(await s.coverage.install({ all: true }), { status: 404, body: { error: 'This profile has nothing to install.' } });
  assert.equal(s.calls.length, 1);
});

test('install runs one Codex profile, then a forced check', async (t) => {
  const status = report({ codex: [codexItem({ plugin: { ...codexItem().plugin, versionMatches: false } })] });
  const s = service(t, { status });
  const result = await s.coverage.install({ sourceId: 'codex' });
  assert.deepEqual(s.calls.map((call) => call.args), [['status', '--json', '--claude-home', CLAUDE, '--claude-home', EXTRA],
    ['install', '--codex-home', CODEX], ['status', '--json', '--claude-home', CLAUDE, '--claude-home', EXTRA]]);
  assert.deepEqual(s.calls[1].opts, { timeoutMs: 180_000, env: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test('install all runs the plain targets together and an extra Claude home with its env', async (t) => {
  const missing = (home) => ({ home, skill: 'missing', skillCurrent: null });
  const status = report({ codex: [], claudeHomes: [missing(CLAUDE), missing(EXTRA)], opencode: { ...report().opencode, plugin: 'missing' } });
  const outputs = [];
  let n = 0;
  const s = service(t, { run: async (args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(status), stderr: '' };
    n++;
    outputs.push(n);
    return { code: n === 2 ? 1 : 0, stdout: `out ${n}`, stderr: n === 2 ? `err ${n}` : '' };
  } });
  const result = await s.coverage.install({ all: true });
  const installs = s.calls.filter((call) => call.args[0] === 'install');
  assert.deepEqual(installs, [
    { args: ['install', '--codex-home', CODEX, '--claude', '--opencode'], opts: { timeoutMs: 180_000, env: {} } },
    { args: ['install', '--claude'], opts: { timeoutMs: 180_000, env: { CLAUDE_CONFIG_DIR: EXTRA } } },
  ]);
  assert.equal(s.calls.at(-1).args[0], 'status');
  assert.deepEqual(result, { status: 200, body: { ok: false, output: 'out 1\nout 2\nerr 2' } });
});

test('a second install while one runs gets 409, and output keeps the last 4000 characters', async (t) => {
  const status = report({ codex: [codexItem({ skillCurrent: false })] });
  let release, started = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = service(t, { run: async (args) => {
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(status), stderr: '' };
    started = true;
    await gate;
    return { code: 0, stdout: `${'a'.repeat(5000)}END`, stderr: '' };
  } });
  const first = s.coverage.install({ sourceId: 'codex' });
  assert.deepEqual(await s.coverage.install({ sourceId: 'codex' }), { status: 409, body: { error: 'An install is running. Wait for it to end.' } });
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  release();
  const result = await first;
  assert.equal(result.body.output.length, 4000);
  assert.ok(result.body.output.endsWith('END'));
  assert.equal((await s.coverage.install({ sourceId: 'codex' })).status, 200);
});

for (const order of ['status first', 'install first']) {
  test(`the check after an install starts after the last install run (${order})`, async (t) => {
    const old = report({ codex: [codexItem({ skillCurrent: false })] }), fresh = report();
    let installed = false, releaseInstall, releaseStatus, statusWaiting = false, installWaiting = false;
    const installGate = new Promise((resolve) => { releaseInstall = resolve; });
    const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
    let statusRuns = 0;
    const s = service(t, { run: async (args) => {
      if (args[0] === 'install') { installWaiting = true; await installGate; installed = true; return { code: 0, stdout: 'ok', stderr: '' }; }
      // The state is read when the run starts.
      const state = installed ? fresh : old;
      statusRuns++;
      if (statusRuns === 2) { statusWaiting = true; await statusGate; }
      return { code: 0, stdout: JSON.stringify(state), stderr: '' };
    } });
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const install = s.coverage.install({ sourceId: 'codex' });
    while (!installWaiting) await tick();
    const during = s.coverage.status({ force: true });
    while (!statusWaiting) await tick();
    if (order === 'status first') { releaseStatus(); await during; releaseInstall(); }
    else { releaseInstall(); await tick(); releaseStatus(); await during; }
    assert.equal((await install).status, 200);
    const kinds = s.calls.map((call) => call.args[0]);
    assert.equal(kinds.at(-1), 'status');
    assert.ok(kinds.lastIndexOf('status') > kinds.lastIndexOf('install'));
    assert.equal((await s.coverage.local()).apps.find((app) => app.sourceId === 'codex').state, 'ready');
    assert.equal((await s.coverage.status()).machines[0].apps.find((app) => app.sourceId === 'codex').state, 'ready');
  });
}

test('coverageApps uses the win32 path rules for a win32 platform', () => {
  const status = report({ codex: [codexItem({ home: 'c:\\users\\me\\.codex' })] });
  const source = { id: 'codex', provider: 'codex', enabled: true, label: 'Codex', dataDir: 'C:\\Users\\me\\.codex' };
  const [app] = coverageApps(status, [source], [], { platform: 'win32', homeDir: 'C:\\Users\\me' });
  assert.equal(app.state, 'ready');
  assert.deepEqual(app.install.args, ['--codex-home', 'C:\\Users\\me\\.codex']);
  assert.equal(app.command, 'asb bridge install --codex-home "$env:USERPROFILE\\.codex"');
  const work = { id: 'work', provider: 'claude-desktop-code', enabled: true, label: 'Work', projectsDir: 'C:\\Users\\me\\.claude-work\\projects' };
  const [claude] = coverageApps(report({ claude: { home: 'C:\\Users\\me\\.claude' }, claudeHomes: [{ home: 'c:\\users\\me\\.claude-work', skill: 'missing', skillCurrent: null }] }),
    [work], [], { platform: 'win32', homeDir: 'C:\\Users\\me' });
  assert.equal(claude.state, 'missing');
  assert.deepEqual(claude.install.env, { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-work' });
  assert.equal(claude.command, '$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-work"; asb bridge install --claude');
});

test('an off Codex profile is not installable', async (t) => {
  const s = service(t, { status: report({ codex: [codexItem({ plugin: { ...codexItem().plugin, enabled: false } })] }) });
  assert.equal((await s.coverage.local()).apps[0].state, 'off');
  assert.equal((await s.coverage.local()).apps[0].canInstall, false);
  assert.deepEqual(await s.coverage.install({ sourceId: 'codex' }), { status: 404, body: { error: 'This profile has nothing to install.' } });
});

const REPORT_KEYS = ['sourceId', 'label', 'provider', 'state', 'version', 'live', 'command'];

test('report gives the member body without install data or paths', async (t) => {
  const outside = { id: 'codex-other', provider: 'codex', enabled: true, label: 'Server', dataDir: path.resolve('/srv/private-data/.codex') };
  const status = report({ codex: [codexItem(), codexItem({ home: outside.dataDir })] });
  const s = service(t, { status, sources: [...Object.values(SOURCES), outside] });
  const reply = await s.coverage.report();
  const apps = (await s.coverage.local()).apps;
  assert.deepEqual(reply, { status: 200, body: { api: 1, asbVersion: '1.12.0', checkedAtMs: 1_000, expectedVersion: '1.2.0',
    apps: apps.map((app) => Object.fromEntries(REPORT_KEYS.map((key) => [key, app[key]]))) } });
  for (const app of reply.body.apps) assert.deepEqual(Object.keys(app), REPORT_KEYS);
  assert.equal(reply.body.apps.at(-1).command, null);
  const text = JSON.stringify(reply.body);
  for (const part of ['srv', 'private-data', HOME, 'synthetic']) assert.ok(!text.includes(part), part);
  assert.equal(s.calls.length, 1);
});

test('report is 503 while the first check runs, and the error body after a failed check', async (t) => {
  const slow = service(t, { reportWaitMs: 20, run: () => new Promise(() => {}) });
  assert.deepEqual(await slow.coverage.report(), { status: 503, body: { error: 'ASB is checking ASB Bridge.' } });
  const failed = service(t, { code: 1 });
  assert.deepEqual(await failed.coverage.report(), { status: 200, body: { api: 1, asbVersion: '1.12.0', checkedAtMs: 1_000, expectedVersion: '', apps: [], error: 'check' } });
});

const memberApp = { sourceId: 'codex', label: 'Codex \uD800', provider: 'codex', state: 'ready', version: '1.2.0', live: 1, command: 'asb bridge install --codex-home ~/.codex' };
const memberBody = (change = {}) => ({ api: 1, asbVersion: '1.12.0', checkedAtMs: 900, expectedVersion: '1.2.0', apps: [{ ...memberApp }], ...change });
const member = (machineId, name, change = {}) => ({ machineId, name, online: true, lastOkAtMs: 500, addresses: [], isSelf: false, asbVersion: '1.11.0', ...change });
function fakeGroup(members, reply) {
  const calls = [];
  return { calls, members,
    status: async () => ({ members: [{ machineId: 'm1', name: 'Desk', online: true, lastOkAtMs: 1, isSelf: true, asbVersion: '1.12.0' }, ...members] }),
    fetchMember: async (machineId, route, options) => { calls.push([machineId, route, options]); return reply(machineId, calls.length); } };
}
const machineOf = async (s, machineId, options) => (await s.coverage.status(options)).machines.find((item) => item.machineId === machineId);

test('status adds offline and ok members after this machine, in group order', async (t) => {
  const group = fakeGroup([member('off', 'Off', { online: false }), member('lap', 'Lap')], () => ({ status: 200, body: memberBody() }));
  const s = service(t, { group });
  const reply = await s.coverage.status();
  assert.deepEqual(reply.machines.map((item) => [item.machineId, item.isSelf, item.state]), [['m1', true, 'ok'], ['off', false, 'offline'], ['lap', false, 'ok']]);
  assert.deepEqual(reply.machines[1], { machineId: 'off', name: 'Off', isSelf: false, online: false, lastOkAtMs: 500, asbVersion: '1.11.0',
    state: 'offline', checking: false, checkedAtMs: null, apps: [], live: null });
  assert.deepEqual(reply.machines[2], { machineId: 'lap', name: 'Lap', isSelf: false, online: true, lastOkAtMs: 500, asbVersion: '1.11.0',
    state: 'ok', checking: false, checkedAtMs: 900, apps: [{ ...memberApp, label: 'Codex �', canInstall: false }], live: null });
  assert.deepEqual(Object.keys(reply.machines[2]), Object.keys(reply.machines[0]));
  assert.deepEqual(group.calls, [['lap', '/peer/v1/bridge', { timeoutMs: 4000 }]]);
});

test('a member body that ASB cannot read is an error with the exact text', async (t) => {
  const app = (change) => ({ apps: [{ ...memberApp, ...change }] });
  for (const body of [null, [], memberBody({ api: 2 }), app({ extra: 1 }), app({ state: 'great' }), app({ live: 10_001 }), app({ live: 1.5 }),
    app({ command: 'asb bridge install\n--claude' }), app({ command: 'x'.repeat(301) }), app({ sourceId: '' }), app({ sourceId: 'x'.repeat(81) }),
    app({ label: 'x'.repeat(81) }), app({ provider: 'claude-cli' }), app({ version: 1 }), memberBody({ apps: Array(33).fill(memberApp) }),
    memberBody({ checkedAtMs: Infinity }), memberBody({ error: 'other' }), memberBody({ asbVersion: 'x'.repeat(41) }), memberBody({ expectedVersion: null })]) {
    const s = service(t, { group: fakeGroup([member('lap', 'Lap')], () => ({ status: 200, body })) });
    const lap = await machineOf(s, 'lap');
    assert.deepEqual([lap.state, lap.error, lap.apps, lap.live], ['error', 'Lap sent a bridge state that ASB cannot read.', [], null], JSON.stringify(body));
  }
});

test('member replies map to error, old, checking, and error texts', async (t) => {
  const failed = service(t, { group: fakeGroup([member('lap', 'Lap')], () => ({ status: 200, body: memberBody({ apps: [], expectedVersion: '', error: 'check' }) })) });
  const lap = await machineOf(failed, 'lap');
  assert.deepEqual([lap.state, lap.error, lap.checkedAtMs, lap.apps], ['error', 'ASB on Lap cannot check ASB Bridge.', 900, []]);
  const relay = { remotePeers: () => ({ peers: [{ machineId: 'lap' }, { machineId: 'lap' }, { machineId: 'other' }] }) };
  const old = service(t, { relay, group: fakeGroup([member('lap', 'Lap')], () => ({ status: 404, body: { error: 'Route is not available.' } })) });
  assert.deepEqual(await machineOf(old, 'lap'), { machineId: 'lap', name: 'Lap', isSelf: false, online: true, lastOkAtMs: 500, asbVersion: '1.11.0',
    state: 'old', checking: false, checkedAtMs: null, apps: [], live: 2 });
  const noRelay = service(t, { group: fakeGroup([member('lap', 'Lap')], () => ({ status: 404, body: {} })) });
  assert.equal((await machineOf(noRelay, 'lap')).live, null);
  const checking = fakeGroup([member('lap', 'Lap')], (id, n) => n === 1 ? { status: 503, body: { error: 'ASB is checking ASB Bridge.' } } : { status: 200, body: memberBody() });
  const busy = service(t, { group: checking });
  const first = await machineOf(busy, 'lap');
  assert.deepEqual([first.state, first.apps, first.live], ['checking', [], null]);
  // A 503 is not cached: the next call asks again.
  assert.equal((await machineOf(busy, 'lap')).state, 'ok');
  assert.equal(checking.calls.length, 2);
  for (const reply of [() => ({ status: 500, body: {} }), () => { throw new Error('/secret/path'); }, () => { throw new Error('offline'); }]) {
    const s = service(t, { group: fakeGroup([member('lap', 'Lap')], reply) });
    const value = await machineOf(s, 'lap');
    assert.deepEqual([value.state, value.error, value.live], ['error', 'ASB cannot get the bridge state of Lap.', null]);
  }
});

test('member values are cached for memberTtlMs, force asks again, and a machine that left loses its cache', async (t) => {
  const group = fakeGroup([member('lap', 'Lap')], () => ({ status: 200, body: memberBody() }));
  const s = service(t, { group });
  await s.coverage.status();
  s.advance(59_999);
  assert.equal((await machineOf(s, 'lap')).state, 'ok');
  assert.equal(group.calls.length, 1);
  s.advance(1);
  await s.coverage.status();
  assert.equal(group.calls.length, 2);
  await s.coverage.status({ force: true });
  assert.equal(group.calls.length, 3);
  group.members.length = 0;
  assert.equal((await s.coverage.status()).machines.length, 1);
  group.members.push(member('lap', 'Lap'));
  await s.coverage.status();
  assert.equal(group.calls.length, 4);
});

test('one request per member at a time, and a slow member is checking after the shared deadline', async (t) => {
  const gates = [];
  let lapCalls = 0;
  const group = fakeGroup([member('lap', 'Lap'), member('fast', 'Fast')], (machineId) => machineId === 'fast' ? { status: 200, body: memberBody() }
    : new Promise((resolve) => { const checkedAtMs = 950 + ++lapCalls; gates.push(() => resolve({ status: 200, body: memberBody({ checkedAtMs }) })); }));
  const s = service(t, { group, waitMs: 30 });
  const started = Date.now();
  const first = await s.coverage.status();
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(first.machines.map((item) => [item.machineId, item.state, item.checking]), [['m1', 'ok', false], ['lap', 'checking', true], ['fast', 'ok', false]]);
  assert.deepEqual(first.machines[1].apps, []);
  await s.coverage.status({ force: true });
  assert.equal(group.calls.filter(([machineId]) => machineId === 'lap').length, 1);
  gates.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  const later = await machineOf(s, 'lap');
  assert.deepEqual([later.state, later.checking, later.checkedAtMs], ['ok', false, 951]);
  // A forced request in flight shows the last value with checking.
  const forced = await machineOf(s, 'lap', { force: true });
  assert.deepEqual([forced.state, forced.checking, forced.checkedAtMs], ['ok', true, 951]);
  gates.shift()();
});

test('report waits at most reportWaitMs, not waitMs, and gives 200 after a slow check ends', async (t) => {
  let finish;
  const s = service(t, { waitMs: 5_000, reportWaitMs: 30, run: () => new Promise((resolve) => { finish = () => resolve({ code: 0, stdout: JSON.stringify(report()), stderr: '' }); }) });
  const started = Date.now();
  assert.deepEqual(await s.coverage.report(), { status: 503, body: { error: 'ASB is checking ASB Bridge.' } });
  assert.ok(Date.now() - started < 1_000);
  finish();
  const later = await s.coverage.report();
  assert.equal(later.status, 200);
  assert.equal(later.body.apps.length, 4);
  assert.equal(s.calls.length, 1);
});
