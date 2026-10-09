"""Native data, scheduling, and row reuse checks, without GTK or a display."""
import ast
import copy
import itertools
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


SOURCE = Path(__file__).parents[1] / "scripts" / "asb-native.py"
TREE = ast.parse(SOURCE.read_text())
NODES = TREE.body[:next(index for index, node in enumerate(TREE.body) if isinstance(node, ast.Try))]
WINDOW = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SwitchboardWindow"))
WINDOW.bases = []
SOURCES = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "AppSourcesWindow"))
SOURCES.bases = []
MARKER = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SourceMarker"))
MARKER.bases = []
APPLICATION = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SwitchboardApplication"))
APPLICATION.bases = []
STRIP = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SessionStrip"))
STRIP.bases = []
SCOPE = {"__file__": str(SOURCE)}
exec(compile(ast.Module(body=NODES + [STRIP, MARKER, SOURCES, WINDOW, APPLICATION], type_ignores=[]), str(SOURCE), "exec"), SCOPE)
Window = SCOPE["SwitchboardWindow"]
Strip = SCOPE["SessionStrip"]
SourcesWindow = SCOPE["AppSourcesWindow"]
Marker = SCOPE["SourceMarker"]
REQUEST_ASYNC = SCOPE["request_async"]
asb = SimpleNamespace(**SCOPE)
FIXTURE_PATH = Path(__file__).with_name("asb_native_test.py")
FIXTURE_TREE = ast.parse(FIXTURE_PATH.read_text())
FIXTURE_NODES = [node for node in FIXTURE_TREE.body
                 if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                    and target.id in ("NOW", "FIXTURE", "CUSTOM") for target in node.targets)
                 or isinstance(node, ast.FunctionDef) and node.name == "mock_dashboard"]
exec(compile(ast.Module(body=FIXTURE_NODES, type_ignores=[]), str(FIXTURE_PATH), "exec"), globals())


class Box:
    def __init__(self, **_kwargs):
        self.children, self.parent = [], None
        self.label = ""

    def append(self, child):
        self.children.append(child)
        child.parent = self

    def insert(self, child, position):
        self.children.insert(position, child)
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

    def clear_hover(self):
        pass


class DataChecks(unittest.TestCase):
    def test_working_duration_uses_known_current_start_only(self):
        row = {"state": "working", "workingSinceMs": NOW - 133_000}
        self.assertEqual(asb.working_duration(row, NOW), "2m13s")
        self.assertEqual(asb.working_duration(row, NOW + 2_000), "2m15s")
        self.assertEqual(asb.working_duration({**row, "pending": True, "questionPending": True,
                                             "questionAttention": True, "manualUnread": True}, NOW), "2m13s")
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
        with TemporaryDirectory(prefix="asb-layout-test-") as directory:
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
        with TemporaryDirectory(prefix="asb-view-test-") as directory:
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
        with TemporaryDirectory(prefix="asb-theme-test-") as directory:
            path = Path(directory) / "asb" / "theme.json"
            self.assertIsNone(asb.read_theme(path))
            asb.write_theme(path, CUSTOM)
            self.assertEqual(asb.read_theme(path), CUSTOM)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            for invalid in ({**CUSTOM, "text": "#222222"}, {**CUSTOM, "background": "#ffffff"},
                            {**CUSTOM, "accent": "red"}, {**CUSTOM, "extra": "#ffffff"},
                            {**CUSTOM, "muted": "#222222"}, {**CUSTOM, "divider": "#12345"}):
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


