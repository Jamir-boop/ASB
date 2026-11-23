import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { agyProcess, agyProcessStart, agyRecordsDir, readAgyRecords, type AgyIdentity, type AgyRecord } from '../../src/antigravity-data.mjs';
import { agyMailboxDir } from '../../src/agy-mailbox.mjs';
import { Bridge, policySchema } from './bridge';
import { agyReceiverError, agyRuntime, cleanAgyMailbox, createAgyHost } from './agy-host';
import { peers, privateDirectory } from './claude';
import { brief, listSessions, listSessionsInput, sendMessage, sendMessageInput, statusBrief } from './tools';
import { version } from './version';

// off until the live kitty proof: MCP start timing, ancestry, empty-prompt rule, and @ or / paste menus are not proven
const AGY_KITTY_DELIVERY = false;
const NO_RECORD = 'ASB has no agy hook record for this process. Install the ASB agy hook and start a new agy session.';
const META_KEY = 'antigravity.google/root_conversation_id';

export function checkAgyCaller(meta: Record<string, unknown> | undefined, id: string) {
  const caller = meta?.[META_KEY];
  if (typeof caller !== 'string' || caller.toLowerCase() !== id) throw new Error('The agy MCP caller does not match the bound conversation. Nothing sent.');
}

function matching(records: AgyRecord[], identity: AgyIdentity) {
  return records.filter(row => row.agyPid === identity.agyPid && row.agyStartTicks === identity.agyStartTicks);
}

function newest(records: AgyRecord[], identity: AgyIdentity) {
  return matching(records, identity).sort((a, b) => b.stateAtMs - a.stateAtMs || b.createdAtMs - a.createdAtMs)[0];
}

function socketDirectory(env: NodeJS.ProcessEnv) {
  const directory = join(env.XDG_RUNTIME_DIR || `/tmp/asb-bridge-socks-${process.getuid!()}`, env.XDG_RUNTIME_DIR ? 'asb-bridge-socks' : '');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDirectory(directory);
  return directory;
}

type Bound = { bridge: Bridge; host: ReturnType<typeof createAgyHost> };

export function bindAgy({ identity, env, home, kittyDelivery, pid = process.pid, now = Date.now,
  read = () => readAgyRecords(agyRecordsDir(env, home), home), startOf = agyProcessStart, installed = () => true }:
  { identity: AgyIdentity | null; env: NodeJS.ProcessEnv; home: string; kittyDelivery: boolean; pid?: number;
    now?: () => number; read?: () => Promise<AgyRecord[]>; startOf?: typeof agyProcessStart; installed?: () => boolean }) {
  const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const state = join(home, '.local', 'state', 'asb-bridge', 'agy');
  const mailbox = agyMailboxDir(env);
  const deadline = now() + 30_000;
  let receiver: Bound | undefined;
  let polling: Promise<boolean> | undefined;
  let stopped = false;
  let sawRecord = false;
  let receiverError = identity ? 'Waiting for the agy SessionStart hook record.' : 'ASB could not find the agy parent process.';

  const live = async () => identity && await startOf(identity.agyPid).catch(() => null) === identity.agyStartTicks;
  const latest = async () => identity && await live() && installed() ? newest(await read(), identity) : undefined;

  async function release() {
    const old = receiver;
    receiver = undefined;
    if (!old) return;
    try {
      await old.host.close();
      await old.bridge.updateRuntime(agyRuntime(undefined));
    } finally { await old.bridge.close(); }
  }

  async function poll() {
    if (stopped) return false;
    if (!identity) return true; // The MCP tools can explain why no receiver is available.
    if (!await live() || !installed()) {
      receiverError = agyReceiverError;
      await release();
      return false;
    }
    if (!sawRecord && now() >= deadline) {
      receiverError = NO_RECORD;
      return true;
    }
    const records = await read();
    const record = newest(records, identity);
    if (!record) {
      await receiver?.host.poll(undefined);
      await receiver?.bridge.updateRuntime(agyRuntime(undefined));
      return true;
    }
    sawRecord = true;
    const id = record.conversationId;
    if (receiver && receiver.bridge.threadId !== id) await release();
    if (!receiver) {
      const readBound = async () => {
        const next = await latest();
        return next?.conversationId === id ? next : undefined;
      };
      const host = createAgyHost({ id, pid, mailbox, read: readBound, kittyDelivery, now });
      let bridge: Bridge | undefined;
      try {
        bridge = new Bridge(id, config, state, '', host);
        await bridge.start(socketDirectory(env), record.workspace);
      } catch {
        await bridge?.close().catch(() => {});
        receiverError = host.receiverError;
        return true;
      }
      receiver = { bridge, host };
      const otherReceivers = new Set(peers(config).filter(peer => peer.pid !== pid).map(peer => peer.sessionId));
      for (const own of matching(records, identity)) {
        if (!otherReceivers.has(own.conversationId)) await cleanAgyMailbox(mailbox, own.conversationId);
      }
    }
    await receiver.host.poll(record);
    await receiver.bridge.updateRuntime(agyRuntime(record));
    return true;
  }

  function tick() {
    return polling ??= poll().finally(() => { polling = undefined; });
  }
  return {
    tick,
    current(meta: Record<string, unknown> | undefined) {
      if (!receiver || stopped) throw new Error(receiverError);
      checkAgyCaller(meta, receiver.bridge.threadId);
      return receiver.bridge;
    },
    async close() {
      stopped = true;
      await polling?.catch(() => {});
      await release();
    },
  };
}

