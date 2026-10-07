import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_QUOTA_HISTORY_PATH = path.join(
  os.homedir(),
  '.agent-mission-control',
  'quota-history.json',
);

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_TREND_SPAN_MS = 30 * 60 * 1000;
const RETENTION_MS = 100 * DAY_MS;
const MAX_SAMPLES = 5000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function safeId(value) {
  return String(value || '').trim().slice(0, 80);
}

function sampleKey(sample = {}) {
  return `${sample.serviceId}\0${sample.windowId}\0${sample.resetsAtMs}`;
}

function sanitizeSample(sample = {}) {
  const serviceId = safeId(sample.serviceId);
  const windowId = safeId(sample.windowId);
  const observedAtMs = finiteNumber(sample.observedAtMs);
  const resetsAtMs = finiteNumber(sample.resetsAtMs);
  const usedPercent = clampPercent(sample.usedPercent);
  if (!serviceId || !windowId || !observedAtMs || !resetsAtMs || usedPercent === null) return null;
  return { serviceId, windowId, observedAtMs, resetsAtMs, usedPercent };
}

async function readHistory(filePath) {
  try {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (payload?.version !== 1 || !Array.isArray(payload.samples)) return [];
    return payload.samples.map(sanitizeSample).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeHistory(filePath, samples) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, samples })}\n`,
      { mode: 0o600 },
    );
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function currentSamples(services, nowMs) {
  return services.flatMap((service) => (
    (Array.isArray(service?.windows) ? service.windows : [])
      .filter((window) => window?.kind !== 'rolling')
      .map((window) => sanitizeSample({
        serviceId: service?.id,
        windowId: window?.id,
        observedAtMs: finiteNumber(service?.observedAtMs) || nowMs,
        resetsAtMs: window?.resetsAtMs,
        usedPercent: window?.usedPercent,
      }))
      .filter(Boolean)
  ));
}

function appendDistinctSamples(samples, additions) {
  const latest = new Map();
  for (const sample of samples) latest.set(sampleKey(sample), sample);
  for (const addition of additions) {
    const previous = latest.get(sampleKey(addition));
    if (
      previous
      && previous.observedAtMs === addition.observedAtMs
      && previous.usedPercent === addition.usedPercent
    ) continue;
    samples.push(addition);
    latest.set(sampleKey(addition), addition);
  }
}

function trendForWindow(samples, serviceId, window, nowMs) {
  const resetsAtMs = finiteNumber(window?.resetsAtMs);
  const durationMs = finiteNumber(window?.durationMs);
  if (!resetsAtMs || !durationMs || window?.kind === 'rolling') return null;
  const cycleStartMs = resetsAtMs - durationMs;
  const cycle = samples
    .filter((sample) => (
      sample.serviceId === serviceId
      && sample.windowId === window.id
      && sample.resetsAtMs === resetsAtMs
      && sample.observedAtMs >= cycleStartMs
      && sample.observedAtMs <= resetsAtMs
    ))
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
  if (cycle.length < 2) return { sampleCount: cycle.length, confidence: 'low' };

  const first = cycle[0];
  const last = cycle.at(-1);
  const spanMs = last.observedAtMs - first.observedAtMs;
  if (spanMs < MIN_TREND_SPAN_MS) {
    return { sampleCount: cycle.length, spanMs, confidence: 'low' };
  }

  const consumedPercent = Math.max(0, last.usedPercent - first.usedPercent);
  const usedPercentPerDay = (consumedPercent / spanMs) * DAY_MS;
  const availablePercent = 100 - last.usedPercent;
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  const projectedAvailablePercent = availablePercent - (usedPercentPerDay * remainingMs / DAY_MS);
  const confidence = spanMs >= DAY_MS && cycle.length >= 8
    ? 'high'
    : (spanMs >= 6 * 60 * 60 * 1000 && cycle.length >= 4 ? 'medium' : 'low');
  return {
    sampleCount: cycle.length,
    spanMs,
    usedPercentPerDay,
    projectedAvailablePercent,
    confidence,
  };
}

export async function attachQuotaHistory(services = [], options = {}) {
  const filePath = options.filePath || '';
  if (!filePath || !Array.isArray(services)) return services;
  const nowMs = finiteNumber(options.nowMs) || Date.now();
  const existing = await readHistory(filePath);
  const minimumObservedAtMs = nowMs - RETENTION_MS;
  const samples = existing.filter((sample) => sample.observedAtMs >= minimumObservedAtMs);
  appendDistinctSamples(samples, currentSamples(services, nowMs));
  samples.sort((left, right) => left.observedAtMs - right.observedAtMs);
  const bounded = samples.slice(-MAX_SAMPLES);
  await writeHistory(filePath, bounded);

  return services.map((service) => ({
    ...service,
    windows: (Array.isArray(service?.windows) ? service.windows : []).map((window) => ({
      ...window,
      history: trendForWindow(bounded, service.id, window, nowMs),
    })),
  }));
}
