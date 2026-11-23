export type AgyIdentity = { agyPid: number; agyStartTicks: string };
export type AgyRecord = Partial<AgyIdentity> & {
  conversationId: string;
  workspace: string;
  state: 'idle' | 'working' | 'question' | 'done' | 'failed';
  stateAtMs: number;
  createdAtMs: number;
  event?: 'SessionStart' | 'PreInvocation' | 'PostInvocation' | 'PreToolUse' | 'PostToolUse' | 'Stop';
  background?: true;
  kittyPid?: string;
  kittyWindowId?: string;
  kittyListenOn?: string;
};
export const AGY_UUID: RegExp;
export function agyRecordsDir(env?: NodeJS.ProcessEnv, homeDir?: string): string;
export function agyProcess(pid?: number, read?: (pid: number, name: string) => Promise<string>): Promise<AgyIdentity | null>;
export function readAgyRecords(dataDir: string, homeDir?: string): Promise<AgyRecord[]>;
export function agyFocusTarget(record: AgyRecord): Promise<{ listenOn: string; windowId: string } | null>;
export function agyProcessStart(pid: number): Promise<string | null>;
