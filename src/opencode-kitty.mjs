// Finds the kitty window that already runs an OpenCode TUI for one session: by the session argument, or by the folder and the window title.
// ASB reads only KITTY_WINDOW_ID and KITTY_LISTEN_ON from the environment of an OpenCode process, and keeps nothing.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agyFocusTarget, procInfo } from './antigravity-data.mjs';

const MAX_CANDIDATES = 64;
const MAX_ENVIRON = 256 * 1024;
const MAX_LS = 1024 * 1024;
const KITTY_LEVELS = 8;
const PID = /^[0-9]{1,20}$/;
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;

const defaultKitty = (args, maxBuffer) => new Promise((resolve, reject) => execFile('kitty', args, { timeout: 3000, maxBuffer },
  (error, stdout) => (error ? reject(error) : resolve(stdout))));

// The TUI title of a session title, as OpenCode sets it.
export const openCodeWindowTitle = (title) => (title.length > 40 ? `OC | ${title.slice(0, 37)}…` : `OC | ${title}`);

async function kittyEnv(pid, procDir) {
  const handle = await fs.open(path.join(procDir, String(pid), 'environ'), 'r');
  const buffer = Buffer.alloc(MAX_ENVIRON);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let windowId;
    let listenOn;
    for (const entry of buffer.toString('latin1', 0, bytesRead).split('\0')) {
      if (windowId === undefined && entry.startsWith('KITTY_WINDOW_ID=')) windowId = entry.slice('KITTY_WINDOW_ID='.length);
      else if (listenOn === undefined && entry.startsWith('KITTY_LISTEN_ON=')) listenOn = entry.slice('KITTY_LISTEN_ON='.length);
    }
    return { windowId, listenOn };
  } finally { await handle.close(); }
}

// The kitty ancestor of an OpenCode process, up to the same level limit as agy.
async function kittyAncestor(pid, procDir) {
  let current = pid;
  let info = await procInfo(current, procDir);
  for (let level = 0; level < KITTY_LEVELS && info; level++) {
    current = info.ppid;
    if (!Number.isInteger(current) || current <= 0) return null;
    info = await procInfo(current, procDir);
    if (info?.comm === 'kitty') return current;
  }
  return null;
}

function* sessionArguments(args) {
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if ((arg === '--session' || arg === '-s') && index + 1 < args.length) yield args[index + 1];
    else if (arg.startsWith('--session=')) yield arg.slice('--session='.length);
    else if (arg.startsWith('-s=')) yield arg.slice('-s='.length);
  }
}

async function kittyTarget(pid, procDir) {
  try {
    const env = await kittyEnv(pid, procDir);
    const kittyPid = await kittyAncestor(pid, procDir);
    return kittyPid ? await agyFocusTarget({ agyPid: pid, kittyWindowId: env.windowId, kittyPid: String(kittyPid), kittyListenOn: env.listenOn },
      { procDir }) : null;
  } catch { return null; }
}

// Every live `opencode` process of this user that is not `serve`, with its kitty target when it has one.
async function openCodeCandidates(procDir) {
  const candidates = [];
  for (const entry of await fs.readdir(procDir, { withFileTypes: true }).catch(() => [])) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (!PID.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      if ((await procInfo(pid, procDir))?.comm !== 'opencode') continue;
      const args = (await fs.readFile(path.join(procDir, entry.name, 'cmdline'))).toString('utf8').split('\0').filter(Boolean);
      if (args[1] === 'serve') continue;
      candidates.push({ pid, args, target: await kittyTarget(pid, procDir) });
    } catch { /* skip this candidate */ }
  }
  return candidates;
}

// The windows of one kitty socket by ID, from `kitty @ --to <listenOn> ls`: OS windows, then their tabs, then the windows.
async function kittyWindowsByListenOn(listenOn, exec) {
  const windows = new Map();
  for (const osWindow of JSON.parse(await exec(['@', '--to', listenOn, 'ls']))) {
    for (const tab of osWindow.tabs || []) for (const window of tab.windows || []) windows.set(String(window.id), window);
  }
  return windows;
}

// The ID of each session that a live OpenCode TUI shows now, and the folder and kitty window title of each other TUI in kitty.
export async function openCodeTerminalSessions({ procDir = '/proc', exec = (args) => defaultKitty(args, MAX_LS) } = {}) {
  const ids = new Set();
  const shown = [];
  const windowsByListenOn = new Map();
  for (const { pid, args, target } of await openCodeCandidates(procDir)) {
    const id = [...sessionArguments(args)].find((value) => SESSION_ID.test(value));
    if (id !== undefined) { ids.add(id); continue; }
    if (!target) continue;
    try {
      if (!windowsByListenOn.has(target.listenOn)) {
        windowsByListenOn.set(target.listenOn, await kittyWindowsByListenOn(target.listenOn, exec).catch(() => null));
      }
      const window = windowsByListenOn.get(target.listenOn)?.get(String(target.windowId));
      if (!window) continue;
      shown.push({ cwd: await fs.readlink(path.join(procDir, String(pid), 'cwd')), title: window.title });
    } catch { /* skip this socket or process */ }
  }
  return { ids, shown };
}

const sessionArgument = (args, id) => [...sessionArguments(args)].includes(id);

// The candidate with the session argument, else the one in the folder whose kitty window title shows the row title.
export async function findOpenCodeKittyWindow({ id, title, cwd, procDir = '/proc', exec = (args) => defaultKitty(args, MAX_LS) }) {
  const candidates = (await openCodeCandidates(procDir)).filter((candidate) => candidate.target)
    .map((candidate) => ({ pid: candidate.pid, args: candidate.args, ...candidate.target }));
  const bySession = candidates.find((candidate) => sessionArgument(candidate.args, id));
  if (bySession) return bySession;
  const expected = typeof title === 'string' && title.length > 0 && cwd ? openCodeWindowTitle(title) : null;
  if (!expected) return null;
  for (const candidate of candidates) {
    try {
      if (await fs.readlink(path.join(procDir, String(candidate.pid), 'cwd')) !== cwd) continue;
      // `kitty @ ls` gives OS windows, then their tabs, then the windows.
      const shown = JSON.parse(await exec(['@', '--to', candidate.listenOn, 'ls', '--match', `id:${candidate.windowId}`]))
        .flatMap((osWindow) => osWindow.tabs || []).flatMap((tab) => tab.windows || []).find((window) => String(window.id) === candidate.windowId);
      if (shown?.title === expected) return candidate;
    } catch { /* skip this candidate */ }
  }
  return null;
}

// Focuses the found window; false on any error, so the caller can start a new one.
export async function focusOpenCodeKittyWindow(target, { exec = (args) => defaultKitty(args, MAX_LS) } = {}) {
  try {
    await exec(['@', '--to', target.listenOn, 'focus-window', '--match', `id:${target.windowId}`]);
    return true;
  } catch { return false; }
}
