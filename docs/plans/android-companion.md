# ASB Android companion: implementation plan

Status: approved plan, not started. Written 2026-10-15 for an implementing agent.
Owner decisions come from an interview with the user. Do not change a decision
in section 2 without asking the user.

Read this whole file before you start. Do the phases in order. Each phase has
acceptance criteria. Do not start the next phase until all criteria of the
current phase pass. Commit at the end of each phase.

---

## 1. Goal

An Android app that shows the same ASB session list as the desktop window, on
the user's phone, and controls ASB from the phone:

- See every session row with its state, attention mark, timer, and drawer/pin
  state, live, the same as the ASB window.
- **Open on PC**: tap a row and ASB opens that chat in Codex or Claude Desktop
  on the Debian PC (the existing `/open` action). This is what "activate a
  session" means. The phone does NOT send prompts, start new chats, or answer
  questions or approvals.
- Every ASB row action: Read, Unread, Pin, Unpin, Move pin earlier/later, Put
  in drawer, Take out of drawer, Discard result, Keep result.
- The ASB setting **Persistent unread** (it is server state, so the phone and
  the PC stay in sync).
- Phone notifications with opencode sounds when a session is done, fails, or
  needs input.
- The phone works also when the ASB window is closed (new headless service).

## 2. Decisions (from the user interview, do not change)

| Topic | Decision |
| --- | --- |
| Activate | Only "Open on PC" (existing open API). No prompt sending. |
| Network | LAN now. Design so that an SSH tunnel can be added later (section 14). |
| Security | HTTPS with a self-signed certificate that the phone pins by SHA-256. Plus one bearer token per paired phone. |
| Pairing | QR code scan. ASB Preferences shows the QR. Manual paste of the pairing link is the fallback. |
| Lifetime | Headless service: a systemd user service runs the ASB server and the phone gateway without the window. The window attaches to it. The service is opt-in. |
| Actions | All ASB row actions and the Persistent unread setting. Drawer, pins, marks sync because they live in ASB's `pending.json`. |
| Notifications | Done, Failed, Needs input. Live while the app is open, plus a WorkManager check every 15 minutes. No Google push server. Sounds from opencode (MIT). |
| Stack | Kotlin + Jetpack Compose, one Gradle module (analysis in section 3). |
| Repo | `android/` folder in the ASB repo. |
| Toolchain | Build on the Debian PC. JDK 21 from apt (Debian 13 has no JDK 17 package), Android command-line tools per user. The phone (REDMI Note 15, Android 16, SDK 36, HyperOS 3, USB adb serial `<serial>`) is the install and test device through `adb`. |

Out of scope (do not build): sending prompts, starting chats, answering
questions/approvals, editing app-source profiles from the phone (a profile
sets a launcher that ASB runs, so remote edits are a code-execution risk),
desktop layout/theme settings, Play Store release, iOS.

## 3. Stack analysis: why Kotlin + Compose is best for an agent

| Criterion | Kotlin + Compose | Flutter | React Native / Expo | PWA from ASB |
| --- | --- | --- | --- | --- |
| Training data and docs | Largest for Android | Large | Large, but fast API churn | Large |
| Compiler catches agent mistakes | Strong static types, null safety | Strong | Weak (JS) or TS setup | Weak |
| CLI build/test loop with no IDE | `./gradlew test assembleDebug` | Needs Flutter SDK + Android SDK | Needs Node + Android SDK + Metro | Yes |
| Background checks (WorkManager) | Native | Plugin | Plugin | No reliable background work |
| Notification channels with custom sounds | Native | Plugin | Plugin | Limited |
| Custom TLS pin (self-signed cert) | 30 lines with OkHttp | Plugin / platform code | Native module needed | Not possible for a self-signed LAN cert |
| QR scan without camera code | Google code scanner, 5 lines | Plugin | Plugin | Camera API code |
| Extra toolchains on this PC | JDK + Android SDK | + Flutter SDK | + Node tooling, Metro | none |

Result: Kotlin + Compose. The PWA fails two hard needs (pinned self-signed TLS
and background notifications). Flutter and React Native add a second toolchain
and plugin layers with no gain for an Android-only app.

Rules for the stack, to keep it simple for an agent:

- One module `app`. No Hilt, no Dagger, no Retrofit, no Room, no Navigation
  library, no RxJava. Screen switching is a Compose `when` on a state value.
- Networking: OkHttp only. JSON: kotlinx.serialization only.
- Storage: one private `SharedPreferences` file.

---

## 4. ASB facts the implementer must know

Read `AGENTS.md`, `SYSTEM_OVERVIEW.md` (sections "API and trust boundary",
"Local writes", "Execution and attention"), and `README.md` first.

- `scripts/asb` finds Node and runs `scripts/asb-desktop.mjs`, or
  `scripts/asb-bridge.mjs` for `asb bridge ...`, or `scripts/asb-package.mjs`
  for `--package`.
- `scripts/asb-desktop.mjs` makes a random `sourceToken`, creates the server
  with `createSwitchboardServer({ sourceToken })` (`src/switchboard.mjs`),
  listens on `127.0.0.1:<PORT or 4629>`, then spawns
  `python3 scripts/asb-native.py http://127.0.0.1:<port>` with env
  `ASB_SOURCE_TOKEN`. When the window exits, it stops the server.
- `src/asb-server.mjs` (`createAsbServer`) is the HTTP server. It checks
  `Host == 127.0.0.1:<port>`. POST actions need `Origin == http://127.0.0.1:<port>`
  and `Sec-Fetch-Site` absent or `same-origin`. App-source changes also need
  header `X-ASB-Source-Token` when a token is set.
- Routes the phone uses (all exist today):
  - `GET /api/dashboard` (optional `?force=1`). Reply has `ETag`. Send
    `If-None-Match` to get `304`.
  - `POST /api/threads/<id>/open` body `{}`. Reply
    `{opened, method, threadId, provider, appDeepLink}` or `{error, detail}`.
  - `POST /api/threads/<id>/mark-read|mark-unread|pin|unpin|discard-result|keep-result|drawer-in|drawer-out`
    body `{}`.
  - `POST /api/threads/<id>/move-pin` body `{"targetId": "<id>", "placement": "before"|"after"}`
    or `{"direction": "up"|"down"}`.
  - `POST /api/settings/unread` body `{"persistentUnread": true|false}`.
- Dashboard top-level keys: `generatedAtMs, performance, persistentUnread,
  pinnedOrder, providers, refreshIntervalMs, summary, threads` (also `messages`
  in current source; ignore it on the phone).
- Thread (row) keys and types:

```text
id str, externalId str, sourceId str, sourceLabel str, sourceNumber int,
sourceCount int, sourceColor str (#rrggbb), sourceShowMarker bool,
provider str ("codex" | "claude-desktop-code"), providerLabel str, title str,
cwd str, projectName str, archived bool, updatedAtMs int, subagentCount int,
state str ("working" | "waiting" | "idle" | "unknown"), reason str,
workingSinceMs int, nativeUnread bool|null, readStatus str,
questionPending bool, actionRequired bool, lastOutcome str ("" | "failed" | "stopped"),
failedAtMs int, completionAtMs int, canOpen bool, appDeepLink str,
discardResult bool, pinIndex int, pinned bool, manualUnread bool,
questionAttention bool, nativeAttention bool, failedAttention bool,
completionAttention bool, retainedUnread bool, retainedUnreadSource str,
drawer bool, unread bool, pending bool, pendingSource str
```

  Parse with `ignoreUnknownKeys = true`, every field with a default, so a new
  server field never breaks the app.
- `refreshIntervalMs` is 2000 while a row is Working, else 5000. Treat any other
  value as 5000.
- The desktop filter, sort, menu, and indicator rules are in
  `scripts/asb-native.py`: `attention_indicator`, `provider_query`,
  `filtered_rows`, `row_menu_actions`, `pin_move_body`. The phone ports these
  exactly (section 10.4). Do not invent other rules.
