# ASB user guide

ASB lists Codex and Claude Desktop Code chats. It also lists remote Code sessions observed in Claude's local cache. Select a row to open that chat in its original app. The Linux native window uses GTK and Libadwaita. ASB makes no model calls and does not send prompts.

See [README.md](README.md) for v1.8.1 packages and runtime requirements.

## Layout and search

**Compact** is the default. It has one line of about 22 pixels per chat. **Comfortable** has rows of about 68 pixels, with the app and folder above a two-line title. Both views read down each column, then across from left to right. Window height and the row height with your font set the row count. More chats continue to the right. Use the mouse wheel, trackpad, or Shift-wheel to scroll horizontally.

Mouse-wheel scrolling moves to its target with a spring. The speed stays continuous, the movement settles in about 350 ms, and it does not overshoot. Repeated wheel input adds distance; reverse input starts from the visible position. Trackpad scrolling stays direct. With GNOME animations off, wheel scrolling is immediate.

In Comfortable, one hover highlight moves between cards and columns in 200 ms. It fades in or out in 100 ms. Cards stay fixed. With GNOME animations off, the highlight changes immediately. Wheel scrolling clears the shared highlight once and keeps it off during the spring. Motion from a stationary pointer afterward does not restart it. Move the pointer again to restore the glide. Native row hover and keyboard focus still work. Compact keeps its static hover.

When data or a filter changes the order or the set of visible cards, the cards move in both views. Each card that stays visible glides from its old place to its new place in about 350 ms. Each new card fades in. A card that leaves disappears at once. This applies to Read, a refresh with a new order, a pin move, a card that goes in or out of the drawer, search text, the pills, the Preferences filters, and the archive setting. A new change during the motion starts from the current painted places. There is no motion at start, when the window size, column width, or view changes, or with GNOME animations off. Pointer input, keyboard focus, and screen readers use the final layout at all times. The hover highlight clears when a motion starts.

A message between two visible sessions shows as a short accent light that flies from the sender card's provider icon to the receiver card's provider icon in 480 to 900 ms, with a small ring on arrival. When the receiver is out of view, an edge mark flashes when the light reaches the viewport edge and no ring shows; when both cards are out of view, nothing plays. Only new messages from the last 30 s play, at most 6 at a time, and nothing plays at start; with GNOME animations off, both provider icons show the accent color for 2 s instead.

Comfortable uses quiet title, folder, state, and age text for Idle chats with no ASB unread dot or Pending attention. Hover or keyboard focus restores normal text. Pins and provider marks keep their normal strength. Source read status does not change this rule.

Hover a row to see the Unfolded card tooltip in either view. It shows the full folder path and title, then the current state/time and app/source. Paths below your home folder use `~`. Long text wraps. One short note explains the current indicator; pin/archive/drawer/link flags and the current row error appear only when needed. The profile dot uses the same rule as the row. Read historical failures do not show a failed-unread note. A chat in the drawer has the flag **In the drawer** and keeps its normal unread note. Its accessible label ends with "In the drawer. Still unread." Screen readers also receive the original full path, state reason, and source identity. The native tooltip frame and control tooltips stay unchanged.

Tooltip queries use current time and row data. Unchanged content is reused; changed text, profile or theme rebuilds it without a source read. Theme changes clear hidden-row tooltip caches too.

Drag a column divider to change the width of all columns. **Appearance** in Preferences also has **Column width** (160–600 pixels) and **Reset width**. The default is 240 pixels. Columns keep the shared width when the list has fewer columns than the window can show, for example in search results. A view change keeps your search, filters, pins, and focused chat. Keyboard navigation reveals a focused row when it is outside the visible area.

Search names, folders, or app-source names. Results update when the text changes. A row title has at most 300 characters; a longer title ends with `…`. Codex can store a full prompt as a title. Search matches the limited title, and the tooltip shows it. Claude Desktop Code titles keep their own shorter limit. A leading `cl:` or `claude:` selects Claude. A leading `cx:` or `codex:` selects Codex. Prefixes ignore case and permit spaces. A prefix alone lists that app. A prefix takes priority over the app filter while it is present. The other filters still apply. Unknown prefixes remain literal search text.

