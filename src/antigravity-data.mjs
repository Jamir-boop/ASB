// Antigravity CLI (agy) sessions from the ASB agy hook records: session metadata and states, not conversation text.
// A live row in a kitty with remote control can focus its kitty window. The Bridge also uses these records to bind.
// ASB never reads agy's own stores, its login, or its transcript text (the transcript is only stat'ed).
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processStart } from './claude-registry.mjs';
import { findExecutable, stateDir } from './platform-paths.mjs';

export const AGY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGY_LISTEN_ON = /^unix:(?:\/|@)[^\x00-\x1f\x7f]+$/;
const PATH_TEXT = /^[^\x00-\x1f\x7f]{1,4096}$/;
const STATES = ['idle', 'working', 'question', 'done', 'failed'];
const EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
const FIELDS = new Set(['conversationId', 'workspace', 'state', 'stateAtMs', 'createdAtMs', 'agyPid', 'agyStartTicks', 'kittyWindowId', 'kittyPid',
  'kittyListenOn', 'background', 'transcriptMtimePath', 'event', 'parentConversationId', 'agentName']);
const MAX_FILES = 500;
const MAX_RECORD = 16 * 1024;
const MAX_TITLE = 1024;
const BAD_TITLE_CHAR = /[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/u;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NO_NEWS_MS = 10 * 60_000;
// agy fires no event when it ends, so a live row is checked again at the next 30 s mark.
const LIVE_CHECK_MS = 30_000;
const KITTY_LEVELS = 8;
export const AGY_FOCUS_ERROR = 'ASB could not focus this agy session in kitty.';
export const AGY_QUIET_REASON = 'No news from the agy session for 10 minutes.';

export const agyAbsolutePath = (value) => typeof value === 'string' && PATH_TEXT.test(value) && path.isAbsolute(value) ? path.resolve(value) : '';
export const agyRecordsDir = (env = process.env, homeDir = os.homedir()) => path.join(stateDir(env, 'linux', homeDir), 'agy');

export function validAgyTitle(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 200 && !BAD_TITLE_CHAR.test(trimmed) ? trimmed : '';
}

export async function readAgyTitle(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600 || info.size > MAX_TITLE) return '';
    return validAgyTitle(await handle.readFile('utf8'));
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}
// The transcript is kept only as a path to stat, and only under agy's own folder.
export const agyTranscriptPath = (value, homeDir = os.homedir()) => {
  const file = agyAbsolutePath(value);
  return file && file.startsWith(path.join(homeDir, '.gemini', 'antigravity-cli') + path.sep) ? file : '';
};

const digits = (value, max) => typeof value === 'string' && new RegExp(`^[0-9]{1,${max}}$`).test(value);
const time = (value) => Number.isFinite(value) && value > 0;

export function agyParentId(value, id) {
  if (typeof value !== 'string' || !AGY_UUID.test(value) || typeof id !== 'string') return undefined;
  const parent = value.toLowerCase();
  return parent === id.toLowerCase() ? undefined : parent;
}

export const validAgyAgentName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 80
  && value === value.trim() && !/[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/u.test(value);

export function validAgyRecord(record, id, homeDir = os.homedir()) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some((key) => !FIELDS.has(key))) return false;
  const { conversationId, workspace, state, stateAtMs, createdAtMs, agyPid, agyStartTicks, kittyWindowId, kittyPid, kittyListenOn,
    background, transcriptMtimePath, event, parentConversationId, agentName } = record;
  return conversationId === id && agyAbsolutePath(workspace) === workspace && STATES.includes(state) && time(stateAtMs) && time(createdAtMs)
    && (parentConversationId === undefined || agyParentId(parentConversationId, id) === parentConversationId)
    && (agentName === undefined || (parentConversationId !== undefined && validAgyAgentName(agentName)))
    && (agyPid === undefined) === (agyStartTicks === undefined)
    && (agyPid === undefined || (Number.isInteger(agyPid) && agyPid > 1 && digits(agyStartTicks, 20)))
    && (kittyWindowId === undefined || digits(kittyWindowId, 10)) && (kittyPid === undefined || digits(kittyPid, 10))
    && (kittyListenOn === undefined || (typeof kittyListenOn === 'string' && kittyListenOn.length <= 300 && AGY_LISTEN_ON.test(kittyListenOn)))
    && (background === undefined || background === true) && (event === undefined || EVENTS.includes(event))
    && (transcriptMtimePath === undefined || agyTranscriptPath(transcriptMtimePath, homeDir) === transcriptMtimePath);
}

