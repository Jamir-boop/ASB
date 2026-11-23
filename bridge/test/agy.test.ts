import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { agyProcess, type AgyRecord } from '../../src/antigravity-data.mjs';
import { takeAgyMailbox } from '../../src/agy-mailbox.mjs';
import { bindAgy, checkAgyCaller } from '../src/agy';
import { agyReceiverError, agyRuntime, createAgyHost, promptZone } from '../src/agy-host';
import { DeliveryRefused } from '../src/delivery';
import { peers } from '../src/claude';

const linux = test.skipIf(process.platform !== 'linux');
const meta = (id: string) => ({ 'antigravity.google/root_conversation_id': id });
const identity = { agyPid: 222, agyStartTicks: '333' };
const body = '[ASB Bridge peer message from Fixture.]\nNext\tline';
const screen = (text = '', tail = '') => `case output\n╭───────────╮\n${
  text.split('\n').map((line, index) => `│ ${index ? ' ' : '›'} ${line}   │`).join('\n')
}\n╰───────────╯\n${tail}`;

function fixture(kittyDelivery = true, listenOn = 'unix:/fake/kitty.sock') {
  const root = mkdtempSync('/tmp/asb-agy-');
  const mailbox = join(root, 'asb-agy-mailbox');
  const id = randomUUID();
  const base = join(mailbox, id);
  const env = { HOME: root, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude') };
  let time = Date.now();
  let record: AgyRecord = { ...identity, conversationId: id, workspace: root, state: 'idle', event: 'SessionStart',
    stateAtMs: time - 2_000, createdAtMs: time - 3_000 };
  const update = (fields: Partial<AgyRecord>) => record = { ...record, ...fields };
  const calls: string[][] = [];
  let checks = 0;
  let view = screen();
  const setScreen = (text: string) => { view = text; };
  let afterRead: (() => Promise<unknown>) | undefined;
  let afterPaste: (() => void) | undefined;
  let validFocus = true;
  const runStop = () => takeAgyMailbox({ conversationId: id }, env);
  const host = createAgyHost({ id, pid: process.pid, mailbox, now: () => time, read: async () => record,
    kittyDelivery, focus: async () => { checks++; return validFocus ? { listenOn, windowId: '2' } : null; },
    exec: async args => {
      calls.push(args);
      if (args[3] === 'get-text') await afterRead?.();
      return view;
    }, wait: async ms => { expect(ms).toBe(150); view = screen(body); afterPaste?.(); } });
  return { root, mailbox, base, id, env, host, update, calls, setScreen, runStop, close: () => rmSync(root, { recursive: true, force: true }),
    checks: () => checks, now: () => time, advance: (ms: number) => time += ms, poll: () => host.poll(record),
    beforeGetText: (fn: typeof afterRead) => { afterRead = fn; }, afterPaste: (fn: typeof afterPaste) => { afterPaste = fn; },
    invalidateTarget: () => { validFocus = false; } };
}

linux('finds an agy ancestor through at most eight parents, including the immediate parent', async () => {
  const read = (agyPid: number) => async (pid: number, name: string) => name === 'comm' ? (pid === agyPid ? 'agy' : 'sh') :
    `${pid} (test) S ${pid - 1} ${Array(17).fill('0').join(' ')} 333 0`;
  for (const depth of [1, 8]) expect(await agyProcess(100, read(100 - depth))).toEqual({ agyPid: 100 - depth, agyStartTicks: '333' });
  expect(await agyProcess(100, read(91))).toBeNull();
  expect(await agyProcess(100, async () => { throw new Error(); })).toBeNull();
});

linux('binds only the newest matching hook record, changes conversation, and cleans only its stale mailbox files', async () => {
  const f = fixture(false);
  const former = randomUUID(), wrong = randomUUID();
  const a = f.update({});
  let rows = [a, { ...a, conversationId: former, stateAtMs: a.stateAtMs - 1 },
    { ...a, conversationId: wrong, agyStartTicks: 'different', stateAtMs: a.stateAtMs + 1 }];
  let ticks = identity.agyStartTicks;
  const binding = bindAgy({ identity, home: f.root, env: f.env, kittyDelivery: false, read: async () => rows, startOf: async () => ticks });
  try {
    mkdirSync(f.mailbox, { mode: 0o700 });
    for (const id of [f.id, former, wrong]) for (const suffix of ['.msg', '.msg.83', '.msg.old.tmp', '.taken', '.continued']) {
      writeFileSync(join(f.mailbox, `${id}${suffix}`), 'stale', { mode: 0o600 });
    }
    await binding.tick();
    expect(binding.current(meta(f.id.toUpperCase())).status().transport).toBe('agy');
    expect(peers(f.env.CLAUDE_CONFIG_DIR)[0]).toMatchObject({ entrypoint: 'agy-asb-bridge', agyConversationId: f.id, name: expect.stringMatching(/^agy-/) });
    expect(statSync(join(f.root, '.local/state/asb-bridge/agy')).mode & 0o777).toBe(0o700);
    expect(readdirSync(f.mailbox).every(name => name.startsWith(wrong))).toBe(true);
    expect(() => binding.current(meta(wrong))).toThrow('does not match');
    expect(() => checkAgyCaller(undefined, f.id)).toThrow('does not match');
    expect(() => checkAgyCaller({ conversation_id: f.id }, f.id)).toThrow('does not match');
    const first = binding.current(meta(f.id));
    await first.updateRuntime({ status: 'busy', mode: 'unknown' });
    rows = [{ ...a, conversationId: former, stateAtMs: a.stateAtMs + 5 }];
    await binding.tick();
    expect(() => binding.current(meta(f.id))).toThrow('does not match');
    expect(binding.current(meta(former)).status().threadId).toBe(former);
    expect(peers(f.env.CLAUDE_CONFIG_DIR).map(p => p.sessionId)).toEqual([former]);
    ticks = 'reused';
    expect(await binding.tick()).toBe(false);
    expect(peers(f.env.CLAUDE_CONFIG_DIR)).toEqual([]);
  } finally { await binding.close(); f.close(); }
});

linux('no matching record for 30 seconds changes the error without stopping receiver discovery', async () => {
  const f = fixture(false);
  let rows: AgyRecord[] = [];
  const binding = bindAgy({ identity, home: f.root, env: f.env, kittyDelivery: false, read: async () => rows,
    startOf: async () => identity.agyStartTicks, now: f.now });
  try {
    await binding.tick();
    expect(() => binding.current(meta(f.id))).toThrow('Waiting');
    f.advance(30_001);
    await binding.tick();
    expect(() => binding.current(meta(f.id))).toThrow('no agy hook record');
    expect(peers(f.env.CLAUDE_CONFIG_DIR)).toEqual([]);
    rows = [f.update({ stateAtMs: f.now() })];
    await binding.tick();
    expect(binding.current(meta(f.id)).status()).toMatchObject({ threadId: f.id, transport: 'agy', replyAddress: expect.any(String) });
    expect(peers(f.env.CLAUDE_CONFIG_DIR).map(peer => peer.sessionId)).toEqual([f.id]);
  } finally { await binding.close(); f.close(); }
});

linux('two agy receivers for one conversation keep exactly one registration and a clear receiverError', async () => {
  const f = fixture(false);
  const a = f.update({}), b = { ...a, agyPid: 999 };
  const placeholder = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
  const first = bindAgy({ identity, home: f.root, env: f.env, kittyDelivery: false, read: async () => [a], startOf: async () => '333' });
  const second = bindAgy({ identity: { ...identity, agyPid: b.agyPid }, home: f.root, env: f.env, kittyDelivery: false,
    pid: placeholder.pid, read: async () => [b], startOf: async () => '333' });
  try {
    await Promise.all([first.tick(), second.tick()]);
    const wins = [first, second].filter(candidate => { try { candidate.current(meta(f.id)); return true; } catch { return false; } });
    expect(wins).toHaveLength(1);
    const winner = wins[0]!;
    const loser = winner === first ? second : first;
    expect(() => loser.current(meta(f.id))).toThrow(agyReceiverError);
    expect(peers(f.env.CLAUDE_CONFIG_DIR)).toHaveLength(1);
    const inbox = winner.current(meta(f.id)).session();
    await loser.tick();
    expect(winner.current(meta(f.id)).session()).toEqual(inbox);
  } finally { await first.close(); await second.close(); placeholder.kill(); await placeholder.exited; f.close(); }
});

linux('maps runtime and refuses every prohibited control, 4001 characters, and 41 lines', async () => {
  const f = fixture(false);
  try {
    for (const state of ['idle', 'done', 'failed', 'working', 'question'] as const) {
      const record = f.update({ state });
      expect(agyRuntime(record)).toEqual({ status: ['working', 'question'].includes(state) ? 'busy' : 'idle', mode: 'unknown' });
      expect(agyRuntime({ ...record, background: true }).status).toBe('busy');
    }
    const controls = Array.from({ length: 160 }, (_, i) => i).filter(i => (i < 32 && i !== 9 && i !== 10) || i >= 127);
    for (const text of [...controls.map(i => `A${String.fromCharCode(i)}B`), 'a'.repeat(4001), Array(41).fill('x').join('\n')]) {
      await expect(f.host.deliver(randomUUID(), text)).rejects.toThrow(DeliveryRefused);
    }
    await expect(f.host.deliver(randomUUID(), 'newline\nand\ttab')).resolves.toEqual({ status: 'accepted', turnId: null });
    expect(f.calls).toEqual([]);
  } finally { await f.host.close(); f.close(); }
});

test('the MCP permission dialog is not an idle prompt with one or two borders', () => {
  const title = 'Antigravity CLI\nASB Bridge MCP tool: list_sessions';
  const border = '──────────────────────────────';
  const options = 'Allow calling this tool?\n> 1. Yes, allow tool call\n  2. Yes, allow this tool always\n  3. Yes, allow all tools from this server\n  4. No, deny tool call';
  const hint = '↑/↓ Navigate · tab Amend';
  expect(promptZone([title, border, options, hint].join('\n'))).toBeNull();
  expect(promptZone([title, border, options, border, hint].join('\n'))).toBeNull();
  expect(promptZone(`${title}\n${border}\n${options}\n${hint}\n${screen()}`)).toBeNull();
});

linux('an abstract kitty socket uses the Stop mailbox without reading the screen', async () => {
  const f = fixture(true, 'unix:@kitty-1234');
  try {
    await f.host.deliver(randomUUID(), body, true);
    await f.poll();
    expect(f.calls).toEqual([]);
    expect(await f.runStop()).toBe(body);
  } finally { await f.host.close(); f.close(); }
});

linux('gate keeps the mailbox file for a draft, a dialog, a working empty screen, a fresh Stop, and a background Stop', async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    await f.host.deliver(id, body, true);
    f.setScreen(screen('draft'));
    await f.poll();
    expect(promptZone(screen('draft'))).toEqual(['draft']);
    expect(JSON.parse(readFileSync(`${f.base}.msg`, 'utf8'))).toEqual({ id, text: body });
    expect(f.calls.map(row => row[3])).toEqual(['get-text']);
    f.setScreen(screen('', 'Permission required: Allow once'));
    await f.poll();
    expect(f.calls.map(row => row[3])).toEqual(['get-text', 'get-text']);
    f.setScreen(screen());
    f.update({ event: 'PreInvocation', state: 'working' });
    await f.poll();
    f.update({ event: 'Stop', state: 'done', stateAtMs: f.now() });
    await f.poll();
    f.update({ background: true });
    f.advance(1001);
    await f.poll();
    expect(f.calls.map(row => row[3])).toEqual(['get-text', 'get-text']);
    expect(JSON.parse(readFileSync(`${f.base}.msg`, 'utf8')).id).toBe(id);
  } finally { await f.host.close(); f.close(); }
});

