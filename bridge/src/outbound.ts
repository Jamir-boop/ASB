import net from 'node:net';
import { once } from 'node:events';
import { z } from 'zod';
import { authorized, findPeer, frameSchema, peerKey, SendRefused, sendFrames, uuid, type Frame, type Peer } from './claude';
import { checkSocket, isWindows, listenPrivate, outboxPath } from './platform';

const requestSchema = z.union([z.object({ type: z.literal('refresh') }),
  z.object({ sessionId: uuid, socketPath: z.string(), procStart: z.string().nullable(), frames: z.array(frameSchema).min(1).max(200) })]);

// Each call of the returned function gives the next JSON line of the socket.
function lineReader(socket: net.Socket) {
  let buffer = '';
  let failure: Error | undefined;
  let wake = () => {};
  const fail = (error: Error) => { failure ??= error; wake(); };
  socket.setEncoding('utf8');
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Local sender disconnected; send outcome may be unknown')));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { fail(new Error('Local send request too large')); socket.destroy(); }
    wake();
  });
  return async (): Promise<unknown> => {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { return JSON.parse(line); }
        catch { throw new Error('Invalid local send request'); }
      }
      if (failure) throw failure;
      await new Promise<void>(resolve => { wake = resolve; });
    }
  };
}

// With a token (Windows), the first line must be the auth line of the receiver's key file.
export async function outboundServer(path: string, configDir: string, address: string, canWrite: (frames: Frame[]) => boolean, onRequest: () => void, token?: string) {
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
    void (async () => {
      try {
        const next = lineReader(socket);
        if (token && !authorized(await next(), token)) { socket.destroy(); return; }
        const request = requestSchema.parse(await next());
        if ('type' in request) {
          onRequest();
          socket.end(JSON.stringify({ refreshed: true }) + '\n');
          return;
        }
        if (request.frames.some(frame => frame.from !== address)) throw new Error('Wrong sending task');
        const peer = findPeer(configDir, request.sessionId);
        if (peer.messagingSocketPath !== request.socketPath || (peer.procStart ?? null) !== request.procStart) throw new Error('Target process changed');
        onRequest();
        const written = await sendFrames(configDir, peer, request.frames, { canWrite: () => canWrite(request.frames) });
        socket.end(JSON.stringify({ written }) + '\n');
      } catch (error) {
        if (!socket.destroyed) socket.end(JSON.stringify(error instanceof SendRefused
          ? { refused: error.message } : { error: 'Local send failed; inspect status before retrying' }) + '\n');
      }
    })();
  });
  await listenPrivate(server, path);
  return () => new Promise<void>((resolve, reject) => {
    for (const socket of connections) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  });
}

export async function sendViaReceiver(configDir: string, receiver: Peer, peer: Peer, frames: unknown[]) {
  const result = z.union([z.object({ written: z.boolean() }), z.object({ refused: z.string() })]).parse(
    await requestReceiver(configDir, receiver, { sessionId: peer.sessionId, socketPath: peer.messagingSocketPath, procStart: peer.procStart ?? null, frames }));
  if ('refused' in result) throw new SendRefused(result.refused);
  return result.written;
}

export async function refreshReceiver(configDir: string, receiver: Peer) {
  z.object({ refreshed: z.literal(true) }).parse(await requestReceiver(configDir, receiver, { type: 'refresh' }));
}

// The receiver of this task listens next to its inbox; on Windows its key file gives the auth line.
async function requestReceiver(configDir: string, receiver: Peer, request: unknown) {
  const path = outboxPath(receiver.messagingSocketPath);
  if (!isWindows()) checkSocket(path);
  const token = isWindows() ? peerKey(configDir, receiver) : undefined;
  const socket = net.createConnection(path);
  socket.setTimeout(15000, () => socket.destroy());
  const next = lineReader(socket);
  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(5000) });
    socket.write((token ? JSON.stringify({ type: 'auth', token }) + '\n' : '') + JSON.stringify(request) + '\n');
    return await next();
  } finally { socket.destroy(); }
}
