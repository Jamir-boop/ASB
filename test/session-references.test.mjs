import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatReference, parseReference, referenceType, rowReference, scopeInput, shortReference,
  MAX_REFERENCE_BYTES } from '../src/session-references.mjs';
import { X509Certificate } from 'node:crypto';
import { createPhoneGateway, referenceScopeTagger } from '../src/phone-gateway.mjs';
import { createSwitchboardServer } from '../src/switchboard.mjs';

// Synthetic data only. Platform-neutral (test/windows-tests.json).
const MACHINE = '0123456789abcdef';
const SCOPE = '0123456789abcdef0123456789abcdef';
const UUID = '11111111-1111-4111-8111-111111111111';
const MIXED = 'AbCdEf12-1111-4111-8111-11111111ABCD';
const base = { machineId: MACHINE, sourceId: 'claude-desktop-code', scopeTag: SCOPE };
const full = (type, appId, extra = {}) => formatReference({ ...base, type, appId, ...extra });
const valid = `asb:1/${MACHINE}/claude-desktop-code/${SCOPE}/claude-local:local_${UUID}`;
const rejects = (text, code = 'invalid-reference') => assert.throws(() => parseReference(text), { code }, JSON.stringify(text));

// A public test certificate (ECDSA P-256, CN=ASB); its key was never kept. Also in test/asb-windows.test.mjs.
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBcDCCARegAwIBAgIUa75tBDagtiNnzswuvkNenDyZam8wCgYIKoZIzj0EAwIw
DjEMMAoGA1UEAwwDQVNCMB4XDTI2MTAxOTIyMDk0MloXDTM2MTAxNjIyMDk0Mlow
DjEMMAoGA1UEAwwDQVNCMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBnv2adjy
E5xiemjlkkHBWDc1rb4tEp6WSiZIz33o4T1x/oM8691hTH2cdSgSbUCNfq5OGkuq
vPZhSyHx/MRZYaNTMFEwHQYDVR0OBBYEFJ6G+IaJLC16DI4dNAYZe8kPBn9xMB8G
A1UdIwQYMBaAFJ6G+IaJLC16DI4dNAYZe8kPBn9xMA8GA1UdEwEB/wQFMAMBAf8w
CgYIKoZIzj0EAwIDRwAwRAIgLJWkR3KJN4g9UaVPW/DfqdUJ4TyJRzElxFETUQs+
7AgCIE5wuN7QJUCEfR0+85UWBxtlxYomM4DMylMm8YLcwfbM
-----END CERTIFICATE-----
`;
const SYNTHETIC_KEY = 'synthetic key material for tests only\n';

async function folder(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-refs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('every type formats and parses back with the app ID kept exactly', () => {
  const cases = [['codex', UUID], ['codex', MIXED], ['claude-local', `local_${UUID}`], ['claude-local', `local_${MIXED}`],
    ['claude-cli', UUID], ['claude-remote', 'cse_AbC-1_x'], ['claude-remote', 'session_Tok'], ['opencode', 'ses_Abc-09_z']];
  for (const [type, appId] of cases) {
    const text = full(type, appId);
    assert.equal(text, `asb:1/${MACHINE}/claude-desktop-code/${SCOPE}/${type}:${appId}`);
    assert.deepEqual(parseReference(text), { version: 1, ...base, type, appId });
  }
  assert.equal(parseReference(valid).appId, `local_${UUID}`);
  assert.equal(parseReference(full('codex', MIXED)).appId, MIXED, 'case is kept');
  assert.equal(parseReference(full('claude-remote', 'cse_Tok')).appId, 'cse_Tok', 'cse_ stays cse_');
});

test('hostile and malformed full text is refused with a stable code', () => {
  const swap = (from, to) => valid.replace(from, to);
  for (const text of [
    '', ' ', `${valid} `, ` ${valid}`, `${valid}\n`, `${valid}\r`, swap('/claude-local', '/ claude-local'), `${valid}\tx`,
    swap(`local_${UUID}`, `local_${UUID}\u0000`), swap('claude-desktop-code', 'claude%2Ddesktop'), `${valid}?x=1`, `${valid}#frag`,
    swap('claude-desktop-code', '..'), swap('claude-desktop-code', 'a\\b'), swap('claude-desktop-code', 'a/../b'), `${valid}/extra`,
    swap('/claude-local', '//claude-local'), `${valid}:extra`, swap(MACHINE, MACHINE.toUpperCase()), swap(MACHINE, MACHINE.slice(1)),
    swap(SCOPE, SCOPE.toUpperCase()), swap(SCOPE, `${SCOPE}0`), swap('claude-desktop-code', 'Claude'), swap('claude-desktop-code', '-x'),
    swap('claude-local:', 'claude-other:'), swap('claude-local:', 'claude-cli:'), swap('claude-local:', ':'), swap('claude-local:', 'claude-local'),
    swap(`local_${UUID}`, UUID), swap(`local_${UUID}`, `local_${UUID}x`), full('codex', UUID).replace(UUID, UUID.replaceAll('-', '')),
    full('claude-remote', 'cse_A').replace('cse_A', 'cse_'), full('claude-remote', 'cse_A').replace('cse_A', 'other_A'),
    full('claude-remote', 'cse_A').replace('cse_A', `cse_${'a'.repeat(129)}`), full('opencode', 'a').replace(':a', ':a.b'),
    full('opencode', 'a').replace(':a', ':'), valid.replace('asb:', 'ASB:'), valid.replace('asb:', 'asb://'), valid.slice(4),
    'claude-desktop-code/local_' + UUID, `asb:1/${MACHINE}/x/${SCOPE}/claude-local:local_${UUID}é`,
    swap('/claude-local', '/ claude-local'), swap('/claude-local', '/constructor'), `asb:1/${MACHINE}/x/${SCOPE}/__proto__:a`,
  ]) rejects(text);
  for (const value of [null, undefined, 1, {}, ['asb:1']]) rejects(value);
  rejects(valid.replace('asb:1/', 'asb:2/'), 'unsupported-reference-version');
  rejects(valid.replace('asb:1/', 'asb:10/'), 'unsupported-reference-version');
  rejects(valid.replace('asb:1/', 'asb:01/'), 'unsupported-reference-version');
  rejects(valid.replace('asb:1/', 'asb:v1/'));
  rejects(valid.replace('asb:1/', 'asb:/'));
  assert.throws(() => full('claude-local', `local_${UUID}/x`), { code: 'invalid-reference' });
  assert.throws(() => formatReference({ ...base, sourceId: 'a/b', type: 'codex', appId: UUID }), { code: 'invalid-reference' });
  assert.throws(() => formatReference({ ...base, type: 'codex' }), { code: 'invalid-reference' });
});

