import { randomBytes as cryptoRandomBytes } from 'node:crypto';

// The open questions and approvals that an agent client (today the Claude Code hook `asb agent claude-wait`) holds for the phone.
// One store for every app: a record is for one `(provider, sessionKey)`. Memory only.
export const MAX_WAIT_MS = 25_000;
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
      || !Array.isArray(item.options) || item.options.length < 1 || item.options.length > 8) return null;
    const options = [];
    for (const option of item.options) {
      if (!object(option) || !text(option.label, 1, 200) || (option.description !== undefined && !text(option.description, 0, 1_000, true))
        || options.some((other) => other.label === option.label)) return null;
      options.push({ label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) });
    }
    copy.push({ question: item.question, ...(item.header !== undefined ? { header: item.header } : {}), options, multiSelect: item.multiSelect === true });
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

// The Claude `answers` object (question text to the labels, then the typed text, joined with `, `) for the phone's answer items, one per
// stored question in order, or null when an item does not fit its question.
export function answersFor(questions, items) {
  if (!Array.isArray(items) || items.length !== questions.length) return null;
  // No prototype: a question text such as `__proto__` stays an own key.
  const answers = Object.create(null);
  for (const [index, question] of questions.entries()) {
    const item = items[index];
    if (!object(item) || !Object.keys(item).every((key) => ['selected', 'other'].includes(key)) || !Array.isArray(item.selected)
      || new Set(item.selected).size !== item.selected.length
      || !item.selected.every((label) => question.options.some((option) => option.label === label))
      || (item.other !== undefined && !text(item.other, 1, 2_000, true))) return null;
    const count = item.selected.length + (item.other !== undefined ? 1 : 0);
    if (question.multiSelect ? count < 1 : count !== 1) return null;
    answers[question.question] = [...item.selected, ...(item.other !== undefined ? [item.other] : [])].join(', ');
  }
  return answers;
}

export function createClaudeQuestions({ now = Date.now, randomBytes = cryptoRandomBytes, socketGraceMs = SOCKET_GRACE_MS } = {}) {
  const records = new Map();
  const waiters = new Map();

  const end = (record, state, answer) => {
    record.state = state;
    if (answer) record.answer = answer;
    record.endedAtMs = now();
    clearTimeout(record.socketTimer);
    const reply = replyOf(record);
    for (const resolve of waiters.get(record.requestId) || []) resolve(reply);
    waiters.delete(record.requestId);
  };
  // A question answer is the Claude `answers` object; an approval answer is `{ decision, note? }`.
  const replyOf = (record) => record.state !== 'answered' ? { state: record.state }
    : record.kind === 'question' ? { state: 'answered', answers: record.answer } : { state: 'answered', ...record.answer };
  const prune = () => {
    for (const [id, record] of records) if (record.state !== 'open' && now() - record.endedAtMs >= KEEP_ENDED_MS) records.delete(id);
  };
  const openList = () => [...records.values()].filter((record) => record.state === 'open');

  return {
    // `{ provider, sessionKey, questions }` or `{ provider, sessionKey, approval }`.
    open({ provider, sessionKey, questions, approval }) {
      prune();
      if (!PROVIDERS.includes(provider) || typeof sessionKey !== 'string' || !sessionKey) throw fail(400, 'Invalid request.');
      const kind = approval === undefined ? 'question' : 'approval';
      const payload = kind === 'question' ? checkedQuestions(questions) : questions === undefined ? checkedApproval(approval) : null;
      if (!payload) throw fail(400, kind === 'question' ? 'Invalid question.' : 'Invalid approval.');
      for (const record of openList()) if (record.provider === provider && record.sessionKey === sessionKey) end(record, 'closed');
      if (openList().length >= MAX_OPEN) throw fail(503, 'Too many open questions.');
      let requestId;
      do requestId = randomBytes(16).toString('hex'); while (records.has(requestId));
      const atMs = now();
      records.set(requestId, { requestId, provider, sessionKey, kind, ...(kind === 'question' ? { questions: payload } : { approval: payload }),
        createdAtMs: atMs, lastWaitAtMs: atMs, seenPending: false, state: 'open' });
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
      if (record.state !== 'open') return Promise.resolve(replyOf(record));
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
          if (record.state !== 'open' || waiters.has(requestId)) return;
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
    // `value`: the Claude answers of a question, or the checked decision of an approval.
    answer(requestId, value) {
      prune();
      const record = records.get(requestId);
      if (record?.state !== 'open') return false;
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
    forSession(provider, sessionKey) {
      prune();
      return openList().find((record) => record.provider === provider && record.sessionKey === sessionKey) || null;
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
      for (const record of openList()) if (now() - record.lastWaitAtMs > WAIT_GAP_MS) end(record, 'closed');
      prune();
    },
  };
}
