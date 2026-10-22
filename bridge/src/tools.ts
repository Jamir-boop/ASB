// Shared bodies of the bridge tools. The Codex MCP server and the OpenCode plugin both call these,
// so the arguments, results, limits, and error texts stay identical.
import { z } from 'zod';
import { maxLineLength, peers, uuid } from './claude';
import { resolve } from 'node:path';
import { engineRuntime, listReferences, referenceText, remotePeers, type ListedReference } from './engine';
import type { Bridge } from './bridge';

export const listSessionsInput = z.object({ nameContains: z.string().min(1).max(128).optional() });
export const sendMessageInput = z.object({ sessionId: z.string().optional(), reference: z.string().optional(),
  text: z.string().min(1).max(maxLineLength).optional(), notify_when_idle: z.boolean().default(false) });

export function agentLabel(entrypoint: string | undefined) {
  return entrypoint === 'codex-asb-bridge' ? 'codex' as const : entrypoint === 'opencode-asb-bridge' ? 'opencode' as const : 'claude' as const;
}

// startedAt in whole seconds: the sort below uses the milliseconds of the peer row, so the order does not change.
const seconds = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Recent message rows without null fields: each tool call returns this into the model context.
export function brief(status: ReturnType<Bridge['status']>) {
  return { ...status, messages: status.messages.slice(0, 5).map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))) };
}

export type ListedSession = { sessionId: string; name: string; agent: 'codex' | 'opencode' | 'claude'; cwd?: string;
  status: string; startedAt?: string; remote?: boolean; machine?: string } & Partial<ListedReference>;

export async function listSessions(caller: string, configDir: string, nameContains?: string): Promise<ListedSession[]> {
  // ASB relay proxy rows stand for remote sessions; the engine lists those below with their machine.
  const local = peers(configDir).filter(peer => peer.entrypoint !== 'asb-relay');
  // Rows without a start time stay last. Fields that are null are left out: each call returns this into the model context.
  const rows = local.filter(peer => peer.sessionId !== caller)
    .sort((first, second) => (second.startedAt ?? -1) - (first.startedAt ?? -1))
    .map(peer => ({ sessionId: peer.sessionId, name: peer.name,
      agent: agentLabel(peer.entrypoint),
      cwd: peer.cwd, status: peer.status,
      ...(peer.startedAt === undefined ? {} : { startedAt: seconds(peer.startedAt) }) }));
  const runtime = engineRuntime();
  const [remote, references] = runtime ? await Promise.all([remotePeers(runtime).catch(() => []),
    listReferences(runtime, { runtimeSessionId: caller, configDir: resolve(configDir) })]) : [[], new Map<string, ListedReference>()];
  // A sessionId send goes to the local session, so a remote entry with a seen ID is reachable only by its reference.
  const seen = new Set([caller, ...local.map(peer => peer.sessionId)]);
  const listed = [...rows.map(row => ({ ...row, ...references.get(row.sessionId) })), ...remote.flatMap(peer => {
    const reference = references.get(`${peer.machineId}:${peer.sessionId}`);
    if (seen.has(peer.sessionId) && !(reference && 'reference' in reference)) return [];
    return [{ sessionId: peer.sessionId, name: `${peer.machineName}-${peer.name}`, agent: peer.agent, status: peer.status,
      remote: true, machine: peer.machineName, ...reference }];
  })];
  const part = nameContains?.toLowerCase();
  return part === undefined ? listed : listed.filter(row => row.name.toLowerCase().includes(part));
}

// getBridge is lazy: the validation texts run before the caller is bound and before anything is sent.
export async function sendMessage(args: { sessionId?: string; reference?: string; text?: string; notify_when_idle?: boolean }, getBridge: () => Bridge) {
  const { sessionId, reference, text, notify_when_idle: notifyWhenIdle = false } = sendMessageInput.parse(args);
  if (sessionId !== undefined && !uuid.safeParse(sessionId).success) throw new Error('Input validation error: sessionId must be a UUID from list_sessions. Nothing sent.');
  if (reference !== undefined && !referenceText.safeParse(reference).success) throw new Error('Input validation error: reference must be a full session reference (asb:1/...). Nothing sent.');
  if ((sessionId === undefined) === (reference === undefined)) throw new Error('Give exactly one of sessionId or reference.');
  return reference === undefined ? getBridge().sendMessage(sessionId!, text, notifyWhenIdle) : getBridge().sendReference(reference, text, notifyWhenIdle);
}

export function statusBrief(bridge: Bridge) {
  return brief(bridge.status());
}
