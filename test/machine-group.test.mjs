import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activeMembers, activePhones, buildJoinLink, checkInvite, createInvite, createMachineGroup, groupPath, INVITE_MS, loadGroup, mergeGroup,
  parseJoinLink, saveGroup, suggestName, validateGroup, validName, withoutSelf } from '../src/machine-group.mjs';

const id = (letter) => letter.repeat(16);
const member = (letter, name, extra = {}) => ({ machineId: id(letter), name, certFingerprint: letter.repeat(64),
  addresses: [{ kind: 'lan', address: '192.168.1.10' }], port: 4630, addedBy: id(letter), addedAtMs: 10, ...extra });
const phone = (deviceId, extra = {}) => ({ deviceId, name: 'Phone', tokenHash: 'f'.repeat(64), addedBy: id('a'), addedAtMs: 10, ...extra });
const group = (extra = {}) => ({ schema: 1, groupId: '0123456789abcdef', self: { machineId: id('a'), name: 'debian' },
  members: [member('a', 'debian')], removed: [], phones: [], removedPhones: [], ...extra });

test('machine names follow the plan rule and suggestions add -2, -3 while a name is taken', () => {
  assert.deepEqual(['debian', 'homeLP', 'a.b_c-d', 'x'.repeat(32)].map(validName), [true, true, true, true]);
  assert.deepEqual(['', '-debian', '.x', 'x'.repeat(33), 'my pc', 'pc\n', 42].map(validName), Array(7).fill(false));
  assert.equal(suggestName('my host.local!', []), 'myhost.local');
  assert.equal(suggestName('..Debian', ['debian']), 'Debian-2');
  assert.equal(suggestName('debian', ['DEBIAN', 'debian-2']), 'debian-3');
  assert.equal(suggestName('***', []), 'machine');
  assert.equal(suggestName('x'.repeat(40), ['x'.repeat(32)]), `${'x'.repeat(30)}-2`);
});

test('group validation is strict about keys, IDs, names, addresses, and self', () => {
  assert.equal(validateGroup(group()), true);
  assert.equal(validateGroup(withoutSelf(group()), { withSelf: false }), true);
  assert.equal(validateGroup(withoutSelf(group())), false);
  assert.equal(validateGroup({ ...group(), extra: 1 }), false);
  assert.equal(validateGroup(group({ schema: 2 })), false);
  assert.equal(validateGroup(group({ groupId: 'ABCDEF0123456789' })), false);
  assert.equal(validateGroup(group({ self: { machineId: id('b'), name: 'debian' } })), false);
  assert.equal(validateGroup(group({ members: [member('a', 'debian', { machineId: id('b') })] })), false);
  assert.equal(validateGroup(group({ members: [member('a', 'debian'), member('b', 'Debian')] })), false);
  assert.equal(validateGroup(group({ members: [member('a', 'debian', { extra: true })] })), false);
  assert.equal(validateGroup(group({ members: [member('a', 'debian', { port: 80 })] })), false);
  for (const addresses of [[], [{ kind: 'lan', address: '8.8.8.8' }], [{ kind: 'lan', address: '100.64.0.1' }], [{ kind: 'wifi', address: '10.0.0.1' }],
    [{ kind: 'lan', address: '10.0.0.1' }, { kind: 'zerotier', address: '10.0.0.1' }], Array.from({ length: 9 }, (_, index) => ({ kind: 'lan', address: `10.0.0.${index}` }))]) {
    assert.equal(validateGroup(group({ members: [member('a', 'debian', { addresses })] })), false, JSON.stringify(addresses));
  }
  assert.equal(validateGroup(group({ members: [member('a', 'debian', { addresses: [{ kind: 'tailscale', address: '100.64.0.1' }] })] })), true);
  assert.equal(validateGroup(group({ phones: [phone('0123456789ab', { name: 'Bad\u0007' })] })), false);
  assert.equal(validateGroup(group({ phones: [phone('0123456789ab'), phone('0123456789ab')] })), false);
  // Names must be unique only among active members.
  assert.equal(validateGroup(group({ members: [member('a', 'debian'), member('b', 'debian')],
    removed: [{ machineId: id('b'), certFingerprint: 'b'.repeat(64), removedBy: id('a'), removedAtMs: 20 }] })), true);
  assert.equal(validateGroup(group(), { addressOk: () => false }), false);
});

