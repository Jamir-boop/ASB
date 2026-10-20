// The parts of the peer transport that differ on Windows (plan 17.1, spikes S3b and S4). Windows has no uid or mode
// bits and no Unix socket files for Claude: it uses cc-msg named pipes, a key file per process, and an auth line.
import net from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync, chmodSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';

const PIPE = '\\\\.\\pipe\\';
// Claude's rule for a Windows messaging address (S3b).
const PEER_PIPE = /^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i;
// The pipe of a receiver's outbound server (outboxPath).
const OUT_PIPE = /^\\\\\.\\pipe\\LOCAL\\asb-out-[0-9a-f]{32}$/;
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

// The Win32 signatures, in one place so the bridge-windows CI job proves them all. The three old symbols keep their
// types; a new BOOL is an i32, and CreateFileW returns an i64 so INVALID_HANDLE_VALUE stays exact (-1n).
// Handle arguments are ptr, which takes a Pointer or a bigint.
const kernel32Symbols = {
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
  GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
  GetNamedPipeServerProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  SetNamedPipeHandleState: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  WriteFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ReadFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  PeekNamedPipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;
const advapi32Symbols = {
  OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetTokenInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  EqualSid: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;
const openWindowsApi = () => ({ ...dlopen('kernel32.dll', kernel32Symbols).symbols, ...dlopen('advapi32.dll', advapi32Symbols).symbols });
export type WindowsApi = ReturnType<typeof openWindowsApi>;
let windowsSymbols: WindowsApi | undefined;
const windowsApi = () => windowsSymbols ??= openWindowsApi();

// Claude on Windows records the creation FILETIME from GetProcessTimes as a decimal string (S3b).
function creationTime(api: WindowsApi, handle: Pointer | bigint) {
  const times = new BigUint64Array(4);
  if (!api.GetProcessTimes(handle, times.subarray(0, 1), times.subarray(1, 2), times.subarray(2, 3), times.subarray(3))) throw new Error('Cannot verify receiver process');
  return String(times[0]);
}

export async function processStart(pid: number) {
  if (isWindows()) {
    const api = windowsApi();
    const handle = api.OpenProcess(0x1000, false, pid);
    if (!handle) throw new Error('Cannot verify receiver process');
    try { return creationTime(api, handle); } finally { api.CloseHandle(handle); }
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

export type ProvedPipe = {
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readLine(maxBytes: number, signal: AbortSignal): Promise<string>;
  close(): void;
};
const unproved = () => new Error('The pipe server is not the registered process');

// Opens the client end of a local pipe and proves its server before any byte: the registry PID, its creation
// FILETIME, and this Windows user. A failed check closes the handle and throws. Only the proved handle carries bytes.
export function pipeProof(path: string, pid: number, procStart: string, api: WindowsApi = windowsApi()): ProvedPipe {
  if (!PEER_PIPE.test(path) && !OUT_PIPE.test(path)) throw new Error('Invalid peer socket');
  // Read and write, no sharing, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server can
  // identify this process but cannot act as it.
  const pipe = api.CreateFileW(Buffer.from(`${path}\0`, 'utf16le'), 0xC0000000, 0, null, 3, 0x00110000, null);
  if (pipe === -1n || pipe === 0n) throw unproved();
  try {
    const server = new Uint32Array(1);
    if (!api.GetNamedPipeServerProcessId(pipe, server) || server[0] !== pid) throw unproved();
    // One handle gives the creation time and the user, so a reused PID cannot pass.
    const owner = api.OpenProcess(0x1000, false, pid);
    if (!owner) throw unproved();
    try { if (creationTime(api, owner) !== procStart || !sameUser(api, owner)) throw unproved(); }
    finally { api.CloseHandle(owner); }
    if (!api.SetNamedPipeHandleState(pipe, new Uint32Array([1]), null, null)) throw unproved();
  } catch (error) { api.CloseHandle(pipe); throw error; }
  return provedPipe(api, pipe);
}

// Module buffers: the SID pointers of TOKEN_USER point into them, so they must live until EqualSid returns.
const tokenUsers = [new Uint8Array(256), new Uint8Array(256)] as const;

function tokenUser(api: WindowsApi, process: Pointer | bigint, buffer: Uint8Array) {
  const token = new BigUint64Array(1);
  if (!api.OpenProcessToken(process, 0x8, token)) return false;
  try { return !!api.GetTokenInformation(token[0]!, 1, buffer, buffer.length, new Uint32Array(1)); }
  finally { api.CloseHandle(token[0]!); }
}

function sameUser(api: WindowsApi, owner: Pointer | bigint) {
  const self = api.OpenProcess(0x1000, false, process.pid);
  if (!self) return false;
  try {
    const [mine, theirs] = tokenUsers;
    // TOKEN_USER starts with the PSID.
    return tokenUser(api, self, mine) && tokenUser(api, owner, theirs)
      && !!api.EqualSid(read.ptr(ptr(mine)) as Pointer, read.ptr(ptr(theirs)) as Pointer);
  } finally { api.CloseHandle(self); }
}

const PIPE_CHUNK = 4096;
// shortcut: polls a PIPE_NOWAIT handle every 5 ms; use overlapped I/O if a live check shows lost or slow writes.
function provedPipe(api: WindowsApi, pipe: bigint): ProvedPipe {
  let pending = Buffer.alloc(0);
  let closed = false;
  return {
    async write(bytes, signal) {
      const done = new Uint32Array(1);
      for (let offset = 0; offset < bytes.length; offset += done[0]!) {
        signal.throwIfAborted();
        // On the Windows CI runner, a NOWAIT write larger than the free pipe buffer wrote 0 bytes, so ask for one chunk at a time.
        const size = Math.min(PIPE_CHUNK, bytes.length - offset);
        if (!api.WriteFile(pipe, bytes.subarray(offset, offset + size), size, done, null)) throw new Error('Pipe write failed');
        if (!done[0]) await Bun.sleep(5);
      }
    },
    // The first line, without its newline; more than maxBytes without a newline throws.
    async readLine(maxBytes, signal) {
      const available = new Uint32Array(1);
      const done = new Uint32Array(1);
      for (;;) {
        const end = pending.indexOf(10);
        if (end >= 0) {
          const line = pending.subarray(0, end).toString();
          pending = pending.subarray(end + 1);
          return line;
        }
        if (pending.length >= maxBytes) throw new Error('Pipe line too long');
        signal.throwIfAborted();
        // FALSE means the server closed the pipe and no data is left.
        if (!api.PeekNamedPipe(pipe, null, 0, null, available, null)) throw new Error('Pipe closed before a full line');
        if (!available[0]) { await Bun.sleep(5); continue; }
        const chunk = new Uint8Array(Math.min(available[0], maxBytes - pending.length));
        if (!api.ReadFile(pipe, chunk, chunk.length, done, null)) throw new Error('Pipe read failed');
        pending = Buffer.concat([pending, chunk.subarray(0, done[0])]);
      }
    },
    close() {
      if (!closed) api.CloseHandle(pipe);
      closed = true;
    },
  };
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
