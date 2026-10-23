import { test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineRequest, engineRuntime, listReferences, remotePeers } from '../src/engine';
import { ENGINE_TOKEN, fakeEngine } from './engine-fixture';
// POSIX only on Windows CI: /tmp and file modes.
const posix = test.skipIf(process.platform === 'win32');

const good = { pid: process.pid, port: 4659, schema: 1 as const, sourceToken: ENGINE_TOKEN };

posix('the engine runtime needs a private folder, a 0600 file with exactly its keys, and a live PID', () => {
  const root = mkdtempSync('/tmp/asb-engine-runtime-');
  const env = { XDG_RUNTIME_DIR: root };
  const file = join(root, 'asb', 'service.json');
  const write = (value: unknown, mode = 0o600) => { writeFileSync(file, JSON.stringify(value), { mode }); chmodSync(file, mode); };
  try {
    expect(engineRuntime(env, 'linux')).toBeNull();
    mkdirSync(join(root, 'asb'), { mode: 0o700 });
    expect(engineRuntime(env, 'linux')).toBeNull();
    write(good);
    expect(engineRuntime(env, 'linux')).toEqual(good);
    write(good, 0o644);
    expect(engineRuntime(env, 'linux')).toBeNull();
    for (const value of [{ ...good, extra: 1 }, { ...good, schema: 2 }, { ...good, port: 0 }, { ...good, sourceToken: 'E'.repeat(64) },
      { ...good, pid: 2147483647 }, { ...good, pid: -1 }, 'not an object']) {
      write(value);
      expect(engineRuntime(env, 'linux')).toBeNull();
    }
    writeFileSync(file, '{');
    expect(engineRuntime(env, 'linux')).toBeNull();
    write(good);
    chmodSync(join(root, 'asb'), 0o755);
    expect(engineRuntime(env, 'linux')).toBeNull();
    chmodSync(join(root, 'asb'), 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

posix('without a valid runtime folder the engine runtime is in the state folder: XDG_STATE_HOME when absolute, else HOME', () => {
  const root = mkdtempSync('/tmp/asb-engine-state-');
  const runtime = join(root, 'runtime');
  const write = (folder: string) => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, 'service.json'), JSON.stringify(good), { mode: 0o600 });
  };
  try {
    mkdirSync(runtime, { mode: 0o700 });
    const env = { XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: join(root, 'state') };
    expect(engineRuntime(env, 'linux')).toBeNull();
    write(join(root, 'state', 'asb', 'run'));
    expect(engineRuntime(env, 'linux')).toEqual(good);
    // A runtime folder that fails a check gives the next candidate; a valid one comes first.
    write(join(runtime, 'asb'));
    chmodSync(join(runtime, 'asb', 'service.json'), 0o644);
    expect(engineRuntime(env, 'linux')).toEqual(good);
    writeFileSync(join(runtime, 'asb', 'service.json'), JSON.stringify({ ...good, port: 4660 }), { mode: 0o600 });
    chmodSync(join(runtime, 'asb', 'service.json'), 0o600);
    expect(engineRuntime(env, 'linux')).toEqual({ ...good, port: 4660 });
    rmSync(join(runtime, 'asb'), { recursive: true });
    chmodSync(join(root, 'state', 'asb', 'run'), 0o755);
    expect(engineRuntime(env, 'linux')).toBeNull();
    // A relative XDG_STATE_HOME gives HOME/.local/state.
    write(join(root, '.local', 'state', 'asb', 'run'));
    expect(engineRuntime({ XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: 'relative', HOME: root }, 'linux')).toEqual(good);
    expect(engineRuntime({ XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: 'relative', HOME: 'relative' }, 'linux')).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('on Windows the engine runtime is LOCALAPPDATA\\asb\\run\\service.json with exactly its keys and a live PID; macOS has none', () => {
  const root = mkdtempSync(join(tmpdir(), 'asb-engine-windows-'));
  const env = { LOCALAPPDATA: root };
  const file = join(root, 'asb', 'run', 'service.json');
  try {
    expect(engineRuntime(env, 'win32')).toBeNull();
    mkdirSync(join(root, 'asb', 'run'), { recursive: true });
    writeFileSync(file, JSON.stringify(good));
    expect(engineRuntime(env, 'win32')).toEqual(good);
    for (const other of [{}, { LOCALAPPDATA: 'relative' }, { LOCALAPPDATA: '' }]) expect(engineRuntime(other, 'win32')).toBeNull();
    expect(engineRuntime({ ...env, XDG_RUNTIME_DIR: root }, 'darwin')).toBeNull();
    for (const value of [{ ...good, extra: 1 }, { ...good, pid: 2147483646 }]) {
      writeFileSync(file, JSON.stringify(value));
      expect(engineRuntime(env, 'win32')).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

posix('engine requests send the source token, the local Host, Origin and JSON on POST, and refuse other replies', async () => {
  const root = mkdtempSync('/tmp/asb-engine-request-');
  let answer: unknown = { peers: [] };
  const engine = fakeEngine(root, () => answer);
  try {
    const runtime = engineRuntime({ XDG_RUNTIME_DIR: root }, 'linux')!;
    const origin = `http://127.0.0.1:${runtime.port}`;
    expect(await engineRequest(runtime, '/api/relay/homes')).toEqual({ peers: [] });
    await engineRequest(runtime, '/api/relay/send', { method: 'POST', body: { a: 1 } });
    const [get, post] = engine.calls;
    expect([get!.method, get!.headers['x-asb-source-token'], get!.headers.host, get!.headers.origin]).toEqual(['GET', ENGINE_TOKEN, `127.0.0.1:${runtime.port}`, undefined]);
    expect([post!.method, post!.headers['x-asb-source-token'], post!.headers.origin, post!.headers['content-type'], post!.body])
      .toEqual(['POST', ENGINE_TOKEN, origin, 'application/json', { a: 1 }]);
    answer = new Response('{}', { status: 403 });
    await expect(engineRequest(runtime, '/api/relay/homes')).rejects.toThrow('HTTP 403');
    answer = new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1/' } });
    await expect(engineRequest(runtime, '/api/relay/homes')).rejects.toThrow();
    answer = new Response('x'.repeat(1024 * 1024 + 1));
    await expect(engineRequest(runtime, '/api/relay/homes')).rejects.toThrow('too large');
    answer = new Promise(resolve => setTimeout(() => resolve({}), 500));
    await expect(engineRequest(runtime, '/api/relay/homes', { timeoutMs: 50 })).rejects.toThrow();
    const peer = { machineId: 'b'.repeat(16), machineName: 'beta', online: true, sessionId: crypto.randomUUID(), name: 'task', agent: 'codex', status: 'idle', remoteControl: false };
    answer = { peers: [peer, { ...peer, online: false }, { ...peer, machineName: '' }, { ...peer, agent: 'opencode' }, { ...peer, status: 's'.repeat(33) }, ...Array(300).fill(peer)] };
    const listed = await remotePeers(runtime);
    expect(listed).toHaveLength(256);
    expect(listed[0]).toEqual({ machineId: peer.machineId, machineName: 'beta', online: true, sessionId: peer.sessionId, name: 'task', agent: 'codex', status: 'idle' });
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});

posix('listReferences posts the caller and keeps only valid items, keyed by sessionId or machineId:sessionId', async () => {
  const root = mkdtempSync('/tmp/asb-engine-references-');
  let answer: unknown;
  const engine = fakeEngine(root, () => answer);
  const local = crypto.randomUUID();
  const remote = crypto.randomUUID();
  const machineId = 'b'.repeat(16);
  const reference = `asb:1/${'a'.repeat(16)}/codex/${'ab'.repeat(16)}/codex:${local}`;
  const caller = { runtimeSessionId: crypto.randomUUID(), configDir: '/synthetic/claude' };
  const reply = (fields: Record<string, unknown> = {}) => ({ apiVersion: 1, ok: true, pid: process.pid,
    local: [{ sessionId: local, reference }], remote: [{ machineId, sessionId: remote, referenceUnavailable: 'old-peer' }], ...fields });
  try {
    const runtime = engineRuntime({ XDG_RUNTIME_DIR: root }, 'linux')!;
    answer = reply();
    expect([...await listReferences(runtime, caller)]).toEqual([[local, { reference }], [`${machineId}:${remote}`, { referenceUnavailable: 'old-peer' }]]);
    expect(engine.calls[0]).toMatchObject({ method: 'POST', route: '/api/agent/list-references' });
    expect(engine.calls[0]!.body).toEqual({ caller, hostCheck: true });
    // A wrong pid, a refusal, another shape, or an engine error: an empty map.
    for (const value of [reply({ pid: process.pid + 1 }), { apiVersion: 1, ok: false, code: 'caller-unregistered', message: 'x.' }, reply({ extra: 1 }),
      reply({ apiVersion: 2 }), { ...reply(), local: undefined }, new Response('{}', { status: 500 }), new Response('{')]) {
      answer = value;
      expect((await listReferences(runtime, caller)).size).toBe(0);
    }
    // Invalid items are dropped: an extra key, both or none of the two fields, a bad reference or reason, a bad ID.
    answer = reply({ local: [{ sessionId: local, reference, extra: 1 }, { sessionId: local, reference, referenceUnavailable: 'x' }, { sessionId: local },
      { sessionId: local, reference: 'asb:1/a b' }, { sessionId: local, reference: `asb:${'x'.repeat(381)}` }, { sessionId: local, reference: 'codex/x' },
      { sessionId: local, referenceUnavailable: 'Not-Found' }, { sessionId: local, referenceUnavailable: 'x'.repeat(65) }, { sessionId: 'x', reference },
      { sessionId: local, machineId, reference }, 7, null],
    remote: [{ sessionId: remote, reference }, { machineId: 'B'.repeat(16), sessionId: remote, reference }, { machineId, sessionId: remote, reference, extra: 1 }] });
    expect((await listReferences(runtime, caller)).size).toBe(0);
    answer = reply({ local: [{ sessionId: local, reference: `asb:${'x'.repeat(380)}` }, { sessionId: remote, referenceUnavailable: 'x'.repeat(64) }], remote: [] });
    expect((await listReferences(runtime, caller)).size).toBe(2);
    // At most 256 items of each list are read.
    const ids = Array.from({ length: 300 }, () => crypto.randomUUID());
    answer = reply({ local: ids.map(sessionId => ({ sessionId, referenceUnavailable: 'not-live' })),
      remote: ids.map(sessionId => ({ machineId, sessionId, referenceUnavailable: 'not-found' })) });
    expect((await listReferences(runtime, caller)).size).toBe(512);
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});

// Windows only: the engine binds a Windows target only for a bridge that proves the pipe server, so the body asks for it.
test.skipIf(process.platform !== 'win32')('on Windows, listReferences asks for a pipe proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asb-engine-windows-'));
  const engine = fakeEngine(root, () => ({ apiVersion: 1, ok: true, pid: process.pid, local: [], remote: [] }), join(root, 'asb', 'run'));
  const caller = { runtimeSessionId: crypto.randomUUID(), configDir: 'C:\\synthetic\\claude' };
  try {
    const runtime = engineRuntime({ LOCALAPPDATA: root }, 'win32');
    expect(runtime).not.toBeNull();
    expect((await listReferences(runtime!, caller)).size).toBe(0);
    expect(engine.calls.map(call => [call.route, call.body])).toEqual([['/api/agent/list-references', { caller, hostCheck: true, pipeProof: true }]]);
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});
