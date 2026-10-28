"""Small native view checks. Session opens use a disposable mock server."""
import contextlib
import copy
import ctypes
import ctypes.util
import gc
import importlib.util
import io
import json
import math
import os
import queue
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import weakref
from unittest.mock import Mock, patch
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
         "state": "waiting", "canOpen": True, "updatedAtMs": NOW - 120_000, "pending": True, "pendingSource": "user-action", "actionRequired": True,
         "actionAttention": True},
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


def toggle_profile(window, key):
    if key in window.profiles:
        window.profiles.discard(key)
    else:
        window.profiles.add(key)
    window.filter_changed()


def select_states(window, states):
    window.states = set(states)
    window.filter_changed()


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
                     "actionRequired": state == "waiting" and index != 0, "actionAttention": state == "waiting" and index != 0,
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


class BoardProcessCheck(unittest.TestCase):
    """The real board process, started as the launcher starts it: the argument "-" and the engine address on stdin."""
    TOKEN = "ab" * 32

    def setUp(self):
        received, token = [], self.TOKEN
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, body):
                self.send_response(200)
                self.send_header("ETag", '"first"')
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_GET(self):
                received.append(("GET", self.path, self.headers.get("X-ASB-Source-Token")))
                self.reply(FIXTURE)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                received.append(("POST", self.path, self.headers.get("X-ASB-Source-Token")))
                self.reply({})
        self.received = received
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 1)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.directory = Path(tempfile.mkdtemp(prefix="asb-board-process-"))
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        # Temporary folders keep the user's configuration, cache, and theme out of the check.
        self.env = {**os.environ, "HOME": str(self.directory), "XDG_CONFIG_HOME": str(self.directory / "config"),
                    "XDG_CACHE_HOME": str(self.directory / "cache"), "XDG_STATE_HOME": str(self.directory / "state"),
                    "ASB_SNAPSHOT": str(self.directory / "board.png"), "PYTHONDONTWRITEBYTECODE": "1"}
        self.env.pop("ASB_SOURCE_TOKEN", None)

    def board(self, stdin):
        board = subprocess.Popen([sys.executable, str(Path(__file__).parents[1] / "scripts" / "asb-board.py"), "-"], stdin=stdin,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        self.addCleanup(self.stop, board)
        return board

    @staticmethod
    def stop(board):
        board.kill()
        board.wait(10)
        for stream in (board.stdin, board.stdout, board.stderr):
            if stream:
                stream.close()

    def test_the_board_gets_its_address_on_stdin_and_asks_for_the_first_dashboard_once(self):
        board = self.board(subprocess.PIPE)
        # The address comes after the start of the board: the board waits and shows nothing until then.
        time.sleep(1.5)
        self.assertIsNone(board.poll())
        self.assertEqual(self.received, [])
        self.assertFalse((self.directory / "board.png").exists())
        board.stdin.write(json.dumps({"url": self.base, "token": self.TOKEN}).encode() + b"\n")
        board.stdin.close()
        for _attempt in range(300):
            if (self.directory / "board.png").exists() and (self.directory / "board.png").stat().st_size > 0 or board.poll() is not None:
                break
            time.sleep(.1)
        self.assertIsNone(board.poll())
        self.assertGreater((self.directory / "board.png").stat().st_size, 0)
        dashboards = [item for item in self.received if item[0] == "GET" and item[1].split("?")[0] == "/api/dashboard"]
        # The early request is the only dashboard request until the next poll. Dashboard reads send no token.
        self.assertEqual(dashboards, [("GET", "/api/dashboard", None)])
        # The token of the line is the token of later requests: the board shares its palette with it.
        for _attempt in range(50):
            if any(item[:2] == ("POST", "/api/palette") for item in self.received):
                break
            time.sleep(.1)
        self.assertEqual([item for item in self.received if item[:2] == ("POST", "/api/palette")][0][2], self.TOKEN)
        board.terminate()
        board.wait(10)
        output, errors = board.stdout.read().decode(), board.stderr.read().decode()
        self.assertIn("Saved the native ASB window image.", output)
        self.assertNotIn("Cannot save the native GTK image", errors)
        self.assertNotIn(self.TOKEN, output + errors)

    def test_the_board_ends_with_exit_code_1_and_a_message_when_the_launcher_sends_no_address(self):
        board = self.board(subprocess.DEVNULL)
        output, errors = board.communicate(timeout=60)
        self.assertEqual(board.returncode, 1)
        self.assertEqual(errors.decode().strip(), "ASB did not get the engine address from its launcher.")
        self.assertEqual(self.received, [])

    def test_the_board_ends_with_exit_code_1_when_the_line_is_not_a_local_address(self):
        board = self.board(subprocess.PIPE)
        line = json.dumps({"url": "http://example.com:4629", "token": self.TOKEN}).encode() + b"\n"
        output, errors = board.communicate(input=line, timeout=60)
        self.assertEqual(board.returncode, 1)
        self.assertEqual(errors.decode().strip(), "Use the local ASB address: http://127.0.0.1:<port>.")
        self.assertNotIn(self.TOKEN, errors.decode())
        self.assertEqual(self.received, [])


class SnapshotWatchCheck(unittest.TestCase):
    """The ASB_SNAPSHOT image comes after a drawn frame. A fake frame clock gives the frame times, so no check waits for real time."""
    NO_CONTENT = "The native window has no rendered content."

    def frames(self, results, times):
        """Calls tick for each frame time with a save_snapshot that gives the next of results (an exception is raised).
        Returns the answers of tick, the saves, the stdout text, and the stderr text."""
        watch, saves, answers = asb.SnapshotWatch("board.png"), iter(results), []
        def save(window, output):
            self.assertEqual((window, output), ("window", "board.png"))
            result = next(saves)
            if isinstance(result, Exception):
                raise result
        with patch.object(asb, "save_snapshot", side_effect=save) as saved, contextlib.redirect_stdout(io.StringIO()) as out, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            for time_us in times:
                answers.append(watch.tick("window", SimpleNamespace(get_frame_time=lambda: time_us)))
        return answers, saved.call_count, out.getvalue(), errors.getvalue()

    def test_nothing_is_saved_until_the_settle_time_after_the_first_frame_has_passed(self):
        # The first tick is the first frame with the dashboard; the time of the first frame is not the start of the clock.
        answers, saves, out, errors = self.frames([None], [5_000_000, 5_016_000, 5_100_000, 5_249_999])
        self.assertEqual((answers, saves, out, errors), ([True] * 4, 0, "", ""))
        answers, saves, out, errors = self.frames([None], [5_000_000, 5_249_999, 5_250_000])
        self.assertEqual((answers, saves, out, errors), ([True, True, False], 1, "Saved the native ASB window image.\n", ""))

    def test_a_save_with_no_content_runs_again_on_the_next_frame_and_the_image_is_saved_once(self):
        answers, saves, out, errors = self.frames(
            [RuntimeError(self.NO_CONTENT), RuntimeError(self.NO_CONTENT), None], [0, 250_000, 266_000, 282_000])
        # False ends the tick callback: GTK calls it no more, so there is no second save.
        self.assertEqual((answers, saves, out, errors), ([True, True, True, False], 3, "Saved the native ASB window image.\n", ""))

    def test_the_tries_stop_at_the_limit_with_the_error_line_and_no_image(self):
        times = list(range(0, 10_000_000, 16_000)) + [10_000_000]
        answers, saves, out, errors = self.frames([RuntimeError(self.NO_CONTENT)] * len(times), times)
        # The frames before 10 s keep the callback; the frame at 10 s prints the error once and ends it.
        self.assertEqual(answers, [True] * (len(times) - 1) + [False])
        self.assertEqual(saves, len([time_us for time_us in times if time_us >= 250_000]))
        self.assertEqual((out, errors), ("", "Cannot save the native GTK image: " + self.NO_CONTENT + "\n"))
        # One frame before the limit still tries again.
        self.assertEqual(self.frames([RuntimeError(self.NO_CONTENT)] * 2, [0, 250_000, 9_999_999])[0], [True, True, True])

    def test_an_error_that_is_not_a_missing_frame_ends_at_once(self):
        answers, saves, out, errors = self.frames([OSError("The disk is full.")], [0, 250_000])
        self.assertEqual((answers, saves, out, errors), ([True, False], 1, "", "Cannot save the native GTK image: The disk is full.\n"))


@unittest.skipUnless(asb.Gtk.init_check(), "A GTK display is not available.")
class WidgetCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.poll_timer = patch.object(asb.GLib, "timeout_add_seconds", return_value=0)
        cls.poll_calls = cls.poll_timer.start()
        cls.addClassCleanup(cls.poll_timer.stop)
        # One application for all GTK check classes: a second one cannot export the same D-Bus path.
        if "shared_application" not in WidgetCheck.__dict__:
            WidgetCheck.shared_application = asb.SwitchboardApplication("http://127.0.0.1:1")
            WidgetCheck.shared_application.register(None)
        cls.application = WidgetCheck.shared_application
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
        self.addCleanup(self.close_windows)
        if shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"):
            # A pointer that an earlier test left where a later popover maps makes GTK log a Gdk-CRITICAL at a popover grab.
            subprocess.run(["xdotool", "mousemove", "9999", "9999"], check=True)

    def close_windows(self):
        # GTK does not close a window that was never shown, so its refresh timer would send requests in later tests.
        for window in self.application.get_windows():
            if isinstance(window, asb.SwitchboardWindow) and not window.closed:
                window.emit("close-request")
            window.destroy()
        self.drain(.03)

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

    def assert_accessible_busy(self, widget, expected):
        error = self.gtk_state(self.capsule_pointer(widget.__gpointer__, None), int(asb.Gtk.AccessibleState.BUSY), ctypes.c_int(expected))
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

    @staticmethod
    def fill_board(window):
        """Build the cards of all columns, for checks that read every card. The board builds only the columns near the view."""
        window.fill_columns(range(len(window.column_parts)))
        return window.focus_widgets

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

    def test_phone_pairing_status_keeps_device_rows_remove_buttons_and_focus(self):
        preferences = asb.Adw.Window(application=self.application)
        preferences.closed = False
        self.addCleanup(preferences.destroy)
        owner = SimpleNamespace(closed=False, base="http://127.0.0.1:1")
        editor = asb.PhoneEditor(owner, preferences)
        preferences.set_content(editor)
        editor.active = True
        device = {"id": "test-phone-a", "name": "Test phone", "createdAtMs": 1000, "lastSeenAtMs": 2000}
        status = {"enabled": False, "running": False, "devices": [device]}
        editor.render_status(status)
        editor.update_controls()
        preferences.present()
        self.drain(.1)
        row, button = editor.devices.get_row_at_index(0), editor.remove_buttons[0]
        self.assertTrue(button.grab_focus())
        editor.render_status(copy.deepcopy(status))
        self.assertIs(editor.devices.get_row_at_index(0), row)
        self.assertIs(editor.remove_buttons[0], button)
        self.assertIs(preferences.get_focus(), button)
        for changed in ({**device, "lastSeenAtMs": 3000}, {**device, "name": "Test tablet"}):
            editor.render_status({**status, "devices": [changed]})
            self.assertIsNot(editor.devices.get_row_at_index(0), row)
            self.assertIsNot(editor.remove_buttons[0], button)
            row, button = editor.devices.get_row_at_index(0), editor.remove_buttons[0]

    def test_reconnect_keeps_the_board_and_preferences_and_uses_the_new_engine(self):
        received = [[], []]
        servers = []
        for index in range(2):
            class Handler(BaseHTTPRequestHandler):
                def do_GET(handler, index=index):
                    received[index].append((handler.path.split("?", 1)[0], handler.headers.get("X-ASB-Source-Token")))
                    handler.send_response(200)
                    handler.send_header("Content-Type", "text/event-stream" if handler.path.split("?", 1)[0] == "/api/events" else "application/json")
                    handler.end_headers()
                    if handler.path.split("?", 1)[0] == "/api/events":
                        handler.wfile.write(b": connected\n\n")
                    else:
                        body = mock_dashboard() if handler.path.startswith("/api/dashboard") else {"sources": [], "revision": "r1"}
                        if handler.path == "/api/phone":
                            body = {"devices": [], "addresses": [], "enabled": False, "port": 4630}
                        handler.wfile.write(json.dumps(body).encode())
                def do_POST(handler, index=index):
                    received[index].append((handler.path.split("?", 1)[0], handler.headers.get("X-ASB-Source-Token")))
                    handler.rfile.read(int(handler.headers.get("Content-Length", 0)))
                    handler.send_response(200)
                    handler.end_headers()
                    handler.wfile.write(b"{}")
                def log_message(handler, *_args):
                    pass
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            servers.append(server)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        bases = [f"http://127.0.0.1:{server.server_port}" for server in servers]
        def wait(done):
            end = time.monotonic() + 6
            while not done() and time.monotonic() < end:
                self.drain(.02)
            self.assertTrue(done())
        with patch.object(asb, "SOURCE_TOKEN", "token-a"):
            window = asb.SwitchboardWindow(self.application, bases[0], theme_path=False, layout_path=False)
            self.addCleanup(window.close)
            window.present()
            wait(lambda: any(route == "/api/agent/ui" for route, _token in received[0]) and not window.loading)
            window.open_preferences()
            preferences = window.preferences_window
            preferences.stack.set_visible_child_name("profiles")
            wait(lambda: preferences.profiles_editor and not preferences.profiles_editor.loading)
            editor = preferences.profiles_editor
            preferences.stack.set_visible_child_name("phone")
            wait(lambda: preferences.phone_editor and not preferences.phone_editor.loading)
            phone = preferences.phone_editor
            messages = copy.copy(window.message_seen)
            old_events = window.events
            self.application.reconnect(bases[1], "token-b")
            editor.request_sources()
            phone.request_phone()
            wait(lambda: all(any(route == wanted for route, _token in received[1])
                             for wanted in ("/api/dashboard", "/api/agent/ui", "/api/events", "/api/sources", "/api/phone")))
            self.assertTrue(all(token == "token-b" for route, token in received[1] if route not in ("/api/dashboard", "/api/events", "/api/sources")))
            self.assertEqual(window.base, bases[1])
            self.assertIs(window.preferences_window, preferences)
            self.assertIs(preferences.profiles_editor, editor)
            self.assertFalse(window.closed)
            self.assertFalse(preferences.closed)
            self.assertTrue(old_events.stopped.is_set())
            self.assertEqual(window.events.address.port, servers[1].server_port)
            self.assertEqual(window.message_seen, messages)
            window.close()
            self.application.reconnect(bases[0], "ignored")
            self.assertEqual(window.base, bases[1])

    def test_close_reports_once_and_stops_ticks_and_inflight_callbacks(self):
        reports, callbacks, waits = [], [], []
        def request(_base, route, callback, _dispatch, method="GET", body=None, **_kwargs):
            if route == "/api/agent/ui":
                reports.append(body)
                callbacks.append(callback)
            return SimpleNamespace(join=waits.append)
        with patch.object(asb, "SOURCE_TOKEN", "fake-token"), \
                patch.object(asb, "request_async", request), \
                patch.object(asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)), \
                patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None):
            window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", theme_path=False, layout_path=False)
            window.present()
            self.drain(.03)
            window.report_ui()
            self.assertEqual(len(callbacks), 1)
            self.assertTrue(window.ui_report_sending)
            window.close()
            self.assertTrue(window.closed)
            callbacks[0]({}, None)
            self.assertFalse(window.tick())
            window.report_ui()
            window.on_close()
            self.drain(.03)
            self.assertEqual(len(reports), 2)
            self.assertEqual(reports[-1], {"clientId": window.ui_client_id, "closed": True})
            self.assertEqual(waits, [.75])
            self.assertIsNone(window.timer)

    def test_toolbar_c_one_row_corners_search_filters_and_no_counters(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
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
            window.make_preferences()
            border_width = window.get_default_size().width - window.get_width()
            self.assertTrue(window.persistent_unread.get_active())
            # Exactly two pills: Drawer and Filters. No app/Pending/Working pills.
            strip_children = []
            child = window.toolbar_strip.get_first_child()
            while child:
                strip_children.append(child)
                child = child.get_next_sibling()
            self.assertEqual(strip_children, [window.drawer_only, window.filters_pill])
            self.assertFalse(hasattr(window, "count"))
            self.assertFalse(hasattr(window, "feedback"))
            self.assertTrue(window.drawer_dot.get_visible())
            self.assertFalse(isinstance(window.drawer_dot, asb.Gtk.Label))
            # Filters pill opens the popover.
            self.assertIsNone(window.filter_popover)
            window.open_filters_popover(); self.drain(.3)
            self.assertIsNotNone(window.filter_popover)
            self.assertIsNotNone(window.filter_popover.get_child())
            # Popover closes and focuses Filters.
            window.filter_popover.popdown(); self.drain(.3)
            self.assertEqual(window.get_focus(), window.filters_pill)
            for width in (520, 680, 1182):
                with self.subTest(width=width):
                    window.set_default_size(width + border_width, 400); self.drain(.3); window.check_geometry(); self.drain(.1)
                    self.assertEqual(window.get_width(), width)
                    current_height = window.window_handle.get_height()
                    pills = [window.drawer_only, window.filters_pill,
                             *(chip for chip, _name in window.filter_chip_widgets.values())]
                    controls = [*pills, window.menu_button, window.window_controls]
                    controls += [window.search_button, window.refresh_button] if width >= 680 else [window.search_button]
                    tallest = max(control.measure(asb.Gtk.Orientation.VERTICAL, -1)[1]
                                  for control in controls if control.get_visible())
                    self.assertLessEqual(current_height, tallest + window.tools.get_margin_top() + window.tools.get_margin_bottom())
                    row_positions = []
                    for pill in pills:
                        if pill.get_visible():
                            found, bounds = pill.compute_bounds(window.toolbar_strip if pill in (window.drawer_only, window.filters_pill) else window.toolbar_scroll)
                            self.assertTrue(found)
                            row_positions.append(round(bounds.origin.y))
                    self.assertEqual(len(set(row_positions)), 1)
                    self.assertEqual(window.app_mark.get_visible(), width >= 320)
                    self.assertEqual(window.search_button.get_visible(), width >= 320)
                    found, before = window.toolbar_end.compute_bounds(window.tools)
                    self.assertTrue(found)
                    self.assertLessEqual(abs(before.origin.x + before.size.width - window.tools.get_width()), 1)
                    window.open_search_from_preferences(); self.drain(.1)
                    self.assertTrue(window.search.get_mapped())
                    self.assertTrue(window.search.has_focus() or window.get_focus().is_ancestor(window.search))
                    window.search.set_text("cx: example")
                    window.search.emit("stop-search")
                    self.drain(.1)
                    self.assertEqual(window.search.get_text(), "")
                    found, after = window.toolbar_end.compute_bounds(window.tools)
                    self.assertTrue(found)
                    self.assertEqual((round(before.origin.x), round(before.origin.y)), (round(after.origin.x), round(after.origin.y)))
            # Chips: Pending, states, profiles, archived, All cards. No digits in labels.
            window.set_pending(True)
            window.states = {"idle", "waiting"}
            window.set_archived(True)
            self.drain(.1)
            keys = set(window.filter_chip_widgets)
            self.assertIn("pending", keys)
            self.assertIn("state:idle", keys)
            self.assertIn("state:waiting", keys)
            self.assertIn("archive", keys)
            for _key, (chip, name) in window.filter_chip_widgets.items():
                label_text = name.get_text()
                self.assertFalse(any(c.isdigit() for c in label_text), label_text)
            # A chip click removes only its value.
            window.filter_chip_widgets["state:idle"][0].emit("clicked"); self.drain(.1)
            self.assertEqual(window.states, {"waiting"})
            self.assertNotIn("state:idle", window.filter_chip_widgets)
            # Delete removes only its value.
            window.filter_chip_widgets["state:waiting"][0].grab_focus(); self.drain(.1)
            window.chip_key(None, asb.Gdk.KEY_Delete, 0, 0, "state:waiting")
            self.assertEqual(window.states, set())
            self.assertNotIn("state:waiting", window.filter_chip_widgets)
            # Pending turns Drawer off and the reverse.
            window.set_pending(True)
            self.assertFalse(window.drawer_only.get_active())
            window.drawer_only.set_active(True); self.drain(.1)
            self.assertFalse(window.pending)
            self.assertNotIn("pending", window.filter_chip_widgets)
            # The search popover keeps its 240px field at wide widths too.
            window.set_default_size(1040 + border_width, 400); self.drain(.3); window.check_geometry(); self.drain(.1)
            self.assertTrue(window.wide_controls)
            window.open_search(); self.drain(.3)
            self.assertGreaterEqual(window.search.get_width(), 240)
            window.clear_search(); self.drain(.2)
            window.reset_width()
            self.assertNotIn("showAppPills", json.loads(path.read_text()) if path.exists() else {})
            window.view_filter.set_selected(1)
            self.assertNotIn("showAppPills", json.loads(path.read_text()) if path.exists() else {})

    def test_chip_trail_order_matches_filter_chips_after_each_step(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        dashboard["providers"] = [
            {"id": "codex-1", "label": "Codex Account One", "message": "", "provider": "codex", "color": "#8296b4"},
            {"id": "codex-2", "label": "Codex Account Two", "message": "", "provider": "codex", "color": "#c4a882"},
            {"id": "claude-1", "label": "Claude Account One", "message": "", "provider": "claude-desktop-code", "color": "#a28caa"},
        ]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(1040, 400)
        window.present(); self.drain(.3)

        def box_titles():
            # Each title here has 18 characters or fewer, so the chip label shows all of it.
            names = dict(window.filter_chip_widgets.values())
            titles = []
            child = window.chip_box.get_first_child()
            while child:
                chip = child.get_child() if isinstance(child, asb.Gtk.Revealer) else child
                if chip in names:
                    titles.append(names[chip].get_label())
                child = child.get_next_sibling()
            return titles

        def expected_titles():
            return [title for _key, title, _detail, _color in window.active_filter_chips()]

        # Step 1: Working
        window.states = {"working"}; window.filter_changed(); self.drain(.1)
        self.assertEqual(box_titles(), expected_titles())
        self.assertEqual(box_titles(), ["Working"])

        # Step 2: Pending
        window.set_pending(True); self.drain(.1)
        self.assertEqual(box_titles(), expected_titles())
        self.assertEqual(box_titles(), ["Pending", "Working"])

        # Step 3: a profile (Codex Account One)
        profile_key = None
        for machine in window.filter_model:
            for app in machine["apps"]:
                for profile in app["profiles"]:
                    if profile["label"] == "Codex Account One":
                        profile_key = profile["key"]
        self.assertIsNotNone(profile_key)
        toggle_profile(window, profile_key); self.drain(.1)
        self.assertEqual(box_titles(), expected_titles())
        self.assertEqual(box_titles(), ["Pending", "Working", "Codex Account One"])

        # Step 4: Idle
        window.states = {"working", "idle"}; window.filter_changed(); self.drain(.1)
        self.assertEqual(box_titles(), expected_titles())
        self.assertEqual(box_titles(), ["Pending", "Working", "Idle", "Codex Account One"])

        # Step 5: show all cards (needs a non-zero card limit for the All cards chip)
        window.card_limit = 100
        window.show_all_cards = True; window.filter_changed(); self.drain(.1)
        self.assertEqual(box_titles(), expected_titles())
        self.assertEqual(box_titles(), ["Pending", "Working", "Idle", "Codex Account One", "All cards"])

    def test_six_chips_at_420_keep_drawer_and_filters_pills_visible(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        dashboard["providers"] = [
            {"id": "codex-1", "label": "Codex Account One", "message": "", "provider": "codex", "color": "#8296b4"},
            {"id": "claude-1", "label": "Claude Account One", "message": "", "provider": "claude-desktop-code", "color": "#a28caa"},
        ]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.3)
        # Six chips: Pending, Working, Waiting, Idle, one profile, archived
        window.set_pending(True)
        window.states = {"working", "waiting", "idle"}
        profile_key = None
        for machine in window.filter_model:
            for app in machine["apps"]:
                for profile in app["profiles"]:
                    if profile_key is None:
                        profile_key = profile["key"]
        toggle_profile(window, profile_key)
        window.set_archived(True)
        self.drain(.2)
        self.assertEqual(len(window.filter_chip_widgets), 6)
        border_width = window.get_default_size().width - window.get_width()
        window.set_default_size(420 + border_width, 400); self.drain(.3); window.check_geometry(); self.drain(.2)
        self.assertEqual(window.get_width(), 420)
        # Drawer and Filters pills are fully visible (within the toolbar strip).
        for pill in (window.drawer_only, window.filters_pill):
            found, bounds = pill.compute_bounds(window.toolbar_strip)
            self.assertTrue(found, pill)
            self.assertGreaterEqual(bounds.origin.x, 0, pill)
            self.assertLessEqual(bounds.origin.x + bounds.size.width, window.toolbar_strip.get_width() + 1, pill)

    def test_chip_and_popover_dots_are_8px_circles(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        dashboard["providers"] = [
            {"id": "codex-1", "label": "Codex Account One", "message": "", "provider": "codex", "color": "#8296b4"},
        ]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.3)
        profile_key = None
        for machine in window.filter_model:
            for app in machine["apps"]:
                for profile in app["profiles"]:
                    profile_key = profile["key"]
        toggle_profile(window, profile_key); self.drain(.2)
        chip, _name = window.filter_chip_widgets[f"profile:{profile_key}"]
        dot = chip.asb_chip_dot
        self.assertTrue(dot.get_visible())
        self.assertEqual(dot.get_width(), 8, "chip dot width")
        self.assertEqual(dot.get_height(), 8, "chip dot height")
        window.open_filters_popover(); self.drain(.3)
        row = window.filter_popover_rows.get(f"profile:{profile_key}")
        self.assertIsNotNone(row)
        content = row.get_child()
        dot2 = None
        child = content.get_first_child()
        while child:
            if child.has_css_class("asb-chip-dot"):
                dot2 = child
                break
            child = child.get_next_sibling()
        self.assertIsNotNone(dot2, "popover dot not found")
        self.assertEqual(dot2.get_width(), 8, "popover dot width")
        self.assertEqual(dot2.get_height(), 8, "popover dot height")

    def test_popover_check_rows_are_real_checkbuttons_with_inconsistent_mixed(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        dashboard["providers"] = [
            {"id": "codex-1", "label": "Codex Account One", "message": "", "provider": "codex", "color": "#8296b4"},
            {"id": "codex-2", "label": "Codex Account Two", "message": "", "provider": "codex", "color": "#c4a882"},
        ]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.3)
        window.open_filters_popover(); self.drain(.3)
        for action, row in window.filter_popover_rows.items():
            if action == "clear":
                continue
            if action == "archive":
                self.assertIsInstance(row, asb.Gtk.Box, f"{action} row is Box")
                self.assertTrue(row.asb_filter_switch.get_can_target(), "switch can_target")
                self.assertTrue(row.asb_filter_switch.get_focusable(), "switch focusable")
                continue
            self.assertIsInstance(row, asb.Gtk.CheckButton, f"{action} row is CheckButton")
        key1 = key2 = None
        for machine in window.filter_model:
            for app in machine["apps"]:
                if app["provider"] == "codex":
                    profiles = app["profiles"]
                    if len(profiles) >= 2:
                        key1, key2 = profiles[0]["key"], profiles[1]["key"]
        self.assertIsNotNone(key1)
        toggle_profile(window, key1); self.drain(.2)
        window.sync_filters_popover_checks()
        header = window.filter_popover_rows.get("app::codex")
        self.assertIsNotNone(header)
        self.assertTrue(header.get_inconsistent(), "header inconsistent with one of two on")
        self.assertFalse(header.get_active())
        toggle_profile(window, key2); self.drain(.2)
        window.sync_filters_popover_checks()
        self.assertTrue(header.get_active(), "header active with both on")
        self.assertFalse(header.get_inconsistent(), "header not inconsistent with both on")

    def test_include_archived_is_a_focusable_switch_with_label_click(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        dashboard = mock_dashboard()
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.3)
        window.open_filters_popover(); self.drain(.3)
        row = window.filter_popover_rows["archive"]
        self.assertIsInstance(row, asb.Gtk.Box)
        switch = row.asb_filter_switch
        self.assertIsInstance(switch, asb.Gtk.Switch)
        self.assertTrue(switch.get_focusable(), "switch focusable")
        self.assertTrue(switch.get_can_target(), "switch can_target")
        self.assert_accessible_label(switch, "Include archived")
        self.assertFalse(window.archived)
        switch.set_active(True); self.drain(.1)
        self.assertTrue(window.archived)
        switch.set_active(False); self.drain(.1)
        self.assertFalse(window.archived)
        name_label = row.get_first_child()
        self.assertEqual(name_label.get_label(), "Include archived")
        click = [c for c in name_label.observe_controllers()
                 if isinstance(c, asb.Gtk.GestureClick) and c.get_button() == 1]
        self.assertEqual(len(click), 1, "label click gesture")
        click[0].emit("pressed", 1, 0.0, 0.0); self.drain(.1)
        self.assertTrue(window.archived, "label click toggles the switch")
        self.assertTrue(switch.get_active())

    def test_filters_popover_offset_at_smallest_toolbar_widths(self):
        window = self.snapshot_window()
        window.present(); self.drain(.3)
        border_width = window.get_default_size().width - window.get_width()
        for width in (680, 507, 320, 1040):
            with self.subTest(width=width):
                window.set_default_size(width + border_width, 600)
                self.drain(.3); window.check_geometry(); self.drain(.1)
                self.assertEqual(window.get_width(), width)
                self.assertEqual(window.wide_controls, width >= 680)
                window.open_filters_popover(); self.drain(.3)
                found, bounds = window.filters_pill.compute_bounds(window)
                self.assertTrue(found)
                natural_width = window.filter_popover.measure(asb.Gtk.Orientation.HORIZONTAL, -1)[1]
                expected = asb.popover_shift(bounds.origin.x, bounds.size.width, natural_width, window.get_width())
                self.assertEqual(tuple(window.filter_popover.get_offset()), (expected, 0))
                centered_left = bounds.origin.x + (bounds.size.width - natural_width) / 2
                if centered_left < 8:
                    self.assertGreater(expected, 0)
                    self.assertAlmostEqual(centered_left + expected, 8, delta=.5)
                if width == 320:
                    self.assertLess(centered_left, 8)
                window.filter_popover.popdown(); self.drain(.2)

    def test_filters_popover_scroller_reserves_switch_space(self):
        window = self.snapshot_window()
        dashboard = mock_dashboard()
        dashboard["providers"] = [{"id": f"codex-{index}", "label": f"Profile {index}", "provider": "codex"}
                                  for index in range(40)]
        window.dashboard = dashboard
        window.filter_model = asb.filter_profiles(dashboard)
        window.present(); self.drain(.3)
        window.open_filters_popover(); self.drain(.3)
        scroller = window.filter_popover.get_child().get_first_child()
        body = scroller.get_child().get_child()
        self.assertEqual(body.get_margin_end(), 10)
        adjustment = scroller.get_vadjustment()
        self.assertGreater(adjustment.get_upper(), adjustment.get_page_size())
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
        self.drain(.3)
        switch = window.filter_popover_rows["archive"].asb_filter_switch
        found, bounds = switch.compute_bounds(scroller)
        self.assertTrue(found)
        self.assertTrue(switch.get_mapped())
        self.assertGreaterEqual(scroller.get_width() - bounds.origin.x - bounds.size.width, 10)

    def test_filters_popover_suppresses_pill_tooltip_until_closed(self):
        window = self.snapshot_window()
        window.present(); self.drain(.3)
        tooltip = window.filters_pill.get_tooltip_text()
        self.assertEqual(tooltip, "Show the filter checklist.")
        self.assertTrue(window.filters_pill.get_has_tooltip())
        for _attempt in range(2):
            window.open_filters_popover(); self.drain(.3)
            self.assertFalse(window.filters_pill.get_has_tooltip())
            self.assertEqual(window.filters_pill.get_tooltip_text(), tooltip)
            window.filter_popover.popdown(); self.drain(.3)
            self.assertTrue(window.filters_pill.get_has_tooltip())
            self.assertEqual(window.filters_pill.get_tooltip_text(), tooltip)

    def test_filter_switch_space_direct(self):
        window = self.snapshot_window()
        window.present(); self.drain(.3)
        window.open_filters_popover(); self.drain(.3)
        switch = window.filter_popover_rows["archive"].asb_filter_switch
        switch.set_active(True)
        for key in (asb.Gdk.KEY_space, asb.Gdk.KEY_KP_Space):
            self.assertTrue(window.filter_switch_key(None, key, 0, 0, switch))
            self.assertFalse(switch.get_active())
            self.assertFalse(window.archived)
            self.assertTrue(window.filter_switch_key(None, key, 0, 0, switch))
            self.assertTrue(switch.get_active())
            self.assertTrue(window.archived)
        self.assertFalse(window.filter_switch_key(None, asb.Gdk.KEY_a, 0, 0, switch))
        self.assertFalse(window.filter_switch_key(None, asb.Gdk.KEY_space, 0, asb.SHORTCUT_MASK, switch))
        self.assertTrue(switch.get_active())
        self.assertTrue(window.archived)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real keys need xdotool and DISPLAY=:9 or :10")
    def test_filter_switch_space_real_key(self):
        import gi
        gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11  # noqa: F401  The X11 surface gives the window ID.
        window = self.snapshot_window()
        window.present(); self.drain(.3)
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True)
        window.open_filters_popover(); self.drain(.3)
        switch = window.filter_popover_rows["archive"].asb_filter_switch
        switch.set_active(True)
        switch.grab_focus(); self.drain(.1)
        for expected in (False, True):
            subprocess.run(["xdotool", "key", "space"], check=True)
            self.drain(.2)
            self.assertEqual(switch.get_active(), expected)
            self.assertEqual(window.archived, expected)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real keys and clicks need xdotool and DISPLAY=:9 or :10")
    def test_filters_outside_held_click_opens_card_once(self):
        window = self.snapshot_window()
        window.set_default_size(700, 600)
        window.present(); self.drain(.4)
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True)
        window.open_filters_popover(); self.drain(.2)
        window.filter_popover_rows["state:working"].set_active(True)
        self.drain(.5)
        card = list(window.focus_widgets.values())[-1]
        found, point = card.compute_point(window, asb.Graphene.Point().init(card.get_width() / 2, card.get_height() / 2))
        self.assertTrue(found)
        with patch.object(asb, "request_async") as request:
            subprocess.run(["xdotool", "mousemove", "--window", str(window.get_surface().get_xid()),
                            str(round(point.x)), str(round(point.y)), "mousedown", "1"], check=True)
            self.drain(.12)
            subprocess.run(["xdotool", "mouseup", "1"], check=True)
            self.drain(.3)
            self.assertFalse(window.filter_popover.get_visible())
            request.assert_called_once()
            self.assertTrue(request.call_args.args[1].endswith("/open"))
        self.assertIsNot(window.get_focus(), window.filters_pill)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real keys and clicks need xdotool and DISPLAY=:9 or :10")
    def test_click_into_a_just_opened_filters_popover_opens_no_card(self):
        window = self.snapshot_window()
        window.set_default_size(700, 600)
        window.present(); self.drain(.4)
        xid = str(window.get_surface().get_xid())
        subprocess.run(["xdotool", "windowfocus", xid], check=True)
        window.open_filters_popover(); self.drain(.3)
        found, bounds = window.filter_popover.compute_bounds(window)
        self.assertTrue(found)
        x, y = bounds.origin.x + bounds.size.width / 2, bounds.origin.y + bounds.size.height / 2
        window.close_filters_popover(); self.drain(.3)
        picked = window.pick(x, y, asb.Gtk.PickFlags.DEFAULT)
        self.assertIsNotNone(picked.get_ancestor(asb.Gtk.ListBoxRow) if picked else None)
        found, pill = window.filters_pill.compute_point(window, asb.Graphene.Point().init(
            window.filters_pill.get_width() / 2, window.filters_pill.get_height() / 2))
        self.assertTrue(found)
        with patch.object(asb, "request_async") as request:
            # One xdotool call: the press into the popover's place reaches the X server before the popover maps.
            subprocess.run(["xdotool", "mousemove", "--window", xid, str(round(pill.x)), str(round(pill.y)), "click", "1",
                            "mousemove", "--window", xid, str(round(x)), str(round(y)), "mousedown", "1"], check=True)
            self.drain(.1)
            subprocess.run(["xdotool", "mouseup", "1"], check=True)
            self.drain(.3)
            self.assertTrue(window.filter_popover.get_visible())
            self.assertFalse([call for call in request.call_args_list if call.args[1].endswith("/open")])

    def test_filters_press_on_the_board_in_the_popover_place_is_claimed(self):
        window = self.snapshot_window()
        window.set_default_size(700, 600)
        window.present(); self.drain(.4)
        window.open_filters_popover(); self.drain(.3)
        found, bounds = window.filter_popover.compute_bounds(window)
        self.assertTrue(found)
        x, y = bounds.origin.x + bounds.size.width / 2, bounds.origin.y + bounds.size.height / 2
        for surface, claimed in ((window.get_surface(), True), (window.filter_popover.get_surface(), False)):
            gesture = Mock()
            gesture.get_current_event.return_value = SimpleNamespace(get_surface=lambda surface=surface: surface)
            window.filters_outside_press(gesture, 1, x, y)
            if claimed:
                gesture.set_state.assert_called_once_with(asb.Gtk.EventSequenceState.CLAIMED)
            else:
                gesture.set_state.assert_not_called()
            self.assertTrue(window.filter_popover.get_visible())

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real keys need xdotool and DISPLAY=:9 or :10")
    def test_filters_escape_tab_inactive_and_unmap_close(self):
        window = self.snapshot_window()
        window.present(); self.drain(.3)
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True)
        window.open_filters_popover(); self.drain(.2)
        self.assertIs(window.get_focus().get_ancestor(asb.Gtk.Popover), window.filter_popover)
        subprocess.run(["xdotool", "key", "Escape"], check=True); self.drain(.2)
        self.assertFalse(window.filter_popover.get_visible())
        self.assertIs(window.get_focus(), window.filters_pill)
        window.open_filters_popover(); self.drain(.2)
        window.filter_popover_rows["state:working"].set_active(True)
        self.assertTrue(window.filter_popover_rows["clear"].grab_focus())
        subprocess.run(["xdotool", "key", "Tab"], check=True); self.drain(.2)
        self.assertFalse(window.filter_popover.get_visible())
        self.assertIsNot(window.get_focus(), window.filters_pill)
        window.open_filters_popover(); self.drain(.2)
        with patch.object(window, "is_active", return_value=False):
            window.notify("is-active")
        self.drain(.2)
        self.assertFalse(window.filter_popover.get_visible())
        window.open_filters_popover(); self.drain(.2)
        found, point = window.filters_pill.compute_point(window, asb.Graphene.Point().init(
            window.filters_pill.get_width() / 2, window.filters_pill.get_height() / 2))
        self.assertTrue(found)
        subprocess.run(["xdotool", "mousemove", "--window", str(window.get_surface().get_xid()),
                        str(round(point.x)), str(round(point.y)), "mousedown", "1"], check=True)
        self.drain(.12)
        subprocess.run(["xdotool", "mouseup", "1"], check=True); self.drain(.2)
        self.assertFalse(window.filter_popover.get_visible())
        self.assertIs(window.get_focus(), window.filters_pill)
        window.open_filters_popover(); self.drain(.2)
        window.set_visible(False); self.drain(.2)
        self.assertFalse(window.filter_popover.get_visible())

    def test_board_popovers_close_when_the_window_stops_being_active(self):
        window = self.snapshot_window()
        window.set_default_size(700, 600)
        window.present(); self.drain(.4)
        card = list(window.focus_widgets.values())[0]
        for name, popup, popover in (
                ("row panel", lambda: window.show_context(card, 10, 10), lambda: window.context_menu),
                ("main menu", window.menu_button.popup, window.menu_button.get_popover),
                ("filters", window.open_filters_popover, lambda: window.filter_popover)):
            with self.subTest(name):
                popup(); self.drain(.2)
                shown = popover()
                self.assertTrue(shown.get_visible())
                with patch.object(window, "is_active", return_value=False):
                    window.notify("is-active")
                    self.drain(.2)
                self.assertFalse(shown.get_visible())

    def test_cards_that_leave_the_board_are_freed(self):
        window = self.snapshot_window()
        window.set_default_size(700, 600)
        window.present(); self.drain(.4)
        # The Comfortable cards have the copy button.
        window.view_filter.set_selected(1); self.drain(.4)
        gone = ["sample-1", "sample-2", "sample-3"]
        hidden = ["sample-40", "sample-41"]
        # A card of a column far outside the view gets its Comfortable content when its column fills.
        cards = [window.card_for(identity) for identity in gone + hidden]
        for card in cards:
            window.ensure_card_controls(card)
        del card
        self.assertTrue(all(getattr(card, "asb_copy_button", None) is not None for card in cards))
        references = [weakref.ref(card) for card in cards]
        del cards
        # Rows that leave the session list.
        dashboard = mock_dashboard()
        dashboard["threads"] = [row for row in dashboard["threads"] if row["id"] not in gone]
        window.apply_dashboard(dashboard, None)
        self.drain(.3)
        self.assertFalse(set(gone) & set(window.row_cache))
        # A cache trim after a search releases the hidden cards.
        window.card_limit = 2
        window.search.set_text("Build pipeline"); self.drain(.6)
        window.trim_row_cache()
        self.assertFalse(set(hidden) & set(window.row_cache))
        window.search.set_text(""); self.drain(.3)
        gc.collect()
        self.drain(.2)
        gc.collect()
        self.assertEqual([reference() for reference in references], [None] * len(references))

    def test_filter_chips_wait_for_popover_close(self):
        window = self.snapshot_window()
        dashboard = mock_dashboard()
        dashboard["providers"] = [{"id": "codex", "label": "Codex Account One", "provider": "codex", "color": "#8296b4"}]
        window.dashboard = dashboard
        window.filter_model = asb.filter_profiles(dashboard)
        window.render()
        window.set_default_size(1040, 400)
        window.present(); self.drain(.3)
        window.open_filters_popover(); self.drain(.3)
        found, before = window.filters_pill.compute_point(window, asb.Graphene.Point())
        self.assertTrue(found)
        window.filter_popover_rows["state:working"].set_active(True)
        window.filter_popover_rows["profile:|codex"].set_active(True)
        self.drain(.3)
        found, after = window.filters_pill.compute_point(window, asb.Graphene.Point())
        self.assertTrue(found)
        self.assertEqual((before.x, before.y), (after.x, after.y))
        self.assertEqual(window.filter_chip_widgets, {})
        self.assertIsNone(window.chip_box.get_first_child())
        self.assertNotIn("asb-" + "filters-on", window.filters_pill.get_css_classes())
        self.assert_accessible_label(window.filters_pill, window.filter_description(), asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.assertEqual(window.filter_description(), "Working, Codex Account One")
        self.assertTrue(window.filter_popover_rows["state:working"].get_active())
        self.assertTrue(window.filter_popover_rows["profile:|codex"].get_active())
        self.assertTrue(window.visible_rows())
        self.assertTrue(all(row["state"] == "working" and row["provider"] == "codex" for row in window.visible_rows()))
        self.assertEqual(window.row_order, [row["id"] for row in window.visible_rows()])
        window.filter_popover_key(None, asb.Gdk.KEY_Escape, 0, 0); self.drain(.3)
        self.assertEqual(list(window.filter_chip_widgets), ["state:working", "profile:|codex"])
        self.assertEqual(list(window.filter_chip_widgets), [key for key, *_rest in window.active_filter_chips()])
        self.assertIs(window.get_focus(), window.filters_pill)
        window.open_filters_popover(); self.drain(.2)
        window.filter_popover_rows["pending"].set_active(True)
        window.filter_popover_rows["archive"].asb_filter_switch.set_active(True)
        window.filter_popover_rows["clear"].emit("clicked"); self.drain(.4)
        self.assertFalse(window.filters_active())
        self.assertEqual(window.filter_chip_widgets, {})
        self.assertIsNone(window.chip_box.get_first_child())
        # A new model builds the rows again. GTK gives each popover one key controller; ASB adds exactly one more.
        dashboard["providers"].append({"id": "codex-2", "label": "Codex Account Two", "provider": "codex", "color": "#c4a882"})
        window.filter_model = asb.filter_profiles(dashboard)
        window.open_filters_popover(); self.drain(.2)
        self.assertIn("profile:|codex-2", window.filter_popover_rows)
        key_controllers = lambda widget: sum(isinstance(controller, asb.Gtk.EventControllerKey) for controller in widget.observe_controllers())
        self.assertEqual(key_controllers(window.filter_popover), key_controllers(asb.Gtk.Popover()) + 1)

    def test_wide_search_allows_one_resize_to_narrow(self):
        window = self.snapshot_window()
        window.set_default_size(1040, 400)
        window.present(); self.drain(.4)
        self.assertTrue(window.wide_controls)
        window.open_search(); window.search.set_text("ac"); self.drain(.3)
        self.assertTrue(window.search_row.get_reveal_child())
        self.assertLessEqual(window.measure(asb.Gtk.Orientation.HORIZONTAL, -1)[0], 360)
        border_width = window.get_default_size().width - window.get_width()
        window.set_default_size(400 + border_width, 400); self.drain(.4)
        self.assertEqual(window.get_width(), 400)
        self.assertFalse(window.wide_controls)

    def test_six_chips_keep_the_pills_at_their_natural_width(self):
        window = self.snapshot_window()
        dashboard = mock_dashboard()
        dashboard["providers"] = [
            {"id": "codex", "label": "Codex Account One", "provider": "codex", "color": "#8296b4"},
            {"id": "claude-desktop-code", "label": "Claude Account Two", "provider": "claude-desktop-code", "color": "#a28caa"},
        ]
        window.dashboard = dashboard
        window.filter_model = asb.filter_profiles(dashboard)
        window.render()
        window.set_default_size(1040, 400)
        window.present(); self.drain(.3)
        window.set_pending(True)
        select_states(window, {"working", "waiting"})
        toggle_profile(window, "|codex")
        toggle_profile(window, "|claude-desktop-code")
        window.set_archived(True); self.drain(.4)
        self.assertEqual(len(window.filter_chip_widgets), 6)
        self.assertEqual(window.search.get_size_request().width, -1)
        for pill in (window.drawer_only, window.filters_pill):
            self.assertGreaterEqual(pill.get_allocated_width(), pill.measure(asb.Gtk.Orientation.HORIZONTAL, -1)[1])

    def test_active_filters_keep_normal_pill_css(self):
        window = self.snapshot_window()
        select_states(window, {"working"})
        for palette in (None, asb.validate_theme(CUSTOM)):
            with self.subTest(palette=palette):
                window.set_palette(palette)
                self.assertNotIn("asb-" + "filters-on", window.filters_pill.get_css_classes())
                self.assertNotIn("asb-" + "filters-on", window.css.to_string())
                self.assert_accessible_label(window.filters_pill, "Working", asb.Gtk.AccessibleProperty.DESCRIPTION)

    def test_profiles_show_remote_claude_sessions_only_for_claude_and_save_the_choice(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body, headers))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        def reply(route, value=None, error=None):
            item = next(item for item in reversed(requests) if item[0] == route)
            item[1](copy.deepcopy(value), error)
            self.drain(.15)
            return item
        def walk(widget):
            yield widget
            child = widget.get_first_child()
            while child:
                yield from walk(child)
                child = child.get_next_sibling()
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
        preferences.stack.set_visible_child_name("profiles"); self.drain(.1)
        editor = preferences.profiles_editor
        self.assertEqual(editor.message.get_label(), "Loading profiles…")
        self.assertFalse(editor.bridge_header.get_visible())
        self.assertIsNone(editor.dialog)
        sources = [{"id": "codex", "provider": "codex", "label": "Personal", "enabled": True, "builtin": True,
                    "dataDir": "/example/profiles/codex", "launcher": "", "color": "#8296b4", "showMarker": True,
                    "sessionCount": 5, "status": "ok"},
                   {"id": "studio", "provider": "claude-desktop-code", "label": "Studio", "enabled": True,
                    "dataDir": "/example/profiles/studio", "launcher": "/example/apps/studio.desktop",
                    "projectsDir": "/example/transcripts", "color": "#b28f80", "showMarker": True,
                    "sessionCount": 1, "status": "ready", "remoteClaude": "native"},
                   {"id": "opencode", "provider": "opencode", "label": "OpenCode", "enabled": True, "builtin": True,
                    "dataDir": "/example/profiles/opencode", "launcher": "", "color": "#899e91", "showMarker": True,
                    "sessionCount": 2, "status": "ok"},
                   {"id": "off", "provider": "codex", "label": "Test", "enabled": False,
                    "dataDir": "/example/profiles/off", "launcher": "", "color": "#a28caa", "showMarker": False,
                    "sessionCount": 0, "status": "disabled"}]
        source_reply = {"sources": sources, "maxSources": 8, "revision": "a" * 64}
        reply("/api/sources", source_reply)
        self.assertFalse(editor.message.get_visible())
        self.assertFalse(editor.bridge_header.get_visible())
        self.assertEqual(requests[-1][0], "/api/bridge")
        apps = [{"sourceId": identity, "label": title, "provider": provider, "state": state,
                 "version": version, "live": live, "canInstall": install}
                for identity, title, provider, state, version, live, install in
                (("codex", "Codex", "codex", "ready", "0.8.0", 2, False),
                 ("studio", "Studio", "claude-desktop-code", "missing", None, 0, True),
                 ("opencode", "OpenCode", "opencode", "update", "0.7.0", 1, False))]
        bridge = {"api": 1, "machines": [{"machineId": "self123456", "name": "atlas", "isSelf": True, "state": "ok", "apps": apps}]}
        reply("/api/bridge", bridge)
        self.assertTrue(editor.bridge_header.get_visible())
        self.assertEqual(editor.bridge_header.get_label(), "ASB Bridge")
        self.assertTrue(all(editor.bridge_header.has_css_class(css) for css in ("caption", "dim-label")))
        self.assertEqual(editor.table.get_selection_mode(), asb.Gtk.SelectionMode.NONE)
        self.assertTrue(editor.table.has_css_class("boxed-list"))
        rows = board_listed(editor.table)
        self.assertEqual([row.get_title() for row in rows], ["Personal", "Studio", "OpenCode", "Test"])
        self.assertEqual([row.get_subtitle() for row in rows],
                         ["Codex · 5 chats", "Claude Desktop Code · 1 chat", "OpenCode · 2 chats", "Codex · Off"])
        self.assertEqual([row.asb_state_label.get_label() for row in rows], ["Ready", "Not installed", "Old version", "Off"])
        for row, source, state in zip(rows, sources, ("ready", "missing", "update", None)):
            self.assertTrue(row.get_activatable())
            self.assertFalse(row.get_use_markup())
            self.assertEqual((row.get_title_lines(), row.get_subtitle_lines()), (0, 0))
            self.assertEqual(row.asb_marker.get_valign(), asb.Gtk.Align.CENTER)
            self.assertEqual(row.asb_state_label.get_wrap_mode(), asb.Pango.WrapMode.WORD)
            self.assertEqual(row.asb_state_label.get_natural_wrap_mode(), asb.Gtk.NaturalWrapMode.NONE)
            self.assertTrue(row.asb_state_label.has_css_class("dim-label"))
            if state:
                self.assertEqual(row.asb_state_icon.get_icon_name(), asb.BRIDGE_STATES[state][1])
                self.assertTrue(row.asb_state_icon.has_css_class(asb.BRIDGE_STATES[state][2]))
            else:
                self.assertIsNone(row.asb_state_icon)
            self.assertIn("go-next-symbolic", [node.get_icon_name() for node in walk(row) if isinstance(node, asb.Gtk.Image)])
            self.assert_accessible_label(row, f"ASB Bridge: {row.asb_state_label.get_label()}. Profile color: {source['color']}",
                                         asb.Gtk.AccessibleProperty.DESCRIPTION)
        header_bounds = editor.bridge_header.compute_bounds(editor)[1]
        state_bounds = rows[0].asb_state_label.compute_bounds(editor)[1]
        header_right = header_bounds.get_x() + header_bounds.get_width()
        state_right = state_bounds.get_x() + state_bounds.get_width()
        self.assertLessEqual(abs(header_right - state_right), 4)
        self.assertEqual(editor.add_button.get_child().get_label(), "Add a profile")
        self.assertEqual(editor.reload_button.get_icon_name(), "view-refresh-symbolic")
        self.assertTrue(editor.reload_button.has_css_class("flat"))
        self.assert_accessible_label(editor.reload_button, "Refresh")
        self.assertEqual(editor.count.get_label(), "4 of 8 profiles")
        editor.table.emit("row-activated", rows[1]); self.drain(.3)
        self.assertIsInstance(editor.dialog, asb.Adw.Dialog)
        self.assertIs(editor.dialog.get_root(), preferences)
        self.assertEqual(editor.dialog.get_content_width(), 560)
        dialog = editor.dialog
        self.assertEqual((editor.dialog_title.get_title(), editor.dialog_title.get_subtitle()),
                         ("Studio", "Claude Desktop Code · 1 chat"))
        # Each folder button opens a file dialog with its own title.
        def buttons(widget):
            child = widget.get_first_child()
            while child:
                if isinstance(child, asb.Gtk.Button):
                    yield child
                yield from buttons(child)
                child = child.get_next_sibling()
        titles = []
        def start(chooser, _parent, _cancellable, callback):
            titles.append(chooser.get_title())
            callback(chooser, None)
        def dismissed(_chooser, _result):
            raise asb.GLib.Error.new_literal(asb.Gtk.dialog_error_quark(), "Dismissed by user", int(asb.Gtk.DialogError.DISMISSED))
        with patch.object(asb.Gtk.FileDialog, "select_folder", start), patch.object(asb.Gtk.FileDialog, "select_folder_finish", dismissed):
            for entry in (editor.projects_dir, editor.data_dir):
                next(button for button in buttons(entry) if button.get_tooltip_text() and button.get_tooltip_text().startswith("Choose ")).emit("clicked")
        self.assertEqual(titles, ["Choose transcript folder", "Choose session folder"])
        self.assertFalse(editor.choosing)
        self.assertEqual(editor.name.get_delegate().get_max_length(), 80)
        self.assertTrue(all(isinstance(widget, asb.Adw.EntryRow) for widget in
                            (editor.name, editor.data_dir, editor.launcher, editor.projects_dir)))
        self.assertEqual(editor.enabled.get_subtitle(), "Show the chats of this profile on the board.")
        self.assertEqual(editor.bridge_row.get_title(), "Not installed")
        self.assertEqual(editor.bridge_row.get_subtitle(), asb.BRIDGE_NONE_BODY)
        self.assertEqual(editor.install_button.get_label(), "Install")
        self.assertEqual(editor.files_group.get_description(), "Choose the app profile folder with claude-code-sessions or Cache. Added profiles need an installed app launcher. An empty Transcript folder uses ~/.claude/projects.")
        self.assertTrue(all(widget.get_visible() for widget in editor.transcript_widgets))
        self.assertTrue(editor.remote_claude.get_use_subtitle())
        self.assertEqual(editor.remote_claude.get_selected(), 2)
        self.assertEqual(editor.remote_claude_note.get_label(), asb.REMOTE_CLAUDE[2][2])
        self.assertGreaterEqual(editor.remote_claude_note.compute_bounds(editor.form)[1].get_y(),
                                editor.remote_claude.compute_bounds(editor.form)[1].get_y() + editor.remote_claude.get_height())
        self.assertTrue(editor.remove_button.get_visible())
        self.assertEqual(editor.color_row.get_subtitle(), "#b28f80")
        for marker, (name, color) in zip(editor.preset_markers, asb.SOURCE_COLOR_PRESETS):
            button = marker.get_parent()
            self.assertTrue(marker.has_css_class("asb-preset-swatch"))
            self.assertTrue(button.has_css_class("flat") and button.has_css_class("circular"))
            self.assertEqual(button.get_tooltip_text(), f"{name}: {color}")
            self.assert_accessible_label(button, f"Use {name} profile color")
            self.assertGreaterEqual(marker.get_width(), 14)
        self.assertFalse(preferences.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
        editor.remote_claude.set_selected(1); self.drain(.05)
        self.assertEqual(editor.remote_claude_note.get_label(), asb.REMOTE_CLAUDE[1][2])
        self.assert_accessible_label(editor.remote_claude, asb.REMOTE_CLAUDE[1][2], asb.Gtk.AccessibleProperty.DESCRIPTION)
        editor.name.set_text("Draft Studio")
        editor.save_button.emit("clicked")
        self.assertEqual(requests[-1][3], {"source": {"id": "studio", "provider": "claude-desktop-code", "label": "Draft Studio",
            "dataDir": "/example/profiles/studio", "launcher": "/example/apps/studio.desktop", "projectsDir": "/example/transcripts",
            "enabled": True, "color": "#b28f80", "showMarker": True, "remoteClaude": "bridge"}})
        self.assertEqual(requests[-1][4], {"If-Match": '"' + "a" * 64 + '"'})
        reply("/api/sources", error="The store is in use.")
        self.assertTrue(editor.editing)
        self.assertEqual(editor.dialog_message.get_label(), "The store is in use.")
        self.assertEqual(editor.name.get_text(), "Draft Studio")
        editor.install_button.emit("clicked")
        self.assertEqual((requests[-1][0], requests[-1][2], requests[-1][3]),
                         ("/api/bridge/install", "POST", {"sourceId": "studio"}))
        self.assertEqual(editor.install_button.get_label(), "Installing…")
        self.assertFalse(editor.install_button.get_sensitive())
        reply("/api/bridge/install", {"ok": True, "output": "ok"})
        self.assertEqual(editor.install_result.get_label(), "Installed.")
        self.drain(.1)
        self.assertTrue(editor.install_result.get_mapped() and editor.remote_claude_note.get_mapped())
        note_y = editor.remote_claude_note.compute_bounds(editor.form)[1].get_y()
        result_y = editor.install_result.compute_bounds(editor.form)[1].get_y()
        self.assertGreater(result_y, note_y)
        self.assertEqual(requests[-1][0], "/api/bridge")
        reply("/api/bridge", bridge)
        preferences.close(); self.drain(.15)
        self.assertTrue(editor.editing)
        window.open_preferences(); self.drain(.15)
        reply("/api/sources", source_reply)
        reply("/api/bridge", bridge)
        self.assertIs(editor.dialog, dialog)
        self.assertTrue(editor.editing)
        self.assertEqual(editor.name.get_text(), "Draft Studio")
        editor.save_button.emit("clicked")
        reply("/api/sources", {**source_reply, "sources": [sources[0], {**sources[1], "label": "Draft Studio", "remoteClaude": "bridge"}, *sources[2:]]})
        self.drain(.3)
        self.assertFalse(editor.editing)
        self.assertEqual(editor.message.get_label(), "Saved.")
        self.assertEqual((editor.editing_id, editor.form_baseline, editor.baseline_source, editor.edit_revision), ("", None, None, None))
        editor.open_source(editor.sources[2]); self.drain(.3)
        self.assertIs(editor.dialog, dialog)
        self.assertFalse(editor.provider.get_visible())
        self.assertTrue(editor.provider_fixed.get_visible())
        self.assertTrue(editor.launcher_fixed.get_visible())
        self.assertFalse(editor.launcher.get_visible())
        self.assertFalse(editor.data_dir.get_editable())
        self.assertTrue(all(not button.get_sensitive() for button in editor.choose_buttons))
        self.assertFalse(any(widget.get_visible() for widget in editor.transcript_widgets))
        self.assertFalse(editor.remove_button.get_visible())
        self.assertEqual(editor.bridge_row.get_title(), "Old version · 0.7.0 · 1 live")
        self.assertEqual(editor.bridge_row.get_subtitle(), "Update, then restart OpenCode.")
        self.assertIn(editor.files_group.get_description(), (None, ""))
        self.assertTrue(editor.dialog_key(None, asb.Gdk.KEY_Escape, 0, 0)); self.drain(.3)
        preferences.set_default_size(420, 700); self.drain(.3)
        self.assertEqual(preferences.get_width(), 420)
        preferences.show_section("profiles"); self.drain(.3)
        # The editor reloads when its section shows again; the engine answers before a form opens.
        reply("/api/sources", {**source_reply, "sources": editor.sources})
        self.assertFalse(editor.loading)
        GTK_WARNINGS.clear()
        # Check the list and every form at phone width, including long state and error text.
        for source in (None, *editor.sources):
            if source is not None:
                editor.open_source(source)
                self.drain(.3)
            for scroll in (node for node in walk(preferences) if isinstance(node, asb.Gtk.ScrolledWindow)
                           and node.get_mapped()):
                adjustment = scroll.get_hadjustment()
                self.assertLessEqual(adjustment.get_upper(), adjustment.get_page_size() + 1)
                for row in (node for node in walk(scroll) if isinstance(node, asb.Gtk.ListBoxRow) and node.get_mapped()):
                    found, bounds = row.compute_bounds(scroll)
                    self.assertTrue(found)
                    self.assertGreaterEqual(bounds.get_x(), -1)
                    self.assertLessEqual(bounds.get_x() + bounds.get_width(), scroll.get_width() + 1)
            if source is not None:
                editor.cancel_form(); self.drain(.3)
        self.assertEqual(GTK_WARNINGS, [])

    def test_machines_show_bridge_lines_for_this_machine_and_members(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route != "/api/palette":
                requests.append((route, callback))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
        preferences.stack.set_visible_child_name("machines"); self.drain(.1)
        editor = preferences.machines_editor
        self.assertEqual([route for route, _callback in requests], ["/api/group", "/api/bridge"])
        own = {"machineId": "3f9a2c71e0b4d58a", "name": "atlas"}
        laptop = {"machineId": "8c41e9d27b3a05f6", "name": "laptop", "online": True, "lastOkAtMs": NOW, "isSelf": False,
                  "addresses": [{"kind": "lan", "address": "192.168.1.24"}]}
        studio = {"machineId": "51b7f0aa3c8e2d9b", "name": "studio", "online": False, "lastOkAtMs": 0, "isSelf": False,
                  "addresses": []}
        group = {"groupId": "7d2e91c4b06fa358", "self": own, "networkEnabled": True, "phones": [],
                 "members": [{**own, "isSelf": True, "online": True, "lastOkAtMs": NOW, "addresses": []}, laptop, studio]}
        requests[0][1](copy.deepcopy(group), None); self.drain(.05)
        bridge = {"api": 1, "machines": [
            {"machineId": own["machineId"], "name": "atlas", "isSelf": True, "state": "ok",
             "apps": [{"sourceId": "codex", "label": "Codex", "state": "ready"},
                      {"sourceId": "personal", "label": "Codex Personal", "state": "hooks"},
                      {"sourceId": "opencode", "label": "OpenCode", "state": "update"}]},
            {"machineId": laptop["machineId"], "name": "laptop", "isSelf": False, "state": "old", "live": 2, "apps": []},
            {"machineId": studio["machineId"], "name": "studio", "isSelf": False, "state": "offline", "apps": []}]}
        requests[1][1](bridge, None); self.drain(.05)
        self.assertEqual(editor.self_row.get_subtitle(),
                         "ID 3f9a2c71\nBridge: Codex ready · Codex Personal hooks not trusted · OpenCode old version")
        subtitles = [row.get_subtitle() for row in board_listed(editor.others)]
        self.assertTrue(subtitles[0].endswith("\nBridge: unknown, needs ASB 1.12+ · 2 live"))
        self.assertTrue(subtitles[1].endswith("\nBridge: not checked while offline"))

    def test_profile_rows_keep_focus_and_a_running_save_keeps_the_dialog(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        def reply(route, value=None, error=None):
            item = next(item for item in reversed(requests) if item[0] == route)
            item[1](copy.deepcopy(value), error)
            self.drain(.5)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
        preferences.stack.set_visible_child_name("profiles"); self.drain(.1)
        editor = preferences.profiles_editor
        def source(identity, title, builtin=False):
            return {"id": identity, "provider": "codex", "label": title, "enabled": True, "builtin": builtin,
                    "dataDir": "/example/profiles/" + identity, "launcher": "" if builtin else "/example/apps/codex.desktop",
                    "color": "#8296b4", "showMarker": True, "sessionCount": 2, "status": "ok"}
        sources = [source("codex", "Codex", True), source("personal", "Codex Personal"), source("added", "Added"),
                   source("work", "Work")]
        def bridge(personal="ready"):
            return {"api": 1, "machines": [{"machineId": "self", "name": "atlas", "isSelf": True, "state": "ok", "apps": [
                {"sourceId": item["id"], "label": item["label"], "provider": "codex",
                 "state": personal if item["id"] == "personal" else "ready", "version": "0.8.0", "live": 1,
                 "canInstall": False} for item in sources]}]}
        reply("/api/sources", {"sources": sources, "maxSources": 8, "revision": "a" * 64})
        reply("/api/bridge", bridge())
        rows = board_listed(editor.table)
        # A render while another page shows starts no frame tick; showing Profiles again aligns the header once.
        preferences.stack.set_visible_child_name("appearance"); self.drain(.1)
        editor.render_sources()
        self.drain(.5)
        self.assertIsNone(editor.header_tick)
        preferences.stack.set_visible_child_name("profiles"); self.drain(.5)
        self.assertIsNone(editor.header_tick)
        # The page shows again, so it reads the profiles and the bridge again.
        self.assertEqual(requests[-1][0], "/api/sources")
        reply("/api/sources", {"sources": sources, "maxSources": 8, "revision": "a" * 64})
        reply("/api/bridge", bridge())
        self.assertIsNone(editor.header_tick)
        rows = board_listed(editor.table)
        # (e) The measured header margin puts its right edge on the right edge of the state text.
        header = editor.bridge_header.compute_bounds(editor)[1]
        state = rows[0].asb_state_label.compute_bounds(editor)[1]
        self.assertLessEqual(abs(header.get_x() + header.get_width() - state.get_x() - state.get_width()), 1)
        # (a) A bridge reply that changes only the focused row keeps that row object and its focus.
        personal = rows[1]
        personal.grab_focus(); self.drain(.05)
        editor.request_bridge()
        reply("/api/bridge", bridge("hooks"))
        self.assertEqual(board_listed(editor.table), rows)
        self.assertIs(preferences.get_focus(), personal)
        self.assertEqual(personal.asb_state_label.get_label(), "Hooks not trusted")
        self.assertEqual(personal.asb_state_icon.get_icon_name(), "dialog-warning-symbolic")
        # (d) Escape and dialog.close() during a save keep the dialog; the error shows there with the edits.
        editor.table.emit("row-activated", personal); self.drain(.3)
        dialog = editor.dialog
        editor.name.set_text("Codex Private")
        editor.save_button.emit("clicked")
        self.assertTrue(editor.saving)
        self.assertFalse(dialog.get_can_close())
        self.assertTrue(editor.dialog_key(None, asb.Gdk.KEY_Escape, 0, 0))
        dialog.close(); self.drain(.5)
        self.assertTrue(editor.editing)
        self.assertTrue(dialog.get_mapped())
        reply("/api/sources", error="The store is in use.")
        self.assertTrue(editor.editing and dialog.get_mapped())
        self.assertEqual(editor.dialog_message.get_label(), "The store is in use.")
        self.assertEqual(editor.name.get_text(), "Codex Private")
        # (b) Save gives the focus back to the same row object, which shows the new name.
        editor.save_button.emit("clicked")
        sources[1] = {**sources[1], "label": "Codex Private"}
        reply("/api/sources", {"sources": sources, "maxSources": 8, "revision": "b" * 64})
        self.assertFalse(editor.editing)
        self.assertIs(board_listed(editor.table)[1], personal)
        self.assertEqual(personal.get_title(), "Codex Private")
        self.assertIs(preferences.get_focus(), personal)
        # (c) Remove gives the focus to the row that took the place of the removed row.
        added, work = board_listed(editor.table)[2:]
        added.grab_focus()
        editor.table.emit("row-activated", added); self.drain(.3)
        editor.remove_button.emit("clicked")
        self.assertEqual(requests[-1][0::2], ("/api/sources/added/remove", "POST"))
        del sources[2]
        reply("/api/sources/added/remove", {"sources": sources, "maxSources": 8, "revision": "c" * 64})
        self.assertFalse(editor.editing)
        self.assertEqual(board_listed(editor.table)[2], work)
        self.assertIs(preferences.get_focus(), work)

    def early_window(self, taken=False):
        """A window that waits for the early request of the launcher start; waiting keeps the callback that the request calls.
        With taken, an earlier window took the result: deliver returns False."""
        requests, waiting = [], []
        def deliver(callback, dispatch):
            waiting.append((callback, dispatch))
            return not taken
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body, etag))
        for target, name, value in ((asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        first_load = SimpleNamespace(deliver=deliver)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", theme_path=False, layout_path=False, first_load=first_load)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        return window, requests, waiting

    def test_the_early_dashboard_is_the_first_dashboard_and_its_tag_goes_to_the_next_request(self):
        window, requests, waiting = self.early_window()
        # The window asks for nothing itself while the early request is open, and a refresh waits in the queue.
        self.assertEqual((len(waiting), requests, window.loading, window.dashboard), (1, [], True, None))
        window.refresh(queue=True)
        self.assertEqual((requests, window.refresh_queued), ([], True))
        callback, dispatch = waiting[0]
        dispatch(callback, copy.deepcopy(FIXTURE), None, ['"early"'])
        self.drain(.3)
        self.assertIn("second", window.row_order)
        self.assertEqual(window.dashboard_etag, '"early"')
        self.assertEqual(window.notice.get_visible(), False)
        # The queued refresh is the only request, and it asks with the tag of the early reply.
        self.assertEqual([(route, etag) for route, _callback, _method, _body, etag in requests if route == "/api/dashboard"], [("/api/dashboard", ['"early"'])])

    def test_a_window_that_finds_the_early_result_taken_asks_for_the_first_dashboard_itself(self):
        window, requests, waiting = self.early_window(taken=True)
        self.assertEqual([(route, method) for route, _callback, method, _body, _etag in requests], [("/api/dashboard", "GET")])
        self.assertTrue(window.loading)
        requests[0][1](copy.deepcopy(FIXTURE), None)
        self.drain(.2)
        self.assertIn("second", window.row_order)
        self.assertFalse(window.loading)

    def test_a_failed_early_dashboard_shows_no_notice_and_the_normal_first_refresh_asks_again(self):
        window, requests, waiting = self.early_window()
        callback, dispatch = waiting[0]
        dispatch(callback, None, "Cannot load sessions. Check that ASB is running, then refresh.", [None])
        self.drain(.2)
        self.assertEqual(window.notice.get_visible(), False)
        self.assertEqual([(route, method) for route, _callback, method, _body, _etag in requests], [("/api/dashboard", "GET")])
        self.assertTrue(window.loading)
        requests[0][1](copy.deepcopy(FIXTURE), None)
        self.drain(.2)
        self.assertIn("second", window.row_order)
        self.assertFalse(window.loading)

    def snapshot_window(self):
        """A window that has its first dashboard at once, as when the early request of the launcher start ends first. It is not mapped."""
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", mock_dashboard(), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        return window

    def test_the_snapshot_waits_for_a_drawn_frame_and_saves_one_image(self):
        with tempfile.TemporaryDirectory(prefix="asb-snapshot-") as temporary:
            image = Path(temporary) / "board.png"
            with patch.dict(os.environ, {"ASB_SNAPSHOT": str(image)}), patch.object(asb, "save_snapshot", wraps=asb.save_snapshot) as saved, \
                    contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as errors:
                window = self.snapshot_window()
                # A window that is not mapped draws no frame, so no save is tried. A fixed timer tried it here and failed.
                self.drain(.6)
                saved.assert_not_called()
                self.assertFalse(image.exists())
                window.present()
                for _attempt in range(100):
                    if image.exists():
                        break
                    self.drain(.1)
                # Later frames must not save it again.
                self.drain(.6)
            self.assertGreater(image.stat().st_size, 0)
            saved.assert_called_once()
            self.assertEqual(out.getvalue(), "Saved the native ASB window image.\n")
            self.assertNotIn("Cannot save the native GTK image", errors.getvalue())

    def test_the_snapshot_starts_one_frame_watch_only_when_asb_snapshot_is_set(self):
        with patch.object(asb.SwitchboardWindow, "add_tick_callback") as watch:
            with patch.dict(os.environ):
                os.environ.pop("ASB_SNAPSHOT", None)
                self.snapshot_window()
            watch.assert_not_called()
            with patch.dict(os.environ, {"ASB_SNAPSHOT": "board.png"}):
                window = self.snapshot_window()
                window.apply_dashboard(copy.deepcopy(FIXTURE), None)
            watch.assert_called_once()

    def test_the_preferences_window_exists_only_after_the_first_open_and_takes_a_custom_theme_set_before(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", lambda *_args, **_kwargs: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        windows = lambda: sum(isinstance(item, asb.PreferencesWindow) for item in self.application.get_windows())
        self.assertEqual((window.preferences_window, windows()), (None, 0))
        # The settings widgets of the Preferences pages work before the window exists.
        window.set_theme_pickers(CUSTOM)
        window.theme_mode.set_selected(1)
        window.apply_theme()
        window.states = {"idle"}
        self.assertTrue(window.has_css_class("asb-custom"))
        self.assertEqual((window.preferences_window, windows()), (None, 0))
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
        self.assertEqual(windows(), 1)
        self.assertTrue(preferences.get_visible())
        self.assertTrue(preferences.has_css_class("asb-custom"))
        # The pages hold the widgets that the board already used.
        self.assertIs(window.color_buttons["accent"].get_root(), preferences)
        self.assertEqual(window.states, {"idle"})
        window.reset_theme()
        self.assertFalse(preferences.has_css_class("asb-custom"))
        preferences.close(); window.open_preferences(); self.drain(.1)
        self.assertIs(window.preferences_window, preferences)
        self.assertEqual(windows(), 1)

    def test_preferences_sections_reuse_lazy_profiles_theme_and_narrow_layout(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route == "/api/bridge":
                callback({"api": 1, "machines": []}, None)
            elif route != "/api/palette":  # The window shares its palette at start; this test checks the other requests.
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        # The window start makes no Preferences window: the first click on the button makes it.
        self.assertIsNone(window.preferences_window)
        self.assertEqual(sum(isinstance(item, asb.PreferencesWindow) for item in self.application.get_windows()), 0)
        self.assertEqual(requests, [])
        window.activate_action("win.preferences", None); self.drain(.2)
        preferences = window.preferences_window
        self.assertTrue(preferences.get_visible())
        self.assertIsNone(preferences.profiles_editor)
        self.assertEqual(requests, [])
        self.assertEqual((preferences.get_width(), preferences.get_height()), (780, 560))
        self.assertIs(preferences.get_transient_for(), window)
        self.assertTrue(preferences.get_destroy_with_parent())
        self.assertFalse(preferences.get_modal())
        self.assertTrue(preferences.sidebar.get_visible())
        self.assertEqual(preferences.pages.get_visible_child_name(), "section")
        self.assertFalse(preferences.back.get_visible())
        self.assert_accessible_label(window.menu_button, "Main menu")
        window.open_preferences()
        self.assertEqual(sum(isinstance(item, asb.PreferencesWindow) for item in self.application.get_windows()), 1)
        window.states = {"working"}
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
        editor.open_source(sources[0])
        self.assertFalse(editor.provider.get_sensitive())
        self.assertFalse(editor.remove_button.get_sensitive())
        editor.open_source(sources[2])
        self.assertEqual((editor.provider.get_visible(), editor.provider_fixed.get_visible(), editor.provider_fixed.get_title()),
                         (False, True, "App"))
        self.assertEqual((editor.data_dir.get_editable(), editor.launcher.get_editable()), (False, False))
        self.assertTrue(all(not button.get_sensitive() for button in editor.choose_buttons))
        self.assertFalse(any(widget.get_visible() for widget in editor.transcript_widgets))
        editor.open_source(sources[0])
        self.assertEqual((editor.provider.get_visible(), editor.provider_fixed.get_visible(), editor.data_dir.get_editable()),
                         (True, False, True))
        self.assertTrue(all(button.get_sensitive() for button in editor.choose_buttons))
        editor.cancel_form(); self.drain(.3)
        capture("profiles-wide")
        editor.add_source(); self.drain(.3)
        editor.name.set_text("Draft profile")
        self.assertIs(editor.dialog.get_root(), preferences)
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
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        capture("list-narrow")
        preferences.show_section("profiles"); self.drain(.2)
        capture("profiles-narrow")
        preferences.go_back(); preferences.show_section("sessions"); self.drain(.2)
        self.assertEqual(preferences.get_width(), 420)
        capture("sessions-narrow")
        preferences.go_back(); preferences.show_section("appearance"); self.drain(.2)
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
        # The narrow Profiles page showed again after the section list, so it loaded once more.
        self.assertEqual(sum(route == "/api/sources" for route, *_args in requests), 4)
        editor.reload_sources()
        callback = requests[-1][1]
        window.close(); self.drain(.1)
        self.assertTrue(preferences.closed)
        self.assertTrue(editor.closed)
        self.assertTrue(editor.cancellable.is_cancelled())
        self.assertFalse(callback({"sources": []}, None))
        self.assertEqual(editor.sources, sources)

    def test_preferences_layout_change_keeps_the_page_and_moves_focus_to_its_navigation_item(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
        self.assertEqual(preferences.get_width(), 780)
        preferences.stack.set_visible_child_name("profiles"); self.drain(.1)
        rows = preferences.sidebar.get_first_child()
        while rows and not isinstance(rows, asb.Gtk.ListBox):
            rows = rows.get_first_child()
        profiles_row = rows.get_selected_row()
        self.assertEqual(profiles_row.get_index(), 2)
        profiles_row.grab_focus(); self.drain(.1)
        self.assertIs(preferences.get_focus(), profiles_row)
        before = list(requests)
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertEqual(preferences.stack.get_visible_child_name(), "profiles")
        self.assertIsNotNone(preferences.get_current_breakpoint())
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        list_row = preferences.get_focus()
        self.assertIs(list_row.get_parent(), preferences.section_list)
        self.assertEqual(list_row.get_title(), "Profiles")
        preferences.set_default_size(780, 560); self.drain(.3)
        self.assertEqual(preferences.stack.get_visible_child_name(), "profiles")
        self.assertIsNone(preferences.get_current_breakpoint())
        self.assertIs(preferences.get_focus(), profiles_row)
        self.assertIs(rows.get_selected_row(), profiles_row)
        # Wide again from the back button: the focus goes to the sidebar row, not out of the window.
        preferences.set_default_size(420, 560); self.drain(.3)
        preferences.show_section("profiles"); self.drain(.1)
        self.assertIs(preferences.get_focus(), preferences.back)
        preferences.set_default_size(780, 560); self.drain(.3)
        self.assertIs(preferences.get_focus(), profiles_row)
        self.assertNotIn("/api/phone", [item[0] for item in requests[len(before):]])
        self.assertEqual((preferences.phone_editor, preferences.machines_editor), (None, None))

    def test_preferences_narrow_section_list_back_escape_report_and_full_height_dialog(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route != "/api/palette":
                requests.append((route, callback, method, body))
            if route == "/api/agent/ui":
                callback({}, None)
            return SimpleNamespace(join=lambda *_args: None)
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", request), (asb, "SOURCE_TOKEN", "fake-token")):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        def visible():
            return [body for route, _callback, _method, body in requests if route == "/api/agent/ui"][-1]["profilesVisible"]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertEqual(preferences.get_width(), 420)
        rows = board_listed(preferences.section_list)
        self.assertEqual([row.get_title() for row in rows], ["Sessions", "Appearance", "Profiles", "Phone", "Machines", "Usage"])
        pages = preferences.stack.get_pages()
        self.assertEqual([row.get_title() for row in rows], [pages.get_item(n).get_title() for n in range(pages.get_n_items())])
        self.assertTrue(rows[0].get_mapped())
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        self.assertFalse(preferences.sidebar.get_visible())
        def walk(widget):
            yield widget
            child = widget.get_first_child()
            while child:
                yield from walk(child)
                child = child.get_next_sibling()
        self.assertFalse(any(isinstance(node, asb.Gtk.StackSwitcher) for node in walk(preferences)))
        self.assertEqual((preferences.title.get_title(), preferences.get_title()), ("Preferences", "Preferences"))
        self.assertFalse(preferences.back.get_visible())
        self.assert_accessible_label(preferences.back, "Back")
        self.assert_accessible_label(preferences.section_list, "Preferences sections")
        # Enter on Profiles: the page, its title, and the focus on Back.
        rows[2].grab_focus(); preferences.section_list.emit("activate-cursor-row"); self.drain(.2)
        self.assertEqual((preferences.stack.get_visible_child_name(), preferences.pages.get_visible_child_name()),
                         ("profiles", "section"))
        self.assertEqual((preferences.title.get_title(), preferences.get_title()), ("Profiles", "Preferences"))
        self.assertTrue(preferences.back.get_visible())
        self.assertIs(preferences.get_focus(), preferences.back)
        editor = preferences.profiles_editor
        self.assertTrue(editor.active)
        self.assertTrue(visible())
        preferences.back.emit("clicked"); self.drain(.2)
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        self.assertEqual(preferences.title.get_title(), "Preferences")
        self.assertFalse(preferences.back.get_visible())
        self.assertIs(preferences.get_focus(), rows[2])
        # The list covers the Profiles page, so the editor stops and the report says not visible.
        self.assertFalse(editor.active)
        self.assertFalse(visible())
        preferences.section_list.emit("row-activated", rows[2]); self.drain(.2)
        self.assertTrue(preferences.window_key(None, asb.Gdk.KEY_Escape, 0, 0)); self.drain(.2)
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        self.assertTrue(preferences.get_visible())
        self.assertIs(preferences.get_focus(), rows[2])
        preferences.show_section("phone"); self.drain(.2)
        self.assertEqual((preferences.stack.get_visible_child_name(), preferences.pages.get_visible_child_name()),
                         ("phone", "section"))
        self.assertEqual(preferences.title.get_title(), "Phone")
        self.assertTrue(preferences.back.get_visible())
        self.assertIs(preferences.get_focus(), preferences.back)
        # The Phone button of the Machines page opens the narrow Phone page the same way.
        preferences.go_back(); preferences.show_section("machines"); self.drain(.2)
        self.assertEqual(preferences.title.get_title(), "Machines")
        button = next(node for node in walk(preferences.machines_editor.off)
                      if isinstance(node, asb.Gtk.Button) and node.get_label() == "Open Phone settings")
        button.emit("clicked"); self.drain(.2)
        self.assertEqual((preferences.stack.get_visible_child_name(), preferences.pages.get_visible_child_name(),
                          preferences.title.get_title()), ("phone", "section", "Phone"))
        self.assertIs(preferences.get_focus(), preferences.back)
        # Wide: the sidebar and the current section; narrow again: the list.
        preferences.set_default_size(780, 560); self.drain(.3)
        self.assertTrue(preferences.sidebar.get_visible())
        self.assertEqual((preferences.stack.get_visible_child_name(), preferences.pages.get_visible_child_name()),
                         ("phone", "section"))
        self.assertFalse(preferences.back.get_visible())
        self.assertEqual(preferences.title.get_title(), "Preferences")
        preferences.show_section("profiles"); self.drain(.2)
        self.assertFalse(preferences.back.get_visible())
        self.assertEqual(preferences.title.get_title(), "Preferences")
        self.assertTrue(visible())
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        self.assertFalse(preferences.back.get_visible())
        # The profile dialog fills the narrow Preferences height for each provider, and has its natural height when wide.
        sources = [{"id": "claude-work", "provider": "claude-desktop-code", "label": "Claude Work", "enabled": True,
                    "builtin": False, "dataDir": "/example/profiles/claude-work", "launcher": "/example/apps/claude.desktop",
                    "projectsDir": "/example/transcripts", "color": "#b28f80", "showMarker": True, "sessionCount": 3,
                    "status": "ok"},
                   {"id": "opencode", "provider": "opencode", "label": "OpenCode", "enabled": True, "builtin": True,
                    "dataDir": "/example/profiles/opencode", "launcher": "", "color": "#899e91", "showMarker": True,
                    "sessionCount": 2, "status": "ok"}]
        preferences.show_section("profiles"); self.drain(.2)
        # The reload of the wide Profiles page is still open, so the shown section queues one more; the engine answers both.
        for _ in range(2):
            next(item for item in reversed(requests) if item[0] == "/api/sources")[1]({"sources": sources, "maxSources": 8}, None)
            self.drain(.2)
        self.assertFalse(editor.loading)
        GTK_WARNINGS.clear()
        heights = []
        for source in sources:
            editor.open_source(source); self.drain(.3)
            if hasattr(asb.Adw, "Dialog"):
                heights.append(editor.dialog.get_content_height())
            editor.cancel_form(); self.drain(.3)
        self.assertEqual(GTK_WARNINGS, [])
        preferences.set_default_size(780, 560); self.drain(.3)
        # The getter gives the measured height after -1, so the set value is read from a spy.
        with (patch.object(editor.dialog, "set_content_height", wraps=editor.dialog.set_content_height)
              if hasattr(asb.Adw, "Dialog") else contextlib.nullcontext()) as spy:
            editor.open_source(sources[0]); self.drain(.3)
        if hasattr(asb.Adw, "Dialog"):
            self.assertEqual(heights, [preferences.get_height(), preferences.get_height()])
            self.assertEqual(preferences.get_height(), 560)
            spy.assert_called_once_with(-1)
        editor.cancel_form(); self.drain(.3)
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertTrue(preferences.window_key(None, asb.Gdk.KEY_Escape, 0, 0)); self.drain(.2)
        self.assertFalse(preferences.get_visible())

    def test_preferences_machines_page_flows_dialogs_timer_and_narrow_section(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route == "/api/bridge":
                callback({"api": 1, "machines": []}, None)
            elif route != "/api/palette":
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
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

        # Narrow: the section list covers the Machines page, so its timer stops until the page shows again.
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        self.assertFalse(editor.active)
        preferences.show_section("machines"); self.drain(.1)
        reply(grouped)
        self.assertTrue(editor.active)
        self.assertEqual(preferences.title.get_title(), "Machines")

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

    def test_preferences_usage_page_loads_applies_backs_up_and_runs_file_jobs(self):
        requests = []
        def request(_base, route, callback, _dispatch, method="GET", body=None, etag=None, headers=None):
            if route == "/api/bridge":
                callback({"api": 1, "machines": []}, None)
            elif route.startswith("/api/usage/"):
                requests.append((route, callback, method, body))
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                   (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                   (asb, "request_async", request)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        default = str(Path.home() / ".config" / "asb-test" / "usage" / "backups")
        old = int(asb.datetime(2025, 3, 4, 3, 0).timestamp() * 1000)
        files = [{"name": "asb-usage-atlas-5eed0c0d-2025-03-04.json", "date": "2025-03-04", "bytes": 1234567, "modifiedAtMs": old},
                 {"name": "asb-usage-atlas-5eed0c0d-2025-03-03.json", "date": "2025-03-03", "bytes": 512, "modifiedAtMs": old - 86_400_000}]
        def status(**changes):
            return {"enabled": True, "time": "03:00", "keep": 5, "folder": "", "path": default, "defaultPath": default,
                    "nextAtMs": int(time.time() * 1000) + 10 * 86_400_000, "running": False, "files": files,
                    "lastError": {"atMs": old, "message": "Disk full."}, **changes}
        def reply(value, route="/api/usage/backup", method="GET", body=None, error=None):
            self.assertEqual(requests[-1][0::2] + (requests[-1][3],), (route, method, body))
            requests[-1][1](copy.deepcopy(value), error)
            self.drain(.05)
        def wait(done):
            end = time.monotonic() + 6
            while not done() and time.monotonic() < end:
                self.drain(.02)
            self.assertTrue(done())
        def rows(listbox):
            return [(row.get_title(), row.get_subtitle()) for row in board_listed(listbox)]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.2)
        window.open_preferences(); self.drain(.2)
        preferences = window.preferences_window
        # 1. Six sections, in the same order in the narrow list and in the stack.
        titles = ["Sessions", "Appearance", "Profiles", "Phone", "Machines", "Usage"]
        pages = preferences.stack.get_pages()
        self.assertEqual([row.get_title() for row in board_listed(preferences.section_list)], titles)
        self.assertEqual([pages.get_item(n).get_title() for n in range(pages.get_n_items())], titles)
        self.assertIsNone(preferences.usage_editor)
        self.assertEqual(requests, [])

        # 2. The first open loads the status once and fills the page.
        preferences.stack.set_visible_child_name("usage"); self.drain(.1)
        editor = preferences.usage_editor
        self.assertEqual([item[0::2] for item in requests], [("/api/usage/backup", "GET")])
        self.assertEqual(editor.message.get_label(), "Loading usage backups…")
        self.assertFalse(editor.settings.get_sensitive() or editor.apply.get_sensitive() or editor.backup_now.get_sensitive())
        reply(status())
        self.assertEqual(len(requests), 1)
        self.assertTrue(editor.enabled.get_active())
        self.assertEqual((editor.hour.get_text(), editor.minute.get_text(), int(editor.keep.get_value())), ("03", "00", 5))
        self.assertEqual(editor.folder_row.get_subtitle(), "~/.config/asb-test/usage/backups")
        self.assertEqual(editor.folder_row.get_tooltip_text(), default)
        self.assertFalse(editor.default_row.get_visible())
        self.assertEqual(rows(editor.files), [(files[0]["name"], f"{asb.backup_when(old, time.time() * 1000)} · 1.2 MB"),
                                              (files[1]["name"], f"{asb.backup_when(old - 86_400_000, time.time() * 1000)} · 512 bytes")])
        self.assertTrue(editor.files.get_visible())
        self.assertFalse(editor.files_empty.get_visible())
        self.assertEqual(editor.next_label.get_label(), asb.backup_next_text(status(), time.time() * 1000))
        self.assertTrue(editor.next_label.get_label().startswith("Next backup: 20"))
        self.assertEqual((editor.error_label.get_label(), editor.error_label.get_visible()), ("Last backup failed: Disk full.", True))
        self.assertEqual(editor.message.get_label(), "")
        self.assertTrue(editor.settings.get_sensitive() and editor.apply.get_sensitive() and editor.backup_now.get_sensitive())
        # The widget order, titles, and accessible labels.
        order = []
        child = editor.get_first_child()
        while child:
            order.append(child)
            child = child.get_next_sibling()
        self.assertEqual(order[0], editor.settings)
        self.assertEqual([order[1].get_first_child(), order[1].get_last_child()], [editor.apply, editor.retry])
        self.assertEqual(order[2:4], [editor.message, order[3]])
        self.assertEqual(order[3].get_label(), "Backups")
        self.assertEqual(order[4:8], [editor.next_label, editor.error_label, editor.files, editor.files_empty])
        self.assertEqual(board_children(order[8]), [editor.backup_now, editor.export_button, editor.import_button])
        self.assertEqual([button.get_label() for button in board_children(order[8])], ["Back up now", "Export…", "Import…"])
        self.assertTrue(order[9].get_label().startswith("Each file holds the usage of every machine in the group."))
        self.assertEqual(len(order), 10)
        self.assertEqual(board_listed(editor.settings), [editor.enabled, editor.time_row, editor.keep, editor.folder_row, editor.default_row])
        self.assertEqual([row.get_title() for row in board_listed(editor.settings)], ["Daily backup", "Time", "Files to keep", "Folder", "Default folder"])
        self.assert_accessible_label(editor.hour, "Backup hour")
        self.assert_accessible_label(editor.minute, "Backup minute")
        self.assert_accessible_label(editor.open_folder, "Open the backup folder")
        self.assert_accessible_label(editor.use_default, "Use the default folder")
        self.assertEqual(editor.change_folder.get_label(), "Change…")

        # 3. Apply sends the edited form; the reply fills it again.
        editor.enabled.set_active(False)
        editor.hour.set_value(4)
        editor.minute.set_value(30)
        editor.keep.set_value(3)
        editor.apply.emit("clicked")
        self.assertEqual(editor.message.get_label(), "Saving…")
        self.assertFalse(editor.apply.get_sensitive() or editor.settings.get_sensitive() or editor.import_button.get_sensitive())
        reply(status(enabled=False, time="04:30", keep=3, nextAtMs=None), "/api/usage/backup/settings", "POST",
              {"enabled": False, "time": "04:30", "keep": 3, "folder": ""})
        self.assertEqual(editor.message.get_label(), "Saved.")
        self.assertEqual(editor.next_label.get_label(), "Daily backup is off.")
        self.assertEqual((editor.hour.get_text(), editor.minute.get_text()), ("04", "30"))

        # 4. A custom folder shows the default folder row; Use goes back to the default folder.
        preferences.stack.set_visible_child_name("sessions"); self.drain(.05)
        preferences.stack.set_visible_child_name("usage"); self.drain(.05)
        reply(status(folder="/srv/asb-test/backups", path="/srv/asb-test/backups", lastError=None, files=[]))
        self.assertEqual(editor.folder_row.get_subtitle(), "/srv/asb-test/backups")
        self.assertTrue(editor.default_row.get_visible())
        self.assertEqual(editor.default_row.get_subtitle(), "~/.config/asb-test/usage/backups")
        self.assertFalse(editor.error_label.get_visible())
        self.assertEqual((editor.files.get_visible(), editor.files_empty.get_visible()), (False, True))
        self.assertEqual(editor.files_empty.get_label(), "No backups yet.")
        editor.use_default.emit("clicked")
        self.assertFalse(editor.default_row.get_visible())
        self.assertEqual(editor.folder_row.get_subtitle(), "~/.config/asb-test/usage/backups")
        editor.apply.emit("clicked")
        reply(status(), "/api/usage/backup/settings", "POST", {"enabled": True, "time": "03:00", "keep": 5, "folder": ""})

        # 5. Back up now keeps an unsaved edit and shows the new file.
        editor.keep.set_value(7)
        editor.backup_now.emit("clicked")
        self.assertEqual(editor.message.get_label(), "Backing up…")
        made = {"name": "asb-usage-atlas-5eed0c0d-2026-10-27.json", "path": default + "/x.json", "machines": 3, "hours": 3071}
        reply({**status(files=files[:1], lastError=None), "made": made}, "/api/usage/backup/now", "POST", {})
        self.assertEqual(editor.message.get_label(), "Saved the usage of 3 machines (3,071 hours) to asb-usage-atlas-5eed0c0d-2026-10-27.json.")
        self.assertEqual(int(editor.keep.get_value()), 7)
        self.assertEqual(len(board_listed(editor.files)), 1)
        self.assertFalse(editor.error_label.get_visible())

        # 6. Errors, a failed first load with Retry, and a late reply after the page hides.
        editor.apply.emit("clicked")
        reply(None, "/api/usage/backup/settings", "POST", {"enabled": True, "time": "03:00", "keep": 7, "folder": ""},
              error="This folder does not exist.")
        self.assertEqual(editor.message.get_label(), "This folder does not exist.")
        self.assertEqual(int(editor.keep.get_value()), 7)
        self.assertFalse(editor.retry.get_visible())
        editor.backup_now.emit("clicked")
        reply(status(), "/api/usage/backup/now", "POST", {})
        self.assertEqual(editor.message.get_label(), "The usage backup response is not valid. Try again.")
        preferences.stack.set_visible_child_name("sessions"); self.drain(.05)
        preferences.stack.set_visible_child_name("usage"); self.drain(.05)
        reply(None, error="Cannot load or change usage backups. Check that ASB is running, then try again.")
        self.assertTrue(editor.retry.get_visible() and editor.retry.get_sensitive())
        self.assertFalse(editor.settings.get_sensitive())
        editor.retry.emit("clicked")
        self.assertFalse(editor.retry.get_visible())
        late = requests[-1][1]
        preferences.stack.set_visible_child_name("sessions"); self.drain(.05)
        self.assertFalse(editor.active)
        late(status(keep=9), None)
        self.assertNotEqual(int(editor.keep.get_value()), 9)
        self.assertEqual(editor.message.get_label(), "Loading usage backups…")
        count = len(requests)
        editor.backup_now.emit("clicked")
        self.assertEqual(len(requests), count)

        # 8. Folder, Open, Export, and Import with patched dialogs and file jobs.
        preferences.stack.set_visible_child_name("usage"); self.drain(.05)
        reply(status())
        with tempfile.TemporaryDirectory(prefix="asb-usage-board-") as temporary:
            chosen, launched, jobs = [], [], []
            def finish_with(value):
                def finish(_dialog, _result):
                    if isinstance(value, Exception):
                        raise value
                    return value
                return finish
            def start(dialog, parent, cancellable, callback):
                chosen.append((dialog.get_title(), parent, cancellable))
                callback(dialog, None)
            dismissed = asb.GLib.Error.new_literal(asb.Gtk.dialog_error_quark(), "Dismissed by user", int(asb.Gtk.DialogError.DISMISSED))
            folder = asb.Gio.File.new_for_path(temporary)
            with patch.object(asb.Gtk.FileDialog, "select_folder", start), \
                    patch.object(asb.Gtk.FileDialog, "select_folder_finish", finish_with(folder)):
                editor.change_folder.emit("clicked")
            self.assertEqual(chosen[-1][:2], ("Choose the backup folder", preferences))
            self.assertTrue(editor.default_row.get_visible())
            self.assertEqual(editor.folder_row.get_subtitle(), asb.short_home_path(temporary, Path.home()))
            with patch.object(asb.Gtk.FileDialog, "select_folder", start), \
                    patch.object(asb.Gtk.FileDialog, "select_folder_finish", finish_with(asb.Gio.File.new_for_uri("https://example.invalid/b"))):
                editor.change_folder.emit("clicked")
            self.assertEqual(editor.message.get_label(), "Choose a local folder.")
            editor.message.set_label("")
            with patch.object(asb.Gtk.FileDialog, "select_folder", start), \
                    patch.object(asb.Gtk.FileDialog, "select_folder_finish", finish_with(dismissed)):
                editor.change_folder.emit("clicked")
            self.assertEqual(editor.message.get_label(), "")
            self.assertFalse(editor.loading)
            def launch(launcher, parent, cancellable, callback):
                launched.append((launcher.get_file().get_path(), parent))
                callback(launcher, None)
            failure = asb.GLib.Error.new_literal(asb.Gio.io_error_quark(), "No handler", int(asb.Gio.IOErrorEnum.NOT_SUPPORTED))
            with patch.object(asb.Gtk.FileLauncher, "launch", launch), \
                    patch.object(asb.Gtk.FileLauncher, "launch_finish", finish_with(failure)):
                editor.open_folder.emit("clicked")
            self.assertEqual(launched, [(temporary, preferences)])
            self.assertEqual(editor.message.get_label(), "Cannot open the folder.")
            editor.use_default.emit("clicked")
            with patch.object(asb.Gtk.FileLauncher, "launch", launch), \
                    patch.object(asb.Gtk.FileLauncher, "launch_finish", finish_with(True)):
                editor.open_folder.emit("clicked")
            self.assertEqual(launched[-1], (default, preferences))
            target = str(Path(temporary) / "asb-usage-2026-10-27.json")
            names = []
            def save(dialog, parent, cancellable, callback):
                names.append(dialog.get_initial_name())
                start(dialog, parent, cancellable, callback)
            def export(base, path):
                jobs.append(("export", base, path, threading.current_thread() is threading.main_thread()))
                return "Saved the usage of 2 machines (4 hours) to asb-usage-2026-10-27.json."
            with patch.object(asb.Gtk.FileDialog, "save", save), \
                    patch.object(asb.Gtk.FileDialog, "save_finish", finish_with(asb.Gio.File.new_for_path(target))), \
                    patch.object(asb, "export_usage_file", export):
                editor.export_button.emit("clicked")
                # The result comes back with GLib.idle_add, so the message shows until the main loop runs.
                self.assertEqual((editor.message.get_label(), editor.loading), ("Exporting…", True))
                wait(lambda: not editor.loading)
            self.assertEqual(chosen[-1][0], "Export usage")
            self.assertEqual(names, [asb.usage_export_name(time.time() * 1000)])
            self.assertEqual(jobs, [("export", "http://127.0.0.1:1", target, False)])
            self.assertEqual(editor.message.get_label(), "Saved the usage of 2 machines (4 hours) to asb-usage-2026-10-27.json.")
            filters = []
            def open_file(dialog, parent, cancellable, callback):
                listed = dialog.get_filters()
                filters.append(([listed.get_item(n).get_name() for n in range(listed.get_n_items())], dialog.get_default_filter().get_name()))
                start(dialog, parent, cancellable, callback)
            def import_file(base, path):
                jobs.append(("import", base, path))
                if len(jobs) > 2:
                    raise RuntimeError("This file is not an ASB usage export.")
                return "Imported the usage of 1 machine: homeLP (1,497 hours)."
            with patch.object(asb.Gtk.FileDialog, "open", open_file), \
                    patch.object(asb.Gtk.FileDialog, "open_finish", finish_with(asb.Gio.File.new_for_path(target))), \
                    patch.object(asb, "import_usage_file", import_file):
                editor.import_button.emit("clicked")
                wait(lambda: not editor.loading)
                self.assertEqual(editor.message.get_label(), "Imported the usage of 1 machine: homeLP (1,497 hours).")
                editor.import_button.emit("clicked")
                wait(lambda: not editor.loading)
                self.assertEqual(editor.message.get_label(), "This file is not an ASB usage export.")
            self.assertEqual(chosen[-1][0], "Import usage")
            self.assertEqual(filters[0], (["ASB usage files", "All files"], "ASB usage files"))
            self.assertEqual(jobs[1:], [("import", "http://127.0.0.1:1", target), ("import", "http://127.0.0.1:1", target)])
            # A file job of a hidden page is dropped, and the dialog of a hidden page is cancelled.
            release = threading.Event()
            def slow(_base, _path):
                release.wait(5)
                return "late"
            with patch.object(asb.Gtk.FileDialog, "open", open_file), \
                    patch.object(asb.Gtk.FileDialog, "open_finish", finish_with(asb.Gio.File.new_for_path(target))), \
                    patch.object(asb, "import_usage_file", slow):
                editor.import_button.emit("clicked")
                self.assertEqual(editor.message.get_label(), "Importing…")
                self.assertTrue(editor.loading and not editor.export_button.get_sensitive())
                preferences.stack.set_visible_child_name("sessions"); self.drain(.05)
                release.set()
                self.drain(.2)
            self.assertEqual(editor.message.get_label(), "Importing…")
            preferences.stack.set_visible_child_name("usage"); self.drain(.05)
            reply(status())
            pending = []
            with patch.object(asb.Gtk.FileDialog, "save", lambda dialog, parent, cancellable, callback: pending.append(cancellable)):
                editor.export_button.emit("clicked")
            self.assertTrue(editor.loading)
            preferences.stack.set_visible_child_name("sessions"); self.drain(.05)
            self.assertTrue(pending[0].is_cancelled())
            self.assertFalse(editor.loading)

        # 7. The narrow page opens from the section list without GTK warnings.
        GTK_WARNINGS.clear()
        preferences.set_default_size(420, 560); self.drain(.3)
        self.assertEqual(preferences.pages.get_visible_child_name(), "list")
        row = board_listed(preferences.section_list)[5]
        preferences.section_list.emit("row-activated", row); self.drain(.2)
        self.assertEqual((preferences.stack.get_visible_child_name(), preferences.title.get_title()), ("usage", "Usage"))
        reply(status())
        self.drain(.2)
        self.assertTrue(editor.active and editor.get_mapped())
        self.assertEqual(preferences.get_width(), 420)
        # The page margins are 20 px on each side.
        self.assertLessEqual(editor.measure(asb.Gtk.Orientation.HORIZONTAL, -1)[0], 420 - 40)
        self.assertEqual(GTK_WARNINGS, [])
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            self.capture(preferences, Path(output) / "native-preferences-usage-narrow.png")
        preferences.close(); self.drain(.1)
        self.assertFalse(editor.active)
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
                self.fill_board(window); self.drain()
                self.assertEqual(len(window.focus_widgets), 106,
                                 (window.search.get_text(), window.states, window.pending))
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
                alert = window.focus_widgets["sample-4"]
                original_alert_row = dict(alert.asb_thread)
                window.update_session_row(alert, {**original_alert_row, "lastOutcome": "failed", "unread": True, "alert": True})
                self.assertEqual(alert.asb_state_label.get_text(), "Stopped")
                self.assertTrue(alert.asb_dot.has_css_class("asb-alert"))
                self.assertFalse(alert.asb_dot.has_css_class("asb-question"))
                self.assertTrue(alert.asb_dot.get_first_child().get_visible())
                self.assertEqual(alert.asb_dot.get_first_child().get_text(), "!")
                window.update_session_row(alert, {**original_alert_row, "lastOutcome": "failed", "unread": False, "alert": False})
                self.assertEqual(alert.asb_state_label.get_text(), "Stopped")
                self.assertFalse(alert.asb_dot.get_first_child().get_visible())
                self.assertFalse(alert.asb_dot.has_css_class("asb-alert"))
                window.update_session_row(alert, original_alert_row)
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
                self.assertGreaterEqual(window.columns, 1)
                self.assertEqual(window.focus_key(), focus)
                self.assert_focus_visible(window, focus)
                window.set_default_size(width, 800)
                window.set_pending(True)
                self.drain()
                self.assertEqual(set(window.focus_widgets), {row["id"] for row in dashboard["threads"] if row.get("pending")})
                if width == 680:
                    self.capture(window, directory / "native-pending-only.png")
                window.set_pending(False)
                window.states = {"waiting"}
                window.render(); self.drain()
                self.assertEqual(len(window.focus_widgets), 4)
                self.assertFalse(hasattr(window, "count"))
                window.states = set()
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
            # While an action runs, every control stays sensitive and keeps the focus and its label, but is busy and does nothing.
            read, signature = panel.asb_actions["read"], panel.asb_signature
            read.grab_focus()
            window.session_actions.add("second")
            row.asb_thread.update(unread=False, pending=False, pendingSource="")
            window.sync_row_panel()
            controls = (panel.asb_open, panel.asb_copy, panel.asb_copy_full,
                        *(button for button in panel.asb_actions.values() if button.get_visible()))
            for control in controls:
                self.assertTrue(control.get_sensitive())
                self.assertTrue(control.has_css_class("asb-action-pending"))
                self.assert_accessible_busy(control, True)
                self.assert_accessible_disabled(control, True)
            self.assertEqual(actions(panel)["read"], ("Mark read", True))
            self.assertIn("drawer", actions(panel))
            self.assertIs(window.get_focus(), read)
            with patch.object(window, "session_action") as action, patch.object(window, "open_row") as open_row:
                for control in controls:
                    control.emit("clicked")
                action.assert_not_called()
                open_row.assert_not_called()
            self.assertIs(window.context_menu, panel)
            self.assertIsNone(panel.asb_copied)
            window.session_actions.discard("second")
            window.sync_row_panel()
            self.drain()
            self.assertIs(panel.asb_actions["read"], read)
            self.assertEqual((read.asb_label.get_label(), read.asb_icon.get_icon_name()), ("Mark unread", "mail-unread-symbolic"))
            self.assert_accessible_label(read, "Mark unread")
            self.assertNotIn("drawer", actions(panel))
            self.assertIs(window.get_focus(), read)
            self.assertNotEqual(panel.asb_signature, signature)
            self.assertFalse(any(control.has_css_class("asb-action-pending") for control in controls))
            self.assert_accessible_busy(read, False)
            self.assert_accessible_disabled(read, False)
            self.assert_accessible_busy(panel.asb_copy_full, False)
            self.assert_accessible_disabled(panel.asb_copy_full, panel.asb_copy_values[2] is None)
            row.asb_thread.update(unread=True, pending=True, pendingSource="observed-completion")
            window.sync_row_panel()
            self.drain()  # Tab order follows the allocation of the shown drawer row.
            # Down and Up move through the controls in Tab order and wrap at the ends.
            keys = [controller for controller in panel.observe_controllers() if isinstance(controller, asb.Gtk.EventControllerKey)]
            capture = next(controller for controller in keys if controller.get_propagation_phase() == asb.Gtk.PropagationPhase.CAPTURE)
            panel.asb_open.grab_focus()
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_messages)
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Down, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_actions["read"])
            self.assertTrue(capture.emit("key-pressed", asb.Gdk.KEY_Up, 0, 0))
            self.assertIs(window.get_focus(), panel.asb_messages)
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
            # An unread required action offers Read and keeps its note.
            self.assertEqual(actions(panel), {"read": ("Mark read", True), "mute": ("Mute", True), "pin": ("Pin", True)})
            self.assertTrue(panel.asb_note.get_visible())
            self.assertEqual(panel.asb_note.get_label(), "Waits for your permission.")
            # The note comes after Open, Show messages, and their separator.
            self.assertIs(panel.asb_note.get_prev_sibling().get_prev_sibling(), panel.asb_messages)
            self.assertIs(panel.asb_messages.get_prev_sibling(), panel.asb_open)
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

    def test_a_card_that_leaves_the_board_drops_its_row_panel_first(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *_args, **_kwargs: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for closing in (False, True):
            with self.subTest(closing=closing):
                GTK_WARNINGS.clear()
                window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                              theme_path=False, layout_path=False)
                self.addCleanup(window.close)
                window.present(); self.drain()
                window.show_context(window.focus_widgets["second"]); self.drain()
                panel = window.context_menu
                dashboard = copy.deepcopy(FIXTURE)
                dashboard["threads"] = [row for row in dashboard["threads"] if row["id"] != "second"]
                if closing:
                    panel.popdown()
                window.apply_dashboard(dashboard, None)
                self.drain()
                self.assertEqual(GTK_WARNINGS, [])
                self.assertNotIn("second", window.row_cache)
                self.assertIsNone(window.context_menu)
                self.assertIsNone(panel.get_parent())
                focus = window.get_focus()
                self.assertTrue(focus is None or focus.get_root() is window)
                window.close(); self.drain()

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real keys need xdotool and DISPLAY=:9 or :10.")
    def test_open_keeps_card_focus_during_and_after_the_request(self):
        from gi.repository import GdkX11

        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.present(); self.drain(.3)
        subprocess.run(["xdotool", "windowfocus", str(GdkX11.X11Surface.get_xid(window.get_surface()))], check=True)
        self.drain(.1)
        identity = window.row_order[0]
        card = window.focus_widgets[identity]
        self.assertTrue(card.asb_thread["canOpen"])
        following = window.focus_widgets[window.row_order[1]]
        for error in (None, "The sample app could not open the session."):
            with self.subTest(error=error):
                card.grab_focus(); self.drain(.1)
                requests.clear()
                subprocess.run(["xdotool", "key", "Return"], check=True); self.drain(.1)
                self.assertIn(identity, window.opening)
                self.assertIs(window.get_focus(), card)
                self.assertEqual(card.asb_title_label.get_label(), "Opening…")
                self.assert_accessible_busy(card, True)
                self.assert_accessible_label(card, "Opening " + card.asb_accessible_label.removeprefix("Open "))
                # Card activation and the number shortcut share the same pending-open guard.
                window.open_row(None, card)
                window.update_number_keys()
                self.assertIn(identity, window.number_keys)
                window.open_number(window.number_keys.index(identity) + 1)
                opens = [request for request in requests if request[1].endswith("/open")]
                self.assertEqual(len(opens), 1)
                window.restore_position(identity, 0)
                self.assertIs(window.get_focus(), card)
                opens[0][2](None if error else {"opened": True}, error); self.drain(.1)
                self.assertIs(window.get_focus(), card)
                self.assertNotIn(identity, window.opening)
                self.assert_accessible_busy(card, False)
                self.assertEqual(card.asb_title_label.get_label(), card.asb_thread["title"])
                subprocess.run(["xdotool", "key", "Down"], check=True); self.drain(.1)
                self.assertIs(window.get_focus(), following)

    def test_row_panel_open_follows_the_open_request_start_and_end(self):
        callbacks = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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

    def test_pointer_row_panel_motion_has_a_24px_margin_and_keyboard_has_no_motion_rule(self):
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *_args: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(900, 800)
        window.present(); self.drain(.3)
        card = window.focus_widgets[window.row_order[0]]
        for pointer in (True, False):
            with self.subTest(pointer=pointer):
                window.show_context(card, gesture=Mock() if pointer else None); self.drain(.2)
                panel = window.context_menu
                self.assertTrue(panel.get_mapped())
                controllers = panel.observe_controllers()
                motions = [controller for controller in controllers if isinstance(controller, asb.Gtk.EventControllerMotion)]
                self.assertEqual(len(motions), int(pointer))
                found, bounds = panel.get_child().get_parent().compute_bounds(panel)
                self.assertTrue(found)
                x, y, width, height = bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height
                if pointer:
                    motion = motions[0]
                    for px, py in ((x + width / 2, y - 10), (x - 24, y), (x + width + 24, y),
                                   (x, y - 24), (x, y + height + 24), (x + width / 2, y + height / 2)):
                        motion.emit("motion", px, py); self.drain(.03)
                        self.assertTrue(panel.get_visible())
                    motion.emit("motion", x + width / 2, y - 30); self.drain(.2)
                    self.assertFalse(panel.get_visible())
                    self.assertIsNone(window.context_menu)
                else:
                    # Keyboard panels have no distance handler on their popover; outside motion cannot close them.
                    motion = asb.Gtk.EventControllerMotion()
                    panel.add_controller(motion)
                    motion.emit("motion", x - 100, y - 100); self.drain(.1)
                    self.assertTrue(panel.get_visible())
                    panel.popdown(); self.drain(.2)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and DISPLAY=:9 or :10.")
    def test_a_held_right_click_row_panel_closes_when_the_pointer_moves_away(self):
        from gi.repository import GdkX11

        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *_args: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout
        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(900, 800)
        window.present(); self.drain(.3)
        card = window.focus_widgets[window.row_order[0]]
        found, bounds = card.asb_title_label.compute_bounds(window)
        self.assertTrue(found)
        left, top = window.get_surface_transform()
        xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(window.get_surface()),
            int(bounds.origin.x + bounds.size.width / 2 + left), int(bounds.origin.y + bounds.size.height / 2 + top))
        self.drain(.1)
        xdo("mousedown", 3); self.drain(.25)
        xdo("mouseup", 3); self.drain(.2)
        panel = window.context_menu
        self.assertTrue(panel is not None and panel.get_mapped())
        xdo("mousemove_relative", "--", -40, -60); self.drain(.3)
        self.assertFalse(panel.get_visible())
        self.assertIsNone(window.context_menu)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_a_held_right_click_opens_a_row_panel_that_takes_the_next_click(self):
        # A hand holds the button for a moment. A panel that opened under the held button lost the next click to GDK.
        from gi.repository import GdkX11

        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args, **_kwargs: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout

        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        # A short window moves the panel up, so the panel opens with the pointer well inside it.
        window.set_default_size(900, 300)
        window.present(); self.drain(.3)

        def move_to(widget, root, x=None):
            found, bounds = widget.compute_bounds(root)
            self.assertTrue(found)
            left, top = root.get_surface_transform()
            xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(root.get_surface()),
                int(bounds.origin.x + (bounds.size.width / 2 if x is None else x) + left),
                int(bounds.origin.y + bounds.size.height / 2 + top))
            self.drain()

        identity, card = max(((identity, widget) for identity, widget in window.focus_widgets.items()
                              if identity != asb.MORE_ID and widget.get_mapped()),
                             key=lambda item: item[1].compute_bounds(window)[1].origin.y)
        move_to(card, window)
        xdo("mousedown", 3); self.drain(.25)
        xdo("mouseup", 3); self.drain(.3)
        panel = window.context_menu
        self.assertTrue(panel is not None and panel.get_mapped())
        move_to(panel.asb_actions["mute"], panel, 40)
        xdo("click", 1); self.drain(.3)
        self.assertEqual([request[1] for request in requests if request[1].startswith("/api/threads/")],
                         ["/api/threads/" + asb.quote(identity, safe="") + "/mute"])
        self.assertIsNone(window.context_menu)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_a_pointer_click_on_a_row_panel_action_keeps_the_panel_open(self):
        # A panel row that turned insensitive under the pointer made GTK pick a new pointer target in the board:
        # the panel got a leave and closed, and a click without a pointer move went to the board under it.
        from gi.repository import GdkX11

        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args, **_kwargs: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout

        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", copy.deepcopy(FIXTURE),
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(900, 700)
        window.present(); self.drain(.3)

        def move_to(widget, root, x=None):
            found, bounds = widget.compute_bounds(root)
            self.assertTrue(found)
            left, top = root.get_surface_transform()
            xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(root.get_surface()),
                int(bounds.origin.x + (bounds.size.width / 2 if x is None else x) + left),
                int(bounds.origin.y + bounds.size.height / 2 + top))
            self.drain()

        # The first card: a pin keeps it in its place, so its panel stays under the pointer.
        identity = window.row_order[0]
        move_to(window.focus_widgets[identity], window)
        xdo("click", 3); self.drain(.3)
        panel = window.context_menu
        self.assertTrue(panel is not None and panel.get_mapped())
        pin = panel.asb_actions["pin"]
        self.assertEqual(pin.asb_label.get_label(), "Pin")
        move_to(pin, panel, 40)
        xdo("click", 1); self.drain(.3)
        routes = lambda: [request[1] for request in requests if request[1].startswith("/api/threads/")]
        self.assertEqual(routes(), ["/api/threads/" + asb.quote(identity, safe="") + "/pin"])
        # While the request runs, the panel stays open and its rows are busy.
        self.assertIs(window.context_menu, panel)
        self.assertTrue(panel.get_mapped())
        self.assertTrue(pin.get_sensitive() and pin.has_css_class("asb-action-pending"))
        requests[-1][2]({"changed": True, "pinnedOrder": [identity]}, None); self.drain(.3)
        self.assertIs(window.context_menu, panel)
        self.assertEqual(pin.asb_label.get_label(), "Unpin")
        self.assertFalse(pin.has_css_class("asb-action-pending"))
        # A second click without a pointer move goes to the same row, not to the board under the panel.
        xdo("click", 1); self.drain(.3)
        self.assertEqual(routes(), ["/api/threads/" + asb.quote(identity, safe="") + "/pin",
                                    "/api/threads/" + asb.quote(identity, safe="") + "/unpin"])
        self.assertIs(window.context_menu, panel)
        self.assertTrue(panel.get_mapped())

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_copy_tag_hides_when_the_pointer_leaves_the_button(self):
        # GTK emits leave before contains-pointer turns false, so leave must not read contains_pointer.
        from gi.repository import GdkX11

        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args, **_kwargs: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout

        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        xdo("mousemove", 1500, 950)
        app_id = "123e4567-e89b-12d3-a456-426614174000"
        now = time.time() * 1000

        def row(identity, order):
            return {"id": identity, "provider": "codex", "providerLabel": "Codex",
                    "title": "Summarize the open issues " + identity,
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle",
                    "canOpen": True, "externalId": app_id, "sessionReference": "codex/" + app_id,
                    "reference": "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:" + app_id,
                    "updatedAtMs": now - order * 1000}

        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1",
                                       {"generatedAtMs": now, "providers": [], "threads": [row("one", 1), row("two", 2)]},
                                       theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        clipboard = SimpleNamespace(texts=[])
        clipboard.set = clipboard.texts.append
        window.get_clipboard = lambda: clipboard
        window.set_default_size(680, 420)
        window.present(); window.set_focus(None); self.drain(.4)
        window.view_filter.set_selected(1); self.drain(.5); window.check_geometry(); self.drain()
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
        one = window.focus_widgets["one"].asb_copy_button
        two = window.focus_widgets["two"].asb_copy_button

        def move_to(widget, root):
            found, bounds = widget.compute_bounds(root)
            self.assertTrue(found)
            left, top = root.get_surface_transform()
            xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(root.get_surface()),
                int(bounds.origin.x + bounds.size.width / 2 + left),
                int(bounds.origin.y + bounds.size.height / 2 + top))
            self.drain()

        # Rest on a copy button shows its tag; a leave that hides the tag is what the user sees.
        move_to(one, window); self.drain(.35)
        self.assertTrue(one.asb_tag_shown)
        move_to(window.search, window); self.drain(.35)
        self.assertFalse(one.asb_tag_shown)
        # A click copies and keeps the tag; the wheel after a copy still switches the kind.
        move_to(one, window); self.drain(.35)
        self.assertTrue(one.asb_tag_shown)
        xdo("click", 1); self.drain(.1)
        self.assertTrue(one.asb_tag_shown)
        self.assertEqual(window.focus_widgets["one"].asb_footer_stack.get_visible_child_name(), "copied")
        before = window.copy_kind
        scroll_before = window.scroll.get_hadjustment().get_value()
        xdo("click", 4); self.drain(.1)
        self.assertNotEqual(window.copy_kind, before)
        self.assertEqual(window.scroll.get_hadjustment().get_value(), scroll_before)
        # A direct move from one copy button to another leaves exactly one tag.
        move_to(one, window); self.drain(.35)
        self.assertTrue(one.asb_tag_shown)
        move_to(two, window); self.drain(.35)
        self.assertFalse(one.asb_tag_shown)
        self.assertTrue(two.asb_tag_shown)

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and a nested test display (DISPLAY=:9 or :10).")
    def test_a_card_glide_keeps_the_wheel_on_the_copy_button_under_a_still_pointer(self):
        # GTK sends no enter to a copy button that stays under a still pointer, so a glide must not take its wheel.
        from gi.repository import GdkX11

        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args, **_kwargs: None)):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout

        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        xdo("mousemove", 1500, 950)
        app_id = "123e4567-e89b-12d3-a456-426614174000"

        def board(order):
            # Idle rows sort newest first, so the board shows the cards in this order.
            return {"generatedAtMs": NOW, "providers": [], "threads": [
                {"id": identity, "provider": "codex", "providerLabel": "Codex", "title": "Summarize the open issues " + identity,
                 "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                 "externalId": app_id, "sessionReference": "codex/" + app_id,
                 "reference": "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:" + app_id,
                 "updatedAtMs": NOW - place * 60_000} for place, identity in enumerate(order)]}

        order = [f"s{n}" for n in range(16)]
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", board(order), theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(680, 420)
        window.present(); window.set_focus(None); self.drain(.4)
        window.view_filter.set_selected(1); self.drain(.5); window.check_geometry(); self.drain()
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
        strip, adjustment = window.list_body, window.scroll.get_hadjustment()
        self.assertGreater(adjustment.get_upper() - adjustment.get_page_size(), adjustment.get_value())  # The wheel can scroll the board.
        button = window.focus_widgets["s1"].asb_copy_button

        def glide(new_order):
            frames = []
            handler = window.get_frame_clock().connect("after-paint", lambda *_args: frames.append(bool(strip.motion)))
            window.apply_dashboard(board(new_order), None)
            end = time.monotonic() + 6
            while not (any(frames) and not strip.motion and window.motion_from is None) and time.monotonic() < end:
                self.drain(.02)
            window.get_frame_clock().disconnect(handler)
            self.assertTrue(any(frames))  # The cards glided.
            self.assertEqual((strip.motion, window.row_order), ({}, new_order))
            self.drain()

        # The pointer rests on the copy button of s1 until its tag shows.
        found, bounds = button.compute_bounds(window)
        self.assertTrue(found)
        left, top = window.get_surface_transform()
        xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(window.get_surface()),
            int(bounds.origin.x + bounds.size.width / 2 + left), int(bounds.origin.y + bounds.size.height / 2 + top))
        self.drain(asb.COPY_REST_S + .3)
        self.assertTrue(button.asb_tag_shown)
        self.assertIs(window.copy_hover, button)
        # (a) Two cards below s1 change places. s1 stays under the pointer, so its copy button keeps the tag and the wheel.
        order[3], order[4] = order[4], order[3]
        glide(order)
        self.assertIs(window.copy_hover, button)
        self.assertTrue(button.asb_tag_shown)
        kind, position = window.copy_kind, adjustment.get_value()
        xdo("click", 5); self.drain(.5)
        self.assertNotEqual(window.copy_kind, kind)
        self.assertEqual(adjustment.get_value(), position)
        # (b) s0 goes to the end, so s1 glides up from under the still pointer: its tag hides and it loses the wheel.
        glide(order[1:] + order[:1])
        self.assertFalse(button.asb_tag_shown)
        self.assertIsNot(window.copy_hover, button)

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
            self.assertLessEqual(window.window_handle.get_height(), window.menu_button.get_height() + 4)
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
            self.assertEqual(len(window.row_columns), 106)
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
            self.assertEqual(asb.read_layout(window.layout_path), {"columnWidth": 240, "view": "compact", "cardLimit": 0, "copyKind": "relative"})

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
            window.search.set_text("cl:")
            window.render()
            self.assertTrue(window.visible_rows())
            self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
            # Escape in the inline entry resets the view at this width too.
            self.assertTrue(window.search_row.get_reveal_child())
            window.search.emit("stop-search")
            self.assertEqual(window.search.get_text(), "")
            window.set_pending(True)
            window.states = {"idle"}
            window.set_archived(True)
            window.search.set_text("cx: build")
            window.window_key(None, asb.Gdk.KEY_Escape, 0, 0)
            self.assertFalse(window.pending)
            self.assertEqual(window.states, set())
            self.assertFalse(window.archived)
            window.filters_pill.grab_focus()
            self.assertFalse(window.window_key(None, asb.Gdk.KEY_space, 0, 0))
            self.assertFalse(window.window_key(None, asb.Gdk.KEY_Return, 0, 0))
            window.search.set_text("cx:")
            window.open_preferences()
            self.assertTrue(window.preferences_window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
            self.assertEqual(window.search.get_text(), "cx:")
            window.clear_search()
            window.clear_filters()
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
                               pending=not working or bool(row.get("questionAttention") or row.get("actionAttention")),
                               pendingSource="user-action" if row.get("actionAttention") else "user-question" if row.get("questionAttention")
                               else "" if working else "manual-unread")
                    result = {"marked": True, "thread": row}
                elif action == "mark-read":
                    row.update(manualUnread=False, retainedUnread=False, retainedUnreadSource="", nativeAttention=False,
                               completionAttention=False, failedAttention=False, questionAttention=False, actionAttention=False,
                               unread=False, pending=False, pendingSource="")
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
            # The real request runs: every control stays sensitive, keeps its label, and is busy.
            self.assertTrue(all(control.get_sensitive() and control.has_css_class("asb-action-pending") for control in (button, popup.asb_open, popup.asb_copy)))
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
            self.assertFalse(button.has_css_class("asb-action-pending"))
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
        window.states = {"working", "idle"}
        self.assertEqual(window.states, {"working", "idle"})
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            window.open_preferences()
            window.preferences_window.stack.set_visible_child_name("sessions")
            self.drain(.2)
            self.capture(window.preferences_window, Path(output) / "native-multi-state.png")
            window.preferences_window.close()
        window.states = set()
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
        self.assertEqual(len(window.row_columns), 106)
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
                self.assertIsInstance(window.filters_pill, asb.Gtk.Button)
                self.fill_board(window); self.drain()
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
                    self.fill_board(window); self.drain()
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
                        # R1: the footer is a stack of the line and the copied page; the line keeps clock, state, right.
                        footer = window.focus_widgets["sample-15"].get_child().get_child().get_last_child()
                        self.assertIsInstance(footer, asb.Gtk.Stack)
                        line = footer.get_child_by_name("line")
                        self.assertFalse(line.get_first_child().get_visible())  # The usage-limit clock.
                        self.assertEqual(line.get_first_child().get_next_sibling().get_text(), "Working")
                        self.assertIs(card.asb_dot.get_ancestor(asb.Gtk.Button), card.asb_read_button)
                        alert, alert_row = window.focus_widgets["sample-4"], dict(window.focus_widgets["sample-4"].asb_thread)
                        window.update_session_row(alert, {**alert_row, "lastOutcome": "limit", "unread": True, "alert": True})
                        self.assertEqual(alert.asb_dot.get_first_child().get_text(), "!")
                        self.assertTrue(alert.asb_dot.has_css_class("asb-alert"))
                        self.assertEqual(alert.asb_read_button.asb_action, "win.mark-read")
                        self.assertFalse(alert.asb_read_button.has_css_class("asb-passive-indicator"))
                        self.assertTrue(alert.asb_read_button.get_focusable() and alert.asb_read_button.get_visible())
                        window.update_session_row(alert, alert_row)
                        # The right part: the where glyph and label (hidden for a desktop row), then the age.
                        right, sample = line.get_last_child(), window.focus_widgets["sample-15"]
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
                        # A column far from the view has no cards.
                        row = column.get_first_child() or window.focus_widgets[focused]
                        self.assertEqual(row.get_height(), 68)
                        self.assertLessEqual(row.get_allocated_width(), 180)
                        self.assertLessEqual(row.get_child().get_child().get_last_child().get_allocated_width(), row.get_allocated_width())
                        column = column.get_next_sibling()
                    self.assertEqual(asb.read_layout(layout_path)["view"], "comfortable")
                    if output:
                        window.search.grab_focus(); self.drain(.2); adjustment.set_value(0); self.drain(.2)
                        self.capture(window, Path(output) / "view-comfortable-360-width160.png")
                    window.reset_width(); self.drain()
                    self.assertEqual(asb.read_layout(layout_path), {"columnWidth": 240, "view": "comfortable", "cardLimit": 0, "copyKind": "relative"})
                window.search.set_text("cl:"); window.render()
                self.assertTrue(all(row["provider"] == "claude-desktop-code" for row in window.visible_rows()))
                window.states = {"working", "idle"}
                window.set_pending(True)
                window.set_archived(True)
                window.view_filter.set_selected(0); self.drain()
                self.assertEqual(window.search.get_text(), "cl:")
                self.assertEqual(window.states, {"working", "idle"})
                self.assertTrue(window.pending)
                self.assertTrue(window.archived)
                window.view_filter.set_selected(1); self.drain()
                self.assertEqual(window.column_width, 240)
                if output and width == 680:
                    window.search.grab_focus(); self.drain(.2)
                    adjustment.set_value(0); self.drain(.2)
                    self.capture(window, Path(output) / "view-comfortable-active-pills.png")
                window.clear_search(); window.clear_filters(); self.drain()
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
                original = window.card_for("sample-15")
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
        # The caption shows the copied text, so the tooltip keeps the reference.
        self.assertEqual((button.asb_icon.get_icon_name(), button.get_tooltip_text()), ("object-select-symbolic", reference))
        self.assertEqual(button.asb_label.get_label(), "Copy relative reference")
        self.assert_accessible_label(button, "Relative session copied", asb.Gtk.AccessibleProperty.DESCRIPTION)
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
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
        card = window.focus_widgets[invalid_row["id"]].asb_copy_button
        self.assertEqual((card.get_visible(), card.asb_action, card.get_tooltip_text()), (True, None, reason))
        self.assertTrue(card.has_css_class("asb-copy-off"))
        self.assert_accessible_disabled(card, True)
        self.assert_accessible_label(card, "Copy relative reference: " + invalid_row["title"])
        card.emit("clicked"); self.drain(.1)
        self.assertEqual(len(clipboard.texts), 2)

    def test_remote_card_copy_button_copies_the_absolute_reference(self):
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        app_id = "123e4567-e89b-12d3-a456-426614174000"
        reference = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:" + app_id
        def row(identity, order, **extra):
            return {"id": identity, "provider": "codex", "providerLabel": "Codex", "title": "Summarize the open issues " + identity,
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "externalId": app_id, "sessionReference": "codex/" + app_id, "reference": reference, "updatedAtMs": NOW - order * 1000, **extra}
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            row("local", 1), row("cli", 2, surface="cli", canOpen=False),
            row("m:0123456789abcdef:remote", 3, remote=True, machineName="homeLP", canOpen=False),
            row("m:0123456789abcdef:nofull", 4, remote=True, machineName="homeLP", canOpen=False)]}
        dashboard["threads"][3].pop("reference")
        dashboard["threads"][3]["referenceUnavailable"] = "old-peer"
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        clipboard = SimpleNamespace(texts=[])
        clipboard.set = clipboard.texts.append
        window.get_clipboard = lambda: clipboard  # No write to a real clipboard.
        window.set_default_size(680, 600)
        window.present(); window.set_focus(None); self.drain(.4)
        window.view_filter.set_selected(1); self.drain(.5); window.check_geometry(); self.drain()
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
        card = lambda identity: window.focus_widgets[identity].asb_copy_button
        remote, nofull = "m:0123456789abcdef:remote", "m:0123456789abcdef:nofull"
        # A local row, also a view-only CLI row, keeps the relative reference.
        for identity in ("local", "cli"):
            self.assertEqual((card(identity).get_visible(), card(identity).get_tooltip_text(), card(identity).asb_action),
                             (True, "Copy relative reference", "win.copy-reference"))
            self.assert_accessible_label(card(identity), "Copy relative reference: " + window.focus_widgets[identity].asb_thread["title"])
            card(identity).emit("clicked"); self.drain(.1)
        self.assertEqual(clipboard.texts, ["codex/" + app_id] * 2)
        # A remote row copies the absolute reference and shows the same check.
        self.assertEqual((card(remote).get_visible(), card(remote).get_tooltip_text(), card(remote).asb_action),
                         (True, "Copy absolute reference. Relative works only on this machine. This session runs on homeLP.", "win.copy-reference"))
        self.assert_accessible_label(card(remote), "Copy absolute reference: " + window.focus_widgets[remote].asb_thread["title"])
        card(remote).emit("clicked"); self.drain(.1)
        self.assertEqual(clipboard.texts[-1], reference)
        self.assertEqual((card(remote).get_child().get_icon_name(), card(remote).get_tooltip_text()),
                         ("object-select-symbolic", "Copy absolute reference. Relative works only on this machine. This session runs on homeLP."))
        self.assertTrue(card(remote).has_css_class("asb-copy-confirmed"))
        # With no absolute reference the remote button keeps its place, with no action, and gives the absolute reason.
        reason = "homeLP has an older ASB. Update ASB on that machine."
        self.assertEqual((card(nofull).get_visible(), card(nofull).asb_action, card(nofull).get_tooltip_text()), (True, None, reason))
        self.assertTrue(card(nofull).has_css_class("asb-copy-off"))
        self.assert_accessible_disabled(card(nofull), True)
        self.assert_accessible_label(card(nofull), "Copy absolute reference: " + window.focus_widgets[nofull].asb_thread["title"])
        count = len(clipboard.texts)
        card(nofull).emit("clicked"); self.drain(.1)
        self.assertEqual(len(clipboard.texts), count)
        # The button follows the reference: it comes on when the row gets one and goes off when the row loses it.
        gets = copy.deepcopy(dashboard)
        gets["threads"][3].pop("referenceUnavailable"); gets["threads"][3]["reference"] = reference
        window.apply_dashboard(gets, None); self.settle(window)
        self.assertEqual((card(nofull).asb_action, card(nofull).get_tooltip_text(), card(nofull).has_css_class("asb-copy-off")),
                         ("win.copy-reference", "Copy absolute reference. Relative works only on this machine. This session runs on homeLP.", False))
        self.assert_accessible_disabled(card(nofull), False)
        window.apply_dashboard(copy.deepcopy(dashboard), None); self.settle(window)
        self.assertEqual((card(nofull).asb_action, card(nofull).get_tooltip_text()), (None, reason))
        # A clipboard error names the kind, and a later good copy clears it.
        good = clipboard.set
        clipboard.set = lambda _text: (_ for _ in ()).throw(TypeError("no clipboard"))
        card(remote).emit("clicked"); self.drain(.1)
        self.assertEqual(window.open_errors[remote], "Cannot copy the absolute reference: no clipboard")
        card("local").emit("clicked"); self.drain(.1)
        self.assertEqual(window.open_errors["local"], "Cannot copy the relative reference: no clipboard")
        clipboard.set = good
        for identity in (remote, "local"):
            card(identity).emit("clicked"); self.drain(.1)
        self.assertNotIn(remote, window.open_errors)
        self.assertNotIn("local", window.open_errors)
        # The row panel keeps both entries for a remote row.
        window.show_context(window.focus_widgets[remote]); self.drain(.3)
        panel = window.context_menu
        self.assertEqual((panel.asb_copy.asb_label.get_label(), panel.asb_copy_full.asb_label.get_label()),
                         ("Copy relative reference", "Copy absolute reference"))
        count = len(clipboard.texts)
        panel.asb_copy.emit("clicked"); self.drain(.1)
        panel.asb_copy_full.emit("clicked"); self.drain(.1)
        self.assertEqual(clipboard.texts[count:], ["codex/" + app_id, reference])

    def test_card_copy_kind_switch_tag_wheel_keys_click_and_feedback(self):
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        app_id = "123e4567-e89b-12d3-a456-426614174000"
        relative = "codex/" + app_id
        absolute = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:" + app_id
        def row(identity, order, **extra):
            return {"id": identity, "provider": "codex", "providerLabel": "Codex", "title": "Summarize the open issues " + identity,
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "externalId": app_id, "sessionReference": "codex/" + app_id, "reference": absolute,
                    "updatedAtMs": NOW - order * 1000, **extra}
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            row("local", 1), row("local-2", 2),
            row("m:0123456789abcdef:remote", 3, remote=True, machineName="homeLP", canOpen=False)]}
        # Extra columns so the wheel before the rest has a column scroll to take.
        dashboard["threads"] += [row(f"fill-{n}", 10 + n) for n in range(12)]
        with tempfile.TemporaryDirectory(prefix="asb-copy-kind-") as temporary:
            layout_path = Path(temporary) / "layout.json"
            window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                          theme_path=False, layout_path=layout_path)
            self.addCleanup(window.close)
            clipboard = SimpleNamespace(texts=[])
            clipboard.set = clipboard.texts.append
            window.get_clipboard = lambda: clipboard  # No write to a real clipboard.
            window.set_default_size(680, 420)
            window.present(); window.set_focus(None); self.drain(.4)
            window.view_filter.set_selected(1); self.drain(.5); window.check_geometry(); self.drain()
            for card in window.focus_widgets.values():
                window.ensure_card_controls(card)
            self.drain()
            cards = {row["id"]: window.focus_widgets[row["id"]] for row in dashboard["threads"]}
            copy_of = lambda identity: cards[identity].asb_copy_button
            tag_of = lambda identity: copy_of(identity).asb_tag
            words_of = lambda identity: cards[identity].asb_copy_words
            # The tag is hidden at rest and shows the complete word after the 250 ms rest.
            self.assertFalse(copy_of("local").asb_tag_shown)
            self.assertFalse(tag_of("local").get_reveal_child())
            def motion(identity, inside):
                button = copy_of(identity)
                controller = SimpleNamespace(get_widget=lambda: button)
                if inside:
                    window.copy_button_enter(controller, 0, 0)
                else:
                    window.copy_button_leave(controller)
            motion("local", True)
            self.assertFalse(copy_of("local").asb_tag_shown)
            self.drain(.05)
            # Before the rest the wheel goes to the column and does not switch the kind.
            adjustment = window.scroll.get_hadjustment()
            before = adjustment.get_value()
            self.assertEqual(window.copy_kind, "relative")
            self.assertTrue(window.scroll_horizontal(None, 0, 1))
            self.assertEqual(window.copy_kind, "relative")
            self.assertIsNotNone(window.scroll_target)  # The column spring takes the wheel.
            end = time.monotonic() + 6
            while window.scroll_target is not None and time.monotonic() < end:
                self.drain(.02)
            self.assertIsNone(window.scroll_target)
            self.assertGreater(adjustment.get_value(), before)
            self.assertEqual(window.copy_kind, "relative")
            # After the rest the tag slides out with the complete word, and the wheel switches every local card.
            self.drain(.3)
            self.assertTrue(copy_of("local").asb_tag_shown)
            self.assertTrue(tag_of("local").get_reveal_child())
            self.assertEqual(words_of("local").get_visible_child_name(), "relative")
            self.assertEqual(words_of("local").get_child_by_name("relative").get_label(), "Relative")
            self.assertEqual(words_of("local").get_child_by_name("absolute").get_label(), "Absolute")
            self.assertTrue(window.scroll_horizontal(None, 0, 1))
            self.assertEqual(window.copy_kind, "absolute")
            self.assertEqual(asb.read_layout(layout_path)["copyKind"], "absolute")
            self.assertEqual(words_of("local").get_visible_child_name(), "absolute")
            self.assertEqual(words_of("local-2").get_visible_child_name(), "absolute")
            # A remote card keeps Absolute and its wheel does not move the board kind.
            motion("m:0123456789abcdef:remote", True)
            self.drain(.3)
            self.assertEqual(copy_of("m:0123456789abcdef:remote").asb_tag_shown, True)
            self.assertEqual(words_of("m:0123456789abcdef:remote").get_visible_child_name(), "absolute")
            self.assertTrue(window.scroll_horizontal(None, 0, -1))
            self.assertEqual(window.copy_kind, "absolute")
            motion("m:0123456789abcdef:remote", False)
            # Alt+Up and Alt+Down switch the kind on a focused copy button.
            local_copy = copy_of("local")
            window.set_focus(local_copy); window.set_focus_visible(True); window.key_focus_changed(); self.drain(.1)
            self.assertTrue(local_copy.asb_tag_shown)
            self.assertTrue(window.row_key(None, asb.Gdk.KEY_Up, 0, asb.Gdk.ModifierType.ALT_MASK, "local"))
            self.assertEqual(window.copy_kind, "relative")
            self.assertTrue(window.row_key(None, asb.Gdk.KEY_Down, 0, asb.Gdk.ModifierType.ALT_MASK, "local"))
            self.assertEqual(window.copy_kind, "absolute")
            self.assertEqual(asb.read_layout(layout_path)["copyKind"], "absolute")
            # A click copies the chosen kind and shows the done text in the footer for 1.6 s.
            footer = cards["local"].asb_footer_stack
            self.assertEqual(footer.get_visible_child_name(), "line")
            local_copy.emit("clicked"); self.drain(.1)
            self.assertEqual(clipboard.texts[-1], absolute)
            self.assertEqual(footer.get_visible_child_name(), "copied")
            self.assertEqual(cards["local"].asb_feedback_label.get_label(), "Absolute session copied")
            # The footer stack never hides the limit clock, state, or age; only the visible page changes.
            self.assertTrue(cards["local"].asb_state_label.get_visible())
            self.assertTrue(cards["local"].asb_age_label.get_parent().get_visible())
            self.assertEqual(local_copy.get_child().get_icon_name(), "object-select-symbolic")
            # The footer shows the copied text, so the tooltip stays.
            self.assertEqual(local_copy.get_tooltip_text(), "Copy absolute reference")
            self.assert_accessible_label(local_copy, "Absolute session copied", asb.Gtk.AccessibleProperty.DESCRIPTION)
            output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
            if output:
                Path(output).mkdir(parents=True, exist_ok=True)
                window.scroll.get_hadjustment().set_value(0); self.drain(.1)
                self.capture(window, Path(output) / "native-copy-absolute-copied.png")
            self.drain(1.7)
            self.assertEqual(footer.get_visible_child_name(), "line")
            self.assertTrue(cards["local"].asb_state_label.get_visible())
            self.assertTrue(cards["local"].asb_age_label.get_parent().get_visible())
            self.assertEqual(local_copy.get_tooltip_text(), "Copy absolute reference")
            # Relative copies the short reference and the relative done text.
            self.assertTrue(window.row_key(None, asb.Gdk.KEY_Up, 0, asb.Gdk.ModifierType.ALT_MASK, "local"))
            self.assertEqual(window.copy_kind, "relative")
            local_copy.emit("clicked"); self.drain(.1)
            self.assertEqual(clipboard.texts[-1], relative)
            self.assertEqual(cards["local"].asb_feedback_label.get_label(), "Relative session copied")
            self.assertEqual(local_copy.get_tooltip_text(), "Copy relative reference")
            if output:
                window.scroll.get_hadjustment().set_value(0); self.drain(.1)
                self.capture(window, Path(output) / "native-copy-relative-copied.png")
            self.drain(1.7)
            # A remote card keeps Absolute and its tag, and the Relative reason is its tooltip.
            remote_copy = copy_of("m:0123456789abcdef:remote")
            self.assertEqual((remote_copy.get_tooltip_text(), remote_copy.asb_action),
                             ("Copy absolute reference. Relative works only on this machine. This session runs on homeLP.", "win.copy-reference"))
            remote_copy.emit("clicked"); self.drain(.1)
            self.assertEqual(clipboard.texts[-1], absolute)
            self.assertEqual(cards["m:0123456789abcdef:remote"].asb_feedback_label.get_label(), "Absolute session copied")
            self.assertEqual(remote_copy.get_tooltip_text(), "Copy absolute reference. Relative works only on this machine. This session runs on homeLP.")
            if output:
                window.scroll.get_hadjustment().set_value(0); self.drain(.1)
                self.capture(window, Path(output) / "native-copy-remote-card.png")
            self.drain(1.7)
            # The row panel caption shows the done text after a copy.
            window.show_context(cards["local"]); self.drain(.3)
            panel = window.context_menu
            panel.asb_copy.emit("clicked"); self.drain(.1)
            self.assertEqual(panel.asb_copy.asb_caption.get_label(), "Relative session copied")
            self.assertEqual(clipboard.texts[-1], relative)
            self.drain(1.7)
            self.assertEqual(panel.asb_copy.asb_caption.get_label(), "Relative: in the same app")
            panel.popdown(); self.drain(.2)
            # The tag captures for asb-main: Relative and Absolute words on a Comfortable card.
            if output:
                Path(output).mkdir(parents=True, exist_ok=True)
                def snap(name):
                    window.scroll.get_hadjustment().set_value(0)
                    self.drain(.1)
                    self.capture(window, Path(output) / name)
                window.set_focus(local_copy); window.set_focus_visible(True); window.key_focus_changed()
                window.change_copy_kind("relative"); self.drain(.3)
                snap("native-copy-tag-relative.png")
                window.change_copy_kind("absolute"); self.drain(.3)
                snap("native-copy-tag-absolute.png")
                # A3 (d): a remote card through the real hover path, only its tag showing.
                window.set_focus(None); window.set_focus_visible(False); window.key_focus_changed()
                window.show_copy_tag(local_copy, False)
                remote_card = cards["m:0123456789abcdef:remote"]
                window.row_hover(SimpleNamespace(contains_pointer=lambda: True, get_widget=lambda: remote_card))
                motion("m:0123456789abcdef:remote", True)
                window.change_copy_kind("relative"); self.drain(.35)
                self.assertTrue(remote_card.has_css_class("asb-hovered"))
                self.assertFalse(copy_of("local").asb_tag_shown)
                self.assertTrue(remote_copy.asb_tag_shown)
                snap("native-copy-remote-tag-absolute.png")
                motion("m:0123456789abcdef:remote", False)
                window.row_hover(SimpleNamespace(contains_pointer=lambda: False, get_widget=lambda: remote_card))
                # R7 (f): 4x nearest-neighbor crops of the actions area of the two tag shots, in one PNG.
                from gi.repository import GdkPixbuf
                def actions_crop(path):
                    pix = GdkPixbuf.Pixbuf.new_from_file(str(path))
                    found, box = cards["local"].asb_copy_button.get_parent().compute_bounds(window)
                    x, y = int(box.origin.x), int(box.origin.y)
                    w, h = max(1, int(box.size.width) + 8), max(1, int(box.size.height) + 4)
                    x, y = max(0, x - 4), max(0, y - 2)
                    w = min(w, pix.get_width() - x)
                    h = min(h, pix.get_height() - y)
                    crop = pix.new_subpixbuf(x, y, w, h)
                    return crop.scale_simple(w * 4, h * 4, GdkPixbuf.InterpType.NEAREST)
                left = actions_crop(Path(output) / "native-copy-tag-relative.png")
                right = actions_crop(Path(output) / "native-copy-tag-absolute.png")
                both = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8,
                                            left.get_width() + right.get_width() + 12,
                                            max(left.get_height(), right.get_height()))
                both.fill(0x1e1e1eff)
                left.copy_area(0, 0, left.get_width(), left.get_height(), both, 0, 0)
                right.copy_area(0, 0, right.get_width(), right.get_height(), both, left.get_width() + 12, 0)
                both.savev(str(Path(output) / "native-copy-tag-crops.png"), "png", [], [])

    def test_copy_feedback_keeps_the_limit_clock_and_needs_focus_visible(self):
        patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        app_id = "123e4567-e89b-12d3-a456-426614174000"
        absolute = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:" + app_id
        now = time.time() * 1000
        rows = [
            {"id": "limited", "provider": "codex", "providerLabel": "Codex", "sourceLabel": "Codex Personal",
             "title": "Plan the alarm export", "cwd": "/example/alarms", "projectName": "alarms", "state": "idle",
             "canOpen": True, "externalId": app_id, "sessionReference": "codex/" + app_id, "reference": absolute,
             "updatedAtMs": now - 600_000, "limitResetsAtMs": now + 45_000},
            {"id": "local", "provider": "codex", "providerLabel": "Codex", "title": "Test the offline mode",
             "cwd": "/example/mobile", "projectName": "mobile", "state": "idle", "canOpen": True,
             "externalId": app_id, "sessionReference": "codex/" + app_id, "reference": absolute,
             "updatedAtMs": now - 60_000},
        ]
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", {"generatedAtMs": now, "providers": [], "threads": rows},
                                       theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        clipboard = SimpleNamespace(texts=[])
        clipboard.set = clipboard.texts.append
        window.get_clipboard = lambda: clipboard
        window.set_default_size(520, 320)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.4)
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
        limited = window.focus_widgets["limited"]
        self.assertTrue(limited.asb_limit_clock.get_visible())
        self.assertEqual(limited.asb_state_label.get_text(), "Resets in")
        # During the feedback the copy button keeps the done text as its accessible description.
        button = limited.asb_copy_button
        button.emit("clicked"); self.drain(.1)
        self.assert_accessible_label(button, "Relative session copied", asb.Gtk.AccessibleProperty.DESCRIPTION)
        self.assertEqual(limited.asb_footer_stack.get_visible_child_name(), "copied")
        # R6: after the feedback the usage-limit clock is visible again and the state says Resets in.
        self.drain(1.7)
        self.assertEqual(limited.asb_footer_stack.get_visible_child_name(), "line")
        self.assertTrue(limited.asb_limit_clock.get_visible())
        self.assertEqual(limited.asb_state_label.get_text(), "Resets in")
        # The description is reset: the property holds the done text no more.
        error = self.gtk_check(self.capsule_pointer(button.__gpointer__, None),
                               int(asb.Gtk.AccessibleProperty.DESCRIPTION),
                               ctypes.c_char_p(b"Relative session copied"))
        self.assertIsNotNone(error)
        message = ctypes.string_at(error).decode()
        self.g_free(error)
        self.assertEqual(message, "undefined")
        self.assertRegex(limited.asb_age_label.get_text(), r"^\d{1,2}s$|^\d+m\d{1,2}s$")
        output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")
        if output:
            Path(output).mkdir(parents=True, exist_ok=True)
            window.scroll.get_hadjustment().set_value(0)
            self.drain(.1)
            self.capture(window, Path(output) / "native-copy-limited-after-feedback.png")
        # R6: a mouse click must not show the tag; only a visible focus ring does.
        local = window.focus_widgets["local"].asb_copy_button
        self.assertFalse(local.asb_tag_shown)
        local.grab_focus(); window.set_focus_visible(False); window.key_focus_changed(); self.drain(.1)
        self.assertFalse(local.asb_tag_shown)
        window.set_focus_visible(True); window.key_focus_changed(); self.drain(.1)
        self.assertTrue(local.asb_tag_shown)
        self.assertEqual(local.asb_card.asb_copy_words.get_visible_child_name(), "relative")
        # R6: the drawn kind glyphs resolve after the app adds the ASB icon path.
        theme = asb.Gtk.IconTheme.get_for_display(window.get_display())
        self.assertTrue(theme.has_icon("asb-link-symbolic"))
        self.assertTrue(theme.has_icon("asb-globe-symbolic"))
        self.assertTrue((Path(asb.__file__).parents[1] / "assets" / "icons" / "asb-link-symbolic.svg").exists())
        self.assertTrue((Path(asb.__file__).parents[1] / "assets" / "icons" / "asb-globe-symbolic.svg").exists())

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
        window.set_default_size(420, 850); self.drain(.3); window.check_geometry(); self.drain()
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True); self.drain(.3)
        # The inline entry keeps the focus while the window handles the number keys.
        window.open_search(); self.drain(.3)
        self.assertTrue(window.search_row.get_reveal_child())
        keys("keydown", "Control_L", wait=.45)
        self.assertTrue(window.numbers_shown)
        self.assertEqual(len(window.number_keys), 9)
        expected = []
        for number in range(1, 10):
            if number <= len(window.number_keys):
                expected.append(window.number_keys[number - 1])
            keys("key", str(number))
        self.assertEqual(opened, expected)
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
        self.assertEqual(opened, expected)
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
        self.fill_board(window); self.drain()
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

    def lazy_board(self, count=300, width=420, height=600):
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": board_rows(count), "persistentUnread": False}
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(width, height)
        window.present(); self.drain(.3); window.check_geometry(); self.drain()
        return window, dashboard

    def assert_columns_filled(self, window):
        """Each filled column lists the cards of its rows in order, each other column is empty, and only filled cards are in focus_widgets."""
        parts, filled = window.column_parts, window.filled_columns
        for number, part in enumerate(parts):
            cards = board_children(window.list_columns[number])
            self.assertEqual([card.asb_focus_key for card in cards], [row["id"] for row in part] if number in filled else [])
            self.assertEqual(board_listed(window.list_columns[number]), cards)
        self.assertEqual(list(window.focus_widgets), [identity for identity in window.row_order if window.row_columns[identity] in filled])

    def test_board_builds_only_the_cards_of_the_columns_near_the_view(self):
        window, _dashboard = self.lazy_board()
        parts = window.column_parts
        self.assertGreater(len(parts), 10)
        first, last = window.column_range()
        self.assertEqual(window.filled_columns, set(range(first, last)))
        self.assertLess(len(window.focus_widgets), 6 * window.capacity)
        self.assert_columns_filled(window)
        self.assertEqual(len(window.row_order), 300)
        # An empty column keeps its width, so the scroll range is the one of a board with all cards.
        # Each column after the first has a 1 px divider.
        self.assertEqual({listing.get_width() for listing in window.list_columns[1:len(parts)]}, {window.column_pixel_width - 1})
        adjustment = window.scroll.get_hadjustment()
        width, upper = window.list_body.get_width(), adjustment.get_upper()
        window.fill_columns(range(len(parts))); self.drain()
        self.assertEqual(len(window.focus_widgets), 300)
        self.assert_columns_filled(window)
        self.assertEqual((window.list_body.get_width(), adjustment.get_upper()), (width, upper))

    def test_hover_controls_build_on_first_hover_with_current_action_state(self):
        window, _dashboard = self.lazy_board(20)
        window.view_filter.set_selected(1); self.drain()
        for extra in ({"unread": True}, {"drawer": True}, {"externalId": "invalid id"}, {"unread": True, "busy": True}):
            with self.subTest(extra=extra):
                row = {**board_rows(1)[0], **extra}
                card = window.session_row(row)
                self.addCleanup(window.release_row, card)
                self.assertFalse(any(hasattr(card, name) for name in ("asb_copy_button", "asb_copy_tag", "asb_drawer_button")))
                self.assertIsNotNone(card.asb_read_button)
                self.assertIsNotNone(card.asb_pin_button)
                if extra.get("busy"):
                    window.session_actions.add(row["id"])
                # An already-built card gets the same update as the first-use card.
                eager = window.session_row(board_rows(1)[0])
                self.addCleanup(window.release_row, eager)
                window.ensure_card_controls(eager)
                window.update_session_row(eager, row)
                window.set_row_hover(card, True)
                for name in ("copy", "drawer", "read", "pin"):
                    button, expected = (getattr(item, "asb_" + name + "_button") for item in (card, eager))
                    self.assertEqual(set(button.get_css_classes()), set(expected.get_css_classes()))
                    self.assertEqual((button.get_visible(), button.asb_action, button.get_tooltip_text()),
                                     (expected.get_visible(), expected.asb_action, expected.get_tooltip_text()))
                controls = card.asb_copy_button, card.asb_drawer_button, card.asb_copy_tag
                window.set_row_hover(card, False); window.set_row_hover(card, True)
                self.assertEqual(controls, (card.asb_copy_button, card.asb_drawer_button, card.asb_copy_tag))
                window.set_row_hover(card, False)
                window.session_actions.discard(row["id"])

    def test_keyboard_focus_builds_hover_controls_before_tab_enters_them(self):
        window, _dashboard = self.lazy_board(20)
        window.view_filter.set_selected(1); self.drain()
        card = window.session_row({**board_rows(1)[0], "id": "focus-first", "unread": True})
        self.addCleanup(window.release_row, card)
        window.list_columns[0].insert(card, 0)
        self.assertFalse(hasattr(card, "asb_copy_button"))
        card.grab_focus(); window.set_focus_visible(True); self.drain()
        self.assertIs(window.get_focus(), card)
        self.assertTrue(card.has_css_class("asb-key-focus"))
        self.assertIsNotNone(card.asb_copy_tag)
        for name in ("copy", "drawer", "read", "pin"):
            self.assertTrue(window.child_focus(asb.Gtk.DirectionType.TAB_FORWARD))
            self.drain(.03)
            self.assertIs(window.get_focus(), getattr(card, "asb_" + name + "_button"))

    def test_a_card_released_before_hover_controls_exist_is_freed(self):
        window, _dashboard = self.lazy_board(20)
        window.view_filter.set_selected(1); self.drain()
        card = window.session_row({**board_rows(1)[0], "id": "never-hovered"})
        self.assertFalse(hasattr(card, "asb_copy_button"))
        reference = weakref.ref(card)
        window.release_row(card)
        del card
        gc.collect(); self.drain(.03); gc.collect()
        self.assertIsNone(reference())

    def test_copy_action_and_focus_restore_build_controls_before_any_hover(self):
        window, _dashboard = self.lazy_board(20)
        window.view_filter.set_selected(1); self.drain()
        cards = [card for card in window.focus_widgets.values() if not hasattr(card, "asb_copy_button")]
        self.assertGreaterEqual(len(cards), 2)
        first, second = cards[-2:]
        clipboard = Mock()
        window.get_clipboard = lambda: clipboard
        window.copy_reference(None, asb.GLib.Variant("s", first.asb_focus_key))
        clipboard.set.assert_called_once()
        self.assertIsNotNone(first.asb_copy_button)
        self.assertEqual(first.asb_footer_stack.get_visible_child_name(), "copied")
        window.restore_position(second.asb_focus_key, 0, focused_action="copy")
        self.assertIs(window.get_focus(), second.asb_copy_button)

    def test_column_range_uses_the_allocated_edges_and_one_side_column(self):
        window, _dashboard = self.lazy_board()
        window.column_pixel_width = 268
        cases = ((0, 1400, (0, 6)), (280, 1400, (0, 7)), (560, 560, (1, 5)),
                 (840, 280, (2, 5)), (100, 1400, (0, 7)), (300, 560, (0, 5)),
                 (272, 12, (0, 2)), (271, 14, (0, 3)), (284, 268, (0, 3)),
                 (552, 12, (1, 3)), (564, 280, (1, 4)))
        for value, page, expected in cases:
            with self.subTest(value=value, page=page):
                self.assertEqual(window.column_range(value, page), expected)

    def test_side_columns_fill_one_at_a_time_after_the_first_paint(self):
        window, _dashboard = self.lazy_board(300, width=1400, height=900)
        window.set_focus(None)
        window.layout_signature = None
        window.render()
        touching = set(range(*window.column_range(sides=False)))
        nearby = set(range(*window.column_range()))
        self.assertEqual(window.filled_columns, touching)
        self.assertTrue(nearby - touching)
        first_paint, fills = [], []
        clock = window.get_frame_clock()
        handler = clock.connect("after-paint", lambda _clock: first_paint.append(set(window.filled_columns)))
        self.addCleanup(clock.disconnect, handler)
        fill = window.fill_columns
        def record(numbers):
            fills.append(tuple(numbers))
            self.assertTrue(first_paint)
            return fill(numbers)
        with patch.object(window, "fill_columns", record):
            self.drain(.4)
        self.assertEqual(first_paint[0], touching)
        self.assertEqual(window.filled_columns, nearby)
        self.assertEqual(fills, [(number,) for number in sorted(nearby - touching)])
        self.assertIsNone(window.side_fill_idle)
        self.assertIsNone(window.side_fill_frame)
        self.assertIsNone(window.side_fill_tick)

    def test_a_new_render_cancels_a_side_fill_waiting_for_its_frame(self):
        window, _dashboard = self.lazy_board(300, width=1400, height=900)
        window.set_focus(None)
        window.layout_signature = None
        window.render()
        tick = window.side_fill_tick
        self.assertIsNotNone(tick)
        with patch.object(window.list_body, "remove_tick_callback", wraps=window.list_body.remove_tick_callback) as remove:
            window.search.set_text("no matching made-up title")
            window.render()
            remove.assert_any_call(tick)
        self.drain(.4)
        self.assertEqual(window.side_columns, ())
        self.assertIsNone(window.side_fill_tick)
        self.assertIsNone(window.side_fill_frame)
        self.assertIsNone(window.side_fill_idle)
        self.assertEqual(window.focus_widgets, {})

    def test_columns_get_their_cards_before_they_paint(self):
        window, _dashboard = self.lazy_board()
        adjustment, viewport = window.scroll.get_hadjustment(), window.scroll.get_child()
        painted, empty = [], []
        def after_paint(_clock):
            for number, listing in enumerate(window.list_columns[:len(window.column_parts)]):
                found, bounds = listing.compute_bounds(viewport)
                if found and bounds.origin.x < viewport.get_width() and bounds.origin.x + bounds.size.width > 0:
                    painted.append(number)
                    if len(board_children(listing)) != len(window.column_parts[number]):
                        empty.append((number, adjustment.get_value()))
        clock = window.get_frame_clock()
        handler = clock.connect("after-paint", after_paint)
        self.addCleanup(clock.disconnect, handler)
        # A scroll before the queued side fill must fill its destination synchronously.
        window.set_focus(None)
        window.layout_signature = None
        window.render()
        self.assertIsNotNone(window.side_fill_tick)
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
        self.assertIn(len(window.column_parts) - 1, window.filled_columns)
        self.drain(.3)
        self.assertIn(len(window.column_parts) - 1, painted)
        # A wheel spring back toward the start, and a wider window, show more columns.
        for _notch in range(4):
            window.scroll_horizontal(None, 0, -1); self.drain(.05)
        end = time.monotonic() + 6
        while window.scroll_target is not None and time.monotonic() < end:
            self.drain(.02)
        window.set_default_size(1100, 600); self.drain(.4); window.check_geometry(); self.drain(.3)
        adjustment.set_value(adjustment.get_upper() / 2); self.drain(.3)
        self.assertEqual(empty, [])
        self.assertGreater(len(set(painted)), 4)
        self.assert_columns_filled(window)

    def test_keyboard_moves_reach_cards_in_columns_with_no_cards_yet(self):
        window, dashboard = self.lazy_board(600)
        order, capacity = window.row_order, window.capacity
        first, last = order[0], order[-1]
        self.assertNotIn(last, window.focus_widgets)
        window.focus_widgets[first].grab_focus()
        window.row_key(None, asb.Gdk.KEY_End, 0, 0, first); self.drain(.3)
        self.assertEqual(window.focus_key(), last)
        self.assertIs(window.get_focus(), window.focus_widgets[last])
        self.assert_focus_visible(window, last)
        window.row_key(None, asb.Gdk.KEY_Home, 0, 0, last); self.drain(.3)
        self.assertEqual(window.focus_key(), first)
        self.assert_focus_visible(window, first)
        identity = first
        for step in range(1, 6):
            window.row_key(None, asb.Gdk.KEY_Right, 0, 0, identity); self.drain(.1)
            identity = order[step * capacity]
            self.assertEqual(window.focus_key(), identity)
        self.drain(.2)
        self.assert_focus_visible(window, identity)
        self.assert_columns_filled(window)
        # Tab from the last column with cards goes to the first card of the next column.
        number = min(number for number in window.filled_columns if number + 1 not in window.filled_columns | {len(window.column_parts)})
        window.focus_widgets[window.column_parts[number][-1]["id"]].grab_focus(); self.drain(.2)
        self.assertTrue(window.child_focus(asb.Gtk.DirectionType.TAB_FORWARD)); self.drain(.2)
        self.assertEqual(window.focus_key(), window.column_parts[number + 1][0]["id"])
        self.assert_columns_filled(window)
        # A refresh after the scroll keeps the focus on the far card, also when a new row moves every card.
        window.row_key(None, asb.Gdk.KEY_End, 0, 0, identity); self.drain(.3)
        changed = copy.deepcopy(dashboard)
        changed["threads"][300]["title"] = "A changed made-up title"
        window.apply_dashboard(changed, None); self.drain(.3)
        self.assertIs(window.get_focus(), window.focus_widgets[last])
        changed = copy.deepcopy(changed)
        changed["threads"].insert(0, {**changed["threads"][7], "id": "s-new", "title": "A new made-up session", "updatedAtMs": NOW + 1})
        window.apply_dashboard(changed, None); self.drain(.3)
        self.assertEqual(window.row_order[-1], last)
        self.assertIs(window.get_focus(), window.focus_widgets[last])
        self.assert_columns_filled(window)

    def test_show_all_search_and_escape_keep_the_card_order_and_the_shown_cards(self):
        window, _dashboard = self.lazy_board()
        window.card_limit = 20
        window.render(); self.drain(.3)
        self.assertEqual(window.row_order[-1], asb.MORE_ID)
        window.open_row(None, window.card_for(asb.MORE_ID)); self.drain(.3)
        self.assertEqual(len(window.row_order), 300)
        self.assertLess(len(window.focus_widgets), len(window.row_order))
        self.assert_columns_filled(window)
        window.scroll.get_hadjustment().set_value(2000); self.drain(.3)
        self.assert_columns_filled(window)
        released = []
        original = window.release_row
        def release(widget):
            released.append(widget.asb_focus_key)
            original(widget)
        with patch.object(window, "release_row", side_effect=release):
            window.search.set_text("session 1"); self.drain(.3)
            self.assertEqual(window.row_order, [row["id"] for row in window.visible_rows()])
            self.assertTrue(all("session 1" in window.row_cache[identity].asb_thread["title"].lower() for identity in window.focus_widgets))
            self.assert_columns_filled(window)
            self.assertTrue(window.clear_search()); self.drain(.4)
        self.assertFalse(window.show_all_cards)
        self.assertEqual(len(window.row_order), 21)
        self.assert_columns_filled(window)
        self.assertTrue(released)
        self.assertFalse(set(released) & window.row_columns.keys())
        self.assertLessEqual(len(window.row_cache), 2 * window.card_limit + 1)
        self.assertTrue(window.row_columns.keys() <= window.row_cache.keys())

    def test_search_row_slide_renders_the_board_once(self):
        window, _dashboard = self.lazy_board(120, 420, 900)
        self.assertTrue(window.get_settings().get_property("gtk-enable-animations"))
        self.assertEqual(window.search_row.get_transition_type(), asb.Gtk.RevealerTransitionType.SLIDE_DOWN)
        height = window.geometry[1]
        renders = []
        original = window.render_board
        def counted(*args, **kwargs):
            renders.append(window.search_row.get_child_revealed())
            return original(*args, **kwargs)
        with patch.object(window, "render_board", side_effect=counted):
            # The first search key opens the search row.
            window.window_key(None, asb.Gdk.KEY_s, 0, 0); self.drain(.6)
            self.assertEqual(window.search.get_text(), "s")
            self.assertTrue(window.search_row.get_child_revealed())
            self.assertLessEqual(len(renders), 2)
            self.assertLess(window.geometry[1], height)
            self.assertEqual(window.geometry[1], window.scroll.get_child().get_height())
            renders.clear()
            self.assertTrue(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0)); self.drain(.6)
            self.assertFalse(window.search_row.get_child_revealed())
            self.assertLessEqual(len(renders), 2)
            self.assertEqual(window.geometry[1], height)
        self.assert_columns_filled(window)

    def test_set_icon_reuses_one_file_icon_per_glyph_name(self):
        first, second, other = asb.Gtk.Image(), asb.Gtk.Image(), asb.Gtk.Image()
        asb.set_icon(first, "asb-chat-symbolic")
        asb.set_icon(second, "asb-chat-symbolic")
        asb.set_icon(other, "asb-drawer-symbolic")
        self.assertIsInstance(first.get_gicon(), asb.Gio.FileIcon)
        self.assertIs(first.get_gicon(), second.get_gicon())
        self.assertIsNot(other.get_gicon(), first.get_gicon())
        self.assertEqual(Path(first.get_gicon().get_file().get_path()).name, "asb-chat-symbolic.svg")

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
        self.assertEqual([row.asb_thread["id"] for row in self.widget_rows(window)], list(window.focus_widgets))
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
        self.assertEqual(len(window.row_columns), 106)
        with patch.object(window, "session_action") as action:
            # The drag source and the drop target are on the cards, so both cards exist.
            window.card_for("sample-10"); window.card_for("sample-11")
            self.assertIsNotNone(window.pin_drag_prepare(None, 0, 0, "sample-10"))
            self.assertTrue(window.pin_drop(None, "asb-pin:sample-10", 0, 60, "sample-11"))
            self.assertEqual(action.call_args.args[2]["placement"], "after")
        window.row_key(None, asb.Gdk.KEY_End, 0, 0, first); self.drain()
        window.set_default_size(680, 500); self.drain(.3)
        self.assertEqual(window.focus_key(), last)
        self.assert_focus_visible(window, last)
        window.search.grab_focus(); adjustment.set_value(adjustment.get_upper())
        window.set_pending(True); self.drain()
        self.assertLessEqual(adjustment.get_value(), adjustment.get_upper() - adjustment.get_page_size() + 1)
        window.set_pending(False); self.drain()
        window.close(); self.drain(.3)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                      theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(680, 500)
        window.present(); self.drain(.3)
        identity = window.row_order[0]
        window.focus_widgets[identity].grab_focus()
        self.assertGreater(window.menu_button.get_width(), 0)
        window.activate_action("win.preferences", None); self.drain(.2)
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
        window.card_for(last).grab_focus(); self.drain()
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
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
        self.assertTrue(set(range(*window.column_range(sides=False))) & set(range(len(shown))) <= window.filled_columns)
        for number, column in enumerate(shown):
            identities = window.row_order[number * window.capacity:(number + 1) * window.capacity]
            target = [window.focus_widgets[identity] for identity in identities] if number in window.filled_columns else []
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

    def test_view_change_does_not_animate_card_height(self):
        provider = asb.Gtk.CssProvider()
        provider.load_from_data(b"row.activatable { transition: all 75ms ease-in-out; }")
        display = asb.Gdk.Display.get_default()
        asb.Gtk.StyleContext.add_provider_for_display(display, provider, asb.Gtk.STYLE_PROVIDER_PRIORITY_THEME)
        self.addCleanup(asb.Gtk.StyleContext.remove_provider_for_display, display, provider)
        window = self.snapshot_window()
        window.dashboard = {"generatedAtMs": NOW, "providers": [], "threads": board_rows(48)}
        window.render()
        window.set_default_size(700, 600)
        window.present(); self.drain(.5)
        repacks = []
        render = window.render
        def counted(*args, **kwargs):
            repacks.append(window.row_height)
            return render(*args, **kwargs)
        with patch.object(window, "render", side_effect=counted):
            window.view_filter.set_selected(1)
            self.drain(.5)
        self.assertEqual(repacks, [asb.COMFORTABLE_ROW_HEIGHT])
        self.assertEqual({card.get_height() for card in window.focus_widgets.values()}, {asb.COMFORTABLE_ROW_HEIGHT})
        repacks.clear()
        with patch.object(window, "render", side_effect=counted):
            window.view_filter.set_selected(0)
            self.drain(.5)
        self.assertEqual(repacks, [asb.ROW_HEIGHT])

    def test_glide_opens_only_the_card_painted_under_the_pointer(self):
        window = self.snapshot_window()
        window.dashboard = {"generatedAtMs": NOW, "providers": [], "threads": board_rows(48)}
        window.render()
        window.set_default_size(700, 600)
        window.present(); self.drain(.5)
        window.dashboard["threads"][-1].update(pinned=True, pinOrder=-1)
        window.render()
        deadline = time.monotonic() + 2
        while not window.list_body.motion and time.monotonic() < deadline:
            self.drain(.01)
        self.assertTrue(window.list_body.motion)
        window.motion_animation.pause()
        window.advance_motion(1)
        cards = window.focus_widgets
        a, b = cards["s47"], cards["s0"]
        places = window.painted_places()
        def point(card):
            x, y, _fade = places[card.asb_thread["id"]]
            found, point = window.scroll.compute_point(window.list_body, asb.Graphene.Point().init(
                x + card.get_width() / 2, y + card.get_height() / 2))
            self.assertTrue(found)
            return point.x, point.y
        with patch.object(asb, "request_async") as request:
            window.card_pointer = point(b)
            window.open_row(None, a)
            request.assert_not_called()
            window.card_pointer = point(a)
            window.open_row(None, a)
            request.assert_called_once()
            window.opening.clear()
            window.card_pointer = None
            window.open_row(None, a)
            self.assertEqual(request.call_count, 2)
        controllers = window.list_body.observe_controllers()
        clicks = [controllers.get_item(i) for i in range(controllers.get_n_items())
                  if isinstance(controllers.get_item(i), asb.Gtk.GestureClick)]
        click = next(c for c in clicks if c.get_button() == 1)
        self.assertEqual(click.get_propagation_phase(), asb.Gtk.PropagationPhase.CAPTURE)
        for signal in ("pressed", "released"):
            click.emit(signal, 1, 12., 34.)
            self.assertEqual(window.card_pointer, (12., 34.))
            self.drain(.01)
            self.assertIsNone(window.card_pointer)

    def test_card_motion_wheel_spring_and_column_width(self):
        threads = [{"id": f"s{n}", "provider": "codex", "providerLabel": "Codex",
                    "title": f"Sample session {n} " + ("needle " if n % 2 else "") + "with a long synthetic title " * 7,
                    "cwd": f"/example/project-{n % 9}", "projectName": f"project-{n % 9}", "state": "working" if n < 3 else "idle",
                    "canOpen": True, "updatedAtMs": NOW - n * 600_000, "readStatus": "unknown",
                    "pending": 3 <= n < 8, "unread": 3 <= n < 8, "completionAttention": 3 <= n < 8} for n in range(116)]
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": threads}
        # No server: a failed refresh shows a notice, and the notice changes the list height.
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        # Keep the inline row open so query changes test card motion, not a viewport resize.
        window.search.set_text("sample")
        search_height = window.search.measure(asb.Gtk.Orientation.VERTICAL, -1)[1]
        window.set_default_size(1000, 500 + search_height)
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
            wait(lambda: window.side_fill_tick is None and window.side_fill_frame is None and window.side_fill_idle is None
                 and all(row.get_height() for row in self.widget_rows(window)))
            self.assertEqual((strip.motion, window.motion_columns, window.motion_from), ({}, [], None))
            self.assertNotEqual(motion.get_state(), playing)
            self.assertNotEqual(spring.get_state(), playing)
            self.assertEqual([row.asb_thread["id"] for row in self.widget_rows(window)], list(window.focus_widgets))
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
        # The icon-only toolbar is as tall at 1080px as at narrow widths, so a column has room for 21 cards.
        self.assertEqual((window.columns, window.capacity, len(window.row_columns)), (4, 21, 116))
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
        # A staying row whose column had no cards before the change has no old place, so it fades in.
        _progress, offsets, _places = assert_glide(before, seen, staying & set(before))
        self.assertTrue(all(offset[2] == 0 for identity, offset in offsets.items() if identity in before))
        self.assertGreater(len(offsets), 50)
        assert_rest()
        before, seen = change(lambda: window.search.set_text("sample"))
        # A staying row whose column is now far from the view has no card.
        # A side card that fills after the first frame appears at its place.
        animated = set(window.focus_widgets) - window.late_cards
        _progress, offsets, places = assert_glide(before, seen, staying & animated)
        self.assertFalse(window.late_cards & set(offsets))
        self.assertEqual({identity for identity, offset in offsets.items() if offset[2]}, animated - staying)
        self.assertTrue(all(places[identity][2] == 1 and offsets[identity] == (0, 0, 1) for identity in animated - staying))
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
        for action in (lambda: mark("s3", False), lambda: window.search.set_text("needle"), lambda: window.search.set_text("sample")):
            _before, seen = change(action, False)
            self.assertFalse(any(frame[0] or frame[1] for frame in seen))
        adjustment = window.scroll.get_hadjustment()
        window.scroll_horizontal(None, 0, 1)
        self.assertEqual((adjustment.get_value(), window.scroll_target), (max(32, adjustment.get_step_increment()), None))
        settings.set_property("gtk-enable-animations", True)
        # The columns that come into view get their cards at once and their size in the next layout.
        adjustment.set_value(0); self.drain(.1)
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
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
            if view:
                # Comfortable keeps the Discard offer of an Idle card in the Read slot, with no ink before hover or focus.
                self.assertTrue(limited.asb_dot.get_visible() and limited.asb_read_button.has_css_class("asb-discard-offer"))
                self.assertEqual(self.ink(limited.asb_read_button), 0)
            else:
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(520, 400)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.3); window.check_geometry(); self.drain()
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
        settle = lambda: self.settle(window)
        pill, bubble, cards, hover = window.drawer_only, window.drawer_dot, window.focus_widgets, asb.Gtk.StateFlags.PRELIGHT
        put, out = "Put in drawer: look read here, keep it under Drawer", "Take out of drawer: show as unread again"
        def reply(identity, **change):
            requests[-1][2]({"changed": True, "threadId": identity, "thread": dict(cards[identity].asb_thread, **change)}, None)
            settle()

        # The pill: the glyph and a dot that is hidden when empty; the word is only the accessible name and the tooltip.
        self.assertIsInstance(pill, asb.Gtk.ToggleButton)
        self.assertIs(window.toolbar_strip.get_first_child(), pill)
        self.assertIs(pill.get_next_sibling(), window.filters_pill)
        glyph = pill.get_child().get_first_child()
        self.assertTrue(glyph.has_css_class("asb-drawer-glyph"))
        self.assertEqual((glyph.get_width(), glyph.get_height()), (9, 5))  # Without the 1 px border.
        self.assertIs(glyph.get_next_sibling(), bubble)
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
        # The kind tag is first in the corner, then copy, drawer, read, pin. Every state has copy, and every wide corner fades the title for it.
        self.assertIs(drawer.get_parent().get_first_child(), copy_button.asb_tag)
        self.assertIs(copy_button.asb_tag.get_next_sibling(), copy_button)
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
        self.hover_card(window, one, True); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(drawer), self.ink(copy_button)), (0, 255, 255))
        self.assertGreater(self.ink(cue), 0)
        self.assertLess(self.ink(one.asb_state_label), 255)  # The read tone.
        self.hover_card(window, question, True); settle()
        self.assertEqual(self.ink(question.asb_copy_button), 255)
        self.assertGreater(self.ink(question.asb_dot), 0)  # A ? does not change.
        self.hover_card(window, one, False); self.hover_card(window, question, False); settle()
        self.assertEqual((self.ink(one.asb_dot), self.ink(cue), self.ink(drawer), self.ink(copy_button)), (255, 0, 0, 0))
        # Focus from a mouse click (not visible) does not change the row. Visible keyboard focus shows the controls.
        shown = lambda: (self.ink(one.asb_dot), self.ink(drawer), self.ink(cue) > 0, self.ink(one.asb_state_label), self.ink(copy_button) > 0)
        for focus in (one, read, drawer, copy_button):
            window.set_focus(focus); window.set_focus_visible(False); settle()
            self.assertFalse(one.has_css_class("asb-key-focus"))
            if focus is one:
                self.assertEqual(shown(), (255, 0, False, 255, False))
                self.assertGreater(self.ink(one.asb_pin_button), 0)  # The pin rule of 1.5.0 stays.
            self.assertEqual((self.ink(one.asb_dot), self.ink(drawer), self.ink(copy_button)), (255, 0, 0))
            window.set_focus_visible(True); settle()
            self.assertTrue(one.has_css_class("asb-key-focus"))
            self.assertEqual(shown(), (0, 255, True, 255, True))
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
                for card in cards.values():
                    window.ensure_card_controls(card)
                settle()
                one, two = cards["s1"], cards["s2"]
                if view:  # Copy and its corner have no ink at rest, also with the check of a copy.
                    window.activate_action("win.copy-reference", asb.GLib.Variant("s", "s3")); settle()
                    rest = cards["s3"].asb_copy_button
                    self.assertTrue(rest.has_css_class("asb-copy-confirmed"))
                    self.assertEqual((self.ink(rest), self.ink(rest.get_parent()), self.ink(two.asb_copy_button)), (0, 0, 0))
                    self.hover_card(window, cards["s3"], True); settle()
                    self.assertEqual(self.ink(rest), 255)
                    if palette:  # Only the check uses the accent; the copy icon keeps the text color.
                        self.assertEqual(window.hex_color(rest.get_color()), palette["accent"])
                    self.hover_card(window, two, True)
                    two.asb_copy_button.set_state_flags(hover, False); settle()
                    self.assertEqual(self.ink(rest), 0)
                    if palette:
                        self.assertEqual(window.hex_color(two.asb_copy_button.get_color()), palette["text"])
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
        window.set_pending(True); settle()
        self.assertEqual(window.row_order, ["s2", "s5"])
        pill.set_active(True); settle()
        self.assertFalse(window.pending)
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
        window.set_pending(True); settle()
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
        window.set_archived(True); settle()
        self.assertTrue(bubble.get_visible())
        self.assert_accessible_label(pill, "Drawer only. The drawer has sessions.")
        window.search.set_text("no such session"); window.profiles = {"|claude-desktop-code"}; settle()
        self.assertEqual((bubble.get_visible(), window.row_order), (True, []))
        window.search.set_text(""); window.profiles = set(); pill.set_active(True); settle()
        self.assertEqual(window.row_order, ["s1", "s6"])
        window.set_archived(False); settle()
        self.assertEqual((bubble.get_visible(), window.row_order), (True, ["s1"]))
        self.assert_accessible_label(pill, "Drawer only. The drawer has sessions.")
        pill.set_active(False); settle()
        for width, wide in ((320, False), (700, True)):
            window.set_default_size(width, 400); settle(); window.check_geometry(); settle()
            self.assertEqual((window.get_width(), window.wide_controls), (width, wide))
            self.assertIs(pill.get_parent(), window.toolbar_strip)
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
        self.hover_card(window, busy, True); settle()
        self.assertFalse(busy.asb_read_button.get_visible())
        self.assertFalse(busy.asb_read_button.has_css_class("asb-discard-offer"))
        self.assertEqual(self.ink(busy.asb_dot), 0)
        self.hover_card(window, plain, True); settle()
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

        # The row panel: Mute comes right after the drawer slot and before Pin. Mute and Unmute close the panel, which covers the card.
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
        muted.emit("clicked"); self.drain()
        self.assertEqual(requests[-1][1], "/api/threads/other/mute")
        self.assertIsNone(window.context_menu)
        self.assertFalse(panel.get_visible())
        self.assertIs(window.get_focus(), other)
        requests[-1][2]({"changed": True, "threadId": "other", "thread": dict(other.asb_thread, muted=True)}, None); settle()
        self.assertTrue(other.asb_mute_glyph.get_visible() and other.asb_mute_glyph.get_mapped())
        self.assertIs(window.get_focus(), other)
        window.show_context(other); self.drain()
        unmute = window.context_menu.asb_actions["mute"]
        self.assertEqual((unmute.asb_label.get_label(), unmute.asb_icon.get_icon_name()), ("Unmute", "preferences-system-notifications-symbolic"))
        unmute.emit("clicked"); self.drain()
        self.assertEqual(requests[-1][1], "/api/threads/other/unmute")
        self.assertIsNone(window.context_menu)
        requests[-1][2]({"changed": True, "threadId": "other", "thread": dict(other.asb_thread, muted=False)}, None); settle()
        self.assertFalse(other.asb_mute_glyph.get_visible())
        self.assertEqual([request[1] for request in requests if request[1].startswith("/api/threads/")],
                         ["/api/threads/other/mute", "/api/threads/other/unmute"])
        # Another action keeps the panel open.
        window.show_context(other); self.drain()
        panel = window.context_menu
        panel.asb_actions["pin"].emit("clicked"); self.drain()
        self.assertEqual(requests[-1][1], "/api/threads/other/pin")
        self.assertIs(window.context_menu, panel)
        panel.popdown(); self.drain()
        # A muted Working row offers no Discard action.
        window.show_context(busy); self.drain()
        self.assertFalse(window.context_menu.asb_actions["discard"].get_visible())
        self.assertEqual(window.context_menu.asb_actions["mute"].asb_label.get_label(), "Unmute")
        window.context_menu.popdown(); self.drain()

    def test_the_mute_icon_has_the_color_and_the_ink_of_the_folder_name(self):
        # At 35% of the folder gray, the icon had about 1.9:1 on a black board, so a muted card looked unchanged.
        now = time.time() * 1000
        def row(identity, **extra):
            return {"id": identity, "provider": "codex", "providerLabel": "Codex", "title": "Summarize the open issues " + identity,
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "updatedAtMs": now - 60_000, "muted": True, **extra}
        rows = [row("read"), row("busy", state="working"), row("remote", remote=True, machineName="homeLP", surface="app", canOpen=False),
                row("limited", limitResetsAtMs=now + 3_600_000)]
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", {"generatedAtMs": now, "providers": [], "threads": rows},
                                       theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(720, 500)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.settle(window)
        cards = window.focus_widgets
        self.assertEqual([cards["read"].has_css_class("asb-idle-read"), cards["remote"].has_css_class("asb-view-only-quiet"),
                          cards["limited"].has_css_class("asb-limited"), cards["busy"].has_css_class("asb-idle-read")], [True, True, True, False])
        hex_color = lambda widget: asb.SwitchboardWindow.hex_color(widget.get_color())
        for custom in (None, {"background": "#000000", "text": "#ffffff", "accent": "#ffb900", "muted": "#bcbcbc", "divider": "#030303"}):
            window.set_palette(custom); self.settle(window)
            for identity in ("read", "busy", "remote", "limited"):
                with self.subTest(custom=bool(custom), card=identity):
                    glyph, folder = cards[identity].asb_mute_glyph, cards[identity].asb_folder
                    self.assertTrue(glyph.get_visible() and glyph.get_mapped())
                    self.assertEqual(hex_color(glyph), hex_color(folder))
                    # The thin lines of the icon get nearly the ink of the folder text: no extra dimming.
                    self.assertGreaterEqual(self.ink(glyph), .8 * self.ink(folder))

    def test_read_required_action_keeps_its_mark_and_offers_unread(self):
        def row(identity, order, **extra):
            return {"id": identity, "provider": "claude-desktop-code", "providerLabel": "Claude Desktop Code",
                    "title": "Approve the synthetic tool " + identity, "cwd": "/example/field-notes", "projectName": "field-notes",
                    "state": "waiting", "canOpen": True, "actionRequired": True, "updatedAtMs": NOW - order * 1000, **extra}
        waiting = dict(actionAttention=True, pending=True, pendingSource="user-action")
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [row("action", 1, **waiting), row("seen", 2, actionAttention=False)]}
        # The menu: Read for an unread action, the drawer, or a manual Unread; else Unread.
        self.assertEqual(asb.row_menu_actions(dashboard["threads"][0])[0], ("Read", "mark-read"))
        self.assertEqual(asb.row_menu_actions(dashboard["threads"][1])[0], ("Unread", "mark-unread"))
        for extra in ({"unread": True}, {"drawer": True}):
            self.assertEqual(asb.row_menu_actions({**dashboard["threads"][1], **extra})[0], ("Read", "mark-read"), extra)
        changed = {**dashboard["threads"][0], "actionAttention": False}
        self.assertNotEqual(asb.attention_signature(dashboard["threads"][0]), asb.attention_signature(changed))
        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(640, 560)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.3); window.check_geometry(); self.drain()
        self.settle(window)
        card = lambda identity: window.focus_widgets[identity]
        unread_text = "A user action is required in the original app. Mark read in ASB"
        read_text = "A user action is required in the original app"
        for identity in ("action", "seen"):
            self.assertTrue(card(identity).asb_dot.get_visible(), identity)
            self.assertEqual(asb.attention_indicator(card(identity).asb_thread), "question")
            window.show_context(card(identity)); self.drain()
            self.assertTrue(window.context_menu.asb_note.get_visible(), identity)
            self.assertEqual(window.context_menu.asb_actions["read"].asb_label.get_label(),
                             "Mark read" if identity == "action" else "Mark unread")
            window.context_menu.popdown(); self.drain()
        read = card("action").asb_read_button
        self.assertEqual((read.get_tooltip_text(), read.asb_action, read.has_css_class("asb-passive-indicator")),
                         (unread_text, "win.mark-read", False))
        seen = card("seen").asb_read_button
        self.assertEqual((seen.get_tooltip_text(), seen.asb_action, seen.has_css_class("asb-passive-indicator")), (read_text, None, True))
        # Read in the corner sends mark-read, and the answer turns the card into a read card that keeps its mark.
        read.emit("clicked")
        self.assertEqual(requests[-1][1], "/api/threads/action/mark-read")
        requests[-1][2]({"changed": True, "threadId": "action", "thread": {**card("action").asb_thread, "actionAttention": False,
                                                                          "pending": False, "pendingSource": ""}}, None)
        self.settle(window)
        read = card("action").asb_read_button
        self.assertEqual((read.get_tooltip_text(), read.asb_action, read.has_css_class("asb-passive-indicator")), (read_text, None, True))
        self.assertTrue(card("action").asb_dot.get_visible())
        self.assertEqual(card("action").asb_thread["state"], "waiting")
        self.assertEqual(asb.row_menu_actions(card("action").asb_thread)[0], ("Unread", "mark-unread"))

    def test_idle_card_offers_discard_for_the_next_task_and_sends_next(self):
        def row(identity, order, **extra):
            return {"id": identity, "provider": "codex", "providerLabel": "Codex", "title": "Summarize the open issues " + identity,
                    "cwd": "/example/field-notes", "projectName": "field-notes", "state": "idle", "canOpen": True,
                    "updatedAtMs": NOW - order * 1000, **extra}
        unread = dict(pending=True, unread=True, completionAttention=True, pendingSource="observed-completion")
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
            row("idle", 1), row("armed", 2, discardResult=True), row("unread", 3, **unread), row("stopped", 4, lastOutcome="stopped"),
            row("muted", 5, muted=True), row("work", 6, state="working", workingSinceMs=NOW - 5000)]}
        requests = []
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
                                    (asb, "request_async", lambda *args: requests.append(args))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(640, 560)
        window.present(); window.set_focus(None); self.drain(.3)
        window.view_filter.set_selected(1); self.drain(.3); window.check_geometry(); self.drain()
        settle = lambda: self.settle(window)
        settle()
        card = lambda identity: window.focus_widgets[identity]
        sent = lambda: [(request[1], request[5]) for request in requests]
        def answer(identity, **changes):
            requests[-1][2]({"changed": True, "threadId": identity, "thread": {**card(identity).asb_thread, **changes}}, None)
            settle()

        # At rest only the armed card shows a ring; on hover an Idle card with no mark shows the dashed offer in the Read slot.
        self.assertEqual(self.ink(card("idle").asb_read_button), 0)
        self.hover_card(window, card("idle"), True); settle()
        read = card("idle").asb_read_button
        self.assertTrue(read.get_visible() and read.has_css_class("asb-discard-offer") and read.has_css_class("asb-discard-button"))
        self.assertGreater(self.ink(read), 0)
        self.assertEqual(read.get_tooltip_text(), "Discard next result: go to read Idle when the next task ends")
        self.hover_card(window, card("idle"), False); settle()
        self.assertEqual(self.ink(card("idle").asb_read_button), 0)
        armed = card("armed")
        self.assertTrue(armed.asb_dot.get_visible() and armed.asb_dot.has_css_class("asb-discard"))
        self.assertFalse(armed.asb_read_button.has_css_class("asb-discard-offer"))
        self.assertGreater(self.ink(armed.asb_read_button), 0)
        self.assertEqual(armed.asb_read_button.get_tooltip_text(), "Keep result: show the dot when the next task ends")
        self.assertIn("Discard is on for the next task.", armed.asb_tooltip)
        self.assertIn(" Discard is on for the next task.", armed.asb_accessible_label)
        self.assertNotIn("Discard", card("idle").asb_accessible_label)
        # A mark, Mute, and a Working card without an arm keep their own look: no offer on a card with a mark or Mute.
        for identity in ("unread", "stopped", "muted"):
            self.hover_card(window, card(identity), True); settle()
            for name in ("asb-discard-offer", "asb-discard-button"):
                self.assertFalse(card(identity).asb_read_button.has_css_class(name), identity)
            self.hover_card(window, card(identity), False); settle()
        self.assertFalse(card("muted").asb_read_button.get_visible())
        self.assertTrue(card("work").asb_read_button.has_css_class("asb-discard-offer"))

        # The row panel names the action for the next task on an Idle card, and keeps the Working texts.
        for identity, label in (("idle", "Discard next result"), ("armed", "Keep next result"), ("work", "Discard result")):
            window.show_context(card(identity)); self.drain()
            action = window.context_menu.asb_actions["discard"]
            self.assertEqual((action.get_visible(), action.asb_label.get_label()), (True, label), identity)
            window.context_menu.popdown(); self.drain()
        for identity in ("unread", "stopped", "muted"):
            window.show_context(card(identity)); self.drain()
            self.assertFalse(window.context_menu.asb_actions["discard"].get_visible(), identity)
            window.context_menu.popdown(); self.drain()

        # An Idle card sends {"next": true}, and Keep sends none. A Working card sends none for Discard.
        del requests[:]
        card("idle").asb_read_button.emit("clicked")
        self.assertEqual(sent(), [("/api/threads/idle/discard-result", {"next": True})])
        answer("idle", discardResult=True)
        read = card("idle").asb_read_button
        self.assertTrue(card("idle").asb_dot.has_css_class("asb-discard") and not read.has_css_class("asb-discard-offer"))
        self.assertGreater(self.ink(read), 0)
        del requests[:]
        read.emit("clicked")
        self.assertEqual(sent(), [("/api/threads/idle/keep-result", None)])
        answer("idle", discardResult=False)
        self.assertTrue(card("idle").asb_read_button.has_css_class("asb-discard-offer"))
        del requests[:]
        window.show_context(card("idle")); self.drain()
        window.context_menu.asb_actions["discard"].emit("clicked")
        self.assertEqual(sent(), [("/api/threads/idle/discard-result", {"next": True})])
        answer("idle", discardResult=True)
        self.assertEqual(window.context_menu.asb_actions["discard"].asb_label.get_label(), "Keep next result")
        window.context_menu.popdown(); self.drain()
        del requests[:]
        card("work").asb_read_button.emit("clicked")
        self.assertEqual(sent(), [("/api/threads/work/discard-result", None)])
        requests[-1][2](None, "Cannot change this session."); settle()

        # Compact shows only the passive ring of an armed Idle card.
        window.view_filter.set_selected(0); self.drain(.3); settle()
        self.assertEqual({identity: card(identity).asb_dot.get_visible() and card(identity).asb_dot.has_css_class("asb-discard")
                          for identity in ("idle", "armed", "unread", "stopped", "muted", "work")},
                         {"idle": True, "armed": True, "unread": False, "stopped": False, "muted": False, "work": False})
        window.view_filter.set_selected(1); self.drain(.3); settle()

        # The check after a Read keeps the slot, and the offer comes back when the check ends.
        del requests[:]
        card("unread").asb_read_button.emit("clicked")
        self.assertEqual(sent(), [("/api/threads/unread/mark-read", None)])
        answer("unread", unread=False, pending=False, completionAttention=False, pendingSource="")
        read = card("unread").asb_read_button
        self.assertTrue(read.has_css_class("asb-read-confirmed"))
        self.assertIsNone(read.asb_action)
        self.assertFalse(read.has_css_class("asb-discard-button"))
        self.drain(1.9); settle()
        read = card("unread").asb_read_button
        self.assertFalse(read.has_css_class("asb-read-confirmed"))
        self.assertEqual(read.asb_action, "win.discard-result")
        self.assertTrue(read.has_css_class("asb-discard-offer"))

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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
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

    def test_message_courier_waits_for_card_motion_and_uses_final_icon_centers(self):
        threads = [{"id": f"m{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Sample session {n}",
                    "cwd": "/example/notes", "projectName": "notes", "state": "working" if n == 1 else "idle",
                    "canOpen": True, "updatedAtMs": NOW - n * 60_000, "workingSinceMs": NOW - 60_000}
                   for n in (1, 2, 3)]
        dashboard = {"generatedAtMs": NOW, "providers": [], "threads": threads, "messages": []}
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard, theme_path=False, layout_path=False)
        self.addCleanup(window.close)
        window.set_default_size(700, 420)
        window.present()
        self.settle(window)
        strip = window.list_body
        self.assertEqual(window.row_order[:2], ["m1", "m2"])
        samples, starts = [], []
        start_messages, start_flight = window.start_messages, strip.start_flight
        def observed_messages(play):
            result = start_messages(play)
            samples.append((bool(strip.motion), len(strip.flights)))
            return result
        def observed_flight(source, target, color, ends):
            starts.append((bool(strip.motion), ends))
            start_flight(source, target, color, ends)
            for animation in strip.flights[-1]["animations"]:
                animation.pause()
        with patch.object(window, "start_messages", observed_messages), patch.object(strip, "start_flight", observed_flight):
            changed = copy.deepcopy(dashboard)
            changed["threads"][1].update(state="working", workingSinceMs=NOW + 1000)
            changed["messages"] = [{"from": "m1", "to": "m2", "atMs": time.time() * 1000}]
            window.apply_dashboard(changed, None)
            deadline = time.monotonic() + 6
            saw_motion = False
            while time.monotonic() < deadline and (not starts or strip.motion):
                self.drain(.01)
                if strip.motion:
                    saw_motion = True
                    self.assertEqual(strip.flights, [])
            self.assertTrue(saw_motion)
            self.assertIn((True, 0), samples)
            self.assertEqual(len(starts), 1)
            self.assertFalse(starts[0][0])
            self.assertEqual(len(strip.flights), 1)
            self.assertEqual(window.row_order[:2], ["m2", "m1"])
            flight = strip.flights[0]
            ends = strip.message_ends(flight)
            self.assertEqual(starts[0][1], ends)
            centers = []
            for row in flight["rows"]:
                found, bounds = row.asb_mark.compute_bounds(strip)
                self.assertTrue(found)
                centers.append((bounds.origin.x + bounds.size.width / 2, bounds.origin.y + bounds.size.height / 2))
            self.assertEqual([point[:2] for point in ends], centers)
            start, end = centers
            self.assertLess(end[1], start[1])
            ys = [start[1]]
            for progress in (.25, .5, .75):
                strip.advance_flight(flight, "flight", progress)
                self.drain(.02)
                self.assertEqual(strip.message_ends(flight), ends)
                ys.append(asb.bezier_point(start, asb.message_control(start, end), end,
                                           asb.ease_in_out_cubic(flight["flight"]))[1])
            ys.append(end[1])
            self.assertTrue(all(before > after for before, after in zip(ys, ys[1:])), ys)

    def test_message_courier_out_of_view_edges(self):
        threads = [{"id": f"e{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Sample row {n}", "cwd": "/example/notes",
                    "projectName": "notes", "state": "idle", "canOpen": True, "updatedAtMs": NOW - n * 60_000} for n in range(80)]
        at = time.time() * 1000
        def board(*messages):
            return {"generatedAtMs": NOW, "providers": [], "threads": threads,
                    "messages": [{"from": source, "to": target, "atMs": at + index} for index, (source, target) in enumerate(messages)]}
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
        for card in window.focus_widgets.values():
            window.ensure_card_controls(card)
        self.drain()
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
            self.assertGreater(self.ink(two.asb_copy_button), 0)  # The kind glyph is present (hollow link peaks below 255).
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
            window.ensure_card_controls(card)
        self.drain()
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real pointer movement needs xdotool and DISPLAY=:9 or :10.")
    def test_static_hover_follows_a_still_pointer_after_cards_move(self):
        from gi.repository import GdkX11

        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        settings = asb.Gtk.Settings.get_default()
        self.addCleanup(settings.set_property, "gtk-enable-animations", settings.get_property("gtk-enable-animations"))
        def xdo(*args):
            return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True).stdout
        x, y = (line.split("=")[1] for line in xdo("getmouselocation", "--shell").splitlines()[:2])
        self.addCleanup(xdo, "mousemove", x, y)
        for view in (0, 1):
            for animated in (False, True):
                with self.subTest(view=view, animated=animated):
                    settings.set_property("gtk-enable-animations", animated)
                    xdo("mousemove", 1500, 950)
                    dashboard = {"generatedAtMs": NOW, "providers": [], "threads": [
                        {"id": f"s{n}", "provider": "codex", "providerLabel": "Codex", "title": f"Review sample {n}",
                         "state": "idle", "canOpen": True, "updatedAtMs": NOW - n * 60_000} for n in range(1, 5)]}
                    window = asb.SwitchboardWindow(self.application, "http://127.0.0.1:1", dashboard,
                                                  theme_path=False, layout_path=False)
                    window.set_default_size(700, 600)
                    window.present(); self.drain(.3)
                    window.view_filter.set_selected(view); self.drain(.3)
                    cards = window.focus_widgets.copy()
                    def move(card=None):
                        left, top = window.get_surface_transform()
                        px, py = 10, 10
                        if card:
                            found, bounds = card.asb_title_label.compute_bounds(window)
                            self.assertTrue(found)
                            px, py = bounds.origin.x + bounds.size.width / 2, bounds.origin.y + bounds.size.height / 2
                        xdo("mousemove", "--window", GdkX11.X11Surface.get_xid(window.get_surface()), int(px + left), int(py + top))
                        self.drain(.1)
                    hovered = lambda: [identity for identity, card in cards.items() if card.has_css_class("asb-hovered")]
                    move(cards["s1"])
                    self.assertEqual(hovered(), ["s1"])
                    dashboard["threads"][-1]["pinned"] = True
                    window.render(); self.drain(.08)
                    self.assertTrue(window.pointer_on(cards["s4"]))
                    self.assertEqual(hovered(), ["s4"])
                    # An enter must clear the layout hover even when GTK sends no leave for that card.
                    self.hover_card(window, cards["s2"], True)
                    self.assertEqual(hovered(), ["s2"])
                    move(cards["s2"])
                    self.assertEqual(hovered(), ["s2"])
                    # Filtering repacks the board with no glide and clears a card that is no longer under the pointer.
                    move()
                    window.search.set_text("sample 3"); self.drain(.4)
                    self.assertEqual(hovered(), [])
                    window.close(); self.drain(.03)

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
        self.assertFalse(hasattr(cards["s2"], "asb_copy_button"))
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
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False)),
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
        more = window.card_for(asb.MORE_ID)
        def check_limited():
            self.assertEqual(window.row_order, full[:100] + [asb.MORE_ID])
            self.assertIs(window.card_for(asb.MORE_ID), more)
            self.assertNotIn("all", window.filter_chip_widgets)
            columns = [listing for listing in window.list_columns if listing.get_parent()]
            for number, listing in enumerate(columns):
                cards, card = [], listing.get_row_at_index(0)
                while card is not None:
                    cards.append(card.asb_focus_key)
                    card = listing.get_row_at_index(len(cards))
                self.assertEqual(cards, window.row_order[number * window.capacity:(number + 1) * window.capacity]
                                 if number in window.filled_columns else [])
        def check_all(first_focus=None):
            self.assertTrue(window.show_all_cards)
            self.assertEqual(window.row_order, full)
            self.assertNotIn(asb.MORE_ID, window.focus_widgets)
            self.assertIs(window.row_cache[asb.MORE_ID], more)
            chip = window.filter_chip_widgets["all"]
            self.assertTrue(chip[0].get_visible() and window.toolbar_scroll.get_visible())
            self.assertEqual((chip[1].get_label(), chip[0].get_tooltip_text()), ("All cards", "Show only the first 100 cards"))
            if first_focus:
                self.assertEqual(window.focus_key(), first_focus)
                self.assert_focus_visible(window, first_focus)
        def reset():
            if "all" in window.filter_chip_widgets:
                window.clear_filter_chip(window.filter_chip_widgets["all"][0], "all")
            else:
                window.show_all_cards = False
                window.filter_changed()
            self.drain(.3)
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
        self.assertIs(window.card_for(asb.MORE_ID), more)
        check_limited()
        self.assertEqual((more.asb_folder.get_label(), more.asb_age_label.get_label(), more.asb_state_label.get_label(),
                          more.asb_title_label.get_label(), more.asb_where_label.get_visible()),
                         ("After the first 100", "from " + age, "Show all", "More sessions", False))
        glyph = more.asb_more_glyph
        self.assertEqual((glyph.get_icon_name(), glyph.get_pixel_size(), glyph.has_css_class("dim-label")), ("go-next-symbolic", 11, True))
        self.assertIs(more.asb_state_label.get_next_sibling(), glyph)
        self.assertFalse(more.asb_actions.get_visible())
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
        if "all" in window.filter_chip_widgets:
            window.clear_filter_chip(window.filter_chip_widgets["all"][0], "all")
        else:
            window.show_all_cards = False
            window.filter_changed()
        window.open_row(None, more); self.drain(.3)
        self.assertTrue(window.show_all_cards)
        setting.set_selected(0); self.drain(.3)
        self.assertEqual((window.card_limit, window.show_all_cards, asb.read_layout(layout_path)["cardLimit"]), (50, False, 50))
        self.assertEqual(window.row_order, full[:50] + [asb.MORE_ID])
        self.assertIs(window.card_for(asb.MORE_ID), more)
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

    def test_waiting_has_no_palette_color_override(self):
        window = self.snapshot_window()
        for palette in (None, asb.validate_theme(CUSTOM)):
            with self.subTest(palette=palette):
                window.set_palette(palette)
                self.assertNotIn(".asb-waiting", window.css.to_string())


class ActivityFixture:
    """The GTK fixture of WidgetCheck for the Messages and Usage window checks."""
    @classmethod
    def setUpClass(cls):
        WidgetCheck.setUpClass.__func__(cls)

    THEME = {"background": "#101820", "text": "#f0f0f0", "accent": "#3080c0", "muted": "#a0a0a0", "divider": "#405060"}

    drain = WidgetCheck.drain
    capture = WidgetCheck.capture
    assert_accessible_label = WidgetCheck.assert_accessible_label
    close_windows = WidgetCheck.close_windows

    def pixels(self, widget):
        """The unpremultiplied RGBA bytes of one widget, rendered with the Cairo renderer, and the row stride."""
        snapshot = asb.Gtk.Snapshot()
        asb.Gtk.WidgetPaintable.new(widget).snapshot(snapshot, widget.get_width(), widget.get_height())
        renderer = asb.Gsk.CairoRenderer()
        renderer.realize(None)
        viewport = asb.Graphene.Rect().init(0, 0, widget.get_width(), widget.get_height())
        downloader = asb.Gdk.TextureDownloader.new(renderer.render_texture(snapshot.to_node(), viewport))
        downloader.set_format(asb.Gdk.MemoryFormat.R8G8B8A8)
        data, stride = downloader.download_bytes()
        renderer.unrealize()
        return data.get_data(), stride

    def assert_pixel(self, widget, x, y, color):
        data, stride = self.pixels(widget)
        offset = int(y) * stride + int(x) * 4
        self.assertEqual("#" + data[offset:offset + 3].hex(), color)

    def check_theme_header(self):
        warnings = len(GTK_WARNINGS)
        asb.THEME_PATH.write_text(json.dumps({"mode": "custom", "colors": self.THEME}))
        # The rendering fixture accent is below the theme editor's contrast limit.
        with patch.object(asb, "validate_theme", return_value=self.THEME):
            window = self.window()
        self.assertTrue(window.has_css_class("asb-custom"))
        spacer = window.toolbar_start.get_next_sibling()
        found, bounds = spacer.compute_bounds(window)
        self.assertTrue(found)
        self.assert_pixel(window, bounds.get_x() + bounds.get_width() // 2, bounds.get_y() + bounds.get_height() // 2, self.THEME["background"])
        # A checked linked toggle of the row shows the accent.
        if hasattr(window, "metric_buttons"):
            found, bounds = window.metric_buttons[window.metric].compute_bounds(window)
            self.assertTrue(found)
            self.assert_pixel(window, bounds.get_x() + 7, bounds.get_y() + bounds.get_height() // 2, self.THEME["accent"])
        window.set_palette(None)
        self.drain(.2)
        self.assertFalse(window.has_css_class("asb-custom"))
        asb.THEME_PATH.unlink()
        native = self.window()
        self.assertFalse(native.has_css_class("asb-custom"))
        self.assertEqual(GTK_WARNINGS[warnings:], [])


@unittest.skipUnless(asb.Gtk.init_check(), "A GTK display is not available.")
class UsageWindowCheck(ActivityFixture, unittest.TestCase):
    REPLIES = json.loads((Path(__file__).parent / "fixtures" / "activity" / "usage-sample.json").read_text())
    ALL = {"desk", "laptop", "studio"}

    def setUp(self):
        saved = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()

        def restore():
            if saved is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = saved
            time.tzset()
        self.addCleanup(restore)
        directory = tempfile.TemporaryDirectory(prefix="asb-usage-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        patcher = patch.object(asb, "THEME_PATH", self.directory / "theme.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.close_windows)
        self.warnings = len(GTK_WARNINGS)

    def window(self, replies=None, size=(948, 760)):
        """A shown Usage window that reads the sample replies (or replies[period]) and records its routes."""
        replies, routes = replies or self.REPLIES, []

        def fetch(route):
            routes.append(route)
            return copy.deepcopy(replies[route.rsplit("=", 1)[1]])
        window = asb.UsageWindow(self.application, "http://127.0.0.1:1", fetch=fetch)
        window.routes = routes
        window.set_default_size(*size)
        window.present()
        self.drain(.1)
        window.refresh()
        self.drain(.25)
        return window

    @staticmethod
    def children(widget):
        child, found = widget.get_first_child(), []
        while child:
            found.append(child)
            child = child.get_next_sibling()
        return found

    def labels(self, widget):
        """Every label text under widget, in order."""
        found = [widget.get_label()] if isinstance(widget, asb.Gtk.Label) else []
        for child in self.children(widget):
            found += self.labels(child)
        return found

    def figures(self, window):
        return {self.labels(figure)[0]: self.labels(figure)[1] for figure in self.children(window.figures)}

    def model_rows(self, window):
        cells = [child for child in self.children(window.models) if hasattr(child, "asb_model")]
        rows = []
        for cell in cells:
            if not rows or rows[-1][0] != cell.asb_model:
                rows.append((cell.asb_model, []))
            rows[-1][1].append(cell)
        return rows

    def assert_no_new_warnings(self):
        self.assertEqual(GTK_WARNINGS[self.warnings:], [])

    def test_toolbar(self):
        window = self.window()
        self.assertEqual((window.get_title(), window.get_default_size(), window.KIND), ("Usage", (948, 760), "usage"))
        self.assertIs(asb.ACTIVITY_WINDOW_CLASSES["usage"], asb.UsageWindow)
        self.assertEqual(window.routes, ["/api/activity/usage?period=30d"])
        menu = window.period_menu
        self.assertEqual([menu.get_model().get_string(index) for index in range(menu.get_model().get_n_items())],
                         ["24 hours", "7 days", "30 days", "90 days", "All time"])
        self.assertEqual(menu.get_selected(), 2)
        self.assertEqual([(button.get_label(), button.get_active()) for button in window.metric_buttons.values()], [("Cost", True), ("Tokens", False)])
        self.assertTrue(window.metric_buttons["cost"].get_parent().has_css_class("linked"))
        self.assertIs(window.metric_buttons["cost"].get_parent().get_parent(), window.toolbar_start)
        self.assertIs(window.machine_filter.get_parent(), window.toolbar_end)
        self.assertIs(window.chips.get_ancestor(asb.Gtk.Popover), window.machine_filter.get_popover())
        self.assertEqual(window.chips.get_orientation(), asb.Gtk.Orientation.VERTICAL)
        self.assertTrue(all(chip.get_halign() == asb.Gtk.Align.FILL for chip in window.chip_buttons.values()))
        self.assert_accessible_label(window.machine_filter, "Machine filter")
        chips = window.chip_buttons
        self.assertEqual(list(chips), ["desk", "laptop", "studio"])
        self.assertEqual([self.labels(chip) for chip in chips.values()], [["Desk"], ["Laptop"], ["Studio", "Offline"]])
        self.assertTrue(all(chip.get_active() and chip.get_sensitive() for chip in chips.values()))
        self.assertEqual([chip.get_tooltip_text() for chip in chips.values()], ["Local", "Connected", "Last report Oct 25, 14:30"])
        for chip, expected in zip(chips.values(), ("Desk, Local", "Laptop, Connected", "Studio, Offline")):
            self.assert_accessible_label(chip, expected)
        dot = chips["studio"].get_child().get_first_child()
        self.assertTrue(dot.has_css_class("asb-activity-hue-2") and dot.has_css_class("asb-activity-hollow"))
        self.assertEqual(window.round.get_tooltip_text(), "Prices: LiteLLM, Oct 26")
        self.assertFalse(hasattr(window, "prices_label"))
        self.assertFalse(any(text.startswith("Prices:") for text in self.labels(window.toolbar)))
        self.assertFalse(window.scan_label.get_visible())
        self.assert_no_new_warnings()

    def test_usage_popovers_close_when_the_window_stops_being_active(self):
        window = self.window()
        self.assertTrue(window.machine_filter.get_visible())

        def popovers(widget):
            child, found = widget.get_first_child(), []
            while child:
                found += ([child] if isinstance(child, asb.Gtk.Popover) else []) + popovers(child)
                child = child.get_next_sibling()
            return found
        for name, popup in (("period", lambda: window.period_menu.activate()), ("machines", window.machine_filter.popup)):
            with self.subTest(name):
                popup(); self.drain(.4)
                shown = [popover for popover in popovers(window) if popover.get_visible()]
                self.assertEqual(len(shown), 1)
                with patch.object(window, "is_active", return_value=False):
                    window.notify("is-active")
                    self.drain(.2)
                self.assertFalse(shown[0].get_visible())

    def test_usage_folds_filter_popover_and_short_note(self):
        replies = copy.deepcopy(self.REPLIES)
        for record in replies["30d"]["records"]:
            if record["model"] == "gpt-6.1-mini":
                record["cost"] = None
        window = self.window(replies)
        folds = (window.machine_fold, window.app_fold, window.maker_fold)
        self.assertEqual([fold.get_expanded() for fold in folds], [True, False, False])
        self.assertEqual([fold.get_label_widget().get_label() for fold in folds], ["Machines", "Apps", "Providers"])
        self.assertEqual([fold.get_child() for fold in folds], [window.machine_rows, window.app_rows, window.maker_rows])
        self.assertEqual([fold.get_margin_top() for fold in folds], [0, 10, 10])
        self.assertTrue(all(fold.has_css_class("asb-usage-fold") for fold in folds))
        self.assertIs(window.maker_fold.get_next_sibling(), window.note)
        window.app_fold.set_expanded(True)
        replies["30d"]["records"][0]["tokens"]["output"] += 1000
        window.refresh()
        self.drain(.1)
        self.assertEqual(window.routes, ["/api/activity/usage?period=30d"] * 2)
        self.assertEqual([fold.get_expanded() for fold in folds], [True, True, False])
        # The note: short, with the model names in its tooltip.
        view = asb.usage_view(window.data, self.ALL, "cost")
        self.assertEqual(window.note.get_label(), f"2 unpriced models: {asb.format_tokens(view['unpriced_tokens'])} tokens not in the cost.")
        self.assertEqual(window.note.get_tooltip_text(), ", ".join(view["unpriced_models"]))
        self.assertEqual(sorted(view["unpriced_models"]), ["gpt-6.1-mini", "mimo-v2.6-pro"])
        self.assertEqual(window.round.get_tooltip_text(), "Prices: LiteLLM, Oct 26")
        # The machine filter: a popover with one chip per machine.
        button = window.machine_filter
        self.assertTrue(button.get_visible())
        self.assertEqual((button.get_tooltip_text(), button.has_css_class("asb-usage-filtered")), ("Machines", False))
        self.assertTrue(button.has_css_class("flat") and button.has_css_class("asb-usage-filter"))
        self.assertEqual(button.get_child().get_gicon().get_file().get_basename(), "asb-filter-symbolic.svg")
        button.popup()
        self.drain(.2)
        self.assertTrue(button.get_popover().get_visible())
        self.assertEqual(self.labels(button.get_popover())[0], "Machines")
        window.chip_buttons["laptop"].set_active(False)
        self.drain(.05)
        self.assertEqual(window.machines_on(), {"desk", "studio"})
        self.assertEqual((button.get_tooltip_text(), button.has_css_class("asb-usage-filtered")), ("Machines: 2 of 3 shown", True))
        self.assertIn(".asb-usage-filtered image", window.css.to_string())
        window.chip_buttons["laptop"].set_active(True)
        self.drain(.05)
        self.assertEqual((button.get_tooltip_text(), button.has_css_class("asb-usage-filtered")), ("Machines", False))
        button.popdown()
        one = {key: dict(reply, machines=reply["machines"][:1],
                         records=[record for record in reply["records"] if record["machineId"] == reply["machines"][0]["machineId"]])
               for key, reply in self.REPLIES.items()}
        self.assertFalse(self.window(one).machine_filter.get_visible())
        self.assert_no_new_warnings()

    def test_overview_rows_and_note(self):
        window = self.window()
        view = asb.usage_view(self.REPLIES["30d"], self.ALL, "cost")
        self.assertEqual(window.round.center(), (asb.format_cost(view["total"]), "at API prices"))
        self.assertEqual(window.round.center(), ("$2,343.50", "at API prices"))
        self.assert_accessible_label(window.round, "Usage by machine and app")
        self.assertEqual(window.round.arcs, asb.usage_round_arcs(view, self.REPLIES["30d"]["machines"], "cost"))
        rows = self.children(window.machine_rows)
        self.assertEqual([row.asb_machine for row in rows], ["desk", "laptop", "studio"])
        self.assertEqual([self.labels(row) for row in rows], [
            ["Desk", "Local", "$1,473.15", "62.9%"], ["Laptop", "Connected", "$622.85", "26.6%"],
            ["Studio", "Offline · last report Oct 25, 14:30", "$247.49", "10.6%"]])
        self.assertEqual([self.labels(row) for row in self.children(window.app_rows)], [
            ["Codex", "$689.81", "29.4%"], ["Claude Code", "$1,573.32", "67.1%"], ["OpenCode", "$80.37", "3.4%"]])
        bar = self.children(rows[0])[1]
        self.assertAlmostEqual(bar.fraction, view["machines"][0]["share"])
        # Desk's OpenCode model is unpriced: no OpenCode segment under Cost.
        self.assertEqual([color for _value, color in bar.segments], ["#c9ccd1", "#d97757"])
        self.assertTrue(window.note.get_visible())
        self.assertEqual(window.note.get_label(), "1 unpriced model: 144.2M tokens not in the cost.")
        self.assertEqual(window.note.get_tooltip_text(), "mimo-v2.6-pro")
        found, round_bounds = window.round.compute_bounds(window)
        self.assertTrue(found)
        self.assertEqual((round_bounds.get_width(), round_bounds.get_height()), (320, 320))
        found, side = rows[0].compute_bounds(window)
        self.assertGreater(side.get_x(), round_bounds.get_x() + 320)
        self.assertEqual(self.figures(window), {"Processed tokens": "3.33B", "Cached input": "2.95B", "Uncached input": "310.1M",
                                                "Output": "68.4M", "Cache savings": "$5,916.10"})
        self.assert_no_new_warnings()

    def test_all_time_month_chart_and_empty_state(self):
        window = self.window()
        window.set_period("all")
        self.drain(.1)
        self.assertEqual(window.routes[-1], "/api/activity/usage?period=all")
        self.assertEqual(window.chart_title.get_label(), "Monthly cost")
        self.assertEqual((len(window.chart.bars), window.chart.buckets["unit"]), (4, "month"))
        self.assertEqual(window.chart.full_label(3), "October 2026")
        window.set_metric("tokens")
        self.assertEqual(window.chart_title.get_label(), "Monthly tokens")
        empty = {key: dict(reply, records=[]) for key, reply in self.REPLIES.items()}
        window = self.window(empty)
        window.set_period("all")
        self.drain(.1)
        self.assertTrue(window.empty_label.get_visible())
        self.assertFalse(window.scroll.get_visible())
        self.assertEqual(window.empty_label.get_label(), "No usage yet.")
        self.assert_no_new_warnings()

    def test_the_one_row_fits_at_every_width(self):
        for size in ((948, 760), (600, 900), (420, 900)):
            with self.subTest(size=size):
                window = self.window(size=size)
                self.assertEqual(window.get_width(), size[0])
                _minimum, natural, _base, _natural_base = window.toolbar.measure(asb.Gtk.Orientation.HORIZONTAL, -1)
                self.assertLessEqual(natural, size[0])
                for widget in (window.period_menu, *window.metric_buttons.values(), window.machine_filter, window.window_controls):
                    found, bounds = widget.compute_bounds(window)
                    self.assertTrue(found)
                    self.assertGreater(bounds.get_width(), 0)
                    self.assertGreaterEqual(bounds.get_x(), 0)
                    self.assertLessEqual(bounds.get_x() + bounds.get_width(), size[0])
                for button in window.metric_buttons.values():
                    self.assertFalse(button.get_child().get_layout().is_ellipsized())
        self.assert_no_new_warnings()

    def test_provider_heading_rows_and_unpriced_value(self):
        window = self.window()
        side = window.maker_fold.get_parent()
        self.assertEqual([child.get_label_widget().get_label() for child in self.children(side) if isinstance(child, asb.Gtk.Expander)],
                         ["Machines", "Apps", "Providers"])
        heading = window.maker_fold.get_label_widget()
        self.assertEqual((window.maker_fold.get_margin_top(), heading.get_margin_bottom()), (10, 0))
        self.assertTrue(heading.has_css_class("asb-usage-heading"))
        rows = self.children(window.maker_rows)
        self.assertEqual([row.asb_maker for row in rows], ["Anthropic", "OpenAI", "Xiaomi MiMo"])
        view = asb.usage_view(self.REPLIES["30d"], self.ALL, "cost")
        for row, maker in zip(rows, view["makers"]):
            self.assertEqual(self.labels(row), [maker["label"], asb.format_cost(maker["value"]),
                                               "" if maker["share"] is None else asb.format_share(maker["share"])])
            who, bar, value, share = self.children(row)
            self.assertEqual(len(self.children(who.get_child())), 1)
            self.assertEqual(bar.segments, [] if maker["value"] is None else [(maker["value"], "#8c929a")])
        self.assertTrue(value.has_css_class("asb-dim"))
        self.assertTrue(value.has_css_class("asb-usage-value"))
        self.assertEqual(share.get_label(), "")
        window.set_metric("tokens")
        mimo = next(row for row in self.children(window.maker_rows) if row.asb_maker == "Xiaomi MiMo")
        maker = next(row for row in asb.usage_view(self.REPLIES["30d"], self.ALL, "tokens")["makers"] if row["id"] == "Xiaomi MiMo")
        self.assertEqual(self.labels(mimo), ["Xiaomi MiMo", asb.format_tokens(maker["tokens"]), asb.format_share(maker["share"])])
        self.assertFalse(self.children(mimo)[2].has_css_class("asb-dim"))
        self.assert_no_new_warnings()

    def test_new_usage_app_rows_series_and_model_icons(self):
        replies = copy.deepcopy(self.REPLIES)
        for reply in replies.values():
            template = reply["records"][0]
            reply["records"] += [dict(copy.deepcopy(template), app=app, model=model, maker=maker)
                                 for app, model, maker in (("grok", "grok-4", "xAI"), ("antigravity", "gemini-3", "Google"),
                                                           ("cursor", "unknown", "Other"))]
        window = self.window(replies)
        rows = self.children(window.app_rows)
        self.assertEqual([row.asb_app for row in rows], ["codex", "claude", "opencode", "antigravity", "grok", ""])
        grok = next(row for row in rows if row.asb_app == "grok")
        who = self.children(grok)[0].get_child()
        self.assertEqual(self.labels(who), ["Grok"])
        self.assertEqual(who.get_first_child().get_gicon().get_file().get_basename(), "asb-terminal-symbolic.svg")
        self.assertEqual([key for key, _label, _color in window.chart.series], ["codex", "claude", "opencode", "antigravity", "grok", ""])
        self.assertNotIn("pi", [key for key, _label, _color in window.chart.series])
        for model, cells in self.model_rows(window):
            if model[1] in ("grok", "antigravity", ""):
                app = cells[1]
                self.assertEqual(self.labels(app), [asb.ACTIVITY_APP_LABELS[model[1]]])
                self.assertEqual(app.get_first_child().get_gicon().get_file().get_basename(), asb.ACTIVITY_APP_ICONS[model[1]] + ".svg")
        window.data["records"].append(dict(copy.deepcopy(replies["30d"]["records"][0]), app="pi", model="pi-model"))
        window.render_view()
        self.assertEqual([key for key, _label, _color in window.chart.series], ["codex", "claude", "opencode", "antigravity", "grok", "pi", ""])
        pi = next(cells[1] for model, cells in self.model_rows(window) if model[1] == "pi")
        self.assertEqual(self.labels(pi), ["Pi"])
        self.assertEqual(pi.get_first_child().get_gicon().get_file().get_basename(), "asb-terminal-symbolic.svg")
        self.assert_no_new_warnings()

    def test_chart_bars_period_and_metric(self):
        window = self.window()
        chart = window.chart
        self.assert_accessible_label(chart, "Usage over time")
        self.assertEqual(chart.get_accessible_role(), asb.Gtk.AccessibleRole.IMG)
        self.assertEqual((len(chart.bars), window.chart_title.get_label(), chart.get_height()), (30, "Daily cost", 242))
        self.assertEqual(chart.axis, ["$50", "$100", "$150"])
        self.assertEqual([key for key, _label, _color in chart.series], ["codex", "claude", "opencode"])
        self.assertAlmostEqual(sum(chart.sums), asb.usage_view(self.REPLIES["30d"], self.ALL, "cost")["total"], delta=.01)
        window.split_buttons["machine"].set_active(True)
        self.assertEqual([key for key, _label, _color in chart.series], ["desk", "laptop", "studio"])
        self.assertEqual(chart.progress, 0)
        self.drain(.4)
        self.assertEqual(chart.progress, 1)
        window.set_period("24h")
        self.drain(.1)
        self.assertEqual(window.routes[-1], "/api/activity/usage?period=24h")
        self.assertEqual((len(chart.bars), window.chart_title.get_label()), (24, "Hourly cost"))
        window.metric_buttons["tokens"].set_active(True)
        self.assertEqual(len(window.routes), 2)
        self.assertEqual(window.chart_title.get_label(), "Hourly tokens")
        value, sub = window.round.center()
        self.assertEqual((value, sub), ("99.4M", "processed tokens"))
        self.assertRegex(value, r"^[\d.]+[MB]$")
        self.assertFalse(window.note.get_visible())
        self.assertEqual(chart.axis, ["5M", "10M", "15M"])
        window.set_period("90d")
        self.drain(.1)
        self.assertRegex(window.round.center()[0], r"^[\d.]+[MB]$")
        self.assertEqual((len(chart.bars), window.chart_title.get_label()), (90, "Daily tokens"))
        self.assert_no_new_warnings()

    def test_a_chip_changes_every_number_and_the_last_stays_on(self):
        window = self.window()
        chips = window.chip_buttons
        chips["studio"].set_active(False)
        self.drain(.05)
        view = asb.usage_view(self.REPLIES["30d"], {"desk", "laptop"}, "cost")
        self.assertEqual(window.routes, ["/api/activity/usage?period=30d"])
        self.assertEqual(window.round.center()[0], "$2,096.01")
        self.assertEqual(window.round.center()[0], asb.format_cost(view["total"]))
        self.assertEqual([row.asb_machine for row in self.children(window.machine_rows)], ["desk", "laptop"])
        self.assertEqual(self.figures(window)["Processed tokens"], asb.format_tokens(view["tokens"]))
        self.assertNotEqual(self.figures(window)["Processed tokens"], "3.33B")
        self.assertNotIn("studio", {key for bar in asb.usage_view(self.REPLIES["30d"], {"desk", "laptop"}, "cost")["bars"] for key in bar["machine"]})
        self.assertTrue(chips["studio"].has_css_class("asb-usage-off"))
        self.assertTrue(all(chip.get_sensitive() for chip in chips.values()))
        chips["laptop"].set_active(False)
        self.drain(.05)
        self.assertEqual([row.asb_machine for row in self.children(window.machine_rows)], ["desk"])
        self.assertFalse(chips["desk"].get_sensitive())
        self.assertEqual(chips["desk"].get_tooltip_text(), "Keep one machine")
        self.assertEqual(chips["studio"].get_tooltip_text(), "Last report Oct 25, 14:30")
        # A refresh keeps the filter.
        window.refresh()
        self.assertEqual([row.asb_machine for row in self.children(window.machine_rows)], ["desk"])
        chips["studio"].set_active(True)
        self.assertTrue(chips["desk"].get_sensitive())
        self.assertEqual(chips["desk"].get_tooltip_text(), "Local")
        self.assertFalse(chips["studio"].has_css_class("asb-usage-off"))
        self.assert_no_new_warnings()

    def test_the_tooltip_of_a_hovered_bar(self):
        window = self.window()
        chart = window.chart
        gap, width = chart.geometry()
        controller = next(item for item in chart.observe_controllers() if isinstance(item, asb.Gtk.EventControllerMotion))
        for index, title in ((20, "Oct 17"), (29, "Oct 26"), (0, "Sep 27")):
            with self.subTest(index=index):
                controller.emit("motion", chart.LEFT + index * (width + gap) + width / 2, 150)
                tip = chart.tip
                self.assertEqual((tip["index"], tip["title"]), (index, title))
                self.assertAlmostEqual(tip["total"], sum(chart.bars[index].values()))
                self.assertEqual(tip["total_text"], asb.format_cost(tip["total"]))
                self.assertEqual([label for label, _text in tip["rows"]], ["Codex", "Claude Code", "OpenCode"])
                left, top, box_width, box_height = tip["bounds"]
                self.assertGreaterEqual(min(left, top), 0)
                self.assertLessEqual(left + box_width, chart.get_width())
                self.assertLessEqual(top + box_height, chart.HEIGHT)
                self.assertGreaterEqual(box_width, 150)
        controller.emit("motion", chart.LEFT + 20 * (width + gap) + width / 2, 150)
        self.assertEqual((chart.tip["total_text"], chart.tip["rows"]), ("$34.32", [("Codex", "$10.11"), ("Claude Code", "$22.88"), ("OpenCode", "$1.33")]))
        # The last bar puts the box left of the bar.
        controller.emit("motion", chart.LEFT + 29 * (width + gap) + width / 2, 150)
        self.assertLess(chart.tip["bounds"][0] + chart.tip["bounds"][2], chart.LEFT + 29 * (width + gap))
        controller.emit("leave")
        self.assertIsNone(chart.tip)
        self.assert_no_new_warnings()

    @unittest.skipUnless(shutil.which("xdotool") and os.environ.get("DISPLAY") in (":9", ":10"),
                         "Real keys need xdotool and DISPLAY=:9 or :10")
    def test_usage_escape_closes_only_after_the_open_menu(self):
        window = self.window()
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True)
        def key(text):
            subprocess.run(["xdotool", "key", text], check=True)
            self.drain(.2)
        def popovers(widget):
            return ([widget] if isinstance(widget, asb.Gtk.Popover) else []) + [
                pop for child in self.children(widget) for pop in popovers(child)]
        window.period_menu.grab_focus()
        key("space")
        menus = popovers(window.period_menu)
        self.assertTrue(any(menu.get_visible() for menu in menus))
        key("Escape")
        self.assertFalse(any(menu.get_visible() for menu in menus))
        self.assertTrue(window.get_visible())
        window.machine_filter.popup(); self.drain(.2)
        self.assertTrue(window.machine_filter.get_popover().get_visible())
        key("Escape")
        self.assertFalse(window.machine_filter.get_popover().get_visible())
        self.assertTrue(window.get_visible())
        key("ctrl+Escape")
        self.assertTrue(window.get_visible())
        key("Escape")
        self.assertFalse(window.get_visible())
        self.assertTrue(window.closed)
        self.assert_no_new_warnings()

    def test_usage_hover_survives_changed_numbers_and_clears_on_leave(self):
        window = self.window()
        chart, ring = window.chart, window.round
        chart_motion = next(c for c in chart.observe_controllers() if isinstance(c, asb.Gtk.EventControllerMotion))
        gap, width = chart.geometry()
        chart_motion.emit("motion", chart.LEFT + 2 * (width + gap) + width / 2, 150.)
        self.assertEqual(chart.hover, 2)
        bars = [{key: value * 2 for key, value in bar.items()} for bar in chart.bars]
        chart.set_data(chart.series, bars, chart.buckets, chart.format, "cost", False)
        self.assertEqual(chart.hover, 2)
        self.assertEqual(chart.tip["total_text"], asb.format_cost(sum(bars[2].values())))
        chart_motion.emit("leave")
        chart.set_data(chart.series, bars, chart.buckets, chart.format, "cost", False)
        self.assertIsNone(chart.hover)
        self.assertIsNone(chart.tip)
        ring_motion = next(c for c in ring.observe_controllers() if isinstance(c, asb.Gtk.EventControllerMotion))
        arc = ring.arcs[1]
        radius, angle = (arc["r0"] + arc["r1"]) / 2, math.radians((arc["a0"] + arc["a1"]) / 2)
        scale = ring.size / ring.SIZE
        ring_motion.emit("motion", (160 + radius * math.cos(angle)) * scale, (160 + radius * math.sin(angle)) * scale)
        self.assertIs(ring.hover, arc)
        arcs = [dict(a, value=a["value"] * 2) for a in ring.arcs]
        ring.set_arcs(arcs, "new total", "new subtitle", asb.format_cost)
        self.assertIs(ring.hover, arcs[1])
        self.assertEqual(ring.center(), (asb.format_cost(arcs[1]["value"]), arcs[1]["label"]))
        ring_motion.emit("leave")
        ring.set_arcs(arcs, "new total", "new subtitle", asb.format_cost)
        self.assertIsNone(ring.hover)
        self.assertEqual(ring.center(), ("new total", "new subtitle"))
        self.assert_no_new_warnings()

    def test_usage_rows_and_totals_keep_widgets_and_update_in_place(self):
        window = self.window()
        def descendants(widget):
            return [widget] + [item for child in self.children(widget) for item in descendants(child)]
        boxes = ((window.machine_rows, "asb_machine", "machines"),
                 (window.app_rows, "asb_app", "apps"), (window.maker_rows, "asb_maker", "makers"))
        saved = {(attr, getattr(row, attr)): descendants(row) for box, attr, _key in boxes for row in self.children(box)}
        figures, blocks = descendants(window.figures), descendants(window.blocks)
        before = self.labels(window.figures)
        view = copy.deepcopy(window.view)
        for key in ("machines", "apps", "makers"):
            view[key].reverse()
            for item in view[key]:
                if item["value"] is not None:
                    item["value"] *= 2
                    item["share"] /= 2
        for machine in view["machines"]:
            machine.update(name=machine["name"] + " changed", state="Connected recently", offline=not machine["offline"], hue=asb.MACHINE_HUES[-1])
            for app in machine["apps"].values():
                app["value"] *= 2
        view["tokens"] *= 2
        view["savings"] *= 2
        for key in ("parts", "cost_parts"):
            view[key] = {part: value * 2 for part, value in view[key].items()}
        window.render_rows(view, asb.format_cost)
        window.render_totals(view)
        for box, attr, key in boxes:
            self.assertEqual([getattr(row, attr) for row in self.children(box)], [item["id"] for item in view[key]])
            for row, item in zip(self.children(box), view[key]):
                self.assertTrue(all(old is new for old, new in zip(saved[(attr, item["id"])], descendants(row))))
                self.assertEqual(len(saved[(attr, item["id"])]), len(descendants(row)))
                self.assertEqual(self.labels(row)[-2:], [asb.format_cost(item["value"]), "" if item["value"] is None else asb.format_share(item["share"])])
                if key == "machines":
                    self.assertEqual(self.labels(row)[:2], [item["name"], item["state"]])
                    state = next(w for w in descendants(row) if isinstance(w, asb.Gtk.Label) and w.get_label() == item["state"])
                    self.assertEqual(state.get_tooltip_text(), item["state"])
                    dot = next(w for w in descendants(row) if w.has_css_class("asb-activity-dot"))
                    self.assertEqual(dot.has_css_class("asb-activity-hollow"), item["offline"])
                    self.assertTrue(dot.has_css_class("horizontal"))
                    self.assertTrue(dot.has_css_class(f"asb-activity-hue-{len(asb.MACHINE_HUES) - 1}"))
        self.assertTrue(all(old is new for old, new in zip(figures, descendants(window.figures))))
        self.assertTrue(all(old is new for old, new in zip(blocks, descendants(window.blocks))))
        self.assertEqual(len(figures), len(descendants(window.figures)))
        self.assertEqual(len(blocks), len(descendants(window.blocks)))
        self.assertNotEqual(before, self.labels(window.figures))
        self.assertEqual(self.figures(window)["Processed tokens"], asb.format_tokens(view["tokens"]))
        for block, values, show in zip(self.children(window.blocks), (view["parts"], view["cost_parts"]), (asb.format_tokens, asb.format_cost)):
            total = sum(values.values())
            lines = [line for line in self.children(block) if hasattr(line, "asb_part")]
            for line in lines:
                self.assertEqual(self.labels(line)[-2:], [show(values[line.asb_part]), asb.format_share(values[line.asb_part] / total)])
        removed = self.children(window.machine_rows)[0]
        departed = view["machines"].pop(0)
        window.render_rows(view, asb.format_cost)
        self.assertIsNone(removed.get_parent())
        view["machines"].append(departed)
        window.render_rows(view, asb.format_cost)
        self.assertEqual([row.asb_machine for row in self.children(window.machine_rows)], [item["id"] for item in view["machines"]])
        self.assertIsNot(self.children(window.machine_rows)[-1], removed)
        # The same data keeps exactly the same label text, including an unpriced value.
        labels = [self.labels(box) for box, _attr, _key in boxes] + [self.labels(window.figures), self.labels(window.blocks)]
        window.render_rows(view, asb.format_cost); window.render_totals(view)
        self.assertEqual(labels, [self.labels(box) for box, _attr, _key in boxes] + [self.labels(window.figures), self.labels(window.blocks)])
        old = self.children(window.app_rows)[0]
        window.small = not window.small
        window.render_rows(view, asb.format_cost)
        self.assertIsNone(old.get_parent())
        again = self.children(window.app_rows)[0]
        window.render_rows(view, asb.format_cost)
        self.assertIs(again, self.children(window.app_rows)[0])
        window.narrow = not window.narrow
        window.render_rows(view, asb.format_cost)
        self.assertIsNone(again.get_parent())
        self.assert_no_new_warnings()

    def test_the_models_table(self):
        window = self.window()
        rows = self.model_rows(window)
        self.assertEqual([key for key, _cells in rows], [
            ("claude-opus-5-5", "claude"), ("gpt-6.1-sol", "codex"), ("claude-sonnet-5-5", "claude"), ("claude-sonnet-5-5", "opencode"),
            ("claude-haiku-5-5", "claude"), ("gpt-6.1-mini", "codex"), ("mimo-v2.6-pro", "opencode")])
        heads = [child.get_label() for child in self.children(window.models) if child.has_css_class("asb-usage-head")]
        self.assertEqual(heads, ["Model", "App", "Machines", "Cost", "Share", "Tokens"])
        first, last = rows[0][1], rows[-1][1]
        self.assertEqual(self.labels(first[0]) + self.labels(first[1]) + self.labels(first[3]) + self.labels(first[4]) + self.labels(first[5]),
                         ["claude-opus-5-5", "Claude Code", "$923.90", "39.4%", "625.9M"])
        self.assert_accessible_label(first[2], "Desk, Studio")
        self.assertEqual(self.labels(last[3]), ["Unpriced"])
        self.assertTrue(last[3].has_css_class("asb-dim"))
        self.assertEqual(self.children(last[4]), [])
        window.metric_buttons["tokens"].set_active(True)
        rows = self.model_rows(window)
        self.assertEqual(rows[0][0], ("gpt-6.1-sol", "codex"))
        view = asb.usage_view(self.REPLIES["30d"], self.ALL, "tokens")
        self.assertEqual(self.labels(rows[-1][1][4]), [asb.format_share(view["models"][-1]["share"])])
        self.assert_no_new_warnings()

    def test_an_incomplete_scan_reads_every_two_seconds(self):
        reading = copy.deepcopy(self.REPLIES)
        reading["30d"]["scan"] = {"complete": False, "files": 2707, "scannedFiles": 120}
        replies = {"30d": None}
        with patch.object(asb, "EventStream"):
            replies["30d"] = reading["30d"]
            window = self.window(replies)
            self.assertTrue(window.scan_label.get_visible())
            self.assertEqual(window.scan_label.get_label(), "Reading usage: 120 of 2,707 files")
            # Its own top bar under the row and the paths note.
            self.assertIs(window.scan_label.get_ancestor(asb.Adw.ToolbarView), window.toolbar_view)
            self.assertIs(window.scan_label.get_prev_sibling(), window.paths_note)
            self.assertEqual((window.scan_label.get_margin_start(), window.scan_label.get_margin_end(), window.scan_label.get_margin_bottom()),
                             (10, 10, 4))
            self.poll_calls.reset_mock()
            self.addCleanup(setattr, self.poll_calls, "return_value", 0)
            self.poll_calls.return_value = 41
            window.start_live()
            self.poll_calls.assert_called_once_with(2, window.poll_tick)
            self.poll_calls.reset_mock()
            replies["30d"] = dict(reading["30d"], scan={"complete": False, "files": 0, "scannedFiles": 0})
            with patch.object(asb.GLib, "source_remove") as removed:
                window.poll_tick()
                self.assertEqual(window.scan_label.get_label(), "Reading usage")
                self.poll_calls.assert_not_called()
                replies["30d"] = self.REPLIES["30d"]
                window.poll_tick()
            removed.assert_called_once_with(41)
            self.poll_calls.assert_called_once_with(15, window.poll_tick)
            self.assertFalse(window.scan_label.get_visible())
            self.poll_calls.reset_mock()
            replies["30d"] = dict(self.REPLIES["30d"], prices={"source": "LiteLLM", "status": "loading", "fetchedAtMs": None, "models": 0})
            with patch.object(asb.GLib, "source_remove"):
                window.poll_tick()
                self.assertEqual(window.round.get_tooltip_text(), "Prices: loading")
                self.poll_calls.assert_called_once_with(2, window.poll_tick)
                window.stop_live()
        self.assert_no_new_warnings()

    def test_a_reply_that_changes_only_the_time_does_not_render(self):
        replies = copy.deepcopy(self.REPLIES)
        window = self.window(replies)
        cells = self.children(window.models)
        rows = self.children(window.machine_rows)
        replies["30d"]["nowMs"] += 60_000
        window.refresh()
        self.assertEqual(window.data["nowMs"], replies["30d"]["nowMs"])
        self.assertEqual(self.children(window.models), cells)
        self.assertEqual(self.children(window.machine_rows), rows)
        replies["30d"]["records"][0]["tokens"]["output"] += 1
        window.refresh()
        self.assertEqual(self.children(window.machine_rows), rows)
        # The view controls change the values without replacing the rows.
        before = self.labels(window.machine_rows)
        window.set_metric("tokens")
        self.assertEqual(self.children(window.machine_rows), rows)
        self.assertNotEqual(self.labels(window.machine_rows), before)
        self.assertEqual(window.round.center()[1], "processed tokens")
        self.assert_no_new_warnings()

    def test_custom_header_and_buttons(self):
        self.check_theme_header()

    def test_theme_surfaces_and_tracks(self):
        asb.THEME_PATH.write_text(json.dumps({"mode": "custom", "colors": self.THEME}))
        # The rendering fixture accent is below the theme editor's contrast limit.
        with patch.object(asb, "validate_theme", return_value=self.THEME):
            window = self.window()
        # The row has the window color and, as on the board, no line under it.
        found, spacer = window.toolbar_start.get_next_sibling().compute_bounds(window)
        self.assertTrue(found)
        found, bounds = window.window_handle.compute_bounds(window)
        self.assertTrue(found)
        middle = spacer.get_x() + spacer.get_width() // 2
        self.assert_pixel(window, middle, bounds.get_y() + bounds.get_height() // 2, self.THEME["background"])
        self.assert_pixel(window, middle, bounds.get_y() + bounds.get_height() - 1, self.THEME["background"])
        adjustment = window.scroll.get_vadjustment()
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
        self.drain(.2)
        share = next(cells[4].get_first_child() for _key, cells in self.model_rows(window) if cells[4].get_first_child() is not None)
        self.assert_pixel(share, share.get_width() - 3, share.get_height() // 2, window.palette["track"])
        asb.THEME_PATH.unlink()
        native = self.window()
        self.assertEqual(native.palette["divider"], native.palette["rule"])
        found, spacer = native.toolbar_start.get_next_sibling().compute_bounds(native.toolbar)
        self.assertTrue(found)
        self.assert_pixel(native.toolbar, spacer.get_x() + spacer.get_width() // 2, native.toolbar.get_height() // 2, native.palette["win"])
        self.assert_no_new_warnings()

    def test_a_theme_change_reaches_the_kept_model_share_bars(self):
        replies = copy.deepcopy(self.REPLIES)
        window = self.window(replies)
        share = next(cells[4] for _key, cells in self.model_rows(window) if cells[4].get_first_child() is not None)
        before_track = share.get_first_child().track
        before = asb.alpha_color(window.palette["light"], .75).to_string()
        window.set_palette(asb.validate_theme(CUSTOM))
        expected = asb.alpha_color(window.palette["light"], .75).to_string()
        self.assertNotEqual(expected, before)
        # A reply with only a new time keeps the rows, so the theme change itself must give the bars the new color.
        replies["30d"]["nowMs"] += 60_000
        window.refresh()
        self.drain(.1)
        self.assertIn(share, [cells[4] for _key, cells in self.model_rows(window)])
        self.assertEqual(share.get_first_child().segments[0][1].to_string(), expected)
        self.assertNotEqual(share.get_first_child().track, before_track)
        self.assertEqual(share.get_first_child().track, window.palette["track"])
        self.assert_no_new_warnings()

    def test_model_rows_keep_their_widgets(self):
        window = self.window()
        before = dict(self.model_rows(window))
        window.set_metric("tokens")
        rows = self.model_rows(window)
        view = asb.usage_view(self.REPLIES["30d"], self.ALL, "tokens")
        self.assertEqual([key for key, _cells in rows], [(model["model"], model["app"]) for model in view["models"]])
        self.assertNotEqual([key for key, _cells in rows], list(before))
        for (key, cells), model in zip(rows, view["models"]):
            self.assertEqual(cells, before[key])
            self.assertEqual({window.models.query_child(cell)[1] for cell in cells}, {rows.index((key, cells)) + 1})
            self.assertEqual(self.labels(cells[5]), [asb.format_tokens(model["tokens"])])
            self.assertEqual(self.labels(cells[4]), [asb.format_share(model["share"])])
        self.drain(.1)
        tops = [cells[0].compute_bounds(window)[1].get_y() for _key, cells in rows]
        self.assertEqual(tops, sorted(tops))
        self.assertEqual(len(set(tops)), len(tops))
        mimo = before[("mimo-v2.6-pro", "opencode")]
        self.assertEqual(self.labels(mimo[3]), ["Unpriced"])
        self.assertTrue(mimo[3].has_css_class("asb-dim"))
        window.data["records"] = [record for record in window.data["records"] if record["model"] != "gpt-6.1-mini"]
        window.data["records"].append(dict(copy.deepcopy(window.data["records"][0]), model="new-model"))
        window.render_view()
        rows = dict(self.model_rows(window))
        gone = before[("gpt-6.1-mini", "codex")]
        self.assertTrue(all(cell.get_parent() is None for cell in gone))
        self.assertNotIn(("gpt-6.1-mini", "codex"), rows)
        added = rows[(("new-model", window.data["records"][0]["app"]))]
        self.assertTrue(all(cell.get_parent() is window.models for cell in added))
        self.assertEqual(self.labels(added[0]), ["new-model"])
        self.assertEqual(len(self.children(window.models)), 6 * (len(rows) + 1))
        self.assert_no_new_warnings()

    def test_a_split_switch_changes_only_the_chart(self):
        window = self.window()
        widgets = [self.children(box) for box in (window.machine_rows, window.app_rows, window.maker_rows, window.figures, window.models)]
        window.split_buttons["machine"].set_active(True)
        self.assertEqual([key for key, _label, _color in window.chart.series], ["desk", "laptop", "studio"])
        self.assertEqual(window.chart.bars, [bar["machine"] for bar in asb.usage_view(self.REPLIES["30d"], self.ALL, "cost")["bars"]])
        self.assertEqual([self.children(box) for box in (window.machine_rows, window.app_rows, window.maker_rows, window.figures, window.models)],
                         widgets)
        window.split_buttons["app"].set_active(True)
        self.assertEqual([key for key, _label, _color in window.chart.series], ["codex", "claude", "opencode"])
        self.assert_no_new_warnings()

    def tall_replies(self):
        """The sample replies with 12 more providers, each with an unpriced model: a tall overview with a long note."""
        replies = copy.deepcopy(self.REPLIES)
        for reply in replies.values():
            template = reply["records"][0]
            reply["records"] += [dict(copy.deepcopy(template), maker=f"Provider {index:02}", model=f"provider-{index:02}-long-model-name-preview",
                                      cost=None) for index in range(12)]
        return replies

    def test_the_round_chart_stays_at_the_top_of_the_wide_layout(self):
        window = self.window(self.tall_replies())
        # The open Providers fold makes the side column taller than the ring.
        window.maker_fold.set_expanded(True)
        self.drain(.1)
        self.assertEqual(window.round_cell.get_valign(), asb.Gtk.Align.START)
        self.assertGreaterEqual(len(self.children(window.maker_rows)), 12)
        self.assertTrue(window.note.get_visible())
        machines = window.machine_fold.get_label_widget()
        self.assertEqual(machines.get_label(), "Machines")
        found, title = machines.compute_bounds(window)
        self.assertTrue(found)
        found, ring = window.round.compute_bounds(window)
        self.assertTrue(found)
        self.assertLessEqual(abs(ring.get_y() - title.get_y()), 40)
        narrow = self.window(self.tall_replies(), size=(860, 900))
        self.assertEqual(narrow.round_cell.get_valign(), asb.Gtk.Align.CENTER)
        self.assert_no_new_warnings()

    def figure_lines(self, window):
        lines = set()
        for figure in self.children(window.figures):
            found, bounds = figure.compute_bounds(window)
            self.assertTrue(found)
            lines.add(bounds.get_y())
        return lines

    def assert_blocks_side_by_side(self, window):
        bounds = [block.compute_bounds(window)[1] for block in self.children(window.blocks)]
        self.assertEqual(len(bounds), 2)
        self.assertEqual(bounds[0].get_y(), bounds[1].get_y())
        self.assertNotEqual(bounds[0].get_x(), bounds[1].get_x())

    def test_narrow_layouts(self):
        window = self.window(size=(860, 900))
        self.assertTrue(window.narrow)
        self.assertFalse(window.small)
        self.assertEqual(window.overview.get_orientation(), asb.Gtk.Orientation.VERTICAL)
        self.assertEqual(window.blocks.get_orientation(), asb.Gtk.Orientation.HORIZONTAL)
        self.assert_blocks_side_by_side(window)
        found, round_bounds = window.round.compute_bounds(window)
        self.assertTrue(found)
        self.assertEqual((round_bounds.get_width(), round_bounds.get_height()), (240, 240))
        self.assertAlmostEqual(round_bounds.get_x() + 120, window.get_width() / 2, delta=8)
        self.assertEqual(len(self.children(window.figures)), 5)
        self.assertIn("Machines", [child.get_label() for child in self.children(window.models) if child.has_css_class("asb-usage-head")])
        small = self.window(size=(600, 900))
        self.assertTrue(small.small and small.narrow)
        heads = [child.get_label() for child in self.children(small.models) if child.has_css_class("asb-usage-head")]
        self.assertEqual(heads, ["Model", "App", "Cost", "Tokens"])
        self.assertEqual(self.labels(self.model_rows(small)[0][1][1]), [])
        self.assertEqual(small.blocks.get_orientation(), asb.Gtk.Orientation.VERTICAL)
        self.assertLessEqual(len(self.figure_lines(small)), 2)
        self.assertEqual(small.content.get_margin_start(), 14)
        middle = self.window(size=(640, 900))
        self.assertTrue(middle.narrow)
        self.assertFalse(middle.small)
        self.assertEqual(middle.get_width(), 640)
        self.assertEqual(middle.blocks.get_orientation(), asb.Gtk.Orientation.HORIZONTAL)
        self.assert_blocks_side_by_side(middle)
        self.assertLessEqual(len(self.figure_lines(middle)), 2)
        wide = self.window()
        self.assertFalse(wide.narrow)
        self.assertEqual(len(self.figure_lines(wide)), 1)
        # The figures line up with their heading: a FlowBox child has no padding of its own.
        title = wide.figures.get_first_child().get_child().get_first_child()
        self.assertEqual(title.compute_bounds(wide)[1].get_x(), wide.figures.get_prev_sibling().compute_bounds(wide)[1].get_x())
        self.assertEqual(wide.overview.get_orientation(), asb.Gtk.Orientation.HORIZONTAL)
        self.assertEqual(wide.content.get_margin_start(), 24)
        self.assert_no_new_warnings()

    def test_the_narrow_ring_scales_its_drawing_and_hit_test(self):
        window = self.window(size=(860, 900))
        ring = window.round
        self.assertTrue(ring.arcs)
        for arc in ring.arcs:
            radius, angle = (arc["r0"] + arc["r1"]) / 2, math.radians((arc["a0"] + arc["a1"]) / 2)
            self.assertIs(ring.arc_at((160 + radius * math.cos(angle)) * .75, (160 + radius * math.sin(angle)) * .75), arc)
        ring.total_text, ring.sub_text = "$123,456.78", "Claude Code on a-very-long-machine-name"
        (value, *_), (sub, *_) = ring.center_layouts()
        self.assertLessEqual(value.get_pixel_extents()[1].width, 2 * 92 * .75 - 16)
        self.assertGreaterEqual(value.get_font_description().get_size() / asb.Pango.SCALE, 12)
        self.assertTrue(sub.is_ellipsized())
        self.assertLessEqual(sub.get_pixel_extents()[1].width, 2 * 92 * .75 - 16)
        wide = self.window()
        (value, *_), _sub = wide.round.center_layouts()
        self.assertEqual(wide.round.total_text, "$2,343.50")
        self.assertEqual(value.get_font_description().get_size() / asb.Pango.SCALE, 26)
        self.assert_no_new_warnings()

    def test_row_columns_keep_their_width(self):
        for size, cell_width in (((948, 760), 210), ((860, 900), 150), ((600, 900), 112)):
            with self.subTest(size=size):
                window = self.window(size=size)
                window.app_fold.set_expanded(True)
                window.maker_fold.set_expanded(True)
                self.drain(.1)
                cells, heights = [], []
                for box in (window.machine_rows, window.app_rows, window.maker_rows):
                    for row in self.children(box):
                        heights.append(row.get_height())
                        who, bar = self.children(row)[:2]
                        found, cell = who.compute_bounds(window)
                        self.assertTrue(found)
                        found, track = bar.compute_bounds(window)
                        self.assertTrue(found)
                        columns = tuple((bounds.get_x(), bounds.get_width()) for widget in self.children(row)
                                        for found, bounds in [widget.compute_bounds(window)] if found)
                        self.assertEqual(len(columns), 4)
                        cells.append((cell.get_width(), track.get_x(), track.get_width(), columns))
                self.assertEqual(len(cells), 9)
                self.assertEqual(cells[0][0], cell_width)
                self.assertEqual(set(cells), {cells[0]})
                self.assertEqual(len(heights), 9)
                self.assertEqual(set(heights), {heights[0]})
                self.assertLessEqual(heights[0], 36)
                if size == (600, 900):
                    states = {row.asb_machine: self.children(self.children(row)[0].get_child())[1] for row in self.children(window.machine_rows)}
                    studio, desk = states["studio"], states["desk"]
                    self.assertEqual(studio.get_label(), "Offline · last report Oct 25, 14:30")
                    self.assertTrue(studio.get_layout().is_ellipsized())
                    self.assertEqual(studio.get_tooltip_text(), "Offline · last report Oct 25, 14:30")
                    self.assertEqual(studio.get_height(), desk.get_height())
        self.assert_no_new_warnings()

    def test_empty_period(self):
        empty = {key: dict(reply, records=[]) for key, reply in self.REPLIES.items()}
        window = self.window(empty)
        self.assertTrue(window.empty_label.get_visible())
        self.assertFalse(window.scroll.get_visible())
        self.assertEqual(window.empty_label.get_label(), "No usage in 30 days.")
        self.assertEqual(list(window.chip_buttons), ["desk", "laptop", "studio"])
        window.set_period("24h")
        self.drain(.05)
        self.assertEqual(window.empty_label.get_label(), "No usage in 24 hours.")
        self.assert_no_new_warnings()

    def test_without_gsk_paths_nothing_is_drawn(self):
        with patch.object(asb, "ACTIVITY_PATHS", False):
            window = self.window()
            self.assertTrue(window.paths_note.get_visible())
            for widget in (window.round, window.chart):
                snapshot = asb.Gtk.Snapshot()
                widget.do_snapshot(snapshot)
                self.assertIsNone(snapshot.to_node())
            self.assertEqual(len(self.children(window.machine_rows)), 3)
            self.assertEqual(len(self.model_rows(window)), 7)
            self.assertEqual(self.figures(window)["Processed tokens"], "3.33B")
            self.capture(window, self.directory / "usage-no-paths.png")
        self.assert_no_new_warnings()


@unittest.skipUnless(asb.Gtk.init_check(), "A GTK display is not available.")
class ActivityWindowCheck(ActivityFixture, unittest.TestCase):
    snapshot_window = WidgetCheck.snapshot_window

    class Probe(asb.ActivityWindow):
        KIND, TITLE, ROUTE = "test", "Test activity", "/api/activity/messages"
        PERIODS, DEFAULT_PERIOD, DEFAULT_SIZE = asb.MESSAGE_PERIODS, "7d", (640, 480)

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.renders, self.sessions = [], []

        def render(self, data, previous):
            self.renders.append((data, previous))

        def show_session(self, seat, title=""):
            self.sessions.append((seat, title))

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="asb-activity-test-")
        self.addCleanup(directory.cleanup)
        # A missing theme file: the windows start with the GNOME colors, whatever this machine saved.
        patcher = patch.object(asb, "THEME_PATH", Path(directory.name) / "theme.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.close_windows)

    def probe(self, answers=None, **kwargs):
        """A window with a fake fetch: each read takes the next answer (an exception is raised), then {"read": n}."""
        answers, routes, pages = list(answers or ()), [], []

        def fetch(route):
            routes.append(route)
            pages.append(window.stack.get_visible_child_name())
            answer = answers.pop(0) if answers else {"read": len(routes)}
            if isinstance(answer, Exception):
                raise answer
            return answer
        window = self.Probe(self.application, "http://127.0.0.1:1", fetch=fetch, **kwargs)
        window.routes, window.pages = routes, pages
        return window

    def test_window_title_size_periods_and_loading_page(self):
        window = self.probe()
        window.present()
        self.drain(.05)
        self.assertEqual(window.get_title(), "Test activity")
        self.assertEqual(window.get_default_size(), (640, 480))
        self.assertTrue(window.has_css_class("asb-activity"))
        self.assertFalse(window.get_modal())
        self.assertIsNone(window.get_transient_for())
        self.assertIs(window.get_application(), self.application)
        menu = window.period_menu
        self.assertIs(window.app_mark.get_next_sibling(), menu)
        self.assertTrue(menu.has_css_class("flat") and menu.has_css_class("asb-period-menu"))
        self.assertTrue(window.toolbar.has_css_class("asb-activity-toolbar"))
        self.assertEqual([menu.get_model().get_string(index) for index in range(menu.get_model().get_n_items())], ["24 hours", "7 days", "30 days"])
        self.assertEqual((menu.get_selected(), menu.get_tooltip_text()), (1, "Period"))
        self.assert_accessible_label(menu, "Period")
        self.assertEqual((window.period, window.data, window.routes), ("7d", None, []))
        self.assertEqual(window.stack.get_visible_child_name(), "loading")
        self.assertTrue(window.stack.get_visible_child().get_spinning())

    def test_replies_render_with_the_previous_reply(self):
        window = self.probe([{"n": 1}, {"n": 2}])
        window.refresh()
        self.assertEqual(window.routes, ["/api/activity/messages?period=7d"])
        self.assertEqual(window.stack.get_visible_child_name(), "data")
        self.assertIs(window.stack.get_visible_child(), window.data_page)
        self.assertEqual(window.renders, [({"n": 1}, None)])
        window.refresh()
        self.assertEqual(window.renders, [({"n": 1}, None), ({"n": 2}, {"n": 1})])
        self.assertEqual(window.data, {"n": 2})

    def test_errors_before_and_after_data(self):
        window = self.probe([RuntimeError("Cannot load the activity. Check that ASB is running, then try again."), {"n": 1},
                             RuntimeError("Later failure.")])
        window.refresh()
        self.assertEqual(window.stack.get_visible_child_name(), "error")
        self.assertEqual(window.error_label.get_label(), "Cannot load the activity. Check that ASB is running, then try again.")
        self.assertTrue(window.error_label.get_wrap())
        self.assertEqual(window.retry_button.get_label(), "Try again")
        window.retry_button.emit("clicked")
        self.assertEqual((len(window.routes), window.stack.get_visible_child_name(), window.renders), (2, "data", [({"n": 1}, None)]))
        window.refresh()
        self.assertEqual((len(window.routes), window.stack.get_visible_child_name(), window.data), (3, "data", {"n": 1}))
        self.assertEqual(len(window.renders), 1)

    def test_period_change_reads_the_new_period(self):
        window = self.probe()
        window.refresh()
        window.set_period("30d")
        self.assertEqual(window.routes[-1], "/api/activity/messages?period=30d")
        self.assertEqual(window.pages[-1], "loading")
        self.assertIsNone(window.renders[-1][1])
        self.assertEqual(window.period_menu.get_selected(), 2)
        with self.assertRaises(ValueError):
            window.set_period("x")
        self.assertEqual(window.period, "30d")
        reads = len(window.routes)
        window.period_menu.set_selected(2)
        self.assertEqual(len(window.routes), reads)
        window.period_menu.set_selected(0)
        self.assertEqual((window.period, window.routes[-1], window.pages[-1]), ("24h", "/api/activity/messages?period=24h", "loading"))
        self.assertEqual(len(window.routes), 3)
        self.assertEqual(window.stack.get_visible_child_name(), "data")

    def test_a_reply_for_an_old_period_is_dropped(self):
        window = self.probe()
        inner = window.fetch

        def fetch(route):
            answer = inner(route)
            if route.endswith("=7d"):
                # The user picks another period while the first read runs.
                window.set_period("24h")
            return answer
        window.fetch = fetch
        window.refresh()
        self.assertEqual(window.routes, ["/api/activity/messages?period=7d", "/api/activity/messages?period=24h"])
        self.assertEqual(window.renders, [({"read": 2}, None)])
        self.assertEqual(window.period, "24h")

    def test_the_reply_dispatch_has_the_default_priority(self):
        window = self.Probe(self.application, "http://127.0.0.1:1")
        with patch.object(asb, "request_async") as request:
            window.refresh()
        dispatch = request.call_args.args[3]
        callback = Mock(return_value=False)
        with patch.object(asb.GLib, "idle_add") as idle:
            dispatch(callback, {"read": 1}, None)
        idle.assert_called_once_with(callback, {"read": 1}, None, priority=asb.GLib.PRIORITY_DEFAULT)

    def test_dashboard_events_coalesce_into_one_refresh(self):
        window = self.probe()
        for _event in range(3):
            asb.GLib.idle_add(window.on_dashboard_event)
            self.drain(.03)
        self.assertEqual(window.routes, [])
        self.drain(1.2)
        self.assertEqual(window.routes, ["/api/activity/messages?period=7d"])
        self.assertIsNone(window.event_timer)

    def test_live_refresh_runs_only_while_mapped(self):
        streams = []
        stream = lambda *args: streams.append((args, Mock())) or streams[-1][1]
        with patch.object(asb, "EventStream", side_effect=stream), patch.object(asb, "request_async") as request:
            window = self.Probe(self.application, "http://127.0.0.1:1")
            self.assertEqual((streams, request.call_count), ([], 0))
            self.poll_calls.reset_mock()
            self.poll_calls.return_value = 0
            window.present()
            self.drain(.1)
            self.assertEqual(len(streams), 1)
            self.assertEqual(streams[0][0], ("http://127.0.0.1:1", window.on_dashboard_event, asb.GLib.idle_add))
            self.poll_calls.assert_called_once_with(15, window.poll_tick)
            self.assertEqual(request.call_args.args[:2], ("http://127.0.0.1:1", "/api/activity/messages?period=7d"))
            # A reconnect while mapped starts a new stream on the new engine.
            request.call_args.args[2]({"n": 1}, None)
            window.reconnect("http://127.0.0.1:2")
            streams[0][1].close.assert_called_once()
            self.assertEqual(streams[1][0][0], "http://127.0.0.1:2")
            self.assertEqual(request.call_args.args[:2], ("http://127.0.0.1:2", "/api/activity/messages?period=7d"))
            window.set_visible(False)
            self.drain(.05)
            streams[1][1].close.assert_called_once()
            self.assertIsNone(window.events)
            window.present()
            self.drain(.1)
            self.assertEqual(len(streams), 3)
            window.close()
            self.drain(.05)
            streams[2][1].close.assert_called_once()
            self.assertTrue(window.closed)

    def test_control_w_closes_and_forgets_the_window(self):
        with patch.dict(asb.ACTIVITY_WINDOW_CLASSES, {"test": lambda application, base: self.probe()}):
            window = self.application.show_activity("test")
        self.drain(.05)
        self.assertIs(self.application.activity_windows["test"], window)
        controllers = [controller for controller in window.observe_controllers() if isinstance(controller, asb.Gtk.ShortcutController)]
        shortcuts = [controller.get_item(index) for controller in controllers for index in range(controller.get_n_items())]
        closing = [shortcut for shortcut in shortcuts if shortcut.get_trigger().to_string() == "<Control>w"]
        self.assertEqual(len(closing), 1)
        closing[0].get_action().activate(asb.Gtk.ShortcutActionFlags.EXCLUSIVE, window, None)
        self.drain(.05)
        self.assertTrue(window.closed)
        self.assertNotIn("test", self.application.activity_windows)
        self.assertNotIn(window, self.application.get_windows())

    def test_show_activity_keeps_one_window_per_kind(self):
        made = []
        factory = lambda application, base: made.append(self.probe()) or made[-1]
        with patch.dict(asb.ACTIVITY_WINDOW_CLASSES, {"test": factory}):
            first = self.application.show_activity("test")
            with patch.object(first, "present", wraps=first.present) as present:
                second = self.application.show_activity("test", seat="first")
            present.assert_called_once()
            with self.assertRaises(ValueError):
                self.application.show_activity("nope")
        self.assertIs(first, second)
        self.assertEqual(len(made), 1)
        self.assertEqual(first.sessions, [("first", "")])
        self.assertEqual([window for window in self.application.get_windows() if isinstance(window, self.Probe)], [first])
        self.addCleanup(setattr, self.application, "base", self.application.base)
        with patch.object(first, "reconnect") as moved, patch.object(asb, "SOURCE_TOKEN", ""):
            self.application.reconnect("http://127.0.0.1:3", "")
        moved.assert_called_once_with("http://127.0.0.1:3")
        first.close()
        self.drain(.05)
        self.assertNotIn("test", self.application.activity_windows)
        # Reopening makes a new window; a window destroyed without a close request is forgotten too.
        with patch.dict(asb.ACTIVITY_WINDOW_CLASSES, {"test": factory}):
            third = self.application.show_activity("test")
        self.assertIsNot(third, first)
        third.destroy()
        self.drain(.05)
        self.assertTrue(third.closed)
        self.assertNotIn("test", self.application.activity_windows)

    def test_each_window_has_its_own_palette(self):
        first, second = self.probe(), self.probe()
        self.assertNotEqual(first.scope_class, second.scope_class)
        self.assertIsNot(first.css, second.css)
        custom = asb.validate_theme(CUSTOM)
        first.set_palette(custom)
        self.assertEqual(first.palette, asb.activity_palette(custom))
        rules = first.css.to_string()
        # GTK prints the selector classes in its own order.
        self.assertTrue(all(f".{first.scope_class}" in line and ".asb-activity" in line for line in rules.splitlines() if line.endswith("{")))
        self.assertIn("background-color:rgb(23,28,34);", rules.replace(" ", ""))
        self.assertNotIn(second.scope_class, rules)
        native = asb.activity_palette(asb.native_colors(second))
        native["divider"] = native["rule"]
        self.assertEqual(second.palette, native)
        self.assertNotIn("rgb(23,28,34)", second.css.to_string().replace(" ", ""))
        first.present()
        self.drain(.2)
        # A rendered pixel of the content area, away from the spinner, has the window color.
        found, point = first.stack.compute_point(first, asb.Graphene.Point().init(20, first.stack.get_height() - 20))
        self.assertTrue(found)
        self.assertEqual(self.window_pixels(first, (point.x, point.y)), ["#171c22"])

    def window_pixels(self, window, *points):
        """The #rrggbb colors of the rendered window at points in window coordinates."""
        snapshot = asb.Gtk.Snapshot()
        asb.Gtk.WidgetPaintable.new(window).snapshot(snapshot, window.get_width(), window.get_height())
        renderer = asb.Gsk.CairoRenderer()
        renderer.realize(None)
        self.addCleanup(renderer.unrealize)
        viewport = asb.Graphene.Rect().init(0, 0, window.get_width(), window.get_height())
        downloader = asb.Gdk.TextureDownloader.new(renderer.render_texture(snapshot.to_node(), viewport))
        downloader.set_format(asb.Gdk.MemoryFormat.R8G8B8A8)
        data, stride = downloader.download_bytes()
        data = data.get_data()
        return ["#" + data[round(y) * stride + round(x) * 4:][:3].hex() for x, y in points]

    def test_the_toolbar_spans_the_window_and_pads_its_items(self):
        window = self.probe()
        window.set_palette(asb.validate_theme(CUSTOM))
        window.present()
        self.drain(.2)
        self.assertEqual(window.get_width(), 640)
        found, bounds = window.window_handle.compute_bounds(window)
        self.assertTrue(found)
        self.assertEqual((bounds.get_x(), bounds.get_y(), bounds.get_width()), (0, 0, 640))
        middle = bounds.get_y() + bounds.get_height() / 2
        bar = window.palette["win"]
        self.assertEqual(self.window_pixels(window, (1, middle), (638, middle)), [bar, bar])
        # The row has the board's margins: 4px at the sides, 2px above.
        found, mark = window.app_mark.compute_bounds(window)
        self.assertTrue(found)
        found, row = window.toolbar.compute_bounds(window)
        self.assertTrue(found)
        self.assertEqual((mark.get_x() - bounds.get_x(), row.get_y() - bounds.get_y()), (4, 2))
        found, controls = window.window_controls.compute_bounds(window)
        self.assertTrue(found)
        self.assertEqual(controls.get_x() + controls.get_width(), 636)

    def test_the_paths_note_shows_only_without_gsk_paths(self):
        self.assertEqual(asb.ACTIVITY_PATHS, hasattr(asb.Gsk, "PathBuilder"))
        for paths in (False, True):
            with self.subTest(paths=paths), patch.object(asb, "ACTIVITY_PATHS", paths):
                window = self.probe()
                note = window.paths_note
                self.assertEqual(note.get_label(), "Charts need GTK 4.14 or later.")
                self.assertTrue(note.has_css_class("asb-dim"))
                self.assertEqual((note.get_margin_top(), note.get_margin_bottom(), note.get_margin_start(), note.get_margin_end()), (4, 4, 10, 10))
                self.assertIs(window.window_handle.get_next_sibling(), note)
                self.assertEqual(note.get_visible(), not paths)
        self.assertIn(f"{window.css_scope}.asb-activity .asb-paths-note {{\n  font-size: 12px;", window.css.to_string())

    def test_subclass_rules_load_with_the_palette(self):
        class Styled(self.Probe):
            def palette_css(self, palette):
                return f"{self.css_scope} .asb-test-total {{ color: {palette['accent']}; }}\n"
        window = Styled(self.application, "http://127.0.0.1:1", fetch=lambda route: {})
        self.assertEqual(window.css_scope, "." + window.scope_class)
        self.assertRegex(window.css_scope, r"^\.asb-activity-\d+$")
        self.assertIn(f"{window.css_scope} .asb-test-total", window.css.to_string())
        custom = asb.validate_theme(CUSTOM)
        window.set_palette(custom)
        rules = window.css.to_string()
        self.assertIn("background-color:rgb(23,28,34);", rules.replace(" ", ""))
        self.assertIn(f"{window.css_scope} .asb-test-total {{\n  color: rgb(243,198,107);", rules)
        self.assertEqual(self.probe().palette_css(custom), "")

    def test_a_board_theme_change_reaches_the_activity_windows(self):
        with patch.dict(asb.ACTIVITY_WINDOW_CLASSES, {"test": lambda application, base: self.probe()}):
            window = self.application.show_activity("test")
        board = self.snapshot_window()
        custom = asb.validate_theme(CUSTOM)
        board.set_palette(custom)
        self.assertEqual(window.palette, asb.activity_palette(custom))
        board.set_palette(None)
        native = asb.activity_palette(asb.native_colors(window))
        native["divider"] = native["rule"]
        self.assertEqual(window.palette, native)

    def test_a_new_gnome_accent_reaches_the_activity_windows_only_with_gnome_colors(self):
        with patch.dict(asb.ACTIVITY_WINDOW_CLASSES, {"test": lambda application, base: self.probe()}):
            window = self.application.show_activity("test")
        board = self.snapshot_window()
        board.set_palette(None)
        native = asb.activity_palette(asb.native_colors(window))
        native["divider"] = native["rule"]
        # The window still has the colors of the old accent; the style change gives it the colors of now.
        window.set_palette(asb.validate_theme(CUSTOM))
        self.assertNotEqual(window.palette, native)
        with patch.object(board, "publish_palette", Mock(return_value=False)) as publish:
            self.assertIs(board.follow_system_style(), False)
        publish.assert_called_once_with()
        self.assertEqual(window.palette, native)
        # With custom colors, only the phone palette is published.
        board.set_palette(asb.validate_theme(CUSTOM))
        with patch.object(board, "publish_palette", Mock(return_value=False)) as publish, \
                patch.object(board, "set_palette", Mock()) as set_palette:
            board.follow_system_style()
        set_palette.assert_not_called()
        publish.assert_called_once_with()

    def test_activity_routes_report_their_errors(self):
        headers = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                headers.append(dict(self.headers))
                path = self.path.split("?")[0]
                code, body = {"/api/activity/messages": (404, {"error": "Not found."}), "/api/activity/usage": (400, {"error": "Invalid period."}),
                              "/api/activity/thread": (500, None)}.get(path, (200, {"seats": []}))
                self.send_response(code)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode() if body else b"")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 1)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_port}"
        with patch.object(asb, "SOURCE_TOKEN", "synthetic-test-value"):
            for route, text in (("/api/activity/messages?period=7d", "This ASB engine has no activity data. Update ASB, then try again."),
                                ("/api/activity/usage?period=1y", "Invalid period."),
                                ("/api/activity/thread?seat=a", "Cannot load the activity. Check that ASB is running, then try again.")):
                with self.subTest(route=route), self.assertRaises(RuntimeError) as caught:
                    asb.request_json(base, route)
                self.assertEqual(str(caught.exception), text)
            self.assertEqual(asb.request_json(base, "/api/activity/other"), {"seats": []})
        self.assertEqual(len(headers), 4)
        self.assertFalse(any("X-ASB-Source-Token" in sent for sent in headers))


@unittest.skipUnless(asb.Gtk.init_check(), "A GTK display is not available.")
class MessagesWindowCheck(ActivityFixture, unittest.TestCase):
    SAMPLE = Path(__file__).with_name("fixtures") / "activity" / "messages-sample.json"

    @classmethod
    def setUpClass(cls):
        ActivityFixture.setUpClass.__func__(cls)
        cls.sample = json.loads(cls.SAMPLE.read_text())
        # The sample times are UTC: the buckets, clocks, and day lines are checked in UTC.
        saved = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()

        def restore():
            if saved is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = saved
            time.tzset()
        cls.addClassCleanup(restore)

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="asb-messages-test-")
        self.addCleanup(directory.cleanup)
        patcher = patch.object(asb, "THEME_PATH", Path(directory.name) / "theme.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        settings = asb.Gtk.Settings.get_default()
        self.addCleanup(settings.set_property, "gtk-font-name", settings.get_property("gtk-font-name"))
        settings.set_property("gtk-font-name", "Cantarell 11")
        self.addCleanup(settings.set_property, "gtk-enable-animations", settings.get_property("gtk-enable-animations"))
        settings.set_property("gtk-enable-animations", True)
        self.addCleanup(self.close_windows)
        self.extra, self.routes = [], []
        self.warnings = len(GTK_WARNINGS)
        self.addCleanup(lambda: self.assertEqual(GTK_WARNINGS[self.warnings:], []))

    def fetch(self, route):
        """The engine replies of the sample data: buckets in UTC, the seats of the period, no text in the report, and in a thread
        text only for local messages; an unknown end has the name from the message (record[7], record[8])."""
        from urllib.parse import parse_qs
        self.routes.append(route)
        path, _mark, query = route.partition("?")
        args = {key: values[0] for key, values in parse_qs(query).items()}
        sample, now = self.sample, self.sample["nowMs"]
        count, size = {"24h": (24, 3_600_000), "7d": (7, 86_400_000), "30d": (30, 86_400_000)}[args["period"]]
        starts = [now // size * size - (count - 1 - index) * size for index in range(count)]
        records = sorted((record for record in sample["messages"] + self.extra if record[3] >= starts[0]), key=lambda record: record[3])
        seats = sample["seats"] + [{"id": seat_id, "title": "Other sessions", "app": "", "machineId": seat_id[len("unknown:"):]}
                                   for seat_id in sorted({end for record in records for end in record[1:3] if end.startswith("unknown:")})]
        machine = {seat["id"]: seat["machineId"] for seat in seats}
        local = lambda record: "desk" in (machine[record[1]], machine[record[2]])

        def message(record, text):
            return {"id": record[0], "from": record[1], "to": record[2], "atMs": record[3], "status": record[4], "reason": record[5],
                    "fromLabel": record[7] if len(record) > 7 else "", "toLabel": record[8] if len(record) > 8 else "",
                    "text": record[6] if text and local(record) else None}
        if path == "/api/activity/messages":
            ends = {record[1] for record in records} | {record[2] for record in records}
            return {"period": args["period"], "nowMs": now, "buckets": {"unit": "hour" if count == 24 else "day", "startsMs": starts},
                    "machines": sample["machines"], "truncated": False,
                    "seats": [dict(seat, order=index) for index, seat in enumerate(seats) if seat["id"] in ends],
                    "messages": [{key: value for key, value in dict(message(record, False), local=local(record)).items() if key != "text"}
                                 for record in records]}
        self.assertEqual(path, "/api/activity/thread")
        if "seat" in args:
            mine = [record for record in records if args["seat"] in record[1:3]]
        else:
            mine = [record for record in records if {record[1], record[2]} == {args["a"], args["b"]}]
        return {"total": len(mine), "messages": [message(record, True) for record in mine[-60:]]}

    def window(self, size=(968, 760), refresh=True):
        window = asb.MessagesWindow(self.application, "http://127.0.0.1:1", fetch=self.fetch)
        window.set_default_size(*size)
        window.present()
        self.drain(.2)
        if refresh:
            window.refresh()
            self.drain(.4)
        return window

    def test_custom_header_and_buttons(self):
        self.check_theme_header()

    def test_theme_ledger_surface_and_divider(self):
        asb.THEME_PATH.write_text(json.dumps({"mode": "custom", "colors": self.THEME}))
        # The rendering fixture accent is below the theme editor's contrast limit.
        with patch.object(asb, "validate_theme", return_value=self.THEME):
            window = self.window()
        ledger = window.ledger
        self.assertTrue(ledger.has_css_class("asb-msg-edge"))
        self.assert_pixel(ledger, ledger.get_width() - 3, ledger.get_height() - 3, self.THEME["background"])
        self.assert_pixel(ledger, 0, ledger.get_height() // 2, self.THEME["divider"])

    def records(self, period="7d"):
        now = self.sample["nowMs"]
        count, size = {"24h": (24, 3_600_000), "7d": (7, 86_400_000), "30d": (30, 86_400_000)}[period]
        start = now // size * size - (count - 1) * size
        return [record for record in self.sample["messages"] + self.extra if record[3] >= start]

    @staticmethod
    def labels(widget):
        found, child = [], widget.get_first_child()
        while child is not None:
            if isinstance(child, asb.Gtk.Label) and child.get_visible():
                found.append(child.get_label())
            found.extend(MessagesWindowCheck.labels(child))
            child = child.get_next_sibling()
        return found

    def tree(self, widget):
        found, child = [widget], widget.get_first_child()
        while child is not None:
            found += self.tree(child)
            child = child.get_next_sibling()
        return found

    def test_activity_windows_have_one_slim_row_like_the_board(self):
        replies = UsageWindowCheck.REPLIES
        usage = asb.UsageWindow(self.application, "http://127.0.0.1:1", fetch=lambda route: copy.deepcopy(replies[route.rsplit("=", 1)[1]]))
        usage.set_default_size(948, 760)
        usage.present()
        self.drain(.2)
        usage.refresh()
        self.drain(.4)
        messages = self.window()
        for window, width, periods in ((messages, 480, asb.MESSAGE_PERIODS), (usage, 420, asb.USAGE_PERIODS)):
            with self.subTest(window=window.KIND):
                tree = self.tree(window)
                self.assertFalse(any(isinstance(widget, (asb.Adw.HeaderBar, asb.Adw.WindowTitle)) for widget in tree))
                self.assertFalse(hasattr(window, "title_widget") or hasattr(window, "period_buttons"))
                # The first top bar: nothing before it in the top bars, and the paths note comes next.
                self.assertIs(window.window_handle.get_ancestor(asb.Adw.ToolbarView), window.toolbar_view)
                self.assertIsNone(window.window_handle.get_prev_sibling())
                self.assertIs(window.window_handle.get_next_sibling(), window.paths_note)
                self.assertIs(window.window_handle.get_child(), window.toolbar)
                row = []
                child = window.toolbar.get_first_child()
                while child is not None:
                    row.append(child)
                    child = child.get_next_sibling()
                self.assertEqual(len(row), 6)
                self.assertEqual([row[0], row[1], row[2], row[4], row[5]],
                                 [window.app_mark, window.period_menu, window.toolbar_start, window.toolbar_end, window.window_controls])
                self.assertTrue(type(row[3]) is asb.Gtk.Box and row[3].get_hexpand())
                self.assertEqual((window.app_mark.get_icon_name(), window.app_mark.get_pixel_size(), window.app_mark.get_tooltip_text()),
                                 (asb.APP_ID, 16, "ASB"))
                self.assert_accessible_label(window.app_mark, "ASB app icon")
                self.assertEqual(window.window_controls.get_decoration_layout(), ":close")
                self.assertLessEqual(window.window_handle.get_height(), 34)
                model = window.period_menu.get_model()
                self.assertEqual([model.get_string(index) for index in range(model.get_n_items())], [text for _key, text in periods])
                if window is usage:
                    window.set_period("all")
                    self.drain(.1)
                    self.assertEqual(window.period_menu.get_selected(), model.get_n_items() - 1)
                window.period_menu.set_selected(0)
                self.drain(.2)
                self.assertEqual(window.period, "24h")
                window.set_default_size(width, 760)
                self.drain(.3)
                self.assertEqual(window.get_width(), width)
                _minimum, natural, _base, _natural_base = window.toolbar.measure(asb.Gtk.Orientation.HORIZONTAL, -1)
                self.assertLessEqual(natural, width)
        labels = [widget.get_label() for widget in self.tree(messages) if isinstance(widget, asb.Gtk.Label)]
        self.assertNotIn("Live", labels)
        self.assertFalse(any(text.endswith(" sessions") for text in labels))

    def test_toolbar_has_only_the_period(self):
        window = self.window()
        self.assertEqual(window.get_title(), "Messages")
        self.assertEqual(window.get_default_size(), (968, 760))
        self.assertIs(asb.ACTIVITY_WINDOW_CLASSES["messages"], asb.MessagesWindow)
        self.assertFalse(any(hasattr(window, name) for name in ("chips", "seat_count", "render_toolbar", "title_widget", "session_chip", "feed", "session")))
        self.assertIsNone(window.toolbar_start.get_first_child())
        self.assertIsNone(window.toolbar_end.get_first_child())
        rules = window.css.to_string()
        for name in ("asb-msg-chip", "asb-msg-live", "asb-msg-pulse"):
            self.assertNotIn(name, rules)
        # The machine list of the ledger stays.
        self.assertTrue(window.machine_counts)

    def test_ledger_numbers_equal_the_logic(self):
        window = self.window()
        view = asb.messages_view(window.data)
        self.assertEqual(window.total.get_visible_child().get_label(), asb.format_count(view["total"]))
        self.assertEqual(window.total.get_visible_child().get_label(), "479")
        self.assertEqual({status: label.get_label() for status, label in window.legend_counts.items()},
                         {status: asb.format_count(count) for status, count in view["by_status"].items() if count})
        self.assertEqual(window.share.counts, {status: count for status, count in view["by_status"].items() if count})
        self.assert_accessible_label(window.share, "Accepted 434, Socket written 22, Held 10, Not sent 5, Unknown 8")
        for (source, target), cell in window.matrix_cells.items():
            value = view["matrix"][view["apps"].index(source)][view["apps"].index(target)]
            self.assertEqual(cell.get_label(), asb.format_count(value) if value else "–")
            if not value:
                self.assert_accessible_label(cell, "none")
        self.assertEqual(window.app_pairs.get_label(), "7 app pairs")
        self.assertEqual({ids: label.get_label() for ids, label in window.machine_counts.items()},
                         {row["ids"]: asb.format_count(row["count"]) for row in view["machine_rows"]})
        self.assertEqual([self.labels(row)[:2] for row in window.recent_rows],
                         [[asb.format_clock(record["atMs"]), f"{record['from']} → {record['to']}"] for record in view["recent"]])
        self.assert_accessible_label(window.table, "Machines, sessions and messages")
        self.assertFalse(hasattr(asb, "MessageStrip"))
        self.assertFalse(hasattr(window, "strip"))
        self.assertIs(window.left.get_first_child(), window.table)
        self.assertIs(window.table.get_next_sibling(), window.reader)
        self.assertIsNone(window.reader.get_next_sibling())

    def test_pins_and_chords_have_named_proxies_in_order(self):
        window = self.window()
        view, table = window.view, window.table
        pins = [key for key in table.proxies if key[0] == "pin"]
        chords = [key for key in table.proxies if key[0] == "chord"]
        self.assertEqual([proxy.key for proxy in table.proxy_order], [("pin", seat_id) for seat_id in view["seated"]] + chords)
        self.assertEqual(len(pins), 12)
        seated = set(view["seated"])
        self.assertEqual({key[1] for key in chords}, {key for key, pair in view["pairs"].items() if pair["a"] in seated and pair["b"] in seated})
        names = {machine["machineId"]: machine["name"] for machine in view["machines"]}
        for _kind, seat_id in pins:
            seat, counts = view["seats"][seat_id], view["counts"][seat_id]
            self.assert_accessible_label(table.proxies[("pin", seat_id)], f"{seat_id}, {asb.ACTIVITY_APP_LABELS[seat['app']]}, {names[seat['machineId']]}: "
                                                                          f"{counts['sent']} sent, {counts['received']} received")
        parser = view["counts"]["parser-review"]
        self.assert_accessible_label(table.proxies[("pin", "parser-review")], f"parser-review, Claude Code, Laptop: {parser['sent']} sent, {parser['received']} received")
        pair = view["pairs"][("release-plan", "parser-review")]
        self.assert_accessible_label(table.proxies[("chord", ("release-plan", "parser-review"))], f"release-plan and parser-review: {pair['n']} messages")
        self.assertEqual(pair["n"], 139)
        for proxy in table.proxy_order:
            self.assertTrue(proxy.get_focusable())
            self.assertEqual(proxy.get_accessible_role(), asb.Gtk.AccessibleRole.BUTTON)
        # Tab goes through the pins in circle order, then the chords.
        table.proxy_order[0].grab_focus()
        for proxy in table.proxy_order[1:4]:
            self.assertTrue(table.child_focus(asb.Gtk.DirectionType.TAB_FORWARD))
            self.assertTrue(proxy.has_focus())
        table.proxy_order[11].grab_focus()
        self.assertTrue(table.child_focus(asb.Gtk.DirectionType.TAB_FORWARD))
        self.assertIs(window.get_focus(), table.proxy_order[12])
        self.assertEqual(table.proxy_order[12].key[0], "chord")
        # A chord takes the pointer only near its curve.
        chord = table.proxies[("chord", ("release-plan", "parser-review"))]
        points = chord.curve[0]
        middle = points[32]
        self.assertTrue(chord.contains(middle[0] - chord.origin[0], middle[1] - chord.origin[1]))
        self.assertEqual(table.hit(*middle), (None, ("release-plan", "parser-review")))
        x, y = asb.table_point(table.geometry, table.geometry["Rp"], table.geometry["seat"]["docs"])
        self.assertEqual(table.hit(x + 15, y), ("docs", None))
        self.assertEqual(table.hit(table.geometry["cx"], table.geometry["cy"]), (None, None))

    def test_a_focused_pin_shows_its_center(self):
        window = self.window()
        self.assertEqual(self.labels(window.table.center), ["docs \u2192\u00a0release-plan"])
        window.table.proxies[("pin", "parser-review")].grab_focus()
        self.drain(.05)
        counts = window.view["counts"]["parser-review"]
        self.assertEqual(self.labels(window.table.center),
                         ["parser-review", "Claude Code · Laptop", "Sent", asb.format_count(counts["sent"]), "Received", asb.format_count(counts["received"])])
        self.assertEqual((counts["sent"], counts["received"]), (81, 109))
        self.assertTrue(window.table.labels["parser-review"]["shown"])
        window.table.pointer_moved(None, *window.table.chords[0]["table"][0][32])
        pair = window.view["pairs"][window.table.chords[0]["key"]]
        self.assertEqual(self.labels(window.table.center)[1:3], [f"→ {pair['ab']}", f"← {pair['ba']}"])

    def test_a_pair_thread_and_escape(self):
        window = self.window()
        key = ("release-plan", "parser-review")
        proxy = window.table.proxies[("chord", key)]
        self.assertTrue(proxy.key_pressed(None, asb.Gdk.KEY_Return, 0, 0))
        self.drain(.3)
        self.assertEqual(window.ledger.get_visible_child_name(), "thread")
        self.assertEqual(window.thread_route.get_label(), "release-plan ⇄ parser-review")
        mine = [record for record in self.records() if {record[1], record[2]} == set(key)]
        forward = sum(record[1] == "release-plan" for record in mine)
        self.assertEqual(window.thread_counts.get_label(), f"→ {forward}  ← {len(mine) - forward}")
        self.assertEqual(len(mine), 139)
        self.assertEqual(self.labels(window.thread_list)[0], "Latest 60 of 139")
        self.assertEqual(list(window.thread_blocks), [record[0] for record in mine[-60:]])
        last = window.thread_blocks[mine[-1][0]]
        self.assertEqual(self.labels(last)[-1], mine[-1][6])
        self.assertEqual(last.get_halign(), asb.Gtk.Align.START if mine[-1][1] == "release-plan" else asb.Gtk.Align.END)
        self.assertIn("/api/activity/thread?period=7d&a=release-plan&b=parser-review", self.routes)
        self.assertIn(asb.day_line(mine[-1][3], self.sample["nowMs"]), self.labels(window.thread_list))
        # A pair with no local endpoint shows no text.
        window.open_thread("pair", ("parser-review", "render-farm"))
        self.assertTrue(window.thread_blocks)
        self.assertTrue(all(self.labels(block)[-1] == "No text" for block in window.thread_blocks.values()))
        self.assertTrue(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
        self.drain(.3)
        self.assertEqual(window.ledger.get_visible_child_name(), "stats")
        self.assertIsNone(window.thread)
        self.assertFalse(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
        # A click on an empty part of the table closes a thread too.
        window.open_thread("pair", key)
        window.table.clicked(None, 1, window.table.geometry["cx"], window.table.geometry["cy"])
        self.assertIsNone(window.thread)

    def test_show_session_opens_and_seats_the_session(self):
        window = self.window()
        outside = next(seat_id for seat_id in window.view["circle"] if seat_id not in window.view["seated"])
        window.show_session(outside)
        self.drain(.6)
        self.assertEqual(window.ledger.get_visible_child_name(), "thread")
        self.assertIn(outside, window.view["seated"])
        self.assertEqual(len(window.view["seated"]), 12)
        self.assertIn(("pin", outside), window.table.proxies)
        self.assertIn(f"/api/activity/thread?period=7d&seat={outside}", self.routes)
        window.show_session("parser-review")
        self.drain(.6)
        self.assertEqual(window.thread_route.get_label(), "parser-review")
        self.assertEqual(window.thread_counts.get_label(), "Sent 81  Received 109")
        self.assertTrue(window.table.proxies[("pin", "parser-review")].has_focus())
        first = next(iter(window.thread_blocks))
        record = next(record for record in self.records() if record[0] == first)
        self.assertEqual(self.labels(window.thread_blocks[first])[0], ("→ " + record[2]) if record[1] == "parser-review" else ("← " + record[1]))
        # A card with no message in the period.
        window.show_session("not-in-reply", "Write the API examples")
        self.assertEqual(window.thread_route.get_label(), "Write the API examples")
        self.assertEqual(window.thread_counts.get_label(), "Sent 0  Received 0")
        self.assertEqual(self.labels(window.thread_list), ["No messages in 7 days."])
        window.show_session("not-in-reply")
        self.assertEqual(window.thread_route.get_label(), "This session")
        # Before the first reply, the window waits.
        later = self.window(refresh=False)
        later.show_session("docs")
        self.assertIsNone(later.thread)
        later.refresh()
        self.assertEqual(later.thread["key"], "docs")
        self.assertEqual(later.thread_route.get_label(), "docs")

    def test_a_recent_row_opens_its_message(self):
        window = self.window()
        record = window.view["recent"][2]
        window.recent_rows[2].emit("clicked")
        self.drain(.3)
        self.assertEqual(set(window.thread["key"]), {record["from"], record["to"]})
        block = window.thread_blocks[record["id"]]
        self.assertTrue(block.has_css_class("asb-msg-hl"))
        self.assertIn("outline", window.css.to_string())
        self.drain(1.3)
        self.assertFalse(block.has_css_class("asb-msg-hl"))

    def test_a_removed_scroll_target_ends_the_scroll_tick(self):
        window = self.window()
        window.recent_rows[2].emit("clicked")
        self.assertIsNotNone(window.scroll_tick)
        # A refresh before the next frame rebuilds the list, so the target block has no parent.
        window.thread_stick = False
        window.render_thread_list()
        self.drain(.2)
        self.assertIsNone(window.scroll_tick)
        self.assertIsNone(window.scroll_target)

    def long_thread(self):
        """70 made-up messages of 2,000 characters on 3 days between icons and lint, which have no sample messages; the thread shows 60."""
        text = "Check the parser notes and keep the release steps in order before the next build. " * 25
        now = self.sample["nowMs"]
        self.extra = [[f"m-long-{index:02d}", ("icons", "lint")[index % 3 == 0], ("lint", "icons")[index % 3 == 0],
                       now - (70 - index) * 3_600_000, "accepted", "", f"{index}: {text}"[:2000]] for index in range(70)]
        return [record[0] for record in self.extra[-60:]]

    def next_frame(self, window):
        """Run the main loop up to the end of the next painted frame, and no further."""
        painted = []
        clock = window.get_frame_clock()
        handler = clock.connect("after-paint", lambda *_args: painted.append(True))
        context, end = asb.GLib.MainContext.default(), time.monotonic() + 2
        while not painted and time.monotonic() < end:
            if not context.iteration(False):
                time.sleep(.002)
        clock.disconnect(handler)
        self.assertTrue(painted)

    def steps_done(self, window):
        return window.thread_idle is None and window.scroll_tick is None

    def place(self, window, widget):
        """The bounds of a widget in the thread view: the page slides in, so the window bounds move while it slides."""
        found, bounds = widget.compute_bounds(window.thread_scroll)
        self.assertTrue(found)
        return (bounds.get_x(), bounds.get_y(), bounds.get_width(), bounds.get_height())

    def view_top(self, window, widget):
        """The top of a widget in the thread view, and the view height."""
        adjustment = window.thread_scroll.get_vadjustment()
        found, point = widget.compute_point(window.thread_list, asb.Graphene.Point().init(0, 0))
        self.assertTrue(found)
        return point.y - adjustment.get_value(), adjustment.get_page_size()

    def assert_only_route(self, box, route):
        """The center or the reader has one widget: the route label."""
        widgets = self.tree(box)[1:]
        self.assertEqual(len(widgets), 1, [type(widget).__name__ for widget in widgets])
        self.assertIsInstance(widgets[0], asb.Gtk.Label)
        self.assertTrue(widgets[0].has_css_class("asb-msg-c-route"))
        self.assertEqual(widgets[0].get_label(), route)
        self.assertNotIn("No text", self.all_labels(box.get_root()))

    def test_the_center_shows_only_the_route_of_the_newest_message(self):
        window = self.window()
        self.assert_only_route(window.table.center, "docs \u2192\u00a0release-plan")
        # A newest message with no text shows its route too.
        self.extra = [["m-none", "release-plan", "parser-review", self.sample["nowMs"] - 1000, "accepted", "", None]]
        window.refresh(); self.drain(.3)
        self.assert_only_route(window.table.center, "release-plan \u2192\u00a0parser-review")

    def test_the_narrow_reader_shows_only_the_route_of_the_newest_message(self):
        window = self.window((490, 800))
        self.wait_for(lambda: window.narrow_scroll.get_visible() and window.reader.get_visible())
        self.assertTrue(window.reader.get_visible())
        self.assert_only_route(window.reader, "docs \u2192\u00a0release-plan")

    def test_an_unknown_end_shows_the_name_from_the_message_in_the_center(self):
        self.extra = [["m-in", "unknown:laptop", "docs", self.sample["nowMs"] - 1000, "held", "", "From a helper.", "beta-helper", ""]]
        window = self.window()
        self.assert_only_route(window.table.center, "beta-helper \u2192\u00a0docs")
        self.extra = [["m-out", "docs", "unknown:laptop", self.sample["nowMs"] - 500, "accepted", "", "To a helper.", "", ""]]
        window.refresh(); self.drain(.3)
        self.assert_only_route(window.table.center, "docs \u2192\u00a0Other sessions")

    def test_a_long_thread_shows_the_newest_blocks_first_and_builds_the_others_in_steps(self):
        window = self.window()
        ids = self.long_thread()
        window.refresh(); self.drain(.3)
        window.open_thread("pair", ("icons", "lint"))
        self.next_frame(window)
        built = list(window.thread_blocks)
        self.assertLess(len(built), 60)
        self.assertEqual(built, ids[-len(built):])
        # The blocks fill the view plus one block: all but the oldest built block fill it, and the newest without the next oldest do not.
        oldest, second = window.thread_blocks[built[0]], window.thread_blocks[built[1]]
        top, page = self.view_top(window, oldest)
        self.assertLessEqual(top + oldest.get_height(), 1)
        top, page = self.view_top(window, second)
        self.assertGreater(top + second.get_height(), 0)
        adjustment = window.thread_scroll.get_vadjustment()
        self.assertEqual(adjustment.get_value(), adjustment.get_upper() - adjustment.get_page_size())
        newest = window.thread_blocks[ids[-1]]
        place = self.place(window, newest)
        self.assertFalse(self.steps_done(window))
        self.wait_for(lambda: self.steps_done(window) and len(window.thread_blocks) == 60, 6)
        self.assertEqual(list(window.thread_blocks), ids)
        self.assertEqual(self.place(window, newest), place)
        # The rows and the children are in order: Latest 60, then each day line over the first block of its day.
        expected, day = ["Latest 60 of 70"], None
        for record in self.extra[-60:]:
            name = asb.day_line(record[3], self.sample["nowMs"])
            if name != day:
                expected.append(name)
                day = name
            expected.append(record[6])
        children, child = [], window.thread_list.get_first_child()
        while child is not None:
            children.append(child)
            child = child.get_next_sibling()
        self.assertEqual([self.labels(child)[-1] if isinstance(child, asb.Gtk.Box) else child.get_label() for child in children], expected)
        rows = [window.thread_list.query_child(child)[1] for child in children]
        self.assertEqual(rows, list(range(len(children))))
        self.assertGreater(len(expected), 62)
        for record in self.extra[-60:]:
            block = window.thread_blocks[record[0]]
            self.assertEqual(block.get_halign(), asb.Gtk.Align.START if record[1] == "icons" else asb.Gtk.Align.END)
            self.assertEqual(block.has_css_class("asb-msg-first"), isinstance(block.get_prev_sibling(), asb.Gtk.Label))
        self.assertEqual(sum(child.has_css_class("asb-msg-first") for child in children), len(expected) - 61)

    def test_a_recent_row_on_an_old_message_shows_it_in_the_first_frame(self):
        window = self.window()
        ids = self.long_thread()
        window.refresh(); self.drain(.3)
        record = next(record for record in window.data["messages"] if record["id"] == ids[20])
        window.recent_clicked(None, record)
        self.next_frame(window)
        self.assertLess(len(window.thread_blocks), 60)
        target = window.thread_blocks[ids[20]]
        self.assertTrue(target.has_css_class("asb-msg-hl"))
        top, page = self.view_top(window, target)
        self.assertAlmostEqual(top, page / 2, delta=1)
        place = self.place(window, target)
        moved = []
        clock = window.get_frame_clock()

        def painted(*_args):
            if self.place(window, target) != place:
                moved.append(self.place(window, target))
        handler = clock.connect("after-paint", painted)
        self.wait_for(lambda: self.steps_done(window) and len(window.thread_blocks) == 60, 6)
        clock.disconnect(handler)
        self.assertEqual(list(window.thread_blocks), ids)
        self.assertEqual(moved, [])

    def test_back_or_a_new_thread_ends_the_steps_of_a_long_thread(self):
        window = self.window()
        self.long_thread()
        window.refresh(); self.drain(.3)
        window.open_thread("pair", ("icons", "lint"))
        self.next_frame(window)
        self.wait_for(lambda: window.thread_idle is not None, 2)
        source = window.thread_idle
        count = len(list(self.tree(window.thread_list)))
        self.thread_page_back(window).emit("clicked")
        self.assertEqual((window.thread, window.thread_idle, window.scroll_tick), (None, None, None))
        self.assertIsNone(asb.GLib.MainContext.default().find_source_by_id(source))
        self.drain(.5)
        self.assertEqual(len(list(self.tree(window.thread_list))), count)
        # A new thread during the steps shows only its own blocks.
        window.open_thread("pair", ("icons", "lint"))
        self.next_frame(window)
        self.assertFalse(self.steps_done(window))
        window.open_thread("pair", ("docs", "release-plan"))
        self.wait_for(lambda: self.steps_done(window), 6)
        reply = self.fetch("/api/activity/thread?period=7d&a=docs&b=release-plan")
        self.assertEqual(list(window.thread_blocks), [record["id"] for record in reply["messages"]])
        blocks = [child for child in self.tree(window.thread_list) if isinstance(child, asb.Gtk.Box) and child.has_css_class("asb-msg-block")]
        self.assertEqual(blocks, list(window.thread_blocks.values()))

    def open_long_thread(self):
        window = self.window()
        ids = self.long_thread()
        window.refresh(); self.drain(.3)
        window.open_thread("pair", ("icons", "lint"))
        self.wait_for(lambda: self.steps_done(window) and len(window.thread_blocks) == 60, 6)
        self.assertEqual(list(window.thread_blocks), ids)
        return window

    def test_a_refresh_with_the_same_thread_look_keeps_every_thread_widget(self):
        window = self.open_long_thread()
        children = self.tree(window.thread_list)
        blocks = dict(window.thread_blocks)
        self.extra.append(["m-other", "docs", "release-plan", self.sample["nowMs"] - 500, "accepted", "", "Another pair."])
        window.refresh()
        self.assertIsNone(window.thread_idle)
        self.drain(.3)
        self.assertEqual(window.view["recent"][0]["id"], "m-other")
        self.assertEqual(self.tree(window.thread_list), children)
        self.assertEqual(window.thread_blocks, blocks)
        self.assertTrue(all(window.thread_blocks[key] is block for key, block in blocks.items()))
        self.assertEqual((window.thread_idle, window.scroll_tick), (None, None))
        self.assertEqual(window.thread_route.get_label(), "icons ⇄ lint")
        self.assertEqual(window.thread_counts.get_label(), f"→ {sum(record[1] == 'icons' for record in self.extra[:70])}  "
                                                           f"← {sum(record[1] == 'lint' for record in self.extra[:70])}")

    def test_a_new_thread_reply_keeps_the_block_at_the_view_top(self):
        window = self.open_long_thread()
        adjustment = window.thread_scroll.get_vadjustment()
        adjustment.set_value(adjustment.get_upper() / 2)
        self.next_frame(window)
        self.assertFalse(window.thread_stick)
        kept, top = next((key, self.view_top(window, block)[0]) for key, block in window.thread_blocks.items()
                         if self.view_top(window, block)[0] + block.get_height() > 0)
        self.assertGreater(list(window.thread_blocks).index(kept), 10)
        self.extra.append(["m-long-new", "icons", "lint", self.sample["nowMs"] - 500, "accepted", "", "One more message."])
        tops = []
        clock = window.get_frame_clock()
        handler = clock.connect("after-paint", lambda *_args: tops.append(self.view_top(window, window.thread_blocks[kept])[0]))
        old = window.thread_blocks[kept]
        window.refresh()
        self.assertIsNot(window.thread_blocks[kept], old)
        self.assertLess(len(window.thread_blocks), 60)
        self.wait_for(lambda: self.steps_done(window) and len(window.thread_blocks) == 60, 6)
        clock.disconnect(handler)
        self.assertEqual(list(window.thread_blocks)[-1], "m-long-new")
        self.assertGreater(len(tops), 2)
        self.assertTrue(all(abs(value - top) <= 1 for value in tops), (top, tops))
        self.assertFalse(any(block.has_css_class("asb-msg-hl") for block in window.thread_blocks.values()))

    def test_a_new_message_at_the_bottom_shows_at_the_bottom(self):
        window = self.open_long_thread()
        self.assertTrue(window.thread_stick)
        self.extra.append(["m-long-new", "lint", "icons", self.sample["nowMs"] - 500, "accepted", "", "One more message."])
        window.refresh()
        self.next_frame(window)
        newest = window.thread_blocks["m-long-new"]
        adjustment = window.thread_scroll.get_vadjustment()
        _x, y, _width, height = self.place(window, newest)
        # The newest block ends at the view bottom, over the 4 px bottom padding of the list.
        self.assertTrue(adjustment.get_page_size() - 12 <= y + height <= adjustment.get_page_size(), (y, height))
        self.assertEqual(adjustment.get_value(), adjustment.get_upper() - adjustment.get_page_size())

    def test_a_period_change_during_the_steps_still_builds_the_whole_thread(self):
        window = self.window()
        ids = self.long_thread()
        window.refresh(); self.drain(.3)
        window.open_thread("pair", ("icons", "lint"))
        self.next_frame(window)
        self.assertLess(len(window.thread_blocks), 60)
        window.set_period("30d")
        # The 30d thread reply is the same as the 7d one.
        self.assertEqual(self.fetch("/api/activity/thread?period=30d&a=icons&b=lint"), window.thread_reply)
        self.wait_for(lambda: self.steps_done(window) and len(window.thread_blocks) == 60, 6)
        self.assertEqual(window.period, "30d")
        self.assertEqual(list(window.thread_blocks), ids)
        days = []
        for record in self.extra[-60:]:
            name = asb.day_line(record[3], self.sample["nowMs"])
            if name not in days:
                days.append(name)
        self.assertEqual([text for text in self.labels(window.thread_list) if text in days], days)

    def thread_page_back(self, window):
        head = window.ledger.get_child_by_name("thread").get_first_child()
        return head.get_first_child()

    def all_labels(self, window):
        return [widget.get_label() for widget in self.tree(window) if isinstance(widget, asb.Gtk.Label) and widget.get_mapped()]

    def test_the_window_opens_on_the_totals_and_reads_no_thread_before_a_click(self):
        window = self.window()
        self.assertEqual(window.ledger.get_visible_child_name(), "stats")
        self.assertIsNone(window.thread)
        self.assertIsNone(window.thread_list.get_first_child())
        self.assertEqual(self.routes, ["/api/activity/messages?period=7d"])
        # The report has no text, as from the engine: the reply key, the lights, and the center work without it.
        self.assertFalse(any("text" in record for record in window.data["messages"]))
        # No message text shows before a thread opens: the center has only the route of the newest message.
        texts = {record[6] for record in self.records() if record[6]}
        self.assertFalse(texts & set(self.all_labels(window)))
        self.assertEqual(self.labels(window.table.center), ["docs \u2192\u00a0release-plan"])
        # Focus, hover, a period change, and a new message open nothing.
        window.table.proxies[("pin", "docs")].grab_focus()
        window.table.pointer_moved(None, *window.table.chords[0]["table"][0][32])
        window.table.pointer_left()
        window.set_period("24h"); self.drain(.2)
        self.extra = [["m-quiet", "docs", "release-plan", self.sample["nowMs"] - 1000, "accepted", "", "Quiet text."]]
        window.refresh(); self.drain(.2)
        self.assertIsNone(window.thread)
        self.assertEqual(window.ledger.get_visible_child_name(), "stats")
        self.assertFalse([route for route in self.routes if route.startswith("/api/activity/thread")])

    def test_each_opener_shows_the_thread_and_escape_or_back_shows_the_totals(self):
        window = self.window()
        table = window.table
        pair = ("release-plan", "parser-review")
        middle = next(chord for chord in table.chords if chord["key"] == pair)["table"][0][32]
        pin = asb.table_point(table.geometry, table.geometry["Rp"], table.geometry["seat"]["docs"])
        label = next(seat_id for seat_id, item in table.labels.items() if item["shown"])
        box = table.labels[label]["box"]
        recent = window.view["recent"][0]
        circle = window.view["circle"]
        openers = (("chord click", lambda: table.clicked(None, 1, *middle), ("pair", pair)),
                   ("pin click", lambda: table.clicked(None, 1, *pin), ("session", "docs")),
                   ("seat label click", lambda: table.clicked(None, 1, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2), ("session", label)),
                   ("Recent row", lambda: window.recent_rows[0].emit("clicked"), ("pair", tuple(sorted((recent["from"], recent["to"]), key=circle.index)))),
                   ("Enter on a pin", lambda: table.proxies[("pin", "parser-review")].key_pressed(None, asb.Gdk.KEY_Return, 0, 0), ("session", "parser-review")),
                   ("Space on a chord", lambda: table.proxies[("chord", pair)].key_pressed(None, asb.Gdk.KEY_space, 0, 0), ("pair", pair)))
        for index, (name, opener, (kind, key)) in enumerate(openers):
            with self.subTest(opener=name):
                self.routes.clear()
                opener(); self.drain(.3)
                self.assertEqual((window.thread["kind"], window.thread["key"]), (kind, key))
                self.assertEqual(window.ledger.get_visible_child_name(), "thread")
                query = f"a={key[0]}&b={key[1]}" if kind == "pair" else f"seat={key}"
                self.assertEqual(self.routes, [f"/api/activity/thread?period=7d&{query}"])
                texts = [self.labels(block)[-1] for block in window.thread_blocks.values()]
                reply = self.fetch(self.routes[0])
                self.assertTrue(texts)
                self.assertEqual(texts, [record["text"] if record["text"] is not None else "No text" for record in reply["messages"]])
                if index % 2:
                    self.thread_page_back(window).emit("clicked")
                else:
                    self.assertTrue(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))
                self.drain(.3)
                self.assertIsNone(window.thread)
                self.assertEqual(window.ledger.get_visible_child_name(), "stats")
        back = self.thread_page_back(window)
        self.assertEqual(back.get_tooltip_text(), "Back to totals")
        self.assert_accessible_label(back, "Back to totals")

    def test_names_texts_and_reasons_come_from_the_reply(self):
        now = self.sample["nowMs"]
        long_text = ("Check the guide and keep the release steps in order. " * 11 + "\n\n") * 2
        self.extra = [["m-long", "docs", "release-plan", now - 4000, "accepted", "", long_text],
                      ["m-in", "unknown:laptop", "docs", now - 3000, "held", "", "From a helper.", "beta-helper", ""],
                      ["m-out", "docs", "unknown:laptop", now - 2000, "written", "", "To a helper.", "", "gamma-helper"],
                      ["m-off", "unknown:laptop", "docs", now - 1000, "not-sent", "Machine offline", None, "beta-helper", ""]]
        window = self.window()
        # The center: the route with the name from the message, with no thread read.
        self.assertEqual(self.labels(window.table.center), ["beta-helper \u2192\u00a0docs"])
        self.assertEqual(self.routes, ["/api/activity/messages?period=7d"])
        self.assertEqual([self.labels(row)[1] for row in window.recent_rows[:4]],
                         ["beta-helper \u2192 docs", "docs \u2192 gamma-helper", "beta-helper \u2192 docs", "docs \u2192 release-plan"])
        self.assertEqual(window.recent_rows[0].get_child().get_last_child().get_tooltip_text(), "Machine offline")
        # The thread of the session: sender lines, status marks, and texts.
        window.show_session("docs"); self.drain(.3)
        blocks = window.thread_blocks
        self.assertEqual(self.labels(blocks["m-off"]), ["\u2190 beta-helper", asb.format_clock(now - 1000), "Machine offline", "No text"])
        self.assertTrue(blocks["m-off"].get_last_child().has_css_class("asb-dim"))
        self.assertEqual(self.labels(blocks["m-out"]), ["\u2192 gamma-helper", asb.format_clock(now - 2000), "Socket written", "To a helper."])
        self.assertEqual(self.labels(blocks["m-in"]), ["\u2190 beta-helper", asb.format_clock(now - 3000), "Held", "From a helper."])
        # Accepted shows no mark; the text keeps its line breaks, wraps, and can be selected.
        self.assertEqual(self.labels(blocks["m-long"]), ["\u2192 release-plan", asb.format_clock(now - 4000), long_text])
        text = blocks["m-long"].get_last_child()
        self.assertFalse(text.has_css_class("asb-dim"))
        self.assertEqual((text.get_wrap(), text.get_wrap_mode(), text.get_selectable(), text.get_width_chars()),
                         (True, asb.Pango.WrapMode.WORD_CHAR, True, 20))
        self.assertLessEqual(blocks["m-long"].get_width(), window.thread_list.get_width())
        self.assertNotIn("Body not shared", self.all_labels(window))

    def test_the_thread_reads_with_the_default_priority(self):
        window = self.window()
        window.fetch = None
        with patch.object(asb, "request_async") as request:
            window.open_thread("pair", ("release-plan", "parser-review"))
        self.assertEqual(request.call_args.args[1], "/api/activity/thread?period=7d&a=release-plan&b=parser-review")
        callback = Mock(return_value=False)
        with patch.object(asb.GLib, "idle_add") as idle:
            request.call_args.args[3](callback, {"total": 0, "messages": []}, None)
        idle.assert_called_once_with(callback, {"total": 0, "messages": []}, None, priority=asb.GLib.PRIORITY_DEFAULT)

    def test_a_hidden_window_closes_the_thread_and_stops_the_motion_and_finish_stops_it_too(self):
        window = self.window()
        window.set_period("30d"); self.drain(.3)
        window.open_thread("pair", ("release-plan", "parser-review")); self.drain(.3)
        self.extra = [["m-live", "release-plan", "parser-review", self.sample["nowMs"] - 1000, "accepted", "", "Live text."]]
        window.refresh()
        self.assertTrue(window.table.flights)
        self.assertIsNotNone(window.table.tick_id)
        window.close_to_hidden(); self.drain(.2)
        self.assertFalse(window.get_visible())
        self.assertEqual((window.thread, window.table.flights, window.table.rings, window.table.tick_id, window.table.move), (None, [], [], None, None))
        self.assertEqual(window.ledger.get_visible_child_name(), "stats")
        window.present(); self.drain(.3)
        self.assertEqual((window.period, window.period_menu.get_selected()), ("30d", 2))
        self.assertIsNone(window.thread)
        self.assertEqual(window.ledger.get_visible_child_name(), "stats")
        self.extra.append(["m-live-2", "release-plan", "parser-review", self.sample["nowMs"] - 500, "accepted", "", "Live text."])
        window.refresh()
        self.assertIsNotNone(window.table.tick_id)
        window.finish()
        self.assertEqual((window.table.flights, window.table.tick_id), ([], None))
        self.assertTrue(window.closed)

    def test_at_rest_no_tick_runs_and_a_tick_ends_with_its_motion(self):
        window = self.window()
        self.drain(.6)
        self.assertEqual((window.table.tick_id, window.scroll_tick, window.event_timer, window.poll_timer), (None, None, None, None))
        # A new seat moves, its light flies, and then the tick ends.
        outside = next(seat_id for seat_id in window.view["circle"] if seat_id not in window.view["seated"])
        self.extra = [["m-seat", outside, window.view["seated"][0], self.sample["nowMs"] - 1000, "accepted", "", None]]
        window.refresh()
        self.assertIsNotNone(window.table.tick_id)
        self.wait_for(lambda: window.table.tick_id is None, 4)
        self.assertEqual((window.table.tick_id, window.table.move, window.table.flights, window.table.rings), (None, None, [], []))

    def test_lights_play_only_for_new_recent_messages_and_at_most_six(self):
        now = self.sample["nowMs"]
        # The first reply plays nothing, also with a message of one second ago.
        self.extra = [["m-first", "release-plan", "parser-review", now - 1000, "accepted", "", None]]
        window = self.window()
        self.assertEqual(window.table.flights, [])
        # A new message older than 120 s plays nothing.
        self.extra.append(["m-old", "release-plan", "parser-review", now - 121_000, "accepted", "", None])
        window.refresh()
        self.assertEqual(window.table.flights, [])
        self.extra += [[f"m-burst-{index}", "release-plan", "parser-review", now - 900 + index, "accepted", "", None] for index in range(8)]
        window.refresh()
        self.assertEqual(asb.MESSAGE_FLIGHT_LIMIT, 6)
        self.assertEqual(len(window.table.flights), 6)
        self.extra.append(["m-more", "release-plan", "parser-review", now - 800, "accepted", "", None])
        window.refresh()
        self.assertEqual(len(window.table.flights), 6)
        window.table.stop_motion()
        with patch.object(asb, "ACTIVITY_PATHS", False):
            self.extra.append(["m-flat", "release-plan", "parser-review", now - 700, "accepted", "", None])
            window.refresh()
            self.assertEqual(window.table.flights, [])

    def test_the_same_view_changes_no_widget_and_queues_no_draw(self):
        window = self.window()
        window.open_thread("pair", ("release-plan", "parser-review")); self.drain(.3)
        fetch = window.fetch

        def later(route):
            reply = fetch(route)
            if route.startswith("/api/activity/messages"):
                reply["nowMs"] += 30_000
                reply["machines"] = [dict(machine, lastReportAtMs=machine.get("lastReportAtMs", 0) + 30_000) for machine in reply["machines"]]
            return reply
        window.fetch = later

        def widgets():
            return [self.tree(part) for part in (window.stats, window.thread_list, window.table.center, window.reader)]
        before, routes = widgets(), len(self.routes)
        with patch.object(window.table.canvas, "queue_draw") as canvas, patch.object(window.table, "queue_draw") as table, \
                patch.object(window.share, "queue_draw") as share, patch.object(window.table, "queue_allocate") as allocate:
            window.refresh(); self.drain(.2)
            self.assertEqual(widgets(), before)
            self.assertEqual((canvas.call_count, table.call_count, share.call_count, allocate.call_count), (0, 0, 0, 0))
            self.assertEqual(len(self.routes), routes + 1)
            # A changed status changes the view.
            self.sample = copy.deepcopy(self.sample)
            self.sample["messages"][-1][4] = "held"
            window.refresh(); self.drain(.2)
            self.assertGreater(canvas.call_count, 0)
        self.assertNotEqual(widgets(), before)

    def test_a_live_message_flies_only_with_animations(self):
        for animations in (True, False):
            with self.subTest(animations=animations):
                asb.Gtk.Settings.get_default().set_property("gtk-enable-animations", animations)
                self.extra = []
                window = self.window()
                total = window.view["total"]
                self.extra = [["m-live", "release-plan", "parser-review", self.sample["nowMs"] - 1000, "accepted", "", "Check parser edge cases."]]
                window.refresh()
                self.assertEqual(window.total.get_visible_child().get_label(), asb.format_count(total + 1))
                self.assertEqual(window.total.get_transition_type(), asb.Gtk.StackTransitionType.CROSSFADE)
                self.assertEqual(len(window.table.flights), 1 if animations else 0)
                self.assertEqual(self.labels(window.recent_rows[0])[1], "release-plan → parser-review")
                if animations:
                    self.assertEqual(window.table.flights[0]["key"], ("release-plan", "parser-review"))
                    self.drain(1.5)
                    self.assertEqual((window.table.flights, window.table.rings, window.table.tick_id), ([], [], None))
                window.close()
                self.drain(.05)

    def test_a_new_session_takes_a_seat_before_its_light_flies(self):
        window = self.window()
        outside = next(seat_id for seat_id in window.view["circle"] if seat_id not in window.view["seated"])
        partner = window.view["seated"][0]
        self.extra = [["m-seat", outside, partner, self.sample["nowMs"] - 1000, "accepted", "", None]]
        window.refresh()
        self.assertIn(outside, window.view["seated"])
        self.assertEqual(len(window.view["seated"]), 12)
        self.assertIsNotNone(window.table.move)
        self.assertEqual(window.table.flights, [])
        self.drain(.45)
        self.assertEqual([flight["from"] for flight in window.table.flights], [outside])
        self.drain(1.5)
        self.assertIsNone(window.table.move)
        asb.Gtk.Settings.get_default().set_property("gtk-enable-animations", False)
        self.extra.append(["m-seat-2", window.view["circle"][-1], partner, self.sample["nowMs"] - 500, "accepted", "", None])
        window.refresh()
        self.assertIsNone(window.table.move)
        self.assertEqual(window.table.flights, [])

    def test_a_not_sent_light_stops_short(self):
        window = self.window()
        self.extra = [["m-fail", "release-plan", "sync-check", self.sample["nowMs"] - 1000, "not-sent", "Machine offline", None]]
        window.refresh()
        self.assertEqual([flight["end"] for flight in window.table.flights], [.85])

    def test_seat_labels_do_not_overlap(self):
        def overlap(a, b):
            return a[0] < b[2] - .5 and b[0] < a[2] - .5 and a[1] < b[3] - .5 and b[1] < a[3] - .5
        for size in ((968, 760), (1440, 900)):
            with self.subTest(size=size):
                window = self.window(size)
                table = window.table
                self.assertEqual(window.get_width(), size[0])
                shown = [label["box"] for label in table.labels.values() if label["shown"]]
                self.assertGreaterEqual(len(shown), 10)
                pins = []
                for seat_id in table.pins:
                    x, y = asb.table_point(table.geometry, table.geometry["Rp"], table.geometry["seat"][seat_id])
                    pins.append((x - 16, y - 16, x + 16, y + 16))
                machines = [(item["x"], item["y"], item["x"] + item["w"], item["y"] + item["h"]) for entries in table.machine_items.values() for item in entries]
                for index, box in enumerate(shown):
                    self.assertFalse(any(overlap(box, other) for other in shown[index + 1:] + pins + machines))
                window.close()
                self.drain(.05)

    def wait_for(self, condition, timeout=3):
        """Drain until the window reaches a state: a resize on a busy display can take more than one frame."""
        end = time.monotonic() + timeout
        while not condition() and time.monotonic() < end:
            self.drain(.05)

    def test_the_narrow_layout_shows_the_reader(self):
        window = self.window((490, 800))
        self.wait_for(lambda: window.narrow_scroll.get_visible() and window.reader.get_visible())
        self.assertTrue(window.narrow_scroll.get_visible())
        self.assertFalse(window.wide.get_visible())
        self.assertIs(window.ledger.get_parent(), window.narrow_box)
        self.assertFalse(window.ledger.has_css_class("asb-msg-edge"))
        self.assertEqual(window.table.get_height(), min(window.table.get_width(), 560))
        self.assertTrue(window.table.small)
        self.assertTrue(window.reader.get_visible())
        self.assertFalse(window.table.center.get_visible())
        self.assertEqual(self.labels(window.reader), ["docs →\u00a0release-plan"])
        window.set_default_size(968, 760)
        # The layout after the reader hides gives the table the whole column: wait for it, not only for the shown center.
        self.wait_for(lambda: window.wide.get_visible() and window.table.center.get_visible()
                      and window.table.get_height() == window.left.get_height())
        self.assertTrue(window.wide.get_visible())
        self.assertTrue(window.ledger.has_css_class("asb-msg-edge"))
        self.assertFalse(window.reader.get_visible())
        self.assertTrue(window.table.center.get_visible())
        # The wide layout has no reader, so the table keeps the whole column.
        self.assertFalse(window.table.small)
        self.assertEqual(window.table.get_height(), window.left.get_height())
        window.set_default_size(968, 520)
        self.wait_for(lambda: window.table.small and not window.table.center.get_visible()
                      and window.table.get_height() == window.left.get_height())
        self.assertTrue(window.wide.get_visible())
        self.assertTrue(window.table.small)
        self.assertFalse(window.table.center.get_visible())
        self.assertFalse(window.reader.get_visible())
        self.assertEqual(window.table.get_height(), window.left.get_height())

    def test_the_narrow_ledger_shows_two_columns_from_640_to_899_px(self):
        window = self.window((860, 860))
        horizontal, vertical = asb.Gtk.Orientation.HORIZONTAL, asb.Gtk.Orientation.VERTICAL
        children = UsageWindowCheck.children
        self.wait_for(lambda: window.narrow_scroll.get_visible() and window.stats.get_orientation() == horizontal)
        self.assertTrue(window.narrow_scroll.get_visible())
        self.assertEqual(window.stats.get_orientation(), horizontal)
        self.assertTrue(window.stats.get_homogeneous())
        first, second = children(window.stats)
        self.assertIs(window.machines_section.get_parent(), second)
        found, left = first.get_first_child().compute_bounds(window)
        self.assertTrue(found)
        found, right = second.get_first_child().compute_bounds(window)
        self.assertTrue(found)
        self.assertEqual(left.get_y(), right.get_y())
        apps, recent = children(first)[1], children(second)[1]
        self.assertEqual([self.labels(part)[0] for part in children(first) + children(second)],
                         ["Messages", "Between apps", "Between machines", "Recent"])
        self.assertFalse(window.machines_section.has_css_class("asb-msg-section-rule"))
        self.assertTrue(apps.has_css_class("asb-msg-section-rule") and recent.has_css_class("asb-msg-section-rule"))
        window.set_default_size(639, 860)
        self.wait_for(lambda: window.stats.get_orientation() == vertical)
        self.assertTrue(window.narrow_scroll.get_visible())
        self.assertEqual(window.stats.get_orientation(), vertical)
        self.assertFalse(window.stats.get_homogeneous())
        self.assertTrue(window.machines_section.has_css_class("asb-msg-section-rule"))
        window.set_default_size(640, 860)
        self.wait_for(lambda: window.stats.get_orientation() == horizontal)
        self.assertEqual(window.stats.get_orientation(), horizontal)
        window.set_default_size(968, 760)
        self.wait_for(lambda: window.wide.get_visible() and window.stats.get_orientation() == vertical)
        self.assertTrue(window.wide.get_visible())
        self.assertIs(window.ledger.get_parent(), window.wide)
        self.assertEqual(window.stats.get_orientation(), vertical)
        self.assertTrue(window.machines_section.has_css_class("asb-msg-section-rule"))

    def test_small_table_threshold_uses_the_real_table_size(self):
        window = self.window((968, 600))
        overhead = window.get_height() - window.left.get_height()
        for height, small in ((495, True), (496, False)):
            with self.subTest(height=height):
                window.set_default_size(968, overhead + height)
                self.wait_for(lambda: window.left.get_height() == height and window.table.small == small)
                self.assertEqual(window.table.get_height(), height)
                self.assertEqual(window.table.small, small)
                self.assertEqual(window.table.center.get_visible(), not small)
                self.assertFalse(window.reader.get_visible())
        for width in (495, 496):
            with self.subTest(width=width):
                window.set_default_size(width, 800)
                self.wait_for(lambda: window.table.get_width() == width and window.narrow_scroll.get_visible())
                self.drain(.05)
                self.assertEqual(window.table.get_height(), width)
                self.assertEqual(window.table.small, width < 496)
                self.assertEqual(window.reader.get_visible(), width < 496)
                self.assertEqual(window.table.center.get_visible(), width >= 496)

    def test_without_gsk_paths_nothing_is_drawn(self):
        with patch.object(asb, "ACTIVITY_PATHS", False):
            window = self.window()
            self.assertTrue(window.paths_note.get_visible())
            self.assertEqual(window.table.proxies, {})
            self.assertFalse(window.table.center.get_visible())
            self.assertEqual(window.total.get_visible_child().get_label(), "479")
            snapshot = asb.Gtk.Snapshot()
            asb.Gtk.WidgetPaintable.new(window.table).snapshot(snapshot, window.table.get_width(), window.table.get_height())
            self.assertIsNone(snapshot.to_node())


def descendants(widget):
    child = widget.get_first_child()
    while child is not None:
        yield child
        yield from descendants(child)
        child = child.get_next_sibling()


@unittest.skipUnless(asb.Gtk.init_check(), "A GTK display is not available.")
class BoardWindowsCheck(ActivityFixture, unittest.TestCase):
    """The Board side of Messages and Usage: the icon-only toolbar, the main menu, the keys, the row panel, the tray event, and the sizes."""
    snapshot_window = WidgetCheck.snapshot_window
    fetch = MessagesWindowCheck.fetch
    USAGE = UsageWindowCheck.REPLIES
    REAL_KEYS = bool(shutil.which("xdotool")) and os.environ.get("DISPLAY") in (":9", ":10")

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="asb-board-windows-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        patcher = patch.object(asb, "THEME_PATH", self.directory / "theme.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        settings = asb.Gtk.Settings.get_default()
        self.addCleanup(settings.set_property, "gtk-font-name", settings.get_property("gtk-font-name"))
        settings.set_property("gtk-font-name", "Cantarell 11")
        self.addCleanup(settings.set_property, "gtk-enable-animations", settings.get_property("gtk-enable-animations"))
        settings.set_property("gtk-enable-animations", False)
        self.sample = json.loads(MessagesWindowCheck.SAMPLE.read_text())
        self.extra, self.routes = [], []
        # The activity windows read the synthetic sample replies, never the network.
        classes = {"messages": lambda application, base: asb.MessagesWindow(application, base, fetch=self.fetch),
                   "usage": lambda application, base: asb.UsageWindow(application, base,
                                                                      fetch=lambda route: copy.deepcopy(self.USAGE[route.rsplit("=", 1)[1]]))}
        patcher = patch.dict(asb.ACTIVITY_WINDOW_CLASSES, classes)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.close_windows)
        self.warnings = len(GTK_WARNINGS)
        self.addCleanup(lambda: self.assertEqual(GTK_WARNINGS[self.warnings:], []))
        self.output = os.environ.get("ASB_NATIVE_TEST_SNAPSHOTS")

    def board(self, dashboard=None):
        window = self.snapshot_window()
        if dashboard is not None:
            window.apply_dashboard(dashboard, None)
        window.present(); window.set_focus(None); self.drain(.3)
        return window

    def resize(self, window, width):
        border = window.get_default_size().width - window.get_width()
        window.set_default_size(width + border, 420); self.drain(.3); window.check_geometry(); self.drain(.1)
        self.assertEqual(window.get_width(), width)

    def keys(self, *args, wait=.15):
        subprocess.run(["xdotool", *args], check=True)
        self.drain(wait)

    def focus(self, window):
        import gi
        gi.require_version("GdkX11", "4.0")
        from gi.repository import GdkX11  # noqa: F401  The X11 surface gives the window ID for the key focus.
        subprocess.run(["xdotool", "windowfocus", str(window.get_surface().get_xid())], check=True)
        self.drain(.3)

    def shot(self, widget, name):
        if self.output:
            self.drain(.15)
            self.capture(widget, Path(self.output) / name)

    def test_toolbar_is_icon_only_and_search_uses_inline_row_at_every_width(self):
        window = self.board()
        heights = set()
        for width in (900, 500, 300):
            with self.subTest(width=width):
                self.resize(window, width)
                heights.add(window.window_handle.get_height())
                self.assertEqual([widget for widget in descendants(window.tools)
                                  if isinstance(widget, asb.Gtk.SearchEntry) and widget.get_ancestor(asb.Gtk.Popover) is None], [])
                self.assertIsNone(window.search.get_ancestor(asb.Gtk.Popover))
                self.assertIs(window.search.get_parent(), window.search_row)
                # The pills show only their glyphs; their names stay for screen readers and in the tooltips.
                for pill in (window.drawer_only, window.filters_pill):
                    self.assertEqual([widget.get_label() for widget in descendants(pill) if isinstance(widget, asb.Gtk.Label) and widget.get_mapped()], [])
                self.assert_accessible_label(window.filters_pill, "Filters")
                self.assertEqual(window.filters_pill.get_tooltip_text(), "Show the filter checklist.")
                self.assertTrue(window.drawer_only.get_tooltip_text().startswith("Show only the sessions in the drawer"))
                self.assertEqual((window.app_mark.get_visible(), window.search_button.get_visible()), (width >= 320,) * 2)
                if width >= 680:
                    self.assertIs(window.refresh_button.get_parent(), window.toolbar_end)
                    self.assertIs(window.refresh_button.get_next_sibling(), window.menu_button)
                    self.assertEqual(window.refresh_button.get_icon_name(), "view-refresh-symbolic")
                else:
                    self.assertIs(window.refresh_button.get_parent(), window.preferences_refresh_row)
                self.shot(window, f"board-toolbar-{width}.png")
                if width < 320:
                    continue
                window.search_button.emit("clicked"); self.drain(.3)
                self.assertTrue(window.search_row.get_reveal_child())
                self.assertTrue(window.get_focus().is_ancestor(window.search) or window.get_focus() is window.search)
                window.search.emit("stop-search"); self.drain(.2)
                self.assertFalse(window.search_row.get_reveal_child())
                # Typing on the board reveals the inline search row.
                card = window.focus_widgets[window.row_order[0]]
                card.grab_focus(); self.drain(.1)
                self.assertTrue(window.window_key(None, asb.Gdk.KEY_a, 0, 0)); self.drain(.3)
                self.assertTrue(window.search_row.get_reveal_child())
                self.assertEqual(window.search.get_text(), "a")
                window.search.emit("stop-search"); self.drain(.2)
                self.assertEqual((window.search.get_text(), window.search_row.get_reveal_child()), ("", False))
                if self.REAL_KEYS:
                    self.focus(window)
                    card.grab_focus(); self.drain(.1)
                    self.keys("key", "a", wait=.3)
                    self.assertTrue(window.search_row.get_reveal_child())
                    self.assertEqual(window.search.get_text(), "a")
                    self.keys("key", "Escape", wait=.3)
                    self.assertEqual((window.search.get_text(), window.search_row.get_reveal_child()), ("", False))
        # One toolbar height at every width: the wide toolbar has no search field that makes it taller.
        self.assertEqual(len(heights), 1, heights)

    def held_click(self, widget, window):
        from gi.repository import GdkX11
        position = subprocess.run(["xdotool", "getmouselocation", "--shell"], check=True, capture_output=True, text=True).stdout
        x, y = [line.split("=")[1] for line in position.splitlines()[:2]]
        self.addCleanup(self.keys, "mousemove", x, y)
        found, bounds = widget.compute_bounds(window)
        self.assertTrue(found)
        left, top = window.get_surface_transform()
        self.keys("mousemove", "--window", str(GdkX11.X11Surface.get_xid(window.get_surface())),
                  str(int(bounds.origin.x + bounds.size.width / 2 + left)),
                  str(int(bounds.origin.y + bounds.size.height / 2 + top)))
        self.keys("mousedown", "1", wait=.12)
        self.keys("mouseup", "1", wait=.3)

    @unittest.skipUnless(REAL_KEYS, "Real pointer clicks need xdotool and DISPLAY=:9 or :10")
    def test_one_pointer_click_opens_a_matching_card_while_searching(self):
        activation = patch.object(asb.SwitchboardWindow, "open_row", autospec=True, side_effect=asb.SwitchboardWindow.open_row)
        activated = activation.start()
        self.addCleanup(activation.stop)
        window = self.board()
        self.resize(window, 900)
        self.focus(window)
        window.set_focus(None)
        self.keys("key", "a", "c", wait=.3)
        self.assertEqual(window.search.get_text(), "ac")
        self.assertTrue(window.row_order)
        card = window.focus_widgets[window.row_order[0]]
        self.assertTrue(card.get_parent().get_activate_on_single_click())
        with patch.object(asb, "request_async") as opened:
            self.held_click(card.asb_title_label, window)
            requests = [call for call in opened.call_args_list if call.args[1].endswith("/open")]
            self.assertEqual(len(requests), 1, "One click on a matching card must open it")
            self.assertEqual(requests[0].args[1], "/api/threads/" + card.asb_thread["id"] + "/open")
            activated.assert_called_once_with(window, card.get_parent(), card)
        self.assertEqual(window.search.get_text(), "ac")
        self.assertTrue(window.search_row.get_reveal_child())

    @unittest.skipUnless(REAL_KEYS, "Real pointer clicks need xdotool and DISPLAY=:9 or :10")
    def test_clear_icon_resets_search_and_all_filters_with_one_render(self):
        window = self.board()
        self.resize(window, 900)
        self.focus(window)
        window.pending, window.archived, window.show_all_cards = True, True, True
        window.states, window.profiles = {"waiting"}, {"|codex"}
        window.open_search()
        window.search.set_text("ac"); self.drain(.4)
        clear = next(child for child in descendants(window.search)
                     if isinstance(child, asb.Gtk.Image) and child.get_icon_name() == "edit-clear-symbolic")
        self.assertTrue(clear.get_mapped())
        with patch.object(window, "render", wraps=window.render) as rendered:
            self.held_click(clear, window)
            self.assertEqual(rendered.call_count, 1)
        self.assertEqual(window.search.get_text(), "")
        self.assertFalse(window.search_expanded or window.search_row.get_reveal_child())
        self.assertFalse(window.filters_active() or window.show_all_cards or window.drawer_view or window.drawer_only.get_active())
        self.assertIs(window.get_focus(), window.search_button)

    @unittest.skipUnless(REAL_KEYS, "Real keys need xdotool and DISPLAY=:9 or :10")
    def test_escape_resets_filters_but_editing_and_popover_escape_do_not(self):
        window = self.board()
        self.focus(window)
        # Filters alone, All cards alone, and Drawer alone also make Escape reset.
        for field, value in (("pending", True), ("states", {"working"}), ("profiles", {"|codex"}),
                             ("archived", True), ("show_all_cards", True), ("drawer_view", True)):
            with self.subTest(field=field):
                setattr(window, field, value)
                window.drawer_only.set_active(window.drawer_view)
                window.filter_changed(); self.drain(.2)
                self.assertFalse(window.search.get_text() or window.search_expanded)
                with patch.object(window, "render", wraps=window.render) as rendered:
                    self.keys("key", "Escape")
                    rendered.assert_called_once_with()
                self.assertFalse(window.filters_active() or window.show_all_cards or window.drawer_view)
                self.assertFalse(window.drawer_only.get_active())
        window.pending, window.archived, window.show_all_cards = True, True, True
        window.states, window.profiles = {"waiting"}, {"|codex"}
        window.open_search()
        self.keys("key", "a")
        self.keys("key", "BackSpace")
        self.assertEqual(window.search.get_text(), "")
        self.assertTrue(window.pending and window.archived and window.show_all_cards)
        self.assertEqual((window.states, window.profiles), ({"waiting"}, {"|codex"}))
        self.assertTrue(window.search_expanded)
        self.keys("key", "a")
        window.open_filters_popover(); self.drain(.2)
        self.keys("key", "Escape")
        self.assertFalse(window.filter_popover.get_visible())
        self.assertEqual(window.search.get_text(), "a")
        self.assertTrue(window.pending and window.archived and window.show_all_cards)
        self.assertEqual((window.states, window.profiles), ({"waiting"}, {"|codex"}))
        for popup in (lambda: window.menu_button.popup(),
                      lambda: window.show_context(window.focus_widgets[window.row_order[0]])):
            popup(); self.drain(.2)
            self.keys("key", "Escape")
            self.assertFalse(window.menu_button.get_popover().get_visible())
            self.assertTrue(window.context_menu is None or not window.context_menu.get_visible())
            self.assertEqual(window.search.get_text(), "a")
            self.assertTrue(window.pending and window.archived and window.show_all_cards)
            self.assertEqual((window.states, window.profiles), ({"waiting"}, {"|codex"}))
        window.open_search(); self.drain(.1)
        with patch.object(window, "render", wraps=window.render) as rendered:
            self.keys("key", "Escape")
            rendered.assert_called_once_with()
        self.assertEqual(window.search.get_text(), "")
        self.assertFalse(window.search_expanded or window.filters_active() or window.show_all_cards)
        self.assertFalse(window.window_key(None, asb.Gdk.KEY_Escape, 0, 0))

    def test_inline_search_visibility_follows_query_and_focus_and_preferences(self):
        window = self.board()
        self.assertIsNone(window.get_focus())
        self.assertFalse(window.search_expanded or window.search_row.get_reveal_child())
        self.assertEqual(window.search_row.get_transition_duration(), 150)
        self.assertEqual(window.search_row.get_transition_type(), asb.Gtk.RevealerTransitionType.NONE)
        self.assertIs(window.window_handle.get_next_sibling(), window.search_row)
        self.assertIs(window.search_row.get_next_sibling(), window.notice)
        self.assertEqual((window.search.get_margin_start(), window.search.get_margin_end(),
                          window.search.get_margin_top(), window.search.get_margin_bottom()), (4, 4, 0, 4))
        window.open_search(); self.drain(.2)
        self.assertTrue(window.search_expanded and window.search_focus.contains_focus())
        window.search_button.grab_focus(); self.drain(.2)
        self.assertFalse(window.search_expanded)
        window.open_search(); window.search.set_text("ac"); self.drain(.2)
        window.search_button.grab_focus(); self.drain(.2)
        self.assertTrue(window.search_expanded)
        window.search.set_text(""); self.drain(.2)
        self.assertFalse(window.search_expanded)
        window.open_preferences(); self.drain(.2)
        window.open_search_from_preferences(); self.drain(.2)
        self.assertFalse(window.preferences_window.get_visible())
        self.assertTrue(window.search_expanded and window.search_focus.contains_focus())
        self.resize(window, 300)
        window.reset_view(); self.drain(.2)
        self.assertTrue(window.get_focus().is_ancestor(window.menu_button))
        settings = window.get_settings()
        settings.set_property("gtk-enable-animations", True)
        animated = self.board()
        self.assertEqual(animated.search_row.get_transition_type(), asb.Gtk.RevealerTransitionType.SLIDE_DOWN)

    def test_main_menu_has_messages_usage_and_preferences_with_their_keys(self):
        window = self.board()
        menu = window.menu_button
        self.assertIsInstance(menu, asb.Gtk.MenuButton)
        self.assertEqual((menu.get_icon_name(), menu.get_tooltip_text()), ("view-more-symbolic", "Main menu"))
        self.assertTrue(menu.has_css_class("asb-toolbar-button"))
        self.assert_accessible_label(menu, "Main menu")
        model = menu.get_menu_model()
        sections = [model.get_item_link(index, asb.Gio.MENU_LINK_SECTION) for index in range(model.get_n_items())]
        items = [[tuple(section.get_item_attribute_value(index, name).get_string() for name in ("label", "action"))
                  for index in range(section.get_n_items())] for section in sections]
        self.assertEqual(items, [[("Messages", "app.messages"), ("Usage", "app.usage")], [("Preferences", "win.preferences")]])
        accels = {action: self.application.get_accels_for_action(action) for action in ("app.messages", "app.usage", "win.preferences")}
        self.assertEqual(accels, {"app.messages": ["<Control>m"], "app.usage": ["<Control>u"], "win.preferences": ["<Control>comma"]})
        self.assertEqual(self.application.get_actions_for_accel("<Control><Shift>u"), [])
        self.assertEqual(self.application.get_actions_for_accel("<Control>w"), [])
        # The menu draws the separator and the key of each item; its popover takes the Board palette.
        custom = {"background": "#171c22", "text": "#f0f2f5", "accent": "#f3c66b", "muted": "#b8c0cc", "divider": "#586372"}
        window.set_palette(custom)
        menu.popup(); self.drain(.4)
        popover = menu.get_popover()
        self.assertTrue(popover.get_visible() and popover.has_css_class("asb-main-menu"))
        texts = [widget.get_label() for widget in descendants(popover) if isinstance(widget, asb.Gtk.Label) and widget.get_mapped()]
        self.assertEqual(texts, ["Messages", "Ctrl+M", "Usage", "Ctrl+U", "Preferences", "Ctrl+,"])
        self.assertEqual(sum(isinstance(widget, asb.Gtk.Separator) and widget.get_mapped() for widget in descendants(popover)), 1)
        data, stride = self.pixels(popover)
        found, bounds = popover.get_child().compute_bounds(popover)
        x, y = int(bounds.origin.x + bounds.size.width / 2), int(bounds.origin.y + 3)
        self.assertEqual(bytes(data[y * stride + x * 4:y * stride + x * 4 + 3]).hex(), "171c22")
        self.shot(window, "board-main-menu-window.png")
        self.shot(popover, "board-main-menu.png")
        menu.popdown(); self.drain(.2)

    def test_menu_actions_and_keys_open_the_windows_in_every_asb_window(self):
        window = self.board()
        application = self.application
        # Closing hides a window; the next open shows the same window.
        shown_kind = lambda kind: kind in application.activity_windows and application.activity_windows[kind].get_visible()
        application.activate_action("messages", None); self.drain(.3)
        messages = application.activity_windows["messages"]
        self.assertIsInstance(messages, asb.MessagesWindow)
        self.assertTrue(messages.get_visible())
        application.activate_action("messages", None); self.drain(.3)
        self.assertIs(application.activity_windows["messages"], messages)
        self.assertEqual(sum(isinstance(item, asb.MessagesWindow) for item in application.get_windows()), 1)
        messages.close(); self.drain(.3)
        self.assertFalse(shown_kind("messages"))
        window.activate_action("win.preferences", None); self.drain(.3)
        self.assertTrue(window.preferences_window.get_visible())
        window.preferences_window.set_visible(False); self.drain(.2)
        if not self.REAL_KEYS:
            self.skipTest("Real keys need xdotool and DISPLAY=:9 or :10")
        opened = []
        window.open_row = lambda _listing, widget: opened.append(widget.asb_thread["id"])

        def opens(kind, key, target):
            self.focus(target)
            self.keys("key", key, wait=.4)
            self.assertTrue(shown_kind(kind), (kind, key, target))
            shown = application.activity_windows[kind]
            self.assertTrue(shown.get_visible())
            return shown
        opens("messages", "ctrl+m", window).close(); self.drain(.3)
        usage = opens("usage", "ctrl+u", window)
        opens("messages", "ctrl+m", usage).close(); self.drain(.3)
        self.focus(usage)
        self.keys("key", "ctrl+w", wait=.4)
        self.assertFalse(shown_kind("usage"))
        # In the search field the keys open the windows too and type nothing; Ctrl+Shift+U stays the Unicode input.
        self.focus(window)
        window.open_search(); self.drain(.3)
        self.keys("key", "ctrl+m", wait=.4)
        self.assertTrue(shown_kind("messages"))
        self.assertEqual(window.search.get_text(), "")
        application.activity_windows["messages"].close(); self.drain(.3)
        self.focus(window)
        window.open_search(); self.drain(.3)
        self.keys("key", "ctrl+u", wait=.4)
        self.assertTrue(shown_kind("usage"))
        application.activity_windows["usage"].close(); self.drain(.3)
        self.focus(window)
        window.open_search(); self.drain(.2)
        self.keys("key", "ctrl+comma", wait=.4)
        self.assertTrue(window.preferences_window.get_visible())
        window.preferences_window.set_visible(False); self.drain(.2)
        self.focus(window)
        window.open_search(); self.drain(.2)
        self.keys("key", "ctrl+shift+u", wait=.3)
        self.keys("key", "Escape", "Escape", wait=.3)
        self.assertFalse(shown_kind("usage"))
        window.clear_search(); self.drain(.2)
        # Ctrl+, opens Preferences, where Ctrl+U works too; Ctrl+W leaves the Board open.
        self.focus(window)
        self.keys("key", "ctrl+comma", wait=.4)
        preferences = window.preferences_window
        self.assertTrue(preferences.get_visible())
        opens("usage", "ctrl+u", preferences).close(); self.drain(.3)
        preferences.set_visible(False); self.drain(.2)
        self.focus(window)
        self.keys("key", "ctrl+w", wait=.4)
        self.assertTrue(window.get_visible() and not window.closed)
        # Holding Ctrl still shows the card numbers, and Ctrl+1 opens the first card.
        window.focus_widgets[window.row_order[0]].grab_focus(); self.drain(.1)
        self.keys("keydown", "Control_L", wait=.5)
        self.assertTrue(window.numbers_shown)
        self.keys("key", "1", wait=.2)
        self.keys("keyup", "Control_L", wait=.2)
        self.assertEqual(opened, [window.number_keys[0]])
        self.assertFalse(window.numbers_shown)

    def test_closing_a_window_hides_it_and_the_next_open_shows_it_again(self):
        board = self.board()
        streams = []
        stream = lambda *_args: streams.append(Mock()) or streams[-1]
        with patch.object(asb, "EventStream", side_effect=stream), patch.object(asb, "request_async") as request, \
                patch.dict(asb.ACTIVITY_WINDOW_CLASSES, {"messages": asb.MessagesWindow}):
            self.poll_calls.reset_mock()
            self.poll_calls.return_value = 0
            window = self.application.show_activity("messages", seat="docs", title="Update the install guide"); self.drain(.2)
            self.assertEqual((len(streams), request.call_count), (1, 1))
            request.call_args.args[2](self.fetch("/api/activity/messages?period=7d"), None); self.drain(.1)
            self.assertEqual(window.stack.get_visible_child_name(), "data")
            # The thread read goes through request_async too: Show messages opened the session thread.
            self.assertEqual(request.call_args.args[1], "/api/activity/thread?period=7d&seat=docs")
            self.assertEqual(window.ledger.get_visible_child_name(), "thread")
            self.assertEqual(window.thread["key"], "docs")
            css = window.css
            window.close(); self.drain(.2)
            # Hidden, not closed: no stream, no timers, and the thread is closed.
            self.assertFalse(window.get_visible() or window.closed)
            self.assertIs(self.application.activity_windows["messages"], window)
            self.assertIn(window, self.application.get_windows())
            streams[0].close.assert_called_once()
            self.assertIsNone(window.events)
            self.assertIsNone(window.poll_timer)
            self.assertIsNone(window.event_timer)
            self.assertIsNone(window.thread)
            self.assertIsNone(window.table.tick_id)
            # The menu opens the same window: live again, one read, and its last data until the reply.
            self.application.activate_action("messages", None); self.drain(.2)
            self.assertIs(self.application.activity_windows["messages"], window)
            self.assertTrue(window.get_visible())
            self.assertEqual((len(streams), request.call_count), (2, 3))
            self.assertIsNotNone(window.poll_timer)
            self.assertEqual(self.poll_calls.call_count, 2)
            self.assertEqual(window.stack.get_visible_child_name(), "data")
            self.assertEqual(window.ledger.get_visible_child_name(), "stats")
            self.assertIsNone(window.thread)
            self.assertIs(window.css, css)
            # The board close destroys a hidden window; no request runs after it.
            window.close(); self.drain(.2)
            board.close(); self.drain(.2)
            self.assertTrue(window.closed)
            self.assertNotIn("messages", self.application.activity_windows)
            self.assertNotIn(window, self.application.get_windows())
            window.refresh(); window.poll_tick(); self.drain(.1)
            self.assertEqual(request.call_count, 3)
            self.assertEqual(len(streams), 2)

    def test_a_window_without_a_board_closes_for_good(self):
        board = self.board()
        usage = self.application.show_activity("usage"); self.drain(.2)
        board.close(); self.drain(.2)
        # A shown window stays when the board closes; its own close then destroys it.
        self.assertTrue(usage.get_visible() and not usage.closed)
        usage.close(); self.drain(.2)
        self.assertTrue(usage.closed)
        self.assertNotIn("usage", self.application.activity_windows)

    def test_row_panel_show_messages_opens_the_thread_of_that_session(self):
        rows = [{"id": "docs", "provider": "claude-desktop-code", "providerLabel": "Claude Desktop Code", "title": "Update the install guide",
                 "cwd": "/example/docs", "projectName": "docs", "state": "idle", "canOpen": True, "updatedAtMs": NOW - 360_000, "unread": True},
                {"id": "parser-review", "provider": "codex", "providerLabel": "Codex", "title": "Review   the parser changes",
                 "cwd": "/example/parser-review", "projectName": "parser-review", "state": "working", "canOpen": False,
                 "updatedAtMs": NOW - 120_000, "remote": True, "machineId": "laptop", "machineName": "Laptop", "sourceLabel": "Codex"}]
        window = self.board({"generatedAtMs": NOW, "providers": [], "threads": rows, "persistentUnread": False})
        custom = {"background": "#171c22", "text": "#f0f2f5", "accent": "#f3c66b", "muted": "#b8c0cc", "divider": "#586372"}
        window.set_palette(custom); self.drain(.2)
        for identity in ("docs", "parser-review"):
            with self.subTest(identity=identity):
                window.show_context(window.focus_widgets[identity]); self.drain(.3)
                panel = window.context_menu
                root = panel.get_child().get_child()
                order = [root.get_first_child()]
                while len(order) < 4:
                    order.append(order[-1].get_next_sibling())
                self.assertEqual(order[:3], [panel.asb_title, panel.asb_open, panel.asb_messages])
                self.assertIsInstance(order[3], asb.Gtk.Separator)
                messages = panel.asb_messages
                self.assertEqual(messages.asb_label.get_label(), "Show messages")
                self.assert_accessible_label(messages, "Show messages")
                self.assertEqual(messages.asb_icon.get_gicon().get_file().get_basename(), "asb-chat-symbolic.svg")
                self.assertTrue(messages.has_css_class("flat") and messages.has_css_class("asb-panel-action"))
                # Sensitive for every row, also the view-only remote row whose Open row is not.
                self.assertTrue(messages.get_sensitive())
                self.assertEqual(panel.asb_open.get_sensitive(), identity == "docs")
                # The new row is in the focus order of the panel keys, between Open in and the actions.
                if identity == "docs":
                    panel.asb_open.grab_focus()
                    keys = SimpleNamespace(get_widget=lambda: panel)
                    self.assertTrue(window.panel_key(keys, asb.Gdk.KEY_Down, 0, 0))
                    self.assertIs(window.get_focus(), messages)
                    self.assertTrue(window.panel_key(keys, asb.Gdk.KEY_Down, 0, 0))
                    self.assertIs(window.get_focus(), next(button for button in panel.asb_actions.values() if button.get_visible()))
                    self.assertTrue(window.panel_key(keys, asb.Gdk.KEY_Up, 0, 0))
                    self.assertIs(window.get_focus(), messages)
                    # The glyph is drawn in the Board text color, as the other ASB glyphs.
                    data, stride = self.pixels(messages.asb_icon)
                    alpha = max(data[3::4])
                    index = data[3::4].index(alpha) * 4
                    color = messages.asb_label.get_color()
                    ink = [round(channel * 255) for channel in (color.red, color.green, color.blue)]
                    self.assertGreater(alpha, 200)
                    self.assertTrue(all(abs(data[index + channel] - ink[channel]) <= 2 for channel in range(3)), (data[index:index + 4], ink))
                    self.shot(panel, "board-row-panel.png")
                    panel.popdown(); self.drain(.3)
                    continue
                title = panel.asb_title.get_label()
                self.assertEqual(title, "Review the parser changes")
                with patch.object(self.application, "show_activity", wraps=self.application.show_activity) as shown:
                    messages.emit("clicked"); self.drain(.3)
                    shown.assert_called_once_with("messages", seat="parser-review", title=title)
                self.assertFalse(panel.get_visible())
                self.assertIsNone(window.context_menu)
                thread = self.application.activity_windows["messages"]
                thread.refresh(); self.drain(.4)
                self.assertEqual((thread.thread["kind"], thread.thread["key"], thread.thread["title"]), ("session", "parser-review", title))
                self.assertEqual(thread.ledger.get_visible_child_name(), "thread")
                self.assertIn("/api/activity/thread?period=7d&seat=parser-review", self.routes)

    def test_tray_event_opens_the_window_only_on_the_board_that_reported_last(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        ready, done, clients = threading.Event(), threading.Event(), []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.end_headers()
                self.wfile.flush()
                ready.wait(2)
                board = clients[0]
                for data in ('{"window":"messages","clientId":"another-board"}', '{"window":"board","clientId":"%s"}' % board,
                             '["usage"]', '{"window":"messages"}', '{"window":"usage","clientId":"%s"}' % board):
                    self.wfile.write(f"event: show-window\ndata: {data}\n\n".encode())
                self.wfile.flush()
                done.wait(3)

            def log_message(self, *_args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
            thread.start()
            self.addCleanup(lambda: (done.set(), server.shutdown(), thread.join(1)))
            base = f"http://127.0.0.1:{server.server_port}"
            patcher = patch.object(asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None)
            patcher.start()
            self.addCleanup(patcher.stop)
            with patch.object(self.application, "show_activity", wraps=self.application.show_activity) as shown:
                window = asb.SwitchboardWindow(self.application, base, mock_dashboard(), theme_path=False, layout_path=False)
                self.addCleanup(window.close)
                window.present(); self.drain(.2)
                # An activity window's stream gets the same events and passes none of them on.
                usage = asb.UsageWindow(self.application, base, fetch=lambda route: copy.deepcopy(self.USAGE[route.rsplit("=", 1)[1]]))
                usage.start_live()
                self.assertIsNone(usage.events.on_show_window)
                self.assertIsNotNone(window.events.on_show_window)
                clients.append(window.ui_client_id)
                ready.set()
                for _attempt in range(40):
                    self.drain(.05)
                    if "usage" in self.application.activity_windows:
                        break
                self.drain(.3)
                shown.assert_called_once_with("usage")
            opened = self.application.activity_windows["usage"]
            self.assertIsNot(opened, usage)
            self.assertTrue(opened.get_visible())
            self.assertNotIn("messages", self.application.activity_windows)
            usage.close()

    def test_open_window_variable_opens_the_board_then_the_window(self):
        original = asb.SwitchboardWindow
        for target, name, value in ((asb.SwitchboardWindow, "refresh", lambda *_args, **_kwargs: None),
                                    (asb, "EventStream", lambda *_args, **_kwargs: SimpleNamespace(close=lambda: None, connected=False))):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # The Board of the start reads no layout or theme file of this machine.
        board = lambda application, base, first_load=None: original(application, base, mock_dashboard(), theme_path=False, layout_path=False)
        for value, expected in (("usage", ["usage"]), ("x", [])):
            with self.subTest(value=value), patch.dict(os.environ, {"ASB_OPEN_WINDOW": value}):
                with patch.object(asb, "SwitchboardWindow", board):
                    self.application.on_activate()
                self.assertNotIn("ASB_OPEN_WINDOW", os.environ)
                boards = [item for item in self.application.get_windows() if isinstance(item, original)]
                self.assertEqual(len(boards), 1)
                self.assertEqual(list(self.application.activity_windows), [])
                self.drain(.3)
                self.assertEqual(list(self.application.activity_windows), expected)
                if expected:
                    self.assertTrue(self.application.activity_windows["usage"].get_visible())
                    self.assertTrue(boards[0].get_visible())
                self.close_windows()

    def test_messages_and_usage_keep_their_own_size(self):
        path = asb.THEME_PATH.with_name("activity-windows.json")
        application = self.application
        messages = application.show_activity("messages"); self.drain(.3)
        self.assertEqual(messages.get_default_size(), (968, 760))
        messages.set_default_size(1000, 700); self.drain(.3)
        self.assertEqual((messages.get_width(), messages.get_height()), (1000, 700))
        messages.close(); self.drain(.3)
        self.assertEqual(json.loads(path.read_text()), {"version": 1, "messages": {"width": 1000, "height": 700, "maximized": False}})
        messages = application.show_activity("messages"); self.drain(.3)
        self.assertEqual(messages.get_default_size(), (1000, 700))
        self.assertEqual((messages.get_width(), messages.get_height()), (1000, 700))
        messages.close(); self.drain(.3)
        # Usage keeps its own size.
        usage = application.show_activity("usage"); self.drain(.3)
        self.assertEqual(usage.get_default_size(), (948, 760))
        usage.close(); self.drain(.3)
        self.assertEqual(asb.read_window_sizes(path), {"messages": (1000, 700, False), "usage": (948, 760, False)})
        # A broken file gives the defaults and no exception; the next close writes a valid file.
        path.write_text("{")
        messages = application.show_activity("messages"); self.drain(.3)
        self.assertEqual(messages.get_default_size(), (968, 760))
        messages.close(); self.drain(.3)
        self.assertEqual(json.loads(path.read_text()), {"version": 1, "messages": {"width": 968, "height": 760, "maximized": False}})
        # A saved maximized window opens maximized.
        asb.write_window_size(path, "usage", 900, 600, True)
        usage = application.show_activity("usage"); self.drain(.5)
        self.assertEqual(usage.get_default_size(), (900, 600))
        self.assertTrue(usage.is_maximized())


if __name__ == "__main__":
    unittest.main()
