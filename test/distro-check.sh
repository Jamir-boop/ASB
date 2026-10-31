#!/bin/sh
# Usage: ASB_DISTRO_CHECK=1 sh test/distro-check.sh <family> <tier> <package>
#
# Installs ASB in a CI container and starts it (plan 17.3). Only the check job of .github/workflows/distros.yml runs it.
# It runs as root: it installs packages, creates the user asbtest, and starts an ASB engine on port 4629.
# The guard below stops it on a real PC (exit code 2).
#   family    debian, fedora, opensuse, arch, alpine, or void
#   tier      board or engine
#   package   the release package to install at the end: deb, rpm, pkgbuild, or none
# The workflow sets these variables:
#   ASB_DISTRO_CHECK=1      the guard
#   ASB_CHECK_REFRESH       the index update of the family
#   ASB_CHECK_ROUTE         the Node.js route of the row (":" when the repository has Node.js 20 or later)
#   ASB_CHECK_REQUIRED, ASB_CHECK_BOARD, ASB_CHECK_OPTIONAL, ASB_CHECK_CI   the install commands of the four key groups
#   ASB_CHECK_WINDOW=skip   the row has no Xvfb, so the board window is not opened
#   ASB_CHECK_SNAPSHOT=skip   the board cannot save its image on the row, so step 7 waits for "UI: verified" from asb agent status
#   ASB_CHECK_PREFERENCES=check   step 11 opens Preferences > Profiles and one profile dialog with the installed board
#   ASB_CHECK_WIDGETS=run   step 12 runs the board widget tests (test/asb_native_test.py) in Xvfb
# The repository is mounted read only at /asb, and the build output is at /asb/dist.
# Each step prints one "==> step N" line before it starts, and the script stops at the first error.
# POSIX sh only: Alpine (busybox ash), Void, Arch, Fedora, openSUSE, Debian, and Ubuntu all run it with their own sh.
set -eu

if [ "${ASB_DISTRO_CHECK:-}" != 1 ] || [ "$(id -u)" -ne 0 ]; then
  echo "Refusing to run: this script installs packages, creates a user, and starts an ASB engine. Run it only as root in a CI container, with ASB_DISTRO_CHECK=1." >&2
  exit 2
fi

family=${1:-}
tier=${2:-}
package=${3:-}
case "$family" in debian|fedora|opensuse|arch|alpine|void) ;; *) echo "Unknown family: $family" >&2; exit 2 ;; esac
case "$tier" in board|engine) ;; *) echo "Unknown tier: $tier" >&2; exit 2 ;; esac
case "$package" in deb|rpm|pkgbuild|none) ;; *) echo "Unknown package: $package" >&2; exit 2 ;; esac

dist=/asb/dist
user=asbtest
home=/home/$user
launcher=$home/.local/bin/asb
entry=$home/.config/autostart/asb-engine.desktop
# The start of every command of asbtest: no runtime folder, no session bus, no desktop, a clean HOME, USER, and LOGNAME (su sets them, python3 does not), and ~/.local/bin on PATH.
session="unset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP DESKTOP_SESSION; HOME=$home; USER=$user; LOGNAME=$user; PATH=$home/.local/bin:$PATH; export HOME USER LOGNAME PATH; cd $home &&"
# The user switch of an image without su (AlmaLinux 10 has only util-linux-core): python3 drops root like su does, then runs the command with sh.
switch='import os, pwd, sys; pw = pwd.getpwnam(sys.argv[1]); os.initgroups(pw.pw_name, pw.pw_gid); os.setgid(pw.pw_gid); os.setuid(pw.pw_uid); os.execv("/bin/sh", ["/bin/sh", "-c", sys.argv[2]])'

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

step() {
  echo "==> step $1: $2"
}

as_user() {
  if command -v su >/dev/null 2>&1; then
    su -s /bin/sh "$user" -c "$session $1"
  else
    python3 -I -c "$switch" "$user" "$session $1"
  fi
}

# The one file that a glob matched, else a failure.
one_file() {
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Expected exactly one file, got: $*" >&2
    return 1
  fi
  printf '%s\n' "$1"
}

