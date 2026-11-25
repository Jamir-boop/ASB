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

const sessionArgument = (args, id) => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === '--session' || arg === '-s') && args[index + 1] === id) return true;
    if (arg === `--session=${id}` || arg === `-s=${id}`) return true;
  }
  return false;
};

// The candidate with the session argument, else the one in the folder whose kitty window title shows the row title.
export async function findOpenCodeKittyWindow({ id, title, cwd, procDir = '/proc', exec = (args) => defaultKitty(args, MAX_LS) }) {
  const candidates = [];
  for (const entry of await fs.readdir(procDir, { withFileTypes: true }).catch(() => [])) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (!PID.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      if ((await procInfo(pid, procDir))?.comm !== 'opencode') continue;
      const args = (await fs.readFile(path.join(procDir, entry.name, 'cmdline'))).toString('utf8').split('\0').filter(Boolean);
      if (args[1] === 'serve') continue;
      const env = await kittyEnv(pid, procDir);
      const kittyPid = await kittyAncestor(pid, procDir);
      if (!kittyPid) continue;
      const target = await agyFocusTarget({ agyPid: pid, kittyWindowId: env.windowId, kittyPid: String(kittyPid), kittyListenOn: env.listenOn },
        { procDir });
      if (!target) continue;
      candidates.push({ pid, args, ...target });
    } catch { /* skip this candidate */ }
  }
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
