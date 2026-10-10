# ASB product

<!-- impeccable:product-schema 1 -->

## Platform

Native desktop: Linux GNOME, GTK4 and Libadwaita. The native window uses no browser or webview. The Impeccable platform enum has no GNOME value; do not substitute `web`, `ios`, `android`, or `adaptive`.

This file records ASB. The Agent Mission Control documentation is removed from this repository. `CHANGELOG.md` keeps the upstream release history.

## Users

The user works with many existing Codex and Claude Desktop Code sessions. The user needs to find a session, see its state, and open it in its own app.

## Product Purpose

ASB (Agent Switch Board) is a local session switcher and monitor. It reads existing session data. It opens existing sessions through each app's direct link.

## Operating Context

The native window can be a narrow sidebar or a wide desktop window. A local Node.js backend supplies the list through `127.0.0.1`. Native and web clients refresh every two seconds while any unarchived root session is Working, otherwise every five seconds. This rule uses the complete list before filters and does not depend on ASB focus. Local source-change events wake a read. Reads do not overlap. A healthy source watcher permits reuse of a clean snapshot for up to five seconds; failed watches keep polling as a fallback. Successful native session actions request a normal queued refresh; Discard still validates current source state before arming. Native rows and bounded column containers are reused across filters. The native client skips unchanged cached text and action updates. The browser reuses rows by chat ID and its visible groups. Both clients use conditional dashboard reads; a `304` skips list updates, while browser age labels update once a minute. First load and source writes can exceed this cadence.

## Capabilities and Constraints

- List root Codex and Claude Desktop Code sessions. Search titles, folders, and provider names. Filter by app, state, archive status, Pending attention, or the drawer.
- Combine state checkboxes. All is the default; an empty selection hides all sessions.
- Pin sessions only in ASB. Keep pins first in saved order, with native drag reorder and keyboard menu movement. Sort a Working row by the start of its current task, so it does not move while it works. Do not import or change original-app pins.
- Select a provider with `cl:`/`claude:` or `cx:`/`codex:`. Type from a session row to search. Escape clears search and keeps explicit filters.
- States are Working, Waiting, Idle, and Unknown. Pending is an attention marker. It does not replace Working, Waiting, or Unknown.
- Use safe, matched local Codex metadata for native unread state. Missing or unmatched data means that read status is unknown.
- When native read status is unknown, mark a new successful Working-to-Idle completion that ASB observed. Do not mark historical Idle sessions on the first scan. Waiting requires user attention.
- **Unread** adds an ASB mark. The row menu shows **Read** for a current ASB dot or question attention and **Unread** when neither is present; action-required waits have no ineffective Read action. It persists across native read-state changes. By default, a successful ASB open acknowledges local manual, completion, native, and question attention; a failed open retains it. Execution and original-app state do not change.
- **Persistent unread** is off by default. When on, ASB retains attention across source read/resolution and successful opens. **Read** in the row menu clears it without changing execution or source data. Save the shared setting only in ASB state, separate from layout/theme.
- Current synchronous Codex input can block execution and show Waiting. Async questions add attention beside current Working or Idle. Human resumption supersedes old questions; goal/context continuation and partial replies preserve them. Default open acknowledgment clears the local dot without resolving source input. Keep question and answer content out of the view.
- Read original SQLite, JSON, and transcript stores without changing them. Keep creator and account identity fields internal. Do not read credentials or call models.
- Save Pending and drawer state only in `$XDG_STATE_HOME/asb/pending.json`, or `~/.local/state/asb/pending.json`. Save custom colors only in `$XDG_CONFIG_HOME/asb/theme.json`, or `~/.config/asb/theme.json`.
- Save one shared target column width and optional view only in ASB's `layout.json`. Native divider drag and a menu field change all columns. Compact is the default with 22px rows; Comfortable uses the chosen Workspace-first 68px layout. Scroll columns horizontally, with three complete Comfortable rows at 1080×248. Keep the same outer frame and no separate title/footer row.
- Use native Codex/Claude/Pending/Working/Drawer pills in both views. No app selected or both selected shows all; one selects that provider. Pending combines with the other filters, except Drawer: turning one on turns the other off. Pills and the app menu share one selection.
- Hide unread marks while Working and keep them stored. Only question attention shows a `?` and makes a Working row Pending. Show Opening within the row, then restore its current title.
- **Discard result** applies once to the current Working task. A successful end skips its result attention and clears the arm; the next task uses normal rules. Keep manual Unread, questions, and failures. Use the approved hollow dot in the existing Comfortable Read slot and a passive Compact ring with row-menu actions. It does not change state, Pending, sorting, or source-app read truth. Missing source observations remain an explicit limit.
- **The drawer** holds unread rows that the user wants out of the way, with no time limit. In the normal list a drawer row looks read: no dot, no Pending, sorted with the read rows. The Drawer pill shows the drawer rows as unread, with a count that only the archive setting changes. Only a row with an unread dot can go in; a question, a required action in the original app, or Working cannot. The row leaves on take out, Read, Unread through the API, or a successful open with Persistent unread off. A newer result or failure, or a question, brings it out as normal unread and Pending; a native unread that is raised again with no new result does not. When no stored mark is left, the row leaves as read. A stopped task keeps the row; a Discard result end acknowledges completion and native marks, so a row with only such a mark leaves as read. Use the Comfortable drawer button beside Read and Pin, and row-menu actions in both views. Save `drawer` and `drawerSeen` only in ASB's `pending.json`. It does not change state or source-app read truth. The web view shows a drawer row as read and has no drawer controls.
- Force dark mode only in ASB. Use GNOME semantic colors by default. Validate, save, apply, and reset custom colors without changing global GNOME settings.
- ASB has no execution client, model calls, quota cards, token cards, telemetry, notifications, or review jobs.

## Brand Commitments

Keep the ASB name in native app identity and the approved Palatine disc icon. Keep native GNOME controls, dark mode, compact controls, and high session density. Use subdued gray Codex and Claude row marks. Keep the session title and state primary. Use one draggable toolbar and no separate branding row.

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
