# OpenCode 2 sessions in ASB: implementation plan

Status: implemented on branch feat/opencode-sessions; documents updated. Written 2026-10-19 for an implementing
agent (a worker model). The decisions in section 2 come from an interview with
the user. The user approved the planner decisions in section 3 on 2026-10-19.
Do not change any of them without asking the user.

Read this whole file before you start. Do the phases in order. Each phase has
acceptance criteria. Do not start the next phase until all criteria of the
current phase pass. Commit at the end of each phase.

---

## 1. Goal

ASB lists every OpenCode 2 session of this machine as a card, next to the
Codex and Claude cards: title, folder, state (Working, Idle, Unknown), the last
result (Done, Failed, Interrupted), unread, and archive. ASB does not open
OpenCode sessions: an OpenCode card is list-only.

## 2. User decisions (from the interview, do not change)

| Topic | Decision |
| --- | --- |
| Version | OpenCode 2 only: the `session_v2` table. ASB does not read the old v1 tables. |
| Click | List only. The planner checked the OpenCode desktop source twice (section 4.2): the app cannot open one session from outside. No click, no CLI resume. |
| Needs input | Not shown for OpenCode. The planner checked the source twice (section 4.3): OpenCode 2 keeps permission asks and question forms only in memory. |
| Filters | An **OpenCode** app pill next to Codex and Claude, OpenCode in the app filter of Preferences, and the search prefixes `oc:` and `opencode:`. Android gets the same filter and prefixes. |
| Icon | OpenCode's own mark (their MIT-licensed logo) as a gray provider icon, like the Codex and Claude marks. Credit it in `assets/icons/README.md`. |
| Default | A third default source. It is on, and it lists sessions when the OpenCode database exists. The user can turn it off in Profiles. |
| Profiles | The default OpenCode folder only. No extra OpenCode sources. |
| Other machines | OpenCode rows take part in the multi-machine plan (`docs/plans/multi-machine.md`) like other rows, also on Windows engines. |

Out of scope: opening an OpenCode session (from the board, the phone, or a
CLI), Needs input for OpenCode, messages between OpenCode and other agents,
OpenCode usage limits, OpenCode v1 history, extra OpenCode profiles, and any
use of the OpenCode server API.

## 3. Planner decisions (approved by the user on 2026-10-19, do not change)

| # | Decision | Why |
| --- | --- | --- |
| O1 | Read `opencode.db` read-only with SQL, the same way ASB reads the Codex database. Never use the OpenCode server API. | ASB reads local stores only. The server API needs a running server, its port, and its password. |
| O2 | Working: the session holds an execution claim (`time_suspended` is set) and has a message from the last 6 hours. A claim with no message in 6 hours shows **Unknown** (an orphaned claim after a crash or a shutdown). | The claim is OpenCode's own durable "turn in flight" record (section 4.4). The 6-hour window is ASB's existing activity window. |
| O3 | `idle_outcome`: `succeeded` is a completion (Done), `failed` is a failure (Failed), `interrupted` is a stop (the stop square, no attention). | Same meanings as the Codex and Claude rows. |
| O4 | Native unread: `time_idle > (time_viewed or 0)`. A session with no `time_idle` has unknown read state. | This is OpenCode's own unread rule, and both the TUI and the desktop app write `time_viewed` (section 4.4). |
| O5 | The database file is `<data folder>/opencode.db`. ASB does not follow `OPENCODE_DB` or the `opencode-<channel>.db` files of local builds. | Release channels (latest, beta, dev, next, prod) all use `opencode.db`. |
| O6 | Title: `title`, else `slug`. | `title` can be empty in v2. |
| O7 | Only root sessions are cards. Subagent sessions (`parent_id` set) only raise the root's `subagentCount`. | Same as Codex. The root's claim covers the turn. |
| O8 | An OpenCode row has `canOpen: false`. Its tooltip says `OpenCode cannot open one session from a link.` | Clear reason; no dead click. |
| O9 | When `session_v2` or a needed column is missing, the source reports the warning `ASB reads OpenCode 2 sessions only. Update OpenCode.` and lists no rows. | The schema is internal to OpenCode and changes often. |

## 4. Facts about OpenCode 2

