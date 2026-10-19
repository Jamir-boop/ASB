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
SOURCES = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "AppSourcesEditor"))
SOURCES.bases = []
PREFERENCES = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "PreferencesWindow"))
PREFERENCES.bases = []
PHONE = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "PhoneEditor"))
PHONE.bases = []
MARKER = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SourceMarker"))
MARKER.bases = []
APPLICATION = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SwitchboardApplication"))
APPLICATION.bases = []
STRIP = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SessionStrip"))
STRIP.bases = []
COLUMN = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SessionColumn"))
COLUMN.bases = []
SCOPE = {"__file__": str(SOURCE)}
exec(compile(ast.Module(body=NODES + [STRIP, COLUMN, MARKER, SOURCES, PHONE, PREFERENCES, WINDOW, APPLICATION], type_ignores=[]), str(SOURCE), "exec"), SCOPE)
Column = SCOPE["SessionColumn"]
SCOPE["SessionColumn"] = lambda **kwargs: SCOPE["Gtk"].ListBox(**kwargs)
Window = SCOPE["SwitchboardWindow"]
Strip = SCOPE["SessionStrip"]
SourcesEditor = SCOPE["AppSourcesEditor"]
Preferences = SCOPE["PreferencesWindow"]
PhoneEditor = SCOPE["PhoneEditor"]
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

    def is_ancestor(self, other):
        parent = self.parent
        while parent is not None and parent is not other:
            parent = parent.parent
        return parent is not None

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

    def set_size_request(self, width, height):
        self.size_request = (width, height)

    def get_visible(self):
        return True

    def get_sensitive(self):
        return True

    def clear_hover(self):
        pass

    def clear_flights(self):
        pass


class ProfileSyncChecks(unittest.TestCase):
    REV_A, REV_B, REV_C = "a" * 64, "b" * 64, "c" * 64

    def setUp(self):
        class Row(Box):
            def set_child(self, child):
                self.child = child

            def update_property(self, *_args):
                pass

            def grab_focus(self):
                self.focused = True

        class Table(Box):
            selected = None

            def get_row_at_index(self, index):
                return self.children[index] if index < len(self.children) else None

            def get_selected_row(self):
                return self.selected

            def select_row(self, row):
                self.selected = row
                if row:
                    self.editor.selected_source(self, row)

            def unselect_all(self):
                self.selected = None

            def set_sensitive(self, value):
                self.sensitive = value

            def update_state(self, *_args):
                pass

        self.Table = Table
        self.request = Mock()
        self.gtk = SimpleNamespace(Box=Mock(), ListBoxRow=Row, Align=SimpleNamespace(CENTER=0),
                                   AccessibleState=SimpleNamespace(BUSY=0),
                                   AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1))
        self.patcher = patch.dict(SCOPE, {"Gtk": self.gtk, "Pango": SimpleNamespace(EllipsizeMode=SimpleNamespace(END=0)),
            "SourceMarker": lambda _owner, color: SimpleNamespace(configured_color=color, set_valign=Mock()),
            "label": Mock(), "request_async": self.request, "GLib": SimpleNamespace(idle_add=Mock())})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def control(self, value, getter, setter):
        control = Mock()
        control.value = value
        getattr(control, getter).side_effect = lambda: control.value
        getattr(control, setter).side_effect = lambda updated: setattr(control, "value", updated)
        return control

    def editor(self):
        editor = object.__new__(SourcesEditor)
        editor.owner = SimpleNamespace(closed=False, base="http://127.0.0.1:1", rgba=lambda color: color,
                                       hex_color=lambda color: color, refresh=Mock(), report_ui=Mock())
        editor.preferences, editor.base = Mock(), editor.owner.base
        editor.preferences.get_focus.return_value = None
        editor.closed = editor.loading = editor.saving = editor.choosing = editor.editing = False
        editor.refresh_queued = editor.rendering = editor.setting_form = editor.conflict = False
        editor.loaded = editor.active = True
        editor.editing_id, editor.max_sources = "", 8
        editor.revision = editor.observed_revision = self.REV_A
        editor.edit_revision = editor.form_baseline = editor.baseline_source = None
        editor.sources = [self.source(), self.source(id="other", label="Other", enabled=False)]
        editor.transcript_widgets, editor.preset_markers, editor.table_markers = [], [], []
        editor.table = self.Table()
        editor.table.editor = editor
        editor.table_line = Mock()
        editor.provider = self.control(0, "get_selected", "set_selected")
        for name in ("name", "data_dir", "launcher", "projects_dir"):
            setattr(editor, name, self.control("", "get_text", "set_text"))
        editor.enabled = self.control(True, "get_active", "set_active")
        editor.show_marker = self.control(True, "get_active", "set_active")
        editor.source_color = self.control("#8296b4", "get_rgba", "set_rgba")
        for name in ("message", "form", "form_title", "source_id", "source_color_hex", "source_status",
                     "add_button", "save_button", "remove_button", "cancel_button", "reload_button"):
            setattr(editor, name, Mock())
        editor.render_sources()
        return editor

    def source(self, **changes):
        return {"id": "main", "provider": "codex", "label": "Main", "dataDir": "/example/main",
                "launcher": "/example/app", "enabled": True, "color": "#8296b4", "showMarker": True,
                "status": "ok", "sessionCount": 2, **changes}

    def reply(self, sources, revision, error=None):
        callback = self.request.call_args.args[2]
        callback(None if error else {"sources": sources, "revision": revision, "maxSources": 8}, error)

    def edit_all_fields(self, editor):
        editor.provider.set_selected(1)
        editor.name.set_text("  draft \t")
        editor.data_dir.set_text("~/draft/../exact ")
        editor.launcher.set_text(" /draft/app ")
        editor.projects_dir.set_text(" ~/draft/transcripts ")
        editor.enabled.set_active(False)
        editor.show_marker.set_active(False)
        editor.source_color.set_rgba("#404040")
        return editor.form_values()

    def test_external_add_reuses_selection_and_keeps_every_raw_dirty_field(self):
        editor = self.editor()
        row = editor.table.get_selected_row()
        baseline = editor.baseline_source
        raw = self.edit_all_fields(editor)
        self.assertTrue(editor.is_dirty())
        editor.observe_revision(self.REV_B)
        self.assertTrue(editor.table.sensitive)
        editor.form.set_sensitive.assert_called_with(True)
        updated = [self.source(sessionCount=3), editor.sources[1], self.source(id="new", label="Added")]
        self.reply(updated, self.REV_B)
        self.assertEqual(editor.sources, updated)
        self.assertEqual(len(editor.table.children), 3)
        self.assertIs(editor.table.get_selected_row(), row)
        self.assertEqual(editor.form_values(), raw)
        self.assertIs(editor.baseline_source, baseline)
        self.assertEqual(editor.edit_revision, self.REV_B)
        self.assertFalse(editor.conflict)
        editor.observe_revision(self.REV_B)
        self.request.assert_called_once()

    def test_clean_selected_source_syncs_and_get_can_finish_after_selection_changes(self):
        editor = self.editor()
        row = editor.table.get_selected_row()
        editor.reload_sources()
        changed = self.source(label="Saved elsewhere", color="#404040", showMarker=False)
        self.reply([changed, editor.sources[1]], self.REV_B)
        self.assertIs(editor.table.get_selected_row(), row)
        self.assertEqual((editor.name.get_text(), editor.source_color.get_rgba(), editor.show_marker.get_active()),
                         ("Saved elsewhere", "#404040", False))
        self.assertFalse(editor.is_dirty())
        self.assertEqual(editor.edit_revision, self.REV_B)
        editor.reload_sources()
        other_row = editor.table.children[1]
        editor.table.select_row(other_row)
        self.reply([changed, self.source(id="other", label="Other updated", enabled=False)], self.REV_C)
        self.assertIs(editor.table.get_selected_row(), other_row)
        self.assertEqual((editor.editing_id, editor.name.get_text()), ("other", "Other updated"))

    def test_status_only_refresh_updates_metadata_and_keeps_dirty_fields_and_baseline(self):
        editor = self.editor()
        missing = self.source(status="missing", sessionCount=0, message="Store is missing.")
        editor.sources[0] = missing
        editor.render_sources("main")
        baseline, form_baseline = editor.baseline_source, editor.form_baseline
        row = editor.table.get_selected_row()
        raw = self.edit_all_fields(editor)
        editor.preferences.get_focus.return_value = editor.name
        editor.table_line.reset_mock()
        editor.reload_sources()
        ready = self.source(status="ready", sessionCount=1, message="Store is ready.")
        self.reply([ready, editor.sources[1]], self.REV_A)
        editor.source_status.set_label.assert_called_with("Ready: Store is ready")
        self.assertEqual(editor.table_line.call_args.args[0][-1], "1 chats · Ready\nStore is ready.")
        self.assertEqual(editor.form_values(), raw)
        self.assertTrue(editor.is_dirty())
        self.assertIs(editor.baseline_source, baseline)
        self.assertIs(editor.form_baseline, form_baseline)
        self.assertEqual(editor.edit_revision, self.REV_A)
        self.assertIs(editor.table.get_selected_row(), row)
        self.assertIs(editor.preferences.get_focus(), editor.name)

    def test_dirty_changed_or_deleted_source_keeps_old_baseline_and_blocks_overwrite(self):
        for deleted in (False, True):
            with self.subTest(deleted=deleted):
                editor = self.editor()
                raw, baseline = self.edit_all_fields(editor), editor.baseline_source
                editor.reload_sources()
                updated = [editor.sources[1]] if deleted else [self.source(label="External edit"), editor.sources[1]]
                self.reply(updated, self.REV_B)
                self.assertEqual(editor.form_values(), raw)
                self.assertIs(editor.baseline_source, baseline)
                self.assertEqual(editor.edit_revision, self.REV_A)
                self.assertTrue(editor.conflict)
                self.assertIn("Your edits are kept", editor.message.set_label.call_args.args[0])
                self.request.reset_mock()
                editor.save_source()
                editor.remove_source()
                self.request.assert_not_called()
                editor.cancel_form()
                self.assertFalse(editor.conflict)
                self.assertFalse(editor.is_dirty())
                self.assertEqual(editor.edit_revision, self.REV_B)
                self.assertEqual(editor.name.get_text(), "Other" if deleted else "External edit")

    def test_add_draft_and_manual_refresh_keep_exact_fields(self):
        editor = self.editor()
        editor.add_source()
        raw = self.edit_all_fields(editor)
        editor.reload_sources()
        self.reply([*editor.sources, self.source(id="new")], self.REV_B)
        self.assertEqual(editor.editing_id, "")
        self.assertIsNone(editor.table.get_selected_row())
        self.assertEqual(editor.form_values(), raw)
        self.assertEqual(editor.edit_revision, self.REV_B)
        self.assertFalse(editor.conflict)
        editor.cancel_form()
        self.assertFalse(editor.is_dirty())
        self.assertEqual(editor.editing_id, "main")

    def test_if_match_failure_keeps_edits_and_own_success_updates_baseline(self):
        editor = self.editor()
        editor.name.set_text("My edit")
        raw = editor.form_values()
        editor.save_source()
        self.assertEqual(self.request.call_args.kwargs, {"headers": {"If-Match": '"' + self.REV_A + '"'}})
        self.reply([], self.REV_B, "App sources changed. Refresh the source list and try again.")
        self.assertEqual(editor.form_values(), raw)
        self.assertTrue(editor.is_dirty())
        self.assertEqual(editor.edit_revision, self.REV_A)
        editor.reload_sources()
        self.reply(editor.sources, self.REV_B)
        editor.save_source()
        self.assertEqual(self.request.call_args.kwargs["headers"]["If-Match"], '"' + self.REV_B + '"')
        self.reply([self.source(label="My edit"), editor.sources[1]], self.REV_C)
        self.assertFalse(editor.is_dirty())
        self.assertEqual((editor.edit_revision, editor.baseline_source["label"]), (self.REV_C, "My edit"))
        editor.owner.refresh.assert_called_once_with(True)

    def test_revision_changes_during_a_mutation_coalesce_and_are_not_lost(self):
        editor = self.editor()
        editor.name.set_text("My edit")
        editor.save_source()
        editor.observe_revision(self.REV_B)
        editor.observe_revision(self.REV_C)
        editor.reload_sources()
        self.request.assert_called_once()
        self.reply([self.source(label="My edit"), editor.sources[1]], self.REV_B)
        self.assertEqual(self.request.call_count, 2)
        self.assertEqual(self.request.call_args.args[4], "GET")
        self.assertTrue(editor.loading)
        self.reply([*editor.sources, self.source(id="added-later")], self.REV_C)
        self.assertEqual((editor.revision, len(editor.sources)), (self.REV_C, 3))
        self.assertFalse(editor.loading or editor.refresh_queued)
        editor.reload_sources()
        editor.observe_revision(self.REV_A)
        self.reply(editor.sources, self.REV_C)
        self.assertEqual(self.request.call_count, 4)
        self.assertTrue(editor.loading)
        self.reply(editor.sources, self.REV_A)
        self.assertFalse(editor.loading or editor.refresh_queued)

    def test_failed_revision_refresh_retries_once_on_the_next_304(self):
        editor = self.editor()
        raw = self.edit_all_fields(editor)
        editor.observe_revision(self.REV_B)
        editor.reload_sources()
        self.assertTrue(editor.refresh_queued)
        self.reply([], self.REV_B, "Cannot load app sources.")
        self.request.assert_called_once()
        self.assertIsNone(editor.observed_revision)
        self.assertFalse(editor.loading or editor.refresh_queued)
        self.assertEqual(editor.form_values(), raw)
        editor.message.set_label.assert_called_with("Cannot load app sources.")

        window = object.__new__(Window)
        window.closed = window.refresh_queued = window.refresh_force_queued = False
        window.preferences_window = SimpleNamespace(profiles_editor=editor)
        window.sources_revision = self.REV_B
        window.report_ui = Mock()
        window.apply_dashboard(None, None)
        self.assertEqual(self.request.call_count, 2)
        self.assertEqual(self.request.call_args.args[1], "/api/sources")
        self.assertEqual(self.request.call_args.args[4], "GET")
        self.assertTrue(editor.loading)
        self.reply([*editor.sources, self.source(id="added-later")], self.REV_B)
        self.assertEqual((editor.revision, len(editor.sources)), (self.REV_B, 3))
        self.assertEqual(editor.form_values(), raw)
        self.assertFalse(editor.loading or editor.refresh_queued)
        window.apply_dashboard(None, None)
        self.assertEqual(self.request.call_count, 2)
        self.assertEqual(window.report_ui.call_count, 2)

    def test_reordered_rows_keep_keyboard_focus_without_resetting_the_form(self):
        editor = self.editor()
        selected = editor.table.get_selected_row()
        raw = self.edit_all_fields(editor)
        editor.preferences.get_focus.side_effect = [selected, None]
        editor.sources.reverse()
        editor.render_sources("main", preserve_form=True)
        self.assertIs(editor.table.get_selected_row(), selected)
        self.assertTrue(selected.focused)
        self.assertEqual(editor.form_values(), raw)

    def test_reopen_and_chooser_queue_refresh_without_losing_draft(self):
        editor = self.editor()
        raw = self.edit_all_fields(editor)
        editor.set_active(False)
        editor.observe_revision(self.REV_B)
        self.request.assert_not_called()
        editor.choosing = True
        editor.set_active(True)
        self.request.assert_not_called()
        self.assertTrue(editor.refresh_queued)
        editor.choosing = False
        editor.flush_refresh()
        self.reply(editor.sources, self.REV_B)
        self.assertEqual(editor.form_values(), raw)
        editor.set_active(True)
        self.request.assert_called_once()
        editor.set_active(False)
        editor.set_active(True)
        self.assertEqual(self.request.call_count, 2)
        self.reply(editor.sources, self.REV_B)
        self.assertEqual(editor.form_values(), raw)

    def test_legacy_and_invalid_revision_response_keeps_form_and_omits_if_match(self):
        editor = self.editor()
        editor.name.set_text("Draft")
        for revision in (None, 1, "invalid", "A" * 64):
            editor.reload_sources()
            self.reply(editor.sources, revision)
            self.assertIsNone(editor.revision)
            self.assertEqual(editor.name.get_text(), "Draft")
            self.assertFalse(editor.conflict)
        editor.save_source()
        self.assertEqual(self.request.call_args.kwargs, {})

    def test_ui_reports_exact_fields_coalesce_and_heartbeat_on_304(self):
        window = object.__new__(Window)
        editor = self.editor()
        editor.observed_revision = self.REV_B
        preferences = SimpleNamespace(closed=False, profiles_editor=editor, get_visible=lambda: True,
                                      get_mapped=lambda: True, stack=Mock(get_visible_child_name=Mock(return_value="profiles")))
        window.closed, window.base, window.preferences_window = False, editor.base, preferences
        window.ui_client_id = str(SCOPE["uuid"].uuid4())
        window.sources_revision = self.REV_B
        window.ui_report_last, window.ui_report_at, window.ui_report_sending = None, 0, False
        window.refresh_queued = window.refresh_force_queued = False
        clock = Mock(return_value=0)
        with patch.dict(SCOPE, {"SOURCE_TOKEN": "ab" * 32, "time": SimpleNamespace(monotonic=clock)}):
            window.report_ui()
            payload = self.request.call_args.args[5]
            self.assertEqual(payload, {"clientId": window.ui_client_id, "sourcesRevision": self.REV_B,
                "profilesRevision": self.REV_A, "profilesVisible": True, "dirty": False})
            self.assertEqual(str(SCOPE["uuid"].UUID(payload["clientId"])), window.ui_client_id)
            callback = self.request.call_args.args[2]
            editor.name.set_text("Draft")
            window.report_ui()
            self.request.assert_called_once()
            callback({}, None)
            self.assertEqual(self.request.call_count, 2)
            self.assertTrue(self.request.call_args.args[5]["dirty"])
            self.request.call_args.args[2](None, "An old server has no UI endpoint.")
            self.assertEqual(self.request.call_count, 2)
            clock.return_value = 24
            window.report_ui()
            self.assertEqual(self.request.call_count, 2)
            clock.return_value = 25
            window.apply_dashboard(None, None)
            self.assertEqual(self.request.call_count, 3)
            self.request.call_args.args[2]({}, None)
            preferences.stack.get_visible_child_name.return_value = "sessions"
            editor.loaded = False
            window.report_ui()
            self.assertEqual(self.request.call_count, 4)
            self.assertEqual(self.request.call_args.args[5], {"clientId": window.ui_client_id,
                "sourcesRevision": self.REV_B, "profilesRevision": None, "profilesVisible": False, "dirty": True})
            window.closed = True
            self.request.call_args.args[2]({}, None)
            self.assertEqual(self.request.call_count, 4)
            window.closed = False
            with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
                window.report_ui()
            self.assertEqual(self.request.call_count, 4)

    def test_agent_token_routing_and_optional_conditional_headers(self):
        import io
        token = "ab" * 32
        for route, method in (("/api/agent/status", "GET"), ("/api/agent/ui", "POST"),
                              ("/api/agent/status?fresh=1", "GET"), ("/api/agentx/status", "GET")):
            transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{}')))
            with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
                asb.request_json("http://127.0.0.1:1", route, method, {})
            request = transport.open.call_args.args[0]
            self.assertEqual(request.get_header("X-asb-source-token"), token if "/agent/" in route else None)
        transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"changed": true}')))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
            received = []
            REQUEST_ASYNC("http://127.0.0.1:1", "/api/sources", None, lambda *args: received.append(args),
                          "POST", {}, headers={"If-Match": '"' + self.REV_A + '"'}).join(1)
        self.assertEqual(received, [(None, {"changed": True}, None)])
        self.assertEqual(transport.open.call_args.args[0].get_header("If-match"), '"' + self.REV_A + '"')
        self.assertEqual(transport.open.call_args.args[0].get_header("X-asb-source-token"), token)


