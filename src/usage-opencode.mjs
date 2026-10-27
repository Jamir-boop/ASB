// Ported in part from T3 Code (https://github.com/pingdotgg/t3code), packages/provider-opencode/src/server/usage.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// JSON functions select token counts, model, and time, never the whole message data.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { querySqliteJson } from './codex-data.mjs';
import { createYielder } from './usage-scan-cache.mjs';

const nativeSqlite = import('node:sqlite').catch(() => null);
// shortcut: node:sqlite is synchronous, so a page on a cold disk can still block the event loop for about 0.5 s; read in a worker thread if that matters.
export const OPENCODE_PAGE_ROWS = 64;
const number = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0;

export async function openCodeDatabases(dataDir) {
  const names = await fs.readdir(dataDir).catch(() => []);
  const files = [];
  for (const name of names.filter((name) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(name)).sort()) {
    const file = path.join(dataDir, name);
    if ((await fs.lstat(file).catch(() => null))?.isFile()) files.push(file);
  }
  return files.sort((a, b) => path.basename(a) === 'opencode.db' ? -1 : path.basename(b) === 'opencode.db' ? 1 : a < b ? -1 : a > b ? 1 : 0);
}

export function openCodeUsageSql(sinceMs, { table = 'session_message', timeCreated = true, paged = false } = {}) {
  const at = timeCreated ? "coalesce(json_extract(data, '$.time.created'), time_created)" : "json_extract(data, '$.time.created')";
  const role = table === 'session_message' ? "type = 'assistant'" : "json_extract(data, '$.role') = 'assistant'";
  return `select id, json_extract(data, '$.tokens.input') as input, json_extract(data, '$.tokens.output') as output,
    json_extract(data, '$.tokens.reasoning') as reasoning, json_extract(data, '$.tokens.cache.read') as cache_read,
    json_extract(data, '$.tokens.cache.write') as cache_write,
    coalesce(json_extract(data, '$.model.modelID'), json_extract(data, '$.model.id'), json_extract(data, '$.modelID'),
      case when json_type(data, '$.model') = 'text' then json_extract(data, '$.model') end) as model,
    ${at} as at
    from ${table} where ${role} and json_type(data, '$.tokens') = 'object' and ${at} >= ${Math.trunc(sinceMs)}${paged ? ' and rowid > ? and rowid <= ? order by rowid' : ''};`;
}

export async function readOpenCodeUsage(dataDir, sinceMs, { query = querySqliteJson,
  native = query === querySqliteJson ? nativeSqlite : null, open, pause = createYielder(), stats = {} } = {}) {
  const sqlite = await native;
  const records = [];
  const seen = new Set();
  const append = (rows) => {
    for (const row of rows) {
      const timestampMs = Number(row.at);
      if (!Number.isFinite(timestampMs) || timestampMs < sinceMs || typeof row.model !== 'string' || !row.model) continue;
      const tokens = { uncached: number(row.input), cacheRead: number(row.cache_read), cacheWrite: number(row.cache_write),
        output: number(row.output) + number(row.reasoning) };
      if (!Object.values(tokens).some((count) => count > 0)) continue;
      if (row.id !== null && row.id !== undefined && row.id !== '') {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
      }
      records.push({ app: 'opencode', timestampMs, model: row.model, tokens, dedupeKey: null });
    }
  };
  for (const file of await openCodeDatabases(dataDir)) {
    let database;
    try {
      if (sqlite?.DatabaseSync) {
        database = open ? open(file) : new sqlite.DatabaseSync(file, { readOnly: true });
        database.exec('PRAGMA busy_timeout = 100');
      }
      const all = (sql, ...params) => database ? database.prepare(sql).all(...params) : query(file, sql);
      for (const table of ['session_message', 'message']) {
        const columns = new Set((await all(`PRAGMA table_info(${table})`)).map((row) => row.name));
        if (!columns.size) continue;
        const sql = openCodeUsageSql(sinceMs, { table, timeCreated: columns.has('time_created'), paged: Boolean(database) });
        if (!database) { append(await all(sql)); continue; }
        const [range] = await all(`select min(rowid) as first, max(rowid) as last from ${table}`);
        if (typeof range?.first !== 'number' || typeof range.last !== 'number') continue;
        const statement = database.prepare(sql);
        for (let after = range.first - 1; after < range.last; after += OPENCODE_PAGE_ROWS) {
          append(statement.all(after, Math.min(after + OPENCODE_PAGE_ROWS, range.last)));
          stats.openCodePages = (stats.openCodePages || 0) + 1;
          await pause();
        }
      }
    } catch { /* An unreadable database does not hide the other databases. */ }
    finally { database?.close(); }
  }
  return records;
}