test('the full form has a 384-byte limit', () => {
  // The longest text that the grammar allows is shorter than the limit; the limit refuses longer input before the parse.
  const longest = `asb:1/${MACHINE}/${'s'.repeat(80)}/${SCOPE}/claude-remote:session_${'a'.repeat(128)}`;
  assert.ok(longest.length < MAX_REFERENCE_BYTES);
  assert.equal(parseReference(longest).appId.length, 136);
  const padded = (bytes) => `asb:1/${MACHINE}/s/${SCOPE}/opencode:${'a'.repeat(bytes - 67)}`;
  assert.equal(padded(MAX_REFERENCE_BYTES).length, MAX_REFERENCE_BYTES);
  rejects(padded(MAX_REFERENCE_BYTES));
  rejects(padded(MAX_REFERENCE_BYTES + 1));
  rejects(`${valid}${'a'.repeat(MAX_REFERENCE_BYTES)}`);
  assert.equal(MAX_REFERENCE_BYTES, 384);
});

test('the row type comes from the checked provider, surface, cache flag, and ID form', () => {
  const row = (provider, externalId, extra = {}) => ({ provider, externalId, surface: 'app', remoteCache: false, ...extra });
  assert.equal(referenceType(row('codex', UUID)), 'codex');
  assert.equal(referenceType(row('codex', UUID, { surface: 'cli' })), 'codex');
  assert.equal(referenceType(row('claude-desktop-code', `local_${UUID}`)), 'claude-local');
  assert.equal(referenceType(row('claude-desktop-code', UUID, { surface: 'cli' })), 'claude-cli');
  assert.equal(referenceType(row('claude-desktop-code', 'session_Tok', { remoteCache: true })), 'claude-remote');
  assert.equal(referenceType(row('opencode', 'ses_1')), 'opencode');
  for (const value of [row('codex', 'x'), row('claude-desktop-code', UUID), row('claude-desktop-code', `local_${UUID}`, { surface: 'cli' }),
    row('claude-desktop-code', 'session_Tok'), row('claude-desktop-code', `local_${UUID}`, { remoteCache: true }),
    row('claude-desktop-code', `local_${UUID}`, { surface: 'other' }), row('other', UUID), row('opencode', 'a b'), row('codex', undefined),
    null, {}]) assert.equal(referenceType(value), null, JSON.stringify(value));
});

