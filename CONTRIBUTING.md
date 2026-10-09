# Contributing to ASB

Keep ASB focused on local Codex and Claude Desktop Code chats. Use existing patterns and system APIs. The ASB runtime has no external npm dependencies.

Before a pull request:

1. Keep original session stores read-only. Save ASB settings only in ASB's own files.
2. Keep the server bound to `127.0.0.1`. Do not add credential reads, model calls, telemetry, or external requests to the ASB path.
3. Use synthetic data for examples, tests, screenshots, and demo scenes. Do not include real titles, prompts, paths, logs, databases, keys, cookies, or tokens.
4. Run `npm test` and `python3 test/asb_native_logic_test.py` with Node.js `>=22.13`. ASB fixtures use built-in SQLite and need no SQLite CLI. `npm test` needs no environment variable.
5. Review the diff. Update `SYSTEM_OVERVIEW.md`, `README.md`, and `CHANGELOG.md` when behavior or release details change.

Native widget tests need a GTK display. Run them only when UI testing is in scope, with synthetic fixtures. Do not open real chats during tests.

ASB pins and Read/Unread marks are independent of the original apps. Preserve that behavior. Pending remains an attention marker beside the real execution state.

ASB releases use Semantic Versioning. Version `1.0.0` is the first public ASB release. Keep the inherited Agent Mission Control history and original MIT license separate from ASB's version series. Use Conventional Commits for commits.

See [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md), [SECURITY.md](SECURITY.md), and [Privacy](docs/PRIVACY.md).
