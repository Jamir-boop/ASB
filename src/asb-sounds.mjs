import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACTION_AT, QUESTION_AT } from './switchboard.mjs';

// Port of android/.../notify/Events.kt, so the PC plays the same events as the phone.
export const BIT_DONE = 1;
export const BIT_FAILED = 2;
export const BIT_INPUT = 4;

export const SOUND_DIR = fileURLToPath(new URL('../assets/sounds/', import.meta.url));
export const SOUND_FILES = {
  [BIT_DONE]: 'opencode_staplebops_01.wav',
  [BIT_INPUT]: 'opencode_staplebops_02.wav',
  [BIT_FAILED]: 'opencode_nope_03.wav',
};

export function soundBits(row) {
  if (row.archived) return 0;
  // A Codex chat with native read state shows its result only as native attention; the outcome says which sound.
  const native = row.nativeAttention && row.state === 'idle';
  const nativeFailed = native && ['failed', 'limit'].includes(row.lastOutcome);
  return (row.completionAttention || (native && !nativeFailed) ? BIT_DONE : 0)
    | (row.failedAttention || nativeFailed ? BIT_FAILED : 0)
    | (row.questionAttention || row.actionAttention ? BIT_INPUT : 0);
}

const soundMark = (row) => ({ bits: soundBits(row),
  questionAt: row.questionPending || row.questionAttention ? row[QUESTION_AT] || 0 : null,
  actionAt: row.actionRequired || row.actionAttention ? row[ACTION_AT] || 0 : null,
});
// Do not replay an older pending request, or treat a late timestamp for the same request as a new one.
const newerStart = (at, before) => before !== 0 && at > (before ?? 0);

export function soundEvents(baseline, rows) {
  if (!baseline) return [];
  const events = [];
  for (const row of rows) {
    const old = baseline.get(row.id);
    const mark = soundMark(row);
    let added = mark.bits & ~(old?.bits || 0);
    if ((mark.bits & old?.bits & BIT_INPUT) && (row.questionAttention && newerStart(mark.questionAt, old.questionAt)
      || row.actionAttention && newerStart(mark.actionAt, old.actionAt))) added |= BIT_INPUT;
    for (const kind of [BIT_INPUT, BIT_FAILED, BIT_DONE]) if (added & kind) events.push({ row, kind });
  }
  return events;
}

// Rows missing from one update keep their marks, so a skipped scan cannot replay a request.
export function soundBaseline(baseline, rows) {
  const next = new Map(baseline || []);
  for (const row of rows) {
    const mark = soundMark(row);
    const old = baseline?.get(row.id);
    if (mark.questionAt !== null) mark.questionAt = Math.max(mark.questionAt, old?.questionAt || 0);
    if (mark.actionAt !== null) mark.actionAt = Math.max(mark.actionAt, old?.actionAt || 0);
    next.set(row.id, mark);
  }
  return next;
}

// Plays at most one sound per dashboard update: Needs input, then Failed, then Done.
// The baseline moves even when canPlay is false, so a board that opens later hears only new events.
export function createSoundWatcher(play, canPlay = () => true) {
  let baseline = null;
  // A member's rows can first arrive after the first update; they are its baseline, not new events.
  const machines = new Set();
  return (dashboard) => {
    const rows = dashboard.threads || [];
    const known = rows.filter((row) => !row.remote || machines.has(row.machineId));
    const kind = Math.max(0, ...soundEvents(baseline, known).map((event) => event.kind));
    baseline = soundBaseline(baseline, rows);
    for (const row of rows) if (row.remote) machines.add(row.machineId);
    if (kind && canPlay()) play(kind);
  };
}

export const PLAYERS = [
  ['pw-play', (file) => ['--media-role', 'Notification', '-P', '{ application.name = "ASB" }', file]],
  ['paplay', (file) => ['--client-name=ASB', '--property=media.role=event', file]],
  ['aplay', (file) => ['-q', file]],
];

