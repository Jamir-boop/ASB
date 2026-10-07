(function installBailianQuotaExtractor(scope) {
  'use strict';

  function chinaTimeIso(value) {
    const match = String(value || '').match(
      /(20\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/,
    );
    if (!match) return '';
    const [, year, month, day, hour, minute, second] = match;
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }

  function parseQuotaText({ quotaText, subscriptionText }) {
    const quota = String(quotaText || '').replaceAll('\u00a0', ' ');
    const subscription = String(subscriptionText || '').replaceAll('\u00a0', ' ');
    const usedMatch = quota.match(/7\s*天限额[\s\S]{0,1000}?(\d+(?:\.\d+)?)\s*%\s*已用/);
    const resetMatch = quota.match(
      /将于\s*(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s*\(UTC\+8\))?\s*重置刷新/,
    );
    const observedMatch = quota.match(
      /最后统计时间\s*(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/,
    );
    const planMatch = subscription.match(/(?:^|\n)\s*([\p{L}\p{N} ._+()（）-]{1,40}套餐)\s*(?:\n|$)/u);
    const endMatch = subscription.match(
      /结束时间\s*(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/,
    );
    const usedPercent = Number(usedMatch?.[1]);
    const resetsAt = chinaTimeIso(resetMatch?.[1]);
    const observedAt = chinaTimeIso(observedMatch?.[1]);
    const planEndsAt = chinaTimeIso(endMatch?.[1]);
    const planName = String(planMatch?.[1] || '').trim();

    if (
      !Number.isFinite(usedPercent)
      || usedPercent < 0
      || usedPercent > 100
      || !resetsAt
      || !observedAt
      || !planName
    ) return null;

    return {
      version: 1,
      planName,
      observedAt,
      planEndsAt: planEndsAt || null,
      sevenDay: { usedPercent, resetsAt },
    };
  }

  function elementText(element) {
    return String(element?.innerText || element?.textContent || '').trim();
  }

  function exactTextElement(documentValue, matcher) {
    return Array.from(documentValue.querySelectorAll('h1,h2,h3,h4,div,span,p'))
      .map((element) => ({ element, text: elementText(element) }))
      .filter(({ text }) => matcher.test(text) && text.length <= 32)
      .sort((left, right) => left.text.length - right.text.length)[0]?.element || null;
  }

  function closestTextBlock(start, matcher, maxLength = 8000) {
    let element = start;
    while (element && element.parentElement) {
      const text = elementText(element);
      if (text.length <= maxLength && matcher.test(text)) return text;
      element = element.parentElement;
    }
    return '';
  }

  function extractFromDocument(documentValue) {
    const quotaTitle = exactTextElement(documentValue, /^套餐额度$/);
    const remainingDays = exactTextElement(documentValue, /^剩余天数$/);
    if (!quotaTitle || !remainingDays) return null;

    const quotaText = closestTextBlock(
      quotaTitle,
      /套餐额度[\s\S]*7\s*天限额[\s\S]*重置刷新[\s\S]*已用/,
    );
    const subscriptionText = closestTextBlock(
      remainingDays,
      /[\p{L}\p{N} ._+()（）-]{1,40}套餐[\s\S]*剩余天数[\s\S]*结束时间/u,
    );
    if (!quotaText || !subscriptionText) return null;
    return parseQuotaText({ quotaText, subscriptionText });
  }

  scope.AmcBailianQuota = Object.freeze({
    chinaTimeIso,
    extractFromDocument,
    parseQuotaText,
  });
}(globalThis));
