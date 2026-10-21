export class DeliveryRefused extends Error {}

// The one line before a peer message body. The name comes from the peer's registry row, so only a plain one goes in.
export function peerHeader(sessionId: string, name?: string, inputId?: string) {
  const from = name && /^[A-Za-z0-9._-]{1,64}$/.test(name) ? `${name}, sessionId ${sessionId}` : `sessionId ${sessionId}`;
  return `[ASB Bridge peer message${inputId ? ` ${inputId}` : ''} from ${from}. Reply with send_message.]`;
}

// Only the start of the output counts, so a body can never name another input.
export const headerInputId = (output: string) => /^\[ASB Bridge peer message (\S+) from /.exec(output)?.[1];
