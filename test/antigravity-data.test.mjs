import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerAgyInKitty, loadAntigravityDashboard } from '../src/antigravity-data.mjs';
import { AppSourceRegistry } from '../src/app-sources.mjs';
import { buildSwitchboardDashboard, isSwitchboardRoot, loadSwitchboardDashboard, PendingTracker, switchboardWatchPaths } from '../src/switchboard.mjs';

const now = Date.parse('2026-11-22T12:00:00Z');
const minute = 60_000;
const day = 24 * 60 * minute;
const id = (n) => `${String(n).padStart(8, '0')}-a221-41ba-96c9-1c571ac0565b`;
const LIVE = { 400: '4377321' };
const startOf = async (pid) => LIVE[pid] ?? null;

async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'asb-agy-data-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const dataDir = path.join(homeDir, 'state', 'asb', 'agy');
  await mkdir(dataDir, { recursive: true });
  const put = async (n, fields = {}) => {
    const record = { conversationId: id(n), workspace: path.join(homeDir, 'ws'), state: 'working', stateAtMs: now - minute, createdAtMs: now - 5 * minute,
      agyPid: 400, agyStartTicks: '4377321', kittyWindowId: '1', ...fields };
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
    await writeFile(path.join(dataDir, `${id(n)}.json`), JSON.stringify(record), { mode: 0o600 });
  };
  const load = (options = {}) => loadAntigravityDashboard({ dataDir, nowMs: now, homeDir, startOf, ...options });
  const rows = async (options) => buildSwitchboardDashboard((await load(options)).threads, [], options?.nowMs ?? now).threads;
  return { homeDir, dataDir, put, load, rows };
}

test('each live state gives its row status', async (t) => {
  const { homeDir, put, rows } = await fixture(t);
  await put(1, { state: 'idle' });
  await put(2, { state: 'working' });
  await put(3, { state: 'question' });
  await put(4, { state: 'done' });
  await put(5, { state: 'failed' });
  const byId = new Map((await rows()).map((row) => [row.externalId, row]));
  const row = byId.get(id(2));
  assert.deepEqual([row.id, row.provider, row.providerLabel, row.surface, row.title, row.cwd, row.canOpen, row.appDeepLink],
    [`agy:${id(2)}`, 'antigravity', 'Antigravity CLI', 'cli', 'ws · 00000002', path.join(homeDir, 'ws'), false, '']);
  assert.deepEqual([byId.get(id(1)).state, byId.get(id(1)).reason], ['idle', 'The CLI session has no task yet.']);
  assert.equal(row.state, 'working');
  const question = byId.get(id(3));
  assert.deepEqual([question.state, question.questionPending, Boolean(question.actionRequired)], ['waiting', true, false]);
  const done = byId.get(id(4));
  assert.deepEqual([done.state, done.lastOutcome, done.completionAtMs], ['idle', '', now - minute]);
  const failed = byId.get(id(5));
  assert.deepEqual([failed.state, failed.lastOutcome, failed.failedAtMs, failed.completionAtMs], ['idle', 'failed', now - minute, 0]);
});

test('an agy subagent counts on its parent without changing the parent state or getting a card', async (t) => {
  const { put, load, rows } = await fixture(t);
  await put(1, { state: 'idle' });
  await put(2, { parentConversationId: id(1), agentName: 'research' });
  await put(3, { parentConversationId: id(4) });
  const [, child, orphan] = (await load()).threads;
  assert.deepEqual([child.isSubagent, child.parentThreadId, child.agentNickname, child.title],
    [true, `agy:${id(1)}`, 'research', 'research']);
  assert.deepEqual([orphan.isSubagent, orphan.parentThreadId, orphan.agentNickname, orphan.title],
    [true, `agy:${id(4)}`, '', 'ws · 00000003']);
  assert.equal(isSwitchboardRoot(child), false);
  assert.equal(isSwitchboardRoot(orphan), false);
  for (const state of ['working', 'failed']) {
    await put(2, { parentConversationId: id(1), agentName: 'research', state });
    assert.deepEqual((await rows()).map((row) => [row.externalId, row.subagentCount, row.state, row.lastOutcome]),
      [[id(1), 1, 'idle', '']], state);
  }
});

