// OpenCode 2 plugin entry. A plain object works today (V7); no @opencode/plugin import.
// One coordinator on globalThis holds the receivers; each setup() instance owns its location.
import { lstatSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { waitForAnswers, waitForDecision, whole, type Approval, type Decision, type PhoneQuestionItem, type QuestionAnswers } from './approval';
import { Bridge } from './bridge';
import { engineRuntime } from './engine';
import { peers, privateDirectory, removeStaleReceivers } from './claude';
import { createOpenCodeHost, opencodeBridgeId, unwrap, type OpenCodeHostParts } from './opencode-host';
import { placeholderCommand, spawnPlaceholder } from './placeholder';
import { isWindows } from './platform';
import { listSessions, listSessionsInput, sendMessage, sendMessageInput, statusBrief } from './tools';
import { version } from './version';

const COORDINATOR = Symbol.for('asb.bridge.opencode');
const CAP = 24;
const START_LIMIT = 8;
const START_WINDOW_MS = 30 * 60 * 1000;
const IDLE_MS = 12 * 60 * 60 * 1000;
const SEEN_LIMIT = 256;
// The event types that handleEvent uses. OpenCode streams many more during a turn.
const HANDLED_EVENTS = new Set(['session.renamed', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
  'session.execution.interrupted', 'session.archived', 'session.deleted', 'session.inbox.delivered', 'session.inbox.enqueued']);
// OpenCode 2.3 requests that wait for the user: permission.asked { id, sessionID }, permission.replied { sessionID, requestID },
// form.created { form: { id, sessionID } }, form.replied and form.cancelled { id, sessionID }.
const WAIT_EVENTS = new Set(['permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled']);
for (const type of WAIT_EVENTS) HANDLED_EVENTS.add(type);

type SessionInfo = {
  id: string;
  title?: string | undefined;
  location?: { directory?: string | undefined } | undefined;
  parentID?: string | undefined;
  time?: { updated?: number } | undefined;
  archived?: boolean | undefined;
};

type Receiver = {
  bridge: Bridge;
  host: ReturnType<typeof createOpenCodeHost>;
  placeholder: { pid: number; kill(): void };
  openCodeSessionId: string;
  bridgeId: string;
  location: string;
  lastActivity: number;
  closed: boolean;
  // The open requests that wait for the user, by request ID: IDs and times only, in memory only.
  asks: Map<string, { kind: 'approval' | 'question'; at: number }>;
};

type Instance = {
  ctx: any;
  directory: string;
  disposers: Array<() => void>;
};

type RegisterResult = Receiver | { limited: true; openCodeSessionId: string; bridgeId: string };

type Coordinator = {
  instances: Map<string, Instance>;
  receivers: Map<string, Receiver>;
  registering: Map<string, Promise<RegisterResult | undefined>>;
  running: Set<string>;
  seen: Set<string>;
  // The phone waits by permission request ID: one per request in this process, as the stacked setup streams each see the request.
  approvals: Map<string, { controller: AbortController; root: string; location: string }>;
  // Phone decisions that OpenCode did not take (the reply threw): a count only.
  replyFailures: number;
  configDir: string;
  stateDir: string;
};

function coordinator(): Coordinator | undefined {
  return (globalThis as Record<symbol, unknown>)[COORDINATOR] as Coordinator | undefined;
}

function ensureCoordinator(configDir: string, stateDir: string): Coordinator {
  const existing = coordinator();
  if (existing) return existing;
  const next: Coordinator = { instances: new Map(), receivers: new Map(), registering: new Map(), running: new Set(), seen: new Set(),
    approvals: new Map(), replyFailures: 0, configDir, stateDir };
  (globalThis as Record<symbol, unknown>)[COORDINATOR] = next;
  return next;
}

function remember(co: Coordinator, id: string) {
  if (co.seen.has(id)) return false;
  co.seen.add(id);
  if (co.seen.size > SEEN_LIMIT) co.seen.delete(co.seen.values().next().value!);
  return true;
}

function bridgeIdOf(sessionId: string) {
  return opencodeBridgeId(sessionId);
}

function sessionCwd(session: SessionInfo) {
  return session.location?.directory || process.cwd();
}

function titleOf(session: SessionInfo) {
  return session.title;
}

async function listLocationSessions(instance: Instance): Promise<SessionInfo[]> {
  try {
    const rows = unwrap<SessionInfo[]>(await instance.ctx.session.list({ directory: instance.directory }));
    return (Array.isArray(rows) ? rows : []) as SessionInfo[];
  } catch (error) { return []; }
}

async function getSession(instance: Instance, id: string): Promise<SessionInfo | undefined> {
  try { return unwrap<SessionInfo>(await instance.ctx.session.get({ sessionID: id })); }
  catch (error) { return undefined; }
}

function socketDirectory() {
  let directory = join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'asb-bridge-socks');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
  } catch (error) {
    directory = `/tmp/asb-bridge-socks-${process.getuid?.() ?? 0}`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
  }
  return directory;
}

