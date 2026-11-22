import { randomBytes as cryptoRandomBytes } from 'node:crypto';

// The open Claude Code questions (AskUserQuestion) that a `claude-wait` hook holds for the phone. Memory only.
export const MAX_WAIT_MS = 25_000;
const MAX_OPEN = 32;
const UNSEEN_GRACE_MS = 30_000;
const WAIT_GAP_MS = 60_000;
const KEEP_ENDED_MS = 60_000;
const CONTROL = /[\x00-\x1f\x7f]/;
// A question or a description can hold a code line: a tab and a newline are allowed there.
const CONTROL_BUT_TAB_NEWLINE = /[\x00-\x08\x0b-\x1f\x7f]/;

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode, expose: true });
const text = (value, min, max, newline = false) => typeof value === 'string' && value.length >= min && value.length <= max
  && !(newline ? CONTROL_BUT_TAB_NEWLINE : CONTROL).test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

export function createClaudeQuestions({ now = Date.now, randomBytes = cryptoRandomBytes } = {}) {
  const records = new Map();
  const waiters = new Map();

  const end = (record, state, answers) => {
    record.state = state;
    if (answers) record.answers = answers;
    record.endedAtMs = now();
    const reply = state === 'answered' ? { state, answers: record.answers } : { state };
    for (const resolve of waiters.get(record.requestId) || []) resolve(reply);
    waiters.delete(record.requestId);
  };
  const prune = () => {
    for (const [id, record] of records) if (record.state !== 'open' && now() - record.endedAtMs >= KEEP_ENDED_MS) records.delete(id);
  };
  const openList = () => [...records.values()].filter((record) => record.state === 'open');

  return {
    open({ cliSessionId, questions }) {
      prune();
      const copy = checkedQuestions(questions);
      if (!copy) throw fail(400, 'Invalid question.');
      for (const record of openList()) if (record.cliSessionId === cliSessionId) end(record, 'closed');
      if (openList().length >= MAX_OPEN) throw fail(503, 'Too many open questions.');
      let requestId;
      do requestId = randomBytes(16).toString('hex'); while (records.has(requestId));
      const atMs = now();
      records.set(requestId, { requestId, cliSessionId, questions: copy, createdAtMs: atMs, lastWaitAtMs: atMs,
        seenPending: false, state: 'open' });
      return { requestId };
    },
    // `signal` ends a held wait early (the client closed its socket), so no timer or resolver stays.
    wait(requestId, maxMs, signal) {
      prune();
      const record = records.get(requestId);
      if (!record) return null;
      record.lastWaitAtMs = now();
      if (record.state === 'answered') return Promise.resolve({ state: 'answered', answers: record.answers });
      if (record.state === 'closed') return Promise.resolve({ state: 'closed' });
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
        const aborted = () => settle({ state: 'open' });
        const timer = setTimeout(() => settle({ state: 'open' }), Math.min(Math.max(0, maxMs), MAX_WAIT_MS));
        list.add(settle);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    },
    answer(requestId, answers) {
      prune();
      const record = records.get(requestId);
      if (record?.state !== 'open') return false;
      end(record, 'answered', answers);
      return true;
    },
    close(requestId) {
      const record = records.get(requestId);
      if (record?.state === 'open') end(record, 'closed');
      prune();
    },
    closeAll() {
      for (const record of openList()) end(record, 'closed');
      prune();
    },
    forSession(cliSessionId) {
      prune();
      return openList().find((record) => record.cliSessionId === cliSessionId) || null;
    },
    openRecords() { prune(); return openList(); },
    hasRecords() { prune(); return records.size > 0; },
    reconcile(pendingSessions) {
      for (const record of openList()) {
        if (pendingSessions.has(record.cliSessionId)) record.seenPending = true;
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
