import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadModelServices } from '../src/model-services.mjs';

const execFileAsync = promisify(execFile);

async function createCindyDatabase(directory) {
  const databasePath = path.join(directory, 'cindy-test.db');
  const tokenPlanRuntimes = JSON.stringify({
    codex: {
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      models: [
        { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
  });
  const deepSeekRuntimes = JSON.stringify({
    codex: {
      baseUrl: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
  });
  const grokSnapshot = JSON.stringify({
    planLabel: 'X Premium+',
    creditUsagePercent: 36,
    resetsAt: '2026-08-24T08:00:00.000Z',
    prepaidBalance: 12.5,
    productUsage: [{ productName: 'Grok 4', usedPercent: 42 }],
    source: 'cli-billing',
    updatedAt: '2026-08-21T03:00:00.000Z',
    accountFingerprint: 'safe-fingerprint',
  });
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const sql = `
    CREATE TABLE custom_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      runtimes TEXT NOT NULL
    );
    CREATE TABLE account_usage_snapshots (
      agent_kind TEXT PRIMARY KEY,
      snapshot TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE daily_model_usage (
      day TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      model TEXT NOT NULL
    );
    INSERT INTO custom_providers VALUES
      ('token-plan', '阿里云百炼 Token Plan（个人版）', ${quote(tokenPlanRuntimes)}),
      ('deepseek', 'DeepSeek', ${quote(deepSeekRuntimes)});
    INSERT INTO account_usage_snapshots VALUES
      ('xai', ${quote(grokSnapshot)}, ${Date.parse('2026-08-21T03:00:00.000Z')});
    INSERT INTO daily_model_usage VALUES
      ('2026-08-21', 'claude-code', 'xai/grok-4');
  `;
  await execFileAsync('sqlite3', [databasePath, sql]);
  return databasePath;
}

async function createKimiState(directory) {
  const agentDirectory = path.join(directory, 'kimi-agent');
  await fs.mkdir(agentDirectory, { recursive: true });
  await fs.writeFile(path.join(agentDirectory, 'kimi-work-capacity.json'), JSON.stringify({
    capacity: 'extended',
  }));
  await fs.writeFile(path.join(agentDirectory, 'kimi-work-models-cache.json'), JSON.stringify({
    latest: {
      models: [
        { modelId: 'k3-agent', displayName: 'K3' },
        { modelId: 'k3-agent-swarm', displayName: 'K3 集群' },
      ],
    },
  }));
}

function fakeJwt(payload = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ padding: 'x'.repeat(420), ...payload })}.test-signature`;
}

async function createKimiLoginState(directory, token) {
  const levelDbDirectory = path.join(directory, 'Local Storage', 'leveldb');
  await fs.mkdir(levelDbDirectory, { recursive: true });
  await fs.writeFile(
    path.join(levelDbDirectory, '000001.log'),
    Buffer.from(`leveldb-record\u0000access_token\u0001${token}\u0000record-end`, 'utf8'),
  );
}

test('loads a normalized five-service quota portfolio without exposing credentials', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kimiDataDir = path.join(directory, 'kimi-desktop');
  const nowMs = Date.parse('2026-08-21T04:00:00.000Z');
  await createKimiState(kimiDataDir);
  const kimiToken = fakeJwt({ exp: Math.floor((nowMs + 3_600_000) / 1000), sub: 'local-test' });
  await createKimiLoginState(kimiDataDir, kimiToken);
  const cindyDatabasePath = await createCindyDatabase(directory);
  const bailianQuotaCachePath = path.join(directory, 'bailian-quota.json');
  await fs.writeFile(bailianQuotaCachePath, JSON.stringify({
    version: 1,
    savedAtMs: nowMs - 30_000,
    snapshot: {
      planName: 'Pro 套餐',
      observedAtMs: nowMs - 31_000,
      planEndsAtMs: Date.parse('2026-09-03T16:00:00.000Z'),
      sevenDay: {
        usedPercent: 45.95,
        availablePercent: 54.05,
        resetsAtMs: Date.parse('2026-08-24T06:06:00.000Z'),
      },
    },
  }));
  const calls = [];

  const services = await loadModelServices({
    nowMs,
    cindyDatabasePath,
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaCachePath: path.join(directory, 'kimi-quota.json'),
    kimiQuotaCacheMs: 0,
    bailianQuotaCachePath,
    deepseekApiKey: 'test-secret-key',
    balanceCacheMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/GetSubscriptionStats')) {
        return {
          ok: true,
          json: async () => ({
            ratelimitCode5h: {
              enabled: true,
              resetTime: '2026-08-21T10:56:00.000000000Z',
            },
            ratelimitCode7d: {
              enabled: true,
              ratio: 0.12,
              resetTime: '2026-08-28T05:56:00.000000000Z',
            },
            subscriptionBalance: {
              amountUsedRatio: 0.0131,
              kimiCodeUsedRatio: 0,
              expireTime: '2026-09-15T00:00:00Z',
            },
            giftBalances: [{
              displayName: 'Invite to Earn Credit',
              amountUsedRatio: 0,
              expireTime: '2026-12-31T00:00:00Z',
            }],
          }),
        };
      }
      if (url.endsWith('/GetSubscription')) {
        return {
          ok: true,
          json: async () => ({
            subscribed: true,
            subscription: {
              active: true,
              nextBillingTime: '2026-09-15T00:00:00.000Z',
              goods: { title: 'Allegro' },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: '88.20',
            granted_balance: '8.20',
            topped_up_balance: '80.00',
          }],
        }),
      };
    },
    codexQuota: {
      groups: [{
        key: 'gpt',
        label: 'GPT',
        observedAtMs: nowMs - 60_000,
        realtime: { usedPercent: 25, availablePercent: 75, resetsAtMs: nowMs + 60_000 },
        weekly: { usedPercent: 40, availablePercent: 60, resetsAtMs: nowMs + 86_400_000 },
      }],
    },
  });

  assert.deepEqual(services.map((service) => service.id), [
    'codex',
    'kimi',
    'bailian',
    'grok',
    'deepseek',
  ]);

  const codex = services[0];
  assert.equal(codex.billingType, 'subscription');
  assert.equal(codex.status, 'live');
  assert.equal(codex.windows[0].availablePercent, 75);
  assert.equal(codex.windows[1].availablePercent, 60);
  assert.equal(codex.windows[1].durationMs, 7 * 24 * 60 * 60 * 1000);

  const kimi = services[1];
  assert.equal(kimi.status, 'live');
  assert.equal(kimi.source, 'Kimi 官方额度 API（客户端登录态）');
  assert.equal(kimi.planName, 'Allegro');
  assert.deepEqual(kimi.models.map((model) => model.id), ['k3-agent', 'k3-agent-swarm']);
  assert.equal(kimi.quotaAvailability, 'official-api-via-client-session');
  assert.deepEqual(kimi.windows.map((window) => ({
    id: window.id,
    usedPercent: window.usedPercent,
    availablePercent: window.availablePercent,
  })), [
    { id: 'monthly', usedPercent: 1.31, availablePercent: 98.69 },
  ]);
  assert.equal(kimi.windows[0].resetsAtMs, Date.parse('2026-09-15T00:00:00.000Z'));
  assert.equal(kimi.windows[0].durationMs, 31 * 24 * 60 * 60 * 1000);
  assert.equal(kimi.windows[0].detail, '');

  const bailian = services[2];
  assert.equal(bailian.planName, 'Pro 套餐');
  assert.equal(bailian.billingType, 'subscription');
  assert.equal(bailian.status, 'live');
  assert.equal(bailian.quotaAvailability, 'browser-bridge');
  assert.equal(bailian.windows.length, 1);
  assert.equal(bailian.windows[0].id, 'seven-day');
  assert.equal(bailian.windows[0].usedPercent, 45.95);
  assert.equal(bailian.windows[0].availablePercent, 54.05);
  assert.equal(bailian.windows[0].resetsAtMs, Date.parse('2026-08-24T06:06:00.000Z'));
  assert.equal(bailian.windows[0].durationMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(bailian.planEndsAtMs, Date.parse('2026-09-03T16:00:00.000Z'));
  assert.deepEqual(bailian.models.map((model) => model.id), ['qwen3.8-max', 'deepseek-v4-pro']);

  const grok = services[3];
  assert.equal(grok.status, 'cached');
  assert.equal(grok.planName, 'X Premium+');
  assert.equal(grok.windows[0].usedPercent, 36);
  assert.equal(grok.windows[0].availablePercent, 64);
  assert.equal(grok.windows[0].resetsAtMs, Date.parse('2026-08-24T08:00:00.000Z'));
  assert.equal(grok.windows[0].durationMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(grok.balance.amount, 12.5);

  const deepseek = services[4];
  assert.equal(deepseek.billingType, 'prepaid');
  assert.equal(deepseek.status, 'live');
  assert.equal(deepseek.balance.available, true);
  assert.deepEqual(deepseek.balance.entries, [{
    currency: 'CNY',
    total: 88.2,
    granted: 8.2,
    toppedUp: 80,
  }]);
  assert.deepEqual(deepseek.models.map((model) => model.id), ['deepseek-chat']);

  assert.equal(calls.length, 3);
  const deepSeekCall = calls.find((call) => call.url === 'https://api.deepseek.com/user/balance');
  const kimiCalls = calls.filter((call) => call.url.includes('MembershipService'));
  assert.equal(deepSeekCall.options.headers.Authorization, 'Bearer test-secret-key');
  assert.equal(kimiCalls.length, 2);
  assert.equal(kimiCalls.every((call) => call.options.headers.Authorization === `Bearer ${kimiToken}`), true);
  assert.equal(kimiCalls.every((call) => call.options.headers['Accept-Language'] === 'zh-CN'), true);
  assert.equal(JSON.stringify(services).includes('test-secret-key'), false);
  assert.equal(JSON.stringify(services).includes(kimiToken), false);
  assert.equal(JSON.stringify(services).includes('safe-fingerprint'), false);

  const kimiCache = await fs.readFile(path.join(directory, 'kimi-quota.json'), 'utf8');
  assert.equal(kimiCache.includes(kimiToken), false);
  assert.equal(kimiCache.includes('refresh_token'), false);
  assert.equal(JSON.parse(kimiCache).service.windows[0].availablePercent, 98.69);
});

test('falls back to the last sanitized Kimi quota snapshot when the live request fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-kimi-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kimiDataDir = path.join(directory, 'kimi-desktop');
  const cachePath = path.join(directory, 'kimi-quota.json');
  const nowMs = Date.parse('2026-08-21T04:00:00.000Z');
  const kimiToken = fakeJwt({ exp: Math.floor((nowMs + 3_600_000) / 1000) });
  await createKimiState(kimiDataDir);
  await createKimiLoginState(kimiDataDir, kimiToken);

  const liveFetch = async (url) => {
    if (url.endsWith('/GetSubscriptionStats')) {
      return {
        ok: true,
        json: async () => ({
          subscriptionBalance: { amountUsedRatio: 0.25, expireTime: '2026-09-15T00:00:00Z' },
        }),
      };
    }
    if (url.endsWith('/GetSubscription')) {
      return {
        ok: true,
        json: async () => ({
          subscribed: true,
          subscription: { active: true, goods: { title: 'Allegro' } },
        }),
      };
    }
    throw new Error('unexpected URL');
  };

  const live = await loadModelServices({
    nowMs,
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaCachePath: cachePath,
    kimiQuotaCacheMs: 0,
    fetchImpl: liveFetch,
  });
  assert.equal(live.find((service) => service.id === 'kimi').status, 'live');

  const cached = await loadModelServices({
    nowMs: nowMs + 60_000,
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaCachePath: cachePath,
    kimiQuotaCacheMs: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: `credential leaked: ${kimiToken}` }),
    }),
  });
  const kimi = cached.find((service) => service.id === 'kimi');
  assert.equal(kimi.status, 'cached');
  assert.equal(kimi.windows[0].availablePercent, 75);
  assert.match(kimi.message, /上次成功快照/);
  assert.equal(JSON.stringify(kimi).includes(kimiToken), false);
});

test('keeps only the Kimi monthly total when reading a legacy quota snapshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-kimi-legacy-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kimiDataDir = path.join(directory, 'kimi-desktop');
  const cachePath = path.join(directory, 'kimi-quota.json');
  const nowMs = Date.parse('2026-08-21T04:00:00.000Z');
  await createKimiState(kimiDataDir);
  await fs.writeFile(cachePath, JSON.stringify({
    version: 1,
    savedAtMs: nowMs - 60_000,
    service: {
      id: 'kimi',
      planName: 'Allegro',
      observedAtMs: nowMs - 60_000,
      windows: [
        {
          id: 'monthly',
          label: '月度总额度',
          kind: 'fixed',
          usedPercent: 20,
          availablePercent: 80,
          resetsAtMs: Date.parse('2026-09-15T00:00:00.000Z'),
          detail: '其中 Code 10%',
        },
        {
          id: 'seven-day-code',
          label: '7 天 Code',
          kind: 'fixed',
          usedPercent: 10,
          availablePercent: 90,
          resetsAtMs: Date.parse('2026-08-28T05:56:00.000Z'),
        },
      ],
    },
  }));

  const services = await loadModelServices({
    nowMs,
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaCachePath: cachePath,
    kimiQuotaCacheMs: 0,
    fetchImpl: async () => {
      throw new Error('should not fetch without a valid access token');
    },
  });

  const kimi = services.find((service) => service.id === 'kimi');
  assert.equal(kimi.status, 'cached');
  assert.deepEqual(kimi.windows, [{
    id: 'monthly',
    label: '月度总额度',
    kind: 'fixed',
    usedPercent: 20,
    availablePercent: 80,
    resetsAtMs: Date.parse('2026-09-15T00:00:00.000Z'),
    durationMs: 31 * 24 * 60 * 60 * 1000,
    detail: '',
  }]);
});

test('does not call Kimi APIs when the only local access token is expired', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-kimi-expired-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kimiDataDir = path.join(directory, 'kimi-desktop');
  const nowMs = Date.parse('2026-08-21T04:00:00.000Z');
  await createKimiState(kimiDataDir);
  await createKimiLoginState(
    kimiDataDir,
    fakeJwt({ exp: Math.floor((nowMs - 60_000) / 1000) }),
  );
  let fetchCount = 0;

  const services = await loadModelServices({
    nowMs,
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaCachePath: path.join(directory, 'missing-cache.json'),
    kimiQuotaCacheMs: 0,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error('should not fetch');
    },
  });

  const kimi = services.find((service) => service.id === 'kimi');
  assert.equal(fetchCount, 0);
  assert.equal(kimi.status, 'configured');
  assert.match(kimi.message, /等待 Kimi 刷新登录态/);
});

test('supports disabling Kimi login-state access without calling the network', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-kimi-disabled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kimiDataDir = path.join(directory, 'kimi-desktop');
  const nowMs = Date.parse('2026-08-21T04:00:00.000Z');
  await createKimiState(kimiDataDir);
  await createKimiLoginState(
    kimiDataDir,
    fakeJwt({ exp: Math.floor((nowMs + 3_600_000) / 1000) }),
  );
  let fetchCount = 0;

  const services = await loadModelServices({
    nowMs,
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaEnabled: false,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error('should not fetch');
    },
  });

  const kimi = services.find((service) => service.id === 'kimi');
  assert.equal(fetchCount, 0);
  assert.equal(kimi.status, 'configured');
  assert.match(kimi.message, /AMC_KIMI_QUOTA=0/);
});

test('throttles repeated Kimi quota reads to one request pair per minute', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-kimi-throttle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kimiDataDir = path.join(directory, 'kimi-desktop');
  const nowMs = Date.parse('2026-08-21T04:00:00.000Z');
  await createKimiState(kimiDataDir);
  await createKimiLoginState(
    kimiDataDir,
    fakeJwt({ exp: Math.floor((nowMs + 3_600_000) / 1000) }),
  );
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount += 1;
    if (url.endsWith('/GetSubscriptionStats')) {
      return {
        ok: true,
        json: async () => ({
          subscriptionBalance: { amountUsedRatio: 0.1, expireTime: '2026-09-15T00:00:00Z' },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ subscription: { active: true, goods: { title: 'Allegro' } } }),
    };
  };
  const options = {
    nowMs,
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir,
    kimiAppInstalled: true,
    kimiQuotaCachePath: '',
    kimiQuotaCacheMs: 60_000,
    fetchImpl,
  };

  const first = await loadModelServices(options);
  const second = await loadModelServices({ ...options, nowMs: nowMs + 30_000 });

  assert.equal(fetchCount, 2);
  assert.equal(first.find((service) => service.id === 'kimi').status, 'live');
  assert.equal(second.find((service) => service.id === 'kimi').observedAtMs, nowMs);
});

test('keeps configured services visible when live quota credentials or snapshots are unavailable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-empty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cindyDatabasePath = await createCindyDatabase(directory);
  await execFileAsync('sqlite3', [cindyDatabasePath, "DELETE FROM account_usage_snapshots;"]);

  const services = await loadModelServices({
    cindyDatabasePath,
    kimiDataDir: path.join(directory, 'missing-kimi'),
    kimiAppInstalled: false,
    deepseekApiKey: '',
    codexQuota: { groups: [] },
  });

  assert.equal(services.find((service) => service.id === 'codex').status, 'unavailable');
  assert.equal(services.find((service) => service.id === 'kimi').status, 'missing');
  assert.equal(services.find((service) => service.id === 'grok').status, 'configured');
  assert.equal(services.find((service) => service.id === 'deepseek').status, 'configured');
});

test('prefers live Grok quota from the Cindy login state and keeps actual activity models', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-grok-live-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cindyDatabasePath = await createCindyDatabase(directory);
  await execFileAsync('sqlite3', [cindyDatabasePath, "DELETE FROM account_usage_snapshots;"]);
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  const secret = 'grok-oauth-secret-for-test';

  const services = await loadModelServices({
    nowMs,
    cindyDatabasePath,
    grokCindyDataDir: directory,
    grokQuotaCachePath: path.join(directory, 'grok-quota.json'),
    grokQuotaCacheMs: 0,
    kimiDataDir: path.join(directory, 'missing-kimi'),
    kimiAppInstalled: false,
    deepseekApiKey: '',
    grokCredentialReader: async () => ({ accessToken: secret, expiresAtMs: nowMs + 60_000 }),
    fetchImpl: async (url, options) => {
      if (url.endsWith('/settings')) {
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => ({ subscription_tier_display: 'X Premium' }),
        };
      }
      if (url.includes('/billing?')) {
        assert.equal(options.headers.Authorization, `Bearer ${secret}`);
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            creditUsagePercent: 56,
            billingPeriodEnd: '2026-08-22T14:59:07.246Z',
            productUsage: [{ product: 'GrokBuild', usagePercent: 56 }],
            prepaidBalance: 0,
          }),
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const grok = services.find((service) => service.id === 'grok');
  assert.equal(grok.status, 'live');
  assert.equal(grok.planName, 'X Premium');
  assert.equal(grok.windows[0].usedPercent, 56);
  assert.equal(grok.windows[0].availablePercent, 44);
  assert.equal(grok.windows[0].detail, 'GrokBuild 56%');
  assert.deepEqual(grok.models.map((model) => model.id), ['xai/grok-4', 'grokbuild']);
  assert.equal(JSON.stringify(grok).includes(secret), false);
});

test('contains DeepSeek balance failures and never prevents the remaining portfolio from loading', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cindyDatabasePath = await createCindyDatabase(directory);

  const services = await loadModelServices({
    cindyDatabasePath,
    kimiDataDir: path.join(directory, 'missing-kimi'),
    deepseekApiKey: 'test-secret-key',
    balanceCacheMs: 0,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  const deepseek = services.find((service) => service.id === 'deepseek');
  assert.equal(deepseek.status, 'error');
  assert.match(deepseek.message, /余额查询失败/);
  assert.equal(JSON.stringify(deepseek).includes('test-secret-key'), false);
  assert.equal(services.length, 5);
});

test('reads the official DeepSeek balance with the Cindy Keychain credential by default', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-deepseek-cindy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cindyDatabasePath = await createCindyDatabase(directory);
  const secret = 'deepseek-cindy-test-secret';
  let credentialReads = 0;

  const services = await loadModelServices({
    nowMs: Date.parse('2026-08-21T12:00:00.000Z'),
    cindyDatabasePath,
    deepseekCindyDataDir: directory,
    deepseekCredentialReader: async () => {
      credentialReads += 1;
      return secret;
    },
    deepseekApiKey: '',
    balanceCacheMs: 0,
    kimiDataDir: path.join(directory, 'missing-kimi'),
    kimiAppInstalled: false,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance');
      assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      return {
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: '1022.89',
            granted_balance: '0',
            topped_up_balance: '1022.89',
          }],
        }),
      };
    },
  });

  const deepseek = services.find((service) => service.id === 'deepseek');
  assert.equal(credentialReads, 1);
  assert.equal(deepseek.status, 'live');
  assert.equal(deepseek.source, 'DeepSeek 官方余额 API（Cindy Keychain）');
  assert.equal(deepseek.balance.entries[0].total, 1022.89);
  assert.equal(JSON.stringify(deepseek).includes(secret), false);
});

test('can disable automatic Cindy DeepSeek credential access', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-services-deepseek-disabled-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cindyDatabasePath = await createCindyDatabase(directory);
  let credentialReads = 0;

  const services = await loadModelServices({
    cindyDatabasePath,
    deepseekCindyDataDir: directory,
    deepseekAutoCredentialEnabled: false,
    deepseekCredentialReader: async () => {
      credentialReads += 1;
      return 'sk-should-not-be-read';
    },
    deepseekApiKey: '',
    kimiDataDir: path.join(directory, 'missing-kimi'),
    kimiAppInstalled: false,
  });

  const deepseek = services.find((service) => service.id === 'deepseek');
  assert.equal(credentialReads, 0);
  assert.equal(deepseek.status, 'configured');
});

test('throttles repeated DeepSeek balance reads without caching the credential', async () => {
  let fetchCount = 0;
  const options = {
    nowMs: Date.parse('2026-08-21T04:00:00.000Z'),
    cindyDatabasePath: '/missing/cindy.db',
    kimiDataDir: '/missing/kimi',
    kimiAppInstalled: false,
    deepseekApiKey: 'cache-test-secret',
    balanceCacheMs: 60_000,
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({ is_available: true, balance_infos: [] }),
      };
    },
  };

  const first = await loadModelServices(options);
  const second = await loadModelServices({ ...options, nowMs: options.nowMs + 30_000 });

  assert.equal(fetchCount, 1);
  assert.equal(first.find((service) => service.id === 'deepseek').status, 'live');
  assert.equal(second.find((service) => service.id === 'deepseek').status, 'live');
  assert.equal(JSON.stringify(second).includes('cache-test-secret'), false);
});
