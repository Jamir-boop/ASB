---
name: bridge
description: Use for asb:1/ session references and messages to Claude Code or Codex sessions.
---

# ASB Bridge for Codex

1. Call `list_sessions` (use `nameContains` when you know part of the name), then `send_message`. If the user gives a full session reference (`asb:1/...`), use it as the `reference`. Copy it as it is. Never take the UUID out of it.
2. Do not put a `uds:` socket path in the text. Put text of more than about 2,000 characters in a file, and send the path.
3. `socket-written`, `accepted`, `started`, and `steered` are transport steps, not answers. A missing receipt is not a failure. Do not send again because of it. After an `unknown` outcome, call `status`. Do not send again by name, by `sessionId`, or by another route, unless the user tells you to: it can arrive two times.
4. If a peer is not in the list, it is not running or not open. Ask the user. Do not say that it ended.
5. Before two agents edit one repository, agree which agent owns which files. The bridge has no locks.
6. Never send a secret, a credential, or an `.env` value to another agent.
