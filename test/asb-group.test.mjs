import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../scripts/asb-group.mjs';
import { main as setup } from '../scripts/asb-setup.mjs';
import { readServiceRuntime } from '../scripts/asb-instance.mjs';
import { buildJoinLink, groupPath } from '../src/machine-group.mjs';
import { phoneTlsDir } from '../src/phone-gateway.mjs';

const launcher = fileURLToPath(new URL('../scripts/asb', import.meta.url));
const token = 'c'.repeat(64);
const link = buildJoinLink({ groupId: '0123456789abcdef', addresses: [{ kind: 'lan', address: '192.168.1.10' }], port: 4630,
  fingerprint: '0123456789abcdef'.repeat(4), code: 'A'.repeat(27), name: 'debian' });
const groupStatus = { groupId: '0123456789abcdef', self: { machineId: 'a'.repeat(16), name: 'debian' }, networkEnabled: true,
  members: [{ machineId: 'a'.repeat(16), name: 'debian', online: true, lastOkAtMs: 1, addresses: [{ kind: 'lan', address: '192.168.1.10' }], isSelf: true },
    { machineId: 'b'.repeat(16), name: 'homeLP', online: false, lastOkAtMs: 0, addresses: [{ kind: 'zerotier', address: '10.147.0.2' }], isSelf: false }],
  phones: [{ deviceId: '0123456789ab', name: 'Pixel' }] };
const phone = { enabled: true, bindAddresses: ['192.168.1.10', '10.9.9.9'], port: 4630, error: '',
  addresses: [{ address: '192.168.1.10', interface: 'wlan0', kind: 'lan' }, { address: '10.147.0.1', interface: 'ztabc', kind: 'zerotier' }],
  listening: [{ kind: 'lan', address: '192.168.1.10' }] };

async function fixture(t, { service = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-group-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_RUNTIME_DIR: path.join(home, 'runtime'), ASB_NODE: process.execPath, PATH: '/usr/bin:/bin' };
  const records = [];
  const replies = new Map([
    ['GET /api/group', [200, groupStatus]], ['POST /api/group/invite', [200, { link, fingerprint: '0123456789abcdef'.repeat(4), expiresAtMs: Date.now() + 600_000 }]],
    ['POST /api/group/join', [200, { joined: true, groupId: '0123456789abcdef' }]], ['POST /api/group/remove', [200, groupStatus]],
    ['POST /api/group/leave', [200, { left: true }]], ['GET /api/phone', [200, phone]], ['POST /api/phone/settings', [200, phone]],
    ['GET /api/service', [service ? 200 : 404, { service: true, pid: process.pid }]],
  ]);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    records.push({ route: `${request.method} ${request.url}`, token: request.headers['x-asb-source-token'], body: body ? JSON.parse(body) : undefined });
    const [status, value] = replies.get(`${request.method} ${request.url}`) || [404, { error: 'Route is not available in ASB.' }];
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const runtime = path.join(env.XDG_RUNTIME_DIR, 'asb/service.json');
  await mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(runtime), 0o700);
  await writeFile(runtime, JSON.stringify({ schema: 1, pid: process.pid, port: server.address().port, sourceToken: token }), { mode: 0o600 });
  const run = async (args, answer = '') => {
    const out = [];
    const err = [];
    const code = await main(args, { env, input: Readable.from([answer]), output: { write: () => {} },
      print: (line) => out.push(line), printError: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { home, env, records, replies, run, posts: () => records.filter((item) => item.route.startsWith('POST')) };
}

test('the group and network commands check their arguments', async (t) => {
  const { run, records } = await fixture(t);
  for (const args of [[], ['group'], ['group', 'join', '--force'], ['group', 'join', '--name'], ['group', 'join', link, '--name'], ['group', 'join', link, '--force'],
    ['group', 'status', '--yaml'], ['group', 'remove'], ['group', 'invite', 'x'], ['network', 'enable'], ['network', 'disable', 'x'], ['agent', 'status']]) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, /^Usage: asb group status/);
  }
  assert.deepEqual(records, []);
});

