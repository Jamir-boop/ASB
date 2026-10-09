# ASB system overview

The current ASB source version is `1.5.0`. See the [publication record](docs/OPEN_SOURCE_PLAN.md) for verified release status.

ASB is a local switch board for existing Codex and Claude Desktop Code chats, including remote Code sessions observed in Claude's local cache. Its main view is a small native GNOME window. It observes local files and opens the original app. It makes no model calls.

Read [README.md](README.md) for installation, [ASB.md](ASB.md) for controls, and [Privacy](docs/PRIVACY.md) for data access. ASB uses its own version series. Agent Mission Control `0.6.0` is the upstream base, not the ASB release version.

## Runtime path

```text
scripts/asb-desktop.mjs
  -> src/switchboard.mjs, loopback HTTP server through src/asb-server.mjs
  -> scripts/asb-native.py, GTK/Libadwaita window
       -> local dashboard, event, open, and ASB state APIs

src/switchboard.mjs
  -> src/app-sources.mjs, local profile registry
  -> src/codex-data.mjs, read-only Codex reader
  -> src/claude-data.mjs, Claude Desktop Code reader
  -> src/insights.mjs, root grouping and normalization
  -> PendingTracker, ASB attention and pin state
```

The launcher creates its own server and Python child. It stops them when the window closes or Node emits the launcher's exit event, including normal and fatal JavaScript exits. SIGKILL or a native process abort can bypass this cleanup. An icon registration error stays visible and does not prevent the native window from opening. Launching from source (`npm run desktop` or `scripts/asb`) keeps an installed desktop entry and reports the conflict. It replaces a source-run entry, including one from another checkout. A port conflict is an error. It does not attach to a process already on the port. The server binds only to `127.0.0.1`; `HOST` cannot change that. The default port is `4629`. The launcher creates one random app source token for each run. It gives the token to the server and to the window through `ASB_SOURCE_TOKEN`.

Python 3 needs PyGObject, GTK `>=4.12`, and Libadwaita `>=1.4`. Node.js `>=22.13` uses built-in SQLite with read-only connections. Older supported Node.js (`>=20`) uses `sqlite3 -readonly`; the Debian package keeps that dependency. ASB's runtime has no external npm dependencies. Development tests use Node.js `>=22.13` and built-in SQLite fixtures, without the SQLite CLI.

ASB uses `DashboardSnapshot` in `src/dashboard-snapshot.mjs` for snapshots, source events, watchers, caches, and request coalescing. It also uses local HTTP utilities, Codex open helpers, and provider cache helpers.

ASB `1.5.0` ships 30 runtime files, including the app-source registry. The package whitelist names them. ASB `1.4.0` also shipped 30. ASB `1.3.0` shipped 32. ASB `1.2.0` shipped 31, down from 42 in ASB `1.1.0`.

## Main files

| File | Responsibility |
| --- | --- |
| `src/switchboard.mjs` | ASB source selection, state, attention, pins, open validation, and server entry. |
| `src/app-sources.mjs` | App-source registration, validation, profile colors, and local settings. |
| `src/asb-server.mjs` | Restricted ASB HTTP server for native and browser clients. |
| `src/dashboard-snapshot.mjs` | Snapshots, source events, watchers, caches, and request coalescing. |
| `src/local-http.mjs` | JSON and static-file HTTP utilities. |
| `src/session-opener.mjs` | Codex app opens and response fields. |
| `src/data-cache.mjs` | Provider cache helpers. |
| `src/codex-data.mjs` | Read-only Codex database, names, lifecycle, questions, and matched native read marks. |
| `src/claude-data.mjs` | Claude Desktop Code metadata and matched local transcript signals. |
| `src/claude-remote-data.mjs` | Approved cached remote session metadata, cursor-linked updates, and explicit worker state. |
| `src/insights.mjs` | Shared thread normalization and root/descendant grouping. |
| `scripts/asb-desktop.mjs` | Native launcher and owned child-process cleanup. |
| `scripts/asb-native.py` | Native rows, filters, search, layout, theme, input, and local label clock. |
| `scripts/asb-icon.mjs` | ASB icon and desktop entry registration. |
| `scripts/asb-package.mjs` | Linux package build, runtime check, and per-user install/uninstall. |
| `public/switchboard.html` | Optional ASB browser view. |
| `test/switchboard.test.mjs` | ASB data, attention, API, and source-event checks. |
| `test/asb-desktop.test.mjs` | Isolated launcher, port-conflict, icon-failure, and owned-child checks without GTK. |
| `test/asb-docs.test.mjs` | ASB install, media, privacy, and credit checks. |
| `test/asb_native_logic_test.py` | Native data, layout, theme, search/filter, scheduling, and row-reuse checks with no GTK display. |
| `docs/status-mapping.html` | Status mapping worksheet; update it when a state, icon, or Pending rule changes. |
| `demo/` | Separate Remotion project with synthetic public demo data. |

