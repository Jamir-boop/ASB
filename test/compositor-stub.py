"""Usage: python3 -I test/compositor-stub.py <command> [args...]

Runs <command> on the X display in DISPLAY while this script owns the compositor selection
(_NET_WM_CM_S<screen>), as a desktop compositor does. GTK checks that selection: on an X display without an
owner (plain Xvfb), GTK 4.18 gives each window 10 px less width and height than its default size, and the
exact size checks of test/asb_native_test.py fail. The script draws nothing and never maps its window.
It waits at most 30 s until the display opens (xvfb-run can start its command before Xvfb accepts clients),
leaves a selection that has an owner already, and exits with the exit code of <command>.
test/distro-check.sh runs the board widget tests through it (step 12).
"""
import ctypes
import os
import subprocess
import sys
import time

x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = (ctypes.c_char_p,)
x11.XDefaultScreen.restype = ctypes.c_int
x11.XDefaultScreen.argtypes = (ctypes.c_void_p,)
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = (ctypes.c_void_p,)
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = (ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int)
x11.XGetSelectionOwner.restype = ctypes.c_ulong
x11.XGetSelectionOwner.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
x11.XCreateSimpleWindow.restype = ctypes.c_ulong
x11.XCreateSimpleWindow.argtypes = (ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                                    ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong)
x11.XSetSelectionOwner.restype = ctypes.c_int
x11.XSetSelectionOwner.argtypes = (ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
x11.XSync.restype = ctypes.c_int
x11.XSync.argtypes = (ctypes.c_void_p, ctypes.c_int)


def main(command):
    if not command:
        print(__doc__, file=sys.stderr)
        return 2
    name = os.environ.get("DISPLAY", "")
    if not name:
        print("FAILED: DISPLAY is empty.", file=sys.stderr)
        return 1
    start = time.monotonic()
    while not (display := x11.XOpenDisplay(name.encode())):
        if time.monotonic() - start >= 30:
            print(f"FAILED: the X display {name} did not open in 30 s.", file=sys.stderr)
            return 1
        time.sleep(0.2)
    seconds = time.monotonic() - start
    screen = x11.XDefaultScreen(display)
    atom = x11.XInternAtom(display, f"_NET_WM_CM_S{screen}".encode(), 0)
    if x11.XGetSelectionOwner(display, atom):
        print(f"The X display {name} opened after {seconds:.1f} s; _NET_WM_CM_S{screen} has an owner already.",
              file=sys.stderr)
    else:
        window = x11.XCreateSimpleWindow(display, x11.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
        x11.XSetSelectionOwner(display, atom, window, 0)
        x11.XSync(display, 0)
        if x11.XGetSelectionOwner(display, atom) != window:
            print(f"FAILED: cannot own _NET_WM_CM_S{screen} on {name}.", file=sys.stderr)
            return 1
        print(f"The X display {name} opened after {seconds:.1f} s; this script owns _NET_WM_CM_S{screen}.",
              file=sys.stderr)
    # The X connection stays open until the command ends: closing it releases the selection.
    code = subprocess.run(command).returncode
    return 128 - code if code < 0 else code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