export { processStart as agyProcessStart };

async function readProc(pid, name) {
  return fs.readFile(`/proc/${pid}/${name}`, 'utf8');
}

// The fields after the command name: [0] is field 3 (state), [1] field 4 (parent PID), [19] field 22 (start ticks).
const statFields = (text) => text.slice(text.lastIndexOf(') ') + 2).split(' ');

// The installed line runs the client as agy -> sh -> sh -> timeout -> sh (scripts/asb) -> node (shorter under bash):
// the first ancestor above the parent with comm agy, at most 8 levels up.
const AGY_LEVELS = 8;
export async function agyProcess(parentPid = process.ppid, read = readProc) {
  try {
    let pid = parentPid;
    for (let level = 0; level < AGY_LEVELS; level++) {
      pid = Number(statFields(await read(pid, 'stat'))[1]);
      if (!Number.isInteger(pid) || pid <= 1) return null;
      if ((await read(pid, 'comm')).trim() !== 'agy') continue;
      const ticks = statFields(await read(pid, 'stat'))[19];
      return /^[0-9]{1,20}$/.test(ticks || '') ? { agyPid: pid, agyStartTicks: ticks } : null;
    }
    return null;
  } catch { return null; }
}

// A process of this user that is not a zombie: its comm and parent PID, from `<procDir>/<pid>/stat`.
async function procInfo(pid, procDir) {
  try {
    if ((await fs.stat(path.join(procDir, String(pid)))).uid !== process.getuid()) return null;
    const text = await fs.readFile(path.join(procDir, String(pid), 'stat'), 'utf8');
    const close = text.lastIndexOf(')');
    const [state, ppid] = text.slice(close + 2).split(' ');
    return state === 'Z' ? null : { comm: text.slice(text.indexOf('(') + 1, close), ppid: Number(ppid) };
  } catch { return null; }
}

// Rule 2 of plan P3 for a live record: a kitty window ID, a live kitty of this user that is an ancestor of the agy PID (the record has no kitty
// start ticks, so the ancestry is the reused-PID check), and a listen-on socket that this user owns or an abstract name with the kitty PID.
export async function agyFocusTarget(record, { procDir = '/proc' } = {}) {
  const { agyPid, kittyWindowId, kittyPid, kittyListenOn } = record;
  if (!Number.isInteger(agyPid) || !digits(kittyWindowId, 10) || !digits(kittyPid, 10) || typeof kittyListenOn !== 'string'
    || kittyListenOn.length > 300 || !AGY_LISTEN_ON.test(kittyListenOn)) return null;
  const kitty = Number(kittyPid);
  if ((await procInfo(kitty, procDir))?.comm !== 'kitty') return null;
  let pid = agyPid;
  for (let level = 0; level < KITTY_LEVELS && pid !== kitty; level++) pid = (await procInfo(pid, procDir))?.ppid || 0;
  if (pid !== kitty) return null;
  const name = kittyListenOn.slice('unix:'.length);
  if (name.startsWith('@')) return new RegExp(`kitty-${kitty}(?![0-9])`).test(name) ? { listenOn: kittyListenOn, windowId: kittyWindowId } : null;
  const info = await fs.lstat(name).catch(() => null);
  return info?.isSocket() && info.uid === process.getuid() ? { listenOn: kittyListenOn, windowId: kittyWindowId } : null;
}

// The open of a focusable row: the record is read and rule 2 checked again now; any failure is the one open error.
export async function focusAgyInKitty({ dataDir, id, procDir = '/proc', startOf = processStart, homeDir = os.homedir() }) {
  const fail = () => { throw new Error(AGY_FOCUS_ERROR); };
  if (typeof id !== 'string' || !AGY_UUID.test(id) || !dataDir) fail();
  const record = await readRecord(path.join(dataDir, `${id}.json`));
  if (!validAgyRecord(record, id, homeDir) || record.agyPid === undefined || await startOf(record.agyPid) !== record.agyStartTicks) fail();
  const target = await agyFocusTarget(record, { procDir });
  if (!target) fail();
  await new Promise((resolve, reject) => execFile('kitty', ['@', '--to', target.listenOn, 'focus-window', '--match', `id:${target.windowId}`],
    { timeout: 3000 }, (error) => (error ? reject(error) : resolve()))).catch(fail);
  return { opened: true, method: 'antigravity-kitty-focus' };
}

