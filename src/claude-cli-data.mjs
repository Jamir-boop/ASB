// Claude Code CLI sessions: running sessions from the live registry, plus CLI transcripts with activity in the last 7 days.
// They are view-only cards. Titles come from the registry name or the title records, never from prompt text.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyLiveClaudeStatus, baseClaudeThread, claudeTitle, DEFAULT_CLAUDE_PROJECTS_DIR, DEFAULT_MAX_JSONL_BYTES,
  indexClaudeProjectFiles, mapWithConcurrency, projectNameFromCwd, readClaudeRootSignals, SIGNAL_CONCURRENCY } from './claude-data.mjs';
import { readLiveClaudeRegistry } from './claude-registry.mjs';

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadClaudeCliThreads({ projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR, desktopSessionIds = new Set(), nowMs = Date.now(),
  maxCount = 500, maxBytes = DEFAULT_MAX_JSONL_BYTES, cacheScope = '' } = {}) {
  const live = (await readLiveClaudeRegistry([path.join(path.dirname(projectsDir), 'sessions')]).catch(() => []))
    .filter((record) => record.entrypoint === 'cli');
  const liveById = new Map(live.map((record) => [record.sessionId, record]));
  const { files, subagentsBySession, agentLogs } = await indexClaudeProjectFiles(projectsDir)
    .catch(() => ({ files: new Map(), subagentsBySession: new Map(), agentLogs: new Map() }));
  // Root transcripts only: subagent and workflow logs are deeper in the project folder.
  const roots = [...files.values()].filter((entry) => path.dirname(path.dirname(entry.filePath)) === projectsDir)
    .map((entry) => ({ entry, sessionId: path.basename(entry.filePath, '.jsonl') }));
  const transcriptIds = new Set(roots.map((root) => root.sessionId));
  // The index does not refresh stats, so each candidate gets a current one.
  const candidates = (await Promise.all(roots.filter((root) => !desktopSessionIds.has(root.sessionId)).map(async (root) => (
    { ...root, mtimeMs: (await fs.stat(root.entry.filePath).catch(() => null))?.mtimeMs ?? -1 }))))
    .filter((root) => root.mtimeMs >= 0 && (nowMs - root.mtimeMs <= RECENT_MS || liveById.has(root.sessionId)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxCount);
  const read = await mapWithConcurrency(candidates, SIGNAL_CONCURRENCY, async (root) => ({ ...root,
    ...await readClaudeRootSignals(root.entry, subagentsBySession.get(root.entry.filePath), { maxBytes, nowMs, cacheScope }, agentLogs) }));
  const rows = read.filter((root) => root.signals.entrypoint === 'cli');
  for (const record of live) {
    if (!transcriptIds.has(record.sessionId) && !desktopSessionIds.has(record.sessionId)) {
      rows.push({ sessionId: record.sessionId, mtimeMs: 0, signals: null, subagentStats: null });
    }
  }
  const threads = rows.map(({ sessionId, mtimeMs, signals, subagentStats }) => {
    const record = liveById.get(sessionId);
    const cwd = record?.cwd || signals?.cwd || '';
    const title = claudeTitle(record?.name || signals?.customTitle || signals?.agentName || `Claude Code session ${sessionId.slice(0, 8)}`);
    const updatedAtMs = Math.max(Number(signals?.latestEventAtMs || 0), mtimeMs, Number(record?.startedAt || 0)) || nowMs;
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
    return applyLiveClaudeStatus(thread, live, nowMs);
  });
  return { threads };
}
