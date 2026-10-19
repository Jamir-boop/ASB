# ASB privacy

ASB runs locally. Its default native and browser launch commands read no login credentials, make no model calls, send no telemetry, and make no network requests outside loopback. The optional phone gateway is off by default. When you turn it on, it accepts connections from paired phones on the private LAN, ZeroTier, or Tailscale addresses that you select.

This document covers `npm start`, `npm run desktop`, the packaged `asb` launcher, and the optional `asb service`. The optional bridge and the optional Android companion are described below.

## What ASB reads

- The latest Codex `~/.codex/state_N.sqlite`, opened read-only.
- `~/.codex/session_index.jsonl` for chat names.
- Matched local Codex read marks in `.codex-global-state.json`. ASB uses only the creator identity and local host that match the database. It does not use credentials to identify the account.
- Matched `~/.codex/sessions/**/rollout-*.jsonl` lifecycle, activity, completion, and question signals.
- Claude Desktop Code `local_*.json` metadata under `$XDG_CONFIG_HOME/Claude/claude-code-sessions`, or `~/.config/Claude/claude-code-sessions` on Linux.
- Associated Claude transcripts under `~/.claude/projects` for lifecycle and completion signals.
- The opening tag of each `<cross-session-message>` delivery record in these transcripts. ASB keeps only the `from-session` or `from` sender ID and the record time. It never keeps the message body, `from-name`, or the socket address.
- Usage-limit numbers. From Codex session logs, ASB uses only `codex_error_info` of `task_complete` errors, and `used_percent` and `resets_at` of `rate_limits.primary` and `rate_limits.secondary` in `token_count` records. It never uses the error message. From Claude transcripts, it uses only `isApiErrorMessage`, `error`, and `quotaLimits.resetsAt` of assistant records. It never uses the limit message text or account and plan data. The view gets only the reset time.
- ASB Bridge databases under `<CODEX_HOME>/plugin-state/asb-bridge/`, opened read-only. ASB reads only `peer_id`, `direction`, `status`, `kind`, and `created_at` of incoming (`in`) rows from the last two minutes. It never selects `text` or `peer_address`.
- Approved Claude session-list and watch response bodies in `Cache/Cache_Data` for remote Code metadata. The reader uses only `https://claude.ai/v1/code/sessions` and `/watch`, with validated cache boundaries and bounded decoding. It does not use HTTP headers, cookies, authentication endpoints, or remote transcript-event bodies.
- ASB's own local state, layout, and theme settings.
- Registered app profiles use their selected local folders and the same readers. ASB also reads its own `sources.json` registration file. A ChatGPT-labeled source covers local Codex coding chats, not ordinary ChatGPT cloud chat history.

Log readers can examine message and tool events in memory to identify state. The ASB view receives no question body, answer text, raw transcript, or credential. ASB does not write to original app stores. One exception applies: the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files next to it. The read-only open of an ASB Bridge database can do the same.

## What ASB displays locally

Chat IDs, names, folders, app names, source IDs/names/colors, archive state, execution state and reason, update time, working time, usage-limit reset time, subagent count, app links, and ASB attention/pin marks can appear in the local API or view. Compatibility profile numbers remain API metadata and are not visible. The source table also shows registered data and launcher paths, enabled flags, and chat count/status. These fields can still identify private work. Use synthetic data for public media and reports.

For session messages, the view gets only pairs of row IDs (sender and receiver) and the message times. It gets no message text, sender name, or address.

Working, Waiting, Idle, and Unknown are local observations. A completion dot is not proof of unread state in the original app. Read/Unread and pins belong only to ASB.

Remote cache observations can be incomplete or old. ASB uses the newest response and exact cursor-linked updates, and warns when no full list is cached. It does not fetch sessions or use a login. Remote records can supply an observed unread mark and explicit worker state. Missing or stale state gives Unknown. Raw participants, account IDs, configuration, bridge aliases, and action bodies stay outside the view payload.

## What ASB writes

| Default path | Stored data |
| --- | --- |
| `~/.local/state/asb/pending.json` | Chat IDs, completion/read/question acknowledgment values, manual/retained attention, pin order, Persistent unread, and drawer marks. |
| `~/.config/asb/layout.json` | Column width, selected view, and Show app pills. |
| `~/.config/asb/theme.json` | Custom colors. |
| `~/.config/asb/sources.json` | Registered source IDs, app names, profile labels/colors, local data/transcript folders, installed launcher paths, and enabled flags. |
| `~/.config/asb/phone.json` | Phone access on or off, selected addresses, port, and paired phones: ID, name, pairing and last-seen times, and the SHA-256 of the token. |
| `~/.config/asb/phone-tls/` | The phone certificate and its private key. |
| `~/.local/state/asb/palette.json` | The last color palette of the ASB window: the GNOME or Custom mode and seven colors. |
| `$XDG_RUNTIME_DIR/asb/service.json` | Pid, port, and per-run source token of the running `asb service`. |
| `~/.config/systemd/user/asb.service` | The user service unit, only after `asb service install`. |
| `~/.local/share/applications/local.asb.AgentSwitchBoard.desktop` | ASB's per-user desktop entry. |
| `~/.local/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg` | ASB's app icon. |

`XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` override these base folders. The Pending state and source settings files have owner-only access; `sources.json` uses `0600`. They store no chat title, message body, or question text. When ASB cannot use one of these two files in full, it moves the old file to `pending.json.bad` or `sources.json.bad` before it saves a new one. An older `.bad` file is replaced. First use can register the known ChatGPT Personal profile when `sources.json` is absent and its local store and installed launcher exist. Disabling or removing a source keeps its files and saved ASB marks/settings. Per-user installation also copies the app into ASB's own data folder and creates `~/.local/bin/asb`. Uninstall removes the `asb/releases` and `asb` data folders when they are empty. The launcher contains local runtime and install paths. The installation manifest records versions and managed file hashes.

ASB writes no search index, review job, notification store, quota history, token cache, work-metric cache, or transcript checkpoint. The Codex reader makes no network request and reads no `auth.json`. Its source readers keep bounded caches in memory.

Source colors are ASB settings in the same schema `1` file. They change only the local identity marker, not original app styles, data, sign-ins, or attention state. Source IDs remain the identity; color does not merge chats. Source names remain available in tooltips, search, and accessible descriptions.

## Optional ASB Bridge

ASB Bridge runs inside Codex. It stores the text of peer messages in per-task SQLite files under `<CODEX_HOME>/plugin-state/asb-bridge/`. ASB does not upload them. A message that the bridge delivers starts a turn in the receiving app. The receiving app uses its own model and network settings.

Only when you run `asb bridge link-claude <profile-home> <shared-home>`, setup links the profile's native `sessions` directory to the selected shared registry. This shares peer metadata and local IPC authentication keys across those profiles. It does not share settings, transcripts, app data, logins, model-provider credentials, or Codex homes. Linked peers can discover and message each other, and a message can start a model turn in the receiving app. This broadens local messaging access within your user account.

The registry and the original-directory backup are private (`0700`). Setup never overwrites a target file. Unknown files and detected concurrent changes cause refusal. A failed rollback keeps and reports the original backup or changed copies when removal would risk data loss. The backup is a snapshot and does not receive later updates. Install and uninstall keep the shared registry, link, and backup. Native link behavior was checked in Claude Code `2.1.303`; it is not a published API. See [the setup and rollback limits](../bridge/README.md#link-claude-profiles).

## Optional Android companion

Phone access is off by default. You turn it on in Preferences > Phone and pair each phone with a one-time QR code. The ASB app scans the code with its own scanner, or the phone camera or any QR scanner app opens the `asb://pair` link in the ASB app. The app uses the camera only while the scanner is open, to read the pairing code. Camera frames stay on the phone and are not saved or sent. The app uses no Google Play services. ASB uses no cloud service and no relay of its own. The phone talks to the PC directly on your local network, or away from home through ZeroTier or Tailscale when you install and join one of them on the PC and the phone. These overlay networks are third-party services with their own privacy terms; ASB does not configure them. The gateway binds only the private LAN, ZeroTier, and Tailscale addresses of the PC that you select. It never binds a public address. A home network or ZeroTier address accepts only loopback and private IPv4 remote addresses. A Tailscale address accepts only Tailscale (`100.64.0.0/10`) and private IPv4 remote addresses. All traffic uses TLS 1.3. The phone pins the SHA-256 of the ASB certificate, and you compare the fingerprint during pairing.

A paired phone receives the same dashboard data as the local view: chat titles, folders, app and source names and colors, execution states, update and working times, usage-limit reset times, attention, pin, and drawer marks, and row IDs. For session messages it receives only pairs of row IDs and the message times. It receives no message text, question body, answer text, transcript, or credential. It also receives the PC host name, the ASB version, the listening addresses and port of the gateway, and the color palette of the ASB window (seven `#RRGGBB` colors and the GNOME or Custom mode). The phone can open chats on the PC and use the row actions and Persistent unread. It cannot read or change app sources or phone settings.

Each phone gets its own 256-bit random token. The PC saves only the SHA-256 of each token. The phone keeps the token in app-private storage, and the app turns off Android backup and device transfer. **Remove** in Preferences > Phone ends that phone's access at once. The pairing code works once and ends after 10 minutes. Repeated failed attempts from one address are blocked for one minute.

Phone notifications show the session title and the source name. The app marks them private, so a secure lock screen can show only "A session needs attention", according to your Android settings. Anyone who unlocks the phone can see the session titles and folders in the app.

## Local API and app opens

The ASB server binds only to `127.0.0.1`. `HOST` cannot change that. The optional phone gateway is a separate listener; see above. The native window and optional browser view use this local API. Source events contain a version, reason, and provider flags, with no file paths or content. Watchers do not upload files.

Session actions require the local Host, a matching Origin, a known session ID, and validated request fields. Source changes use the same Host and Origin protection and accept only source settings. When the launcher starts ASB, source changes also need its per-run token in the header `X-ASB-Source-Token`. A server started with `npm start` has no token. Local paths and installed app launchers are validated. Raw commands, arguments, environment fields, and arbitrary URLs are rejected. Other local programs under your account can still access local metadata.

Selecting a row opens a validated `codex:` or `claude:` app link. Default sources use the existing URL handler. A registered profile can use its installed launcher; ASB passes one validated URI through detached `spawn`, without a shell. The launched app runs independently after dispatch; ASB does not wait for or stop it. ASB does not change sign-ins, credentials, app data, or default handlers. The original app can make its own network requests under its own settings. ASB does not send it a prompt, answer a question, cancel a task, or change its read state.

## Public release media

The banner and Remotion demo use synthetic chats and folders. The animation illustrates controls and is not a capture of local conversations.

Never publish agent databases, rollout logs, `.env` files, credentials, local installation manifests, or screenshots with private text. See [SECURITY.md](../SECURITY.md) for reporting guidance.
