import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getClaudeCacheStats, invalidateClaudeData, loadClaudeDesktopCodeThreads, parseClaudeJsonlSignals,
} from '../src/claude-data.mjs';
import { buildSwitchboardDashboard } from '../src/switchboard.mjs';

const nowMs = Date.parse('2026-10-07T12:00:00Z');
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const event = (type, offset, extra = {}) => ({ type, timestamp: new Date(nowMs + offset).toISOString(), ...extra });

async function fixture(t, count = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asb-claude-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const appDir = path.join(directory, 'app');
  const projectsDir = path.join(directory, 'projects');
  const metadataDir = path.join(appDir, 'claude-code-sessions');
  await fs.mkdir(metadataDir, { recursive: true });
  await fs.mkdir(projectsDir);
  const transcripts = [];
  for (let index = 0; index < count; index++) {
    const cliSessionId = `session-${index}`;
    const transcriptPath = path.join(projectsDir, `${cliSessionId}.jsonl`);
    await fs.writeFile(path.join(metadataDir, `local_${index}.json`), JSON.stringify({
      sessionId: `local_${index}`, cliSessionId, title: `Task ${index}`, cwd: '/tmp/synthetic-work',
    }));
    await fs.writeFile(transcriptPath, jsonl([
      event('user', -1000, { message: { content: 'Start this task.' } }),
      event('progress', -500, { data: 'x'.repeat(2048) }),
    ]));
    transcripts.push(transcriptPath);
  }
  const options = { appDir, projectsDir, nowMs: nowMs + 1000, maxBytes: 256 };
  const scan = async () => buildSwitchboardDashboard((await loadClaudeDesktopCodeThreads(options)).threads, [], options.nowMs);
  return { transcripts, scan };
}

test('Claude index invalidation reuses unchanged transcripts and reads only changed lifecycle', async (t) => {
  const { transcripts, scan } = await fixture(t, 3);
  assert.ok((await scan()).threads.every((thread) => thread.state === 'working'));
  await scan();
  const warm = getClaudeCacheStats().jsonlSignals;
  invalidateClaudeData({ filePath: '', index: true });
  assert.ok((await scan()).threads.every((thread) => thread.state === 'working'));
  const unchanged = getClaudeCacheStats().jsonlSignals;
  assert.equal(unchanged.bytesRead - warm.bytesRead, 0);
  assert.equal(unchanged.hits - warm.hits, transcripts.length);

  const completed = jsonl([event('result', 100, { terminal_reason: 'completed' })]);
  await fs.appendFile(transcripts[0], completed);
  invalidateClaudeData({ filePath: '', index: true });
  const changed = await scan();
  const reads = getClaudeCacheStats().jsonlSignals;
  assert.equal(changed.threads.find((thread) => thread.externalId === 'local_0').state, 'idle');
  assert.equal(changed.threads.find((thread) => thread.externalId === 'local_0').completionAtMs, nowMs + 100);
  assert.equal(reads.bytesRead - unchanged.bytesRead, 64 + Buffer.byteLength(completed));
  assert.equal(reads.hits - unchanged.hits, transcripts.length - 1);
  assert.ok(reads.entries <= reads.limit && reads.limit <= 5000);
});

test('Claude lifecycle recovery detects same-size rewrites and targeted invalidation', async (t) => {
  for (const changedField of ['mtimeMs', 'ctimeMs', 'invalidated']) {
    await t.test(changedField, async (t) => {
      const { transcripts: [transcriptPath], scan } = await fixture(t);
      const records = jsonl([
        event('user', -1000, { message: { content: 'Start this task.' } }),
        event('result', -900, { terminal_reason: 'completed' }),
        event('progress', -500, { data: 'x'.repeat(2048) }),
      ]);
      await fs.writeFile(transcriptPath, records);
      const originalStat = fs.stat;
      const signature = await fs.stat(transcriptPath);
      let observedStat = signature;
      t.mock.method(fs, 'stat', async (filePath, ...args) => filePath === transcriptPath
        ? observedStat : originalStat(filePath, ...args));
      assert.equal((await scan()).threads[0].completionAtMs, nowMs - 900);
      const before = getClaudeCacheStats().jsonlSignals.bytesRead;
      const rewritten = records.replace('completed', 'cancelled');
      assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(records));
      await fs.writeFile(transcriptPath, rewritten);
      if (changedField === 'invalidated') invalidateClaudeData({ filePath: transcriptPath });
      else observedStat = { ...signature, [changedField]: signature[changedField] + 1 };
      const stopped = (await scan()).threads[0];
      assert.equal(stopped.state, 'idle');
      assert.equal(stopped.completionAtMs, 0);
      assert.equal(stopped.lastOutcome, 'stopped');
      assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead - before, 256 + signature.size);
    });
  }
});

