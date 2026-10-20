import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { maxLineLength, peers, uuid } from './claude';
import { engineRuntime, remotePeers } from './engine';
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
// Codex copies these instructions into every bridge tool description, so they stay one line.
// The safety notice travels with each incoming message instead.
const server = new McpServer({ name: 'asb-bridge', version }, { instructions:
  'Message local Claude Code and Codex agents: list_sessions, then send_message by sessionId.' });

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

server.registerTool('list_sessions', { description: 'List the live agents on this machine and, in a machine group, on the other machines (remote: true), most recently started first. Pick one by sessionId: names and working directories repeat across agents, and status tells you idle or busy right now, not how long an agent has sat idle. Start time separates them.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async (_args, extra) => {
  const caller = callerThread(extra._meta);
  // ASB relay proxy rows stand for remote sessions; the engine lists those below with their machine.
  const local = peers(configDir).filter(peer => peer.entrypoint !== 'asb-relay');
  const rows = local.filter(peer => peer.sessionId !== caller)
    .map(peer => ({ sessionId: peer.sessionId, name: peer.name,
      agent: peer.entrypoint === 'codex-asb-bridge' ? 'codex' : 'claude',
      cwd: peer.cwd, status: peer.status,
      startedAt: peer.startedAt === undefined ? null : new Date(peer.startedAt).toISOString() }))
    .sort((first, second) => (second.startedAt ?? '').localeCompare(first.startedAt ?? ''));
  const runtime = engineRuntime();
  const remote = runtime ? await remotePeers(runtime).catch(() => []) : [];
  const seen = new Set([caller, ...local.map(peer => peer.sessionId)]);
  return result([...rows, ...remote.filter(peer => !seen.has(peer.sessionId)).map(peer => ({ sessionId: peer.sessionId,
    name: `${peer.machineName}-${peer.name}`, agent: peer.agent, cwd: null, status: peer.status, startedAt: null, remote: true, machine: peer.machineName }))]);
});
server.registerTool('send_message', { description: 'Send text to one listed agent, or set notify_when_idle alone to subscribe without sending. Its answer enters the current Codex turn, or starts one when this task is idle. Batch what you have to say into one message: a rapid burst to the same agent is refused.',
  inputSchema: { sessionId: uuid, text: z.string().min(1).max(maxLineLength).optional(), notify_when_idle: z.boolean().default(false) }, annotations: { openWorldHint: true } },
  async ({ sessionId, text, notify_when_idle }, extra) => result(await current(extra._meta).sendMessage(sessionId, text, notify_when_idle)));
server.registerTool('status', { description: 'Show this task\'s receiver, transport and recent outcomes. The receiver starts at the first turn and when Codex reloads a registered task. A null replyAddress in a turn means untrusted hooks or a failed SessionStart: ask the user to check hook trust. No tool restarts it. Check unknown outcomes before resending.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
  async (_args, extra) => result(brief(current(extra._meta).status())));
server.registerTool('inbox', { description: 'Open a dialog the user answers. Use view policy to set accept, hold, refuse or default, view expiry to set how long a held message waits, and view held to put the oldest held message in front of the user. Only that answer releases held input, and the held text stays out of your context either way.',
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
