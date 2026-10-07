# ASB publication plan

ASB `1.0.0` will be published as a public Linux release at [Jamir-boop/ASB](https://github.com/Jamir-boop/ASB). The source workspace had no Git repository when this release preparation began. A fresh initial commit is planned; inherited upstream Git history is not present.

## Release contents

- ASB source, tests, Linux package scripts, and user docs.
- The unchanged upstream MIT license and clear Agent Mission Control `0.6.0` credit.
- Synthetic banner and Remotion demo source, with a GIF preview and MP4 release asset.
- `asb_1.0.0_all.deb`, `asb-1.0.0-linux.tar.gz`, and `SHA256SUMS`.

Generated packages and development dependency folders stay outside source control. No local agent store, real session capture, credential, or installation manifest belongs in the public export.

## Before the initial publication

1. Review every file selected for the initial commit. Scan for private titles, account IDs, machine paths, keys, cookies, logs, databases, and real session data. `.gitignore` does not remove data from Git history.
2. Run `npm test` and `python3 test/asb_native_logic_test.py`. Record the actual results. Do not copy historical upstream check counts into ASB release notes.
3. Run `npm run build`. Check archive members, Debian metadata, runtime requirements, and `SHA256SUMS`. Check package installation with disposable local paths before installing for the current user.
4. Check public media for synthetic data and verify README links. The Remotion animation is a presentation, not a native UI test.
5. Create the fresh Git history with a Conventional Commit. Examine all reachable history before the first push. Confirm that the unchanged MIT license and upstream credit are present.
6. Create the public GitHub repository, push `main`, and publish tag `v1.0.0` with the package and media assets. Review the remote files and downloaded checksums.

Publication status must come from the actual GitHub result. This plan does not state that a repository, tag, release, or install check has already succeeded.

## Repository settings

Use `main` as the default branch. Enable Issues and private vulnerability reporting when available. Add required test checks to branch protection when CI is configured.
