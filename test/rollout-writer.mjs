// Random Codex rollouts for the scan tests, and the result of a full pass by an independent rule.
import { promises as fs } from 'node:fs';
import { parseRolloutSignals, readTail } from '../src/codex-data.mjs';

const LIFECYCLE_KEYS = ['agentRunning', 'agentStartedAtMs', 'agentActivityAtMs', 'latestLifecycleAtMs', 'latestLifecycleKind',
  'latestTaskStartedAtMs', 'latestTaskEndedAtMs', 'latestTaskEndKind'];
const QUESTION_KEYS = ['awaitingUserInput', 'userQuestionBlocking', 'latestUserQuestionAtMs', 'latestBlockingQuestionAtMs'];
const CALL_IDS = ['call_a', 'call_b', 'call_c'];
const WORDS = ['plain text', '日本語のテキスト', 'émoji 🚀 naïve', 'request_user_input in prose', '中文说明', 'Ünïcödé ✓'];

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent of the scan: one pass of the tail and one pass of the whole file, merged by the rule of readRolloutSignals().
export async function expectedSignals(filePath, tailBytes) {
  const tail = await readTail(filePath, tailBytes);
  const expected = Object.fromEntries(Object.entries(parseRolloutSignals(tail.text)));
  if (tail.start === 0) return expected;
  const whole = parseRolloutSignals(await fs.readFile(filePath, 'utf8'));
  const lifecycleFromWhole = expected.agentRunning === null;
  for (const key of lifecycleFromWhole ? [...LIFECYCLE_KEYS, ...QUESTION_KEYS] : QUESTION_KEYS) expected[key] = whole[key];
  if (lifecycleFromWhole && expected.agentRunning === true) {
    expected.agentActivityAtMs = Math.max(expected.agentStartedAtMs, expected.latestEventAtMs || 0);
  }
  return expected;
}

export function rolloutWriter(random) {
  let time = Date.parse('2026-10-07T12:00:00Z');
  const pick = (list) => list[Math.floor(random() * list.length)];
  const text = (minimum = 0) => {
    let value = '';
    do value += `${pick(WORDS)} `; while (value.length < minimum || random() < 0.7);
    return value;
  };
  const line = (payload) => JSON.stringify({ type: 'event_msg', timestamp: new Date(time += 1000).toISOString(), payload });
  const call = (name = `${pick(['', 'functions.'])}request_user_input${pick(['', '_async'])}`) => {
    const value = line({ type: 'function_call', name, call_id: pick(CALL_IDS),
      arguments: JSON.stringify({ questions: Array.from({ length: 1 + Math.floor(random() * 2) }, (_, index) => ({ id: `q${index}` })) }) });
    return random() < 0.2 ? value.replace('"name":"', '"name" : "') : value;
  };
  const filler = (minimum = 0) => line({ type: pick(['tool_output', 'agent_message', 'token_count']), text: text(minimum) });
  // Some rollouts have few question calls, so the question map stays empty for long ranges.
  const kinds = [
    [pick([0.5, 3, 10]), call],
    [8, () => line({ type: 'function_call_output', call_id: pick(CALL_IDS),
      output: pick(['{"accepted":true}', '{"accepted":true}', '{"accepted":false}', '{"accepted":true,"error":"closed"}', 'not json', text()]) })],
    [5, () => line({ type: 'user_message', message: `<send_user_message_question_reply>${JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', pick(CALL_IDS), Math.floor(random() * 2)]), answer: text() },
    ])}</send_user_message_question_reply>` })],
    [2, () => line({ type: 'user_message', message: `Please continue. ${text()}` })],
    [1, () => line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Check this again. ${text()}` }] })],
    [4, () => line({ type: 'user_message', message: `<codex_internal_context>${text()}</codex_internal_context>` })],
    [1, () => line({ type: 'turn_aborted' })],
    [1, () => line({ type: 'task_complete', error: { message: 'failed' } })],
    [3, () => line({ type: 'task_complete' })],
    [4, () => line({ type: 'task_started' })],
    [6, () => line({ type: 'agent_message', message: `Call request_user_input when the name is "request_user_input". ${text()}` })],
    [6, () => line({ type: 'tool_output', text: JSON.stringify({ type: 'function_call', name: pick(['request_user_input', 'functions.request_user_input_async']), call_id: 'call_a', arguments: '{"questions":[{}]}' }) })],
    [3, () => line({ type: 'function_call', name: 'exec_command', call_id: pick(CALL_IDS), arguments: '{"cmd":"grep request_user_input"}' })],
    [3, () => call().slice(0, -1 - Math.floor(random() * 40))],
    [2, () => `{"type":"event_msg","payload":{"type":"task_started"`],
    [30, filler],
  ];
  const total = kinds.reduce((sum, [weight]) => sum + weight, 0);
  const event = () => {
    let at = random() * total;
    return kinds.find(([weight]) => (at -= weight) < 0)[1]();
  };
  const crlfRate = pick([0, 0, 0.3, 1]);
  const join = (lines) => Buffer.from(lines.map((value) => `${value}${random() < crlfRate ? '\r\n' : '\n'}`).join(''));
  let rest = Buffer.alloc(0);
  // Sometimes the result has a last line without a newline. The next call writes the missing bytes first.
  const finish = (buffer) => {
    const lastLine = buffer.lastIndexOf(10, buffer.length - 2) + 1;
    const cut = [buffer.length, buffer.length, buffer.length - (buffer.at(-2) === 13 ? 2 : 1),
      lastLine + 1 + Math.floor(random() * (buffer.length - lastLine - 1))][Math.floor(random() * 4)];
    const result = Buffer.concat([rest, buffer.subarray(0, cut)]);
    rest = buffer.subarray(cut);
    return result;
  };
  return {
    random, pick, call, filler, join, finish,
    lifecycle: () => line({ type: pick(['task_started', 'task_complete']) }),
    events: (count) => Array.from({ length: count }, event),
    // Lines without a lifecycle event that are longer than the tail.
    quiet: (bytes) => {
      const lines = [];
      for (let size = 0; size <= bytes; size += lines.at(-1).length + 2) lines.push(filler());
      return lines;
    },
  };
}
