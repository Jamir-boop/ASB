import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(root, 'extensions', 'bailian-quota-bridge');

test('Bailian extension has narrow permissions and no cookie access', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage']);
  assert.deepEqual(manifest.host_permissions.sort(), [
    'http://127.0.0.1:4629/*',
    'https://bailian.console.aliyun.com/*',
  ]);
  assert.equal(JSON.stringify(manifest).includes('cookies'), false);
});

test('Bailian extension extracts only the sanitized quota snapshot', async () => {
  const source = await fs.readFile(path.join(extensionDir, 'extract.js'), 'utf8');
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: 'extract.js' });

  const snapshot = context.globalThis.AmcBailianQuota.parseQuotaText({
    quotaText: `
      套餐额度
      最后统计时间 2026-08-21 18:29:28
      7天限额
      将于 2026-08-24 14:06:00 (UTC+8) 重置刷新
      45.95% 已用
      套餐专属 API Key sk-sp-HIDDEN
    `,
    subscriptionText: `
      Pro 套餐
      剩余天数 13 天
      开始时间 2026-08-03 13:50:04
      结束时间 2026-09-04 00:00:00
    `,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    version: 1,
    planName: 'Pro 套餐',
    observedAt: '2026-08-21T10:29:28.000Z',
    planEndsAt: '2026-09-03T16:00:00.000Z',
    sevenDay: {
      usedPercent: 45.95,
      resetsAt: '2026-08-24T06:06:00.000Z',
    },
  });
  assert.equal(JSON.stringify(snapshot).includes('HIDDEN'), false);
  assert.equal(JSON.stringify(snapshot).includes('API Key'), false);
});