test('group status, invite, remove, and leave use the loopback group routes with the source token', async (t) => {
  const { run, records, posts } = await fixture(t);
  const status = await run(['group', 'status']);
  assert.equal(status.code, 0);
  assert.match(status.out, /^Group 0123456789abcdef\. This machine: debian \(aaaaaaaa\)\.\nNetwork access: on\.\nMachines:\n  debian \(aaaaaaaa\): this machine lan:192\.168\.1\.10\n  homeLP \(bbbbbbbb\): offline zerotier:10\.147\.0\.2\nPhones: Pixel\.$/);
  assert.deepEqual(JSON.parse((await run(['group', 'status', '--json'])).out), groupStatus);
  assert.ok(records.every((item) => item.token === token));
  const invite = await run(['group', 'invite']);
  assert.equal(invite.code, 0);
  assert.match(invite.out, /^Join link: asb:\/\/join\?v=1&.*\nFingerprint: 0123 4567 89ab cdef 0123 /);
  assert.match(invite.out, /\nOn the other machine, run: asb group join '<link>'\nOn Windows, run asb group join and paste the link when it asks\.$/);
  const removed = await run(['group', 'remove', 'HOMELP']);
  assert.deepEqual([removed.code, removed.out], [0, 'homeLP was removed from the group.']);
  const missing = await run(['group', 'remove', 'workLP']);
  assert.deepEqual([missing.code, missing.err], [1, 'asb group: No machine named workLP is in the group.']);
  assert.equal((await run(['group', 'leave'])).out, 'This machine left the group.');
  assert.deepEqual(posts().map((item) => [item.route, item.body]), [['POST /api/group/invite', {}],
    ['POST /api/group/remove', { machineId: 'b'.repeat(16) }], ['POST /api/group/leave', {}]]);
});

test('join shows the inviter fingerprint and asks unless --yes, and prints a name suggestion', async (t) => {
  const { run, posts, replies } = await fixture(t);
  const refused = await run(['group', 'join', link], 'n\n');
  assert.equal(refused.code, 1);
  assert.equal(refused.out, 'Inviter: debian\nFingerprint: 0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567 89ab cdef 0123 4567 89ab cdef');
  assert.equal(refused.err, 'asb group: ASB did not join the group.');
  assert.equal((await run(['group', 'join', link], '')).code, 1);
  assert.deepEqual(posts(), []);
  assert.equal((await run(['group', 'join', link], 'yes\n')).code, 0);
  assert.equal((await run(['group', 'join', link, '--yes', '--name', 'laptop'])).out.split('\n').at(-1), 'This machine joined the group of debian.');
  assert.deepEqual(posts().map((item) => item.body), [{ link, name: '' }, { link, name: 'laptop' }]);
  replies.set('POST /api/group/join', [409, { error: 'Another machine in the group has this name.', suggestion: 'laptop-2' }]);
  const taken = await run(['group', 'join', link, '--name', 'laptop', '--yes']);
  assert.deepEqual([taken.code, taken.err], [1, 'asb group: Another machine in the group has this name. Use another name, for example: --name laptop-2']);
  assert.deepEqual([(await run(['group', 'join', 'asb://join?v=1', '--yes'])).err], ['asb group: This join link is not valid.']);
});

test('join with no link asks for it, because cmd.exe splits a typed link at each &', async (t) => {
  const { run, posts } = await fixture(t);
  const asked = await run(['group', 'join'], `${link}\ny\n`);
  assert.equal(asked.code, 0, asked.err);
  assert.equal(asked.out.split('\n').at(-1), 'This machine joined the group of debian.');
  // --yes does not skip the link question.
  assert.equal((await run(['group', 'join', '--name', 'x', '--yes'], `  ${link}  \n`)).code, 0);
  assert.equal((await run(['group', 'join', link, '--name', 'y'], 'y\n')).code, 0);
  assert.deepEqual(posts().map((item) => item.body), [{ link, name: '' }, { link, name: 'x' }, { link, name: 'y' }]);
  for (const answer of ['', '\n']) {
    const empty = await run(['group', 'join', '--yes'], answer);
    assert.deepEqual([empty.code, empty.err], [1, 'asb group: No join link.']);
  }
  assert.equal((await run(['group', 'join'], `${link}\n`)).err, 'asb group: ASB did not join the group.');
  assert.equal(posts().length, 3);
});

test('network enable and disable send the phone settings with the current port', async (t) => {
  const { run, posts } = await fixture(t);
  assert.equal((await run(['network', 'status'])).out, 'Network access is on, port 4630: 192.168.1.10 (lan).');
  assert.deepEqual(JSON.parse((await run(['network', 'status', '--json'])).out), phone);
  const wrong = await run(['network', 'enable', '192.168.1.99']);
  assert.deepEqual([wrong.code, wrong.err], [1, 'asb network: Choose network addresses on this PC: 192.168.1.10, 10.147.0.1.']);
  assert.equal((await run(['network', 'enable', '192.168.1.10', '10.147.0.1'])).code, 0);
  assert.equal((await run(['network', 'disable'])).code, 0);
  assert.deepEqual(posts().map((item) => item.body), [{ enabled: true, bindAddresses: ['192.168.1.10', '10.147.0.1'], port: 4630 },
    { enabled: false, bindAddresses: ['192.168.1.10'], port: 4630 }]);
});

