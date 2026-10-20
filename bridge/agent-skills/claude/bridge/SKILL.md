---
name: bridge
description: Message local Codex tasks and other Claude Code sessions through ASB Bridge.
disable-model-invocation: true
---

# ASB Bridge for Claude Code

Claude Code sends and receives with its own tools. ASB Bridge adds Codex tasks to them.

1. Run `ListAgents`. A Codex task shows as `codex-<title>-<suffix>`. A task from another Codex home uses that home's name, for example `codex-personal-<title>-<suffix>`. It shows the folder name until the task has a title. A name can change when the user renames the task.
2. Send with `SendMessage` to that name. If the name is not found, run `ListAgents` again. Do not send to a `uds:` socket path from an old message: the path changes when Codex restarts.
3. If a Codex task is not in the list, it is not open in Codex, or it is new and had no turn yet. Ask the user to open it or to send it one message. Do not say that the task ended. Do not run `codex exec resume` while the Codex app has the thread open.
4. Put all that you have to say into one message. Put text of more than about 2,000 characters in a file, and send the path.
5. A success result means only that the text reached the socket. A missing receipt or answer is not a failure. Do not send the message again because of it, and do not send it by another name or route. When delivery is important, ask the receiver to confirm in one line.
6. Never send a secret, a credential, or an `.env` value to another agent.
7. A session on another machine shows as `<machine>-<name>`. ASB relays the message to that machine. `notify_when_idle` does not work for these sessions.
8. A full ASB session reference (`asb:1/...`) is not a `SendMessage` target. Never take the UUID out of it, and do not select a `ListAgents` name for it. Tell the user that a Codex task with ASB Bridge can send to it by reference.
