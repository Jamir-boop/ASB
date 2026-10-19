# Security policy

ASB reads local session metadata and serves it on `127.0.0.1`. The ASB path leaves original app stores unchanged, reads no credentials, and makes no model calls or external network requests. One exception applies: the read-only SQLite open of the Codex state database can create `-wal` and `-shm` side files next to it.

A local process under your user account can access the local API. Loopback binding does not separate ASB from other programs on the same computer. Action endpoints check Host, Origin, known session IDs, and request fields.

A local program that is not a browser can send Host and Origin itself. A source change can set the launcher that ASB runs. For this reason, the launcher creates one random token for each run and gives it to the server and to the window (`ASB_SOURCE_TOKEN`). `POST /api/sources` and `POST /api/sources/<id>/remove` then need the header `X-ASB-Source-Token`. Without it, the reply is 403. `GET /api/sources` needs no token. A server started with `npm start` has no token, so these routes then have only the Host and Origin checks.

The optional machine group joins ASB engines on your private network. Its trust model:

- Each engine is one machine. Its identity is its phone certificate. Members connect with mutual TLS 1.3 and pin each other's certificate.
- To join, a machine needs a one-time invite code from a member (valid 10 minutes, void after 8 wrong codes). `asb group join` shows the fingerprint of the inviter; compare it with the fingerprint that the inviter shows before you join.
- The member routes (`/peer/v1/*`, except `join`) need the client certificate of an active member. Other callers get 401, which counts toward the gateway throttle.
- Any active member can add or remove members. A removal is a tombstone, and a tombstone always wins in the merge of the group lists. A removed machine gets 410 from the members and then leaves the group. It cannot join again with the same certificate: it needs a new identity (if `asb group status` still shows a group, run `asb group leave`; then stop ASB (`asb engine stop`), run `asb group reset-identity`, and start ASB again; paired phones must then pair again).
- Members see each other's session titles, folders, states, and times. Each member accepts the tokens of the group phones.

Report security issues through [GitHub private vulnerability reporting](https://github.com/Jamir-boop/ASB/security/advisories/new) if it is enabled. Do not put private content in a public issue. If private reporting is unavailable, open an issue that describes only the affected component and asks for a private contact route.

Before sharing diagnostics, remove real chat titles, prompts, project paths, account IDs, and all content from local agent stores. Do not attach:

- `~/.codex/**` or `~/.claude/**`
- Claude Desktop session stores
- `~/.local/state/asb/**` or ASB installation manifests
- `.env` files, databases, JSONL logs, cookies, tokens, or keys
- Screenshots that show private work
