// `asb agent agy-hook <event>`: the Antigravity CLI (agy) hook client. It keeps one record per conversation with IDs, paths, times,
// and the state only (never prompt, answer, tool input, or error text), and it never contacts the engine.
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGY_LISTEN_ON, AGY_UUID, agyAbsolutePath as absolutePath, agyRecordsDir, agyTranscriptPath } from '../src/antigravity-data.mjs';

const MAX_STDIN = 256 * 1024;
const MAX_RECORD = 16 * 1024;
const QUESTION_TOOL = 'ask_question';

// A PreToolUse reply of `{}` denies the tool in agy; `ask` keeps agy's own flow.
export const neutralReply = (event) => event === 'PreToolUse' ? '{"decision":"ask"}' : '{}';

const digits = (value) => typeof value === 'string' && /^[0-9]{1,10}$/.test(value) ? value : '';

// The next state of an event, or null when the event changes nothing.
export function agyNextState(hook) {
  const event = hook.hookEventName;
  const tool = hook.toolCall && typeof hook.toolCall === 'object' ? hook.toolCall.name : '';
  if (event === 'SessionStart') return { state: 'idle' };
  if (event === 'PreInvocation') return { state: 'working' };
  if (event === 'PreToolUse' && tool === QUESTION_TOOL) return { state: 'question' };
  if (event === 'PostToolUse' && tool === QUESTION_TOOL) return { state: 'working' };
  if (event !== 'Stop') return null;
  if (typeof hook.error === 'string' && hook.error) return { state: 'failed' };
  if (hook.fullyIdle === true) return { state: 'done' };
  if (hook.fullyIdle === false) return { state: 'working', background: true };
  return null;
}

async function readProc(pid, name) {
  return fs.readFile(`/proc/${pid}/${name}`, 'utf8');
}

// The fields after the command name: [0] is field 3 (state), [1] field 4 (parent PID), [19] field 22 (start ticks).
const statFields = (text) => text.slice(text.lastIndexOf(') ') + 2).split(' ');

// The hook runs as agy -> sh -> this process.
export async function agyProcess(parentPid = process.ppid, read = readProc) {
  try {
    const agyPid = Number(statFields(await read(parentPid, 'stat'))[1]);
    if (!Number.isInteger(agyPid) || agyPid <= 1 || (await read(agyPid, 'comm')).trim() !== 'agy') return null;
    const ticks = statFields(await read(agyPid, 'stat'))[19];
    return /^[0-9]{1,20}$/.test(ticks || '') ? { agyPid, agyStartTicks: ticks } : null;
  } catch { return null; }
}

async function readStdin(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_STDIN) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function oldCreatedAt(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD) return 0;
    const value = Number(JSON.parse(await handle.readFile('utf8')).createdAtMs);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch { return 0; } finally { await handle?.close().catch(() => {}); }
}

export async function writeAgyRecord(hook, { env = process.env, homeDir = os.homedir(), nowMs = Date.now(), parentPid = process.ppid, read = readProc } = {}) {
  const next = agyNextState(hook);
  if (!next || typeof hook.conversationId !== 'string' || !AGY_UUID.test(hook.conversationId)) return null;
  const workspace = absolutePath(Array.isArray(hook.workspacePaths) ? hook.workspacePaths[0] : '') || absolutePath(hook.cwd);
  if (!workspace) return null;
  const dir = agyRecordsDir(env, homeDir);
  const file = path.join(dir, `${hook.conversationId.toLowerCase()}.json`);
  const agy = await agyProcess(parentPid, read);
  const listenOn = typeof env.KITTY_LISTEN_ON === 'string' && env.KITTY_LISTEN_ON.length <= 300 && AGY_LISTEN_ON.test(env.KITTY_LISTEN_ON) ? env.KITTY_LISTEN_ON : '';
  const transcript = agyTranscriptPath(hook.transcriptPath, homeDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const record = {
    conversationId: hook.conversationId.toLowerCase(), workspace, state: next.state, stateAtMs: nowMs,
    createdAtMs: await oldCreatedAt(file) || nowMs,
    ...(agy || {}),
    ...(digits(env.KITTY_WINDOW_ID) ? { kittyWindowId: env.KITTY_WINDOW_ID } : {}),
    ...(digits(env.KITTY_PID) ? { kittyPid: env.KITTY_PID } : {}),
    ...(listenOn ? { kittyListenOn: listenOn } : {}),
    ...(next.background ? { background: true } : {}),
    ...(transcript ? { transcriptMtimePath: transcript } : {}),
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return record;
}

// Always the neutral reply first and exit code 0: a fault after the reply cannot deny a tool.
export async function agyHook(args, { stdin = process.stdin, write = (text) => process.stdout.write(text), ...options } = {}) {
  const event = typeof args[0] === 'string' ? args[0] : '';
  try { write(`${neutralReply(event)}\n`); } catch {}
  try {
    const text = await readStdin(stdin);
    if (text === null) return 0;
    const hook = JSON.parse(text);
    if (!hook || typeof hook !== 'object' || Array.isArray(hook) || hook.hookEventName !== event) return 0;
    await (options.writeRecord || writeAgyRecord)(hook, options);
  } catch {}
  return 0;
}