test('a record whose agy ended, or whose PID was reused, is not live', async (t) => {
  const { put, rows, load } = await fixture(t);
  await put(1, { state: 'working', agyPid: 401, agyStartTicks: '1' });
  await put(2, { state: 'question', agyStartTicks: '999' });
  await put(3, { state: 'idle', agyPid: undefined, agyStartTicks: undefined });
  await put(4, { state: 'done', agyPid: 401, agyStartTicks: '1' });
  await put(5, { state: 'failed', agyPid: 401, agyStartTicks: '1' });
  const byId = new Map((await rows()).map((row) => [row.externalId, row]));
  for (const n of [1, 2]) {
    assert.deepEqual([byId.get(id(n)).state, byId.get(id(n)).reason, byId.get(id(n)).processEnded, byId.get(id(n)).failedAtMs],
      ['unknown', 'The agy process ended during a task.', undefined, 0]);
  }
  for (const n of [3, 4, 5]) assert.deepEqual([byId.get(id(n)).state, byId.get(id(n)).reason], ['idle', 'The agy process ended.']);
  assert.deepEqual([byId.get(id(4)).completionAtMs, byId.get(id(5)).lastOutcome], [now - minute, 'failed']);
  // A quit during a turn (Esc then /exit gives no event) is not a failure for the tracker.
  for (const state of ['working', 'question']) {
    await put(6, { state, agyPid: 400, agyStartTicks: '4377321' });
    const tracker = new PendingTracker(false);
    const scan = async () => tracker.observe(buildSwitchboardDashboard((await load()).threads, [], now));
    assert.notEqual((await scan()).threads.find((row) => row.externalId === id(6)).state, 'unknown');
    await put(6, { state, agyPid: 401, agyStartTicks: '1' });
    const ended = (await scan()).threads.find((row) => row.externalId === id(6));
    assert.deepEqual([ended.state, ended.processEnded, ended.failedAtMs, ended.lastOutcome, Boolean(ended.failedAttention), tracker.records[ended.id]?.pendingKind || ''],
      ['unknown', undefined, 0, '', false, ''], state);
  }
});

test('a quiet agy turn becomes Unknown after 60 seconds and resumes on new evidence', async (t) => {
  const { homeDir, put, rows, load } = await fixture(t);
  const transcript = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', id(2), 'transcript.jsonl');
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, '');
  await utimes(transcript, (now - 20_000) / 1000, (now - 20_000) / 1000);
  // Off the 30 s grid, so the quiet deadline is the next check.
  const old = now - minute - 3_000;
  await put(1, { event: 'PreInvocation', stateAtMs: old });
  await put(2, { stateAtMs: old, transcriptMtimePath: transcript });
  await put(3, { stateAtMs: old, background: true });
  await put(4, { state: 'question', stateAtMs: now - 11 * minute });
  const byId = new Map((await rows()).map((row) => [row.externalId, row]));
  const quiet = byId.get(id(1));
  assert.deepEqual([quiet.state, quiet.reason, quiet.completionAtMs, quiet.failedAtMs],
    ['unknown', 'No news from the agy session for 60 seconds.', 0, 0]);
  assert.equal(byId.get(id(4)).state, 'waiting');
  assert.equal(byId.get(id(4)).questionPending, true);
  assert.equal((await rows({ nowMs: now + 7 * 60 * minute })).find((row) => row.externalId === id(4)).state, 'waiting');
  assert.equal(byId.get(id(2)).state, 'working');
  assert.equal(byId.get(id(3)).state, 'working');
  const early = now - 8_000;
  const threads = (await load({ nowMs: early })).threads;
  assert.deepEqual(threads.map((thread) => [thread.externalId, thread.cliProcessCheckAtMs]),
    [[id(1), old + minute], [id(2), now], [id(3), now], [id(4), now]]);
  assert.equal(buildSwitchboardDashboard(threads, [], early).nextStatusCheckAtMs, old + minute + 1);
  assert.equal((await rows({ nowMs: old + minute })).find((row) => row.externalId === id(1)).state, 'working');
  assert.equal((await rows({ nowMs: old + minute + 1 })).find((row) => row.externalId === id(1)).state, 'unknown');
  assert.equal((await rows({ nowMs: now + 20 * minute })).find((row) => row.externalId === id(3)).state, 'working');
  await utimes(transcript, (now + 2 * minute) / 1000, (now + 2 * minute) / 1000);
  assert.equal((await rows({ nowMs: now + 2 * minute })).find((row) => row.externalId === id(2)).state, 'working');
  const tracker = new PendingTracker(false);
  const observe = async (atMs) => (await tracker.observe(buildSwitchboardDashboard((await load({ nowMs: atMs })).threads, [], atMs)))
    .threads.find((row) => row.externalId === id(1));
  assert.equal((await observe(early)).state, 'working');
  const silent = await observe(now);
  assert.deepEqual([silent.state, silent.completionAttention, silent.failedAttention], ['unknown', false, false]);
  await put(1, { state: 'done', event: 'Stop', stateAtMs: now + minute });
  const done = await observe(now + minute);
  assert.deepEqual([done.state, done.completionAtMs, done.completionAttention], ['idle', now + minute, true]);
});

