"""Small native view checks. Session opens use a disposable mock server."""
import copy
import ctypes
import ctypes.util
import importlib.util
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("GTK_A11Y", "test")
SPEC = importlib.util.spec_from_file_location("asb_native", Path(__file__).parents[1] / "scripts" / "asb-native.py")
asb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(asb)
NOW = 1_790_000_000_000
FIXTURE = {
    "generatedAtMs": NOW,
    "providers": [{"id": "codex", "label": "Codex", "message": ""},
                  {"id": "claude-desktop-code", "label": "Claude Desktop Code", "message": ""}],
    "threads": [
        {"id": "first", "provider": "codex", "providerLabel": "Codex", "title": "Verify native session switching",
         "cwd": "/example/ASB", "projectName": "ASB", "state": "working", "canOpen": True, "pinned": False,
         "updatedAtMs": NOW, "reason": "The local log has an open task.", "nativeUnread": True, "nativeAttention": True, "readStatus": "unread"},
        {"id": "second", "provider": "codex", "providerLabel": "Codex", "title": "Check keyboard focus after refresh",
         "cwd": "/example/ASB", "projectName": "ASB", "state": "idle", "canOpen": True, "updatedAtMs": NOW - 60_000,
         "pending": True, "unread": True, "pendingSource": "observed-completion"},
        {"id": "unknown", "provider": "codex", "providerLabel": "Codex", "title": "A session without a desktop link",
         "cwd": "/example/Tools", "projectName": "Tools", "state": "unknown", "canOpen": False, "updatedAtMs": NOW - 300_000},
        {"id": "claude:local_mock", "provider": "claude-desktop-code", "providerLabel": "Claude Desktop Code",
         "title": "Choose the folder for the next check", "cwd": "/example/Notes", "projectName": "Notes",
         "state": "waiting", "canOpen": True, "updatedAtMs": NOW - 120_000, "pending": True, "pendingSource": "user-action", "actionRequired": True},
        {"id": "archive", "provider": "codex", "providerLabel": "Codex", "title": "Completed setup",
         "cwd": "/example/ASB", "projectName": "ASB", "state": "idle", "canOpen": True,
         "archived": True, "updatedAtMs": NOW - 3600_000},
    ],
}


CUSTOM = {"background": "#171c22", "text": "#f0f2f5", "accent": "#f3c66b", "muted": "#b8c0cc", "divider": "#586372"}


def mock_dashboard():
    titles = ["Account settings", "Build pipeline", "Cache invalidation", "Error messages", "Import parser",
              "Keyboard navigation", "Local sync", "Release checks", "Route migration", "Session history",
              "Theme controls", "Workspace search", "Document export", "Image preview"]
    parts = ["", " · build", " · client", " · docs", " · page", " · service", " · tests", " · worker"]
    rows = []
    for index in range(106):
        state = "waiting" if index < 4 else "idle" if index < 12 else "working" if index < 29 else "unknown" if index >= 94 else "idle"
        manual = index in (12, 94)
        pending = index < 12 or (manual and state != "working")
        provider = "claude-desktop-code" if index % 3 == 1 else "codex"
        rows.append({"id": f"sample-{index}", "provider": provider, "providerLabel": "Claude Desktop Code" if provider != "codex" else "Codex",
                     "title": titles[index // 8] + parts[index % 8], "cwd": "/example/" + ["ASB", "Tools", "Notes"][index % 3],
                     "projectName": ["ASB", "Tools", "Notes"][index % 3], "state": state, "canOpen": True,
                     "pending": pending, "unread": pending and state not in ("waiting", "working"), "manualUnread": manual,
                     "nativeUnread": True if index == 15 else None,
                     "nativeAttention": index == 15,
                     "pendingSource": "manual-unread" if manual and pending else "user-question" if index == 0 else "user-action" if state == "waiting" else "observed-completion" if pending else "",
                     "actionRequired": state == "waiting" and index != 0,
                     "questionPending": index == 0, "questionAttention": index == 0,
                     "readStatus": "read" if index == 0 else "unread" if index == 15 else "unknown", "updatedAtMs": NOW - index * 60_000})
    return {"generatedAtMs": NOW, "providers": [], "threads": rows}


class RequestChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == "/error":
                    self.send_error(500)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"invalid" if self.path == "/invalid" else json.dumps(FIXTURE).encode())

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                cls.received.append((self.path, self.headers.get("Origin"), body))
                self.send_response(200)
                self.end_headers()
                result = {"marked": True} if self.path.endswith("/mark-unread") else {"changed": True} \
                    if self.path.endswith("/mark-read") or self.path == "/api/settings/unread" else {"opened": self.path != "/not-opened"}
                self.wfile.write(json.dumps(result).encode())
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(1)

    def test_async_read_open_origin_and_errors(self):
        callbacks = queue.Queue()
        dispatch = lambda callback, *args: callbacks.put((callback, args, threading.get_ident()))
        worker = asb.request_async(self.base, "/api/dashboard", lambda *_args: None, dispatch)
        _callback, (dashboard, error), thread_id = callbacks.get(timeout=2)
        worker.join(1)
        self.assertIsNone(error)
        self.assertEqual(dashboard["threads"][0]["id"], "first")
        self.assertNotEqual(thread_id, threading.get_ident())
        self.assertTrue(asb.request_json(self.base, "/api/threads/claude%3Alocal_mock/open", "POST")["opened"])
        self.assertEqual(self.received[-1], ("/api/threads/claude%3Alocal_mock/open", self.base, b"{}"))
        self.assertTrue(asb.request_json(self.base, "/api/threads/first/mark-unread", "POST")["marked"])
        self.assertTrue(asb.request_json(self.base, "/api/threads/first/mark-read", "POST")["changed"])
        self.assertTrue(asb.request_json(self.base, "/api/settings/unread", "POST", {"persistentUnread": True})["changed"])
        self.assertEqual(self.received[-1], ("/api/settings/unread", self.base, b'{"persistentUnread": true}'))
        for route, method in [("/error", "GET"), ("/invalid", "GET"), ("/not-opened", "POST")]:
            worker = asb.request_async(self.base, route, lambda *_args: None, dispatch, method)
            _callback, (result, error), _thread_id = callbacks.get(timeout=2)
            worker.join(1)
            self.assertIsNone(result)
            self.assertIn("Cannot", error)