## Sources and list scope

ASB loads enabled app sources independently. One failed source does not remove another source's rows. The default sources use these paths:

| Source | Read path |
| --- | --- |
| Codex | Latest `~/.codex/state_N.sqlite`, `session_index.jsonl`, `.codex-global-state.json`, and matched `sessions/**/rollout-*.jsonl`. |
| Claude Desktop Code on Linux | `$XDG_CONFIG_HOME/Claude/claude-code-sessions/local_*.json`, or `~/.config/Claude/claude-code-sessions/local_*.json`. |
| Claude transcript signals | Matched JSONL files under `~/.claude/projects`. |
| Claude remote Code | Session-list and watch response bodies in Claude's `Cache/Cache_Data`. |

### App-source registry

`src/app-sources.mjs` stores up to eight sources in `~/.config/asb/sources.json`, with owner-only `0600` access. XDG config overrides apply. Each source has a stable ID, provider, label, color, dot visibility, data folder, installed launcher, and enabled flag. Claude can also set a transcript folder. The two default sources stay registered; users can edit or disable them. Additional sources can be removed. The same physical store cannot be registered twice.

A Codex source reads its `CODEX_HOME` folder with the same relative files as the default source. A Claude source reads its app profile folder, including `claude-code-sessions` and `Cache/Cache_Data`; its transcript folder defaults to `~/.claude/projects`. This supports separate profiles that use one app binary with isolated `CODEX_HOME` and Electron profile folders. On the first registry read, when `sources.json` is absent, ASB registers the known ChatGPT Personal profile only if its local store and installed launcher are present. ASB does not change logins, credentials, app data, or default URL handlers. ChatGPT-labeled sources expose local Codex coding chats; ordinary ChatGPT cloud chat history is outside this source.

Default sources keep their existing row IDs. Additional sources prefix row and parent IDs with the stable source ID, while `externalId` keeps the original app ID for opens. Equal app IDs in different stores remain separate. Rows provide `sourceId`, `sourceLabel`, read-only `sourceColor`, and `sourceShowMarker`. The compatibility fields `sourceNumber` and `sourceCount` remain metadata; numbers are not visible. Numbers start at one per provider in registry order, including disabled sources. Removal can change numbers, but source IDs define identity. Colors do not merge sources or chats. Disabling or removing a source does not delete ASB attention, pins, unread marks, or settings.

Source settings schema `1` accepts optional `color` as a six-digit hex value and saves it in lowercase. Old settings without a color get a stable default from the source ID. An edit that omits `color` keeps the existing color. Dark picker colors also save; native rendering adjusts only the displayed color to keep 3:1 contrast on the current base and hover backgrounds. Optional boolean `showMarker` defaults to true for old settings. An edit that omits it keeps the existing value. False hides only the profile dot in both views; color, source reads, opens, state, unread, and pins stay unchanged. The native editor uses explicit Save and shows save success or errors.

Additional profiles need a supported installed launcher path. ASB sends that launcher one validated app URI through detached `spawn`, without a shell. The launched app runs independently after dispatch; ASB does not wait for or stop it. Default sources can leave the launcher empty to use the existing URL handler. Each profile's files and directories use the shared debounced watchers and existing polling fallback.

Root chats are the list unit. Explicit workers and subagents stay grouped under the root. ASB omits `subagent` and `guardian_review` source rows. Each source has a 5000-record limit. ASB does not discover orphan Codex rollouts outside the database. Archived rows are available but hidden by default.

Codex names prefer the desktop/session-index name, then the raw stored title, with the existing empty fallback. ASB does not select `first_user_message` for title derivation. A row title is limited to 300 characters; a longer title ends with `…`. Whole Unicode code points are kept. Codex stores can hold a full prompt as a title. Search and the tooltip use the limited title. Claude Desktop Code titles keep their own shorter limit. Claude metadata must have a valid `local_<uuid>` ID to provide an open action. App links are constructed from valid IDs:

- `codex://threads/<uuid>`
- `claude://code/continue?session=local_<uuid>`
- `claude://code/<validated cse_ or session_ ID>`

Default app opens use the source apps' registered URL handlers. Registered profile launchers receive the same validated links. ASB does not create chats or run a CLI resume command for its open action.

Remote cache reads accept only production `https://claude.ai/v1/code/sessions` and `/watch` response bodies. HTTP headers, credentials, transcript-event endpoints, and raw account/config fields are not used. Completed cache entries use Chromium stream boundaries; open gzip watches use their partial body and zero-filled reserved tail. ASB selects the newest response and exact cursor-linked continuations, not a union of old login streams. Missing full-list metadata produces a source warning and only observed rows. Cache delay, eviction, and offline periods can limit coverage. No remote request is made.

