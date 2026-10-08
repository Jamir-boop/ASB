# ASB user guide

ASB lists Codex and Claude Desktop Code chats. It also lists remote Code sessions observed in Claude's local cache. Select a row to open that chat in its original app. The Linux native window uses GTK and Libadwaita. ASB makes no model calls and does not send prompts.

See [README.md](README.md) for v1.2.0 packages and runtime requirements.

## Layout and search

**Compact** is the default. It has one 22-pixel line per chat. **Comfortable** has 68-pixel rows, with the app and folder above a two-line title. Both views read down each column, then across from left to right. Window height sets the row count. More chats continue to the right. Use the mouse wheel, trackpad, or Shift-wheel to scroll horizontally.

Drag a column divider to change the width of all columns. The menu also has **Column width** (160–600 pixels) and **Reset width**. The default is 240 pixels. A view change keeps your search, filters, pins, and focused chat. Keyboard navigation reveals a focused row when it is outside the visible area.

Search names or folders. A leading `cl:` or `claude:` selects Claude. A leading `cx:` or `codex:` selects Codex. Prefixes ignore case and permit spaces. A prefix alone lists that app. A prefix takes priority over the app filter while it is present. The other filters still apply. Unknown prefixes remain literal search text.

Type from a chat row to enter search. Escape clears the search and its prefix. Explicit filters stay set. Native popups and Ctrl/Alt/Super shortcuts keep their normal keys.

## Filters and pins

Use the **Codex**, **Claude**, and **Pending** toolbar pills. No selected app means all apps; both app pills mean their union. The menu uses the same app selection. The state menu has independent **Working**, **Waiting**, **Idle**, and **Unknown** choices. **All states** selects all. **Clear states** hides all rows until you select a state. Archived chats are hidden by default.

ASB pins come first in their saved order. Unpinned chats follow: Pending, Working, Idle, then Unknown. Right-click a row, or use Menu or Shift+F10, to **Pin** or **Unpin** it. Drag a pinned row onto another pin to change the order. **Move pin earlier** and **Move pin later** provide the same control from the keyboard. Hidden pins keep their place in the saved order.

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

A Claude root stays Working while a recent child Agent linked by its launch is active, even after the root response ends. The child count includes files under that root. Only linked child lifecycle changes execution. A linked child with missing or stale signals can give Unknown. The completion dot waits for the group to finish; interruption and error do not add a completion dot.

Working time uses the current task or request start, when known. A local two-second clock updates the text without reading the source again. Compact shows the duration beside Working. Comfortable shows it at the right. Missing starts and other states have no running timer. Below one hour, the label includes seconds. Longer durations show hours and minutes.

**Pending** means attention, not an execution state. A row keeps its Working, Waiting, Idle, or Unknown label when its dot appears.

- Codex native unread marks use only the identity and local host that match its SQLite creator metadata. Missing, corrupt, or unmatched read data means Unknown read status. ASB does not read credentials to find the identity.
- A native unread dot can appear while Codex is Working. Native unread alone does not put a Working or Unknown row in Pending-only.
- Local Claude chats have no reliable native unread mark. Cached remote records can provide an unread mark. ASB can also add a completion dot when it observes a Working-to-Idle change with a new completion. This dot is an ASB observation. The first scan does not mark historical Idle chats Pending.
- Current synchronous `request_user_input` questions can show Waiting. Async questions add attention while the real Working or Idle state stays visible. Real human input supersedes old questions. ASB sends no question or answer text to the view.

## Read and Unread

Right-click a row, or use Menu or Shift+F10. The menu offers **Read** when the row has an ASB dot and **Unread** when it has none.

**Unread** adds an ASB mark and includes the chat in Pending-only. It survives read changes in the original app. **Read** clears ASB attention. Neither action changes execution or the original chat store.

In Comfortable, select the dot beside the top-right pin to **Read**. A successful action shows a check for 1.6 seconds. A failed action keeps the dot and puts the error in the row tooltip. This control works with or without **Persistent unread**. It does not open the chat or resolve a source question. New attention replaces old feedback.

By default, a successful open acknowledges manual, native, completion, and question attention in ASB. A failed open keeps the attention. An acknowledgment does not answer a question or cancel the source task. A new question, completion, or native Read-to-Unread cycle can add new attention.