linux('only a named input pastes, verifies the screen, and proves Return from a later PreInvocation', async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    await f.host.deliver(id, body, true);
    await f.poll();
    expect(promptZone(screen())).toEqual(['']);
    expect(f.calls.map(row => row[3])).toEqual(['get-text', 'send-text', 'get-text', 'send-key']);
    expect(f.checks()).toBe(4);
    for (const args of f.calls) {
      expect(args.slice(0, 3)).toEqual(['@', '--to', 'unix:/fake/kitty.sock']);
      expect(args.slice(4, 6)).toEqual(['--match', 'id:2']);
    }
    expect(f.calls[1]?.slice(6)).toEqual(['--bracketed-paste=enable', '--', body]);
    expect(f.calls[3]?.slice(6)).toEqual(['enter']);
    expect(existsSync(`${f.base}.msg`)).toBe(false);
    f.update({ event: 'PreInvocation', state: 'working', stateAtMs: f.advance(150) });
    await f.poll();
    expect((await f.host.inputs([id])).consumed).toEqual([{ id, clientId: id }]);
    expect((await f.host.inputs([])).consumed).toEqual([]);
    f.update({ event: 'Stop', state: 'idle' });
    f.advance(2000);
    await f.host.deliver(randomUUID(), body);
    await f.poll();
    expect(f.calls).toHaveLength(4);
    expect(existsSync(`${f.base}.msg`)).toBe(true);
  } finally { await f.host.close(); f.close(); }
});

