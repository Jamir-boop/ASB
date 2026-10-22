import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { peers, register, uniqueName, bridgeNameBase, namedSession, inbox, peerAddress, processStart } from '../src/claude';
import { createOpenCodeHost, modeFromRules, opencodeBridgeId, uuidV5 } from '../src/opencode-host';
import { listSessions, sendMessage, agentLabel } from '../src/tools';
import { Bridge } from '../src/bridge';
import { ensureCoordinator, bridgeIdOf, registerSession, unregister, deleteSession, handleEvent, recentInputs, CAP, START_LIMIT, START_WINDOW_MS, IDLE_MS } from '../src/opencode';

const posix = test.skipIf(process.platform === 'win32');
// The ASB engine runs on Linux and Windows only: `engineRuntime` gives null on macOS, so no references come back.
const linux = test.skipIf(process.platform !== 'linux');

function fakeCtx() {
  const syntheticCalls: Array<{ sessionID: string; text: string; delivery: string }> = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const eventQueue: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];
  let wake: (() => void) | undefined;
  const ctx = {
    app: { version: '2.1.2' },
    location: { directory: '/tmp/opencode-project' },
    session: {
      async list() { return [...sessions.values()]; },
      async get(input: { sessionID: string }) { return sessions.get(input.sessionID); },
      async synthetic(input: { sessionID: string; text: string; delivery: string }) {
        syntheticCalls.push(input);
        return { id: `inb_${syntheticCalls.length}` };
      },
      async context() { return [{ id: 'msg_old', type: 'user', text: 'human earlier' }]; },
    },
    agent: {
      async list() {
        return [{ permissions: [{ action: 'shell', pattern: '*', permission: 'allow' }, { action: 'edit', pattern: '*', permission: 'allow' }] }];
      },
    },
    event: {
      // R3: the real API takes options and returns an async iterable of { id, type, data }.
      subscribe(options?: unknown) {
        if (typeof options === 'function') throw new TypeError('event.subscribe takes options');
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<{ id: string; type: string; data: Record<string, unknown> }>> {
                while (!signal?.aborted && eventQueue.length === 0) {
                  await new Promise<void>(resolve => { wake = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
                }
                if (signal?.aborted || eventQueue.length === 0) return { done: true, value: undefined };
                return { done: false, value: eventQueue.shift()! };
              },
              async return() { return { done: true, value: undefined }; },
            };
          },
        };
      },
    },
    tool: { transform(_fn?: unknown) {} },
  };
  return {
    ctx,
    syntheticCalls,
    sessions,
    setSession(id: string, row: Record<string, unknown>) { sessions.set(id, { id, ...row }); },
    pushEvent(event: { id: string; type: string; data: Record<string, unknown> }) {
      eventQueue.push(event);
      wake?.();
      wake = undefined;
    },
  };
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timeout: ' + label);
}

function settle(ms = 20) { return new Promise(resolve => setTimeout(resolve, ms)); }

function tempHome() {
  const root = mkdtempSync(join(tmpdir(), 'asb-opencode-'));
  const configDir = join(root, 'claude');
  const stateDir = join(root, 'state');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(join(configDir, 'sessions'), 0o700);
  chmodSync(stateDir, 0o700);
  return { root, configDir, stateDir };
}

async function resetCoordinator(co: ReturnType<typeof ensureCoordinator>) {
  for (const receiver of [...co.receivers.values()]) {
    try { await receiver.bridge.close(); } catch { /* Gone. */ }
    try { receiver.placeholder.kill(); } catch { /* Gone. */ }
  }
  co.registering.clear();
  co.receivers.clear();
  co.instances.clear();
  co.running.clear();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('asb.bridge.opencode')];
}

posix('bridge UUID is a stable UUID v5 of opencode:<ses_...>', () => {
  const id = 'ses_01abcdefghijklmnop';
  const first = opencodeBridgeId(id);
  expect(first).toBe(opencodeBridgeId(id));
  expect(z.uuid().safeParse(first).success).toBe(true);
  expect(first).not.toBe(opencodeBridgeId('ses_other'));
  expect(uuidV5('opencode:ses_01abcdefghijklmnop')).toBe(first);
});

posix('name rule is opencode-<title slug>-<suffix> and falls back to the folder', () => {
  expect(bridgeNameBase('opencode', 'Fix Login Fast', '/tmp/proj')).toBe('opencode-fix-login-fast');
  expect(bridgeNameBase('opencode', undefined, '/tmp/my-long-service-folder-name')).toMatch(/^opencode-my-long-serv/);
  const root = mkdtempSync(join(tmpdir(), 'asb-name-'));
  try {
    const id = randomUUID();
    const name = namedSession(root, 'opencode', 'Fix Login', '/tmp/proj', id);
    expect(name).toBe(`opencode-fix-login-${id.slice(-2)}`);
    const folder = join(root, 'sessions');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    // No other live peer holds the name, so the shortest suffix wins.
    expect(uniqueName(root, 'opencode-fix-login', id)).toBe(`opencode-fix-login-${id.slice(-2)}`);
  } finally { rmSync(root, { recursive: true }); }
});

posix('agentLabel maps entrypoints', () => {
  expect(agentLabel('codex-asb-bridge')).toBe('codex');
  expect(agentLabel('opencode-asb-bridge')).toBe('opencode');
  expect(agentLabel('other')).toBe('claude');
});

test('modeFromRules is bypass, prompting, or unknown from shell and edit', () => {
  expect(modeFromRules([{ action: 'shell', pattern: '*', permission: 'allow' }, { action: 'edit', pattern: '*', permission: 'allow' }])).toBe('bypass');
  expect(modeFromRules([{ action: 'shell', pattern: '*', permission: 'ask' }, { action: 'edit', pattern: '*', permission: 'allow' }])).toBe('prompting');
  expect(modeFromRules(undefined)).toBe('unknown');
  expect(modeFromRules([])).toBe('unknown');
});

