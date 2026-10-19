# ASB on several machines: implementation plan

Status: approved plan, not started. Written 2026-10-19 for an implementing
agent (a worker model). The decisions in section 2 come from an interview with
the user. The user approved the planner decisions in section 3 and the card
design (option D) on 2026-10-19. Do not change any of them without asking the
user.

Read this whole file before you start. Do the phases in order. Each phase has
acceptance criteria. Do not start the next phase until all criteria of the
current phase pass. Commit at the end of each phase. Phase 0 (spikes) can
stop the plan: obey its gates.

---

## 1. Goal

1. **Engine and board.** The ASB engine (sessions reader, attention state,
   phone gateway, machine links, message relay) runs without a window. The
   board (the GTK window) is only a view. When you close the board, the
   engine keeps running and keeps feeding the Android app. A tray icon shows
   that the engine runs. Its menu has **Open ASB** and **Quit ASB**.
2. **Machine group.** Your machines join one ASB group. You pair a new machine
   once, with any member. Every engine reads the sessions of every other
   member. Every board and the phone show all sessions of all machines.
3. **Remote and view-only cards.** A session of another machine shows as a
   card whose bottom line names the machine (a screen glyph and the machine
   name before the age). It does not open on click. A CLI session (Codex
   CLI or Claude Code CLI) also does not open on click, on any machine.
   Remote cards keep Pending attention, Read/Unread, pins, and the drawer.
   Those marks are saved only on the engine where you change them.
4. **Claude Code CLI sessions** show as cards: running sessions, plus sessions
   with activity in the last 7 days.
5. **Messages between machines.** Every agent can message every agent on any
   member machine: Codex and Claude, CLI and desktop app. The app's own route
   is preferred (Claude to Claude through Claude Remote Control). The ASB
   bridge carries the other cases. A message to an offline machine is refused
   at once.
6. **Windows 10 and 11.** The engine and the bridge run on Windows. Windows has
   no board in this plan (a Windows board is a later, separate project).
7. **Install from GitHub with npm** on Linux and Windows.

## 2. User decisions (from the interview, do not change)

| Topic | Decision |
| --- | --- |
| Operating systems | Linux (engine and board) and Windows 10/11 (engine and bridge, no board). macOS is not in this plan. |
| Board on Windows | None. A Windows board is a separate, later project. |
| Board and engine | The engine runs without a board. Closing the board keeps the engine running for the phone. A tray icon shows the engine. |
| Identity ("ASB account") | Machines join a group. Pair a new machine with any one member; members share the member list, so all members trust it. Revoke once. |
| Topology | Mesh: every engine reads every other member. No hub. |
| Remote cards | Shown on every board and on the phone. View-only: no open on click. A screen glyph and the machine name in the card's bottom line show that the session is on another machine. |
| Card design | Option D, "Machine in the meta line", with the Grey tone (approved 2026-10-19). Section 12.3 has the full rules and Appendix D the glyphs. The study page `.impeccable/options/remote-cards-2026-10-19/index.html` is git-ignored and exists only on the Debian PC. |
| Remote card features | Pending attention, PC sounds, Pin, Read/Unread, and the drawer work on remote cards. |
| Where marks apply | Only on the engine where you change them. Nothing is written to the other machine. |
| CLI cards | Every CLI card (local or remote) is view-only. This changes the current behavior for local Codex CLI tasks. |
| Claude CLI cards | Running sessions, plus sessions with transcript activity in the last 7 days. |
| Sounds | Only on a machine where a board is open. |
| Shared session data | Title, status, app and profile, folder path, and times. Never message text. |
| Message pairs | All agents with all agents. |
| Route preference | Use the app's own route when the two sessions use the same app and the route works (Claude to Claude through Remote Control). Use the ASB bridge in the other cases. |
| Claude without Remote Control | Proxy or API-key Claude profiles use the ASB bridge for Claude to Claude across machines. |
| Proxy-row rule | Automatic, with a per-profile override. Details in section 9.6. |
| Offline target | Refuse at once with a clear reason. No queue. |
| Inbound trust | The receiving session's normal policy applies (same as a local message). The sender name carries the machine name. |
| Message lines | The board also animates messages between machines. |
| Phone | The phone can use several engines and uses the one that it can reach. |
| Install | `npm install -g github:Jamir-boop/ASB`, then `asb setup`, on Linux and Windows. Node.js is the only prerequisite. Bun comes from npm too (`npm install -g bun`). |
| Machine names | Set at join time. The hostname is only a suggestion. The group refuses a duplicate name. |
| Delivery | Phased. Each phase is usable alone. |
| Windows tests | The agent may use SSH to homeLP and workLP (key-only SSH from the Debian PC works). The user does visual checks through RDP. |

Out of scope: a Windows or macOS board, the macOS engine, opening a session on
another machine, sending prompts, a message queue for offline machines,
syncing marks between engines, renaming a machine after it joins (leave and
join again), and a version bump or release (ask the user).

## 3. Planner decisions (approved by the user on 2026-10-19, do not change)

| # | Decision | Why |
| --- | --- | --- |
| P1 | The phone pairs once with any engine. The engine adds the phone to the group list, so every member accepts the same phone token. Revoking the phone on one engine revokes it everywhere. | Windows has no board to show a pairing QR code. One pairing is simpler for the user. |
| P2 | The board launcher never hosts the server in its own process. It starts the engine (the systemd user service, or a detached `asb engine run`) and then opens the window as a client. | One code path. The window can close at any time. |
| P3 | Machine links use the existing phone gateway listener (same addresses, same port 4630, same certificate). Routes under `/peer/v1/` need mutual TLS with the certificate of an active member. | No second port, no second firewall rule. The phone routes stay as they are. |
| P4 | The engine's TLS certificate is the machine identity. `machineId` is the first 16 hex characters of its SHA-256 fingerprint. | No second key system. |
| P5 | The member list is a merge-only set: members and phones are added; removal writes a tombstone; a tombstone always wins. Any active member can add or remove members. Engines exchange the list over mutual TLS. No signatures. | Simple, no conflicts, safe for a group of machines that one user owns. |
| P6 | When a machine is not reachable, its cards stay for 10 minutes as Unknown with the note "homeLP is not reachable.", then disappear. | No flicker on short Wi-Fi drops; no stale states shown as current. |
| P7 | `provider` keeps its values (`codex`, `claude-desktop-code`). New row fields: `surface` (`app` or `cli`), `machineId`, `machineName`, `remote`, `globalId`, `remoteCache`. | Filters, pills, and Android keep working. |
| P8 | A Claude CLI session is a transcript whose `entrypoint` is `cli`. SDK, IDE, and other entry points do not show. | The user asked for CLI sessions. |
| P9 | The message relay runs in Bun inside the bridge package (`bridge/src/relay.ts`). The engine starts it, owns TLS and trust, and forwards between machines. | The bridge already has the Claude peer protocol code. |
| P10 | Proxy rows exist only for remote sessions that can receive messages now, at most 32 per Claude config home. Each proxy row uses a tiny placeholder process for its PID (`cat` on Linux, `findstr` on Windows). Spike S1 must prove that Claude accepts this. | Claude requires a live PID per registry row. One Bun process per row would cost about 30 MB each. |
| P11 | Codex senders reach remote sessions through the relay API, not through proxy rows. Proxy rows serve only Claude senders. | The proxy-row rule can then skip remote Claude sessions that Claude reaches natively, without breaking Codex. |
| P12 | Windows autostart: an HKCU `Run` value starts a hidden PowerShell tray script. The tray script starts and watches the engine. No admin rights. | Task Scheduler logon triggers can need admin; a plain Run value opens a console window. |
| P13 | Windows TLS certificate: PowerShell `New-SelfSignedCertificate` (ECDSA P-256), exported as PFX and CER. Linux keeps `openssl`. | openssl is not on the Windows PATH. One path per operating system. |
| P14 | The Linux tray is a small Python D-Bus service (StatusNotifierItem and dbusmenu) built on `Gio`. No GTK 3, no new package. Without a tray host (stock GNOME with no AppIndicator extension), no icon shows and the engine still runs. | GTK 4 has no tray API. AyatanaAppIndicator would add a system package. |
| P15 | The Windows firewall rule is never created by ASB. `asb setup` prints the exact command; the user runs it in an admin PowerShell. | Firewall changes need admin rights and the user's approval. |

## 4. Size and risk

Line counts include tests. They are estimates for planning, not promises.

| Phase | Content | Size | Risk | The user must |
| --- | --- | --- | --- | --- |
| 0 | Spikes S1 to S8 | 1 to 2 days, no product code | Decides the size of phases 6 and 7 | Start Claude and Codex sessions on homeLP (RDP); look at the tray icons |
| 1 | Engine and board split, Linux tray, sounds rule | M: 700 to 1,000 lines | Low to medium | Check the tray icon |
| 2 | View-only cards, Claude CLI cards, machine labels (option D) | L: 1,200 to 1,800 lines | Medium (CLI state accuracy) | Check the cards |
| 3 | Machine group, remote cards, cross-machine message lines (Linux) | XL: 2,500 to 3,500 lines | Medium (security, merge rules) | Join machines |
| 4 | Windows engine (statuses only), npm install, `asb setup` | L to XL: 1,500 to 2,200 lines | High (store paths, autostart, certificate, firewall) | Run the firewall command as admin; RDP checks |
| 5 | Android: several engines, machine labels, notification keys | L: 1,200 to 1,600 lines | Medium | Install and test on the phone |
| 6 | Message relay between machines (Linux) | XL: 2,000 to 3,000 lines | High (unpublished Claude protocol) | Approve live tests that use model tokens |
| 7 | Windows bridge | XL: 2,500 to 4,000 lines | Very high; spikes can block it | RDP tests with real sessions |
| 8 | Documents | M: 300 to 600 lines | Low | Review |

Total: about 13,000 to 19,000 changed lines. Phases 1 to 3 give the full
board result between Linux engines. Phase 4 adds Windows statuses. Phases 6
and 7 add messages. Phase 7 is the most likely place for a hard stop.

## 5. Words used in this plan

| Word | Meaning |
| --- | --- |
| engine | The headless ASB process: `src/switchboard.mjs` server on `127.0.0.1`, phone gateway, machine links, relay supervisor, tray launcher. One per user per machine. |
| board | The GTK window (`scripts/asb-native.py`). A client of the engine. Linux only. |
| tray | The tray icon process. Linux: `scripts/asb-tray.py`. Windows: `scripts/asb-tray.ps1`. |
| group | The set of machines that trust each other. Stored in `group.json`. |
| member | A machine in the group. |
| peer | Another member, seen from this engine. |
| local row | A dashboard row for a session on this machine. |
| remote row | A dashboard row that a peer sent. `remote: true`. |
| remote-cache row | A row from Claude's local cache of claude.ai sessions (exists today). `remoteCache: true`. |
| view-only | A card that does not open: `remote` is true or `surface` is `cli`. |
| surface | `app` (desktop app) or `cli`. |
| registry | Claude's session registry: `<config home>/sessions/<pid>.json`. |
| proxy row | A registry row that the relay writes for a remote session, so a local Claude can list and message it. |
| relay | The Bun process `bridge/dist/relay.js` that owns proxy rows and their sockets. |
| native route | Claude's own messaging: local sockets, or Remote Control through Anthropic servers. |

## 6. Facts about the current code