class NativeLogicChecks(unittest.TestCase):
    def test_source_form_sends_only_editable_fields_and_valid_local_paths(self):
        body = SCOPE["source_form_body"]
        source = body("codex", " Personal ", "~/.codex-personal", "~/.local/bin/chatgpt-personal",
                      True, "codex-personal", "/ignored")
        self.assertEqual(source, {"source": {"id": "codex-personal", "provider": "codex", "label": "Personal",
                                             "dataDir": str(Path.home() / ".codex-personal"),
                                             "launcher": str(Path.home() / ".local/bin/chatgpt-personal"), "enabled": True}})
        self.assertEqual(body("claude-desktop-code", "Claude", "/profile", "", False, projects_dir="/transcripts"),
                         {"source": {"provider": "claude-desktop-code", "label": "Claude", "dataDir": "/profile",
                                     "launcher": "", "enabled": False, "projectsDir": "/transcripts"}})
        self.assertNotIn("projectsDir", body("claude-desktop-code", "Claude", "/profile", "", True)["source"])
        self.assertNotIn("color", body("codex", "Codex", "/profile", "", True)["source"])
        self.assertNotIn("showMarker", body("codex", "Codex", "/profile", "", True)["source"])
        self.assertEqual(body("codex", "Codex", "/profile", "", True, color="#B28F80")["source"]["color"], "#b28f80")
        for show_marker in (True, False):
            self.assertEqual(body("codex", "Codex", "/profile", "", True, color="#404040", show_marker=show_marker)["source"],
                             {"provider": "codex", "label": "Codex", "dataDir": "/profile", "launcher": "", "enabled": True,
                              "color": "#404040", "showMarker": show_marker})
        for color in (False, 42, {}, "", "#fff", "#8296b4; background:red", "#12345g"):
            with self.subTest(color=color), self.assertRaises(ValueError):
                body("codex", "Codex", "/profile", "", True, color=color)
        for key, value in (("provider", "other"), ("name", ""), ("name", "x" * 81), ("name", "Name\n"),
                           ("data_dir", "relative"), ("data_dir", ""), ("launcher", "chatgpt"),
                           ("launcher", "/bin/chatgpt\x00"), ("enabled", 1), ("identity", "id/name"),
                           ("projects_dir", "relative"), ("show_marker", 1), ("show_marker", "false"), ("show_marker", {})):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                fields = dict(provider="claude-desktop-code", name="Claude", data_dir="/profile", launcher="", enabled=True)
                body(**{**fields, key: value})

    def test_source_requests_serialize_keep_failed_form_and_refresh_after_changes(self):
        window = object.__new__(SourcesWindow)
        builtin = {"id": "codex", "provider": "codex", "builtin": True, "dataDir": "/default"}
        personal = {"id": "codex-personal", "provider": "codex", "builtin": False}
        window.closed = window.loading = window.choosing = False
        window.loaded = window.editing = True
        window.base, window.sources, window.max_sources, window.editing_id = "http://127.0.0.1:1", [builtin, personal], 8, personal["id"]
        window.owner = SimpleNamespace(closed=False, refresh=Mock(), sources_window=window,
                                       hex_color=Mock(return_value="#b28f80"))
        window.source_color = Mock(get_rgba=Mock(return_value=object()))
        window.provider = Mock(get_selected=Mock(return_value=0))
        for name, value in (("name", "Personal"), ("data_dir", "/profile"), ("launcher", "/bin/chatgpt-personal"), ("projects_dir", "")):
            setattr(window, name, Mock(get_text=Mock(return_value=value)))
        window.enabled = Mock(get_active=Mock(return_value=True))
        window.show_marker = Mock(get_active=Mock(return_value=False))
        for name in ("message", "table", "form", "add_button", "save_button", "remove_button", "cancel_button", "reload_button"):
            setattr(window, name, Mock())
        window.render_sources, window.cancellable = Mock(), Mock()
        gtk = SimpleNamespace(AccessibleState=SimpleNamespace(BUSY=0))
        request, dispatch = Mock(), Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=dispatch), "Gtk": gtk}):
            window.owner.hex_color.return_value = "#12345g"
            window.save_source()
            request.assert_not_called()
            window.message.set_label.assert_called_with("Profile color must use a #RRGGBB value.")
            window.source_color.set_rgba.assert_not_called()
            window.owner.hex_color.return_value = "#404040"
            window.save_source()
            self.assertTrue(window.loading)
            window.save_button.set_sensitive.assert_called_with(False)
            window.save_source()
            window.reload_sources()
            request.assert_called_once()
            base, route, callback, actual_dispatch, method, body = request.call_args.args
            self.assertEqual((base, route, actual_dispatch, method), (window.base, "/api/sources", dispatch, "POST"))
            self.assertEqual(set(body["source"]), {"id", "provider", "label", "dataDir", "launcher", "enabled", "color", "showMarker"})
            self.assertEqual(body["source"]["color"], "#404040")
            self.assertIs(body["source"]["showMarker"], False)
            self.assertFalse(callback(None, "This session store is already registered."))
            self.assertFalse(window.loading)
            window.message.set_label.assert_called_with("This session store is already registered.")
            window.name.set_text.assert_not_called()
            window.source_color.set_rgba.assert_not_called()
            window.render_sources.assert_not_called()
            window.owner.refresh.assert_not_called()
            window.save_button.set_sensitive.assert_called_with(True)

            window.editing_id = ""
            window.save_source()
            created = {**personal, "id": "codex-new", "dataDir": "/profile"}
            callback = request.call_args.args[2]
            self.assertFalse(callback({"changed": True, "sources": [builtin, created]}, None))
            window.render_sources.assert_called_with("codex-new")
            window.owner.refresh.assert_called_once_with(True)
            window.message.set_label.assert_called_with("Saved. 2 of 8 app sources")

            request.reset_mock()
            window.editing_id = "codex"
            window.remove_source()
            request.assert_not_called()
            window.update_controls()
            window.remove_button.set_sensitive.assert_called_with(False)
            window.provider.set_sensitive.assert_called_with(False)
            window.max_sources = len(window.sources)
            window.update_controls()
            window.add_button.set_sensitive.assert_called_with(False)

            window.editing_id = "codex-new"
            window.remove_source()
            self.assertEqual((request.call_args.args[1], request.call_args.args[4:]), ("/api/sources/codex-new/remove", ("POST", {})))
            callback = request.call_args.args[2]
            self.assertFalse(callback({"changed": True, "sources": [builtin]}, None))
            self.assertEqual(window.sources, [builtin])
            self.assertEqual(window.owner.refresh.call_count, 2)
            window.message.set_label.assert_called_with("Removed. 1 of 2 app sources")

            window.reload_sources()
            self.assertEqual(request.call_args.args[1], "/api/sources")
            callback = request.call_args.args[2]
            self.assertFalse(window.on_close())
            self.assertIsNone(window.owner.sources_window)
            window.cancellable.cancel.assert_called_once()
            window.render_sources.reset_mock()
            self.assertFalse(callback({"sources": []}, None))
            window.render_sources.assert_not_called()
            self.assertEqual(window.owner.refresh.call_count, 2)
            request.reset_mock()
            window.reload_sources()
            request.assert_not_called()

    def test_source_editor_reload_keeps_the_saved_picker_color_and_dot_setting(self):
        window = object.__new__(SourcesWindow)
        window.owner = SimpleNamespace(rgba=lambda color: color, hex_color=lambda color: color)
        for name in ("form_title", "source_id", "provider", "name", "data_dir", "launcher", "projects_dir", "enabled",
                     "show_marker", "source_color", "source_color_hex", "source_status"):
            setattr(window, name, Mock())
        window.source_color.get_rgba.return_value = "#404040"
        window.provider_changed = window.update_controls = Mock()
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.set_form({"id": "codex", "provider": "codex", "label": "Codex", "enabled": True,
                             "color": "#404040", "showMarker": False})
            window.source_color.set_rgba.assert_called_with("#404040")
            window.source_color_hex.set_label.assert_called_with("#404040")
            window.show_marker.set_active.assert_called_with(False)
            window.enabled.set_active.assert_called_with(True)
            window.set_form({"provider": "codex", "color": "#404040", "showMarker": True})
            window.source_color.set_rgba.assert_called_with("#404040")
            window.show_marker.set_active.assert_called_with(True)
            window.set_form({"provider": "codex"})
            window.show_marker.set_active.assert_called_with(True)

    def test_source_http_errors_keep_server_validation_and_post_origin(self):
        import io
        http_error = SCOPE["HTTPError"]("http://127.0.0.1:1/api/sources", 400, "Bad Request", {},
                                         io.BytesIO(b'{"error":"This session store is already registered."}'))
        transport = Mock(open=Mock(side_effect=http_error))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport}):
            with self.assertRaisesRegex(RuntimeError, "already registered"):
                SCOPE["request_json"]("http://127.0.0.1:1", "/api/sources", "POST", {"source": {}})
        request = transport.open.call_args.args[0]
        self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:1")
        self.assertEqual(request.get_header("Content-type"), "application/json")

    def test_incomplete_http_responses_dispatch_sanitized_failure_and_release_client_latches(self):
        from http.client import IncompleteRead, BadStatusLine
        for failure in (IncompleteRead(b"SYNTHETIC_PRIVATE_BODY", 100), BadStatusLine("SYNTHETIC_PRIVATE_STATUS")):
            transport = Mock(open=Mock(side_effect=failure))
            latches = {"loading": True, "action": True}
            received = []
            def callback(result, error):
                received.append((result, error))
                latches.update(loading=False, action=False)
            dispatch = Mock(side_effect=lambda function, result, error: function(result, error))
            with patch.dict(SCOPE, {"LOCAL_HTTP": transport}):
                worker = REQUEST_ASYNC("http://127.0.0.1:1", "/api/dashboard", callback, dispatch)
                worker.join(1)
            self.assertFalse(worker.is_alive())
            dispatch.assert_called_once()
            self.assertEqual(latches, {"loading": False, "action": False})
            self.assertIsNone(received[0][0])
            self.assertEqual(received[0][1], "Cannot load sessions. Check that ASB is running, then refresh.")
            self.assertNotIn("SYNTHETIC_PRIVATE", received[0][1])
        response = Mock(read=Mock(side_effect=IncompleteRead(b"SYNTHETIC_PRIVATE_BODY", 100)))
        http_error = SCOPE["HTTPError"]("http://127.0.0.1:1/api/sources", 400, "Bad Request", {}, response)
        with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=http_error))}):
            with self.assertRaisesRegex(RuntimeError, "Cannot load or change app sources") as caught:
                SCOPE["request_json"]("http://127.0.0.1:1", "/api/sources")
            self.assertNotIn("SYNTHETIC_PRIVATE", str(caught.exception))

    def test_signal_shutdown_closes_all_windows_including_active_source_window(self):
        application = object.__new__(SCOPE["SwitchboardApplication"])
        main, sources = Mock(), Mock()
        application.get_windows, application.quit = Mock(return_value=[sources, main]), Mock()
        self.assertFalse(application.close_windows())
        sources.close.assert_called_once()
        main.close.assert_called_once()
        application.quit.assert_called_once()

    def test_source_identity_reaches_session_tooltip_and_accessible_description(self):
        window = object.__new__(Window)
        window.view, window.opening, window.open_errors = "compact", set(), {"personal": "Open failed"}
        row = {"id": "personal", "title": "Personal chat", "providerLabel": "Codex", "state": "idle", "canOpen": True,
               "sourceLabel": "ChatGPT Personal", "sourceId": "codex-personal"}
        widget = SimpleNamespace(asb_thread=row, asb_time_signature=None, asb_state_label=Mock(), asb_title_label=Mock(),
                                 set_sensitive=Mock(), set_tooltip_text=Mock(), update_property=Mock(), update_state=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.update_row_text(widget, 100_000)
            self.assertIn("App source: ChatGPT Personal (codex-personal)", widget.asb_tooltip)
            self.assertIn("App source: ChatGPT Personal (codex-personal)", widget.update_property.call_args.args[1][1])
            self.assertIn("Open failed", widget.update_property.call_args.args[1][1])
            row.update(sourceColor="#b28f80", sourceCount=2)
            widget.asb_time_signature = None
            window.update_row_text(widget, 100_000)
            self.assertIn("Profile color marker: #b28f80", widget.asb_tooltip)
            self.assertIn("App source: ChatGPT Personal (codex-personal). Profile color marker: #b28f80", widget.update_property.call_args.args[1][1])
            del row["sourceLabel"], row["sourceId"], row["sourceColor"], row["sourceCount"]
            widget.asb_time_signature = None
            window.update_row_text(widget, 100_000)
            self.assertNotIn("App source:", widget.asb_tooltip)
            self.assertIn("Open failed", widget.update_property.call_args.args[1][1])
            self.assertNotIn("App source:", widget.update_property.call_args.args[1][1])

    def test_profile_circle_validates_color_and_updates_existing_rows_in_both_views(self):
        color = SCOPE["source_marker_color"]
        for value, count, expected in (("#8296b4", 2, "#8296b4"), ("#B28F80", 8, "#b28f80"), (None, None, ""),
                                       ("#8296b4", 1, ""), ("#8296b4", 0, ""), ("#8296b4", -1, ""),
                                       ("#8296b4", True, ""), ("#8296b4", "2", ""), ("#8296b4", 2.0, ""),
                                       (True, 2, ""), (42, 2, ""), ("#101010", 2, "#101010"), ("#fff", 2, ""),
                                       ("#8296b4; opacity:0", 2, "")):
            self.assertEqual(color({"sourceColor": value, "sourceCount": count}), expected)
        for show_marker, expected in ((True, "#404040"), (False, ""), (1, ""), ("true", ""), (None, "")):
            self.assertEqual(color({"sourceColor": "#404040", "sourceCount": 2, "sourceShowMarker": show_marker}), expected)
        window = object.__new__(Window)
        window.clear_read_feedback = window.update_card_actions = window.update_row_text = Mock()
        window.open_errors = {}
        for view in ("compact", "comfortable"):
            for provider in ("codex", "claude-desktop-code"):
                window.view = view
                badge = Mock()
                widget = SimpleNamespace(asb_view=view, asb_thread={}, asb_mark=Mock(), asb_source_badge=badge,
                                         asb_dot=Mock(), asb_state_label=Mock(), asb_folder=Mock(), set_child=Mock(),
                                         set_activatable=Mock(), add_css_class=Mock(), remove_css_class=Mock())
                row = {"id": "profile-chat", "provider": provider, "state": "working", "unread": True}
                for metadata, expected in (({"sourceColor": "#8296b4", "sourceCount": 2}, "#8296b4"),
                                           ({"sourceColor": "#b28f80", "sourceCount": 2.0}, ""),
                                           ({"sourceColor": "#b28f80", "sourceCount": 2}, "#b28f80"),
                                           ({"sourceColor": "#404040", "sourceCount": 2, "sourceShowMarker": False}, ""),
                                           ({"sourceColor": "#404040", "sourceCount": 2, "sourceShowMarker": True}, "#404040"),
                                           ({"sourceColor": "#b28f80", "sourceCount": 1}, ""), ({}, "")):
                    window.update_session_row(widget, {**row, **metadata})
                    badge.set_color.assert_called_with(expected)
                    self.assertIs(widget.asb_source_badge, badge)
                    self.assertEqual(widget.asb_thread, {**row, **metadata})
                    widget.asb_dot.set_visible.assert_called_with(True)
                    widget.asb_state_label.add_css_class.assert_any_call("asb-working")
                    widget.asb_state_label.add_css_class.assert_any_call("success")
                widget.set_child.assert_not_called()

    def test_profile_marker_owns_safe_css_and_clamps_only_the_display_color(self):
        marker = object.__new__(Marker)
        marker.owner = SimpleNamespace(profile_surfaces=("#0f0f0f", "#242424"))
        marker.style_provider, marker.set_visible = Mock(), Mock()
        marker.set_color("#B28F80")
        self.assertEqual(marker.configured_color, "#b28f80")
        css = marker.style_provider.load_from_string.call_args.args[0]
        self.assertIn("background: #b28f80", css)
        self.assertIn("border-color: #0f0f0f", css)
        self.assertIn("border-color: #242424", css)
        marker.style_provider.load_from_string.reset_mock()
        marker.set_color("#b28f80")
        marker.style_provider.load_from_string.assert_not_called()
        marker.owner.profile_surfaces = ("#606060", "#707070")
        marker.set_color(marker.configured_color)
        css = marker.style_provider.load_from_string.call_args.args[0]
        displayed = SCOPE["re"].search(r"background: (#[0-9a-f]{6})", css)[1]
        self.assertNotEqual(displayed, marker.configured_color)
        self.assertEqual(marker.configured_color, "#b28f80")
        for surface in marker.owner.profile_surfaces:
            self.assertGreaterEqual(SCOPE["contrast"](displayed, surface), 3)
        marker.owner.profile_surfaces = ("#0f0f0f", "#242424")
        for color in ("#000000", "#404040"):
            marker.set_color(color)
            self.assertEqual(marker.configured_color, color)
            css = marker.style_provider.load_from_string.call_args.args[0]
            displayed = SCOPE["re"].search(r"background: (#[0-9a-f]{6})", css)[1]
            self.assertNotEqual(displayed, marker.configured_color)
            for surface in marker.owner.profile_surfaces:
                self.assertGreaterEqual(SCOPE["contrast"](displayed, surface), 3)
        for invalid in ("", None, False, "#8296b4} button{opacity:0", "#12345g"):
            marker.set_color(invalid)
            self.assertEqual(marker.configured_color, "")
            marker.set_visible.assert_called_with(False)
            marker.style_provider.load_from_string.assert_called_with("")
        for _name, preset in SCOPE["SOURCE_COLOR_PRESETS"]:
            self.assertEqual(SCOPE["validate_source_color"](preset), preset)

    def test_source_count_type_change_refreshes_markers_despite_numeric_equality(self):
        window = object.__new__(Window)
        window.closed = window.refresh_queued = window.snapshot_pending = False
        window.refresh_interval_ms, window.clock_interval = 5000, 60
        window.refresh_button, window.sync_unread_setting, window.set_notice, window.update_clock, window.render = (Mock() for _ in range(5))
        row = {"id": "profile-chat", "state": "idle", "sourceCount": 2, "sourceColor": "#b28f80"}
        window.signature = [row]
        window.apply_dashboard({"threads": [{**row, "sourceCount": 2.0}]}, None)
        window.render.assert_called_once()
        self.assertEqual(SCOPE["source_marker_color"](window.signature[0]), "")

    def test_source_name_search_keeps_app_prefix_archive_and_pending_filters(self):
        filtered = SCOPE["filtered_rows"]
        board = {"threads": [
            {"id": "main", "provider": "codex", "sourceLabel": "Codex", "state": "idle"},
            {"id": "personal", "provider": "codex", "sourceLabel": "ChatGPT Personal", "state": "working"},
            {"id": "claude", "provider": "claude-desktop-code", "sourceLabel": "Claude Personal", "state": "idle", "pending": True},
            {"id": "archived", "provider": "codex", "sourceLabel": "ChatGPT Personal", "state": "working", "archived": True},
        ]}
        self.assertEqual({row["id"] for row in filtered(board, "PERSONAL")}, {"personal", "claude"})
        self.assertEqual([row["id"] for row in filtered(board, "Personal", app="codex")], ["personal"])
        self.assertEqual([row["id"] for row in filtered(board, "cx:Personal", app="claude-desktop-code")], ["personal"])
        self.assertEqual([row["id"] for row in filtered(board, "cl:Personal", app="codex")], ["claude"])
        self.assertEqual([row["id"] for row in filtered(board, "Personal", pending_only=True)], ["claude"])
        self.assertEqual([row["id"] for row in filtered(board, "Personal", state={"working"}, pending_only=True)], ["claude", "personal"])
        self.assertEqual({row["id"] for row in filtered(board, "Personal", app="codex", archived=True)}, {"personal", "archived"})

    def test_policy_and_read_menu_use_current_asb_dot(self):
        interval, actions = SCOPE["refresh_interval"], SCOPE["row_menu_actions"]
        for value, expected in ((2000, 2000), (5000, 5000), (None, 5000), (True, 5000), (10, 5000)):
            self.assertEqual(interval({"refreshIntervalMs": value}), expected)
        for row in ({"unread": True}, {"questionAttention": True}, {"retainedUnread": True, "unread": True}):
            self.assertEqual(actions(row)[0], ("Read", "mark-read"))
            self.assertNotIn(("Unread", "mark-unread"), actions(row))
        self.assertEqual(actions({"nativeUnread": True, "nativeAttention": False})[0], ("Unread", "mark-unread"))
        self.assertEqual([action for _, action in actions({"pinned": True})], ["mark-unread", "unpin", "pin-up", "pin-down"])

    def test_attention_indicator_prefers_question_and_working_rows_hide_unread_text(self):
        indicator = SCOPE["attention_indicator"]
        for row, expected in (({}, ""), ({"unread": True}, "dot"), ({"questionAttention": True}, "question"),
                              ({"unread": True, "questionAttention": True}, "question"),
                              ({"state": "working", "unread": False, "manualUnread": True, "nativeAttention": True,
                                "retainedUnread": True}, ""),
                              ({"state": "working", "unread": False, "questionAttention": True}, "question")):
            self.assertEqual(indicator(row), expected)
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(), set_child=Mock(), asb_mark=Mock(),
                                 asb_source_badge=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
                                 add_css_class=Mock(), remove_css_class=Mock())
        glyph = widget.asb_dot.get_first_child.return_value
        row = {"id": "a", "provider": "codex", "state": "working", "questionAttention": True}
        for change, visible, question in (({}, True, True), ({"questionAttention": False}, False, False),
                                          ({"state": "idle", "unread": True}, True, False)):
            row.update(change)
            window.update_session_row(widget, row)
            widget.asb_dot.set_visible.assert_called_with(visible)
            glyph.set_visible.assert_called_with(question)
            (widget.asb_dot.add_css_class if question else widget.asb_dot.remove_css_class).assert_any_call("asb-question")
        widget.set_child.assert_not_called()
        del window.update_row_text
        window.opening, window.open_errors = set(), {}
        marks = {"manualUnread": True, "nativeUnread": True, "nativeAttention": True, "readStatus": "unread",
                 "retainedUnread": True, "retainedUnreadSource": "native-unread"}
        widget = SimpleNamespace(asb_time_signature=None, asb_state_label=Mock(), asb_title_label=Mock(), set_sensitive=Mock(),
                                 set_tooltip_text=Mock(), update_property=Mock(), update_state=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for extra, shown, hidden in (({"state": "working", "unread": False}, (), ("unread", "Unread", "retained")),
                                         ({"state": "working", "unread": False, "questionAttention": True},
                                          ("Question needs your answer.", "Asks a question. Open the chat to answer."), ("unread", "Unread", "retained")),
                                         ({"state": "idle", "unread": True}, ("Marked as unread in ASB.", "Unread in the original app.",
                                                                              "Unread retained in ASB.", "Marked unread in ASB."), ())):
                widget.asb_thread, widget.asb_time_signature = {"id": "a", "title": "Chat", "providerLabel": "Codex", **marks, **extra}, None
                window.update_row_text(widget, 100_000)
                text = widget.asb_accessible_label + "\n" + widget.asb_tooltip
                for value in shown:
                    self.assertIn(value, text)
                for value in hidden:
                    self.assertNotIn(value, text)

    def test_stop_and_permission_marks_are_passive_and_keep_pin_actions(self):
        indicator, actions = SCOPE["attention_indicator"], SCOPE["row_menu_actions"]
        stop = {"id": "a", "title": "Chat", "state": "idle", "lastOutcome": "stopped"}
        wait = {**stop, "state": "waiting", "actionRequired": True, "unread": True, "questionAttention": True}
        for row, expected in ((stop, "stop"), ({**stop, "unread": True}, "dot"),
                              ({**stop, "questionAttention": True}, "question"), (wait, "question"),
                              ({**stop, "state": "working"}, "")):
            self.assertEqual(indicator(row), expected)
        self.assertEqual(actions(stop)[0], ("Unread", "mark-unread"))
        self.assertEqual(actions(wait), [("Pin", "pin")])
        self.assertEqual(actions({**wait, "pinned": True}), [("Unpin", "unpin"),
                         ("Move pin earlier", "pin-up"), ("Move pin later", "pin-down")])
        window = object.__new__(Window)
        window.session_actions = set()
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=stop, asb_read_timer=None,
                                 asb_read_button=Mock(), asb_pin_button=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for row in (stop, wait):
                widget.asb_thread = row
                window.update_card_actions(widget)
                widget.asb_read_button.set_visible.assert_called_with(True)
                widget.asb_read_button.set_focusable.assert_called_with(False)
                widget.asb_read_button.set_action_name.assert_called_with(None)
                widget.asb_read_button.add_css_class.assert_any_call("asb-passive-indicator")
                widget.asb_read_button.update_state.assert_called_with([0, 1], [False, True])
                widget.asb_pin_button.set_action_name.assert_called_with("win.pin")
            widget.asb_thread = {**stop, "unread": True}
            window.update_card_actions(widget)
            widget.asb_read_button.set_action_name.assert_called_with("win.mark-read")
            widget.asb_read_button.set_focusable.assert_called_with(True)
            widget.asb_read_button.remove_css_class.assert_any_call("asb-passive-indicator")
        css = SOURCE.read_text()
        self.assertIn(".asb-dot.asb-stop {{ border-radius: 1px;", css)
        self.assertIn(".asb-dot.asb-stop {{ background: {colors['muted']};", css)
        self.assertIn(":hover:not(.asb-passive-indicator):not(.asb-discard-button) .asb-read-cue", css)

    def test_row_text_names_failed_stopped_and_current_permission_waits(self):
        window = object.__new__(Window)
        window.view, window.opening, window.open_errors = "compact", set(), {}
        widget = SimpleNamespace(asb_time_signature=None, asb_state_label=Mock(), asb_title_label=Mock(),
                                 set_tooltip_text=Mock(), update_property=Mock(), update_state=Mock(), set_sensitive=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                              AccessibleState=SimpleNamespace(BUSY=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for extra, expected in (({"lastOutcome": "stopped"}, "Task stopped."),
                                    ({"lastOutcome": "failed", "unread": True, "failedAttention": True}, "Task failed."),
                                    ({"state": "waiting", "actionRequired": True}, "A user action is required in the original app.")):
                widget.asb_thread = {"id": "a", "title": "Chat", "providerLabel": "Codex", "state": "idle", **extra}
                widget.asb_time_signature = None
                window.update_row_text(widget, 100_000)
                self.assertIn(expected, widget.asb_accessible_label)
                self.assertNotIn("completed task", widget.asb_tooltip)
                if extra.get("actionRequired"):
                    self.assertIn("Waits for your permission.", widget.asb_tooltip)

    def test_discard_ring_priorities_menus_and_comfortable_action_modes(self):
        indicator, actions = SCOPE["attention_indicator"], SCOPE["row_menu_actions"]
        working = {"id": "a", "title": "Chat", "state": "working", "discardResult": True}
        for extra, expected in (({}, "discard"), ({"unread": True}, "dot"),
                                ({"questionAttention": True}, "question"), ({"actionRequired": True}, "question"),
                                ({"state": "idle", "lastOutcome": "stopped"}, "stop"), ({"state": "idle"}, "")):
            self.assertEqual(indicator({**working, **extra}), expected)
        self.assertEqual(actions(working)[-1], ("Keep result", "keep-result"))
        self.assertEqual(actions({**working, "discardResult": False})[-1], ("Discard result", "discard-result"))
        self.assertNotIn(("Discard result", "discard-result"), actions({"state": "idle"}))
        window = object.__new__(Window)
        window.session_actions = set()
        window.clear_read_feedback = Mock(side_effect=lambda item: setattr(item, "asb_read_timer", None))
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=working, asb_read_timer=None,
                                 asb_read_button=Mock(), asb_pin_button=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for armed, action, text in ((False, "win.discard-result", "Discard result: go to read Idle when this task ends"),
                                       (True, "win.keep-result", "Keep result: show the dot when this task ends")):
                widget.asb_thread = {**working, "discardResult": armed}
                window.update_card_actions(widget)
                widget.asb_read_button.set_visible.assert_called_with(True)
                widget.asb_read_button.set_focusable.assert_called_with(True)
                widget.asb_read_button.set_action_name.assert_called_with(action)
                widget.asb_read_button.set_tooltip_text.assert_called_with(text)
                widget.asb_read_button.update_state.assert_called_with([0, 1], [False, False])
                widget.asb_read_button.add_css_class.assert_any_call("asb-discard-button")
                (widget.asb_read_button.remove_css_class if armed else widget.asb_read_button.add_css_class).assert_any_call("asb-discard-offer")
            window.session_actions.add("a")
            window.update_card_actions(widget)
            widget.asb_read_button.set_action_name.assert_called_with(None)
            widget.asb_read_button.set_sensitive.assert_called_with(True)
            widget.asb_read_button.update_state.assert_called_with([0, 1], [True, True])
            window.session_actions.clear()
            widget.asb_thread = {**working, "questionAttention": True}
            window.update_card_actions(widget)
            widget.asb_read_button.set_action_name.assert_called_with("win.mark-read")
            widget.asb_read_button.remove_css_class.assert_any_call("asb-discard-button")
            widget.asb_thread = {**working, "actionRequired": True}
            window.update_card_actions(widget)
            widget.asb_read_button.set_action_name.assert_called_with(None)
            widget.asb_read_button.set_focusable.assert_called_with(False)
            for armed in (False, True):
                widget.asb_thread = {**working, "discardResult": armed}
                widget.asb_read_timer = 42
                window.update_card_actions(widget)
                self.assertIsNone(widget.asb_read_timer)
                widget.asb_read_button.remove_css_class.assert_any_call("asb-read-confirmed")
                widget.asb_read_button.set_action_name.assert_called_with("win.keep-result" if armed else "win.discard-result")
            self.assertEqual(window.clear_read_feedback.call_count, 2)
        source = SOURCE.read_text()
        self.assertIn("min-width: 6px; min-height: 6px; border: 1.5px solid @window_fg_color", source)
        self.assertIn(".asb-discard-button.asb-discard-offer {{ opacity: 0;", source)
        self.assertIn(".asb-session:focus-within .asb-discard-offer {{ opacity: 1;", source)

    def test_compact_discard_ring_is_passive_and_keeps_row_geometry(self):
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(), set_child=Mock(), asb_mark=Mock(),
                                 asb_source_badge=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
                                 add_css_class=Mock(), remove_css_class=Mock())
        row = {"id": "a", "provider": "codex", "state": "working", "discardResult": True, "workingSinceMs": 1}
        window.update_session_row(widget, row)
        widget.asb_dot.set_visible.assert_called_with(True)
        widget.asb_dot.add_css_class.assert_any_call("asb-discard")
        widget.asb_dot.get_first_child().set_visible.assert_called_with(False)
        widget.set_child.assert_not_called()
        self.assertFalse(hasattr(widget, "asb_read_button"))
        self.assertEqual(SCOPE["ROW_HEIGHT"], 22)
        self.assertEqual(SCOPE["COMFORTABLE_ROW_HEIGHT"], 68)

    def test_tooltip_model_notes_follow_the_visible_indicator_and_source(self):
        model = SCOPE["tooltip_model"]
        base = {"id": "a", "state": "idle", "title": "Chat", "providerLabel": "Codex", "canOpen": True}
        cases = [({"questionAttention": True}, "question", "Asks a question. Open the chat to answer."),
                 ({"actionRequired": True, "questionAttention": True}, "question", "Waits for your permission."),
                 ({"unread": True, "pendingSource": "observed-completion", "completionAttention": True}, "dot", "Finished. Not read yet."),
                 ({"unread": True, "pendingSource": "observed-failure", "failedAttention": True}, "dot", "Failed. Not read yet."),
                 ({"unread": True, "pendingSource": "native-unread", "nativeAttention": True}, "dot", "Unread in the original app."),
                 ({"unread": True, "pendingSource": "manual-unread", "manualUnread": True}, "dot", "Marked unread in ASB."),
                 ({"unread": True, "retainedUnread": True}, "dot", "Unread kept in ASB. Use Read to clear it."),
                 ({"lastOutcome": "stopped"}, "stop", "You stopped this task."),
                 ({"state": "working", "discardResult": True}, "discard", "Discard is on for this task."),
                 ({"questionPending": True}, "", "A question is still open in the chat."),
                 ({"lastOutcome": "failed", "unread": False}, "", ""), ({}, "", "")]
        for extra, indicator, note in cases:
            value = model({**base, **extra}, 100_000, "/home/test")
            self.assertEqual((value["indicator"], value["note"]), (indicator, note))
        combined = {**base, "unread": True, "manualUnread": True, "nativeAttention": True,
                    "completionAttention": True, "failedAttention": True, "retainedUnread": True}
        for source, note in (("manual-unread", "Marked unread in ASB."), ("native-unread", "Unread in the original app."),
                             ("observed-completion", "Finished. Not read yet."), ("observed-failure", "Failed. Not read yet."),
                             ("user-question", "Unread kept in ASB. Use Read to clear it.")):
            self.assertEqual(model({**combined, "pendingSource": source}, 100_000, "/home/test")["note"], note)
        retained_read = {**base, "unread": True, "retainedUnread": True, "pendingSource": "native-unread", "nativeAttention": False}
        self.assertEqual(model(retained_read, 100_000, "/home/test")["note"], "Unread kept in ASB. Use Read to clear it.")
        self.assertEqual(model({**base, "state": "working", "questionAttention": True, "discardResult": True},
                               100_000, "/home/test")["note"], "Asks a question. Open the chat to answer.")

    def test_tooltip_paths_apps_times_flags_and_description_keep_full_data(self):
        model, description = SCOPE["tooltip_model"], SCOPE["tooltip_description"]
        base = {"id": "a", "state": "working", "provider": "codex", "providerLabel": "Codex", "canOpen": True,
                "title": "<b>Long title</b> " + "字" * 500, "updatedAtMs": 100_000, "workingSinceMs": 101_000}
        for path, expected in (("/home/test", "~"), ("/home/test/project/deep", "~/project/deep"),
                               ("/home/test-other/project", "/home/test-other/project"), ("/work/project", "/work/project")):
            value = model({**base, "cwd": path}, 223_000, "/home/test/")
            self.assertEqual((value["path"], value["full_path"]), (expected, path))
            self.assertIn(path, description(value))
            self.assertEqual(value["state_text"], "Working · 2m2s")
            self.assertEqual(value["title"], base["title"])
        self.assertEqual(model({**base, "projectName": "Project"}, 223_000, "/home/test")["path"], "Project")
        self.assertEqual(model(base, 223_000, "/home/test")["path"], "No project folder")
        unknown = model({**base, "workingSinceMs": 0}, 223_000, "/home/test")
        self.assertEqual(unknown["state_text"], "Working · 2m ago")
        source = {**base, "sourceLabel": "Personal", "sourceId": "codex-personal", "sourceCount": 2,
                  "sourceColor": "#B28F80", "pinned": True, "archived": True, "canOpen": False, "reason": "Recorded state reason."}
        value = model(source, 223_000, "/home/test", "Cannot open this session.")
        self.assertEqual((value["app"], value["app_color"], value["flags"]),
                         ("Codex · Personal", "#b28f80", "Pinned · Archived · No direct link"))
        for text in (base["title"], "Recorded state reason.", "Personal", "codex-personal", "Cannot open this session."):
            self.assertIn(text, description(value))
        self.assertEqual(model({**source, "sourceLabel": "Codex"}, 223_000, "/home/test")["app"], "Codex")
        for extra in ({"sourceCount": 1}, {"sourceCount": True}, {"sourceShowMarker": False}, {"sourceColor": "#fff"}):
            self.assertEqual(model({**source, **extra}, 223_000, "/home/test")["app_color"], "")
        long_path = "/work/" + "directory/" * 100
        self.assertEqual(model({**base, "cwd": long_path}, 223_000, "/home/test")["path"], long_path)

    def test_tooltip_query_reuses_content_and_rebuilds_on_rendered_changes_without_reads(self):
        window = object.__new__(Window)
        window.closed, window.open_errors, window.hover_colors = False, {"a": "First error"}, None
        window.refresh = Mock()
        window.tooltip_content = Mock(side_effect=lambda _row, _model: object())
        widget = SimpleNamespace(asb_thread={"id": "a", "title": "First", "state": "working", "canOpen": True,
                                            "provider": "codex", "providerLabel": "Codex", "workingSinceMs": 98_000, "updatedAtMs": 99_000},
                                 asb_tooltip_key=None, asb_tooltip_content=None)
        tooltip, request, clock = Mock(), Mock(), Mock(return_value=100)
        with patch.dict(SCOPE, {"time": SimpleNamespace(time=clock), "request_async": request}):
            for _ in range(100):
                self.assertTrue(window.query_row_tooltip(widget, 0, 0, False, tooltip))
            window.tooltip_content.assert_called_once()
            self.assertEqual(tooltip.set_custom.call_count, 100)
            first = window.tooltip_content.call_args.args[1]
            first_custom = tooltip.set_custom.call_args.args[0]
            self.assertTrue(all(call.args[0] is first_custom for call in tooltip.set_custom.call_args_list))
            clock.return_value = 100.9
            window.query_row_tooltip(widget, 0, 0, False, tooltip)
            self.assertEqual(window.tooltip_content.call_count, 1)
            clock.return_value = 101
            window.query_row_tooltip(widget, 0, 0, False, tooltip)
            self.assertEqual(window.tooltip_content.call_count, 2)
            self.assertEqual(window.tooltip_content.call_args.args[1]["state_text"], "Working · 3s")
            window.open_errors.clear()
            window.query_row_tooltip(widget, 0, 0, False, tooltip)
            self.assertEqual(window.tooltip_content.call_count, 3)
            widget.asb_thread.update(sourceLabel="Personal", sourceCount=2, sourceColor="#8296b4")
            window.query_row_tooltip(widget, 0, 0, False, tooltip)
            self.assertEqual(window.tooltip_content.call_count, 4)
            widget.asb_thread["provider"] = "claude-desktop-code"
            window.query_row_tooltip(widget, 0, 0, False, tooltip)
            self.assertEqual(window.tooltip_content.call_count, 5)
            window.hover_colors = {"text": "#ffffff"}
            window.query_row_tooltip(widget, 0, 0, False, tooltip)
            self.assertEqual(window.tooltip_content.call_count, 6)
            widget.asb_thread.update(title="Second", discardResult=True)
            window.query_row_tooltip(widget, 0, 0, True, tooltip)
            second = window.tooltip_content.call_args.args[1]
            self.assertEqual((first["title"], first["state_text"], first["error"]), ("First", "Working · 2s", "First error"))
            self.assertEqual((second["title"], second["error"], second["note"]), ("Second", "", "Discard is on for this task."))
            self.assertIsNot(tooltip.set_custom.call_args.args[0], first_custom)
            builds = window.tooltip_content.call_count
            widget.asb_thread["pending"] = True
            window.query_row_tooltip(widget, 0, 0, True, tooltip)
            self.assertEqual(window.tooltip_content.call_count, builds + 1)
            request.assert_not_called()
            window.refresh.assert_not_called()
            window.closed = True
            self.assertFalse(window.query_row_tooltip(widget, 0, 0, False, tooltip))
            self.assertEqual(window.tooltip_content.call_count, builds + 1)

    def test_tooltip_palette_invalidation_clears_visible_and_hidden_row_cache(self):
        window = object.__new__(Window)
        window.css, window.add_css_class, window.remove_css_class = Mock(), Mock(), Mock()
        palette = {"background": "#0f0f0f", "text": "#f6f5f4", "muted": "#aaaaaa", "accent": "#cccccc", "divider": "#444444"}
        window.native_colors = lambda: palette
        rows = {name: SimpleNamespace(asb_thread={"id": name}, asb_source_badge=Mock(),
                                     asb_tooltip_content=object(), asb_tooltip_key=(name,)) for name in ("visible", "hidden")}
        window.row_cache, window.focus_widgets = rows, {"visible": rows["visible"]}
        for colors in (None, palette):
            for row in rows.values():
                row.asb_tooltip_content, row.asb_tooltip_key = object(), ("cached",)
            window.set_palette(colors)
            for row in rows.values():
                self.assertIsNone(row.asb_tooltip_content)
                self.assertIsNone(row.asb_tooltip_key)
                row.asb_source_badge.set_color.assert_called_with("")

    def test_tooltip_query_handler_has_one_row_lifetime_and_no_static_row_tooltip(self):
        window = object.__new__(Window)
        window.update_session_row, window.clear_read_feedback = Mock(), Mock()
        widget = Mock()
        widget.get_parent.return_value = None
        widget.connect.return_value = 77
        controllers = []
        def controller(**_kwargs):
            value = Mock()
            controllers.append(value)
            return value
        gtk = SimpleNamespace(ListBoxRow=lambda **_kwargs: widget, EventControllerKey=controller,
                              EventControllerFocus=controller, GestureClick=controller, DragSource=controller,
                              DropTarget=SimpleNamespace(new=lambda *_args: controller()),
                              PropagationPhase=SimpleNamespace(CAPTURE=0))
        with patch.dict(SCOPE, {"Gtk": gtk, "Gdk": SimpleNamespace(DragAction=SimpleNamespace(MOVE=0)),
                               "GObject": SimpleNamespace(TYPE_STRING=0)}):
            self.assertIs(window.session_row({"id": "a"}), widget)
            widget.set_has_tooltip.assert_called_once_with(True)
            widget.connect.assert_called_once_with("query-tooltip", window.query_row_tooltip)
            self.assertEqual(len(widget.asb_handlers), 5)
            self.assertIsNone(widget.asb_tooltip_content)
            self.assertIsNone(widget.asb_tooltip_key)
            widget.asb_tooltip_content, widget.asb_tooltip_key = object(), ("cached",)
            window.release_row(widget)
            self.assertIsNone(widget.asb_tooltip_content)
            self.assertIsNone(widget.asb_tooltip_key)
            widget.disconnect.assert_called_once_with(77)
            self.assertEqual(widget.remove_controller.call_count, 5)
            self.assertTrue(all(call.args[0] is not widget for call in widget.remove_controller.call_args_list))
            self.assertIsNone(widget.asb_tooltip_handler)
            widget.set_tooltip_text.assert_not_called()
        method = next(node for node in WINDOW.body if isinstance(node, ast.FunctionDef) and node.name == "tooltip_content")
        forbidden = {"set_ellipsize", "set_lines", "set_height_request", "set_size_request", "set_markup"}
        self.assertFalse(any(isinstance(node, ast.Attribute) and node.attr in forbidden for node in ast.walk(method)))

    def test_gtk_fixtures_and_action_responses_match_attention_without_loading_gtk(self):
        import io
        import json
        tree = ast.parse((SOURCE.parent.parent / "test" / "asb_native_test.py").read_text())
        nodes = [node for node in tree.body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id in ("NOW", "FIXTURE") for target in node.targets)]
        nodes.append(next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "mock_dashboard"))
        menu_test = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                         and node.name == "test_actual_menu_activation_multistate_and_pin_drag")
        nodes.append(next(node for node in ast.walk(menu_test) if isinstance(node, ast.FunctionDef) and node.name == "do_POST"))
        fixture = {"json": json, "received": []}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "<pure GTK fixture data>", "exec"), fixture)
        fixture["dashboard"] = fixture["mock_dashboard"]()
        def consistent(rows):
            for row in rows:
                if row["state"] == "working":
                    self.assertFalse(row.get("unread"))
                    self.assertEqual(bool(row.get("pending")), bool(row.get("questionAttention") or row.get("actionRequired")))
                if row.get("unread") or row.get("questionAttention") or row.get("actionRequired"):
                    self.assertTrue(row.get("pending"))
        def post(path, body=None):
            payload = json.dumps(body or {}).encode()
            request = SimpleNamespace(path=path, headers={"Content-Length": str(len(payload)), "Origin": "http://127.0.0.1:1"},
                                      rfile=io.BytesIO(payload), wfile=io.BytesIO(), send_response=Mock(), end_headers=Mock())
            fixture["do_POST"](request)
            consistent(fixture["dashboard"]["threads"])
        consistent(fixture["FIXTURE"]["threads"])
        consistent(fixture["dashboard"]["threads"])
        rows = fixture["dashboard"]["threads"]
        post("/api/threads/sample-12/mark-unread")
        self.assertTrue(rows[12]["manualUnread"])
        self.assertNotIn(("Read", "mark-read"), SCOPE["row_menu_actions"](rows[12]))
        rows[12].update(state="idle", unread=True, pending=True, pendingSource="manual-unread")
        self.assertIn(("Read", "mark-read"), SCOPE["row_menu_actions"](rows[12]))
        post("/api/threads/sample-12/mark-read")
        self.assertFalse(rows[12]["manualUnread"])
        post("/api/settings/unread", {"persistentUnread": True})
        self.assertTrue(rows[15]["retainedUnread"])
        self.assertEqual(SCOPE["attention_indicator"](rows[15]), "")
        self.assertNotIn(("Read", "mark-read"), SCOPE["row_menu_actions"](rows[15]))
        rows[15].update(state="idle", unread=True, pending=True, pendingSource="native-unread")
        self.assertIn(("Read", "mark-read"), SCOPE["row_menu_actions"](rows[15]))
        post("/api/threads/sample-15/mark-read")
        self.assertFalse(rows[15]["retainedUnread"])
        self.assertFalse(rows[15]["nativeUnread"])
        self.assertEqual(rows[15]["readStatus"], "read")
        post("/api/threads/sample-0/mark-read")
        self.assertTrue(rows[0]["questionPending"])
        self.assertFalse(rows[0]["questionAttention"])
        post("/api/threads/sample-1/mark-read")
        self.assertTrue(rows[1]["actionRequired"])
        self.assertTrue(rows[1]["pending"])
        self.assertNotIn(("Read", "mark-read"), SCOPE["row_menu_actions"](rows[1]))

    def test_working_pill_shares_states_without_recursive_updates(self):
        window = object.__new__(Window)
        def toggle(active, changed=lambda: None):
            control = SimpleNamespace(active=active, get_active=lambda: control.active)
            def set_active(value):
                if control.active != value:
                    control.active = value
                    changed()
            control.set_active = set_active
            return control

        window.states, window.updating_states = set(SCOPE["STATES"]), False
        window.state_checks = {state: toggle(True, window.states_changed) for state in SCOPE["STATES"]}
        window.working_only = toggle(False, window.working_from_pill)
        window.state_filter, window.render = Mock(), Mock()
        window.list_body = Mock()
        window.select_states = Mock(wraps=window.select_states)
        window.apps, window.syncing_apps = set(), False
        window.app_pills = {app: toggle(False, window.apps_from_pills) for app in ("codex", "claude-desktop-code")}
        window.app_filter = Mock()
        window.search = Mock(get_text=Mock(return_value=""))
        window.archive, window.pending_only = toggle(False), toggle(False)
        window.dashboard = {"threads": [
            {"id": "codex-working", "provider": "codex", "state": "working", "pending": True},
            {"id": "claude-working", "provider": "claude-desktop-code", "state": "working", "pending": True},
            {"id": "codex-active", "provider": "codex", "state": "working"},
            {"id": "codex-idle", "provider": "codex", "state": "idle", "pending": True},
            {"id": "archived", "provider": "codex", "state": "working", "pending": True, "archived": True},
        ]}
        def selection(states):
            self.assertEqual(window.states, states)
            self.assertEqual({state for state, check in window.state_checks.items() if check.get_active()}, states)
            self.assertEqual(window.working_only.get_active(), states == {"working"})
            self.assertFalse(window.updating_states)
            window.render.assert_called_once()
            window.render.reset_mock()

        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0))}):
            window.states_changed()
            selection(set(SCOPE["STATES"]))
            window.working_only.set_active(True)
            window.select_states.assert_called_once_with({"working"})
            selection({"working"})
            window.select_apps({"codex"})
            self.assertEqual({row["id"] for row in window.visible_rows()}, {"codex-working", "codex-active"})
            window.pending_only.set_active(True)
            self.assertEqual({row["id"] for row in window.visible_rows()}, {"codex-working", "codex-active", "codex-idle"})
            window.select_apps({"claude-desktop-code"})
            self.assertEqual([row["id"] for row in window.visible_rows()], ["claude-working"])
            window.search.get_text.return_value = "cx:"
            self.assertEqual({row["id"] for row in window.visible_rows()}, {"codex-working", "codex-active", "codex-idle"})
            window.archive.set_active(True)
            self.assertEqual({row["id"] for row in window.visible_rows()}, {"codex-working", "codex-active", "codex-idle", "archived"})
            window.render.reset_mock()
            window.select_states.reset_mock()
            window.working_only.set_active(False)
            window.select_states.assert_called_once_with(set(SCOPE["STATES"]))
            selection(set(SCOPE["STATES"]))
            self.assertEqual({row["id"] for row in window.visible_rows()}, {"codex-working", "codex-idle", "archived"})
            for states in ({"working"}, {"working", "idle"}, set(), set(SCOPE["STATES"])):
                window.select_states.reset_mock()
                window.select_states(states)
                window.select_states.assert_called_once_with(states)
                selection(states)
            window.select_states.reset_mock()
            window.state_checks["waiting"].set_active(False)
            selection({"working", "idle", "unknown"})
            window.select_states.assert_not_called()

    def test_working_pending_union_keeps_unread_and_other_filters(self):
        filtered = SCOPE["filtered_rows"]
        board = {"threads": [dict(provider="codex", **row) for row in (
            {"id": "working-read", "state": "working", "title": "Find work"},
            {"id": "working-unread", "state": "working", "unread": True, "pending": True},
            {"id": "idle-unread", "state": "idle", "unread": True, "title": "Find idle"},
            {"id": "waiting-attention", "state": "waiting", "questionAttention": True},
            {"id": "unknown-unread", "state": "unknown", "unread": True},
            {"id": "idle-read", "state": "idle"},
            {"id": "native-only", "state": "unknown", "nativeUnread": True},
            {"id": "archived-unread", "state": "idle", "unread": True, "archived": True},
        )] + [{"id": "claude-unread", "provider": "claude-desktop-code", "state": "idle", "unread": True, "title": "Find Claude"}]}
        expected = {"working-read", "working-unread", "idle-unread", "waiting-attention", "unknown-unread", "claude-unread"}
        disjoint = {"threads": [board["threads"][0], board["threads"][2]]}
        self.assertEqual({row["id"] for row in filtered(disjoint, state={"working"}, pending_only=True)},
                         {"working-read", "idle-unread"})
        rows = filtered(board, state={"working"}, pending_only=True)
        self.assertEqual({row["id"] for row in rows}, expected)
        self.assertEqual(len(rows), len(expected))
        self.assertEqual({row["id"] for row in filtered(board, state={"working"})}, {"working-read", "working-unread"})
        self.assertEqual([row["id"] for row in filtered(board, pending_only=True)], ["working-unread"])
        self.assertEqual([row["id"] for row in filtered(board, state={"working", "idle"}, pending_only=True)], ["working-unread"])
        self.assertEqual(filtered(board, state=set(), pending_only=True), [])
        self.assertEqual({row["id"] for row in filtered(board, app="codex", state={"working"}, pending_only=True)}, expected - {"claude-unread"})
        self.assertEqual({row["id"] for row in filtered(board, "find", app="codex", state={"working"}, pending_only=True)},
                         {"working-read", "idle-unread"})
        self.assertEqual([row["id"] for row in filtered(board, "cl:find", app="codex", state={"working"}, pending_only=True)],
                         ["claude-unread"])
        self.assertEqual({row["id"] for row in filtered(board, state={"working"}, pending_only=True, archived=True)},
                         expected | {"archived-unread"})

    def test_hover_retargets_clears_and_settles_with_animations_disabled(self):
        strip = object.__new__(Strip)
        classes = set()
        strip.add_css_class, strip.remove_css_class = classes.add, classes.discard
        strip.queue_draw = Mock()
        strip.get_settings = Mock(return_value=Mock(get_property=Mock(return_value=True)))
        strip.hover_animation = Mock(reset=Mock(side_effect=lambda: strip.advance_hover(0)))
        strip.clear_hover()
        first, second, across = (0, 0, 240, 68), (0, 68, 240, 68), (252, 0, 240, 68)
        strip.show_hover(first)
        self.assertEqual(strip.hover_alpha, 0)
        self.assertEqual(classes, {"asb-hover-paint"})
        strip.hover_animation.set_duration.assert_called_with(100)
        strip.advance_hover(.5)
        self.assertEqual((strip.hover_rect, strip.hover_alpha), (first, .5))
        strip.advance_hover(1)
        strip.show_hover(second)
        strip.hover_animation.set_duration.assert_called_with(200)
        strip.advance_hover(.5)
        self.assertEqual(strip.hover_rect, (0, 34, 240, 68))
        strip.show_hover(across)
        self.assertEqual(strip.hover_from, (0, 34, 240, 68, 1))
        strip.advance_hover(.5)
        self.assertEqual(strip.hover_rect, (126, 17, 240, 68))
        strip.advance_hover(1)
        strip.show_hover(None)
        strip.hover_animation.set_duration.assert_called_with(100)
        strip.advance_hover(.5)
        self.assertEqual((strip.hover_rect, strip.hover_alpha), (across, .5))
        self.assertEqual(classes, {"asb-hover-paint"})
        strip.advance_hover(1)
        self.assertIsNone(strip.hover_rect)
        self.assertEqual(classes, set())
        strip.show_hover(first)
        strip.advance_hover(.5)
        self.assertEqual(strip.hover_rect, first)
        strip.clear_hover()
        self.assertEqual(classes, set())
        strip.queue_draw.reset_mock()
        strip.advance_hover(.5)
        strip.queue_draw.assert_not_called()
        self.assertIsNone(strip.hover_target)
        strip.get_settings.return_value.get_property.return_value = False
        strip.hover_animation.play.reset_mock()
        for rectangle in (second, across, None):
            strip.show_hover(rectangle)
            self.assertEqual(strip.hover_rect, rectangle)
            self.assertEqual(strip.hover_alpha, 1 if rectangle else 0)
            self.assertEqual(classes, {"asb-hover-paint"} if rectangle else set())
        strip.hover_animation.play.assert_not_called()

    def test_wheel_scroll_retargets_clamps_and_yields_to_native_input(self):
        window = object.__new__(Window)
        window.closed, window.scroll_target = False, None
        window.scroll_direction, window.scroll_updating = 0, False
        window.list_body, window.refresh, window.render = Mock(), Mock(), Mock()
        settings = Mock(get_property=Mock(return_value=True))
        window.get_settings = lambda: settings
        adjustment = SimpleNamespace(value=10.0, lower=10.0, upper=210.0, page=100.0, step=32.0)
        adjustment.get_value = lambda: adjustment.value
        adjustment.get_lower = lambda: adjustment.lower
        adjustment.get_upper = lambda: adjustment.upper
        adjustment.get_page_size = lambda: adjustment.page
        adjustment.get_step_increment = lambda: adjustment.step
        def set_value(value):
            previous = adjustment.value
            adjustment.value = max(adjustment.lower, min(adjustment.upper - adjustment.page, value))
            if previous != adjustment.value:
                window.scroll_position_changed(adjustment)
        adjustment.set_value = set_value
        window.scroll = SimpleNamespace(get_hadjustment=lambda: adjustment)
        animation = window.scroll_animation = Mock(reset=Mock(side_effect=lambda: window.advance_scroll(0)))
        wheel, surface = SimpleNamespace(get_unit=lambda: 0), SimpleNamespace(get_unit=lambda: 1)
        with patch.dict(SCOPE, {"Gdk": SimpleNamespace(ScrollUnit=SimpleNamespace(WHEEL=0, SURFACE=1))}):
            window.scroll_horizontal(wheel, 0, 1)
            self.assertEqual((adjustment.value, window.scroll_target), (10, 42))
            window.advance_scroll(.37)
            self.assertAlmostEqual(adjustment.value, 21.84)
            self.assertEqual(window.scroll_target, 42)
            window.scroll_horizontal(wheel, 1, -5)  # Shift/horizontal input keeps its X mapping.
            self.assertEqual(window.scroll_target, 74)
            self.assertAlmostEqual(window.scroll_from, 21.84)
            window.advance_scroll(.5)
            current = adjustment.value
            window.scroll_horizontal(wheel, 0, -.5)
            self.assertEqual(window.scroll_from, current)
            self.assertEqual(window.scroll_target, current - 16)
            window.advance_scroll(.5)
            self.assertLess(adjustment.value, current)
            window.scroll_horizontal(wheel, 100, 0)
            self.assertEqual(window.scroll_target, 110)
            window.advance_scroll(1)
            self.assertEqual(adjustment.value, 110)
            self.assertIsNone(window.scroll_target)
            animation.play.reset_mock()
            window.scroll_horizontal(wheel, 1, 0)
            window.scroll_horizontal(wheel, 0, 0)
            animation.play.assert_not_called()
            window.scroll_horizontal(wheel, -100, 0)
            self.assertEqual(window.scroll_target, 10)
            window.advance_scroll(1)
            self.assertEqual(adjustment.value, 10)

            window.scroll_horizontal(wheel, 0, 1)
            window.advance_scroll(.5)
            current = adjustment.value
            animation.play.reset_mock()
            window.scroll_horizontal(surface, .75, 8)
            self.assertEqual(adjustment.value, current + .75)
            self.assertIsNone(window.scroll_target)
            window.advance_scroll(1)
            self.assertEqual(adjustment.value, current + .75)
            animation.play.assert_not_called()
            window.scroll_horizontal(surface, 0, 1.25)
            self.assertEqual(adjustment.value, current + 2)

            window.scroll_horizontal(wheel, 0, 1)
            window.advance_scroll(.5)
            current = adjustment.value
            settings.get_property.return_value = False
            animation.play.reset_mock()
            window.scroll_horizontal(wheel, 0, -1)
            self.assertEqual(adjustment.value, max(10, current - 32))
            self.assertIsNone(window.scroll_target)
            animation.play.assert_not_called()
            settings.get_property.return_value = True
            adjustment.step = 48
            window.scroll_horizontal(None, 0, 1)
            self.assertEqual(window.scroll_target, min(110, adjustment.value + 48))
            set_value(25.5)  # Scrollbar/keyboard changes win over an active wheel target.
            self.assertIsNone(window.scroll_target)
            window.advance_scroll(1)
            self.assertEqual(adjustment.value, 25.5)

            window.scroll_horizontal(wheel, 0, 1)
            window.cancel_scroll(adjustment)  # GtkAdjustment bounds changes and unmap.
            window.advance_scroll(1)
            self.assertEqual(adjustment.value, 25.5)
            adjustment.upper, adjustment.page = 110, 100
            set_value(10)
            animation.play.reset_mock()
            window.scroll_horizontal(wheel, 0, 1)
            animation.play.assert_not_called()
            self.assertIsNone(window.scroll_target)
            adjustment.upper = 210
            window.scroll_horizontal(wheel, 0, 1)
            window.events, window.get_display, window.css = Mock(), Mock(), object()
            window.timer = window.clock_timer = window.geometry_idle = window.notice_timer = None
            window.surface_signal = window.context_menu = None
            window.focus_widgets, window.row_cache = {}, {}
            with patch.dict(SCOPE, {"Gtk": SimpleNamespace(StyleContext=Mock())}):
                self.assertFalse(window.on_close())
            window.advance_scroll(1)
            window.scroll_horizontal(wheel, 0, 1)
            self.assertEqual(adjustment.value, 10)
            self.assertIsNone(window.scroll_target)
        window.refresh.assert_not_called()
        window.render.assert_not_called()
        window.list_body.clear_hover.assert_called()

    def test_row_actions_keep_the_target_and_post_to_the_session_route(self):
        window = object.__new__(Window)
        window.base = "http://127.0.0.1:1"
        window.closed, window.session_actions, window.focus_widgets = False, set(), {}
        window.get_focus = window.focus_key = lambda: None
        window.visible_rows = lambda: [{"id": "first", "pinned": True}, {"id": "known/session", "pinned": True},
                                       {"id": "last", "pinned": True}, {"id": "plain"}]
        target = SimpleNamespace(get_string=lambda: "known/session")
        request, dispatch = Mock(), Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=dispatch)}):
            for name, action, body in (("mark-read", "mark-read", None),
                                      ("mark-unread", "mark-unread", None),
                                      ("pin", "pin", None), ("unpin", "unpin", None),
                                      ("pin-up", "move-pin", {"targetId": "first", "placement": "before"}),
                                      ("pin-down", "move-pin", {"targetId": "last", "placement": "after"})):
                with self.subTest(action=name):
                    request.reset_mock()
                    window.session_actions.clear()
                    window.row_action(None, target, name)
                    request.assert_called_once()
                    base, route, callback, actual_dispatch, method, actual_body = request.call_args.args
                    self.assertEqual((base, route, actual_dispatch, method, actual_body),
                                     (window.base, "/api/threads/known%2Fsession/" + action,
                                      dispatch, "POST", body))
                    self.assertTrue(callable(callback))
            request.reset_mock()
            window.visible_rows = lambda: [{"id": "known/session", "pinned": True}, {"id": "plain"}]
            window.row_action(None, target, "pin-up")
            window.row_action(None, target, "pin-down")
            request.assert_not_called()

    def test_pin_move_targets_the_visible_pinned_neighbor(self):
        move = SCOPE["pin_move_body"]
        # The stored pin order is a, hidden, b: "hidden" is not in the visible rows.
        rows = [{"id": "a", "pinned": True}, {"id": "b", "pinned": True}, {"id": "c"}]
        self.assertIsNone(move(rows, "a", "up"))
        self.assertIsNone(move(rows, "b", "down"))
        self.assertEqual(move(rows, "b", "up"), {"targetId": "a", "placement": "before"})
        self.assertEqual(move(rows, "a", "down"), {"targetId": "b", "placement": "after"})
        self.assertIsNone(move(rows, "c", "up"))
        self.assertIsNone(move(rows, "missing", "down"))

    def test_source_token_header_only_on_source_posts_with_a_token(self):
        token = "ab" * 32
        for value, route, method, expected in ((token, "/api/sources", "POST", token),
                                               (token, "/api/sources/one/remove", "POST", token),
                                               (token, "/api/sources", "GET", None),
                                               (token, "/api/sourcesx", "POST", None),
                                               (token, "/api/threads/a/pin", "POST", None),
                                               ("", "/api/sources", "POST", None)):
            with self.subTest(route=route, method=method, token=bool(value)):
                transport = Mock(open=Mock(side_effect=OSError("closed")))
                with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": value}):
                    with self.assertRaises(RuntimeError) as caught:
                        SCOPE["request_json"]("http://127.0.0.1:1", route, method, {})
                self.assertEqual(transport.open.call_args.args[0].get_header("X-asb-source-token"), expected)
                self.assertNotIn(token, str(caught.exception))
        source = SOURCE.read_text()
        self.assertEqual(source.count("ASB_SOURCE_TOKEN"), 1)
        self.assertEqual(source.count("SOURCE_TOKEN"), 4)

    def test_row_error_clears_when_the_row_state_changes(self):
        window = object.__new__(Window)
        window.view, window.open_errors = "compact", {"a": "Cannot change this session.", "other": "kept"}
        window.clear_read_feedback = window.update_card_actions = window.update_row_text = window.update_open_state = Mock()
        widget = Mock(asb_view="compact", asb_thread={"id": "a", "provider": "codex", "state": "working", "updatedAtMs": 1})
        window.update_session_row(widget, {"id": "a", "provider": "codex", "state": "working", "updatedAtMs": 2})
        self.assertIn("a", window.open_errors)
        window.update_session_row(widget, {"id": "a", "provider": "codex", "state": "idle", "updatedAtMs": 2})
        self.assertEqual(window.open_errors, {"other": "kept"})

    def test_focus_moved_by_a_repack_keeps_the_queued_restore(self):
        window = object.__new__(Window)
        window.focus_generation = 0
        column = type("ListBox", (), {})()
        for focus, expected in ((None, 0), (column, 0), (object(), 1)):
            window.get_focus = lambda focus=focus: focus
            window.focus_changed()
            self.assertEqual(window.focus_generation, expected)

    def test_empty_list_text_follows_the_dashboard_when_no_row_is_visible(self):
        class Text(Box):
            set_wrap = set_hexpand = set_margin_top = lambda *_args: None
        class Column(Box):
            pass
        def text(value, *_args):
            widget = Text()
            widget.label = value
            return widget
        window = object.__new__(Window)
        window.dashboard, window.closed = {"threads": []}, False
        window.context_menu = window.focused_id = window.layout_signature = None
        window.focus_generation, window.cancel_scroll = 0, Mock()
        window.focus_key = window.get_focus = lambda: None
        window.focus_widgets, window.row_cache, window.open_errors = {}, {}, {}
        window.list_body, window.count = Box(), Box()
        window.geometry, window.column_width, window.row_height, window.view = (500, 100), 240, 22, "compact"
        window.scroll = SimpleNamespace(get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 0))
        window.visible_rows = lambda: SCOPE["filtered_rows"](window.dashboard)
        gtk = SimpleNamespace(ListBox=Column, SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0))
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": SimpleNamespace(idle_add=Mock()), "label": text}):
            window.render()
            self.assertEqual([child.label for child in window.list_body.children],
                             ["No desktop sessions found. Create a session, then refresh."])
            window.dashboard = {"threads": [{"id": "old", "state": "idle", "archived": True}]}
            window.render()
            self.assertEqual([child.label for child in window.list_body.children],
                             ["No matching sessions. Change the search or filters."])

    def test_timestamp_update_reuses_rows_and_columns_order_change_reuses_rows(self):
        SCOPE["Gtk"] = SimpleNamespace(ListBox=Box, SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0))
        SCOPE["GLib"] = SimpleNamespace(idle_add=Mock(), source_remove=Mock())
        board = {"threads": [{"id": "a", "title": "Unique match", "state": "working", "updatedAtMs": 20},
                             {"id": "b", "state": "idle", "updatedAtMs": 10},
                             *({"id": str(index), "state": "idle"} for index in range(111)),
                             {"id": "archived", "state": "idle", "archived": True}]}
        window = object.__new__(Window)
        window.dashboard, window.closed = board, False
        window.context_menu = window.focused_id = window.layout_signature = None
        window.focus_generation = 0
        window.focus_key = lambda: None
        window.get_focus = lambda: None
        window.focus_widgets, window.row_cache, window.list_body, window.count = {}, {}, Box(), Box()
        window.open_errors = {"b": "Cannot change this session."}
        window.geometry, window.column_width, window.row_height, window.view = (500, 100), 240, 22, "compact"
        adjustment = SimpleNamespace(get_value=lambda: 0, get_upper=lambda: 500, get_page_size=lambda: 300, set_value=Mock())
        window.scroll = SimpleNamespace(get_hadjustment=lambda: adjustment)
        window.set_focus = Mock()
        window.search = SimpleNamespace(query="", get_text=lambda: window.search.query)
        window.visible_rows = lambda: SCOPE["filtered_rows"](window.dashboard, window.search.get_text())
        window.update_row_text = window.update_card_actions = Mock()
        created, released = [], []
        def create(row):
            widget = Box()
            widget.asb_thread = dict(row)
            widget.asb_read_timer, widget.asb_handlers = None, []
            created.append(widget)
            return widget
        window.session_row = create
        window.update_session_row = lambda widget, row: setattr(widget, "asb_thread", dict(row))
        def release(widget):
            released.append(widget)
            Window.release_row(window, widget)
        window.release_row = release
        window.render()
        widgets, columns = dict(window.focus_widgets), list(window.list_body.children)
        self.assertEqual(len(created), 113)
        self.assertNotIn("archived", window.row_cache)
        window.scroll_animation, window.scroll_target = Mock(), 32
        window.scroll_direction = 1
        board["threads"][0]["updatedAtMs"] = 30
        window.render()
        self.assertEqual(window.focus_widgets, widgets)
        self.assertEqual(window.list_body.children, columns)
        self.assertEqual(len(created), 113)
        self.assertEqual(window.scroll_target, 32)
        window.scroll_animation.reset.assert_not_called()
        board["threads"][1].update(pinned=True, pinIndex=0)
        window.render()
        self.assertEqual(window.scroll_target, 32)
        window.scroll_animation.reset.assert_not_called()
        self.assertEqual(window.list_body.children, columns)
        self.assertEqual(window.row_order[:2], ["b", "a"])
        self.assertEqual(window.focus_widgets, widgets)
        widgets["b"].asb_read_timer = 7
        window.get_focus = lambda: widgets["a"]
        window.focus_key = lambda: "a"
        window.search.query = "Unique match"
        window.render()
        callback, *args = SCOPE["GLib"].idle_add.call_args.args
        window.get_focus = lambda: window.search
        window.focus_changed()
        callback(*args)
        window.set_focus.assert_not_called()
        adjustment.set_value.assert_not_called()
        window.focus_key = lambda: None
        self.assertEqual(list(window.focus_widgets), ["a"])
        self.assertEqual(window.row_cache, widgets)
        self.assertEqual((len(created), len(released)), (113, 0))
        self.assertIsNone(widgets["b"].asb_read_timer)
        SCOPE["GLib"].source_remove.assert_called_once_with(7)
        window.update_row_text.reset_mock()
        window.update_clock()
        self.assertEqual(window.update_row_text.call_args.args[0], widgets["a"])
        self.assertEqual(window.update_row_text.call_count, 1)
        window.search.query = ""
        window.render()
        self.assertEqual(window.focus_widgets, widgets)
        self.assertEqual((len(created), len(released)), (113, 0))
        window.search.query = "Unique match"
        window.render()
        board["threads"] = [row for row in board["threads"] if row["id"] != "b"]
        window.render()
        window.render()
        self.assertEqual(released, [widgets["b"]])
        self.assertNotIn("b", window.row_cache)
        self.assertFalse(window.open_errors)
        window.events, window.get_display, window.css = Mock(), Mock(), object()
        window.timer = window.clock_timer = window.geometry_idle = window.notice_timer = None
        window.surface_signal = None
        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(StyleContext=Mock())}):
            window.on_close()
        self.assertEqual(len(released), 113)
        self.assertEqual(len({id(widget) for widget in released}), 113)
        self.assertFalse(window.row_cache)
        self.assertFalse(window.focus_widgets)

    def test_hidden_rows_restore_finished_open_errors_theme_and_view(self):
        row = {"id": "a", "title": "Retained attention", "provider": "codex", "state": "idle",
               "canOpen": True, "unread": True, "pending": True, "retainedUnread": True,
               "sourceCount": 2, "sourceColor": "#404040"}
        window = object.__new__(Window)
        window.dashboard, window.closed, window.base = {"threads": [row], "persistentUnread": True}, False, "http://127.0.0.1:1"
        window.context_menu = window.focused_id = window.layout_signature = None
        window.focus_generation = 0
        window.focus_key = window.get_focus = lambda: None
        window.geometry, window.column_width, window.row_height, window.view = (500, 100), 240, 22, "compact"
        window.opening, window.open_errors, window.session_actions = set(), {}, set()
        window.refresh = Mock()
        window.list_body, window.count = Box(), Box()
        window.scroll = SimpleNamespace(get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 0))
        widget = Box()
        widget.asb_thread, widget.asb_view, widget.asb_time_signature = dict(row), "compact", None
        widget.asb_read_timer, widget.asb_handlers = None, []
        for name in ("asb_title_label", "asb_state_label", "asb_mark", "asb_dot", "set_activatable", "set_child", "remove_css_class",
                     "set_sensitive", "set_tooltip_text", "update_property", "update_state"):
            setattr(widget, name, Mock())
        marker = object.__new__(Marker)
        marker.owner, marker.style_provider, marker.set_visible = window, Mock(), Mock()
        widget.asb_source_badge = marker
        window.row_cache, window.focus_widgets = {"a": widget}, {}
        window.css, window.add_css_class, window.remove_css_class = Mock(), Mock(), Mock()
        palette = {"background": "#0f0f0f", "text": "#f6f5f4", "muted": "#aaaaaa", "accent": "#cccccc", "divider": "#444444"}
        window.native_colors = lambda: palette
        window.set_palette(None)
        window.set_palette({**palette, "background": "#202020"})
        self.assertIn("border-color: #202020", marker.rendered_css)
        self.assertFalse(window.focus_widgets)
        gtk = SimpleNamespace(ListBox=Box, Box=lambda **_kwargs: Mock(), Image=lambda **_kwargs: Mock(),
                              Overlay=lambda **_kwargs: Mock(), Button=lambda **_kwargs: Mock(),
                              SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0, CENTER=1, END=2),
                              Orientation=SimpleNamespace(VERTICAL=0), AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        request = Mock()
        glib = SimpleNamespace(idle_add=Mock(), source_remove=Mock(), Variant=lambda _kind, value: value)
        window.visible_rows = lambda: window.dashboard["threads"]
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": glib, "request_async": request,
                               "Pango": SimpleNamespace(EllipsizeMode=SimpleNamespace(END=0), WrapMode=SimpleNamespace(WORD_CHAR=0)),
                               "SourceMarker": lambda _owner: marker, "label": lambda *_args: Mock()}):
            window.update_row_text(widget)
            window.open_row(None, widget)
            widget.asb_title_label.set_label.assert_called_with("Opening…")
            widget.set_sensitive.assert_called_with(False)
            request.call_args.args[2]({"opened": True}, None)
            self.assertFalse(window.opening)
            window.refresh.assert_called_once_with(queue=True)
            self.assertEqual(widget.asb_thread, row)
            window.render()
            self.assertIs(window.focus_widgets["a"], widget)
            widget.asb_title_label.set_label.assert_called_with(row["title"])
            widget.set_sensitive.assert_called_with(True)
            self.assertTrue(widget.asb_thread["unread"])

            window.open_row(None, widget)
            window.focus_widgets.clear()
            widget.parent.remove(widget)
            request.call_args.args[2](None, "Cannot open this session.")
            window.refresh.assert_called_once_with(queue=True)
            window.view, window.row_height = "comfortable", SCOPE["COMFORTABLE_ROW_HEIGHT"]
            window.render()
            self.assertEqual(widget.asb_view, "comfortable")
            widget.set_child.assert_called_once()
            widget.asb_title_label.set_label.assert_called_with(row["title"])
            widget.set_sensitive.assert_called_with(True)
            self.assertIn("Cannot open this session.", widget.update_property.call_args.args[1][1])
            widget.set_tooltip_text.assert_not_called()
            self.assertTrue(widget.asb_thread["unread"])
            widget.asb_read_button.set_action_name.assert_called_with("win.mark-read")

    def test_clear_search_uses_one_native_change_signal(self):
        window = object.__new__(Window)
        window.cancel_scroll, window.render = Mock(), Mock()
        window.list_body = Box()
        text = "query"
        def set_text(value):
            nonlocal text
            if value != text:
                text = value
                window.filter_changed()
        window.search = SimpleNamespace(set_text=set_text)
        window.clear_search()
        window.render.assert_called_once_with()
        window.clear_search()
        window.render.assert_called_once_with()

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
        widget = SimpleNamespace(asb_thread={"id": "a", "canOpen": True, "unread": True})
        window.focus_widgets, window.opening, window.open_errors = {"a": widget}, set(), {}
        window.update_open_state = Mock()
        for _ in range(2):
            window.open_row(None, widget)
            requests[-1][2]({"opened": True}, None)
        self.assertTrue(window.refresh_queued)
        self.assertFalse(window.refresh_force_queued)
        window.apply_dashboard(None, "Cannot load sessions")
        self.assertEqual(len(pending), 1)
        callback, args = pending.pop()
        callback(*args)
        self.assertEqual(requests[-1][1], "/api/dashboard")
        window.open_row(None, widget)
        requests[-1][2](None, "Cannot open this session.")
        self.assertFalse(window.refresh_queued)
        self.assertTrue(widget.asb_thread["unread"])

    def test_order_only_swap_moves_two_rows_without_column_or_action_teardown(self):
        operations = {"remove": 0, "insert": 0, "append": 0}
        focus = [None]
        class Listing(Box):
            def append(self, child):
                operations["append"] += 1
                super().append(child)
            def remove(self, child):
                operations["remove"] += 1
                super().remove(child)
            def insert(self, child, position):
                operations["insert"] += 1
                super().insert(child, position)
        window = object.__new__(Window)
        window.dashboard = {"threads": [{"id": "a", "state": "working", "updatedAtMs": 20},
                                        {"id": "b", "state": "working", "updatedAtMs": 10}]}
        window.closed, window.layout_signature, window.focused_id = False, None, None
        window.context_menu, window.cancel_scroll = Mock(), Mock()
        window.focus_generation = 0
        window.get_focus = lambda: focus[0]
        window.focus_key = lambda: "a" if focus[0] else None
        window.set_focus = Mock(side_effect=lambda widget: focus.__setitem__(0, widget))
        window.focus_widgets, window.row_cache = {}, {}
        window.list_body, window.count = Box(), Box()
        window.list_body.clear_hover = Mock()
        window.list_body.remove = Mock(wraps=window.list_body.remove)
        window.list_body.append = Mock(wraps=window.list_body.append)
        window.geometry, window.column_width, window.row_height, window.view = (500, 100), 240, 22, "compact"
        window.scroll = SimpleNamespace(get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 32))
        window.visible_rows = lambda: SCOPE["filtered_rows"](window.dashboard)
        def create(row):
            widget = Box()
            widget.asb_thread = dict(row)
            widget.get_visible = widget.get_sensitive = lambda: True
            return widget
        window.session_row = create
        window.update_session_row = lambda widget, row: setattr(widget, "asb_thread", dict(row))
        glib = SimpleNamespace(idle_add=Mock())
        gtk = SimpleNamespace(ListBox=Listing, SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0))
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": glib}):
            window.render()
            columns, widgets = list(window.list_body.children), dict(window.focus_widgets)
            focus[0] = widgets["a"]
            for key in operations:
                operations[key] = 0
            window.cancel_scroll.reset_mock()
            window.list_body.clear_hover.reset_mock()
            window.list_body.remove.reset_mock()
            window.list_body.append.reset_mock()
            window.context_menu.popdown.reset_mock()
            queued = glib.idle_add.call_count
            window.dashboard["threads"][1]["updatedAtMs"] = 30
            window.render()
            self.assertEqual(window.row_order, ["b", "a"])
            self.assertEqual(columns[0].children, [widgets["b"], widgets["a"]])
            self.assertEqual(operations, {"remove": 2, "insert": 2, "append": 0})
            self.assertEqual(window.list_body.children, columns)
            window.list_body.remove.assert_not_called()
            window.list_body.append.assert_not_called()
            window.context_menu.popdown.assert_not_called()
            window.cancel_scroll.assert_not_called()
            window.list_body.clear_hover.assert_not_called()
            self.assertEqual(glib.idle_add.call_count, queued)
            window.set_focus.assert_called_once_with(widgets["a"])
            window.set_focus.reset_mock()
            focus[0] = search = Box()
            window.focus_key = lambda: None
            window.dashboard["threads"][0]["updatedAtMs"] = 40
            window.render()
            self.assertEqual(window.row_order, ["a", "b"])
            window.set_focus.assert_not_called()
            self.assertIs(focus[0], search)

    def test_order_only_path_places_every_permutation_in_its_column(self):
        window = object.__new__(Window)
        window.closed, window.layout_signature, window.focused_id = False, None, None
        window.context_menu, window.cancel_scroll = None, Mock()
        window.focus_generation = 0
        window.get_focus = window.focus_key = lambda: None
        window.set_focus = Mock()
        window.focus_widgets, window.row_cache, window.open_errors = {}, {}, {}
        window.list_body, window.count = Box(), Box()
        window.list_body.remove = Mock(wraps=window.list_body.remove)
        window.geometry, window.column_width, window.row_height, window.view = (800, 60), 240, 22, "compact"
        window.scroll = SimpleNamespace(get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 0))
        window.visible_rows = lambda: list(window.dashboard["threads"])
        def create(row):
            widget = Box()
            widget.asb_thread = dict(row)
            return widget
        window.session_row = create
        window.update_session_row = lambda widget, row: setattr(widget, "asb_thread", dict(row))
        gtk = SimpleNamespace(ListBox=Box, SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0))
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": SimpleNamespace(idle_add=Mock())}):
            window.dashboard = {"threads": [{"id": name, "state": "idle"} for name in "abcde"]}
            window.render()
            self.assertEqual((window.capacity, len(window.list_body.children)), (2, 3))
            columns, widgets = list(window.list_body.children), dict(window.focus_widgets)
            for order in itertools.permutations("abcde"):
                window.dashboard = {"threads": [{"id": name, "state": "idle"} for name in order]}
                window.render()
                self.assertEqual([[child.asb_thread["id"] for child in column.children] for column in columns],
                                 [list(order[0:2]), list(order[2:4]), list(order[4:5])])
                self.assertEqual(window.focus_widgets, widgets)
            window.list_body.remove.assert_not_called()

    def test_completed_read_guard_ignores_discard_only_inside_half_second(self):
        ignore = SCOPE["ignore_discard_after_read"]
        for action in ("discard-result", "keep-result"):
            self.assertFalse(ignore(action, None, 10))
            self.assertTrue(ignore(action, 10, 10.499))
            self.assertFalse(ignore(action, 10, 10.5))
        self.assertFalse(ignore("mark-read", 10, 10.1))
        window = object.__new__(Window)
        widget = SimpleNamespace(asb_thread={"id": "a", "state": "working", "questionAttention": True},
                                 asb_read_generation=1, asb_view="comfortable", asb_last_read_at=None)
        window.base, window.closed = "http://127.0.0.1:1", False
        window.session_actions, window.open_errors = set(), {}
        window.focus_widgets = window.row_cache = {"a": widget}
        window.dashboard = {"threads": [dict(widget.asb_thread)]}
        window.get_focus = window.focus_key = lambda: None
        window.update_card_actions = window.update_open_state = Mock()
        window.refresh = Mock()
        window.render = Mock(side_effect=lambda **_kwargs: setattr(widget, "asb_thread", window.dashboard["threads"][0]))
        request, clock = Mock(), Mock(return_value=10)
        with patch.dict(SCOPE, {"request_async": request, "time": SimpleNamespace(monotonic=clock),
                               "GLib": SimpleNamespace(idle_add=Mock())}):
            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": dict(widget.asb_thread, questionAttention=False)}, None)
            self.assertEqual(widget.asb_last_read_at, 10)
            request.reset_mock()
            window.update_card_actions.reset_mock()
            clock.return_value = 10.1
            window.session_action("a", "discard-result")
            window.session_action("a", "keep-result")
            request.assert_not_called()
            window.update_card_actions.assert_not_called()
            self.assertFalse(window.session_actions)
            clock.return_value = 10.5
            window.session_action("a", "discard-result")
            self.assertEqual(request.call_args.args[1], "/api/threads/a/discard-result")
            self.assertEqual(window.session_actions, {"a"})

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
            window.list_body = Mock()
            window.clock_timer = window.geometry_idle = window.surface_signal = window.context_menu = None
            window.focus_widgets, window.row_cache = {}, {}
            with patch.dict(SCOPE, {"Gtk": SimpleNamespace(StyleContext=Mock())}):
                self.assertFalse(window.on_close())
            glib.source_remove.assert_any_call(closing)
            self.assertIsNone(window.notice_timer)
            window.notice.set_visible.reset_mock()
            self.assertFalse(timers[closing][1]())
            window.notice.set_visible.assert_not_called()

    def test_changed_row_fields_keep_content_and_copy_mutable_source(self):
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        row = {"id": "a", "provider": "codex", "state": "working", "updatedAtMs": 10, "unread": False}
        widget = SimpleNamespace(asb_view="compact", asb_thread=dict(row), set_activatable=Mock(),
                                 set_child=Mock(), asb_mark=Mock(), asb_source_badge=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
                                 add_css_class=Mock(), remove_css_class=Mock())
        row.update(updatedAtMs=20, unread=True, state="waiting", pinned=True)
        window.update_session_row(widget, row)
        widget.set_child.assert_not_called()
        widget.asb_dot.set_visible.assert_called_once_with(True)
        widget.asb_state_label.add_css_class.assert_any_call("asb-waiting")
        window.update_row_text.assert_called_once_with(widget)
        row["pinned"] = False
        self.assertTrue(widget.asb_thread["pinned"])

    @staticmethod
    def theme_window(path):
        window = object.__new__(Window)
        colors = {"background": "#0f0f0f", "text": "#f6f5f4", "accent": "#cccccc", "muted": "#aaaaaa", "divider": "#444444"}
        window.theme_path, window.syncing_theme = path, False
        mode = window.theme_mode = SimpleNamespace(selected=0)
        mode.get_selected = lambda: mode.selected
        mode.set_selected = lambda value: setattr(mode, "selected", value)
        window.rgba = window.hex_color = lambda value: value
        window.native_colors = lambda: dict(colors)
        window.theme_error, window.set_palette = Mock(), Mock()
        window.color_buttons = {}
        for key, color in colors.items():
            picker = SimpleNamespace(color=color)
            picker.get_rgba = lambda picker=picker: picker.color
            def set_rgba(value, picker=picker):
                picker.color = value
                window.theme_color_changed(picker, None)
            picker.set_rgba = set_rgba
            window.color_buttons[key] = picker
        return window, colors

    def test_theme_picker_edits_select_custom_and_apply_saves_each_color(self):
        with TemporaryDirectory(prefix="asb-theme-test-") as temporary:
            window, colors = self.theme_window(Path(temporary) / "theme.json")
            window.set_theme_pickers(colors)
            self.assertEqual(window.theme_mode.selected, 0)
            window.theme_error.set_label.assert_not_called()
            self.assertFalse(window.syncing_theme)
            edits = {"background": "#121212", "text": "#eeeeee", "accent": "#dddddd", "muted": "#cccccc", "divider": "#666666"}
            for key, value in edits.items():
                window.theme_mode.set_selected(0)
                window.set_palette.reset_mock()
                window.color_buttons[key].set_rgba(value)
                self.assertEqual(window.theme_mode.selected, 1, key)
                window.set_palette.assert_not_called()
                colors[key] = value
                window.apply_theme()
                window.set_palette.assert_called_once_with(colors)
                self.assertEqual(SCOPE["read_theme"](window.theme_path), colors)
                window.theme_error.set_label.assert_called_with("Custom theme saved.")
            for value in (colors["background"], "#121213"):
                window.set_palette.reset_mock()
                window.color_buttons["divider"].set_rgba(value)
                colors["divider"] = value
                self.assertLess(SCOPE["contrast"](value, colors["background"]), 1.5)
                window.apply_theme()
                window.set_palette.assert_called_once_with(colors)
                self.assertEqual(SCOPE["read_theme"](window.theme_path), colors)
            restored, _colors = self.theme_window(window.theme_path)
            restored.theme_mode.set_selected(1)
            restored.set_theme_pickers(SCOPE["read_theme"](restored.theme_path))
            self.assertEqual(restored.theme_mode.selected, 1)
            self.assertEqual({key: picker.color for key, picker in restored.color_buttons.items()}, colors)
            restored.theme_error.set_label.assert_not_called()
            restored.reset_theme()
            self.assertEqual(restored.theme_mode.selected, 0)
            self.assertFalse(restored.theme_path.exists())
            self.assertFalse(restored.syncing_theme)
            self.assertEqual({key: picker.color for key, picker in restored.color_buttons.items()}, restored.native_colors())
            restored.set_palette.assert_called_once_with(None)
            restored.theme_error.set_label.assert_called_with("Reset to GNOME colors.")

    def test_invalid_theme_and_write_or_reset_failure_keep_saved_and_applied_colors(self):
        with TemporaryDirectory(prefix="asb-theme-test-") as temporary:
            window, colors = self.theme_window(Path(temporary) / "theme.json")
            window.theme_mode.set_selected(1)
            window.apply_theme()
            saved = window.theme_path.read_bytes()
            window.set_palette.reset_mock()
            for key, value in (("background", "#ffffff"), ("text", "#333333"), ("muted", "#333333"),
                               ("accent", "#333333"), ("divider", "#12345")):
                window.set_theme_pickers({**colors, key: value})
                window.apply_theme()
                window.set_palette.assert_not_called()
                self.assertEqual(window.theme_path.read_bytes(), saved)
                window.theme_error.add_css_class.assert_called_with("warning")
                self.assertTrue(window.theme_error.set_label.call_args.args[0])
            window.set_theme_pickers({**colors, "background": "#121212"})
            with patch.object(Path, "replace", side_effect=OSError("synthetic write failure")):
                window.apply_theme()
            window.set_palette.assert_not_called()
            self.assertEqual(window.theme_path.read_bytes(), saved)
            self.assertEqual(list(window.theme_path.parent.glob(".asb-*")), [])
            window.theme_error.set_label.assert_called_with("synthetic write failure")
            with patch.object(Path, "unlink", side_effect=OSError("synthetic reset failure")):
                window.reset_theme()
            window.set_palette.assert_not_called()
            self.assertEqual(window.theme_mode.selected, 1)
            self.assertEqual(window.theme_path.read_bytes(), saved)
            window.theme_error.set_label.assert_called_with("Cannot reset the ASB theme. Check its config folder.")

    def test_idle_read_quiet_class_and_color_contrast(self):
        window = object.__new__(Window)
        window.view = "comfortable"
        window.clear_read_feedback = window.update_card_actions = window.update_row_text = Mock()
        window.open_errors = {}
        classes = set()
        widget = SimpleNamespace(asb_view="comfortable", asb_thread={}, set_activatable=Mock(), asb_mark=Mock(), asb_source_badge=Mock(),
                                 asb_dot=Mock(), asb_state_label=Mock(), asb_folder=Mock(),
                                 add_css_class=classes.add, remove_css_class=classes.discard)
        row = {"id": "a", "provider": "codex", "state": "idle", "unread": False, "pending": False}
        for extra, quiet in (({}, True), ({"pinned": True}, True), ({"readStatus": "unknown"}, True),
                             ({"readStatus": "unread", "nativeUnread": True, "nativeAttention": False}, True),
                             ({"state": "working"}, False), ({"state": "waiting"}, False), ({"state": "unknown"}, False),
                             ({}, True), ({"unread": True}, False), ({"questionAttention": True}, False), ({"pending": True}, False)):
            window.update_session_row(widget, {**row, **extra})
            self.assertEqual("asb-idle-read" in classes, quiet)
        window.view, widget.asb_view, widget.asb_thread = "compact", "compact", {}
        window.update_session_row(widget, row)
        self.assertNotIn("asb-idle-read", classes)
        colors = {"background": "#0f0f0f", "text": "#f6f5f4", "muted": "#aaaaaa", "accent": "#cccccc", "divider": "#444444"}
        for foreground in ("#f6f5f4", "#aaaaaa", "#929292"):
            palette = SCOPE["validate_theme"]({**colors, "text": foreground, "muted": foreground})
            for key, fraction in (("text", .67), ("muted", .85)):
                quiet, _fraction = SCOPE["quiet_color"](palette, key, fraction, SCOPE["highlight_color"](palette))
                for surface in (palette["background"], SCOPE["highlight_color"](palette)):
                    self.assertGreaterEqual(SCOPE["contrast"](quiet, surface), 4.5)
                if foreground == "#929292":
                    self.assertEqual(quiet, foreground)

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

    def test_card_actions_keep_attention_on_failure_and_reject_stale_read_feedback(self):
        row = {"id": "a", "provider": "codex", "state": "idle", "workingSinceMs": 0,
               "updatedAtMs": 100, "unread": True, "nativeUnread": True, "nativeAttention": True,
               "canOpen": False, "pinned": False}
        read_row = dict(row, unread=False, nativeAttention=False)
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=dict(row), asb_focus_key="a",
                                 asb_read_timer=None, asb_read_generation=1, asb_read_button=Mock(),
                                 asb_pin_button=Mock(), asb_mark=Mock(), asb_source_badge=Mock(), asb_dot=Mock(), asb_folder=Mock(),
                                 asb_state_label=Mock(), set_activatable=Mock(), add_css_class=Mock(), remove_css_class=Mock())
        window = object.__new__(Window)
        window.closed, window.view, window.base = False, "comfortable", "http://127.0.0.1:1"
        window.session_actions, window.open_errors, window.focus_widgets = set(), {}, {"a": widget}
        window.dashboard = {"threads": [dict(row)]}
        window.get_focus = window.focus_key = lambda: None
        window.update_open_state = window.update_row_text = Mock()
        window.refresh = Mock()
        window.render = Mock(side_effect=lambda **_kwargs: window.update_session_row(
            window.focus_widgets["a"], window.dashboard["threads"][0]))
        timers = []
        def timeout(interval, callback):
            timers.append((interval, callback))
            return len(timers)
        glib = SimpleNamespace(idle_add=Mock(), timeout_add=timeout, source_remove=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        request = Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": glib, "Gtk": gtk}):
            window.session_action("a", "mark-read")
            window.session_action("a", "mark-read")
            request.assert_called_once()
            widget.asb_read_button.set_sensitive.assert_called_with(True)
            widget.asb_read_button.set_action_name.assert_called_with(None)
            widget.asb_read_button.set_focusable.assert_called_with(True)
            request.call_args.args[2](None, "Cannot change this session.")
            self.assertTrue(widget.asb_thread["unread"])
            self.assertIsNone(widget.asb_read_timer)
            self.assertEqual(timers, [])
            self.assertFalse(window.session_actions)

            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": read_row}, None)
            self.assertEqual((widget.asb_thread["state"], widget.asb_thread["workingSinceMs"]), ("idle", 0))
            self.assertTrue(widget.asb_thread["nativeUnread"])
            self.assertFalse(widget.asb_thread["unread"])
            self.assertEqual(timers[0][0], 1600)
            widget.asb_read_button.set_focusable.assert_called_with(True)
            widget.asb_read_button.add_css_class.assert_called_with("asb-read-confirmed")
            self.assertNotIn("a", window.open_errors)
            window.dashboard["threads"][0]["pinned"] = True
            window.render()
            self.assertEqual(widget.asb_read_timer, 1)
            widget.asb_pin_button.set_action_name.assert_called_with("win.unpin")
            window.dashboard["threads"][0]["updatedAtMs"] = 150
            window.render()
            self.assertEqual(widget.asb_read_timer, 1)
            self.assertEqual(widget.asb_thread["state"], "idle")
            window.confirm_read(widget)
            glib.source_remove.assert_called_with(1)
            widget.asb_read_button.set_visible.reset_mock()
            self.assertFalse(timers[0][1]())
            self.assertEqual(widget.asb_read_timer, 2)
            widget.asb_read_button.set_visible.assert_not_called()
            self.assertFalse(timers[1][1]())
            self.assertIsNone(widget.asb_read_timer)
            widget.asb_read_button.set_visible.assert_called_with(False)

            window.dashboard["threads"] = [dict(row, updatedAtMs=200)]
            window.render()
            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": dict(read_row, updatedAtMs=200)}, None)
            feedback = timers[-1][1]
            window.dashboard["threads"] = [dict(row, updatedAtMs=300)]
            window.render()
            self.assertIsNone(widget.asb_read_timer)
            glib.source_remove.assert_called_with(3)
            widget.asb_read_button.set_visible.reset_mock()
            self.assertFalse(feedback())
            widget.asb_read_button.set_visible.assert_not_called()

            window.session_action("a", "mark-read")
            stale_result = request.call_args.args[2]
            window.dashboard["threads"] = [dict(row, updatedAtMs=400)]
            window.render()
            stale_result({"thread": dict(read_row, updatedAtMs=300)}, None)
            self.assertTrue(widget.asb_thread["unread"])
            self.assertEqual(widget.asb_thread["updatedAtMs"], 400)
            self.assertEqual(len(timers), 3)

            for passive in ({"state": "waiting", "actionRequired": True}, {"state": "idle", "lastOutcome": "stopped"}):
                window.dashboard["threads"] = [dict(row, updatedAtMs=500)]
                window.render()
                window.session_action("a", "mark-read")
                request.call_args.args[2]({"thread": {**read_row, "updatedAtMs": 500, **passive}}, None)
                self.assertIsNone(widget.asb_read_timer)
                self.assertEqual(len(timers), 3)
                widget.asb_read_button.set_action_name.assert_called_with(None)

            window.dashboard["threads"] = [dict(row, state="working", unread=False, questionAttention=True,
                                                discardResult=True, updatedAtMs=600)]
            window.render()
            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": dict(window.dashboard["threads"][0], questionAttention=False)}, None)
            self.assertIsNone(widget.asb_read_timer)
            widget.asb_read_button.set_action_name.assert_called_with("win.keep-result")
            self.assertEqual(len(timers), 3)

            window.confirm_read(widget)
            removed_feedback = timers[-1][1]
            widget.asb_handlers, widget.get_parent = [], lambda: None
            window.release_row(widget)
            window.focus_widgets["a"] = SimpleNamespace(asb_read_timer=None)
            widget.asb_read_button.set_visible.reset_mock()
            self.assertFalse(removed_feedback())
            widget.asb_read_button.set_visible.assert_not_called()

    def test_action_keys_stop_row_activation_and_pin_focus_survives_repack(self):
        window = object.__new__(Window)
        window.context_menu = None
        button = SimpleNamespace(asb_card_action="pin", get_sensitive=lambda: True, activate=Mock(),
                                 get_visible=lambda: True, get_action_name=lambda: "win.pin")
        window.get_focus = lambda: button
        gdk = SimpleNamespace(KEY_space=32, KEY_Return=13, KEY_KP_Enter=44)
        with patch.dict(SCOPE, {"Gdk": gdk, "SHORTCUT_MASK": 8}):
            for key in (32, 13, 44):
                self.assertTrue(window.row_key(None, key, 0, 0, "a"))
            self.assertEqual(button.activate.call_count, 3)
            button.get_action_name = lambda: None
            self.assertTrue(window.row_key(None, 13, 0, 0, "a"))
            self.assertEqual(button.activate.call_count, 3)
            button.get_sensitive = lambda: False
            self.assertTrue(window.row_key(None, 13, 0, 0, "a"))
            self.assertEqual(button.activate.call_count, 3)
        button.get_sensitive = lambda: True
        row = SimpleNamespace(asb_pin_button=button)
        window.closed, window.focus_widgets = False, {"a": row}
        window.focus_generation = 0
        window.menu_button = SimpleNamespace(get_active=lambda: False)
        window.set_focus = Mock()
        adjustment = SimpleNamespace(get_upper=lambda: 500, get_page_size=lambda: 300, set_value=Mock())
        window.scroll = SimpleNamespace(get_hadjustment=lambda: adjustment)
        window.restore_position("a", 12, focused_action="pin", focus_generation=0)
        window.set_focus.assert_called_with(button)
        window.set_focus.reset_mock()
        window.focus_changed()
        window.restore_position("a", 12, focused_action="pin", focus_generation=0)
        window.set_focus.assert_not_called()
        button.get_visible = lambda: False
        window.restore_position("a", 12, focused_action="pin", focus_generation=1)
        window.set_focus.assert_called_with(row)
        window.set_focus.reset_mock()
        window.menu_button.get_active = lambda: True
        window.restore_position("a", 12, focus_generation=1)
        self.assertEqual(window.deferred_row_focus, "a")
        window.set_focus.assert_not_called()
        window.menu_button.get_active = lambda: False
        window.menu_button.get_popover = lambda: SimpleNamespace(get_visible=lambda: False)
        window.reveal_row, window.list_body = Mock(), Mock()
        window.restore_settings_focus("a")
        window.set_focus.assert_called_with(row)
        window.restore_position("a", 12, reveal_focus=True, focus_generation=1)
        window.reveal_row.assert_called_with("a")
        window.list_body.add_tick_callback.assert_called_once_with(window.reveal_after_layout, "a")
        window.focus_widgets.clear()
        window.set_focus.reset_mock()
        window.restore_position("a", 12, reveal_focus=True, focus_generation=1)
        window.set_focus.assert_not_called()

    def test_pending_and_confirmed_controls_keep_native_pointer_targets_and_exclude_pin_drag(self):
        read, pin = Mock(), Mock()
        for control, name in ((read, "read"), (pin, "pin")):
            control.asb_card_action = name
            control.set_sensitive.side_effect = lambda enabled, target=control: setattr(target.get_sensitive, "return_value", enabled)
            control.set_action_name.side_effect = lambda name, target=control: setattr(target.get_action_name, "return_value", name)
        body = SimpleNamespace(get_ancestor=lambda _kind: None)
        dot = SimpleNamespace(get_ancestor=lambda _kind: read)
        widget = SimpleNamespace(asb_view="comfortable", asb_thread={"id": "a", "title": "Pointer sample", "pinned": True, "unread": True, "canOpen": True},
                                 asb_read_button=read, asb_pin_button=pin, asb_read_timer=None)
        # Model GTK's default pick contract: insensitive controls are not pointer targets.
        def pick(x, _y, flags):
            target = {10: read, 20: dot, 40: pin}.get(x, body)
            button = target if getattr(target, "asb_card_action", None) else target.get_ancestor(object)
            return body if button and not button.get_sensitive() and not flags & 1 else target
        widget.pick = Mock(side_effect=pick)
        window = object.__new__(Window)
        window.context_menu = None
        window.focus_widgets, window.opening, window.session_actions = {"a": widget}, set(), {"a"}
        window.get_focus = lambda: read
        gtk = SimpleNamespace(Button=object, PickFlags=SimpleNamespace(DEFAULT=0, INSENSITIVE=1),
                              AccessibleProperty=SimpleNamespace(LABEL=0), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        gdk = SimpleNamespace(KEY_space=32, KEY_Return=13, KEY_KP_Enter=44,
                              ContentProvider=SimpleNamespace(new_for_value=lambda value: value))
        with patch.dict(SCOPE, {"Gtk": gtk, "Gdk": gdk, "SHORTCUT_MASK": 8,
                               "GObject": SimpleNamespace(TYPE_STRING=0, Value=lambda _type, value: value)}):
            for pending, confirmed, unread in ((True, False, True), (False, True, False), (False, False, True)):
                with self.subTest(pending=pending, confirmed=confirmed):
                    window.session_actions = {"a"} if pending else set()
                    widget.asb_read_timer = 1 if confirmed else None
                    widget.asb_thread["unread"] = unread
                    window.update_card_actions(widget)
                    self.assertTrue(read.get_sensitive())
                    self.assertTrue(pin.get_sensitive())
                    self.assertEqual(read.get_action_name(), None if pending or confirmed else "win.mark-read")
                    self.assertEqual(pin.get_action_name(), None if pending else "win.unpin")
                    read.update_state.assert_called_with([0, 1], [pending, pending or confirmed])
                    read.update_property.assert_called_with([0], [("Read in ASB" if confirmed else "Mark read in ASB") + ": Pointer sample"])
                    pin.update_property.assert_called_with([0], ["Unpin in ASB: Pointer sample"])
                    for x in (10, 20, 40):
                        self.assertIsNone(window.pin_drag_prepare(None, x, 0, "a"))
                    if pending or confirmed:
                        read.activate.reset_mock()
                        self.assertTrue(window.row_key(None, 13, 0, 0, "a"))
                        read.activate.assert_not_called()
                    self.assertEqual(window.pin_drag_prepare(None, 100, 40, "a"), "asb-pin:a")
            window.base, window.closed, window.open_errors = "http://127.0.0.1:1", False, {}
            window.update_open_state = Mock()
            request = Mock()
            with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=Mock())}):
                window.open_row(None, widget)
            self.assertEqual(request.call_args.args[1], "/api/threads/a/open")

    def test_row_capture_yields_menu_keys_and_keeps_body_navigation(self):
        window = object.__new__(Window)
        menu = SimpleNamespace(get_visible=lambda: True)
        window.context_menu, window.get_focus = menu, Mock(return_value=None)
        gdk = SimpleNamespace(KEY_Up=1, KEY_Down=2, KEY_Left=3, KEY_Right=4, KEY_Home=5, KEY_End=6,
                              KEY_Menu=7, KEY_F10=8, KEY_space=9, KEY_Return=10, KEY_KP_Enter=11)
        with patch.dict(SCOPE, {"Gdk": gdk, "SHORTCUT_MASK": 16}):
            for key in range(1, 12):
                self.assertFalse(window.row_key(None, key, 0, 0, "a"))
            window.get_focus.assert_not_called()
            menu.get_visible = lambda: False
            window.row_order, window.capacity = ["a", "b"], 2
            window.focus_widgets = {"a": Mock(), "b": Mock()}
            window.reveal_row = Mock()
            self.assertTrue(window.row_key(None, 2, 0, 0, "a"))
            window.focus_widgets["b"].grab_focus.assert_called_once()
            window.reveal_row.assert_called_once_with("b")

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
                                     sock=SimpleNamespace(shutdown=lambda _how: released.set(), settimeout=Mock()), close=lambda: None)
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


