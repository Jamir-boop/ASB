# Multi-machine Phase 0 spike results

This file records the Phase 0 spikes of `multi-machine.md`. It holds no addresses, user names, tokens, or private file contents.

## S8: Linux tray (Debian, GNOME)

- Date: 2026-10-19.
- Commands: a minimal Python Gio StatusNotifierItem with a com.canonical.dbusmenu menu that follows Appendix A, in `/tmp/asb-spike-s8/`. It ran detached (`setsid -f ... > out.log 2>&1 < /dev/null`). Menu items only wrote a line to `events.log`.
- Seen:
  - `RegisterStatusNotifierItem` returned without error. `RegisteredStatusNotifierItems` from the Appendix A `busctl` command listed the item.
  - `GetLayout` returned revision 1 with Open ASB, a separator, and Quit ASB.
  - A `busctl` `Event` call for item 1 with `clicked` wrote one Open ASB line.
  - The user saw the ASB icon in the top bar and a menu with Open ASB and Quit ASB. The user's Open ASB click wrote one more Open ASB line.
  - The user's first Quit ASB click did not arrive: `events.log` had no Quit ASB line and the bus name still had an owner. The second Quit ASB click arrived and wrote one Quit ASB line.
  - After that Quit ASB, the spike stopped, released its bus name (`NameHasOwner` returned false), and the icon left the top bar.
- Gate: PASS. Phase 1 can include the Linux tray.
- Cleanup: `/tmp/asb-spike-s8/` removed.

## S1: Claude Code proxy row (Debian)

- Date: 2026-10-19. Claude Code 2.1.303, Bun 1.4.2.
- Commands: a Bun script in `/tmp/asb-spike-s1/` started `/usr/bin/cat` with a stdin pipe and ignored output, read its `procStart` (field 22 of `/proc/<pid>/stat`), listened on a Unix socket in a new `0700` folder, and wrote one `0600` row `~/.claude/sessions/<cat pid>.json` with the `register()` fields (name `asb-spike-proxy`, entrypoint `asb-relay`). The row pid and `procStart` belonged to cat; the socket belonged to the Bun process. The script logged only the frame type and the byte length. Two Claude Code sessions ran `ListAgents` and sent one message each for each case.
- Seen:

  | Case | Listed by ListAgents | Message delivered as a `user` frame |
  | --- | --- | --- |
  | Live cat, row with `procStart` | Yes (idle, no app label) | Yes, from both sessions |
  | Live cat, row without `procStart` | Yes | Yes, from both sessions |
  | Dead cat, row without `procStart` | Yes | Yes, from both sessions |
  | Dead cat, row with the old `procStart` | Yes | Yes, from both sessions |

  - No delivery notice came back in any case.
  - After cleanup removed the row, `ListAgents` no longer listed it.
- Gate: PASS. Claude Code lists and delivers to a placeholder-PID row with a socket that another process owns. `procStart` is not required, but production proxy rows still write it.
- Consequence for phase 6: Claude Code 2.1.303 filters neither a dead PID nor a stale `procStart`. Thus the relay must delete a proxy row and close its socket itself when the placeholder or the remote session goes away. A stale row otherwise still accepts messages. The PID is not a liveness signal for Claude Code here, so the placeholder process matters only for other readers (for example ASB's own registry reader and the bridge's `peers()`).
- Cleanup: the row, the socket, the cat and Bun processes, and `/tmp/asb-spike-s1/` removed.

## SSH session on homeLP

- Key-only SSH to homeLP works. The SSH session runs with a High integrity label (the account is an administrator, and OpenSSH gives it the full token).
- The real engine runs unelevated in the user's desktop session. Thus a check that can depend on the integrity level also runs through a one-time interactive scheduled task (normal integrity). The spikes use no administrator rights: only user-level reads, files in `%TEMP%`, and HKCU.

## S2: Windows store paths and tools (homeLP, SSH, read-only)

- Date: 2026-10-19. Windows 10 (10.0.19044), PowerShell 5.1.19041.
- Commands: a read-only PowerShell probe in a new `%TEMP%` folder printed metadata only (exists, type, size or child count, last write time) for the paths that ASB reads, and the tool versions. The folder was removed after the run.
- Seen:
  - Codex: `%USERPROFILE%\.codex` exists with `state_5.sqlite` (and `-wal`), `session_index.jsonl`, `.codex-global-state.json`, and `sessions` (662 `rollout-*.jsonl` files). The Codex desktop app is the MSIX package `OpenAI.Codex_2p2nqsd0c76g0`, but its data is in `%USERPROFILE%\.codex`. `plugin-state\asb-bridge` is absent (the bridge is not installed there).
  - Claude Desktop: `%APPDATA%\Claude` does not exist. The app is the MSIX package `Claude_pzs8sxrjxfjjc`, and its store is `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude` (with `claude-code-sessions` and `Cache\Cache_Data`). Its last write is from 2026-07-05, so the app was not used recently on this machine.
  - Claude cache: 0 of 67 files in `Cache\Cache_Data` match `^[a-f0-9]{16}_0$`. The files are `index`, `data_0` to `data_3`, and 62 `f_xxxxxx` files: the Chromium blockfile cache format, not the simple cache format that ASB reads on Linux.
  - Claude Code CLI: `%USERPROFILE%\.claude\projects` exists (14 children). `%USERPROFILE%\.claude\sessions` exists with 0 `*.json` rows (no live CLI session at the time).
  - Tools: Node v24.14.1 (`node:sqlite` loads), Bun 1.3.14, Claude Code 2.1.303, codex-cli 0.163.0, Git 2.53.0.windows.2. `openssl` is not on `PATH`, but Git for Windows includes `openssl.exe` (`usr\bin` and `mingw64\bin`).