- Package whitelist: `RUNTIME_FILES` in `scripts/asb-package.mjs`. Every new
  runtime file under `src/` or `scripts/` must be added there.
  `DEBIAN_DEPENDS` is in the same file.
- `test/asb-docs.test.mjs` asserts exact README text (for example the Python
  requirement line). If you change that text, update the test in the same
  commit.
- Do not touch `bridge/`.

## 5. Working rules for the implementer

- Work in a separate git worktree, because another agent session works in the
  main checkout and the main checkout has uncommitted user edits:
  `git -C ~/Documents/ASB worktree add ~/Documents/ASB-android -b feat/android-companion`.
  Do all work in `~/Documents/ASB-android`. Never edit, reset, stash, or
  commit in `~/Documents/ASB`.
- First commit: copy this file to `docs/plans/android-companion.md` in the
  worktree.
- Commits: Conventional Commits 1.0.0, for example `feat(phone): add the phone gateway`.
  No `Co-Authored-By` lines and no AI attribution.
- Do not run `sudo`. Do not accept licenses for the user. When a step needs
  sudo or a license acceptance, stop and ask the user to run the exact command.
- Do not stop or restart the user's running ASB instance (port 4629). For
  manual tests use `PORT=4729`, gateway port `4730`, and temporary
  `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` folders under `/tmp`.
  Stop your test processes by PID, never with `pkill -f`.
- Keep the ASB runtime free of npm dependencies. Use only Node built-ins.
- Do not delegate the task to another agent.
- After each phase run its checks. Report failures with output. Do not mark a
  phase done when a check fails.
- Versions: Android app `versionName "0.1.0"`, `versionCode 1`. Do not change
  the ASB version in `package.json`; put ASB changes under an `Unreleased`
  heading in `CHANGELOG.md`.

---

## 6. Architecture

```text
Phone app (Kotlin)
  | HTTPS, TLS 1.3, cert pinned by SHA-256, header "Authorization: Bearer <token>"
  v
Phone gateway (src/phone-gateway.mjs, node:https)
  listens on <LAN IP>:4630 only when enabled
  checks remote address, bearer token, route allowlist
  | plain HTTP to loopback, sets Host and Origin itself
  v
ASB server (src/asb-server.mjs) on 127.0.0.1:4629, unchanged trust rules
  |
  v
PendingTracker / readers / openThread (xdg-open on the PC)

Host process (one of the two):
  A) scripts/asb-service.mjs run   (systemd user service, no window)
  B) scripts/asb-desktop.mjs       (window launcher, when no service runs)
Window launcher with a running service: attaches, spawns only the window.
```

Main points:

- The loopback server stays loopback-only. The gateway is a second listener,
  off by default, with its own auth, and forwards only allowlisted routes.
- `/api/sources` (profiles) is never reachable from the phone.
- All ASB state is already on the server, so phone and PC are in sync with no
  new sync code.

---

## 7. Phase 1: phone gateway core (Node)

### 7.1 New file `src/phone-gateway.mjs`

Exports:

```js
export const PHONE_API_VERSION = 1;
export const DEFAULT_PHONE_PORT = 4630;
export function phoneSettingsPath(env = process.env) // $XDG_CONFIG_HOME/asb/phone.json or ~/.config/asb/phone.json (empty XDG_CONFIG_HOME = home config, like other ASB files)
export function phoneTlsDir(env = process.env)       // same base, folder asb/phone-tls
export function privateIPv4Addresses(interfaces = os.networkInterfaces()) // [{address, interface}] for RFC1918 IPv4 only, sorted by interface name
export function isAllowedRemote(address)             // true for 127.0.0.1, ::1, 10/8, 172.16/12, 192.168/16, and the same as ::ffff:a.b.c.d
export function createPhoneGateway({ localPort, asbVersion, settingsPath = phoneSettingsPath(), tlsDir = phoneTlsDir(),
  now = Date.now, openssl = 'openssl', hostName = os.hostname(), listAddresses = privateIPv4Addresses })
// listAddresses is a test hook. Production always uses privateIPv4Addresses.
```

`createPhoneGateway` returns an object:

```js
{
  async start(),             // read settings; if enabled, ensure cert, listen
  async stop(),              // close the https server and its connections
  async status(),            // see 7.6
  async updateSettings({ enabled, bindAddress, port }), // validate, save, restart listener, return status()
  async createPairing(),     // returns { uri, expiresAtMs }; needs a running listener
  async revokeDevice(id),    // remove device, save, return status()
}
```

### 7.2 Settings file

Path from `phoneSettingsPath()`. Mode `0600`, parent folder created with
`0700` if missing. Write atomically: write `phone.json.tmp` then `rename`.

```json
{
  "schema": 1,
  "enabled": false,
  "bindAddress": "",
  "port": 4630,
  "devices": [
    { "id": "a1b2c3d4e5f6", "name": "REDMI Note 15", "tokenSha256": "<64 lowercase hex>",
      "createdAtMs": 0, "lastSeenAtMs": 0 }
  ]
}
```

Validation on read: `schema === 1`, `enabled` boolean, `bindAddress` string,
`port` integer 1024..65535, `devices` array (max 8) of objects with exactly the
fields above (`id` 12 lowercase hex, `name` 1..64 chars with no control
characters, `tokenSha256` 64 lowercase hex, times non-negative integers).
Missing file: defaults (`enabled false`, `bindAddress ""`, `port 4630`,
`devices []`). Invalid file: rename it to `phone.json.bad` (replace an older
`.bad`), use defaults, and set `status().warning` to
`ASB moved an invalid phone.json to phone.json.bad.` This copies the
`sources.json` rule.

`lastSeenAtMs`: update in memory on each authenticated request; save to disk
at most once per 10 minutes per device, and on `stop()`.

### 7.3 TLS certificate

Files in `phoneTlsDir()`: `cert.pem` and `key.pem`, mode `0600`, folder `0700`.
Create them only when they are missing (or when one of the two is missing,
create both again). Use `execFile` (no shell) with a 20 s timeout:

```text
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes
  -keyout <tlsDir>/key.pem -out <tlsDir>/cert.pem -days 3650
  -subj "/CN=ASB phone gateway"
```

(Pass every token as a separate argument; `-subj` value is one argument.)
Fingerprint: `new crypto.X509Certificate(certPem).fingerprint256`, then remove
`:` and lowercase. This is the 64-hex pin. If `openssl` fails or is missing,
`start()` and `updateSettings()` keep the listener off and `status().error` is
`ASB cannot create the phone certificate. Install openssl.`

### 7.4 Listener

- `https.createServer({ key, cert, minVersion: 'TLSv1.3' }, handler)`.
- `listen(port, bindAddress)`. Listen only when `enabled` is true AND
  `bindAddress` is in `listAddresses()`. If the address is gone (for
  example Wi-Fi changed), stay off with `status().error`
  `The phone address <a> is not on this PC now. Choose another address.`
- `EADDRINUSE`: stay off, error `Port <p> is in use.`
- Request timeout 15 s (`server.requestTimeout = 15000`), headers timeout 10 s.
- Every reply: `cache-control: no-store`, `x-content-type-options: nosniff`.

### 7.5 Request handling, in this order

1. `isAllowedRemote(request.socket.remoteAddress)` false: destroy the socket.
2. Throttle: per remote address, count auth failures (401) and pair failures in
   a sliding 60 s window. At 20 or more, reply `429 {"error":"Too many failed attempts. Wait one minute."}`
   for 60 s. Keep at most 256 addresses in the map (drop the oldest).
3. Parse URL. Bad URL: `400 {"error":"Invalid request URL."}`.
4. Route table (anything else: `404 {"error":"Route is not available."}`;
   wrong method: `405`):

