# ASB / Agent Switch Board

This repository is ASB (Agent Switch Board). When the user says "ASB", "Agent Switch Board", "这个系统", "这个控制台", or "咱们这个项目", use this repository unless they give another path.

## Start Here

- First read `SYSTEM_OVERVIEW.md` for current architecture, data sources, UX decisions, and known pitfalls.
- Then read `README.md` for public-facing positioning and open-source expectations.
- If the task touches privacy, release readiness, or GitHub publishing, also read `docs/PRIVACY.md` and `docs/OPEN_SOURCE_PLAN.md`.

## Product Context

ASB is a native GNOME switch board for Codex and Claude Desktop Code chats. It reads local app stores and opens existing chats in their original apps. Original app stores stay read-only. ASB saves its own local marks, pins, and settings. Its runtime reads no credentials, makes no model calls, and makes no network requests outside loopback.

The release target is a GitHub-friendly open-source version. Be conservative about privacy:

- Do not commit local Codex/Claude state, logs, screenshots with private text, cookies, tokens, API keys, or machine-specific secrets.
- Prefer mock data for public screenshots and examples.
- Keep the server local-only. It always binds `127.0.0.1`; the code has no `HOST` setting.

## Development Rules

- Use existing patterns in `src/*`, `public/*`, and `test/*`.
- Keep the app dependency-light unless the user explicitly approves adding a package.
- Run `npm test` after behavior changes.
- If a local dev server is needed, default to `npm start` and `http://127.0.0.1:4629`.
- After completing user-visible features, behavior changes, data source/API changes, notification semantics, or release work, check whether `SYSTEM_OVERVIEW.md`, `README.md`, and `CHANGELOG.md` need to be updated so future threads inherit the current project memory.
- Preserve user edits in the working tree; this repo is often dirty during iteration.

## Current Notification Stance

ASB shows Pending attention in its chat rows. It has no desktop/system notifications or notification center.
