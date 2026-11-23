// Antigravity CLI (agy) sessions from the records of the ASB agy hook (scripts/asb-agy-hook.mjs): IDs, paths, times, and states only.
// The rows are view only, except that a live row in a kitty with remote control focuses its kitty window.
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
const FIELDS = new Set(['conversationId', 'workspace', 'state', 'stateAtMs', 'createdAtMs', 'agyPid', 'agyStartTicks', 'kittyWindowId', 'kittyPid',
  'kittyListenOn', 'background', 'transcriptMtimePath']);
const MAX_FILES = 500;
const MAX_RECORD = 16 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NO_NEWS_MS = 10 * 60 * 1000;
// agy fires no event when it ends, so a live row is checked again at the next 30 s mark.
const LIVE_CHECK_MS = 30_000;
const KITTY_LEVELS = 8;
export const AGY_FOCUS_ERROR = 'ASB could not focus this agy session in kitty.';

export const agyAbsolutePath = (value) => typeof value === 'string' && PATH_TEXT.test(value) && path.isAbsolute(value) ? path.resolve(value) : '';
export const agyRecordsDir = (env = process.env, homeDir = os.homedir()) => path.join(stateDir(env, 'linux', homeDir), 'agy');
// The transcript is kept only as a path to stat, and only under agy's own folder.
export const agyTranscriptPath = (value, homeDir = os.homedir()) => {
  const file = agyAbsolutePath(value);
  return file && file.startsWith(path.join(homeDir, '.gemini', 'antigravity-cli') + path.sep) ? file : '';
};

const digits = (value, max) => typeof value === 'string' && new RegExp(`^[0-9]{1,${max}}$`).test(value);
const time = (value) => Number.isFinite(value) && value > 0;

export function validAgyRecord(record, id, homeDir = os.homedir()) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some((key) => !FIELDS.has(key))) return false;
  const { conversationId, workspace, state, stateAtMs, createdAtMs, agyPid, agyStartTicks, kittyWindowId, kittyPid, kittyListenOn,
    background, transcriptMtimePath } = record;
  return conversationId === id && agyAbsolutePath(workspace) === workspace && STATES.includes(state) && time(stateAtMs) && time(createdAtMs)
    && (agyPid === undefined) === (agyStartTicks === undefined)
    && (agyPid === undefined || (Number.isInteger(agyPid) && agyPid > 1 && digits(agyStartTicks, 20)))
    && (kittyWindowId === undefined || digits(kittyWindowId, 10)) && (kittyPid === undefined || digits(kittyPid, 10))
    && (kittyListenOn === undefined || (typeof kittyListenOn === 'string' && kittyListenOn.length <= 300 && AGY_LISTEN_ON.test(kittyListenOn)))
    && (background === undefined || background === true)
    && (transcriptMtimePath === undefined || agyTranscriptPath(transcriptMtimePath, homeDir) === transcriptMtimePath);
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
  if (!ready) advice.push('In kitty.conf:', '  allow_remote_control socket-only', '  listen_on unix:@kitty-{kitty_pid}');
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

// The transcript's modification time: stat only, a regular file only.
async function transcriptMtime(file) {
  if (!file) return 0;
  const info = await fs.lstat(file).catch(() => null);
  return info?.isFile() ? info.mtimeMs : 0;
}

export function agyThread(record, { live, transcriptAtMs = 0, nowMs = Date.now(), canFocus = false }) {
  const { conversationId: id, workspace, state, stateAtMs } = record;
  const thread = {
    id: `agy:${id}`, externalId: id, provider: 'antigravity', providerLabel: 'Antigravity CLI', source: 'agy-cli', surface: 'cli',
    title: `${path.basename(workspace) || workspace} · ${id.slice(0, 8)}`, cwd: workspace, archived: false,
    createdAtMs: record.createdAtMs, updatedAtMs: stateAtMs, canOpen: false, transcriptActivityAtMs: stateAtMs,
  };
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
  // Esc fires no event: working with no event or transcript change for 10 minutes is Unknown. Questions stay Waiting; background commands keep Working.
  const newsAtMs = Math.max(stateAtMs, transcriptAtMs);
  const quiet = state === 'working' && !record.background;
  if (quiet && nowMs - newsAtMs > NO_NEWS_MS) thread.agyStatus = { state: 'unknown', reason: 'No news from the agy session for 10 minutes.' };
  const nextCheck = (Math.floor(nowMs / LIVE_CHECK_MS) + 1) * LIVE_CHECK_MS;
  thread.cliProcessCheckAtMs = quiet && !thread.agyStatus ? Math.min(nextCheck, newsAtMs + NO_NEWS_MS) : nextCheck;
  return thread;
}

// Reads the hook records (at most 500 files of 16 KiB each); a bad file is skipped. Removes its own records that are not live and older than 7 days.
export async function loadAntigravityDashboard({ dataDir, nowMs = Date.now(), homeDir = os.homedir(), startOf = processStart, procDir = '/proc' } = {}) {
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
    if (!live && nowMs - record.stateAtMs > KEEP_MS) {
      await fs.rm(file, { force: true }).catch(() => {});
      return null;
    }
    return agyThread(record, { live, nowMs, transcriptAtMs: live ? await transcriptMtime(record.transcriptMtimePath) : 0,
      canFocus: live && Boolean(await agyFocusTarget(record, { procDir })) });
  }))).filter(Boolean);
  return { generatedAtMs: nowMs, provider: { installed: true, status: 'ready', message: '', threadCount: threads.length }, threads };
}
