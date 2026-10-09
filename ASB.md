# ASB user guide

ASB lists Codex and Claude Desktop Code chats. It also lists remote Code sessions observed in Claude's local cache. Select a row to open that chat in its original app. The Linux native window uses GTK and Libadwaita. ASB makes no model calls and does not send prompts.

See [README.md](README.md) for v1.5.0 packages and runtime requirements.

## Layout and search

**Compact** is the default. It has one 22-pixel line per chat. **Comfortable** has 68-pixel rows, with the app and folder above a two-line title. Both views read down each column, then across from left to right. Window height sets the row count. More chats continue to the right. Use the mouse wheel, trackpad, or Shift-wheel to scroll horizontally.

Mouse-wheel scrolling moves to its target with a spring. The speed stays continuous, the movement settles in about 350 ms, and it does not overshoot. Repeated wheel input adds distance; reverse input starts from the visible position. Trackpad scrolling stays direct. With GNOME animations off, wheel scrolling is immediate.

In Comfortable, one hover highlight moves between cards and columns in 200 ms. It fades in or out in 100 ms. Cards stay fixed. With GNOME animations off, the highlight changes immediately. Compact keeps its static hover.

When data or a filter changes the order or the set of visible cards, the cards move in both views. Each card that stays visible glides from its old place to its new place in about 350 ms. Each new card fades in. A card that leaves disappears at once. This applies to Read, a refresh with a new order, a pin move, search text, the pills, the menu filters, and the archive setting. A new change during the motion starts from the current painted places. There is no motion at start, when the window size, column width, or view changes, or with GNOME animations off. Pointer input, keyboard focus, and screen readers use the final layout at all times. The hover highlight clears when a motion starts.

Comfortable uses quiet title, folder, state, and age text for Idle chats with no ASB unread dot or Pending attention. Hover or keyboard focus restores normal text. Pins and provider marks keep their normal strength. Source read status does not change this rule.

Hover a row to see the Unfolded card tooltip in either view. It shows the full folder path and title, then the current state/time and app/source. Paths below your home folder use `~`. Long text wraps. One short note explains the current indicator; pin/archive/link flags and the current row error appear only when needed. The profile dot uses the same rule as the row. Read historical failures do not show a failed-unread note. Screen readers also receive the original full path, state reason, and source identity. The native tooltip frame and control tooltips stay unchanged.

Tooltip queries use current time and row data. Unchanged content is reused; changed text, profile or theme rebuilds it without a source read. Theme changes clear hidden-row tooltip caches too.

Drag a column divider to change the width of all columns. The menu also has **Column width** (160–600 pixels) and **Reset width**. The default is 240 pixels. Columns keep the shared width when the list has fewer columns than the window can show, for example in search results. A view change keeps your search, filters, pins, and focused chat. Keyboard navigation reveals a focused row when it is outside the visible area.

Search names, folders, or app-source names. Results update when the text changes. A row title has at most 300 characters; a longer title ends with `…`. Codex can store a full prompt as a title. Search matches the limited title, and the tooltip shows it. Claude Desktop Code titles keep their own shorter limit. A leading `cl:` or `claude:` selects Claude. A leading `cx:` or `codex:` selects Codex. Prefixes ignore case and permit spaces. A prefix alone lists that app. A prefix takes priority over the app filter while it is present. The other filters still apply. Unknown prefixes remain literal search text.

At start, no control has the keyboard focus. Type a printable key to enter search; the first Tab also goes to the search field. Type from a chat row to enter search. Escape clears the search and its prefix. Explicit filters stay set. Native popups and Ctrl/Alt/Super shortcuts keep their normal keys.

## Filters and pins

Use the **Codex**, **Claude**, **Pending**, and **Working** toolbar pills. No selected app means all apps; both app pills mean their union. The menu uses the same app selection. **Working** alone selects only Working; turn it off to restore all states. It shares the state menu and is active only when Working is the sole selected state. **Pending** alone shows Pending chats. Together, **Working** and **Pending** show Working or chats with Pending or an ASB unread dot. App, search, and archive filters still apply. The state menu has independent **Working**, **Waiting**, **Idle**, and **Unknown** choices. Other state combinations keep Pending as an AND filter. **All states** selects all. **Clear states** hides all rows until you select a state. Archived chats are hidden by default.