Local bridge aliases deduplicate matching remote rows. For bridge records, validated `session_<token>` and `cse_<token>` links use the same identity. ASB keeps the local row, folder, and direct-open link. Invalid aliases and aliases with more than one local owner cannot remove a remote row. Cloud rows require an exact stored alias. Titles and times do not establish identity. Aliases stay outside the view payload.

Remote execution requires a response observation within six hours plus explicit worker/session state. Server sync receipt cursors provide observation time; file modification time is a fallback for an approved body write. Bridge sessions also need an explicit connected state. Cloud sessions do not need that bridge field. Unknown, stale, or disconnected records give Unknown. Remote Working has no inferred start time. Folders stay empty; safe Git source names can identify a project. Fresh cached unread marks use the same ASB attention rules as other native marks.

## Execution and attention

Execution uses Working, Waiting, Idle, and Unknown. A root is not Working only because it is unarchived. Open task/request signals require activity within six hours. Source signals can lag or survive a crash; old open signals become Unknown.

Codex roots include unarchived descendants with explicit database links, including nested subagents. The existing bounded rollout cache reads their lifecycle. A recent open child task keeps the root Working after the root's own task ends. Only recent open members set the current start time. Missing or stale child lifecycle gives Unknown unless another member has current work. Archived, unrelated, and orphan rollouts do not change root execution.

The Claude Desktop Code reader includes child files under the matched root transcript in the child count. An async Agent launch must link its returned agent ID to that exact root's child file. Recent child request, thinking, and tool events keep the root Working after its own response ends. Child completion, interruption, and error events close that work. Unrelated children cannot change execution. Missing linked lifecycle gives Unknown unless the root has current work. Stale child work cannot set a fresh root's timer start.

Each non-empty Claude user reply starts a task, including `ok`, `y`, `1`, `.`, and `继续`. Local command records (`<local-command-caveat>`, `<command-name>`, `<local-command-stdout>`) do not start a task. Both readers skip a JSONL line that is not an object.

Current synchronous questions can block execution in Waiting. Async questions add attention while Working or Idle remains visible. Matching answers, failure, abort, or cancellation resolve the question. Real human input supersedes old questions. Automatic goal continuation, context, and partial answers do not. Question and answer bodies stay outside ASB view payloads.

A pending Claude `AskUserQuestion` tool call is a question. It gives Waiting and question attention. If it is the only pending tool and a linked child has recent open work, the row stays Working with question attention. Other pending permission tools, including `ExitPlanMode`, give Waiting with a passive `?` until a tool result or terminal event resolves them. A pending Claude permission, plan approval, or question tool gives Waiting and Pending only for six hours after its tool event. After that, the usual rules apply, and an old open task gives Unknown. A fresh remote worker `requires_action` uses the same wait rule. ASB Read and successful opens cannot clear these waits. The Read control and row menu have no Read action during such a wait; Pin stays available.

Codex approval wait is unsupported. The local state schema has no current unanswered approval field, and the examined rollout schema has no reliable request/resolution pair. ASB does not read the app-server `waitingOnApproval` flag or infer approval from tool names, time, or policy fields. An open task keeps its current Working rule.

Linked Codex child questions add root attention. A current synchronous child question gives Waiting when no recent open member can continue. The root's own current synchronous question keeps its Waiting priority. Native read status still comes from the root. ASB Read acknowledges group attention without changing source questions or read marks.

Pending is separate from execution. Every visible unread dot or `?` counts as Pending, including Unknown and archived rows when they have a visible dot. A stop square does not count as Pending. A Working chat cannot be unread. While a row is Working, `unread` is false and only question attention makes it Pending. Stored manual, native, completion, failure, and retained marks do not change; they show again when Working ends.

Native Codex unread needs a creator identity and exact local host match. Missing or unmatched metadata gives Unknown read status. Identity fields stay outside the API. Local Claude chats have no reliable native unread source. ASB completion and failure marks require an observed Working-to-Idle change and a new terminal event. A task that goes Working, Waiting, then Idle keeps this observation and gets its completion or failure mark. Historical Idle rows do not gain either mark on first load. Sources with native read truth keep their native rule. Abort and cancellation add no new unread mark.

Codex and Claude terminal attention is held until the root and its linked child work end. The last group end sets the outcome. A successful end can add completion attention. A failed end can add a failed-task dot until Read, under the same observed-end, open acknowledgment, and Persistent unread rules. Codex failure uses a non-null terminal `task_complete.error`. Claude failure uses terminal `result.is_error`, a linked failed task notification, or a fresh remote session `failed` state. Linked child task notifications handle the statuses `completed`, `failed`, `cancelled`, and `aborted`. Ordinary tool errors, refusal text, child shutdown, and interruption do not establish task failure. A later completion or cancellation takes priority over an older failure. Child IDs, error bodies, prompts, and transcript paths stay outside the ASB view and state file.

