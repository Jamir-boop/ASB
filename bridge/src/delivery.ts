export class DeliveryRefused extends Error {}

const plainName = /^[^,\[\]\p{C}\u2028\u2029]{1,64}$/u;

// The one line before a peer message body. The name is peer data inside a line that the model trusts, so a comma, a bracket, or a line break could add a fake session ID or a second header.
// The reply hint names the tool that answers on the receiving host.
export function peerHeader(sessionId: string, name?: string, inputId?: string, replyHint = 'Reply with send_message.') {
  const from = name?.trim() && plainName.test(name) ? `${name}, sessionId ${sessionId}` : `sessionId ${sessionId}`;
  return `[ASB Bridge peer message${inputId ? ` ${inputId}` : ''} from ${from}. ${replyHint}]`;
}

// Only the start of the output counts, so a body can never name another input.
export const headerInputId = (output: string) => /^\[ASB Bridge peer message (\S+) from /.exec(output)?.[1];
