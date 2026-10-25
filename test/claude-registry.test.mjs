import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readClaudeAppApprovals, readLiveClaudeRegistry } from '../src/claude-registry.mjs';

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

const APP_SESSION = 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_APP_SESSION = 'local_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const REQUEST = '11111111-2222-4333-8444-555555555555';
const OTHER_REQUEST = '22222222-3333-4444-8555-666666666666';
const approvalTime = '2026-10-25 07:55:48';
const approvalAtMs = new Date(2026, 9, 25, 7, 55, 48).getTime();
const approvalLine = (id = REQUEST, session = APP_SESSION, tool = 'browser:left_click') =>
  `${approvalTime} [info] Emitted tool permission request ${id} for ${tool} in session ${session}\n`;
function approvalFixture(t) {
  const appDir = mkdtempSync(path.join(tmpdir(), 'asb-approvals-'));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));
  mkdirSync(path.join(appDir, 'logs'));
  return { file: path.join(appDir, 'logs', 'main.log'), read: () => readClaudeAppApprovals(appDir) };
}

test('app approvals return only the tool and local time of the newest open request per session', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, approvalLine() + approvalLine(OTHER_REQUEST, APP_SESSION, 'Read').replace('07:55:48', '07:55:49'));
  assert.deepEqual(await read(), new Map([[APP_SESSION, { tool: 'Read', atMs: approvalAtMs + 1000 }]]));
  appendFileSync(file, `${approvalTime} [info] Received permission response for ${OTHER_REQUEST}: once (tool: Read)\n`);
  const result = await read();
  assert.deepEqual(result, new Map([[APP_SESSION, { tool: 'browser:left_click', atMs: approvalAtMs }]]));
  assert.deepEqual(Object.keys(result.get(APP_SESSION)).sort(), ['atMs', 'tool']);
  result.get(APP_SESSION).tool = 'changed';
  assert.equal((await read()).get(APP_SESSION).tool, 'browser:left_click');
});

test('both app response forms close requests for known and unknown decisions', async (t) => {
  for (const decision of ['once', 'always', 'deny', 'cancelled']) {
    for (const response of [
      `Received permission response for ${REQUEST}: ${decision} (tool: browser:left_click)`,
      `LocalSessions.respondToToolPermission: requestId=${REQUEST}, decision=${decision}, hasUpdatedInput=true`,
    ]) {
      const { file, read } = approvalFixture(t);
      writeFileSync(file, approvalLine());
      assert.equal((await read()).size, 1);
      appendFileSync(file, `${approvalTime} [info] ${response}\n`);
      assert.equal((await read()).size, 0);
    }
  }
});

test('app quit closes all approvals and CRLF line ends work', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, (approvalLine() + approvalLine(OTHER_REQUEST, OTHER_APP_SESSION, 'Bash')).replaceAll('\n', '\r\n'));
  assert.equal((await read()).size, 2);
  appendFileSync(file, `${approvalTime} [info] beforeQuit: handler fired\r\n`);
  assert.equal((await read()).size, 0);
});

test('app approval lines wait for their final newline across appends', async (t) => {
  const { file, read } = approvalFixture(t);
  const line = approvalLine();
  writeFileSync(file, line.slice(0, 19));
  assert.equal((await read()).size, 0);
  appendFileSync(file, line.slice(19, -1));
  assert.equal((await read()).size, 0);
  appendFileSync(file, '\n');
  assert.equal((await read()).size, 1);
  assert.equal((await read()).size, 1);
});

test('truncation and replacement clear previous app approvals', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, approvalLine() + 'unrelated padding\n'.repeat(10));
  assert.equal((await read()).size, 1);
  writeFileSync(file, approvalLine(OTHER_REQUEST, OTHER_APP_SESSION, 'Read'));
  assert.deepEqual([...(await read()).keys()], [OTHER_APP_SESSION]);
  renameSync(file, `${file}.old`);
  writeFileSync(file, approvalLine());
  assert.deepEqual([...(await read()).keys()], [APP_SESSION]);
});

