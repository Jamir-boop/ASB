"""Small native view checks. Session opens use a disposable mock server."""
import copy
import ctypes
import ctypes.util
import gc
import importlib.util
import json
import os
import queue
import random
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
    "persistentUnread": False,
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


GTK_WARNINGS = []


def keep_gtk_warnings(level, fields, n_fields, user_data):
    # GLib allows one writer for the process; the default writer still prints each message.
    if int(level) & 28:
        GTK_WARNINGS.extend(ctypes.string_at(field.value).decode(errors="replace") for field in fields[:n_fields] if field.key == "MESSAGE")
    return asb.GLib.log_writer_default(level, fields, user_data)


asb.GLib.log_set_writer_func(keep_gtk_warnings, None)


def board_children(column):
    cards, card = [], column.get_first_child()
    while card:
        cards.append(card)
        card = card.get_next_sibling()
    return cards


def board_listed(column):
    cards, card = [], column.get_row_at_index(0)
    while card is not None:
        cards.append(card)
        card = column.get_row_at_index(len(cards))
    return cards


def board_rows(count):
    return [{"id": f"s{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Sample session {n}",
             "cwd": f"/example/project-{n % 9}", "projectName": f"project-{n % 9}", "state": "working" if n < 6 else "idle",
             "canOpen": True, "updatedAtMs": NOW - n * 600_000, "readStatus": "unknown",
             "workingSinceMs": NOW - n * 900_000 if n < 6 else 0, "pending": 6 <= n < 20, "unread": 6 <= n < 20} for n in range(count)]


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
    return {"generatedAtMs": NOW, "providers": [], "threads": rows, "persistentUnread": False}


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
        cls.gtk_state = ctypes.CDLL(ctypes.util.find_library("gtk-4")).gtk_test_accessible_check_state
        cls.gtk_state.argtypes = (ctypes.c_void_p, ctypes.c_int)
        cls.gtk_state.restype = ctypes.c_void_p
        cls.g_free = ctypes.CDLL(ctypes.util.find_library("glib-2.0")).g_free
        cls.g_free.argtypes = (ctypes.c_void_p,)

    def setUp(self):
        settings = asb.Gtk.Settings.get_default()
        self.addCleanup(settings.set_property, "gtk-font-name", settings.get_property("gtk-font-name"))
        # Exact pixel checks use one font; the font-height test checks other metrics.
        settings.set_property("gtk-font-name", "Cantarell 11")
        # mock_dashboard() has more rows than the card limit; the limit test sets the real limit again.
        for target, name in ((asb, "DEFAULT_CARD_LIMIT"), (asb.SwitchboardWindow, "card_limit")):
            patcher = patch.object(target, name, 0)
            patcher.start()
            self.addCleanup(patcher.stop)

    def assert_accessible_label(self, widget, expected, prop=None):
        # GTK's exact property check is variadic and is not exposed by PyGObject.
        prop = asb.Gtk.AccessibleProperty.LABEL if prop is None else prop
        error = self.gtk_check(self.capsule_pointer(widget.__gpointer__, None), int(prop),
                               ctypes.c_char_p(expected.encode()))
        if error:
            message = ctypes.string_at(error).decode()
            self.g_free(error)
            self.fail(message)

    def assert_accessible_disabled(self, widget, expected):
        error = self.gtk_state(self.capsule_pointer(widget.__gpointer__, None), int(asb.Gtk.AccessibleState.DISABLED), ctypes.c_int(expected))
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

    @staticmethod
    def hover_card(window, card, inside):
        # The same method that the motion controller of the card calls on notify::contains-pointer.
        window.row_hover(SimpleNamespace(contains_pointer=lambda: inside, get_widget=lambda: card))

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

    def test_toolbar_c_one_row_corners_search_filters_and_no_counters(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        with tempfile.TemporaryDirectory(prefix="asb-toolbar-c-") as temporary:
            path = Path(temporary) / "layout.json"
            dashboard = mock_dashboard()
            dashboard.pop("persistentUnread")
            dashboard["threads"][30].update(drawer=True, unread=False, pending=False)
            window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                          theme_path=False, layout_path=path)
            self.addCleanup(window.close)
            window.present(); window.set_focus(None); self.drain(.3)
            border_width = window.get_default_size().width - window.get_width()
            self.assertTrue(window.persistent_unread.get_active())
            self.assertFalse(window.show_app_pills)
            self.assertTrue(all(not pill.get_visible() for pill in window.app_pills.values()))
            window.app_filter.set_selected(1)
            window.select_states({"idle", "waiting"})
            window.archive.set_active(True)
            self.assertEqual(window.filter_chip_widgets["states"][1].get_text(), "Waiting, Idle")
            window.app_pills_setting.set_active(True)
            self.assertFalse(window.filter_chip_widgets["app"][0].get_visible())
            for width in (320, 420, 680, 1182, 280):
                with self.subTest(width=width):
                    window.set_default_size(width + border_width, 400); self.drain(.3); window.check_geometry(); self.drain(.1)
                    self.assertEqual(window.get_width(), width)
                    current_height = window.window_handle.get_height()
                    pills = [*window.app_pills.values(), window.pending_only, window.working_only, window.drawer_only,
                             *(chip for chip, _name in window.filter_chip_widgets.values())]
                    controls = [*pills, window.menu_button, window.window_controls]
                    controls += [window.search, window.refresh_button] if width >= 680 else [window.search_button]
                    tallest = max(control.measure(asb.Gtk.Orientation.VERTICAL, -1)[1]
                                  for control in controls if control.get_visible())
                    self.assertLessEqual(current_height, tallest + window.tools.get_margin_top() + window.tools.get_margin_bottom())
                    row_positions = []
                    for pill in pills:
                        if pill.get_visible():
                            found, bounds = pill.compute_bounds(window.toolbar_strip)
                            self.assertTrue(found)
                            row_positions.append(round(bounds.origin.y))
                    self.assertEqual(len(set(row_positions)), 1)
                    self.assertFalse(hasattr(window, "count"))
                    self.assertFalse(hasattr(window, "feedback"))
                    self.assertEqual(window.pending_only.get_label(), "Pending")
                    self.assertEqual(window.working_only.get_label(), "Working")
                    self.assertTrue(window.drawer_dot.get_visible())
                    self.assertFalse(isinstance(window.drawer_dot, asb.Gtk.Label))
                    self.assertEqual(window.app_mark.get_visible(), width >= 320)
                    self.assertEqual(window.search_button.get_visible(), 320 <= width < 680)
                    self.assertEqual(window.drawer_label.get_visible(), width >= 680)
                    self.assertTrue(all(icon.get_visible() == (width < 680) for icon in window.app_pill_icons.values()))
                    found, before = window.toolbar_end.compute_bounds(window.tools)
                    self.assertTrue(found)
                    self.assertLessEqual(abs(before.origin.x + before.size.width - window.tools.get_width()), 1)
                    window.open_search_from_preferences(); self.drain(.1)
                    self.assertTrue(window.search.get_mapped())
                    self.assertTrue(window.search.has_focus() or window.get_focus().is_ancestor(window.search))
                    window.search.set_text("cx: example")
                    if window.wide_controls:
                        self.assertTrue(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
                    else:
                        window.search.emit("stop-search")
                    self.drain(.1)
                    self.assertEqual(window.search.get_text(), "")
                    self.assertEqual((window.apps, window.states, window.archive.get_active()), ({"codex"}, {"idle", "waiting"}, True))
                    found, after = window.toolbar_end.compute_bounds(window.tools)
                    self.assertTrue(found)
                    self.assertEqual((round(before.origin.x), round(before.origin.y)), (round(after.origin.x), round(after.origin.y)))
            window.working_only.set_active(True)
            self.assertEqual(window.states, {"working"})
            self.assertFalse(window.filter_chip_widgets["states"][0].get_visible())
            window.working_only.set_active(False)
            self.assertEqual(window.states, set(asb.STATES))
            window.select_states({"idle", "waiting"})
            state_chip = window.filter_chip_widgets["states"][0]
            state_chip.grab_focus(); self.drain(.1)
            self.assertGreater(window.toolbar_scroll.get_hadjustment().get_value(), 0)
            state_chip.emit("clicked"); self.drain(.1)
            self.assertEqual(window.states, set(asb.STATES))
            self.assertIsNot(window.get_focus(), state_chip)
            window.app_pills_setting.set_active(False)
            self.assertEqual(window.apps, {"codex"})
            self.assertTrue(window.app_pills["codex"].get_active())
            self.assertTrue(window.filter_chip_widgets["app"][0].get_visible())
            window.filter_chip_widgets["app"][0].emit("clicked")
            self.assertEqual(window.apps, set())
            window.filter_chip_widgets["archive"][0].emit("clicked")
            self.assertFalse(window.archive.get_active())
            window.reset_width()
            self.assertFalse(asb.read_layout(path)["showAppPills"])
            window.view_filter.set_selected(1)
            self.assertFalse(asb.read_layout(path)["showAppPills"])

    def test_profiles_show_remote_claude_sessions_only_for_claude_and_save_the_choice(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
        preferences.stack.set_visible_child_name("profiles"); self.drain(.1)
        editor = preferences.profiles_editor
        sources = [{"id": "codex", "provider": "codex", "label": "Personal", "enabled": True, "builtin": True,
                    "dataDir": "/example/profiles/codex", "launcher": "", "color": "#8296b4", "showMarker": True,
                    "sessionCount": 5, "status": "ok"},
                   {"id": "studio", "provider": "claude-desktop-code", "label": "Studio", "enabled": True,
                    "dataDir": "/example/profiles/studio", "launcher": "/example/apps/studio.desktop",
                    "projectsDir": "/example/transcripts", "color": "#b28f80", "showMarker": True,
                    "sessionCount": 3, "status": "ok", "remoteClaude": "native"}]
        requests[-1][1]({"sources": sources, "maxSources": 8}, None)
        transcript, remote = editor.transcript_widgets
        # The field follows Transcript folder and has the caption, the dropdown, and the note.
        self.assertIs(transcript.get_next_sibling(), remote)
        self.assertIs(editor.remote_claude.get_ancestor(asb.Gtk.Box).get_parent(), remote)
        self.assertIs(remote.get_last_child(), editor.remote_claude_note)
        self.assert_accessible_label(editor.remote_claude, "Remote Claude sessions")
        editor.table.select_row(editor.table.get_row_at_index(1)); self.drain(.1)
        self.assertTrue(remote.get_visible())
        self.assertEqual(editor.remote_claude.get_selected(), 2)
        self.assertEqual(editor.remote_claude_note.get_label(), asb.REMOTE_CLAUDE[2][2])
        self.assertFalse(editor.is_dirty())
        editor.remote_claude.set_selected(1); self.drain(.05)
        self.assertEqual(editor.remote_claude_note.get_label(), asb.REMOTE_CLAUDE[1][2])
        self.assert_accessible_label(editor.remote_claude, asb.REMOTE_CLAUDE[1][2], asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.assertTrue(editor.is_dirty())
        editor.save_button.emit("clicked")
        self.assertEqual((requests[-1][0], requests[-1][2], requests[-1][3]["source"]["remoteClaude"]), ("/api/sources", "POST", "bridge"))
        requests[-1][1]({"sources": [sources[0], {**sources[1], "remoteClaude": "bridge"}], "maxSources": 8}, None); self.drain(.1)
        editor.table.select_row(editor.table.get_row_at_index(0)); self.drain(.1)
        self.assertFalse(remote.get_visible())
        self.assertEqual(editor.remote_claude.get_selected(), 0)
        self.assertEqual(editor.remote_claude_note.get_label(), asb.REMOTE_CLAUDE[0][2])
        editor.save_button.emit("clicked")
        self.assertEqual((requests[-1][2], requests[-1][3]["source"]["provider"]), ("POST", "codex"))
        self.assertNotIn("remoteClaude", requests[-1][3]["source"])
        requests[-1][1]({"sources": sources, "maxSources": 8}, None); self.drain(.1)

    def test_preferences_sections_reuse_lazy_profiles_theme_and_narrow_layout(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None):
            if route != "/api/palette":  # The window shares its palette at start; this test checks the other requests.
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        preferences = window.preferences_window
        self.assertFalse(preferences.get_visible())
        self.assertIsNone(preferences.profiles_editor)
        self.assertEqual(requests, [])
        window.menu_button.emit("clicked"); self.drain(.2)
        self.assertEqual((preferences.get_width(), preferences.get_height()), (780, 560))
        self.assertIs(preferences.get_transient_for(), window)
        self.assertTrue(preferences.get_destroy_with_parent())
        self.assertFalse(preferences.get_modal())
        self.assertTrue(preferences.sidebar.get_visible())
        self.assertFalse(preferences.tabs_scroll.get_visible())
        self.assert_accessible_label(window.menu_button, "Open Preferences")
        window.open_preferences()
        self.assertEqual(sum(isinstance(item, asb.PreferencesWindow) for item in self.application.get_windows()), 1)
        window.app_pills["codex"].set_active(True)
        self.assertEqual(window.app_filter.get_selected(), 1)
        window.app_filter.set_selected(2)
        self.assertTrue(window.app_pills["claude-desktop-code"].get_active())
        window.working_only.set_active(True)
        self.assertEqual(window.states, {"working"})
        self.assertTrue(window.state_checks["working"].get_active())
        window.select_states(set(asb.STATES))
        window.app_filter.set_selected(0)
        window.sync_unread_setting(True)
        self.assertTrue(window.persistent_unread.get_active())
        self.assertEqual(requests, [])
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        def capture(name):
            self.drain(.15)
            if output:
                self.capture(preferences, Path(output) / ("native-preferences-" + name + ".png"))
        capture("sessions-wide")
        preferences.stack.set_visible_child_name("appearance")
        self.assertEqual(requests, [])
        capture("appearance-wide")
        preferences.stack.set_visible_child_name("profiles"); self.drain(.1)
        self.assertEqual([item[0] for item in requests], ["/api/sources"])
        editor = preferences.profiles_editor
        sources = [{"id": "codex", "provider": "codex", "label": "Personal", "enabled": True, "builtin": True,
                    "dataDir": "/example/profiles/codex", "launcher": "", "color": "#8296b4", "showMarker": True,
                    "sessionCount": 5, "status": "ok"},
                   {"id": "studio", "provider": "claude-desktop-code", "label": "Studio", "enabled": False,
                    "dataDir": "/example/profiles/studio", "launcher": "/example/apps/studio.desktop",
                    "projectsDir": "/example/transcripts", "color": "#b28f80", "showMarker": False,
                    "sessionCount": 3, "status": "disabled"},
                   {"id": "opencode", "provider": "opencode", "label": "OpenCode", "enabled": True, "builtin": True,
                    "dataDir": "/example/profiles/opencode", "launcher": "", "color": "#899e91", "showMarker": True,
                    "sessionCount": 2, "status": "ok"}]
        requests[-1][1]({"sources": sources, "maxSources": 8}, None)
        self.assertFalse(editor.provider.get_sensitive())
        self.assertFalse(editor.remove_button.get_sensitive())
        editor.table.select_row(editor.table.get_row_at_index(2))
        self.assertEqual((editor.provider.get_visible(), editor.provider_text.get_visible(), editor.provider_text.get_label()),
                         (False, True, "OpenCode"))
        self.assertEqual((editor.data_dir.get_editable(), editor.launcher.get_editable()), (False, False))
        self.assertTrue(all(not button.get_sensitive() for button in editor.choose_buttons))
        self.assertFalse(any(widget.get_visible() for widget in editor.transcript_widgets))
        editor.table.select_row(editor.table.get_row_at_index(0))
        self.assertEqual((editor.provider.get_visible(), editor.provider_text.get_visible(), editor.data_dir.get_editable()),
                         (True, False, True))
        self.assertTrue(all(button.get_sensitive() for button in editor.choose_buttons))
        capture("profiles-wide")
        editor.add_source()
        editor.name.set_text("Draft profile")
        self.assertIs(editor.name.get_root(), preferences)
        self.assertEqual(window.search.get_text(), "")
        preferences.stack.set_visible_child_name("sessions")
        preferences.stack.set_visible_child_name("profiles")
        self.assertIs(preferences.profiles_editor, editor)
        self.assertEqual(editor.name.get_text(), "Draft profile")
        self.assertEqual(len(requests), 2)
        requests[-1][1]({"sources": sources, "maxSources": 8}, None)
        self.assertEqual(editor.name.get_text(), "Draft profile")
        preferences.close(); self.drain(.1)
        self.assertTrue(window.get_visible())
        self.assertFalse(window.closed)
        self.assertFalse(preferences.get_visible())
        self.assertTrue(editor.cancellable.is_cancelled())
        window.open_preferences(); self.drain(.1)
        self.assertIs(window.preferences_window, preferences)
        self.assertEqual(editor.name.get_text(), "Draft profile")
        self.assertEqual(len(requests), 3)
        requests[-1][1]({"sources": sources, "maxSources": 8}, None)
        self.assertEqual(editor.name.get_text(), "Draft profile")
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertEqual(preferences.get_width(), 420)
        self.assertFalse(preferences.sidebar.get_visible())
        self.assertTrue(preferences.tabs_scroll.get_visible())
        capture("profiles-narrow")
        preferences.stack.set_visible_child_name("sessions"); self.drain(.2)
        self.assertEqual(preferences.get_width(), 420)
        capture("sessions-narrow")
        preferences.stack.set_visible_child_name("appearance"); self.drain(.2)
        self.assertEqual(preferences.get_width(), 420)
        window.set_theme_pickers(CUSTOM)
        window.theme_mode.set_selected(1)
        window.apply_theme()
        self.assertTrue(window.has_css_class("asb-custom"))
        self.assertTrue(preferences.has_css_class("asb-custom"))
        capture("custom-narrow")
        window.reset_theme()
        self.assertFalse(window.has_css_class("asb-custom"))
        self.assertFalse(preferences.has_css_class("asb-custom"))
        preferences.stack.set_visible_child_name("sessions")
        window.persistent_unread.set_active(False)
        self.assertEqual(requests[-1][0], "/api/settings/unread")
        unread_callback = requests[-1][1]
        preferences.close()
        unread_callback({"persistentUnread": False, "dashboard": copy.deepcopy(FIXTURE)}, None)
        self.assertTrue(window.persistent_unread.get_sensitive())
        self.assertFalse(window.persistent_unread.get_active())
        window.open_preferences()
        self.assertEqual(sum(route == "/api/sources" for route, *_args in requests), 3)
        editor.reload_sources()
        callback = requests[-1][1]
        window.close(); self.drain(.1)
        self.assertTrue(preferences.closed)
        self.assertTrue(editor.closed)
        self.assertTrue(editor.cancellable.is_cancelled())
        self.assertFalse(callback({"sources": []}, None))
        self.assertEqual(editor.sources, sources)

    def test_preferences_machines_page_flows_dialogs_timer_and_narrow_tabs(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        fingerprint = "3f9a2c71e0b4d58a6c13f7e29b0d4a8851c6e3f70a9b2d4e8c1f5a7b3e6d9c20"
        link = ("asb://join?v=1&g=7d2e91c4b06fa358&a=lan:192.168.1.10,zerotier:10.147.20.12&p=4630"
                f"&f={fingerprint}&c=Q3vX9kR2mT7wLp4sN8bYc1HfDj6Ga0Ze5Uo&n=atlas")
        own = {"machineId": "3f9a2c71e0b4d58a", "name": "atlas"}
        laptop = {"machineId": "8c41e9d27b3a05f6", "name": "laptop", "online": True, "lastOkAtMs": NOW, "isSelf": False,
                  "addresses": [{"kind": "lan", "address": "192.168.1.24"}, {"kind": "zerotier", "address": "10.147.20.31"}]}
        studio = {"machineId": "51b7f0aa3c8e2d9b", "name": "studio", "online": False, "lastOkAtMs": 0, "isSelf": False,
                  "addresses": [{"kind": "zerotier", "address": "10.147.20.77"}]}
        alone = {"groupId": "", "self": own, "networkEnabled": True, "members": [], "phones": []}
        grouped = {"groupId": "7d2e91c4b06fa358", "self": own, "networkEnabled": True, "phones": [{"name": "Pixel 8"}],
                   "members": [{**own, "isSelf": True, "online": True, "lastOkAtMs": NOW, "addresses": []}, laptop, studio]}
        def reply(value, route="/api/group", method="GET", body=None):
            self.assertEqual(requests[-1][0::2] + (requests[-1][3],), (route, method, body))
            requests[-1][1](copy.deepcopy(value), None)
            self.drain(.05)
        def routes():
            return [item[0] for item in requests]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        preferences = window.preferences_window
        window.open_preferences(); self.drain(.2)
        preferences.stack.set_visible_child_name("phone"); self.drain(.1)
        self.assertIsNone(preferences.machines_editor)
        self.assertNotIn("/api/group", routes())
        preferences.stack.set_visible_child_name("machines"); self.drain(.1)
        editor = preferences.machines_editor
        self.assertIsNotNone(editor)
        self.assertEqual(routes()[-1], "/api/group")
        self.assertFalse(editor.body.get_visible())
        self.assertEqual(editor.message.get_label(), "Loading the machine group…")
        requests[-1][1](None, "Cannot load or change the machine group. Check that ASB is running, then try again.")
        self.assertTrue(editor.retry.get_visible())
        editor.retry.emit("clicked")
        reply(alone)
        self.assertTrue(editor.body.get_visible())
        self.assertFalse(editor.retry.get_visible())
        self.assertFalse(editor.message.get_visible())
        self.assertEqual((editor.self_row.get_title(), editor.self_row.get_subtitle()), ("atlas", "ID 3f9a2c71"))
        self.assertEqual([widget.get_visible() for widget in (editor.off, editor.alone, editor.others_heading, editor.others,
                                                              editor.phones, editor.join_open, editor.leave_button)],
                         [False, True, False, False, False, True, False])
        self.assertTrue(editor.add_button.get_sensitive() and editor.join_open.get_sensitive())
        self.assertEqual(self.poll_calls.call_args.args[:2], (5, editor.poll))
        count = len(requests)
        with patch.object(asb.GLib, "source_remove") as remove:
            editor.poll_timer = 77
            preferences.stack.set_visible_child_name("sessions"); self.drain(.1)
        remove.assert_called_once_with(77)
        self.assertIsNone(editor.poll_timer)
        self.assertEqual(len(requests), count)
        preferences.stack.set_visible_child_name("machines"); self.drain(.1)
        self.assertEqual(self.poll_calls.call_args.args[:2], (5, editor.poll))
        reply(grouped)
        self.assertEqual([widget.get_visible() for widget in (editor.off, editor.alone, editor.others_heading, editor.others,
                                                              editor.empty, editor.phones, editor.join_open, editor.leave_button)],
                         [False, False, True, True, False, True, False, True])
        rows = [editor.others.get_row_at_index(index) for index in range(2)]
        self.assertIsNone(editor.others.get_row_at_index(2))
        self.assertEqual([(row.get_title(), row.get_subtitle(), row.has_css_class("dim-label")) for row in rows],
                         [("laptop", "Online · ID 8c41e9d2\n192.168.1.24 (Home network) · 10.147.20.31 (ZeroTier)", False),
                          ("studio", "Offline · ID 51b7f0aa\n10.147.20.77 (ZeroTier)", True)])
        self.assertEqual(editor.phones.get_label(),
                         "Phones in the group: Pixel 8. A phone paired on one machine works with all of them.")
        self.assert_accessible_label(editor.remove_buttons[1], "Remove studio")
        self.assertTrue(editor.leave_button.has_css_class("destructive-action"))
        # A poll with the same rows keeps them, so a focused Remove button keeps the focus.
        focused = editor.remove_buttons[1]
        self.assertTrue(focused.grab_focus())
        editor.poll()
        reply(grouped)
        self.assertIs(editor.remove_buttons[1], focused)
        self.assertIs(preferences.get_focus(), focused)
        editor.poll()
        reply({**grouped, "members": [grouped["members"][0], {**laptop, "online": False, "lastOkAtMs": int(time.time() * 1000)}, studio]})
        row = editor.others.get_row_at_index(0)
        self.assertEqual(row.get_subtitle(), "Offline · last seen Just now · ID 8c41e9d2\n"
                                             "192.168.1.24 (Home network) · 10.147.20.31 (ZeroTier)")
        self.assertTrue(row.has_css_class("dim-label"))
        editor.poll()
        self.assertEqual(routes()[-1], "/api/group")
        reply({**grouped, "members": grouped["members"][:2]})
        self.assertTrue(editor.empty.get_visible() is False and editor.others.get_row_at_index(1) is None)
        editor.request_group()
        reply({**grouped, "members": grouped["members"][:1]})
        self.assertEqual((editor.empty.get_visible(), editor.others.get_visible()), (True, False))

        # Network off: the actions are off and the button opens Phone.
        preferences.stack.set_visible_child_name("sessions"); self.drain(.05)
        preferences.stack.set_visible_child_name("machines"); self.drain(.05)
        reply({**alone, "networkEnabled": False})
        self.assertTrue(editor.off.get_visible())
        self.assertEqual((editor.add_button.get_sensitive(), editor.join_open.get_sensitive()), (False, False))
        count = len(requests)
        editor.add_button.emit("clicked")
        self.assertEqual(len(requests), count)
        editor.off.get_last_child().emit("clicked"); self.drain(.1)
        self.assertEqual(preferences.stack.get_visible_child_name(), "phone")
        self.assertFalse(editor.active)

        # Invite: the panel replaces the actions until a new machine joins or the link expires.
        preferences.stack.set_visible_child_name("machines"); self.drain(.05)
        reply(alone)
        expires = int(time.time() * 1000) + 600_000
        editor.add_button.emit("clicked")
        reply({"link": link, "fingerprint": fingerprint, "expiresAtMs": expires}, "/api/group/invite", "POST", {})
        self.assertEqual((editor.invite_box.get_visible(), editor.actions.get_visible()), (True, False))
        self.assertEqual(editor.link.get_label(), link)
        self.assertEqual(editor.own_fingerprint.get_label(), asb.group_fingerprint(fingerprint))
        self.assertEqual(editor.invite_help.get_label(), asb.machine_invite_text(expires))
        self.assertEqual((editor.qr.get_visible(), editor.qr_help.get_visible()),
                         (asb.qr_matrix(link) is not None, asb.qr_matrix(link) is None))
        self.assert_accessible_label(editor.qr, "Machine join QR code")
        self.assertEqual(editor.qr_help.get_label(),
                         "Install the Python qrcode module and PyGObject cairo support. Run asb doctor for the command.")
        self.assert_accessible_label(editor.own_fingerprint, "Certificate fingerprint")
        editor.poll()
        reply({**grouped, "members": grouped["members"][:1]})
        self.assertTrue(editor.invite_box.get_visible())
        editor.poll()
        reply({**grouped, "members": grouped["members"][:2]})
        self.assertEqual((editor.invite_box.get_visible(), editor.actions.get_visible()), (False, True))
        self.assertEqual(editor.message.get_label(), "Joined: laptop")
        editor.request_group()
        reply(alone)
        editor.add_button.emit("clicked")
        reply({"link": link, "fingerprint": fingerprint, "expiresAtMs": expires}, "/api/group/invite", "POST", {})
        count = len(requests)
        with patch.object(asb.time, "time", return_value=expires / 1000):
            editor.poll()
        self.assertEqual(len(requests), count)
        self.assertFalse(editor.invite_box.get_visible())
        self.assertEqual(editor.message.get_label(), "This join link has expired. Select Add a machine to make a new one.")

        # Join: no request until Join, and an error keeps the panel and its text.
        editor.join_open.emit("clicked")
        self.assertEqual((editor.join_box.get_visible(), editor.actions.get_visible()), (True, False))
        self.assertEqual(len(requests), count)
        self.assertEqual(editor.join_name.get_text(), "atlas")
        editor.join_link.set_text("https://example.com/not-a-link")
        self.assertEqual((editor.not_link.get_visible(), editor.compare.get_visible()), (True, False))
        self.assertFalse(editor.join_button.get_sensitive())
        editor.join_link.set_text(link + "\n")
        self.assertEqual((editor.not_link.get_visible(), editor.compare.get_visible()), (False, True))
        self.assertEqual(editor.compare_heading.get_label(), "Does atlas show this fingerprint?")
        self.assertEqual(editor.inviter_fingerprint.get_label(), asb.group_fingerprint(fingerprint))
        self.assertFalse(editor.same.get_active())
        self.assertFalse(editor.join_button.get_sensitive())
        editor.same.set_active(True)
        self.assertTrue(editor.join_button.get_sensitive())
        editor.join_name.set_text("bad name")
        self.assertFalse(editor.join_button.get_sensitive())
        editor.join_name.set_text(" laptop ")
        self.assertTrue(editor.join_button.get_sensitive())
        self.assertEqual(len(requests), count)
        editor.join_button.emit("clicked")
        self.assertEqual(requests[-1][2:], ("POST", {"link": link, "name": "laptop"}))
        self.assertFalse(editor.join_button.get_sensitive())
        requests[-1][1](None, "This name is taken. Try the name laptop-2.")
        self.assertTrue(editor.join_box.get_visible())
        self.assertEqual((editor.join_link.get_text(), editor.join_name.get_text()), (link + "\n", " laptop "))
        self.assertEqual(editor.message.get_label(), "This name is taken. Try the name laptop-2.")
        self.assertTrue(editor.join_button.get_sensitive())
        editor.join_link.set_text(link)
        self.assertFalse(editor.same.get_active())
        editor.same.set_active(True)
        editor.join_button.emit("clicked")
        reply({"joined": True}, "/api/group/join", "POST", {"link": link, "name": "laptop"})
        self.assertFalse(editor.join_box.get_visible())
        reply(grouped)
        self.assertEqual(editor.message.get_label(), "Joined the group of atlas.")

        # Remove and Leave ask first; Cancel sends nothing.
        for button, heading, response, route, body in (
                (editor.remove_buttons[1], "Remove studio?", "remove", "/api/group/remove", {"machineId": studio["machineId"]}),
                (editor.leave_button, "Leave the group?", "leave", "/api/group/leave", {})):
            count = len(requests)
            button.emit("clicked"); self.drain(.1)
            dialog = editor.dialog
            self.assertEqual(dialog.get_heading(), heading)
            self.assertEqual(dialog.get_default_response(), "cancel")
            self.assertEqual(dialog.get_response_appearance(response), asb.Adw.ResponseAppearance.DESTRUCTIVE)
            dialog.emit("response", "cancel")
            dialog.force_close(); self.drain(.1)
            self.assertIsNone(editor.dialog)
            self.assertEqual(len(requests), count)
            button.emit("clicked"); self.drain(.1)
            editor.dialog.emit("response", response)
            editor.dialog.force_close(); self.drain(.1)
            self.assertEqual(requests[-1][0::2] + (requests[-1][3],), (route, "POST", body))
            reply({}, route, "POST", body)
            reply(grouped)
        self.assertEqual(editor.message.get_label(), "This machine left the group.")
        self.assertEqual(editor.dialog, None)
        editor.remove_buttons[0].emit("clicked"); self.drain(.1)
        self.assertEqual(editor.dialog.get_body(), asb.machine_confirm_body(["studio"], "laptop"))
        preferences.stack.set_visible_child_name("sessions"); self.drain(.1)
        self.assertIsNone(editor.dialog)
        preferences.stack.set_visible_child_name("machines"); self.drain(.1)
        reply(grouped)

        # Narrow: the tabs scroll and the selected tab is in view.
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertIs(preferences.tabs.get_ancestor(asb.Gtk.ScrolledWindow), preferences.tabs_scroll)
        self.assertTrue(preferences.tabs_scroll.get_visible())
        tab = preferences.tabs.get_last_child()
        self.assertTrue(tab.get_active())
        found, bounds = tab.compute_bounds(preferences.tabs_scroll)
        self.assertTrue(found)
        self.assertGreaterEqual(bounds.get_x(), 0)
        self.assertLessEqual(bounds.get_x() + bounds.get_width(), preferences.tabs_scroll.get_width())
        preferences.stack.set_visible_child_name("sessions"); self.drain(.1)
        self.assertEqual(preferences.tabs_scroll.get_hadjustment().get_value(), 0)
        preferences.stack.set_visible_child_name("machines"); self.drain(.1)
        reply(grouped)
        self.assertGreater(preferences.tabs_scroll.get_hadjustment().get_value(), 0)

        # The custom theme keeps destructive text red.
        normal = editor.add_button.get_color()
        window.set_theme_pickers(CUSTOM)
        window.theme_mode.set_selected(1)
        window.apply_theme(); self.drain(.1)
        self.assertNotEqual(editor.leave_button.get_color().to_string(), editor.add_button.get_color().to_string())
        self.assertNotEqual(editor.add_button.get_color().to_string(), normal.to_string())
        window.reset_theme()
        with patch.object(asb.GLib, "source_remove") as remove:
            editor.poll_timer = 78
            preferences.close(); self.drain(.1)
        remove.assert_called_once_with(78)
        self.assertFalse(editor.active)
        self.assertIsNone(editor.poll_timer)
        window.close(); self.drain(.1)
        self.assertTrue(editor.closed)

    def test_machines_dialogs_use_adw_message_dialog_when_libadwaita_has_no_alert_dialog(self):
        # Libadwaita 1.4 (AlmaLinux 9): Adw.AlertDialog (1.5) does not exist, so the dialog is a real Adw.MessageDialog.
        real = asb.Adw
        class Libadwaita14:
            def __getattr__(self, name):
                if name == "AlertDialog":
                    raise AttributeError(name)
                return getattr(real, name)
        def find_button(widget, label):
            child = widget.get_first_child()
            while child:
                found = child if isinstance(child, asb.Gtk.Button) and child.get_label() == label else find_button(child, label)
                if found:
                    return found
                child = child.get_next_sibling()
        parent = real.Window(title="Preferences", default_width=360, default_height=240)
        self.addCleanup(parent.destroy)
        parent.present(); self.drain(.2)
        editor = SimpleNamespace(preferences=parent, owner=SimpleNamespace(closed=False), dialog=None, active=True, loaded=True,
                                 loading=False, closed=False, generation=0, poll_loading=False, poll_timer=None, close_invite=lambda: None)
        parent.closed = False
        clicked = []
        def ask():
            asb.MachinesEditor.alert(editor, "Remove studio?", "The group keeps the others.", "remove", lambda: clicked.append(True))
            self.drain(.2)
            return editor.dialog
        with patch.object(asb, "Adw", Libadwaita14()):
            dialog = ask()
            self.assertIsInstance(dialog, real.MessageDialog)
            self.assertEqual((dialog.get_heading(), dialog.get_body(), dialog.get_modal()), ("Remove studio?", "The group keeps the others.", True))
            self.assertIs(dialog.get_transient_for(), parent)
            self.assertTrue(dialog.get_visible())
            self.assertEqual((dialog.get_default_response(), dialog.get_close_response()), ("cancel", "cancel"))
            self.assertEqual(dialog.get_response_appearance("remove"), real.ResponseAppearance.DESTRUCTIVE)
            # Cancel sends nothing, and the dialog closes itself and leaves editor.dialog.
            find_button(dialog, "Cancel").emit("clicked"); self.drain(.1)
            self.assertEqual((clicked, editor.dialog, dialog.get_visible()), ([], None, False))
            # Escape and the window close request count as Cancel.
            dialog = ask()
            dialog.close(); self.drain(.1)
            self.assertEqual((clicked, editor.dialog, dialog.get_visible()), ([], None, False))
            dialog = ask()
            find_button(dialog, "Remove").emit("clicked"); self.drain(.1)
            self.assertEqual((clicked, editor.dialog, dialog.get_visible()), ([True], None, False))
            # Hiding the page destroys the dialog and sends nothing.
            dialog = ask()
            asb.MachinesEditor.set_active(editor, False); self.drain(.1)
            self.assertEqual((clicked, editor.dialog, editor.active, dialog.get_visible()), ([True], None, False, False))
            self.assertNotIn(dialog, asb.Gtk.Window.list_toplevels())

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
                self.assertEqual(window.focus_widgets["sample-0"].asb_state_label.get_text(), "Waiting")
                self.assertEqual(window.focus_widgets["sample-4"].asb_state_label.get_text(), "Idle")
                question = window.focus_widgets["sample-0"]
                self.assertTrue(question.asb_state_label.get_prev_sibling().has_css_class("asb-dot"))
                self.assert_accessible_label(question, "Open Account settings in Codex. Waiting. Question needs your answer.")
                self.assertEqual(window.focus_widgets["sample-12"].asb_state_label.get_text(), "Working")
                self.assertEqual(window.focus_widgets["sample-94"].asb_state_label.get_text(), "Unknown")
                native = window.focus_widgets["sample-15"]
                dot = native.asb_state_label.get_prev_sibling()
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
                self.assertFalse(hasattr(window, "count"))
                window.select_states(set(asb.STATES))
                window.app_filter.set_selected(2)
                self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
                window.app_filter.set_selected(0)
                window.search.set_text("/example/Notes")
                window.render()
                self.assertTrue(all(row["cwd"] == "/example/Notes" for row in window.visible_rows()))
                visible = window.visible_rows()
                self.assertFalse(hasattr(window, "count"))
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
        fixture = copy.deepcopy(FIXTURE)
        fixture["threads"][1].update(pinned=True, pinIndex=0)
        fixture["threads"].append({"id": "drawer", "provider": "claude-desktop-code", "providerLabel": "Claude Desktop Code",
                                   "title": "A result kept out of the way", "cwd": "/example/Notes", "projectName": "Notes",
                                   "state": "idle", "canOpen": True, "updatedAtMs": NOW - 240_000, "drawer": True,
                                   "manualUnread": True})
        with tempfile.TemporaryDirectory(prefix="asb-native-menu-test-") as temporary:
            window = asb.SwitchboardWindow(application, "http://127.0.0.1:1", fixture,
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
            def actions(panel):
                return {slot: (button.asb_label.get_label(), button.get_sensitive()) for slot, button in panel.asb_actions.items()
                        if button.get_visible()}
            for key, modifier in ((asb.Gdk.KEY_Menu, 0), (asb.Gdk.KEY_F10, asb.Gdk.ModifierType.SHIFT_MASK)):
                self.assertTrue(window.row_key(None, key, 0, modifier, "unknown"))
                self.drain()
                panel = window.context_menu
                self.assertIsInstance(panel, asb.Gtk.Popover)
                self.assertNotIsInstance(panel, asb.Gtk.PopoverMenu)
                self.assertFalse(panel.get_has_arrow())
                self.assertTrue(panel.has_css_class("asb-row-panel"))
                self.assertTrue(panel.get_mapped())
                self.assert_accessible_label(panel, "A session without a desktop link")
                self.assertEqual(panel.asb_title.get_label(), "A session without a desktop link")
                self.assertEqual(panel.asb_title.get_tooltip_text(), "/example/Tools\ncodex/")
                self.assertEqual(panel.asb_open.asb_label.get_label(), "Open in Codex")
                self.assertEqual(panel.asb_open.asb_icon.get_icon_name(), "go-next-symbolic")
                self.assertFalse(panel.asb_open.get_sensitive())
                self.assertEqual(actions(panel), {"read": ("Mark unread", True), "mute": ("Mute", True), "pin": ("Pin", True)})
                self.assertFalse(panel.asb_note.get_visible())
                self.assertFalse(window.row_key(None, asb.Gdk.KEY_Down, 0, 0, "unknown"))
                panel.popdown()
                self.drain()
                self.assertIsNone(window.context_menu)
            # The panel is about 280px wide with the 8px padding, also for a long title and folder.
            row = window.focus_widgets["second"]
            row.asb_thread.update(title="A long title " * 12, cwd="/example/" + "folder/" * 20)
            window.show_context(row, 10, 10)
            self.drain()
            panel = window.context_menu
            self.assertTrue(panel.get_mapped())
            self.assertTrue(260 <= panel.get_child().get_width() <= 268, panel.get_child().get_width())
            self.assertEqual(panel.asb_title.get_layout().get_line_count(), 1)
            self.assertTrue(panel.asb_title.get_layout().is_ellipsized())
            panel.popdown()
            row.asb_thread.update(title=fixture["threads"][1]["title"], cwd="/example/ASB")
            window.show_context(row, 10, 10)
            self.drain()
            panel = window.context_menu
            # The centered panel points inside the window, also for a click near the window edge.
            ok, rectangle = panel.get_pointing_to()
            ok, point = row.compute_point(window, asb.Graphene.Point().init(rectangle.x, rectangle.y))
            half = 139  # the 278px panel with its ring
            self.assertTrue(half <= point.x <= window.get_width() - half, (point.x, half, window.get_width()))
            # One flat row of about 30px per control; a copy row is taller for its caption.
            for button in (panel.asb_open, *panel.asb_actions.values()):
                if button.get_visible():
                    self.assertTrue(button.has_css_class("flat") and button.has_css_class("asb-panel-action"))
                    self.assertTrue(30 <= button.get_height() <= 32, button.get_height())
            for button in (panel.asb_copy, panel.asb_copy_full):
                self.assertTrue(button.has_css_class("flat") and button.has_css_class("asb-panel-captioned"))
                # get_height() leaves out the padding: 5px at the top and the bottom.
                found, box = button.compute_bounds(panel)
                self.assertEqual(box.size.height, button.get_height() + 10)
                self.assertGreater(box.size.height, 32)
            # A failed action shows its error in the panel, which covers the card tooltip.
            self.assertFalse(panel.asb_error.get_visible())
            window.open_errors["second"] = "The server did not answer."
            window.sync_row_panel()
            self.assertTrue(panel.asb_error.get_visible())
            self.assertEqual(panel.asb_error.get_label(), "The server did not answer.")
            window.open_errors.pop("second")
            window.sync_row_panel()
            self.assertFalse(panel.asb_error.get_visible())
            self.assertEqual(actions(panel), {"read": ("Mark read", True), "drawer": ("Put in drawer", True), "mute": ("Mute", True),
                                              "pin": ("Unpin", True), "pin-up": ("Move pin earlier", True), "pin-down": ("Move pin later", True)})
            # ASB glyphs are file icons, so GTK recolors them like the theme icons.
            icons = [button.asb_icon.get_icon_name() or button.asb_icon.get_gicon().get_file().get_basename()
                     for button in panel.asb_actions.values() if button.get_visible()]
            self.assertEqual(icons, ["object-select-symbolic", "asb-drawer-symbolic.svg", "asb-muted-symbolic.svg", "view-pin-symbolic",
                                     "go-up-symbolic", "go-down-symbolic"])
            self.assertTrue(all(button.asb_icon.get_gicon().get_file().query_exists(None) for button in panel.asb_actions.values()
                                if button.get_visible() and not button.asb_icon.get_icon_name()))
            for button in panel.asb_actions.values():
                if button.get_visible():
                    self.assert_accessible_label(button, button.asb_label.get_label())
            self.assert_accessible_label(panel.asb_open, "Open in Codex")
            self.assert_accessible_label(panel.asb_copy, "Copy relative reference")
            self.assert_accessible_label(panel.asb_copy_full, "Copy absolute reference")
            self.assertTrue(panel.asb_open.get_sensitive())
            # Earlier and Later at the ends of the pins send nothing.
            with patch.object(window, "session_action") as action:
                panel.asb_actions["pin-up"].emit("clicked")
                panel.asb_actions["pin-down"].emit("clicked")
                action.assert_not_called()
                panel.asb_actions["drawer"].emit("clicked")
                action.assert_called_once_with("second", "drawer-in")
                action.reset_mock()
                panel.asb_actions["read"].emit("clicked")
                action.assert_called_once_with("second", "mark-read")
            self.assertIs(window.context_menu, panel)
            # While an action runs, every control is insensitive and keeps its label; the focused slot gets the focus
            # back, with its new label, when the action ends.
            read, signature = panel.asb_actions["read"], panel.asb_signature
            read.grab_focus()
            window.session_actions.add("second")
            row.asb_thread.update(unread=False, pending=False, pendingSource="")
            window.sync_row_panel()
            self.assertFalse(any(button.get_sensitive() for button in (panel.asb_open, panel.asb_copy, panel.asb_copy_full, *panel.asb_actions.values())))
            self.assertEqual(actions(panel)["read"], ("Mark read", False))
            self.assertIn("drawer", actions(panel))
            self.assertIs(panel.asb_return_focus, read)
            window.session_actions.discard("second")
            window.sync_row_panel()
            self.drain()
            self.assertIs(panel.asb_actions["read"], read)
            self.assertEqual((read.asb_label.get_label(), read.asb_icon.get_icon_name()), ("Mark unread", "mail-unread-symbolic"))
            self.assert_accessible_label(read, "Mark unread")
            self.assertNotIn("drawer", actions(panel))
            self.assertIs(window.get_focus(), read)
            self.assertNotEqual(panel.asb_signature, signature)
            row.asb_thread.update(unread=True, pending=True, pendingSource="observed-completion")
            window.sync_row_panel()
            self.drain()  # Tab order follows the allocation of the shown drawer row.
            # Down and Up move through the controls in Tab order and wrap at the ends.
            keys = [controller for controller in panel.observe_controllers() if isinstance(controller, asb.Gtk.EventControllerKey)]
            capture = next(controller for controller in keys if controller.get_propagation_phase() == asb.Gtk.PropagationPhase.CAPTURE)
            panel.asb_open.grab_focus()
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_actions["read"])
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Up, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_open)
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Up, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_copy_full)
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Up, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_copy)
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Up, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_actions["pin-down"])
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_copy)
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_copy_full)
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_open)
            # Escape (the native popover key handler) closes the panel and gives the focus back to the card.
            panel.asb_actions["pin"].grab_focus()
            self.assertTrue(window.get_focus().is_ancestor(panel))
            native = next(controller for controller in keys if controller.get_propagation_phase() == asb.Gtk.PropagationPhase.BUBBLE)
            finalized = []
            panel.weak_ref(lambda: finalized.append(True))
            self.assertTrue(native.emit("key-pressed", asb.Gdk.KEY_Escape, 9, 0))
            self.drain()
            self.assertIsNone(window.context_menu)
            self.assertIs(window.get_focus(), window.focus_widgets["second"])
            # A closed panel is freed: its handlers hold no reference to it.
            del panel, keys, capture, native, read
            gc.collect()
            self.drain()
            self.assertEqual(finalized, [True])
            window.show_context(window.focus_widgets["first"])
            self.drain()
            panel = window.context_menu
            self.assertTrue(260 <= panel.get_child().get_width() <= 268, panel.get_child().get_width())
            self.assertEqual(actions(panel), {"read": ("Mark unread", True), "mute": ("Mute", True), "pin": ("Pin", True),
                                              "discard": ("Discard result", True)})
            self.assertEqual(panel.asb_actions["discard"].asb_icon.get_icon_name(), "edit-delete-symbolic")
            # A clock tick that changes no shown data changes no widget.
            shown = panel.asb_signature
            later = time.time() + 2 * 86_400
            with patch.object(asb.time, "time", return_value=later):
                window.update_clock()
            self.assertIs(panel.asb_signature, shown)
            window.show_context(window.focus_widgets["drawer"])
            self.drain()
            self.assertFalse(panel.get_visible())
            panel = window.context_menu
            self.assertEqual(panel.asb_open.asb_label.get_label(), "Open in Claude Desktop Code")
            self.assertEqual(actions(panel), {"read": ("Mark read", True), "drawer": ("Take out of drawer", True), "mute": ("Mute", True),
                                              "pin": ("Pin", True)})
            self.assertFalse(panel.asb_note.get_visible())
            window.show_context(window.focus_widgets["claude:local_mock"])
            self.drain()
            panel = window.context_menu
            self.assertEqual(actions(panel), {"mute": ("Mute", True), "pin": ("Pin", True)})
            self.assertTrue(panel.asb_note.get_visible())
            self.assertEqual(panel.asb_note.get_label(), "Waits for your permission.")
            # The note comes after Open and its separator.
            self.assertIs(panel.asb_note.get_prev_sibling().get_prev_sibling(), panel.asb_open)
            # Open runs the card open path and closes the panel.
            with patch.object(window, "open_row") as open_row:
                panel.asb_open.emit("clicked")
                open_row.assert_called_once_with(None, window.focus_widgets["claude:local_mock"])
            self.drain()
            self.assertIsNone(window.context_menu)
            # A repack keeps the panel open on its row while the row stays on the board.
            window.show_context(window.focus_widgets["second"])
            self.drain()
            panel = window.context_menu
            window.search.set_text("keyboard focus")
            window.render()
            self.drain()
            self.assertEqual(window.row_order, ["second"])
            self.assertIs(window.context_menu, panel)
            self.assertTrue(panel.get_mapped())
            # A row that leaves the board closes its panel.
            window.search.set_text("no session has this title")
            window.render()
            self.drain()
            self.assertIsNone(window.context_menu)
            window.search.set_text("")
            window.render()
            with patch.object(window, "session_action") as action:
                window.activate_action("win.mark-unread", asb.GLib.Variant("s", "unknown"))
                action.assert_called_once_with("unknown", "mark-unread")
            window.close()
            self.drain(.03)

    def test_row_panel_open_follows_the_open_request_start_and_end(self):
        callbacks = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                    (asb, "request_async", lambda *args: callbacks.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain()
        card = window.focus_widgets["second"]
        window.show_context(card); self.drain()
        panel = window.context_menu
        self.assertTrue(panel.asb_open.get_sensitive())
        # An open of the row that starts while its panel shows makes Open insensitive at once, and the end of the request
        # makes it sensitive again, with no other row change and no clock tick.
        for error in (None, "The app did not open the session."):
            window.open_row(None, card)
            self.assertEqual(callbacks[-1][1], "/api/threads/second/open")
            self.assertIs(window.context_menu, panel)
            self.assertFalse(panel.asb_open.get_sensitive())
            callbacks[-1][2](None if error else {"opened": True}, error)
            self.assertNotIn("second", window.opening)
            self.assertTrue(panel.asb_open.get_sensitive())
            self.assertEqual((panel.asb_error.get_visible(), panel.asb_error.get_label()), (bool(error), error or ""))
        # A clock tick that changes no shown data changes no widget.
        shown = panel.asb_signature
        with patch.object(asb.time, "time", return_value=time.time() + 86_400):
            window.update_clock()
        self.assertIs(panel.asb_signature, shown)
        self.assertEqual([args[1] for args in callbacks if args[1].endswith("/open")], ["/api/threads/second/open"] * 2)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_context_menu_closes_on_pointer_exit(self):
        from gi.repository import GdkX11

        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                    (asb, "request_async", lambda *_args, **_kwargs: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout

        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        xdo("mousemove", 1500, 950)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(900, 700)
        window.present(); self.drain(.3)
        card = window.focus_widgets["second"]
        self.assertTrue(window.row_key(None, asb.Gdk.KEY_Menu, 0, 0, "second"))
        self.drain()
        panel = window.context_menu
        self.assertTrue(panel.get_mapped())
        # A menu opened from the keyboard stays open until the pointer enters and leaves it.
        xdo("mousemove", 1490, 940); self.drain()
        self.assertIs(window.context_menu, panel)

        def move_to(widget, root):
            found, bounds = widget.compute_bounds(root)
            self.assertTrue(found)
            left, top = root.get_surface_transform()
            xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(root.get_surface()),
                int(bounds.origin.x + bounds.size.width / 2 + left),
                int(bounds.origin.y + bounds.size.height / 2 + top))
            self.drain()

        for control in (panel.asb_open, panel.asb_actions["read"], panel.asb_actions["pin"], panel.asb_copy):
            move_to(control, panel)
            self.assertIs(window.context_menu, panel)
            self.assertTrue(panel.get_mapped())
        panel.asb_copy.emit("clicked")
        self.assertIsNotNone(panel.asb_copy_timer)
        finalized = []
        panel.weak_ref(lambda: finalized.append(True))
        xdo("mousemove", 1500, 950); self.drain(.3)
        self.assertIsNone(window.context_menu)
        self.assertFalse(panel.get_visible())
        self.assertIsNone(panel.asb_copy_timer)
        self.assertIs(window.get_focus(), card)
        del control, panel
        gc.collect(); self.drain()
        self.assertEqual(finalized, [True])
        # Right-click uses the same exit behavior, including leaving for the board without a click.
        move_to(card, window)
        xdo("click", 3); self.drain()
        panel = window.context_menu
        self.assertIsNotNone(panel)
        move_to(panel.asb_open, panel)
        move_to(window.menu_button, window)
        self.assertIsNone(window.context_menu)
        self.assertFalse(window.opening or window.session_actions)

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
            self.assertFalse(hasattr(window, "feedback"))
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
            self.assertEqual(asb.read_layout(window.layout_path), {"columnWidth": 240, "view": "compact", "showAppPills": False, "cardLimit": 0})

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
            window.open_preferences()
            self.assertTrue(window.preferences_window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
            self.assertEqual(window.search.get_text(), "cx:")
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
                self.assertEqual(window.focus_widgets["sample-15"].asb_state_label.get_text(), "Working")
                acknowledged = copy.deepcopy(changed)
                acknowledged["threads"][15].update(unread=False, nativeAttention=False, pending=False)
                window.apply_dashboard(acknowledged, None)
                self.drain()
                read_row = window.focus_widgets["sample-15"]
                self.assertEqual(read_row.asb_state_label.get_text(), "Working")
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
                self.assertEqual(calls[-1][0], "/api/dashboard")
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
                if self.path == "/api/palette":  # The window shares its palette at start; this test checks row actions.
                    self.send_response(200); self.end_headers(); self.wfile.write(b'{"changed": true}')
                    return
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
        # The action, its slot, and the slot label before and after the action.
        controls = {"Unread": ("read", "Mark unread", "Mark read"), "Read": ("read", "Mark read", "Mark unread"),
                    "Pin": ("pin", "Pin", "Unpin"), "Unpin": ("pin", "Unpin", "Pin"),
                    "Move pin earlier": ("pin-up", "Move pin earlier", "Move pin earlier")}
        def activate(identity, text):
            window.show_context(window.focus_widgets[identity])
            self.drain()
            popup = window.context_menu
            slot, before, after = controls[text]
            button = popup.asb_actions[slot]
            self.assertEqual(button.asb_label.get_label(), before)
            button.grab_focus()
            button.emit("clicked")
            # The real request runs: every control is insensitive and keeps its label.
            self.assertFalse(button.get_sensitive() or popup.asb_open.get_sensitive() or popup.asb_copy.get_sensitive())
            self.assertEqual(button.asb_label.get_label(), before)
            self.drain(.35)
            # The panel stays open on its row, with the new row data, and the same slot keeps the focus.
            self.assertIs(window.context_menu, popup)
            self.assertTrue(popup.get_mapped())
            self.assertIs(popup.get_parent(), window.focus_widgets[identity])
            self.assertIs(popup.asb_actions[slot], button)
            self.assertEqual(button.asb_label.get_label(), after)
            self.assert_accessible_label(button, after)
            self.assertTrue(button.get_sensitive())
            self.assertIs(window.get_focus(), button)
            popup.popdown()
            self.drain()
            self.assertIsNone(window.context_menu)
        activate("sample-30", "Unread")
        self.assertEqual(received[0], ("/api/threads/sample-30/mark-unread", {}, base))
        self.assertTrue(window.focus_widgets["sample-30"].asb_thread["manualUnread"])
        dot = window.focus_widgets["sample-30"].asb_state_label.get_prev_sibling()
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
            self.assertTrue(window.persistent_unread.get_active())
            self.assertTrue(window.persistent_unread.get_sensitive())
            self.assertEqual(window.unread_setting_error.get_text(), "Cannot change the unread setting.")
            window.dashboard = current_dashboard
            window.sync_unread_setting(current_dashboard["persistentUnread"])
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
        self.assertEqual(window.state_summary.get_label(), "2 states")
        self.assertEqual(window.states, {"working", "idle"})
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            window.open_preferences()
            window.preferences_window.stack.set_visible_child_name("sessions")
            self.drain(.2)
            self.capture(window.preferences_window, Path(output) / "native-multi-state.png")
            window.preferences_window.close()
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
                        mark = top.get_first_child().get_child()
                        self.assertEqual((mark.get_icon_name(), mark.get_gicon().get_file().get_basename()), (None, "asb-claude-symbolic.svg"))
                        self.assertTrue(mark.get_gicon().get_file().query_exists(None))
                        self.assertEqual(top.get_first_child().get_next_sibling().get_text(), "Tools")
                        self.assertEqual(card.asb_pin_button.get_child().get_icon_name(), "view-pin-symbolic")
                        self.assertTrue(title.get_wrap())
                        self.assertEqual(title.get_lines(), 2)
                        self.assertEqual(title.get_height(), 32)
                        self.assertEqual(title.get_ellipsize(), asb.Pango.EllipsizeMode.END)
                        metadata = window.focus_widgets["sample-15"].get_child().get_child().get_last_child()
                        self.assertFalse(metadata.get_first_child().get_visible())  # The usage-limit clock.
                        self.assertEqual(metadata.get_first_child().get_next_sibling().get_text(), "Working")
                        self.assertIs(card.asb_dot.get_ancestor(asb.Gtk.Button), card.asb_read_button)
                        # The right part: the where glyph and label (hidden for a desktop row), then the age.
                        right, sample = metadata.get_last_child(), window.focus_widgets["sample-15"]
                        self.assertIs(right.get_first_child(), sample.asb_where_icon)
                        self.assertIs(sample.asb_where_icon.get_next_sibling(), sample.asb_where_label)
                        self.assertIs(sample.asb_where_label.get_next_sibling(), sample.asb_age_label)
                        self.assertFalse(sample.asb_where_icon.get_visible() or sample.asb_where_label.get_visible())
                        self.assertEqual(right.get_last_child().get_ellipsize(), asb.Pango.EllipsizeMode.END)
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
                    self.assertEqual(asb.read_layout(layout_path), {"columnWidth": 240, "view": "comfortable", "showAppPills": False, "cardLimit": 0})
                window.app_pills["codex"].set_active(True)
                self.assertEqual(window.apps, {"codex"})
                self.assertEqual(window.app_filter.get_selected(), 1)
                self.assertTrue(all(row["provider"] == "codex" for row in window.visible_rows()))
                window.app_pills["claude-desktop-code"].set_active(True)
                self.assertEqual(window.app_filter.get_selected(), 4)
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

    def test_row_panel_copies_the_app_and_session_id_and_matches_the_board_background(self):
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        row = dashboard["threads"][1]
        row.update(id="claude-proxy-1:local_" + "a" * 36, externalId="local_" + "a" * 36, sourceId="claude-proxy-1",
                   sourceLabel="Claude Proxy", sourceName="claude-proxy")
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        clipboard = SimpleNamespace(texts=[])
        clipboard.set = clipboard.texts.append
        window.get_clipboard = lambda: clipboard  # No write to a real clipboard.
        window.set_default_size(680, 600)
        window.present(); self.drain(.5); window.check_geometry(); self.drain()
        window.show_context(window.focus_widgets[row["id"]]); self.drain(.3)
        panel = window.context_menu
        reference = "claude-proxy/local_" + "a" * 36
        button, full = panel.asb_copy, panel.asb_copy_full
        self.assertIs(button.get_next_sibling(), full)
        self.assertIs(full.get_next_sibling(), panel.asb_error)  # The last control of the panel.
        self.assertIsInstance(button.get_prev_sibling(), asb.Gtk.Separator)
        self.assertEqual((button.asb_label.get_label(), button.asb_icon.get_icon_name(), button.get_tooltip_text()),
                         ("Copy relative reference", "edit-copy-symbolic", reference))
        self.assertTrue(button.has_css_class("flat"))
        self.assert_accessible_label(button, "Copy relative reference")
        self.assert_accessible_label(button, reference, asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.assertEqual((button.asb_caption.get_label(), button.asb_caption.get_lines()), ("Relative: in the same app", 1))
        self.assertEqual(panel.asb_title.get_tooltip_text().split("\n")[1], reference)
        # This mock is an old engine: row 2 says why, has no action, and stays sensitive and focusable.
        older = "The ASB engine is older. Quit ASB and start it again."
        self.assertEqual((full.asb_label.get_label(), full.asb_caption.get_label(), full.asb_caption.get_lines(), full.get_sensitive(),
                          full.get_focusable()), ("Copy absolute reference", older, 2, True, True))
        self.assert_accessible_label(full, "Copy absolute reference")
        self.assert_accessible_label(full, older, asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.assert_accessible_disabled(full, True)
        self.assert_accessible_disabled(button, False)
        full.emit("clicked"); self.drain(.1)
        self.assertEqual(clipboard.texts, [])
        # The button copies the exact reference, and the panel stays open.
        button.emit("clicked"); self.drain(.1)
        button.emit("clicked"); self.drain(.1)
        self.assertEqual(clipboard.texts, [reference, reference])
        self.assertIs(window.context_menu, panel)
        self.assertTrue(panel.get_visible())
        self.assertEqual((button.asb_icon.get_icon_name(), button.get_tooltip_text()), ("object-select-symbolic", "Copied"))
        self.assertEqual(button.asb_label.get_label(), "Copy relative reference")
        self.assert_accessible_label(button, "Copied", asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.drain(1.7)
        self.assertEqual((button.asb_icon.get_icon_name(), button.get_tooltip_text()), ("edit-copy-symbolic", reference))
        self.assert_accessible_label(button, reference, asb.Gtk.AccessibleProperty.DESCRIPTION)
        # Up and Down reach both copy rows, also the unavailable one, and wrap at the end.
        last = [control for control in panel.asb_actions.values() if control.get_visible()][-1]
        last.grab_focus()
        keys = next(controller for controller in panel.observe_controllers()
                    if isinstance(controller, asb.Gtk.EventControllerKey) and controller.get_propagation_phase() == asb.Gtk.PropagationPhase.CAPTURE)
        self.assertTrue(keys.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
        self.assertIs(window.get_focus(), button)
        self.assertTrue(keys.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
        self.assertIs(window.get_focus(), full)
        self.assertTrue(keys.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
        self.assertIs(window.get_focus(), panel.asb_open)
        # A refresh with a new ID updates the tooltips and ends the feedback of the old copy.
        button.emit("clicked")
        row["externalId"] = "local_" + "b" * 36
        window.render(); window.sync_row_panel(); self.drain(.1)
        self.assertEqual(button.get_tooltip_text(), "claude-proxy/local_" + "b" * 36)
        self.assertEqual(panel.asb_title.get_tooltip_text().split("\n")[1], "claude-proxy/local_" + "b" * 36)
        self.assertEqual(button.asb_icon.get_icon_name(), "edit-copy-symbolic")
        # A failed copy keeps the copy icon and shows its error below the list, also after an action error clears.
        def refuse(_text):
            raise TypeError("no clipboard")
        clipboard.set = refuse
        button.emit("clicked"); self.drain(.1)
        copy_error = "Cannot copy the relative reference: no clipboard"
        self.assertEqual((panel.asb_error.get_label(), panel.asb_error.get_visible()), (copy_error, True))
        self.assertEqual(button.asb_icon.get_icon_name(), "edit-copy-symbolic")
        window.open_errors[row["id"]] = "The server did not answer."
        window.sync_row_panel()
        self.assertEqual(panel.asb_error.get_label(), "The server did not answer.")
        window.open_errors.pop(row["id"])
        window.sync_row_panel()
        self.assertEqual((panel.asb_error.get_label(), panel.asb_error.get_visible()), (copy_error, True))
        clipboard.set = clipboard.texts.append
        button.emit("clicked"); self.drain(.1)
        self.assertFalse(panel.asb_error.get_visible())
        window.open_errors[row["id"]] = "The server did not answer."
        window.sync_row_panel(); self.drain(.1)
        def render_panel():
            snapshot = asb.Gtk.Snapshot()
            asb.Gtk.WidgetPaintable.new(panel).snapshot(snapshot, panel.get_width(), panel.get_height())
            renderer = asb.Gsk.CairoRenderer()
            renderer.realize(None)
            viewport = asb.Graphene.Rect().init(0, 0, panel.get_width(), panel.get_height())
            downloader = asb.Gdk.TextureDownloader.new(renderer.render_texture(snapshot.to_node(), viewport))
            downloader.set_format(asb.Gdk.MemoryFormat.R8G8B8A8)
            data, stride = downloader.download_bytes()
            renderer.unrealize()
            data = data.get_data()
            return lambda x, y: "#" + "".join(f"{value:02x}" for value in data[int(y) * stride + int(x) * 4:int(y) * stride + int(x) * 4 + 3])
        def near(first, second, delta=1):
            return all(abs(int(first[i:i + 2], 16) - int(second[i:i + 2], 16)) <= delta for i in (1, 3, 5))
        def bounds_of(widget):
            found, bounds = widget.compute_bounds(panel)
            return bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height
        def text_on(label, background, dimmed=1):
            color = label.get_color()
            # Libadwaita colors can have channels past 1; the screen shows them clamped.
            ink = "#" + "".join(f"{max(0, min(255, round(channel * 255))):02x}" for channel in (color.red, color.green, color.blue))
            return asb.contrast(asb.mix_color(background, ink, color.alpha * dimmed), background)
        for custom in (None, {"background": "#171c22", "text": "#f0f2f5", "accent": "#f3c66b", "muted": "#b8c0cc", "divider": "#586372"}):
            with self.subTest(custom=bool(custom)):
                window.set_palette(custom); self.drain(.2)
                board = custom["background"] if custom else window.native_colors()["background"]
                window.set_focus(panel.asb_open); self.drain(.3)
                pixel = render_panel()
                found, bounds = panel.get_child().compute_bounds(panel)
                painted = pixel(bounds.origin.x - 4, bounds.origin.y + 20)  # Inside the 8px padding.
                self.assertTrue(near(painted, board), (painted, board))
                # The action rows are flat on the board; native hover and press tint them, and a focused row has its focus ring.
                x, copy_y, _width, copy_height = bounds_of(button)
                self.assertTrue(near(pixel(x + 2, copy_y + copy_height / 2), board, 2), pixel(x + 2, copy_y + copy_height / 2))
                for state in (asb.Gtk.StateFlags.PRELIGHT, asb.Gtk.StateFlags.ACTIVE):
                    button.set_state_flags(state, False); self.drain(.3)
                    self.assertFalse(near(render_panel()(x + 4, copy_y + copy_height / 2), board, 2), state)
                    button.unset_state_flags(state); self.drain(.3)
                pinned = panel.asb_actions["pin"]
                pin_x, pinned_y, _pw, pinned_height = bounds_of(pinned)
                window.set_focus_visible(True)
                pinned.grab_focus(); self.drain(.3)
                self.assertTrue(pinned.has_focus())
                self.assertFalse(near(render_panel()(pin_x + 1, pinned_y + pinned_height / 2), board, 2))  # The ring is on the row edge.
                # The permission note uses 72% of the text color; custom colors use the muted role.
                for label in (panel.asb_title, panel.asb_open.asb_label, pinned.asb_label, button.asb_label, panel.asb_note, panel.asb_error,
                              button.asb_caption, full.asb_caption):
                    self.assertGreaterEqual(text_on(label, board), 4.5, label.get_css_classes())

    def test_copy_rows_show_the_absolute_reference_the_reasons_and_the_disabled_card_button(self):
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        row, invalid_row = dashboard["threads"][1], dashboard["threads"][2]
        app_id = "123e4567-e89b-12d3-a456-426614174000"
        reference = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:" + app_id
        row.update(externalId=app_id, sessionReference="codex/" + app_id, reference=reference)
        invalid_row.update(externalId="bad id", referenceUnavailable="invalid-app-id")
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        clipboard = SimpleNamespace(texts=[])
        clipboard.set = clipboard.texts.append
        window.get_clipboard = lambda: clipboard  # No write to a real clipboard.
        window.set_default_size(680, 600)
        window.present(); self.drain(.5); window.check_geometry(); self.drain()
        window.show_context(window.focus_widgets[row["id"]]); self.drain(.3)
        panel = window.context_menu
        short, full = panel.asb_copy, panel.asb_copy_full
        self.assertEqual((full.asb_caption.get_label(), full.asb_caption.get_lines()), ("Absolute: with ASB, any machine", 1))
        self.assertFalse(full.asb_caption.get_layout().is_ellipsized())
        self.assertEqual(full.asb_caption.get_layout().get_line_count(), 1)
        self.assert_accessible_label(full, reference, asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.assert_accessible_disabled(full, False)
        # The row 2 tooltip is the exact value, wrapped at about 36 characters.
        tooltip = SimpleNamespace(set_custom=lambda widget: setattr(tooltip, "widget", widget))
        self.assertTrue(window.query_copy_tooltip(full, 0, 0, False, tooltip))
        self.assertEqual((tooltip.widget.get_label(), tooltip.widget.get_max_width_chars(), tooltip.widget.get_wrap_mode()),
                         (reference, 36, asb.Pango.WrapMode.WORD_CHAR))
        short.emit("clicked"); self.drain(.1)
        full.emit("clicked"); self.drain(.1)
        self.assertEqual(clipboard.texts, ["codex/" + app_id, reference])
        # A copy on row 2 ends the check on row 1; the label stays.
        self.assertEqual((short.asb_icon.get_icon_name(), full.asb_icon.get_icon_name(), full.asb_label.get_label()),
                         ("edit-copy-symbolic", "object-select-symbolic", "Copy absolute reference"))
        self.assertTrue(full.has_css_class("asb-copy-done"))
        self.assert_accessible_label(short, "codex/" + app_id, asb.Gtk.AccessibleProperty.DESCRIPTION)
        # Unknown source: row 2 shows the reason in place of the caption, and keeps the focus.
        row.pop("reference")
        row["referenceUnavailable"] = "unknown-source"
        window.render(); window.sync_row_panel(); self.drain(.1)
        unknown = "ASB does not know the profile of this session."
        self.assertEqual((full.asb_caption.get_label(), full.asb_icon.get_icon_name(), full.get_sensitive(), full.get_focusable()),
                         (unknown, "edit-copy-symbolic", True, True))
        self.assertTrue(full.has_css_class("asb-copy-off"))
        self.assert_accessible_disabled(full, True)
        layout = full.asb_caption.get_layout()
        self.assertTrue(layout.get_line_count() <= 2 and not layout.is_ellipsized())
        full.grab_focus(); full.activate(); self.drain(.1)
        self.assertIs(window.get_focus(), full)
        self.assertEqual(len(clipboard.texts), 2)
        panel.popdown(); self.drain(.2)
        # An invalid ID: both rows are off, the reason shows once, under row 2.
        window.show_context(window.focus_widgets[invalid_row["id"]]); self.drain(.3)
        panel = window.context_menu
        reason = "This session has an ID in a form that ASB does not know."
        self.assertEqual((panel.asb_copy.asb_caption.get_visible(), panel.asb_copy_full.asb_caption.get_label()), (False, reason))
        for button in (panel.asb_copy, panel.asb_copy_full):
            self.assert_accessible_disabled(button, True)
            self.assert_accessible_label(button, reason, asb.Gtk.AccessibleProperty.DESCRIPTION)
            button.emit("clicked")
        self.assertEqual(panel.asb_copy.get_tooltip_text(), reason)
        self.assertNotIn("\n", panel.asb_title.get_tooltip_text())  # The path only.
        self.assertEqual(len(clipboard.texts), 2)
        panel.popdown(); self.drain(.2)
        # The Comfortable card button stays, with no action and the reason as its tooltip.
        window.view_filter.set_selected(1); self.drain(1)
        card = window.focus_widgets[invalid_row["id"]].asb_copy_button
        self.assertEqual((card.get_visible(), card.asb_action, card.get_tooltip_text()), (True, None, reason))
        self.assertTrue(card.has_css_class("asb-copy-off"))
        self.assert_accessible_disabled(card, True)
        self.assert_accessible_label(card, "Copy relative reference: " + invalid_row["title"])
        card.emit("clicked"); self.drain(.1)
        self.assertEqual(len(clipboard.texts), 2)

    def test_ctrl_number_keycaps_cover_the_mark_in_both_views_and_keep_the_row_height(self):
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", mock_dashboard(), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(680, 248)
        window.present(); self.drain(.5); window.check_geometry(); self.drain()
        for selected, row_height, size in ((0, asb.ROW_HEIGHT, 16), (1, asb.COMFORTABLE_ROW_HEIGHT, 18)):
            with self.subTest(selected=selected):
                window.view_filter.set_selected(selected); self.drain(.5)
                window.show_numbers(); self.drain(.3)
                self.assertTrue(window.numbers_shown)
                self.assertFalse(window.list_body.has_css_class("asb-numbers-shown"))
                # Whole cards only: two complete columns of the 680px window.
                self.assertEqual(window.number_keys, window.row_order[:min(9, window.columns * window.capacity)])
                for number, identity in enumerate(window.number_keys, 1):
                    card = window.focus_widgets[identity]
                    badge = card.asb_number_label
                    self.assertEqual((badge.get_label(), badge.get_visible(), badge.get_can_target()), (str(number), True, False))
                    self.assertTrue(badge.has_css_class("asb-number-shown"))
                    self.assertFalse(badge.get_parent().get_measure_overlay(badge))
                    found, box = badge.compute_bounds(badge.get_parent())  # The border box.
                    self.assertEqual((box.size.width, box.size.height), (size, size))
                    # The keycap is centered on the provider mark and covers it.
                    found, mark = card.asb_mark.compute_bounds(badge.get_parent())
                    self.assertTrue(found)
                    self.assertAlmostEqual(box.origin.x * 2 + size, mark.origin.x * 2 + mark.size.width, delta=1)
                    self.assertAlmostEqual(box.origin.y * 2 + size, mark.origin.y * 2 + mark.size.height, delta=1)
                hidden = window.focus_widgets[window.row_order[len(window.number_keys)]].asb_number_label
                self.assertEqual((hidden.get_label(), hidden.get_visible()), ("", False))
                self.assertFalse(hidden.has_css_class("asb-number-shown"))
                self.assertTrue(all(row.get_height() == row_height for row in self.widget_rows(window)))
                window.hide_numbers(); self.drain(.3)
                self.assertFalse(badge.has_css_class("asb-number-shown"))
        window.set_palette({"background": "#000000", "text": "#7c7c7c", "accent": "#ff0000", "muted": "#999999", "divider": "#333333"})
        self.drain()
        badge = window.focus_widgets[window.number_keys[0]].asb_number_label
        found, box = badge.compute_bounds(badge.get_parent())
        self.assertEqual((box.size.width, box.size.height), (18, 18))
        if not (shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10")):
            return  # Real keys need xdotool and a nested test display (DISPLAY=:9 or :10).
        import gi
        gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11  # noqa: F401  The X11 surface gives the window ID for the key focus.
        opened = []
        window.open_row = lambda _listing, widget: opened.append(widget.asb_thread["id"])
        def keys(*args, wait=.1):
            subprocess.run(["xdotool", *args], check=True)
            self.drain(wait)
        window.set_default_size(420, 400); self.drain(.3); window.check_geometry(); self.drain()
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True); self.drain(.3)
        # The narrow search popover gets the keys itself; the number keys work there and keep the search focus.
        window.open_search(); self.drain(.3)
        self.assertTrue(window.search_popover.get_visible())
        keys("keydown", "Control_L", wait=.45)
        self.assertTrue(window.numbers_shown)
        keys("key", "3")
        self.assertEqual(opened, [window.number_keys[2]])
        self.assertTrue(window.get_focus().is_ancestor(window.search))
        keys("keyup", "Control_L", wait=.2)
        self.assertFalse(window.numbers_shown)
        # Any other popover hides and blocks the numbers, also one that does not take the focus.
        quiet = asb.Gtk.Popover(autohide=False, child=asb.Gtk.Label(label="Synthetic non-focus popup"))
        quiet.set_parent(window.menu_button)
        keys("keydown", "Control_L", wait=.45)
        self.assertTrue(window.numbers_shown)
        quiet.popup(); self.drain(.2)
        self.assertFalse(window.numbers_shown)
        keys("key", "3")
        self.assertEqual(len(opened), 1)
        keys("keyup", "Control_L", wait=.2)
        quiet.popdown(); quiet.unparent(); self.drain()
        # A popover that takes the keys misses the release; closing it shows nothing, and a new hold works.
        grab = asb.Gtk.Popover(child=asb.Gtk.Entry())
        grab.set_parent(window.menu_button)
        keys("keydown", "Control_L", wait=.45)
        self.assertTrue(window.numbers_shown)
        grab.popup(); self.drain(.3)
        self.assertFalse(window.numbers_shown)
        keys("keyup", "Control_L", wait=.2)
        grab.popdown(); self.drain(.6)
        self.assertFalse(window.numbers_shown)
        keys("keydown", "Control_L", wait=.45)
        self.assertTrue(window.numbers_shown)
        keys("keyup", "Control_L", wait=.2)
        self.assertFalse(window.numbers_shown)
        grab.unparent()

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

    def test_board_moves_only_changed_cards_sets_tooltips_before_rooting_and_shares_badge_styles(self):
        clay = dict(asb.SOURCE_COLOR_PRESETS)["Clay"]
        dashboard = mock_dashboard()
        for row in dashboard["threads"][:6]:
            row.update(sourceCount=2, sourceColor=clay)
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1080, 248)
        window.present(); self.drain(.5)
        self.assertEqual(window.view, "compact")
        # A view change sets the card tooltips while the new controls have no root, so GTK makes no tooltip query.
        roots, update = {}, window.update_card_actions
        def record(widget):
            button = getattr(widget, "asb_read_button", None)
            if button is not None:
                roots.setdefault(widget.asb_thread["id"], button.get_root())
            return update(widget)
        with patch.object(window, "update_card_actions", record):
            window.view_filter.set_selected(1); self.drain(1.5)
        self.assertEqual(roots.keys(), window.focus_widgets.keys())
        self.assertEqual(set(roots.values()), {None})
        self.assertEqual({widget.asb_pin_button.get_tooltip_text() for widget in window.focus_widgets.values()}, {"Pin in ASB"})
        # The board badges share one style class, and they paint the color of the Profiles preset.
        displayed = asb.display_source_color(clay, window.profile_surfaces)
        badges = [window.focus_widgets[row["id"]].asb_source_badge for row in dashboard["threads"][:6]]
        self.assertEqual([[name for name in badge.get_css_classes() if name.startswith("asb-badge")] for badge in badges],
                         [["asb-badge-" + displayed[1:]]] * len(badges))
        self.settle(window)
        for badge in badges:
            snapshot = asb.Gtk.Snapshot()
            asb.Gtk.WidgetPaintable.new(badge).snapshot(snapshot, badge.get_width(), badge.get_height())
            renderer = asb.Gsk.CairoRenderer()
            renderer.realize(None)
            downloader = asb.Gdk.TextureDownloader.new(renderer.render_texture(snapshot.to_node(), None))
            downloader.set_format(asb.Gdk.MemoryFormat.R8G8B8A8)
            data, stride = downloader.download_bytes()
            renderer.unrealize()
            center = (badge.get_height() // 2) * stride + (badge.get_width() // 2) * 4
            painted = data.get_data()[center:center + 3]
            self.assertTrue(all(abs(value - int(displayed[1 + 2 * index:3 + 2 * index], 16)) <= 1
                                for index, value in enumerate(painted)), (bytes(painted).hex(), displayed))
        # A reorder to the top moves only the cards that change column or order; every card keeps its widget.
        hooks = list(window.popover_hooks)
        widgets = dict(window.focus_widgets)
        parents = {identity: widget.get_parent() for identity, widget in widgets.items()}
        last = window.row_order[-1]
        removed = []
        for listing in window.list_columns:
            listing.remove = lambda widget, listing=listing: (removed.append(widget), asb.Gtk.ListBox.remove(listing, widget))[1]
        window.dashboard["threads"] = [{**row, "pinned": True, "pinIndex": 0} if row["id"] == last else row
                                       for row in window.dashboard["threads"]]
        window.render(); self.drain(.2)
        for listing in window.list_columns:
            del listing.remove
        self.assertEqual(window.row_order[0], last)
        self.assertEqual(window.focus_widgets, widgets)
        columns = [listing for listing in window.list_columns if listing.get_parent()]
        for number, listing in enumerate(columns):
            cards, card = [], listing.get_row_at_index(0)
            while card is not None:
                cards.append(card.asb_focus_key)
                card = listing.get_row_at_index(len(cards))
            self.assertEqual(cards, window.row_order[number * window.capacity:(number + 1) * window.capacity])
        moved = {widget.asb_focus_key for widget in removed}
        # The new first card and the last card of each full column move; all other cards stay in their column.
        self.assertIn(last, moved)
        self.assertLessEqual(len(moved), len(columns) + 1)
        self.assertTrue(all(widgets[identity].get_parent() is parents[identity] for identity in widgets.keys() - moved))
        # The render puts the popover hooks back, and a popover that opens after it still blocks the numbers.
        self.assertEqual(len(window.popover_hooks), len(hooks))
        quiet = asb.Gtk.Popover(autohide=False, child=asb.Gtk.Label(label="Synthetic popup after a render"))
        quiet.set_parent(window.menu_button)
        quiet.popup(); self.drain(.2)
        self.assertIn(quiet, window.open_popovers)
        self.assertTrue(window.numbers_blocked())
        quiet.popdown(); quiet.unparent(); self.drain()
        window.close(); self.drain()
        self.assertEqual(window.popover_hooks, [])

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

    def test_horizontal_short_wheel_focus_dividers_and_preferences_focus(self):
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
        self.assertGreater(window.menu_button.get_width(), 0)
        window.menu_button.emit("clicked"); self.drain(.2)
        preferences = window.preferences_window
        self.assertTrue(preferences.get_visible())
        preferences.stack.set_visible_child_name("appearance")
        window.view_filter.grab_focus(); self.drain()
        window.view_filter.set_selected(1); self.drain()
        self.assertTrue(preferences.get_visible())
        self.assertIs(preferences.get_focus().get_root(), preferences)
        self.assertTrue(preferences.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
        self.drain()
        self.assertFalse(preferences.get_visible())
        self.assertEqual(window.focus_key(), identity)
        window.close(); self.drain(.03)

    def test_repack_keeps_focus_when_a_frame_comes_before_the_restore(self):
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", mock_dashboard(),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1080, 248)
        window.present(); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.3); window.check_geometry(); self.drain()
        last = window.row_order[-1]
        window.focus_widgets[last].grab_focus(); self.drain()
        self.assertEqual(window.focus_key(), last)
        # Hold the queued restore so that GTK lays out a frame first, as on a slow display.
        held = []
        idle_add = asb.GLib.idle_add
        def hold(callback, *args, **kwargs):
            if getattr(callback, "__name__", "") == "restore_position":
                held.append((callback, args))
                return 0
            return idle_add(callback, *args, **kwargs)
        with patch.object(asb.GLib, "idle_add", hold):
            window.set_default_size(680, 500); self.drain(.3)
        self.assertTrue(held)
        self.assertEqual(window.focus_key(), last)
        for callback, args in held:
            callback(*args)
        self.drain()
        self.assertEqual(window.focus_key(), last)
        self.assert_focus_visible(window, last)

    def board_window(self, count, limit=0):
        # No server: a failed refresh shows a notice, and the notice changes the list height.
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", {"generatedAtMs": NOW, "providers": [], "threads": board_rows(count)},
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        # A column that lost a card from its internal list loops forever when GTK frees it; a failed test must not leave one.
        self.addCleanup(lambda: [card.unparent() for column in window.list_columns for card in board_children(column)])
        window.card_limit = limit
        window.set_default_size(1000, 500)
        window.present(); self.drain(.3)
        window.render(); self.drain(.2)
        GTK_WARNINGS.clear()
        return window

    def assert_board_columns(self, window, laid_out=False):
        """Each column holds its target cards in the target order, as widget children and in the internal list of GTK."""
        shown = [column for column in window.list_columns if column.get_parent()]
        self.assertEqual(len(shown), window.actual_columns)
        for number, column in enumerate(shown):
            target = [window.focus_widgets[identity] for identity in window.row_order[number * window.capacity:(number + 1) * window.capacity]]
            self.assertEqual(board_children(column), target)
            self.assertEqual(board_listed(column), target)
            if laid_out:
                # Each card sits right under the one before it: no empty slot.
                bottom = 0
                for card in target:
                    self.assertEqual(round(card.compute_bounds(column)[1].origin.y), bottom)
                    bottom += card.get_height()
        self.assertTrue(all(not board_children(column) and not board_listed(column) for column in window.list_columns if not column.get_parent()))
        self.assertEqual(GTK_WARNINGS, [])
        return shown

    def test_board_shows_one_card_for_a_row_id_that_comes_twice(self):
        window = self.board_window(70)
        columns, order, initial = list(window.list_columns), list(window.row_order), copy.deepcopy(window.dashboard)
        # Two rows with one ID go to the top: the same card is twice in the target of the first column and moves into it.
        row = next(row for row in initial["threads"] if row["id"] == order[window.capacity + 3])
        board = copy.deepcopy(initial)
        board["threads"] = [{**row, "pending": True, "unread": True, "updatedAtMs": NOW + 60_000}] * 2 + board["threads"]
        window.apply_dashboard(board, None); self.drain(.3)
        self.assertEqual((window.row_order[0], window.row_order.count(row["id"]), len(window.row_order)), (row["id"], 1, 70))
        self.assertEqual(self.assert_board_columns(window, laid_out=True), columns[:window.actual_columns])
        # The board without the second row: the card goes back to its column.
        window.apply_dashboard(copy.deepcopy(initial), None); self.drain(.3)
        self.assertEqual(window.row_order, order)
        self.assertEqual(self.assert_board_columns(window, laid_out=True), columns[:window.actual_columns])

    def test_board_never_inserts_a_card_twice_or_with_a_parent(self):
        window = self.board_window(70)
        columns = list(window.list_columns)
        original = asb.column_moves
        def twice(current, target):
            # The same card twice in the moves of one column, as one card twice in a column target gives.
            removals, inserts = original(current, target)
            return removals, inserts + inserts[:1]
        with patch.object(asb, "column_moves", twice):
            board = copy.deepcopy(window.dashboard)
            board["threads"][window.capacity * 2]["updatedAtMs"] = NOW + 60_000
            board["threads"][window.capacity * 2]["pending"] = True
            window.apply_dashboard(board, None); self.drain(.3)
        self.assertEqual(window.row_order[0], board["threads"][window.capacity * 2]["id"])
        self.assertEqual(self.assert_board_columns(window, laid_out=True), columns[:window.actual_columns])

    def test_board_replaces_the_columns_when_the_internal_list_of_one_has_a_stale_entry(self):
        window = self.board_window(70)
        self.assertGreaterEqual(window.actual_columns, 3)
        columns = list(window.list_columns)
        first, second, third = columns[:3]
        # GTK 4 gives no warning when a card of a column is inserted into the same column again: the internal list holds it twice.
        # The first column then keeps a stale entry for a card that left the widget tree, the second column lists a card twice.
        # GTK lays out the internal list, so each stale entry takes a slot that no card fills.
        card = first.get_row_at_index(1)
        first.insert(card, 0)
        first.remove(card)
        # The last card of a column is the one that a card at the top pushes into the next column.
        second.insert(second.get_row_at_index(window.capacity - 1), 2)
        self.assertNotEqual(board_listed(first), board_children(first))
        self.assertNotEqual(board_listed(second), board_children(second))
        GTK_WARNINGS.clear()
        window.focus_widgets[window.row_order[window.capacity + 3]].grab_focus(); self.drain(.1)
        focused = window.focus_key()
        # A pending card goes to the top: it moves from the third column to the first.
        board = copy.deepcopy(window.dashboard)
        moved = window.row_order[2 * window.capacity + 2]
        next(row for row in board["threads"] if row["id"] == moved).update(pending=True, unread=True, updatedAtMs=NOW + 60_000)
        window.apply_dashboard(board, None); self.drain(.3)
        self.assertEqual(window.row_order[0], moved)
        shown = self.assert_board_columns(window, laid_out=True)
        # All columns are new. The old ones stay alive, with no card, because a card can still point into their internal list.
        self.assertTrue(set(columns).isdisjoint(shown))
        self.assertEqual(window.retired_columns[:len(columns)], columns)
        self.assertEqual([board_children(column) for column in window.retired_columns], [[]] * len(window.retired_columns))
        self.assertEqual(window.focus_key(), focused)
        # Closing the window works with the old columns kept.
        window.close(); self.drain(.2)
        self.assertEqual((window.list_columns, GTK_WARNINGS), ([], []))

    def test_board_columns_hold_their_cards_after_many_refreshes(self):
        # The live pattern: pending cards change their time at each scan and change places, some cards go to another column,
        # cards leave and come in, the More card shows and goes away, and sometimes two rows have one ID.
        window = self.board_window(96, limit=90)
        generator = random.Random(20261020)
        serial, more, doubled = 0, set(), 0
        for tick in range(500):
            board = copy.deepcopy(window.dashboard)
            rows = board["threads"]
            for row in rows:
                if row["pending"]:
                    row["updatedAtMs"] = NOW + tick * 1000 + generator.randrange(900)
            for row in generator.sample(rows, generator.randrange(4)):
                row.update(pending=not row["pending"], unread=not row["pending"], updatedAtMs=NOW + tick * 1000 + generator.randrange(900))
            if len(rows) > 88 and generator.random() < .4:
                del rows[generator.randrange(len(rows))]
            if len(rows) < 98 and generator.random() < .4:
                serial += 1
                rows.append({**board_rows(1)[0], "id": f"new{serial}", "title": f"New session {serial}", "updatedAtMs": NOW + tick * 1000,
                             "pending": generator.random() < .5})
            if generator.random() < .15:
                rows.insert(0, {**generator.choice(rows), "pending": True, "unread": True, "updatedAtMs": NOW + tick * 1000})
            elif generator.random() < .5:
                seen = set()
                rows[:] = [row for row in rows if not (row["id"] in seen or seen.add(row["id"]))]
            doubled += len({row["id"] for row in rows}) < len(rows)
            if tick % 25 == 0:
                window.focus_widgets[window.row_order[generator.randrange(20)]].grab_focus()
            if tick % 125 == 100:
                window.width_control.set_value(160 if window.column_width == 240 else 240)
            window.apply_dashboard(board, None)
            if tick % 10 == 0:
                self.drain(.02)
            self.assert_board_columns(window)
            more.add(asb.MORE_ID in window.row_order)
        self.assertEqual(more, {True, False})
        self.assertGreater(doubled, 20)
        self.drain(.3)
        self.assert_board_columns(window, laid_out=True)

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

        # A geometry repack sets motion_from to False until its layout; wait for that layout too.
        wait(lambda: len(frames) >= 3 and len(columns()) == 6 and columns()[0].get_width() == window.column_pixel_width
             and window.motion_from is None)
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
        wait(lambda: columns()[0].get_width() == window.column_pixel_width and window.motion_from is None)
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

    def test_usage_limit_card_greys_counts_down_and_lifts_at_the_reset(self):
        now = time.time() * 1000
        rows = [{"id": "limited", "provider": "codex", "providerLabel": "Codex", "sourceLabel": "Codex Personal",
                 "title": "Plan the alarm export", "cwd": "/example/alarms", "projectName": "alarms", "state": "idle",
                 "canOpen": True, "updatedAtMs": now - 600_000, "limitResetsAtMs": now + 12_000},
                {"id": "normal", "provider": "codex", "providerLabel": "Codex", "title": "Test the offline mode",
                 "cwd": "/example/mobile", "projectName": "mobile", "state": "idle", "canOpen": True, "updatedAtMs": now - 60_000}]
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", {"generatedAtMs": now, "providers": [], "threads": rows},
                                       theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(520, 400)
        window.present(); window.set_focus(None); self.drain(.3)
        window.apply_dashboard(window.dashboard, None)
        self.assertEqual(window.clock_interval, 2)
        self.assertTrue(asb.Gtk.IconTheme.get_for_display(window.get_display()).has_icon("preferences-system-time-symbolic"))
        hex_color = lambda label: asb.SwitchboardWindow.hex_color(label.get_color())
        background = window.native_colors()["background"]
        for view in (1, 0):
            window.view_filter.set_selected(view); self.settle(window)
            limited, normal = window.focus_widgets["limited"], window.focus_widgets["normal"]
            self.assertTrue(limited.has_css_class("asb-limited"))
            self.assertFalse(normal.has_css_class("asb-limited"))
            self.assertTrue(limited.asb_limit_clock.get_visible())
            self.assertEqual(limited.asb_limit_clock.get_icon_name(), "preferences-system-time-symbolic")
            self.assertFalse(normal.asb_limit_clock.get_visible())
            self.assertFalse(limited.asb_dot.get_visible())
            self.assertEqual(self.ink(limited.asb_dot), 0)
            self.assertEqual(limited.get_height(), normal.get_height())
            if view:
                self.assertEqual(limited.asb_state_label.get_text(), "Resets in")
                self.assertRegex(limited.asb_age_label.get_text(), r"^\d{1,2}s$")
                self.assertIs(limited.asb_limit_clock.get_next_sibling(), limited.asb_state_label)
                # Dimmer than the quiet text of the normal read Idle row, with 4.5:1 on the background.
                for name in ("asb_title_label", "asb_folder", "asb_state_label", "asb_age_label"):
                    grey, quiet = hex_color(getattr(limited, name)), hex_color(getattr(normal, name))
                    self.assertGreaterEqual(asb.contrast(grey, background), 4.5)
                    self.assertLess(asb.contrast(grey, background), asb.contrast(quiet, background))
            else:
                self.assertRegex(limited.asb_state_label.get_text(), r"^Resets \d{1,2}s$")
                self.assertIs(limited.asb_limit_clock.get_next_sibling(), limited.asb_dot)
            self.assertRegex(limited.asb_accessible_label, r"^Open Plan the alarm export in Codex\. Idle\. Usage limit\. Resets in \d{1,2} seconds?\.$")
            self.assert_accessible_label(limited, limited.asb_accessible_label)
            tooltip = SimpleNamespace(set_custom=lambda _content: None)
            window.query_row_tooltip(limited, 0, 0, False, tooltip)
            self.assertRegex(limited.asb_tooltip_key[0]["limit"], r"^Codex Personal is out of usage\. It resets at 1?\d:\d\d [AP]M\.$")
        # The local clock lifts the grey at the reset, with no data read.
        while time.time() * 1000 <= rows[0]["limitResetsAtMs"]:
            self.drain(.1)
        with patch.object(window, "render") as render:
            window.update_clock(); self.settle(window)
            render.assert_not_called()
        limited = window.focus_widgets["limited"]
        self.assertFalse(limited.has_css_class("asb-limited"))
        self.assertFalse(limited.asb_limit_clock.get_visible())
        self.assertEqual(limited.asb_state_label.get_text(), "Idle")
        self.assertEqual(limited.asb_accessible_label, "Open Plan the alarm export in Codex. Idle.")
        self.assertEqual(window.clock_interval, 60)
        window.view_filter.set_selected(1); self.settle(window)
        limited, normal = window.focus_widgets["limited"], window.focus_widgets["normal"]
        self.assertEqual((limited.asb_state_label.get_text(), limited.asb_age_label.get_text()), ("Idle", "10m ago"))
        self.assertFalse(limited.asb_limit_clock.get_visible())
        self.assertEqual(hex_color(limited.asb_title_label), hex_color(normal.asb_title_label))

    def test_view_only_cards_show_where_they_run_in_the_grey_tone_and_do_not_open(self):
        now = time.time() * 1000
        def row(identity, **extra):
            return {"id": identity, "externalId": identity, "provider": "claude-desktop-code", "providerLabel": "Claude Code CLI",
                    "title": "Check the " + identity, "cwd": "/example/" + identity, "projectName": identity, "state": "idle",
                    "canOpen": False, "appDeepLink": "", "updatedAtMs": now - 720_000, "unread": False, "pending": False, **extra}
        rows = [row("cli", surface="cli"), row("remote", surface="app", remote=True, machineName="homeLP", state="working"),
                row("desktop", providerLabel="Claude Desktop Code", surface="app", canOpen=True,
                    appDeepLink="claude://code/continue?session=local_x"),
                row("unread", surface="cli", unread=True, pendingSource="observed-completion", completionAttention=True)]
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", {"generatedAtMs": now, "providers": [], "threads": rows},
                                       theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(720, 500)
        window.present(); window.set_focus(None); self.drain(.3)
        theme = asb.Gtk.IconTheme.get_for_display(window.get_display())
        self.assertTrue(theme.has_icon("asb-machine-symbolic") and theme.has_icon("asb-terminal-symbolic"))
        hex_color = lambda widget: asb.SwitchboardWindow.hex_color(widget.get_color())
        for view in (0, 1):
            window.view_filter.set_selected(view); self.settle(window)
            cards = {identity: window.focus_widgets[identity] for identity in ("cli", "remote", "desktop", "unread")}
            comfortable = window.view == "comfortable"
            for identity, text, icon in (("cli", "CLI", "asb-terminal-symbolic"), ("remote", "homeLP", "asb-machine-symbolic")):
                card = cards[identity]
                self.assertEqual(card.asb_where_label.get_text(), text + " ·" if comfortable else "· " + text)
                self.assertTrue(card.asb_where_label.get_visible())
                self.assertFalse(card.get_activatable())
                if comfortable:
                    glyph = card.asb_where_icon
                    self.assertEqual((glyph.get_icon_name(), glyph.get_gicon().get_file().get_basename(), glyph.get_visible()),
                                     (None, icon + ".svg", True))
                    self.assertTrue(glyph.get_gicon().get_file().query_exists(None))
                    self.assertIs(card.asb_where_label.get_next_sibling(), card.asb_age_label)
                    self.assertEqual(card.asb_age_label.get_text(), "12m ago")
                else:
                    self.assertIsNone(card.asb_where_icon)
                    self.assertIs(card.asb_state_label.get_next_sibling(), card.asb_where_label)
            self.assertFalse(cards["desktop"].asb_where_label.get_visible())
            self.assertTrue(cards["desktop"].get_activatable())
            # The Grey tone: a resting view-only row dims its title and state, a Working one keeps the state color.
            self.assertEqual((cards["cli"].has_css_class("asb-view-only-quiet"), cards["cli"].has_css_class("asb-view-only-rest")), (True, True))
            self.assertEqual((cards["remote"].has_css_class("asb-view-only-quiet"), cards["remote"].has_css_class("asb-view-only-rest")),
                             (True, False))
            self.assertFalse(cards["unread"].has_css_class("asb-view-only-quiet"))
            self.assertNotEqual(hex_color(cards["cli"].asb_title_label), hex_color(cards["unread"].asb_title_label))
            self.assertNotEqual(hex_color(cards["cli"].asb_state_label), hex_color(cards["remote"].asb_state_label))
            self.assertRegex(cards["cli"].asb_accessible_label, r"^Session Check the cli in Claude Code CLI\. Idle\. CLI session\. View only\.$")
            self.assertRegex(cards["remote"].asb_accessible_label, r"^Session Check the remote in Claude Code CLI\. Working\. On homeLP\. View only\.$")
            self.assert_accessible_label(cards["cli"], cards["cli"].asb_accessible_label)
        # The row panel says why the card does not open.
        for identity, label in (("cli", "Runs in a terminal"), ("remote", "On homeLP")):
            window.show_context(window.focus_widgets[identity]); self.drain(.3)
            panel = window.context_menu
            self.assertEqual((panel.asb_open.asb_label.get_label(), panel.asb_open.get_sensitive()), (label, False))
            panel.popdown(); self.drain(.2)
        # The provider marks load as file icons, so that GTK recolors them with the card CSS.
        file_icon = lambda image: (image.get_icon_name(), image.get_gicon().get_file().get_basename(), image.get_gicon().get_file().query_exists(None))
        self.assertEqual(file_icon(window.app_pills["codex"].get_child().get_first_child()), (None, "asb-openai-symbolic.svg", True))
        tooltip = SimpleNamespace(set_custom=lambda content: setattr(tooltip, "content", content))
        self.assertTrue(window.query_row_tooltip(window.focus_widgets["desktop"], 0, 0, False, tooltip))
        mark = tooltip.content.get_first_child().get_first_child()
        self.assertTrue(mark.has_css_class("asb-provider"))
        self.assertEqual(file_icon(mark), (None, "asb-claude-symbolic.svg", True))
        # A reused card that changes its provider shows the new mark.
        card = window.focus_widgets["desktop"]
        self.assertEqual(file_icon(card.asb_mark), (None, "asb-claude-symbolic.svg", True))
        window.update_session_row(card, {**card.asb_thread, "provider": "codex"})
        self.assertEqual(file_icon(card.asb_mark), (None, "asb-openai-symbolic.svg", True))

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
        pill, bubble, cards, hover = window.drawer_only, window.drawer_dot, window.focus_widgets, asb.Gtk.StateFlags.PRELIGHT
        put, out = "Put in drawer: look read here, keep it under Drawer", "Take out of drawer: show as unread again"
        def reply(identity, **change):
            requests[-1][2]({"changed": True, "threadId": identity, "thread": dict(cards[identity].asb_thread, **change)}, None)
            settle()

        # The pill: glyph, optional word, and a dot that is hidden when empty.
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
        self.assert_accessible_label(pill, "Drawer only. The drawer is empty.")
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
        copy_button = one.asb_copy_button
        # Copy is first: copy, drawer, read, pin. Every state has it, and every wide corner fades the title for it.
        self.assertIs(drawer.get_parent().get_first_child(), copy_button)
        self.assertIs(copy_button.get_next_sibling(), drawer)
        self.assertIs(drawer.get_next_sibling().get_first_child(), read)
        self.assertIs(drawer.get_next_sibling().get_next_sibling(), one.asb_pin_button)
        self.assertEqual((copy_button.get_width(), copy_button.get_height(), copy_button.asb_action, copy_button.get_child().get_icon_name()),
                         (24, 24, "win.copy-reference", "edit-copy-symbolic"))
        self.assertEqual(copy_button.get_child().get_pixel_size(), 12)
        self.assertEqual(copy_button.get_tooltip_text(), "Copy relative reference")
        self.assert_accessible_label(copy_button, "Copy relative reference: " + one.asb_thread["title"])
        self.assertTrue(all(card.asb_copy_button.get_visible() and card.asb_copy_button.get_parent().has_css_class("asb-corner-wide")
                            for card in cards.values()))
        self.assertEqual(self.ink(cards["s3"].asb_copy_button.get_parent()), 0)  # A corner at rest has no ink.
        self.assertEqual((drawer.get_width(), drawer.get_height(), drawer.asb_action), (24, 24, "win.drawer-in"))
        self.assertEqual(drawer.get_tooltip_text(), put)
        self.assert_accessible_label(drawer, put + ": " + one.asb_thread["title"])
        # The title has the same allocation with three buttons and with two.
        self.assertIs(one.get_parent(), question.get_parent())
        self.assertEqual(one.asb_title_label.get_width(), question.asb_title_label.get_width())
        self.assertEqual(one.asb_title_label.get_width(), one.get_width() - 16 - 21 - 54)
        self.assertEqual((one.get_height(), one.asb_title_label.get_height()), (68, 32))
        self.assertEqual((self.ink(one.asb_dot), self.ink(cue), self.ink(drawer), self.ink(one.asb_state_label)), (255, 0, 0, 255))
        self.assertEqual(self.ink(copy_button), 0)
        self.hover_card(window, one, True); self.hover_card(window, question, True); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(drawer), self.ink(copy_button), self.ink(question.asb_copy_button)), (0, 255, 255, 255))
        self.assertGreater(self.ink(cue), 0)
        self.assertLess(self.ink(one.asb_state_label), 255)  # The read tone.
        self.assertGreater(self.ink(question.asb_dot), 0)  # A ? does not change.
        self.hover_card(window, one, False); self.hover_card(window, question, False); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(cue), self.ink(drawer), self.ink(copy_button)), (255, 0, 0, 0))
        # Focus from a mouse click (not visible) does not change the row. Visible keyboard focus shows the controls.
        shown = lambda: (self.ink(one.asb_dot), self.ink(drawer), self.ink(cue) > 0, self.ink(one.asb_state_label), self.ink(copy_button))
        for focus in (one, read, drawer, copy_button):
            window.set_focus(focus); window.set_focus_visible(False); settle()
            self.assertFalse(one.has_css_class("asb-key-focus"))
            if focus is one:
                self.assertEqual(shown(), (255, 0, False, 255, 0))
                self.assertGreater(self.ink(one.asb_pin_button), 0)  # The pin rule of 1.5.0 stays.
            self.assertEqual((self.ink(one.asb_dot), self.ink(drawer), self.ink(copy_button)), (255, 0, 0))
            window.set_focus_visible(True); settle()
            self.assertTrue(one.has_css_class("asb-key-focus"))
            self.assertEqual(shown(), (0, 255, True, 255, 255))
        window.set_focus(cards["s2"]); settle()
        self.assertFalse(one.has_css_class("asb-key-focus"))
        self.assertEqual(shown(), (255, 0, False, 255, 0))
        window.set_focus(one)  # Tab goes to copy, drawer, read, pin.
        for control in (copy_button, drawer, read, one.asb_pin_button):
            self.assertTrue(one.child_focus(asb.Gtk.DirectionType.TAB_FORWARD))
            self.assertIs(window.get_focus(), control)
        window.set_focus(None); window.set_focus_visible(False); settle()
        self.assertFalse(one.has_css_class("asb-key-focus"))

        # A click sends drawer-in. After the reply the row looks read, sorts with the read rows, and lights the dot.
        drawer.emit("clicked")
        self.assertEqual((requests[-1][1], requests[-1][4], requests[-1][5]), ("/api/threads/s1/drawer-in", "POST", None))
        self.assertIsNone(drawer.asb_action)
        self.assertTrue(drawer.has_css_class("asb-action-pending"))
        window.dashboard_etag = "etag"
        reply("s1", unread=False, pending=False, drawer=True)
        self.assertIs(cards["s1"], one)
        self.assertIsNone(window.dashboard_etag)
        self.assertEqual(window.row_order, ["s2", "s5", "s4", "s1", "s3"])
        self.assertFalse(hasattr(window, "count"))
        self.assertTrue(one.has_css_class("asb-drawer") and one.has_css_class("asb-idle-read"))
        self.assertEqual((self.ink(one.asb_dot), self.ink(read), self.ink(drawer)), (0, 0, 0))
        self.assertEqual((bubble.get_visible(), pill.has_css_class("asb-drawer-filled")), (True, True))
        self.assert_accessible_label(pill, "Drawer only. The drawer has sessions.")
        self.assertEqual((drawer.get_visible(), drawer.asb_action, drawer.has_css_class("asb-drawer-filled")),
                         (True, "win.drawer-out", True))
        self.assertFalse(drawer.has_css_class("asb-action-pending"))
        self.assertEqual(drawer.get_tooltip_text(), out)
        self.assert_accessible_label(drawer, out + ": " + one.asb_thread["title"])
        self.assertTrue(one.asb_accessible_label.endswith(" Task completed. In the drawer. Still unread."))
        self.assert_accessible_label(one, one.asb_accessible_label)
        self.assertIn("Finished. Not read yet.\nIn the drawer", one.asb_tooltip)
        self.assertEqual(asb.row_menu_actions(one.asb_thread)[:2], [("Read", "mark-read"), ("Take out of drawer", "drawer-out")])
        self.hover_card(window, one, True); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(read), self.ink(drawer)), (0, 255, 255))
        self.assertGreater(self.ink(cue), 0)
        self.hover_card(window, one, False); settle()

        # Peek changes only the drawer cards; CSS shows their unread look without a render.
        controllers = pill.observe_controllers()
        peek = next(controller for controller in (controllers.get_item(index) for index in range(controllers.get_n_items()))
                    if isinstance(controller, asb.Gtk.EventControllerMotion))
        for palette in (None, CUSTOM):
            window.set_palette(palette)
            for view in (0, 1):
                window.view_filter.set_selected(view); settle(); window.set_focus(None); settle()
                one, two = cards["s1"], cards["s2"]
                if view:  # Copy and its corner have no ink at rest, also with the check of a copy.
                    window.activate_action("win.copy-reference", asb.GLib.Variant("s", "s3")); settle()
                    rest = cards["s3"].asb_copy_button
                    self.assertTrue(rest.has_css_class("asb-copy-confirmed"))
                    self.assertEqual((self.ink(rest), self.ink(rest.get_parent()), self.ink(two.asb_copy_button)), (0, 0, 0))
                    self.hover_card(window, cards["s3"], True); self.hover_card(window, two, True)
                    two.asb_copy_button.set_state_flags(hover, False); settle()
                    self.assertEqual(self.ink(rest), 255)
                    if palette:  # Only the check uses the accent; the copy icon keeps the text color.
                        self.assertEqual((window.hex_color(rest.get_color()), window.hex_color(two.asb_copy_button.get_color())),
                                         (palette["accent"], palette["text"]))
                    self.hover_card(window, cards["s3"], False); self.hover_card(window, two, False); two.asb_copy_button.unset_state_flags(hover); settle()
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
                    self.hover_card(window, two, True); settle()  # The hover rule holds in both views.
                    self.assertEqual(self.ink(two.asb_dot), 0)
                    if view:
                        self.assertEqual(self.ink(two.asb_drawer_button), 255)
                    self.hover_card(window, two, False); settle()
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
        self.assertFalse(hasattr(window, "count"))
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
        self.assertEqual((self.ink(one.asb_dot), drawer.asb_action), (255, "win.drawer-in"))

        # A column narrower than 190 px has no drawer button; the corner is the Read and Pin pair.
        window.width_control.set_value(160); settle()
        self.assertLess(window.column_pixel_width, 190)
        self.assertFalse(any(card.asb_drawer_button.get_visible() or card.asb_copy_button.get_visible()
                             or card.asb_copy_button.get_parent().has_css_class("asb-corner-wide") for card in cards.values()))
        self.assertTrue(one.asb_read_button.get_visible() and one.asb_pin_button.get_visible())
        self.assertIn(("Put in drawer", "drawer-in"), asb.row_menu_actions(one.asb_thread))
        window.width_control.set_value(240); settle()
        self.assertEqual({identity: card.asb_drawer_button.get_visible() for identity, card in cards.items()},
                         {"s1": True, "s2": True, "s3": False, "s4": False, "s5": False})

        # The pill follows the other pills at 680 px and stays usable at 320 px with a count.
        drawer.emit("clicked")
        reply("s1", unread=False, pending=False, drawer=True)
        self.assertTrue(bubble.get_visible())
        # The occupancy dot follows the archive setting. Search and the other filters do not change it.
        board = copy.deepcopy(window.dashboard)
        board["threads"].append(row(6, drawer=True, archived=True))
        window.apply_dashboard(board, None); settle()
        self.assertTrue(bubble.get_visible())
        window.archive.set_active(True); settle()
        self.assertTrue(bubble.get_visible())
        self.assert_accessible_label(pill, "Drawer only. The drawer has sessions.")
        window.search.set_text("no such session"); window.app_pills["claude-desktop-code"].set_active(True); settle()
        self.assertEqual((bubble.get_visible(), window.row_order), (True, []))
        window.search.set_text(""); window.app_pills["claude-desktop-code"].set_active(False); pill.set_active(True); settle()
        self.assertEqual(window.row_order, ["s1", "s6"])
        window.archive.set_active(False); settle()
        self.assertEqual((bubble.get_visible(), window.row_order), (True, ["s1"]))
        self.assert_accessible_label(pill, "Drawer only. The drawer has sessions.")
        pill.set_active(False); settle()
        for width, wide in ((320, False), (700, True)):
            window.set_default_size(width, 400); settle(); window.check_geometry(); settle()
            self.assertEqual((window.get_width(), window.wide_controls), (width, wide))
            self.assertIs(pill.get_parent().get_parent(), window.toolbar_strip)
            self.assertEqual(self.ink(bubble), 255)
            self.assertGreater(self.ink(pill.get_child().get_first_child()), 0)
        # The occupancy dot has no numeral, including large drawers.
        for count in (99, 100, 120):
            board = {"generatedAtMs": NOW, "providers": [], "threads": [row(n, drawer=True) for n in range(count)]}
            window.apply_dashboard(board, None); settle()
            self.assertTrue(bubble.get_visible())
            self.assertFalse(isinstance(bubble, asb.Gtk.Label))
            self.assert_accessible_label(pill, "Drawer only. The drawer has sessions.")
        window.close(); self.drain(.03)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer clicks need xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_muted_card_icon_by_the_name_panel_switch_and_no_discard_ring(self):
        def row(identity, **extra):
            return {"id": identity, "provider": "codex", "providerLabel": "Codex", "title": "Summarize the open issues " + identity,
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "updatedAtMs": NOW, **extra}
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            row("read", muted=True), row("busy", state="working", muted=True), row("plain", state="working"),
            row("asked", state="waiting", muted=True, pending=True, questionAttention=True, questionPending=True),
            row("other", updatedAtMs=NOW - 60_000)]}
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
        settle()
        cards = window.focus_widgets
        def bounds(widget, card):
            found, rectangle = widget.compute_bounds(card)
            self.assertTrue(found)
            return rectangle.origin.x, rectangle.origin.y, rectangle.size.width, rectangle.size.height
        def beside(card, before, sibling=None):
            glyph = card.asb_mute_glyph
            self.assertIs(glyph.get_prev_sibling(), sibling or before)
            self.assertTrue(glyph.get_visible() and glyph.get_mapped())
            # The ASB glyph, a file icon so that GTK recolors it; no theme icon is left on the card.
            self.assertEqual((glyph.get_storage_type(), glyph.get_icon_name(), glyph.get_pixel_size()),
                             (asb.Gtk.ImageType.GICON, None, 12))
            self.assertEqual(glyph.get_gicon().get_file().get_basename(), "asb-muted-symbolic.svg")
            self.assertTrue(glyph.get_gicon().get_file().query_exists(None))
            self.assertTrue(glyph.has_css_class("asb-mute-glyph") and glyph.has_css_class("dim-label"))
            x, y, width, height = bounds(glyph, card)
            bx, by, bwidth, bheight = bounds(before, card)
            self.assertGreaterEqual(x, bx + bwidth)
            self.assertLessEqual(x, bx + bwidth + 8)
            self.assertLessEqual(abs((y + height / 2) - (by + bheight / 2)), 2)
            self.assertLessEqual(x + width, card.get_width())
            return x

        # Comfortable: the icon follows the folder name on the top line, only for a muted row.
        self.assertEqual({identity: card.asb_mute_glyph.get_visible() for identity, card in cards.items()},
                         {"read": True, "busy": True, "plain": False, "asked": True, "other": False})
        for identity in ("read", "busy", "asked"):
            beside(cards[identity], cards[identity].asb_folder)
        # A muted Working card has no Discard ring, also on hover; an unmuted one keeps it.
        busy, plain = cards["busy"], cards["plain"]
        self.hover_card(window, busy, True); self.hover_card(window, plain, True); settle()
        self.assertFalse(busy.asb_read_button.get_visible())
        self.assertFalse(busy.asb_read_button.has_css_class("asb-discard-offer"))
        self.assertEqual(self.ink(busy.asb_dot), 0)
        self.assertTrue(plain.asb_read_button.get_visible() and plain.asb_read_button.has_css_class("asb-discard-offer"))
        self.assertGreater(self.ink(plain.asb_dot), 0)
        self.hover_card(window, busy, False); self.hover_card(window, plain, False); settle()
        # A narrow column ellipsizes a long folder name first; the icon stays visible inside the card.
        dashboard["threads"][0]["projectName"] = "a-very-long-project-folder-name-for-the-mute-check"
        window.apply_dashboard(copy.deepcopy(dashboard), None); settle()
        window.width_control.set_value(160); settle()
        self.assertLess(window.column_pixel_width, 190)
        read = cards["read"]
        self.assertTrue(read.asb_folder.get_layout().is_ellipsized())
        beside(read, read.asb_folder)
        window.width_control.set_value(240); settle()

        # Compact: the icon follows the state and the where label, which is hidden on these app rows.
        window.view_filter.set_selected(0); self.drain(.3); settle()
        self.assertEqual({identity: card.asb_mute_glyph.get_visible() for identity, card in cards.items()},
                         {"read": True, "busy": True, "plain": False, "asked": True, "other": False})
        for identity in ("read", "busy", "asked"):
            self.assertIs(cards[identity].asb_where_label.get_prev_sibling(), cards[identity].asb_state_label)
            self.assertFalse(cards[identity].asb_where_label.get_visible())
            beside(cards[identity], cards[identity].asb_state_label, cards[identity].asb_where_label)
        window.view_filter.set_selected(1); self.drain(.3); settle()

        # The row panel: Mute comes right after the drawer slot and before Pin, and sends mute and then unmute.
        other = cards["other"]
        window.show_context(other); self.drain()
        panel = window.context_menu
        muted = panel.asb_actions["mute"]
        self.assertEqual(list(panel.asb_actions)[:4], ["read", "drawer", "mute", "pin"])
        self.assertIs(panel.asb_actions["drawer"].get_next_sibling(), muted)
        self.assertIs(muted.get_next_sibling(), panel.asb_actions["pin"])
        # The one-tone ASB mute glyph of the cards, as a file icon.
        self.assertEqual((muted.asb_label.get_label(), muted.asb_icon.get_icon_name(), muted.asb_icon.get_gicon().get_file().get_basename()),
                         ("Mute", None, "asb-muted-symbolic.svg"))
        self.assertTrue(muted.get_visible())
        muted.grab_focus()
        muted.emit("clicked")
        self.assertEqual(requests[-1][1], "/api/threads/other/mute")
        self.assertFalse(muted.get_sensitive())
        requests[-1][2]({"changed": True, "threadId": "other", "thread": dict(other.asb_thread, muted=True)}, None); settle()
        self.assertIs(window.context_menu, panel)
        self.assertIs(panel.asb_actions["mute"], muted)
        self.assertEqual((muted.asb_label.get_label(), muted.asb_icon.get_icon_name()), ("Unmute", "preferences-system-notifications-symbolic"))
        self.assertIs(window.get_focus(), muted)
        self.assertTrue(other.asb_mute_glyph.get_visible())
        muted.emit("clicked")
        self.assertEqual(requests[-1][1], "/api/threads/other/unmute")
        requests[-1][2]({"changed": True, "threadId": "other", "thread": dict(other.asb_thread, muted=False)}, None); settle()
        self.assertEqual(muted.asb_label.get_label(), "Mute")
        self.assertFalse(other.asb_mute_glyph.get_visible())
        self.assertEqual([request[1] for request in requests if request[1].startswith("/api/threads/")],
                         ["/api/threads/other/mute", "/api/threads/other/unmute"])
        panel.popdown(); self.drain()
        # A muted Working row offers no Discard action.
        window.show_context(busy); self.drain()
        self.assertFalse(window.context_menu.asb_actions["discard"].get_visible())
        self.assertEqual(window.context_menu.asb_actions["mute"].asb_label.get_label(), "Unmute")
        window.context_menu.popdown(); self.drain()

    def test_message_courier_flight_paint_lit_icons_and_hidden_rows(self):
        def row(n, title):
            return {"id": f"m{n}", "provider": "codex", "providerLabel": "Codex", "title": title, "cwd": "/example/notes",
                    "projectName": "notes", "state": "idle", "canOpen": True, "updatedAtMs": NOW - n * 60_000}
        threads = [row(1, "Draft the release note"), row(2, "Check the parser fixtures"), row(3, "Sort the open issues")]
        at = time.time() * 1000
        def board(*messages):
            # Each pair has one fixed time, so a pair in a later dashboard is the same message.
            return {"generatedAtMs": NOW, "providers": [], "threads": threads,
                    "messages": [{"from": source, "to": target, "atMs": at + int(source[1:]) * 10 + int(target[1:])}
                                 for source, target in messages]}
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", board(("m1", "m3")), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(700, 420)
        window.present()
        self.settle(window)
        strip, rows = window.list_body, window.focus_widgets
        def wait(done, limit=6):
            end = time.monotonic() + limit
            while not done() and time.monotonic() < end:
                self.drain(.02)
            self.assertTrue(done())
        # The first dashboard only marks its messages as seen.
        self.drain(.3)
        self.assertEqual(strip.flights, [])
        window.apply_dashboard(board(("m1", "m3"), ("m3", "m1")), None)
        wait(lambda: strip.flights)
        self.assertEqual(len(strip.flights), 1)
        flight = strip.flights[0]
        self.assertEqual(flight["rows"], (rows["m3"], rows["m1"]))
        for animation in flight["animations"]:
            animation.pause()
        flight["flight"] = .5
        start, end = (point[:2] for point in strip.message_ends(flight))
        head = asb.bezier_point(start, asb.message_control(start, end), end, .5)
        self.assertTrue(end[1] < head[1] < start[1] and head[0] < start[0])
        def pixel(x, y):
            strip.queue_draw()
            self.settle(window)
            snapshot = asb.Gtk.Snapshot()
            asb.Gtk.WidgetPaintable.new(strip).snapshot(snapshot, strip.get_width(), strip.get_height())
            renderer = asb.Gsk.CairoRenderer()
            renderer.realize(None)
            # The node bounds start at the first painted pixel; the viewport keeps strip coordinates.
            viewport = asb.Graphene.Rect().init(0, 0, strip.get_width(), strip.get_height())
            downloader = asb.Gdk.TextureDownloader.new(renderer.render_texture(snapshot.to_node(), viewport))
            downloader.set_format(asb.Gdk.MemoryFormat.R8G8B8A8)
            data, stride = downloader.download_bytes()
            renderer.unrealize()
            offset = int(y) * stride + int(x) * 4
            return tuple(data.get_data()[offset:offset + 4])
        accent = window.message_color()
        expected = tuple(min(255, round(channel * 255)) for channel in (accent.red, accent.green, accent.blue)) + (255,)
        painted = pixel(*head)
        self.assertTrue(all(abs(a - b) <= 3 for a, b in zip(painted, expected)), (painted, expected))
        strip.clear_flights()
        self.assertNotEqual(pixel(*head), painted)
        # A played flight ends with no frame loop at rest.
        window.apply_dashboard(board(("m1", "m3"), ("m3", "m1"), ("m2", "m1")), None)
        wait(lambda: strip.flights)
        wait(lambda: not strip.flights)

        # GNOME animations off: no flight, and both provider icons show the accent color for 2 s.
        settings = window.get_settings()
        settings.set_property("gtk-enable-animations", False)
        self.addCleanup(settings.set_property, "gtk-enable-animations", True)
        window.apply_dashboard(board(("m1", "m2")), None)
        wait(lambda: rows["m1"].has_css_class("asb-message-lit"))
        self.assertTrue(rows["m2"].has_css_class("asb-message-lit"))
        self.assertFalse(rows["m3"].has_css_class("asb-message-lit"))
        self.assertEqual(strip.flights, [])
        wait(lambda: not rows["m1"].has_css_class("asb-message-lit") and not rows["m2"].has_css_class("asb-message-lit"), 4)
        settings.set_property("gtk-enable-animations", True)

        # GTK 4.12 has no Gsk.PathBuilder (GTK 4.14): with animations on, no flight starts and both icons light.
        real_gsk = asb.Gsk
        class Gtk412:
            def __getattr__(self, name):
                if name == "PathBuilder":
                    raise AttributeError(name)
                return getattr(real_gsk, name)
        with patch.object(asb, "Gsk", Gtk412()):
            window.apply_dashboard(board(("m3", "m2")), None)
            wait(lambda: rows["m3"].has_css_class("asb-message-lit"))
            self.assertTrue(rows["m2"].has_css_class("asb-message-lit"))
            self.assertEqual(strip.flights, [])
            wait(lambda: not rows["m3"].has_css_class("asb-message-lit") and not rows["m2"].has_css_class("asb-message-lit"), 4)

        # A message to a row that search hides plays nothing.
        window.search.set_text("parser")
        wait(lambda: list(window.focus_widgets) == ["m2"])
        window.apply_dashboard(board(("m2", "m3")), None)
        self.drain(.5)
        self.assertEqual(strip.flights, [])
        self.assertFalse(rows["m2"].has_css_class("asb-message-lit"))

    def test_message_courier_out_of_view_edges(self):
        threads = [{"id": f"e{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Sample row {n}", "cwd": "/example/notes",
                    "projectName": "notes", "state": "idle", "canOpen": True, "updatedAtMs": NOW - n * 60_000} for n in range(80)]
        at = time.time() * 1000
        def board(*messages):
            return {"generatedAtMs": NOW, "providers": [], "threads": threads,
                    "messages": [{"from": source, "to": target, "atMs": at + index} for index, (source, target) in enumerate(messages)]}
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", board(), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(500, 300)
        window.present()
        self.settle(window)
        strip, adjustment = window.list_body, window.scroll.get_hadjustment()
        playing = asb.Adw.AnimationState.PLAYING
        def wait(done, limit=6):
            end = time.monotonic() + limit
            while not done() and time.monotonic() < end:
                self.drain(.02)
            self.assertTrue(done())
        def send(*messages):
            sent.extend(messages)
            window.apply_dashboard(board(*sent), None)
        sent = []
        self.assertGreater(adjustment.get_upper(), 3 * adjustment.get_page_size())
        # Receiver out of view: no edge mark at the start; at the end the edge mark flashes and no ring plays.
        send(("e0", "e79"))
        wait(lambda: strip.flights)
        flight = strip.flights[0]
        self.assertEqual([end[2] for end in strip.message_ends(flight)], [False, True])
        self.assertNotEqual(flight["edge_animation"].get_state(), playing)
        flight["animations"][-1].skip()
        self.assertEqual(flight["edge_end"], 1)
        self.assertEqual(flight["edge_animation"].get_state(), playing)
        self.assertNotEqual(flight["ring_animation"].get_state(), playing)
        strip.clear_flights()
        # Sender out of view: the edge mark flashes at the start.
        send(("e79", "e0"))
        wait(lambda: strip.flights)
        flight = strip.flights[0]
        self.assertEqual((flight["edge_end"], flight["edge_animation"].get_state()), (0, playing))
        strip.clear_flights()
        # Both ends out of view: nothing plays, also with GNOME animations off.
        adjustment.set_value((adjustment.get_upper() - adjustment.get_page_size()) / 2)
        self.settle(window)
        for pair in (("e0", "e78"), ("e1", "e78")):
            ends = strip.message_ends({"rows": tuple(window.focus_widgets[identity] for identity in pair)})
            self.assertEqual([end[2] for end in ends], [True, True])
        send(("e0", "e78"))
        self.drain(.5)
        self.assertEqual(strip.flights, [])
        settings = window.get_settings()
        settings.set_property("gtk-enable-animations", False)
        self.addCleanup(settings.set_property, "gtk-enable-animations", True)
        send(("e1", "e78"))
        self.drain(.5)
        self.assertFalse(any(row.has_css_class("asb-message-lit") for row in window.focus_widgets.values()))

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
        # Copy is local: no request, no open, and the nested display's clipboard has the exact reference.
        self.assertEqual(click(cards["s4"].asb_copy_button), [])
        self.assertEqual(window.opening, set())
        copied = []
        clipboard = window.get_clipboard()
        clipboard.read_text_async(None, lambda source, result: copied.append(source.read_text_finish(result))); self.drain(.3)
        self.assertEqual(copied, [asb.session_reference(cards["s4"].asb_thread)])
        self.assertEqual(cards["s4"].asb_copy_button.get_child().get_icon_name(), "object-select-symbolic")
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
        # The keyboard makes the focus visible. Tab from the row goes to copy, drawer, read, pin, with the controls shown.
        xdo("windowfocus", xid)
        xdo("key", "Up"); self.settle(window)
        self.assertIs(window.get_focus(), two)
        self.assertEqual((window.get_focus_visible(), two.has_css_class("asb-key-focus"), one.has_css_class("asb-key-focus")), (True, True, False))
        self.assertEqual((shown(one), shown(two)), ((255, False, 0), (0, True, 255)))
        for control in (two.asb_copy_button, two.asb_drawer_button, two.asb_read_button, two.asb_pin_button):
            xdo("key", "Tab"); self.settle(window)
            self.assertIs(window.get_focus(), control)
            self.assertEqual(shown(two), (0, True, 255))
            self.assertEqual(self.ink(two.asb_copy_button), 255)
        # Space and Enter on the focused Copy go through the row keys: a copy, with no request and no open.
        two.asb_copy_button.grab_focus(); self.settle(window)
        for key in ("space", "Return"):
            del requests[:]
            xdo("key", key); self.drain(.3)
            self.assertEqual((requests, window.opening), ([], set()))
            self.assertEqual(two.asb_copy_button.get_child().get_icon_name(), "object-select-symbolic")
        window.close(); self.drain(.03)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_card_buttons_have_no_action_names(self):
        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        rows = [{"id": f"s{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Sort the release notes {n}",
                 "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                 "updatedAtMs": NOW - n * 60_000} for n in (1, 2)]
        rows[0].update(pending=True, unread=True, completionAttention=True, pendingSource="observed-completion")
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", {"generatedAtMs": NOW, "providers": [], "threads": rows},
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(700, 420)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.4)
        for card in window.focus_widgets.values():
            buttons = (card.asb_copy_button, card.asb_drawer_button, card.asb_read_button, card.asb_pin_button)
            self.assertEqual([button.get_action_name() for button in buttons], [None] * 4)
        # Keyboard and screen-reader activation emit clicked, which sends the window action.
        window.focus_widgets["s1"].asb_read_button.activate(); self.drain(.4)
        self.assertEqual([request[1] for request in requests if request[1] != "/api/palette"], ["/api/threads/s1/mark-read"])
        self.assertEqual(window.opening, set())

    def test_row_cache_releases_hidden_cards_above_twice_the_limit(self):
        asb.gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11
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
        self.addCleanup(xdo, "mousemove", x, y)
        words = ["amber", "amber", "birch", "birch", "cedar", "cedar", "cedar", "cedar"]
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            {"id": f"r{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Review the {word} notes {n}",
             "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
             "updatedAtMs": NOW - n * 60_000} for n, word in enumerate(words)]}
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(900, 420)
        window.present(); window.set_focus(None); self.drain(.4)
        window.view_filter.set_selected(1); self.drain(.4); window.check_geometry(); self.drain(.3)
        window.card_limit = 2  # Not a Preferences choice, so not through the setting.
        window.render(); self.drain(.3)
        self.assertEqual(window.row_order, ["r0", "r1", asb.MORE_ID])
        more = window.focus_widgets[asb.MORE_ID]
        # Show all, then clear the All cards chip: after the idle, the cache has the shown cards and the More card only.
        window.open_row(None, more); self.drain(.3)
        self.assertEqual(len(window.row_cache), 9)
        window.clear_filter_chip(window.filter_chip_widgets["all"][0], "all"); self.drain(.3)
        self.assertEqual(window.row_order, ["r0", "r1", asb.MORE_ID])
        self.assertEqual(set(window.row_cache), {"r0", "r1", asb.MORE_ID})
        self.assertIs(window.row_cache[asb.MORE_ID], more)
        self.assertIsNone(window.row_cache_trim)
        # Two searches hide r0 and r1 and pass the bound of 5 cards; a clear builds them again with their current data.
        first = window.focus_widgets["r0"]
        window.search.set_text("cedar"); self.drain(.6)
        self.assertEqual(set(window.row_cache), {"r0", "r1", "r4", "r5", asb.MORE_ID})
        window.search.set_text("birch"); self.drain(.6)
        self.assertEqual(set(window.row_cache), {"r2", "r3", asb.MORE_ID})
        window.dashboard["threads"][0] = dict(window.dashboard["threads"][0], title="Review the renamed notes 0")
        window.search.set_text(""); self.drain(.6)
        self.assertEqual(window.row_order, ["r0", "r1", asb.MORE_ID])
        card = window.focus_widgets["r0"]
        self.assertIsNot(card, first)
        self.assertEqual(card.asb_title_label.get_label(), "Review the renamed notes 0")
        found, bounds = card.asb_title_label.compute_bounds(window)
        self.assertTrue(found)
        left, top = window.get_surface_transform()
        xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(window.get_surface()),
            int(bounds.origin.x + bounds.size.width / 2 + left), int(bounds.origin.y + bounds.size.height / 2 + top))
        self.drain(.3)
        del requests[:]
        xdo("click", 1); self.drain(.4)
        self.assertEqual([request[1] for request in requests if request[1] != "/api/palette"], ["/api/threads/r0/open"])

    def test_real_pointer_sets_one_hover_class_on_each_card(self):
        asb.gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            {"id": f"s{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Summarize the open issues {n}",
             "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
             "updatedAtMs": NOW - n * 60_000} for n in range(1, 5)]}
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout
        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(700, 420)
        window.present(); window.set_focus(None); self.drain(.4)
        window.view_filter.set_selected(1); self.drain(.4); window.check_geometry(); self.drain(.3)
        cards = window.focus_widgets
        def move(widget=None):
            left, top = window.get_surface_transform()
            x, y = 10, 10  # The top left corner of the header, off the board.
            if widget:
                found, bounds = widget.compute_bounds(window)
                self.assertTrue(found)
                x, y = bounds.origin.x + bounds.size.width / 2, bounds.origin.y + bounds.size.height / 2
            xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(window.get_surface()), int(x + left), int(y + top))
            self.settle(window)
            return [identity for identity, card in cards.items() if card.has_css_class("asb-hovered")]
        # Each card has exactly one of the two classes at all times.
        one_class = lambda: all(card.has_css_class("asb-hovered") != card.has_css_class("asb-unhovered") for card in cards.values())
        self.assertEqual([identity for identity, card in cards.items() if card.has_css_class("asb-hovered")], [])
        self.assertTrue(one_class())
        self.assertEqual(move(cards["s1"].asb_title_label), ["s1"])
        self.assertTrue(one_class())
        self.assertEqual(self.ink(cards["s1"].asb_copy_button), 255)
        self.assertEqual(self.ink(cards["s2"].asb_copy_button), 0)
        self.assertEqual(move(cards["s2"].asb_title_label), ["s2"])
        self.assertTrue(cards["s1"].has_css_class("asb-unhovered") and one_class())
        self.assertEqual(self.ink(cards["s1"].asb_copy_button), 0)
        self.assertEqual(move(), [])
        self.assertTrue(one_class())
        window.close(); self.drain(.03)

    def test_card_limit_more_card_show_all_chip_and_preference(self):
        from gi.repository import GdkX11
        for target, name in ((asb, "DEFAULT_CARD_LIMIT"), (asb.SwitchboardWindow, "card_limit")):
            patcher = patch.object(target, name, 100)
            patcher.start()
            self.addCleanup(patcher.stop)
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
        self.addCleanup(xdo, "mousemove", x, y)
        dashboard = mock_dashboard()
        dashboard["threads"] += [dict(dashboard["threads"][40], id=f"extra-{index}", title=f"Synthetic older session {index}",
                                      updatedAtMs=NOW - (200 + index) * 86_400_000) for index in range(24)]
        temporary = Path(tempfile.mkdtemp(prefix="asb-card-limit-"))
        self.addCleanup(shutil.rmtree, temporary, True)
        layout_path = temporary / "layout.json"
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=layout_path)
        self.addCleanup(window.close)
        window.set_default_size(1080, 420)
        window.present(); window.set_focus(None); self.drain(.4); window.check_geometry(); self.drain(.3)
        xid = GdkX11.X11Surface.get_xid(window.get_surface())
        full = [row["id"] for row in asb.filtered_rows(dashboard)]
        self.assertEqual(len(full), 130)
        more = window.focus_widgets[asb.MORE_ID]
        def check_limited():
            self.assertEqual(window.row_order, full[:100] + [asb.MORE_ID])
            self.assertIs(window.focus_widgets[asb.MORE_ID], more)
            self.assertFalse(window.filter_chip_widgets["all"][0].get_visible())
            columns = [listing for listing in window.list_columns if listing.get_parent()]
            for number, listing in enumerate(columns):
                cards, card = [], listing.get_row_at_index(0)
                while card is not None:
                    cards.append(card.asb_focus_key)
                    card = listing.get_row_at_index(len(cards))
                self.assertEqual(cards, window.row_order[number * window.capacity:(number + 1) * window.capacity])
        def check_all(first_focus=None):
            self.assertTrue(window.show_all_cards)
            self.assertEqual(window.row_order, full)
            self.assertNotIn(asb.MORE_ID, window.focus_widgets)
            self.assertIs(window.row_cache[asb.MORE_ID], more)
            chip = window.filter_chip_widgets["all"]
            self.assertTrue(chip[0].get_visible() and window.filter_chip_group.get_visible())
            self.assertEqual((chip[1].get_label(), chip[0].get_tooltip_text()), ("All cards", "Show only the first 100 cards"))
            if first_focus:
                self.assertEqual(window.focus_key(), first_focus)
                self.assert_focus_visible(window, first_focus)
        def reset():
            window.clear_filter_chip(window.filter_chip_widgets["all"][0], "all"); self.drain(.3)
            self.assertFalse(window.show_all_cards)
            check_limited()
        check_limited()
        # Compact: the parts of the More card, with no number key, no row panel, and the count only in the tooltip and label.
        newest = max(row["updatedAtMs"] for row in dashboard["threads"] if row["id"] in full[100:])
        self.assertEqual(more.asb_thread["updatedAtMs"], newest)
        age = asb.row_meta({"state": "idle", "updatedAtMs": newest}).split(" · ")[1]
        self.assertEqual(more.asb_thread["asbFirst"], full[100])
        self.assertEqual((more.asb_mark.get_icon_name(), more.asb_title_label.get_label(), more.asb_state_label.get_label(),
                          more.asb_where_label.get_label(), more.asb_where_label.get_visible()),
                         ("view-more-horizontal-symbolic", "More sessions", "Show all", "· " + age, True))
        self.assertTrue(more.asb_state_label.has_css_class("dim-label"))
        self.assertTrue(more.get_activatable())
        self.assertFalse(more.asb_source_badge.get_visible())
        self.assert_accessible_label(more, "More sessions. 30 sessions after the first 100. Activate to show all cards.")
        shown = []
        self.assertTrue(window.query_row_tooltip(more, 0, 0, False, SimpleNamespace(set_text=shown.append)))
        self.assertEqual(shown, ["30 more sessions after the first 100. Click to show all cards."])
        adjustment = window.scroll.get_hadjustment()
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size()); self.drain(.3)
        window.update_number_keys()
        self.assertNotIn(asb.MORE_ID, window.number_keys)
        self.assertEqual(getattr(more, "asb_number", 0), 0)
        found, box = more.compute_bounds(window.scroll.get_child())
        self.assertTrue(found)
        self.assertEqual(asb.number_key_rows([more.asb_thread], {asb.MORE_ID: (box.origin.x, box.origin.y, box.size.width, box.size.height)},
                                             (window.scroll.get_child().get_width(), window.scroll.get_child().get_height())), [])
        window.row_context(None, 1, 5, 5, asb.MORE_ID)
        for key, modifier in ((asb.Gdk.KEY_Menu, 0), (asb.Gdk.KEY_F10, asb.Gdk.ModifierType.SHIFT_MASK)):
            window.row_key(None, key, 0, modifier, asb.MORE_ID)
        self.drain(.2)
        self.assertIsNone(window.context_menu)
        self.assertFalse(window.pin_drop(None, "asb-pin:" + asb.MORE_ID, 0, 0, full[0]))
        # Comfortable: the folder line, the arrow after Show all, the age, and no action corner.
        window.view_filter.set_selected(1); self.drain(.6); window.check_geometry(); self.drain(.3)
        self.assertIs(window.focus_widgets[asb.MORE_ID], more)
        check_limited()
        self.assertEqual((more.asb_folder.get_label(), more.asb_age_label.get_label(), more.asb_state_label.get_label(),
                          more.asb_title_label.get_label(), more.asb_where_label.get_visible()),
                         ("After the first 100", "from " + age, "Show all", "More sessions", False))
        glyph = more.asb_more_glyph
        self.assertEqual((glyph.get_icon_name(), glyph.get_pixel_size(), glyph.has_css_class("dim-label")), ("go-next-symbolic", 11, True))
        self.assertIs(more.asb_state_label.get_next_sibling(), glyph)
        self.assertFalse(more.asb_copy_button.get_parent().get_visible())
        self.assert_accessible_label(more, "More sessions. 30 sessions after the first 100. Activate to show all cards.")
        self.assertEqual(asb.read_layout(layout_path)["cardLimit"], 100)
        self.assertNotIn("cardLimit", json.loads(layout_path.read_text()))
        # A pointer click shows all cards and keeps the horizontal position.
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size()); self.drain(.3)
        position = adjustment.get_value()
        found, bounds = more.compute_bounds(window)
        self.assertTrue(found)
        left, top = window.get_surface_transform()
        xdo("mousemove", "--window", xid, int(bounds.origin.x + bounds.size.width / 2 + left), int(bounds.origin.y + bounds.size.height / 2 + top))
        self.drain(.3)
        xdo("click", 1); self.drain(.6)
        check_all()
        self.assertAlmostEqual(adjustment.get_value(), position, delta=1)
        self.assertEqual([request[1] for request in requests if request[1] != "/api/palette"], [])
        xdo("mousemove", "--window", xid, 3, window.get_height() - 3); self.drain(.2)
        reset()
        # Enter and Space on the More card with the keyboard focus: the focus goes to the first card that it stood for.
        for key in ("Return", "space"):
            with self.subTest(key=key):
                window.focus_widgets[full[99]].grab_focus(); self.drain(.2)
                xdo("windowfocus", xid); xdo("key", "Down"); self.drain(.3)
                self.assertIs(window.get_focus(), more)
                self.assertTrue(window.get_focus_visible())
                xdo("key", key); self.drain(.6)
                check_all(full[100])
                reset()
        window.set_focus(None)
        more.grab_focus(); self.drain(.2)
        more.get_parent().emit("row-activated", more); self.drain(.5)
        check_all()
        self.assertEqual(window.focus_key(), full[100])
        self.assertEqual([request[1] for request in requests if request[1] != "/api/palette"], [])
        reset()
        # A reorder and a filter change with the More card on the board keep the right columns and the same More widget.
        window.dashboard["threads"] = [dict(row, pinned=True, pinIndex=0) if row["id"] == full[50] else row for row in window.dashboard["threads"]]
        full = [row["id"] for row in asb.filtered_rows(window.dashboard)]
        window.render(); self.drain(.3)
        self.assertEqual(window.row_order[0], full[0])
        check_limited()
        window.search.set_text("Build"); self.drain(.6)
        self.assertNotIn(asb.MORE_ID, window.row_order)
        self.assertIs(window.row_cache[asb.MORE_ID], more)
        self.assertTrue(more.asb_handlers)
        window.search.set_text(""); self.drain(.6)
        check_limited()
        # Preferences > Sessions: the choice saves, the board changes at once, and a failed save keeps the old choice.
        setting = window.card_limit_setting
        self.assertEqual([setting.get_model().get_string(index) for index in range(5)], ["50", "100", "200", "500", "All"])
        self.assertEqual(setting.get_selected(), 1)
        self.assert_accessible_label(setting, "Cards on the board")
        window.clear_filter_chip(window.filter_chip_widgets["all"][0], "all")
        window.open_row(None, more); self.drain(.3)
        self.assertTrue(window.show_all_cards)
        setting.set_selected(0); self.drain(.3)
        self.assertEqual((window.card_limit, window.show_all_cards, asb.read_layout(layout_path)["cardLimit"]), (50, False, 50))
        self.assertEqual(window.row_order, full[:50] + [asb.MORE_ID])
        self.assertEqual(more.asb_folder.get_label(), "After the first 50")
        setting.set_selected(2); self.drain(.3)
        self.assertEqual((window.card_limit, json.loads(layout_path.read_text())["cardLimit"]), (200, 200))
        self.assertEqual(window.row_order, full)
        setting.set_selected(4); self.drain(.3)
        self.assertEqual((window.card_limit, json.loads(layout_path.read_text())["cardLimit"]), (0, 0))
        self.assertEqual(window.row_order, full)
        self.assertEqual(window.card_limit_error.get_label(), "")
        blocker = temporary / "not-a-folder"
        blocker.write_text("")
        window.layout_path = blocker / "layout.json"
        setting.set_selected(1); self.drain(.3)
        self.assertEqual((setting.get_selected(), window.card_limit), (4, 0))
        self.assertTrue(window.card_limit_error.get_label())
        self.assertEqual(window.row_order, full)
        window.layout_path = layout_path
        setting.set_selected(1); self.drain(.3)
        self.assertEqual((window.card_limit, window.card_limit_error.get_label()), (100, ""))
        self.assertFalse(layout_path.exists() and "cardLimit" in json.loads(layout_path.read_text()))
        check_limited()
        window.close(); self.drain(.03)

if __name__ == "__main__":
    unittest.main()
