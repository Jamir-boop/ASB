import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReference, rowReference, shortReference } from '../src/session-references.mjs';
import { bindLocalTarget, bindMemberTarget, memberTarget, notSentMessage, referencesForList, resolveSessionReference } from '../src/session-targets.mjs';

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

// Exact local binding (resolve-bound): a fake io and clock, no files and no processes.
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const UUID_4 = '44444444-4444-4444-8444-444444444444';
const CALLER = '55555555-5555-4555-8555-555555555555';
const MSG = '66666666-6666-4666-8666-666666666666';
const ROOT = '/synthetic/claude/sessions';
const soloRow = local({ provider: 'codex', sourceId: 'codex', externalId: UUID_3 });
const cliRow = local({ provider: 'claude-desktop-code', surface: 'cli', sourceId: 'claude-desktop-code', externalId: UUID_4, providerLabel: 'Claude Code CLI' });
const boundSources = [...sources.map((source) => source.id === 'claude-desktop-code' ? { ...source, projectsDir: '/synthetic/claude/projects' } : source),
  { id: 'claude-2', provider: 'claude-desktop-code', label: 'Claude 2', enabled: false, projectsDir: '/synthetic/other/projects' }];
const boundContext = { ...context, sources: boundSources, tags: new Map([...tags, ['claude-2', SCOPE_M]]),
  threads: [codexRow, workRow, soloRow, cliRow, memberFound, oldRow] };
const record = (pid, sessionId, entrypoint, extra = {}) => ({ pid, procStart: String(pid * 10), sessionId, entrypoint,
  messagingSocketPath: `/synthetic/s/${pid}.sock`, name: SECRET.title, cwd: SECRET.cwd, ...extra });
const callerRecord = record(10, CALLER, 'codex-asb-bridge');
const cliTarget = record(20, UUID_4, 'cli');
const codexTarget = record(30, UUID_3, 'codex-asb-bridge');
const fakeIo = (overrides = {}) => {
  const calls = [];
  const io = { platform: 'linux', pid: 999, now: () => 1_000,
    registry: async (configDir) => { calls.push(['registry', configDir]); return { root: ROOT, records: [callerRecord, cliTarget, codexTarget] }; },
    claudeRoot: async (source) => { calls.push(['claudeRoot', source.id]); return source.id === 'claude-desktop-code' ? ROOT : '/synthetic/other/sessions'; },
    receiverClaim: async (source, appId) => { calls.push(['receiverClaim', source.id, appId]); return { pid: 30, proc_start: '300' }; },
    ...overrides };
  return { io, calls };
};
const bind = async (reference, { io = fakeIo().io, remainingMs = 10_000, pipeProof, ...overrides } = {}) => {
  const result = await bindLocalTarget({ reference, caller: { runtimeSessionId: CALLER, configDir: '/synthetic/claude' }, msgId: MSG, remainingMs, pipeProof },
    { ...boundContext, ...overrides }, io);
  const text = JSON.stringify(result);
  for (const value of [SECRET.title, SECRET.cwd, SECRET.message, SECRET.path]) assert.equal(text.includes(value), false, `${value} must not be in the result`);
  if (!result.ok) for (const value of ['/synthetic/', '"pid"', 'procStart']) assert.equal(text.includes(value), false);
  return result;
};
const records = (list) => fakeIo({ registry: async () => ({ root: ROOT, records: list }) }).io;

test('an exact codex or claude-cli target binds to its live registry record with a capped expiry', async () => {
  const { io, calls } = fakeIo();
  assert.deepEqual(await bind(cliRow.reference, { io }), { apiVersion: 1, ok: true, pid: 999, binding: { registryHome: ROOT, runtimeSessionId: UUID_4,
    pid: 20, procStart: '200', messagingSocketPath: '/synthetic/s/20.sock', msgId: MSG, expiresAtMs: 11_000 } });
  assert.deepEqual(calls, [['registry', '/synthetic/claude'], ['claudeRoot', 'claude-desktop-code'], ['claudeRoot', 'claude-2']]);
  assert.deepEqual((await bind(soloRow.reference)).binding, { registryHome: ROOT, runtimeSessionId: UUID_3, pid: 30, procStart: '300',
    messagingSocketPath: '/synthetic/s/30.sock', msgId: MSG, expiresAtMs: 11_000 });
  assert.equal((await bind(soloRow.reference, { remainingMs: 2_500 })).binding.expiresAtMs, 3_500);
  assert.equal((await bind(soloRow.reference, { remainingMs: 0 })).binding.expiresAtMs, 1_000);
  assert.equal((await bind(soloRow.reference, { remainingMs: 20_000 })).binding.expiresAtMs, 11_000);
});

