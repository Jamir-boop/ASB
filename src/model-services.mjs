import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_BAILIAN_QUOTA_CACHE_PATH,
  readBailianQuotaSnapshot,
} from './bailian-quota-bridge.mjs';
import {
  DEFAULT_GROK_QUOTA_CACHE_PATH,
  loadGrokQuota,
  readJson,
  writeJsonAtomicPrivate,
} from './grok-quota.mjs';
import { findCindyDatabase } from './cindy-data.mjs';
import { readCindyProviderSecret } from './cindy-safe-storage.mjs';
import { attachQuotaHistory, DEFAULT_QUOTA_HISTORY_PATH } from './quota-history.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_CINDY_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Cindy');
const DEFAULT_KIMI_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'kimi-desktop');
const DEFAULT_KIMI_APP_PATH = '/Applications/Kimi.app';
const DEFAULT_KIMI_QUOTA_CACHE_PATH = path.join(
  os.homedir(),
  '.agent-mission-control',
  'kimi-quota.json',
);
const KIMI_MEMBERSHIP_API_BASE = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService';
const KIMI_SUBSCRIPTION_STATS_URL = `${KIMI_MEMBERSHIP_API_BASE}/GetSubscriptionStats`;
const KIMI_SUBSCRIPTION_URL = `${KIMI_MEMBERSHIP_API_BASE}/GetSubscription`;
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEFAULT_BALANCE_CACHE_MS = 60_000;
const DEFAULT_KIMI_QUOTA_CACHE_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_KIMI_STORAGE_FILES = 12;
const MAX_KIMI_STORAGE_FILE_BYTES = 16 * 1024 * 1024;
let deepSeekBalanceCache = null;
const kimiQuotaMemoryCache = new Map();
const kimiQuotaInFlight = new Map();

function coerceNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value) {
  const number = coerceNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function timestampToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (number <= 0) return null;
    return number > 1_000_000_000_000 ? number : number * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function querySqlite(databasePath, sql, runCommand) {
  if (!databasePath) return [];
  const { stdout } = await runCommand('sqlite3', ['-readonly', '-json', databasePath, sql], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = parseJson(stdout, []);
  return Array.isArray(rows) ? rows : [];
}

function runtimeModels(provider = {}) {
  const runtimes = parseJson(provider.runtimes, {}) || {};
  const models = new Map();

  for (const runtime of Object.values(runtimes)) {
    if (!runtime || typeof runtime !== 'object') continue;
    for (const model of Array.isArray(runtime.models) ? runtime.models : []) {
      const id = String(model?.id || model?.modelId || '').trim();
      if (!id || models.has(id)) continue;
      models.set(id, {
        id,
        label: String(model?.name || model?.displayName || id),
      });
    }
  }

  return [...models.values()];
}

function runtimeUrls(provider = {}) {
  const runtimes = parseJson(provider.runtimes, {}) || {};
  return Object.values(runtimes)
    .flatMap((runtime) => [runtime?.baseUrl, runtime?.modelsUrl])
    .filter(Boolean)
    .map(String);
}

function quotaDurationMs(window, fallbackMs = null) {
  const minutes = coerceNumber(window?.windowMinutes, 0);
  return minutes > 0 ? minutes * MINUTE_MS : fallbackMs;
}

function previousMonthlyBoundaryMs(resetsAtMs) {
  const value = timestampToMs(resetsAtMs);
  if (!value) return null;
  const reset = new Date(value);
  const previousMonthEnd = new Date(Date.UTC(
    reset.getUTCFullYear(),
    reset.getUTCMonth(),
    0,
    reset.getUTCHours(),
    reset.getUTCMinutes(),
    reset.getUTCSeconds(),
    reset.getUTCMilliseconds(),
  ));
  const previousDay = Math.min(reset.getUTCDate(), previousMonthEnd.getUTCDate());
  return Date.UTC(
    previousMonthEnd.getUTCFullYear(),
    previousMonthEnd.getUTCMonth(),
    previousDay,
    reset.getUTCHours(),
    reset.getUTCMinutes(),
    reset.getUTCSeconds(),
    reset.getUTCMilliseconds(),
  );
}

function monthlyDurationMs(resetsAtMs) {
  const value = timestampToMs(resetsAtMs);
  const previous = previousMonthlyBoundaryMs(value);
  return value && previous ? value - previous : null;
}

function findProvider(providers, predicate) {
  return providers.find((provider) => {
    const text = [provider.id, provider.name, ...runtimeUrls(provider)].join(' ').toLowerCase();
    return predicate(text, provider);
  }) || null;
}

async function readCindyState({ cindyDatabasePath, cindyDataDir, runCommand }) {
  const databasePath = cindyDatabasePath || await findCindyDatabase(cindyDataDir);
  if (!databasePath || !await pathExists(databasePath)) {
    return { databasePath: '', providers: [], snapshots: [], activityModels: [] };
  }

  const [providers, snapshots, activityModels] = await Promise.all([
    querySqlite(
      databasePath,
      'SELECT id, name, runtimes FROM custom_providers ORDER BY id;',
      runCommand,
    ).catch(() => []),
    querySqlite(
      databasePath,
      'SELECT agent_kind, snapshot, updated_at FROM account_usage_snapshots ORDER BY agent_kind;',
      runCommand,
    ).catch(() => []),
    querySqlite(
      databasePath,
      "SELECT DISTINCT model FROM daily_model_usage WHERE lower(model) LIKE '%grok%' OR lower(model) LIKE '%xai%' ORDER BY model LIMIT 20;",
      runCommand,
    ).catch(() => []),
  ]);

  return { databasePath, providers, snapshots, activityModels };
}

function codexService(codexQuota = {}) {
  const group = (Array.isArray(codexQuota.groups) ? codexQuota.groups : [])
    .find((candidate) => candidate?.key === 'gpt');
  const windows = [];

  if (group?.realtime) {
    const durationMs = quotaDurationMs(group.realtime, 5 * 60 * MINUTE_MS);
    const longWindow = durationMs >= DAY_MS;
    windows.push({
      id: 'rolling',
      label: longWindow ? '长期额度' : '短时额度',
      kind: longWindow ? 'fixed' : 'rolling',
      usedPercent: clampPercent(group.realtime.usedPercent),
      availablePercent: clampPercent(group.realtime.availablePercent),
      resetsAtMs: timestampToMs(group.realtime.resetsAtMs),
      durationMs,
    });
  }
  if (group?.weekly) {
    windows.push({
      id: 'weekly',
      label: '长期额度',
      kind: 'fixed',
      usedPercent: clampPercent(group.weekly.usedPercent),
      availablePercent: clampPercent(group.weekly.availablePercent),
      resetsAtMs: timestampToMs(group.weekly.resetsAtMs),
      durationMs: quotaDurationMs(group.weekly, 7 * DAY_MS),
    });
  }

  return {
    id: 'codex',
    label: 'GPT / Codex',
    provider: 'OpenAI',
    billingType: 'subscription',
    planName: 'ChatGPT 订阅',
    status: group ? (group.stale ? 'cached' : 'live') : 'unavailable',
    source: 'Codex 本地 rate limit',
    observedAtMs: timestampToMs(group?.observedAtMs),
    quotaAvailability: group ? 'local-signal' : 'unavailable',
    windows,
    models: [],
    message: group ? '已读取 Codex 本地额度信号' : '尚未读取到 Codex 额度信号',
  };
}

function flattenKimiModels(cache) {
  const models = new Map();
  for (const entry of Object.values(cache && typeof cache === 'object' ? cache : {})) {
    for (const model of Array.isArray(entry?.models) ? entry.models : []) {
      const id = String(model?.modelId || model?.id || '').trim();
      if (!id || models.has(id)) continue;
      models.set(id, {
        id,
        label: String(model?.displayName || model?.name || id),
      });
    }
  }
  return [...models.values()];
}

function jwtExpiryMs(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const expiresAtMs = coerceNumber(payload?.exp) * 1000;
    return Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null;
  } catch {
    return null;
  }
}

function accessTokenCandidates(buffer, nowMs) {
  const text = buffer.toString('latin1');
  const candidates = [];
  let offset = -1;

  while ((offset = text.indexOf('access_token', offset + 1)) >= 0) {
    const afterKey = text.slice(offset + 'access_token'.length, offset + 1400);
    const match = afterKey.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (!match || Number(match.index) > 128) continue;
    const expiresAtMs = jwtExpiryMs(match[0]);
    if (!expiresAtMs || expiresAtMs <= nowMs) continue;
    candidates.push({ token: match[0], expiresAtMs, offset });
  }

  return candidates;
}

async function readKimiAccessToken(kimiDataDir, nowMs) {
  const levelDbDir = path.join(kimiDataDir, 'Local Storage', 'leveldb');
  let names = [];
  try {
    names = await fs.readdir(levelDbDir);
  } catch {
    return '';
  }

  const files = [];
  for (const name of names.filter((entry) => /\.(?:log|ldb)$/i.test(entry))) {
    const filePath = path.join(levelDbDir, name);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_KIMI_STORAGE_FILE_BYTES) {
        continue;
      }
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Chromium may compact or replace LevelDB files while Kimi is running.
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const candidates = [];
  for (const file of files.slice(0, MAX_KIMI_STORAGE_FILES)) {
    try {
      const buffer = await fs.readFile(file.filePath);
      for (const candidate of accessTokenCandidates(buffer, nowMs)) {
        candidates.push({ ...candidate, mtimeMs: file.mtimeMs });
      }
    } catch {
      // A concurrently rotated file is best treated as an unavailable sample.
    }
  }

  candidates.sort((left, right) => (
    right.expiresAtMs - left.expiresAtMs
    || right.mtimeMs - left.mtimeMs
    || right.offset - left.offset
  ));
  return candidates[0]?.token || '';
}

function ratioPercent(value, enabled = true) {
  const ratio = coerceNumber(value);
  if (ratio === null) return enabled ? 0 : null;
  if (ratio < 0 || ratio > 1) return null;
  return Math.round(ratio * 10_000) / 100;
}

function safeLabel(value, fallback, maxLength = 80) {
  const label = String(value || '').trim().replaceAll(/[\u0000-\u001f\u007f]/g, ' ');
  return (label || fallback).slice(0, maxLength);
}

function kimiWindow({ id, label, kind, ratio, enabled = true, resetsAt, detail = '' }) {
  const usedPercent = ratioPercent(ratio, enabled);
  const resetsAtMs = timestampToMs(resetsAt);
  return {
    id,
    label,
    kind,
    usedPercent,
    availablePercent: usedPercent === null ? null : Math.round((100 - usedPercent) * 100) / 100,
    resetsAtMs,
    durationMs: id === 'monthly' ? monthlyDurationMs(resetsAtMs) : null,
    detail: safeLabel(detail, '', 80),
  };
}

function normalizeKimiQuota({ stats, subscription, models, nowMs }) {
  const activeSubscription = subscription?.subscription?.active
    ? subscription.subscription
    : (subscription?.purchaseSubscription?.active ? subscription.purchaseSubscription : null);
  const monthly = stats?.subscriptionBalance;
  if (!monthly || typeof monthly !== 'object') throw new Error('invalid quota response');

  const windows = [
    kimiWindow({
      id: 'monthly',
      label: '月度总额度',
      kind: 'fixed',
      ratio: monthly.amountUsedRatio,
      resetsAt: activeSubscription?.nextBillingTime || monthly.expireTime,
    }),
  ];

  return {
    id: 'kimi',
    label: 'Kimi',
    provider: 'Moonshot AI',
    billingType: 'subscription',
    planName: safeLabel(activeSubscription?.goods?.title, 'Kimi 会员'),
    status: 'live',
    source: 'Kimi 官方额度 API（客户端登录态）',
    observedAtMs: nowMs,
    quotaAvailability: 'official-api-via-client-session',
    windows,
    models,
    message: '已使用 Kimi 客户端当前登录态读取；登录凭证不会保存',
  };
}

async function fetchKimiJson(url, accessToken, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Authorization: `Bearer ${accessToken}`,
    },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (!response?.ok) throw new Error('quota request failed');
  const contentLength = coerceNumber(response.headers?.get?.('content-length'));
  if (contentLength !== null && contentLength > 1024 * 1024) {
    throw new Error('quota response too large');
  }
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid quota response');
  }
  return payload;
}

