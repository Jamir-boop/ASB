import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { maxLineLength, peers, uuid } from './claude';
import { engineRuntime, listReferences, referenceText, remotePeers, type ListedReference } from './engine';
import { Bridge, expirySchema, policySchema } from './bridge';
import { codexIpcPath } from './codex';
import { HeldDialogs } from './held-dialogs';
import { version } from './version';

const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const stateDir = join(codexHome, 'plugin-state', 'asb-bridge');
const hookPath = join(import.meta.dir, `hook${extname(import.meta.path)}`);
let bridge: Bridge | undefined;
let dialogs: HeldDialogs | undefined;

export function callerThread(meta: Record<string, unknown> | undefined): string {
  let turn: unknown = meta?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = undefined; } }
  const parsed = z.object({ thread_id: uuid }).safeParse(turn);
  const candidate = parsed.success ? parsed.data.thread_id :
    meta?.threadId ?? meta?.thread_id;
  return uuid.parse(candidate);
}

function current(meta: Record<string, unknown> | undefined) {
  const id = callerThread(meta);
  if (bridge && bridge.threadId !== id) throw new Error('This MCP process is already bound to another Codex task');
  if (!bridge) {
    bridge = new Bridge(id, configDir, stateDir, codexIpcPath(codexHome));
    dialogs = new HeldDialogs(bridge, server);
  }
  return bridge;
}

function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }; }
// Recent message rows without null fields: each tool call returns this into the model context.
function brief(status: ReturnType<Bridge['status']>) {
  return { ...status, messages: status.messages.slice(0, 5).map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))) };
}
// Codex copies these instructions into every bridge tool description, so they stay one short line.
// The safety notice travels with each incoming message instead.
const server = new McpServer({ name: 'asb-bridge', version }, { instructions: 'Message other agents.' });

async function startReceiver(threadId: string, cwd: string) {
  const child = Bun.spawn([process.execPath, hookPath],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe', env: process.env });
  child.stdin.write(JSON.stringify({ session_id: threadId, cwd, hook_event_name: 'SessionStart' }));
  child.stdin.end();
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error.trim() || 'Session receiver hook failed');
  dialogs?.start();
}

server.registerTool('session_start', { description: 'Bind the native SessionStart lifecycle hook and start the receiver.',
  inputSchema: { cwd: z.string().refine(isAbsolute) }, _meta: { ui: { visibility: [] } } }, async ({ cwd }, extra) => {
  await startReceiver(current(extra._meta).threadId, cwd);
  return { content: [] };
});

// startedAt in whole seconds: the sort below uses the milliseconds of the peer row, so the order does not change.
const seconds = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