test('exact binding failures come in check order, and steps 1 to 6 use no io', async () => {
  const { io, calls } = fakeIo();
  const early = async (reference, code, overrides = {}) => failed(await bind(reference, { io, ...overrides }), code);
  await early(`codex/${UUID_3}`, 'invalid-reference');
  await early('asb:1/x', 'invalid-reference');
  await early(`asb:2/${SELF}/codex/${SCOPE}/codex:${UUID_3}`, 'unsupported-reference-version');
  await early(soloRow.reference, 'no-machine-identity', { machine: {} });
  await early(full(OTHER, 'codex', SCOPE, 'codex', UUID_3), 'unknown-machine');
  await early(full(SELF, 'gone', SCOPE, 'codex', UUID_3), 'stale-source');
  await early(full(SELF, 'codex', SCOPE_B, 'codex', UUID_3), 'stale-source-scope');
  await early(soloRow.reference, 'ambiguous-identity', { threads: [soloRow, { ...soloRow, id: 'copy' }] });
  await early(full(OLD, 'codex', SCOPE_M, 'codex', UUID_2), 'peer-upgrade-required');
  await early(memberFound.reference, 'member-target');
  await early(soloRow.reference, 'unsupported-platform', { io: { ...io, platform: 'darwin' } });
  await early(soloRow.reference, 'unsupported-platform', { io: { ...io, platform: 'darwin' }, pipeProof: true });
  await early(full(SELF, 'claude-desktop-code', SCOPE_B, 'claude-local', `local_${UUID_4}`), 'unsupported-type');
  await early(cacheRow.reference, 'unsupported-type');
  await early(full(SELF, 'off', SCOPE, 'codex', UUID_3), 'source-disabled');
  await early(full(SELF, 'codex', SCOPE, 'codex', UUID_4), 'not-found');
  assert.deepEqual(calls, []);

  for (const list of [[], [cliTarget], [record(10, CALLER, 'cli')], [callerRecord, record(11, CALLER, 'codex-asb-bridge')]]) {
    failed(await bind(cliRow.reference, { io: records(list) }), 'caller-unregistered');
  }
  failed(await bind(cliRow.reference, { io: fakeIo({ registry: async () => null }).io }), 'caller-unregistered');
  failed(await bind(codexRow.reference), 'ambiguous-source');
  failed(await bind(cliRow.reference, { io: fakeIo({ claudeRoot: async () => '/synthetic/other/sessions' }).io }), 'native-scope-unavailable');
  failed(await bind(cliRow.reference, { io: fakeIo({ claudeRoot: async () => ROOT }).io }), 'ambiguous-source');
  for (const list of [[callerRecord], [callerRecord, { ...cliTarget, messagingSocketPath: undefined }], [callerRecord, { ...cliTarget, entrypoint: 'asb-relay' }]]) {
    failed(await bind(cliRow.reference, { io: records(list) }), 'not-live');
  }
  failed(await bind(cliRow.reference, { io: records([callerRecord, cliTarget, record(21, UUID_4, 'cli')]) }), 'ambiguous-identity');
  failed(await bind(cliRow.reference, { io: records([callerRecord, { ...cliTarget, entrypoint: 'codex-asb-bridge' }]) }), 'not-mapped');
  failed(await bind(soloRow.reference, { io: records([callerRecord, { ...codexTarget, entrypoint: 'cli' }]) }), 'not-mapped');
  for (const claim of [null, { pid: 31, proc_start: '300' }, { pid: 30, proc_start: '301' }]) {
    failed(await bind(soloRow.reference, { io: fakeIo({ receiverClaim: async () => claim }).io }), 'not-mapped');
  }
});

