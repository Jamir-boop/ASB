// Ported from T3 Code (https://github.com/pingdotgg/t3code), packages/provider-pi/src/server/usage.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import { tokenCount } from './usage-claude.mjs';
import { parseTimestampMs } from './usage-codex.mjs';

const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.length > 0;

export function parsePiLine(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return []; }
  if (!object(entry) || !nonempty(entry.id)) return [];
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === 'message' ? entry.message : entry;
  let attributed = false;
  if (entry.type === 'message') {
    if (!object(source) || !['assistant', 'toolResult'].includes(source.role)) return [];
    attributed = source.role === 'assistant';
  } else if (entry.type === 'usage') attributed = true;
  else if (!['compaction', 'branch_summary'].includes(entry.type)) return [];
  if (attributed && (!nonempty(source.provider) || !nonempty(source.model)
    || (entry.type === 'message' && Object.hasOwn(source, 'responseModel') && !nonempty(source.responseModel)))) return [];
  const usage = source.usage;
  if (!object(usage)) return [];
  if (Object.hasOwn(usage, 'cost') && !object(usage.cost)) return [];
  // LiteLLM prices the bare model name, as T3 Code does; the provider stays in the dedupe key only.
  const model = attributed ? (entry.type === 'message' ? source.responseModel ?? source.model : source.model) : 'Tools/summaries';
  const keyModel = attributed ? `${source.provider}/${model}` : model;
  const tokens = { uncached: tokenCount(usage.input), cacheRead: tokenCount(usage.cacheRead),
    cacheWrite: tokenCount(usage.cacheWrite), output: tokenCount(usage.output) };
  if (!Object.values(tokens).some((count) => count > 0)) return [];
  return [{ app: 'pi', timestampMs, model, tokens, dedupeKey: JSON.stringify(['pi', entry.id, entry.timestamp, keyModel]) }];
}

export const piUsageFormat = {
  app: 'pi', markers: ['"usage"'], initialState: () => null,
  validState: (state) => state === null, parseLine: parsePiLine,
};