class PhoneChecks(unittest.TestCase):
    def status(self, **changes):
        return {"enabled": True, "bindAddresses": ["192.168.50.4"], "port": 4630,
                "addresses": [{"address": "192.168.50.4", "interface": "enp0s1", "kind": "lan"}],
                "listening": [{"kind": "lan", "address": "192.168.50.4"}], "running": True, "error": "", "warning": "", "fingerprint": "abcd" * 16,
                "devices": [], "pairing": {"expiresAtMs": 0}, **changes}

    def editor(self):
        editor = object.__new__(PhoneEditor)
        editor.owner, editor.preferences = SimpleNamespace(closed=False), SimpleNamespace(closed=False)
        editor.base, editor.closed, editor.active, editor.loaded = "http://127.0.0.1:1", False, True, True
        editor.loading = editor.poll_loading = False
        editor.generation, editor.poll_timer = 0, None
        editor.status, editor.address_checks, editor.remove_buttons = self.status(), {"192.168.50.4": Mock()}, []
        editor.pairing_uri, editor.expires_at, editor.pair_device_ids, editor.matrix = "", 0, set(), None
        for name in ("settings", "apply", "pair", "retry", "message", "status_label", "fingerprint", "enabled",
                     "address_list", "address_note", "port", "devices", "empty", "pairing", "qr", "link", "copy", "qr_help"):
            setattr(editor, name, Mock())
        editor.devices.get_first_child.return_value = None
        return editor

    def test_phone_helpers_cover_off_starting_running_error_and_fingerprint(self):
        self.assertEqual(asb.group_fingerprint("abcd" * 16), " ".join(["abcd"] * 16))
        self.assertEqual(asb.group_fingerprint(""), "")
        self.assertEqual(asb.phone_status_text(self.status()), "Running at https://192.168.50.4:4630 (Home network)")
        self.assertEqual(asb.phone_status_text(self.status(enabled=False, running=False)), "Phone access is off.")
        self.assertIn("Apply the settings", asb.phone_status_text(self.status(running=False)))
        self.assertEqual(asb.phone_status_text(self.status(running=False, error="Choose a private address.")),
                         "Choose a private address.")
        missing = "The phone address 10.147.17.4 is not on this PC now. Choose another address."
        self.assertEqual(asb.phone_status_text(self.status(port=4631, error=missing, listening=[
            {"kind": "lan", "address": "192.168.50.4"}, {"kind": "tailscale", "address": "100.101.102.103"}])),
            "Running at https://192.168.50.4:4631 (Home network), https://100.101.102.103:4631 (Tailscale)\n" + missing)

    def test_phone_address_rows_name_each_kind_and_note_missing_overlays(self):
        lan = {"address": "192.168.50.4", "interface": "enp0s1", "kind": "lan"}
        zerotier = {"address": "10.147.17.4", "interface": "ztabcdef12", "kind": "zerotier"}
        tailscale = {"address": "100.101.102.103", "interface": "tailscale0", "kind": "tailscale"}
        self.assertEqual(asb.phone_address_rows([lan, zerotier, tailscale, {"address": "8.8.8.8", "kind": "other"}]), [
            {"address": "192.168.50.4", "title": "Home network", "subtitle": "192.168.50.4"},
            {"address": "10.147.17.4", "title": "ZeroTier", "subtitle": "10.147.17.4 · Works away from home"},
            {"address": "100.101.102.103", "title": "Tailscale", "subtitle": "100.101.102.103 · Works away from home"}])
        note = "Install and join ZeroTier or Tailscale on this PC and the phone to use ASB away from home."
        self.assertEqual(asb.phone_address_note([lan]), note)
        self.assertEqual(asb.phone_address_note([lan, zerotier]), "")
        self.assertEqual(asb.phone_address_note([tailscale]), "")
        self.assertEqual(asb.phone_address_note([]), "No private network address on this PC. " + note)

    def test_qr_helper_builds_the_expected_matrix_or_returns_none_without_qrcode(self):
        import builtins
        original_import = builtins.__import__
        def no_qrcode(name, *args, **kwargs):
            if name == "qrcode":
                raise ModuleNotFoundError("qrcode")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=no_qrcode):
            self.assertIsNone(asb.qr_matrix("asb://pair?v=1"))
        code = Mock(get_matrix=Mock(return_value=[[True, False], [False, True]]))
        module = SimpleNamespace(QRCode=Mock(return_value=code), constants=SimpleNamespace(ERROR_CORRECT_M=17))
        with patch.dict("sys.modules", {"qrcode": module}):
            self.assertEqual(asb.qr_matrix("asb://pair?v=1"), [[True, False], [False, True]])
        module.QRCode.assert_called_once_with(error_correction=17, border=4)
        code.add_data.assert_called_once_with("asb://pair?v=1")
        code.make.assert_called_once_with(fit=True)

    def test_phone_and_service_http_headers_success_and_errors(self):
        import io
        token = "cd" * 32
        routes = (("/api/phone", "GET"), ("/api/phone?force=1", "GET"),
                  ("/api/phone/settings", "POST"), ("/api/phone/pairing", "POST"),
                  ("/api/phone/devices/a/revoke", "POST"), ("/api/service", "GET"))
        for route, method in routes:
            with self.subTest(route=route):
                transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"enabled": false}')))
                with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
                    self.assertEqual(asb.request_json("http://127.0.0.1:1", route, method, {}), {"enabled": False})
                request = transport.open.call_args.args[0]
                self.assertEqual(request.get_header("X-asb-source-token"), token)
                self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:1" if method == "POST" else None)
        for route in ("/api/phonex", "/api/servicex", "/api/threads/a/pin"):
            transport = Mock(open=Mock(side_effect=OSError()))
            with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
                with self.assertRaises(RuntimeError):
                    asb.request_json("http://127.0.0.1:1", route)
            self.assertIsNone(transport.open.call_args.args[0].get_header("X-asb-source-token"))
        for route in ("/api/phone/settings", "/api/service"):
            failure = SCOPE["HTTPError"]("http://127.0.0.1:1" + route, 400, "Bad Request", {},
                                          io.BytesIO(b'{"error":"Choose a private address."}'))
            with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=failure))}):
                with self.assertRaisesRegex(RuntimeError, "Choose a private address"):
                    asb.request_json("http://127.0.0.1:1", route, "POST", {})
        with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(return_value=io.BytesIO(b'{}')))}):
            with self.assertRaisesRegex(RuntimeError, "Cannot change this session"):
                asb.request_json("http://127.0.0.1:1", "/api/threads/a/pin", "POST", {})

    def test_status_refresh_keeps_form_edits_and_lists_device_dates(self):
        editor = self.editor()
        device = {"id": "a", "name": "Test <phone> & tablet", "createdAtMs": NOW, "lastSeenAtMs": NOW - 60_000}
        row = Mock()
        gtk = SimpleNamespace(CheckButton=Mock(side_effect=lambda **kwargs: Mock(active=kwargs["active"])),
                              Button=Mock(), Align=SimpleNamespace(CENTER=0),
                              AccessibleProperty=SimpleNamespace(LABEL=0))
        editor.address_list.get_first_child.side_effect = [Mock(), None, None, None]
        with patch.dict(SCOPE, {"Gtk": gtk, "Adw": SimpleNamespace(ActionRow=Mock(return_value=row))}):
            editor.render_status(self.status(devices=[device]))
            editor.enabled.set_active.assert_not_called()
            editor.address_list.append.assert_not_called()
            editor.port.set_value.assert_not_called()
            self.assertEqual(SCOPE["Adw"].ActionRow.call_args.kwargs["title"], "Test <phone> & tablet")
            self.assertFalse(SCOPE["Adw"].ActionRow.call_args.kwargs["use_markup"])
            self.assertIn("Paired ", SCOPE["Adw"].ActionRow.call_args.kwargs["subtitle"])
            self.assertIn("\nLast seen ", SCOPE["Adw"].ActionRow.call_args.kwargs["subtitle"])
            editor.empty.set_visible.assert_called_with(False)
            addresses = [{"address": "192.168.50.4", "interface": "enp0s1", "kind": "lan"},
                         {"address": "100.101.102.103", "interface": "tailscale0", "kind": "tailscale"}]
            SCOPE["Adw"].ActionRow.reset_mock()
            editor.render_status(self.status(addresses=addresses, bindAddresses=["100.101.102.103", "10.147.17.4"]), True)
            editor.address_list.remove.assert_called_once()
            self.assertEqual(list(editor.address_checks), ["192.168.50.4", "100.101.102.103"])
            self.assertEqual([check.active for check in editor.address_checks.values()], [False, True])
            self.assertEqual([(call.kwargs["title"], call.kwargs["subtitle"]) for call in SCOPE["Adw"].ActionRow.call_args_list],
                             [("Home network", "192.168.50.4"), ("Tailscale", "100.101.102.103 · Works away from home")])
            self.assertIs(SCOPE["Adw"].ActionRow.call_args.kwargs["activatable_widget"], editor.address_checks["100.101.102.103"])
            self.assertEqual(editor.address_list.append.call_count, 2)
            editor.address_list.set_visible.assert_called_with(True)
            editor.address_note.set_visible.assert_called_with(False)
            editor.port.set_value.assert_called_once_with(4630)
            editor.render_status(self.status(addresses=[], bindAddresses=[]), True)
            self.assertEqual(editor.address_checks, {})
            editor.address_list.set_visible.assert_called_with(False)
            editor.address_note.set_label.assert_called_with(asb.phone_address_note([]))
            editor.address_note.set_visible.assert_called_with(True)
            editor.empty.set_visible.assert_called_with(True)

    def test_phone_requests_retry_errors_and_preserve_poll_form(self):
        editor = self.editor()
        editor.loaded = False
        editor.render_status = Mock(side_effect=lambda *_args: setattr(editor, "loaded", True))
        request, glib = Mock(), SimpleNamespace(idle_add=Mock(), source_remove=Mock())
        with patch.dict(SCOPE, {"request_async": request, "GLib": glib}):
            editor.request_phone()
            self.assertTrue(editor.loading)
            callback = request.call_args.args[2]
            callback(None, "ASB is not answering.")
            self.assertFalse(editor.loading)
            editor.retry.set_visible.assert_called_with(True)
            editor.request_phone()
            request.call_args.args[2](self.status(), None)
            editor.render_status.assert_called_once_with(self.status(), True)
            editor.render_status.reset_mock()
            editor.pairing_uri, editor.expires_at = "asb://pair?v=1", NOW + 600_000
            with patch.object(SCOPE["time"], "time", return_value=NOW / 1000):
                editor.request_phone(poll=True)
                self.assertFalse(editor.loading)
                self.assertTrue(editor.poll_loading)
                count = request.call_count
                editor.request_phone(poll=True)
                self.assertEqual(request.call_count, count)
                request.call_args.args[2](None, "ASB is not answering.")
                editor.message.set_label.assert_called_with("ASB is not answering.")
                editor.request_phone(poll=True)
                request.call_args.args[2](self.status(pairing={"expiresAtMs": editor.expires_at}), None)
                editor.message.set_label.assert_called_with("")
            self.assertFalse(editor.poll_loading)
            self.assertFalse(editor.render_status.call_args.args[1])
            editor.request_phone("/api/phone/settings", "POST", {})
            request.call_args.args[2](self.status(), None)
            self.assertTrue(editor.render_status.call_args.args[1])

    def test_pairing_poll_stops_for_success_expiry_hide_and_stale_callbacks(self):
        editor = self.editor()
        editor.render_status = Mock()
        glib = SimpleNamespace(idle_add=Mock(), timeout_add_seconds=Mock(return_value=51), source_remove=Mock())
        request = Mock()
        result = {"uri": "asb://pair?v=1", "expiresAtMs": NOW + 600_000}
        with patch.dict(SCOPE, {"GLib": glib, "request_async": request, "qr_matrix": Mock(return_value=None)}), \
                patch.object(SCOPE["time"], "time", return_value=NOW / 1000):
            editor.show_pairing(result)
            glib.timeout_add_seconds.assert_called_once_with(3, editor.poll_pairing)
            editor.link.set_label.assert_called_with(result["uri"])
            editor.qr.set_visible.assert_called_with(False)
            self.assertTrue(editor.poll_pairing())
            callback = request.call_args.args[2]
            device = {"id": "new", "name": "New phone", "createdAtMs": NOW}
            callback(self.status(devices=[device]), None)
            self.assertIsNone(editor.poll_timer)
            self.assertEqual(editor.pairing_uri, "")
            editor.message.set_label.assert_called_with("Paired: New phone")
            glib.source_remove.assert_called_once_with(51)
            editor.show_pairing(result)
            editor.poll_pairing()
            callback = request.call_args.args[2]
            editor.expires_at = NOW - 1
            self.assertFalse(editor.poll_pairing())
            editor.message.set_label.assert_called_with("This pairing code has expired. Pair a phone to make a new one.")
            editor.render_status.reset_mock()
            callback(self.status(), None)
            editor.render_status.assert_not_called()
            editor.show_pairing(result)
            editor.poll_pairing()
            callback = request.call_args.args[2]
            editor.set_active(False)
            self.assertFalse(editor.poll_pairing())
            self.assertEqual(editor.pairing_uri, "")
            callback(self.status(), None)
            editor.render_status.assert_not_called()
            editor.set_active(True)
            callback(self.status(), None)
            editor.render_status.assert_not_called()
            editor.request_phone("/api/phone/pairing", "POST", {})
            callback = request.call_args.args[2]
            editor.close()
            callback(result, None)
            self.assertTrue(editor.closed)
            self.assertIsNone(editor.poll_timer)
            self.assertEqual(glib.timeout_add_seconds.call_count, 3)

    def test_settings_revoke_pairing_and_qr_use_native_values(self):
        editor = self.editor()
        editor.address_checks = {"192.168.50.4": Mock(get_active=Mock(return_value=True)),
                                  "10.147.17.4": Mock(get_active=Mock(return_value=False)),
                                  "100.101.102.103": Mock(get_active=Mock(return_value=True))}
        editor.enabled.get_active.return_value = False
        editor.port.get_value.return_value = 4631
        editor.request_phone = Mock()
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(source_remove=Mock())}):
            editor.apply_settings()
            editor.request_phone.assert_called_with("/api/phone/settings", "POST",
                {"enabled": False, "bindAddresses": ["192.168.50.4", "100.101.102.103"], "port": 4631})
            editor.revoke_device("a/b")
            editor.request_phone.assert_called_with("/api/phone/devices/a%2Fb/revoke", "POST", {})
            editor.pair_phone()
            editor.request_phone.assert_called_with("/api/phone/pairing", "POST", {})
            editor.active = False
            editor.request_phone.reset_mock()
            editor.apply_settings()
            editor.revoke_device("a")
            editor.pair_phone()
            editor.request_phone.assert_not_called()
        editor.matrix = [[True, False], [False, True]]
        context = Mock()
        editor.draw_qr(None, context, 241, 240)
        self.assertEqual([call.args for call in context.set_source_rgb.call_args_list], [(1, 1, 1), (0, 0, 0)])
        self.assertEqual([call.args for call in context.rectangle.call_args_list], [(0, 0, 120, 120), (120, 120, 120, 120)])

    def test_copy_link_remains_available_with_qr_and_rejects_expired_codes(self):
        editor = self.editor()
        clipboard = Mock()
        editor.get_clipboard = Mock(return_value=clipboard)
        result = {"uri": "asb://pair?v=1", "expiresAtMs": NOW + 600_000}
        glib = SimpleNamespace(timeout_add_seconds=Mock(return_value=51), source_remove=Mock())
        with patch.dict(SCOPE, {"GLib": glib, "qr_matrix": Mock(return_value=[[True]])}), \
                patch.object(SCOPE["time"], "time", return_value=NOW / 1000):
            editor.show_pairing(result)
            editor.copy.set_visible.assert_called_with(True)
            editor.qr.set_visible.assert_called_with(True)
            editor.link.set_visible.assert_called_with(False)
            editor.copy_pairing()
            clipboard.set.assert_called_once_with(result["uri"])
            clipboard.set.reset_mock()
            editor.expires_at = NOW - 1
            editor.copy_pairing()
            clipboard.set.assert_not_called()
            self.assertEqual(editor.pairing_uri, "")
            self.assertIsNone(editor.poll_timer)

    def test_preferences_loads_phone_once_and_stops_it_on_page_and_window_hide(self):
        preferences = object.__new__(Preferences)
        preferences.owner, preferences.closed = SimpleNamespace(closed=False, report_ui=Mock()), False
        preferences.profiles_editor = preferences.phone_editor = None
        preferences.phone = Mock()
        preferences.stack = Mock(get_visible_child_name=Mock(return_value="sessions"))
        preferences.get_visible = Mock(return_value=True)
        preferences.get_mapped = Mock(return_value=True)
        editor = Mock()
        with patch.dict(SCOPE, {"PhoneEditor": Mock(return_value=editor)}):
            preferences.section_changed()
            SCOPE["PhoneEditor"].assert_not_called()
            preferences.stack.get_visible_child_name.return_value = "phone"
            preferences.section_changed()
            preferences.section_changed()
            SCOPE["PhoneEditor"].assert_called_once_with(preferences.owner, preferences)
            preferences.phone.append.assert_called_once_with(editor)
            editor.set_active.assert_called_with(True)
            preferences.stack.get_visible_child_name.return_value = "appearance"
            preferences.section_changed()
            editor.set_active.assert_called_with(False)
            preferences.stack.get_visible_child_name.return_value = "phone"
            preferences.get_mapped.return_value = False
            preferences.section_changed()
            editor.set_active.assert_called_with(False)
            preferences.get_mapped.return_value = True
            preferences.get_visible.return_value = False
            preferences.section_changed()
            editor.set_active.assert_called_with(False)


