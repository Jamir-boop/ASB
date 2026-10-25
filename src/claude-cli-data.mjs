// Claude Code CLI sessions: running sessions from the live registry, plus CLI transcripts with activity in the last 7 days.
// They are view-only cards. Titles come from the registry name or the title records, never from prompt text.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyLiveClaudeStatus, baseClaudeThread, claudeTitle, currentClaudeRoot, DEFAULT_CLAUDE_PROJECTS_DIR, DEFAULT_MAX_JSONL_BYTES,
  indexClaudeProjectFiles, liveClaudeRecord, mapWithConcurrency, projectNameFromCwd, readClaudeRootSignals, SIGNAL_CONCURRENCY } from './claude-data.mjs';
import { readLiveClaudeRegistry } from './claude-registry.mjs';

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
// A new or switched session writes its transcript a moment before its registry record names it, so a turn this recent does not show that the process ended.
const PROCESS_START_GRACE_MS = 10_000;

export async function loadClaudeCliThreads({ projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR, desktopSessionIds = new Set(), nowMs = Date.now(),
  maxCount = 500, maxBytes = DEFAULT_MAX_JSONL_BYTES, cacheScope = '' } = {}) {
  const registryDir = path.join(path.dirname(projectsDir), 'sessions');
  // `registry` is null when no registry shows which processes live: an old CLI has no folder, only Linux has a reader, and a read can fail.
  const registry = process.platform === 'linux' && await fs.stat(registryDir).then((info) => info.isDirectory(), () => false)
    ? await readLiveClaudeRegistry([registryDir]).catch(() => null) : null;
  const live = (registry || []).filter((record) => record.entrypoint === 'cli');
  const liveById = new Map(live.map((record) => [record.sessionId, record]));
  const projectIndex = await indexClaudeProjectFiles(projectsDir)
    .catch(() => ({ files: new Map(), subagentsBySession: new Map(), agentLogs: new Map() }));
  const { files, rootCopies, subagentsBySession, agentLogs } = projectIndex;
  // Root transcripts only: subagent and workflow logs are deeper in the project folder.
  const roots = [...files.values()].filter((entry) => path.dirname(path.dirname(entry.filePath)) === projectsDir)
    .map((entry) => ({ entry, sessionId: path.basename(entry.filePath, '.jsonl') }));
  const transcriptIds = new Set(roots.map((root) => root.sessionId));
  // The index does not refresh stats, so each candidate gets a current one.
  const candidates = (await Promise.all(roots.filter((root) => !desktopSessionIds.has(root.sessionId)).map(async (root) => {
    // A session with a copy in more than one project folder uses the newest copy, which has a current stat.
    const copy = rootCopies?.has(root.sessionId) ? await currentClaudeRoot(projectIndex, root.sessionId) : null;
    return { ...root, entry: copy || root.entry,
      mtimeMs: (copy?.stat || await fs.stat(root.entry.filePath).catch(() => null))?.mtimeMs ?? -1 };
  })))
    .filter((root) => root.mtimeMs >= 0 && (nowMs - root.mtimeMs <= RECENT_MS || liveById.has(root.sessionId)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxCount);
  const read = await mapWithConcurrency(candidates, SIGNAL_CONCURRENCY, async (root) => ({ ...root,
    ...await readClaudeRootSignals(root.entry, subagentsBySession.get(root.entry.filePath), { maxBytes, nowMs, cacheScope }, agentLogs) }));
  // A resume or copy can refresh the file time without a turn in the last 7 days.
  const rows = read.filter((root) => root.signals.entrypoint === 'cli'
    && (liveById.has(root.sessionId) || nowMs - (root.signals.latestEventAtMs || root.mtimeMs) <= RECENT_MS));
  for (const record of live) {
    if (!transcriptIds.has(record.sessionId) && !desktopSessionIds.has(record.sessionId)) {
      rows.push({ sessionId: record.sessionId, mtimeMs: 0, signals: null, subagentStats: null });
    }
  }
  const threads = rows.map(({ sessionId, mtimeMs, signals, subagentStats }) => {
    const record = liveById.get(sessionId);
    const cwd = record?.cwd || signals?.cwd || '';
    const title = claudeTitle(record?.name || signals?.customTitle || signals?.agentName || `Claude Code session ${sessionId.slice(0, 8)}`);
    // A resume writes records with no turn, so the file time and the process start are only fallbacks.
    const updatedAtMs = Number(signals?.latestEventAtMs || 0) || Math.max(mtimeMs, Number(record?.startedAt || 0)) || nowMs;
    const thread = baseClaudeThread({
      id: `cli:${sessionId}`,
      externalId: sessionId,
      provider: 'claude-desktop-code',
      providerLabel: 'Claude Code CLI',
      source: 'claude-cli',
      title,
      cwd,
      projectName: projectNameFromCwd(cwd, 'Claude Code CLI'),
      model: signals?.model,
      archived: false,
      createdAtMs: Number(signals?.oldestEventAtMs || 0) || Number(record?.startedAt || 0) || nowMs,
      updatedAtMs,
      signals,
      canOpen: false,
      extra: {
        surface: 'cli',
        cliSessionId: sessionId,
        priorCliSessionIds: [],
        incomingMessages: (signals?.lifecycle?.messages || []).map((message) => ({ ...message })),
        limitResetsAtMs: Number(signals?.lifecycle?.limitResetsAtMs || 0),
        bridgeSessionIds: record?.bridgeSessionId ? [record.bridgeSessionId] : [],
        transcriptActivityAtMs: Number(signals?.latestEventAtMs || 0) || null,
        embeddedSubagentCount: Number(subagentStats?.count || 0),
        embeddedSubagentUpdatedAtMs: Number(subagentStats?.updatedAtMs || 0) || null,
        cliNoTranscript: !signals,
      },
    }, nowMs);
    const row = applyLiveClaudeStatus(thread, live, nowMs);
    // An open task with no live process of the session (of any entrypoint) means that the process ended during the task.
    return registry && row.lifecycleRunning === true && !liveClaudeRecord(row, registry)
      && nowMs - Number(row.transcriptActivityAtMs || 0) > PROCESS_START_GRACE_MS ? { ...row, cliProcessEnded: true } : row;
  });
  return { threads };
}
