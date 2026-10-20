# ASB on every Linux distribution: implementation plan

Status: approved by the user on 2026-10-20, in progress. Phase 0 is done
(2026-10-20: CI run 39408877913 passed all 16 jobs). Phase 1 passed the
review on 2026-10-20. Written 2026-10-19
for an implementing agent (a worker model). Section 2 has the user's
decisions from the interview. Section 3 has the planner decisions, which the
user approved. Do not change any of them without asking the user.

Read this whole file before you start. Do the phases in order. Each phase has
acceptance criteria. Do not start the next phase until all criteria of the
current phase pass and the reviewer accepts the phase (section 8). Phase 0
can correct section 7 and Appendix A: obey its gate.

**Start condition.** Met. Multi-machine phase 4 is in `main` (`e3059c8`:
`scripts/asb.mjs`, `src/platform-paths.mjs`, `scripts/asb-setup.mjs`, and the
npm install), and so are multi-machine phases 5 to 8. Start from `main` at
`68c40ef`. The line numbers in this plan come from `main` at `68c40ef`.
Earlier phases move some of them: find the code by the names given. Before
each phase starts, the reviewer checks the anchors of that phase.

---

## 1. Goal

1. **Every distribution.** ASB installs and runs on every current Linux
   distribution that ships the libraries it needs. CI proves the Debian,
   Ubuntu, Fedora, RHEL, openSUSE, Arch, Alpine, Void, and Nix families.
   Gentoo, Solus, and image-based systems (Fedora Atomic, openSUSE Aeon,
   SteamOS) get the same checks and commands, without CI.
2. **One check command.** `asb doctor` checks the system. It prints the exact
   command that installs what is missing, for the package manager of that
   system. ASB never runs the command.
3. **Engine only.** On a release whose GTK or Libadwaita is too old for the
   board, the engine runs alone. The phone and the boards on your other
   machines still show its sessions.
4. **Start at login everywhere.** The engine starts at login with or without
   systemd, on every desktop that supports XDG autostart, and without
   `XDG_RUNTIME_DIR`.
5. **Release packages.** `npm run build` makes a `.deb`, an `.rpm`, an Arch
   `PKGBUILD`, and the portable archive. The repository has a Nix flake.
6. **Proof.** GitHub Actions installs and starts ASB in a container of each
   family on every push.

## 2. User decisions (from the interview, do not change)

| Topic | Decision |
| --- | --- |
| Scope | All Linux distributions. |
| Install channels | npm (`npm install -g github:Jamir-boop/ASB`, then `asb setup`, from the multi-machine plan), and release packages that CI builds: `.deb`, `.rpm`, an Arch `PKGBUILD`, and a Nix flake. The packages go on GitHub Releases. The flake is in the repository. |
| Not wanted | Distro repositories (AUR, COPR, OBS, nixpkgs, PPA), and Flatpak, AppImage, or Snap packages of ASB. |
| Old releases | Engine only. The board shows only on releases with new enough libraries. |
| System changes | ASB prints the exact command (package install, firewall rule) and never runs it. ASB never calls `sudo`, `doas`, `pkexec`, `rpm-ostree`, `transactional-update`, a package manager, or a firewall tool to change the system. |
| Tests | GitHub Actions containers, one or more jobs per distro family. |
| EL10 window test (2026-10-20, after the first CI run) | RHEL 10 and its rebuilds have no Xvfb. The alma-10 job stays a board row: CI proves that GTK and Libadwaita load there, but it does not open the ASB window (`window: skip`, 9.2 and 17). |

Out of scope: publishing to distro repositories; ASB as a Flatpak, AppImage,
or Snap; a board for GTK older than 4.12 or Libadwaita older than 1.4 (the
interview option "Lower the board's needs"); autostart on a machine with no
desktop session (a headless server: `asb doctor` prints the manual command);
WSL; BSD systems; 32-bit systems; and a version bump or release (ask the
user).

## 3. Planner decisions (approved by the user on 2026-10-20, do not change)

| # | Decision | Why |
| --- | --- | --- |
| L1 | Two tiers. **Board tier:** Node.js 20 or later (from the distro, or the official route in Appendix B), Python 3.9 or later with PyGObject, GTK 4.12 or later, Libadwaita 1.4 or later, `xdg-utils`, and `openssl`. **Engine tier:** the same without Python, GTK, and Libadwaita. Every release that meets a tier is supported. CI tests the releases in Appendix C. | "All distributions" needs a rule, not a list. |
| L2 | The board floor stays at GTK 4.12 and Libadwaita 1.4: the floor in the interview question and in the current installer. Two guards make the board work there (phase 5). The Remove and Leave dialogs use `Adw.MessageDialog` when `Adw.AlertDialog` (Libadwaita 1.5) does not exist. A message lights its two rows (the path for animations off) when `Gsk.PathBuilder` (GTK 4.14) does not exist. | RHEL, AlmaLinux, and Rocky 9 have GTK 4.12 and Libadwaita 1.4, with updates until 2032. Today the board fails there in these two places (section 6.2). The other choice is a floor of GTK 4.14 and Libadwaita 1.5. It needs no guards, but these releases then run engine only. |
| L3 | No fixed tool paths. Python: `ASB_PYTHON`, then `/usr/bin/python3`, then `python3` on `PATH`. Node: `ASB_NODE`, then `node` on `PATH`, then the current fixed list plus `/home/linuxbrew/.linuxbrew/bin/node`. `xdg-open`, `openssl`, `sqlite3`, and the sound players: `PATH`. | NixOS and Guix have no `/usr/bin/python3`. nvm, fnm, and Homebrew keep Node outside the fixed list. |
| L4 | Engine only: when the board check fails, `asb` starts the engine, writes no desktop entry, prints the reason, and exits with code 3. The tray hides **Open ASB**. The per-user install and `asb setup` succeed with a warning. The `.deb` and the `.rpm` list the board libraries as Recommends (weak dependencies). | The user chose engine only. A hard dependency refuses the install on old releases. |
| L5 | `asb doctor` is read-only. It prints one line per check, then one install command for the missing required packages and one for the missing optional packages. One package table (`src/linux-distros.mjs`, Appendix A) feeds doctor, the README, and CI. `--json` prints the same data. Exit code 0 when the engine can run, else 1. | One source of truth. CI proves the exact commands that users see. |
| L6 | Autostart: the systemd user unit when a systemd user manager answers and `graphical-session.target` is active. Else an XDG autostart entry `~/.config/autostart/asb-engine.desktop` that runs `<launcher> engine start`. With no desktop session, `asb service install` refuses and names `asb engine start`. | Xfce, MATE, LXQt, Cinnamon, window managers, and distributions without systemd do not start `graphical-session.target`. |
| L7 | Runtime folder: `$XDG_RUNTIME_DIR/asb` when it is set. Else `${XDG_STATE_HOME:-~/.local/state}/asb/run` (mode 0700, owner checked). A record whose engine does not answer is stale and is replaced (the rule of multi-machine 14.3). | Some systems without systemd have no `XDG_RUNTIME_DIR`. |
| L8 | Firewall: when phone access or machine links have addresses, and firewalld (`firewall-cmd --state` prints `running`) or ufw (`/etc/ufw/ufw.conf` has `ENABLED=yes`) is active, `asb setup` and `asb doctor` print the exact rule for TCP port 4630 on each selected address. ASB never runs it. | Fedora and openSUSE turn firewalld on by default. Phone access then fails with no reason. |
| L9 | Sounds: the three PC sounds become 16-bit PCM WAV files, decoded from the current MP3 files (the gain stays the same). Players: `pw-play`, then `paplay`, then `aplay`. | MP3 needs libsndfile 1.1 or later, built with MPEG support. WAV plays with every libsndfile and with ALSA alone. Each file grows from about 7 KB to about 41 KB. |
| L10 | App links: `asb doctor` reports the handler of `codex:` and `claude:` links (`xdg-mime query default`). ASB keeps reading only the native app folders. Opening stays `xdg-open <link>`. | Without a handler, Open does nothing and shows no reason. No Flatpak or Snap build of these apps can feed ASB (Appendix F), so ASB needs no other app folders. |
| L11 | Packages. `.deb`: engine needs in Depends, board needs in Recommends. One `noarch` `.rpm` with rich dependencies for the Fedora, RHEL, and openSUSE families. A `PKGBUILD` generated with the SHA-256 of the release archive. A flake (`flake.nix`, `nix/package.nix`) that stages the same runtime files and wraps them with Node, Python, GTK, and Libadwaita. `npm run build` makes all of them except the flake. | One build path and one runtime file list. |
| L12 | CI: a new workflow `.github/workflows/distros.yml`. A host job makes each install command with `src/linux-distros.mjs`. Each matrix job runs one distro image with `docker run`, runs that exact command, and then runs `test/distro-check.sh`. Unit tests stay in `test.yml`. Two jobs run on `ubuntu-24.04-arm`. | CI then proves the commands that `asb doctor` prints. Docker on the host runner works with every image, also Alpine. |
| L13 | ASB never downloads or bundles Node.js. When Node is missing or older than 20, `asb doctor` and the README name the official route for the family (Appendix B). The launcher's error message links to the README. | The user chose printed commands and no bundles. |
| L14 | Library fixes: the board and the tray use `GLibUnix.signal_add` when it exists (GLib 2.80 and later). The QR code shows only when `qrcode` imports and `gi.require_foreign('cairo')` works. | GLib 2.88 removed `GLib.unix_signal_add`. Without PyGObject cairo support, the QR draw callback raises an error. |
| L15 | Order: phase 0 now; phases 1 to 9 after multi-machine phase 4. | They change the same launcher, setup, and package files. |

## 4. Size and risk

Line counts include tests. They are estimates for planning, not promises.

| Phase | Content | Size | Risk | The user must |
| --- | --- | --- | --- | --- |
| 0 | Package table and container spike | S: 300 to 450 lines | Low; can change Appendix A | Approve the branch push for CI |
| 1 | Tool discovery, board check, `asb doctor` | M: 800 to 1,000 lines | Low | Nothing |
| 2 | Engine only | S: 200 to 300 lines | Low | Nothing |
| 3 | Autostart and runtime folder without systemd | M: 350 to 500 lines | Medium (login start on many desktops) | Nothing |
| 4 | Firewall commands | S: 150 to 250 lines | Low | Nothing |
| 5 | Sounds, library fixes, and the L2 guards | S: 150 to 250 lines | Low | Nothing |
| 6 | App link check | S: 80 to 150 lines | Low | Nothing |
| 7 | Release packages | L: 600 to 900 lines | Medium (RPM rich dependencies, Nix wrapping) | Nothing |
| 8 | CI on every family | M: 400 to 600 lines | Medium (board smoke test in containers) | Approve the branch push for CI |
| 9 | Documents | M: 300 to 500 lines | Low | Nothing |

The user also approves each commit and each push (section 8).

Total: about 3,300 to 4,900 changed lines.

## 5. Words used in this plan

| Word | Meaning |
| --- | --- |
| family | Distributions that share a package manager and package names (Appendix A). |
| board tier, engine tier | See L1. |
| board check | The Python probe that reports Python, PyGObject, GTK, Libadwaita, GLib, cairo support, and `qrcode` (phase 1). |
| engine only | ASB runs the engine without the board (L4). |
| image-based system | A distribution with a read-only `/usr` that adds packages with `rpm-ostree` or `transactional-update`, or not at all (Fedora Atomic, openSUSE Aeon, SteamOS). |
| autostart mode | `systemd` or `xdg` (L6). |
| tray host | A program that owns `org.kde.StatusNotifierWatcher` on the session bus. |
| route | The official way to get Node.js 20 or later on a family whose own package is older (Appendix B). |