function registerSession(co: Coordinator, instance: Instance, session: SessionInfo): Promise<RegisterResult | undefined> {
  if (session.parentID) return Promise.resolve(undefined);
  const pending = co.registering.get(session.id);
  if (pending) return pending;
  const run = registerSessionOnce(co, instance, session).finally(() => co.registering.delete(session.id));
  co.registering.set(session.id, run);
  return run;
}

async function registerSessionOnce(co: Coordinator, instance: Instance, session: SessionInfo): Promise<RegisterResult | undefined> {
  if (session.parentID || co.instances.get(instance.directory) !== instance) return undefined;
  const existing = co.receivers.get(session.id);
  if (existing && !existing.closed) {
    existing.lastActivity = Date.now();
    existing.host.setTitle(titleOf(session));
    try { existing.bridge.updateRuntime(await existing.host.runtime()); } catch (error) { /* Still registered. */ }
    return existing;
  }
  if (co.receivers.size >= CAP) {
    const victim = [...co.receivers.values()].sort((a, b) => a.lastActivity - b.lastActivity).find(row => canClose(co, row));
    if (!victim) return { limited: true as const, openCodeSessionId: session.id, bridgeId: bridgeIdOf(session.id) };
    await unregister(co, victim.openCodeSessionId);
  }
  const cwd = sessionCwd(session);
  const title = titleOf(session);
  const bridgeId = bridgeIdOf(session.id);
  const command = placeholderCommand();
  let placeholder: { pid: number; kill(): void };
  try {
    const child = spawnPlaceholder(command);
    placeholder = { pid: child.pid, kill: () => { try { child.kill(); } catch (error) { /* Gone. */ } } };
  } catch (error) {
    return { limited: true as const, openCodeSessionId: session.id, bridgeId };
  }
  const parts: OpenCodeHostParts = {
    openCodeSessionId: session.id,
    title,
    session: instance.ctx.session,
    agent: instance.ctx.agent,
    isRunning: async (id) => co.running.has(id),
    recentInputs: id => recentInputs(instance, id),
    pid: placeholder.pid,
  };
  const host = createOpenCodeHost(parts);
  const bridge = new Bridge(bridgeId, co.configDir, co.stateDir, '', host);
  const receiver: Receiver = {
    bridge, host, placeholder, openCodeSessionId: session.id, bridgeId,
    location: instance.directory, lastActivity: Date.now(), closed: false, asks: new Map(),
  };
  const generation = bridge.beginSession();
  try {
    await bridge.start(isWindows() ? '' : socketDirectory(), cwd, generation);
  } catch (error) {
    placeholder.kill();
    await bridge.close().catch(() => {});
    throw error;
  }
  bridge.updateRuntime(await host.runtime());
  // The instance was cleaned up during the start: do not leave a receiver that nobody owns.
  if (co.instances.get(instance.directory) !== instance) {
    receiver.closed = true;
    await bridge.close().catch(() => {});
    placeholder.kill();
    return undefined;
  }
  co.receivers.set(session.id, receiver);
  return receiver;
}

// After a plugin reload the host map is empty: take the last message of the OpenCode session context.
async function recentInputs(instance: Instance, openCodeSessionId: string) {
  const ctx = instance?.ctx;
  if (!ctx?.session?.context) return [];
  try {
    const value = unwrap<unknown>(await ctx.session.context({ sessionID: openCodeSessionId }));
    const rows = (Array.isArray(value) ? value : (value as { messages?: unknown[] })?.messages) ?? [];
    const mapped = [...rows].reverse().map(row => {
      const message = row as { id?: string; type?: string; text?: string; content?: string };
      const text = message.text ?? (typeof message.content === 'string' ? message.content : '');
      const kind = message.type === 'user' ? 'user' : message.type === 'synthetic' ? 'synthetic' : 'other';
      return { id: String(message.id ?? ''), kind: kind as 'user' | 'synthetic' | 'other', text };
    }).filter(row => row.id);
    return mapped.filter(row => row.kind !== 'other').slice(0, 1);
  } catch (error) { return []; }
}