async function main() {
  const env = process.env, home = homedir();
  const binding = bindAgy({ identity: await agyProcess(process.pid), env, home, kittyDelivery: AGY_KITTY_DELIVERY,
    installed: () => existsSync(import.meta.path) });
  const server = new McpServer({ name: 'asb-bridge', version }, { instructions: 'Message other agents.' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const current = async (meta: Record<string, unknown> | undefined) => {
    const initial = binding.current(meta);
    await binding.tick();
    const bridge = binding.current(meta);
    if (bridge !== initial) throw new Error('The agy conversation changed. Nothing sent.');
    return bridge;
  };
  server.registerTool('list_sessions', { description: 'List ASB peers here and on other machines. Send by reference or by sessionId.',
    inputSchema: listSessionsInput, annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ nameContains }, extra) => {
    const bridge = await current(extra._meta);
    return result(await listSessions(bridge.threadId, bridge.configDir, nameContains));
  });
  server.registerTool('send_message', { description: 'Send plain text to one ASB peer by reference or sessionId. notify_when_idle alone asks for an idle notice.',
    inputSchema: sendMessageInput, annotations: { openWorldHint: true } }, async (args, extra) => {
    const bridge = await current(extra._meta);
    return result(await sendMessage(args, () => bridge));
  });
  server.registerTool('status', { description: 'Show the ASB receiver and recent outcomes. Check unknown outcomes before resending.',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async (_args, extra) => result(statusBrief(await current(extra._meta))));
  server.registerTool('inbox', { description: 'Check the held count or ask the user to change the inbox policy. Held text stays out of context.',
    inputSchema: { view: z.enum(['policy', 'held']) }, annotations: { openWorldHint: false } }, async ({ view }, extra) => {
    const bridge = await current(extra._meta);
    if (view === 'held') return result({ heldCount: bridge.held().length });
    if (!server.server.getClientCapabilities()?.elicitation) throw new Error('This agy client cannot show an ASB inbox policy dialog.');
    const answer = await server.server.elicitInput({ mode: 'form', message: `ASB Bridge inbox policy. Currently: ${bridge.policy()}.`,
      requestedSchema: { type: 'object', properties: { policy: { type: 'string', title: 'Inbox',
        enum: ['default', 'accept', 'hold', 'refuse'] } }, required: ['policy'] } });
    const active = binding.current(extra._meta);
    if (active !== bridge) throw new Error('The agy conversation changed. No policy changed.');
    if (answer.action === 'accept') await active.setPolicy(policySchema.parse(answer.content?.policy));
    return result({ action: answer.action, ...brief(active.status()) });
  });

  let timer: ReturnType<typeof setInterval>;
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    void binding.close().catch(() => console.error('agy Bridge cleanup failed.')).finally(() => server.close());
  };
  const update = () => { void binding.tick().then(live => { if (!live) shutdown(); }).catch(() => console.error('agy Bridge poll failed.')); };
  server.server.onclose = shutdown;
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
  if (closing) return;
  timer = setInterval(update, 1000);
  update();
}

if (import.meta.main) await main();
