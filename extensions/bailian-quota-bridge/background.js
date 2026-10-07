const CONSOLE_URL = 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal';
const LOCAL_ENDPOINT = 'http://127.0.0.1:4629/api/model-services/bailian-snapshot';
const REFRESH_ALARM = 'amc-bailian-refresh';
const CLEANUP_PREFIX = 'amc-bailian-cleanup:';
const MANAGED_TABS_KEY = 'managedBailianTabs';

async function managedTabs() {
  const stored = await chrome.storage.session.get(MANAGED_TABS_KEY);
  return Array.isArray(stored[MANAGED_TABS_KEY]) ? stored[MANAGED_TABS_KEY] : [];
}

async function saveManagedTabs(tabIds) {
  await chrome.storage.session.set({
    [MANAGED_TABS_KEY]: [...new Set(tabIds.filter(Number.isInteger))].slice(-4),
  });
}

async function forgetManagedTab(tabId) {
  await saveManagedTabs((await managedTabs()).filter((candidate) => candidate !== tabId));
  await chrome.alarms.clear(`${CLEANUP_PREFIX}${tabId}`);
}

async function closeManagedTab(tabId) {
  const isManaged = (await managedTabs()).includes(tabId);
  if (!isManaged) return;
  await chrome.tabs.remove(tabId).catch(() => {});
  await forgetManagedTab(tabId);
}

function sanitizedSnapshot(input) {
  const usedPercent = Number(input?.sevenDay?.usedPercent);
  const observedAt = Date.parse(String(input?.observedAt || ''));
  const planEndsAt = input?.planEndsAt ? Date.parse(String(input.planEndsAt)) : null;
  const resetsAt = Date.parse(String(input?.sevenDay?.resetsAt || ''));
  const planName = String(input?.planName || '').trim();
  if (
    input?.version !== 1
    || !Number.isFinite(usedPercent)
    || usedPercent < 0
    || usedPercent > 100
    || !Number.isFinite(observedAt)
    || (planEndsAt !== null && !Number.isFinite(planEndsAt))
    || !Number.isFinite(resetsAt)
    || !/^[\p{L}\p{N} ._+()（）-]{1,48}$/u.test(planName)
  ) return null;

  return {
    version: 1,
    planName,
    observedAt: new Date(observedAt).toISOString(),
    planEndsAt: planEndsAt === null ? null : new Date(planEndsAt).toISOString(),
    sevenDay: {
      usedPercent: Math.round(usedPercent * 100) / 100,
      resetsAt: new Date(resetsAt).toISOString(),
    },
  };
}

async function postSnapshot(input) {
  const snapshot = sanitizedSnapshot(input);
  if (!snapshot) throw new Error('Invalid Bailian quota snapshot');
  const response = await fetch(LOCAL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error(`Agent Mission Control returned HTTP ${response.status}`);
}

async function startRefresh() {
  if ((await managedTabs()).length) return;
  const tab = await chrome.tabs.create({ url: CONSOLE_URL, active: false });
  if (!Number.isInteger(tab.id)) return;
  await saveManagedTabs([tab.id]);
  chrome.alarms.create(`${CLEANUP_PREFIX}${tab.id}`, { delayInMinutes: 1 });
}

async function configureSchedule() {
  chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: 0.5, periodInMinutes: 5 });
  await startRefresh();
}

chrome.runtime.onInstalled.addListener(() => {
  void configureSchedule();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSchedule();
});

chrome.action.onClicked.addListener(() => {
  void startRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    void startRefresh();
    return;
  }
  if (alarm.name.startsWith(CLEANUP_PREFIX)) {
    const tabId = Number(alarm.name.slice(CLEANUP_PREFIX.length));
    if (Number.isInteger(tabId)) void closeManagedTab(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type !== 'amc-bailian-quota'
    || !String(sender.url || '').startsWith('https://bailian.console.aliyun.com/')
  ) return false;

  void (async () => {
    try {
      await postSnapshot(message.snapshot);
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    } finally {
      if (Number.isInteger(sender.tab?.id)) await closeManagedTab(sender.tab.id);
    }
  })();
  return true;
});
