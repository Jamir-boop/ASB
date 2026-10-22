# Startup on stock Codex

Separate Claude profiles discover peers in their own `<config-home>/sessions` directory by default. The explicit `asb bridge link-claude <profile-home> <shared-home>` setup in [README.md](README.md#link-claude-profiles) shares only that registry. Native Claude Code `2.1.303` follows the directory link. App profiles and Codex task state stay separate. Install, restart recovery, and uninstall do not create or remove this link.

The goal is to open a normal Codex CLI or desktop chat, type nothing, and let Claude discover the chat and start its first turn. The plugin must work with stock Codex on other machines.

## Result

Claude cannot discover an untouched chat. Codex 0.159.2 and 0.159.3 queue `SessionStart` while it creates the session and runs it inside the first turn. Until then no receiver exists and the registry has no row.

An external first turn does work. `turn/start` with `input: []` and `toolOutput` makes the instruction enter the model as a function-call output. That turn runs `SessionStart`, which registers the receiver. Later Claude messages start idle turns or join active ones. `bun run test:native --peer-first` and `--interactive` verify this through app-server and an interactive CLI with nothing typed. The first turn has no persisted user message. The explicit backend request is part of those checks, so they do not show discovery by Claude.

## Restart recovery

When the Codex app or its app-server restarts, the old process runs `SessionEnd` for every loaded thread, and each receiver stops. Codex then loads the threads again without a turn, so `SessionStart` does not run.

The bundled MCP server starts when Codex loads a thread. About 1, 5, 15, and 60 seconds after it starts, it runs `hook.js --revive`. Each sweep makes one `thread/loaded/list` request with no limit. It probes only loaded app-server threads that had a receiver before and have no live receiver now. It keeps the state files and message history of every task, except those that ended more than 30 days ago, that Codex has not loaded, and that have no live receiver: a sweep deletes these state files (with their `-wal` and `-shm` files), and never after a failed list. A generation check makes sure that concurrent sweeps and a normal `SessionStart` leave one receiver.

Desktop IPC has no loaded-thread list. The sweep reads lifecycle metadata once and finds the newest valid `SessionEnd` time in that Codex home. For a thread absent from the app-server list, it probes desktop IPC only when the recorded end is within 30 seconds of that newest end, including the boundary. This permits recovery from the old process's shutdown burst after a restart. A failed app-server list also uses this bounded desktop path. Each desktop probe has a one-second total timeout and closes its socket. Missing or invalid end times, and ends outside the last burst, wait for a normal `SessionStart`. Old state databases still qualify through the app-server list; their desktop path needs a new `SessionEnd`. Beginning a session keeps its last end time so a failed revival can retry at a later sweep. This window limits probes; it does not prove that every eligible desktop thread is loaded.

A fresh thread has no earlier receiver, so it still needs its first turn.

## Why the MCP server cannot register early

Codex can start the bundled MCP server before the first turn. The server then lacks the owning thread ID: neither the `initialize` message nor the child environment carries it. Codex adds thread metadata only to `tools/call` requests, which need a turn.

Server-initiated requests do not fill the gap:

- Codex does not advertise Roots, and Roots describes filesystem locations.
- Ping returns an empty result.
- Elicitation returns an action and content, with no thread ID or permission state.

The daemon lists loaded threads through `thread/loaded/list` and broadcasts `thread/started`. Both identify threads globally. Neither binds one MCP process to its thread or reports the thread's approval and sandbox settings, which can differ between threads in one directory. On an untouched thread, `thread/read` returns metadata, but observer attachment through `thread/resume` fails with `no rollout found`.

## Alternatives

| Approach | Consequence |
| --- | --- |
| Run `SessionStart` as today | Registers on the first turn only. |
| Register every loaded daemon thread from MCP startup | Needs shared ownership across MCP processes. Fresh threads still lack the permission snapshot. |
| Read session files | A fresh thread has no rollout. Files do not identify the owning MCP process. |
| Infer the thread from the working directory | Several chats can share one directory, so a message can reach the wrong chat. |
| Put a controller between frontend and backend | It could capture `thread/start` responses with exact IDs and settings. It adds connection forwarding, shared lifecycle, and frontend configuration, and the desktop app needs a supported attachment point. |
| Send a synthetic opening prompt or change runtime settings | Changes the requested behavior and the thread state. Excluded. |

A controller is a separate architecture decision, and the plugin does not include one. The desktop app's blank-composer lifecycle is unverified, so the CLI results do not show when that app creates a backend thread.

## OpenCode registration

OpenCode has no `SessionStart` hook. The plugin registers a session at these times:

1. The session runs a turn (`execution.started` of a root session).
2. The session calls a bridge tool (`list_sessions`, `send_message`, or `status`).
3. Plugin start: root sessions that are not archived and were updated in the last 30 minutes, newest first, at most 8.
4. A location loads lazily: when OpenCode loads a session that registered before, its receiver comes back from state.

A subagent session never registers. Its tool call sends as its root. A `session.created` event alone registers nothing: an untouched chat stays invisible, as in Codex. A `renamed` event refreshes the title. `succeeded`, `failed`, and `interrupted` mark the receiver idle and send idle notices. `archived` unregisters. `deleted` unregisters and removes the state file. When an OpenCode instance stops, only the sessions of that location unregister. After 12 hours of no activity a session unregisters and registers again on its next turn.

## Sources

Codex `rust-v0.159.2`: [session creation](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/session/session.rs), [first-turn hooks](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/session/turn.rs), [MCP startup](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/codex-mcp/src/rmcp_client.rs), [thread metadata](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs), [running-thread resume](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/thread_processor.rs), and [tool-call metadata](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/mcp_tool_call.rs).

MCP: [Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots), [Ping](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping), [Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation).