class NativeIOAuditChecks(unittest.TestCase):
    def test_event_stream_survives_silence_and_closes_live_blocked_read(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import time

        headers_sent, send_event, received, release = (threading.Event() for _ in range(4))
        requests, connections = [], []
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.end_headers()
                self.wfile.flush()
                headers_sent.set()
                if send_event.wait(2):
                    try:
                        self.wfile.write(b'event: dashboard\ndata: {"reason":"source-dirty"}\n\n')
                        self.wfile.flush()
                    except OSError:
                        return
                    release.wait(2)
            def log_message(self, *_args):
                pass

        connection_class = SCOPE["HTTPConnection"]
        def short_connection(*args, **kwargs):
            kwargs["timeout"] = .05
            connection = connection_class(*args, **kwargs)
            connections.append(connection)
            return connection

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            server_thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
            server_thread.start()
            with patch.dict(SCOPE, {"HTTPConnection": short_connection}):
                stream = SCOPE["EventStream"](f"http://127.0.0.1:{server.server_port}", received.set,
                                              lambda callback: callback())
                try:
                    self.assertTrue(headers_sent.wait(1))
                    self.assertFalse(received.wait(.15))
                    self.assertIsNotNone(stream.socket)
                    self.assertIsNone(stream.socket.gettimeout())
                    send_event.set()
                    self.assertTrue(received.wait(1))
                    self.assertEqual(requests, ["/api/events"])
                    self.assertEqual(len(connections), 1)
                    started = time.monotonic()
                    stream.close()
                    stream.worker.join(.5)
                    self.assertFalse(stream.worker.is_alive())
                    self.assertLess(time.monotonic() - started, .5)
                finally:
                    stream.close()
                    send_event.set()
                    release.set()
                    stream.worker.join(1)
                    server.shutdown()
                    server_thread.join(1)

    def test_relative_day_age_updates_row_signature_and_keeps_working_duration(self):
        day, now = 86_400_000, 4 * 86_400_000
        row = {"state": "idle", "updatedAtMs": 2 * day, "pinned": True, "archived": True}
        window = object.__new__(Window)
        window.view, window.update_open_state = "comfortable", Mock()
        widget = SimpleNamespace(asb_thread=row, asb_time_signature=None,
                                 asb_state_label=Mock(), asb_age_label=Mock())
        for current, age in ((now, "2d ago"), (now + day, "3d ago")):
            window.update_row_text(widget, current)
            widget.asb_age_label.set_label.assert_called_with(age)
            self.assertEqual(widget.asb_time_signature, ("", "Idle · " + age + " · Pinned · Archived"))
            self.assertEqual(SCOPE["tooltip_model"](row, current, "/fixture/home")["state_text"], "Idle · " + age)
        self.assertEqual(window.update_open_state.call_count, 2)
        widget.asb_thread = {**row, "state": "working", "workingSinceMs": now - 61_000}
        window.update_row_text(widget, now)
        widget.asb_age_label.set_label.assert_called_with("1m1s")
        self.assertEqual(SCOPE["tooltip_model"](widget.asb_thread, now, "/fixture/home")["state_text"], "Working · 1m1s")

    def test_config_paths_use_home_when_xdg_config_home_is_empty(self):
        assignments = [node for node in TREE.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id in ("THEME_PATH", "LAYOUT_PATH")
                               for target in node.targets)]
        code = compile(ast.Module(body=assignments, type_ignores=[]), str(SOURCE), "exec")
        with TemporaryDirectory() as directory:
            home = Path(directory) / "synthetic-home"
            for config in (None, "", str(Path(directory) / "synthetic-config")):
                environment = {"HOME": str(home)}
                if config is not None:
                    environment["XDG_CONFIG_HOME"] = config
                with self.subTest(config=config), patch.dict(SCOPE["os"].environ, environment, clear=True):
                    scope = {"Path": Path, "os": SCOPE["os"]}
                    exec(code, scope)
                    base = Path(config) if config else home / ".config"
                    self.assertEqual(scope["THEME_PATH"], base / "asb" / "theme.json")
                    self.assertEqual(scope["LAYOUT_PATH"], base / "asb" / "layout.json")


if __name__ == "__main__":
    unittest.main()
