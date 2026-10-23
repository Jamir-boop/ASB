// The OpenCode host behind one Bridge: synthetic delivery, event-backed runtime, and the inboxID map.
// Policy, receipts, idle notices, limits, and hop chains stay in Bridge.
import { createHash } from 'node:crypto';
import type { Host } from './bridge';
import { bridgeNameBase } from './claude';
import type { Inputs } from './desktop-input';
import type { Runtime } from './desktop';

// Fixed namespace for the bridge UUID of an OpenCode session. UUID v5 of `opencode:<ses_...>` is stable across restarts.
export const OPENCODE_NAMESPACE = 'a5b8c9d0-1e2f-4a3b-8c7d-9e0f1a2b3c4d';

export function uuidV5(name: string, namespace: string = OPENCODE_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function opencodeBridgeId(openCodeSessionId: string) {
  return uuidV5(`opencode:${openCodeSessionId}`);
}

// V27: mode is only for the outgoing `from-mode` of frames that OpenCode sends.
// The last matching rule wins, as in OpenCode.
export function modeFromRules(permissions: unknown): Runtime['mode'] {
  const parsed = Array.isArray(permissions) ? permissions : null;
  if (!parsed) return 'unknown';
  const effective = (action: string) => {
    let answer: string | undefined;
    for (const row of parsed) {
      const rule = row as { action?: unknown; resource?: unknown; pattern?: unknown; effect?: unknown; permission?: unknown };
      const resource = typeof rule.resource === 'string' ? rule.resource : rule.pattern;
      const effect = typeof rule.effect === 'string' ? rule.effect : rule.permission;
      if ((rule.action !== action && rule.action !== '*') || resource !== '*') continue;
      if (effect === 'allow' || effect === 'ask' || effect === 'deny') answer = effect;
    }
    return answer;
  };
  const shell = effective('shell');
  const edit = effective('edit');
  if (shell === 'allow' && edit === 'allow') return 'bypass';
  if (shell === 'ask' || edit === 'ask') return 'prompting';
  return 'unknown';
}

export type OpenCodeSessionLike = {
  synthetic(input: { sessionID: string; text: string; delivery: 'steer' | 'queue' }): Promise<unknown>;
  context(input: { sessionID: string }): Promise<unknown>;
  list(input?: { directory?: string }): Promise<unknown[]>;
  get(input: { sessionID: string }): Promise<unknown>;
};

export type OpenCodeAgentLike = { list(): Promise<unknown[]> };

// The OpenCode plugin client wraps HTTP results as { data }. A plain array or object is also accepted.
export function unwrap<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) return (value as { data: T }).data;
  return value as T;
}

export type OpenCodeHostParts = {
  openCodeSessionId: string;
  title?: string | undefined;
  session: OpenCodeSessionLike;
  agent: OpenCodeAgentLike;
  // The running set is owned by the coordinator; the host only reads it.
  isRunning(sessionId: string): boolean | Promise<boolean>;
  // Newest-first messages of the session, used after a plugin reload. May be async (ctx.session.context is a Promise).
  recentInputs(sessionId: string): Array<{ id: string; kind: 'user' | 'synthetic' | 'other'; text: string }> | Promise<Array<{ id: string; kind: 'user' | 'synthetic' | 'other'; text: string }>>;
  // The placeholder PID of this receiver, written into the registry row.
  pid: number;
};

type PendingInput = { id: string; clientId: string | null; kind: 'user' | 'synthetic' | 'other'; text: string };

