// Real OpenCode check. Skipped without OPENCODE_BRIDGE_TEST_BINARY.
// Windows (PowerShell): $env:OPENCODE_BRIDGE_TEST_BINARY="C:\path\opencode.exe"; bun test ./test/native-opencode.ts
// Temporary HOME/XDG_*/TMPDIR, mock provider only, never the live service.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { test } from 'bun:test';
import { inbox, peers, peerAddress, peerKey, processStart, socketPath, uuid, writePeerKey } from '../src/claude';
import { assertWindowsRow, liveServiceCommand, liveServiceLines, nativeEnv, nativePeerToken, peerInboxPath } from './native-env';
// @ts-ignore -- plain JS installer, no declaration file
import { install, uninstall } from '../../scripts/asb-bridge.mjs';

const binary = process.env.OPENCODE_BRIDGE_TEST_BINARY;
const windows = process.platform === 'win32';

const liveService = () => {
  const out = Bun.spawnSync(liveServiceCommand(), { stdout: 'pipe', stderr: 'ignore' });
  return liveServiceLines(out.stdout.toString());
};

test('native OpenCode bridge', async () => {
  const before = liveService();
  const root = mkdtempSync(join(tmpdir(), 'opencode-native-'));
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  const opencodeConfig = join(configHome, 'opencode');
  const data = join(root, 'data');
  const cache = join(root, 'cache');
  const state = join(root, 'state');
  const run = join(root, 'run');
  const tmp = join(root, 'tmp');
  const claudeHome = join(root, 'claude');
  const work = join(root, 'work');
  for (const dir of [home, opencodeConfig, data, cache, state, run, tmp, join(claudeHome, 'sessions'), work]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const env = nativeEnv(root);

  // Mock OpenAI-compatible provider. CALL_CODE:<js> emits an execute tool_call. SLOW delays 5 s.
  const mockRequests: any[] = [];
  let mockCounter = 0;
  const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] });
    if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    const body: any = await request.json();
    const messages: any[] = body.messages ?? [];
    const text = (content: unknown) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? '').join('') : '';
    const last = messages.at(-1);
    const tools: string[] = (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);
    mockRequests.push({ model: body.model, stream: !!body.stream, tools, messages: messages.map(m => ({ role: m.role, content: text(m.content).slice(0, 500), toolCalls: m.tool_calls?.length ?? 0 })) });
    const lastUser = [...messages].reverse().find(m => m.role === 'user' && !text(m.content).startsWith('<system-update>'));
    if (text(lastUser?.content).includes('SLOW')) await Bun.sleep(5000);
    const execute = tools.find(name => name === 'execute' || name.endsWith('.execute'));
    const marker = /CALL_CODE:([\s\S]*)$/.exec(text(last?.content))?.[1]?.trim();
    const id = `chatcmpl-mock-${++mockCounter}`;
    let message: any;
    if (last?.role === 'user' && marker && execute) {
      message = { role: 'assistant', content: null, tool_calls: [{ id: `call_${mockCounter}`, type: 'function', function: { name: execute, arguments: JSON.stringify({ code: marker }) } }] };
    } else if (last?.role === 'tool') {
      message = { role: 'assistant', content: `mock: saw tool result: ${text(last.content).slice(0, 200)}` };
    } else {
      message = { role: 'assistant', content: `mock reply to: ${text(last?.content).slice(0, 120)}` };
    }
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!body.stream) return Response.json({ id, object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage });
    const chunk = (delta: any, reason: string | null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const parts = [chunk({ role: 'assistant', content: message.content ?? '' }, null)];
    if (message.tool_calls) parts.push(chunk({ tool_calls: message.tool_calls.map((call: any, index: number) => ({ index, ...call })) }, null));
    parts.push(chunk({}, finish), `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage })}\n\n`, 'data: [DONE]\n\n');
    return new Response(parts.join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });

  writeFileSync(join(opencodeConfig, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock-1',
    providers: {
      mock: {
        name: 'Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'mock-key-not-real' },
        models: { 'mock-1': { name: 'Mock 1', limit: { context: 32000, output: 4000 } } },
      },
    },
  }, null, 2), { mode: 0o600 });

  const installed = await install({
    opencode: true,
    opencodeConfig,
    claudeHome,
    sourceRoot: join(import.meta.dir, '../..'),
    env: { ...env },
  });
  assert(installed.opencode?.installed, 'install must report the OpenCode plugin');

  const portFile = join(run, 'oc.port');
  const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = free.port;
  free.stop(true);
  writeFileSync(portFile, String(port));

  let server: Bun.Subprocess | undefined;
  let serverLog = '';
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        serverLog += decoder.decode(value, { stream: true });
      }
    } catch { /* Closed. */ }
  };
  const startServer = async () => {
    serverLog = '';
    server = Bun.spawn([binary!, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: work, env: { ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    void pump(server.stdout as ReadableStream<Uint8Array>);
    void pump(server.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await Bun.sleep(50);
      const match = /server password (\S+)/.exec(serverLog);
      if (match) return match[1]!;
      if (server.exitCode !== null) throw new Error(`OpenCode serve exited ${server.exitCode}: ${serverLog.slice(-800)}`);
    }
    throw new Error(`OpenCode serve did not print a password: ${serverLog.slice(-800)}`);
  };

  const api = async (password: string, method: string, path: string, body?: unknown) => {
    const auth = Buffer.from(`opencode:${password}`).toString('base64');
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: () => { try { return JSON.parse(text); } catch { return text; } } };
  };

  const until = async (predicate: () => boolean | Promise<boolean>, label: string, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await Bun.sleep(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  };

  const openCodeRow = () => peers(claudeHome).find(row => row.entrypoint === 'opencode-asb-bridge');
  // The registry folder order differs by platform (tmpfs lists the newest first), so a check that needs one session asks for it.
  const rowOf = (openCodeSessionId: string) => peers(claudeHome).find(row => row.entrypoint === 'opencode-asb-bridge' && row.opencodeSessionId === openCodeSessionId);
  const rowsOf = () => peers(claudeHome).filter(row => row.entrypoint === 'opencode-asb-bridge');

  // Fake Claude peer: use the same inbox, key, and sender helpers as Claude.
  const peerId = uuid.parse(crypto.randomUUID());
  const peerToken = nativePeerToken();
  const receipts: any[] = [];
  const peerFrames: any[] = [];
  const peerServer = await inbox(work, frame => {
    if (frame.type === 'control' && frame.action === 'peer_message_status') receipts.push(frame);
    else peerFrames.push(frame);
  }, undefined, { token: peerToken });
  const peerPath = socketPath(peerServer.address);
  if (!windows) assert.equal(peerPath, peerInboxPath(work));
  const peerStart = await processStart(process.pid);
  if (peerToken) writePeerKey(join(claudeHome, 'sessions'), process.pid, peerPath, peerToken, peerStart);
  writeFileSync(join(claudeHome, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, procStart: peerStart, sessionId: peerId, messagingSocketPath: peerPath, cwd: work,
    peerProtocol: 1, peerFeatures: ['notify_idle'], entrypoint: 'cli', name: 'native-peer',
  }), { mode: 0o600 });

  const sendToOpenCode = async (text: string, openCodeSessionId: string) => {
    const row = rowOf(openCodeSessionId);
    assert(row, 'OpenCode session must be registered before send');
    const id = crypto.randomUUID();
    const token = peerKey(claudeHome, row);
    // Keep the original close timing: sendFrames' drain delay can miss the unread slot in (c).
    const connection = net.createConnection(row.messagingSocketPath);
    await once(connection, 'connect');
    if (token) connection.write(JSON.stringify({ type: 'auth', token }) + '\n');
    connection.end(JSON.stringify({
      msgV: 1, msg_id: id, type: 'user', priority: 'next', from: peerAddress(peerPath),
      session_id: row.sessionId,
      message: { role: 'user', content: text },
    }) + '\n');
    await once(connection, 'close');
    return id;
  };

  let password: string | undefined;
  try {
    password = await startServer();

    const listed = await api(password, 'GET', '/api/session');
    assert.equal(listed.status, 200);

    const createdA = await api(password, 'POST', '/api/session', { title: 'Alpha Native', directory: work });
    assert.equal(createdA.status, 200);
    const bodyA = createdA.json();
    const sessionA = (bodyA.id ?? bodyA.data?.id) as string;
    assert(sessionA?.startsWith('ses_'), `session A id: ${JSON.stringify(bodyA).slice(0, 200)}`);

    const createdB = await api(password, 'POST', '/api/session', { title: 'Beta Native', directory: work });
    assert.equal(createdB.status, 200);
    const bodyB = createdB.json();
    const sessionB = (bodyB.id ?? bodyB.data?.id) as string;
    assert(sessionB?.startsWith('ses_'), `session B id: ${JSON.stringify(bodyB).slice(0, 200)}`);

    // R5: mock-only guard before the first prompt. Abort on any real-provider sign.
    try {
      const guardConfig = await api(password, 'GET', '/api/config');
      assert.equal(guardConfig.status, 200);
      const configRaw = guardConfig.json() as any;
      const configDocs = Array.isArray(configRaw) ? configRaw : (configRaw?.data ?? []);
      const configPaths = configDocs.map((d: any) => String(d.path ?? d.info?.path ?? ''));
      const configModels = configDocs.map((d: any) => d.info?.model).filter(Boolean);
      const configProviderKeys = configDocs.flatMap((d: any) => Object.keys(d.info?.providers ?? {}));
      console.log('R5-GUARD', JSON.stringify({ configPaths, configModels, configProviderKeys }));
      // An empty answer proves nothing. Windows can report the long form of a short TEMP path, in another case.
      assert(configPaths.length > 0 && configModels.length > 0, 'the config answer has no paths or no default model');
      const roots = [root, realpathSync.native(root)].map(r => windows ? r.toLowerCase() : r);
      for (const p of configPaths) assert(roots.some(r => (windows ? p.toLowerCase() : p).startsWith(r)), `config folder outside temp: ${p}`);
      for (const m of configModels) assert.equal(`${m.providerID}/${m.model}`, 'mock/mock-1', `default model: ${JSON.stringify(m)}`);
      assert(configProviderKeys.every((k: string) => k === 'mock'), `providers: ${configProviderKeys.join(',')}`);
      const guardProvider = await api(password, 'GET', '/api/provider');
      console.log('R5-PROVIDER', String(JSON.stringify(guardProvider.json())).slice(0, 400));
    } catch (error) {
      try { server?.kill('SIGTERM'); } catch { /* Gone. */ }
      throw error;
    }

    // A non-mock provider fails at once. The message list can lag a turn (seen on Windows), so wait up to 5 s for one assistant message.
    const assertMockOnly = async (sessionId: string) => {
      let assistant = 0;
      let status = 0;
      const deadline = Date.now() + 5000;
      do {
        const msgRes = await api(password!, 'GET', `/api/session/${sessionId}/message`);
        status = msgRes.status;
        const msgRaw = msgRes.json() as any;
        const messages = Array.isArray(msgRaw) ? msgRaw : (msgRaw?.data ?? []);
        assistant = 0;
        for (const m of messages) {
          if (m?.type !== 'assistant') continue;
          assistant++;
          const pid = m.model?.providerID ?? m.data?.model?.providerID;
          if (pid !== 'mock') assert.fail(`non-mock providerID: ${pid ?? '(missing)'} in ${sessionId}`);
        }
        if (assistant) break;
        await Bun.sleep(100);
      } while (Date.now() < deadline);
      if (!assistant) assert.fail(`no assistant message in ${sessionId} after a turn (last status ${status})`);
      console.log(`R5-MESSAGES ${sessionId} assistant=${assistant} provider=mock`);
    };

    const unreadCount = (bridgeId: string) => {
      const db = new Database(join(state, 'opencode', 'plugin-state', 'asb-bridge', `${bridgeId}.sqlite`), { readonly: true });
      try {
        return db.query<{ total: number }, []>("SELECT count(*) AS total FROM messages WHERE direction='in' AND kind='message' AND awaiting_input=1").get()?.total ?? 0;
      } finally { db.close(); }
    };

    // First prompt triggers plugin setup and registers the session.
    const first = await api(password, 'POST', `/api/session/${sessionA}/prompt`, { text: 'NATIVE_BOOT alpha' });
    assert.equal(first.status, 200);
    await until(() => !!rowOf(sessionA), 'OpenCode registry row');
    const row = rowOf(sessionA)!;
    assert.equal(row.entrypoint, 'opencode-asb-bridge');
    assert(row.name.startsWith('opencode-'), `name rule: ${row.name}`);
    assert((row as any).opencodeSessionId === sessionA, 'row must carry the OpenCode session id');
    await until(() => rowsOf().some(r => (r as any).opencodeSessionId === sessionB), 'second session also registers');
    await until(() => mockRequests.length >= 1, 'mock request for the boot turn');
    assert(mockRequests[0].messages.some((m: any) => String(m.content).includes('NATIVE_BOOT')), 'mock must see the boot prompt');
    await assertMockOnly(sessionA);

    const messageStatus = (bridgeId: string, id: string) => {
      const db = new Database(join(state, 'opencode', 'plugin-state', 'asb-bridge', `${bridgeId}.sqlite`), { readonly: true });
      try {
        return db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(id)?.status;
      } finally { db.close(); }
    };

    // Inbound: fake peer sends to the OpenCode socket. Idle session gets status started.
    const inboundText = `NATIVE_INBOUND ${crypto.randomUUID()}`;
    const inboundId = await sendToOpenCode(`<cross-session-message from="${peerAddress(peerPath)}" from-session="${peerId}" from-name="native-peer">\n${inboundText}\n</cross-session-message>`, sessionA);
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes(inboundText))), 'mock request for inbound');
    await until(() => messageStatus(row.sessionId, inboundId) === 'started', 'idle inbound status started');
    assert(!receipts.some(r => r.orig_msg_id === inboundId && r.status === 'delivered'), 'an at-once accept must not send a delivered receipt');
    await assertMockOnly(sessionA);

    // Busy/idle: SLOW holds the turn. A second inbound while busy must steer.
    const slow = api(password, 'POST', `/api/session/${sessionA}/prompt`, { text: 'SLOW NATIVE_BUSY' });
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes('NATIVE_BUSY'))), 'slow turn started');
    const busyText = `NATIVE_BUSY_IN ${crypto.randomUUID()}`;
    const busyId = await sendToOpenCode(`<cross-session-message from="${peerAddress(peerPath)}" from-session="${peerId}" from-name="native-peer">\n${busyText}\n</cross-session-message>`, sessionA);
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes(busyText))), 'busy inbound reaches the model');
    await until(() => messageStatus(row.sessionId, busyId) === 'steered', 'busy inbound status steered');
    await slow;
    await assertMockOnly(sessionA);

    // Outbound: mock model calls tools.asb_bridge.send_message. Fake peer receives a frame with from-name.
    const outText = `NATIVE_OUTBOUND ${crypto.randomUUID()}`;
    const outPrompt = await api(password, 'POST', `/api/session/${sessionA}/prompt`, {
      text: `CALL_CODE: return await tools.asb_bridge.send_message({ sessionId: "${peerId}", text: ${JSON.stringify(outText)} })`,
    });
    assert.equal(outPrompt.status, 200);
    await until(() => peerFrames.some(frame => String(frame.message?.content ?? '').includes(outText)), 'outbound frame to the fake peer');
    const outFrame = peerFrames.find(frame => String(frame.message?.content ?? '').includes(outText));
    const envelope = /^<cross-session-message\s[^>]*>/.exec(String(outFrame.message?.content ?? ''))?.[0] ?? '';
    assert(envelope.includes(`from-name="${row.name}"`) || envelope.includes('from-name="opencode-'), `from-name in envelope: ${envelope}`);
    assert(envelope.includes(`from-session="${row.sessionId}"`), `from-session in envelope: ${envelope}`);
    await assertMockOnly(sessionA);

    // list_sessions shows the fake peer as claude and this session as opencode.
    const listPrompt = await api(password, 'POST', `/api/session/${sessionA}/prompt`, {
      text: 'CALL_CODE: return await tools.asb_bridge.list_sessions({})',
    });
    assert.equal(listPrompt.status, 200);
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes('native-peer') || String(m.content).includes('opencode-'))), 'list_sessions result');
    await assertMockOnly(sessionA);

    // R4(a): a session created AFTER the plugin starts, turn via the HTTP API, registers on session.execution.started.
    const createdC = await api(password, 'POST', '/api/session', { title: 'Late Native', directory: work });
    assert.equal(createdC.status, 200);
    const bodyC = createdC.json();
    const sessionC = (bodyC.id ?? bodyC.data?.id) as string;
    assert(sessionC?.startsWith('ses_'), `late session id: ${JSON.stringify(bodyC).slice(0, 200)}`);
    const latePrompt = await api(password, 'POST', `/api/session/${sessionC}/prompt`, { text: 'NATIVE_LATE gamma' });
    assert.equal(latePrompt.status, 200);
    await until(() => rowsOf().some(r => (r as any).opencodeSessionId === sessionC), 'late session registers on session.execution.started');
    console.log('PASS (a) late session registers on session.execution.started');
    const lateRow = rowsOf().find(r => r.opencodeSessionId === sessionC)!;
    for (const line of assertWindowsRow(lateRow, claudeHome)) console.log(line);
    await assertMockOnly(sessionC);

    // R4(b): a rename through the API changes the row name (session.update -> PATCH).
    const renameRes = await api(password, 'PATCH', `/api/session/${sessionC}`, { title: 'Renamed Native' });
    assert(renameRes.status >= 200 && renameRes.status < 300, `rename: ${renameRes.status} ${JSON.stringify(renameRes.json()).slice(0, 200)}`);
    await until(() => rowsOf().some(r => (r as any).opencodeSessionId === sessionC && /renamed-native/.test(r.name)), 'rename changes row name');
    console.log('PASS (b) rename changes row name');

    // R4(c): after an inbound bridge message, session.inbox.delivered frees the unread slot.
    const hopA = 'a1b2c3d4e5f60718293a4b5c';
    const hopB = 'b2c3d4e5f60718293a4b5c6d';
    const cInbound = `NATIVE_C_IN ${crypto.randomUUID()}`;
    const rowC = rowsOf().find(r => (r as any).opencodeSessionId === sessionC)!;
    // Watch from before the send: on a fast system the slot is set and freed before the model sees the message.
    let unreadBefore = 0;
    const watch = setInterval(() => { try { unreadBefore = Math.max(unreadBefore, unreadCount(rowC.sessionId)); } catch { /* Not written yet. */ } }, 5);
    try {
      await sendToOpenCode(`<cross-session-message from="${peerAddress(peerPath)}" from-session="${peerId}" hop-chain="${hopA},${hopB}" from-name="native-peer">\n${cInbound}\n</cross-session-message>`, sessionC);
      await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes(cInbound))), 'inbound for inbox.delivered');
      await until(() => unreadBefore >= 1, 'unread slot is set after inbound');
      await until(() => unreadCount(rowC.sessionId) === 0, 'inbox.delivered frees the unread slot');
    } finally { clearInterval(watch); }
    const unreadAfter = unreadCount(rowC.sessionId);
    console.log(`PASS (c) inbox.delivered frees the unread slot (unread before=${unreadBefore}, after=${unreadAfter})`);
    await assertMockOnly(sessionC);

    const envelopeOf = (needle: string) => {
      const frame = peerFrames.find(f => String(f.message?.content ?? '').includes(needle));
      return /^<cross-session-message\s[^>]*>/.exec(String(frame?.message?.content ?? ''))?.[0] ?? '';
    };

    // R4(d): a human prompt through the API after a bridge message resets the hop chain.
    // d1 must run in the inbound turn itself: a CALL_CODE prompt is a user item and would reset the origin first.
    const d1 = `NATIVE_D1 ${crypto.randomUUID()}`;
    const dInbound = `NATIVE_D_IN ${crypto.randomUUID()}\nCALL_CODE: return await tools.asb_bridge.send_message({ sessionId: "${peerId}", text: ${JSON.stringify(d1)} })`;
    await sendToOpenCode(`<cross-session-message from="${peerAddress(peerPath)}" from-session="${peerId}" hop-chain="${hopA},${hopB}" from-name="native-peer">\n${dInbound}\n</cross-session-message>`, sessionC);
    await until(() => peerFrames.some(frame => String(frame.message?.content ?? '').includes(d1)), 'outbound with inbound hop chain');
    const d1Env = envelopeOf(d1);
    assert(d1Env.includes(hopA) || d1Env.includes(hopB), `hop chain should carry inbound hops: ${d1Env}`);
    await assertMockOnly(sessionC);

    const humanPrompt = await api(password, 'POST', `/api/session/${sessionC}/prompt`, { text: 'NATIVE_HUMAN delta' });
    assert.equal(humanPrompt.status, 200);
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes('NATIVE_HUMAN'))), 'human prompt reaches the model');
    await assertMockOnly(sessionC);

    const d2 = `NATIVE_D2 ${crypto.randomUUID()}`;
    await api(password, 'POST', `/api/session/${sessionC}/prompt`, {
      text: `CALL_CODE: return await tools.asb_bridge.send_message({ sessionId: "${peerId}", text: ${JSON.stringify(d2)} })`,
    });
    await until(() => peerFrames.some(frame => String(frame.message?.content ?? '').includes(d2)), 'outbound after human prompt');
    const d2Env = envelopeOf(d2);
    assert(!d2Env.includes(hopA) && !d2Env.includes(hopB), `hop chain must reset after a human prompt: ${d2Env}`);
    console.log('PASS (d) human prompt resets the hop chain');
    await assertMockOnly(sessionC);

    // R4(e): Archive removes the row, and the placeholder PID is gone.
    const cRow = rowsOf().find(r => (r as any).opencodeSessionId === sessionC)!;
    const cPlaceholderPid = cRow.pid;
    const archiveRes = await api(password, 'PATCH', `/api/session/${sessionC}`, { archived: true });
    assert(archiveRes.status >= 200 && archiveRes.status < 300, `archive: ${archiveRes.status} ${JSON.stringify(archiveRes.json()).slice(0, 200)}`);
    await until(() => !rowsOf().some(r => (r as any).opencodeSessionId === sessionC), 'archive removes the row');
    await until(() => { try { process.kill(cPlaceholderPid, 0); return false; } catch { return true; } }, 'placeholder PID is gone after archive', 15000);
    console.log('PASS (e) archive removes the row and the placeholder PID');

    // R4(f): Delete removes the state file (session.remove -> DELETE).
    const stateFileC = join(state, 'opencode', 'plugin-state', 'asb-bridge', `${rowC.sessionId}.sqlite`);
    const deleteRes = await api(password, 'DELETE', `/api/session/${sessionC}`);
    assert(deleteRes.status >= 200 && deleteRes.status < 300, `delete: ${deleteRes.status} ${JSON.stringify(deleteRes.json()).slice(0, 200)}`);
    await until(() => !existsSync(stateFileC), 'delete removes the state file');
    console.log('PASS (f) delete removes the state file');
    // SIGTERM: cleanup removes registry rows.
    server!.kill('SIGTERM');
    await server!.exited;
    await until(() => rowsOf().length === 0, 'SIGTERM removes OpenCode registry rows', 15000);

    // SIGKILL: placeholder dies on stdin EOF; next start sweeps stale files.
    password = await startServer();
    const again = await api(password, 'POST', `/api/session/${sessionA}/prompt`, { text: 'NATIVE_RESTART' });
    assert.equal(again.status, 200);
    await until(() => !!openCodeRow(), 'row after restart');
    const beforeKill = openCodeRow()!;
    const placeholderPid = beforeKill.pid;
    server!.kill('SIGKILL');
    await server!.exited;
    await until(() => { try { process.kill(placeholderPid, 0); return false; } catch { return true; } }, 'placeholder exits on SIGKILL', 15000);

    password = await startServer();
    const swept = await api(password, 'POST', `/api/session/${sessionA}/prompt`, { text: 'NATIVE_SWEEP' });
    assert.equal(swept.status, 200);
    await until(() => !!openCodeRow(), 'row after sweep start');

    // Location reload must run cleanup before the session can register and receive again.
    const reloadPid = rowOf(sessionA)!.pid;
    const reload = await api(password, 'POST', '/api/location/reload');
    assert.equal(reload.status, 204, `location reload: ${reload.status} ${JSON.stringify(reload.json())}`);
    await until(() => { try { process.kill(reloadPid, 0); return false; } catch { return true; } }, 'location reload stops the old placeholder', 15000);
    const resumed = await api(password, 'POST', `/api/session/${sessionA}/prompt`, { text: 'NATIVE_LOCATION_RELOAD' });
    assert.equal(resumed.status, 200);
    await until(() => !!rowOf(sessionA) && rowOf(sessionA)!.pid !== reloadPid, 'location reload registers a new placeholder');
    const reloadText = `NATIVE_RELOAD_DELIVERY ${crypto.randomUUID()}`;
    await sendToOpenCode(reloadText, sessionA);
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes(reloadText))), 'delivery after location reload reaches the mock');
    await assertMockOnly(sessionA);
    console.log('PASS location reload: cleanup ran, re-registered, delivery works');

    // Second folder: a session there registers with its own folder and receives.
    const work2 = join(root, 'work2');
    mkdirSync(work2, { recursive: true, mode: 0o700 });
    const createdD = await api(password, 'POST', '/api/session', { title: 'Second Folder', location: { directory: work2 } });
    assert.equal(createdD.status, 200);
    const bodyD = createdD.json();
    const sessionD = (bodyD.id ?? bodyD.data?.id) as string;
    assert(sessionD?.startsWith('ses_'), `second folder session id: ${JSON.stringify(bodyD).slice(0, 200)}`);
    const secondPrompt = await api(password, 'POST', `/api/session/${sessionD}/prompt`, { text: 'NATIVE_SECOND_FOLDER' });
    assert.equal(secondPrompt.status, 200);
    await until(() => rowsOf().some(r => (r as any).opencodeSessionId === sessionD), 'second folder session registers');
    const rowD = rowsOf().find(r => (r as any).opencodeSessionId === sessionD)!;
    const normCwd = (value: string) => {
      let path = value;
      try { path = realpathSync.native(value); } catch { /* Keep the given form. */ }
      return windows ? path.toLowerCase() : path;
    };
    assert.equal(normCwd(String(rowD.cwd)), normCwd(work2), `row cwd must be the second folder: ${rowD.cwd} vs ${work2}`);
    let secondPlaceholderAlive = true;
    try { process.kill(rowD.pid, 0); } catch { secondPlaceholderAlive = false; }
    assert(secondPlaceholderAlive, `placeholder PID ${rowD.pid} must be alive for the second folder`);
    const secondText = `NATIVE_SECOND_IN ${crypto.randomUUID()}`;
    await sendToOpenCode(secondText, sessionD);
    await until(() => mockRequests.some(r => r.messages.some((m: any) => String(m.content).includes(secondText))), 'second folder receives');
    await assertMockOnly(sessionD);
    console.log('PASS second folder registers with its own folder and receives');

    // Uninstall: rows go away live and the plugin folder is gone.
    await uninstall({ opencode: true, opencodeConfig, claudeHome, sourceRoot: join(import.meta.dir, '../..'), env: { ...env } });
    assert(!existsSync(join(opencodeConfig, 'plugins', 'asb-bridge')), 'plugin folder removed');
    await until(() => rowsOf().length === 0, 'uninstall removes live rows', 15000);

    // The Windows filter matches any `serve`, so leave out the server of this test.
    const after = liveService().filter(line => !server?.pid || !line.startsWith(`${server.pid} `));
    assert.deepEqual(after, before, `live OpenCode service must not change\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
    console.log(`Native OpenCode passed with ${binary}: register, inbound started, busy steer, outbound from-name, R4 a-f, SIGTERM, SIGKILL, location reload, uninstall. Live service unchanged (${before.join(' | ') || 'none'}).`);
  } finally {
    try { server?.kill('SIGTERM'); } catch { /* Already gone. */ }
    try { await server?.exited; } catch { /* Already gone. */ }
    mock.stop(true);
    await peerServer.close();
    rmSync(root, { recursive: true, force: true });
    const after = liveService();
    if (after.join() !== before.join()) console.error(`WARNING: live service changed\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
  }
}, 180000);

if (!binary) {
  test.skip('native OpenCode bridge (set OPENCODE_BRIDGE_TEST_BINARY)', () => {});
}
