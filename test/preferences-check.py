#!/usr/bin/env python3
"""Check the shipped Profiles UI with fake replies, without an ASB engine."""
import argparse
import copy
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch


def require(condition, item):
    if not condition:
        raise AssertionError(item)


def walk(widget):
    yield widget
    child = widget.get_first_child()
    while child is not None:
        yield from walk(child)
        child = child.get_next_sibling()


def probe(args, result):
    import gi
    gi.require_version("Adw", "1")
    from gi.repository import Adw
    if args.force_fallback:
        # A proxy hides Dialog even when PyGObject can load it again on demand.
        class LegacyAdw:
            def __getattr__(self, name):
                if name == "Dialog":
                    raise AttributeError(name)
                return getattr(Adw, name)
        with patch.object(gi.repository, "Adw", LegacyAdw()):
            spec = importlib.util.spec_from_file_location("asb_native", args.board)
            asb = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(asb)
    else:
        spec = importlib.util.spec_from_file_location("asb_native", args.board)
        asb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(asb)
    if args.force_fallback:
        require(not hasattr(asb.Adw, "Dialog"), "forced fallback hides Adw.Dialog")
    Gtk, GLib = asb.Gtk, asb.GLib
    result["gtk"] = ".".join(str(getattr(Gtk, "get_" + part + "_version")()) for part in ("major", "minor", "micro"))
    result["libadwaita"] = ".".join(str(getattr(Adw, "get_" + part + "_version")()) for part in ("major", "minor", "micro"))
    require(Gtk.init_check(), "GTK display")

    def drain(duration=.3):
        end = time.monotonic() + duration
        context = GLib.MainContext.default()
        while time.monotonic() < end:
            while context.pending():
                context.iteration(False)
            time.sleep(.005)

    sources, apps = [], []
    for identity, provider, title, enabled, state in (
            ("codex", "codex", "Codex", True, "ready"),
            ("personal", "codex", "Codex Personal", True, "hooks"),
            ("studio", "claude-desktop-code", "Claude Studio", True, "missing"),
            ("opencode", "opencode", "OpenCode", True, "update"),
            ("off", "codex", "Disabled", False, "ready")):
        sources.append({"id": identity, "provider": provider, "label": title, "enabled": enabled,
                        "builtin": identity in ("codex", "opencode"), "dataDir": "/example/profiles/" + identity,
                        "launcher": "/example/apps/studio.desktop", "projectsDir": "/example/transcripts",
                        "color": "#8296b4", "showMarker": True, "sessionCount": 2,
                        "status": "ok" if enabled else "disabled", "remoteClaude": "auto"})
        apps.append({"sourceId": identity, "label": title, "provider": provider, "state": state,
                     "version": "0.7.0" if state == "update" else "0.8.0", "live": 0,
                     "canInstall": state == "missing"})
    replies = {"/api/sources": {"sources": sources, "maxSources": 8, "revision": "a" * 64},
               "/api/bridge": {"api": 1, "machines": [{"machineId": "self", "name": "Example",
                                                       "isSelf": True, "state": "ok", "apps": apps}]}}
    requests = []

    def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
        if route == "/api/palette":
            return
        require(method == "GET", "unexpected write: " + route)
        requests.append((route, callback))

    # The native tests use the same patched requests and stream, with an initial dashboard.
    with patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None), \
            patch.object(asb, "EventStream", lambda *_args: SimpleNamespace(close=lambda: None)), \
            patch.object(asb, "request_async", request):
        application = asb.SwitchboardApplication("http://127.0.0.1:1")
        application.register(None)
        dashboard = {"generatedAtMs": 1790000000000, "providers": [], "threads": [], "persistentUnread": False}
        window = asb.SwitchboardWindow(application, "http://127.0.0.1:1", dashboard,
                                       theme_path=False, layout_path=False)
        try:
            window.present()
            drain()
            # GTK 4.12 on Xvfb keeps the size of a shown window, so Preferences opens narrow from its first map.
            preferences = window.make_preferences()
            preferences.set_default_size(420, 700)
            preferences.present()
            drain(.6)
            result["preferences_width"] = preferences.get_width()
            result["preferences_min_width"] = preferences.measure(Gtk.Orientation.HORIZONTAL, -1)[0]
            result["content_width"] = preferences.get_content().get_width()
            result["content_min_width"] = preferences.get_content().measure(Gtk.Orientation.HORIZONTAL, -1)[0]
            result["surface_width"] = preferences.get_surface().get_width()
            result["solid_csd"] = preferences.has_css_class("solid-csd")
            result["narrow"] = preferences.get_current_breakpoint() is preferences.breakpoint
            # GTK 4.12 on Xvfb gives the window 410 px for a 420 px default size, so the rule is the narrow layout and content that fits.
            require(result["narrow"], "Preferences narrow layout")
            require(result["content_min_width"] <= result["content_width"] <= 420, "Preferences content fits in 420 px")
            require(preferences.pages.get_visible_child_name() == "list", "Preferences section list")
            preferences.show_section("profiles")
            drain()
            require(preferences.pages.get_visible_child_name() == "section"
                    and preferences.stack.get_visible_child_name() == "profiles", "Profiles section page")
            require(preferences.back.get_visible() and preferences.back.get_mapped(), "Preferences Back button")
            for route in ("/api/sources", "/api/bridge"):
                callback = next((callback for path, callback in reversed(requests) if path == route), None)
                require(callback is not None, "request " + route)
                callback(copy.deepcopy(replies[route]), None)
                drain()
            editor = preferences.profiles_editor
            rows = [row for row in walk(editor.table) if isinstance(row, Gtk.ListBoxRow)]
            result["profiles"] = [{"name": row.get_title(), "state": row.asb_state_label.get_label()} for row in rows]
            require(result["profiles"] == [{"name": source["label"], "state": state} for source, state in
                    zip(sources, ("Ready", "Hooks not trusted", "Not installed", "Old version", "Off"))],
                    "Profiles rows and states")
            def check_layout(root):
                for scroll in (node for node in walk(root) if isinstance(node, Gtk.ScrolledWindow)
                               and node.get_mapped()):
                    adjustment = scroll.get_hadjustment()
                    require(adjustment.get_upper() <= adjustment.get_page_size() + 1, "Profiles horizontal scroll")
                    for row in (node for node in walk(scroll) if isinstance(node, Gtk.ListBoxRow) and node.get_mapped()):
                        found, bounds = row.compute_bounds(scroll)
                        require(found and bounds.get_x() >= -1 and
                                bounds.get_x() + bounds.get_width() <= scroll.get_width() + 1, "Profiles row bounds")
                for label in (node for node in walk(root) if isinstance(node, Gtk.Label) and node.get_mapped()):
                    layout = label.get_layout()
                    width, height = layout.get_pixel_size()
                    require(not layout.is_ellipsized() and width <= label.get_width() + 1 and
                            height <= label.get_height() + 1, "cut Profiles label: " + label.get_label())
            check_layout(preferences)
            result["no_horizontal_scroll"] = True
            result["no_cut_labels"] = True
            claude_row = rows[2]
            claude_row.grab_focus()
            editor.table.emit("row-activated", claude_row)
            drain(.5)
            dialog = editor.dialog
            result["dialog_kind"] = type(dialog).__module__.rsplit(".", 1)[-1] + "." + type(dialog).__name__
            require(isinstance(dialog, asb.Adw.Dialog if hasattr(asb.Adw, "Dialog") else asb.Adw.Window),
                    "profile dialog class")
            require(dialog.get_mapped(), "Claude dialog mapped")
            fields = (("Name", editor.name), ("App", editor.provider), ("ASB Bridge", editor.bridge_group),
                      ("Install", editor.install_button), ("Session folder", editor.data_dir),
                      ("Open with", editor.launcher), ("Transcript folder", editor.projects_dir),
                      ("Remote Claude sessions", editor.remote_claude), ("Profile color", editor.source_color),
                      ("Show profile dot", editor.show_marker), ("Enabled", editor.enabled),
                      ("Save", editor.save_button), ("Remove profile", editor.remove_button))
            for name, widget in fields:
                require(widget.get_visible() and widget.get_mapped(), "Claude field: " + name)
                if isinstance(widget, Adw.PreferencesRow):
                    require(widget.get_title() == name, "Claude field title: " + name)
            require(editor.name.get_text() == "Claude Studio" and editor.provider.get_selected() == 1,
                    "Claude field values")
            require(editor.install_button.get_label() == "Install" and editor.install_button.get_sensitive(),
                    "Claude bridge button")
            require(editor.save_button.get_label() == "Save" and editor.remove_button.get_label() == "Remove profile",
                    "Claude Save and Remove buttons")
            check_layout(dialog)
            result["dialog_mapped"] = True
            result["fields"] = [name for name, _widget in fields]
            controllers = dialog.observe_controllers()
            handled = any(controller.emit("key-pressed", asb.Gdk.KEY_Escape, 0, asb.Gdk.ModifierType(0))
                          for controller in controllers if isinstance(controller, Gtk.EventControllerKey))
            drain(.5)
            require(handled and not dialog.get_mapped() and not editor.editing, "Escape closes Claude dialog")
            require(preferences.get_focus() is claude_row, "focus returns to Claude row")
            result["escape_closes"] = result["focus_returns"] = True
        finally:
            try:
                pointer = ctypes.pythonapi.PyCapsule_GetPointer
                pointer.restype = ctypes.c_void_p
                pointer.argtypes = [ctypes.py_object, ctypes.c_char_p]
                preferences = window.preferences_window
                editor = preferences.profiles_editor if preferences else None
                roots = (window, preferences, editor.dialog if editor else None)
                result["row_title_boxes"] = sorted({hex(pointer(node.__gpointer__, None))
                    for root in roots if root is not None for node in walk(root)
                    if isinstance(node, Gtk.Box) and node.has_css_class("title")
                    and node.get_ancestor(Adw.ActionRow) is not None})
            except Exception as error:
                result["errors"].append("row title box collection: " + str(error))
            window.close()
            drain()
            application.quit()