test('a row reference gives the full text or one reason', () => {
  const row = { provider: 'codex', surface: 'app', externalId: UUID };
  assert.deepEqual(rowReference(row, { ...base, sourceId: 'codex' }), { reference: `asb:1/${MACHINE}/codex/${SCOPE}/codex:${UUID}` });
  assert.deepEqual(rowReference(row, { ...base, machineId: '' }), { referenceUnavailable: 'no-machine-identity' });
  assert.deepEqual(rowReference(row, { ...base, sourceId: '' }), { referenceUnavailable: 'unknown-source' });
  assert.deepEqual(rowReference(row, { ...base, sourceId: undefined }), { referenceUnavailable: 'unknown-source' });
  assert.deepEqual(rowReference(row, { ...base, scopeTag: undefined }, 'old-peer'), { referenceUnavailable: 'old-peer' });
  assert.deepEqual(rowReference({ ...row, externalId: 'x' }, base), { referenceUnavailable: 'invalid-app-id' });
  assert.deepEqual(rowReference({ ...row, provider: 'other' }, base), { referenceUnavailable: 'unsupported-type' });
});

test('the short reference is the text that the board copies, only when it is one safe line', () => {
  assert.equal(shortReference({ provider: 'claude-desktop-code', surface: 'app', externalId: `local_${UUID}`, sourceName: 'claude-personal' }),
    `claude-personal/local_${UUID}`);
  assert.equal(shortReference({ provider: 'claude-desktop-code', surface: 'app', externalId: `local_${UUID}` }), `claude-desktop-code/local_${UUID}`);
  assert.equal(shortReference({ provider: 'codex', surface: 'cli', externalId: MIXED }), `codex/${MIXED}`);
  assert.equal(shortReference({ provider: 'opencode', surface: 'app', externalId: 'ses_1' }), 'opencode/ses_1');
  assert.equal(shortReference({ provider: 'claude-desktop-code', surface: 'app', remoteCache: true, externalId: 'cse_Tok' }),
    'claude-desktop-code/cse_Tok');
  for (const row of [
    { provider: 'codex', externalId: `${UUID}\n` }, { provider: 'codex', externalId: 'not-an-id' }, { provider: 'other', externalId: UUID },
    { provider: 'codex', externalId: UUID, sourceName: 'a\u0007b' }, { provider: 'codex', externalId: UUID, sourceName: 'a\nb' },
    { provider: 'codex', externalId: UUID, sourceName: 'a b' }, { provider: 'codex', externalId: UUID, sourceName: 'x'.repeat(400) },
    { provider: 'codex', externalId: UUID, sourceName: 'café' },
  ]) assert.equal(shortReference({ surface: 'app', ...row }), null, JSON.stringify(row));
  // Full text is never read as the short form.
  assert.throws(() => parseReference(`claude-personal/local_${UUID}`), { code: 'invalid-reference' });
  assert.throws(() => parseReference(`${valid}x`), { code: 'invalid-reference' });
});