test('Claude append checkpoints recover from truncation, replacement, and a changed append boundary', async (t) => {
  for (const change of ['truncation', 'replacement', 'rewrite-and-grow']) {
    await t.test(change, async (t) => {
      const { transcripts: [transcriptPath], scan } = await fixture(t);
      const records = jsonl([
        event('user', -1000, { message: { content: 'Start this task.' } }),
        event('progress', -950, { data: 'x'.repeat(2048) }),
        event('result', -900, { terminal_reason: 'completed' }),
      ]);
      await fs.writeFile(transcriptPath, records);
      assert.equal((await scan()).threads[0].completionAtMs, nowMs - 900);
      if (change === 'truncation') await fs.writeFile(transcriptPath,
        jsonl([event('user', -800, { message: { content: 'Start a different task.' } })]));
      else if (change === 'replacement') {
        await fs.writeFile(`${transcriptPath}.replacement`, records.replace('completed', 'cancelled'));
        await fs.rename(`${transcriptPath}.replacement`, transcriptPath);
      } else await fs.writeFile(transcriptPath, records.replace('completed', 'cancelled')
        + jsonl([event('progress', -700, { data: 'New bytes.' })]));
      invalidateClaudeData({ filePath: transcriptPath });
      const recovered = (await scan()).threads[0];
      assert.equal(recovered.completionAtMs, 0);
      assert.equal(recovered.state, change === 'truncation' ? 'working' : 'idle');
      assert.equal(recovered.lastOutcome, change === 'truncation' ? '' : 'stopped');
      const before = getClaudeCacheStats().jsonlSignals.bytesRead;
      await scan();
      assert.equal(getClaudeCacheStats().jsonlSignals.bytesRead, before);
    });
  }
});

test('Claude local command records after a completed turn do not start work', async (t) => {
  const ended = [
    event('user', -1000, { message: { content: 'Finish this task.' } }),
    event('assistant', -900, { message: { stop_reason: 'end_turn', content: 'Done.' } }),
  ];
  for (const content of ['<local-command-caveat>Caveat: local command.</local-command-caveat>',
    '<command-name>/status</command-name>', '<local-command-stdout>Ready.</local-command-stdout>']) {
    await t.test(content, () => {
      const records = [...ended, event('user', -800, { isMeta: false, message: { content } })];
      const signals = parseClaudeJsonlSignals(jsonl(records));
      assert.equal(signals.lifecycle.running, false, content);
      assert.equal(signals.latestUserMessageAtMs, nowMs - 1000, content);
      assert.equal(signals.lifecycle.endedAtMs, nowMs - 900, content);

      const active = parseClaudeJsonlSignals(jsonl([...records,
        event('assistant', -700, { message: { content: [{ type: 'thinking' }] } }),
      ]));
      assert.equal(active.lifecycle.running, true, content);
      assert.equal(active.lifecycle.startedAtMs, nowMs - 700, content);
    });
  }
  const prompt = parseClaudeJsonlSignals(jsonl([...ended,
    event('user', -800, { message: { content: 'Run the next task.' } }),
  ]));
  assert.equal(prompt.lifecycle.running, true);
  assert.equal(prompt.lifecycle.startedAtMs, nowMs - 800);
  for (const content of ['ok', 'okay', 'y', '1', '.', '继续']) {
    const reply = parseClaudeJsonlSignals(jsonl([...ended, event('user', -800, { message: { content } })]));
    assert.equal(reply.lifecycle.running, true, content);
    assert.equal(reply.lifecycle.startedAtMs, nowMs - 800, content);
    assert.equal(reply.latestUserMessageAtMs, nowMs - 800, content);
  }
  for (const content of ['', '  ']) {
    const empty = parseClaudeJsonlSignals(jsonl([...ended, event('user', -800, { message: { content } })]));
    assert.equal(empty.lifecycle.running, false, JSON.stringify(content));
  }
});
