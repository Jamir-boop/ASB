// The engine side of the message relay between machines (plan 9.6, 9.7, 16): the relay body checks, the supervisor of
// bridge/dist/relay.js, the peer lists of the members, and the handlers of the member and loopback relay routes.
import { spawn as spawnProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLiveClaudeRegistry } from './claude-registry.mjs';
import { peerRequest } from './machine-peers.mjs';
import { findExecutable, runtimeDir } from './platform-paths.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX16 = /^[a-f0-9]{16}$/;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const STATUSES = ['held', 'denied', 'expired', 'delivered', 'refused', 'dropped'];
const REASONS = ['machine-offline', 'target-unavailable', 'too-large', 'rate-limited', 'refused'];
const LIST_MS = 5_000;
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

// Plan 9.7: the body of POST /peer/v1/deliver, and of POST /api/relay/send with the target `machineId`.
export function validRelayBody(value, { withMachine = false } = {}) {
  const kind = object(value) && Object.hasOwn(value, 'message') ? 'message' : 'control';
  if (!keys(value, ['targetSessionId', 'sender', kind, ...(withMachine ? ['machineId'] : [])])) return false;
  const { sender, message, control } = value;
  if ((withMachine && !hex16(value.machineId)) || !uuid(value.targetSessionId)
    || !keys(sender, ['machineId', 'sessionId', 'name', 'mode', 'agent']) || !hex16(sender.machineId) || !uuid(sender.sessionId)
    || !text(sender.name, 1, 128) || CONTROLS.test(sender.name) || !['prompting', 'bypass', 'unknown'].includes(sender.mode)
    || !['claude', 'codex'].includes(sender.agent)) return false;
  if (kind === 'message') {
    return keys(message, ['msgId', 'text', 'hopChain']) && uuid(message.msgId) && text(message.text, 1, 1_048_576)
      && Array.isArray(message.hopChain) && message.hopChain.length <= 32
      && message.hopChain.every((token) => typeof token === 'string' && /^[a-f0-9]{24}$/.test(token));
  }
  return keys(control, ['action', 'orig_msg_id', 'status'], ['status_detail', 'reason', 'drop_reason', 'dropped_msg_ids'])
    && control.action === 'peer_message_status' && uuid(control.orig_msg_id) && STATUSES.includes(control.status)
    && optionalText(control.status_detail, 64) && optionalText(control.reason, 1000) && optionalText(control.drop_reason, 64)
    && (control.dropped_msg_ids === undefined || (Array.isArray(control.dropped_msg_ids) && control.dropped_msg_ids.length <= 256
      && control.dropped_msg_ids.every(uuid)));
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
// The first home of each real folder wins. A folder that does not exist gets no proxy rows.
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
    if (homes.has(real)) continue;
    const records = await readLiveClaudeRegistry([path.join(real, 'sessions')]).catch(() => []);
    homes.set(real, { path: real, remoteClaude: candidate.remoteClaude,
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

const relayError = (message) => Object.assign(new Error(message), { code: 'relay-unavailable' });
const TARGET_UNAVAILABLE = { ok: false, reason: 'target-unavailable' };
const INVALID = { status: 400, body: { error: 'Invalid relay request.' } };

// Plan 16.1, 17.6: runs bridge/dist/relay.js while this Linux or Windows machine shares a group with another active member.
// catPath is the placeholder that each proxy row of the relay runs (bridge/src/relay.ts).
export function createRelaySupervisor({ group, port, sourceToken, root = ROOT, env = process.env, platform = process.platform,
  spawn = spawnProcess, request = peerRequest, log = (line) => console.error(line), now = Date.now,
  catPath = platform === 'win32' ? path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'findstr.exe') : '/usr/bin/cat',
  firstLineMs = 10_000, stopMs = 2_000 }) {
  const relayJs = path.join(root, 'bridge', 'dist', 'relay.js');
  let child = null;
  let relay = null;
  let stopped = false;
  let blocked = false;
  let restarts = [];
  let checking = Promise.resolve();
  let checkTimer = null;
  let listTimer = null;
  const lists = new Map();
  const ending = new WeakSet();

  const selfId = () => group.self()?.machineId || '';
  const others = () => group.peerStates().filter((state) => state.member.machineId !== selfId());
  const online = (state) => {
    const list = lists.get(state.member.machineId);
    return state.online && Boolean(list) && now() - list.atMs <= LIST_STALE_MS;
  };

  async function pollLists() {
    const tls = await group.tls();
    await Promise.all(others().map(async (state) => {
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
    const bun = await findExecutable('bun', { platform, env });
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
    if (!['linux', 'win32'].includes(platform) || !runtimeDir(env, platform) || !others().length) return false;
    return Boolean(await findExecutable('bun', { platform, env })) && await isFile(relayJs) && await isFile(catPath);
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

  async function relayRequest(target, { method = 'GET', body } = {}) {
    if (!relay) throw relayError('The message relay is not running.');
    const { port: relayPort, token } = relay;
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const call = http.request({ host: '127.0.0.1', port: relayPort, path: target, method, timeout: 10_000,
        headers: { authorization: `Bearer ${token}`, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, (reply) => {
        const chunks = [];
        reply.on('data', (chunk) => chunks.push(chunk));
        reply.on('error', reject);
        reply.on('end', () => {
          if (reply.statusCode !== 200) { reject(relayError(`The message relay answered HTTP ${reply.statusCode}.`)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(relayError('The message relay sent invalid JSON.')); }
        });
      });
      call.on('timeout', () => call.destroy(relayError('The message relay did not answer.')));
      call.on('error', reject);
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
    // GET /api/relay/homes.
    async homes(sources) {
      return { machineId: selfId(), machineName: group.selfName(), homes: await relayHomes(sources, { env }) };
    },
    // GET /api/relay/remote-peers: the members that answer now.
    remotePeers() {
      return { peers: others().filter(online).flatMap((state) => lists.get(state.member.machineId).peers.map((peer) => ({
        machineId: state.member.machineId, machineName: state.member.name, online: true, ...peer }))) };
    },
    // POST /api/relay/send.
    async send(body) {
      if (!validRelayBody(body, { withMachine: true }) || body.sender.machineId !== selfId()) return INVALID;
      const { machineId, ...forward } = body;
      const state = others().find((item) => item.member.machineId === machineId);
      if (!state) return { status: 200, body: { ok: false, reason: 'refused' } };
      if (!online(state)) return { status: 200, body: { ok: false, reason: 'machine-offline' } };
      let reply;
      try { reply = await request({ member: state.member, path: '/peer/v1/deliver', method: 'POST', body: forward, tls: await group.tls(), timeoutMs: 10_000 }); }
      catch { return { status: 200, body: { ok: false, reason: 'machine-offline' } }; }
      return { status: 200, body: reply.status === 200 && validRelayReply(reply.body) ? reply.body : { ok: false, reason: 'refused' } };
    },
  };
}