test('the scope input is unambiguous and uses the effective Claude default', () => {
  const claude = (dataDir, projectsDir) => ({ provider: 'claude-desktop-code', dataDir, projectsDir });
  const inputs = [claude('/a', '/b/c'), claude('/a/b', '/c'), claude('/a,b', '/c'), claude('/a', 'b,/c'), claude('/a"', '/b'), claude('/a', '"/b'),
    { provider: 'codex', dataDir: '/a' }, { provider: 'opencode', dataDir: '/a' }, claude('/a', '/b')];
  assert.equal(new Set(inputs.map(scopeInput)).size, inputs.length);
  for (const input of inputs) {
    const [domain, version, provider, dataDir, projects] = JSON.parse(scopeInput(input));
    assert.deepEqual([domain, version, provider, dataDir], ['asb-session-reference-scope', 1, input.provider, input.dataDir]);
    assert.equal(projects, input.provider === 'claude-desktop-code' ? input.projectsDir : '');
  }
  assert.equal(scopeInput(claude('/a')), scopeInput(claude('/a', path.join(os.homedir(), '.claude', 'projects'))));
  assert.equal(scopeInput({ provider: 'codex', dataDir: '/a', projectsDir: '/x' }), scopeInput({ provider: 'codex', dataDir: '/a' }));
});

test('scope tags follow the configured folders and the identity, and hold no secret or path', async (t) => {
  const directory = await folder(t);
  const projects = path.join(directory, 'projects');
  const source = { id: 'claude-x', provider: 'claude-desktop-code', label: 'Claude X', dataDir: path.join(directory, 'app'), projectsDir: projects };
  await mkdir(source.dataDir);
  await writeFile(path.join(source.dataDir, 'store.db'), 'first');
  for (const secret of [Buffer.from(SYNTHETIC_KEY), 'a'.repeat(64)]) {
    const tag = referenceScopeTagger(secret);
    const first = tag(source);
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.equal(tag({ ...source, label: 'Renamed' }), first, 'a label rename keeps the tag');
    assert.notEqual(tag({ ...source, dataDir: path.join(directory, 'other') }), first);
    assert.notEqual(tag({ ...source, projectsDir: path.join(directory, 'other') }), first);
    assert.notEqual(tag({ ...source, provider: 'codex' }), first);
    // A replaced database file (new inode, same paths) keeps the tag.
    await rm(path.join(source.dataDir, 'store.db'));
    await writeFile(path.join(source.dataDir, 'store.db'), 'second');
    assert.equal(tag(source), first);
    const defaults = { ...source, projectsDir: undefined };
    assert.equal(tag(defaults), tag({ ...source, projectsDir: path.join(os.homedir(), '.claude', 'projects') }));
    assert.notEqual(referenceScopeTagger(Buffer.from(`${SYNTHETIC_KEY}x`))(source), first);
    assert.notEqual(referenceScopeTagger('b'.repeat(64))(source), first);
    for (const part of [directory, 'projects', String(secret).slice(0, 16)]) assert.ok(!first.includes(part));
  }
  assert.notEqual(referenceScopeTagger(Buffer.from(SYNTHETIC_KEY))(source), referenceScopeTagger('a'.repeat(64))(source));
  assert.throws(() => referenceScopeTagger(''));
  assert.throws(() => referenceScopeTagger(Buffer.alloc(0)));
});

