# ASB user guide

ASB lists Codex and Claude Desktop Code chats. It also lists remote Code sessions observed in Claude's local cache, OpenCode 2 sessions (list only; see [OpenCode](#opencode)), and Claude Code CLI and Codex CLI sessions (view only; see [CLI sessions](#cli-sessions)). Select a row to open that chat in its original app. The Linux native window uses GTK and Libadwaita. ASB makes no model calls and does not send prompts.

See the [install guide](docs/INSTALL.md) for v1.12.1 packages and runtime requirements.

## Layout and search

**Compact** is the default. It has one line of about 22 pixels per chat. **Comfortable** has rows of about 68 pixels, with the app and folder above a two-line title. Both views read down each column, then across from left to right. Window height and the row height with your font set the row count. More chats continue to the right. Use the mouse wheel, trackpad, or Shift-wheel to scroll horizontally.

Mouse-wheel scrolling moves to its target with a spring. The speed stays continuous, the movement settles in about 350 ms, and it does not overshoot. Repeated wheel input adds distance; reverse input starts from the visible position. Trackpad scrolling stays direct. With GNOME animations off, wheel scrolling is immediate.

In Comfortable, one hover highlight moves between cards and columns in 200 ms. It fades in or out in 100 ms. Cards stay fixed. With GNOME animations off, the highlight changes immediately. Wheel scrolling clears the shared highlight once and keeps it off during the spring. Motion from a stationary pointer afterward does not restart it. Move the pointer again to restore the glide. Native row hover and keyboard focus still work. Compact keeps its static hover.

When data or a filter changes the order or the set of visible cards, the cards move in both views. Each card that stays visible glides from its old place to its new place in about 350 ms. Each new card fades in. A card that leaves disappears at once. This applies to Read, a refresh with a new order, a pin move, a card that goes in or out of the drawer, search text, the pills, the Preferences filters, and the archive setting. A new change during the motion starts from the current painted places. There is no motion at start, when the window size, column width, or view changes, or with GNOME animations off. Pointer input, keyboard focus, and screen readers use the final layout at all times. The hover highlight clears when a motion starts.

A message between two visible sessions shows as a short accent light that flies from the sender card's provider icon to the receiver card's provider icon in 480 to 900 ms, with a small ring on arrival. When the receiver is out of view, an edge mark flashes when the light reaches the viewport edge and no ring shows; when both cards are out of view, nothing plays. Only new messages from the last 30 s play, at most 6 at a time, and nothing plays at start; with GNOME animations off or on GTK 4.12, both provider icons show the accent color for 2 s instead.

Comfortable uses quiet title, folder, state, and age text for Idle chats with no ASB unread dot or Pending attention. Hover or keyboard focus restores normal text. Pins and provider marks keep their normal strength. Source read status does not change this rule.

Hover a row to see the Unfolded card tooltip in either view. It shows the full folder path and title, then the current state/time and app/source. Paths below your home folder use `~`. Long text wraps. One short note explains the current indicator; pin/archive/drawer/link flags and the current row error appear only when needed. The profile dot uses the same rule as the row. Read historical failures do not show a failed-unread note. A chat in the drawer has the flag **In the drawer** and keeps its normal unread note. Its accessible label ends with "In the drawer. Still unread." Screen readers also receive the original full path, state reason, and source identity. The native tooltip frame and control tooltips stay unchanged.

Tooltip queries use current time and row data. Unchanged content is reused; changed text, profile or theme rebuilds it without a source read. Theme changes clear hidden-row tooltip caches too.

Drag a column divider to change the width of all columns. **Appearance** in Preferences also has **Column width** (160–600 pixels) and **Reset width**. The default is 240 pixels. Columns keep the shared width when the list has fewer columns than the window can show, for example in search results. A view change keeps your search, filters, pins, and focused chat. Keyboard navigation reveals a focused row when it is outside the visible area.

Search names, folders, or app-source names. Results update when the text changes. A row title has at most 300 characters; a longer title ends with `…`. Codex can store a full prompt as a title. Search matches the limited title, and the tooltip shows it. Claude Desktop Code titles keep their own shorter limit. A leading `cl:` or `claude:` selects Claude. A leading `cx:` or `codex:` selects Codex. A leading `oc:` or `opencode:` selects OpenCode. Prefixes ignore case and permit spaces. A prefix alone lists that app. A prefix takes priority over the app filter while it is present. The other filters still apply. Unknown prefixes remain literal search text.

The toolbar stays in one row and shows only icons. The disc and the Search button are at the left; the ⋮ main menu and native Close stay at the right. The **Drawer** and **Filters** pills show no text labels. Extra pills and filter chips scroll horizontally. At 680 pixels or more, the Refresh button is visible before ⋮; below that width, Refresh is in Preferences > Sessions. Select Search, type on the board, or select **Find a session or folder** in Preferences to open the search field. It is a row under the toolbar, not a popover: it slides down in 150 ms (with no motion when animations are off). The row stays while it has a query or the focus; with an empty query, it hides when it loses the focus. Below 320 pixels, the disc and the Search button are hidden. At start, no control has keyboard focus. One click on a card opens the session while you search. The × in the field and Escape clear the query and all filters (Pending, the states, the profiles, Include archived, All cards, and the Drawer view) and hide the search row. Backspace that empties the query keeps the filters. An open popover (Filters, the row panel, or the main menu) takes Escape first and closes only itself. With no query and no filter, Escape does nothing. Native popups and Ctrl/Alt/Super shortcuts keep their normal keys. Hold Ctrl for a moment to show the numbers 1–9 on the first nine whole cards that can open; Ctrl+1 to Ctrl+9 open that card, also before the numbers show.

## Filters and pins

Use the **Drawer** and **Filters** toolbar pills. **Filters** opens a checklist popover with **Pending**, the states (**Working**, **Waiting**, **Idle**, and **Unknown**), the profiles, and **Include archived**. The popover lists each app profile that is registered on this machine, for example Codex Account One and Claude Account Two, also a profile with no sessions now. When sessions of another machine of the group show, its profiles come under that machine's name. An app with two or more profiles on one machine has a check for the app: it shows a dash when only some of its profiles are on, and a click turns all of them on, or all of them off when all are on. No selected state means all states, and no selected profile means all profiles. Choices in one group add sessions; groups together remove sessions. **Pending** alone shows Pending chats. Together, **Working** and **Pending** show Working chats or chats with Pending or an ASB unread dot. Other states keep Pending as an AND filter. Search still applies. Archived chats are hidden until you turn on **Include archived**. The popover stays open while you select; Escape or a click outside closes it. The chips change when the popover closes, so the popover does not move while you select. Space or Enter turns **Include archived** on or off. **Clear filters** at the bottom clears Pending, the states, the profiles, and Include archived, and closes the popover. **Drawer** shows only the chats in the drawer; see [The drawer](#the-drawer). It combines with the popover filters and search. It does not combine with **Pending**: turning one on turns the other off.

Each active filter value has a chip with a × after the pills, for example **Working** or **Codex Account Two**. A profile chip has the profile color dot. A profile of another machine reads **<profile> · <machine>**. Select a chip, or press Delete or Backspace on it, to clear only that value. Chips that do not fit scroll; the wheel over them scrolls them. **All cards** has a chip while the board shows all cards past the card limit. The search prefixes `cx:`, `cl:`, and `oc:` still select one app, together with the profile filters. The main view has no numeric counters.

The board shows only the first cards in its order. Set the number in Preferences > Sessions > **Cards on the board**: 50, 100, 200, 500, or All (default 100). Search and filters look at all sessions, and the limit applies to the result. When more cards match, a **More sessions** card comes at the end. Click it, or press Enter or Space on it, to show all cards. Then the toolbar shows the **All cards** chip; select its × to show only the first cards again. A new window always starts with the first cards. The tooltip of the More card tells how many sessions it holds.

ASB pins come first in their saved order. Unpinned chats follow: Pending, Working, Idle, then Unknown. A Waiting chat that you marked read sorts with the Idle chats. A Working chat sorts by the start of its current task, so it does not move while it works. A Working chat with no known start comes after the Working chats that have one. In the Pending group, Working chats with a question come first, by task start; the other Pending chats follow by newest activity. A card moves when its state or group changes or a new task starts. Right-click a row, or use Menu or Shift+F10, to **Pin** or **Unpin** it. Drag a pinned row onto another pin to change the order. **Move pin earlier** and **Move pin later** provide the same control from the keyboard. They move the pin before or after the adjacent visible pinned row, with search and filters applied. They do nothing at the first or last visible pin. Hidden pins keep their place in the saved order.

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

When a usage limit stops a chat, its row is grey and shows a clock with **Resets in** and a countdown (Compact: **Resets 4h32m**; from 24 hours on, days and hours such as **Resets 3d4h**). The limit stop is a failed task: the row shows the `!` mark and is Pending until Read. At the reset time the grey look and the countdown go, and the row shows **Stopped**; and the tooltip shows the reset time, with the weekday when the reset is on another day.

**Pending** means attention, not an execution state. Each visible dot, `!`, or `?` counts as Pending. A row keeps its Working, Waiting, Idle, or Unknown label when its indicator appears. A question or current permission wait shows a `?` instead of the dot. An unread failed task, or a task that a usage limit stopped, shows a `!` instead of the dot. Such an Idle row shows **Stopped** in place of **Idle** until the next task starts, also after Read; filters still count it as Idle. A stop square does not count as Pending. A read permission wait keeps its `?` but does not count as Pending.