## 6. Facts about the current code (`main` at 68c40ef)

The anchors in this section come from `main` at `68c40ef`. The phases use
the same names.

### 6.1 Launcher, engine, and packages

- **Commands:** `scripts/asb` (POSIX `sh`) finds Node and runs
  `scripts/asb.mjs`, which dispatches every command (`:23-37`: `engine`,
  `agent`, `bridge`, `group`, `network`, `phone`, `setup`, `service`,
  `--package`, and no command for the board). npm links `asb` to
  `scripts/asb.mjs` directly (`package.json` `bin`), so the npm route skips
  `scripts/asb`. `scripts/asb.mjs:20` checks the Node version only on
  Windows (22.13).
- **Node discovery** (`scripts/asb:10-11`): `$ASB_NODE`, `~/.local/bin/node`,
  `/usr/local/bin/node`, `/usr/bin/node`. Not `PATH`. It needs major version
  20. For all commands except `build`, `uninstall`, `agent`, `group`,
  `network`, `phone`, and `setup` (the `case` at `:9` and the list at
  `:11`), it also needs `node:sqlite` or the `sqlite3` command. Failure: one
  message and exit code 1 (`:17-18`).
- **PATH search:** `findExecutable(name, { platform, env, searchPath })` in
  `src/platform-paths.mjs:27-42` returns the first executable file on
  `PATH`, or `''`.
- **Python** is `/usr/bin/python3` in `scripts/asb-package.mjs:117` (also
  written into the per-user launcher as `ASB_PYTHON`, `:224`),
  `scripts/asb-desktop.mjs:31`, and `scripts/asb-engine.mjs:127`.
- **`checkRuntime`** (`asb-package.mjs:106-127`): Linux, Node 20,
  `node:sqlite` or `sqlite3`, GTK 4.12 and Libadwaita 1.4 through
  `/usr/bin/python3`, and `/usr/bin/xdg-open --version`. Any failure refuses
  the install.
- **Builds** (`build`, `:310-339`): `asb-<version>-linux.tar.gz` and
  `asb_<version>_all.deb`. `DEBIAN_DEPENDS` (`:12`): `nodejs (>= 20), sqlite3,
  python3, python3-gi, gir1.2-gtk-4.0 (>= 4.12), gir1.2-adw-1 (>= 1.4),
  xdg-utils, openssl`. Recommends: `python3-qrcode, pipewire-bin` (`:331`).
  `RUNTIME_FILES` (`:14`) and `copyRuntime` (`:80`) choose the files. The
  commands of `main` (`:341-353`) are `build`, `install`, `uninstall`, and
  `check`. `test/asb-package.test.mjs` builds twice and compares the bytes;
  it reads Depends and Recommends with `dpkg-deb -f`.
- **Desktop entry:** `registerAppIcon` (`scripts/asb-icon.mjs:50`) writes
  `~/.local/share/applications/local.asb.AgentSwitchBoard.desktop` on each
  start, unless `ASB_SYSTEM_INSTALL=1` (`asb-desktop.mjs:21-28`).
- **Board start** (`asb-desktop.mjs`: `start` at `:18-45`, `main` at
  `:47-59`): it starts the engine, registers the icon, and spawns
  `asb-native.py` with the engine URL.
- **Engine start** (`startEngine`, `asb-engine.mjs:147-177`): it refuses
  without a runtime path (`:149`), which on Linux needs `XDG_RUNTIME_DIR`.
  It uses `systemctl --user start` when `asb.service` is enabled (`:153`),
  else a detached `asb-engine.mjs run` that writes `engine.log` in
  `stateDir` (`:38`, `:160-168`).
- **Service** (`scripts/asb-service.mjs`): systemd only. The unit (`:38`) has
  `PartOf`, `After`, and `WantedBy` `graphical-session.target`. Install
  `:88-93`, uninstall `:94-99`, status `:73-79`.
- **Runtime record:** `instanceRuntimePath` (`scripts/asb-instance.mjs:8-11`)
  is `service.json` in `runtimeDir` (`src/platform-paths.mjs:21-25`), which
  is `$XDG_RUNTIME_DIR/asb` on Linux, or `null` without an absolute
  `XDG_RUNTIME_DIR`. `prepareInstanceRuntime` (`asb-instance.mjs:94-128`)
  checks that `XDG_RUNTIME_DIR` exists and is owned by the user (`:98-102`),
  makes the folder with mode 0700, and refuses a record whose PID is alive
  (`:118-126`). On Windows, a live PID counts only when that engine answers
  (`serviceAnswers`, `:82-87`), because Windows soon gives an old PID to a
  new process.
- **`asb setup`** (`scripts/asb-setup.mjs`, `run` at `:60-83`): step 1 runs
  `asb service install` on Linux and waits for the engine; step 2 turns on
  network access; step 3 prints the Windows firewall rule
  (`firewallCommand`, `:33-34`) on Windows only; steps 4 and 5 print the
  bridge and group hints.
- **Tray start** (`asb-engine.mjs:35`, `:126-140`): only with
  `DBUS_SESSION_BUS_ADDRESS`, through `ASB_PYTHON` or `/usr/bin/python3`.
- **Sounds** (`src/asb-sounds.mjs:11-15`, `:66-94`): three MP3 files (mono,
  44.1 kHz, about 0.47 s each). Players `pw-play`, then `paplay`. One log line
  when neither works (`:86`). Windows plays no sounds (`asb-engine.mjs:62`).
- **Certificate** (`src/phone-gateway.mjs:257`): `openssl req ...` on Linux.
  Without `openssl`, no phone or machine listener starts (`:292`).
- **Opening a session** (`src/session-opener.mjs:12`, `:16-17`): `xdg-open
  <link>` from `PATH`, inside `systemd-run --user --scope` when
  `INVOCATION_ID` is set. ASB does not check which app handles `codex:` or
  `claude:` links.
- **App folders:** Codex `~/.codex` (`src/app-sources.mjs:55`); Claude
  `${XDG_CONFIG_HOME:-~/.config}/Claude` on Linux
  (`defaultClaudeAppDir`, `src/claude-data.mjs:12-14`); Claude projects
  `~/.claude/projects`; OpenCode `${XDG_DATA_HOME:-~/.local/share}/opencode`
  (`app-sources.mjs:59-60`, edits refused at `:220-222`).
- **Node features:** `node:sqlite` loads without a flag from 22.13.
  `zlib.zstdDecompressSync` (`src/claude-remote-data.mjs:99`) exists from
  22.15; older Node ignores zstd cache bodies. `npm test` passes
  `--no-experimental-strip-types`, which needs Node 22.6 or later.
- **CI** (`.github/workflows/test.yml`): `node-test` on `ubuntu-latest` with
  Node 22.13 and 24 (`npm test`, the native logic test, `npm run build`,
  and the upload of the `.deb`, the archive, and `SHA256SUMS`);
  `windows-test` (the tests in `test/windows-tests.json`); and
  `bridge-windows`. `bridge.yml`: the bridge tests. No other distribution,
  CPU architecture, or package format.

### 6.2 Board and tray

- **Library needs above the installer floor, with no check:**
  `Adw.AlertDialog` (Libadwaita 1.5) in `MachinesEditor.alert`
  (`scripts/asb-native.py:2470-2483`, the Remove and Leave dialogs), and
  its `force_close()` in `MachinesEditor.set_active` (`:2270`).
  `Gsk.PathBuilder`, `Gsk.Stroke`, `Gtk.Snapshot.append_fill`, and
  `append_stroke` (GTK 4.14) in `snapshot_flights` (`:1211-1257`, the
  message flights). `start_messages` (`:3493-3511`) starts a flight only
  when animations are on, else it calls `light_row`. The `accent-color` use
  (Libadwaita 1.6) is checked (`:3040-3041`).
- **`GLib.unix_signal_add`** at `asb-native.py:5417` and
  `scripts/asb-tray.py:273`. GLib 2.88 removed it from `GLib`.
  `GLibUnix.signal_add` exists from GLib 2.80.
- **QR code:** `qrcode` is optional (`qr_matrix`, `asb-native.py:806-815`).
  The draw callbacks also need PyGObject cairo support (`python3-gi-cairo`
  on Debian), which no package lists. Without it, the draw callback raises
  `TypeError`. The hint texts name `python3-qrcode` (`:1900`, `:2214`).
- **Python:** 3.9 is the floor (`str.removeprefix`). The tray needs only GLib
  and Gio.
- **Desktop:** the board starts no programs, forces the dark style, and has
  no X11 or Wayland branch. `ASB_SNAPSHOT=<file>` saves a PNG after the first
  dashboard and prints `Saved the native ASB window image.`; the window does
  not quit (`:2696`, `:3539-3540`).
- **Tests:** `test/asb_native_logic_test.py` needs only Python 3.8; it loads
  some classes of `asb-native.py` with `ast` and no GTK (`:14-40`).
  `test/asb_native_test.py` (`npm run test:native`) needs a display, the
  Adwaita icon theme, and the Cantarell font; it is not in CI.
  `test/asb_tray_test.py` needs PyGObject with GLib and Gio; it is not in
  CI.

### 6.3 The Debian PC

Debian 13.7, GNOME on X11, GTK 4.18.6, Libadwaita 1.7.6, GLib 2.84.4,
PyGObject 3.50.0, Python 3.13.5, Node 24.20, x86_64.
`graphical-session.target` is active, and `asb.service` runs. Podman and
Docker are not installed; QEMU and Flatpak are. No Codex, Claude, or
OpenCode Flatpak is installed. The other machines run Windows.

## 7. Facts about distributions

Values from the distribution package indexes on 2026-10-19 (a research pass
with sources: repology, the repository of each distribution, and
endoflife.date). Phase 0 records the real values in CI and corrects this
table. "NodeSource" and "module stream" mean the routes in Appendix B.

The first CI run (2026-10-20, run 39405121939) confirmed the GTK,
Libadwaita, and Node.js values of these rows: Debian 12 (4.8.3, 1.2.2),
Debian 13 (4.18.6, 1.7.6, Node 20.19), Ubuntu 22.04 (4.6.9, 1.1.7), Ubuntu
24.04 (4.14.5, 1.5.0), Ubuntu 26.04 (4.22.4, 1.9.1, Node 22.22), AlmaLinux
9.8 (4.12.3, 1.4.2, Python 3.9.25), Tumbleweed (4.22.5, 1.9.4, Node 24.21),
Arch (4.24.1, 1.10.0, Node 26.12), Alpine 3.24 (4.22.4, 1.9.2, Node 24.18),
and Void (4.22.4, 1.9.1, Node 24.18). The arm64 rows gave the same values.
Fedora 43 and 44, AlmaLinux 10, and Leap 16.0 failed on package names (the
notes below). After the fixes, the second run (run 39408877913) passed all
16 jobs and measured them: Fedora 43 (4.20.4, 1.8.8, Node 22.22), Fedora 44
(4.22.5, 1.9.4, Node 22.23), AlmaLinux 10.2 (4.16.7, 1.6.10, Node 22.23,
Python 3.12.14), and Leap 16.0 (4.18.6, 1.7.5, Node 22.23, Python 3.13.14).
No release moved to another tier.

