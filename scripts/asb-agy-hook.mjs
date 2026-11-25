// `asb agent agy-hook <event>`: the Antigravity CLI (agy) hook client. It keeps one record per conversation with session metadata
// and state, never prompt, answer, tool input, or error text. Stop can read its local mailbox. Only PreToolUse of ask_question,
// run_command, edit_file, or write_file contacts the local engine (POST /api/agent/wait) so a paired phone can answer or approve.
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGY_LISTEN_ON, AGY_UUID, agyAbsolutePath as absolutePath, agyParentId, agyProcess, agyRecordsDir, agyTranscriptPath, agyWindowsProcess,
  readAgyTitle, validAgyAgentName, validAgyTitle } from '../src/antigravity-data.mjs';

import { takeAgyMailbox } from '../src/agy-mailbox.mjs';
import { readServiceRuntime, requestInstance } from './asb-instance.mjs';
export { agyProcess };

const MAX_STDIN = 256 * 1024;
const MAX_TITLE_STDIN = 64 * 1024;
const MAX_RECORD = 16 * 1024;
const QUESTION_TOOL = 'ask_question';
const APPROVAL_TOOLS = new Set(['run_command', 'edit_file', 'write_file']);

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

async function readStdin(stdin, limit = MAX_STDIN) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function oldRecord(file, platform) {
  let handle;
  try {
    const windows = platform === 'win32';
    if (windows) {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > MAX_RECORD) return null;
    }
    handle = await fs.open(file, windows ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD) return null;
    const { createdAtMs, parentConversationId, state, agyPid, agyStartTicks } = JSON.parse(await handle.readFile('utf8'));
    const value = Number(createdAtMs);
    return { createdAtMs: Number.isFinite(value) && value > 0 ? value : 0, parentConversationId, state, agyPid, agyStartTicks };
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

// agy hooks carry no parent ID. A subagent runs in the agy process of its parent and starts while that parent works,
// so a new conversation's parent is the one working root conversation of the same agy process.
async function agyProcessParent(dir, id, agy, platform) {
  let names;
  try { names = await fs.readdir(dir); } catch { return ''; }
  const found = [];
  for (const name of names) {
    const other = name.slice(0, -5);
    if (!name.endsWith('.json') || !AGY_UUID.test(other) || other === id) continue;
    const record = await oldRecord(path.join(dir, name), platform);
    if (record?.state === 'working' && !record.parentConversationId && record.agyPid === agy.agyPid
      && record.agyStartTicks === agy.agyStartTicks) found.push(other);
  }
  return found.length === 1 ? found[0] : '';
}

export async function writeAgyRecord(hook, { env = process.env, homeDir = os.homedir(), nowMs = Date.now(), parentPid = process.ppid, read,
  platform = process.platform, run, dir = agyRecordsDir(env, homeDir, platform) } = {}) {
  const next = agyNextState(hook);
  if (!next || typeof hook.conversationId !== 'string' || !AGY_UUID.test(hook.conversationId)) return null;
  const workspace = absolutePath(Array.isArray(hook.workspacePaths) ? hook.workspacePaths[0] : '') || absolutePath(hook.cwd);
  if (!workspace) return null;
  const id = hook.conversationId.toLowerCase();
  const file = path.join(dir, `${id}.json`);
  let agy = platform === 'win32' ? null : await agyProcess(parentPid, read);
  const listenOn = typeof env.KITTY_LISTEN_ON === 'string' && env.KITTY_LISTEN_ON.length <= 300 && AGY_LISTEN_ON.test(env.KITTY_LISTEN_ON) ? env.KITTY_LISTEN_ON : '';
  const transcript = agyTranscriptPath(hook.transcriptPath, homeDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = await oldRecord(file, platform);
  if (platform === 'win32') agy = hook.hookEventName === 'SessionStart' || !previous?.agyPid
    ? await agyWindowsProcess(parentPid, run) : { agyPid: previous.agyPid, agyStartTicks: previous.agyStartTicks };
  const parentConversationId = agyParentId(hook.parentConversationId === undefined ? previous?.parentConversationId : hook.parentConversationId, id)
    || (!previous && agy ? agyParentId(await agyProcessParent(dir, id, agy, platform), id) : '');
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

function agyQuestionPayload(hook) {
  if (typeof hook.conversationId !== 'string' || !AGY_UUID.test(hook.conversationId)) return null;
  const raw = hook.toolCall?.args?.questions;
  if (!Array.isArray(raw) || !raw.length) return null;
  const questions = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.question !== 'string'
      || !Array.isArray(item.options) || !item.options.every((option) => typeof option === 'string')) return null;
    questions.push({ question: item.question, options: item.options.map((label) => ({ label })), multiSelect: item.is_multi_select === true });
  }
  return { provider: 'antigravity', sessionKey: hook.conversationId.toLowerCase(), question: { questions } };
}

async function agyApprovalPayload(hook) {
  if (typeof hook.conversationId !== 'string' || !AGY_UUID.test(hook.conversationId)) return null;
  const tool = hook.toolCall?.name;
  const args = hook.toolCall?.args;
  if (!APPROVAL_TOOLS.has(tool) || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  const { whole } = await import('./asb-agent.mjs');
  let approval = null;
  if (tool === 'run_command') {
    if (!whole(args.CommandLine) || !args.CommandLine) return null;
    approval = { kind: 'tool', title: 'Allow a shell command?', display: [{ label: 'Command', text: args.CommandLine, mono: true }], note: false };
  } else if (tool === 'write_file') {
    if (!whole(args.Path) || !args.Path) return null;
    const size = typeof args.Content === 'string' ? args.Content.length : 0;
    approval = { kind: 'tool', title: 'Allow a new file?', display: [{ label: 'File', text: args.Path, mono: true }, { label: 'Size', text: `${size} characters`, mono: false }], note: false };
  } else if (tool === 'edit_file') {
    if (!whole(args.Path) || !args.Path) return null;
    approval = { kind: 'tool', title: 'Allow a file edit?', display: [{ label: 'File', text: args.Path, mono: true }], note: false };
  }
  return approval ? { provider: 'antigravity', sessionKey: hook.conversationId.toLowerCase(), approval } : null;
}

async function postAgyQuestion(body, { env = process.env } = {}) {
  const runtime = await readServiceRuntime(env);
  if (!runtime) return;
  await requestInstance(runtime, '/api/agent/wait', { method: 'POST', maxBytes: 4096, timeoutMs: 1500, body });
}

// The other hooks reply before reading stdin. Stop waits to see if it can continue the session.
export async function agyHook(args, { stdin = process.stdin, write = (text) => process.stdout.write(text), exit = process.exit,
  platform = process.platform, ...options } = {}) {
  const event = typeof args[0] === 'string' ? args[0] : '';
  let replied = false;
  const reply = (text = neutralReply(event)) => {
    if (replied) return;
    replied = true;
    try { write(`${text}\n`); } catch {}
  };
  if (event !== 'Stop' || platform === 'win32') reply();
  const timer = setTimeout(() => { reply(); exit(0); }, HARD_EXIT_MS);
  timer.unref();
  try {
    const text = await readStdin(stdin);
    if (text === null) return 0;
    const hook = JSON.parse(text);
    if (!hook || typeof hook !== 'object' || Array.isArray(hook) || hook.hookEventName !== event) return 0;
    await (options.writeRecord || writeAgyRecord)(hook, { ...options, platform });
    if (platform === 'win32') return 0;
    const post = options.postWait || options.postQuestion || postAgyQuestion;
    if (event === 'PreToolUse' && hook.toolCall?.name === QUESTION_TOOL) {
      const payload = agyQuestionPayload(hook);
      if (payload) await post(payload, options).catch(() => {});
    } else if (event === 'PreToolUse' && APPROVAL_TOOLS.has(hook.toolCall?.name)) {
      const payload = await agyApprovalPayload(hook);
      if (payload) await post(payload, options).catch(() => {});
    }
    if (event === 'Stop') {
      const continuation = await takeAgyMailbox(hook, options.env);
      if (continuation !== null) reply(JSON.stringify({ decision: 'continue', reason: continuation }));
    }
  } catch {} finally { clearTimeout(timer); reply(); }
  return 0;
}

// `asb agent agy-title`: agy window title command. Reads only conversation_id, conversation_title, workspace, and cwd;
// saves a valid title to `<id>.title` when changed, and prints the window title with no newline.
export async function agyTitle({ stdin = process.stdin, write = (t) => process.stdout.write(t), exit = process.exit, env = process.env,
  homeDir = os.homedir(), platform = process.platform } = {}) {
  let wrote = false;
  const output = (text = 'agy') => {
    if (wrote) return;
    wrote = true;
    try { write(text); } catch {}
  };
  const timer = setTimeout(() => { output('agy'); exit(0); }, HARD_EXIT_MS);
  timer.unref();
  let label = 'agy';
  try {
    const text = await readStdin(stdin, MAX_TITLE_STDIN);
    if (text === null) return 0;
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
    const { conversation_id: id, conversation_title: rawTitle, workspace, cwd } = data;
    const validId = typeof id === 'string' && AGY_UUID.test(id);
    const title = validId ? validAgyTitle(rawTitle) : '';
    const folder = absolutePath(workspace) || absolutePath(cwd);
    const base = folder ? path.basename(folder) : '';
    label = title || (base ? `agy · ${base}` : 'agy');
    if (title) {
      const dir = agyRecordsDir(env, homeDir, platform);
      const file = path.join(dir, `${id.toLowerCase()}.title`);
      if (await readAgyTitle(file, platform) !== title) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, title, { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
    }
  } catch {} finally { clearTimeout(timer); output(label); }
  return 0;
}