test('bad files are skipped, at most 500 files are read, and old records that are not live are removed', async (t) => {
  const { homeDir, dataDir, put, load } = await fixture(t);
  await put(1);
  await writeFile(path.join(dataDir, `${id(2)}.json`), 'not json');
  await put(3, { extra: 'x' });
  await put(4, { conversationId: id(5) });
  await put(6, { workspace: 'relative' });
  await put(7, { state: 'asleep' });
  await put(8, { kittyListenOn: 'tcp:localhost:1' });
  await put(9, { transcriptMtimePath: '/etc/passwd' });
  await writeFile(path.join(dataDir, `${id(10)}.json`), JSON.stringify({ conversationId: id(10), pad: 'x'.repeat(20_000) }));
  await symlink(path.join(dataDir, `${id(1)}.json`), path.join(dataDir, `${id(11)}.json`));
  await writeFile(path.join(dataDir, 'notes.json'), '{}');
  await put(15, { parentConversationId: '../bad-id' });
  await put(16, { parentConversationId: id(16).toUpperCase() });
  await put(17, { agentName: 'orphan name' });
  await put(18, { parentConversationId: id(1), agentName: 'bad\x7fname' });
  assert.deepEqual((await load()).threads.map((thread) => thread.externalId), [id(1)]);
  await put(12, { agyPid: 401, stateAtMs: now - 8 * day });
  await put(13, { stateAtMs: now - 8 * day });
  await put(14, { agyPid: 401, stateAtMs: now - 6 * day });
  const kept = (await load()).threads.map((thread) => thread.externalId);
  assert.deepEqual(kept, [id(1), id(13), id(14)]);
  assert.equal((await readdir(dataDir)).includes(`${id(12)}.json`), false);
  await rm(dataDir, { recursive: true });
  await mkdir(dataDir);
  for (let n = 1; n <= 501; n += 1) await put(n);
  assert.equal((await load()).threads.length, 500);
  assert.deepEqual((await loadAntigravityDashboard({ dataDir: path.join(homeDir, 'none'), nowMs: now })).provider, { installed: false, status: 'missing', message: '' });
});