| Release (and its derivatives) | GTK | Libadwaita | Node.js in the repository | Init | Tier |
| --- | --- | --- | --- | --- | --- |
| Debian 12, LTS only (MX 23) | 4.8 | 1.2 | 18 | systemd (MX: sysvinit) | Engine, Node from NodeSource |
| Debian 13 (Devuan 6, MX 25) | 4.18 | 1.7 | 20 | systemd (Devuan: sysvinit or OpenRC) | Board |
| Ubuntu 22.04 (Mint 21, Pop!_OS 22.04, Zorin 17, elementary OS 7) | 4.6 | 1.1 | 12 | systemd | Engine, Node from NodeSource |
| Ubuntu 24.04 (Mint 22, Pop!_OS 24.04, Zorin 18, elementary OS 8) | 4.14 | 1.5 | 18 | systemd | Board, Node from NodeSource |
| Ubuntu 26.04 and 26.10 | 4.22 and 4.24 | 1.9 and 1.10 | 22 and 24 | systemd | Board |
| Fedora 43 and 44 | 4.20 and 4.22 | 1.8 and 1.9 | 22 (also `nodejs24`) | systemd | Board |
| RHEL, AlmaLinux, Rocky 9 (9.8) | 4.12 | 1.4 | 16, retired (module streams `nodejs:22` and `nodejs:24`) | systemd | Board through the L2 guards, Node from the module stream |
| RHEL, AlmaLinux, Rocky 10 | 4.16 | 1.6 | 22 (also `nodejs24`) | systemd | Board |
| openSUSE Leap 16.0 | 4.18 | 1.7 | 22 (`nodejs-default`) | systemd | Board |
| openSUSE Tumbleweed, Slowroll, Aeon | 4.22 | 1.9 | 24 (`nodejs-default`) | systemd | Board |
| Arch, Manjaro, EndeavourOS, CachyOS, Artix | 4.22 to 4.24 | 1.9 to 1.10 | 26 (LTS packages for 20, 22, and 24) | systemd (Artix: OpenRC, runit, s6, dinit) | Board |
| Alpine 3.22 to 3.24 (musl) | 4.18 to 4.22 | 1.7 to 1.9 | 22 or 24 | OpenRC | Board |
| Void (glibc and musl) | 4.22 | 1.9 | 24 | runit | Board |
| Gentoo (stable) | 4.20 | 1.8 | slots for 20 to 26 | OpenRC or systemd | Board (USE flags in Appendix A) |
| Solus | 4.24 | 1.10 | 24 | systemd | Board |
| NixOS 26.05 | 4.22 | 1.9 | 24 | systemd | Board, through the flake |
| Fedora Atomic (Silverblue, Kinoite, Bazzite, Bluefin, Aurora) | as Fedora | as Fedora | not in the image | systemd | Board; Node and the board libraries through `rpm-ostree install` |
| SteamOS 3.8 | 4.18 (repository) | 1.7 (repository) | not in the image | systemd | Engine; read-only system, Node from the nodejs.org archive |

Notes:

- GTK 4.12 and Libadwaita 1.4 came with GNOME 45. Every release with GNOME 45
  or later has both, and so does RHEL 9.8.
- Debian 12, Ubuntu 22.04, and Ubuntu 24.04 ship Node.js 18 or older. The
  `.deb` dependency `nodejs (>= 20)` is then met only through NodeSource.
  Debian 13 ships Node.js 20, which has no built-in SQLite, so ASB uses the
  `sqlite3` program there.
- End of life on 2026-10-19, so not in the table and not tested: Ubuntu
  25.04 and 25.10, Fedora 41 and 42, openSUSE Leap 15.6 (its Python 3.6 is
  also too old), and NixOS 25.05 and 25.11. Alpine 3.21 ends on 2026-11-01.
- SteamOS: an update removes the packages that `pacman` installed. ASB uses
  only what the image has. The board runs only when the image has its
  libraries.
- Fedora 43 and later: `python3-gobject` no longer pulls in
  `gobject-introspection`, the only package with the `cairo-1.0` and
  `freetype2-2.0` typelibs. Without it, GTK does not import (first CI run),
  so Appendix A adds it to the `gtk` key.
- RHEL 10 and its rebuilds have no Xvfb: the X.Org server was removed, and
  `xwfb-run` (package `xwayland-run`) replaces `xvfb-run`. CI does not open
  the window on alma-10 (section 2).
- openSUSE: `dbus-run-session` is in `dbus-1-daemon`, because dbus-broker is
  the default bus since 2024. Leap 16.0: `/usr/bin/python3` comes from the
  `python3` wrapper package, not from `python313-base`.
- Arch and Alpine: the cairo support of PyGObject needs pycairo
  (`python-cairo`, `py3-cairo`), and the PyGObject package does not pull it
  in.
- Fedora and openSUSE turn firewalld on by default. Ubuntu ships ufw turned
  off.
- Distributions without systemd (Alpine, Void, Artix, Devuan, Gentoo with
  OpenRC, MX Linux) need the XDG autostart mode (L6). Some have no
  `XDG_RUNTIME_DIR` without elogind (L7).
- Cinnamon, Xfce, MATE, LXQt, and window managers do not reach
  `graphical-session.target`, also on systemd distributions.
- Tray hosts: KDE Plasma, Cinnamon, Xfce (status tray plugin), MATE (with
  the indicator applet), LXQt, Budgie, Waybar, and COSMIC have one. Stock
  GNOME has none (the AppIndicator extension adds one; Ubuntu ships it).
- Apps (Appendix F): Claude Desktop for Linux (beta) is a `.deb` for Ubuntu
  22.04 or later and Debian 12 or later. The ChatGPT app with Codex
  (preview) supports Ubuntu 24.04 and 26.04, Debian 13, Fedora 43 and 44,
  and Arch. On other releases, ASB still shows the sessions of the Codex and
  Claude Code CLIs (view-only cards) and of the other machines.

## 8. Working rules

- Follow `AGENTS.md`. Run `(umask 022; npm test)` after behavior changes:
  with umask 077, the package test fails on file modes.
- After board or tray changes, run `python3 test/asb_native_logic_test.py`
  and `python3 -m unittest discover -s test -p 'asb_tray_test.py'`.
  (`python3 -m unittest test/asb_tray_test.py` fails: the module name
  `test` is the Python standard library test package.)
- Keep ASB dependency-free: no npm packages, no Python packages besides
  PyGObject and the optional `qrcode`.
- ASB never runs `sudo`, `doas`, `pkexec`, `rpm-ostree`,
  `transactional-update`, a package manager, or a firewall change. Tests must
  prove that doctor and setup only print these commands. Read-only queries
  (`openssl version`, `firewall-cmd --state`, `xdg-mime query default`,
  `systemctl --user is-active`) are allowed.
- Never read credentials or message text. Besides ASB's own files and the
  app folders that ASB already reads, `asb doctor` reads only
  `/etc/os-release`, `/run/ostree-booted`, `PATH`, the session bus names,
  `/etc/ufw/ufw.conf`, the output of the read-only queries above, the
  Python probe, and `GET /api/service` and `GET /api/phone` of the local
  engine.
- Do not change user or planner decisions. If a fact in this plan is wrong,
  stop and report it.
- The implementing agent does not commit, push, publish a release, or change
  the version. At the end of each phase, it stops and reports to the
  reviewer (the session that gave it this plan): the changed files, each
  check with its result, and the open questions. The reviewer examines the
  diff, runs the checks again, and asks the user before each commit and each
  push. The commit lines in the phases are the messages for these commits
  (Conventional Commits, no AI attribution, no Co-Authored-By trailer).
- Do every check with commands. Never ask the user to click, look, listen,
  or start an app. Never send input to the user's display. Run the GTK tests
  (`npm run test:native`) only on a hidden display.
- Do not install system packages, and do not use `sudo`. Do not stop,
  restart, reinstall, or reconfigure the user's ASB (`asb.service`, the
  installed launcher, and its settings): the phone uses it. Use temporary
  `HOME`, `XDG_*`, and `PORT` values for the tests that start an engine.
- After each phase, check whether `SYSTEM_OVERVIEW.md`, `README.md`,
  `ASB.md`, and `CHANGELOG.md` need an update. Phase 9 does the full pass.

---

## 9. Phase 0: package table and container spike

Phase 0 adds new files only.

### 9.1 Package table

Create `src/linux-distros.mjs` (no imports outside `node:`):

1. `FAMILIES`: one entry per family of Appendix A, with `ids` (values of
   `ID`), `like` (values of `ID_LIKE`), `install` (the command words without
   the root prefix, for example `['apt', 'install']`), `ci` (the CI install
   words, 9.2 step 3), and `packages` (a map
   from each key of Appendix A to one or more package names, or `null` when
   the family has no package for it).
