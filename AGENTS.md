# ASB / Agent Switch Board

This repository is ASB (Agent Switch Board). When the user says "ASB", "Agent Switch Board", "这个系统", "这个控制台", or "咱们这个项目", use this repository unless they give another path.

## Start Here

- First read `SYSTEM_OVERVIEW.md` for current architecture, data sources, UX decisions, and known pitfalls.
- Then read `README.md` for public-facing positioning and open-source expectations.
- If the task touches privacy, release readiness, or GitHub publishing, also read `docs/PRIVACY.md` and `docs/OPEN_SOURCE_PLAN.md`.

## Product Context

ASB is a native GNOME switch board for Codex and Claude Desktop Code chats. It reads local app stores and opens existing chats in their original apps. ASB also lists OpenCode 2 sessions (list only: it cannot open them, except that the optional ASB Bridge lets an OpenCode session send and receive messages). ASB also lists Claude Code CLI and Codex CLI sessions (view only: it does not open them). Original app stores stay read-only. ASB saves its own local marks, pins, and settings. Its runtime reads no credentials and makes no model calls. The main server binds only `127.0.0.1` (default port `4629`).

The optional phone gateway (`src/phone-gateway.mjs`) is off by default. When the user turns it on in Preferences > Phone, it binds only the selected private LAN or overlay (ZeroTier, Tailscale) addresses (default port `4630`). It uses TLS 1.3, a pinned self-signed certificate, and per-phone bearer tokens. It forwards only allowlisted session routes to the loopback server. It also serves the member routes of the optional machine group (`/peer/v1/*`, mutual TLS with pinned certificates; `src/machine-group.mjs`, `src/machine-peers.mjs`). The optional `asb service` user service runs the server and the gateway without the window. The Android companion app is in `android/`.

On Windows, ASB runs the engine and the same GTK board (`scripts/asb-native.py`) with MSYS2 Python (UCRT64). Without MSYS2, only the engine runs. The engine plays the sounds with Windows PowerShell, only while a board is open. ASB Bridge and the message relay also run on Windows (named pipes, key files, and the `auth` line; `bridge/src/platform.ts`). `asb engine install` writes the HKCU Run value from Node, and `scripts/asb-tray.ps1` keeps the engine running. Paths come from `src/platform-paths.mjs`; win32 branches take injected `platform`, `env`, and `execFile`, so their tests run on Linux. The Windows CI job runs the files in `test/windows-tests.json`.

The release target is a GitHub-friendly open-source version. Be conservative about privacy:

- Do not commit local Codex/Claude state, logs, screenshots with private text, cookies, tokens, API keys, or machine-specific secrets.
- Prefer mock data for public screenshots and examples.
- Keep the main server local-only. It always binds `127.0.0.1`; the code has no `HOST` setting. Do not remove the phone gateway to satisfy this rule. Keep the gateway off by default, bound only to selected private LAN or overlay (ZeroTier, Tailscale) addresses, and limited to its route allowlist. Never bind `0.0.0.0`, loopback, or public addresses. Never make `/api/sources`, `/api/palette`, the phone settings routes, `/api/group*`, `/api/engine/*`, or `/api/agent/*` reachable from the gateway.

## Development Rules

- Use existing patterns in `src/*`, `public/*`, and `test/*`.
- Keep the app dependency-light unless the user explicitly approves adding a package.
- The npm package (`npm install -g github:Jamir-boop/ASB`) ships only the `files` list in `package.json`. Keep it honest: add each new runtime file, and keep tests, docs, `android/`, and `demo/` out. Check with `npm pack --dry-run`.
- Run `npm test` after behavior changes.
- `bridge/` is a Bun and TypeScript package with its own tests: after bridge changes, run `cd bridge && bun run check && bun test && bun run build`, and commit `bridge/dist/`.
- `android/` is a Kotlin and Gradle project with its own tests: after Android changes, run `cd android && ./gradlew --no-daemon testDebugUnitTest lint assembleDebug assembleRelease`. See `android/README.md` for the toolchain.
- If a local dev server is needed, default to `npm start` and `http://127.0.0.1:4629`.
- After completing user-visible features, behavior changes, data source/API changes, notification semantics, or release work, check whether `SYSTEM_OVERVIEW.md`, `README.md`, and `CHANGELOG.md` need to be updated so future threads inherit the current project memory.
- Preserve user edits in the working tree; this repo is often dirty during iteration.

## Current Notification Stance

ASB shows Pending attention in its chat rows. The desktop has no pop-up notifications or notification center. The ASB server plays the Done, Needs input, and Failed sounds on the PC (`src/asb-sounds.mjs`). The Android companion in `android/` has phone notifications (Done, Failed, and Needs input) with the same sounds.
