// The engine side of the message relay between machines (plan 9.6, 9.7, 16): the relay body checks, the supervisor of
// bridge/dist/relay.js, the peer lists of the members, and the handlers of the member and loopback relay routes.
import { spawn as spawnProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLiveClaudeRegistry } from './claude-registry.mjs';
import { peerRequest } from './machine-peers.mjs';
import { bunFolders, bunNotFound, findBun, findExecutable, runtimeDir } from './platform-paths.mjs';
import { formatReference } from './session-references.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX16 = /^[a-f0-9]{16}$/;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const STATUSES = ['held', 'denied', 'expired', 'delivered', 'refused', 'dropped'];
const REASONS = ['machine-offline', 'target-unavailable', 'too-large', 'rate-limited', 'refused'];
const LIST_MS = 5_000;
// The limits nest (bridge/PROTOCOL-COVERAGE.md): the relay writes to the target in at most 5 s plus a 150 ms flush,
// the receiver waits RELAY_DELIVER_MS for its relay, and the sender waits MEMBER_POST_MS for the member.
const RELAY_DELIVER_MS = 8_000;
const RELAY_LIST_MS = 3_000;
const MEMBER_POST_MS = 10_000;
// Exact member receipts: the life of a send attempt, the attempts kept, the controls of one attempt, and the time limits.
const ATTEMPT_MS = 30 * 60_000;
const ATTEMPTS = 1024;
const CONTROLS_PER_ATTEMPT = 4;
const RECEIPT_POST_MS = 4_000;
const OUTBOX_MS = 2_000;
const LIST_STALE_MS = 15_000;
const CHECK_MS = 30_000;
const RESTARTS = 5;
const RESTART_WINDOW_MS = 600_000;
export const RELAY_STOPPED = 'ASB: the message relay stopped after 5 restarts in 10 minutes.';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Exactly the required keys, and only these optional ones.
const keys = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const hex16 = (value) => typeof value === 'string' && HEX16.test(value);
const optionalText = (value, max) => value === undefined || text(value, 0, max);

const validSender = (sender) => keys(sender, ['machineId', 'sessionId', 'name', 'mode', 'agent']) && hex16(sender.machineId) && uuid(sender.sessionId)
  && text(sender.name, 1, 128) && !CONTROLS.test(sender.name) && ['prompting', 'bypass', 'unknown'].includes(sender.mode)
  && ['claude', 'codex'].includes(sender.agent);
const validMessage = (message) => keys(message, ['msgId', 'text', 'hopChain']) && uuid(message.msgId) && text(message.text, 1, 1_048_576)
  && Array.isArray(message.hopChain) && message.hopChain.length <= 32
  && message.hopChain.every((token) => typeof token === 'string' && /^[a-f0-9]{24}$/.test(token));

// The v1 receipt control: it carries no text and names no destination.
const validControl = (control) => keys(control, ['action', 'orig_msg_id', 'status'], ['status_detail', 'reason', 'drop_reason', 'dropped_msg_ids'])
  && control.action === 'peer_message_status' && uuid(control.orig_msg_id) && STATUSES.includes(control.status)
  && optionalText(control.status_detail, 64) && optionalText(control.reason, 1000) && optionalText(control.drop_reason, 64)
  && (control.dropped_msg_ids === undefined || (Array.isArray(control.dropped_msg_ids) && control.dropped_msg_ids.length <= 256
    && control.dropped_msg_ids.every(uuid)));

// Plan 9.7: the body of POST /peer/v1/deliver, and of POST /api/relay/send with the target `machineId`.
export function validRelayBody(value, { withMachine = false } = {}) {
  const kind = object(value) && Object.hasOwn(value, 'message') ? 'message' : 'control';
  if (!keys(value, ['targetSessionId', 'sender', kind, ...(withMachine ? ['machineId'] : [])])) return false;
  const { sender, message, control } = value;
  if ((withMachine && !hex16(value.machineId)) || !uuid(value.targetSessionId) || !validSender(sender)) return false;
  if (kind === 'message') return validMessage(message);
  return validControl(control);
}