export function createOpenCodeHost(parts: OpenCodeHostParts): Host & {
  noteDelivered(inboxId: string): void;
  noteHuman(text: string, id: string): void;
  peekLatest(): Promise<PendingInput | null | undefined>;
  setTitle(title: string | undefined): void;
} {
  const delivered = new Map<string, PendingInput>();
  const ownIds = new Set<string>();
  let latest: PendingInput | null | undefined;
  let restorePromise: Promise<void> | undefined;
  let liveTitle = parts.title;

  const restore = () => {
    if (!restorePromise) {
      restorePromise = (async () => {
        for (const item of await parts.recentInputs(parts.openCodeSessionId)) {
          const row = { id: item.id, clientId: null, kind: item.kind, text: item.text };
          // A live deliver/noteHuman origin wins over the context fallback.
          if (latest === undefined) latest = row;
          if (item.kind !== 'other') break;
        }
      })();
    }
    return restorePromise;
  };

  return {
    entrypoint: 'opencode-asb-bridge',
    transport: 'opencode',
    remoteAgent: 'claude',
    replyHint: 'Reply with tools.asb_bridge.send_message.',
    identity: { pid: parts.pid },
    nameBase: (cwd) => namedOpenCode(cwd, liveTitle),
    extraRow: { opencodeSessionId: parts.openCodeSessionId },
    setTitle(title: string | undefined) { liveTitle = title; },
    receiverError: 'This OpenCode session has no active receiver or has more than one registration. The receiver starts at the first turn '
      + 'and when OpenCode loads a session that registered before. If it stays inactive during a turn, ask the user to open the ASB Bridge plugin. No tool restarts it.',
    async runtime() {
      const permissions = await sessionPermissions(parts);
      const running = await parts.isRunning(parts.openCodeSessionId);
      return { status: running ? 'busy' : 'idle', mode: modeFromRules(permissions) };
    },
    async inputs() {
      await restore();
      const drained = [...delivered.values()];
      delivered.clear();
      if (drained.length) latest = drained[drained.length - 1]!;
      return { latest, consumed: drained.map(row => ({ id: row.id, clientId: row.clientId })) };
    },
    async deliver(inputId, text) {
      const idle = !(await parts.isRunning(parts.openCodeSessionId));
      const result = unwrap<{ id: string }>(await parts.session.synthetic({ sessionID: parts.openCodeSessionId, text, delivery: 'steer' }));
      const id = result?.id ?? String(Date.now());
      ownIds.add(id);
      delivered.set(id, { id, clientId: inputId, kind: 'synthetic', text });
      latest = { id, clientId: inputId, kind: 'synthetic', text };
      return { status: idle ? 'started' : 'steered', turnId: null };
    },
    noteDelivered(inboxId) {
      const row = delivered.get(inboxId);
      if (!row) return;
      // Keep the row in `delivered` so the next inputs() reports it and Bridge frees the unread slot.
      latest = row;
    },
    noteHuman(text, id) {
      // Synthetic deliveries also land as inbox.enqueued user items. Keep their hop origin.
      if (ownIds.has(id)) return;
      const row = { id, clientId: null, kind: 'user' as const, text };
      latest = row;
    },
    async peekLatest() { await restore(); return latest; },
  };
}

// OpenCode 2.1.4 fields: session.agent is an agent id (no key for the default agent), session.permissions is optional, and agent.list() entries have id, name, and permissions.
async function sessionPermissions(parts: OpenCodeHostParts) {
  try {
    const session = unwrap<{ agent?: unknown; permissions?: unknown } | undefined>(await parts.session.get({ sessionID: parts.openCodeSessionId }));
    const list = unwrap<Array<{ id?: unknown; permissions?: unknown }>>(await parts.agent.list());
    if (!Array.isArray(list)) return undefined;
    const id = session?.agent;
    const agent = typeof id === 'string' && id ? list.find(entry => entry?.id === id) : list[0];
    if (!Array.isArray(agent?.permissions)) return undefined;
    return Array.isArray(session?.permissions) ? [...agent.permissions, ...session.permissions] : agent.permissions;
  } catch { return undefined; }
}

// Same rule as codex-<title>-<suffix>, with the fixed OpenCode prefix. uniqueName adds the suffix.
export function namedOpenCode(cwd: string, title: string | undefined) {
  return bridgeNameBase('opencode', title, cwd);
}