ASB pins come first in their saved order. Unpinned chats follow: Pending, Working, Idle, then Unknown. Right-click a row, or use Menu or Shift+F10, to **Pin** or **Unpin** it. Drag a pinned row onto another pin to change the order. **Move pin earlier** and **Move pin later** provide the same control from the keyboard. They move the pin before or after the adjacent visible pinned row, with search and filters applied. They do nothing at the first or last visible pin. Hidden pins keep their place in the saved order.

In Comfortable, the top-right pin appears on row hover or keyboard focus. A pinned control stays visible. Select it to **Pin** or **Unpin** without opening the chat. Pinned chats use the saved pin order; unpinned chats return to the normal state order.

ASB does not import or write pins in the original apps.

## State, attention, and working time

| State | Local evidence |
| --- | --- |
| Working | An open task or request with recent activity. |
| Waiting | A current user action is required. |
| Idle | The last task or response ended. |
| Unknown | The source signal is missing or too old. |

An unarchived chat is not proof that it is Working. An open task with no activity for six hours becomes Unknown. Source writes, cold scans, and app crashes can delay or limit the evidence.

A Claude root stays Working while a recent child Agent linked by its launch is active, even after the root response ends. The child count includes files under that root. Only linked child lifecycle changes execution. Each non-empty Claude user reply starts a task, including `ok`, `y`, `1`, `.`, and `继续`. Local command records do not. A linked child with missing or stale signals can give Unknown. Attention waits for the group to finish. Its last end decides whether the task completed, failed, or stopped. A later end takes priority over an older failure.

Working time uses the current task or request start, when known. A local two-second clock updates the text without reading the source again. Compact shows the duration beside Working. Comfortable shows it at the right. Missing starts and other states have no running timer. Below one hour, the label includes seconds. Longer durations show hours and minutes.

**Pending** means attention, not an execution state. Each visible dot or `?` counts as Pending. A row keeps its Working, Waiting, Idle, or Unknown label when its indicator appears. A question or current permission wait shows a `?` instead of the dot. A stop square does not count as Pending.

- Codex native unread marks use only the identity and local host that match its SQLite creator metadata. Missing, corrupt, or unmatched read data means Unknown read status. ASB does not read credentials to find the identity.
- A Working chat is never unread. While a chat is Working, ASB hides its dot and shows only a `?` for a question. Saved Unread, native, completion, failure, and retained marks stay stored and show again when Working ends. A visible native unread dot also puts an Unknown row in Pending-only.
- Local Claude chats have no reliable native unread mark. Cached remote records can provide an unread mark. ASB can also add a completion dot when it observes a Working-to-Idle change with a new completion. This dot is an ASB observation. A task that goes Working, Waiting, then Idle also gets its completion or failure dot. The first scan does not mark historical Idle chats Pending.
- Current synchronous `request_user_input` questions can show Waiting. Async questions add attention while the real Working or Idle state stays visible. Real human input supersedes old questions. A pending Claude `AskUserQuestion` shows Waiting with the `?`. It stays Working with the `?` only while a linked child Agent has recent work and no other permission request is pending. ASB sends no question or answer text to the view.
- Claude permission tools, pending `ExitPlanMode`, and fresh remote `requires_action` show Waiting with a passive `?` until resolved in Claude. Read and successful opens cannot clear this wait. Pin stays available. A pending Claude permission, plan approval, or question tool gives Waiting and Pending only for six hours after its tool event. After that, the usual rules apply, and an old open task gives Unknown.
- A stopped root or group shows Idle with a small muted square, including historical stops. It adds no unread mark. New work or a later end removes the square. Existing question or unread attention has priority.
- A terminal failure shows Idle. With unknown native read state, a failed-task dot requires an observed Working-to-Idle change and a new failure. Historical failures get no new dot on first load. Codex uses non-null `task_complete.error`; Claude uses terminal `result.is_error`, a linked failed task notification, or fresh remote session `failed`. Ordinary tool errors and interruptions are not task failures. Native read truth keeps its own rule.
- Codex approval wait remains unsupported. ASB has no reliable unanswered approval signal in its local file sources and does not read the app-server `waitingOnApproval` flag.