// Windows Media.SoundPlayer plays the PCM WAV files. A new powershell.exe costs about 280 ms for each sound, so one hidden process
// reads one WAV path per line from stdin and plays each with PlaySync, in order. The path is data on stdin, never in the command text.
// The script reads UTF-8 bytes from the stdin handle, because the console code page would change a path with non-ASCII letters.
// A bad line or a missing file only skips that sound, and `exit 0` keeps the failed last sound from giving the exit code 1.
export const WINDOWS_PLAYER_ARGS = ['-NoProfile', '-NonInteractive', '-Command',
  '$r=New-Object IO.StreamReader([Console]::OpenStandardInput(),[Text.Encoding]::UTF8);'
  + 'while($null -ne ($p=$r.ReadLine())){try{if($p){(New-Object Media.SoundPlayer $p).PlaySync()}}catch{}};exit 0'];
const WINDOWS_IDLE_MS = 5 * 60_000;

// The process ends when its stdin closes. After 5 minutes with no sound, ASB closes it and the next sound starts a new one.
// The child, its stdin, and the timer are unref'd, so the engine can exit at once; the closed pipe ends the process.
function createWindowsPlayer(spawn, report, dir) {
  let current = null;
  let idle = null;
  let missing = false;
  const start = () => {
    const child = spawn('powershell.exe', WINDOWS_PLAYER_ARGS, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const drop = () => { if (current === child) { current = null; clearTimeout(idle); } };
    child.on('error', (error) => {
      drop();
      if (error.code !== 'ENOENT') return report(`ASB cannot play a sound with powershell.exe: ${error.message}`);
      missing = true;
      report('ASB cannot play sounds: Windows PowerShell was not found.');
    });
    child.on('exit', (code) => { drop(); if (code) report(`ASB cannot play a sound: powershell.exe exited with code ${code}.`); });
    child.stdin.on('error', (error) => { drop(); report(`ASB cannot play a sound with powershell.exe: ${error.message}`); });
    child.unref();
    child.stdin.unref();
    return child;
  };
  return (kind) => {
    const file = SOUND_FILES[kind];
    if (missing || !file) return;
    try {
      current ??= start();
      current.stdin.write(`${dir}${file}\n`);
      clearTimeout(idle);
      idle = setTimeout(() => { const child = current; current = null; child.stdin.end(); }, WINDOWS_IDLE_MS).unref();
    } catch (error) {
      report(`ASB cannot play a sound with powershell.exe: ${error.message}`);
    }
  };
}

// The player never blocks or throws. On Linux it falls back to paplay when pw-play is missing, then to aplay.
export function createSoundPlayer({ spawn = spawnProcess, log = console.error, dir = SOUND_DIR, platform = process.platform } = {}) {
  let reported = false;
  const report = (message) => { if (!reported) { reported = true; log(message); } };
  if (platform === 'win32') return createWindowsPlayer(spawn, report, dir);
  let index = 0;
  const play = (kind, file = SOUND_FILES[kind]) => {
    const player = PLAYERS[index];
    if (!player || !file) return;
    const [program, args] = player;
    try {
      const child = spawn(program, args(`${dir}${file}`), { detached: true, stdio: 'ignore' });
      child.on('error', (error) => {
        if (error.code !== 'ENOENT') return report(`ASB cannot play a sound with ${program}: ${error.message}`);
        if (PLAYERS[index] === player) index += 1;
        if (PLAYERS[index]) play(kind, file);
        else report('ASB cannot play sounds: install pw-play (PipeWire), paplay (PulseAudio), or aplay (ALSA). Run asb doctor for the command.');
      });
      child.on('exit', (code) => { if (code) report(`ASB cannot play a sound: ${program} exited with code ${code}.`); });
      child.unref();
    } catch (error) {
      report(`ASB cannot play a sound with ${program}: ${error.message}`);
    }
  };
  return play;
}
