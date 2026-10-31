// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/provider/Drivers/codexUsage.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// ASB keeps the token_count deltas and the model carried forward from turn_context. It drops the service tiers (ASB prices
// them at the standard rates), but tags a request above 200,000 or 272,000 input tokens. Records hold tokens only, never message text.
import { tierModel } from './usage-pricing.mjs';

const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens',
  'reasoning_output_tokens', 'total_tokens'];
const count = (value) => Number.isInteger(value) && value >= 0;

export function parseTimestampMs(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function validUsage(usage) {
  return USAGE_FIELDS.every((key) => count(usage[key]))
    && usage.cached_input_tokens + usage.cache_write_input_tokens <= usage.input_tokens
    && usage.reasoning_output_tokens <= usage.output_tokens
    && usage.total_tokens >= usage.input_tokens + usage.output_tokens;
}

function readCodexTokenUsage(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  const usage = {
    input_tokens: input,
    cached_input_tokens: value.cached_input_tokens === undefined ? 0 : value.cached_input_tokens,
    cache_write_input_tokens: value.cache_write_input_tokens === undefined ? 0 : value.cache_write_input_tokens,
    output_tokens: output,
    reasoning_output_tokens: value.reasoning_output_tokens === undefined ? 0 : value.reasoning_output_tokens,
    total_tokens: value.total_tokens === undefined ? input + output : value.total_tokens,
  };
  return validUsage(usage) ? usage : null;
}

const advanceCodexUsage = (previous, last) => readCodexTokenUsage(
  Object.fromEntries(USAGE_FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]])));

// token_count events carry no model, so the model comes from the most recent turn_context.
export function initialCodexScanState() {
  return { model: '', lastUsageSignature: null, lastCumulativeUsage: null, malformedRecords: 0, sawSessionMeta: false,
    suppressingForkCopies: false, forkCopyAnchorMs: 0 };
}

// The disk cache keeps this state so that a grown rollout resumes with the right model and counters.
export function validCodexScanState(state) {
  return typeof state === 'object' && state !== null && typeof state.model === 'string'
    && (state.lastUsageSignature === null || typeof state.lastUsageSignature === 'string')
    && (state.lastCumulativeUsage === null || readCodexTokenUsage(state.lastCumulativeUsage) !== null)
    && count(state.malformedRecords) && typeof state.sawSessionMeta === 'boolean'
    && typeof state.suppressingForkCopies === 'boolean' && Number.isFinite(state.forkCopyAnchorMs);
}

// Forks copy and restamp parent history in a burst (0-40ms gaps); genuine child usage follows a model turn (5s+ observed).
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload) {
  if (typeof payload.forked_from_id === 'string') return true;
  return typeof payload.source?.subagent?.thread_spawn?.parent_thread_id === 'string';
}

// Cumulative counters validate request deltas. Older events without cumulative counters use
// normalized consecutive-request deduplication.
// Records at or after options.tiersFromMs get the size tag of their request in the model name.
export function parseCodexLine(line, state, options = {}) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  return parseCodexRecord(parsed, state, options);
}

function parseCodexRecord(record, state, { tiersFromMs = Infinity } = {}) {
  if (typeof record !== 'object' || record === null) return null;
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return null;

  if (record.type === 'session_meta') {
    // Only the first meta identifies this session; copied ancestor metas would misattribute later records.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const metaTimestampMs = parseTimestampMs(record.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payload)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model;
    return null;
  }

  if (payload.type !== 'token_count') return null;
  const info = payload.info;
  if (typeof info !== 'object' || info === null) return null;

  // Codex may re-emit these counters after the model or timestamp becomes available.
  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null || state.model.length === 0) return null;

  const last = readCodexTokenUsage(info.last_token_usage);
  const rawCumulative = info.total_token_usage;
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCodexTokenUsage(rawCumulative) : null;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      // Copied history is already billed in the parent, but establishes the child's baseline.
      const signature = last === null ? null : JSON.stringify(last);
      if (cumulative !== null) state.lastCumulativeUsage = cumulative;
      else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
        state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, last);
      }
      state.lastUsageSignature = signature;
      return null;
    }
    state.suppressingForkCopies = false;
    state.lastUsageSignature = null;
  }

  const previous = state.lastCumulativeUsage;
  // A valid snapshot remains the next baseline even when its paired request is malformed.
  if (cumulative !== null) state.lastCumulativeUsage = cumulative;
  if (last === null || (hasCumulative && cumulative === null)) {
    state.malformedRecords += 1;
    return null;
  }

  // Zero-component counters report context size, not a request: fill_to_context_window, or the
  // post-compaction marker whose total is the new context size (its cumulative may reset to zero).
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return null;
  }

  if (cumulative !== null && previous !== null && USAGE_FIELDS.every((key) => cumulative[key] === previous[key])) return null;

  if (last.total_tokens !== last.input_tokens + last.output_tokens) {
    state.malformedRecords += 1;
    return null;
  }

  const signature = JSON.stringify(last);
  if (cumulative !== null) {
    // A session resumed in a new Codex process restarts its cumulative counters at this request.
    const restarted = USAGE_FIELDS.every((key) => cumulative[key] === last[key]);
    // Forks and paginated continuations can inherit totals without copying a counter snapshot.
    // Only bill the latest request, and require the unseen prefix to be valid usage too.
    const reconciled = previous === null
      ? readCodexTokenUsage(Object.fromEntries(USAGE_FIELDS.map((key) => [key, cumulative[key] - last[key]]))) !== null
      : USAGE_FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
    if (!restarted && !reconciled) {
      state.malformedRecords += 1;
      return null;
    }
  } else {
    if (signature === state.lastUsageSignature) return null;
    // Advance expected totals for billed legacy requests so a cumulative re-emission is stale.
    const advanced = advanceCodexUsage(previous, last);
    if (advanced === null) {
      state.malformedRecords += 1;
      return null;
    }
    state.lastCumulativeUsage = advanced;
  }
  state.lastUsageSignature = signature;

  // Codex reports input_tokens inclusive of the cached portion; output_tokens includes the reasoning tokens.
  const tokens = {
    uncached: last.input_tokens - last.cached_input_tokens - last.cache_write_input_tokens,
    cacheRead: last.cached_input_tokens,
    cacheWrite: last.cache_write_input_tokens,
    output: last.output_tokens,
  };
  if (tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output === 0) return null;
  const model = timestampMs >= tiersFromMs ? tierModel(state.model, last.input_tokens) : state.model;
  return { app: 'codex', timestampMs, model, tokens, dedupeKey: null };
}

export const codexUsageFormat = {
  app: 'codex',
  // Metadata lines carry the model and the fork state even without usage.
  markers: ['"token_count"', '"turn_context"', '"session_meta"'],
  initialState: initialCodexScanState,
  validState: validCodexScanState,
  parseLine: parseCodexLine,
};