test('reset-identity refuses while the engine runs or while in a group, then deletes only the certificate files', async (t) => {
  const running = await fixture(t, { service: true });
  assert.deepEqual(await running.run(['group', 'reset-identity']), { code: 1, out: '', err: 'asb group: Stop ASB first: asb engine stop.' });
  const { env, run } = await fixture(t);
  const tls = phoneTlsDir(env);
  await mkdir(tls, { recursive: true });
  for (const name of ['key.pem', 'cert.pem', 'other.txt']) await writeFile(path.join(tls, name), 'x');
  await writeFile(groupPath(env), '{}');
  assert.deepEqual(await run(['group', 'reset-identity']), { code: 1, out: '', err: 'asb group: Leave the group first: asb group leave.' });
  await rm(groupPath(env));
  assert.deepEqual(await run(['group', 'reset-identity']), { code: 0, out: 'Identity reset. Paired phones must pair again.', err: '' });
  assert.deepEqual(await readdir(tls), ['other.txt']);
  // Without a runtime file, the other commands say how to start ASB.
  await rm(path.join(env.XDG_RUNTIME_DIR, 'asb/service.json'));
  assert.deepEqual(await run(['group', 'status']), { code: 1, out: '', err: 'asb group: ASB is not running. Start it: asb engine start.' });
});

test('the asb launcher dispatches group and network without the SQLite check', async (t) => {
  const { env } = await fixture(t);
  for (const [args, expected] of [[['group', 'status', '--json'], 0], [['network', 'status', '--json'], 0], [['group'], 2]]) {
    const child = spawn(launcher, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, expected, args.join(' '));
    if (expected === 0) assert.ok(JSON.parse(stdout));
  }
});

const devices = [{ id: '0123456789ab', name: 'Pixel', createdAtMs: Date.UTC(2026, 9, 1), lastSeenAtMs: 0 },
  { id: 'aaaaaaaaaaaa', name: 'Tablet', createdAtMs: Date.UTC(2026, 9, 2), lastSeenAtMs: Date.UTC(2026, 9, 3) },
  { id: 'bbbbbbbbbbbb', name: 'tablet', createdAtMs: Date.UTC(2026, 9, 4), lastSeenAtMs: 0 }];

test('asb phone status, pair, and remove use the phone routes and refuse an unclear name', async (t) => {
  const { run, replies, posts, records } = await fixture(t);
  replies.set('GET /api/phone', [200, { ...phone, devices }]);
  replies.set('POST /api/phone/pairing', [200, { uri: 'asb://pair?v=2&c=synthetic', expiresAtMs: Date.UTC(2026, 9, 19, 12, 10) }]);
  replies.set('POST /api/phone/devices/0123456789ab/revoke', [200, phone]);
  replies.set('POST /api/phone/devices/bbbbbbbbbbbb/revoke', [200, phone]);
  const status = await run(['phone', 'status']);
  assert.equal(status.code, 0);
  assert.deepEqual(status.out.split('\n').map((line) => line.replace(/paired .*, last seen .*/, 'paired D, last seen T')),
    ['Network access is on, port 4630: 192.168.1.10 (lan).', 'Paired phones:', '  Pixel (0123456789ab): paired D, last seen T',
      '  Tablet (aaaaaaaaaaaa): paired D, last seen T', '  tablet (bbbbbbbbbbbb): paired D, last seen T']);
  assert.match(status.out, /Pixel \(0123456789ab\): paired .*, last seen never/);
  assert.deepEqual(JSON.parse((await run(['phone', 'status', '--json'])).out).devices, devices);
  const pair = await run(['phone', 'pair']);
  assert.equal(pair.code, 0);
  assert.match(pair.out, /^Pairing link: asb:\/\/pair\?v=2&c=synthetic\nThe link works one time until .+\.\nScan it as a QR code or paste it in the ASB app on the phone\.$/);
  assert.deepEqual(await run(['phone', 'remove', 'PIXEL']), { code: 0, out: 'Pixel was removed.', err: '' });
  assert.deepEqual(await run(['phone', 'remove', 'Tablet']), { code: 1, out: '',
    err: 'asb phone: More than one phone is named Tablet: aaaaaaaaaaaa, bbbbbbbbbbbb. Use asb phone remove --id <id>.' });
  assert.deepEqual(await run(['phone', 'remove', '--id', 'bbbbbbbbbbbb']), { code: 0, out: 'tablet was removed.', err: '' });
  assert.equal((await run(['phone', 'remove', 'Watch'])).err, 'asb phone: No phone named Watch is paired.');
  assert.equal((await run(['phone', 'remove', '--id', 'cccccccccccc'])).err, 'asb phone: No phone with the ID cccccccccccc is paired.');
  assert.deepEqual(posts().map((item) => [item.route, item.body]), [['POST /api/phone/pairing', {}],
    ['POST /api/phone/devices/0123456789ab/revoke', {}], ['POST /api/phone/devices/bbbbbbbbbbbb/revoke', {}]]);
  assert.ok(records.every((item) => item.token === token));
  for (const args of [['phone'], ['phone', 'pair', 'x'], ['phone', 'remove'], ['phone', 'remove', '--id'], ['phone', 'status', '--yaml']]) {
    assert.equal((await run(args)).code, 2, args.join(' '));
  }
});

