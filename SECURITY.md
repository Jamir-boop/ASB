# Security policy

ASB reads local session metadata and serves it on `127.0.0.1`. The ASB path leaves original app stores unchanged, reads no credentials, and makes no model calls or external network requests. One exception applies: the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files next to it.

A local process under your user account can access the local API. Loopback binding does not separate ASB from other programs on the same computer. Action endpoints check Host, Origin, known session IDs, and request fields.

A local program that is not a browser can send Host and Origin itself. A source change can set the launcher that ASB runs. For this reason, the engine makes one random token for each run and publishes it in `service.json`. The launcher writes the token and the URL to the stdin of the window as one JSON line, not to an argument, an environment variable, or a file. A window that you start by hand with the URL as its argument uses `ASB_SOURCE_TOKEN`. `POST /api/sources` and `POST /api/sources/<id>/remove` then need the header `X-ASB-Source-Token`. Without it, the reply is 403. `GET /api/sources` needs no token. A server started with `npm start` has no token, so these routes then have only the Host and Origin checks.

The optional machine group joins ASB engines on your private network. Its trust model:

- Each engine is one machine. Its identity is its phone certificate. Members connect with mutual TLS 1.3 and pin each other's certificate.
- To join, a machine needs a one-time invite code from a member (valid 10 minutes, void after 8 wrong codes). `asb group join` shows the fingerprint of the inviter; compare it with the fingerprint that the inviter shows before you join.
- The member routes need the client certificate of an active member: `/peer/v1/*` (except `join`), `POST /peer/v2/resolve-session`, and `POST /peer/v2/deliver`. Other callers get 401, which counts toward the gateway throttle.
- Any active member can add or remove members. A removal is a tombstone, and a tombstone always wins in the merge of the group lists. A removed machine gets 410 from the members and then leaves the group. It cannot join again with the same certificate: it needs a new identity (if `asb group status` still shows a group, run `asb group leave`; then stop ASB (`asb engine stop`), run `asb group reset-identity`, and start ASB again; paired phones must then pair again).
- Members see each other's session titles, folders, states, and times. Each member accepts the tokens of the group phones.

Add only your own machines to a group: a member can see your sessions and message them. Messages between machines (ASB Bridge and the message relay) follow these rules:

- A member can list the live local sessions of your machine (session ID, name, Claude or Codex, status, and whether Claude Remote Control is on) with `GET /peer/v1/peers`, and can deliver a message to one of them with `POST /peer/v1/deliver`. Both routes need the client certificate of an active member, and a delivery must name the caller's own machine as its sender. A delivered message goes to the inbox of the target session, so the receiving session applies its usual rules for a message from another session: Claude Code's own rules, or the inbox policy of ASB Bridge for a Codex task. A member can also ask with `POST /peer/v2/resolve-session` if one exact session (named by its full session reference) can take a message now, and deliver one message to exactly that session with `POST /peer/v2/deliver`. This delivery must also name the caller's own machine as its sender. The receiving engine binds the reference to one live session in its own records, and its relay checks that session in those records again just before the write. The receipt of such a message goes back only to the task that sent it, in the same process. The sending engine uses a receipt only when it comes from the member of that send, checked against the member certificate.
- The relay process listens only on `127.0.0.1` and accepts only the random token that it gives the engine at start. Its proxy rows are files in your Claude config homes (mode `0600` on Linux). On Windows, each proxy row and each bridge receiver also has a key file with a random token, as Claude Code writes for its own sessions, and a connection must send that token first. Any process can serve a free pipe name, so for a send by full session reference on the same Windows PC, ASB Bridge also checks before the first byte that the pipe server is the registered process (its PID and start time) of the same Windows user.
- A Codex task sends a message to another machine only through the local engine on `127.0.0.1`, with the source token from the engine's `service.json` (mode `0600` in a private runtime folder on Linux).
- The engine and the relay do not save or log message text and keep no queue. As for a local message, ASB Bridge keeps the text of a Codex task's messages in that task's own state file.

On Windows, ASB has no POSIX file modes, so it does not check the owner or mode of its files there. It limits `%APPDATA%\asb` and the `%LOCALAPPDATA%\asb` state and runtime folders to your Windows user with `icacls` (inheritance off, full control only for you); when this fails, the engine logs a warning and still starts. It still refuses a linked `service.json` or a linked `%LOCALAPPDATA%\asb` folder. A `service.json` whose PID is live stops a second engine only when that engine answers `GET /api/service` with the same PID in 2 s, because Windows can reuse a PID. Windows opens a session link with `cmd /c start`, which parses some characters itself. For this reason, ASB opens a link on Windows only when it matches `^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9/?=._:~-]*$`, and refuses others with "This session link cannot open on Windows."

Report security issues through [GitHub private vulnerability reporting](https://github.com/Jamir-boop/ASB/security/advisories/new) if it is enabled. Do not put private content in a public issue. If private reporting is unavailable, open an issue that describes only the affected component and asks for a private contact route.

Before sharing diagnostics, remove real chat titles, prompts, project paths, account IDs, and all content from local agent stores. Do not attach:

- `~/.codex/**` or `~/.claude/**`
- Claude Desktop session stores
- `~/.local/state/asb/**` or ASB installation manifests
- `.env` files, databases, JSONL logs, cookies, tokens, or keys
- Screenshots that show private work