test('Antigravity CLI is a default source with fixed folder, no launcher, the eight-source limit, and a watch path', async (t) => {
  const { homeDir, put } = await fixture(t);
  const env = { XDG_STATE_HOME: path.join(homeDir, 'state') };
  const configPath = path.join(homeDir, 'config', 'sources.json');
  const registry = new AppSourceRegistry({ homeDir, env, platform: 'linux', configPath, discoverPersonal: false });
  const sources = await registry.read();
  const agy = sources.find((item) => item.id === 'antigravity');
  assert.equal(agy.color, '#ae9c78');
  assert.notEqual(agy.color, sources.find((item) => item.id === 'codex').color);
  assert.deepEqual([agy.provider, agy.label, agy.dataDir, agy.launcher, agy.enabled, agy.builtin],
    ['antigravity', 'Antigravity CLI', path.join(homeDir, 'state', 'asb', 'agy'), '', true, true]);
  await assert.rejects(registry.update({ ...agy, dataDir: path.join(homeDir, 'other') }), { message: 'The Antigravity CLI data folder cannot change.' });
  await assert.rejects(registry.update({ ...agy, launcher: '/usr/bin/codex' }), { message: 'The Antigravity CLI profile takes no launcher.' });
  const { id: _id, builtin: _builtin, ...copy } = agy;
  await assert.rejects(registry.update({ ...copy, dataDir: path.join(homeDir, 'copy') }), { message: 'Only the default Antigravity CLI profile is supported.' });
  await assert.rejects(registry.remove('antigravity'), { statusCode: 400 });
  // A file from before the support gains the source in memory; a file with eight sources does not.
  await mkdir(path.dirname(configPath), { recursive: true });
  const stored = sources.filter((item) => item.id !== 'antigravity').map(({ builtin: _b, ...item }) => item);
  await writeFile(configPath, JSON.stringify({ version: 1, sources: stored }));
  const old = new AppSourceRegistry({ homeDir, env, platform: 'linux', configPath, discoverPersonal: false });
  assert.equal((await old.read()).at(-1).id, 'antigravity');
  const full = [...stored, ...[1, 2, 3, 4, 5].map((n) => ({ id: `claude-extra-${n}`, provider: 'claude-desktop-code', label: `Extra ${n}`,
    dataDir: path.join(homeDir, `extra-${n}`), projectsDir: path.join(homeDir, `extra-${n}`, 'projects'), launcher: '/usr/bin/claude', enabled: false }))];
  await writeFile(configPath, JSON.stringify({ version: 1, sources: full }));
  const eight = new AppSourceRegistry({ homeDir, env, platform: 'linux', configPath, discoverPersonal: false });
  assert.equal((await eight.read()).some((item) => item.provider === 'antigravity'), false);
  // The loader runs for the source, and the engine watches its folder.
  await put(1);
  const board = await loadSwitchboardDashboard({ sources, nowMs: now, loadCodex: async () => ({ threads: [] }),
    loadClaude: async () => ({ threads: [] }), loadOpenCode: async () => ({ threads: [] }) });
  assert.equal(board.providers.find((item) => item.id === 'antigravity').status, 'ready');
  const row = board.threads.find((item) => item.provider === 'antigravity');
  assert.deepEqual([row.sourceId, row.providerLabel, row.canOpen], ['antigravity', 'Antigravity CLI', false]);
  const spec = switchboardWatchPaths({ homeDir, agyDir: agy.dataDir }).find((item) => item.source === 'antigravity');
  assert.deepEqual([spec.path, spec.optional], [agy.dataDir, true]);
  assert.deepEqual([`${id(1)}.json`, `${id(1)}.title`, `${id(1)}.json.${id(2)}.tmp`, `${id(1)}.title.${id(2)}.tmp`, 'notes.json', ''].map((name) => spec.acceptEvent(name)), [true, true, false, false, false, true]);
});

