import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCrossSessionEnvelope } from './claude-data.mjs';
import { createYielder, pathKey, readPrivateJson, writePrivateJson } from './usage-scan-cache.mjs';

const CHUNK_BYTES = 1024 * 1024;
// A saved state that is a few minutes old still spares the full read after a restart; the appended bytes are small.
const SAVE_EVERY_MS = 5 * 60 * 1000;
const MARKERS = ['SendMessage', 'send_message', '<cross-session-message', 'success'].map((text) => Buffer.from(text));
const SESSION = /^(?:local_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const contentText = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n') : '';
const cut = (body) => { const points = Array.from(body); return points.length > 2000 ? `${points.slice(0, 1999).join('')}…` : body; };

// Bodies exist only while parsing a line or answering a text request, never in the file cache.
function messages(event, owner) {
  const atMs = Date.parse(event.timestamp);
  if (!Number.isFinite(atMs)) return [];
  const session = event.sessionId || owner;
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    return event.message.content.filter((item) => item?.type === 'tool_use' && /(?:SendMessage|send_message)$/.test(item.name || '')
      && typeof item.id === 'string' && item.id && typeof item.input?.message === 'string' && item.input.message.trim()
      && typeof (item.input.to ?? item.input.session_id) === 'string').flatMap((item) => {
      const to = item.input.to ?? item.input.session_id;
      if (!to || to === 'main' || /^a[0-9a-f]{16}$/.test(to)) return [];
      // A socket address changes with each start and names no session: keep only its kind, so no path goes to the group.
      return [{ id: `claude:${item.id}`, direction: 'out', from: session, to: to.startsWith('uds:') ? 'uds:' : to,
        label: SESSION.test(to) || to.startsWith('uds:') ? '' : to.slice(0, 120), atMs,
        body: item.input.message.trim(), status: 'accepted', reason: '' }];
    });
  }
  let envelope = null;
  if (event.type === 'user' && event.isMeta === true) envelope = parseCrossSessionEnvelope(contentText(event.message?.content).trim(), 199);
  if (event.type === 'attachment' && event.attachment?.type === 'queued_command' && typeof event.attachment.prompt === 'string') {
    const prompt = event.attachment.prompt.trim();
    if (prompt.endsWith('</cross-session-message>')) envelope = parseCrossSessionEnvelope(prompt, 0);
  }
  return envelope && typeof event.uuid === 'string' && event.uuid ? [{ id: `claude:${event.uuid}`, direction: 'in', from: envelope.sender,
    to: session, label: envelope.name, atMs, body: envelope.body, status: 'accepted', reason: '' }] : [];
}

