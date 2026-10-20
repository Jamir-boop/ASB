#!/bin/sh
# Usage: sh test/distro-probe.sh board|engine <family>
#
# Reports what this system has for ASB. It installs nothing and starts no ASB program.
# It prints one JSON object on stdout, also when a tool is missing, and writes the same object to
# $ASB_PROBE_OUT when that is set. Then it exits with code 1 when a check fails (code 2 for bad arguments).
# Both tiers need node 20 or later, openssl, xdg-open, and node:sqlite or sqlite3. The board tier also needs
# Python 3.9, PyGObject, GTK 4.12, Libadwaita 1.4, xvfb-run, and dbus-run-session. With ASB_PROBE_WINDOW=skip
# (a release without Xvfb), the board tier does not check xvfb-run.
#
# Keys (a value is null when the command is missing or fails):
#   tier, family        the arguments
#   id, id_like, version_id   ID, ID_LIKE, and VERSION_ID of /etc/os-release, quotes removed (the file is not run)
#   detect              the output of node src/linux-distros.mjs detect, for example "debian normal"
#   node, sqlite3, openssl, xdg_open   the first line of the version output of each tool
#   node_sqlite         true when node:sqlite loads without a flag (null without node)
#   python, gi          the Python and PyGObject versions, from one python3 probe (all its keys are null without python3)
#   gtk, adw, glib      [major, minor, micro] of GTK 4, Libadwaita 1, and GLib, or null
#   cairo, qrcode       true when gi.require_foreign('cairo') works and when qrcode imports
#   board_error         "<type>: <first message line>" (at most 200 characters) of the first failure of the
#                       PyGObject, GTK, and Libadwaita imports, or null
#   pw_play, paplay, aplay, xvfb_run, dbus_run_session   the path of each program
#   errors              the failed checks, as sentences
#   ok                  true when errors is empty
set -u

tier=${1:-}
family=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)
errors=''
code=0

fail() {
  errors="$errors${errors:+,}$(str "$1")"
  [ "$code" -ne 0 ] || code=1
}

# A JSON string, or null for an empty value. The values are single lines; control characters are dropped.
str() {
  if [ -z "$1" ]; then printf 'null'; return; fi
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# The first output line of a command, or nothing when the command fails.
first() {
  out=$("$@" 2>/dev/null) || return 0
  printf '%s\n' "$out" | head -n 1
}

# One os-release value with its outer quotes removed.
release() {
  [ -r /etc/os-release ] || return 0
  sed -n "s/^$1=//p" /etc/os-release | head -n 1 | sed "s/^\"\(.*\)\"\$/\1/; s/^'\(.*\)'\$/\1/"
}

path_of() { str "$(command -v "$1" 2>/dev/null)"; }

case "$tier:$family" in board:?*|engine:?*) ;; *) fail "usage: sh test/distro-probe.sh board|engine <family>"; code=2 ;; esac

node=$(first node --version)
detect=''
node_sqlite=null
if [ -n "$node" ]; then
  detect=$(first node "$root/src/linux-distros.mjs" detect)
  if node -e 'require("node:sqlite")' >/dev/null 2>&1; then node_sqlite=true; else node_sqlite=false; fi
fi
sqlite3=$(first sqlite3 --version)
openssl=$(first openssl version)
xdg_open=$(first xdg-open --version)

# The keys of the Python part; the probe prints them with json.dumps, without the outer braces.
python='"python":null,"gi":null,"gtk":null,"adw":null,"glib":null,"cairo":null,"qrcode":null,"board_error":null'
board=''
probe='
import json, sys
r = {"python": "%d.%d.%d" % sys.version_info[:3], "gi": None, "gtk": None, "adw": None, "glib": None, "cairo": False, "qrcode": False,
     "board_error": None}
def board_error(error):
    if r["board_error"] is None:
        r["board_error"] = (type(error).__name__ + ": " + str(error)).splitlines()[0][:200]
try:
    import gi
    r["gi"] = gi.__version__
except Exception as error:
    board_error(error)
