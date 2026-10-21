import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inbox, socketPath, writePeerKey } from '../src/claude';

// The row and key file of a receiver that died. A live placeholder process stands for the unrelated process that has the PID now.
export async function staleReceiver(configDir: string, folder: string, threadId: string, procStart?: string) {
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(folder, { mode: 0o700 });
  // macOS has cat only in /bin, so the placeholder comes from PATH.
  const placeholder = Bun.spawn(['cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  // A real private socket, so that peers() keeps the row.
  const box = await inbox(folder, () => {}, `${placeholder.pid}.sock`);
  const path = socketPath(box.address);
  const row = join(configDir, 'sessions', `${placeholder.pid}.json`);
  writeFileSync(row, JSON.stringify({ pid: placeholder.pid, sessionId: threadId, messagingSocketPath: path, cwd: '/tmp', name: 'old-receiver',
    peerProtocol: 1, entrypoint: 'codex-asb-bridge', ...(procStart ? { procStart } : {}) }), { mode: 0o600 });
  const key = writePeerKey(join(configDir, 'sessions'), placeholder.pid, path, 'a'.repeat(32), procStart ?? 'a previous process with this PID');
  return {
    pid: placeholder.pid, row, key, socket: path,
    alive() { try { return process.kill(placeholder.pid, 0); } catch { return false; } },
    async close() { await box.close(); placeholder.kill(); },
  };
}
