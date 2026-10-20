---
name: bridge
description: Message local Claude Code sessions and other Codex tasks with the ASB Bridge tools.
---

# ASB Bridge for Codex

1. Call `list_sessions`. Select the target by `sessionId`. Names and folders repeat.
2. Call `send_message` with the `sessionId` and the `text`. Put all that you have to say into one message: the bridge refuses a fast series of messages to one agent. Put text of more than about 2,000 characters in a file, and send the path. Do not put a `uds:` socket path in the text.
3. Continue your work after you send. The answer arrives in your current turn, or it starts a new turn. To know when a peer is idle, call `send_message` with only `notify_when_idle` set to true.
4. `socket-written`, `accepted`, `started`, and `steered` are transport steps, not answers. After an `unknown` outcome, call `status` before you send again.
5. If `status` shows a `replyAddress` of null during a turn, ask the user to check that the ASB Bridge hooks are trusted. No tool starts the receiver.
6. If a peer is not in the list, it is not running or not open. Ask the user. Do not say that it ended.
7. Before two agents edit one repository, agree which agent owns which files. The bridge has no locks.
8. Never send a secret, a credential, or an `.env` value to another agent.
9. If the user gives a full session reference (`asb:1/...`), call `send_message` with `reference` set to that text as it is. Never take the UUID out of it. The reference can be for a session on another machine of the group. `notify_when_idle` with a reference works only for a session on this machine. After an `unknown` outcome for a reference, call `status`. Do not send the message again by name or by `sessionId`. A receipt from another machine can be lost: the message then stays `socket-written`. Do not send it again because a receipt is missing.