// Step 0 on Linux: a fake doctor, so that no test runs the Python probe or openssl.
const doctorData = (status = 'ok') => ({ system: { name: 'Test Linux', family: 'debian', mode: 'normal' },
  checks: [{ id: 'node', group: 'Engine', status, detail: 'Node.js 24.0.0 (/usr/bin/node), built-in SQLite' }], advice: [] });
const DOCTOR_LINES = ['ASB doctor: Test Linux, family debian', '', 'Engine', '  ok       Node.js 24.0.0 (/usr/bin/node), built-in SQLite'];

// The firewall fakes: by default no firewall-cmd and no ufw.conf (the state none). `calls` records every program.
const noProgram = async (file) => { throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }); };

async function runSetup(state, args, { platform = 'linux', answer = '', doctor = async () => doctorData(), execFile = noProgram,
  read = async () => '' } = {}) {
  const out = [];
  const err = [];
  const installs = [];
  const calls = [];
  const code = await setup(args, { env: state.env, platform, input: Readable.from([answer]), output: { write: () => {} },
    print: (line) => out.push(line), printError: (line) => err.push(line), node: 'C:\\Program Files\\nodejs\\node.exe', waitMs: 500,
    installService: async (argv) => { installs.push(['service', argv]); return 0; },
    installEngine: async (argv) => { installs.push(['engine', argv]); return 0; },
    find: (env) => readServiceRuntime(env), doctor, execFile: (file, argv, options) => { calls.push([file, ...argv]); return execFile(file, argv, options); },
    read });
  // `out` leaves out the four doctor lines of Linux; `all` has them.
  return { code, out: platform === 'linux' ? out.slice(DOCTOR_LINES.length) : out, all: out, err, installs, calls };
}

test('asb setup step 0 prints the doctor output on Linux and stops when the engine cannot run', async (t) => {
  const state = await fixture(t);
  const failed = await runSetup(state, ['--yes'], { doctor: async () => doctorData('missing') });
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.installs, []);
  assert.deepEqual(failed.all, ['ASB doctor: Test Linux, family debian', '', 'Engine', '  missing  Node.js 24.0.0 (/usr/bin/node), built-in SQLite']);
  assert.deepEqual(failed.err, ['asb setup: The ASB engine cannot run on this system. Install the missing packages, then run asb setup again.']);
  assert.equal(state.posts().length, 0);
  let called = false;
  const windows = await runSetup(state, ['--address', '192.168.1.99'], { platform: 'win32', doctor: async () => { called = true; return doctorData(); } });
  assert.equal(windows.code, 1);
  assert.equal(called, false);
});