test('loader uses valid .title, falls back on bad mode/symlink/size/content, ignores orphan .title, and removes .title with old records', async (t) => {
  const { dataDir, put, load } = await fixture(t);
  await put(1);
  await writeFile(path.join(dataDir, `${id(1)}.title`), 'asb-agy-w', { mode: 0o600 });
  await put(2);
  await writeFile(path.join(dataDir, `${id(2)}.title`), 'wrong-mode', { mode: 0o644 });
  await chmod(path.join(dataDir, `${id(2)}.title`), 0o644);
  await put(3);
  await symlink(path.join(dataDir, `${id(1)}.title`), path.join(dataDir, `${id(3)}.title`));
  await put(4);
  await writeFile(path.join(dataDir, `${id(4)}.title`), 'x'.repeat(1025), { mode: 0o600 });
  await put(5);
  await writeFile(path.join(dataDir, `${id(5)}.title`), 'bad\u0007title', { mode: 0o600 });
  // Orphan .title with no record
  await writeFile(path.join(dataDir, `${id(6)}.title`), 'orphan-title', { mode: 0o600 });
  // Old non-live record with .title -> both removed
  await put(7, { agyPid: 401, stateAtMs: now - 8 * day });
  await writeFile(path.join(dataDir, `${id(7)}.title`), 'old-title', { mode: 0o600 });

  const threads = (await load()).threads;
  const byId = new Map(threads.map((thread) => [thread.externalId, thread.title]));
  assert.equal(byId.get(id(1)), 'asb-agy-w');
  assert.equal(byId.get(id(2)), 'ws · 00000002');
  assert.equal(byId.get(id(3)), 'ws · 00000003');
  assert.equal(byId.get(id(4)), 'ws · 00000004');
  assert.equal(byId.get(id(5)), 'ws · 00000005');
  assert.equal(byId.has(id(6)), false);
  assert.equal(byId.has(id(7)), false);
  const files = await readdir(dataDir);
  assert.equal(files.includes(`${id(7)}.json`), false);
  assert.equal(files.includes(`${id(7)}.title`), false);
});

