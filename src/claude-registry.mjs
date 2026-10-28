// Reads Claude Code's live session registry (<config>/sessions/<pid>.json) and app approvals (<appDir>/logs/main.log). Neither is a published API;
// the waiting status and waitingFor fields were observed in Claude Code 2.1.299, so callers treat them as best effort.
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_RECORD_BYTES = 256 * 1024;
const BRIDGE_SESSION = /^(?:cse|session)_[A-Za-z0-9_-]{1,128}$/;
const text = (value) => typeof value === 'string' ? value : null;
// Claude's rule for a Windows messaging address: a copy of PEER_PIPE in bridge/src/platform.ts:13.
const PEER_PIPE = /^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i;
const FILETIME = /^[0-9]{1,20}$/;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function processStart(pid) {
  try {
    if ((await fs.stat(`/proc/${pid}`)).uid !== process.getuid()) return null;
    const fields = (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').pop().split(' ');
    return fields[0] === 'Z' ? null : fields[19] ?? null;
  } catch { return null; }
}

// Windows has no uid and no O_NOFOLLOW: lstat first, as ownedJson in bridge/src/platform.ts does.
async function readRecord(file, windows = false) {
  let handle;
  try {
    if (windows) {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
    }
    handle = await fs.open(file, windows ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (!windows && info.uid !== process.getuid()) || info.size > MAX_RECORD_BYTES) return null;
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size > info.size ? null : JSON.parse(buffer.subarray(0, size));
  } catch { return null; } finally { await handle.close(); }
}

export async function readLiveClaudeRegistryFolder(root, { windows = false, registryReads = null } = {}) {
  if (!registryReads) return readLiveClaudeRegistry([root], { windows });
  const real = await fs.realpath(root);
  const key = JSON.stringify([real, windows]);
  if (!registryReads.has(key)) registryReads.set(key, readLiveClaudeRegistry([real], { windows }));
  return registryReads.get(key);
}

// Returns verified live records only: owned files whose process is alive with the recorded start time.
// The Windows rules run only for a caller that asks for them.
// The engine runs on Node with no FFI, so on Windows it checks the PID and, for a record with a message pipe, that the pipe exists.
// A dead process's pipe goes with it, so a reused PID cannot keep its record. ASB Bridge proves the start time,
// the pipe server, and the user at the write.
export async function readLiveClaudeRegistry(roots, { windows = false, isAlive = pidAlive, listPipes = () => fs.readdir('\\\\.\\pipe\\') } = {}) {
  if (!windows && process.platform !== 'linux') return [];
  // The pipe names without the `\\.\pipe\` part, in lower case; null when the list cannot be read, so the PID rule applies.
  const pipes = windows ? await listPipes().then((names) => new Set(names.map((name) => name.toLowerCase())), () => null) : null;
  const pipeListed = (record) => pipes === null || typeof record.messagingSocketPath !== 'string' || !PEER_PIPE.test(record.messagingSocketPath)
    || pipes.has(record.messagingSocketPath.slice('\\\\.\\pipe\\'.length).toLowerCase());
  const realRoots = new Set();
  for (const root of roots) {
    const real = await fs.realpath(root).catch(() => null);
    if (real) realRoots.add(real);
  }
  const records = new Map();
  for (const root of realRoots) {
    let files;
    try { files = await fs.readdir(root); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    for (const file of files.filter((name) => /^[1-9][0-9]*\.json$/.test(name))) {
      const record = await readRecord(path.join(root, file), windows);
      if (!record || typeof record !== 'object' || Array.isArray(record) || record.pid !== Number(file.slice(0, -5))
        || typeof record.name !== 'string' || typeof record.sessionId !== 'string'
        || record.procStart === undefined || record.procStart === null) continue;
      const start = windows ? (typeof record.procStart === 'string' && FILETIME.test(record.procStart) && isAlive(record.pid) && pipeListed(record) ? record.procStart : null)
        : await processStart(record.pid);
      if (start === null || start !== String(record.procStart)) continue;
      records.set(`${record.pid}:${start}`, { pid: record.pid, procStart: start, sessionId: record.sessionId,
        hostSessionId: text(record.hostSessionId), name: record.name, status: text(record.status),
        waitingFor: typeof record.waitingFor === 'string' && record.waitingFor.length <= 64 ? record.waitingFor : undefined,
        statusUpdatedAt: Number.isFinite(record.statusUpdatedAt) ? record.statusUpdatedAt : 0,
        cwd: text(record.cwd), kind: text(record.kind), entrypoint: text(record.entrypoint),
        startedAt: Number.isFinite(record.startedAt) ? record.startedAt : 0,
        bridgeSessionId: typeof record.bridgeSessionId === 'string' && BRIDGE_SESSION.test(record.bridgeSessionId)
          ? record.bridgeSessionId : undefined,
        // Only a record of the peer protocol has an inbox that the ASB Bridge can write to.
        messagingSocketPath: record.peerProtocol === 1 && typeof record.messagingSocketPath === 'string'
          && (!windows || PEER_PIPE.test(record.messagingSocketPath)) ? record.messagingSocketPath : undefined });
    }
  }
  return [...records.values()];
}

const APPROVAL_WINDOW_BYTES = 1024 * 1024;
const approvalLogs = new Map();
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOG_TIME = '(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) \\[info\\] ';
const TOOL = '[A-Za-z0-9_:.-]{1,128}';
const emittedApproval = new RegExp(`^${LOG_TIME}Emitted tool permission request (${UUID}) for (${TOOL}) in session (local_${UUID})$`);
const receivedApproval = new RegExp(`^${LOG_TIME}Received permission response for (${UUID}):`);
const respondedApproval = new RegExp(`^${LOG_TIME}LocalSessions\\.respondToToolPermission: requestId=(${UUID}),`);
const abortedApproval = new RegExp(`^${LOG_TIME}Permission request (${UUID}) for ${TOOL} aborted$`);
// Only a finished quit writes willQuit; a vetoed quit and a second app launch keep the approvals open.
const quitApprovals = new RegExp(`^${LOG_TIME}willQuit: handler fired`);

// shortcut: Requests older than the read window or open across a log rotation are not seen; upgrade when the app writes open approvals to a state file.
export async function readClaudeAppApprovals(appDir, { windows = process.platform === 'win32' } = {}) {
  const file = path.join(appDir, 'logs', 'main.log');
  let handle;
  try {
    handle = await fs.open(file, windows ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return new Map();
    let state = approvalLogs.get(file);
    if (!state || state.dev !== info.dev || state.ino !== info.ino || info.size < state.offset
      || info.size - state.offset > 4 * APPROVAL_WINDOW_BYTES) {
      state = { dev: info.dev, ino: info.ino, offset: Math.max(0, info.size - APPROVAL_WINDOW_BYTES), open: new Map(), emitted: 0, received: 0 };
      state.skipFirst = state.offset > 0;
    }
    const readOffset = state.offset;
    const buffer = Buffer.alloc(info.size - readOffset);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, readOffset + size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const completeEnd = buffer.subarray(0, size).lastIndexOf(10) + 1;
    state.offset = readOffset + completeEnd;
    const lines = buffer.subarray(0, completeEnd).toString('utf8').split('\n');
    lines.pop();
    for (const raw of lines) {
      if (state.skipFirst) { state.skipFirst = false; continue; }
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const emitted = emittedApproval.exec(line);
      if (emitted) {
        const [, year, month, day, hour, minute, second, requestId, tool, sessionId] = emitted;
        state.open.delete(requestId);
        state.open.set(requestId, { sessionId, tool, atMs: new Date(+year, +month - 1, +day, +hour, +minute, +second).getTime() });
        if (state.open.size > 256) state.open.delete(state.open.keys().next().value);
        state.emitted += 1;
      } else {
        const received = receivedApproval.exec(line);
        if (received) state.received += 1;
        const closed = received || respondedApproval.exec(line) || abortedApproval.exec(line);
        if (closed) state.open.delete(closed[7]);
        else if (quitApprovals.test(line)) state.open.clear();
      }
    }
    approvalLogs.set(file, state);
    const approvals = new Map();
    for (const { sessionId, tool, atMs } of state.open.values()) {
      if (!approvals.has(sessionId) || atMs >= approvals.get(sessionId).atMs) approvals.set(sessionId, { tool, atMs });
    }
    // Many responses with no request mean that the app changed its request line.
    Object.defineProperty(approvals, 'formatChanged', { value: state.received >= 3 && state.emitted === 0 });
    return approvals;
  } catch {
    approvalLogs.delete(file);
    return new Map();
  } finally { await handle?.close().catch(() => {}); }
}
