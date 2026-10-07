export function rememberBounded(cache, key, value, limit, metrics = null, writeKey = '', evictionKey = '') {
  if (!cache || limit <= 0) return;
  if (metrics && writeKey) metrics[writeKey] = coerceMetric(metrics[writeKey]) + 1;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    if (metrics && evictionKey) metrics[evictionKey] = coerceMetric(metrics[evictionKey]) + 1;
  }
}

export function statSignature(stat) {
  return {
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0),
    dev: Number(stat?.dev || 0),
    ino: Number(stat?.ino || 0),
    ctimeMs: Number(stat?.ctimeMs || 0),
  };
}

export function sameFileSignature(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
    && a.dev === b.dev && a.ino === b.ino;
}

function coerceMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
