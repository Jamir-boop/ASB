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

export class SourceCache extends Map {
  constructor(limit) {
    super();
    this.defaultLimit = limit;
    this.budgets = new Map();
    this.activeScopes = null;
  }

  get limit() {
    return [...this.budgets.values()].reduce((sum, budget) => sum + budget.limit, 0) || this.defaultLimit;
  }

  get(key, scope = '', limit = this.defaultLimit) {
    const value = super.get(key);
    if (super.has(key)) this.own(key, scope, limit);
    return value;
  }

  own(key, scope, limit, refresh = false) {
    if (limit <= 0 || (scope && this.activeScopes && !this.activeScopes.has(scope))) return;
    let budget = this.budgets.get(scope);
    if (!budget) {
      // Eight registered sources and one bounded scope for standalone readers.
      if (this.budgets.size === 9) this.dropScope(this.budgets.keys().next().value);
      budget = { keys: new Set(), limit };
      this.budgets.set(scope, budget);
    }
    budget.limit = limit;
    if (refresh) budget.keys.delete(key);
    budget.keys.add(key);
    while (budget.keys.size > limit) {
      const oldest = budget.keys.values().next().value;
      budget.keys.delete(oldest);
      if (![...this.budgets.values()].some((entry) => entry.keys.has(oldest))) super.delete(oldest);
    }
  }

  remember(key, value, scope = '', limit = this.defaultLimit, metrics = null, writeKey = '', evictionKey = '') {
    if (limit <= 0 || (scope && this.activeScopes && !this.activeScopes.has(scope))) return;
    if (metrics && writeKey) metrics[writeKey] = coerceMetric(metrics[writeKey]) + 1;
    const previousSize = this.size;
    const existed = super.has(key);
    super.set(key, value);
    this.own(key, scope, limit, true);
    if (metrics && evictionKey) metrics[evictionKey] = coerceMetric(metrics[evictionKey]) + previousSize + Number(!existed) - this.size;
  }

  delete(key) {
    for (const budget of this.budgets.values()) budget.keys.delete(key);
    return super.delete(key);
  }

  clear() {
    this.budgets.clear();
    super.clear();
  }

  dropScope(scope) {
    const budget = this.budgets.get(scope);
    this.budgets.delete(scope);
    for (const key of budget?.keys || []) {
      if (![...this.budgets.values()].some((entry) => entry.keys.has(key))) super.delete(key);
    }
  }

  retainScopes(scopes) {
    this.activeScopes = new Set(scopes);
    for (const scope of this.budgets.keys()) if (!this.activeScopes.has(scope)) this.dropScope(scope);
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