const defaultKitty = (args) => new Promise((resolve, reject) => execFile('kitty', args, { timeout: 3000, maxBuffer: 512 * 1024 },
  (error, stdout) => (error ? reject(error) : resolve(stdout))));
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compact = (value) => String(value).replace(/\s+/g, '');
const cleanFormLine = (line) => line.replace(/^\s*(?:[>›❯]\s*)?/, '').trim();
const MAX_AGY_OTHER_CHARS = 500;

// Verifies the agy question form on the kitty screen and types the phone answer.
// Returns true only when all steps were verified, null when the form is gone, or false on any mismatch or error.
export async function answerAgyInKitty({ dataDir, id, questions, items, procDir = '/proc', startOf = processStart,
  homeDir = os.homedir(), exec = defaultKitty, wait = defaultWait }) {
  if (typeof id !== 'string' || !AGY_UUID.test(id) || !dataDir || !Array.isArray(questions) || !questions.length
    || !Array.isArray(items) || items.length !== questions.length) return false;
  for (const item of items) {
    if (item?.other !== undefined && (typeof item.other !== 'string' || item.other.length < 1
      || item.other.length > MAX_AGY_OTHER_CHARS || /[\x00-\x1f\x7f]/.test(item.other))) return false;
  }
  const record = await readRecord(path.join(dataDir, `${id}.json`));
  if (!validAgyRecord(record, id, homeDir)) return false;
  if (record.state !== 'question') return null;
  if (record.agyPid === undefined || await startOf(record.agyPid) !== record.agyStartTicks) return false;
  const target = await agyFocusTarget(record, { procDir });
  if (!target) return false;

  const cmd = (action, args = []) => exec(['@', '--to', target.listenOn, action, '--match', `id:${target.windowId}`, ...args]);
  const getScreen = () => cmd('get-text', ['--extent', 'screen']);
  const writeIn = async (text, digit) => {
    await cmd('send-text', ['--', String(digit)]);
    await wait(150);
    if (!(await getScreen()).includes('Your answer:')) return false;
    await cmd('send-text', ['--bracketed-paste=enable', '--', text]);
    await wait(150);
    if (!compact(await getScreen()).includes(compact(text))) return false;
    await cmd('send-key', ['enter']);
    return true;
  };

  try {
    let screen = await getScreen();
    const total = questions.length;
    for (let i = 0; i < total; i += 1) {
      const k = i + 1;
      const q = questions[i];
      const item = items[i];
      const header = `Question ${k}/${total}:`;
      const pos = screen.lastIndexOf(header);
      if (pos < 0) return k === 1 ? null : false;
      const form = screen.slice(pos);
      const qStart = compact(q.question).slice(0, 60);
      if (!qStart || !compact(form).startsWith(compact(header) + qStart)) return false;
      const lines = form.split('\n').map(cleanFormLine);
      let cursor = 0;
      const findNext = (match) => {
        for (let idx = cursor; idx < lines.length; idx += 1) {
          if (match(lines[idx])) { cursor = idx + 1; return true; }
        }
        return false;
      };
      for (let opt = 0; opt < q.options.length; opt += 1) {
        const d = opt + 1;
        const label = q.options[opt].label;
        const ok = q.multiSelect
          ? findNext((line) => line === `${d}. [ ] ${label}` || line === `${d}. [x] ${label}`)
          : findNext((line) => line === `${d}. ${label}`);
        if (!ok) return false;
      }
      const writeInDigit = q.options.length + 1;
      if (!findNext((line) => line === `${writeInDigit}. Write-in...`)) return false;

      if (!q.multiSelect) {
        if (item.other !== undefined) {
          if (!await writeIn(item.other, writeInDigit)) return false;
        } else {
          const idx = q.options.findIndex((option) => option.label === item.selected?.[0]);
          if (idx < 0) return false;
          await cmd('send-text', ['--', String(idx + 1)]);
        }
      } else {
        for (const label of item.selected || []) {
          const idx = q.options.findIndex((option) => option.label === label);
          if (idx < 0) return false;
          const d = idx + 1;
          await cmd('send-text', ['--', String(d)]);
          await wait(150);
          const after = await getScreen();
          const afterPos = after.lastIndexOf(header);
          if (afterPos < 0) return false;
          const checked = after.slice(afterPos).split('\n').map(cleanFormLine).some((line) => line === `${d}. [x] ${label}`);
          if (!checked) return false;
        }
        if (item.other !== undefined) {
          if (!await writeIn(item.other, writeInDigit)) return false;
        } else {
          await cmd('send-key', ['enter']);
        }
      }

      if (k < total) {
        await wait(150);
        screen = await getScreen();
        if (screen.lastIndexOf(`Question ${k + 1}/${total}:`) < 0) return false;
      }
    }
    return true;
  } catch { return false; }
}

