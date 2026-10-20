import { test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineRequest, engineRuntime, remotePeers } from '../src/engine';
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
    expect(engineRuntime(env)).toBeNull();
    mkdirSync(join(root, 'asb'), { mode: 0o700 });
    expect(engineRuntime(env)).toBeNull();
    write(good);
    expect(engineRuntime(env)).toEqual(good);
    write(good, 0o644);
    expect(engineRuntime(env)).toBeNull();
    for (const value of [{ ...good, extra: 1 }, { ...good, schema: 2 }, { ...good, port: 0 }, { ...good, sourceToken: 'E'.repeat(64) },
      { ...good, pid: 2147483647 }, { ...good, pid: -1 }, 'not an object']) {
      write(value);
      expect(engineRuntime(env)).toBeNull();
    }
    writeFileSync(file, '{');
    expect(engineRuntime(env)).toBeNull();
    write(good);
    chmodSync(join(root, 'asb'), 0o755);
    expect(engineRuntime(env)).toBeNull();
    chmodSync(join(root, 'asb'), 0o700);
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
    const runtime = engineRuntime({ XDG_RUNTIME_DIR: root })!;
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
