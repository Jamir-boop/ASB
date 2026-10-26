# Plan: Roundtable messages board and Usage board

Status: approved by the user on 2026-10-26 ("I like the whole approach", "We're ready to go"). The previews are git-ignored and use sample data:

- `.impeccable/options/roundtable-usage-2026-10-26/index.html`: the two views.
- `.impeccable/options/board-windows-2026-10-26/index.html`: the three windows, how the user opens each one, the seat limit, and the message thread.

## Goal

Two read-only views for the whole machine group:

- **Messages (Roundtable):** each machine is an arc, each session is a seat, and each bridge conversation is a chord. A live message is the accent light that the Board already uses. A ledger shows the message counts by status, by app pair, and by machine pair.
- **Usage:** the tokens and the API price of all agents on all machines, as in T3 Code's usage view, with a machine dimension.

Neither view acts on sessions. Both are optional: a user who never opens them sees no change.

## Windows

The Board stays narrow. It gets no new toolbar button and no new width. Messages and Usage each get their own window:

| Window | Size at first open | Content |
| --- | --- | --- |
| Board | as now | the cards |
| Messages | 968 x 760 | the Roundtable and its ledger |
| Usage | 948 x 760 | the usage view |

- Each window is nonmodal, has one instance, and remembers its size. Opening it again raises it.
- Closing Messages or Usage does not close ASB. Closing the Board works as now.
- DESIGN.md forbids a browser or webview in the native window. Thus the views are native GTK: the round table and the charts are `Gtk.DrawingArea` and `Gsk` paths. The light reuses the Board's flight code (`Gsk.PathBuilder`, GTK 4.14). GTK 4.12 and animations off show no light.
- Windows uses the same board code (MSYS2), so it gets the same windows.

## How the user opens them

| Place | Change |
| --- | --- |
| Board ⋮ button | Becomes the main menu: `Messages` (Ctrl+M), `Usage` (Ctrl+U), a separator, `Preferences` (Ctrl+,). Today it opens Preferences directly. |
| Keys | Ctrl+M opens Messages, Ctrl+U opens Usage, from any ASB window. Ctrl+W closes Messages or Usage. Ctrl+Shift+U stays free (GTK Unicode input). |
| Tray menu | `Open ASB`, `Messages`, `Usage`, a separator, `Quit ASB`. |
| Row panel of a card | `Show messages` after `Open in <app>`. It opens Messages with the thread of that session. |

## Board toolbar

The toolbar shows only icons at every width, as the narrow toolbar does now and as the preview shows:

- The disc, the search button (`system-search-symbolic`, it opens the search popover), the Drawer and Filters pills without their text labels, the filter chips, the ⋮ main menu, and Close.
- The search field in the toolbar at 680px or more goes away, and the `Drawer` and `Filters` labels no longer show at any width. Typing on the Board and the Preferences search action still start a search.
- No other change: Refresh stays an icon before ⋮ at 680px or more, and the active filter chips keep their text, because they show which filters are on. Below 320px the disc and the search button hide, as now.
- Update the toolbar paragraph of `DESIGN.md`.

The same message shows in two places at once: the Board light flies between the two cards, and the Roundtable light flies along the chord. A message that was not sent has no Board light (the Board has only receiver records).

## Seat limit

The Roundtable seats only the most recent sessions:

- 12 seats (chosen on 2026-10-26). At 16 and 20 in a 968px window, some seat labels hide. A pin always shows its label on hover or focus.
- Order: the time of each session's newest message in the period. A selected session always has a seat.
- Chords join only seated sessions. The ledger counts all messages of the period.
- The toolbar shows `12 of 18 sessions`.
- When a new session takes a seat, the seats move along the circle (300ms), then the light flies.

## Message thread

- A click on a chord (or Enter on a focused chord) replaces the ledger with the thread of that pair: the newest 60 messages, oldest at the top, with the day, the time, the sender, the status (when not Accepted) and the text. Escape, the back button, or a click on an empty part of the table restores the ledger.
- A click on a seat (or `Show messages` on the Board) shows the thread of that session with all its partners.
- A click on a Recent row opens the thread of its pair at that message.
- Text shows only for messages that this machine sent or received. Other messages show `Body not shared`. The text never goes to the peers or the phone.

## Data on each machine (engine)

**Messages.** The engine reads the `messages` table of each bridge database (`<dataDir>/plugin-state/asb-bridge/<appId>.sqlite`), read-only. For counts it selects only `id`, `peer_id`, `direction`, `status`, `status_reason`, `kind` and `created_at`. Outgoing rows give each message once, so a message is not counted twice. New loopback routes:

- `GET /api/activity/messages?period=24h|7d|30d` gives the machines, the seats, the hourly or daily buckets, and one record per message (sender and receiver seat, time, status group, and a fixed reason), with no text.
- `GET /api/activity/thread?a=<seat>&b=<seat>&period=` (or `?seat=` for one session) gives the newest 60 messages: time, sender, receiver, status, and the text of local messages.

**Usage.** Port the usage logic of T3 Code (MIT, copyright T3 Tools Inc.) to plain Node modules in `src/`:

| T3 Code file | What ASB keeps |
| --- | --- |
| `apps/server/src/provider/Drivers/codexUsage.ts` | Codex `token_count` deltas, and the model that is carried forward from `turn_context` |
| `apps/server/src/provider/Drivers/claudeUsage.ts` | Claude `message.usage`, one count per message and request ID |
| `apps/server/src/usage/usagePricing.ts` | the cost formula, and the fallback of missing cache rates to the input rate |
| `apps/server/src/usage/usageAggregation.ts` | hourly and daily totals per app and model |
| `apps/server/src/usage/usageScanCache.ts` | a per-file cache by size and change time, so a refresh reads only new bytes |
| `apps/server/src/usage/UsageService.ts` | the run-time download of the LiteLLM price list (`src/usage-rates.mjs`) |

ASB does not copy the whole repository: it is a pnpm monorepo of 28,603 files on Effect and React, and ASB has no build step and few dependencies. The ported files keep the MIT notice in their header and in a new `THIRD_PARTY_NOTICES.md`, which goes into the `files` list of `package.json`.

**Prices.** Like T3 Code, ASB downloads the LiteLLM price list at run time (changed during the build; see below). Only a Usage report starts the download, in the background. The engine keeps the rates in a 24-hour disk cache (`~/.cache/asb/usage/usage-model-rates.json`). It tries the GitHub raw URL, then the GitHub API URL, with a 10 s timeout and a 32 MiB limit, and waits at least 60 s after a failed download. A model without a price shows `Unpriced` and is not in the cost. The Usage view shows `Prices: LiteLLM, Oct 26`, `Prices: loading`, or `Prices: not available`. ASB ships no price snapshot.

**Limits.** T3 Code's Limits tab (5-hour and weekly windows) reads account tokens. ASB reads no credentials, so ASB does not add it.

New loopback route: `GET /api/activity/usage?period=24h|7d|30d|90d` gives the hourly records per app and model (token parts and cost).

## Machine group

New member route (mutual TLS, an active member only, `no-store`):

- `GET /peer/v1/activity?period=`: the member's local message records (ID, sender and receiver, time, status group, fixed reason, and which bridge rows it has), its usage token parts per app, model and UTC hour, and its scan counts.

There is no member thread route (changed during the build): a thread shows text only for messages of this machine. The reply has no text, paths, titles, costs, or session IDs other than the IDs that the group already shares through `/peer/v1/sessions`. The asking engine asks each member in parallel with a 5 s timeout and a 16 MiB reply limit, and keeps each reply for 30 s per period. The engine merges all members into one view. An offline member keeps its last reply with its time (`Last report Oct 25, 14:30`).

The phone gateway forwards only the messages and usage reads (`/phone/v1/activity/messages` and `/phone/v1/activity/usage`, changed during the build for the Android screens). These replies have no message text. The thread route is never reachable from the phone.

## Steps

1. Engine: the bridge counts, the thread route, the usage port, the price snapshot, the loopback routes, and tests with synthetic transcripts and databases.
2. Machine group: the two member routes, the merge, and the stale-member state, with tests.
3. Native windows: Messages and Usage, the main menu, the keys, the tray items, and `Show messages`, checked on the hidden display with synthetic data.
4. Docs: `SYSTEM_OVERVIEW.md`, `README.md`, `CHANGELOG.md`, `DESIGN.md`.

## Decisions (2026-10-26)

1. Separate windows for Messages and Usage.
2. 12 seats.
3. The thread shows the text of local messages, as in the preview.
4. A price snapshot in each release, as recommended. Replaced on 2026-10-26: ASB downloads the prices at run time, like T3 Code (see below).
5. The Board toolbar shows only icons.

## Changes during the build

- No member thread route: `/peer/v1/activity/thread` does not exist. A thread shows the text only of messages that this machine sent or received; the other messages show `Body not shared`.
- The phone gets the messages and usage reads with counts, statuses, titles, and token usage only, never message text. The Android app has Messages and Usage screens (the ⋮ main menu of the sessions screen, and `Show messages` in the session panel).
- The GTK windows have no second title in the toolbar: the header bar shows the window title, and the toolbar under it starts with the period buttons.
- Prices are downloaded at run time like T3 Code. The user decided this on 2026-10-26 ("okay download litellm just like t3 code"). This replaces the price snapshot of decision 4: there is no `src/usage-prices.json` and no release script for it. The download runs only while the Usage view is used, with a 24-hour disk cache.
- The windows keep only their size, not their position, because GTK 4 has no window position API. The sizes are in `activity-windows.json`, not in `layout.json`, because older ASB versions reject unknown keys in `layout.json`.
- The views are custom drawn widgets (`Gtk.Widget` subclasses that draw in `do_snapshot` with `Gsk` paths), not `Gtk.DrawingArea`. The Messages light has its own drawing code in the round table (`RoundTable.fly` and `snapshot_lights`); it does not reuse the Board's card light code.
- Android: TalkBack reaches each seat of the round table in circle order through targets over the pins, and the App column of the Models table shows only the app mark.
