import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function openCommandForUrl(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function codexResumeCommandForThread(thread = {}) {
  const threadId = String(thread.externalId || thread.id || '');
  if (!threadId) return thread.resumeCommand || '';

  const resumeCommand = `codex resume --no-alt-screen ${shellQuote(threadId)}`;
  return thread.cwd ? `cd ${shellQuote(thread.cwd)} && ${resumeCommand}` : resumeCommand;
}

function isCodexThread(thread = {}) {
  return thread.provider === 'codex'
    || thread.provider === 'codex-cli'
    || String(thread.defaultOpenMode || '').startsWith('codex-')
    || String(thread.appDeepLink || '').startsWith('codex://')
    || String(thread.resumeCommand || '').startsWith('codex resume');
}

export function resumeCommandForResponse(thread = {}) {
  return isCodexThread(thread) ? codexResumeCommandForThread(thread) : (thread.resumeCommand || '');
}

export async function openThreadInCodex(thread, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  if (!thread.appDeepLink) {
    throw new Error('Thread is missing a Codex deep link');
  }

  const { command, args } = openCommandForUrl(thread.appDeepLink, platform);
  await runCommand(command, args, { timeout: 5000 });
  return {
    opened: true,
    method: 'codex-deeplink',
    resumeCommand: codexResumeCommandForThread(thread),
  };
}
