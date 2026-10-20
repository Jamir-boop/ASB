// The read-only lookup of a session reference in the rows that the engine already has (SYSTEM_OVERVIEW.md,
// "Session references"). No I/O: the server gives the cached rows, the registered sources, their scope tags,
// the local machine identity, and the machine group members.
import { sourceName } from './app-sources.mjs';
import { parseReference, parseShortReference, validMachineId } from './session-references.mjs';

const MESSAGES = {
  'invalid-reference': 'This is not a valid session reference.',
  'unsupported-reference-version': 'This session reference has an unsupported version.',
  'scope-mismatch': 'The --source value is not the source in this full reference.',
  'scope-required': 'More than one source has this short reference. Give the source with --source, or use the full reference.',
  'no-machine-identity': 'This ASB has no machine identity, so it cannot resolve a full reference.',
  'unknown-machine': 'The machine in this reference is not this machine or a member of its machine group.',
  'stale-source': 'The source in this reference is not registered now.',
  'stale-source-scope': 'The folders of this source changed after ASB made this reference.',
  'ambiguous-identity': 'More than one session has this reference. ASB does not select one.',
  'evidence-incomplete': 'The member machine has an older ASB that does not send full references.',
};
const fail = (code) => ({ apiVersion: 1, ok: false, code, message: MESSAGES[code] });
const ok = (form, identity, display, location, availability, extra = {}) =>
  ({ apiVersion: 1, ok: true, form, identity, display, location, availability, ...extra });
const identityOf = ({ machineId, sourceId, scopeTag, type, appId }, reference) => ({ reference, machineId, sourceId, scopeTag, type, appId });
const text = (value) => typeof value === 'string' ? value : null;
const locationOf = (row) => row.remote ? 'member' : row.remoteCache === true ? 'native-remote-observation' : 'local';
// A member row has only the source label; this gives the same name text as a local source.
const rowSourceName = (row) => text(row.sourceName)
  ?? (typeof row.sourceLabel === 'string' && typeof row.sourceId === 'string' ? sourceName({ label: row.sourceLabel, id: row.sourceId }) : null);

export function resolveSessionReference({ reference, sourceId } = {}, { threads = [], sources = [], tags = new Map(), machine = {}, members = [] } = {}) {
  if (typeof reference === 'string' && reference.startsWith('asb:')) return resolveFull(reference, sourceId, { threads, sources, tags, machine, members });
  try { parseShortReference(reference); } catch { return fail('invalid-reference'); }
  const rows = threads.filter((row) => !row.remote && row.sessionReference === reference && (sourceId === undefined || row.sourceId === sourceId));
  if (!rows.length) return ok('short', null, null, null, 'not-found');
  if (new Set(rows.map((row) => row.sourceId)).size > 1) return fail('scope-required');
  if (rows.length > 1) return fail('ambiguous-identity');
  const [row] = rows;
  const display = { machineName: text(machine.machineName), sourceName: rowSourceName(row), providerLabel: text(row.providerLabel) };
  if (typeof row.reference !== 'string') {
    return ok('short', null, display, locationOf(row), 'found', { referenceUnavailable: text(row.referenceUnavailable) ?? 'unknown-source' });
  }
  return ok('short', identityOf(parseReference(row.reference), row.reference), display, locationOf(row), 'found');
}

