import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMachineGroup, loadGroup, saveGroup, validateGroup, withoutSelf } from '../src/machine-group.mjs';

const id = (letter) => letter.repeat(16);
const member = (letter, name) => ({ machineId: id(letter), name, certFingerprint: letter.repeat(64),
  addresses: [{ kind: 'lan', address: '192.0.2.10' }], port: 4630, addedBy: id('a'), addedAtMs: 10 });

test('a group update with colliding member names keeps the valid saved group', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-group-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'group.json');
  const common = [member('a', 'desk'), member('b', 'tower')];
  const local = { schema: 1, groupId: id('f'), self: { machineId: id('a'), name: 'desk' },
    members: [...common, member('c', 'laptop')], removed: [], phones: [], removedPhones: [] };
  const remote = withoutSelf({ ...local, members: [...common, member('d', 'Laptop')] });
  const addressOk = () => true;
  assert.equal(validateGroup(local, { addressOk }), true);
  assert.equal(validateGroup(remote, { withSelf: false, addressOk }), true);
  await saveGroup(file, local);
  const original = await fs.readFile(file, 'utf8');
  const pending = [];
  const timers = { setTimeout: (run, ms) => { const handle = { run, ms, unref() {} }; pending.push(handle); return handle; },
    clearTimeout: (handle) => { const at = pending.indexOf(handle); if (at !== -1) pending.splice(at, 1); } };
  const logs = [];
  const gateway = { credentials: async () => ({ fingerprint: 'a'.repeat(64) }) };
  const machine = createMachineGroup({ file, gateway: () => gateway, addressOk, timers, hostName: 'desk', log: (line) => logs.push(line),
    request: async ({ path }) => path === '/peer/v1/group' ? { status: 200, body: remote } : { status: 503, body: null } });
  await machine.start();
  t.after(() => machine.stop());
  const poll = pending.find((handle) => handle.ms === 30_000);
  pending.splice(pending.indexOf(poll), 1);
  poll.run();
  // The next group timer is set only after the asynchronous merge and save finish.
  for (const deadline = Date.now() + 5000; pending.filter((handle) => handle.ms === 30_000).length < 2;) {
    assert.ok(Date.now() < deadline, 'group poll completed');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(logs, ['ASB did not apply a group update from another machine: the merged group is not valid.']);
  assert.deepEqual(await loadGroup(file, { addressOk }), { group: local, warning: '' });
  assert.deepEqual(machine.peerStates().map((state) => state.member.name), ['tower', 'laptop']);
});