const AGY_DIALOG_HEADERS = ['Requesting permission for:', 'Allow creation of this file?', 'Accept this file edit?'];

function hasAnyAgyDialog(screen) {
  const tail = String(screen || '').split('\n').slice(-25).map((line) => line.trim());
  return tail.some((line) => AGY_DIALOG_HEADERS.includes(line));
}

function fileLineMatches(line, filePath) {
  const pathPart = line.replace(/\s+\+\d+(?:\s+-\d+)?\s*$/, '').trim();
  if (!pathPart) return false;
  if (pathPart === filePath) return true;
  const base = path.basename(filePath);
  if (!base) return false;
  if (pathPart.includes('...')) return pathPart === base || pathPart.endsWith(`/${base}`);
  return pathPart === base;
}

// Pure matcher for the three agy 1.5.15 permission dialogs (command, new file, file edit).
// Returns the deny option digit (for example '4' or '2') when the last screen lines match in order, else null.
export function matchAgyApprovalScreen(screen, approval) {
  if (typeof screen !== 'string' || !approval || typeof approval !== 'object' || !Array.isArray(approval.display)) return null;
  const lines = screen.split('\n');
  const title = approval.title;
  const yesPattern = /^\s*[>›❯]\s*1\.\s*Yes\b/;
  let promptIdx = -1;
  let denyPattern = null;

  if (title === 'Allow a shell command?') {
    const command = approval.display.find((item) => item.label === 'Command')?.text;
    const cmdCompact = compact(command || '');
    if (!cmdCompact) return null;
    let headerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() === 'Requesting permission for:') { headerIdx = i; break; }
    }
    if (headerIdx < 0) return null;
    let endIdx = -1;
    for (let i = headerIdx + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === 'Run this command?' || yesPattern.test(lines[i])) { endIdx = i; break; }
    }
    if (endIdx <= headerIdx + 1) return null;
    const screenCmd = compact(lines.slice(headerIdx + 1, endIdx).join(''));
    const tail40 = cmdCompact.slice(-40);
    if (!screenCmd || (!screenCmd.includes(tail40) && !cmdCompact.includes(screenCmd))) return null;
    promptIdx = endIdx;
    denyPattern = /^\s*(?:[>›❯]\s*)?([2-9])\.\s*No,\s*cancel$/;
  } else if (title === 'Allow a new file?' || title === 'Allow a file edit?') {
    const filePath = approval.display.find((item) => item.label === 'File')?.text;
    if (!filePath) return null;
    const questionLine = title === 'Allow a new file?' ? 'Allow creation of this file?' : 'Accept this file edit?';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() === questionLine) { promptIdx = i; break; }
    }
    if (promptIdx < 0) return null;
    const before = lines.slice(Math.max(0, promptIdx - 30), promptIdx);
    if (!before.some((line) => fileLineMatches(line, filePath))) return null;
    denyPattern = title === 'Allow a new file?'
      ? /^\s*(?:[>›❯]\s*)?([2-9])\.\s*No,\s*deny creation$/
      : /^\s*(?:[>›❯]\s*)?([2-9])\.\s*No,\s*reject this change$/;
  } else {
    return null;
  }

  let yesIdx = -1;
  for (let i = promptIdx; i < Math.min(lines.length, promptIdx + 6); i += 1) {
    if (yesPattern.test(lines[i])) { yesIdx = i; break; }
  }
  if (yesIdx < 0) return null;
  let denyIdx = -1;
  let denyDigit = null;
  for (let i = yesIdx + 1; i < Math.min(lines.length, yesIdx + 10); i += 1) {
    const match = denyPattern.exec(lines[i].trimEnd());
    if (match) { denyIdx = i; denyDigit = match[1]; break; }
  }
  if (!denyDigit) return null;
  const trailing = lines.slice(denyIdx + 1).filter((line) => line.trim().length > 0);
  return trailing.length <= 5 ? denyDigit : null;
}

