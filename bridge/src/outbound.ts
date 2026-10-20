import net from 'node:net';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { authorized, findPeer, frameSchema, peerKey, peers, SendRefused, sendFrames, uuid, type Frame, type Peer } from './claude';
import { checkSocket, isWindows, listenPrivate, outboxPath, pipeProof } from './platform';

// The live target of one exact send, from the engine route /api/agent/resolve-bound.
export const bindingSchema = z.strictObject({ registryHome: z.string().min(1), runtimeSessionId: uuid, pid: z.number().int().positive(),
  procStart: z.string().min(1), messagingSocketPath: z.string().min(1), msgId: uuid, expiresAtMs: z.number().int().nonnegative() });
export type Binding = z.infer<typeof bindingSchema>;
const frames = z.array(frameSchema).min(1).max(200);
// The receipt of an exact member send, from the local ASB engine (src/machine-relay.mjs). It names this receiver process.
export const exactReceiptSchema = z.strictObject({ runtimeSessionId: uuid, pid: z.number().int().positive(), procStart: z.string().min(1),
  reference: z.string().max(384).regex(/^asb:[\x21-\x7e]+$/), msgIds: z.array(uuid).min(1).max(257),
  status: z.enum(['held', 'denied', 'expired', 'delivered', 'refused', 'dropped']), status_detail: z.string().max(64).optional(),
  reason: z.string().max(1000).optional(), drop_reason: z.string().max(64).optional() });
export type ExactReceipt = z.infer<typeof exactReceiptSchema>;
const requestSchema = z.union([z.object({ type: z.literal('refresh') }),
  z.object({ sessionId: uuid, socketPath: z.string(), procStart: z.string().nullable(), frames }),
  z.strictObject({ binding: bindingSchema, frames }),
  z.strictObject({ exactReceipt: exactReceiptSchema })]);
const boundMessages = {
  'binding-expired': 'The time for this send ended before the write.',
  'target-changed': 'The target session changed after ASB found it.',
  'receiver-stopped': 'The receiver of this task stopped before the write.',
};
type BoundCode = keyof typeof boundMessages;
export const refuse = (code: BoundCode) => Object.assign(new SendRefused(`${boundMessages[code]} Nothing sent (${code}).`), { code });

// The first frame carries the msgId of the binding, and each frame for a session names the bound one.
function boundFrames(binding: Binding, list: unknown[]) {
  const parsed = list.map(frame => frameSchema.safeParse(frame).data);
  const first = parsed[0];
  return first !== undefined && 'msg_id' in first && first.msg_id === binding.msgId && parsed.every(frame => frame !== undefined
    && (frame.type === 'user' ? frame.session_id === binding.runtimeSessionId : frame.session_id === undefined || frame.session_id === binding.runtimeSessionId));
}

// The one registry record that still has every bound field; else undefined.
export function boundPeer(configDir: string, binding: Binding): Peer | undefined {
  try { if (realpathSync(join(configDir, 'sessions')) !== binding.registryHome) return undefined; } catch { return undefined; }
  const matches = peers(configDir).filter(peer => peer.entrypoint !== 'asb-relay' && peer.sessionId === binding.runtimeSessionId);
  const peer = matches.length === 1 ? matches[0] : undefined;
  return peer && peer.pid === binding.pid && peer.procStart === binding.procStart && peer.messagingSocketPath === binding.messagingSocketPath
    ? peer : undefined;
}

// Each failure before the handoff is a proved not-sent; after the handoff the caller reports unknown.
export async function sendBound(configDir: string, binding: Binding, list: unknown[], canWrite: () => boolean) {
  if (Date.now() >= binding.expiresAtMs) throw refuse('binding-expired');
  const peer = boundFrames(binding, list) ? boundPeer(configDir, binding) : undefined;
  if (!peer) throw refuse('target-changed');
  let code: BoundCode = 'target-changed';
  let handoff = false;
  try {
    // sendFrames calls canWrite after connect and before the first byte.
    const written = await sendFrames(configDir, peer, list, { prove: true, canWrite: () => {
      if (Date.now() >= binding.expiresAtMs) code = 'binding-expired';
      else if (!boundPeer(configDir, binding)) code = 'target-changed';
      else if (!canWrite()) code = 'receiver-stopped';
      else handoff = true;
      return handoff;
    } });
    if (written) return true;
  } catch (error) {
    if (handoff || error instanceof SendRefused) throw error;
  }
  throw refuse(code);
}

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
export async function outboundServer(path: string, configDir: string, address: string, canWrite: (frames: Frame[]) => boolean, onRequest: () => void, token?: string,
  onReceipt: (receipt: ExactReceipt) => number = () => 0) {
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
        if ('exactReceipt' in request) {
          socket.end(JSON.stringify({ applied: onReceipt(request.exactReceipt) }) + '\n');
          return;
        }
        if (request.frames.some(frame => frame.from !== address)) throw new Error('Wrong sending task');
        if ('binding' in request) {
          onRequest();
          const written = await sendBound(configDir, request.binding, request.frames, () => canWrite(request.frames));
          socket.end(JSON.stringify({ written }) + '\n');
          return;
        }
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

// The bound request has no sessionId key, so the receiver checks it only with boundPeer.
export async function sendBoundViaReceiver(configDir: string, receiver: Peer, binding: Binding, list: unknown[]) {
  const result = z.union([z.object({ written: z.boolean() }), z.object({ refused: z.string() })]).parse(
    await requestReceiver(configDir, receiver, { binding, frames: list }, () => refuse('receiver-stopped'), true));
  if ('refused' in result) throw new SendRefused(result.refused);
  return result.written;
}

export async function refreshReceiver(configDir: string, receiver: Peer) {
  z.object({ refreshed: z.literal(true) }).parse(await requestReceiver(configDir, receiver, { type: 'refresh' }));
}

// The receiver of this task listens next to its inbox; on Windows its key file gives the auth line.
// With unsent, a failure before the request goes out throws its error: nothing went out.
// With prove on Windows, the request and the reply go only through a handle whose server is the receiver process.
async function requestReceiver(configDir: string, receiver: Peer, request: unknown, unsent?: () => Error, prove = false) {
  let path: string;
  let token: string | undefined;
  try {
    path = outboxPath(receiver.messagingSocketPath);
    if (!isWindows()) checkSocket(path);
    token = isWindows() ? peerKey(configDir, receiver) : undefined;
  } catch (error) { throw unsent?.() ?? error; }
  const text = (token ? JSON.stringify({ type: 'auth', token }) + '\n' : '') + JSON.stringify(request) + '\n';
  if (prove && isWindows()) {
    let pipe;
    try { pipe = pipeProof(path, receiver.pid, receiver.procStart ?? ''); } catch (error) { throw unsent?.() ?? error; }
    try {
      const signal = AbortSignal.timeout(15000);
      await pipe.write(Buffer.from(text), signal);
      return JSON.parse(await pipe.readLine(64 * 1024, signal));
    } finally { pipe.close(); }
  }
  const socket = net.createConnection(path);
  socket.setTimeout(15000, () => socket.destroy());
  const next = lineReader(socket);
  try {
    try { await once(socket, 'connect', { signal: AbortSignal.timeout(5000) }); } catch (error) { throw unsent?.() ?? error; }
    socket.write(text);
    return await next();
  } finally { socket.destroy(); }
}
