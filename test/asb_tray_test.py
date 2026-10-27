import builtins
import importlib.util
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = importlib.util.spec_from_file_location("asb_tray", os.path.join(ROOT, "scripts", "asb-tray.py"))
tray = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tray)


class TrayLogicTest(unittest.TestCase):
    def test_panel_status_changes_emit_once_and_update_the_item_property(self):
        connection = Mock()
        item = tray.Tray(connection, (42, "http://127.0.0.1:4731", "a" * 64, "/opt/asb/bin/asb"), {})
        self.assertEqual(item.item_property("Status").unpack(), "Active")
        for status in ("Passive", "Active"):
            connection.reset_mock()
            self.assertIs(item.show_status(status), False)
            connection.emit_signal.assert_called_once()
            args = connection.emit_signal.call_args.args
            self.assertEqual(args[:4], (None, "/StatusNotifierItem", "org.kde.StatusNotifierItem", "NewStatus"))
            self.assertEqual(args[4].unpack(), (status,))
            self.assertEqual(item.item_property("Status").unpack(), status)
            self.assertIs(item.show_status(status), False)
            self.assertEqual(connection.emit_signal.call_count, 1)

    def test_run_watches_the_panel_name_and_updates_status_from_its_callbacks(self):
        connection = Mock()
        connection.call_sync.return_value = tray.GLib.Variant("(u)", (1,))
        with patch.object(tray.GLib, "MainLoop") as loop, patch.object(tray.GLib, "timeout_add_seconds"), \
                patch.object(tray, "unix_signal_add"), patch.object(tray.Gio, "bus_watch_name_on_connection") as watch, \
                patch.object(tray.Tray, "refresh_tooltip"):
            item = tray.Tray(connection, (42, "http://127.0.0.1:4731", "a" * 64, "/opt/asb/bin/asb"), {})
            self.assertEqual(item.run(), 0)
        self.assertEqual(connection.register_object.call_count, 2)
        loop.return_value.run.assert_called_once_with()
        self.assertEqual(watch.call_count, 2)
        self.assertEqual(watch.call_args_list[0].args[1], tray.WATCHER)
        args = watch.call_args_list[1].args
        self.assertEqual(args[:3], (connection, "local.asb.AgentSwitchBoard.Panel", tray.Gio.BusNameWatcherFlags.NONE))
        self.assertEqual(tray.PANEL_NAME, "local.asb.AgentSwitchBoard.Panel")
        args[3](connection, tray.PANEL_NAME, "alpha")
        self.assertEqual(item.item_property("Status").unpack(), "Passive")
        args[4](connection, tray.PANEL_NAME)
        self.assertEqual(item.item_property("Status").unpack(), "Active")

    def test_tooltip_text_shows_phone_access_only_when_it_runs(self):
        self.assertEqual(tray.tooltip_text({"running": True}), "Running. Phone access on.")
        for phone in ({"running": False}, {"running": "yes"}, {}, None, []):
            self.assertEqual(tray.tooltip_text(phone), "Running.")

    def test_menu_layout_has_open_messages_usage_a_separator_and_quit(self):
        self.assertEqual(tray.menu_layout(), (0, {"children-display": "submenu"}, [
            (1, {"label": "Open ASB"}, []), (4, {"label": "Messages"}, []), (5, {"label": "Usage"}, []),
            (2, {"type": "separator"}, []), (3, {"label": "Quit ASB"}, [])]))
        self.assertEqual(tray.menu_items(tray.menu_layout())[3], {"label": "Quit ASB"})

    def test_layout_value_builds_dbusmenu_variants(self):
        value = tray.GLib.Variant("(u(ia{sv}av))", (1, tray.layout_value(tray.menu_layout())))
        self.assertEqual(value.unpack(), (1, (0, {"children-display": "submenu"}, [
            (1, {"label": "Open ASB"}, []), (4, {"label": "Messages"}, []), (5, {"label": "Usage"}, []),
            (2, {"type": "separator"}, []), (3, {"label": "Quit ASB"}, [])])))
        self.assertEqual(value.get_child_value(1).get_child_value(2).get_child_value(0).get_type_string(), "v")

    def test_launch_argv_uses_a_scope_only_under_systemd(self):
        self.assertEqual(tray.launch_argv("/opt/asb/bin/asb", {}), ["/opt/asb/bin/asb"])
        self.assertEqual(tray.launch_argv("/opt/asb/bin/asb", {"INVOCATION_ID": "abc"}),
                         ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--", "/opt/asb/bin/asb"])

    def test_launch_env_removes_the_engine_keys(self):
        env = {"HOME": "/home/a", "ASB_SOURCE_TOKEN": "t", "ASB_ENGINE_PID": "1", "ASB_ENGINE_URL": "u", "ASB_LAUNCHER": "l", "ASB_NODE": "/n"}
        self.assertEqual(tray.launch_env(env), {"HOME": "/home/a", "ASB_NODE": "/n"})
        self.assertIn("ASB_SOURCE_TOKEN", env)

    def test_menu_action_maps_only_clicks_on_open_messages_usage_and_quit(self):
        self.assertEqual(tray.menu_action(1, "clicked"), "open")
        self.assertEqual(tray.menu_action(4, "clicked"), "messages")
        self.assertEqual(tray.menu_action(5, "clicked"), "usage")
        self.assertEqual(tray.menu_action(3, "clicked"), "quit")
        for item_id, event_id in ((2, "clicked"), (1, "hovered"), (4, "opened"), (5, "hovered"), (3, "opened"), (0, "clicked")):
            self.assertIsNone(tray.menu_action(item_id, event_id))

    def test_without_the_board_the_menu_has_only_quit(self):
        self.assertEqual(tray.menu_layout(board=False), (0, {"children-display": "submenu"}, [(3, {"label": "Quit ASB"}, [])]))
        self.assertEqual(tray.menu_layout(True), tray.menu_layout())
        for item_id in (1, 4, 5):
            self.assertIsNone(tray.menu_action(item_id, "clicked", board=False))
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
            self.assertEqual(sorted(item.items), [0, 1, 2, 3, 4, 5] if board else [0, 3])
            item.method_call(None, None, "/StatusNotifierItem", None, "Activate", tray.GLib.Variant("(ii)", (0, 0)), Invocation())
            item.method_call(None, None, "/MenuBar", None, "Event",
                             tray.GLib.Variant("(isvu)", (1, "clicked", tray.GLib.Variant("s", ""), 0)), Invocation())
            self.assertEqual(opened, [True, True] if board else [])
            invocation = Invocation()
            item.method_call(None, None, "/MenuBar", None, "GetLayout", tray.GLib.Variant("(iias)", (0, -1, [])), invocation)
            self.assertEqual(invocation.value.unpack()[1], tray.menu_layout(board))

    def show_window_tray(self, reply):
        """A tray with a fake request, a fake spawn, and work that runs at once."""
        settings = (42, "http://127.0.0.1:4629", "a" * 64, "/opt/asb/bin/asb")
        item = tray.Tray(None, settings, {"HOME": "/home/a", "ASB_SOURCE_TOKEN": "a" * 64, "ASB_OPEN_WINDOW": "usage"})
        item.in_background = lambda work: work()
        requests = []

        def request(method, route, timeout, body=None):
            requests.append((method, route, timeout, body))
            if isinstance(reply, Exception):
                raise reply
            return reply
        item.request = request
        return item, requests

    def test_show_window_opens_a_board_only_when_no_board_shows_the_window(self):
        for reply, spawns in (({"shown": True}, 0), ({"shown": False}, 1), ({"shown": 1}, 1), ([], 1), (OSError("refused"), 1)):
            item, requests = self.show_window_tray(reply)
            with patch.object(tray.GLib, "idle_add", side_effect=lambda callback, *args: callback(*args)) as idle, \
                    patch.object(tray.GLib, "spawn_async") as spawn:
                item.run_action("messages")
            self.assertEqual(requests, [("POST", "/api/engine/show-window", 5, {"window": "messages"})], reply)
            self.assertEqual(spawn.call_count, spawns, reply)
            self.assertEqual(idle.call_count, spawns, reply)
            if spawns:
                envp = spawn.call_args.kwargs["envp"]
                self.assertEqual([entry for entry in envp if entry.startswith("ASB_OPEN_WINDOW=")], ["ASB_OPEN_WINDOW=messages"])
                self.assertFalse(any(entry.startswith("ASB_SOURCE_TOKEN=") for entry in envp))

    def test_open_asb_returns_false_and_never_passes_the_tray_open_window(self):
        item, _requests = self.show_window_tray({"shown": True})
        with patch.object(tray.GLib, "spawn_async") as spawn:
            self.assertIs(item.open_asb(), False)
            item.run_action("open")
        self.assertEqual(spawn.call_count, 2)
        for call in spawn.call_args_list:
            self.assertFalse(any(entry.startswith("ASB_OPEN_WINDOW=") for entry in call.kwargs["envp"]))
        self.assertIn("HOME=/home/a", spawn.call_args.kwargs["envp"])

    def test_request_posts_the_json_body_with_the_token_header(self):
        settings = (42, "http://127.0.0.1:4629", "a" * 64, "/opt/asb/bin/asb")
        item = tray.Tray(None, settings, {})
        sent = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, *_args):
                return b'{"shown": true}'

        def fake_open(request, timeout):
            sent.append((request, timeout))
            return Response()
        with patch.object(tray.LOCAL_HTTP, "open", side_effect=fake_open):
            self.assertEqual(item.request("POST", "/api/engine/show-window", 5, {"window": "usage"}), {"shown": True})
            item.request("POST", "/api/engine/stop", 5)
        request, timeout = sent[0]
        self.assertEqual((request.get_method(), request.full_url, timeout), ("POST", "http://127.0.0.1:4629/api/engine/show-window", 5))
        self.assertEqual(json.loads(request.data), {"window": "usage"})
        self.assertEqual(request.get_header("X-asb-source-token"), "a" * 64)
        self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:4629")
        self.assertEqual(sent[1][0].data, b"{}")

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