async function fetchKimiQuota({ accessToken, fetchImpl, models, nowMs }) {
  const subscriptionPromise = fetchKimiJson(KIMI_SUBSCRIPTION_URL, accessToken, fetchImpl)
    .catch(() => null);
  const stats = await fetchKimiJson(KIMI_SUBSCRIPTION_STATS_URL, accessToken, fetchImpl);
  const subscription = await subscriptionPromise;
  return normalizeKimiQuota({ stats, subscription, models, nowMs });
}

function sanitizedKimiCache(service, savedAtMs) {
  return {
    version: 1,
    savedAtMs,
    service: {
      id: 'kimi',
      planName: safeLabel(service?.planName, 'Kimi 会员'),
      observedAtMs: timestampToMs(service?.observedAtMs),
      windows: (Array.isArray(service?.windows) ? service.windows : [])
        .filter((window) => window?.id === 'monthly')
        .slice(0, 1)
        .map((window) => ({
          id: 'monthly',
          label: '月度总额度',
          kind: 'fixed',
          usedPercent: clampPercent(window?.usedPercent),
          availablePercent: clampPercent(window?.availablePercent),
          resetsAtMs: timestampToMs(window?.resetsAtMs),
          durationMs: coerceNumber(window?.durationMs) || monthlyDurationMs(window?.resetsAtMs),
          detail: '',
        })),
    },
  };
}

