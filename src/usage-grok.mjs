// Ported from T3 Code (https://github.com/pingdotgg/t3code), packages/provider-grok/src/server/usage.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import { tokenCount } from './usage-claude.mjs';

const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseGrokLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return []; }
  const params = record?.params;
  const update = params?.update;
  if (update?.sessionUpdate !== 'turn_completed' || !object(update.usage)) return [];
  let timestampMs = params?._meta?.agentTimestampMs;
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) {
    const at = record.timestamp;
    if (typeof at !== 'number' || !Number.isFinite(at)) return [];
    timestampMs = at > 1e12 ? at : at * 1000;
  }
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const promptId = typeof update.prompt_id === 'string' ? update.prompt_id : null;
  let entries = object(update.usage.modelUsage)
    ? Object.entries(update.usage.modelUsage).filter(([model, usage]) => model.length && object(usage)) : [];
  if (!entries.length) entries = [['grok', update.usage]];
  const records = [];
  for (const [model, usage] of entries) {
    const cacheRead = tokenCount(usage.cachedReadTokens);
    const cacheWrite = tokenCount(usage.cacheCreationTokens);
    const tokens = { uncached: Math.max(0, tokenCount(usage.inputTokens) - cacheRead - cacheWrite),
      cacheRead, cacheWrite, output: tokenCount(usage.outputTokens) };
    if (!Object.values(tokens).some((count) => count > 0)) continue;
    records.push({ app: 'grok', timestampMs, model, tokens,
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${model}` });
  }
  return records;
}

export const grokUsageFormat = {
  app: 'grok', markers: ['"turn_completed"'], initialState: () => null,
  validState: (state) => state === null, parseLine: parseGrokLine,
};