// The exact member routes (SYSTEM_OVERVIEW.md, "Exact member sends"). The one reason enum of both v2 replies.
export const EXACT_REASONS = ['invalid-reference', 'unsupported-reference-version', 'no-machine-identity', 'unknown-machine', 'stale-source',
  'stale-source-scope', 'ambiguous-identity', 'unsupported-platform', 'unsupported-type', 'source-disabled', 'not-found', 'ambiguous-source',
  'native-scope-unavailable', 'not-live', 'not-mapped', 'target-unavailable', 'relay-unavailable', 'binding-expired', 'target-changed',
  'too-large', 'rate-limited'];
const validTarget = (value, machineId) => {
  if (!keys(value, ['sourceId', 'scopeTag', 'type', 'appId']) || !Object.values(value).every((item) => typeof item === 'string')) return false;
  try { formatReference({ machineId, ...value }); return true; } catch { return false; }
};
export const validResolveRequest = (value, machineId) => keys(value, ['api', 'target']) && value.api === 2 && validTarget(value.target, machineId);
export const validResolveReply = (value) => (keys(value, ['api', 'outcome']) && value.api === 2 && value.outcome === 'ready')
  || (keys(value, ['api', 'outcome', 'reason']) && value.api === 2 && value.outcome === 'unavailable' && EXACT_REASONS.includes(value.reason));
export const validDeliverRequest = (value, machineId) => keys(value, ['api', 'target', 'sender', 'message', 'remainingMs']) && value.api === 2
  && validTarget(value.target, machineId) && validSender(value.sender) && validMessage(value.message)
  && Number.isInteger(value.remainingMs) && value.remainingMs >= 0 && value.remainingMs <= 10_000;
const validOutcome = (value, extra = []) => (keys(value, [...extra, 'outcome']) && ['submitted', 'unknown'].includes(value.outcome))
  || (keys(value, [...extra, 'outcome', 'reason']) && value.outcome === 'not-sent' && EXACT_REASONS.includes(value.reason));
export const validDeliverReply = (value) => validOutcome(value, ['api', 'msgId']) && value.api === 2 && uuid(value.msgId);
// The relay's reply to POST /deliver-bound.
export const validBoundReply = (value) => validOutcome(value);
// The receipt of an exact member send: POST /api/relay/receipt from the relay, and the control variant of POST /peer/v2/deliver.
export const validReceiptBody = (value) => keys(value, ['machineId', 'control']) && hex16(value.machineId) && validControl(value.control);
export const validReceiptRequest = (value) => keys(value, ['api', 'control']) && value.api === 2 && validControl(value.control);

const privateEntry = async (file, isKind) => {
  const info = await fs.lstat(file);
  if (!isKind(info) || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('The outbox is not private.');
};

// An error with `unsent` means that nothing was written.
const unsent = (message) => Object.assign(new Error(message), { unsent: true });

// One request to the outbox socket of a bridge receiver (Linux), next to its inbox `<name>.sock` (bridge/src/platform.ts).
// The reply is the `applied` count.
export async function writeOutbox(inbox, request, timeoutMs = OUTBOX_MS) {
  if (typeof inbox !== 'string' || !path.isAbsolute(inbox) || !inbox.endsWith('.sock') || inbox.split('/').includes('..')) throw unsent('Invalid outbox path.');
  const outbox = `${inbox.slice(0, -'.sock'.length)}.out`;
  const deadline = Date.now() + timeoutMs;
  try {
    await privateEntry(path.dirname(outbox), (info) => info.isDirectory());
    await privateEntry(outbox, (info) => info.isSocket());
  } catch (error) { throw unsent(error.message); }
  return new Promise((resolve, reject) => {
    let written = false;
    let buffer = '';
    const socket = net.createConnection(outbox);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(written ? error : unsent(error.message));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The outbox did not answer.')), Math.max(0, deadline - Date.now()));
    socket.setEncoding('utf8');
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('The outbox closed.')));
    socket.once('connect', () => { written = true; socket.write(`${JSON.stringify(request)}\n`); });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) { if (Buffer.byteLength(buffer) > 64 * 1024) finish(new Error('The outbox reply is too large.')); return; }
      let value;
      try { value = JSON.parse(buffer.slice(0, end)); } catch {}
      if (keys(value, ['applied']) && Number.isInteger(value.applied) && value.applied >= 0) finish(null, value.applied);
      else finish(new Error('The outbox sent an invalid reply.'));
    });
  });
}

