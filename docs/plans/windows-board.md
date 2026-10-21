# ASB board on Windows: implementation plan

Status: draft, written 2026-10-20 from `main` at `f9b46c7`. Section 2 has the
user's decisions from the interview. Do not change them without asking the
user. Do the phases in order. Do not start a phase until the reviewer accepts
the phase before it. Find code by the names given, not by line numbers.

---

## 1. Goal

The same board that runs on Linux opens on Windows. It is the same
`scripts/asb-native.py`, with GTK 4 and Libadwaita from MSYS2. No second UI,
no browser view, no webview. When MSYS2 is missing, the engine runs alone, as
it does now, and `asb doctor` prints the commands that install it.

## 2. User decisions (2026-10-20)

1. UI: the same GTK board (`scripts/asb-native.py`). `PRODUCT.md` keeps "The
   native window uses no browser or webview."
2. Install: MSYS2 is a prerequisite. `asb doctor` on Windows checks the board
   and prints the `winget` and `pacman` commands. ASB never runs them. No
   bundled zip.
3. Extras in scope: a Windows CI board smoke test, PC sounds on Windows, and a
   Start menu shortcut.
4. Spike PC: homeLP (Windows 10 LTSC 21H2).

## 3. What we reuse (no new layers)

| Need | Existing code |
| --- | --- |
| Engine start on Windows | `startWindowsEngine` in `scripts/asb-engine.mjs` (starts the tray, the tray starts the engine) |
| Board launcher | `scripts/asb-desktop.mjs` (board check, spawn, engine watch) |
| Python search and probe | `pythonCandidates`, `probePython`, `boardCheck` in `src/linux-system.mjs` |
| `PATHEXT` search | `findExecutable` in `src/platform-paths.mjs` |
| Windows folders | `configDir`, `cacheDir` in `src/platform-paths.mjs` |
| Engine API, token, opens | `src/asb-server.mjs`, Windows openers (already work) |
| Tray | `scripts/asb-tray.ps1` (add one menu item) |
| Sound rules and the "board open" gate | `src/asb-sounds.mjs`, `createSwitchboardServer` in `src/switchboard.mjs` |
| Doctor checks and printed commands | `collect` and `format` in `scripts/asb-doctor.mjs` |
| Windows tests on Linux | `test/asb-windows.test.mjs`, `test/windows-tests.json` |

The board is an HTTP client of the engine. Its only known Linux-only parts
are `GLib.unix_signal_add`, the XDG theme and cache paths, and the `/` in
`tooltip_model`. The launcher refuses non-Linux in its `main`.

## 4. Phases

### Phase 0: spike on homeLP (go or stop)

No repository change. Goal: prove that the board runs on MSYS2 and list the
real defects.

1. Install MSYS2 and `mingw-w64-ucrt-x86_64-python-gobject`,
   `mingw-w64-ucrt-x86_64-gtk4`, `mingw-w64-ucrt-x86_64-libadwaita`. Record
   the GTK and Libadwaita versions (floors: 4.12 and 1.4).
2. Run the board against the homeLP engine in the signed-in session (one-time
   scheduled task with `/it`), with `ASB_SOURCE_TOKEN` and `ASB_SNAPSHOT`.
   Copy the PNG back.
3. Answer these questions:
   - Does the board start? Which errors (expected: `GLib.unix_signal_add`)?
   - Do rows, icons, fonts, CSS, and the theme look correct?
   - `python.exe` with Node `windowsHide`, or `pythonw.exe`: is the window
     visible, and is there a console window?
   - Does `probePython` get JSON from `pythonw.exe`?
   - Start time and memory, for the record.
4. Gate: when the board renders rows, go to phase 1 with the defect list. When
   GTK on MSYS2 cannot run the board, stop and ask the user.

### Phase 1: board code runs on Windows

Files: `scripts/asb-native.py`, `scripts/asb-board.py`,
`test/asb_native_logic_test.py`.

- Call `GLib.unix_signal_add` only when `os.name != "nt"`. On Windows the
  launcher ends the window process.
- `THEME_PATH` and `LAYOUT_PATH`: `%APPDATA%\asb` on Windows (the same folder
  as `configDir`). `asb-board.py` cache: `%LOCALAPPDATA%\asb\cache\pycache`
  (the same as `cacheDir`).