function resolveFull(reference, sourceId, { threads, sources, tags, machine, members }) {
  let parsed;
  try { parsed = parseReference(reference); } catch (error) { return fail(error.code); }
  // A full reference names its own source; --source cannot change it.
  if (sourceId !== undefined && sourceId !== parsed.sourceId) return fail('scope-mismatch');
  if (!validMachineId(machine.machineId)) return fail('no-machine-identity');
  const identity = identityOf(parsed, reference);
  const pick = (rows, display, onFound = 'found') => {
    const matches = rows.filter((row) => row.reference === reference);
    if (matches.length > 1) return fail('ambiguous-identity');
    if (!matches.length) return ok('full', identity, display, null, 'not-found');
    const [row] = matches;
    return ok('full', identity, { ...display, sourceName: display.sourceName ?? rowSourceName(row), providerLabel: text(row.providerLabel) },
      locationOf(row), onFound);
  };
  if (parsed.machineId === machine.machineId) {
    const source = sources.find((item) => item.id === parsed.sourceId);
    if (!source) return fail('stale-source');
    if (tags.get(source.id) !== parsed.scopeTag) return fail('stale-source-scope');
    const display = { machineName: text(machine.machineName), sourceName: sourceName(source), providerLabel: null };
    if (!source.enabled) return ok('full', identity, display, null, 'source-disabled');
    return pick(threads.filter((row) => !row.remote), display);
  }
  const member = members.find((item) => item.machineId === parsed.machineId && !item.isSelf);
  if (!member) return fail('unknown-machine');
  const rows = threads.filter((row) => row.remote === true && row.machineId === member.machineId);
  if (rows.some((row) => row.referenceUnavailable === 'old-peer')) return fail('evidence-incomplete');
  return pick(rows, { machineName: text(member.name), sourceName: null, providerLabel: null }, member.online ? 'found' : 'machine-offline');
}

const BOUND_MESSAGES = {
  'member-target': 'This reference is for a session on another machine. This version of ASB Bridge cannot send to it.',
  'peer-upgrade-required': 'The member machine has an older ASB that cannot take a message for one exact session. Update ASB on that machine.',
  'local-target': 'This reference is for a session on this machine, not on another machine.',
  'unsupported-platform': 'ASB can send by reference only on Linux now.',
  'unsupported-type': 'ASB can send by reference only to Codex and Claude Code CLI sessions.',
  'source-disabled': 'The source of this session is disabled.',
  'not-found': 'ASB has no session with this reference.',
  'caller-unregistered': 'The sending task has no single live registration in its session registry.',
  'native-scope-unavailable': 'The target session is not in the session registry of the sending task.',
  'ambiguous-source': 'More than one source can have this session. ASB does not select one.',
  'not-live': 'The target session has no live receiver now.',
  'not-mapped': 'The live receiver of this session does not belong to the source in this reference.',
  'machine-offline': 'The member machine is not reachable now.',
  'capability-unknown': 'ASB cannot tell if the member machine can send to one exact session.',
  refused: 'The member machine refused the request.',
  'too-large': 'The message is too large for the member machine.',
  'rate-limited': 'Too many messages to this session just now. Wait, or send the text in one message.',
  'target-unavailable': 'The target session on the member machine is not available now.',
  'relay-unavailable': 'The message relay on the member machine is not available now.',
  'binding-expired': 'The time for this send ended before the write.',
  'target-changed': 'The target session changed after ASB found it.',
  'invalid-request': 'ASB cannot make a valid request for this message.',
};
const refuse = (code) => ({ apiVersion: 1, ok: false, code, message: BOUND_MESSAGES[code] });
const BINDING_LIFE_MS = 10_000;
const BOUND_TYPES = ['codex', 'claude-cli'];
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

// The message for a send that did not go out: the bound codes first, then the resolver codes.
export const notSentMessage = (code) => BOUND_MESSAGES[code] ?? MESSAGES[code];

// The one live registration of the sending task in its private registry, or null.
async function callerRecord(caller, io) {
  const registry = await io.registry(caller.configDir);
  const own = registry?.records.filter((record) => record.sessionId === caller.runtimeSessionId) ?? [];
  return own.length === 1 && own[0].entrypoint === 'codex-asb-bridge' ? { registry, record: own[0] } : null;
}