export const validRelayReply = (value) => (keys(value, ['ok', 'outcome']) && value.ok === true && value.outcome === 'socket-written')
  || (keys(value, ['ok', 'reason']) && value.ok === false && REASONS.includes(value.reason));

// Plan 16.6: a member's /peer/v1/peers reply; invalid entries are dropped.
export function validPeerList(value) {
  if (!keys(value, ['peers']) || !Array.isArray(value.peers) || value.peers.length > 256) return null;
  return value.peers.filter((peer) => keys(peer, ['sessionId', 'name', 'agent', 'status', 'remoteControl']) && uuid(peer.sessionId)
    && text(peer.name, 1, 128) && ['claude', 'codex'].includes(peer.agent) && text(peer.status, 0, 32) && typeof peer.remoteControl === 'boolean')
    .map(({ sessionId, name, agent, status, remoteControl }) => ({ sessionId, name, agent, status, remoteControl }));
}

const isFolder = async (folder) => (await fs.stat(folder).catch(() => null))?.isDirectory() === true;

// GET /api/relay/homes: the Claude config homes of the enabled Claude sources, then ~/.claude and CLAUDE_CONFIG_DIR.
// The first home of each real sessions folder wins (a profile's sessions can link to another home's). A folder that does not exist gets no proxy rows.
export async function relayHomes(sources, { env = process.env, homeDir = os.homedir() } = {}) {
  const candidates = [
    ...sources.filter((source) => source.enabled && source.provider === 'claude-desktop-code' && source.projectsDir)
      .map((source) => ({ path: path.dirname(source.projectsDir), remoteClaude: source.remoteClaude || 'auto' })),
    { path: path.join(homeDir, '.claude'), remoteClaude: 'auto' },
    ...(typeof env.CLAUDE_CONFIG_DIR === 'string' && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? [{ path: env.CLAUDE_CONFIG_DIR, remoteClaude: 'auto' }] : []),
  ];
  const homes = new Map();
  for (const candidate of candidates) {
    if (!await isFolder(candidate.path)) continue;
    const real = await fs.realpath(candidate.path);
    const sessions = await fs.realpath(path.join(real, 'sessions')).catch(() => path.join(real, 'sessions'));
    if (homes.has(sessions)) continue;
    const records = await readLiveClaudeRegistry([path.join(real, 'sessions')]).catch(() => []);
    homes.set(sessions, { path: real, remoteClaude: candidate.remoteClaude,
      hasRemoteControl: records.some((record) => record.bridgeSessionId && record.entrypoint !== 'asb-relay') });
  }
  return [...homes.values()];
}

const isFile = async (file) => (await fs.stat(file).catch(() => null))?.isFile() === true;

// The first stdout line of the relay, or '' after the time limit or the end of the output.
function firstLine(stream, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = '';
    const done = (line) => {
      clearTimeout(timer);
      stream.off('data', data);
      stream.off('end', end);
      // Later output is not read, so the pipe never fills.
      stream.resume();
      resolve(line);
    };
    const data = (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at >= 0) done(buffer.slice(0, at));
      else if (buffer.length > 4096) done('');
    };
    const end = () => done('');
    const timer = setTimeout(() => done(''), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', data);
    stream.on('end', end);
  });
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    if (keys(value, ['port', 'token']) && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
      && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)) return value;
  } catch {}
  return null;
}