A final root or group cancellation gives Idle with a passive stop square, including historical rows. Read does not clear this source outcome. New work or a later end removes the square. Existing question or unread attention remains visible in preference to the square.

Discard applies once to the current Working task. A verified successful root/group end clears the arm and suppresses its completion and matching native unread attention, including new Persistent unread retention. It does not clear manual Unread, question attention, or earlier failed-task attention. Failed ends keep their normal dot; cancellation keeps the stop square. Discard is not attention and does not change state or sort order. Any observed Idle clears the arm. Waiting and Unknown keep it stored.

Existing lifecycle caches retain explicit member starts and terminal timestamps/kinds. The tracker uses these signals through private row Symbols, without exposing identities or transcript paths. A root ending while a linked child continues does not clear Discard. A child's first start uses explicit Codex creation or Claude launch/request evidence to cover late starts; missing evidence remains conservative. A proven new root task after its terminal event clears the old arm, including when Idle was missed between scans. A verified group end followed by new member work also clears it. A follow-up message in an armed Claude task does not clear the arm. Only a task that starts after an end later than the arm clears it. The displayed Working timer is not a task identity.

The first matched native unread episode for a discarded success is acknowledged locally, including a mark that arrives one scan later. A later observed Read-to-Unread cycle is preserved. The first late mark cannot be distinguished from a source-app manual Unread for the same completion; that first episode can be suppressed. A verified newer end clears the old native mask, and a failed end cannot use it. Local readers keep only the latest terminal data: if an armed task and a whole later task both end before the next observation, the later successful end can be discarded. Discard arming therefore scans current source state and rejects an already-Idle row; Keep uses the normal cache. This prevents a late cached click from arming after both tasks ended. Remote `completed`/`review_ready` and `failed` terminal metadata are supported. Generic remote Idle without a terminal timestamp clears the arm but does not suppress unknown/native attention. A remote end and new run wholly between observations cannot be proved from the cache metadata, so the old arm can remain. ASB makes no timing guess or remote call.

Read, Unread, pins, and pin order belong only to ASB. A successful open acknowledges ASB attention by default. It does not change execution or answer a question. Failed opens preserve attention. Persistent unread retains attention until Read, even after source Read/resolution or successful opens. It is off by default.

All clients share one tracker. Tracking uses the complete scanned list before filters. `pending.json` contains IDs, marker/acknowledgment values, manual marks, retained sources, pin order, Persistent unread, and numeric Discard fields (`discard`, `discardedAt`, `discardStart`, `discardEnd`, `discardNative`). Version 1 remains compatible with old records; missing/invalid numeric fields use zero. The file has owner-only access. It contains no chat titles, message bodies, call IDs, or transcript paths.

ASB shows the Pending state warning when it cannot use `pending.json` in full. The causes are an unreadable file, invalid JSON, a version other than 1, a bad shape, or a dropped record. ASB then moves the old file to `pending.json.bad` before the first save. An older `.bad` file is replaced. The same rule applies to `sources.json`: ASB moves it to `sources.json.bad` before the next source update or remove. The warning that ASB cannot save Pending state clears after the next good save.

## Native view contract

