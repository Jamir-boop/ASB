#!/usr/bin/env python3
"""Starts the ASB board from asb-native.py as a module, so that Python keeps its compiled code between starts."""
import importlib.util
import os
import sys
from pathlib import Path

def prefer_cairo(environ, system=os.name):
    """On Windows, GTK tries GL first and falls back to Cairo after an error; Cairo shows the first rows sooner and uses less memory.
    A renderer that the user chose stays, and so does a request for DirectComposition."""
    if system == "nt" and not environ.get("GSK_RENDERER") and "dcomp" not in environ.get("GDK_DEBUG", "").lower():
        environ["GSK_RENDERER"] = "cairo"


def use_app_id(system=os.name):
    """On Windows, python.exe runs the board, so Windows puts the board window under Python and shows the Python icon on the taskbar.
    An own AppUserModelID gives the board its own taskbar button with the window icon. It is APP_ID of asb-native.py."""
    if system == "nt":
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("local.asb.AgentSwitchBoard")


# GTK reads GSK_RENDERER, and Windows reads the AppUserModelID, when the first window opens, so these calls stay before the board code runs.
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