const wrappedStart = '[ASB Bridge peer message from Fixture, sessionId';
const wrappedId = '11111111-2222-4333-8444-555555555555';
const wrappedBody = `${wrappedStart} ${wrappedId}. Reply with asb-bridge send_message.]\nNext line`;
for (const [kind, lines, verified] of [
  ['word wrap', [wrappedStart, `${wrappedId}. Reply with asb-bridge`, 'send_message.]', 'Next line'], true],
  ['wrap inside a word', [`${wrappedStart} ${wrappedId.slice(0, 17)}`, `${wrappedId.slice(17)}. Reply with asb-bridge`, 'send_message.]', 'Next line'], true],
  ['different text', [wrappedStart, `${wrappedId}. Reply with asb-bridge`, 'list_sessions.]', 'Next line'], false],
  ['missing body', [wrappedStart, `${wrappedId}. Reply with asb-bridge`, 'send_message.]'], false],
  ['different body', [wrappedStart, `${wrappedId}. Reply with asb-bridge`, 'send_message.]', 'Other line'], false],
  ['empty prompt', [''], false],
] as const) linux(`kitty post-paste check handles ${kind}`, async () => {
  const f = fixture();
  try {
    const border = '─'.repeat(71);
    const zone = lines.map((line, i) => `│${(i ? `  ${line}` : `> ${line}`).padEnd(71)}│`).join('\n');
    f.afterPaste(() => f.setScreen(`case output\n╭${border}╮\n${zone}\n╰${border}╯\n`));
    const id = randomUUID();
    await f.host.deliver(id, wrappedBody, true);
    await f.poll();
    expect(f.calls.map(args => args[3])).toEqual(verified ? ['get-text', 'send-text', 'get-text', 'send-key'] : ['get-text', 'send-text', 'get-text']);
    if (verified) {
      expect(f.calls[3]?.slice(6)).toEqual(['enter']);
      f.update({ event: 'PreInvocation', state: 'working', stateAtMs: f.advance(150) });
      await f.poll();
      expect((await f.host.inputs([id])).consumed).toEqual([{ id, clientId: id }]);
    } else {
      expect((await f.host.inputs([id])).lost).toEqual([{ id, clientId: id }]);
    }
  } finally { await f.host.close(); f.close(); }
});