All source links point to tag `v2.0.32` (commit
`843a6c514e606b436a7fe713422ace0a93ad3d61`) of
<https://github.com/anomalyco/opencode>, the version that was installed on the
Debian PC when this plan was written. OpenCode is MIT-licensed.

### 4.1 Install and storage

- CLI: `opencode` (for example `~/.local/bin/opencode`). Desktop app: an
  Electron app (Debian package `opencode`, files in `/opt/OpenCode`, desktop
  entry `ai.opencode.desktop.desktop`, handler for `x-scheme-handler/opencode`).
- Both use one data folder: `$XDG_DATA_HOME/opencode`, else
  `~/.local/share/opencode`, on every operating system, also on Windows
  (`packages/util/src/global-roots.ts`).
- The database is `opencode.db` in that folder for release channels
  (`packages/cli/src/database-path.ts`). It uses WAL mode (`opencode.db-wal`,
  `opencode.db-shm`).
- The same folder also holds `auth.json` (credentials). The database also has
  `account`, `control_account`, and `credential` tables with tokens. **Never
  read `auth.json`, and never query any table other than `session_v2`,
  `session_message`, and `sqlite_master`.**

### 4.2 No way to open one session (checked twice)

- The desktop main process acts on only one link:
  `opencode://console/authorized` (`packages/desktop/src/main/lifecycle/deep-link.ts`).
- Every other `opencode://` link brings the window to the front and reaches
  the window as an `opencode:deep-link` event
  (`packages/desktop/src/renderer/startup/deep-links.ts`). No code in
  `packages/app`, `packages/session-ui`, or the desktop renderer listens to it.
- The window start data has only `id`, `firstLaunchPending`, and `packaged`
  (`packages/desktop/src/shared/window-bootstrap.ts`).
- The remote debugging port exists only in development builds
  (`packages/desktop/src/main/lifecycle/configure.ts`).