| Method | Path | Auth | Action |
| --- | --- | --- | --- |
| POST | `/phone/v1/pair` | pairing code | 7.7 |
| GET | `/phone/v1/hello` | bearer | `200 {"api":1,"asbVersion":"<x.y.z>","deviceId":"<id>","serverName":"<hostName>"}` |
| GET | `/phone/v1/dashboard` | bearer | proxy to `GET /api/dashboard`; pass on only the query `force=1` |
| POST | `/phone/v1/threads/<id>/<action>` | bearer | proxy to `POST /api/threads/<id>/<action>`. `<action>` must be one of `open, mark-read, mark-unread, pin, unpin, move-pin, discard-result, keep-result, drawer-in, drawer-out`. `<id>` is the raw path segment, 1..512 chars, no `/` |
| POST | `/phone/v1/settings/unread` | bearer | proxy to `POST /api/settings/unread` |

5. Bearer auth: header `authorization` must be `Bearer <token>`, token 43
   base64url chars. Hash with SHA-256 (hex) and compare to each device
   `tokenSha256` with `crypto.timingSafeEqual` on equal-length buffers.
   No match: `401 {"error":"This phone is not paired with ASB."}`.
6. Request body limit 64 KiB for POST. Over the limit: `413`.

Proxy (`node:http.request`):

```js
{ host: '127.0.0.1', port: localPort, method, path: '/api/...',
  headers: {
    host: `127.0.0.1:${localPort}`,
    ...(method === 'POST' ? { origin: `http://127.0.0.1:${localPort}`, 'content-type': 'application/json' } : {}),
    ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
  } }
```

Do not forward any other request header (no cookies, no authorization). Copy
the reply status and only the headers `content-type`, `etag`, `cache-control`.
Pipe the body. If the loopback request fails, reply
`502 {"error":"ASB is not answering."}`. Timeout 30 s (a forced dashboard scan
can be slow).

### 7.6 `status()` shape (used by the loopback API in phase 2)

```json
{
  "enabled": true, "bindAddress": "192.168.50.4", "port": 4630,
  "addresses": [{ "address": "192.168.50.4", "interface": "enp5s0" }],
  "running": true, "error": "", "warning": "",
  "fingerprint": "<64 hex or empty>",
  "devices": [{ "id": "…", "name": "…", "createdAtMs": 0, "lastSeenAtMs": 0 }],
  "pairing": { "expiresAtMs": 0 }
}
```

Never include tokens, token hashes, or the pairing code in `status()`.

### 7.7 Pairing

`createPairing()`:
- Needs `running === true`, else throw a 400-type error `Turn on phone access first.`
- Code: 20 random bytes, base64url (27 chars). TTL 10 minutes. Only one active
  code; a new call replaces the old one. Single use. Keep a failure counter;
  after 8 wrong codes the active code is void.
- URI (all values URL-encoded with `encodeURIComponent`):
  `asb://pair?v=1&h=<bindAddress>&p=<port>&f=<fingerprint>&c=<code>&n=<hostName>`
- Return `{ uri, expiresAtMs }`.

`POST /phone/v1/pair` body exactly `{"code": "<code>", "deviceName": "<name>"}`:
- Bad JSON or other keys: `400 {"error":"Invalid pairing request."}`.
- No active code, expired, or wrong code (compare with `timingSafeEqual` after
  a length check): `403 {"error":"This pairing code is not valid. Make a new one in ASB."}`
  and count a failure.
- 8 devices already: `409 {"error":"Remove a paired phone in ASB first."}`.
- Success: void the code. Token = 32 random bytes base64url. Device id = 6
  random bytes hex. Name = trimmed `deviceName`, control chars removed, cut to
  64 chars, `Phone` if empty. Save. Reply
  `200 {"deviceId":"…","token":"…","serverName":"…","asbVersion":"…","api":1}`.

### 7.8 Tests: new `test/phone-gateway.test.mjs`

Use `node:test`, temporary folders, a fake loopback ASB server made with
`http.createServer` on port 0 that records requests. Start the gateway with
`bindAddress` `127.0.0.1` for tests (allow this only through an injected
`addresses` function option, for example `listAddresses: () => [{address:'127.0.0.1', interface:'lo'}]`;
production uses `privateIPv4Addresses`). Use `https.request` with
`rejectUnauthorized: false` and check `socket.getPeerCertificate().fingerprint256`
matches `status().fingerprint`. Skip cert tests with `t.skip` when `openssl`
is not on PATH.

Cases (each one a test):
1. Defaults when the settings file is missing; listener off.
2. Invalid settings file moves to `phone.json.bad` and sets the warning.
3. Settings file and TLS files have mode `0600`; folders `0700`.
4. Pairing: success returns a token; second use of the same code gives 403;
   expired code (inject `now`) gives 403; 8 wrong codes void the code.
5. Device limit 8 gives 409.
6. Bearer: missing/wrong token 401; right token 200 on `/phone/v1/hello`.
7. Throttle: 20 failures give 429.
8. Allowlist: `/phone/v1/sources`, `/api/dashboard`, `/phone/v1/threads/x/delete` give 404.
9. Proxy: POST adds `origin` and `host`, strips `authorization`; GET forwards
   `if-none-match` and returns the fake server's `304` and `etag`.
10. `isAllowedRemote` table test, including `::ffff:192.168.50.7` true and
    `8.8.8.8` false.
11. `revokeDevice` makes the old token give 401.
12. `status()` never contains `token`, `tokenSha256`, or the code.

### Phase 1 acceptance

- `npm test` passes (all old tests and the new file).
- `src/phone-gateway.mjs` is in `RUNTIME_FILES`.
- Commit: `feat(phone): add the phone gateway`.

---

## 8. Phase 2: loopback phone API, launcher wiring, Preferences page

### 8.1 Server routes in `src/asb-server.mjs`

Add an option `phoneGateway = null` to `createAsbServer`. When it is set, add
these routes. All of them need the source token (header `X-ASB-Source-Token`)
when the server has one, exactly like `/api/sources` actions, also for the GET.
POST routes also need the normal Host/Origin action checks. Bodies are strict
like the other routes (exact keys, else 400).

| Method | Path | Body | Reply |
| --- | --- | --- | --- |
| GET | `/api/phone` | none | `status()` |
| POST | `/api/phone/settings` | `{"enabled":bool,"bindAddress":str,"port":int}` | `status()` |
| POST | `/api/phone/pairing` | `{}` | `{ uri, expiresAtMs }` |
| POST | `/api/phone/devices/<id>/revoke` | `{}` | `status()` |
| GET | `/api/service` | none | `{"service": true|false, "pid": <n>}` (used in phase 3) |

Validation for settings: `bindAddress` must be in `status().addresses` (or
empty when `enabled` is false); `port` integer 1024..65535 and not equal to the
ASB port. Errors: `400 {"error": "<sentence>"}`.

Pass `phoneGateway` through `createSwitchboardServer` options (it already
spreads `...options` into `createAsbServer`).

### 8.2 Launcher wiring (`scripts/asb-desktop.mjs`)

After the server listens, create the gateway with `localPort: port`,
`asbVersion` from `package.json` (read it with `fs.readFileSync` and
`JSON.parse`), then `await gateway.start()`. Log a start error to stderr, do
not stop ASB. In `stop()`, call `gateway.stop()`. Pass the gateway to
`createSwitchboardServer({ sourceToken, phoneGateway: gateway })` (create the
gateway object before the server; call `start()` after `listen`).

`npm start` (`src/switchboard.mjs` main) does not start a gateway.

### 8.3 Preferences "Phone" page (`scripts/asb-native.py`)

- `PreferencesWindow` builds its sections at line ~1310:
  `for title, content in (("Sessions", sessions), ("Appearance", appearance), ("Profiles", self.profiles))`.
  Add a fourth section `("Phone", self.phone)`.
- New class `PhoneEditor(Gtk.Box)`, modeled on `AppSourcesEditor` (same request
  helpers, same token header, same error label style, load on first visit and
  after explicit actions only, no background timer except while a QR is shown).