@unittest.skipUnless(asb.Gtk.init_check(), "A GTK display is not available.")
class WidgetCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.poll_timer = patch.object(asb.GLib, "timeout_add_seconds", return_value=0)
        cls.poll_calls = cls.poll_timer.start()
        cls.addClassCleanup(cls.poll_timer.stop)
        cls.application = asb.SwitchboardApplication("http://127.0.0.1:1")
        cls.application.register(None)
        # The ink checks read icon pixels, and the highest alpha of an icon is different in each icon theme.
        asb.Gtk.Settings.get_default().set_property("gtk-icon-theme-name", "Adwaita")
        if os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS"):
            Path(os.environ["ASB_NATIVE_TEST_SNAPSHOTS"]).mkdir(parents=True, exist_ok=True)
        cls.capsule_pointer = ctypes.pythonapi.PyCapsule_GetPointer
        cls.capsule_pointer.argtypes = (ctypes.py_object, ctypes.c_char_p)
        cls.capsule_pointer.restype = ctypes.c_void_p
        cls.gtk_check = ctypes.CDLL(ctypes.util.find_library("gtk-4")).gtk_test_accessible_check_property
        cls.gtk_check.argtypes = (ctypes.c_void_p, ctypes.c_int)
        cls.gtk_check.restype = ctypes.c_void_p
        cls.g_free = ctypes.CDLL(ctypes.util.find_library("glib-2.0")).g_free
        cls.g_free.argtypes = (ctypes.c_void_p,)

    def assert_accessible_label(self, widget, expected):
        # GTK's exact property check is variadic and is not exposed by PyGObject.
        error = self.gtk_check(self.capsule_pointer(widget.__gpointer__, None), int(asb.Gtk.AccessibleProperty.LABEL),
                               ctypes.c_char_p(expected.encode()))
        if error:
            message = ctypes.string_at(error).decode()
            self.g_free(error)
            self.fail(message)

    def drain(self, duration=0.18):
        end = time.monotonic() + duration
        context = asb.GLib.MainContext.default()
        while time.monotonic() < end:
            while context.pending():
                context.iteration(False)
            time.sleep(0.005)

    def capture(self, window, path):
        for attempt in range(3):
            try:
                asb.save_snapshot(window, str(path))
                return
            except RuntimeError:
                if attempt == 2:
                    raise
                window.queue_draw()
                if hasattr(window, "check_geometry"):
                    window.check_geometry()
                self.drain(.15)

    def widget_rows(self, window):
        column = window.list_body.get_first_child()
        while column:
            row = column.get_first_child()
            while row:
                yield row
                row = row.get_next_sibling()
            column = column.get_next_sibling()

    def assert_focus_visible(self, window, identity):
        found, bounds = window.focus_widgets[identity].compute_bounds(window.list_body)
        self.assertTrue(found)
        adjustment = window.scroll.get_hadjustment()
        self.assertGreaterEqual(bounds.origin.x, adjustment.get_value() - 1)
        self.assertLessEqual(bounds.origin.x + bounds.size.width, adjustment.get_value() + adjustment.get_page_size() + 1)

    def test_native_columns_rows_focus_scroll_and_snapshots(self):
        application = self.application
        self.assertEqual(application.get_style_manager().get_color_scheme(), asb.Adw.ColorScheme.FORCE_DARK)
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        with tempfile.TemporaryDirectory(prefix="asb-native-test-") as temporary:
            directory = Path(output or temporary)
            directory.mkdir(parents=True, exist_ok=True)
            for width, columns in ((360, 1), (680, 2), (1040, 4)):
                dashboard = mock_dashboard()
                window = asb.SwitchboardWindow(application, "http://127.0.0.1:1", dashboard,
                                              theme_path=Path(temporary) / f"theme-{width}.json", layout_path=False)
                self.addCleanup(window.close)
                window.set_default_size(width, 800)
                window.present()
                self.drain(.3)
                self.assertIsInstance(window, asb.Adw.ApplicationWindow)
                self.assertEqual((window.get_width(), window.get_height()), (width, 800))
                self.assertEqual(window.columns, columns)
                self.assertEqual(len(window.focus_widgets), 106,
                                 (window.search.get_text(), window.apps, window.states, window.pending_only.get_active()))
                self.assertEqual(self.poll_calls.call_args.args[0], 2)
                displayed = []
                for row in self.widget_rows(window):
                    displayed.append(row.asb_thread["id"])
                    self.assertGreater(row.get_height(), 0)
                    self.assertLessEqual(row.get_height(), 22)
                    content = row.get_child()
                    self.assertEqual(content.get_orientation(), asb.Gtk.Orientation.HORIZONTAL)
                    self.assertEqual(content.get_first_child().get_child().get_pixel_size(), 14)
                    title = content.get_first_child().get_next_sibling()
                    self.assertFalse(title.get_wrap())
                    self.assertTrue(title.get_single_line_mode())
                    self.assertEqual(title.get_ellipsize(), asb.Pango.EllipsizeMode.END)
                    self.assertIn(row.asb_thread["cwd"], row.asb_tooltip)
                self.assertEqual(displayed, window.row_order)
                self.assertEqual(len(set(displayed)), 106)
                self.assertEqual(window.focus_widgets["sample-0"].get_child().get_last_child().get_text(), "Waiting")
                self.assertEqual(window.focus_widgets["sample-4"].get_child().get_last_child().get_text(), "Idle")
                question = window.focus_widgets["sample-0"]
                self.assertTrue(question.get_child().get_last_child().get_prev_sibling().has_css_class("asb-dot"))
                self.assert_accessible_label(question, "Open Account settings in Codex. Waiting. Question needs your answer.")
                self.assertEqual(window.focus_widgets["sample-12"].get_child().get_last_child().get_text(), "Working")
                self.assertEqual(window.focus_widgets["sample-94"].get_child().get_last_child().get_text(), "Unknown")
                native = window.focus_widgets["sample-15"]
                dot = native.get_child().get_last_child().get_prev_sibling()
                self.assertTrue(dot.has_css_class("asb-dot"))
                self.assertFalse(dot.get_visible())
                self.assertFalse(native.asb_thread["unread"])
                self.assertFalse(native.asb_thread["pending"])
                self.assertTrue(native.asb_thread["nativeUnread"])
                self.assertTrue(native.asb_thread["nativeAttention"])
                self.assert_accessible_label(native, "Open Build pipeline · worker in Codex. Working.")
                self.assertIn("Marked unread in ASB.", window.focus_widgets["sample-94"].asb_tooltip)
                self.assertFalse(window.has_css_class("asb-custom"))
                self.capture(window, directory / f"native-{width}.png")
                large = copy.deepcopy(dashboard)
                large["threads"].extend({**dashboard["threads"][30], "id": f"extra-{index}"} for index in range(80))
                dashboard = large
                window.apply_dashboard(dashboard, None)
                self.drain()
                focused = window.row_order[5]
                original = window.focus_widgets[focused]
                original.grab_focus()
                same = copy.deepcopy(dashboard)
                same["generatedAtMs"] += 30_000
                window.apply_dashboard(same, None)
                self.assertIs(window.focus_widgets[focused], original)
                window.row_key(None, asb.Gdk.KEY_Down, 0, 0, focused)
                self.assertEqual(window.focus_key(), window.row_order[6])
                window.row_key(None, asb.Gdk.KEY_Home, 0, 0, window.row_order[6])
                self.assertEqual(window.focus_key(), window.row_order[0])
                window.row_key(None, asb.Gdk.KEY_Right, 0, 0, window.row_order[0])
                self.assertEqual(window.focus_key(), window.row_order[window.capacity])
                adjustment = window.scroll.get_hadjustment()
                self.assertGreater(adjustment.get_upper(), adjustment.get_page_size())
                adjustment.set_value(250)
                position = adjustment.get_value()
                changed = copy.deepcopy(dashboard)
                changed["threads"][window.capacity]["title"] = "<b>Literal session title</b>"
                changed["threads"][0]["title"] = "Long session title\nwith a second line and an export artifact"
                focus = window.focus_key()
                window.apply_dashboard(changed, None)
                self.drain()
                self.assertEqual(window.focus_key(), focus)
                self.assertAlmostEqual(adjustment.get_value(), min(position, adjustment.get_upper() - adjustment.get_page_size()), delta=1)
                self.assertLessEqual(window.focus_widgets["sample-0"].get_height(), 22)
                window.set_default_size(width, 700)
                self.drain(.3)
                self.assertEqual(window.focus_key(), focus)
                self.assert_focus_visible(window, focus)
                alternate = 680 if width == 360 else 360
                window.set_default_size(alternate, 800)
                self.drain(.3)
                self.assertEqual(window.columns, 2 if alternate == 680 else 1)
                self.assertEqual(window.focus_key(), focus)
                self.assert_focus_visible(window, focus)
                window.set_default_size(width, 800)
                window.pending_only.set_active(True)
                self.drain()
                self.assertEqual(set(window.focus_widgets), {row["id"] for row in dashboard["threads"] if row.get("pending")})
                if width == 680:
                    self.capture(window, directory / "native-pending-only.png")
                window.pending_only.set_active(False)
                window.select_states({"waiting"})
                self.assertEqual(len(window.focus_widgets), 4)
                self.assertEqual(window.count.get_text(), "4 Pending · 4 sessions")
                window.select_states(set(asb.STATES))
                window.app_filter.set_selected(2)
                self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
                window.app_filter.set_selected(0)
                window.search.set_text("/example/Notes")
                window.render()
                self.assertTrue(all(row["cwd"] == "/example/Notes" for row in window.visible_rows()))
                visible = window.visible_rows()
                self.assertEqual(window.count.get_text(), f"{sum(bool(row.get('pending')) for row in visible)} Pending · {len(visible)} sessions")
                window.search.set_text("")
                window.render()
                window.theme_mode.set_selected(1)
                self.assertTrue(asb.validate_theme(window.native_colors()))
                for key, picker in window.color_buttons.items():
                    self.assert_accessible_label(picker, f"{key.capitalize()} color")
                    self.assert_accessible_label(picker.get_first_child(), f"{key.capitalize()} color")
                    picker.set_rgba(window.rgba(CUSTOM[key]))
                window.apply_theme()
                self.drain()
                self.assertEqual(asb.read_theme(window.theme_path), CUSTOM)
                self.assertTrue(window.has_css_class("asb-custom"))
                if width == 1040:
                    window.apply_dashboard(mock_dashboard(), None)
                    self.drain()
                    self.capture(window, directory / "native-custom.png")
                window.color_buttons["text"].set_rgba(window.rgba("#222222"))
                window.apply_theme()
                self.assertIn("4.5:1", window.theme_error.get_text())
                self.assertEqual(asb.read_theme(window.theme_path), CUSTOM)
                window.reset_theme()
                self.assertFalse(window.has_css_class("asb-custom"))
                self.assertIsNone(asb.read_theme(window.theme_path))
                window.close()
                self.drain(.03)

    def test_native_context_menu_keyboard_and_disabled_open(self):
        application = self.application
        with tempfile.TemporaryDirectory(prefix="asb-native-menu-test-") as temporary:
            window = asb.SwitchboardWindow(application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                          theme_path=Path(temporary) / "theme.json", layout_path=False)
            self.addCleanup(window.close)
            window.present()
            self.drain()
            self.assertFalse(window.focus_widgets["unknown"].get_activatable())
            self.assertTrue(window.focus_widgets["unknown"].get_sensitive())
            self.assertNotIn("Unread in the original app.", window.focus_widgets["first"].asb_tooltip)
            self.assertNotIn("marks this session as read", window.focus_widgets["first"].asb_tooltip)
            context_clicks = [controller for controller in window.focus_widgets["unknown"].observe_controllers()
                              if isinstance(controller, asb.Gtk.GestureClick) and controller.get_button() == 3]
            self.assertEqual(len(context_clicks), 1)
            for key, modifier in ((asb.Gdk.KEY_Menu, 0), (asb.Gdk.KEY_F10, asb.Gdk.ModifierType.SHIFT_MASK)):
                self.assertTrue(window.row_key(None, key, 0, modifier, "unknown"))
                menu = window.context_menu
                self.assertIsInstance(menu, asb.Gtk.PopoverMenu)
                self.assertEqual(menu.get_accessible_role(), asb.Gtk.AccessibleRole.MENU)
                model = menu.get_menu_model()
                self.assertEqual(model.get_item_attribute_value(0, "label", None).get_string(), "Unread")
                self.assertEqual(model.get_item_attribute_value(0, "target", None).get_string(), "unknown")
                self.assertEqual(model.get_item_attribute_value(1, "label", None).get_string(), "Pin")
                self.assertEqual(model.get_item_attribute_value(1, "action", None).get_string(), "win.pin")
                menu.popdown()
                self.drain()
            with patch.object(window, "session_action") as action:
                window.activate_action("win.mark-unread", asb.GLib.Variant("s", "unknown"))
                action.assert_called_once_with("unknown", "mark-unread")
            window.close()
            self.drain(.03)

    def test_compact_short_toolbar_typing_inline_open_and_queued_unread(self):
        with tempfile.TemporaryDirectory(prefix="asb-compact-test-") as temporary:
            window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", mock_dashboard(),
                                          theme_path=Path(temporary) / "theme.json", layout_path=Path(temporary) / "layout.json")
            self.addCleanup(window.close)
            window.set_default_size(1080, 280)
            window.present()
            self.drain(.3)
            window.check_geometry()
            self.drain()
            self.assertEqual((window.get_width(), window.get_height()), (1080, 280))
            self.assertIsInstance(window.window_handle, asb.Gtk.WindowHandle)
            self.assertFalse(window.window_controls.get_empty())
            self.assertEqual(window.window_controls.get_decoration_layout(), ":close")
            self.assertTrue(window.wide_controls)
            self.assertFalse(window.feedback.get_visible())
            self.assertLessEqual(window.window_handle.get_height(), window.search.get_height() + 4)
            self.assertGreaterEqual(window.scroll.get_height(), 240)
            self.assertEqual(window.columns, 4)
            self.assertGreaterEqual(window.capacity, 10)
            self.assertFalse(hasattr(window, "updated"))
            self.assertEqual(window.get_icon_name(), asb.APP_ID)
            self.assertEqual(self.application.get_application_id(), asb.APP_ID)
            self.assertEqual(window.app_mark.get_icon_name(), asb.APP_ID)
            self.assertEqual(window.app_mark.get_pixel_size(), 16)
            self.assertTrue(asb.Gtk.IconTheme.get_for_display(window.get_display()).has_icon(asb.APP_ID))
            def descendants(widget):
                yield widget
                child = widget.get_first_child()
                while child:
                    yield from descendants(child)
                    child = child.get_next_sibling()
            self.assertFalse(any(isinstance(widget, asb.Adw.HeaderBar) for widget in descendants(window)))
            self.assertFalse(any(isinstance(widget, asb.Gtk.Label) and widget.get_text() in
                                 ("ASB", "Hover for folder and full title · Enter opens") for widget in descendants(window)))
            output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
            if output:
                self.capture(window, Path(output) / "native-1080-short.png")

            window.focus_widgets["sample-15"].grab_focus()
            adjustment = window.scroll.get_hadjustment()
            adjustment.set_value(100)
            focused = window.focus_key()
            order = list(window.row_order)
            divider = window.column_pixel_width + 6
            self.assertTrue(window.divider_at(divider))
            window.column_drag_begin(None, divider, 10)
            window.column_drag_update(None, -100, 0)
            self.drain()
            self.assertEqual(window.column_width, 160)
            self.assertEqual(window.columns, 6)
            self.assertFalse(window.layout_path.exists())
            self.assertEqual(window.row_order, order)
            self.assertEqual(len(window.focus_widgets), 106)
            self.assertEqual(window.focus_key(), focused)
            self.assertAlmostEqual(adjustment.get_value(), 100, delta=1)
            widths = []
            column = window.list_body.get_first_child()
            while column:
                widths.append(column.get_allocated_width())
                column = column.get_next_sibling()
            self.assertLessEqual(max(widths) - min(widths), 1)
            window.column_drag_end()
            self.assertEqual(asb.read_layout(window.layout_path)["columnWidth"], 160)
            self.assert_accessible_label(window.width_control, "Column width in pixels")
            if output:
                window.search.grab_focus()
                self.drain(.3)
                adjustment.set_value(0)
                self.drain(.3)
                self.assertEqual(adjustment.get_value(), 0)
                self.capture(window, Path(output) / "native-1080-six-columns.png")
            window.reset_width()
            self.drain()
            self.assertEqual(window.columns, 4)
            self.assertEqual(window.column_width, 240)
            self.assertFalse(window.layout_path.exists())

            row = window.focus_widgets["sample-15"]
            window.refresh_button.grab_focus()
            self.assertTrue(window.window_key(None, asb.Gdk.KEY_k, 0, 0))
            self.assertEqual(window.search.get_text(), "k")
            window.clear_search()
            row = window.focus_widgets["sample-15"]
            row.grab_focus()
            for modifier in (asb.Gdk.ModifierType.CONTROL_MASK, asb.Gdk.ModifierType.ALT_MASK, asb.Gdk.ModifierType.SUPER_MASK):
                self.assertFalse(window.window_key(None, asb.Gdk.KEY_c, 0, modifier))
                self.assertEqual(window.search.get_text(), "")
                self.assertFalse(window.row_key(None, asb.Gdk.KEY_Home, 0, modifier, "sample-15"))
            self.assertTrue(window.window_key(None, asb.Gdk.KEY_c, 0, 0))
            self.assertEqual(window.search.get_text(), "c")
            self.assertFalse(window.window_key(None, asb.Gdk.KEY_l, 0, 0))
            window.app_filter.set_selected(1)
            window.search.set_text("cl:")
            window.render()
            self.assertTrue(window.visible_rows())
            self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
            self.assertTrue(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
            self.assertEqual(window.search.get_text(), "")
            self.assertEqual(window.app_filter.get_selected(), 1)
            self.assertTrue(all(row["provider"] == "codex" for row in window.visible_rows()))
            window.pending_only.set_active(True)
            window.select_states({"idle"})
            window.archive.set_active(True)
            window.search.set_text("cx: build")
            window.window_key(None, asb.Gdk.KEY_Escape, 0, 0)
            self.assertTrue(window.pending_only.get_active())
            self.assertEqual(window.states, {"idle"})
            self.assertTrue(window.archive.get_active())
            window.pending_only.grab_focus()
            self.assertFalse(window.window_key(None, asb.Gdk.KEY_space, 0, 0))
            self.assertFalse(window.window_key(None, asb.Gdk.KEY_Return, 0, 0))
            window.search.set_text("cx:")
            window.menu_button.get_popover().popup()
            self.assertFalse(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
            self.assertEqual(window.search.get_text(), "cx:")
            window.menu_button.get_popover().popdown()
            window.clear_search()
            window.app_filter.set_selected(0)
            window.select_states(set(asb.STATES))
            window.archive.set_active(False)
            window.pending_only.set_active(False)
            self.drain()

            calls = []
            def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None):
                calls.append((route, callback, method))
            with patch.object(asb, "request_async", request):
                geometry = (window.window_handle.get_height(), window.scroll.get_height())
                window.open_row(None, window.focus_widgets["sample-15"])
                self.assertEqual(window.focus_widgets["sample-15"].asb_title_label.get_text(), "Opening…")
                self.assertFalse(window.notice.get_visible())
                if output:
                    self.drain()
                    self.capture(window, Path(output) / "native-1080-opening.png")
                opened = calls[-1][1]
                changed = mock_dashboard()
                changed["threads"][15]["title"] = "<b>Current literal title</b>"
                window.apply_dashboard(changed, None)
                self.drain()
                self.assertEqual(window.focus_widgets["sample-15"].asb_title_label.get_text(), "Opening…")
                opened({"opened": True}, None)
                self.drain()
                self.assertEqual(window.focus_widgets["sample-15"].asb_title_label.get_text(), "<b>Current literal title</b>")
                self.assertFalse(window.notice.get_visible())
                self.assertEqual((window.window_handle.get_height(), window.scroll.get_height()), geometry)
                self.assertEqual(window.focus_widgets["sample-15"].get_child().get_last_child().get_text(), "Working")
                acknowledged = copy.deepcopy(changed)
                acknowledged["threads"][15].update(unread=False, nativeAttention=False, pending=False)
                window.apply_dashboard(acknowledged, None)
                self.drain()
                read_row = window.focus_widgets["sample-15"]
                self.assertEqual(read_row.get_child().get_last_child().get_text(), "Working")
                self.assertFalse(read_row.asb_dot.get_visible())
                calls[-1][1](changed, None)
                window.open_row(None, window.focus_widgets["sample-15"])
                calls[-1][1](None, "Cannot open this session. Check its app link handler.")
                self.drain()
                self.assertEqual(window.focus_widgets["sample-15"].asb_title_label.get_text(), "<b>Current literal title</b>")
                self.assertIn("Cannot open", window.focus_widgets["sample-15"].asb_tooltip)
                self.assertFalse(window.notice.get_visible())
                self.assertEqual((window.window_handle.get_height(), window.scroll.get_height()), geometry)

                window.loading = True
                window.row_action(None, asb.GLib.Variant("s", "sample-15"), "mark-unread")
                calls[-1][1]({"marked": True}, None)
                self.assertTrue(window.refresh_queued)
                count = len(calls)
                window.apply_dashboard(changed, None)
                self.drain()
                self.assertEqual(len(calls), count + 1)
                self.assertEqual(calls[-1][0], "/api/dashboard?force=1")
                marked = copy.deepcopy(changed)
                marked["threads"][15].update(manualUnread=True, unread=False, pending=False, pendingSource="")
                calls[-1][1](marked, None)
                self.drain()
                self.assertTrue(window.focus_widgets["sample-15"].asb_thread["manualUnread"])
                self.assertFalse(window.focus_widgets["sample-15"].asb_thread["unread"])
                self.assertFalse(window.focus_widgets["sample-15"].asb_thread["pending"])
                self.assertFalse(window.focus_widgets["sample-15"].asb_dot.get_visible())
                self.assertFalse(window.refresh_queued)
                ended = copy.deepcopy(marked)
                ended["threads"][15].update(state="idle", unread=True, pending=True, pendingSource="manual-unread")
                window.apply_dashboard(ended, None)
                self.drain()
                self.assertTrue(window.focus_widgets["sample-15"].asb_thread["manualUnread"])
                self.assertTrue(window.focus_widgets["sample-15"].asb_dot.get_visible())

            close = window.window_controls.get_first_child()
            self.assertEqual(close.get_action_name(), "window.close")
            close.emit("clicked")
            self.drain(.03)
            self.assertTrue(window.closed)

    def test_actual_menu_activation_multistate_and_pin_drag(self):
        dashboard = mock_dashboard()
        received = []
        order = []
        def apply_pins():
            dashboard["pinnedOrder"] = list(order)
            for row in dashboard["threads"]:
                row["pinned"] = row["id"] in order
                row["pinIndex"] = order.index(row["id"]) if row["id"] in order else -1
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(dashboard).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                received.append((self.path, body, self.headers.get("Origin")))
                if self.path == "/api/settings/unread":
                    dashboard["persistentUnread"] = body["persistentUnread"]
                    if body["persistentUnread"]:
                        row = dashboard["threads"][15]
                        row.update(retainedUnread=True, retainedUnreadSource="native-unread", unread=False, pending=False,
                                   pendingSource="", nativeUnread=False, nativeAttention=False, readStatus="read")
                    result = {"changed": True, "persistentUnread": body["persistentUnread"], "dashboard": dashboard}
                    self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(result).encode())
                    return
                identity, action = self.path.split("/")[-2:]
                row = next(row for row in dashboard["threads"] if row["id"] == identity)
                if action == "mark-unread":
                    working = row["state"] == "working"
                    row.update(manualUnread=True, unread=not working,
                               pending=not working or bool(row.get("questionAttention") or row.get("actionRequired")),
                               pendingSource="user-action" if row.get("actionRequired") else "user-question" if row.get("questionAttention")
                               else "" if working else "manual-unread")
                    result = {"marked": True, "thread": row}
                elif action == "mark-read":
                    row.update(manualUnread=False, retainedUnread=False, retainedUnreadSource="", nativeAttention=False,
                               completionAttention=False, failedAttention=False, questionAttention=False, unread=False,
                               pending=bool(row.get("actionRequired")), pendingSource="user-action" if row.get("actionRequired") else "")
                    result = {"changed": True, "threadId": identity, "thread": row}
                else:
                    if action == "pin":
                        order.append(identity)
                    elif action == "unpin":
                        order.remove(identity)
                    elif body.get("direction"):
                        index = order.index(identity)
                        other = index + (-1 if body["direction"] == "up" else 1)
                        if 0 <= other < len(order): order[index], order[other] = order[other], order[index]
                    else:
                        order.remove(identity)
                        order.insert(order.index(body["targetId"]) + (body["placement"] == "after"), identity)
                    apply_pins()
                    result = {"changed": True, "pinnedOrder": list(order)}
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(result).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_port}"
        window = asb.SwitchboardWindow(self.application, base, copy.deepcopy(dashboard), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.3)
        def descendants(widget):
            yield widget
            child = widget.get_first_child()
            while child:
                yield from descendants(child); child = child.get_next_sibling()
        def activate(identity, text):
            window.show_context(window.focus_widgets[identity])
            popup = window.context_menu
            item = next(widget for widget in descendants(popup) if widget.find_property("text") and widget.get_property("text") == text)
            self.assertTrue(item.activate())
            self.drain(.35)
        activate("sample-30", "Unread")
        self.assertEqual(received[0], ("/api/threads/sample-30/mark-unread", {}, base))
        self.assertTrue(window.focus_widgets["sample-30"].asb_thread["manualUnread"])
        dot = window.focus_widgets["sample-30"].get_child().get_last_child().get_prev_sibling()
        self.assertTrue(dot.has_css_class("asb-dot"))
        self.assertEqual(dot.get_width(), 7)
        activate("sample-30", "Read")
        self.assertEqual(received[1], ("/api/threads/sample-30/mark-read", {}, base))
        self.assertFalse(window.focus_widgets["sample-30"].asb_thread["manualUnread"])
        self.assertEqual(window.focus_widgets["sample-30"].asb_thread["state"], "idle")
        self.assertFalse(window.persistent_unread.get_active())
        callbacks = []
        with patch.object(asb, "request_async", side_effect=lambda *args: callbacks.append(args)):
            current_dashboard, window.dashboard = window.dashboard, None
            window.persistent_unread.set_active(True)
            self.assertFalse(window.persistent_unread.get_sensitive())
            window.sync_unread_setting(False)
            self.assertTrue(window.persistent_unread.get_active())
            self.assertEqual(len(callbacks), 1)
            self.assertEqual(callbacks[0][1], "/api/settings/unread")
            callbacks[0][2](None, "Cannot change the unread setting.")
            self.assertFalse(window.persistent_unread.get_active())
            self.assertTrue(window.persistent_unread.get_sensitive())
            self.assertEqual(window.unread_setting_error.get_text(), "Cannot change the unread setting.")
            window.dashboard = current_dashboard
        window.persistent_unread.set_active(True); self.drain(.4)
        self.assertEqual(received[-1], ("/api/settings/unread", {"persistentUnread": True}, base))
        self.assertTrue(window.persistent_unread.get_sensitive())
        self.assertEqual(window.unread_setting_error.get_text(), "")
        requests = len(received)
        window.apply_dashboard(copy.deepcopy(dashboard), None); self.drain()
        self.assertEqual(len(received), requests)
        for view in (0, 1):
            window.view_filter.set_selected(view); self.drain()
            row = window.focus_widgets["sample-15"]
            self.assertEqual(row.asb_thread["state"], "working")
            self.assertFalse(row.asb_thread["nativeUnread"])
            self.assertTrue(row.asb_thread["retainedUnread"])
            self.assertFalse(row.asb_thread["unread"])
            self.assertFalse(row.asb_thread["pending"])
            self.assertEqual(asb.attention_indicator(row.asb_thread), "")
            self.assertNotIn(("Read", "mark-read"), asb.row_menu_actions(row.asb_thread))
            self.assertNotIn("Unread kept in ASB.", row.asb_tooltip)
            self.assert_accessible_label(row, row.asb_accessible_label)
            self.assertNotIn("Unread retained in ASB", row.asb_accessible_label)
        dashboard["threads"][15].update(state="idle", unread=True, pending=True, pendingSource="native-unread")
        window.apply_dashboard(copy.deepcopy(dashboard), None); self.drain()
        for view in (0, 1):
            window.view_filter.set_selected(view); self.drain()
            row = window.focus_widgets["sample-15"]
            self.assertTrue(row.asb_thread["retainedUnread"])
            self.assertTrue(row.asb_thread["unread"])
            self.assertTrue(row.asb_thread["pending"])
            self.assertIn("Unread kept in ASB.", row.asb_tooltip)
            self.assertIn("Unread retained in ASB", row.asb_accessible_label)
            dot = next(widget for widget in descendants(row) if widget.has_css_class("asb-dot"))
            self.assertEqual((dot.get_width(), dot.get_height()), (7, 7))
        window.view_filter.set_selected(0); self.drain()
        activate("sample-15", "Read")
        self.assertFalse(window.focus_widgets["sample-15"].asb_thread["retainedUnread"])
        self.assertEqual(window.focus_widgets["sample-15"].asb_thread["state"], "idle")
        window.persistent_unread.set_active(False); self.drain(.4)
        self.assertEqual(received[-1], ("/api/settings/unread", {"persistentUnread": False}, base))
        self.assertEqual(sum(route == "/api/settings/unread" for route, *_args in received), 2)
        window.select_states({"working", "idle"})
        self.assertEqual(window.state_filter.get_label(), "2 states")
        self.assertEqual(window.states, {"working", "idle"})
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            window.menu_button.get_popover().popup()
            window.state_filter.get_popover().popup()
            self.drain(.2)
            self.capture(window, Path(output) / "native-multi-state.png")
            window.state_filter.get_popover().popdown()
            window.menu_button.get_popover().popdown()
        window.select_states(set())
        self.assertEqual(window.row_order, [])
        window.select_states(set(asb.STATES))
        for identity in ("sample-30", "sample-31", "sample-32"):
            activate(identity, "Pin")
        self.assertEqual(window.row_order[:3], ["sample-30", "sample-31", "sample-32"])
        window.search.set_text("Local sync")
        window.render()
        window.search.set_text("")
        window.render()
        self.assertIsNotNone(window.pin_drag_prepare(None, 0, 0, "sample-30"))
        self.assertFalse(window.pin_drop(None, "unrelated", 0, 0, "sample-32"))
        self.assertFalse(window.pin_drop(None, "asb-pin:unknown", 0, 0, "sample-32"))
        self.assertFalse(window.pin_drop(None, "asb-pin:sample-30", 0, 0, "sample-40"))
        self.assertTrue(window.pin_drop(None, "asb-pin:sample-30", 0, 100, "sample-32"))
        self.drain(.35)
        self.assertEqual(order, ["sample-31", "sample-32", "sample-30"])
        self.assertEqual(window.row_order[:3], order)
        activate("sample-30", "Move pin earlier")
        self.assertEqual(order, ["sample-31", "sample-30", "sample-32"])
        activate("sample-30", "Unpin")
        self.assertEqual(order, ["sample-31", "sample-32"])
        self.assertEqual(len(window.focus_widgets), 106)
        if output:
            window.search.grab_focus()
            self.drain(.2)
            window.scroll.get_hadjustment().set_value(0)
            self.drain(.2)
            self.capture(window, Path(output) / "native-asb-pins.png")
        window.close(); self.drain(.03)

    def test_view_modes_pills_focus_cards_and_narrow_metadata(self):
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        with tempfile.TemporaryDirectory(prefix="asb-view-widgets-") as temporary:
            for width, height in ((320, 800), (360, 800), (680, 800), (1040, 800), (1080, 248)):
                dashboard = mock_dashboard()
                dashboard["threads"][10].update(pinned=True, pinIndex=0)
                dashboard["threads"][11].update(pinned=True, pinIndex=1)
                dashboard["threads"][10]["title"] = "<b>A long literal title with two readable lines and an export artifact</b>"
                layout_path = Path(temporary) / f"layout-{width}.json"
                window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                              theme_path=False, layout_path=layout_path)
                self.addCleanup(window.close)
                window.set_default_size(width, height)
                window.present(); self.drain(.3); window.check_geometry(); self.drain()
                self.assertEqual((window.get_width(), window.get_height()), (width, height))
                self.assertIsInstance(window.pending_only, asb.Gtk.ToggleButton)
                self.assertEqual(window.pending_only.get_label(), "Pending")
                self.assertEqual(window.apps, set())
                self.assertEqual(len(window.focus_widgets), 106)
                toolbar_height = window.window_handle.get_height()
                order = list(window.row_order)
                focused = "sample-15"
                window.focus_widgets[focused].grab_focus()
                adjustment = window.scroll.get_hadjustment()
                adjustment.set_value(min(100, max(0, adjustment.get_upper() - adjustment.get_page_size())))
                position = adjustment.get_value()
                for mode, row_height in (("compact", 22), ("comfortable", 68)):
                    window.view_filter.set_selected(1 if mode == "comfortable" else 0)
                    self.drain(.3)
                    self.assertEqual(window.view, mode)
                    self.assertEqual(window.row_height, row_height)
                    self.assertEqual(window.row_order, order)
                    self.assertEqual(window.focus_key(), focused)
                    if mode == "comfortable":
                        self.assert_focus_visible(window, focused)
                    else:
                        self.assertAlmostEqual(adjustment.get_value(), min(position, max(0, adjustment.get_upper() - adjustment.get_page_size())), delta=1)
                    self.assertEqual(window.window_handle.get_height(), toolbar_height)
                    self.assertEqual(len(window.focus_widgets), 106)
                    vertical = window.scroll.get_vadjustment()
                    self.assertAlmostEqual(vertical.get_upper(), vertical.get_page_size(), delta=1)
                    displayed = []
                    for row in self.widget_rows(window):
                        displayed.append(row.asb_thread["id"])
                        self.assertEqual(row.get_height(), row_height)
                    self.assertEqual(displayed, order)
                    vertical = window.scroll.get_vadjustment()
                    self.assertAlmostEqual(vertical.get_upper(), vertical.get_page_size(), delta=1)
                    self.assertEqual(window.actual_columns, (106 + window.capacity - 1) // window.capacity)
                    self.assertEqual(window.scroll.get_policy(), (asb.Gtk.PolicyType.AUTOMATIC, asb.Gtk.PolicyType.NEVER))
                    card = window.focus_widgets["sample-10"]
                    title = card.asb_title_label
                    self.assertIn("<b>", title.get_text())
                    self.assertIn("/example/Tools", card.asb_tooltip)
                    if mode == "comfortable":
                        self.assertIsInstance(card.get_child(), asb.Gtk.Overlay)
                        content = card.get_child().get_child()
                        self.assertEqual(content.get_orientation(), asb.Gtk.Orientation.VERTICAL)
                        top = content.get_first_child()
                        self.assertEqual(top.get_first_child().get_child().get_icon_name(), "asb-claude-symbolic")
                        self.assertEqual(top.get_first_child().get_next_sibling().get_text(), "Tools")
                        self.assertEqual(card.asb_pin_button.get_child().get_icon_name(), "view-pin-symbolic")
                        self.assertTrue(title.get_wrap())
                        self.assertEqual(title.get_lines(), 2)
                        self.assertEqual(title.get_height(), 32)
                        self.assertEqual(title.get_ellipsize(), asb.Pango.EllipsizeMode.END)
                        metadata = window.focus_widgets["sample-15"].get_child().get_child().get_last_child()
                        self.assertEqual(metadata.get_first_child().get_text(), "Working")
                        self.assertIs(card.asb_dot.get_ancestor(asb.Gtk.Button), card.asb_read_button)
                        self.assertEqual(metadata.get_last_child().get_ellipsize(), asb.Pango.EllipsizeMode.END)
                    else:
                        self.assertEqual(card.get_child().get_orientation(), asb.Gtk.Orientation.HORIZONTAL)
                        self.assertTrue(title.get_single_line_mode())
                    if output:
                        window.search.grab_focus(); self.drain(.2); adjustment.set_value(0); self.drain(.2)
                        self.capture(window, Path(output) / f"view-{mode}-{width}.png")
                        window.focus_widgets[focused].grab_focus()
                        position = adjustment.get_value()
                self.assertEqual(asb.read_layout(layout_path)["view"], "comfortable")
                if width == 360:
                    window.width_control.set_value(160); self.drain(.3)
                    self.assertEqual(window.get_width(), 360)
                    self.assertEqual(window.columns, 2)
                    column = window.list_body.get_first_child()
                    while column:
                        row = column.get_first_child()
                        self.assertEqual(row.get_height(), 68)
                        self.assertLessEqual(row.get_allocated_width(), 180)
                        self.assertLessEqual(row.get_child().get_child().get_last_child().get_allocated_width(), row.get_allocated_width())
                        column = column.get_next_sibling()
                    self.assertEqual(asb.read_layout(layout_path)["view"], "comfortable")
                    if output:
                        window.search.grab_focus(); self.drain(.2); adjustment.set_value(0); self.drain(.2)
                        self.capture(window, Path(output) / "view-comfortable-360-width160.png")
                    window.reset_width(); self.drain()
                    self.assertEqual(asb.read_layout(layout_path), {"columnWidth": 240, "view": "comfortable"})
                window.app_pills["codex"].set_active(True)
                self.assertEqual(window.apps, {"codex"})
                self.assertEqual(window.app_filter.get_selected(), 1)
                self.assertTrue(all(row["provider"] == "codex" for row in window.visible_rows()))
                window.app_pills["claude-desktop-code"].set_active(True)
                self.assertEqual(window.app_filter.get_selected(), 3)
                self.assertEqual(len(window.focus_widgets), 106)
                window.app_filter.set_selected(2)
                self.assertFalse(window.app_pills["codex"].get_active())
                self.assertTrue(window.app_pills["claude-desktop-code"].get_active())
                window.app_filter.set_selected(1)
                window.search.set_text("cl:"); window.render()
                self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
                window.select_states({"working", "idle"})
                window.pending_only.set_active(True)
                window.archive.set_active(True)
                window.view_filter.set_selected(0); self.drain()
                self.assertEqual(window.search.get_text(), "cl:")
                self.assertEqual(window.apps, {"codex"})
                self.assertEqual(window.states, {"working", "idle"})
                self.assertTrue(window.pending_only.get_active())
                self.assertTrue(window.archive.get_active())
                window.view_filter.set_selected(1); self.drain()
                self.assertEqual(window.column_width, 240)
                if output and width == 680:
                    window.search.grab_focus(); self.drain(.2)
                    adjustment.set_value(0); self.drain(.2)
                    self.capture(window, Path(output) / "view-comfortable-active-pills.png")
                window.clear_search(); window.select_apps(set()); window.select_states(set(asb.STATES))
                window.pending_only.set_active(False); window.archive.set_active(False); self.drain()
                with patch.object(asb, "request_async") as request:
                    card = window.focus_widgets["sample-10"]
                    window.open_row(None, card)
                    self.assertEqual(card.asb_title_label.get_text(), "Opening…")
                    self.assertEqual(card.get_height(), 68)
                    self.assertEqual(card.asb_title_label.get_height(), 32)
                    window.view_filter.set_selected(0); self.drain()
                    self.assertEqual(window.focus_widgets["sample-10"].asb_title_label.get_text(), "Opening…")
                    window.view_filter.set_selected(1); self.drain()
                    self.assertEqual(window.focus_widgets["sample-10"].get_height(), 68)
                    callback = request.call_args_list[0].args[2]
                    callback(None, "Cannot open this session.")
                    self.assertEqual(window.focus_widgets["sample-10"].asb_title_label.get_text(), dashboard["threads"][10]["title"])
                    self.assertIn("Cannot open", window.focus_widgets["sample-10"].asb_tooltip)
                with patch.object(window, "session_action") as action:
                    self.assertIsNotNone(window.pin_drag_prepare(None, 0, 0, "sample-10"))
                    self.assertTrue(window.pin_drop(None, "asb-pin:sample-10", 0, 33, "sample-11"))
                    self.assertEqual(action.call_args.args[2]["placement"], "before")
                window.set_palette(CUSTOM)
                self.assertTrue(window.has_css_class("asb-comfortable"))
                self.assertTrue(window.has_css_class("asb-custom"))
                if output and width == 1040:
                    window.search.grab_focus(); self.drain(.2)
                    adjustment.set_value(0); self.drain(.2)
                    self.capture(window, Path(output) / "view-comfortable-custom.png")
                window.set_palette(None)
                same = copy.deepcopy(dashboard); same["generatedAtMs"] += 30_000
                original = window.focus_widgets["sample-15"]
                window.apply_dashboard(same, None)
                self.assertIs(window.focus_widgets["sample-15"], original)
                window.close(); self.drain(.03)

    def assert_packing_fits(self, window):
        viewport = window.scroll.get_child()
        heights = []
        for row in window.focus_widgets.values():
            found, bounds = row.compute_bounds(viewport)
            self.assertTrue(found)
            self.assertGreaterEqual(bounds.origin.y, 0)
            self.assertLessEqual(bounds.origin.y + bounds.size.height, viewport.get_height())
            heights.append(row.get_height())
        self.assertEqual(window.row_height, max(heights))
        self.assertEqual(window.capacity, max(1, (viewport.get_height() - 4) // window.row_height))
        return viewport

    def test_font_row_height_sets_capacity_without_repeat(self):
        dashboard = mock_dashboard()
        for row in dashboard["threads"][::3]:
            row["title"] += " with a long synthetic title" * 5
        # No server: a failed refresh shows a notice, and the notice changes the list height.
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1080, 248)
        window.present(); self.drain(.5)
        settings = asb.Gtk.Settings.get_default()
        self.addCleanup(settings.reset_property, "gtk-font-name")
        # The font changes in a window that is open: only an internal relayout reports the new row heights.
        settings.set_property("gtk-font-name", "Sans 22")
        for selected, nominal in ((1, asb.COMFORTABLE_ROW_HEIGHT), (0, asb.ROW_HEIGHT)):
            with self.subTest(selected=selected):
                window.view_filter.set_selected(selected); self.drain(1.5)
                self.assertGreaterEqual(window.row_height, nominal)
                self.assert_packing_fits(window)
                with patch.object(window, "render", wraps=window.render) as render:
                    self.drain(1)
                render.assert_not_called()

    def test_a_title_with_line_breaks_keeps_the_card_height_and_a_wide_window_keeps_the_pill_width(self):
        dashboard = mock_dashboard()
        dashboard["threads"][5]["title"] = "\n".join(["A title with line breaks"] * 12)
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1182, 350)
        window.present(); self.drain(.5)
        window.view_filter.set_selected(1); self.drain(1.5)
        # A title with line breaks is one paragraph in the card, so all cards have the same height.
        heights = {widget.get_height() for widget in window.focus_widgets.values()}
        self.assertEqual(len(heights), 1)
        self.assertEqual((window.row_height, window.capacity), (max(heights), (window.geometry[1] - 4) // max(heights)))
        self.assertGreater(window.capacity, 1)
        # In the wide layout the Drawer pill has its natural width, as the other pills.
        self.assertTrue(window.wide_controls)
        self.assertLessEqual(window.drawer_only.get_width(), window.drawer_only.measure(asb.Gtk.Orientation.HORIZONTAL, -1)[1])

    def test_scrollbar_below_viewport_sets_capacity(self):
        settings = asb.Gtk.Settings.get_default()
        self.addCleanup(settings.reset_property, "gtk-overlay-scrolling")
        settings.set_property("gtk-overlay-scrolling", False)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", mock_dashboard(), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1080, 248)
        window.present(); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(1.5)
        self.assertEqual((window.get_width(), window.get_height()), (1080, 248))
        viewport = self.assert_packing_fits(window)
        self.assertLess(viewport.get_height(), window.scroll.get_height())
        self.assertGreater(len(window.focus_widgets), window.capacity * window.columns)

    def test_horizontal_short_wheel_focus_dividers_and_outside_settings(self):
        dashboard = mock_dashboard()
        dashboard["threads"][10].update(pinned=True, pinIndex=0)
        dashboard["threads"][11].update(pinned=True, pinIndex=1)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1080, 248)
        window.present(); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.3); window.check_geometry(); self.drain()
        self.assertEqual((window.get_width(), window.get_height()), (1080, 248))
        self.assertEqual(window.capacity, 3)
        column = window.list_body.get_first_child()
        rows = []
        row = column.get_first_child()
        while row:
            rows.append(row); row = row.get_next_sibling()
        self.assertEqual(len(rows), 3)
        # The overlay scrollbar lies over the rows; the viewport is the visible area.
        found, view_bounds = window.scroll.get_child().compute_bounds(window.scroll)
        self.assertTrue(found)
        for row in rows:
            self.assertEqual(row.get_height(), 68)
            found, bounds = row.compute_bounds(window.scroll)
            self.assertTrue(found)
            self.assertGreaterEqual(bounds.origin.y, view_bounds.origin.y)
            self.assertLessEqual(bounds.origin.y + bounds.size.height, view_bounds.origin.y + view_bounds.size.height)
        adjustment = window.scroll.get_hadjustment()
        vertical = window.scroll.get_vadjustment()
        self.assertAlmostEqual(vertical.get_upper(), vertical.get_page_size(), delta=1)
        self.assertEqual([row.asb_thread["id"] for row in self.widget_rows(window)], window.row_order)
        self.assertEqual(len(set(window.row_order)), 106)
        self.assertEqual(window.actual_columns, (106 + window.capacity - 1) // window.capacity)
        self.assertGreater(adjustment.get_upper(), adjustment.get_page_size())
        adjustment.set_value(0)
        self.assertTrue(window.scroll_horizontal(None, 0, 1))
        # The wheel moves with a spring, and the test display can be as slow as one frame each second.
        end = time.monotonic() + 6
        while window.scroll_target is not None and time.monotonic() < end:
            self.drain(.02)
        self.assertIsNone(window.scroll_target)
        self.assertGreater(adjustment.get_value(), 0)
        surface = SimpleNamespace(get_unit=lambda: asb.Gdk.ScrollUnit.SURFACE)
        before = adjustment.get_value()
        window.scroll_horizontal(surface, 17, 0)
        self.assertAlmostEqual(adjustment.get_value(), before + 17, delta=1)
        first, last = window.row_order[0], window.row_order[-1]
        window.row_key(None, asb.Gdk.KEY_End, 0, 0, first); self.drain()
        self.assertEqual(window.focus_key(), last)
        self.assert_focus_visible(window, last)
        window.row_key(None, asb.Gdk.KEY_Home, 0, 0, last); self.drain()
        self.assert_focus_visible(window, first)
        self.assertAlmostEqual(adjustment.get_value(), 0, delta=1)
        window.search.grab_focus(); adjustment.set_value(500)
        changed = copy.deepcopy(dashboard)
        changed["threads"][20]["title"] = "A changed title at the same horizontal position"
        window.apply_dashboard(changed, None); self.drain()
        self.assertAlmostEqual(adjustment.get_value(), 500, delta=1)
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            self.capture(window, Path(output) / "view-comfortable-1080-horizontal-scrolled.png")
        step = window.column_pixel_width + 12
        index = int(adjustment.get_value() // step) + 1
        divider = index * step - 6
        self.assertTrue(window.divider_at(divider))
        order = list(window.row_order)
        window.column_drag_begin(None, divider, 10)
        window.column_drag_update(None, -40, 0); self.drain()
        window.column_drag_end()
        self.assertEqual(window.column_width, 200)
        self.assertEqual(window.row_order, order)
        self.assertEqual(len(window.focus_widgets), 106)
        with patch.object(window, "session_action") as action:
            self.assertIsNotNone(window.pin_drag_prepare(None, 0, 0, "sample-10"))
            self.assertTrue(window.pin_drop(None, "asb-pin:sample-10", 0, 60, "sample-11"))
            self.assertEqual(action.call_args.args[2]["placement"], "after")
        window.row_key(None, asb.Gdk.KEY_End, 0, 0, first); self.drain()
        window.set_default_size(680, 500); self.drain(.3)
        self.assertEqual(window.focus_key(), last)
        self.assert_focus_visible(window, last)
        window.search.grab_focus(); adjustment.set_value(adjustment.get_upper())
        window.pending_only.set_active(True); self.drain()
        self.assertLessEqual(adjustment.get_value(), adjustment.get_upper() - adjustment.get_page_size() + 1)
        window.pending_only.set_active(False); self.drain()
        window.close(); self.drain(.3)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(680, 500)
        window.present(); self.drain(.3)
        identity = window.row_order[0]
        window.focus_widgets[identity].grab_focus()
        popup = window.menu_button.get_popover()
        self.assertTrue(popup.get_autohide())
        self.assertGreater(window.menu_button.get_width(), 0)
        window.menu_button.grab_focus(); self.drain()
        clicked = []
        button = window.menu_button.get_first_child()
        button.connect("clicked", lambda *_args: clicked.append(True))
        self.assertTrue(button.activate()); self.drain(.4)
        self.assertEqual(clicked, [True])
        self.assertTrue(popup.get_visible(), (window.menu_button.get_active(), window.menu_button.get_mapped(),
                                             window.get_focus(), window.get_width(), window.get_height()))
        window.view_filter.grab_focus(); self.drain()
        window.view_filter.set_selected(1); self.drain()
        self.assertTrue(popup.get_visible())
        focus = window.get_focus()
        self.assertIsNotNone(focus.get_ancestor(asb.Gtk.Popover))
        found, bounds = window.view_filter.compute_bounds(window)
        self.assertTrue(found)
        window.settings_click.emit("pressed", 1, bounds.origin.x + 2, bounds.origin.y + 2)
        self.assertTrue(popup.get_visible())
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            self.capture(popup, Path(output) / "native-settings-popup.png")
        self.assertFalse(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
        window.settings_click.emit("pressed", 1, 0, window.get_height() - 1)
        self.drain()
        self.assertFalse(popup.get_visible())
        self.assertEqual(window.focus_key(), identity)
        window.close(); self.drain(.03)

    def test_card_motion_wheel_spring_and_column_width(self):
        threads = [{"id": f"s{n}", "provider": "codex", "providerLabel": "Codex",
                    "title": f"Sample session {n} " + ("needle " if n % 2 else "") + "with a long synthetic title " * 7,
                    "cwd": f"/example/project-{n % 9}", "projectName": f"project-{n % 9}", "state": "working" if n < 3 else "idle",
                    "canOpen": True, "updatedAtMs": NOW - n * 600_000, "readStatus": "unknown",
                    "pending": 3 <= n < 8, "unread": 3 <= n < 8, "completionAttention": 3 <= n < 8} for n in range(116)]
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": threads}
        # No server: a failed refresh shows a notice, and the notice changes the list height.
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1000, 500)
        window.present()
        strip, motion, spring = window.list_body, window.motion_animation, window.scroll_animation
        playing = asb.Adw.AnimationState.PLAYING
        frames = []
        window.get_frame_clock().connect("after-paint", lambda *_args: frames.append(
            (strip.motion_progress, dict(strip.motion), window.painted_places())))
        def wait(done, limit=6):
            # The frame rate of the test display can be as low as one frame each second.
            end = time.monotonic() + limit
            while not done() and time.monotonic() < end:
                self.drain(.02)
            self.assertTrue(done())
        def change(action, moves=True):
            before = window.painted_places()
            frames.clear()
            action()
            if moves:
                wait(lambda: any(frame[1] for frame in frames) and not strip.motion and window.motion_from is None)
            else:
                wait(lambda: len(frames) >= 2 and not window.motion_from)
            return before, list(frames)
        def columns():
            found, child = [], strip.get_first_child()
            while child:
                found.append(child)
                child = child.get_next_sibling()
            return found
        def assert_rest():
            self.assertEqual((strip.motion, window.motion_columns, window.motion_from), ({}, [], None))
            self.assertNotEqual(motion.get_state(), playing)
            self.assertNotEqual(spring.get_state(), playing)
            self.assertEqual([row.asb_thread["id"] for row in self.widget_rows(window)], window.row_order)
            self.assertEqual({row.get_height() for row in self.widget_rows(window)}, {22})
            for column in columns():
                self.assertIn(column.get_width(), (window.column_pixel_width, window.column_pixel_width - 1))  # 1 px divider.
        def assert_glide(before, seen, identities):
            first = next(index for index, frame in enumerate(seen) if frame[1])
            for progress, offsets, places in seen[:first + 1]:
                for identity in identities:
                    self.assertAlmostEqual(places[identity][0], before[identity][0], delta=1)
                    self.assertAlmostEqual(places[identity][1], before[identity][1], delta=1)
            progress = [frame[0] for frame in seen[first:]]
            self.assertEqual((progress[0], progress[-1]), (1, 0))
            self.assertEqual(progress, sorted(progress, reverse=True))
            return seen[first]
        def mark(identity, pending):
            board = copy.deepcopy(window.dashboard)
            next(row for row in board["threads"] if row["id"] == identity).update(pending=pending, unread=pending, completionAttention=pending)
            window.dashboard = board
            window.render()

        wait(lambda: len(frames) >= 3 and len(columns()) == 6 and columns()[0].get_width() == window.column_pixel_width)
        self.assertEqual((window.columns, window.capacity, len(window.focus_widgets)), (4, 20, 116))
        self.assertTrue(all(isinstance(column, asb.SessionColumn) for column in columns()))
        self.assertFalse(any(frame[1] for frame in frames))  # The first render and its geometry repack do not move.
        assert_rest()

        # (a) Order only: an unread row becomes read. Six rows change places inside the same columns.
        listings = columns()
        window.set_focus(window.focus_widgets["s5"])
        before, seen = change(lambda: mark("s5", False))
        self.assertEqual(columns(), listings)
        self.assertEqual(window.focus_key(), "s5")
        _progress, offsets, _places = assert_glide(before, seen, before)
        final = window.painted_places()
        self.assertEqual(set(offsets), {"s5", "s6", "s7", "s0", "s1", "s2"})
        self.assertEqual(offsets, {identity: (before[identity][0] - final[identity][0], before[identity][1] - final[identity][1], 0)
                                   for identity in offsets})
        self.assertEqual(offsets["s5"], (0, -110, 0))
        curve = [motion.calculate_value(time_ms) for time_ms in range(601)]
        self.assertGreater(curve[17], .9)  # Soft start.
        self.assertTrue(all(0 <= later <= earlier <= 1 for earlier, later in zip(curve, curve[1:])))  # No overshoot.
        self.assertLess(curve[350], .01)
        self.assertLessEqual(motion.get_estimated_duration(), 600)
        assert_rest()

        # (b) Filters: rows that stay glide, a long title does not widen the three columns, and rows that return fade in.
        full = window.painted_places()
        before, seen = change(lambda: window.search.set_text("needle"))
        staying = set(window.focus_widgets)
        self.assertEqual((len(staying), len(columns())), (58, 3))
        self.drain(.05)
        self.assertEqual(window.focus_key(), "s5")  # The queued focus restore survives the move of focus to a column.
        _progress, offsets, _places = assert_glide(before, seen, staying)
        self.assertTrue(all(offset[2] == 0 for offset in offsets.values()))
        self.assertGreater(len(offsets), 50)
        assert_rest()
        before, seen = change(lambda: window.search.set_text(""))
        _progress, offsets, places = assert_glide(before, seen, staying)
        self.assertEqual({identity for identity, offset in offsets.items() if offset[2]}, set(window.focus_widgets) - staying)
        self.assertTrue(all(places[identity][2] == 1 and offsets[identity] == (0, 0, 1) for identity in set(window.focus_widgets) - staying))
        self.assertTrue(all(place[2] == 0 for place in window.painted_places().values()))  # Full opacity at the end.
        self.assertEqual(window.painted_places(), full)
        assert_rest()

        # A change during a motion starts from the painted places.
        before = window.painted_places()
        frames.clear()
        mark("s6", False)
        wait(lambda: any(frame[1] for frame in frames))
        final = {identity: widget.compute_bounds(window.scroll)[1].origin for identity, widget in window.focus_widgets.items()}
        strip.motion_progress = .5
        flight = window.painted_places()
        self.assertEqual(flight["s6"], (4, (before["s6"][1] + final["s6"].y) / 2, 0))
        frames.clear()
        mark("s7", False)
        wait(lambda: any(frame[1] for frame in frames) and not strip.motion)
        assert_glide(flight, list(frames), flight)
        assert_rest()

        # (c) GNOME animations off: no offset in any frame.
        settings = window.get_settings()
        settings.set_property("gtk-enable-animations", False)
        self.addCleanup(settings.set_property, "gtk-enable-animations", True)
        for action in (lambda: mark("s3", False), lambda: window.search.set_text("needle"), lambda: window.search.set_text("")):
            _before, seen = change(action, False)
            self.assertFalse(any(frame[0] or frame[1] for frame in seen))
        adjustment = window.scroll.get_hadjustment()
        window.scroll_horizontal(None, 0, 1)
        self.assertEqual((adjustment.get_value(), window.scroll_target), (max(32, adjustment.get_step_increment()), None))
        settings.set_property("gtk-enable-animations", True)
        adjustment.set_value(0)
        assert_rest()

        # (d) A new column count is a geometry repack: no motion.
        _before, seen = change(lambda: window.width_control.set_value(160), False)
        self.assertEqual(window.columns, 5)
        self.assertFalse(any(frame[0] or frame[1] for frame in seen))
        _before, seen = change(lambda: window.width_control.set_value(240), False)
        self.assertFalse(any(frame[0] or frame[1] for frame in seen))
        wait(lambda: columns()[0].get_width() == window.column_pixel_width)
        assert_rest()

        # (e) One wheel click from rest: the spring of the window, read at 60 Hz frame times.
        window.scroll_horizontal(None, 0, 1)
        distance = window.scroll_target
        self.assertEqual(distance, max(32, adjustment.get_step_increment()))
        self.assertEqual(spring.get_state(), playing)
        curve = [spring.calculate_value(time_ms) for time_ms in range(601)]
        self.assertLess(curve[17], .15 * distance)
        reached = next(time_ms for time_ms, value in enumerate(curve) if value >= .9 * distance)
        self.assertTrue(150 <= reached <= 300, reached)
        self.assertLessEqual(max(curve), distance)
        self.assertTrue(all(earlier <= later for earlier, later in zip(curve, curve[1:])))
        self.assertLessEqual(spring.get_estimated_duration(), 450)
        self.assertTrue(all(abs(value - distance) < .5 for value in curve[spring.get_estimated_duration() - 1:]))
        wait(lambda: window.scroll_target is None)
        self.assertEqual(adjustment.get_value(), distance)
        # (f) At rest no animation plays.
        assert_rest()

    def ink(self, widget):
        """The highest painted alpha of one widget: 0 when CSS hides it, below 255 when CSS dims it."""
        snapshot = asb.Gtk.Snapshot()
        asb.Gtk.WidgetPaintable.new(widget).snapshot(snapshot, widget.get_width(), widget.get_height())
        node = snapshot.to_node()
        if node is None:
            return 0
        # The Cairo renderer needs no surface, and its result does not depend on the renderer of the test display.
        renderer = asb.Gsk.CairoRenderer()
        renderer.realize(None)
        data, _stride = asb.Gdk.TextureDownloader.new(renderer.render_texture(node, None)).download_bytes()
        renderer.unrealize()
        return max(data.get_data()[3::4])

    def settle(self, window):
        # CSS state reaches the widgets in the next frame, and the test display can paint only one frame each second.
        self.drain(.1)
        frames = []
        handler = window.get_frame_clock().connect("after-paint", lambda *_args: frames.append(True))
        window.queue_draw()
        end = time.monotonic() + 6
        while not frames and time.monotonic() < end:
            self.drain(.02)
        window.get_frame_clock().disconnect(handler)
        self.assertTrue(frames)
        self.drain(.05)

    def test_drawer_pill_card_button_views_peek_and_narrow_column(self):
        def row(n, **extra):
            return {"id": f"s{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Summarize the open issues into one short note {n}",
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "updatedAtMs": NOW - n * 60_000, **extra}
        unread = dict(pending=True, unread=True, completionAttention=True, pendingSource="observed-completion")
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            row(1, **unread), row(2, **unread), row(3), row(4, state="working"), row(5, pending=True, questionAttention=True)]}
        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(520, 400)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.3); window.check_geometry(); self.drain()
        settle = lambda: self.settle(window)
        pill, bubble, cards, hover = window.drawer_only, window.drawer_bubble, window.focus_widgets, asb.Gtk.StateFlags.PRELIGHT
        put, out = "Put in drawer: look read here, keep it under Drawer", "Take out of drawer: show as unread again"
        def reply(identity, **change):
            requests[-1][2]({"changed": True, "threadId": identity, "thread": dict(cards[identity].asb_thread, **change)}, None)
            settle()

        # The pill: glyph, word, and a count bubble that is hidden at zero.
        self.assertIsInstance(pill, asb.Gtk.ToggleButton)
        self.assertIs(window.pending_group.get_last_child(), pill)
        self.assertIs(window.working_only.get_next_sibling(), pill)
        glyph = pill.get_child().get_first_child()
        self.assertTrue(glyph.has_css_class("asb-drawer-glyph"))
        self.assertEqual((glyph.get_width(), glyph.get_height()), (9, 5))  # Without the 1 px border.
        self.assertEqual(glyph.get_next_sibling().get_text(), "Drawer")
        self.assertIs(pill.get_child().get_last_child(), bubble)
        self.assertFalse(bubble.get_visible())
        self.assertFalse(pill.has_css_class("asb-drawer-filled"))
        self.assert_accessible_label(pill, "Drawer only. Sessions in the drawer: 0")
        self.assertEqual(pill.get_tooltip_text(), "Show only the sessions in the drawer, as unread. Point here to see them in the list.")
        # An empty list changes its text when only the drawer view changes.
        window.search.set_text("no such session"); settle()
        empty = lambda: window.list_body.get_first_child().get_text()
        self.assertEqual(empty(), "No matching sessions. Change the search or filters.")
        pill.set_active(True); settle()
        self.assertEqual(empty(), "The drawer is empty. Put an unread session in it to get it out of the way.")
        pill.set_active(False); settle()
        self.assertEqual(empty(), "No matching sessions. Change the search or filters.")
        window.search.set_text(""); settle(); window.set_focus(None); settle()

        # The drawer button: only for a row with an unread dot, before Read and Pin, and only with the pointer on the card.
        self.assertEqual(window.column_pixel_width, 250)
        self.assertEqual(window.row_order, ["s1", "s2", "s5", "s4", "s3"])
        self.assertEqual({identity: card.asb_drawer_button.get_visible() for identity, card in cards.items()},
                         {"s1": True, "s2": True, "s3": False, "s4": False, "s5": False})
        one, question = cards["s1"], cards["s5"]
        drawer, read, cue = one.asb_drawer_button, one.asb_read_button, one.asb_read_button.get_child().get_last_child()
        self.assertIs(drawer.get_next_sibling().get_first_child(), read)
        self.assertIs(drawer.get_next_sibling().get_next_sibling(), one.asb_pin_button)
        self.assertTrue(drawer.get_parent().has_css_class("asb-corner-drawer"))
        self.assertFalse(question.asb_drawer_button.get_parent().has_css_class("asb-corner-drawer"))
        self.assertEqual((drawer.get_width(), drawer.get_height(), drawer.get_action_name()), (24, 24, "win.drawer-in"))
        self.assertEqual(drawer.get_tooltip_text(), put)
        self.assert_accessible_label(drawer, put + ": " + one.asb_thread["title"])
        # The title has the same allocation with three buttons and with two.
        self.assertIs(one.get_parent(), question.get_parent())
        self.assertEqual(one.asb_title_label.get_width(), question.asb_title_label.get_width())
        self.assertEqual(one.asb_title_label.get_width(), one.get_width() - 16 - 21 - 54)
        self.assertEqual((one.get_height(), one.asb_title_label.get_height()), (68, 32))
        self.assertEqual((self.ink(one.asb_dot), self.ink(cue), self.ink(drawer), self.ink(one.asb_state_label)), (255, 0, 0, 255))
        one.set_state_flags(hover, False); question.set_state_flags(hover, False); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(drawer)), (0, 255))
        self.assertGreater(self.ink(cue), 0)
        self.assertLess(self.ink(one.asb_state_label), 255)  # The read tone.
        self.assertGreater(self.ink(question.asb_dot), 0)  # A ? does not change.
        one.unset_state_flags(hover); question.unset_state_flags(hover); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(cue), self.ink(drawer)), (255, 0, 0))
        # Focus from a mouse click (not visible) does not change the row. Visible keyboard focus shows the controls.
        shown = lambda: (self.ink(one.asb_dot), self.ink(drawer), self.ink(cue) > 0, self.ink(one.asb_state_label))
        for focus in (one, read, drawer):
            window.set_focus(focus); window.set_focus_visible(False); settle()
            self.assertFalse(one.has_css_class("asb-key-focus"))
            if focus is one:
                self.assertEqual(shown(), (255, 0, False, 255))
                self.assertGreater(self.ink(one.asb_pin_button), 0)  # The pin rule of 1.5.0 stays.
            self.assertEqual((self.ink(one.asb_dot), self.ink(drawer)), (255, 0))
            window.set_focus_visible(True); settle()
            self.assertTrue(one.has_css_class("asb-key-focus"))
            self.assertEqual(shown(), (0, 255, True, 255))
        window.set_focus(cards["s2"]); settle()
        self.assertFalse(one.has_css_class("asb-key-focus"))
        self.assertEqual(shown(), (255, 0, False, 255))
        window.set_focus(one)  # Tab goes to drawer, read, pin.
        for control in (drawer, read, one.asb_pin_button):
            self.assertTrue(one.child_focus(asb.Gtk.DirectionType.TAB_FORWARD))
            self.assertIs(window.get_focus(), control)
        window.set_focus(None); window.set_focus_visible(False); settle()
        self.assertFalse(one.has_css_class("asb-key-focus"))

        # A click sends drawer-in. After the reply the row looks read, sorts with the read rows, and the count is 1.
        drawer.emit("clicked")
        self.assertEqual((requests[-1][1], requests[-1][4], requests[-1][5]), ("/api/threads/s1/drawer-in", "POST", None))
        self.assertIsNone(drawer.get_action_name())
        self.assertTrue(drawer.has_css_class("asb-action-pending"))
        window.dashboard_etag = "etag"
        reply("s1", unread=False, pending=False, drawer=True)
        self.assertIs(cards["s1"], one)
        self.assertIsNone(window.dashboard_etag)
        self.assertEqual(window.row_order, ["s2", "s5", "s4", "s1", "s3"])
        self.assertEqual(window.count.get_text(), "2 Pending · 5 sessions")
        self.assertTrue(one.has_css_class("asb-drawer") and one.has_css_class("asb-idle-read"))
        self.assertEqual((self.ink(one.asb_dot), self.ink(read), self.ink(drawer)), (0, 0, 0))
        self.assertEqual((bubble.get_visible(), bubble.get_text(), pill.has_css_class("asb-drawer-filled")), (True, "1", True))
        self.assert_accessible_label(pill, "Drawer only. Sessions in the drawer: 1")
        self.assertEqual((drawer.get_visible(), drawer.get_action_name(), drawer.has_css_class("asb-drawer-filled")),
                         (True, "win.drawer-out", True))
        self.assertFalse(drawer.has_css_class("asb-action-pending"))
        self.assertEqual(drawer.get_tooltip_text(), out)
        self.assert_accessible_label(drawer, out + ": " + one.asb_thread["title"])
        self.assertTrue(one.asb_accessible_label.endswith(" Task completed. In the drawer. Still unread."))
        self.assert_accessible_label(one, one.asb_accessible_label)
        self.assertIn("Finished. Not read yet.\nIn the drawer", one.asb_tooltip)
        self.assertEqual(asb.row_menu_actions(one.asb_thread)[:2], [("Read", "mark-read"), ("Take out of drawer", "drawer-out")])
        one.set_state_flags(hover, False); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(read), self.ink(drawer)), (0, 255, 255))
        self.assertGreater(self.ink(cue), 0)
        one.unset_state_flags(hover); settle()

        # Peek changes only the drawer cards; CSS shows their unread look without a render.
        controllers = pill.observe_controllers()
        peek = next(controller for controller in (controllers.get_item(index) for index in range(controllers.get_n_items()))
                    if isinstance(controller, asb.Gtk.EventControllerMotion))
        for palette in (None, CUSTOM):
            window.set_palette(palette)
            for view in (0, 1):
                window.view_filter.set_selected(view); settle(); window.set_focus(None); settle()
                one, two = cards["s1"], cards["s2"]
                colors = lambda card: [getattr(card, name).get_color().to_string() for name in
                                       ("asb_title_label", "asb_folder", "asb_state_label", "asb_age_label") if hasattr(card, name)]
                with patch.object(window, "render") as render:
                    self.assertEqual((self.ink(one.asb_dot), self.ink(two.asb_dot)), (0, 255))
                    if view:  # In the normal list a drawer row has the quiet text of a read Idle row.
                        self.assertEqual(colors(one), colors(cards["s3"]))
                        self.assertNotEqual(colors(one)[0], colors(two)[0])
                        self.assertNotEqual(colors(one)[1], colors(two)[1])
                    else:  # Compact: focus of any kind never hides the dot.
                        for visible in (False, True):
                            window.set_focus(two); window.set_focus_visible(visible); settle()
                            self.assertEqual((self.ink(two.asb_dot), self.ink(two.asb_state_label)), (255, 255))
                        window.set_focus(None); window.set_focus_visible(False); settle()
                    peek.emit("enter", 1, 1); settle()
                    self.assertTrue(one.has_css_class("asb-drawer-lit"))
                    self.assertFalse(window.has_css_class("asb-drawer-lit"))
                    self.assertFalse(two.has_css_class("asb-drawer-lit"))
                    self.assertEqual(colors(one), colors(two))  # The normal text color, in the peek.
                    self.assertEqual((self.ink(one.asb_dot), self.ink(one.asb_state_label), self.ink(two.asb_dot)), (255, 255, 255))
                    if view:
                        self.assertEqual((self.ink(one.asb_read_button), self.ink(one.asb_drawer_button)), (255, 0))
                    peek.emit("leave"); settle()
                    self.assertFalse(one.has_css_class("asb-drawer-lit"))
                    self.assertEqual(self.ink(one.asb_dot), 0)
                    if not palette:
                        self.assertLess(self.ink(one.asb_state_label), 255 if not view else 256)
                    two.set_state_flags(hover, False); settle()  # The hover rule holds in both views.
                    self.assertEqual(self.ink(two.asb_dot), 0)
                    if view:
                        self.assertEqual(self.ink(two.asb_drawer_button), 255)
                    two.unset_state_flags(hover); settle()
                    self.assertEqual(self.ink(two.asb_dot), 255)
                    render.assert_not_called()
        window.set_palette(None)
        one, drawer = cards["s1"], cards["s1"].asb_drawer_button

        # The drawer view: only drawer rows, with the unread look. Drawer and Pending do not combine.
        window.pending_only.set_active(True); settle()
        self.assertEqual(window.row_order, ["s2", "s5"])
        pill.set_active(True); settle()
        self.assertFalse(window.pending_only.get_active())
        self.assertTrue(one.has_css_class("asb-drawer-lit"))
        self.assertEqual(window.row_order, ["s1"])
        self.assertEqual(window.count.get_text(), "0 Pending · 1 sessions")
        self.assertIs(one.asb_dot.get_ancestor(asb.Gtk.Button), one.asb_read_button)
        self.assertEqual((self.ink(one.asb_dot), self.ink(one.asb_state_label), self.ink(drawer)), (255, 255, 0))
        normal = [label.get_color().to_string() for label in (one.asb_title_label, one.asb_folder, one.asb_state_label, one.asb_age_label)]
        pill.set_active(False); settle()  # The drawer view has the normal text color; the normal list has the quiet color.
        quiet = [label.get_color().to_string() for label in (one.asb_title_label, one.asb_folder, one.asb_state_label, one.asb_age_label)]
        self.assertTrue(all(first != second for first, second in zip(normal, quiet)))
        self.assertEqual(normal[0], cards["s2"].asb_title_label.get_color().to_string())
        pill.set_active(True); settle()
        peek.emit("enter", 1, 1); peek.emit("leave"); settle()
        self.assertTrue(one.has_css_class("asb-drawer-lit"))
        tooltip = SimpleNamespace(set_custom=lambda _content: None)
        window.query_row_tooltip(one, 0, 0, False, tooltip)
        self.assertEqual(one.asb_tooltip_key[0]["indicator"], "dot")
        window.pending_only.set_active(True); settle()
        self.assertFalse(pill.get_active())
        self.assertFalse(window.has_css_class("asb-drawer-lit"))
        self.assertEqual(window.row_order, ["s2", "s5"])
        window.query_row_tooltip(one, 0, 0, False, tooltip)
        self.assertEqual(one.asb_tooltip_key[0]["indicator"], "")
        window.search.set_text("no such session"); pill.set_active(True); settle()
        self.assertEqual(window.list_body.get_first_child().get_text(), "No matching sessions. Change the search or filters.")
        window.search.set_text(""); settle()
        self.assertEqual(window.row_order, ["s1"])

        # Take out: the row leaves the drawer view, and the empty drawer has its own text.
        drawer.emit("clicked")
        self.assertEqual(requests[-1][1], "/api/threads/s1/drawer-out")
        reply("s1", unread=True, pending=True, drawer=False)
        self.assertEqual(window.row_order, [])
        self.assertEqual(window.list_body.get_first_child().get_text(),
                         "The drawer is empty. Put an unread session in it to get it out of the way.")
        self.assertFalse(bubble.get_visible())
        self.assertFalse(pill.has_css_class("asb-drawer-filled"))
        pill.set_active(False); settle()
        self.assertEqual(window.row_order, ["s1", "s2", "s5", "s4", "s3"])
        self.assertFalse(one.has_css_class("asb-drawer"))
        self.assertEqual((self.ink(one.asb_dot), drawer.get_action_name()), (255, "win.drawer-in"))

        # A column narrower than 190 px has no drawer button; the corner is the Read and Pin pair.
        window.width_control.set_value(160); settle()
        self.assertLess(window.column_pixel_width, 190)
        self.assertFalse(any(card.asb_drawer_button.get_visible() or card.asb_drawer_button.get_parent().has_css_class("asb-corner-drawer")
                             for card in cards.values()))
        self.assertTrue(one.asb_read_button.get_visible() and one.asb_pin_button.get_visible())
        self.assertIn(("Put in drawer", "drawer-in"), asb.row_menu_actions(one.asb_thread))
        window.width_control.set_value(240); settle()
        self.assertEqual({identity: card.asb_drawer_button.get_visible() for identity, card in cards.items()},
                         {"s1": True, "s2": True, "s3": False, "s4": False, "s5": False})

        # The pill follows the other pills at 680 px and stays usable at 320 px with a count.
        drawer.emit("clicked")
        reply("s1", unread=False, pending=False, drawer=True)
        self.assertTrue(bubble.get_visible())
        # The count follows the archive setting, as the drawer view does. Search and the other filters do not change it.
        board = copy.deepcopy(window.dashboard)
        board["threads"].append(row(6, drawer=True, archived=True))
        window.apply_dashboard(board, None); settle()
        self.assertEqual(bubble.get_text(), "1")
        window.archive.set_active(True); settle()
        self.assertEqual(bubble.get_text(), "2")
        self.assert_accessible_label(pill, "Drawer only. Sessions in the drawer: 2")
        window.search.set_text("no such session"); window.app_pills["claude-desktop-code"].set_active(True); settle()
        self.assertEqual((bubble.get_text(), window.row_order), ("2", []))
        window.search.set_text(""); window.app_pills["claude-desktop-code"].set_active(False); pill.set_active(True); settle()
        self.assertEqual(window.row_order, ["s1", "s6"])
        window.archive.set_active(False); settle()
        self.assertEqual((bubble.get_text(), window.row_order), ("1", ["s1"]))
        self.assert_accessible_label(pill, "Drawer only. Sessions in the drawer: 1")
        pill.set_active(False); settle()
        for width, wide in ((320, False), (700, True)):
            window.set_default_size(width, 400); settle(); window.check_geometry(); settle()
            self.assertEqual((window.get_width(), window.wide_controls), (width, wide))
            self.assertIs(pill.get_parent().get_parent(), window.tools if wide else window.feedback)
            self.assertEqual(self.ink(bubble), 255)
            self.assertGreater(self.ink(pill.get_child().get_first_child()), 0)
        # 100 or more drawer rows show 99+; the accessible label keeps the exact number.
        for count, text in ((99, "99"), (100, "99+"), (120, "99+")):
            board = {"generatedAtMs": NOW, "providers": [], "threads": [row(n, drawer=True) for n in range(count)]}
            window.apply_dashboard(board, None); settle()
            self.assertEqual(bubble.get_text(), text)
            self.assert_accessible_label(pill, f"Drawer only. Sessions in the drawer: {count}")
        window.close(); self.drain(.03)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer clicks need xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_real_pointer_click_on_a_corner_button_does_not_open_the_session(self):
        asb.gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11
        def row(n, **extra):
            return {"id": f"s{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Summarize the open issues {n}",
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "updatedAtMs": NOW - n * 60_000, **extra}
        unread = dict(pending=True, unread=True, completionAttention=True, pendingSource="observed-completion")
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [row(1, **unread), row(2, **unread), row(3, state="working"), row(4)]}
        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout
        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)  # A pointer that stays on the window changes the hover state in the next tests.
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(700, 420)
        window.present(); window.set_focus(None); self.drain(.4)
        window.view_filter.set_selected(1); self.drain(.4); window.check_geometry(); self.drain(.3)
        cards = window.focus_widgets
        def click(widget):
            found, bounds = widget.compute_bounds(window)
            self.assertTrue(found)
            left, top = window.get_surface_transform()
            xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(window.get_surface()),
                int(bounds.origin.x + bounds.size.width / 2 + left), int(bounds.origin.y + bounds.size.height / 2 + top))
            self.drain(.3)
            del requests[:]
            xdo("click", 1)
            self.drain(.4)
            return [request[1] for request in requests]
        failed = lambda: (requests[-1][2](None, "Cannot change this session."), self.drain(.3))
        self.assertEqual(click(cards["s2"].asb_drawer_button), ["/api/threads/s2/drawer-in"])
        pending = list(requests)
        self.assertEqual(click(cards["s2"].asb_title_label), [])  # The card does not open while its action is in flight.
        requests.extend(pending)
        failed()
        self.assertEqual(click(cards["s2"].asb_read_button), ["/api/threads/s2/mark-read"])
        failed()
        self.assertEqual(click(cards["s3"].asb_read_button), ["/api/threads/s3/discard-result"])
        failed()
        self.assertEqual(click(cards["s2"].asb_pin_button), ["/api/threads/s2/pin"])
        requests[-1][2]({"changed": True, "pinnedOrder": ["s2"]}, None); self.drain(.8)
        self.assertEqual(window.row_order[0], "s2")
        self.assertFalse(window.opening or window.session_actions)
        # Directly after an action is complete, a click on the card body opens the session one time.
        self.assertEqual(click(cards["s2"].asb_title_label), ["/api/threads/s2/open"])
        requests[-1][2]({"opened": True}, None); self.drain(.2)
        self.assertEqual(click(cards["s4"].asb_title_label), ["/api/threads/s4/open"])
        requests[-1][2]({"opened": True}, None); self.drain(.2)
        # Focus from a mouse click does not change the row: after the pointer leaves, the dot stays and no drawer button shows.
        one, two = cards["s1"], cards["s2"]
        self.assertEqual(click(one.asb_read_button), ["/api/threads/s1/mark-read"])
        failed()
        xid = GdkX11.X11Surface.get_xid(window.get_surface())
        xdo("mousemove", "--window", xid, 3, window.get_height() - 3); self.settle(window)
        self.assertEqual(window.focus_key(), "s1")
        self.assertTrue(one.get_state_flags() & asb.Gtk.StateFlags.FOCUS_WITHIN)
        self.assertEqual((window.get_focus_visible(), one.has_css_class("asb-key-focus")), (False, False))
        self.assertFalse(one.get_state_flags() & asb.Gtk.StateFlags.PRELIGHT)
        shown = lambda card: (self.ink(card.asb_dot), self.ink(card.asb_read_button.get_child().get_last_child()) > 0,
                              self.ink(card.asb_drawer_button))
        self.assertEqual(shown(one), (255, False, 0))
        self.assertGreater(self.ink(one.asb_pin_button), 0)  # The pin rule of 1.5.0.
        # The keyboard makes the focus visible. Tab from the row goes to drawer, read, pin, with the controls shown.
        xdo("windowfocus", xid)
        xdo("key", "Up"); self.settle(window)
        self.assertIs(window.get_focus(), two)
        self.assertEqual((window.get_focus_visible(), two.has_css_class("asb-key-focus"), one.has_css_class("asb-key-focus")), (True, True, False))
        self.assertEqual((shown(one), shown(two)), ((255, False, 0), (0, True, 255)))
        for control in (two.asb_drawer_button, two.asb_read_button, two.asb_pin_button):
            xdo("key", "Tab"); self.settle(window)
            self.assertIs(window.get_focus(), control)
            self.assertEqual(shown(two), (0, True, 255))
        window.close(); self.drain(.03)


if __name__ == "__main__":
    unittest.main()