- Compact is the default with 22-pixel rows. Comfortable uses 68-pixel rows with the folder first and a two-line title.
- Comfortable uses C Restore on hover: only Idle rows without visible ASB unread/question attention or Pending use quiet title/folder/state/age text. Pinned rows use the same rule; provider marks and controls keep their strength. Hover/focus restores normal text. Source read metadata cannot override ASB acknowledgment. Quiet colors derive from the active palette and keep 4.5:1 contrast on background and highlight. Compact is unchanged.
- Comfortable uses the approved C Corner pair: a top-right Read dot beside Pin/Unpin. Pin appears on row hover or keyboard focus; a pinned control stays visible. Both use the existing ASB state APIs and stay separate from opening the chat. Saved pin order, drag reorder, and row menus remain available.
- Comfortable actions use 24-pixel circular targets in an unmeasured overlay. Folder and title reserve 62 pixels at the right, including the content inset. State and time remain in the footer. Compact and the outer frame keep their existing layout.
- Comfortable paints one shared hover highlight behind cards and actions, across columns. One native animation uses 200 ms for movement and 100 ms for arrival/leave, aligned with the approved command-palette motion reference; rapid targets start from the current painted bounds. GNOME colors stay dynamic; custom colors use the existing highlight mix. GNOME animations off gives immediate feedback. Repacking, filters, resize, scroll, the start of a card motion, unmap, and close clear it. Hover makes no source reads and adds no permanent frame loop. Compact and keyboard focus keep their existing feedback.
- One indicator serves both views with priority `?`, dot, Discard ring, stop. A current permission wait or question attention shows the accent `?`. Unread shows the 7-pixel dot. Armed Working uses a hollow ring with a 9-pixel outer size (6-pixel space and 1.5-pixel border), using GNOME foreground or custom text. It does not count as Pending. An Idle stopped outcome with no attention shows a 7-pixel muted square with a 1-pixel radius. The stop and permission-wait marks are passive and have no Read action or check cue. Tooltips and accessible labels distinguish current wait, stopped, failed, completed, and armed Discard. They do not report stored unread while `unread` is false. The indicator updates in place and keeps row geometry and pin controls.
- Comfortable uses the existing 24-pixel Read slot for Discard while Working without question attention. Before arming, its dashed muted ring appears on row hover or keyboard focus. Armed, the solid ring stays visible and offers Keep result. Discard actions have no Read check cue or confirmation and cannot open the row. Questions retain the Read action or passive permission-wait behavior. Reading a Working question returns directly to the Discard ring without a check; Idle/Waiting Read confirmation stays unchanged. New Working without a question clears old Read feedback. Compact shows only the passive armed ring and keeps the timer. Working row menus offer Discard result or Keep result as the keyboard path. No card text is dimmed by Discard.
- Both views use the approved A Unfolded card tooltip: 14px provider icon plus full muted path, full 13px wrapped title, then an 11px state/time and app/source footer. Home uses `~` only at a directory boundary. A native FlowBox wraps the app block onto its own right-aligned line. The Soft profile dot follows the row's existing rule. One optional note uses the actual indicator and one fixed sentence; short flags and the current row error share its hairline block. Read historical failures have no failed-unread note. All text uses plain labels, WORD_CHAR wrapping, and an approximate 36-character width, with no title/path truncation or fixed height. The title is the limited title of at most 300 characters from the server. The GTK tooltip surface stays native.
- Each tooltip query computes a fresh cheap model from the cached row and current clock/error, with no source read. The row lazily retains one content widget and complete render key; unchanged models reuse it, and every query calls GTK `set_custom`. Model, provider/state tint, and custom-theme changes rebuild content. Palette changes clear all row tooltip caches, including hidden rows. Each row owns one query handler; release/close clears its content/key and disconnects it separately from the five input controllers. Rows have no static tooltip-text property. Visible tooltips omit state reason and long source/read metadata. The accessible description keeps the full original path, title, state/time, note, flags, error, state reason, and source name/ID; row names and control tooltips stay unchanged.
- A successful Read clears only ASB attention and shows a check for 1.6 seconds. It works with either Persistent unread setting. Failure keeps the dot. Row identity, view, feedback generation, and current attention guard against stale results or new unread marks. Read does not change execution, original-app read state, or source question resolution.
- A successful completed Read records a per-row monotonic time. Discard/Keep activation is ignored for 0.5 seconds after it, before busy state or a request is created. The ring/offer is visible immediately. Menus, server behavior, and Idle/Waiting Read confirmation stay unchanged; row release clears the stored time.
- While a row action is pending, its controls keep pointer sensitivity but lose their action bindings. They report `BUSY` and `DISABLED` to accessibility APIs. The confirmation has no Read action binding. Pointer and keyboard activation cannot open the row through these controls.
- Rows flow down each column, then across. The list scrolls horizontally. Height sets row capacity; shared width sets visible columns. An order-only refresh with the same IDs and packing moves only changed rows inside existing columns, without explicit menu or scroll teardown. Widget/action identity and focus are retained when possible. When a moved row had keyboard focus, the window sets the focus on it again. Columns keep the shared width when the list has fewer columns than the window can show, for example search results with long titles.
- Card motion applies to both views. When data or filters change the order or the set of visible cards, each card that stays visible glides from its old place to its new place, and each new card fades in. A card that leaves disappears at once. The causes are a row that goes from unread to read, a new order from a refresh, a pin move, search text, the pills, the menu filters, and the archive setting. One shared animation of about 350 ms with a critically damped spring feel drives all cards. A new change during the animation starts from the current painted places. There is no motion at the first render, when the window is not mapped, when GNOME animations are off, or when the packing dimensions change (window size, column width, view). The motion is paint only: allocation, input, focus, and accessibility are at the final layout at all times. The shared hover highlight is cleared when a motion starts. The motion adds no permanent frame loop.
- Wheel scrolling uses one critically damped Libadwaita spring toward the target, with a continuous velocity. The damping ratio is 1. The spring settles in about 350 ms with no overshoot. The step per click is unchanged. Same-direction input adds to a clamped target; reversal starts from the visible position. Trackpad input stays direct and cancels wheel motion. GNOME animations off gives immediate feedback. Bounds, layout/filter/view changes, external scroll changes, unmap, and close cancel old targets. Unchanged refresh preserves active scroll; frames make no source reads and add no permanent loop.
- ASB pins come first in saved order. Other rows follow Pending, Working, Idle, then Unknown.
- Codex and Claude pills share the app menu filter. Working alone selects only Working through the state menu; turning it off restores all states. It is active only for that single-state selection. Working plus Pending shows Working or rows with Pending or visible ASB unread/question attention. Other state selections keep Pending as an AND filter. Provider, search, and archive checks still restrict the union; prefixes temporarily take priority over app selection.
- At start, no widget has the keyboard focus, so no text cursor blinks and repaints the window. The first Tab goes to the search field. Typing a printable key moves focus to the search field. Typing from a row starts search with no fixed delay. Escape clears the query and prefix. Queued row focus restoration stops if focus has changed. Row menus have mouse and keyboard access; pin movement has a keyboard alternative. **Move pin earlier** and **Move pin later** move the pin before or after the adjacent visible pinned row, with search and filters applied. They send no request at the first or last visible pin.
- **App sources…** in the existing menu opens a native table and one editor. The table shows Enabled, name/app, session folder, launcher, and chat count/status. Add, Save, Remove, Cancel, Refresh, native path pickers, and a Color picker with four muted presets manage local registration. Default sources cannot be removed.
- The approved Soft dot sits at the lower-left of the existing provider icon in both views. Its 6px solid fill and 1px background rim make an 8px circle. This passive, unmeasured overlay appears only when that provider has multiple registered sources. Codex and Claude use the same rule; legacy or single-source rows hide it. Source names remain in search, tooltips, and accessible descriptions, so color is not the only identifier. Row geometry, borders, and provider pills stay unchanged.
- View/width changes preserve filters, search, pins, focus, and the outer frame. Keyboard focus reveals off-screen rows. Ordinary refresh preserves scroll position.
- Dark colors apply only to ASB. A color picker change selects Custom colors; Apply checks and saves the palette for the next start. Any valid six-digit divider color is accepted, including the background color. Dark background and text contrast checks stay in place. Loading or resetting pickers keeps the intended mode. Reset removes the saved custom theme and selects GNOME colors. Validation and save errors keep the previous theme. No global GNOME setting changes.
- Working time uses a stable source start (`workingSinceMs`) and a local two-second clock. Idle age labels update once a minute. Label updates do not read sources.
- Provider warnings hide after five seconds. The same warning stays hidden until it changes or clears. Dashboard fetch errors stay visible until a successful refresh. A background poll does not change the Refresh button. The button is insensitive only while a forced refresh is in flight or queued. A row action error leaves the row when the row state changes or when the row leaves the list.
- The empty-list text follows the list. **No desktop sessions found…** shows only when the dashboard has no sessions. A list with no match shows the search and filter text.

