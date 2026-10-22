// OpenCode 2 plugin entry. A plain object works today (V7); no @opencode/plugin import.
// One coordinator on globalThis holds the receivers; each setup() instance owns its location.
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Bridge } from './bridge';
import { peers, privateDirectory, removeStaleReceivers } from './claude';
import { createOpenCodeHost, opencodeBridgeId, type OpenCodeHostParts } from './opencode-host';
import { placeholderCommand, spawnPlaceholder } from './placeholder';
import { isWindows } from './platform';
import { listSessions, listSessionsInput, sendMessage, sendMessageInput, statusBrief } from './tools';
import { version } from './version';

const COORDINATOR = Symbol.for('asb.bridge.opencode');
const CAP = 24;
const START_LIMIT = 8;
const START_WINDOW_MS = 30 * 60 * 1000;
const IDLE_MS = 12 * 60 * 60 * 1000;
const SEEN_LIMIT = 256;

type SessionInfo = {
  id: string;
  title?: string | undefined;
  cwd?: string | undefined;
  parentID?: string | undefined;
  time?: { updated?: number; idle?: number } | undefined;
  archived?: boolean | undefined;
};

type Receiver = {
  bridge: Bridge;
  host: ReturnType<typeof createOpenCodeHost>;
  placeholder: { pid: number; kill(): void };
  openCodeSessionId: string;
  bridgeId: string;
  location: string;
  title: string | undefined;
  cwd: string;
  lastActivity: number;
  running: boolean;
  limited: boolean;
  closed: boolean;
};

type Instance = {
  ctx: any;
  directory: string;
  disposers: Array<() => void>;
};

type RegisterResult = Receiver | { limited: true; openCodeSessionId: string; bridgeId: string };

type Coordinator = {
  instances: Map<string, Instance>;
  receivers: Map<string, Receiver>;
  registering: Map<string, Promise<RegisterResult | undefined>>;
  running: Set<string>;
  seen: Set<string>;
  configDir: string;
  stateDir: string;
};

function coordinator(): Coordinator | undefined {
  return (globalThis as Record<symbol, unknown>)[COORDINATOR] as Coordinator | undefined;
}

function ensureCoordinator(configDir: string, stateDir: string): Coordinator {
  const existing = coordinator();
  if (existing) return existing;
  const next: Coordinator = { instances: new Map(), receivers: new Map(), registering: new Map(), running: new Set(), seen: new Set(), configDir, stateDir };
  (globalThis as Record<symbol, unknown>)[COORDINATOR] = next;
  return next;
}

function remember(co: Coordinator, id: string) {
  if (co.seen.has(id)) return false;
  co.seen.add(id);
  if (co.seen.size > SEEN_LIMIT) co.seen.delete(co.seen.values().next().value!);
  return true;
}

function bridgeIdOf(sessionId: string) {
  return opencodeBridgeId(sessionId);
}

function sessionCwd(session: SessionInfo) {
  return session.cwd || process.cwd();
}

function titleOf(session: SessionInfo) {
  return session.title;
}

// The OpenCode plugin client wraps HTTP results as { data }. A plain array or object is also accepted.
function unwrap<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) return (value as { data: T }).data;
  return value as T;
}

async function listLocationSessions(instance: Instance): Promise<SessionInfo[]> {
  try {
    const rows = unwrap<SessionInfo[]>(await instance.ctx.session.list({ directory: instance.directory }));
    return (Array.isArray(rows) ? rows : []) as SessionInfo[];
  } catch (error) { return []; }
}

async function getSession(instance: Instance, id: string): Promise<SessionInfo | undefined> {
  try { return unwrap<SessionInfo>(await instance.ctx.session.get({ sessionID: id })); }
  catch (error) { return undefined; }
}

function socketDirectory(configDir: string) {
  let directory = join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'asb-bridge-socks');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
  } catch (error) {
    directory = `/tmp/asb-bridge-socks-${process.getuid?.() ?? 0}`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
  }
  void configDir;
  return directory;
}

function registerSession(co: Coordinator, instance: Instance, session: SessionInfo): Promise<RegisterResult | undefined> {
  if (session.parentID) return Promise.resolve(undefined);
  const pending = co.registering.get(session.id);
  if (pending) return pending;
  const run = registerSessionOnce(co, instance, session).finally(() => co.registering.delete(session.id));
  co.registering.set(session.id, run);
  return run;
}