// Polls the agy kitty screen every intervalMs (default 1000 ms) while an agy approval record is open.
// Calls onMatch once when the dialog appears, and onGone if no match within timeoutMs (10 s) or once the dialog leaves.
export function watchAgyApproval({ dataDir, id, approval, onMatch, onGone, isOpen = () => true,
  intervalMs = 1000, timeoutMs = 10_000, procDir = '/proc', startOf = processStart, homeDir = os.homedir(),
  exec = defaultKitty, now = Date.now }) {
  let seen = false;
  let busy = false;
  let stopped = false;
  const startedAt = now();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const check = async () => {
    if (stopped || busy) return;
    if (!isOpen()) { stop(); return; }
    busy = true;
    let matched = false;
    try {
      if (typeof id === 'string' && AGY_UUID.test(id) && dataDir) {
        const record = await readRecord(path.join(dataDir, `${id}.json`));
        if (validAgyRecord(record, id, homeDir) && record.agyPid !== undefined && await startOf(record.agyPid) === record.agyStartTicks) {
          const target = await agyFocusTarget(record, { procDir });
          if (target) {
            const screen = await exec(['@', '--to', target.listenOn, 'get-text', '--match', `id:${target.windowId}`, '--extent', 'screen']);
            matched = Boolean(matchAgyApprovalScreen(screen, approval));
          }
        }
      }
    } catch { matched = false; } finally { busy = false; }
    if (stopped || !isOpen()) { stop(); return; }
    if (!seen) {
      if (matched) { seen = true; onMatch?.(); }
      else if (now() - startedAt >= timeoutMs) { stop(); onGone?.(); }
    } else if (!matched) {
      stop();
      onGone?.();
    }
  };
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref?.();
  queueMicrotask(() => { void check(); });
  return stop;
}

// Verifies the agy permission dialog on the kitty screen, types '1' (allow) or the deny digit (deny), and waits up to 2000 ms for it to close.
// Returns true when gone after typing, null when the dialog was already gone before typing, or false on mismatch/error/timeout.
export async function approveAgyInKitty({ dataDir, id, approval, decision, procDir = '/proc', startOf = processStart,
  homeDir = os.homedir(), exec = defaultKitty, wait = defaultWait, pollMs = 200, timeoutMs = 2000 }) {
  if (typeof id !== 'string' || !AGY_UUID.test(id) || !dataDir || !['allow', 'deny'].includes(decision)) return false;
  const record = await readRecord(path.join(dataDir, `${id}.json`));
  if (!validAgyRecord(record, id, homeDir) || record.agyPid === undefined || await startOf(record.agyPid) !== record.agyStartTicks) return false;
  const target = await agyFocusTarget(record, { procDir });
  if (!target) return false;
  const cmd = (action, args = []) => exec(['@', '--to', target.listenOn, action, '--match', `id:${target.windowId}`, ...args]);
  const getScreen = () => cmd('get-text', ['--extent', 'screen']);
  try {
    const screen = await getScreen();
    const denyDigit = matchAgyApprovalScreen(screen, approval);
    if (!denyDigit) return hasAnyAgyDialog(screen) ? false : null;
    await cmd('send-text', ['--', decision === 'allow' ? '1' : denyDigit]);
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += pollMs) {
      await wait(pollMs);
      if (!matchAgyApprovalScreen(await getScreen(), approval)) return true;
    }
    return false;
  } catch { return false; }
}

// asb doctor, only with kitty on PATH: the two remote control keys of kitty.conf (read only; no other line of the file is used).
export async function agyKittyDoctor(add, advice, { env = process.env, read } = {}) {
  // A PC without kitty gets no line and no kitty.conf advice.
  if (!await findExecutable('kitty', { env })) return;
  const conf = await read(path.join(env.HOME || os.homedir(), '.config', 'kitty', 'kitty.conf')).catch(() => '');
  let allow = '';
  let listen = false;
  for (const line of conf.split('\n')) {
    const [key, value = ''] = line.trim().split(/\s+/);
    if (key === 'allow_remote_control') allow = value;
    if (key === 'listen_on') listen = value.startsWith('unix:');
  }
  const ready = ['socket-only', 'socket', 'yes'].includes(allow) && listen;
  add('kitty-remote', 'Options', ready ? 'ok' : 'info', `kitty remote control: ${ready ? 'reachable' : 'not set up'}`);
  if (!ready) advice.push('In kitty.conf:', '  allow_remote_control socket-only', '  listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}');
}

