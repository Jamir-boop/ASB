// The ASB message relay (plan 9.6, 9.7, 16). The engine starts it while the machine group has another member. It keeps
// proxy rows in the local Claude config homes for sessions on other machines, sends the frames written to them through
// the engine, and writes the frames that other machines deliver. Only short error lines without message data are logged.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { hopChain, inbox, maxLineLength, ownedJson, peerAddress, peers, privateDirectory, processStart, removePeerKey, senderMode, sendFrames,
  SendRefused, serializeFrame, socketPath, userFrame, uuid, writePeerKey, type Frame, type Peer } from './claude';
import { isWindows, keyName, pidDomain } from './platform';
import { bindingSchema, boundPeer, exactReceiptSchema, requestReceiver, sendBound } from './outbound';

const homeSchema = z.object({ path: z.string().refine(isAbsolute), remoteClaude: z.enum(['auto', 'bridge', 'native']), hasRemoteControl: z.boolean() });
const homesSchema = z.object({ machineId: z.string(), machineName: z.string(), homes: z.array(homeSchema) });
const remoteSchema = z.object({ machineId: z.string().regex(/^[a-f0-9]{16}$/), machineName: z.string().min(1), online: z.boolean(),
  sessionId: uuid, name: z.string(), agent: z.enum(['claude', 'codex']), status: z.string(), remoteControl: z.boolean() });
const statuses = z.enum(['held', 'denied', 'expired', 'delivered', 'refused', 'dropped']);
// The body of POST /deliver (plan 9.7); src/machine-relay.mjs checks the same rules in the engine.
const senderSchema = z.strictObject({ machineId: z.string().regex(/^[a-f0-9]{16}$/), sessionId: uuid,
  name: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f-\x9f]*$/), mode: z.enum(['prompting', 'bypass', 'unknown']), agent: z.enum(['claude', 'codex']) });
const messageSchema = z.strictObject({ msgId: uuid, text: z.string().min(1).max(maxLineLength), hopChain: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(32) });
type Sender = z.infer<typeof senderSchema>;
const deliverSchema = z.strictObject({
  targetSessionId: uuid,
  sender: senderSchema,
  message: messageSchema.optional(),
  control: z.strictObject({ action: z.literal('peer_message_status'), orig_msg_id: uuid, status: statuses, status_detail: z.string().max(64).optional(),
    reason: z.string().max(1000).optional(), drop_reason: z.string().max(64).optional(), dropped_msg_ids: z.array(uuid).max(256).optional() }).optional(),
}).refine(value => (value.message === undefined) !== (value.control === undefined));
const replySchema = z.union([z.strictObject({ ok: z.literal(true), outcome: z.literal('socket-written') }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['machine-offline', 'target-unavailable', 'too-large', 'rate-limited', 'refused']) })]);
// The engine's reply to POST /api/relay/send: the member reasons, and `unknown` when the message can have gone out.
const sendReplySchema = z.union([z.strictObject({ ok: z.literal(true), outcome: z.literal('socket-written') }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['machine-offline', 'target-unavailable', 'too-large', 'rate-limited', 'refused', 'unknown']) })]);
export type Home = z.infer<typeof homeSchema>;
export type RemotePeer = z.infer<typeof remoteSchema>;
// `peer` is the data of the last delivery that needed the row, for a sender that is not listed yet.
export type ReverseNeed = { home: string; machineId: string; sessionId: string; atMs: number; peer: RemotePeer };
type Reply = z.infer<typeof replySchema>;
// The body of POST /deliver-bound: the engine's own binding of one exact member send (src/machine-relay.mjs).
const deliverBoundSchema = z.strictObject({ binding: bindingSchema, sender: senderSchema, message: messageSchema });
// The body of POST /outbox: a receipt of an exact member send for the receiver of a local task (a Windows engine, src/machine-relay.mjs).
const outboxSchema = z.strictObject({ configDir: z.string().refine(isAbsolute), messagingSocketPath: z.string().min(1),
  request: z.strictObject({ exactReceipt: exactReceiptSchema }) });