The application ID is `local.asb.AgentSwitchBoard`. The toolbar uses ASB's own disc icon. Codex and Claude row icons identify the original apps. The installer adds only ASB's launcher and icon. It adds no auto-start entry.

## Refresh and performance limits

Native and web clients poll every two seconds while any unarchived root is Working, otherwise every five seconds. This uses the full list before filters and continues when ASB loses focus. The clean server snapshot has a five-second TTL. With two-second polling, reconciliation can occur on the next tick after about six seconds. Cold scans and source write delay can take longer.

Source watchers send only a version, reason, and provider flags. They send no paths or content. Registered source folders and registry changes use these same watchers. Events are grouped for 250 milliseconds. Active scans start no more than once per two seconds. Missing directories and watch failures retry every five seconds. On Linux, ASB uses one watch for each directory under the session folders, not one for each file. It follows new and removed folders from `rename` events, with one `stat` for each event entry. It does a full directory walk only at start, when the list of watch paths changes, while coverage is incomplete (every five seconds), after a watcher error, when a watch root reports its own name, after a burst of more than 64 structure events, and every 60 seconds as a safety net. `performance.dashboard.watchWalks` counts these walks. Other platforms use the native recursive watch and fall back to directory watches. An injected `loadDashboard` with no source registry gets no default watch paths. Polling remains the fallback; profile registration adds no permanent fast poll.

Client reads do not overlap and retain at most one requested follow-up. A forced read (`/api/dashboard?force=1`) that arrives during a scan waits for that scan. It then gets one more scan that starts after the request. Forced requests during the same scan share that scan. A successful open marks the server snapshot dirty and sends a `dashboard` event with the reason `asb-open`; the next read scans again. In the clients, successful opens request a normal cached refresh and retain a follow-up if a read is already active. Each `200` reply of `GET /api/dashboard`, with or without `?force=1`, has an `ETag` header: a quoted SHA-256 content hash of all reply fields except `generatedAtMs` and `performance`. The dashboard replies also have `Cache-Control: no-store`. A request with `If-None-Match` equal to the current tag gets `304` with no body; a forced request still scans first. `performance.dashboard.notModified` counts these replies. The native window sends the tag of the list that it shows and does no work on a `304`. It clears the tag after an error and after a POST reply changed its list. The web view sends no tag and gets `200` as before. Native rows remain keyed by ID and update in place. A lazy row cache retains previously shown rows across search and filters, bounded by full dashboard IDs. Hidden rows have no clock work or Read feedback; current data, action state, time, view, and palette apply when they return. Layout signals replace permanent frame checks; IDs removed from the full dashboard and window close release row controllers.