## Read and Unread

Right-click a row, or use Menu or Shift+F10. The menu offers **Read** for an ASB dot or question attention and **Unread** when neither is present. A current permission wait has no Read action. A passive stop square can still be marked Unread.

**Unread** adds an ASB mark and includes the chat in Pending-only. It survives read changes in the original app. **Read** clears ASB attention. Neither action changes execution or the original chat store.

In Comfortable, select the dot or question-attention `?` beside the top-right pin to **Read**. A permission-wait `?` or stop square is passive, with no Read action or check cue. A successful Read shows a check for 1.6 seconds. A failed action keeps the dot and puts the error in the row tooltip. The error leaves the row when the row state changes or when the row leaves the list. This control works with or without **Persistent unread**. It does not open the chat or resolve a source question. New attention replaces old feedback.

By default, a successful open acknowledges manual, native, completion, failure, and question attention in ASB. A failed open keeps the attention. An acknowledgment does not answer a question, clear a permission wait, or change a stopped outcome. A new question, completion, failure, or native Read-to-Unread cycle can add new attention.

## Discard result

Use **Discard result** while a task is Working to skip its next successful result dot. In Comfortable, point at the row or use keyboard focus to show the dashed hollow dot beside Pin. Select it to turn Discard on. The solid hollow dot stays visible. Select it again for **Keep result**. Compact keeps the Working timer and shows only the passive armed ring; use the row menu to change it. Working row menus provide both actions in either view.

Discard applies to this task once. A verified successful group end goes to read Idle without new result attention, even with Persistent unread on. The next task uses normal rules. It does not clear manual Unread, questions, or earlier failed-task attention. A failed end still gets its normal dot; cancellation still gets the stop square. A question has priority over the ring and keeps its normal Read or permission-wait behavior. Discard changes no state, Pending filter, pin order, or source-app read flag.

Reading a Working question returns directly to the Discard ring. It shows no Read confirmation check. Idle and Waiting Read confirmation stay unchanged. A new Working row without a question clears old Read feedback.

Discard stays stored during Waiting and Unknown. Any observed Idle clears it. A root ending while its linked child works keeps it armed; a proven new root task clears the old arm. A follow-up message in an armed Claude task does not cancel Discard. Only a task that starts after an end later than the arm cancels it. ASB uses recorded starts and ends, not the changing Working timer.

Discard checks the current source before arming. Keep uses the normal cache and adds no forced scan. If task A ends and task B starts and ends before a late click, cached A can still look Working; the Discard scan rejects the current Idle row. A task already armed before both ends can still affect B because the local reader retains only the latest end. ASB does not add history or infer a missing result.

A native unread mark for the discarded success can arrive late. ASB suppresses the first matched episode and preserves later observed Read-to-Unread cycles. A source-app manual Unread that is the first mark for the same completion can also be suppressed. Remote cache limits still apply: generic Idle without a terminal timestamp clears the arm but cannot safely suppress native attention. A remote end and new run missed between scans can leave Discard armed. ASB does not infer a missing task identity.

**Persistent unread** is off by default. Turn it on to keep ASB attention after source Read, question resolution, completion, and successful opens. Choose **Read** to clear it. Turning the setting off keeps existing dots and restores acknowledgment on successful opens. Retained marks follow the Working rule above: they are hidden while the chat is Working. Every visible retained dot counts as Pending.

All ASB clients share this attention and pin state. Filters do not limit what the tracker observes.

## Theme and local settings

ASB uses dark mode only in its own window. **GNOME colors** uses your current background, text, and accent colors. **Custom colors** lets you set background, text, accent, muted text, and divider colors. Divider color has no contrast limit. Changing a color selects **Custom colors**. Select **Apply theme** to check the dark background and text contrast, apply the colors, and save them for the next start. A validation or save error keeps the previous theme. **Reset to GNOME** removes the custom theme and resets the pickers. ASB does not change global GNOME settings.