test('the merge is a union where the older entry wins and tombstones win and stay', () => {
  const local = group({ members: [member('a', 'debian'), member('b', 'homeLP', { addedAtMs: 30, addedBy: id('c') })],
    phones: [phone('0123456789ab', { name: 'Old', addedAtMs: 20 })] });
  const remote = withoutSelf(group({ members: [member('a', 'debian'), member('b', 'homeLP-new', { addedAtMs: 30, addedBy: id('a') }),
    member('c', 'workLP')], phones: [phone('0123456789ab', { name: 'Older', addedAtMs: 5 }), phone('ba9876543210')],
    removed: [{ machineId: id('c'), certFingerprint: 'c'.repeat(64), removedBy: id('b'), removedAtMs: 40 }],
    removedPhones: [{ deviceId: 'ba9876543210', removedBy: id('b'), removedAtMs: 40 }] }));
  const merged = mergeGroup(local, remote);
  assert.deepEqual(merged.self, local.self);
  assert.deepEqual(merged.members.map((item) => item.name), ['debian', 'homeLP-new']);
  assert.deepEqual(merged.phones.map((item) => item.name), ['Older']);
  assert.deepEqual([merged.removed.length, merged.removedPhones.length], [1, 1]);
  assert.equal(validateGroup(merged), true);
  // The tombstone also wins when the entry comes back from a member that has not seen it.
  const again = mergeGroup(merged, withoutSelf(group({ members: [member('c', 'workLP')], phones: [phone('ba9876543210')] })));
  assert.deepEqual([again.members.map((item) => item.name), again.phones.length, again.removed.length], [['debian', 'homeLP-new'], 1, 1]);
  assert.deepEqual(activeMembers(again).map((item) => item.name), ['debian', 'homeLP-new']);
  assert.deepEqual(activePhones(again).map((item) => item.deviceId), ['0123456789ab']);
  // Another group changes nothing.
  assert.equal(mergeGroup(local, { ...remote, groupId: 'ffffffffffffffff' }), local);
});

test('the merge keeps the newest 256 tombstones and 32 members', () => {
  const hex = (number, size) => number.toString(16).padStart(size, '0');
  const removed = Array.from({ length: 300 }, (_, index) => ({ machineId: hex(index, 16), certFingerprint: hex(index, 64),
    removedBy: id('a'), removedAtMs: index }));
  const members = [member('a', 'debian'), ...Array.from({ length: 40 }, (_, index) => ({ ...member('a', `m${index}`),
    machineId: hex(1000 + index, 16), certFingerprint: hex(1000 + index, 16) + 'e'.repeat(48), addedAtMs: 100 + index }))];
  const merged = mergeGroup(group(), withoutSelf(group({ removed, members })));
  assert.equal(merged.removed.length, 256);
  assert.equal(merged.removed[0].removedAtMs, 44);
  assert.equal(merged.members.length, 32);
  assert.equal(merged.members[0].name, 'debian');
});

