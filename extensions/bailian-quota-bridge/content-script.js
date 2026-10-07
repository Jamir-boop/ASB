(function startBailianQuotaBridge() {
  'use strict';

  if (!location.hash.includes('/efm/subscription/token-plan/personal')) return;

  let sent = false;
  let attempts = 0;
  const trySend = () => {
    if (sent || attempts >= 60) return;
    attempts += 1;
    const snapshot = globalThis.AmcBailianQuota?.extractFromDocument(document);
    if (!snapshot) return;
    sent = true;
    chrome.runtime.sendMessage({ type: 'amc-bailian-quota', snapshot }).catch(() => {});
  };

  trySend();
  const timer = setInterval(() => {
    trySend();
    if (sent || attempts >= 60) clearInterval(timer);
  }, 500);
}());