test('answerAgyInKitty verifies screens and types single, multi-question, write-in, multi-select, and refuses mismatch/gone/newline', async (t) => {
  const { homeDir, dataDir, put } = await fixture(t);
  const procDir = path.join(homeDir, 'proc');
  const writeProc = async (pid, comm, ppid) => {
    const pdir = path.join(procDir, String(pid));
    await mkdir(pdir, { recursive: true });
    await writeFile(path.join(pdir, 'stat'), `${pid} (${comm}) S ${ppid} ${Array(17).fill('0').join(' ')} 1 0 0\n`);
  };
  await writeProc(300, 'kitty', 1);
  await writeProc(400, 'agy', 300);
  await put(1, { state: 'question', kittyPid: '300', kittyWindowId: '2', kittyListenOn: 'unix:@kitty-300' });

  const qFruit = { question: 'ASB probe: pick a fruit', options: [{ label: 'Kiwi' }, { label: 'Plum' }], multiSelect: false };
  const qSize = { question: 'ASB probe: pick a size', options: [{ label: 'Small' }, { label: 'Large' }], multiSelect: false };
  const qToppings = { question: 'ASB probe: pick toppings', options: [{ label: 'Salt' }, { label: 'Pepper' }, { label: 'Lime' }], multiSelect: true };

  const formSingle = (k, n, q) => `Question ${k}/${n}: ${q.question}\n\n> 1. ${q.options[0].label}\n  2. ${q.options[1].label}\n  3. Write-in...\n\n  ↑/↓ Navigate · enter Select · esc Skip`;
  const formMulti = (checked = new Set()) => `Question 1/1: ${qToppings.question}\n\n${
    qToppings.options.map((o, i) => `${i === 0 ? '> ' : '  '}${i + 1}. [${checked.has(i + 1) ? 'x' : ' '}] ${o.label}`).join('\n')
  }\n  4. Write-in...\n\n  ↑/↓ Navigate · space Toggle · enter Submit`;

  const runAnswer = (questions, items, handler) => {
    const calls = [];
    return answerAgyInKitty({
      dataDir, id: id(1), questions, items, procDir, startOf, homeDir,
      wait: async () => {},
      exec: async (args) => { calls.push(args); return handler(args); },
    }).then((result) => ({ result, calls }));
  };

  // 1. Single digit
  {
    const { result, calls } = await runAnswer([qFruit], [{ selected: ['Plum'] }], () => formSingle(1, 1, qFruit));
    assert.equal(result, true);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text', 'send-text']);
    assert.deepEqual(calls[1].slice(-2), ['--', '2']);
  }

  // 2. Two questions
  {
    let step = 1;
    const { result, calls } = await runAnswer([qFruit, qSize], [{ selected: ['Kiwi'] }, { selected: ['Large'] }], (args) => {
      if (args[3] === 'send-text') step += 1;
      return step === 1 ? formSingle(1, 2, qFruit) : formSingle(2, 2, qSize);
    });
    assert.equal(result, true);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text', 'send-text', 'get-text', 'send-text']);
    assert.deepEqual([calls[1].at(-1), calls[3].at(-1)], ['1', '2']);
  }

  // 3. Single select Write-in
  {
    let screen = formSingle(1, 1, qFruit);
    const { result, calls } = await runAnswer([qFruit], [{ selected: [], other: 'Teal, with a comma' }], (args) => {
      if (args[3] === 'send-text' && args.at(-1) === '3') screen = 'Your answer:\n';
      else if (args[3] === 'send-text' && args.includes('--bracketed-paste=enable')) screen = `Your answer:\n${args.at(-1)}`;
      return screen;
    });
    assert.equal(result, true);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text', 'send-text', 'get-text', 'send-text', 'get-text', 'send-key']);
    assert.deepEqual(calls[3].slice(-3), ['--bracketed-paste=enable', '--', 'Teal, with a comma']);
    assert.deepEqual(calls[5].slice(-1), ['enter']);
  }

  // 4. Multi-select without Write-in
  {
    const checked = new Set();
    const { result, calls } = await runAnswer([qToppings], [{ selected: ['Salt', 'Lime'] }], (args) => {
      if (args[3] === 'send-text') checked.add(Number(args.at(-1)));
      return formMulti(checked);
    });
    assert.equal(result, true);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text', 'send-text', 'get-text', 'send-text', 'get-text', 'send-key']);
    assert.deepEqual([calls[1].at(-1), calls[3].at(-1), calls[5].at(-1)], ['1', '3', 'enter']);
  }

  // 5. Multi-select with Write-in
  {
    const checked = new Set();
    let mode = 'form';
    let pasted = '';
    const { result, calls } = await runAnswer([qToppings], [{ selected: ['Salt', 'Lime'], other: 'Chili' }], (args) => {
      if (args[3] === 'send-text') {
        const last = args.at(-1);
        if (last === '4') mode = 'writein';
        else if (args.includes('--bracketed-paste=enable')) { mode = 'pasted'; pasted = last; }
        else checked.add(Number(last));
      }
      return mode === 'form' ? formMulti(checked) : mode === 'writein' ? 'Your answer:\n' : `Your answer:\n${pasted}`;
    });
    assert.equal(result, true);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text', 'send-text', 'get-text', 'send-text', 'get-text', 'send-text', 'get-text', 'send-text', 'get-text', 'send-key']);
    assert.deepEqual(calls[7].slice(-3), ['--bracketed-paste=enable', '--', 'Chili']);
  }

  // 6. Mismatched screen types nothing
  {
    const wrong = formSingle(1, 1, qSize).replace('Question 1/1: ASB probe: pick a size', 'Question 1/1: ASB probe: pick a fruit');
    const { result, calls } = await runAnswer([qFruit], [{ selected: ['Kiwi'] }], () => wrong);
    assert.equal(result, false);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text']);
  }

  // 7. Gone form (no Question header on screen, or record state changed)
  {
    const { result, calls } = await runAnswer([qFruit], [{ selected: ['Kiwi'] }], () => 'normal prompt\n> ');
    assert.equal(result, null);
    assert.deepEqual(calls.map((c) => c[3]), ['get-text']);
    await put(1, { state: 'working', kittyPid: '300', kittyWindowId: '2', kittyListenOn: 'unix:@kitty-300' });
    const after = await runAnswer([qFruit], [{ selected: ['Kiwi'] }], () => formSingle(1, 1, qFruit));
    assert.equal(after.result, null);
    assert.equal(after.calls.length, 0);
    await put(1, { state: 'question', kittyPid: '300', kittyWindowId: '2', kittyListenOn: 'unix:@kitty-300' });
  }

  // 8. Newline in other: refused before typing anything
  {
    const { result, calls } = await runAnswer([qFruit], [{ selected: [], other: 'line1\nline2' }], () => formSingle(1, 1, qFruit));
    assert.equal(result, false);
    assert.equal(calls.length, 0);
  }
});