The Codex, Claude, and normalization modules have one mode. The ASB view has no token, quota, artifact, model-service, or governance data. The Codex reader makes no network request, reads no `auth.json`, and writes no file. `AMC_CODEX_RESET_CREDITS` has no effect. There is only the Claude Desktop Code reader for Claude. Metadata fingerprints reuse unchanged records. Source events can invalidate caches even when file stats do not change. Codex and Claude signal caches have 5000-entry limits. The Claude directory index has a 32-root limit.

The remote reader keeps at most 32 cache roots, 50,000 classified file names per root, 512 response entries, and 5000 projected session records per root. Aggregate eviction preserves only the newest selected response chain so linked updates are not lost. Raw protected storage can reach `512 × 5000` records per root; its metric reports the actual raw count. Six concurrent readers inspect new keys and changed approved bodies. Encoded bodies are limited to 8 MiB and decoded bodies to 16 MiB. Unrelated cache writes do not reread old keys or bodies. Built-in zstd decoding is optional; gzip watch reads work on older supported Node.js versions.

Codex tails start at 64 KiB and grow to 256 KiB. On the first read of a log that is larger than the tail, ASB does not parse each line of the full log when the tail gives the lifecycle state. It searches the raw bytes before the tail for a real question call (a `function_call` named `request_user_input` or `request_user_input_async`) and reads lines only from such a call until the question state is clear again. The results are the same as a full scan. A log whose tail has no lifecycle event still gets the full scan. Lifecycle and question recovery can scan full logs with bounded memory and append checkpoints held in memory. Later reads continue from the saved offset. Claude transcript tails have an 8 MiB limit and use six concurrent reads. Larger Claude logs recover lifecycle and Agent links with bounded memory and an append checkpoint in the same signal cache. Local-command prefixes do not start new work. Broad no-path invalidation reuses unchanged lifecycle data, while targeted and equal-size rewrites retain safe invalidation. Unchanged child logs use cached signals. Retained history can still make cold reads slow. ASB writes no transcript or work-metric cache.

## API and trust boundary

ASB uses `createAsbServer` from `src/asb-server.mjs`. It allows the view assets, dashboard, source events, app-source settings, known-session open, ASB Read/Unread, pins, pin movement, and Persistent unread settings. Other API routes are not exposed.

Actions require the local Host and a matching Origin. App-source changes also need the app source token when the server has one (see below). Session IDs must be in the scanned list. Read/Unread and pin/unpin accept an empty JSON object. Persistent unread accepts only a `persistentUnread` boolean. Pin movement accepts `up`/`down`, or a known pinned target with `before`/`after`. Session actions accept no client commands, paths, or URLs.

Read APIs (dashboard, including forced refresh, sources, and events) accept an absent Origin or the exact local Origin. Sec-Fetch-Site must be absent, `same-origin`, or `none`. Cross-site reads return 403 before source loading. These access checks run before the `ETag` comparison of the dashboard. Native no-header requests and normal address-bar navigation remain supported; asset routes keep their existing behavior.

Malformed request URLs return 400 without stopping the server. Malformed JSON gives 400 on every action route. The open reply has no `resumeCommand`. The `?refresh=` alias is not available; use `?force=1`. The dashboard reply has no `performance.notifications`. It has the counters `performance.dashboard.watchWalks` and `performance.dashboard.notModified`. The native HTTP client converts incomplete responses and bad status lines into its normal failure callback, including incomplete source-error bodies. Failure text does not include partial response data, and loading/action latches can recover.

| App-source route | Contract |
| --- | --- |
| `GET /api/sources` | Registered sources, colors, compatibility profile metadata, chat counts/status, and the eight-source limit. Needs no token. |
| `POST /api/sources` | `{source: {...}}` with full `provider`, `label`, `dataDir`, `launcher`, and `enabled` fields. Include `id` to edit; omit it to add. Optional `color` uses `#RRGGBB`; optional `showMarker` is boolean. Claude can include `projectsDir`. Needs the header `X-ASB-Source-Token` when a token is set. |
| `POST /api/sources/<id>/remove` | Empty JSON object; default source removal is rejected. Needs the header `X-ASB-Source-Token` when a token is set. |
| `POST /api/threads/<id>/discard-result` | Empty JSON object; forces a source scan and requires a known Working row. Arms its current task once. |
| `POST /api/threads/<id>/keep-result` | Empty JSON object; uses the normal cached lookup and clears a known row's Discard arm without a forced scan. |

