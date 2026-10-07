# ASB system overview

ASB source `1.1.1` is unreleased. Published downloads remain on `1.1.0`.

ASB is a local switch board for existing Codex and Claude Desktop Code chats, including remote Code sessions observed in Claude's local cache. Its main view is a small native GNOME window. It observes local files and opens the original app. It makes no model calls.

Read [README.md](README.md) for installation, [ASB.md](ASB.md) for controls, and [Privacy](docs/PRIVACY.md) for data access. ASB uses its own version series. Agent Mission Control `0.6.0` is the upstream base, not the ASB release version.

## Runtime path

```text
scripts/asb-desktop.mjs
  -> src/switchboard.mjs, loopback HTTP server through src/asb-server.mjs
  -> scripts/asb-native.py, GTK/Libadwaita window
       -> local dashboard, event, open, and ASB state APIs

src/switchboard.mjs
  -> src/codex-data.mjs, ASB reader mode
  -> src/claude-data.mjs, ASB reader mode
  -> src/insights.mjs, root grouping and normalization
  -> PendingTracker, ASB attention and pin state
```

The launcher creates its own server and Python child. It stops them when the window closes. A port conflict is an error. It does not attach to a process already on the port. The server binds only to `127.0.0.1`; `HOST` cannot change that. The default port is `4629`.

Python 3 needs PyGObject, GTK `>=4.10`, and Libadwaita `>=1.4`. Node.js `>=22.13` uses built-in SQLite with read-only connections. Older supported Node.js (`>=20`) uses `sqlite3 -readonly`. ASB's runtime has no external npm dependencies. Development tests use Node.js `>=22.13` and need the SQLite CLI for some upstream fixtures.

ASB and the retained upstream server share `DashboardSnapshot` in `src/dashboard-snapshot.mjs` for snapshots, source events, watchers, caches, and request coalescing. They also share local HTTP utilities, Codex open helpers, and provider cache helpers. The ASB package excludes `src/server.mjs` and its upstream-only dashboard, quota, notification, review, and search modules. Those files remain in the source repository.

## Main files

| File | Responsibility |
| --- | --- |
| `src/switchboard.mjs` | ASB source selection, state, attention, pins, open validation, and server entry. |
| `src/asb-server.mjs` | Restricted ASB HTTP server for native and browser clients. |
| `src/dashboard-snapshot.mjs` | Shared snapshots, source events, watchers, caches, and request coalescing. |
| `src/local-http.mjs` | Shared JSON and static-file HTTP utilities. |
| `src/session-opener.mjs` | Shared Codex app opens and response fields. |
| `src/data-cache.mjs` | Shared provider cache helpers. |
| `src/codex-data.mjs` | Read-only Codex database, names, lifecycle, questions, and matched native read marks. |
| `src/claude-data.mjs` | Claude Desktop Code metadata and matched local transcript signals. |
| `src/claude-remote-data.mjs` | Approved cached remote session metadata, cursor-linked updates, and explicit worker state. |
| `src/insights.mjs` | Shared thread normalization and root/descendant grouping. |
| `scripts/asb-desktop.mjs` | Native launcher and owned child-process cleanup. |
| `scripts/asb-native.py` | Native rows, filters, search, layout, theme, input, and local label clock. |
| `scripts/asb-icon.mjs` | ASB icon and desktop entry registration. |
| `scripts/asb-package.mjs` | Linux package build, runtime check, and per-user install/uninstall. |
| `public/switchboard.html` | Optional ASB browser view. |
| `test/switchboard.test.mjs` | ASB data, attention, API, source-event, and launcher checks. |
| `test/asb_native_logic_test.py` | Native logic checks with no GTK display. |
| `demo/` | Separate Remotion project with synthetic public demo data. |

## Sources and list scope

ASB loads both sources independently. One failed source does not remove the other source's rows.

| Source | Read path |
| --- | --- |
| Codex | Latest `~/.codex/state_N.sqlite`, `session_index.jsonl`, `.codex-global-state.json`, and matched `sessions/**/rollout-*.jsonl`. |
| Claude Desktop Code on Linux | `$XDG_CONFIG_HOME/Claude/claude-code-sessions/local_*.json`, or `~/.config/Claude/claude-code-sessions/local_*.json`. |
| Claude transcript signals | Matched JSONL files under `~/.claude/projects`. |
| Claude remote Code | Session-list and watch response bodies in Claude's `Cache/Cache_Data`. |

Root chats are the list unit. Explicit workers and subagents stay grouped under the root. ASB omits `subagent` and `guardian_review` source rows. Each source has a 5000-record limit. ASB does not discover orphan Codex rollouts outside the database. Archived rows are available but hidden by default.

