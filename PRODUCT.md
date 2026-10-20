# ASB product

<!-- impeccable:product-schema 1 -->

## Platform

Native desktop: Linux GNOME, GTK4 and Libadwaita. On Windows, ASB runs only the engine (statuses only, no window) for the phone and the machine group. The native window uses no browser or webview. The Impeccable platform enum has no GNOME value; do not substitute `web`, `ios`, `android`, or `adaptive`.

This file records ASB. The Agent Mission Control documentation is removed from this repository. `CHANGELOG.md` keeps the upstream release history.

## Users

The user works with many existing Codex and Claude Desktop Code sessions. The user needs to find a session, see its state, and open it in its own app. The user can run these sessions on more than one computer and wants one board for all of them.

## Product Purpose

ASB (Agent Switch Board) is a local session switcher and monitor. It reads existing session data. It opens existing sessions through each app's direct link. In an optional machine group, each ASB engine shows the sessions of the other machines as view-only cards, and sessions can message the sessions on the other machines.

## Operating Context

The native window can be a narrow sidebar or a wide desktop window. A local Node.js backend supplies the list through `127.0.0.1`. An optional user service can run this backend without the window. An optional Android companion shows the same list on a paired phone over the local network. It uses the off-by-default phone gateway with pinned TLS. The phone can open a chat on the PC and use the row actions. An optional machine group joins the ASB engines on your private LAN, ZeroTier, or Tailscale addresses with mutual TLS. ASB Bridge and the ASB message relay carry messages between Claude Code and Codex sessions, on one machine and between the machines of the group (Linux and Windows). Native and web clients refresh every two seconds while any unarchived root session is Working, otherwise every five seconds. This rule uses the complete list before filters and does not depend on ASB focus. Local source-change events wake a read. Reads do not overlap. A healthy source watcher permits reuse of a clean snapshot for up to five seconds; failed watches keep polling as a fallback. Successful native session actions request a normal queued refresh; Discard still validates current source state before arming. Native rows and bounded column containers are reused across filters. The native client skips unchanged cached text and action updates. The browser reuses rows by chat ID and its visible groups. Both clients use conditional dashboard reads; a `304` skips list updates, while browser age labels update once a minute. First load and source writes can exceed this cadence.

## Capabilities and Constraints

