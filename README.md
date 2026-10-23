# ASB

**Agent Switch Board** is a native switch board with GTK 4 and Libadwaita: GNOME on Linux, and Windows with MSYS2. It lists your Codex and Claude Desktop Code chats and opens a chat in its own app; it also lists OpenCode 2 sessions and shows Claude Code CLI and Codex CLI sessions (view only). An optional machine group shows sessions from your other computers, an optional Android app shows them on your phone, and the optional ASB Bridge lets sessions message each other. ASB reads the app stores read-only and makes no model calls.

![ASB banner](docs/media/asb-banner.png)

https://github.com/user-attachments/assets/c85742f4-d1b0-4ffc-9497-144069fec36b

## What it does

- List Codex and Claude Desktop Code chats and open them in their own app.
- List OpenCode 2 sessions and show Claude Code CLI and Codex CLI sessions (view only).
- Show Pending attention, unread marks, pins, and a drawer for sessions.
- Show sessions from your other computers in an optional machine group.
- Show sessions and notifications on Android, with an Android 16 Live update chip and Pending counts first.
- Let sessions message each other through ASB Bridge, also by session reference; Claude Code uses resolved send names.
- Play Done, Needs input, and Failed sounds on the PC.
- Read the app stores read-only and make no model calls.

## Install on Linux

Needs Node.js `>=20` (`sqlite3` below `22.13`), Python 3 with PyGObject, GTK `>=4.12`, Libadwaita `>=1.4`, `xdg-utils`, and `openssl`.
Install Codex and Claude Desktop first, with working `codex:` and `claude:` URL handlers.

### Install with npm

```bash
npm install -g --install-links github:Jamir-boop/ASB
asb setup
```

Keep `--install-links`: npm 11 needs it to keep the install working.
See the [full install guide](docs/INSTALL.md) for system checks, distribution packages, release packages, and engine-only use.

## Install on Windows

Windows needs Node.js `22.13` or later and uses the same npm commands.
ASB runs the engine and the GTK window on Windows. The window needs MSYS2 Python, PyGObject, GTK `>=4.12`, and Libadwaita `>=1.4`.
See [Windows setup](docs/INSTALL.md#install-on-windows) for the packages and commands.

## Android companion (optional)

The optional Android app shows your sessions and notifications on your phone; phone access is off by default.
The [live notification](android/README.md#live-notification) shows Pending counts first and can be an Android 16 Live update, so HyperOS can show it in its island; in-app messages show in a small dark pill over the toolbar.
See the [Android guide](android/README.md) for pairing, building, and installing the app.

## ASB Bridge (optional)

The ASB `1.11.0` packages have ASB Bridge `0.8.0`, with OpenCode 2 support and sends by session reference (`asb:1/...`) from Codex and OpenCode.
Claude Code sessions run `asb agent resolve-session <reference>` to get the `SendMessage` name (`Send name:`); `asb bridge status` says when an installed skill is out of date and which `asb bridge install` target updates it.
See the [bridge guide](bridge/README.md) and [setup and recovery](docs/INSTALL.md#asb-bridge-optional).

[User guide](ASB.md) · [Privacy](docs/PRIVACY.md) · [Source setup](ASB.md#start-and-stop) · [Contributing](CONTRIBUTING.md) · [Install guide](docs/INSTALL.md)

ASB Bridge is based on claude-uds-bridge by Leon Kohli (MIT). See [bridge/LICENSE](bridge/LICENSE).

ASB plays Done, Needs input, and Failed sounds on the PC. The sounds are audio from opencode, commit `fe87944b6ae85422db64c751b6d6ee488b0d7f1c` (MIT, Copyright (c) 2025 opencode). The PC copies in `assets/sounds/` are louder than the originals: a gain of 8 to 19 dB and a limiter at about −1 dB peak, because the originals are too quiet on PC speakers. The Android app uses the original files. See [assets/sounds/opencode-LICENSE.txt](assets/sounds/opencode-LICENSE.txt).

Based on [Agent Mission Control 0.6.0](https://github.com/forxidian/agent-mission-control/releases/tag/v0.6.0) by **forxidian**. [MIT license](LICENSE).
