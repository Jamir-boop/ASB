// The phone approval of an agent request: the text rules of scripts/asb-agent.mjs and the engine wait loop (/api/agent/wait).
import { engineRequest, type EngineRuntime } from './engine';

// A copy of HIDDEN in scripts/asb-agent.mjs (a test compares the two): the controls but a tab and a newline (C0, DEL, C1), and the
// invisible and direction marks that can make a command look like another one.
export const HIDDEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const cut = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
// A display text that the phone may see in part: the hidden characters removed, then cut to its limit.
export const shown = (value: unknown, max = 4_000) => cut(String(value).replace(new RegExp(HIDDEN, 'g'), ''), max);
// A text that the phone user allows: shown whole and unchanged, or not at all.
export const whole = (value: unknown, max = 4_000): value is string => typeof value === 'string' && value.length <= max && !HIDDEN.test(value);

export type ApprovalItem = { label: string; text: string; mono: boolean };
export type Approval = { kind: 'tool'; title: string; display: ApprovalItem[]; note: true };
export type Decision = { decision: 'allow' } | { decision: 'deny'; note?: string };

const POLL_MS = 30_000;
const GONE_POLLS = 3;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  (timer as { unref?: () => void }).unref?.();
  signal.addEventListener('abort', done, { once: true });
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
});

// Holds the request for the phone and gives the phone decision, or null in every other case (no engine, a refusal, a closed
// record, a bad reply, the engine gone for 3 polls in a row, or the signal). It never throws.
export async function waitForDecision(runtime: EngineRuntime | null, provider: string, sessionKey: string, approval: Approval, signal: AbortSignal): Promise<Decision | null> {
  if (!runtime || signal.aborted) return null;
  let requestId: string;
  try {
    const opened = await engineRequest(runtime, '/api/agent/wait', { method: 'POST', body: { provider, sessionKey, approval }, signal });
    if (!object(opened) || opened.wait !== true || typeof opened.requestId !== 'string' || !/^[0-9a-f]{32}$/.test(opened.requestId)) return null;
    requestId = opened.requestId;
  } catch { return null; }
  let gone = 0;
  while (!signal.aborted) {
    let reply: unknown;
    try {
      reply = await engineRequest(runtime, `/api/agent/wait/${requestId}`, { method: 'POST', body: {}, timeoutMs: POLL_MS, signal });
    } catch (error) {
      // An HTTP answer (404, 403, ...) ends the wait; a missing engine gets two more tries.
      if (signal.aborted || (error instanceof Error && error.message.startsWith('The ASB engine answered HTTP')) || ++gone >= GONE_POLLS) return null;
      await pause(1_000, signal);
      continue;
    }
    gone = 0;
    if (!object(reply)) return null;
    if (reply.state === 'answered') {
      if (reply.decision === 'allow') return { decision: 'allow' };
      if (reply.decision === 'deny' && (reply.note === undefined || typeof reply.note === 'string')) {
        return reply.note === undefined ? { decision: 'deny' } : { decision: 'deny', note: reply.note };
      }
      return null;
    }
    if (reply.state !== 'open') return null;
  }
  return null;
}