- List root Codex and Claude Desktop Code sessions. Also list root OpenCode 2 sessions, list only: OpenCode 2 has no link that opens one session, and it keeps permission asks and questions only in memory, so OpenCode has no Waiting. Search titles, folders, and provider names. Filter by app, state, archive status, Pending attention, or the drawer.
- Show Claude Code CLI and Codex CLI sessions, and the sessions of the other machines of the group, as view-only cards: they show but do not open. A remote card names its machine. Read, Unread, pins, the drawer, and Mute change only this machine's marks; Discard is refused. A machine that does not answer gives Unknown cards.
- Combine state checkboxes. All is the default; an empty selection hides all sessions.
- Use one separate, nonmodal native Preferences window. The toolbar button raises the existing window. Sessions holds app/state/archive filters, Show app pills, Persistent unread, search, and narrow-window Refresh; Appearance holds view, shared width, and colors; Profiles holds the existing source editor. Use left navigation at wide widths and tabs at narrow widths. Closing Preferences keeps ASB running and keeps form edits. Profiles loads on its first visit and after explicit actions, with no new timer or background scan.
- Pin sessions only in ASB. Keep pins first in saved order, with native drag reorder and keyboard menu movement. Sort a Working row by the start of its current task, so it does not move while it works. Do not import or change original-app pins.
- Select a provider with `cl:`/`claude:`, `cx:`/`codex:`, or `oc:`/`opencode:`. Type from a session row to search. Escape clears search and keeps explicit filters.
- Hold Ctrl to show number keycaps on the first nine whole cards that can open; Ctrl+1 to Ctrl+9 open that card in its app.
- States are Working, Waiting, Idle, and Unknown. Pending is an attention marker. It does not replace Working, Waiting, or Unknown.
- Use safe, matched local Codex metadata for native unread state. Missing or unmatched data means that read status is unknown.
- When native read status is unknown, mark a new successful Working-to-Idle completion that ASB observed. Do not mark historical Idle sessions on the first scan. Waiting requires user attention.
- **Unread** adds an ASB mark. The row panel (right-click, Menu, or Shift+F10) has an **Unread** switch: it is on for a current ASB dot or question attention, and turning it off runs Read; it is off when neither is present. Action-required waits have no ineffective Read action, so the switch is on and cannot change. It persists across native read-state changes. With Persistent unread off, a successful ASB open acknowledges local manual, completion, native, and question attention; a failed open retains it. Execution and original-app state do not change.
- **Persistent unread** is on by default when the saved setting is absent or invalid. An explicit saved false stays off. When on, ASB retains native, completion, and failure attention across source read and successful opens. A resolved question leaves no retained mark. Turning off **Unread** in the row panel clears it without changing execution or source data. Save the shared setting only in ASB state, separate from layout/theme.
- Current synchronous Codex input can block execution and show Waiting. Async questions add attention beside current Working or Idle. Human resumption supersedes old questions; goal/context continuation and partial replies preserve them. With Persistent unread off, open acknowledgment clears the local dot without resolving source input. Keep question and answer content out of the view.
- Read original SQLite, JSON, and transcript stores without changing them. Keep creator and account identity fields internal. Do not read credentials or call models.
- Save Pending and drawer state only in `$XDG_STATE_HOME/asb/pending.json`, or `~/.local/state/asb/pending.json`. Save custom colors only in `$XDG_CONFIG_HOME/asb/theme.json`, or `~/.config/asb/theme.json`.
- Save one shared target column width, optional view, and optional boolean `showAppPills` only in ASB's schema `1` `layout.json`. Old layouts hide app pills. View and width changes, including Reset width, keep this setting. Save errors keep its previous value. Native divider drag and the Appearance field change all columns. Compact is the default with 22px rows; Comfortable uses the chosen Workspace-first 68px layout. Scroll columns horizontally, with three complete Comfortable rows at 1080×248. Keep the same outer frame and no separate title/footer row.
- Use native Pending/Working/Drawer pills in both views. Codex/Claude/OpenCode pills are hidden by default; Show app pills in Sessions enables them, with text at wide widths and app icons at narrow widths. Hiding them keeps the app filter. No app selected or all three selected shows all; one or two select those providers. Pending combines with the other filters, except Drawer: turning one on turns the other off. Pills and the app filter in Sessions share one selection. Use × chips only for filters with no visible pill: a hidden app selection, restricted states other than Working alone, and Include archived. Changing app-pill visibility keeps filters.
- Hide unread marks while Working and keep them stored. Only question attention shows a `?` and makes a Working row Pending. Show Opening within the row, then restore its current title.
- **Discard result** applies once to the current Working task. A successful end skips its result attention and clears the arm; the next task uses normal rules. Keep manual Unread, questions, and failures. Use the approved hollow dot in the existing Comfortable Read slot and a passive Compact ring with the row-panel switch. It does not change state, Pending, sorting, or source-app read truth. Missing source observations remain an explicit limit.
- **The drawer** holds unread rows that the user wants out of the way, with no time limit. In the normal list a drawer row looks read: no dot, no Pending, sorted with the read rows. The Drawer pill shows the drawer rows as unread, with a plain occupancy dot that only the archive setting changes. The dot has no numeral; empty drawers hide it. Only a row with an unread dot can go in; a question, a required action in the original app, or Working cannot. The row leaves on take out, Read, Unread through the API, or a successful open with Persistent unread off. A newer result or failure, or a question, brings it out as normal unread and Pending; a native unread that is raised again with no new result does not. When no stored mark is left, the row leaves as read. A stopped task keeps the row; a Discard result end acknowledges completion and native marks, so a row with only such a mark leaves as read. Use the Comfortable drawer button beside Read and Pin, and the row-panel switch in both views. Save `drawer` and `drawerSeen` only in ASB's `pending.json`. It does not change state or source-app read truth. The web view shows a drawer row as read and has no drawer controls.
- When a usage limit stops a session, its card is greyed out and shows **Resets in** with a countdown (days and hours, for example `3d4h`, when the reset is 24 hours or more away). It is not Pending. At the reset it returns to normal at once.
- A message between two sessions shows as a short accent light from the sender card to the receiver card. ASB reads only who sent to whom and when. It never reads or shows message text. A message to or from a session on another machine plays between its remote card and the other card. ASB keeps no message queue: a message to a machine that is offline is refused at once.
- Force dark mode only in ASB. Use GNOME semantic colors by default. Validate, save, apply, and reset custom colors in both the main and Preferences windows without changing global GNOME settings.
- ASB has no execution client, model calls, quota cards, token cards, telemetry, or review jobs. The desktop has no pop-up notifications; the ASB server plays the Done, Needs input, and Failed sounds on the PC. The Android companion has phone notifications for Done, Failed, and Needs input.

## Brand Commitments

Keep the ASB name in native app identity and the approved Palatine disc icon. Keep native GNOME controls, dark mode, compact controls, and high session density. Use subdued gray Codex, Claude, and OpenCode row marks. Keep the session title and state primary. Use one draggable toolbar row with fixed Preferences and native Close at the right. Extra pills and × filter chips scroll horizontally. The disc is visible at widths of at least 320px. Below 320px, hide the disc and toolbar search control; typing and Preferences still open search. Wide windows show the search field; narrow windows use a search popover. Show no numeric counters in the main view. Keep the outer frame and no separate branding row.

## Evidence on Hand

The user approved option 2, Column Flow, from `.impeccable/options/index.html`. Those five studies use sample data and retain their original review notes. They are historical evidence, not current product authority.

The current implementation is in `scripts/asb-native.py` and `src/switchboard.mjs`. Native mock captures are in `.impeccable/review/horizontal/`. `ASB.md` records runtime, data limits, controls, and checks. `DESIGN.md` records the native design system; `.impeccable/briefs/column-flow.md` records this surface.

## Product Principles

- Keep original app data read-only.
- Show the evidence available. Keep unknown state explicit.
- Keep native unread state, observed completion, and manual ASB marks distinct.
- Open the existing session in its original app.

## Accessibility & Inclusion

Keep visible native focus, keyboard row movement, text state labels, full row details, and accessible control names. Custom text, muted text, and accent colors must pass the implemented contrast checks. Do not use color alone to show state.

Working time uses the current source task/request start only. Compact shows it beside Working; Comfortable uses the right metadata label. A local two-second clock updates labels and accessible text without a data read. The native Unfolded card tooltip computes current text when queried and reuses one row-owned content widget when its model/theme is unchanged. Changed content rebuilds; palette changes and row release clear the cache. It shows full path/title, state/time, app/source, and one optional indicator note, with the native frame and no source read. The label clock stops when the full unarchived list has no Working session. Idle age labels refresh once a minute. Seconds show below one hour; longer durations show hours and minutes. Unknown start and non-Working states have no running timer. The backend sends a stable `workingSinceMs`, not elapsed time.
