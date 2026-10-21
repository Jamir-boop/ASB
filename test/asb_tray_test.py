import builtins
import importlib.util
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = importlib.util.spec_from_file_location("asb_tray", os.path.join(ROOT, "scripts", "asb-tray.py"))
tray = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tray)


class TrayLogicTest(unittest.TestCase):
    def test_tooltip_text_shows_phone_access_only_when_it_runs(self):
        self.assertEqual(tray.tooltip_text({"running": True}), "Running. Phone access on.")
        for phone in ({"running": False}, {"running": "yes"}, {}, None, []):
            self.assertEqual(tray.tooltip_text(phone), "Running.")

    def test_menu_layout_has_open_a_separator_and_quit(self):
        self.assertEqual(tray.menu_layout(), (0, {"children-display": "submenu"}, [
            (1, {"label": "Open ASB"}, []), (2, {"type": "separator"}, []), (3, {"label": "Quit ASB"}, [])]))
        self.assertEqual(tray.menu_items(tray.menu_layout())[3], {"label": "Quit ASB"})

    def test_layout_value_builds_dbusmenu_variants(self):
        value = tray.GLib.Variant("(u(ia{sv}av))", (1, tray.layout_value(tray.menu_layout())))
        self.assertEqual(value.unpack(), (1, (0, {"children-display": "submenu"}, [
            (1, {"label": "Open ASB"}, []), (2, {"type": "separator"}, []), (3, {"label": "Quit ASB"}, [])])))
        self.assertEqual(value.get_child_value(1).get_child_value(2).get_child_value(0).get_type_string(), "v")

    def test_launch_argv_uses_a_scope_only_under_systemd(self):
        self.assertEqual(tray.launch_argv("/opt/asb/bin/asb", {}), ["/opt/asb/bin/asb"])
        self.assertEqual(tray.launch_argv("/opt/asb/bin/asb", {"INVOCATION_ID": "abc"}),
                         ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--", "/opt/asb/bin/asb"])

    def test_launch_env_removes_the_engine_keys(self):
        env = {"HOME": "/home/a", "ASB_SOURCE_TOKEN": "t", "ASB_ENGINE_PID": "1", "ASB_ENGINE_URL": "u", "ASB_LAUNCHER": "l", "ASB_NODE": "/n"}
        self.assertEqual(tray.launch_env(env), {"HOME": "/home/a", "ASB_NODE": "/n"})
        self.assertIn("ASB_SOURCE_TOKEN", env)

    def test_menu_action_maps_only_clicks_on_open_and_quit(self):
        self.assertEqual(tray.menu_action(1, "clicked"), "open")
        self.assertEqual(tray.menu_action(3, "clicked"), "quit")
        for item_id, event_id in ((2, "clicked"), (1, "hovered"), (3, "opened"), (0, "clicked")):
            self.assertIsNone(tray.menu_action(item_id, event_id))

    def test_without_the_board_the_menu_has_only_quit(self):
        self.assertEqual(tray.menu_layout(board=False), (0, {"children-display": "submenu"}, [(3, {"label": "Quit ASB"}, [])]))
        self.assertEqual(tray.menu_layout(True), tray.menu_layout())
        self.assertIsNone(tray.menu_action(1, "clicked", board=False))
        self.assertEqual(tray.menu_action(3, "clicked", board=False), "quit")
        self.assertEqual(tray.menu_action(1, "clicked", board=True), "open")

    def test_tray_reads_asb_board_once_and_activate_opens_nothing_without_the_board(self):
        settings = (42, "http://127.0.0.1:4629", "a" * 64, "/opt/asb/bin/asb")

        class Invocation:
            def return_value(self, value):
                self.value = value

        for env, board in (({"ASB_BOARD": "0"}, False), ({}, True), ({"ASB_BOARD": "1"}, True)):
            item = tray.Tray(None, settings, env)
            opened = []
            item.open_asb = lambda: opened.append(True)
            self.assertEqual(item.board, board)
            self.assertEqual(sorted(item.items), [0, 1, 2, 3] if board else [0, 3])
            item.method_call(None, None, "/StatusNotifierItem", None, "Activate", tray.GLib.Variant("(ii)", (0, 0)), Invocation())
            item.method_call(None, None, "/MenuBar", None, "Event",
                             tray.GLib.Variant("(isvu)", (1, "clicked", tray.GLib.Variant("s", ""), 0)), Invocation())
            self.assertEqual(opened, [True, True] if board else [])
            invocation = Invocation()
            item.method_call(None, None, "/MenuBar", None, "GetLayout", tray.GLib.Variant("(iias)", (0, -1, [])), invocation)
            self.assertEqual(invocation.value.unpack()[1], tray.menu_layout(board))

    def test_engine_settings_need_every_valid_value(self):
        env = {"ASB_ENGINE_PID": "42", "ASB_ENGINE_URL": "http://127.0.0.1:4629", "ASB_SOURCE_TOKEN": "a" * 64, "ASB_LAUNCHER": "/opt/asb/bin/asb"}
        self.assertEqual(tray.engine_settings(env), (42, "http://127.0.0.1:4629", "a" * 64, "/opt/asb/bin/asb"))
        for key, value in (("ASB_ENGINE_PID", "0"), ("ASB_ENGINE_PID", "x"), ("ASB_ENGINE_URL", "http://example.com:4629"),
                           ("ASB_SOURCE_TOKEN", "A" * 64), ("ASB_LAUNCHER", "bin/asb")):
            self.assertIsNone(tray.engine_settings({**env, key: value}))
        for key in env:
            self.assertIsNone(tray.engine_settings({name: value for name, value in env.items() if name != key}))

    def test_icon_theme_path_is_the_checkout_icons_folder(self):
        self.assertEqual(tray.ICON_THEME_PATH, os.path.join(ROOT, "assets", "icons"))

    def run_signal_helper(self, glib_unix=None, version_error=None):
        """Run the helper with a fake gi, GLib, and GLibUnix, so that the real GLib of this system does not matter."""
        original_import = builtins.__import__
        imported = []
        def fake_import(name, *args, **kwargs):
            if name != "gi.repository":
                return original_import(name, *args, **kwargs)
            imported.append(name)
            if isinstance(glib_unix, Exception):
                raise glib_unix
            return SimpleNamespace(GLibUnix=glib_unix)
        gi = SimpleNamespace(require_version=Mock(side_effect=version_error))
        glib, callback = SimpleNamespace(unix_signal_add=Mock(return_value=1)), Mock()
        with patch.object(tray, "gi", gi), patch.object(tray, "GLib", glib), patch("builtins.__import__", side_effect=fake_import):
            result = tray.unix_signal_add(0, 15, callback)
        return result, gi, glib, callback, imported

    def test_signal_helper_uses_glibunix_signal_add_when_it_exists(self):
        unix = SimpleNamespace(signal_add=Mock(return_value=7), signal_add_full=Mock())
        result, gi, glib, callback, _imported = self.run_signal_helper(unix)
        self.assertEqual(result, 7)
        unix.signal_add.assert_called_once_with(0, 15, callback)
        unix.signal_add_full.assert_not_called()
        glib.unix_signal_add.assert_not_called()
        gi.require_version.assert_called_once_with("GLibUnix", "2.0")

    def test_signal_helper_uses_glib_unix_signal_add_when_glibunix_has_only_signal_add_full(self):
        # GLib 2.84 with PyGObject 3.50 (Debian 13): GLibUnix imports, but it has no signal_add.
        unix = SimpleNamespace(signal_add_full=Mock())
        result, _gi, glib, callback, imported = self.run_signal_helper(unix)
        self.assertEqual(result, 1)
        glib.unix_signal_add.assert_called_once_with(0, 15, callback)
        unix.signal_add_full.assert_not_called()
        self.assertEqual(imported, ["gi.repository"])

    def test_signal_helper_uses_glib_unix_signal_add_when_the_glibunix_import_fails(self):
        result, _gi, glib, callback, imported = self.run_signal_helper(ImportError("cannot import name 'GLibUnix'"))
        self.assertEqual(result, 1)
        glib.unix_signal_add.assert_called_once_with(0, 15, callback)
        self.assertEqual(imported, ["gi.repository"])

    def test_signal_helper_uses_glib_unix_signal_add_when_glibunix_is_not_available(self):
        # GLib before 2.80 (AlmaLinux 9): require_version raises ValueError, and the import is not tried.
        result, gi, glib, callback, imported = self.run_signal_helper(version_error=ValueError("Namespace GLibUnix not available"))
        self.assertEqual(result, 1)
        glib.unix_signal_add.assert_called_once_with(0, 15, callback)
        gi.require_version.assert_called_once_with("GLibUnix", "2.0")
        self.assertEqual(imported, [])


if __name__ == "__main__":
    unittest.main()