async function registerSessionOnce(co: Coordinator, instance: Instance, session: SessionInfo): Promise<RegisterResult | undefined> {
  if (session.parentID || co.instances.get(instance.directory) !== instance) return undefined;
  const existing = co.receivers.get(session.id);
  if (existing && !existing.closed) {
    existing.lastActivity = Date.now();
    existing.title = titleOf(session);
    existing.host.setTitle(existing.title);
    try { existing.bridge.updateRuntime(await existing.host.runtime()); } catch (error) { /* Still registered. */ }
    return existing;
  }
  if (co.receivers.size >= CAP) {
    const victim = [...co.receivers.values()].filter(row => !row.running && !row.limited && !row.bridge.held().length)
      .sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (!victim) return { limited: true as const, openCodeSessionId: session.id, bridgeId: bridgeIdOf(session.id) };
    await unregister(co, victim.openCodeSessionId);
  }
  const cwd = sessionCwd(session);
  const title = titleOf(session);
  const bridgeId = bridgeIdOf(session.id);
  const command = placeholderCommand();
  let placeholder: { pid: number; kill(): void };
  try {
    const child = spawnPlaceholder(command);
    placeholder = { pid: child.pid, kill: () => { try { child.kill(); } catch (error) { /* Gone. */ } } };
  } catch (error) {
    return { limited: true as const, openCodeSessionId: session.id, bridgeId };
  }
  const parts: OpenCodeHostParts = {
    openCodeSessionId: session.id,
    title,
    cwd,
    session: instance.ctx.session,
    agent: instance.ctx.agent,
    isRunning: async (id) => {
      if (co.running.has(id)) return true;
      // V25: a session is running when time.updated > time.idle. The event set can miss a start.
      try {
        const session = await getSession(instance, id);
        const time = session?.time;
        if (time && typeof time.updated === 'number' && typeof time.idle === 'number') return time.updated > time.idle;
      } catch (error) { /* Treat as idle. */ }
      return false;
    },
    recentInputs: id => recentInputs(instance, id),
    pid: placeholder.pid,
  };
  const host = createOpenCodeHost(parts);
  const bridge = new Bridge(bridgeId, co.configDir, co.stateDir, '', host);
  const receiver: Receiver = {
    bridge, host, placeholder, openCodeSessionId: session.id, bridgeId,
    location: instance.directory, title, cwd, lastActivity: Date.now(),
    running: co.running.has(session.id), limited: false, closed: false,
  };
  const generation = bridge.beginSession();
  try {
    await bridge.start(isWindows() ? '' : socketDirectory(co.configDir), cwd, generation);
  } catch (error) {
    placeholder.kill();
    await bridge.close().catch(() => {});
    throw error;
  }
  bridge.updateRuntime(await host.runtime());
  // The instance was cleaned up during the start: do not leave a receiver that nobody owns.
  if (co.instances.get(instance.directory) !== instance) {
    receiver.closed = true;
    await bridge.close().catch(() => {});
    placeholder.kill();
    return undefined;
  }
  co.receivers.set(session.id, receiver);
  return receiver;
}

// After a plugin reload the host map is empty: take the last message of the OpenCode session context.
async function recentInputs(instance: Instance, openCodeSessionId: string) {
  const ctx = instance?.ctx;
  if (!ctx?.session?.context) return [];
  try {
    const value = unwrap<unknown>(await ctx.session.context({ sessionID: openCodeSessionId }));
    const rows = (Array.isArray(value) ? value : (value as { messages?: unknown[] })?.messages) ?? [];
    const mapped = [...rows].reverse().map(row => {
      const message = row as { id?: string; type?: string; text?: string; content?: string };
      const text = message.text ?? (typeof message.content === 'string' ? message.content : '');
      const kind = message.type === 'user' ? 'user' : message.type === 'synthetic' ? 'synthetic' : 'other';
      return { id: String(message.id ?? ''), kind: kind as 'user' | 'synthetic' | 'other', text };
    }).filter(row => row.id);
    return mapped.filter(row => row.kind !== 'other').slice(0, 1);
  } catch (error) { return []; }
}