posix('send_message validation texts match the Codex tool bodies', async () => {
  const { root, configDir, stateDir } = tempHome();
  try {
    const bridge = new Bridge(randomUUID(), configDir, stateDir, join(root, 'x.sock'));
    try {
      await expect(sendMessage({ sessionId: 'not-a-uuid' }, () => bridge)).rejects.toThrow(
        'Input validation error: sessionId must be a UUID from list_sessions. Nothing sent.');
      await expect(sendMessage({ reference: 'nope' }, () => bridge)).rejects.toThrow(
        'Input validation error: reference must be a full session reference (asb:1/...). Nothing sent.');
      await expect(sendMessage({}, () => bridge)).rejects.toThrow('Give exactly one of sessionId or reference.');
    } finally { await bridge.close(); }
  } finally { rmSync(root, { recursive: true }); }
});

posix('list_sessions reports agent opencode and filters by nameContains', async () => {
  const { root, configDir } = tempHome();
  const placeholders: Array<{ kill(): void }> = [];
  const inboxes: Array<{ close(): Promise<void> }> = [];
  try {
    const self = randomUUID();
    const other = randomUUID();
    const folder = join(root, 'socks');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    for (const [sessionId, name, entrypoint, file] of [
      [self, 'opencode-alpha-aa', 'opencode-asb-bridge', 'self.sock'],
      [other, 'codex-beta-bb', 'codex-asb-bridge', 'other.sock'],
    ] as const) {
      const child = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
      placeholders.push({ kill: () => { try { child.kill(); } catch { /* Gone. */ } } });
      const box = await inbox(folder, () => {}, file);
      inboxes.push(box);
      const procStart = z.string().parse(await processStart(child.pid));
      writeFileSync(join(configDir, 'sessions', `${child.pid}.json`), JSON.stringify({
        pid: child.pid, sessionId, cwd: '/tmp', name, startedAt: entrypoint === 'opencode-asb-bridge' ? 2000 : 1000,
        procStart, peerProtocol: 1, kind: 'interactive', entrypoint,
        messagingSocketPath: box.address.replace(/^uds:/, ''), status: entrypoint === 'opencode-asb-bridge' ? 'idle' : 'busy',
        statusUpdatedAt: 1, peerFeatures: ['notify_idle'],
        ...(entrypoint === 'opencode-asb-bridge' ? { opencodeSessionId: 'ses_alpha' } : {}),
      }));
    }
    const caller = randomUUID();
    const listed = await listSessions(caller, configDir);
    expect(listed.map(row => row.name).sort()).toEqual(['codex-beta-bb', 'opencode-alpha-aa']);
    expect(listed.find(row => row.sessionId === other)?.agent).toBe('codex');
    expect(listed.find(row => row.sessionId === self)?.agent).toBe('opencode');
    const filtered = await listSessions(caller, configDir, 'alpha');
    expect(filtered.map(row => row.name)).toEqual(['opencode-alpha-aa']);
    // The caller never lists itself.
    expect((await listSessions(self, configDir)).map(row => row.name)).toEqual(['codex-beta-bb']);
  } finally {
    for (const box of inboxes) await box.close().catch(() => {});
    for (const child of placeholders) child.kill();
    rmSync(root, { recursive: true });
  }
});

posix('send_message validation errors are byte-equal across the Codex and OpenCode tool paths', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const instance = { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] };
    co.instances.set('/tmp/opencode-project', instance);
    fake.setSession('ses_eq', { location: { directory: '/tmp/proj' }, title: 'Equal' });
    const { default: plugin } = await import('../src/opencode');
    const tools: Array<{ name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }> = [];
    fake.ctx.tool.transform = (callback: (editor: { namespace: () => void; add: (tool: { name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }) => void }) => void) => {
      const editor = {
        namespace() { /* noop */ },
        add(tool: { name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }) { tools.push(tool); return editor; },
      };
      callback(editor);
    };
    await plugin.setup(fake.ctx);
    const send = tools.find(tool => tool.name === 'send_message')!;
    const bridge = new Bridge(randomUUID(), configDir, stateDir, join(root, 'x.sock'));
    try {
      const cases = [
        { sessionId: 'not-a-uuid' },
        { reference: 'nope' },
        {},
      ];
      for (const input of cases) {
        let shared: string | undefined;
        try { await sendMessage(input as Record<string, unknown>, () => bridge); }
        catch (error) { shared = (error as Error).message; }
        let toolPath: string | undefined;
        try { await send.execute(input, { sessionID: 'ses_eq' }); }
        catch (error) { toolPath = (error as Error).message; }
        expect(shared).toBeTruthy();
        expect(toolPath).toBe(shared);
      }
    } finally { await bridge.close(); }
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