// The live receiver of the identity in the given registries. It never selects one of more candidates.
async function bindIn(identity, reference, context, io, registries, msgId, remainingMs) {
  const source = context.sources.find((item) => item.id === identity.sourceId);
  if (identity.type === 'codex') {
    if (context.threads.some((row) => !row.remote && row.provider === 'codex' && row.externalId === identity.appId
      && row.reference !== reference)) return refuse('ambiguous-source');
  } else {
    const root = await io.claudeRoot(source);
    if (!registries.some((registry) => registry.root === root)) return refuse('native-scope-unavailable');
    for (const other of context.sources) {
      if (other.id !== source.id && other.provider === 'claude-desktop-code' && await io.claudeRoot(other) === root) return refuse('ambiguous-source');
    }
  }
  const candidates = registries.flatMap((registry) => registry.records.filter((record) => record.entrypoint !== 'asb-relay'
    && record.sessionId === identity.appId && typeof record.messagingSocketPath === 'string').map((record) => ({ registry, record })));
  if (!candidates.length) return refuse('not-live');
  if (candidates.length > 1) return fail('ambiguous-identity');
  const [{ registry, record: target }] = candidates;
  if (identity.type === 'codex') {
    const claim = target.entrypoint === 'codex-asb-bridge' ? await io.receiverClaim(source, identity.appId) : null;
    if (claim?.pid !== target.pid || String(claim.proc_start) !== target.procStart) return refuse('not-mapped');
  } else if (target.entrypoint !== 'cli') return refuse('not-mapped');
  return { apiVersion: 1, ok: true, pid: io.pid, binding: { registryHome: registry.root, runtimeSessionId: target.sessionId,
    pid: target.pid, procStart: target.procStart, messagingSocketPath: target.messagingSocketPath, msgId,
    expiresAtMs: io.now() + Math.min(remainingMs, BINDING_LIFE_MS) } };
}

// The live local process of one full reference, for one send by the ASB Bridge (SYSTEM_OVERVIEW.md, "Session references").
// Steps 1 to 6 use only the given rows; io reads the registries and the bridge receiver row. The first failure is the reply.
export async function bindLocalTarget({ reference, caller, msgId, remainingMs }, context, io) {
  if (typeof reference !== 'string' || !reference.startsWith('asb:')) return fail('invalid-reference');
  const resolved = resolveSessionReference({ reference }, context);
  if (!resolved.ok) return resolved.code === 'evidence-incomplete' ? refuse('peer-upgrade-required') : resolved;
  const { identity, availability } = resolved;
  if (identity.machineId !== context.machine?.machineId) return refuse('member-target');
  if (io.platform !== 'linux') return refuse('unsupported-platform');
  if (!BOUND_TYPES.includes(identity.type)) return refuse('unsupported-type');
  if (['source-disabled', 'not-found'].includes(availability)) return refuse(availability);
  const own = await callerRecord(caller, io);
  if (!own) return refuse('caller-unregistered');
  return bindIn(identity, reference, context, io, [own.registry], msgId, remainingMs);
}

// The sending engine's checks for an exact send to a member (SYSTEM_OVERVIEW.md, "Exact member sends"). The member decides
// if the session exists, so the cached member rows are not used here. The first failure is the reply.
export async function memberTarget({ reference, caller }, context, io) {
  if (typeof reference !== 'string' || !reference.startsWith('asb:')) return fail('invalid-reference');
  const resolved = resolveSessionReference({ reference }, context);
  if (!resolved.ok) return resolved.code === 'evidence-incomplete' ? refuse('peer-upgrade-required') : resolved;
  const { identity } = resolved;
  if (identity.machineId === context.machine?.machineId) return refuse('local-target');
  if (io.platform !== 'linux') return refuse('unsupported-platform');
  if (!BOUND_TYPES.includes(identity.type)) return refuse('unsupported-type');
  const own = await callerRecord(caller, io);
  if (!own) return refuse('caller-unregistered');
  const name = typeof own.record.name === 'string' ? own.record.name.replace(CONTROLS, ' ').slice(0, 128) : '';
  // Internal: the receipts of the member go to the outbox of this receiver process only. No route reply has it.
  const { sessionId: runtimeSessionId, pid, procStart, messagingSocketPath } = own.record;
  return { ok: true, identity, name: name || 'Codex', returnTo: { runtimeSessionId, pid, procStart, messagingSocketPath } };
}

