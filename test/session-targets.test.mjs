import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReference, rowReference, shortReference } from '../src/session-references.mjs';
import { resolveSessionReference } from '../src/session-targets.mjs';

// Synthetic data only. Platform-neutral (test/windows-tests.json).
const SELF = '0123456789abcdef';
const MEMBER = 'fedcba9876543210';
const OLD = 'aaaaaaaaaaaaaaaa';
const OTHER = '1111111111111111';
const SCOPE = '0123456789abcdef0123456789abcdef';
const SCOPE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SCOPE_M = 'cccccccccccccccccccccccccccccccc';
const UUID = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const SECRET = { title: 'Secret title', cwd: '/home/someone/private', path: '/home/someone/private/a.jsonl', pid: 4242,
  processStart: 'start-stamp-x', message: 'private message text' };
const sources = [
  { id: 'codex', provider: 'codex', label: 'Codex', enabled: true },
  { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude', enabled: true },
  { id: 'work', provider: 'codex', label: 'Work Profile', enabled: true },
  { id: 'off', provider: 'codex', label: 'Off', enabled: false },
];
const tags = new Map([['codex', SCOPE], ['claude-desktop-code', SCOPE_B], ['work', SCOPE], ['off', SCOPE]]);
const machine = { machineId: SELF, machineName: 'desk' };
const members = [{ machineId: SELF, name: 'desk', online: true, isSelf: true }, { machineId: MEMBER, name: 'laptop', online: true },
  { machineId: OLD, name: 'old-box', online: true }];
// A local row as the server makes it: the reference fields come from the step 1 helpers.
const local = (extra) => {
  const row = { id: extra.externalId, remote: false, providerLabel: 'Codex', ...SECRET, ...extra };
  const sourceName = { codex: 'codex', 'claude-desktop-code': 'claude', work: 'work-profile' }[row.sourceId];
  Object.assign(row, { sourceName }, rowReference(row, { machineId: SELF, sourceId: row.sourceId, scopeTag: tags.get(row.sourceId) }));
  const short = shortReference(row);
  return short ? { ...row, sessionReference: short } : row;
};
const codexRow = local({ provider: 'codex', sourceId: 'codex', externalId: UUID });
const workRow = local({ provider: 'codex', sourceId: 'work', externalId: UUID });
const cacheRow = local({ provider: 'claude-desktop-code', sourceId: 'claude-desktop-code', externalId: 'cse_abc', remoteCache: true,
  providerLabel: 'Claude Desktop Code' });
const memberRow = (machineId, extra = {}) => {
  const row = { id: `m:${machineId}:x`, remote: true, machineId, provider: 'codex', providerLabel: 'Codex', surface: 'app',
    sourceId: 'codex', sourceLabel: 'Home Codex', externalId: UUID_2, ...SECRET, ...extra };
  return { ...row, ...rowReference(row, { machineId, sourceId: row.sourceId, scopeTag: machineId === OLD ? undefined : SCOPE_M }, 'old-peer') };
};
const memberFound = memberRow(MEMBER);
const oldRow = memberRow(OLD);
const threads = [codexRow, workRow, cacheRow, memberFound, oldRow];
const context = { threads, sources, tags, machine, members };
const resolve = (reference, sourceId, overrides = {}) => {
  const result = resolveSessionReference({ reference, ...(sourceId === undefined ? {} : { sourceId }) }, { ...context, ...overrides });
  const text = JSON.stringify(result);
  for (const value of Object.values(SECRET)) assert.equal(text.includes(String(value)), false, `${value} must not be in the result`);
  for (const key of ['title', 'cwd', 'path', 'folder', 'pid', 'token', 'socket']) assert.equal(text.includes(`"${key}"`), false);
  return result;
};
const failed = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal(result.apiVersion, 1);
  assert.equal(result.code, code);
  assert.match(result.message, /^[^—]+\.$/);
};
const full = (machineId, sourceId, scopeTag, type, appId) => formatReference({ machineId, sourceId, scopeTag, type, appId });
const ident = (reference, machineId, sourceId, scopeTag, type, appId) => ({ reference, machineId, sourceId, scopeTag, type, appId });

