import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const instanceRuntimePath = (env = process.env) => typeof env.XDG_RUNTIME_DIR === 'string' && path.isAbsolute(env.XDG_RUNTIME_DIR)
  ? path.join(env.XDG_RUNTIME_DIR, 'asb', 'service.json') : null;
const owned = (info) => !process.getuid || info.uid === process.getuid();
const validRuntime = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === 'pid,port,schema,sourceToken' && value.schema === 1
  && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
  && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
  && typeof value.sourceToken === 'string' && /^[a-f0-9]{64}$/.test(value.sourceToken);

async function runtimeContents(file) {
  const directory = await lstat(path.dirname(file));
  if (!directory.isDirectory() || !owned(directory) || (directory.mode & 0o777) !== 0o700) throw new Error('Unsafe ASB runtime folder.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !owned(info) || (info.mode & 0o777) !== 0o600 || info.size > 4096) throw new Error('Unsafe ASB runtime file.');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('ASB runtime file is too large.');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function readServiceRuntime(env = process.env) {
  const file = instanceRuntimePath(env);
  if (!file) return null;
  try {
    const value = JSON.parse(await runtimeContents(file));
    return validRuntime(value) ? value : null;
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

export async function findRunningService(env = process.env) {
  const runtime = await readServiceRuntime(env);
  if (!runtime) return null;
  try {
    const reply = await requestInstance(runtime, '/api/service', { maxBytes: 4096 });
    return reply.statusCode === 200 && reply.body?.service === true && reply.body.pid === runtime.pid ? runtime : null;
  } catch { return null; }
}

export async function prepareInstanceRuntime(env = process.env) {
  const file = instanceRuntimePath(env);
  const root = file && await lstat(env.XDG_RUNTIME_DIR).catch(() => null);
  if (!root?.isDirectory() || !owned(root)) throw new Error('ASB service run needs an absolute, existing XDG_RUNTIME_DIR folder owned by the user.');
  const directory = path.dirname(file);
  const previousDirectory = await lstat(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (previousDirectory && (!previousDirectory.isDirectory() || !owned(previousDirectory))) {
    throw new Error('ASB will not use a linked or foreign runtime folder.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (previousDirectory && (previousDirectory.mode & 0o777) !== 0o700) {
    const existing = await lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (existing) throw new Error('ASB kept an invalid service.json. Check its runtime folder permissions.');
  }
  await chmod(directory, 0o700);
  let previous = null;
  try { previous = await runtimeContents(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('ASB kept an invalid service.json. Remove it before starting ASB.');
  }
  if (previous) {
    let saved;
    try { saved = JSON.parse(previous); } catch {}
    if (!validRuntime(saved)) throw new Error('ASB kept an invalid service.json. Remove it before starting ASB.');
    try { process.kill(saved.pid, 0); throw new Error('The ASB runtime file belongs to a running process.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return { file, previous };
}

export async function publishInstanceRuntime(prepared, runtime) {
  if (!prepared) return null;
  const { file, previous } = prepared;
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(runtime) + '\n', { flag: 'wx', mode: 0o600 });
    if (previous === null) await link(temporary, file);
    else {
      if (!(await runtimeContents(file)).equals(previous)) throw new Error('ASB kept a runtime file that changed during startup.');
      await rename(temporary, file);
    }
  } finally { await rm(temporary, { force: true }); }
  return { file, runtime };
}

export async function removeInstanceRuntime(record) {
  if (!record) return;
  let current;
  try { current = JSON.parse(await runtimeContents(record.file)); }
  catch { return; }
  if (validRuntime(current) && current.pid === record.runtime.pid && current.sourceToken === record.runtime.sourceToken) await rm(record.file);
}
