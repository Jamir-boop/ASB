# ASB

**Agent Switch Board** is a native GNOME switcher for your Codex and Claude Desktop Code chats. Select a chat to open it in its original app. ASB makes no model calls.

![ASB banner](docs/media/asb-banner.png)

https://github.com/user-attachments/assets/c85742f4-d1b0-4ffc-9497-144069fec36b

## Install on Linux

[Download v1.8.1](https://github.com/Jamir-boop/ASB/releases/tag/v1.8.1) · [Release notes](docs/releases/v1.8.1.md) · [Checksums](https://github.com/Jamir-boop/ASB/releases/download/v1.8.1/SHA256SUMS)

Needs Node.js `>=20` (`sqlite3` below `22.13`), Python 3 with PyGObject, GTK `>=4.12`, Libadwaita `>=1.4`, and `xdg-utils`. The current source also needs `openssl` for the phone certificate. The optional `python3-qrcode` shows the phone pairing QR code.

Install Codex and Claude Desktop first, with working `codex:` and `claude:` URL handlers.

**Debian:** [asb_1.8.1_all.deb](https://github.com/Jamir-boop/ASB/releases/download/v1.8.1/asb_1.8.1_all.deb)

```bash
sudo apt install ./asb_1.8.1_all.deb
asb
```

**Portable (per-user):** [asb-1.8.1-linux.tar.gz](https://github.com/Jamir-boop/ASB/releases/download/v1.8.1/asb-1.8.1-linux.tar.gz)

```bash
tar -xzf asb-1.8.1-linux.tar.gz
cd asb-1.8.1
./install.sh
~/.local/bin/asb
```

[User guide](ASB.md) · [Privacy](docs/PRIVACY.md) · [Source setup](ASB.md#start-and-stop) · [Contributing](CONTRIBUTING.md)

## Install with npm (Linux and Windows)

The current source also installs as an npm package. Linux needs the same packages as above. Windows needs Node.js `22.13` or later.

```bash
npm install -g github:Jamir-boop/ASB
asb setup
```

`asb setup` makes the engine start when you sign in, waits for it, and asks which network addresses to turn on. On Windows it also prints the firewall rule to run. ASB never runs that rule itself.

On Windows, ASB has statuses only: the engine reads Codex and Claude on that PC for the phone and the machine group. It has no window. ASB Bridge and messages between machines also work on Windows. See [Windows](ASB.md#windows).

## Android companion (optional)

The ASB Android app shows your sessions on your phone over your local network, or away from home through ZeroTier or Tailscale. It can open a chat on the PC, use the row actions, and change Persistent unread. It shows Done, Failed, and Needs input notifications. In a machine group, the app uses another machine of the group when the paired PC does not answer.

Phone access is off by default. In ASB, open Preferences > Phone, select **Allow phone access**, select one or more addresses (Home network, ZeroTier, or Tailscale), and select **Apply**. Then select **Pair a phone** and scan the QR code with **Scan QR code** in the ASB app or with the phone camera, or paste the pairing link in the app. Compare the certificate fingerprint on the PC and the phone. See the [Android guide](android/README.md) to build and install the app.

## Run without the window (optional)

The ASB engine (the server and phone access) runs without the window. `asb` starts the engine when none runs, then opens the window. Closing the window keeps the engine and phone access running. To stop them, select **Quit ASB** in Preferences > Sessions or in the tray icon menu. `asb engine start`, `asb engine stop`, and `asb engine status` do the same from a terminal.

On Linux, the engine shows a tray icon with **Open ASB** and **Quit ASB**. The icon shows only when the desktop has a tray host, for example the GNOME AppIndicator extension. Without a tray host, the engine runs with no icon.

`asb service install` installs and starts the `asb.service` systemd user service, so the engine also starts with your session. `asb service status` shows the service state. `asb service uninstall` stops and removes it. When the service is installed, `asb` starts the engine through it. An ASB `1.8.1` or older window cannot attach and reports a port conflict.

The current source includes the Android companion and the user service; published `1.8.1` packages do not.

The current source can also join ASB on several of your computers in one machine group: each machine then shows the sessions of the others as cards. See [Machines](ASB.md#machines).

In a machine group, Claude and Codex sessions on one machine can message sessions on the other machines (Linux and Windows). The other sessions appear in `/list-agents` (Claude) and `list_sessions` (Codex) with the machine name first. A message to a machine that is offline is refused at once; ASB keeps no queue.

## OpenCode sessions (list only)

The current source also lists OpenCode 2 sessions from the local OpenCode database. OpenCode cards show state, the last result, and unread, but ASB cannot open them: OpenCode 2 has no link that opens one session. See [OpenCode](ASB.md#opencode).

## CLI sessions (view only)

ASB also shows Claude Code CLI and Codex CLI sessions as view-only cards: a terminal glyph and `CLI` before the age, and a click does nothing. See [CLI sessions](ASB.md#cli-sessions).

## Local agent commands

The current source adds `asb agent status` and `asb agent sources` commands to list, get, add, update, or remove a source, with `--json` output and JSON files for edits. Commands use the running desktop or service and report saved, backend, and recent UI state separately. Profiles refreshes after external changes and keeps unsaved edits. See [commands and conflict handling](ASB.md#local-agent-commands). Published `1.8.1` packages and the unmanaged `npm start` server do not support these commands.

## ASB Bridge (optional)

ASB Bridge lets local Claude Code sessions and Codex tasks message each other. When ASB Bridge is installed, a message that one agent sends starts a turn in the receiving app.

The current source includes the bridge; published `1.8.1` packages do not. It needs Bun. From a source checkout, run `scripts/asb bridge install --all`. With a package built from this source, run `asb bridge install --all`. Then open Plugins > ASB Bridge in Codex, trust both hooks, and restart Codex. Without a target flag, `asb bridge install` shows usage and changes nothing. See the [bridge guide](bridge/README.md) for explicit targets and the on-demand skills.

Separate Claude profiles can opt in to shared peer discovery with `asb bridge link-claude <profile-home> <shared-home>`. This shares only peer metadata and IPC authentication keys. App data and provider credentials stay separate. Read the [setup and backup limits](bridge/README.md#link-claude-profiles) first.

Codex starts the required bridge server with `bun` from the PATH of the Codex app. If that app cannot start Bun, Codex cannot start or resume tasks. To recover, run `asb bridge uninstall --codex-home <home>` for the affected home; this command does not need Bun. Then make Bun visible to desktop apps, for example with a link in `~/.local/bin` on Linux if that directory is on the app's PATH. Restart Codex and install the bridge again. `asb bridge status` checks the PATH of running Codex app-server processes on Linux and warns when Bun is missing.

ASB Bridge is based on claude-uds-bridge by Leon Kohli (MIT). See [bridge/LICENSE](bridge/LICENSE).

ASB plays Done, Needs input, and Failed sounds on the PC. The sounds are audio from opencode, commit `fe87944b6ae85422db64c751b6d6ee488b0d7f1c` (MIT, Copyright (c) 2025 opencode). The PC copies in `assets/sounds/` are louder than the originals: a gain of 8 to 19 dB and a limiter at about −1 dB peak, because the originals are too quiet on PC speakers. The Android app uses the original files. See [assets/sounds/opencode-LICENSE.txt](assets/sounds/opencode-LICENSE.txt).

Based on [Agent Mission Control 0.6.0](https://github.com/forxidian/agent-mission-control/releases/tag/v0.6.0) by **forxidian**. [MIT license](LICENSE).