async function unregister(co: Coordinator, openCodeSessionId: string) {
  stopApprovals(co, wait => wait.root === openCodeSessionId);
  const receiver = co.receivers.get(openCodeSessionId);
  if (!receiver) return;
  co.receivers.delete(openCodeSessionId);
  receiver.closed = true;
  try { await receiver.bridge.close(); } catch (error) { /* Already closing. */ }
  receiver.placeholder.kill();
}

async function deleteSession(co: Coordinator, openCodeSessionId: string) {
  const receiver = co.receivers.get(openCodeSessionId);
  await unregister(co, openCodeSessionId);
  // After archive the receiver is gone; the state file still has to go on delete.
  const bridgeId = receiver?.bridgeId ?? bridgeIdOf(openCodeSessionId);
  try { rmSync(join(co.stateDir, `${bridgeId}.sqlite`), { force: true }); } catch (error) { /* Gone. */ }
}

function touch(co: Coordinator, openCodeSessionId: string) {
  const receiver = co.receivers.get(openCodeSessionId);
  if (receiver) receiver.lastActivity = Date.now();
}

async function findInstanceFor(co: Coordinator, openCodeSessionId: string): Promise<Instance | undefined> {
  const receiver = co.receivers.get(openCodeSessionId);
  if (receiver) return co.instances.get(receiver.location);
  // No receiver: the instance of the session folder; get can miss across folders, so try in order.
  for (const instance of co.instances.values()) {
    const session = await getSession(instance, openCodeSessionId);
    if (!session) continue;
    return co.instances.get(session.location?.directory ?? '') ?? co.instances.values().next().value;
  }
  return co.instances.values().next().value;
}

function receiverOf(co: Coordinator, openCodeSessionId: string) {
  return co.receivers.get(openCodeSessionId);
}

function writeWaits(receiver: Receiver) {
  const open = [...receiver.asks.values()];
  const count = (kind: string) => open.filter(ask => ask.kind === kind).length;
  const newest = (kind: string) => Math.max(0, ...open.filter(ask => ask.kind === kind).map(ask => ask.at)) || null;
  receiver.bridge.setWaits({ approvals: count('approval'), questions: count('question'), approvalAt: newest('approval'), questionAt: newest('question') });
}

function stopApprovals(co: Coordinator, test: (wait: { root: string; location: string }, requestId: string) => boolean) {
  for (const [requestId, wait] of co.approvals) {
    if (!test(wait, requestId)) continue;
    wait.controller.abort();
    co.approvals.delete(requestId);
  }
}

const SESSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;
type ToolPart = { name: unknown; input: Record<string, unknown> };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// The tool part that a permission request names (`data.source`), from the session context at ask time (spike D1b).
async function toolPartOf(ctx: any, data: Record<string, unknown>): Promise<ToolPart | null> {
  const source = data.source;
  if (!record(source) || typeof source.messageID !== 'string' || typeof source.id !== 'string' || typeof ctx?.session?.context !== 'function') return null;
  try {
    const rows = unwrap<unknown>(await ctx.session.context({ sessionID: data.sessionID }));
    const message = (Array.isArray(rows) ? rows : []).find(row => record(row) && row.id === source.messageID) as Record<string, unknown> | undefined;
    const part = (Array.isArray(message?.content) ? message.content : []).find(item => record(item) && item.type === 'tool' && item.id === source.id);
    const input = part?.state?.input;
    return record(input) ? { name: part.name, input } : null;
  } catch { return null; }
}

// The phone card of an OpenCode permission request: the tool's own input, never the permission view. Null keeps it on the PC.
// `resources` holds parsed parts of a command (D1a), so the card shows the command only when each part is in it.
function opencodeApproval(data: Record<string, unknown>, part: ToolPart | null, directory: unknown, subagent: boolean): Approval | null {
  const resources = data.resources;
  if (!part || !Array.isArray(resources) || !resources.length || !resources.every(item => typeof item === 'string' && item)) return null;
  const { input } = part;
  const end = subagent ? ' for a subagent?' : '?';
  const item = (label: string, text: string, mono = true) => ({ label, text, mono });
  if (data.action === 'shell') {
    const command = input.command;
    const folder = typeof input.workdir === 'string' ? input.workdir : directory;
    if (!whole(command) || !command || !resources.every(text => command.includes(text)) || !whole(folder) || !folder) return null;
    return { kind: 'tool', title: `Allow a shell command${end}`, display: [item('Command', command), item('Folder', folder)], note: true };
  }
  if (data.action === 'edit' && (part.name === 'write' || part.name === 'edit')) {
    const path = input.path;
    if (!whole(path) || !path || resources.length !== 1 || !whole(directory) || !isAbsolute(directory)) return null;
    // OpenCode can give a relative permission resource for an absolute tool input.
    const absolute = (value: string) => resolve(directory, value);
    const file = absolute(path);
    if (!whole(file) || file !== absolute(resources[0])) return null;
    const length = (value: unknown) => typeof value === 'string' ? value.length : 0;
    const size = part.name === 'write' ? `${length(input.content)} characters` : `${length(input.oldString)} to ${length(input.newString)} characters`;
    return { kind: 'tool', title: `Allow a file change${end}`, display: [item('File', file), item('Size', size, false)], note: true };
  }
  return null;
}