async function readRecord(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.size > MAX_RECORD) return null;
    return JSON.parse(await handle.readFile('utf8'));
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

// The Bridge reads only ASB's hook records, never agy's stores or their metadata.
export async function readAgyRecords(dataDir, homeDir = os.homedir()) {
  const files = await fs.readdir(dataDir).catch(() => []);
  const records = [];
  for (const name of files) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !AGY_UUID.test(id) || id !== id.toLowerCase()) continue;
    const record = await readRecord(path.join(dataDir, name));
    if (validAgyRecord(record, id, homeDir)) records.push(record);
  }
  return records;
}

// The transcript's modification time: stat only, a regular file only.
async function transcriptMtime(file) {
  if (!file) return 0;
  const info = await fs.lstat(file).catch(() => null);
  return info?.isFile() ? info.mtimeMs : 0;
}

const NEW_AGY_TURN = /^(?:>\s+\S|●)/;
const AGY_PROMPT_BORDER = /^[─━═╭╮╰╯│┃ ]{10,}$/;
const AGY_INTERRUPT = /^(?:⎿\s*)?Interrupted · What should Antigravity CLI do instead\?/;

export function agyScreenInterrupted(screen) {
  const lines = screen.split('\n').map((line) => line.trim());
  const prompt = lines.findLastIndex((line) => line === '>');
  if (prompt < 1) return false;
  const after = lines.slice(prompt + 1);
  const footer = after.find((line) => line);
  if ((footer && !AGY_PROMPT_BORDER.test(footer)) || after.some((line) => NEW_AGY_TURN.test(line))) return false;
  let before = prompt - 1;
  while (before >= 0 && (!lines[before] || AGY_PROMPT_BORDER.test(lines[before]))) before--;
  return before >= 0 && AGY_INTERRUPT.test(lines[before]);
}

// Keep only the check result (not the screen). Reserve the interval before the read starts, also for overlapping scans.
let interruptChecks;
async function checkAgyInterrupt(file, record, target, newsAtMs, nowMs, exec) {
  if (!target || record.state !== 'working' || record.background || record.parentConversationId) return {};
  const last = interruptChecks.get(file);
  const screenCheckAtMs = Math.max(newsAtMs + LIVE_CHECK_MS, last?.nextAtMs || 0);
  const turn = JSON.stringify([record.agyPid, record.agyStartTicks, record.stateAtMs, newsAtMs, target.listenOn, target.windowId]);
  if (nowMs < screenCheckAtMs) return { screenCheckAtMs, interrupted: last?.turn === turn && await last.result };
  const result = Promise.resolve().then(() => exec(['@', '--to', target.listenOn, 'get-text', '--match', `id:${target.windowId}`, '--extent', 'screen']))
    .then(agyScreenInterrupted).catch(() => false);
  const nextAtMs = nowMs + LIVE_CHECK_MS;
  interruptChecks.set(file, { turn, nextAtMs, result });
  return { screenCheckAtMs: nextAtMs, interrupted: await result };
}