export function createClaudeMessages({ readSources = async () => [], homeDir = os.homedir(), now = Date.now,
  keepMs = 30 * 86_400_000, stats = {}, stateFile = '', platform = process.platform, log = console.error } = {}) {
  const cache = new Map();
  const locations = new WeakMap();
  let scanning = Promise.resolve();
  let loaded = false;
  let dirty = false;
  let savedAtMs = null;

  // Paths and message bodies never go to disk. A live listing supplies the path for each saved file key.
  async function load() {
    if (loaded || !stateFile) return;
    loaded = true;
    const document = await readPrivateJson(stateFile, { platform });
    if (document?.version !== 1 || !document.files || typeof document.files !== 'object' || Array.isArray(document.files)) return;
    for (const [key, entry] of Object.entries(document.files)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !entry || !['size', 'offset', 'guardLength', 'ino', 'dev'].every((n) => Number.isSafeInteger(entry[n]) && entry[n] >= 0)
        || entry.offset > entry.size || entry.guardLength > 64 || entry.guardLength > entry.size
        || !['mtimeMs', 'ctimeMs'].every((n) => Number.isFinite(entry[n])) || !/^[a-f0-9]{16}$/.test(entry.first)
        || !Array.isArray(entry.failed) || !entry.failed.every((id) => typeof id === 'string') || !Array.isArray(entry.rows)) continue;
      const rows = [];
      for (const row of entry.rows) {
        if (!Array.isArray(row) || row.length !== 8) break;
        const [id, direction, atMs, status, reason, hash, offset, length] = row;
        if (typeof id !== 'string' || !['in', 'out'].includes(direction)
          || !Number.isFinite(atMs) || !['accepted', 'not-sent'].includes(status) || !['', 'Not sent'].includes(reason) || !/^[a-f0-9]{16}$/.test(hash)
          || ![offset, length].every((v) => Number.isSafeInteger(v) && v >= 0) || offset + length > entry.offset) break;
        rows.push({ id, direction, atMs, status, reason, hash, offset, length });
      }
      if (rows.length === entry.rows.length) cache.set(key, { size: entry.size, offset: entry.offset, guardLength: entry.guardLength,
        ino: entry.ino, dev: entry.dev, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, first: entry.first, rows, failed: new Set(entry.failed) });
    }
  }
  async function save() {
    if (!stateFile || !dirty || (savedAtMs !== null && now() - savedAtMs < SAVE_EVERY_MS)) return;
    const files = Object.fromEntries([...cache].map(([key, entry]) => [key, { ...entry, failed: [...entry.failed], rows: entry.rows.map((row) =>
      [row.id, row.direction, row.atMs, row.status, row.reason, row.hash, row.offset, row.length]) }]));
    try { await writePrivateJson(stateFile, { version: 1, files }, { platform }); dirty = false; savedAtMs = now(); }
    catch { log('ASB cannot save its Claude message cache. It keeps the old file.'); }
  }

  async function scan(file, stat, sinceMs, yieldNow) {
    const key = pathKey(file);
    let entry = cache.get(key);
    if (entry?.ino === stat.ino && entry.dev === stat.dev && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs) return entry;
    const handle = await fs.open(file, 'r');
    try {
      const guard = Buffer.alloc(Math.min(64, stat.size));
      if (guard.length) { await handle.read(guard, 0, guard.length, 0); stats.readBytes = (stats.readBytes || 0) + guard.length; }
      const first = hash(guard);
      if (!entry || entry.ino !== stat.ino || entry.dev !== stat.dev || stat.size <= entry.size || hash(guard.subarray(0, entry.guardLength)) !== entry.first) entry = { offset: 0, rows: [], failed: new Set() };
      async function readLines(data) {
        const starts = new Set();
        for (const marker of MARKERS) {
          let at = data.indexOf(marker);
          while (at !== -1) {
            starts.add(at === 0 ? 0 : data.lastIndexOf(10, at - 1) + 1);
            at = data.indexOf(marker, data.indexOf(10, at) + 1);
          }
        }
        for (const offset of [...starts].sort((a, b) => a - b)) {
          const end = data.indexOf(10, offset);
          const line = data.toString('utf8', offset, end);
          if (/SendMessage|send_message|<cross-session-message|success\\?"\s*:\s*false/.test(line)) {
            let event;
            try { event = JSON.parse(line); } catch {}
            if (event) {
              for (const { body, ...row } of messages(event, path.basename(file, '.jsonl'))) {
                if (row.atMs >= sinceMs) entry.rows.push({ ...row, hash: hash(body), offset: entry.offset + offset, length: end - offset });
              }
              if (event.type === 'user' && Array.isArray(event.message?.content)) {
                for (const item of event.message.content) if (item?.type === 'tool_result' && (event.toolUseResult?.success === false
                  || contentText(item.content).startsWith('{"success":false'))) entry.failed.add(`claude:${item.tool_use_id}`);
              }
            }
          }
          await yieldNow();
        }
        entry.offset += data.length;
      }
      let position = entry.offset;
      let pending = [];
      while (position < stat.size) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        stats.readBytes = (stats.readBytes || 0) + bytesRead;
        position += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        if (pending.length) {
          const newline = chunk.indexOf(10);
          if (newline === -1) {
            pending.push(chunk);
            await yieldNow();
            continue;
          }
          await readLines(Buffer.concat([...pending, chunk.subarray(0, newline + 1)]));
          pending = [];
          start = newline + 1;
        }
        const newline = chunk.lastIndexOf(10);
        if (newline >= start) {
          await readLines(chunk.subarray(start, newline + 1));
          start = newline + 1;
        }
        if (start < chunk.length) pending.push(chunk.subarray(start));
        await yieldNow();
      }
      Object.assign(entry, { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, first, guardLength: guard.length });
      cache.set(key, entry);
      dirty = true;
      return entry;
    } finally { await handle.close(); }
  }

  async function records(sinceMs) {
    const read = async () => {
      await load();
      const roots = new Set((await readSources()).filter((source) => source.enabled && source.provider === 'claude-desktop-code')
        .map((source) => path.resolve(source.projectsDir || path.join(homeDir, '.claude', 'projects'))));
      const seen = new Set();
      const result = new Map();
      const failed = new Set();
      const yieldNow = createYielder();
      const keepSinceMs = now() - keepMs;
      const cutoff = Math.max(sinceMs, keepSinceMs);
      for (const root of roots) for (const project of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!project.isDirectory()) continue;
        const folder = path.join(root, project.name);
        for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
          if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
          const file = path.join(folder, item.name);
          const stat = await fs.stat(file).catch(() => null);
          if (!stat || stat.mtimeMs < keepSinceMs) continue;
          seen.add(pathKey(file));
          if (stat.mtimeMs < cutoff) continue;
          try {
            // Cache the retention window, so a later request for a longer period does not miss records.
            const entry = await scan(file, stat, keepSinceMs, yieldNow);
            const kept = entry.rows.filter((row) => row.atMs >= keepSinceMs);
            if (kept.length !== entry.rows.length) dirty = true;
            entry.rows = kept;
            for (const id of entry.failed) failed.add(id);
            for (const row of entry.rows) if (row.atMs >= cutoff && !result.has(row.id)) {
              if (row.label === undefined) {
                const found = await readMessage({ file, ...row });
                if (!found) continue;
                Object.assign(row, { from: found.from, to: found.to, label: found.label });
              }
              result.set(row.id, { ...row, file });
            }
          } catch {}
          await yieldNow();
        }
      }
      for (const key of cache.keys()) if (!seen.has(key)) { cache.delete(key); dirty = true; }
      await save();
      return [...result.values()].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id)).map(({ file, offset, length, ...row }) => {
        if (failed.has(row.id)) Object.assign(row, { status: 'not-sent', reason: 'Not sent' });
        locations.set(row, { file, offset, length });
        return row;
      });
    };
    const result = scanning.then(read);
    scanning = result.catch(() => {});
    return result;
  }

  // A loaded record has no session names. Read its one line to restore them; bodies stay out of both caches.
  async function readMessage(location) {
    let handle;
    try {
      handle = await fs.open(location.file, 'r');
      const buffer = Buffer.alloc(location.length);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, location.offset);
      stats.readBytes = (stats.readBytes || 0) + bytesRead;
      stats.lineBytesRead = (stats.lineBytesRead || 0) + bytesRead;
      stats.linesRead = (stats.linesRead || 0) + 1;
      if (bytesRead !== buffer.length) return null;
      const event = JSON.parse(buffer.toString('utf8'));
      const row = messages(event, path.basename(location.file, '.jsonl')).find((item) => item.id === location.id);
      return row && hash(row.body) === location.hash ? row : null;
    } catch { return null; } finally { await handle?.close(); }
  }
  async function text(record) {
    const location = locations.get(record);
    if (!location) return null;
    const row = await readMessage({ ...location, id: record.id, hash: record.hash });
    return row ? cut(row.body) : null;
  }
  return { records, text };
}