const relayError = (message, status) => Object.assign(new Error(message), { code: 'relay-unavailable', ...(status ? { status } : {}) });
const TARGET_UNAVAILABLE = { ok: false, reason: 'target-unavailable' };
const INVALID = { status: 400, body: { error: 'Invalid relay request.' } };

// Plan 8.4: what a member's reply to POST /peer/v1/deliver proves. `unknown` goes only to the local bridge, never on the member wire.
// A v1 member also sends target-unavailable, refused, and machine-offline when it is not sure, so these are unknown.
function memberOutcome({ status, body }) {
  if ([400, 401, 403, 410].includes(status)) return { ok: false, reason: 'refused' };
  if (status === 200 && validRelayReply(body) && (body.ok || ['too-large', 'rate-limited'].includes(body.reason))) return body;
  return { ok: false, reason: 'unknown' };
}

// Plan 16.1, 17.6: runs bridge/dist/relay.js while this Linux or Windows machine shares a group with another active member.
// catPath is the placeholder that each proxy row of the relay runs (bridge/src/relay.ts): findstr.exe on Windows, else `cat` from PATH.
export function createRelaySupervisor({ group, port, sourceToken, root = ROOT, env = process.env, platform = process.platform,
  spawn = spawnProcess, request = peerRequest, log = (line) => console.error(line), now = Date.now,
  catPath = platform === 'win32' ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'findstr.exe') : '',
  firstLineMs = 10_000, stopMs = 2_000, bindTarget = async () => { throw new Error('No exact binder.'); }, outbox = null }) {
  const relayJs = path.join(root, 'bridge', 'dist', 'relay.js');
  let child = null;
  let relay = null;
  let stopped = false;
  let blocked = false;
  // bunMissing: only Bun is missing now. bunLogged: the line about it was logged and Bun has not come back since.
  let bunMissing = false;
  let bunLogged = false;
  let restarts = [];
  let checking = Promise.resolve();
  let checkTimer = null;
  let listTimer = null;
  const lists = new Map();
  const ending = new WeakSet();
  // The exact member sends of this engine, by msgId, in memory only (no text): the receipts of the member come back to them.
  const attempts = new Map();
  const pruneAttempts = () => { for (const [id, attempt] of attempts) if (attempt.expiresAtMs <= now()) attempts.delete(id); };
  const sameReturn = (one, other) => ['runtimeSessionId', 'pid', 'procStart', 'messagingSocketPath'].every((key) => one?.[key] === other?.[key]);

  const selfId = () => group.self()?.machineId || '';
  const others = () => group.peerStates().filter((state) => state.member.machineId !== selfId());
  const online = (state) => {
    const list = lists.get(state.member.machineId);
    return state.online && Boolean(list) && now() - list.atMs <= LIST_STALE_MS;
  };

  async function pollLists() {
    const tls = await group.tls();
    // An offline member's list is not used, and its address timeouts would delay the lists of online members.
    await Promise.all(others().filter((state) => state.online).map(async (state) => {
      try {
        const reply = await request({ member: state.member, path: '/peer/v1/peers', tls });
        const peers = reply.status === 200 ? validPeerList(reply.body) : null;
        if (peers) lists.set(state.member.machineId, { atMs: now(), peers });
      } catch {}
    }));
  }
  const listLoop = async () => {
    await pollLists().catch(() => {});
    if (relay) { listTimer = setTimeout(listLoop, LIST_MS); listTimer.unref?.(); }
  };

  function exited(spawned, code) {
    if (child !== spawned) return;
    child = null;
    relay = null;
    clearTimeout(listTimer);
    lists.clear();
    if (stopped || ending.has(spawned) || code === 0) return;
    restarts = restarts.filter((time) => now() - time < RESTART_WINDOW_MS);
    if (restarts.length >= RESTARTS) {
      if (!blocked) log(RELAY_STOPPED);
      blocked = true;
      return;
    }
    restarts.push(now());
    check();
  }

  async function launch() {
    const bun = await findBun({ platform, env });
    const relayDir = path.join(runtimeDir(env, platform), 'relay');
    const spawned = spawn(bun, [relayJs], { stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...env, ASB_ENGINE_URL: `http://127.0.0.1:${port}`, ASB_SOURCE_TOKEN: sourceToken, ASB_RELAY_DIR: relayDir } });
    child = spawned;
    spawned.once('error', () => exited(spawned, 1));
    spawned.once('exit', (code) => exited(spawned, code));
    spawned.stdin.on('error', () => {});
    const value = parseLine(await firstLine(spawned.stdout, firstLineMs));
    if (child !== spawned) return;
    if (!value) { spawned.kill('SIGKILL'); return; }
    relay = value;
    listLoop();
  }

  async function end(current) {
    ending.add(current);
    if (child === current) { child = null; relay = null; clearTimeout(listTimer); lists.clear(); }
    if (current.exitCode !== null || current.signalCode !== null) return;
    const exit = new Promise((resolve) => current.once('exit', resolve));
    // Windows has no SIGTERM: the end of stdin stops the relay, which removes its rows (plan 17.6).
    if (platform === 'win32') current.stdin.end();
    else current.kill('SIGTERM');
    const timer = setTimeout(() => current.kill('SIGKILL'), stopMs);
    await exit;
    clearTimeout(timer);
  }

  async function wanted() {
    const ready = ['linux', 'win32'].includes(platform) && Boolean(runtimeDir(env, platform)) && others().length > 0
      && await isFile(relayJs) && await isFile(catPath || await findExecutable('cat', { platform, env }));
    const bun = ready && await findBun({ platform, env });
    bunMissing = ready && !bun;
    if (bun) bunLogged = false;
    else if (bunMissing && !bunLogged) {
      // One line, not one every 30 s: the next line comes after Bun was found and lost again.
      bunLogged = true;
      log(`ASB cannot start the message relay: ${bunNotFound(bunFolders({ platform, env }))} Messages to and from other machines do not work.`);
    }
    return Boolean(bun);
  }

  // At engine start, on each group change, and every 30 s.
  function check() {
    // Timers and exit events call this, so it never rejects.
    checking = checking.then(async () => {
      if (stopped) return;
      if (!await wanted()) {
        blocked = false;
        restarts = [];
        if (child) await end(child);
        return;
      }
      if (!child && !blocked) await launch();
    }).catch(() => log('ASB cannot check the message relay.'));
    return checking;
  }

  // The control variant of POST /peer/v2/deliver: the receipt of the member for an exact send of this engine. Every failed
  // check gives the same reply, so the route does not show which message IDs exist.
  async function peerReceipt(value, fingerprint) {
    if (!validReceiptRequest(value)) return INVALID;
    const { control } = value;
    const msgId = control.orig_msg_id;
    const reply = (outcome, reason) => ({ status: 200, body: { api: 2, msgId, outcome, ...(reason ? { reason } : {}) } });
    const live = (attempt) => Boolean(attempt) && now() < attempt.expiresAtMs && attempt.certFingerprint === fingerprint;
    const attempt = attempts.get(msgId);
    if (!live(attempt) || ++attempt.controls > CONTROLS_PER_ATTEMPT) return reply('not-sent', 'binding-expired');
    const msgIds = [msgId];
    for (const id of control.status === 'dropped' ? control.dropped_msg_ids ?? [] : []) {
      const other = attempts.get(id);
      if (!msgIds.includes(id) && live(other) && other.reference === attempt.reference && sameReturn(other.returnTo, attempt.returnTo)) msgIds.push(id);
    }
    const { runtimeSessionId, pid, procStart, messagingSocketPath } = attempt.returnTo ?? {};
    const { status, status_detail, reason, drop_reason } = control;
    const fields = Object.fromEntries(Object.entries({ status_detail, reason, drop_reason }).filter(([, item]) => item !== undefined));
    try {
      await writeReceipt(messagingSocketPath, { exactReceipt: { runtimeSessionId, pid, procStart, reference: attempt.reference, msgIds, status, ...fields } },
        OUTBOX_MS, attempt.returnTo?.configDir);
      return reply('submitted');
    } catch (error) { return error?.unsent ? reply('not-sent', 'target-unavailable') : reply('unknown'); }
  }

  // Windows: Node cannot prove a pipe server and the engine reads no key file, so the relay (Bun) writes the receipt.
  async function relayOutbox(inbox, request, timeoutMs, configDir) {
    if (!relay) throw unsent('The message relay is not running.');
    let reply;
    try { reply = await relayRequest('/outbox', { method: 'POST', body: { configDir, messagingSocketPath: inbox, request }, timeoutMs }); }
    catch (error) { throw [400, 401, 404].includes(error?.status) ? unsent(error.message) : error; }
    if (keys(reply, ['applied']) && Number.isInteger(reply.applied) && reply.applied >= 0) return reply.applied;
    throw reply?.outcome === 'not-sent' ? unsent('The relay did not write the receipt.') : new Error('The message relay sent an invalid reply.');
  }
  const writeReceipt = outbox ?? (platform === 'win32' ? relayOutbox : writeOutbox);

  // One total deadline: a relay that sends headers and then stalls fails too.
  async function relayRequest(target, { method = 'GET', body, timeoutMs = method === 'GET' ? RELAY_LIST_MS : RELAY_DELIVER_MS } = {}) {
    if (!relay) throw relayError('The message relay is not running.');
    const { port: relayPort, token } = relay;
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); if (error) { reject(error); call.destroy(); } else resolve(value); };
      const call = http.request({ host: '127.0.0.1', port: relayPort, path: target, method,
        headers: { authorization: `Bearer ${token}`, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, (reply) => {
        const chunks = [];
        reply.on('data', (chunk) => chunks.push(chunk));
        reply.on('error', finish);
        reply.on('end', () => {
          if (reply.statusCode !== 200) { finish(relayError(`The message relay answered HTTP ${reply.statusCode}.`, reply.statusCode)); return; }
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(relayError('The message relay sent invalid JSON.')); }
        });
      });
      const timer = setTimeout(() => finish(relayError('The message relay did not answer.')), timeoutMs);
      call.on('error', finish);
      call.end(bytes);
    });
  }

  return {
    start() {
      stopped = false;
      checkTimer = setInterval(check, CHECK_MS);
      checkTimer.unref?.();
      return check();
    },
    check,
    async stop() {
      stopped = true;
      clearInterval(checkTimer);
      if (child) await end(child);
      await checking;
    },
    running: () => Boolean(relay),
    // For GET /api/group: why the relay runs or not. `no-bun` means that only Bun is missing.
    status: () => relay ? { state: 'running' } : blocked ? { state: 'stopped' }
      : bunMissing ? { state: 'no-bun', bunFolders: bunFolders({ platform, env }) } : { state: 'not-running' },
    relayRequest,

    // GET /peer/v1/peers.
    async peerPeers() {
      if (!relay) return { status: 200, body: { peers: [] } };
      try { return { status: 200, body: { peers: validPeerList(await relayRequest('/peers')) || [] } }; }
      catch { return { status: 200, body: { peers: [] } }; }
    },
    // POST /peer/v1/deliver; `fingerprint` is the caller's member certificate.
    async peerDeliver(value, fingerprint) {
      if (!validRelayBody(value)) return INVALID;
      if (value.sender.machineId !== fingerprint.slice(0, 16)) return { status: 403, body: { error: 'The sender machine does not match.' } };
      try {
        const reply = await relayRequest('/deliver', { method: 'POST', body: value });
        return { status: 200, body: validRelayReply(reply) ? reply : TARGET_UNAVAILABLE };
      } catch { return { status: 200, body: TARGET_UNAVAILABLE }; }
    },
    // POST /peer/v2/resolve-session: read-only, the member says if it can send to this one session now.
    async peerResolveExact(value, _fingerprint) {
      if (!validResolveRequest(value, selfId())) return INVALID;
      const unavailable = (reason) => ({ status: 200, body: { api: 2, outcome: 'unavailable', reason } });
      let bound;
      try { bound = await bindTarget({ reference: formatReference({ machineId: selfId(), ...value.target }), msgId: randomUUID(), remainingMs: 0 }); }
      catch { return unavailable('target-unavailable'); }
      if (bound?.ok !== true) return unavailable(EXACT_REASONS.includes(bound?.code) ? bound.code : 'target-unavailable');
      if (!relay) return unavailable('relay-unavailable');
      return { status: 200, body: { api: 2, outcome: 'ready' } };
    },
    // POST /peer/v2/deliver: one bound write through the relay, inside the sender's deadline, or (with exactly `api` and
    // `control`) the receipt of an exact send of this engine.
    async peerDeliverExact(value, fingerprint) {
      if (keys(value, ['api', 'control'])) return peerReceipt(value, fingerprint);
      if (!validDeliverRequest(value, selfId())) return INVALID;
      if (value.sender.machineId !== fingerprint.slice(0, 16)) return { status: 403, body: { error: 'The sender machine does not match.' } };
      const { msgId } = value.message;
      const reply = (outcome, reason) => ({ status: 200, body: { api: 2, msgId, outcome, ...(reason ? { reason } : {}) } });
      const deadline = now() + Math.min(value.remainingMs - 500, RELAY_DELIVER_MS);
      let bound;
      try { bound = await bindTarget({ reference: formatReference({ machineId: selfId(), ...value.target }), msgId, remainingMs: Math.max(0, deadline - now()) }); }
      catch { return reply('not-sent', 'target-unavailable'); }
      if (bound?.ok !== true) return reply('not-sent', EXACT_REASONS.includes(bound?.code) ? bound.code : 'target-unavailable');
      // The relay write (5 s and the 150 ms flush) must end before the member deadline.
      const expiresAtMs = Math.min(bound.binding.expiresAtMs, deadline - 5_500);
      if (expiresAtMs <= now()) return reply('not-sent', 'binding-expired');
      if (!relay) return reply('not-sent', 'relay-unavailable');
      try {
        const answer = await relayRequest('/deliver-bound', { method: 'POST', body: { binding: { ...bound.binding, expiresAtMs }, sender: value.sender,
          message: value.message }, timeoutMs: deadline - now() });
        return validBoundReply(answer) ? reply(answer.outcome, answer.reason) : reply('unknown');
      } catch (error) {
        // The relay refused the request before any write, or it is an older relay.js without the route.
        return [400, 401, 404].includes(error?.status) ? reply('not-sent', 'relay-unavailable') : reply('unknown');
      }
    },
    // GET /api/relay/homes.
    async homes(sources) {
      return { machineId: selfId(), machineName: group.selfName(), homes: await relayHomes(sources, { env }) };
    },
    // GET /api/relay/remote-peers: the members that answer now.
    remotePeers() {
      return { peers: others().filter(online).flatMap((state) => lists.get(state.member.machineId).peers.map((peer) => ({
        machineId: state.member.machineId, machineName: state.member.name, online: true, ...peer }))) };
    },
    // POST /api/relay/receipt: the receipt of an exact send to this machine goes back to the sending member only, as one
    // control POST. No v1 request. `sent` says that the request went out.
    async sendReceipt(body) {
      if (!validReceiptBody(body)) return INVALID;
      const state = others().find((item) => item.member.machineId === body.machineId);
      if (!state?.online) return { status: 200, body: { sent: false } };
      try {
        await request({ member: state.member, path: '/peer/v2/deliver', method: 'POST', body: { api: 2, control: body.control }, tls: await group.tls(),
          timeoutMs: RECEIPT_POST_MS, lastAddress: state.lastAddress });
        return { status: 200, body: { sent: true } };
      } catch (error) { return { status: 200, body: { sent: Boolean(error?.handedOff) } }; }
    },
    // POST /api/relay/send.
    async send(body) {
      if (!validRelayBody(body, { withMachine: true }) || body.sender.machineId !== selfId()) return INVALID;
      const { machineId, ...forward } = body;
      const state = others().find((item) => item.member.machineId === machineId);
      if (!state) return { status: 200, body: { ok: false, reason: 'refused' } };
      if (!online(state)) return { status: 200, body: { ok: false, reason: 'machine-offline' } };
      let reply;
      try { reply = await request({ member: state.member, path: '/peer/v1/deliver', method: 'POST', body: forward, tls: await group.tls(), timeoutMs: MEMBER_POST_MS,
        lastAddress: state.lastAddress }); }
      catch (error) { return { status: 200, body: { ok: false, reason: error?.handedOff ? 'unknown' : 'machine-offline' } }; }
      return { status: 200, body: memberOutcome(reply) };
    },
    // The sending side of one exact member send: resolve, then at most one deliver, to the reference's machine only.
    // Never a v1 request, a second deliver, or another member. The reply is { outcome, reason? }.
    // `returnTo` is the registry record of the sending task's receiver: the receipts of the member go to its outbox.
    async sendExact({ identity, sender, message, remainingMs, returnTo }) {
      const notSent = (reason) => ({ outcome: 'not-sent', reason });
      pruneAttempts();
      if (attempts.has(message?.msgId)) return notSent('invalid-request');
      const state = others().find((item) => item.member.machineId === identity.machineId);
      if (!state) return notSent('unknown-machine');
      if (!state.online) return notSent('machine-offline');
      const { sourceId, scopeTag, type, appId } = identity;
      const target = { sourceId, scopeTag, type, appId };
      let tls;
      let resolved;
      try {
        tls = await group.tls();
        resolved = await request({ member: state.member, path: '/peer/v2/resolve-session', method: 'POST', body: { api: 2, target }, tls,
          timeoutMs: 4_000, lastAddress: state.lastAddress });
      } catch (error) { return notSent(error?.handedOff ? 'capability-unknown' : 'machine-offline'); }
      if (resolved.status === 404) return notSent('peer-upgrade-required');
      if ([400, 401, 403, 410, 429].includes(resolved.status)) return notSent('refused');
      if (resolved.status !== 200 || !validResolveReply(resolved.body)) return notSent('capability-unknown');
      if (resolved.body.outcome === 'unavailable') return notSent(resolved.body.reason);
      const deliverMs = Math.min(MEMBER_POST_MS, remainingMs);
      if (deliverMs <= 1_000) return notSent('binding-expired');
      const body = { api: 2, target, sender: { ...sender, machineId: selfId() }, message, remainingMs: deliverMs - 1_000 };
      if (!validDeliverRequest(body, identity.machineId)) return notSent('invalid-request');
      // Saved before the deliver: the receipt can come before its reply. A not-sent result gives no receipt.
      attempts.set(message.msgId, { certFingerprint: state.member.certFingerprint, reference: identity.reference, returnTo,
        expiresAtMs: now() + ATTEMPT_MS, controls: 0 });
      while (attempts.size > ATTEMPTS) attempts.delete(attempts.keys().next().value);
      const result = await (async () => {
        let reply;
        try {
          reply = await request({ member: state.member, path: '/peer/v2/deliver', method: 'POST', body, tls, timeoutMs: deliverMs,
            lastAddress: resolved.address });
        } catch (error) { return error?.handedOff ? { outcome: 'unknown' } : notSent('machine-offline'); }
        if (reply.status === 404) return notSent('peer-upgrade-required');
        if ([400, 401, 403, 410, 429].includes(reply.status)) return notSent('refused');
        if (reply.status === 413) return notSent('too-large');
        if (reply.status === 200 && validDeliverReply(reply.body) && reply.body.msgId === message.msgId) {
          return reply.body.outcome === 'not-sent' ? notSent(reply.body.reason) : { outcome: reply.body.outcome };
        }
        return { outcome: 'unknown' };
      })();
      if (result.outcome === 'not-sent') attempts.delete(message.msgId);
      return result;
    },
  };
}
