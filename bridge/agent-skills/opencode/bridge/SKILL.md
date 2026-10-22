---
name: bridge
description: Use for asb:1/ session references and messages to Codex tasks or other machines.
---

# ASB Bridge for OpenCode

1. Use `tools.asb_bridge.list_sessions`. A Codex task shows as `codex-<title>-<suffix>`. A session on another machine shows as `<machine>-<name>`.
2. Send with `tools.asb_bridge.send_message`. Use the `reference` of an entry when it has one, else its `sessionId`. A `uds:` socket path is not a target: it changes when the peer restarts.
3. A session that is not in the list is not open, or is new and had no turn yet. Ask the user to open it or to send it one message. Never say that it ended.
4. Put all that you have to say into one message. Put text of more than about 2,000 characters in a file, and send the path.
5. Success means only that the text reached the socket. A missing receipt or answer is not a failure. Do not send again, not by another name or route: it can arrive twice.
6. Never send a secret, a credential, or an `.env` value to another agent.
7. Give an `asb:1/...` value as `reference`. Never take the UUID out of it.
