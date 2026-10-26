// Ported from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/provider/Drivers/antigravityUsageReader.ts and AntigravityUsage.ts, commit 3cb16cf. MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createYielder } from './usage-scan-cache.mjs';

const nativeSqlite = import('node:sqlite').catch(() => null);

export function expandHome(value, homeDir) {
  if (value === '~') return homeDir;
  return /^~[/\\]/.test(value) ? path.join(homeDir, value.slice(2)) : value;
}

export async function antigravityRoots(env, homeDir) {
  const configured = env.ANTIGRAVITY_DATA_DIR?.split(',').map((value) => value.trim()).filter(Boolean);
  const defaults = ['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup']
    .map((name) => path.join(homeDir, '.gemini', name));
  defaults.push(path.join(homeDir, '.config', 'antigravity'));
  const roots = new Set();
  for (const root of configured?.length ? configured : defaults) {
    try {
      const canonical = await fs.realpath(path.resolve(expandHome(root, homeDir)));
      if (!(await fs.stat(canonical)).isDirectory()) continue;
      const conversations = path.join(canonical, 'conversations');
      roots.add(await fs.realpath((await fs.stat(conversations).catch(() => null))?.isDirectory() ? conversations : canonical));
    } catch { /* Missing roots have no usage. */ }
  }
  return [...roots];
}

function fields(bytes) {
  let offset = 0;
  const result = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error('Invalid Antigravity protobuf varint');
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw new Error('Invalid Antigravity protobuf varint');
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== 'number') throw new Error('Invalid protobuf field');
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!number) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== 'number' || length > bytes.length - offset) throw new Error('Invalid protobuf field length');
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else throw new Error('Unsupported protobuf wire type');
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value, key) => typeof value.get(key)?.[0] === 'number' ? value.get(key)[0] : 0;
const bytesAt = (value, key) => value.get(key)?.[0] instanceof Uint8Array ? value.get(key)[0] : undefined;
const nested = (value, key) => bytesAt(value, key) === undefined ? new Map() : fields(bytesAt(value, key));
const textAt = (value, key) => bytesAt(value, key) === undefined ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytesAt(value, key)).trim();
const timestamp = (value) => numberAt(value, 1) > 0 ? numberAt(value, 1) * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;

const MODEL_IDS = {
  246: 'gemini-2.5-pro', 312: 'gemini-2.5-flash', 313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking', 330: 'gemini-2.5-flash-lite',
  281: 'claude-sonnet-4', 282: 'claude-sonnet-4', 290: 'claude-opus-4', 291: 'claude-opus-4',
  333: 'claude-sonnet-4-5', 334: 'claude-sonnet-4-5', 340: 'claude-haiku-4-5', 341: 'claude-haiku-4-5',
  1026: 'claude-opus-4-6', 1035: 'claude-sonnet-4-6', 1016: 'gemini-3.1-pro',
  1036: 'gemini-3.1-pro', 1037: 'gemini-3.1-pro', 1018: 'gemini-3-flash-preview',
  1084: 'gemini-3-flash-preview', 1047: 'gemini-3-flash-preview',
};

function modelName(name, id) {
  if (name) {
    const normalized = name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replaceAll(' ', '-');
    return normalized.startsWith('claude-')
      ? normalized.replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, 'claude-$2-$1').replaceAll('.', '-') : normalized;
  }
  return MODEL_IDS[id] ?? (id > 0 ? `antigravity-model-${id}` : '');
}

function metadata(bytes, step) {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) throw new Error('Missing Antigravity generation metadata');
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usage = bytesAt(data, step ? 9 : 4);
  // Copies prevent usage fields from holding each whole metadata blob in memory.
  const usages = usage === undefined ? [] : [fields(usage.slice())];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error('Invalid retry metadata');
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) usages.push(fields(retryUsage.slice()));
  }
  return {
    model: modelName(textAt(model, step ? 12 : 19) || textAt(model, step ? 8 : 21), numberAt(model, step ? 1 : 3)),
    timestampMs: step ? timestamp(nested(data, 8)) ?? timestamp(nested(data, 1)) : timestamp(nested(nested(data, 9), 4)),
    usages,
  };
}

function blob(value) {
  if (!(value instanceof Uint8Array)) throw new Error('Invalid Antigravity metadata blob');
  return value;
}

function usageCandidates(generations, steps, trajectoryTimestamp, fallbackTimestamp) {
  const records = [];
  const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry.model]));
  for (const [source, entries] of [['step', steps], ['generation', generations]]) {
    for (const { idx, entry } of entries) {
      for (const usage of entry.usages) {
        const tokens = { uncached: numberAt(usage, 2), cacheRead: numberAt(usage, 5), cacheWrite: numberAt(usage, 4),
          output: Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10)) };
        if (!Object.values(tokens).some((count) => count > 0)) continue;
        const keys = [11, 12, 7].flatMap((key) => {
          const id = textAt(usage, key);
          return id ? [`antigravity:${key}:${id}`] : [];
        });
        records.push({
          record: { app: 'antigravity', timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
            model: MODEL_IDS[numberAt(usage, 1)] || entry.model || (source === 'step' ? generationModels.get(idx) : '')
              || modelName('', numberAt(usage, 1)) || 'antigravity-unknown', tokens, dedupeKey: null },
          keys, timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
        });
      }
    }
  }
  return records;
}

