#!/usr/bin/env python3
"""Starts the ASB board from asb-native.py as a module, so that Python keeps its compiled code between starts."""
import importlib.util
import os
import sys
from pathlib import Path

def prefer_cairo(environ, system=os.name):
    """Use Cairo on Windows for a faster start and on X11 for less memory and faster repaint.
    Keep user settings and Windows DirectComposition requests; Wayland keeps GTK's default."""
    if system == "nt" and not environ.get("GSK_RENDERER") and "dcomp" not in environ.get("GDK_DEBUG", "").lower():
        environ["GSK_RENDERER"] = "cairo"
    elif system != "nt":
        backend = environ.get("GDK_BACKEND", "").split(",", 1)[0].strip()
        x11 = backend == "x11" or (backend in ("", "*") and not environ.get("WAYLAND_DISPLAY") and environ.get("DISPLAY"))
        if x11 and not environ.get("GSK_RENDERER") and not environ.get("GDK_DISABLE"):
            environ["GSK_RENDERER"] = "cairo"
            environ["GDK_DISABLE"] = "gl,vulkan"


def use_app_id(system=os.name):
    """On Windows, python.exe runs the board, so Windows puts the board window under Python and shows the Python icon on the taskbar.
    An own AppUserModelID gives the board its own taskbar button with the window icon. It is APP_ID of asb-native.py."""
    if system == "nt":
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("local.asb.AgentSwitchBoard")


# Set renderer defaults before GTK starts: Cairo avoids a failed GL start on Windows and reduces memory and repaint work on X11.
# Windows also reads the AppUserModelID before the first window opens.
prefer_cairo(os.environ)
use_app_id()
source = Path(__file__).with_name("asb-native.py")
spec = importlib.util.spec_from_file_location("asb_native", source)
board = importlib.util.module_from_spec(spec)
# The same folders as cacheDir in src/platform-paths.mjs, plus pycache.
if os.name == "nt":
    base = os.environ.get("LOCALAPPDATA", "")
    cache = Path(base if os.path.isabs(base) else Path.home() / "AppData" / "Local") / "asb" / "cache" / "pycache"
else:
    base = os.environ.get("XDG_CACHE_HOME", "")
    cache = Path(base if os.path.isabs(base) else Path.home() / ".cache") / "asb" / "pycache"
# Only the board code uses the cache folder: a __pycache__ next to it stops the next install (verifyRelease), and a
# prefix for the whole process would compile every imported module again.
previous = sys.pycache_prefix, sys.dont_write_bytecode
try:
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    sys.pycache_prefix = str(cache)
except OSError:
    sys.dont_write_bytecode = True
try:
    code = spec.loader.get_code(spec.name)
finally:
    sys.pycache_prefix, sys.dont_write_bytecode = previous
sys.modules[spec.name] = board
exec(code, vars(board))
raise SystemExit(board.main())