| File | Contents |
| --- | --- |
| `$XDG_STATE_HOME/asb/pending.json` | Attention history, Read/Unread marks, pins, Persistent unread, and current-task Discard. |
| `$XDG_CONFIG_HOME/asb/layout.json` | Column width and selected view. |
| `$XDG_CONFIG_HOME/asb/theme.json` | Custom colors. |
| `$XDG_CONFIG_HOME/asb/sources.json` | App-source names, colors, dot visibility, folders, launchers, and enabled flags. |

With no XDG override, state uses `~/.local/state` and config uses `~/.config`. An empty `XDG_CONFIG_HOME` also uses `~/.config`. A width-only layout file loads Compact. Reset width keeps the selected view. The attention and source settings files have owner-only access. When ASB cannot use `pending.json` in full, it shows the Pending state warning and moves the old file to `pending.json.bad` before the first save. An older `.bad` file is replaced. The same rule applies to `sources.json` (`sources.json.bad`) before the next source update or remove. The warning that ASB cannot save Pending state clears after the next good save.

The application ID is `local.asb.AgentSwitchBoard`. Per-user installation registers only ASB's own launcher and icon. It creates no auto-start entry. See [icon provenance](assets/icons/ASB-disc-provenance.md).

## App sources

Open **App sources…** in the menu to add or edit local Codex and Claude profiles. The native table shows Enabled, name/app, session folder, **Open with**, and chat count/status. Select a source to edit it, or choose **Add**. Use **Choose…** for folders and the installed app launcher, then **Save**. **Cancel** discards form edits; **Refresh** reloads the table. ASB supports eight registered sources, including the two defaults.

| Field | Select |
| --- | --- |
| App | Codex or Claude Desktop Code. |
| Name | A short profile name, such as Work. |
| Profile color | The source marker color, with a picker and four muted presets. |
| Show profile dot | Show or hide this profile's dot. Its saved color stays available. |
| Session folder (Codex) | That profile's `CODEX_HOME`, such as `~/.codex-work`, with `state_N.sqlite`. |
| Session folder (Claude) | That app profile's folder, such as `~/.config/Claude-Work`, with `claude-code-sessions` or `Cache`. |
| Open with | The supported installed launcher that opens this profile. Default sources can use the default app link handler. |
| Transcript folder (Claude) | That profile's local transcript folder; empty uses `~/.claude/projects`. |
| Enabled | Include this source in ASB reads and the chat list. |

The default Codex and Claude sources can be edited or disabled, but not removed. **Remove** unregisters an additional source. Disable and Remove do not delete source files or saved ASB attention, pins, unread marks, and settings. One store cannot be added twice. A missing or failed source does not hide other profiles.

A second ChatGPT/Codex login needs its own local profile data and installed profile launcher. Profiles can share one app binary if their `CODEX_HOME` and Electron profile folders are separate. On first use, when `sources.json` is absent, ASB registers the known ChatGPT Personal profile if its local store and launcher exist. ASB does not sign in, copy credentials, or change the original apps' URL handlers. A ChatGPT-labeled source shows local Codex coding chats, not ordinary ChatGPT cloud chat history. Use the same source table for additional Claude instances.

When an app has multiple registered sources, a Soft dot appears at the lower-left of its icon in both views. It uses the source color and has no action. Clear **Show profile dot**, then **Save**, to hide only this profile's dot. This keeps the source enabled, its saved color, and its state and unread marks. Legacy rows and apps with one registered source hide it. Profile numbers are not visible. The source name remains in the tooltip, accessible description, and search. The Codex and Claude pills still select all sources for that app.

Choose **Profile color** in the source editor, then **Save**. The presets are Slate blue (`#8296b4`), Clay (`#b28f80`), Plum (`#a28caa`), and Sage (`#899e91`). ASB saves any valid six-digit hex color, including dark colors. The display can lighten the marker to keep 3:1 contrast without changing the saved color. A successful save shows **Saved**; an error keeps the form for correction. Old source settings get a stable default color and show the dot. Color identifies the source only; it does not change state, unread marks, chat identity, or original app styles.

## Start and stop