const LIST_MAX = 256;
const LOCAL_TYPES = ['cli', 'codex-asb-bridge'];

// The references that a send of this caller accepts now, for list_sessions (SYSTEM_OVERVIEW.md, "Session references").
// The caller registry is read one time; each item is checked like a send, and only the reference or the reason code goes out.
export async function referencesForList({ caller }, context, io, listed = []) {
  if (io.platform !== 'linux') return refuse('unsupported-platform');
  const own = await callerRecord(caller, io);
  if (!own) return refuse('caller-unregistered');
  const once = { ...io, registry: async () => own.registry };
  // One board row gives the reference to check, else the reason that it has none.
  const check = async (rows, target) => {
    if (!rows.length) return { referenceUnavailable: 'not-found' };
    if (rows.length > 1) return { referenceUnavailable: 'ambiguous-source' };
    const [row] = rows;
    if (typeof row.reference !== 'string') return { referenceUnavailable: text(row.referenceUnavailable) ?? 'unknown-source' };
    const result = await target(row.reference);
    return result.ok ? { reference: row.reference } : { referenceUnavailable: result.code };
  };
  const records = new Map();
  for (const record of own.registry.records) {
    if (record.entrypoint === 'asb-relay' || typeof record.messagingSocketPath !== 'string' || record.sessionId === caller.runtimeSessionId) continue;
    records.set(record.sessionId, [...records.get(record.sessionId) ?? [], record]);
  }
  const local = [];
  for (const [sessionId, same] of [...records].slice(0, LIST_MAX)) {
    const item = same.length > 1 ? { referenceUnavailable: 'ambiguous-identity' }
      : !LOCAL_TYPES.includes(same[0].entrypoint) ? { referenceUnavailable: 'unsupported-type' }
        : await check(context.threads.filter((row) => !row.remote && row.externalId === sessionId),
          (reference) => bindLocalTarget({ reference, caller, msgId: null, remainingMs: 0 }, context, once));
    local.push({ sessionId, ...item });
  }
  const remote = [];
  const keys = new Set();
  for (const { machineId, sessionId } of listed) {
    if (remote.length >= LIST_MAX) break;
    if (typeof machineId !== 'string' || typeof sessionId !== 'string' || keys.has(`${machineId}:${sessionId}`)) continue;
    keys.add(`${machineId}:${sessionId}`);
    const item = await check(context.threads.filter((row) => row.remote === true && row.machineId === machineId && row.externalId === sessionId),
      (reference) => memberTarget({ reference, caller }, context, once));
    remote.push({ machineId, sessionId, ...item });
  }
  return { apiVersion: 1, ok: true, pid: io.pid, local, remote };
}

// The receiving engine's own binding for an exact send from a member: no caller registry, only the homes of the target source.
export async function bindMemberTarget({ reference, msgId, remainingMs }, context, io) {
  const resolved = resolveSessionReference({ reference }, context);
  if (!resolved.ok) return resolved;
  const { identity, availability } = resolved;
  if (identity.machineId !== context.machine?.machineId) return fail('unknown-machine');
  if (io.platform !== 'linux') return refuse('unsupported-platform');
  if (!BOUND_TYPES.includes(identity.type)) return refuse('unsupported-type');
  if (['source-disabled', 'not-found'].includes(availability)) return refuse(availability);
  const source = context.sources.find((item) => item.id === identity.sourceId);
  const registries = (await Promise.all((await io.targetHomes(identity.type, source)).map((home) => io.registry(home)))).filter(Boolean);
  // No private registry to read: no live receiver can be checked.
  if (!registries.length) return refuse('not-live');
  return bindIn(identity, reference, context, io, registries, msgId, remainingMs);
}
