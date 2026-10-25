# Changelog

ASB has its own release series. The retained Agent Mission Control releases are recorded separately below.

## Unreleased

- Added the ASB Bridge state of each profile to Preferences > Profiles, which is now one list in place of the wide table that scrolled sideways. Each row shows the app, the chat count, and the bridge state of the profile on this machine (for example **Ready**, **Hooks not trusted**, **Not installed**, or **Old version**). A row opens the profile in a dialog with the edit form, the next step for its bridge, and **Install** or **Update** when ASB can do it. A disabled profile shows **Off**, because ASB checks the bridge only for enabled profiles.
- Added a Bridge line to each machine in Preferences > Machines, with the ASB Bridge state of its enabled profiles, for example `Bridge: Codex ready · OpenCode old version`. A machine with an older ASB shows `Bridge: unknown, needs ASB 1.12 or later` and the number of its live sessions.
- Added the local routes `GET /api/bridge` and `POST /api/bridge/install` (with the source token) and the member route `GET /peer/v1/bridge`, which sends no path. The engine checks the bridge with `asb bridge status --json` only when a request asks, and keeps the result for 60 s. The phone gateway does not forward these routes.
- Added `--claude-home <path>` to `asb bridge status` (you can give it more than once). The JSON output also has the skill state of each Claude home and the session IDs of the live receivers.
- Changed `asb setup` so that it asks which parts to set up: the board and ASB Bridge, the board only, or the bridge only (`--only board` and `--only bridge` choose without the question). The bridge part installs ASB Bridge for each app that does not have it and never changes an existing install. It skips a Codex home when the running Codex cannot find Bun, because the install would stop Codex from starting tasks. Before, setup only printed `asb bridge install --all`.
- Fixed Preferences, which showed the next page after you made a narrow window wide again while a tab had the keyboard focus. When the focused tabs or sidebar hid, GTK moved the focus one item too far, and the sidebar opened the page of that item (for example **Phone** in place of **Profiles**). Now the focus goes to the item of the page that shows: its tab in a narrow window, and its sidebar row in a wide window.
- Fixed a crash risk of the board when a session left the board while its row panel was open or closing, for example when you deleted the session in its app or turned its profile off. GTK freed the card with the panel still on it, and the panel then pointed to freed memory (the log showed `Finalizing GtkListBoxRow ..., but it still has children left`). The board now closes the panel and takes it off the card first.

## ASB 1.11.1 - 2026-10-24

- ASB Bridge is still `0.8.0` in this release.
- Fixed the row panel, which closed after a pointer click on **Pin**, **Mark read**, **Put in drawer**, and its other actions. While the action ran, the panel made its rows insensitive. GTK then moved the pointer out of the panel: the panel closed, and a second click without a pointer move went to the board under it. Now the rows stay sensitive while the action runs. They look dimmed and do nothing until it ends, as the card buttons do. **Mute** and **Unmute** still close the panel.
- Fixed **Mute** and the other rows of the row panel, which did nothing after a normal right-click on X11. The panel opened when the right button went down. When the button was still down as the panel opened, GDK took the next click in the panel for a click outside it: it closed the panel and dropped the click. The panel now opens when the right button is released. **Mute** and **Unmute** now also close the panel, so that you see the mute icon on the card at once.
- Fixed the mute icon of a card, which was too faint to see, so that a card looked the same after **Mute**. The icon had 35% of the gray of the folder name (about 1.9:1 on a black board). It now has the color of the folder name next to it, also on a read Idle card, a card that runs elsewhere, and a card with a usage limit, so it has the contrast of that name (at least 4.5:1).
- Fixed the copy button of a Comfortable card after a card move. When another card moved while the pointer rested on the copy button, the wheel scrolled the board in place of switching between Relative and Absolute, until the pointer left the button and came back. After a move, the board now checks whether the pointer is still on the button.
- Changed the text of Waiting cards to the colors of Idle cards: on the board (also in the tooltip), on the phone (also in the session inspector), and in the web view. Before, the word `Waiting` had the warning color, or the accent color with a custom palette. The `?` or dot and the place of Waiting cards at the top still show that a session waits for you.
- Changed the board so that it no longer lists the side chats that `/btw` makes in the Claude app (Claude Desktop Code, also under another config folder), open or archived. ASB knows them by `spawnedFrom.btw` in their session file. Hand-offs, forks, and sessions that another session started stay on the board. Codex side chats were never on the board: Codex does not save them.
- Fixed the message relay on Windows with a Bun that npm installed (`npm i -g bun`). That install puts only the npm shim `bun.cmd` on `PATH`, and Node.js cannot start a `.cmd` file without a shell, so the relay never started, and the engine log got the line `ASB cannot check the message relay.` at each check. On Windows, the engine and `asb doctor` now take only a `bun.exe` from `PATH`, and then look in the folders of the Bun installer as before. With only `bun.cmd`, the engine log, `asb group status`, and `asb doctor` now say that Bun was not found.
- Fixed `asb doctor` on Windows for an MSYS2 that is not in `C:\msys64`. When the board Python is the UCRT64 Python of another MSYS2 folder (from `ASB_PYTHON` or `python` on `PATH`, for example `C:\tools\msys64\ucrt64\bin\python.exe`), the `pacman` command and the check for `pacman.exe` now use that folder. Before, the doctor told you to install a second MSYS2 in `C:\msys64` and to put the board packages there, and the board still did not start.
- Changed the glibc settings of the engine start so that your own values stay. When `MALLOC_ARENA_MAX`, `MALLOC_MMAP_THRESHOLD_`, or `MALLOC_TRIM_THRESHOLD_` is set when the engine starts (also to an empty value), the engine uses your value, and the message relay and the apps that ASB opens get it too. Before, ASB replaced it with its own value and then removed it from the environment of the relay and the apps. A value of yours that is the same as the ASB value is still removed for them.
- Changed the quit marker `stopped.json`. It now holds only `schema` and the SHA-256 of the source token: each engine run has a new token, so the PID added nothing. An ASB window of this version also closes at once when an ASB 1.11.0 engine quits (its marker has the PID).
- Fixed the `Done` chip of the Android live notification when the phone clock changes. The chip now counts its 8 s with the monotonic clock of the phone, which also counts deep sleep (`SystemClock.elapsedRealtime`). Before, a clock that went back during the 8 s kept `Done` until a later change of the notification, and a clock that went forward ended it too soon. Also, the redraw at the end of the 8 s could come 1 ms before the end, because two clocks round to milliseconds at different points, and then `Done` stayed until the next update.
- Removed six fields of the session rows of `GET /api/dashboard` that no ASB code reads: `inCodexSidebar`, `defaultOpenMode`, `desktopName`, `hasUnreadTurn`, and `openLabel` of Codex rows, and `hasUnreadTurn`, `awaitingReview`, and `openLabel` of Claude Desktop rows. The board, the Android app, and the machine group do not use them. A script of your own that reads these fields of `/api/dashboard` does not get them now.
- Fixed the placeholder processes of the message relay (one `cat`, or `findstr.exe` on Windows, for each session of another machine), which got the source token of the engine in their environment for as long as the relay ran. The relay now starts them with its environment without `ASB_SOURCE_TOKEN`.
- Fixed ASB Bridge for OpenCode at its limit of 24 receivers. A new session could close the receiver of a session that another agent waited on (`notify_when_idle`), and that agent then got the notice that the session ended while the session still ran. The limit now uses the same rule as the 12 h expiry: it closes only a receiver with no turn, no held message, and no agent that waits on it.
- Changed the ASB Bridge OpenCode plugin so that it asks OpenCode for a session only for the events that it uses. OpenCode streams many events during a turn (text, tool, and step events), and before, each of them caused one or more `session.get` calls.
- Changed `asb bridge install` so that it prints only the next steps of the targets that it installed. `asb bridge install --opencode` no longer tells you to trust the Codex hooks and to restart Codex. The last line now says to run the install command again with the same targets after an ASB upgrade, because `asb bridge install` with no target only lists the targets. The installed OpenCode plugin folder now has the mode `0700`, so only your user can read it.

See [ASB 1.11.1 release notes](docs/releases/v1.11.1.md) for downloads, upgrades, and check limits.

## ASB 1.11.0 - 2026-10-23