linux('list_sessions merges remote entries and references for an OpenCode caller', async () => {
  const { root, configDir } = tempHome();
  const placeholders: Array<{ kill(): void }> = [];
  const inboxes: Array<{ close(): Promise<void> }> = [];
  const runtimeDir = join(root, 'runtime');
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const localRefHolder: { localId?: string; localRef?: string; remoteRef?: string; remoteId?: string; machineId?: string; remotePeer?: Record<string, unknown> } = {};
  const { fakeEngine } = await import('./engine-fixture');
  const engine = fakeEngine(runtimeDir, route => {
    if (route === '/api/agent/list-references') {
      return {
        apiVersion: 1, ok: true, pid: process.pid,
        local: [{ sessionId: localRefHolder.localId, reference: localRefHolder.localRef }],
        remote: [{ machineId: localRefHolder.machineId, sessionId: localRefHolder.remoteId, reference: localRefHolder.remoteRef }],
      };
    }
    return { peers: localRefHolder.remotePeer ? [localRefHolder.remotePeer] : [] };
  });
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  try {
    const self = randomUUID();
    const folder = join(root, 'socks');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const child = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    placeholders.push({ kill: () => { try { child.kill(); } catch { /* Gone. */ } } });
    const box = await inbox(folder, () => {}, 'self.sock');
    inboxes.push(box);
    const procStart = z.string().parse(await processStart(child.pid));
    writeFileSync(join(configDir, 'sessions', `${child.pid}.json`), JSON.stringify({
      pid: child.pid, sessionId: self, cwd: '/tmp', name: 'opencode-local-aa', startedAt: 2000,
      procStart, peerProtocol: 1, kind: 'interactive', entrypoint: 'opencode-asb-bridge',
      messagingSocketPath: box.address.replace(/^uds:/, ''), status: 'idle',
      statusUpdatedAt: 1, peerFeatures: ['notify_idle'], opencodeSessionId: 'ses_local',
    }));
    const remoteId = randomUUID();
    const machineId = 'b'.repeat(16);
    localRefHolder.localId = self;
    localRefHolder.localRef = `asb:1/${'a'.repeat(16)}/codex/${'ab'.repeat(16)}/codex:${self}`;
    localRefHolder.remoteId = remoteId;
    localRefHolder.machineId = machineId;
    localRefHolder.remoteRef = `asb:1/${'c'.repeat(16)}/codex/${'cd'.repeat(16)}/codex:${remoteId}`;
    // Q3: the wire keeps only claude or codex; a remote OpenCode session lists as claude.
    localRefHolder.remotePeer = {
      machineId, machineName: 'beta', online: true, sessionId: remoteId,
      name: 'remote-task', agent: 'claude', status: 'idle', remoteControl: false,
    };
    const caller = randomUUID();
    const listed = await listSessions(caller, configDir);
    const localRow = listed.find(row => row.sessionId === self);
    expect(localRow?.agent).toBe('opencode');
    expect(localRow && 'reference' in localRow ? localRow.reference : undefined).toBe(localRefHolder.localRef);
    const remoteRow = listed.find(row => row.remote);
    expect(remoteRow?.sessionId).toBe(remoteId);
    expect(remoteRow?.agent).toBe('claude');
    expect(remoteRow?.name).toBe('beta-remote-task');
    expect(remoteRow && 'reference' in remoteRow ? remoteRow.reference : undefined).toBe(localRefHolder.remoteRef);
    expect(remoteRow?.machine).toBe('beta');
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    engine.close();
    for (const box of inboxes) await box.close().catch(() => {});
    for (const child of placeholders) child.kill();
    rmSync(root, { recursive: true });
  }
});

posix('outgoing frames carry from-mode from V27 agent rules', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const folder = join(root, 'socks');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const frames: Array<Record<string, unknown>> = [];
  const peerPath = join(root, 'peer.sock');
  const peerServer = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        frames.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  peerServer.listen(peerPath);
  await once(peerServer, 'listening');
  chmodSync(peerPath, 0o600);
  const peerId = randomUUID();
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath, cwd: root,
    peerProtocol: 1, peerFeatures: ['notify_idle'], startedAt: 1700000000000,
  }));
  const host = createOpenCodeHost({
    openCodeSessionId: 'ses_mode', title: 'Mode', cwd: '/tmp',
    session: fake.ctx.session, agent: {
      async list() {
        return [{ permissions: [{ action: 'shell', pattern: '*', permission: 'allow' }, { action: 'edit', pattern: '*', permission: 'allow' }] }];
      },
    },
    isRunning: () => false, recentInputs: () => [{ id: 'msg_1', kind: 'user', text: 'human earlier' }], pid: process.pid,
  });
  const bridge = new Bridge(randomUUID(), configDir, stateDir, join(root, 'x.sock'), host);
  try {
    await bridge.start(folder, '/tmp', bridge.beginSession());
    await bridge.updateRuntime(await host.runtime());
    await bridge.sendMessage(peerId, 'hello');
    const deadline = Date.now() + 2000;
    while (!frames.some(frame => frame.type === 'user') && Date.now() < deadline) await Bun.sleep(5);
    const frame = frames.find(f => f.type === 'user') as { message?: { content?: string } } | undefined;
    expect(frame).toBeTruthy();
    expect(frame!.message!.content).toContain('from-mode="bypass"');
  } finally {
    await bridge.close();
    await new Promise<void>(resolve => peerServer.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
});

posix('inbound delivery is synthetic steer; started when idle and steered when running', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const openCodeId = 'ses_inbound_1';
    fake.setSession(openCodeId, { location: { directory: '/tmp/proj' }, title: 'Inbound' });
    co.instances.set('/tmp/opencode-project', { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] });
    const instance = [...co.instances.values()][0]!;
    const receiver = await registerSession(co, instance, { id: openCodeId, location: { directory: '/tmp/proj' }, title: 'Inbound' });
    expect(receiver && 'bridge' in receiver).toBe(true);
    const row = receiver as { bridge: Bridge; host: ReturnType<typeof createOpenCodeHost> };
    expect(row.bridge.threadId).toBe(bridgeIdOf(openCodeId));

    const { peerHeader } = await import('../src/delivery');
    const sender = randomUUID();
    const text = `${peerHeader(sender, 'codex-peer', undefined, row.host.replyHint)}\nhello opencode`;
    expect(text).toContain('Reply with tools.asb_bridge.send_message.');
    expect(text).toContain(`sessionId ${sender}`);
    const result = await row.host.deliver(randomUUID(), text);
    expect(result.status).toBe('started');
    expect(fake.syntheticCalls[0]?.delivery).toBe('steer');
    expect(fake.syntheticCalls[0]?.text).toContain('Reply with tools.asb_bridge.send_message.');
    expect(fake.syntheticCalls[0]?.text).toContain('hello opencode');

    co.running.add(openCodeId);
    expect((await row.host.deliver(randomUUID(), 'second')).status).toBe('steered');

    row.host.noteDelivered('inb_1');
    expect((await row.host.peekLatest())?.kind).toBe('synthetic');
    row.host.noteHuman('user typed this', 'msg_human');
    expect((await row.host.peekLatest())?.kind).toBe('user');
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('a sender with any mode is delivered at once (no hold)', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  try {
    const host = createOpenCodeHost({
      openCodeSessionId: 'ses_mode', title: 'Mode', cwd: '/tmp',
      session: fake.ctx.session, agent: fake.ctx.agent,
      isRunning: () => false, recentInputs: () => [], pid: process.pid,
    });
    const bridge = new Bridge(randomUUID(), configDir, stateDir, join(root, 'x.sock'), host);
    try {
      const socks = join(root, 'socks');
      mkdirSync(socks, { recursive: true, mode: 0o700 });
      chmodSync(socks, 0o700);
      const generation = bridge.beginSession();
      await bridge.start(socks, '/tmp', generation);
      expect(bridge.policy()).toBe('default');
      expect(bridge.held()).toEqual([]);
      // A bypass or prompting sender: the message is delivered at once.
      for (const text of ['from a bypass sender', 'from a prompting sender', 'from a null-mode sender']) {
        const result = await host.deliver(randomUUID(), text);
        expect(result.status).toBe('started');
        expect(fake.syntheticCalls.at(-1)?.text).toContain(text);
      }
    } finally { await bridge.close(); }
  } finally { rmSync(root, { recursive: true }); }
});