async function readKimiQuotaCache(cachePath, base) {
  if (!cachePath) return null;
  const cached = await readJson(cachePath, null);
  if (cached?.version !== 1 || cached?.service?.id !== 'kimi') return null;
  const sanitized = sanitizedKimiCache(cached.service, timestampToMs(cached.savedAtMs) || Date.now());
  if (!sanitized.service.windows.length) return null;
  return {
    ...base,
    planName: sanitized.service.planName,
    status: 'cached',
    source: 'Kimi 上次成功快照',
    observedAtMs: sanitized.service.observedAtMs,
    quotaAvailability: 'cached-snapshot',
    windows: sanitized.service.windows,
    message: '实时查询暂不可用；显示上次成功快照',
  };
}

async function cachedKimiQuota({ cacheKey, cacheMs, nowMs, load }) {
  const cached = kimiQuotaMemoryCache.get(cacheKey);
  if (cacheMs > 0 && cached?.expiresAtMs > nowMs) return cached.value;
  if (cacheMs > 0 && kimiQuotaInFlight.has(cacheKey)) return kimiQuotaInFlight.get(cacheKey);

  const pending = load();
  if (cacheMs > 0) kimiQuotaInFlight.set(cacheKey, pending);
  try {
    const value = await pending;
    if (cacheMs > 0) {
      kimiQuotaMemoryCache.set(cacheKey, {
        expiresAtMs: nowMs + cacheMs,
        value,
      });
    }
    return value;
  } finally {
    if (kimiQuotaInFlight.get(cacheKey) === pending) kimiQuotaInFlight.delete(cacheKey);
  }
}

async function kimiService({
  kimiDataDir,
  kimiAppInstalled,
  kimiQuotaCachePath,
  kimiQuotaCacheMs,
  kimiQuotaEnabled,
  fetchImpl,
  nowMs,
}) {
  const installed = kimiAppInstalled ?? await pathExists(DEFAULT_KIMI_APP_PATH);
  const agentDir = path.join(kimiDataDir, 'kimi-agent');
  const [modelsCache, capacity] = await Promise.all([
    readJson(path.join(agentDir, 'kimi-work-models-cache.json'), {}),
    readJson(path.join(agentDir, 'kimi-work-capacity.json'), {}),
  ]);
  const stateDetected = await pathExists(agentDir);
  const models = flattenKimiModels(modelsCache);
  const base = {
    id: 'kimi',
    label: 'Kimi',
    provider: 'Moonshot AI',
    billingType: 'subscription',
    planName: 'Kimi 会员',
    status: installed || stateDetected ? 'configured' : 'missing',
    source: 'Kimi 本地客户端',
    observedAtMs: null,
    quotaAvailability: 'external-only',
    windows: [],
    models,
    capacity: String(capacity?.capacity || ''),
  };

  if (!installed && !stateDetected) {
    return { ...base, status: 'missing', message: '未检测到 Kimi 本地客户端' };
  }
  if (!kimiQuotaEnabled) {
    return {
      ...base,
      status: 'configured',
      message: '实时额度读取已通过 AMC_KIMI_QUOTA=0 关闭',
    };
  }

  const persistentCache = await readKimiQuotaCache(kimiQuotaCachePath, base).catch(() => null);
  const cacheKey = `${kimiDataDir}\0${kimiQuotaCachePath || ''}`;

  try {
    const live = await cachedKimiQuota({
      cacheKey,
      cacheMs: kimiQuotaCacheMs,
      nowMs,
      load: async () => {
        const accessToken = await readKimiAccessToken(kimiDataDir, nowMs);
        if (!accessToken) return null;
        return fetchKimiQuota({ accessToken, fetchImpl, models, nowMs });
      },
    });
    if (live) {
      if (live.observedAtMs !== persistentCache?.observedAtMs) {
        await writeJsonAtomicPrivate(kimiQuotaCachePath, sanitizedKimiCache(live, nowMs)).catch(() => {});
      }
      return { ...live, capacity: base.capacity };
    }
    return persistentCache || {
      ...base,
      status: 'configured',
      message: '已检测到客户端；等待 Kimi 刷新登录态',
    };
  } catch {
    return persistentCache || {
      ...base,
      status: 'error',
      message: 'Kimi 额度查询失败；请确认客户端已登录',
    };
  }
}