async function unregister(co: Coordinator, openCodeSessionId: string) {
  const receiver = co.receivers.get(openCodeSessionId);
  if (!receiver) return;
  co.receivers.delete(openCodeSessionId);
  receiver.closed = true;
  try { await receiver.bridge.close(); } catch (error) { /* Already closing. */ }
  receiver.placeholder.kill();
}

async function deleteSession(co: Coordinator, openCodeSessionId: string) {
  const receiver = co.receivers.get(openCodeSessionId);
  await unregister(co, openCodeSessionId);
  // After archive the receiver is gone; the state file still has to go on delete.
  const bridgeId = receiver?.bridgeId ?? bridgeIdOf(openCodeSessionId);
  try { rmSync(join(co.stateDir, `${bridgeId}.sqlite`), { force: true }); } catch (error) { /* Gone. */ }
}

function touch(co: Coordinator, openCodeSessionId: string) {
  const receiver = co.receivers.get(openCodeSessionId);
  if (receiver) receiver.lastActivity = Date.now();
}

function findInstanceFor(co: Coordinator, openCodeSessionId: string): Instance | undefined {
  const receiver = co.receivers.get(openCodeSessionId);
  if (receiver) return co.instances.get(receiver.location);
  return co.instances.values().next().value;
}

function receiverOf(co: Coordinator, openCodeSessionId: string) {
  return co.receivers.get(openCodeSessionId);
}

async function noteActivity(co: Coordinator, instance: Instance, session: SessionInfo) {
  touch(co, session.id);
  await registerSession(co, instance, session);
}

async function handleEvent(co: Coordinator, event: { id?: string; type?: string; data?: Record<string, unknown> }) {
  const id = event.id;
  if (id && !remember(co, id)) return;
  const data = event.data ?? {};
  const sessionId = String(data.sessionID ?? data.sessionId ?? '');
  const type = event.type ?? '';
  const instance = sessionId ? findInstanceFor(co, sessionId) : co.instances.values().next().value;
  if (!instance) return;
  const session = sessionId ? (await getSession(instance, sessionId) ?? { id: sessionId, title: data.title as string | undefined, cwd: data.cwd as string | undefined, parentID: data.parentID as string | undefined }) : undefined;
  if (!session) return;

  if (type === 'session.created') return;
  if (type === 'session.renamed') {
    const receiver = receiverOf(co, session.id);
    if (!receiver) return;
    const title = String(data.title ?? session.title ?? '');
    receiver.title = title;
    receiver.host.setTitle(title);
    try { receiver.bridge.updateRuntime(await receiver.host.runtime()); } catch (error) { /* Keep the old name. */ }
    return;
  }
  if (type === 'session.execution.started') {
    if (session.parentID) return;
    co.running.add(session.id);
    const receiver = await registerSession(co, instance, session);
    if (receiver && 'bridge' in receiver) {
      receiver.running = true;
      receiver.lastActivity = Date.now();
      receiver.bridge.updateRuntime(await receiver.host.runtime());
    }
    return;
  }
  if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.execution.interrupted') {
    co.running.delete(session.id);
    const receiver = receiverOf(co, session.id);
    if (!receiver) return;
    receiver.running = false;
    receiver.lastActivity = Date.now();
    receiver.bridge.updateRuntime(await receiver.host.runtime());
    return;
  }
  if (type === 'session.archived') {
    co.running.delete(session.id);
    await unregister(co, session.id);
    return;
  }
  if (type === 'session.deleted') {
    co.running.delete(session.id);
    await deleteSession(co, session.id);
    return;
  }
  if (type === 'session.inbox.delivered') {
    const receiver = receiverOf(co, session.id);
    receiver?.host.noteDelivered(String(data.inboxID ?? ''));
    touch(co, session.id);
    return;
  }
  if (type === 'session.inbox.enqueued') {
    const receiver = receiverOf(co, session.id);
    // Real shape: item: { type: 'user', payload: { text }, delivery }. id is the inboxID.
    const item = data.item as { type?: string; id?: string; text?: string; payload?: { text?: string } | undefined } | undefined;
    const text = item?.text ?? item?.payload?.text ?? '';
    if (item?.type === 'user') receiver?.host.noteHuman(String(text), String(item.id ?? data.inboxID ?? randomUUID()));
    touch(co, session.id);
    return;
  }
}

