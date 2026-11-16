import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { Bridge } from '../src/bridge';
import { watchCodex } from '../src/codex';
import { appServer } from './app-server-fixture';
// POSIX only on Windows CI: the Unix socket file of the app-server fixture.
const posix = test.skipIf(process.platform === 'win32');

type Waits = { approvals: number; questions: number; approval_at: number | null; question_at: number | null };
const waits = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return db.query<Waits, []>('SELECT approvals,questions,approval_at,question_at FROM runtime WHERE singleton=1').get()!; }
  finally { db.close(); }
};
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

posix('the Codex approval wait follows activeFlags waitingOnApproval and resets at idle and close', async () => {
  const server = await appServer();
  const stateDir = mkdtempSync(join(tmpdir(), 'asb-waits-'));
  const file = join(stateDir, `${server.threadId}.sqlite`);
  const bridge = new Bridge(server.threadId, stateDir, stateDir, join(stateDir, 'unavailable.sock'));
  const stop = await watchCodex({ kind: 'app-server', path: server.path }, server.threadId, state => bridge.updateRuntime(state), () => {});
  try {
    expect(waits(file)).toEqual({ approvals: 0, questions: 0, approval_at: null, question_at: null });
    const before = Date.now();
    server.setState('active', ['waitingOnApproval']);
    await until(() => waits(file).approvals === 1);
    const first = waits(file).approval_at!;
    expect(first).toBeGreaterThanOrEqual(before);
    // The same wait keeps the time when the Bridge first saw it.
    await Bun.sleep(5);
    server.setState('active', ['waitingOnApproval', 'waitingOnUserInput']);
    await Bun.sleep(50);
    expect(waits(file)).toEqual({ approvals: 1, questions: 0, approval_at: first, question_at: null });
    // A question flag alone is no approval: Codex questions come from the rollouts.
    server.setState('active', ['waitingOnUserInput']);
    await until(() => waits(file).approvals === 0);
    expect(waits(file)).toEqual({ approvals: 0, questions: 0, approval_at: null, question_at: null });
    server.setState('active', ['waitingOnApproval']);
    await until(() => waits(file).approvals === 1);
    server.setState('idle');
    await until(() => waits(file).approvals === 0);
    expect(waits(file).approval_at).toBeNull();
    server.setState('active', ['waitingOnApproval']);
    await until(() => waits(file).approvals === 1);
    stop();
    await bridge.close();
    expect(waits(file)).toEqual({ approvals: 0, questions: 0, approval_at: null, question_at: null });
  } finally { stop(); await bridge.close(); await server.close(); rmSync(stateDir, { recursive: true }); }
});

posix('an unknown runtime and a new session clear the waits', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'asb-waits-'));
  const threadId = randomUUID();
  const file = join(stateDir, `${threadId}.sqlite`);
  const bridge = new Bridge(threadId, stateDir, stateDir, join(stateDir, 'unavailable.sock'));
  try {
    bridge.setWaits({ approvals: 2, questions: 1, approvalAt: 1000, questionAt: 2000 });
    expect(waits(file)).toEqual({ approvals: 2, questions: 1, approval_at: 1000, question_at: 2000 });
    // OpenCode has no approval field: its runtime updates keep the waits.
    bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
    expect(waits(file).approvals).toBe(2);
    bridge.updateRuntime({ status: 'unknown', mode: 'unknown' });
    expect(waits(file)).toEqual({ approvals: 0, questions: 0, approval_at: null, question_at: null });
    bridge.setWaits({ approvals: 1, questions: 0, approvalAt: 1000, questionAt: 3000 });
    expect(waits(file)).toEqual({ approvals: 1, questions: 0, approval_at: 1000, question_at: null });
    bridge.beginSession();
    expect(waits(file)).toEqual({ approvals: 0, questions: 0, approval_at: null, question_at: null });
  } finally { void bridge.close(); rmSync(stateDir, { recursive: true }); }
});

posix('a state database from an older Bridge gets the wait columns', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'asb-waits-'));
  const threadId = randomUUID();
  const file = join(stateDir, `${threadId}.sqlite`);
  const old = new Database(file, { create: true });
  old.exec(`CREATE TABLE runtime (singleton INTEGER PRIMARY KEY CHECK(singleton=1), status TEXT NOT NULL, mode TEXT NOT NULL, updated_at INTEGER, hop_token TEXT);
    INSERT INTO runtime (singleton,status,mode,updated_at,hop_token) VALUES (1,'idle','prompting',5,'abc');`);
  old.close();
  const bridge = new Bridge(threadId, stateDir, stateDir, join(stateDir, 'unavailable.sock'));
  try {
    expect(waits(file)).toEqual({ approvals: 0, questions: 0, approval_at: null, question_at: null });
    const db = new Database(file, { readonly: true });
    expect(db.query('SELECT status,hop_token FROM runtime').get()).toEqual({ status: 'idle', hop_token: 'abc' });
    db.close();
  } finally { await bridge.close(); rmSync(stateDir, { recursive: true }); }
});