# Steps 1 and 2: the index update, the Node.js route (step 2, empty on repository rows), and the installs, in the order of the probe job.
install_packages() {
  step 1 "update the index, add Node.js by its route, and install the required, board, optional, and CI packages"
  eval "${ASB_CHECK_REFRESH:?}"
  eval "${ASB_CHECK_ROUTE:-:}"
  eval "${ASB_CHECK_REQUIRED:?}"
  eval "${ASB_CHECK_BOARD:?}"
  eval "${ASB_CHECK_OPTIONAL:?}"
  eval "${ASB_CHECK_CI:?}"
}

create_user() {
  step 3 "create the user $user"
  if command -v useradd >/dev/null 2>&1; then
    useradd -m -d "$home" -s /bin/sh "$user"
  elif command -v adduser >/dev/null 2>&1; then
    adduser -D -h "$home" -s /bin/sh "$user"
  else
    fail "Neither useradd nor adduser exists."
  fi
  command -v su >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || fail "Neither su nor python3 exists."
  as_user 'test "$(id -un)" = asbtest && test -w "$HOME"' || fail "The image cannot run a command as $user."
}

install_asb() {
  step 4 "unpack the archive and run install.sh"
  archive=$(one_file "$dist"/asb-*-linux.tar.gz)
  version=${archive##*/}
  version=${version#asb-}
  version=${version%-linux.tar.gz}
  # -o: the archive has owner 0, and asbtest cannot give files to root (busybox tar and GNU tar both read -o as "do not restore the owner").
  as_user "tar -xzof $archive -C $home && cd $home/asb-$version && ./install.sh"
  [ -x "$launcher" ] || fail "install.sh did not write $launcher."
}

# Step 5: board.ok must match the tier and commands.required must be empty (null or an empty array). $1 is the launcher.
check_doctor() {
  step 5 "asb doctor --json with $1"
  code=0
  as_user "$1 doctor --json" >/tmp/asb-doctor.json || code=$?
  if [ "$code" -eq 0 ]; then
    node -e '
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const want = process.argv[2] === "board";
      const required = d.commands.required;
      const errors = [];
      if (d.board.ok !== want) errors.push(`board.ok is ${d.board.ok} (${d.board.reason}), expected ${want}`);
      if (required && required.length) errors.push(`commands.required is not empty: ${required.join(" ")}`);
      if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
      console.log(`board.ok is ${d.board.ok}, commands.required is empty`);
    ' /tmp/asb-doctor.json "$tier" || code=$?
  fi
  if [ "$code" -ne 0 ]; then
    as_user "$1 doctor" || true
    fail "asb doctor failed the check (exit code $code, expected 0)."
  fi
}

# Step 6: the engine, the loopback API, and the autostart modes. $1 is the launcher.
check_engine() {
  step 6 "engine, agent, and service with $1"
  as_user "$1 engine start"
  [ -f "$home/.local/state/asb/run/service.json" ] || fail "The runtime file is not in $home/.local/state/asb/run."
  as_user "$1 agent status"
  as_user "$1 engine stop"
  code=0
  as_user "$1 engine status" || code=$?
  [ "$code" -eq 1 ] || fail "asb engine status exited with code $code after the stop, expected 1."
  # No desktop session: the none mode refuses.
  code=0
  out=$(as_user "$1 service install" 2>&1) || code=$?
  printf '%s\n' "$out"
  [ "$code" -eq 1 ] || fail "asb service install exited with code $code without a desktop session, expected 1."
  case $out in *"No desktop session was found"*) ;; *) fail "The none refusal text is missing." ;; esac
  [ ! -e "$entry" ] || fail "service install wrote $entry without a desktop session."
  # A desktop session and no systemd user manager: the xdg mode.
  code=0
  out=$(as_user "XDG_CURRENT_DESKTOP=CI $1 service install" 2>&1) || code=$?
  printf '%s\n' "$out"
  [ "$code" -eq 0 ] || fail "asb service install exited with code $code in a desktop session, expected 0."
  case $out in *"through XDG autostart"*) ;; *) fail "service install did not use the xdg mode." ;; esac
  grep -qxF '# Generated by ASB: engine autostart' "$entry" || fail "$entry has no ASB marker."
  grep -qF "$1 engine start" "$entry" || fail "$entry does not name $1."
  as_user "$1 engine status" || fail "The engine does not run after service install."
  as_user "$1 service uninstall"
  [ ! -e "$entry" ] || fail "service uninstall kept $entry."
  code=0
  as_user "$1 engine status" || code=$?
  [ "$code" -eq 1 ] || fail "The engine runs after service uninstall (asb engine status exited with code $code)."
}

