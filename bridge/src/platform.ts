// The parts of the peer transport that differ on Windows (plan 17.1, spikes S3b and S4). Windows has no uid or mode
// bits and no Unix socket files for Claude: it uses cc-msg named pipes, a key file per process, and an auth line.
import net from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync, chmodSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { dlopen, FFIType, ptr } from 'bun:ffi';

const PIPE = '\\\\.\\pipe\\';
// Claude's rule for a Windows messaging address (S3b).
const PEER_PIPE = /^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i;
export const CODEX_PIPE = '\\\\.\\pipe\\codex-ipc';

export const isWindows = (platform: string = process.platform) => platform === 'win32';

export function ownedJson(path: string, maxBytes: number, platform: string = process.platform): unknown {
  // Windows: lstat first, because O_NOFOLLOW does not exist there; a junction is a symbolic link to lstat.
  if (isWindows(platform)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error('Invalid local metadata file');
  }
  const fd = openSync(path, isWindows(platform) ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || (!isWindows(platform) && stat.uid !== process.getuid?.())) throw new Error('Invalid local metadata file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export function privateDirectory(path: string, platform: string = process.platform) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (!isWindows(platform) && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) {
    throw new Error('Socket/state directory must be private and owned by the current user');
  }
}

export function checkSocket(path: string) {
  if (!isAbsolute(path) || path.split('/').includes('..')) throw new Error('Invalid socket path');
  privateDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Invalid peer socket');
}

export function checkPeerSocket(path: string, platform: string = process.platform) {
  if (!isWindows(platform)) return checkSocket(path);
  if (!PEER_PIPE.test(path)) throw new Error('Invalid peer socket');
}

// Codex's app-server socket on Windows is an AF_UNIX reparse point that Bun cannot lstat or stat; readdir sees it.
export function checkSocketFile(path: string, platform: string = process.platform) {
  if (!isWindows(platform)) return checkSocket(path);
  privateDirectory(dirname(path), platform);
  const entry = readdirSync(dirname(path), { withFileTypes: true }).find(item => item.name === basename(path));
  if (!entry) throw Object.assign(new Error(`Socket not found: ${path}`), { code: 'ENOENT' });
  if (entry.isDirectory()) throw new Error('Invalid socket path');
}

let kernel32: ReturnType<typeof openKernel32> | undefined;
function openKernel32() {
  return dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  }).symbols;
}

export async function processStart(pid: number) {
  if (isWindows()) {
    // Claude on Windows records the creation FILETIME from GetProcessTimes as a decimal string (S3b).
    const api = kernel32 ??= openKernel32();
    const handle = api.OpenProcess(0x1000, false, pid);
    if (!handle) throw new Error('Cannot verify receiver process');
    try {
      const times = new BigUint64Array(4);
      if (!api.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) throw new Error('Cannot verify receiver process');
      return String(times[0]);
    } finally { api.CloseHandle(handle); }
  }
  if (process.platform === 'linux') {
    // Claude Code on Linux records the kernel start time (field 22 of /proc/<pid>/stat), not `ps lstart`.
    const start = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()?.split(' ')[19];
    if (!start) throw new Error('Cannot verify receiver process');
    return start;
  }
  const child = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)],
    { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore' });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0 || !output.trim()) throw new Error('Cannot verify receiver process');
  return output.trim();
}

export function pidDomain(platform: string = process.platform) {
  if (isWindows(platform)) return `win32:${hostname().toLowerCase()}`;
  return platform === 'darwin' ? 'darwin' : undefined;
}

export function inboxPath(directory: string, fileName = `${process.pid}.sock`, platform: string = process.platform) {
  return isWindows(platform) ? `${PIPE}LOCAL\\cc-msg-${randomBytes(16).toString('hex')}` : join(directory, fileName);
}

export function outboxPath(inbox: string, platform: string = process.platform) {
  if (!isWindows(platform)) return inbox.replace(/\.sock$/, '.out');
  if (!PEER_PIPE.test(inbox)) throw new Error('Invalid peer socket');
  return `${PIPE}LOCAL\\asb-out-${inbox.slice(-32).toLowerCase()}`;
}

// For a pipe, Claude hashes `\\.\pipe\` plus the lower-case pipe name (S3b); a socket path is hashed as it is.
export function keyName(pid: number, socketPath: string) {
  const canonical = socketPath.slice(0, PIPE.length).toLowerCase() === PIPE.toLowerCase()
    ? PIPE + socketPath.slice(PIPE.length).toLowerCase() : socketPath;
  return `${pid}.${createHash('sha256').update(canonical).digest('hex')}.key`;
}

export async function listenPrivate(server: net.Server, path: string, platform: string = process.platform) {
  if (isWindows(platform)) { server.listen(path); await once(server, 'listening'); return; }
  const mask = process.umask(0o077);
  try { server.listen(path); await once(server, 'listening'); }
  finally { process.umask(mask); }
  chmodSync(path, 0o600);
}
