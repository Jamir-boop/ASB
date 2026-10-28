// Read-only bridge and Claude message activity, merged over the machine group.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { querySqliteJson } from './codex-data.mjs';
import { MAX_ACTIVITY_MESSAGES, rowKeyLookup } from './machine-peers.mjs';
import { defaultOpenCodeStateDir } from './opencode-data.mjs';
import { periodBuckets, USAGE_PERIODS as PERIODS } from './usage-aggregation.mjs';

export { periodBuckets, PERIODS };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A message ID that can go into the text query.
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;
const KEEP_MS = 30 * DAY_MS;
const MAX_FILES = 2_000;
const THREAD_SIZE = 60;
const TEXT_LIMIT = 2_000;
const APPS = { codex: 'codex', 'claude-desktop-code': 'claude', opencode: 'opencode' };
const NO_SCAN = { complete: true, files: 0, scannedFiles: 0 };

// Contract 2.1: the status group of one bridge row. The Codex app-server host writes `accepted` into in rows.
export function statusGroup(status, direction) {
  if (['accepted', 'started', 'steered', 'delivered'].includes(status)) return 'accepted';
  if (['socket-written', 'pending'].includes(status) || (status === 'submitting' && direction === 'in')) return 'written';
  if (status === 'held') return 'held';
  if (['not-sent', 'refused', 'denied', 'dropped', 'expired'].includes(status)) return 'not-sent';
  return 'unknown';
}

// Contract 2.1: a fixed reason for a not-sent row; the status_reason text itself never goes out.
export function statusReason(status, text) {
  const fixed = { refused: 'Refused', denied: 'Denied', dropped: 'Dropped', expired: 'Expired' }[status];
  if (fixed) return fixed;
  if (status !== 'not-sent') return '';
  const reason = typeof text === 'string' ? text : '';
  if (reason.endsWith('is not reachable. Nothing sent.')) return 'Machine offline';
  if (reason.startsWith('Message too large')) return 'Too large';
  if (reason.startsWith('Too many messages')) return 'Rate limited';
  if (reason.endsWith('refused the message. Nothing sent.')) return 'Refused';
  return 'Not sent';
}

const bodyHash = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);

// The bridge text without the cross-session envelope.
export function messageBody(text) {
  const lines = String(text ?? '').split('\n');
  if (lines[0]?.startsWith('<cross-session-message')) lines.shift();
  if (lines.at(-1) === '' && lines.at(-2)?.trim() === '</cross-session-message>') lines.pop();
  if (lines.length && lines.at(-1).trim() === '</cross-session-message>') lines.pop();
  return lines.join('\n');
}

export function messageText(text) {
  const points = Array.from(messageBody(text));
  return points.length > TEXT_LIMIT ? `${points.slice(0, TEXT_LIMIT - 1).join('')}…` : points.join('');
}

