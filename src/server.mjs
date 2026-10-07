import { createReadStream, watch } from 'node:fs';
import { mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CLAUDE_PROVIDER_IDS, getClaudeCacheStats, openClaudeThread } from './claude-data.mjs';
import { getCodexCacheStats, getCodexThreadArtifacts } from './codex-data.mjs';
import { loadDashboard as loadMissionControlDashboard } from './dashboard.mjs';
import { NotificationCenter } from './notifications.mjs';
import { openOpenCodeSession } from './opencode-data.mjs';
import { buildPendingSummary } from './pending-summary.mjs';
import { getReviewContentForThread } from './review-content.mjs';
import { createReviewJobStore } from './review-jobs.mjs';
import { buildReviewPrompt } from './review-prompts.mjs';
import { listReviewTargets, runReviewWithProvider } from './review-runners.mjs';
import { createSearchIndex } from './search-index.mjs';
import {
  DEFAULT_BAILIAN_QUOTA_CACHE_PATH,
  writeBailianQuotaSnapshot,
} from './bailian-quota-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const execFileAsync = promisify(execFile);
const PWA_APP_NAMES = [
  'Agent Mission Control.app',
  'Agent 任务控制台.app',
  'Agent 控制台.app',
];
const PWA_APP_SCRIPT_NAMES = [
  'Agent Mission Control',
  'Agent 任务控制台',
  'Agent 控制台',
];
const PWA_APP_DIRS = [
  path.join(os.homedir(), 'Applications', 'Chrome Apps.localized'),
  path.join(os.homedir(), 'Applications', 'Chrome Apps'),
  path.join(os.homedir(), 'Applications', 'Edge Apps.localized'),
  path.join(os.homedir(), 'Applications', 'Edge Apps'),
];
const DEFAULT_DASHBOARD_CACHE_TTL_MS = 10_000;
const DEFAULT_NOTIFICATION_CACHE_TTL_MS = 30_000;
const DEFAULT_PENDING_SUMMARY_DASHBOARD_MAX_AGE_MS = 120_000;
const DEFAULT_DASHBOARD_EVENT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS = 500;
const DEFAULT_SEARCH_INDEX_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_SEARCH_INDEX_THREAD_LIMIT = 5000;
const DEFAULT_SEARCH_INDEX_PROVIDER_LIMIT = 1000;
const DEFAULT_SEARCH_INDEX_ROLLOUT_LIMIT = 160;
const SEARCH_ARTIFACT_SUMMARY_LIMIT = 3;
const SEARCH_ARTIFACT_HYDRATION_CONCURRENCY = 6;
const DEFAULT_PROMPT_PACK_ROOT = path.join(os.homedir(), '.agent-mission-control', 'prompt-packs');
const MAX_PROMPT_PACK_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_LOCAL_PREVIEW_BYTES = 25 * 1024 * 1024;
const LOCAL_PREVIEW_IMAGE_TYPES = new Map([
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['text/html', '.html'],
  ['application/json', '.json'],
]);
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

