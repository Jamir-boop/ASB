// Antigravity CLI (agy) sessions from the records of the ASB agy hook (scripts/asb-agy-hook.mjs): IDs, paths, times, and states only.
// The rows are view only. ASB never reads agy's own stores, its login, or its transcript text (the transcript is only stat'ed).
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processStart } from './claude-registry.mjs';
import { stateDir } from './platform-paths.mjs';

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

export function agyThread(record, { live, transcriptAtMs = 0, nowMs = Date.now() }) {
  const { conversationId: id, workspace, state, stateAtMs } = record;
  const thread = {
    id: `agy:${id}`, externalId: id, provider: 'antigravity', providerLabel: 'Antigravity CLI', source: 'agy-cli', surface: 'cli',
    title: `${path.basename(workspace) || workspace} · ${id.slice(0, 8)}`, cwd: workspace, archived: false,
    createdAtMs: record.createdAtMs, updatedAtMs: stateAtMs, canOpen: false, transcriptActivityAtMs: stateAtMs,
  };
  if (state === 'idle') thread.cliNoTranscript = true;
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
export async function loadAntigravityDashboard({ dataDir, nowMs = Date.now(), homeDir = os.homedir(), startOf = processStart } = {}) {
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
    return agyThread(record, { live, nowMs, transcriptAtMs: live ? await transcriptMtime(record.transcriptMtimePath) : 0 });
  }))).filter(Boolean);
  return { generatedAtMs: nowMs, provider: { installed: true, status: 'ready', message: '', threadCount: threads.length }, threads };
}