Installed packages launch with `asb` or the ASB Applications entry. The per-user command `~/.local/bin/asb` starts the shipped `scripts/asb`. If the recorded Node.js is not usable, `scripts/asb` tries `~/.local/bin/node`, `/usr/local/bin/node`, then `/usr/bin/node`, and prints a message if none is usable. ASB appends `/usr/local/bin:/usr/bin:/bin` to the caller's `PATH`, so apps started from ASB keep the caller's `PATH` order. From source:

```bash
npm run desktop
```

The initial window is about 420×900 pixels. Closing it stops the backend that the launcher started. An icon registration error stays visible, but the window still opens. A source run keeps an installed GNOME entry and reports the conflict. It replaces a source-run entry, including one from another checkout. A busy port produces an error; ASB does not attach to another server. Use `PORT=4630 npm run desktop` to select a different port.

The optional browser view starts with `npm start` at [http://127.0.0.1:4629/](http://127.0.0.1:4629/). Both modes bind only to `127.0.0.1`. `HOST` does not change the address.

Default Codex opens use `codex://threads/<id>`. Default Claude opens use `claude://code/continue?session=local_<uuid>` for local chats and `claude://code/<id>` for validated `cse_` or `session_` remote IDs. The apps must handle these links. An additional source's installed launcher receives the validated link for that profile. Invalid Claude local IDs remain visible with the open action disabled. Opens run in the background. **Opening…** appears in the row; a failure adds details to its tooltip.

## Refresh and data limits

Both clients poll every two seconds while any unarchived root chat is Working, otherwise every five seconds. This uses the full list before filters. Monitoring continues when another app has focus. Source-change events can start a read sooner. The shared clean snapshot lasts five seconds, so a two-second poll can reconcile after about six seconds. Cold scans and source write delays can take longer.

Reads do not overlap. On Linux, ASB uses one watch for each directory under the session folders. It follows new and removed folders from the watcher events. It walks all session folders again only at start, when the source list changes, while a watch is missing, after a watcher error or a large burst of folder changes, and every 60 seconds. When a read brings no change, the native window gets a `304` reply and does no list work. A background poll does not change the Refresh button; the button is inactive only during a refresh that you requested. Polling remains the fallback when a watcher or event stream fails. Rows stay keyed by chat ID and update in place. Activity alone does not rewrite ASB state.

By default, ASB reads the latest `~/.codex/state_N.sqlite` in read-only mode, `session_index.jsonl`, matched `.codex-global-state.json` read marks, and rollout lifecycle signals. On Linux, Claude metadata comes from `$XDG_CONFIG_HOME/Claude/claude-code-sessions` or `~/.config/Claude/claude-code-sessions`. Only `local_*.json` metadata is used. Matched transcripts come from `~/.claude/projects`. Registered profiles use their selected folders and the same readers, source-change events, and polling fallback.

Remote Code metadata comes from approved session-list and watch response bodies in Claude's `Cache/Cache_Data`. ASB uses the newest cached response and exact cursor-linked updates. A watch without a full list contains only observed sessions; the source warning states this limit. The cache can be incomplete or old, including while Claude is closed. ASB does not fetch the remote list. Working and Waiting require an explicit worker state and a response observation within six hours. Missing state or a disconnected Remote Control bridge gives Unknown. Cloud sessions do not need a bridge connection. Remote work has no inferred start time or local folder; a safe cached Git repository name can identify the project.

Root chats are the list unit. Internal subagents stay grouped under their root. Reads are limited to 5000 records per source. ASB does not include orphan Codex rollouts that are absent from its local database.

Codex tail reads start at 64 KiB and grow to 256 KiB. On the first read of a larger log, ASB searches the bytes before the tail for question calls and reads lines only from such a call. When the tail has no lifecycle event, lifecycle and question checks scan the full log with bounded memory. Claude uses an 8 MiB transcript tail with lifecycle checks when needed. Large retained histories can make the first scan slow. In-memory caches reuse unchanged metadata and bound stored entries. No transcript checkpoint file is written by ASB.

See [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) for source modules and [Privacy](docs/PRIVACY.md) for the full data boundary.