export function defaultDashboardWatchPaths(homeDir = os.homedir()) {
  return [
    { path: path.join(homeDir, '.codex'), recursive: false },
    path.join(homeDir, '.codex', 'state_5.sqlite'),
    path.join(homeDir, '.codex', 'state_5.sqlite-wal'),
    path.join(homeDir, '.codex', 'session_index.jsonl'),
    { path: path.join(homeDir, '.codex', 'sessions'), recursive: true },
    { path: path.join(homeDir, '.codex', 'browser', 'sessions'), recursive: true },
    { path: path.join(homeDir, 'Library', 'Application Support', 'ai.opencode.desktop'), recursive: true },
    { path: path.join(homeDir, '.claude', 'projects'), recursive: true },
    {
      path: path.join(homeDir, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
      recursive: true,
    },
    {
      path: path.join(homeDir, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data'),
      recursive: false,
    },
    {
      path: path.join(homeDir, 'Library', 'Application Support', 'Cindy'),
      recursive: false,
    },
    {
      path: path.join(homeDir, 'Library', 'Application Support', 'kimi-desktop', 'kimi-agent'),
      recursive: false,
    },
    path.join(homeDir, '.agent-mission-control', 'bailian-quota.json'),
  ];
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendJsonWithHeaders(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function chromeExtensionOrigin(request) {
  const origin = String(request.headers.origin || '').trim();
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : '';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function durationSince(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}

function hitRatePercent(hits, misses) {
  const total = Number(hits || 0) + Number(misses || 0);
  if (!total) return null;
  return Math.round((Number(hits || 0) / total) * 100);
}

async function readJsonBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
  }

  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readBinaryBody(request, maxBytes = MAX_PROMPT_PACK_ATTACHMENT_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error('Prompt pack attachment is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function isCrossOriginLocalRequest(request) {
  const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return true;

  const origin = String(request.headers.origin || '').trim();
  if (!origin) return false;

  const host = String(request.headers.host || '').trim();
  if (!host) return true;

  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function rejectCrossOriginLocalRequest(request, response) {
  if (!isCrossOriginLocalRequest(request)) return false;
  sendJson(response, 403, { error: 'Cross-origin local file access is blocked' });
  return true;
}

function sendError(response, error, fallbackMessage = 'Request failed') {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  sendJson(response, statusCode, {
    error: error instanceof Error ? error.message : fallbackMessage,
  });
}

function openCommandForUrl(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function appleScriptString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function hideAppProcessByBundleIdScriptArgs(bundleId) {
  return [
    '-e',
    `set targetBundleId to "${appleScriptString(bundleId)}"`,
    '-e',
    'tell application "System Events"',
    '-e',
    'set visible of first application process whose bundle identifier is targetBundleId to false',
    '-e',
    'end tell',
  ];
}

function hideAppProcessByNameScriptArgs(appName) {
  return [
    '-e',
    `set targetBundleId to id of application "${appleScriptString(appName)}"`,
    '-e',
    'tell application "System Events"',
    '-e',
    'set visible of first application process whose bundle identifier is targetBundleId to false',
    '-e',
    'end tell',
  ];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function codexResumeCommandForThread(thread = {}) {
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

function resumeCommandForResponse(thread = {}) {
  return isCodexThread(thread) ? codexResumeCommandForThread(thread) : (thread.resumeCommand || '');
}

function terminalResumeScriptArgs(resumeCommand) {
  return [
    '-e',
    'tell application "Terminal"',
    '-e',
    'activate',
    '-e',
    `do script "${appleScriptString(resumeCommand)}"`,
    '-e',
    'end tell',
  ];
}

function terminalFocusScriptArgs(tty) {
  return [
    '-e',
    `set targetTTY to "${appleScriptString(tty)}"`,
    '-e',
    'tell application "Terminal"',
    '-e',
    'repeat with terminalWindow in windows',
    '-e',
    'repeat with terminalTab in tabs of terminalWindow',
    '-e',
    'if tty of terminalTab is targetTTY then',
    '-e',
    'try',
    '-e',
    'set miniaturized of terminalWindow to false',
    '-e',
    'end try',
    '-e',
    'set selected of terminalTab to true',
    '-e',
    'set index of terminalWindow to 1',
    '-e',
    'activate',
    '-e',
    'return "focused"',
    '-e',
    'end if',
    '-e',
    'end repeat',
    '-e',
    'end repeat',
    '-e',
    'end tell',
    '-e',
    'error "Terminal tab not found for " & targetTTY',
  ];
}

function looksLikeCodexCliProcess(command = '') {
  const text = String(command);
  return /(^|[\s/])codex(\s|$)/.test(text)
    || text.includes('/.local/bin/codex')
    || text.includes('@openai/codex')
    || text.includes('/codex-darwin-');
}

function parsePsProcessRows(stdout = '') {
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      const [, pid, ppid, tty, command] = match;
      return { pid, ppid, tty, command };
    })
    .filter(Boolean);
}

function normalizeTerminalTty(tty = '') {
  const text = String(tty).trim();
  if (!text || text === '??' || text === '?') return '';
  if (text.startsWith('/dev/')) return text;
  if (text.startsWith('tty')) return `/dev/${text}`;
  return `/dev/tty${text}`;
}

function lsofNameLines(stdout = '') {
  return String(stdout)
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

function lsofCwd(stdout = '') {
  const lines = String(stdout).split('\n');
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index] === 'fcwd' && lines[index + 1]?.startsWith('n')) {
      return lines[index + 1].slice(1);
    }
  }
  return '';
}

async function realpathOrSelf(value = '') {
  if (!value) return '';
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function lsofMatchesThread(stdout, thread, normalizedThreadCwd = '') {
  const id = String(thread.id || thread.externalId || '');
  const rolloutPath = String(thread.rolloutPath || '');
  const resolvedThreadCwd = thread.cwd ? path.resolve(thread.cwd) : '';
  const names = lsofNameLines(stdout);
  const exactNeedles = [rolloutPath, id].filter(Boolean);

  if (exactNeedles.some((needle) => names.some((name) => name.includes(needle)))) {
    return 'exact';
  }

  const cwd = lsofCwd(stdout);
  if (cwd && (path.resolve(cwd) === normalizedThreadCwd || path.resolve(cwd) === resolvedThreadCwd)) {
    return 'cwd';
  }

  return '';
}

function isRunningCodexCliThread(thread) {
  return thread?.status === 'running'
    || Number(thread?.currentTurnStartedAtMs || 0) > 0
    || Number(thread?.currentTurnElapsedMs || 0) > 0;
}

async function findRunningCodexTerminalTty(thread, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  if (platform !== 'darwin') return '';

  const { stdout } = await runCommand('ps', ['-axo', 'pid=,ppid=,tty=,command='], { timeout: 3000 });
  const candidates = parsePsProcessRows(stdout)
    .map((processRow) => ({
      ...processRow,
      tty: normalizeTerminalTty(processRow.tty),
    }))
    .filter((processRow) => processRow.tty && looksLikeCodexCliProcess(processRow.command));

  if (!candidates.length) return '';

  const normalizedThreadCwd = await realpathOrSelf(thread.cwd || '');
  const cwdMatches = new Set();

  for (const processRow of candidates) {
    let lsofOutput = '';
    try {
      const lsofResult = await runCommand('lsof', ['-p', processRow.pid, '-Fn'], {
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
      });
      lsofOutput = lsofResult.stdout || '';
    } catch {
      continue;
    }

    const match = lsofMatchesThread(lsofOutput, thread, normalizedThreadCwd);
    if (match === 'exact') return processRow.tty;
    if (match === 'cwd') cwdMatches.add(processRow.tty);
  }

  return cwdMatches.size === 1 ? [...cwdMatches][0] : '';
}

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // Try the next known app shim path.
    }
  }
  return '';
}

export async function findInstalledPwaApp({
  platform = process.platform,
  appDirs = PWA_APP_DIRS,
  appNames = PWA_APP_NAMES,
} = {}) {
  if (platform !== 'darwin') return '';

  const candidates = appDirs.flatMap((dir) => appNames.map((name) => path.join(dir, name)));
  return firstExistingPath(candidates);
}

export async function getInstalledPwaAppStatus(options = {}) {
  const appPath = await findInstalledPwaApp(options);
  return {
    installed: Boolean(appPath),
    method: appPath ? 'macos-pwa-app' : 'not-found',
  };
}

export async function openInstalledPwaApp({
  platform = process.platform,
  runCommand = execFileAsync,
  appDirs = PWA_APP_DIRS,
  appNames = PWA_APP_NAMES,
} = {}) {
  if (platform !== 'darwin') {
    const error = new Error('Installed PWA app opener is only supported on macOS');
    error.statusCode = 501;
    throw error;
  }

  const appPath = await findInstalledPwaApp({ platform, appDirs, appNames });
  if (!appPath) {
    const error = new Error('Installed Agent Mission Control app was not found');
    error.statusCode = 404;
    throw error;
  }

  await runCommand('open', [appPath], { timeout: 5000 });
  return { opened: true, method: 'macos-pwa-app' };
}

export async function hideInstalledPwaApp({
  platform = process.platform,
  runCommand = execFileAsync,
  appDirs = PWA_APP_DIRS,
  appNames = PWA_APP_NAMES,
  appScriptNames = PWA_APP_SCRIPT_NAMES,
} = {}) {
  if (platform !== 'darwin') {
    const error = new Error('Installed PWA app hider is only supported on macOS');
    error.statusCode = 501;
    throw error;
  }

  let installedAppError = null;
  const appPath = await findInstalledPwaApp({ platform, appDirs, appNames });
  if (appPath) {
    try {
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      const { stdout } = await runCommand('plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        plistPath,
      ], { timeout: 5000 });
      const bundleId = String(stdout || '').trim();
      if (!bundleId) {
        throw new Error('Installed PWA app bundle id was not found');
      }

      await runCommand('osascript', hideAppProcessByBundleIdScriptArgs(bundleId), { timeout: 5000 });
      return { hidden: true, method: 'macos-pwa-app' };
    } catch (error) {
      installedAppError = error;
    }
  }

  let lastError = null;
  for (const appName of appScriptNames) {
    try {
      await runCommand('osascript', hideAppProcessByNameScriptArgs(appName), { timeout: 5000 });
      return { hidden: true, method: 'macos-pwa-app' };
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error(
    installedAppError?.message
      || lastError?.message
      || 'Installed Agent Mission Control app window was not found',
  );
  error.statusCode = 404;
  throw error;
}

export const minimizeInstalledPwaApp = hideInstalledPwaApp;

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

export async function openThreadInCindy(thread, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  const deepLink = String(thread.appDeepLink || '');
  if (!deepLink.startsWith('cindy://session/')) {
    throw new Error('Cindy 线程缺少 session deep link');
  }

  const { command, args } = openCommandForUrl(deepLink, platform);
  await runCommand(command, args, { timeout: 5000 });
  return {
    opened: true,
    method: 'cindy-deeplink',
    resumeCommand: thread.resumeCommand || `open '${deepLink}'`,
  };
}

export async function openThreadInCodexCli(thread, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  const resumeCommand = codexResumeCommandForThread(thread);
  if (!resumeCommand) {
    throw new Error('Codex CLI 缺少 resume 命令');
  }

  if (platform === 'darwin') {
    const existingTerminalTty = await findRunningCodexTerminalTty(thread, { platform, runCommand }).catch(() => '');
    if (existingTerminalTty) {
      await runCommand('osascript', terminalFocusScriptArgs(existingTerminalTty), { timeout: 5000 });
      return {
        opened: true,
        method: 'codex-terminal-existing',
        resumeCommand,
      };
    }

    if (isRunningCodexCliThread(thread)) {
      return {
        opened: false,
        method: 'copy-command',
        resumeCommand,
      };
    }

    await runCommand('osascript', terminalResumeScriptArgs(resumeCommand), { timeout: 5000 });
    return {
      opened: true,
      method: 'codex-terminal',
      resumeCommand,
    };
  }

  return {
    opened: false,
    method: 'copy-command',
    resumeCommand,
  };
}

export async function openThreadInProvider(thread, options = {}) {
  if (thread.provider === 'cindy' || thread.frontend === 'cindy') {
    return openThreadInCindy(thread, options);
  }

  if (thread.provider === 'opencode') {
    return openOpenCodeSession(thread);
  }

  if (CLAUDE_PROVIDER_IDS.has(thread.provider)) {
    return openClaudeThread(thread, options);
  }

  if (thread.provider === 'codex-cli') {
    return openThreadInCodexCli(thread, options);
  }

  if (thread.provider === 'codex' && thread.appDeepLink) {
    return openThreadInCodex(thread, options);
  }

  if (thread.defaultOpenMode === 'codex-cli-resume' || (thread.provider === 'codex' && thread.resumeCommand)) {
    return openThreadInCodexCli(thread, options);
  }

  return openThreadInCodex(thread, options);
}

function safeStaticPath(publicDir, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  const resolved = path.resolve(publicDir, `.${decodedPath}`);
  if (!resolved.startsWith(publicDir)) return null;
  return resolved;
}

async function serveStatic(request, response, publicDir) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const filePath = safeStaticPath(publicDir, url.pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'content-type': MIME_TYPES.get(path.extname(filePath)) || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

function findDashboardThread(dashboard, threadId) {
  return dashboard.threads?.find((candidate) => candidate.id === threadId) || null;
}

function reviewSourceForThread(thread) {
  return {
    threadId: thread.id,
    provider: thread.provider || '',
    providerLabel: thread.providerLabel || thread.provider || 'Agent',
    title: thread.title || '',
    cwd: thread.cwd || '',
    projectName: thread.projectName || '',
    model: thread.model || '',
  };
}

function parseReviewLimit(value) {
  const limit = Number.parseInt(value || '50', 10);
  if (!Number.isFinite(limit) || limit < 1) return 50;
  return Math.min(limit, 200);
}

function parseSearchLimit(value) {
  const limit = Number.parseInt(value || '50', 10);
  if (!Number.isFinite(limit) || limit < 1) return 50;
  return Math.min(limit, 200);
}

function parseBooleanSearchParam(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function artifactTypeCounts(items = []) {
  const counts = {};
  for (const item of items) {
    if (!item?.type) continue;
    counts[item.type] = (counts[item.type] || 0) + 1;
  }
  return counts;
}

function artifactSummaryForSearch(artifacts = {}) {
  const items = Array.isArray(artifacts?.items) ? artifacts.items : [];
  const total = Number(artifacts?.total ?? items.length) || items.length;
  if (!total) return { total: 0, latestAtMs: null, typeCounts: {}, items: [] };

  return {
    total,
    latestAtMs: artifacts?.latestAtMs ?? items[0]?.atMs ?? null,
    typeCounts: artifacts?.typeCounts && typeof artifacts.typeCounts === 'object'
      ? artifacts.typeCounts
      : artifactTypeCounts(items),
    items: items.slice(0, SEARCH_ARTIFACT_SUMMARY_LIMIT),
  };
}

function shouldHydrateSearchArtifacts(thread = {}) {
  const provider = String(thread.provider || '');
  return Boolean(thread.rolloutPath)
    && provider.startsWith('codex')
    && Number(thread?.artifacts?.total || 0) <= 0;
}

async function hydrateCodexSearchArtifacts(result = {}, loadCodexThreadArtifacts) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const candidates = items.filter(shouldHydrateSearchArtifacts);
  if (!candidates.length) return result;

  let cursor = 0;
  const workerCount = Math.min(SEARCH_ARTIFACT_HYDRATION_CONCURRENCY, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const thread = candidates[cursor];
      cursor += 1;

      try {
        const loaded = await loadCodexThreadArtifacts({ thread });
        const summary = artifactSummaryForSearch(loaded?.artifacts);
        if (summary.total > 0) thread.artifacts = summary;
      } catch {
        // Search should stay useful even if one historical rollout disappeared or is malformed.
      }
    }
  });

  await Promise.all(workers);
  return result;
}

function normalizeLocalPreviewPath(value = '') {
  let text = String(value || '').trim();
  if (!text) return '';

  try {
    text = decodeURIComponent(text);
  } catch {
    // The query parser already decodes normal values; keep malformed input as-is.
  }
  text = text.replace(/^file:\/+/, '/');
  if (text.startsWith('~/')) {
    text = path.join(os.homedir(), text.slice(2));
  }

  if (!path.isAbsolute(text)) return '';
  return text;
}

function decodeHeaderValue(value = '') {
  const text = String(Array.isArray(value) ? value[0] || '' : value || '').trim();
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function promptPackIdFromPath(value = '') {
  const id = decodeHeaderValue(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(id)) {
    const error = new Error('Prompt pack id is invalid');
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function sanitizeAttachmentToken(value = '', fallback = 'attachment') {
  const token = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return token || fallback;
}

function extensionForAttachment(fileName = '', contentType = '') {
  const cleanName = String(fileName || '').replace(/\\/g, '/').split(/[?#]/)[0];
  const extension = cleanName.match(/\.([A-Za-z0-9]{1,12})$/)?.[0]?.toLowerCase() || '';
  if (extension) return extension;
  return CONTENT_TYPE_EXTENSIONS.get(String(contentType || '').split(';')[0].toLowerCase()) || '';
}

function sanitizeAttachmentFileName(fileName = '', contentType = '') {
  const decoded = decodeHeaderValue(fileName) || 'attachment';
  const cleanPath = decoded.replace(/\\/g, '/').split(/[?#]/)[0];
  const baseName = path.basename(cleanPath) || 'attachment';
  const extension = extensionForAttachment(baseName, contentType);
  const baseWithoutExtension = extension && baseName.toLowerCase().endsWith(extension)
    ? baseName.slice(0, -extension.length)
    : baseName;
  const safeBase = baseWithoutExtension
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/[\s._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase()
    || 'attachment';
  return `${safeBase}${extension}`;
}

function storedAttachmentFileName({
  attachmentId = '',
  fileName = '',
  contentType = '',
} = {}) {
  const safeAttachmentId = sanitizeAttachmentToken(attachmentId, 'A1');
  const safeFileName = sanitizeAttachmentFileName(fileName, contentType);
  return safeFileName.toLowerCase().startsWith(`${safeAttachmentId.toLowerCase()}-`)
    ? safeFileName
    : `${safeAttachmentId}-${safeFileName}`;
}

async function savePromptPackAttachment({
  promptPackRoot = DEFAULT_PROMPT_PACK_ROOT,
  packId,
  segmentId = '',
  attachmentId = '',
  fileName = '',
  contentType = '',
  content = Buffer.alloc(0),
} = {}) {
  const safePackId = promptPackIdFromPath(packId);
  const root = path.resolve(promptPackRoot);
  const packDir = path.resolve(root, safePackId);
  if (packDir !== root && !packDir.startsWith(`${root}${path.sep}`)) {
    const error = new Error('Prompt pack path is invalid');
    error.statusCode = 400;
    throw error;
  }

  const attachmentsDir = path.join(packDir, 'attachments');
  const safeAttachmentId = sanitizeAttachmentToken(attachmentId, 'A1');
  const safeSegmentId = sanitizeAttachmentToken(segmentId, '');
  const storedName = storedAttachmentFileName({
    attachmentId: safeAttachmentId,
    fileName,
    contentType,
  });
  const targetPath = path.join(attachmentsDir, storedName);

  await mkdir(attachmentsDir, { recursive: true });
  await writeFile(targetPath, content);

  return {
    packId: safePackId,
    segmentId: safeSegmentId,
    attachmentId: safeAttachmentId,
    fileName: storedName,
    contentType: String(contentType || 'application/octet-stream').split(';')[0],
    size: content.length,
    packDir,
    path: targetPath,
    relativePath: path.join('attachments', storedName),
  };
}

async function servePromptPackAttachment(request, response, packId, {
  promptPackRoot = DEFAULT_PROMPT_PACK_ROOT,
} = {}) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' });
    response.end('Method not allowed');
    return;
  }
  if (rejectCrossOriginLocalRequest(request, response)) return;

  try {
    const contentType = String(request.headers['content-type'] || 'application/octet-stream');
    const content = await readBinaryBody(request);
    const saved = await savePromptPackAttachment({
      promptPackRoot,
      packId,
      segmentId: decodeHeaderValue(request.headers['x-amc-segment-id']),
      attachmentId: decodeHeaderValue(request.headers['x-amc-attachment-id']),
      fileName: decodeHeaderValue(request.headers['x-amc-filename']) || 'attachment',
      contentType,
      content,
    });
    sendJson(response, 200, saved);
  } catch (error) {
    sendError(response, error, 'Failed to save prompt pack attachment');
  }
}

export async function openLocalFilePath(filePath, {
  platform = process.platform,
  runCommand = execFileAsync,
} = {}) {
  if (!filePath) throw new Error('Local file path is required');

  if (platform === 'darwin') {
    await runCommand('open', [filePath], { timeout: 5000 });
    return { opened: true, method: 'macos-open' };
  }

  if (platform === 'win32') {
    await runCommand('cmd', ['/c', 'start', '', filePath], { timeout: 5000 });
    return { opened: true, method: 'windows-start' };
  }

  await runCommand('xdg-open', [filePath], { timeout: 5000 });
  return { opened: true, method: 'xdg-open' };
}

export async function revealPathInFileManager(filePath, {
  platform = process.platform,
  runCommand = execFileAsync,
  isDirectory = false,
} = {}) {
  if (!filePath) throw new Error('Local path is required');

  if (platform === 'darwin') {
    await runCommand('open', ['-R', filePath], { timeout: 5000 });
    return { revealed: true, method: 'macos-finder' };
  }

  if (platform === 'win32') {
    await runCommand(
      'explorer.exe',
      isDirectory ? [filePath] : [`/select,${filePath}`],
      { timeout: 5000 },
    );
    return { revealed: true, method: 'windows-explorer' };
  }

  await runCommand('xdg-open', [isDirectory ? filePath : path.dirname(filePath)], { timeout: 5000 });
  return { revealed: true, method: 'xdg-open' };
}

export async function revealThreadInFileManager(thread, targetPath, options = {}) {
  return revealPathInFileManager(targetPath, options);
}

async function readFileHeader(filePath, length = 16) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function imageContentTypeFromHeader(filePath, header) {
  const extension = path.extname(filePath).toLowerCase();
  const extensionType = LOCAL_PREVIEW_IMAGE_TYPES.get(extension);
  if (!extensionType) return '';

  if (extensionType === 'image/png') {
    return header.length >= 8
      && header[0] === 0x89
      && header[1] === 0x50
      && header[2] === 0x4e
      && header[3] === 0x47
      && header[4] === 0x0d
      && header[5] === 0x0a
      && header[6] === 0x1a
      && header[7] === 0x0a
      ? extensionType
      : '';
  }

  if (extensionType === 'image/jpeg') {
    return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      ? extensionType
      : '';
  }

  if (extensionType === 'image/gif') {
    const prefix = header.subarray(0, 6).toString('ascii');
    return prefix === 'GIF87a' || prefix === 'GIF89a' ? extensionType : '';
  }

  if (extensionType === 'image/webp') {
    return header.length >= 12
      && header.subarray(0, 4).toString('ascii') === 'RIFF'
      && header.subarray(8, 12).toString('ascii') === 'WEBP'
      ? extensionType
      : '';
  }

  if (extensionType === 'image/bmp') {
    return header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d ? extensionType : '';
  }

  return '';
}

async function serveLocalFilePreview(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  if (rejectCrossOriginLocalRequest(request, response)) return;

  const requestedPath = normalizeLocalPreviewPath(url.searchParams.get('path') || '');
  if (!requestedPath) {
    sendJson(response, 400, { error: 'Local image path is required' });
    return;
  }

  try {
    const filePath = await realpath(requestedPath);
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    if (info.size > MAX_LOCAL_PREVIEW_BYTES) {
      sendJson(response, 413, { error: 'Local image is too large to preview' });
      return;
    }

    const contentType = imageContentTypeFromHeader(filePath, await readFileHeader(filePath));
    if (!contentType) {
      sendJson(response, 415, { error: 'Only local raster image previews are supported' });
      return;
    }

    response.writeHead(200, {
      'content-type': contentType,
      'content-length': info.size,
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

async function serveLocalFileOpen(request, response, {
  openLocalFile = openLocalFilePath,
} = {}) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' });
    response.end('Method not allowed');
    return;
  }
  if (rejectCrossOriginLocalRequest(request, response)) return;

  try {
    const body = await readJsonBody(request);
    const requestedPath = normalizeLocalPreviewPath(body.path || '');
    if (!requestedPath) {
      sendJson(response, 400, { error: 'Local file path is required' });
      return;
    }

    const filePath = await realpath(requestedPath);
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const result = await openLocalFile(filePath);
    sendJson(response, 200, {
      ...result,
      path: filePath,
    });
  } catch (error) {
    sendError(response, error, 'Failed to open local file');
  }
}

async function resolveThreadRevealTarget(thread = {}) {
  const requestedPath = normalizeLocalPreviewPath(thread.cwd || thread.rolloutPath || '');
  if (!requestedPath) {
    const error = new Error('Thread does not have a local path to reveal');
    error.statusCode = 422;
    throw error;
  }

  const filePath = await realpath(requestedPath);
  const info = await stat(filePath);
  if (!info.isFile() && !info.isDirectory()) {
    const error = new Error('Thread local path is not revealable');
    error.statusCode = 404;
    throw error;
  }

  return {
    path: filePath,
    isDirectory: info.isDirectory(),
  };
}

function threadNotFound(response) {
  sendJson(response, 404, { error: 'Thread not found' });
}

async function executeReviewJob({
  job,
  prompt,
  cwd,
  targetModel,
  runReview,
  reviewStore,
}) {
  try {
    const result = await runReview({
      provider: job.target.provider,
      prompt,
      cwd,
      model: targetModel,
    });

    if (result.ok) {
      await reviewStore.updateJob(job.id, {
        status: 'succeeded',
        completedAtMs: Date.now(),
        resultText: result.resultText || '',
        resultPreview: result.resultPreview || '',
        stderr: result.stderr || '',
        timedOut: Boolean(result.timedOut),
        truncatedResult: Boolean(result.truncatedResult),
        exitCode: result.exitCode ?? 0,
      });
      return;
    }

    await reviewStore.updateJob(job.id, {
      status: 'failed',
      completedAtMs: Date.now(),
      resultText: result.resultText || '',
      resultPreview: result.resultPreview || '',
      error: result.error || 'Review runner failed',
      stderr: result.stderr || '',
      timedOut: Boolean(result.timedOut),
      truncatedResult: Boolean(result.truncatedResult),
      exitCode: result.exitCode ?? null,
    });
  } catch (error) {
    await reviewStore.updateJob(job.id, {
      status: 'failed',
      completedAtMs: Date.now(),
      error: error instanceof Error ? error.message : 'Review runner failed',
    });
  }
}

export function createServer({
  switchboardOnly = false,
  markUnreadThread = null,
  markReadThread = null,
  setUnreadSettings = null,
  pinThread = null,
  loadDashboard = loadMissionControlDashboard,
  notificationCenter = null,
  monitorNotifications = false,
  notificationScanIntervalMs = 20_000,
  dashboardCacheTtlMs = positiveInteger(process.env.DASHBOARD_CACHE_TTL_MS, DEFAULT_DASHBOARD_CACHE_TTL_MS),
  dashboardWatchPaths = [],
  dashboardAdaptiveRefresh = false,
  dashboardSourceChanged = () => {},
  watchDashboardPath = watch,
  dashboardSetTimeout = setTimeout,
  dashboardClearTimeout = clearTimeout,
  dashboardEventMinIntervalMs = positiveInteger(
    process.env.DASHBOARD_EVENT_MIN_INTERVAL_MS,
    DEFAULT_DASHBOARD_EVENT_MIN_INTERVAL_MS,
  ),
  dashboardWatchDebounceMs = positiveInteger(
    process.env.DASHBOARD_WATCH_DEBOUNCE_MS,
    DEFAULT_DASHBOARD_WATCH_DEBOUNCE_MS,
  ),
  notificationCacheTtlMs = positiveInteger(process.env.NOTIFICATION_CACHE_TTL_MS, DEFAULT_NOTIFICATION_CACHE_TTL_MS),
  pendingSummaryDashboardMaxAgeMs = positiveInteger(
    process.env.PENDING_SUMMARY_DASHBOARD_MAX_AGE_MS,
    DEFAULT_PENDING_SUMMARY_DASHBOARD_MAX_AGE_MS,
  ),
  now = Date.now,
  openThread = openThreadInProvider,
  openLocalFile = openLocalFilePath,
  revealThread = revealThreadInFileManager,
  openInstalledApp = openInstalledPwaApp,
  hideInstalledApp = hideInstalledPwaApp,
  minimizeInstalledApp = hideInstalledApp,
  getInstalledAppStatus = getInstalledPwaAppStatus,
  reviewStore = createReviewJobStore(),
  runReview = runReviewWithProvider,
  loadReviewTargets = listReviewTargets,
  loadCodexThreadArtifacts = getCodexThreadArtifacts,
  publicDir = DEFAULT_PUBLIC_DIR,
  promptPackRoot = DEFAULT_PROMPT_PACK_ROOT,
  searchIndex = createSearchIndex(),
  searchIndexMaxAgeMs = positiveInteger(process.env.SEARCH_INDEX_MAX_AGE_MS, DEFAULT_SEARCH_INDEX_MAX_AGE_MS),
  searchIndexThreadLimit = positiveInteger(process.env.SEARCH_INDEX_THREAD_LIMIT, DEFAULT_SEARCH_INDEX_THREAD_LIMIT),
  searchIndexProviderLimit = positiveInteger(process.env.SEARCH_INDEX_PROVIDER_LIMIT, DEFAULT_SEARCH_INDEX_PROVIDER_LIMIT),
  searchIndexRolloutLimit = positiveInteger(process.env.SEARCH_INDEX_ROLLOUT_LIMIT, DEFAULT_SEARCH_INDEX_ROLLOUT_LIMIT),
  bailianQuotaCachePath = DEFAULT_BAILIAN_QUOTA_CACHE_PATH,
  saveBailianQuotaSnapshot = writeBailianQuotaSnapshot,
} = {}) {
  let dashboardLoadPromise = null;
  let notificationRefreshPromise = null;
  let searchIndexRebuildPromise = null;
  let dashboardCache = null;
  let notificationCache = null;
  const dashboardEventClients = new Set();
  const dashboardWatchers = [];
  let dashboardEventVersion = 0;
  let dashboardInvalidationTimer = null;
  let dashboardInvalidationReason = 'file-change';
  let dashboardLastEventAtMs = 0;
  let dashboardDirty = false;
  let dashboardGeneration = 0;
  let dashboardLastScanStartedAtMs = -Infinity;
  let dashboardRetryAfterMs = 0;
  let dashboardClosed = false;
  let dashboardWatchCoverage = false;
  let dashboardWatchRetryTimer = null;
  let dashboardWatchReconcilePromise = null;
  const adaptiveWatchers = new Map();
  const dashboardSourceHints = new Map();
  const dashboardSources = { codex: false, claude: false };
  const threadOpenPromises = new Map();
  const serverMetrics = {
    dashboardCacheHits: 0,
    dashboardCacheMisses: 0,
    dashboardCoalescedLoads: 0,
    dashboardLoadCount: 0,
    dashboardLoadErrors: 0,
    dashboardLastLoadMs: null,
    dashboardLastLoadedAtMs: null,
    dashboardSoftInvalidations: 0,
    dashboardHardInvalidations: 0,
    dashboardLastInvalidatedAtMs: null,
    notificationCacheHits: 0,
    notificationCacheMisses: 0,
    notificationCoalescedRefreshes: 0,
    notificationRefreshCount: 0,
    notificationRefreshErrors: 0,
    notificationLastRefreshMs: null,
    notificationLastRefreshedAtMs: null,
  };

  const performanceSnapshot = () => {
    const memory = process.memoryUsage();
    const dashboardCacheAgeMs = dashboardCache?.cachedAtMs ? Math.max(0, now() - dashboardCache.cachedAtMs) : null;
    const notificationCacheAgeMs = notificationCache?.cachedAtMs
      ? Math.max(0, now() - notificationCache.cachedAtMs)
      : null;
    const cacheTtlMs = dashboardAdaptiveRefresh ? dashboardWatchCoverage ? 5_000
      : dashboardCache?.dashboard?.refreshIntervalMs === 2_000 ? 2_000 : 5_000 : dashboardCacheTtlMs;

    return {
      generatedAtMs: now(),
      process: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      dashboard: {
        cacheTtlMs,
        cacheAgeMs: dashboardCacheAgeMs,
        cached: dashboardCacheAgeMs !== null && dashboardCacheAgeMs < cacheTtlMs,
        hits: serverMetrics.dashboardCacheHits,
        misses: serverMetrics.dashboardCacheMisses,
        hitRatePercent: hitRatePercent(
          serverMetrics.dashboardCacheHits,
          serverMetrics.dashboardCacheMisses,
        ),
        coalescedLoads: serverMetrics.dashboardCoalescedLoads,
        loadCount: serverMetrics.dashboardLoadCount,
        errorCount: serverMetrics.dashboardLoadErrors,
        lastLoadMs: serverMetrics.dashboardLastLoadMs,
        lastLoadedAtMs: serverMetrics.dashboardLastLoadedAtMs,
        dirty: dashboardDirty,
        ...(dashboardAdaptiveRefresh ? { watchCoverage: dashboardWatchCoverage } : {}),
        eventMinIntervalMs: dashboardEventMinIntervalMs,
        softInvalidations: serverMetrics.dashboardSoftInvalidations,
        hardInvalidations: serverMetrics.dashboardHardInvalidations,
        lastInvalidatedAtMs: serverMetrics.dashboardLastInvalidatedAtMs,
      },
      notifications: {
        cacheTtlMs: notificationCacheTtlMs,
        cacheAgeMs: notificationCacheAgeMs,
        cached: notificationCacheAgeMs !== null && notificationCacheAgeMs < notificationCacheTtlMs,
        hits: serverMetrics.notificationCacheHits,
        misses: serverMetrics.notificationCacheMisses,
        hitRatePercent: hitRatePercent(
          serverMetrics.notificationCacheHits,
          serverMetrics.notificationCacheMisses,
        ),
        coalescedRefreshes: serverMetrics.notificationCoalescedRefreshes,
        refreshCount: serverMetrics.notificationRefreshCount,
        errorCount: serverMetrics.notificationRefreshErrors,
        lastRefreshMs: serverMetrics.notificationLastRefreshMs,
        lastRefreshedAtMs: serverMetrics.notificationLastRefreshedAtMs,
      },
      caches: {
        codex: getCodexCacheStats(),
        claude: getClaudeCacheStats(),
      },
    };
  };

  const loadSharedDashboard = ({ force = false } = {}) => {
    const cachedAtMs = Number(dashboardCache?.cachedAtMs || 0);
    const cacheAgeMs = now() - cachedAtMs;
    const refreshIntervalMs = dashboardCache?.dashboard?.refreshIntervalMs === 2_000 ? 2_000 : 5_000;
    const cacheTtlMs = dashboardAdaptiveRefresh ? dashboardWatchCoverage ? 5_000 : refreshIntervalMs : dashboardCacheTtlMs;
    const clockExpired = dashboardAdaptiveRefresh && now() >= Number(dashboardCache?.dashboard?.nextStatusCheckAtMs || Infinity);
    const busyThrottled = dashboardAdaptiveRefresh && dashboardDirty && refreshIntervalMs === 2_000
      && now() - dashboardLastScanStartedAtMs < 2_000;
    const cacheValid = !clockExpired && (dashboardAdaptiveRefresh
      ? (!dashboardDirty && cacheAgeMs < cacheTtlMs) || busyThrottled : cacheAgeMs < cacheTtlMs);
    if (!force && dashboardCache?.dashboard && cacheAgeMs >= 0
      && (cacheValid || dashboardAdaptiveRefresh && now() < dashboardRetryAfterMs)) {
      serverMetrics.dashboardCacheHits += 1;
      return Promise.resolve(dashboardCache.dashboard);
    }

    if (!dashboardLoadPromise) {
      serverMetrics.dashboardCacheMisses += 1;
      const startedAtMs = Date.now();
      dashboardLastScanStartedAtMs = now();
      const generation = dashboardGeneration;
      const hints = [...dashboardSourceHints];
      dashboardSourceHints.clear();
      dashboardLoadPromise = Promise.resolve()
        .then(async () => {
          if (dashboardAdaptiveRefresh) {
            if (dashboardDirty) await reconcileAdaptiveWatchers();
            for (const [source, files] of hints) {
              for (const [filePath, index] of files) await dashboardSourceChanged(source, { filePath, index });
            }
          }
          return loadDashboard();
        })
        .then((dashboard) => {
          serverMetrics.dashboardLoadCount += 1;
          serverMetrics.dashboardLastLoadMs = durationSince(startedAtMs);
          serverMetrics.dashboardLastLoadedAtMs = now();
          dashboardCache = {
            dashboard,
            cachedAtMs: now(),
          };
          dashboardRetryAfterMs = 0;
          if (generation === dashboardGeneration) dashboardDirty = false;
          return dashboard;
        })
        .catch((error) => {
          if (dashboardAdaptiveRefresh) { dashboardDirty = true; dashboardRetryAfterMs = now() + 5_000; }
          serverMetrics.dashboardLoadErrors += 1;
          serverMetrics.dashboardLastLoadMs = durationSince(startedAtMs);
          throw error;
        })
        .finally(() => {
          dashboardLoadPromise = null;
          if (dashboardAdaptiveRefresh && dashboardDirty && !dashboardClosed) scheduleDashboardInvalidation('file-change');
        });
    } else {
      serverMetrics.dashboardCoalescedLoads += 1;
    }
    return dashboardLoadPromise;
  };

  const sendDashboardEvent = (response, event, payload) => {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const broadcastDashboardEvent = (event, payload) => {
    for (const client of dashboardEventClients) {
      sendDashboardEvent(client, event, payload);
    }
  };

  const invalidateDashboard = (reason = 'dashboard-change', { hard = true, dirty = true } = {}) => {
    if (dirty) dashboardDirty = true;
    if (hard) dashboardGeneration += 1;
    if (hard) {
      dashboardCache = null;
      notificationCache = null;
      serverMetrics.dashboardHardInvalidations += 1;
    } else {
      serverMetrics.dashboardSoftInvalidations += 1;
    }
    serverMetrics.dashboardLastInvalidatedAtMs = now();
    dashboardLastEventAtMs = now();
    dashboardEventVersion += 1;
    broadcastDashboardEvent('dashboard', dashboardAdaptiveRefresh ? {
      version: dashboardEventVersion,
      reason,
      sources: { ...dashboardSources },
    } : {
      version: dashboardEventVersion,
      reason,
      hard,
      observedAtMs: now(),
    });
    dashboardSources.codex = false;
    dashboardSources.claude = false;
  };

  const scheduleDashboardInvalidation = (reason = 'dashboard-change') => {
    dashboardDirty = true;
    dashboardInvalidationReason = reason;
    if (dashboardInvalidationTimer) return;

    if (dashboardAdaptiveRefresh) {
      const busy = dashboardCache?.dashboard?.refreshIntervalMs === 2_000;
      const delayMs = Math.max(dashboardWatchDebounceMs, dashboardRetryAfterMs - now(),
        busy ? 2_000 - (now() - dashboardLastScanStartedAtMs) : 0);
      dashboardInvalidationTimer = dashboardSetTimeout(() => {
        dashboardInvalidationTimer = null;
        if (dashboardClosed) return;
        if (dashboardLoadPromise) return;
        // One shared follow-up scan covers the burst before clients read the snapshot.
        if (dashboardCache && dashboardDirty && dashboardEventClients.size) {
          loadSharedDashboard().then(() => {
            if (!dashboardClosed) invalidateDashboard(dashboardInvalidationReason, { hard: false, dirty: false });
          }).catch(() => {
            if (!dashboardClosed) invalidateDashboard('source-unavailable', { hard: false });
          });
        } else invalidateDashboard(dashboardInvalidationReason, { hard: false, dirty: false });
      }, Math.max(0, delayMs));
      dashboardInvalidationTimer.unref?.();
      return;
    }

    const elapsedMs = dashboardLastEventAtMs
      ? Math.max(0, now() - dashboardLastEventAtMs)
      : Number.POSITIVE_INFINITY;
    const throttleDelayMs = Number.isFinite(elapsedMs)
      ? Math.max(0, dashboardEventMinIntervalMs - elapsedMs)
      : 0;
    const delayMs = Math.max(dashboardWatchDebounceMs, throttleDelayMs);
    dashboardInvalidationTimer = dashboardSetTimeout(() => {
      dashboardInvalidationTimer = null;
      invalidateDashboard(dashboardInvalidationReason, { hard: false });
    }, delayMs);
    dashboardInvalidationTimer.unref?.();
  };

  const createDashboardWatchers = async () => {
    for (const entry of dashboardWatchPaths || []) {
      const spec = typeof entry === 'string' ? { path: entry, recursive: false } : entry;
      const targetPath = spec?.path;
      if (!targetPath) continue;

      try {
        await stat(targetPath);
        const watcher = watchDashboardPath(targetPath, { recursive: Boolean(spec.recursive) }, () => {
          dashboardGeneration += 1;
          scheduleDashboardInvalidation('file-change');
        });
        watcher.on?.('error', () => {});
        dashboardWatchers.push(watcher);
      } catch {
        // Missing provider directories are expected when a provider is not installed.
      }
    }
  };

  const sourceChanged = (spec, event, rawFilename, targetPath = spec.path) => {
    if (dashboardClosed) return;
    const filename = rawFilename == null ? '' : String(rawFilename);
    if (spec.acceptEvent && !spec.acceptEvent(filename, event)) return;
    const filePath = filename ? path.resolve(targetPath, filename) : '';
    if (filename && (path.isAbsolute(filename) || path.relative(targetPath, filePath).startsWith('..'))) return;
    dashboardGeneration += 1;
    if (['codex', 'claude'].includes(spec.source)) {
      dashboardSources[spec.source] = true;
      let files = dashboardSourceHints.get(spec.source);
      if (!files) dashboardSourceHints.set(spec.source, files = new Map());
      if (!files.has('')) {
        // A large burst needs one provider index check, with no unbounded filename queue.
        if (!filePath || files.size >= 128) { files.clear(); files.set('', true); }
        else files.set(filePath, files.get(filePath) || event === 'rename');
      }
    }
    scheduleDashboardInvalidation('file-change');
  };

  const reconcileAdaptiveWatchers = () => {
    if (dashboardWatchReconcilePromise || dashboardClosed) return dashboardWatchReconcilePromise;
    dashboardWatchReconcilePromise = (async () => {
      const desired = new Set();
      let covered = Boolean(dashboardWatchPaths?.length);
      const attach = async (targetPath, spec, recursive) => {
        if (dashboardClosed) return false;
        const info = await stat(targetPath);
        if (dashboardClosed) return false;
        desired.add(targetPath);
        const signature = `${info.dev}:${info.ino}`;
        const previous = adaptiveWatchers.get(targetPath);
        if (previous?.signature === signature) return true;
        previous?.watcher.close?.();
        adaptiveWatchers.delete(targetPath);
        const watcher = watchDashboardPath(targetPath, { recursive }, (event, filename) => sourceChanged(spec, event, filename, targetPath));
        adaptiveWatchers.set(targetPath, { watcher, signature });
        watcher.on?.('error', () => {
          if (adaptiveWatchers.get(targetPath)?.watcher !== watcher) return;
          watcher.close?.();
          adaptiveWatchers.delete(targetPath);
          dashboardWatchCoverage = false;
          sourceChanged(spec, 'rename', null);
        });
        return true;
      };
      const attachDirectories = async (targetPath, spec) => {
        await attach(targetPath, spec, false);
        const entries = await readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) if (entry.isDirectory()) await attachDirectories(path.join(targetPath, entry.name), spec);
      };
      for (const entry of dashboardWatchPaths || []) {
        const spec = typeof entry === 'string' ? { path: entry } : entry;
        if (!spec?.path) continue;
        try {
          if (spec.recursive && spec.manualRecursive) await attachDirectories(spec.path, spec);
          else {
            try { await attach(spec.path, spec, Boolean(spec.recursive)); }
            catch (error) {
              if (!spec.recursive || !['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'ERR_FEATURE_UNAVAILABLE', 'ERR_INVALID_ARG_VALUE'].includes(error.code)) throw error;
              spec.manualRecursive = true;
              await attachDirectories(spec.path, spec);
            }
          }
        } catch (error) {
          if (!(spec.optional && error.code === 'ENOENT')) covered = false;
        }
      }
      for (const [targetPath, entry] of adaptiveWatchers) {
        if (!desired.has(targetPath) || dashboardClosed) { entry.watcher.close?.(); adaptiveWatchers.delete(targetPath); }
      }
      dashboardWatchCoverage = !dashboardClosed && covered;
    })().finally(() => { dashboardWatchReconcilePromise = null; });
    return dashboardWatchReconcilePromise;
  };

  const retryAdaptiveWatchers = async () => {
    try { await reconcileAdaptiveWatchers(); } catch { dashboardWatchCoverage = false; }
    if (dashboardClosed) return;
    dashboardWatchRetryTimer = dashboardSetTimeout(retryAdaptiveWatchers, 5_000);
    dashboardWatchRetryTimer.unref?.();
  };

  const dashboardForRequest = async (options = {}) => {
    const dashboard = await loadSharedDashboard(options);
    return {
      ...dashboard,
      summary: { ...(dashboard.summary || {}) },
    };
  };

  const dashboardForPendingSummary = () => {
    const cachedAtMs = Number(dashboardCache?.cachedAtMs || 0);
    const cacheAgeMs = now() - cachedAtMs;
    if (
      dashboardCache?.dashboard
      && cacheAgeMs >= 0
      && cacheAgeMs <= pendingSummaryDashboardMaxAgeMs
    ) {
      serverMetrics.dashboardCacheHits += 1;
      return Promise.resolve(dashboardCache.dashboard);
    }

    return loadSharedDashboard();
  };

  const openThreadOnce = (thread) => {
    const threadKey = `${thread.provider || 'codex'}:${thread.id || thread.externalId || ''}`;
    if (!threadOpenPromises.has(threadKey)) {
      threadOpenPromises.set(
        threadKey,
        Promise.resolve()
          .then(() => openThread(thread))
          .finally(() => {
            threadOpenPromises.delete(threadKey);
          }),
      );
    }

    return threadOpenPromises.get(threadKey);
  };

  const rebuildSearchIndex = async () => {
    if (!searchIndexRebuildPromise) {
      searchIndexRebuildPromise = (async () => {
        const dashboard = await loadDashboard({
          limit: searchIndexThreadLimit,
          openCodeMaxCount: searchIndexProviderLimit,
          claudeMaxCount: searchIndexProviderLimit,
          maxRollouts: searchIndexRolloutLimit,
        });
        return searchIndex.indexDashboard(dashboard);
      })().finally(() => {
        searchIndexRebuildPromise = null;
      });
    }

    return searchIndexRebuildPromise;
  };

  const ensureSearchIndex = async ({ force = false } = {}) => {
    const current = await searchIndex.status();
    const indexedAtMs = Number(current?.indexedAtMs || 0);
    const ageMs = indexedAtMs ? now() - indexedAtMs : Number.POSITIVE_INFINITY;

    if (
      !force
      && current?.available
      && !current.needsRebuild
      && indexedAtMs > 0
      && ageMs >= 0
      && ageMs < searchIndexMaxAgeMs
    ) {
      return current;
    }

    await rebuildSearchIndex();
    return searchIndex.status();
  };

  const findThreadForAction = async (threadId) => {
    const dashboard = await dashboardForRequest();
    let thread = dashboard.threads?.find((candidate) => candidate.id === threadId);
    if (thread) return thread;
    if (switchboardOnly) return null;

    const indexed = await searchIndex.searchThreads({
      query: threadId,
      includeArchived: true,
      limit: 5,
    }).catch(() => null);
    thread = indexed?.items?.find((candidate) => candidate.id === threadId) || null;
    return thread;
  };

  const notificationsForDashboard = async (dashboard, { force = false } = {}) => {
    if (!notificationCenter) return null;

    const cachedAtMs = Number(notificationCache?.cachedAtMs || 0);
    const cacheAgeMs = now() - cachedAtMs;
    if (!force && notificationCache?.notifications && cacheAgeMs >= 0 && cacheAgeMs < notificationCacheTtlMs) {
      serverMetrics.notificationCacheHits += 1;
      return notificationCache.notifications;
    }

    if (!notificationRefreshPromise) {
      serverMetrics.notificationCacheMisses += 1;
      const startedAtMs = Date.now();
      notificationRefreshPromise = Promise.resolve()
        .then(() => notificationCenter.refresh(dashboard))
        .then((notifications) => {
          serverMetrics.notificationRefreshCount += 1;
          serverMetrics.notificationLastRefreshMs = durationSince(startedAtMs);
          serverMetrics.notificationLastRefreshedAtMs = now();
          notificationCache = {
            notifications,
            cachedAtMs: now(),
          };
          return notifications;
        })
        .catch((error) => {
          serverMetrics.notificationRefreshErrors += 1;
          serverMetrics.notificationLastRefreshMs = durationSince(startedAtMs);
          throw error;
        })
        .finally(() => {
          notificationRefreshPromise = null;
        });
    } else {
      serverMetrics.notificationCoalescedRefreshes += 1;
    }
    return notificationRefreshPromise;
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (switchboardOnly) {
      const address = server.address();
      const expectedHost = `127.0.0.1:${address?.port}`;
      if (request.headers.host !== expectedHost) {
        sendJson(response, 403, { error: 'Use the local ASB address.' });
        return;
      }
      const localAction = url.pathname.match(/^\/api\/threads\/([^/]+)\/(mark-unread|mark-read|pin|unpin|move-pin)$/);
      const unreadSettingsRoute = url.pathname === '/api/settings/unread';
      const eventRoute = url.pathname === '/api/events';
      const actionRoute = /^\/api\/threads\/[^/]+\/open$/.test(url.pathname) || Boolean(localAction) || unreadSettingsRoute;
      const staticRoutes = ['/', '/switchboard.html', '/switchboard.js', '/switchboard.css', '/icon.svg'];
      const readRoute = url.pathname === '/api/dashboard' || eventRoute || staticRoutes.includes(url.pathname);
      if (!readRoute && !actionRoute) {
        sendJson(response, 404, { error: 'Route is not available in ASB.' });
        return;
      }
      if ((readRoute && request.method !== 'GET') || (actionRoute && request.method !== 'POST')) {
        response.writeHead(405, { allow: actionRoute ? 'POST' : 'GET' });
        response.end('Method not allowed');
        return;
      }
      if (actionRoute && (request.headers.origin !== `http://${expectedHost}`
        || !['same-origin', undefined].includes(request.headers['sec-fetch-site']))) {
        sendJson(response, 403, { error: 'Use session actions from ASB.' });
        return;
      }
      if (eventRoute && ((request.headers.origin && request.headers.origin !== `http://${expectedHost}`)
        || !['same-origin', 'none', undefined].includes(request.headers['sec-fetch-site']))) {
        sendJson(response, 403, { error: 'Use the local ASB event stream.' });
        return;
      }
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (unreadSettingsRoute) {
        try {
          const body = await readJsonBody(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'persistentUnread'
            || typeof body.persistentUnread !== 'boolean') {
            sendJson(response, 400, { error: 'Invalid ASB unread setting.' });
            return;
          }
          const dashboard = dashboardCache?.dashboard || await loadSharedDashboard();
          await setUnreadSettings(body.persistentUnread, dashboard);
          invalidateDashboard('asb-unread-settings');
          sendJson(response, 200, { changed: true, persistentUnread: body.persistentUnread, dashboard });
        } catch (error) {
          sendJson(response, error.statusCode || 500, { error: 'Cannot update the ASB unread setting.' });
        }
        return;
      }
      if (localAction) {
        try {
          const body = await readJsonBody(request);
          const action = localAction[2];
          const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : 'invalid';
          const validMove = fields === 'direction' && ['up', 'down'].includes(body.direction)
            || fields === 'placement,targetId' && typeof body.targetId === 'string' && ['before', 'after'].includes(body.placement);
          if ((action === 'move-pin' && !validMove) || (action !== 'move-pin' && fields !== '')) {
            sendJson(response, 400, { error: 'Invalid ASB session action.' });
            return;
          }
          const thread = await findThreadForAction(decodeURIComponent(localAction[1]));
          if (!thread) { threadNotFound(response); return; }
          if (action === 'mark-unread') {
            await markUnreadThread(thread);
            invalidateDashboard('asb-unread', { hard: false, dirty: false });
            sendJson(response, 200, { marked: true, threadId: thread.id, thread });
          } else if (action === 'mark-read') {
            await markReadThread(thread);
            invalidateDashboard('asb-read', { hard: false, dirty: false });
            sendJson(response, 200, { changed: true, threadId: thread.id, thread });
          } else {
            if (body.targetId && !await findThreadForAction(body.targetId)) { threadNotFound(response); return; }
            const pinnedOrder = await pinThread(thread, action, body);
            invalidateDashboard('asb-pins');
            sendJson(response, 200, { changed: true, threadId: thread.id, pinnedOrder });
          }
        } catch (error) {
          sendJson(response, error.statusCode || 500, { error: 'Cannot update this ASB session.' });
        }
        return;
      }
      if (url.pathname === '/') request.url = '/switchboard.html';
    }

    if (url.pathname === '/api/model-services/bailian-snapshot') {
      const origin = chromeExtensionOrigin(request);
      if (!origin) {
        sendJson(response, 403, { error: 'Only the local Bailian Chrome bridge is allowed' });
        return;
      }
      const corsHeaders = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
        vary: 'Origin',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders);
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { ...corsHeaders, allow: 'POST, OPTIONS' });
        response.end('Method not allowed');
        return;
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        sendJsonWithHeaders(response, 415, { error: 'Content-Type must be application/json' }, corsHeaders);
        return;
      }

      try {
        const body = await readJsonBody(request);
        const saved = await saveBailianQuotaSnapshot(
          bailianQuotaCachePath,
          body,
          { nowMs: now() },
        );
        invalidateDashboard('bailian-quota-bridge');
        sendJsonWithHeaders(response, 202, {
          accepted: true,
          observedAtMs: saved.snapshot.observedAtMs,
        }, corsHeaders);
      } catch (error) {
        sendJsonWithHeaders(response, Number(error?.statusCode) || 400, {
          error: error instanceof Error ? error.message : 'Invalid Bailian quota snapshot',
        }, corsHeaders);
      }
      return;
    }

    if (url.pathname === '/api/events') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      response.write('\n');
      dashboardEventClients.add(response);
      sendDashboardEvent(response, 'connected', dashboardAdaptiveRefresh ? {
        version: dashboardEventVersion, reason: 'connected', sources: { codex: false, claude: false },
      } : {
        version: dashboardEventVersion,
        observedAtMs: now(),
      });
      request.on('close', () => {
        dashboardEventClients.delete(response);
      });
      return;
    }

    if (url.pathname === '/api/dashboard') {
      try {
        const force = parseBooleanSearchParam(url.searchParams.get('force'))
          || parseBooleanSearchParam(url.searchParams.get('refresh'));
        const dashboard = await dashboardForRequest({ force });
        if (notificationCenter) {
          dashboard.notifications = await notificationsForDashboard(dashboard, { force });
          dashboard.summary = {
            ...dashboard.summary,
            inboxCount: dashboard.notifications.summary.activeCount,
          };
        }
        dashboard.performance = performanceSnapshot();
        sendJson(response, 200, dashboard);
      } catch (error) {
        sendJson(response, 500, {
          error: 'Failed to load dashboard data',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === '/api/notifications') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' });
        response.end('Method not allowed');
        return;
      }

      if (!notificationCenter) {
        sendJson(response, 503, { error: 'Notification center is not configured' });
        return;
      }

      try {
        const force = url.searchParams.get('force') === '1';
        const dashboard = await dashboardForRequest({ force });
        const notifications = await notificationsForDashboard(dashboard, { force });
        sendJson(response, 200, notifications);
      } catch (error) {
        sendError(response, error, 'Failed to load notifications');
      }
      return;
    }

    if (url.pathname === '/api/pending-summary') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        const dashboard = await dashboardForPendingSummary();
        const notifications = notificationCenter
          ? await notificationsForDashboard(dashboard)
          : dashboard.notifications || {
            summary: { activeCount: dashboard.summary?.inboxCount ?? dashboard.inbox?.length ?? 0 },
            items: dashboard.inbox || [],
          };

        sendJson(response, 200, buildPendingSummary(notifications, Date.now(), dashboard));
      } catch (error) {
        sendError(response, error, 'Failed to load pending summary');
      }
      return;
    }

    if (url.pathname === '/api/performance') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      sendJson(response, 200, performanceSnapshot());
      return;
    }

    if (url.pathname === '/api/local-file-preview') {
      await serveLocalFilePreview(request, response, url);
      return;
    }

    if (url.pathname === '/api/local-file-open') {
      await serveLocalFileOpen(request, response, { openLocalFile });
      return;
    }

    const promptPackAttachmentMatch = url.pathname.match(/^\/api\/prompt-packs\/([^/]+)\/attachments$/);
    if (promptPackAttachmentMatch) {
      await servePromptPackAttachment(request, response, promptPackAttachmentMatch[1], { promptPackRoot });
      return;
    }

    const artifactMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/artifacts$/);
    if (artifactMatch) {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        const threadId = decodeURIComponent(artifactMatch[1]);
        const dashboard = await dashboardForRequest();
        const thread = findDashboardThread(dashboard, threadId);
        sendJson(response, 200, await loadCodexThreadArtifacts({ thread }));
      } catch (error) {
        sendError(response, error, 'Failed to load thread artifacts');
      }
      return;
    }

    if (url.pathname === '/api/search/status') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        sendJson(response, 200, await searchIndex.status());
      } catch (error) {
        sendError(response, error, 'Failed to load search index status');
      }
      return;
    }

    if (url.pathname === '/api/search/reindex') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end('Method not allowed');
        return;
      }

      try {
        const result = await rebuildSearchIndex();
        sendJson(response, 200, {
          ...(await searchIndex.status()),
          ...result,
        });
      } catch (error) {
        sendError(response, error, 'Failed to rebuild search index');
      }
      return;
    }

    if (url.pathname === '/api/search') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        const force = parseBooleanSearchParam(url.searchParams.get('force'));
        let indexStatus = await ensureSearchIndex({ force });
        const searchParams = {
          query: url.searchParams.get('q') || url.searchParams.get('query') || '',
          provider: url.searchParams.get('provider') || 'all',
          status: url.searchParams.get('status') || 'all',
          project: url.searchParams.get('project') || 'all',
          includeArchived: parseBooleanSearchParam(url.searchParams.get('archived'))
            || parseBooleanSearchParam(url.searchParams.get('includeArchived')),
          includeSubagents: parseBooleanSearchParam(url.searchParams.get('subagents'))
            || parseBooleanSearchParam(url.searchParams.get('includeSubagents')),
          includeAutomations: parseBooleanSearchParam(url.searchParams.get('automations'))
            || parseBooleanSearchParam(url.searchParams.get('includeAutomations')),
          limit: parseSearchLimit(url.searchParams.get('limit')),
          cursor: url.searchParams.get('cursor') || '',
        };
        let result = await searchIndex.searchThreads(searchParams);
        if (!force && searchParams.query.trim() && Number(result.total || 0) === 0) {
          indexStatus = await ensureSearchIndex({ force: true });
          result = await searchIndex.searchThreads(searchParams);
        }
        result = await hydrateCodexSearchArtifacts(result, loadCodexThreadArtifacts);
        sendJson(response, 200, {
          ...result,
          index: indexStatus,
        });
      } catch (error) {
        sendError(response, error, 'Failed to search threads');
      }
      return;
    }

    if (url.pathname === '/api/projects/history') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        await ensureSearchIndex({
          force: parseBooleanSearchParam(url.searchParams.get('force')),
        });
        sendJson(response, 200, await searchIndex.projectHistory({
          limit: parseSearchLimit(url.searchParams.get('limit')),
          query: url.searchParams.get('q') || url.searchParams.get('query') || '',
        }));
      } catch (error) {
        sendError(response, error, 'Failed to load project history');
      }
      return;
    }

    const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
    if (notificationMatch) {
      if (request.method !== 'PATCH') {
        response.writeHead(405, { allow: 'PATCH' });
        response.end('Method not allowed');
        return;
      }

      if (!notificationCenter) {
        sendJson(response, 503, { error: 'Notification center is not configured' });
        return;
      }

      try {
        const body = await readJsonBody(request);
        const id = decodeURIComponent(notificationMatch[1]);
        const updated = await notificationCenter.updateNotification(id, body);
        invalidateDashboard('notification-update');
        sendJson(response, 200, updated);
      } catch (error) {
        sendError(response, error, 'Failed to update notification');
      }
      return;
    }

    if (url.pathname === '/api/review-targets') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        sendJson(response, 200, await loadReviewTargets());
      } catch (error) {
        sendError(response, error, 'Failed to load review targets');
      }
      return;
    }

    const reviewContentMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/review-content$/);
    if (reviewContentMatch) {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        const threadId = decodeURIComponent(reviewContentMatch[1]);
        const dashboard = await loadDashboard();
        const thread = findDashboardThread(dashboard, threadId);
        const content = await getReviewContentForThread({
          thread,
          mode: url.searchParams.get('mode') || 'latest-agent-signal',
        });
        sendJson(response, 200, content);
      } catch (error) {
        sendError(response, error, 'Failed to load review content');
      }
      return;
    }

    if (url.pathname === '/api/reviews') {
      if (request.method === 'GET') {
        try {
          const jobs = await reviewStore.listJobs({
            limit: parseReviewLimit(url.searchParams.get('limit')),
            threadId: url.searchParams.get('threadId') || undefined,
          });
          sendJson(response, 200, jobs);
        } catch (error) {
          sendError(response, error, 'Failed to list review jobs');
        }
        return;
      }

      if (request.method === 'POST') {
        try {
          const body = await readJsonBody(request);
          const sourceThreadId = String(body.sourceThreadId || '');
          if (!sourceThreadId) {
            sendJson(response, 400, { error: 'sourceThreadId is required' });
            return;
          }

          const targetProvider = String(body.targetProvider || '');
          if (!targetProvider) {
            sendJson(response, 400, { error: 'targetProvider is required' });
            return;
          }

          const targets = await loadReviewTargets();
          const target = targets.items?.find((candidate) => candidate.provider === targetProvider);
          if (!target || !target.available) {
            sendJson(response, 422, { error: 'Selected review target is not available' });
            return;
          }

          const dashboard = await loadDashboard();
          const thread = findDashboardThread(dashboard, sourceThreadId);
          const content = await getReviewContentForThread({
            thread,
            mode: body.inputMode || 'latest-agent-signal',
          });

          const source = reviewSourceForThread(thread);
          const templateId = body.templateId || 'technical-review';
          const prompt = buildReviewPrompt({
            templateId,
            source,
            content: content.content,
            customReviewInstruction: body.customReviewInstruction,
          });
          const queued = await reviewStore.createJob({
            source,
            target: {
              provider: target.provider,
              label: target.label,
              runner: target.runner,
              model: body.targetModel || '',
            },
            templateId,
            inputMode: content.mode,
            inputPreview: content.preview,
          });
          const running = await reviewStore.updateJob(queued.id, {
            status: 'running',
            startedAtMs: Date.now(),
          });

          void executeReviewJob({
            job: running,
            prompt,
            cwd: thread.cwd || process.cwd(),
            targetModel: body.targetModel || '',
            runReview,
            reviewStore,
          });

          sendJson(response, 202, { job: running });
        } catch (error) {
          sendError(response, error, 'Failed to create review job');
        }
        return;
      }

      response.writeHead(405, { allow: 'GET, POST' });
      response.end('Method not allowed');
      return;
    }

    const reviewJobMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
    if (reviewJobMatch) {
      if (request.method !== 'GET' && request.method !== 'PATCH') {
        response.writeHead(405, { allow: 'GET, PATCH' });
        response.end('Method not allowed');
        return;
      }

      try {
        const id = decodeURIComponent(reviewJobMatch[1]);
        if (request.method === 'PATCH') {
          const body = await readJsonBody(request);
          sendJson(response, 200, { job: await reviewStore.updateJob(id, { fixLoop: body.fixLoop }) });
          return;
        }

        sendJson(response, 200, { job: await reviewStore.getJob(id) });
      } catch (error) {
        sendError(response, error, 'Failed to load review job');
      }
      return;
    }

    if (url.pathname === '/api/notification-settings') {
      sendJson(response, 410, {
        error: 'Desktop notifications are disabled',
        detail: 'Desktop notification delivery is hidden until a reliable native notifier is available.',
      });
      return;
    }

    if (url.pathname === '/api/notification-test') {
      sendJson(response, 410, {
        error: 'Desktop notifications are disabled',
        detail: 'Desktop notification delivery is hidden until a reliable native notifier is available.',
      });
      return;
    }

    if (url.pathname === '/api/app/installed') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end('Method not allowed');
        return;
      }

      try {
        const status = await getInstalledAppStatus();
        sendJson(response, 200, status);
      } catch (error) {
        sendError(response, error, 'Failed to check installed app');
      }
      return;
    }

    if (url.pathname === '/api/app/open-installed') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end('Method not allowed');
        return;
      }

      try {
        const result = await openInstalledApp();
        sendJson(response, 200, result);
      } catch (error) {
        sendError(response, error, 'Failed to open installed app');
      }
      return;
    }

    if (url.pathname === '/api/app/hide-installed' || url.pathname === '/api/app/minimize-installed') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end('Method not allowed');
        return;
      }

      try {
        const result = url.pathname === '/api/app/minimize-installed'
          ? await minimizeInstalledApp()
          : await hideInstalledApp();
        sendJson(response, 200, result);
      } catch (error) {
        sendError(response, error, 'Failed to hide installed app');
      }
      return;
    }

    const openThreadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/open$/);
    if (openThreadMatch) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end('Method not allowed');
        return;
      }

      try {
        const body = await readJsonBody(request);
        const threadId = decodeURIComponent(openThreadMatch[1]);
        const thread = await findThreadForAction(threadId);

        if (!thread) {
          threadNotFound(response);
          return;
        }

        const result = await openThreadOnce(thread);
        const notification = body.markNotificationDone && body.notificationId && notificationCenter
          ? await notificationCenter.updateNotification(String(body.notificationId), { status: 'done' })
          : null;
        if (notification) invalidateDashboard('notification-update');
        sendJson(response, 200, {
          ...result,
          threadId: thread.id,
          provider: thread.provider || 'codex',
          appDeepLink: thread.appDeepLink,
          resumeCommand: resumeCommandForResponse(thread),
          ...(notification ? { notification } : {}),
        });
      } catch (error) {
        sendJson(response, 500, {
          error: 'Failed to open thread',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const revealThreadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/reveal$/);
    if (revealThreadMatch) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end('Method not allowed');
        return;
      }
      if (rejectCrossOriginLocalRequest(request, response)) return;

      try {
        const threadId = decodeURIComponent(revealThreadMatch[1]);
        const thread = await findThreadForAction(threadId);

        if (!thread) {
          threadNotFound(response);
          return;
        }

        const target = await resolveThreadRevealTarget(thread);
        const result = await revealThread(thread, target.path, { isDirectory: target.isDirectory });
        sendJson(response, 200, {
          ...result,
          threadId: thread.id,
          path: target.path,
        });
      } catch (error) {
        sendError(response, error, 'Failed to reveal thread');
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }

    await serveStatic(request, response, publicDir);
  });

  if (dashboardAdaptiveRefresh && dashboardWatchPaths?.length) {
    server.once('listening', retryAdaptiveWatchers);
  } else if (dashboardWatchPaths?.length) {
    createDashboardWatchers().catch((error) => {
      console.warn('Dashboard watcher setup failed:', error instanceof Error ? error.message : String(error));
    });
  }

  const closeDashboardResources = () => {
    dashboardClosed = true;
    if (dashboardInvalidationTimer) dashboardClearTimeout(dashboardInvalidationTimer);
    if (dashboardWatchRetryTimer) dashboardClearTimeout(dashboardWatchRetryTimer);
    for (const watcher of dashboardWatchers) watcher.close?.();
    for (const entry of adaptiveWatchers.values()) entry.watcher.close?.();
    adaptiveWatchers.clear();
    for (const client of dashboardEventClients) client.end();
    dashboardEventClients.clear();
  };
  server.once('close', closeDashboardResources);
  if (dashboardAdaptiveRefresh) {
    const close = server.close.bind(server);
    server.close = (...args) => { closeDashboardResources(); return close(...args); };
  }

  if (monitorNotifications && notificationCenter) {
    let firstScan = true;
    const scan = async () => {
      try {
        const dashboard = await dashboardForRequest();
        await notificationsForDashboard(dashboard);
        firstScan = false;
      } catch (error) {
        console.warn('Notification scan failed:', error instanceof Error ? error.message : String(error));
      }
    };
    const timer = setInterval(scan, notificationScanIntervalMs);
    timer.unref?.();
    server.once('close', () => clearInterval(timer));
    scan();
  }

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT || '4629', 10);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({
    notificationCenter: new NotificationCenter(),
    monitorNotifications: false,
    dashboardWatchPaths: defaultDashboardWatchPaths(),
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Agent Mission Control: http://${host}:${actualPort}`);
  });
}
