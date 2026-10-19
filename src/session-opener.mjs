import { spawn } from 'node:child_process';

export function openCommandForUrl(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

export function scopedCommand(command, args, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'linux' || !env.INVOCATION_ID) return { command, args };
  return { command: 'systemd-run', args: ['--user', '--scope', '--collect', '--quiet', '--', command, ...args] };
}

// An opener can start a long-running app that inherits its stdio: ignored output has no pipe to keep the open waiting.
// Under systemd, the app gets its own scope, so it does not keep asb.service running.
export function runOpener(command, args, { timeout }) {
  const scoped = scopedCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(scoped.command, scoped.args, { stdio: 'ignore', timeout });
    child.once('error', reject);
    child.once('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || `exit code ${code}`}).`))));
  });
}

export async function openThreadInCodex(thread, {
  platform = process.platform,
  runCommand = runOpener,
} = {}) {
  if (!thread.appDeepLink) {
    throw new Error('Thread is missing a Codex deep link');
  }

  const { command, args } = openCommandForUrl(thread.appDeepLink, platform);
  await runCommand(command, args, { timeout: 5000 });
  return { opened: true, method: 'codex-deeplink' };
}
