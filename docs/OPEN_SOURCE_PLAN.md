# ASB publication record and checklist

## Latest publication

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