for (const changed of ['text', 'event', 'target', 'no proof'] as const) linux(`never retries a kitty paste with ${changed}`, async () => {
  const f = fixture();
  try {
    f.afterPaste(() => {
      if (changed === 'text') f.setScreen(screen(`draft ${body.split('\n')[0]}`));
      if (changed === 'event') f.update({ event: 'PreInvocation', stateAtMs: f.advance(10) });
      if (changed === 'target') f.invalidateTarget();
    });
    const id = randomUUID();
    await f.host.deliver(id, body, true);
    await f.poll();
    expect(f.calls.some(args => args[3] === 'send-key')).toBe(changed === 'no proof');
    f.advance(5001);
    await f.poll();
    expect((await f.host.inputs([id])).lost).toEqual([{ id, clientId: id }]);
    expect((await f.host.inputs([])).lost).toEqual([]);
    expect(existsSync(`${f.base}.msg`)).toBe(false);
  } finally { await f.host.close(); f.close(); }
});

for (const winner of ['hook', 'kitty'] as const) linux(`the ${winner} wins the mailbox rename, never both`, async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    f.setScreen(screen('draft'));
    await f.host.deliver(id, body, true);
    await f.poll();
    f.setScreen(screen());
    let hookReply: string | null = null;
    if (winner === 'hook') f.beforeGetText(async () => { hookReply = await f.runStop(); });
    else f.afterPaste(() => { expect(existsSync(`${f.base}.msg`)).toBe(false); });
    await f.poll();
    if (winner === 'kitty') hookReply = await f.runStop();
    expect(hookReply).toBe(winner === 'hook' ? body : null);
    expect(f.calls.filter(args => args[3] === 'send-key')).toHaveLength(winner === 'kitty' ? 1 : 0);
    const at = winner === 'hook' ? statSync(`${f.base}.taken`).mtimeMs : f.now();
    f.update({ event: 'PreInvocation', state: 'working', stateAtMs: Math.ceil(at + 1) });
    await f.poll();
    expect((await f.host.inputs([id])).consumed).toEqual([{ id, clientId: id }]);
    expect(existsSync(`${f.base}.taken`)).toBe(false);
  } finally { await f.host.close(); f.close(); }
});