**Persistent unread** is off by default. Turn it on to keep ASB attention after source Read, question resolution, completion, and successful opens. Choose **Read** to clear it. Turning the setting off keeps existing dots and restores acknowledgment on successful opens. Native unread alone on Working or Unknown keeps the Pending-only rule above.

All ASB clients share this attention and pin state. Filters do not limit what the tracker observes.

## Theme and local settings

ASB uses dark mode only in its own window. **GNOME colors** uses your current background, text, and accent colors. **Custom colors** lets you set background, text, accent, muted text, and divider colors. **Apply theme** checks the dark background and text contrast, then saves. **Reset to GNOME** removes the custom theme. ASB does not change global GNOME settings.

| File | Contents |
| --- | --- |
| `$XDG_STATE_HOME/asb/pending.json` | Attention history, Read/Unread marks, pins, and Persistent unread. |
| `$XDG_CONFIG_HOME/asb/layout.json` | Column width and selected view. |
| `$XDG_CONFIG_HOME/asb/theme.json` | Custom colors. |

With no XDG override, state uses `~/.local/state` and config uses `~/.config`. A width-only layout file loads Compact. Reset width keeps the selected view. The attention state file has owner-only access.

The application ID is `local.asb.AgentSwitchBoard`. Per-user installation registers only ASB's own launcher and icon. It creates no auto-start entry. See [icon provenance](assets/icons/ASB-disc-provenance.md).

## Start and stop

Installed packages launch with `asb` or the ASB Applications entry. From source:

```bash
npm run desktop
```

The initial window is about 420×900 pixels. Closing it stops the backend that the launcher started. A busy port produces an error; ASB does not attach to another server. Use `PORT=4630 npm run desktop` to select a different port.

The optional browser view starts with `npm start` at [http://127.0.0.1:4629/](http://127.0.0.1:4629/). Both modes bind only to `127.0.0.1`. `HOST` does not change the address.

Codex must handle `codex://threads/<id>`. Claude Desktop must handle `claude://code/continue?session=local_<uuid>` for local chats and `claude://code/<id>` for validated `cse_` or `session_` remote IDs. Invalid Claude local IDs remain visible with the open action disabled. Opens run in the background. **Opening…** appears in the row; a failure adds details to its tooltip.

## Refresh and data limits

Both clients poll every two seconds while any unarchived root chat is Working, otherwise every five seconds. This uses the full list before filters. Monitoring continues when another app has focus. Source-change events can start a read sooner. The shared clean snapshot lasts five seconds, so a two-second poll can reconcile after about six seconds. Cold scans and source write delays can take longer.

Reads do not overlap. Polling remains the fallback when a watcher or event stream fails. Rows stay keyed by chat ID and update in place. Activity alone does not rewrite ASB state.

ASB reads the latest `~/.codex/state_N.sqlite` in read-only mode, `session_index.jsonl`, matched `.codex-global-state.json` read marks, and rollout lifecycle signals. On Linux, Claude metadata comes from `$XDG_CONFIG_HOME/Claude/claude-code-sessions` or `~/.config/Claude/claude-code-sessions`. Only `local_*.json` metadata is used. Matched transcripts come from `~/.claude/projects`.

Remote Code metadata comes from approved session-list and watch response bodies in Claude's `Cache/Cache_Data`. ASB uses the newest cached response and exact cursor-linked updates. A watch without a full list contains only observed sessions; the source warning states this limit. The cache can be incomplete or old, including while Claude is closed. ASB does not fetch the remote list. Working and Waiting require an explicit worker state and a response observation within six hours. Missing state or a disconnected Remote Control bridge gives Unknown. Cloud sessions do not need a bridge connection. Remote work has no inferred start time or local folder; a safe cached Git repository name can identify the project.

Root chats are the list unit. Internal subagents stay grouped under their root. Reads are limited to 5000 records per source. ASB does not include orphan Codex rollouts that are absent from its local database.

Codex tail reads start at 64 KiB and grow to 256 KiB. When needed, lifecycle and question checks scan full logs with bounded memory. Claude uses an 8 MiB transcript tail with lifecycle checks when needed. Large retained histories can make the first scan slow. In-memory caches reuse unchanged metadata and bound stored entries. No transcript checkpoint file is written by ASB.

See [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) for source modules and [Privacy](docs/PRIVACY.md) for the full data boundary.
