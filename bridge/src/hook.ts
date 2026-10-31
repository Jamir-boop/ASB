import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { Bridge } from './bridge';
import { nativePeer, peerAddress, peers, privateDirectory, processStart, removeReceiverFiles, removeStaleReceivers, uuid } from './claude';
import { appServerSocket, codexIpcPath, discoverTarget, readCodexCwd, watchCodex } from './codex';
import { isWindows, keyName } from './platform';
import { loadedAppServerThreads } from './app-server';

const eventSchema = z.object({ session_id: uuid, cwd: z.string().refine(isAbsolute),
  hook_event_name: z.enum(['SessionStart', 'SessionEnd']), generation: uuid.optional() });
type Event = z.infer<typeof eventSchema>;
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const stateDir = join(codexHome, 'plugin-state', 'asb-bridge');
const ipcPath = codexIpcPath(codexHome);
// An ended task that Codex has not loaded and that has no receiver loses its state file after this time.
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function receiver(threadId: string) {
  const matches = peers(configDir).filter(peer => peer.sessionId === threadId
    && peer.entrypoint === 'codex-asb-bridge');
  if (matches.length > 1) throw new Error('Multiple receivers claim this Codex task');
  return matches[0];
}

async function live(threadId: string) {
  try {
    await removeStaleReceivers(configDir, threadId);
    const active = receiver(threadId);
    return !!active?.procStart && await processStart(active.pid) === active.procStart;
  } catch { return false; }
}

async function runReceiver(event: Event) {
  const bridge = new Bridge(event.session_id, configDir, stateDir, ipcPath);
  let unwatch: (() => void) | undefined;
  let closing = false;
  let ready = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await bridge.close(); unwatch?.(); }
    finally { process.exit(0); }
  };
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('disconnect', () => { if (!ready) void close(); });
  try {
    bridge.setTarget(await discoverTarget(codexHome, ipcPath, event.session_id));
    unwatch = await watchCodex(bridge.target(), event.session_id, state => bridge.updateRuntime(state), () => { void close(); });
    // Windows inboxes are named pipes, so there is no socket folder.
    await bridge.start(isWindows() ? '' : socketDirectory(), event.cwd, uuid.parse(event.generation));
    if (closing) throw new Error('Codex disconnected during receiver startup');
    if (!process.connected) throw new Error('Session starter disconnected before readiness');
    ready = true;
    process.send?.({ ready: true }, error => { if (error) void close(); });
    process.disconnect?.();
  } catch (error) {
    const message = (error as { message?: unknown } | undefined)?.message;
    if (process.connected) process.send?.({ error: typeof message === 'string' ? message : 'Receiver startup failed' }, () => {});
    await close();
  }
}

function socketDirectory() {
  const livePeer = nativePeer(peers(configDir));
  let directory = livePeer ? dirname(livePeer.messagingSocketPath)
    : join(process.env.XDG_RUNTIME_DIR ?? process.env.CLAUDE_CODE_TMPDIR ?? '/tmp', 'cc-socks');
  try {
    if (Buffer.byteLength(join(directory, `${process.pid}.sock`)) > 103) throw new Error('Socket path too long');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
  } catch {
    directory = `/tmp/cc-socks-${process.getuid?.()}`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
  }
  return directory;
}


async function runHook(event: Event) {
  const state = new Bridge(event.session_id, configDir, stateDir, ipcPath);
  try {
    if (event.hook_event_name === 'SessionEnd') {
      const owner = state.endSession();
      if (!owner) return;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
        throw error;
      }
      if (await processStart(owner.pid) !== owner.proc_start) return;
      // Windows ends the receiver at once, so its own close() cannot send the end notices.
      const active = receiver(event.session_id);
      if (active) await state.finishSession(peerAddress(active.messagingSocketPath));
      process.kill(owner.pid, 'SIGTERM');
      const deadline = Date.now() + 2000;
      while (receiver(event.session_id) && Date.now() < deadline) await Bun.sleep(25);
      if (isWindows()) removeReceiverFiles(configDir, owner.pid, owner.proc_start);
      if (receiver(event.session_id)) throw new Error('Receiver did not stop');
      return;
    }
    await removeStaleReceivers(configDir, event.session_id);
    const active = receiver(event.session_id);
    if (active) {
      if (!active.procStart || await processStart(active.pid) !== active.procStart) throw new Error('Receiver process identity changed');
      return;
    }
    await startReceiver(state, event, state.beginSession());
  } finally { await state.close(); }
}