export function agyThread(record, { live, transcriptAtMs = 0, nowMs = Date.now(), canFocus = false, title = '',
  interrupted = false, screenCheckAtMs = Infinity }) {
  const { conversationId: id, workspace, state, stateAtMs } = record;
  const thread = {
    id: `agy:${id}`, externalId: id, provider: 'antigravity', providerLabel: 'Antigravity CLI', source: 'agy-cli', surface: 'cli',
    title: (record.parentConversationId && record.agentName) || title || `${path.basename(workspace) || workspace} · ${id.slice(0, 8)}`, cwd: workspace, archived: false,
    createdAtMs: record.createdAtMs, updatedAtMs: stateAtMs, canOpen: false, transcriptActivityAtMs: stateAtMs,
  };
  if (record.parentConversationId) Object.assign(thread, { isSubagent: true, parentThreadId: `agy:${record.parentConversationId}`,
    agentNickname: record.agentName || '' });
  if (state === 'idle') thread.cliNoTranscript = true;
  if (live && canFocus) thread.canFocus = true;
  if (state === 'working' || state === 'question') {
    Object.assign(thread, { lifecycleRunning: true, agentActivityAtMs: Math.max(stateAtMs, transcriptAtMs), latestLifecycleAtMs: stateAtMs });
    if (state === 'question') Object.assign(thread, { userQuestionBlocking: true, latestBlockingQuestionAtMs: stateAtMs,
      awaitingUserInput: true, latestUserQuestionAtMs: stateAtMs });
  }
  if (state === 'done' || state === 'failed') Object.assign(thread, { lifecycleRunning: false, latestLifecycleKind: state === 'done' ? 'task_complete' : 'failed',
    latestLifecycleAtMs: stateAtMs, latestTaskEndedAtMs: stateAtMs });
  if (!live) {
    thread.agyStatus = thread.lifecycleRunning ? { state: 'unknown', reason: 'The agy process ended during a task.' }
      : { state: 'idle', reason: 'The agy process ended.' };
    return thread;
  }
  if (state === 'question') thread.agyStatus = { state: 'waiting', reason: 'The current tool is waiting for an answer.' };
  const newsAtMs = Math.max(stateAtMs, transcriptAtMs);
  const quiet = state === 'working' && !record.background;
  if (interrupted) Object.assign(thread, { lifecycleRunning: false, latestLifecycleKind: 'turn_aborted',
    agyStatus: { state: 'idle', reason: 'The agy turn was interrupted.' } });
  else if (quiet && nowMs - newsAtMs > NO_NEWS_MS) thread.agyStatus = { state: 'unknown', reason: AGY_QUIET_REASON };
  const nextCheck = (Math.floor(nowMs / LIVE_CHECK_MS) + 1) * LIVE_CHECK_MS;
  thread.cliProcessCheckAtMs = Math.min(nextCheck, screenCheckAtMs, quiet && !thread.agyStatus ? newsAtMs + NO_NEWS_MS : Infinity);
  return thread;
}

// Reads the hook records (at most 500 files of 16 KiB each); a bad file is skipped. Removes its own records that are not live and older than 7 days.
export async function loadAntigravityDashboard({ dataDir, nowMs = Date.now(), homeDir = os.homedir(), startOf = processStart,
  procDir = '/proc', exec = defaultKitty } = {}) {
  interruptChecks ??= new Map();
  for (const [file, check] of interruptChecks) if (check.nextAtMs <= nowMs) interruptChecks.delete(file);
  const names = await fs.readdir(dataDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!names) return { generatedAtMs: nowMs, provider: { installed: false, status: 'missing', message: '' }, threads: [] };
  // shortcut: the first 500 names in sort order, not the newest; the 7-day removal keeps the folder small, sort by time if users keep more.
  const ids = names.filter((name) => name.endsWith('.json') && AGY_UUID.test(name.slice(0, -5))).sort().slice(0, MAX_FILES).map((name) => name.slice(0, -5));
  const threads = (await Promise.all(ids.map(async (id) => {
    const file = path.join(dataDir, `${id}.json`);
    const record = await readRecord(file);
    if (!validAgyRecord(record, id, homeDir)) return null;
    const live = record.agyPid !== undefined && await startOf(record.agyPid) === record.agyStartTicks;
    const titleFile = path.join(dataDir, `${id}.title`);
    if (!live && nowMs - record.stateAtMs > KEEP_MS) {
      await fs.rm(file, { force: true }).catch(() => {});
      await fs.rm(titleFile, { force: true }).catch(() => {});
      return null;
    }
    const [transcriptAtMs, target, title] = await Promise.all([live ? transcriptMtime(record.transcriptMtimePath) : 0,
      live ? agyFocusTarget(record, { procDir }) : null, readAgyTitle(titleFile)]);
    const check = await checkAgyInterrupt(file, record, target, Math.max(record.stateAtMs, transcriptAtMs), nowMs, exec);
    return agyThread(record, { live, nowMs, transcriptAtMs, canFocus: Boolean(target), title, ...check });
  }))).filter(Boolean);
  return { generatedAtMs: nowMs, provider: { installed: true, status: 'ready', message: '', threadCount: threads.length }, threads };
}
