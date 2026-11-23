import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agyFocusTarget, type AgyRecord } from '../../src/antigravity-data.mjs';
import { AGY_MAILBOX_TTL_MS, privateAgyMailbox, readAgyMailboxFile, safeAgyText } from '../../src/agy-mailbox.mjs';
import { bridgeNameBase } from './claude';
import type { Host } from './bridge';
import type { Inputs } from './desktop-input';
import type { Runtime } from './desktop';
import { DeliveryRefused } from './delivery';

const PROOF_MS = 5_000;
const CLAIM_MS = 10_000;
export const agyReceiverError = 'This agy conversation has no active ASB receiver or another receiver already registered it.';

export function agyRuntime(record: AgyRecord | undefined): Runtime {
  return { status: !record ? 'unknown' : record.background || record.state === 'working' || record.state === 'question' ? 'busy' : 'idle', mode: 'unknown' };
}

export function promptZone(screen: string): string[] | null {
  const lines = screen.trimEnd().split('\n');
  const borders = lines.flatMap((line, i) => /^[─━═╭╮╰╯│┃ ]{10,}$/.test(line) && /[─━═]/.test(line) ? [i] : []);
  const top = borders.at(-2), bottom = borders.at(-1);
  if (top === undefined || bottom === undefined || bottom - top < 2
    || /allow once|permission required|run this command\?|submit answers|select an option/i.test(lines.slice(top).join('\n'))) return null;
  return lines.slice(top + 1, bottom).map(line => line.replace(/^[ │┃>›❯]+/, '').replace(/[ │┃]+$/, ''));
}

const oldEnough = (record: AgyRecord | undefined, now: number) => record && (record.event === 'Stop' || record.event === 'SessionStart')
  && agyRuntime(record).status === 'idle' && now - record.stateAtMs >= 1000;
const sameEvent = (a: AgyRecord, b: AgyRecord | undefined) => a.event === b?.event && a.stateAtMs === b?.stateAtMs;
const sameTarget = (a: AgyRecord, b: AgyRecord | undefined) => b && a.kittyPid === b.kittyPid
  && a.kittyWindowId === b.kittyWindowId && a.kittyListenOn === b.kittyListenOn;
const proof = (record: AgyRecord | undefined, after: number) => record?.event === 'PreInvocation'
  && record.stateAtMs > after && record.stateAtMs <= after + PROOF_MS;
const remove = (file: string) => unlink(file).catch(() => {});

export async function cleanAgyMailbox(dir: string | null, id: string) {
  if (!dir || !await privateAgyMailbox(dir)) return;
  for (const name of await readdir(dir).catch(() => [])) {
    if (name === `${id}.msg` || name === `${id}.taken` || name === `${id}.continued` || name.startsWith(`${id}.msg.`)) {
      await remove(join(dir, name));
    }
  }
}

