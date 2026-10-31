import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accountReceipt, findPeer, findPeerProcess, hopChain, inbox, peerAddress, peers, privateDirectory, processStart, register, SendRefused, sendFrames, senderMode, serializeFrame, socketPath, userFrame, uuid, type Frame, type Peer } from './claude';
import type { Runtime } from './desktop';
import type { Inputs } from './desktop-input';
import { deliverToCodex, readCodexInputs, readCodexRuntime, targetSchema, type Target } from './codex';
import { z } from 'zod';
import { bindingSchema, boundPeer, outboundServer, refreshReceiver, refuse, sendBound, sendBoundViaReceiver, sendViaReceiver, type Binding, type ExactReceipt } from './outbound';
import { isWindows, outboxPath } from './platform';
import { PeerGuard } from './guard';
import { DeliveryRefused, peerHeader } from './delivery';
import { engineRequest, engineRuntime, remotePeers, type EngineRuntime, type RemotePeer } from './engine';

type Message = { id: string; peer_id: string; direction: string; text: string; status: string; turn_id: string | null;
  peer_address: string | null; peer_start: string | null; from_mode: string | null; expires_at: number | null; kind: string;
  drop_reason: string | null; status_reason: string | null };
type Subscription = { id: string; peer_id: string; peer_address: string; peer_start: string | null; direction: string };
export const policySchema = z.enum(['default', 'accept', 'hold', 'refuse']);
type Policy = z.infer<typeof policySchema>;
const subscriptionLifetime = 12 * 60 * 60 * 1000;
// `unknown` comes only from the local engine. An older engine sends target-unavailable also when the message can have
// gone out, so it is unknown too.
const relayReply = z.union([z.strictObject({ ok: z.literal(true), outcome: z.literal('socket-written') }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['machine-offline', 'target-unavailable', 'too-large', 'rate-limited', 'refused', 'unknown']) })]);
// The reply of /api/agent/resolve-bound; any other shape means that the engine is not available.
const boundReply = z.union([
  z.strictObject({ apiVersion: z.literal(1), ok: z.literal(true), pid: z.number().int().positive(), binding: bindingSchema }),
  z.strictObject({ apiVersion: z.literal(1), ok: z.literal(false), code: z.string().regex(/^[a-z][a-z-]{0,63}$/), message: z.string().min(1).max(512) })]);
// The reply of /api/agent/send-member; any other shape, pid, or msgId means that the outcome is unknown.
const memberReply = z.union([
  z.strictObject({ apiVersion: z.literal(1), pid: z.number().int().positive(), msgId: uuid, outcome: z.enum(['submitted', 'unknown']) }),
  z.strictObject({ apiVersion: z.literal(1), pid: z.number().int().positive(), msgId: uuid, outcome: z.literal('not-sent'),
    code: z.string().regex(/^[a-z][a-z-]{0,63}$/), message: z.string().min(1).max(512) })]);
const engineUnavailable = () => new SendRefused('The local ASB engine did not answer. Nothing sent (engine-unavailable).');
const remoteRefusals: Record<'machine-offline' | 'too-large' | 'rate-limited' | 'refused', (machine: string) => string> = {
  'machine-offline': machine => `${machine} is not reachable. Nothing sent.`,
  'too-large': () => 'Message too large for the other machine. Nothing sent.',
  'rate-limited': () => 'Too many messages to this session just now. Nothing sent; wait or batch the text.',
  refused: machine => `${machine} refused the message. Nothing sent.`,
};

// The native host behind one Bridge: Codex (desktop or app-server IPC) or the OpenCode plugin.
// Policy, receipts, idle notices, limits, and hop chains stay in Bridge and do not depend on the host.
export type Host = {
  entrypoint: 'codex-asb-bridge' | 'opencode-asb-bridge';
  transport: string;
  remoteAgent: 'codex' | 'claude';
  replyHint: string;
  identity: { pid: number };
  // Codex registers under its own title rule; OpenCode passes its nameBase and extra row fields.
  nameBase?: (cwd: string, sessionId: string) => string;
  extraRow?: Record<string, unknown>;
  receiverError: string;
  runtime(): Promise<Runtime>;
  inputs(awaiting: string[]): Promise<Inputs>;
  deliver(inputId: string, text: string): Promise<{ status: string; turnId: string | null }>;
};