test('a full local reference is found with its machine, source, and location', () => {
  assert.deepEqual(resolve(codexRow.reference), { apiVersion: 1, ok: true, form: 'full',
    identity: ident(codexRow.reference, SELF, 'codex', SCOPE, 'codex', UUID),
    display: { machineName: 'desk', sourceName: 'codex', providerLabel: 'Codex' }, location: 'local', availability: 'found' });
  assert.deepEqual(resolve(codexRow.reference, 'codex').availability, 'found');
  const cache = resolve(cacheRow.reference);
  assert.deepEqual([cache.location, cache.availability, cache.identity.type, cache.display.sourceName],
    ['native-remote-observation', 'found', 'claude-remote', 'claude']);
});

test('full reference failures have stable codes and never guess', () => {
  failed(resolve('asb:1/x'), 'invalid-reference');
  failed(resolve(`asb:2/${SELF}/codex/${SCOPE}/codex:${UUID}`), 'unsupported-reference-version');
  failed(resolve(codexRow.reference, 'work'), 'scope-mismatch');
  failed(resolve(codexRow.reference, undefined, { machine: { machineId: '', machineName: 'desk' } }), 'no-machine-identity');
  failed(resolve(codexRow.reference, undefined, { machine: {} }), 'no-machine-identity');
  failed(resolve(full(SELF, 'gone', SCOPE, 'codex', UUID)), 'stale-source');
  failed(resolve(codexRow.reference, undefined, { sources: sources.filter((source) => source.id !== 'codex') }), 'stale-source');
  // A changed folder gives the source a new tag.
  failed(resolve(codexRow.reference, undefined, { tags: new Map([...tags, ['codex', SCOPE_M]]) }), 'stale-source-scope');
  failed(resolve(full(SELF, 'codex', SCOPE_B, 'codex', UUID)), 'stale-source-scope');
  failed(resolve(codexRow.reference, undefined, { threads: [codexRow, { ...codexRow, id: 'copy' }] }), 'ambiguous-identity');
  failed(resolve(full(OTHER, 'codex', SCOPE, 'codex', UUID)), 'unknown-machine');
  failed(resolve(memberFound.reference, undefined, { members: [] }), 'unknown-machine');
  failed(resolve(full(OLD, 'codex', SCOPE_M, 'codex', UUID_2)), 'evidence-incomplete');
  failed(resolve(full(MEMBER, 'codex', SCOPE_M, 'codex', UUID_2), undefined,
    { threads: [memberFound, { ...memberFound, id: 'copy' }] }), 'ambiguous-identity');
});

test('not-found and source-disabled results take the identity from the text', () => {
  const missing = full(SELF, 'codex', SCOPE, 'codex', UUID_2);
  assert.deepEqual(resolve(missing), { apiVersion: 1, ok: true, form: 'full', identity: ident(missing, SELF, 'codex', SCOPE, 'codex', UUID_2),
    display: { machineName: 'desk', sourceName: 'codex', providerLabel: null }, location: null, availability: 'not-found' });
  const disabled = full(SELF, 'off', SCOPE, 'codex', UUID);
  // A disabled source has no row lookup, even when a row has the same text.
  assert.deepEqual(resolve(disabled, undefined, { threads: [{ ...codexRow, reference: disabled }] }), { apiVersion: 1, ok: true, form: 'full',
    identity: ident(disabled, SELF, 'off', SCOPE, 'codex', UUID),
    display: { machineName: 'desk', sourceName: 'off', providerLabel: null }, location: null, availability: 'source-disabled' });
  // A member row is never a local match.
  assert.equal(resolve(full(SELF, 'codex', SCOPE, 'codex', UUID_2), undefined, { threads: [{ ...memberFound, machineId: SELF }] }).availability, 'not-found');
});