- ASB Bridge is `0.8.0` in this release.
- Fixed a crash of the Android app. When you sent a message to a busy Claude Desktop Code session, Claude Desktop kept the message in a `waiting-input/local_<id>.json` file next to the session file, and the engine read that file as a second session with the same row ID. The session list of the app needs unique row IDs, so the app stopped. The engine now does not read `waiting-input/` (its files hold message text, not session data), and the app keeps only the first row when a dashboard has a row ID two times.
- Added Android 16 Live updates to the live notification of the Android app, so that HyperOS can show it in its island. The chip shows `Done` with a check mark for 8 s after a session gets a Done result, else the number of pending sessions (a question mark when one needs input, else a filled disc), else the number of working sessions (an open ring). When nothing is pending or working, or the PC does not answer, the notification is not a Live update and looks as before. The expanded notification lists the Working sessions with `BigTextStyle`, because Live updates do not accept `InboxStyle`. The app now asks for the normal permission `POST_PROMOTED_NOTIFICATIONS`. A phone without Live updates shows the same notification.
- Changed the in-app messages of the Android app (for example `Opened on <PC>` after a good Open, and errors) to a small dark pill over the toolbar, the shape of the HyperOS island. A tap closes it. Before, they showed in a near-white strip with black text at the bottom of the dark app, because the theme did not set the Material colors that the strip uses.
- Changed the order of the counts in the live notification of the Android app: Pending first, then Working, then the number of sessions (for example `1 pending · 2 working · 721 sessions`), so that the counts that need attention are first.
- Added sends by session reference from Claude Code sessions. Before, the Claude Code `bridge` skill said that an `asb:1/...` reference is not a `SendMessage` target and that only a Codex task or an OpenCode session can send to it, so a Claude Code session refused a send to a reference. Claude Code has only its native `ListAgents` and `SendMessage`. Now `asb agent resolve-session <reference>` also gives the `SendMessage` name of the session: the text output has the line `Send name: <name>` (or `Send name: none (the session is not open here, or its name is not unique)`), and `--json` has `sendName`. The CLI sends the Claude config folder of the caller (`CLAUDE_CONFIG_DIR`, else `~/.claude`) as the new optional `configDir` field of `POST /api/agent/resolve-session`. The engine reads the live session registry in that folder only when the folder is private, and gives the name only when exactly one live record has a native session ID of the board row (for a session on another machine, one `asb-relay` record) and no other live record has that name. The route still sends nothing and writes nothing. Rule 7 of the skill now says to send to that name, or else to tell the user; rule 4 is shorter, so the skill stays under 300 tokens. Run `asb bridge install --claude` to get the new skill.
- Changed `asb bridge status` so that it says when an installed bridge skill is out of date. `skill ok` meant only that the installed files match their own install record, so a skill that an older ASB installed still showed `skill ok` after an update, with the old rules. Now the status compares the install record with the skill of the installed ASB package: the text shows `skill ok (current)` or `skill ok (out of date: run asb bridge install <target>)`, and `--json` has `skillCurrent` (`true`, `false`, or `null` when the skill is not `ok`) for each Codex home, Claude, and OpenCode. `asb bridge install` still updates such a skill without `--force`.
- Changed the board so that it stays open when the engine restarts, for example after `systemctl --user restart asb.service` or an install that restarts the engine. Before, the launcher closed the board when the engine process ended, because a new engine has a new source token. Now the launcher waits up to 20 s for a new engine. When the new engine has the same ASB version and the same package folder, the launcher sends the board the new address and token on its stdin, and the board reconnects: the same window, with its filters, scroll, and Preferences. Another version or folder, or no engine in 20 s, closes the board as before, so that an update never leaves old board code with a new engine. A quit (Quit ASB in the tray, Quit engine in the board, or `asb engine stop`) still closes the board at once: the engine writes the private marker `stopped.json` (its PID and a SHA-256 of its token) only for that stop request.
- Fixed the message light of the board, which the user could not see when a message came with a card move. A message usually makes the receiver start Working, so its card moves next to or above the sender's card, and the light flew during that move between the moving cards. The two cards crossed, so the light went one way, came back, and stopped almost where it started. Now a light that comes during a card motion starts when the motion ends, between the final card places. The look and the timings of the light do not change.
- Fixed the message light of the board for OpenCode sessions. A message that an OpenCode session sent, or that an OpenCode session received, never made the light fly between the two rows, on one machine or across the machine group. An OpenCode session sends with its bridge ID (UUID v5 of `opencode:<ses_...>`), but its row had only its session ID as a message key, and ASB did not read the messages that the OpenCode plugin of ASB Bridge received. Now the row has both keys, and ASB reads the receiver view of the plugin database (peer ID, status, time, and kind; never the text) in `<OpenCode state>/plugin-state/asb-bridge/`. A machine of the group gets the light for the OpenCode sessions of a member only when that member has this fix too.
- Fixed the `from-mode` of messages that an OpenCode session sends through ASB Bridge. The plugin read the OpenCode permission rules with the fields `pattern` and `permission`, but OpenCode 2.1.x uses `action`, `resource`, and `effect`, and a rule with the action `*` matches any action. So the mode was always unknown, and the messages had no `from-mode`. Claude Code holds such a message in a session that bypasses permissions, and in the Claude Desktop app it then expires: a message from OpenCode never reached such a session. The plugin now reads the 2.1.x rules of the agent of the session (the first agent when the session names none), then the rules of the session (the last matching rule wins, as in OpenCode, and the older fields still work). So a session of the default `build` agent sends `from-mode="bypass"`, and a session of the `plan` agent, or with its own `ask` rule, does not. The real OpenCode test checks both agents.
- Added sends by session reference to Claude Desktop Code sessions (`claude-local` references), on the same machine and from another machine of the group. Before, ASB Bridge refused such a reference with `unsupported-type`, because the engine could not check the Desktop session again at the write. The engine now binds the reference to the one live registry record whose `hostSessionId` is the Desktop session ID. That record must come from the Claude Desktop app (`claude-desktop` or `claude-desktop-3p`), and its CLI session ID must be the current or a prior CLI session ID of the board row. The engine keeps these IDs on the row in memory only: the dashboard API, the phone, and the other machines never get them. ASB Bridge checks the `hostSessionId` of the record again before it connects and before the first byte. A Claude source that shares its session registry with another Claude source (a linked `sessions` folder) can now get these sends, because the Desktop session ID names one session. An older ASB Bridge on the same machine gets `host-check-required` (update ASB Bridge); an older ASB on the other machine refuses with `unsupported-type`.
- Fixed three problems of the ASB Bridge OpenCode plugin, found with the OpenCode CLI on Windows. The placeholder process of a session (`findstr.exe`) got a console window of its own, because the background service of the OpenCode CLI has no console; closing that window ended the placeholder, and the session could then not send and was not visible to other sessions. The plugin now starts it with no console on Windows. A session row showed the folder of the OpenCode server instead of the folder of the session (the plugin read a `cwd` field that OpenCode sessions do not have), and a session in a second folder registered through the plugin instance of the first folder. A row now shows the `location.directory` of the session, and each session uses the instance of its own folder. The OpenCode `bridge` skill said that an `asb:1/...` reference is not a `send_message` target, so a model refused to send; the OpenCode tool takes `reference`, and the skill now says to use it. The real OpenCode check now also starts a session in a second folder and checks its folder, its placeholder, and a delivery to it.
- Fixed `asb bridge install` and `asb bridge uninstall` so that one Codex home that fails no longer stops the other targets. On Windows, a running Codex keeps the plugin cache folder in use (its bridge server runs in that folder), so `codex plugin add` and `codex plugin remove` fail with `Access is denied` (os error 5) or `being used by another process` (os error 32), and the command stopped before Claude and OpenCode. Now the command prints a warning for that home, does not change its skill, continues with the other Codex homes, Claude, and OpenCode, and exits 1. On Windows, the warning for these two errors also says to close Codex and run the same command again.
- Fixed the cleanup of the ASB Bridge OpenCode plugin, which OpenCode never ran. OpenCode calls the value that the plugin `setup()` returns as a function, but the plugin returned an object with a `cleanup` method. `setup()` now returns the cleanup function. When OpenCode reloads a location (for example `POST /api/location/reload`), the plugin now removes the receivers, registry rows, and placeholder processes of that location, and a session registers again at its next turn. Before, the old receivers stayed until the OpenCode process ended. The real OpenCode check (mock model) now reloads the location and proves the cleanup, the new registration, and a delivery after it. Its old step changed the plugin file, which proved nothing: OpenCode does not reload a plugin when its file changes.
- Fixed `asb bridge status` on Windows, which showed the Codex marketplace folder with the `\\?\` prefix (the verbatim path form that Codex saves). The text and `--json` status now show `C:\x` for `\\?\C:\x` and `\\server\share` for `\\?\UNC\server\share`; other folders do not change. `asb bridge install` also compares the folder without the prefix, so it no longer removes and adds the `asb` marketplace again when the folder is the same.
- Fixed three small problems of the toolbar **Filters** popover, found on Windows. At the narrowest board, the popover went about 25 px past the left edge of the board, and the window edge cut its corner; it now stays at least 8 px inside the board, and its arrow still points at the **Filters** pill. When the profile list scrolls, the scroll bar no longer covers the **Include archived** switch: the list has a 10 px end margin. The pill tooltip no longer covers the first row while the popover opens: the tooltip is off while the popover is open, and comes back with the same text when it closes.
- Fixed four problems of the toolbar **Filters** popover. Space did not turn the **Include archived** switch on or off; now Space and Enter do. The popover moved sideways while you selected, because each new chip made the search field narrower and moved the **Filters** pill; now the chips change when the popover closes, and the cards, the check marks, and the accessible description still change at once. At wide widths, one resize (for example Windows Snap or a tiling window manager) could not make the window narrower than 515 px; the search field now has a low minimum width and a natural width of about 240 px, so that minimum is about 350 px. The **Filters** pill no longer uses the accent color when a filter is active: the chips show the active filters. **Drawer** keeps the accent while it is on.
- Added OpenCode 2 sessions to ASB Bridge `0.8.0`. The OpenCode plugin registers an active OpenCode session as a receiver: at the plugin start, up to 8 sessions that changed in the last 30 minutes, and later each session that starts a turn. Claude Code sessions and Codex tasks then list it as `opencode-<title>-<suffix>` and can send to it, and a message starts a turn in that session. The OpenCode session lists and sends with the `asb_bridge` tools. Each receiver has a small placeholder process for the PID of its registry row (`cat` on Linux, `findstr.exe` on Windows). There are at most 24 receivers; a receiver goes after 12 hours with no activity, when its session is archived, or when the plugin stops. Two registrations of one session at the same time share one receiver, and the plugin cleanup waits for a registration that is still starting. `asb bridge install --opencode` installs the plugin and the OpenCode `bridge` skill in the OpenCode config folder (`--opencode-config <path>` names that folder), `--all` adds them when the folder exists, and `asb bridge uninstall` removes them and their rows. The plugin never changes `opencode.json`. Exact sends by reference to an OpenCode session are not supported. On Windows, the real OpenCode check passes with OpenCode 2.1.3 and a mock model.
- Fixed a false warning at each engine start, "ASB could not register ChatGPT Personal", on a machine that has a `.codex-personal` store but no `~/.local/bin/chatgpt-personal` launcher (for example Windows). ASB registers that profile only when its store and its launcher are present, so an absent launcher now gives no source and no warning. A launcher that is present but not valid still gives the warning.
- Fixed the folder of Codex sessions on Windows, which showed with the `\\?\` prefix (the Windows verbatim path form that Codex saves) in hover cards and the row panel. ASB now shows `C:\x` for `\\?\C:\x` and `\\server\share` for `\\?\UNC\server\share`. Other folders do not change.
- Changed the toolbar filters. The toolbar now has two pills, **Drawer** and **Filters**. **Filters** opens a checklist popover with Pending, the states, the registered app profiles of each machine (for example Codex Account One and Claude Account Two), and Include archived. An app with two or more profiles has a check that turns all of them on or off and shows a dash when only some are on. Each active filter value has a chip with a × that clears only that value; a profile chip has the profile color dot. No selected state now shows all states. Preferences > Sessions no longer has the App, state, archive, and Show app pills settings. `layout.json` no longer gets `showAppPills`, and old files with it still load. The dashboard `providers` entries now include `provider` and `color`.
- Fixed the copy feedback, which showed the copied text twice: in the card footer or the row panel caption, and in the tooltip of the button. After a copy, the card copy button keeps its tooltip and the row panel copy row keeps the reference as its tooltip. The accessible description still gets the copied text.
- Fixed the copy tag of a card copy button, which could stay visible after the pointer left the button. GTK sends the leave signal before it clears the contains-pointer state, so the leave handler no longer reads that state. The tag now hides on leave, when the card loses hover, and when the button unmaps or its card is released. A tag that shows for a visible keyboard focus still stays.
- Added a kind switch and copy feedback to the card copy button. One board setting, `copyKind` in `layout.json`, stores Relative (the default) or Absolute. A tag with the full word **Relative** or **Absolute**, a kind icon, and two position dots slides out when the pointer rests on the button for 250 ms or when the button has visible keyboard focus. The wheel on the button (after that rest, or while the tag shows) and Alt+Up and Alt+Down on the focused button switch the kind. A click, Enter, or Space copies that kind, and the card footer shows **Relative session copied** or **Absolute session copied** for 1.6 s. A card of a session on another machine always copies the absolute reference and says why Relative is not available. The row panel shows the same text after a copy.
- Changed ASB Bridge so that the default receive policy of a Codex task delivers every message at once, as `accept` does. Before, it compared the permission modes of the sender and the receiver and held a message with another mode until the user released it in a dialog. The mode comparison, the release dialog, its expiry values, and the `inbox` expiry view are gone. The explicit policies `hold` and `refuse` stay. A message is still only text that can start a turn under the receiving app's own settings, and it grants no approval. Messages held under the old rule expire at the next start, as before.
- Changed how the engine uses memory, so that it holds much less after scans. After a scan, the engine now runs a full V8 garbage collection of the last-resort kind, which releases the free V8 pages, when its memory is 128 MiB or more above the level after the last one (3 s after a scan end, at most once in 30 s; Node.js 22 or later). The engine start also passes the Node.js argument `--max-semi-space-size=16` (Linux and Windows) and, on Linux, the glibc settings `MALLOC_ARENA_MAX=2`, `MALLOC_MMAP_THRESHOLD_=131072`, and `MALLOC_TRIM_THRESHOLD_=131072`. This happens in the launcher `scripts/asb` for `service run` and `engine run`, in the detached engine of `asb engine start`, and in the Windows tray. The engine removes the glibc settings from its own environment, so the message relay and the apps that it opens do not get them. On a PC with 281 sessions, the engine memory went from about 390 to 520 MB down to about 195 MB, and the CPU rose by about 3 to 23 percent (the higher values come from a forced scan every 2 s). A user service that an earlier ASB wrote gets the settings after `systemctl --user restart asb.service`.
- Changed how a scan builds its session objects, so that it makes less garbage and uses less CPU. A scan made about 14 objects for each Codex session (copies of the thread query rows and of the index titles, 2 or 3 copies each for the runtime fields and for the subagent links, and a second build of the links to find the linked sessions). It now makes 3, and adds the fields to the object that it just made. The kept thread query result is now frozen, so a write to it fails. On a machine with 285 rows, a scan went from 66.2 MB to 46.7 MB of allocated memory, the median scan from 50 ms to 39.5 ms, and the CPU for 290 forced scans from 23.3 s to 20.0 s (medians of 4 runs each, old and new in turns). Rows, titles, states, references, and the `ETag` do not change.
- Changed how the engine keeps the Claude Desktop session files and the Codex global state in memory, so that it uses less memory. The cache of each Claude Desktop session file (about 90 KB each) now keeps only the 17 fields that ASB reads, and the `title` and `name` of `metadata`. The cache of the Codex global state now keeps only its `electron-thread-read-state-v1` key. On a machine with 126 session files, these two caches went from about 12.5 MB and 2.2 MB to about 84 KB and 71 KB, and the live JavaScript heap went from about 43 MB to about 29 MB. Rows, titles, states, and references do not change. A test fails when a reader reads a field that is not in `CLAUDE_SESSION_FIELDS` (`src/claude-data.mjs`) or `CODEX_GLOBAL_STATE_KEYS` (`src/codex-data.mjs`).
- Fixed the window image of the check mode (`ASB_SNAPSHOT`), which was sometimes not saved. The window now saves the image 250 ms after the first frame that GTK draws with the session list, and no longer 250 ms after the first list. Because the window now starts while the engine starts, the list can come before the window is shown, and then the old timer ended before the first frame: on Windows, 10 of 15 Start menu opens with no engine running saved no image. If the window has no content yet, it tries again on the next frames for up to 10 s, and then prints the same error line as before. Without `ASB_SNAPSHOT`, nothing changes.
- Changed the first scan of an engine that starts with saved reader positions, so that it is faster. The engine now also saves the tail result of each Codex session log that did not change, and the entries of the Claude Desktop cache folder (Linux) that are not a session list or watch. After a restart it does not read the tail of an unchanged log, and it opens only the cache entries that can be a session list or watch. On a PC with 49,949 cache entries and 182 Codex logs, the scan after a restart went from 2.36 s to 1.25 s. A log or a cache group that changed is read in full, as before. The positions file (`readers/positions.json`) holds only numbers, booleans, fixed words, IDs, and keyed digests, with no message text, title, path, or URL. It can grow to about 1 MB, and it is built at most once in 10 minutes.
- Changed how the ASB window opens when no engine runs, so that it starts sooner. The launcher now starts the window as soon as the board check is good, while the engine starts, and writes the engine address (the URL and the source token) to the stdin of the window as one JSON line when the engine is ready. The token is in no argument, environment variable, or file. The window reads the line in a thread before its GTK import ends and loads the first session list at once, and it uses that reply as its first list. So the engine start, the GTK import, and the first request run together (on Windows, the GTK import takes about 1.2 s). If the engine cannot start, the launcher stops the window and shows the same message and exit code as before. The Preferences window is now made when you first open it. On Linux, the first window image comes about 100 ms sooner with no engine running (699 ms against 596 ms from the start of the launcher) and about 110 ms sooner when the engine needs 300 ms for the first list (792 ms against 681 ms). A window that you start by hand with the URL as its argument and `ASB_SOURCE_TOKEN` works as before.
- Changed how ASB saves `pending.json`, so that it writes less. ASB now writes the file only when a record, the pin order, or Persistent unread changed. A scan that changes nothing no longer serializes all records to compare them (about 1.1 ms for 1300 records, now about 0.3 ms). A record no longer has the fields that hold their default value (0 or the empty string), so a file of idle records is less than half of its old size. `lastSeen` is now the start of the UTC day, and it moves for all rows at the same scan. Before, each row moved at its own time, so a machine with 1300 records rewrote the whole file about once every two minutes with no work at all (16 writes in 30 minutes in a test with synthetic records). The file keeps version 1, the atomic write, and the owner-only mode. ASB `1.10.0` loads the new file with the same meaning.
- Changed how the engine talks to the other machines of a group, so that it uses less CPU and time. A GET to a member (the sessions list every 2 to 5 s, the relay list every 5 s, the group, and hello) now keeps its TLS connection open and reuses it, with at most 2 idle connections for each member address, closed after 30 s without traffic. Before, each GET made a new TLS 1.3 handshake. In a local test, 20 GETs in a row take about 5 ms instead of 34 ms, and use about 6 ms of client CPU instead of 26 ms. The certificate pin rule is the same: a request goes out only on a socket whose server certificate matched the pin, and the connections of a member close when it leaves the group or the engine stops. A POST (join, leave, message delivery) still uses a new connection, so it never goes out twice. A GET that fails on a connection the member had closed is tried again once on a new connection.
- Changed how the ASB window opens, so that it starts sooner. The launcher now keeps the last good result of the Python check in `board-check.json` in the ASB cache folder and skips the check (about 800 ms on Windows) while the ASB version, the Python candidates, and the size and time of the Python file stay the same; it checks again when the window ends with an error, and a failed check is never kept. `asb doctor` and `asb setup` still run the full check. On Windows, the window now uses the Cairo renderer (`GSK_RENDERER=cairo`), which shows the first rows about 270 ms sooner and uses about 90 MB less memory, unless you set `GSK_RENDERER` or put `dcomp` in `GDK_DEBUG`.
- Changed `GET /api/dashboard` to do less work for a repeated request. The engine now keeps the serialized session list and its `ETag` for the latest reply, and it uses them again while the scan result, the snapshot revision, and the palette are the same. A request that finds the same list no longer serializes or hashes it again, and a matching `If-None-Match` gets `304` with almost no work. The reply bytes, the `ETag` values, and the headers do not change.
- Made the Windows tray and the Windows sounds faster. The tray now starts the engine before it loads Windows Forms and builds its icon and menu. The engine now plays all sounds with one hidden `powershell.exe` that reads the WAV paths from stdin, and that process ends after 5 minutes with no sound. Before, each sound started a new `powershell.exe`.
- Changed the copy button of a card of a session on another machine: it now copies the absolute reference (`asb:1/...`, which works from any machine) and not the relative one (`<app>/<session ID>`, which works only on its own machine). Its tooltip is **Copy absolute reference**. When ASB has no safe absolute reference for that session, the button stays in its place with no action and its tooltip gives the reason. A copy error names the kind of reference. Cards of local sessions, also CLI sessions, and the row panel do not change.
- Added Discard on Idle cards. An Idle card with no `?`, dot, or stop square now offers **Discard next result** (the dashed ring in the Read slot, on hover or keyboard focus, and the row menu and row panel), so a task that you know will go well leaves no dot, no Done sound, and no Done phone notification. The ring is solid while it is on, and **Keep result** (**Keep next result** in the menu and the panel) turns it off. The arm stays until a task ends after it, also when a whole task runs between two scans. When ASB sees the row Working, the arm works as the Discard of a Working task. A failed end keeps its dot, and a stopped task keeps its square. `discard-result` takes `{}` as before, or exactly `{"next": true}`, which also arms an Idle row. `pending.json` has the new record field `discardNext`. The Android app is not changed: it offers Discard for Working rows only and shows nothing for an Idle arm.
- Fixed the message relay on a machine where Bun is not on the engine's `PATH`. When `PATH` does not have Bun, the engine now finds it in `$BUN_INSTALL/bin` and `~/.bun/bin` (on Windows, `%BUN_INSTALL%\bin` and `%USERPROFILE%\.bun\bin`). So the relay also starts after a Windows sign-in start or in a systemd user service, where only the machine `Path` or a short `PATH` can apply. When the group has another machine and the engine finds no Bun, it writes one line to its log, and `asb group status` (and the `relay` field of `asb group status --json`) shows the state of the relay. `asb doctor` uses the same lookup: a Bun that is only in the standard folder is `ok` and marked `not on PATH`, because a Codex task still needs Bun on the `PATH` of Codex.
- Added a Start menu link on Windows: `asb engine install` adds **ASB** to the Start menu (`ASB.lnk`, with the ASB icon), which opens the ASB window, and `asb engine uninstall` removes it. ASB changes or removes only a link that it made; it keeps another `ASB.lnk` and prints its path. The link runs `scripts\asb-tray.ps1` with the new `-Open` switch, which starts the launcher.
- Added `asb doctor` on Windows. It checks Node.js and the ASB window, and prints the `winget` and `pacman` commands that install MSYS2 and the board packages; ASB never runs them. `asb setup` now prints these checks on Windows too, and prints `asb bridge install --all` instead of saying that the bridge is not available.
- Added the ASB window on Windows: `asb` with no command, and **Open ASB** in the tray menu (or a left click on the tray icon), start the engine and open the same board as on Linux. The board needs MSYS2 Python with PyGObject, GTK 4.12 or later, and Libadwaita 1.4 or later (an absolute `ASB_PYTHON`, else `C:\msys64\ucrt64\bin\python.exe`, then `python` on `PATH`). Without them, the launcher exits with code 3, and the tray (in a balloon) or the Start menu link (in a message box) shows `ASB has no window on this PC. Run asb doctor.`
- Added PC sounds on Windows: the engine plays the Done, Needs input, and Failed sounds with Windows PowerShell (`Media.SoundPlayer`). It plays them only while an ASB window is open, as on Linux.

See [ASB 1.11.0 release notes](docs/releases/v1.11.0.md) for downloads, upgrades, and check limits.

## ASB 1.10.0 - 2026-10-21

- ASB Bridge is `0.7.0` in this release.
- Fixed the `.deb` compression: a `.deb` that CI built on Ubuntu had zstd members (`control.tar.zst` and `data.tar.zst`), because the default of the Ubuntu `dpkg-deb` is zstd. It had the same files as a Debian build but different bytes, and it needed dpkg 1.21.18 or later. The build now always uses xz, so a `.deb` from any host also installs with an older dpkg.
- Rewrote the Linux install text. The README now has the npm route, `asb doctor`, one install block for each distribution family (the same commands that `asb doctor` prints on a system with nothing installed; a docs test checks each block against the package table), the release packages, engine only, start at login without systemd, and the firewall rule. `ASB.md` has a new System check section for `asb doctor`, and its Node.js search text is current. `SYSTEM_OVERVIEW.md` describes the tool discovery, the board check, `asb doctor`, the package formats, and the CI matrix. `docs/PRIVACY.md` lists what `asb doctor` and `asb setup` read.
- Added `flake.lock`, which pins nixpkgs `nixos-26.05` for the Nix flake. The CI `nix` job made it.
- Fixed the window on a minimal Fedora 43: GTK 4.20 aborts in libepoxy when `libGLESv2.so.2` is missing, and the `gtk4` package does not require it. The `gtk` key of the Fedora family is now `gtk4 gobject-introspection libglvnd-gles`, so `asb doctor` prints `libglvnd-gles` with the other window packages, and the RPM recommends `libglvnd-gles` when `gtk4` is installed.
- Added CI for the Linux families except Gentoo and Solus (`.github/workflows/distros.yml`, on each push). The `probe` jobs install all the packages of the table in 16 images (Debian 13 and 12; Ubuntu 26.04, 24.04, and 22.04; Fedora 43 and 44; AlmaLinux 10 and 9; openSUSE Tumbleweed and Leap 16.0; Arch; Alpine 3.24; Void; and Debian 13 and Fedora 44 on arm64) and probe what each image has. The `check` jobs install ASB there from the archive with `install.sh`, then run `asb doctor`, the engine, the autostart modes (`none` and `xdg`), the board in Xvfb, the Python tests, and the uninstall, and then install the `.deb`, the RPM, or the `PKGBUILD` of the row. The `build` job makes the packages once. The `nix` job builds the flake and starts the engine. AlmaLinux 10 does not open the window (EL10 has no Xvfb). On AlmaLinux 9 the check waits for `UI: verified` from `asb agent status`, because PyGObject 3.40 cannot save the board image. The `Test` workflow also installs `rpm`, so its tests and build make and check the RPM, and it uploads the RPM and the `PKGBUILD` with the `.deb` and the archive.
- ASB Bridge is now `0.7.0`: its shipped files changed (the one-line header, the skills that the model can load, `nameContains` and the shorter tool texts, the receiver and relay fixes, and the new name rule), and Codex loads a changed plugin only with a new version.
- Changed ASB Bridge to show more sender names in the header of a peer message. Before, a name went in only with the characters `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-`, so a title such as `Fix board rows`, `Claude Code`, `Revisión del tablero`, or `修复看板` was left out. Now a name goes in when it has 1 to 64 characters (Unicode code points) and is not only white space. A name still stays out when it has a comma, a `[` or `]`, a control, invisible (for example U+200B or U+202E), private-use, or unassigned character, or a line or paragraph separator, because the model trusts the header and such a name could add a fake session ID or a second header. The header then has only the session ID, as before.
- Fixed Android notifications that stayed after you read the session on the PC. Android keeps about 50 notifications for one app and then drops new ones, so a heavy user stopped getting alerts with no sign. Each read of the live service and of the 15-minute check now cancels the Done, Failed, or Needs input notification of each session whose mark is clear (read on the PC, a lost mark, or an archived session). The mark on the row decides, not a change since the last read, so a session that you read while the app was open loses its notification at the first read after the app is in the background. A session that is missing from the read, a first read with no baseline, and the Done and Failed marks of a session with a usage limit keep their notifications. A read from an engine other than the paired PC also keeps the notifications of sessions of other machines, because that engine starts the row of such a session with no mark. A read from the paired PC cancels them like the notifications of local sessions.
- Fixed Android pairing away from home: the app tried only the first address of the pairing link (the home network), so pairing failed when only ZeroTier or Tailscale could reach the PC. The pairing request now tries every address of the link in order, as a read does, and the first HTTP reply ends the loop. A row action or a setting still goes to one address only, so it cannot run two times. The PC accepts a pairing code one time only, so a second address cannot add a second phone: a used code gets 403 and the app shows `This pairing code is not valid. Make a new one in ASB.`
- Fixed ASB Bridge: the Bridge opened every old task state file up to four times at each start (1, 5, 15, and 60 seconds after it starts), so with many old tasks each start was slow and used much CPU and disk. Now it deletes the state files of tasks that ended more than 30 days ago, with their `-wal` and `-shm` files, when Codex has not loaded the task and the task has no live receiver. It deletes nothing when the list of loaded tasks fails.
- Fixed ASB Bridge: when another process uses the PID of a dead receiver, a task could not get a receiver again, because every `SessionStart` of that task failed with `Receiver process identity changed`. Now the next `SessionStart` (and a receiver revival) removes the old receiver row and key file and starts a new receiver. It never signals the other process. A row with no start time still fails, and a row stays when the start time of its process cannot be read, because neither shows that its process is gone. A receiver start also no longer fails when a process of another user has the PID of the old receiver in the state database.
- Fixed ASB Bridge: a message that the bridge could not send because the Codex task was neither active nor idle is now dropped with a `delivery-refused` receipt, and it no longer stops the idle notices of the task. Before, the bridge kept the message as `unknown` and waited for its input forever, so no idle notice went out. A new session and a receiver start also clear the wait for input of `unknown` messages (a receiver start also makes a `submitting` message of a dead receiver `unknown`); their status stays `unknown`.
- Fixed ASB Bridge: after you accept or deny a held message from another machine, the receipt now reaches that machine, so it no longer shows `held` forever. Before, the receipt of a decision that the MCP server or a hook made did not reach the relay proxy row, and people sent the message again. The outbox of the receiver now finds the row by its socket and start time, and it takes only receipts and idle notices for a proxy row.
- Fixed ASB Bridge: the message relay now takes its placeholder process `cat` from `PATH`, not from `/usr/bin/cat`, and the engine checks for `cat` on `PATH` before it starts the relay. Machine messages now work on systems with no `/usr/bin/cat` (for example NixOS). Before, the engine did not start the relay there, and no log line showed it.
- Fixed the window and the tray icon on GTK 4.12 with Libadwaita 1.4 (RHEL, AlmaLinux, and Rocky 9) and on GLib 2.88. On Libadwaita 1.4, the Remove and Leave dialogs of Preferences > Machines failed because `Adw.AlertDialog` (Libadwaita 1.5) does not exist: they now use `Adw.MessageDialog` there. On GTK 4.12, a message between two sessions failed because `Gsk.PathBuilder` (GTK 4.14) does not exist: the two rows now light, as with GNOME animations off. GLib 2.88 removed `GLib.unix_signal_add`: the window and the tray icon now use `GLibUnix.signal_add` when it exists. The QR code now shows only when the Python `qrcode` module and PyGObject cairo support both work (before, missing cairo support made the draw callback fail), and its hint names both.
- Changed the Codex and Claude readers to keep no prompt text. They kept the first and latest prompt and the last answer of each session (up to 2000 characters for each session in the memory caches, for up to 5000 sessions in each store), and no code read them. The readers now keep only the time and the kind of each message. ASB also deleted two more fields that no code read: the Codex native pin (`pinned`, `is_pinned`, `pinned-thread-ids`) and the automation hint (`isAutomation`). The card state, the row time, the unread marks, the sounds, and the ASB pins do not change. The saved reader positions never held text. An old positions file loads without an error: the changed reader code drops its records once, and the first scan reads the logs in full.
- Fixed a Claude Code CLI card that stayed Working for six hours after its process ended (killed, out of memory, or a reboot during a task), while the board scanned every 2 seconds. On Linux, when the registry folder (`<Claude folder>/sessions`) exists and has no live process for a transcript with an open task, the card now shows Unknown with the reason `The CLI process ended during a task.`, and the fast scan stops. A card with a live process (of any entrypoint), a card with no open task, an old CLI with no registry folder, and any other system are unchanged. Codex CLI cards are unchanged.
- Fixed a Codex reader that failed with no warning: when Codex moved its session logs, ASB read nothing, and every Codex card showed Unknown with no reason. Now, when ASB cannot read the log of any unarchived root session (a missing file or a read error), the Codex source shows a warning: `ASB cannot read the Codex session logs, so Codex cards show Unknown.` One readable log keeps the source `ready`.
- Fixed an empty Codex list on Node.js 20 (the `sqlite3` command): a title can hold a whole prompt, and a large store passed the 20 MiB output limit of `sqlite3`, so the query failed. A `~/.sqliterc` that prints text also broke the JSON. The thread query now reads only the first 301 characters of a title (a row shows at most 300) on both SQLite paths, and `sqlite3` runs with `-init` set to the null device.
- Changed the release build: it now also makes an RPM (`asb-<version>-1.noarch.rpm`, only when `rpmbuild` is installed) and an Arch `PKGBUILD` with the SHA-256 of the archive. The repository also has a Nix flake (`flake.nix`, `nix/package.nix`); the packages and the npm package do not ship it. The `.deb` now has the board libraries (`python3-gi`, `python3-gi-cairo`, GTK, Libadwaita) in Recommends, and the sound player can be `pipewire-bin`, `pulseaudio-utils`, or `alsa-utils`, so that a release with an old GTK still installs the engine.
- Fixed `pending.json`, which only grew: ASB kept one record for each row that it ever saw and wrote the whole file at each change, so 20,000 records made a 7.5 MB file and cost about 15 ms for each scan. ASB now drops the record of a row that it did not see for 30 days, unless the row has a pin, a mark, a drawer entry, or Mute. It also drops the records of a machine that left the group. The file keeps the time of the last scan that listed each row (`lastSeen`).
- Fixed the marks and sounds of a member machine that is offline for a short time: its rows became Unknown, and that reset the Working mark and the sound bits. A task that ended during the outage got no unread dot and no Done sound, and a task that ended before the outage played its Done sound again when the member came back. The tracker now keeps the Working mark of an offline member's rows, and the sounds keep their last bits.
- Fixed a group member that showed as offline on all machines when it had a long session list: a member dropped a reply of more than 5000 rows or 4 MiB whole, and about 3800 rows with long titles are enough for 4 MiB. A machine now sends only its newest rows (at most 5000 rows, and about 3.5 MiB of rows).
- Fixed a new group member that polled an old address of the machine that invited it: that machine saved its own address and port only when it made the group, so after a port or LAN change a later member polled the old values and never got a reply. Each invite now saves the current addresses and port of the inviting machine when they changed.
- Fixed old notifications that the phone showed again after an engine start: the engine read its machine ID only after the phone gateway started, so the first scan gave every row an empty `globalId`, and the phone saw each row as new. The engine now reads the machine ID before its server listens.
- Changed ASB Bridge: `list_sessions` now takes the optional `nameContains` (a case-insensitive part of the name that the list shows, also for sessions of other machines). It leaves out fields that have no value (a session of another machine has no `cwd` and no `startedAt`) and writes `startedAt` without milliseconds. The tool texts and the input schemas are shorter, so the bridge costs fewer tokens when its tools load. The checks before a send are the same: a bad `sessionId` or `reference` is still refused before anything is sent.
- Changed ASB Bridge: the model can now load the two bridge skills by itself, when a task has a session reference (`asb:1/...`) or needs a message to another agent. Each skill adds a short entry to the skill list of Claude Code and Codex. Before, a skill loaded only when you typed `/bridge` or `$bridge`. Both commands still work. The skill texts are also shorter, and they keep all safety rules.
- Fixed the card time ("N ago") and the card order after you open a session: an open no longer sets the time to now or moves the card to the front. The time is now the time of the last turn. Before, Codex moved the thread time when the app wrote a `thread_settings_applied` entry at the open. ASB also used file times that change at an open: the session file of the Claude app, the subagent logs, and the transcript of a Claude Code CLI session.
- Fixed the npm install command in the README and in `ASB.md`: it is now `npm install -g --install-links github:Jamir-boop/ASB`. With npm 11, the old command linked the global package to a temporary clone that npm then deleted, so `asb` stopped working.
- Made the board faster when it shows many cards and in long sessions: card moves no longer get slower over time, and hidden cards no longer stay in memory.
- Changed the Android app: the Text size setting is now named **Card text size**, and it changes only the text on the session cards. The other text in the app (top bar, filters, Settings, dialogs, and the session inspector) now follows only the phone font size. The setting keeps its saved value.
- Fixed ASB Bridge: a Codex task no longer puts its inbox socket in the folder of a relay proxy or of another receiver. The relay deletes the sockets in its folder when it restarts, and then nobody could reach the task and the task could not send. The task now takes the folder of a native Claude session, or its own `cc-socks` folder.
- `asb doctor` shows one more check: **Links**. It names the desktop file that handles `codex:` links and the one that handles `claude:` links (`xdg-mime query default`). When an app has no handler, or `xdg-mime` is missing, the line has the status `info` and says that ASB cannot open sessions of that app until the app handles its links.
- Changed ASB Bridge to give a peer message to the model once, after a one-line header, with fewer tokens. The header has the sender name, the sender session ID, and, on the app-server path, the input ID. The text follows as it is. Before, JSON escaped the text (two times on the app-server path), and the envelope repeated the socket path and the sender ID. The bridge still reads thread history that `0.6.0` wrote.
- Fixed PC sounds on Linux systems without MP3 support: the three sounds are now 16-bit PCM WAV files with the same samples and gain, and ASB plays them with `pw-play`, then `paplay`, then `aplay -q` (ALSA). When no player exists, the log line names the three players and `asb doctor`.
- The engine starts faster after a restart: it saves its Codex and Claude reader positions in `~/.cache/asb/readers/positions.json` (no message text, no paths) and reads only the new bytes of each Codex session log and of each Claude transcript larger than 8 MiB.
- ASB Bridge is now `0.6.0`: its shipped files changed for the Windows sends by reference, and Codex loads a changed plugin only with a new version.
- ASB Bridge can now send by reference to a session on the same Windows PC. Before the first byte, it checks that the pipe belongs to the target process of the same Windows user. An older bridge on Windows gets `bridge-upgrade-required`. Sends by reference to another machine of the group now also work from and to Windows; on Windows the receipts need the message relay (Bun).
- Changed the board start: the board window opens a little sooner, because Python keeps the compiled board code in `~/.cache/asb/pycache`.
- Changed the board launcher: it now runs the board check (about 0.1 s) while the engine starts, not after it. The launcher still decides on the window before it registers the icon.
- Fixed `asb` on Linux with an unknown first argument (for example `asb --help` or `asb servce`): it opened the board and started an engine. It now prints the usage and exits with code 2. Only `asb` with no command opens the board.
- Changed the engine to use less CPU: with full file watch coverage, it scans when a session file changes, when another machine of the group sends a change, or when a status time limit comes, with a safety scan every 30 seconds. The Codex reader no longer queries the Codex database again when the database did not change.
- Changed the machine group: archived sessions of another machine no longer show in the Archive filter.
- Fixed the Codex reader for Codex database changes: a missing column no longer empties the Codex list.
- Fixed the Debian package: **Open ASB** in the tray, the user service, and the autostart entry now use `/usr/bin/asb`, because that command sets `ASB_INSTALLED_LAUNCHER`. Before, they used `/usr/lib/asb/scripts/asb`, and **Open ASB** wrote a per-user app entry that stayed after `apt remove asb`. A unit or entry that an older package wrote changes only when you run `asb service install` again.
- Fixed `asb service install` and `asb setup` after `asb`: the user service restarted every 5 seconds while the engine that `asb` started was running.
- Fixed the user service after an uninstall: `asb.service` now has `ConditionFileIsExecutable=<launcher>` in `[Unit]`, so a unit that stays after you remove ASB is skipped at login and does not fail. An installed unit gets this line when you run `asb service install` again.
- Fixed **Check now** in the Android app: it now shows the notifications that it finds, and an automatic check while the app is open no longer marks new events as seen.
- Fixed Claude Desktop sessions that moved into a worktree: they now show their current state, because ASB reads the newest copy of the transcript, not an old copy in the previous project folder.
- Fixed a Claude Code CLI session with Remote Control that showed as two cards and lost its messages.
- Fixed cloud cards that went away or flickered when the PC clock ran a little behind the server, and a cloud card that went away for one scan when the cache file changed during the read.
- Fixed sounds for old events when the engine starts in a machine group: the first rows of a member machine now set its baseline and play nothing.
- Fixed "machine offline" for an online machine while another machine of the group is off: the message relay now reads the session lists of online machines only.
- Fixed phone access settings that could not change while a saved ZeroTier or Tailscale address was absent: the gateway now does the only address check.
- Fixed an engine stop when a member machine sends a bad port: ASB now accepts only ports from 1024 to 65535, and a request with a bad port fails without a later error.
- Fixed an engine stop when the browser view asks for a file that ASB cannot read.
- Fixed a board that stopped showing cards because of one bad card: a card with no provider, a usage limit reset time that is not a date, or a title cut inside an emoji. Titles are now cut on whole characters, and ASB repairs broken text in rows from other machines.
- Fixed empty card slots in a board column that grew with time, and the GTK warning "Tried to remove non-child" at each reorder: GTK 4 lists a card twice, with no warning, when the same card is twice in one column (for example when two rows have one ID). The board now shows one card for each ID (the first row), never inserts a card that still has a parent, and replaces all columns when the internal list of one differs from its cards.
- The session menu now has **Copy relative reference** (the app host and session ID, in the same app) and **Copy absolute reference** (`asb:1/...`, with ASB, on any machine of the group). When ASB cannot make a reference, the row shows why.
- Made the board faster under the pointer and with the Ctrl numbers: these changes now restyle only the cards that change. Very long titles are cut on the card; the tooltip shows the full title.

See [ASB 1.10.0 release notes](docs/releases/v1.10.0.md) for downloads, upgrades, and check limits.

## ASB 1.9.0 - 2026-10-20

- ASB Bridge is `0.5.0` in this release.
- Fixed the provider marks and the machine and terminal glyphs on the board: they now take the colors of the theme, for example the accent color of a card with a new message. ASB loads them as file icons, because GTK 4.18 does not recolor symbolic icons from the icon search path.
- Added full session references to `list_sessions` in ASB Bridge (Linux): each entry now has its `reference`, or `referenceUnavailable` with the reason code when a send cannot use one. A listed reference is one that `send_message` accepts now. An entry of another machine with the same session ID as a local session shows only when it has a reference. Without the engine, the list stays the same as before.
- Added receipts for exact sends to another machine in ASB Bridge (Linux): the receipt of the target session (for example `delivered`, `denied`, or `dropped`) now comes back to the message row of the sending Codex task. Only the receipt of the bound target process counts, and it goes back only to the same receiver process of the sending task. Else the receipt is lost and the message stays submitted. A receipt never goes on the old path between machines, and ASB never makes a receipt itself.
- Added exact sends to another machine in ASB Bridge (Linux on both machines): a full session reference (`asb:1/...`) of a Codex or Claude Code CLI session on another machine of the group now reaches exactly that session, or nothing is sent and the reply tells the reason. The engine first asks the other machine if it can send to that session, and sends the text only after a yes. A reference never falls back to a session ID, another session, or another machine. Receipts and idle subscriptions for these sends are not available yet.
- Added exact sends in ASB Bridge (Linux): `send_message` can take a full session reference (`asb:1/...`) instead of `sessionId`. The message goes to exactly that Codex or Claude Code CLI session on this machine, or nothing is sent and the reply tells the reason. A reference never falls back to the session ID or to another machine.
- `asb doctor` and `asb setup` on Linux now print the firewall rule for phone access and machine links when firewalld or ufw is active: for firewalld a rich rule for the phone access port (4630 by default) on each selected address (with the zone of its interface) and one `--reload`, for ufw one `ufw allow` line for each address. ASB never runs these commands. Doctor reads the selected addresses from the running engine; `--json` has them in `commands.firewall`.
- Added autostart without systemd: when no systemd user manager runs a graphical session, `asb service install` writes the XDG autostart entry `~/.config/autostart/asb-engine.desktop`, which runs `<launcher> engine start` at login, and starts the engine. Without a desktop session, it changes nothing, names `<launcher> engine start`, and exits with code 1. A change of mode removes the ASB file of the other mode. `asb service uninstall` removes the entry and stops the engine. `asb service status` shows the entry and the engine state in this mode.
- Without an absolute `XDG_RUNTIME_DIR`, the engine now runs and keeps its runtime file in `asb/run` in `XDG_STATE_HOME` when it is absolute, else in `~/.local/state` (mode `0700`, owner checked). A record there whose engine does not answer is replaced. ASB Bridge also looks for the engine there.
- `asb doctor` shows two more checks: **Autostart** (systemd user service, XDG autostart, or not installed) and **Runtime folder**.
- Added engine only: when the window cannot run on the system (no PyGObject, or GTK older than 4.12 or Libadwaita older than 1.4), `asb` keeps the engine running for the phone and your other machines, writes no desktop entry, prints the reason, and exits with code 3. The tray menu then has only **Quit ASB**, and a left click does nothing. The per-user install then writes no desktop entry or icon.
- Fixed ASB Bridge: two receivers or hooks that started at the same time could fail with "database is locked". The bridge now sets the lock wait time before it changes the journal mode, and the revive hook also waits for a lock when it reads the state of other chats.
- Fixed messages between machines: ASB no longer says "Nothing sent" when it cannot know the result, sends a message to the other machine only one time, and refuses a session ID that more than one other machine has. A Claude sender gets no false refusal when the result is not known. Each wait now has a total limit, and the limits nest.
- Added `asb doctor` (Linux): it checks Node.js, SQLite, `openssl`, `xdg-open`, the window libraries (Python 3.9, PyGObject, GTK 4.12, Libadwaita 1.4), the QR code, sounds, the tray host, and Bun. It prints the install command for the package manager of your distribution and the Node.js route, and never runs them. `--json` prints the same data. It exits with code 0 when the engine can run. `asb setup` on Linux prints the same checks first.
- ASB now finds Python and Node.js without fixed paths: Python from `ASB_PYTHON`, `/usr/bin/python3`, or `python3` on `PATH`; Node.js also from `PATH` and Homebrew on Linux. The Node.js message links to the new README section.
- The per-user install now continues without the window when the window libraries are missing or too old, with `ASB will run without its window: <reason> Run asb doctor for details.` The engine needs are still checked first.
- The session menu is now a short action list: the title, Open, then only the actions that apply (Mark read, Pin, Mute, and others), then Copy app and session ID. The switches, the state line, and the large header are gone. The focus stays on the same row when its label changes.
- Added `asb agent resolve-session`: it shows the machine, the source, and the state of a full or short session reference. It only reads and sends nothing.
- The mute icon on the cards now has one gray tone. Some icon themes drew its slash brighter than its bell.
- The engine now gives each session a full session reference (machine, source, and app session ID) for the coming copy action and resolver. A keyed source scope tag in the reference changes when the folders of the source change. The rows of an older group member get no full reference.
- Fixed the message relay: when a Claude profile's `sessions` folder was a link to another home's, Claude listed each remote session two times. ASB now uses each real `sessions` folder once.
- The native context menu now closes when the pointer leaves it. Keyboard access stays available.
- Fixed ASB Bridge and the message relay: messages to a Claude Code 2.1.304 session on Windows failed, because its key file has the start time in `procStartFt`. ASB now reads `procStartFt` or `procStart`.
- Fixed ASB Bridge: a Codex desktop task did not start its receiver when an old Codex app-server socket file was present (on Windows, and on Linux when the socket had no listener). A failed connection to the Codex app-server now falls back to the Codex desktop app.
- Added **Cards on the board** to Preferences > Sessions (50, 100, 200, 500, or All; default 100). The board shows only the first cards in its order, and a More card at the end shows the rest. Search and filters look at all sessions.
- Made the board faster with many cards: a reorder moves only the cards that change column or order, a tooltip is set only when its text changes, profile dots use shared styles, and the popover check no longer runs for every card that moves. Measured with 840 synthetic rows, the first paint takes 55 ms instead of 117 ms after a reorder, 180 ms instead of 1,493 ms after a machine goes offline, and 1,524 ms instead of 2,604 ms after a view change.
- ASB Bridge and the message relay now run on Windows. Codex tasks and Claude Code sessions on a Windows PC can message each other and the sessions on the other machines of the group. On Windows the bridge uses Claude's named pipes, writes a key file for each receiver, and accepts a connection only after the `auth` line with that key. `asb bridge install` finds `bun` and `codex` with `PATHEXT` and runs a `codex.cmd` safely; `asb bridge link-claude` is not supported on Windows. A new `bridge-windows` CI job runs the bridge checks and tests on Windows. Linux and macOS behavior does not change.
- Added the relay part of messages between machines: the engine runs the ASB message relay while the machine group has another member. Local Claude sessions see the sessions of the other members as proxy rows and can message them; the member routes `GET /peer/v1/peers` and `POST /peer/v1/deliver` carry the lists and the messages. Claude sources get the optional `remoteClaude` setting (`auto`, `bridge`, or `native`).
- Added **Remote Claude sessions** to Preferences > Profiles (the approved option A): for each Claude profile, choose Automatic, Through ASB, or Claude Remote Control only. A note under the choice says what it does.
- Codex tasks with ASB Bridge can list and message the sessions on the other machines of the group: `list_sessions` adds them with `remote: true` and the machine name, and `send_message` sends through the local engine. A message to an offline machine is refused at once.
- Android: cards say where a session runs (the machine name or `CLI`, with a glyph in Comfortable) and are view only, with the quiet colors when they have no attention. The app uses another engine of the machine group when the paired PC does not answer, and checks the paired PC again once a minute. Settings lists the machines with Online or Offline. Notifications use the session key of the group, so a change of engine does not repeat them.
- Added the npm package: `npm install -g github:Jamir-boop/ASB` installs the `asb` command on Linux and Windows. One dispatcher (`scripts/asb.mjs`) now runs every `asb` subcommand; `scripts/asb` keeps its Node.js and SQLite checks on Linux.
- Added the Windows engine, statuses only: it reads Codex and Claude on that PC for paired phones and the machine group. It has no window and no sounds. `asb engine install` makes it start when you sign in (the HKCU Run value), and a tray icon has **Copy phone pairing link** and **Quit ASB**. It needs Node.js 22.13 or later. Its files are in `%APPDATA%\asb` and `%LOCALAPPDATA%\asb`, limited to your user with `icacls`. To join a group on Windows, run `asb group join` with no link and paste the link when it asks, because `cmd.exe` splits a typed link at each `&`.
- Added `asb setup`: it turns on autostart, waits for the engine, and turns on network access for the addresses that you select (`--yes`, `--address`). On Windows it prints the firewall rule; ASB never changes the firewall.
- Added `asb phone status`, `pair`, and `remove` to list, pair, and remove phones from a terminal.
- On Windows, a session link opens only when it has plain URL characters; else it says "This session link cannot open on Windows". Claude web sessions are not read on Windows. Tailscale and ZeroTier adapters with Windows names now show as Tailscale and ZeroTier.
- Added Preferences > Machines (the approved option A): this machine, the other machines with their status and addresses, the group phones, and **Add a machine** (join link, QR code, and fingerprint), **Join a group** (paste the link and compare the fingerprint), **Remove**, and **Leave the group**, with a confirmation for each removal. The page reads the group every 5 seconds while it is open. Narrow Preferences tabs now scroll, and destructive buttons keep red text in custom colors.
- Added the machine group: ASB engines on your private LAN, ZeroTier, or Tailscale addresses can join one group and show each other's sessions as remote cards. `asb group invite` prints a one-time join link (10 minutes); `asb group join '<link>'` shows the inviter fingerprint to compare, then joins. Also `asb group status`, `remove`, `leave`, and `reset-identity`, and `asb network status`, `enable`, and `disable`. Members use mutual TLS 1.3 with pinned certificates on the phone gateway listeners (`/peer/v1/*`), and send only whitelisted row fields, never message text.
- Added remote cards: a card from another machine shows its name, does not open, and refuses Discard. Read, Unread, pins, the drawer, and Mute change only this machine's marks. A machine that does not answer for 3 polls gives Unknown cards with `<name> is not reachable.`, which go away after 10 minutes. A removed machine leaves the group when it next reaches a member. Session message lines also join sessions on two machines.
- Added group phones: each member accepts the token of a phone that is paired with another member. The gateway now asks for a client certificate; phones send none and work as before.
- Added Claude Code CLI sessions as view-only cards: each running `claude` session and each CLI transcript with activity in the last 7 days. A running session with no transcript yet shows Idle. The title is the session name or the title that you set in the CLI, never prompt text. A session that the Desktop app owns stays a desktop card.
- Changed Codex CLI tasks (`codex`, `codex exec`) to view-only cards: a Codex CLI card no longer opens from ASB. The server refuses to open a CLI session with `This session cannot open from ASB.`
- Added the approved option D look for view-only cards, with the Grey tone: a terminal glyph and `CLI` before the age in Comfortable, `Idle · CLI` in Compact, quiet colors while the card has no attention, and a tooltip, row panel button, and screen reader text that say why the card does not open. The web view shows `CLI` before the age.
- Added the row fields `surface`, `machineId`, `machineName`, `remote`, `globalId`, and `remoteCache`. The engine creates the phone certificate at start, also when phone access is off, and uses the first 16 characters of its fingerprint as the machine ID.

- Fixed phone access after a network switch, for example from the home network to ZeroTier that you turn on on the phone. The phone app now drops the idle connections of the old network and reads ASB at once (then again after 3 seconds) instead of after up to 30 seconds, and it learns new PC addresses from hello after a network change without a new pairing. The PC gateway checks its addresses every 30 seconds and starts to listen on a selected address that appears later (for example ZeroTier after `asb.service`). Preferences > Phone reads the addresses again each time it opens and keeps a saved address that is not on the PC now.

- Added OpenCode 2 sessions, list only. ASB reads the root sessions of `opencode.db` read-only: `session_v2`, the subagent count, and only `session_id` and `time_created` of `session_message`. It never reads `auth.json`, the `account`, `control_account`, `credential`, or `kv` tables, or `session_message.data`. OpenCode's execution claim gives Working (Unknown with no message in 6 hours), `idle_outcome` gives Done, Failed, or the stop square, and OpenCode's own read mark gives unread. OpenCode cards do not open, because OpenCode 2 has no link that opens one session, and they have no Needs input, because OpenCode keeps permission asks and questions only in memory.
- Added OpenCode as a third default source with a fixed folder (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`) and no launcher. You can turn it off in Profiles, but you cannot add another OpenCode source. A settings file without it gets it in memory, unless the file already has 8 sources.
- Added the OpenCode mark, the **OpenCode** app pill, the OpenCode choices in Preferences > Sessions (each app and each pair of apps), and the `oc:` and `opencode:` search prefixes to the native window, and the same mark, filter, and prefixes to the Android app. With app pills hidden, the app chip names every selected app, for example **Codex, OpenCode**.

- Split ASB into an engine and a window. The engine runs the server and phone access without a window; `asb` starts it when none runs (through `asb.service` when that is enabled, else detached with its output in `~/.local/state/asb/engine.log`), then opens the window as a client. Closing the window keeps the engine and phone access running. Added `asb engine run`, `start`, `stop`, and `status`, and the loopback route `POST /api/engine/stop`, which the phone gateway never forwards. A window closes when its engine stops.
- Added a Linux tray icon for the engine, with **Open ASB** and **Quit ASB** and a tooltip that shows whether phone access is on. It shows only when the desktop has a tray host, for example the GNOME AppIndicator extension. `ASB_TRAY=0` turns it off.
- Added **Quit ASB** to Preferences > Sessions. It stops ASB and phone access, then closes the window.
- Changed the PC sounds of the engine to play only while an ASB window is open. Sounds can continue for up to 45 s after the last window closes. The `npm start` browser view keeps its sounds.
- Added Mute for a session: a muted session stays read when a task ends, with no Done sound or phone alert. Questions and failures still alert. Turn it on with Muted in the row panel; a muted card shows a muted-bell icon by its name.
- Fixed the keyboard focus that sometimes jumped to the first card of a column when ASB packed the cards again, for example after a window resize.
- Added a copy button to the Comfortable card. It copies the app and session ID, the same text as in the row panel, and shows while the pointer is on the card or the card has keyboard focus.
- Fixed a session open that never finished when it started Claude Desktop, and took 5 s when it started ChatGPT. The open also kept the ASB service from stopping until systemd killed it after 90 s. ASB now starts apps without its output pipes and, under systemd, in their own scope.
- The ASB service now exits at most 5 s after a stop signal, and logs the pending cleanup step and the open Node resources.
- Made the list in the native row panel flat on the board background, with thin neutral lines around it and between its rows.
- Added an **App and session ID** row with a copy button to the native row panel, and gave the panel the same background as the board.
- Added Ctrl number keys to the native window: hold Ctrl to show the numbers 1–9 on the first nine whole cards, and press Ctrl+1 to Ctrl+9 to open that card.
- Fixed a Claude session that waits for a permission prompt showing Working; it now shows Waiting.
- Fixed native theme colors with RGB channels outside `0..1`. Color conversion now limits each channel to a byte, so the theme editor and phone palette receive valid `#RRGGBB` values.
- Shortened the ASB Bridge peer message prefix.
- Added `asb agent status` and `sources list/get/add/update/remove`, with `--json`, bounded JSON file or stdin input, partial updates, and idempotent source operations. The CLI uses the authenticated local API and reports saved, backend, and recent native UI state separately. UI reports do not prove visual display. Desktop and service modes share a private runtime descriptor; the phone gateway cannot access agent or source settings routes.
- Added source names made from labels, with id-or-name selectors for `asb agent sources get/update/remove`, and the read-only `asb agent peers`, which lists live local agents as `<instance>/<name>` and agent homes that are not in ASB. ASB Bridge task names now start with their Codex home name, for example `codex-personal-`.
- Added stable source settings revisions and optional `If-Match` checks. Stale source updates and removals return `409` without overwriting settings. Profiles now reloads when visible and after a source revision change, keeps unsaved edits and Add drafts, and shows conflicts when an edited source changes elsewhere. The source file stays at schema `1`.

- Added explicit `asb bridge link-claude <profile-home> <shared-home>` setup for cross-profile peer discovery and messaging. It links only the native Claude registry and IPC keys, keeps app data and provider credentials separate, preserves the original directory in a private backup, and refuses unsafe paths, unknown files, conflicts, and detected source changes. Install and uninstall keep the shared registry and backup. Native directory-link behavior was checked in Claude Code `2.1.303` and has no compatibility promise.

- Changed the Android app ID to `io.github.jamir_boop.asb` for F-Droid. The new ID installs as a new app beside the old `local.asb.companion` app, so pair the phone again and uninstall the old app. The channel sounds now use the app's own package name.
- Replaced the Google code scanner in the Android app with an in-app scanner made with CameraX and ZXing, so the app has no Google Play services. **Scan QR code** asks for the camera permission on first use. The phone camera or any QR scanner app also works: the `asb://pair` link opens ASB on the Check the PC screen. Paste still works. The Android release build has no dependency metadata block, signs with the key from `android/keystore.properties` when that file exists, and has Fastlane store text. Android releases use `android-v<version>` tags.

- Fixed a Claude Desktop chat that ends its turn with a wrap-up question: it showed Working, or Done without the question, and now it shows Waiting with the `?` and Needs input until you answer. A wrap-up without a question now shows Done.
- Fixed the Android app scrolling down when sessions move. When a session moved above the first visible row (for example after a pin), the list followed that row, so the rows on top went above the screen. The list now keeps its position by index, as on the desktop, and a provider warning that comes or goes does not move the rows. Each Column Flow column always shows its first card. A list that was at the top also starts at the top after a rotation or a return from Settings, so provider warnings stay in view.
- Changed the native row menu to a row panel (the approved option E): a session header, **Open in** the app, switches for **Unread**, **In the drawer**, **Pinned**, and **Discard result** (Working rows), and **Earlier** and **Later** for pinned rows. The panel has a ring in the accent color, so it stands out from the window, and it stays open while you change several marks. In custom colors, the search popover and other popovers now have a visible edge.
- Added PC sounds for Done, Needs input, and Failed. The ASB server plays the same opencode sounds as the Android app, made louder for PC speakers, and uses the same rules as the Android notifications, with one sound per update at most. It uses `pw-play` (or `paplay`) as an event sound, so its volume follows the System Sounds volume. The Debian package now recommends `pipewire-bin`.
- Changed the phone gateway to send the dashboard reply with gzip when the phone accepts it. The live notification service and the app read about 5 to 10 times fewer bytes. Every dashboard reply that the loopback server answers has `Vary: Accept-Encoding`, and the `ETag` and the 304 reply do not change.
- Added an R8 release build of the Android app. The local debug key signs it, and the install steps compile its profile.
- Changed the phone gateway to listen on more than one address. Preferences > Phone shows one check row for each private address: Home network, ZeroTier, or Tailscale. ZeroTier and Tailscale addresses let the phone reach ASB away from home. A `100.64.0.0/10` address counts only on a Tailscale interface. A Tailscale listener accepts only Tailscale and private callers. `phone.json` is now schema 2 (`bindAddresses`); a schema 1 file still loads. The pairing link is version 2 with all listening addresses, and `GET /phone/v1/hello` reports the listening addresses and port.
- Added `POST /api/palette` and the dashboard field `palette`. The ASB window sends its resolved colors (GNOME or Custom, with the success and warning colors) at start, after Apply theme or Reset, and after a GNOME style change. The server saves them in `$XDG_STATE_HOME/asb/palette.json` (mode `0600`), so the service keeps them after a restart. The phone gets the palette with the dashboard. The phone gateway cannot reach the route.
- Added the optional phone gateway. It is off by default. When you turn it on, it binds one private IPv4 address of the PC (default port `4630`) with TLS 1.3, a pinned self-signed certificate, and one bearer token for each phone. It forwards only the allowlisted session routes to the loopback server. The main server still binds only `127.0.0.1`.
- Added Preferences > Phone: turn phone access on or off, choose the address and port, see the certificate fingerprint, pair a phone with a one-time QR code, and remove paired phones. The Debian package now depends on `openssl` and recommends `python3-qrcode` for the QR code.
- Added `asb service install`, `uninstall`, `status`, and `run`. The optional `asb.service` systemd user service runs the ASB server and phone access without the window. It scans every two or five seconds with no client, so it sees task ends while the window is closed. The ASB window attaches to a running service.
- Added the ASB Android companion `0.1.0` in `android/`: the session list with the desktop filters, all row actions, Persistent unread, Open on PC, message motion, and the usage-limit state. It shows Done, Failed, and Needs input notifications with sounds from opencode.
- Added the usage-limit state: when a usage limit stops a session, its card is greyed out and shows "Resets in" with a countdown to the reset. ASB reads only the limit numbers and reset times from the Codex session logs and the Claude Code transcripts.
- Fixed Claude chats that showed Unread while they were still working. A delivered task notification, a message from another session to an idle chat, and a prompt with only images now start a task, so the chat stays Working until Claude's reply ends. A linked subagent that ends before its notification reaches the chat keeps the chat Working for up to 10 seconds instead of giving a false completion.
- Changed the failed-task dot for Claude background agents: when Claude replies to the notification of a failed background agent, the end of the reply sets the outcome, so the chat no longer gets a Failed dot (or a Failed phone notification) for that agent.
- Fixed the Codex usage-limit state when Codex stops a session before a window shows 100 percent. A stopped session now uses the newest window record at or before the stop, from its own log or another session of the same Codex home. Of the windows in that record that reset after the stop and show 90 percent or more, the most-used one gives the reset; with none, the session gets no reset. Pro weekly windows give a reset days away.
- Fixed ASB Bridge `0.3.2` treating an outgoing message that a peer holds as an incoming held message. The task's own text could show in the inbox dialog, go back into the same task, or send false receipts to the peer, and it could block idle notices. Inbox queries now use only incoming messages.
- Added message motion: when one session sends a message to another, a small light in the accent color flies from the sender card to the receiver card. This includes Claude to Claude, Codex to Codex, and messages between the two apps. ASB reads only the sender, the receiver, and the time, never the message text.
- Fixed Claude remote sessions that were not on the board. On about 2026-10-10 the Claude app changed its watch request form and added a new query parameter. ASB now accepts any query parameters on the session-list and watch paths.
- Fixed a Claude or Codex question that stayed an unread dot after you answered it, with Persistent unread on. A question now gives attention only while it is open. An old saved question mark loads as none.
- Added ASB Bridge, moved from claude-uds-bridge `0.3.0` with its Git history and renamed to `asb-bridge`.
- Added `asb bridge status`, `install`, and `uninstall` for selected providers. Installation needs explicit targets or `--all`; without targets it shows usage and changes nothing.
- Added the on-demand `/bridge` skill for Claude Code and `$bridge` skill for Codex.
- The root tests now skip TypeScript files, so Bun runs the bridge tests separately.
- ASB Bridge `0.3.1` checks Bun on the running Codex app-server PATH and warns when it is missing. Recovery is documented; uninstall no longer needs Bun.
- Definite Codex delivery refusals now drop the message with `delivery-refused`, clear its awaiting mark, and send a receipt. Uncertain outcomes stay `unknown`.
- Receiver revival uses one loaded-thread list per app-server sweep. Desktop probes use the last session-end burst (a 30-second window) and have a one-second total timeout, also when the loaded list fails.
- Removed the undocumented bridge target flags from the ASB package installer. Use `asb bridge install` with explicit targets or `--all`.
- Changed held-message checks from 500 milliseconds to two seconds.
- Removed four unused MCP thread-ID aliases. Native `x-codex-turn-metadata`, `threadId`, and `thread_id` remain supported.

See [ASB 1.9.0 release notes](docs/releases/v1.9.0.md) for downloads, upgrades, and check limits.

## ASB 1.8.1 - 2026-10-13

- Fixed duplicate native toolbar filter controls. Working-only uses its existing pill without a second chip. App chips appear only while the Codex and Claude pills are hidden. Other restricted state chips and the archive chip remain available. Filters and saved settings keep their values.

See [ASB 1.8.1 release notes](docs/releases/v1.8.1.md) for downloads, upgrades, and check limits.

## ASB 1.8.0 - 2026-10-13

- Kept the native toolbar in one row, with fixed Preferences and native Close. Extra pills and removable App/state/archive filter chips scroll horizontally. Narrow search uses a popover; Refresh stays in Sessions. Below 320px, hide the disc and toolbar search control while typing and Preferences search remain available.
- Hid app pills by default. Added Sessions > Show app pills, saved as optional boolean `showAppPills` in schema `1` layout settings. Narrow pills use the existing provider icons. Hiding pills and changing/resetting view or width keep filters and the setting.
- Removed main-view numeric counters and the count summary. Drawer now uses a plain occupancy dot, with no numeral and no narrow label.
- Made Persistent unread on by default when no valid saved setting exists. An explicit saved false stays off. Successful opens acknowledge attention only while it is off.
- Archived the [X11 frame-timing investigation](docs/benchmarks/x11-frame-timing-2026-10-13.md), including failed graphics trials, restoration checks, and retest limits. No safe app-only 240 Hz fix was found. The existing Python workaround stays unchanged.
- Archived the [Qt comparison](docs/benchmarks/python-qt-2026-10-13.md) and numeric samples. One valid main-monitor manual pair found no meaningful scroll speed gain, lower Qt resize callback p95, and higher Qt PSS. Different resize paths limit the comparison. Eight bounded native groups passed.
- Archived the [Rust comparison](docs/benchmarks/python-rust-2026-10-12.md), numeric samples, and [acceptance coverage](docs/benchmarks/rust-acceptance-2026-10-12.md). Rust startup and PSS improved; interaction timing was mixed and repaint cadence was close. Python and Rust each passed fourteen critical native groups.
- Removed both unreleased prototype trees and their harnesses after evaluation. These historical experiments cannot be run from the current tree. Production ASB uses Python, with no new runtime dependency.

Files from 1.7.0 remain compatible. Existing Persistent unread choices stay set; the new Show app pills setting is off when absent. See [ASB 1.8.0 release notes](docs/releases/v1.8.0.md) for downloads, upgrades, and check limits.

## ASB 1.7.0 - 2026-10-10

- Moved native settings to the approved Option B Preferences window, with Sessions, Appearance, and Profiles. Wide windows use left navigation; narrow windows use tabs. Repeated opens raise the same window. Closing Preferences keeps ASB running and keeps form edits. Profiles loads only on the first visit and after explicit actions. Existing settings, source actions, and storage stay unchanged.

Files from 1.6.1 load unchanged. See [ASB 1.7.0 release notes](docs/releases/v1.7.0.md) for downloads, upgrades, and check limits.

## ASB 1.6.1 - 2026-10-10

- On composited X11, the existing realize hook disables GTK4 compositor-feedback frame sync when the surface API is available. Wayland and noncomposited displays stay unchanged. Native springs, the renderer, and reduced-motion rules stay unchanged. This GTK4 X11 backend API is deprecated and has no replacement. The fallback frame clock may run at about 60 Hz.
- Native `SessionColumn` snapshots now skip columns outside the viewport. The viewport check includes card-motion bounds. Row allocation, input, focus, and accessibility stay unchanged. Scroll and layout invalidate skipped snapshots when their columns enter the viewport.

Resize lag remains unresolved. See [ASB 1.6.1 release notes](docs/releases/v1.6.1.md) for downloads, upgrades, and check limits.

## ASB 1.6.0 - 2026-10-09

- Added the drawer. It holds unread cards that the user wants out of the way. In the normal list, a drawer card looks read: it has no unread dot, it is not Pending, and it sorts with the read cards. The drawer has no time limit. A card leaves the drawer in these ways: **Take out of drawer**; Read; Unread through the API; a successful open when Persistent unread is off; new attention; or no stored mark is left. With Persistent unread on, an open keeps the marks and the card stays in the drawer.
- The card comes out as normal unread and Pending when ASB sees a result or failure time that is newer than `drawerSeen`, or when the chat has a question. This includes a task that ASB did not see in its Working phase, for example a short task between two scans. A native unread that is raised again in the original app with no new result does not take the card out.
- When no stored mark is left, for example the chat was read in the original app and ASB has no other mark for it, the card leaves the drawer as a read chat. An unknown native read state for a time keeps the card in the drawer.
- Only a row with an unread dot can go in the drawer. A row with a question (`?`), a required action in the original app, or a Working state cannot. A drawer card that goes Working stays in the drawer. A stopped task keeps the card in the drawer. A task that ends with Discard result on acknowledges the completion and native marks, as in 1.5.0. A drawer card whose only mark is of that kind is then read and leaves the drawer. A drawer card with a manual Unread mark stays in the drawer and is not Pending.
- ASB saves the drawer in its own `pending.json` with two numeric record fields: `drawer` (0 or 1) and `drawerSeen`. `drawerSeen` is the newest result time that ASB had seen for the chat when the card was put in the drawer. The format version stays 1 and files from 1.5.0 load as they are. ASB changes nothing in Codex or Claude.
- Each dashboard row has the boolean field `drawer`. A drawer row has `unread: false`. Added the local actions `POST /api/threads/<id>/drawer-in` and `POST /api/threads/<id>/drawer-out`. They take an empty JSON object, use the same access checks as `mark-read`, and reply `{ changed, threadId, thread }`. `drawer-in` gives 400 unless the row is unread with no question and no required action. `drawer-out` gives 400 unless the row is in the drawer. Read and Unread clear the drawer flag.
- Added the **Drawer** pill, a fifth native toggle pill after Working. It has a drawer glyph, the word "Drawer", and an accent count bubble. The count is the number of drawer rows that the archive setting allows: archived rows count only while "Show archived sessions" is on. Search, the app pills, and the state filters do not change it. The bubble is hidden at zero and shows `99+` from 100. The checked pill has the accent color as background and an inverted bubble (background color with accent text). The tooltip is "Show only the sessions in the drawer, as unread. Point here to see them in the list." The accessible label is "Drawer only. Sessions in the drawer: N". In a narrow window the word "Drawer" can ellipsize and the count text can shrink to no width. The count text now starts with the Pending number ("N Pending · M sessions", before "N sessions · M Pending"). Thus the default 420 px window, which cuts the end of the text with five pills, still shows the Pending count. The glyph is drawn with styled boxes: a small rounded rectangle outline with a short handle line. There is no new icon file. With the pill on, the list shows the drawer rows, and they look unread as normal. The pill combines with the app pills, search, the state filters, and the archive setting. It does not combine with Pending: turning one on turns the other off. The empty drawer view says **The drawer is empty. Put an unread session in it to get it out of the way.**
- Added a hover rule in both native views. While the pointer is on an unread row, it looks read: the unread dot is not shown and the state label has the read tone. When the pointer leaves, it looks unread again. In Comfortable, the Read slot shows its check cue while the pointer is on the card. A `?`, the stop square, and the Discard ring do not change on hover. The read look (no dot, and the check cue in Comfortable) also shows while the row has visible keyboard focus or while one of its controls has visible keyboard focus. Focus that comes from a mouse click does not change the row: its dot stays. In Compact, focus never hides the dot.
- Added the drawer button in Comfortable. The card corner is now a row of three: drawer, read, pin. The drawer button shows only while the pointer is on the card, while the card has visible keyboard focus, or while the button itself has visible keyboard focus. A row that looks unread gets the button that puts it in the drawer. A row in the drawer gets a filled glyph in the accent color that takes it out. A drawer row outside the drawer view hides its Read target until the pointer or visible focus is on the row. The title keeps its width: the three controls lie over the end of the first title line, with a 16px fade to the window background, not to the hover color. On a highlighted row this gives a slightly darker pocket behind the buttons. A column narrower than 190px has no drawer button. Compact has no card buttons.
- Added **Put in drawer** to the row menu of a row that looks unread, and **Take out of drawer** (with **Read**) to the row menu of a row in the drawer, in both views. The row menu of a drawer row has no **Unread**.
- Added the peek. While the pointer is on the Drawer pill and the drawer view is off, the drawer rows show their unread look in place. This changes CSS only on visible drawer rows, with no list render.
- The row tooltip can show the flag **In the drawer**. A drawer row keeps its normal unread note; the note text does not name the drawer. A Working drawer row has the flag and no note. The accessible label of a drawer row ends with "In the drawer. Still unread."
- The web view (`npm start`) shows a drawer row as read. It has no Drawer pill and no drawer actions.
- List changes from the drawer use the existing card motion. The drawer adds no timer and no frame loop.
- Working cards no longer change places while they work. A Working row sorts by the start of its current task (`workingSinceMs`), not by its last activity, so it does not move while it works. A Working row with no known start sorts after the Working rows that have one, by ID. In the Pending group, Working rows (a question on a Working chat) come first, by task start, and the other Pending rows follow by newest activity. A row moves when its state or group changes or a new task starts.
- Fixed a real pointer click on a card button (Read, Pin, Discard or Keep, and the new drawer button) that also opened the session in its original app. This defect was also in 1.5.0 and earlier. A row with a card action in flight now ignores activation.
- Fixed a malformed session ID on an ASB state-action route that gave HTTP 500. It now gives 400.
- Fixed a card that was many lines high when the title of its chat had line breaks. The line limit of the title label is for each paragraph. The card now shows the title as one paragraph: one line in Compact and a maximum of two lines in Comfortable. The dashboard row and the tooltip keep the raw title. This defect was also in 1.5.0 and earlier.
- Fixed a Claude Desktop Code chat that showed Idle while a background subagent ran again. This occurred after the chat sent a message to an ended subagent, which starts that subagent again with the same ID and transcript. The chat now shows Working from the message until the end of that subagent. A task notification with the status `stopped` now ends the work of its subagent. This defect was also in 1.5.0 and earlier.
- Fixed a Claude Desktop Code chat that showed Unknown, with no time limit, after a background subagent ended. This occurred when the chat was busy at the end of the subagent and the log of the subagent was not in the folder of the chat. The app then writes the task notification as a queued `attachment` record, and ASB did not read that form. The chat now shows Idle after such a notification. A task notification with the status `killed` now ends the work of its subagent. This defect was also in 1.5.0 and earlier.
- Fixed a Claude Desktop Code chat that showed Unknown while a background subagent worked after the end of the main turn. This occurred after the app gave the chat a new CLI session ID: the subagent logs stay in the folder of the old ID, and ASB did not find them. ASB now also uses the log of a linked subagent from another session folder of the same project folder. The chat shows Working while that subagent works, then Idle. This defect was also in 1.5.0 and earlier.
- Fixed the Working time and the place of a Claude Desktop Code card that changed when the app compacted the context of the chat. The summary record of a compaction counted as a new prompt. Thus the task start moved to the time of the compaction, and an idle chat could show Working. The tool calls that the app recorded after the summary were also lost, and with them the link of a subagent. The task and its start time now continue across a compaction. This defect was also in 1.5.0 and earlier.
- Fixed a Claude Desktop Code chat that did not show Working for a background subagent when the record of the launch call had the stop reason `refusal`. A record with a tool call is not the end of a turn, because the app runs the tool. This defect was also in 1.5.0 and earlier.
- Fixed a Claude Desktop Code chat that showed Idle while a background workflow that the chat started was in progress. The chat now shows Working until the task notification of the workflow. This defect was also in 1.5.0 and earlier.
- Fixed a last row that was cut at the bottom of the native window. Row packing now uses the viewport height and the height of the highest visible row after layout, not the scrolled window height and the constants 22 and 68. The defect occurred with a font that has higher lines than the reference font, and with `gtk-overlay-scrolling` off, where the horizontal scrollbar takes height below the rows.
- Reduced shared hover work during scrolling. Scroll clears the shared highlight once. Pointer motion cannot restart it during the wheel spring. After scroll, stationary or generated motion cannot restart it; real pointer movement restores the glide. Native row hover and focus stay available. Spring, trackpad, and reduced-motion behavior stay unchanged.
- Reduced native list work. Filters reuse column containers within the full dashboard count and current row capacity. Source removal releases excess containers. Rows skip unchanged cached text and action updates. Motion frames skip draw invalidation outside the viewport and clear all cached motion paint at the end.
- Missing or failed watch roots now retry every five seconds without walking healthy folder trees. Required failures keep watcher coverage incomplete and polling available. Recovered subtrees increment `performance.dashboard.watchWalks`; simple absent-root checks do not. Late callbacks from closed or replaced watchers are ignored.
- Successful native session actions now request a normal queued refresh. They keep one follow-up when a read is active. Discard still forces its server validation scan before arming.
- The browser now reuses rows by chat ID and provider/project groups for its visible list. A title change does not rebuild rows or listeners. The row cache stays within current dashboard IDs, with in-flight opens, retained focus, and collapse choices preserved. Browser reads send `If-None-Match`; `304` skips list updates while age labels still update once a minute. Errors clear the tag. Successful opens use normal queued refreshes, and queued forced refreshes remain forced.
- Concurrent Claude profiles with the same `projectsDir` now share one directory signature check. They also share cached root, subagent, and Workflow lookup maps. Multiple migrated child candidates still get current modification times.
- Local Codex and Claude signal and lifecycle caches now retain up to 5000 keys per enabled store. Shared values are held once. Codex lifecycle checkpoints use the same ownership, including rollouts outside the store folder. Local metadata limits are 5000 Claude records and 32 Codex records per store. Disabling, removing, or changing a store prunes its local cache owners while shared active values remain. Owner tracking permits eight registered source stores plus one bounded standalone scope. Stale in-flight index reads cannot restore invalidated or removed entries. Remote response-cache retention stays separate and unchanged.
- Claude remote body decoding and parsing now use one lazy shared worker. Runtime body reads queue before allocation and run one at a time; key discovery and stat scans retain six concurrent readers. The queue is bounded to 512 metadata jobs and 48 MiB of explicitly submitted async bodies. Existing body limits and parser rules stay unchanged. Idle workers are unreferenced. Shutdown and deadlines reject queued work immediately. The worker closes gracefully after its active bounded parse returns, and a replacement waits for that exit. This avoids the native-zlib abort from forced termination on Node.js 24.21. A hung native parse can still block worker exit and replacement. The first remote load has worker startup overhead. No runtime file or dependency was added.
- Claude transcript signal reads now continue from an in-memory checkpoint after a guarded append. They keep loaded questions and metadata, recover complete lifecycle data when needed, and show a valid final JSON record without a newline. The next append rereads that final line. Truncation, replacement, equal-size changes, and detected boundary rewrites trigger recovery. The append guard assumes earlier bytes stay unchanged when a file grows. Pending permission entries are limited to the newest 5000.

See [ASB 1.6.0 release notes](docs/releases/v1.6.0.md) for downloads, upgrades, performance samples, and check limits.

## ASB 1.5.0 - 2026-10-09

- Reduced the work of the first read of a Codex rollout log that is larger than the 256 KiB tail. When the tail gives the lifecycle state, ASB no longer parses each line of the full log. It searches the raw bytes before the tail for a real question call (a `function_call` named `request_user_input` or `request_user_input_async`). It reads lines only from such a call until the question state is clear again. The results are the same as before. A log whose tail has no lifecycle event still gets the full scan. Later reads continue from the saved offset, as before.
- On Linux, source watchers now follow new and removed folders from `rename` events, with one `stat` for each event entry. ASB does a full directory walk only at start, when the list of watch paths changes, while coverage is incomplete (every five seconds, as before), after a watcher error, when a watch root reports its own name, after a burst of more than 64 structure events, and every 60 seconds as a safety net. Before, ASB walked all directories before each dirty scan and every five seconds. Added the counter `performance.dashboard.watchWalks`.
- Added not-modified replies for `GET /api/dashboard`. Each `200` reply, with or without `?force=1`, has an `ETag` header: a quoted SHA-256 content hash of all reply fields except `generatedAtMs` and `performance`. The dashboard replies also have `Cache-Control: no-store`. A request with `If-None-Match` equal to the current tag gets `304` with no body. A forced request still scans first. The access checks run first, as before. Added the counter `performance.dashboard.notModified`. The native window sends the tag of the list that it shows and does no work on a `304`. It clears the tag after an error and after a POST reply changed its list. The web view sends no tag and gets `200` as before.
- A background poll no longer changes the native Refresh button. The button is insensitive only while a forced refresh is in flight or queued.
- At start, no widget in the native window has the keyboard focus. Before, the search field had it, and its blinking cursor repainted the window. Typing a printable key still moves focus to the search field. The first Tab goes to the search field.
- A row title is now limited to 300 characters. A longer title ends with `…`. Whole Unicode code points are kept. Codex stores can hold a full prompt as a title. Search matches the limited title. Claude Desktop Code titles keep their own shorter limit.
- Wheel scrolling now uses a critically damped Libadwaita spring toward the target, with a continuous velocity. The damping ratio is 1. The spring settles in about 350 ms with no overshoot. It replaces the restarted 180 ms exponential ease-out. The step per click, the clamped target for same-direction input, the reversal from the current visible position, the direct trackpad/surface input that cancels the animation, the immediate movement with GNOME animations off, and the cancel conditions are unchanged. There is no permanent frame loop.
- Added card motion in the native window. When the order or the set of visible cards changes because of data or filters, each card that stays visible glides from its old place to its new place, and each new card fades in. A card that leaves disappears at once. The causes are a row that goes from unread to read, a new order from a refresh, a pin move, search text, the pills, the menu filters, and the archive setting. One shared animation of about 350 ms with a critically damped spring feel drives all cards. A new change during the animation starts from the current painted places. There is no motion at the first render, when the window is not mapped, when GNOME animations are off, or when the packing dimensions change (window size, column width, view). The motion is paint only: allocation, input, focus, and accessibility are at the final layout at all times. The shared hover highlight is cleared when a motion starts. There is no permanent frame loop.
- Fixed columns that became wider than the shared column width. This occurred when the list had fewer columns than the window can show, for example in search results, and a column had long titles. Columns now keep the shared width in all cases.
- The runtime file count stays 30.

See [ASB 1.5.0 release notes](docs/releases/v1.5.0.md) for downloads, upgrades, and check limits. The Node tests and the native logic tests pass. The GTK widget test file `test/asb_native_test.py` was run on one X11 machine: the window opens, four of its eight tests pass, including the new test for card motion, the wheel spring, and the column width, and four fail in the same way as with the 1.3.0 code because their expectations are older than the 1.3.0 layout. Card motion and the wheel spring were also measured on that display with synthetic rows. No Debian `apt install` was run. Native pixel fidelity remains unverified. See the [publication record](docs/OPEN_SOURCE_PLAN.md) for verified release checks.

## ASB 1.4.0 - 2026-10-09

- Fixed rows that showed Working and the unread dot together. A Working chat now has `unread` false and is Pending only for a question. Saved manual, native, completion, and retained marks are not changed and show again when Working ends. Tooltips and accessible labels follow the same rule.
- Added a `?` attention indicator for questions in both native views. It replaces the dot when a question needs an answer, uses the accent color, and keeps row size and the Comfortable Read control.
- Added Claude `AskUserQuestion` as a question signal. The row shows Waiting with question attention. It stays Working with question attention when no other permission tool is pending and a linked child has recent open work. A question row is Pending through its question attention, so Read or a successful open can acknowledge it.
- Claude permission waits, pending `ExitPlanMode`, and fresh remote `requires_action` now show a passive `?` with Waiting and Pending until resolved in Claude. Read cannot clear these waits, so the Comfortable control and row menu have no Read action. Pin stays available.
- Stopped root and group tasks now show Idle with a passive 7px muted square, including historical stops. Stop adds no unread mark. Question and unread attention have priority; new work or a later end removes the square.
- Added failed-task attention for observed Working-to-Idle terminal failures, including the last linked child end. Codex uses non-null `task_complete.error`; Claude uses terminal `result.is_error`, linked failed task notifications, and fresh remote session `failed`. Historical failures get no new dot on first load. Native read truth, successful-open acknowledgment, and Persistent unread keep their existing rules. Tooltips and accessible names distinguish failed from completed tasks.
- Pending now includes every visible dot or `?`, including unread dots on Unknown or archived rows. The passive stop square does not count as Pending. Updated the status mapping worksheet. Codex approval wait remains unsupported because local files provide no reliable unanswered approval signal.
- Each non-empty Claude user reply now starts a task, including `ok`, `y`, `1`, `.`, and `继续`. Local command records do not. Both readers skip a JSONL line that is not an object. Linked child task notifications handle `completed`, `failed`, `cancelled`, and `aborted`.
- Added one-shot **Discard result** for Working tasks, with **Keep result**, the approved hollow dot, and native row-menu access. Successful ends suppress their completion and matching native unread attention, including new Persistent unread retention. Questions, failures, manual Unread and cancellation keep their normal behavior. Linked child work keeps the arm until the group ends; explicit local end/start evidence prevents carry into the next task. Remote cache gaps and first late native-unread ambiguity are documented.
- Added protected local Discard/Keep POST actions with compatible numeric state fields. Discard scans current state before arming; Keep uses the normal cache without a forced scan. This rejects late cached arming after two tasks ended. An already-armed local task still has the documented latest-terminal observation limit. Malformed request JSON in the ASB session-action handler now returns 400; internal/source exceptions keep their existing status.
- Working without a question now returns directly to the Discard offer/ring and clears old Read feedback. Reading a Working question shows no confirmation check; Idle/Waiting Read confirmation stays unchanged.
- Order-only native refreshes now move changed rows inside existing columns, preserving widgets/actions and avoiding explicit menu/scroll/hover teardown. Added the approved 0.5-second monotonic guard after completed Read before Discard/Keep requests, while the ring/offer remains visible.
- Added the native A Unfolded card tooltip in both views. It shows the full wrapped path/title, state/time, app/source and profile dot, with one optional indicator note, short flags, and the current row error. Its GTK frame stays native. Each query computes current text without a source read and reuses one row-owned widget for an unchanged model/theme, while still calling GTK `set_custom`. Model/theme changes rebuild content; palette changes and row release clear the cache, including hidden rows. Accessible descriptions retain full path, state reason, and source identity; row names and control tooltips stay unchanged.
- Removed the native search delay and duplicate clear render. Previously shown rows stay cached across searches and filters, while removed dashboard IDs release their controllers. Queued focus restoration stops after a focus change. A successful open uses the cached dashboard and keeps one follow-up read when needed.
- **Move pin earlier / later** now moves the pin before or after the adjacent visible pinned row and sends nothing at the first or last visible pin. A row action error leaves the row when its state changes or the row leaves the list. The empty-list text follows the list. A moved row that had keyboard focus gets the focus again. Removed the unused CSS class `.asb-pending`.
- A pending Claude permission, plan approval (`ExitPlanMode`), or question tool now gives Waiting and Pending only for six hours after its tool event. After that, the usual rules apply.
- Fixed a missing completion or failure dot for a task that goes Working, Waiting, then Idle.
- Fixed a follow-up message in an armed Claude task cancelling Discard. Only a task that starts after an end later than the arm cancels it.
- Fixed Claude local-command records being treated as new work. Broad no-path invalidation now reuses unchanged lifecycle data; targeted/equal-size rewrites keep their safe invalidation behavior.
- Kept ASB Codex titles on the raw desktop-title path, with desktop-name priority and empty fallback, without selecting `first_user_message`. The upstream title path and native read-cache semantics remain unchanged.
- Protected the selected Claude remote response chain from aggregate eviction while retaining the 512-response and 5000-projected-session limits. Raw protected storage can reach `512 × 5000` records per cache root, with up to 32 roots; the raw metric remains visible.
- Fixed quiet native event streams reconnecting at the read timeout; validated streams now wait without a read deadline and close still releases blocked reads. Relative age signatures advance past one day, and empty XDG config paths use the home fallback.
- Fixed incomplete HTTP responses escaping the native request worker. They now dispatch the normal failure callback without partial response data, including source-error detail reads, so loading/action controls can recover.
- Icon registration errors now keep their message and allow the native window to open. Icon registration from source preserves a managed desktop entry that uses another launcher and reports the conflict before writing.
- When ASB cannot use `pending.json` in full, it shows the Pending state warning and moves the old file to `pending.json.bad` before the first save. `sources.json` uses the same rule (`sources.json.bad`) before the next source update or remove. The cannot-save Pending warning clears after the next good save.
- A forced read (`/api/dashboard?force=1`) during a scan now waits for it and gets one more scan that starts after the request. Forced requests during the same scan share that scan. A successful open marks the snapshot dirty and sends a `dashboard` event with the reason `asb-open`.
- On Linux, source watchers use one watch for each directory under the session folders, not one for each file, and find new folders at the next reconcile. Other platforms use the native recursive watch and fall back to directory watches. An injected `loadDashboard` with no source registry gets no default watch paths.
- Protected dashboard, source-list, and event reads against cross-site Origin/Sec-Fetch-Site requests, including forced dashboard refreshes. Rejected reads do not scan sources. Native requests without these headers, local browser reads, and address-bar navigation remain supported; asset and action rules stay unchanged.
- Fixed malformed request URLs stopping the ASB server. Invalid targets now return 400. The launcher's exit hook also stops its owned native process on normal/fatal JavaScript exits; SIGKILL and native aborts can bypass cleanup.
- Added a per-run app source token. The launcher gives it to the server and to the window (`ASB_SOURCE_TOKEN`). `POST /api/sources` and `POST /api/sources/<id>/remove` need the header `X-ASB-Source-Token` when a token is set; if not, the reply is 403. `GET /api/sources` is unchanged. A server started with `npm start` has no token.
- Malformed JSON now gives 400 on every action route. The open reply has no `resumeCommand`. Removed the `?refresh=` alias and `performance.notifications`.
- `~/.local/bin/asb` now starts the shipped `scripts/asb`. If the recorded Node.js is not usable, `scripts/asb` tries `~/.local/bin/node`, `/usr/local/bin/node`, then `/usr/bin/node`, and prints a message if none is usable. ASB appends `/usr/local/bin:/usr/bin:/bin` to the caller's `PATH` and puts no system folder before it.
- A source run keeps an installed GNOME entry. It replaces a source-run entry, including one from another checkout. Uninstall removes the `asb/releases` and `asb` data folders when they are empty.
- Raised the GTK floor to `4.12`. The Debian package depends on `gir1.2-gtk-4.0 (>= 4.12)`.
- Generated launchers preserve a validated absolute Node executable with shell quoting. Interrupted package work awaits writes and rollback, clears only its own lock/staging folder, and preserves foreign locks with an error that identifies the folder.
- Removed the unused upstream dashboard, service code, design records, and mock screenshot assets. Kept current ASB features, release media, the MIT license, upstream credit, and release history. Moved the ASB documentation case into its own test.
- Removed the dashboard mode from the Codex, Claude, and normalization modules. They have one mode. The Codex reader makes no network request, reads no `auth.json`, and writes no file; `AMC_CODEX_RESET_CREDITS` has no effect. The Codex thread query does not select `sandbox_policy`, `approval_mode`, `cli_version`, or `memory_mode`. Only the Claude Desktop Code reader remains for Claude. Removed `src/governance.mjs` and `src/token-usage.mjs`; the package whitelist has 30 runtime files. Removed the npm script `test:asb`.
- Corrected repository agent guidance for ASB's native Codex/Claude scope, local state, and loopback-only runtime.
- Moved display-free native data checks into the no-GTK logic suite, sharing the existing synthetic fixtures. Added isolated busy/free-port and icon-failure launcher checks without opening GTK or changing real app entries. ASB fixtures use built-in SQLite on Node.js `>=22.13` without the SQLite CLI.
- Shared row/tooltip indicator CSS without changing roles or geometry, and removed the unused source-description alias while retaining the actual accessible description.
- Documented that the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files.

See [ASB 1.4.0 release notes](docs/releases/v1.4.0.md) for downloads, upgrades, and check limits. The Node tests and the native logic tests pass. The GTK widget test file `test/asb_native_test.py` was run on one X11 machine: the window opens, three of its seven tests pass, and four fail in the same way as with the 1.3.0 code because their expectations are older than the 1.3.0 layout. No native screenshots and no Debian `apt install` were run. Native pixel fidelity remains unverified. Codex approval waits have no icon, because the local files have no signal for them. See the [publication record](docs/OPEN_SOURCE_PLAN.md) for verified release checks.

## ASB 1.3.0 - 2026-10-08

- Removed the theme divider contrast limit. Any valid six-digit divider color now applies and saves, including the background color. Dark background and text contrast checks stay in place.
- Fixed theme picker changes being discarded while GNOME colors was selected. A user color change now selects Custom colors; Apply validates, applies, and saves with visible feedback. Loading and reset keep their intended mode, and invalid colors or save errors keep the previous theme.
- Added native smooth horizontal wheel scrolling in both views, with a 180 ms ease-out, repeated-input accumulation, immediate reversal, and clamped targets. Trackpad input stays direct; GNOME animations off and external scroll/layout changes stop wheel motion.
- Fixed duplicate Claude Desktop Code rows when local bridge aliases use `session_` and remote cache IDs use `cse_` for the same token. Kept local folders and open links, separate chats, and remote rows with invalid or ambiguous links.
- Added a native Working pill after Pending. It shares the state menu and restores all states when off. Working alone selects Working; Working plus Pending shows Working or Pending/unread chats. App, search, and archive filters still apply. Empty-result text uses the available width.
- Added one shared Comfortable hover highlight that glides between cards and columns in 200 ms and fades in 100 ms. It uses native animation, keeps card positions and actions, respects GNOME animations off, and clears when the list changes.
- Added C Restore on hover for Comfortable Idle-read text. Title, folder, state, and age use quiet palette roles without reducing contrast below 4.5:1; hover/focus restores normal text. Pinned Idle-read rows follow the same rule, while provider marks and controls retain their strength.
- Fixed Codex root execution while explicitly linked nested subagents have current work. Kept bounded cached reads, group timing, child question attention, and completion attention after the group ends. Stale or missing child lifecycle gives Unknown; cancellation does not add completion attention.
- Added a native **App sources…** table and editor for up to eight Codex/Claude profiles, with validated local folders, installed launchers, enable/disable, counts/status, and owner-only source settings. When source settings are absent, first use registers the known ChatGPT Personal coding profile only if its local store and installed launcher are present. Ordinary ChatGPT cloud chat history is outside this source. Separate stores keep separate chat IDs and open targets; original app data and sign-ins stay unchanged.
- Fixed registered app launchers being killed after five seconds. ASB now returns after a detached app spawn succeeds, keeps launch errors visible, and leaves the app running when ASB closes.
- Added the approved Soft dot at the lower-left of existing provider icons when that app has multiple registered sources. Codex and Claude use the same passive 6px fill with a 1px background rim. Source names remain in tooltips, accessible descriptions, and search. Profile numbers are not visible; row dimensions, actions, and existing filters stay unchanged.
- Added a source Color picker with muted Slate blue, Clay, Plum, and Sage presets. Optional source colors save in the owner-only schema `1` settings; old records get stable defaults and edits without a color keep the existing value. Contrast checks keep markers distinct from the base and hover backgrounds. Source IDs, state/unread colors, saved marks, and original app data stay unchanged.
- Fixed dark profile colors being rejected on Save. Any valid six-digit hex color now saves; the displayed dot keeps 3:1 contrast without changing that color. Save success and errors stay visible in the editor.
- Added **Show profile dot** for each source. Turning it off hides only that profile's passive dot in both views and keeps its color for later use. Old settings show the dot; edits that omit the new flag retain its value.
- Added the app-source registry to the explicit package whitelist, bringing the current runtime to 32 files. Profile files and registration changes use the existing source watchers and polling fallback.
- Updated the synthetic demo source to show four switches between sample Codex and Claude Desktop Code chats. The existing README video link is unchanged.

See [ASB 1.3.0 release notes](docs/releases/v1.3.0.md) for downloads, upgrades, and check limits. No native UI tests, new native screenshots, or Debian `apt install` were run for this release preparation. See the [publication record](docs/OPEN_SOURCE_PLAN.md) for verified release checks.

## ASB 1.2.0 - 2026-10-07

- Added the approved C Corner pair to Comfortable cards: a top-right Read dot beside Pin/Unpin, visible pins on hover/focus, and persistent pinned controls. Actions use the existing ASB APIs, saved pin order, drag reorder, and row menus.
- Added a 1.6-second Read check after a successful ASB acknowledgment. Failed Read keeps the dot. Guards keep stale results and feedback from hiding new attention. Read stays separate from opening, execution, source read state, and question resolution.
- Kept Compact, the 68px Comfortable height, the outer frame, and footer state/time. Circular overlay controls reserve folder/title space without changing row measurement.

- Separated ASB server and opener paths. Excluded the legacy server from ASB packages and shared existing snapshot and watcher logic. The runtime has 31 files, down from 42 in `1.1.0`.
- Removed seven dead browser helpers and unused CSS.
- Shared Codex and Claude cache and file-signature helpers.
- Used standard SQLite process handling with `promisify(execFile)`. Kept SQL input and errors unchanged.
- Simplified native Read/Unread action routing. Kept existing features and privacy limits.

See [ASB 1.2.0 release notes](docs/releases/v1.2.0.md) for upgrades and check limits. The Corner pair review covers code and logic. Native pixel fidelity remains unverified; no native UI tests or new native screenshots were run.

## ASB 1.1.0 - 2026-10-07

- Added remote Claude Code rows from approved local session-list/watch cache bodies. Kept cursor-linked source scope, explicit cached worker state, validated existing-session links, local-twin dedupe, and bounded reads. Partial cache coverage is reported; no credentials or remote requests are used.
- Fixed Claude root execution while explicitly linked background Agents remain active. Added child counts, current group timing, and completion attention after the group finishes. Stale or missing child signals give Unknown; interruption and error do not add completion attention.
- Kept Claude lifecycle recovery and child reads in the existing bounded cache and six-read concurrency limit.
- Native provider warnings now hide after five seconds. Repeated polls do not show the same warning again; dashboard fetch errors stay visible until a successful refresh.

See [ASB 1.1.0 release notes](docs/releases/v1.1.0.md) for downloads, upgrades, and cache limits.

## ASB 1.0.0

The first public ASB release provides one native GNOME window for local Codex and Claude Desktop Code chats.

- Added Compact and Comfortable views with adaptive columns, horizontal scroll, shared width, and saved layout.
- Added app/state/Pending filters, search prefixes, and direct opens in the original apps.
- Added independent ASB Read/Unread marks, Persistent unread, pins, drag order, and keyboard movement.
- Kept execution state separate from attention. Added current working time from source starts.
- Added GNOME colors and validated custom dark colors in ASB's own settings.
- Added source events, adaptive polling, row reuse, bounded caches, and an ASB reader path that omits unused dashboard work.
- Kept original chat stores read-only. ASB reads no credentials and makes no model calls or external network requests.
- Added Debian and per-user Linux packages, checksums, public docs, and a synthetic Remotion demo.

See [ASB 1.0.0 release notes](docs/releases/v1.0.0.md) for installation and limits. Linux is the native release target.

## Upstream history

The following entries are the inherited Agent Mission Control history by forxidian. They describe the upstream dashboard and its own version series, not ASB `1.0.0`. The original MIT license remains unchanged.

## [0.6.0] - 2026-08-21

### Update preview / 更新预览

The original upstream release included a synthetic model-service dashboard screenshot.

> This screenshot is generated entirely from synthetic mock data. It contains no local threads, real paths, account identifiers, credentials, or actual quota and balance values.
>
> 该截图完全由虚构 mock 数据生成，不包含本机任务、真实路径、账号标识、凭证或实际额度与余额。

### English

#### Added

- Added a five-service model-resource portfolio for GPT / Codex, Kimi, Alibaba Bailian Token Plan, Grok, and DeepSeek, with normalized subscription windows, prepaid balances, model catalogs, source freshness, and explicit live/cached/external-only/error states.
- Added read-only Cindy and Kimi adapters plus an official DeepSeek balance query through `AMC_DEEPSEEK_API_KEY` or Cindy's owner-scoped Keychain credential; credentials never enter frontend payloads, and successful balance reads are throttled for 60 seconds.
- Added Cindy session support with explicit Claude Code, Codex, and Pi harness labels plus validated `cindy://session/<id>` opening, so Cindy-owned tasks return to the Cindy frontend.
- Grouped Cindy collaboration workers, provider subagents, and nested descendants under their root host. Recent threads now contain host rows only, while host badges and activity include the full descendant tree; Cindy-owned raw harness sessions are deduplicated without hiding independent client sessions, and harness-only providers are no longer presented as independently used clients.
- Reworked subscription quota cards around a prominent time-to-reset countdown, paired quota/time remaining percentages, and ranked use-more/use-less guidance. Sanitized local quota samples now graduate projections from a low-confidence cycle estimate to confidence-labelled historical trends.
- Added near-real-time Kimi quota monitoring through the desktop client's current access token, exposing only the monthly total requested by the user. Tokens remain request-local; only an owner-readable sanitized snapshot is persisted for stale fallback.
- Added `AMC_KIMI_QUOTA=0` to disable Kimi login-state access, plus precise quota percentages, reset details, and observation freshness in model-service cards.
- Added an optional minimal-permission Chrome bridge for Alibaba Bailian Token Plan. It refreshes the seven-day quota every five minutes from the logged-in console, posts only allowlisted fields to localhost, and persists an owner-readable sanitized fallback snapshot without cookie access.
- Added near-real-time Grok weekly quota monitoring by reusing Cindy's current xAI access token through macOS Keychain. The token remains in process memory; only allowlisted plan, quota, reset, product-share, and balance fields are persisted.
- Added automatic DeepSeek prepaid-balance monitoring through Cindy's owner-scoped Keychain credential, with `AMC_DEEPSEEK_API_KEY` override and `AMC_DEEPSEEK_BALANCE=0` opt-out.

#### Fixed

- Bounded per-project similar-title governance comparisons and reused normalized title tokens, preventing a 5,000-thread history from blocking the local HTTP server and making the installed PWA appear hung.
- Changed the disconnected macOS menu-bar badge action to restart the AMC LaunchAgent and open the installed Chrome / Edge PWA shim directly before any ordinary browser fallback. The helper now discovers the user-specific LaunchAgent label instead of publishing a machine-specific identifier.
- Handled `sqlite3` stdio failures inside search-index calls so an early closed input pipe can no longer surface as an unhandled `EPIPE` and terminate the local server during PWA startup.

### 中文

#### 新增

- 新增 GPT / Codex、Kimi、阿里百炼 Token Plan、Grok、DeepSeek 五服务额度组合，统一订阅窗口、预付余额、模型清单、来源新鲜度，并明确区分实时、缓存、仅外部可查和错误状态。
- 新增 Cindy / Kimi 只读适配器，以及通过 `AMC_DEEPSEEK_API_KEY` 或 Cindy owner-scoped Keychain 凭证读取 DeepSeek 官方余额；凭证不会进入前端 payload，成功余额结果在进程内节流 60 秒。
- 新增 Cindy 会话支持，明确标识 Claude Code / Codex / Pi Harness，并通过校验后的 `cindy://session/<id>` 回到 Cindy 前端。
- 将 Cindy 协同 Worker、各 provider 的 SubAgent 和嵌套后代归拢到根 Host。最近线程只展示 Host，Host 的 Sub 数量和活动时间覆盖完整后代树；Cindy 已拥有的底层 Harness 会话会去重，独立客户端会话不受影响，纯 Harness 来源也不再被误列为用户独立使用的客户端。
- 重做订阅额度卡：突出显示距离刷新还剩多久，并排比较额度剩余与时间剩余，在顶部汇总“多用 / 少用”优先级。系统开始保存脱敏额度采样，历史不足时明确标注低置信度线性估算，积累后自动切换为带置信度的历史趋势预测。
- 新增 Kimi 近实时额度监控，复用桌面客户端当前 access token，只展示用户需要的月度总额度。令牌只在请求内存中使用，本地仅保存所有者可读的脱敏快照供失败回退。
- 新增 `AMC_KIMI_QUOTA=0` 关闭开关，并在模型服务卡片中显示精确百分比、重置细节和数据新鲜度。
- 新增可选的阿里百炼 Token Plan Chrome 本地桥接：每 5 分钟复用已登录控制台刷新 7 天额度，只向 localhost 提交白名单字段，并以所有者可读权限保存脱敏回退快照；扩展不申请 Cookie 权限。
- 新增 Grok 近实时周额度监控：通过 macOS Keychain 复用 Cindy 当前 xAI access token，令牌仅存于进程内存，本地只保存套餐、额度、重置、产品占比与余额白名单字段。
- 新增 DeepSeek 预付余额自动监控：默认复用 Cindy owner-scoped Keychain 凭证，支持 `AMC_DEEPSEEK_API_KEY` 显式覆盖和 `AMC_DEEPSEEK_BALANCE=0` 关闭。

#### 修复

- 将项目内的相似标题治理比较改为有界候选，并复用标题归一化 / 分词结果，避免 5000 条历史任务阻塞本地 HTTP 服务。
- macOS 菜单栏助手断连时会先重启 AMC LaunchAgent，再直接打开 Chrome / Edge 已安装 PWA；同时改为自动发现用户的 LaunchAgent 标识，不再在公开仓库写入机器专属命名。
- 在搜索索引调用内处理 `sqlite3` 标准流异常，避免输入管道提前关闭时以未处理 `EPIPE` 终止本地服务。

## [0.5.0] - 2026-07-27

### English

#### Added

- Added an experimental Portfolio implementation with per-project active, waiting, stale, archived, sub-agent, cost-breakdown, artifact, recent-action, and candidate-thread drilldown data.
- Added evidence-backed governance categories for Active, Waiting, Automation, Cleanup candidates, Archived, and dormant work without treating `notLoaded`, missing transcripts, or missing artifacts as completion.
- Added a read-only Portfolio Cleanup workspace with 30/60/90-day filters, host/sub-agent/automation separation, exact-title duplicate and recovery-title detection, similar-thread/canonical clues, selection, copy, and Markdown dry-run export.
- Added configurable long-run warnings based on compactions, tool calls, Agent tasks/turns, user inputs, verification signals, artifacts, and goal completion, with staged-summary, new-task, STATUS/HANDOFF, and stop-expansion suggestions.
- Added an advisory WIP view recommending no more than five concurrent Active host tasks while keeping Waiting and Automation in separate lanes.
- Added optional Codex gifted reset-credit summaries with expiry times, using local ChatGPT auth only for the reset-credit request and supporting `AMC_CODEX_RESET_CREDITS=0` as an opt-out.
- Added server-sent dashboard change notifications with polling fallback, plus guided toast notices for review and fix-loop actions.

#### Changed

- Hid the workspace tab strip and restored Threads as the default dashboard. Portfolio and Cleanup remain internal experimental implementations because stale/unarchived heuristics do not reliably represent whether the user has already handled a task.
- Prioritized cached input, non-cached input, output, and reasoning breakdowns over raw total-token rankings, while showing artifact and verification context without inventing an ROI score.
- Refined the Prompt Pack composer so copied packs remain collapsed for reopening, the top add control starts a fresh conversation, per-segment controls insert new sections, and saved attachments render as visual previews without foregrounding raw local paths.
- Stream-scanned a bounded set of high-cost Codex rollouts for governance counters, persisted aggregate checkpoints locally, then resumed later scans (including after server restarts) from the last processed byte with bounded read concurrency; cleanup remains client-side and never calls archive, delete, or move APIs.
- Bumped the PWA shell cache so installed local apps receive the Portfolio workspace assets without caching local API payloads.
- Refreshed the README screenshot set with synthetic 0.5.0 dashboard, full-history search, and artifact timeline examples.

#### Fixed

- Preserved explicitly selected stale or archived candidate threads in the recent task list so Portfolio drilldown opens the intended governance detail instead of resetting to the newest thread.
- Removed desktop and narrow-screen horizontal overflow in the Portfolio/Cleanup workspaces, including dense topbar and long-title cases.
- Counted Codex tasks from explicit `task_started` / `task_complete` / `turn_aborted` rollout lifecycle signals, with a low-memory full-file fallback when a large active turn pushes its start beyond the bounded tail window.
- Coalesced concurrent search index rebuilds and added SQLite lock waiting / bail safeguards, avoiding full-history search failures that flooded the UI with repeated `database is locked` errors.
- Broke the long-running CPU feedback loop by excluding AMC's own notification store from provider watchers, skipping unchanged notification writes, coalescing concurrent notification refreshes, rate-limiting file-change events, preserving warm dashboard snapshots, and stopping SSE refreshes from forcing full rescans.
- Restored server-side Codex desktop deep links for Codex Desktop history threads, including threads missing from the sidebar index, while keeping `codex resume` / Terminal recovery only for true CLI or no-deep-link fallback cases.
- Run Codex CLI resume recovery from the thread's original cwd with `--no-alt-screen`, so fallback Terminal recovery opens the expected project and surfaces Codex prompts/errors instead of a blank-looking session.
- Let local Codex review jobs run from non-Git workspaces while retaining read-only sandbox and no-approval settings.
- Hid the installed PWA window by reading its bundle id from the app shim path before falling back to localized app names, avoiding failures when AppleScript cannot resolve names such as `Agent 控制台`.

### 中文

#### 新增

- 新增实验性“项目组合 / Portfolio”实现，保留按项目统计 Active、Waiting、长期未更新、归档、子代理、成本拆分、产物、最近动作和候选任务的数据能力。
- 新增带证据的 Active、Waiting、Automation、Cleanup candidates、Archived 和 dormant 分类；不会把 `notLoaded`、缺少 transcript 或缺少 artifact 当成完成。
- 新增只读 Portfolio Cleanup 工作区，支持 30 / 60 / 90 天、主任务 / 子代理 / 自动化筛选、精确同标题重复、恢复类标题、相似任务 / canonical 线索、选择、复制和 Markdown dry-run 导出。
- 新增集中配置的长线程预警，结合压缩、工具调用、Agent task / turn、用户输入、验证信号、产物和目标完成判断，并给出阶段小结、新开任务、STATUS / HANDOFF 和停止无指标扩展建议。
- 新增 WIP 建议视图：建议同时 Active 主任务不超过 5 个，Waiting 和 Automation 使用独立 lane；不作为强制业务规则。
- 新增可选的 Codex 赠送重置次数与到期时间汇总；只为该请求读取本机 ChatGPT 登录态，并可通过 `AMC_CODEX_RESET_CREDITS=0` 关闭。
- 新增带轮询兜底的服务端事件实时同步，并为评审与修复闭环操作增加带下一步提示的固定 toast。

#### 调整

- 隐藏工作区标签栏并恢复“任务流”为默认看板。Portfolio 与 Cleanup 暂时只保留内部实验实现，因为陈旧 / 未归档规则无法可靠表达用户是否已经处理任务。
- 成本视图优先区分缓存输入、非缓存输入、输出和推理，再结合产物 / 验证上下文展示 raw total，不发明精确 ROI 指标。
- 优化 Prompt 打包器：复制后保留可再次打开的折叠包，顶部加号用于新开对话，段落控件用于插入新段；已保存附件改为可视化预览，不把本地绝对路径放在主视觉位置。
- 对有限数量的高成本 Codex rollout 首次使用流式深扫，把聚合 checkpoint 保存在本地，后续（包括服务重启后）从上次处理的字节位置增量续扫，并限制并发读取数；Cleanup 仍是纯前端 dry-run，不调用归档、删除或移动 API。
- 更新 PWA 静态壳缓存版本，让已安装的本地应用获得 Portfolio 资源，同时继续禁止缓存本机 API payload。
- 更新 README 脱敏截图组，用虚构数据展示 0.5.0 的 dashboard、全历史搜索和素材时间线界面。

#### 修复

- 保留用户从 Portfolio 显式选择的陈旧或归档候选，使下钻详情不会被最近任务列表重置到最新线程。
- 修复 Portfolio / Cleanup 在桌面和窄屏下的横向溢出，包括密集顶栏和超长标题场景。
- Codex 运行中计数改为识别 rollout 中明确的 `task_started` / `task_complete` / `turn_aborted` 生命周期信号；当大任务把开始事件挤出尾部读取窗口时，再用低内存逐行扫描补读，避免少算工作中任务。
- 合并并发搜索索引重建，并为 SQLite 调用增加锁等待和遇错即停保护，避免全历史搜索因 `database is locked` 反复报错而刷满界面。
- 切断长期运行时的 CPU 自激循环：不再 watch AMC 自己写入的通知文件，通知无变化时不重复写盘、并发刷新单飞合并，文件变化事件限频且保留温热 dashboard 快照，SSE 刷新也不再强制触发全量扫描。
- 恢复 Codex Desktop 历史线程的后端 desktop deep link 唤起，包括未出现在侧边栏索引里的线程；`codex resume` / Terminal 只保留给真正 CLI 或无 deep link 的兜底场景。
- Codex CLI 兜底恢复会从线程原始 cwd 执行，并加上 `--no-alt-screen`，避免打开到 `~` 目录或把更新提示 / 错误藏成空白终端。
- 本地 Codex 评审任务现在可在非 Git 工作区运行，同时继续保持只读 sandbox 和免审批设置。
- 隐藏已安装 PWA 窗口时优先从 app shim 路径读取 bundle id，再兜底尝试本地化应用名，避免 AppleScript 无法解析 `Agent 控制台` 这类名称时报错。

## [0.4.5] - 2026-06-24

### English

#### Added

- Added token usage breakdowns for dashboard summaries, project rows, thread rows, and search details, separating fresh input, cache reads, cache writes, output, reasoning, and uncategorized tokens.
- Added a local Prompt Pack composer that lets users organize segmented instructions, paste or select attachments, save them under `~/.agent-mission-control/prompt-packs`, and copy a Markdown handoff package for another Agent.
- Added `POST /api/prompt-packs/:id/attachments` for same-origin local attachment persistence with safe pack ids, sanitized filenames, and size limits.
- Added a lower-emphasis grouped row action menu for recent threads and search results, with reveal-in-file-manager and deep-link copy actions while keeping open as the primary action.
- Added Codex native pinned-state badges from `pinned-thread-ids`; the unavailable direct pin/unpin menu action is not shown.
- Added `POST /api/threads/:id/reveal` to reveal known thread working directories or rollout files through the system file manager.

#### Changed

- Normalized token breakdown data from Codex, Claude, and OpenCode usage payloads, then carried the aggregates through project, search, and dashboard API responses.
- Refined the Prompt Pack composer so it starts collapsed until a segment is added, with lightweight between-segment insert controls and drag sorting while keeping arrow controls as a keyboard-friendly fallback.
- Moved the history search launcher beside, but outside of, the Prompt Pack shell, then reshaped the Prompt Pack composer as a notched module so the header and full-width segment area read as one unit without the search block being wrapped into it.
- Refreshed the README mock screenshot set with synthetic data for the 0.4.5 dashboard, history search, and artifact timeline UI.

### 中文

#### 新增

- 新增 token 用量拆分，在汇总、项目、线程和搜索详情中区分新输入、缓存复用、缓存写入、输出、推理和未细分 token。
- 新增本地 Prompt 打包器，可分段整理修改要求、粘贴或选择附件，将附件保存到 `~/.agent-mission-control/prompt-packs`，并一键复制给其他 Agent 的 Markdown 交接包。
- 新增 `POST /api/prompt-packs/:id/attachments`，用于同源本地附件保存，并限制 pack id、清理文件名和控制大小。
- 在最近线程和搜索结果右侧新增低权重的合并操作菜单，支持在文件管理器中显示和复制 deep link，同时保留“打开”为主操作。
- 新增从 `pinned-thread-ids` 读取的 Codex 原生置顶 badge；不可用的直接置顶 / 取消置顶菜单项不再展示。
- 新增 `POST /api/threads/:id/reveal`，可对已知线程的工作目录或 rollout 文件调用系统文件管理器显示。

#### 调整

- 统一解析 Codex、Claude、OpenCode 的 token 明细，并把聚合结果带入项目、搜索和 dashboard API。
- 优化 Prompt 打包器交互：默认不展开空段落，点击新增后再出现待填写段落；段落之间新增轻量插入控件，并支持拖拽排序，同时保留上 / 下箭头作为键盘友好的备用操作。
- 将历史搜索入口放到 Prompt 打包器右侧但保持为独立模块，并把 Prompt 打包器调整为缺口式一体模块：头部和下方通栏段落连成一体，但搜索不被包进 Prompt 外框。
- 更新 README 脱敏 mock 截图组，用虚构数据呈现 0.4.5 的 dashboard、历史搜索和素材时间线界面。

## [0.4.0] - 2026-06-18

### English

#### Added

- Added a dedicated full-history search mode backed by a local SQLite FTS index, with ranked thread results, filters, paging, and project history.
- Added Codex rollout-only history discovery so recent CLI or sidebar-missing Codex sessions can appear in search and open through `codex resume`.
- Added Codex artifact extraction from rollout messages, including local file / URL summaries, image previews, artifact timelines, and local file opening.
- Added a refreshed README mock screenshot set generated from synthetic data, covering the upgraded thread list, full-history search results, and Codex artifact timeline.

#### Changed

- Raised the default Codex thread window to 5000 and kept search indexing off the normal dashboard refresh path.
- Reworked the thread and search result rows around denser project, status, token, match, and artifact modules.
- Changed the installed PWA window action from Dock minimization to app hiding, avoiding minimized thumbnail clutter.

#### Fixed

- Preserved stored / sidebar Codex titles unless the title is missing or still the placeholder.
- Kept hidden Codex history threads openable through CLI resume when a browser deep link is not the right path.
- Marked Codex automation threads even when the sidebar title hides the automation prefix.
- Blocked cross-origin browser requests from using local artifact preview / open endpoints.
- Fixed mock screenshot capture to drive Chrome through DevTools with a fresh profile, so README screenshots can capture search and artifact modal states without stale service worker data.

### 中文

#### 新增

- 新增独立全历史搜索模式，使用本地 SQLite FTS 索引，支持相关性排序、筛选、分页和项目历史。
- 新增 Codex rollout-only 历史发现，让近期 CLI 或未出现在侧边栏的 Codex 会话也能被搜索，并通过 `codex resume` 打开。
- 新增 Codex artifact 抽取能力，可从 rollout 消息中展示本地文件 / URL 摘要、图片预览、artifact 时间线和本地文件打开入口。
- 更新 README 脱敏 mock 截图组，使用虚构数据分别展示 0.4 线程列表、全历史搜索结果和线程素材时间线。

#### 调整

- Codex 默认线程窗口提升到 5000，并让搜索索引构建独立于常规 dashboard 刷新路径。
- 重做线程行和搜索结果行的信息结构，压缩展示项目、状态、token、匹配原因和 artifact 模块。
- 已安装 PWA 的窗口操作从最小化改为隐藏，避免在 Dock 右侧留下最小化缩略图。

#### 修复

- 保留 Codex 已存储 / 侧边栏标题，只有标题缺失或仍为占位文案时才回退到 rollout 推断。
- 对隐藏的 Codex 历史线程使用 CLI resume 打开，避免错误依赖浏览器 deep link。
- 即使侧边栏标题隐藏了 automation 前缀，也能识别 Codex 自动化线程。
- 阻止跨站浏览器请求调用本地 artifact 预览 / 打开接口。
- 修复 mock 截图生成脚本，改用临时 Chrome profile 并通过 DevTools 驱动真实界面状态，避免旧 service worker 缓存复用过期 UI 数据，也能稳定捕获搜索和素材弹窗。

## [0.3.1] - 2026-05-14

### English

#### Added

- Added active Codex goal detection from local `thread_goals`, so long-running goal loops stay in the running Host count instead of falling into pending work.
- Added smarter Codex CLI opening on macOS: running CLI threads focus an existing Terminal tab when it can be matched, and avoid spawning duplicate resume sessions when it cannot.
- Added lightweight pending-summary polling so the dashboard can refresh stale pending and Host counts without forcing full scans on every interval.

#### Changed

- Unified in-app pending copy so hard pending work and soft progress use the same visible pending bucket, while preserving the underlying notification source labels.
- Let `/api/pending-summary` reuse a recent dashboard snapshot to reduce repeated local filesystem scans from menu-bar and lightweight polling clients.
- Added ignore coverage for local-only diagnostics and generated research reports to keep public GitHub syncs sanitized.

#### Fixed

- Fixed GPT quota aggregation by preferring the account-level Codex quota (`limit_id: codex`) over newer model-specific `codex_*` limits.
- Suppressed stale soft-progress menu badges when the source thread has already continued or is running again.
- Opened notification cards through the same source-task opener used by explicit open actions, marking the notification handled consistently.
- Refreshed legacy soft-progress notification titles to the shorter release copy.

### 中文

#### 新增

- 新增从本地 `thread_goals` 识别 Codex active goal 的能力，让长期运行的 goal 任务继续计入工作中的 Host，而不是落到待处理里。
- 优化 macOS 上 Codex CLI 任务打开逻辑：能匹配到运行中的 Terminal 标签页时直接聚焦，匹配不到时避免重复新开 resume 终端。
- 新增轻量 pending-summary 轮询，让看板可及时同步待处理和 Host 数量，而不必每次都触发全量扫描。

#### 调整

- 统一站内待处理口径：硬待处理和软性新进展都进入同一个可见待处理池，同时保留底层通知来源标签。
- `/api/pending-summary` 可复用近期 dashboard 快照，减少菜单栏和轻量轮询客户端造成的本地文件扫描。
- 增加本地诊断和生成型调研报告的忽略规则，降低公开同步到 GitHub 时误提交私密材料的风险。

#### 修复

- 修复 GPT quota 汇总选择错误：优先使用账户级 Codex quota（`limit_id: codex`），不再被更新的模型专用 `codex_*` 限额覆盖。
- 当源线程已继续或重新运行时，菜单栏摘要会隐藏过期的软性新进展，避免出现幽灵角标。
- 通知卡片现在走和显式打开按钮相同的源任务打开逻辑，并一致地标记通知已处理。
- 旧版软性新进展通知标题会刷新为更短的发布版文案。

## [0.3.0] - 2026-05-14

### English

#### Added

- Added an Agent review workflow from the thread detail panel, with local Codex, Claude Code, and OpenCode CLI targets.
- Added review input modes for latest Agent signal, privacy-scoped thread summary, and Codex latest-turn content.
- Added review templates for code, product/requirements, technical design, reply quality, and custom review instructions.
- Added review history, selected review details, copyable review results, and copyable debug summaries.
- Added Fix Loop MVP actions to copy a repair prompt, copy and open the source thread, and mark a review as applied or dismissed.
- Added target capability labels and review history filters for pending fixes, applied fixes, and dismissed reviews.

#### Changed

- Updated the review prompts to guide target Agents toward read-only repo inspection only when useful, while avoiding unnecessary token use.
- Restricted review runners so Codex uses a read-only sandbox and Claude Code runs with write tools denied.
- Documented review data flow, local storage, input boundaries, and Fix Loop metadata in the privacy notes and README.
- Kept desktop/system review notifications hidden for the public release while preserving in-app review status visibility.

#### Fixed

- Hid raw runner stderr from review details and replaced it with copyable debug summaries.
- Preserved selected review target options across detail panel rerenders and dashboard refreshes.
- Kept review job polling visible while a detail panel is open.
- Added borders and layout refinements for review input previews and review results.
- Hardened Codex review runner temp output handling by cleaning files on failure and using collision-resistant temp paths.

### 中文

#### 新增

- 新增从线程详情面板发起 Agent 评审的工作流，支持本机 Codex、Claude Code 和 OpenCode CLI 作为评审目标。
- 新增评审输入模式：最新 Agent 输出、隐私受限的线程摘要，以及 Codex 最新回合内容。
- 新增代码审查、产品/需求审查、技术方案审查、回复质量审查和自定义审查要求等评审模板。
- 新增评审历史、选中评审详情、复制评审结果和复制调试摘要能力。
- 新增 Fix Loop MVP 操作，可复制修复 Prompt、复制并打开源线程，以及把评审标记为已处理或不采纳。
- 新增目标 Agent 能力标签，并支持按待修复、已处理、不采纳筛选评审历史。

#### 调整

- 优化评审 Prompt：引导目标 Agent 仅在有必要时只读查看 repo 文件，避免不必要的 token 消耗。
- 收紧评审 runner 边界：Codex 使用只读沙盒，Claude Code 禁用写入工具。
- 在隐私文档和 README 中补充评审数据流、本地存储、输入边界和 Fix Loop 元数据说明。
- 发布版继续隐藏桌面/系统评审通知，只保留站内评审状态可见。

#### 修复

- 评审详情不再直接展示原始 runner stderr，改为提供可复制的调试摘要。
- 修复详情面板重绘和看板刷新后评审目标选项丢失的问题。
- 修复打开评审详情时评审任务轮询不可见的问题。
- 为评审输入预览和评审结果增加边框，并优化详情布局。
- 加固 Codex 评审 runner 临时输出处理：失败路径也会清理临时文件，并使用防撞临时路径。

## [0.2.3] - 2026-05-13

### English

#### Added

- Added running Host task group counts to the dashboard summary, top bar, and privacy-limited pending summary API.
- Added a lightweight top-bar metric cluster for running Host tasks and hard pending work.
- Added an installable Chrome / Edge PWA shell with manifest, icons, a service worker that avoids `/api/*` payloads, and local controls to open or hide the installed dashboard app on macOS without leaving a minimized Dock thumbnail.
- Added grouped quota cards by LLM family, so GPT and Claude quota signals can be shown side by side without adding more summary cards.
- Added Claude Desktop / Cowork quota extraction from the local Claude usage cache, mapped to the same realtime and weekly quota summary shape.
- Added `claude://resume` deep links for Claude Desktop Code sessions when a valid CLI session id is available.

#### Changed

- Refined the macOS menu bar helper so clicking the badge focuses an existing Chrome or Safari dashboard tab before opening a new dashboard URL.
- Refined the macOS menu bar helper badge colors and count alignment to better match the dashboard's quieter release UI.
- Refined the macOS menu bar helper so it first asks the local server to reopen the installed PWA app before falling back to browser tabs.
- Reworked the top-bar refresh controls and metric layout so status text and controls keep stable spacing across desktop and mobile widths.
- Made the top-bar Host-running and pending metrics clickable shortcuts to the running-thread view and notification center.
- Updated the README mock UI screenshot generated from synthetic dashboard data for the latest release layout.
- Renamed soft progress notification states and actions from "read" language to "viewed" language, separating new-progress review from hard pending work.
- Updated notification done and snooze actions to update the visible inbox optimistically before waiting for persistence.
- Deduplicated Claude Desktop Code metadata that points to the same CLI session, keeping the freshest local session record.
- Tightened responsive thread-row actions by keeping copy/resume-command actions in the detail panel.
- Updated the work-in-progress summary copy to distinguish running Agent threads from running Host task groups.

#### Fixed

- Prevented stale unfinished turns with no recent activity from staying in the running state indefinitely.
- Avoided treating ordinary unresolved Claude tool calls as user-facing pending work, while still preserving explicit permission/user-request signals.
- Treated incomplete Claude Cowork metadata as a running signal only while the activity remains fresh.
- Marked soft progress notifications as viewed when their inbox item is opened from the notification center.

### 中文

#### 新增

- 在看板摘要、顶部栏和隐私受限的 pending summary API 中加入工作中的 Host 任务组数量。
- 新增顶部关键指标区，用于快速查看工作中的 Host 任务和硬待处理数量。
- 新增可安装的 Chrome / Edge PWA 壳子，包含 manifest、图标、不缓存 `/api/*` 的 service worker，以及 macOS 上打开或隐藏已安装控制台应用的本地接口，隐藏后不在 Dock 右侧留下最小化缩略图。
- 新增按 LLM 家族分组的 quota 卡片，可在同一组摘要卡里并列展示 GPT、Claude 等 quota 信号。
- 新增从本地 Claude usage cache 读取 Claude Desktop / Cowork 聚合 quota 的能力，并映射到统一的实时 / 本周 quota 结构。
- 新增 Claude Desktop Code 的 `claude://resume` deep link 支持，可在存在有效 CLI session id 时直接恢复桌面会话。

#### 调整

- 优化 macOS 菜单栏辅助工具：点击徽章会优先切回已有的 Chrome 或 Safari 控制台标签页，再按需打开新页面。
- 优化 macOS 菜单栏辅助工具徽章的配色和数字对齐，使其更贴近发布版控制台的克制视觉。
- 优化 macOS 菜单栏辅助工具：会先请求本地服务打开已安装的 PWA 应用，再回退到浏览器标签页。
- 重做顶部刷新控制和关键指标布局，让状态文字与控件在桌面端和移动端都保持稳定间距。
- 顶部 Host 工作中和待处理指标现在可点击，分别跳到运行中线程视图和通知中心。
- 更新 README 中由虚构看板数据生成的脱敏 mock UI 示意图，以匹配最新发布版布局。
- 将软性“新进展”的状态和操作文案从“已读”调整为“已查看”，和硬性的待处理事项进一步区分。
- 通知的已处理和稍后提醒操作改为先乐观更新当前收件箱，再等待持久化结果。
- 对指向同一 CLI session 的 Claude Desktop Code 元数据做去重，保留最新的本地会话记录。
- 收紧响应式线程列表操作区，把复制 / resume 命令入口保留在详情面板里。
- 调整工作中摘要文案，区分运行中的 Agent 线程和运行中的 Host 任务组。

#### 修复

- 避免很久没有新活动、但缺失 final answer 的旧轮次长期停留在“运行中”状态。
- 避免把普通未完成 Claude tool call 误判为需要用户处理，同时保留明确的授权 / 用户请求信号。
- Claude Cowork 未完成元数据只会在活动仍然新鲜时作为运行中信号。
- 从通知中心打开软性“新进展”条目时，会同步标记为已查看。

## [0.2.2] - 2026-05-11

### English

#### Added

- Added Host/Sub Agent relationship metadata to normalized threads, dashboard data, thread rows, and copyable thread summaries.
- Added a privacy-limited `/api/pending-summary` endpoint for aggregate pending/progress counts.
- Added an optional native macOS menu bar helper, runnable with `npm run menubar`, that shows aggregate pending/progress counts and opens the local dashboard.

#### Changed

- Separated soft "new progress" notifications from hard pending work in the dashboard summary, inbox heading, inbox actions, and notification copy.
- Let the desktop thread list and project rail fill the available work-panel height while preserving mobile flow.
- Limited inferred observed-completion reminders to recent Codex UI threads and cleared them when the user continues a thread.

#### Fixed

- Avoided inferring observed-completion reminders for non-Codex providers, exec-spawned Codex threads, and currently running threads.
- Dismissed stale legacy observed-completion reminders even when older records used the previous sticky policy.

### 中文

#### 新增

- 在线程标准化、看板数据、线程列表和可复制线程摘要中加入 Host/Sub Agent 关系信息。
- 新增隐私受限的 `/api/pending-summary` 接口，只返回待处理/新进展的聚合数量。
- 新增可选原生 macOS 菜单栏辅助工具，可通过 `npm run menubar` 显示聚合待查看数量并打开本地控制台。

#### 调整

- 在总览、收件箱标题、操作按钮和文案中区分软性的“新进展”和硬性的“待处理”。
- 让桌面端线程列表和项目栏填满工作面板高度，同时保持移动端自然排布。
- 将推断出的 observed-completion 提醒限制在近期 Codex UI 线程内，并在用户继续发言后自动清理。

#### 修复

- 避免为非 Codex provider、exec 派生的 Codex 线程和运行中的线程误推断 observed-completion 提醒。
- 即使旧记录使用过此前的 sticky 策略，也会清理过期的 legacy observed-completion 提醒。

## [0.2.1] - 2026-05-10

### Fixed

- Fixed notification tests for CI by aligning observed-completion initialization fixtures with the current recent/stale signal policy.

## [0.2.0] - 2026-05-10

### Added

- Added a priority in-app inbox at the top of the dashboard, with preview and expand/collapse behavior for pending work.
- Added a structured single-thread audit detail panel with status summary, pending signals, token usage, local evidence, recent truncated signals, and next actions.
- Added "复制线程摘要" so a thread can be handed off to another Agent with privacy-limited local metadata and truncated signals.
- Added sub-agent thread classification so child/worker threads do not pollute the main dashboard inbox or notification candidates.
- Added project-facing `AGENTS.md` guidance for future maintainers.
- Added a design brief to capture the next direction for upstream thread artifact/detail work.

### Changed

- Changed observed-completion notifications to remain visible until explicitly handled, instead of expiring after a short grace period.
- Disabled desktop/system notification delivery in the public release until a reliable native notifier is available.
- Changed notification settings and notification test endpoints to return `410 Gone` while desktop notifications are disabled.
- Moved the filter controls into the thread panel and tightened the dashboard summary/provider layout.
- Updated the README screenshot to reflect the latest real UI rendered from mock data.

### Fixed

- Reopened recent legacy auto-dismissed observed-completion records so users do not miss fresh work after upgrading.
- Dismissed stale active legacy observed-completion records that predate the new sticky policy.
- Excluded sub-agent permission/review signals from notification candidates and dashboard attention rows.

## [0.1.0] - 2026-05-09

### Added

- Initial public release.
- Local dashboard for Codex, OpenCode, Claude Code CLI, Claude Desktop Code, and Claude Cowork sessions.
- Read-only local data adapters for thread status, token usage, quota samples, project aggregation, and pending work signals.
- Local notification center with persistent in-app state.
- Privacy documentation, security guidance, contributing notes, mock screenshot workflow, and GitHub Actions tests.
