// `asb agent agy-hook <event>`: the Antigravity CLI (agy) hook client. It keeps one record per conversation with session metadata
// and state, never prompt, answer, tool input, or error text. Stop can read its local mailbox; it never contacts the engine.
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGY_LISTEN_ON, AGY_UUID, agyAbsolutePath as absolutePath, agyParentId, agyProcess, agyRecordsDir, agyTranscriptPath,
  validAgyAgentName } from '../src/antigravity-data.mjs';

import { takeAgyMailbox } from '../src/agy-mailbox.mjs';
export { agyProcess };

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

const HARD_EXIT_MS = 3000;

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

async function oldRecord(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD) return null;
    const { createdAtMs, parentConversationId } = JSON.parse(await handle.readFile('utf8'));
    const value = Number(createdAtMs);
    return { createdAtMs: Number.isFinite(value) && value > 0 ? value : 0, parentConversationId };
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

export async function writeAgyRecord(hook, { env = process.env, homeDir = os.homedir(), nowMs = Date.now(), parentPid = process.ppid, read } = {}) {
  const next = agyNextState(hook);
  if (!next || typeof hook.conversationId !== 'string' || !AGY_UUID.test(hook.conversationId)) return null;
  const workspace = absolutePath(Array.isArray(hook.workspacePaths) ? hook.workspacePaths[0] : '') || absolutePath(hook.cwd);
  if (!workspace) return null;
  const dir = agyRecordsDir(env, homeDir);
  const id = hook.conversationId.toLowerCase();
  const file = path.join(dir, `${id}.json`);
  const agy = await agyProcess(parentPid, read);
  const listenOn = typeof env.KITTY_LISTEN_ON === 'string' && env.KITTY_LISTEN_ON.length <= 300 && AGY_LISTEN_ON.test(env.KITTY_LISTEN_ON) ? env.KITTY_LISTEN_ON : '';
  const transcript = agyTranscriptPath(hook.transcriptPath, homeDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = await oldRecord(file);
  const parentConversationId = agyParentId(hook.parentConversationId === undefined ? previous?.parentConversationId : hook.parentConversationId, id);
  const agentName = typeof hook.agentName === 'string' ? hook.agentName.trim() : '';
  const record = {
    conversationId: id, workspace, state: next.state, stateAtMs: nowMs, event: hook.hookEventName,
    createdAtMs: previous?.createdAtMs || nowMs,
    ...(parentConversationId ? { parentConversationId } : {}),
    ...(parentConversationId && validAgyAgentName(agentName) ? { agentName } : {}),
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

// The other hooks reply before reading stdin. Stop waits to see if it can continue the session.
export async function agyHook(args, { stdin = process.stdin, write = (text) => process.stdout.write(text), exit = process.exit, ...options } = {}) {
  const event = typeof args[0] === 'string' ? args[0] : '';
  let replied = false;
  const reply = (text = neutralReply(event)) => {
    if (replied) return;
    replied = true;
    try { write(`${text}\n`); } catch {}
  };
  if (event !== 'Stop') reply();
  const timer = setTimeout(() => { reply(); exit(0); }, HARD_EXIT_MS);
  timer.unref();
  try {
    const text = await readStdin(stdin);
    if (text === null) return 0;
    const hook = JSON.parse(text);
    if (!hook || typeof hook !== 'object' || Array.isArray(hook) || hook.hookEventName !== event) return 0;
    await (options.writeRecord || writeAgyRecord)(hook, options);
    if (event === 'Stop') {
      const continuation = await takeAgyMailbox(hook, options.env);
      if (continuation !== null) reply(JSON.stringify({ decision: 'continue', reason: continuation }));
    }
  } catch {} finally { clearTimeout(timer); reply(); }
  return 0;
}