- Contents, top to bottom:
  1. `Adw.SwitchRow` "Allow phone access". Subtitle: "Phones on your network
     can see your sessions and use ASB actions after pairing."
  2. `Adw.ComboRow` "Address" from `status().addresses` (label
     `192.168.50.4 (enp5s0)`).
  3. `Adw.SpinRow` "Port" 1024..65535, default 4630.
  4. Button "Apply" → `POST /api/phone/settings`. Show errors in the page.
  5. Status line: `Running at https://<a>:<p>` or the `error` text.
  6. Fingerprint line: the 64 hex in 16 groups of 4, monospace, selectable.
  7. Button "Pair a phone" (insensitive unless running) →
     `POST /api/phone/pairing`, then show the QR and the text
     "Scan with the ASB app. The code works once and ends in 10 minutes."
     While the QR is shown, poll `GET /api/phone` every 3 s. When the device
     count grows, hide the QR and show "Paired: <newest device name>". Stop
     polling at expiry, on page change, and on window hide.
  8. "Paired phones" list: name, "Paired <date>", "Last seen <relative>", and a
     "Remove" button → `POST /api/phone/devices/<id>/revoke`.
- QR rendering: `try: import qrcode` at use time. Build with
  `qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)`,
  `add_data(uri)`, `make(fit=True)`, `get_matrix()` (list of bool rows). Draw in a
  `Gtk.DrawingArea` (240×240) with Cairo: white background, black squares,
  integer module size. Keep the QR black on white also in dark mode.
  If `import qrcode` fails: show the URI in a selectable monospace label with a
  "Copy link" button and the note "Install python3-qrcode to show a QR code."
- Put pure helpers at module level so `test/asb_native_logic_test.py` can test
  them without GTK: `group_fingerprint(hex) -> str`,
  `phone_status_text(status) -> str`, `qr_matrix(uri) -> list[list[bool]] | None`.

### 8.4 Package changes (`scripts/asb-package.mjs`)

- `DEBIAN_DEPENDS`: add `openssl`.
- Add a `Recommends: python3-qrcode` line to the generated `DEBIAN/control`.
- Update the tests that check the control file text, if any
  (`grep -rn "DEBIAN_DEPENDS\|Depends" test/`).

### 8.5 Tests

- `test/switchboard.test.mjs` or a new `test/asb-phone-api.test.mjs`: the five
  routes, the token rule (403 without token when a token is set), Host/Origin
  rule for POST, strict bodies, and that `/api/phone` is 404 when no gateway is
  passed.
- `test/asb_native_logic_test.py`: `group_fingerprint`, `phone_status_text`,
  `qr_matrix` (returns `None` when `qrcode` is missing: patch the import).

### Phase 2 acceptance

- `npm test` and `python3 test/asb_native_logic_test.py` pass.
- Manual: from the worktree run
  `PORT=4729 XDG_CONFIG_HOME=/tmp/asbp/config XDG_STATE_HOME=/tmp/asbp/state node scripts/asb-desktop.mjs`
  only if the user agrees to a second ASB window for a short time (the user
  wants one ASB window at a time; ask first). Otherwise test the routes with
  `curl` against `node -e` code that starts `createSwitchboardServer` plus a
  gateway on port 4729/4730.
- Commit: `feat(phone): add phone access settings and pairing to Preferences`.

---

## 9. Phase 3: headless service

### 9.1 Command

`scripts/asb`: add a branch like the `bridge` one:

```sh
if [ "${1:-}" = service ]; then
  shift
  exec "$ASB_CANDIDATE" "$ASB_ROOT/scripts/asb-service.mjs" "$@"
fi
```

New file `scripts/asb-service.mjs` (add to `RUNTIME_FILES`). Subcommands:

| Command | Effect |
| --- | --- |
| `asb service run` | Run the ASB server and phone gateway with no window, until SIGTERM/SIGINT. |
| `asb service install` | Write the unit, `systemctl --user daemon-reload`, `systemctl --user enable --now asb.service`. Print the result. |
| `asb service uninstall` | `systemctl --user disable --now asb.service`, remove the unit, `daemon-reload`. |
| `asb service status` | Print `systemctl --user is-active asb.service` and whether the runtime file is valid. |
| none / other | Print usage, exit 2, change nothing. |

Use `execFile('systemctl', [...])` with no shell. Linux only; on other
platforms print an error and exit 1.

### 9.2 Unit file

Path: `$XDG_CONFIG_HOME/systemd/user/asb.service` (default
`~/.config/systemd/user/asb.service`). Content (fill the two absolute paths at
install time):

```ini
[Unit]
Description=ASB (Agent Switch Board) server
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
Environment=ASB_NODE=<absolute path of process.execPath>
ExecStart=<absolute path of the asb launcher> service run
Restart=on-failure
RestartSec=5
# Apps that ASB opens must survive a service stop or restart.
KillMode=process

[Install]
WantedBy=graphical-session.target
```

Launcher path: `process.env.ASB_INSTALLED_LAUNCHER` when it is an absolute
executable file (the per-user `~/.local/bin/asb` sets it; check how
`scripts/asb-icon.mjs` uses it), else the absolute path of `scripts/asb` in
this checkout. Reject paths with whitespace, control characters, `%`, or `\`
(systemd unit syntax) with a clear error.

Why each line: `graphical-session.target` gives the service the `DISPLAY` and
D-Bus environment that `xdg-open` needs (checked on this PC:
`systemctl --user show-environment` has `DISPLAY` and
`DBUS_SESSION_BUS_ADDRESS`). `KillMode=process` keeps Codex or Claude Desktop
alive when they were first started by an ASB open and the service stops.

### 9.3 Runtime file and token

`asb service run`:
1. Needs `XDG_RUNTIME_DIR` (absolute, existing). Else exit 1 with a message.
2. Make `$XDG_RUNTIME_DIR/asb/` with `0700`.
3. `sourceToken = randomBytes(32).toString('hex')`.
4. Start `createSwitchboardServer({ sourceToken, phoneGateway })` on
   `127.0.0.1:<PORT or 4629>`, then `gateway.start()`.
5. Write `$XDG_RUNTIME_DIR/asb/service.json` with mode `0600` (atomic write):
   `{"schema":1,"pid":<process.pid>,"port":<port>,"sourceToken":"<hex>"}`.
6. On SIGTERM/SIGINT: delete `service.json` only if it still holds this pid,
   stop the gateway, close the server, exit 0.
7. `GET /api/service` returns `{"service": true, "pid": <pid>}` in this mode
   (pass an option `serviceMode: true` to the server) and
   `{"service": false, ...}` from the window launcher.

### 9.4 Window launcher attach mode (`scripts/asb-desktop.mjs`)

Before `server.listen`:
1. Read `$XDG_RUNTIME_DIR/asb/service.json`. If it is missing or invalid, use
   the current behavior (host the server and the gateway itself).
2. If valid: `GET http://127.0.0.1:<port>/api/service` with header
   `X-ASB-Source-Token: <token>`, 2 s timeout. If the reply is `200` and
   `service === true` and `pid` matches, attach: do not create a server or a
   gateway; spawn the Python window with the service URL and
   `ASB_SOURCE_TOKEN=<token>`; when the window exits, exit with its code. Do
   not stop the service.
3. Any other result: current behavior (a port conflict is still an error).

Icon registration stays the same in both modes.

### 9.5 Tests: new `test/asb-service.test.mjs`

Follow `test/asb-desktop.test.mjs` (isolated HOME/XDG folders,
`ASB_SYSTEM_INSTALL=1`, `ASB_PYTHON=/bin/true`). Do not call the real
`systemctl`: inject a fake runner or put a fake `systemctl` script first on
`PATH` that records its arguments.

1. Unit text: has absolute `ExecStart`, `KillMode=process`,
   `WantedBy=graphical-session.target`, `Environment=ASB_NODE=`.
2. Bad launcher path (with a space) is rejected and nothing is written.
3. `install` calls `daemon-reload` then `enable --now asb.service`.
4. `uninstall` calls `disable --now`, removes the file, calls `daemon-reload`.
5. `run` writes `service.json` with `0600`, folder `0700`, and removes it on
   SIGTERM.