# The logs of a board that failed its proof, then the end of the board.
board_failed() {
  tail -n 30 "$log" "$xlog" "$home/.local/state/asb/engine.log" >&2 || true
  kill "$board" 2>/dev/null || true
}

# Step 7: the board tier opens the window in Xvfb and saves its image, or (ASB_CHECK_SNAPSHOT=skip) waits for UI: verified. The engine tier prints the engine-only message.
check_window() {
  if [ "$tier" = engine ]; then
    step 7 "the engine tier opens no window: asb exits with code 3"
    code=0
    out=$(as_user "$launcher" 2>&1) || code=$?
    printf '%s\n' "$out"
    [ "$code" -eq 3 ] || fail "asb exited with code $code on the engine tier, expected 3."
    case $out in *"ASB runs without its window on this system"*) ;; *) fail "The engine-only message is missing." ;; esac
    as_user "$launcher engine stop"
    return 0
  fi
  if [ "${ASB_CHECK_WINDOW:-}" = skip ]; then
    step 7 "skip: this row has no Xvfb, so the window is not opened (step 5 checked the board libraries)"
    return 0
  fi
  png=/tmp/asb-board.png
  log=/tmp/asb-board.log
  xlog=/tmp/asb-xvfb.log
  rm -f "$png" "$log" "$xlog"
  if [ "${ASB_CHECK_SNAPSHOT:-}" = skip ]; then
    step 7 "open the board in Xvfb and wait for UI: verified (this row cannot save the board image)"
    snapshot=
  else
    step 7 "open the board in Xvfb and save its image"
    snapshot=ASB_SNAPSHOT=$png
  fi
  # xvfb-run can start its command before Xvfb accepts clients: the board starts only when GDK can open the display.
  # -noreset: without it, Xvfb resets when its last set-up client leaves (the engine's GTK check), and the reset drops a board connection that is not set up yet.
  # Xvfb writes its errors to $xlog (xvfb-run sends them to /dev/null without -e).
  as_user "dbus-run-session -- xvfb-run -a -e $xlog -s '-screen 0 1280x1024x24 -noreset' sh -c 'python3 -I /asb/test/wait-for-display.py && exec env $snapshot $launcher' >$log 2>&1" &
  board=$!
  seconds=0
  if [ -n "$snapshot" ]; then
    # The image is ready when it has at least 1 KB and the same size on two checks in a row.
    last=-1
    while :; do
      size=0
      [ ! -f "$png" ] || size=$(wc -c <"$png")
      size=$((size + 0))
      if [ "$size" -ge 1024 ] && [ "$size" -eq "$last" ]; then break; fi
      last=$size
      kill -0 "$board" 2>/dev/null || break
      [ "$seconds" -lt 90 ] || break
      sleep 1
      seconds=$((seconds + 1))
    done
    if [ "$size" -lt 1024 ] || [ "$size" -ne "$last" ]; then
      board_failed
      fail "The board saved no image (size $size bytes after $seconds s)."
    fi
    echo "The board saved $png ($size bytes after $seconds s)."
  else
    # The open window reports to the engine, and asb agent status then prints "UI: verified". The first calls fail while the engine starts.
    verified=
    status=
    while kill -0 "$board" 2>/dev/null; do
      status=$(as_user "$launcher agent status" 2>/dev/null) || status=
      case $status in *"UI: verified"*) verified=1; break ;; esac
      [ "$seconds" -lt 90 ] || break
      sleep 1
      seconds=$((seconds + 1))
    done
    if [ -z "$verified" ] || ! kill -0 "$board" 2>/dev/null; then
      printf '%s\n' "$status" >&2
      board_failed
      fail "The board did not report UI: verified while it ran (after $seconds s)."
    fi
    printf '%s\n' "$status" | grep -F 'UI: verified'
    echo "The board reported UI: verified after $seconds s."
  fi
  as_user "$launcher engine stop"
  # The window closes with its engine.
  seconds=0
  while kill -0 "$board" 2>/dev/null && [ "$seconds" -lt 20 ]; do
    sleep 1
    seconds=$((seconds + 1))
  done
  if kill -0 "$board" 2>/dev/null; then
    kill "$board" 2>/dev/null || true
    fail "The board stayed open 20 s after its engine stopped."
  fi
  wait "$board" || true
}