// Windows: the records have pipe paths and a FILETIME string procStart. The engine binds only for a bridge that proves the pipe.
const pipe = (pid) => `\\\\.\\pipe\\LOCAL\\cc-msg-${String(pid).padStart(32, '0')}`;
const winRecord = (pid, sessionId, entrypoint) => record(pid, sessionId, entrypoint, { procStart: `13300000000000000${pid}`, messagingSocketPath: pipe(pid) });
const winIo = (overrides = {}) => fakeIo({ platform: 'win32', registry: async () => ({ root: ROOT, records: [winRecord(10, CALLER, 'codex-asb-bridge'),
  winRecord(20, UUID_4, 'cli'), winRecord(30, UUID_3, 'codex-asb-bridge')] }),
  receiverClaim: async () => ({ pid: 30, proc_start: '1330000000000000030' }), ...overrides });

test('on Windows an exact local target binds only for a bridge that proves the pipe, after the member check and before any io', async () => {
  assert.deepEqual(await bind(cliRow.reference, { io: winIo().io, pipeProof: true }), { apiVersion: 1, ok: true, pid: 999, binding: { registryHome: ROOT,
    runtimeSessionId: UUID_4, pid: 20, procStart: '1330000000000000020', messagingSocketPath: pipe(20), msgId: MSG, expiresAtMs: 11_000 } });
  assert.equal((await bind(soloRow.reference, { io: winIo().io, pipeProof: true })).binding.messagingSocketPath, pipe(30));
  const { io, calls } = winIo();
  for (const pipeProof of [undefined, false, 'true', 1]) failed(await bind(soloRow.reference, { io, pipeProof }), 'bridge-upgrade-required');
  // An old Windows bridge still reaches send-member.
  failed(await bind(memberFound.reference, { io }), 'member-target');
  failed(await bind('asb:1/x', { io }), 'invalid-reference');
  assert.deepEqual(calls, []);
});

test('on Windows referencesForList binds local items only for a bridge that proves the pipe; remote items stay unsupported', async () => {
  const list = [winRecord(10, CALLER, 'codex-asb-bridge'), winRecord(20, UUID_4, 'cli'), winRecord(30, UUID_3, 'codex-asb-bridge')];
  const listed = [{ machineId: MEMBER, sessionId: UUID_2 }];
  const io = () => winIo({ registry: async () => ({ root: ROOT, records: list }) }).io;
  assert.deepEqual((await listFor(list, { io: io(), listed, pipeProof: true })).result, { apiVersion: 1, ok: true, pid: 999,
    local: [{ sessionId: UUID_4, reference: cliRow.reference }, { sessionId: UUID_3, reference: soloRow.reference }],
    remote: [{ machineId: MEMBER, sessionId: UUID_2, referenceUnavailable: 'unsupported-platform' }] });
  assert.deepEqual((await listFor(list, { io: io(), listed })).result, { apiVersion: 1, ok: true, pid: 999,
    local: [{ sessionId: UUID_4, referenceUnavailable: 'bridge-upgrade-required' }, { sessionId: UUID_3, referenceUnavailable: 'bridge-upgrade-required' }],
    remote: [{ machineId: MEMBER, sessionId: UUID_2, referenceUnavailable: 'unsupported-platform' }] });
  // Member sends stay Linux only until later phases.
  failed(await memberTarget({ reference: memberFound.reference, caller }, boundContext, io()), 'unsupported-platform');
});

// Exact member sends: the sending engine's checks (memberTarget) and the receiving engine's binding (bindMemberTarget).
const caller = { runtimeSessionId: CALLER, configDir: '/synthetic/claude' };
const member = (reference, { io = fakeIo().io, ...overrides } = {}) => memberTarget({ reference, caller }, { ...boundContext, ...overrides }, io);

