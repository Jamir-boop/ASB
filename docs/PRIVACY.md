# ASB privacy

ASB runs locally. Its default native and browser launch commands read no login credentials, make no model calls, send no telemetry, and make no network requests outside loopback.

This document covers `npm start`, `npm run desktop`, and the packaged `asb` launcher.

## What ASB reads

- The latest Codex `~/.codex/state_N.sqlite`, opened read-only.
- `~/.codex/session_index.jsonl` for chat names.
- Matched local Codex read marks in `.codex-global-state.json`. ASB uses only the creator identity and local host that match the database. It does not use credentials to identify the account.
- Matched `~/.codex/sessions/**/rollout-*.jsonl` lifecycle, activity, completion, and question signals.
- Claude Desktop Code `local_*.json` metadata under `$XDG_CONFIG_HOME/Claude/claude-code-sessions`, or `~/.config/Claude/claude-code-sessions` on Linux.
- Associated Claude transcripts under `~/.claude/projects` for lifecycle and completion signals.
- Approved Claude session-list and watch response bodies in `Cache/Cache_Data` for remote Code metadata. The reader uses only `https://claude.ai/v1/code/sessions` and `/watch`, with validated cache boundaries and bounded decoding. It does not use HTTP headers, cookies, authentication endpoints, or remote transcript-event bodies.
- ASB's own local state, layout, and theme settings.
- Registered app profiles use their selected local folders and the same readers. ASB also reads its own `sources.json` registration file. A ChatGPT-labeled source covers local Codex coding chats, not ordinary ChatGPT cloud chat history.

Log readers can examine message and tool events in memory to identify state. The ASB view receives no question body, answer text, raw transcript, or credential. ASB does not write to original app stores. One exception applies: the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files next to it.

## What ASB displays locally

Chat IDs, names, folders, app names, source IDs/names/colors, archive state, execution state and reason, update time, working time, subagent count, app links, and ASB attention/pin marks can appear in the local API or view. Compatibility profile numbers remain API metadata and are not visible. The source table also shows registered data and launcher paths, enabled flags, and chat count/status. These fields can still identify private work. Use synthetic data for public media and reports.

Working, Waiting, Idle, and Unknown are local observations. A completion dot is not proof of unread state in the original app. Read/Unread and pins belong only to ASB.

Remote cache observations can be incomplete or old. ASB uses the newest response and exact cursor-linked updates, and warns when no full list is cached. It does not fetch sessions or use a login. Remote records can supply an observed unread mark and explicit worker state. Missing or stale state gives Unknown. Raw participants, account IDs, configuration, bridge aliases, and action bodies stay outside the view payload.

## What ASB writes

| Default path | Stored data |
| --- | --- |
| `~/.local/state/asb/pending.json` | Chat IDs, completion/read/question acknowledgment values, manual/retained attention, pin order, and Persistent unread. |
| `~/.config/asb/layout.json` | Column width and selected view. |
| `~/.config/asb/theme.json` | Custom colors. |
| `~/.config/asb/sources.json` | Registered source IDs, app names, profile labels/colors, local data/transcript folders, installed launcher paths, and enabled flags. |
| `~/.local/share/applications/local.asb.AgentSwitchBoard.desktop` | ASB's per-user desktop entry. |
| `~/.local/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg` | ASB's app icon. |

`XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` override these base folders. The Pending state and source settings files have owner-only access; `sources.json` uses `0600`. They store no chat title, message body, or question text. When ASB cannot use one of these two files in full, it moves the old file to `pending.json.bad` or `sources.json.bad` before it saves a new one. An older `.bad` file is replaced. First use can register the known ChatGPT Personal profile when `sources.json` is absent and its local store and installed launcher exist. Disabling or removing a source keeps its files and saved ASB marks/settings. Per-user installation also copies the app into ASB's own data folder and creates `~/.local/bin/asb`. Uninstall removes the `asb/releases` and `asb` data folders when they are empty. The launcher contains local runtime and install paths. The installation manifest records versions and managed file hashes.

ASB writes no search index, review job, notification store, quota history, token cache, work-metric cache, or transcript checkpoint. The Codex reader makes no network request and reads no `auth.json`. Its source readers keep bounded caches in memory.

Source colors are ASB settings in the same schema `1` file. They change only the local identity marker, not original app styles, data, sign-ins, or attention state. Source IDs remain the identity; color does not merge chats. Source names remain available in tooltips, search, and accessible descriptions.

## Local API and app opens

ASB binds only to `127.0.0.1`. `HOST` cannot change that. The native window and optional browser view use this local API. Source events contain a version, reason, and provider flags, with no file paths or content. Watchers do not upload files.

Session actions require the local Host, a matching Origin, a known session ID, and validated request fields. Source changes use the same Host and Origin protection and accept only source settings. When the launcher starts ASB, source changes also need its per-run token in the header `X-ASB-Source-Token`. A server started with `npm start` has no token. Local paths and installed app launchers are validated. Raw commands, arguments, environment fields, and arbitrary URLs are rejected. Other local programs under your account can still access local metadata.

Selecting a row opens a validated `codex:` or `claude:` app link. Default sources use the existing URL handler. A registered profile can use its installed launcher; ASB passes one validated URI through detached `spawn`, without a shell. The launched app runs independently after dispatch; ASB does not wait for or stop it. ASB does not change sign-ins, credentials, app data, or default handlers. The original app can make its own network requests under its own settings. ASB does not send it a prompt, answer a question, cancel a task, or change its read state.

## Public release media

The banner and Remotion demo use synthetic chats and folders. The animation illustrates controls and is not a capture of local conversations.

Never publish agent databases, rollout logs, `.env` files, credentials, local installation manifests, or screenshots with private text. See [SECURITY.md](../SECURITY.md) for reporting guidance.