// Revive the receivers of threads that registered before and that Codex loaded again, e.g. after an app restart.
async function revive() {
  let files: string[];
  try { files = readdirSync(stateDir); } catch { return; }
  let appServerPath: string | undefined;
  let loaded = new Set<string>();
  try {
    const path = appServerSocket(codexHome);
    loaded = await loadedAppServerThreads(path);
    appServerPath = path;
  } catch { /* A failed list still permits the bounded desktop recovery below. */ }
  const states: { threadId: string; generation: string; endedAt?: number }[] = [];
  const now = Date.now();
  let newestEnd = 0;
  // Deleting needs both proofs: the loaded list and the registry were read.
  let withReceiver: Set<string> | undefined;
  try { withReceiver = new Set(peers(configDir).filter(peer => peer.entrypoint === 'codex-asb-bridge').map(peer => peer.sessionId)); }
  catch { /* No proof of a receiver: no file goes. */ }
  for (const file of files) {
    const threadId = uuid.safeParse(file.slice(0, -'.sqlite'.length)).data;
    if (!threadId || file !== `${threadId}.sqlite`) continue;
    try {
      const db = new Database(join(stateDir, file), { readonly: true });
      let expired = false;
      try {
        db.exec('PRAGMA busy_timeout=5000;');
        const lifecycle = db.query<{ generation: string; active: number; ended_at?: unknown }, []>('SELECT * FROM lifecycle WHERE singleton=1').get();
        const end = lifecycle?.ended_at;
        const endedAt = typeof end === 'number' && Number.isSafeInteger(end) && end > 0 && end <= now ? end : undefined;
        if (endedAt !== undefined) newestEnd = Math.max(newestEnd, endedAt);
        // active: a new session keeps the old ended_at, so a task with a crashed receiver can still be active.
        expired = lifecycle?.active === 0 && endedAt !== undefined && endedAt < now - STATE_RETENTION_MS && appServerPath !== undefined
          && !loaded.has(threadId) && withReceiver !== undefined && !withReceiver.has(threadId);
        if (!expired && lifecycle?.generation && db.query('SELECT 1 FROM transport WHERE singleton=1').get()) {
          states.push({ threadId, generation: lifecycle.generation, endedAt });
        }
      } finally { db.close(); }
      // The database is closed first: Windows keeps a file that is in use.
      if (expired) for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(join(stateDir, file + suffix)); } catch { /* Gone, or in use: the next sweep tries again. */ }
      }
    } catch { continue; }
  }
  for (const { threadId, generation, endedAt } of states) {
    const inAppServer = loaded.has(threadId);
    if ((!inAppServer && (endedAt === undefined || endedAt < newestEnd - 30000))
      || await live(threadId)) continue;
    let event: Event;
    try {
      const cwd = inAppServer ? await readCodexCwd({ kind: 'app-server', path: appServerPath! }, threadId)
        : await readCodexCwd({ kind: 'desktop', path: ipcPath }, threadId, 1000);
      event = eventSchema.parse({ session_id: threadId, cwd, hook_event_name: 'SessionStart' });
    } catch { continue; }
    const state = new Bridge(threadId, configDir, stateDir, ipcPath);
    try {
      const next = state.beginSession(generation);
      if (next) await startReceiver(state, event, next);
    } catch (error) {
      console.error(`Receiver revival for ${threadId} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    } finally { await state.close(); }
  }
}

async function startReceiver(state: Bridge, event: Event, generation: string) {
  try { await launchReceiver(event, generation); }
  catch (error) {
    // A concurrent starter replaced this generation or claimed the receiver first: its receiver is the one to keep.
    const deadline = Date.now() + 10000;
    const running = (pid: number | null) => { try { return pid !== null && process.kill(pid, 0); } catch { return false; } };
    for (let session = state.session(); session?.active && (session.generation !== generation || running(session.pid))
      && Date.now() < deadline; session = state.session()) {
      if (await live(event.session_id)) return;
      await Bun.sleep(50);
    }
    throw error;
  }
}

async function launchReceiver(event: Event, generation: string) {
  const child = spawn(process.execPath, [z.string().min(1).parse(process.argv[1]), '--receive'],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'], env: process.env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Receiver startup timed out')), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Receiver exited before readiness')));
      child.once('message', value => {
        const message = z.object({ ready: z.boolean().optional(), error: z.string().optional() }).safeParse(value);
        if (message.success && message.data.ready) resolve();
        else reject(new Error(message.success ? message.data.error : 'Invalid receiver readiness'));
      });
      child.stdin?.end(JSON.stringify({ ...event, generation }));
    });
  } catch (error) { child.kill('SIGTERM'); throw error; }
  finally { clearTimeout(timer); child.unref(); }
}

try {
  if (process.argv[2] === '--revive') await revive();
  else {
    const event = eventSchema.parse(JSON.parse(await Bun.stdin.text()));
    if (process.argv[2] === '--receive') await runReceiver(event);
    else await runHook(event);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Session receiver hook failed');
  process.exitCode = 1;
}