Providers are `codex` and `claude-desktop-code`. Paths must be absolute local paths; additional launchers must be supported installed executables. Source updates reject raw command, argument, environment, and unknown fields. They use the same Host and Origin protection as session actions.

A local program that is not a browser can send Host and Origin itself, and a source change can set the launcher that ASB runs. For this reason, the launcher gives the server and the window one random token for each run. When a token is set, `POST /api/sources` and `POST /api/sources/<id>/remove` need the header `X-ASB-Source-Token`. Without it, the reply is 403 with `Use app source actions from the ASB window.` The window sends the header only on app-source changes, and only when `ASB_SOURCE_TOKEN` is set. A server started with `npm start` has no token. These routes then have only the Host and Origin checks.

## Local writes

| Default location | Purpose |
| --- | --- |
| `~/.local/state/asb/pending.json` | ASB attention, pins, Persistent unread, and current-task Discard marks. |
| `~/.config/asb/layout.json` | Width and view. |
| `~/.config/asb/theme.json` | Custom colors. |
| `~/.config/asb/sources.json` | App-source IDs, labels, colors, dot visibility, paths, launchers, and enabled flags, with owner-only access. |
| `~/.local/share/applications/local.asb.AgentSwitchBoard.desktop` | Per-user launcher. |
| `~/.local/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg` | Per-user app icon. |

XDG state/config/data overrides apply. The per-user package also installs ASB under its own local data folder and adds `~/.local/bin/asb`. `~/.local/bin/asb` records `ASB_NODE` and starts the shipped `scripts/asb`. It keeps `ASB_NODE` when it is an absolute, executable regular file with no control characters; otherwise it records the current Node executable. Paths use shell quoting. If the recorded Node.js is not usable, `scripts/asb` tries `~/.local/bin/node`, `/usr/local/bin/node`, then `/usr/bin/node`. It prints a message if none is usable. ASB does not put system folders before the caller's `PATH`. It appends `/usr/local/bin:/usr/bin:/bin` and a recorded SQLite folder, so apps started from ASB keep the caller's `PATH` order. Uninstall removes the `asb/releases` and `asb` data folders when they are empty. SIGINT/SIGTERM abort package work, await pending writes and rollback, and remove only its acquired lock and staging folder. A foreign lock stays intact and the error identifies its folder. See the installer for its exact manifest. Original app stores stay read-only, with one exception: the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files next to it. The files `pending.json.bad` and `sources.json.bad` can appear next to their originals.

## Checks and release

```bash
npm test
python3 test/asb_native_logic_test.py
npm run build
```

The first two commands do not launch the ASB window. `npm test` needs no `sqlite3` command and no environment variable. Launcher checks use isolated HOME/XDG/source folders, `ASB_SYSTEM_INSTALL=1`, and `ASB_PYTHON=/bin/true` to verify busy/free ports without GTK or icon registration. Display-free data checks share the synthetic GTK fixtures through AST extraction without importing GTK. Native widget tests are separate and need a GTK display with synthetic fixtures. Use them only when UI testing is in scope. Do not use real session stores for public media or test captures.

Native SSE retains its connection/header timeout but removes the live read timeout after validated stream headers; close shuts down blocked reads. Row ages use relative text for all elapsed days, and empty `XDG_CONFIG_HOME` falls back to the home config folder. Row and tooltip indicator CSS share the same shape rules and keep their existing roles/sizes.

The source build produces `asb_1.5.0_all.deb`, `asb-1.5.0-linux.tar.gz`, and `SHA256SUMS` in `dist/`. The portable root is `asb-1.5.0/` with `./install.sh`. See [release notes](docs/releases/v1.5.0.md) for upgrades and check limits. Public demo assets use synthetic session names and folders. The current demo source shows four app switches; the existing README video link stays unchanged. Remotion build dependencies are separate from the ASB runtime.

The Node tests and the native logic tests pass. For ASB `1.5.0`, the GTK widget test file `test/asb_native_test.py` was run on one X11 machine: the window opens, four of its eight tests pass, including the new test for card motion, the wheel spring, and the column width, and four fail in the same way as with the 1.3.0 code because their expectations are older than the 1.3.0 layout. Card motion and the wheel spring were also measured on that display with synthetic rows. No Debian `apt install` was run. Native pixel fidelity remains unverified. See the [publication record](docs/OPEN_SOURCE_PLAN.md) for verified release checks.

## Origin and credit

ASB is based on [Agent Mission Control `0.6.0`](https://github.com/forxidian/agent-mission-control/releases/tag/v0.6.0) by forxidian. The original [MIT license](LICENSE) and [upstream release history](CHANGELOG.md#upstream-history) remain. The upstream dashboard, its related service code, and its documentation are removed from this repository. The readers keep no dashboard mode.