- Codex native unread marks use only the identity and local host that match its SQLite creator metadata. Missing, corrupt, or unmatched read data means Unknown read status. ASB does not read credentials to find the identity.
- A Working chat is never unread. While a chat is Working, ASB hides its dot and shows only a `?` for a question. Saved Unread, native, completion, failure, and retained marks stay stored and show again when Working ends. A visible native unread dot also puts an Unknown row in Pending-only.
- Local Claude chats have no reliable native unread mark. Cached remote records can provide an unread mark. ASB can also add a completion dot when it observes a Working-to-Idle change with a new completion. This dot is an ASB observation. A task that goes Working, Waiting, then Idle also gets its completion or failure dot. The first scan does not mark historical Idle chats Pending.
- Current synchronous `request_user_input` questions can show Waiting. Async questions add attention while the real Working or Idle state stays visible. Real human input supersedes old questions. A pending Claude `AskUserQuestion` shows Waiting with the `?`. A Claude Desktop wrap-up (`mcp__ccd_turn__wrap_up`) ends the turn, and a wrap-up with an `ask` is a pending question until the next turn starts. It stays Working with the `?` only while a linked child Agent has recent work and no other permission request is pending. ASB sends no question or answer text to the view.
- Claude permission tools, pending `ExitPlanMode`, and fresh remote `requires_action` show Waiting with a `?` until resolved in Claude. Read and successful opens cannot clear this wait: Read moves the card down to the read cards, and it keeps Waiting, the `?`, and its note. A new wait of the chat is unread again. A pending Claude permission, plan approval, or question tool gives Waiting and Pending only for six hours after its tool event. After that, the usual rules apply, and an old open task gives Unknown.
- A stopped root or group shows Idle with a small muted square, including historical stops. It adds no unread mark. New work or a later end removes the square. Existing question or unread attention has priority.
- A terminal failure shows Idle. With unknown native read state, a failed-task dot requires an observed Working-to-Idle change and a new failure. Historical failures get no new dot on first load. Codex uses non-null `task_complete.error`; Claude uses terminal `result.is_error`, a linked failed task notification that ends the group (a queued or transcript-only copy), or fresh remote session `failed`. A delivered failed notification starts a reply turn, and the end of that turn sets the outcome. Ordinary tool errors and interruptions are not task failures. Native read truth keeps its own rule.
- The PC plays a sound when a chat gets a new Done, Needs input, or Failed mark, like the phone. It plays one sound per update at most, and no sound for the marks that exist when ASB starts. The engine plays sounds only while an ASB window is open; the sounds stop when the last window closes (up to 45 s later after a crash of the window). The `npm start` browser view keeps its sounds.
- Codex approval wait remains unsupported. ASB has no reliable unanswered approval signal in its local file sources and does not read the app-server `waitingOnApproval` flag.

## Read and Unread

