# Security policy

ASB reads local session metadata and serves it on `127.0.0.1`. The ASB path leaves original app stores unchanged, reads no credentials, and makes no model calls or external network requests.

A local process under your user account can access the local API. Loopback binding does not separate ASB from other programs on the same computer. Action endpoints check Host, Origin, known session IDs, and request fields.

Report security issues through [GitHub private vulnerability reporting](https://github.com/Jamir-boop/ASB/security/advisories/new) if it is enabled. Do not put private content in a public issue. If private reporting is unavailable, open an issue that describes only the affected component and asks for a private contact route.

Before sharing diagnostics, remove real chat titles, prompts, project paths, account IDs, and all content from local agent stores. Do not attach:

- `~/.codex/**` or `~/.claude/**`
- Claude Desktop session stores
- `~/.local/state/asb/**` or ASB installation manifests
- `.env` files, databases, JSONL logs, cookies, tokens, or keys
- Screenshots that show private work

The retained Agent Mission Control server has a broader data and network scope. Its security boundary is described in [upstream privacy](docs/upstream/PRIVACY.md). The ASB launch commands do not start that server.