posix('register triggers, rename, archive, delete, and child sessions never register', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    fake.setSession('ses_exec', { location: { directory: '/tmp/proj' }, title: 'Exec', time: { updated: Date.now() - START_WINDOW_MS - 1000 } });
    fake.setSession('ses_child', { location: { directory: '/tmp/proj' }, title: 'Child', parentID: 'ses_exec' });
    fake.setSession('ses_fresh', { location: { directory: '/tmp/proj' }, title: 'Fresh', time: { updated: Date.now() - START_WINDOW_MS - 1000 } });
    const { default: plugin } = await import('../src/opencode');
    const api = await plugin.setup(fake.ctx);

    fake.pushEvent({ id: 'e1', type: 'session.created', data: { sessionID: 'ses_exec' } });
    await settle();
    expect(co.receivers.size).toBe(0);

    fake.pushEvent({ id: 'e2', type: 'session.execution.started', data: { sessionID: 'ses_exec' } });
    await until(() => co.receivers.has('ses_exec'), 'register on execution.started');
    expect(co.receivers.get('ses_exec')?.running).toBe(true);

    fake.pushEvent({ id: 'e3', type: 'session.execution.started', data: { sessionID: 'ses_child' } });
    await settle();
    expect(co.receivers.has('ses_child')).toBe(false);

    fake.pushEvent({ id: 'e4', type: 'session.renamed', data: { sessionID: 'ses_exec', title: 'Renamed Task' } });
    await until(() => co.receivers.get('ses_exec')?.title === 'Renamed Task', 'rename');

    fake.pushEvent({ id: 'e5', type: 'session.execution.succeeded', data: { sessionID: 'ses_exec' } });
    await until(() => co.receivers.get('ses_exec')?.running === false, 'succeeded');
    expect(co.running.has('ses_exec')).toBe(false);

    fake.pushEvent({ id: 'e6', type: 'session.archived', data: { sessionID: 'ses_exec' } });
    await until(() => !co.receivers.has('ses_exec'), 'archive');

    fake.pushEvent({ id: 'e7', type: 'session.execution.started', data: { sessionID: 'ses_fresh' } });
    await until(() => co.receivers.has('ses_fresh'), 'register fresh');
    const sqlite = join(stateDir, `${bridgeIdOf('ses_fresh')}.sqlite`);
    expect(existsSync(sqlite)).toBe(true);
    fake.pushEvent({ id: 'e8', type: 'session.deleted', data: { sessionID: 'ses_fresh' } });
    await until(() => !co.receivers.has('ses_fresh'), 'delete');
    expect(existsSync(sqlite)).toBe(false);

    // event id dedupe: a second delivery of the same id is ignored
    fake.pushEvent({ id: 'e2', type: 'session.execution.started', data: { sessionID: 'ses_exec' } });
    await settle();
    expect(co.receivers.has('ses_exec')).toBe(false);

    await api?.();
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('dispose aborts the event loop and no event after dispose is handled', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    fake.setSession('ses_dispose', { location: { directory: '/tmp/proj' }, title: 'Dispose', time: { updated: Date.now() } });
    const { default: plugin } = await import('../src/opencode');
    const api = await plugin.setup(fake.ctx);
    fake.pushEvent({ id: 'e1', type: 'session.execution.started', data: { sessionID: 'ses_dispose' } });
    await until(() => co.receivers.has('ses_dispose'), 'register before dispose');
    await api?.();
    fake.pushEvent({ id: 'e2', type: 'session.execution.started', data: { sessionID: 'ses_dispose' } });
    await settle(50);
    expect(co.receivers.has('ses_dispose')).toBe(false);
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('dispose waits for an in-flight registration and leaves no receiver or placeholder', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  const sessionId = 'ses_cleanup_race';
  const bridgeId = bridgeIdOf(sessionId);
  let placeholderPid: number | undefined;
  const listAgents = fake.ctx.agent.list;
  fake.ctx.agent.list = async () => {
    for (const file of readdirSync(join(configDir, 'sessions'))) {
      if (!file.endsWith('.json')) continue;
      const row = JSON.parse(readFileSync(join(configDir, 'sessions', file), 'utf8'));
      if (row.sessionId === bridgeId) placeholderPid = row.pid;
    }
    return listAgents();
  };
  try {
    const { default: plugin } = await import('../src/opencode');
    const api = await plugin.setup(fake.ctx);
    const instance = co.instances.get(fake.ctx.location.directory)!;
    const session = { id: sessionId, location: { directory: '/tmp/proj' }, title: 'Cleanup race', time: { updated: Date.now() } };
    fake.setSession(sessionId, session);
    const pending = registerSession(co, instance, session as any);
    await api?.();
    const result = await pending;
    expect(result).toBeUndefined();
    expect(co.receivers.has(sessionId)).toBe(false);
    const rows = readdirSync(join(configDir, 'sessions')).filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(readFileSync(join(configDir, 'sessions', file), 'utf8')));
    expect(rows.some(row => row.sessionId === bridgeId)).toBe(false);
    expect(placeholderPid).toBeDefined();
    await until(() => {
      try { process.kill(placeholderPid!, 0); return false; }
      catch { return true; }
    }, 'placeholder exits after cleanup');
    expect(() => process.kill(placeholderPid!, 0)).toThrow();
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('fake event.subscribe throws on a function and ends when the signal aborts', async () => {
  const fake = fakeCtx();
  expect(() => fake.ctx.event.subscribe(() => {})).toThrow(TypeError);
  const controller = new AbortController();
  const stream = fake.ctx.event.subscribe({ signal: controller.signal }) as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> };
  expect(typeof stream[Symbol.asyncIterator]).toBe('function');
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();
  controller.abort();
  const result = await pending;
  expect(result.done).toBe(true);
});

test('constants match the approved limits', () => {
  expect(CAP).toBe(24);
  expect(START_LIMIT).toBe(8);
  expect(START_WINDOW_MS).toBe(30 * 60 * 1000);
  expect(IDLE_MS).toBe(12 * 60 * 60 * 1000);
});

posix('inputs after a reload take the last context message; none means unknown origin', async () => {
  const host = createOpenCodeHost({
    openCodeSessionId: 'ses_reload', title: 'Reload', cwd: '/tmp',
    session: { async synthetic() { return { id: 'x' }; }, async context() { return []; }, async list() { return []; }, async get() { return {}; } },
    agent: { async list() { return []; } },
    isRunning: () => false,
    recentInputs: () => [{ id: 'msg_1', kind: 'synthetic' as const, text: '[ASB Bridge peer message from a, sessionId b. Reply with tools.asb_bridge.send_message.]\nbody' }],
    pid: process.pid,
  });
  expect((await host.peekLatest())?.kind).toBe('synthetic');
  const empty = createOpenCodeHost({
    openCodeSessionId: 'ses_empty', title: undefined, cwd: '/tmp/no-title-folder',
    session: { async synthetic() { return { id: 'x' }; }, async context() { return []; }, async list() { return []; }, async get() { return {}; } },
    agent: { async list() { return []; } },
    isRunning: () => false,
    recentInputs: () => [],
    pid: process.pid,
  });
  expect(await empty.peekLatest()).toBeUndefined();
});

posix('a bridge tool call registers the session; a child tool call sends as its root', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const instance = { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] };
    co.instances.set('/tmp/opencode-project', instance);
    fake.setSession('ses_tool', { location: { directory: '/tmp/proj' }, title: 'Tool Call' });
    fake.setSession('ses_sub', { location: { directory: '/tmp/proj' }, title: 'Sub', parentID: 'ses_tool' });
    const { default: plugin } = await import('../src/opencode');
    const tools: Array<{ name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }> = [];
    // plugin.setup calls ctx.tool.transform(callback); the callback receives the editor.
    fake.ctx.tool.transform = (callback: (editor: { namespace: () => void; add: (tool: { name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }) => void }) => void) => {
      const editor = {
        namespace() { /* noop */ },
        add(tool: { name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }) { tools.push(tool); return editor; },
      };
      callback(editor);
    };
    await plugin.setup(fake.ctx);
    const list = tools.find(tool => tool.name === 'list_sessions')!;
    const status = tools.find(tool => tool.name === 'status')!;
    // A root session that only calls a tool registers.
    expect(co.receivers.has('ses_tool')).toBe(false);
    await list.execute({}, { sessionID: 'ses_tool' });
    expect(co.receivers.has('ses_tool')).toBe(true);
    // A child never registers; its tool call uses the root receiver.
    await list.execute({}, { sessionID: 'ses_sub' });
    expect(co.receivers.has('ses_sub')).toBe(false);
    const result = JSON.parse(String((await status.execute({}, { sessionID: 'ses_sub' })).content));
    expect(result.registered).toBe(true);
    expect(result.openCodeSessionId).toBe('ses_tool');
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('plugin start registers at most 8 sessions updated in the last 30 minutes, newest first', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      fake.setSession(`ses_start_${i}`, { location: { directory: '/tmp/proj' }, title: `Start ${i}`, time: { updated: now - i * 1000 } });
    }
    fake.setSession('ses_stale', { location: { directory: '/tmp/proj' }, title: 'Stale', time: { updated: now - START_WINDOW_MS - 1000 } });
    const { default: plugin } = await import('../src/opencode');
    const fake2 = fakeCtx();
    fake2.ctx.session.list = fake.ctx.session.list;
    fake2.ctx.session.get = fake.ctx.session.get;
    fake2.ctx.location = { directory: '/tmp/opencode-project' };
    await plugin.setup(fake2.ctx);
    expect(co.receivers.size).toBe(START_LIMIT);
    expect(co.receivers.has('ses_stale')).toBe(false);
    // Newest first: ses_start_0 is in, the oldest of the window is out.
    expect(co.receivers.has('ses_start_0')).toBe(true);
    expect(co.receivers.has('ses_start_7')).toBe(true);
    expect(co.receivers.has('ses_start_8')).toBe(false);
    expect(co.receivers.has('ses_start_11')).toBe(false);
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('instance cleanup unregisters only the sessions of that location', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const other = fakeCtx();
    const here = { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] };
    const there = { ctx: other.ctx, directory: '/tmp/other-project', disposers: [] };
    co.instances.set(here.directory, here);
    co.instances.set(there.directory, there);
    fake.setSession('ses_here', { location: { directory: '/tmp/proj' }, title: 'Here' });
    other.setSession('ses_there', { location: { directory: '/tmp/other' }, title: 'There' });
    await registerSession(co, here, { id: 'ses_here', location: { directory: '/tmp/proj' }, title: 'Here' });
    await registerSession(co, there, { id: 'ses_there', location: { directory: '/tmp/other' }, title: 'There' });
    // Cleanup of one location: only its receivers go.
    for (const receiver of [...co.receivers.values()]) {
      if (receiver.location === here.directory) await unregister(co, receiver.openCodeSessionId);
    }
    co.instances.delete(here.directory);
    expect(co.receivers.has('ses_here')).toBe(false);
    expect(co.receivers.has('ses_there')).toBe(true);
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('an event for a session of the second folder registers with that folder', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fakeA = fakeCtx();
  const fakeB = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const here = { ctx: fakeA.ctx, directory: '/tmp/opencode-project', disposers: [] };
    const there = { ctx: fakeB.ctx, directory: '/tmp/other-project', disposers: [] };
    co.instances.set(here.directory, here);
    co.instances.set(there.directory, there);
    fakeB.setSession('ses_second', { location: { directory: '/tmp/other-project' }, title: 'Second' });
    await handleEvent(co, { id: 'ev_second', type: 'session.execution.started', data: { sessionID: 'ses_second' } });
    const receiver = co.receivers.get('ses_second');
    expect(receiver).toBeDefined();
    expect(receiver!.location).toBe('/tmp/other-project');
    expect(receiver!.cwd).toBe('/tmp/other-project');
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('a tool call for a session of the second folder registers with that folder', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fakeA = fakeCtx();
  const fakeB = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const here = { ctx: fakeA.ctx, directory: '/tmp/opencode-project', disposers: [] };
    const there = { ctx: fakeB.ctx, directory: '/tmp/other-project', disposers: [] };
    co.instances.set(here.directory, here);
    co.instances.set(there.directory, there);
    fakeB.setSession('ses_second', { location: { directory: '/tmp/other-project' }, title: 'Second' });
    fakeB.ctx.location = { directory: '/tmp/other-project' };
    const { default: plugin } = await import('../src/opencode');
    const tools: Array<{ name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }> = [];
    fakeB.ctx.tool.transform = (callback: (editor: { namespace: () => void; add: (tool: { name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }) => void }) => void) => {
      const editor = {
        namespace() { /* noop */ },
        add(tool: { name: string; execute: (input: unknown, toolCtx: { sessionID?: string }) => Promise<{ content: unknown }> }) { tools.push(tool); return editor; },
      };
      callback(editor);
    };
    await plugin.setup(fakeB.ctx);
    const status = tools.find(tool => tool.name === 'status')!;
    await status.execute({}, { sessionID: 'ses_second' });
    const receiver = co.receivers.get('ses_second');
    expect(receiver).toBeDefined();
    expect(receiver!.location).toBe('/tmp/other-project');
    expect(receiver!.cwd).toBe('/tmp/other-project');
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('two registerSession calls for one session share one receiver and one generation', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    fake.setSession('ses_race', { location: { directory: '/tmp/proj' }, title: 'Race', time: { updated: Date.now() } });
    const { default: plugin, registerSession } = await import('../src/opencode');
    const instance = { ctx: fake.ctx, directory: '/tmp/proj', disposers: [] };
    co.instances.set(instance.directory, instance);
    // Two calls without awaiting the first.
    const a = registerSession(co, instance, { id: 'ses_race', location: { directory: '/tmp/proj' }, title: 'Race' } as any);
    const b = registerSession(co, instance, { id: 'ses_race', location: { directory: '/tmp/proj' }, title: 'Race' } as any);
    expect(co.registering.size).toBe(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    if (!ra || !('bridge' in ra)) throw new Error('expected a full receiver');
    const sqlite = join(stateDir, `${ra.bridgeId}.sqlite`);
    const db = new Database(sqlite, { readonly: true });
    const generation = db.query<{ generation: string }, []>('SELECT generation FROM lifecycle WHERE singleton=1').get()?.generation;
    db.close();
    expect(generation).toBe(ra.bridge.session()?.generation);
    expect(co.receivers.get('ses_race')).toBe(ra);
    expect(co.registering.size).toBe(0);
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('cap 24 evicts the idle oldest and refuses the new one when nothing can go', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const instance = { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] };
    co.instances.set('/tmp/opencode-project', instance);
    const ids: string[] = [];
    for (let i = 0; i < CAP; i++) {
      const id = `ses_cap_${i}`;
      ids.push(id);
      fake.setSession(id, { location: { directory: '/tmp/proj' }, title: `Cap ${i}` });
      const receiver = await registerSession(co, instance, { id, location: { directory: '/tmp/proj' }, title: `Cap ${i}` });
      expect(receiver && 'bridge' in receiver).toBe(true);
      // Stagger activity so the oldest is ses_cap_0.
      (receiver as { lastActivity: number }).lastActivity = Date.now() - (CAP - i) * 1000;
    }
    expect(co.receivers.size).toBe(CAP);
    // One running session cannot be evicted; the idle oldest goes instead.
    co.running.add('ses_cap_0');
    co.receivers.get('ses_cap_0')!.running = true;
    fake.setSession('ses_extra', { location: { directory: '/tmp/proj' }, title: 'Extra' });
    const extra = await registerSession(co, instance, { id: 'ses_extra', location: { directory: '/tmp/proj' }, title: 'Extra' });
    expect(extra && 'bridge' in extra).toBe(true);
    expect(co.receivers.has('ses_cap_0')).toBe(true);
    expect(co.receivers.has('ses_cap_1')).toBe(false);
    expect(co.receivers.has('ses_extra')).toBe(true);
    // When every row is running, the new session is limited and status says limit.
    for (const id of [...co.receivers.keys()]) {
      co.running.add(id);
      co.receivers.get(id)!.running = true;
    }
    fake.setSession('ses_limited', { location: { directory: '/tmp/proj' }, title: 'Limited' });
    const limited = await registerSession(co, instance, { id: 'ses_limited', location: { directory: '/tmp/proj' }, title: 'Limited' });
    expect(limited && 'limited' in limited).toBe(true);
    expect(co.receivers.has('ses_limited')).toBe(false);
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('12 hour idle unregisters a quiet receiver that holds nothing', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    const instance = { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] };
    co.instances.set('/tmp/opencode-project', instance);
    fake.setSession('ses_idle', { location: { directory: '/tmp/proj' }, title: 'Idle' });
    const receiver = await registerSession(co, instance, { id: 'ses_idle', location: { directory: '/tmp/proj' }, title: 'Idle' });
    expect(receiver && 'bridge' in receiver).toBe(true);
    (receiver as { lastActivity: number }).lastActivity = Date.now() - IDLE_MS - 1000;
    // The expire path is the same as the hourly timer: drop idle rows past 12 h.
    const row = co.receivers.get('ses_idle')!;
    if (!row.running && !row.bridge.held().length
      && row.bridge.status().idleRequests.every(request => request.status !== 'waiting')
      && Date.now() - row.lastActivity >= IDLE_MS) await unregister(co, 'ses_idle');
    expect(co.receivers.has('ses_idle')).toBe(false);
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('inbox.delivered frees the unread slot and human input resets the hop chain', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  const co = ensureCoordinator(configDir, stateDir);
  try {
    fake.setSession('ses_inbox', { location: { directory: '/tmp/proj' }, title: 'Inbox', time: { updated: Date.now() } });
    const { default: plugin } = await import('../src/opencode');
    const api = await plugin.setup(fake.ctx);
    fake.pushEvent({ id: 'e1', type: 'session.execution.started', data: { sessionID: 'ses_inbox' } });
    await until(() => co.receivers.has('ses_inbox'), 'register inbox session');
    const host = co.receivers.get('ses_inbox')!.host;
    // deliver fills the unread map; session.inbox.delivered frees the slot and becomes latest.
    await host.deliver('c1', 'one');
    await host.deliver('c2', 'two');
    expect((await host.peekLatest())?.text).toContain('two');
    fake.pushEvent({ id: 'e2', type: 'session.inbox.delivered', data: { sessionID: 'ses_inbox', inboxID: 'inb_1' } });
    await until(async () => (await host.peekLatest())?.kind === 'synthetic', 'inbox.delivered frees the slot');
    // A human message resets the hop chain origin (session.inbox.enqueued item.type user).
    // Real shape: item.payload.text, id on data.inboxID (2.1.2 probe).
    fake.pushEvent({ id: 'e3', type: 'session.inbox.enqueued', data: { sessionID: 'ses_inbox', inboxID: 'msg_h', item: { type: 'user', payload: { text: 'typed by the user' }, delivery: 'steer' } } });
    await until(async () => (await host.peekLatest())?.kind === 'user', 'human input resets the hop chain');
    expect((await host.peekLatest())?.text).toBe('typed by the user');
    await api?.();
  } finally {
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});

posix('after a reload the origin comes from context, else the exact refusal text', async () => {
  const { peerHeader } = await import('../src/delivery');
  const header = peerHeader(randomUUID(), 'codex-peer', undefined, 'Reply with tools.asb_bridge.send_message.');
  // After a reload the host map is empty: recentInputs reads ctx.session.context (async).
  const fake = fakeCtx();
  fake.ctx.session.context = async () => [{ id: 'msg_s', type: 'synthetic', text: `${header}\nfrom reload` }];
  const instance = { ctx: fake.ctx, directory: '/tmp/opencode-project', disposers: [] };
  const items = await recentInputs(instance, 'ses_origin');
  expect(items).toHaveLength(1);
  expect(items[0]!.kind).toBe('synthetic');
  const host = createOpenCodeHost({
    openCodeSessionId: 'ses_origin', title: 'Origin', cwd: '/tmp',
    session: fake.ctx.session, agent: fake.ctx.agent,
    isRunning: () => false,
    recentInputs: id => recentInputs(instance, id),
    pid: process.pid,
  });
  expect((await host.peekLatest())?.kind).toBe('synthetic');
  // Empty context: no origin, and the Bridge refuses a send with the existing text.
  const emptyFake = fakeCtx();
  emptyFake.ctx.session.context = async () => [];
  const emptyInstance = { ctx: emptyFake.ctx, directory: '/tmp/opencode-project', disposers: [] };
  const empty = createOpenCodeHost({
    openCodeSessionId: 'ses_none', title: undefined, cwd: '/tmp/no-title',
    session: emptyFake.ctx.session, agent: emptyFake.ctx.agent,
    isRunning: () => false,
    recentInputs: id => recentInputs(emptyInstance, id),
    pid: process.pid,
  });
  expect(await empty.peekLatest()).toBeUndefined();
  expect((await empty.inputs([])).latest).toBeUndefined();
  const { root, configDir, stateDir } = tempHome();
  try {
    const bridge = new Bridge(randomUUID(), configDir, stateDir, join(root, 'x.sock'), empty);
    const socks = join(root, 'socks');
    mkdirSync(socks, { recursive: true, mode: 0o700 });
    chmodSync(socks, 0o700);
    const peerId = randomUUID();
    const peerPath = join(root, 'peer.sock');
    const peerServer = net.createServer(() => {});
    peerServer.listen(peerPath);
    await once(peerServer, 'listening');
    chmodSync(peerPath, 0o600);
    mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
      pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath, cwd: root,
      peerProtocol: 1, peerFeatures: ['notify_idle'], startedAt: 1700000000000,
    }));
    try {
      const generation = bridge.beginSession();
      await bridge.start(socks, '/tmp', generation);
      await expect(bridge.sendMessage(peerId, 'hello')).rejects.toThrow('Cannot determine the current input origin');
    } finally { await bridge.close(); await new Promise<void>(resolve => peerServer.close(() => resolve())); }
  } finally { rmSync(root, { recursive: true }); }
});

posix('queue-full, duplicate, and rate limit report their drop reason', async () => {
  const { root, configDir, stateDir } = tempHome();
  const fake = fakeCtx();
  try {
    const host = createOpenCodeHost({
      openCodeSessionId: 'ses_drops', title: 'Drops', cwd: '/tmp',
      session: fake.ctx.session, agent: fake.ctx.agent,
      isRunning: () => false, recentInputs: () => [], pid: process.pid,
    });
    const bridge = new Bridge(randomUUID(), configDir, stateDir, join(root, 'x.sock'), host);
    const socks = join(root, 'socks');
    mkdirSync(socks, { recursive: true, mode: 0o700 });
    chmodSync(socks, 0o700);
    // A fake peer with a real private socket, so receive() finds the sender and the receipts have a target.
    const peerId = randomUUID();
    const peerPath = join(root, 'peer.sock');
    const receipts: Array<Record<string, unknown>> = [];
    const peerServer = net.createServer(socket => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          receipts.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
        }
      });
    });
    peerServer.listen(peerPath);
    await once(peerServer, 'listening');
    chmodSync(peerPath, 0o600);
    mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
      pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath, cwd: root,
      peerProtocol: 1, peerFeatures: ['notify_idle'], startedAt: 1700000000000,
    }));
    try {
      const generation = bridge.beginSession();
      await bridge.start(socks, '/tmp', generation);
      const inboxPath = peers(configDir).find(p => p.sessionId === bridge.threadId)?.messagingSocketPath;
      expect(inboxPath).toBeTruthy();
      const transmit = async (frame: Record<string, unknown>) => {
        const socket = net.createConnection(inboxPath!);
        await once(socket, 'connect');
        socket.end(JSON.stringify({ msgV: 1, from: `uds:${peerPath}`, ...frame }) + '\n');
        await once(socket, 'close');
      };
      const message = async (text: string) => {
        const id = randomUUID();
        await transmit({ type: 'user', msg_id: id, session_id: bridge.threadId,
          message: { role: 'user', content: `<cross-session-message from-mode="prompting">${text}</cross-session-message>` } });
        return id;
      };
      const until = async (condition: () => boolean, timeoutMs = 2000) => {
        const deadline = Date.now() + timeoutMs;
        while (!condition() && Date.now() < deadline) await Bun.sleep(5);
        expect(condition()).toBe(true);
      };
      // Duplicate: the same body within 30s is dropped.
      const first = await message('repeat');
      await until(() => bridge.status().messages.some(row => row.id === first && row.status !== 'pending'));
      const duplicate = await message('repeat');
      await until(() => bridge.status().messages.some(row => row.id === duplicate && row.drop_reason === 'duplicate'));
      // Rate limit: 30 unique bodies exhaust the burst budget.
      for (let i = 0; i < 30; i++) await message(`unique ${i}`);
      const limited = await message('unique overflow');
      await until(() => bridge.status().messages.some(row => row.id === limited && row.drop_reason === 'rate-limited'));
      // Queue-full: pre-fill to exactly 50 unread, then one more is dropped.
      const db = new Database(join(stateDir, `${bridge.threadId}.sqlite`));
      try {
        const need = 50 - bridge.status().unreadCount;
        expect(need).toBeGreaterThan(0);
        db.transaction(() => {
          for (let i = 0; i < need; i++) db.run(
            "INSERT INTO messages (id,peer_id,direction,text,status,awaiting_input,desktop_input_id) VALUES (?,?,'in',?,'steered',1,?)",
            [randomUUID(), peerId, `prefill ${i}`, randomUUID()]);
        })();
        expect(bridge.status().unreadCount).toBe(50);
        const overflow = await message('overflow');
        await until(() => bridge.status().messages.some(row => row.id === overflow && row.drop_reason === 'queue-full'));
      } finally { db.close(); }
    } finally { await bridge.close(); await new Promise<void>(resolve => peerServer.close(() => resolve())); }
  } finally { rmSync(root, { recursive: true }); }
});

