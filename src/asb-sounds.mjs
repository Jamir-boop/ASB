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

// Windows Media.SoundPlayer plays the PCM WAV files. The path goes in ASB_SOUND, never in the command text.
const WINDOWS_PLAYERS = [
  ['powershell.exe', () => ['-NoProfile', '-NonInteractive', '-Command', '(New-Object Media.SoundPlayer $env:ASB_SOUND).PlaySync()']],
];

// The player never blocks or throws. It falls back to paplay when pw-play is missing, then to aplay.
export function createSoundPlayer({ spawn = spawnProcess, log = console.error, dir = SOUND_DIR, platform = process.platform } = {}) {
  const win32 = platform === 'win32';
  const players = win32 ? WINDOWS_PLAYERS : PLAYERS;
  let index = 0;
  let reported = false;
  const report = (message) => { if (!reported) { reported = true; log(message); } };
  const play = (kind, file = SOUND_FILES[kind]) => {
    const player = players[index];
    if (!player || !file) return;
    const [program, args] = player;
    const target = `${dir}${file}`;
    try {
      // A detached child on Windows gets its own console, so win32 hides the window and does not detach.
      const child = spawn(program, args(target), win32
        ? { env: { ...process.env, ASB_SOUND: target }, windowsHide: true, stdio: 'ignore' }
        : { detached: true, stdio: 'ignore' });
      child.on('error', (error) => {
        if (error.code !== 'ENOENT') return report(`ASB cannot play a sound with ${program}: ${error.message}`);
        if (players[index] === player) index += 1;
        if (players[index]) play(kind, file);
        else report(win32 ? 'ASB cannot play sounds: Windows PowerShell was not found.'
          : 'ASB cannot play sounds: install pw-play (PipeWire), paplay (PulseAudio), or aplay (ALSA). Run asb doctor for the command.');
      });
      child.on('exit', (code) => { if (code) report(`ASB cannot play a sound: ${program} exited with code ${code}.`); });
      child.unref();
    } catch (error) {
      report(`ASB cannot play a sound with ${program}: ${error.message}`);
    }
  };
  return play;
}
