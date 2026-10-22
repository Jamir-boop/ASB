// One placeholder process per registered session: a Claude registry row needs its own live PID.
// Linux uses `cat` (it exits on stdin EOF, so it dies with the server). Windows uses findstr.exe, as the relay does.
import { join } from 'node:path';
import { isWindows } from './platform';

export function placeholderCommand(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (isWindows(platform)) return [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'findstr.exe'), 'x'];
  return ['cat']; // PATH: NixOS has no /usr/bin/cat, and macOS has cat only in /bin.
}

// The command the relay and the OpenCode plugin spawn (unchanged shape for the relay).
export const PLACEHOLDER = placeholderCommand();

// A console-less parent gives a console program its own console window; closing it ends the placeholder.
export function placeholderSpawnOptions(platform: string = process.platform) {
  if (isWindows(platform)) return { stdin: 'pipe' as const, stdout: 'ignore' as const, stderr: 'ignore' as const, detached: true };
  return { stdin: 'pipe' as const, stdout: 'ignore' as const, stderr: 'ignore' as const };
}

export function spawnPlaceholder(command: string[] = PLACEHOLDER) {
  return Bun.spawn(command, placeholderSpawnOptions());
}