function bailianService(cindyState, quotaCache, nowMs) {
  const provider = findProvider(cindyState.providers, (text) => (
    text.includes('token-plan.') || text.includes('token plan') || text.includes('coding.dashscope')
  ));
  const tokenPlan = provider && runtimeUrls(provider).some((url) => url.includes('token-plan.'));
  const snapshot = quotaCache?.snapshot;
  const cacheAgeMs = quotaCache?.savedAtMs == null ? null : Math.max(0, nowMs - quotaCache.savedAtMs);
  const fresh = cacheAgeMs !== null && cacheAgeMs <= 15 * 60_000;

  if (snapshot?.sevenDay) {
    return {
      id: 'bailian',
      label: '阿里百炼',
      provider: 'Alibaba Cloud',
      billingType: 'subscription',
      planName: snapshot.planName || (tokenPlan ? 'Token Plan（个人版）' : 'Coding Plan'),
      status: fresh ? 'live' : 'cached',
      source: fresh ? '百炼控制台浏览器桥接' : '百炼上次成功快照',
      observedAtMs: timestampToMs(snapshot.observedAtMs) || timestampToMs(quotaCache.savedAtMs),
      quotaAvailability: fresh ? 'browser-bridge' : 'cached-snapshot',
      planEndsAtMs: timestampToMs(snapshot.planEndsAtMs),
      windows: [{
        id: 'seven-day',
        label: '周期额度',
        kind: 'fixed',
        usedPercent: clampPercent(snapshot.sevenDay.usedPercent),
        availablePercent: clampPercent(snapshot.sevenDay.availablePercent),
        resetsAtMs: timestampToMs(snapshot.sevenDay.resetsAtMs),
        durationMs: 7 * DAY_MS,
      }],
      models: runtimeModels(provider || {}),
      message: fresh
        ? '已通过 Chrome 登录态读取百炼控制台；浏览器凭证不会进入 AMC'
        : 'Chrome 未运行或刷新暂不可用；显示上次成功的脱敏快照',
    };
  }

  return {
    id: 'bailian',
    label: '阿里百炼',
    provider: 'Alibaba Cloud',
    billingType: 'subscription',
    planName: tokenPlan ? 'Token Plan（个人版）' : (provider?.name || 'Coding Plan'),
    status: provider ? 'configured' : 'missing',
    source: provider ? 'Cindy 本地配置' : '未检测到',
    observedAtMs: null,
    quotaAvailability: 'external-only',
    planEndsAtMs: null,
    windows: [{
      id: 'seven-day',
      label: '周期额度',
      kind: 'fixed',
      usedPercent: null,
      availablePercent: null,
      resetsAtMs: null,
      durationMs: 7 * DAY_MS,
    }],
    models: runtimeModels(provider || {}),
    message: provider
      ? '已识别 Cindy 套餐；等待 Chrome 本地桥接写入额度快照'
      : '未检测到 Cindy 中的百炼套餐配置',
  };
}

function grokSnapshot(snapshots = []) {
  for (const row of snapshots) {
    const snapshot = parseJson(row.snapshot, null);
    if (!snapshot || typeof snapshot !== 'object') continue;
    const looksLikeGrok = row.agent_kind?.toLowerCase().includes('xai')
      || snapshot.source === 'cli-billing'
      || Object.hasOwn(snapshot, 'creditUsagePercent')
      || Array.isArray(snapshot.productUsage);
    if (looksLikeGrok) return { row, snapshot };
  }
  return null;
}