type BoundReply = { outcome: 'submitted' | 'unknown' } | { outcome: 'not-sent'; reason: string };
// The last exact member sends of this relay (oldest out first), and the window of their receipts.
const EXACT_IDS = 1024;
const EXACT_RECEIPT_MS = 30 * 60_000;
// One exact member send: the reverse row that got the frame, the sending machine, and the bound target process.
export type ExactEntry = { rowKey: string; machineId: string; pid: number; procStart: string; messagingSocketPath: string; atMs: number };
type StatusFrame = Extract<Frame, { action: 'peer_message_status' }>;
type Control = Record<string, unknown> & { orig_msg_id: string };

// Splits one receipt frame into its exact part (for one sending machine) and its legacy part. An exact ID never goes on
// the legacy path: an exact ID that is not valid is dropped. `writer` is the verified local session that wrote the frame.
export function receiptParts(frame: StatusFrame, rowKey: string, writer: Pick<Peer, 'pid' | 'procStart' | 'messagingSocketPath'>,
  exact: ReadonlyMap<string, ExactEntry>, nowMs: number) {
  const { action, orig_msg_id, status, status_detail, reason, drop_reason, dropped_msg_ids } = frame;
  const cut = Object.fromEntries(Object.entries({ status_detail: status_detail?.slice(0, 64), reason: reason?.slice(0, 1000),
    drop_reason: drop_reason?.slice(0, 64) }).filter(([, value]) => value !== undefined));
  const ids = [...new Set([orig_msg_id, ...(status === 'dropped' ? dropped_msg_ids ?? [] : [])])];
  const valid = (id: string) => {
    const entry = exact.get(id);
    return entry !== undefined && entry.rowKey === rowKey && entry.pid === writer.pid && entry.procStart === writer.procStart
      && entry.messagingSocketPath === writer.messagingSocketPath && nowMs - entry.atMs < EXACT_RECEIPT_MS;
  };
  const machineId = ids.filter(valid).map(id => exact.get(id)!.machineId)[0];
  const mine = ids.filter(id => valid(id) && exact.get(id)!.machineId === machineId);
  const result: { exact?: { machineId: string; control: Control }; legacy?: Control } = {};
  if (machineId !== undefined) {
    result.exact = { machineId, control: { action, orig_msg_id: mine[0]!, status, ...cut, ...(status === 'dropped' ? { dropped_msg_ids: mine } : {}) } };
  }
  const legacyDropped = dropped_msg_ids?.filter(id => !exact.has(id));
  if (!exact.has(orig_msg_id)) {
    result.legacy = { action, orig_msg_id, status, ...cut, ...(legacyDropped ? { dropped_msg_ids: legacyDropped } : {}) };
  } else if (status === 'dropped' && legacyDropped?.length) {
    result.legacy = { action, orig_msg_id: legacyDropped[0]!, status, ...cut, dropped_msg_ids: legacyDropped };
  }
  return result;
}