// Allow is one run only, never `always`; a deny always has a message, as a reject without one stops the turn (D0).
function permissionReply(sessionID: string, requestID: string, decided: Decision) {
  if (decided.decision === 'allow') return { sessionID, requestID, decision: 'once' as const };
  return { sessionID, requestID, decision: 'reject' as const, message: decided.note === undefined ? 'Denied from the phone.' : `Denied from the phone: ${decided.note}` };
}

// One detached phone wait for a request. Only the setup of the request's own folder can reply (D1b), so no other instance is used.
// The bridge replies only for a request that it registered and only from an engine answer of allow or deny.
function askPhone(co: Coordinator, receiver: Receiver, data: Record<string, unknown>, requestId: string, directory: unknown, subagent: boolean) {
  const owner = typeof directory === 'string' ? co.instances.get(directory) : undefined;
  const sessionKey = receiver.openCodeSessionId;
  if (!owner || typeof directory !== 'string' || !SESSION_KEY.test(sessionKey) || co.approvals.has(requestId)) return;
  const controller = new AbortController();
  co.approvals.set(requestId, { controller, root: sessionKey, location: directory });
  void (async () => {
    // No engine: no context read (it reads the whole session).
    const runtime = engineRuntime();
    if (!runtime) return;
    const approval = opencodeApproval(data, await toolPartOf(owner.ctx, data), directory, subagent);
    if (!approval || controller.signal.aborted) return;
    const decided = await waitForDecision(runtime, 'opencode', sessionKey, approval, controller.signal);
    if (!decided || controller.signal.aborted) return;
    // A failed reply is not tried again: the TUI dialog stays for the PC.
    try { await owner.ctx.permission.reply(permissionReply(String(data.sessionID), requestId, decided)); }
    catch { co.replyFailures += 1; }
  })().catch(() => {});
}

const CONTROL = /[\x00-\x1f\x7f]/;
const CONTROL_BUT_TAB_NEWLINE = /[\x00-\x08\x0b-\x1f\x7f]/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type MappedOption = { value: string; label: string; description?: string };
type MappedField = { key: string; question: string; multiSelect: boolean; custom: boolean; options: MappedOption[]; minItems?: number; maxItems?: number };
type MappedForm = { questions: PhoneQuestionItem[]; fields: MappedField[] };

// Maps an OpenCode 2.4 Form.Info to ASB phone questions only when every field is a single-choice string (with options)
// or multiselect with 1 to 8 options (1 to 4 fields total). Free text, number, integer, boolean, external, hidden, or
// conditional (`when`) fields keep the form on the PC.
function opencodeQuestion(form: Record<string, unknown>): MappedForm | null {
  const rawFields = form.fields;
  if (!Array.isArray(rawFields) || rawFields.length < 1 || rawFields.length > 4) return null;
  const questions: PhoneQuestionItem[] = [];
  const fields: MappedField[] = [];
  const seenQuestions = new Set<string>();
  const seenKeys = new Set<string>();
  for (const field of rawFields) {
    if (!record(field) || typeof field.key !== 'string' || !field.key || seenKeys.has(field.key)) return null;
    if (field.hidden === true || field.when !== undefined) return null;
    const multiSelect = field.type === 'multiselect';
    if (field.type !== 'string' && !multiSelect) return null;
    if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 8) return null;
    const options: MappedOption[] = [];
    const seenLabels = new Set<string>();
    for (const option of field.options) {
      if (!record(option) || typeof option.value !== 'string' || !option.value
        || typeof option.label !== 'string' || option.label.length < 1 || option.label.length > 200 || CONTROL.test(option.label)
        || seenLabels.has(option.label)) return null;
      if (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 1_000
        || CONTROL_BUT_TAB_NEWLINE.test(option.description))) return null;
      seenLabels.add(option.label);
      options.push({ value: option.value, label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) });
    }
    const title = typeof field.title === 'string' ? field.title.trim() : '';
    const desc = typeof field.description === 'string' ? field.description.trim() : '';
    const useHeader = Boolean(title && desc && title !== desc && title.length <= 100 && !CONTROL.test(title));
    const question = useHeader ? desc : (title || desc || field.key);
    const header = useHeader ? title : undefined;
    if (question.length < 1 || question.length > 2_000 || CONTROL_BUT_TAB_NEWLINE.test(question) || seenQuestions.has(question)) return null;
    seenKeys.add(field.key);
    seenQuestions.add(question);
    const minItems = multiSelect && typeof field.minItems === 'number' ? field.minItems : undefined;
    const maxItems = multiSelect && typeof field.maxItems === 'number' ? field.maxItems : undefined;
    questions.push({ question, ...(header !== undefined ? { header } : {}), options: options.map(({ label, description }) => ({ label, ...(description !== undefined ? { description } : {}) })), multiSelect });
    fields.push({ key: field.key, question, multiSelect, custom: field.custom === true, options, ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}) });
  }
  return { questions, fields };
}

