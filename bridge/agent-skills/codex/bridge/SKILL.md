---
name: bridge
description: Message local Claude Code sessions and other Codex tasks with the ASB Bridge tools.
---

# ASB Bridge for Codex

1. Call `list_sessions`. Select the target by its `reference` when the entry has one, else by its `sessionId`. Names, folders, and session IDs can repeat. A `sessionId` that a local session has always goes to that local session.
2. Call `send_message` with that `reference` or `sessionId` and the `text`. Copy a `reference` as it is, and never take the UUID out of it. Put all that you have to say into one message: the bridge refuses a fast series of messages to one agent. Put text of more than about 2,000 characters in a file, and send the path. Do not put a `uds:` socket path in the text.
3. Continue your work after you send. The answer arrives in your current turn, or it starts a new turn. To know when a peer is idle, call `send_message` with only `notify_when_idle` set to true. This works only for a session on this machine.
4. `socket-written`, `accepted`, `started`, and `steered` are transport steps, not answers. A missing receipt is not a failure: a receipt can be lost, and the message then stays `socket-written`. Do not send again because a receipt is missing. After an `unknown` outcome, call `status`. Do not send the message again by name, by `sessionId`, or by another route, unless the user tells you to: it can arrive two times.
5. If `status` shows a `replyAddress` of null during a turn, ask the user to check that the ASB Bridge hooks are trusted. No tool starts the receiver.
6. If a peer is not in the list, it is not running or not open. Ask the user. Do not say that it ended.
7. Before two agents edit one repository, agree which agent owns which files. The bridge has no locks.
8. Never send a secret, a credential, or an `.env` value to another agent.
9. If the user gives a full session reference (`asb:1/...`), use it as the `reference` of `send_message`. It can be for a session on another machine of the group.
