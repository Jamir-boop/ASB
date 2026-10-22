import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePeerKey } from '../src/claude';
import { assertWindowsRow, liveServiceCommand, liveServiceLines, nativeEnv, nativePeerToken, peerInboxPath } from './native-env';

const parent = {
  PATH: '/synthetic/bin', Path: 'C:\\synthetic\\bin',
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD',
  HOME: '/real/home', USERPROFILE: 'C:\\real', HOMEDRIVE: 'C:', HOMEPATH: '\\real',
  APPDATA: 'C:\\real\\appdata', LOCALAPPDATA: 'C:\\real\\localappdata', TEMP: 'C:\\real\\tmp', TMP: 'C:\\real\\tmp',
  XDG_CONFIG_HOME: '/real/config', SECRET_TOKEN: 'synthetic-secret', OPENAI_API_KEY: 'synthetic-api-key',
};

// Keep a copy of the original environment to catch changes to Linux isolation.
const linuxEnv = (root: string, path = parent.PATH) => ({
  PATH: path,
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  XDG_RUNTIME_DIR: join(root, 'run'),
  TMPDIR: join(root, 'tmp'),
  TERM: 'dumb',
  ASB_NATIVE_OUT: join(root, 'run'),
});

test('native Linux environment stays exactly isolated as before', () => {
  const root = join(tmpdir(), 'synthetic-native-env');
  expect(nativeEnv(root, 'linux', parent)).toEqual(linuxEnv(root));
  expect(nativeEnv(root, 'linux', {})).toEqual(linuxEnv(root, '/usr/bin:/bin'));
});

test('native Windows environment keeps only system variables and temporary homes', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-env-'));
  try {
    const { PATH, ...pathCaseParent } = parent;
    const env = nativeEnv(root, 'win32', pathCaseParent);
    expect(env).toEqual({
      ...linuxEnv(root, parent.Path),
      SystemRoot: parent.SystemRoot, windir: parent.windir, SystemDrive: parent.SystemDrive,
      ComSpec: parent.ComSpec, PATHEXT: parent.PATHEXT,
      USERPROFILE: join(root, 'home'),
      APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
      TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    });
    for (const key of ['HOMEDRIVE', 'HOMEPATH', 'Path', 'SECRET_TOKEN', 'OPENAI_API_KEY']) expect(env).not.toHaveProperty(key);
    expect(existsSync(env.APPDATA!)).toBe(true);
    expect(existsSync(env.LOCALAPPDATA!)).toBe(true);
    expect(nativeEnv(root, 'win32', parent).PATH).toBe(PATH);
    expect(nativeEnv(root, 'win32', {})).not.toHaveProperty('SystemRoot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native service snapshots use the platform process list without contacting a service', () => {
  expect(liveServiceCommand('linux')).toEqual(['ps', '-o', 'pid,lstart,cmd', '-C', 'opencode-cli']);
  const command = liveServiceCommand('win32');
  expect(command.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command']);
  for (const part of ['Get-CimInstance Win32_Process', "'opencode*'", "'serve'", 'ProcessId', 'CreationDate', 'CommandLine']) expect(command[4]).toContain(part);
  const output = ' PID START CMD\n 123 synthetic opencode serve --service\r\n 456 synthetic opencode serve --port 9999\r\n';
  expect(liveServiceLines(output, 'linux')).toEqual(['123 synthetic opencode serve --service']);
  expect(liveServiceLines(output, 'win32')).toEqual(['123 synthetic opencode serve --service', '456 synthetic opencode serve --port 9999']);
});

test('native peer inbox uses the Claude socket or named pipe form', () => {
  const work = join(tmpdir(), 'synthetic-native-work');
  expect(peerInboxPath(work, 'linux')).toBe(join(work, `${process.pid}.sock`));
  expect(peerInboxPath(work, 'win32')).toMatch(/^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/);
});

test('only the Windows fake peer needs a random auth token', () => {
  expect(nativePeerToken('linux')).toBeUndefined();
  expect(nativePeerToken('win32')).toMatch(/^[0-9a-f]{32}$/);
  expect(nativePeerToken('win32')).not.toBe(nativePeerToken('win32'));
});

test('Windows row checks validate the image, identity, key, and pipe with an injected process list', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-row-'));
  const row = { pid: 123, procStart: 'synthetic-start', messagingSocketPath: peerInboxPath(root, 'win32') };
  const output = (text: string, exitCode = 0) => ({ exitCode, stdout: Buffer.from(text), stderr: Buffer.from('synthetic process list') });
  const list = (command: string[]) => {
    expect(command).toEqual(['tasklist', '/FI', 'PID eq 123', '/FO', 'CSV', '/NH']);
    return output('"findstr.exe","123","Console","1","100 K"\r\n');
  };
  try {
    expect(assertWindowsRow(row, root, 'linux', () => { throw new Error('must not list processes'); })).toEqual([]);
    expect(() => assertWindowsRow(row, root, 'win32', () => output('', 1))).toThrow();
    expect(() => assertWindowsRow(row, root, 'win32', () => output('"other.exe","123",'))).toThrow();
    expect(() => assertWindowsRow(row, root, 'win32', () => output('"findstr.exe","124",'))).toThrow();
    expect(() => assertWindowsRow({ ...row, procStart: undefined }, root, 'win32', list)).toThrow('procStart');
    expect(() => assertWindowsRow(row, root, 'win32', list)).toThrow('key file');
    const sessions = join(root, 'sessions');
    mkdirSync(sessions);
    writePeerKey(sessions, row.pid, row.messagingSocketPath, 'ab'.repeat(16), row.procStart);
    expect(assertWindowsRow(row, root, 'win32', list).map(line => line.slice(0, 9))).toEqual(['PASS (w1)', 'PASS (w2)', 'PASS (w3)', 'PASS (w4)']);
    const bad = { ...row, messagingSocketPath: join(root, 'not-a-pipe.sock') };
    writePeerKey(sessions, bad.pid, bad.messagingSocketPath, 'ab'.repeat(16), bad.procStart);
    expect(() => assertWindowsRow(bad, root, 'win32', list)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