function grokModels(cindyState, productUsage = []) {
  const models = new Map();
  for (const row of cindyState.activityModels) {
    const id = String(row?.model || '').trim();
    if (id && !models.has(id)) models.set(id, { id, label: id });
  }
  for (const product of productUsage) {
    const label = String(product?.productName || product?.name || product?.product || '').trim();
    if (!label) continue;
    const id = label.toLowerCase().replaceAll(/\s+/g, '-');
    if (!models.has(id)) models.set(id, { id, label });
  }
  return [...models.values()];
}

function grokService(cindyState, directQuota = null) {
  const match = grokSnapshot(cindyState.snapshots);
  const direct = directQuota?.snapshot;
  const configured = Boolean(match)
    || cindyState.providers.some((provider) => (
      [provider.id, provider.name, ...runtimeUrls(provider)].join(' ').toLowerCase().includes('xai')
    ))
    || cindyState.activityModels.some((row) => /(^|[/_-])(xai|grok)([/_-]|$)/i.test(String(row.model || '')));
  const usedPercent = clampPercent(direct?.usedPercent ?? match?.snapshot?.creditUsagePercent);
  const balanceAmount = coerceNumber(direct?.prepaidBalance ?? match?.snapshot?.prepaidBalance);
  const observedAtMs = timestampToMs(direct?.observedAtMs)
    || timestampToMs(match?.snapshot?.updatedAt)
    || timestampToMs(match?.row?.updated_at);
  const productUsage = Array.isArray(direct?.productUsage)
    ? direct.productUsage
    : (Array.isArray(match?.snapshot?.productUsage) ? match.snapshot.productUsage : []);
  const hasQuota = Boolean(direct || match);
  const directLive = directQuota?.freshness === 'live';
  const productDetail = productUsage
    .slice(0, 3)
    .map((product) => {
      const label = String(product?.productName || product?.name || product?.product || '').trim();
      const value = clampPercent(product?.usagePercent ?? product?.usedPercent);
      return label && value !== null ? `${label} ${Number(value.toFixed(2))}%` : '';
    })
    .filter(Boolean)
    .join(' · ');

  return {
    id: 'grok',
    label: 'Grok',
    provider: 'xAI',
    billingType: 'subscription',
    planName: String(direct?.planName || match?.snapshot?.planLabel || 'X 会员额度'),
    status: directLive ? 'live' : (hasQuota ? 'cached' : (configured ? 'configured' : 'missing')),
    source: directLive
      ? 'xAI 用量接口（Cindy 登录态）'
      : (direct ? 'Grok 上次成功快照' : (match ? 'Cindy 脱敏额度快照' : (configured ? 'Cindy 本地用量' : '未检测到'))),
    observedAtMs,
    quotaAvailability: directLive ? 'official-api-via-client-session' : (hasQuota ? 'cached-snapshot' : 'external-only'),
    windows: hasQuota ? [{
      id: 'weekly',
      label: '共享额度',
      kind: 'fixed',
      usedPercent,
      availablePercent: usedPercent === null ? null : 100 - usedPercent,
      resetsAtMs: timestampToMs(direct?.resetsAtMs ?? match?.snapshot?.resetsAt),
      durationMs: 7 * DAY_MS,
      detail: productDetail,
    }] : [],
    balance: balanceAmount === null ? null : {
      amount: balanceAmount,
      currency: String(match?.snapshot?.prepaidCurrency || 'USD'),
    },
    models: grokModels(cindyState, productUsage),
    message: directLive
      ? '已使用 Cindy 当前 Grok 登录态直接读取；OAuth 令牌不会写入 AMC 快照'
      : (direct
        ? '实时查询暂不可用；显示上次成功的脱敏快照'
        : (match
          ? '已读取 Cindy 的脱敏快照'
          : (configured ? '已检测到 Grok 使用记录；等待可用的 Cindy 登录态' : '未检测到 Grok 配置或用量'))),
  };
}

