export const AGY_MAILBOX_TTL_MS: number;
export function safeAgyText(text: unknown): text is string;
export function agyMailboxDir(env?: NodeJS.ProcessEnv): string | null;
export function privateAgyMailbox(dir: string | null): Promise<boolean>;
export function readAgyMailboxFile(file: string): Promise<{ text: string; at: number } | null>;
export function takeAgyMailbox(hook: { conversationId: string; continuationActive?: boolean }, env?: NodeJS.ProcessEnv): Promise<string | null>;