test('memberTarget checks in order with no io before the caller check, and does not use the cached member rows', async () => {
  const { io, calls } = fakeIo();
  const early = async (reference, code, overrides = {}) => failed(await member(reference, { io, ...overrides }), code);
  await early(`codex/${UUID_2}`, 'invalid-reference');
  await early(7, 'invalid-reference');
  await early('asb:1/x', 'invalid-reference');
  await early(`asb:2/${MEMBER}/codex/${SCOPE_M}/codex:${UUID_2}`, 'unsupported-reference-version');
  await early(memberFound.reference, 'no-machine-identity', { machine: {} });
  await early(full(OTHER, 'codex', SCOPE, 'codex', UUID_2), 'unknown-machine');
  await early(full(OLD, 'codex', SCOPE_M, 'codex', UUID_2), 'peer-upgrade-required');
  await early(soloRow.reference, 'local-target');
  await early(memberFound.reference, 'unsupported-platform', { io: { ...io, platform: 'darwin' } });
  await early(full(MEMBER, 'codex', SCOPE_M, 'claude-local', `local_${UUID_2}`), 'unsupported-type');
  await early(full(MEMBER, 'codex', SCOPE_M, 'opencode', 'abc'), 'unsupported-type');
  assert.deepEqual(calls, []);
  for (const list of [[], [record(10, CALLER, 'cli')], [callerRecord, record(11, CALLER, 'codex-asb-bridge')]]) {
    failed(await member(memberFound.reference, { io: records(list) }), 'caller-unregistered');
  }
  failed(await member(memberFound.reference, { io: fakeIo({ registry: async () => null }).io }), 'caller-unregistered');

  const { io: okIo, calls: okCalls } = fakeIo();
  assert.deepEqual(await member(memberFound.reference, { io: okIo }), { ok: true, identity: ident(memberFound.reference, MEMBER, 'codex', SCOPE_M, 'codex', UUID_2),
    name: SECRET.title, returnTo: { runtimeSessionId: CALLER, pid: 10, procStart: '100', messagingSocketPath: '/synthetic/s/10.sock' } });
  assert.deepEqual(okCalls, [['registry', '/synthetic/claude']]);
  // The member decides not-found and offline, not the cached rows of this engine.
  const missing = full(MEMBER, 'claude-desktop-code', SCOPE_M, 'claude-cli', UUID);
  assert.equal((await member(missing)).ok, true);
  assert.equal((await member(memberFound.reference, { members: [{ ...members[1], online: false }] })).ok, true);
  const named = async (name) => (await member(memberFound.reference, { io: records([{ ...callerRecord, name }]) })).name;
  assert.equal(await named('a\nb\x7fc'), 'a b c');
  assert.equal(await named('x'.repeat(200)), 'x'.repeat(128));
  for (const name of ['', undefined, 7]) assert.equal(await named(name), 'Codex');
});

// list_sessions references: each item is checked like a send, with one caller registry read for the whole list.
const UUID_5 = '77777777-7777-4777-8777-777777777777';
const UUID_6 = '88888888-8888-4888-8888-888888888888';
const UUID_7 = '99999999-9999-4999-8999-999999999999';
const UUID_8 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_9 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_10 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const listFor = async (list, { io, listed = [], pipeProof, ...overrides } = {}) => {
  const fake = io ?? fakeIo({ registry: async (configDir) => { fake.calls.push(['registry', configDir]); return { root: ROOT, records: list }; } });
  const result = await referencesForList({ caller, pipeProof }, { ...boundContext, ...overrides }, fake.io ?? fake, listed);
  const text = JSON.stringify(result);
  for (const value of ['/synthetic/', 'procStart', 'returnTo', 'binding', 'messagingSocketPath', SECRET.title, SECRET.cwd, '"name"']) {
    assert.equal(text.includes(value), false, `${value} must not be in the reply`);
  }
  assert.equal(text.split('"pid"').length, result.ok ? 2 : 1);
  return { result, calls: fake.calls };
};

