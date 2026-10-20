import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLiveClaudeRegistry } from '../src/claude-registry.mjs';

// The Windows registry rules, asked for with the windows option: synthetic records and an injected isAlive, on any OS
// (test/windows-tests.json).
const SESSION = '11111111-1111-4111-8111-111111111111';
const PIPE = `\\\\.\\pipe\\LOCAL\\cc-msg-${'ab'.repeat(16)}`;
const LIVE = new Set([101, 102, 103, 104, 105, 106, 107, 108, 109]);
const isAlive = (pid) => LIVE.has(pid);

test('the Windows rules keep a live pipe record with its recorded start and drop everything else', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asb-registry-'));
  const write = (pid, fields = {}) => writeFileSync(path.join(root, `${pid}.json`), JSON.stringify({ pid, sessionId: SESSION, name: 'synthetic',
    procStart: '133000000000000000', peerProtocol: 1, messagingSocketPath: PIPE, entrypoint: 'cli', ...fields }));
  try {
    write(101);
    write(102, { messagingSocketPath: '/synthetic/s/102.sock' });
    write(103, { messagingSocketPath: PIPE, peerProtocol: 2 });
    write(200);
    write(104, { procStart: 133000000000000000 });
    write(105, { procStart: '13300000000000000x' });
    write(106, { procStart: '1'.repeat(21) });
    writeFileSync(path.join(root, '107.json'), JSON.stringify({ pid: 107, sessionId: SESSION, name: 'x'.repeat(256 * 1024), procStart: '1' }));
    mkdirSync(path.join(root, '108.json'));
    // A link to a valid record outside the folder. Symbolic links need extra rights on Windows.
    if (process.platform !== 'win32') {
      mkdirSync(path.join(root, 'outside'));
      writeFileSync(path.join(root, 'outside', '109.json'), JSON.stringify({ pid: 109, sessionId: SESSION, name: 'synthetic', procStart: '1' }));
      symlinkSync(path.join(root, 'outside', '109.json'), path.join(root, '109.json'));
    }
    const records = await readLiveClaudeRegistry([root], { windows: true, isAlive });
    assert.deepEqual(records.map((record) => [record.pid, record.procStart, record.messagingSocketPath]).sort(),
      [[101, '133000000000000000', PIPE], [102, '133000000000000000', undefined], [103, '133000000000000000', undefined]]);
    if (process.platform === 'win32') assert.deepEqual(await readLiveClaudeRegistry([root], { isAlive }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