const REVERSE_MS = 30 * 60_000;
const UNLISTED_MS = 120_000;
const ROWS_PER_HOME = 32;
const ENVELOPE = /^<cross-session-message\s[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/;
const REASONS: Record<Exclude<Reply, { ok: true }>['reason'], (machine: string) => string> = {
  'machine-offline': machine => `${machine} is not reachable.`,
  'target-unavailable': machine => `The session on ${machine} is not available.`,
  'too-large': () => 'The message is too large.',
  'rate-limited': () => 'Too many messages to this session just now.',
  refused: machine => `${machine} refused the message.`,
};
// Plan 8.1: the refusal reason that the Claude sender gets, or 'unknown' when no terminal receipt may go back.
// Only a proved not-sent result gives a receipt. An older engine sends target-unavailable also after a handoff.
export async function forwardOutcome(send: Promise<unknown>): Promise<keyof typeof REASONS | 'sent' | 'unknown'> {
  let reply: z.infer<typeof sendReplySchema>;
  try { reply = sendReplySchema.parse(await send); }
  catch (error) { return engineNotReached(error) ? 'machine-offline' : 'unknown'; }
  if (reply.ok) return 'sent';
  return reply.reason === 'unknown' || reply.reason === 'target-unavailable' ? 'unknown' : reply.reason;
}

// The request did not reach the engine, or the engine refused it before any send (route checks answer 4xx).
function engineNotReached(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? (error.cause as { code?: string } | undefined)?.code;
  const status = (error as { status?: number }).status;
  return code === 'ConnectionRefused' || code === 'ECONNREFUSED' || (status !== undefined && status >= 400 && status < 500);
}

// A call to the local engine with one total deadline.
export function engineCaller(engine: string, sourceToken: string, timeoutMs = 30_000) {
  return async (path: string, body?: unknown) => {
    const response = await fetch(`${engine}${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-asb-source-token': sourceToken, ...(body === undefined ? {} : { origin: engine, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return response.json() as Promise<unknown>;
  };
}

const rowKey = (home: string, machineId: string, sessionId: string) => `${home}\0${machineId}\0${sessionId}`;
// A process that waits on stdin stands in for the remote session: its PID and start time make the row live.
const PLACEHOLDER = isWindows() ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'findstr.exe'), 'x'] : ['/usr/bin/cat'];
const agentOf = (peer: Peer) => peer.entrypoint === 'codex-asb-bridge' ? 'codex' as const : 'claude' as const;

// Plan 9.6: which remote sessions get a proxy row in each local Claude config home.
export function proxyPlan(homes: Home[], remote: RemotePeer[], reverse: ReverseNeed[], nowMs = Date.now()): Map<string, RemotePeer[]> {
  const plan = new Map<string, RemotePeer[]>();
  for (const home of homes) {
    // A listed sender keeps its reverse row 30 minutes; a sender that is not listed yet keeps it 120 s.
    const reverseRows = reverse.filter(need => need.home === home.path).flatMap(need => {
      const listed = remote.find(peer => peer.machineId === need.machineId && peer.sessionId === need.sessionId);
      return nowMs - need.atMs < (listed ? REVERSE_MS : UNLISTED_MS) ? [listed ?? need.peer] : [];
    });
    const needed = new Set(reverseRows.map(peer => rowKey(home.path, peer.machineId, peer.sessionId)));
    const isNeeded = (peer: RemotePeer) => needed.has(rowKey(home.path, peer.machineId, peer.sessionId));
    // Claude Remote Control already lists a remote Claude session in Claude when both sides have it.
    const wanted = (peer: RemotePeer) => peer.agent === 'codex' || home.remoteClaude === 'bridge'
      || (home.remoteClaude === 'auto' && !(peer.remoteControl && home.hasRemoteControl));
    plan.set(home.path, [...reverseRows, ...remote.filter(peer => !isNeeded(peer) && wanted(peer))].slice(0, ROWS_PER_HOME));
  }
  return plan;
}

// The machine name keeps a proxy row apart from the local sessions in Claude's ListAgents.
export function proxyName(machineName: string, name: string, taken: Iterable<string>) {
  const clean = (text: string) => text.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const base = clean(`${machineName}-${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-'));
  const used = new Set(taken);
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? '' : `-${number}`;
    const candidate = clean(base.slice(0, 64 - suffix.length)) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

function livePeers(home: string) {
  try { return peers(home); } catch { return []; }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

// Rows of an earlier relay whose placeholder is gone. A reused PID has another start time.
async function removeStaleRows(home: string) {
  const directory = join(home, 'sessions');
  let files: string[];
  try { files = readdirSync(directory); } catch { return; }
  for (const file of files.filter(name => /^[1-9][0-9]*\.json$/.test(name))) {
    try {
      const row = z.object({ pid: z.number().int().positive(), entrypoint: z.literal('asb-relay'), procStart: z.string(), messagingSocketPath: z.string() })
        .parse(ownedJson(join(directory, file), 256 * 1024));
      if (file !== `${row.pid}.json` || (alive(row.pid) && await processStart(row.pid).catch(() => null) === row.procStart)) continue;
      unlinkSync(join(directory, file));
      removePeerKey(join(directory, keyName(row.pid, row.messagingSocketPath)), row.procStart);
    } catch { /* Not a proxy row, or already gone. */ }
  }
}

type Row = { key: string; home: string; peer: RemotePeer; path: string; keyPath?: string; address: string; socket: { close(): Promise<void> };
  child: Bun.Subprocess<'pipe', 'ignore', 'ignore'>; record: { pid: number; procStart: string; name: string; status: string;
    messagingSocketPath: string; statusUpdatedAt: number } & Record<string, unknown> };

async function main() {
  const engine = process.env.ASB_ENGINE_URL ?? '';
  const sourceToken = process.env.ASB_SOURCE_TOKEN ?? '';
  const relayDir = process.env.ASB_RELAY_DIR ?? '';
  const enginePort = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(engine)?.[1] ?? 0);
  if (!enginePort || enginePort > 65535 || !/^[a-f0-9]{64}$/.test(sourceToken) || !isAbsolute(relayDir)) {
    console.error('ASB relay: ASB_ENGINE_URL, ASB_SOURCE_TOKEN, and ASB_RELAY_DIR are not valid.');
    process.exit(2);
  }
  mkdirSync(relayDir, { recursive: true, mode: 0o700 });
  const directory = realpathSync(relayDir);
  privateDirectory(directory);
  const removeSockets = () => {
    for (const file of readdirSync(directory)) if (file.endsWith('.sock')) try { unlinkSync(join(directory, file)); } catch { /* Gone. */ }
  };
  removeSockets();
  const log = (line: string) => console.error(line);
  const call = engineCaller(engine, sourceToken);
  let self = homesSchema.parse(await call('/api/relay/homes'));
  for (const home of self.homes) await removeStaleRows(home.path);

  const rows = new Map<string, Row>();
  const needs = new Map<string, ReverseNeed>();
  let remote: RemotePeer[] = [];
  let lastOkAtMs = Date.now();
  let closing = false;
  let queue: Promise<unknown> = Promise.resolve();
  // Row changes run one at a time, so a delivery and the timer never add the same row twice.
  const serialize = <T>(action: () => Promise<T>) => {
    const result = queue.catch(() => {}).then(action);
    queue = result;
    return result;
  };

  async function addRow(home: string, peer: RemotePeer) {
    const sessions = join(home, 'sessions');
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const real = realpathSync(sessions);
    privateDirectory(real);
    const child = Bun.spawn(PLACEHOLDER, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    let socket: { address: string; close(): Promise<void> } | undefined;
    let keyPath: string | undefined;
    let procStart = '';
    try {
      procStart = await processStart(child.pid);
      // The sun_path limit of a Unix socket.
      if (!isWindows() && Buffer.byteLength(join(directory, `${child.pid}.sock`)) > 103) throw new Error('The relay socket path is too long.');
      // A Windows proxy row has a cc-msg pipe and a key file, as Claude's rows do (plan 17.6).
      const token = isWindows() ? randomBytes(16).toString('hex') : undefined;
      let row: Row | undefined;
      socket = await inbox(directory, frame => {
        if (row) void forward(row, frame).catch(() => log('ASB relay: cannot forward a frame.'));
      }, `${child.pid}.sock`, { token });
      const messagingSocketPath = socketPath(socket.address);
      if (token) keyPath = writePeerKey(real, child.pid, messagingSocketPath, token, procStart);
      const now = Date.now();
      const domain = pidDomain();
      const record = { pid: child.pid, sessionId: peer.sessionId, cwd: '', name: proxyName(peer.machineName, peer.name, livePeers(home).map(item => item.name)),
        startedAt: now, procStart, peerProtocol: 1, ...(domain ? { pidDomain: domain } : {}), kind: 'interactive', entrypoint: 'asb-relay', messagingSocketPath,
        status: peer.status, statusUpdatedAt: now, peerFeatures: [] };
      const path = join(real, `${child.pid}.json`);
      writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      row = { key: rowKey(home, peer.machineId, peer.sessionId), home, peer, path, keyPath, address: socket.address, socket, child, record };
      rows.set(row.key, row);
      return row;
    } catch (error) {
      if (keyPath) removePeerKey(keyPath, procStart);
      await socket?.close().catch(() => {});
      child.stdin.end();
      child.kill();
      throw error;
    }
  }

  async function removeRow(row: Row) {
    rows.delete(row.key);
    // The receipts of its exact sends are lost. The IDs stay exact, so they never take the legacy path, also when a new
    // reverse row gets the same key.
    for (const [id, entry] of exactIds) if (entry.rowKey === row.key) exactIds.set(id, { ...entry, rowKey: '' });
    try {
      const current = z.object({ pid: z.number(), procStart: z.string() }).parse(ownedJson(row.path, 256 * 1024));
      if (current.pid === row.record.pid && current.procStart === row.record.procStart) unlinkSync(row.path);
    } catch { /* Already gone. */ }
    if (row.keyPath) removePeerKey(row.keyPath, row.record.procStart);
    await row.socket.close().catch(() => {});
    try { unlinkSync(row.record.messagingSocketPath); } catch { /* Already gone. */ }
    row.child.stdin.end();
    row.child.kill();
  }

  function setStatus(row: Row, status: string) {
    row.record = { ...row.record, status, statusUpdatedAt: Date.now() };
    const temporary = `${row.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(row.record), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, row.path);
  }

  async function apply(plan: Map<string, RemotePeer[]>) {
    if (closing) return;
    const wanted = new Map<string, { home: string; peer: RemotePeer }>();
    for (const [home, list] of plan) for (const peer of list) wanted.set(rowKey(home, peer.machineId, peer.sessionId), { home, peer });
    for (const row of [...rows.values()]) if (!wanted.has(row.key)) await removeRow(row);
    for (const [key, { home, peer }] of wanted) {
      const row = rows.get(key);
      try {
        if (!row) await addRow(home, peer);
        else {
          row.peer = peer;
          if (row.record.status !== peer.status) setStatus(row, peer.status);
        }
      } catch { log('ASB relay: cannot write a proxy row.'); }
    }
  }

  // Plan 16.3: the sender is a live local session that writes from its own socket.
  async function findSender(home: string, from: string) {
    for (const peer of livePeers(home)) {
      if (peer.entrypoint === 'asb-relay' || !peer.procStart || peerAddress(peer.messagingSocketPath) !== from) continue;
      if (await processStart(peer.pid).catch(() => null) === peer.procStart) return peer;
    }
    return undefined;
  }

  // The last message IDs of exact member sends: their receipts never go back on the v1 path, also after a reverse row
  // that lives longer than 30 minutes. No age limit; the oldest ID goes out first.
  const exactIds = new Map<string, ExactEntry>();
  const keepExact = (id: string, entry: ExactEntry) => {
    exactIds.delete(id);
    exactIds.set(id, entry);
    while (exactIds.size > EXACT_IDS) exactIds.delete(exactIds.keys().next().value!);
  };

  async function forward(row: Row, frame: Frame) {
    if (frame.type === 'control' && frame.action !== 'peer_message_status') return;
    const sender = await findSender(row.home, frame.from);
    if (!sender) return;
    const target = { machineId: row.peer.machineId, targetSessionId: row.peer.sessionId };
    const from = (mode: string) => ({ machineId: self.machineId, sessionId: sender.sessionId, agent: agentOf(sender),
      name: sender.name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 128) || 'Claude Code',
      mode: ['prompting', 'bypass'].includes(mode) ? mode : 'unknown' });
    if (frame.type === 'control') {
      if (frame.action !== 'peer_message_status') return;
      // Both stay fire and forget; an older engine answers 404 for the exact route.
      const { exact, legacy } = receiptParts(frame, row.key, sender, exactIds, Date.now());
      await Promise.all([exact && call('/api/relay/receipt', exact).catch(() => {}),
        legacy && call('/api/relay/send', { ...target, sender: from('unknown'), control: legacy }).catch(() => {})]);
      return;
    }
    try { serializeFrame(frame); } catch { return; }
    const content = frame.message.content;
    const text = (ENVELOPE.exec(content)?.[1] ?? content).replaceAll('<\\/cross-session-message', '</cross-session-message');
    const outcome = await forwardOutcome(call('/api/relay/send', { ...target, sender: from(senderMode(content) ?? 'unknown'),
      message: { msgId: frame.msg_id, text, hopChain: hopChain(content) } }));
    if (outcome === 'sent') return;
    // A refused or expired receipt would say that nothing was sent; Claude has no receipt for an unknown outcome.
    if (outcome === 'unknown') { log(`ASB relay: the send outcome of message ${frame.msg_id} is unknown.`); return; }
    await sendFrames(row.home, sender, [{ msgV: 1, type: 'control', msg_id: randomUUID(), from: row.address, session_id: sender.sessionId,
      action: 'peer_message_status', orig_msg_id: frame.msg_id, status: 'expired', status_detail: 'refused', reason: REASONS[outcome](row.peer.machineName) }]);
  }

  // The row of the sender in this home, so that the target can answer it (plan 16.3).
  function reverseRow(home: string, sender: Sender) {
    return serialize(async () => {
      const key = rowKey(home, sender.machineId, sender.sessionId);
      const listed = remote.find(peer => peer.machineId === sender.machineId && peer.sessionId === sender.sessionId);
      const machineName = remote.find(peer => peer.machineId === sender.machineId)?.machineName ?? sender.machineId.slice(0, 8);
      const peer = listed ?? { machineId: sender.machineId, machineName, online: true, sessionId: sender.sessionId,
        name: sender.name, agent: sender.agent, status: 'idle', remoteControl: false };
      needs.set(key, { home, machineId: sender.machineId, sessionId: sender.sessionId, atMs: Date.now(), peer });
      const existing = rows.get(key);
      if (existing) return existing;
      if (closing) throw new Error('The relay is stopping.');
      return addRow(home, peer);
    });
  }

  // One exact member send: only the bound record of the bound home, never a search by session ID, never an engine call.
  async function deliverBound(value: unknown): Promise<BoundReply | undefined> {
    const parsed = deliverBoundSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { binding, sender, message } = parsed.data;
    const notSent = (reason: string): BoundReply => ({ outcome: 'not-sent', reason });
    // The native realpath, as boundPeer: the engine's registryHome comes from Node fs.promises.realpath, and the JS-style realpathSync keeps Windows 8.3 short names.
    const home = self.homes.find(item => { try { return realpathSync.native(join(item.path, 'sessions')) === binding.registryHome; } catch { return false; } });
    const target = home ? boundPeer(home.path, binding) : undefined;
    if (!home || !target) return notSent('target-changed');
    let reverse: Row;
    try { reverse = await reverseRow(home.path, sender); } catch { return notSent('target-unavailable'); }
    const frame = userFrame(target, reverse.address, reverse.record.name, sender.sessionId, message.msgId, message.text, sender.mode, null, message.hopChain);
    try { serializeFrame(frame); } catch { return notSent('too-large'); }
    // Before the write: the target can send its receipt within the 150 ms flush of sendFrames. A not-sent write
    // gives the target no frame, so no receipt with this ID comes.
    keepExact(message.msgId, { rowKey: reverse.key, machineId: sender.machineId, pid: binding.pid, procStart: binding.procStart,
      messagingSocketPath: binding.messagingSocketPath, atMs: Date.now() });
    try { await sendBound(home.path, binding, [frame], () => !closing); }
    catch (error) {
      if (!(error instanceof SendRefused)) return { outcome: 'unknown' };
      exactIds.delete(message.msgId);
      // A refusal without a code is the burst budget of the target.
      const code = (error as SendRefused & { code?: string }).code;
      return notSent(code === 'receiver-stopped' ? 'relay-unavailable' : code ?? 'rate-limited');
    }
    return { outcome: 'submitted' };
  }

  // The receipt of an exact member send, to the receiver of a local task. The receiver is only the request fields, not a registry
  // row: on Windows the proof checks the PID, the start time, and the user at the write, and the receiver checks that the receipt names it.
  async function writeReceipt(value: unknown): Promise<{ applied: number } | { outcome: 'not-sent' | 'unknown' } | undefined> {
    const parsed = outboxSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { configDir, messagingSocketPath, request } = parsed.data;
    const notSent = new Error('Nothing sent.');
    let reply: unknown;
    try {
      reply = await requestReceiver(configDir, { pid: request.exactReceipt.pid, procStart: request.exactReceipt.procStart, messagingSocketPath },
        request, () => notSent, true);
    } catch (error) { return { outcome: error === notSent ? 'not-sent' : 'unknown' }; }
    const applied = z.strictObject({ applied: z.number().int().nonnegative() }).safeParse(reply);
    return applied.success ? applied.data : { outcome: 'unknown' };
  }

  // Plan 16.5: a frame from another machine for a local session. Proxy rows never receive one, so relays cannot loop.
  async function deliver(value: unknown): Promise<Reply | undefined> {
    const parsed = deliverSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { targetSessionId, sender, message, control } = parsed.data;
    const found = new Map<number, { home: string; target: Peer }>();
    for (const home of self.homes) for (const peer of livePeers(home.path)) {
      if (peer.sessionId === targetSessionId && peer.entrypoint !== 'asb-relay' && !found.has(peer.pid)) found.set(peer.pid, { home: home.path, target: peer });
    }
    const match = found.size === 1 ? [...found.values()][0] : undefined;
    if (!match) return { ok: false, reason: 'target-unavailable' };
    const { home, target } = match;
    let reverse: Row;
    try { reverse = await reverseRow(home, sender); } catch { return { ok: false, reason: 'target-unavailable' }; }
    let frame: unknown;
    if (message) {
      frame = userFrame(target, reverse.address, reverse.record.name, sender.sessionId, message.msgId, message.text, sender.mode, null, message.hopChain);
      try { serializeFrame(frame); } catch { return { ok: false, reason: 'too-large' }; }
    } else frame = { msgV: 1, type: 'control', msg_id: randomUUID(), from: reverse.address, session_id: target.sessionId, ...control };
    try { await sendFrames(home, target, [frame]); }
    catch (error) { return { ok: false, reason: error instanceof SendRefused ? 'rate-limited' : 'target-unavailable' }; }
    return { ok: true, outcome: 'socket-written' };
  }

  function listPeers() {
    const seen = new Map<string, { sessionId: string; name: string; agent: 'claude' | 'codex'; status: string; remoteControl: boolean }>();
    for (const home of self.homes) for (const peer of livePeers(home.path)) {
      if (peer.entrypoint === 'asb-relay' || seen.has(peer.sessionId)) continue;
      seen.set(peer.sessionId, { sessionId: peer.sessionId, name: peer.name, agent: agentOf(peer), status: peer.status, remoteControl: Boolean(peer.bridgeSessionId) });
    }
    return [...seen.values()];
  }

  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 2 * 1024 * 1024 + 1024, async fetch(request) {
    const given = Buffer.from(request.headers.get('authorization') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected) || request.headers.get('host') !== `127.0.0.1:${server.port}`) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    const { pathname } = new URL(request.url);
    if (pathname === '/peers' && request.method === 'GET') return Response.json({ peers: listPeers() });
    if (pathname === '/deliver' && request.method === 'POST') {
      const reply = await deliver(await request.json().catch(() => undefined));
      return reply ? Response.json(reply) : Response.json({ error: 'Invalid relay request.' }, { status: 400 });
    }
    if (pathname === '/deliver-bound' && request.method === 'POST') {
      const reply = await deliverBound(await request.json().catch(() => undefined));
      return reply ? Response.json(reply) : Response.json({ error: 'Invalid relay request.' }, { status: 400 });
    }
    if (pathname === '/outbox' && request.method === 'POST') {
      const reply = await writeReceipt(await request.json().catch(() => undefined));
      return reply ? Response.json(reply) : Response.json({ error: 'Invalid relay request.' }, { status: 400 });
    }
    return Response.json({ error: 'Not found.' }, { status: 404 });
  } });

  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    try {
      const [homes, listed] = await Promise.all([call('/api/relay/homes'), call('/api/relay/remote-peers')]);
      self = homesSchema.parse(homes);
      remote = z.object({ peers: z.array(remoteSchema) }).parse(listed).peers;
      lastOkAtMs = Date.now();
    } catch {
      // Plan 16.2: the rows stay for 30 s while the engine does not answer.
      if (Date.now() - lastOkAtMs >= 30_000) await serialize(async () => { for (const row of [...rows.values()]) await removeRow(row); });
      return;
    }
    for (const [key, need] of needs) if (Date.now() - need.atMs >= REVERSE_MS) needs.delete(key);
    await serialize(() => apply(proxyPlan(self.homes, remote, [...needs.values()])));
  }
  const loop = async () => {
    await tick().catch(() => log('ASB relay: cannot update the proxy rows.'));
    if (!closing) timer = setTimeout(loop, 5000);
  };

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await serialize(async () => { for (const row of [...rows.values()]) await removeRow(row); }).catch(() => {});
    removeSockets();
    server.stop(true);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // The engine keeps stdin open; its end means the engine is gone.
  process.stdin.on('end', shutdown);
  process.stdin.resume();
  console.log(JSON.stringify({ port: server.port, token }));
  void loop();
}

if (import.meta.main) {
  main().catch(() => { console.error('ASB relay: cannot start.'); process.exit(1); });
}