class DataChecks(unittest.TestCase):
    def test_realize_disables_x11_frame_feedback_only_on_composited_displays(self):
        constructor = next(node for node in WINDOW.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        hooks = [node for node in ast.walk(constructor) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == "connect"
                 and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "realize"]
        self.assertEqual(len(hooks), 1)
        self.assertEqual(hooks[0].args[1].attr, "watch_layout")
        for has_api, composited in ((True, True), (True, False), (False, True)):
            with self.subTest(has_api=has_api, composited=composited):
                surface = SimpleNamespace(connect=Mock(return_value=17))
                frame_sync = Mock()
                if has_api:
                    surface.set_frame_sync_enabled = frame_sync
                display = SimpleNamespace(is_composited=Mock(return_value=composited))
                window = object.__new__(Window)
                window.get_surface, window.get_display = lambda: surface, lambda: display
                window.queue_geometry = Mock()
                window.watch_layout()
                if has_api and composited:
                    frame_sync.assert_called_once_with(False)
                else:
                    frame_sync.assert_not_called()
                self.assertEqual(display.is_composited.call_count, int(has_api))
                self.assertIs(window.layout_surface, surface)
                self.assertEqual(window.surface_signal, 17)
                surface.connect.assert_called_once_with("layout", window.queue_geometry)
                window.queue_geometry.assert_called_once_with()

    def test_offscreen_snapshots_keep_rows_and_include_cross_column_motion(self):
        viewport = SimpleNamespace(get_width=lambda: 500)
        window = SimpleNamespace(scroll=SimpleNamespace(get_child=lambda: viewport,
                                 get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 200)), motion_bounds={})
        strip = SimpleNamespace(motion={}, motion_progress=0)
        column = object.__new__(Column)
        row = SimpleNamespace(asb_focus_key="row", get_next_sibling=lambda: None)
        column.get_root, column.get_parent = lambda: window, lambda: strip
        column.get_first_child, column.snapshot_child = lambda: row, Mock()
        bounds = SimpleNamespace(origin=SimpleNamespace(x=800), size=SimpleNamespace(width=240))
        column.compute_bounds = lambda _viewport: (True, bounds)
        snapshot = Mock()
        column.do_snapshot(snapshot)
        self.assertTrue(column.asb_snapshot_skipped)
        self.assertIs(column.get_first_child(), row)
        column.snapshot_child.assert_not_called()
        for left, visible in ((500, False), (499, True), (-240, False), (-239, True)):
            bounds.origin.x = left
            self.assertEqual(column.in_viewport(), visible)
        bounds.origin.x = 800
        strip.motion_progress = .5
        window.motion_bounds[column] = (450, 1240, 0, 68)
        column.do_snapshot(snapshot)
        self.assertFalse(column.asb_snapshot_skipped)
        column.snapshot_child.assert_called_once_with(row, snapshot)
        strip.motion_progress = 0
        self.assertFalse(column.in_viewport())
        column.compute_bounds = lambda _viewport: (False, bounds)
        self.assertTrue(column.in_viewport())

    def test_scroll_and_layout_restore_cached_empty_columns_once(self):
        window = object.__new__(Window)
        window.closed, window.scroll_updating, window.motion_from = False, True, None
        window.list_body, window.queue_number_keys = Mock(), Mock()
        position, width = [1500], [500]
        viewport = SimpleNamespace(get_width=lambda: width[0])
        adjustment = SimpleNamespace(get_value=lambda: position[0], get_page_size=lambda: width[0])
        window.scroll = SimpleNamespace(get_child=lambda: viewport, get_hadjustment=lambda: adjustment)
        window.list_columns = []
        strip = SimpleNamespace(motion_progress=0)
        for index in range(12):
            column = object.__new__(Column)
            column.asb_snapshot_skipped = True
            column.get_root, column.get_parent = lambda: window, lambda: strip
            column.queue_draw = Mock()
            column.compute_bounds = lambda _viewport, index=index: (True, SimpleNamespace(
                origin=SimpleNamespace(x=index * 252 + 4 - position[0]), size=SimpleNamespace(width=240)))
            window.list_columns.append(column)
        window.scroll_position_changed()
        self.assertTrue(all(window.list_columns[index].queue_draw.called for index in (5, 6, 7)))
        window.list_columns[0].queue_draw.assert_not_called()
        window.list_columns[11].queue_draw.assert_not_called()
        window.scroll_position_changed()
        self.assertTrue(all(column.queue_draw.call_count <= 1 for column in window.list_columns))
        position[0] = 0
        window.scroll_position_changed()
        self.assertTrue(all(window.list_columns[index].queue_draw.called for index in (0, 1)))
        window.list_columns[2].asb_snapshot_skipped = True
        window.list_columns[2].queue_draw.reset_mock()
        width[0] = 600
        window.start_motion()
        self.assertEqual(window.list_columns[2].queue_draw.call_count, 1)
        self.assertTrue(all(column.queue_draw.call_count <= 1 for column in window.list_columns))

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

    def test_limited_drawer_row_has_no_dot_until_the_reset(self):
        at = SCOPE["time"].time() * 1000
        row = {"id": "a", "state": "idle", "drawer": True, "limitResetsAtMs": at + 3_600_000}
        self.assertEqual(asb.attention_indicator(row, True), "")
        self.assertEqual(asb.attention_indicator({**row, "limitResetsAtMs": at - 1}, True), "dot")

    def test_usage_limit_tooltip_uses_24_hour_time_without_an_am_pm_marker(self):
        time, strftime = SCOPE["time"], SCOPE["time"].strftime
        reset = time.mktime((2026, 10, 7, 20, 28, 0, 0, 0, -1)) * 1000
        row = {"id": "a", "provider": "codex", "providerLabel": "Codex", "title": "Chat", "state": "idle", "canOpen": True,
               "updatedAtMs": reset - 600_000, "limitResetsAtMs": reset}
        # A locale with no AM/PM marker: %p gives an empty string.
        with patch.object(time, "strftime", lambda form, *at: strftime(form.replace("%p", ""), *at)):
            limit = asb.tooltip_model(row, reset - 3_600_000, "/home/test")["limit"]
        self.assertEqual(limit, "Codex is out of usage. It resets at 20:28.")

    def test_usage_limit_days_away_show_days_hours_and_the_weekday(self):
        row = {"id": "a", "provider": "codex", "providerLabel": "Codex", "title": "Chat", "state": "idle", "canOpen": True,
               "updatedAtMs": NOW - 600_000, "limitResetsAtMs": NOW + 3_600_000}
        # Rounded up; from 24 hours on, days and hours. The Working timer keeps its format.
        for seconds, text, spoken in ((86_400, "1d0h", "1 day"), (86_399, "23h59m", "23 hours 59 minutes"),
                                      (273_600, "3d4h", "3 days 4 hours"), (90_000, "1d1h", "1 day 1 hour"),
                                      (604_800, "7d0h", "7 days"), (176_399, "2d0h", "2 days")):
            self.assertEqual((asb.limit_text(seconds), asb.spoken_limit(seconds)), (text, spoken))
        self.assertEqual(asb.working_duration({"state": "working", "workingSinceMs": NOW - 273_600_000}, NOW), "76h0m")
        self.assertEqual(asb.clock_interval([{**row, "limitResetsAtMs": NOW + 273_600_000}], NOW), 60)

        time = SCOPE["time"]
        # NOW is Monday 21 September 2026, 14:13:20 UTC; UTC is the local zone here.
        with patch.object(time, "localtime", time.gmtime), patch.object(time, "time", lambda: NOW / 1000):
            for reset, text in ((NOW + 9 * 3_600_000, "It resets at 11:13 PM."),
                                (NOW + 10 * 3_600_000, "It resets Tuesday at 12:13 AM."),
                                (NOW + 273_600_000, "It resets Thursday at 6:13 PM."),
                                # Today's weekday a week away needs the date.
                                (NOW + 604_500_000, "It resets Monday 28 September at 2:08 PM.")):
                limited = {**row, "limitResetsAtMs": reset}
                self.assertEqual(asb.tooltip_model(limited, NOW, "/home/test")["limit"], f"Codex is out of usage. {text}")
                self.assertEqual(asb.tooltip_model(limited, None, "/home/test")["limit"], f"Codex is out of usage. {text}")
            strftime = time.strftime
            with patch.object(time, "strftime", lambda form, *at: strftime(form.replace("%p", ""), *at)):
                self.assertEqual(asb.tooltip_model({**row, "limitResetsAtMs": NOW + 273_600_000}, NOW, "/home/test")["limit"],
                                 "Codex is out of usage. It resets Thursday at 18:13.")

        window = object.__new__(Window)
        window.opening, window.open_errors = set(), {}
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for view, state in (("comfortable", "Resets in"), ("compact", "Resets 3d4h")):
                window.view = view
                widget = SimpleNamespace(asb_thread={**row, "limitResetsAtMs": NOW + 273_600_000}, asb_time_signature=None,
                                         asb_state_label=Mock(), asb_age_label=Mock(), asb_title_label=Mock(), asb_limit_clock=Mock(),
                                         add_css_class=Mock(), remove_css_class=Mock(), set_sensitive=Mock(),
                                         update_property=Mock(), update_state=Mock())
                window.update_row_text(widget, NOW)
                widget.asb_state_label.set_label.assert_called_with(state)
                if view == "comfortable":
                    widget.asb_age_label.set_label.assert_called_with("3d4h")
                self.assertEqual(widget.asb_accessible_label, "Open Chat in Codex. Idle. Usage limit. Resets in 3 days 4 hours.")

    def test_usage_limit_countdown_clock_colors_tooltip_and_accessible_text(self):
        row = {"id": "a", "provider": "codex", "providerLabel": "Codex", "title": "Chat", "state": "idle", "canOpen": True,
               "updatedAtMs": NOW - 600_000, "limitResetsAtMs": NOW + 3_600_000}
        left = lambda seconds: asb.limit_left({**row, "limitResetsAtMs": NOW + seconds * 1000}, NOW)
        # Rounded up, so a limited row never shows 0s; the format is the Working timer format.
        for seconds, text, spoken in ((3600, "1h0m", "1 hour"), (3599, "59m59s", "59 minutes 59 seconds"),
                                      (16_330, "4h32m", "4 hours 32 minutes"), (3661, "1h1m", "1 hour 1 minute"),
                                      (60, "1m0s", "1 minute"), (59, "59s", "59 seconds"), (1, "1s", "1 second"), (.2, "1s", "1 second")):
            self.assertEqual((asb.duration_text(left(seconds)), asb.spoken_duration(left(seconds))), (text, spoken))
        for reset in (NOW, NOW - 1, 0, None, True, "soon", float("nan"), float("inf")):
            self.assertEqual(asb.limit_left({**row, "limitResetsAtMs": reset}, NOW), 0)
        self.assertEqual(asb.limit_left({"state": "idle"}, NOW), 0)

        interval = asb.clock_interval
        self.assertEqual(interval([row], NOW - 1), 60)  # Over one hour.
        self.assertEqual(interval([row], NOW), 2)
        self.assertEqual(interval([row], NOW + 3_600_000), 60)  # At the reset.
        self.assertEqual(interval([{**row, "state": "working"}], NOW - 1), 2)
        self.assertEqual(interval([{**row, "state": "working", "archived": True}], NOW - 1), 60)

        # Dimmer than the quiet Idle-read text, and 4.5:1 on the background, in GNOME dark and light and in a custom theme.
        for palette, highlight in ((dict(background="#222226", text="#ffffff"), "#313135"),
                                   (dict(background="#fafafb", text="#323237"), "#f1f1f2"),
                                   (CUSTOM, asb.highlight_color(CUSTOM))):
            limited, fraction = asb.limited_color(palette)
            hover, _fraction = asb.quiet_color(palette, "text", 0, highlight)
            self.assertGreaterEqual(asb.contrast(limited, palette["background"]), 4.5)
            self.assertGreaterEqual(asb.contrast(hover, highlight), 4.5)
            for quiet in (asb.quiet_color(palette, "text", .67, highlight)[0],
                          asb.quiet_color(palette, "muted" if "muted" in palette else "text", .85 if "muted" in palette else .5, highlight)[0]):
                self.assertLess(asb.contrast(limited, palette["background"]), asb.contrast(quiet, palette["background"]))
            self.assertLess(fraction, 1)

        time = SCOPE["time"]
        # UTC as the local zone: NOW + 1 hour is on the same day, in every machine time zone.
        with patch.object(time, "localtime", time.gmtime):
            clock = time.strftime("%I:%M %p", time.localtime((NOW + 3_600_000) / 1000)).lstrip("0")
            model = asb.tooltip_model(row, NOW, "/home/test")
            self.assertEqual(model["limit"], f"Codex is out of usage. It resets at {clock}.")
            self.assertIn(model["limit"], asb.tooltip_description(model))
            self.assertEqual(asb.tooltip_model({**row, "sourceLabel": "Codex Personal"}, NOW, "/home/test")["limit"],
                             f"Codex Personal is out of usage. It resets at {clock}.")
        self.assertEqual(asb.tooltip_model(row, NOW + 3_600_000, "/home/test")["limit"], "")

        window = object.__new__(Window)
        window.opening, window.open_errors = set(), {}
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for view, state in (("comfortable", "Resets in"), ("compact", "Resets 4h32m")):
                window.view = view
                widget = SimpleNamespace(asb_thread={**row, "limitResetsAtMs": NOW + 16_330_000}, asb_time_signature=None,
                                         asb_state_label=Mock(), asb_age_label=Mock(), asb_title_label=Mock(), asb_limit_clock=Mock(),
                                         add_css_class=Mock(), remove_css_class=Mock(), set_sensitive=Mock(),
                                         update_property=Mock(), update_state=Mock())
                window.update_row_text(widget, NOW)
                widget.add_css_class.assert_called_once_with("asb-limited")
                widget.asb_limit_clock.set_visible.assert_called_once_with(True)
                widget.asb_state_label.set_label.assert_called_with(state)
                if view == "comfortable":
                    widget.asb_age_label.set_label.assert_called_with("4h32m")
                self.assertEqual(widget.asb_accessible_label, "Open Chat in Codex. Idle. Usage limit. Resets in 4 hours 32 minutes.")
                window.update_row_text(widget, NOW + 16_330_000)  # At the reset the row is a normal Idle row at once.
                widget.remove_css_class.assert_called_once_with("asb-limited")
                widget.asb_limit_clock.set_visible.assert_called_with(False)
                widget.asb_state_label.set_label.assert_called_with("Idle")
                if view == "comfortable":
                    widget.asb_age_label.set_label.assert_called_with("4h ago")
                self.assertEqual(widget.asb_accessible_label, "Open Chat in Codex. Idle.")

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
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact", "showAppPills": False})
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
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact", "showAppPills": False})

    def test_view_setting_legacy_width_save_and_reset(self):
        with TemporaryDirectory(prefix="asb-view-test-") as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps({"version": 1, "columnWidth": 180}))
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "compact", "showAppPills": False})
            asb.write_layout(path, 180, "comfortable")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "comfortable", "showAppPills": False})
            asb.write_layout(path, 320)
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable", "showAppPills": False})
            asb.write_layout(path)
            self.assertTrue(path.exists())
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable", "showAppPills": False})
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                asb.write_layout(path, 240, "unknown")
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            asb.write_layout(path, 240, "compact")
            asb.write_layout(path)
            self.assertFalse(path.exists())

    def test_app_pill_layout_boolean_and_setting_preservation(self):
        with TemporaryDirectory(prefix="asb-toolbar-layout-") as directory:
            path = Path(directory) / "layout.json"
            for invalid in (0, 1, "true", None, [], {}):
                path.write_text(json.dumps({"version": 1, "columnWidth": 240, "showAppPills": invalid}))
                with self.assertRaises(ValueError):
                    asb.read_layout(path)
            path.unlink()
            asb.write_layout(path, 180, "compact", True)
            self.assertTrue(asb.read_layout(path)["showAppPills"])
            asb.write_layout(path, 320, "comfortable")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable", "showAppPills": True})
            asb.write_layout(path)
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable", "showAppPills": True})
            asb.write_layout(path, 240, "compact", False)
            self.assertFalse(json.loads(path.read_text())["showAppPills"])
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                asb.write_layout(path, 240, "compact", "false")
            self.assertEqual(path.read_bytes(), before)
            window = object.__new__(Window)
            window.show_app_pills, window.column_width, window.view, window.layout_path = False, 180, "comfortable", path
            window.app_pills_setting = Mock(get_active=Mock(return_value=True))
            window.app_pills_error, window.layout_error = Mock(), Mock()
            window.update_toolbar_presentation, window.render = Mock(), Mock()
            window.apps, window.states = {"codex"}, {"waiting"}
            window.change_app_pills_setting()
            self.assertTrue(window.show_app_pills)
            self.assertTrue(asb.read_layout(path)["showAppPills"])
            self.assertEqual((window.apps, window.states), ({"codex"}, {"waiting"}))
            window.render.assert_not_called()
            window.app_pills_setting.get_active.return_value = False
            with patch.dict(SCOPE, {"write_layout": Mock(side_effect=OSError("Save failed"))}):
                window.change_app_pills_setting()
            self.assertTrue(window.show_app_pills)
            window.app_pills_setting.set_active.assert_called_once_with(True)
            window.app_pills_error.set_label.assert_called_with("Save failed")
            window.update_toolbar_presentation.assert_called_once_with()
            window.dragging = False
            window.width_control = Mock(set_value=Mock(side_effect=lambda width: setattr(window, "column_width", width)))
            window.reset_width()
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable", "showAppPills": True})
            window.save_width()
            self.assertTrue(asb.read_layout(path)["showAppPills"])

    def test_filter_chip_groups_clear_only_their_constraint(self):
        chips = asb.filter_chips
        self.assertEqual(chips(set(), set(asb.STATES), False), ())
        self.assertEqual(chips(set(asb.SOURCE_PROVIDERS), set(asb.STATES), False), ())
        self.assertEqual(chips({"codex"}, set(), True), (
            ("app", "Codex", "Clear app filter: Codex"),
            ("states", "No states", "Clear state filter: No states"),
            ("archive", "Include archived", "Hide archived sessions")))
        self.assertEqual(chips({"claude-desktop-code"}, {"idle", "working"}, False), (
            ("app", "Claude", "Clear app filter: Claude"),
            ("states", "Working, Idle", "Clear state filter: Working, Idle")))
        self.assertEqual(chips(set(), {"working"}, False), ())
        self.assertEqual(chips({"codex"}, set(asb.STATES), False, True), ())
        self.assertEqual(chips({"codex"}, set(asb.STATES), False), (("app", "Codex", "Clear app filter: Codex"),))
        self.assertEqual(chips(set(), {"waiting"}, False), (("states", "Waiting", "Clear state filter: Waiting"),))
        window = object.__new__(Window)
        window.apps, window.states = {"claude-desktop-code"}, {"working"}
        window.archive = SimpleNamespace(active=True, get_active=lambda: window.archive.active,
                                         set_active=lambda value: setattr(window.archive, "active", value))
        window.get_focus = lambda: None
        window.filter_chip_widgets = {key: (Mock(), Mock()) for key in ("app", "states", "archive")}
        window.select_apps = lambda values: setattr(window, "apps", values)
        window.select_states = lambda values: setattr(window, "states", values)
        board = {"threads": [dict(row, provider="codex") for row in (
            {"id": "work", "state": "working"}, {"id": "old", "state": "idle", "archived": True})]}
        self.assertEqual([row["id"] for row in asb.filtered_rows(board, "cx:", "claude-desktop-code", window.states, True)], ["work"])
        window.clear_filter_chip(None, "app")
        self.assertEqual((window.apps, window.states, window.archive.active), (set(), {"working"}, True))
        window.clear_filter_chip(None, "states")
        self.assertEqual((window.apps, window.states, window.archive.active), (set(), set(asb.STATES), True))
        window.clear_filter_chip(None, "archive")
        self.assertEqual((window.apps, window.states, window.archive.active), (set(), set(asb.STATES), False))

    def test_filter_chips_reuse_controls_and_keep_full_state_names(self):
        window = object.__new__(Window)
        window.apps, window.states = {"codex"}, {"working", "waiting", "unknown"}
        window.archive = Mock(get_active=Mock(return_value=True))
        window.filter_chip_group, window.filter_chip_signature = Mock(), None
        window.filter_chip_widgets = {key: (Mock(), Mock()) for key in ("app", "states", "archive")}
        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0))}):
            window.sync_filter_chips()
            chip, name = window.filter_chip_widgets["states"]
            name.set_label.assert_called_once_with("Working, Waiting, Unknown")
            chip.set_tooltip_text.assert_called_once_with("Clear state filter: Working, Waiting, Unknown")
            chip.update_property.assert_called_once_with([0], ["Clear state filter: Working, Waiting, Unknown"])
            window.sync_filter_chips()
            self.assertEqual(chip.set_tooltip_text.call_count, 1)
            window.states = set(asb.STATES)
            window.sync_filter_chips()
            chip.set_visible.assert_called_with(False)

    def test_show_app_pills_resyncs_chips_without_changing_filters(self):
        window = object.__new__(Window)
        window.show_app_pills, window.column_width, window.view, window.layout_path = False, 240, "compact", False
        window.apps, window.states = {"codex"}, {"waiting"}
        window.archive = Mock(get_active=Mock(return_value=True))
        window.app_pills_setting = Mock(get_active=Mock(return_value=True))
        window.app_pills_error, window.update_toolbar_presentation = Mock(), Mock()
        window.filter_chip_group, window.filter_chip_signature = Mock(), None
        window.filter_chip_widgets = {key: (Mock(), Mock()) for key in ("app", "states", "archive")}
        app_chip = window.filter_chip_widgets["app"][0]
        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0))}):
            window.sync_filter_chips()
            app_chip.set_visible.assert_called_with(True)
            window.change_app_pills_setting()
            app_chip.set_visible.assert_called_with(False)
            self.assertTrue(window.show_app_pills)
            self.assertEqual((window.apps, window.states, window.archive.get_active()), ({"codex"}, {"waiting"}, True))
            window.app_pills_setting.get_active.return_value = False
            window.change_app_pills_setting()
            app_chip.set_visible.assert_called_with(True)
            self.assertFalse(window.show_app_pills)
            self.assertEqual((window.apps, window.states, window.archive.get_active()), ({"codex"}, {"waiting"}, True))

    def test_narrow_escape_collapses_search_and_keeps_filters(self):
        window = object.__new__(Window)
        window.search_expanded, window.wide_controls, window.context_menu = True, False, None
        window.cancel_scroll, window.number_key_pressed = Mock(), Mock(return_value=None)
        window.search_popover, window.search_button = Mock(), Mock()
        window.apps, window.states = {"codex"}, {"waiting"}
        text = ["cl: example"]
        window.search = SimpleNamespace(get_text=lambda: text[0], set_text=lambda value: text.__setitem__(0, value),
                                        grab_focus=Mock(), set_position=Mock())
        window.get_focus = lambda: None
        window.present = Mock()
        with patch.dict(SCOPE, {"Gdk": SimpleNamespace(KEY_Escape=27, KEY_space=32, KEY_Return=13, KEY_KP_Enter=14,
                              keyval_to_unicode=lambda key: key), "SHORTCUT_MASK": 0,
                              "Gtk": SimpleNamespace(Editable=type("Editable", (), {}), TextView=type("TextView", (), {}))}):
            self.assertTrue(window.window_key(None, 27, 0, 0))
            self.assertEqual((text[0], window.search_expanded), ("", False))
            self.assertEqual((window.apps, window.states), ({"codex"}, {"waiting"}))
            window.search_popover.popdown.assert_called_once_with()
            self.assertTrue(window.window_key(None, ord("x"), 0, 0))
            self.assertEqual((text[0], window.search_expanded), ("x", True))
            window.search_popover.popup.assert_called_once_with()
            window.wide_controls = True
            window.clear_search()
            self.assertTrue(window.search_expanded)
            self.assertEqual(text[0], "")

    def test_chip_clear_restores_keyboard_focus_and_preferences_search_raises_main(self):
        window = object.__new__(Window)
        chips = {key: (Mock(), Mock()) for key in ("app", "states", "archive")}
        window.filter_chip_widgets, window.menu_button = chips, Mock()
        window.get_focus = lambda: chips["states"][0]
        for key, (button, _label) in chips.items():
            button.get_visible.return_value = key == "archive"
        window.select_states = Mock()
        window.clear_filter_chip(chips["states"][0], "states")
        window.select_states.assert_called_once_with(set(asb.STATES))
        chips["archive"][0].grab_focus.assert_called_once_with()
        chips["archive"][0].get_visible.return_value = False
        window.clear_filter_chip(chips["states"][0], "states")
        window.menu_button.grab_focus.assert_called_once_with()
        window.preferences_window, window.present, window.open_search = Mock(), Mock(), Mock()
        window.open_search_from_preferences()
        window.preferences_window.set_visible.assert_called_once_with(False)
        window.present.assert_called_once_with()
        window.open_search.assert_called_once_with()

    def test_toolbar_presentation_keeps_fixed_corners_and_reparents_only_on_mode_changes(self):
        class Control(Box):
            visible = True
            def prepend(self, child):
                self.insert(child, 0)
            def set_visible(self, value):
                self.visible = value
            def set_child(self, child):
                for old in tuple(self.children):
                    self.remove(old)
                if child:
                    self.append(child)
            def get_text(self):
                return ""
            set_icon_name = Mock()
            popdown = Mock()
        window = object.__new__(Window)
        window.toolbar_center, window.toolbar_end, window.search_popover = Control(), Control(), Control()
        window.search, window.search_button, window.app_mark, window.toolbar_scroll = Control(), Control(), Control(), Control()
        window.preferences_refresh_row, window.refresh_button, window.drawer_label = Control(), Control(), Control()
        window.menu_button, window.window_controls = Control(), Control()
        window.app_pills = {provider: Control() for provider in asb.SOURCE_PROVIDERS}
        window.app_pill_labels = {provider: Control() for provider in asb.SOURCE_PROVIDERS}
        window.app_pill_icons = {provider: Control() for provider in asb.SOURCE_PROVIDERS}
        window.toolbar_center.append(window.search_button)
        window.toolbar_center.append(window.toolbar_scroll)
        window.toolbar_end.append(window.menu_button)
        window.toolbar_end.append(window.window_controls)
        window.preferences_refresh_row.append(window.refresh_button)
        window.search_popover.set_child(window.search)
        window.get_focus = lambda: None
        window.show_app_pills = True
        window.update_toolbar_presentation()
        self.assertIs(window.search.get_parent(), window.search_popover)
        self.assertFalse(window.drawer_label.visible)
        self.assertTrue(window.search_button.visible)
        window.wide_controls = True
        window.update_toolbar_presentation()
        self.assertIs(window.search.get_parent(), window.toolbar_center)
        self.assertIs(window.refresh_button.get_parent(), window.toolbar_end)
        self.assertFalse(window.search_button.visible)
        self.assertTrue(window.drawer_label.visible)
        self.assertTrue(all(name.visible for name in window.app_pill_labels.values()))
        with patch.object(window.toolbar_center, "remove", wraps=window.toolbar_center.remove) as remove:
            window.update_toolbar_presentation()
            remove.assert_not_called()
        window.wide_controls, window.tiny_controls = False, True
        window.update_toolbar_presentation()
        self.assertFalse(window.app_mark.visible)
        self.assertFalse(window.search_button.visible)
        self.assertIs(window.search.get_parent(), window.search_popover)
        self.assertIs(window.menu_button.get_parent(), window.toolbar_end)
        self.assertIs(window.window_controls.get_parent(), window.toolbar_end)
        self.assertTrue(all(icon.visible for icon in window.app_pill_icons.values()))
        self.assertFalse(all(name.visible for name in window.app_pill_labels.values()))

    def test_toolbar_wheel_scroll_clamps_without_a_timer(self):
        window = object.__new__(Window)
        value = [0]
        adjustment = SimpleNamespace(get_value=lambda: value[0], get_upper=lambda: 240, get_page_size=lambda: 120,
                                     set_value=lambda position: value.__setitem__(0, position))
        window.toolbar_scroll = SimpleNamespace(get_hadjustment=lambda: adjustment)
        self.assertTrue(window.scroll_toolbar(None, 0, 1))
        self.assertEqual(value[0], 40)
        self.assertTrue(window.scroll_toolbar(None, 5, 0))
        self.assertEqual(value[0], 120)
        self.assertFalse(window.scroll_toolbar(None, 0, 1))
        self.assertTrue(window.scroll_toolbar(None, -8, 0))
        self.assertEqual(value[0], 0)

    def test_persistent_unread_missing_or_invalid_is_on_and_saved_false_stays_off(self):
        window = object.__new__(Window)
        window.unread_setting_loading, window.syncing_unread_setting = False, False
        window.persistent_unread = Mock()
        for value, expected in ((None, True), (0, True), ("false", True), (True, True), (False, False)):
            window.sync_unread_setting(value)
            window.persistent_unread.set_active.assert_called_with(expected)
        self.assertFalse(window.syncing_unread_setting)

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

    def test_hex_color_clamps_extended_theme_channels_to_rgb_bytes(self):
        for channels, expected in (((0, .5, 1), "#0080ff"),
                                   ((.5043112636, .8172299862, 1.2187165022), "#81d0ff"),
                                   ((-.1, 1.1, .25), "#00ff40")):
            with self.subTest(channels=channels):
                self.assertEqual(Window.hex_color(SimpleNamespace(red=channels[0], green=channels[1], blue=channels[2])), expected)

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

    def test_palette_payload_for_gnome_and_custom_colors(self):
        native = {"background": "#242424", "text": "#ffffff", "accent": "#78aeed", "muted": "#c8c8c8", "divider": "#5b5b5b"}
        self.assertEqual(asb.palette_payload(None, native, "#8ff0a4", "#f8e45c"),
                         {"mode": "gnome", "colors": {**native, "success": "#8ff0a4", "warning": "#f8e45c"}})
        self.assertEqual(asb.palette_payload(None, native)["colors"],
                         {**native, "success": "#78aeed", "warning": "#78aeed"})
        self.assertEqual(asb.palette_payload(CUSTOM, native, "#8ff0a4", "#f8e45c"),
                         {"mode": "custom", "colors": {**CUSTOM, "success": CUSTOM["accent"], "warning": CUSTOM["accent"]}})

    def test_palette_publish_sends_changes_once_and_retries_after_failure(self):
        import io
        window = object.__new__(Window)
        window.base, window.closed, window.hover_colors = "http://127.0.0.1:1", False, dict(CUSTOM)
        window.palette_sent = window.palette_wanted = None
        window.palette_sending = False
        sends = []
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(idle_add=Mock()), "request_async": lambda base, route, callback, dispatch, method, body:
                                sends.append((route, method, body, callback))}):
            window.publish_palette()
            window.publish_palette()
            self.assertEqual([(route, method) for route, method, *_ in sends], [("/api/palette", "POST")])
            window.hover_colors = {**CUSTOM, "accent": "#ffffff"}
            window.publish_palette()
            with patch("sys.stderr", io.StringIO()) as stderr:
                sends[0][3](None, "Cannot change this session.")
            self.assertIn("palette", stderr.getvalue())
            self.assertEqual(len(sends), 1)
            window.publish_palette()
            self.assertEqual(sends[1][2]["colors"]["accent"], "#ffffff")
            sends[1][3]({"changed": True}, None)
            window.publish_palette()
            self.assertEqual(len(sends), 2)
        token = "cd" * 32
        transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"changed": false}')))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
            self.assertEqual(asb.request_json("http://127.0.0.1:1", "/api/palette", "POST", sends[1][2]), {"changed": False})
        request = transport.open.call_args.args[0]
        self.assertEqual(request.get_header("X-asb-source-token"), token)
        self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:1")

    def test_local_url_and_unfocused_refresh(self):
        self.assertEqual(asb.local_base_url("http://127.0.0.1:4629/"), "http://127.0.0.1:4629")
        for value in ["https://example.com", "http://localhost:4629", "http://127.0.0.1:4629/api", "http://u:p@127.0.0.1:4629"]:
            with self.assertRaises(ValueError):
                asb.local_base_url(value)
        calls = []
        sidebar = SimpleNamespace(closed=False, is_active=lambda: False, refresh=lambda: calls.append(True), report_ui=Mock())
        self.assertTrue(asb.SwitchboardWindow.tick(sidebar))
        self.assertEqual(calls, [True])
        sidebar.closed = True
        self.assertFalse(asb.SwitchboardWindow.tick(sidebar))
        self.assertEqual(calls, [True])