server.registerTool('list_sessions', { description: 'List agents here and on other machines of the group (remote: true). Send by reference if an entry has one, else by sessionId. Names, folders, and IDs can repeat: a sessionId goes to the local agent first. Status is idle or busy now only. agent is claude or codex. nameContains: part of name.',
  inputSchema: { nameContains: z.string().min(1).max(128).optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ nameContains }, extra) => {
  const caller = callerThread(extra._meta);
  // ASB relay proxy rows stand for remote sessions; the engine lists those below with their machine.
  const local = peers(configDir).filter(peer => peer.entrypoint !== 'asb-relay');
  // Rows without a start time stay last. Fields that are null are left out: each call returns this into the model context.
  const rows = local.filter(peer => peer.sessionId !== caller)
    .sort((first, second) => (second.startedAt ?? -1) - (first.startedAt ?? -1))
    .map(peer => ({ sessionId: peer.sessionId, name: peer.name,
      agent: peer.entrypoint === 'codex-asb-bridge' ? 'codex' : 'claude',
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
  return result(part === undefined ? listed : listed.filter(row => row.name.toLowerCase().includes(part)));
});
// The advertised schema is a plain string, which is shorter for the model. The checks run in the handler, before the caller is read and before anything is sent.
server.registerTool('send_message', { description: 'Send text to one agent. Its answer enters the current Codex turn, or starts one if the task is idle. Batch what you say into one message: a rapid burst to one agent is refused. Give sessionId (UUID from list_sessions) or reference (asb:1/... as given: exactly that session, on any machine of the group). notify_when_idle alone sends nothing and asks for one idle notice (only for a session on this machine).',
  inputSchema: { sessionId: z.string().optional(), reference: z.string().optional(),
    text: z.string().min(1).max(maxLineLength).optional(), notify_when_idle: z.boolean().default(false) }, annotations: { openWorldHint: true } },
  async ({ sessionId, reference, text, notify_when_idle }, extra) => {
    if (sessionId !== undefined && !uuid.safeParse(sessionId).success) throw new Error('Input validation error: sessionId must be a UUID from list_sessions. Nothing sent.');
    if (reference !== undefined && !referenceText.safeParse(reference).success) throw new Error('Input validation error: reference must be a full session reference (asb:1/...). Nothing sent.');
    if ((sessionId === undefined) === (reference === undefined)) throw new Error('Give exactly one of sessionId or reference.');
    const bridge = current(extra._meta);
    return result(await (reference === undefined ? bridge.sendMessage(sessionId!, text, notify_when_idle) : bridge.sendReference(reference, text, notify_when_idle)));
  });
server.registerTool('status', { description: 'Show receiver and recent outcomes. It starts at the first turn; no tool restarts it. A null replyAddress in a turn means untrusted hooks or a failed SessionStart: ask the user to check hook trust. Check unknown outcomes before resending.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
  async (_args, extra) => result(brief(current(extra._meta).status())));
server.registerTool('inbox', { description: 'Ask the user in a dialog. view: policy (accept, hold, refuse, default), expiry (how long held messages wait), held (review the oldest). Only the answer releases held input. Held text stays out of your context.',
  inputSchema: { view: z.enum(['policy', 'held', 'expiry']) }, annotations: { openWorldHint: false } }, async ({ view }, extra) => {
  const bridge = current(extra._meta);
  if (view === 'expiry') {
    const answer = await server.server.elicitInput({ mode: 'form', message: `Deadline for messages held by the permission-mode comparison. Currently: ${bridge.dialogExpiry()}.`,
      requestedSchema: { type: 'object', properties: { expiry: { type: 'string', title: 'Expiry',
        enum: ['60s', '5m', '10m', 'never'], enumNames: ['One minute', 'Five minutes', 'Ten minutes', 'No expiry'] } }, required: ['expiry'] } });
    if (answer.action === 'accept') await bridge.setExpiry(expirySchema.parse(answer.content?.expiry));
    return result({ action: answer.action, ...brief(bridge.status()) });
  }
  if (view === 'policy') {
    const answer = await server.server.elicitInput({ mode: 'form',
      message: `ASB Bridge. Inbox of this Codex task. Currently: ${bridge.policy()}. Accept also delivers held messages. Refuse discards them.`,
      requestedSchema: { type: 'object', properties: { policy: { type: 'string', title: 'Inbox',
        enum: ['default', 'accept', 'hold', 'refuse'], enumNames: ['Default: compare permission modes', 'Accept: receive', 'Hold: keep back', 'Refuse: reject'] } }, required: ['policy'] } });
    if (answer.action === 'accept') await bridge.setPolicy(policySchema.parse(answer.content?.policy));
    return result({ action: answer.action, ...brief(bridge.status()) });
  }
  const held = bridge.held()[0];
  if (!held) return result({ heldCount: 0 });
  if (bridge.policy() === 'hold') return result({ heldCount: bridge.held().length,
    instruction: 'Explicit hold only releases after the user changes the policy. Open inbox with view: policy.' });
  return result({ ...await dialogs?.review(), ...brief(bridge.status()) });
});

// After a Codex restart, threads load again without a turn. The thread that spawned this process can need a moment to become reachable.
let reviving: Bun.Subprocess | undefined;
const revivals = [1000, 5000, 15000, 60000].map(delay => setTimeout(() => {
  if (reviving?.exitCode === null && reviving.signalCode === null) return;
  reviving = Bun.spawn([process.execPath, hookPath, '--revive'],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit', env: process.env });
}, delay).unref());

server.server.onclose = () => { for (const timer of revivals) clearTimeout(timer); void (async () => { await dialogs?.close(); await bridge?.close(); })()
  .catch(() => console.error('Bridge shutdown failed.')); };
await server.connect(new StdioServerTransport());