test('group.json saves atomically with mode 0600 and an invalid file moves to group.json.bad', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-group-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'config', 'asb', 'group.json');
  // The Linux folder rules and file modes; Windows uses APPDATA and has no POSIX modes (this file is in the Windows CI list).
  const linux = process.platform !== 'win32';
  if (linux) {
    assert.equal(groupPath({ HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') }), file);
    assert.equal(groupPath({ HOME: home }), path.join(home, '.config/asb/group.json'));
  }
  assert.deepEqual(await loadGroup(file), { group: null, warning: '' });
  await saveGroup(file, group());
  if (linux) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(file)), ['group.json']);
  assert.deepEqual(await loadGroup(file), { group: group(), warning: '' });
  await writeFile(file, JSON.stringify({ ...group(), schema: 7 }));
  assert.deepEqual(await loadGroup(file), { group: null, warning: 'ASB moved an invalid group.json to group.json.bad.' });
  assert.equal(JSON.parse(await readFile(`${file}.bad`, 'utf8')).schema, 7);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('an invite code is valid 10 minutes, one at a time, and void after 8 wrong codes', () => {
  const invite = createInvite(1000);
  assert.match(invite.code, /^[A-Za-z0-9_-]{27}$/);
  assert.equal(invite.expiresAtMs, 1000 + INVITE_MS);
  assert.equal(checkInvite(invite, invite.code, 1000), 'ok');
  assert.equal(checkInvite(invite, invite.code, 1000 + INVITE_MS), 'none');
  assert.equal(checkInvite(null, invite.code, 1000), 'none');
  for (let index = 0; index < 7; index += 1) assert.equal(checkInvite(invite, 'x'.repeat(27), 1000), 'bad');
  assert.equal(checkInvite(invite, invite.code, 1000), 'ok');
  assert.equal(checkInvite(invite, 'short', 1000), 'bad');
  assert.equal(checkInvite(invite, invite.code, 1000), 'none');
  assert.notEqual(createInvite(1000).code, createInvite(1000).code);
});

test('the join link round-trips and rejects other keys and values', () => {
  const values = { groupId: '0123456789abcdef', addresses: [{ kind: 'lan', address: '192.168.1.10' }, { kind: 'tailscale', address: '100.100.1.2' }],
    port: 4630, fingerprint: 'a'.repeat(64), code: createInvite().code, name: 'debian' };
  const link = buildJoinLink(values);
  assert.match(link, /^asb:\/\/join\?v=1&g=0123456789abcdef&a=lan%3A192\.168\.1\.10%2Ctailscale%3A100\.100\.1\.2&p=4630&f=a{64}&c=[A-Za-z0-9_-]{27}&n=debian$/);
  assert.deepEqual(parseJoinLink(link), values);
  const replace = (key, value) => link.replace(new RegExp(`([?&]${key}=)[^&]*`), `$1${value}`);
  for (const bad of [link.replace('asb://join', 'asb://pair'), `${link}&x=1`, link.replace('&n=debian', ''), `${link}&n=again`,
    replace('v', '2'), replace('g', 'xyz'), replace('a', 'lan%3A8.8.8.8'), replace('a', 'wifi%3A10.0.0.1'), replace('p', '80'),
    replace('p', '04630'), replace('f', 'A'.repeat(64)), replace('c', 'short'), replace('n', '-bad'), replace('n', '%E0%A4%A'), 42]) {
    assert.equal(parseJoinLink(bad), null, String(bad));
  }
  assert.deepEqual(parseJoinLink(replace('a', 'lan%3A127.0.0.2'), { addressOk: () => true }).addresses, [{ kind: 'lan', address: '127.0.0.2' }]);
});

test('a tombstone for this machine makes the engine leave at once, from a member or at start', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-group-leave-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'group.json');
  const gateway = { credentials: async () => ({ key: '', cert: '', fingerprint: 'a'.repeat(64) }), identity: async () => id('a'),
    status: async () => ({ running: true, listening: [{ kind: 'lan', address: '192.168.1.10' }], port: 4630 }), devices: async () => [] };
  const tombstone = { machineId: id('a'), certFingerprint: 'a'.repeat(64), removedBy: id('b'), removedAtMs: 20 };
  const two = () => group({ members: [member('a', 'debian'), member('b', 'homeLP')] });
  const pending = [];
  const timers = { setTimeout: (run, ms) => { const handle = { run, ms, unref() {} }; pending.push(handle); return handle; },
    clearTimeout: (handle) => { if (pending.includes(handle)) pending.splice(pending.indexOf(handle), 1); } };
  const logs = [];
  const request = async ({ path: route }) => route === '/peer/v1/group'
    ? { status: 200, body: withoutSelf({ ...two(), removed: [tombstone] }) } : { status: 503, body: null };
  await saveGroup(file, two());
  const machine = createMachineGroup({ file, gateway: () => gateway, request, timers, hostName: 'pc', log: (line) => logs.push(line) });
  await machine.start();
  assert.deepEqual([machine.selfName(), machine.peerStates().map((state) => state.member.name)], ['debian', ['homeLP']]);
  const groupPoll = pending.find((handle) => handle.ms === 30_000);
  pending.splice(pending.indexOf(groupPoll), 1);
  groupPoll.run();
  // The leave deletes a real file, so wait in real time.
  for (const deadline = Date.now() + 5000; logs.length === 0 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(logs, ['ASB: this machine was removed from the machine group.']);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.deepEqual([machine.selfName(), machine.self(), machine.peerStates()], ['pc', null, []]);
  assert.deepEqual(pending, []);
  // A saved group.json that already has the tombstone.
  await saveGroup(file, { ...two(), removed: [tombstone] });
  const again = createMachineGroup({ file, gateway: () => gateway, request, timers, hostName: 'pc', log: (line) => logs.push(line) });
  await again.start();
  assert.equal(logs.length, 2);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.deepEqual((await again.status()).groupId, '');
  await assert.rejects(again.remove(id('b')), { statusCode: 409, message: 'This machine is not in a group.' });
});