test('member references use only the rows that the engine has, with the member state', () => {
  assert.deepEqual(resolve(memberFound.reference), { apiVersion: 1, ok: true, form: 'full',
    identity: ident(memberFound.reference, MEMBER, 'codex', SCOPE_M, 'codex', UUID_2),
    display: { machineName: 'laptop', sourceName: 'home-codex', providerLabel: 'Codex' }, location: 'member', availability: 'found' });
  const offline = resolve(memberFound.reference, undefined, { members: [{ ...members[1], online: false }] });
  assert.deepEqual([offline.availability, offline.location], ['machine-offline', 'member']);
  const missing = full(MEMBER, 'codex', SCOPE_M, 'codex', UUID);
  assert.deepEqual(resolve(missing), { apiVersion: 1, ok: true, form: 'full', identity: ident(missing, MEMBER, 'codex', SCOPE_M, 'codex', UUID),
    display: { machineName: 'laptop', sourceName: null, providerLabel: null }, location: null, availability: 'not-found' });
  // A local row with the same text does not answer for the member.
  assert.equal(resolve(missing, undefined, { threads: [{ ...codexRow, reference: missing }] }).availability, 'not-found');
  // The self entry of the member list is not a member.
  failed(resolve(full(SELF, 'codex', SCOPE, 'codex', UUID), undefined, { machine: { machineId: OTHER } }), 'unknown-machine');
});

test('a short reference resolves on this machine only and asks for a source when two sources match', () => {
  assert.equal(codexRow.sessionReference, `codex/${UUID}`);
  assert.deepEqual(resolve(codexRow.sessionReference), { apiVersion: 1, ok: true, form: 'short',
    identity: ident(codexRow.reference, SELF, 'codex', SCOPE, 'codex', UUID),
    display: { machineName: 'desk', sourceName: 'codex', providerLabel: 'Codex' }, location: 'local', availability: 'found' });
  assert.equal(resolve(cacheRow.sessionReference).location, 'native-remote-observation');
  const same = { ...workRow, sessionReference: codexRow.sessionReference };
  failed(resolve(codexRow.sessionReference, undefined, { threads: [codexRow, same] }), 'scope-required');
  assert.match(resolve(codexRow.sessionReference, undefined, { threads: [codexRow, same] }).message, /--source/);
  assert.equal(resolve(codexRow.sessionReference, 'work', { threads: [codexRow, same] }).identity.sourceId, 'work');
  failed(resolve(codexRow.sessionReference, undefined, { threads: [codexRow, { ...codexRow, id: 'copy' }] }), 'ambiguous-identity');
  for (const [reference, sourceId] of [[codexRow.sessionReference, 'work'], [`codex/${UUID_2}`, undefined]]) {
    assert.deepEqual(resolve(reference, sourceId), { apiVersion: 1, ok: true, form: 'short', identity: null, display: null, location: null,
      availability: 'not-found' });
  }
  // Member rows are never searched for short text.
  assert.equal(resolve(`codex/${UUID_2}`, undefined, { threads: [{ ...memberFound, sessionReference: `codex/${UUID_2}` }] }).availability, 'not-found');
  // A row with no full reference gives its reason.
  const bare = { ...codexRow, referenceUnavailable: 'no-machine-identity' };
  delete bare.reference;
  assert.deepEqual(resolve(codexRow.sessionReference, undefined, { threads: [bare] }), { apiVersion: 1, ok: true, form: 'short', identity: null,
    display: { machineName: 'desk', sourceName: 'codex', providerLabel: 'Codex' }, location: 'local', availability: 'found',
    referenceUnavailable: 'no-machine-identity' });
});

test('hostile input is refused, and full text is never read as short', () => {
  const trap = { ...codexRow, sessionReference: 'asb:1/x' };
  failed(resolve('asb:1/x', undefined, { threads: [trap] }), 'invalid-reference');
  for (const reference of [undefined, null, 7, {}, [], '', ' ', `codex/${UUID} `, `codex/${UUID}\n`, `../codex/${UUID}`, `codex/${'x'.repeat(400)}`,
    `${codexRow.reference}\n`, `${codexRow.reference}/x`, `asb:1/${SELF}/codex/${SCOPE}/codex:${UUID}?x`, `codex/${UUID}/x`, '__proto__/x']) {
    failed(resolve(reference), 'invalid-reference');
  }
  assert.equal(resolveSessionReference().code, 'invalid-reference');
});
