import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENGINE_TOKEN = 'e'.repeat(64);
export type EngineCall = { method: string; route: string; headers: Record<string, string>; body: unknown };

// A fake ASB engine: an HTTP server and its service.json in <runtimeDir>/asb.
export function fakeEngine(runtimeDir: string, handler: (route: string, body: unknown) => unknown | Promise<unknown>) {
  const calls: EngineCall[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const route = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.json() : undefined;
    calls.push({ method: request.method, route, headers: Object.fromEntries(request.headers), body });
    const value = await handler(route, body);
    return value instanceof Response ? value : Response.json(value);
  } });
  const folder = join(runtimeDir, 'asb');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, 'service.json'), JSON.stringify({ pid: process.pid, port: server.port, schema: 1, sourceToken: ENGINE_TOKEN }), { mode: 0o600 });
  return { calls, server, close() { server.stop(true); rmSync(folder, { recursive: true, force: true }); } };
}
