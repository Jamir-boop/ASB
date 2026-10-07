"""Native scheduling and row reuse checks, without GTK or a display."""
import ast
import copy
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SOURCE = Path(__file__).parents[1] / "scripts" / "asb-native.py"
TREE = ast.parse(SOURCE.read_text())
NODES = TREE.body[:next(index for index, node in enumerate(TREE.body) if isinstance(node, ast.Try))]
WINDOW = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SwitchboardWindow"))
WINDOW.bases = []
SCOPE = {"__file__": str(SOURCE)}
exec(compile(ast.Module(body=NODES + [WINDOW], type_ignores=[]), str(SOURCE), "exec"), SCOPE)
Window = SCOPE["SwitchboardWindow"]


class Box:
    def __init__(self, **_kwargs):
        self.children, self.parent = [], None
        self.label = ""

    def append(self, child):
        self.children.append(child)
        child.parent = self

    def remove(self, child):
        self.children.remove(child)
        child.parent = None

    def get_parent(self):
        return self.parent

    def get_first_child(self):
        return self.children[0] if self.children else None

    def get_next_sibling(self):
        siblings = self.parent.children
        index = siblings.index(self) + 1
        return siblings[index] if index < len(siblings) else None

    def add_css_class(self, _value):
        pass

    def connect(self, *_args):
        return 1

    def disconnect(self, _handler):
        pass

    def set_label(self, value):
        self.label = value


