#!/usr/bin/env python3
"""Starts the ASB board from asb-native.py as a module, so that Python keeps its compiled code between starts."""
import importlib.util
import os
import sys
from pathlib import Path

source = Path(__file__).with_name("asb-native.py")
spec = importlib.util.spec_from_file_location("asb_native", source)
board = importlib.util.module_from_spec(spec)
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