Read `AGENTS.md`, `SYSTEM_OVERVIEW.md`, `README.md`, `bridge/README.md`,
`bridge/PROTOCOL-COVERAGE.md`, and `bridge/STARTUP.md` first. Line numbers are
from 2026-10-19 and can move; search for the names.

Engine and server:

- `scripts/asb` (POSIX `sh`) finds Node and runs `scripts/asb-desktop.mjs`, or
  the `agent`, `bridge`, `service`, and `--package` scripts.
- `scripts/asb-desktop.mjs` (Linux only): if `findRunningService()` finds the
  service, it attaches. Else it creates the server and the phone gateway in
  its own process, publishes `service.json`, and spawns
  `python3 scripts/asb-native.py <url>` with `ASB_SOURCE_TOKEN`. When the
  window exits, it stops everything.
- `scripts/asb-service.mjs`: `run` hosts the server and gateway with no window
  and writes `$XDG_RUNTIME_DIR/asb/service.json` (`{schema:1,pid,port,sourceToken}`).
  `install` writes the systemd user unit `asb.service`. Line 112 refuses every
  subcommand on non-Linux systems.
- `scripts/asb-instance.mjs`: shared descriptor code. It needs
  `XDG_RUNTIME_DIR`, folder mode `0700`, and file mode `0600`.
- `src/switchboard.mjs`:
  - `buildSwitchboardDashboard` (line 150) makes rows from threads.
    `canOpen` (about line 195) is `Boolean(appDeepLink) && thread.sourceCanOpen !== false`.
  - `resolveSessionMessages` (line 233) maps native session keys to row IDs.
    Keys: `externalId`, `cliSessionId`, `priorCliSessionIds`, and
    `bridge:session_<t>` / `bridge:cse_<t>` aliases.
  - `loadSwitchboardDashboard` (line 282) loads each enabled source.
  - `openSwitchboardThread` (line 346) checks links before an open.
  - `PendingTracker` (line 370): `observe` (435) and `apply` (497). Records
    are keyed by row ID in `pending.json`.
  - `createSwitchboardServer` (line 621): its `loadDashboard` wrapper calls
    `tracker.observe(await load(...))`, then the sound watcher.
- `src/asb-server.mjs` (`createAsbServer`): thread actions accept any
  URL-encoded row ID and find the row with `findThreadForAction` (line 72).
  UI client reports live in `uiClients` (lines 49 and 145 to 147, 45-second
  expiry). `invalidateDashboard(reason, options)` refreshes the snapshot.
- `src/asb-sounds.mjs`: `createSoundWatcher(play)` (line 55) keeps a baseline
  and plays the strongest new event.
- `src/phone-gateway.mjs`: `createPhoneGateway({ localPort, asbVersion,
  settingsPath, tlsDir, now, openssl, hostName, listAddresses })` (line 115).
  Tests inject `listAddresses` and use `127.0.0.x` as LAN addresses. The route
  checks are near lines 320 to 330. Kinds come from interface names in
  `addressKind` (lines 47 to 51). The certificate comes from `openssl req`.
- Codex `threads.source` on this PC: `vscode` for desktop app chats
  (originator `Codex Desktop`), `cli` for Codex CLI, `exec` for `codex exec`.
- Claude registry rows (`<config home>/sessions/<pid>.json`) have the keys
  `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol,
  peerFeatures, kind, entrypoint, hostSessionId, pidDomain,
  messagingSocketPath, name, nameSince, updatedAt, status, statusUpdatedAt`,
  and `bridgeSessionId` when the session is on Remote Control. Desktop
  sessions have `entrypoint: "claude-desktop"`. Bridge receivers have
  `entrypoint: "codex-asb-bridge"`. Never read the `.key` files in that folder
  in the engine.

Board (`scripts/asb-native.py`):

- `session_row` (3472) and `update_session_row` (3604 to 3742) build cards.
  `widget.set_activatable(bool(row.get("canOpen")))` is at 3621. `open_row`
  (4208) also checks `canOpen`.
- The provider icon is in a `Gtk.Overlay` (3629 to 3636). `SourceMarker`
  (1102 to 1125) is the profile dot at the lower left. The upper right is free.
- `tooltip_model` (547 to 617) builds flags at 594 to 596, including
  "No direct link". The accessible label is built at 3857 to 3870.
- The row panel: `row_menu_actions` (92 to 104), `row_panel_controls` (107 to
  118), and `update_row_panel` (4005 to 4051). The **Open in <app>** button
  label and sensitivity are at 4033 and 4034.
- The usage-limit look: `asb-limited` class (3847 to 3850), CSS (2512 to 2518),
  `limited_color` (355). Quiet tone: `quiet_color` (346).
- CSS comes from `set_palette` (2360 to 2530). Icons load from
  `assets/icons` (2007).
- The Comfortable bottom line is a `Gtk.Box` built at 3674 to 3685: the limit
  clock, the state label, and the age label (`asb-age`, `hexpand`, aligned to
  the end, ellipsized). Compact appends `(mark_overlay, title, clock, dot,
  state)` at 3714. `update_row_text` sets the state and age text (3850 to
  3856).
- A view change deletes the view-specific widget attributes listed at 3625.
- The limited CSS covers the parts listed at 2512. The quiet Idle rule is at
  2511 to 2515.
- The board sets no pointer cursor on cards. The Comfortable hover is one
  shared paint (`show_hover`, 856).
- Messages: `new_messages` (244 to 260) and `start_messages` (2726 to 2744)
  use row IDs.
- Tests in `test/asb_native_logic_test.py` use stand-in widgets with exact
  attribute lists (for example near 1823 and 3545). A new `widget.asb_*`
  attribute that `update_session_row` sets on every update breaks them. Create
  new attributes only where the view content is built, as `asb_source_badge`
  is.

Android (`android/app/src/main/java/local/asb/companion/`):

- One paired PC only: flat keys in `data/Store.kt`; `MainActivity.openPairingLink`
  refuses a new link while paired.
- Pairing links: `data/Pairing.kt` `parsePairingUri` accepts exact key sets
  for `v=1` and `v=2`. An extra key makes the link fail.
- Network: `net/AsbApi.kt` `request()` tries endpoints of one PC; GET can fail
  over, POST goes to one endpoint. `net/PinnedClient.kt` pins one fingerprint.
  `hello()` requires `api == 1`.
- `data/Models.kt` uses `ignoreUnknownKeys = true`, so new row fields are safe.
  Open depends only on `canOpen`.
- `ui/SessionsScreen.kt`: `SessionCard` (809 to 926), `ProviderMark` (928 to
  950, profile dot at the lower left), `SessionInspector` (1108 to 1261).
- Notifications: `notify/Events.kt` keys the baseline by `row.id`;
  `notify/Notifier.kt` tags are `"$id:$kind"`.

Bridge (`bridge/src/`):

- One receiver process per Codex task. `register()` (`claude.ts` 168 to 200)
  writes `sessions/<receiver pid>.json` with `entrypoint: "codex-asb-bridge"`.
- `peers()` (`claude.ts` 78 to 94) requires: file name equal to `<pid>.json`,
  `process.kill(pid, 0)` succeeds, socket owned by the user with no group or
  other bits, in a `0700` folder.
- `sendFrames()` (`claude.ts` 268 to 312): budget, `procStart` check, socket
  check, optional auth line from `<pid>.<sha256(socket path)>.key`, then the
  frames. `userFrame()` (254 to 260) builds the envelope. `senderMode()` and
  `hopChain()` (243 to 251) parse it.
- `Bridge.receive()` (`bridge.ts` 301 to 347) drops a frame whose `from` is
  not a registered local row address.
- Guards: `BurstBudget` and `PeerGuard` in `guard.ts`.
- Nothing in the bridge works on Windows today: uid and mode checks,
  `/proc` and `ps` for `processStart`, Unix socket paths, `ws+unix://` to the
  Codex app-server, and `$CODEX_HOME/ipc/ipc.sock` for desktop IPC.

Windows engine blockers (from a code audit, not tested on Windows):

- `asb-service.mjs:112` refuses non-Linux; `asb-instance.mjs` needs
  `XDG_RUNTIME_DIR` and POSIX modes; a stale `service.json` with a reused PID
  blocks a start; `scripts/asb` is POSIX `sh`.
- No `openssl` on the Windows PATH.
- `addressKind` misses the Windows adapter names `Tailscale` and
  `ZeroTier One [<network id>]`.
- Config and state paths fall back to `%USERPROFILE%\.config` and
  `%USERPROFILE%\.local\state`.
- Spawns lack `windowsHide: true` (`session-opener.mjs:21`, `claude-data.mjs:1156`).
- Many tests assume POSIX (modes, `/bin/sh`, symlinks, `systemctl` fakes).

## 7. Working rules

- Use the existing patterns in `src/*`, `scripts/*`, `public/*`, `test/*`,
  `bridge/*`, and `android/*`. Write code that reads like the code around it.
- Add no npm dependency to the root package (it has none). The bridge keeps
  only its current dependencies. Python uses only the standard library and
  PyGObject. Android adds no library.
- Every new pure function gets a unit test. Every phase keeps the existing
  tests green.
- Keep Linux behavior the same except where this plan says otherwise.
- Security invariants (never break these):
  - The main server binds only `127.0.0.1`.
  - The gateway never binds `0.0.0.0`, loopback, or public addresses in
    production, and refuses public callers.
  - `/api/sources`, `/api/palette`, `/api/phone*`, `/api/agent/*`,
    `/api/group*`, `/api/relay/*`, `/api/engine/*`, and `/api/service` are
    never reachable through the gateway.
  - `/peer/v1/*` routes (except `join`) need the client certificate of an
    active member.
  - Never log tokens, codes, message text, or titles of other machines.
  - Never send message text in a dashboard or a session list.
  - Never read credentials, `.key` files (engine), or account fields.
- Commit at the end of each phase with Conventional Commits (`feat:`,
  `fix:`, `docs:`, `test:`). Add no AI attribution or co-author lines.
- Checks (run the ones that the phase touches):

```bash
npm test
python3 test/asb_native_logic_test.py
npm run test:native
cd bridge && bun run check && bun test && bun run build
cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug assembleRelease
```

- After bridge source changes, run `bun run build` and commit `bridge/dist/`.
  Change the version in `bridge/package.json` and
  `bridge/.codex-plugin/plugin.json` together.