6. Desktop launcher attaches to a running `run` process (same temp
   `XDG_RUNTIME_DIR`, `PORT` set to a free port): it starts no second server
   and the service still answers after the launcher exits.
7. Desktop launcher with a stale `service.json` (dead pid) hosts normally.

### Phase 3 acceptance

- `npm test` passes.
- Manual, only with the user's consent because it touches the real session:
  `scripts/asb service install` from the worktree is NOT done in this phase.
  Real install happens in phase 8.
- Commit: `feat(service): add an optional headless ASB user service`.

---

## 10. Phases 4 to 7: Android app

### 10.1 Phase 4: toolchain and empty project

Toolchain (ask the user to run the sudo and license lines; you run the rest):

```bash
sudo apt install openjdk-21-jdk-headless
```

```bash
mkdir -p ~/Android/Sdk/cmdline-tools /tmp/asb-android-dl
curl -fL -o /tmp/asb-android-dl/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip -q /tmp/asb-android-dl/cmdline-tools.zip -d /tmp/asb-android-dl
mv /tmp/asb-android-dl/cmdline-tools ~/Android/Sdk/cmdline-tools/latest
```

User accepts the SDK licenses (this is a license acceptance; the user runs it):

```bash
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root="$HOME/Android/Sdk" --licenses
```

Then:

```bash
~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root="$HOME/Android/Sdk" "platforms;android-36" "build-tools;36.0.0"
```

Use the existing `/usr/local/bin/adb` (34.0.5); do not install platform-tools.

Gradle wrapper (one time):

```bash
curl -fL -o /tmp/asb-android-dl/gradle.zip https://services.gradle.org/distributions/gradle-8.14.3-bin.zip
curl -fL -o /tmp/asb-android-dl/gradle.zip.sha256 https://services.gradle.org/distributions/gradle-8.14.3-bin.zip.sha256
echo "$(cat /tmp/asb-android-dl/gradle.zip.sha256)  /tmp/asb-android-dl/gradle.zip" | sha256sum -c -
unzip -q /tmp/asb-android-dl/gradle.zip -d ~/Android
```

Create the project files below, then in `android/` run
`~/Android/gradle-8.14.3/bin/gradle wrapper --gradle-version 8.14.3 --distribution-type bin`
and add `distributionSha256Sum=<the sha256>` to
`android/gradle/wrapper/gradle-wrapper.properties`. Commit `gradlew`,
`gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, and the properties file.

`android/local.properties` (not committed): `sdk.dir=/home/<user>/Android/Sdk`.

Root `.gitignore`: add `android/.gradle/`, `android/.kotlin/`,
`android/local.properties`, `android/captures/`. (`build/` is already ignored.)

Versions (`android/gradle/libs.versions.toml`). These are stable and older than
two weeks. If one does not resolve, use the newest stable patch of the same
minor and write the change in `android/README.md`.

```toml
[versions]
agp = "8.11.1"
kotlin = "2.2.0"
composeBom = "2025.07.00"
activityCompose = "1.10.1"
lifecycle = "2.9.2"
work = "2.10.2"
okhttp = "4.12.0"
serialization = "1.9.0"
coroutines = "1.10.2"
codeScanner = "16.1.0"
junit = "4.13.2"