async function fetchDeepSeekBalance({ apiKey, fetchImpl, nowMs }) {
  if (!apiKey) return null;
  const response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unknown'}`);
  const payload = await response.json();
  const entries = (Array.isArray(payload?.balance_infos) ? payload.balance_infos : [])
    .map((entry) => ({
      currency: String(entry?.currency || ''),
      total: coerceNumber(entry?.total_balance, 0),
      granted: coerceNumber(entry?.granted_balance, 0),
      toppedUp: coerceNumber(entry?.topped_up_balance, 0),
    }))
    .filter((entry) => entry.currency);

  return {
    available: Boolean(payload?.is_available),
    entries,
    observedAtMs: nowMs,
  };
}

function credentialFingerprint(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

async function cachedDeepSeekBalance({ apiKey, fetchImpl, nowMs, cacheMs }) {
  const fingerprint = credentialFingerprint(apiKey);
  if (
    cacheMs > 0
    && deepSeekBalanceCache?.fingerprint === fingerprint
    && deepSeekBalanceCache.expiresAtMs > nowMs
  ) {
    return deepSeekBalanceCache.promise;
  }

  const promise = fetchDeepSeekBalance({ apiKey, fetchImpl, nowMs });
  if (cacheMs <= 0) return promise;

  deepSeekBalanceCache = {
    fingerprint,
    expiresAtMs: nowMs + cacheMs,
    promise,
  };
  try {
    return await promise;
  } catch (error) {
    if (deepSeekBalanceCache?.promise === promise) deepSeekBalanceCache = null;
    throw error;
  }
}

export async function readCindyDeepSeekApiKey({ cindyDataDir, runCommand }) {
  const secret = await readCindyProviderSecret({
    cindyDataDir,
    providerId: 'deepseek',
    storageKeys: [
      'provider_key_deepseek_codex',
      'provider_key_deepseek_claude-code',
      'provider_key_deepseek',
    ],
    runCommand,
  });
  return typeof secret === 'string'
    && /^sk-[A-Za-z0-9_-]{16,512}$/.test(secret)
    ? secret
    : '';
}

async function deepSeekService({
  cindyState,
  apiKey,
  credentialSource,
  fetchImpl,
  nowMs,
  balanceCacheMs,
}) {
  const provider = findProvider(cindyState.providers, (text) => text.includes('api.deepseek.com'));
  const base = {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'DeepSeek',
    billingType: 'prepaid',
    planName: '预付费余额',
    source: apiKey && credentialSource === 'cindy-keychain'
      ? 'DeepSeek 官方余额 API（Cindy 登录态）'
      : (provider ? 'Cindy 本地配置' : '环境变量'),
    observedAtMs: null,
    quotaAvailability: apiKey ? 'official-api' : 'credential-required',
    windows: [],
    models: runtimeModels(provider || {}),
  };

  if (!apiKey) {
    return {
      ...base,
      status: provider ? 'configured' : 'missing',
      balance: null,
      message: provider
        ? '已识别 Cindy 配置；等待可用的 DeepSeek 凭证'
        : '设置 AMC_DEEPSEEK_API_KEY 后可读取官方余额',
    };
  }

  try {
    const balance = await cachedDeepSeekBalance({
      apiKey,
      fetchImpl,
      nowMs,
      cacheMs: balanceCacheMs,
    });
    return {
      ...base,
      status: 'live',
      source: credentialSource === 'cindy-keychain'
        ? 'DeepSeek 官方余额 API（Cindy Keychain）'
        : 'DeepSeek 官方余额 API',
      observedAtMs: balance.observedAtMs,
      balance,
      message: balance.available ? '余额可用' : '账户余额当前不可用',
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      balance: null,
      message: `余额查询失败（${error?.message || '未知错误'}）`,
    };
  }
}

export async function loadModelServices(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const runCommand = options.runCommand || execFileAsync;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const kimiDataDir = options.kimiDataDir || DEFAULT_KIMI_DATA_DIR;
  const kimiQuotaCachePath = Object.hasOwn(options, 'kimiQuotaCachePath')
    && options.kimiQuotaCachePath !== undefined
    ? options.kimiQuotaCachePath
    : (kimiDataDir === DEFAULT_KIMI_DATA_DIR ? DEFAULT_KIMI_QUOTA_CACHE_PATH : '');
  const bailianQuotaCachePath = Object.hasOwn(options, 'bailianQuotaCachePath')
    && options.bailianQuotaCachePath !== undefined
    ? options.bailianQuotaCachePath
    : (options.cindyDatabasePath || options.cindyDataDir ? '' : DEFAULT_BAILIAN_QUOTA_CACHE_PATH);
  const grokCindyDataDir = options.grokCindyDataDir
    ?? (options.cindyDatabasePath && !options.cindyDataDir ? '' : (options.cindyDataDir || DEFAULT_CINDY_DATA_DIR));
  const grokQuotaCachePath = Object.hasOwn(options, 'grokQuotaCachePath')
    && options.grokQuotaCachePath !== undefined
    ? options.grokQuotaCachePath
    : (grokCindyDataDir === DEFAULT_CINDY_DATA_DIR ? DEFAULT_GROK_QUOTA_CACHE_PATH : '');
  const usesCustomLocalState = Boolean(
    options.cindyDatabasePath
    || options.cindyDataDir
    || options.kimiDataDir
    || options.grokCindyDataDir
    || options.deepseekCindyDataDir,
  );
  const quotaHistoryPath = Object.hasOwn(options, 'quotaHistoryPath')
    && options.quotaHistoryPath !== undefined
    ? options.quotaHistoryPath
    : (usesCustomLocalState ? '' : DEFAULT_QUOTA_HISTORY_PATH);
  const cindyState = await readCindyState({
    cindyDatabasePath: options.cindyDatabasePath,
    cindyDataDir: options.cindyDataDir || DEFAULT_CINDY_DATA_DIR,
    runCommand,
  });

  const explicitDeepSeekApiKey = options.deepseekApiKey ?? process.env.AMC_DEEPSEEK_API_KEY ?? '';
  const deepSeekAutoCredentialEnabled = options.deepseekAutoCredentialEnabled
    ?? String(process.env.AMC_DEEPSEEK_BALANCE ?? '1').trim() !== '0';
  const deepSeekCindyDataDir = options.deepseekCindyDataDir
    ?? (options.cindyDatabasePath && !options.cindyDataDir ? '' : (options.cindyDataDir || DEFAULT_CINDY_DATA_DIR));
  let deepSeekApiKey = explicitDeepSeekApiKey;
  let deepSeekCredentialSource = explicitDeepSeekApiKey ? 'environment' : '';
  if (!deepSeekApiKey && deepSeekAutoCredentialEnabled && deepSeekCindyDataDir) {
    deepSeekApiKey = await (options.deepseekCredentialReader || readCindyDeepSeekApiKey)({
      cindyDataDir: deepSeekCindyDataDir,
      runCommand,
    }).catch(() => '');
    if (deepSeekApiKey) deepSeekCredentialSource = 'cindy-keychain';
  }

  const [kimi, bailianQuota, grokQuota, deepseek] = await Promise.all([
    kimiService({
      kimiDataDir,
      kimiAppInstalled: options.kimiAppInstalled,
      kimiQuotaCachePath,
      kimiQuotaCacheMs: options.kimiQuotaCacheMs ?? DEFAULT_KIMI_QUOTA_CACHE_MS,
      kimiQuotaEnabled: options.kimiQuotaEnabled
        ?? String(process.env.AMC_KIMI_QUOTA ?? '1').trim() !== '0',
      fetchImpl,
      nowMs,
    }),
    readBailianQuotaSnapshot(bailianQuotaCachePath),
    loadGrokQuota({
      cindyDataDir: grokCindyDataDir,
      cachePath: grokQuotaCachePath,
      cacheMs: options.grokQuotaCacheMs ?? DEFAULT_BALANCE_CACHE_MS,
      enabled: options.grokQuotaEnabled
        ?? String(process.env.AMC_GROK_QUOTA ?? '1').trim() !== '0',
      credentialReader: options.grokCredentialReader,
      fetchImpl,
      runCommand,
      nowMs,
    }),
    deepSeekService({
      cindyState,
      apiKey: deepSeekApiKey,
      credentialSource: deepSeekCredentialSource,
      fetchImpl,
      nowMs,
      balanceCacheMs: options.balanceCacheMs ?? DEFAULT_BALANCE_CACHE_MS,
    }),
  ]);

  const services = [
    codexService(options.codexQuota),
    kimi,
    bailianService(cindyState, bailianQuota, nowMs),
    grokService(cindyState, grokQuota),
    deepseek,
  ];
  return attachQuotaHistory(services, { filePath: quotaHistoryPath, nowMs }).catch(() => services);
}
