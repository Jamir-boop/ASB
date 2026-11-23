import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AGY_UUID } from './antigravity-data.mjs';

const MAX_BYTES = 16 * 1024;
export const AGY_MAILBOX_TTL_MS = 60 * 60_000;

export function safeAgyText(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= 4000 && text.split('\n').length <= 40
    && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text);
}

export const agyMailboxDir = (env = process.env) => path.isAbsolute(env.XDG_RUNTIME_DIR || '')
  ? path.join(env.XDG_RUNTIME_DIR, 'asb-agy-mailbox') : null;

export async function privateAgyMailbox(dir) {
  const entry = dir && await fs.lstat(dir).catch(() => null);
  return Boolean(entry && entry.isDirectory() && entry.uid === process.getuid?.() && (entry.mode & 0o7777) === 0o700);
}

export async function readAgyMailboxFile(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const entry = await handle.stat();
    if (!entry.isFile() || entry.uid !== process.getuid?.() || entry.size > MAX_BYTES || (entry.mode & 0o7777) !== 0o600) return null;
    const data = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(data);
    return bytesRead === entry.size ? { text: data.toString('utf8', 0, bytesRead), at: entry.mtimeMs } : null;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

// The rename is the claim. If the host withdrew first, the hook cannot read or continue the message.
export async function takeAgyMailbox(hook, env = process.env) {
  const id = hook.conversationId;
  if (typeof id !== 'string' || !AGY_UUID.test(id)) return null;
  const dir = agyMailboxDir(env);
  if (!dir || !await privateAgyMailbox(dir)) return null;
  const base = path.join(dir, id.toLowerCase());
  const guard = `${base}.continued`;
  try { await fs.unlink(guard); return null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (hook.continuationActive === true) return null;
  const claim = `${base}.msg.${process.pid}`;
  try { await fs.rename(`${base}.msg`, claim); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try {
    const file = await readAgyMailboxFile(claim);
    if (!file || Date.now() - file.at >= AGY_MAILBOX_TTL_MS) return null;
    value = JSON.parse(file.text);
    if (typeof value?.id !== 'string' || !AGY_UUID.test(value.id) || !safeAgyText(value.text)) return null;
  } finally { await fs.unlink(claim); }
  await fs.writeFile(guard, '', { flag: 'wx', mode: 0o600 });
  const temporary = `${base}.msg.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value.id, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, `${base}.taken`);
  } catch (error) {
    await fs.unlink(guard).catch(() => {});
    throw error;
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return value.text;
}