test('an invite after a port or address change saves them in the entry of this machine, so a new member polls the new ones', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'asb-group-invite-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'group.json');
  const network = { listening: [{ kind: 'lan', address: '192.168.1.10' }], port: 4630 };
  const gateway = { credentials: async () => ({ key: '', cert: '', fingerprint: 'a'.repeat(64) }), identity: async () => id('a'),
    status: async () => ({ running: true, ...network }), devices: async () => [] };
  let changes = 0;
  const machine = createMachineGroup({ file, gateway: () => gateway, hostName: 'debian', log: () => {}, onChange: () => { changes += 1; } });
  const selfEntry = async () => (await loadGroup(file)).group.members.find((item) => item.machineId === id('a'));
  const linkValues = async () => parseJoinLink((await machine.invite()).link);
  const code = async () => new URL((await machine.invite()).link.replace('asb://', 'https://')).searchParams.get('c');
  const join = async (name, letter, address, port) => machine.peer.join({ code: await code(), name, addresses: [{ kind: 'lan', address }], port }, letter.repeat(64));
  // The first invite makes the group with the current values.
  assert.deepEqual((await linkValues()).addresses, network.listening);
  const first = await selfEntry();
  assert.deepEqual([first.addresses, first.port], [network.listening, 4630]);
  // The same values save nothing.
  changes = 0;
  await machine.invite();
  assert.deepEqual([changes, await selfEntry()], [0, first]);
  // A member joins, then this machine changes its port and its addresses.
  assert.equal((await join('homeLP', 'b', '192.168.1.30', 4631)).status, 200);
  Object.assign(network, { listening: [{ kind: 'lan', address: '192.168.1.20' }, { kind: 'zerotier', address: '10.147.17.5' }], port: 4700 });
  changes = 0;
  const values = await linkValues();
  assert.deepEqual([values.addresses, values.port], [network.listening, 4700]);
  assert.equal(changes, 1);
  // The saved entry has the new values and keeps its time and author. The entry of the other member does not change.
  const saved = (await loadGroup(file)).group;
  assert.deepEqual(saved.members.map((item) => [item.name, item.addresses, item.port, item.addedBy]),
    [['debian', network.listening, 4700, id('a')], ['homeLP', [{ kind: 'lan', address: '192.168.1.30' }], 4631, id('a')]]);
  assert.equal(saved.members[0].addedAtMs, first.addedAtMs);
  // A machine that joins now gets the new values in the group that this machine sends.
  const joined = await join('workLP', 'c', '192.168.1.40', 4632);
  const inviter = joined.body.group.members.find((item) => item.machineId === id('a'));
  assert.deepEqual([inviter.addresses, inviter.port], [network.listening, 4700]);
  // A list that the group cannot hold is refused, and the saved entry stays.
  network.listening = Array.from({ length: 9 }, (_, index) => ({ kind: 'lan', address: `192.168.1.${50 + index}` }));
  await assert.rejects(machine.invite(), { statusCode: 409, message: 'ASB cannot save these network addresses in the group.' });
  assert.equal((await selfEntry()).port, 4700);
});