test('unrelated and malformed app log lines cannot open or close approvals', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, [
    'Starting app\n', `prefix ${approvalLine()}`, approvalLine().replace(' [info]', ' [debug]'),
    approvalLine(REQUEST, 'local_not-a-uuid'), approvalLine(REQUEST.replace('1', 'A')),
    approvalLine(REQUEST, APP_SESSION, 'x'.repeat(65)), approvalLine(REQUEST, APP_SESSION, 'browser:bad/tool'),
    `${approvalTime} [info] unrelated object { address: "https://example.invalid" }\n`,
  ].join(''));
  assert.deepEqual(await read(), new Map());
  appendFileSync(file, approvalLine());
  appendFileSync(file, `prefix ${approvalTime} [info] beforeQuit: handler fired\n`);
  assert.equal((await read()).size, 1);
});

test('missing app logs and read errors return an empty map', async (t) => {
  const { file, read } = approvalFixture(t);
  assert.deepEqual(await read(), new Map());
  mkdirSync(file);
  assert.deepEqual(await read(), new Map());
});

test('the initial app log window skips old requests and its first partial line', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, approvalLine() + 'x'.repeat(1024 * 1024) + '\n' + approvalLine(OTHER_REQUEST, OTHER_APP_SESSION, 'ExitPlanMode'));
  assert.deepEqual(await read(), new Map([[OTHER_APP_SESSION, { tool: 'ExitPlanMode', atMs: approvalAtMs }]]));
});

test('an app log jump over 4 MiB resets the read window and open approvals', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, approvalLine());
  assert.equal((await read()).size, 1);
  appendFileSync(file, 'x'.repeat(4 * 1024 * 1024) + '\n' + approvalLine(OTHER_REQUEST, OTHER_APP_SESSION));
  assert.deepEqual([...(await read()).keys()], [OTHER_APP_SESSION]);
});

test('the app log keeps at most 256 open requests and drops the oldest', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, Array.from({ length: 257 }, (_, i) => {
    const uuid = `${i.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`;
    return approvalLine(uuid, `local_${uuid}`);
  }).join(''));
  const result = await read();
  assert.equal(result.size, 256);
  assert.equal(result.has('local_00000000-2222-4333-8444-555555555555'), false);
  assert.equal(result.has('local_00000100-2222-4333-8444-555555555555'), true);
});

test('each public app line form works when its fields or CRLF are split across reads', async (t) => {
  const lines = [approvalLine(),
    `${approvalTime} [info] Received permission response for ${REQUEST}: always (tool: browser:left_click)\n`,
    `${approvalTime} [info] LocalSessions.respondToToolPermission: requestId=${REQUEST}, decision=deny, hasUpdatedInput=false\n`,
    `${approvalTime} [info] beforeQuit: handler fired\n`];
  for (const [index, line] of lines.entries()) {
    const crlf = line.replace('\n', '\r\n');
    for (const split of [7, 30, 55, crlf.length - 1].filter((at) => at < crlf.length)) {
      const { file, read } = approvalFixture(t);
      writeFileSync(file, index ? approvalLine() : '');
      await read();
      appendFileSync(file, crlf.slice(0, split));
      assert.equal((await read()).size, index ? 1 : 0);
      appendFileSync(file, crlf.slice(split));
      assert.equal((await read()).size, index ? 0 : 1, `${index}, split ${split}`);
    }
  }
});

test('an unrelated unfinished line is discarded through its newline', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, `${approvalTime} [info] unrelated object https://example.invalid/`);
  assert.equal((await read()).size, 0);
  appendFileSync(file, approvalLine());
  assert.equal((await read()).size, 0);
  appendFileSync(file, approvalLine());
  assert.equal((await read()).size, 1);
});

test('a reset window without a newline still drops its partial first line on the next read', async (t) => {
  const { file, read } = approvalFixture(t);
  writeFileSync(file, 'x'.repeat(1024 * 1024 + 20));
  assert.equal((await read()).size, 0);
  assert.equal((await read()).size, 0);
  appendFileSync(file, approvalLine());
  assert.equal((await read()).size, 0);
  appendFileSync(file, approvalLine(OTHER_REQUEST, OTHER_APP_SESSION));
  assert.deepEqual([...(await read()).keys()], [OTHER_APP_SESSION]);
});
