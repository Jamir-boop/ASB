import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Peer } from '../src/claude';
import { inboxPath, keyName } from '../src/platform';

export function nativeEnv(root: string, platform: string = process.platform, parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parentEnv.PATH ?? (platform === 'win32' ? parentEnv.Path : undefined) ?? '/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    TMPDIR: join(root, 'tmp'),
    TERM: 'dumb',
    ASB_NATIVE_OUT: join(root, 'run'),
  };
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT']) {
      if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
    }
    Object.assign(env, {
      USERPROFILE: env.HOME,
      APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'localappdata'),
      TEMP: env.TMPDIR,
      TMP: env.TMPDIR,
    });
    for (const dir of [env.APPDATA!, env.LOCALAPPDATA!]) mkdirSync(dir, { recursive: true });
  }
  return env;
}

export function liveServiceCommand(platform: string = process.platform) {
  return platform === 'win32'
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'opencode*' -and $_.CommandLine -match 'serve' } | Sort-Object ProcessId | ForEach-Object { '{0} {1:o} {2}' -f $_.ProcessId, $_.CreationDate, $_.CommandLine }"]
    : ['ps', '-o', 'pid,lstart,cmd', '-C', 'opencode-cli'];
}

export function liveServiceLines(output: string, platform: string = process.platform) {
  return output.split('\n').filter(line => (platform === 'win32' ? /serve/ : /serve --service/).test(line)).map(line => line.trim());
}

export function peerInboxPath(work: string, platform: string = process.platform) {
  return inboxPath(work, `${process.pid}.sock`, platform);
}

export function nativePeerToken(platform: string = process.platform) {
  return platform === 'win32' ? randomBytes(16).toString('hex') : undefined;
}

export function assertWindowsRow(row: Pick<Peer, 'pid' | 'procStart' | 'messagingSocketPath'>, claudeHome: string,
  platform: string = process.platform, spawn: (command: string[]) => { exitCode: number; stdout: Buffer; stderr: Buffer } = command => Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })) {
  if (platform !== 'win32') return [];
  const image = spawn(['tasklist', '/FI', `PID eq ${row.pid}`, '/FO', 'CSV', '/NH']);
  assert.equal(image.exitCode, 0, image.stderr.toString());
  assert.match(image.stdout.toString(), new RegExp(`^"findstr\\.exe","${row.pid}",`, 'im'));
  assert(row.procStart, 'Windows row must have procStart');
  assert(existsSync(join(claudeHome, 'sessions', keyName(row.pid, row.messagingSocketPath))), 'Windows row key file must exist');
  assert.match(row.messagingSocketPath, /^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/);
  return [
    'PASS (w1) row PID is a live findstr.exe',
    'PASS (w2) row has procStart',
    'PASS (w3) row key file follows the Claude key name rule',
    'PASS (w4) messagingSocketPath is a cc-msg named pipe',
  ];
}