Codex names prefer `session_index.thread_name`, then the stored title. Claude metadata must have a valid `local_<uuid>` ID to provide an open action. App links are constructed from valid IDs:

- `codex://threads/<uuid>`
- `claude://code/continue?session=local_<uuid>`
- `claude://code/<validated cse_ or session_ ID>`

The source apps must register their URL handlers. ASB does not create chats or run a CLI resume command for its open action.

Remote cache reads accept only production `https://claude.ai/v1/code/sessions` and `/watch` response bodies. HTTP headers, credentials, transcript-event endpoints, and raw account/config fields are not used. Completed cache entries use Chromium stream boundaries; open gzip watches use their partial body and zero-filled reserved tail. ASB selects the newest response and exact cursor-linked continuations, not a union of old login streams. Missing full-list metadata produces a source warning and only observed rows. Cache delay, eviction, and offline periods can limit coverage. No remote request is made. Local bridge aliases deduplicate matching remote rows and stay outside the view payload.

Remote execution requires a response observation within six hours plus explicit worker/session state. Server sync receipt cursors provide observation time; file modification time is a fallback for an approved body write. Bridge sessions also need an explicit connected state. Cloud sessions do not need that bridge field. Unknown, stale, or disconnected records give Unknown. Remote Working has no inferred start time. Folders stay empty; safe Git source names can identify a project. Fresh cached unread marks use the same ASB attention rules as other native marks.

## Execution and attention

Execution uses Working, Waiting, Idle, and Unknown. A root is not Working only because it is unarchived. Open task/request signals require activity within six hours. Source signals can lag or survive a crash; old open signals become Unknown.

Claude Desktop Code and CLI readers include child files under the matched root transcript in the child count. An async Agent launch must link its returned agent ID to that exact root's child file. Recent child request, thinking, and tool events keep the root Working after its own response ends. Child completion, interruption, and error events close that work. Unrelated children cannot change execution. Missing linked lifecycle gives Unknown unless the root has current work. Stale child work cannot set a fresh root's timer start.

Current synchronous questions can block execution in Waiting. Async questions add attention while Working or Idle remains visible. Matching answers, failure, abort, or cancellation resolve the question. Real human input supersedes old questions. Automatic goal continuation, context, and partial answers do not. Question and answer bodies stay outside ASB view payloads.

Pending is separate from execution. It can come from a current user action, question attention, an Idle native unread mark, a newly observed completion, or a manual ASB Unread mark. A native unread dot alone does not make a Working or Unknown chat Pending.

Native Codex unread needs a creator identity and exact local host match. Missing or unmatched metadata gives Unknown read status. Identity fields stay outside the API. Local Claude chats have no reliable native unread source. Their ASB completion mark requires an observed Working-to-Idle change and a new completion. Historical Idle rows do not gain a completion mark on first load. Abort and cancellation do not create completion marks.

Claude completion is held until the root and its linked child work end. The last successful group completion can then add attention. A final interruption or error cannot add completion attention. Child IDs, prompts, and transcript paths stay outside the ASB view.

Read, Unread, pins, and pin order belong only to ASB. A successful open acknowledges ASB attention by default. It does not change execution or answer a question. Failed opens preserve attention. Persistent unread retains attention until Read, even after source Read/resolution or successful opens. It is off by default.

All clients share one tracker. Tracking uses the complete scanned list before filters. `pending.json` contains IDs, marker/acknowledgment values, manual marks, retained sources, pin order, and Persistent unread. It has owner-only access. It contains no chat titles or message bodies.

## Native view contract

- Compact is the default with 22-pixel rows. Comfortable uses 68-pixel rows with the folder first and a two-line title.
- Rows flow down each column, then across. The list scrolls horizontally. Height sets row capacity; shared width sets visible columns.
- ASB pins come first in saved order. Other rows follow Pending, Working, Idle, then Unknown.
- Codex, Claude, and Pending pills share the menu filters. State choices can be combined. Search prefixes temporarily take priority over app selection.
- Typing from a row starts search. Escape clears the query and prefix. Row menus have mouse and keyboard access; pin movement has a keyboard alternative.
- View/width changes preserve filters, search, pins, focus, and the outer frame. Keyboard focus reveals off-screen rows. Ordinary refresh preserves scroll position.
- Dark colors apply only to ASB. Custom colors must pass background and contrast checks. No global GNOME setting changes.
- Working time uses a stable source start (`workingSinceMs`) and a local two-second clock. Idle age labels update once a minute. Label updates do not read sources.
- Provider warnings hide after five seconds. The same warning stays hidden until it changes or clears. Dashboard fetch errors stay visible until a successful refresh.