// Maps the engine's QuestionAnswers (question text -> labels/other joined with `, `) back to OpenCode Form.Answer values.
// Refuses Other text when the field does not have `custom: true`, or counts outside minItems/maxItems.
function formAnswer(mapped: MappedForm, answers: QuestionAnswers): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const field of mapped.fields) {
    const raw = answers[field.question];
    if (typeof raw !== 'string' || !raw) return null;
    if (!field.multiSelect) {
      const hit = field.options.find(option => option.label === raw);
      if (hit) out[field.key] = hit.value;
      else if (field.custom) out[field.key] = raw;
      else return null;
    } else {
      let rest = raw;
      const values: string[] = [];
      const used = new Set<string>();
      const byLength = [...field.options].sort((a, b) => b.label.length - a.label.length);
      while (rest.length) {
        const exact = byLength.find(option => !used.has(option.label) && rest === option.label);
        if (exact) { values.push(exact.value); used.add(exact.label); rest = ''; break; }
        const prefix = byLength.find(option => !used.has(option.label) && rest.startsWith(`${option.label}, `));
        if (prefix) { values.push(prefix.value); used.add(prefix.label); rest = rest.slice(prefix.label.length + 2); continue; }
        if (!field.custom) return null;
        values.push(rest);
        rest = '';
      }
      if (!values.length || (field.minItems !== undefined && values.length < field.minItems)
        || (field.maxItems !== undefined && values.length > field.maxItems)) return null;
      out[field.key] = values;
    }
  }
  return out;
}

// Reads OpenCode's own service registration file (`$XDG_STATE_HOME/opencode/service.json`) for the server this plugin runs inside.
function opencodeService(env: NodeJS.ProcessEnv = process.env, pid = process.pid): { url: string; auth: string } | null {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME : env.HOME && isAbsolute(env.HOME) ? join(env.HOME, '.local', 'state') : '';
  if (!state) return null;
  const file = join(state, 'opencode', 'service.json');
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 16 * 1024 || (process.getuid && info.uid !== process.getuid())) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (parsed.pid !== pid || typeof parsed.url !== 'string' || typeof parsed.password !== 'string' || !parsed.password) return null;
    const url = new URL(parsed.url);
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return null;
    return { url: url.origin, auth: `Basic ${Buffer.from(`opencode:${parsed.password}`).toString('base64')}` };
  } catch { return null; }
}

