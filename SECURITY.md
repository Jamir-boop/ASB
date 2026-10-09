# Security policy

ASB reads local session metadata and serves it on `127.0.0.1`. The ASB path leaves original app stores unchanged, reads no credentials, and makes no model calls or external network requests. One exception applies: the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files next to it.

A local process under your user account can access the local API. Loopback binding does not separate ASB from other programs on the same computer. Action endpoints check Host, Origin, known session IDs, and request fields.

A local program that is not a browser can send Host and Origin itself. A source change can set the launcher that ASB runs. For this reason, the launcher creates one random token for each run and gives it to the server and to the window (`ASB_SOURCE_TOKEN`). `POST /api/sources` and `POST /api/sources/<id>/remove` then need the header `X-ASB-Source-Token`. Without it, the reply is 403. `GET /api/sources` needs no token. A server started with `npm start` has no token, so these routes then have only the Host and Origin checks.

Report security issues through [GitHub private vulnerability reporting](https://github.com/Jamir-boop/ASB/security/advisories/new) if it is enabled. Do not put private content in a public issue. If private reporting is unavailable, open an issue that describes only the affected component and asks for a private contact route.

Before sharing diagnostics, remove real chat titles, prompts, project paths, account IDs, and all content from local agent stores. Do not attach:

- `~/.codex/**` or `~/.claude/**`
- Claude Desktop session stores
- `~/.local/state/asb/**` or ASB installation manifests
- `.env` files, databases, JSONL logs, cookies, tokens, or keys
- Screenshots that show private work
