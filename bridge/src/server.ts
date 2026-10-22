import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { uuid } from './claude';
import { Bridge, policySchema } from './bridge';
import { codexIpcPath } from './codex';
import { brief, listSessions, listSessionsInput, sendMessage, sendMessageInput, statusBrief } from './tools';
import { version } from './version';

const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const stateDir = join(codexHome, 'plugin-state', 'asb-bridge');
const hookPath = join(import.meta.dir, `hook${extname(import.meta.path)}`);
let bridge: Bridge | undefined;

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
  }
  return bridge;
}

function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }; }
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
}

server.registerTool('session_start', { description: 'Bind the native SessionStart lifecycle hook and start the receiver.',
  inputSchema: { cwd: z.string().refine(isAbsolute) }, _meta: { ui: { visibility: [] } } }, async ({ cwd }, extra) => {
  await startReceiver(current(extra._meta).threadId, cwd);
  return { content: [] };
});

server.registerTool('list_sessions', { description: 'List agents here and on other machines of the group (remote: true). Send by reference if an entry has one, else by sessionId. Names, folders, and IDs can repeat: a sessionId goes to the local agent first. Status is idle or busy now only. agent is claude or codex. nameContains: part of name.',
  inputSchema: listSessionsInput, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ nameContains }, extra) =>
  result(await listSessions(callerThread(extra._meta), configDir, nameContains)));
// The advertised schema is a plain string, which is shorter for the model. The checks run in the handler, before the caller is read and before anything is sent.
server.registerTool('send_message', { description: 'Send text to one agent. Its answer enters the current Codex turn, or starts one if the task is idle. Batch what you say into one message: a rapid burst to one agent is refused. Give sessionId (UUID from list_sessions) or reference (asb:1/... as given: exactly that session, on any machine of the group). notify_when_idle alone sends nothing and asks for one idle notice (only for a session on this machine).',
  inputSchema: sendMessageInput, annotations: { openWorldHint: true } },
  async (args, extra) => result(await sendMessage(args, () => current(extra._meta))));
server.registerTool('status', { description: 'Show receiver and recent outcomes. It starts at the first turn; no tool restarts it. A null replyAddress in a turn means untrusted hooks or a failed SessionStart: ask the user to check hook trust. Check unknown outcomes before resending.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
  async (_args, extra) => result(statusBrief(current(extra._meta))));
server.registerTool('inbox', { description: 'Ask the user in a dialog. view: policy (accept, hold, refuse, default), held (how many wait). Only the answer releases held input. Held text stays out of your context.',
  inputSchema: { view: z.enum(['policy', 'held']) }, annotations: { openWorldHint: false } }, async ({ view }, extra) => {
  const bridge = current(extra._meta);
  if (view === 'policy') {
    const answer = await server.server.elicitInput({ mode: 'form',
      message: `ASB Bridge. Inbox of this Codex task. Currently: ${bridge.policy()}. Accept also delivers held messages. Refuse discards them.`,
      requestedSchema: { type: 'object', properties: { policy: { type: 'string', title: 'Inbox',
        enum: ['default', 'accept', 'hold', 'refuse'], enumNames: ['Default: accept every message', 'Accept: receive', 'Hold: keep back', 'Refuse: reject'] } }, required: ['policy'] } });
    if (answer.action === 'accept') await bridge.setPolicy(policySchema.parse(answer.content?.policy));
    return result({ action: answer.action, ...brief(bridge.status()) });
  }
  const held = bridge.held()[0];
  if (!held) return result({ heldCount: 0 });
  return result({ heldCount: bridge.held().length,
    instruction: 'Held input only releases after the user changes the policy. Open inbox with view: policy.' });
});

// After a Codex restart, threads load again without a turn. The thread that spawned this process can need a moment to become reachable.
let reviving: Bun.Subprocess | undefined;
const revivals = [1000, 5000, 15000, 60000].map(delay => setTimeout(() => {
  if (reviving?.exitCode === null && reviving.signalCode === null) return;
  reviving = Bun.spawn([process.execPath, hookPath, '--revive'],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit', env: process.env });
}, delay).unref());

server.server.onclose = () => { for (const timer of revivals) clearTimeout(timer); void (async () => { await bridge?.close(); })()
  .catch(() => console.error('Bridge shutdown failed.')); };
await server.connect(new StdioServerTransport());