linux('a taken file without PreInvocation becomes lost; taking wins over the 60-minute expiry', async () => {
  const f = fixture(false);
  try {
    const id = randomUUID(), next = randomUUID();
    await f.host.deliver(id, body, true);
    await f.host.deliver(next, body, true);
    await f.poll();
    expect(await f.runStop()).toBe(body);
    expect(f.calls).toEqual([]);
    f.advance(60 * 60_000 + 1);
    await f.poll();
    expect(await f.host.inputs([id, next])).toEqual({ latest: null, consumed: [],
      lost: [{ id, clientId: id }], withdrawn: [{ id: next, clientId: next }] });
    expect((await f.host.inputs([])).lost).toEqual([]);
  } finally { await f.host.close(); f.close(); }
});

linux('a file missing without a taken marker becomes lost only after ten seconds', async () => {
  const f = fixture(false);
  try {
    const id = randomUUID();
    await f.host.deliver(id, body);
    await f.poll();
    rmSync(`${f.base}.msg`);
    await f.poll();
    f.advance(9999);
    await f.poll();
    expect((await f.host.inputs([id])).lost).toEqual([]);
    f.advance(1);
    await f.poll();
    expect((await f.host.inputs([id])).lost).toEqual([{ id, clientId: id }]);
  } finally { await f.host.close(); f.close(); }
});