async function sweep(co: Coordinator) {
  await removeStaleReceivers(co.configDir, '', 'opencode-asb-bridge').catch(() => {});
  // Per-thread sweep of every live row of this entrypoint.
  for (const row of peers(co.configDir)) {
    if (row.entrypoint !== 'opencode-asb-bridge') continue;
    await removeStaleReceivers(co.configDir, row.sessionId, 'opencode-asb-bridge').catch(() => {});
  }
}

async function expireIdle(co: Coordinator) {
  const now = Date.now();
  for (const receiver of [...co.receivers.values()]) {
    if (receiver.running || receiver.bridge.held().length) continue;
    const status = receiver.bridge.status();
    if (status.idleRequests.some(request => request.status === 'waiting')) continue;
    if (now - receiver.lastActivity >= IDLE_MS) await unregister(co, receiver.openCodeSessionId);
  }
}

function readPluginConfig(): { claudeConfigDir: string; stateDir: string } {
  const folder = dirname(import.meta.path);
  const path = join(folder, 'asb-bridge.json');
  if (existsSync(path)) {
    try {
      const parsed = z.object({ claudeConfigDir: z.string(), stateDir: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8')));
      return parsed;
    } catch (error) { /* Fall through. */ }
  }
  return {
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude'),
    stateDir: join(process.env.HOME ?? '', '.local', 'state', 'asb-bridge'),
  };
}

function toolInput(schema: z.ZodType) {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

export default {
  id: 'asb.bridge',
  version,
  async setup(ctx: any) {
    const appVersion = String(ctx.app?.version ?? '0');
    const missing = !ctx.session?.synthetic || !ctx.tool?.transform || !ctx.event?.subscribe || compareVersion(appVersion, '2.1.2') < 0;
    if (missing) return {};
    const { claudeConfigDir, stateDir } = readPluginConfig();
    const co = ensureCoordinator(claudeConfigDir, stateDir);
    mkdirSync(co.stateDir, { recursive: true, mode: 0o700 });
    privateDirectory(co.stateDir);
    const directory = String(ctx.location?.directory ?? process.cwd());
    const instance: Instance = { ctx, directory, disposers: [] };
    co.instances.set(directory, instance);

    await sweep(co);
    const recent = (await listLocationSessions(instance))
      .filter(session => !session.parentID && !session.archived)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, START_LIMIT);
    for (const session of recent) {
      if ((session.time?.updated ?? 0) < Date.now() - START_WINDOW_MS) continue;
      await registerSession(co, instance, session).catch(() => {});
    }

    // R1: subscribe takes options and returns an async iterable of { id, type, data }.
    const controller = new AbortController();
    let events: unknown;
    try {
      events = ctx.event.subscribe({ signal: controller.signal });
    } catch (error) { events = undefined; }
    instance.disposers.push(() => controller.abort());
    if (typeof (events as { [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator] !== 'function') {
      console.error('ASB Bridge: OpenCode events are not available.');
    } else {
      void (async () => {
        try {
          for await (const event of events as AsyncIterable<unknown>) {
            if (controller.signal.aborted) break;
            try {
              await handleEvent(co, event as { id?: string; type?: string; data?: Record<string, unknown> });
            } catch (error) {
              console.error('ASB Bridge: event handling failed.', error);
            }
          }
        } catch (error) { /* Aborted or stream ended. */ }
      })();
    }

    ctx.tool.transform((editor: any) => {
      editor.namespace({ name: 'asb_bridge', description: 'Message other agents.' });
      editor.add({
        name: 'list_sessions',
        description: 'List agents here and on other machines of the group (remote: true). Send by reference if an entry has one, else by sessionId. Names, folders, and IDs can repeat: a sessionId goes to the local agent first. Status is idle or busy now only. agent is claude, codex, or opencode. nameContains: part of name.',
        input: toolInput(listSessionsInput),
        options: { namespace: 'asb_bridge' },
        execute: async (input: unknown, toolCtx: { sessionID?: string }) => {
          const sessionId = String(toolCtx?.sessionID ?? '');
          const rootId = await ensureToolReceiver(co, sessionId) ?? sessionId;
          touch(co, rootId);
          const receiver = receiverOf(co, rootId);
          const caller = receiver?.bridgeId ?? bridgeIdOf(rootId);
          return { content: JSON.stringify(await listSessions(caller, co.configDir, (input as { nameContains?: string })?.nameContains)) };
        },
      });
      editor.add({
        name: 'send_message',
        description: 'Send text to one agent. Its answer enters the current OpenCode turn, or starts one if the session is idle. Batch what you say into one message: a rapid burst to one agent is refused. Give sessionId (UUID from list_sessions) or reference (asb:1/... as given: exactly that session, on any machine of the group). notify_when_idle alone sends nothing and asks for one idle notice (only for a session on this machine).',
        input: toolInput(sendMessageInput),
        options: { namespace: 'asb_bridge' },
        execute: async (input: unknown, toolCtx: { sessionID?: string }) => {
          const sessionId = String(toolCtx?.sessionID ?? '');
          const rootId = await ensureToolReceiver(co, sessionId) ?? sessionId;
          const receiver = receiverOf(co, rootId);
          if (!receiver) return { content: JSON.stringify({ error: 'This OpenCode session is not registered.' }) };
          touch(co, rootId);
          return { content: JSON.stringify(await sendMessage(input as Record<string, unknown>, () => receiver.bridge)) };
        },
      });
      editor.add({
        name: 'status',
        description: 'Show receiver and recent outcomes. It starts at the first turn; no tool restarts it. Check unknown outcomes before resending.',
        input: toolInput(z.object({})),
        options: { namespace: 'asb_bridge' },
        execute: async (_input: unknown, toolCtx: { sessionID?: string }) => {
          const sessionId = String(toolCtx?.sessionID ?? '');
          const rootId = await ensureToolReceiver(co, sessionId) ?? sessionId;
          const receiver = receiverOf(co, rootId);
          if (!receiver) return { content: JSON.stringify({ openCodeSessionId: rootId, registered: false, reason: 'limit' }) };
          touch(co, rootId);
          return { content: JSON.stringify({ ...statusBrief(receiver.bridge), openCodeSessionId: rootId, registered: true }) };
        },
      });
    });

    const timer = setInterval(() => { void expireIdle(co).catch(() => {}); }, 60 * 60 * 1000);
    timer.unref?.();
    instance.disposers.push(() => clearInterval(timer));

    return {
      async cleanup() {
        for (const disposer of instance.disposers) { try { disposer(); } catch (error) { /* Already gone. */ } }
        co.instances.delete(directory);
        await Promise.allSettled([...co.registering.values()]);
        for (const receiver of [...co.receivers.values()]) {
          if (receiver.location === directory) await unregister(co, receiver.openCodeSessionId).catch(() => {});
        }
        if (!co.instances.size) {
          delete (globalThis as Record<symbol, unknown>)[COORDINATOR];
        }
      },
    };
  },
};

// Q9: a subagent never registers; its tool call sends as the root session.
async function rootSessionId(instance: Instance, openCodeSessionId: string): Promise<string> {
  let id = openCodeSessionId;
  for (let i = 0; i < 8; i++) {
    const session = await getSession(instance, id);
    const parent = session?.parentID;
    if (!parent) return id;
    id = parent;
  }
  return id;
}

async function ensureToolReceiver(co: Coordinator, openCodeSessionId: string): Promise<string | undefined> {
  if (!openCodeSessionId) return undefined;
  const instance = findInstanceFor(co, openCodeSessionId);
  if (!instance) return undefined;
  const rootId = await rootSessionId(instance, openCodeSessionId);
  const session = await getSession(instance, rootId) ?? { id: rootId, cwd: process.cwd() };
  await registerSession(co, instance, session as SessionInfo).catch(() => {});
  return rootId;
}

function compareVersion(a: string, b: string) {
  const left = a.split('.').map(part => Number(part) || 0);
  const right = b.split('.').map(part => Number(part) || 0);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export { ensureCoordinator, coordinator, registerSession, unregister, deleteSession, handleEvent, bridgeIdOf, rootSessionId, recentInputs, CAP, START_LIMIT, START_WINDOW_MS, IDLE_MS };
