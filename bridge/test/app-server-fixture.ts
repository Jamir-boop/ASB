import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

export async function appServer(root = mkdtempSync('/tmp/codex-app-'), threadId = randomUUID()) {
  const directory = join(root, 'app-server-control');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'app-server-control.sock');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const turnId = randomUUID();
  const submissions: { method: string; params: Record<string, unknown> }[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const responses: unknown[] = [];
  let state = 'idle';
  let permissions: Record<string, unknown> = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
  let items: unknown[] = [];
  let queue: unknown[] = [];
  let loaded = true;
  let loadedListError = false;
  let unloadAfterRead = false;
  let dropAcknowledgement = false;
  let refuseSubmission = false;
  let withholdAcknowledgement = false;
  const notify = (method: string, params: unknown) => {
    for (const socket of sockets.clients) socket.send(JSON.stringify({ method, params }));
  };
  sockets.on('connection', socket => {
    socket.on('error', () => {});
    socket.on('message', data => {
      const request = JSON.parse(data.toString());
      if (!request.method) { responses.push(request); return; }
      if (!request.id) return;
      requests.push(request);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
      const thread = { id: threadId, cwd: root, status: { type: loaded ? state : 'notLoaded' }, canAcceptDirectInput: true };
      if (request.method === 'initialize') reply({ userAgent: 'codex/0.159.2', codexHome: root });
      else if (request.method === 'thread/loaded/list') {
        if (loadedListError) socket.send(JSON.stringify({ id: request.id, error: { code: -32603, message: 'Loaded list unavailable' } }));
        else reply({ data: loaded ? [threadId] : [], nextCursor: null });
      }
      else if (request.method === 'thread/read') { reply({ thread }); if (unloadAfterRead) { loaded = false; unloadAfterRead = false; } }
      else if (request.method === 'thread/resume') {
        if (Object.keys(request.params).some(key => !['threadId', 'excludeTurns'].includes(key))) {
          throw new Error('The bridge must not override a live thread setting');
        }
        loaded = true;
        reply({ thread: { ...thread, status: { type: state } }, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandboxPolicy });
      } else if (request.method === 'thread/items/list') {
        const start = Number(request.params.cursor ?? 0);
        const limit = request.params.limit ?? 100;
        reply({ data: items.slice().reverse().slice(start, start + limit).map(item => ({ turnId, item })),
          nextCursor: start + limit < items.length ? String(start + limit) : null });
      } else if (request.method === 'thread/queue/list') reply({ data: queue, nextCursor: null });
      else if (request.method === 'turn/start') {
        if (!loaded) { socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Thread is not loaded' } })); return; }
        if (refuseSubmission) { socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'Peer input rejected' } })); return; }
        submissions.push(request);
        if (dropAcknowledgement) { socket.terminate(); return; }
        if (withholdAcknowledgement) return;
        reply({ turn: { id: turnId } });
      } else socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unknown method' } }));
    });
  });
  server.listen(path);
  await once(server, 'listening');
  chmodSync(path, 0o600);
  return { path, root, threadId, turnId, submissions, requests, responses,
    setState(value: 'idle' | 'active') { state = value; notify('thread/status/changed', { threadId, status: { type: state } }); },
    setPermissions(value: Record<string, unknown>) { permissions = value; notify('thread/settings/updated', { threadId, threadSettings: value }); },
    setItems(value: unknown[]) { items = value; },
    setQueue(value: unknown[]) { queue = value; notify('thread/queue/changed', { threadId }); },
    setLoaded(value: boolean) { loaded = value; },
    failLoadedList() { loadedListError = true; },
    unloadOnNextRead() { unloadAfterRead = true; },
    loseAcknowledgement() { dropAcknowledgement = true; },
    refuseSubmission() { refuseSubmission = true; },
    withholdAcknowledgement() { withholdAcknowledgement = true; },
    disconnectClients() { for (const socket of sockets.clients) socket.terminate(); },
    requestApproval() { notify('item/commandExecution/requestApproval', { threadId });
      for (const socket of sockets.clients) socket.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId } })); },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true });
    },
  };
}