linux('sends a delivered receipt only for proven input released from hold, and a drop receipt for withdrawal', async () => {
  const f = fixture(false);
  const config = f.env.CLAUDE_CONFIG_DIR;
  const socket = join(f.root, 'sender.sock');
  const sender = randomUUID();
  const received: string[] = [];
  const peer = net.createServer(conn => conn.on('data', chunk => received.push(chunk.toString())));
  peer.listen(socket);
  await once(peer, 'listening');
  chmodSync(socket, 0o600);
  mkdirSync(join(config, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(config, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, name: 'Fixture', sessionId: sender,
    messagingSocketPath: socket, cwd: f.root, peerProtocol: 1 }));
  let record = f.update({});
  const binding = bindAgy({ identity, home: f.root, env: f.env, kittyDelivery: false, read: async () => [record],
    startOf: async () => '333', now: f.now });
  try {
    await binding.tick();
    const bridge = binding.current(meta(f.id));
    const address = bridge.status().replyAddress!;
    const transmit = async (text: string, expected = 'accepted') => {
      const id = randomUUID();
      const conn = net.createConnection(address.slice(4));
      await once(conn, 'connect');
      conn.end(`${JSON.stringify({ msgV: 1, type: 'user', msg_id: id, from: `uds:${socket}`, session_id: f.id, message: { role: 'user', content: text } })}\n`);
      await once(conn, 'close');
      const stop = Date.now() + 2000;
      while (!bridge.status().messages.some(row => row.id === id && row.status === expected) && Date.now() < stop) await Bun.sleep(5);
      expect(bridge.status().messages.find(row => row.id === id)?.status).toBe(expected);
      return id;
    };
    const proven = await transmit('first');
    const unclear = await transmit('second');
    const refused = await transmit('third');
    expect(bridge.status().unreadCount).toBe(3);
    await binding.tick();
    expect(await f.runStop()).toContain('first');
    record = f.update({ event: 'PreInvocation', state: 'working', stateAtMs: Math.ceil(statSync(`${f.base}.taken`).mtimeMs + 1) });
    await binding.tick();
    await binding.tick();
    record = f.update({ event: 'Stop', state: 'done' });
    expect(await f.runStop()).toBeNull();
    expect(await f.runStop()).toContain('second');
    f.advance(6000);
    await binding.tick();
    await binding.tick();
    f.advance(60 * 60_000);
    await binding.tick();
    await binding.tick();
    expect(bridge.status().unreadCount).toBe(0);
    const status = new Map(bridge.status().messages.map(row => [row.id, row.status]));
    expect([status.get(proven), status.get(unclear), status.get(refused)]).toEqual(['accepted', 'unknown', 'dropped']);
    const receipts = () => received.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ action: 'peer_message_status', orig_msg_id: refused, status: 'dropped', drop_reason: 'delivery-refused' });

    await bridge.setPolicy('hold');
    const held = await transmit('fourth', 'held');
    await bridge.setPolicy('accept');
    expect(bridge.status().messages.find(row => row.id === held)?.status).toBe('accepted');
    expect(receipts().map(r => [r.orig_msg_id, r.status])).toEqual([[refused, 'dropped'], [held, 'held']]);
    await binding.tick();
    expect(await f.runStop()).toContain('fourth');
    record = f.update({ event: 'PreInvocation', state: 'working', stateAtMs: Math.ceil(statSync(`${f.base}.taken`).mtimeMs + 1) });
    await binding.tick();
    await binding.tick();
    expect(bridge.status().unreadCount).toBe(0);
    expect(receipts().map(r => [r.orig_msg_id, r.status])).toEqual([[refused, 'dropped'], [held, 'held'], [held, 'delivered']]);
  } finally { await binding.close(); await new Promise<void>(resolve => peer.close(() => resolve())); f.close(); }
});

linux('the stdio MCP entry exposes the four tools and closes on EOF without a receiver', async () => {
  const f = fixture(false);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/agy.ts')], {
    cwd: f.root, env: f.env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  });
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  const rpc = async (id: number, method: string, params?: object) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    child.stdin.flush();
    while (!buffered.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('agy MCP closed before replying');
      buffered += chunk.value;
    }
    const newline = buffered.indexOf('\n');
    const reply = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    expect(reply.id).toBe(id);
    return reply.result;
  };
  try {
    expect((await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).serverInfo.name).toBe('asb-bridge');
    const list = await rpc(2, 'tools/list');
    expect(list.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['inbox', 'list_sessions', 'send_message', 'status']);
    const reply = await rpc(3, 'tools/call', { name: 'status', arguments: {}, _meta: meta(f.id) });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toContain('no');
    await child.stdin.end();
    expect(await Promise.race([child.exited, Bun.sleep(1000).then(() => 'still running')])).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    f.close();
  }
});
