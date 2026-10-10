# ASB publication record and checklist

## Latest publication

ASB [1.6.1](https://github.com/Jamir-boop/ASB/releases/tag/v1.6.1) was published on `2026-10-10` (Lima). Its source and tag use commit [bf4f2d9](https://github.com/Jamir-boop/ASB/commit/bf4f2d906e69c82f68f2795f137a183fdc90a3ae).

- Uploaded `asb_1.6.1_all.deb`, `asb-1.6.1-linux.tar.gz`, and `SHA256SUMS`. All three downloads matched local bytes and hashes. [Exact-source CI](https://github.com/Jamir-boop/ASB/actions/runs/38029498867) passed on Node.js `22.13.0` and `24`.
- Local checks passed 269 Node tests, 77 native logic tests, Python compilation, and diff checks. Both package payloads had 30 runtime files that matched source bytes. The final Debian `Installed-Size` was 477 KiB. Reproducibility checks passed.
- Synthetic upgrade, install, and removal fixtures passed using the published `1.6.0` package. The upgrade kept settings, marks, pins, drawer state, and Persistent unread.
- The current-user install used the verified portable download and passed. The manifest used `1.6.1`; all 30 installed runtime files matched source bytes and hashes. Two normal X11 processes ran one window. The API returned HTTP `200`, with 154 rows and no duplicate IDs. The `1182x350` geometry was restored.
- All four settings/state files kept their bytes and modes during installation. After start, theme, layout, sources, manual marks, pin order, Persistent unread, and record count stayed unchanged.
- Privacy checks covered 19 history commits, 356 blobs, 100 current files, and eight release files. The upstream MIT license, credit, and exact README video link stayed unchanged.
- Manual scroll repaint activity measured 57.93 FPS; presented frames were not measured. Resize lag remains unresolved. The X11 fallback clock may run at about 60 Hz. See [release notes](releases/v1.6.1.md) for measurements and limits.
- Twenty synthetic viewport pixel checks passed. The full GTK widget suite was not rerun; an earlier motion test failed an old startup expectation. No Debian `apt install`, real-chat opens, or Node.js `20` + SQLite CLI reader check was run.

## Earlier publications

ASB [1.6.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.6.0) was published on `2026-10-09` (Lima). Its source and tag use commit [c122324](https://github.com/Jamir-boop/ASB/commit/c1223247006eb6713a5c6424e3be3ef9d7696ab5).

- Uploaded `asb_1.6.0_all.deb`, `asb-1.6.0-linux.tar.gz`, and `SHA256SUMS`. All three downloads matched local bytes and hashes. [CI](https://github.com/Jamir-boop/ASB/actions/runs/38023748369) passed on Node.js `22.13.0` and `24`.
- Local checks passed 269 Node tests on Node.js `24.21`, 74 native logic tests, Python compilation, and diff checks. All 30 runtime payload files matched source bytes. Debian metadata, runtime, reproducibility, and installer fixtures passed. The final Debian `Installed-Size` was 475 KiB.
- A synthetic upgrade from `1.5.0` to `1.6.0` kept settings, three marks, two pins, drawer state, and Persistent unread.
- The current-user portable install used the downloaded release and passed. All 30 installed runtime files matched source bytes; the manifest used `1.6.0`. Two ASB processes ran one window. The API returned HTTP `200`, with 154 rows and no duplicate IDs. The `1182x350` window size was restored.
- Theme, layout, and source hashes and modes stayed unchanged. Pending bytes stayed unchanged during installation. After start, the record count, manual marks, pins, and Persistent unread stayed unchanged.
- A synthetic 120-card check compared scrolling before and after the hover fix. Wheel-burst scrolling changed from 19.73 to 56.89 FPS; reversal changed from 14.98 to 60.01 FPS. The outside-pointer case was about 60 FPS. The hidden display used GL, the test accessibility backend (`GTK_A11Y=test`), four rows per column, and a fixed pointer. This was not a physical-pointer check. One 42 ms paint remained. See [release notes](releases/v1.6.0.md) for the other samples and limits.
- Privacy checks covered 16 history commits and 339 blobs, plus incremental diffs. The upstream MIT license and exact README video link stayed unchanged.
- The full GTK widget suite was not rerun after the performance changes. No Debian `apt install`, real-chat opens, or Node.js `20` + SQLite CLI reader check was run. Native pixel fidelity and real-app GUI opening remain unverified.

ASB [1.5.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.5.0) was published on `2026-10-09` (Lima). Its source and tag use commit [e22a046](https://github.com/Jamir-boop/ASB/commit/e22a0466aef560cd77a7e5be47ede11e3c6ad620).

- Uploaded `asb_1.5.0_all.deb`, `asb-1.5.0-linux.tar.gz`, and `SHA256SUMS`. All three downloads matched local bytes and hashes.
- Independent checks passed 212 Node tests, 67 pure native logic checks, Python compilation, diff checks, the 30-file runtime whitelist, and Debian metadata. A second build gave the same bytes, and the archive files matched the source. [CI](https://github.com/Jamir-boop/ASB/actions/runs/37963673946) passed for the source commit on Node.js `22.13.0` and `24`.
- A disposable `1.4.0` install used the local `1.4.0` portable archive. Its upgrade to `1.5.0` kept layout, custom theme, pins, a manual mark, and Persistent unread byte-for-byte. The installed command started ASB in the disposable home on a headless display; the API returned HTTP `200`. Uninstall removed both releases and the empty data folders.
- The current-user install and restart passed. All 30 installed runtime files matched the source bytes. The running paths used `1.5.0`; the API returned HTTP `200` with no duplicate IDs. Theme, layout, and source hashes stayed unchanged. The record count, manual marks, pin order, and Persistent unread stayed unchanged.
- The `1.4.0` and `1.5.0` Codex log scans gave equal signals for all 716 local rollout logs. The `1.4.0` and `1.5.0` servers gave equal rows for the same local stores, except six titles that `1.5.0` cut to 300 characters and one time field of a session that changed during the comparison. The comparisons used field values only and recorded no content.
- Measured on one machine with 148 rows and 716 Codex logs (3.4 GB), with a warm file cache. The time from start to the first list went from 9.7 s to 3.9 s. With two to four Working sessions, the server used 1.2% of one CPU core (before: 2% to 3.5%) and the window 0.14% (before: 1.5% to 2.6%). Server wakeups went from about 375 to 11 per second, and window wakeups from 60–100 to 13 per second. In 90 seconds, 52 of 102 list replies were `304`, and one directory walk ran. Server memory did not change (about 350 MB).
- The GTK widget test file was run on one X11 machine. Four of its eight tests passed, including the new test for card motion, the wheel spring, and the column width. Four failed in the same way as with the `1.3.0` code, because their expectations are older than the `1.3.0` layout. On that display, with synthetic rows: a card motion painted at about 60 frames per second and painted no frame after its end while the pointer was outside the window; one wheel click reached 90% of its distance in 199 ms and ended on its target at 379 ms with no overshoot; search results with long titles kept the shared column width; no widget had focus after start. The row tooltip was built under GTK for 14 synthetic rows in both views and both color modes with no error.
- Privacy scans covered the 1421 added lines of the release commit. They found no secrets or private state. The upstream MIT license and exact README video link stayed unchanged.
- No Debian `apt install` or real-app GUI opens were run. Native pixel fidelity and real-app GUI opening remain unverified. The Node.js `20` reader path with the `sqlite3` command was not run.

ASB [1.4.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.4.0) was published on `2026-10-09` (Lima). Its source and tag use commit [95883c1](https://github.com/Jamir-boop/ASB/commit/95883c1aaa82e1ca3f2ce06ced549dfe863a4c23).

- Uploaded `asb_1.4.0_all.deb`, `asb-1.4.0-linux.tar.gz`, and `SHA256SUMS`. All three downloads matched local bytes and hashes.
- Independent checks passed 196 Node tests, 63 pure native logic checks, Python compilation, diff checks, the 30-file runtime whitelist, and Debian metadata. A second build gave the same bytes, and the archive files matched the source. [CI](https://github.com/Jamir-boop/ASB/actions/runs/37952353550) passed for the source commit on Node.js `22.13.0` and `24`.
- A disposable `1.3.0` install used the local `1.3.0` portable archive. Its upgrade to `1.4.0` kept layout, custom theme, pins, a manual mark, and Persistent unread byte-for-byte. The installed command started ASB in the disposable home; the API returned HTTP `200`. Uninstall removed both releases and the empty data folders.
- The current-user install and restart passed. All 30 installed runtime files matched the source bytes. The running paths used `1.4.0`; the API returned HTTP `200` with no duplicate IDs. Theme, layout, and source hashes, manual marks, and pin order stayed unchanged.
- The reader code from before the dashboard removal and the `1.4.0` reader code gave the same rows for the same local stores. The comparison used field values only and recorded no content.
- The GTK widget test file was run on one X11 machine. Three of its seven tests passed. Four failed in the same way as with the `1.3.0` code, because their expectations are older than the `1.3.0` layout. This run found one startup defect and one focus defect in unreleased code; both were fixed before the release. The row tooltip was built under GTK for 14 synthetic rows in both views and both color modes with no error.
- Privacy scans covered the 4402 added lines of the release commit. They found no secrets or private state. The upstream MIT license and exact README video link stayed unchanged.
- No native screenshots, Debian `apt install`, or real-app GUI opens were run. Native pixel fidelity and real-app GUI opening remain unverified. The Node.js `20` reader path with the `sqlite3` command was not run.

ASB [1.3.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.3.0) was published on `2026-10-08` (Lima). Its source and tag use commit [35a9b9a](https://github.com/Jamir-boop/ASB/commit/35a9b9a010f203d2d92d0f04b5bf8a4dfd2460ab).

- Uploaded `asb_1.3.0_all.deb`, `asb-1.3.0-linux.tar.gz`, and `SHA256SUMS`. All three downloads matched local bytes and hashes.
- Independent checks passed 446 Node tests, 29 pure native logic checks, Python compilation, diff checks, the 32-file runtime whitelist, and Debian metadata. Reproducibility, imports, payload, and user-installer fixtures passed. [CI](https://github.com/Jamir-boop/ASB/actions/runs/37812000950) passed for the source commit on Node.js `22.13.0` and `24`.
- A disposable `1.2.0` install used the downloaded public portable installer. Its upgrade to `1.3.0` kept layout, custom theme (including equal background/divider colors), sources, profile colors/dot visibility, pins, and manual/persistent unread byte-for-byte.
- The current-user install and restart passed. All 32 installed runtime files matched reviewed source bytes and hashes. The manifest and running native path used `1.3.0`; the API returned HTTP `200`, with no duplicate IDs and preserved profile open availability. Theme, layout, and source hashes, manual marks, and pin order stayed unchanged. A synthetic launcher target survived opener exit and 5.2 seconds; a spawn failure kept unread attention.
- Privacy scans covered 10 earlier commits, 222 blobs, and 26 new or changed release files. They found no secrets or private state. The upstream MIT license and exact README video link stayed unchanged. The synthetic demo source was reviewed; no video was rendered or uploaded again.
- No UI/widget tests, new native screenshots, Debian `apt install`, or real-app GUI opens were run. Native pixel fidelity and real-app GUI opening remain unverified.

ASB [1.2.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.2.0) was published on `2026-10-07` (Lima). Its source and tag use commit [a139538](https://github.com/Jamir-boop/ASB/commit/a1395386f6b054befceca323f1c90567c2b23898).

- Uploaded `asb_1.2.0_all.deb`, `asb-1.2.0-linux.tar.gz`, and `SHA256SUMS`. All three downloads matched local bytes and hashes.
- Independent checks passed 426 Node tests, 12 pure native logic checks, build checks, and package checks. [CI](https://github.com/Jamir-boop/ASB/actions/runs/37708726563) passed on Node.js `22.13.0` and `24`.
- A disposable `1.1.0` install used its original installer. Its upgrade to `1.2.0` kept settings.
- The current-user install and restart passed. Settings hashes stayed unchanged. Installed native bytes matched the reviewed source. Running paths used `1.2.0`; the backend returned HTTP `200`.
- No UI tests, native screenshots, or Debian `apt install` were run. Native pixel fidelity remains unverified.

ASB [1.1.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.1.0) was published on `2026-10-07` (Lima). Its source and tag use commit [84b5dee](https://github.com/Jamir-boop/ASB/commit/84b5deed74a446eec794fc706418030b2d616cec).

- Uploaded `asb_1.1.0_all.deb`, `asb-1.1.0-linux.tar.gz`, and `SHA256SUMS`. All three downloaded hashes matched the local files.
- Local checks passed 419 Node tests and seven pure native logic checks. [CI](https://github.com/Jamir-boop/ASB/actions/runs/37687682053) passed on Node.js `22.13.0` and `24`.
- A disposable per-user upgrade from `1.0.0` to `1.1.0` kept layout, theme, pins, and unread state. The packaged runtime check passed. No UI tests or Debian `apt install` were run.

ASB [1.0.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.0.0) was published on `2026-10-07` in the public [Jamir-boop/ASB](https://github.com/Jamir-boop/ASB) repository. The initial code commit is [552c3da](https://github.com/Jamir-boop/ASB/commit/552c3da). The source workspace had no Git repository when preparation began; inherited upstream Git history was not imported.

## Verified publication

- Both Linux installers, the MP4, and `SHA256SUMS` were uploaded. Remote hashes matched the local files.
- Independent checks passed 405 Node tests and six pure native logic checks. CI passed on Node.js `22.13.0` and `24`.
- Per-user portable installation and launch passed. Settings hashes stayed unchanged.
- Debian package format, dependencies, reproducibility, and the Node.js `20` + SQLite CLI reader passed checks. Debian `apt install` and `apt remove` were not run.
- No UI tests were run.

## Release contents

- ASB source, tests, Linux package scripts, and user docs.
- The unchanged upstream MIT license and clear Agent Mission Control `0.6.0` credit.
- Synthetic banner and Remotion demo source, with a GIF preview and MP4 release asset.
- `asb_1.0.0_all.deb`, `asb-1.0.0-linux.tar.gz`, and `SHA256SUMS`.

Generated packages and development dependency folders stay outside source control. No local agent store, real session capture, credential, or installation manifest belongs in the public export.

## Before each release

1. Review every file selected for the release. Scan for private titles, account IDs, machine paths, keys, cookies, logs, databases, and real session data. `.gitignore` does not remove data from Git history.
2. Run `npm test` and `python3 test/asb_native_logic_test.py`. Record the actual results. Do not copy historical upstream check counts into ASB release notes.
3. Run `npm run build`. Check archive members, Debian metadata, runtime requirements, and `SHA256SUMS`. Check package installation with disposable local paths before installing for the current user.
4. Check public media for synthetic data and verify README links. The Remotion animation is a presentation, not a native UI test.
5. Use Conventional Commits. Examine the diff and all reachable Git history before publication. Confirm that the unchanged MIT license and upstream credit are present.
6. Push the reviewed `main` commit and publish the versioned tag with package and media assets. Review the remote files and downloaded checksums.

Record publication status and check results only after verification.

## Repository settings

Use `main` as the default branch. Enable Issues and private vulnerability reporting when available. Require CI test checks in branch protection when configured.