The toolbar stays in one row. The disc is at the left; Preferences and native Close stay at the right. Extra pills and filter chips scroll horizontally. At 680 pixels or more, the search field and Refresh button are visible. Below that width, select Search or type to open the search popover; Refresh is in Preferences > Sessions. Below 320 pixels, the disc and toolbar Search button are hidden. Typing or **Find a session or folder** in Preferences still opens search. At start, no control has keyboard focus. Escape clears the query and prefix and closes narrow search. Explicit filters stay set. Native popups and Ctrl/Alt/Super shortcuts keep their normal keys.

## Filters and pins

Use the **Pending**, **Working**, and **Drawer** toolbar pills. **Show app pills** in Preferences > Sessions is off by default. Turn it on to show **Codex** and **Claude**; narrow windows use app icons. The App field stays available when the pills are hidden. Hiding pills keeps the active app filter. No selected app means all apps; both app pills mean their union. **Sessions** in Preferences uses the same app selection. **Working** alone selects only Working; turn it off to restore all states. It shares the state choices in **Sessions** and is active only when Working is the sole selected state. **Pending** alone shows Pending chats. Together, **Working** and **Pending** show Working or chats with Pending or an ASB unread dot. App, search, and archive filters still apply. **Sessions** has independent **Working**, **Waiting**, **Idle**, and **Unknown** choices. Other state combinations keep Pending as an AND filter. **All** selects all. **Clear** hides all rows until you select a state. Archived chats are hidden by default. **Drawer** shows only the chats in the drawer; see [The drawer](#the-drawer). It combines with the app pills, search, the state filters, and the archive setting. It does not combine with **Pending**: turning one on turns the other off.

Filters have a toolbar chip with a × button when no visible pill already controls them. Working alone uses the Working pill; it has no duplicate chip. A single App selection has a chip only when app pills are hidden. Other restricted state sets have a chip with the selected states, or **No states**. Clear a chip to reset only that group: App to all apps, states to all states, or **Include archived** to off. Search prefixes still take priority over the app filter. Persistent unread and Show app pills have no filter chips. The main view has no numeric counters.

ASB pins come first in their saved order. Unpinned chats follow: Pending, Working, Idle, then Unknown. A Working chat sorts by the start of its current task, so it does not move while it works. A Working chat with no known start comes after the Working chats that have one. In the Pending group, Working chats with a question come first, by task start; the other Pending chats follow by newest activity. A card moves when its state or group changes or a new task starts. Right-click a row, or use Menu or Shift+F10, to **Pin** or **Unpin** it. Drag a pinned row onto another pin to change the order. **Move pin earlier** and **Move pin later** provide the same control from the keyboard. They move the pin before or after the adjacent visible pinned row, with search and filters applied. They do nothing at the first or last visible pin. Hidden pins keep their place in the saved order.

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

A Claude root stays Working while a recent child Agent linked by its launch is active, even after the root response ends. The child count includes files under that root. Only linked child lifecycle changes execution. When a linked child log ends before its task notification reaches the root, the chat stays Working for up to 10 seconds. Each non-empty Claude user reply starts a task, including `ok`, `y`, `1`, `.`, and `继续`, and also a prompt with only images. A delivered task notification starts a task, because Claude replies to it; a stopped or killed task's notification does not. A message from another session starts a task in an idle chat. Local command records do not. A linked child with missing or stale signals can give Unknown. Attention waits for the group to finish. Its last end decides whether the task completed, failed, or stopped. A later end takes priority over an older failure.

Working time uses the current task or request start, when known. A local two-second clock updates the text without reading the source again. Compact shows the duration beside Working. Comfortable shows it at the right. Missing starts and other states have no running timer. Below one hour, the label includes seconds. Longer durations show hours and minutes.

When a usage limit stops a chat, its row is grey and shows a clock with **Resets in** and a countdown (Compact: **Resets 4h32m**; from 24 hours on, days and hours such as **Resets 3d4h**). The row is not Pending; at the reset time it becomes a normal Idle row, and the tooltip shows the reset time, with the weekday when the reset is on another day.

**Pending** means attention, not an execution state. Each visible dot or `?` counts as Pending. A row keeps its Working, Waiting, Idle, or Unknown label when its indicator appears. A question or current permission wait shows a `?` instead of the dot. A stop square does not count as Pending.

- Codex native unread marks use only the identity and local host that match its SQLite creator metadata. Missing, corrupt, or unmatched read data means Unknown read status. ASB does not read credentials to find the identity.
- A Working chat is never unread. While a chat is Working, ASB hides its dot and shows only a `?` for a question. Saved Unread, native, completion, failure, and retained marks stay stored and show again when Working ends. A visible native unread dot also puts an Unknown row in Pending-only.
- Local Claude chats have no reliable native unread mark. Cached remote records can provide an unread mark. ASB can also add a completion dot when it observes a Working-to-Idle change with a new completion. This dot is an ASB observation. A task that goes Working, Waiting, then Idle also gets its completion or failure dot. The first scan does not mark historical Idle chats Pending.
- Current synchronous `request_user_input` questions can show Waiting. Async questions add attention while the real Working or Idle state stays visible. Real human input supersedes old questions. A pending Claude `AskUserQuestion` shows Waiting with the `?`. A Claude Desktop wrap-up (`mcp__ccd_turn__wrap_up`) ends the turn, and a wrap-up with an `ask` is a pending question until the next turn starts. It stays Working with the `?` only while a linked child Agent has recent work and no other permission request is pending. ASB sends no question or answer text to the view.
- Claude permission tools, pending `ExitPlanMode`, and fresh remote `requires_action` show Waiting with a passive `?` until resolved in Claude. Read and successful opens cannot clear this wait. Pin stays available. A pending Claude permission, plan approval, or question tool gives Waiting and Pending only for six hours after its tool event. After that, the usual rules apply, and an old open task gives Unknown.
- A stopped root or group shows Idle with a small muted square, including historical stops. It adds no unread mark. New work or a later end removes the square. Existing question or unread attention has priority.
- A terminal failure shows Idle. With unknown native read state, a failed-task dot requires an observed Working-to-Idle change and a new failure. Historical failures get no new dot on first load. Codex uses non-null `task_complete.error`; Claude uses terminal `result.is_error`, a linked failed task notification that ends the group (a queued or transcript-only copy), or fresh remote session `failed`. A delivered failed notification starts a reply turn, and the end of that turn sets the outcome. Ordinary tool errors and interruptions are not task failures. Native read truth keeps its own rule.
- The PC plays a sound when a chat gets a new Done, Needs input, or Failed mark, like the phone. It plays one sound per update at most, and no sound for the marks that exist when ASB starts.
- Codex approval wait remains unsupported. ASB has no reliable unanswered approval signal in its local file sources and does not read the app-server `waitingOnApproval` flag.

## Read and Unread

Right-click a row, or use Menu or Shift+F10. The menu offers **Read** for an ASB dot or question attention and **Unread** when neither is present. A current permission wait has no Read action. A passive stop square can still be marked Unread. An unread row also offers **Put in drawer**. A row in the drawer offers **Take out of drawer** and **Read**, and no **Unread**.

**Unread** adds an ASB mark and includes the chat in Pending-only. It survives read changes in the original app. **Read** clears ASB attention. Neither action changes execution or the original chat store.

While the pointer is on an unread row, the row looks read in both views: the unread dot is not shown and the state label has the read tone. When the pointer leaves, the row looks unread again. In Comfortable, the Read slot shows its check cue while the pointer is on the card. A `?`, the stop square, and the Discard ring do not change on hover. The read look (no dot, and the check cue in Comfortable) also shows while the row has visible keyboard focus or while one of its controls has visible keyboard focus. Focus that comes from a mouse click does not change the row: its dot stays. In Compact, focus never hides the dot.

In Comfortable, select the dot or question-attention `?` beside the top-right pin to **Read**. A permission-wait `?` or stop square is passive, with no Read action or check cue. A successful Read shows a check for 1.6 seconds. A failed action keeps the dot and puts the error in the row tooltip. The error leaves the row when the row state changes or when the row leaves the list. This control works with or without **Persistent unread**. It does not open the chat or resolve a source question. New attention replaces old feedback.

With **Persistent unread** off, a successful open acknowledges manual, native, completion, failure, and question attention in ASB. A failed open keeps the attention. An acknowledgment does not answer a question, clear a permission wait, or change a stopped outcome. A new question, completion, failure, or native Read-to-Unread cycle can add new attention.

## The drawer

The drawer holds unread chats that you want out of the way. In the normal list, a chat in the drawer looks read. It has no unread dot, it is not Pending, and it sorts with the read chats. ASB changes nothing in Codex or Claude.

To put a chat in the drawer, open the row panel of an unread row and turn on **In the drawer**. In Comfortable, you can also point at the card, or move keyboard focus to it, and select the drawer button. The card corner then shows three buttons in a row: drawer, read, pin. The title keeps its width. The buttons lie over the end of the first title line, with a short fade to the window background. On a highlighted card this gives a slightly darker pocket behind the buttons. Focus that comes from a mouse click does not show the drawer button. A column narrower than 190 pixels has no drawer button; use the row panel there. Compact has no card buttons; use the row panel.

Only a row with an unread dot can go in the drawer. A row with a `?`, a required action in the original app, or a Working state cannot.

To see the drawer, select the **Drawer** pill. It shows a drawer glyph and a small dot when the drawer has chats. The dot has no numeral. Archived chats affect the dot only while **Show archived sessions** is on. Search, the app pills, and the state filters do not change it. An empty drawer hides the dot. A selected pill has the accent color as background. Narrow windows hide the word Drawer and keep the glyph and dot. With the pill on, the list shows only the drawer chats, and they look unread as normal. An empty drawer shows **The drawer is empty. Put an unread session in it to get it out of the way.** You can also point at the pill while it is off: the drawer chats then show their unread look in place until the pointer leaves.

The drawer has no time limit. A chat leaves the drawer in these ways:

- You take it out. Turn off **In the drawer** in the row panel. In Comfortable, the drawer button of a drawer card has a filled glyph in the accent color; select it. The chat is unread and Pending again.
- You mark it read: turn off **Unread** in the row panel. In a drawer row, **Unread** and **In the drawer** are on; an Unread action through the local API also takes the chat out.
- You open it. A successful open acknowledges the marks when **Persistent unread** is off. With **Persistent unread** on, an open keeps the marks and the chat stays in the drawer.
- It gets new attention. The chat comes out as normal unread and Pending when ASB sees a result or failure time that is newer than `drawerSeen`, or when the chat has a question. This includes a task that ASB did not see in its Working phase, for example a short task between two scans. A native unread that is raised again in the original app with no new result does not take the chat out.
- Its mark is gone. When no stored mark is left, for example the chat was read in the original app and ASB has no other mark for it, the chat leaves the drawer as a read chat. An unknown native read state for a time keeps the chat in the drawer.

A drawer chat that goes Working stays in the drawer. A stopped task keeps the chat in the drawer. A task that ends with **Discard result** on acknowledges the completion and native marks, as in 1.5.0. A drawer chat whose only mark is of that kind is then read and leaves the drawer. A drawer chat with a manual Unread mark stays in the drawer and is not Pending.

The browser view shows a drawer chat as read. It has no Drawer pill and no drawer actions.

## Discard result

Use **Discard result** while a task is Working to skip its next successful result dot. In Comfortable, point at the row or use keyboard focus to show the dashed hollow dot beside Pin. Select it to turn Discard on. The solid hollow dot stays visible. Select it again for **Keep result**. Compact keeps the Working timer and shows only the passive armed ring; use the **Discard result** switch in the row panel to change it. The row panel of a Working row has this switch in either view.

Discard applies to this task once. A verified successful group end goes to read Idle without new result attention, even with Persistent unread on. The next task uses normal rules. It does not clear manual Unread, questions, or earlier failed-task attention. A failed end still gets its normal dot; cancellation still gets the stop square. A question has priority over the ring and keeps its normal Read or permission-wait behavior. Discard changes no state, Pending filter, pin order, or source-app read flag.

Reading a Working question returns directly to the Discard ring. It shows no Read confirmation check. Idle and Waiting Read confirmation stay unchanged. A new Working row without a question clears old Read feedback.

Discard stays stored during Waiting and Unknown. Any observed Idle clears it. A root ending while its linked child works keeps it armed; a proven new root task clears the old arm. A follow-up message in an armed Claude task does not cancel Discard. Only a task that starts after an end later than the arm cancels it. ASB uses recorded starts and ends, not the changing Working timer.

Discard checks the current source before arming. Keep uses the normal cache and adds no forced scan. If task A ends and task B starts and ends before a late click, cached A can still look Working; the Discard scan rejects the current Idle row. A task already armed before both ends can still affect B because the local reader retains only the latest end. ASB does not add history or infer a missing result.

A native unread mark for the discarded success can arrive late. ASB suppresses the first matched episode and preserves later observed Read-to-Unread cycles. A source-app manual Unread that is the first mark for the same completion can also be suppressed. Remote cache limits still apply: generic Idle without a terminal timestamp clears the arm but cannot safely suppress native attention. A remote end and new run missed between scans can leave Discard armed. ASB does not infer a missing task identity.

**Persistent unread** in **Sessions** is on by default when no valid saved setting exists. An explicit saved off setting stays off. It keeps native, completion, and failure attention after source Read and successful opens. Choose **Read** to clear it. A question is attention only while it is open. When you answer it in the original app, its `?` goes and no retained dot stays. Turning the setting off keeps existing dots and restores acknowledgment on successful opens. Retained marks follow the Working rule above: they are hidden while the chat is Working. Every visible retained dot counts as Pending.

All ASB clients share this attention and pin state. Filters do not limit what the tracker observes.

## Preferences and local settings

Select the toolbar settings button to open **Preferences**. It is one separate native window. You can still use the main window. Selecting the button again raises the same Preferences window. Closing Preferences keeps ASB running and keeps form edits for the next open.

Use **Sessions** for app and state filters, archived sessions, Show app pills, Persistent unread, search, and narrow-window Refresh. Use **Appearance** for Compact or Comfortable, column width, and colors. Use **Profiles** to add or edit app sources. Use **Phone** for the optional Android companion. A wide window has navigation on the left; a narrow window has tabs above the page.

ASB uses dark mode in its main and Preferences windows. In **Appearance**, **GNOME colors** uses your current background, text, and accent colors. **Custom colors** lets you set background, text, accent, muted text, and divider colors. Divider color has no contrast limit. Changing a color selects **Custom colors**. Select **Apply theme** to check the dark background and text contrast, apply the colors to both windows, and save them for the next start. A validation or save error keeps the previous theme. **Reset to GNOME** removes the custom theme and resets the pickers. ASB does not change global GNOME settings.

| File | Contents |
| --- | --- |
| `$XDG_STATE_HOME/asb/pending.json` | Attention history, Read/Unread marks, pins, Persistent unread, current-task Discard, and the drawer. |
| `$XDG_CONFIG_HOME/asb/layout.json` | Column width, selected view, and Show app pills. |
| `$XDG_CONFIG_HOME/asb/theme.json` | Custom colors. |
| `$XDG_CONFIG_HOME/asb/sources.json` | App-source names, colors, dot visibility, folders, launchers, and enabled flags. |
| `$XDG_CONFIG_HOME/asb/phone.json` | Phone access on or off, selected addresses, port, and paired phones. Each phone has an ID, a name, times, and the SHA-256 of its token. |
| `$XDG_CONFIG_HOME/asb/phone-tls/` | The phone certificate (`cert.pem`) and its private key (`key.pem`). |

With no XDG override, state uses `~/.local/state` and config uses `~/.config`. An empty `XDG_CONFIG_HOME` also uses `~/.config`. A width-only layout file loads Compact. Reset width keeps the selected view. The attention, source, and phone settings files have owner-only access. When ASB cannot use `pending.json` in full, it shows the Pending state warning and moves the old file to `pending.json.bad` before the first save. An older `.bad` file is replaced. The same rule applies to `sources.json` (`sources.json.bad`) before the next source update or remove. The warning that ASB cannot save Pending state clears after the next good save.

The application ID is `local.asb.AgentSwitchBoard`. Per-user installation registers only ASB's own launcher and icon. It creates no auto-start entry. See [icon provenance](assets/icons/ASB-disc-provenance.md).

## App sources

Open **Profiles** in Preferences to add or edit local Codex and Claude profiles. The native table shows Enabled, name/app, session folder, **Open with**, and chat count/status. Select a source to edit it, or choose **Add**. Use **Choose…** for folders and the installed app launcher, then **Save**. **Cancel** discards form edits; **Refresh** reloads the table. The table loads on the first visit and after explicit actions. Changing the Preferences section keeps the form edits and does not reload the table. ASB supports eight registered sources, including the two defaults.

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

## Phone access

Open **Phone** in Preferences to use the optional ASB Android app. Phone access is off by default. See [the Android guide](android/README.md) to build and install the app.

| Field | Select |
| --- | --- |
| Allow phone access | Turn phone access on or off. Phones on your network can see your sessions and use ASB actions after pairing. |
| Addresses | One check row for each private address of this PC: **Home network** (LAN), **ZeroTier**, or **Tailscale**, with the address. ZeroTier and Tailscale rows show "Works away from home". Select one or more. |
| Port | The phone port, from 1024 to 65535. The default is `4630`. It must be different from the ASB port. |

Select **Apply** to save and start or stop phone access. The page then shows `Running at` with each listening address, or an error. When a selected address is not on the PC now (for example after a Wi-Fi change), ASB skips it, the other addresses still listen, and the page shows an error that names it. Select other addresses, then select **Apply**. The page also shows the certificate fingerprint in groups of four characters. The fingerprint does not change when you change the addresses or port.

To use ASB away from home, install and join ZeroTier or Tailscale on this PC and on the phone. Then select the ZeroTier or Tailscale row and select **Apply**. When no ZeroTier or Tailscale address is on the PC, the page shows a note about this. One pairing works on all selected addresses. The app finds a working address by itself, and a phone that was paired before also gets the new addresses.

To pair a phone, select **Pair a phone**. Scan the QR code with the phone camera or any QR scanner app; it opens the ASB app. Or select **Copy link** and paste the link in the app. The code works once and ends in 10 minutes. Eight wrong codes also end it. Compare the fingerprint on the phone with the fingerprint in Preferences. When the phone is paired, the page shows **Paired:** and the phone name. Without `python3-qrcode`, the page shows the pairing link with **Copy link**; paste the link in the app. ASB keeps up to eight paired phones.

**Paired phones** lists each phone with its pairing date and last-seen time. **Remove** removes that phone at once. The phone then shows that it was removed. To stop all phone access, clear **Allow phone access** and select **Apply**.

## Start and stop

Installed packages launch with `asb` or the ASB Applications entry. The per-user command `~/.local/bin/asb` starts the shipped `scripts/asb`. If the recorded Node.js is not usable, `scripts/asb` tries `~/.local/bin/node`, `/usr/local/bin/node`, then `/usr/bin/node`, and prints a message if none is usable. ASB appends `/usr/local/bin:/usr/bin:/bin` to the caller's `PATH`, so apps started from ASB keep the caller's `PATH` order. From source:

```bash
npm run desktop
```

The initial window is about 420×900 pixels. Closing it stops the backend that the launcher started. An icon registration error stays visible, but the window still opens. A source run keeps an installed GNOME entry and reports the conflict. It replaces a source-run entry, including one from another checkout. A busy port produces an error. ASB attaches only to its own running user service (see below), not to another server. Use `PORT=4729 npm run desktop` to select a different port.

The optional browser view starts with `npm start` at [http://127.0.0.1:4629/](http://127.0.0.1:4629/). Both modes bind only to `127.0.0.1`. `HOST` does not change the address. `npm start` does not start phone access.

ASB uses two ports. The ASB server uses `4629` on `127.0.0.1`, or the `PORT` value. Phone access uses `4630` by default on the addresses that you select in Preferences > Phone.

### User service

The optional `asb.service` systemd user service runs the ASB server and phone access without the window. Phones then stay connected when you close the window. From a source checkout, use `scripts/asb service` in place of `asb service`.

| Command | Effect |
| --- | --- |
| `asb service install` | Write `~/.config/systemd/user/asb.service`, then enable and start it. |
| `asb service uninstall` | Stop and disable the service, then remove the unit file. |
| `asb service status` | Show the service state and whether its runtime file is valid. |

The service starts with the graphical session and restarts after a failure. Apps that ASB opened stay open when the service stops. While the service runs, `asb` attaches to it: it opens only the window and uses the service's port. Closing the window does not stop the service. An ASB `1.8.1` or older window cannot attach and reports a port conflict. After you install a new ASB package or move the checkout, run `asb service install` again to point the service to it. The user service needs Linux with systemd. The browser view has no Drawer pill and no drawer actions.

The unreleased Rust and Qt frontends were removed after evaluation. The normal
launcher and installers use Python at ASB `1.8.1`. Archived [Rust results](docs/benchmarks/python-rust-2026-10-12.md)
show faster startup and lower PSS, with mixed interaction timing. Archived
[Qt results](docs/benchmarks/python-qt-2026-10-13.md) show no meaningful scroll
speed gain; resize and memory results have limits. Neither comparison proves
physical display FPS or complete UI parity. Their harnesses are no longer in
this tree.

Default Codex opens use `codex://threads/<id>`. Default Claude opens use `claude://code/continue?session=local_<uuid>` for local chats and `claude://code/<id>` for validated `cse_` or `session_` remote IDs. The apps must handle these links. An additional source's installed launcher receives the validated link for that profile. Invalid Claude local IDs remain visible with the open action disabled. Opens run in the background. **Opening…** appears in the row; a failure adds details to its tooltip.

## Refresh and data limits

Both clients poll every two seconds while any unarchived root chat is Working, otherwise every five seconds. This uses the full list before filters. Monitoring continues when another app has focus. Source-change events can start a read sooner. The shared clean snapshot lasts five seconds, so a two-second poll can reconcile after about six seconds. Cold scans and source write delays can take longer.

Reads do not overlap. On Linux, ASB uses one watch for each directory under the session folders. It follows new and removed folders from the watcher events. Full folder walks remain for start, changed source paths, root replacement or structure invalidation, a large burst of folder changes, and the 60-second safety check. Missing or failed watch roots retry every five seconds without walking healthy folder trees. When a read brings no change, both clients get a `304` reply and skip list updates. Browser age labels still update once a minute. A background poll does not change the native Refresh button; the button is inactive only during a refresh that you requested. Successful native session actions request a normal refresh and keep one follow-up if a read is active. Discard still checks the current source before arming. Polling remains the fallback when a watcher or event stream fails. Rows stay keyed by chat ID and update in place. Native filters reuse rows and bounded column containers. The browser also reuses visible groups and keeps opens, retained focus, and project collapse choices across updates. Activity alone does not rewrite ASB state.

By default, ASB reads the latest `~/.codex/state_N.sqlite` in read-only mode, `session_index.jsonl`, matched `.codex-global-state.json` read marks, and rollout lifecycle signals. On Linux, Claude metadata comes from `$XDG_CONFIG_HOME/Claude/claude-code-sessions` or `~/.config/Claude/claude-code-sessions`. Only `local_*.json` metadata is used. Matched transcripts come from `~/.claude/projects`. Registered profiles use their selected folders and the same readers, source-change events, and polling fallback.

Remote Code metadata comes from approved session-list and watch response bodies in Claude's `Cache/Cache_Data`. ASB uses the newest cached response and exact cursor-linked updates. A watch without a full list contains only observed sessions; the source warning states this limit. The cache can be incomplete or old, including while Claude is closed. ASB does not fetch the remote list. Remote body decoding and parsing use one lazy worker with bounded queued reads. The first remote load has worker startup overhead. Shutdown and deadlines reject queued reads immediately. The worker closes after its active bounded parse returns; a replacement waits for the old worker to exit. A hung native parse can block that exit. Working and Waiting require an explicit worker state and a response observation within six hours. Missing state or a disconnected Remote Control bridge gives Unknown. Cloud sessions do not need a bridge connection. Remote work has no inferred start time or local folder; a safe cached Git repository name can identify the project.

Root chats are the list unit. Internal subagents stay grouped under their root. Reads are limited to 5000 records per source. ASB does not include orphan Codex rollouts that are absent from its local database.

Codex tail reads start at 64 KiB and grow to 256 KiB. On the first read of a larger log, ASB searches the bytes before the tail for question calls and reads lines only from such a call. When the tail has no lifecycle event, lifecycle and question checks scan the full log with bounded memory. Claude uses an 8 MiB transcript tail with complete lifecycle recovery when needed. After a guarded append, it reads new records from its in-memory checkpoint and keeps loaded questions and metadata. A valid final JSON record without a newline is visible and is read again on append. Truncation, replacement, equal-size changes, and detected boundary rewrites trigger recovery. The append guard assumes earlier bytes stay unchanged when a file grows. Large retained histories can make the first scan slow. In-memory caches reuse unchanged metadata. Local signal and lifecycle caches retain up to 5000 keys per enabled store, with shared values held once. Disabling, removing, or changing a store prunes its local cache ownership. Shared active data stays cached. Remote response-cache retention is separate. No transcript checkpoint file is written by ASB.

See [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) for source modules and [Privacy](docs/PRIVACY.md) for the full data boundary.

## X11 scrolling limit

On the tested Debian 13 GNOME X11 stack, ASB has no proven safe 240 Hz scrolling fix. Keep the current Python workaround. The [investigation report](docs/benchmarks/x11-frame-timing-2026-10-13.md) records the measured results. See [the measured limitation and retest checks](SYSTEM_OVERVIEW.md#known-x11-frame-rate-limitation) before changing the distro or desktop stack. Resize lag remains unresolved.