[libraries]
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
compose-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
compose-material-icons = { group = "androidx.compose.material", name = "material-icons-core" }
activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
lifecycle-runtime-compose = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
lifecycle-viewmodel-compose = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }
work-runtime = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "work" }
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
okhttp-mockwebserver = { group = "com.squareup.okhttp3", name = "mockwebserver", version.ref = "okhttp" }
okhttp-tls = { group = "com.squareup.okhttp3", name = "okhttp-tls", version.ref = "okhttp" }
serialization-json = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "serialization" }
coroutines-android = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-android", version.ref = "coroutines" }
coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutines" }
code-scanner = { group = "com.google.android.gms", name = "play-services-code-scanner", version.ref = "codeScanner" }
junit = { group = "junit", name = "junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
```

`app/build.gradle.kts` essentials:

```kotlin
android {
    namespace = "local.asb.companion"
    compileSdk = 36
    defaultConfig {
        applicationId = "local.asb.companion"
        minSdk = 29          // TLS 1.3 is on by default from Android 10
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { compose = true }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
// Do not use jvmToolchain(17): only JDK 21 is installed and toolchain download is off. JDK 21 compiles to target 17.
```

Phase 4 acceptance: `cd android && ./gradlew --no-daemon assembleDebug` builds
an app with one "ASB" text screen; `adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk`
works; `adb -s <serial> shell am start -n local.asb.companion/.MainActivity`
shows it. Commit: `build(android): add the Android project skeleton`.

### 10.2 File layout (create these, nothing more)

```text
android/
  README.md
  settings.gradle.kts, build.gradle.kts, gradle.properties
  gradle/libs.versions.toml, gradle/wrapper/*, gradlew, gradlew.bat
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/java/local/asb/companion/
    AsbApp.kt                  Application: creates notification channels, schedules the worker
    MainActivity.kt            Compose host, screen switch, notification permission request
    data/Models.kt             @Serializable Dashboard, Thread, Provider, Hello, PairReply, ErrorReply
    data/Pairing.kt            parsePairingUri(), PairingInfo
    data/Store.kt              SharedPreferences wrapper
    net/PinnedClient.kt        OkHttpClient with the SHA-256 pin
    net/AsbApi.kt              hello, pair, dashboard (ETag), action, setPersistentUnread
    ui/Rules.kt                pure ports of the desktop rules (10.4)
    ui/Format.kt               timer and age text
    ui/SessionsViewModel.kt
    ui/Theme.kt
    ui/PairScreen.kt, ui/SessionsScreen.kt, ui/SettingsScreen.kt
    notify/Events.kt           pure attention diff (10.6)
    notify/Notifier.kt         channels and posting
    notify/CheckWorker.kt      WorkManager worker
    notify/ActionReceiver.kt   notification buttons
  app/src/main/res/raw/opencode_staplebops_01.mp3, opencode_staplebops_02.mp3, opencode_nope_03.mp3
  app/src/main/res/drawable/ic_stat_asb.xml      monochrome vector from public/icon.svg
  app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml (+ foreground vector)
  app/src/main/res/xml/data_extraction_rules.xml, backup_rules.xml (exclude everything)
  app/src/main/res/values/strings.xml, themes.xml
  app/src/main/assets/licenses/opencode-LICENSE.txt, asb-LICENSE.txt
  app/src/test/java/local/asb/companion/
    PairingTest.kt, RulesTest.kt, FormatTest.kt, EventsTest.kt, AsbApiTest.kt
```

### 10.3 Phase 5: networking and pairing

Manifest:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<application android:name=".AsbApp" android:allowBackup="false"
    android:dataExtractionRules="@xml/data_extraction_rules"
    android:fullBackupContent="@xml/backup_rules"
    android:usesCleartextTraffic="false" ...>
  <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui"/>
  <activity android:name=".MainActivity" android:exported="true"> MAIN/LAUNCHER </activity>
  <receiver android:name=".notify.ActionReceiver" android:exported="false"/>
</application>
```

No CAMERA permission (the Google code scanner does not need it).

`Pairing.kt`:

```kotlin
data class PairingInfo(val host: String, val port: Int, val fingerprint: String, val code: String, val serverName: String)
fun parsePairingUri(text: String): PairingInfo?   // null on any error
```

Rules: scheme `asb`, host `pair`, `v == "1"`, `h` is a dotted IPv4 (four 0..255
parts), `p` int 1..65535, `f` 64 lowercase hex, `c` 27 base64url chars,
`n` any (empty allowed). Use `android.net.Uri` only in the UI; implement the
parser with `java.net.URI` + manual query split so unit tests run on the JVM.

`Store.kt` (one `SharedPreferences` named `asb`, `MODE_PRIVATE`):
`host, port, fingerprint, token, deviceId, serverName, etag` (not saved; keep
etag in memory), `baseline` (JSON string, 10.6), `notifyDone`, `notifyFailed`,
`notifyInput` (default true), `revoked` (bool). `clear()` for unpair.

`PinnedClient.kt` (exact behavior):

```kotlin
fun pinnedClient(fingerprintHex: String): OkHttpClient {
    val trust = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            throw CertificateException("Client certificates are not used")
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            if (chain.isEmpty() || sha256Hex(chain[0].encoded) != fingerprintHex)
                throw CertificateException("ASB certificate does not match the paired PC")
        }
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    return OkHttpClient.Builder()
        .sslSocketFactory(ssl.socketFactory, trust)
        .hostnameVerifier { _, session ->
            val cert = session.peerCertificates.firstOrNull() as? X509Certificate
            cert != null && sha256Hex(cert.encoded) == fingerprintHex
        }
        .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS).tlsVersions(TlsVersion.TLS_1_3).build()))
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .build()
}
```

The pin is the only trust. Never add a "trust all" path.

`AsbApi.kt` (suspend functions on `Dispatchers.IO`, base URL
`https://<host>:<port>`):

| Function | Request | Result |
| --- | --- | --- |
| `pair(info, deviceName)` | POST `/phone/v1/pair` `{"code","deviceName"}` (no bearer) | `PairReply` |
| `hello()` | GET `/phone/v1/hello` | `Hello` |
| `dashboard(etag, force)` | GET `/phone/v1/dashboard[?force=1]`, `If-None-Match` | `Fetched(dashboard, etag)` or `NotModified` |
| `action(id, action, body = "{}")` | POST `/phone/v1/threads/<urlencoded id>/<action>` | raw JSON object |
| `setPersistentUnread(value)` | POST `/phone/v1/settings/unread` | Unit |

Errors: map to a sealed `AsbError`: `Offline` (IOException, timeout),
`NotPaired` (401), `Throttled` (429), `Server(message)` (any other non-2xx;
message = JSON `error`, plus `detail` when present), `PinMismatch`
(SSLPeerUnverifiedException or CertificateException in the cause chain). On
`NotPaired` set `revoked = true` in the store.

Device name for pairing: `Build.MANUFACTURER + " " + Build.MODEL`, or
`Settings.Global.DEVICE_NAME` when not empty.

`PairScreen` (shown when the store has no token):
- Text: "Pair with ASB. On the PC open ASB Preferences > Phone, turn on phone
  access, and select Pair a phone."
- Button "Scan QR code": `GmsBarcodeScanning.getClient(activity,
  GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()).startScan()`.
  Success → `parsePairingUri(rawValue)`.
- Field "Or paste the pairing link" + button "Pair".
- Invalid link: "This is not an ASB pairing code."
- Before the request, show "PC: <serverName> at <host>:<port>" and
  "Certificate: <first 4 groups of the fingerprint>…" (so the user can compare
  with the PC page).
- On success save host, port, fingerprint, token, deviceId, serverName; call
  `hello()`; go to the sessions screen. Show `Server(message)` texts as they are.

Tests (`AsbApiTest.kt`, JVM): use `okhttp-tls` `HeldCertificate` +
`HandshakeCertificates` with `MockWebServer.useHttps(...)`. Check: matching pin
connects; another certificate gives `PinMismatch`; 401 gives `NotPaired`;
304 gives `NotModified`; bearer header is sent; pair sends no bearer.
`PairingTest.kt`: valid URI, each invalid field, encoded server name.

Phase 5 acceptance: unit tests pass; on the real phone, pairing with a test
gateway on the PC works (needs phase 2 on port 4730 with temp XDG folders), and
`hello` works. Commit: `feat(android): pair with ASB over pinned TLS`.

### 10.4 Phase 6: sessions screen and actions

`Rules.kt` ports these Python functions from `scripts/asb-native.py` exactly.
Keep the same names in camelCase and add a comment `// Port of <python name>`
on each.

```kotlin
val STATES = listOf("working", "waiting", "idle", "unknown")

fun attentionIndicator(row: Thread, drawer: Boolean = false): String =
    when {
        row.actionRequired || row.questionAttention -> "question"
        row.unread || (drawer && row.drawer && row.state != "working") -> "dot"
        row.state == "working" && row.discardResult -> "discard"
        row.state == "idle" && row.lastOutcome == "stopped" -> "stop"
        else -> ""
    }

// returns (query casefolded and trimmed, app)
fun providerQuery(query: String, app: String = "all"): Pair<String, String>
// regex ^\s*(cl|claude|cx|codex)\s*:\s*(.*)$ ignore case, DOTALL;
// cl/claude -> "claude-desktop-code", cx/codex -> "codex"

data class Filter(
    val query: String = "", val app: String = "all",          // "all" | "codex" | "claude-desktop-code"
    val states: Set<String> = STATES.toSet(),
    val archived: Boolean = false, val pendingOnly: Boolean = false, val drawerOnly: Boolean = false)

fun filteredRows(threads: List<Thread>, f: Filter): List<Thread>
```

`filteredRows` rules (same as `filtered_rows`):
1. `(q, app) = providerQuery(f.query, f.app)`.
2. `workingOrUnread = f.pendingOnly && f.states == setOf("working")`.
3. Keep a row when all are true:
   - `f.archived || !row.archived`
   - `!f.drawerOnly || row.drawer`
   - `app == "all" || row.provider == app`
   - if `workingOrUnread`: `row.state == "working" || row.pending || row.unread || row.questionAttention`;
     else `row.state in f.states && (!f.pendingOnly || row.pending)`
   - `q.isEmpty()` or `q` is in the lowercase join with `\n` of
     `title, projectName, cwd, providerLabel, sourceLabel`.
     (Python `casefold`: use `lowercase(Locale.ROOT)`.)
4. Sort key: pinned rows first by `(pinIndex, id)`; then others by
   `(bucket, state != "working", -moment, id)` where
   `bucket = 0 if pending or state == "waiting" else {working:1, idle:2, unknown:3}`
   and `moment = updatedAtMs` when not working, else `workingSinceMs` if > 0
   else 0. Compare ids with plain string order.

```kotlin
data class MenuAction(val label: String, val action: String)
fun rowMenuActions(row: Thread): List<MenuAction>
```

Same as `row_menu_actions`: if not `actionRequired`, first `Read`/`mark-read`
when `drawer || indicator in (question, dot)`, else `Unread`/`mark-unread`.
Then `Take out of drawer`/`drawer-out` if `drawer`, else `Put in drawer`/`drawer-in`
if indicator is `dot`. Then `Unpin`/`unpin` or `Pin`/`pin`. If pinned add
`Move pin earlier`/`pin-up` and `Move pin later`/`pin-down`. If
`state == "working"` add `Keep result`/`keep-result` when `discardResult`,
else `Discard result`/`discard-result`. The phone puts `Open on PC`/`open`
first in the sheet when `row.canOpen`.

```kotlin
fun pinMoveBody(visibleRows: List<Thread>, id: String, direction: String): String?  // JSON or null
```

Same as `pin_move_body`: pinned ids of the visible list; neighbor before
(`up`) or after (`down`); body `{"targetId":"<n>","placement":"before"|"after"}`;
null at the end (then send nothing and show "Already first"/"Already last").
`pin-up`/`pin-down` send `POST move-pin` with that body.

Pill rules (same as the desktop toolbar):
- **Pending** pill toggles `pendingOnly`. Turning it on turns `drawerOnly` off.
- **Drawer** pill toggles `drawerOnly`. Turning it on turns `pendingOnly` off.
  Show a small dot on the pill when any row has `drawer == true` and passes the
  archive setting.
- **Working** pill is on only when `states == {"working"}`. Tap on: set
  `states = {"working"}`. Tap off: set `states = all`.
- Filter sheet (button "Filters"): App (All / Codex / Claude), state
  checkboxes, "Include archived". Empty state selection shows no rows.
- In the drawer view call `attentionIndicator(row, drawer = true)`.

`Format.kt`:
- Working timer from `workingSinceMs` (only when > 0): under 1 h `"12m 05s"`
  (under 1 min `"45s"`); else `"1h 12m"`. Update every 2 s while any visible
  row is Working.
- Idle age from `updatedAtMs`: `"now"` (< 1 min), `"5m"`, `"3h"`, `"2d"`.
  Update once a minute.
- State labels: Working, Waiting, Idle, Unknown.

`SessionsViewModel`:
- `StateFlow` of `UiState(dashboard, filter, offline, banner, busyIds, lastError)`.
- Refresh loop runs only while the screen is at least STARTED
  (`repeatOnLifecycle(Lifecycle.State.STARTED)` in the screen, calling a
  suspend `poll()` loop in the ViewModel):
  `dashboard(etag)`; on success store dashboard + etag; on `NotModified` keep
  it; wait `refreshIntervalMs` (2000 or 5000, else 5000). On `Offline` set
  `offline = true`, wait 5 s, then 10 s, then 30 s (max). Reset backoff on
  success.
- Pull-to-refresh and the toolbar Refresh button call `dashboard(null, force = true)`.
- Actions: add the id to `busyIds`, call the API, remove it, then clear the
  etag and refresh once. On error show a snackbar with the message. While an
  id is busy, ignore taps on that row.
- After each successful dashboard, update the notification baseline with
  `Events.update` and do NOT post notifications (the user is looking).

`SessionsScreen` layout (Material 3, `Scaffold`):
- Top bar: title "ASB", subtitle `<serverName>` + `· Live` or `· Offline`;
  actions Refresh, Settings.
- Search `OutlinedTextField` with hint "Search, or cl: / cx:".
- Chip row: Pending, Working, Drawer, Filters.
- Provider warnings: for each `providers[]` with `status == "warning"` show its
  `message` in a dismissible banner (dismiss hides the same text until it
  changes).
- `LazyColumn` with `key = id`. Row:
  - leading 32 dp circle with "cx" (codex) or "cl" (claude); when
    `sourceShowMarker && sourceCount > 1`, a 8 dp dot in `sourceColor` at the
    lower left.
  - title (max 2 lines, ellipsis), second line
    `projectName · <State> · <timer or age>`, small pin icon when pinned.
  - trailing indicator: question → "?" in the accent color; dot → 8 dp filled
    circle; discard → 10 dp hollow ring; stop → 8 dp muted square.
  - content description: title, state, indicator meaning, "pinned", "in the
    drawer". Do not use color alone.
  - tap → `open` if `canOpen`, else snackbar "This session has no direct link."
    While busy show "Opening…" in place of the second line. On success snackbar
    "Opened on <serverName>".
  - long press → `ModalBottomSheet` with `rowMenuActions` (plus Open on PC).
- Empty: no threads at all → "No sessions found on the PC."; threads but no
  match → "No sessions match the search and filters."
- `revoked == true` → full-screen message "This phone was removed from ASB.
  Pair again." with a button to the pair screen (clears the store).

Tests: `RulesTest.kt` with fixtures that mirror the Python cases in
`test/asb_native_logic_test.py` for `filtered_rows`, `row_menu_actions`,
`pin_move_body`, `attention_indicator` (read that file and copy its cases);
`FormatTest.kt`.

Phase 6 acceptance: unit tests pass; on the phone against the test gateway
(temp state folder), each action changes the row as on the desktop, Open on PC
opens the chat on the PC (ask the user to watch the PC screen), filters match
the desktop for the same data. Commit: `feat(android): add the session list and ASB actions`.

### 10.5 Phase 7: settings, notifications, sounds, background check

Sounds: download from opencode (MIT), commit
`fe87944b6ae85422db64c751b6d6ee488b0d7f1c`, folder
`packages/ui/src/assets/audio/`:

| opencode file | App file (`res/raw/`) | Use (opencode desktop default) |
| --- | --- | --- |
| `staplebops-01.mp3` | `opencode_staplebops_01.mp3` | Done (opencode "agent" sound) |
| `staplebops-02.mp3` | `opencode_staplebops_02.mp3` | Needs input (opencode "permissions" sound) |
| `nope-03.mp3` | `opencode_nope_03.mp3` | Failed (opencode "errors" sound) |

Download URL form:
`https://raw.githubusercontent.com/anomalyco/opencode/fe87944b6ae85422db64c751b6d6ee488b0d7f1c/packages/ui/src/assets/audio/staplebops-01.mp3`.
Also save `https://raw.githubusercontent.com/anomalyco/opencode/fe87944b6ae85422db64c751b6d6ee488b0d7f1c/LICENSE`
as `assets/licenses/opencode-LICENSE.txt`. Write the source, commit, and
license in `android/README.md` under "Third-party assets".

Channels (create in `AsbApp.onCreate`; ids are fixed, never rename them):

| Channel id | Name | Importance | Sound |
| --- | --- | --- | --- |
| `asb_done` | Done | DEFAULT | `android.resource://local.asb.companion/raw/opencode_staplebops_01` |
| `asb_input` | Needs input | HIGH | `.../raw/opencode_staplebops_02` |
| `asb_failed` | Failed | DEFAULT | `.../raw/opencode_nope_03` |
| `asb_status` | Connection | LOW | none |

Set sound with `AudioAttributes.USAGE_NOTIFICATION` +
`CONTENT_TYPE_SONIFICATION`. The user changes sounds in Android channel
settings; the app has no sound picker.

`Events.kt` (pure, unit-tested):

```kotlin
const val BIT_DONE = 1; const val BIT_FAILED = 2; const val BIT_INPUT = 4
fun bits(row: Thread): Int  // 0 for archived rows; DONE if completionAttention; FAILED if failedAttention; INPUT if questionAttention || actionRequired
data class Event(val row: Thread, val kind: Int)   // kind is one bit
fun diff(baseline: Map<String, Int>?, threads: List<Thread>): List<Event>
fun update(threads: List<Thread>): Map<String, Int>  // id -> bits for current rows only
```

`diff` rules: baseline null (first run after pairing) → no events. For each
row: `new = bits(row) and old.inv()` where `old = baseline[id] ?: 0`. One event
per set bit in `new`. A new row with bits set gives events. Order: INPUT,
FAILED, DONE.

Posting (`Notifier.post(events)`):
- Skip a kind when its switch (`notifyDone`/`notifyFailed`/`notifyInput`) is off.
- Notification id: `(row.id + ":" + kind).hashCode()`.
- Title: Done → "Done", Failed → "Failed", Input → "Waiting for approval" when
  `actionRequired`, else "Needs your answer". Text: `title` or `projectName`.
  Sub text: `sourceLabel`.
- `setVisibility(VISIBILITY_PRIVATE)` with a public version: title "ASB", text
  "A session needs attention".
- Small icon `ic_stat_asb`. Tap → `MainActivity`. Auto cancel.
- Actions: "Open on PC" (only when `canOpen`) and "Read" (only when the row
  menu would show Read), each a `PendingIntent.getBroadcast` to
  `ActionReceiver` with extras `id`, `action`, `notificationId`,
  `FLAG_IMMUTABLE`.
- Group all with group key `asb` and one summary notification when 2 or more
  are shown.
- No notification when `POST_NOTIFICATIONS` is not granted.

`ActionReceiver`: `goAsync()`, run the API call on a coroutine with a 10 s
timeout, cancel the notification on success; on failure replace its text with
"Could not reach ASB." and keep it. Then `finish()`.

`CheckWorker` (`CoroutineWorker`):
- Not paired or revoked → `Result.success()`.
- `dashboard(null, false)` → `diff(baseline, threads)` → post → save
  `update(threads)` → `Result.success()`.
- `Offline` → `Result.success()` (no retry storm; the next period tries again).
- `NotPaired` → set revoked, post one `asb_status` notification "This phone was
  removed from ASB. Open the app to pair again." once.
- Schedule in `AsbApp.onCreate`:
  `PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)` with
  `Constraints(requiredNetworkType = NetworkType.CONNECTED)`,
  `enqueueUniquePeriodicWork("asb-check", ExistingPeriodicWorkPolicy.KEEP, ...)`.

Foreground rule: while `MainActivity` is resumed, the ViewModel updates the
baseline and posts nothing. The worker posts only when the app is not resumed
(check `ProcessLifecycleOwner` is not needed: keep a `@Volatile var resumed`
in `AsbApp` set from `MainActivity.onResume/onPause`).

`SettingsScreen`:
- Connection: server name, `host:port`, fingerprint in groups of 4, status
  from `hello()`. Button "Unpair this phone" → confirm dialog → clear store →
  pair screen. Text: "Also remove this phone in ASB Preferences > Phone."
- ASB: switch "Persistent unread" bound to `dashboard.persistentUnread`;
  change calls `setPersistentUnread` and refreshes. Explain: "Keep unread marks
  until you select Read. This is the same setting as on the PC."
- Notifications: three switches (Done, Failed, Needs input); button
  "Notification sound and style" → `Settings.ACTION_APP_NOTIFICATION_SETTINGS`;
  if permission is missing, button "Allow notifications".
- Background: button "Check now" → `OneTimeWorkRequest<CheckWorker>`. Card:
  "HyperOS can stop background checks. In app info set Battery saver to No
  restrictions and turn on Autostart." Button → `Settings.ACTION_APPLICATION_DETAILS_SETTINGS`
  with `package:local.asb.companion`.
- About: app version, "Sounds: opencode (MIT)", "ASB (MIT)", open the license
  texts from assets in a simple scrollable dialog.

`MainActivity`: on first start on Android 13+, request `POST_NOTIFICATIONS`
with `rememberLauncherForActivityResult(RequestPermission())` after pairing.

Theme: Material 3, `darkColorScheme()` when the system is dark, else
`lightColorScheme()`. No dynamic color. Edge-to-edge with `enableEdgeToEdge()`
and `Scaffold` insets.

Tests: `EventsTest.kt` (first run no events; each bit; new row; archived row
ignored; drawer-in does not fire; read then new completion fires again).

Phase 7 acceptance: unit tests and `./gradlew lint` pass with no errors;
on the phone: lock the screen, make a short Codex or Claude task finish on the
PC (ask the user), press "Check now" first to verify the path, then wait for a
periodic run or use
`adb -s <serial> shell cmd jobscheduler run -f local.asb.companion <job id>`
(get the id from `adb shell dumpsys jobscheduler | grep -A3 local.asb.companion`).
The notification shows with the opencode sound; "Open on PC" opens the chat on
the PC; "Read" clears the mark on the PC. Commit:
`feat(android): add notifications, settings, and background checks`.

---

## 11. Phase 8: docs, real install, end-to-end check

Docs (update in the same commit; keep STE style of the existing files):

- `AGENTS.md`: Product Context: the main server binds only `127.0.0.1`; the
  optional phone gateway (off by default) binds one chosen private address with
  pinned TLS and paired tokens; ASB has an optional user service. Notification
  stance: the desktop has none; the Android app has phone notifications.
- `README.md`: requirements add `openssl`, optional `python3-qrcode`; a short
  "Android companion" section (what it does, how to pair, link to
  `android/README.md`); a "Run without the window" section for
  `asb service install`. Update `test/asb-docs.test.mjs` if an asserted line
  changes.
- `ASB.md`: Preferences > Phone, service commands, ports 4629/4630.
- `SYSTEM_OVERVIEW.md`: runtime path (service and attach mode), main files
  table (new files), API and trust boundary (gateway, phone routes, loopback
  phone routes), local writes (`phone.json`, `phone-tls/`, `service.json`,
  `asb.service`), checks (Android build).
- `docs/PRIVACY.md`: what the phone receives (titles, folders, states), that
  traffic stays on the LAN with TLS, tokens stored hashed on the PC and in app
  private storage on the phone, no cloud service.
- `PRODUCT.md`: Capabilities line "ASB has no ... notifications" → the desktop
  has none; the Android app has notifications.
- `CHANGELOG.md`: `## Unreleased` with Added: phone gateway, Preferences >
  Phone, `asb service`, Android app 0.1.0.
- `android/README.md`: toolchain, build, install, test commands, versions,
  third-party assets, known limits (section 13).

Real install (ask the user before each step; it changes their running setup):
1. User closes the ASB window.
2. Merge is not needed for a test: from the worktree run
   `scripts/asb service install`. Check `systemctl --user status asb.service`.
   The unit then points to the worktree. After the user merges and installs a
   new ASB package, `asb service install` must run again to point to it.
3. Open the ASB window from the worktree (`scripts/asb`): it must attach (no
   port error).
4. Preferences > Phone: enable on `192.168.50.4`, port 4630, pair the phone.
5. End-to-end checklist below.
6. Ask the user whether to keep the service, or `scripts/asb service uninstall`
   and restart their installed ASB.

End-to-end checklist (all must pass on the REDMI Note 15 over Wi-Fi, not USB):

- [ ] Pairing by QR works; the fingerprint groups on phone and PC match.
- [ ] A second scan of the same QR fails with the "not valid" message.
- [ ] The list matches the desktop window for the same filter (count and order).
- [ ] Tap a row: the chat opens on the PC.
- [ ] Read, Unread, Pin, Unpin, Move pin, Drawer in/out, Discard/Keep: the
      desktop window shows the change within 5 s, and the reverse direction too.
- [ ] Persistent unread toggled on the phone changes the desktop setting.
- [ ] Close the ASB window: the phone stays Live (service).
- [ ] `systemctl --user restart asb.service`: a Claude Desktop or Codex window
      that ASB opened stays open; the phone reconnects.
- [ ] Remove the phone in Preferences: the phone shows "This phone was removed".
- [ ] Turn off phone access: the phone shows Offline; `ss -ltnp | grep 4630` is empty.
- [ ] Done, Failed, Needs input notifications with the three opencode sounds.
- [ ] `curl -k https://192.168.50.4:4630/phone/v1/dashboard` gives 401;
      `curl http://192.168.50.4:4629/` fails (loopback only).

Final checks: `npm test`, `python3 test/asb_native_logic_test.py`,
`npm run build` (package whitelist), `cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug`.
Run the GTK widget tests only on a hidden nested display (see the
`asb-gtk-check-before-release` notes in the ASB Claude memory if available);
otherwise report them as not run.

Commit: `docs: describe the phone gateway, service, and Android app`.
Do not push, merge, tag, or release. Report to the user and wait.

## 12. Security checklist (verify before phase 8 ends)

- Gateway off by default; on only by user action in Preferences.
- Gateway binds one private IPv4 address, never `0.0.0.0`.
- TLS 1.3 only; cert key `0600`; pin checked on every connection.
- Tokens: 256-bit random; only SHA-256 stored on the PC; compared in constant time.
- Pairing code: single use, 10 min, one at a time, 8 failures void it.
- Throttle on auth failures.
- Only the allowlisted routes; `/api/sources` and phone settings are never
  reachable from the LAN.
- No secrets in logs, `status()`, the dashboard, or notifications.
- Phone storage is app-private; backups are off.
- No `trust all` TLS code anywhere in the app.

## 13. Known limits (write these in `android/README.md`)

- LAN only. Away from home the app shows Offline.
- Background checks run about every 15 minutes, and HyperOS can delay them more
  unless the user removes battery limits.
- The QR scanner needs Google Play services.
- A debug-signed APK; reinstall from another PC needs an uninstall first.
- The phone shows titles and folders of all sessions; anyone who unlocks the
  phone can see them.

## 14. Future: SSH tunnel (do not build now)

Design hooks already in place: `isAllowedRemote` accepts `127.0.0.1`, and the
phone stores host and port separately. A later version can let the gateway also
bind `127.0.0.1:4630` and the app open an SSH local forward (for example with
an embedded SSH library) to that port, with the same pin and token. No other
change is needed in the API.
