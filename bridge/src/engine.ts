// Finds the local ASB engine through its service.json and calls its message relay routes (plan 16.4).
// On Linux and Windows; macOS has no engine for the bridge yet.
import { lstatSync } from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';
import { z } from 'zod';
import { ownedJson, privateDirectory, uuid } from './claude';
import { isWindows } from './platform';

export type EngineRuntime = { pid: number; port: number; schema: 1; sourceToken: string };
const runtimeSchema = z.strictObject({ pid: z.number().int().positive().max(2147483647), port: z.number().int().min(1).max(65535),
  schema: z.literal(1), sourceToken: z.string().regex(/^[a-f0-9]{64}$/) });
const remotePeerSchema = z.object({ machineId: z.string().regex(/^[a-f0-9]{16}$/), machineName: z.string().min(1).max(64), online: z.literal(true),
  sessionId: uuid, name: z.string().min(1).max(128), agent: z.enum(['claude', 'codex']), status: z.string().max(32) });
export type RemotePeer = z.infer<typeof remotePeerSchema>;

// The same rules as readServiceRuntime in scripts/asb-instance.mjs: a private folder, an owned 0600 file, exact keys, a live PID.
// Windows has no modes: <LOCALAPPDATA>\asb\run\service.json, with no links (src/platform-paths.mjs runtimeDir).
function folderRuntime(folder: string, platform: string): EngineRuntime | null {
  const file = join(folder, 'service.json');
  try {
    privateDirectory(folder, platform);
    if (!isWindows(platform) && (lstatSync(file).mode & 0o777) !== 0o600) return null;
    const runtime = runtimeSchema.parse(ownedJson(file, 4096, platform));
    process.kill(runtime.pid, 0);
    return runtime;
  } catch { return null; }
}

// The first candidate folder whose service.json passes the checks.
export function engineRuntime(env: Record<string, string | undefined> = process.env, platform: string = process.platform): EngineRuntime | null {
  const folders: string[] = [];
  if (isWindows(platform)) {
    if (!env.LOCALAPPDATA || !win32.isAbsolute(env.LOCALAPPDATA)) return null;
    folders.push(join(env.LOCALAPPDATA, 'asb', 'run'));
  } else if (platform === 'linux') {
    // An agent process can lack XDG_RUNTIME_DIR while the engine has it. An engine without it uses the state folder (plan L7).
    folders.push(join(env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : `/run/user/${process.getuid?.()}`, 'asb'));
    const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME
      : env.HOME && isAbsolute(env.HOME) ? join(env.HOME, '.local', 'state') : '';
    if (state) folders.push(join(state, 'asb', 'run'));
  } else return null;
  for (const folder of folders) {
    const runtime = folderRuntime(folder, platform);
    if (runtime) return runtime;
  }
  return null;
}

export async function engineRequest(runtime: EngineRuntime, route: string, { method = 'GET', body, timeoutMs }: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}) {
  const origin = `http://127.0.0.1:${runtime.port}`;
  const response = await fetch(`${origin}${route}`, { method, redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs ?? (method === 'POST' && route === '/api/relay/send' ? 12_000 : 2_000)),
    headers: { 'x-asb-source-token': runtime.sourceToken, ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bytes = await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`The ASB engine answered HTTP ${response.status}`);
  if (bytes.byteLength > 1024 * 1024) throw new Error('The ASB engine reply is too large');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

// The sessions on the other machines of the group; invalid entries are dropped.
export async function remotePeers(runtime: EngineRuntime) {
  const reply = z.object({ peers: z.array(z.unknown()) }).parse(await engineRequest(runtime, '/api/relay/remote-peers'));
  return reply.peers.flatMap(peer => {
    const parsed = remotePeerSchema.safeParse(peer);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 256);
}

// A full session reference as the engine and send_message take it.
export const referenceText = z.string().max(384).regex(/^asb:[\x21-\x7e]+$/);
const reason = z.string().max(64).regex(/^[a-z][a-z-]*$/);
// Exactly one of reference or referenceUnavailable, and no other key.
const listItem = <T extends z.ZodRawShape>(keys: T) =>
  z.union([z.strictObject({ ...keys, reference: referenceText }), z.strictObject({ ...keys, referenceUnavailable: reason })]);
const localItem = listItem({ sessionId: uuid });
const remoteItem = listItem({ machineId: z.string().regex(/^[a-f0-9]{16}$/), sessionId: uuid });
const listReply = z.strictObject({ apiVersion: z.literal(1), ok: z.literal(true), pid: z.number().int().positive(),
  local: z.array(z.unknown()), remote: z.array(z.unknown()) });
export type ListedReference = { reference: string } | { referenceUnavailable: string };

// The reference of each listed session, or its reason code: keyed by sessionId (local) and <machineId>:<sessionId> (remote).
// Invalid items are dropped. Any error or other reply gives an empty map, so list_sessions stays as it is without the engine.
export async function listReferences(runtime: EngineRuntime, caller: { runtimeSessionId: string; configDir: string }) {
  const found = new Map<string, ListedReference>();
  let reply: z.infer<typeof listReply>;
  // On Windows the engine binds only for a bridge that proves the pipe server before each bound write.
  try { reply = listReply.parse(await engineRequest(runtime, '/api/agent/list-references', { method: 'POST',
    body: { caller, ...(isWindows() ? { pipeProof: true } : {}) } })); }
  catch { return found; }
  if (reply.pid !== runtime.pid) return found;
  const value = (item: { reference?: string; referenceUnavailable?: string }): ListedReference =>
    item.reference !== undefined ? { reference: item.reference } : { referenceUnavailable: item.referenceUnavailable! };
  for (const entry of reply.local.slice(0, 256)) {
    const item = localItem.safeParse(entry);
    if (item.success) found.set(item.data.sessionId, value(item.data));
  }
  for (const entry of reply.remote.slice(0, 256)) {
    const item = remoteItem.safeParse(entry);
    if (item.success) found.set(`${item.data.machineId}:${item.data.sessionId}`, value(item.data));
  }
  return found;
}
