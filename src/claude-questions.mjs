import { randomBytes as cryptoRandomBytes } from 'node:crypto';

// The open questions and approvals that an agent client holds for the phone.
// One store for every app: a record is for one `(provider, sessionKey)`. Memory only.
export const MAX_WAIT_MS = 25_000;
export const CODEX_FIRST_MS = 28_000;
export const PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity'];
const MAX_OPEN = 32;
const UNSEEN_GRACE_MS = 30_000;
const WAIT_GAP_MS = 60_000;
const KEEP_ENDED_MS = 60_000;
// A PC "No" kills the Claude hook client with no message: its held wait closes the socket and no next poll comes.
const SOCKET_GRACE_MS = 5_000;
const CONTROL = /[\x00-\x1f\x7f]/;
// A question or a description can hold a code line: a tab and a newline are allowed there.
const CONTROL_BUT_TAB_NEWLINE = /[\x00-\x08\x0b-\x1f\x7f]/;

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode, expose: true });
const text = (value, min, max, newline = false) => typeof value === 'string' && value.length >= min && value.length <= max
  && !(newline ? CONTROL_BUT_TAB_NEWLINE : CONTROL).test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys.join(',');

// A copy with only the known keys, or null when a value is outside the limits.
export function checkedQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return null;
  const copy = [];
  for (const item of questions) {
    if (!object(item) || !text(item.question, 1, 2_000, true) || (item.header !== undefined && !text(item.header, 0, 100))
      || (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean')
      || (item.allowOther !== undefined && typeof item.allowOther !== 'boolean')
      || !Array.isArray(item.options) || item.options.length < 1 || item.options.length > 8) return null;
    const options = [];
    for (const option of item.options) {
      if (!object(option) || !text(option.label, 1, 200) || (option.description !== undefined && !text(option.description, 0, 1_000, true))
        || options.some((other) => other.label === option.label)) return null;
      options.push({ label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) });
    }
    copy.push({ question: item.question, ...(item.header !== undefined ? { header: item.header } : {}), options, multiSelect: item.multiSelect === true,
      ...(item.allowOther !== undefined ? { allowOther: item.allowOther } : {}) });
  }
  return copy;
}

// A copy of an approval (`{ kind, title, display, note }`, exact keys), or null when a value is outside the limits.
export function checkedApproval(approval) {
  if (!exact(approval, ['display', 'kind', 'note', 'title']) || !['tool', 'plan'].includes(approval.kind) || typeof approval.note !== 'boolean'
    || !text(approval.title, 1, 300) || !Array.isArray(approval.display) || approval.display.length > 8) return null;
  const plan = approval.kind === 'plan';
  const display = [];
  for (const item of approval.display) {
    if (!exact(item, ['label', 'mono', 'text'])) return null;
    // A plan record has one long `Plan` text.
    const max = plan && item.label === 'Plan' && !display.some((other) => other.label === 'Plan') ? 16_000 : 4_000;
    if (!text(item.label, 1, 40) || !text(item.text, 0, max, true) || typeof item.mono !== 'boolean') return null;
    display.push({ label: item.label, text: item.text, mono: item.mono });
  }
  if (display.reduce((sum, item) => sum + item.text.length, 0) > (plan ? 16_500 : 8_000)) return null;
  return { kind: approval.kind, title: approval.title, display, note: approval.note };
}

// A phone decision on an approval (`{ decision, note? }`, exact keys), or null. A note goes only with a deny of an approval that takes one.
export function checkedDecision(approval, value) {
  if (!(exact(value, ['decision']) || exact(value, ['decision', 'note'])) || !['allow', 'deny'].includes(value.decision)) return null;
  if (value.note === undefined) return { decision: value.decision };
  return value.decision === 'deny' && approval.note === true && text(value.note, 1, 500, true) ? { decision: 'deny', note: value.note } : null;
}

