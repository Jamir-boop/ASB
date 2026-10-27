// The permanent usage ledger: the hourly token counts of this machine and of imported machines, kept after the transcripts
// are gone. Every merge takes the larger count per hour, app, model, and token type, so a second merge of the same data adds nothing.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configDir } from './platform-paths.mjs';
import { validName } from './machine-group.mjs';

export const LEDGER_VERSION = 1;
export const EXPORT_FORMAT = 'asb-usage-export';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIRST_USAGE_MS = Date.UTC(2020, 0, 1);
const MAX_EXPORT_MACHINES = 64;
const MAX_EXPORT_RECORDS = 500_000;
const TOKEN_TYPES = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
const APP = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL = /^[^\x00-\x1f]{1,200}$/u;
const MACHINE_ID = /^[0-9a-f]{16}$/;

export function usageLedgerPath(env = process.env, platform = process.platform) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(configDir(env, platform), 'usage', 'usage-ledger.json');
}

export const recordKey = (hourMs, app, model) => `${hourMs}\0${app}\0${model}`;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');

// A record in its file form: [hourMs, app, model, uncached, cacheRead, cacheWrite, output].
export const validTuple = (item, nowMs) => Array.isArray(item) && item.length === 7 && Number.isSafeInteger(item[0])
  && item[0] % HOUR_MS === 0 && item[0] >= FIRST_USAGE_MS && item[0] <= nowMs + DAY_MS
  && typeof item[1] === 'string' && APP.test(item[1]) && typeof item[2] === 'string' && MODEL.test(item[2]) && item.slice(3).every(count);
export const validRecord = ({ hourMs, app, model, tokens }, nowMs) => validTuple([hourMs, app, model, ...TOKEN_TYPES.map((type) => tokens?.[type])], nowMs);
const fromTuple = ([hourMs, app, model, uncached, cacheRead, cacheWrite, output]) => ({ hourMs, app, model, tokens: { uncached, cacheRead, cacheWrite, output } });
const toTuple = ({ hourMs, app, model, tokens }) => [hourMs, app, model, ...TOKEN_TYPES.map((type) => tokens[type])];

// Per token type the larger value. Returns whether anything grew.
export function mergeRecord(records, record) {
  const key = recordKey(record.hourMs, record.app, record.model);
  const old = records.get(key);
  if (!old) {
    records.set(key, { hourMs: record.hourMs, app: record.app, model: record.model, tokens: Object.fromEntries(TOKEN_TYPES.map((type) => [type, record.tokens[type]])) });
    return true;
  }
  let grew = false;
  for (const type of TOKEN_TYPES) if (record.tokens[type] > old.tokens[type]) { old.tokens[type] = record.tokens[type]; grew = true; }
  return grew;
}
export const mergeRecords = (records, list) => {
  let grew = false;
  for (const record of list) grew = mergeRecord(records, record) || grew;
  return grew;
};

// Code-point order, so the same records give the same file on every machine.
const text = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const sortedTuples = (records) => [...records].sort((a, b) => a.hourMs - b.hourMs || text(a.app, b.app) || text(a.model, b.model)).map(toTuple);

export const emptyLedger = () => ({ self: { machineId: '', name: '', records: new Map() }, machines: new Map() });

export function encodeLedger(ledger) {
  return { version: LEDGER_VERSION, self: { machineId: ledger.self.machineId, name: ledger.self.name, records: sortedTuples(ledger.self.records.values()) },
    machines: [...ledger.machines.values()].map(({ machineId, name, exportedAtMs, records }) => ({ machineId, name, exportedAtMs, records: sortedTuples(records.values()) })) };
}

const recordMap = (tuples) => {
  const records = new Map();
  mergeRecords(records, tuples.map(fromTuple));
  return records;
};