class NativeLogicChecks(unittest.TestCase):
    def test_policy_and_read_menu_use_current_asb_dot(self):
        interval, actions = SCOPE["refresh_interval"], SCOPE["row_menu_actions"]
        for value, expected in ((2000, 2000), (5000, 5000), (None, 5000), (True, 5000), (10, 5000)):
            self.assertEqual(interval({"refreshIntervalMs": value}), expected)
        for row in ({"unread": True}, {"questionAttention": True}, {"retainedUnread": True, "unread": True}):
            self.assertEqual(actions(row)[0], ("Read", "mark-read"))
            self.assertNotIn(("Unread", "mark-unread"), actions(row))
        self.assertEqual(actions({"nativeUnread": True, "nativeAttention": False})[0], ("Unread", "mark-unread"))
        self.assertEqual([action for _, action in actions({"pinned": True})], ["mark-unread", "unpin", "pin-up", "pin-down"])

    def test_row_actions_keep_the_target_and_post_to_the_session_route(self):
        window = object.__new__(Window)
        window.base = "http://127.0.0.1:1"
        target = SimpleNamespace(get_string=lambda: "known/session")
        request, dispatch = Mock(), Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=dispatch)}):
            for name, action, body in (("mark-read", "mark-read", None),
                                      ("mark-unread", "mark-unread", None),
                                      ("pin", "pin", None), ("unpin", "unpin", None),
                                      ("pin-up", "move-pin", {"direction": "up"}),
                                      ("pin-down", "move-pin", {"direction": "down"})):
                with self.subTest(action=name):
                    request.reset_mock()
                    window.row_action(None, target, name)
                    request.assert_called_once()
                    base, route, callback, actual_dispatch, method, actual_body = request.call_args.args
                    self.assertEqual((base, route, actual_dispatch, method, actual_body),
                                     (window.base, "/api/threads/known%2Fsession/" + action,
                                      dispatch, "POST", body))
                    self.assertTrue(callable(callback))

    def test_timestamp_update_reuses_rows_and_columns_order_change_reuses_rows(self):
        SCOPE["Gtk"] = SimpleNamespace(ListBox=Box, SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0))
        SCOPE["GLib"] = SimpleNamespace(idle_add=lambda *_args: 1)
        board = {"threads": [{"id": "a", "state": "working", "updatedAtMs": 20},
                             {"id": "b", "state": "idle", "updatedAtMs": 10}]}
        window = object.__new__(Window)
        window.dashboard, window.closed = board, False
        window.context_menu = window.focused_id = window.layout_signature = None
        window.focus_key = lambda: None
        window.focus_widgets, window.list_body, window.count = {}, Box(), Box()
        window.geometry, window.column_width, window.row_height, window.view = (500, 100), 240, 22, "compact"
        window.scroll = SimpleNamespace(get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 0))
        window.visible_rows = lambda: SCOPE["filtered_rows"](window.dashboard)
        created, released = [], []
        def create(row):
            widget = Box()
            widget.asb_thread = dict(row)
            created.append(widget)
            return widget
        window.session_row = create
        window.update_session_row = lambda widget, row: setattr(widget, "asb_thread", dict(row))
        window.release_row = lambda widget: (released.append(widget), widget.parent.remove(widget))
        window.render()
        widgets, columns = dict(window.focus_widgets), list(window.list_body.children)
        board["threads"][0]["updatedAtMs"] = 30
        window.render()
        self.assertEqual(window.focus_widgets, widgets)
        self.assertEqual(window.list_body.children, columns)
        self.assertEqual(len(created), 2)
        board["threads"][1].update(pinned=True, pinIndex=0)
        window.render()
        self.assertEqual(window.row_order, ["b", "a"])
        self.assertEqual(window.focus_widgets, widgets)
        board["threads"] = board["threads"][:1]
        window.render()
        self.assertEqual(released, [widgets["b"]])

    def test_events_coalesce_without_force_and_manual_force_survives(self):
        requests, pending = [], []
        SCOPE["request_async"] = lambda *args: requests.append(args)
        SCOPE["GLib"] = SimpleNamespace(idle_add=lambda callback, *args: pending.append((callback, args)))
        window = object.__new__(Window)
        window.closed, window.loading, window.refresh_queued, window.refresh_force_queued = False, True, False, False
        window.dashboard, window.base = {}, "http://127.0.0.1:1"
        window.refresh_button = SimpleNamespace(set_sensitive=lambda _value: None)
        window.set_notice = lambda _value: None
        for _ in range(10):
            window.source_changed()
        self.assertTrue(window.refresh_queued)
        self.assertFalse(window.refresh_force_queued)
        window.apply_dashboard(None, "Cannot load sessions")
        self.assertEqual(len(pending), 1)
        callback, args = pending.pop()
        callback(*args)
        self.assertEqual(requests[-1][1], "/api/dashboard")
        window.refresh(True)
        window.source_changed()
        self.assertTrue(window.refresh_force_queued)
        window.apply_dashboard(None, "Cannot load sessions")
        callback, args = pending.pop()
        callback(*args)
        self.assertEqual(requests[-1][1], "/api/dashboard?force=1")

    def test_provider_warning_expires_once_and_old_timers_cannot_hide_new_notices(self):
        timers = {}
        def timeout(interval, callback):
            identity = len(timers) + 1
            timers[identity] = (interval, callback)
            return identity
        glib = SimpleNamespace(timeout_add=timeout, source_remove=Mock())
        window = object.__new__(Window)
        window.closed = window.refresh_queued = window.snapshot_pending = False
        window.dashboard, window.signature = {}, []
        window.refresh_interval_ms, window.timer, window.clock_interval = 5000, 99, 60
        window.notice_timer, window.notice_generation, window.provider_notice = None, 0, ""
        window.notice = SimpleNamespace(set_label=Mock(), set_visible=Mock())
        window.refresh_button = SimpleNamespace(set_sensitive=Mock())
        window.sync_unread_setting = window.update_clock = Mock()
        def apply(message, interval=5000):
            window.apply_dashboard({"providers": [{"message": message}], "threads": [],
                                    "refreshIntervalMs": interval}, None)
        with patch.dict(SCOPE, {"GLib": glib}):
            apply("Partial remote cache")
            first = window.notice_timer
            self.assertEqual(timers[first][0], 5000)
            for interval in (2000, 2000, 5000, 5000):
                apply("Partial remote cache", interval)
                self.assertEqual(window.notice_timer, first)
            window.notice.set_visible.assert_called_once_with(True)
            self.assertFalse(timers[first][1]())
            self.assertIsNone(window.notice_timer)
            for interval in (2000, 5000):
                apply("Partial remote cache", interval)
                self.assertIsNone(window.notice_timer)
                window.notice.set_visible.assert_called_with(False)

            apply("Another warning")
            replaced = window.notice_timer
            apply("Partial remote cache")
            current = window.notice_timer
            glib.source_remove.assert_any_call(replaced)
            window.notice.set_visible.reset_mock()
            self.assertFalse(timers[replaced][1]())
            self.assertFalse(timers[first][1]())
            self.assertEqual(window.notice_timer, current)
            window.notice.set_visible.assert_not_called()

            window.apply_dashboard(None, "Cannot load sessions")
            glib.source_remove.assert_any_call(current)
            self.assertIsNone(window.notice_timer)
            window.notice.set_visible.reset_mock()
            self.assertFalse(timers[current][1]())
            window.notice.set_visible.assert_not_called()
            window.apply_dashboard(None, "Cannot load sessions")
            window.notice.set_label.assert_called_with("Cannot load sessions")
            window.notice.set_visible.assert_called_with(True)
            apply("Partial remote cache")
            self.assertIsNone(window.notice_timer)
            window.notice.set_visible.assert_called_with(False)
            apply("")
            apply("Partial remote cache")
            current = window.notice_timer
            self.assertIsNotNone(current)
            self.assertFalse(timers[current][1]())
            window.notice.set_visible.assert_called_with(False)

            apply("Close warning")
            closing = window.notice_timer
            window.events, window.get_display, window.css = Mock(), Mock(), object()
            window.clock_timer = window.geometry_idle = window.surface_signal = window.context_menu = None
            window.focus_widgets = {}
            with patch.dict(SCOPE, {"Gtk": SimpleNamespace(StyleContext=Mock())}):
                self.assertFalse(window.on_close())
            glib.source_remove.assert_any_call(closing)
            self.assertIsNone(window.notice_timer)
            window.notice.set_visible.reset_mock()
            self.assertFalse(timers[closing][1]())
            window.notice.set_visible.assert_not_called()

    def test_changed_row_fields_keep_content_and_copy_mutable_source(self):
        window = object.__new__(Window)
        window.view, window.update_row_text = "compact", Mock()
        row = {"id": "a", "provider": "codex", "state": "working", "updatedAtMs": 10, "unread": False}
        widget = SimpleNamespace(asb_view="compact", asb_thread=dict(row), set_activatable=Mock(),
                                 set_child=Mock(), asb_mark=Mock(), asb_dot=Mock(), asb_state_label=Mock())
        row.update(updatedAtMs=20, unread=True, state="waiting", pinned=True)
        window.update_session_row(widget, row)
        widget.set_child.assert_not_called()
        widget.asb_dot.set_visible.assert_called_once_with(True)
        widget.asb_state_label.add_css_class.assert_any_call("asb-waiting")
        window.update_row_text.assert_called_once_with(widget)
        row["pinned"] = False
        self.assertTrue(widget.asb_thread["pinned"])

    def test_clock_is_local_and_row_controllers_are_released(self):
        calls, disconnected = [], []
        window = object.__new__(Window)
        window.closed, window.focus_widgets = False, {"a": object()}
        window.update_row_text = lambda *args: calls.append(args)
        self.assertTrue(window.update_clock())
        self.assertEqual(len(calls), 1)
        controller = SimpleNamespace(disconnect=disconnected.append)
        widget = SimpleNamespace(asb_handlers=[(controller, [1, 2])], remove_controller=calls.append,
                                 get_parent=lambda: None)
        window.release_row(widget)
        self.assertEqual(disconnected, [1, 2])
        self.assertEqual(widget.asb_handlers, [])
        self.assertIs(calls[-1], controller)

    def test_event_stream_skips_connected_hint_and_closes_blocked_read(self):
        ready, released = threading.Event(), threading.Event()
        class Response:
            status = 200
            lines = iter((b'event: dashboard\n', b'data: {"reason":"connected"}\n', b'\n',
                          b'event: dashboard\n', b'data: {"reason":"source-dirty"}\n', b'\n'))
            def getheader(self, *_args):
                return "text/event-stream; charset=utf-8"
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                pass
            def readline(self, _limit):
                line = next(self.lines, None)
                if line is None:
                    released.wait(1)
                    return b""
                return line
        connection = SimpleNamespace(request=lambda *_args, **_kwargs: None, getresponse=lambda: Response(),
                                     sock=SimpleNamespace(shutdown=lambda _how: released.set()), close=lambda: None)
        calls = []
        def dispatch(callback):
            calls.append(callback)
            ready.set()
        with patch.dict(SCOPE, {"HTTPConnection": lambda *_args, **_kwargs: connection}):
            stream = SCOPE["EventStream"]("http://127.0.0.1:1", lambda: None, dispatch)
            try:
                self.assertTrue(ready.wait(1))
                self.assertEqual(len(calls), 1)
            finally:
                stream.close()
                stream.worker.join(1)
            self.assertFalse(stream.worker.is_alive())


if __name__ == "__main__":
    unittest.main()
