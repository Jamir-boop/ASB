import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { runtimeDir } from '../src/platform-paths.mjs';

export const instanceRuntimePath = (env = process.env, platform = process.platform) => {
  const directory = runtimeDir(env, platform);
  return directory && path.join(directory, 'service.json');
};
// Windows has no POSIX owner or mode bits; there the folder ACL (icacls) limits access, and links are still refused.
const owned = (info, platform = process.platform) => platform === 'win32' || !process.getuid || info.uid === process.getuid();
const privateMode = (info, mode, platform = process.platform) => platform === 'win32' || (info.mode & 0o777) === mode;
const validRuntime = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === 'pid,port,schema,sourceToken' && value.schema === 1
  && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
  && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
  && typeof value.sourceToken === 'string' && /^[a-f0-9]{64}$/.test(value.sourceToken);

async function runtimeContents(file, platform = process.platform) {
  const directory = await lstat(path.dirname(file));
  if (!directory.isDirectory() || !owned(directory, platform) || !privateMode(directory, 0o700, platform)) throw new Error('Unsafe ASB runtime folder.');
  // Windows has no O_NOFOLLOW, so a link check comes first there.
  if (platform === 'win32' && (await lstat(file)).isSymbolicLink()) throw new Error('Unsafe ASB runtime file.');
  const handle = await open(file, platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !owned(info, platform) || !privateMode(info, 0o600, platform) || info.size > 4096) throw new Error('Unsafe ASB runtime file.');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('ASB runtime file is too large.');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function readServiceRuntime(env = process.env, platform = process.platform) {
  const file = instanceRuntimePath(env, platform);
  if (!file) return null;
  try {
    const value = JSON.parse(await runtimeContents(file, platform));
    return validRuntime(value) ? value : null;
  } catch { return null; }
}

export async function writeQuitMarker(prepared, runtime) {
  const file = path.join(path.dirname(prepared.file), 'stopped.json');
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schema: 1, token: createHash('sha256').update(runtime.sourceToken).digest('hex') }) + '\n',
      { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function readQuitMarker(env = process.env, platform = process.platform) {
  const service = instanceRuntimePath(env, platform);
  if (!service) return null;
  try {
    const value = JSON.parse(await runtimeContents(path.join(path.dirname(service), 'stopped.json'), platform));
    // An engine of ASB 1.11.0 also writes its PID, and a newer window must see its quit too.
    return value && ['schema,token', 'pid,schema,token'].includes(Object.keys(value).sort().join(',')) && value.schema === 1
      && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token) ? { schema: 1, token: value.token } : null;
  } catch { return null; }
}

export function requestInstance(runtime, route, { method = 'GET', body, headers = {}, timeoutMs = 2000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('The running ASB instance did not reply in time.')), timeoutMs);
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    request = http.request({ host: '127.0.0.1', port: runtime.port, path: route, method, agent: false,
      headers: { ...headers, host: `127.0.0.1:${runtime.port}`, origin: `http://127.0.0.1:${runtime.port}`,
        'X-ASB-Source-Token': runtime.sourceToken,
        ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }) } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) done(new Error('The running ASB instance sent too much data.'));
        else chunks.push(chunk);
      });
      response.on('error', () => done(new Error('Cannot read the running ASB instance response.')));
      response.on('end', () => {
        try { done(null, { statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { done(new Error('The running ASB instance sent invalid JSON.')); }
      });
    });
    request.on('error', () => done(new Error('Cannot connect to the running ASB instance.')));
    request.end(bytes);
  });
}

// The engine of this runtime record answers as itself.
export async function serviceAnswers(runtime, request = requestInstance) {
  try {
    const reply = await request(runtime, '/api/service', { maxBytes: 4096 });
    return reply.statusCode === 200 && reply.body?.service === true && reply.body.pid === runtime.pid;
  } catch { return false; }
}