posix('host runtime mode is bypass, prompting, or unknown from V27 agent rules', async () => {
  const fake = fakeCtx();
  const parts = {
    openCodeSessionId: 'ses_v27', title: 'V27', cwd: '/tmp',
    session: fake.ctx.session,
    agent: { async list() { return [{ permissions: [{ action: 'shell', pattern: '*', permission: 'allow' }, { action: 'edit', pattern: '*', permission: 'allow' }] }]; } },
    isRunning: () => false, recentInputs: () => [], pid: process.pid,
  };
  expect((await createOpenCodeHost(parts).runtime()).mode).toBe('bypass');
  expect((await createOpenCodeHost({ ...parts, agent: { async list() { return [{ permissions: [{ action: 'shell', pattern: '*', permission: 'ask' }, { action: 'edit', pattern: '*', permission: 'allow' }] }]; } } }).runtime()).mode).toBe('prompting');
  expect((await createOpenCodeHost({ ...parts, agent: { async list() { return []; } } }).runtime()).mode).toBe('unknown');
});

posix('setup returns a cleanup function only when the required APIs are available', async () => {
  const { root, configDir, stateDir } = tempHome();
  const co = ensureCoordinator(configDir, stateDir);
  const { default: plugin } = await import('../src/opencode');
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined;
  try {
    cleanup = await plugin.setup(fakeCtx().ctx);
    const missing = await plugin.setup({ app: { version: '2.1.2' } });
    expect({ cleanup: typeof cleanup, missing }).toEqual({ cleanup: 'function', missing: undefined });
  } finally {
    if (typeof cleanup === 'function') await cleanup();
    await resetCoordinator(co);
    rmSync(root, { recursive: true });
  }
});