The application ID is `local.asb.AgentSwitchBoard`. The toolbar uses ASB's own disc icon. Codex and Claude row icons identify the original apps. The installer adds only ASB's launcher and icon. It adds no auto-start entry.

## Refresh and performance limits

Native and web clients poll every two seconds while any unarchived root is Working, otherwise every five seconds. This uses the full list before filters and continues when ASB loses focus. The clean server snapshot has a five-second TTL. With two-second polling, reconciliation can occur on the next tick after about six seconds. Cold scans and source write delay can take longer.

Source watchers send only a version, reason, and provider flags. They send no paths or content. Events are grouped for 250 milliseconds. Active scans start no more than once per two seconds. Missing directories and watch failures retry every five seconds. Older recursive-watch support uses directory watches and periodic discovery. Polling remains the fallback.

Client reads do not overlap and retain at most one requested follow-up. Forced refresh waits for an existing read. Native rows remain keyed by ID and update in place. Layout signals replace permanent frame checks; removed rows disconnect their controllers.

ASB reader mode omits token, quota, artifact, model-service, and governance work. Metadata fingerprints reuse unchanged records. Source events can invalidate caches even when file stats do not change. Codex and Claude signal caches have 5000-entry limits. The Claude directory index has a 32-root limit.

The remote reader keeps at most 32 cache roots, 50,000 classified file names per root, 512 response entries, and 5000 projected session records per root. Six concurrent readers inspect new keys and changed approved bodies. Encoded bodies are limited to 8 MiB and decoded bodies to 16 MiB. Unrelated cache writes do not reread old keys or bodies. Built-in zstd decoding is optional; gzip watch reads work on older supported Node.js versions.

Codex tails start at 64 KiB and grow to 256 KiB. Lifecycle and question recovery can scan full logs with bounded memory and append checkpoints held in memory. Claude transcript tails have an 8 MiB limit and use six concurrent reads. Larger Claude logs recover lifecycle and Agent links with bounded memory and an append checkpoint in the same signal cache. Unchanged child logs use cached signals. Retained history can still make cold reads slow. ASB writes no transcript or work-metric cache.

## API and trust boundary

ASB uses `createAsbServer` from `src/asb-server.mjs`. It allows the view assets, dashboard, source events, known-session open, ASB Read/Unread, pins, pin movement, and Persistent unread settings. Other upstream APIs are not exposed.

Actions require the local Host and a matching Origin. Session IDs must be in the scanned list. Read/Unread and pin/unpin accept an empty JSON object. Persistent unread accepts only a `persistentUnread` boolean. Pin movement accepts `up`/`down`, or a known pinned target with `before`/`after`. The client cannot submit arbitrary commands, paths, or URLs.

## Local writes

| Default location | Purpose |
| --- | --- |
| `~/.local/state/asb/pending.json` | ASB attention, pins, and Persistent unread. |
| `~/.config/asb/layout.json` | Width and view. |
| `~/.config/asb/theme.json` | Custom colors. |
| `~/.local/share/applications/local.asb.AgentSwitchBoard.desktop` | Per-user launcher. |
| `~/.local/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg` | Per-user app icon. |

XDG state/config/data overrides apply. The per-user package also installs ASB under its own local data folder and adds `~/.local/bin/asb`. See the installer for its exact manifest. Original app stores stay read-only.

## Checks and release

```bash
npm test
python3 test/asb_native_logic_test.py
npm run build
```

The first two commands do not launch the ASB window. Native widget tests are separate and need a GTK display with synthetic fixtures. Use them only when UI testing is in scope. Do not use real session stores for public media or test captures.

The source build produces `asb_1.1.1_all.deb`, `asb-1.1.1-linux.tar.gz`, and `SHA256SUMS` in `dist/`. The portable root is `asb-1.1.1/` with `./install.sh`. These are unreleased build names. Public demo assets use synthetic session names and folders. Remotion build dependencies are separate from the ASB runtime.

## Retained upstream

ASB is based on Agent Mission Control `0.6.0` by forxidian. The original MIT license and release history remain. The retained `src/server.mjs` entry is the broader upstream dashboard. `npm start` now launches ASB, not that dashboard.

The upstream path includes OpenCode, Cindy, Cowork, tokens, quota, artifacts, notifications, search, Prompt Pack, and review jobs. It can read login credentials and make quota requests; explicit review jobs can call model CLIs. These behaviors are outside the ASB runtime contract. ASB constructs no review store, search index, or notification center. Its launch path uses the ASB server and reader mode, which disables auth and quota reads.

See [docs/upstream/README.md](docs/upstream/README.md), [upstream privacy](docs/upstream/PRIVACY.md), and the separate upstream section in [CHANGELOG.md](CHANGELOG.md). Do not copy upstream settings or feature claims into the ASB UI without a new design and privacy review.