Right-click a row, or use Menu or Shift+F10. The row panel shows the title, **Open in <app>**, and then only the actions that apply. It offers **Mark read** for an ASB dot or question attention and **Mark unread** when neither is present. A current permission wait offers **Mark read** until you read it and **Mark unread** after, and the panel says **Waits for your permission.** A passive stop square can still be marked unread. An unread row also offers **Put in drawer**. A row in the drawer offers **Take out of drawer** and **Mark read**, and no **Mark unread**. **Mute** or **Unmute** comes right after the drawer row; see [Mute](#mute). The last two rows copy a reference to the session. **Copy relative reference** copies the app host and the app's own session ID, for example `claude-proxy/local_…`. It points to the session in the same app. **Copy absolute reference** copies the full ASB reference (`asb:1/...`). It points to exactly this session through ASB, from any app and on any machine of the group. The tooltip of each row shows the text. After a copy, the caption shows **Relative session copied** or **Absolute session copied** for a moment. When ASB cannot make a reference, the row shows why and copies nothing. In Comfortable, the copy button at the top right of a card copies the chosen kind of reference while the pointer is on the card or the card has keyboard focus. The kind is Relative (`<app>/<session ID>`) or Absolute (`asb:1/...`). One setting for the whole board, saved in `layout.json`, holds the kind. The wheel on the button, or Alt+Up and Alt+Down on the focused button, switches it after a short rest. A small tag with the complete word **Relative** or **Absolute** slides out beside the button. Click copies the chosen kind. The card footer shows **Relative session copied** or **Absolute session copied** for a moment. On a card of a session on another machine, it copies only the absolute reference, because a relative reference works only on its own machine. The panel has the same background as the board.

**Unread** adds an ASB mark and includes the chat in Pending-only. It survives read changes in the original app. **Read** clears ASB attention. Neither action changes execution or the original chat store.

While the pointer is on an unread row, the row looks read in both views: the unread dot is not shown and the state label has the read tone. When the pointer leaves, the row looks unread again. In Comfortable, the Read slot shows its check cue while the pointer is on the card. A `?`, the stop square, and the Discard ring do not change on hover. The read look (no dot, and the check cue in Comfortable) also shows while the row has visible keyboard focus or while one of its controls has visible keyboard focus. Focus that comes from a mouse click does not change the row: its dot stays. In Compact, focus never hides the dot.

In Comfortable, select the dot, the `!`, or question-attention `?` beside the top-right pin to **Read**. An unread permission-wait `?` also has **Read**. A read permission-wait `?` or a stop square is passive, with no Read action or check cue. A successful Read shows a check for 1.6 seconds. A failed action keeps the dot and puts the error in the row tooltip. The error leaves the row when the row state changes or when the row leaves the list. This control works with or without **Persistent unread**. It does not open the chat or resolve a source question. New attention replaces old feedback.

With **Persistent unread** off, a successful open acknowledges manual, native, completion, failure, question, and permission-wait attention in ASB. A failed open keeps the attention. An acknowledgment does not answer a question, clear a permission wait, or change a stopped outcome. A new question, completion, failure, or native Read-to-Unread cycle can add new attention.

## The drawer

The drawer holds unread chats that you want out of the way. In the normal list, a chat in the drawer looks read. It has no unread dot, it is not Pending, and it sorts with the read chats. ASB changes nothing in Codex or Claude.

To put a chat in the drawer, open the row panel of an unread row and select **Put in drawer**. In Comfortable, you can also point at the card, or move keyboard focus to it, and select the drawer button. The card corner then shows three buttons in a row: drawer, read, pin. The title keeps its width. The buttons lie over the end of the first title line, with a short fade to the window background. On a highlighted card this gives a slightly darker pocket behind the buttons. Focus that comes from a mouse click does not show the drawer button. A column narrower than 190 pixels has no drawer button; use the row panel there. Compact has no card buttons; use the row panel.

Only a row with an unread dot or `!` can go in the drawer. A row with a `?`, a required action in the original app, or a Working state cannot.

To see the drawer, select the **Drawer** pill. It shows a drawer glyph and a small dot when the drawer has chats. The dot has no numeral. Archived chats affect the dot only while **Include archived** is on in the Filters popover. Search, profile filters, and the state filters do not change it. An empty drawer hides the dot. A selected pill has the accent color as background. Narrow windows hide the word Drawer and keep the glyph and dot. With the pill on, the list shows only the drawer chats, and they look unread as normal. An empty drawer shows **The drawer is empty. Put an unread session in it to get it out of the way.** You can also point at the pill while it is off: the drawer chats then show their unread look in place until the pointer leaves.

The drawer has no time limit. A chat leaves the drawer in these ways:

- You take it out. Select **Take out of drawer** in the row panel. In Comfortable, the drawer button of a drawer card has a filled glyph in the accent color; select it. The chat is unread and Pending again.
- You mark it read: select **Mark read** in the row panel. An Unread action through the local API also takes the chat out.
- You open it. A successful open acknowledges the marks when **Persistent unread** is off. With **Persistent unread** on, an open keeps the marks and the chat stays in the drawer.
- It starts to work or waits for you. When the chat goes Working, has a question, or waits for your permission in the original app, it leaves the drawer at once. A Working chat shows with the Working cards, at the front of them. When the task ends, the chat shows its marks again: unread and Pending with the new result, or with its old mark when the task stopped with no result.
- It gets new attention. The chat comes out as normal unread and Pending when ASB sees a result or failure time that is newer than `drawerSeen`. This includes a task that ASB did not see in its Working phase, for example a short task between two scans. A native unread that is raised again in the original app with no new result does not take the chat out.
- Its mark is gone. When no stored mark is left, for example the chat was read in the original app and ASB has no other mark for it, the chat leaves the drawer as a read chat. An unknown native read state for a time keeps the chat in the drawer.

A task that ends with **Discard result** on acknowledges the completion and native marks, as in 1.5.0, so a chat whose only mark is of that kind is read. A manual Unread mark stays: the chat is unread, or, after a short task between two scans, it stays in the drawer and is not Pending.

The browser view shows a drawer chat as read. It has no Drawer pill and no drawer actions.

## Discard result

Use **Discard result** while a task is Working to skip its next successful result dot. In Comfortable, point at the row or use keyboard focus to show the dashed hollow dot beside Pin. Select it to turn Discard on. The solid hollow dot stays visible. Select it again for **Keep result**. Compact keeps the Working timer and shows only the passive armed ring; use **Discard result** or **Keep result** in the row panel to change it. The row panel of a Working row has this action in either view.

On an Idle chat with no `?`, dot, or stop square, use **Discard next result** to skip the result dot of its next task, for example a task that you know will go well. In Comfortable, the same dashed ring shows in the Read slot on hover or keyboard focus. The row menu and the row panel have **Discard next result**, and **Keep next result** while it is on. The arm stays until a task ends after it, also when a whole task runs between two scans. When ASB sees the chat Working, it works as **Discard result** for that task. The Android app offers Discard only for Working chats.

Discard applies to this task once. A verified successful group end goes to read Idle without new result attention, even with Persistent unread on. The next task uses normal rules. It does not clear manual Unread, questions, or earlier failed-task attention. A failed end still gets its normal `!` mark; cancellation still gets the stop square. A question has priority over the ring and keeps its normal Read or permission-wait behavior. Discard changes no state, Pending filter, pin order, or source-app read flag.

Reading a Working question returns directly to the Discard ring. It shows no Read confirmation check. Idle and Waiting Read confirmation stay unchanged. A new Working row without a question clears old Read feedback.

Discard stays stored during Waiting and Unknown. Any observed Idle clears the Discard of a Working task. A Discard of the next task stays until a task ends after it. A root ending while its linked child works keeps it armed; a proven new root task clears the old arm. A follow-up message in an armed Claude task does not cancel Discard. Only a task that starts after an end later than the arm cancels it. ASB uses recorded starts and ends, not the changing Working timer.

Discard checks the current source before arming. Keep uses the normal cache and adds no forced scan. If task A ends and task B starts and ends before a late click, cached A can still look Working; the Discard scan rejects the current Idle row. A task already armed before both ends can still affect B because the local reader retains only the latest end. ASB does not add history or infer a missing result.

A native unread mark for the discarded success can arrive late. ASB suppresses the first matched episode and preserves later observed Read-to-Unread cycles. A source-app manual Unread that is the first mark for the same completion can also be suppressed. Remote cache limits still apply: generic Idle without a terminal timestamp clears the arm but cannot safely suppress native attention. A remote end and new run missed between scans can leave Discard armed. ASB does not infer a missing task identity.

**Persistent unread** in **Sessions** is on by default when no valid saved setting exists. An explicit saved off setting stays off. It keeps native, completion, and failure attention after source Read and successful opens. Choose **Read** to clear it. A question is attention only while it is open. When you answer it in the original app, its `?` goes and no retained dot stays. Turning the setting off keeps existing dots and restores acknowledgment on successful opens. Retained marks follow the Working rule above: they are hidden while the chat is Working. Every visible retained dot counts as Pending.

All ASB clients share this attention and pin state. Filters do not limit what the tracker observes.

## Mute

Select **Mute** in the row panel to keep a chat read when its tasks end: finished tasks stay read, and questions still alert. **Unmute** turns it off. A muted chat shows a small muted-bell icon after the folder name in Comfortable and after the state in Compact.

- A task of a muted chat that ends with success gives no dot, no Done sound, and no Done phone notification. ASB handles it as a success with **Discard result** on, also for a native unread mark of that task that arrives late. **Persistent unread** does not keep it.
- Questions and permission waits still show the `?` and play the Needs input sound and phone notification.
- A failed task still shows its `!` mark and plays the Failed sound.
- Mute applies to tasks that end after you turn it on.
- Turning Mute on does not clear a dot at once. A dot from before stays until you read it, or until a later task of the muted chat ends with success. Failure dots and manual Unread stay until you read them.
- **Unread** in ASB still works on a muted chat. An Unread mark that the original app sets with no new finished task still shows.
- A muted chat has no **Discard result**: no card ring and no row panel action. A Discard that you armed before Mute stays as it is.

ASB saves Mute for each chat in its own `pending.json`, like the drawer. The phone and the browser view get the `muted` row field, but they have no Mute control.

## OpenCode

ASB lists OpenCode sessions from the local OpenCode database, read-only. It reads only OpenCode 2 sessions (the `session_v2` table), not older OpenCode history. Only root sessions are cards. A subagent session is not a card; it adds to the subagent count of its root. The card title is the OpenCode title, or the session slug when the title is empty. When the database has no `session_v2` table or a needed column, the source shows **ASB reads OpenCode 2 sessions only. Update OpenCode.** and lists no rows.

OpenCode cards do not open. OpenCode 2 has no link that opens one session. A click or Enter does nothing, the card gets no Ctrl number, and **Open in OpenCode** in the row panel is insensitive. The tooltip flag says **No direct link. OpenCode cannot open one session from a link.** Read, Unread, pins, the drawer, and Discard work as for other chats.

| Card | OpenCode evidence |
| --- | --- |
| Working | OpenCode holds its execution claim for the session (a turn is in progress), and the last message of the session or its subagents is from the last six hours. With no message, the claim time counts. |
| Unknown | The execution claim exists, but the last message (or the claim, with no message) is more than six hours old. A claim can stay after a crash or a shutdown during a turn. |
| Idle | No execution claim. |
| Done | The last turn ended with `idle_outcome` `succeeded`. |
| Failed | The last turn ended with `idle_outcome` `failed`. |
| Interrupted | The last turn ended with `idle_outcome` `interrupted`. The card shows the stop square, with no attention. |

Unread comes from OpenCode's own read mark. A session is unread when its last finished turn (`time_idle`) is later than the time that OpenCode last showed it (`time_viewed`). Viewing the session in the OpenCode TUI or desktop app clears it. A session with no finished turn has unknown read state. OpenCode has no Needs input in ASB: OpenCode keeps permission asks and questions only in memory, not in its database, so an OpenCode card never shows Waiting or a `?`.

The OpenCode profiles in the Filters popover and the `oc:` and `opencode:` search prefixes select OpenCode cards.

## CLI sessions

ASB shows Claude Code CLI and Codex CLI sessions as view-only cards. A Codex CLI task (`codex`, `codex exec`) no longer opens from ASB. Claude Code CLI cards show each running `claude` session, and each CLI transcript with activity in the last 7 days. They also show on a PC without the Claude desktop app. A running session with no transcript yet shows Idle. A Claude session that the Desktop app owns stays a Claude Desktop Code card.

In Comfortable, the bottom line of a CLI card shows the terminal glyph and `CLI` before the age, for example `Idle` and `CLI · 12m ago`. In Compact, `· CLI` follows the state, for example `Idle · CLI`. A CLI card with no attention uses the Grey tone: its title and text use the quiet colors, and its state keeps its color while it is Working or Waiting. An unread dot, a `?`, and the usage-limit look keep full strength. Hover or keyboard focus restores the normal colors.

A click or Enter on a CLI card does nothing, the card gets no Ctrl number, and the row panel button says **Runs in a terminal** and is insensitive. The tooltip says **CLI session. Runs in a terminal. ASB does not open CLI sessions.** Read, Unread, pins, the drawer, Mute, and Discard work as for other chats. The title of a Claude Code CLI card is the session name, then the title that you set in the CLI, else `Claude Code session` and the start of the session ID. ASB never uses prompt text as the title.

## Machines

The machine group shows the sessions of your other computers that run ASB. Each machine shows the cards of the other machines next to its own. The commands work through the running ASB engine.

**Preferences > Machines** does the same work as the commands. It shows this machine, the other machines (online, or offline with the last-seen time, their ID and addresses, and **Remove**), and the group phones. **Add a machine** shows the join link, a QR code, and the fingerprint of this machine until the other machine joins or the link ends. **Join a group** takes a pasted link, shows the fingerprint of the inviter, and joins only after you select **It is the same**. **Leave the group** and **Remove** ask first. When network access is off, **Open Phone settings** opens the Phone page. Each machine also has a Bridge line with the ASB Bridge state of its enabled app profiles, for example `Bridge: Codex ready · OpenCode old version`. An offline machine shows `Bridge: not checked while offline`, and a machine with an older ASB shows `Bridge: unknown, needs ASB 1.12+`. The page reads the group and the bridge states again every 5 seconds while it is open. The command steps:

1. On each machine, turn on network access: `asb network enable <address>`. `asb network status` lists the addresses of the PC. Network access is the same setting as phone access. Use a private LAN, ZeroTier, or Tailscale address.
2. On the first machine, run `asb group invite`. It prints a join link, the fingerprint in groups of four characters, and the time until which the link works. The link works one time for 10 minutes.
3. On the other machine, run `asb group join '<link>'`, optionally with `--name <name>`. With no link, `asb group join` asks `Paste the join link: ` and reads one line; an empty answer stops with `No join link.`. Use this form on Windows: `cmd.exe` splits a typed link at each `&`. It prints the name and fingerprint of the inviter and asks `Does the other machine show this fingerprint? [y/N]`. Compare the fingerprint, then answer `y`. When the name is taken, ASB suggests another one.

`asb group status` lists the machines (online, or offline with the last-seen time), the group phones, and, when the group has another machine, the state of the message relay (see [Messages between machines](#messages-between-machines-linux-and-windows)). `asb group remove <name>` removes a machine. `asb group leave` makes this machine leave the group; it keeps its paired phones. A removed machine leaves the group by itself when it next reaches a member. To join again, it needs a new identity: if `asb group status` still shows a group, run `asb group leave`; then stop ASB (`asb engine stop`), run `asb group reset-identity`, and start ASB again. Paired phones must then pair again. `asb network disable` turns network access off.

A card from another machine shows that machine's name in the bottom line. It does not open from ASB. Archived sessions of another machine do not show, also with **Include archived** on. Read, Unread, pins, the drawer, and Mute work and change only the marks of this machine. Discard does not work on it. A Done card of another machine plays the Done sound. When a machine does not answer for 3 polls, its cards show Unknown with `<name> is not reachable.` After 10 minutes, its cards go away. Each machine of the group also accepts the token of a phone that is paired with another machine of the group.

### Messages between machines (Linux and Windows)

Claude Code sessions and Codex tasks on one machine can message the sessions on the other machines of the group. Each machine needs Bun for its ASB engine; a Codex task also needs ASB Bridge. The engine finds Bun on its own `PATH` first. When it is not there, the engine looks in `$BUN_INSTALL/bin` (when `BUN_INSTALL` is an absolute path) and then in `~/.bun/bin`, where the Bun installer puts it. On Windows, these folders are `%BUN_INSTALL%\bin` and `%USERPROFILE%\.bun\bin`. A service or a Windows sign-in start can have a shorter `PATH` than your shell, so this folder search lets the relay start. A Codex task still needs Bun on the `PATH` of Codex. The engine starts its message relay by itself while the group has at least one other machine, and stops it when this machine is alone or leaves the group. When the engine finds no Bun while the group has another machine, it writes one line to its log (`ASB cannot start the message relay: Bun was not found on PATH or in <folder>.`) and does not repeat it every 30 seconds. `asb group status` shows the state in its last line, `Message relay: running.`, `Message relay: not running.` (with the reason when Bun is missing), or `Message relay: stopped after 5 restarts in 10 minutes.` `asb group status --json` has the same state in the field `relay`.

- In Claude Code, `/list-agents` shows each session of another machine as `<machine>-<session>`, for example `laptop-codex-fix-tests-3f`. Ask Claude to message it as usual.
- For each Claude profile, **Remote Claude sessions** in Preferences > Profiles sets how Claude reaches Claude sessions on other machines. Claude Remote Control works per session: with **Automatic** or **Claude Remote Control only**, a local session that is not on Remote Control does not see a remote Claude session that ASB leaves out.
- In Codex, `list_sessions` shows the other machines' sessions after the local ones, with `remote: true` and `machine`. On Linux and Windows, each entry also has its full session reference (`reference`), or the reason that a send cannot use one (`referenceUnavailable`). Send to one with `send_message` by its `sessionId`. Or send by its full session reference (`asb:1/...`): ASB then sends to exactly that Codex or Claude Code CLI session (on the same Linux or Windows PC, or between Linux and Windows machines of the group), or it sends nothing and gives the reason.
- A reply comes back the same way: the receiving session sees the sender under the name of the sending machine.
- A message to a machine that is offline, or to a session that has ended, is refused at once with a short reason, for example `laptop is not reachable.`. ASB keeps no queue: send the message again when the machine is back.
- Idle subscriptions (`notify_when_idle`) do not work across machines yet.

## Messages and Usage

**Messages** shows the newest messages that your agents send each other, with their text. **Usage** shows the tokens and the API price of the Codex, Claude Code, OpenCode, Antigravity, Grok, and Pi agents. Both show all machines of the group. Each one opens in its own window, so the board keeps its width. Both only show data: they do not open sessions or change their marks.

Open them in one of these ways:

- Select ⋮ (the main menu) in the board toolbar, then **Messages** or **Usage**. **Preferences** is in the same menu.
- Press Ctrl+M for Messages or Ctrl+U for Usage. These keys work in every ASB window. On the board, Ctrl+, opens Preferences.
- Select **Messages** or **Usage** in the tray menu. When no board is open, ASB opens the board and then that window.
- Select **Show messages** in the row panel of a card. Messages then shows only the messages of that session, and the toolbar shows a chip with the session title and ×. Select × (**Show all sessions**) or press Escape to show all sessions.

Each window has one instance: open it again to bring it to the front. Ctrl+W closes Messages or Usage; closing them does not close ASB. Each window keeps its size for the next time. While a window shows, it updates by itself after each change of the board (at most once a second) and every 15 seconds.

Each window has one slim toolbar row and no header bar. The row is also the drag area of the window. It has the ASB mark, the period menu, the controls of that window, and only a close button.

**Messages** shows `24 hours`, `7 days` (the default), or `30 days`. It is one list of the newest messages, newest first. Day headers divide the list in local time: `Today`, `Yesterday`, then the month and day (`Oct 25`). A message shows the time (`14:05`), the sender, `→`, and the receiver. After a session of another machine of the group, ` · <machine>` follows. When the status is not Accepted, the message shows it: `Socket written`, `Held`, a fixed reason or `Not sent`, or `Unknown`. Under it is the full text: it wraps, and you can select and copy it. A message with no text shows `No text`. A session that is not a card on the board shows the name from the message when there is one (for example `beta-helper`), else `Other session`. The list has at most the newest 200 messages; then its last line is `Showing the newest 200 messages.` An empty period shows `No messages in this period.` A text has at most 2,000 characters; a longer text ends with `…`. A refresh with the same messages changes nothing. When new messages arrive while you read lower in the list, the message that you read stays in place; at the top, the list stays at the top.

Messages reads two sources:

- Claude Code transcripts: the `*.jsonl` files directly in each project folder of the projects folder of each enabled Claude profile (default `~/.claude/projects`), changed in the last 30 days. The sending session has a `SendMessage` tool call (or a tool whose name ends in `send_message`) with a target and a message. The receiving session has a `<cross-session-message>` record. A message to `main` or to a subagent does not show. When the tool result says that the send failed, the message shows `Not sent`.
- ASB Bridge databases.

When the transcripts of the sender and the receiver both have one message, the list shows it once.

**Usage** shows `24 hours`, `7 days`, `30 days` (the default), `90 days`, or `All time`. Select **Cost** or **Tokens**. With 2 or more machines, the machine filter button (tooltip `Machines`) is at the end of the toolbar; its popover has the machine chips. Select a chip to turn its machine on or off. The window shows the machines, the apps, the providers (Machines is open, and Apps and Providers are folds), a chart by app or by machine, the totals of the token types, and the models. The chart is `Hourly cost` for 24 hours, `Daily cost` for 7 to 90 days, and `Monthly cost` for All time (with `Tokens`: `Hourly tokens`, `Daily tokens`, `Monthly tokens`). All time has one bar for each month, from the month of the oldest usage to `This month`. The month labels show the year on the first label and where the year changes. **Providers** has one row for each company that makes a model, for example Anthropic, OpenAI, Google, or xAI. A model that ASB does not know counts as `Other`. A model name with a prefix that LiteLLM does not know, such as `z-ai/glm-5.2`, takes the price of `glm-5.2`. A model with no price shows `Unpriced` and is not in the cost; a one-line note counts the unpriced models and their tokens, for example `1 unpriced model: 12K tokens not in the cost.`, and its tooltip names the models. In Cost, a provider with no priced model also shows `Unpriced`. The tooltip of the ring chart is the price line: `Prices: LiteLLM, Oct 26` (the day of the price list), `Prices: loading`, or `Prices: not available`. ASB downloads the LiteLLM price list from GitHub only while you use Usage (also on the phone), at most once in 24 hours when the download works.

The first scan reads all history of the newest 10,000 transcript files, by the time of their last change. It also reads the compressed Codex rollouts (`*.jsonl.zst`); this needs Node.js 22.15 or later. The first scan can take some time. While it runs, a small line under the toolbar shows `Reading usage: 120 of 2,707 files` (or `Reading usage` before the file list is ready) and the usage found so far. While the scan runs or the prices load, the window updates every 2 seconds. Usage reads these folders:

- Codex: `sessions` and `archived_sessions` of each enabled Codex profile.
- Claude Code: the projects folder of each enabled Claude profile.
- OpenCode: `opencode.db` and each `opencode-<name>.db` in the folder of each enabled OpenCode profile.
- Grok: `$GROK_HOME/sessions`, else `~/.grok/sessions`.
- Pi: `$PI_CODING_AGENT_SESSION_DIR`, else `sessions` in `$PI_CODING_AGENT_DIR`, else `~/.pi/agent/sessions`.
- Antigravity: the folders of `$ANTIGRAVITY_DATA_DIR` (a comma list), else `~/.gemini/antigravity`, `~/.gemini/antigravity-cli`, `~/.gemini/antigravity-ide`, `~/.gemini/antigravity-backup`, and `~/.config/antigravity`. This needs Node.js 22.13 or later (`node:sqlite`).

Grok, Pi, and Antigravity need no profile: ASB reads their folders when they exist. ASB does not read these apps:

- Cursor: its usage is on cursor.com and needs your login.
- Muse: its folder is known only from the running `muse` program.
- The OpenCode `storage/message` JSON files: the storage of old OpenCode versions.

The other machines of the group send their message records, the text of their newest 200 messages of the period (at most 2,000 characters each), and their hourly token usage. So Messages shows the text of messages between sessions of other machines. A machine shows `Local`, `Connected`, or `Offline`; a machine chip names only `Offline`, and its tooltip shows the state. An offline machine keeps its last data and shows the time of its last report, for example `Last report Oct 25, 14:30`. The Usage window needs GTK 4.14 for the charts; with GTK 4.12 it shows `Charts need GTK 4.14 or later.`

ASB keeps the hourly token usage of this machine in its usage ledger (`~/.config/asb/usage/usage-ledger.json`; on Windows `%APPDATA%\asb\usage\usage-ledger.json`). So Usage keeps the usage of a transcript after its app deletes it (Claude Code deletes CLI transcripts after 30 days by default), the usage of the transcripts after the newest 10,000, and the usage of a profile that you disable or remove. The engine reads the usage 10 minutes after it starts and then every hour, also when the Usage window is closed. The ledger also keeps the last usage that each machine of the group sent: each hour, the engine asks the online machines of the group for their usage. So a machine that is offline, or that left the group, stays in Usage and in the backups with the time of its last report. If you delete the ledger, Usage shows only the usage that the transcripts still have and that the online machines send.

To keep the usage of a machine that you will not use again, or to see the usage of all your machines on a new machine, export the usage on one machine and import it on the other. The engine must run.

| Command | Effect |
| --- | --- |
| `asb usage export <file>` | Save the hourly usage of this machine, the other machines of the group, and the imported machines to a new file. The file has mode `0600`. |
| `asb usage import <file>` | Add the usage of an export file to this machine. A machine that is not in the group shows as `Offline`, with the export time as its last report. When you import the same file again, nothing counts two times. |

An export file has the machine IDs and names, and the token counts of each hour, app, and model. It has no message text, title, or folder.

### Usage backups

Each day at 03:00, the engine saves a backup file of the usage of every machine: this machine, the machines of the group (an offline machine with the usage that the ledger kept), and the imported machines. The file has the content of `asb usage export`, so `asb usage import` and **Import…** read it. Its name is `asb-usage-<name>-<id>-<date>.json`: the machine name, the first 8 characters of the machine ID, and the local date. The default folder is `~/.config/asb/usage/backups` (on Windows `%APPDATA%\asb\usage\backups`), and the file has mode `0600`. After the backup, ASB deletes the oldest backup files of this machine, so the folder keeps the last 5. A second backup on the same day replaces the file of that day. ASB never deletes other files in the folder. When the PC is off or asleep at the backup time, the backup runs at the first check after that on the same day: the engine checks 15 minutes after it starts and then every 15 minutes.

Change the backups in Preferences > Usage:

- **Daily backup** turns the daily backup on or off.
- **Time** is the local time of the daily backup.
- **Files to keep** is the number of backup files of this machine, from 1 to 30.
- **Folder** is where the files go. Select **Change…** to choose another folder, the folder button to open it in the file manager, and **Use** in **Default folder** to go back to the default folder. ASB never makes or changes a folder that you choose, so the folder must exist. To keep the backups when the disk fails, choose a folder on another disk or a folder that a sync app copies.

Select **Apply** to save the settings. **Back up now** saves a backup at once, also when the daily backup is off. The page lists the backup files of this machine and shows the time of the next backup. **Export…** saves an export file where you choose, and **Import…** adds the usage of an export file or a backup file.

| Command | Effect |
| --- | --- |
| `asb usage backup` | Show the backup settings, the next backup, and the backup files of this machine. |
| `asb usage backup now` | Save a backup now. |
| `asb usage backup on [--time HH:MM] [--keep N] [--folder <path>\|default]` | Turn the daily backup on, and change its settings. `--folder default` goes back to the default folder. A relative path starts from the current folder. An empty value is an error. |
| `asb usage backup off [--time HH:MM] [--keep N] [--folder <path>\|default]` | Turn the daily backup off. `asb usage backup now` still works. |

## Top bar (GNOME)

On GNOME Shell 45 to 49, the ASB extension shows ASB in the top bar, to the left of the system menu. One capsule has three numbers: the sessions that need you, the sessions that work, and all sessions on the machines of the group. Archived sessions do not count. When a session needs you, the first part has the accent color. When the engine does not run, the capsule shows `Off`. A number that changes rolls up, and a new session that needs you makes the first part flash one time. When animations are off, the numbers change at once.

Select the capsule to open its menu:

- **Needs you**: the 6 newest sessions that need you. `?` is a question or an approval, `!` is a failed task, and a dot is a finished task. More sessions show as `3 more`.
- **Working**: the 6 sessions that started work last, with the time since they started.
- **Machines** (only in a machine group): each machine with its number of sessions. An offline machine shows `Offline`.
- **Open ASB**, **Messages**, **Usage**, and **Quit ASB**, as in the tray menu.

Select a session to open it in its app. A session that ASB cannot open, for example a CLI session or a session of another machine, opens the board. When the engine does not run, the menu shows `ASB is not running.` and **Start ASB**.

The capsule uses the accent of the board colors (**Appearance** in Preferences). When no board saved its colors yet, it uses the GNOME accent color. On a light top bar or a light menu, ASB uses dark text and makes the accent and the machine colors darker, so they stay readable. While the extension runs, the tray icon hides itself, so the top bar shows ASB one time.

The per-user install (`install.sh`) adds the extension when GNOME Shell 45 or later is installed, and turns it on the first time. GNOME Shell loads a new extension only when it starts: on X11, press Alt+F2, type `r`, and press Enter; on Wayland, log out and log in again. The .deb, RPM, Arch, and Nix packages install the extension for all users: turn it on in the Extensions app. For an npm install, see [Top-bar extension](docs/INSTALL.md#top-bar-extension-gnome). The extension reads the engine port and token from `service.json` and gets its numbers from `GET /api/panel` on `127.0.0.1`. It sends nothing to other computers.

## Preferences and local settings

Select the toolbar settings button to open **Preferences**. It is one separate native window. You can still use the main window. Selecting the button again raises the same Preferences window. Closing Preferences keeps ASB running and keeps form edits for the next open.

Use **Sessions** for Cards on the board, Persistent unread, search, and narrow-window Refresh. The Filters popover is the one place for filters. Use **Appearance** for Compact or Comfortable, column width, and colors. Use **Profiles** to add or edit app sources. Use **Phone** for the optional Android companion. Use **Machines** for the machine group. Use **Usage** for the daily usage backups and to export or import the usage. A wide window has navigation on the left. A narrow window (600 px wide or less) shows a list of the sections first: select a section to open it, and use **Back** or Escape to go back to the list.

ASB uses dark mode in its main and Preferences windows. In **Appearance**, **GNOME colors** uses your current background, text, and accent colors. **Custom colors** lets you set background, text, accent, muted text, and divider colors. Divider color has no contrast limit. Changing a color selects **Custom colors**. Select **Apply theme** to check the dark background and text contrast, apply the colors to both windows, and save them for the next start. A validation or save error keeps the previous theme. **Reset to GNOME** removes the custom theme and resets the pickers. ASB does not change global GNOME settings.

| File | Contents |
| --- | --- |
| `$XDG_STATE_HOME/asb/pending.json` | Attention history, Read/Unread marks, pins, Persistent unread, Discard (current task and next task), and the drawer. |
| `$XDG_CONFIG_HOME/asb/layout.json` | Column width, selected view, Cards on the board, and the card copy kind. |
| `$XDG_CONFIG_HOME/asb/theme.json` | Custom colors. |
| `$XDG_CONFIG_HOME/asb/sources.json` | App-source names, colors, dot visibility, folders, launchers, and enabled flags. |
| `$XDG_CONFIG_HOME/asb/phone.json` | Phone access on or off, selected addresses, port, and paired phones. Each phone has an ID, a name, times, and the SHA-256 of its token. |
| `$XDG_CONFIG_HOME/asb/phone-tls/` | The phone certificate (`cert.pem`) and its private key (`key.pem`). |

With no XDG override, state uses `~/.local/state` and config uses `~/.config`. An empty `XDG_CONFIG_HOME` also uses `~/.config`. A width-only layout file loads Compact. Reset width keeps the selected view. The attention, source, and phone settings files have owner-only access. When ASB cannot use `pending.json` in full, it shows the Pending state warning and moves the old file to `pending.json.bad` before the first save. An older `.bad` file is replaced. The same rule applies to `sources.json` (`sources.json.bad`) before the next source update or remove. The warning that ASB cannot save Pending state clears after the next good save.

The application ID is `local.asb.AgentSwitchBoard`. Per-user installation registers only ASB's own launcher and icon. It creates no auto-start entry. See [icon provenance](assets/icons/ASB-disc-provenance.md).

## App sources

Open **Profiles** in Preferences to add or edit local Codex and Claude profiles. The list shows each profile with its app, its chat count (or **Off**), and its ASB Bridge state. Select a profile to open it in a dialog, or choose **Add a profile**. In the dialog, use the folder buttons for folders and the installed app launcher, then **Save**. **Cancel** or Escape closes the dialog and discards its edits. The Refresh button reloads the list and checks ASB Bridge again. The list reloads when Profiles becomes visible and when the dashboard reports changed source settings. ASB supports eight registered sources, including the three defaults.

The **ASB Bridge** part of the dialog shows the bridge state of the profile on this machine, with the next step when something is wrong (for example, trust the hooks in Codex). **Install** or **Update** runs `asb bridge install` for that profile and can take some minutes. ASB checks ASB Bridge only for enabled profiles.

Automatic refresh keeps unsaved edits and an **Add** draft. If another client changes or removes a source with unsaved edits, ASB keeps your edits and shows a conflict. Select **Cancel**, open the profile again, then edit and save again. If only another source changed, your form stays available. Save and Remove also check the source revision, so a change during a request returns `409` without overwriting saved settings.

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
| Remote Claude sessions (Claude) | How Claude in this profile reaches Claude sessions on the other machines of the group: **Automatic** (through ASB, unless both machines use Claude Remote Control), **Through ASB** (always through ASB), or **Claude Remote Control only** (ASB adds no Claude sessions of other machines to this profile; Codex tasks of other machines stay). |
| Enabled | Include this source in ASB reads and the chat list. |

The default Codex, Claude, and OpenCode sources can be edited or disabled, but not removed. **Remove profile** unregisters an additional source. Disable and Remove do not delete source files or saved ASB attention, pins, unread marks, and settings. One store cannot be added twice. A missing or failed source does not hide other profiles.

ASB has one OpenCode source, the default source. Its folder is fixed: `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`, with the file `opencode.db`. It has no launcher, because ASB cannot open OpenCode sessions. In the dialog, the app is the fixed text **OpenCode**, the session folder is read-only, and **Open with** is not used. You can change its name, color, and dot, and turn it off with **Enabled**. You cannot add another OpenCode source. A settings file from before OpenCode support gets the default OpenCode source when ASB reads it, unless the file already has eight sources.

A second ChatGPT/Codex login needs its own local profile data and installed profile launcher. Profiles can share one app binary if their `CODEX_HOME` and Electron profile folders are separate. On first use, when `sources.json` is absent, ASB registers the known ChatGPT Personal profile if its local store and launcher exist. ASB does not sign in, copy credentials, or change the original apps' URL handlers. A ChatGPT-labeled source shows local Codex coding chats, not ordinary ChatGPT cloud chat history. Use the same Profiles list for additional Claude instances.

When an app has multiple registered sources, a Soft dot appears at the lower-left of its icon in both views. It uses the source color and has no action. Clear **Show profile dot**, then **Save**, to hide only this profile's dot. This keeps the source enabled, its saved color, and its state and unread marks. Legacy rows and apps with one registered source hide it. Profile numbers are not visible. The source name remains in the tooltip, accessible description, and search. The Codex and Claude pills still select all sources for that app.

Choose **Profile color** in the source editor, then **Save**. The presets are Slate blue (`#8296b4`), Clay (`#b28f80`), Plum (`#a28caa`), and Sage (`#899e91`). ASB saves any valid six-digit hex color, including dark colors. The display can lighten the marker to keep 3:1 contrast without changing the saved color. A successful save shows **Saved**; an error keeps the form for correction. Old source settings get a stable default color and show the dot. Color identifies the source only; it does not change state, unread marks, chat identity, or original app styles.

## Local agent commands

`asb agent` inspects the running ASB instance and manages its app sources through the local API. From a source checkout, use `scripts/asb agent` in place of `asb agent`.

| Command | Effect |
| --- | --- |
| `asb agent status` | Show the version, mode, pid, ASB root path, source settings path, and backend/UI state. |
| `asb agent peers` | List live local agents from the Claude session registries by app instance, and the agent homes that are not in ASB. Read-only. |
| `asb agent sources list` | List registered sources: id, name, provider, enabled state, label, and data folder. `--json` also returns their settings revision. |
| `asb agent sources get <id\|name>` | Show one registered source. |
| `asb agent sources add --file <json-file>` | Add a source from one JSON object. |
| `asb agent sources update <id\|name> --file <json-file>` | Merge the supplied fields into the current source. |
| `asb agent sources remove <id\|name>` | Unregister an additional source. An absent source is unchanged. |
| `asb agent resolve-session <reference> [--source <source-id>]` | Show the machine, the source, and the state of a full or short session reference. Read-only. |

Each source has a name made from its label: lowercase letters and digits, with other characters changed to `-`, at most 80 characters. A label with no letters or digits uses the source id. Names are unique: a save fails when the name is the name or the id of another source. A selector that is a source id selects that source. Otherwise ASB selects the one source with that name. If older settings give more than one source the same name, the command fails with `source_ambiguous`; use the id.

`asb agent peers` shows each live agent as `<instance>/<name>`, where the instance is the source name of the agent's app home and the name is the agent's own registry name. ASB reads Claude session records from the `sessions` folder of each Claude source home and of `~/.claude`. It accepts only records owned by you whose process is alive and has the recorded start time. For each agent it reads only `CLAUDE_CONFIG_DIR` and `CODEX_HOME` from that process. Codex tasks from ASB Bridge use `CODEX_HOME` (default `~/.codex`); other agents use `CLAUDE_CONFIG_DIR` (default `~/.claude`). When no source, or more than one source, matches the home, the instance is `unknown`. A relative or empty value in the variable that selects the agent's home, or an unreadable process environment, also gives `unknown`; the other variable does not affect the result. `duplicate name` marks a name that more than one live agent uses. `Not in ASB` lists `~/.codex*` folders with a `config.toml` and Claude agent homes that match no source.

`asb agent resolve-session` reads the session list that the engine has now. It does not scan, open, or send. A full reference (`asb:1/...`) resolves on this machine or on a member of the machine group. A short reference (`<source-name>/<app-session-id>`, the text that the board copies) resolves on this machine only; when more than one source has the same short text, give `--source <source-id>`. `--source` cannot change the source of a full reference. The result never contains a title, folder, path, or process data. For example (synthetic IDs):

```json
{"apiVersion":1,"ok":true,"form":"full","identity":{"reference":"asb:1/0123456789abcdef/codex/0123456789abcdef0123456789abcdef/codex:11111111-1111-4111-8111-111111111111","machineId":"0123456789abcdef","sourceId":"codex","scopeTag":"0123456789abcdef0123456789abcdef","type":"codex","appId":"11111111-1111-4111-8111-111111111111"},"display":{"machineName":"desk","sourceName":"codex","providerLabel":"Codex"},"location":"local","availability":"found","command":"resolve-session"}
```

`availability` is `found`, `not-found`, `source-disabled`, or `machine-offline`. An error gives a stable code, for example `stale-source-scope` when the folders of the source changed after ASB made the reference, and the command exits with a status that is not 0.

Add `--json` to any command for structured output. Use `--file -` to read JSON from standard input. Input is limited to 64 KiB and accepts only `provider`, `label`, `dataDir`, `launcher`, `enabled`, `projectsDir`, `color`, and `showMarker`. Do not include `id` or report fields such as `sessionCount`. Source folders and launcher paths must be absolute. A new source needs `provider`, `label`, `dataDir`, and `launcher`; `enabled` defaults to true. The provider is `codex` or `claude-desktop-code`.

For example, an update file can contain only:

```json
{"color":"#899e91","showMarker":true}
```

Apply it with `asb agent sources update <id> --file profile.json --json`. Repeating an update with the same values changes nothing. Repeating Add for the same physical store with matching supplied settings changes nothing; different settings require Update. Default sources remain protected. Writes use the revision from the preceding read. A concurrent change returns `409`; read the current sources and repeat the command.

Write results report **Saved**, **Backend**, and **UI** separately. Saved compares the current settings revision with the revision of the command's own write; if another client saved after it, Saved is `changed-after-write` and the result keeps the command's own revision. Backend confirms the revision in the cached dashboard. UI reports recent state received by native clients and, when Profiles is visible, its table revision. UI can be `verified`, `pending`, `dirty`, or `not-open`. These reports do not prove what was drawn on the display. A successful write requires saved and backend verification; check UI separately.

The commands need a current desktop or service with a safe `$XDG_RUNTIME_DIR/asb/service.json`. Both modes publish this private descriptor (`0600` in a user-owned `0700` folder); it contains the pid, port, and per-run source token. The CLI verifies the API version and pid and never prints the token. Without an absolute `XDG_RUNTIME_DIR`, the descriptor is in `asb/run` in `XDG_STATE_HOME` when it is absolute, else in `~/.local/state`. Older ASB builds and the unmanaged `npm start` server do not support these commands. The phone gateway cannot access the agent or source settings routes.

## Phone access

Open **Phone** in Preferences to use the optional ASB Android app. Phone access is off by default. See [the Android guide](android/README.md) to build and install the app. In a [machine group](#machines), a paired phone uses another machine of the group when the paired PC does not answer, and goes back to the paired PC when it answers again.

| Field | Select |
| --- | --- |
| Allow phone access | Turn phone access on or off. Phones on your network can see your sessions and use ASB actions after pairing. |
| Addresses | One check row for each private address of this PC: **Home network** (LAN), **ZeroTier**, or **Tailscale**, with the address. ZeroTier and Tailscale rows show "Works away from home". Select one or more. |
| Port | The phone port, from 1024 to 65535. The default is `4630`. It must be different from the ASB port. |

Select **Apply** to save and start or stop phone access. The page then shows `Running at` with each listening address, or an error. When a selected address is not on the PC now (for example after a Wi-Fi change), ASB skips it, the other addresses still listen, and the page shows an error that names it. The address stays checked as "Not on this PC now". When the address appears again (for example when ZeroTier starts after ASB), ASB starts to listen on it in 30 seconds or less. You do not need to select **Apply**. Each time you open the Phone page, it reads the addresses again. The page also shows the certificate fingerprint in groups of four characters. The fingerprint does not change when you change the addresses or port.

To use ASB away from home, install and join ZeroTier or Tailscale on this PC and on the phone. Then select the ZeroTier or Tailscale row and select **Apply**. When no ZeroTier or Tailscale address is on the PC, the page shows a note about this. One pairing works on all selected addresses. The app finds a working address by itself, and a phone that was paired before also gets the new addresses. After a network change on the phone (for example when you turn on ZeroTier), the app reads ASB at once.

To pair a phone, select **Pair a phone**. In the ASB app, select **Scan QR code** and scan the QR code. The phone camera or any QR scanner app also opens the ASB app. Or select **Copy link** and paste the link in the app. The code works once and ends in 10 minutes. Eight wrong codes also end it. Compare the fingerprint on the phone with the fingerprint in Preferences. When the phone is paired, the page shows **Paired:** and the phone name. Without the Python `qrcode` module or PyGObject cairo support (`asb doctor` prints the command), the page shows the pairing link with **Copy link**; paste the link in the app. ASB keeps up to eight paired phones.

**Paired phones** lists each phone with its pairing date and last-seen time. **Remove** removes that phone at once. The phone then shows that it was removed. To stop all phone access, clear **Allow phone access** and select **Apply**.

On Linux, firewalld or ufw can block the phone port. `asb setup` and `asb doctor` print the rule that lets phones and other machines reach it. ASB never runs it. See [System check](#system-check).

The same actions work from a terminal while the engine runs. Network access must be on (`asb network enable <address>`).

| Command | Effect |
| --- | --- |
| `asb phone status [--json]` | List the paired phones with their ID, pairing date, and last-seen time. |
| `asb phone pair` | Print a one-time pairing link and the time when it ends. Scan it as a QR code or paste it in the ASB app. |
| `asb phone remove <name>` | Remove the phone with this name. When more than one phone has the name, ASB lists their IDs. |
| `asb phone remove --id <id>` | Remove the phone with this ID. |

## Start and stop

Installed packages launch with `asb` or the ASB Applications entry. On Linux, `asb` with a command that ASB does not know (for example `asb --help` or a typo) prints the usage and exits with code 2; it starts no engine and no window. The per-user command `~/.local/bin/asb` starts the shipped `scripts/asb`. If the recorded Node.js is not usable, `scripts/asb` tries `node` on `PATH`, `~/.local/bin/node`, `/home/linuxbrew/.linuxbrew/bin/node`, `/usr/local/bin/node`, then `/usr/bin/node`. It uses the first that is Node.js 20 or later with SQLite. If none is usable, it prints a message with a link to the [install help](docs/INSTALL.md#nodejs). When `ASB_PYTHON` is an absolute path, the window uses only that Python. Else it uses the first of `/usr/bin/python3` and `python3` on `PATH` that has PyGObject. The window start keeps the last good result of this check in `~/.cache/asb/board-check.json`, so that most starts skip the check. ASB checks again after an update of ASB, a change of the Python candidates or the Python file, and when the window ends with an error. A failed check is never kept. `asb doctor` and `asb setup` always run the full check. You can delete the file. ASB finds `xdg-open`, `openssl`, `sqlite3`, and the sound players on `PATH`. ASB appends `/usr/local/bin:/usr/bin:/bin` to the caller's `PATH`, so apps started from ASB keep the caller's `PATH` order. From source:

```bash
npm run desktop
```

The initial window is about 420×900 pixels. The window is a view of the ASB engine, which runs the server and phone access. When no engine runs, `asb` starts one: through `asb.service` when that user service is enabled, else as a detached `asb engine run` process that writes its output to `~/.local/state/asb/engine.log`. The window opens when the engine answers. When the window cannot run on the system (engine only: the Window checks of `asb doctor` fail, for example GTK older than 4.12 on Debian 12 or Ubuntu 22.04), `asb` writes no desktop entry, prints `ASB runs without its window on this system: <reason> The engine runs for the phone and your other machines. Run asb doctor for details.`, and exits with code 3; the engine keeps running. The per-user install then also writes no desktop entry or icon. If the engine does not answer in 10 s, `asb` prints `ASB cannot start its engine. See <log>.` and exits; a busy port is the usual cause. Closing the window keeps the engine and phone access running. When the engine stops (Quit ASB in the tray, `asb engine stop`, or a restart of `asb.service`), open windows close. To stop them, select **Quit ASB** in Preferences > Sessions or in the tray icon menu. An icon registration error stays visible, but the window still opens. A source run keeps an installed GNOME entry and reports the conflict. It replaces a source-run entry, including one from another checkout. ASB attaches only to its own engine, not to another server. Use `PORT=4729 npm run desktop` to select a different port.

| Command | Effect |
| --- | --- |
| `asb engine start` | Start the engine when none runs, then print its PID and port. |
| `asb engine stop` | Stop the engine and phone access. |
| `asb engine status` | Show whether the engine runs, its PID and port, and whether it runs as the user service or detached. |
| `asb engine run` | Run the engine in this terminal. |

On Linux, the engine shows a tray icon when the desktop has a tray host, for example the GNOME AppIndicator extension. Its tooltip shows `Running.` or `Running. Phone access on.`. Its menu has **Open ASB**, **Messages**, **Usage**, and **Quit ASB**, and a left click opens ASB. When the window cannot run on the system, the menu has only **Quit ASB**, and a left click does nothing. Without a tray host, the engine runs with no icon. While the ASB top-bar extension runs, the icon hides itself (see [Top bar (GNOME)](#top-bar-gnome)). Set `ASB_TRAY=0` to start the engine without the tray icon. From a source checkout, use `scripts/asb engine` in place of `asb engine`.

The engine gives free memory back to the system. After a scan, it runs a full garbage collection when its memory is 128 MiB or more above the level after the last one (at most once in 30 s). `asb.service`, `asb engine start`, and `asb engine run` start the engine with a smaller V8 young generation (the Node.js argument `--max-semi-space-size=16`) and with three glibc settings (`MALLOC_ARENA_MAX=2`, `MALLOC_MMAP_THRESHOLD_=131072`, and `MALLOC_TRIM_THRESHOLD_=131072`). The engine removes the glibc settings from its environment, so the message relay and the apps that it opens do not get them. A user service that an earlier ASB wrote gets these settings when you restart it (`systemctl --user restart asb.service`). This uses less memory and a little more CPU. Node.js 20 gets only the smaller young generation and the glibc settings, because its V8 cannot free the pages in a garbage collection.

The optional browser view starts with `npm start` at [http://127.0.0.1:4629/](http://127.0.0.1:4629/). Both modes bind only to `127.0.0.1`. `HOST` does not change the address. `npm start` does not start phone access.

ASB uses two ports. The ASB server uses `4629` on `127.0.0.1`, or the `PORT` value. Phone access uses `4630` by default on the addresses that you select in Preferences > Phone.

### User service

The optional `asb.service` systemd user service runs the ASB engine, so the engine starts with the graphical session. When no systemd user manager runs a graphical session, `asb service install` uses an XDG autostart entry instead (see below). Without the service, `asb` starts a detached engine, which writes its output to `~/.local/state/asb/engine.log`. From a source checkout, use `scripts/asb service` in place of `asb service`.

| Command | Effect |
| --- | --- |
| `asb service install` | Write `~/.config/systemd/user/asb.service`, stop the running ASB engine, then enable and start the service. Without a systemd graphical session: write `~/.config/autostart/asb-engine.desktop`, then start the engine. |
| `asb service uninstall` | Stop and disable the service, then remove the unit file. Remove the autostart entry, then stop the engine. |
| `asb service status` | Show the service state and whether its runtime file is valid. Without a systemd graphical session: the autostart entry and `Engine: running` or `Engine: not running` (exit code 3). |

The service starts with the graphical session and restarts after a failure. After 5 failed starts in 60 s, systemd stops the restarts. The unit starts only while its launcher is an executable file, so a unit that stays after you uninstall ASB is skipped at login and does not fail. Apps that ASB opened stay open when the service stops. Under systemd, each app that ASB opens runs in its own scope, outside `asb.service`. The service exits at most 5 s after a stop signal. While the service runs, `asb` attaches to it: it opens only the window and uses the service's port. When the service is enabled but stopped, `asb` and `asb engine start` start it with `systemctl --user start asb.service`. Closing the window does not stop the service. **Quit ASB** and `asb engine stop` stop it with exit code 0, so systemd does not restart it; it starts again with the next login or `asb`. An ASB `1.8.1` or older window cannot attach and reports a port conflict. After you install a new ASB package or move the checkout, run `asb service install` again to point the service to it. The `asb.service` unit needs Linux with systemd. The autostart entry needs a desktop that supports XDG autostart. The browser view has no Drawer pill and no drawer actions.

The autostart entry runs `<launcher> engine start` at login, with `ASB_NODE` set to the Node.js that installed it. It has the line `# Generated by ASB: engine autostart`; ASB changes or removes only an entry with this line. Window managers without XDG autostart must run `asb engine start` after login. Without a desktop session, `asb service install` changes nothing and exits with code 1. When you change from one mode to the other, `asb service install` writes the new file, then removes the ASB file of the other mode. When it writes the unit, it always stops the running engine before it starts the service. When `systemctl --user disable` fails, it keeps the unit and says so; only one engine can run.

The unreleased Rust and Qt frontends were removed after evaluation. The normal
launcher and installers use Python at ASB `1.12.1`. Archived [Rust results](docs/benchmarks/python-rust-2026-10-12.md)
show faster startup and lower PSS, with mixed interaction timing. Archived
[Qt results](docs/benchmarks/python-qt-2026-10-13.md) show no meaningful scroll
speed gain; resize and memory results have limits. Neither comparison proves
physical display FPS or complete UI parity. Their harnesses are no longer in
this tree.

Default Codex opens use `codex://threads/<id>`. Default Claude opens use `claude://code/continue?session=local_<uuid>` for local chats and `claude://code/<id>` for validated `cse_` or `session_` remote IDs. The apps must handle these links. The Links line of [`asb doctor`](#system-check) shows which desktop file handles each scheme. An additional source's installed launcher receives the validated link for that profile. Invalid Claude local IDs remain visible with the open action disabled. Opens run in the background. **Opening…** appears in the row; a failure adds details to its tooltip.

## System check

`asb doctor` checks a Linux system and prints the commands that fix it. On Windows, it checks Node.js, the window, and the options (see [Windows](#windows)). From a source checkout, use `scripts/asb doctor` in place of `asb doctor`. It reads the system and, when it runs, the engine. It never runs an install command and never changes the firewall. `asb setup` prints the same checks first. See [Privacy](docs/PRIVACY.md) for what it reads.

The first line names your distribution and its family (`family unknown` when no family matches). Image-based systems (Fedora Atomic, openSUSE Aeon) add `transactional`, and SteamOS adds `readonly`. Each check then has one line with a status: `ok`, `missing`, `old`, or `info`. The checks come in three groups.

| Group | Checks |
| --- | --- |
| Engine | Node.js 20 or later (with built-in SQLite, else the `sqlite3` command), `openssl`, and `xdg-open`. |
| Window | Python 3.9 or later, PyGObject, GTK 4.12 or later, and Libadwaita 1.4 or later. |
| Options | The QR code (the Python `qrcode` module and PyGObject cairo support), the sound player (`pw-play`, `paplay`, or `aplay`), the tray host, Bun (for ASB Bridge), the autostart, the runtime folder, and the links. |

```text
ASB doctor: Fedora Linux 44 (Workstation Edition), family fedora

Engine
  ok       Node.js 22.23.1 (/usr/bin/node), built-in SQLite
  ok       openssl 3.5.1
  ok       xdg-open (/usr/bin/xdg-open)
Window
  missing  PyGObject (Python 3.14.8, /usr/bin/python3)
  missing  GTK 4
  missing  Libadwaita
Options
  missing  QR code (Python qrcode)
  ok       Sounds (pw-play)
  info     Tray host: not checked (needs PyGObject and a session bus)
  info     Bun: not found. ASB Bridge needs it.
  info     Autostart: not installed
  ok       Runtime folder: /run/user/1000/asb
  ok       Links: codex: chatgpt.desktop, claude: com.anthropic.Claude.desktop

Install the missing packages:
  sudo dnf install python3-gobject gtk4 gobject-introspection libglvnd-gles libadwaita
Optional:
  sudo dnf install python3-qrcode-core
```

- **Exit code.** `asb doctor` exits with code 0 when every Engine check is `ok`, else with code 1. A Window check that is not `ok` does not change the code: `asb` then runs the engine without the window (see [Start and stop](#start-and-stop)).
- **Commands.** The required command lists the missing Engine and Window packages for your package manager. The optional command lists the QR code and sound packages. `doas` replaces `sudo` when `doas` is found and `sudo` is not. A Node.js that is missing or older than 20 gets its route: for RHEL, AlmaLinux, Rocky, CentOS Stream, and Oracle Linux 9 the module command, for the Debian family the NodeSource page, and for SteamOS the archive from nodejs.org. When GTK or Libadwaita is too old, doctor prints no package. It says that ASB runs without its window, and that the phone and your other machines still show the sessions of this PC. A system without an install command (NixOS, SteamOS, an unknown family) gets the needs in words. NixOS also gets the flake line `nix profile install github:Jamir-boop/ASB`. Image-based systems get `rpm-ostree install` or `transactional-update pkg install`, then a restart note. Gentoo gets the `USE` flags that the packages need.
- **Autostart and runtime folder.** The Autostart line reads the two files that `asb service install` writes. It shows `systemd user service`, `XDG autostart`, or `not installed`. The Runtime folder line shows the folder in use. Without `XDG_RUNTIME_DIR` it is `info`, and the folder is `~/.local/state/asb/run`.
- **Bun.** Doctor looks for Bun as the engine does: on `PATH`, then in `$BUN_INSTALL/bin`, then in `~/.bun/bin` (on Windows, `%BUN_INSTALL%\bin`, then `%USERPROFILE%\.bun\bin`). Bun on `PATH` shows `ok` and `Bun (<file>), for ASB Bridge`. Bun in one of the other folders also shows `ok`, but the line says `not on PATH`: the message relay finds it there, but a Codex task needs Bun on `PATH`. No Bun shows `info`.
- **Links.** For `codex` and `claude`, doctor runs `xdg-mime query default x-scheme-handler/<scheme>` and prints the desktop file that answers (`ok`). An app with no handler, or a system without `xdg-mime`, gets `info` and the text `none: ASB cannot open <app> sessions until the app handles <scheme>: links`. ASB opens a session with `xdg-open <link>`, so without a handler **Open** does nothing.
- **Firewall.** While the engine runs with phone access on, and firewalld (`firewall-cmd --state` prints `running`) or ufw (`/etc/ufw/ufw.conf` has `ENABLED=yes`) is active, doctor also prints the rule for each selected address and the phone port, as `asb setup` does. It prints the lines under `Phone access and machine links through firewalld:` or `... through ufw:`. For firewalld, each address gets `sudo firewall-cmd --permanent [--zone=<zone>] --add-rich-rule='rule family="ipv4" destination address="<address>" port port="<port>" protocol="tcp" accept'`, with the zone of its interface when firewalld names one, and the lines end with one `sudo firewall-cmd --reload`. For ufw, each address gets `sudo ufw allow in on <interface> to <address> port <port> proto tcp`. Doctor prints a rule only for an IPv4 address, a port from 1 to 65535, and usual interface and zone names. For another name, it prints a note and no rule. The main server on `127.0.0.1` needs no rule.
- **JSON.** `asb doctor --json` prints `schema`, `system`, `checks` (`id`, `group`, `status`, and `detail`), `board` (`ok` and `reason`), and `commands` (`required`, `optional`, `node`, and `firewall`). `required`, `optional`, and `node` are each an array of words or `null`, and `firewall` is an array of such arrays.

## Windows

On Windows, the ASB engine reads Codex and Claude on that PC and gives their sessions to paired phones and to the other machines of the group. Since ASB `1.11.0`, Windows also has the ASB window, the Start menu entry, `asb doctor`, and the PC sounds. The ASB window needs MSYS2 Python with PyGObject, GTK `>=4.12`, and Libadwaita `>=1.4`; without it, only the engine runs. It plays the Done, Needs input, and Failed sounds with one hidden Windows PowerShell process, but only while an ASB window is open. This process ends after 5 minutes with no sound. ASB Bridge and messages between machines work on Windows too (see below). A paired phone shows the sessions and can open them on the Windows PC. A Linux board in the group shows them as remote cards. Claude web sessions are not read on Windows. Windows needs Node.js `22.13` or later.

```bash
npm install -g --install-links github:Jamir-boop/ASB
asb setup
```

Keep `--install-links`: without it, npm 11 links the package to a temporary folder that it then deletes, and `asb` stops working.

`asb setup` asks which parts to set up: **Board and bridge** (the default), **Board only**, or **Bridge only**. `asb setup --only board` and `asb setup --only bridge` choose without the question, and `--yes` chooses both. The board part does steps 1 to 4; the bridge part does step 5:

1. It prints the checks of `asb doctor`. It stops when the engine cannot run (Node.js without built-in SQLite). A missing window does not stop it; the checks then show how to install it.
2. It writes the autostart value and starts the engine, then waits up to 20 s for the engine to answer.
3. It lists the network addresses of the PC and asks which to turn on. `--yes` keeps the saved addresses (else the first home network address). `--address <address>` selects an address with no question; you can give it more than once.
4. It prints the firewall rule for the selected addresses and the phone port. ASB never runs this rule and never changes the firewall. To let phones and other machines reach ASB, run the rule in an administrator PowerShell. When Windows already allows `node.exe` on private networks, the rule is not needed.
5. It installs ASB Bridge for each app that does not have it yet (Codex homes, Claude, and OpenCode). It does not change a bridge that is already installed; Preferences > Profiles shows its state and can update it. It skips a Codex home when the running Codex cannot find Bun, and says why.

With the board part, it ends with the command to join a machine group. On Windows, run `asb group join --name <name>` and paste the link when it asks.

On Linux, `asb setup` prints the checks of [`asb doctor`](#system-check) in step 1 and stops when the engine cannot run. In step 2 it runs `asb service install` (the `asb.service` unit or the XDG autostart entry). In step 4 it prints the firewall rule when firewalld or ufw is active.

`asb doctor` also runs on Windows. It checks Node.js (`22.13` or later with built-in SQLite), the window (MSYS2 Python with PyGObject, GTK, and Libadwaita), and the options (the QR code, Bun, and autostart). When a window check fails, it prints the commands that install MSYS2 and the board packages: `winget install --id MSYS2.MSYS2 -e` (only when `C:\msys64\usr\bin\pacman.exe` does not exist), then `C:\msys64\usr\bin\pacman.exe -S --needed mingw-w64-ucrt-x86_64-python-gobject mingw-w64-ucrt-x86_64-gtk4 mingw-w64-ucrt-x86_64-libadwaita`. When GTK or Libadwaita is too old, the `pacman` command uses `-Syu --needed`. ASB never runs these commands. MSYS2 has no Python `qrcode` package, so the QR code check shows `info`, and Preferences shows no QR code on Windows. It shows the pairing link with **Copy link**; the tray menu **Copy phone pairing link** gives the same link.

| Command | Effect |
| --- | --- |
| `asb engine install` | Make the engine start when you sign in, add ASB to the Start menu, then start the engine. |
| `asb engine uninstall` | Remove the autostart value and the Start menu link, then stop the engine. |
| `asb engine start` | Start the engine and its tray icon when none runs. |
| `asb engine stop` | Stop the engine and phone access. |
| `asb engine status` | Show whether the engine runs, its PID and port. |
| `asb engine run` | Run the engine in this terminal. |

`asb` with no command starts the engine when it is not running and opens the ASB window, as on Linux. The launcher uses an absolute `ASB_PYTHON`; else `C:\msys64\ucrt64\bin\python.exe`, then `python` on `PATH`. As on Linux, it keeps the last good result of this check in `board-check.json` (see the table below). The window uses the Cairo renderer, which starts sooner and uses less memory. To use another renderer, set `GSK_RENDERER` (for example to `gl`) or put `dcomp` in `GDK_DEBUG`. When no Python passes the board check, it prints `ASB runs without its window on this system: <reason> The engine runs for the phone and your other machines. Run asb doctor for details.` and exits with code 3; the engine keeps running. GTK works only in a signed-in desktop session: in an SSH session, it crashes at the first window. Autostart is the `ASB` value in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. It starts a hidden PowerShell tray script (`scripts\asb-tray.ps1`) with the `node.exe` that installed ASB. The script starts the engine first, then it builds the icon and the menu, so the engine starts sooner. It starts the engine with `--max-semi-space-size=16`, which limits the V8 young generation of the engine. The tray icon menu has **Open ASB**, **Messages**, **Usage**, a separator, **Copy phone pairing link**, and **Quit ASB**. **Open ASB** and a left click on the icon start `asb` with no console; they do nothing while an earlier launcher runs. When that launcher exits with code 3, the tray shows "ASB has no window on this PC. Run asb doctor." The tray starts the engine again after a failure, at most 5 times in 10 minutes. After that, it shows "ASB stopped after repeated failures." and stops. The Start menu link `ASB.lnk` (in your Programs folder, with the ASB icon) starts the same tray script with the `-Open` switch. With this switch, the script starts `asb` with no console. When `asb` exits with code 3 within 30 s, the script shows "ASB has no window on this PC. Run asb doctor." in a message box. `asb engine uninstall` removes the link only when ASB made it. When another `ASB.lnk` exists, ASB keeps it and prints `ASB kept <path>: it was not made by ASB.`

| File | Path |
| --- | --- |
| Settings, the colors and layout of the window (`theme.json`, `layout.json`), phone settings, the certificate, and the group | `%APPDATA%\asb` |
| Marks, pins, and `engine.log` | `%LOCALAPPDATA%\asb\state` |
| The engine runtime file (`service.json`) | `%LOCALAPPDATA%\asb\run` |
| The reader positions, the saved window check (`board-check.json`), and the compiled window code (`pycache`) | `%LOCALAPPDATA%\asb\cache` |

To let Codex tasks and Claude Code sessions message each other on Windows, install Bun, make it visible to the Codex app, and install ASB Bridge as on Linux:

```bash
asb bridge install --all
```

The bridge uses named pipes and key files on Windows. A send by full session reference to a session on the same PC works on Windows: before the first byte, the bridge checks that the pipe belongs to the target process of the same Windows user. `asb bridge link-claude` does not work on Windows. See [ASB Bridge on Windows](bridge/README.md#windows). With Bun on the engine's `PATH`, or in `%BUN_INSTALL%\bin` or `%USERPROFILE%\.bun\bin`, the engine also runs the message relay of the machine group. The engine of the Windows sign-in start has only the machine `Path`, and the Bun installer adds its folder to the user `Path` only, so the folder search is what finds Bun there. A send by full session reference to another machine of the group also works from Windows; its receipts need this relay.

ASB limits these folders to your Windows user with `icacls`. Windows has no POSIX file modes, so ASB does not check them there; it still refuses linked files. The phone certificate is `cert.pfx` with its passphrase in `pfx-pass` and the public part in `cert.cer`, which Windows PowerShell creates. A session link opens with `start` only when it has plain URL characters; ASB refuses the others with "This session link cannot open on Windows."

## Refresh and data limits

Both clients poll every two seconds while any unarchived root chat is Working, otherwise every five seconds. This uses the full list before filters. Monitoring continues when another app has focus. Source-change events can start a read sooner. The shared clean snapshot lasts five seconds, so a two-second poll can reconcile after about six seconds. Cold scans and source write delays can take longer.

Reads do not overlap. On Linux, ASB uses one watch for each directory under the session folders. It follows new and removed folders from the watcher events. Full folder walks remain for start, changed source paths, root replacement or structure invalidation, a large burst of folder changes, and the 60-second safety check. Missing or failed watch roots retry every five seconds without walking healthy folder trees. When a read brings no change, both clients get a `304` reply and skip list updates. Browser age labels still update once a minute. A background poll does not change the native Refresh button; the button is inactive only during a refresh that you requested. Successful native session actions request a normal refresh and keep one follow-up if a read is active. Discard still checks the current source before arming. Polling remains the fallback when a watcher or event stream fails. Rows stay keyed by chat ID and update in place. Native filters reuse rows and bounded column containers. The browser also reuses visible groups and keeps opens, retained focus, and project collapse choices across updates. Activity alone does not rewrite ASB state.

By default, ASB reads the latest `~/.codex/state_N.sqlite` in read-only mode, `session_index.jsonl`, matched `.codex-global-state.json` read marks, and rollout lifecycle signals. On Linux, Claude metadata comes from `$XDG_CONFIG_HOME/Claude/claude-code-sessions` or `~/.config/Claude/claude-code-sessions`. Only `local_*.json` metadata is used. Matched transcripts come from `~/.claude/projects`. Registered profiles use their selected folders and the same readers, source-change events, and polling fallback.

Remote Code metadata comes from approved session-list and watch response bodies in Claude's `Cache/Cache_Data`. ASB uses the newest cached response and exact cursor-linked updates. A watch without a full list contains only observed sessions; the source warning states this limit. The cache can be incomplete or old, including while Claude is closed. ASB does not fetch the remote list. Remote body decoding and parsing use one lazy worker with bounded queued reads. The first remote load has worker startup overhead. Shutdown and deadlines reject queued reads immediately. The worker closes after its active bounded parse returns; a replacement waits for the old worker to exit. A hung native parse can block that exit. Working and Waiting require an explicit worker state and a response observation within six hours. Missing state or a disconnected Remote Control bridge gives Unknown. Cloud sessions do not need a bridge connection. Remote work has no inferred start time or local folder; a safe cached Git repository name can identify the project.

Root chats are the list unit. Internal subagents stay grouped under their root. Reads are limited to 5000 records per source. ASB does not include orphan Codex rollouts that are absent from its local database.

Codex tail reads start at 64 KiB and grow to 256 KiB. On the first read of a larger log, ASB searches the bytes before the tail for question calls and reads lines only from such a call. When the tail has no lifecycle event, lifecycle and question checks scan the full log with bounded memory. Claude uses an 8 MiB transcript tail with complete lifecycle recovery when needed. After a guarded append, it reads new records from its in-memory checkpoint and keeps loaded questions and metadata. A valid final JSON record without a newline is visible and is read again on append. Truncation, replacement, equal-size changes, and detected boundary rewrites trigger recovery. The append guard assumes earlier bytes stay unchanged when a file grows. Large retained histories can make the first scan slow. In-memory caches reuse unchanged metadata. Local signal and lifecycle caches retain up to 5000 keys per enabled store, with shared values held once. Disabling, removing, or changing a store prunes its local cache ownership. Shared active data stays cached. Remote response-cache retention is separate. The engine saves its Codex and Claude reader positions in `~/.cache/asb/readers/positions.json`, with no message text and no paths, so that after a restart it reads only the new bytes of each Codex session log and of each Claude transcript that is larger than its tail. It also saves the tail result of each Codex log and the entries of the Claude Desktop cache folder that are not session lists, so that after a restart it does not read the tail of a log that did not change, and opens only the cache entries that can be a session list or watch.

See [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) for source modules and [Privacy](docs/PRIVACY.md) for the full data boundary.

## X11 scrolling limit

On the tested Debian 13 GNOME X11 stack, ASB has no proven safe 240 Hz scrolling fix. Keep the current Python workaround. The [investigation report](docs/benchmarks/x11-frame-timing-2026-10-13.md) records the measured results. See [the measured limitation and retest checks](SYSTEM_OVERVIEW.md#known-x11-frame-rate-limitation) before changing the distro or desktop stack. Resize lag remains unresolved.
