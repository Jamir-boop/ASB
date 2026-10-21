import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Port of android/.../notify/Events.kt, so the PC plays the same events as the phone.
export const BIT_DONE = 1;
export const BIT_FAILED = 2;
export const BIT_INPUT = 4;
const BIT_LIMITED = 8;

export const SOUND_DIR = fileURLToPath(new URL('../assets/sounds/', import.meta.url));
export const SOUND_FILES = {
  [BIT_DONE]: 'opencode_staplebops_01.wav',
  [BIT_INPUT]: 'opencode_staplebops_02.wav',
  [BIT_FAILED]: 'opencode_nope_03.wav',
};

const limited = (row, nowMs) => Number(row.limitResetsAtMs || 0) > nowMs;

export function soundBits(row) {
  if (row.archived) return 0;
  // A Codex chat with native read state shows its result only as native attention; the outcome says which sound.
  const native = row.nativeAttention && row.state === 'idle';
  const nativeFailed = native && row.lastOutcome === 'failed';
  return (row.completionAttention || (native && !nativeFailed) ? BIT_DONE : 0)
    | (row.failedAttention || nativeFailed ? BIT_FAILED : 0)
    | (row.questionAttention || row.actionRequired ? BIT_INPUT : 0);
}

export function soundEvents(baseline, rows, nowMs = Date.now()) {
  if (!baseline) return [];
  const events = [];
  for (const row of rows) {
    const old = baseline.get(row.id) || 0;
    let added = soundBits(row) & ~old;
    // Stored attention survives a limit; do not play its first restoration after the reset.
    if (limited(row, nowMs) || old & BIT_LIMITED) added &= BIT_INPUT;
    for (const kind of [BIT_INPUT, BIT_FAILED, BIT_DONE]) if (added & kind) events.push({ row, kind });
  }
  return events;
}

// Rows missing from one update keep their bits, so a skipped scan cannot replay an old mark.
export function soundBaseline(baseline, rows, nowMs = Date.now()) {
  const next = new Map(baseline || []);
  for (const row of rows) {
    const current = soundBits(row);
    next.set(row.id, !row.archived && limited(row, nowMs)
      ? (current & BIT_INPUT) | ((baseline?.get(row.id) || 0) & (BIT_DONE | BIT_FAILED)) | BIT_LIMITED
      : current);
  }
  return next;
}

// Plays at most one sound per dashboard update: Needs input, then Failed, then Done.
// The baseline moves even when canPlay is false, so a board that opens later hears only new events.
export function createSoundWatcher(play, canPlay = () => true) {
  let baseline = null;
  // A member's rows can first arrive after the first update; they are its baseline, not new events.
  const machines = new Set();
  return (dashboard, nowMs = Date.now()) => {
    const rows = dashboard.threads || [];
    const known = rows.filter((row) => !row.remote || machines.has(row.machineId));
    const kind = Math.max(0, ...soundEvents(baseline, known, nowMs).map((event) => event.kind));
    baseline = soundBaseline(baseline, rows, nowMs);
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
