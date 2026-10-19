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
  for (const args of [[], ['group'], ['group', 'join'], ['group', 'join', link, '--name'], ['group', 'join', link, '--force'],
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
