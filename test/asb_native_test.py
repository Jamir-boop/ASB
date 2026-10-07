"""Small native view checks. Session opens use a disposable mock server."""
import copy
import ctypes
import ctypes.util
import importlib.util
import json
import os
import queue
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
         "state": "waiting", "canOpen": True, "updatedAtMs": NOW - 120_000, "pending": True, "pendingSource": "user-action"},
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
        pending = index < 12 or manual
        provider = "claude-desktop-code" if index % 3 == 1 else "codex"
        rows.append({"id": f"sample-{index}", "provider": provider, "providerLabel": "Claude Desktop Code" if provider != "codex" else "Codex",
                     "title": titles[index // 8] + parts[index % 8], "cwd": "/example/" + ["ASB", "Tools", "Notes"][index % 3],
                     "projectName": ["ASB", "Tools", "Notes"][index % 3], "state": state, "canOpen": True,
                     "pending": pending, "unread": (pending and state != "waiting") or index == 15, "manualUnread": manual,
                     "nativeUnread": True if index == 15 else None,
                     "nativeAttention": index == 15,
                     "pendingSource": "manual-unread" if manual else "user-action" if state == "waiting" else "observed-completion" if pending else "",
                     "questionPending": index == 0, "questionAttention": index == 0,
                     "readStatus": "read" if index == 0 else "unread" if index == 15 else "unknown", "updatedAtMs": NOW - index * 60_000})
    return {"generatedAtMs": NOW, "providers": [], "threads": rows}


class DataChecks(unittest.TestCase):
    def test_working_duration_uses_known_current_start_only(self):
        row = {"state": "working", "workingSinceMs": NOW - 133_000}
        self.assertEqual(asb.working_duration(row, NOW), "2m13s")
        self.assertEqual(asb.working_duration(row, NOW + 2_000), "2m15s")
        self.assertEqual(asb.working_duration({**row, "pending": True, "manualUnread": True}, NOW), "2m13s")
        for seconds, expected in ((0, "0s"), (59, "59s"), (60, "1m0s"), (3723, "1h2m")):
            self.assertEqual(asb.working_duration({**row, "workingSinceMs": NOW - seconds * 1000}, NOW), expected)
        for start in (None, 0, -1, True, "unknown", NOW + 1, float("nan")):
            self.assertEqual(asb.working_duration({**row, "workingSinceMs": start}, NOW), "")
        for state in ("waiting", "idle", "unknown"):
            self.assertEqual(asb.working_duration({**row, "state": state}, NOW), "")

    def test_filters_state_order_pending_and_archive(self):
        self.assertEqual([row["id"] for row in asb.filtered_rows(FIXTURE)], ["second", "claude:local_mock", "first", "unknown"])
        self.assertEqual(len(asb.filtered_rows(FIXTURE, archived=True)), 5)
        for query, expected in [("SWITCHING", ["first"]), ("/example/Notes", ["claude:local_mock"]),
                                ("Claude Desktop", ["claude:local_mock"]), ("missing", [])]:
            self.assertEqual([row["id"] for row in asb.filtered_rows(FIXTURE, query=query)], expected)
        self.assertEqual([row["id"] for row in asb.filtered_rows(FIXTURE, app="codex", state="unknown")], ["unknown"])
        self.assertEqual([row["id"] for row in asb.filtered_rows(FIXTURE, pending_only=True)], ["second", "claude:local_mock"])
        self.assertIn("Pinned", asb.row_meta({**FIXTURE["threads"][0], "pinned": True}, NOW))
        self.assertIn("Archived", asb.row_meta(FIXTURE["threads"][-1], NOW))

    def test_column_capacity_and_unique_coverage(self):
        rows = mock_dashboard()["threads"]
        for width, expected in ((360, 1), (680, 2), (1040, 4)):
            columns, capacity, pages = asb.pack_columns(rows, width, 660)
            self.assertEqual(columns, expected)
            self.assertEqual(capacity, 29)
            self.assertEqual([row["id"] for column in pages for row in column], [row["id"] for row in rows])
            self.assertGreater(asb.pack_columns(rows, width, 800)[1], capacity)
        for width, columns in ((160, 6), (240, 4), (600, 1)):
            self.assertEqual(asb.pack_columns(rows, 1080, 245, width)[0], columns)
        self.assertEqual(asb.pack_columns(rows, 360, 700, 160)[0], 2)
        for height in (22, 68):
            columns, capacity, pages = asb.pack_columns(rows, 1040, 660, row_height=height)
            self.assertEqual(capacity, 656 // height)
            self.assertEqual([row["id"] for column in pages for row in column], [row["id"] for row in rows])

    def test_layout_width_validation_persistence_and_reset(self):
        with tempfile.TemporaryDirectory(prefix="asb-layout-test-") as directory:
            path = Path(directory) / "layout.json"
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact"})
            asb.write_layout(path, 160)
            self.assertEqual(asb.read_layout(path)["columnWidth"], 160)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            previous = path.read_bytes()
            for invalid in (159, 601, 240.5, "240", True):
                with self.assertRaises(ValueError):
                    asb.write_layout(path, invalid)
                self.assertEqual(path.read_bytes(), previous)
            asb.write_layout(path)
            self.assertFalse(path.exists())
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact"})

    def test_view_setting_legacy_width_save_and_reset(self):
        with tempfile.TemporaryDirectory(prefix="asb-view-test-") as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps({"version": 1, "columnWidth": 180}))
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "compact"})
            asb.write_layout(path, 180, "comfortable")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "comfortable"})
            asb.write_layout(path, 320)
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable"})
            asb.write_layout(path)
            self.assertTrue(path.exists())
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable"})
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                asb.write_layout(path, 240, "unknown")
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            asb.write_layout(path, 240, "compact")
            asb.write_layout(path)
            self.assertFalse(path.exists())

    def test_provider_prefixes(self):
        for prefix, provider in (("cl:", "claude-desktop-code"), ("claude:", "claude-desktop-code"),
                                 (" CL : ", "claude-desktop-code"), ("ClaUde: ", "claude-desktop-code"),
                                 ("cx:", "codex"), ("codex:", "codex"), (" CX : ", "codex"), ("CODEX:", "codex")):
            opposite = "codex" if provider == "claude-desktop-code" else "claude-desktop-code"
            selected = asb.filtered_rows(FIXTURE, query=prefix, app=opposite)
            self.assertTrue(selected)
            self.assertTrue(all(row["provider"] == provider for row in selected))
        self.assertEqual([row["id"] for row in asb.filtered_rows(FIXTURE, "CL: CHOOSE THE FOLDER")], ["claude:local_mock"])
        self.assertEqual([row["id"] for row in asb.filtered_rows(FIXTURE, "codex: /example/ASB", pending_only=True)], ["second"])
        self.assertEqual(len(asb.filtered_rows(FIXTURE, "cx:", archived=True)), 4)
        self.assertEqual(asb.filtered_rows(FIXTURE, "claude:", state="working"), [])
        literal = {"threads": [{**FIXTURE["threads"][0], "id": "literal", "title": "notes: <b>Literal title</b>"}]}
        self.assertEqual(asb.provider_query("notes: <b>"), ("notes: <b>", "all"))
        self.assertEqual(asb.filtered_rows(literal, "notes: <b>")[0]["id"], "literal")

    def test_combined_states_and_asb_pin_order(self):
        board = copy.deepcopy(FIXTURE)
        selected = asb.filtered_rows(board, state={"working", "idle"})
        self.assertEqual([row["id"] for row in selected], ["second", "first"])
        self.assertEqual(asb.filtered_rows(board, state=set()), [])
        self.assertEqual([row["id"] for row in asb.filtered_rows(board, state={"working", "idle"}, pending_only=True)], ["second"])
        board["threads"][0].update(pinned=True, pinIndex=1)
        board["threads"][2].update(pinned=True, pinIndex=0)
        self.assertEqual([row["id"] for row in asb.filtered_rows(board)], ["unknown", "first", "second", "claude:local_mock"])
        self.assertEqual([row["id"] for row in asb.filtered_rows(board, "cx:", state={"working", "idle"})], ["first", "second"])

    def test_theme_validation_atomic_save_and_reset(self):
        with tempfile.TemporaryDirectory(prefix="asb-theme-test-") as directory:
            path = Path(directory) / "asb" / "theme.json"
            self.assertIsNone(asb.read_theme(path))
            asb.write_theme(path, CUSTOM)
            self.assertEqual(asb.read_theme(path), CUSTOM)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            for invalid in ({**CUSTOM, "text": "#222222"}, {**CUSTOM, "background": "#ffffff"},
                            {**CUSTOM, "accent": "red"}, {**CUSTOM, "extra": "#ffffff"},
                            {**CUSTOM, "muted": "#222222"}, {**CUSTOM, "divider": "#171c22"}):
                with self.assertRaises(ValueError):
                    asb.write_theme(path, invalid)
                self.assertEqual(path.read_bytes(), before)
            low_highlight_contrast = {**CUSTOM, "text": "#888888", "accent": "#888888", "muted": "#888888"}
            self.assertGreaterEqual(asb.contrast("#888888", "#171c22"), 4.5)
            self.assertEqual(asb.highlight_color(low_highlight_contrast), "#282c31")
            with self.assertRaisesRegex(ValueError, "highlight"):
                asb.write_theme(path, low_highlight_contrast)
            self.assertEqual(path.read_bytes(), before)
            for key in ("text", "accent", "muted"):
                self.assertGreaterEqual(asb.contrast(CUSTOM[key], asb.highlight_color(CUSTOM)), 4.5)
            self.assertEqual(list(path.parent.iterdir()), [path])
            asb.write_theme(path)
            self.assertIsNone(asb.read_theme(path))

    def test_local_url_and_unfocused_refresh(self):
        self.assertEqual(asb.local_base_url("http://127.0.0.1:4629/"), "http://127.0.0.1:4629")
        for value in ["https://example.com", "http://localhost:4629", "http://127.0.0.1:4629/api", "http://u:p@127.0.0.1:4629"]:
            with self.assertRaises(ValueError):
                asb.local_base_url(value)
        calls = []
        sidebar = SimpleNamespace(closed=False, is_active=lambda: False, refresh=lambda: calls.append(True))
        self.assertTrue(asb.SwitchboardWindow.tick(sidebar))
        self.assertEqual(calls, [True])
        sidebar.closed = True
        self.assertFalse(asb.SwitchboardWindow.tick(sidebar))
        self.assertEqual(calls, [True])


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
                    self.assertEqual(content.get_first_child().get_pixel_size(), 14)
                    title = content.get_first_child().get_next_sibling()
                    self.assertFalse(title.get_wrap())
                    self.assertTrue(title.get_single_line_mode())
                    self.assertEqual(title.get_ellipsize(), asb.Pango.EllipsizeMode.END)
                    self.assertIn(row.asb_thread["cwd"], row.get_tooltip_text())
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
                self.assertEqual((dot.get_width(), dot.get_height()), (7, 7))
                self.assertFalse(native.asb_thread["pending"])
                self.assert_accessible_label(native, "Open Build pipeline · worker in Codex. Working. Unread in the original app.")
                self.assertIn("Marked as unread in ASB", window.focus_widgets["sample-12"].get_tooltip_text())
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
                self.assertEqual(window.count.get_text(), "4 sessions · 4 Pending")
                window.select_states(set(asb.STATES))
                window.app_filter.set_selected(2)
                self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
                window.app_filter.set_selected(0)
                window.search.set_text("/example/Notes")
                window.render()
                self.assertTrue(all(row["cwd"] == "/example/Notes" for row in window.visible_rows()))
                visible = window.visible_rows()
                self.assertEqual(window.count.get_text(), f"{len(visible)} sessions · {sum(bool(row.get('pending')) for row in visible)} Pending")
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
            self.assertIn("Original app unread state.", window.focus_widgets["first"].get_tooltip_text())
            self.assertNotIn("marks this session as read", window.focus_widgets["first"].get_tooltip_text())
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
            marked = []
            window.mark_unread = marked.append
            window.activate_action("win.mark-unread", asb.GLib.Variant("s", "unknown"))
            self.assertEqual(marked, ["unknown"])
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
            self.assertLessEqual(window.window_handle.get_height(), 34)
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
            def request(_base, route, callback, _dispatch, method="GET", body=None):
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
                self.assertIn("Cannot open", window.focus_widgets["sample-15"].get_tooltip_text())
                self.assertFalse(window.notice.get_visible())
                self.assertEqual((window.window_handle.get_height(), window.scroll.get_height()), geometry)

                window.loading = True
                window.mark_unread("sample-15")
                calls[-1][1]({"marked": True}, None)
                self.assertTrue(window.refresh_queued)
                count = len(calls)
                window.apply_dashboard(changed, None)
                self.drain()
                self.assertEqual(len(calls), count + 1)
                self.assertEqual(calls[-1][0], "/api/dashboard?force=1")
                marked = copy.deepcopy(changed)
                marked["threads"][15].update(manualUnread=True, unread=True, pending=True, pendingSource="manual-unread")
                calls[-1][1](marked, None)
                self.drain()
                self.assertTrue(window.focus_widgets["sample-15"].asb_thread["manualUnread"])
                self.assertFalse(window.refresh_queued)

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
                        row.update(retainedUnread=True, retainedUnreadSource="native-unread", unread=True,
                                   nativeUnread=False, nativeAttention=False, readStatus="read")
                    result = {"changed": True, "persistentUnread": body["persistentUnread"], "dashboard": dashboard}
                    self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(result).encode())
                    return
                identity, action = self.path.split("/")[-2:]
                row = next(row for row in dashboard["threads"] if row["id"] == identity)
                if action == "mark-unread":
                    row.update(manualUnread=True, unread=True, pending=True, pendingSource="manual-unread")
                    result = {"marked": True, "thread": row}
                elif action == "mark-read":
                    row.update(manualUnread=False, retainedUnread=False, unread=False, pending=False, pendingSource="")
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
            self.assertIn("ASB retained", row.get_tooltip_text())
            self.assert_accessible_label(row, row.asb_accessible_label)
            self.assertIn("Unread retained in ASB", row.asb_accessible_label)
            dot = next(widget for widget in descendants(row) if widget.has_css_class("asb-dot"))
            self.assertEqual((dot.get_width(), dot.get_height()), (7, 7))
        window.view_filter.set_selected(0); self.drain()
        activate("sample-15", "Read")
        self.assertFalse(window.focus_widgets["sample-15"].asb_thread["retainedUnread"])
        self.assertEqual(window.focus_widgets["sample-15"].asb_thread["state"], "working")
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
                    self.assertIn("/example/Tools", card.get_tooltip_text())
                    if mode == "comfortable":
                        self.assertEqual(card.get_child().get_orientation(), asb.Gtk.Orientation.VERTICAL)
                        top = card.get_child().get_first_child()
                        self.assertEqual(top.get_first_child().get_icon_name(), "asb-claude-symbolic")
                        self.assertEqual(top.get_first_child().get_next_sibling().get_text(), "Tools")
                        self.assertEqual(top.get_last_child().get_icon_name(), "view-pin-symbolic")
                        self.assertTrue(title.get_wrap())
                        self.assertEqual(title.get_lines(), 2)
                        self.assertEqual(title.get_height(), 32)
                        self.assertEqual(title.get_ellipsize(), asb.Pango.EllipsizeMode.END)
                        metadata = window.focus_widgets["sample-15"].get_child().get_last_child()
                        self.assertTrue(metadata.get_first_child().has_css_class("asb-dot"))
                        self.assertEqual(metadata.get_first_child().get_next_sibling().get_text(), "Working")
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
                        self.assertLessEqual(row.get_child().get_last_child().get_allocated_width(), row.get_allocated_width())
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
                    self.assertIn("Cannot open", window.focus_widgets["sample-10"].get_tooltip_text())
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
        found, bar_bounds = window.scroll.get_hscrollbar().compute_bounds(window.scroll)
        self.assertTrue(found)
        for row in rows:
            self.assertEqual(row.get_height(), 68)
            found, bounds = row.compute_bounds(window.scroll)
            self.assertTrue(found)
            self.assertLessEqual(bounds.origin.y + bounds.size.height, bar_bounds.origin.y + 1)
        adjustment = window.scroll.get_hadjustment()
        vertical = window.scroll.get_vadjustment()
        self.assertAlmostEqual(vertical.get_upper(), vertical.get_page_size(), delta=1)
        self.assertEqual([row.asb_thread["id"] for row in self.widget_rows(window)], window.row_order)
        self.assertEqual(len(set(window.row_order)), 106)
        self.assertEqual(window.actual_columns, (106 + window.capacity - 1) // window.capacity)
        self.assertGreater(adjustment.get_upper(), adjustment.get_page_size())
        adjustment.set_value(0)
        self.assertTrue(window.scroll_horizontal(None, 0, 1))
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


if __name__ == "__main__":
    unittest.main()