test('the gateway keys scope tags with the identity secret it already loads, on Linux and Windows', async (t) => {
  const directory = await folder(t);
  const source = { provider: 'codex', dataDir: '/synthetic/codex' };
  // Linux: the private key PEM bytes. The files exist, so nothing makes a certificate.
  const linuxTls = path.join(directory, 'linux-tls');
  await mkdir(linuxTls);
  await writeFile(path.join(linuxTls, 'key.pem'), SYNTHETIC_KEY);
  await writeFile(path.join(linuxTls, 'cert.pem'), CERTIFICATE);
  const linux = createPhoneGateway({ localPort: 4629, platform: 'linux', tlsDir: linuxTls, openssl: '/nonexistent/openssl',
    settingsPath: path.join(directory, 'linux.json') });
  const linuxTag = await linux.referenceScopes();
  assert.equal(linuxTag(source), referenceScopeTagger(Buffer.from(SYNTHETIC_KEY))(source));
  assert.equal(await readFile(path.join(linuxTls, 'key.pem'), 'utf8'), SYNTHETIC_KEY, 'the key stays the same');
  // Windows: the PFX passphrase.
  const windowsTls = path.join(directory, 'windows-tls');
  await mkdir(windowsTls);
  await writeFile(path.join(windowsTls, 'cert.pfx'), 'synthetic pfx');
  await writeFile(path.join(windowsTls, 'pfx-pass'), 'c'.repeat(64));
  await writeFile(path.join(windowsTls, 'cert.cer'), new X509Certificate(CERTIFICATE).raw);
  const calls = [];
  const windows = createPhoneGateway({ localPort: 4629, platform: 'win32', tlsDir: windowsTls, settingsPath: path.join(directory, 'win.json'),
    execFile: async (...args) => { calls.push(args); return { stdout: '' }; } });
  const windowsTag = await windows.referenceScopes();
  assert.equal(windowsTag(source), referenceScopeTagger('c'.repeat(64))(source));
  assert.equal(calls.length, 0, 'no new certificate');
  // No identity gives no tag function.
  const missing = createPhoneGateway({ localPort: 4629, platform: 'win32', tlsDir: path.join(directory, 'none'),
    settingsPath: path.join(directory, 'none.json'), execFile: async () => { throw new Error('PowerShell failed'); } });
  assert.equal(await missing.referenceScopes(), null);
});