if r["gi"]:
    try:
        gi.require_version("Gtk", "4.0")
        from gi.repository import Gtk
        r["gtk"] = [Gtk.get_major_version(), Gtk.get_minor_version(), Gtk.get_micro_version()]
    except Exception as error:
        board_error(error)
    try:
        gi.require_version("Adw", "1")
        from gi.repository import Adw
        r["adw"] = [Adw.get_major_version(), Adw.get_minor_version(), Adw.get_micro_version()]
    except Exception as error:
        board_error(error)
    try:
        from gi.repository import GLib
        r["glib"] = [GLib.MAJOR_VERSION, GLib.MINOR_VERSION, GLib.MICRO_VERSION]
    except Exception:
        pass
    try:
        gi.require_foreign("cairo")
        r["cairo"] = True
    except Exception:
        pass
try:
    import qrcode
    r["qrcode"] = True
except Exception:
    pass
print(json.dumps(r, separators=(",", ":"))[1:-1])
v = lambda x: x or [0, 0]
print(1 if r["gi"] else 0, v(r["gtk"])[0], v(r["gtk"])[1], v(r["adw"])[0], v(r["adw"])[1], sys.version_info[0], sys.version_info[1])
'
if out=$(python3 -c "$probe" 2>/dev/null); then
  line=$(printf '%s\n' "$out" | sed -n 1p)
  case "$line" in '"python":'*',"qrcode":'*) python=$line; board=$(printf '%s\n' "$out" | sed -n 2p) ;; esac
fi

[ -n "$node" ] || fail "node does not run."
major=${node#v}
major=${major%%.*}
case "$major" in ''|*[!0-9]*) ;; *) [ "$major" -ge 20 ] || fail "Node.js is older than 20." ;; esac
[ -n "$openssl" ] || fail "openssl does not run."
[ -n "$xdg_open" ] || fail "xdg-open does not run."
[ "$node_sqlite" = true ] || [ -n "$sqlite3" ] || fail "Neither node:sqlite loads nor sqlite3 runs."
[ "${detect%% *}" = "$family" ] || fail "The detected family is not $family."
if [ "$tier" = board ]; then
  # shellcheck disable=SC2086 # The probe prints seven numbers. Without python3, only "PyGObject is missing." applies.
  set -- ${board:-0 0 0 0 0 3 9}
  { [ "$6" -gt 3 ] || { [ "$6" -eq 3 ] && [ "$7" -ge 9 ]; }; } || fail "Python is older than 3.9."
  if [ "$1" -ne 1 ]; then fail "PyGObject is missing."; else
    { [ "$2" -gt 4 ] || { [ "$2" -eq 4 ] && [ "$3" -ge 12 ]; }; } || fail "GTK is missing or older than 4.12."
    { [ "$4" -gt 1 ] || { [ "$4" -eq 1 ] && [ "$5" -ge 4 ]; }; } || fail "Libadwaita is missing or older than 1.4."
  fi
  [ "${ASB_PROBE_WINDOW:-}" = skip ] || command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run is missing."
  command -v dbus-run-session >/dev/null 2>&1 || fail "dbus-run-session is missing."
fi

if [ -n "$errors" ]; then ok=false; else ok=true; fi
json=$(printf '{"tier":%s,"family":%s,"id":%s,"id_like":%s,"version_id":%s,"detect":%s,"node":%s,"node_sqlite":%s,"sqlite3":%s,' \
  "$(str "$tier")" "$(str "$family")" "$(str "$(release ID)")" "$(str "$(release ID_LIKE)")" "$(str "$(release VERSION_ID)")" \
  "$(str "$detect")" "$(str "$node")" "$node_sqlite" "$(str "$sqlite3")"
printf '"openssl":%s,"xdg_open":%s,%s,"pw_play":%s,"paplay":%s,"aplay":%s,"xvfb_run":%s,"dbus_run_session":%s,' \
  "$(str "$openssl")" "$(str "$xdg_open")" "$python" "$(path_of pw-play)" "$(path_of paplay)" "$(path_of aplay)" \
  "$(path_of xvfb-run)" "$(path_of dbus-run-session)"
printf '"errors":[%s],"ok":%s}' "$errors" "$ok")

printf '%s\n' "$json"
if [ -n "${ASB_PROBE_OUT:-}" ]; then
  printf '%s\n' "$json" > "$ASB_PROBE_OUT" || { echo "Cannot write $ASB_PROBE_OUT." >&2; exit 1; }
fi
exit "$code"