export class Bridge {
  private db: Database;
  private guard: PeerGuard;
  private listener?: Awaited<ReturnType<typeof inbox>>;
  private closeOutbound?: Awaited<ReturnType<typeof outboundServer>>;
  private registration?: Awaited<ReturnType<typeof register>>;
  private closing = false;
  private ownsReceiver = false;
  // The start time of this receiver process, as start() registers it.
  private procStart?: string;
  private serial: Promise<unknown> = Promise.resolve();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private incomingMessages = 0;
  private host: Host;
  constructor(readonly threadId: string, readonly configDir: string, stateDir: string, readonly ipcPath: string, host?: Host) {
    uuid.parse(threadId);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    privateDirectory(stateDir);
    const path = join(stateDir, `${threadId}.sqlite`);
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    // The busy timeout comes first: the journal-mode change can meet another process's lock.
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS receiver (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, proc_start TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifecycle (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL, active INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transport (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), kind TEXT NOT NULL, path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), status TEXT NOT NULL, mode TEXT NOT NULL
      );
      INSERT OR IGNORE INTO runtime (singleton,status,mode) VALUES (1,'unknown','unknown');
      CREATE TABLE IF NOT EXISTS inbound_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy TEXT NOT NULL
      );
      INSERT OR IGNORE INTO inbound_policy (singleton,policy) VALUES (1,'default');
      CREATE TABLE IF NOT EXISTS idle_requests (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, peer_address TEXT NOT NULL, peer_start TEXT,
        direction TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL,
        UNIQUE(direction,peer_address)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, direction TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, turn_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );`);
    const columns = this.db.query<{ name: string }, []>('PRAGMA table_info(messages)').all();
    for (const [name, sql] of Object.entries({
      turn_id: 'ALTER TABLE messages ADD COLUMN turn_id TEXT',
      peer_address: 'ALTER TABLE messages ADD COLUMN peer_address TEXT',
      peer_start: 'ALTER TABLE messages ADD COLUMN peer_start TEXT',
      from_mode: 'ALTER TABLE messages ADD COLUMN from_mode TEXT',
      expires_at: 'ALTER TABLE messages ADD COLUMN expires_at INTEGER',
      kind: "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'",
      drop_reason: 'ALTER TABLE messages ADD COLUMN drop_reason TEXT',
      status_reason: 'ALTER TABLE messages ADD COLUMN status_reason TEXT',
      awaiting_input: 'ALTER TABLE messages ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0',
      native_input_id: 'ALTER TABLE messages ADD COLUMN native_input_id TEXT',
    })) {
      if (!columns.some(column => column.name === name)) this.db.exec(sql);
    }
    if (!columns.some(column => column.name === 'desktop_input_id')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN desktop_input_id TEXT;
        UPDATE messages SET desktop_input_id=id WHERE direction='in' AND status IN ('submitting','started','steered','unknown');`);
    }
    if (!this.db.query<{ name: string }, []>('PRAGMA table_info(runtime)').all().some(column => column.name === 'updated_at')) {
      this.db.exec('ALTER TABLE runtime ADD COLUMN updated_at INTEGER');
    }
    if (!this.db.query<{ name: string }, []>('PRAGMA table_info(lifecycle)').all().some(column => column.name === 'ended_at')) {
      this.db.exec('ALTER TABLE lifecycle ADD COLUMN ended_at INTEGER');
    }
    if (!this.db.query<{ name: string }, []>('PRAGMA table_info(runtime)').all().some(column => column.name === 'hop_token')) {
      this.db.exec('ALTER TABLE runtime ADD COLUMN hop_token TEXT');
    }
    this.guard = new PeerGuard(this.db);
    this.host = host ?? this.codexHost();
  }

  // The default host: the Codex desktop or app-server transport that this class always used.
  private codexHost(): Host {
    const bridge = this;
    return {
      entrypoint: 'codex-asb-bridge',
      get transport() { return bridge.target().kind; },
      remoteAgent: 'codex',
      replyHint: 'Reply with send_message.',
      identity: { pid: process.pid },
      receiverError: 'This Codex task has no active receiver or has more than one registration. The receiver starts at the first turn '
        + 'and when Codex loads a task that registered before. If it stays inactive during a turn, the plugin hooks are not trusted '
        + 'or the SessionStart hook failed: ask the user to check hook trust. No tool restarts it.',
      runtime: () => readCodexRuntime(bridge.target(), bridge.threadId),
      inputs: awaiting => readCodexInputs(bridge.target(), bridge.threadId, awaiting),
      deliver: (inputId, text) => deliverToCodex(bridge.target(), bridge.threadId, inputId, text),
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => {});
    return result;
  }

  // With `expected`, the session begins only if the lifecycle generation is still that value.
  beginSession(): string;
  beginSession(expected: string): string | undefined;
  beginSession(expected?: string): string | undefined {
    return this.db.transaction(() => {
      if (expected !== undefined && !this.db.query('SELECT 1 FROM lifecycle WHERE singleton=1 AND generation=?').get(expected)) return undefined;
      const generation = randomUUID();
      this.db.run('INSERT INTO lifecycle (singleton,generation,active) VALUES (1,?,1) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation, active=1', [generation]);
      this.db.run("UPDATE messages SET status='expired' WHERE direction='in' AND status='held'");
      this.db.run("UPDATE idle_requests SET status='expired' WHERE status IN ('waiting','submitting','unknown')");
      // An unknown input of an earlier session must not block the idle notices of this one; its status stays unknown.
      this.db.run("UPDATE messages SET awaiting_input=0 WHERE direction='in' AND status='unknown' AND awaiting_input=1");
      this.db.run("UPDATE runtime SET status='unknown',mode='unknown' WHERE singleton=1");
      this.db.run('DELETE FROM peer_guard');
      return generation;
    }).immediate();
  }

  session() {
    return this.db.query<{ generation: string; active: number; pid: number | null }, []>(
      'SELECT generation,active,(SELECT pid FROM receiver WHERE singleton=1) AS pid FROM lifecycle WHERE singleton=1').get();
  }

  setTarget(target: Target) {
    targetSchema.parse(target);
    this.db.run('INSERT INTO transport VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET kind=excluded.kind,path=excluded.path', [target.kind, target.path]);
  }

  target(): Target {
    const target = this.db.query<{ kind: string; path: string }, []>('SELECT kind,path FROM transport WHERE singleton=1').get();
    return targetSchema.parse(target ?? { kind: 'desktop', path: this.ipcPath });
  }

  endSession() {
    return this.db.transaction(() => {
      this.db.run('INSERT INTO lifecycle (singleton,generation,active,ended_at) VALUES (1,?,0,?) ON CONFLICT(singleton) DO UPDATE SET active=0, ended_at=excluded.ended_at', [randomUUID(), Date.now()]);
      this.db.run("UPDATE idle_requests SET status='expired' WHERE direction='out' AND status IN ('waiting','unknown')");
      return this.db.query<{ pid: number; proc_start: string }, []>('SELECT pid,proc_start FROM receiver WHERE singleton=1').get();
    })();
  }

  start(directory: string, cwd: string, generation: string) {
    uuid.parse(generation);
    return this.exclusive(async () => {
      if (this.closing) throw new Error('Receiver is closing');
      if (this.listener) return;
      const old = this.db.query<{ pid: number; proc_start: string }, []>('SELECT pid,proc_start FROM receiver WHERE singleton=1').get();
      if (old) {
        let alive = true;
        try { process.kill(old.pid, 0); }
        catch (error) {
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          // EPERM: another user's process has the PID of the dead receiver, so its start time decides below.
          if (code === 'ESRCH') alive = false;
          else if (code !== 'EPERM') throw error;
        }
        if (alive && await processStart(old.pid) === old.proc_start) throw new Error('Receiver is already starting or running');
      }
      const hostPid = this.host.identity.pid;
      const procStart = await processStart(hostPid);
      this.db.transaction(() => {
        if (!this.db.query('SELECT 1 FROM lifecycle WHERE singleton=1 AND generation=? AND active=1').get(generation)) {
          throw new Error('Session ended or was replaced before receiver startup');
        }
        if (old) this.db.run('DELETE FROM receiver WHERE singleton=1 AND pid=? AND proc_start=?', [old.pid, old.proc_start]);
        const claim = this.db.run('INSERT OR IGNORE INTO receiver VALUES (1,?,?)', [hostPid, procStart]);
        if (!claim.changes) throw new Error('Another receiver claimed this task');
      })();
      this.ownsReceiver = true;
      this.procStart = procStart;
      // A dead receiver left these: the outcome is unknown, but the wait for their input must not block idle notices (beginSession runs first).
      this.db.run("UPDATE messages SET status='unknown',awaiting_input=0 WHERE status='submitting'");
      // Windows needs the token in the inbox before the row exists (plan 17.2).
      const token = isWindows() ? randomBytes(16).toString('hex') : undefined;
      // One socket name per receiver process: Codex uses its own PID, OpenCode the placeholder PID.
      this.listener = await inbox(directory, frame => {
        if (this.closing) return;
        if (frame.type === 'user') this.incomingMessages++;
        void this.exclusive(async () => {
          try { await this.receive(frame); }
          finally { if (frame.type === 'user') this.incomingMessages--; }
          await this.flushIdle();
        }).catch(() => console.error('Peer message handling failed; inspect bridge status.'));
      }, `${this.host.identity.pid}.sock`, { token });
      this.db.run('UPDATE runtime SET hop_token=? WHERE singleton=1',
        [createHmac('sha256', randomBytes(32)).update(this.listener.address).digest('hex').slice(0, 24)]);
      if (this.closing) throw new Error('Receiver is closing');
      this.closeOutbound = await outboundServer(outboxPath(socketPath(this.listener.address)), this.configDir, this.listener.address,
        frames => !this.closing && (!frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.state === 'idle') || this.canNotifyIdle()),
        () => this.scheduleExpiry(), token, receipt => this.applyExactReceipt(receipt));
      this.registration = await register(this.configDir, this.threadId, this.listener.address, cwd, this.runtime().status, token, {
        pid: this.host.identity.pid,
        procStart: this.procStart,
        entrypoint: this.host.entrypoint,
        nameBase: this.host.nameBase,
        extra: this.host.extraRow,
      });
      if (this.closing) throw new Error('Receiver is closing');
      for (const message of this.db.query<Message, []>("SELECT * FROM messages WHERE direction='in' AND status='pending' ORDER BY created_at,rowid").all()) {
        if (this.closing) break;
        await this.route(message);
      }
    });
  }

  updateRuntime(state: Runtime, renamed = false) {
    if (this.closing) return;
    this.db.run('UPDATE runtime SET updated_at=CASE WHEN status<>? THEN ? ELSE updated_at END,status=?,mode=? WHERE singleton=1',
      [state.status, Date.now(), state.status, state.mode]);
    this.registration?.update(state.status, renamed);
    if (this.listener) void this.exclusive(async () => {
      if (state.status === 'idle') await this.syncInputs();
      await this.flushIdle();
    }).catch(() => console.error('Inbound state update failed.'));
  }

  private runtime() {
    const state = this.db.query<Runtime & { updated_at: number | null }, []>('SELECT status,mode,updated_at FROM runtime WHERE singleton=1').get();
    if (!state) throw new Error('Missing task runtime');
    return state;
  }

  private ownHop() {
    return this.db.query<{ hop_token: string | null }, []>('SELECT hop_token FROM runtime WHERE singleton=1').get()?.hop_token ?? null;
  }

  private async syncInputs() {
    const awaiting = this.db.query<{ desktop_input_id: string | null }, []>(
      "SELECT desktop_input_id FROM messages WHERE direction='in' AND awaiting_input=1").all()
      .flatMap(message => message.desktop_input_id ? [message.desktop_input_id] : []);
    const inputs = await this.host.inputs(awaiting);
    this.db.transaction(() => {
      for (const input of inputs.consumed) this.db.run(
        "UPDATE messages SET awaiting_input=0,native_input_id=? WHERE direction='in' AND (desktop_input_id=? OR native_input_id=?) AND status IN ('submitting','started','steered','accepted','unknown')",
        [input.id, input.clientId, input.id]);
    })();
    return inputs;
  }

  private unreadCount() {
    return this.db.query<{ total: number }, []>("SELECT count(*) AS total FROM messages WHERE direction='in' AND kind='message' AND awaiting_input=1").get()?.total ?? 0;
  }

  private async outgoingHops() {
    const { latest } = await this.syncInputs();
    if (latest === undefined) throw new SendRefused('Cannot determine the current input origin; no message was sent');
    if (latest === null) return [];
    const message = this.db.query<{ text: string }, [string]>(
      "SELECT text FROM messages WHERE direction='in' AND kind='message' AND native_input_id=?").get(latest.id);
    return message ? hopChain(message.text) : [];
  }

  private receiver() {
    const matches = peers(this.configDir).filter(peer => peer.sessionId === this.threadId);
    const receiver = matches[0];
    if (matches.length !== 1 || receiver?.entrypoint !== this.host.entrypoint) {
      throw new Error(this.host.receiverError);
    }
    return receiver;
  }

  sendMessage(sessionId: string, text?: string, notifyWhenIdle = false) {
    return this.exclusive(async () => {
      await this.expireSubscriptions();
      if (sessionId === this.threadId) throw new Error('Cannot send to this task itself');
      // A session that no local registry row has can be on another machine of the group (plan 16.4).
      // A local match always wins; a remote one only when exactly one other machine has the session ID.
      const runtime = peers(this.configDir).some(peer => peer.sessionId === sessionId && peer.entrypoint !== 'asb-relay') ? null : engineRuntime();
      if (runtime) {
        let listed: RemotePeer[];
        try { listed = await remotePeers(runtime); }
        catch { throw new Error('ASB cannot list the sessions on the other machines. Nothing sent.'); }
        const matches = listed.filter(peer => peer.sessionId === sessionId);
        if (new Set(matches.map(peer => peer.machineId)).size > 1) {
          throw new Error(`More than one other machine has session ${sessionId}. Nothing sent.`);
        }
        if (matches[0]) return this.sendRemote(runtime, matches[0], text, notifyWhenIdle);
      }
      const peer = findPeer(this.configDir, sessionId);
      return this.sendLocal(peer, sessionId, text, notifyWhenIdle);
    });
  }

  // One exact local session by its full reference: the engine binds it, and the write checks the binding again.
  // It never asks for remote peers or the relay.
  sendReference(reference: string, text?: string, notifyWhenIdle = false) {
    return this.exclusive(async () => {
      await this.expireSubscriptions();
      if (!text && !notifyWhenIdle) throw new Error('A message or notify_when_idle is required');
      this.receiver();
      const ids = { id: text ? randomUUID() : null, subscriptionId: notifyWhenIdle ? randomUUID() : null };
      const msgId = ids.id ?? ids.subscriptionId;
      const runtime = engineRuntime();
      if (!runtime) throw engineUnavailable();
      let reply: z.infer<typeof boundReply>;
      try {
        // On Windows the engine binds only for a bridge that proves the pipe server before each bound write.
        reply = boundReply.parse(await engineRequest(runtime, '/api/agent/resolve-bound', { method: 'POST', timeoutMs: 5_000, body: { reference,
          caller: { runtimeSessionId: this.threadId, configDir: resolve(this.configDir) }, msgId, remainingMs: 10_000, hostCheck: true,
          ...(isWindows() ? { pipeProof: true } : {}) } }));
      } catch { throw engineUnavailable(); }
      if (!reply.ok && reply.code === 'member-target') {
        if (notifyWhenIdle) throw new SendRefused('Idle subscriptions do not work across machines yet. Nothing sent (remote-idle-unsupported).');
        return this.sendMember(runtime, reference, ids.id!, text!);
      }
      if (!reply.ok) throw new SendRefused(`${reply.message} Nothing sent (${reply.code}).`);
      if (reply.pid !== runtime.pid || reply.binding.msgId !== msgId) throw engineUnavailable();
      const { binding } = reply;
      if (binding.runtimeSessionId === this.threadId) throw new Error('Cannot send to this task itself');
      const peer = boundPeer(this.configDir, binding);
      if (!peer) throw refuse('target-changed');
      return this.sendLocal(peer, binding.runtimeSessionId, text, notifyWhenIdle, frames => this.writeBound(binding, frames), ids);
    });
  }

  // Runs inside the exclusive section of sendMessage or sendReference.
  private async sendLocal(peer: Peer, sessionId: string, text: string | undefined, notifyWhenIdle: boolean,
    write = (frames: unknown[]) => this.writePeer(peer, frames),
    { id, subscriptionId } = { id: text ? randomUUID() : null, subscriptionId: notifyWhenIdle ? randomUUID() : null }) {
    if (!text && !notifyWhenIdle) throw new Error('A message or notify_when_idle is required');
    if (notifyWhenIdle && (!peer.peerFeatures.includes('notify_idle') || this.policy() === 'refuse')) {
      throw new Error('Idle subscription unavailable: target must support notify_idle and this inbox must not refuse incoming notices');
    }
    const receiver = this.receiver();
    const address = peerAddress(receiver.messagingSocketPath);
    const frames: unknown[] = [];
    const messageFrame = id && text ? userFrame(peer, address, receiver.name, this.threadId, id, text, this.runtime().mode, this.ownHop(), await this.outgoingHops()) : null;
    if (messageFrame) serializeFrame(messageFrame);
    if (subscriptionId) this.subscribe(subscriptionId, peer, 'out');
    if (id && text) {
      this.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,peer_start) VALUES (?,?,'out',?,'submitting',?,?)",
        [id, sessionId, text, peerAddress(peer.messagingSocketPath), peer.procStart ?? null]);
      frames.push(messageFrame);
    }
    if (subscriptionId) {
      frames.push({ msgV: 1, type: 'control', action: 'notify_when_idle', msg_id: subscriptionId, from: address, from_mode: this.runtime().mode });
    }
    try {
      if (!await write(frames)) throw new Error('Receiver stopped before writing');
      if (id) this.db.run("UPDATE messages SET status='socket-written' WHERE id=? AND status='submitting'", [id]);
    } catch (error) {
      if (error instanceof SendRefused) {
        if (id) this.db.run("UPDATE messages SET status='not-sent' WHERE id=? AND status='submitting'", [id]);
        if (subscriptionId) this.db.run("UPDATE idle_requests SET status='expired' WHERE id=?", [subscriptionId]);
        throw error;
      }
      if (id) this.db.run("UPDATE messages SET status='unknown' WHERE id=? AND status='submitting'", [id]);
      if (subscriptionId) this.db.run("UPDATE idle_requests SET status='unknown' WHERE id=? AND status='waiting'", [subscriptionId]);
      throw new Error(`Send outcome unknown for ${id ?? subscriptionId}; inspect status before sending again`);
    }
    return { messageId: id, subscriptionId, status: id
      ? this.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(id)?.status : 'socket-written' };
  }

  // One exact session on a member machine, through the local engine only. It never lists peers, never uses /api/relay/*,
  // and never sends again by itself. Runs inside sendReference's exclusive section.
  private async sendMember(runtime: EngineRuntime, reference: string, id: string, text: string) {
    const receiver = this.receiver();
    const address = peerAddress(receiver.messagingSocketPath);
    const mode = this.runtime().mode;
    const hops = [...await this.outgoingHops(), ...(this.ownHop() ? [this.ownHop()!] : [])].slice(-32);
    // The same limit as a local send; any UUID has the length of the target session ID.
    serializeFrame(userFrame({ sessionId: randomUUID() }, address, receiver.name, this.threadId, id, text, mode, null, hops));
    this.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,peer_start) VALUES (?,?,'out',?,'submitting',NULL,NULL)",
      [id, reference, text]);
    let reply: z.infer<typeof memberReply> | undefined;
    try {
      reply = memberReply.parse(await engineRequest(runtime, '/api/agent/send-member', { method: 'POST', timeoutMs: 16_000, body: { reference,
        caller: { runtimeSessionId: this.threadId, configDir: resolve(this.configDir) }, mode: ['prompting', 'bypass'].includes(mode) ? mode : 'unknown',
        message: { msgId: id, text, hopChain: hops }, remainingMs: 10_000 } }));
      if (reply.pid !== runtime.pid || reply.msgId !== id) reply = undefined;
    } catch { reply = undefined; }
    if (reply?.outcome === 'not-sent') {
      const reason = `${reply.message} Nothing sent (${reply.code}).`;
      this.db.run("UPDATE messages SET status='not-sent',status_reason=? WHERE id=? AND status='submitting'", [reason, id]);
      throw new SendRefused(reason);
    }
    if (reply?.outcome !== 'submitted') {
      this.db.run("UPDATE messages SET status='unknown' WHERE id=? AND status='submitting'", [id]);
      throw new Error(`Send outcome unknown for ${id}; inspect status before sending again`);
    }
    this.db.run("UPDATE messages SET status='socket-written' WHERE id=? AND status='submitting'", [id]);
    return { messageId: id, subscriptionId: null, status: this.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(id)?.status };
  }

  // The receipt of an exact member send, from the local engine through the outbox. It applies only to this receiver
  // process and to rows of sendMember (the reference as peer_id, no peer address). It never sends anything.
  private applyExactReceipt(receipt: ExactReceipt) {
    if (this.closing || !this.ownsReceiver || receipt.runtimeSessionId !== this.threadId || receipt.pid !== this.host.identity.pid
      || receipt.procStart !== this.procStart) return 0;
    const status = receipt.status === 'expired' && receipt.status_detail === 'refused' ? 'refused' : receipt.status;
    return this.db.transaction(() => receipt.msgIds.reduce((applied, id) => applied + this.db.run(`UPDATE messages SET status=?,drop_reason=?,status_reason=?
      WHERE id=? AND peer_id=? AND peer_address IS NULL AND direction='out' AND status IN ('submitting','socket-written','unknown','held')`,
      [status, receipt.drop_reason ?? null, receipt.reason ?? null, id, receipt.reference]).changes, 0))();
  }

  // Runs inside sendMessage's exclusive section.
  private async sendRemote(runtime: EngineRuntime, target: RemotePeer, text: string | undefined, notifyWhenIdle: boolean) {
    if (notifyWhenIdle) throw new Error('Idle subscriptions do not work across machines yet.');
    if (!text) throw new Error('A message or notify_when_idle is required');
    const receiver = this.receiver();
    const address = peerAddress(receiver.messagingSocketPath);
    const mode = this.runtime().mode;
    const hops = [...await this.outgoingHops(), ...(this.ownHop() ? [this.ownHop()!] : [])].slice(-32);
    const id = randomUUID();
    // The same limit as a local send: the frame that a local send would write.
    serializeFrame(userFrame({ sessionId: target.sessionId }, address, receiver.name, this.threadId, id, text, mode, null, hops));
    let machineId: string;
    try { machineId = z.object({ machineId: z.string().regex(/^[a-f0-9]{16}$/) }).parse(await engineRequest(runtime, '/api/relay/homes')).machineId; }
    catch { throw new SendRefused('The local ASB engine did not answer. Nothing sent.'); }
    // A receipt that comes back through the proxy row of this session updates the message like a local one.
    const proxy = peers(this.configDir).find(peer => peer.entrypoint === 'asb-relay' && peer.sessionId === target.sessionId);
    this.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,peer_start) VALUES (?,?,'out',?,'submitting',?,?)",
      [id, target.sessionId, text, proxy ? peerAddress(proxy.messagingSocketPath) : null, proxy?.procStart ?? null]);
    let reply: z.infer<typeof relayReply>;
    try {
      reply = relayReply.parse(await engineRequest(runtime, '/api/relay/send', { method: 'POST', body: { machineId: target.machineId, targetSessionId: target.sessionId,
        sender: { machineId, sessionId: this.threadId, name: receiver.name, mode: ['prompting', 'bypass'].includes(mode) ? mode : 'unknown', agent: this.host.remoteAgent },
        message: { msgId: id, text, hopChain: hops } } }));
    } catch { reply = { ok: false, reason: 'unknown' }; }
    if (!reply.ok) {
      if (reply.reason === 'unknown' || reply.reason === 'target-unavailable') {
        this.db.run("UPDATE messages SET status='unknown' WHERE id=? AND status='submitting'", [id]);
        throw new Error(`Send outcome unknown for ${id}; inspect status before sending again`);
      }
      const reason = remoteRefusals[reply.reason](target.machineName);
      this.db.run("UPDATE messages SET status='not-sent',status_reason=? WHERE id=? AND status='submitting'", [reason, id]);
      throw new SendRefused(reason);
    }
    this.db.run("UPDATE messages SET status='socket-written' WHERE id=? AND status='submitting'", [id]);
    return { messageId: id, subscriptionId: null, status: this.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(id)?.status };
  }

  private async receive(frame: Frame) {
    if (this.closing) return;
    const peer = peers(this.configDir).find(peer => peer.sessionId !== this.threadId
      && frame.from === peerAddress(peer.messagingSocketPath));
    if (!peer) return;
    if (peer.procStart && await processStart(peer.pid) !== peer.procStart) return;
    if (frame.session_id && frame.session_id !== this.threadId) return;
    if (frame.type === 'control') {
      if (frame.action === 'peer_message_status') {
        const status = frame.status === 'expired' && frame.status_detail === 'refused' ? 'refused' : frame.status;
        const ids = new Set([frame.orig_msg_id, ...(status === 'dropped' ? frame.dropped_msg_ids ?? [] : [])]);
        for (const id of ids) {
          const previous = this.db.query<{ status: string }, [string, string, string | null]>(
            "SELECT status FROM messages WHERE id=? AND peer_address=? AND peer_start IS ? AND direction='out' AND status IN ('submitting','socket-written','unknown','held')")
            .get(id, frame.from, peer.procStart ?? null);
          if (!previous) continue;
          this.db.run('UPDATE messages SET status=?,drop_reason=?,status_reason=? WHERE id=?',
            [status, frame.drop_reason ?? null, frame.reason ?? null, id]);
          accountReceipt(peer, status, previous.status);
        }
      } else if (frame.action === 'notify_when_idle') {
        if (this.policy() === 'refuse') return;
        if (!this.subscribe(frame.msg_id, peer, 'in')) return;
        await this.flushIdle();
      } else {
        const consumed = this.db.run("UPDATE idle_requests SET status='received' WHERE id=? AND direction='out' AND peer_address=? AND peer_start IS ? AND status IN ('waiting','unknown') AND expires_at>?",
          [frame.orig_msg_id, frame.from, peer.procStart ?? null, Date.now()]);
        if (!consumed.changes) return;
        const id = frame.msg_id ?? randomUUID();
        const text = JSON.stringify({ event: 'peer_idle_notice', state: ['idle', 'exited'].includes(frame.state) ? frame.state : 'unavailable',
          subscriptionId: frame.orig_msg_id, finishedAt: frame.finished_at, detail: frame.detail });
        await this.acceptIncoming(id, peer, text, frame.from_mode ?? null, 'idle-notice');
      }
      return;
    }
    if (frame.file_attachments?.length) {
      const result = this.db.run("INSERT OR IGNORE INTO messages (id,peer_id,direction,text,status,peer_address,peer_start,kind,status_reason) VALUES (?,?,'in',?,'refused',?,?,'message',?)",
        [frame.msg_id, peer.sessionId, frame.message.content, frame.from, peer.procStart ?? null,
          'File attachments are unsupported; send plain text or a shared filesystem path.']);
      if (result.changes) {
        const message = this.db.query<Message, [string]>('SELECT * FROM messages WHERE id=?').get(frame.msg_id);
        if (message) await this.receipt(message, 'refused');
      }
      return;
    }
    await this.acceptIncoming(frame.msg_id, peer, frame.message.content, senderMode(frame.message.content) ?? null, 'message');
  }

  private async acceptIncoming(id: string, peer: Peer, text: string, mode: string | null, kind: string) {
    const result = this.db.run("INSERT OR IGNORE INTO messages (id,peer_id,direction,text,status,peer_address,peer_start,from_mode,kind) VALUES (?,?,'in',?,'pending',?,?,?,?)",
      [id, peer.sessionId, text, peerAddress(peer.messagingSocketPath), peer.procStart ?? null, mode, kind]);
    if (result.changes === 0) return;
    const message = this.db.query<Message, [string]>('SELECT * FROM messages WHERE id=?').get(id);
    if (message) await this.route(message);
  }

  policy(): Policy {
    return policySchema.parse(this.db.query<{ policy: string }, []>('SELECT policy FROM inbound_policy WHERE singleton=1').get()?.policy);
  }

  private decision(): Exclude<Policy, 'default'> {
    const policy = this.policy();
    return policy === 'default' ? 'accept' : policy;
  }

  private async route(message: Message) {
    const decision = this.decision();
    if (decision === 'accept') { await this.deliver(message); return; }
    if (message.kind === 'idle-notice') {
      this.db.run("UPDATE messages SET status=?,text='' WHERE id=? AND status='pending'",
        [decision === 'hold' ? 'recorded' : 'refused', message.id]);
      return;
    }
    const status = decision === 'hold' ? 'held' : 'refused';
    this.db.run("UPDATE messages SET status=?,expires_at=NULL WHERE id=? AND status='pending'", [status, message.id]);
    await this.receipt(message, status);
    for (const old of this.db.query<Message, []>("SELECT * FROM messages WHERE direction='in' AND status='held' ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 100").all()) {
      this.db.run("UPDATE messages SET status='dropped' WHERE id=? AND status='held'", [old.id]);
      await this.receipt(old, 'dropped');
    }
    this.scheduleExpiry();
  }

  private async receipt(message: Message, status: string, dropReason = 'queue-full') {
    if (message.kind !== 'message') return;
    try {
      if (!message.peer_address) return;
      const peer = findPeerProcess(this.configDir, message.peer_address, message.peer_start);
      await this.control(peer, { action: 'peer_message_status', orig_msg_id: message.id,
        status: status === 'refused' ? 'expired' : status, ...(status === 'refused' ? { status_detail: 'refused' } : {}),
        ...(message.status_reason ? { reason: message.status_reason } : {}),
        ...(status === 'dropped' ? { drop_reason: dropReason, dropped_msg_ids: [message.id] } : {}) });
    } catch { /* A receipt cannot undo an already recorded delivery decision. */ }
  }

  private control(peer: Peer, fields: Record<string, unknown>, canWrite?: () => boolean) {
    const receiver = this.receiver();
    const frames = [{ msgV: 1, type: 'control', msg_id: randomUUID(),
      from: peerAddress(receiver.messagingSocketPath), from_mode: this.runtime().mode, ...fields }];
    return this.writePeer(peer, frames, canWrite);
  }

  private async writePeer(peer: Peer, frames: unknown[], canWrite?: () => boolean) {
    if (this.ownsReceiver) return sendFrames(this.configDir, peer, frames, { canWrite });
    const receiver = this.receiver();
    return sendViaReceiver(this.configDir, receiver, peer, frames);
  }

  private async writeBound(binding: Binding, frames: unknown[]) {
    if (this.ownsReceiver) return sendBound(this.configDir, binding, frames, () => !this.closing);
    return sendBoundViaReceiver(this.configDir, this.receiver(), binding, frames);
  }

  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const next = this.db.query<{ deadline: number | null }, []>(
      "SELECT min(expires_at) AS deadline FROM idle_requests WHERE status IN ('waiting','unknown')").get()?.deadline;
    if (next == null || this.closing) return;
    this.expiryTimer = setTimeout(() => {
      void this.exclusive(async () => { await this.flushIdle(); }).catch(() => console.error('Idle expiry failed.'));
    }, Math.max(1, next - Date.now()));
    this.expiryTimer.unref();
  }

  held() {
    return this.db.query<Message, []>("SELECT * FROM messages WHERE direction='in' AND status='held' ORDER BY created_at,rowid").all();
  }

  async setPolicy(policy: Policy) {
    this.assertActive();
    policySchema.parse(policy);
    this.db.run('UPDATE inbound_policy SET policy=? WHERE singleton=1', [policy]);
    await this.exclusive(async () => {
      if (policy === 'refuse') {
        this.db.run("UPDATE idle_requests SET status='expired' WHERE status='waiting'");
      }
      await this.recheckHeld();
      await this.flushIdle();
    });
    await this.refreshTimers();
  }

  private async refreshTimers() {
    if (this.ownsReceiver) { this.scheduleExpiry(); return; }
    const receiver = this.receiver();
    await refreshReceiver(this.configDir, receiver);
  }

  private async recheckHeld() {
    for (const message of this.held()) {
      const decision = this.decision();
      if (decision === 'accept') await this.deliver(message);
      else if (decision === 'refuse') {
        if (this.db.run("UPDATE messages SET status='refused' WHERE id=? AND status='held'", [message.id]).changes) await this.receipt(message, 'refused');
      }
    }
    this.scheduleExpiry();
  }

  private subscribe(id: string, peer: Peer, direction: 'in' | 'out') {
    if (this.db.query('SELECT 1 FROM idle_requests WHERE id=?').get(id)) return false;
    const count = this.db.query<{ total: number }, [string, string]>("SELECT count(*) AS total FROM idle_requests WHERE direction=? AND status='waiting' AND peer_address<>?")
      .get(direction, peerAddress(peer.messagingSocketPath))?.total ?? 0;
    if (count >= 32) throw new Error('Idle subscription limit reached');
    this.db.run("INSERT OR REPLACE INTO idle_requests VALUES (?,?,?,?,?,'waiting',?)",
      [id, peer.sessionId, peerAddress(peer.messagingSocketPath), peer.procStart ?? null, direction, Date.now() + subscriptionLifetime]);
    this.scheduleExpiry();
    return true;
  }

  private async expireSubscriptions() {
    for (const subscription of this.db.query<Subscription, [number]>("SELECT * FROM idle_requests WHERE status IN ('waiting','unknown') AND expires_at<=?").all(Date.now())) {
      if (!this.db.run("UPDATE idle_requests SET status='expired' WHERE id=? AND status IN ('waiting','unknown')", [subscription.id]).changes
        || subscription.direction !== 'out') continue;
      const id = randomUUID();
      const text = JSON.stringify({ event: 'idle_subscription_expired', subscriptionId: subscription.id,
        sessionId: this.currentPeer(subscription).sessionId, message: 'No idle notice arrived before the 12-hour deadline. Do not keep waiting on this subscription.' });
      this.db.run("INSERT INTO messages (id,peer_id,direction,text,status,kind) VALUES (?,?,'in',?,'pending','subscription-expired')", [id, subscription.peer_id, text]);
      const message = this.db.query<Message, [string]>('SELECT * FROM messages WHERE id=?').get(id);
      if (message) await this.deliver(message);
    }
    this.scheduleExpiry();
  }

  private assertActive() {
    if (!this.db.query('SELECT 1 FROM lifecycle WHERE singleton=1 AND active=1').get()) throw new Error('This task has no active receiver');
    this.receiver();
  }

  private async flushIdle() {
    if (this.closing) return;
    await this.expireSubscriptions();
    if (this.closing || this.policy() === 'refuse' || this.held().length || this.incomingMessages) return;
    const pending = this.db.query<Subscription, [number]>("SELECT * FROM idle_requests WHERE direction='in' AND status='waiting' AND expires_at>?").all(Date.now());
    if (!pending.length) return;
    await this.syncInputs();
    if (this.unreadCount() || (await this.host.runtime()).status !== 'idle') return;
    for (const subscription of pending) {
      if (!this.db.run("UPDATE idle_requests SET status='submitting' WHERE id=? AND status='waiting'", [subscription.id]).changes) continue;
      try {
        const peer = findPeerProcess(this.configDir, subscription.peer_address, subscription.peer_start);
        const sent = await this.control(peer, { action: 'peer_idle_notice', orig_msg_id: subscription.id, state: 'idle',
          ...(this.runtime().updated_at == null ? {} : { finished_at: this.runtime().updated_at }) },
          () => this.canNotifyIdle());
        this.db.run('UPDATE idle_requests SET status=? WHERE id=?', [sent ? 'sent' : this.policy() === 'refuse' ? 'expired' : 'waiting', subscription.id]);
      } catch { this.db.run("UPDATE idle_requests SET status='unknown' WHERE id=?", [subscription.id]); }
    }
  }

  private canNotifyIdle() {
    return !this.closing && this.runtime().status === 'idle' && this.policy() !== 'refuse' && !this.held().length && !this.incomingMessages && !this.unreadCount();
  }

  // The model replies with this ID, so it must be the peer's current one after a /clear.
  private currentPeer({ peer_id, peer_address, peer_start }: Pick<Message, 'peer_id' | 'peer_address' | 'peer_start'>): { sessionId: string; name?: string } {
    try { return peer_address ? findPeerProcess(this.configDir, peer_address, peer_start) : { sessionId: peer_id }; }
    catch { return { sessionId: peer_id }; }
  }

  private async deliver(message: Message) {
    const body = /^<cross-session-message\s[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/.exec(message.text)?.[1] ?? message.text;
    if (message.kind === 'message') {
      try { await this.syncInputs(); }
      catch {
        // Nothing went to Codex: the sender gets the same drop receipt as for a refused delivery.
        if (this.db.run("UPDATE messages SET status='dropped',drop_reason='delivery-refused',awaiting_input=0 WHERE id=? AND status IN ('pending','held')", [message.id]).changes) {
          await this.receipt(message, 'dropped', 'delivery-refused');
        }
        return;
      }
    }
    const inputId = randomUUID();
    const claim = this.db.transaction(() => {
      const full = message.kind === 'message' && this.unreadCount() >= 50;
      const result = this.db.run("UPDATE messages SET status=?,awaiting_input=?,drop_reason=?,desktop_input_id=? WHERE id=? AND status IN ('pending','held')",
        [full ? 'dropped' : 'submitting', !full && message.kind === 'message' ? 1 : 0, full ? 'queue-full' : null, full ? null : inputId, message.id]);
      return result.changes ? full ? 'full' : 'claimed' : 'unchanged';
    }).immediate();
    if (claim === 'unchanged') return;
    if (claim === 'full') { await this.receipt(message, 'dropped', 'queue-full'); return; }
    if (message.kind === 'message') {
      const reason = this.guard.admit(`${message.peer_address}:${message.peer_start ?? ''}`, body, hopChain(message.text), this.ownHop());
      if (reason) {
        this.db.run("UPDATE messages SET status='dropped',drop_reason=?,awaiting_input=0 WHERE id=?", [reason, message.id]);
        await this.receipt(message, 'dropped', reason);
        return;
      }
    }
    try {
      const { sessionId, name } = this.currentPeer(message);
      const embedInput = this.host.transport === 'app-server' ? inputId : undefined;
      const text = `${peerHeader(sessionId, name, embedInput, this.host.replyHint)}\n${body}`;
      const result = await this.host.deliver(inputId, text);
      this.db.run('UPDATE messages SET status=?,turn_id=? WHERE id=?', [result.status, result.turnId, message.id]);
      if (message.status === 'held') await this.receipt(message, 'delivered');
    } catch (error) {
      if (error instanceof DeliveryRefused) {
        this.db.run("UPDATE messages SET status='dropped',drop_reason='delivery-refused',awaiting_input=0 WHERE id=?", [message.id]);
        await this.receipt(message, 'dropped', 'delivery-refused');
      } else this.db.run("UPDATE messages SET status='unknown' WHERE id=?", [message.id]);
    }
  }

  status() {
    const receiver = peers(this.configDir).find(peer => peer.sessionId === this.threadId && peer.entrypoint === this.host.entrypoint);
    return { threadId: this.threadId, name: receiver?.name ?? null, replyAddress: receiver ? peerAddress(receiver.messagingSocketPath) : null,
      transport: this.host.transport,
      runtime: this.runtime(),
      inboundPolicy: this.policy(), heldCount: this.held().length, unreadCount: this.unreadCount(),
      idleRequests: this.db.query<Pick<Subscription, 'id' | 'peer_id' | 'direction'> & { status: string }, [number]>(
        'SELECT id,peer_id,direction,status FROM idle_requests WHERE expires_at>?').all(Date.now()),
      messages: this.db.query<Pick<Message, 'id' | 'peer_id' | 'direction' | 'status' | 'turn_id' | 'drop_reason' | 'status_reason'>, []>(
        'SELECT id,peer_id,direction,status,turn_id,drop_reason,status_reason FROM messages ORDER BY created_at DESC,rowid DESC LIMIT 20').all() };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.expiryTimer);
    if (this.ownsReceiver && this.listener) await this.finishSession(this.listener.address);
    const withdraw = async () => {
      await this.closeOutbound?.();
      this.closeOutbound = undefined;
      try { this.registration?.close(); } catch { /* An uninstall can remove the row first; the inbox must still close. */ }
      this.registration = undefined;
      await this.listener?.close();
      this.listener = undefined;
      if (this.ownsReceiver) this.db.run('DELETE FROM receiver WHERE singleton=1 AND pid=?', [this.host.identity.pid]);
      this.ownsReceiver = false;
    };
    await withdraw();
    await this.serial;
    await withdraw();
    this.db.close();
  }

  async finishSession(address: string) {
    const outgoing = new Map<string, { reference: Message | Subscription; frames: unknown[]; subscriptions: string[] }>();
    const add = (reference: Message | Subscription, fields: Record<string, unknown>) => {
      if (!reference.peer_address) return;
      const key = `${reference.peer_address}:${reference.peer_start ?? ''}`;
      const group = outgoing.get(key) ?? { reference, frames: [], subscriptions: [] };
      group.frames.push({ msgV: 1, type: 'control', msg_id: randomUUID(), from: address, from_mode: this.runtime().mode, ...fields });
      if (fields.action === 'peer_idle_notice' && typeof fields.orig_msg_id === 'string') group.subscriptions.push(fields.orig_msg_id);
      outgoing.set(key, group);
    };
    for (const message of this.held()) {
      if (this.db.run("UPDATE messages SET status='expired' WHERE id=? AND status='held'", [message.id]).changes && message.kind === 'message') {
        add(message, { action: 'peer_message_status', orig_msg_id: message.id, status: 'expired' });
      }
    }
    if (this.policy() !== 'refuse') {
      for (const subscription of this.db.query<Subscription, [number]>("SELECT * FROM idle_requests WHERE direction='in' AND status='waiting' AND expires_at>?").all(Date.now())) {
        if (this.db.run("UPDATE idle_requests SET status='submitting' WHERE id=? AND status='waiting'", [subscription.id]).changes) {
          add(subscription, { action: 'peer_idle_notice', orig_msg_id: subscription.id, state: 'exited', finished_at: Date.now() });
        }
      }
    }
    await Promise.all([...outgoing.values()].map(async ({ reference, frames, subscriptions }) => {
      let status = 'unknown';
      try {
        if (!reference.peer_address) throw new Error('Peer address missing');
        const peer = findPeerProcess(this.configDir, reference.peer_address, reference.peer_start);
        await sendFrames(this.configDir, peer, frames, { timeoutMs: 500 });
        status = 'sent';
      } catch { /* Session shutdown cannot guarantee delivery to a departing peer. */ }
      for (const id of subscriptions) this.db.run('UPDATE idle_requests SET status=? WHERE id=?', [status, id]);
    }));
  }
}
