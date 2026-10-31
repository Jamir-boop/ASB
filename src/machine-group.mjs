// The machine group: group.json, its merge rules, invites, join links, and the orchestrator that owns the pollers.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPeerPoller, exportBody, exportLocalSessions, MAX_ACTIVITY_BYTES, mergePeerRows, peerRequest, validActivity } from './machine-peers.mjs';
import { phoneSettingsPath, privateIPv4, tailscaleIPv4 } from './phone-gateway.mjs';
import { localMachineName } from './switchboard.mjs';
import { USAGE_PERIODS } from './usage-aggregation.mjs';

export const GROUP_SCHEMA = 1;
export const MAX_MEMBERS = 32;
export const MAX_PHONES = 64;
export const MAX_TOMBSTONES = 256;
export const INVITE_MS = 600_000;
const KINDS = ['lan', 'zerotier', 'tailscale'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const HEX16 = /^[a-f0-9]{16}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CODE = /^[A-Za-z0-9_-]{27}$/;
const controls = /[\x00-\x1f\x7f-\x9f]/;
const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const time = (value) => Number.isSafeInteger(value) && value >= 0;
const unique = (list, key) => new Set(list.map(key)).size === list.length;

export const groupPath = (env = process.env) => path.join(path.dirname(phoneSettingsPath(env)), 'group.json');

// A peer address: a private IPv4 address, or a Tailscale address for the `tailscale` kind (the gateway rules).
export const validPeerAddress = ({ kind, address }) => kind === 'tailscale' ? tailscaleIPv4(address) : privateIPv4(address);

export const validName = (name) => typeof name === 'string' && NAME.test(name);
const phoneName = (name) => typeof name === 'string' && Array.from(name).length >= 1 && Array.from(name).length <= 64 && !controls.test(name);

// The host name with only name characters, cut to 32, with -2, -3, and so on while the name is taken (case-insensitive).
export function suggestName(hostName, taken = []) {
  const used = new Set(taken.map((name) => String(name).toLowerCase()));
  const base = String(hostName || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 32) || 'machine';
  if (!used.has(base.toLowerCase())) return base;
  for (let number = 2; ; number += 1) {
    const suffix = `-${number}`;
    const name = base.slice(0, 32 - suffix.length) + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
}

export const validAddresses = (value, addressOk = validPeerAddress) => Array.isArray(value) && value.length >= 1 && value.length <= 8
  && value.every((item) => fields(item, ['kind', 'address']) && KINDS.includes(item.kind) && typeof item.address === 'string' && addressOk(item))
  && unique(value, (item) => item.address);
export const validPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535;

const validMember = (item, addressOk) => fields(item, ['machineId', 'name', 'certFingerprint', 'addresses', 'port', 'addedBy', 'addedAtMs'])
  && HEX16.test(item.machineId) && validName(item.name) && HEX64.test(item.certFingerprint) && item.machineId === item.certFingerprint.slice(0, 16)
  && validAddresses(item.addresses, addressOk) && validPort(item.port) && HEX16.test(item.addedBy) && time(item.addedAtMs);
const validRemoved = (item) => fields(item, ['machineId', 'certFingerprint', 'removedBy', 'removedAtMs'])
  && HEX16.test(item.machineId) && HEX64.test(item.certFingerprint) && HEX16.test(item.removedBy) && time(item.removedAtMs);
const validPhone = (item) => fields(item, ['deviceId', 'name', 'tokenHash', 'addedBy', 'addedAtMs'])
  && /^[a-f0-9]{12}$/.test(item.deviceId) && phoneName(item.name) && HEX64.test(item.tokenHash) && HEX16.test(item.addedBy) && time(item.addedAtMs);
const validRemovedPhone = (item) => fields(item, ['deviceId', 'removedBy', 'removedAtMs'])
  && /^[a-f0-9]{12}$/.test(item.deviceId) && HEX16.test(item.removedBy) && time(item.removedAtMs);

// Strict check of a loaded group (with `self`) or a received one (without it).
export function validateGroup(value, { withSelf = true, addressOk = validPeerAddress } = {}) {
  const keys = ['schema', 'groupId', 'members', 'removed', 'phones', 'removedPhones', ...(withSelf ? ['self'] : [])];
  if (!fields(value, keys) || value.schema !== GROUP_SCHEMA || typeof value.groupId !== 'string' || !HEX16.test(value.groupId)) return false;
  const list = (items, limit, check) => Array.isArray(items) && items.length <= limit && items.every(check);
  if (!list(value.members, MAX_MEMBERS, (item) => validMember(item, addressOk)) || !unique(value.members, (item) => item.machineId)
    || !list(value.removed, MAX_TOMBSTONES, validRemoved) || !unique(value.removed, (item) => `${item.machineId}:${item.certFingerprint}`)
    || !list(value.phones, MAX_PHONES, validPhone) || !unique(value.phones, (item) => item.deviceId)
    || !list(value.removedPhones, MAX_TOMBSTONES, validRemovedPhone) || !unique(value.removedPhones, (item) => item.deviceId)) return false;
  const names = activeMembers(value).map((item) => item.name.toLowerCase());
  if (new Set(names).size !== names.length) return false;
  if (!withSelf) return true;
  return fields(value.self, ['machineId', 'name']) && HEX16.test(value.self.machineId) && validName(value.self.name)
    && value.members.some((item) => item.machineId === value.self.machineId);
}

const tombstoned = (group, member) => group.removed.some((item) => item.machineId === member.machineId && item.certFingerprint === member.certFingerprint);
export const activeMembers = (group) => group.members.filter((member) => !tombstoned(group, member));
export const activePhones = (group) => group.phones.filter((phone) => !group.removedPhones.some((item) => item.deviceId === phone.deviceId));

// The older entry wins: the smaller time, then the smaller author ID.
const older = (timeKey, byKey) => (left, right) => left[timeKey] - right[timeKey] || (left[byKey] < right[byKey] ? -1 : left[byKey] > right[byKey] ? 1 : 0);
function union(lists, key, order) {
  const kept = new Map();
  for (const item of lists.flat()) {
    const id = key(item);
    const current = kept.get(id);
    if (!current || order(item, current) < 0) kept.set(id, item);
  }
  return [...kept.values()].sort((left, right) => order(left, right) || (key(left) < key(right) ? -1 : 1));
}
// Full tombstone lists drop their oldest entries first.
const newest = (list) => list.slice(-MAX_TOMBSTONES);

// Union of both groups; a tombstone always wins and stays. A group with another ID changes nothing.
export function mergeGroup(local, remote) {
  if (!remote || remote.groupId !== local.groupId) return local;
  const removed = newest(union([local.removed, remote.removed], (item) => `${item.machineId}:${item.certFingerprint}`, older('removedAtMs', 'removedBy')));
  const removedPhones = newest(union([local.removedPhones, remote.removedPhones], (item) => item.deviceId, older('removedAtMs', 'removedBy')));
  const members = union([local.members, remote.members], (item) => item.machineId, older('addedAtMs', 'addedBy'))
    .filter((member) => !removed.some((item) => item.machineId === member.machineId && item.certFingerprint === member.certFingerprint))
    .slice(0, MAX_MEMBERS);
  const phones = union([local.phones, remote.phones], (item) => item.deviceId, older('addedAtMs', 'addedBy'))
    .filter((phone) => !removedPhones.some((item) => item.deviceId === phone.deviceId)).slice(0, MAX_PHONES);
  return { schema: GROUP_SCHEMA, groupId: local.groupId, ...(local.self ? { self: local.self } : {}), members, removed, phones, removedPhones };
}

export function withoutSelf(group) {
  const { self: _, ...rest } = group;
  return rest;
}

// Same style as phone.json: an invalid file moves to group.json.bad.
export async function loadGroup(file, { addressOk } = {}) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return { group: null, warning: '' }; throw cause; }
  let value;
  try { value = JSON.parse(raw); } catch {}
  if (!validateGroup(value, { addressOk })) {
    await fs.rename(file, `${file}.bad`);
    return { group: null, warning: 'ASB moved an invalid group.json to group.json.bad.' };
  }
  await fs.chmod(file, 0o600);
  return { group: value, warning: '' };
}