export async function findRunningService(env = process.env, platform = process.platform) {
  const runtime = await readServiceRuntime(env, platform);
  return runtime && await serviceAnswers(runtime) ? runtime : null;
}

export async function prepareInstanceRuntime(env = process.env, { platform = process.platform, answers = serviceAnswers,
  file = instanceRuntimePath(env, platform) } = {}) {
  const directory = path.dirname(file);
  // Without an absolute XDG_RUNTIME_DIR, Linux uses <state>/asb/run and creates its asb folder (plan L7).
  const fallback = platform !== 'win32' && !(typeof env.XDG_RUNTIME_DIR === 'string' && path.posix.isAbsolute(env.XDG_RUNTIME_DIR));
  const rootPath = platform === 'win32' || fallback ? path.dirname(directory) : env.XDG_RUNTIME_DIR;
  if (platform === 'win32') await mkdir(rootPath, { recursive: true });
  // A failed mkdir gives the folder message below.
  if (fallback) await mkdir(rootPath, { recursive: true, mode: 0o700 }).catch(() => {});
  const root = await lstat(rootPath).catch(() => null);
  if (!root?.isDirectory() || !owned(root, platform)) {
    throw new Error(platform === 'win32' ? 'ASB will not use a linked or missing LOCALAPPDATA\\asb folder.'
      : `ASB will not use a missing, linked, or foreign runtime folder: ${rootPath}`);
  }
  const previousDirectory = await lstat(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (previousDirectory && (!previousDirectory.isDirectory() || !owned(previousDirectory, platform))) {
    throw new Error('ASB will not use a linked or foreign runtime folder.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (previousDirectory && !privateMode(previousDirectory, 0o700, platform)) {
    const existing = await lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (existing) throw new Error('ASB kept an invalid service.json. Check its runtime folder permissions.');
  }
  if (platform !== 'win32') await chmod(directory, 0o700);
  let previous = null;
  try { previous = await runtimeContents(file, platform); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('ASB kept an invalid service.json. Remove it before starting ASB.');
  }
  if (previous) {
    let saved;
    try { saved = JSON.parse(previous); } catch {}
    if (!validRuntime(saved)) throw new Error('ASB kept an invalid service.json. Remove it before starting ASB.');
    let alive = true;
    try { process.kill(saved.pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    // Windows soon gives an old PID to a new process, and the fallback folder survives a restart,
    // so there a live PID counts only when that engine answers.
    if (alive && ((platform !== 'win32' && !fallback) || await answers(saved))) throw new Error('The ASB runtime file belongs to a running process.');
  }
  return { file, previous, platform };
}

export async function publishInstanceRuntime(prepared, runtime) {
  if (!prepared) return null;
  const { file, previous, platform } = prepared;
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(runtime) + '\n', { flag: 'wx', mode: 0o600 });
    if (previous === null) await link(temporary, file);
    else {
      if (!(await runtimeContents(file, platform)).equals(previous)) throw new Error('ASB kept a runtime file that changed during startup.');
      await rename(temporary, file);
    }
  } finally { await rm(temporary, { force: true }); }
  return { file, runtime, platform };
}

export async function removeInstanceRuntime(record) {
  if (!record) return;
  let current;
  try { current = JSON.parse(await runtimeContents(record.file, record.platform)); }
  catch { return; }
  if (validRuntime(current) && current.pid === record.runtime.pid && current.sourceToken === record.runtime.sourceToken) await rm(record.file);
}

// Limits a Windows folder to the current user (plan 14.3). With no user name in the environment, it only warns.
export async function protectWindowsFolder(folder, { env = process.env, execFile, log = console.error } = {}) {
  const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  if (!user) { log(`ASB cannot limit ${folder} to this user: USERNAME is not set.`); return false; }
  try {
    await execFile('icacls', [folder, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true });
    return true;
  } catch (error) {
    log(`ASB cannot limit ${folder} to this user: ${error.message}`);
    return false;
  }
}