run_python_tests() {
  step 8 "run the Python tests"
  as_user "PYTHONDONTWRITEBYTECODE=1 python3 /asb/test/asb_native_logic_test.py"
  if [ "$tier" = board ]; then
    as_user "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s /asb/test -p 'asb_tray_test.py'"
  fi
}

uninstall_asb() {
  step 9 "run uninstall.sh"
  as_user "cd $home/asb-$version && ./uninstall.sh"
  [ ! -e "$launcher" ] || fail "uninstall.sh kept $launcher."
}

# Step 10: install the release package as root, then repeat steps 5 and 6 with /usr/bin/asb.
install_package() {
  if [ "$package" = none ]; then
    step 10 "skip: the $family row has no release package"
    return 0
  fi
  step 10 "install the $package package"
  case $package in
    deb)
      deb=$(one_file "$dist"/asb_*_all.deb)
      # apt reads the file as its own user, so it needs a readable copy.
      cp "$deb" /tmp/
      chmod 644 "/tmp/${deb##*/}"
      DEBIAN_FRONTEND=noninteractive apt-get install -y "/tmp/${deb##*/}"
      ;;
    rpm)
      rpm=$(one_file "$dist"/asb-*.noarch.rpm)
      cp "$rpm" /tmp/
      case $family in
        fedora) dnf install -y "/tmp/${rpm##*/}" ;;
        opensuse) zypper --non-interactive install --allow-unsigned-rpm "/tmp/${rpm##*/}" ;;
        *) fail "No rpm install command for the $family family." ;;
      esac
      ;;
    pkgbuild)
      # makepkg refuses to run as root, and it needs fakeroot and binutils. It finds the archive next to the PKGBUILD, so it downloads nothing.
      pacman -S --needed --noconfirm base-devel
      as_user "mkdir -p $home/pkgbuild && cp $dist/PKGBUILD $archive $home/pkgbuild/ && cd $home/pkgbuild && makepkg"
      pkg=$(one_file "$home"/pkgbuild/asb-*.pkg.tar.zst)
      pacman -U --noconfirm "$pkg"
      ;;
  esac
  [ -x /usr/bin/asb ] || fail "/usr/bin/asb is missing after the $package install."
  check_doctor /usr/bin/asb
  check_engine /usr/bin/asb
}

check_preferences() {
  [ "${ASB_CHECK_PREFERENCES:-}" = check ] || return 0
  step 11 "check Preferences > Profiles with the installed board in Xvfb"
  # The release launcher /usr/bin/asb runs /usr/lib/asb/scripts/asb.
  native=/usr/lib/asb/scripts/asb-native.py
  [ -f "$native" ] || fail "The installed board script $native is missing."
  as_user "ASB_TRAY=0 PYTHONDONTWRITEBYTECODE=1 timeout 120 dbus-run-session -- xvfb-run -a -e /tmp/asb-preferences-xvfb.log -s '-screen 0 1280x1024x24 -noreset' python3 -I /asb/test/preferences-check.py --board $native" || {
    cat /tmp/asb-preferences-xvfb.log >&2 || true
    fail "Preferences > Profiles failed."
  }
}

check_widgets() {
  [ "${ASB_CHECK_WIDGETS:-}" = run ] || return 0
  step 12 "run the board widget tests in Xvfb"
  # The widget tests need the Cantarell font, the Adwaita icons, and xdotool for the real pointer tests.
  case $family in
    debian) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fonts-cantarell adwaita-icon-theme xdotool ;;
    *) fail "No widget test packages for the $family family." ;;
  esac
  # A 1440 px test window must fit the screen, and GTK sizes a window exactly only with a compositor selection owner.
  as_user "ASB_TRAY=0 PYTHONDONTWRITEBYTECODE=1 timeout 900 dbus-run-session -- xvfb-run -a -e /tmp/asb-widgets-xvfb.log -s '-screen 0 1600x1000x24 -noreset' python3 -I /asb/test/compositor-stub.py python3 -m unittest discover -s /asb/test -p asb_native_test.py" || {
    cat /tmp/asb-widgets-xvfb.log >&2 || true
    fail "The board widget tests failed."
  }
}

install_packages
create_user
install_asb
check_doctor "$launcher"
check_engine "$launcher"
check_window
run_python_tests
uninstall_asb
install_package
check_preferences
check_widgets
echo "==> all steps passed"
