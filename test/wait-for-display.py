#!/usr/bin/env python3
"""Usage: python3 -I test/wait-for-display.py [seconds]

Waits until GDK can open the X display in DISPLAY, then exits 0; exits 1 after the timeout (default 30 s).
test/distro-check.sh runs it inside xvfb-run before the board: xvfb-run can start its command while Xvfb
does not accept clients yet, and the board then stops with "Gtk couldn't be initialized".
"""
import os
import sys
import time

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, Gtk  # noqa: E402

# GDK opens no display before GTK init. This init can fail while Xvfb starts; later opens still work.
Gtk.init_check()


def wait_for_display(name, timeout):
    deadline = time.monotonic() + timeout
    while True:
        display = Gdk.Display.open(name) if name else None
        if display is not None:
            display.close()
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.2)


def main():
    timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    name = os.environ.get("DISPLAY", "")
    started = time.monotonic()
    if not wait_for_display(name, timeout):
        print(f"FAILED: the X display {name or '(DISPLAY is empty)'} did not open in {timeout:g} s.", file=sys.stderr)
        return 1
    print(f"The X display {name} opened after {time.monotonic() - started:.1f} s.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