- The `v2` branch had no commits after `v2.0.32` on 2026-10-19. PR
  [#54153](https://github.com/anomalyco/opencode/pull/54153)
  (`opencode://session/<id>`) was closed without a merge.

### 4.3 No pending asks in the database (checked twice)

- `permission.asked` and `permission.replied` are `ephemeral` events
  (`packages/schema/src/permission.ts`). `form.created`, `form.replied`, and
  `form.cancelled` (the question tool) are also `ephemeral`
  (`packages/schema/src/form.ts`). Ephemeral events are not saved.
- The `permission` table holds only saved "always allow" rules
  (`packages/core/src/permission/sql.ts`).
- Tool calls in saved messages have only the states `streaming`, `running`,
  `completed`, and `error` (`packages/schema/src/session-message.ts`). No state
  means "waiting for permission".

### 4.4 Fields that ASB uses

From `packages/core/src/session/sql.ts`, `store.ts`, and `projector.ts`:

| Column of `session_v2` | Meaning |
| --- | --- |
| `id` | `ses_` plus 26 characters. |
| `parent_id` | Set for a subagent session. |
| `title`, `slug` | The title can be empty; the slug is two words, for example `calm-squid`. |
| `directory` | The working folder. |
| `version` | The OpenCode version that wrote the row. |
| `time_created`, `time_updated` | Milliseconds. Some writes keep `time_updated` unchanged on purpose, so it is not an activity time. |
| `time_suspended` | The execution claim: set when a turn starts, cleared when the turn ends. A claim that survives a crash or a shutdown during a turn stays until the next start resumes it. |
| `time_idle` | Advances at every finished turn, also within one millisecond. |
| `idle_outcome` | `succeeded`, `failed`, or `interrupted`. |
| `time_viewed` | The read mark. Both the TUI and the desktop app write it ("Viewed state is server-global"). |
| `time_archived` | Set for an archived session. |

`session_message` has `session_id`, `type`, `seq`, `time_created`,
`time_updated`, and `data`. Its index
`session_message_session_time_created_id_idx` covers `(session_id,
time_created, id)`. ASB reads only `session_id` and `time_created` from it.
Never read `data`: it holds prompts and answers.

## 5. Facts about ASB

Line numbers are from 2026-10-19 and can move; search for the names. Other
sessions were changing these files on that date (for example
`src/claude-registry.mjs` was new and not committed), so read the current code.

Engine:

- `src/app-sources.mjs`: `PROVIDERS = ['codex', 'claude-desktop-code']`
  (line 9); `defaultSourceColor` (16 to 18); `defaultAppSources` (46 to 53);
  the read path refuses a saved file that lacks a default source (148 to 152,
  `Default app sources must stay registered.`); new source IDs (204);
  `MAX_APP_SOURCES` is 8.
- `src/switchboard.mjs`: `switchboardWatchPaths` (42 to 58);
  `switchboardStatus` (73 to 101: `lifecycleRunning`, `agentActivityAtMs`,
  the 6-hour `ACTIVITY_WINDOW_MS`); `buildSwitchboardDashboard` (153: the
  provider, `providerLabel`, `canOpen`, `lastOutcome`, `failedAtMs`,
  `completionAtMs` rules); `retainSourceCaches` (276 to 284);
  `loadSwitchboardDashboard` (about 285 to 345: one loader per provider);
  `openSwitchboardThread` (about 350); the server's watch and invalidate hooks
  (about 650 to 670).
- `src/codex-data.mjs`: `querySqliteJson(databasePath, sql)` (line 75) opens a
  read-only `node:sqlite` connection, with the `sqlite3 -readonly -json`
  command as the fallback. It is not exported.
- `src/insights.mjs`: thread normalization (`provider` mapping near line 118).
- Stop kinds: `STOPPED_KINDS` in `src/switchboard.mjs` includes `turn_aborted`.

Board (`scripts/asb-native.py`):

- `SOURCE_PROVIDERS` (27) and the Profiles editor provider list (1365, 1419,
  1544).
- Search prefixes (about 188): `cl`/`claude` and `cx`/`codex`; the search
  tooltip text (2070).
- `filter_chips` (496 to 499) names a single app as Codex or Claude.
- The tooltip app label map (596).
- Provider icons are chosen with an inline `codex` test at 2204, 2258, 3538,
  and 3717.
- App pills are made in a loop over `("codex", "Codex"),
  ("claude-desktop-code", "Claude")` (2253 to 2267) and shown or hidden at 2919
  to 2922.

Android (`android/app/src/main/java/local/asb/companion/`):

- `ui/Rules.kt:95`: the search prefix maps to `claude-desktop-code` or `codex`.
- `ui/SessionsScreen.kt:939`: `ProviderMark` picks `ic_provider_openai` for
  `codex`, else `ic_provider_claude`.
- `ui/SessionsScreen.kt:1060`: the app filter list `All`, `Codex`, `Claude`.

## 6. Working rules

- Use the existing patterns. Add no dependency.
- Every new pure function gets a unit test. Keep all current tests green.
- Never write to any OpenCode file. Open the database only read-only.
- Privacy: never read `auth.json`, the `account`, `control_account`,
  `credential`, or `kv` tables, or `session_message.data`. Never log titles or
  folders.
- Commit at the end of each phase with Conventional Commits. Add no AI
  attribution or co-author lines.
- Checks:

```bash
npm test
python3 test/asb_native_logic_test.py
npm run test:native
cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug assembleRelease
```

- If `docs/plans/multi-machine.md` is in progress in the same checkout, both
  plans change `buildSwitchboardDashboard`, the provider and pill code of the
  board, and the Android cards. Rebase on its latest commit before each phase,
  and keep both behaviors.
- Stop and report to the user when the real database does not match
  section 4.4, or when a decision in section 2 or 3 does not work as written.

## 7. Phase 1: engine

### 7.1 Shared read-only query

Export `querySqliteJson` from `src/codex-data.mjs` and import it in the new
reader. Do not copy it.

### 7.2 Reader: `src/opencode-data.mjs`

Export `loadOpenCodeDashboard({ dataDir, nowMs, maxCount = 5000, cacheScope })`
that returns `{ provider, threads }` in the same shape as the Codex and Claude
loaders, and `invalidateOpenCodeData()`.

1. `databasePath = path.join(dataDir, 'opencode.db')`. When it does not exist,
   return `provider.installed = false` (the source shows `missing`, as for the
   other apps).
2. Cache: keep the last result per `cacheScope` with the signature
   `(mtimeMs, size)` of `opencode.db` and `opencode.db-wal`. Reuse the result
   when both are unchanged. `invalidateOpenCodeData()` clears the cache.
3. Schema guard: query `sqlite_master` and the `pragma table_info` of
   `session_v2` and `session_message`. Required columns: section 4.4. When one
   is missing, return the warning of decision O9 and no threads.
4. Root sessions (one query, explicit columns only):

   ```sql
   select id, title, slug, directory, version, time_created, time_updated,
          time_suspended, time_idle, idle_outcome, time_viewed, time_archived
   from session_v2
   where parent_id is null
   order by time_updated desc
   limit <maxCount>
   ```

5. Subagent counts:

   ```sql
   select parent_id, count(*) as n from session_v2
   where parent_id is not null group by parent_id
   ```

6. Last activity of each root, including its subagents (uses the index):

   ```sql
   select coalesce(s.parent_id, s.id) as root, max(m.time_created) as at
   from session_message m join session_v2 s on s.id = m.session_id
   group by root
   ```

   If this query is slow on a large database (more than 200 ms on the Debian
   PC), limit it to roots with `time_suspended is not null`; other roots do not
   need it.
7. Map each root to a thread:

   | Thread field | Value |
   | --- | --- |
   | `id`, `externalId` | `id` |
   | `provider` | `opencode` |
   | `source` | `opencode-db` |
   | `title` | `title`, else `slug` |
   | `cwd` | `directory` |
   | `archived` | `time_archived != null` |
   | `createdAtMs` | `time_created` |
   | `updatedAtMs` | the largest of `time_updated`, `time_idle`, and the last activity |
   | `subagentCount` | from step 5 |
   | `lifecycleRunning` | `time_suspended != null` |
   | `agentStartedAtMs` | `time_suspended` |
   | `agentActivityAtMs` | the last activity from step 6, else `time_suspended` |
   | `latestLifecycleKind` | `task_complete` for `succeeded`, `failed` for `failed`, `turn_aborted` for `interrupted`, else `""` |
   | `latestLifecycleAtMs` | `time_idle` |
   | `latestTaskEndedAtMs` | `time_idle` |
   | `nativeUnread` | `time_idle == null ? null : time_idle > (time_viewed ?? 0)` |
   | `readStatus` | `unknown`, `unread`, or `read` from `nativeUnread` |

8. `switchboardStatus` then gives: claim and recent activity is Working; claim
   with old activity is Unknown ("The last task has no recent signal."); no
   claim is Idle. Check that no other provider-specific branch changes this.

### 7.3 Dashboard rows

In `buildSwitchboardDashboard` (and in `src/insights.mjs` if it maps
providers), handle `provider === 'opencode'`:

- `provider: 'opencode'`, `providerLabel: 'OpenCode'`.
- `canOpen: false`, `appDeepLink: ''`.
- `lastOutcome`, `failedAtMs`, and `completionAtMs` come from the existing
  rules with the lifecycle fields of 7.2.
- `workingSinceMs`: `agentStartedAtMs` while Working.
- If the multi-machine plan has landed: `surface: 'app'`, and the row is
  exported to peers like other local rows.

`openSwitchboardThread` refuses OpenCode rows:
`OpenCode cannot open one session from a link.`

### 7.4 Source registry

In `src/app-sources.mjs`:

1. Add `opencode` to `PROVIDERS` and a default source
   `{ id: 'opencode', provider: 'opencode', label: 'OpenCode',
   dataDir: <XDG_DATA_HOME or ~/.local/share>/opencode, launcher: '',
   enabled: true, builtin: true }` with a default color
   (`defaultSourceColor`).
2. Migration: a saved `sources.json` without the `opencode` source is valid.
   Append the default OpenCode source in memory after the saved sources; the
   next save writes it. A saved file that has an `opencode` source with another
   provider is invalid, as today.
3. Refuse a new source with `provider: 'opencode'`:
   `Only the default OpenCode source is supported.` The default OpenCode source
   can be edited (label, color, dot, enabled) like the other default sources;
   its `dataDir` cannot change, and it takes no launcher.
4. `asb agent sources` and `/api/sources` show it like the others.

### 7.5 Loading, watching, and caches

In `src/switchboard.mjs`:

- `loadSwitchboardDashboard`: call `loadOpenCodeDashboard` for an enabled
  `opencode` source (with `cacheScope` and the source scoping of IDs that the
  other sources use).
- `switchboardWatchPaths`: add `{ path: <opencode data folder>, source:
  'opencode', optional: true, acceptEvent: (filename) => !filename ||
  /^opencode\.db(?:-wal)?$/.test(filename) }`.
- The server's source-changed hook calls `invalidateOpenCodeData()` for
  `opencode`.
- `retainSourceCaches`: keep the OpenCode cache only for enabled sources.

### 7.6 Tests

- `test/opencode-data.test.mjs`: build a temporary database with
  `node:sqlite` that has the `session_v2` and `session_message` columns of
  section 4.4 (plus an `account` table with a fake token). Cover: a running
  claim with recent activity (Working), a claim with old activity (Unknown),
  `succeeded`, `failed`, and `interrupted`, unread and read, no `time_idle`
  (unknown read state), archived, a subagent counted and not listed, the title
  fallback, a missing `session_v2` (warning), a missing column (warning), and a
  WAL change that refreshes the cache. Wrap `querySqliteJson` (or check the SQL
  strings) to prove that no query names `account`, `credential`,
  `control_account`, `kv`, or `data`.
- `test/app-sources.test.mjs`: three default sources; an old file gets the
  OpenCode source; a new OpenCode source is refused; the default OpenCode
  source cannot change its folder.
- `test/switchboard.test.mjs`: OpenCode rows on the dashboard (provider,
  label, `canOpen`, outcomes, unread) and the open refusal.

### Phase 1 acceptance

- Checks pass.
- On the Debian PC (read-only): `GET /api/dashboard` lists the OpenCode root
  sessions with correct titles, folders, states, and outcomes. A running
  OpenCode turn shows Working within 5 s and Idle with the outcome after it
  ends. A finished turn in a session that is not open in OpenCode shows as
  unread; viewing it in OpenCode clears it.

## 8. Phase 2: board and web view

1. Icon: add `assets/icons/asb-opencode-symbolic.svg` (Appendix A). Add its
   credit to `assets/icons/README.md`: OpenCode logo, from
   `packages/ui/src/assets/favicon/favicon.svg` at tag `v2.0.32` of
   anomalyco/opencode, MIT License, Copyright (c) 2025 opencode; ASB changes
   only the crop and the gray fill; brand rights stay with the owner.
2. Add the pure function `provider_icon(provider)`:
   `asb-openai-symbolic`, `asb-claude-symbolic`, or `asb-opencode-symbolic`.
   Use it at the four icon sites (2204, 2258, 3538, 3717).
3. App pills (2253 to 2267): add `("opencode", "OpenCode")`. The rule "no app
   selected or all apps selected shows all" must now cover three apps.
4. Search prefixes (about 188): add `oc` and `opencode` for `opencode`. Update
   the search tooltip (2070):
   `Search title or folder. cl: or claude: selects Claude; cx: or codex: selects Codex; oc: or opencode: selects OpenCode.`
5. `filter_chips` (496 to 499) and the tooltip app label map (596): add
   `OpenCode`.
6. The Preferences > Sessions app filter: add OpenCode.
7. Profiles:
   - Show the OpenCode source in the table as `OpenCode` (1419).
   - `source_form_body` (line 42) refuses every provider outside
     `SOURCE_PROVIDERS`. Let it accept `opencode` only when
     `identity == "opencode"` (an edit of the default source). The provider
     list for a new source stays Codex and Claude (`SOURCE_PROVIDERS`).
   - The editor calls `SOURCE_PROVIDERS.index(...)` (1365), which fails for
     `opencode`. For the OpenCode source, show the app as the fixed text
     `OpenCode` in place of the provider list, and make the folder and
     launcher fields read-only.
   - Test both rules.
8. The row panel button for an OpenCode row: `Open in OpenCode`, insensitive.
   The tooltip flag `No direct link` gets the note
   `OpenCode cannot open one session from a link.`
9. Web view (`public/switchboard.js`): OpenCode rows show `providerLabel` and
   send no open request.
10. Tests in `test/asb_native_logic_test.py`: `provider_icon`, the prefix
    parser (`oc:`, `opencode:`, case, spaces), filter chips with OpenCode, the
    three-app "all" rule, and the tooltip note.

### Phase 2 acceptance

- Checks pass.
- On the Debian PC: OpenCode cards show the OpenCode mark; the OpenCode pill
  and `oc:` select only them; a click does nothing; the tooltip gives the
  reason; Codex and Claude cards and filters work as before.

## 9. Phase 3: Android

1. Add `res/drawable/ic_provider_opencode.xml` from the Appendix A paths
   (`android:viewportWidth="256"`, `android:viewportHeight="320"`,
   `android:fillType="evenOdd"` on the frame path; the inner path at alpha 0.5,
   with `android:fillAlpha="0.5"`).
2. `ui/SessionsScreen.kt:939`: pick the drawable by provider (`codex`,
   `opencode`, else Claude). Put the choice in a small pure function in
   `ui/Rules.kt` and test it.
3. `ui/SessionsScreen.kt:1060`: add `"opencode" to "OpenCode"` to the app
   filter list.
4. `ui/Rules.kt:95`: add the `oc` and `opencode` prefixes.
5. Tests: the prefix parser, the filter list, and the provider icon function.

### Phase 3 acceptance

- `cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug assembleRelease` passes.
- On the phone: OpenCode cards show the OpenCode mark, the OpenCode filter
  works, a tap shows no Open action, and a Done or Failed OpenCode session
  gives the normal notification.

## 10. Phase 4: documents

Update README.md (supported apps), ASB.md (OpenCode cards, limits: no open,
no Needs input), SYSTEM_OVERVIEW.md (sources table row: the OpenCode database
and the exact columns read; the registry's third default source), PRIVACY.md
(what ASB reads and never reads, section 4.1), PRODUCT.md (capabilities),
DESIGN.md (provider marks and pills), `docs/status-mapping.html` (the OpenCode
state mapping of 7.2), and CHANGELOG.md (Unreleased).

## 11. Deviations from the plan

The code differs from this plan in these points. The documents describe the
code.

- The reader also sets `embeddedSubagentCount` to the subagent count. The
  dashboard counts only listed children, and OpenCode subagents are not
  listed, so without this field the count was lost.
- When a saved `sources.json` has the `opencode` source, the registry replaces
  its saved folder with the default folder and its launcher with an empty
  value.
- A saved settings file that already has 8 sources (`MAX_APP_SOURCES`) does
  not gain the OpenCode source.
- `src/dashboard-snapshot.mjs` has no OpenCode file hint. The watcher event
  only marks the snapshot dirty, and the reader cache compares the size and
  time of `opencode.db` and `opencode.db-wal` on each load. The planned
  OpenCode branch in `dashboardSourceChanged` was removed.
- With app pills hidden, every restricted app selection gets an app chip,
  including a pair of apps. The chip names the selected apps, for example
  `Codex, OpenCode`.
- The tooltip note is on the flags line: `No direct link. OpenCode cannot
  open one session from a link.`
- The launcher placeholder of the OpenCode source in Profiles is
  `Not used: OpenCode cannot open one session from a link.`
- The web view (`public/switchboard.js`) also guards `openSession`: it returns
  at once for a row with `canOpen: false`.
- The Android drawable `ic_provider_opencode.xml` is 11.2 x 14 dp, to keep the
  4:5 shape of the view box.
- The reader does not read the `version` column, so the schema check does not
  require it.

## Appendix A: OpenCode mark

`assets/icons/asb-opencode-symbolic.svg` (checked in a browser at 160 px and
14 px on 2026-10-19). The paths come from OpenCode's favicon; the view box
crops the frame.

```xml
<svg width="16" height="16" fill="#a5a5a5" role="img" viewBox="128 96 256 320" xmlns="http://www.w3.org/2000/svg"><title>OpenCode</title><path fill-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"/><path d="M320 224V352H192V224H320Z" opacity=".5"/></svg>
```

If GTK renders the inner block at full strength (the symbolic recoloring
ignores `opacity`), remove the `opacity` attribute and keep the shape.
