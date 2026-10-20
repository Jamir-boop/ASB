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