// The checked items in question order, and the legacy text-to-answer map for Claude. The map joins labels and Other with `, `.
export function answersFor(questions, items) {
  if (!Array.isArray(items) || items.length !== questions.length) return null;
  // No prototype: a question text such as `__proto__` stays an own key.
  const answers = Object.create(null);
  const answerItems = [];
  for (const [index, question] of questions.entries()) {
    const item = items[index];
    if (!object(item) || !Object.keys(item).every((key) => ['selected', 'other'].includes(key)) || !Array.isArray(item.selected)
      || new Set(item.selected).size !== item.selected.length
      || !item.selected.every((label) => question.options.some((option) => option.label === label))
      || (item.other !== undefined && (question.allowOther === false || !text(item.other, 1, 2_000, true)))) return null;
    const count = item.selected.length + (item.other !== undefined ? 1 : 0);
    if (question.multiSelect ? count < 1 : count !== 1) return null;
    const other = item.other === undefined ? [] : [item.other];
    answers[question.question] = [...item.selected, ...other].join(', ');
    answerItems.push({ selected: [...item.selected], ...(item.other === undefined ? {} : { other: item.other }) });
  }
  return { answers, answerItems };
}

export function createClaudeQuestions({ now = Date.now, randomBytes = cryptoRandomBytes, socketGraceMs = SOCKET_GRACE_MS } = {}) {
  const records = new Map();
  const waiters = new Map();
  const codexListeners = new Set();
  const changed = (record) => {
    if (record.provider === 'codex' || (record.provider === 'antigravity' && record.kind === 'approval' && record.onScreen === true)) {
      for (const notify of codexListeners) notify();
    }
  };

  const end = (record, state, answer) => {
    record.state = state;
    if (answer) record.answer = answer;
    record.endedAtMs = now();
    clearTimeout(record.socketTimer);
    clearTimeout(record.deadlineTimer);
    const reply = replyOf(record);
    for (const resolve of waiters.get(record.requestId) || []) resolve(reply);
    waiters.delete(record.requestId);
    changed(record);
  };
  const replyOf = (record) => record.state !== 'answered' ? { state: record.state } : { state: 'answered', ...record.answer };
  const prune = () => {
    for (const [id, record] of records) if (record.state !== 'open' && now() - record.endedAtMs >= KEEP_ENDED_MS) records.delete(id);
  };
  const isOpen = (record) => {
    if (record?.state === 'open' && record.deadlineAtMs !== undefined && now() >= record.deadlineAtMs) end(record, 'closed');
    return record?.state === 'open';
  };
  const openList = () => [...records.values()].filter(isOpen);
  const sameSession = (record, provider, sessionKey) => record.provider === provider && record.sessionKey === sessionKey;
  const hasRoom = (open, provider, sessionKey) => open.length < MAX_OPEN || open.some((record) => sameSession(record, provider, sessionKey));

  return {
    onCodexChange(listener) {
      codexListeners.add(listener);
      return () => codexListeners.delete(listener);
    },
    // Check admission without opening or closing any request.
    canOpen(provider, sessionKey) {
      const atMs = now();
      const open = [...records.values()].filter((record) => record.state === 'open' && !(record.deadlineAtMs <= atMs));
      return hasRoom(open, provider, sessionKey);
    },
    // `{ provider, sessionKey, questions }` or `{ provider, sessionKey, approval }`.
    open({ provider, sessionKey, questions, approval }) {
      prune();
      if (!PROVIDERS.includes(provider) || typeof sessionKey !== 'string' || !sessionKey) throw fail(400, 'Invalid request.');
      const kind = approval === undefined ? 'question' : 'approval';
      const payload = kind === 'question' ? checkedQuestions(questions) : questions === undefined ? checkedApproval(approval) : null;
      if (!payload) throw fail(400, kind === 'question' ? 'Invalid question.' : 'Invalid approval.');
      const open = openList();
      if (!hasRoom(open, provider, sessionKey)) throw fail(503, 'Too many open questions.');
      for (const record of open) if (sameSession(record, provider, sessionKey)) end(record, 'closed');
      let requestId;
      do requestId = randomBytes(16).toString('hex'); while (records.has(requestId));
      const atMs = now();
      const record = { requestId, provider, sessionKey, kind, ...(kind === 'question' ? { questions: payload } : { approval: payload }),
        ...(provider === 'antigravity' && kind === 'approval' ? { onScreen: false } : {}),
        createdAtMs: atMs, lastWaitAtMs: atMs, seenPending: false, state: 'open' };
      records.set(requestId, record);
      if (provider === 'codex' && kind === 'approval') {
        record.deadlineAtMs = atMs + CODEX_FIRST_MS;
        record.deadlineTimer = setTimeout(() => end(record, 'closed'), CODEX_FIRST_MS);
        record.deadlineTimer.unref?.();
      }
      changed(record);
      return { requestId };
    },
    // `signal` ends a held wait early (the client closed its socket), so no timer or resolver stays. With no next poll in
    // `socketGraceMs` after that, the record closes.
    wait(requestId, maxMs, signal) {
      prune();
      const record = records.get(requestId);
      if (!record) return null;
      record.lastWaitAtMs = now();
      clearTimeout(record.socketTimer);
      if (!isOpen(record)) return Promise.resolve(replyOf(record));
      return new Promise((resolve) => {
        const list = waiters.get(requestId) || new Set();
        waiters.set(requestId, list);
        const settle = (reply) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          list.delete(settle);
          if (!list.size && waiters.get(requestId) === list) waiters.delete(requestId);
          resolve(reply);
        };
        const aborted = () => {
          settle({ state: 'open' });
          if (record.provider === 'antigravity' || record.state !== 'open' || waiters.has(requestId)) return;
          // A next poll clears this timer.
          record.socketTimer = setTimeout(() => { if (record.state === 'open' && !waiters.has(requestId)) end(record, 'closed'); }, socketGraceMs);
          record.socketTimer.unref?.();
        };
        const timer = setTimeout(() => settle({ state: 'open' }), Math.min(Math.max(0, maxMs), MAX_WAIT_MS));
        list.add(settle);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    },
    // `value`: the checked question answer or approval decision.
    answer(requestId, value) {
      prune();
      const record = records.get(requestId);
      if (!isOpen(record)) return false;
      end(record, 'answered', value);
      return true;
    },
    close(requestId) {
      const record = records.get(requestId);
      if (record?.state === 'open') end(record, 'closed');
      prune();
    },
    // Only the records of `kind`; with no kind, all.
    closeAll(kind) {
      for (const record of openList()) if (kind === undefined || record.kind === kind) end(record, 'closed');
      prune();
    },
    setOnScreen(requestId, value) {
      const record = records.get(requestId);
      if (!isOpen(record) || record.onScreen === Boolean(value)) return false;
      record.onScreen = Boolean(value);
      changed(record);
      return true;
    },
    forSession(provider, sessionKey) {
      prune();
      return openList().find((record) => record.provider === provider && record.sessionKey === sessionKey
        && !(record.provider === 'antigravity' && record.kind === 'approval' && record.onScreen !== true)) || null;
    },
    openRecords() { prune(); return openList(); },
    hasRecords() { prune(); return records.size > 0; },
    // `pendingSessions`: the session keys of `provider` whose app shows a pending request of `kind` now.
    reconcile(provider, kind, pendingSessions) {
      for (const record of openList()) {
        if (record.provider !== provider || record.kind !== kind) continue;
        if (pendingSessions.has(record.sessionKey)) record.seenPending = true;
        else if (record.seenPending || now() - record.createdAtMs > UNSEEN_GRACE_MS) end(record, 'closed');
      }
      prune();
    },
    sweep() {
      for (const record of openList()) if (record.provider !== 'antigravity' && now() - record.lastWaitAtMs > WAIT_GAP_MS) end(record, 'closed');
      prune();
    },
  };
}