export async function saveGroup(file, group) {
  const temporary = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.rm(temporary, { force: true });
  try {
    await fs.writeFile(temporary, JSON.stringify(group, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export const createInvite = (nowMs = Date.now()) => ({ code: randomBytes(20).toString('base64url'), expiresAtMs: nowMs + INVITE_MS, failures: 0 });

// 'ok' uses the invite; 'bad' counts a wrong code (8 wrong codes void it); 'none' means no current invite.
export function checkInvite(invite, code, nowMs = Date.now()) {
  if (!invite || nowMs >= invite.expiresAtMs || invite.failures >= 8) return 'none';
  const given = Buffer.from(String(code));
  const expected = Buffer.from(invite.code);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return 'ok';
  invite.failures += 1;
  return 'bad';
}

// The address list of a join link and a hello query: `kind:address` items, split at `,`, then at the first `:`.
const joinAddresses = (addresses) => addresses.map(({ kind, address }) => `${kind}:${address}`).join(',');
const splitAddresses = (text) => text.split(',').map((item) => {
  const at = item.indexOf(':');
  return { kind: item.slice(0, at), address: item.slice(at + 1) };
});
const PORT_TEXT = /^[1-9][0-9]{3,4}$/;

export function buildJoinLink({ groupId, addresses, port, fingerprint, code, name }) {
  const values = { v: 1, g: groupId, a: joinAddresses(addresses), p: port, f: fingerprint, c: code, n: name };
  return `asb://join?${Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

export function parseJoinLink(link, { addressOk = validPeerAddress } = {}) {
  if (typeof link !== 'string' || link.length > 4096 || !link.startsWith('asb://join?')) return null;
  const values = {};
  for (const part of link.slice('asb://join?'.length).split('&')) {
    const [key, value, extra] = part.split('=');
    if (extra !== undefined || value === undefined || Object.hasOwn(values, key)) return null;
    try { values[key] = decodeURIComponent(value); } catch { return null; }
  }
  if (!fields(values, ['v', 'g', 'a', 'p', 'f', 'c', 'n']) || values.v !== '1' || !HEX16.test(values.g) || !PORT_TEXT.test(values.p)
    || !HEX64.test(values.f) || !CODE.test(values.c) || !validName(values.n)) return null;
  const addresses = splitAddresses(values.a);
  const port = Number(values.p);
  if (!validAddresses(addresses, addressOk) || !validPort(port)) return null;
  return { groupId: values.g, addresses, port, fingerprint: values.f, code: values.c, name: values.n };
}

export const fingerprintOf = (raw) => createHash('sha256').update(raw).digest('hex');

const refuse = (statusCode, message, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });
const NETWORK_OFF = 'Turn on network access first: asb network enable <address>.';
const reply = (status, body) => ({ status, body });

// Decision A: one object owns group.json, the invite, the join and leave flows, the pollers, and the gateway peer callbacks.
// The gateway and the server are read lazily (decision B).
export function createMachineGroup({ file = groupPath(), gateway, server = () => null, asbVersion = '', now = Date.now,
  log = (line) => console.error(line), addressOk = validPeerAddress, onChange = () => {}, request = peerRequest,
  hostName = localMachineName(), timers } = {}) {
  let group = null;
  let invite = null;
  let exported = null;
  let credentials = null;
  let started = false;
  const pollers = new Map();
  let work = Promise.resolve();
  const serialize = (action) => {
    const result = work.catch(() => {}).then(action);
    work = result;
    return result;
  };
  const tls = async () => credentials ??= await gateway().credentials();
  const peerStates = () => [...pollers.values()].map((poller) => poller.state);
  // The last activity reply of each member and period (contract 4), kept 30 s; an offline member keeps its last reply.
  const activityReplies = new Map();
  const ACTIVITY_PERIODS = Object.keys(USAGE_PERIODS);
  async function memberActivity(state, period) {
    const key = `${state.member.machineId}\0${period}`;
    const entry = activityReplies.get(key) || { checkedAtMs: -Infinity, online: false, reply: null, lastReportAtMs: 0, pending: null };
    activityReplies.set(key, entry);
    if (!entry.pending && now() - entry.checkedAtMs >= 30_000) {
      entry.pending = (async () => {
        try {
          if (!state.online) throw new Error('offline');
          const answer = await request({ member: state.member, path: `/peer/v1/activity?period=${period}`, tls: await tls(),
            lastAddress: state.lastAddress, timeoutMs: 5000, maxBytes: MAX_ACTIVITY_BYTES });
          const reply = answer.status === 200 ? validActivity(answer.body) : null;
          if (!reply) throw new Error('invalid-reply');
          Object.assign(entry, { online: true, reply, lastReportAtMs: now() });
        } catch { entry.online = false; }
        entry.checkedAtMs = now();
      })().finally(() => { entry.pending = null; });
    }
    await entry.pending;
    return { machineId: state.member.machineId, name: state.member.name, state: entry.online ? 'online' : 'offline',
      lastReportAtMs: entry.lastReportAtMs, messages: entry.reply?.messages || [], usage: entry.reply?.usage || [],
      scan: entry.reply?.scan || { complete: true, files: 0, scannedFiles: 0 } };
  }

  const savedNetwork = (member) => JSON.stringify([member.addresses, member.port]);
  // Each hello tells the member the current network of this machine, so a member that cannot reach the old one learns the new one.
  const helloQuery = async () => {
    try {
      const { addresses, port } = await network();
      return validAddresses(addresses, addressOk) && validPort(port) ? `?a=${encodeURIComponent(joinAddresses(addresses))}&p=${port}` : '';
    } catch { return ''; }
  };

  function syncPollers() {
    const wanted = new Map((group && started ? activeMembers(group) : [])
      .filter((member) => member.machineId !== group.self.machineId).map((member) => [member.machineId, member]));
    for (const [machineId, poller] of pollers) {
      const member = wanted.get(machineId);
      if (member && member.certFingerprint === poller.state.member.certFingerprint) {
        poller.state.member.name = member.name;
        // Only a changed saved entry replaces the addresses and port that the poller learned from a hello reply.
        if (poller.saved !== savedNetwork(member)) Object.assign(poller.state.member, { addresses: member.addresses, port: member.port });
        poller.saved = savedNetwork(member);
        continue;
      }
      poller.stop();
      pollers.delete(machineId);
    }
    for (const [machineId, member] of wanted) {
      if (pollers.has(machineId)) continue;
      const poller = createPeerPoller({ member, tls, request, now, onChange, validAddresses: (value) => validAddresses(value, addressOk), helloQuery,
        onGroup: (value) => serialize(() => applyGroup(value)), onRemoved: () => serialize(removed), ...(timers ? { timers } : {}) });
      poller.saved = savedNetwork(member);
      pollers.set(machineId, poller);
      poller.start();
    }
  }

  async function forget() {
    await fs.rm(file, { force: true });
    group = null;
    invite = null;
    exported = null;
    syncPollers();
    onChange();
  }

  // Decision F: a tombstone for this machine, or a 410 from a member.
  async function removed() {
    if (!group) return;
    await forget();
    log('ASB: this machine was removed from the machine group.');
  }

  // Merges a group from a member; decision F: a tombstone for this machine makes it leave at once.
  async function applyGroup(value) {
    if (!group || !validateGroup(value, { withSelf: false, addressOk })) return;
    const merged = mergeGroup(group, value);
    const { fingerprint } = await tls();
    if (merged.removed.some((item) => item.machineId === group.self.machineId && item.certFingerprint === fingerprint)) {
      await removed();
      return;
    }
    if (JSON.stringify(merged) === JSON.stringify(group)) return;
    if (!validateGroup(merged, { addressOk })) {
      log('ASB did not apply a group update from another machine: the merged group is not valid.');
      return;
    }
    await saveGroup(file, merged);
    group = merged;
    syncPollers();
    onChange();
  }

  async function network() {
    const status = await gateway().status();
    if (!status.running) throw refuse(409, NETWORK_OFF);
    return { addresses: status.listening, port: status.port };
  }

  const phoneEntries = async (existing, addedBy) => (await gateway().devices()).filter((device) => !existing.some((item) => item.deviceId === device.id))
    .map((device) => ({ deviceId: device.id, name: device.name, tokenHash: device.tokenSha256, addedBy, addedAtMs: now() }));

  async function save(next) {
    await saveGroup(file, next);
    group = next;
    syncPollers();
    onChange();
  }

  function status(networkEnabled, identity) {
    if (!group) return { groupId: '', self: { machineId: identity, name: suggestName(hostName, []) }, networkEnabled, members: [], phones: [] };
    return { groupId: group.groupId, self: { ...group.self }, networkEnabled,
      members: activeMembers(group).map((member) => {
        const state = pollers.get(member.machineId)?.state;
        const isSelf = member.machineId === group.self.machineId;
        return { machineId: member.machineId, name: member.name, online: isSelf || Boolean(state?.online),
          lastOkAtMs: isSelf ? now() : state?.lastOkAtMs || 0, addresses: (state?.member.addresses || member.addresses).map((item) => ({ ...item })), isSelf,
          asbVersion: isSelf ? asbVersion : state?.member.asbVersion || '' };
      }),
      phones: activePhones(group).map(({ deviceId, name }) => ({ deviceId, name })) };
  }
  const currentStatus = async () => {
    const running = (await gateway().status()).running;
    return status(running, group ? group.self.machineId : await gateway().identity().catch(() => ''));
  };

  return {
    start: () => serialize(async () => {
      const loaded = await loadGroup(file, { addressOk });
      if (loaded.warning) log(`ASB: ${loaded.warning}`);
      group = loaded.group;
      started = true;
      if (group) {
        const { fingerprint } = await tls();
        if (group.removed.some((item) => item.machineId === group.self.machineId && item.certFingerprint === fingerprint)) await removed();
      }
      syncPollers();
    }),
    stop: () => serialize(async () => {
      started = false;
      syncPollers();
    }),
    // Decision E: the name of local rows.
    selfName: () => group?.self.name || hostName,
    self: () => group ? { ...group.self } : null,
    // For the tracker: the machine IDs of the active members. It is null before the group is loaded, so no record goes then,
    // and an empty list when this machine is in no group, so the records and pins of the old members go.
    memberIds: () => started ? (group ? activeMembers(group).map((member) => member.machineId) : []) : null,
    // Decision D: the export comes from the loaded dashboard before the merge, while it has only local rows.
    merge: (dashboard, nowMs = now()) => {
      exported = group ? exportBody(exportLocalSessions(dashboard, group.self, nowMs)) : null;
      return group ? mergePeerRows(dashboard, peerStates(), group.self, nowMs) : dashboard;
    },
    peerStates,
    // Contract 4, the asking side: the activity of each active member, asked in parallel (5 s timeout each), by name.
    activity: async (period) => {
      if (!ACTIVITY_PERIODS.includes(period)) throw new Error('Invalid period.');
      const states = peerStates();
      const ids = new Set(states.map((state) => state.member.machineId));
      for (const key of activityReplies.keys()) if (!ids.has(key.split('\0')[0])) activityReplies.delete(key);
      const members = await Promise.all(states.map((state) => memberActivity(state, period)));
      const order = (item) => `${item.name.toLowerCase()}\0${item.machineId}`;
      return members.sort((left, right) => order(left) < order(right) ? -1 : 1);
    },
    // The member TLS of this machine, for the message relay (plan 16.6).
    tls,
    status: () => serialize(currentStatus),
    // One read-only request to an online member, with the request function and address of its poller; the poller state stays.
    fetchMember: async (machineId, path, { timeoutMs = 4000 } = {}) => {
      const state = pollers.get(machineId)?.state;
      if (!state?.online) throw new Error('offline');
      return request({ member: state.member, path, tls: await tls(), lastAddress: state.lastAddress, timeoutMs });
    },

    invite: () => serialize(async () => {
      const { addresses, port } = await network();
      const { fingerprint } = await tls();
      if (!group) {
        const self = { machineId: fingerprint.slice(0, 16), name: suggestName(hostName, []) };
        const next = { schema: GROUP_SCHEMA, groupId: randomBytes(8).toString('hex'), self,
          members: [{ machineId: self.machineId, name: self.name, certFingerprint: fingerprint, addresses, port, addedBy: self.machineId, addedAtMs: now() }],
          removed: [], phones: (await phoneEntries([], self.machineId)).slice(0, MAX_PHONES), removedPhones: [] };
        if (!validateGroup(next, { addressOk })) throw refuse(409, 'ASB cannot create a group with these network addresses.');
        await save(next);
      } else {
        // A machine that joins later polls this saved entry, so it must have the address and port of the join link.
        const self = group.members.find((member) => member.machineId === group.self.machineId);
        if (JSON.stringify([self.addresses, self.port]) !== JSON.stringify([addresses, port])) {
          const next = { ...group, members: group.members.map((member) => member === self ? { ...member, addresses, port } : member) };
          if (!validateGroup(next, { addressOk })) throw refuse(409, 'ASB cannot save these network addresses in the group.');
          await save(next);
        }
      }
      invite = createInvite(now());
      return { link: buildJoinLink({ groupId: group.groupId, addresses, port, fingerprint, code: invite.code, name: group.self.name }),
        fingerprint, expiresAtMs: invite.expiresAtMs };
    }),

    join: ({ link, name }) => serialize(async () => {
      const parsed = parseJoinLink(link, { addressOk });
      if (!parsed) throw refuse(400, 'This join link is not valid.');
      if (group) throw refuse(409, 'Leave the current group first.');
      const { addresses, port } = await network();
      const own = await tls();
      if (own.fingerprint === parsed.fingerprint) throw refuse(409, 'This link is from this machine.');
      const wanted = name || suggestName(hostName, []);
      const inviter = { machineId: parsed.fingerprint.slice(0, 16), certFingerprint: parsed.fingerprint, addresses: parsed.addresses, port: parsed.port };
      let answer;
      try {
        answer = await request({ member: inviter, path: '/peer/v1/join', method: 'POST', body: { code: parsed.code, name: wanted, addresses, port }, tls: own });
      } catch { throw refuse(502, 'The other machine did not answer.'); }
      const body = answer.body;
      if (answer.status === 409 && typeof body?.error === 'string') {
        throw refuse(409, body.error.slice(0, 200), validName(body.suggestion) ? { suggestion: body.suggestion } : {});
      }
      if (answer.status === 401) throw refuse(409, 'The join code is not valid or has expired. Make a new invite on the other machine.');
      if (answer.status === 429) throw refuse(409, 'The other machine refused too many attempts. Wait one minute.');
      const machineId = own.fingerprint.slice(0, 16);
      const me = body?.group?.members?.find?.((member) => member.machineId === machineId);
      if (answer.status !== 200 || !fields(body, ['groupId', 'group']) || body.groupId !== parsed.groupId || body.group.groupId !== parsed.groupId
        || !validateGroup(body.group, { withSelf: false, addressOk }) || me?.certFingerprint !== own.fingerprint
        || !activeMembers(body.group).some((member) => member.certFingerprint === parsed.fingerprint)) {
        throw refuse(502, 'The other machine sent an invalid reply.');
      }
      const phones = [...body.group.phones, ...await phoneEntries(body.group.phones, machineId)].slice(0, MAX_PHONES);
      await save({ ...body.group, self: { machineId, name: me.name }, phones });
      return { joined: true, groupId: group.groupId };
    }),

    remove: (machineId) => serialize(async () => {
      if (!group) throw refuse(409, 'This machine is not in a group.');
      if (machineId === group.self.machineId) throw refuse(409, 'Use asb group leave to leave the group.');
      const member = activeMembers(group).find((item) => item.machineId === machineId);
      if (!member) throw refuse(400, 'No machine with this ID is in the group.');
      await save(mergeGroup(group, { ...withoutSelf(group), removed: [...group.removed,
        { machineId, certFingerprint: member.certFingerprint, removedBy: group.self.machineId, removedAtMs: now() }] }));
      return currentStatus();
    }),

    leave: () => serialize(async () => {
      if (!group) throw refuse(409, 'This machine is not in a group.');
      const own = await tls();
      const members = [...pollers.values()].map((poller) => poller.state).sort((left, right) => right.online - left.online).map((state) => state.member);
      // Best effort: the first member that answers in 4 s.
      let timer;
      await Promise.race([
        (async () => {
          for (const member of members) {
            try { if ((await request({ member, path: '/peer/v1/leave', method: 'POST', body: {}, tls: own, timeoutMs: 4000 })).status === 200) return; } catch {}
          }
        })(),
        new Promise((resolve) => { timer = setTimeout(resolve, 4000); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      await forget();
      return { left: true };
    }),

    onPhonePaired: (device) => serialize(async () => {
      if (!group || group.phones.some((item) => item.deviceId === device.id) || activePhones(group).length >= MAX_PHONES) return;
      await save({ ...group, phones: [...group.phones, { deviceId: device.id, name: device.name, tokenHash: device.tokenSha256,
        addedBy: group.self.machineId, addedAtMs: now() }] });
    }).catch(() => log('ASB cannot save the machine group.')),
    onPhoneRevoked: (id) => serialize(async () => {
      if (!group) return;
      await save(mergeGroup(group, { ...withoutSelf(group), removedPhones: [...group.removedPhones,
        { deviceId: id, removedBy: group.self.machineId, removedAtMs: now() }] }));
    }).catch(() => log('ASB cannot save the machine group.')),

    // The gateway peer callbacks (plan 9.4). `removedFingerprint`, `memberFingerprint`, and `phones` are synchronous: the gateway calls them in its queue.
    peer: {
      removedFingerprint: (fingerprint) => Boolean(group) && group.removed.some((item) => item.certFingerprint === fingerprint),
      memberFingerprint: (fingerprint) => Boolean(group) && activeMembers(group).some((member) => member.certFingerprint === fingerprint),
      phones: () => group ? activePhones(group).map(({ deviceId, name, tokenHash }) => ({ deviceId, name, tokenHash })) : [],
      // The phone hello lists the members, so a phone can change to another engine (plan 15.1).
      engines: () => group ? activeMembers(group).map((member) => ({ machineId: member.machineId, name: member.name,
        port: member.port, fingerprint: member.certFingerprint,
        addresses: (pollers.get(member.machineId)?.state?.member.addresses || member.addresses).map((item) => ({ ...item })) })) : [],
      hello: async () => {
        const status = await gateway().status();
        return { api: 1, machineId: group.self.machineId, name: group.self.name, groupId: group.groupId, asbVersion,
          addresses: status.listening, port: status.port };
      },
      // The hello query of a member: its current addresses and port, saved in its own active entry only.
      seen: (fingerprint, params) => serialize(async () => {
        const text = params.get('a');
        const portText = params.get('p');
        if (!group || text === null || portText === null || !PORT_TEXT.test(portText)) return;
        const addresses = splitAddresses(text);
        const port = Number(portText);
        if (!validAddresses(addresses, addressOk) || !validPort(port)) return;
        const member = activeMembers(group).find((item) => item.certFingerprint === fingerprint && item.machineId !== group.self.machineId);
        if (!member || savedNetwork(member) === savedNetwork({ addresses, port })) return;
        const next = { ...group, members: group.members.map((item) => item === member ? { ...item, addresses, port } : item) };
        if (validateGroup(next, { addressOk })) await save(next);
      }),
      group: async () => withoutSelf(group),
      sessions: async (ifNoneMatch) => {
        await server()?.dashboardForRequest();
        // A cached dashboard from before the group has no export.
        if (!exported) await server()?.dashboardForRequest({ force: true });
        if (!exported) return { status: 503, etag: '', body: JSON.stringify({ error: 'ASB has no session list yet.' }) };
        return ifNoneMatch === exported.etag ? { status: 304, etag: exported.etag, body: '' } : { status: 200, ...exported };
      },
      // GET /peer/v1/activity (contract 4): this machine's local records only, never text.
      activity: async (period) => {
        const value = await server()?.activityMember?.(period);
        return value ? reply(200, value) : reply(404, { error: 'Route is not available.' });
      },
      join: (value, fingerprint) => serialize(async () => {
        if (!group || checkInvite(invite, value.code, now()) !== 'ok') return reply(401, { error: 'This join code is not valid. Make a new invite.' });
        if (group.removed.some((item) => item.certFingerprint === fingerprint)) {
          return reply(409, { error: 'This machine was removed. Reset its identity and join again.' });
        }
        const active = activeMembers(group);
        if (active.some((member) => member.certFingerprint === fingerprint)) return reply(409, { error: 'This machine is already in the group.' });
        if (!validAddresses(value.addresses, addressOk) || !validPort(value.port)) return reply(400, { error: 'Invalid join request.' });
        const taken = active.map((member) => member.name);
        if (!validName(value.name) || taken.some((item) => item.toLowerCase() === value.name.toLowerCase())) {
          return reply(409, { error: validName(value.name) ? 'Another machine in the group has this name.' : 'This machine name is not valid.',
            suggestion: suggestName(value.name, taken) });
        }
        if (active.length >= MAX_MEMBERS) return reply(409, { error: 'The group is full.' });
        const machineId = fingerprint.slice(0, 16);
        await save({ ...group, members: [...group.members.filter((member) => member.machineId !== machineId), { machineId, name: value.name,
          certFingerprint: fingerprint, addresses: value.addresses.map(({ kind, address }) => ({ kind, address })), port: value.port,
          addedBy: group.self.machineId, addedAtMs: now() }] });
        invite = null;
        return reply(200, { groupId: group.groupId, group: withoutSelf(group) });
      }),
      leave: (fingerprint) => serialize(async () => {
        if (!group) return reply(401, { error: 'This machine is not in the group.' });
        await save(mergeGroup(group, { ...withoutSelf(group), removed: [...group.removed,
          { machineId: fingerprint.slice(0, 16), certFingerprint: fingerprint, removedBy: fingerprint.slice(0, 16), removedAtMs: now() }] }));
        return reply(200, { left: true });
      }),
    },
  };
}
