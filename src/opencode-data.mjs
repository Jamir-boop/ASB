import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { querySqliteJson, readBridgeMessages, SESSION_MESSAGE_WINDOW_MS } from './codex-data.mjs';

const MAX_THREADS = 5000;
const SCHEMA_WARNING = 'ASB reads OpenCode 2 sessions only. Update OpenCode.';
const SESSION_COLUMNS = ['id', 'parent_id', 'title', 'slug', 'directory', 'time_created', 'time_updated',
  'time_suspended', 'time_idle', 'idle_outcome', 'time_viewed', 'time_archived'];
const MESSAGE_COLUMNS = ['session_id', 'type', 'time_created', 'data'];
// shortcut: only shells started in the last 7 days count, so the query reads few rows; widen it if longer background shells matter.
const BACKGROUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LIFECYCLE_KINDS = { succeeded: 'task_complete', failed: 'failed', interrupted: 'turn_aborted' };
const cache = new Map();

// Must stay the same as opencodeBridgeId in bridge/src/opencode-host.ts.
export function opencodeBridgeId(sessionId) {
  const ns = Buffer.from('a5b8c9d0-1e2f-4a3b-8c7d-9e0f1a2b3c4d'.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(`opencode:${sessionId}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function defaultOpenCodeStateDir({ homeDir = os.homedir(), env = process.env } = {}) {
  return path.join(env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state'), 'opencode');
}

export function invalidateOpenCodeData() {
  cache.clear();
}

export function retainOpenCodeDataScopes(scopes) {
  for (const key of cache.keys()) if (!scopes.includes(key)) cache.delete(key);
}

const fileSignature = (info) => info ? `${info.mtimeMs}:${info.size}` : '';
const time = (value) => value == null ? null : Number(value);

async function schemaReady(databasePath, query) {
  const tables = new Set((await query(databasePath,
    "select name from sqlite_master where type = 'table' and name in ('session_v2', 'session_message');")).map((row) => row.name));
  if (!tables.has('session_v2') || !tables.has('session_message')) return false;
  const columns = async (table) => new Set((await query(databasePath, `pragma table_info(${table});`)).map((row) => row.name));
  const [session, message] = await Promise.all([columns('session_v2'), columns('session_message')]);
  return SESSION_COLUMNS.every((name) => session.has(name)) && MESSAGE_COLUMNS.every((name) => message.has(name));
}

function openCodeThread(row, subagents, activity, background = {}) {
  const idleAt = time(row.time_idle);
  const suspendedAt = time(row.time_suspended);
  const nativeUnread = idleAt == null ? null : idleAt > (time(row.time_viewed) ?? 0);
  return {
    id: row.id,
    externalId: row.id,
    provider: 'opencode',
    source: 'opencode-db',
    title: row.title || row.slug || '',
    cwd: row.directory || '',
    archived: row.time_archived != null,
    createdAtMs: Number(row.time_created || 0),
    // OpenCode moves time_updated with no turn, so use it only when message and idle times are absent.
    updatedAtMs: Math.max(idleAt || 0, activity || 0) || Number(row.time_updated || 0),
    // The dashboard counts listed children; OpenCode subagents are not listed.
    embeddedSubagentCount: Number(subagents.get(row.id) || 0),
    lifecycleRunning: suspendedAt != null,
    agentStartedAtMs: suspendedAt,
    agentActivityAtMs: activity || suspendedAt,
    latestLifecycleKind: LIFECYCLE_KINDS[row.idle_outcome] || '',
    latestLifecycleAtMs: idleAt,
    latestTaskEndedAtMs: idleAt,
    nativeUnread,
    readStatus: nativeUnread == null ? 'unknown' : nativeUnread ? 'unread' : 'read',
    ...(background.commands > 0 ? { backgroundCommands: background.commands } : {}),
    ...(background.agents > 0 ? { backgroundAgents: background.agents } : {}),
  };
}

// Reads session_v2, session_message times, and the ASB Bridge receiver view (peer ID, status, time, kind), never text or credentials.
export async function loadOpenCodeDashboard({ dataDir, stateDir = '', nowMs = Date.now(), maxCount = MAX_THREADS, cacheScope = '',
  query = querySqliteJson } = {}) {
  const databasePath = path.join(dataDir, 'opencode.db');
  const [main, wal] = await Promise.all([fs.stat(databasePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }), fs.stat(`${databasePath}-wal`).catch(() => null)]);
  if (!main) return { generatedAtMs: nowMs, provider: { installed: false, status: 'missing', message: '' }, threads: [] };
  const key = cacheScope || databasePath;
  // A WAL append does not change the main file.
  const signature = `${fileSignature(main)}|${fileSignature(wal)}`;
  const cached = cache.get(key);
  let result = cached?.signature === signature ? cached.result : null;
  if (!result) {
    if (!(await schemaReady(databasePath, query))) {
      result = { generatedAtMs: nowMs, provider: { installed: true, status: 'warning', message: SCHEMA_WARNING }, threads: [] };
    } else {
      const limit = Math.min(Math.max(Number.parseInt(maxCount, 10) || MAX_THREADS, 1), MAX_THREADS);
      const [roots, subagentRows, activityRows, backgroundRows] = await Promise.all([
        query(databasePath, `select id, title, slug, directory, time_created, time_updated,
          time_suspended, time_idle, idle_outcome, time_viewed, time_archived
          from session_v2 where parent_id is null order by time_updated desc limit ${limit};`),
        query(databasePath, `select parent_id, count(*) as n from session_v2
          where parent_id is not null group by parent_id;`),
        query(databasePath, `select coalesce(s.parent_id, s.id) as root, max(m.time_created) as at
          from session_message m join session_v2 s on s.id = m.session_id group by root;`),
        // json_each has its own `root` column, so the group uses the expression, not the alias.
        // Background shells (a shell tool part with input background and a shell ID, with no synthetic shell end of that ID) and
        // busy subagents (child sessions with time_suspended, the busy column of the roots), as counts per root, never text.
        // shortcut: ASB does not know whether OpenCode runs, so a shell of an OpenCode that quit with no end record counts until
        // the 7-day window passes; gate the counts by a live OpenCode signal when ASB gets one.
        query(databasePath, `select coalesce(s.parent_id, s.id) as root, 'commands' as kind, count(*) as n
          from session_message m join session_v2 s on s.id = m.session_id, json_each(m.data, '$.content') t
          where m.time_created >= ${Math.floor(nowMs - BACKGROUND_WINDOW_MS)} and m.type = 'assistant' and instr(m.data, '"shellID"') > 0
            and json_extract(t.value, '$.type') = 'tool' and json_extract(t.value, '$.name') = 'shell'
            and json_extract(t.value, '$.state.input.background') = 1 and json_extract(t.value, '$.state.metadata.shellID') is not null
            and not exists (select 1 from session_message e where e.session_id = m.session_id and e.type = 'synthetic'
              and instr(e.data, '"shellID"') > 0 and json_extract(e.data, '$.metadata.source') = 'shell'
              and json_extract(e.data, '$.metadata.shellID') = json_extract(t.value, '$.state.metadata.shellID'))
          group by coalesce(s.parent_id, s.id)
          union all
          select parent_id as root, 'agents' as kind, count(*) as n from session_v2
          where parent_id is not null and time_suspended is not null group by parent_id;`),
      ]);
      const subagents = new Map(subagentRows.map((row) => [row.parent_id, row.n]));
      const activity = new Map(activityRows.map((row) => [row.root, Number(row.at || 0)]));
      const background = new Map();
      for (const { root, kind, n } of backgroundRows) background.set(root, { ...background.get(root), [kind]: Number(n) });
      const threads = roots.map((row) => openCodeThread(row, subagents, activity.get(row.id), background.get(row.id)));
      result = { generatedAtMs: nowMs, provider: { installed: true, status: 'ready', message: '', threadCount: threads.length }, threads };
    }
    cache.set(key, { signature, result });
  }
  if (typeof stateDir === 'string' && stateDir && result.threads.length) {
    const incoming = new Map();
    for (const { to, from, atMs } of await readBridgeMessages(stateDir, nowMs - SESSION_MESSAGE_WINDOW_MS, cacheScope)) {
      if (!incoming.has(to)) incoming.set(to, []);
      incoming.get(to).push({ from, atMs });
    }
    if (!incoming.size) return result;
    return { ...result, threads: result.threads.map((thread) => {
      const messages = incoming.get(opencodeBridgeId(thread.externalId));
      return messages ? { ...thread, incomingMessages: messages } : thread;
    }) };
  }
  return result;
}