- Gate: FAIL on the Claude Desktop store path and on the cache format.
  - Store path: phase 4 adds the MSIX path `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude` to the win32 Claude app folder search.
  - Cache format: disable remote-cache rows on Windows with a source warning.
- Cleanup: the `%TEMP%` folder on homeLP removed (`Test-Path` returned False).

## S5: Bun on Windows (homeLP)

- Date: 2026-10-19. Bun 1.3.14, `process.platform` win32.
- Commands: a Bun script in a new `%TEMP%` folder ran five checks, each with a 5 s timeout and its own cleanup. It ran two times: over SSH (High integrity) and through a one-time interactive scheduled task (`schtasks /create ... /it /rl LIMITED`, run, then deleted) in the user's desktop session (Medium integrity, session 1).
- Seen (the same in both runs):
  - `pipe`: a `node:net` server on `\\.\pipe\asb-spike-s5-<random>` echoed one line to a `node:net` client.
  - `pipe-bytes`: a 1048576-byte line (the Claude line limit) echoed with the exact length both ways.
  - `kill0`: `process.kill(own pid, 0)` worked; on a PID that had exited it threw `ESRCH`.
  - `findstr`: `C:\Windows\System32\findstr.exe x` with a stdin pipe and ignored output was alive after 1 s and exited (code 1) after stdin EOF.
  - `detached-ipc`: a detached `bun child.ts` with `stdio ['ignore','ignore','ignore','ipc']` sent its PID over IPC, which matched `child.pid`, and exited 0 on "stop".
- Gate: PASS (5 pass, 0 fail, at both integrity levels).
- Cleanup: the folder and the scheduled task removed; no `bun` or `findstr` process left.

## S6: Windows certificate and Node TLS 1.3 (homeLP, SSH)

- Date: 2026-10-19. Node v24.14.1.
- Commands: Appendix B part 1 without changes, with the folder and a random passphrase only in environment variables, in a new `%TEMP%` folder. Then a Node `https` server with `pfx` and `minVersion: 'TLSv1.3'` on `127.0.0.1`, and a Node client.
- Seen:
  - `New-SelfSignedCertificate` (ECDSA P-256) worked; `cert.pfx` and `cert.cer` were exported, and the store entry was removed in `finally`.
  - The key type was `ec prime256v1`. The connection used TLSv1.3.
  - The SHA-256 of the peer certificate seen by the client matched the SHA-256 of the `cert.cer` DER bytes, and `fingerprint256` values matched too.
- Gate: PASS. The `openssl.exe` fallback was not needed.
- Cleanup: `cert.pfx`, `cert.cer`, and the folder removed; no `CN=ASB` certificate left in `Cert:\CurrentUser\My`.

## S7: Windows tray and Run value (homeLP, SSH and a one-time interactive scheduled task)

- Date: 2026-10-19. Windows 10 21H2, PowerShell 5.1, Node v24.14.1.
- Commands: a PowerShell `NotifyIcon` script (the Appendix B part 2 outline) in a new `%TEMP%` folder. A one-time interactive scheduled task (`/it /rl LIMITED`) started it in the user's desktop session with the Run command form `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<folder>\tray.ps1"`. The script started `node.exe` (`UseShellExecute = $false`, `CreateNoWindow = $true`), made a 32 px icon, and added a `ContextMenuStrip` with **Copy phone pairing link** and **Quit ASB**. A timer clicked **Quit ASB** (`PerformClick`) when a flag file appeared. Then a round trip of an HKCU `Run` value.
- Seen (two runs):
  - The script ran in session 1. Its console window existed and was not visible.
  - `NotifyIcon.Visible` was true, and the menu had the two items.
  - `node.exe` ran in session 1 with no main window.
  - **Quit ASB** stopped `node.exe`, removed the icon, and ended the script. No process was left.
  - Run value: `reg.exe add /d` from PowerShell 5.1 lost the quotes inside the command (a known PowerShell 5.1 problem with native arguments). Node `execFileSync('reg', ['add', <key>, '/v', <name>, '/t', 'REG_SZ', '/d', <command>, '/f'])` stored the exact command (the read-back was equal), and `reg delete` removed it.
  - Not confirmed: the icon on the screen. UI Automation from the task found no taskbar buttons, the toolbar handle lookup failed, and a capture of the screen corner showed no taskbar (it can be hidden). A real logon with the Run value was not tested, because it needs a sign-out.
  - Also seen (read-only): the firewall has inbound Allow rules for `C:\Program Files\nodejs\node.exe` on the Private profile and Block rules on the Public profile. The Ethernet adapter is Private, and the ZeroTier adapter is Public. So members reach an engine on homeLP over the LAN, not over ZeroTier, until the user adds the `asb setup` firewall rule.