def split_criticals(stderr, row_title_boxes):
    errors, ignored = [], []
    for line in stderr.splitlines():
        if not re.search(r"(?:Gtk|Adwaita)-CRITICAL", line):
            continue
        # GTK 4.12 with Libadwaita 1.4 fails its own consistency check in the title box of each Adw.ActionRow (CI run 40188371932); GTK 4.18 does not.
        match = re.search(r"GtkBox (0x[0-9a-f]+) reports a minimum width of \d+, but minimum width for height of \d+ is \d+\. Expect overlapping widgets\.", line)
        (ignored if match and match[1] in row_title_boxes else errors).append(line)
    return errors, ignored


def check_critical_filter():
    known = "Gtk-CRITICAL **: GtkBox 0x123 reports a minimum width of 13, but minimum width for height of 1048576 is 20. Expect overlapping widgets."
    unknown = known.replace("0x123", "0x456")
    other = "Gtk-CRITICAL **: another problem"
    assert split_criticals("\n".join((known, unknown, other)), ["0x123"]) == ([unknown, other], [known])


def main():
    check_critical_filter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--board", required=True, type=Path)
    parser.add_argument("--force-fallback", action="store_true")
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.probe:
        result = {"errors": []}
        try:
            probe(args, result)
        except Exception as error:
            result["errors"].append(str(error))
        print(json.dumps(result))
        return int(bool(result["errors"]))
    with tempfile.TemporaryDirectory(prefix="asb-preferences-check-") as temporary:
        env = os.environ.copy()
        env.update(HOME=temporary, ASB_TRAY="0", PYTHONDONTWRITEBYTECODE="1", GTK_A11Y="none")
        for key, suffix in (("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                            ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "run")):
            folder = Path(temporary) / suffix
            folder.mkdir(mode=0o700)
            env[key] = str(folder)
        for key in tuple(env):
            if key.startswith("ASB_") and key != "ASB_TRAY":
                del env[key]
        command = [sys.executable, "-I", str(Path(__file__).resolve()), "--probe", "--board", str(args.board.resolve())]
        if args.force_fallback:
            command.append("--force-fallback")
        try:
            completed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=100)
            sys.stderr.write(completed.stderr)
            try:
                result = json.loads(completed.stdout)
            except ValueError:
                result = {"errors": ["probe returned no JSON: " + completed.stdout]}
            if completed.returncode and not result["errors"]:
                result["errors"].append("probe exit code " + str(completed.returncode))
            errors, result["ignored"] = split_criticals(completed.stderr, result.get("row_title_boxes", []))
            result["errors"].extend(errors)
        except subprocess.TimeoutExpired:
            result = {"errors": ["Preferences check timed out after 100 s"]}
        for error in result["errors"]:
            print("FAILED: " + error, file=sys.stderr)
        print(json.dumps(result))
        return int(bool(result["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