test('the server adds the reference fields to local rows and keeps the row IDs', async (t) => {
  const sources = [
    { id: 'codex', provider: 'codex', label: 'Codex', dataDir: '/synthetic/codex', enabled: true, builtin: true, launcher: '' },
    { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude Desktop Code', dataDir: '/synthetic/claude',
      projectsDir: '/synthetic/projects', enabled: true, builtin: true, launcher: '' },
    { id: 'opencode', provider: 'opencode', label: 'OpenCode', dataDir: '/synthetic/opencode', enabled: true, builtin: true, launcher: '' },
  ];
  const tag = referenceScopeTagger('d'.repeat(64));
  const claude = (id, externalId, extra = {}) => ({ id, externalId, provider: 'claude-desktop-code', surface: 'app', sourceId: 'claude-desktop-code',
    sourceName: 'claude-desktop-code', remoteCache: false, remote: false, state: 'idle', ...extra });
  const rows = () => [
    { id: UUID, externalId: UUID, provider: 'codex', surface: 'cli', sourceId: 'codex', sourceName: 'codex', state: 'idle' },
    claude(`claude-desktop-code:local_${UUID}`, `local_${UUID}`),
    claude(`claude-desktop-code:${UUID}`, UUID, { surface: 'cli' }),
    claude('claude-desktop-code:cse_Tok', 'cse_Tok', { remoteCache: true }),
    { id: 'opencode:ses_1', externalId: 'ses_1', provider: 'opencode', surface: 'app', sourceId: 'opencode', sourceName: 'opencode', state: 'idle' },
    claude('claude-desktop-code:bad', 'bad id'),
    claude('gone:x', `local_${UUID}`, { sourceId: 'gone' }),
    { id: 'other:1', externalId: UUID, provider: 'other', surface: 'app', sourceId: 'codex', state: 'idle' },
    { id: `m:${'e'.repeat(16)}:x`, externalId: UUID, provider: 'codex', surface: 'app', sourceId: 'codex', remote: true, state: 'idle' },
  ];
  let identity = { machineId: MACHINE, machineName: 'synthetic' };
  const start = async (options) => {
    const server = createSwitchboardServer({ pendingStatePath: false, dashboardWatchPaths: [],
      sourceRegistry: { read: async () => sources, report: async () => [], warning: '' },
      loadDashboard: async () => ({ providers: [], threads: rows() }), ...options });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    return async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard?force=1`)).json();
  };
  const managed = await start({ machineIdentity: () => identity, referenceScopes: () => tag });
  const board = await managed();
  const byId = new Map(board.threads.map((row) => [row.id, row]));
  assert.deepEqual(board.threads.map((row) => row.id), rows().map((row) => row.id), 'the row IDs stay the same');
  const scope = (id) => tag(sources.find((source) => source.id === id));
  assert.equal(byId.get(UUID).reference, `asb:1/${MACHINE}/codex/${scope('codex')}/codex:${UUID}`);
  assert.equal(byId.get(`claude-desktop-code:local_${UUID}`).reference,
    `asb:1/${MACHINE}/claude-desktop-code/${scope('claude-desktop-code')}/claude-local:local_${UUID}`);
  assert.equal(byId.get(`claude-desktop-code:${UUID}`).reference,
    `asb:1/${MACHINE}/claude-desktop-code/${scope('claude-desktop-code')}/claude-cli:${UUID}`);
  assert.equal(byId.get('claude-desktop-code:cse_Tok').reference,
    `asb:1/${MACHINE}/claude-desktop-code/${scope('claude-desktop-code')}/claude-remote:cse_Tok`);
  assert.equal(byId.get('opencode:ses_1').reference, `asb:1/${MACHINE}/opencode/${scope('opencode')}/opencode:ses_1`);
  assert.equal(byId.get(UUID).referenceScope, scope('codex'));
  assert.equal(byId.get(UUID).sessionReference, `codex/${UUID}`);
  assert.equal(byId.get('claude-desktop-code:cse_Tok').sessionReference, 'claude-desktop-code/cse_Tok');
  assert.equal(byId.get('claude-desktop-code:bad').referenceUnavailable, 'invalid-app-id');
  assert.equal('sessionReference' in byId.get('claude-desktop-code:bad'), false);
  assert.equal(byId.get('gone:x').referenceUnavailable, 'unknown-source');
  assert.equal('referenceScope' in byId.get('gone:x'), false);
  assert.equal(byId.get('other:1').referenceUnavailable, 'unsupported-type');
  const remote = byId.get(`m:${'e'.repeat(16)}:x`);
  assert.deepEqual(['reference', 'referenceUnavailable', 'referenceScope', 'sessionReference'].filter((key) => key in remote), []);
  for (const row of board.threads) assert.ok(!JSON.stringify(row).includes('/synthetic/'), 'no folder in a row');
  // A label rename keeps the reference; a folder edit changes it.
  sources[0] = { ...sources[0], label: 'Codex renamed' };
  assert.equal((await managed()).threads[0].reference, byId.get(UUID).reference);
  sources[0] = { ...sources[0], dataDir: '/synthetic/codex-2' };
  assert.notEqual((await managed()).threads[0].reference, byId.get(UUID).reference);
  // The npm start server has no machine identity.
  const plain = await (await start({}))();
  assert.ok(plain.threads.filter((row) => !row.remote).every((row) => row.referenceUnavailable === 'no-machine-identity' && !row.reference));
  assert.equal(plain.threads.find((row) => row.id === UUID).sessionReference, `codex/${UUID}`);
  const untagged = await (await start({ machineIdentity: () => identity, referenceScopes: () => null }))();
  assert.equal(untagged.threads[0].referenceUnavailable, 'no-machine-identity');
  identity = { machineId: '', machineName: 'synthetic' };
  assert.equal((await managed()).threads[0].referenceUnavailable, 'no-machine-identity');
});