- Gate: PASS for all checks that a program can make. Phase 4 includes the tray and the Run value, and writes the Run value from Node. The icon on the screen and the start at logon stay in the Phase 4 acceptance (the user confirms through RDP).
- Cleanup: the scheduled tasks, the Run value, the folders, and all spike processes removed (checked).

## S3: Windows Claude Code registry rows (homeLP, SSH and a one-time interactive scheduled task)

- Date: 2026-10-19. Claude Code 2.1.303 (the native `claude.exe` of the npm package).
- Commands: a static search of `claude.exe` for the messaging address and the key file name. Then a one-time interactive scheduled task (`/it /rl LIMITED`) started `claude.exe` with no prompt (no model use), with `DISABLE_AUTOUPDATER=1` and a hidden window, in the user's desktop session. The probe printed only field names, types, lengths, and masked shapes of the new registry row. It did not open the key file. Then `taskkill /T /F` stopped the process tree.
- Seen:
  - In a new folder that Claude Code did not trust yet, no row came in 25 s (the trust prompt was open). In a folder that was trusted before, the row `~/.claude/sessions/<pid>.json` came at once. Its `pid` was the `claude.exe` PID.
  - Row fields: `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `version`, `peerProtocol`, `peerFeatures` (array), `kind` (`interactive`), `entrypoint` (`cli`), `pidDomain`, `messagingSocketPath`, `name`, `nameSource`, `nameSince`. Before the first prompt the row had no `status`. It had no `procStartFt` and no `hostSessionId`.
  - `procStart` is the process creation time as a Windows FILETIME in decimal (18 digits). It matched the creation time from `Win32_Process` to the microsecond.
  - `pidDomain` is `win32:<computer name in lower case>`.
  - `messagingSocketPath` is a named pipe `\\.\pipe\LOCAL\cc-msg-<hex>`, and the pipe was listed while the session ran.
  - The key file is `<pid>.<sha256 of the lower-case pipe path>.key` (116 bytes). The SHA-256 of the pipe path with its original case did not match. Static search: a client sends the `peerToken` of that file in an `auth` frame first, and Windows requires it.
  - A forced stop left the row and the key file. The probe removed them by name.
- Gate: PASS. A Windows proxy row is the Linux row with a named pipe, a FILETIME `procStart`, the `win32:` `pidDomain`, and its own key file named from the lower-case pipe path. As on Linux (S1), the relay must remove its rows and key files itself.
- Cleanup: the scheduled task, the rows, the key files, and the `%TEMP%` folder removed; no `claude.exe` process left; the trusted folder had the same entries before and after.

## S4: Windows Codex transports (homeLP, SSH, static and Bun)

- Date: 2026-10-19. codex-cli 0.163.0, Codex desktop (MSIX) 26.908, Bun 1.3.14, Node v24.14.1.
- Commands: a Bun and Node script in a new `%TEMP%` folder tested AF_UNIX sockets. `codex app-server --help` and `codex app-server daemon --help`. A static search of the desktop `app.asar` for the IPC and the daemon socket.
- Seen:
  - Desktop IPC: the desktop app's IPC router listens on the fixed named pipe `\\.\pipe\codex-ipc` on Windows (on Linux, `$CODEX_HOME/ipc/ipc.sock` in a `0700` folder). The client side connects to the same address with `net.connect`.
  - The desktop app uses the shared app-server daemon (`$CODEX_HOME/app-server-control/app-server-control.sock`) only when the platform is not Windows and `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`. On Windows it always runs its own app-server over stdio, so the bridge cannot reach that app-server.
  - The CLI has `codex app-server --listen` with `stdio://`, `unix://`, `unix://PATH`, `ws://IP:PORT`, and `off`, and `codex app-server daemon start|stop|restart|...`. `app-server-control.sock` on homeLP is an AF_UNIX socket file.
  - Bun on Windows listened on and connected to an AF_UNIX path (`bun-ping`), and Bun `node:net` connected to it (`net-ping`). Node `listen` on an AF_UNIX path failed with `EACCES`.
  - Not tested live: the Codex desktop app was not started (it opens a window on the user's screen), so a connection to `\\.\pipe\codex-ipc` was not made.
- Gate: PASS with a limit. On Windows the bridge uses the `desktop` target on `\\.\pipe\codex-ipc`; the `app-server` target applies only to a CLI daemon, which Bun can reach over AF_UNIX. The live desktop pipe connection is part of the Phase 7 acceptance.
- Cleanup: the `%TEMP%` folder removed (`Test-Path` returned False).