test('referencesForList gives each listed session its reference or the reason that a send refuses it', async () => {
  const unnamed = { ...local({ provider: 'codex', sourceId: 'codex', externalId: UUID_8 }), referenceUnavailable: 'no-machine-identity' };
  delete unnamed.reference;
  const unknown = { ...local({ provider: 'codex', sourceId: 'codex', externalId: UUID_9 }) };
  delete unknown.reference;
  delete unknown.referenceUnavailable;
  const disabled = local({ provider: 'codex', sourceId: 'off', externalId: UUID_10 });
  const threads = [...boundContext.threads, unnamed, unknown, disabled];
  const list = [callerRecord, cliTarget, codexTarget, record(40, UUID, 'codex-asb-bridge'), record(50, UUID_5, 'cli'), record(60, UUID_6, 'claude-desktop'),
    record(70, UUID_7, 'cli'), record(71, UUID_7, 'cli'), record(80, UUID_8, 'cli'), record(81, UUID_9, 'cli'), record(90, UUID_10, 'cli'),
    record(91, UUID_2, 'asb-relay'), record(92, crypto.randomUUID(), 'cli', { messagingSocketPath: undefined })];
  const listed = [{ machineId: MEMBER, machineName: 'laptop', sessionId: UUID_2, name: SECRET.title }, { machineId: OLD, sessionId: UUID_2 },
    { machineId: MEMBER, sessionId: UUID_3 }, { machineId: MEMBER, sessionId: UUID_2 }];
  const { result, calls } = await listFor(list, { threads, listed });
  assert.deepEqual(result, { apiVersion: 1, ok: true, pid: 999, local: [
    { sessionId: UUID_4, reference: cliRow.reference },
    { sessionId: UUID_3, reference: soloRow.reference },
    { sessionId: UUID, referenceUnavailable: 'ambiguous-source' },
    { sessionId: UUID_5, referenceUnavailable: 'not-found' },
    { sessionId: UUID_6, referenceUnavailable: 'unsupported-type' },
    { sessionId: UUID_7, referenceUnavailable: 'ambiguous-identity' },
    { sessionId: UUID_8, referenceUnavailable: 'no-machine-identity' },
    { sessionId: UUID_9, referenceUnavailable: 'unknown-source' },
    { sessionId: UUID_10, referenceUnavailable: 'source-disabled' },
  ], remote: [
    { machineId: MEMBER, sessionId: UUID_2, reference: memberFound.reference },
    { machineId: OLD, sessionId: UUID_2, referenceUnavailable: 'old-peer' },
    { machineId: MEMBER, sessionId: UUID_3, referenceUnavailable: 'not-found' },
  ] });
  assert.deepEqual(calls.filter(([name]) => name === 'registry'), [['registry', '/synthetic/claude']]);
  // A bind refusal is the reason; two member rows with one ID are ambiguous.
  const scoped = await listFor([callerRecord, cliTarget], { io: fakeIo({ registry: async () => ({ root: ROOT, records: [callerRecord, cliTarget] }),
    claudeRoot: async () => '/synthetic/other/sessions' }) });
  assert.deepEqual(scoped.result.local, [{ sessionId: UUID_4, referenceUnavailable: 'native-scope-unavailable' }]);
  const twice = await listFor([callerRecord], { threads: [memberFound, { ...memberFound, id: 'copy' }], listed: [{ machineId: MEMBER, sessionId: UUID_2 }] });
  assert.deepEqual(twice.result.remote, [{ machineId: MEMBER, sessionId: UUID_2, referenceUnavailable: 'ambiguous-source' }]);
});

test('referencesForList refuses off Linux and Windows or without one caller registration, and caps each list at 256', async () => {
  failed((await listFor([callerRecord], { io: { ...fakeIo().io, platform: 'darwin' } })).result, 'unsupported-platform');
  for (const list of [[], [record(10, CALLER, 'cli')], [callerRecord, record(11, CALLER, 'codex-asb-bridge')]]) {
    failed((await listFor(list)).result, 'caller-unregistered');
  }
  failed((await listFor([], { io: fakeIo({ registry: async () => null }) })).result, 'caller-unregistered');
  const many = Array.from({ length: 300 }, (_, index) => record(100 + index, crypto.randomUUID(), 'cli'));
  const listed = Array.from({ length: 300 }, () => ({ machineId: MEMBER, sessionId: crypto.randomUUID() }));
  const { result, calls } = await listFor([callerRecord, ...many], { listed });
  assert.equal(result.local.length, 256);
  assert.equal(result.remote.length, 256);
  assert.equal(calls.filter(([name]) => name === 'registry').length, 1);
});

