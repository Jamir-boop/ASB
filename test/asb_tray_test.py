import importlib.util
import os
import unittest

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


if __name__ == "__main__":
    unittest.main()