async function readDatabase(database, fallbackTimestamp, pause) {
  let committed = false;
  database.exec('PRAGMA busy_timeout = 100');
  database.exec('BEGIN');
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('gen_metadata') && !tables.has('steps')) throw new Error('Missing Antigravity tables');
    const readMetadata = async (table, column, pageRows, step) => {
      if (!tables.has(table)) return [];
      const entries = [];
      const query = database.prepare(`SELECT rowid AS row_id, idx, ${column} AS data FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
      let after = -Infinity;
      while (true) {
        const rows = query.all(after, pageRows);
        for (const row of rows) {
          if (step && row.data === null) continue;
          if (typeof row.idx !== 'number') throw new Error('Invalid Antigravity index');
          entries.push({ idx: row.idx, entry: metadata(blob(row.data), step) });
        }
        if (rows.length < pageRows) break;
        after = rows.at(-1).row_id;
        await pause();
      }
      return entries.sort((a, b) => a.idx - b.idx);
    };
    const generations = await readMetadata('gen_metadata', 'data', 1, false);
    let trajectoryTimestamp = null;
    if (tables.has('trajectory_metadata_blob')) {
      for (const row of database.prepare('SELECT data FROM trajectory_metadata_blob').iterate()) {
        trajectoryTimestamp ??= timestamp(nested(fields(blob(row.data)), 2));
      }
    }
    const steps = await readMetadata('steps', 'metadata', 64, true);
    const candidates = usageCandidates(generations, steps, trajectoryTimestamp, fallbackTimestamp);
    database.exec('COMMIT');
    committed = true;
    return candidates;
  } finally { if (!committed) database.exec('ROLLBACK'); }
}

export async function readAntigravityUsage(roots, sinceMs, { cache = new Map(), native = nativeSqlite,
  open, pause = createYielder() } = {}) {
  const sqlite = await native;
  // shortcut: Antigravity needs node:sqlite (Node.js 22.5 or later); without it ASB reads no Antigravity usage.
  if (!sqlite?.DatabaseSync) return [];
  const identities = new Map();
  const groups = [];
  const find = (index) => {
    let root = index;
    while (groups[root].parent !== root) root = groups[root].parent;
    while (index !== root) {
      const parent = groups[index].parent;
      groups[index].parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left, right) => {
    let a = find(left), b = find(right);
    if (a === b) return;
    if (groups[a].size < groups[b].size) [a, b] = [b, a];
    const target = groups[a], source = groups[b];
    const first = target.owner < source.owner ? target : source;
    const bestTime = source.timestampQuality > target.timestampQuality
      || (source.timestampQuality === target.timestampQuality && source.record.timestampMs < target.record.timestampMs) ? source : target;
    const tokens = Object.fromEntries(Object.keys(target.record.tokens).map((key) => [key, Math.max(target.record.tokens[key], source.record.tokens[key])]));
    target.record = { ...first.record, model: first.record.model === 'antigravity-unknown'
      ? (first === target ? source.record.model : target.record.model) : first.record.model,
    timestampMs: bestTime.record.timestampMs, tokens };
    target.timestampQuality = bestTime.timestampQuality;
    target.owner = first.owner;
    target.size += source.size;
    source.parent = a;
  };
  const visited = new Set();
  const fingerprintOf = async (file) => {
    const info = await fs.stat(file);
    return { info, part: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
  };
  const walk = async (directory) => {
    const names = await fs.readdir(directory).catch(() => []);
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      const file = path.join(directory, name);
      const info = await fs.lstat(file).catch(() => null);
      if (info?.isDirectory()) await walk(file);
      else if (info?.isFile() && name.endsWith('.db')) {
        let database;
        try {
          const canonical = await fs.realpath(file);
          if (visited.has(canonical)) continue;
          visited.add(canonical);
          const { info: stat, part } = await fingerprintOf(canonical);
          const wal = await fingerprintOf(`${canonical}-wal`).catch(() => null);
          const fingerprint = `${part}/${wal?.part ?? '-'}`;
          let cached = cache.get(canonical);
          if (cached?.fingerprint !== fingerprint) {
            database = open ? open(canonical) : new sqlite.DatabaseSync(canonical, { readOnly: true });
            const candidates = await readDatabase(database, stat.mtimeMs, pause);
            cached = { fingerprint, candidates };
            cache.set(canonical, cached);
          }
          for (const candidate of cached.candidates) {
            const index = groups.length;
            groups.push({ ...candidate, parent: index, size: 1, owner: index });
            for (const key of candidate.keys) {
              if (identities.has(key)) merge(index, identities.get(key));
              identities.set(key, index);
            }
            if (index % 256 === 255) await pause();
          }
        } catch { /* A broken database gives no records; the other files are still read. */ }
        finally { database?.close(); }
      }
      await pause();
    }
  };
  for (const root of roots) await walk(root);
  for (const key of cache.keys()) if (!visited.has(key)) cache.delete(key);
  return groups.flatMap((group, index) => group.parent === index && group.record.timestampMs >= sinceMs
    ? [{ ...group.record, model: group.record.model.replace(/-(?:low|medium|high)$/, '') }] : []);
}
