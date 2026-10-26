// Token usage of OpenCode 2 from its database. The query selects only the token counts, the model, and the times
// with SQLite JSON functions: never the whole `data` value, which holds the message text.
import path from 'node:path';
import { querySqliteJson } from './codex-data.mjs';

const number = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0;

export function openCodeUsageSql(sinceMs) {
  const at = "coalesce(json_extract(data, '$.time.created'), time_created)";
  return `select json_extract(data, '$.tokens.input') as input, json_extract(data, '$.tokens.output') as output,
    json_extract(data, '$.tokens.reasoning') as reasoning, json_extract(data, '$.tokens.cache.read') as cache_read,
    json_extract(data, '$.tokens.cache.write') as cache_write,
    coalesce(json_extract(data, '$.model.modelID'), json_extract(data, '$.model.id'),
      case when json_type(data, '$.model') = 'text' then json_extract(data, '$.model') end) as model,
    ${at} as at
    from session_message where type = 'assistant' and json_type(data, '$.tokens') = 'object' and ${at} >= ${Math.trunc(sinceMs)};`;
}

// Records of the assistant messages created at sinceMs or later: { app, timestampMs, model, tokens, dedupeKey }.
export async function readOpenCodeUsage(dataDir, sinceMs, { query = querySqliteJson } = {}) {
  const rows = await query(path.join(dataDir, 'opencode.db'), openCodeUsageSql(sinceMs));
  const records = [];
  for (const row of rows) {
    const timestampMs = Number(row.at);
    if (!Number.isFinite(timestampMs) || typeof row.model !== 'string' || !row.model) continue;
    const tokens = { uncached: number(row.input), cacheRead: number(row.cache_read), cacheWrite: number(row.cache_write),
      output: number(row.output) + number(row.reasoning) };
    if (tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output === 0) continue;
    records.push({ app: 'opencode', timestampMs, model: row.model, tokens, dedupeKey: null });
  }
  return records;
}