async function replyForm(sessionID: string, formID: string, answer: Record<string, string | string[]>,
  service: { url: string; auth: string } | null = opencodeService()): Promise<boolean> {
  if (!service) return false;
  const response = await fetch(`${service.url}/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: service.auth },
    body: JSON.stringify({ answer }),
    signal: AbortSignal.timeout(5_000),
  });
  return response.ok;
}

function askPhoneQuestion(co: Coordinator, receiver: Receiver, form: Record<string, unknown>, requestId: string, directory: unknown) {
  const owner = typeof directory === 'string' ? co.instances.get(directory) : undefined;
  const sessionKey = receiver.openCodeSessionId;
  const formSessionId = String(form.sessionID ?? '');
  if (!owner || typeof directory !== 'string' || !SESSION_KEY.test(sessionKey) || !formSessionId || co.approvals.has(requestId)) return;
  const mapped = opencodeQuestion(form);
  if (!mapped) return;
  const controller = new AbortController();
  co.approvals.set(requestId, { controller, root: sessionKey, location: directory });
  void (async () => {
    const runtime = engineRuntime();
    if (!runtime) return;
    const answers = await waitForAnswers(runtime, 'opencode', sessionKey, mapped.questions, controller.signal);
    if (!answers || controller.signal.aborted) return;
    const answer = formAnswer(mapped, answers);
    if (!answer) { co.replyFailures += 1; return; }
    // A failed reply is not tried again: the TUI form stays for the PC.
    try {
      if (typeof owner.ctx?.session?.form?.reply === 'function') {
        await owner.ctx.session.form.reply({ sessionID: formSessionId, formID: requestId, answer });
      } else if (!await replyForm(formSessionId, requestId, answer)) {
        co.replyFailures += 1;
      }
    } catch { co.replyFailures += 1; }
  })().catch(() => {});
}

async function handleEvent(co: Coordinator, event: { id?: string; type?: string; data?: Record<string, unknown>; location?: { directory?: unknown } }) {
  const type = event.type ?? '';
  if (!HANDLED_EVENTS.has(type)) return;
  const id = event.id;
  if (id && !remember(co, id)) return;
  const data = event.data ?? {};
  const form = type === 'form.created' ? (data.form ?? {}) as Record<string, unknown> : undefined;
  const sessionId = String((form ?? data).sessionID ?? data.sessionId ?? '');
  const instance = sessionId ? await findInstanceFor(co, sessionId) : co.instances.values().next().value;
  if (!instance) return;
  const session = sessionId ? (await getSession(instance, sessionId) ?? { id: sessionId, title: data.title as string | undefined, location: data.location as { directory?: string } | undefined, parentID: data.parentID as string | undefined }) : undefined;
  if (!session) return;

  if (WAIT_EVENTS.has(type)) {
    // A subagent's request waits in its root session, as OpenCode shows it.
    const receiver = receiverOf(co, session.parentID ? await rootSessionId(instance, session.id) : session.id);
    const requestId = String((type === 'permission.replied' ? data.requestID : (form ?? data).id) ?? '');
    if (!receiver || !requestId) return;
    if (type === 'permission.asked' || type === 'form.created') receiver.asks.set(requestId, { kind: form ? 'question' : 'approval', at: Date.now() });
    else receiver.asks.delete(requestId);
    if (type === 'permission.replied' || type === 'form.replied' || type === 'form.cancelled') stopApprovals(co, (_wait, id) => id === requestId);
    writeWaits(receiver);
    if (type === 'permission.asked') askPhone(co, receiver, data, requestId, event.location?.directory, Boolean(session.parentID));
    if (type === 'form.created' && form) askPhoneQuestion(co, receiver, form, requestId, event.location?.directory);
    return;
  }
  if (type === 'session.renamed') {
    const receiver = receiverOf(co, session.id);
    if (!receiver) return;
    receiver.host.setTitle(String(data.title ?? session.title ?? ''));
    try { receiver.bridge.updateRuntime(await receiver.host.runtime(), true); } catch (error) { /* Keep the old name. */ }
    return;
  }
  if (type === 'session.execution.started') {
    if (session.parentID) return;
    co.running.add(session.id);
    const receiver = await registerSession(co, instance, session);
    if (receiver && 'bridge' in receiver) {
      receiver.lastActivity = Date.now();
      receiver.bridge.updateRuntime(await receiver.host.runtime());
    }
    return;
  }
  if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.execution.interrupted') {
    co.running.delete(session.id);
    const receiver = receiverOf(co, session.id);
    if (!receiver) return;
    receiver.lastActivity = Date.now();
    // A turn that ended has no open request.
    receiver.asks.clear();
    stopApprovals(co, wait => wait.root === session.id);
    writeWaits(receiver);
    receiver.bridge.updateRuntime(await receiver.host.runtime());
    return;
  }
  if (type === 'session.archived') {
    co.running.delete(session.id);
    await unregister(co, session.id);
    return;
  }
  if (type === 'session.deleted') {
    co.running.delete(session.id);
    await deleteSession(co, session.id);
    return;
  }
  if (type === 'session.inbox.delivered') {
    const receiver = receiverOf(co, session.id);
    receiver?.host.noteDelivered(String(data.inboxID ?? ''));
    touch(co, session.id);
    return;
  }
  if (type === 'session.inbox.enqueued') {
    const receiver = receiverOf(co, session.id);
    // Real shape: item: { type: 'user', payload: { text }, delivery }. id is the inboxID.
    const item = data.item as { type?: string; id?: string; text?: string; payload?: { text?: string } | undefined } | undefined;
    const text = item?.text ?? item?.payload?.text ?? '';
    if (item?.type === 'user') receiver?.host.noteHuman(String(text), String(item.id ?? data.inboxID ?? randomUUID()));
    touch(co, session.id);
    return;
  }
}

async function sweep(co: Coordinator) {
  await removeStaleReceivers(co.configDir, '', 'opencode-asb-bridge').catch(() => {});
  // Per-thread sweep of every live row of this entrypoint.
  for (const row of peers(co.configDir)) {
    if (row.entrypoint !== 'opencode-asb-bridge') continue;
    await removeStaleReceivers(co.configDir, row.sessionId, 'opencode-asb-bridge').catch(() => {});
  }
}

// The one rule for the cap eviction and the 12 h expiry: no turn runs, no message is held, and no agent waits for an idle notice.
function canClose(co: Coordinator, receiver: Receiver) {
  return !co.running.has(receiver.openCodeSessionId) && !receiver.bridge.held().length
    && !receiver.bridge.status().idleRequests.some(request => request.status === 'waiting');
}

async function expireIdle(co: Coordinator) {
  const now = Date.now();
  for (const receiver of [...co.receivers.values()]) {
    if (canClose(co, receiver) && now - receiver.lastActivity >= IDLE_MS) await unregister(co, receiver.openCodeSessionId);
  }
}

function readPluginConfig(): { claudeConfigDir: string; stateDir: string } {
  const folder = dirname(import.meta.path);
  const path = join(folder, 'asb-bridge.json');
  if (existsSync(path)) {
    try {
      const parsed = z.object({ claudeConfigDir: z.string(), stateDir: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8')));
      return parsed;
    } catch (error) { /* Fall through. */ }
  }
  return {
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude'),
    stateDir: join(process.env.HOME ?? '', '.local', 'state', 'asb-bridge'),
  };
}

function toolInput(schema: z.ZodType) {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

export default {
  id: 'asb.bridge',
  version,
  async setup(ctx: any) {
    const appVersion = String(ctx.app?.version ?? '0');
    const missing = !ctx.session?.synthetic || !ctx.tool?.transform || !ctx.event?.subscribe || compareVersion(appVersion, '2.1.2') < 0;
    if (missing) return;
    const { claudeConfigDir, stateDir } = readPluginConfig();
    const co = ensureCoordinator(claudeConfigDir, stateDir);
    mkdirSync(co.stateDir, { recursive: true, mode: 0o700 });
    privateDirectory(co.stateDir);
    const directory = String(ctx.location?.directory ?? process.cwd());
    const instance: Instance = { ctx, directory, disposers: [] };
    co.instances.set(directory, instance);

    await sweep(co);
    const recent = (await listLocationSessions(instance))
      .filter(session => !session.parentID && !session.archived)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, START_LIMIT);
    for (const session of recent) {
      if ((session.time?.updated ?? 0) < Date.now() - START_WINDOW_MS) continue;
      await registerSession(co, instance, session).catch(() => {});
    }

    // R1: subscribe takes options and returns an async iterable of { id, type, data }.
    const controller = new AbortController();
    let events: unknown;
    try {
      events = ctx.event.subscribe({ signal: controller.signal });
    } catch (error) { events = undefined; }
    instance.disposers.push(() => controller.abort(), () => stopApprovals(co, wait => wait.location === directory));
    if (typeof (events as { [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator] !== 'function') {
      console.error('ASB Bridge: OpenCode events are not available.');
    } else {
      void (async () => {
        try {
          for await (const event of events as AsyncIterable<unknown>) {
            if (controller.signal.aborted) break;
            try {
              await handleEvent(co, event as { id?: string; type?: string; data?: Record<string, unknown> });
            } catch (error) {
              console.error('ASB Bridge: event handling failed.', error);
            }
          }
        } catch (error) { /* Aborted or stream ended. */ }
      })();
    }

    ctx.tool.transform((editor: any) => {
      editor.namespace({ name: 'asb_bridge', description: 'Message other agents.' });
      editor.add({
        name: 'list_sessions',
        description: 'List agents here and on other machines of the group (remote: true). Send by reference if an entry has one, else by sessionId. Names, folders, and IDs can repeat: a sessionId goes to the local agent first. Status is idle or busy now only. agent is claude, codex, or opencode. nameContains: part of name.',
        input: toolInput(listSessionsInput),
        options: { namespace: 'asb_bridge' },
        execute: async (input: unknown, toolCtx: { sessionID?: string }) => {
          const sessionId = String(toolCtx?.sessionID ?? '');
          const rootId = await ensureToolReceiver(co, sessionId) ?? sessionId;
          touch(co, rootId);
          const receiver = receiverOf(co, rootId);
          const caller = receiver?.bridgeId ?? bridgeIdOf(rootId);
          return { content: JSON.stringify(await listSessions(caller, co.configDir, (input as { nameContains?: string })?.nameContains)) };
        },
      });
      editor.add({
        name: 'send_message',
        description: 'Send text to one agent. Its answer enters the current OpenCode turn, or starts one if the session is idle. Batch what you say into one message: a rapid burst to one agent is refused. Give sessionId (UUID from list_sessions) or reference (asb:1/... as given: exactly that session, on any machine of the group). notify_when_idle alone sends nothing and asks for one idle notice (only for a session on this machine).',
        input: toolInput(sendMessageInput),
        options: { namespace: 'asb_bridge' },
        execute: async (input: unknown, toolCtx: { sessionID?: string }) => {
          const sessionId = String(toolCtx?.sessionID ?? '');
          const rootId = await ensureToolReceiver(co, sessionId) ?? sessionId;
          const receiver = receiverOf(co, rootId);
          if (!receiver) return { content: JSON.stringify({ error: 'This OpenCode session is not registered.' }) };
          touch(co, rootId);
          return { content: JSON.stringify(await sendMessage(input as Record<string, unknown>, () => receiver.bridge)) };
        },
      });
      editor.add({
        name: 'status',
        description: 'Show receiver and recent outcomes. It starts at the first turn; no tool restarts it. Check unknown outcomes before resending.',
        input: toolInput(z.object({})),
        options: { namespace: 'asb_bridge' },
        execute: async (_input: unknown, toolCtx: { sessionID?: string }) => {
          const sessionId = String(toolCtx?.sessionID ?? '');
          const rootId = await ensureToolReceiver(co, sessionId) ?? sessionId;
          const receiver = receiverOf(co, rootId);
          if (!receiver) return { content: JSON.stringify({ openCodeSessionId: rootId, registered: false, reason: 'limit' }) };
          touch(co, rootId);
          return { content: JSON.stringify({ ...statusBrief(receiver.bridge), openCodeSessionId: rootId, registered: true }) };
        },
      });
    });

    const timer = setInterval(() => { void expireIdle(co).catch(() => {}); }, 60 * 60 * 1000);
    timer.unref?.();
    instance.disposers.push(() => clearInterval(timer));

    return async () => {
      for (const disposer of instance.disposers) { try { disposer(); } catch (error) { /* Already gone. */ } }
      co.instances.delete(directory);
      await Promise.allSettled([...co.registering.values()]);
      for (const receiver of [...co.receivers.values()]) {
        if (receiver.location === directory) await unregister(co, receiver.openCodeSessionId).catch(() => {});
      }
      if (!co.instances.size) {
        delete (globalThis as Record<symbol, unknown>)[COORDINATOR];
      }
    };
  },
};

// Q9: a subagent never registers; its tool call sends as the root session.
async function rootSessionId(instance: Instance, openCodeSessionId: string): Promise<string> {
  let id = openCodeSessionId;
  for (let i = 0; i < 8; i++) {
    const session = await getSession(instance, id);
    const parent = session?.parentID;
    if (!parent) return id;
    id = parent;
  }
  return id;
}

async function ensureToolReceiver(co: Coordinator, openCodeSessionId: string): Promise<string | undefined> {
  if (!openCodeSessionId) return undefined;
  const instance = await findInstanceFor(co, openCodeSessionId);
  if (!instance) return undefined;
  const rootId = await rootSessionId(instance, openCodeSessionId);
  const session = await getSession(instance, rootId) ?? { id: rootId };
  await registerSession(co, instance, session as SessionInfo).catch(() => {});
  return rootId;
}

function compareVersion(a: string, b: string) {
  const left = a.split('.').map(part => Number(part) || 0);
  const right = b.split('.').map(part => Number(part) || 0);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export { opencodeApproval, opencodeQuestion, formAnswer, opencodeService, replyForm, permissionReply, ensureCoordinator, coordinator, registerSession, unregister, deleteSession, handleEvent, canClose, expireIdle, bridgeIdOf, rootSessionId, recentInputs, CAP, START_LIMIT, START_WINDOW_MS, IDLE_MS };
