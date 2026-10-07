import { loadCodexCliProvider, loadCodexDashboard } from './codex-data.mjs';
import { loadClaudeAgentThreads } from './claude-data.mjs';
import { loadCindyThreads, reconcileCindyOwnedHarnessThreads } from './cindy-data.mjs';
import { loadOpenCodeThreads } from './opencode-data.mjs';
import { buildDashboard } from './insights.mjs';
import { loadModelServices } from './model-services.mjs';

function codexProvider(dashboard) {
  const threadCount = (dashboard?.threads || [])
    .filter((thread) => (thread.provider || 'codex') === 'codex').length;
  return {
    id: 'codex',
    label: 'Codex',
    installed: true,
    status: 'ready',
    message: threadCount ? `已读取 ${threadCount} 项 Codex 任务` : '已接入，暂无任务',
    threadCount,
  };
}

export function reconcileProviderThreadCounts(providers = [], threads = []) {
  const countByProvider = new Map();
  for (const thread of threads) {
    const providerId = String(thread?.provider || '');
    if (!providerId) continue;
    countByProvider.set(providerId, (countByProvider.get(providerId) || 0) + 1);
  }

  return providers.flatMap((provider) => {
    const threadCount = countByProvider.get(provider.id) || 0;
    const originalCount = Number(provider.threadCount || 0);
    const reassignedCount = Math.max(0, originalCount - threadCount);
    if (!reassignedCount) return [{ ...provider, threadCount }];
    if (threadCount === 0) return [];

    return [{
      ...provider,
      threadCount,
      message: `已读取 ${threadCount} 个独立任务；${reassignedCount} 个底层会话已归属宿主客户端`,
    }];
  });
}

export async function loadDashboard(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const [codexDashboard, openCodeResult, claudeResult, cindyResult] = await Promise.all([
    loadCodexDashboard({ ...options, nowMs }),
    loadOpenCodeThreads({
      nowMs,
      runOpenCode: options.runOpenCode,
      maxCount: options.openCodeMaxCount,
      desktopDataDir: options.openCodeDesktopDataDir,
    }),
    loadClaudeAgentThreads({
      nowMs,
      runCommand: options.runClaudeCommand,
      maxCount: options.claudeMaxCount,
      projectsDir: options.claudeProjectsDir,
      appDir: options.claudeAppDir,
    }),
    loadCindyThreads({
      nowMs,
      cindyDatabasePath: options.cindyDatabasePath,
      cindyDataDir: options.cindyDataDir,
      maxCount: options.cindyMaxCount,
      runCommand: options.runCindyCommand,
    }),
  ]);
  const codexCliThreadCount = (codexDashboard.threads || [])
    .filter((thread) => thread.provider === 'codex-cli').length;
  const codexCli = await loadCodexCliProvider({
    runCommand: options.runCodexCommand,
    threadCount: codexCliThreadCount,
  });
  const providerResults = [
    codexProvider(codexDashboard),
    codexCli,
    cindyResult.provider,
    openCodeResult.provider,
    ...claudeResult.providers,
  ];
  const reconciledThreads = reconcileCindyOwnedHarnessThreads([
    ...(codexDashboard.threads || []),
    ...(openCodeResult.threads || []),
    ...(claudeResult.threads || []),
  ], cindyResult);
  const providers = reconcileProviderThreadCounts(providerResults, reconciledThreads);
  const dashboard = buildDashboard(reconciledThreads, nowMs);
  const codexResets = codexDashboard.summary?.quota?.codexResets || null;
  const quota = {
    ...dashboard.summary.quota,
    codexResets,
  };
  const modelServices = await loadModelServices({
    nowMs,
    codexQuota: quota,
    cindyDatabasePath: options.cindyDatabasePath,
    cindyDataDir: options.cindyDataDir,
    kimiDataDir: options.kimiDataDir,
    kimiAppInstalled: options.kimiAppInstalled,
    kimiQuotaCachePath: options.kimiQuotaCachePath,
    kimiQuotaCacheMs: options.kimiQuotaCacheMs,
    kimiQuotaEnabled: options.kimiQuotaEnabled,
    bailianQuotaCachePath: options.bailianQuotaCachePath,
    grokCindyDataDir: options.grokCindyDataDir,
    grokQuotaCachePath: options.grokQuotaCachePath,
    grokQuotaCacheMs: options.grokQuotaCacheMs,
    grokQuotaEnabled: options.grokQuotaEnabled,
    grokCredentialReader: options.grokCredentialReader,
    deepseekCindyDataDir: options.deepseekCindyDataDir,
    deepseekAutoCredentialEnabled: options.deepseekAutoCredentialEnabled,
    deepseekCredentialReader: options.deepseekCredentialReader,
    deepseekApiKey: options.deepseekApiKey,
    fetchImpl: options.fetchModelService || options.fetchImpl,
    runCommand: options.runModelServiceCommand,
    balanceCacheMs: options.modelBalanceCacheMs,
    quotaHistoryPath: options.quotaHistoryPath,
  });

  return {
    ...dashboard,
    providers,
    summary: {
      ...dashboard.summary,
      providers,
      quota,
      modelServices,
    },
  };
}
