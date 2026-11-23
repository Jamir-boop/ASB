import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HIDDEN, shown, whole, waitForAnswers, waitForDecision, type Approval, type PhoneQuestionItem } from '../src/approval';
import { engineRuntime } from '../src/engine';
import { ENGINE_TOKEN, fakeEngine } from './engine-fixture';
const posix = test.skipIf(process.platform === 'win32');

const approval: Approval = { kind: 'tool', title: 'Allow a shell command?', display: [{ label: 'Command', text: 'touch a.txt', mono: true }], note: true };
const REQUEST = 'a'.repeat(32);

test('HIDDEN is the same character class as scripts/asb-agent.mjs', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'asb-agent.mjs'), 'utf8');
  const line = source.split('\n').find(row => row.startsWith('const HIDDEN = '));
  expect(line).toBe(`const HIDDEN = /${HIDDEN.source}/;`);
});

test('whole and shown keep the asb-agent rules: no hidden character, no cut', () => {
  for (const mark of ['\u202e', '\u200b', '\x85']) {
    expect(whole(`touch a${mark}.txt`)).toBe(false);
    expect(shown(`touch a${mark}.txt`)).toBe('touch a.txt');
  }
  expect(whole('a'.repeat(4_000))).toBe(true);
  expect(whole('a'.repeat(4_001))).toBe(false);
  expect(whole('line one\n\tline two')).toBe(true);
  expect(whole(5)).toBe(false);
  expect(shown('a'.repeat(10), 5)).toBe('aaaa…');
});

// A fake engine whose poll replies come from `polls` in order; the open reply is `opened`.
function engineWith(opened: unknown, polls: unknown[] = []) {
  const root = mkdtempSync('/tmp/asb-approval-');
  const engine = fakeEngine(root, (route) => route === '/api/agent/wait' ? opened : polls.shift() ?? { state: 'open' });
  return { engine, runtime: engineRuntime({ XDG_RUNTIME_DIR: root }, 'linux'), done() { engine.close(); rmSync(root, { recursive: true, force: true }); } };
}
const signal = () => new AbortController().signal;

posix('waitForDecision gives allow or deny only for an answered record with that decision', async () => {
  for (const [reply, expected] of [
    [{ state: 'answered', decision: 'allow' }, { decision: 'allow' }],
    [{ state: 'answered', decision: 'deny' }, { decision: 'deny' }],
    [{ state: 'answered', decision: 'deny', note: 'Not now.' }, { decision: 'deny', note: 'Not now.' }],
    [{ state: 'answered', decision: 'always' }, null],
    [{ state: 'answered', decision: 'deny', note: 5 }, null],
    [{ state: 'answered' }, null],
    [{ state: 'closed' }, null],
    [{ state: 'other' }, null],
    ['not an object', null],
  ] as const) {
    const { engine, runtime, done } = engineWith({ wait: true, requestId: REQUEST }, [{ state: 'open' }, reply]);
    try {
      expect(await waitForDecision(runtime, 'opencode', 'ses_one', approval, signal())).toEqual(expected as never);
      // The open body is exact, then one poll per reply, each with the source token.
      expect(engine.calls.map(call => [call.route, call.body])).toEqual([
        ['/api/agent/wait', { provider: 'opencode', sessionKey: 'ses_one', approval }], [`/api/agent/wait/${REQUEST}`, {}], [`/api/agent/wait/${REQUEST}`, {}]]);
      expect(engine.calls.every(call => call.headers['x-asb-source-token'] === ENGINE_TOKEN)).toBe(true);
    } finally { done(); }
  }
});

posix('waitForDecision gives null with no engine, a refusal, wait false, or a bad request ID', async () => {
  expect(await waitForDecision(null, 'opencode', 'ses_one', approval, signal())).toBeNull();
  for (const opened of [new Response('{}', { status: 403 }), new Response('{}', { status: 404 }), new Response('{}', { status: 400 }),
    { wait: false }, { wait: true, requestId: 'short' }, { wait: true }]) {
    const { engine, runtime, done } = engineWith(opened);
    try {
      expect(await waitForDecision(runtime, 'opencode', 'ses_one', approval, signal())).toBeNull();
      expect(engine.calls.length).toBe(1);
    } finally { done(); }
  }
  // A 404 on a poll ends the wait at once.
  const { engine, runtime, done } = engineWith({ wait: true, requestId: REQUEST }, [new Response('{}', { status: 404 })]);
  try {
    expect(await waitForDecision(runtime, 'opencode', 'ses_one', approval, signal())).toBeNull();
    expect(engine.calls.length).toBe(2);
  } finally { done(); }
});

posix('waitForDecision gives null when the engine is gone for 3 polls in a row', async () => {
  const { runtime, done } = engineWith({ wait: true, requestId: REQUEST });
  // Each poll fails to connect, as when the engine stopped after the open.
  let polls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes(`/api/agent/wait/${REQUEST}`)) { polls += 1; throw new TypeError('connection refused'); }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    expect(await waitForDecision(runtime, 'opencode', 'ses_one', approval, signal())).toBeNull();
    expect(polls).toBe(3);
  } finally { globalThis.fetch = realFetch; done(); }
});

posix('the signal ends a held poll at once with null', async () => {
  const root = mkdtempSync('/tmp/asb-approval-');
  let held: (() => void) | undefined;
  const engine = fakeEngine(root, (route) => route === '/api/agent/wait' ? { wait: true, requestId: REQUEST }
    : new Promise(resolve => { held = () => resolve({ state: 'answered', decision: 'allow' }); }));
  const controller = new AbortController();
  try {
    const result = waitForDecision(engineRuntime({ XDG_RUNTIME_DIR: root }, 'linux'), 'opencode', 'ses_one', approval, controller.signal);
    const deadline = Date.now() + 2000;
    while (!held && Date.now() < deadline) await Bun.sleep(5);
    const at = Date.now();
    controller.abort();
    expect(await result).toBeNull();
    expect(Date.now() - at).toBeLessThan(500);
    held?.();
    // An aborted signal starts nothing.
    expect(await waitForDecision(engineRuntime({ XDG_RUNTIME_DIR: root }, 'linux'), 'opencode', 'ses_one', approval, controller.signal)).toBeNull();
    expect(engine.calls.length).toBe(2);
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});

posix('waitForAnswers shares the poll loop and returns the engine answers map', async () => {
  const questions: PhoneQuestionItem[] = [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }];
  const { engine, runtime, done } = engineWith({ wait: true, requestId: REQUEST }, [{ state: 'open' }, { state: 'answered', answers: { 'Pick one': 'B' } }]);
  try {
    expect(await waitForAnswers(runtime, 'opencode', 'ses_one', questions, signal())).toEqual({ 'Pick one': 'B' });
    expect(engine.calls.map(call => [call.route, call.body])).toEqual([
      ['/api/agent/wait', { provider: 'opencode', sessionKey: 'ses_one', question: { questions } }],
      [`/api/agent/wait/${REQUEST}`, {}],
      [`/api/agent/wait/${REQUEST}`, {}],
    ]);
  } finally { done(); }
});