export function createActivityMessages({ readSources = async () => [], dashboard = async () => ({ threads: [] }),
  claudeMessages = null, machine = () => ({ machineId: '', name: '' }), group = null, activityUsage = null, now = Date.now,
  openCodeStateDir = defaultOpenCodeStateDir, query = querySqliteJson, busy = () => false, changes = null } = {}) {
  // Per bridge database: the size and change time of the file and its WAL, and its message rows of the last 30 days. Oldest entry goes first.
  const files = new Map();
  let messagesCache = null;
  const recordsCache = new Map();
  const reusable = (cached, sinceMs) => typeof changes === 'function' && cached && cached.sinceMs <= sinceMs
    && (now() - cached.atMs < 10_000 || (!busy() && changes() === cached.changes && now() - cached.atMs < 5 * 60_000));

  async function readRows(filePath, sinceMs) {
    const [main, wal] = await Promise.all([fs.stat(filePath), fs.stat(`${filePath}-wal`).catch(() => null)]);
    if (Math.max(main.mtimeMs, wal?.mtimeMs || 0) < sinceMs) return [];
    const signature = `${main.size}:${main.mtimeMs}|${wal ? `${wal.size}:${wal.mtimeMs}` : ''}`;
    const since = Math.floor(sinceMs / 1000);
    const cached = files.get(filePath);
    if (cached?.signature === signature && cached.since <= since) return cached.rows;
    const columns = new Set((await query(filePath, 'pragma table_info(messages);')).map((row) => row.name));
    let rows = [];
    if (['id', 'peer_id', 'direction', 'status', 'created_at'].every((name) => columns.has(name))) {
      // A file with no kind column has only messages.
      rows = (await query(filePath, `select id, peer_id, direction, status, text, ${columns.has('status_reason') ? 'status_reason' : "'' as status_reason"}, created_at
        from messages where created_at >= ${since}${columns.has('kind') ? " and kind = 'message'" : ''};`))
        .filter((row) => typeof row.id === 'string' && MESSAGE_ID.test(row.id) && typeof row.peer_id === 'string' && UUID.test(row.peer_id)
          && ['in', 'out'].includes(row.direction) && Number.isFinite(Number(row.created_at)))
        .map((row) => ({ id: row.id, peer: row.peer_id, direction: row.direction, atMs: Number(row.created_at) * 1000,
          status: statusGroup(row.status, row.direction), reason: statusReason(row.status, row.status_reason),
          hash: bodyHash(messageBody(row.text)), label: '' }));
    }
    files.delete(filePath);
    files.set(filePath, { signature, since, rows });
    while (files.size > MAX_FILES) files.delete(files.keys().next().value);
    return rows;
  }

  // The bridge folders of the enabled sources: Codex and Claude homes, and the OpenCode bridge state folder.
  async function bridgeFiles() {
    const sources = (await readSources()).filter((source) => source.enabled);
    const folders = [...new Set(sources.map((source) => path.join(source.provider === 'opencode' ? openCodeStateDir() : source.dataDir,
      'plugin-state', 'asb-bridge')))];
    const lists = await Promise.all(folders.map(async (folder) => (await fs.readdir(folder).catch(() => []))
      .filter((name) => name.endsWith('.sqlite') && UUID.test(name.slice(0, -'.sqlite'.length)))
      .map((name) => ({ filePath: path.join(folder, name), owner: name.slice(0, -'.sqlite'.length) }))));
    return lists.flat();
  }

  // This machine's records since sinceMs: one per message ID from all its rows. The receiver row gives the status, the sender row the time.
  async function localMessages(sinceMs) {
    if (reusable(messagesCache, sinceMs)) return messagesCache.records.filter((row) => row.atMs >= sinceMs);
    const atMs = now(), change = changes?.();
    const read = await Promise.all((await bridgeFiles()).map(({ filePath, owner }) =>
      readRows(filePath, now() - KEEP_MS).then((rows) => ({ filePath, owner, rows }), () => null)));
    const byId = new Map();
    for (const entry of read) {
      for (const row of entry?.rows || []) {
        if (row.atMs < sinceMs) continue;
        let record = byId.get(row.id);
        if (!record) byId.set(row.id, record = { id: row.id, in: null, out: null, files: [] });
        if (!record[row.direction]) record[row.direction] = { ...row, ...(row.direction === 'out' ? { from: entry.owner, to: row.peer } : { from: row.peer, to: entry.owner }) };
        record.files.push(entry.filePath);
      }
    }
    const records = [...byId.values()].map(({ id, in: received, out: sent, files: paths }) => ({ id, from: (sent || received).from, to: (sent || received).to,
      atMs: (sent || received).atMs, status: (received || sent).status, reason: (received || sent).reason,
      direction: received && sent ? 'both' : received ? 'in' : 'out', hash: (sent || received).hash, label: '', files: paths }))
      .concat((await claudeMessages?.records(sinceMs) || []).map((row) => ({ ...row, claudeRecord: row, files: [] })));
    if (typeof changes === 'function') messagesCache = { atMs, sinceMs, changes: change, records };
    return records;
  }

  const byTime = (left, right) => left.atMs - right.atMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  // Read only requested bodies. No body is kept in the scan cache.
  async function textsFor(records) {
    const texts = new Map();
    const byFile = new Map();
    await Promise.all(records.map(async (item) => {
      if (item.text !== undefined) texts.set(item.id, item.text);
      if (item.claudeRecord) {
        const text = await claudeMessages.text(item.claudeRecord);
        if (text !== null) texts.set(item.id, text);
      }
      for (const file of item.files || []) byFile.set(file, [...(byFile.get(file) || []), item.textId || item.id]);
    }));
    await Promise.all([...byFile].map(async ([file, ids]) => {
      try {
        const rows = await query(file, `select id, text from messages where id in (${ids.filter((id) => MESSAGE_ID.test(id)).map((id) => `'${id}'`).join(',')});`);
        for (const row of rows) for (const item of records) if ((item.textId || item.id) === row.id && typeof row.text === 'string'
          && (!item.hash || bodyHash(messageBody(row.text)) === item.hash)) texts.set(item.id, messageText(row.text));
      } catch {}
    }));
    return texts;
  }

  async function localRecords(period) {
    if (period === 'all') return [];
    const span = Math.min(PERIODS[period].unit === 'hour' ? DAY_MS : PERIODS[period].count * DAY_MS, KEEP_MS);
    const sinceMs = now() - span;
    const cached = recordsCache.get(period);
    if (reusable(cached, sinceMs)) return cached.records.filter((row) => row.atMs >= sinceMs);
    const atMs = now(), change = changes?.();
    const records = (await localMessages(sinceMs)).sort(byTime).slice(-MAX_ACTIVITY_MESSAGES);
    const texts = await textsFor(records.slice(-200));
    const result = records.map(({ id, from, to, atMs, status, reason, direction, hash, label }) =>
      ({ id, from, to, atMs, status, reason, direction, hash, label, text: texts.get(id) ?? null }));
    if (typeof changes === 'function') recordsCache.set(period, { atMs, sinceMs, changes: change, records: result });
    return result;
  }

  // All records of the period over the group, mapped to seats, oldest first.
  async function merged(period) {
    const nowMs = now();
    const buckets = periodBuckets(period, nowMs);
    const startMs = buckets.startsMs[0];
    const self = machine();
    const [board, local, members] = await Promise.all([dashboard(), localMessages(startMs),
      group?.activity ? group.activity(period).catch(() => []) : []]);
    const records = new Map();
    const add = (item, origin, files) => {
      let record = records.get(item.id);
      if (!record) records.set(item.id, record = { ...item, origin, fromOrigin: origin, toOrigin: origin,
        fromLabel: '', toLabel: '', files: [], sender: false, receiver: false });
      if (item.direction !== 'out' && !record.receiver) Object.assign(record, { to: item.to, toOrigin: origin,
        fromLabel: item.label || '', status: item.status, reason: item.reason, receiver: true });
      if (item.direction !== 'in' && !record.sender) Object.assign(record, { from: item.from, fromOrigin: origin,
        toLabel: item.label || '', atMs: item.atMs, sender: true });
      if (item.claudeRecord) record.claudeRecord = item.claudeRecord;
      if (item.text != null && record.text == null) record.text = item.text;
      record.files.push(...files);
    };
    for (const item of local) add(item, self.machineId, item.files);
    for (const member of members) for (const item of member.messages) add(item, member.machineId, []);
    const ordered = [...records.values()].sort(byTime);
    const free = new Map();
    for (const record of ordered) if (record.sender && !record.receiver && record.hash) {
      if (!free.has(record.hash)) free.set(record.hash, []);
      free.get(record.hash).push(record);
    }
    for (const received of ordered.filter((record) => record.receiver && !record.sender && record.hash)) {
      const senders = free.get(received.hash);
      const index = senders?.findLastIndex((record) => record.atMs <= received.atMs + 120_000 && received.atMs <= record.atMs + DAY_MS);
      if (index === undefined || index < 0) continue;
      const [sent] = senders.splice(index, 1);
      Object.assign(sent, { to: received.to, toOrigin: received.toOrigin, fromLabel: received.fromLabel,
        status: 'accepted', reason: '', receiver: true });
      if (!sent.claudeRecord && received.claudeRecord) sent.claudeRecord = received.claudeRecord;
      if (sent.text == null && received.text != null) sent.text = received.text;
      if (!sent.files.length && received.files.length) { sent.files = received.files; sent.textId = received.id; }
      records.delete(received.id);
    }
    const lookup = rowKeyLookup(board);
    const rows = new Map((board.threads || []).map((row) => [row.id, row]));
    const seat = (key, origin) => {
      const rowId = lookup.get(key);
      return rowId && rows.has(rowId) ? rowId : `unknown:${origin}`;
    };
    const messages = [...records.values()].filter((record) => record.atMs >= startMs).sort(byTime)
      .map((record) => {
        const from = seat(record.from, record.fromOrigin), to = seat(record.to, record.toOrigin);
        return { id: record.id, from, to, atMs: record.atMs, status: record.status, reason: record.reason,
          local: record.files.length > 0 || Boolean(record.claudeRecord), files: record.files, hash: record.hash,
          claudeRecord: record.claudeRecord, textId: record.textId, text: record.text,
          fromLabel: from.startsWith('unknown:') ? record.fromLabel : '', toLabel: to.startsWith('unknown:') ? record.toLabel : '' };
      });
    const machines = [{ machineId: self.machineId, name: self.name, self: true, state: 'local', lastReportAtMs: 0 },
      ...members.map(({ machineId, name, state, lastReportAtMs }) => ({ machineId, name, self: false, state, lastReportAtMs }))];
    return { nowMs, buckets, machines, messages, rows, self };
  }

  // Contract 2.1 seats: every endpoint, in machine order, then by title and ID inside a machine.
  function seatsOf(ids, rows, machines, self) {
    const seats = [...ids].map((id) => {
      const row = rows.get(id);
      return row ? { id, title: String(row.title || ''), app: APPS[row.provider] || '', machineId: row.remote ? row.machineId : self.machineId }
        : { id, title: 'Other sessions', app: '', machineId: id.slice('unknown:'.length) };
    });
    const index = new Map(machines.map((item, position) => [item.machineId, position]));
    const key = (item) => [index.get(item.machineId) ?? machines.length, item.machineId, item.title.toLowerCase(), item.id];
    seats.sort((left, right) => {
      const [a, b] = [key(left), key(right)];
      for (let at = 0; at < a.length; at += 1) if (a[at] !== b[at]) return a[at] < b[at] ? -1 : 1;
      return 0;
    });
    const counts = new Map();
    return seats.map((item) => {
      const order = counts.get(item.machineId) || 0;
      counts.set(item.machineId, order + 1);
      return { ...item, order };
    });
  }

  return {
    // No body is read and no message has text: the texts show only in a thread.
    // With text: false (the phone gateway), no message has labels either.
    async report(period, { text = true } = {}) {
      const { nowMs, buckets, machines, messages, rows, self } = await merged(period);
      const kept = messages.slice(-MAX_ACTIVITY_MESSAGES);
      const ids = new Set(kept.flatMap((item) => [item.from, item.to]));
      return { period, nowMs, buckets, machines, seats: seatsOf(ids, rows, machines, self),
        messages: kept.map(({ files, hash, claudeRecord, textId, text: _text, fromLabel, toLabel, ...item }) => (text
          ? { ...item, fromLabel, toLabel } : item)), truncated: kept.length < messages.length };
    },

    // One pair or one session: the newest 60 messages oldest first, the total, and the text of each.
    async thread(period, { a, b, seat } = {}) {
      const { messages } = await merged(period);
      const all = messages.filter((item) => seat !== undefined ? item.from === seat || item.to === seat
        : (item.from === a && item.to === b) || (item.from === b && item.to === a));
      const shown = all.slice(-THREAD_SIZE);
      const texts = await textsFor(shown);
      return { total: all.length, messages: shown.map(({ id, from, to, atMs, status, reason, fromLabel, toLabel }) =>
        ({ id, from, to, atMs, status, reason, fromLabel, toLabel, text: texts.get(id) ?? null })) };
    },

    localRecords,

    // GET /peer/v1/activity: local records, and the local hourly usage ({ usage, scan }) when the usage service is there.
    async memberReply(period) {
      const [messages, hourly] = await Promise.all([localRecords(period), activityUsage?.localHourly ? activityUsage.localHourly(period) : null]);
      return { messages, usage: Array.isArray(hourly?.usage) ? hourly.usage : [], scan: hourly?.scan || NO_SCAN };
    },
  };
}
