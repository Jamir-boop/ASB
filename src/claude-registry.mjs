// Reads Claude Code's live session registry (<config>/sessions/<pid>.json). It is not a published API;
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
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return size > MAX_RECORD_BYTES ? null : JSON.parse(buffer.subarray(0, size));
  } catch { return null; } finally { await handle.close(); }
}

// Returns verified live records only: owned files whose process is alive with the recorded start time.
// The Windows rules run only for a caller that asks for them, so the Windows board and the relay homes do not change.
// The engine runs on Node with no FFI, so on Windows it checks only the PID; ASB Bridge proves the start time,
// the pipe server, and the user at the write.
export async function readLiveClaudeRegistry(roots, { windows = false, isAlive = pidAlive } = {}) {
  if (!windows && process.platform !== 'linux') return [];
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
      const start = windows ? (typeof record.procStart === 'string' && FILETIME.test(record.procStart) && isAlive(record.pid) ? record.procStart : null)
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
