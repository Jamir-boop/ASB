# Install and run ASB

## Install on Linux

[Download v1.13.0](https://github.com/Jamir-boop/ASB/releases/tag/v1.13.0) · [Release notes](../docs/releases/v1.13.0.md) · [Checksums](https://github.com/Jamir-boop/ASB/releases/download/v1.13.0/SHA256SUMS)

Needs Node.js `>=20` (`sqlite3` below `22.13`), Python 3 with PyGObject, GTK `>=4.12`, Libadwaita `>=1.4`, and `xdg-utils`. ASB `1.13.0` also needs `openssl` for the phone certificate. The optional Python `qrcode` module and PyGObject cairo support (Debian: `python3-qrcode` and `python3-gi-cairo`) show the phone pairing QR code. A system with no Python, no PyGObject, or an older GTK or Libadwaita runs ASB with [only the engine](#engine-only).

Install Codex and Claude Desktop first, with working `codex:` and `claude:` URL handlers.

On X11, the window uses the Cairo renderer, which uses less memory; to use another renderer, set `GSK_RENDERER` (for example to `gl`) or `GDK_DISABLE`, while Wayland keeps GTK's default.

### Install with npm

ASB `1.13.0` installs as an npm package. It needs the same packages as the other routes. [Windows](#install-on-windows) uses the same commands.

```bash
npm install -g --install-links github:Jamir-boop/ASB
asb setup
```

Keep `--install-links`: without it, npm 11 links the package to a temporary folder that it then deletes, and `asb` stops working.

`asb setup` asks which parts to set up: the board and ASB Bridge (the default), the board only (`--only board`), or ASB Bridge only (`--only bridge`). For the board, it checks the system as `asb doctor` does, and stops when the engine cannot run. Then it makes the engine start when you sign in, waits for it, and asks which network addresses to turn on. It prints the firewall rule when firewalld or ufw is active. ASB never runs that rule itself. For the bridge, it installs [ASB Bridge](#asb-bridge-optional) for each app that does not have it yet, and does not change a bridge that is already installed.

### Check the system

ASB `1.13.0` has `asb doctor`. Run it to check the system. It prints one line for each check: Node.js, `openssl`, `xdg-open`, PyGObject, GTK, Libadwaita, the QR code, the sound player, the tray host, Bun, the autostart, and the runtime folder. The Node.js line shows the built-in SQLite. A `sqlite3` line comes only when Node.js has no built-in SQLite, and a Python line only when Python is missing or older than 3.9. It also checks the handlers of `codex:` and `claude:` links. Then `asb doctor` prints one command for the missing packages and one command for the optional packages. The commands use the package manager of your distribution. ASB never runs them.

`asb doctor` exits with code 0 when the engine can run, else with code 1. `asb doctor --json` prints the same data for a script.

When `ASB_PYTHON` is an absolute path, ASB uses only that Python. Else it uses the first of `/usr/bin/python3` and `python3` on `PATH` that has PyGObject. It finds `xdg-open`, `openssl`, `sqlite3`, and the sound players on `PATH`. For Node.js, see [Node.js](#nodejs).

The window start keeps the last good result of the Python check in `board-check.json` in the ASB cache folder (`~/.cache/asb`; `%LOCALAPPDATA%\asb\cache` on Windows), so that most starts skip the check. ASB checks again after an update or when the window ends with an error. Delete the file to check again. `asb doctor` always runs the full check. When no engine runs, the window starts while the engine starts and gets its address when the engine is ready, so that both start together.

### Packages for each distribution

Each block has the commands that `asb doctor` prints on a system with nothing installed. The first command installs what ASB needs. The second command installs the optional packages: the QR code of the phone pairing, and a sound player. Use `doas` in place of `sudo` when your system has `doas` and no `sudo`.

On every push, CI installs ASB and starts its engine on Debian 13 and 12, Ubuntu 26.04, 24.04, and 22.04, Fedora 43 and 44, AlmaLinux 10, openSUSE Tumbleweed and Leap 16.0, Arch Linux, Alpine 3.24, and Void. It also builds the Nix flake. Gentoo, Solus, and the image-based systems get the same checks and commands, but CI does not run them.

**Debian, Ubuntu, and their derivatives** (family `debian`)

```bash
# Required
sudo apt install nodejs sqlite3 openssl xdg-utils python3-gi gir1.2-gtk-4.0 gir1.2-adw-1
# Optional
sudo apt install python3-gi-cairo python3-qrcode pipewire-bin
```

Debian 12 and Ubuntu 22.04 and 24.04 have a `nodejs` package older than 20. Use the [Node.js route](#nodejs) first. Debian 12 and Ubuntu 22.04 also have a GTK older than 4.12, so ASB runs [only the engine](#engine-only) there.

**Fedora, RHEL, AlmaLinux, Rocky Linux, CentOS Stream, and Oracle Linux** (family `fedora`)

```bash
# Required
sudo dnf install nodejs sqlite openssl xdg-utils python3-gobject gtk4 gobject-introspection libglvnd-gles libadwaita
# Optional
sudo dnf install python3-qrcode-core pipewire-utils
```

The default `nodejs` package of RHEL 9 and its rebuilds is the retired Node.js 16. Run `sudo dnf module install nodejs:24` first (see [Node.js](#nodejs)), and leave `nodejs` out of the first command. ASB `1.13.0` runs the window on their GTK 4.12 and Libadwaita 1.4. The `gtk4` package does not require `libglvnd-gles`, but GTK 4.20 stops without it.

**openSUSE Tumbleweed and Leap** (family `opensuse`)

```bash
# Required
sudo zypper install nodejs-default sqlite3 openssl xdg-utils python3 python313-gobject typelib-1_0-Gtk-4_0 typelib-1_0-Adw-1
# Optional
sudo zypper install python313-gobject-cairo python313-qrcode pipewire-tools
```

The `python313` names follow the main Python of Tumbleweed and Leap 16.0 (Python 3.13). When openSUSE changes its main Python, the names change.

**Arch Linux, Manjaro, EndeavourOS, and Artix** (family `arch`)

```bash
# Required
sudo pacman -S --needed nodejs sqlite openssl xdg-utils python-gobject gtk4 libadwaita
# Optional
sudo pacman -S --needed python-cairo python-qrcode pipewire-audio
```

**Alpine Linux** (family `alpine`)

```bash
# Required
sudo apk add nodejs sqlite openssl xdg-utils py3-gobject3 gtk4.0 libadwaita
# Optional
sudo apk add py3-cairo py3-qrcode pipewire-tools
```

**Void Linux** (family `void`)

```bash
# Required
sudo xbps-install -S nodejs sqlite openssl xdg-utils python3-gobject gtk4 libadwaita
# Optional
sudo xbps-install -S python3-qrcode pipewire
```

**Gentoo** (family `gentoo`)

```bash
# Required
sudo emerge --ask --noreplace net-libs/nodejs dev-db/sqlite dev-libs/openssl x11-misc/xdg-utils dev-python/pygobject gui-libs/gtk gui-libs/libadwaita
# Optional
sudo emerge --ask --noreplace dev-python/qrcode media-video/pipewire
```

Build `gui-libs/gtk` and `gui-libs/libadwaita` with `USE=introspection`, `dev-python/pygobject` with `USE=cairo`, and `media-video/pipewire` with `USE=extra` (for `pw-play`).

**Solus** (family `solus`)

```bash
# Required
sudo eopkg install nodejs sqlite3 openssl xdg-utils python-gobject libgtk-4 libadwaita
# Optional
sudo eopkg install python-qrcode pipewire
```

**NixOS** (family `nixos`)

```bash
nix profile install github:Jamir-boop/ASB
```

The flake brings every package. See [Release packages](#release-packages).

Image-based systems use the names of the Fedora or openSUSE block. Fedora Atomic (Silverblue, Kinoite, Bazzite, Bluefin, and Aurora) uses `rpm-ostree install`. openSUSE Aeon, MicroOS, and Kalpa use `transactional-update pkg install`. Restart the computer to use the new packages. `asb doctor` prints the right command. SteamOS has a read-only system, so `asb doctor` prints no install command there. It lists the needs in words and prints the Node.js route. The window runs only when the image has the libraries.

### Release packages

**Debian:** [asb_1.13.0_all.deb](https://github.com/Jamir-boop/ASB/releases/download/v1.13.0/asb_1.13.0_all.deb)

```bash
sudo apt install ./asb_1.13.0_all.deb
asb
```

**Fedora, RHEL, and their derivatives:** [asb-1.13.0-1.noarch.rpm](https://github.com/Jamir-boop/ASB/releases/download/v1.13.0/asb-1.13.0-1.noarch.rpm)

```bash
sudo dnf install ./asb-1.13.0-1.noarch.rpm
```

**openSUSE:** the same RPM. It has no signature.

```bash
sudo zypper install --allow-unsigned-rpm ./asb-1.13.0-1.noarch.rpm
```

**Arch Linux:** [PKGBUILD](https://github.com/Jamir-boop/ASB/releases/download/v1.13.0/PKGBUILD). Put it in an empty folder, and run this there. `makepkg` needs the `base-devel` package. The `PKGBUILD` downloads the archive of this release and checks its SHA-256.

```bash
makepkg -si
```

**Portable (per-user):** [asb-1.13.0-linux.tar.gz](https://github.com/Jamir-boop/ASB/releases/download/v1.13.0/asb-1.13.0-linux.tar.gz)

```bash
tar -xzf asb-1.13.0-linux.tar.gz
cd asb-1.13.0
./install.sh
~/.local/bin/asb
```

`npm run build` makes the same files from source in `dist/`: the `.deb`, the portable archive, the `PKGBUILD`, `SHA256SUMS`, and the RPM (only when `rpmbuild` is installed). The `.deb` and the RPM list the board libraries as weak dependencies (Recommends), so a system with an old GTK still installs ASB and runs only the engine.

**Nix:** the repository has a flake (`flake.nix`) for `x86_64-linux` and `aarch64-linux`. It works from the default branch now. It brings Node.js 24 and Python with PyGObject, GTK, and Libadwaita. Turn on the `nix-command` and `flakes` features of Nix first.

```bash
nix profile install github:Jamir-boop/ASB
asb
```

`nix run github:Jamir-boop/ASB` runs ASB without an install. `asb service install` writes store paths into the unit or the autostart entry, so run it again after each update of the flake.

### Engine only

The window needs Python 3.9, PyGObject, GTK 4.12, and Libadwaita 1.4. When the system has less, `asb` starts the engine, prints the reason, and exits with code 3. The engine keeps running, and the phone and your other machines still show the sessions of this machine. The tray menu has only **Quit ASB**. The per-user install and `asb setup` succeed with a warning. `asb doctor` names the missing or old part. It prints no package for an old GTK or Libadwaita: update the distribution or use the engine only.

### Start at login without systemd

`asb service install` picks the way to start the engine at login:

- With a systemd user manager and an active graphical session, it installs the `asb.service` user service.
- Without them, in a desktop session (for example Xfce, MATE, LXQt, Cinnamon, or a system with OpenRC, runit, or no systemd), it writes the XDG autostart entry `~/.config/autostart/asb-engine.desktop` and starts the engine. A window manager without XDG autostart must run `asb engine start` after each login. The entry has `TryExec=<launcher>`, so the desktop skips it when the launcher is gone.
- With no desktop session (for example a server without a desktop), it changes nothing, prints the command `<launcher> engine start`, and exits with code 1.

`asb service status` shows the mode. Without `XDG_RUNTIME_DIR`, the engine keeps its runtime file in `~/.local/state/asb/run`.

### Top-bar extension (GNOME)

On GNOME Shell 45 to 49, the ASB extension (`asb@jamir-boop.github.io`) shows ASB in the top bar: the sessions that need you, the sessions that work, and all sessions of your machines. See [Top bar (GNOME)](../ASB.md#top-bar-gnome).

- The per-user install (`./install.sh`) adds it when GNOME Shell 45 or later is installed, and turns it on the first time. An update replaces it. An extension with this name that ASB did not install, or a link in its place, stays as it is. `./uninstall.sh` removes the files that the install wrote.
- The .deb, RPM, and Arch packages install it in `/usr/share/gnome-shell/extensions`, and the Nix package in the `share/gnome-shell/extensions` folder of the profile. Turn it on in the Extensions app, or with `gnome-extensions enable asb@jamir-boop.github.io`.
- With npm, link it one time, then turn it on as above:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$(npm root -g)/agent-switch-board/gnome-shell" ~/.local/share/gnome-shell/extensions/asb@jamir-boop.github.io
```

GNOME Shell loads a new extension only when it starts: on X11, press Alt+F2, type `r`, and press Enter; on Wayland, log out and log in again.

### Firewall

The main ASB server listens only on `127.0.0.1` and needs no rule. Phone access and machine links use TCP port `4630` (the default) on the addresses that you select. Fedora and openSUSE turn firewalld on by default. Ubuntu has `ufw`, turned off by default. When firewalld or ufw is active, `asb setup` and `asb doctor` print the exact rule for each selected address. ASB never runs it. `asb doctor` prints the rule only while the engine runs with phone access on.

[User guide](../ASB.md) · [Privacy](../docs/PRIVACY.md) · [Source setup](../ASB.md#start-and-stop) · [Contributing](../CONTRIBUTING.md)

## Install on Windows

Windows needs Node.js `22.13` or later. Use the npm commands of [Install with npm](#install-with-npm). On Windows, `asb setup` also prints the firewall rule to run.

On Windows, the engine reads Codex and Claude on that PC for the phone and the machine group. Since ASB `1.11.0`, Windows also has the ASB window, the Start menu entry, `asb doctor`, and the PC sounds. The ASB window needs MSYS2 Python with PyGObject, GTK `>=4.12`, and Libadwaita `>=1.4`; without it, only the engine runs. To get the window, install MSYS2 and these packages. `asb doctor` prints these commands (the first only when MSYS2 is missing) and never runs them:

```powershell
winget install --id MSYS2.MSYS2 -e
C:\msys64\usr\bin\pacman.exe -S --needed mingw-w64-ucrt-x86_64-python-gobject mingw-w64-ucrt-x86_64-gtk4 mingw-w64-ucrt-x86_64-libadwaita
```

Then run `asb`, select **Open ASB** in the tray icon, or select ASB in the Start menu (`asb setup` adds it). The window needs a signed-in desktop session. MSYS2 has no Python `qrcode` package, so Preferences shows the pairing link and no QR code on Windows. The window uses the Cairo renderer, unless you set `GSK_RENDERER` or put `dcomp` in `GDK_DEBUG`. ASB Bridge and messages between machines also work on Windows. See [Windows](../ASB.md#windows).

## Node.js

ASB needs Node.js 20 or later. Node.js 22.13 or later is recommended: older releases have no built-in SQLite, so ASB then uses the `sqlite3` command. ASB never downloads Node.js. On Linux, the launcher uses the first of these that is Node.js 20 or later with SQLite: `ASB_NODE` (an absolute path), `node` on `PATH`, `~/.local/bin/node`, `/home/linuxbrew/.linuxbrew/bin/node`, `/usr/local/bin/node`, and `/usr/bin/node`.

When the Node.js package of your distribution is older than 20, use the official route:

| Release | Route |
| --- | --- |
| Debian 12, Ubuntu 22.04 and 24.04, and their derivatives | Install Node.js 24 from [NodeSource](https://github.com/nodesource/distributions). |
| RHEL, AlmaLinux, Rocky, CentOS Stream, and Oracle Linux 9 | `sudo dnf module install nodejs:24` |
| SteamOS | Unpack the Linux archive from [nodejs.org](https://nodejs.org/en/download) into `~/.local`, so that `~/.local/bin/node` exists. |
| Other releases | The `nodejs` package of the distribution. Image-based systems install it with the command of the [package blocks](#packages-for-each-distribution). |

`asb doctor` prints the route for your system.

## Android companion (optional)

The ASB Android app shows your sessions on your phone over your local network, or away from home through ZeroTier or Tailscale. It can open a chat on the PC, use the row actions, and change Persistent unread. It shows Done, Failed, and Needs input notifications. In a machine group, the app uses another machine of the group when the paired PC does not answer.

The [live notification](../android/README.md#live-notification) shows session counts with Pending first and can be an Android 16 Live update, so HyperOS can show it in its island. In-app messages show in a small dark pill over the toolbar.

Phone access is off by default. In ASB, open Preferences > Phone, select **Allow phone access**, select one or more addresses (Home network, ZeroTier, or Tailscale), and select **Apply**. Then select **Pair a phone** and scan the QR code with **Scan QR code** in the ASB app or with the phone camera, or paste the pairing link in the app. Compare the certificate fingerprint on the PC and the phone. See the [Android guide](../android/README.md) to build and install the app.

## Run without the window (optional)

The ASB engine (the server and phone access) runs without the window. `asb` starts the engine when none runs, then opens the window. When the system cannot run the window (for example GTK older than 4.12), `asb` keeps the engine running, prints the reason, and exits with code 3; the phone and your other machines still show this machine's sessions. Closing the window keeps the engine and phone access running. To stop them, select **Quit ASB** in Preferences > Sessions or in the tray icon menu. `asb engine start`, `asb engine stop`, and `asb engine status` do the same from a terminal.

On Linux, the engine shows a tray icon. Its menu has **Open ASB**, **Messages**, **Usage**, a separator, and **Quit ASB** (only **Quit ASB** when the window cannot run). **Open ASB** and a left click bring the open board to the front, or start the board when no board is open. **Messages** and **Usage** open that window on the open board, or start the board with that window when no board is open. The icon shows only when the desktop has a tray host, for example the GNOME AppIndicator extension. Without a tray host, the engine runs with no icon. While the [top-bar extension](#top-bar-extension-gnome) runs, the icon hides itself.

`asb service install` installs and starts the `asb.service` systemd user service, so the engine also starts with your session. Without a systemd graphical session, it uses an XDG autostart entry instead, or it changes nothing when there is no desktop session. See [Start at login without systemd](#start-at-login-without-systemd). `asb service status` shows the service or entry state. `asb service uninstall` stops and removes it. When the service is installed, `asb` starts the engine through it. An ASB `1.8.1` or older window cannot attach and reports a port conflict.

The ASB `1.13.0` packages include the user service. The Android companion is a separate app: the Linux packages do not include it.

ASB `1.13.0` can also join ASB on several of your computers in one machine group: each machine then shows the sessions of the others as cards. See [Machines](../ASB.md#machines).

In a machine group, Claude and Codex sessions on one machine can message sessions on the other machines (Linux and Windows). The other sessions appear in `/list-agents` (Claude) and `list_sessions` (Codex) with the machine name first. A message to a machine that is offline is refused at once; ASB keeps no queue. Each machine needs Bun for its engine: on its `PATH` (on Windows a `bun.exe`; the `bun.cmd` that `npm i -g bun` puts on `PATH` does not count), or in the folder of the Bun installer (`$BUN_INSTALL/bin` or `~/.bun/bin`; on Windows, `%BUN_INSTALL%\bin` or `%USERPROFILE%\.bun\bin`). `asb group status` shows if the message relay runs, and the engine log has one line when Bun is missing. See [Messages between machines](../ASB.md#messages-between-machines-linux-and-windows).

## OpenCode sessions (list only)

ASB `1.13.0` also lists OpenCode 2 sessions from the local OpenCode database. OpenCode cards show state, the last result, and unread, but ASB cannot open them: OpenCode 2 has no link that opens one session. The optional ASB Bridge also lets an OpenCode session send and receive messages. See [OpenCode](../ASB.md#opencode).

## CLI sessions (view only)

ASB also shows Claude Code CLI and Codex CLI sessions as view-only cards: a terminal glyph and `CLI` before the age, and a click does nothing. See [CLI sessions](../ASB.md#cli-sessions).

## Local agent commands

ASB has `asb agent status` and `asb agent sources` commands to list, get, add, update, or remove a source, with `--json` output and JSON files for edits. Commands use the running desktop or service and report saved, backend, and recent UI state separately. Profiles refreshes after external changes and keeps unsaved edits. See [commands and conflict handling](../ASB.md#local-agent-commands). The ASB `1.13.0` packages include these commands. ASB `1.8.1` or older packages and the unmanaged `npm start` server do not support them.

## ASB Bridge (optional)

ASB Bridge lets local Claude Code sessions, Codex tasks, and OpenCode 2 sessions message each other. When ASB Bridge is installed, a message that one agent sends starts a turn in the receiving app.

The ASB `1.13.0` packages include ASB Bridge `0.8.0`; ASB `1.8.1` or older packages do not. It needs Bun. From a source checkout, run `scripts/asb bridge install --all`. With an ASB `1.13.0` package, run `asb bridge install --all`. `asb setup` also installs it for the apps that do not have it (`asb setup --only bridge` installs only the bridge), and Preferences > Profiles shows its state for each profile, with **Install** or **Update**. Then open Plugins > ASB Bridge in Codex, trust both hooks, and restart Codex. `asb bridge install --opencode` adds the OpenCode plugin; `--all` adds it when the OpenCode config folder exists. Without a target flag, `asb bridge install` shows usage and changes nothing. See the [bridge guide](../bridge/README.md) for explicit targets and the usage skills.

Codex tasks and OpenCode sessions can send by session reference (`asb:1/...`). Claude Code sessions first run `asb agent resolve-session <reference>`, which prints the `SendMessage` name on the `Send name:` line. If it prints `Send name: none`, send nothing. `asb bridge status` says when an installed bridge skill is out of date and which `asb bridge install` target updates it.

Separate Claude profiles can opt in to shared peer discovery with `asb bridge link-claude <profile-home> <shared-home>`. This shares only peer metadata and IPC authentication keys. App data and provider credentials stay separate. Read the [setup and backup limits](../bridge/README.md#link-claude-profiles) first.

Codex starts the required bridge server with `bun` from the PATH of the Codex app. If that app cannot start Bun, Codex cannot start or resume tasks. To recover, run `asb bridge uninstall --codex-home <home>` for the affected home; this command does not need Bun. Then make Bun visible to desktop apps, for example with a link in `~/.local/bin` on Linux if that directory is on the app's PATH. Restart Codex and install the bridge again. `asb bridge status` checks the PATH of running Codex app-server processes on Linux and warns when Bun is missing.

## Uninstall

To remove the per-user install, run these commands in the unpacked folder (for example `asb-1.13.0`):

```bash
./scripts/asb service uninstall
./scripts/asb bridge uninstall --all
./uninstall.sh
```

The first command removes the start at login. The second removes ASB Bridge from Codex, Claude Code, and OpenCode. `./uninstall.sh` removes the files that the install wrote. ASB settings, pins, and unread state stay.