test('asb setup installs the autostart, turns on the chosen addresses, and prints the next steps', async (t) => {
  const state = await fixture(t);
  const off = { ...phone, enabled: false, bindAddresses: [] };
  state.replies.set('GET /api/phone', [200, off]);
  const linux = await runSetup(state, ['--yes']);
  assert.equal(linux.code, 0, linux.err.join('\n'));
  assert.deepEqual(linux.installs, [['service', ['install']]]);
  assert.deepEqual(linux.all.slice(0, DOCTOR_LINES.length), DOCTOR_LINES);
  assert.deepEqual(linux.out, ['Network access is on, port 4630: 192.168.1.10 (lan).', 'To let agents send messages, run: asb bridge install --all',
    "On a machine in the group: asb group invite. Here: asb group join '<link>' --name <name>."]);
  const chosen = await runSetup(state, ['--address', '10.147.0.1', '--address', '192.168.1.10', '--yes']);
  assert.equal(chosen.code, 0);
  const asked = await runSetup(state, [], { answer: '2\n' });
  assert.equal(asked.code, 0);
  assert.deepEqual(asked.out.slice(0, 3), ['Network addresses on this PC:', '  1. 192.168.1.10 (home network, wlan0)', '  2. 10.147.0.1 (ZeroTier, ztabc)']);
  const kept = await runSetup(state, [], { answer: '' });
  assert.equal(kept.code, 0);
  state.replies.set('GET /api/phone', [200, phone]);
  const windows = await runSetup(state, ['--yes'], { platform: 'win32' });
  assert.equal(windows.code, 0);
  assert.deepEqual(windows.installs, [['engine', ['install']]]);
  assert.deepEqual(windows.out.slice(1), ['Run this command in an administrator PowerShell to let other machines and phones reach ASB:',
    '  New-NetFirewallRule -DisplayName "ASB engine" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4630 -LocalAddress 192.168.1.10 '
      + '-Program "C:\\Program Files\\nodejs\\node.exe"',
    'Windows can already allow node.exe on private networks; then this rule is not needed.', 'The bridge is not available on Windows yet.',
    'On a machine in the group: asb group invite. Here: asb group join --name <name>, then paste the link.']);
  assert.deepEqual(state.posts().map((item) => item.body), [
    { enabled: true, bindAddresses: ['192.168.1.10'], port: 4630 }, { enabled: true, bindAddresses: ['10.147.0.1', '192.168.1.10'], port: 4630 },
    { enabled: true, bindAddresses: ['10.147.0.1'], port: 4630 }, { enabled: true, bindAddresses: ['192.168.1.10'], port: 4630 },
    // --yes keeps the saved selection that is on this PC now.
    { enabled: true, bindAddresses: ['192.168.1.10'], port: 4630 }]);
  const wrong = await runSetup(state, ['--address', '192.168.1.99']);
  assert.deepEqual([wrong.code, wrong.err], [1, ['asb setup: Choose network addresses on this PC: 192.168.1.10, 10.147.0.1.']]);
  const badNumber = await runSetup(state, [], { answer: '7\n' });
  assert.deepEqual([badNumber.code, badNumber.err], [1, ['asb setup: Enter numbers from 1 to 2.']]);
  assert.equal((await runSetup(state, ['--address'])).code, 2);
  assert.equal(state.posts().length, 5);
});

test('asb setup on Linux prints the firewalld rule for the chosen addresses and runs only the read-only queries', async (t) => {
  const state = await fixture(t);
  // A PATH without sudo and doas gives sudo on every host.
  const env = { ...state.env, PATH: state.env.HOME };
  const execFile = async (file, argv) => {
    if (file === 'firewall-cmd' && argv[0] === '--state') return { stdout: 'running\n' };
    if (file === 'firewall-cmd' && argv[0] === '--get-zone-of-interface=wlan0') return { stdout: 'home\n' };
    return noProgram(file);
  };
  const reads = [];
  const result = await runSetup({ ...state, env }, ['--address', '192.168.1.10', '--address', '10.147.0.1', '--yes'],
    { execFile, read: async (file) => { reads.push(file); return ''; } });
  assert.equal(result.code, 0, result.err.join('\n'));
  const rule = (address) => `--add-rich-rule='rule family="ipv4" destination address="${address}" port port="4630" protocol="tcp" accept'`;
  assert.deepEqual(result.out, ['Network access is on, port 4630: 192.168.1.10 (lan).', 'Phone access and machine links through firewalld:',
    `  sudo firewall-cmd --permanent --zone=home ${rule('192.168.1.10')}`, `  sudo firewall-cmd --permanent ${rule('10.147.0.1')}`,
    '  sudo firewall-cmd --reload', 'To let agents send messages, run: asb bridge install --all',
    "On a machine in the group: asb group invite. Here: asb group join '<link>' --name <name>."]);
  assert.deepEqual(result.calls, [['firewall-cmd', '--state'], ['firewall-cmd', '--get-zone-of-interface=wlan0'],
    ['firewall-cmd', '--get-zone-of-interface=ztabc']]);
  assert.deepEqual(reads, []);
  // ufw, and Windows runs no firewall query.
  const ufw = await runSetup({ ...state, env }, ['--address', '10.147.0.1', '--yes'], { read: async (file) => (file === '/etc/ufw/ufw.conf' ? 'ENABLED=yes\n' : '') });
  assert.deepEqual(ufw.out.slice(1, 3), ['Phone access and machine links through ufw:', '  sudo ufw allow in on ztabc to 10.147.0.1 port 4630 proto tcp']);
  const windows = await runSetup({ ...state, env }, ['--yes'], { platform: 'win32', execFile });
  assert.equal(windows.code, 0);
  assert.deepEqual(windows.calls, []);
});
