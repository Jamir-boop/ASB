---
name: bridge
description: Use for asb:1/ session references and messages to Codex tasks or other machines.
---

# ASB Bridge for Claude Code

1. Run `ListAgents`. A Codex task shows as `codex-<title>-<suffix>`. A session on another machine shows as `<machine>-<name>`.
2. Send with `SendMessage` to that name. A `uds:` socket path is not a target: it changes when Codex restarts.
3. A Codex task that is not in the list is not open, or is new and had no turn yet. Ask the user to open it or to send it one message. Never say that it ended. Do not run `codex exec resume` for an open thread.
4. Put all that you have to say into one message. Put text of more than about 2,000 characters in a file, and send the path.
5. Success means only that the text reached the socket. A missing receipt or answer is not a failure. Do not send again, not by another name or route: it can arrive twice.
6. Never send a secret, a credential, or an `.env` value to another agent.
7. An `asb:1/...` session reference is not a `SendMessage` target. Never take the UUID out of it. Only a Codex task can send to it.