class MessageChecks(unittest.TestCase):
    def test_flight_duration_bow_tail_and_edges(self):
        self.assertEqual((asb.message_duration(100), asb.message_duration(1050), asb.message_duration(3000)), (480, 700, 900))
        self.assertEqual(asb.message_control((0, 100), (100, 100)), (50, 78))
        self.assertEqual(asb.message_control((100, 100), (0, 100)), (50, 78))
        x, y = asb.message_control((0, 0), (1000, 0))
        self.assertEqual((x, round(y, 6)), (500, -60))
        self.assertEqual(asb.message_control((50, 0), (50, 100)), (28, 50))
        self.assertEqual(asb.message_control((50, 100), (50, 0)), (28, 50))
        self.assertEqual(asb.message_control((5, 0), (5, 1000)), (2, 500))
        x, y = asb.message_control((0, 0), (100, 80))
        self.assertLess(y, 40)
        self.assertGreater(x, 50)
        self.assertEqual(asb.message_control((7, 7), (7, 7)), (7, 7))
        start, control, end = (0, 0), (50, -40), (100, 0)
        self.assertEqual(asb.bezier_point(start, control, end, 0), start)
        self.assertEqual(asb.bezier_point(start, control, end, 1), end)
        self.assertEqual(asb.bezier_point(start, control, end, .5), (50, -20))
        ease = asb.ease_in_out_cubic
        self.assertEqual((ease(0), ease(.25), ease(.5), ease(.75), ease(1)), (0, .0625, .5, .9375, 1))
        tail = asb.message_tail(.5)
        self.assertEqual(len(tail), 8)
        for k, (first, last, width, alpha) in enumerate(tail, 1):
            self.assertAlmostEqual(first, ease(.5 - (k - 1) * .025))
            self.assertAlmostEqual(last, ease(.5 - k * .025))
            self.assertAlmostEqual(width, 3.2 * (1 - k / 9))
            self.assertAlmostEqual(alpha, .7 * (1 - k / 9))
        short = asb.message_tail(.06)
        self.assertEqual(len(short), 3)
        self.assertEqual(short[-1][1], 0)
        self.assertEqual(asb.message_tail(0), [])
        # The tail stretches with speed: short at the slow start and end, long in the fast middle.
        length = lambda t: asb.message_tail(t)[0][0] - asb.message_tail(t)[-1][1]
        self.assertAlmostEqual(length(.5), ease(.5) - ease(.3))
        self.assertGreater(length(.5), .35)
        self.assertLess(length(.2), .1)
        self.assertLess(length(1), .1)
        self.assertEqual(asb.message_tail(1)[0][0], 1)
        self.assertEqual([asb.message_edge(x, 100, 400) for x in (50, 100, 250, 400, 450)], [102, 100, 250, 400, 398])
        self.assertEqual([asb.edge_alpha(ms) for ms in (0, 60, 120, 300, 420, 570, 720, 800)], [0, .5, 1, 1, 1, .5, 0, 0])

    def test_new_messages_first_seen_age_visibility_pairs_and_cap(self):
        select = asb.new_messages
        now = 1_000_000
        visible = {"a": 1, "b": 1, "c": 1}
        message = lambda source, target, at=now - 1000: {"from": source, "to": target, "atMs": at}
        play, seen = select([message("a", "b")], None, visible, now, 6)
        self.assertEqual((play, seen), ([], {("a", "b", now - 1000)}))
        play, seen = select([message("a", "b"), message("b", "a", now - 500)], seen, visible, now, 6)
        self.assertEqual(play, [("b", "a", now - 500)])
        self.assertEqual(seen, {("a", "b", now - 1000), ("b", "a", now - 500)})
        play, seen = select([message("b", "a", now - 500)], seen, visible, now, 6)
        self.assertEqual((play, seen), ([], {("b", "a", now - 500)}))
        play, _seen = select([message("a", "c", now - 30_000), message("a", "b", now - 30_001)], set(), visible, now, 6)
        self.assertEqual(play, [("a", "c", now - 30_000)])
        play, seen = select([message("a", "hidden"), message("hidden", "a"), message("a", "a")], set(), visible, now, 6)
        self.assertEqual((play, len(seen)), ([], 3))
        play, _seen = select([message("a", "b", now - 3), message("a", "b", now - 2), message("b", "a", now - 1)], set(), visible, now, 6)
        self.assertEqual(play, [("a", "b", now - 3), ("b", "a", now - 1)])
        many = {str(index): 1 for index in range(9)}
        messages = [message(str(index), str(index + 1)) for index in range(8)]
        play, seen = select(messages, set(), many, now, 6)
        self.assertEqual((len(play), len(seen)), (6, 8))
        play, seen = select(messages, set(), many, now, 2)
        self.assertEqual((len(play), len(seen)), (2, 8))
        play, seen = select([None, {"from": "a"}, {"from": "a", "to": "b", "atMs": "1"}], set(), visible, now, 6)
        self.assertEqual((play, seen), ([], set()))
        self.assertEqual(select(None, set(), visible, now, 6), ([], set()))

    def test_dashboards_keep_message_state_apart_from_the_dashboard(self):
        window = object.__new__(Window)
        window.list_body = SimpleNamespace(flights=[], add_tick_callback=Mock())
        window.focus_widgets = {"a": 1, "b": 1}
        at = SCOPE["time"].time() * 1000
        window.play_messages([{"from": "a", "to": "b", "atMs": at}])
        window.list_body.add_tick_callback.assert_not_called()
        window.play_messages([{"from": "a", "to": "b", "atMs": at}, {"from": "b", "to": "a", "atMs": at}])
        window.list_body.add_tick_callback.assert_called_once_with(window.messages_after_layout, [("b", "a", at)])
        window.list_body.flights = [None] * 6
        window.play_messages([{"from": "a", "to": "b", "atMs": at + 1}])
        self.assertEqual(window.list_body.add_tick_callback.call_count, 1)
        window.play_messages([])
        self.assertEqual(window.message_seen, set())


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
        window = object.__new__(SourcesEditor)
        builtin = {"id": "codex", "provider": "codex", "builtin": True, "dataDir": "/default"}
        personal = {"id": "codex-personal", "provider": "codex", "builtin": False}
        window.closed = window.loading = window.choosing = False
        window.loaded = window.editing = True
        window.base, window.sources, window.max_sources, window.editing_id = "http://127.0.0.1:1", [builtin, personal], 8, personal["id"]
        window.owner = SimpleNamespace(closed=False, refresh=Mock(),
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
            window.close()
            self.assertTrue(window.closed)
            window.cancellable.cancel.assert_called_once()
            window.render_sources.reset_mock()
            self.assertFalse(callback({"sources": []}, None))
            window.render_sources.assert_not_called()
            self.assertEqual(window.owner.refresh.call_count, 2)
            request.reset_mock()
            window.reload_sources()
            request.assert_not_called()

    def test_preferences_reuses_profile_editor_and_cancels_dialog_callbacks(self):
        owner = object.__new__(Window)
        owner.closed = False
        preferences = object.__new__(Preferences)
        preferences.owner, preferences.closed, preferences.profiles_editor, preferences.phone_editor = owner, False, None, None
        preferences.get_visible = Mock(return_value=True)
        preferences.get_mapped = Mock(return_value=True)
        preferences.stack = Mock(get_visible_child_name=Mock(return_value="sessions"))
        preferences.profiles, preferences.present, preferences.set_visible, preferences.destroy = Mock(), Mock(), Mock(), Mock()
        owner.preferences_window = preferences
        editor = SimpleNamespace(cancel_dialogs=Mock(), close=Mock(), set_active=Mock())
        with patch.dict(SCOPE, {"AppSourcesEditor": Mock(return_value=editor),
                               "Gtk": SimpleNamespace(Window=SimpleNamespace(list_toplevels=lambda: []))}):
            owner.open_preferences()
            owner.open_preferences()
            self.assertEqual(preferences.present.call_count, 2)
            preferences.section_changed()
            SCOPE["AppSourcesEditor"].assert_not_called()
            preferences.stack.get_visible_child_name.return_value = "profiles"
            preferences.section_changed()
            preferences.section_changed()
            SCOPE["AppSourcesEditor"].assert_called_once_with(owner, preferences)
            preferences.profiles.append.assert_called_once_with(editor)
            self.assertTrue(preferences.on_close())
            preferences.set_visible.assert_called_with(False)
            self.assertFalse(owner.closed)
            self.assertFalse(preferences.closed)
            preferences.section_changed()
            SCOPE["AppSourcesEditor"].assert_called_once()
            preferences.dispose()
            self.assertTrue(preferences.closed)
            editor.close.assert_called_once()
            preferences.destroy.assert_called_once()

        source = object.__new__(SourcesEditor)
        source.closed = source.loading = source.choosing = False
        source.owner, source.preferences = SimpleNamespace(closed=False), object()
        source.update_controls, source.message = Mock(), Mock()
        source.cancellable = Mock(is_cancelled=Mock(return_value=False))
        entry = Mock(get_text=Mock(return_value="/example/profile"))
        dialog = Mock()
        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(FileDialog=Mock(return_value=dialog))}):
            source.choose_path(entry, True)
            dialog.select_folder.assert_called_once()
            parent, cancellable, callback = dialog.select_folder.call_args.args
            self.assertIs(parent, source.preferences)
            self.assertIs(cancellable, source.cancellable)
            source.cancel_dialogs()
            cancellable.is_cancelled.return_value = True
            callback(dialog, object())
            dialog.select_folder_finish.assert_not_called()
            entry.set_text.assert_not_called()
            self.assertFalse(source.choosing)

    def test_source_editor_reload_keeps_the_saved_picker_color_and_dot_setting(self):
        window = object.__new__(SourcesEditor)
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
        window.preferences_window = None
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

    def test_row_panel_controls_note_and_edges_follow_the_menu_rules(self):
        controls, note, edge = SCOPE["row_panel_controls"], SCOPE["row_panel_note"], SCOPE["edge_color"]
        contrast = SCOPE["contrast"]
        idle = {"state": "idle", "unread": True, "pinned": True, "pendingSource": "observed-completion"}
        self.assertEqual(controls(idle), {"unread": (True, "mark-read"), "drawer": (False, "drawer-in"),
                                          "pinned": (True, "unpin"), "order": (True, "pin-up")})
        self.assertEqual(note(idle), "Finished. Not read yet.")
        self.assertEqual(note({**idle, "manualUnread": True}), "Marked unread.")
        working = {"state": "working"}
        self.assertEqual(controls(working), {"unread": (False, "mark-unread"), "drawer": (False, None),
                                             "pinned": (False, "pin"), "discard": (False, "discard-result")})
        self.assertEqual(controls({**working, "discardResult": True})["discard"], (True, "keep-result"))
        self.assertEqual(note({**working, "unread": True}), "")
        drawer = {"state": "idle", "drawer": True}
        self.assertEqual(controls(drawer)["unread"], (True, "mark-read"))
        self.assertEqual(controls(drawer)["drawer"], (True, "drawer-out"))
        self.assertEqual(note(drawer), "Finished. Not read yet.")
        waiting = {"state": "waiting", "actionRequired": True, "questionAttention": True}
        self.assertEqual(controls(waiting)["unread"], (True, None))
        self.assertEqual(controls(waiting)["drawer"], (False, None))
        self.assertEqual(note(waiting), "Waits for your permission.")
        self.assertEqual(note({"state": "idle", "questionAttention": True}), "Asks a question.")
        self.assertEqual(note({"state": "idle"}), "")
        for row in (idle, working, drawer, waiting):
            offered = {action for _title, action in SCOPE["row_menu_actions"](row)}
            self.assertEqual({action for _on, action in controls(row).values() if action} - {"pin-up"}, offered - {"pin-up", "pin-down"})
        self.assertEqual(edge("#0f0f0f", "#ffb900", .7, ("#000000", "#0f0f0f")), "#b78605")
        dim = edge("#171c22", "#f0f2f5", .36, ("#171c22",))
        self.assertGreaterEqual(contrast(dim, "#171c22"), 3)
        self.assertEqual(edge("#000000", "#101010", .5, ("#000000",)), "#101010")

    def test_panel_place_keeps_the_centered_panel_inside_the_window(self):
        place = SCOPE["panel_place"]
        # Room everywhere: the pointer stays.
        self.assertEqual(place(200, 100, 302, 400, 962, 900), (200, 100, "bottom"))
        # Near the left and right edges the center moves in by half the width plus the margin.
        self.assertEqual(place(20, 100, 302, 400, 420, 900), (157, 100, "bottom"))
        self.assertEqual(place(410, 100, 302, 400, 420, 900), (263, 100, "bottom"))
        # A window narrower than the panel centers it.
        self.assertEqual(place(20, 100, 302, 400, 300, 900)[0], 150)
        # No room below, more room above: the panel opens upward.
        self.assertEqual(place(200, 420, 302, 300, 962, 470), (200, 420, "top"))
        # No room either way: the panel moves to stay in the window on the larger side.
        self.assertEqual(place(200, 300, 302, 400, 962, 470), (200, 406, "top"))
        self.assertEqual(place(200, 100, 302, 400, 962, 470), (200, 64, "bottom"))

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
        window.state_summary, window.render = Mock(), Mock()
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
        strip.hover_rect = strip.hover_target = strip.hover_from = strip.hover_to = None
        strip.hover_alpha = 0
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
        strip.queue_draw.reset_mock()
        strip.hover_animation.reset.reset_mock()
        strip.clear_hover()
        for _frame in range(20):
            strip.clear_hover()
        strip.queue_draw.assert_called_once_with()
        strip.hover_animation.reset.assert_called_once_with()
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

    def test_scroll_does_not_restart_hover_paint_for_a_stationary_pointer(self):
        window = object.__new__(Window)
        window.view, window.closed, window.dragging = "comfortable", False, False
        window.scroll_target, window.scroll_updating = None, False
        window.list_body, window.queue_number_keys = Mock(), Mock()
        window.list_body.pick.return_value = None
        window.cancel_scroll = Mock()
        position = [True, 100, 200]
        controller = SimpleNamespace(get_current_event=lambda: SimpleNamespace(get_position=lambda: position))
        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(PickFlags=SimpleNamespace(DEFAULT=0))}):
            window.hover_motion(controller, 100, 200)
            window.list_body.pick.assert_called_once()
            window.list_body.reset_mock()
            for frame in range(20):
                window.scroll_updating = True
                window.scroll_position_changed()
                window.scroll_updating = False
                window.hover_motion(controller, 100 + frame, 200)
            window.list_body.pick.assert_not_called()
            window.list_body.show_hover.assert_not_called()
            window.cancel_scroll.assert_not_called()
            window.hover_motion(None, 150, 200)
            window.list_body.pick.assert_not_called()
            position[1] += 1  # A real pointer move restores the normal hover path.
            window.hover_motion(controller, 151, 200)
            window.list_body.pick.assert_called_once()
            window.list_body.show_hover.assert_called_once_with(None)
            window.scroll_target = 300
            position[1] += 1
            window.hover_motion(controller, 152, 200)
            self.assertEqual(window.list_body.pick.call_count, 1)

    def test_wheel_scroll_retargets_clamps_and_yields_to_native_input(self):
        window = object.__new__(Window)
        window.closed, window.scroll_target = False, None
        window.scroll_direction, window.scroll_updating = 0, False
        window.list_body, window.refresh, window.render = Mock(), Mock(), Mock()
        window.queue_number_keys = Mock()
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
        animation = window.scroll_animation = Mock(get_velocity=Mock(return_value=0))
        animation.reset.side_effect = lambda: window.advance_scroll(animation.set_value_from.call_args.args[0])
        wheel, surface = SimpleNamespace(get_unit=lambda: 0), SimpleNamespace(get_unit=lambda: 1)
        def spring():
            return tuple(getattr(animation, name).call_args.args[0] for name in ("set_value_from", "set_value_to", "set_initial_velocity"))
        with patch.dict(SCOPE, {"Gdk": SimpleNamespace(ScrollUnit=SimpleNamespace(WHEEL=0, SURFACE=1))}):
            animation.get_velocity.return_value = 900  # A stopped spring gives no start speed.
            window.scroll_horizontal(wheel, 0, 1)
            self.assertEqual((adjustment.value, window.scroll_target), (10, 42))
            self.assertEqual(spring(), (10, 42, 0))
            self.assertAlmostEqual(animation.set_epsilon.call_args.args[0] * 32, .05)
            window.advance_scroll(21.84)
            self.assertAlmostEqual(adjustment.value, 21.84)
            self.assertEqual(window.scroll_target, 42)
            animation.get_velocity.return_value = 300
            window.scroll_horizontal(wheel, 1, -5)  # Shift/horizontal input keeps its X mapping.
            self.assertEqual(spring(), (21.84, 74, 300))  # Same direction: new target, same speed.
            window.advance_scroll(48)
            current = adjustment.value
            window.scroll_horizontal(wheel, 0, -.5)
            self.assertEqual(spring(), (current, current - 16, 300))  # Reversal: the speed turns round in the spring.
            self.assertEqual(window.scroll_target, current - 16)
            window.advance_scroll(current - 8)
            self.assertLess(adjustment.value, current)
            animation.get_velocity.return_value = 5000
            window.scroll_horizontal(wheel, 100, 0)
            self.assertEqual(window.scroll_target, 110)
            self.assertEqual(spring(), (40, 110, 1400))  # More than 20/s times the distance would pass the target.
            animation.get_velocity.return_value = -5000
            window.scroll_horizontal(wheel, -1, 0)
            self.assertEqual(spring(), (40, 10, -600))
            window.scroll_horizontal(wheel, 100, 0)
            window.advance_scroll(110)
            self.assertEqual(adjustment.value, 110)
            self.assertIsNone(window.scroll_target)
            animation.play.reset_mock()
            window.scroll_horizontal(wheel, 1, 0)
            window.scroll_horizontal(wheel, 0, 0)
            animation.play.assert_not_called()
            adjustment.value = 109.7  # Less than half a pixel from the end: no spring.
            window.scroll_horizontal(wheel, 1, 0)
            self.assertEqual((adjustment.value, window.scroll_target), (110, None))
            animation.play.assert_not_called()
            window.scroll_horizontal(wheel, -100, 0)
            self.assertEqual(window.scroll_target, 10)
            window.advance_scroll(10)
            self.assertEqual(adjustment.value, 10)
            self.assertIsNone(window.scroll_target)

            window.scroll_horizontal(wheel, 0, 1)
            window.advance_scroll(26)
            current = adjustment.value
            animation.play.reset_mock()
            window.scroll_horizontal(surface, .75, 8)
            self.assertEqual(adjustment.value, current + .75)
            self.assertIsNone(window.scroll_target)
            window.advance_scroll(42)
            self.assertEqual(adjustment.value, current + .75)
            animation.play.assert_not_called()
            window.scroll_horizontal(surface, 0, 1.25)
            self.assertEqual(adjustment.value, current + 2)

            window.scroll_horizontal(wheel, 0, 1)
            window.advance_scroll(50)
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
            window.advance_scroll(60)
            self.assertEqual(adjustment.value, 25.5)

            window.scroll_horizontal(wheel, 0, 1)
            window.cancel_scroll(adjustment)  # GtkAdjustment bounds changes and unmap.
            window.advance_scroll(73.5)
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
            window.advance_scroll(58)
            window.scroll_horizontal(wheel, 0, 1)
            self.assertEqual(adjustment.value, 10)

    def test_card_motion_decision_offsets_and_progress(self):
        before = (("a", "b"), 4, 20, 239, "compact", True)
        allowed = asb.motion_allowed
        self.assertTrue(allowed(before, (("b", "a"), 4, 20, 239, "compact", True), True, True))
        self.assertTrue(allowed(before, ((), 4, 20, 239, "compact", False), True, True))  # Filters change only the IDs.
        self.assertFalse(allowed(None, before, True, True))  # First render.
        self.assertFalse(allowed(before, before, False, True))  # GNOME animations off.
        self.assertFalse(allowed(before, before, True, False))  # Not mapped.
        for index, value in ((1, 5), (2, 21), (3, 240), (4, "comfortable")):
            changed = list(before)
            changed[index] = value
            self.assertFalse(allowed(before, tuple(changed), True, True))
        old = {"stay": (4, 0, 0), "down": (4, 22, 0), "across": (4, 418, 0), "flight": (130.5, 44, .25), "gone": (4, 66, 0)}
        new = {"stay": (4, 0, 0), "down": (4, 110, 0), "across": (255, 0, 0), "flight": (255, 22, 0), "new": (4, 22, 0)}
        self.assertEqual(asb.motion_offsets(old, new), {"down": (0, -88, 0), "across": (-251, 418, 0),
                                                       "flight": (-124.5, 22, .25), "new": (0, 0, 1)})
        self.assertEqual(asb.motion_offsets({}, {}), {})

        class Row:
            def __init__(self, x, y):
                self.place, self.draws = SimpleNamespace(origin=SimpleNamespace(x=x, y=y)), 0
            def compute_bounds(self, _target):
                return True, self.place
            def queue_draw(self):
                self.draws += 1
        window = object.__new__(Window)
        window.scroll, window.closed = object(), False
        window.list_body = SimpleNamespace(motion={"down": (0, -88, 0), "new": (0, 0, 1)}, motion_progress=.5)
        window.focus_widgets = {"stay": Row(4, 0), "down": Row(4, 110), "new": Row(4, 22)}
        self.assertEqual(window.painted_places(), {"stay": (4, 0, 0), "down": (4, 66, 0), "new": (4, 22, .5)})
        column = Row(0, 0)
        window.motion_columns = [column]
        window.advance_motion(.25)
        self.assertEqual((window.list_body.motion_progress, column.draws, len(window.list_body.motion)), (.25, 1, 2))
        window.advance_motion(0)
        self.assertEqual((window.list_body.motion, window.motion_columns, column.draws), ({}, [], 2))
        offscreen = Row(0, 0)
        adjustment = SimpleNamespace(value=0, get_value=lambda: adjustment.value)
        window.scroll = SimpleNamespace(get_hadjustment=lambda: adjustment, get_width=lambda: 240, get_height=lambda: 400)
        window.motion_columns = [column, offscreen]
        window.motion_bounds = {column: (4, 244, 0, 400), offscreen: (508, 748, 0, 400)}
        window.advance_motion(.75)
        self.assertEqual((column.draws, offscreen.draws), (3, 0))
        adjustment.value = 508  # Scrolling exposes the other column during the same animation.
        window.advance_motion(.5)
        self.assertEqual((column.draws, offscreen.draws), (3, 1))
        window.advance_motion(0)
        self.assertEqual((window.motion_columns, window.motion_bounds), ([], {}))
        window.motion_from = False  # A layout without motion is pending.
        window.start_motion()
        self.assertIsNone(window.motion_from)
        window.motion_from = {}
        window.cancel_motion()
        self.assertIsNone(window.motion_from)

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
        self.assertEqual(source.count("SOURCE_TOKEN"), 5)

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
        window.dashboard, window.closed, window.clock_interval = board, False, 2
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
        # The repack moved the focused row, so render keeps the focus on it before GTK can move it.
        window.set_focus.assert_called_once_with(widgets["a"])
        window.set_focus.reset_mock()
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
        window.search_popover, window.search_button = Mock(), Mock()
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
        window.session_actions = set()
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
        window.dashboard = {"threads": [{"id": "a", "state": "idle", "updatedAtMs": 20},
                                        {"id": "b", "state": "idle", "updatedAtMs": 10}]}
        window.closed, window.layout_signature, window.focused_id = False, None, None
        window.context_menu, window.cancel_scroll = Mock(asb_identity="a"), Mock()
        window.update_row_panel = Mock()
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
            # The open panel of row "a" stays open when the row moves, and shows the new row data.
            window.context_menu.get_parent.return_value = widgets["a"]
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
            window.update_row_panel.assert_called_with(window.context_menu, widgets["a"].asb_thread)
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

    def test_drawer_roundtrip_reuses_all_columns_and_unchanged_controls(self):
        for view, height in (("compact", 22), ("comfortable", 68)):
            with self.subTest(view=view):
                operations = {"columns": 0, "remove": 0, "insert": 0}
                disconnected = []
                class Listing(Box):
                    def __init__(self, **kwargs):
                        operations["columns"] += 1
                        super().__init__(**kwargs)
                    def remove(self, child):
                        operations["remove"] += 1
                        super().remove(child)
                    def insert(self, child, position):
                        operations["insert"] += 1
                        super().insert(child, position)
                    def disconnect(self, handler):
                        self_test.assertIsNone(self.get_parent())
                        self_test.assertIsNone(self.get_first_child())
                        disconnected.append((self, handler))
                self_test = self
                window = object.__new__(Window)
                window.dashboard = {"threads": [{"id": f"s{index}", "title": f"Session {index}", "provider": "codex",
                                                  "providerLabel": "Codex", "state": "idle", "canOpen": True,
                                                  "drawer": index < 5} for index in range(120)]}
                window.closed, window.layout_signature, window.context_menu, window.focused_id = False, None, None, None
                window.focus_generation, window.view, window.row_height = 0, view, height
                window.geometry, window.column_width = (500, height * 3 + 4), 240
                window.focus_key = window.get_focus = lambda: None
                window.focus_widgets, window.row_cache, window.open_errors = {}, {}, {}
                window.opening, window.session_actions = set(), set()
                window.list_body, window.count = Box(), Box()
                window.drawer_only, window.drawer_dot = Mock(), Mock()
                window.scroll = SimpleNamespace(get_hadjustment=lambda: SimpleNamespace(get_value=lambda: 0))
                window.visible_rows = lambda: [row for row in window.dashboard["threads"] if not window.drawer_view or row["drawer"]]
                controls = []
                def create(row):
                    widget = Box()
                    widget.asb_view, widget.asb_thread = view, {}
                    widget.asb_read_timer, widget.asb_read_generation, widget.asb_time_signature = None, 0, None
                    widget.asb_handlers = []
                    widget.asb_focus_key = row["id"]
                    for name in ("asb_mark", "asb_source_badge", "asb_dot", "asb_state_label", "asb_title_label",
                                 "asb_folder", "asb_age_label", "asb_read_button", "asb_pin_button", "asb_drawer_button",
                                 "set_activatable", "set_sensitive", "update_property", "update_state", "remove_css_class"):
                        control = Mock()
                        setattr(widget, name, control)
                        controls.append(control)
                    window.update_session_row(widget, row)
                    return widget
                window.session_row = Mock(side_effect=create)
                gtk = SimpleNamespace(ListBox=Listing, SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0),
                                      AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                                      AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
                with patch.dict(SCOPE, {"Gtk": gtk, "GLib": SimpleNamespace(idle_add=Mock(), source_remove=Mock()),
                                       "label": lambda *_args: Mock()}):
                    window.render()
                    columns, widgets = list(window.list_body.children), dict(window.focus_widgets)
                    self.assertEqual((window.capacity, len(columns), operations["columns"]), (3, 40, 40))
                    window.drawer_view = True
                    window.render()
                    self.assertEqual(window.list_body.children, columns[:2])
                    self.assertEqual(len(window.row_cache), 120)
                    self.assertEqual(window.list_columns, columns)
                    self.assertEqual(disconnected, [])
                    for key in operations:
                        operations[key] = 0
                    for control in controls:
                        control.reset_mock()
                    window.drawer_view = False
                    window.render()
                    self.assertEqual(window.list_body.children, columns)
                    self.assertEqual(window.focus_widgets, widgets)
                    self.assertEqual(window.session_row.call_count, 120)
                    self.assertEqual(operations, {"columns": 0, "remove": 0, "insert": 115})
                    self.assertEqual(sum(len(control.mock_calls) for control in controls), 5)  # Only the five peek classes change.
                    self.assertEqual([[row.asb_thread["id"] for row in column.children] for column in columns],
                                     [[f"s{index}" for index in range(start, start + 3)] for start in range(0, 120, 3)])
                    window.geometry = (800, height * 3 + 4)
                    window.render()
                    self.assertEqual(window.list_body.children, columns)
                    self.assertTrue(all(column.size_request == (window.column_pixel_width, -1) for column in columns))
                    window.drawer_view = True
                    window.render()
                    window.dashboard["threads"] = window.dashboard["threads"][:15]
                    window.render()  # The filtered set is unchanged, but the full dashboard lost IDs.
                    self.assertEqual(window.list_columns, columns[:5])
                    self.assertEqual(len(disconnected), 35)
                    window.drawer_view = False
                    window.render()
                    self.assertEqual(window.list_body.children, columns[:5])
                    window.geometry = (800, height * 6 + 4)
                    window.render()
                    self.assertEqual((window.capacity, window.list_columns), (6, columns[:3]))
                    self.assertEqual(len(disconnected), 37)
                    window.dashboard["threads"] = window.dashboard["threads"][:3]
                    window.render()
                    self.assertEqual(window.list_columns, columns[:1])
                    self.assertEqual((len(disconnected), len(window.row_cache)), (39, 3))
                    window.dashboard["threads"] = []
                    window.render()
                    self.assertEqual((window.list_columns, window.row_cache), ([], {}))
                    self.assertEqual(len(disconnected), 40)

    def test_drawer_peek_changes_only_drawer_rows_and_keeps_the_selected_view_lit(self):
        window = object.__new__(Window)
        window.focus_widgets = {str(index): SimpleNamespace(asb_thread={"drawer": index < 5},
                                add_css_class=Mock(), remove_css_class=Mock()) for index in range(120)}
        window.add_css_class, window.remove_css_class = Mock(), Mock()
        window.set_drawer_peek(True)
        window.set_drawer_peek(True)
        self.assertEqual(sum(row.add_css_class.call_count for row in window.focus_widgets.values()), 5)
        window.drawer_view = True
        window.set_drawer_peek(False)
        self.assertFalse(any(row.remove_css_class.called for row in window.focus_widgets.values()))
        window.drawer_view = False
        window.set_drawer_peek(False)
        self.assertEqual(sum(row.remove_css_class.call_count for row in window.focus_widgets.values()), 5)
        window.add_css_class.assert_not_called()
        window.remove_css_class.assert_not_called()

    def test_successful_session_action_queues_a_normal_read_after_an_older_read(self):
        window = object.__new__(Window)
        window.preferences_window = None
        window.closed, window.loading, window.refresh_queued, window.refresh_force_queued = False, True, False, False
        window.session_actions, window.focus_widgets = set(), {}
        window.open_errors = {}
        row = {"id": "a", "provider": "codex", "state": "idle"}
        window.dashboard, window.dashboard_etag, window.signature = {"threads": [row]}, "old", [row]
        window.base, window.refresh_interval_ms, window.clock_interval, window.snapshot_pending = "http://127.0.0.1:1", 5000, 60, False
        window.get_focus = window.focus_key = lambda: None
        window.render = window.sync_unread_setting = window.set_notice = window.update_clock = Mock()
        window.refresh_button = Mock()
        request, dispatch = Mock(), Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=dispatch)}):
            window.session_action("a", "pin")
            request.call_args.args[2]({"thread": dict(row, pinned=True)}, None)
            self.assertEqual((window.refresh_queued, window.refresh_force_queued, window.dashboard_etag), (True, False, None))
            window.apply_dashboard({"threads": [row]}, None)
            callback, *args = dispatch.call_args.args
            self.assertEqual((callback, args), (window.refresh, [False]))
            callback(*args)
            self.assertEqual(request.call_args.args[1], "/api/dashboard")
            self.assertEqual(request.call_count, 2)
            self.assertEqual(window.refresh_button.mock_calls, [])

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
        window.preferences_window = None
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
        window.theme_error, window.set_palette, window.publish_palette = Mock(), Mock(), Mock()
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
                window.publish_palette.assert_called()
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
        window.closed, window.focus_widgets = False, {"a": SimpleNamespace(asb_thread={"state": "idle"})}
        window.dashboard, window.clock_interval = {"threads": []}, 60
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
        window.restore_position("a", 12, focus_generation=1)
        window.set_focus.assert_called_with(row)
        window.reveal_row, window.list_body = Mock(), Mock()
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

    def test_drawer_filter_indicator_menu_tooltip_and_action_flow(self):
        filtered, indicator, actions = SCOPE["filtered_rows"], SCOPE["attention_indicator"], SCOPE["row_menu_actions"]
        base = {"provider": "codex", "state": "idle", "title": "Chat", "providerLabel": "Codex", "canOpen": True}
        unread = {**base, "id": "unread", "unread": True, "pending": True, "updatedAtMs": 4}
        tucked = {**base, "id": "tucked", "drawer": True, "unread": False, "completionAttention": True,
                  "pendingSource": "observed-completion", "updatedAtMs": 3}
        board = {"threads": [unread, tucked, {**tucked, "id": "claude", "provider": "claude-desktop-code", "title": "Find"},
                             {**tucked, "id": "old", "archived": True}, {**base, "id": "read", "updatedAtMs": 1}]}
        ids = lambda *args, **kwargs: [row["id"] for row in filtered(board, *args, **kwargs)]
        self.assertEqual(ids(), ["unread", "claude", "tucked", "read"])  # A drawer row sorts with the read rows.
        self.assertEqual(ids(drawer_only=True), ["claude", "tucked"])
        self.assertEqual(ids(drawer_only=True, archived=True), ["claude", "old", "tucked"])
        self.assertEqual(ids("find", drawer_only=True), ["claude"])
        self.assertEqual(ids(app="codex", drawer_only=True), ["tucked"])
        self.assertEqual(ids("cl:", app="codex", drawer_only=True), ["claude"])
        self.assertEqual(ids(state={"working"}, drawer_only=True), [])
        self.assertEqual(ids(state={"idle"}, drawer_only=True), ["claude", "tucked"])

        for row, expected in ((tucked, "dot"), ({**tucked, "questionAttention": True}, "question"),
                              ({**tucked, "actionRequired": True}, "question"), ({**tucked, "state": "working"}, ""),
                              ({**tucked, "state": "working", "discardResult": True}, "discard"),
                              ({**tucked, "lastOutcome": "stopped"}, "dot"), (unread, "dot"), (base, "")):
            self.assertEqual(indicator(row, True), expected)
        self.assertEqual(indicator(tucked), "")
        self.assertEqual(indicator({**tucked, "lastOutcome": "stopped"}), "stop")

        self.assertEqual(actions(unread), [("Read", "mark-read"), ("Put in drawer", "drawer-in"), ("Pin", "pin")])
        self.assertEqual(actions(tucked), [("Read", "mark-read"), ("Take out of drawer", "drawer-out"), ("Pin", "pin")])
        self.assertEqual(actions({**tucked, "state": "working"}),
                         [("Read", "mark-read"), ("Take out of drawer", "drawer-out"), ("Pin", "pin"), ("Discard result", "discard-result")])
        self.assertEqual(actions({**tucked, "actionRequired": True}), [("Take out of drawer", "drawer-out"), ("Pin", "pin")])
        for row in (base, {**base, "questionAttention": True}, {**unread, "questionAttention": True}, {**unread, "actionRequired": True}):
            self.assertFalse({"drawer-in", "drawer-out"} & {action for _title, action in actions(row)})

        signature = SCOPE["attention_signature"]
        self.assertNotEqual(signature(tucked), signature({**tucked, "drawer": False}))

        model, description = SCOPE["tooltip_model"], SCOPE["tooltip_description"]
        value = model(tucked, 100_000, "/home/test")
        self.assertEqual((value["indicator"], value["note"], value["flags"]), ("", "Finished. Not read yet.", "In the drawer"))
        self.assertIn("Finished. Not read yet.\nIn the drawer", description(value))
        shown = model(tucked, 100_000, "/home/test", drawer_view=True)
        self.assertEqual((shown["indicator"], shown["note"], shown["flags"]), ("dot", "Finished. Not read yet.", "In the drawer"))
        self.assertEqual(model({**tucked, "pinned": True, "pendingSource": "manual-unread"}, 100_000, "/home/test")["flags"], "Pinned · In the drawer")
        self.assertEqual(model({**tucked, "pendingSource": "manual-unread"}, 100_000, "/home/test")["note"], "Marked unread in ASB.")
        question = model({**tucked, "questionAttention": True}, 100_000, "/home/test")
        self.assertEqual((question["indicator"], question["note"]), ("question", "Asks a question. Open the chat to answer."))
        self.assertEqual(model(unread, 100_000, "/home/test")["flags"], "")

        window = object.__new__(Window)
        window.view, window.opening, window.open_errors = "compact", set(), {}
        text = SimpleNamespace(asb_thread=dict(tucked), asb_time_signature=None, asb_state_label=Mock(), asb_title_label=Mock(),
                               set_sensitive=Mock(), update_property=Mock(), update_state=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.update_row_text(text, 100_000)
            self.assertEqual(text.asb_accessible_label, "Open Chat in Codex. Idle. Task completed. In the drawer. Still unread.")
            self.assertIn("In the drawer", text.update_property.call_args.args[1][1])
            text.asb_thread, text.asb_time_signature = dict(unread), None
            window.update_row_text(text, 100_000)
            self.assertNotIn("drawer", text.asb_accessible_label)

        put, out = "Put in drawer: look read here, keep it under Drawer", "Take out of drawer: show as unread again"
        row = {**unread, "id": "a"}
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=dict(row), asb_focus_key="a", asb_read_timer=None,
                                 asb_read_generation=1, asb_read_button=Mock(), asb_pin_button=Mock(), asb_drawer_button=Mock(),
                                 asb_copy_button=Mock(), asb_copy_timer=None)
        drawer, corner = widget.asb_drawer_button, widget.asb_copy_button.get_parent.return_value
        window = object.__new__(Window)
        window.closed, window.view, window.base = False, "comfortable", "http://127.0.0.1:1"
        window.session_actions, window.open_errors, window.focus_widgets = set(), {}, {"a": widget}
        window.dashboard, window.dashboard_etag = {"threads": [dict(row)]}, "etag"
        window.get_focus = window.focus_key = lambda: None
        window.update_open_state, window.refresh = Mock(), Mock()
        window.render = Mock(side_effect=lambda **_kwargs: setattr(widget, "asb_thread", dict(window.dashboard["threads"][0])))
        request, timeout = Mock(), Mock()
        with patch.dict(SCOPE, {"request_async": request, "Gtk": gtk,
                               "GLib": SimpleNamespace(idle_add=Mock(), timeout_add=timeout, source_remove=Mock())}):
            window.update_card_actions(widget)
            drawer.set_visible.assert_called_with(True)
            drawer.set_action_name.assert_called_with("win.drawer-in")
            drawer.remove_css_class.assert_any_call("asb-drawer-filled")
            drawer.set_tooltip_text.assert_called_with(put)
            drawer.update_property.assert_called_with([0], [put + ": Chat"])
            drawer.update_state.assert_called_with([0, 1], [False, False])
            corner.add_css_class.assert_called_with("asb-corner-wide")

            window.session_action("a", "drawer-in")
            window.session_action("a", "drawer-in")
            request.assert_called_once()
            self.assertEqual((request.call_args.args[1], request.call_args.args[4], request.call_args.args[5]),
                             ("/api/threads/a/drawer-in", "POST", None))
            drawer.set_action_name.assert_called_with(None)
            drawer.add_css_class.assert_any_call("asb-action-pending")
            drawer.update_state.assert_called_with([0, 1], [True, True])
            request.call_args.args[2](None, "Cannot change this session.")
            self.assertEqual((window.open_errors, window.session_actions, window.dashboard_etag),
                             ({"a": "Cannot change this session."}, set(), "etag"))
            self.assertTrue(widget.asb_thread["unread"])
            drawer.set_action_name.assert_called_with("win.drawer-in")
            window.refresh.assert_not_called()

            window.session_action("a", "drawer-in")
            reply = dict(row, unread=False, pending=False, drawer=True)
            request.call_args.args[2]({"changed": True, "threadId": "a", "thread": reply}, None)
            self.assertEqual((window.dashboard["threads"], window.open_errors, window.dashboard_etag), ([reply], {}, None))
            window.refresh.assert_called_once_with(queue=True)
            timeout.assert_not_called()  # No Read confirmation.
            self.assertIsNone(widget.asb_read_timer)
            drawer.set_visible.assert_called_with(True)
            drawer.set_action_name.assert_called_with("win.drawer-out")
            drawer.add_css_class.assert_any_call("asb-drawer-filled")
            drawer.set_tooltip_text.assert_called_with(out)
            drawer.update_property.assert_called_with([0], [out + ": Chat"])
            widget.asb_read_button.set_visible.assert_called_with(True)
            widget.asb_read_button.set_action_name.assert_called_with("win.mark-read")

            window.session_action("a", "drawer-out")
            self.assertEqual(request.call_args.args[1], "/api/threads/a/drawer-out")
            request.call_args.args[2]({"changed": True, "threadId": "a", "thread": dict(row)}, None)
            self.assertEqual(window.dashboard["threads"], [row])
            drawer.set_action_name.assert_called_with("win.drawer-in")
            timeout.assert_not_called()

            for thread, width, shown in ((base, 240, False), (row, 189, False), (reply, 189, False), (row, 190, True),
                                         ({**row, "questionAttention": True}, 240, False), ({**reply, "state": "working"}, 240, True)):
                widget.asb_thread, window.column_pixel_width = {**thread, "id": "a"}, width
                window.update_card_actions(widget)
                drawer.set_visible.assert_called_with(shown)
                # Copy is in every wide corner, so the fade follows the width, not the drawer button.
                (corner.add_css_class if width >= 190 else corner.remove_css_class).assert_called_with("asb-corner-wide")
        css = SOURCE.read_text()
        for rule in ("{base} .asb-unread:hover .asb-dot,", "{base} .asb-drawer:not(.asb-drawer-lit) .asb-dot {{ opacity: 0; }}",
                     "{base} .asb-unread:hover .asb-read-cue,", "{base} .asb-drawer.asb-drawer-lit:not(:hover) .asb-state {{ opacity: 1; }}"):
            self.assertIn(rule, css)
        self.assertIn('"drawer-in", "drawer-out"):', css)

    def test_working_rows_keep_their_place_while_only_the_update_time_changes(self):
        filtered = SCOPE["filtered_rows"]
        ids = lambda rows: [row["id"] for row in filtered({"threads": rows})]
        work = lambda identity, start, updated, **extra: {"id": identity, "provider": "codex", "state": "working",
                                                         "workingSinceMs": start, "updatedAtMs": updated, **extra}
        idle = lambda identity, updated, **extra: {"id": identity, "provider": "codex", "state": "idle", "updatedAtMs": updated, **extra}
        # (a) Two Working rows keep their order when their update times swap.
        self.assertEqual(ids([work("a", 100, 500), work("b", 200, 900)]), ["b", "a"])
        self.assertEqual(ids([work("a", 100, 900), work("b", 200, 500)]), ["b", "a"])
        # (b) In the Pending group the Working rows are first, by task start; the other rows follow by update time.
        pending = [idle("new", 300, pending=True, unread=True), idle("old", 100, pending=True, unread=True)]
        ask = lambda identity, start, updated: work(identity, start, updated, pending=True, questionAttention=True)
        for updated in (1, 250, 999):
            self.assertEqual(ids(pending + [ask("ask", 50, updated)]), ["ask", "new", "old"])
            self.assertEqual(ids(pending + [ask("ask", 50, updated), ask("late", 60, 1), ask("zero", None, 999), work("plain", 999, 999)]),
                             ["late", "ask", "zero", "new", "old", "plain"])
        # (c) A Working row with no start sorts after the rows with a start, by id.
        for start in (None, 0, -1, True, "unknown", float("nan")):
            for updated in (1, 999):
                rows = [work("z", start, updated), work("y", start, 5), work("a", 100, 500), work("b", 200, 2)]
                self.assertEqual(ids(rows), ["b", "a", "y", "z"])
        self.assertEqual(ids([{"id": "none", "state": "working", "updatedAtMs": 999}, work("a", 100, 1)]), ["a", "none"])
        # (d) Working to Idle: the row moves to the Idle bucket, by its update time.
        rows = [work("a", 100, 500), work("b", 200, 900), idle("i1", 800), idle("i2", 300)]
        self.assertEqual(ids(rows), ["b", "a", "i1", "i2"])
        rows[1] = idle("b", 400, workingSinceMs=200)
        self.assertEqual(ids(rows), ["a", "i1", "b", "i2"])
        # A new task start moves the row; pins keep their saved order.
        self.assertEqual(ids([work("a", 300, 500), work("b", 200, 900)]), ["a", "b"])
        self.assertEqual(ids([work("a", 100, 1), work("p", 1, 1, pinned=True, pinIndex=0)]), ["p", "a"])

    def test_card_action_in_flight_does_not_open_the_row(self):
        window = object.__new__(Window)
        window.base, window.closed = "http://127.0.0.1:1", False
        window.opening, window.open_errors, window.session_actions = set(), {}, {"a"}
        window.update_open_state = Mock()
        widget = SimpleNamespace(asb_thread={"id": "a", "canOpen": True})
        other = SimpleNamespace(asb_thread={"id": "b", "canOpen": True})
        request = Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=Mock())}):
            window.open_row(None, widget)
            request.assert_not_called()
            self.assertEqual(window.opening, set())
            window.update_open_state.assert_not_called()
            window.open_row(None, other)
            self.assertEqual(request.call_args.args[1], "/api/threads/b/open")
            window.session_actions.discard("a")  # The reply came: the next click on the card opens it.
            window.open_row(None, widget)
            self.assertEqual(request.call_args.args[1], "/api/threads/a/open")
            self.assertEqual(request.call_count, 2)

    def test_session_reference_uses_the_app_host_and_the_app_session_id(self):
        claude = {"id": "claude-proxy-1:local_1234", "externalId": "local_1234", "provider": "claude-desktop-code", "sourceName": "claude-proxy"}
        self.assertEqual(asb.session_reference(claude), "claude-proxy/local_1234")
        codex = {"id": "123e4567-e89b-12d3-a456-426614174000", "externalId": "123e4567-e89b-12d3-a456-426614174000", "provider": "codex"}
        self.assertEqual(asb.session_reference(codex), "codex/123e4567-e89b-12d3-a456-426614174000")
        self.assertEqual(asb.session_reference({"id": "x:cse_remote", "externalId": "cse_remote", "provider": "claude-desktop-code"}),
                         "claude-desktop-code/cse_remote")

    def test_panel_copy_writes_the_reference_and_shows_copied_for_a_moment(self):
        timers, removed = {}, []
        def timeout_add(delay, callback):
            timers[len(timers) + 1] = (delay, callback)
            return len(timers)
        glib = SimpleNamespace(timeout_add=timeout_add, source_remove=removed.append, Error=type("GError", (Exception,), {}))
        gtk = SimpleNamespace(Popover=object, AccessibleProperty=SimpleNamespace(DESCRIPTION=1))
        window = object.__new__(Window)
        window.closed, window.update_row_panel = False, Mock()
        clipboard = Mock()
        window.get_clipboard = lambda: clipboard
        row = {"id": "claude-proxy-1:local_1234", "externalId": "local_1234", "provider": "claude-desktop-code", "sourceName": "claude-proxy"}
        window.focus_widgets = {row["id"]: SimpleNamespace(asb_thread=row)}
        panel = SimpleNamespace(asb_identity=row["id"], asb_copy=Mock(), asb_copy_row=Mock(), asb_copy_timer=None, asb_copy_error="")
        panel.asb_copy.get_ancestor = lambda _type: panel
        with patch.dict(SCOPE, {"GLib": glib, "Gtk": gtk}):
            window.panel_copy(panel.asb_copy)
            clipboard.set.assert_called_once_with("claude-proxy/local_1234")
            panel.asb_copy.set_icon_name.assert_called_with("object-select-symbolic")
            panel.asb_copy.set_tooltip_text.assert_called_with("Copied")
            panel.asb_copy_row.update_property.assert_called_with([1], ["Copied"])
            self.assertEqual(timers[1][0], 1600)
            window.update_row_panel.assert_called_with(panel, row)
            # A second copy starts the 1.6 seconds again.
            window.panel_copy(panel.asb_copy)
            self.assertEqual((removed, panel.asb_copy_timer), ([1], 2))
            timers[2][1]()
            self.assertIsNone(panel.asb_copy_timer)
            panel.asb_copy.set_icon_name.assert_called_with("edit-copy-symbolic")
            panel.asb_copy.set_tooltip_text.assert_called_with("Copy app and session ID")
            panel.asb_copy_row.reset_property.assert_called_with(1)
            # Close removes a running timer, so no late callback touches the panel.
            window.panel_copy(panel.asb_copy)
            window.clear_copy_feedback(panel)
            self.assertEqual((removed[-1], panel.asb_copy_timer), (3, None))
            clipboard.set.side_effect = TypeError("no clipboard")
            panel.asb_copy.reset_mock()
            window.panel_copy(panel.asb_copy)
            self.assertEqual(panel.asb_copy_error, "Cannot copy the app and session ID: no clipboard")
            self.assertEqual(len(timers), 3)
            panel.asb_copy.set_icon_name.assert_called_once_with("edit-copy-symbolic")
            window.update_row_panel.assert_called_with(panel, row)

    def test_card_copy_is_local_shows_a_check_and_keeps_failures_on_the_row(self):
        timers, removed = {}, []
        def timeout_add(delay, callback):
            timers[len(timers) + 1] = (delay, callback)
            return len(timers)
        glib = SimpleNamespace(timeout_add=timeout_add, source_remove=removed.append, Error=type("GError", (Exception,), {}))
        rows = [{"id": "claude-proxy-1:local_1", "externalId": "local_1", "provider": "claude-desktop-code", "sourceName": "claude-proxy"},
                {"id": "123e4567", "externalId": "123e4567", "provider": "codex"},
                {"id": "local_2", "externalId": "local_2", "provider": "claude-desktop-code"}]
        window = object.__new__(Window)
        window.closed, window.open_errors = False, {}
        window.session_actions = {row["id"] for row in rows}  # A pending server action does not block a copy.
        # The real card update runs, so the copy button shows the actual feedback.
        window.update_card_actions = Mock(side_effect=lambda widget: Window.update_card_actions(window, widget))
        window.update_open_state = Mock()
        clipboard = Mock()
        window.get_clipboard = lambda: clipboard
        widgets = {row["id"]: SimpleNamespace(asb_thread=row, asb_focus_key=row["id"], asb_view="comfortable", asb_copy_timer=None,
                                              asb_read_timer=None, asb_read_button=Mock(), asb_pin_button=Mock(), asb_copy_button=Mock())
                   for row in rows}
        window.focus_widgets = dict(widgets)
        request = Mock()
        target = lambda identity: SimpleNamespace(get_string=lambda: identity)
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        def feedback(widget):
            button = widget.asb_copy_button
            return (widget.asb_copy_timer, button.get_child().set_from_icon_name.call_args.args[0], button.set_tooltip_text.call_args.args[0],
                    button.update_property.call_args.args if button.update_property.call_args.args[0] == [1] else button.reset_property.call_args.args)
        with patch.dict(SCOPE, {"GLib": glib, "request_async": request, "Gtk": gtk}):
            for row, text in zip(rows, ("claude-proxy/local_1", "codex/123e4567", "claude-desktop-code/local_2")):
                window.copy_reference(None, target(row["id"]))
                self.assertEqual(clipboard.set.call_args.args, (text,))
            request.assert_not_called()
            self.assertEqual([timers[index][0] for index in timers], [1600, 1600, 1600])
            first = widgets[rows[0]["id"]]
            window.update_card_actions.assert_called_with(widgets[rows[2]["id"]])
            # A second copy starts the 1.6 seconds again; the end restores the copy button.
            window.copy_reference(None, target(rows[0]["id"]))
            self.assertEqual((removed, first.asb_copy_timer), ([1], 4))
            window.update_card_actions.reset_mock()
            timers[4][1]()
            self.assertIsNone(first.asb_copy_timer)
            window.update_card_actions.assert_called_once_with(first)
            # Release removes a running timer; a late end for a row that left the board changes nothing.
            window.copy_reference(None, target(rows[0]["id"]))
            window.cancel_card_copy(first)
            self.assertEqual((removed[-1], first.asb_copy_timer), (5, None))
            window.focus_widgets.pop(rows[1]["id"])
            window.update_card_actions.reset_mock()
            timers[2][1]()
            window.update_card_actions.assert_not_called()
            # Success, then a failure within 1.6 seconds: the check ends and the copy button comes back.
            third = widgets[rows[2]["id"]]
            self.assertEqual(feedback(third), (3, "object-select-symbolic", "Copied", ([1], ["Copied"])))
            third.asb_copy_button.reset_mock()
            clipboard.set.side_effect = TypeError("no clipboard")
            window.copy_reference(None, target(rows[2]["id"]))
            self.assertEqual(removed[-1], 3)
            self.assertEqual(feedback(third), (None, "edit-copy-symbolic", "Copy app and session ID", (1,)))
            self.assertEqual(window.open_errors, {rows[2]["id"]: "Cannot copy the app and session ID: no clipboard"})
            window.update_open_state.assert_called_once_with(third)
            self.assertEqual(len(timers), 5)
            # A later success clears the old copy error from the row tooltip, and an open error stays.
            clipboard.set.side_effect = None
            window.copy_reference(None, target(rows[2]["id"]))
            self.assertEqual(window.open_errors, {})
            self.assertEqual(window.update_open_state.call_count, 2)
            self.assertEqual(feedback(third), (6, "object-select-symbolic", "Copied", ([1], ["Copied"])))
            window.open_errors[rows[2]["id"]] = "The server did not answer."
            window.copy_reference(None, target(rows[2]["id"]))
            self.assertEqual(window.open_errors, {rows[2]["id"]: "The server did not answer."})
            request.assert_not_called()

    def test_card_copy_button_shows_its_check_and_never_takes_a_pending_state(self):
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        row = {"id": "a", "title": "Chat", "state": "idle"}
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=dict(row), asb_focus_key="a", asb_read_timer=None, asb_copy_timer=None,
                                 asb_read_button=Mock(), asb_pin_button=Mock(), asb_copy_button=Mock())
        copy, corner = widget.asb_copy_button, widget.asb_copy_button.get_parent.return_value
        window = object.__new__(Window)
        window.session_actions = {"a"}
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for width, copied in ((240, False), (240, True), (189, False)):
                window.column_pixel_width, widget.asb_copy_timer = width, 7 if copied else None
                window.update_card_actions(widget)
                copy.set_visible.assert_called_with(width >= 190)
                (corner.add_css_class if width >= 190 else corner.remove_css_class).assert_called_with("asb-corner-wide")
                copy.set_action_name.assert_called_with("win.copy-reference")
                copy.get_child().set_from_icon_name.assert_called_with("object-select-symbolic" if copied else "edit-copy-symbolic")
                (copy.add_css_class if copied else copy.remove_css_class).assert_called_with("asb-copy-confirmed")
                copy.set_tooltip_text.assert_called_with("Copied" if copied else "Copy app and session ID")
                copy.update_property.assert_any_call([0], ["Copy app and session ID: Chat"])
                if copied:
                    copy.update_property.assert_called_with([1], ["Copied"])
                else:
                    copy.reset_property.assert_called_with(1)
            self.assertNotIn(("asb-action-pending",), [call.args for call in copy.add_css_class.call_args_list])
            copy.update_state.assert_not_called()
            copy.set_sensitive.assert_not_called()

    def test_number_keys_take_whole_openable_cards_down_then_across(self):
        rows = [{"id": f"r{index}", "canOpen": index != 1} for index in range(14)]
        # Two columns of five 22px rows, 252px apart; the third column is cut at the right edge.
        bounds = {f"r{index}": (4 + 252 * (index // 5), 22 * (index % 5), 240, 22) for index in range(14)}
        keys = asb.number_key_rows(rows, bounds, (600, 120))
        self.assertEqual(keys, ["r0", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"])
        self.assertEqual(asb.number_key_rows(rows[:4], bounds, (600, 120)), ["r0", "r2", "r3"])
        # Half a pixel outside still counts; more does not.
        edge = {"r0": (-.5, 0, 240, 22), "r2": (0, 98.5, 240, 22), "r3": (360.6, 0, 240, 22)}
        self.assertEqual(asb.number_key_rows(rows, edge, (600, 120)), ["r0", "r2"])
        self.assertEqual(asb.number_key_rows(rows, {"r0": (0, 0, 0, 22), "r2": (0, 0, 240, 0)}, (600, 120)), [])
        self.assertEqual(asb.number_key_rows(rows, bounds, (0, 120)), [])
        self.assertEqual(asb.number_key_rows(rows, {"r0": (601, 0, 240, 22)}, (600, 120)), [])
        self.assertEqual([asb.number_key(key) for key in (0x30, 0x31, 0x39, 0x3a, 0xffb0, 0xffb1, 0xffb9, 0x66)],
                         [0, 1, 9, 0, 0, 1, 9, 0])

    def test_number_badge_colors_keep_text_contrast(self):
        fill, edge, pressed = asb.number_badge_colors(CUSTOM)
        self.assertEqual((fill, edge), (asb.mix_color(CUSTOM["background"], CUSTOM["text"], .17),
                                        asb.mix_color(CUSTOM["background"], CUSTOM["text"], .36)))
        self.assertEqual(pressed, "#000000")
        # A valid palette whose 17% mix leaves the text below 4.5:1 lowers the fill toward the background.
        low = asb.validate_theme({"background": "#000000", "text": "#7c7c7c", "accent": "#ff0000", "muted": "#999999", "divider": "#333333"})
        fill, edge, pressed = asb.number_badge_colors(low)
        self.assertLess(asb.contrast(low["text"], asb.mix_color(low["background"], low["text"], .17)), 4.5)
        self.assertGreaterEqual(asb.contrast(low["text"], fill), 4.5)
        self.assertGreater(asb.luminance(fill), asb.luminance(low["background"]))
        self.assertEqual(edge, asb.mix_color(low["background"], low["text"], .36))
        self.assertGreaterEqual(asb.contrast(low["accent"], pressed), 4.5)

    def test_ctrl_hold_shows_numbers_and_ctrl_digit_opens_the_card(self):
        timers, removed = {}, []
        def timeout_add(delay, callback, *args):
            timers[len(timers) + 1] = (delay, callback, args)
            return len(timers)
        glib = SimpleNamespace(timeout_add=timeout_add, source_remove=removed.append, idle_add=Mock())
        modifiers = SimpleNamespace(SHIFT_MASK=1, CONTROL_MASK=4, ALT_MASK=8, SUPER_MASK=16, META_MASK=32, HYPER_MASK=64)
        gdk = SimpleNamespace(KEY_Control_L=0xffe3, KEY_Control_R=0xffe4, KEY_Escape=27, KEY_space=32, KEY_Return=13,
                              KEY_KP_Enter=14, ModifierType=modifiers, keyval_to_unicode=lambda key: key)
        popover = type("Popover", (), {})
        gtk = SimpleNamespace(Popover=popover, AccessibleProperty=SimpleNamespace(KEY_SHORTCUTS=7),
                              Editable=type("Editable", (), {}), TextView=type("TextView", (), {}), ScrollUnit=None)
        window = object.__new__(Window)
        window.closed, window.context_menu, window.focus_generation = False, None, 0
        window.search_popover, other_popup = popover(), popover()
        active, focus = [True], [None]
        window.is_active, window.get_focus = lambda: active[0], lambda: focus[0]
        window.list_body, window.open_row = Mock(), Mock()
        viewport = SimpleNamespace(get_width=lambda: 500, get_height=lambda: 66)
        window.scroll = SimpleNamespace(get_child=lambda: viewport)
        places = {f"r{index}": (4 + 252 * (index // 3), 22 * (index % 3)) for index in range(6)}
        def card(identity):
            return SimpleNamespace(asb_thread={"id": identity, "canOpen": identity != "r1"}, asb_number_label=Mock(),
                                   update_property=Mock(), reset_property=Mock(),
                                   compute_bounds=lambda _viewport: (True, SimpleNamespace(
                                       origin=SimpleNamespace(x=places[identity][0], y=places[identity][1]),
                                       size=SimpleNamespace(width=240, height=22))))
        window.focus_widgets = {identity: card(identity) for identity in places}
        window.row_cache = dict(window.focus_widgets)
        cards = window.focus_widgets
        def entry(ancestor=None):
            return SimpleNamespace(get_ancestor=lambda _type: ancestor)
        control = modifiers.CONTROL_MASK
        with patch.dict(SCOPE, {"GLib": glib, "Gdk": gdk, "Gtk": gtk, "SHORTCUT_MASK": 4 | 8 | 16 | 32}):
            self.assertFalse(window.window_key(None, gdk.KEY_Control_L, 0, 0))
            self.assertEqual(timers[1][0], 400)
            self.assertFalse(window.window_key(None, gdk.KEY_Control_L, 0, control))  # Key repeat.
            self.assertEqual(len(timers), 1)
            timers[1][1]()
            self.assertTrue(window.numbers_shown)
            window.list_body.add_css_class.assert_called_once_with("asb-numbers-shown")
            self.assertEqual(window.number_keys, ["r0", "r2", "r3", "r4", "r5"])
            cards["r3"].asb_number_label.set_label.assert_called_with("3")
            cards["r3"].update_property.assert_called_with([7], ["Control+3"])
            cards["r1"].asb_number_label.set_label.assert_not_called()
            # Ctrl+3 and keypad 3 open the third card, also from the search entry and the narrow search popover.
            for key, where in ((0x33, None), (0xffb3, entry()), (0x33, entry(window.search_popover))):
                focus[0] = where
                window.open_row.reset_mock()
                self.assertTrue(window.window_key(None, key, 0, control))
                window.open_row.assert_called_once_with(None, cards["r3"])
            cards["r3"].asb_number_label.add_css_class.assert_called_with("asb-number-pressed")
            self.assertTrue(window.numbers_shown)
            window.open_row.reset_mock()
            self.assertTrue(window.window_key(None, 0x39, 0, control))  # An empty slot does nothing.
            for extra in (modifiers.SHIFT_MASK, modifiers.ALT_MASK, modifiers.SUPER_MASK):
                self.assertFalse(window.window_key(None, 0x33, 0, control | extra))
            window.open_row.assert_not_called()
            self.assertFalse(window.numbers_shown)  # Another key while Ctrl is down hides the numbers.
            cards["r3"].asb_number_label.remove_css_class.assert_called_with("asb-number-pressed")
            self.assertFalse(window.window_key(None, gdk.KEY_Control_R, 0, control))
            self.assertEqual(len(timers), 1)  # No new hold until Ctrl is released.
            window.window_key_released(None, gdk.KEY_Control_L, 0, control)
            # Ctrl+F cancels a hold before it shows the numbers.
            focus[0] = None
            window.window_key(None, gdk.KEY_Control_R, 0, 0)
            self.assertFalse(window.window_key(None, ord("f"), 0, control))
            self.assertEqual(removed[-1], 2)
            self.assertIsNone(window.number_hold)
            window.window_key_released(None, gdk.KEY_Control_R, 0, control)
            # The row panel and other popups block the keys; release still clears the state.
            for blocked in ("panel", "popup"):
                window.context_menu = Mock(get_visible=Mock(return_value=True)) if blocked == "panel" else None
                focus[0] = entry(other_popup) if blocked == "popup" else None
                count = len(timers)
                self.assertFalse(window.window_key(None, gdk.KEY_Control_L, 0, 0))
                self.assertEqual(len(timers), count)
                self.assertFalse(window.window_key(None, 0x33, 0, control))
                window.open_row.assert_not_called()
                window.window_key_released(None, gdk.KEY_Control_L, 0, control)
                self.assertEqual((window.numbers_shown, window.number_hold), (False, None))
            # A popup that had the keys missed the release: Control still down (repeat) starts nothing; a fresh hold does.
            focus[0] = entry(other_popup)
            self.assertFalse(window.window_key(None, gdk.KEY_Control_L, 0, 0))
            focus[0], count = None, len(timers)
            self.assertFalse(window.window_key(None, gdk.KEY_Control_L, 0, control))
            self.assertEqual(len(timers), count)
            self.assertFalse(window.window_key(None, gdk.KEY_Control_L, 0, 0))
            self.assertEqual(len(timers), count + 1)
            window.window_key_released(None, gdk.KEY_Control_L, 0, control)
            window.context_menu, focus[0] = None, None
            # A popup that takes the focus, inactivity, and a board scroll hide the numbers, with no reshow.
            for hide in ("focus", "inactive", "scroll", "release"):
                active[0], focus[0] = True, None
                window.window_key(None, gdk.KEY_Control_L, 0, 0)
                timers[len(timers)][1]()
                self.assertTrue(window.numbers_shown, hide)
                if hide == "focus":
                    focus[0] = entry(other_popup)
                    window.focus_changed()
                elif hide == "inactive":
                    active[0] = False
                    window.active_changed()
                    active[0] = True
                    window.active_changed()
                elif hide == "scroll":
                    window.scroll_horizontal(None, 0, 0)
                else:
                    window.window_key_released(None, gdk.KEY_Control_R, 0, control)
                self.assertFalse(window.numbers_shown, hide)
                count = len(timers)
                if hide in ("focus", "scroll"):
                    focus[0] = None
                    window.window_key(None, gdk.KEY_Control_L, 0, control)
                    self.assertEqual(len(timers), count, hide)
                window.window_key_released(None, gdk.KEY_Control_L, 0, control)
            # A repack renumbers in place, keeps the numbers shown, and clears the old accessible key.
            window.window_key(None, gdk.KEY_Control_L, 0, 0)
            timers[len(timers)][1]()
            window.list_body.remove_css_class.reset_mock()
            places.update(r0=(4, 44), r2=(4, 0), r5=(508, 0))
            window.queue_number_keys()
            window.number_keys_due(*glib.idle_add.call_args.args[1:])
            self.assertEqual(window.number_keys, ["r0", "r2", "r3", "r4"])
            cards["r2"].asb_number_label.set_label.assert_called_with("2")
            cards["r5"].reset_property.assert_called_with(7)
            cards["r5"].asb_number_label.set_visible.assert_called_with(False)
            self.assertTrue(window.numbers_shown)
            window.list_body.remove_css_class.assert_not_called()
            window.queue_number_keys(scrolled=True)
            window.queue_number_keys(scrolled=True)
            self.assertEqual(removed[-1], len(timers) - 1)  # A scroll settles once.
            self.assertEqual(timers[len(timers)][0], 100)


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
            self.assertEqual(widget.asb_time_signature, ("", "Idle · " + age + " · Pinned · Archived", ""))
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


    def test_dashboard_tag_is_sent_only_for_dashboard_reads_and_304_is_not_an_error(self):
        import io
        base, sent = "http://127.0.0.1:1", []
        class Reply(io.BytesIO):
            headers = {}
        def transport(tag=None, status=200):
            def open_request(request, timeout):
                sent.append(request)
                if status != 200:
                    raise SCOPE["HTTPError"](request.full_url, status, "Synthetic", {}, io.BytesIO())
                reply = Reply(b'{"threads": [], "changed": true}')
                reply.headers = {"ETag": tag} if tag else {}
                return reply
            return {"LOCAL_HTTP": SimpleNamespace(open=open_request)}
        request = SCOPE["request_json"]
        with patch.dict(SCOPE, transport('"b"')):
            for route in ("/api/dashboard", "/api/dashboard?force=1"):
                etag = ['"a"']
                self.assertEqual(request(base, route, etag=etag)["threads"], [])
                self.assertEqual(sent[-1].get_header("If-none-match"), '"a"')
                self.assertEqual(etag, ['"b"'])
            etag = [None]
            request(base, "/api/dashboard", etag=etag)
            self.assertFalse(sent[-1].has_header("If-none-match"))
            self.assertEqual(etag, ['"b"'])
            for arguments in ((base, "/api/dashboard"), (base, "/api/sources", "GET", None, ['"a"']),
                              (base, "/api/dashboard", "POST", None, ['"a"'])):
                request(*arguments)
                self.assertFalse(sent[-1].has_header("If-none-match"))
        with patch.dict(SCOPE, transport()):
            etag = ['"a"']
            request(base, "/api/dashboard", etag=etag)
            self.assertEqual(etag, [None])
        with patch.dict(SCOPE, transport(status=304)):
            etag, received = ['"a"'], []
            self.assertIsNone(request(base, "/api/dashboard", etag=etag))
            self.assertEqual(etag, ['"a"'])
            REQUEST_ASYNC(base, "/api/dashboard", None, lambda *args: received.append(args), "GET", None, etag).join(1)
            self.assertEqual(received, [(None, None, None)])
            for arguments in ((base, "/api/dashboard"), (base, "/api/dashboard", "GET", None, [None]),
                              (base, "/api/sources", "GET", None, ['"a"'])):
                with self.assertRaises(RuntimeError):
                    request(*arguments)
        with patch.dict(SCOPE, transport(status=500)):
            etag = ['"a"']
            with self.assertRaisesRegex(RuntimeError, "Cannot load sessions"):
                request(base, "/api/dashboard", etag=etag)
            self.assertEqual(etag, ['"a"'])

    def polling_window(self):
        window = object.__new__(Window)
        window.preferences_window = None
        window.base, window.dashboard, window.signature, window.dashboard_etag = "http://127.0.0.1:1", None, None, None
        window.closed = window.loading = window.refresh_queued = window.refresh_force_queued = window.snapshot_pending = False
        window.refresh_interval_ms, window.clock_interval = 5000, 60
        window.refresh_button, window.sync_unread_setting, window.set_notice, window.update_clock, window.render, window.count = \
            (Mock() for _ in range(6))
        return window

    def test_unchanged_poll_changes_no_state_and_replaced_dashboard_drops_the_tag(self):
        window, requests, pending = self.polling_window(), [], []
        widgets = (window.sync_unread_setting, window.set_notice, window.update_clock, window.render, window.count)
        def reply(dashboard, error, tag=None):
            _base, route, callback, _dispatch, method, body, etag = requests.pop()
            self.assertEqual((method, body), ("GET", None))
            sent, etag[0] = etag[0], tag if dashboard else etag[0]
            callback(dashboard, error)
            return route, sent
        glib = SimpleNamespace(idle_add=lambda callback, *args: pending.append((callback, args)))
        with patch.dict(SCOPE, {"request_async": lambda *args: requests.append(args), "GLib": glib}):
            first = {"threads": [{"id": "a", "state": "idle"}]}
            window.tick()
            self.assertEqual(reply(first, None, '"one"'), ("/api/dashboard", None))
            self.assertIs(window.dashboard, first)
            self.assertEqual(window.dashboard_etag, '"one"')
            window.render.assert_called_once_with()
            for widget in widgets:
                widget.reset_mock()
            before = dict(vars(window))
            window.tick()
            self.assertTrue(window.loading)
            window.source_changed()
            self.assertEqual(reply(None, None), ("/api/dashboard", '"one"'))
            self.assertEqual(vars(window), before)
            for widget in widgets:
                self.assertEqual(widget.mock_calls, [])
            callback, args = pending.pop()
            self.assertEqual((callback, args), (window.refresh, (False,)))
            callback(*args)
            self.assertEqual(reply(None, "Cannot load sessions"), ("/api/dashboard", '"one"'))
            self.assertIs(window.dashboard, first)
            self.assertIsNone(window.dashboard_etag)
            window.set_notice.assert_called_once_with("Cannot load sessions")
            window.count.set_label.assert_not_called()
            window.tick()
            second = {"threads": [{"id": "b", "state": "idle"}]}
            self.assertEqual(reply(second, None, '"two"'), ("/api/dashboard", None))
            self.assertIs(window.dashboard, second)
            window.tick()
            self.assertEqual(reply(dict(second), None), ("/api/dashboard", '"two"'))
            self.assertIsNone(window.dashboard_etag)
            window.tick()
            self.assertEqual(reply(second, None, '"three"'), ("/api/dashboard", None))
            self.assertEqual((pending, window.refresh_button.mock_calls), ([], []))

            window.refresh = Mock()
            window.syncing_unread_setting = window.unread_setting_loading = False
            window.persistent_unread, window.unread_setting_error = Mock(), Mock()
            window.change_unread_setting()
            posted = {"threads": []}
            requests.pop()[2]({"changed": True, "persistentUnread": True, "dashboard": posted}, None)
            self.assertIs(window.dashboard, posted)
            self.assertIsNone(window.dashboard_etag)
            window.refresh.assert_called_once_with(True)
            window.dashboard_etag = '"four"'
            window.session_actions, window.focus_widgets, window.open_errors = set(), {}, {}
            window.get_focus = window.focus_key = lambda: None
            window.session_action("a", "pin")
            requests.pop()[2](None, "Cannot change this session.")
            self.assertEqual(window.dashboard_etag, '"four"')
            window.session_action("a", "pin")
            requests.pop()[2]({"changed": True, "pinnedOrder": []}, None)
            self.assertIsNone(window.dashboard_etag)
            self.assertEqual(window.refresh.call_count, 2)

    def test_only_forced_refresh_changes_the_refresh_button(self):
        window, requests, pending = self.polling_window(), [], []
        button = window.refresh_button.set_sensitive
        def reply(dashboard, error):
            requests.pop()[2](dashboard, error)
            self.assertFalse(window.loading)
        def follow_up():
            callback, args = pending.pop()
            callback(*args)
        glib = SimpleNamespace(idle_add=lambda callback, *args: pending.append((callback, args)))
        with patch.dict(SCOPE, {"request_async": lambda *args: requests.append(args), "GLib": glib}):
            window.tick()
            window.source_changed()
            reply({"threads": []}, None)
            follow_up()
            reply(None, "Cannot load sessions")
            window.tick()
            reply(None, None)
            self.assertEqual(window.refresh_button.mock_calls, [])
            for result in (({"threads": []}, None), (None, "Cannot load sessions"), (None, None)):
                button.reset_mock()
                window.refresh(True)
                self.assertEqual(requests[-1][1], "/api/dashboard?force=1")
                button.assert_called_once_with(False)
                reply(*result)
                self.assertEqual([call.args for call in button.call_args_list], [(False,), (True,)])
            button.reset_mock()
            window.tick()
            window.refresh(True)
            button.assert_called_once_with(False)
            reply(None, None)
            button.assert_called_once_with(False)
            follow_up()
            self.assertEqual(requests[-1][1], "/api/dashboard?force=1")
            window.refresh(True)
            window.source_changed()
            reply(None, "Cannot load sessions")
            self.assertNotIn((True,), [call.args for call in button.call_args_list])
            follow_up()
            self.assertEqual(requests[-1][1], "/api/dashboard?force=1")
            reply({"threads": []}, None)
            self.assertEqual(button.call_args_list[-1].args, (True,))
            self.assertEqual([call.args for call in button.call_args_list].count((True,)), 1)
            self.assertEqual((requests, pending), ([], []))
            button.reset_mock()
            window.refresh(True)
            window.closed = True
            window.refresh(True)
            requests.pop()[2]({"threads": []}, None)
            button.assert_called_once_with(False)

if __name__ == "__main__":
    unittest.main()