function kitty(args: string[]) {
  return new Promise<string>((resolve, reject) => execFile('kitty', args, { timeout: 3000, maxBuffer: 512 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

type AgyHostParts = {
  id: string;
  pid: number;
  mailbox: string | null;
  read(): Promise<AgyRecord | undefined>;
  kittyDelivery: boolean;
  focus?: typeof agyFocusTarget;
  exec?: typeof kitty;
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
};
type Waiting = { id: string; text: string; named: boolean; expires: number; published?: true; goneAt?: number; takenAt?: number; returnedAt?: number };
type Outcome = 'consumed' | 'lost' | 'withdrawn';

export function createAgyHost({ id, pid, mailbox, read, kittyDelivery, focus = agyFocusTarget, exec = kitty,
  wait = Bun.sleep, now = Date.now }: AgyHostParts): Host & { poll(record: AgyRecord | undefined): Promise<void>; close(): Promise<void> } {
  const base = mailbox && join(mailbox, id);
  const waiting: Waiting[] = [];
  const results: Record<Outcome, Inputs['consumed']> = { consumed: [], lost: [], withdrawn: [] };
  const known = new Set<string>();
  let latest: Inputs['latest'] = null;
  let lastInvocation = 0;
  let closed = false;
  let firstRead = true;

  const settle = (item: Waiting, outcome: Outcome) => {
    waiting.splice(waiting.indexOf(item), 1);
    const input = { id: item.id, clientId: item.id };
    results[outcome].push(input);
    if (outcome === 'consumed') latest = input;
  };

  async function withdraw() {
    if (!base || !await privateAgyMailbox(mailbox)) return false;
    const claim = `${base}.msg.${randomUUID()}.tmp`;
    try { await rename(`${base}.msg`, claim); }
    catch { return false; }
    await remove(claim);
    return true;
  }

  async function publish(item: Waiting) {
    if (!base || !mailbox) return;
    try { await mkdir(mailbox, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return; }
    if (!await privateAgyMailbox(mailbox)) return;
    const temp = `${base}.msg.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ id: item.id, text: item.text }), { flag: 'wx', mode: 0o600 });
      const queued = new Date(item.expires - AGY_MAILBOX_TTL_MS);
      await utimes(temp, queued, queued);
      await link(temp, `${base}.msg`);
      item.published = true;
    } catch { /* Another file or an unavailable mailbox: keep waiting. */ }
    finally { await remove(temp); }
  }

  async function command(record: AgyRecord, action: string, args: string[], before?: () => Promise<boolean>) {
    const target = await focus(record);
    if (!target || closed || (before && !await before())) throw new Error('agy kitty target changed');
    return exec(['@', '--to', target.listenOn, action, '--match', `id:${target.windowId}`, ...args]);
  }

  async function paste(item: Waiting, gate: AgyRecord): Promise<boolean> {
    if (!kittyDelivery || !item.named || !oldEnough(gate, now())) return false;
    const screen = () => command(gate, 'get-text', ['--extent', 'screen']);
    const unchanged = async () => {
      const current = await read();
      return sameEvent(gate, current) && Boolean(sameTarget(gate, current)) && Boolean(oldEnough(current, now()));
    };
    try {
      const zone = promptZone(await screen());
      if (!zone || zone.some(Boolean) || !await unchanged()) return false;
    } catch { return false; }
    if (item.published) {
      if (!await withdraw()) return false;
      delete item.published;
    }
    let attempted = false;
    try {
      await command(gate, 'send-text', ['--bracketed-paste=enable', '--', item.text], async () => attempted = await unchanged());
      await wait(150);
      const zone = promptZone(await screen());
      if (!zone?.[0]?.startsWith(item.text.split('\n')[0]!)) throw new Error('agy paste could not be verified');
      await command(gate, 'send-key', ['enter'], async () => {
        if (!await unchanged()) return false;
        item.returnedAt = now();
        return true;
      });
    } catch {
      if (!attempted) return false;
      settle(item, 'lost');
    }
    return true;
  }

  async function followMailbox(item: Waiting, record: AgyRecord | undefined) {
    if (!base || !await privateAgyMailbox(mailbox)) {
      item.goneAt ??= now();
    } else {
      const taken = await readAgyMailboxFile(`${base}.taken`);
      if (taken?.text === item.id) {
        item.takenAt = taken.at;
        await remove(`${base}.taken`);
      }
      if (!item.takenAt && !await lstat(`${base}.msg`).catch(() => null)) item.goneAt ??= now();
    }
    if (item.takenAt !== undefined) {
      if (proof(record, item.takenAt)) settle(item, 'consumed');
      else if (now() >= item.takenAt + PROOF_MS) settle(item, 'lost');
      return true;
    }
    if (item.goneAt === undefined) return false;
    if (now() >= item.goneAt + CLAIM_MS) settle(item, 'lost');
    return true;
  }

  return {
    entrypoint: 'agy-asb-bridge', transport: 'agy', remoteAgent: 'claude', replyHint: 'Reply with asb-bridge send_message.',
    identity: { pid }, nameBase: cwd => bridgeNameBase('agy', undefined, cwd), extraRow: { agyConversationId: id },
    receiverError: agyReceiverError,
    async runtime() { return agyRuntime(await read()); },
    async deliver(inputId, text, named = false) {
      if (closed || !safeAgyText(text)) throw new DeliveryRefused('agy accepts at most 4000 characters and 40 lines, with no control characters except tab and newline.');
      known.add(inputId);
      waiting.push({ id: inputId, text, named, expires: now() + AGY_MAILBOX_TTL_MS });
      return { status: 'accepted', turnId: null };
    },
    async inputs(awaiting) {
      // An accepted row left by an earlier receiver has no delivery proof.
      if (firstRead) for (const inputId of awaiting) if (!known.has(inputId)) results.lost.push({ id: inputId, clientId: inputId });
      firstRead = false;
      const { consumed, lost, withdrawn } = results;
      const drained = { latest, consumed: consumed.splice(0), lost: lost.splice(0), withdrawn: withdrawn.splice(0) };
      for (const input of [...drained.consumed, ...drained.lost, ...drained.withdrawn]) known.delete(input.id);
      return drained;
    },
    async poll(record) {
      if (closed) return;
      if (record?.event === 'PreInvocation' && record.stateAtMs !== lastInvocation) {
        lastInvocation = record.stateAtMs;
        latest = null;
      }
      const item = waiting[0];
      for (const queued of waiting.slice(1)) if (now() >= queued.expires) settle(queued, 'withdrawn');
      if (!item) return;
      if (item.returnedAt !== undefined) {
        if (proof(record, item.returnedAt)) settle(item, 'consumed');
        else if (now() >= item.returnedAt + PROOF_MS) settle(item, 'lost');
        return;
      }
      if (item.published && await followMailbox(item, record)) return;
      if (now() >= item.expires) {
        if (item.published && !await withdraw()) return; // The Stop claim can win this race.
        await cleanAgyMailbox(mailbox, id);
        settle(item, 'withdrawn');
        return;
      }
      if (!record || await paste(item, record)) return;
      if (!item.published) await publish(item);
    },
    async close() {
      closed = true;
      for (const item of [...waiting]) {
        const lost = item.returnedAt !== undefined || (item.published && !await withdraw());
        settle(item, lost ? 'lost' : 'withdrawn');
      }
      await cleanAgyMailbox(mailbox, id);
    },
  };
}
