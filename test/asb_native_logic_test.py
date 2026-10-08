"""Native scheduling and row reuse checks, without GTK or a display."""
import ast
import copy
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

    def clear_hover(self):
        pass


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
            self.assertEqual(widget.update_property.call_args.args[1][1], "App source: ChatGPT Personal (codex-personal)\nOpen failed")
            row.update(sourceColor="#b28f80", sourceCount=2)
            widget.asb_time_signature = None
            window.update_row_text(widget, 100_000)
            self.assertIn("Profile color marker: #b28f80", widget.asb_tooltip)
            self.assertEqual(widget.update_property.call_args.args[1][1], "App source: ChatGPT Personal (codex-personal). Profile color marker: #b28f80\nOpen failed")
            del row["sourceLabel"], row["sourceId"], row["sourceColor"], row["sourceCount"]
            widget.asb_time_signature = None
            window.update_row_text(widget, 100_000)
            self.assertNotIn("App source:", widget.asb_tooltip)
            self.assertEqual(widget.update_property.call_args.args[1][1], "Open failed")

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
            window.focus_widgets = {}
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
                    window.session_actions.clear()
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
        window.get_focus = lambda: None
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
        window.scroll_animation, window.scroll_target = Mock(), 32
        window.scroll_direction = 1
        board["threads"][0]["updatedAtMs"] = 30
        window.render()
        self.assertEqual(window.focus_widgets, widgets)
        self.assertEqual(window.list_body.children, columns)
        self.assertEqual(len(created), 2)
        self.assertEqual(window.scroll_target, 32)
        window.scroll_animation.reset.assert_not_called()
        board["threads"][1].update(pinned=True, pinIndex=0)
        window.render()
        self.assertIsNone(window.scroll_target)
        window.scroll_animation.reset.assert_called_once()
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
            window.list_body = Mock()
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
        row = {"id": "a", "provider": "codex", "state": "working", "workingSinceMs": 50,
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
            request.call_args.args[2](None, "Cannot change this session.")
            self.assertTrue(widget.asb_thread["unread"])
            self.assertIsNone(widget.asb_read_timer)
            self.assertEqual(timers, [])
            self.assertFalse(window.session_actions)

            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": read_row}, None)
            self.assertEqual((widget.asb_thread["state"], widget.asb_thread["workingSinceMs"]), ("working", 50))
            self.assertTrue(widget.asb_thread["nativeUnread"])
            self.assertFalse(widget.asb_thread["unread"])
            self.assertEqual(timers[0][0], 1600)
            widget.asb_read_button.add_css_class.assert_called_with("asb-read-confirmed")
            self.assertNotIn("a", window.open_errors)
            window.dashboard["threads"][0]["pinned"] = True
            window.render()
            self.assertEqual(widget.asb_read_timer, 1)
            widget.asb_pin_button.set_action_name.assert_called_with("win.unpin")
            window.dashboard["threads"][0]["updatedAtMs"] = 150
            window.render()
            self.assertEqual(widget.asb_read_timer, 1)
            self.assertEqual(widget.asb_thread["state"], "working")
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
        window.menu_button = SimpleNamespace(get_active=lambda: False)
        window.set_focus = Mock()
        adjustment = SimpleNamespace(get_upper=lambda: 500, get_page_size=lambda: 300, set_value=Mock())
        window.scroll = SimpleNamespace(get_hadjustment=lambda: adjustment)
        window.restore_position("a", 12, focused_action="pin")
        window.set_focus.assert_called_with(button)
        button.get_visible = lambda: False
        window.restore_position("a", 12, focused_action="pin")
        window.set_focus.assert_called_with(row)

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