- SSH rules for homeLP and workLP. Take their users and addresses from the
  machine inventory (`~/Documents/agent-policy/context/machines.md`). Never
  copy addresses or user names into the repository:
  - You may copy ASB, install it under the user profile, run it, and run
    tests.
  - Ask the user first before you install system software (Node.js, Bun,
    Git), change system settings (firewall, execution policy), or start
    model work (live message tests use the user's model quota).
  - Over SSH, `winget` runs in session 0 and its default source fails with
    `Cancelled`. Ask the user to install software through RDP instead.
  - Copy no private data off the machines. Print names, sizes, and times, not
    file contents. Remove your test files when you finish.
- Stop and report to the user when:
  - a spike gate in phase 0 fails;
  - a decision in section 2 or 3 does not work as written;
  - a test can pass only if you change a decision;
  - you need admin rights, a firewall change, or model work.

## 8. Architecture

```text
 Debian PC (Linux)                                  homeLP (Windows)
 ┌───────────────────────────────┐                  ┌───────────────────────────────┐
 │ board (GTK) ──┐  tray (Gio) ─┐│                  │                 tray (PS1) ─┐ │
 │               ▼              ▼│                  │                             ▼ │
 │   engine: switchboard server  │◄── mTLS /peer ──►│   engine: switchboard server  │
 │   127.0.0.1:4629              │   (gateway 4630) │   127.0.0.1:4629              │
 │   gateway (phones + peers)    │                  │   gateway (phones + peers)    │
 │   peer poller, group store    │                  │   peer poller, group store    │
 │   relay (Bun) ── proxy rows   │                  │   relay (Bun) ── proxy rows   │
 └──────▲────────────────▲───────┘                  └──────▲────────────────────────┘
        │                │                                 │
     Android        Claude / Codex                     Claude / Codex
     (any engine)   sessions, bridge receivers         sessions, bridge receivers
```

Data flow for cards:

1. Each engine loads its local sessions as today (plus Claude CLI sessions).
2. Each engine serves its local rows (whitelisted fields) at
   `GET /peer/v1/sessions` to members.
3. Each engine polls every active member, caches their rows, and merges them
   into its dashboard before `PendingTracker.observe`. So attention, Read,
   pins, the drawer, sounds, and the phone work on remote rows with no new
   attention logic.
4. Boards and the phone read the merged dashboard from their own engine.

Data flow for messages (phase 6):

1. A local Claude lists a proxy row (written by the relay) and sends to its
   socket. A local Codex task calls the relay API through the bridge.
2. The relay asks its engine to deliver. The engine posts
   `/peer/v1/deliver` to the target machine over mutual TLS.
3. The target engine hands the frame to its relay. The relay writes a
   reverse proxy row for the sender (so the target can reply), rebuilds the
   envelope, and writes the frame to the target session's own socket.
4. Replies and receipts go back the same way.

## 9. Data contracts

### 9.1 Row fields (all rows)

New fields that `buildSwitchboardDashboard` and the merge add:

| Field | Type | Value |
| --- | --- | --- |
| `surface` | `"app"` or `"cli"` | Codex: `cli` when `source` is `cli` or `exec`, else `app`. Claude desktop and remote-cache rows: `app`. Claude CLI rows: `cli`. |
| `machineId` | 16 lowercase hex | The machine that runs the session. |
| `machineName` | string | That machine's group name. |
| `remote` | boolean | `true` for rows from peers. |
| `globalId` | string | `<machineId>:<row id on its own engine>`. The same on every engine. |
| `remoteCache` | boolean | `true` for rows from Claude's claude.ai cache. |

Changed fields:

| Field | Rule |
| --- | --- |
| `providerLabel` | `Codex`, `Codex CLI`, `Claude Desktop Code`, or `Claude Code CLI`. |
| `canOpen` | Also `false` when `surface` is `cli` or `remote` is true. |
| `appDeepLink` | `""` when `canOpen` is false because of `cli` or `remote`. |
| `id` (remote rows) | `m:<machineId>:<row id on its own engine>`. |

Before phase 3, `machineId`, `machineName`, and `globalId` use this engine's
identity, and `remote` is always false.

### 9.2 Peer export (`GET /peer/v1/sessions`)

```json
{
  "api": 1,
  "machineId": "a1b2c3d4e5f60718",
  "name": "debian",
  "generatedAtMs": 1792396000000,
  "refreshIntervalMs": 2000,
  "rows": [ { "id": "...", "...": "whitelisted fields only" } ],
  "keys": { "<row id>": ["<native key>", "..."] },
  "incoming": [ { "to": "<row id>", "from": "<native key>", "atMs": 1792395990000 } ]
}
```

Row whitelist (copy only these fields): `id, externalId, provider,
providerLabel, surface, title, cwd, projectName, archived, updatedAtMs,
subagentCount, state, reason, workingSinceMs, nativeUnread, readStatus,
questionPending, actionRequired, lastOutcome, failedAtMs, completionAtMs,
limitResetsAtMs, sourceId, sourceLabel, sourceColor, sourceShowMarker,
sourceCount`.

Exclude remote rows and remote-cache rows. The reply has an `ETag`; a request
with the same `If-None-Match` gets `304`. Gzip when the caller accepts it
(reuse `acceptsGzip`).

### 9.3 Group file

`<config dir>/asb/group.json`, mode `0600` on Linux (Windows: see 14.3):

```json
{
  "schema": 1,
  "groupId": "16 lowercase hex",
  "self": { "machineId": "16 hex", "name": "debian" },
  "members": [ { "machineId": "16 hex", "name": "homeLP", "certFingerprint": "64 hex",
                 "addresses": [ { "kind": "lan", "address": "192.168.1.20" } ], "port": 4630,
                 "addedBy": "16 hex", "addedAtMs": 0 } ],
  "removed": [ { "machineId": "16 hex", "certFingerprint": "64 hex", "removedBy": "16 hex", "removedAtMs": 0 } ],
  "phones": [ { "deviceId": "12 hex", "name": "Phone", "tokenHash": "64 hex", "addedBy": "16 hex", "addedAtMs": 0 } ],
  "removedPhones": [ { "deviceId": "12 hex", "removedBy": "16 hex", "removedAtMs": 0 } ]
}
```

Rules:

- `members` includes this machine.
- Merge: union of `members` by `machineId`, union of `phones` by `deviceId`,
  union of both tombstone lists. When two entries have one key, keep the one
  with the smaller `addedAtMs`, then the smaller `addedBy`. A tombstone always
  wins over an entry with the same key.
- Active members: `members` minus `removed` (match `machineId` and
  `certFingerprint`). Active phones: `phones` minus `removedPhones`.
- Limits: 32 members, 64 phones, 256 entries in each tombstone list. Drop the
  oldest tombstones first when a list is full. Refuse a join when the member
  limit is reached.
- Names: `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`. Unique among active members,
  case-insensitive. `suggestName(hostname, taken)` removes other characters,
  cuts to 32, and adds `-2`, `-3`, and so on when the name is taken.
- Ignore a peer whose `groupId` differs.

### 9.4 Peer routes (gateway, mutual TLS)

The gateway listener gets `requestCert: true, rejectUnauthorized: false`. The
member check: SHA-256 of `request.socket.getPeerCertificate(true).raw`, as
lowercase hex, equals the `certFingerprint` of an active member. A failed
check gives `401` and counts toward the existing auth throttle.

| Route | Caller | Body | Reply |
| --- | --- | --- | --- |
| `POST /peer/v1/join` | Any client certificate | `{code, name, addresses, port}` | `200 {groupId, group}` (the merged group without `self`), `401` bad code, `409 {error, suggestion}` name taken or machine removed, `429` throttle |
| `GET /peer/v1/hello` | Member | none | `{api:1, machineId, name, groupId, asbVersion, addresses, port}` |
| `GET /peer/v1/group` | Member | none | Group file without `self` |
| `GET /peer/v1/sessions` | Member | none | Section 9.2 |
| `POST /peer/v1/leave` | Member | `{}` | `{left:true}`; adds a tombstone for the caller |
| `GET /peer/v1/peers` (phase 6) | Member | none | Section 9.7 |
| `POST /peer/v1/deliver` (phase 6) | Member | Section 9.7 | Section 9.7 |

All bodies are limited to 64 KiB, except `deliver` (2 MiB). Bodies must have
exactly the listed keys (same strict style as the phone routes).

### 9.5 Loopback routes (engine, source token required)

Same checks as the current phone routes: header `X-ASB-Source-Token`, local
`Host`, and for POST the local `Origin`. Replies have `Cache-Control: no-store`.

| Route | Body | Reply |
| --- | --- | --- |
| `POST /api/engine/stop` (phase 1) | `{}` | `{stopping:true}`, then the engine exits with code 0 |
| `GET /api/group` (phase 3) | none | `{groupId, self, networkEnabled, members:[{machineId,name,online,lastOkAtMs,addresses,isSelf}], phones:[{deviceId,name}]}` |
| `POST /api/group/invite` (phase 3) | `{}` | `{link, fingerprint, expiresAtMs}`; creates the group when there is none |
| `POST /api/group/join` (phase 3) | `{link, name}` | `{joined:true, groupId}` or `409 {error, suggestion}` |
| `POST /api/group/remove` (phase 3) | `{machineId}` | Group status |
| `POST /api/group/leave` (phase 3) | `{}` | `{left:true}` |
| `GET /api/relay/homes` (phase 6) | none | Local Claude config homes for proxy rows |
| `GET /api/relay/remote-peers` (phase 6) | none | Section 9.7 list from all members, with `machineId`, `machineName`, `online` |
| `POST /api/relay/send` (phase 6) | Section 9.7 | Section 9.7 |

Join link: `asb://join?v=1&g=<groupId>&a=<kind:address,...>&p=<port>&f=<fingerprint>&c=<code>&n=<inviter name>`,
same encoding as the phone link. The code: 20 random bytes, base64url, valid
10 minutes, one use, void after 8 wrong codes (reuse the phone pairing helpers).

### 9.6 Proxy-row rule (phase 6)

For each local Claude config home `H` and each remote messageable session `R`:

1. If `R.agent` is `codex`: create a proxy row.
2. If `R.agent` is `claude`:
   - The source override for `H` is `bridge`: create a proxy row.
   - The override is `native`: no proxy row.
   - The override is `auto` (default): no proxy row when `R.remoteControl` is
     true AND `H` has at least one live local session with `bridgeSessionId`
     (evidence that `H` can use Remote Control). Else create a proxy row.
3. At most 32 proxy rows per `H`, newest `R` first.

The override is a new optional field `remoteClaude` (`auto`, `bridge`,
`native`) on Claude sources in `sources.json` (schema stays 1; an absent field
means `auto`). Profiles shows it as **Remote Claude sessions**: Automatic,
Through ASB, Claude Remote Control only.

Limit to document: Remote Control works per session. A local session in `H`
that is not on Remote Control does not see `R` when the rule skips `R`.

### 9.7 Relay contracts (phase 6)

`GET /peer/v1/peers` reply (no socket paths, no PIDs):

```json
{ "peers": [ { "sessionId": "uuid", "name": "codex-fix-tests-ab", "agent": "codex",
               "status": "idle", "remoteControl": false } ] }
```

Include only live registry rows from this machine's Claude config homes,
with a valid `messagingSocketPath`, and `entrypoint` not `asb-relay`.

`POST /peer/v1/deliver` and `POST /api/relay/send` body:

```json
{ "targetSessionId": "uuid",
  "sender": { "machineId": "16 hex", "sessionId": "uuid", "name": "string", "mode": "prompting", "agent": "claude" },
  "message": { "msgId": "uuid", "text": "plain text", "hopChain": ["24 hex"] } }
```

or, for a receipt, `"control": { ...peer_message_status frame... }` in place
of `message`. `POST /api/relay/send` adds `"machineId"` (the target machine).
`sender.machineId` on `/peer/v1/deliver` must equal the caller's member ID.

Reply: `{ "ok": true, "outcome": "socket-written" }` or
`{ "ok": false, "reason": "machine-offline" | "target-unavailable" | "too-large" | "rate-limited" | "refused" }`.

## 10. Phase 0: spikes

Do not change product code. Use temporary folders. Write the results to
`docs/plans/multi-machine-spikes.md` (what you ran, what you saw, the gate
result). Ask the user before each spike that needs them.

| Spike | Where | Question | Gate |
| --- | --- | --- | --- |
| S1 | Debian PC | Does Claude Code 2.1.303 list and deliver to a proxy row whose PID is a placeholder process (`/usr/bin/cat` with a stdin pipe) and whose socket another process owns? Does it need `procStart`? | Fail: phase 6 uses one small Bun process per proxy row; report the memory per process and ask the user. |
| S2 | homeLP (SSH, read-only) | Where are the Codex and Claude Desktop stores (`%USERPROFILE%\.codex`, `%APPDATA%\Claude`, MSIX paths under `%LOCALAPPDATA%\Packages`), `%USERPROFILE%\.claude\projects`, and `sessions`? Node version and `node:sqlite`. Does Claude's `Cache\Cache_Data` use files named `^[a-f0-9]{16}_0$`? | Fail on a store path: phase 4 adds that path. Fail on cache format: disable remote-cache rows on Windows with a source warning. |
| S3 | homeLP (RDP: user starts `claude` and Claude Desktop) | Registry row keys on Windows, `messagingSocketPath` form (named pipe), `procStart` format (compare with the process creation time), `pidDomain`, key file names and fields. | Unknown format: phase 7 stops. |
| S4 | homeLP (RDP: user opens Codex desktop and a Codex CLI task) | How do the Codex app-server daemon and desktop IPC listen on Windows? List pipes with `[System.IO.Directory]::GetFiles('\\.\pipe\')`; look in `%USERPROFILE%\.codex\app-server-control`; read `codex app-server --help`. | No reachable transport from Bun: phase 7 delivers only to Claude; report. |
| S5 | homeLP (SSH) | Bun on Windows: named pipe server and client with `node:net`, `process.kill(pid, 0)`, detached spawn with `ipc`, `findstr` as a placeholder that exits on stdin EOF. | Fail: phase 7 stops. |
| S6 | homeLP (SSH) | `New-SelfSignedCertificate` ECDSA P-256, export PFX and CER, Node `https` server with `pfx` and TLS 1.3, Node client sees the CER fingerprint. | Fail: try `openssl.exe` from Git for Windows; else stop phase 4 and report. |
| S7 | homeLP (RDP) | A PowerShell `NotifyIcon` script shows an icon and a menu; an HKCU `Run` value starts it hidden at logon; it starts `node.exe` with no console window. | Fail: report; Windows has no tray, autostart through the Run value only. |
| S8 | Debian PC | A minimal Gio StatusNotifierItem (Appendix A) shows an icon in the top bar and gets menu clicks. | Fail: phase 1 ships without the Linux tray; report. |

S1 detail: write a temporary Bun script in `/tmp/asb-spike-s1/` that starts
`/usr/bin/cat` with `stdio: ['pipe', 'ignore', 'ignore']`, reads its start
time from `/proc/<pid>/stat` (field 22, as `processStart` in
`bridge/src/claude.ts` does), listens on a Unix socket in a new `0700` folder,
and writes `<config home>/sessions/<cat pid>.json` with the same fields as
`register()` (random `sessionId`, `name: "asb-spike-proxy"`,
`entrypoint: "asb-relay"`, `peerFeatures: []`). Ask the user which Claude
profile to use. In a Claude session of that profile: `/list-agents` must show
the row; a request to message it must deliver one `user` frame to your
socket. Repeat without `procStart`. Then kill `cat` and check that the row
leaves the list. Remove the row, the socket, and the folder.

## 11. Phase 1: engine and board split, tray (Linux)

### 11.1 Engine entry

1. Create `scripts/asb-engine.mjs`. Move the body of `runService` from
   `scripts/asb-service.mjs` into an exported `runEngine({ env })`. Keep
   `asb service run` as an alias that calls `runEngine`.
2. Export `main(argv)` from every script that `scripts/asb.mjs` will call in
   phase 4 (`asb-engine.mjs`, `asb-service.mjs`, `asb-agent.mjs`,
   `asb-bridge.mjs`). Keep their "run when main" blocks.
3. Add `POST /api/engine/stop` to `src/asb-server.mjs` (section 9.5). The
   engine passes an `onStop` callback through `createSwitchboardServer`
   options. The callback answers first, then stops the gateway, the tray, the
   relay (phase 6), and the server, removes `service.json`, and exits with
   code 0. Exit code 0 keeps systemd (`Restart=on-failure`) from restarting it.
4. Add `asb engine run|start|stop|status`:
   - `start`: if `systemctl --user is-enabled asb.service` prints `enabled`,
     run `systemctl --user start asb.service`. Else spawn
     `process.execPath scripts/asb-engine.mjs run` with `detached: true`,
     stdout and stderr to `$XDG_STATE_HOME/asb/engine.log` (truncate at start),
     then `unref()`. Wait until `findRunningService()` answers (poll every
     200 ms, at most 10 s).
   - `stop`: `POST /api/engine/stop` through `service.json`.
   - `status`: running or not, PID, port, mode.

### 11.2 Board launcher

Change `scripts/asb-desktop.mjs`:

1. Remove the in-process server and gateway.
2. `findRunningService()`. If none, run the `engine start` logic (11.1 step 4).
   If the engine does not answer in 10 s, print
   `ASB cannot start its engine. See <log path>.` and exit 1.
3. Spawn the window in attach mode with the service URL and token (as the
   attach branch does today).
4. When the window exits, the launcher exits. The engine keeps running.

Update `test/asb-desktop.test.mjs` for the new flow (no server in the
launcher, engine start, attach, exit without stopping the engine).

### 11.3 Quit ASB on the board

Add a **Quit ASB** button to Preferences > Sessions, below Persistent unread,
with the help text **Stops ASB, phone access, and machine links. Closing the
window keeps them running.** It sends `POST /api/engine/stop` with the token,
then closes the window. The window's close button only closes the window.

### 11.4 Linux tray

Create `scripts/asb-tray.py` (Appendix A). Rules:

- The engine spawns it on Linux when `DBUS_SESSION_BUS_ADDRESS` is set and
  `ASB_TRAY` is not `0`. Environment: `ASB_ENGINE_PID`, `ASB_ENGINE_URL`,
  `ASB_SOURCE_TOKEN`, `ASB_LAUNCHER` (the absolute `asb` launcher:
  `ASB_INSTALLED_LAUNCHER`, else `scripts/asb` of this checkout).
- When no `org.kde.StatusNotifierWatcher` owner exists on the session bus,
  the tray exits with code 0 and prints nothing.
- Icon: `IconName` `local.asb.AgentSwitchBoard` and `IconThemePath` set to the
  repository `assets/icons` folder.
- Tooltip title `ASB`; text `Running. Phone access on.` or `Running.` (read
  `GET /api/phone` with the token every 30 s).
- Menu: **Open ASB** (spawn `ASB_LAUNCHER` detached), a separator, **Quit ASB**
  (`POST /api/engine/stop`). A left click (`Activate`) opens ASB.
- The tray checks `os.kill(engine_pid, 0)` every 5 s and exits when the
  engine is gone. The engine sends SIGTERM to the tray when it stops. A tray
  error never stops the engine; the engine prints one line.
- Put the menu layout and tooltip text in pure functions. Test them in a new
  `test/asb_tray_test.py` without D-Bus.

### 11.5 Sounds only with a board

1. In `createAsbServer`, add `server.boardOpen()`: remove expired UI clients,
   return `uiClients.size > 0`.
2. Change `createSoundWatcher(play, canPlay = () => true)`: always update the
   baseline; call `play(kind)` only when `kind && canPlay()`.
3. In `createSwitchboardServer`, pass `() => server.boardOpen()` (bind it
   late, because the watcher exists before the server).
4. Tests in `test/asb-sounds.test.mjs`: no sound without a board; a sound
   with a board; no replay of old events when a board opens later.

### 11.6 Documents

Update README ("Run without the window"), ASB.md ("Start and stop", "User
service"), and SYSTEM_OVERVIEW ("Runtime path", "Sounds").

### Phase 1 acceptance

- All checks in section 7 that cover the changed files pass.
- On the Debian PC: `scripts/asb` opens the window; closing the window leaves
  `scripts/asb agent status` working and the phone refreshing; the tray icon
  shows (the user confirms); **Open ASB** opens the window; **Quit ASB**
  stops the engine and the tray; `systemctl --user is-active asb.service`
  then prints `inactive`.
- With the window closed, a Done event plays no sound. With the window open,
  it plays.

## 12. Phase 2: view-only cards and Claude CLI cards

The user approved option D ("Machine in the meta line") with the Grey tone.
Section 12.3 describes it in full; you do not need the study page.

### 12.1 Row fields

In `buildSwitchboardDashboard` add `surface`, `remoteCache`, the identity
fields, and the label and `canOpen` rules from section 9.1.

- Check that normalized Codex threads keep the raw `threads.source` string
  (see `src/insights.mjs` near line 130). If not, add `source` there.
- `openSwitchboardThread` must also refuse a row with `surface === "cli"` or
  `remote === true`: `This session cannot open from ASB.`
- Before phase 3 the identity is: `machineId` from the gateway certificate
  fingerprint (create the certificate at engine start when it is missing, with
  the existing code path), `machineName` from the sanitized hostname. When the
  certificate cannot be made (no `openssl`), `machineId` is `""`, and the
  group commands in phase 3 refuse with the existing certificate error.

### 12.2 Claude CLI reader

Create `src/claude-cli-data.mjs` with
`loadClaudeCliThreads({ projectsDir, desktopSessionIds, nowMs, maxCount = 500, cacheScope })`.

- The config home is `path.dirname(projectsDir)`. Live rows come from
  `<config home>/sessions/`: names `^[1-9][0-9]*\.json$`, regular files of at
  most 256 KiB, JSON objects with `entrypoint === "cli"`, and
  `process.kill(pid, 0)` succeeds (`EPERM` counts as alive). Use only
  `sessionId`, `cwd`, `name`, `startedAt`, `status`, `bridgeSessionId`. Never
  open `.key` files.
- Reuse first: on 2026-10-19 other sessions added `src/claude-registry.mjs`
  (`readLiveClaudeRegistry(roots)`, `processStart(pid)`); it was not
  committed when this plan was written. If it exists when you start, read
  live rows with it, and add only what this step needs (for example
  `bridgeSessionId`). Do not write a second registry reader.
- Transcripts: reuse the project index and signal reading of
  `src/claude-data.mjs` (`indexClaudeProjectFiles` at 1031, `readClaudeRootSignals`
  at 943, `readClaudeSignalFile` at 851, `claudeSubagentParentSessionId` at
  1057). Export what you need; do not copy them.
- Include a transcript when all are true: its file time is within 7 days of
  `nowMs`, or its session is live; its signals have `entrypoint === "cli"`;
  it is not a subagent file; its session ID is not in `desktopSessionIds`
  (every `cliSessionId` and `priorCliSessionIds` of the desktop threads of
  the same source).
- Thread shape: the same as desktop threads from `baseClaudeThread` (694),
  with `id: "cli:" + sessionId`, `externalId: sessionId`,
  `provider: "claude-desktop-code"`, `surface: "cli"`, `source: "claude-cli"`.
- Title order: the live registry `name`; a title record in the transcript
  (check which record types exist, for example `custom-title` or `summary`);
  else `Claude Code session <first 8 characters of the ID>`. Never use prompt
  text.
- State: the same transcript lifecycle rules as desktop threads
  (`switchboardStatus`). Do not map registry `status` values.
- `incomingMessages`: from the signals, as for desktop threads.
- Wire it into `loadSwitchboardDashboard` for each enabled
  `claude-desktop-code` source. Scope IDs for non-built-in sources as the
  other threads are scoped.
- Add `<config home>/sessions` to the Claude watch paths in
  `switchboardWatchPaths`.
- Tests: new `test/claude-cli-data.test.mjs` with fixture folders (live row
  with a fake PID that is alive: use `process.pid`; old transcript; desktop
  session ID excluded; subagent excluded; `entrypoint` not `cli` excluded;
  title order; 500 limit).

### 12.3 Board cards (option D, Grey tone)

Option D in short:

- The bottom line of a view-only card keeps the state at the left. At the
  right, before the age, it says where the session runs:
  - a remote row: the screen glyph and the machine name, for example
    `homeLP · 18m ago`;
  - a local CLI row: the terminal glyph and `CLI`, for example `CLI · 12m ago`;
  - a remote CLI row: the screen glyph and the machine name (the tooltip says
    that it is a CLI session).
- Compact has no glyph: ` · homeLP` or ` · CLI` follows the state, for
  example `Idle · homeLP`.
- A usage-limited remote row keeps the limit look and the label:
  `workLP · 4h 32m` in Comfortable, `Resets 4h32m · workLP` in Compact.
- Grey tone: a view-only row with no attention uses the quiet colors. The
  state keeps its color while the row is Working or Waiting. Unread dots, `?`,
  and the limit look keep full strength.
- Hover and pointer do not change (the board sets no pointer cursor on
  cards, and its hover is already a faint fill).

Steps:

1. Icons: add `assets/icons/asb-machine-symbolic.svg` and
   `assets/icons/asb-terminal-symbolic.svg` with the exact content in
   Appendix D. They are fill-based on purpose: GTK recolors symbolic icons
   through their fill, so a stroke-only icon would render as a solid block.
   Add one line about them to `assets/icons/README.md` (drawn for ASB, no
   outside source).
2. Pure functions near `row_meta` (525), with tests:
   - `is_view_only(row)`: true when `row.get("remote")` or
     `row.get("surface") == "cli"`.
   - `row_where(row)`: `("asb-machine-symbolic", <machineName or "another machine">)`
     for remote rows, `("asb-terminal-symbolic", "CLI")` for local CLI rows,
     else `(None, "")`.
   - `view_only_tone(row)`: `""` when the row is not view-only, or has
     `unread`, `questionAttention`, or `pending`, or `limitResetsAtMs > 0`;
     `"quiet"` when the state is `working` or `waiting`; else `"rest"`.
3. Comfortable bottom line (built at 3674 to 3685): in place of
   `metadata.append(age)`, make `right = Gtk.Box(spacing=4, hexpand=True,
   halign=Gtk.Align.END)` and append to it, in this order:
   - `where_icon = Gtk.Image(pixel_size=11, visible=False)` with the classes
     `asb-where-icon` and `dim-label`;
   - `where = label("", "caption")` with the classes `asb-where` and
     `dim-label`, `set_ellipsize(Pango.EllipsizeMode.END)`,
     `set_max_width_chars(12)`, not visible;
   - the age label, without its `set_hexpand(True)` (keep the end alignment
     and the ellipsize).

   Then `metadata.append(right)`. Store `widget.asb_where_icon` and
   `widget.asb_where_label`. The machine name ellipsizes first; the state
   label never ellipsizes.
4. Compact row (3714): after `state`, append `where = label("", "caption")`
   with the classes `asb-where` and `dim-label`, ellipsize at the end,
   `set_max_width_chars(10)`, not visible. Store it as
   `widget.asb_where_label` and set `widget.asb_where_icon = None`.
5. Add `"asb_where_icon"` and `"asb_where_label"` to the list that a view
   change deletes (3625).
6. In `update_session_row`, after the provider icon is set (3717), apply
   `row_where(row)`: Comfortable shows the icon and the text `<name> ·`;
   Compact shows the text `· <name>`. Hide both when the name is empty. Add
   the class `asb-view-only-quiet` when `view_only_tone(row)` is `"quiet"` or
   `"rest"`, and the class `asb-view-only-rest` when it is `"rest"`; remove
   them otherwise.
7. CSS in `set_palette` (2500 to 2520):
   - Add `" .asb-where"` and `" .asb-where-icon"` to `parts`, so the limited
     look also dims them.
   - Use the quiet colors (`quiet_title`, `quiet_caption`) with the selector
     `{base} .asb-view-only-quiet:not(.asb-limited):not(.asb-drawer-lit):not(:hover):not(:focus-within)`:
     `.asb-title` gets `quiet_title`; `.asb-folder`, `.asb-age`, `.asb-where`,
     and `.asb-where-icon` get `quiet_caption`.
   - With the selector `{base} .asb-view-only-rest:not(.asb-limited):not(.asb-drawer-lit):not(:hover):not(:focus-within)`,
     `.asb-state` gets `quiet_caption`.
   - These rules apply in both views. On hover or focus within, the normal
     colors come back, as with the quiet Idle rule.
8. Tooltip (`tooltip_model`, 547 to 617): for remote rows replace "No direct
   link" with `On <machineName>` and add the note `Open it on <machineName>.`;
   for local CLI rows use the flag `CLI session` and the note
   `Runs in a terminal. ASB does not open CLI sessions.` A remote CLI row has
   both flags: `On <machineName> · CLI session`.
9. Accessible label (3857 to 3870): add `On <machineName>. View only.` or
   `CLI session. View only.`
10. Row panel button (4033 and 4034): the label `On <machineName>` or
    `Runs in a terminal`, insensitive.
11. `row_menu_actions`: no Discard result or Keep result for remote rows.
12. Implement the remote branch now with fixture rows (`remote`,
    `machineName`), so phase 3 needs no board work.
13. Tests:
    - new tests for `is_view_only`, `row_where` (remote, local CLI, remote
      CLI, desktop app, empty machine name), and `view_only_tone` (no
      attention, unread, question, pending, limited, Working, Waiting);
    - extend the tooltip test (2165), the panel test (1908), the accessible
      text test (2046), and the usage-limit test (962) with a limited remote
      row;
    - the logic tests use stand-in widgets with exact attribute lists (search
      the tests for `asb_age_label`). Add `asb_where_icon` and
      `asb_where_label` to those stand-ins.

### 12.4 Web view

In `public/switchboard.js`, use the option D text on view-only rows: the
machine name (or `CLI`) and ` · ` before the age. Do not send an open request
when `canOpen` is false.

### 12.5 Documents

ASB.md (cards), SYSTEM_OVERVIEW (sources table: Claude CLI sessions and the
registry), PRIVACY (the registry is read; `.key` files are not), DESIGN.md
(the view-only card rule, and that the user approved option D, "Machine in
the meta line", with the Grey tone, from
`.impeccable/options/remote-cards-2026-10-19/index.html`).

### Phase 2 acceptance

- Checks pass.
- On the Debian PC: a running `claude` CLI session shows as a card with the
  terminal glyph and `CLI` before the age (Compact: `Idle · CLI`); a click
  does nothing; the tooltip says it is a CLI session.
  A Codex CLI task looks the same. Codex and Claude desktop chats still open.
  A CLI transcript older than 7 days with no live process does not show.

## 13. Phase 3: machine group and remote cards (Linux)

### 13.1 Group store

Create `src/machine-group.mjs`: load and save `group.json` (atomic write,
`0600`, same style as `phone.json`), `mergeGroup(local, remote)`,
`activeMembers`, `activePhones`, `suggestName`, name validation, and invite
codes. Pure functions get tests in `test/machine-group.test.mjs` (merge order,
tombstones win, limits, names, codes expire and void after 8 tries).

### 13.2 Gateway

In `src/phone-gateway.mjs`:

1. Add `requestCert: true, rejectUnauthorized: false` to the listener. Phone
   routes do not change.
2. Add an option `peer` with callbacks: `join`, `hello`, `group`, `sessions`,
   `leave` (phase 6 adds `peers` and `deliver`). Route `/peer/v1/*` to them
   after the member check (section 9.4). Keep the caller address rules, the
   throttle, and the body limits.
3. Phone token check: also accept a token whose SHA-256 matches an active
   group phone. When a phone pairs, add it to the group (`phones` entry) if
   this engine is in a group (planner decision P1). When this engine creates
   or joins a group, add its phones that are already paired.
4. Revoking a phone also writes a `removedPhones` tombstone.
5. Make certificate creation callable without starting a listener (12.1 uses
   it for the identity).

### 13.3 Peer client and poller

Create `src/machine-peers.mjs`:

- `peerRequest({ member, path, method, body, etag, tls })`: `https.request`
  with `minVersion: 'TLSv1.3'`, the engine certificate and key as client
  credentials (`tls` holds `cert`/`key` on Linux; `pfx`/`passphrase` on
  Windows), `rejectUnauthorized: false`. On `secureConnect`, compare the SHA-256
  of the server certificate DER with `member.certFingerprint`; on a mismatch,
  destroy the socket with the error `pin-mismatch`. Try the member addresses
  in this order: the last address that worked, then `lan`, `zerotier`,
  `tailscale`. Timeout 4 s.
- A poller per active member except this machine:
  - sessions every `max(2000, refreshIntervalMs of the last reply)` ms with
    the ETag;
  - group every 30 s, merged with `mergeGroup` and saved when it changed;
  - hello at start and every 60 s (address refresh, kept in memory only).
  - Back-off when a request fails: 5 s, 10 s, 30 s.
- Member state: `{ online, lastOkAtMs, sessions, error }`. `online` becomes
  false after 3 failed polls.
- `onChange()` runs after a `200` sessions reply or an `online` change. The
  engine calls `invalidateDashboard('peer-sessions', { hard: false })`.

### 13.4 Export, merge, and messages

Pure functions in `src/machine-peers.mjs`, tests in
`test/machine-peers.test.mjs`:

1. `buildSwitchboardDashboard` keeps the message key map and the unresolved
   incoming messages as a non-enumerable property (a module `Symbol`), so the
   export does not scan again. Change `resolveSessionMessages` to also return
   `keysByRow` and `unresolved` (`{to, from, atMs}` where `from` is not a
   local key). Keep its current return value for existing callers.
2. `exportLocalSessions(dashboard, self)`: section 9.2.
3. `mergePeerRows(dashboard, peerStates, self, nowMs)`:
   - Local rows get `machineId`, `machineName`, `remote: false`, `globalId`.
   - Rows of each peer (online, or offline for less than 10 minutes) get the
     remote fields from 9.1. Rows of an offline peer get `state: "unknown"` and
     `reason: "<name> is not reachable."`.
   - Drop a local remote-cache row when a peer row has one of its
     `bridge:session_<t>` or `bridge:cse_<t>` keys (the peer row is the real
     session).
   - Messages: make one key map from local keys and peer keys (mapped to
     merged row IDs; a key with two rows is not used). Resolve each peer's
     `incoming` and the local `unresolved` entries. Add them to
     `dashboard.messages` with the current rules (2-minute window, up to 5 s in
     the future, no self messages, dedupe, sort, newest 50).
4. In `createSwitchboardServer`'s `loadDashboard`, call `mergePeerRows` on
   the loaded dashboard before `tracker.observe`.
5. `openThread` and `discardThread` refuse remote rows with a clear error.

### 13.5 Loopback routes and CLI

Add the phase 3 routes of section 9.5 in `src/asb-server.mjs`.

Create `scripts/asb-group.mjs` (`asb group status|invite|join <link>
[--name N] [--yes]|remove <name>|leave`) and `asb network status|enable
<address>...|disable` (it uses the existing `/api/phone` and
`/api/phone/settings` routes). Both find the engine through `service.json`,
like `scripts/asb-agent.mjs`. Add `group` and `network` to the dispatch in
`scripts/asb` (phase 4 moves the dispatch to `scripts/asb.mjs`). `join` prints the inviter name and the
fingerprint from the link and asks
`Does the other machine show this fingerprint? [y/N]` unless `--yes`.
Invite and join refuse when network access is off:
`Turn on network access first: asb network enable <address>.`

Join flow on the engine: parse the link; post `/peer/v1/join` to the
inviter (pinned to `f`, with this engine's client certificate); save the
returned group with `self`; start the pollers. On the inviter: check the code,
check that the caller's certificate is not in `removed`
(`409 This machine was removed. Reset its identity and join again.`), check
the name, add the member, return the group.

Leave: post `/peer/v1/leave` to one reachable member, delete `group.json`,
and stop the pollers. The certificate stays, so paired phones keep working.
To join again after a removal, the machine needs a new identity:
`asb group reset-identity` (deletes the certificate; the next start makes a new
one; phones must pair again).

### 13.6 Board: Preferences > Machines

Add a **Machines** page after **Phone** in `scripts/asb-native.py`:

- `This machine: <name> (<first 8 characters of machineId>)`.
- Member list: name, short ID, `Online` or `Offline · last seen <age>`,
  addresses in muted text, and **Remove** (with a confirm dialog).
- **Add a machine**: calls invite; shows the link (selectable), the
  fingerprint, the QR code (reuse the phone pairing QR path), and the expiry.
- **Join a group**: a link entry and a name entry (prefilled with the
  suggestion); shows the fingerprint from the link and asks the user to
  compare it; then **Join**.
- **Leave the group** with a confirm dialog.
- When network access is off, the page says so and links to **Phone**.

Put the text and state rules in pure functions with tests.

### 13.7 Documents

PRIVACY (session titles, folders, states, and times go to group members
over the selected private addresses with pinned TLS 1.3; never message
text), SECURITY.md (trust model: any member can add or remove members), and
AGENTS.md (the gateway also serves member routes).

### Phase 3 acceptance

- Checks pass, including gateway tests with real TLS on `127.0.0.x`
  (inject `listAddresses` as the current tests do).
- The paired Android phone still connects and refreshes after the listener
  asks for client certificates (the phone sends none).
- Two-engine check on the Debian PC (Appendix C): engine B joins engine A;
  A's board shows B's rows with B's name in the bottom line; open is refused; Read,
  Pin, and the drawer work and change only A's `pending.json`; a remote Done
  plays a sound while A's board is open; a fixture cross-session message
  between A and B animates as a line; stopping B makes its cards Unknown with
  the note, and they leave after 10 minutes.

## 14. Phase 4: Windows engine (statuses only) and npm install

Run spikes S2, S6, and S7 before this phase.

### 14.1 Launcher and npm

1. Create `scripts/asb.mjs` with `#!/usr/bin/env node`. It dispatches
   `engine`, `service` (Linux), `agent`, `bridge`, `group`, `network`, `phone`,
   and `setup` by importing each script's `main(argv)`. With no subcommand:
   Linux opens the board (the `asb-desktop.mjs` logic); Windows prints the
   engine status and the hint `ASB has no window on Windows. Use the phone or
   a Linux board.`
2. Make `scripts/asb` call `scripts/asb.mjs` after it finds Node, so both
   launchers share one dispatcher. Keep its Node discovery.
3. `package.json`: add `"bin": { "asb": "scripts/asb.mjs" }` and a `files`
   list: `src/`, `scripts/*.mjs`, `scripts/asb`, `scripts/asb-native.py`,
   `scripts/asb-tray.py`, `scripts/asb-tray.ps1`, `public/`, `assets/`,
   `bridge/dist/`, `bridge/hooks/`, `bridge/agent-skills/`,
   `bridge/.codex-plugin/`, `bridge/.mcp.json`, `bridge/package.json`,
   `bridge/LICENSE`, `bridge/README.md`, `.agents/plugins/marketplace.json`,
   `LICENSE`, `README.md`. Check with `npm pack --dry-run` that the Android,
   demo, docs, and test folders are not in the package.
4. On Windows, `scripts/asb.mjs` refuses Node older than 22.13 (the engine
   needs `node:sqlite`; `sqlite3` is rarely installed on Windows).

### 14.2 Paths

Create `src/platform-paths.mjs` with `configDir(env, platform)`,
`stateDir(env, platform)`, and `runtimeDir(env, platform)`:

| Function | Linux (unchanged) | Windows |
| --- | --- | --- |
| `configDir` | `$XDG_CONFIG_HOME/asb` or `~/.config/asb` | `%APPDATA%\asb` |
| `stateDir` | `$XDG_STATE_HOME/asb` or `~/.local/state/asb` | `%LOCALAPPDATA%\asb\state` |
| `runtimeDir` | `$XDG_RUNTIME_DIR/asb` (required) | `%LOCALAPPDATA%\asb\run` |

Use them in `app-sources.mjs` (line 87), `phone-gateway.mjs` (26 to 31),
`switchboard.mjs` (371, 647), and `asb-instance.mjs` (7 and 8). Linux values
must stay byte-identical; add tests for both platforms with fake `env`.

### 14.3 File safety on Windows

- In `asb-instance.mjs` and the other mode and uid checks: on win32, skip the
  mode and uid checks, keep the refusal of links (`lstat().isSymbolicLink()`
  also catches junctions).
- When the engine creates its config, state, and runtime folders on win32,
  limit them to the user:
  `icacls <folder> /inheritance:r /grant:r <USERDOMAIN>\<USERNAME>:(OI)(CI)F`
  (with `execFile`, no shell).
- Stale `service.json`: before refusing to start, send `GET /api/service`
  with the recorded token (2 s timeout). No answer means stale: replace it.

### 14.4 TLS certificate on Windows

On win32, create the certificate with PowerShell (Appendix B, part 1):
ECDSA P-256 in `Cert:\CurrentUser\My`, export `cert.pfx` (random passphrase in
`pfx-pass`) and `cert.cer`, then remove it from the store. The gateway and the
peer client use `pfx` and `passphrase` on win32. The fingerprint is
`new X509Certificate(cer).fingerprint256` without colons, in lowercase.

### 14.5 Network names

In `addressKind`, use `/^tailscale/i` and `/^(zt|zerotier)/i`. Add tests with
the Windows adapter names `Tailscale` and `ZeroTier One [8056c2e21c000001]`.

### 14.6 Autostart and tray on Windows

- `asb engine install` (win32): `reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  /v ASB /t REG_SZ /d "<command>" /f` with `execFile`, where `<command>` is
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<root>\scripts\asb-tray.ps1"`.
  Then start that command now (detached, `windowsHide: true`).
- `asb engine uninstall` (win32): `reg delete ... /v ASB /f`, then stop.
- `scripts/asb-tray.ps1` (Appendix B, part 2): starts the engine hidden,
  restarts it after a crash (at most 5 times in 10 minutes), shows the tray
  icon, and stops the engine on **Quit ASB**.
- Add `windowsHide: true` to the spawns in `session-opener.mjs:21` and
  `claude-data.mjs:1156`.
- Windows has no board, so it never plays sounds (phase 1 rule).

### 14.7 Readers on Windows

Use the store paths that spike S2 found for the default Codex and Claude
sources. If the Claude cache format differs, turn off remote-cache rows on
win32 with a source warning. Accept only `.exe` launchers on win32.

### 14.8 `asb setup`

Interactive on both systems; `--yes` and `--address <ip>` for scripts:

1. Install the engine autostart (Linux: `asb service install`; Windows: 14.6).
2. Network access: list addresses, ask which to turn on, save them.
3. Windows: print the firewall command and ask the user to run it in an admin
   PowerShell. Never run it.

   ```powershell
   New-NetFirewallRule -DisplayName "ASB engine" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4630 -LocalAddress <selected addresses> -Program "<node.exe path>"
   ```

4. Bridge: Linux prints `asb bridge install --all`; Windows prints
   `The bridge is not available on Windows yet.` until phase 7.
5. Print how to join a group.

### 14.9 Windows CI

Add a `windows-latest` job to `.github/workflows/test.yml` that runs an
explicit list of platform-neutral tests (`test/machine-group.test.mjs`,
`test/machine-peers.test.mjs`, `test/platform-paths.test.mjs`, and others that
do not use POSIX modes, `/bin/sh`, or `systemctl`).

### Phase 4 acceptance

- Checks pass on Linux; the Windows CI job passes.
- On homeLP (after the user installs Node.js 22 LTS through RDP):
  `npm install -g <tarball from npm pack>`, `asb setup`, the user runs the
  firewall command, `asb group join <link from the Debian board>`.
- The Debian board shows homeLP's Codex and Claude sessions (desktop and CLI)
  with `homeLP` in the bottom line, and their states change within 5 s.
- After the user signs out and in on homeLP, the engine runs again and the
  tray icon shows (the user confirms through RDP). **Quit ASB** stops it.

## 15. Phase 5: Android

### 15.1 Server side

- `/phone/v1/hello` adds `machineId` and
  `engines: [{ machineId, name, port, fingerprint, addresses: [{kind, address}] }]`
  (active group members; the fingerprint is the member `certFingerprint`).
- Rows already carry the section 9.1 fields.

### 15.2 App

- `data/Models.kt`: `Thread` gets `machineId`, `machineName`, `remote`
  (default false), `surface` (default `"app"`), `globalId` (default empty;
  use `id` when empty). `Hello` gets `machineId` and `engines` (default empty).
- `data/Store.kt`: keep the current keys for the paired engine. Add `engines`
  (JSON list from hello) and `currentEngine`. The token is the same for every
  engine (planner decision P1). Clear both on unpair.
- `net/AsbApi.kt` and `net/PinnedClient.kt`: GET tries the current engine,
  then the paired engine, then the others, each with its own fingerprint pin.
  The engine that answers becomes current. POST goes only to the engine that
  served the dashboard on screen, because remote row IDs differ per engine.
- `notify/Events.kt` and `notify/Notifier.kt`: key the baseline and the
  notification tags by `globalId`, so a switch of engine does not repeat
  notifications.
- `ui/SessionsScreen.kt`, option D (the same rules as section 12.3):
  - Comfortable card: at the right of the bottom row, before the age, the
    glyph and the machine name (or `CLI`) with ` · `; the machine name
    ellipsizes first, at about 12 characters.
  - Compact card: ` · <machineName>` or ` · CLI` after the state, no glyph.
  - Glyphs: vector drawables `ic_machine.xml` and `ic_terminal.xml` from the
    Appendix D paths (`android:viewportWidth="12"`,
    `android:viewportHeight="12"`, `android:fillType="evenOdd"` on the ring
    paths).
  - Grey tone with the rule of `view_only_tone` (12.3 step 2), using the
    app's existing quiet colors; the limit colors win.
  - Inspector: the button `On <machineName>` or `Runs in a terminal`,
    disabled. Accessibility text: add `On <machineName>. View only.` or
    `CLI session. View only.`
- Settings: list the engines with `Online` or `Offline` and mark the one in use.
- Tests: `ModelsTest` (defaults), `AsbApiTest` (engine order, POST only to the
  current engine, pins per engine), `EventsTest` (`globalId` keys), rules tests
  for view-only rows.

### Phase 5 acceptance

- `cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug assembleRelease` passes.
- On the phone: paired with the Debian engine, it shows homeLP cards with
  `homeLP` in the bottom line. After `asb engine stop` on Debian, it changes to the homeLP engine
  within 30 s and shows the sessions. No notification repeats after the change.

## 16. Phase 6: messages between machines (Linux)

Gate: spike S1 passed (or the user approved the one-process-per-row fallback).

### 16.1 Relay process

Create `bridge/src/relay.ts`, bundled to `bridge/dist/relay.js`:

- The engine starts it as a child (`bun <root>/bridge/dist/relay.js`) when
  Bun is on the PATH and the group has another active member. It restarts it
  after a crash (at most 5 times in 10 minutes) and stops it with the engine.
- Environment: `ASB_ENGINE_URL`, `ASB_SOURCE_TOKEN`. The relay listens on a
  random loopback port and prints one JSON line `{port, token}` to stdout. The
  engine calls the relay with that token.
- At start, the relay removes old proxy rows (`entrypoint: "asb-relay"`) whose
  PID is not alive, and their sockets.

### 16.2 Proxy rows

- Every 5 s, read `GET /api/relay/homes` and `GET /api/relay/remote-peers`,
  apply the rule in section 9.6, and add or remove proxy rows.
- A proxy row: start a placeholder (`/usr/bin/cat` with
  `stdio: ['pipe', 'ignore', 'ignore']`; it exits when the relay dies), read its
  `procStart` with `processStart()`, listen on a socket in the relay's private
  `0700` folder, and write `<home>/sessions/<placeholder pid>.json` with flag
  `wx` and mode `0600`: `pid`, `sessionId` (the remote session's ID), `cwd: ""`,
  `name` (`<machine name>-<remote name>`, lowercase, only letters, digits,
  `-`, `_`; unique among live rows), `startedAt`, `procStart`,
  `peerProtocol: 1`, `kind: "interactive"`, `entrypoint: "asb-relay"`,
  `messagingSocketPath`, `status`, `statusUpdatedAt`, `peerFeatures: []`.
  No `notify_idle`, so no idle subscriptions.
- Remove a proxy row (row file, socket, placeholder) when its remote session
  goes away or its machine is offline.
- In the Codex MCP server, `list_sessions` and `findPeer` (for
  `send_message`) skip rows with `entrypoint: "asb-relay"`. Codex senders
  reach remote sessions only through the relay API (16.4).

### 16.3 Sending (local Claude to a proxy socket)

- Parse lines with `frameSchema`. Ignore an `auth` line.
- `user` frame: check the size; parse `from`, `from-session`, `from-name`,
  `from-mode`, and `hop-chain` with the existing helpers; find the sender's
  local registry row by `peerAddress(messagingSocketPath) === from` (drop the
  frame when there is none); call `POST /api/relay/send` with the target
  machine and session, the sender, the message text inside the envelope, the
  hop chain, and `msg_id`.
- When the reply is not `ok`, write a receipt to the sender's socket in the
  format of `receipt()` in `bridge.ts`:
  `{type:"control", subtype:"peer_message_status", orig_msg_id, status:"expired", status_detail:"refused", reason:"<machine> is not reachable."}`
  (use the reason that matches the error).
- `peer_message_status` control frame (a receipt from a target that got a
  message through a reverse proxy row): send it with `control` in place of
  `message` (section 9.7), to the machine of the original sender.
- Drop other control frames.

### 16.4 Sending (local Codex task)

In `bridge/src/server.ts` and `bridge/src/bridge.ts`:

- `list_sessions`: add the entries of `GET /api/relay/remote-peers` (find the
  engine through `service.json`; skip quietly when there is no engine) with
  `name: "<machine>-<name>"`, `remote: true`, and `machine`.
- `send_message` to a `sessionId` that is not a local peer but is in the
  remote list: call `POST /api/relay/send` with this task as the sender (its
  thread ID, its row name, its runtime mode). Return the reply outcome or the
  refusal reason to the model.

### 16.5 Delivery on the target machine

The engine's `/peer/v1/deliver` handler forwards to the relay. The relay:

1. finds exactly one live local registry row with `sessionId ===
   targetSessionId` and `entrypoint !== "asb-relay"` in the local config homes;
   else replies `target-unavailable`;
2. makes sure a reverse proxy row for the sender exists in the target's
   config home (the same mechanics as 16.2), so the target can reply;
3. builds the frame with the `userFrame()` logic: `from` is the reverse proxy
   address, `from-session` is the sender's session ID, `from-name` is the
   reverse proxy row name, `from-mode` is the sender's mode, `hop-chain` is the
   sender's chain unchanged, `session_id` is the target, `priority: "next"`,
   `msg_id` unchanged;
4. writes it with `sendFrames()` (auth key lookup, socket and `procStart`
   checks, burst budget);
5. replies `{ok:true, outcome:"socket-written"}` or a reason.

A frame that arrives on a reverse proxy socket (a reply or a receipt from the
target) goes back through 16.3 to the original sender. Keep `orig_msg_id` in
receipts. Never deliver a frame to a proxy row: delivery targets only real
local sessions, so relays cannot loop.

### 16.6 Engine routes

Add `GET /peer/v1/peers`, `POST /peer/v1/deliver`, `GET /api/relay/homes`,
`GET /api/relay/remote-peers`, and `POST /api/relay/send` (sections 9.4, 9.5,
9.7). The engine polls each member's `/peer/v1/peers` every 5 s while the relay
runs. `POST /api/relay/send` to an offline member replies
`machine-offline` at once (no queue).

`GET /api/relay/homes`: the Claude config homes of enabled Claude sources
(`path.dirname(projectsDir)`), plus `~/.claude` and `CLAUDE_CONFIG_DIR`
when they exist, without duplicates, each with its `remoteClaude` override
and `hasRemoteControl` (a live local session with `bridgeSessionId`).

### 16.7 Profiles override

Add the optional `remoteClaude` field to Claude sources in
`src/app-sources.mjs` (validation, revision, `asb agent sources` JSON), and the
**Remote Claude sessions** dropdown in Profiles.

### 16.8 Tests

- `bridge/test/relay.test.ts`: two relays and two registry folders in one
  test, with the engine routes faked: Claude fixture to proxy to remote Codex
  fixture receiver; the reply path; the offline refusal receipt; proxy rows
  removed after a relay restart; a placeholder exits when its relay dies;
  the rule matrix of 9.6.
- `test/machine-relay-api.test.mjs`: engine routes, member checks, body
  validation, offline refusal.

### Phase 6 acceptance

- Checks pass.
- Live check (ask the user first; it uses model quota): with two engines on
  the Debian PC (Appendix C) and two Claude config homes, a Claude session in
  a proxy profile lists `<machine>-...` rows in `/list-agents`, messages a
  Codex task "on the other machine", and gets a reply. A message to a stopped
  engine's session gives an immediate refusal notice. The board animates the
  message between the two machines.

## 17. Phase 7: Windows bridge

Gate: spikes S3, S3b, S4, and S5 passed (2026-10-19). This section was updated
with their results before the code.

Today every uid and mode check in the bridge fails on Windows
(`process.getuid` does not exist), so `peers()` is always empty and no
receiver starts. This phase ports the bridge, its installer, and the relay.
Linux and macOS behavior does not change.

### 17.1 Platform module

New `bridge/src/platform.ts`; `claude.ts`, `codex.ts`, `outbound.ts`,
`hook.ts`, `bridge.ts`, and `relay.ts` use it.

- `ownedJson`, `privateDirectory`: Linux and macOS as now. Windows: `lstat`
  must give a file (or a folder) that is not a symbolic link or junction
  (refuse reparse points), and the size limit applies. No uid or mode check:
  the folders are in the user profile, which Windows keeps private to the
  user. No `O_NOFOLLOW` (the `lstat` check comes first).
- `checkPeerSocket(path)`: Linux and macOS as `checkSocket` now. Windows:
  the path must match Claude's rule `^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$`
  (case-insensitive; S3b). No file check on a pipe.
- `processStart(pid)`: Linux and macOS as now. Windows: the creation
  FILETIME from `GetProcessTimes` as a decimal string, through `bun:ffi`
  (`kernel32` `OpenProcess(0x1000)`, `GetProcessTimes`, `CloseHandle`). It
  equals Claude's `procStart` exactly (S3b). No cache.
- `pidDomain()`: Windows `win32:${os.hostname().toLowerCase()}`; macOS
  `darwin` (as now); Linux none (as now).
- `inboxPath(directory)`: Linux and macOS `<directory>/<pid>.sock` (as now).
  Windows `\\.\pipe\LOCAL\cc-msg-<32 random hex>`.
- `outboxPath(inbox)`: Linux and macOS replace `.sock` with `.out` (as now).
  Windows `\\.\pipe\LOCAL\asb-out-<the same 32 hex>`.
- `keyName(pid, address)`: `<pid>.<sha256(canonical)>.key`. Canonical is
  `\\.\pipe\` plus the lower-case pipe name for a pipe, else the path as now.
- No `umask` or `chmod` on Windows.

### 17.2 Key files and the `auth` line

- On Windows, `register()` (the bridge receiver) and the relay (each proxy
  row) first write their key file `sessions/<pid>.<hash>.key` with
  `{ peerToken, procStart, pidDomain }` (`peerToken` 16 random bytes in hex;
  through `<name>.tmp.<hex>` and a rename, mode `0600`), then the row with
  `pidDomain`. They remove the key file with the row.
- On Windows, the inbox needs `{"type":"auth","token":"<peerToken>"}` as the
  first line of each connection (constant-time compare, within the 30 s
  deadline); else it closes the connection. Linux and macOS keep ignoring the
  `auth` line.
- `sendFrames` on Windows: the key file is required (Windows receivers need
  `auth`); a missing key file is the error
  `Claude peer key is missing; list sessions again`.
- The outbound server (`.out`) on Windows also needs the `auth` line with the
  receiver's `peerToken`. The MCP server process reads it from the
  receiver's key file, as `sendFrames` does.

### 17.3 Stop and cleanup on Windows

A signal on Windows ends a process with no handler (`TerminateProcess`).

- Hook `SessionEnd` on Windows: after the stop and the exit, it deletes the
  receiver's row and key file when they still have that `pid` and
  `procStart`.
- The engine stops the relay on Windows by ending its stdin (the relay exits
  cleanly, 16.1), waits up to 2 s, then kills it. At start the relay removes
  stale proxy rows and their key files (16.1).

### 17.4 Codex transports on Windows (S4)

- Desktop: `\\.\pipe\codex-ipc` (a fixed name; no file check). The Codex
  home goes to `discoverTarget` as its own argument (today it is derived from
  the IPC path).
- App-server daemon: `$CODEX_HOME\app-server-control\app-server-control.sock`
  over AF_UNIX (Bun connects; S4). On Windows the WebSocket uses
  `ws://localhost/` with the `ws` option `createConnection: () =>
  net.connect(path)`, because `ws+unix://` splits a `C:\` path at the colon.
  The folder check is `privateDirectory`; the socket file must exist (it is a
  reparse point on Windows, so the reparse refusal does not apply to this one
  file).
- The revive path in `hook.ts` uses the same two transports.

### 17.5 Installer (`scripts/asb-bridge.mjs`) on Windows

- `executable(name)`: on Windows, search each `PATH` folder with each
  `PATHEXT` extension (default `.COM;.EXE;.BAT;.CMD`); return the full path.
- `codex.cmd`: run it through `cmd.exe /d /s /c` with fixed arguments only.
  Each argument is put in double quotes and must not contain `"`, `%`, `^`,
  `&`, `|`, `<`, `>`, `!`, or a line break; else the command stops with
  `This path cannot go to codex.cmd safely.` `.exe` files run directly.
- The check of `bun` on the PATH of a running Codex app-server stays
  Linux-only.
- Linking Claude registry folders refuses on Windows:
  `Linking Claude session folders is not supported on Windows.`

### 17.6 Relay on Windows

- The supervisor also starts the relay on Windows (16.1 condition with
  `bun.exe` found through `PATHEXT` and `%SystemRoot%\System32\findstr.exe`
  in place of `/usr/bin/cat`).
- Placeholder: `findstr.exe x` with a stdin pipe and ignored output (S5).
- Proxy sockets are `cc-msg-` pipes with key files and the `auth` check
  (17.1, 17.2).

### 17.7 Tests and CI

- Linux-only tests (Unix socket files, `/proc`, `/tmp`, modes, symbolic
  links, signals) skip on Windows with a reason.
- New tests that run on all platforms: the platform helpers; an inbox and
  `sendFrames` round trip with a key file in a temporary `sessions` folder
  (on Windows through a `cc-msg-` pipe, with a wrong and a missing `auth`
  line refused); `processStart` of the test process equals the value from the
  operating system (Windows: `Get-Process` `StartTime.ToFileTimeUtc()`).
- Windows CI: a `bridge` job on `windows-latest` with Bun runs
  `bun run check` and `bun test`.

### 17.8 Documents

`bridge/README.md` (Windows), `bridge/PROTOCOL-COVERAGE.md` (Windows pipes,
key files, `auth`), `SYSTEM_OVERVIEW.md`, `ASB.md` (bridge install on
Windows), `CHANGELOG.md` (Unreleased).

### Phase 7 acceptance

- Checks pass on Linux, and the Windows list passes on homeLP.
- On homeLP (no model use): `asb bridge install` adds the plugin for Codex;
  `asb bridge status` is good. A receiver row that ASB writes has the S3b
  shape (pipe, key file, `pidDomain`, `procStart`), and a test sender with the
  key reaches it while a sender without the key cannot.
- Live (ask the user first; it uses model quota and an RDP session): Claude
  `/list-agents` on homeLP lists a local Codex task (the local bridge works on
  Windows) and the Debian sessions; messages work in both directions between
  Debian and homeLP for Codex to Claude, Codex to Codex, and a proxy Claude
  profile to Claude. The Codex desktop app answers on `\\.\pipe\codex-ipc`.

## 18. Phase 8: documents

Update README, ASB.md, SYSTEM_OVERVIEW.md, PRIVACY.md, SECURITY.md,
CHANGELOG.md (Unreleased), DESIGN.md, PRODUCT.md, AGENTS.md, bridge/README.md,
bridge/PROTOCOL-COVERAGE.md (Windows, cross-machine rows), and
bridge/COMPARISON.md (the "other machines" line). Do not change the version.
Ask the user about the release.

## Appendix A: Linux tray (D-Bus)

Use `Gio.bus_own_name` for `org.kde.StatusNotifierItem-<pid>-1`, export the
two objects below with `Gio.DBusNodeInfo.new_for_xml` and
`connection.register_object`, then call
`org.kde.StatusNotifierWatcher.RegisterStatusNotifierItem(<bus name>)` on
`/StatusNotifierWatcher`. Run a `GLib.MainLoop`.

Object `/StatusNotifierItem`:

```xml
<node>
 <interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconThemePath" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
  <signal name="NewIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg name="status" type="s"/></signal>
 </interface>
</node>
```

Values: `Category` `ApplicationStatus`, `Id` `asb`, `Title` `ASB`, `Status`
`Active`, `ItemIsMenu` false, `Menu` `/MenuBar`, `ToolTip`
`("", [], "ASB", "<text>")`. Emit `NewToolTip` when the text changes.

Object `/MenuBar`:

```xml
<node>
 <interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/>
  <property name="TextDirection" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout">
   <arg type="i" name="parentId" direction="in"/><arg type="i" name="recursionDepth" direction="in"/>
   <arg type="as" name="propertyNames" direction="in"/>
   <arg type="u" name="revision" direction="out"/><arg type="(ia{sv}av)" name="layout" direction="out"/>
  </method>
  <method name="GetGroupProperties">
   <arg type="ai" name="ids" direction="in"/><arg type="as" name="propertyNames" direction="in"/>
   <arg type="a(ia{sv})" name="properties" direction="out"/>
  </method>
  <method name="GetProperty">
   <arg type="i" name="id" direction="in"/><arg type="s" name="name" direction="in"/><arg type="v" name="value" direction="out"/>
  </method>
  <method name="Event">
   <arg type="i" name="id" direction="in"/><arg type="s" name="eventId" direction="in"/>
   <arg type="v" name="data" direction="in"/><arg type="u" name="timestamp" direction="in"/>
  </method>
  <method name="EventGroup">
   <arg type="a(isvu)" name="events" direction="in"/><arg type="ai" name="idErrors" direction="out"/>
  </method>
  <method name="AboutToShow"><arg type="i" name="id" direction="in"/><arg type="b" name="needUpdate" direction="out"/></method>
  <method name="AboutToShowGroup">
   <arg type="ai" name="ids" direction="in"/><arg type="ai" name="updatesNeeded" direction="out"/><arg type="ai" name="idErrors" direction="out"/>
  </method>
  <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})" name="updatedProps"/><arg type="a(ias)" name="removedProps"/></signal>
  <signal name="LayoutUpdated"><arg type="u" name="revision"/><arg type="i" name="parent"/></signal>
 </interface>
</node>
```

`Version` 3, `TextDirection` `ltr`, `Status` `normal`. `GetLayout` returns
revision 1 and
`(0, {"children-display": "submenu"}, [ <(1, {"label": "Open ASB"}, [])>, <(2, {"type": "separator"}, [])>, <(3, {"label": "Quit ASB"}, [])> ])`,
where each child is a `GLib.Variant("(ia{sv}av)", ...)`. `Event` with
`eventId` `clicked` runs the item. `AboutToShow` returns false.

Check on the Debian PC with
`busctl --user call org.kde.StatusNotifierWatcher /StatusNotifierWatcher org.freedesktop.DBus.Properties Get ss org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems`.

## Appendix B: Windows scripts

Part 1, certificate (run with `execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])`;
pass the folder and the passphrase through environment variables, never by
string concatenation into the script):

```powershell
$ErrorActionPreference = 'Stop'
$c = New-SelfSignedCertificate -Subject 'CN=ASB' -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy Exportable `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(10)
try {
  $p = ConvertTo-SecureString -String $env:ASB_PFX_PASS -AsPlainText -Force
  Export-PfxCertificate -Cert $c -FilePath (Join-Path $env:ASB_TLS_DIR 'cert.pfx') -Password $p | Out-Null
  Export-Certificate -Cert $c -FilePath (Join-Path $env:ASB_TLS_DIR 'cert.cer') -Type CERT | Out-Null
} finally { Remove-Item -LiteralPath $c.PSPath }
```

Part 2, tray (`scripts/asb-tray.ps1`), outline:

```powershell
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source
# Start the engine with no window and restart it after a crash (5 times in 10 minutes at most).
# NotifyIcon: icon from assets\icons\asb-tray-32.png through [System.Drawing.Icon]::FromHandle(...GetHicon()).
# ContextMenuStrip: "Copy phone pairing link" (POST /api/phone/pairing, Set-Clipboard), "Quit ASB".
# Quit: read %LOCALAPPDATA%\asb\run\service.json, POST /api/engine/stop with X-ASB-Source-Token,
#       wait for the engine to exit, hide the icon, exit.
[System.Windows.Forms.Application]::Run()
```

Start the engine with `System.Diagnostics.ProcessStartInfo` (`FileName` =
node, `Arguments` = the quoted `scripts\asb.mjs engine run`,
`UseShellExecute = $false`, `CreateNoWindow = $true`). Make
`assets/icons/asb-tray-32.png` from `local.asb.AgentSwitchBoard.svg` once and
commit it.

## Appendix C: two-engine check on one Linux PC

Run two engines with separate homes. Engine A uses the LAN address, engine B
the ZeroTier address, both on gateway port 4630.

Stop the real `asb.service` first and start it again at the end:

```bash
systemctl --user stop asb.service
```

Make the folders (the runtime folders need mode `0700`):

```bash
mkdir -p -m 700 /tmp/asb-a/run /tmp/asb-b/run
```

Start engine A and engine B, each in its own terminal tab:

```bash
env HOME=/tmp/asb-a XDG_CONFIG_HOME=/tmp/asb-a/config XDG_STATE_HOME=/tmp/asb-a/state XDG_RUNTIME_DIR=/tmp/asb-a/run PORT=4629 node scripts/asb-engine.mjs run
```

```bash
env HOME=/tmp/asb-b XDG_CONFIG_HOME=/tmp/asb-b/config XDG_STATE_HOME=/tmp/asb-b/state XDG_RUNTIME_DIR=/tmp/asb-b/run PORT=4639 node scripts/asb-engine.mjs run
```

Give each engine fixture Codex and Claude stores (copy the test fixtures into
its home before the start). Run every `scripts/asb` command with the same
`env` prefix as its engine, so it finds that engine's `service.json`:

1. A: `scripts/asb network enable <this PC's LAN address>`; B:
   `scripts/asb network enable <this PC's ZeroTier address>`.
2. A: `scripts/asb group invite`; B: `scripts/asb group join '<link>' --name engine-b`.
3. Open a board on A: `ASB_SOURCE_TOKEN=<token from A's service.json> python3 scripts/asb-native.py http://127.0.0.1:4629`.

At the end, stop both engines and remove `/tmp/asb-a` and `/tmp/asb-b`.

## Appendix D: option D glyphs

Copy these files exactly. They use the format of the existing provider marks
(`assets/icons/asb-claude-symbolic.svg`): one root fill, no strokes. Both
were checked in a browser at 192 px and 11 px on 2026-10-19.

`assets/icons/asb-machine-symbolic.svg` (a screen on a stand):

```xml
<svg width="16" height="16" fill="#a5a5a5" role="img" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><title>Other machine</title><path fill-rule="evenodd" d="M2 1h8a1.5 1.5 0 0 1 1.5 1.5V7A1.5 1.5 0 0 1 10 8.5H2A1.5 1.5 0 0 1 .5 7V2.5A1.5 1.5 0 0 1 2 1zm0 1.5V7h8V2.5z"/><path d="M5.25 8.5h1.5V10H9v1.5H3V10h2.25z"/></svg>
```

`assets/icons/asb-terminal-symbolic.svg` (a window with a prompt):

```xml
<svg width="16" height="16" fill="#a5a5a5" role="img" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><title>CLI session</title><path fill-rule="evenodd" d="M2 1h8a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 10 11H2A1.5 1.5 0 0 1 .5 9.5v-7A1.5 1.5 0 0 1 2 1zm0 1.5v7h8v-7z"/><path d="M3.67 3.83 5.85 6 3.67 8.17 2.83 7.33 4.15 6 2.83 4.67z"/><path d="M6 7.4h2.6v1.1H6z"/></svg>
```

For Android, use the same `pathData` values in `ic_machine.xml` and
`ic_terminal.xml`, with `android:fillType="evenOdd"` on the first path of
each.