2. `parseOsRelease(text)`: the `KEY=value` lines of
   [os-release(5)](https://www.freedesktop.org/software/systemd/man/latest/os-release.html),
   with shell quotes removed. `ID_LIKE` becomes an array.
3. `detectFamily(release, { ostreeBooted })`: match `ID` against `ids`
   first, then each `ID_LIKE` value against `like`. The result is
   `{ family, mode }`. `mode` is `transactional` when `ostreeBooted` is true
   (Fedora Atomic) or `ID` is `opensuse-microos`, `opensuse-aeon`, or
   `opensuse-kalpa`; `readonly` for `ID=steamos`; else `normal`. No match
   gives `{ family: null, mode: 'normal' }`.
4. `installCommand(family, keys, { mode, root })`: the package names for
   the keys, without duplicates, in key order, after the root prefix and the
   install words. `root` comes from the caller: `sudo` (the default) or
   `doas`; another value throws. The module stays synchronous with `node:`
   imports only, so the caller finds the root command (10.2). Transactional
   mode uses `rpm-ostree install` (Fedora) or
   `transactional-update pkg install` (openSUSE). Read-only mode, NixOS, and
   an unknown family give `null`.
5. `nodeRoute(release, family, { mode })`: the Node.js route of Appendix B.
   It gives `{ command }` (an array of words without the root prefix) for
   release 9 of RHEL and its rebuilds: `ID` is `rhel`, `centos`,
   `almalinux`, `rocky`, or `ol`, or `ID_LIKE` has `rhel`, and `VERSION_ID`
   starts with `9`. It gives `{ text }` for the `debian` family and for
   read-only mode. Else it gives `null`.
6. A "run when main" block for CI (CI runs as root, so no root prefix).
   Compare `realpathSync(process.argv[1])` with the module path, as
   `scripts/asb.mjs:42` does, so that a path with a symlink also works:
   - `node src/linux-distros.mjs <family> <key>...` prints the CI form of
     the install command on one line: the `ci` words of the family (9.2
     step 3), then the package names. It exits with code 1 when the family
     has no `ci` words.
   - `node src/linux-distros.mjs detect` reads `/etc/os-release` and
     `/run/ostree-booted` and prints `<family> <mode>` (`none` when no
     family matches).
   - Other arguments print a usage line and exit with code 2.

Tests in a new `test/linux-distros.test.mjs`: `parseOsRelease` with quotes,
comments, and empty lines; `detectFamily` for every `ID` of section 7 and
Appendix A (use real os-release texts as fixtures); `installCommand` for each
family and mode; `doas` versus `sudo`; `nodeRoute` for Debian 12, Linux Mint
22, AlmaLinux 9, Oracle Linux 9, AlmaLinux 10 (`null`), Fedora 44 (`null`),
and SteamOS.

### 9.2 Container spike

Create `.github/workflows/distros.yml` with one matrix job per row of
Appendix C, except the `nix` row (phase 8 adds it). Triggers: `push` on
every branch, and `workflow_dispatch` (Goal 6). Use the action versions of
`test.yml` (`actions/checkout@v4`, `actions/setup-node@v4`,
`actions/upload-artifact@v4`). Each matrix entry has `job`, `image`,
`runner`, `family`, `tier` (`board` or `engine`), and `node` (`repository`,
`nodesource`, or `module`). The alma-10 entry also has `window: skip`
(section 2): it leaves `xvfb` out of the keys and gives the container
`-e ASB_PROBE_WINDOW=skip`.

1. Check out the repository on the runner of the row (`ubuntu-latest`, or
   `ubuntu-24.04-arm` for the arm64 rows) and set up Node 24 there.
2. On the host: `node src/linux-distros.mjs <family> <keys>` for all the
   keys of Appendix A (required, board, optional, and CI) on every row, so
   that every name is proved. On the `nodesource` and `module` rows, leave
   `node` out of the keys.
3. `docker run --rm -v "$PWD:/asb:ro" -v "$RUNNER_TEMP/out:/out" -e
   ASB_PROBE_OUT=/out/probe.json <image> sh -eu -c "<refresh>; <route>;
   <install command>; sh /asb/test/distro-probe.sh <tier> <family>"`.
   `<refresh>` is the index update of the family: `apt-get update`,
   `pacman -Syu --noconfirm` (a partial upgrade can break the install), `apk
   update`, or `xbps-install -Syu xbps` (the image must update xbps first);
   nothing for dnf and zypper. `<route>` is empty on `repository` rows, else
   the CI route of Appendix B. Keep `<refresh>` and `<route>` in the
   workflow (a `case` on the family or the `node` value), not in
   `FAMILIES`. For apt, set `DEBIAN_FRONTEND=noninteractive` and add
   `-y`; for dnf add `-y`; for zypper use `--non-interactive`; for pacman
   add `--noconfirm`; for xbps add `-y`; apk needs none. Keep them in
   `FAMILIES` as `ci`: the full CI install words of the family, for example
   `['zypper', '--non-interactive', 'install']` (a global option comes
   before the subcommand). `ci` is `null` for Gentoo, Solus, and NixOS.
4. Create `test/distro-probe.sh` (POSIX `sh`, no Bash features). It prints
   one JSON object with:
   - `ID`, `ID_LIKE`, and `VERSION_ID` from `/etc/os-release`, and the
     output of `node <repository>/src/linux-distros.mjs detect`;
   - the versions of `node`, `sqlite3`, `openssl`, and `xdg-open`, and
     whether `node:sqlite` loads;
   - from one `python3 -c` probe: the Python, PyGObject, GTK, Libadwaita,
     and GLib versions, whether `gi.require_foreign('cairo')` works, and
     whether `qrcode` imports (import GTK and Libadwaita in `try` blocks),
     and `board_error`: the first line of the first error of the PyGObject,
     GTK, and Libadwaita imports, or `null` when all three load;
   - the paths of `pw-play`, `paplay`, `aplay`, `xvfb-run`, and
     `dbus-run-session`, or `null`.
   It exits with code 1 when `node`, `openssl`, or `xdg-open` does not
   run, when `node` is older than 20 (L1), when neither `node:sqlite` loads
   nor `sqlite3` runs (the rule of `engineCheck`), when the detected family
   is not the `<family>` argument, or, for the `board` tier, when Python is
   older than 3.9 (L1), PyGObject is missing, GTK is older than 4.12,
   Libadwaita is older than 1.4, or `xvfb-run` or `dbus-run-session` is
   missing (phase 8 needs them; with `ASB_PROBE_WINDOW=skip`, `xvfb-run` is
   not checked). Make the JSON with `printf` and a small
   escape function, not with Python or Node, which can be missing; the
   Python probe prints its own part with `json.dumps`, or the probe writes
   `null` for that part. It prints the JSON object first in each case, and
   when `ASB_PROBE_OUT` is set, it also writes the object to that file. It
   finds `src/linux-distros.mjs` from its own path (`$(dirname "$0")/..`),
   so it also runs on the Debian PC.
5. Each job uploads `$RUNNER_TEMP/out/probe.json` as the artifact
   `distro-probe-<job>`, also when the probe fails (`if: always()`).

### Phase 0 gate

- Local checks first: `(umask 022; npm test)` passes; `sh -n
  test/distro-probe.sh` passes; PyYAML loads `.github/workflows/distros.yml`;
  on the Debian PC, `sh test/distro-probe.sh engine debian` exits with code
  0 and prints one JSON object that `python3 -m json.tool` accepts, and
  `node src/linux-distros.mjs detect` prints `debian normal`.
- Then the reviewer pushes the branch (after the user approves) and reads
  the run. All jobs pass, or the worker corrects Appendix A and section 7
  from the probe results, and the reviewer pushes again.
- If a release moves from the board tier to the engine tier, a family
  cannot install a required key, or a board-tier row cannot install the CI
  keys (for example Xvfb), stop and report to the user before phase 1.
- Commit: `feat(distros): add the Linux package table and the container probe`.

## 10. Phase 1: tool discovery, board check, and `asb doctor`

### 10.1 Find the tools (L3)

1. `scripts/asb`: in the candidate list (`:10`), put `$(command -v node ||
   true)` after `"${ASB_NODE:-}"`, and `/home/linuxbrew/.linuxbrew/bin/node`
   after `"$HOME/.local/bin/node"`. Add `doctor` to the commands that skip
   the SQLite check (the `case` at `:9` and the list at `:11`), so that
   doctor can report a missing SQLite. Add one sentence to the failure
   message (`:17`): `Install help: https://github.com/Jamir-boop/ASB#nodejs`.
   That link needs the README `Node.js` section of 10.4 in the same phase.
2. `scripts/asb.mjs`:
   - Dispatch `doctor` to `scripts/asb-doctor.mjs` (Linux only), next to
     `service` (`:34`), as the other commands do.
   - npm runs `scripts/asb.mjs` without `scripts/asb`. On Linux, when the
     Node major version is below 20, print the message of `scripts/asb:17`
     (with the new sentence) and return 1, next to the Windows check
     (`:20`).
   - Tests: add cases to `test/asb-windows.test.mjs`, which already calls
     this `main` with fake `platform`, `version`, and `load` values.
3. Create `src/linux-system.mjs`. Every `PATH` search uses `findExecutable`
   from `src/platform-paths.mjs` (`:27-42`, `''` when nothing is found). Do
   not write a second `PATH` search.
   - `pythonCandidates(env)` (async): when `env.ASB_PYTHON` is absolute, it
     is the only candidate (the user or a package chose it). Else
     `/usr/bin/python3` when it is an executable file, then
     `findExecutable('python3', { env })`, without duplicates. A relative
     `ASB_PYTHON` is ignored.
   - `probePython(python, { execFile, env })`: run `python -c <probe>` with a
     5 s timeout. The probe prints one JSON object: `python` (version),
     `gi` (PyGObject version or `null`), `gtk`, `adw`, `glib` (arrays of three
     numbers, or `null`), `cairo` (true when `gi.require_foreign('cairo')`
     works), `qrcode` (true when it imports), and `trayHost` (true, false, or
     `null`: `org.kde.StatusNotifierWatcher` has an owner on the session bus;
     `null` without `DBUS_SESSION_BUS_ADDRESS`; use a 1 s D-Bus timeout).
     Import GTK and Libadwaita inside `try` blocks; they import without a
     display.
   - `boardCheck({ env, execFile })`: probe the candidates in order. Use the
     first candidate with `gi`. Result: `{ ok, python, versions, reason }`.
     `ok` needs Python 3.9, GTK 4.12, and Libadwaita 1.4 (L2). `reason` is a
     sentence, for example `GTK 4.8 is older than 4.12.` or
     `PyGObject is not installed.`
   - `engineCheck({ env, node })`: Node major version 20, `node:sqlite`
     or `sqlite3` on `PATH`, `openssl` on `PATH`, and `xdg-open` on `PATH`.
     `node` is the facts of the running Node (10.2); it runs no program.
4. `scripts/asb-desktop.mjs:31` and `scripts/asb-engine.mjs:129` (`main`
   at `f1927b6`): use
   `env.ASB_PYTHON`, else the `python` of `boardCheck` (the desktop) or the
   first candidate with `gi` (the tray). Without one, the tray does not start
   and the engine prints one line.
5. `scripts/asb-package.mjs` `checkRuntime` (`:107-128` at `f1927b6`): use
   `engineCheck` (failure refuses the install) and `boardCheck` (failure
   prints `ASB will run without its window: <reason> Run asb doctor for
   details.` and the install continues). Keep the `sqliteDirectory` result.
   Write `ASB_PYTHON` into the launcher (`:225`) only when a Python with `gi`
   was found. Remove the fixed `/usr/bin/python3` and `/usr/bin/xdg-open`
   paths.
6. Add `scripts/asb-doctor.mjs`, `src/linux-system.mjs`, and
   `src/linux-distros.mjs` to `RUNTIME_FILES` (`scripts/asb-package.mjs:14`),
   so that the `.deb` and the archive have them. The test "ASB payload
   imports are complete" (`test/asb-package.test.mjs:55`) checks the static
   imports, but not the `script()` dispatch of `scripts/asb.mjs`.

### 10.2 `asb doctor` (L5)

Create `scripts/asb-doctor.mjs` with `main(argv)`, `collect(deps)`, and
`format(data)`. Dispatch `asb doctor` from `scripts/asb.mjs`. Arguments:
none, or `--json`. `collect` takes its readers and `execFile` as arguments,
so that tests can fake the system. `collect` finds `sudo` and `doas` with
`findExecutable` and gives `root: 'doas'` to `installCommand` when `doas`
is found and `sudo` is not; else `sudo`.

Checks, in this order (Appendix D has the output):

| Group | Check | Status words |
| --- | --- | --- |
| System | Distribution (`PRETTY_NAME`), family, mode | info |
| Engine | Node.js (path, version, built-in SQLite) | ok, missing, old |
| Engine | `sqlite3` (only when Node has no `node:sqlite`) | ok, missing |
| Engine | `openssl`, `xdg-open` | ok, missing |
| Window | Python, PyGObject, GTK, Libadwaita | ok, missing, old |
| Options | QR code (`qrcode` and cairo support) | ok, missing |
| Options | Sounds (first player found) | ok, missing |
| Options | Tray host | ok, info (none found; name the GNOME AppIndicator extension) |
| Options | Bun (for ASB Bridge) | ok, info |

Phases 3, 4, and 6 add the autostart, runtime folder, firewall, and link
checks.

Sources of the checks:

- The first line is `ASB doctor: <PRETTY_NAME>, family <family>`, with
  `, <mode>` after it when the mode is not `normal`, and `family unknown`
  when no family matches.
- Node.js is the running Node (`process.execPath`, `process.versions.node`,
  and whether `node:sqlite` imports). `scripts/asb` and `scripts/asb.mjs`
  refuse Node older than 20 before doctor runs, so `collect` takes these
  facts as an argument, and the tests fake Node 18 and no Node.
- Sounds: the first program of the `PLAYERS` list of `src/asb-sounds.mjs`
  (`:66`) on `PATH`. Export that list; do not copy the names.
- The Gentoo note and the image-based note of Appendix A are printed after
  the commands of that family or mode.

Commands after the checks:

1. **Required:** one `installCommand` for the missing engine keys and the
   missing (not old) board keys.
2. **Optional:** one `installCommand` for the missing optional keys.
3. **Node.js** (`nodeRoute`, 9.1). When Node is missing and the route is a
   `command`, print the route with the root prefix before the required
   command, and leave `node` out of the required command. When Node is
   missing and the route is a `text` or `null`, add `node` to the required
   command, and print a `text` route under it after `If this Node.js is
   older than 20:`. When Node is older than 20, print only the route.
4. **Old libraries:** when GTK or Libadwaita is old, print
   `This system has GTK <x> and Libadwaita <y>. The ASB window needs GTK 4.12
   and Libadwaita 1.4, so ASB runs without its window. The phone and your
   other machines still show this machine's sessions.` and no package for
   them.
5. **No command** (NixOS, read-only mode, unknown family): print the needs in
   words. For NixOS print `Use the flake: nix profile install
   github:Jamir-boop/ASB`. In read-only mode, also print the route text when
   Node is missing or old.

Exit code 0 when the engine can run, else 1. `--json` prints
`{ schema: 1, system, checks: [{ id, group, status, detail }], board:
{ ok, reason }, commands: { required, optional, node, firewall } }` with each
command as an array of words.

`asb setup` (`scripts/asb-setup.mjs`, `run` at `:60-83`): add step 0 on
Linux. Run `collect`, print the `format` lines, and stop with exit code 1
when the engine cannot run. Give `main` (`:85-88`) a `doctor` option with
the real `collect` as its default, as it has `installService`, so that the
tests can fake it (the setup tests are in `test/asb-group.test.mjs` and
`test/asb-windows.test.mjs`).

### 10.3 Tests

- New `test/linux-system.test.mjs`: Python order (`ASB_PYTHON` alone, else
  `/usr/bin/python3`, then `PATH`); a system without `/usr/bin/python3` (fake
  candidates); a relative `ASB_PYTHON` is ignored;
  `boardCheck` with fake probe outputs (missing `gi`; GTK 4.8 with
  Libadwaita 1.2 gives `ok: false`; GTK 4.12 with Libadwaita 1.4 gives
  `ok: true`); `engineCheck` with a fake `PATH` of stub scripts.
- New `test/asb-doctor.test.mjs`: the output of Appendix D for a fake
  Debian 13 system with all checks ok; a fake Fedora system with missing
  board packages (one `sudo dnf install` line); a fake Ubuntu 22.04 system
  (engine only, no board packages); Node 18 (route only); AlmaLinux 9
  without Node (the module command, and no `nodejs` in the required
  command); NixOS (flake line); exit codes; and a check that `collect`
  calls `execFile` only with the read-only programs of section 8.
- Update `test/asb-package.test.mjs` for `checkRuntime`: a board failure
  does not refuse the install, and the launcher has no `ASB_PYTHON` line
  when no Python with `gi` was found.

### 10.4 Documents

Phase 1 adds a user command and new reads, so it updates the documents for
them (section 8). Phase 9 does the full pass.

- `README.md`: a `Node.js` section (anchor `#nodejs`, which the launcher
  message links) with the Node.js 20 floor and the routes of Appendix B, and
  one line in "Install on Linux": run `asb doctor` to check the system; it
  prints the install commands and never runs them.
- `CHANGELOG.md` (Unreleased): `asb doctor`, the Python and Node.js search,
  and the install that continues without the window.
- `SYSTEM_OVERVIEW.md`: rows for `src/linux-system.mjs` and
  `src/linux-distros.mjs` in the module table (`:136` has the
  `src/platform-paths.mjs` row), and the new count of the runtime file list
  (`:106`).
- `docs/PRIVACY.md`: what doctor reads (section 8).

### Phase 1 acceptance

- `(umask 022; npm test)` passes.
- On the Debian PC, `scripts/asb doctor` shows every engine and window check
  as ok, the QR code as ok, the sound player `pw-play`, Bun as ok, and no
  commands. It exits with code 0.
- On the Debian PC, `ASB_PYTHON=/bin/false scripts/asb doctor` reports the
  window as not available and still exits with code 0.
- `scripts/asb doctor --json | python3 -m json.tool` succeeds.
- `RUNTIME_FILES` and `npm pack --dry-run` have the three new runtime files,
  and the README has the `Node.js` heading (10.4).
- Commit: `feat(doctor): check the system and print the install commands`.

## 11. Phase 2: engine only (L4)

1. `scripts/asb-desktop.mjs` `start()` (`:18-45`): after `startEngine()`,
   run `boardCheck`. When it fails, do not call `registerAppIcon` and do not
   spawn the window. Print `ASB runs without its window on this system:
   <reason> The engine runs for the phone and your other machines. Run asb
   doctor for details.` and exit with code 3. The engine keeps running.
   Phase 1 runs `boardCheck` there only without `ASB_PYTHON` (to find the
   Python). Phase 2 runs it always: an absolute `ASB_PYTHON` is then the
   only candidate.
2. `scripts/asb-engine.mjs` `runEngine` (tray start at `:126-140`): run
   `boardCheck` once before the tray starts. When it fails, start the tray
   with `ASB_BOARD=0` in its environment. Phase 1 runs it only without
   `ASB_PYTHON`, and starts no tray (one error line) when no Python has
   `gi`. Keep that rule, and run the check always.
3. `scripts/asb-tray.py`: with `ASB_BOARD=0`, the menu has only **Quit ASB**,
   and a left click (`Activate`) does nothing. Keep the menu layout in the
   pure functions; add cases to `test/asb_tray_test.py`.
4. `scripts/asb-package.mjs` `install()` (`:161`): when the board check
   fails, skip both `registerAppIcon` calls (`:185` and `:234`), and leave
   the `icon` and `desktop` paths (`:134-135`) out of the install record.
   `uninstall()` (`:269`) already skips missing files; add a test.
5. `asb setup`: no change. Step 0 (10.2) already prints the reason.
6. Tests: `test/asb-desktop.test.mjs` (board check fails: no registration,
   no window, exit code 3, engine started); the tray menu cases; the install
   record without the desktop keys; `runEngine` with a fake `execFile` (in
   `test/asb-service.test.mjs`, next to the tray test at `:499`): a board
   failure starts the tray with `ASB_BOARD=0`, and no Python with `gi`
   starts no tray and prints one line.

### Phase 2 acceptance

- `(umask 022; npm test)` and
  `python3 -m unittest discover -s test -p 'asb_tray_test.py'` pass. `npm run test:native` passes on the hidden display.
- On the Debian PC, with the user's engine running,
  `ASB_PYTHON=/bin/false scripts/asb` prints the engine-only message and
  exits with code 3. It only reads the user's engine: `scripts/asb engine
  status` shows the same PID before and after.
- Commit: `feat(engine): run without the window when the board libraries are old`.

## 12. Phase 3: autostart and runtime folder without systemd (L6, L7)

### 12.1 Autostart mode

1. In `scripts/asb-service.mjs`, add `autostartMode({ env, execFile })`:
   - `systemd` when `systemctl --user show-environment` exits with code 0
     and `systemctl --user is-active graphical-session.target` prints
     `active`.
   - `xdg` when the first check fails or the target is not active, and
     `XDG_CURRENT_DESKTOP` or `DESKTOP_SESSION` is set.
   - `none` otherwise.
2. `asb service install`:
   - `systemd`: the current unit (`:88-93`).
   - `xdg`: write `${XDG_CONFIG_HOME:-~/.config}/autostart/asb-engine.desktop`
     with the same safety rules as the unit (marker line, `atomicWrite`, no
     write through links, the Node and launcher path rules of
     `serviceUnit`). Content in Appendix E. Then call `startEngine()` and
     print `ASB starts at login through XDG autostart. Window managers
     without XDG autostart must run: <launcher> engine start`.
   - `none`: change nothing. Print `No desktop session was found. Run asb
     service install from your desktop session, or run <launcher> engine
     start after you log in.` and exit with code 1. `asb setup` step 1
     (`scripts/asb-setup.mjs:63-64`) then stops with its current message;
     keep that (a machine without a desktop session is out of scope,
     section 2).
   - When the other mode's file exists and has ASB's marker, remove it
     (for the unit: `systemctl --user disable --now asb.service` first).
3. `asb service uninstall`: remove the unit (as today) or the autostart
   entry (marker checked), then stop the engine with `POST /api/engine/stop`
   in the `xdg` case.
4. `asb service status`: print the mode and the state. `systemd`: the
   current output. `xdg`: `XDG autostart entry: <path>` and `Engine: running`
   or `Engine: not running`.
5. `asb doctor`: add the check `Autostart` (`systemd user service`, `XDG
   autostart`, or `not installed`).

### 12.2 Runtime folder

1. `runtimeDir` (`src/platform-paths.mjs:21-25`), Linux branch:
   `$XDG_RUNTIME_DIR/asb` when `XDG_RUNTIME_DIR` is absolute, else
   `path.posix.join(stateDir(env, platform, home), 'run')`, which is
   `${XDG_STATE_HOME:-~/.local/state}/asb/run`. Change the comment at `:21`.
   `instanceRuntimePath` (`scripts/asb-instance.mjs:8-11`) then never gives
   `null` on Linux.
2. `prepareInstanceRuntime` (`asb-instance.mjs:94-128`), root check
   (`:98-102`): with an absolute `XDG_RUNTIME_DIR`, keep the current check
   (an absolute `XDG_RUNTIME_DIR` that does not exist is still refused).
   With the fallback, the root is `stateDir`: create it with
   `mkdir(..., { recursive: true, mode: 0o700 })` when it is missing, then
   check that it is a folder owned by the user and not a link. The `run`
   folder gets the same mode 0700 and owner checks as today. Change the
   Linux message at `:101` to name the folder that failed.
3. Stale record (`:118-126`): with the fallback folder, a live PID counts
   only when that engine answers (`answers(saved)`), as on Windows: the
   folder survives a restart, so its PID can belong to another process now.
   With `XDG_RUNTIME_DIR` (a `tmpfs` that a restart clears), keep the
   current rule.
4. Remove the refusal in `startEngine` (`asb-engine.mjs:149`).
5. `asb doctor`: add the check `Runtime folder` (the folder in use, and
   `XDG_RUNTIME_DIR is not set` as info).

### 12.3 Tests

- `test/asb-service.test.mjs`: the three modes with a fake `execFile` and
  environment; install, status, and uninstall in `xdg` mode with a temporary
  `XDG_CONFIG_HOME`; a foreign autostart file is kept; a mode change removes
  the other file.
- `test/asb-service.test.mjs:175-183` (`service run needs an absolute
  existing runtime directory`): change it. An empty or relative
  `XDG_RUNTIME_DIR` now starts the engine with its record in
  `<XDG_STATE_HOME>/asb/run/service.json` (folder 0700, file 0600; stop the
  engine at the end of the test). An absolute `XDG_RUNTIME_DIR` that does
  not exist is still refused with the new message.
- `test/platform-paths.test.mjs:24-29`: the Linux `runtimeDir` gives the
  fallback folder instead of `null`.
- A stale record in the fallback folder whose PID is alive (use the PID of
  the test process) and does not answer is replaced. The same record in an
  `XDG_RUNTIME_DIR` folder is still refused with no request: keep the
  Linux part of `test/asb-win32-files.test.mjs:49-51` as it is.

### Phase 3 acceptance

- `(umask 022; npm test)` passes.
- On the Debian PC (`systemd` mode), `scripts/asb service status` behaves
  as before, and `autostartMode()` with the real environment gives
  `systemd`. Do not reinstall or stop the user's service: the phone uses it.
- Unit tests cover the `xdg` mode and the fallback folder. Phase 8 proves
  both on real systems: containers have neither systemd nor
  `XDG_RUNTIME_DIR`.
- Commit: `feat(service): start the engine at login without systemd`.

## 13. Phase 4: firewall commands (L8)

1. In `scripts/asb-doctor.mjs`, add `firewallState({ execFile, readFile })`:
   `firewalld` when `firewall-cmd --state` exits with code 0 and prints
   `running`; `ufw` when `/etc/ufw/ufw.conf` has a line `ENABLED=yes`; else
   `none`. A missing program or file means "not this firewall".
2. Add `linuxFirewallLines(state, addresses, port, { execFile })` next to
   it. `addresses` are the selected entries of `/api/phone` (`{ address,
   interface }`), and `port` is the phone access port (4630 by default).
   For each address:
   - firewalld: `sudo firewall-cmd --permanent --add-rich-rule='rule
     family="ipv4" destination address="<address>" port port="<port>"
     protocol="tcp" accept'`, then once `sudo firewall-cmd --reload`. When
     `firewall-cmd --get-zone-of-interface=<interface>` names a zone, add
     `--zone=<zone>` after `--permanent`.
   - ufw: `sudo ufw allow in on <interface> to <address> port <port> proto
     tcp`.
   - Print them under `Phone access and machine links through <firewall>:`.
   - Use the root command that `collect` found for `installCommand` (10.2).
3. `asb doctor`: when the engine runs (`findRunningService`), read
   `/api/phone` with `api` (`scripts/asb-group.mjs:48`). When `enabled` is
   true, map each of `bindAddresses` to its entry in `addresses` (the
   interface) and print the lines of step 2. When the engine does not run
   or access is off, print no firewall lines. Put the lines in
   `commands.firewall` of the JSON output.
4. `asb setup`, step 3 (`scripts/asb-setup.mjs:73-78`): on Linux, print the
   lines of step 2 for the chosen addresses and `saved.port`, in the place
   where Windows prints `firewallCommand`.
5. Tests: fake `execFile` and `readFile` for firewalld (with and without a
   zone), ufw, and none; doas; the doctor and setup outputs; no command
   other than the read-only queries is ever run (the fake `execFile`
   records every call).

### Phase 4 acceptance

- `(umask 022; npm test)` passes.
- On the Debian PC (no firewall), doctor prints no firewall lines.
- Commit: `feat(doctor): print the firewall rule for phone access`.

## 14. Phase 5: sounds and library fixes (L2, L9, L14)

1. Decode the three sounds with
   `ffmpeg -i <name>.mp3 -fflags +bitexact -flags:a +bitexact -map_metadata -1 -c:a pcm_s16le <name>.wav`.
   Keep the names (`opencode_staplebops_01.wav` and so on). Delete the MP3
   files from `assets/sounds/`. The Android app keeps its own files.
2. Change the file names in `SOUND_FILES` (`src/asb-sounds.mjs:12-14`),
   `RUNTIME_FILES` (`scripts/asb-package.mjs:21`), `test/asb-sounds.test.mjs`
   (`:93`, `:107-109`), and `SYSTEM_OVERVIEW.md:303` (also add `aplay -q`
   to its player sentence). `README.md:92` names no file format: keep it.
   Add one `CHANGELOG.md` Unreleased line.
3. Add `['aplay', (file) => ['-q', file]]` after `paplay` in `PLAYERS`
   (`:66-69`). Change the message (`:86`) to `ASB cannot play sounds: install
   pw-play (PipeWire), paplay (PulseAudio), or aplay (ALSA). Run asb doctor
   for the command.`
4. Board and tray: add a helper that uses `GLibUnix.signal_add` when
   `gi.require_version('GLibUnix', '2.0')` and the import work, else
   `GLib.unix_signal_add`. Use it at `asb-native.py:5417` and
   `asb-tray.py:273`.
5. Board QR code: `qr_matrix` (`asb-native.py:806-815`) returns `None`
   also when `gi.require_foreign('cairo')` raises `ImportError`. Change the
   hint texts (`:1900`, `:2214`) from naming `python3-qrcode` to `Install
   the Python qrcode module and PyGObject cairo support. Run asb doctor for
   the command.`
6. Libadwaita 1.4 (L2): in `MachinesEditor.alert` (`asb-native.py:2470-2483`), when `Adw`
   has no `AlertDialog`, make
   `Adw.MessageDialog(transient_for=self.preferences, modal=True,
   heading=heading, body=body)` with the same responses, response
   appearance, default response, and close response. Connect its `response`
   signal to `chosen` and to a handler that clears `self.dialog` (the
   `closed` handler does this for `Adw.AlertDialog`). Call `present()` with
   no argument. In `MachinesEditor.set_active` (`:2269-2270`), call
   `force_close()` on an `Adw.AlertDialog` and `destroy()` on an
   `Adw.MessageDialog`.
7. GTK 4.12 (L2): in `start_messages` (`:3505`, `if not animations:`), take
   the `light_row` path also when `Gsk` has no `PathBuilder`.
8. Tests: the player order with three players in `test/asb-sounds.test.mjs`;
   the QR fallback in `test/asb_native_logic_test.py` (fake a failing
   `require_foreign`); the signal helper in `test/asb_tray_test.py`. In
   `test/asb_native_logic_test.py`, load `MachinesEditor` as the file loads
   `PhoneEditor`, and check `alert` with a fake `Adw` with and without
   `AlertDialog`. Check that `start_messages` lights the rows and starts no
   flight when the fake `Gsk` has no `PathBuilder`.

### Phase 5 acceptance

- All checks of section 8 pass, and `npm run test:native` passes on the
  hidden display.
- For each sound, the PCM samples that `ffmpeg` decodes from the new WAV
  file are the same bytes as the samples that it decodes from the old MP3
  file (`ffmpeg -i <file> -f s16le -ac 1 -ar 44100 -`, then compare). `aplay
  -q -D null <file>` exits with code 0 for each WAV file. Do not play the
  sounds on the speakers.
- Phase 8 proves the board on AlmaLinux 9 (GTK 4.12, Libadwaita 1.4).
- Commits: `fix(sounds): play WAV files with PipeWire, PulseAudio, or ALSA`
  and `fix(board): run on GTK 4.12, Libadwaita 1.4, and GLib 2.88`.

## 15. Phase 6: app link check (L10)

1. `asb doctor`: add the check `Links` to the Options group. For `codex`
   and `claude`, run `xdg-mime query default x-scheme-handler/<scheme>`.
   Print the desktop file (status `ok`), or `none: ASB cannot open <app>
   sessions until the app handles <scheme>: links` (status `info`). Empty
   output and a missing `xdg-mime` give the same `info` line.
2. Tests in `test/asb-doctor.test.mjs` with a fake `execFile`: a handler,
   empty output, and a missing `xdg-mime`.

### Phase 6 acceptance

- `(umask 022; npm test)` passes.
- On the Debian PC, doctor prints `codex: chatgpt.desktop` and
  `claude: com.anthropic.Claude.desktop`.
- Commit: `feat(doctor): check the codex and claude link handlers`.

## 16. Phase 7: release packages (L11)

### 16.1 Debian package

Change `DEBIAN_DEPENDS` (`scripts/asb-package.mjs:12`) and the control file
(`:331`):

- Depends: `nodejs (>= 20), sqlite3, xdg-utils, openssl`.
- Recommends: `python3-gi, python3-gi-cairo, gir1.2-gtk-4.0 (>= 4.12),
  gir1.2-adw-1 (>= 1.4), python3-qrcode, pipewire-bin | pulseaudio-utils |
  alsa-utils`.

Update the expectations in `test/asb-package.test.mjs`.

### 16.2 RPM

1. In `build()`, after the `.deb`, build `asb-<version>-1.noarch.rpm`. Make
   its payload tree with the same steps as the `.deb` payload (`:322-329`),
   but put the license at `usr/share/licenses/asb/LICENSE` instead of
   `usr/share/doc/asb/copyright`. Write the spec into the temporary folder
   (Appendix G). Run `rpmbuild -bb` with `_topdir` in the
   temporary folder, `_buildhost reproducible`,
   `use_source_date_epoch_as_buildtime 1`,
   `clamp_mtime_to_source_date_epoch 1`, and `SOURCE_DATE_EPOCH` in the
   environment.
2. When `rpmbuild` is not installed, skip the RPM, print one line, and keep
   it out of `SHA256SUMS`. CI installs `rpm` before `npm run build`.
3. Tests: when `rpmbuild` exists, build twice and compare the bytes; read
   `rpm -qp --requires --recommends` and compare with Appendix G.

### 16.3 PKGBUILD

1. In `build()`, write `dist/PKGBUILD` from the template in Appendix H, with
   the version and the SHA-256 of the archive that the same build made.
   Add it to `SHA256SUMS`.
2. Test: the generated file has the version and the archive hash, and
   `bash -n` accepts it.

### 16.4 Nix flake

1. Add `"stage"` to the commands of `asb-package.mjs` (`main`, `:341-353`;
   the list is at `:343`): `node scripts/asb-package.mjs stage <folder>`
   copies `RUNTIME_FILES` to the folder with `copyRuntime`. `main` now
   accepts exactly one argument (`:345`), so let `stage` take the folder as
   its second argument; the other commands keep the one-argument rule. The
   flake uses it, so that the runtime file list stays in one place.
2. Create `flake.nix` (systems `x86_64-linux` and `aarch64-linux`, input
   `nixpkgs` on `nixos-26.05`) and `nix/package.nix`
   (`stdenvNoCC.mkDerivation`). Commit `flake.lock`.
   - `nativeBuildInputs`: `nodejs_24`, `makeWrapper`, `wrapGAppsHook4`,
     `gobject-introspection`.
   - `buildInputs`: `gtk4`, `libadwaita`.
   - Python: `python3.withPackages (ps: [ ps.pygobject3 ps.pycairo
     ps.qrcode ])`.
   - `installPhase`: `node scripts/asb-package.mjs stage
     $out/lib/asb`; the desktop entry and the icon into `$out/share`; then
     `makeWrapper $out/lib/asb/scripts/asb $out/bin/asb` with
     `--set ASB_SYSTEM_INSTALL 1`, `--set ASB_NODE <nodejs_24>/bin/node`,
     `--set ASB_PYTHON <python>/bin/python3`, `--prefix PATH :` the
     `bin` folders of `xdg-utils`, `openssl`, `sqlite`, `pipewire`, and
     `alsa-utils`, and `"${gappsWrapperArgs[@]}"` (set `dontWrapGApps =
     true`).
   - `apps.default` runs `asb`.
3. `asb service install` writes store paths into the unit or the autostart
   entry. Add to the README: run `asb service install` again after each
   update of the flake.

### 16.5 CI build job

In `test.yml`, install `rpm` (`sudo apt-get install -y rpm`) before
`npm run build`, and add `dist/asb-*.noarch.rpm` and `dist/PKGBUILD` to the
uploaded artifact.

### Phase 7 acceptance

- `(umask 022; npm test)` passes on the Debian PC, with the RPM tests
  skipped when `rpmbuild` is missing.
- The CI build job makes the `.deb`, the `.rpm`, the archive, the
  `PKGBUILD`, and `SHA256SUMS`, and two builds have the same bytes.
- Phase 8 proves the installs.
- Commit: `feat(package): build an RPM, a PKGBUILD, and a Nix flake`.

## 17. Phase 8: CI on every family (L12)

Extend `.github/workflows/distros.yml` from phase 0:

1. Job `build` (host): Node 24, `sudo apt-get install -y rpm`,
   `npm run build`; upload `dist/`.
2. Matrix job per row of Appendix C (needs `build`): download `dist/`, make
   the install commands on the host (phase 0), then `docker run --rm -v
   "$PWD:/asb:ro" <image> sh -eu /asb/test/distro-check.sh <family> <tier>
   <package>` with the commands in environment variables.
3. Create `test/distro-check.sh` (POSIX `sh`, no Bash features). Steps:
   1. Install the required, board (board tier only), optional, and CI keys
      with the commands from the host.
   2. Add Node.js through the route of Appendix B when the row says so.
   3. Create a user `asbtest` with a home folder. Run every following ASB
      step as that user, with `XDG_RUNTIME_DIR` unset and no session bus.
   4. Unpack `dist/asb-<version>-linux.tar.gz` in the home folder and run
      `./install.sh`.
   5. `~/.local/bin/asb doctor --json`: check `board.ok` against the tier,
      and that `commands.required` is empty.
   6. `asb engine start` (the runtime folder must be
      `~/.local/state/asb/run`), then `asb agent status` (proves the loopback
      API), then `asb engine stop`. Then `asb service install`: expect the
      `none` refusal (exit code 1), because a container has no desktop
      session. Then `XDG_CURRENT_DESKTOP=CI asb service install`: expect the
      `xdg` mode, the autostart entry, and a running engine. Then `asb
      service uninstall`: the entry is gone and the engine stops.
   7. Board tier: start `dbus-run-session -- xvfb-run -a env
      ASB_SNAPSHOT=/tmp/asb-board.png ~/.local/bin/asb` in the background.
      Wait at most 90 s for the PNG (at least 1 KB). Then `asb engine stop`;
      the window closes with its engine. Engine tier: `asb` exits with code 3
      and prints the engine-only message. A row with `window: skip`
      (alma-10, section 2) skips this step; step 5 still proves the board
      check there.
   8. With `PYTHONDONTWRITEBYTECODE=1` (the repository is mounted read-only):
      `python3 /asb/test/asb_native_logic_test.py`, and on the board tier
      `python3 -m unittest discover -s /asb/test -p 'asb_tray_test.py'`.
   9. `./uninstall.sh`.
   10. As root, install the package of the row: `apt-get install -y
       ./asb_*_all.deb`, `dnf install -y ./asb-*.noarch.rpm`, or `zypper
       --non-interactive install --allow-unsigned-rpm ./asb-*.noarch.rpm`.
       For Arch, run `makepkg` as `asbtest` with the archive next to the
       `PKGBUILD` (makepkg then does not download it), and `pacman -U
       --noconfirm ./asb-*.pkg.tar.zst` as root. Then repeat steps 5 and 6
       with `/usr/bin/asb`.
4. Job `nix` (host `ubuntu-latest` with `cachix/install-nix-action`): `nix
   flake check`, `nix build`, `./result/bin/asb doctor --json` (board ok),
   and the engine start, status, and stop of step 6.
5. Keep `test.yml` as it is, plus the phase 7 change.

### Phase 8 acceptance

- Every job of `distros.yml` passes on a branch push (the reviewer pushes
  after the user approves, and reads the run with `gh run view`). If the
  board fails on a board-tier row (for example alma-9), stop and report. Do
  not move a row to the engine tier without the user's approval.
- A deliberate wrong package name in Appendix A makes the matching job fail
  (check once, then restore).
- Commit: `ci: install and start ASB on every distro family`.

## 18. Phase 9: documents

1. `README.md`, "Install on Linux":
   - The npm route (from multi-machine phase 4), then `asb doctor`.
   - One block per family with the required and optional install commands
     from Appendix A. A docs test checks that each block equals
     `installCommand` for that family.
   - The release packages: `.deb`, `.rpm`, `PKGBUILD` (`makepkg -si`), and
     the flake (`nix profile install github:Jamir-boop/ASB`).
   - The `Node.js` section of phase 1 (anchor `#nodejs`): check it against
     Appendix B again.
   - Engine only, autostart without systemd, and the firewall note.
2. `ASB.md`: `asb doctor`, the autostart modes, engine only, and the link
   check.
3. `SYSTEM_OVERVIEW.md`: tool discovery, the board check, the runtime folder
   rule, the autostart modes, the WAV sounds, the package formats, and the
   CI matrix.
4. `CHANGELOG.md` (Unreleased) and `docs/PRIVACY.md` (what doctor reads,
   from section 8).
5. Update `test/asb-docs.test.mjs` for the new install text.

### Phase 9 acceptance

- `(umask 022; npm test)` passes.
- The reviewer checks each README install block against
  `installCommand` and Appendix B.
- Commit: `docs: describe ASB on every Linux distribution`.

---

## Appendix A: package table

Keys: **required** `node`, `sqlite`, `openssl`, `xdg`. **Board** `gi`,
`gtk`, `adw`. **Optional** `gicairo`, `qrcode`, `sound`. **CI**
`xvfb`, `dbus`, `font`. Phase 0 proves every name. A dash means that the
family has no separate package (another package of the row includes it).

The column heads give the family keys (the `FAMILIES` keys and the
`<family>` argument of 9.1). `ids` and `like` both hold the base `ID`
values of the family: `debian` and `ubuntu`; `fedora`, `rhel`, and
`centos`; `opensuse` and `suse`; `arch` and `artix`; `alpine`; `void`;
`gentoo`; `solus`; and `nixos` (a family with no install command).
Derivatives match through `ID_LIKE`: AlmaLinux has
`ID_LIKE="rhel centos fedora"`, and Linux Mint has `ID_LIKE="ubuntu debian"`.

| Key | `debian`: Debian, Ubuntu (`apt install`) | `fedora`: Fedora, RHEL (`dnf install`) | `opensuse` (`zypper install`) | `arch` (`pacman -S --needed`) | `alpine` (`apk add`) | `void` (`xbps-install -S`) | `gentoo` (`emerge --ask --noreplace`) | `solus` (`eopkg install`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `node` | `nodejs` | `nodejs` | `nodejs-default` | `nodejs` | `nodejs` | `nodejs` | `net-libs/nodejs` | `nodejs` |
| `sqlite` | `sqlite3` | `sqlite` | `sqlite3` | `sqlite` | `sqlite` | `sqlite` | `dev-db/sqlite` | `sqlite3` |
| `openssl` | `openssl` | `openssl` | `openssl` | `openssl` | `openssl` | `openssl` | `dev-libs/openssl` | `openssl` |
| `xdg` | `xdg-utils` | `xdg-utils` | `xdg-utils` | `xdg-utils` | `xdg-utils` | `xdg-utils` | `x11-misc/xdg-utils` | `xdg-utils` |
| `gi` | `python3-gi` | `python3-gobject` | `python3 python313-gobject` | `python-gobject` | `py3-gobject3` | `python3-gobject` | `dev-python/pygobject` | `python-gobject` |
| `gtk` | `gir1.2-gtk-4.0` | `gtk4 gobject-introspection` | `typelib-1_0-Gtk-4_0` | `gtk4` | `gtk4.0` | `gtk4` | `gui-libs/gtk` | `libgtk-4` |
| `adw` | `gir1.2-adw-1` | `libadwaita` | `typelib-1_0-Adw-1` | `libadwaita` | `libadwaita` | `libadwaita` | `gui-libs/libadwaita` | `libadwaita` |
| `gicairo` | `python3-gi-cairo` | - | `python313-gobject-cairo` | `python-cairo` | `py3-cairo` | - | - | - |
| `qrcode` | `python3-qrcode` | `python3-qrcode-core` | `python313-qrcode` | `python-qrcode` | `py3-qrcode` | `python3-qrcode` | `dev-python/qrcode` | `python-qrcode` |
| `sound` | `pipewire-bin` | `pipewire-utils` | `pipewire-tools` | `pipewire-audio` | `pipewire-tools` | `pipewire` | `media-video/pipewire` | `pipewire` |
| `xvfb` (CI) | `xvfb xauth` | `xorg-x11-server-Xvfb` | `xvfb-run` | `xorg-server-xvfb` | `xvfb-run` | `xorg-server-xvfb xvfb-run` | none (no CI) | none (no CI) |
| `dbus` (CI) | `dbus` | `dbus-daemon` | `dbus-1-daemon` | `dbus` | `dbus` | `dbus` | none (no CI) | none (no CI) |
| `font` (CI) | `fonts-dejavu-core` | `dejavu-sans-fonts` | `dejavu-fonts` | `ttf-dejavu` | `font-dejavu` | `dejavu-fonts-ttf` | none (no CI) | none (no CI) |

Notes:

- **openSUSE:** the Python package names include the main Python flavor:
  `python313` on Tumbleweed and Leap 16.0 today. When Tumbleweed changes its
  main Python, the tumbleweed CI job fails. Then change the names.
- **openSUSE, first CI run:** Leap 16.0 needs the `python3` wrapper package
  for `/usr/bin/python3` (`python313-gobject` brings only `python3.13`).
  `dbus-run-session` is in `dbus-1-daemon`, not in `dbus-1`.
- **RHEL 9:** it has only `python3-qrcode-core`, so the `fedora` family uses
  this name. It needs no EPEL. The first CI run installed it on Fedora 43
  and 44 and AlmaLinux 9, and AlmaLinux 10 resolved it too (that install
  failed only on Xvfb).
- **Fedora 43 and later:** `gobject-introspection` has the `cairo-1.0`
  typelib that GTK needs, and `python3-gobject` no longer pulls it in. It is
  in the `gtk` key, so that doctor prints it when GTK does not load.
- **Arch and Alpine:** the PyGObject package has the cairo module but not
  pycairo, so `gicairo` is `python-cairo` or `py3-cairo` there.
- **RHEL 10:** it has no Xvfb, so the alma-10 job leaves the `xvfb` key out
  (`window: skip`, section 2).
- **Gentoo:** doctor also prints `Build gui-libs/gtk and gui-libs/libadwaita
  with USE=introspection, dev-python/pygobject with USE=cairo, and
  media-video/pipewire with USE=extra (for pw-play).`
- **Solus:** no CI job proves this column.
- **NixOS** has no column: the flake brings everything.
- **Image-based systems** use the Fedora or openSUSE names with the
  transactional command, then `Restart the computer to use the new
  packages.`

## Appendix B: Node.js routes

`nodeRoute` (9.1) selects the row. 10.2 step 3 says how doctor prints it.

| Release | Route that doctor and the README print |
| --- | --- |
| The `debian` family (Debian 12, Ubuntu 22.04 and 24.04, and their derivatives have Node.js 18 or older) | `Install Node.js 24 from NodeSource (https://github.com/nodesource/distributions), then run asb doctor again.` |
| RHEL, AlmaLinux, Rocky, CentOS Stream, and Oracle Linux 9 (the repository has only the retired Node.js 16) | `dnf module install nodejs:24`, after the root prefix |
| Read-only mode (SteamOS) | `Unpack the Linux archive from https://nodejs.org/en/download into ~/.local, so that ~/.local/bin/node exists.` |
| Any other release | No route: the `node` package of Appendix A is Node.js 20 or later. Image-based systems install it with the transactional command. |

CI: the debian-12, ubuntu-22.04, and ubuntu-24.04 rows leave `node` out of
the required keys. They run `apt-get install -y curl ca-certificates`,
download `https://deb.nodesource.com/setup_24.x` to `/tmp/nodesource.sh`,
run `bash /tmp/nodesource.sh`, and then run `apt-get install -y nodejs`.
The alma-9 row also leaves `node` out and runs
`dnf module install -y nodejs:24`.

## Appendix C: CI matrix

| Job | Image | Runner | Tier | Node.js | Package test |
| --- | --- | --- | --- | --- | --- |
| debian-13 | `debian:13` | `ubuntu-latest` | Board | Repository | `.deb` |
| debian-12 | `debian:12` | `ubuntu-latest` | Engine | NodeSource | `.deb` |
| ubuntu-24.04 | `ubuntu:24.04` | `ubuntu-latest` | Board | NodeSource | `.deb` |
| ubuntu-22.04 | `ubuntu:22.04` | `ubuntu-latest` | Engine | NodeSource | `.deb` |
| ubuntu-26.04 | `ubuntu:26.04` | `ubuntu-latest` | Board | Repository | `.deb` |
| fedora-43 | `fedora:43` | `ubuntu-latest` | Board | Repository | `.rpm` |
| fedora-44 | `fedora:44` | `ubuntu-latest` | Board | Repository | `.rpm` |
| alma-10 | `almalinux:10` | `ubuntu-latest` | Board, `window: skip` (no Xvfb on EL10) | Repository | `.rpm` |
| alma-9 | `almalinux:9` | `ubuntu-latest` | Board (GTK 4.12, Libadwaita 1.4) | Module stream | `.rpm` |
| tumbleweed | `opensuse/tumbleweed` | `ubuntu-latest` | Board | Repository | `.rpm` |
| leap-16 | `opensuse/leap:16.0` | `ubuntu-latest` | Board | Repository | `.rpm` |
| arch | `archlinux:latest` | `ubuntu-latest` | Board | Repository | `PKGBUILD` |
| alpine-3.24 | `alpine:3.24` | `ubuntu-latest` | Board | Repository | Archive only |
| void | `ghcr.io/void-linux/void-glibc-full:latest` | `ubuntu-latest` | Board | Repository | Archive only |
| debian-13-arm | `debian:13` | `ubuntu-24.04-arm` | Board | Repository | `.deb` |
| fedora-44-arm | `fedora:44` | `ubuntu-24.04-arm` | Board | Repository | `.rpm` |
| nix | none (Nix on the host) | `ubuntu-latest` | Board | Flake | Flake |

When an image tag does not exist, phase 0 uses the nearest release of the
same family and reports it.

## Appendix D: doctor output

Text, for a Fedora system without the board packages and with firewalld:

```text
ASB doctor: Fedora Linux 44 (Workstation Edition), family fedora

Engine
  ok       Node.js 22.23.1 (/usr/bin/node), built-in SQLite
  ok       openssl 3.5.1
  ok       xdg-open (/usr/bin/xdg-open)
Window
  missing  PyGObject (Python 3.14.8, /usr/bin/python3)
  missing  GTK 4
  missing  Libadwaita
Options
  missing  QR code (Python qrcode)
  ok       Sounds (pw-play)
  ok       Tray host
  ok       Autostart: systemd user service
  ok       Runtime folder: /run/user/1000/asb
  ok       Links: codex: chatgpt.desktop, claude: com.anthropic.Claude.desktop

Install the missing packages:
  sudo dnf install python3-gobject gtk4 gobject-introspection libadwaita
Optional:
  sudo dnf install python3-qrcode-core
Phone access and machine links through firewalld:
  sudo firewall-cmd --permanent --zone=public --add-rich-rule='rule family="ipv4" destination address="192.168.1.20" port port="4630" protocol="tcp" accept'
  sudo firewall-cmd --reload
```

The group headings use "Window" for the board, because users know that word.
JSON: see 10.2.

## Appendix E: autostart entry

```ini
[Desktop Entry]
# Generated by ASB: engine autostart
Type=Application
Name=ASB engine
Comment=Starts the ASB engine for the phone and your other machines
Exec=env ASB_NODE=<node> <launcher> engine start
Icon=local.asb.AgentSwitchBoard
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
```

`<node>` and `<launcher>` follow the rules of `serviceUnit`
(`scripts/asb-service.mjs:28-37`). `<node>` is the value of the unit's
`Environment=ASB_NODE=`. `<launcher>` is the installed launcher, else
`scripts/asb` of the checkout. `executablePath` refuses whitespace, quotes,
`%`, `$`, and backslashes in both paths, so they need no quoting. Without
`ASB_NODE`, the launcher sees only the desktop `PATH` at login, which often
does not have the Node.js of nvm, fnm, or Homebrew.

## Appendix F: app builds on Linux

Checked on 2026-10-19 in the app documentation, Flathub, the Snap Store, and
the AUR. The Claude and ChatGPT Linux apps are beta or preview builds, so
their names and folders can change. ASB reads the native folders below, as
today. Phase 6 checks only the link handlers.

| App | Official Linux builds | Package and desktop file | Data folder | Link scheme |
| --- | --- | --- | --- | --- |
| Claude Desktop (beta) | `.deb` from the apt repository `downloads.claude.ai/claude-desktop/apt/stable` (amd64, arm64) | `claude-desktop`, `com.anthropic.Claude.desktop` | `${XDG_CONFIG_HOME:-~/.config}/Claude` | `claude:` |
| ChatGPT app with Codex (preview) | `.deb` and `.rpm` (x64, arm64), and a script for Arch | `chatgpt`, `chatgpt.desktop` | `~/.codex` (shared with the Codex CLI) | `codex:` |
| OpenCode 2 desktop | `.deb`, `.rpm`, and AppImage (x64, arm64) | app ID `ai.opencode.desktop` | `${XDG_DATA_HOME:-~/.local/share}/opencode` | none that ASB uses (list only) |
| Claude Code CLI, Codex CLI | npm, install scripts, and static builds | none | `~/.claude/projects`, `~/.codex` | none (view-only cards) |

Builds that ASB does not support:

- The OpenCode Flatpak `ai.opencode.opencode` (Flathub, 1.18.8) and the Snap
  `opencode` (1.19.3) are OpenCode 1. ASB reads only OpenCode 2.
- No Flatpak or Snap of Claude Desktop or the ChatGPT app exists. The Claude
  Snaps on the Snap Store (`claude-ai-desktop`, `claudeai-desktop`) are
  unofficial web wrappers.
- The unofficial `claude-desktop-debian` builds (`.deb`, `.rpm`, AppImage,
  and a Nix flake) use `~/.config/Claude`, as the official app does, so ASB
  already reads their sessions. Their documents do not name a `claude:`
  handler.

## Appendix G: RPM spec

```spec
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
Name:           asb
Version:        <version>
Release:        1
Summary:        Local session switch board for Codex and Claude Desktop Code
License:        MIT
URL:            https://github.com/Jamir-boop/ASB
BuildArch:      noarch
AutoReqProv:    no
Requires:       (nodejs >= 20 or nodejs-default or nodejs22 or nodejs24)
Requires:       (sqlite or sqlite3)
Requires:       openssl
Requires:       xdg-utils
Recommends:     (python3-gobject or python313-gobject)
Recommends:     python3
Recommends:     (gobject-introspection if python3-gobject)
Recommends:     python313-gobject-cairo
Recommends:     (gtk4 >= 4.12 or typelib-1_0-Gtk-4_0 >= 4.12)
Recommends:     (libadwaita >= 1.4 or typelib-1_0-Adw-1 >= 1.4)
Recommends:     (python3-qrcode-core or python313-qrcode)
Recommends:     (pipewire-utils or pipewire-tools or pulseaudio-utils or alsa-utils)

%description
Native GTK 4 session list with local read-only provider access.

%install
cp -a %{payload}/. %{buildroot}/

%files
/usr/lib/asb
/usr/bin/asb
/usr/share/applications/local.asb.AgentSwitchBoard.desktop
/usr/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg
%license /usr/share/licenses/asb/LICENSE
```

`%{payload}` is a `--define` with the payload folder. `AutoReqProv: no`
stops rpmbuild from adding a Python ABI dependency, which would break engine
only and the openSUSE install. The three `%global` lines stop the build
scripts that byte-compile Python files or add build IDs, so that two builds
have the same bytes. Phase 8 proves that `dnf` and `zypper` resolve every
rich dependency. `dnf` and `zypper` skip a weak dependency (Recommends)
that names no package of the system, so the openSUSE names do no harm on
Fedora and RHEL. On Fedora, `python3-gobject` already has cairo support.
The first CI run (section 7) added two lines: Fedora 43 and later need
`gobject-introspection` for the `cairo-1.0` typelib of GTK, and Leap 16.0
needs the `python3` wrapper for `/usr/bin/python3`.

## Appendix H: PKGBUILD template

```bash
pkgname=asb
pkgver=<version>
pkgrel=1
pkgdesc='Local session switch board for Codex and Claude Desktop Code'
arch=('any')
url='https://github.com/Jamir-boop/ASB'
license=('MIT')
depends=('nodejs' 'openssl' 'xdg-utils' 'python-gobject' 'gtk4' 'libadwaita')
optdepends=('python-qrcode: phone pairing QR code'
            'python-cairo: phone pairing QR code'
            'pipewire-audio: sounds'
            'bun: ASB Bridge')
source=("https://github.com/Jamir-boop/ASB/releases/download/v${pkgver}/asb-${pkgver}-linux.tar.gz")
sha256sums=('<sha256 of the archive>')

package() {
  install -d "$pkgdir/usr/lib/asb"
  cp -a "asb-$pkgver/." "$pkgdir/usr/lib/asb/"
  printf '%s\n' '#!/bin/sh' 'export ASB_SYSTEM_INSTALL=1' 'exec /usr/lib/asb/scripts/asb "$@"' > asb.sh
  install -Dm755 asb.sh "$pkgdir/usr/bin/asb"
  install -Dm644 "asb-$pkgver/assets/icons/local.asb.AgentSwitchBoard.svg" \
    "$pkgdir/usr/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg"
  install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/local.asb.AgentSwitchBoard.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=ASB
GenericName=Agent Switch Board
Exec=/usr/bin/asb
Icon=/usr/share/icons/hicolor/scalable/apps/local.asb.AgentSwitchBoard.svg
Terminal=false
StartupWMClass=local.asb.AgentSwitchBoard
Categories=Development;
EOF
  install -Dm644 "asb-$pkgver/LICENSE" "$pkgdir/usr/share/licenses/asb/LICENSE"
}
```

Arch always has current libraries, so the board libraries are hard
dependencies here. `python-gobject` lists `python-cairo` only as optional
(first CI run), so the QR code needs it in `optdepends`.
