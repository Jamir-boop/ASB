import path from 'node:path';
import { permissionRequestHook, readHookTargets } from './claude-hook.mjs';

export const { status: codexHookStatus, change: changeCodexHook } = permissionRequestHook({
  fileName: 'hooks.json', matcher: '^Bash$', timeout: 45, suffix: ' agent codex-wait',
});

export const codexHookTargets = (sources) => [...new Set(sources.filter((source) => source.enabled === true && source.provider === 'codex'
  && typeof source.dataDir === 'string' && path.isAbsolute(source.dataDir)).map((source) => path.resolve(source.dataDir)))];

export const readCodexHookTargets = (env, platform) => readHookTargets(env, platform, codexHookTargets);
