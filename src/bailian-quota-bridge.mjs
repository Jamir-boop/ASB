import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BAILIAN_QUOTA_CACHE_PATH = path.join(
  os.homedir(),
  '.agent-mission-control',
  'bailian-quota.json',
);

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LEVEL_FIELDS = new Set(['version', 'planName', 'observedAt', 'planEndsAt', 'sevenDay']);
const WINDOW_FIELDS = new Set(['usedPercent', 'resetsAt']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`${label} contains unsupported field: ${field}`);
  }
}

function timestampMs(value, label, { minMs, maxMs }) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed < minMs || parsed > maxMs) {
    throw new TypeError(`${label} is outside the accepted time range`);
  }
  return Math.floor(parsed);
}

function planLabel(value) {
  const label = String(value || '').trim().replaceAll(/[\u0000-\u001f\u007f]/g, ' ');
  if (!label || label.length > 48 || !/^[\p{L}\p{N} ._+()（）-]+$/u.test(label)) {
    throw new TypeError('planName is invalid');
  }
  return label;
}

function roundedPercent(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new TypeError(`${label} must be between 0 and 100`);
  }
  return Math.round(number * 100) / 100;
}

export function normalizeBailianQuotaSnapshot(payload, { nowMs = Date.now() } = {}) {
  assertPlainObject(payload, 'snapshot');
  assertKnownFields(payload, TOP_LEVEL_FIELDS, 'snapshot');
  if (payload.version !== 1) throw new TypeError('snapshot version must be 1');

  assertPlainObject(payload.sevenDay, 'sevenDay');
  assertKnownFields(payload.sevenDay, WINDOW_FIELDS, 'sevenDay');
  const usedPercent = roundedPercent(payload.sevenDay.usedPercent, 'sevenDay.usedPercent');
  const observedAtMs = timestampMs(payload.observedAt, 'observedAt', {
    minMs: nowMs - (7 * DAY_MS),
    maxMs: nowMs + (10 * 60 * 1000),
  });
  const resetsAtMs = timestampMs(payload.sevenDay.resetsAt, 'sevenDay.resetsAt', {
    minMs: nowMs - (7 * DAY_MS),
    maxMs: nowMs + (14 * DAY_MS),
  });
  const planEndsAtMs = payload.planEndsAt == null || payload.planEndsAt === ''
    ? null
    : timestampMs(payload.planEndsAt, 'planEndsAt', {
      minMs: nowMs - (365 * DAY_MS),
      maxMs: nowMs + (3 * 365 * DAY_MS),
    });

  return {
    version: 1,
    savedAtMs: Math.floor(nowMs),
    snapshot: {
      planName: planLabel(payload.planName),
      observedAtMs,
      planEndsAtMs,
      sevenDay: {
        usedPercent,
        availablePercent: Math.round((100 - usedPercent) * 100) / 100,
        resetsAtMs,
      },
    },
  };
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeBailianQuotaSnapshot(
  cachePath = DEFAULT_BAILIAN_QUOTA_CACHE_PATH,
  payload,
  options = {},
) {
  if (!cachePath) throw new TypeError('Bailian quota cache path is required');
  const normalized = normalizeBailianQuotaSnapshot(payload, options);
  await writePrivateJson(cachePath, normalized);
  return normalized;
}

export async function readBailianQuotaSnapshot(cachePath = DEFAULT_BAILIAN_QUOTA_CACHE_PATH) {
  if (!cachePath) return null;
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (
      cached?.version !== 1
      || !Number.isFinite(Number(cached?.savedAtMs))
      || !cached?.snapshot
      || typeof cached.snapshot !== 'object'
      || !cached.snapshot.sevenDay
      || typeof cached.snapshot.sevenDay !== 'object'
    ) return null;

    const usedPercent = roundedPercent(
      cached.snapshot.sevenDay.usedPercent,
      'sevenDay.usedPercent',
    );
    const observedAtMs = Number(cached.snapshot.observedAtMs);
    const resetsAtMs = Number(cached.snapshot.sevenDay.resetsAtMs);
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(resetsAtMs)) return null;

    return {
      version: 1,
      savedAtMs: Math.floor(Number(cached.savedAtMs)),
      snapshot: {
        planName: planLabel(cached.snapshot.planName),
        observedAtMs: Math.floor(observedAtMs),
        planEndsAtMs: Number.isFinite(Number(cached.snapshot.planEndsAtMs))
          ? Math.floor(Number(cached.snapshot.planEndsAtMs))
          : null,
        sevenDay: {
          usedPercent,
          availablePercent: Math.round((100 - usedPercent) * 100) / 100,
          resetsAtMs: Math.floor(resetsAtMs),
        },
      },
    };
  } catch {
    return null;
  }
}