- `tooltip_model`: shorten the home folder with `\` too.
- Fix only the other defects that phase 0 found.

Acceptance: the logic tests cover the Windows paths and the tooltip (patched
`os.name` and environment) and pass on Linux. The Linux GTK tests pass. The
board renders on homeLP with no local patch.

### Phase 2: open the board on Windows

Files: `scripts/asb-desktop.mjs`, `scripts/asb.mjs`, `src/linux-system.mjs`,
`scripts/asb-tray.ps1`, `test/asb-windows.test.mjs`.

- `pythonCandidates` on win32: an absolute `ASB_PYTHON`, then the MSYS2
  default (`C:\msys64\ucrt64\bin\`, the executable that phase 0 chose), then
  `python` on `PATH` through `findExecutable`.
- `asb-desktop.mjs`: allow win32. Use `startWindowsEngine` there, skip
  `registerAppIcon`. The spawn, the token, and the engine watch stay the same.
- `asb.mjs`: no command on Windows opens the board, as on Linux. Remove
  `WINDOWS_HINT`. When the board check fails, the launcher's current message
  ("ASB runs without its window on this system: ... Run asb doctor") and exit
  code 3 replace it.
- Tray: add **Open ASB** at the top of the menu and on a left click, as the
  Linux tray does. It starts `node scripts\asb.mjs` with no console. When the
  launcher exits with code 3, the tray shows a balloon: `ASB has no window on
  this PC. Run asb doctor.`

Acceptance: new win32 tests with injected `platform`, `spawn`, and `find`
(launcher, dispatcher, candidates) pass on Linux and in the `windows-test`
job. On homeLP, the command of tray **Open ASB** and `asb` open the board
(scheduled task and snapshot), and the board closes when `asb engine stop`
stops the engine.

### Phase 3: Windows CI board smoke test

Files: `.github/workflows/test.yml`, one small smoke script in `test/`.

- New job `board-windows` on `windows-latest`: `msys2/setup-msys2` (UCRT64,
  the three packages), then run the smoke script with MSYS2 Python: a fake
  engine (`ThreadingHTTPServer` with synthetic rows, as in
  `test/asb_native_test.py`), the board with `ASB_SNAPSHOT`, and a check that
  the PNG exists. Also run `test/asb_native_logic_test.py` there.
- `msys2/setup-msys2` is a CI action, not a runtime package.

Acceptance: the job passes on GitHub Actions and fails when the board cannot
start (check once with a forced error).

### Phase 4: `asb doctor` and `asb setup` on Windows

Files: `scripts/asb-doctor.mjs`, `scripts/asb.mjs`, `scripts/asb-setup.mjs`,
their tests.

- Dispatcher: allow `doctor` on win32.
- `collect` on win32: the Engine group checks Node.js 22.13 with
  `node:sqlite` only (no `/etc/os-release`, `openssl`, `xdg-open`, or Linux
  firewall). The Window group is the current `boardCheck` block. The commands
  are `winget install --id MSYS2.MSYS2 -e` and
  `C:\msys64\usr\bin\pacman.exe -S --needed mingw-w64-ucrt-x86_64-python-gobject mingw-w64-ucrt-x86_64-gtk4 mingw-w64-ucrt-x86_64-libadwaita`.
- `asb setup` on Windows: print the doctor Window lines when the board is
  missing (do not stop). Replace the stale line `The bridge is not available
  on Windows yet.` with the `asb bridge install --all` line, because ASB
  Bridge runs on Windows now.

Acceptance: win32 `collect` tests with injected `execFile` pass on Linux and
in `windows-test`. On homeLP, `asb doctor` shows the board as ok.

### Phase 5: Start menu shortcut

Files: `scripts/asb-engine.mjs`, `scripts/asb-tray.ps1`,
`assets/icons/asb.ico` (new), `package.json` `files`, tests.

- `asb engine install` also writes
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\ASB.lnk` with
  `WScript.Shell` in Windows PowerShell. The paths go in environment
  variables, as `WINDOWS_CERTIFICATE_SCRIPT` does. Description:
  `Generated by ASB` (the marker).
- Target: the tray script with an `-Open` switch. With `-Open`, the script
  starts the launcher with no console and exits; it does not take the tray
  mutex. Phase 0 or this phase records whether a console flashes.
- `asb engine uninstall` removes the link only when it has the marker.
- The icon: one `.ico` made once from the current PNG and committed (`.lnk`
  icons cannot use PNG).

Acceptance: install and uninstall tests with injected `execFile` pass. On
homeLP, the link exists with its icon, and its target opens the board.
`npm pack --dry-run` lists the icon.

### Phase 6: PC sounds on Windows

Files: `src/asb-sounds.mjs`, `scripts/asb-engine.mjs`, their tests.

- `createSoundPlayer({ platform })`: on win32 the player is
  `powershell.exe -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer $env:ASB_SOUND).PlaySync()"`
  with the file in `ASB_SOUND` and `windowsHide`. The WAV files are PCM, so
  `SoundPlayer` plays them.
- `runEngine`: give the player on win32 too, and remove the "Windows has no
  board" rule. The current gate plays sounds only while a board reports
  itself, so an engine with no board stays silent.

Acceptance: win32 player tests with injected `spawn` pass. On homeLP, the player
command exits 0 for each WAV file. The engine log shows no sound error.

### Phase 7: documents and release

- Each phase updates the documents of its change: `PRODUCT.md` (platform
  line), `README.md`, `ASB.md` (Windows), `SYSTEM_OVERVIEW.md` (runtime path,
  Windows section), `CHANGELOG.md`.
- Release: the reviewer asks the user before the version change and the
  release.

## 5. Out of scope

A bundled Windows release, a WebView2 or browser board, a Windows-native UI,
macOS, WSL, Windows notifications, and Claude web sessions on Windows.

## 6. Work rules

- Each phase goes to one `worker` (Sonnet 5.5, `xhigh`). The reviewer reads
  the diff and runs the checks: `npm test`, the Python logic tests, and the
  new win32 tests. The phases run one after the other, because phases 2, 5,
  and 6 touch the same files.
- Checks are automated. The homeLP checks use a scheduled task and
  `ASB_SNAPSHOT` with synthetic or local data. Do not ask the user to click.