// Its own file has no upper time bound: a clock that is wrong at load time must not set the history aside.
function decodeLedger(value, nowMs = Infinity) {
  if (!exact(value, ['version', 'self', 'machines']) || value.version !== LEDGER_VERSION) return null;
  const { self, machines } = value;
  if (!exact(self, ['machineId', 'name', 'records']) || typeof self.machineId !== 'string' || typeof self.name !== 'string'
    || !Array.isArray(self.records) || !self.records.every((item) => validTuple(item, nowMs)) || !Array.isArray(machines)) return null;
  const ledger = emptyLedger();
  Object.assign(ledger.self, { machineId: self.machineId, name: self.name, records: recordMap(self.records) });
  for (const item of machines) {
    if (!exact(item, ['machineId', 'name', 'exportedAtMs', 'records']) || !MACHINE_ID.test(item.machineId) || !validName(item.name)
      || !count(item.exportedAtMs) || !Array.isArray(item.records) || !item.records.every((record) => validTuple(record, nowMs))) return null;
    const old = ledger.machines.get(item.machineId);
    if (old) {
      mergeRecords(old.records, item.records.map(fromTuple));
      old.exportedAtMs = Math.max(old.exportedAtMs, item.exportedAtMs);
    } else ledger.machines.set(item.machineId, { machineId: item.machineId, name: item.name, exportedAtMs: item.exportedAtMs, records: recordMap(item.records) });
  }
  return ledger;
}

// A missing file gives an empty ledger. A broken file is never overwritten: it is set aside, or, if that fails, nothing is saved.
// A file that cannot be read (or a link) is kept as it is, and nothing is saved. The mode alone never sets a file aside.
export async function loadLedger(file, { platform = process.platform, now = Date.now, log = console.error } = {}) {
  const unreadable = () => {
    log('ASB cannot read its usage ledger. It saves no usage history now.');
    return { ledger: emptyLedger(), blocked: true };
  };
  let raw;
  try {
    if (!(await fs.lstat(file)).isFile()) return unreadable();
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? { ledger: emptyLedger(), blocked: false } : unreadable();
  }
  let value = null;
  try { value = JSON.parse(raw); } catch { /* Set aside below. */ }
  const ledger = decodeLedger(value);
  if (ledger) {
    if (platform !== 'win32') await fs.chmod(file, 0o600).catch(() => {});
    return { ledger, blocked: false };
  }
  const name = `usage-ledger.${now()}.bad.json`;
  try {
    await fs.rename(file, path.join(path.dirname(file), name));
    log(`ASB set aside an unreadable usage ledger: ${name}.`);
    return { ledger: emptyLedger(), blocked: false };
  } catch {
    log('ASB cannot set aside its unreadable usage ledger. It saves no usage history now.');
    return { ledger: emptyLedger(), blocked: true };
  }
}

export const exportDocument = (exportedAtMs, machines) => ({ format: EXPORT_FORMAT, version: LEDGER_VERSION, exportedAtMs,
  machines: machines.map(({ machineId, name, records }) => ({ machineId, name, records: sortedTuples(records) })) });

// All or nothing: the machines of an export file, each with its records merged by key.
export function readExport(document, nowMs) {
  const fail = () => { throw Object.assign(new Error('This file is not an ASB usage export.'), { statusCode: 400 }); };
  if (!exact(document, ['format', 'version', 'exportedAtMs', 'machines']) || document.format !== EXPORT_FORMAT || document.version !== LEDGER_VERSION
    || !Number.isSafeInteger(document.exportedAtMs) || document.exportedAtMs <= 0 || !Array.isArray(document.machines)
    || document.machines.length < 1 || document.machines.length > MAX_EXPORT_MACHINES) fail();
  return document.machines.map((item) => {
    if (!exact(item, ['machineId', 'name', 'records']) || typeof item.machineId !== 'string' || !MACHINE_ID.test(item.machineId) || !validName(item.name)
      || !Array.isArray(item.records) || item.records.length > MAX_EXPORT_RECORDS || !item.records.every((record) => validTuple(record, nowMs))) fail();
    return { machineId: item.machineId, name: item.name, records: recordMap(item.records) };
  });
}
