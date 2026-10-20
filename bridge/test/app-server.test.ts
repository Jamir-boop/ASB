import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AppServer, loadedAppServerThreads, withAppServer } from '../src/app-server';
import { peers } from '../src/claude';
import { appServer } from './app-server-fixture';
import { discoverTarget, watchCodex } from '../src/codex';
import { DeliveryRefused } from '../src/delivery';
// POSIX only on Windows CI: the Unix socket file of the app-server fixture.
const posix = test.skipIf(process.platform === 'win32');

// A private listener killed with SIGKILL leaves its socket file with nobody behind it, as Codex does.
async function staleSocket(path: string) {
  const child = Bun.spawn([process.execPath, '-e', `process.umask(0o077); require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('ready'))`],
    { stdout: 'pipe', stderr: 'ignore' });
  const reader = child.stdout.getReader();
  await reader.read();
  child.kill('SIGKILL');
  await child.exited;
  expect(lstatSync(path).isSocket()).toBe(true);
}

posix('a missing or stale app-server socket falls back to the desktop target', async () => {
  const root = mkdtempSync('/tmp/codex-stale-');
  try {
    const directory = join(root, 'app-server-control');
    mkdirSync(directory, { mode: 0o700 });
    const ipcPath = join(root, 'ipc.sock');
    const threadId = randomUUID();
    expect(await discoverTarget(root, ipcPath, threadId)).toEqual({ kind: 'desktop', path: ipcPath });
    const path = join(directory, 'app-server-control.sock');
    await staleSocket(path);
    const failure = await new AppServer(path, threadId).connectHost().then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'ECONNREFUSED', message: expect.stringMatching(/^App-server connection failed: \S/) });
    expect(await discoverTarget(root, ipcPath, threadId)).toEqual({ kind: 'desktop', path: ipcPath });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

posix('loaded-thread discovery initializes the host without a per-thread read', async () => {
  const server = await appServer();
  try {
    expect(await loadedAppServerThreads(server.path)).toEqual(new Set([server.threadId]));
    expect(server.requests.map(request => request.method)).toEqual(['initialize', 'thread/loaded/list']);
    expect(server.requests[1]?.params).toEqual({});
    server.setLoaded(false);
    expect(await loadedAppServerThreads(server.path)).toEqual(new Set());
  } finally { await server.close(); }
});

posix('a CLI session registers without desktop IPC, withdraws at SessionEnd and is revived after a restart', async () => {
  const server = await appServer();
  const configDir = join(server.root, 'claude');
  const hook = async (hook_event_name: 'SessionStart' | 'SessionEnd' | '--revive') => {
    const revive = hook_event_name === '--revive';
    const child = Bun.spawn([process.execPath, process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts'), ...(revive ? [hook_event_name] : [])],
      { env: { ...process.env, CODEX_HOME: server.root, CLAUDE_CONFIG_DIR: configDir }, stdin: revive ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' });
    if (!revive) { child.stdin?.write(JSON.stringify({ session_id: server.threadId, cwd: server.root, hook_event_name })); child.stdin?.end(); }
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
  };
  try {
    await hook('SessionStart');
    expect(peers(configDir).map(peer => peer.sessionId)).toEqual([server.threadId]);
    await hook('SessionEnd');
    expect(peers(configDir)).toEqual([]);
    await hook('--revive');
    expect(peers(configDir).map(peer => [peer.sessionId, peer.cwd])).toEqual([[server.threadId, server.root]]);
  } finally {
    for (const peer of peers(configDir)) process.kill(peer.pid, 'SIGTERM');
    await server.close();
  }
});

posix('peer input has tool authority and an independent delivery ID in idle and active threads', async () => {
  const server = await appServer();
  try {
    for (const state of ['idle', 'active'] as const) {
      server.setState(state);
      const inputId = randomUUID();
      const result = await withAppServer(server.path, server.threadId, client => client.submit(inputId, 'peer update'));
      expect(result).toEqual({ status: 'accepted', turnId: server.turnId });
      expect(server.submissions.at(-1)?.params).toEqual({ threadId: server.threadId, input: [],
        toolOutput: { name: 'peer_message', namespace: 'asb_bridge', output: JSON.stringify({ inputId, content: 'peer update' }) } });
    }
    server.loseAcknowledgement();
    await expect(withAppServer(server.path, server.threadId, client => client.submit(randomUUID(), 'uncertain update'))).rejects.toThrow();
    expect(server.submissions).toHaveLength(3);
  } finally { await server.close(); }
});

posix('delivery refuses a thread unloaded after preflight without loading it again', async () => {
  const server = await appServer();
  try {
    server.unloadOnNextRead();
    const error = await withAppServer(server.path, server.threadId, client => client.submit(randomUUID(), 'late message')).catch(error => error);
    expect(error).toBeInstanceOf(DeliveryRefused);
    expect(error.message).toContain('Thread is not loaded');
    expect(server.submissions).toEqual([]);
  } finally { await server.close(); }
});

posix('consumed peer inputs correlate across history pages and new user input resets the origin', async () => {
  const server = await appServer();
  const inputId = randomUUID();
  const nativeId = randomUUID();
  const userId = randomUUID();
  const peer = { type: 'functionCallOutput', id: nativeId, name: 'peer_message', namespace: 'asb_bridge',
    output: JSON.stringify({ inputId, content: 'peer update' }) };
  const tail = Array.from({ length: 110 }, () => ({ type: 'agentMessage', id: randomUUID() }));
  try {
    server.setItems([peer, ...tail]);
    expect(await withAppServer(server.path, server.threadId, client => client.inputs([inputId])))
      .toEqual({ latest: { id: nativeId, clientId: inputId }, consumed: [{ id: nativeId, clientId: inputId }] });
    server.setItems([peer, ...tail, { type: 'userMessage', id: userId }]);
    const inputs = await withAppServer(server.path, server.threadId, client => client.inputs([inputId]));
    expect(inputs.latest).toEqual({ id: userId, clientId: null });
    expect(inputs.consumed).toContainEqual({ id: nativeId, clientId: inputId });
    server.setItems([peer, { type: 'functionCallOutput', id: userId, name: 'other_external_input', namespace: null, output: 'update' }]);
    expect((await withAppServer(server.path, server.threadId, client => client.inputs([inputId]))).latest)
      .toEqual({ id: userId, clientId: null });
  } finally { await server.close(); }
});

posix('queued work prevents idle and the bridge leaves approval requests to the existing UI', async () => {
  const server = await appServer();
  const states: { status: string; mode: string }[] = [];
  const client = new AppServer(server.path, server.threadId);
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
    expect(predicate()).toBe(true);
  };
  try {
    await client.connect();
    server.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    await client.runtime();
    await client.observe(state => states.push(state));
    expect(states.at(-1)).toEqual({ status: 'idle', mode: 'bypass' });
    server.setPermissions({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
    await until(() => states.at(-1)?.mode === 'prompting');
    server.setQueue([{ id: randomUUID() }]);
    server.requestApproval();
    await until(() => states.at(-1)?.status === 'busy');
    server.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    await until(() => states.at(-1)?.mode === 'bypass');
    server.setQueue([]);
    await until(() => states.at(-1)?.status === 'idle');
    expect(server.responses).toEqual([]);
    expect(server.submissions).toEqual([]);
  } finally { client.close(); await server.close(); }
});

posix('an observer disconnect suspends reception until fresh permissions are read', async () => {
  const server = await appServer();
  const states: { status: string; mode: string }[] = [];
  let disconnected = false;
  const stop = await watchCodex({ kind: 'app-server', path: server.path }, server.threadId,
    state => states.push(state), () => { disconnected = true; });
  try {
    server.disconnectClients();
    server.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    const deadline = Date.now() + 2000;
    while (states.at(-1)?.mode !== 'bypass' && !disconnected && Date.now() < deadline) await Bun.sleep(5);
    expect(disconnected).toBe(false);
    expect(states).toContainEqual({ status: 'unknown', mode: 'unknown' });
    expect(states.at(-1)).toEqual({ status: 'idle', mode: 'bypass' });
    expect(server.submissions).toEqual([]);
  } finally { stop(); await server.close(); }
});
