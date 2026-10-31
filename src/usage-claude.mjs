// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/provider/Drivers/claudeUsage.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps message.usage and the key of one count per message and request ID. Records hold tokens only, never message text.
import { parseTimestampMs } from './usage-codex.mjs';

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = '<synthetic>';

export function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Claude Code writes one record per assistant content block, and every one of those records repeats the usage object of
// the parent message. The early records are written while the reply still streams, so their output count is partial.
// Summing them overcounts, so the scan keeps one record per dedupeKey with the larger counts.
export function parseClaudeLine(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(record) {
  if (typeof record !== 'object' || record === null || record.type !== 'assistant') return null;
  const message = record.message;
  if (typeof message !== 'object' || message === null) return null;
  const usage = message.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;
  const model = typeof message.model === 'string' ? message.model : '';
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return null;
  const messageId = typeof message.id === 'string' ? message.id : null;
  const requestId = typeof record.requestId === 'string' ? record.requestId : null;
  return {
    app: 'claude',
    timestampMs,
    model,
    tokens: {
      uncached: tokenCount(usage.input_tokens),
      cacheRead: tokenCount(usage.cache_read_input_tokens),
      cacheWrite: tokenCount(usage.cache_creation_input_tokens),
      // Anthropic folds thinking tokens into output.
      output: tokenCount(usage.output_tokens),
    },
    dedupeKey: messageId === null && requestId === null ? null : `${messageId ?? ''}:${requestId ?? ''}`,
  };
}

export const claudeUsageFormat = {
  app: 'claude',
  markers: ['"usage"'],
  initialState: () => null,
  validState: (state) => state === null,
  parseLine: parseClaudeLine,
};