const HOME_1 = '/synthetic/h1';
const HOME_2 = '/synthetic/h2';
const homeIo = (homes, overrides = {}) => {
  const calls = [];
  const io = { platform: 'linux', pid: 999, now: () => 1_000,
    targetHomes: async (type, source) => { calls.push(['targetHomes', type, source.id]); return type === 'claude-cli' ? ['/synthetic/claude'] : Object.keys(homes); },
    registry: async (home) => { calls.push(['registry', home]); return homes[home] ? { root: `${home}/sessions`, records: homes[home] } : null; },
    claudeRoot: async (source) => { calls.push(['claudeRoot', source.id]); return source.id === 'claude-desktop-code' ? ROOT : '/synthetic/other/sessions'; },
    receiverClaim: async (source, appId) => { calls.push(['receiverClaim', source.id, appId]); return { pid: 30, proc_start: '300' }; },
    ...overrides };
  return { io, calls };
};
const bindMember = (reference, io, overrides = {}) => bindMemberTarget({ reference, msgId: MSG, remainingMs: 10_000 }, { ...boundContext, ...overrides }, io);

test('bindMemberTarget binds in the homes of the target source only, with no caller registry', async () => {
  const { io, calls } = homeIo({ [HOME_1]: [cliTarget], [HOME_2]: [codexTarget] });
  assert.deepEqual(await bindMember(soloRow.reference, io), { apiVersion: 1, ok: true, pid: 999, binding: { registryHome: `${HOME_2}/sessions`,
    runtimeSessionId: UUID_3, pid: 30, procStart: '300', messagingSocketPath: '/synthetic/s/30.sock', msgId: MSG, expiresAtMs: 11_000 } });
  assert.deepEqual(calls, [['targetHomes', 'codex', 'codex'], ['registry', HOME_1], ['registry', HOME_2], ['receiverClaim', 'codex', UUID_3]]);
  failed(await bindMember(soloRow.reference, homeIo({ [HOME_1]: [codexTarget], [HOME_2]: [{ ...codexTarget, pid: 31 }] }).io), 'ambiguous-identity');
  // A CLI session counts only in its own source home: the record in another home is not live for it.
  const cli = homeIo({ '/synthetic/claude': [], [HOME_1]: [cliTarget] });
  failed(await bindMember(cliRow.reference, cli.io), 'not-live');
  assert.deepEqual(cli.calls.slice(0, 2), [['targetHomes', 'claude-cli', 'claude-desktop-code'], ['registry', '/synthetic/claude']]);
  const bound = await bindMember(cliRow.reference, homeIo({ '/synthetic/claude': [cliTarget] }, { claudeRoot: async (source) =>
    source.id === 'claude-desktop-code' ? '/synthetic/claude/sessions' : '/synthetic/other/sessions' }).io);
  assert.equal(bound.binding.registryHome, '/synthetic/claude/sessions');
  failed(await bindMember(soloRow.reference, homeIo({}).io), 'not-live');
  // The binder's own checks: another machine, the 5a refusals, and the resolver failures pass through.
  failed(await bindMember(memberFound.reference, io), 'unknown-machine');
  failed(await bindMember(full(SELF, 'gone', SCOPE, 'codex', UUID_3), io), 'stale-source');
  failed(await bindMember(soloRow.reference, { ...io, platform: 'win32' }), 'unsupported-platform');
  failed(await bindMember(full(SELF, 'off', SCOPE, 'codex', UUID_3), io), 'source-disabled');
  failed(await bindMember(full(SELF, 'codex', SCOPE, 'codex', UUID_4), io), 'not-found');
  failed(await bindMember(cacheRow.reference, io), 'unsupported-type');
  failed(await bindMember(codexRow.reference, io), 'ambiguous-source');
});

test('every code has a not-sent message that ends with a period and has no em dash', () => {
  for (const code of ['invalid-reference', 'unsupported-reference-version', 'scope-mismatch', 'scope-required', 'no-machine-identity', 'unknown-machine',
    'stale-source', 'stale-source-scope', 'ambiguous-identity', 'evidence-incomplete', 'member-target', 'peer-upgrade-required', 'local-target',
    'unsupported-platform', 'unsupported-type', 'source-disabled', 'not-found', 'caller-unregistered', 'native-scope-unavailable', 'ambiguous-source',
    'not-live', 'not-mapped', 'machine-offline', 'capability-unknown', 'refused', 'too-large', 'rate-limited', 'target-unavailable',
    'relay-unavailable', 'binding-expired', 'target-changed', 'invalid-request', 'bridge-upgrade-required']) {
    assert.match(notSentMessage(code) ?? '', /^[^—]+\.$/, code);
  }
  assert.equal(notSentMessage('remote-exact-unsupported'), undefined);
});
