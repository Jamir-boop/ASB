"""Native data, scheduling, and row reuse checks, without GTK or a display."""
import ast
import copy
from datetime import datetime, timezone
import io
import itertools
import json
import os
import sys
from pathlib import Path, PureWindowsPath
from tempfile import TemporaryDirectory
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch


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
MACHINES = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "MachinesEditor"))
MACHINES.bases = []
MARKER = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SourceMarker"))
MARKER.bases = []
APPLICATION = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SwitchboardApplication"))
APPLICATION.bases = []
STRIP = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SessionStrip"))
STRIP.bases = []
USAGE_CHART = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "UsageChart"))
USAGE_CHART.bases = []
COLUMN = copy.deepcopy(next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == "SessionColumn"))
COLUMN.bases = []
# The signal helper follows the GI import block, so it is not in NODES.
SIGNAL = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "unix_signal_add")
# The color helpers of the Board and the activity windows also follow the GI import block.
COLORS = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in ("rgba", "hex_color", "native_colors")]
SCOPE = {"__file__": str(SOURCE)}
exec(compile(ast.Module(body=NODES + [SIGNAL] + COLORS + [USAGE_CHART, STRIP, COLUMN, MARKER, SOURCES, PHONE, MACHINES, PREFERENCES, WINDOW, APPLICATION],
                        type_ignores=[]), str(SOURCE), "exec"), SCOPE)
Column = SCOPE["SessionColumn"]
SCOPE["SessionColumn"] = lambda **kwargs: SCOPE["Gtk"].ListBox(**kwargs)
Window = SCOPE["SwitchboardWindow"]
Strip = SCOPE["SessionStrip"]
SourcesEditor = SCOPE["AppSourcesEditor"]
Preferences = SCOPE["PreferencesWindow"]
PhoneEditor = SCOPE["PhoneEditor"]
Marker = SCOPE["SourceMarker"]
REQUEST_ASYNC = SCOPE["request_async"]
# The real set_icon() loads a Gio.FileIcon; the GTK suite checks the files.
SCOPE["set_icon"] = Mock()
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

    def get_row_at_index(self, index):
        return self.children[index] if index < len(self.children) else None

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

    def clear_hover(self, **_kwargs):
        pass

    def clear_flights(self):
        pass


class FakeMarker:
    def __init__(self, _owner, color=""):
        self.configured_color, self.set_valign, self.add_css_class = color, Mock(), Mock()

    def set_color(self, color):
        self.configured_color = color


class ActivityHelperChecks(unittest.TestCase):
    def setUp(self):
        # Local times are checked in UTC, so the expected strings do not depend on the machine.
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

    @staticmethod
    def utc(*parts):
        return int(datetime(*parts, tzinfo=timezone.utc).timestamp() * 1000)

    def test_names_and_fixed_colors(self):
        self.assertEqual(asb.ACTIVITY_APPS, ("codex", "claude", "opencode"))
        self.assertEqual(asb.USAGE_APPS, ("codex", "claude", "opencode", "antigravity", "grok", "pi"))
        self.assertEqual(asb.ACTIVITY_APP_LABELS, {"codex": "Codex", "claude": "Claude Code", "opencode": "OpenCode", "": "Other",
                                                  "antigravity": "Antigravity", "grok": "Grok", "pi": "Pi"})
        self.assertEqual(asb.USAGE_MAKER_COLOR, "#8c929a")
        self.assertEqual(asb.USAGE_OTHER_MAKER, "Other")
        self.assertEqual([asb.ACTIVITY_APP_ICONS[app] for app in ("antigravity", "grok", "pi")], ["asb-terminal-symbolic"] * 3)
        self.assertEqual(asb.ACTIVITY_STATUSES, ("accepted", "written", "held", "not-sent", "unknown"))
        self.assertEqual([asb.ACTIVITY_STATUS_LABELS[key] for key in asb.ACTIVITY_STATUSES],
                         ["Accepted", "Socket written", "Held", "Not sent", "Unknown"])
        self.assertEqual(set(asb.ACTIVITY_STATUS_COLORS), set(asb.ACTIVITY_STATUSES))
        self.assertEqual(set(asb.ACTIVITY_STATUS_ICONS), set(asb.ACTIVITY_STATUSES))
        self.assertEqual(set(asb.ACTIVITY_APP_ICONS), set(asb.ACTIVITY_APP_LABELS))
        self.assertEqual(asb.ACTIVITY_APP_COLORS["claude"], "#d97757")
        self.assertEqual(asb.ACTIVITY_TOKEN_COLORS, {"cacheRead": "#4b5058", "cacheWrite": "#6b7179", "uncached": "#959ba3", "output": "#e4e6e8"})
        self.assertEqual(asb.USAGE_PERIODS[-2:], (("90d", "90 days"), ("all", "All time")))
        self.assertEqual(asb.MESSAGE_PERIODS, (("24h", "24 hours"), ("7d", "7 days"), ("30d", "30 days")))

    def test_number_formats(self):
        self.assertEqual(asb.format_count(1234), "1,234")
        self.assertEqual(asb.format_count(0), "0")
        self.assertEqual(asb.format_cost(2148.62), "$2,148.62")
        self.assertEqual(asb.format_cost(0.074), "$0.07")
        self.assertEqual(asb.format_cost(None), "Unpriced")
        for value, expected in ((0, "0"), (999, "999"), (1000, "1.0K"), (412_340, "412.3K"), (412_350, "412.4K"), (999_950, "1.0M"),
                                (845_200_000, "845.2M"), (999_950_000, "1.00B"), (1_940_000_000, "1.94B"), (1_945_000_000, "1.95B")):
            with self.subTest(value=value):
                self.assertEqual(asb.format_tokens(value), expected)
        self.assertEqual(asb.format_share(.384), "38.4%")
        self.assertEqual(asb.format_share(0), "0.0%")
        self.assertEqual(asb.format_share(1), "100.0%")

    def test_time_formats_and_day_lines(self):
        self.assertEqual(asb.format_clock(self.utc(2026, 10, 24, 16, 38, 59)), "16:38")
        self.assertEqual(asb.format_clock(self.utc(2026, 10, 24, 9, 5)), "09:05")
        self.assertEqual(asb.format_day(self.utc(2026, 10, 24, 12)), "Oct 24")
        self.assertEqual(asb.format_day(self.utc(2026, 10, 4, 12)), "Oct 4")
        self.assertEqual(asb.format_day(self.utc(2026, 1, 31)), "Jan 31")
        now = self.utc(2026, 10, 26, 0, 5)
        self.assertEqual(asb.day_line(self.utc(2026, 10, 26, 0, 0), now), "Today")
        self.assertEqual(asb.day_line(self.utc(2026, 10, 25, 23, 59), now), "Yesterday")
        self.assertEqual(asb.day_line(self.utc(2026, 10, 25, 0, 0), now), "Yesterday")
        self.assertEqual(asb.day_line(self.utc(2026, 10, 24, 23, 59), now), "Oct 24")
        # The day comes from the local calendar. The POSIX form of UTC-3 needs no tzdata files (the Ubuntu 22.04 image has none).
        os.environ["TZ"] = "<-03>3"
        time.tzset()
        self.assertEqual(asb.day_line(self.utc(2026, 10, 24, 23, 0), now), "Yesterday")

    def test_month_names_do_not_follow_the_locale(self):
        source = SOURCE.read_text()
        body = source[source.index("def format_day(ms):"):source.index("def day_line(")]
        self.assertNotIn("strftime", body)
        self.assertEqual([asb.format_day(self.utc(2026, month, 1)) for month in range(1, 13)],
                         [f"{name} 1" for name in "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()])

    def test_machines(self):
        self.assertEqual([asb.machine_hue(index) for index in (0, 1, 2, 5, 6, 13)],
                         ["#a28caa", "#7cc48a", "#5fb3b3", "#b4b86c", "#a28caa", "#7cc48a"])
        self.assertEqual([asb.machine_state_text({"state": state}) for state in ("local", "online", "offline")], ["Local", "Connected", "Offline"])
        at = self.utc(2026, 10, 25, 14, 30)
        self.assertEqual(asb.machine_last_report({"state": "online", "lastReportAtMs": at}), "")
        self.assertEqual(asb.machine_last_report({"state": "offline", "lastReportAtMs": 0}), "")
        self.assertEqual(asb.machine_last_report({"state": "offline", "lastReportAtMs": at}), "Last report Oct 25, 14:30")

    def test_buckets(self):
        hours = {"unit": "hour", "startsMs": [self.utc(2026, 10, 26, hour) for hour in range(9, 13)]}
        self.assertEqual([asb.bucket_label(hours, index) for index in range(4)], ["09:00", "10:00", "11:00", "Now"])
        days = {"unit": "day", "startsMs": [self.utc(2026, 10, day) for day in range(23, 27)]}
        self.assertEqual([asb.bucket_label(days, index) for index in range(4)], ["Oct 23", "Oct 24", "Oct 25", "Today"])

    def test_activity_palette(self):
        colors = {"background": "#101010", "text": "#f0f0f0", "accent": "#3080c0", "muted": "#a0a0a0", "divider": "#404040"}
        self.assertEqual(asb.activity_palette(colors), {
            "win": "#101010", "rule": "#2d2d2d", "track": "#363636", "divider": "#404040", "popup": "#616161",
            "text": "#f0f0f0", "dim": "#a0a0a0", "accent": "#3080c0", "light": "#78acd6", "warn": "#e0b45a", "bad": "#f5a090"})


class ProfileSyncChecks(unittest.TestCase):
    REV_A, REV_B, REV_C = "a" * 64, "b" * 64, "c" * 64

    def setUp(self):
        class Row(Box):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.title, self.subtitle = kwargs.get("title", ""), kwargs.get("subtitle", "")

            def set_title(self, value):
                self.title = value

            def set_subtitle(self, value):
                self.subtitle = value

            def __getattr__(self, name):
                value = Mock()
                setattr(self, name, value)
                return value

            def set_child(self, child):
                self.child = child

            def update_property(self, *_args):
                pass

            def grab_focus(self):
                self.focused = True

        class Table(Box):
            def set_sensitive(self, value):
                self.sensitive = value

            def update_state(self, *_args):
                pass

        self.Table = Table
        self.request = Mock()
        self.gtk = SimpleNamespace(Box=Mock(), Image=Mock(), ListBoxRow=Row, Align=SimpleNamespace(CENTER=0),
                                   NaturalWrapMode=SimpleNamespace(NONE=0), Justification=SimpleNamespace(RIGHT=0),
                                   AccessibleState=SimpleNamespace(BUSY=0),
                                   AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1))
        self.patcher = patch.dict(SCOPE, {"Gtk": self.gtk, "Adw": SimpleNamespace(ActionRow=Row, Dialog=Mock()),
            "Pango": SimpleNamespace(EllipsizeMode=SimpleNamespace(END=0), WrapMode=SimpleNamespace(WORD=0)),
            "SourceMarker": FakeMarker,
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
        editor.refresh_queued = editor.setting_form = editor.conflict = False
        editor.loaded = editor.active = True
        editor.editing_id, editor.max_sources = "", 8
        editor.revision = editor.observed_revision = self.REV_A
        editor.edit_revision = editor.form_baseline = editor.baseline_source = None
        editor.sources = [self.source(), self.source(id="other", label="Other", enabled=False)]
        editor.transcript_widgets, editor.preset_markers, editor.table_markers = [], [], []
        editor.choose_buttons, editor.fixed_provider = [Mock(), Mock()], ""
        editor.table = self.Table()
        editor.table.editor = editor
        editor.dialog, editor.dialog_title = Mock(), Mock()
        editor.ensure_dialog = Mock()
        editor.cancellable = Mock()
        editor.bridge_apps, editor.installing = None, ""
        editor.bridge_loading, editor.bridge_generation, editor.bridge_refresh = False, 0, False
        editor.bridge_queued, editor.feedback = None, False
        editor.header_tick = editor.focus_after_close = None
        editor.request_bridge = Mock()
        for name in ("dialog_message", "install_result", "bridge_header", "bridge_group", "bridge_row", "bridge_icon",
                     "install_button", "files_group", "color_row", "provider_fixed", "launcher_fixed", "count"):
            setattr(editor, name, Mock())
        editor.provider = self.control(0, "get_selected", "set_selected")
        for name in ("name", "data_dir", "launcher", "projects_dir"):
            setattr(editor, name, self.control("", "get_text", "set_text"))
        editor.enabled = self.control(True, "get_active", "set_active")
        editor.show_marker = self.control(True, "get_active", "set_active")
        editor.source_color = self.control("#8296b4", "get_rgba", "set_rgba")
        editor.remote_claude, editor.remote_claude_note = self.control(0, "get_selected", "set_selected"), Mock()
        for name in ("message", "form", "source_id", "source_status",
                     "add_button", "save_button", "remove_button", "cancel_button", "reload_button"):
            setattr(editor, name, Mock())
        editor.render_sources()
        editor.open_source(editor.sources[0])
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
        editor.remote_claude.set_selected(2)
        return editor.form_values()

    def test_external_add_reuses_selection_and_keeps_every_raw_dirty_field(self):
        editor = self.editor()
        row = next((row for row in editor.table.children if row.asb_source["id"] == "main"), None)
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
        self.assertIs(next((row for row in editor.table.children if row.asb_source["id"] == "main"), None), row)
        self.assertEqual(editor.form_values(), raw)
        self.assertIs(editor.baseline_source, baseline)
        self.assertEqual(editor.edit_revision, self.REV_B)
        self.assertFalse(editor.conflict)
        editor.observe_revision(self.REV_B)
        self.request.assert_called_once()

    def test_remote_claude_choice_loads_clean_makes_the_form_dirty_and_is_saved(self):
        editor = self.editor()
        editor.open_source(editor.sources[0])
        claude = self.source(id="claude", provider="claude-desktop-code", label="Claude", remoteClaude="bridge")
        editor.set_form(claude)
        self.assertEqual(editor.remote_claude.get_selected(), 1)
        self.assertFalse(editor.is_dirty())
        editor.remote_claude.set_selected(2)
        self.assertTrue(editor.is_dirty())
        editor.provider.set_selected(1)
        editor.save_source()
        self.assertEqual(self.request.call_args.args[5]["source"]["remoteClaude"], "native")

    def test_clean_selected_source_syncs_and_get_can_finish_after_selection_changes(self):
        editor = self.editor()
        row = next((row for row in editor.table.children if row.asb_source["id"] == "main"), None)
        editor.reload_sources()
        changed = self.source(label="Saved elsewhere", color="#404040", showMarker=False)
        self.reply([changed, editor.sources[1]], self.REV_B)
        self.assertIs(next((row for row in editor.table.children if row.asb_source["id"] == "main"), None), row)
        self.assertEqual((editor.name.get_text(), editor.source_color.get_rgba(), editor.show_marker.get_active()),
                         ("Saved elsewhere", "#404040", False))
        self.assertFalse(editor.is_dirty())
        self.assertEqual(editor.edit_revision, self.REV_B)
        editor.reload_sources()
        other_row = editor.table.children[1]
        editor.open_source(other_row.asb_source)
        self.reply([changed, self.source(id="other", label="Other updated", enabled=False)], self.REV_C)
        self.assertEqual(editor.editing_id, "other")
        self.assertEqual((editor.editing_id, editor.name.get_text()), ("other", "Other updated"))

    def test_status_text_joins_parts_with_one_period_each(self):
        editor = self.editor()
        for source, text in (({"status": "ready"}, "Ready."), ({"status": "warning", "message": "Store is missing."}, "Warning: Store is missing."),
                ({"status": "warning", "message": "Store is missing"}, "Warning: Store is missing."),
                ({"status": "ready", "builtin": True}, "Ready. Default profile: you can edit or turn it off. You cannot remove it."),
                ({"status": "warning", "message": "X.", "builtin": True}, "Warning: X. Default profile: you can edit or turn it off. You cannot remove it."),
                ({"builtin": True}, "Default profile: you can edit or turn it off. You cannot remove it."), ({}, "")):
            with self.subTest(source=source):
                editor.set_source_status(source)
                editor.source_status.set_label.assert_called_with(text)
                editor.source_status.set_visible.assert_called_with(bool(text))

    def test_status_only_refresh_updates_metadata_and_keeps_dirty_fields_and_baseline(self):
        editor = self.editor()
        missing = self.source(status="missing", sessionCount=0, message="Store is missing.")
        editor.sources[0] = missing
        editor.open_source(editor.sources[0])
        baseline, form_baseline = editor.baseline_source, editor.form_baseline
        row = next((row for row in editor.table.children if row.asb_source["id"] == "main"), None)
        raw = self.edit_all_fields(editor)
        editor.preferences.get_focus.return_value = editor.name

        editor.reload_sources()
        ready = self.source(status="ready", sessionCount=1, message="Store is ready.")
        self.reply([ready, editor.sources[1]], self.REV_A)
        editor.source_status.set_label.assert_called_with("Ready: Store is ready.")
        self.assertEqual(editor.table.children[0].subtitle, "Codex · 1 chat")
        self.assertEqual(editor.form_values(), raw)
        self.assertTrue(editor.is_dirty())
        self.assertIs(editor.baseline_source, baseline)
        self.assertIs(editor.form_baseline, form_baseline)
        self.assertEqual(editor.edit_revision, self.REV_A)
        self.assertIs(next((row for row in editor.table.children if row.asb_source["id"] == "main"), None), row)
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
                self.assertIn("Your edits are kept", editor.dialog_message.set_label.call_args.args[0])
                self.request.reset_mock()
                editor.save_source()
                editor.remove_source()
                self.request.assert_not_called()
                editor.cancel_form()
                self.assertFalse(editor.conflict)
                self.assertFalse(editor.is_dirty())
                self.assertIsNone(editor.edit_revision)
                self.assertFalse(editor.editing)
                editor.open_source(editor.sources[0])
                self.assertEqual(editor.name.get_text(), "Other" if deleted else "External edit")

    def test_add_draft_and_manual_refresh_keep_exact_fields(self):
        editor = self.editor()
        editor.add_source()
        raw = self.edit_all_fields(editor)
        editor.reload_sources()
        self.reply([*editor.sources, self.source(id="new")], self.REV_B)
        self.assertEqual(editor.editing_id, "")
        self.assertEqual(editor.dialog_title.set_title.call_args.args[0], "New profile")
        self.assertEqual(editor.form_values(), raw)
        self.assertEqual(editor.edit_revision, self.REV_B)
        self.assertFalse(editor.conflict)
        editor.cancel_form()
        self.assertFalse(editor.is_dirty())
        self.assertEqual(editor.editing_id, "")

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
        self.assertEqual((editor.edit_revision, editor.baseline_source, editor.editing), (None, None, False))
        editor.message.set_label.assert_called_with("Saved.")
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
        selected = next((row for row in editor.table.children if row.asb_source["id"] == "main"), None)
        raw = self.edit_all_fields(editor)
        editor.preferences.get_focus.side_effect = [selected, None]
        editor.sources.reverse()
        editor.render_sources("main", preserve_form=True)
        self.assertIs(next((row for row in editor.table.children if row.asb_source["id"] == "main"), None), selected)
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
                                      get_mapped=lambda: True, stack=Mock(get_visible_child_name=Mock(return_value="profiles")),
                                      pages=Mock(get_visible_child_name=Mock(return_value="section")))
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
            preferences.pages.get_visible_child_name.return_value = "list"
            window.report_ui()
            self.assertEqual(self.request.call_count, 4)
            self.assertFalse(self.request.call_args.args[5]["profilesVisible"])
            self.request.call_args.args[2]({}, None)
            preferences.pages.get_visible_child_name.return_value = "section"
            preferences.stack.get_visible_child_name.return_value = "sessions"
            editor.loaded = False
            window.report_ui()
            self.assertEqual(self.request.call_count, 5)
            self.assertEqual(self.request.call_args.args[5], {"clientId": window.ui_client_id,
                "sourcesRevision": self.REV_B, "profilesRevision": None, "profilesVisible": False, "dirty": True})
            window.closed = True
            self.request.call_args.args[2]({}, None)
            self.assertEqual(self.request.call_count, 5)
            window.closed = False
            with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
                window.report_ui()
            self.assertEqual(self.request.call_count, 5)

    def test_final_ui_report_has_a_bounded_wait_and_uses_the_shared_request_path(self):
        window = object.__new__(Window)
        window.base, window.ui_client_id = "http://127.0.0.1:1", str(SCOPE["uuid"].uuid4())
        request = Mock()
        with patch.dict(SCOPE, {"request_async": request, "SOURCE_TOKEN": "fake-token"}):
            window.report_ui_closed()
            request.assert_called_once()
            base, route, callback, dispatch, method, body = request.call_args.args
            self.assertEqual((base, route, method, body), (window.base, "/api/agent/ui", "POST",
                             {"clientId": window.ui_client_id, "closed": True}))
            self.assertIsNone(callback({}, None))
            self.assertIsNone(dispatch(callback, {}, None))
            request.return_value.join.assert_called_once_with(.75)
            request.reset_mock()
            with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
                window.report_ui_closed()
            request.assert_not_called()
            del window.ui_client_id
            window.report_ui_closed()
            request.assert_not_called()

    def test_engine_stop_sends_the_token_and_keeps_the_server_error(self):
        import io
        token = "ef" * 32
        transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"stopping": true}')))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
            self.assertEqual(asb.request_json("http://127.0.0.1:1", "/api/engine/stop", "POST", {}), {"stopping": True})
        request = transport.open.call_args.args[0]
        self.assertEqual(request.get_header("X-asb-source-token"), token)
        self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:1")
        self.assertEqual(request.data, b"{}")
        failure = SCOPE["HTTPError"]("http://127.0.0.1:1/api/engine/stop", 403, "Forbidden", {},
                                      io.BytesIO(b'{"error":"Use the current ASB source token to stop ASB."}'))
        with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=failure)), "SOURCE_TOKEN": token}):
            with self.assertRaisesRegex(RuntimeError, "^Use the current ASB source token to stop ASB\\.$"):
                asb.request_json("http://127.0.0.1:1", "/api/engine/stop", "POST", {})
        with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=OSError())), "SOURCE_TOKEN": token}):
            with self.assertRaisesRegex(RuntimeError, "^Cannot load or change ASB\\. Check that ASB is running, then try again\\.$"):
                asb.request_json("http://127.0.0.1:1", "/api/engine/stop", "POST", {})

    def test_quit_engine_posts_the_stop_and_closes_only_on_success(self):
        window = object.__new__(Window)
        window.base, window.closed = "http://127.0.0.1:1", False
        window.quit_engine_button, window.quit_engine_error, window.close = Mock(), Mock(), Mock()
        requests = []
        with patch.dict(SCOPE, {"request_async": lambda *args: requests.append(args)}):
            window.quit_engine()
            base, route, finished, _dispatch, method, body = requests.pop()
            self.assertEqual((base, route, method, body), ("http://127.0.0.1:1", "/api/engine/stop", "POST", {}))
            window.quit_engine_button.set_sensitive.assert_called_once_with(False)
            window.quit_engine_error.set_label.assert_called_once_with("")
            self.assertFalse(finished(None, "Cannot load or change ASB."))
            window.close.assert_not_called()
            window.quit_engine_button.set_sensitive.assert_called_with(True)
            window.quit_engine_error.set_label.assert_called_with("Cannot load or change ASB.")
            window.quit_engine()
            self.assertFalse(requests.pop()[2]({"stopping": True}, None))
            window.close.assert_called_once_with()
            self.assertEqual(window.quit_engine_button.set_sensitive.call_args_list[-1].args, (False,))
            window.quit_engine()
            window.closed = True
            self.assertFalse(requests.pop()[2](None, "late"))
            window.close.assert_called_once_with()
            self.assertEqual(window.quit_engine_error.set_label.call_args_list[-1].args, ("",))

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
            self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:1" if method == "POST" else None)
        transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"changed": true}')))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
            received = []
            REQUEST_ASYNC("http://127.0.0.1:1", "/api/sources", None, lambda *args: received.append(args),
                          "POST", {}, headers={"If-Match": '"' + self.REV_A + '"'}).join(1)
        self.assertEqual(received, [(None, {"changed": True}, None)])
        self.assertEqual(transport.open.call_args.args[0].get_header("If-match"), '"' + self.REV_A + '"')
        self.assertEqual(transport.open.call_args.args[0].get_header("X-asb-source-token"), token)


class UsageLogicChecks(unittest.TestCase):
    """The Usage window numbers over the preview's sample data (test/fixtures/activity/usage-sample.json, UTC buckets)."""
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

    def view(self, period="30d", on=None, metric="cost", reply=None):
        return asb.usage_view(reply or self.REPLIES[period], self.ALL if on is None else on, metric)

    def assert_consistent(self, view, metric):
        total = view["total"]
        self.assertAlmostEqual(total, view["cost"] if metric == "cost" else view["tokens"], delta=.01)
        self.assertAlmostEqual(sum(machine["value"] for machine in view["machines"]), total, delta=.01)
        self.assertAlmostEqual(sum(app["value"] for app in view["apps"]), total, delta=.01)
        self.assertAlmostEqual(sum(model["value"] for model in view["models"] if model["value"] is not None), total, delta=.01)
        self.assertEqual(sum(maker["tokens"] for maker in view["makers"]), sum(app["tokens"] for app in view["apps"]))
        self.assertAlmostEqual(sum(maker["cost"] for maker in view["makers"]), sum(app["cost"] for app in view["apps"]), delta=1e-9)
        self.assertAlmostEqual(sum(maker["value"] or 0 for maker in view["makers"]), total, delta=1e-9)
        self.assertEqual(sum(view["parts"].values()), view["tokens"])
        self.assertAlmostEqual(sum(sum(bar["app"].values()) for bar in view["bars"]), total, delta=.01)
        self.assertAlmostEqual(sum(sum(bar["machine"].values()) for bar in view["bars"]), total, delta=.01)
        for machine in view["machines"]:
            self.assertAlmostEqual(sum(app["value"] for app in machine["apps"].values()), machine["value"], delta=.01)
        if metric == "cost":
            self.assertAlmostEqual(sum(view["cost_parts"].values()), total, delta=.01)

    def test_every_period_and_metric_is_consistent(self):
        for period in ("24h", "7d", "30d", "90d", "all"):
            for metric in ("cost", "tokens"):
                with self.subTest(period=period, metric=metric):
                    view = self.view(period, metric=metric)
                    self.assertEqual(len(view["bars"]), {"24h": 24, "7d": 7, "30d": 30, "90d": 90, "all": 4}[period])
                    self.assert_consistent(view, metric)
                    records = self.REPLIES[period]["records"]
                    self.assertEqual(view["tokens"], sum(sum(record["tokens"].values()) for record in records))

    def test_the_preview_numbers(self):
        view = self.view()
        self.assertEqual((asb.format_cost(view["cost"]), asb.format_tokens(view["tokens"]), asb.format_cost(view["savings"])),
                         ("$2,343.50", "3.33B", "$5,916.10"))
        self.assertEqual([(machine["name"], asb.format_cost(machine["value"]), asb.format_share(machine["share"]), machine["state"])
                          for machine in view["machines"]],
                         [("Desk", "$1,473.15", "62.9%", "Local"), ("Laptop", "$622.85", "26.6%", "Connected"),
                          ("Studio", "$247.49", "10.6%", "Offline · last report Oct 25, 14:30")])
        self.assertEqual([(app["label"], asb.format_cost(app["value"])) for app in view["apps"]],
                         [("Codex", "$689.81"), ("Claude Code", "$1,573.32"), ("OpenCode", "$80.37")])
        self.assertEqual([(model["model"], model["app"], model["machines"]) for model in view["models"]], [
            ("claude-opus-5-5", "claude", ["desk", "studio"]), ("gpt-6.1-sol", "codex", ["desk", "laptop", "studio"]),
            ("claude-sonnet-5-5", "claude", ["desk", "laptop"]), ("claude-sonnet-5-5", "opencode", ["laptop"]),
            ("claude-haiku-5-5", "claude", ["desk"]), ("gpt-6.1-mini", "codex", ["laptop"]), ("mimo-v2.6-pro", "opencode", ["desk"])])
        self.assertEqual((view["models"][-1]["cost"], view["models"][-1]["value"], view["models"][-1]["share"]), (None, None, None))
        self.assertEqual(asb.format_share(view["models"][0]["share"]), "39.4%")
        tokens = self.view(metric="tokens")
        self.assertEqual(tokens["models"][0]["model"], "gpt-6.1-sol")
        self.assertIsNotNone(tokens["models"][-1]["share"])
        self.assertEqual(asb.format_tokens(self.view("24h", metric="tokens")["total"]), "99.4M")

    def test_month_bucket_labels_and_tooltip_titles_are_english(self):
        starts = [int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp() * 1000)
                  for year, month in ((2026, 11), (2026, 12), (2027, 1), (2027, 2))]
        buckets = {"unit": "month", "startsMs": starts}
        self.assertEqual([asb.bucket_label(buckets, index) for index in range(4)],
                         ["Nov 2026", "Dec", "Jan 2027", "This month"])
        chart = SimpleNamespace(buckets=buckets)
        self.assertEqual([asb.UsageChart.full_label(chart, index) for index in range(4)],
                         ["November 2026", "December 2026", "January 2027", "February 2027"])
        self.assertEqual(asb.bucket_label({"unit": "month", "startsMs": starts[:1]}, 0), "This month")
        fixture = self.REPLIES["all"]["buckets"]
        self.assertEqual([asb.bucket_label(fixture, index) for index in range(4)], ["Jul 2026", "Aug", "Sep", "This month"])
        self.assertEqual(asb.UsageChart.full_label(SimpleNamespace(buckets=fixture), 3), "October 2026")

    def test_month_label_steps_and_existing_hour_day_steps(self):
        for unit, count, expected in (("month", 4, 1), ("month", 12, 1), ("month", 13, 3), ("month", 36, 3), ("month", 37, 12),
                                      ("hour", 24, 3), ("day", 7, 1), ("day", 30, 5), ("day", 90, 15)):
            with self.subTest(unit=unit, count=count):
                chart = SimpleNamespace(buckets={"unit": unit}, bars=[{}] * count)
                self.assertEqual(asb.UsageChart.label_step(chart), expected)

    @staticmethod
    def axis(unit, starts, chart_width):
        """The axis labels as UsageChart.do_snapshot places them, with a fake font of 7 px per character."""
        count = len(starts)
        gap = 1 if count >= 90 else 2
        width = (chart_width - asb.UsageChart.LEFT - gap * (count - 1)) / count
        centers = [asb.UsageChart.LEFT + index * (width + gap) + width / 2 for index in range(count)]
        buckets = {"unit": unit, "startsMs": starts}
        step = asb.UsageChart.label_step(SimpleNamespace(buckets=buckets, bars=[{}] * count))
        return asb.usage_axis_labels(buckets, centers, chart_width, step, lambda text: 7 * len(text))

    @staticmethod
    def months(year, month, count):
        return [int(datetime(year + (month - 1 + index) // 12, (month - 1 + index) % 12 + 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
                for index in range(count)]

    def assert_axis_rules(self, labels, starts, chart_width):
        for (_index, text, left), (_next, _text, right) in zip(labels, labels[1:]):
            self.assertLessEqual(left + 7 * len(text), right - 4)
        for _index, text, left in labels:
            self.assertGreaterEqual(left, 0)
            self.assertLessEqual(left + 7 * len(text), chart_width)
        self.assertEqual(labels[-1][:2], (len(starts) - 1, "This month"))
        year = None
        for index, text, _left in labels[:-1]:
            at = datetime.fromtimestamp(starts[index] / 1000, timezone.utc)
            short = asb.ACTIVITY_MONTHS[at.month - 1][:3]
            self.assertEqual(text, short if at.year == year else f"{short} {at.year}")
            year = at.year

    def test_month_axis_labels_do_not_overlap_and_name_the_year(self):
        twelve = self.months(2025, 11, 12)
        labels = self.axis("month", twelve, 452)
        self.assert_axis_rules(labels, twelve, 452)
        self.assertLess(len(labels), 12)
        twenty = self.months(2025, 4, 20)
        labels = self.axis("month", twenty, 452)
        self.assert_axis_rules(labels, twenty, 452)
        self.assertEqual([text for _index, text, _left in labels], ["May 2025", "Aug", "Nov", "Feb 2026", "May", "This month"])
        self.assertEqual([index for index, _text, _left in labels], [1, 4, 7, 10, 13, 19])
        self.assertEqual([text for _index, text, _left in self.axis("month", twenty[:1], 452)], ["This month"])
        labels = self.axis("month", twelve, 1000)
        self.assert_axis_rules(labels, twelve, 1000)
        self.assertEqual([text for _index, text, _left in labels],
                         ["Nov 2025", "Dec", "Jan 2026", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "This month"])
        self.assertEqual([text for _index, text, _left in labels], [asb.bucket_label({"unit": "month", "startsMs": twelve}, index)
                                                                    for index in range(12)])

    def test_hour_and_day_axis_labels_do_not_change(self):
        for unit, starts, every in (("hour", [int(datetime(2026, 10, 26, 0, tzinfo=timezone.utc).timestamp() * 1000) + hour * 3_600_000
                                               for hour in range(24)], 3),
                                    ("day", [int(datetime(2026, 9, 27, tzinfo=timezone.utc).timestamp() * 1000) + day * 86_400_000
                                             for day in range(30)], 5)):
            with self.subTest(unit=unit):
                buckets = {"unit": unit, "startsMs": starts}
                labels = self.axis(unit, starts, 852)
                self.assertEqual([(index, text) for index, text, _left in labels],
                                 [(index, asb.bucket_label(buckets, index)) for index in range(len(starts)) if (len(starts) - 1 - index) % every == 0])

    def test_all_fixture_keeps_the_90_day_totals_in_utc_months(self):
        reply, days = self.REPLIES["all"], self.REPLIES["90d"]
        self.assertEqual(reply["period"], "all")
        self.assertEqual(reply["buckets"]["unit"], "month")
        for key in ("machines", "prices", "scan"):
            self.assertEqual(reply.get(key), days.get(key))
        self.assertEqual([datetime.fromtimestamp(at / 1000, timezone.utc).strftime("%Y-%m-%d") for at in reply["buckets"]["startsMs"]],
                         ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"])
        expected = {}
        for record in days["records"]:
            month = datetime.fromtimestamp(days["buckets"]["startsMs"][record["bucket"]] / 1000, timezone.utc).month
            key = tuple(record[field] for field in ("machineId", "app", "model", "maker")) + (month,)
            row = expected.setdefault(key, {"tokens": dict.fromkeys(asb.USAGE_PARTS, 0),
                                            "cost": None if record["cost"] is None else dict.fromkeys(record["cost"], 0)})
            for part, value in record["tokens"].items():
                row["tokens"][part] += value
            if row["cost"] is not None:
                for part, value in record["cost"].items():
                    row["cost"][part] += value
        self.assertEqual(len(reply["records"]), len(expected))
        for record in reply["records"]:
            month = datetime.fromtimestamp(reply["buckets"]["startsMs"][record["bucket"]] / 1000, timezone.utc).month
            key = tuple(record[field] for field in ("machineId", "app", "model", "maker")) + (month,)
            self.assertEqual(record["tokens"], expected[key]["tokens"])
            self.assertEqual(record["cost"], expected[key]["cost"])

    def test_makers_have_priced_cost_or_tokens_and_shares(self):
        makers = self.view()["makers"]
        self.assertEqual([row["id"] for row in makers], ["Anthropic", "OpenAI", "Xiaomi MiMo"])
        self.assertEqual((makers[-1]["value"], makers[-1]["share"], makers[-1]["priced"]), (None, None, False))
        self.assertGreater(makers[-1]["tokens"], 0)
        tokens = self.view(metric="tokens")["makers"]
        mimo = next(row for row in tokens if row["id"] == "Xiaomi MiMo")
        self.assertEqual(mimo["value"], mimo["tokens"])
        self.assertGreater(mimo["share"], 0)
        self.assertAlmostEqual(sum(row["share"] for row in tokens), 1, delta=1e-9)

    def test_maker_order_missing_values_and_machine_filter(self):
        reply = copy.deepcopy(self.REPLIES["30d"])
        template = reply["records"][0]
        reply["records"] = [dict(copy.deepcopy(template), maker=maker, cost=copy.deepcopy(template["cost"]) if maker == "Google" else None,
                                  tokens={part: count if part == "output" else 0 for part in asb.USAGE_PARTS})
                            for maker, count in (("Other", 100), ("Google", 10), ("xAI", 20))]
        self.assertEqual([row["id"] for row in self.view(reply=reply)["makers"]], ["Google", "xAI", "Other"])
        for missing in (None, "", 123):
            with self.subTest(maker=missing):
                reply["records"][0]["maker"] = missing
                if missing is None:
                    del reply["records"][0]["maker"]
                other = self.view(reply=reply)["makers"][-1]
                self.assertEqual((other["id"], other["tokens"]), ("Other", 100))
        reply["records"].append(dict(copy.deepcopy(template), maker="Off", machineId="studio"))
        self.assertNotIn("Off", [row["id"] for row in self.view(reply=reply, on={"desk", "laptop"})["makers"]])
        # Equal cost: the label order wins over the tokens.
        reply["records"] = [dict(copy.deepcopy(template), maker=maker, tokens={part: count if part == "output" else 0 for part in asb.USAGE_PARTS})
                            for maker, count in (("Zhipu", 500), ("Alibaba", 10))]
        self.assertEqual([row["id"] for row in self.view(reply=reply)["makers"]], ["Alibaba", "Zhipu"])

    def test_usage_apps_keep_order_unknown_apps_and_new_ring_colors(self):
        reply = copy.deepcopy(self.REPLIES["30d"])
        template = reply["records"][0]
        apps = ("pi", "cursor", "grok", "antigravity", "opencode", "claude", "codex")
        reply["records"] = [dict(copy.deepcopy(template), app=app) for app in apps]
        view = self.view(reply=reply)
        self.assertEqual([row["id"] for row in view["apps"]], ["codex", "claude", "opencode", "antigravity", "grok", "pi", ""])
        self.assertEqual(view["apps"][-1]["tokens"], sum(template["tokens"].values()))
        arcs = asb.usage_round_arcs(view, reply["machines"], "cost")
        self.assertEqual([arc["color"] for arc in arcs if arc["kind"] == "app"],
                         ["#c9ccd1", "#d97757", "#7d848c", "#4f8fe0", "#e8e46a", "#c678dd", "#5d6268"])

    def test_a_machine_that_is_off_leaves_every_number(self):
        reply = self.REPLIES["30d"]
        for metric in ("cost", "tokens"):
            with self.subTest(metric=metric):
                view = self.view(on={"desk", "laptop"}, metric=metric)
                self.assert_consistent(view, metric)
                kept = [record for record in reply["records"] if record["machineId"] != "studio"]
                self.assertEqual(view["tokens"], sum(sum(record["tokens"].values()) for record in kept))
                self.assertAlmostEqual(view["cost"], sum(record["cost"]["total"] for record in kept if record["cost"]), delta=.01)
                self.assertEqual([machine["id"] for machine in view["machines"]], ["desk", "laptop"])
                self.assertFalse(any("studio" in bar["machine"] for bar in view["bars"]))
                self.assertFalse(any("studio" in model["machines"] for model in view["models"]))
                self.assertFalse(any(arc["id"].startswith("studio") for arc in asb.usage_round_arcs(view, reply["machines"], metric)))
                self.assertLess(view["total"], self.view(metric=metric)["total"])
        self.assertEqual(asb.format_cost(self.view(on={"desk", "laptop"})["cost"]), "$2,096.01")

    def test_the_last_machine_stays_on(self):
        self.assertEqual(asb.usage_toggle({"desk", "laptop"}, "desk"), {"laptop"})
        self.assertEqual(asb.usage_toggle({"laptop"}, "laptop"), {"laptop"})
        self.assertEqual(asb.usage_toggle({"laptop"}, "desk"), {"desk", "laptop"})
        self.assertEqual(asb.usage_toggle(set(), "desk"), {"desk"})

    def test_the_opus_cost_follows_the_rate_formula(self):
        records = [record for record in self.REPLIES["30d"]["records"] if record["model"] == "claude-opus-5-5"]
        tokens = {part: sum(record["tokens"][part] for record in records) for part in asb.USAGE_PARTS}
        expected = (tokens["uncached"] * 5 + tokens["cacheRead"] * .5 + tokens["cacheWrite"] * 6.25 + tokens["output"] * 25) / 1e6
        row = next(model for model in self.view()["models"] if model["model"] == "claude-opus-5-5")
        self.assertAlmostEqual(row["cost"], expected, delta=.01)
        self.assertEqual(asb.format_cost(row["cost"]), "$923.90")

    def test_the_unpriced_note(self):
        self.assertEqual(asb.usage_unpriced_note(self.view()), "mimo-v2.6-pro is unpriced: 144.2M tokens not in the cost.")
        self.assertEqual(asb.usage_unpriced_note(self.view(metric="tokens")), "")
        self.assertEqual(asb.usage_unpriced_note(self.view(on={"laptop"})), "")
        reply = copy.deepcopy(self.REPLIES["30d"])
        for record in reply["records"]:
            if record["model"] == "gpt-6.1-mini":
                record["cost"] = None
        view = self.view(reply=reply)
        # The names keep the order of their first record.
        order = list(dict.fromkeys(record["model"] for record in reply["records"] if record["cost"] is None))
        self.assertEqual(sorted(order), ["gpt-6.1-mini", "mimo-v2.6-pro"])
        self.assertEqual(asb.usage_unpriced_note(view), f"{', '.join(order)} are unpriced: 349.3M tokens not in the cost.")
        self.assert_consistent(view, "cost")

    def test_prices_text(self):
        at = int(datetime(2026, 10, 26, 9, tzinfo=timezone.utc).timestamp() * 1000)
        for prices, text in (({"source": "LiteLLM", "status": "fresh", "fetchedAtMs": at, "models": 2131}, "Prices: LiteLLM, Oct 26"),
                             ({"source": "LiteLLM", "status": "cached", "fetchedAtMs": at - 86_400_000, "models": 2131}, "Prices: LiteLLM, Oct 25"),
                             ({"source": "LiteLLM", "status": "loading", "fetchedAtMs": None, "models": 0}, "Prices: loading"),
                             ({"source": "LiteLLM", "status": "unavailable", "fetchedAtMs": None, "models": 0}, "Prices: not available"),
                             (None, "Prices: not available")):
            with self.subTest(prices=prices):
                self.assertEqual(asb.usage_prices_text(prices), text)

    def test_scan_text(self):
        self.assertEqual(asb.usage_scan_text({"complete": True, "files": 2707, "scannedFiles": 2707}), "")
        self.assertEqual(asb.usage_scan_text({"complete": False, "files": 2707, "scannedFiles": 120}), "Reading usage: 120 of 2,707 files")
        self.assertEqual(asb.usage_scan_text({"complete": False, "files": 0, "scannedFiles": 0}), "Reading usage")

    def test_axis(self):
        for maximum, metric, expected in ((150, "cost", (50, ["$50", "$100", "$150"])), (0, "cost", (1, ["$1", "$2", "$3"])),
                                          (7.2, "cost", (2.5, ["$2.5", "$5", "$7.5"])), (4500, "cost", (2000, ["$2,000", "$4,000", "$6,000"])),
                                          (13.5e6, "tokens", (5e6, ["5M", "10M", "15M"])), (4.5e9, "tokens", (2e9, ["2B", "4B", "6B"])),
                                          (7.5e5, "tokens", (2.5e5, ["250K", "500K", "750K"])), (2400, "tokens", (1000, ["1K", "2K", "3K"])),
                                          (12, "tokens", (5, ["5", "10", "15"]))):
            with self.subTest(maximum=maximum, metric=metric):
                step, labels = asb.usage_axis(maximum, metric)
                self.assertAlmostEqual(step, expected[0])
                self.assertEqual(labels, expected[1])
                self.assertGreaterEqual(step * 3, maximum)

    def test_round_arcs(self):
        view, machines = self.view(), self.REPLIES["30d"]["machines"]
        arcs = asb.usage_round_arcs(view, machines, "cost")
        rings = [arc for arc in arcs if arc["kind"] == "machine"]
        self.assertEqual([(arc["id"], arc["r0"], arc["r1"], arc["color"]) for arc in rings],
                         [("desk", 92, 114, "#a28caa"), ("laptop", 92, 114, "#7cc48a"), ("studio", 92, 114, "#5fb3b3")])
        self.assertEqual(rings[0]["a0"], -90)
        self.assertAlmostEqual(sum(arc["a1"] - arc["a0"] for arc in rings), 360 - 3 * 1.5)
        self.assertAlmostEqual(rings[1]["a0"] - rings[0]["a1"], 1.5)
        self.assertAlmostEqual((rings[0]["a1"] - rings[0]["a0"]) / (360 - 4.5), view["machines"][0]["value"] / view["total"])
        apps = [arc for arc in arcs if arc["kind"] == "app"]
        self.assertEqual({(arc["r0"], arc["r1"]) for arc in apps}, {(118, 146)})
        self.assertIn("Claude Code on Laptop", [arc["label"] for arc in apps])
        for ring in rings:
            inside = [arc for arc in apps if arc["id"].startswith(ring["id"] + "/")]
            self.assertAlmostEqual(inside[0]["a0"], ring["a0"])
            self.assertAlmostEqual(inside[-1]["a1"], ring["a1"])
        self.assertTrue(all(arc["a1"] - arc["a0"] >= .5 for arc in arcs))
        alone = asb.usage_round_arcs(self.view(on={"laptop"}, metric="tokens"), machines, "tokens")
        self.assertEqual((alone[0]["a0"], alone[0]["a1"]), (-90, 270))
        # Studio has no usage in the last 24 hours: no arc.
        self.assertNotIn("studio", [arc["id"] for arc in asb.usage_round_arcs(self.view("24h"), machines, "cost")])

    def test_bar_easing(self):
        self.assertEqual((asb.ease_bars(0), asb.ease_bars(1), asb.ease_bars(-1), asb.ease_bars(2)), (0, 1, 0, 1))
        self.assertGreater(asb.ease_bars(.25), .75)
        self.assertLess(asb.ease_bars(.05), asb.ease_bars(.1))


class UsageBackupChecks(unittest.TestCase):
    def status(self, **changes):
        return {"enabled": True, "time": "03:00", "keep": 5, "folder": "", "path": "/example/home/.config/asb/usage/backups",
                "defaultPath": "/example/home/.config/asb/usage/backups", "nextAtMs": 1793260800000, "running": False,
                "files": [{"name": "asb-usage-atlas-5eed0c0d-2026-10-27.json", "date": "2026-10-27", "bytes": 1234567,
                           "modifiedAtMs": 1793174400000}], "lastError": None, **changes}

    @staticmethod
    def local_ms(*parts):
        return int(datetime(*parts).timestamp() * 1000)

    def test_usage_routes_send_the_token_need_no_changed_and_use_their_timeouts_and_texts(self):
        token = "9a" * 32
        for route, method, timeout in (("/api/usage/backup", "GET", 15), ("/api/usage/backup/settings", "POST", 15),
                                       ("/api/usage/backup/now", "POST", 120), ("/api/usage/export", "GET", 120),
                                       ("/api/usage/import", "POST", 120), ("/api/usage/export", "POST", 15),
                                       ("/api/usage/backup/now", "GET", 15)):
            with self.subTest(route=route, method=method):
                transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"enabled": false}')))
                with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
                    self.assertEqual(asb.request_json("http://127.0.0.1:1", route, method, {}), {"enabled": False})
                request = transport.open.call_args.args[0]
                self.assertEqual(request.get_header("X-asb-source-token"), token)
                self.assertEqual(request.get_header("Origin"), "http://127.0.0.1:1" if method == "POST" else None)
                self.assertEqual(transport.open.call_args.kwargs["timeout"], timeout)
        transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{}')))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
            asb.request_json("http://127.0.0.1:1", "/api/usagex")
        self.assertIsNone(transport.open.call_args.args[0].get_header("X-asb-source-token"))
        def fail(code, payload):
            failure = SCOPE["HTTPError"]("http://127.0.0.1:1/api/usage/backup/settings", code, "Error", {}, io.BytesIO(payload))
            with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=failure)), "SOURCE_TOKEN": token}):
                with self.assertRaises(RuntimeError) as caught:
                    asb.request_json("http://127.0.0.1:1", "/api/usage/backup/settings", "POST", {})
            return str(caught.exception)
        self.assertEqual(fail(400, b'{"error":"This folder does not exist."}'), "This folder does not exist.")
        self.assertEqual(fail(404, b'{"error":"Not found."}'), "This ASB engine has no usage backups. Update ASB, then try again.")
        self.assertEqual(fail(500, b'not json'), "Cannot load or change usage backups. Check that ASB is running, then try again.")
        with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=OSError())), "SOURCE_TOKEN": token}):
            with self.assertRaisesRegex(RuntimeError, "^Cannot load or change usage backups\\. Check that ASB is running, then try again\\.$"):
                asb.request_json("http://127.0.0.1:1", "/api/usage/backup")

    def test_short_home_path_shortens_linux_and_windows_homes(self):
        self.assertEqual(asb.short_home_path("/home/u", "/home/u"), "~")
        self.assertEqual(asb.short_home_path("/home/u/.config/asb", "/home/u"), "~/.config/asb")
        self.assertEqual(asb.short_home_path("/home/user2/x", "/home/u"), "/home/user2/x")
        self.assertEqual(asb.short_home_path("/srv/backups", "/home/u"), "/srv/backups")
        self.assertEqual(asb.short_home_path("C:\\Users\\u\\Backups", "C:\\Users\\u"), "~\\Backups")
        self.assertEqual(asb.short_home_path("/home/u\\x", "/home/u"), "/home/u\\x")

    def test_backup_status_valid_takes_only_the_exact_shape(self):
        made = {"name": "asb-usage-atlas-5eed0c0d-2026-10-27.json", "path": "/example/b/x.json", "machines": 3, "hours": 3071}
        for value in (self.status(), self.status(nextAtMs=None, files=[]), self.status(lastError={"atMs": 1, "message": "Disk full."}),
                      self.status(made=made), self.status(keep=1, time="23:59"), self.status(keep=30, time="00:00")):
            self.assertTrue(asb.backup_status_valid(value), value)
        files = self.status()["files"][0]
        for value in (None, [], {}, self.status(extra=1), {k: v for k, v in self.status().items() if k != "running"},
                      self.status(enabled=1), self.status(running=None), self.status(time="3:00"), self.status(time="24:00"),
                      self.status(time="12:60"), self.status(keep=0), self.status(keep=31), self.status(keep=True), self.status(keep=5.0),
                      self.status(folder=None), self.status(path=1), self.status(defaultPath=None), self.status(nextAtMs="1"),
                      self.status(nextAtMs=True), self.status(files={}), self.status(files=[{**files, "bytes": "1"}]),
                      self.status(files=[{**files, "extra": 1}]), self.status(files=[["x"]]), self.status(lastError="failed"),
                      self.status(lastError={"atMs": 1}), self.status(lastError={"atMs": True, "message": "x"}),
                      self.status(made={**made, "hours": None}), self.status(made={**made, "extra": 1}), self.status(made=None)):
            self.assertFalse(asb.backup_status_valid(value), value)

    def test_backup_texts_sizes_counts_and_bodies(self):
        now = self.local_ms(2026, 10, 27, 12, 0)
        self.assertEqual(asb.backup_when(self.local_ms(2026, 10, 27, 3, 0), now), "Today at 03:00")
        self.assertEqual(asb.backup_when(self.local_ms(2026, 10, 26, 23, 59), now), "Yesterday at 23:59")
        self.assertEqual(asb.backup_when(self.local_ms(2026, 10, 25, 3, 0), now), "2026-10-25 03:00")
        self.assertEqual(asb.backup_size(512), "512 bytes")
        self.assertEqual(asb.backup_size(1023), "1023 bytes")
        self.assertEqual(asb.backup_size(980 * 1024 + 300), "980 KB")
        self.assertEqual(asb.backup_size(1234567), "1.2 MB")
        self.assertEqual(asb.backup_next_text(self.status(enabled=False, nextAtMs=None), now), "Daily backup is off.")
        self.assertEqual(asb.backup_next_text(self.status(running=True), now), "A backup is running…")
        self.assertEqual(asb.backup_next_text(self.status(nextAtMs=now), now), "Next backup: in a few minutes.")
        self.assertEqual(asb.backup_next_text(self.status(nextAtMs=now - 60_000), now), "Next backup: in a few minutes.")
        self.assertEqual(asb.backup_next_text(self.status(nextAtMs=self.local_ms(2026, 10, 27, 15, 0)), now), "Next backup: today at 15:00.")
        self.assertEqual(asb.backup_next_text(self.status(nextAtMs=self.local_ms(2026, 10, 28, 3, 0)), now), "Next backup: tomorrow at 03:00.")
        self.assertEqual(asb.backup_next_text(self.status(nextAtMs=self.local_ms(2026, 10, 29, 3, 0)), now), "Next backup: 2026-10-29 03:00.")
        self.assertEqual(asb.backup_error_text(self.status()), "")
        self.assertEqual(asb.backup_error_text(self.status(lastError={"atMs": now, "message": "Disk full."})), "Last backup failed: Disk full.")
        self.assertEqual((asb.count_text(1, "machine"), asb.count_text(2, "machine"), asb.count_text(3071, "hour")),
                         ("1 machine", "2 machines", "3,071 hours"))
        self.assertEqual(asb.backup_made_text({"machines": 3, "hours": 3071}, "asb-usage-2026-10-27.json"),
                         "Saved the usage of 3 machines (3,071 hours) to asb-usage-2026-10-27.json.")
        self.assertEqual(asb.backup_made_text({"machines": 1, "hours": 1}, "a.json"), "Saved the usage of 1 machine (1 hour) to a.json.")
        self.assertEqual(asb.usage_import_text({"machines": [{"machineId": "a", "name": "homeLP", "hours": 1497},
                                                             {"machineId": "b", "name": "workLP", "hours": 62}]}),
                         "Imported the usage of 2 machines: homeLP (1,497 hours), workLP (62 hours).")
        self.assertEqual(asb.usage_import_text({"machines": [{"machineId": "a", "name": "atlas", "hours": 1}]}),
                         "Imported the usage of 1 machine: atlas (1 hour).")
        self.assertEqual(asb.backup_settings_body(1, 4, 30, 3.0, ""), {"enabled": True, "time": "04:30", "keep": 3, "folder": ""})
        self.assertEqual(asb.backup_settings_body(False, 0, 5, 30, "/x"), {"enabled": False, "time": "00:05", "keep": 30, "folder": "/x"})
        self.assertEqual(asb.usage_export_name(self.local_ms(2026, 10, 27, 0, 30)), "asb-usage-2026-10-27.json")

    def test_backup_days_follow_the_local_zone(self):
        previous = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "<-03>3"
            time.tzset()
            utc = lambda *parts: int(datetime(*parts, tzinfo=timezone.utc).timestamp() * 1000)
            now = utc(2026, 10, 27, 2, 0)  # 23:00 on 26 October in UTC-3.
            self.assertEqual(asb.backup_when(utc(2026, 10, 26, 6, 0), now), "Today at 03:00")
            self.assertEqual(asb.backup_when(utc(2026, 10, 26, 2, 0), now), "Yesterday at 23:00")
            self.assertEqual(asb.backup_next_text(self.status(nextAtMs=utc(2026, 10, 27, 6, 0)), now), "Next backup: tomorrow at 03:00.")
            self.assertEqual(asb.usage_export_name(now), "asb-usage-2026-10-26.json")
        finally:
            if previous is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = previous
            time.tzset()

    def test_export_usage_file_writes_through_a_private_temporary_file(self):
        document = {"format": "asb-usage-export", "version": 1, "exportedAtMs": 1,
                    "machines": [{"machineId": "a", "name": "atlas", "records": [[1], [2], [3]]},
                                 {"machineId": "b", "name": "homeLP", "records": [[4]]}]}
        routes = []
        def reply(value):
            def request(base, route, *args):
                routes.append((base, route) + args)
                return json.loads(json.dumps(value))
            return request
        with TemporaryDirectory() as folder:
            target = os.path.join(folder, "asb-usage-2026-10-27.json")
            with patch.dict(SCOPE, {"request_json": reply(document)}):
                self.assertEqual(asb.export_usage_file("http://127.0.0.1:1", target),
                                 "Saved the usage of 2 machines (4 hours) to asb-usage-2026-10-27.json.")
            self.assertEqual(routes, [("http://127.0.0.1:1", "/api/usage/export")])
            self.assertEqual(Path(target).read_text(), json.dumps(document, separators=(",", ":")))
            if os.name == "posix":
                self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)
            self.assertEqual(os.listdir(folder), ["asb-usage-2026-10-27.json"])
            # A folder in the place of the file: the replace fails, and the temporary file goes.
            blocked = os.path.join(folder, "blocked.json")
            os.mkdir(blocked)
            with patch.dict(SCOPE, {"request_json": reply(document)}):
                with self.assertRaises(RuntimeError) as caught:
                    asb.export_usage_file("http://127.0.0.1:1", blocked)
            self.assertRegex(str(caught.exception), r"^Cannot save blocked\.json: .+\.$")
            self.assertEqual(sorted(os.listdir(folder)), ["asb-usage-2026-10-27.json", "blocked.json"])
            with patch.dict(SCOPE, {"request_json": reply(document)}):
                with self.assertRaisesRegex(RuntimeError, r"^Cannot save x\.json: No such file or directory\.$"):
                    asb.export_usage_file("http://127.0.0.1:1", os.path.join(folder, "missing", "x.json"))
            with patch.dict(SCOPE, {"request_json": reply(document)}), patch.object(os, "fdopen", side_effect=OSError()):
                with self.assertRaisesRegex(RuntimeError, r"^Cannot save x\.json: an error\.$"):
                    asb.export_usage_file("http://127.0.0.1:1", os.path.join(folder, "x.json"))
            self.assertEqual(sorted(os.listdir(folder)), ["asb-usage-2026-10-27.json", "blocked.json"])
            for value in ({**document, "format": "other"}, {**document, "machines": {}}, {**document, "machines": [{"records": {}}]},
                          {"machines": []}, None, [], "not an object"):
                with patch.dict(SCOPE, {"request_json": reply(value)}):
                    with self.assertRaisesRegex(RuntimeError, r"^This ASB engine gave an invalid usage export\.$"):
                        asb.export_usage_file("http://127.0.0.1:1", os.path.join(folder, "y.json"))
            self.assertEqual(sorted(os.listdir(folder)), ["asb-usage-2026-10-27.json", "blocked.json"])
            # O_EXCL must not overwrite or remove a file if the random temporary name collides.
            temporary = Path(folder, "collision.json.abcdef123456.tmp")
            temporary.write_text("keep this file")
            with patch.dict(SCOPE, {"request_json": reply(document)}), \
                    patch.object(SCOPE["uuid"], "uuid4", return_value=SimpleNamespace(hex="abcdef1234560000")):
                with self.assertRaisesRegex(RuntimeError, r"^Cannot save collision\.json: File exists\.$"):
                    asb.export_usage_file("http://127.0.0.1:1", str(Path(folder, "collision.json")))
            self.assertEqual(temporary.read_text(), "keep this file")
            with patch.dict(SCOPE, {"request_json": Mock(side_effect=RuntimeError("This ASB engine has no usage backups."))}):
                with self.assertRaisesRegex(RuntimeError, "no usage backups"):
                    asb.export_usage_file("http://127.0.0.1:1", os.path.join(folder, "y.json"))

    def test_import_usage_file_checks_the_file_and_posts_the_document(self):
        document = {"format": "asb-usage-export", "version": 1, "exportedAtMs": 1, "machines": []}
        result = {"machines": [{"machineId": "a", "name": "homeLP", "hours": 1497}, {"machineId": "b", "name": "workLP", "hours": 62}]}
        with TemporaryDirectory() as folder:
            path = os.path.join(folder, "usage.json")
            Path(path).write_text(json.dumps(document))
            request = Mock(return_value=result)
            with patch.dict(SCOPE, {"request_json": request}):
                self.assertEqual(asb.import_usage_file("http://127.0.0.1:1", path),
                                 "Imported the usage of 2 machines: homeLP (1,497 hours), workLP (62 hours).")
            request.assert_called_once_with("http://127.0.0.1:1", "/api/usage/import", "POST", document)
            for reply in (None, [], {}, {"machines": {}}, {"machines": [{"name": "x"}]}, {"machines": [{"name": 1, "hours": 1}]},
                          {"machines": [{"machineId": 1, "name": "atlas", "hours": 1}]},
                          {"machines": [{"machineId": "a", "name": "atlas", "hours": True}]}):
                with patch.dict(SCOPE, {"request_json": Mock(return_value=reply)}):
                    with self.assertRaisesRegex(RuntimeError, r"^The usage import response is not valid\.$"):
                        asb.import_usage_file("http://127.0.0.1:1", path)
            with patch.dict(SCOPE, {"request_json": Mock(side_effect=RuntimeError("This file is not an ASB usage export."))}):
                with self.assertRaisesRegex(RuntimeError, r"^This file is not an ASB usage export\.$"):
                    asb.import_usage_file("http://127.0.0.1:1", path)
            request = Mock()
            large = os.path.join(folder, "large.json")
            with open(large, "wb"):
                pass
            os.truncate(large, 64 * 1024 * 1024 + 1)
            for name, content in (("text.json", b"not json"), ("list.json", b"[1, 2]"), ("bytes.json", b"\xff\xfe")):
                Path(folder, name).write_bytes(content)
            with patch.dict(SCOPE, {"request_json": request}):
                for name, text in (("large.json", "The file is too large for an ASB usage export."),
                                   ("missing.json", "Cannot read missing.json."), ("text.json", "This file is not an ASB usage export."),
                                   ("list.json", "This file is not an ASB usage export."), ("bytes.json", "This file is not an ASB usage export.")):
                    with self.subTest(name=name):
                        with self.assertRaises(RuntimeError) as caught:
                            asb.import_usage_file("http://127.0.0.1:1", os.path.join(folder, name))
                        self.assertEqual(str(caught.exception), text)
                if os.name == "posix":
                    with self.assertRaisesRegex(RuntimeError, r"^Cannot read sub\.$"):
                        os.mkdir(os.path.join(folder, "sub"))
                        asb.import_usage_file("http://127.0.0.1:1", os.path.join(folder, "sub"))
            request.assert_not_called()


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
        editor.generation, editor.poll_timer, editor.form_loaded = 0, None, None
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
        missing = "The phone address 10.147.17.4 is not on this PC now. ASB listens on it when it appears."
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
        self.assertEqual(asb.phone_address_rows([lan], ["10.147.17.4", "192.168.50.4"]), [
            {"address": "192.168.50.4", "title": "Home network", "subtitle": "192.168.50.4"},
            {"address": "10.147.17.4", "title": "Not on this PC now", "subtitle": "10.147.17.4 · ASB listens on it when it appears"}])
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
        # A runner without PyGObject has no gi: fake it with working cairo support.
        pygobject = SimpleNamespace(require_foreign=Mock())
        code = Mock(get_matrix=Mock(return_value=[[True, False], [False, True]]))
        module = SimpleNamespace(QRCode=Mock(return_value=code), constants=SimpleNamespace(ERROR_CORRECT_M=17))
        with patch.dict("sys.modules", {"qrcode": module, "gi": pygobject}):
            self.assertEqual(asb.qr_matrix("asb://pair?v=1"), [[True, False], [False, True]])
        pygobject.require_foreign.assert_called_once_with("cairo")
        module.QRCode.assert_called_once_with(error_correction=17, border=4)
        code.add_data.assert_called_once_with("asb://pair?v=1")
        code.make.assert_called_once_with(fit=True)

    def test_qr_helper_returns_none_without_pygobject_cairo_support(self):
        pygobject = SimpleNamespace(require_foreign=Mock(side_effect=ImportError("Could not import foreign library 'cairo'")))
        module = SimpleNamespace(QRCode=Mock(), constants=SimpleNamespace(ERROR_CORRECT_M=17))
        with patch.dict("sys.modules", {"qrcode": module, "gi": pygobject}):
            self.assertIsNone(asb.qr_matrix("asb://pair?v=1"))
        pygobject.require_foreign.assert_called_once_with("cairo")
        module.QRCode.assert_not_called()

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

    def test_machine_texts_view_and_join_link_summary(self):
        member = {"machineId": "8c41e9d27b3a05f6", "name": "laptop", "online": True, "lastOkAtMs": NOW,
                  "addresses": [{"kind": "lan", "address": "192.168.1.24"}, {"kind": "zerotier", "address": "10.147.20.31"}]}
        self.assertEqual(asb.machine_status_text({**member, "isSelf": True}), "This machine")
        self.assertEqual(asb.machine_status_text(member), "Online")
        self.assertEqual(asb.machine_status_text({**member, "online": False}, NOW + 3 * 3_600_000 + 600_000),
                         "Offline · last seen 3h ago")
        self.assertEqual(asb.machine_status_text({**member, "online": False, "lastOkAtMs": 0}, NOW), "Offline")
        self.assertEqual(asb.machine_addresses_text(member), "192.168.1.24 (Home network) · 10.147.20.31 (ZeroTier)")
        self.assertEqual(asb.machine_addresses_text({"addresses": [{"kind": "wireguard", "address": "10.9.0.2"}]}),
                         "10.9.0.2 (wireguard)")
        self.assertEqual(asb.machine_addresses_text({"addresses": []}), "")
        self.assertEqual(asb.machine_member_subtitle(member, NOW),
                         "Online · ID 8c41e9d2\n192.168.1.24 (Home network) · 10.147.20.31 (ZeroTier)")
        self.assertEqual(asb.machine_member_subtitle({**member, "addresses": []}, NOW), "Online · ID 8c41e9d2")
        self.assertEqual(asb.machine_phones_text([]), "")
        self.assertEqual(asb.machine_phones_text([{"name": "Pixel 8"}, {"name": "Tablet"}]),
                         "Phones in the group: Pixel 8, Tablet. A phone paired on one machine works with all of them.")
        own = {"machineId": "3f9a2c71e0b4d58a", "name": "atlas", "isSelf": True}
        studio = {**member, "machineId": "51b7f0aa3c8e2d9b", "name": "studio", "online": False}
        self.assertEqual(asb.machines_view({"groupId": "", "networkEnabled": True, "members": []}),
                         {"off": False, "grouped": False, "others": [], "add": True, "join": True,
                          "join_visible": True, "leave_visible": False})
        self.assertEqual(asb.machines_view({"groupId": "7d2e91c4b06fa358", "networkEnabled": False,
                                            "members": [studio, own, member]}),
                         {"off": True, "grouped": True, "others": [studio, member], "add": False, "join": False,
                          "join_visible": False, "leave_visible": True})
        self.assertEqual(asb.machine_confirm_body(["laptop"], "studio"),
                         "studio leaves the group. This PC and laptop stop showing its sessions, and it stops showing theirs. "
                         "To join again, studio must reset its identity first.")
        self.assertEqual(asb.machine_confirm_body([], "studio"),
                         "studio leaves the group. This PC stops showing its sessions, and it stops showing theirs. "
                         "To join again, studio must reset its identity first.")
        self.assertEqual(asb.machine_confirm_body(["laptop", "studio"]),
                         "This PC stops showing the sessions of laptop and studio, and they stop showing its sessions. "
                         "Phones that were paired on another machine stop working with this PC.")
        self.assertEqual(asb.machine_confirm_body(["a", "b", "c"]).split(",")[0:2], ["This PC stops showing the sessions of a", " b and c"])
        self.assertEqual(asb.machine_confirm_body([]), "Phones that were paired on another machine stop working with this PC.")
        fingerprint = "3f9a2c71e0b4d58a6c13f7e29b0d4a8851c6e3f70a9b2d4e8c1f5a7b3e6d9c20"
        link = ("asb://join?v=1&g=7d2e91c4b06fa358&a=lan:192.168.1.10,zerotier:10.147.20.12&p=4630"
                f"&f={fingerprint}&c=Q3vX9kR2mT7wLp4sN8bYc1HfDj6Ga0Ze5Uo&n=atlas")
        self.assertEqual(asb.join_link_summary(link), {"name": "atlas", "fingerprint": fingerprint})
        self.assertEqual(asb.join_link_summary(" \n" + link + "\n "), {"name": "atlas", "fingerprint": fingerprint})
        for bad in ("", "atlas", "asb://pair?v=1", link + "&n=atlas", link.replace("v=1", "v=2"),
                    link.replace(fingerprint, fingerprint[:63]), link.replace(fingerprint, fingerprint.upper()),
                    link.replace("n=atlas", "n=-atlas"), link.replace("n=atlas", "n=at%20las"), link.replace("&p=4630", ""),
                    link + "&x=1", link.replace("p=4630", "p=4630=1"), link.replace("p=4630", "p")):
            with self.subTest(bad=bad):
                self.assertIsNone(asb.join_link_summary(bad))
        with patch.object(SCOPE["time"], "localtime", side_effect=lambda seconds: SCOPE["time"].gmtime(seconds)):
            self.assertEqual(asb.machine_invite_text(NOW + 600_000),
                             "On the other machine, open Preferences > Machines, select Join a group, and paste this link. "
                             "The link works once and ends at " + SCOPE["time"].strftime("%H:%M", SCOPE["time"].gmtime(NOW / 1000 + 600)) + ".")

    def test_machine_group_http_token_replies_errors_and_timeouts(self):
        import io
        token = "ef" * 32
        for route, method, timeout in (("/api/group", "GET", 15), ("/api/group/invite", "POST", 15), ("/api/group/remove", "POST", 15),
                                       ("/api/group/join", "POST", 30), ("/api/group/leave", "POST", 30)):
            with self.subTest(route=route):
                transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"groupId": ""}')))
                with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
                    self.assertEqual(asb.request_json("http://127.0.0.1:1", route, method, {}), {"groupId": ""})
                request = transport.open.call_args.args[0]
                self.assertEqual(request.get_header("X-asb-source-token"), token)
                self.assertEqual(transport.open.call_args.kwargs["timeout"], timeout)
        transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{}')))
        with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": token}):
            asb.request_json("http://127.0.0.1:1", "/api/groupx")
            self.assertIsNone(transport.open.call_args.args[0].get_header("X-asb-source-token"))
            self.assertEqual(transport.open.call_args.kwargs["timeout"], 15)
        for payload, message in ((b'{"error":"This name is taken.","suggestion":"laptop-2"}', "This name is taken. Try the name laptop-2."),
                                 (b'{"error":"This name is taken.","suggestion":"-bad name"}', "This name is taken."),
                                 (b'{"error":"This name is taken.","suggestion":7}', "This name is taken."),
                                 (b'{"suggestion":"laptop-2"}', "Cannot load or change the machine group. "
                                                                 "Check that ASB is running, then try again.")):
            failure = SCOPE["HTTPError"]("http://127.0.0.1:1/api/group/join", 409, "Conflict", {}, io.BytesIO(payload))
            with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=failure))}):
                with self.assertRaises(RuntimeError) as raised:
                    asb.request_json("http://127.0.0.1:1", "/api/group/join", "POST", {"link": "", "name": ""})
            self.assertEqual(str(raised.exception), message)
        with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=OSError()))}):
            with self.assertRaisesRegex(RuntimeError, "^Cannot load or change the machine group. Check that ASB is running, then try again.$"):
                asb.request_json("http://127.0.0.1:1", "/api/group")

    def test_status_refresh_keeps_form_edits_and_lists_device_dates(self):
        editor = self.editor()
        device = {"id": "a", "name": "Test <phone> & tablet", "createdAtMs": NOW, "lastSeenAtMs": NOW - 60_000}
        row = Mock()
        gtk = SimpleNamespace(CheckButton=Mock(side_effect=lambda **kwargs: Mock(
                                  active=kwargs["active"], get_active=Mock(return_value=kwargs["active"]))),
                              Button=Mock(), Align=SimpleNamespace(CENTER=0),
                              AccessibleProperty=SimpleNamespace(LABEL=0))
        editor.enabled.get_active.return_value, editor.port.get_value.return_value = True, 4630
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
            # The saved ZeroTier address is absent now; it stays selected so Apply keeps it.
            self.assertEqual(list(editor.address_checks), ["192.168.50.4", "100.101.102.103", "10.147.17.4"])
            self.assertEqual([check.active for check in editor.address_checks.values()], [False, True, True])
            self.assertEqual([(call.kwargs["title"], call.kwargs["subtitle"]) for call in SCOPE["Adw"].ActionRow.call_args_list],
                             [("Home network", "192.168.50.4"), ("Tailscale", "100.101.102.103 · Works away from home"),
                              ("Not on this PC now", "10.147.17.4 · ASB listens on it when it appears")])
            self.assertIs(SCOPE["Adw"].ActionRow.call_args.kwargs["activatable_widget"], editor.address_checks["10.147.17.4"])
            self.assertEqual(editor.address_list.append.call_count, 3)
            editor.address_list.set_visible.assert_called_with(True)
            editor.address_note.set_visible.assert_called_with(False)
            editor.port.set_value.assert_called_once_with(4630)
            editor.render_status(self.status(addresses=[], bindAddresses=[]), True)
            self.assertEqual(editor.address_checks, {})
            editor.address_list.set_visible.assert_called_with(False)
            editor.address_note.set_label.assert_called_with(asb.phone_address_note([]))
            editor.address_note.set_visible.assert_called_with(True)
            editor.empty.set_visible.assert_called_with(True)

    def test_phone_form_values_keep_unsaved_edits_and_else_follow_the_server(self):
        status = self.status(port=4631, bindAddresses=["192.168.50.4", "10.147.17.4"])
        server = (True, 4631, ["192.168.50.4", "10.147.17.4"])
        self.assertEqual(asb.phone_form_values(None, (False, 4630, []), status), server)
        self.assertEqual(asb.phone_form_values((True, 4630, ["10.147.17.4", "192.168.50.4"]),
                                               (True, 4630, ["192.168.50.4", "10.147.17.4"]), status), server)
        edited = (True, 4632, ["192.168.50.4"])
        self.assertEqual(asb.phone_form_values((True, 4630, ["192.168.50.4", "10.147.17.4"]), edited, status), edited)

    def test_phone_pane_reopen_keeps_edits_shows_new_addresses_unchecked_and_follows_an_unedited_form(self):
        editor = self.editor()
        lan = {"address": "192.168.50.4", "interface": "enp0s1", "kind": "lan"}
        zerotier = {"address": "10.147.17.4", "interface": "ztabcdef12", "kind": "zerotier"}
        tailscale = {"address": "100.101.102.103", "interface": "tailscale0", "kind": "tailscale"}
        gtk = SimpleNamespace(CheckButton=Mock(side_effect=lambda **kwargs: Mock(
                                  active=kwargs["active"], get_active=Mock(return_value=kwargs["active"]))),
                              Button=Mock(), Align=SimpleNamespace(CENTER=0), AccessibleProperty=SimpleNamespace(LABEL=0))
        actions = Mock(side_effect=lambda **kwargs: Mock(title=kwargs["title"]))
        editor.address_list.get_first_child.return_value = None
        checks = lambda: {address: check.get_active() for address, check in editor.address_checks.items()}
        with patch.dict(SCOPE, {"Gtk": gtk, "Adw": SimpleNamespace(ActionRow=actions)}):
            editor.render_status(self.status(addresses=[lan], bindAddresses=["192.168.50.4"]), True)
            self.assertEqual(checks(), {"192.168.50.4": True})
            # An unedited form follows the server.
            editor.enabled.get_active.return_value, editor.port.get_value.return_value = True, 4630
            editor.render_status(self.status(addresses=[lan, zerotier], port=4631,
                                             bindAddresses=["192.168.50.4", "10.147.17.4"]), True)
            self.assertEqual(checks(), {"192.168.50.4": True, "10.147.17.4": True})
            editor.port.set_value.assert_called_with(4631)
            # The user unchecks ZeroTier and changes the port, then the pane opens again with a new address.
            editor.address_checks["10.147.17.4"].get_active.return_value = False
            editor.enabled.get_active.return_value, editor.port.get_value.return_value = False, 4632
            editor.render_status(self.status(addresses=[lan, zerotier, tailscale], port=4631,
                                             bindAddresses=["192.168.50.4", "10.147.17.4"]), True)
            self.assertEqual(checks(), {"192.168.50.4": True, "10.147.17.4": False, "100.101.102.103": False})
            editor.port.set_value.assert_called_with(4632)
            editor.enabled.set_active.assert_called_with(False)
            # A checked address that went away stays checked as "Not on this PC now".
            editor.render_status(self.status(addresses=[zerotier, tailscale], port=4631,
                                             bindAddresses=["192.168.50.4", "10.147.17.4"]), True)
            self.assertEqual(checks(), {"10.147.17.4": False, "100.101.102.103": False, "192.168.50.4": True})
            self.assertEqual(actions.call_args.kwargs["title"], "Not on this PC now")
            editor.port.set_value.assert_called_with(4632)

    def test_each_phone_pane_open_reads_the_addresses_and_form_again(self):
        editor = self.editor()
        editor.active, editor.preferences, editor.owner = False, SimpleNamespace(closed=False), SimpleNamespace(closed=False)
        editor.render_status = Mock(side_effect=lambda *_args: setattr(editor, "loaded", True))
        request, glib = Mock(), SimpleNamespace(idle_add=Mock(), source_remove=Mock())
        with patch.dict(SCOPE, {"request_async": request, "GLib": glib}):
            for count in (1, 2):
                editor.set_active(True)
                self.assertEqual(request.call_count, count)
                self.assertEqual(request.call_args.args[1], "/api/phone")
                request.call_args.args[2](self.status(), None)
                editor.render_status.assert_called_with(self.status(), True)
                editor.set_active(False)

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
        preferences.profiles_editor = preferences.phone_editor = preferences.machines_editor = preferences.usage_editor = None
        preferences.phone, preferences.machines, preferences.usage = Mock(), Mock(), Mock()
        preferences.pages = Mock(get_visible_child_name=Mock(return_value="section"))
        preferences.stack = Mock(get_visible_child_name=Mock(return_value="sessions"))
        preferences.get_visible = Mock(return_value=True)
        preferences.get_mapped = Mock(return_value=True)
        editor, machines, usage = Mock(), Mock(), Mock()
        with patch.dict(SCOPE, {"PhoneEditor": Mock(return_value=editor), "MachinesEditor": Mock(return_value=machines),
                                "UsageBackupEditor": Mock(return_value=usage)}):
            preferences.section_changed()
            SCOPE["PhoneEditor"].assert_not_called()
            preferences.stack.get_visible_child_name.return_value = "phone"
            preferences.section_changed()
            preferences.section_changed()
            SCOPE["PhoneEditor"].assert_called_once_with(preferences.owner, preferences)
            preferences.phone.append.assert_called_once_with(editor)
            editor.set_active.assert_called_with(True)
            preferences.pages.get_visible_child_name.return_value = "list"
            preferences.section_changed()
            editor.set_active.assert_called_with(False)
            preferences.pages.get_visible_child_name.return_value = "section"
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
            SCOPE["MachinesEditor"].assert_not_called()
            preferences.get_visible.return_value = True
            preferences.stack.get_visible_child_name.return_value = "machines"
            preferences.section_changed()
            preferences.section_changed()
            SCOPE["MachinesEditor"].assert_called_once_with(preferences.owner, preferences)
            preferences.machines.append.assert_called_once_with(machines)
            machines.set_active.assert_called_with(True)
            editor.set_active.assert_called_with(False)
            preferences.stack.get_visible_child_name.return_value = "phone"
            preferences.section_changed()
            machines.set_active.assert_called_with(False)
            SCOPE["UsageBackupEditor"].assert_not_called()
            preferences.stack.get_visible_child_name.return_value = "usage"
            preferences.section_changed()
            preferences.section_changed()
            SCOPE["UsageBackupEditor"].assert_called_once_with(preferences.owner, preferences)
            preferences.usage.append.assert_called_once_with(usage)
            usage.set_active.assert_called_with(True)
            editor.set_active.assert_called_with(False)
            machines.set_active.assert_called_with(False)
            preferences.get_mapped.return_value = False
            preferences.section_changed()
            usage.set_active.assert_called_with(False)
            preferences.get_mapped.return_value = True
            preferences.section_changed()
            usage.set_active.assert_called_with(True)
            preferences.stack.get_visible_child_name.return_value = "machines"
            preferences.section_changed()
            usage.set_active.assert_called_with(False)
            SCOPE["UsageBackupEditor"].assert_called_once()
            preferences.cancel_dialogs, preferences.destroy = Mock(), Mock()
            preferences.dispose()
            usage.close.assert_called_once_with()


class DataChecks(unittest.TestCase):
    def test_realize_disables_x11_frame_feedback_only_on_composited_displays(self):
        constructor = next(node for node in WINDOW.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        hooks = [node for node in ast.walk(constructor) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == "connect"
                 and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "realize"
                 and isinstance(node.args[1], ast.Attribute)]
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
        # A limited remote row keeps the limit look and says where it runs: "workLP · 4h32m", or "Resets 4h32m · workLP".
        remote = {**row, "canOpen": False, "remote": True, "machineName": "workLP", "limitResetsAtMs": NOW + 16_330_000}
        self.assertEqual(asb.view_only_tone(remote), "")
        for view, state, where in (("comfortable", "Resets in", "workLP ·"), ("compact", "Resets 4h32m", "· workLP")):
            window.view = view
            window.clear_read_feedback = window.update_card_actions = window.update_drawer_style = Mock()
            classes = set()
            widget = SimpleNamespace(asb_view=view, asb_thread={}, asb_time_signature=None, set_activatable=Mock(), asb_mark=Mock(),
                                     asb_source_badge=Mock(), asb_where_icon=Mock() if view == "comfortable" else None,
                                     asb_where_label=Mock(), asb_dot=Mock(), asb_folder=Mock(), asb_state_label=Mock(),
                                     asb_age_label=Mock(), asb_title_label=Mock(), asb_limit_clock=Mock(),
                                     add_css_class=classes.add, remove_css_class=classes.discard, set_sensitive=Mock(),
                                     update_property=Mock(), update_state=Mock())
            SCOPE["set_icon"].reset_mock()
            with patch.dict(SCOPE, {"Gtk": gtk}):
                window.update_session_row(widget, remote)
                window.update_row_text(widget, NOW)  # The row update uses the real clock.
            widget.asb_where_label.set_label.assert_called_with(where)
            widget.asb_state_label.set_label.assert_called_with(state)
            if view == "comfortable":
                SCOPE["set_icon"].assert_any_call(widget.asb_where_icon, "asb-machine-symbolic")
                widget.asb_age_label.set_label.assert_called_with("4h32m")
            self.assertEqual(classes & {"asb-limited", "asb-view-only-quiet", "asb-view-only-rest"}, {"asb-limited"})
            self.assertEqual(widget.asb_accessible_label,
                             "Session Chat in Codex. Idle. Usage limit. Resets in 4 hours 32 minutes. On workLP. View only.")

    def test_view_only_rows_where_and_grey_tone(self):
        remote = {"remote": True, "machineName": "homeLP", "surface": "app"}
        cli = {"surface": "cli", "machineName": "This PC"}
        for row, view_only, where in ((remote, True, ("asb-machine-symbolic", "homeLP")),
                                      (cli, True, ("asb-terminal-symbolic", "CLI")),
                                      ({**remote, "surface": "cli"}, True, ("asb-machine-symbolic", "homeLP")),
                                      ({**remote, "machineName": ""}, True, ("asb-machine-symbolic", "another machine")),
                                      ({"surface": "app", "remote": False}, False, (None, "")),
                                      ({"provider": "opencode", "surface": "app", "canOpen": False}, False, (None, "")),
                                      ({}, False, (None, ""))):
            self.assertEqual((asb.is_view_only(row), asb.row_where(row)), (view_only, where))
        tone = asb.view_only_tone
        for extra, expected in (({"state": "idle"}, "rest"), ({"state": "unknown"}, "rest"), ({"state": "working"}, "quiet"),
                                ({"state": "waiting"}, "rest"), ({"state": "idle", "unread": True}, ""),
                                ({"state": "waiting", "questionAttention": True}, ""), ({"state": "idle", "pending": True}, ""),
                                ({"state": "idle", "limitResetsAtMs": NOW}, "")):
            self.assertEqual(tone({**cli, **extra}), expected)
            self.assertEqual(tone({**remote, **extra}), expected)
        self.assertEqual(tone({"state": "idle", "surface": "app"}), "")
        # The card shows the where text and the tone classes in both views; a desktop row hides them.
        window = object.__new__(Window)
        window.clear_read_feedback = window.update_card_actions = window.update_row_text = window.update_drawer_style = Mock()
        window.open_errors = {}
        for view in ("comfortable", "compact"):
            window.view = view
            classes = set()
            widget = SimpleNamespace(asb_view=view, asb_thread={}, set_activatable=Mock(), asb_mark=Mock(), asb_source_badge=Mock(),
                                     asb_where_icon=Mock() if view == "comfortable" else None, asb_where_label=Mock(),
                                     asb_dot=Mock(), asb_state_label=Mock(), asb_folder=Mock(),
                                     add_css_class=classes.add, remove_css_class=classes.discard)
            base = {"id": "a", "provider": "claude-desktop-code", "canOpen": False, "unread": False, "pending": False}
            for row, label, icon, css in (({**base, **cli, "state": "idle"}, "CLI", "asb-terminal-symbolic",
                                           {"asb-view-only-quiet", "asb-view-only-rest"}),
                                          ({**base, **remote, "state": "working"}, "homeLP", "asb-machine-symbolic", {"asb-view-only-quiet"}),
                                          ({**base, **cli, "state": "idle", "unread": True}, "CLI", "asb-terminal-symbolic", set()),
                                          ({**base, "canOpen": True, "state": "idle"}, "", None, set())):
                SCOPE["set_icon"].reset_mock()
                window.update_session_row(widget, row)
                widget.asb_where_label.set_label.assert_called_with(("" if not label else label + " ·") if view == "comfortable"
                                                                     else ("" if not label else "· " + label))
                widget.asb_where_label.set_visible.assert_called_with(bool(label))
                if view == "comfortable":
                    widget.asb_where_icon.set_visible.assert_called_with(bool(label))
                    if icon:
                        SCOPE["set_icon"].assert_called_with(widget.asb_where_icon, icon)
                SCOPE["set_icon"].assert_any_call(widget.asb_mark, "asb-claude-symbolic")
                self.assertEqual(classes & {"asb-view-only-quiet", "asb-view-only-rest"}, css)
                widget.set_activatable.assert_called_with(row["canOpen"])
        # A Working remote card offers no discard; a local CLI card keeps the offer.
        window.view = "comfortable"
        widget.asb_view, widget.asb_thread = "comfortable", {}
        widget.asb_where_icon = Mock()
        for row, offer in (({**base, **remote, "state": "working"}, False), ({**base, **cli, "state": "working"}, True)):
            window.update_session_row(widget, row)
            widget.asb_dot.set_visible.assert_called_with(offer)

    def test_bad_card_values_do_not_stop_the_render(self):
        window = object.__new__(Window)
        window.clear_read_feedback = window.update_card_actions = window.update_row_text = window.update_drawer_style = Mock()
        window.open_errors = {}
        window.view = "compact"
        widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(), asb_mark=Mock(), asb_source_badge=Mock(),
                                 asb_where_icon=None, asb_where_label=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
                                 asb_folder=Mock(), add_css_class=Mock(), remove_css_class=Mock())
        # A member row with no provider.
        window.update_session_row(widget, {"id": "m:a:1", "remote": True, "state": "idle"})
        # A reset time past the largest JavaScript date.
        self.assertEqual(asb.tooltip_model({"state": "idle", "limitResetsAtMs": 1e20}, NOW, "/home/u")["limit"], "")

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
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact", "cardLimit": 100, "copyKind": "relative"})
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
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact", "cardLimit": 100, "copyKind": "relative"})

    def test_view_setting_legacy_width_save_and_reset(self):
        with TemporaryDirectory(prefix="asb-view-test-") as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps({"version": 1, "columnWidth": 180}))
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "compact", "cardLimit": 100, "copyKind": "relative"})
            asb.write_layout(path, 180, "comfortable")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "comfortable", "cardLimit": 100, "copyKind": "relative"})
            asb.write_layout(path, 320)
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable", "cardLimit": 100, "copyKind": "relative"})
            asb.write_layout(path)
            self.assertTrue(path.exists())
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable", "cardLimit": 100, "copyKind": "relative"})
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                asb.write_layout(path, 240, "unknown")
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            asb.write_layout(path, 240, "compact")
            asb.write_layout(path)
            self.assertFalse(path.exists())

    def test_layout_accepts_legacy_show_app_pills_and_never_writes_it(self):
        with TemporaryDirectory(prefix="asb-toolbar-layout-") as directory:
            path = Path(directory) / "layout.json"
            # ASB does not use the old value, so any value loads.
            for value in (0, 1, "true", None, [], {}):
                path.write_text(json.dumps({"version": 1, "columnWidth": 240, "showAppPills": value}))
                self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "compact", "cardLimit": 100, "copyKind": "relative"})
            path.write_text(json.dumps({"version": 1, "columnWidth": 240, "showAppPills": True}))
            self.assertNotIn("showAppPills", asb.read_layout(path))
            asb.write_layout(path, 180, "compact")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 180, "view": "compact", "cardLimit": 100, "copyKind": "relative"})
            self.assertNotIn("showAppPills", json.loads(path.read_text()))
            asb.write_layout(path, 320, "comfortable")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable", "cardLimit": 100, "copyKind": "relative"})
            self.assertNotIn("showAppPills", json.loads(path.read_text()))
            asb.write_layout(path)
            self.assertTrue(path.exists())
            self.assertEqual(asb.read_layout(path)["columnWidth"], 240)
            self.assertNotIn("showAppPills", json.loads(path.read_text()))
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                asb.write_layout(path, 240, "compact", "false")
            self.assertEqual(path.read_bytes(), before)
            window = object.__new__(Window)
            window.column_width, window.view, window.layout_path, window.copy_kind = 180, "comfortable", path, "relative"
            window.card_limit, window.layout_error, window.dragging = 100, Mock(), False
            window.width_control = Mock(set_value=Mock(side_effect=lambda width: setattr(window, "column_width", width)))
            window.reset_width()
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable", "cardLimit": 100, "copyKind": "relative"})
            window.save_width()
            self.assertNotIn("showAppPills", json.loads(path.read_text()))

    def test_card_limit_layout_validation_and_setting_preservation(self):
        with TemporaryDirectory(prefix="asb-card-limit-layout-") as directory:
            path = Path(directory) / "layout.json"
            path.write_text(json.dumps({"version": 1, "columnWidth": 240}))
            self.assertEqual(asb.read_layout(path)["cardLimit"], 100)
            for value in (50, 100, 200, 500, 0):
                asb.write_layout(path, 240, card_limit=value)
                self.assertEqual(asb.read_layout(path)["cardLimit"], value)
                self.assertEqual("cardLimit" in json.loads(path.read_text()), value != 100)
            previous = path.read_bytes()
            for invalid in (1, "100", True, False, 101, -1, None, [], 100.0):
                path.write_bytes(previous)
                if invalid is not None:
                    with self.assertRaises(ValueError):
                        asb.write_layout(path, 240, card_limit=invalid)
                    self.assertEqual(path.read_bytes(), previous)
                path.write_text(json.dumps({"version": 1, "columnWidth": 240, "cardLimit": invalid}))
                with self.assertRaisesRegex(ValueError, "Cards on the board must be 50, 100, 200, 500, or All."):
                    asb.read_layout(path)
            path.write_text(json.dumps({"version": 1, "columnWidth": 240, "cardLimit": 200}))
            asb.write_layout(path, 320)
            asb.write_layout(path, 320, "comfortable")
            asb.write_layout(path, 320, "comfortable")
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable", "cardLimit": 200, "copyKind": "relative"})
            window = object.__new__(Window)
            window.column_width, window.view, window.layout_path, window.copy_kind = 320, "comfortable", path, "relative"
            window.card_limit, window.layout_error, window.dragging = 200, Mock(), False
            window.width_control = Mock(set_value=Mock(side_effect=lambda width: setattr(window, "column_width", width)))
            window.reset_width()
            self.assertEqual(asb.read_layout(path), {"columnWidth": 240, "view": "comfortable", "cardLimit": 200, "copyKind": "relative"})
            window.save_width()
            self.assertEqual(asb.read_layout(path)["cardLimit"], 200)
            # The delete branch keeps a file that holds a limit other than the default.
            path.write_text(json.dumps({"version": 1, "columnWidth": 240, "cardLimit": 0}))
            asb.write_layout(path)
            self.assertEqual(asb.read_layout(path)["cardLimit"], 0)
            asb.write_layout(path, card_limit=100)
            self.assertFalse(path.exists())
            # The Preferences control: the same value does nothing, a failed save selects the old value again.
            window.card_limit, window.show_all_cards, window.copy_kind = 100, True, "relative"
            window.card_limit_setting, window.card_limit_error, window.filter_changed = Mock(get_selected=Mock(return_value=1)), Mock(), Mock()
            window.change_card_limit()
            window.filter_changed.assert_not_called()
            self.assertFalse(path.exists())
            window.card_limit_setting.get_selected.return_value = 2
            window.change_card_limit()
            self.assertEqual((window.card_limit, window.show_all_cards, asb.read_layout(path)["cardLimit"]), (200, False, 200))
            window.card_limit_error.set_label.assert_called_with("")
            window.filter_changed.assert_called_once_with()
            window.card_limit_setting.get_selected.return_value = 4
            with patch.dict(SCOPE, {"write_layout": Mock(side_effect=OSError("Save failed"))}):
                window.change_card_limit()
            self.assertEqual(window.card_limit, 200)
            window.card_limit_setting.set_selected.assert_called_once_with(2)
            window.card_limit_error.set_label.assert_called_with("Save failed")
            window.filter_changed.assert_called_once_with()

    def test_copy_kind_layout_validation_and_setting_preservation(self):
        with TemporaryDirectory(prefix="asb-copy-kind-layout-") as directory:
            path = Path(directory) / "layout.json"
            self.assertEqual(asb.read_layout(path)["copyKind"], "relative")
            path.write_text(json.dumps({"version": 1, "columnWidth": 240}))
            self.assertEqual(asb.read_layout(path)["copyKind"], "relative")
            asb.write_layout(path, 240, copy_kind="absolute")
            self.assertEqual(asb.read_layout(path)["copyKind"], "absolute")
            self.assertEqual(json.loads(path.read_text())["copyKind"], "absolute")
            # A Relative kind is the default and is not written.
            asb.write_layout(path, 240, copy_kind="relative")
            self.assertEqual(asb.read_layout(path)["copyKind"], "relative")
            self.assertNotIn("copyKind", json.loads(path.read_text()))
            previous = path.read_bytes()
            for invalid in ("session", "Relative", "ABSOLUTE", 1, True, None, [], {}):
                path.write_bytes(previous)
                if invalid is not None:
                    with self.assertRaises(ValueError):
                        asb.write_layout(path, 240, copy_kind=invalid)
                    self.assertEqual(path.read_bytes(), previous)
                path.write_text(json.dumps({"version": 1, "columnWidth": 240, "copyKind": invalid}))
                with self.assertRaisesRegex(ValueError, "Copy kind must be Relative or Absolute."):
                    asb.read_layout(path)
            path.write_text(json.dumps({"version": 1, "columnWidth": 240, "copyKind": "absolute"}))
            asb.write_layout(path, 320)
            asb.write_layout(path, 320, "comfortable")
            asb.write_layout(path, 320, "comfortable")
            asb.write_layout(path, 320, "comfortable", card_limit=200)
            self.assertEqual(asb.read_layout(path), {"columnWidth": 320, "view": "comfortable",
                                                     "cardLimit": 200, "copyKind": "absolute"})
            # A default layout is deleted; an Absolute kind keeps the file.
            asb.write_layout(path, copy_kind="absolute")
            self.assertTrue(path.exists())
            self.assertEqual(json.loads(path.read_text())["copyKind"], "absolute")
            asb.write_layout(path)
            self.assertTrue(path.exists())
            self.assertEqual(asb.read_layout(path)["copyKind"], "absolute")
            path.write_text(json.dumps({"version": 1, "columnWidth": 240}))
            asb.write_layout(path, copy_kind="relative")
            self.assertFalse(path.exists())
            window = object.__new__(Window)
            window.column_width, window.view, window.layout_path = 240, "compact", path
            window.card_limit, window.layout_error, window.dragging, window.copy_kind = 100, Mock(), False, "absolute"
            window.width_control = Mock(set_value=Mock(side_effect=lambda width: setattr(window, "column_width", width)))
            window.save_width()
            self.assertEqual(asb.read_layout(path)["copyKind"], "absolute")
            window.reset_width()
            self.assertEqual(asb.read_layout(path)["copyKind"], "absolute")
            # A failed save keeps the old kind and shows the error.
            window.copy_kind = "relative"
            window.set_notice = Mock()
            with patch.dict(SCOPE, {"write_layout": Mock(side_effect=OSError("Save failed"))}):
                window.change_copy_kind("absolute")
            self.assertEqual(window.copy_kind, "relative")
            window.layout_error.set_label.assert_called_with("Save failed")
            window.set_notice.assert_called_once_with("Save failed", temporary=True)
            window.change_copy_kind("absolute")
            self.assertEqual((window.copy_kind, asb.read_layout(path)["copyKind"]), ("absolute", "absolute"))
            self.assertEqual(window.change_copy_kind("absolute"), None)

    def test_card_copy_kind_rule_for_local_remote_and_missing_values(self):
        full = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:123e4567-e89b-12d3-a456-426614174000"
        short = "codex/123e4567-e89b-12d3-a456-426614174000"
        local = {"id": "x", "externalId": "123e4567-e89b-12d3-a456-426614174000", "provider": "codex",
                 "sessionReference": short, "reference": full}
        remote = {**local, "id": "m:0123456789abcdef:x", "remote": True, "machineName": "homeLP"}
        self.assertEqual(asb.card_copy(local), (short, None, "relative"))
        self.assertEqual(asb.card_copy(local, "relative"), (short, None, "relative"))
        self.assertEqual(asb.card_copy(local, "absolute"), (full, None, "absolute"))
        # A remote row copies the Absolute reference whatever the board kind is.
        self.assertEqual(asb.card_copy(remote), (full, None, "absolute"))
        self.assertEqual(asb.card_copy(remote, "relative"), (full, None, "absolute"))
        self.assertEqual(asb.card_copy(remote, "absolute"), (full, None, "absolute"))
        self.assertEqual(asb.copy_relative_reason(remote), "Relative works only on this machine. This session runs on homeLP.")
        self.assertEqual(asb.copy_relative_reason({**remote, "machineName": None}),
                         "Relative works only on this machine. This session runs on another machine.")
        # A missing value keeps the disabled rule: no value, the reason, and the kind that was asked for.
        broken = {"id": "b", "title": "Chat", "externalId": "bad id", "provider": "codex",
                  "referenceUnavailable": "invalid-app-id"}
        self.assertEqual(asb.card_copy(broken), (None, "This session has an ID in a form that ASB does not know.", "relative"))
        self.assertEqual(asb.card_copy(broken, "absolute"), (None, "This session has an ID in a form that ASB does not know.", "absolute"))
        self.assertEqual(asb.card_copy(remote, "relative")[1], None)

    def test_copy_rest_and_wheel_notch_rules(self):
        self.assertIs(asb.validate_copy_kind("relative"), "relative")
        self.assertIs(asb.validate_copy_kind("absolute"), "absolute")
        for bad in ("session", "", None, 1):
            with self.assertRaises(ValueError):
                asb.validate_copy_kind(bad)
        # The pointer must rest 250 ms before the wheel may switch the kind.
        self.assertFalse(asb.copy_rest_ready(None, 10.0))
        self.assertFalse(asb.copy_rest_ready(10.0, 10.0))
        self.assertFalse(asb.copy_rest_ready(10.0, 10.249))
        self.assertTrue(asb.copy_rest_ready(10.0, 10.25))
        self.assertTrue(asb.copy_rest_ready(10.0, 11.0))
        # The tag show (rest or keyboard focus) also arms the wheel.
        self.assertFalse(asb.copy_wheel_captured(None, 10.0))
        self.assertFalse(asb.copy_wheel_captured(10.0, 10.1))
        self.assertTrue(asb.copy_wheel_captured(10.0, 10.3))
        self.assertTrue(asb.copy_wheel_captured(None, 10.0, tag_shown=True))
        self.assertTrue(asb.copy_wheel_captured(None, 10.0, keyboard_focus=True))
        # A wheel notch is 1.0. Hi-res fractions add up to one notch; one large event is still one step.
        state = dict(asb.COPY_WHEEL_STATE)
        step, state = asb.copy_wheel_step(state, 1.0, 1.0)
        self.assertEqual(step, 1)
        step, state = asb.copy_wheel_step(state, -1.0, 1.1)
        self.assertEqual(step, -1)
        state = dict(asb.COPY_WHEEL_STATE)
        for tick in range(3):
            step, state = asb.copy_wheel_step(state, .25, 1.0 + tick * .01)
            self.assertEqual(step, 0, tick)
        step, state = asb.copy_wheel_step(state, .25, 1.04)
        self.assertEqual((step, state["acc"]), (1, 0.0))
        state = dict(asb.COPY_WHEEL_STATE)
        step, state = asb.copy_wheel_step(state, .5, 1.0)
        self.assertEqual(step, 0)
        step, state = asb.copy_wheel_step(state, .5, 1.01)
        self.assertEqual(step, 1)
        state = dict(asb.COPY_WHEEL_STATE)
        step, state = asb.copy_wheel_step(state, 2.0, 1.0)
        self.assertEqual((step, state["acc"]), (1, 0.0))
        step, state = asb.copy_wheel_step(state, .1, 1.01)
        self.assertEqual(step, 0)
        state = dict(asb.COPY_WHEEL_STATE)
        step, state = asb.copy_wheel_step(state, .5, 1.0)
        step, state = asb.copy_wheel_step(state, -.5, 1.01)
        self.assertEqual(step, 0)
        state = dict(asb.COPY_WHEEL_STATE)
        step, state = asb.copy_wheel_step(state, .5, 1.0)
        step, state = asb.copy_wheel_step(state, .5, 1.1)
        self.assertEqual(step, 1)
        state = dict(asb.COPY_WHEEL_STATE)
        step, state = asb.copy_wheel_step(state, .5, 1.0)
        step, state = asb.copy_wheel_step(state, .5, 1.3)
        self.assertEqual(step, 0)
        # Smooth trackpad deltas accumulate to one step per burst.
        state = dict(asb.COPY_WHEEL_STATE)
        for tick in range(9):
            step, state = asb.copy_wheel_step(state, 3, 1.0 + tick * .01, surface=True)
            self.assertEqual(step, 0, tick)
        step, state = asb.copy_wheel_step(state, 3, 1.10, surface=True)
        self.assertEqual(step, 1)
        step, state = asb.copy_wheel_step(state, 3, 1.11, surface=True)
        self.assertEqual(step, 0)
        # A gap opens a new burst, and a negative burst steps down.
        step, state = asb.copy_wheel_step(state, -30, 1.5, surface=True)
        self.assertEqual(step, -1)
        step, _state = asb.copy_wheel_step(state, 0, 1.6, surface=True)
        self.assertEqual(step, 0)

    def test_the_keyboard_copy_tag_goes_with_the_focus_after_a_pointer_rest_elsewhere(self):
        def button():
            tag = SimpleNamespace(shown=False)
            tag.set_reveal_child = lambda value: setattr(tag, "shown", value)
            return SimpleNamespace(asb_card_action="copy", asb_tag=tag, asb_tag_shown=False, asb_rest_at=None,
                                   asb_card=None, get_ancestor=lambda _type: None)
        a, b, c = button(), button(), button()
        other = SimpleNamespace(asb_card_action="drawer", get_ancestor=lambda _type: None)
        window = object.__new__(Window)
        window.copy_hover = window.copy_rest_timer = window.copy_focus_button = window.key_focus_row = None
        focus = {"widget": None, "visible": True}
        window.get_focus = lambda: focus["widget"]
        window.get_focus_visible = lambda: focus["visible"]
        def move_focus(widget):
            focus["widget"] = widget
            window.key_focus_changed()
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(timeout_add=Mock(return_value=9), source_remove=Mock()),
                                "Gtk": SimpleNamespace(ListBoxRow=object)}):
            move_focus(a)
            self.assertTrue(a.asb_tag.shown)
            # The pointer rests on B and leaves it; A keeps the focus and its tag.
            window.copy_button_enter(SimpleNamespace(get_widget=lambda: b), 0, 0)
            window.copy_tag_due(b)
            window.copy_button_leave(SimpleNamespace(get_widget=lambda: b))
            self.assertEqual((a.asb_tag.shown, b.asb_tag.shown), (True, False))
            move_focus(other)
            self.assertEqual((a.asb_tag.shown, b.asb_tag.shown), (False, False))
            self.assertIsNone(window.copy_focus_button)
            # The focus goes from one copy button to the next: only the new one shows its tag.
            move_focus(a)
            move_focus(c)
            self.assertEqual((a.asb_tag.shown, c.asb_tag.shown, window.copy_focus_button), (False, True, c))
            # The pointer is on C when the focus leaves: the tag stays until the pointer leaves.
            window.copy_button_enter(SimpleNamespace(get_widget=lambda: c), 0, 0)
            move_focus(other)
            self.assertEqual((c.asb_tag.shown, window.copy_focus_button), (True, None))
            window.copy_button_leave(SimpleNamespace(get_widget=lambda: c))
            self.assertFalse(c.asb_tag.shown)

    def test_limit_rows_keeps_the_first_rows_and_one_more_row(self):
        rows = [{"id": f"r{index}", "updatedAtMs": 1000 - index if index != 7 else 5000, "canOpen": True} for index in range(10)]
        before = copy.deepcopy(rows)
        for limit, show_all in ((10, False), (12, False), (0, False), (3, True)):
            self.assertIs(asb.limit_rows(rows, limit, show_all), rows)
        limited = asb.limit_rows(rows, 4)
        self.assertEqual([row["id"] for row in limited], ["r0", "r1", "r2", "r3", asb.MORE_ID])
        self.assertEqual(limited[-1], {"id": "asb:more", "provider": "", "providerLabel": "", "title": "More sessions",
                                       "state": "idle", "canOpen": False, "updatedAtMs": 5000, "asbMore": 6, "asbLimit": 4,
                                       "asbFirst": "r4"})
        self.assertEqual(asb.limit_rows(rows, 9)[-1]["asbMore"], 1)
        self.assertEqual(rows, before)
        self.assertEqual((asb.DEFAULT_CARD_LIMIT, [value for value, _title in asb.CARD_LIMITS]), (100, [50, 100, 200, 500, 0]))
        bounds = {row["id"]: (0, 22 * index, 240, 22) for index, row in enumerate(limited)}
        self.assertNotIn(asb.MORE_ID, asb.number_key_rows(limited, bounds, (600, 600)))
        self.assertEqual(asb.number_key_rows(limited, bounds, (600, 600)), ["r0", "r1", "r2", "r3"])

    def test_filtered_rows_keeps_the_first_row_of_each_id(self):
        # One card for each ID: a card twice in one column makes GTK list it twice, with no warning.
        board = {"threads": [
            {"id": "a", "title": "first copy", "state": "idle", "updatedAtMs": 10},
            {"id": "b", "title": "other", "state": "idle", "updatedAtMs": 20},
            {"id": "a", "title": "second copy", "state": "idle", "pending": True, "updatedAtMs": 30},
            {"id": "c", "title": "archived copy", "state": "idle", "archived": True, "updatedAtMs": 40},
            {"id": "c", "title": "shown copy", "state": "idle", "updatedAtMs": 5}]}
        self.assertEqual([(row["id"], row["title"]) for row in asb.filtered_rows(board)],
                         [("b", "other"), ("a", "first copy"), ("c", "shown copy")])
        # The first row that the filters keep wins, also with the archive filter and a search.
        self.assertEqual([(row["id"], row["title"]) for row in asb.filtered_rows(board, archived=True)],
                         [("c", "archived copy"), ("b", "other"), ("a", "first copy")])
        self.assertEqual([(row["id"], row["title"]) for row in asb.filtered_rows(board, query="copy")],
                         [("a", "first copy"), ("c", "shown copy")])
        self.assertEqual([row["title"] for row in asb.limit_rows(asb.filtered_rows(board), 2)], ["other", "first copy", "More sessions"])

    def test_filter_chip_groups_clear_only_their_constraint(self):
        model = ({"machine": "", "machineName": "This machine", "apps": (
            {"provider": "codex", "profiles": ({"key": "|codex-1", "label": "Work", "color": "#112233"},)},
            {"provider": "claude-desktop-code", "profiles": ({"key": "|claude-1", "label": "Main", "color": ""},)},
        )},)
        chips = asb.filter_chips
        self.assertEqual(chips(False, set(), set(), model, False, limit=0), ())
        self.assertEqual(chips(True, {"working"}, {"|codex-1"}, model, True, limit=0), (
            ("pending", "Pending", "Remove filter: Pending", ""),
            ("state:working", "Working", "Remove filter: Working", ""),
            ("profile:|codex-1", "Work", "Remove filter: Work", "#112233"),
            ("archive", "Include archived", "Remove filter: Include archived", "")))
        self.assertEqual(chips(False, {"idle", "working"}, set(), model, False, limit=0), (
            ("state:working", "Working", "Remove filter: Working", ""),
            ("state:idle", "Idle", "Remove filter: Idle", "")))
        self.assertEqual(chips(False, set(), set(), model, False, limit=200), ())
        self.assertEqual(chips(False, set(), set(), model, False, show_all=True), (("all", "All cards", "Show only the first 100 cards", ""),))
        self.assertEqual(chips(False, set(), set(), model, False, show_all=True, limit=200),
                         (("all", "All cards", "Show only the first 200 cards", ""),))
        self.assertEqual(chips(False, set(), set(), model, False, show_all=True, limit=0), ())
        window = object.__new__(Window)
        window.pending, window.archived = True, True
        window.states, window.profiles = {"working"}, {"|claude-1"}
        window.filter_model = model
        window.show_all_cards = False
        window.card_limit = 100
        window.get_focus = lambda: None
        window.filter_chip_widgets = {}
        window.filter_changed = Mock()
        window.set_pending = lambda on: setattr(window, "pending", bool(on))
        window.set_archived = lambda on: setattr(window, "archived", bool(on))
        window.clear_filter_chip(None, "pending")
        self.assertFalse(window.pending)
        window.clear_filter_chip(None, "state:working")
        self.assertEqual(window.states, set())
        window.clear_filter_chip(None, "profile:|claude-1")
        self.assertEqual(window.profiles, set())
        window.clear_filter_chip(None, "archive")
        self.assertFalse(window.archived)
        window.show_all_cards = True
        window.clear_filter_chip(None, "all")
        self.assertFalse(window.show_all_cards)
        window.filter_changed.assert_called()
    def test_filter_chips_reuse_controls_and_keep_full_state_names(self):
        window = object.__new__(Window)
        window.pending, window.archived = False, True
        window.states, window.profiles = {"working", "waiting", "unknown"}, set()
        window.filter_model = ()
        window.show_all_cards, window.card_limit = False, 0
        window.chip_box = Mock()
        window.filter_popover = None
        window.filter_chip_signature = None
        window.filter_chip_widgets = {}
        window.get_settings = lambda: SimpleNamespace(get_property=lambda _name: False)
        window.get_mapped = lambda: False
        window.update_filters_pill = Mock()
        window.make_filter_chip = Mock(side_effect=lambda key, title, detail, color, animations, after=None: (Mock(asb_chip_dot=Mock(), set_tooltip_text=Mock(), update_property=Mock()), Mock()))
        window.scroll_chip_into_view = lambda: False
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(idle_add=lambda fn: fn()),
                                "Gtk": SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL="label"))}):
            window.sync_filter_chips()
            self.assertEqual(set(window.filter_chip_widgets), {"state:working", "state:waiting", "state:unknown", "archive"})
            window.make_filter_chip.reset_mock()
            window.sync_filter_chips()
            window.make_filter_chip.assert_not_called()
            window.states = set()
            window.sync_filter_chips()
            self.assertEqual(set(window.filter_chip_widgets), {"archive"})

    def test_escape_collapses_search_at_every_width_and_keeps_filters(self):
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
            # The wide Board has no search field in the toolbar: typing and Escape use the popover too.
            window.wide_controls = True
            self.assertTrue(window.window_key(None, ord("a"), 0, 0))
            self.assertEqual((text[0], window.search_expanded, window.search_popover.popup.call_count), ("xa", True, 2))
            self.assertTrue(window.window_key(None, 27, 0, 0))
            self.assertEqual((text[0], window.search_expanded, window.search_popover.popdown.call_count), ("", False, 2))

    def test_chip_clear_restores_keyboard_focus_and_preferences_search_raises_main(self):
        window = object.__new__(Window)
        chips = {key: (Mock(), Mock()) for key in ("state:working", "archive")}
        window.filter_chip_widgets, window.filters_pill = chips, Mock()
        window.get_focus = lambda: chips["state:working"][0]
        window.states, window.profiles = {"working"}, set()
        window.pending, window.archived = False, True
        window.show_all_cards, window.card_limit = False, 100
        window.filter_changed = Mock()
        window.set_archived = lambda on: setattr(window, "archived", on)
        window.clear_filter_chip(chips["state:working"][0], "state:working")
        self.assertNotIn("working", window.states)
        chips["archive"][0].grab_focus.assert_called_once_with()
        chips["archive"][0].grab_focus.reset_mock()
        # When only the removed chip remains in the widget map, focus falls to Filters.
        window.filter_chip_widgets = {"state:working": chips["state:working"]}
        window.states = {"working"}
        window.clear_filter_chip(chips["state:working"][0], "state:working")
        window.filters_pill.grab_focus.assert_called_once_with()
        window.preferences_window, window.present, window.open_search = Mock(), Mock(), Mock()
        window.open_search_from_preferences()
        window.preferences_window.set_visible.assert_called_once_with(False)
        window.present.assert_called_once_with()
        window.open_search.assert_called_once_with()

    def test_a_profile_that_leaves_the_model_leaves_no_chip_and_no_filter(self):
        def row(identity, remote=False):
            value = {"id": identity, "provider": "codex", "state": "idle", "title": identity, "updatedAtMs": 1,
                     "sourceId": "codex", "machineName": "laptop"}
            if remote:
                value.update(remote=True, machineId="m1", machineName="studio", sourceLabel="Codex")
            return value
        providers = [{"id": "codex", "provider": "codex", "label": "Codex"}]
        window = object.__new__(Window)
        window.closed = window.loading = window.refresh_queued = window.refresh_force_queued = False
        window.refresh_button, window.preferences_window, window.snapshot_pending = Mock(), None, False
        window.signature, window.dashboard, window.filter_model = None, None, ()
        window.pending, window.archived, window.states, window.profiles = False, False, set(), set()
        window.show_all_cards, window.card_limit = False, 100
        window.refresh_interval_ms = 5000
        for name in ("set_notice", "report_ui", "sync_unread_setting", "render", "play_messages", "update_clock",
                     "sync_filter_chips", "filter_changed"):
            setattr(window, name, Mock())
        window.apply_dashboard({"providers": providers, "threads": [row("local-1"), row("m:m1:a", remote=True)]}, None, [None])
        window.profiles.add("m1|codex")
        self.assertEqual([chip[1] for chip in window.active_filter_chips()], ["Codex · studio"])
        window.sync_filter_chips.reset_mock()
        # The studio machine leaves: its profile goes from the filter and from the chips.
        window.apply_dashboard({"providers": providers, "threads": [row("local-1")]}, None, [None])
        window.sync_filter_chips.assert_called_once_with()
        self.assertEqual(window.profiles, set())
        # A click on the old chip only removes a filter.
        chip = Mock()
        window.filter_chip_widgets, window.get_focus = {"profile:m1|codex": (chip, Mock())}, lambda: None
        window.clear_filter_chip(chip, "profile:m1|codex")
        self.assertEqual(window.profiles, set())
        window.filter_changed.assert_called_once_with()
        # A local profile leaves and the thread list stays the same: the rows render again.
        threads = window.dashboard["threads"]
        window.apply_dashboard({"providers": providers + [{"id": "codex-2", "provider": "codex", "label": "Two"}],
                                "threads": threads}, None, [None])
        window.profiles.add("|codex-2")
        window.sync_filter_chips.reset_mock()
        window.render.reset_mock()
        window.apply_dashboard({"providers": providers, "threads": threads}, None, [None])
        self.assertEqual(window.profiles, set())
        window.sync_filter_chips.assert_called_once_with()
        window.render.assert_called_once_with()

    def test_an_old_filters_popover_row_adds_no_profile_that_left_the_model(self):
        window = object.__new__(Window)
        window.filter_model = asb.filter_profiles({"providers": [{"id": "codex", "provider": "codex", "label": "Codex"}],
                                                   "threads": []})
        window.profiles = set()
        window.filter_changed, window.sync_filters_popover_checks = Mock(), Mock()
        window.filter_row_toggled(SimpleNamespace(get_active=lambda: True), "profile:m9|codex")
        self.assertEqual(window.profiles, set())
        window.sync_filters_popover_checks.assert_called_once_with()
        window.filter_row_toggled(SimpleNamespace(get_active=lambda: True), "profile:|codex")
        self.assertEqual(window.profiles, {"|codex"})
        window.filter_row_toggled(SimpleNamespace(get_active=lambda: False), "profile:|codex")
        self.assertEqual(window.profiles, set())

    def test_toolbar_presentation_keeps_fixed_corners_and_the_search_in_its_popover(self):
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
        window.preferences_refresh_row, window.refresh_button = Control(), Control()
        window.menu_button, window.window_controls = Control(), Control()
        window.toolbar_center.append(window.search_button)
        window.toolbar_center.append(window.toolbar_scroll)
        window.toolbar_end.append(window.menu_button)
        window.toolbar_end.append(window.window_controls)
        window.preferences_refresh_row.append(window.refresh_button)
        window.search_popover.set_child(window.search)
        window.get_focus = lambda: None
        window.update_toolbar_presentation()
        self.assertIs(window.search.get_parent(), window.search_popover)
        self.assertIs(window.refresh_button.get_parent(), window.preferences_refresh_row)
        self.assertTrue(window.search_button.visible)
        window.wide_controls = True
        window.update_toolbar_presentation()
        self.assertIs(window.search.get_parent(), window.search_popover)
        self.assertIs(window.refresh_button.get_parent(), window.toolbar_end)
        self.assertEqual(window.toolbar_end.children[:2], [window.refresh_button, window.menu_button])
        self.assertTrue(window.search_button.visible)
        with patch.object(window.toolbar_end, "remove", wraps=window.toolbar_end.remove) as remove:
            window.update_toolbar_presentation()
            remove.assert_not_called()
        window.wide_controls, window.tiny_controls = False, True
        window.update_toolbar_presentation()
        self.assertFalse(window.app_mark.visible)
        self.assertFalse(window.search_button.visible)
        self.assertIs(window.search.get_parent(), window.search_popover)
        self.assertIs(window.menu_button.get_parent(), window.toolbar_end)
        self.assertIs(window.window_controls.get_parent(), window.toolbar_end)

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

    def test_provider_icon_names_each_app_mark(self):
        self.assertEqual([asb.provider_icon(provider) for provider in ("codex", "claude-desktop-code", "opencode", None)],
                         ["asb-openai-symbolic", "asb-claude-symbolic", "asb-opencode-symbolic", "asb-claude-symbolic"])

    def test_filter_profiles_builds_machine_app_profile_model(self):
        dashboard = {
            "providers": [
                {"id": "codex-1", "label": "Work", "provider": "codex", "color": "#112233", "status": "ok"},
                {"id": "claude-1", "label": "Main", "provider": "claude-desktop-code", "color": "#445566", "status": "ok"},
                {"id": "asb-sources", "label": "Sources", "status": "warning"},
            ],
            "threads": [
                {"id": "local", "provider": "codex", "sourceId": "codex-1", "machineId": "aaaaaaaaaaaaaaaa", "state": "idle"},
                {"id": "r1", "provider": "codex", "sourceId": "codex-r", "remote": True, "machineId": "bbbbbbbbbbbbbbbb",
                 "machineName": "studio", "sourceLabel": "Studio Codex", "sourceColor": "#778899", "sourceNumber": 1, "state": "idle"},
                {"id": "r2", "provider": "claude-desktop-code", "sourceId": "claude-r", "remote": True, "machineId": "bbbbbbbbbbbbbbbb",
                 "machineName": "studio", "sourceLabel": "Studio Claude", "sourceNumber": 2, "state": "idle"},
            ],
        }
        model = asb.filter_profiles(dashboard)
        self.assertEqual(len(model), 2)
        local, remote = model
        self.assertEqual(local["machine"], "")
        self.assertEqual(local["machineName"], "This machine")
        self.assertEqual([(app["provider"], [p["key"] for p in app["profiles"]]) for app in local["apps"]],
                         [("codex", ["|codex-1"]), ("claude-desktop-code", ["|claude-1"])])
        self.assertEqual(local["apps"][0]["profiles"][0]["color"], "#112233")
        self.assertEqual(remote["machine"], "bbbbbbbbbbbbbbbb")
        self.assertEqual(remote["machineName"], "studio")
        self.assertEqual([app["provider"] for app in remote["apps"]], ["codex", "claude-desktop-code"])
        self.assertEqual(remote["apps"][0]["profiles"][0]["key"], "bbbbbbbbbbbbbbbb|codex-r")
        self.assertEqual(remote["apps"][0]["profiles"][0]["label"], "Studio Codex")
        self.assertEqual(remote["apps"][0]["profiles"][0]["color"], "#778899")
        self.assertEqual(asb.row_profile_key({"remote": True, "machineId": "bbbbbbbbbbbbbbbb", "sourceId": "codex-r"}),
                         "bbbbbbbbbbbbbbbb|codex-r")
        self.assertEqual(asb.row_profile_key({"remote": False, "machineId": "aaaaaaaaaaaaaaaa", "sourceId": "codex-1"}), "|codex-1")
        self.assertEqual(asb.row_profile_key({"provider": "opencode"}), "|opencode")
        # A single-profile app is one row; a multi-profile app is a header plus indented rows.
        multi = {"providers": [
            {"id": "a", "label": "A", "provider": "codex", "color": "#111111", "status": "ok"},
            {"id": "b", "label": "B", "provider": "codex", "color": "#222222", "status": "ok"},
            {"id": "c", "label": "C", "provider": "opencode", "color": "", "status": "ok"},
        ], "threads": []}
        apps = asb.filter_profiles(multi)[0]["apps"]
        self.assertEqual([(app["provider"], len(app["profiles"])) for app in apps], [("codex", 2), ("opencode", 1)])

    def test_filtered_rows_uses_profile_groups_and_empty_states_as_all(self):
        board = {"threads": [
            {"id": "w", "provider": "codex", "sourceId": "c1", "state": "working", "pending": True},
            {"id": "i", "provider": "codex", "sourceId": "c1", "state": "idle"},
            {"id": "u", "provider": "claude-desktop-code", "sourceId": "k1", "state": "working", "unread": True},
            {"id": "r", "provider": "codex", "sourceId": "c2", "remote": True, "machineId": "m1", "state": "idle"},
        ]}
        self.assertEqual({row["id"] for row in asb.filtered_rows(board)}, {"w", "i", "u", "r"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, state=set())}, {"w", "i", "u", "r"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, profiles={"|c1"})}, {"w", "i"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, profiles={"|c1", "|k1"})}, {"w", "i", "u"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, profiles={"m1|c2"})}, {"r"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, profiles={"|c1"}, state="idle")}, {"i"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, pending_only=True)}, {"w"})
        self.assertEqual({row["id"] for row in asb.filtered_rows(board, pending_only=True, state={"working"})}, {"w", "u"})

    def test_filtered_rows_sorts_a_read_waiting_row_with_the_idle_rows(self):
        board = {"threads": [
            {"id": "done", "state": "idle", "pending": True, "updatedAtMs": 500},
            {"id": "asks", "state": "waiting", "pending": True, "questionAttention": True, "updatedAtMs": 400},
            {"id": "approve", "state": "waiting", "pending": True, "actionRequired": True, "updatedAtMs": 300},
            {"id": "work", "state": "working", "workingSinceMs": 100, "updatedAtMs": 900},
            {"id": "read", "state": "waiting", "pending": False, "updatedAtMs": 800},
            {"id": "old", "state": "idle", "pending": False, "updatedAtMs": 200},
        ]}
        self.assertEqual([row["id"] for row in asb.filtered_rows(board)], ["done", "asks", "approve", "work", "read", "old"])

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
        for prefix in ("oc:", "opencode:", " OC : ", "OpenCode:", "  opencode  :  "):
            with self.subTest(prefix=prefix):
                self.assertEqual(asb.provider_query(prefix + " Calm Squid", "codex"), ("calm squid", "opencode"))
        self.assertEqual(asb.provider_query("ocx: text"), ("ocx: text", "all"))
        opencode = {"threads": [{**FIXTURE["threads"][0], "id": "oc", "provider": "opencode", "providerLabel": "OpenCode"},
                                {**FIXTURE["threads"][0], "id": "cx"}]}
        self.assertEqual([row["id"] for row in asb.filtered_rows(opencode, "OC:", app="codex")], ["oc"])
        self.assertEqual(asb.filtered_rows(literal, "notes: <b>")[0]["id"], "literal")

    def test_combined_states_and_asb_pin_order(self):
        board = copy.deepcopy(FIXTURE)
        selected = asb.filtered_rows(board, state={"working", "idle"})
        self.assertEqual([row["id"] for row in selected], ["second", "first"])
        self.assertEqual([row["id"] for row in asb.filtered_rows(board, state=set())],
                         ["second", "claude:local_mock", "first", "unknown"])
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

    def test_messages_wait_for_card_motion_and_keep_bounded_unique_pending_pairs(self):
        window = object.__new__(Window)
        window.closed = False
        window.motion_columns = []
        ends = [(1, 4, False), (1, 2, False)]
        window.list_body = SimpleNamespace(motion={"a": (0, 20, 0)}, flights=[],
                                           message_ends=Mock(return_value=ends), start_flight=Mock())
        window.focus_widgets = {"a": Mock(), "b": Mock()}
        window.get_settings = lambda: SimpleNamespace(get_property=lambda _name: True)
        window.light_row, window.message_color = Mock(), Mock(return_value="accent")
        pairs = [("a", "b", 1), ("b", "a", 2)]
        idle = Mock()
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(idle_add=idle), "Gsk": SimpleNamespace(PathBuilder=object)}):
            self.assertFalse(window.start_messages(pairs))
            window.list_body.start_flight.assert_not_called()
            window.light_row.assert_not_called()
            self.assertEqual(window.pending_messages, pairs)
            window.start_messages(pairs)
            self.assertEqual(window.pending_messages, pairs)
            window.advance_motion(.5)
            idle.assert_not_called()
            window.advance_motion(0)
            idle.assert_called_once_with(window.start_messages, pairs)
            self.assertEqual(window.pending_messages, [])
            self.assertEqual(window.list_body.motion, {})
            window.advance_motion(0)
            self.assertEqual(idle.call_count, 1)
            callback, pending = idle.call_args.args
            callback(pending)
            self.assertEqual(window.list_body.start_flight.call_count, 2)

            # Both fallback modes wait too; the checks run again at the end of the motion.
            for animations, gsk in ((False, SimpleNamespace(PathBuilder=object)), (True, SimpleNamespace())):
                window.get_settings = lambda: SimpleNamespace(get_property=lambda _name: animations)
                window.list_body.motion = {"a": (0, 20, 0)}
                window.light_row.reset_mock()
                idle.reset_mock()
                with patch.dict(SCOPE, {"Gsk": gsk}):
                    window.start_messages(pairs[:1])
                    window.light_row.assert_not_called()
                    window.motion_animation = SimpleNamespace(skip=lambda: window.advance_motion(0))
                    window.cancel_motion()
                    idle.assert_called_once_with(window.start_messages, pairs[:1])
                    idle.call_args.args[0](idle.call_args.args[1])
                    self.assertEqual(window.light_row.call_count, 2)

            window.list_body.motion = {"a": (0, 20, 0)}
            many = [("a", "b", at) for at in range(asb.MESSAGE_FLIGHT_LIMIT + 3)]
            window.start_messages(many[:4])
            window.start_messages(many[2:])
            self.assertEqual(window.pending_messages, many[-asb.MESSAGE_FLIGHT_LIMIT:])
            self.assertEqual(len(set(window.pending_messages)), asb.MESSAGE_FLIGHT_LIMIT)
            idle.reset_mock()
            window.closed = True
            window.advance_motion(0)
            self.assertEqual(window.pending_messages, [])
            idle.assert_not_called()
            window.pending_messages = pairs[:]
            window.start_messages(pairs)
            self.assertEqual(window.pending_messages, [])
            idle.assert_not_called()

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

    def test_messages_light_the_rows_and_start_no_flight_without_gsk_path_builder(self):
        def play(animations, gsk):
            window = object.__new__(Window)
            window.closed = False
            window.get_settings = lambda: SimpleNamespace(get_property=lambda name: animations if name == "gtk-enable-animations" else None)
            window.focus_widgets = {"a": Mock(), "b": Mock()}
            ends = [(1, 2, False), (3, 4, False)]
            window.list_body = SimpleNamespace(flights=[], message_ends=Mock(return_value=ends), start_flight=Mock())
            window.light_row, window.message_color = Mock(), Mock(return_value="accent")
            with patch.dict(SCOPE, {"Gsk": gsk}):
                self.assertFalse(window.start_messages([("a", "b", 1)]))
            return window, ends
        # GTK 4.12 has no Gsk.PathBuilder (GTK 4.14): the rows light, as with animations off.
        for animations in (True, False):
            window, _ends = play(animations, SimpleNamespace())
            self.assertEqual(window.light_row.call_args_list, [call(window.focus_widgets["a"], 2000), call(window.focus_widgets["b"], 2000)])
            window.list_body.start_flight.assert_not_called()
        window, _ends = play(False, SimpleNamespace(PathBuilder=object))
        self.assertEqual(window.light_row.call_args_list, [call(window.focus_widgets["a"], 2000), call(window.focus_widgets["b"], 2000)])
        window.list_body.start_flight.assert_not_called()
        # With animations on and Gsk.PathBuilder, the light flies and only the sender icon shows the accent color at the start.
        window, ends = play(True, SimpleNamespace(PathBuilder=object))
        window.list_body.start_flight.assert_called_once_with(window.focus_widgets["a"], window.focus_widgets["b"], "accent", ends)
        window.light_row.assert_called_once_with(window.focus_widgets["a"], 160)


class SignalHelperChecks(unittest.TestCase):
    def run_helper(self, glib_unix=None, version_error=None):
        """Run the helper with a fake gi, GLib, and GLibUnix. A runner can have no PyGObject, so nothing real loads."""
        import builtins
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
        with patch.dict(SCOPE, {"gi": gi, "GLib": glib}), patch("builtins.__import__", side_effect=fake_import):
            result = SCOPE["unix_signal_add"](0, 15, callback)
        return result, gi, glib, callback, imported

    def test_uses_glibunix_signal_add_when_it_exists(self):
        unix = SimpleNamespace(signal_add=Mock(return_value=7), signal_add_full=Mock())
        result, gi, glib, callback, imported = self.run_helper(unix)
        self.assertEqual(result, 7)
        unix.signal_add.assert_called_once_with(0, 15, callback)
        unix.signal_add_full.assert_not_called()
        glib.unix_signal_add.assert_not_called()
        gi.require_version.assert_called_once_with("GLibUnix", "2.0")

    def test_uses_glib_unix_signal_add_when_glibunix_has_only_signal_add_full(self):
        # GLib 2.84 with PyGObject 3.50 (Debian 13): GLibUnix imports, but it has no signal_add.
        unix = SimpleNamespace(signal_add_full=Mock())
        result, _gi, glib, callback, imported = self.run_helper(unix)
        self.assertEqual(result, 1)
        glib.unix_signal_add.assert_called_once_with(0, 15, callback)
        unix.signal_add_full.assert_not_called()
        self.assertEqual(imported, ["gi.repository"])

    def test_uses_glib_unix_signal_add_when_the_glibunix_import_fails(self):
        result, _gi, glib, callback, imported = self.run_helper(ImportError("cannot import name 'GLibUnix'"))
        self.assertEqual(result, 1)
        glib.unix_signal_add.assert_called_once_with(0, 15, callback)
        self.assertEqual(imported, ["gi.repository"])

    def test_uses_glib_unix_signal_add_when_glibunix_is_not_available(self):
        # GLib before 2.80 (AlmaLinux 9): require_version raises ValueError, and the import is not tried.
        result, gi, glib, callback, imported = self.run_helper(version_error=ValueError("Namespace GLibUnix not available"))
        self.assertEqual(result, 1)
        glib.unix_signal_add.assert_called_once_with(0, 15, callback)
        gi.require_version.assert_called_once_with("GLibUnix", "2.0")
        self.assertEqual(imported, [])


class MachinesDialogChecks(unittest.TestCase):
    def editor(self):
        editor = object.__new__(SCOPE["MachinesEditor"])
        editor.preferences, editor.owner, editor.dialog = SimpleNamespace(closed=False), SimpleNamespace(closed=False), None
        editor.active, editor.loaded, editor.loading, editor.closed = True, True, False, False
        editor.generation, editor.poll_loading, editor.poll_timer = 0, False, None
        editor.bridge, editor.bridge_loading = None, False
        editor.close_invite = Mock()
        return editor

    @staticmethod
    def emit(dialog, name, *args):
        for connected in dialog.connect.call_args_list:
            if connected.args[0] == name:
                connected.args[1](dialog, *args)

    def alert(self, editor, adw):
        clicked = Mock()
        with patch.dict(SCOPE, {"Adw": adw}):
            editor.alert("Remove studio?", "The group keeps the others.", "remove", clicked)
        return clicked

    def adw(self, kind, dialog):
        return SimpleNamespace(**{kind: Mock(return_value=dialog)}, ResponseAppearance=SimpleNamespace(DESTRUCTIVE="destructive"))

    def check_responses(self, dialog):
        self.assertEqual(dialog.add_response.call_args_list, [call("cancel", "Cancel"), call("remove", "Remove")])
        dialog.set_response_appearance.assert_called_once_with("remove", "destructive")
        dialog.set_default_response.assert_called_once_with("cancel")
        dialog.set_close_response.assert_called_once_with("cancel")

    def test_alert_uses_adw_alert_dialog_when_libadwaita_has_it(self):
        editor, dialog = self.editor(), Mock()
        adw = self.adw("AlertDialog", dialog)
        adw.MessageDialog = Mock()
        clicked = self.alert(editor, adw)
        adw.AlertDialog.assert_called_once_with(heading="Remove studio?", body="The group keeps the others.")
        adw.MessageDialog.assert_not_called()
        self.check_responses(dialog)
        dialog.present.assert_called_once_with(editor.preferences)
        self.assertIs(editor.dialog, dialog)
        self.assertEqual([item.args[0] for item in dialog.connect.call_args_list], ["response", "closed"])
        self.emit(dialog, "response", "cancel")
        clicked.assert_not_called()
        self.emit(dialog, "response", "remove")
        clicked.assert_called_once_with()
        self.assertIs(editor.dialog, dialog)
        # A dialog that closes late does not clear a newer dialog.
        newer = Mock()
        editor.dialog = newer
        self.emit(dialog, "closed")
        self.assertIs(editor.dialog, newer)
        editor.dialog = dialog
        self.emit(dialog, "closed")
        self.assertIsNone(editor.dialog)

    def test_alert_uses_adw_message_dialog_without_adw_alert_dialog(self):
        # Libadwaita 1.4: Adw.AlertDialog (1.5) does not exist.
        editor, dialog = self.editor(), Mock()
        adw = self.adw("MessageDialog", dialog)
        clicked = self.alert(editor, adw)
        adw.MessageDialog.assert_called_once_with(transient_for=editor.preferences, modal=True, heading="Remove studio?",
                                                  body="The group keeps the others.")
        self.check_responses(dialog)
        dialog.present.assert_called_once_with()
        self.assertIs(editor.dialog, dialog)
        # The dialog has no closed signal: its two response handlers act on a response, and the dialog closes itself.
        self.assertEqual([item.args[0] for item in dialog.connect.call_args_list], ["response", "response"])
        self.emit(dialog, "response", "remove")
        clicked.assert_called_once_with()
        self.assertIsNone(editor.dialog)
        # A cancel clicks nothing, and a response of an old dialog does not clear a newer dialog.
        clicked.reset_mock()
        editor.dialog = dialog
        self.emit(dialog, "response", "cancel")
        clicked.assert_not_called()
        self.assertIsNone(editor.dialog)
        newer = Mock()
        editor.dialog = newer
        self.emit(dialog, "response", "cancel")
        self.assertIs(editor.dialog, newer)

    def test_hiding_the_page_closes_the_dialog_of_each_kind(self):
        editor, dialog = self.editor(), Mock()
        editor.dialog = dialog
        with patch.dict(SCOPE, {"Adw": SimpleNamespace(AlertDialog=object)}):
            editor.set_active(False)
        dialog.force_close.assert_called_once_with()
        dialog.destroy.assert_not_called()
        # The closed signal of an Adw.AlertDialog clears the dialog later.
        self.assertIs(editor.dialog, dialog)
        editor, dialog = self.editor(), Mock()
        editor.dialog = dialog
        with patch.dict(SCOPE, {"Adw": SimpleNamespace(MessageDialog=object)}):
            editor.set_active(False)
        dialog.destroy.assert_called_once_with()
        dialog.force_close.assert_not_called()
        self.assertIsNone(editor.dialog)
        self.assertEqual((editor.generation, editor.active), (1, False))


class BridgeHelperChecks(unittest.TestCase):
    def test_state_lines_details_actions_cover_every_state_and_unknown_values(self):
        details = {"ready": None, "update": "Update, then restart Codex.",
            "hooks": "In Codex, open Plugins > ASB Bridge, trust both hooks, and restart Codex.",
            "off": "In Codex, open Plugins > ASB Bridge and turn it on.",
            "nobun": "Codex cannot start or resume tasks. Make Bun visible to desktop apps, then restart Codex.",
            "missing": "Install it to let your agents send messages to each other. The board works without it.",
            "conflict": "Run asb bridge status in a terminal to see what is in the way.",
            "old-app": "ASB Bridge needs OpenCode 2.1.2 or later. Update OpenCode.",
            "unknown": "ASB cannot find the Claude folder of this profile."}
        for state in (*asb.BRIDGE_STATES, "future-state"):
            for version in (None, "", "0.8.0", 123):
                for live in (None, 0, 2, -1, True, "2"):
                    with self.subTest(state=state, version=version, live=live):
                        app = {"state": state, "provider": "codex", "version": version, "live": live}
                        text = asb.BRIDGE_STATES.get(state, asb.BRIDGE_STATES["unknown"])[0]
                        if state in ("ready", "update") and version == "0.8.0":
                            text += " · 0.8.0"
                        if type(live) is int and live > 0:
                            text += " · 2 live"
                        self.assertEqual(asb.bridge_state_line(app), text)
                        self.assertEqual(asb.bridge_detail(app), details.get(state, details["unknown"]))
                        for allowed in (False, True):
                            self.assertEqual(asb.bridge_action({**app, "canInstall": allowed}),
                                {"missing": "Install", "update": "Update"}.get(state) if allowed else None)
        for provider, detail in (("claude-desktop-code", "Update. New Claude sessions use it."),
                                 ("opencode", "Update, then restart OpenCode.")):
            self.assertEqual(asb.bridge_detail({"state": "update", "provider": provider}), detail)

    def test_bridge_validation_rejects_bad_shapes_and_self_uses_first_match(self):
        app = {"sourceId": "a", "label": "Codex", "state": "ready"}
        machine = {"name": "atlas", "isSelf": True, "state": "ok", "apps": [app]}
        data = {"api": 1, "machines": [machine]}
        self.assertTrue(asb.bridge_valid(data))
        for value in (None, [], {}, {"api": 1}, {"api": True, "machines": []}, {"api": 2, "machines": []},
                      {"api": 1, "machines": {}}, {"api": 1, "machines": [None]}):
            with self.subTest(value=value):
                self.assertFalse(asb.bridge_valid(value))
        for field, value in (("name", None), ("name", 1), ("isSelf", 1), ("state", None), ("apps", None), ("apps", [None])):
            self.assertFalse(asb.bridge_valid({**data, "machines": [{**machine, field: value}]}))
        for field in ("sourceId", "label", "state"):
            for value in (None, 1, False, []):
                self.assertFalse(asb.bridge_valid({**data, "machines": [{**machine, "apps": [{**app, field: value}]}]}))
        self.assertEqual(asb.bridge_self_apps({"api": 1, "machines": [{**machine, "isSelf": False}, machine,
            {**machine, "apps": [{**app, "sourceId": "later"}]}]}), {"a": app})
        self.assertEqual(asb.bridge_self_apps({"api": 1, "machines": []}), {})

    def test_machine_bridge_line_covers_every_branch_and_phrase(self):
        for machine, text in (({"state": "offline"}, "Bridge: not checked while offline"),
                ({"state": "old"}, "Bridge: unknown, needs ASB 1.12+"),
                ({"state": "old", "live": 2}, "Bridge: unknown, needs ASB 1.12+ · 2 live"),
                ({"state": "old", "live": True}, "Bridge: unknown, needs ASB 1.12+"),
                ({"state": "error", "error": "Try again."}, "Bridge: Try again."),
                ({"state": "error", "error": 2}, "Bridge: ASB cannot check it."),
                ({"state": "error", "error": ""}, "Bridge: ASB cannot check it."),
                ({"state": "checking", "apps": []}, "Bridge: checking…"),
                ({"state": "ok", "checking": True, "apps": []}, "Bridge: checking…"),
                ({"state": "ok", "apps": []}, "Bridge: no app profiles"),
                ({"state": "ok", "apps": [{"label": "A", "state": "missing"}, {"label": "B", "state": "missing"}]}, "Bridge: not installed")):
            with self.subTest(machine=machine):
                self.assertEqual(asb.machine_bridge_line(machine), text)
        apps = [{"label": "Codex", "state": "ready"}, {"label": "Codex Personal", "state": "hooks"},
                {"label": "OpenCode", "state": "update"}]
        self.assertEqual(asb.machine_bridge_line({"state": "ok", "apps": apps}),
                         "Bridge: Codex ready · Codex Personal hooks not trusted · OpenCode old version")
        for state, phrase in (*asb.MACHINE_BRIDGE_PHRASES.items(), ("new", "unknown")):
            apps = [{"label": "A", "state": state}, {"label": "B", "state": "ready"}]
            self.assertEqual(asb.machine_bridge_line({"state": "ok", "apps": apps}), f"Bridge: A {phrase} · B ready")

    def test_bridge_http_token_timeout_success_and_error_texts(self):
        for route, method, timeout, token in (("/api/bridge", "GET", 15, None),
                ("/api/bridge?refresh=1", "GET", 15, None), ("/api/bridge/install", "POST", 420, "fake-token"),
                ("/api/bridge/other", "POST", 15, "fake-token")):
            transport = Mock(open=Mock(side_effect=lambda *_args, **_kwargs: io.BytesIO(b'{"ok": false, "output": "text"}')))
            with patch.dict(SCOPE, {"LOCAL_HTTP": transport, "SOURCE_TOKEN": "fake-token"}):
                self.assertEqual(asb.request_json("http://127.0.0.1:1", route, method, {"sourceId": "main"})["ok"], False)
            request = transport.open.call_args.args[0]
            self.assertEqual(request.get_header("X-asb-source-token"), token)
            self.assertEqual(transport.open.call_args.kwargs["timeout"], timeout)
            if method == "POST":
                self.assertEqual(json.loads(request.data), {"sourceId": "main"})
        for code in (400, 404, 409):
            error = asb.HTTPError("http://127.0.0.1:1/api/bridge/install", code, "Error", {}, io.BytesIO(b'{"error":"Install failed."}'))
            with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=error))}):
                with self.assertRaisesRegex(RuntimeError, "^Install failed\\.$"):
                    asb.request_json("http://127.0.0.1:1", "/api/bridge/install", "POST", {})
        for error in (OSError(), ValueError()):
            with patch.dict(SCOPE, {"LOCAL_HTTP": Mock(open=Mock(side_effect=error))}):
                with self.assertRaisesRegex(RuntimeError, "^Cannot load or change ASB Bridge\\. Check that ASB is running, then try again\\.$"):
                    asb.request_json("http://127.0.0.1:1", "/api/bridge")


class ProfileBridgeChecks(unittest.TestCase):
    def setUp(self):
        self.fixture = ProfileSyncChecks()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.editor = self.fixture.editor()
        del self.editor.request_bridge
        self.request = self.fixture.request

    def reply(self, data=None, error=None):
        self.request.call_args.args[2](data, error)

    def bridge(self, state="missing", can_install=True):
        return {"api": 1, "machines": [{"name": "atlas", "isSelf": True, "state": "ok", "apps": [
            {"sourceId": "main", "label": "Main", "provider": "codex", "state": state, "canInstall": can_install}]}]}

    def test_sources_get_then_bridge_and_manual_refresh_uses_refresh_query(self):
        editor = self.editor
        editor.reload_sources()
        self.fixture.reply(editor.sources, self.fixture.REV_A)
        self.assertEqual(self.request.call_args.args[1], "/api/bridge")
        self.reply(self.bridge())
        self.assertEqual(editor.bridge_apps, {"main": self.bridge()["machines"][0]["apps"][0]})
        self.assertEqual(len(editor.table.children), 2)
        editor.refresh_sources()
        self.assertEqual(self.request.call_args.args[1], "/api/sources")
        self.fixture.reply(editor.sources, self.fixture.REV_A)
        self.assertEqual(self.request.call_args.args[1], "/api/bridge?refresh=1")
        self.reply(self.bridge())
        editor.dialog_message.set_label.assert_called_with("")

    def test_bridge_errors_keep_data_only_refresh_shows_error_and_hide_voids_reply(self):
        editor = self.editor
        editor.request_bridge()
        self.request.assert_called_once()
        editor.request_bridge(True)
        self.request.assert_called_once()
        self.reply(self.bridge())
        # The call made while the first ran starts now, with its refresh.
        self.assertEqual(self.request.call_args.args[1], "/api/bridge?refresh=1")
        self.reply(self.bridge())
        previous = editor.bridge_apps
        for refresh in (False, True):
            for error, result in (("Cannot check.", None), (None, {})):
                editor.message.reset_mock()
                editor.request_bridge(refresh)
                self.reply(result, error)
                self.assertIs(editor.bridge_apps, previous)
                if refresh:
                    editor.message.set_label.assert_called_once_with(error or "The ASB Bridge response is not valid. Try again.")
                else:
                    editor.message.set_label.assert_not_called()
        editor.request_bridge()
        late = self.request.call_args.args[2]
        editor.set_active(False)
        late(self.bridge("ready"), None)
        self.assertIs(editor.bridge_apps, previous)
        self.assertFalse(editor.bridge_loading)
        count = self.request.call_count
        editor.request_bridge()
        self.assertEqual(self.request.call_count, count)
        editor.set_active(True)
        self.fixture.reply(editor.sources, self.fixture.REV_A)
        current = self.request.call_args.args[2]
        late(self.bridge("ready"), None)
        self.assertTrue(editor.bridge_loading)
        current(self.bridge("update"), None)
        self.assertEqual(editor.bridge_apps["main"]["state"], "update")

    def test_install_body_busy_results_last_twelve_lines_and_followup_get(self):
        editor = self.editor
        for state, result, error, text, monospace in (
                ("missing", {"ok": True, "output": "ok"}, None, "Installed.", False),
                ("update", {"ok": True}, None, "Updated.", False),
                ("missing", {"ok": False, "output": "\n".join(map(str, range(20)))}, None,
                 asb.BRIDGE_INSTALL_FAILED + "\n" + "\n".join(map(str, range(8, 20))), True),
                ("missing", None, "Install error.", "Install error.", False)):
            with self.subTest(state=state, result=result, error=error):
                editor.bridge_apps = asb.bridge_self_apps(self.bridge(state))
                self.request.reset_mock()
                editor.install_bridge()
                self.assertEqual(self.request.call_args.args[1], "/api/bridge/install")
                self.assertEqual(self.request.call_args.args[4:], ("POST", {"sourceId": "main"}))
                self.assertEqual(editor.installing, "main")
                editor.install_button.set_label.assert_called_with("Installing…")
                editor.install_button.set_sensitive.assert_called_with(False)
                editor.install_result.set_visible.assert_called_with(False)
                editor.install_bridge()
                self.request.assert_called_once()
                self.reply(result, error)
                editor.install_result.set_label.assert_called_with(text)
                (editor.install_result.add_css_class if monospace else editor.install_result.remove_css_class).assert_called_with("monospace")
                self.assertEqual(editor.installing, "")
                self.assertEqual(self.request.call_args.args[1], "/api/bridge")
                self.reply(self.bridge(state))
        editor.install_bridge()
        callback = self.request.call_args.args[2]
        editor.cancel_form()
        callback({"ok": True}, None)
        editor.message.set_label.assert_called_with("Installed.")
        self.reply(self.bridge())
        editor.open_source(editor.sources[0])
        editor.install_bridge()
        callback = self.request.call_args.args[2]
        editor.close()
        editor.message.reset_mock()
        editor.install_result.reset_mock()
        self.request.reset_mock()
        callback({"ok": True}, None)
        editor.message.set_label.assert_not_called()
        editor.install_result.set_label.assert_not_called()
        self.request.assert_not_called()

    def test_close_reset_deleted_clean_close_and_save_feedback(self):
        editor = self.editor
        editor.reload_sources()
        self.fixture.reply([editor.sources[1]], self.fixture.REV_B)
        self.assertFalse(editor.editing)
        self.assertEqual((editor.editing_id, editor.form_baseline, editor.baseline_source, editor.edit_revision, editor.conflict),
                         ("", None, None, None, False))
        editor.dialog.close.assert_called_once()
        editor.cancellable.cancel.assert_called_once()
        editor.open_source(editor.sources[0])
        editor.name.set_text("Edit")
        editor.save_source()
        self.fixture.reply([{**editor.sources[0], "label": "Edit"}], self.fixture.REV_C)
        self.assertFalse(editor.editing)
        editor.message.set_label.assert_called_with("Saved.")
        editor.dialog.close.reset_mock()
        self.assertFalse(editor.end_edit())
        editor.dialog.close.assert_not_called()

    def test_feedback_stays_after_later_gets_and_open_add_refresh_clear_it(self):
        editor = self.editor
        for remove in (False, True):
            for clear in ("open", "add", "refresh"):
                with self.subTest(remove=remove, clear=clear):
                    editor.open_source(editor.sources[-1] if remove else editor.sources[0])
                    if remove:
                        editor.sources[-1]["builtin"] = False
                        editor.remove_source()
                    else:
                        editor.name.set_text("Edit")
                        editor.save_source()
                    self.fixture.reply(editor.sources, self.fixture.REV_B)
                    text = "Removed." if remove else "Saved."
                    editor.message.set_label.assert_called_with(text)
                    editor.reload_sources()
                    self.assertEqual(self.request.call_args.args[1:5:3], ("/api/sources", "GET"))
                    self.fixture.reply(editor.sources, self.fixture.REV_C)
                    editor.message.set_label.assert_called_with(text)
                    self.reply(self.bridge())
                    editor.message.set_label.assert_called_with(text)
                    if clear == "open":
                        editor.open_source(editor.sources[0])
                    elif clear == "add":
                        editor.add_source()
                    else:
                        editor.refresh_sources()
                        self.fixture.reply(editor.sources, self.fixture.REV_C)
                        self.reply(self.bridge())
                    editor.message.set_label.assert_called_with("")
                    self.assertFalse(editor.feedback)
                    editor.cancel_form()
        # A load error replaces the loading text, and a later successful GET clears it.
        editor.reload_sources()
        self.fixture.reply([], self.fixture.REV_C, "Cannot load profiles.")
        editor.message.set_label.assert_called_with("Cannot load profiles.")
        editor.reload_sources()
        self.fixture.reply(editor.sources, self.fixture.REV_C)
        editor.message.set_label.assert_called_with("")

    def test_bridge_calls_while_loading_queue_once_keep_refresh_and_hide_drops_queue(self):
        editor = self.editor
        for outcome in ((self.bridge(), None), (None, "Error."), ({}, None)):
            with self.subTest(outcome=outcome):
                self.request.reset_mock()
                editor.request_bridge()
                editor.request_bridge()
                editor.request_bridge(True)
                editor.request_bridge()
                self.request.assert_called_once()
                self.assertIs(editor.bridge_queued, True)
                self.reply(*outcome)
                self.assertEqual(self.request.call_count, 2)
                self.assertEqual(self.request.call_args.args[1], "/api/bridge?refresh=1")
                self.assertIsNone(editor.bridge_queued)
                self.reply(self.bridge())
                self.assertEqual(self.request.call_count, 2)
                self.assertFalse(editor.bridge_loading)
        self.request.reset_mock()
        editor.request_bridge()
        editor.request_bridge()
        self.assertIs(editor.bridge_queued, False)
        late = self.request.call_args.args[2]
        editor.set_active(False)
        self.assertIsNone(editor.bridge_queued)
        late(self.bridge(), None)
        self.request.assert_called_once()

    def test_rows_update_in_place_per_id_and_only_a_new_id_makes_a_row(self):
        editor = self.editor
        made = Mock(side_effect=editor.make_row)
        editor.make_row = made
        editor.bridge_apps = asb.bridge_self_apps(self.bridge())
        editor.render_sources("main", preserve_form=True)
        main, other = editor.table.children
        made.assert_not_called()
        state = main.asb_state
        editor.preferences.get_focus.return_value = main
        main.add_css_class, main.update_property = Mock(), Mock()
        editor.bridge_apps = asb.bridge_self_apps(self.bridge("ready"))
        editor.sources = [{**editor.sources[0], "label": "Renamed", "color": "#404040", "enabled": False}, editor.sources[1]]
        editor.render_sources("main", preserve_form=True)
        self.assertEqual(editor.table.children, [main, other])
        self.assertIs(main.asb_state, state)
        self.assertEqual((main.title, main.subtitle, main.asb_marker.configured_color), ("Renamed", "Codex · Off", "#404040"))
        main.add_css_class.assert_called_with("dim-label")
        main.update_property.assert_called_with([1], ["ASB Bridge: Off. Profile color: #404040"])
        made.assert_not_called()
        editor.sources = [*editor.sources, self.fixture.source(id="new", label="New")]
        editor.render_sources("main", preserve_form=True)
        made.assert_called_once_with()
        self.assertEqual(editor.table.children[:2], [main, other])
        editor.sources = [editor.sources[2], editor.sources[0]]
        editor.render_sources("main", preserve_form=True)
        self.assertEqual(editor.table.children[1], main)
        self.assertNotIn(other, editor.table.children)
        made.assert_called_once_with()

    def test_post_success_renders_before_close_and_remove_moves_focus_after_close(self):
        editor = self.editor
        order = []
        render, cancel = editor.render_sources, editor.cancel_form
        editor.render_sources = Mock(side_effect=lambda *args, **kwargs: (order.append("render"), render(*args, **kwargs)))
        editor.cancel_form = Mock(side_effect=lambda *args: (order.append("close"), cancel(*args)))
        editor.name.set_text("Edit")
        editor.save_source()
        self.fixture.reply([{**editor.sources[0], "label": "Edit"}, editor.sources[1]], self.fixture.REV_B)
        self.assertEqual(order, ["render", "close"])
        self.assertIsNone(editor.focus_after_close)
        editor.dialog_closed()
        rows = list(editor.table.children)
        for row in rows:
            row.grab_focus = Mock()
        editor.add_button.grab_focus.assert_not_called()
        for sources, removed, expected in ((["main", "other"], "main", 0), (["main", "other"], "other", 0), (["main"], "main", None)):
            with self.subTest(removed=removed, sources=sources):
                editor.sources = [self.fixture.source(id=identity, label=identity) for identity in sources]
                editor.render_sources()
                for row in editor.table.children:
                    row.grab_focus = Mock()
                editor.add_button.reset_mock()
                editor.open_source(next(source for source in editor.sources if source["id"] == removed))
                order.clear()
                editor.remove_source()
                remaining = [source for source in editor.sources if source["id"] != removed]
                self.fixture.reply(remaining, self.fixture.REV_C)
                self.assertEqual(order, ["render", "close"])
                self.assertEqual(editor.focus_after_close, sources.index(removed))
                editor.dialog_closed()
                self.assertIsNone(editor.focus_after_close)
                if expected is None:
                    editor.add_button.grab_focus.assert_called_once_with()
                else:
                    editor.table.children[expected].grab_focus.assert_called_once_with()

    def test_a_running_save_blocks_escape_close_and_14_close_request(self):
        editor = self.editor
        editor.name.set_text("Edit")
        editor.save_source()
        self.assertTrue(editor.saving)
        editor.dialog.set_can_close.assert_called_with(False)
        with patch.dict(SCOPE, {"Gdk": SimpleNamespace(KEY_Escape=27), "SHORTCUT_MASK": 1}):
            self.assertTrue(editor.dialog_key(None, 27, 0, 0))
        editor.cancel_form()
        self.assertTrue(editor.dialog_closed())
        self.assertTrue(editor.editing)
        editor.dialog.close.assert_not_called()
        self.fixture.reply([], self.fixture.REV_B, "The store is in use.")
        self.assertTrue(editor.editing)
        editor.dialog_message.set_label.assert_called_with("The store is in use.")
        self.assertEqual(editor.name.get_text(), "Edit")
        editor.dialog.set_can_close.assert_called_with(True)
        self.assertFalse(editor.dialog_closed())
        self.assertFalse(editor.editing)


class ProfileDialogChecks(unittest.TestCase):
    def test_modern_and_14_containers_reuse_present_and_dispose(self):
        for modern in (True, False):
            with self.subTest(modern=modern):
                fixture = ProfileSyncChecks()
                fixture.setUp()
                try:
                    editor = fixture.editor()
                    del editor.ensure_dialog
                    editor.dialog = None
                    adw = SimpleNamespace(**{name: Mock() for name in ("Window", "ToolbarView", "HeaderBar", "WindowTitle",
                        "PreferencesPage", "PreferencesGroup", "EntryRow", "ComboRow", "ActionRow", "SwitchRow")})
                    if modern:
                        adw.Dialog = Mock()
                    gtk = SimpleNamespace(**{name: Mock() for name in ("Button", "Image", "Box", "ColorDialogButton", "ColorDialog", "EventControllerKey", "StringList")},
                        Align=SimpleNamespace(CENTER=0, START=1), NaturalWrapMode=SimpleNamespace(NONE=0),
                        AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0))
                    editor.preferences.has_css_class.return_value = True
                    with patch.dict(SCOPE, {"Adw": adw, "Gtk": gtk, "SourceMarker": Mock(), "label": Mock(),
                                            "Pango": SimpleNamespace(WrapMode=SimpleNamespace(WORD=0))}):
                        editor.ensure_dialog()
                        dialog = editor.dialog
                        if modern:
                            adw.Dialog.assert_called_once_with(content_width=560)
                            dialog.set_child.assert_called_once()
                            editor.form.get_first_child().set_propagate_natural_height.assert_called_once_with(True)
                        else:
                            adw.Window.assert_called_once_with(transient_for=editor.preferences, modal=True, default_width=560,
                                default_height=640, hide_on_close=True)
                            self.assertEqual(dialog.add_css_class.call_args_list, [call("asb-column-flow"), call("asb-preferences"), call("asb-custom")])
                            dialog.set_content.assert_called_once()
                        editor.ensure_dialog()
                        self.assertIs(editor.dialog, dialog)
                        editor.present_dialog()
                        dialog.present.assert_called_once_with(*([editor.preferences] if modern else []))
                        if modern:
                            dialog.set_content_height.assert_called_once_with(-1)
                            editor.preferences.get_current_breakpoint.return_value = editor.preferences.breakpoint
                            editor.preferences.get_height.return_value = 560
                            editor.present_dialog()
                            dialog.set_content_height.assert_called_with(560)
                            dialog.present.reset_mock()
                        else:
                            dialog.set_content_height.assert_not_called()
                        self.assertEqual(dialog.connect.call_args.args[0], "closed" if modern else "close-request")
                        editor.close()
                        (dialog.force_close if modern else dialog.destroy).assert_called_once_with()
                finally:
                    fixture.doCleanups()

    def test_escape_guard_and_each_close_handler_reset_once(self):
        fixture = ProfileSyncChecks()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        editor = fixture.editor()
        preferences = object.__new__(Preferences)
        preferences.profiles_editor, preferences.close = editor, Mock()
        preferences.narrow = Mock(return_value=False)
        with patch.dict(SCOPE, {"Gdk": SimpleNamespace(KEY_Escape=27), "SHORTCUT_MASK": 1}):
            editor.dialog.get_mapped.return_value = True
            self.assertFalse(preferences.window_key(None, 27, 0, 0))
            preferences.close.assert_not_called()
            # Libadwaita 1.4: Preferences opened on another page with a hidden draft; Escape closes Preferences.
            editor.dialog.get_mapped.return_value = False
            self.assertTrue(preferences.window_key(None, 27, 0, 0))
            preferences.close.assert_called_once_with()
            self.assertTrue(editor.editing)
            preferences.close.reset_mock()
            editor.dialog.get_mapped.return_value = True
            self.assertTrue(editor.dialog_key(None, 27, 0, 0))
            self.assertFalse(editor.editing)
            self.assertTrue(preferences.window_key(None, 27, 0, 0))
            preferences.close.assert_called_once_with()
        editor.owner.report_ui.reset_mock()
        editor.cancellable.cancel.reset_mock()
        editor.end_edit()
        editor.owner.report_ui.assert_not_called()
        editor.cancellable.cancel.assert_not_called()


class MachineBridgeChecks(unittest.TestCase):
    def editor(self):
        editor = MachinesDialogChecks().editor()
        editor.base = "http://127.0.0.1:1"
        editor.loaded = False
        editor.request_group, editor.render, editor.expire_invite = Mock(), Mock(), Mock(return_value=False)
        return editor

    def bridge(self):
        return {"api": 1, "machines": [
            {"machineId": "atlas-id", "name": "atlas", "isSelf": True, "state": "ok", "apps": [{"sourceId": "codex", "label": "Codex", "state": "ready"}]},
            {"machineId": "studio-id", "name": "studio", "isSelf": False, "state": "offline", "apps": []}]}

    def test_activation_poll_single_flight_hide_void_and_retained_errors(self):
        editor = self.editor()
        editor.active = False
        request = Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=Mock(), timeout_add_seconds=Mock(return_value=5), source_remove=Mock())}):
            editor.set_active(True)
            editor.request_group.assert_called_once_with()
            self.assertEqual(request.call_args.args[1], "/api/bridge")
            editor.poll()
            request.assert_called_once()
            self.assertEqual(editor.request_group.call_args, call(poll=True))
            request.call_args.args[2](self.bridge(), None)
            previous = editor.bridge
            editor.group, editor.loaded = {"fake": "group"}, True
            editor.poll()
            request.call_args.args[2](self.bridge(), None)
            editor.render.assert_called_once_with(editor.group)
            for result, error in ((None, "Error"), ({}, None)):
                editor.request_bridge()
                request.call_args.args[2](result, error)
                self.assertEqual(editor.bridge, previous)
            editor.request_bridge()
            late = request.call_args.args[2]
            editor.set_active(False)
            late({"api": 1, "machines": []}, None)
            self.assertEqual(editor.bridge, previous)
            self.assertFalse(editor.bridge_loading)
            editor.set_active(True)
            late({"api": 1, "machines": []}, None)
            self.assertTrue(editor.bridge_loading)
            request.call_args.args[2](self.bridge(), None)
            self.assertFalse(editor.bridge_loading)

    def test_bridge_subtitles_and_equal_poll_keep_rows(self):
        editor = self.editor()
        del editor.render
        editor.bridge = self.bridge()
        for name in ("self_row", "off", "phones", "others_heading", "others", "empty", "alone", "leave_button", "join_open", "body"):
            setattr(editor, name, Mock())
        editor.join_box = Mock(get_visible=Mock(return_value=False))
        editor.render_others, editor.rows_shown = Mock(), None
        own = {"machineId": "atlas-id", "name": "atlas"}
        studio = {"machineId": "studio-id", "name": "studio", "isSelf": False, "online": False, "lastOkAtMs": 0, "addresses": []}
        group = {"self": own, "members": [{**own, "isSelf": True}, studio], "groupId": "group", "networkEnabled": True, "phones": []}
        editor.render(group)
        editor.self_row.set_subtitle.assert_called_with("ID atlas-id\nBridge: Codex ready")
        rows = editor.render_others.call_args.args[1]
        self.assertTrue(rows[0][2].endswith("\nBridge: not checked while offline"))
        editor.rows_shown = rows
        editor.render_others.reset_mock()
        editor.render(group)
        editor.render_others.assert_not_called()
        self.assertEqual(editor.bridge_suffix("absent"), "")
        editor.bridge = None
        self.assertEqual(editor.bridge_suffix(is_self=True), "")


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

    def test_source_form_sends_remote_claude_only_for_claude_and_only_known_values(self):
        body = SCOPE["source_form_body"]
        for value in ("auto", "bridge", "native"):
            with self.subTest(value=value):
                self.assertEqual(body("claude-desktop-code", "Claude", "/profile", "", True, remote_claude=value)["source"]["remoteClaude"], value)
        self.assertNotIn("remoteClaude", body("claude-desktop-code", "Claude", "/profile", "", True)["source"])
        self.assertNotIn("remoteClaude", body("codex", "Codex", "/profile", "", True, remote_claude="native")["source"])
        for value in ("Auto", "", 1, True, {}, "remote"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "Automatic, Through ASB, or Claude Remote Control only"):
                body("claude-desktop-code", "Claude", "/profile", "", True, remote_claude=value)
        edit_values = SCOPE["source_edit_values"]
        self.assertEqual(edit_values({"id": "claude"})[-1], "auto")
        self.assertEqual(edit_values({"id": "claude", "remoteClaude": "native"})[-1], "native")
        self.assertNotEqual(edit_values({"id": "claude"}), edit_values({"id": "claude", "remoteClaude": "bridge"}))

    def test_only_the_default_opencode_source_is_accepted_and_its_editor_is_fixed(self):
        body = SCOPE["source_form_body"]
        self.assertEqual(body("opencode", " Work ", "/data/opencode", "", False, "opencode", "/ignored", "#899e91", True),
                         {"source": {"id": "opencode", "provider": "opencode", "label": "Work", "dataDir": "/data/opencode",
                                     "launcher": "", "enabled": False, "color": "#899e91", "showMarker": True}})
        for identity in ("", "codex", "opencode-2"):
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                body("opencode", "OpenCode", "/data/opencode", "", True, identity)
        self.assertEqual(asb.SOURCE_PROVIDERS, ("codex", "claude-desktop-code"))
        fixture = ProfileSyncChecks()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        window = fixture.editor()
        default = {"id": "opencode", "provider": "opencode", "label": "OpenCode", "builtin": True, "enabled": True,
                   "launcher": "", "dataDir": "/data/opencode", "color": "#899e91"}
        with patch.dict(SCOPE, {"Gtk": SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0), AccessibleState=SimpleNamespace(BUSY=0))}):
            window.sources = [default]
            window.set_form(default)
            self.assertEqual(window.fixed_provider, "opencode")
            window.provider.set_visible.assert_called_with(False)
            window.provider_fixed.set_visible.assert_called_with(True)
            for entry in (window.data_dir, window.launcher):
                entry.set_editable.assert_called_with(False)
            self.assertFalse(any(widget.get_visible() for widget in window.transcript_widgets))
            window.closed = window.loading = window.choosing = window.conflict = False
            window.loaded, window.editing_id, window.request_sources = True, "opencode", Mock()
            window.name.get_text.return_value, window.data_dir.get_text.return_value = "OpenCode", "/data/opencode"
            window.launcher.get_text.return_value = window.projects_dir.get_text.return_value = ""
            window.enabled.get_active.return_value = window.show_marker.get_active.return_value = True
            window.save_source()
            self.assertEqual(window.request_sources.call_args.args[2]["source"]["provider"], "opencode")
            window.set_form({"provider": "codex"})
            self.assertEqual(window.fixed_provider, "")
            window.provider.set_visible.assert_called_with(True)
            window.provider_fixed.set_visible.assert_called_with(False)
            for entry in (window.data_dir, window.launcher):
                entry.set_editable.assert_called_with(True)

    def test_source_requests_serialize_keep_failed_form_and_refresh_after_changes(self):
        fixture = ProfileSyncChecks()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        window = fixture.editor()
        window.edit_revision = window.revision = None
        window.active = False
        builtin = {"id": "codex", "provider": "codex", "builtin": True, "dataDir": "/default"}
        personal = {"id": "codex-personal", "provider": "codex", "builtin": False}
        window.closed = window.loading = window.choosing = False
        window.loaded = window.editing = True
        window.base, window.sources, window.max_sources, window.editing_id = "http://127.0.0.1:1", [builtin, personal], 8, personal["id"]
        window.owner = SimpleNamespace(closed=False, refresh=Mock(),
                                       hex_color=Mock(return_value="#b28f80"))
        window.source_color = Mock(get_rgba=Mock(return_value=object()))
        window.provider, window.fixed_provider, window.choose_buttons = Mock(get_selected=Mock(return_value=0)), "", []
        for name, value in (("name", "Personal"), ("data_dir", "/profile"), ("launcher", "/bin/chatgpt-personal"), ("projects_dir", "")):
            setattr(window, name, Mock(get_text=Mock(return_value=value)))
        window.enabled = Mock(get_active=Mock(return_value=True))
        window.show_marker = Mock(get_active=Mock(return_value=False))
        window.remote_claude = Mock(get_selected=Mock(return_value=0))
        for name in ("message", "table", "form", "add_button", "save_button", "remove_button", "cancel_button", "reload_button"):
            setattr(window, name, Mock())
        window.render_sources, window.cancellable = Mock(), Mock()
        gtk = SimpleNamespace(AccessibleState=SimpleNamespace(BUSY=0))
        request, dispatch = Mock(), Mock()
        with patch.dict(SCOPE, {"request_async": request, "GLib": SimpleNamespace(idle_add=dispatch), "Gtk": gtk}):
            window.owner.hex_color.return_value = "#12345g"
            window.save_source()
            request.assert_not_called()
            window.dialog_message.set_label.assert_called_with("Profile color must use a #RRGGBB value.")
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
            window.dialog_message.set_label.assert_called_with("This session store is already registered.")
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
            window.render_sources.assert_called_with()
            window.owner.refresh.assert_called_once_with(True)
            window.message.set_label.assert_called_with("Saved.")

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
            window.message.set_label.assert_called_with("Removed.")

            window.reload_sources()
            self.assertEqual(request.call_args.args[1], "/api/sources")
            callback = request.call_args.args[2]
            window.close()
            self.assertTrue(window.closed)
            self.assertTrue(window.cancellable.cancel.called)
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
        preferences.machines_editor = preferences.usage_editor = None
        preferences.pages = Mock(get_visible_child_name=Mock(return_value="section"))
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
        fixture = ProfileSyncChecks()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        window = fixture.editor()
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0), AccessibleState=SimpleNamespace(BUSY=0))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.set_form({"id": "codex", "provider": "codex", "label": "Codex", "enabled": True,
                             "color": "#404040", "showMarker": False})
            window.source_color.set_rgba.assert_called_with("#404040")
            window.color_row.set_subtitle.assert_called_with("#404040")
            window.show_marker.set_active.assert_called_with(False)
            window.enabled.set_active.assert_called_with(True)
            window.set_form({"provider": "codex", "color": "#404040", "showMarker": True})
            window.source_color.set_rgba.assert_called_with("#404040")
            window.show_marker.set_active.assert_called_with(True)
            window.set_form({"provider": "codex"})
            window.show_marker.set_active.assert_called_with(True)
            # Remote Claude sessions follows the saved value; a missing or unknown value is Automatic.
            for remote, index in (("native", 2), ("bridge", 1), (None, 0), ("remote", 0), ({}, 0)):
                source = {"id": "claude", "provider": "claude-desktop-code", "label": "Claude", "enabled": True}
                window.set_form(source if remote is None else {**source, "remoteClaude": remote})
                window.remote_claude.set_selected.assert_called_with(index)

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
            with self.assertRaisesRegex(RuntimeError, "Cannot load or change profiles") as caught:
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
            self.assertIn("Profile: ChatGPT Personal (codex-personal)", widget.asb_tooltip)
            self.assertIn("Profile: ChatGPT Personal (codex-personal)", widget.update_property.call_args.args[1][1])
            self.assertIn("Open failed", widget.update_property.call_args.args[1][1])
            row.update(sourceColor="#b28f80", sourceCount=2)
            widget.asb_time_signature = None
            window.update_row_text(widget, 100_000)
            self.assertIn("Profile color marker: #b28f80", widget.asb_tooltip)
            self.assertIn("Profile: ChatGPT Personal (codex-personal). Profile color marker: #b28f80", widget.update_property.call_args.args[1][1])
            del row["sourceLabel"], row["sourceId"], row["sourceColor"], row["sourceCount"]
            widget.asb_time_signature = None
            window.update_row_text(widget, 100_000)
            self.assertNotIn("Profile:", widget.asb_tooltip)
            self.assertIn("Open failed", widget.update_property.call_args.args[1][1])
            self.assertNotIn("Profile:", widget.update_property.call_args.args[1][1])

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
                widget = SimpleNamespace(asb_view=view, asb_thread={}, asb_mark=Mock(), asb_source_badge=badge, asb_where_icon=(Mock() if view == "comfortable" else None), asb_where_label=Mock(),
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
        window = object.__new__(Window)
        window.profile_surfaces, window.badge_css, window.badge_colors = ("#0f0f0f", "#242424"), Mock(), {}
        marker = object.__new__(Marker)
        marker.owner, marker.color_class = window, ""
        marker.set_visible, marker.add_css_class, marker.remove_css_class = Mock(), Mock(), Mock()
        def displayed():
            # The badge has one color class, and the one shared provider has the rules of that class.
            css = window.badge_css.load_from_string.call_args.args[0]
            return SCOPE["re"].search(r"\.asb-source-badge\." + marker.color_class + r" \{ background: (#[0-9a-f]{6});", css)[1]
        marker.set_color("#B28F80")
        self.assertEqual((marker.configured_color, marker.color_class), ("#b28f80", "asb-badge-b28f80"))
        marker.add_css_class.assert_called_once_with("asb-badge-b28f80")
        css = window.badge_css.load_from_string.call_args.args[0]
        self.assertIn(".asb-source-badge.asb-badge-b28f80 { background: #b28f80; border-color: #0f0f0f; }", css)
        self.assertIn(".asb-session.asb-hovered .asb-source-badge.asb-badge-b28f80, "
                      ".asb-session:focus-within .asb-source-badge.asb-badge-b28f80 { border-color: #242424; }", css)
        window.badge_css.load_from_string.reset_mock()
        marker.add_css_class.reset_mock()
        marker.set_color("#b28f80")
        window.badge_css.load_from_string.assert_not_called()
        marker.add_css_class.assert_not_called()
        # set_palette clears the shared rules when the surfaces change.
        window.badge_colors.clear()
        window.profile_surfaces = ("#606060", "#707070")
        marker.set_color(marker.configured_color)
        marker.remove_css_class.assert_called_once_with("asb-badge-b28f80")
        self.assertNotEqual(displayed(), marker.configured_color)
        self.assertEqual(marker.configured_color, "#b28f80")
        for surface in window.profile_surfaces:
            self.assertGreaterEqual(SCOPE["contrast"](displayed(), surface), 3)
        window.badge_colors.clear()
        window.profile_surfaces = ("#0f0f0f", "#242424")
        names = []
        for color in ("#000000", "#404040"):
            marker.set_color(color)
            self.assertEqual(marker.configured_color, color)
            self.assertNotEqual(displayed(), marker.configured_color)
            for surface in window.profile_surfaces:
                self.assertGreaterEqual(SCOPE["contrast"](displayed(), surface), 3)
            names.append(marker.color_class)
        # One provider holds the rules of every badge color.
        css = window.badge_css.load_from_string.call_args.args[0]
        self.assertTrue(all(".asb-source-badge." + name + " {" in css for name in names))
        window.badge_css.load_from_string.reset_mock()
        for invalid in ("", None, False, "#8296b4} button{opacity:0", "#12345g"):
            marker.set_color(invalid)
            self.assertEqual((marker.configured_color, marker.color_class), ("", ""))
            marker.set_visible.assert_called_with(False)
        marker.remove_css_class.assert_called_with(names[-1])
        window.badge_css.load_from_string.assert_not_called()
        for _name, preset in SCOPE["SOURCE_COLOR_PRESETS"]:
            self.assertEqual(SCOPE["validate_source_color"](preset), preset)

    def test_a_filter_dot_drops_a_peer_color_that_is_not_a_color(self):
        window = object.__new__(Window)
        window.profile_surfaces, window.badge_css, window.badge_colors = ("#1e1e1e", "#2a2a2a"), Mock(), {}
        dot = SimpleNamespace(set_visible=Mock(), add_css_class=Mock(), remove_css_class=Mock())
        # A group member can send this sourceColor; filter_profiles copies it into the filter model.
        model = asb.filter_profiles({"providers": [], "threads": [
            {"id": "m:m1:a", "remote": True, "machineId": "m1", "provider": "codex", "sourceId": "codex", "state": "idle",
             "sourceColor": '#000; } window { background: url("https://example.invalid/x.png"); } .x {'}]})
        window.paint_dot(dot, model[1]["apps"][0]["profiles"][0]["color"])
        dot.set_visible.assert_called_once_with(False)
        dot.add_css_class.assert_not_called()
        self.assertFalse(any("window" in made.args[0] for made in window.badge_css.load_from_string.call_args_list))

    def test_a_filter_dot_has_one_class_of_its_displayed_color(self):
        window = object.__new__(Window)
        surfaces = ("#1e1e1e", "#2a2a2a")
        window.profile_surfaces, window.badge_css, window.badge_colors = surfaces, Mock(), {}
        classes = set()
        dot = SimpleNamespace(set_visible=Mock(), add_css_class=classes.add, remove_css_class=classes.discard)
        for color in ("#8296b4", "#b28f80", "#8296b4"):
            window.paint_dot(dot, color)
        self.assertEqual(classes, {window.badge_class(asb.display_source_color("#8296b4", surfaces))})
        window.paint_dot(dot, "#3a4a6a")
        displayed = asb.display_source_color("#3a4a6a", surfaces)
        self.assertNotEqual(displayed, "#3a4a6a")
        self.assertEqual(classes, {window.badge_class(displayed)})
        dot.set_visible.assert_called_with(True)
        # set_palette empties the shared rules: the next paint writes the rule of the dot again.
        window.badge_colors.clear()
        window.badge_css.load_from_string.reset_mock()
        window.paint_dot(dot, "#3a4a6a")
        self.assertIn(".asb-chip-dot." + window.badge_class(displayed) + " { background: " + displayed + "; }",
                      window.badge_css.load_from_string.call_args.args[0])
        self.assertEqual(classes, {window.badge_class(displayed)})

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

    def test_row_panel_controls_and_edges_follow_the_menu_rules(self):
        controls, edge, actions = SCOPE["row_panel_controls"], SCOPE["edge_color"], SCOPE["row_menu_actions"]
        contrast = SCOPE["contrast"]
        idle = {"state": "idle", "unread": True, "pinned": True, "pendingSource": "observed-completion"}
        self.assertEqual(controls(idle), {"read": ("mark-read", "Mark read", "object-select-symbolic"),
                                          "drawer": ("drawer-in", "Put in drawer", "asb-drawer-symbolic"),
                                          "mute": ("mute", "Mute", "asb-muted-symbolic"),
                                          "pin": ("unpin", "Unpin", "view-pin-symbolic"),
                                          "pin-up": ("pin-up", "Move pin earlier", "go-up-symbolic"),
                                          "pin-down": ("pin-down", "Move pin later", "go-down-symbolic")})
        working = {"state": "working"}
        self.assertEqual(controls(working), {"read": ("mark-unread", "Mark unread", "mail-unread-symbolic"),
                                             "mute": ("mute", "Mute", "asb-muted-symbolic"),
                                             "pin": ("pin", "Pin", "view-pin-symbolic"),
                                             "discard": ("discard-result", "Discard result", "edit-delete-symbolic")})
        self.assertEqual(controls({**working, "discardResult": True})["discard"], ("keep-result", "Keep result", "edit-undo-symbolic"))
        for remote in (working, {**working, "discardResult": True}):
            self.assertNotIn("discard", controls({**remote, "remote": True}))
            self.assertFalse({"discard-result", "keep-result"} & {action for _title, action in actions({**remote, "remote": True})})
        self.assertEqual(controls({**working, "surface": "cli"})["discard"][0], "discard-result")
        drawer = {"state": "idle", "drawer": True}
        self.assertEqual(controls(drawer)["read"][:2], ("mark-read", "Mark read"))
        self.assertEqual(controls(drawer)["drawer"], ("drawer-out", "Take out of drawer", "asb-drawer-symbolic"))
        # A required action has the read slot: Read until it is read, then Unread.
        waiting = {"state": "waiting", "actionRequired": True, "actionAttention": True}
        self.assertEqual(list(controls(waiting)), ["read", "mute", "pin"])
        self.assertEqual(controls(waiting)["read"][:2], ("mark-read", "Mark read"))
        self.assertEqual(controls({**waiting, "actionAttention": False})["read"][:2], ("mark-unread", "Mark unread"))
        # A muted row offers Unmute and no Discard, Working or not.
        for row in (idle, working, {**working, "discardResult": True}):
            muted = {**row, "muted": True}
            self.assertEqual(controls(muted)["mute"], ("unmute", "Unmute", "preferences-system-notifications-symbolic"))
            self.assertNotIn("discard", controls(muted))
            self.assertEqual(list(controls(muted)), [key for key in controls(row) if key != "discard"])
        # Every action has one slot; the slots follow the menu order, and only the offered actions show.
        slots = list(dict.fromkeys(slot for slot, _icon in SCOPE["ROW_PANEL_SLOTS"].values()))
        self.assertEqual(slots, ["read", "drawer", "mute", "pin", "pin-up", "pin-down", "discard"])
        for row in (idle, working, drawer, waiting, {**idle, "muted": True}, {**working, "muted": True}, {**working, "discardResult": True},
                    {"state": "idle", "pinned": True}, {"state": "idle", "manualUnread": True, "unread": True},
                    {"state": "working", "remote": True, "pinned": True}, {"state": "idle", "surface": "cli", "unread": True}):
            offered = actions(row)
            self.assertEqual([(action, label) for action, label, _icon in controls(row).values()],
                             [(action, {"mark-read": "Mark read", "mark-unread": "Mark unread"}.get(action, title)) for title, action in offered])
            self.assertEqual(list(controls(row)), [slot for slot in slots if slot in controls(row)])
        self.assertEqual(set(SCOPE["ROW_PANEL_SLOTS"]), {"mark-read", "mark-unread", "drawer-in", "drawer-out", "mute", "unmute", "pin", "unpin",
                                                          "pin-up", "pin-down", "discard-result", "keep-result"})
        self.assertEqual(edge("#0f0f0f", "#ffb900", .7, ("#000000", "#0f0f0f")), "#b78605")
        dim = edge("#171c22", "#f0f2f5", .36, ("#171c22",))
        self.assertGreaterEqual(contrast(dim, "#171c22"), 3)
        self.assertEqual(edge("#000000", "#101010", .5, ("#000000",)), "#101010")

    def test_popover_shift_fits(self):
        self.assertEqual(asb.popover_shift(180, 40, 280, 500), 0)

    def test_popover_shift_left(self):
        self.assertEqual(asb.popover_shift(20, 40, 280, 500), 108)

    def test_popover_shift_right(self):
        self.assertEqual(asb.popover_shift(460, 40, 280, 500), -128)

    def test_popover_shift_wider_than_board(self):
        shift = asb.popover_shift(100, 40, 280, 250)
        self.assertEqual(100 + 40 / 2 - 280 / 2 + shift, 8)
        self.assertEqual(asb.popover_shift(100, 40, 280, 250, margin=12), 32)

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
        self.assertEqual([action for _, action in actions({"pinned": True})], ["mark-unread", "mute", "unpin", "pin-up", "pin-down"])
        self.assertEqual(actions({"pinned": True, "muted": True})[1], ("Unmute", "unmute"))
        self.assertEqual(actions({"state": "working"})[-2:], [("Pin", "pin"), ("Discard result", "discard-result")])
        self.assertEqual(actions({"state": "working", "muted": True}), [("Unread", "mark-unread"), ("Unmute", "unmute"), ("Pin", "pin")])
        self.assertEqual(actions({"state": "working", "muted": True, "discardResult": True})[-1], ("Pin", "pin"))

    def test_attention_indicator_prefers_question_and_working_rows_hide_unread_text(self):
        indicator = SCOPE["attention_indicator"]
        for row, expected in (({}, ""), ({"unread": True}, "dot"), ({"unread": True, "alert": True}, "alert"),
                              ({"unread": True, "alert": True, "questionAttention": True}, "question"),
                              ({"questionAttention": True}, "question"),
                              ({"unread": True, "questionAttention": True}, "question"),
                              ({"state": "working", "unread": False, "manualUnread": True, "nativeAttention": True,
                                "retainedUnread": True}, ""),
                              ({"state": "working", "unread": False, "questionAttention": True}, "question")):
            self.assertEqual(indicator(row), expected)
        self.assertEqual(SCOPE["row_menu_actions"]({"unread": True, "alert": True})[:2],
                         [("Read", "mark-read"), ("Put in drawer", "drawer-in")])
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(), set_child=Mock(), asb_mark=Mock(),
                                 asb_source_badge=Mock(), asb_where_icon=None, asb_where_label=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
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
        # A required action keeps its "?" mark after Read, as a passive mark.
        wait = {**stop, "state": "waiting", "actionRequired": True, "actionAttention": False}
        for row, expected in ((stop, "stop"), ({**stop, "unread": True}, "dot"),
                              ({**stop, "questionAttention": True}, "question"), (wait, "question"),
                              ({**stop, "state": "working"}, "")):
            self.assertEqual(indicator(row), expected)
        self.assertEqual(actions(stop)[0], ("Unread", "mark-unread"))
        self.assertEqual(actions(wait), [("Unread", "mark-unread"), ("Mute", "mute"), ("Pin", "pin")])
        self.assertEqual(actions({**wait, "pinned": True}), [("Unread", "mark-unread"), ("Mute", "mute"), ("Unpin", "unpin"),
                         ("Move pin earlier", "pin-up"), ("Move pin later", "pin-down")])
        for extra in ({"actionAttention": True}, {"unread": True}):
            self.assertEqual(actions({**wait, **extra})[0], ("Read", "mark-read"))
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
                self.assertEqual(widget.asb_read_button.asb_action, None)
                widget.asb_read_button.add_css_class.assert_any_call("asb-passive-indicator")
                widget.asb_read_button.update_state.assert_called_with([0, 1], [False, True])
                self.assertEqual(widget.asb_pin_button.asb_action, "win.pin")
            widget.asb_thread = {**stop, "unread": True}
            window.update_card_actions(widget)
            self.assertEqual(widget.asb_read_button.asb_action, "win.mark-read")
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
                                    ({"lastOutcome": "limit", "unread": True, "alert": True}, "Usage limit stopped the task."),
                                    ({"state": "waiting", "actionRequired": True}, "A user action is required in the original app.")):
                widget.asb_thread = {"id": "a", "title": "Chat", "providerLabel": "Codex", "state": "idle", **extra}
                widget.asb_time_signature = None
                window.update_row_text(widget, 100_000)
                self.assertIn(expected, widget.asb_accessible_label)
                if extra.get("lastOutcome") in ("failed", "limit"):
                    self.assertIn("Stopped.", widget.asb_accessible_label)
                    self.assertTrue(SCOPE["tooltip_model"](widget.asb_thread, 100_000, "/example")["state_text"].startswith("Stopped"))
                self.assertNotIn("completed task", widget.asb_tooltip)
                if extra.get("actionRequired"):
                    self.assertIn("Waits for your permission.", widget.asb_tooltip)

    def test_discard_ring_priorities_menus_and_comfortable_action_modes(self):
        indicator, actions = SCOPE["attention_indicator"], SCOPE["row_menu_actions"]
        working = {"id": "a", "title": "Chat", "state": "working", "discardResult": True}
        for extra, expected in (({}, "discard"), ({"unread": True}, "dot"),
                                ({"questionAttention": True}, "question"), ({"actionRequired": True}, "question"),
                                ({"state": "idle", "lastOutcome": "stopped", "discardResult": False}, "stop"),
                                ({"state": "idle", "discardResult": False}, "")):
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
                self.assertEqual(widget.asb_read_button.asb_action, action)
                widget.asb_read_button.set_tooltip_text.assert_called_with(text)
                widget.asb_read_button.update_state.assert_called_with([0, 1], [False, False])
                widget.asb_read_button.add_css_class.assert_any_call("asb-discard-button")
                (widget.asb_read_button.remove_css_class if armed else widget.asb_read_button.add_css_class).assert_any_call("asb-discard-offer")
            window.session_actions.add("a")
            window.update_card_actions(widget)
            self.assertEqual(widget.asb_read_button.asb_action, None)
            widget.asb_read_button.set_sensitive.assert_called_with(True)
            widget.asb_read_button.update_state.assert_called_with([0, 1], [True, True])
            window.session_actions.clear()
            widget.asb_thread = {**working, "questionAttention": True}
            window.update_card_actions(widget)
            self.assertEqual(widget.asb_read_button.asb_action, "win.mark-read")
            widget.asb_read_button.remove_css_class.assert_any_call("asb-discard-button")
            widget.asb_thread = {**working, "actionRequired": True}
            window.update_card_actions(widget)
            self.assertEqual(widget.asb_read_button.asb_action, None)
            widget.asb_read_button.set_focusable.assert_called_with(False)
            for armed in (False, True):
                widget.asb_thread = {**working, "discardResult": armed}
                widget.asb_read_timer = 42
                window.update_card_actions(widget)
                self.assertIsNone(widget.asb_read_timer)
                widget.asb_read_button.remove_css_class.assert_any_call("asb-read-confirmed")
                self.assertEqual(widget.asb_read_button.asb_action, "win.keep-result" if armed else "win.discard-result")
            self.assertEqual(window.clear_read_feedback.call_count, 2)

    def test_a_muted_row_has_the_muted_flag_and_label_and_no_discard_ring(self):
        row = {"id": "a", "title": "Chat", "provider": "codex", "providerLabel": "Codex", "state": "idle", "muted": True, "canOpen": True}
        self.assertEqual(SCOPE["tooltip_model"](row, 100_000, "/home/test")["flags"], "Muted")
        self.assertEqual(SCOPE["tooltip_model"]({**row, "pinned": True}, 100_000, "/home/test")["flags"], "Pinned · Muted")
        self.assertEqual(SCOPE["tooltip_model"]({**row, "muted": False}, 100_000, "/home/test")["flags"], "")
        window = object.__new__(Window)
        window.view, window.opening, window.open_errors, window.session_actions = "compact", set(), {}, set()
        text = SimpleNamespace(asb_thread=dict(row), asb_time_signature=None, asb_state_label=Mock(), asb_title_label=Mock(),
                               set_sensitive=Mock(), update_property=Mock(), update_state=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.update_row_text(text, 100_000)
            self.assertEqual(text.asb_accessible_label, "Open Chat in Codex. Idle. Muted.")
            text.asb_thread, text.asb_time_signature = {**row, "muted": False}, None
            window.update_row_text(text, 100_000)
            self.assertNotIn("Muted", text.asb_accessible_label)
            widget = SimpleNamespace(asb_view="comfortable", asb_thread={**row, "state": "working"}, asb_read_timer=None,
                                     asb_read_button=Mock(), asb_pin_button=Mock())
            window.update_card_actions(widget)
            widget.asb_read_button.set_visible.assert_called_with(False)
            self.assertEqual(widget.asb_read_button.asb_action, None)
            widget.asb_read_button.remove_css_class.assert_any_call("asb-discard-button")
            widget.asb_read_button.remove_css_class.assert_any_call("asb-discard-offer")
            # Unmute changes the signature, so the ring comes back.
            widget.asb_thread = {**widget.asb_thread, "muted": False}
            window.update_card_actions(widget)
            widget.asb_read_button.set_visible.assert_called_with(True)
            self.assertEqual(widget.asb_read_button.asb_action, "win.discard-result")
        source = SOURCE.read_text()
        self.assertIn("min-width: 6px; min-height: 6px; border: 1.5px solid @window_fg_color", source)
        self.assertIn(".asb-discard-button.asb-discard-offer {{ opacity: 0;", source)
        self.assertIn(".asb-session:focus-within .asb-discard-offer {{ opacity: 1;", source)

    def test_idle_discard_ring_priority_menu_panel_and_texts(self):
        indicator, actions, controls = SCOPE["attention_indicator"], SCOPE["row_menu_actions"], SCOPE["row_panel_controls"]
        idle = {"id": "a", "title": "Chat", "providerLabel": "Codex", "state": "idle", "canOpen": True}
        armed = {**idle, "discardResult": True}
        # An armed Idle row shows the ring below `?` and the dot and above the stop square; Waiting and Unknown rows never show it.
        for row, expected in ((idle, ""), (armed, "discard"), ({**armed, "unread": True}, "dot"), ({**armed, "questionAttention": True}, "question"),
                              ({**armed, "lastOutcome": "stopped"}, "discard"), ({**idle, "lastOutcome": "stopped"}, "stop"),
                              ({**armed, "state": "waiting"}, ""), ({**armed, "state": "unknown"}, "")):
            self.assertEqual(indicator(row), expected, row)
        # The menu and the row panel offer Discard for the next task on an Idle row with no mark, and Keep on an armed one.
        self.assertEqual(actions(idle)[-1], ("Discard next result", "discard-result"))
        self.assertEqual(actions(armed)[-1], ("Keep next result", "keep-result"))
        self.assertEqual(controls(idle)["discard"], ("discard-result", "Discard next result", "edit-delete-symbolic"))
        self.assertEqual(controls(armed)["discard"], ("keep-result", "Keep next result", "edit-undo-symbolic"))
        # A mark, a drawer entry, Mute, another machine, or another state takes the offer away; Keep stays for an armed row with a mark.
        for extra in ({"unread": True}, {"questionAttention": True}, {"lastOutcome": "stopped"}, {"drawer": True}, {"muted": True},
                      {"remote": True}, {"state": "waiting"}, {"state": "unknown"}):
            self.assertNotIn("discard", controls({**idle, **extra}), extra)
        for extra in ({"unread": True}, {"questionAttention": True}, {"drawer": True}):
            self.assertEqual(controls({**armed, **extra})["discard"][0], "keep-result", extra)
        for extra in ({"muted": True}, {"remote": True}, {"state": "waiting"}):
            self.assertNotIn("discard", controls({**armed, **extra}), extra)
        self.assertEqual(controls({**idle, "surface": "cli"})["discard"][0], "discard-result")
        # Working rows keep their texts.
        self.assertEqual(actions({**idle, "state": "working"})[-1], ("Discard result", "discard-result"))
        self.assertEqual(actions({**armed, "state": "working"})[-1], ("Keep result", "keep-result"))
        # The tooltip note and the accessible label name the next task on an Idle row only.
        model = SCOPE["tooltip_model"]
        self.assertEqual(model(armed, 100_000, "/home/test")["note"], "Discard is on for the next task.")
        self.assertEqual(model({**armed, "state": "working"}, 100_000, "/home/test")["note"], "Discard is on for this task.")
        self.assertEqual(model(idle, 100_000, "/home/test")["note"], "")
        window = object.__new__(Window)
        window.view, window.opening, window.open_errors, window.session_actions = "compact", set(), {}, set()
        text = SimpleNamespace(asb_thread=dict(armed), asb_time_signature=None, asb_state_label=Mock(), asb_title_label=Mock(),
                               set_sensitive=Mock(), update_property=Mock(), update_state=Mock())
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.update_row_text(text, 100_000)
            self.assertIn(" Discard is on for the next task.", text.asb_accessible_label)
            self.assertNotIn("Discard is on.", text.asb_accessible_label)
            text.asb_thread, text.asb_time_signature = {**armed, "state": "working"}, None
            window.update_row_text(text, 100_000)
            self.assertIn(" Discard is on.", text.asb_accessible_label)
            self.assertNotIn("next task", text.asb_accessible_label)
            text.asb_thread, text.asb_time_signature = dict(idle), None
            window.update_row_text(text, 100_000)
            self.assertNotIn("Discard", text.asb_accessible_label)

    def test_idle_card_offers_discard_for_the_next_task_in_the_read_slot(self):
        window = object.__new__(Window)
        window.session_actions = set()
        window.clear_read_feedback = Mock(side_effect=lambda item: setattr(item, "asb_read_timer", None))
        idle = {"id": "a", "title": "Chat", "state": "idle"}
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        def card(row, timer=None):
            widget = SimpleNamespace(asb_view="comfortable", asb_thread=row, asb_read_timer=timer, asb_read_button=Mock(), asb_pin_button=Mock())
            window.update_card_actions(widget)
            return widget, widget.asb_read_button
        with patch.dict(SCOPE, {"Gtk": gtk}):
            for armed, action, text in ((False, "win.discard-result", "Discard next result: go to read Idle when the next task ends"),
                                       (True, "win.keep-result", "Keep result: show the dot when the next task ends")):
                _widget, read = card({**idle, "discardResult": armed})
                read.set_visible.assert_called_with(True)
                read.set_focusable.assert_called_with(True)
                self.assertEqual(read.asb_action, action)
                read.set_tooltip_text.assert_called_with(text)
                read.update_state.assert_called_with([0, 1], [False, False])
                read.add_css_class.assert_any_call("asb-discard-button")
                # The dashed offer shows only before the arm; the armed ring is solid.
                (read.remove_css_class if armed else read.add_css_class).assert_any_call("asb-discard-offer")
                self.assertNotIn(call("asb-discard-offer"), read.add_css_class.call_args_list if armed else [])
            # A mark keeps the Read action, and a stopped task keeps its passive square.
            _widget, read = card({**idle, "unread": True, "pending": True})
            self.assertEqual(read.asb_action, "win.mark-read")
            read.remove_css_class.assert_any_call("asb-discard-button")
            _widget, read = card({**idle, "lastOutcome": "stopped"})
            self.assertEqual(read.asb_action, None)
            read.set_focusable.assert_called_with(False)
            read.add_css_class.assert_any_call("asb-passive-indicator")
            read.remove_css_class.assert_any_call("asb-discard-button")
            # Mute and another machine take the card offer away.
            for extra in ({"muted": True}, {"remote": True}):
                _widget, read = card({**idle, **extra})
                read.set_visible.assert_called_with(False)
                self.assertEqual(read.asb_action, None)
                read.remove_css_class.assert_any_call("asb-discard-button")
            # The check after a Read keeps the slot until it ends; an arm made meanwhile takes it.
            widget, read = card(dict(idle), timer=42)
            window.clear_read_feedback.assert_not_called()
            self.assertEqual((widget.asb_read_timer, read.asb_action), (42, None))
            read.add_css_class.assert_any_call("asb-read-confirmed")
            read.set_tooltip_text.assert_called_with("Read in ASB")
            widget, read = card({**idle, "discardResult": True}, timer=42)
            window.clear_read_feedback.assert_called_once()
            self.assertEqual((widget.asb_read_timer, read.asb_action), (None, "win.keep-result"))
            # A pending request keeps the labels and drops the action.
            window.session_actions.add("a")
            _widget, read = card(dict(idle))
            self.assertEqual(read.asb_action, None)
            read.update_state.assert_called_with([0, 1], [True, True])

    def test_discard_action_sends_next_only_for_an_idle_card(self):
        window = object.__new__(Window)
        window.focus_widgets = {"idle": SimpleNamespace(asb_thread={"id": "idle", "state": "idle"}),
                                "work": SimpleNamespace(asb_thread={"id": "work", "state": "working"})}
        window.session_action = Mock()
        target = lambda identity: SimpleNamespace(get_string=lambda: identity)
        for identity, body in (("idle", {"next": True}), ("work", None), ("gone", None)):
            window.session_action.reset_mock()
            window.row_action(None, target(identity), "discard-result")
            window.session_action.assert_called_once_with(identity, "discard-result", body)
        for identity in ("idle", "work"):
            window.session_action.reset_mock()
            window.row_action(None, target(identity), "keep-result")
            window.session_action.assert_called_once_with(identity, "keep-result")

    def test_idle_discard_and_keep_wait_half_a_second_after_a_read_and_send_next(self):
        window = object.__new__(Window)
        widget = SimpleNamespace(asb_thread={"id": "a", "state": "idle", "unread": True}, asb_read_generation=1, asb_view="comfortable",
                                 asb_last_read_at=None)
        window.base, window.closed = "http://127.0.0.1:1", False
        window.session_actions, window.open_errors = set(), {}
        window.focus_widgets = window.row_cache = {"a": widget}
        window.dashboard = {"threads": [dict(widget.asb_thread)]}
        window.get_focus = window.focus_key = lambda: None
        window.update_card_actions = window.update_open_state = Mock()
        window.confirm_read = Mock()
        window.refresh = Mock()
        window.render = Mock(side_effect=lambda **_kwargs: setattr(widget, "asb_thread", window.dashboard["threads"][0]))
        request, clock = Mock(), Mock(return_value=10)
        with patch.dict(SCOPE, {"request_async": request, "time": SimpleNamespace(monotonic=clock), "GLib": SimpleNamespace(idle_add=Mock())}):
            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": dict(widget.asb_thread, unread=False)}, None)
            # The Read of an Idle card shows the check, then the card has no mark.
            window.confirm_read.assert_called_once_with(widget)
            self.assertEqual(widget.asb_last_read_at, 10)
            request.reset_mock()
            clock.return_value = 10.1
            target = SimpleNamespace(get_string=lambda: "a")
            window.row_action(None, target, "discard-result")
            window.row_action(None, target, "keep-result")
            request.assert_not_called()
            self.assertFalse(window.session_actions)
            clock.return_value = 10.5
            window.row_action(None, target, "discard-result")
            self.assertEqual((request.call_args.args[1], request.call_args.args[4], request.call_args.args[5]),
                             ("/api/threads/a/discard-result", "POST", {"next": True}))
            window.session_actions.clear()
            window.row_action(None, target, "keep-result")
            self.assertEqual((request.call_args.args[1], request.call_args.args[5]), ("/api/threads/a/keep-result", None))

    def test_compact_idle_discard_ring_is_passive_and_only_an_armed_row_shows_it(self):
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        for armed in (True, False):
            widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(), set_child=Mock(), asb_mark=Mock(),
                                     asb_source_badge=Mock(), asb_where_icon=None, asb_where_label=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
                                     add_css_class=Mock(), remove_css_class=Mock())
            window.update_session_row(widget, {"id": "a", "provider": "codex", "state": "idle", "discardResult": armed})
            widget.asb_dot.set_visible.assert_called_with(armed)
            (widget.asb_dot.add_css_class if armed else widget.asb_dot.remove_css_class).assert_any_call("asb-discard")
            self.assertFalse(hasattr(widget, "asb_read_button"))

    def test_compact_discard_ring_is_passive_and_keeps_row_geometry(self):
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(), set_child=Mock(), asb_mark=Mock(),
                                 asb_source_badge=Mock(), asb_where_icon=None, asb_where_label=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
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

    def test_card_title_folds_space_and_cuts_long_titles(self):
        self.assertEqual(asb.CARD_TITLE_CHARS, 85)
        self.assertEqual(asb.card_title("Fix the board"), "Fix the board")
        self.assertEqual(asb.card_title("  Fix\n the\t board  "), "Fix the board")
        self.assertEqual(asb.card_title(""), "Untitled session")
        self.assertEqual(asb.card_title(" \n "), "Untitled session")
        self.assertEqual(asb.card_title("a" * 85), "a" * 85)
        for size in (86, 5000):
            self.assertEqual(asb.card_title("a" * size), "a" * 84 + "…")
        self.assertEqual(asb.card_title("a" * 83 + " " + "b" * 10), "a" * 83 + "…")  # No space before the ….
        cut = asb.card_title("a" * 83 + "😀" + "b" * 10)
        self.assertEqual((cut, len(cut)), ("a" * 83 + "😀…", 85))  # The emoji stays whole.

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
                 ({"unread": True, "alert": True, "lastOutcome": "failed"}, "alert", "Failed. Not read yet."),
                 ({"unread": True, "alert": True, "lastOutcome": "limit"}, "alert", "Usage limit stopped the task. Not read yet."),
                 ({"lastOutcome": "stopped"}, "stop", "You stopped this task."),
                 ({"state": "working", "discardResult": True}, "discard", "Discard is on for this task."),
                 ({"discardResult": True}, "discard", "Discard is on for the next task."),
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
        opencode = {**base, "provider": "opencode", "providerLabel": "", "canOpen": False, "pinned": True,
                    "sourceLabel": "OpenCode", "sourceId": "opencode"}
        value = model(opencode, 223_000, "/home/test")
        self.assertEqual((value["app"], value["flags"]),
                         ("OpenCode", "Pinned · No direct link. OpenCode cannot open one session from a link."))
        self.assertIn("OpenCode cannot open one session from a link.", description(value))
        # A view-only row says where it runs in place of "No direct link".
        for extra, flags in (({"surface": "cli", "pinned": True}, "Pinned · CLI session. Runs in a terminal. ASB does not open CLI sessions."),
                             ({"remote": True, "machineName": "homeLP"}, "On homeLP. Open it on homeLP."),
                             ({"remote": True, "machineName": "homeLP", "surface": "cli"}, "On homeLP · CLI session. Open it on homeLP."),
                             ({"remote": True, "machineName": ""}, "On another machine. Open it on another machine."),
                             ({"surface": "app"}, "No direct link")):
            value = model({**base, "canOpen": False, **extra}, 223_000, "/home/test")
            self.assertEqual(value["flags"], flags)
            self.assertIn(flags, description(value))

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
        window.badge_css, window.badge_colors = Mock(), {}
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
        widget.get_first_child.return_value = None
        widget.connect.return_value = 77
        controllers = []
        def controller(**_kwargs):
            value = Mock()
            controllers.append(value)
            return value
        gtk = SimpleNamespace(ListBoxRow=lambda **_kwargs: widget, EventControllerKey=controller,
                              EventControllerFocus=controller, EventControllerMotion=controller, GestureClick=controller,
                              DragSource=controller,
                              DropTarget=SimpleNamespace(new=lambda *_args: controller()),
                              PropagationPhase=SimpleNamespace(CAPTURE=0))
        with patch.dict(SCOPE, {"Gtk": gtk, "Gdk": SimpleNamespace(DragAction=SimpleNamespace(MOVE=0)),
                               "GObject": SimpleNamespace(TYPE_STRING=0)}):
            self.assertIs(window.session_row({"id": "a"}), widget)
            widget.set_has_tooltip.assert_called_once_with(True)
            widget.connect.assert_called_once_with("query-tooltip", window.query_row_tooltip)
            self.assertEqual(len(widget.asb_handlers), 6)
            widget.add_css_class.assert_any_call("asb-unhovered")
            controllers[2].connect.assert_called_once_with("notify::contains-pointer", window.row_hover, "a")
            self.assertIsNone(widget.asb_tooltip_content)
            self.assertIsNone(widget.asb_tooltip_key)
            widget.asb_tooltip_content, widget.asb_tooltip_key = object(), ("cached",)
            window.release_row(widget)
            self.assertIsNone(widget.asb_tooltip_content)
            self.assertIsNone(widget.asb_tooltip_key)
            widget.disconnect.assert_called_once_with(77)
            self.assertEqual(widget.remove_controller.call_count, 6)
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
                    self.assertEqual(bool(row.get("pending")), bool(row.get("questionAttention") or row.get("actionAttention")))
                if row.get("unread") or row.get("questionAttention") or row.get("actionAttention"):
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
        # Read on a required action keeps Waiting and the "?" mark, and takes the row out of pending.
        self.assertIn(("Read", "mark-read"), SCOPE["row_menu_actions"](rows[1]))
        post("/api/threads/sample-1/mark-read")
        self.assertTrue(rows[1]["actionRequired"])
        self.assertFalse(rows[1]["pending"])
        self.assertEqual((rows[1]["state"], SCOPE["attention_indicator"](rows[1])), ("waiting", "question"))
        self.assertEqual(SCOPE["row_menu_actions"](rows[1])[0], ("Unread", "mark-unread"))

    def test_pending_and_drawer_are_exclusive_and_states_need_no_pill_sync(self):
        window = object.__new__(Window)
        window.pending, window.archived = False, False
        window.states, window.profiles = set(), set()
        window.filter_model = ()
        window.drawer_view = False
        window.drawer_only = SimpleNamespace(active=False, get_active=lambda: window.drawer_only.active,
                                             set_active=lambda value: setattr(window.drawer_only, "active", value))
        window.filter_changed = Mock()
        window.list_body = Mock()
        window.search = Mock(get_text=Mock(return_value=""))
        window.dashboard = {"threads": [
            {"id": "codex-working", "provider": "codex", "state": "working", "pending": True},
            {"id": "claude-working", "provider": "claude-desktop-code", "state": "working", "pending": True},
            {"id": "codex-active", "provider": "codex", "state": "working"},
            {"id": "codex-idle", "provider": "codex", "state": "idle", "pending": True},
            {"id": "archived", "provider": "codex", "state": "working", "pending": True, "archived": True},
        ]}
        window.show_all_cards, window.card_limit = False, 100
        window.set_pending(True)
        self.assertTrue(window.pending)
        window.filter_changed.assert_called()
        window.drawer_only.active = True
        window.drawer_view = True
        window.pending = True
        window.drawer_toggled()
        self.assertFalse(window.pending)
        self.assertTrue(window.drawer_view)
        window.set_pending(True)
        self.assertFalse(window.drawer_only.active)
        self.assertTrue(window.pending)
        window.set_pending(False)
        window.drawer_view = False
        self.assertEqual({row["id"] for row in window.visible_rows()},
                         {"codex-working", "claude-working", "codex-active", "codex-idle"})
        window.set_pending(True)
        self.assertEqual({row["id"] for row in window.visible_rows()},
                         {"codex-working", "claude-working", "codex-idle"})
        window.states = {"working"}
        self.assertEqual({row["id"] for row in window.visible_rows()},
                         {"codex-working", "claude-working", "codex-active", "codex-idle"})
        window.set_pending(False)
        self.assertEqual({row["id"] for row in window.visible_rows()}, {"codex-working", "claude-working", "codex-active"})
        window.states = {"working", "idle"}
        self.assertEqual({row["id"] for row in window.visible_rows()},
                         {"codex-working", "claude-working", "codex-active", "codex-idle"})
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
        self.assertEqual([row["id"] for row in filtered(board, state=set(), pending_only=True)], ["working-unread"])
        self.assertEqual({row["id"] for row in filtered(board, app="codex", state={"working"}, pending_only=True)}, expected - {"claude-unread"})
        self.assertEqual({row["id"] for row in filtered(board, "find", app="codex", state={"working"}, pending_only=True)},
                         {"working-read", "idle-unread"})
        self.assertEqual([row["id"] for row in filtered(board, "cl:find", app="codex", state={"working"}, pending_only=True)],
                         ["claude-unread"])
        self.assertEqual({row["id"] for row in filtered(board, state={"working"}, pending_only=True, archived=True)},
                         expected | {"archived-unread"})

    def test_hover_retargets_clears_and_settles_with_animations_disabled(self):
        def card():
            classes = set()
            return SimpleNamespace(classes=classes, add_css_class=classes.add, remove_css_class=classes.discard)
        strip = object.__new__(Strip)
        classes = set()
        strip.add_css_class, strip.remove_css_class = classes.add, classes.discard
        strip.queue_draw = Mock()
        strip.get_settings = Mock(return_value=Mock(get_property=Mock(return_value=True)))
        strip.hover_animation = Mock(reset=Mock(side_effect=lambda: strip.advance_hover(0)))
        strip.hover_rect = strip.hover_target = strip.hover_from = strip.hover_to = strip.hover_card = None
        strip.hover_alpha = 0
        strip.clear_hover()
        first, second, across = (0, 0, 240, 68), (0, 68, 240, 68), (252, 0, 240, 68)
        one, two, three = card(), card(), card()
        strip.show_hover(first, one)
        self.assertEqual(strip.hover_alpha, 0)
        self.assertEqual((one.classes, classes), ({"asb-hover-paint"}, set()))
        strip.hover_animation.set_duration.assert_called_with(100)
        strip.advance_hover(.5)
        self.assertEqual((strip.hover_rect, strip.hover_alpha), (first, .5))
        strip.advance_hover(1)
        strip.show_hover(second, two)
        self.assertEqual((one.classes, two.classes), (set(), {"asb-hover-paint"}))
        strip.hover_animation.set_duration.assert_called_with(200)
        strip.advance_hover(.5)
        self.assertEqual(strip.hover_rect, (0, 34, 240, 68))
        strip.show_hover(across, three)
        self.assertEqual((two.classes, three.classes), (set(), {"asb-hover-paint"}))
        self.assertEqual(strip.hover_from, (0, 34, 240, 68, 1))
        strip.advance_hover(.5)
        self.assertEqual(strip.hover_rect, (126, 17, 240, 68))
        strip.advance_hover(1)
        strip.show_hover(None)
        self.assertEqual(three.classes, set())  # The pointer left the card, so the fade-out needs no class.
        strip.hover_animation.set_duration.assert_called_with(100)
        strip.advance_hover(.5)
        self.assertEqual((strip.hover_rect, strip.hover_alpha), (across, .5))
        strip.advance_hover(1)
        self.assertIsNone(strip.hover_rect)
        strip.show_hover(first, one)
        strip.advance_hover(.5)
        self.assertEqual(strip.hover_rect, first)
        strip.queue_draw.reset_mock()
        strip.hover_animation.reset.reset_mock()
        strip.clear_hover()
        self.assertEqual((one.classes, strip.hover_card), (set(), None))
        for _frame in range(20):
            strip.clear_hover()
        strip.queue_draw.assert_called_once_with()
        strip.hover_animation.reset.assert_called_once_with()
        strip.queue_draw.reset_mock()
        strip.advance_hover(.5)
        strip.queue_draw.assert_not_called()
        self.assertIsNone(strip.hover_target)
        strip.get_settings.return_value.get_property.return_value = False
        strip.hover_animation.play.reset_mock()
        for rectangle, hovered in ((second, two), (across, three), (None, None)):
            strip.show_hover(rectangle, hovered)
            self.assertEqual(strip.hover_rect, rectangle)
            self.assertEqual(strip.hover_alpha, 1 if rectangle else 0)
            self.assertEqual([item for item in (one, two, three) if item.classes], [hovered] if hovered else [])
        strip.hover_animation.play.assert_not_called()
        self.assertEqual(classes, set())  # The strip never gets a class, so no change restyles all cards.

    def test_row_hover_sets_exactly_one_hover_class(self):
        window = object.__new__(Window)
        classes = {"asb-session", "asb-unhovered"}
        card = SimpleNamespace(add_css_class=classes.add, remove_css_class=classes.discard)
        for inside, expected in ((True, "asb-hovered"), (True, "asb-hovered"), (False, "asb-unhovered"), (True, "asb-hovered")):
            window.row_hover(SimpleNamespace(contains_pointer=lambda: inside, get_widget=lambda: card), None, "s1")
            self.assertEqual(classes, {"asb-session", expected})
        # The ASB CSS names no hover pseudo-class on a card; only buttons keep it.
        css = SOURCE.read_text()
        for rule in (".asb-session:hover", ".asb-unread:hover", ":not(:hover)", '":hover"'):
            self.assertNotIn(rule, css)

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
            window.list_body.show_hover.assert_called_once_with(None, None)
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
            window.events, window.get_display, window.css, window.badge_css = Mock(), Mock(), object(), object()
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
                                               (token, "/api/dashboard", "GET", None),
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
        # The environment is read once (a board started by hand). The token is used in the header rule (3 lines), in report_ui and the final UI report, and in the
        # launcher start and reconnect, which set it (a global statement and the assignment each) from stdin.
        self.assertEqual(source.count("ASB_SOURCE_TOKEN"), 1)
        self.assertEqual(source.count("SOURCE_TOKEN"), 10)

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
        # The repack takes the other rows out and leaves the focused row in its place, so render does not set the focus again.
        self.assertEqual(window.list_body.children[0].children, [widgets["a"]])
        window.set_focus.assert_not_called()
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
        window.events, window.get_display, window.css, window.badge_css = Mock(), Mock(), object(), object()
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
        marker.owner, marker.color_class, marker.set_visible = window, "", Mock()
        marker.add_css_class, marker.remove_css_class = Mock(), Mock()
        widget.asb_source_badge = marker
        window.row_cache, window.focus_widgets = {"a": widget}, {}
        window.css, window.add_css_class, window.remove_css_class = Mock(), Mock(), Mock()
        window.badge_css, window.badge_colors = Mock(), {}
        palette = {"background": "#0f0f0f", "text": "#f6f5f4", "muted": "#aaaaaa", "accent": "#cccccc", "divider": "#444444"}
        window.native_colors = lambda: palette
        window.set_palette(None)
        window.set_palette({**palette, "background": "#202020"})
        self.assertIn("border-color: #202020", window.badge_css.load_from_string.call_args.args[0])
        self.assertFalse(window.focus_widgets)
        gtk = SimpleNamespace(ListBox=Box, Box=lambda **_kwargs: Mock(), Image=lambda **_kwargs: Mock(),
                              Overlay=lambda **_kwargs: Mock(), Button=lambda **_kwargs: Mock(),
                              Stack=lambda **_kwargs: Mock(), Revealer=lambda **_kwargs: Mock(),
                              EventControllerMotion=lambda: Mock(),
                              StackTransitionType=SimpleNamespace(SLIDE_UP=0, SLIDE_DOWN=1, CROSSFADE=2),
                              RevealerTransitionType=SimpleNamespace(SLIDE_RIGHT=0),
                              SelectionMode=SimpleNamespace(NONE=0), Align=SimpleNamespace(START=0, CENTER=1, END=2),
                              Orientation=SimpleNamespace(VERTICAL=0), AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        request = Mock()
        glib = SimpleNamespace(idle_add=Mock(), source_remove=Mock(), Variant=lambda _kind, value: value)
        window.visible_rows = lambda: window.dashboard["threads"]
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": glib, "Gio": Mock(), "set_icon": Mock(), "request_async": request,
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
            self.assertEqual(widget.asb_read_button.asb_action, "win.mark-read")

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
            # Only one row of the swap moves: the focused row "a".
            self.assertEqual(operations, {"remove": 1, "insert": 1, "append": 0})
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

    def test_column_moves_keep_the_longest_ordered_run_and_give_the_target(self):
        moves = SCOPE["column_moves"]
        def apply(current, target):
            removals, inserts = moves(current, target)
            column = [card for card in current if card not in removals]
            self.assertEqual([index for index, _card in inserts], sorted(index for index, _card in inserts))
            for index, card in inserts:
                column.insert(index, card)
            self.assertEqual(column, list(target))
            return len(removals), len(inserts)
        for current, target, expected in (("abcd", "abcd", (0, 0)), ("abcd", "dabc", (1, 1)), ("abcd", "bacd", (1, 1)),
                                          ("abcd", "xabc", (1, 1)), ("abc", "ac", (1, 0)), ("", "ab", (0, 2)), ("ab", "", (2, 0)),
                                          ("abcde", "edcba", (4, 4)), ("", "", (0, 0))):
            with self.subTest(current=current, target=target):
                self.assertEqual(apply(list(current), list(target)), expected)
        random = __import__("random").Random(4629)
        for _case in range(200):
            cards = random.sample(range(40), random.randint(0, 20))
            current = random.sample(cards, random.randint(0, len(cards)))
            target = random.sample(cards, random.randint(0, len(cards)))
            removals, inserts = apply(current, target)
            # The cards that stay are a longest run of current that has the target order.
            place = {card: index for index, card in enumerate(target)}
            kept = [place[card] for card in current if card in place]
            longest = [1] * len(kept)
            for later in range(len(kept)):
                for earlier in range(later):
                    if kept[earlier] < kept[later]:
                        longest[later] = max(longest[later], longest[earlier] + 1)
            self.assertEqual(inserts, len(target) - max(longest, default=0))
            self.assertEqual(removals, len(current) - max(longest, default=0))

    def test_render_takes_the_popover_hooks_off_and_puts_them_back_once(self):
        window = object.__new__(Window)
        gobject = SimpleNamespace(add_emission_hook=Mock(side_effect=lambda *_args, ids=itertools.count(10): next(ids)), remove_emission_hook=Mock())
        window.closed, window.popover_hooks, window.popover_visibility = False, [("map", 1), ("unmap", 2)], Mock()
        seen = []
        def board(*args, **kwargs):
            seen.append((list(window.popover_hooks), args, kwargs))
            if len(seen) == 1:
                window.render("nested")
            return "done"
        window.render_board = board
        with patch.dict(SCOPE, {"GObject": gobject, "Gtk": SimpleNamespace(Popover="Popover")}):
            self.assertEqual(window.render("a", reveal_focus=True), "done")
            # No hook is on inside a render, also in a nested one, and the hooks come back once.
            self.assertEqual(seen, [([], ("a",), {"reveal_focus": True}), ([], ("nested",), {})])
            self.assertEqual([call.args[:2] for call in gobject.remove_emission_hook.call_args_list], [("Popover", "map"), ("Popover", "unmap")])
            self.assertEqual(gobject.add_emission_hook.call_count, 2)
            self.assertEqual(window.popover_hooks, [("map", 10), ("unmap", 11)])
            window.render_board = Mock(side_effect=RuntimeError("render failed"))
            with self.assertRaises(RuntimeError):
                window.render()
            self.assertEqual(window.popover_hooks, [("map", 12), ("unmap", 13)])
            # A window that closes in a render gets no hooks back.
            window.render_board = lambda: setattr(window, "closed", True)
            window.render()
            self.assertEqual((window.popover_hooks, gobject.add_emission_hook.call_count), ([], 4))

    def test_card_actions_set_a_tooltip_only_when_its_text_changes(self):
        def button():
            item = Mock()
            item.tip = None
            item.get_tooltip_text.side_effect = lambda: item.tip
            item.set_tooltip_text.side_effect = lambda text: setattr(item, "tip", text)
            return item
        window = object.__new__(Window)
        window.session_actions, window.column_pixel_width, window.clear_read_feedback = set(), 240, Mock()
        read, pin, drawer, copy = buttons = [button() for _index in range(4)]
        widget = SimpleNamespace(asb_view="comfortable", asb_thread={"id": "a", "title": "Chat", "state": "idle", "unread": True},
                                 asb_read_timer=None, asb_copy_timer=None, asb_read_button=read, asb_pin_button=pin,
                                 asb_drawer_button=drawer, asb_copy_button=copy)
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1),
                              AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.update_card_actions(widget)
            self.assertEqual([item.tip for item in buttons],
                             ["Mark read in ASB", "Pin in ASB", "Put in drawer: look read here, keep it under Drawer", "Copy relative reference"])
            for item in buttons:
                item.set_tooltip_text.reset_mock()
            # A new title changes the labels but no tooltip.
            widget.asb_thread = {**widget.asb_thread, "title": "Chat 2"}
            window.update_card_actions(widget)
            read.update_property.assert_called_with([0], ["Mark read in ASB: Chat 2"])
            for item in buttons:
                item.set_tooltip_text.assert_not_called()
            widget.asb_thread = {**widget.asb_thread, "pinned": True}
            widget.asb_copy_timer = 7
            window.update_card_actions(widget)
            pin.set_tooltip_text.assert_called_once_with("Unpin in ASB")
            copy.set_tooltip_text.assert_not_called()  # The footer shows the copied text, so the tooltip stays.
            read.set_tooltip_text.assert_not_called()
            drawer.set_tooltip_text.assert_not_called()

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
                                 "asb_where_icon", "asb_where_label", "set_activatable", "set_sensitive", "update_property", "update_state", "remove_css_class"):
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
            window.events, window.get_display, window.css, window.badge_css = Mock(), Mock(), object(), object()
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
                                 set_child=Mock(), asb_mark=Mock(), asb_source_badge=Mock(), asb_where_icon=None, asb_where_label=Mock(), asb_dot=Mock(), asb_state_label=Mock(),
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
        widget = SimpleNamespace(asb_view="comfortable", asb_thread={}, set_activatable=Mock(), asb_mark=Mock(), asb_source_badge=Mock(), asb_where_icon=Mock(), asb_where_label=Mock(),
                                 asb_dot=Mock(), asb_state_label=Mock(), asb_folder=Mock(),
                                 add_css_class=classes.add, remove_css_class=classes.discard)
        row = {"id": "a", "provider": "codex", "state": "idle", "unread": False, "pending": False}
        for extra, quiet in (({}, True), ({"pinned": True}, True), ({"readStatus": "unknown"}, True),
                             ({"readStatus": "unread", "nativeUnread": True, "nativeAttention": False}, True),
                             ({"state": "working"}, False), ({"state": "waiting"}, True), ({"state": "unknown"}, False),
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
                                 get_parent=lambda: None, get_first_child=lambda: None)
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
                                 asb_pin_button=Mock(), asb_mark=Mock(), asb_source_badge=Mock(), asb_where_icon=Mock(), asb_where_label=Mock(), asb_dot=Mock(), asb_folder=Mock(),
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
            self.assertEqual(widget.asb_read_button.asb_action, None)
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
            self.assertEqual(widget.asb_pin_button.asb_action, "win.unpin")
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
            # The Idle card has no mark now: its Read slot offers Discard for the next task.
            widget.asb_read_button.set_visible.assert_called_with(True)
            self.assertEqual(widget.asb_read_button.asb_action, "win.discard-result")

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
                self.assertEqual(widget.asb_read_button.asb_action, None)

            window.dashboard["threads"] = [dict(row, state="working", unread=False, questionAttention=True,
                                                discardResult=True, updatedAtMs=600)]
            window.render()
            window.session_action("a", "mark-read")
            request.call_args.args[2]({"thread": dict(window.dashboard["threads"][0], questionAttention=False)}, None)
            self.assertIsNone(widget.asb_read_timer)
            self.assertEqual(widget.asb_read_button.asb_action, "win.keep-result")
            self.assertEqual(len(timers), 3)

            window.confirm_read(widget)
            removed_feedback = timers[-1][1]
            widget.asb_handlers, widget.get_parent, widget.get_first_child = [], lambda: None, lambda: None
            window.release_row(widget)
            window.focus_widgets["a"] = SimpleNamespace(asb_read_timer=None)
            widget.asb_read_button.set_visible.reset_mock()
            self.assertFalse(removed_feedback())
            widget.asb_read_button.set_visible.assert_not_called()

    def test_action_keys_stop_row_activation_and_pin_focus_survives_repack(self):
        window = object.__new__(Window)
        window.context_menu = None
        button = SimpleNamespace(asb_card_action="pin", get_sensitive=lambda: True, activate=Mock(),
                                 get_visible=lambda: True, asb_action="win.pin")
        window.get_focus = lambda: button
        gdk = SimpleNamespace(KEY_space=32, KEY_Return=13, KEY_KP_Enter=44, KEY_Up=1, KEY_Down=2,
                              ModifierType=SimpleNamespace(ALT_MASK=1, CONTROL_MASK=2, SUPER_MASK=4, META_MASK=8))
        with patch.dict(SCOPE, {"Gdk": gdk, "SHORTCUT_MASK": 8}):
            for key in (32, 13, 44):
                self.assertTrue(window.row_key(None, key, 0, 0, "a"))
            self.assertEqual(button.activate.call_count, 3)
            button.asb_action = None
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

    def test_card_action_clicked_activates_the_window_action_of_the_button(self):
        window = object.__new__(Window)
        window.activate_action = Mock()
        button = SimpleNamespace(asb_action="win.pin", asb_identity="a")
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(Variant=lambda kind, value: (kind, value))}):
            window.card_action_clicked(button)
            window.activate_action.assert_called_once_with("win.pin", ("s", "a"))
            button.asb_action = None
            window.card_action_clicked(button)
        window.activate_action.assert_called_once()

    def test_trim_row_cache_releases_hidden_cards_above_twice_the_limit(self):
        more = SCOPE["MORE_ID"]
        def window_with(cards, shown):
            window = object.__new__(Window)
            window.closed, window.card_limit, window.row_cache_trim = False, 2, "queued"
            window.row_cache = {identity: SimpleNamespace(name=identity) for identity in cards}
            window.focus_widgets = {identity: window.row_cache[identity] for identity in shown}
            window.open_errors = {"r6": "Cannot open."}
            window.release_row = Mock()
            return window
        # 8 cached cards: 2 shown, the More card, and 5 hidden.
        window = window_with([f"r{n}" for n in range(7)] + [more], ["r0", "r1", more])
        self.assertFalse(window.trim_row_cache())
        self.assertIsNone(window.row_cache_trim)
        self.assertEqual(set(window.row_cache), {"r0", "r1", more})
        self.assertEqual(sorted(call.args[0].name for call in window.release_row.call_args_list), ["r2", "r3", "r4", "r5", "r6"])
        self.assertEqual(window.open_errors, {"r6": "Cannot open."})
        # At 2 x limit + 1 cards or less nothing goes.
        for change, cards in ((dict(show_all_cards=True), 8), (dict(card_limit=0), 8), (dict(closed=True), 8), ({}, 5)):
            with self.subTest(change=change, cards=cards):
                window = window_with([f"r{n}" for n in range(cards - 1)] + [more], ["r0", "r1", more])
                window.__dict__.update(change)
                self.assertFalse(window.trim_row_cache())
                self.assertIsNone(window.row_cache_trim)
                window.release_row.assert_not_called()
                self.assertEqual(len(window.row_cache), cards)

    def test_pending_and_confirmed_controls_keep_native_pointer_targets_and_exclude_pin_drag(self):
        read, pin = Mock(), Mock()
        for control, name in ((read, "read"), (pin, "pin")):
            control.asb_card_action = name
            control.set_sensitive.side_effect = lambda enabled, target=control: setattr(target.get_sensitive, "return_value", enabled)
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
        gdk = SimpleNamespace(KEY_space=32, KEY_Return=13, KEY_KP_Enter=44, KEY_Up=1, KEY_Down=2,
                              ModifierType=SimpleNamespace(ALT_MASK=1, CONTROL_MASK=2, SUPER_MASK=4, META_MASK=8),
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
                    self.assertEqual(read.asb_action, None if pending or confirmed else "win.mark-read")
                    self.assertEqual(pin.asb_action, None if pending else "win.unpin")
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
                              KEY_Menu=7, KEY_F10=8, KEY_space=9, KEY_Return=10, KEY_KP_Enter=11,
                              ModifierType=SimpleNamespace(ALT_MASK=1, CONTROL_MASK=2, SUPER_MASK=4, META_MASK=8, SHIFT_MASK=16))
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

        self.assertEqual(actions(unread), [("Read", "mark-read"), ("Put in drawer", "drawer-in"), ("Mute", "mute"), ("Pin", "pin")])
        self.assertEqual(actions(tucked), [("Read", "mark-read"), ("Take out of drawer", "drawer-out"), ("Mute", "mute"), ("Pin", "pin")])
        self.assertEqual(actions({**tucked, "state": "working"}),
                         [("Read", "mark-read"), ("Take out of drawer", "drawer-out"), ("Mute", "mute"), ("Pin", "pin"),
                          ("Discard result", "discard-result")])
        self.assertEqual(actions({**tucked, "actionRequired": True}),
                         [("Read", "mark-read"), ("Take out of drawer", "drawer-out"), ("Mute", "mute"), ("Pin", "pin")])
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
            self.assertEqual(drawer.asb_action, "win.drawer-in")
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
            self.assertEqual(drawer.asb_action, None)
            drawer.add_css_class.assert_any_call("asb-action-pending")
            drawer.update_state.assert_called_with([0, 1], [True, True])
            request.call_args.args[2](None, "Cannot change this session.")
            self.assertEqual((window.open_errors, window.session_actions, window.dashboard_etag),
                             ({"a": "Cannot change this session."}, set(), "etag"))
            self.assertTrue(widget.asb_thread["unread"])
            self.assertEqual(drawer.asb_action, "win.drawer-in")
            window.refresh.assert_not_called()

            window.session_action("a", "drawer-in")
            reply = dict(row, unread=False, pending=False, drawer=True)
            request.call_args.args[2]({"changed": True, "threadId": "a", "thread": reply}, None)
            self.assertEqual((window.dashboard["threads"], window.open_errors, window.dashboard_etag), ([reply], {}, None))
            window.refresh.assert_called_once_with(queue=True)
            timeout.assert_not_called()  # No Read confirmation.
            self.assertIsNone(widget.asb_read_timer)
            drawer.set_visible.assert_called_with(True)
            self.assertEqual(drawer.asb_action, "win.drawer-out")
            drawer.add_css_class.assert_any_call("asb-drawer-filled")
            drawer.set_tooltip_text.assert_called_with(out)
            drawer.update_property.assert_called_with([0], [out + ": Chat"])
            widget.asb_read_button.set_visible.assert_called_with(True)
            self.assertEqual(widget.asb_read_button.asb_action, "win.mark-read")

            window.session_action("a", "drawer-out")
            self.assertEqual(request.call_args.args[1], "/api/threads/a/drawer-out")
            request.call_args.args[2]({"changed": True, "threadId": "a", "thread": dict(row)}, None)
            self.assertEqual(window.dashboard["threads"], [row])
            self.assertEqual(drawer.asb_action, "win.drawer-in")
            timeout.assert_not_called()

            for thread, width, shown in ((base, 240, False), (row, 189, False), (reply, 189, False), (row, 190, True),
                                         ({**row, "questionAttention": True}, 240, False), ({**reply, "state": "working"}, 240, True)):
                widget.asb_thread, window.column_pixel_width = {**thread, "id": "a"}, width
                window.update_card_actions(widget)
                drawer.set_visible.assert_called_with(shown)
                # Copy is in every wide corner, so the fade follows the width, not the drawer button.
                (corner.add_css_class if width >= 190 else corner.remove_css_class).assert_called_with("asb-corner-wide")
        css = SOURCE.read_text()
        for rule in ("{base} .asb-unread.asb-hovered .asb-dot,", "{base} .asb-drawer:not(.asb-drawer-lit) .asb-dot {{ opacity: 0; }}",
                     "{base} .asb-unread.asb-hovered .asb-read-cue,", "{base} .asb-drawer.asb-drawer-lit.asb-unhovered .asb-state {{ opacity: 1; }}"):
            self.assertIn(rule, css)
        self.assertIn('"drawer-in", "drawer-out", "mute", "unmute"):', css)

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

    def test_copy_values_check_both_references_and_give_each_reason(self):
        full = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:123e4567-e89b-12d3-a456-426614174000"
        local = {"id": "x", "externalId": "123e4567-e89b-12d3-a456-426614174000", "provider": "codex",
                 "sessionReference": "codex/123e4567-e89b-12d3-a456-426614174000", "reference": full}
        self.assertEqual(asb.copy_values(local), ("codex/123e4567-e89b-12d3-a456-426614174000", None, full, None))
        short = local["sessionReference"]
        def off(code, **extra):
            row = {**local, "referenceUnavailable": code, **extra}
            row.pop("reference")
            return asb.copy_values(row)
        self.assertEqual(off("unknown-source"), (short, None, None, "ASB does not know the profile of this session."))
        member = off("unknown-source", remote=True, machineName="homeLP")
        self.assertEqual(member[3], "homeLP did not send the profile of this session.")
        self.assertEqual(off("old-peer", remote=True, machineName="homeLP")[3], "homeLP has an older ASB. Update ASB on that machine.")
        self.assertEqual(off("no-machine-identity")[3], "This computer has no ASB machine ID. Run asb doctor.")
        self.assertEqual(off("ambiguous-source"), (short, None, None, "More than one profile reads this session. ASB cannot pick one."))
        # An invalid ID has no short value either; both rows have the same reason.
        invalid = "This session has an ID in a form that ASB does not know."
        self.assertEqual(off("invalid-app-id", sessionReference=None), (None, invalid, None, invalid))
        unsupported = "This version of ASB does not know this app. Update ASB on this machine."
        self.assertEqual(off("unsupported-type", sessionReference=None), (None, unsupported, None, unsupported))
        fallback = "ASB cannot make a full reference for this session."
        self.assertEqual(off("new-code")[2:], (None, fallback))
        self.assertEqual(off(["list"])[2:], (None, fallback))
        self.assertEqual(asb.copy_values({**local, "reference": full + " x"})[2:], (None, fallback))
        # An old engine sends no reference keys: the short value comes from session_reference, the full one is off.
        old = {"id": "x", "externalId": "local_1234", "provider": "claude-desktop-code", "sourceName": "claude-proxy"}
        self.assertEqual(asb.copy_values(old), ("claude-proxy/local_1234", None, None, "The ASB engine is older. Quit ASB and start it again."))
        for bad in ("codex/a\nb", "codex/a b", "codex/\u00e9", "c/" + "a" * 383, "codex/\ud800", "", None, 7):
            self.assertEqual(asb.copy_values({**local, "sessionReference": bad})[:2], (None, invalid), repr(bad))
            self.assertEqual(asb.copy_values({**local, "reference": bad})[2:], (None, fallback), repr(bad))
        self.assertEqual(asb.copy_values({**local, "sessionReference": "c/" + "a" * 382})[0], "c/" + "a" * 382)
        self.assertEqual(asb.copy_values({**old, "externalId": "local_1\n"})[:2], (None, invalid))

    def copy_panel(self, values):
        """A window and a panel with mock copy rows; the real copy handlers run."""
        timers, removed = {}, []
        def timeout_add(delay, callback):
            timers[len(timers) + 1] = (delay, callback)
            return len(timers)
        glib = SimpleNamespace(timeout_add=timeout_add, source_remove=removed.append, Error=type("GError", (Exception,), {}))
        gtk = SimpleNamespace(Popover=object, AccessibleProperty=SimpleNamespace(DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=2))
        window = object.__new__(Window)
        window.closed, window.update_row_panel, window.session_actions = False, Mock(), set()
        clipboard = Mock()
        window.get_clipboard = lambda: clipboard
        row = {"id": "a"}
        window.focus_widgets = {"a": SimpleNamespace(asb_thread=row)}
        panel = SimpleNamespace(asb_identity="a", asb_copy=Mock(), asb_copy_full=Mock(), asb_copy_timer=None, asb_copy_error="",
                                asb_copy_values=values, asb_copied=None)
        for button in (panel.asb_copy, panel.asb_copy_full):
            button.get_ancestor = lambda _type: panel
        return window, panel, clipboard, timers, removed, glib, gtk, row

    def test_panel_copy_writes_each_reference_and_shows_copied_for_a_moment(self):
        full = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:1"
        window, panel, clipboard, timers, removed, glib, gtk, row = self.copy_panel(("codex/1", None, full, None))
        short, absolute = panel.asb_copy, panel.asb_copy_full
        icon = Mock()
        with patch.dict(SCOPE, {"GLib": glib, "Gtk": gtk, "set_icon": icon}):
            window.show_copy_rows(panel)
            self.assertEqual((short.asb_tip, absolute.asb_tip), ("codex/1", full))
            short.set_tooltip_text.assert_called_with("codex/1")
            absolute.set_tooltip_text.assert_not_called()  # Row 2 has its own wrapped tooltip.
            short.asb_caption.set_label.assert_called_with("Relative: in the same app")
            absolute.asb_caption.set_label.assert_called_with("Absolute: with ASB, any machine")
            absolute.asb_caption.set_lines.assert_called_with(1)
            absolute.update_state.assert_called_with([0, 2], [False, False])
            absolute.update_property.assert_called_with([1], [full])
            window.panel_copy(short, "short")
            clipboard.set.assert_called_once_with("codex/1")
            icon.assert_any_call(short.asb_icon, "object-select-symbolic")
            short.add_css_class.assert_any_call("asb-copy-done")
            short.set_tooltip_text.assert_called_with("codex/1")  # The caption shows the copied text.
            short.update_property.assert_called_with([1], ["Relative session copied"])
            short.asb_label.set_label.assert_not_called()  # The label stays.
            self.assertEqual(timers[1][0], 1600)
            window.update_row_panel.assert_called_with(panel, row)
            # A copy on row 2 ends the check on row 1 at once.
            window.panel_copy(absolute, "full")
            clipboard.set.assert_called_with(full)
            self.assertEqual((removed, panel.asb_copy_timer, panel.asb_copied), ([1], 2, "full"))
            icon.assert_any_call(short.asb_icon, "edit-copy-symbolic")
            icon.assert_called_with(absolute.asb_icon, "object-select-symbolic")
            short.update_property.assert_called_with([1], ["codex/1"])
            absolute.update_property.assert_called_with([1], ["Absolute session copied"])
            self.assertEqual(absolute.asb_tip, full)
            # After 1.6 seconds the description is the exact value again; nothing resets it to empty.
            timers[2][1]()
            self.assertEqual((panel.asb_copy_timer, panel.asb_copied, absolute.asb_tip), (None, None, full))
            absolute.update_property.assert_called_with([1], [full])
            absolute.reset_property.assert_not_called()
            # Close removes a running timer, so no late callback touches the panel.
            window.panel_copy(short, "short")
            window.clear_copy_feedback(panel)
            self.assertEqual((removed[-1], panel.asb_copy_timer), (3, None))
            for button, text in ((short, "relative"), (absolute, "absolute")):
                clipboard.set.side_effect = TypeError("no clipboard")
                window.panel_copy(button, "short" if button is short else "full")
                self.assertEqual(panel.asb_copy_error, f"Cannot copy the {text} reference: no clipboard")
                self.assertIsNone(panel.asb_copied)
            self.assertEqual(len(timers), 3)
            clipboard.set.side_effect = None
            window.panel_copy(absolute, "full")
            self.assertEqual(panel.asb_copy_error, "")
            # While an action for the row runs, both rows are busy and copy nothing.
            window.session_actions.add("a")
            window.show_copy_rows(panel)
            for button in (short, absolute):
                button.update_state.assert_called_with([0, 2], [True, True])
                button.add_css_class.assert_any_call("asb-action-pending")
            clipboard.set.reset_mock()
            window.panel_copy(short, "short")
            clipboard.set.assert_not_called()

    def test_an_unavailable_copy_row_is_focusable_has_no_action_and_shows_its_reason(self):
        invalid = "This session has an ID in a form that ASB does not know."
        window, panel, clipboard, timers, _removed, glib, gtk, _row = self.copy_panel((None, invalid, None, invalid))
        short, absolute = panel.asb_copy, panel.asb_copy_full
        with patch.dict(SCOPE, {"GLib": glib, "Gtk": gtk}):
            window.show_copy_rows(panel)
            for button in (short, absolute):
                window.panel_copy(button, "short" if button is short else "full")
                button.update_state.assert_called_with([0, 2], [False, True])
                button.add_css_class.assert_any_call("asb-copy-off")
                button.update_property.assert_called_with([1], [invalid])
                self.assertEqual(button.asb_tip, invalid)
                button.set_sensitive.assert_not_called()
            clipboard.set.assert_not_called()
            window.update_row_panel.assert_not_called()
            self.assertEqual(timers, {})
            # One reason for both rows shows once, under row 2, in at most two lines.
            short.asb_caption.set_visible.assert_called_with(False)
            absolute.asb_caption.set_label.assert_called_with(invalid)
            absolute.asb_caption.set_lines.assert_called_with(2)
            # Different reasons: each row shows its own.
            unknown = "ASB does not know the profile of this session."
            panel.asb_copy_values = (None, invalid, None, unknown)
            window.show_copy_rows(panel)
            short.asb_caption.set_label.assert_called_with(invalid)
            absolute.asb_caption.set_label.assert_called_with(unknown)
            # Available again: no DISABLED state.
            panel.asb_copy_values = ("codex/1", None, None, unknown)
            window.show_copy_rows(panel)
            short.update_state.assert_called_with([0, 2], [False, False])
            short.remove_css_class.assert_any_call("asb-copy-off")

    def test_the_disabled_card_copy_button_has_no_action_and_never_copies(self):
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        row = {"id": "a", "title": "Chat", "state": "idle", "externalId": "bad id", "provider": "codex", "referenceUnavailable": "invalid-app-id"}
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=row, asb_focus_key="a", asb_read_timer=None, asb_copy_timer=None,
                                 asb_read_button=Mock(), asb_pin_button=Mock(), asb_copy_button=Mock())
        copy = widget.asb_copy_button
        window = object.__new__(Window)
        window.session_actions, window.column_pixel_width, window.closed, window.open_errors = set(), 240, False, {}
        window.focus_widgets = {"a": widget}
        clipboard = Mock()
        window.get_clipboard = lambda: clipboard
        with patch.dict(SCOPE, {"Gtk": gtk}):
            window.update_card_actions(widget)
            copy.set_visible.assert_called_with(True)
            self.assertEqual(copy.asb_action, None)
            copy.add_css_class.assert_any_call("asb-copy-off")
            copy.update_state.assert_called_with([1], [True])
            copy.set_tooltip_text.assert_called_with("This session has an ID in a form that ASB does not know.")
            copy.update_property.assert_any_call([0], ["Copy relative reference: Chat"])
            window.copy_reference(None, SimpleNamespace(get_string=lambda: "a"))
            clipboard.set.assert_not_called()
            self.assertIsNone(widget.asb_copy_timer)

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
            glyph = SCOPE["set_icon"].call_args.args[1]
            return (widget.asb_copy_timer, glyph, button.set_tooltip_text.call_args.args[0],
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
            self.assertEqual(feedback(third), (3, "object-select-symbolic", "Copy relative reference", ([1], ["Relative session copied"])))
            third.asb_copy_button.reset_mock()
            clipboard.set.side_effect = TypeError("no clipboard")
            window.copy_reference(None, target(rows[2]["id"]))
            self.assertEqual(removed[-1], 3)
            self.assertEqual(feedback(third), (None, "edit-copy-symbolic", "Copy relative reference", (1,)))
            self.assertEqual(window.open_errors, {rows[2]["id"]: "Cannot copy the relative reference: no clipboard"})
            window.update_open_state.assert_called_once_with(third)
            self.assertEqual(len(timers), 5)
            # A later success clears the old copy error from the row tooltip, and an open error stays.
            clipboard.set.side_effect = None
            window.copy_reference(None, target(rows[2]["id"]))
            self.assertEqual(window.open_errors, {})
            self.assertEqual(window.update_open_state.call_count, 2)
            self.assertEqual(feedback(third), (6, "object-select-symbolic", "Copy relative reference", ([1], ["Relative session copied"])))
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
                self.assertEqual(copy.asb_action, "win.copy-reference")
                SCOPE["set_icon"].assert_called_with(copy.get_child(), "object-select-symbolic" if copied else "edit-copy-symbolic")
                (copy.add_css_class if copied else copy.remove_css_class).assert_called_with("asb-copy-confirmed")
                copy.set_tooltip_text.assert_called_with("Copy relative reference")
                copy.update_property.assert_any_call([0], ["Copy relative reference: Chat"])
                copy.update_state.assert_called_with([1], [False])
                if copied:
                    copy.update_property.assert_called_with([1], ["Relative session copied"])
                else:
                    copy.reset_property.assert_called_with(1)
            self.assertNotIn(("asb-action-pending",), [call.args for call in copy.add_css_class.call_args_list])
            self.assertNotIn(("asb-copy-off",), [call.args for call in copy.add_css_class.call_args_list])
            copy.set_sensitive.assert_not_called()

    def test_card_copy_takes_the_absolute_reference_for_a_remote_row_only(self):
        full = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:123e4567-e89b-12d3-a456-426614174000"
        short = "codex/123e4567-e89b-12d3-a456-426614174000"
        local = {"id": "x", "externalId": "123e4567-e89b-12d3-a456-426614174000", "provider": "codex", "sessionReference": short, "reference": full}
        remote = {**local, "id": "m:0123456789abcdef:x", "remote": True, "machineName": "homeLP"}
        self.assertEqual(asb.card_copy(local), (short, None, "relative"))
        self.assertEqual(asb.card_copy({**local, "surface": "cli"}), (short, None, "relative"))
        self.assertEqual(asb.card_copy(remote), (full, None, "absolute"))
        # Only the value True counts as remote.
        for flag in ("yes", 1, None, False):
            self.assertEqual(asb.card_copy({**remote, "remote": flag}), (short, None, "relative"), repr(flag))
        # A remote row with no safe absolute reference gives the absolute reason, though the relative one is fine.
        gone = {key: value for key, value in remote.items() if key != "reference"}
        self.assertEqual(asb.card_copy({**gone, "referenceUnavailable": "old-peer"}),
                         (None, "homeLP has an older ASB. Update ASB on that machine.", "absolute"))
        self.assertEqual(asb.card_copy({**gone, "referenceUnavailable": "old-peer", "remote": False}), (short, None, "relative"))
        self.assertEqual(asb.card_copy({**remote, "reference": full + " x"}),
                         (None, "ASB cannot make a full reference for this session.", "absolute"))

    def test_remote_card_copy_button_has_the_absolute_texts_and_follows_the_reference(self):
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        full = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:123e4567-e89b-12d3-a456-426614174000"
        old_peer = "homeLP has an older ASB. Update ASB on that machine."
        row = {"id": "m:0123456789abcdef:x", "title": "Chat", "state": "idle", "externalId": "123e4567-e89b-12d3-a456-426614174000",
               "provider": "codex", "sessionReference": "codex/123e4567-e89b-12d3-a456-426614174000", "remote": True,
               "machineName": "homeLP", "reference": full}
        widget = SimpleNamespace(asb_view="comfortable", asb_thread=dict(row), asb_focus_key=row["id"], asb_read_timer=None, asb_copy_timer=None,
                                 asb_read_button=Mock(), asb_pin_button=Mock(), asb_copy_button=Mock())
        copy = widget.asb_copy_button
        window = object.__new__(Window)
        window.session_actions, window.column_pixel_width, window.closed, window.open_errors = set(), 240, False, {}
        window.focus_widgets = {row["id"]: widget}
        window.update_open_state = Mock()
        window.get_clipboard = lambda: clipboard
        clipboard = Mock()
        timers = []
        glib = SimpleNamespace(timeout_add=lambda delay, callback: timers.append((delay, callback)) or len(timers),
                               source_remove=Mock(), Error=type("GError", (Exception,), {}))
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": glib}):
            window.update_card_actions(widget)
            self.assertEqual(copy.asb_action, "win.copy-reference")
            copy.set_tooltip_text.assert_called_with("Copy absolute reference. Relative works only on this machine. This session runs on homeLP.")
            copy.update_property.assert_any_call([0], ["Copy absolute reference: Chat"])
            copy.update_state.assert_called_with([1], [False])
            copy.remove_css_class.assert_any_call("asb-copy-off")
            # The button and the copy-reference action copy the same value; the check shows and the tooltip stays.
            window.copy_reference(None, SimpleNamespace(get_string=lambda: row["id"]))
            clipboard.set.assert_called_once_with(full)
            copy.set_tooltip_text.assert_called_with("Copy absolute reference. Relative works only on this machine. This session runs on homeLP.")
            SCOPE["set_icon"].assert_called_with(copy.get_child(), "object-select-symbolic")
            # The reference goes away: the signature changes, so the button loses its action and gives the absolute reason.
            widget.asb_copy_timer = None
            widget.asb_thread = {key: value for key, value in row.items() if key != "reference"} | {"referenceUnavailable": "old-peer"}
            window.update_card_actions(widget)
            self.assertEqual(copy.asb_action, None)
            copy.add_css_class.assert_any_call("asb-copy-off")
            copy.update_state.assert_called_with([1], [True])
            copy.set_tooltip_text.assert_called_with(old_peer)
            copy.update_property.assert_any_call([0], ["Copy absolute reference: Chat"])
            clipboard.reset_mock()
            window.copy_reference(None, SimpleNamespace(get_string=lambda: row["id"]))
            clipboard.set.assert_not_called()
            # The reference comes back: the button updates again.
            widget.asb_thread = dict(row)
            window.update_card_actions(widget)
            self.assertEqual(copy.asb_action, "win.copy-reference")
            copy.update_state.assert_called_with([1], [False])
            copy.set_tooltip_text.assert_called_with("Copy absolute reference. Relative works only on this machine. This session runs on homeLP.")
            # A local row, also a view-only CLI row, keeps the relative texts and value.
            for extra in ({}, {"surface": "cli"}):
                local = {**row, "id": "local" + str(len(extra)), "remote": False, **extra}
                local_widget = SimpleNamespace(asb_view="comfortable", asb_thread=local, asb_focus_key=local["id"], asb_read_timer=None,
                                               asb_copy_timer=None, asb_read_button=Mock(), asb_pin_button=Mock(), asb_copy_button=Mock())
                window.focus_widgets[local["id"]] = local_widget
                window.update_card_actions(local_widget)
                local_widget.asb_copy_button.set_tooltip_text.assert_called_with("Copy relative reference")
                local_widget.asb_copy_button.update_property.assert_any_call([0], ["Copy relative reference: Chat"])
                clipboard.reset_mock()
                window.copy_reference(None, SimpleNamespace(get_string=lambda: local["id"]))
                clipboard.set.assert_called_once_with(local["sessionReference"])

    def test_card_copy_errors_name_the_reference_kind_and_a_later_copy_clears_either(self):
        glib = SimpleNamespace(timeout_add=lambda *_args: 1, source_remove=Mock(), Error=type("GError", (Exception,), {}))
        gtk = SimpleNamespace(AccessibleProperty=SimpleNamespace(LABEL=0, DESCRIPTION=1), AccessibleState=SimpleNamespace(BUSY=0, DISABLED=1))
        full = "asb:1/0123456789abcdef/codex/" + "f" * 32 + "/codex:123e4567-e89b-12d3-a456-426614174000"
        base = {"title": "Chat", "state": "idle", "externalId": "123e4567-e89b-12d3-a456-426614174000", "provider": "codex",
                "sessionReference": "codex/123e4567-e89b-12d3-a456-426614174000", "reference": full}
        rows = [{**base, "id": "m:0123456789abcdef:x", "remote": True, "machineName": "homeLP"}, {**base, "id": "local"}]
        widgets = {row["id"]: SimpleNamespace(asb_view="comfortable", asb_thread=row, asb_focus_key=row["id"], asb_read_timer=None,
                                              asb_copy_timer=None, asb_read_button=Mock(), asb_pin_button=Mock(), asb_copy_button=Mock())
                   for row in rows}
        window = object.__new__(Window)
        window.session_actions, window.column_pixel_width, window.closed, window.open_errors = set(), 240, False, {}
        window.focus_widgets = dict(widgets)
        window.update_open_state = Mock()
        clipboard = Mock()
        window.get_clipboard = lambda: clipboard
        with patch.dict(SCOPE, {"Gtk": gtk, "GLib": glib}):
            for row, kind in zip(rows, ("absolute", "relative")):
                target = SimpleNamespace(get_string=lambda identity=row["id"]: identity)
                clipboard.set.side_effect = TypeError("no clipboard")
                window.copy_reference(None, target)
                self.assertEqual(window.open_errors, {row["id"]: f"Cannot copy the {kind} reference: no clipboard"})
                clipboard.set.side_effect = None
                window.copy_reference(None, target)
                self.assertEqual(window.open_errors, {})
            # An error of the other kind (the row changed) is also cleared, and an open error stays.
            window.open_errors[rows[0]["id"]] = "Cannot copy the relative reference: old"
            window.copy_reference(None, SimpleNamespace(get_string=lambda: rows[0]["id"]))
            self.assertEqual(window.open_errors, {})
            window.open_errors[rows[0]["id"]] = "The server did not answer."
            window.copy_reference(None, SimpleNamespace(get_string=lambda: rows[0]["id"]))
            self.assertEqual(window.open_errors, {rows[0]["id"]: "The server did not answer."})

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
        def keycap():
            classes = set()
            return Mock(classes=classes, add_css_class=Mock(side_effect=classes.add),
                        remove_css_class=Mock(side_effect=classes.discard))
        def shown():
            return {identity for identity, widget in cards.items() if "asb-number-shown" in widget.asb_number_label.classes}
        def card(identity):
            return SimpleNamespace(asb_thread={"id": identity, "canOpen": identity != "r1"}, asb_number_label=keycap(),
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
            self.assertTrue(window.window_key(None, 0x33, 0, control))  # Ctrl+3 before the hold timer shows no keycap.
            window.open_row.assert_called_once_with(None, cards["r3"])
            self.assertEqual(shown(), set())
            timers[1][1]()
            self.assertTrue(window.numbers_shown)
            # The class goes on the numbered keycaps, not on the list.
            self.assertEqual(shown(), {"r0", "r2", "r3", "r4", "r5"})
            window.list_body.add_css_class.assert_not_called()
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
            self.assertEqual(shown(), set())
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
            self.assertEqual(shown(), {"r0", "r2", "r3", "r4"})  # The keycap that lost its number loses the class.
            window.list_body.add_css_class.assert_not_called()
            window.list_body.remove_css_class.assert_not_called()
            window.queue_number_keys(scrolled=True)
            window.queue_number_keys(scrolled=True)
            self.assertEqual(removed[-1], len(timers) - 1)  # A scroll settles once.
            self.assertEqual(timers[len(timers)][0], 100)

    def test_waiting_state_label_uses_idle_classes(self):
        window = object.__new__(Window)
        window.view, window.update_row_text, window.open_errors = "compact", Mock(), {}
        for state, pending, expected in (("waiting", False, {"asb-waiting", "dim-label"}),
                                         ("waiting", True, {"asb-waiting"}),
                                         ("working", False, {"asb-working", "success"})):
            with self.subTest(state=state, pending=pending):
                classes = set()
                label = Mock(add_css_class=classes.add, remove_css_class=classes.discard)
                widget = SimpleNamespace(asb_view="compact", asb_thread={}, set_activatable=Mock(),
                                         asb_mark=Mock(), asb_source_badge=Mock(), asb_where_icon=None,
                                         asb_where_label=Mock(), asb_dot=Mock(), asb_state_label=label,
                                         add_css_class=Mock(), remove_css_class=Mock())
                window.update_session_row(widget, {"id": "a", "provider": "codex", "state": state, "pending": pending})
                self.assertEqual(classes, expected)


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
        assignments = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "config_dir"
                       or isinstance(node, ast.Assign)
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
                    scope = {"Path": Path, "os": SCOPE["os"], "ntpath": SCOPE["ntpath"]}
                    exec(code, scope)
                    base = Path(config) if config else home / ".config"
                    self.assertEqual(scope["THEME_PATH"], base / "asb" / "theme.json")
                    self.assertEqual(scope["LAYOUT_PATH"], base / "asb" / "layout.json")

    def test_config_dir_uses_appdata_on_windows_and_keeps_the_linux_folder(self):
        roaming = "C:\\Users\\me\\AppData\\Roaming"
        with TemporaryDirectory() as directory, patch.dict(SCOPE["os"].environ, {"HOME": str(Path(directory) / "synthetic-home")}):
            home = Path.home()
            for environment, os_name, expected in (
                    ({"APPDATA": roaming}, "nt", PureWindowsPath(roaming, "asb")),
                    ({"APPDATA": roaming, "XDG_CONFIG_HOME": "/xdg"}, "nt", PureWindowsPath(roaming, "asb")),
                    ({"APPDATA": "Roaming"}, "nt", PureWindowsPath(home, "AppData", "Roaming", "asb")),
                    ({}, "nt", PureWindowsPath(home, "AppData", "Roaming", "asb")),
                    ({"APPDATA": roaming}, "posix", PureWindowsPath(home, ".config", "asb")),
                    ({"XDG_CONFIG_HOME": "/xdg"}, "posix", PureWindowsPath("/xdg", "asb")),
                    ({"XDG_CONFIG_HOME": "relative"}, "posix", PureWindowsPath("relative", "asb")),
                    ({"XDG_CONFIG_HOME": ""}, "posix", PureWindowsPath(home, ".config", "asb"))):
                with self.subTest(environment=environment, os_name=os_name):
                    self.assertEqual(str(PureWindowsPath(SCOPE["config_dir"](environment, os_name))), str(expected))
        self.assertEqual(SCOPE["config_dir"]({"XDG_CONFIG_HOME": "/xdg"}, "posix"), Path("/xdg/asb"))

    def test_tooltip_path_shortens_a_windows_or_a_linux_home(self):
        for home, path, expected in (
                ("/home/me", "/home/me", "~"),
                ("/home/me", "/home/me/src/ASB", "~/src/ASB"),
                ("/home/me", "/home/meow/src", "/home/meow/src"),
                ("/home/me", "/home/me\\src", "/home/me\\src"),
                ("C:\\Users\\me", "C:\\Users\\me", "~"),
                ("C:\\Users\\me", "C:\\Users\\me\\src\\ASB", "~\\src\\ASB"),
                ("C:\\Users\\me", "C:\\Users\\meow", "C:\\Users\\meow"),
                ("C:\\Users\\me", "C:\\Users\\meow\\src", "C:\\Users\\meow\\src"),
                ("C:\\Users\\me", "D:\\Users\\me\\src", "D:\\Users\\me\\src")):
            with self.subTest(home=home, path=path):
                model = SCOPE["tooltip_model"]({"cwd": path}, 0, home)
                self.assertEqual((model["path"], model["full_path"]), (expected, path))

    def test_main_registers_the_unix_signals_only_off_windows(self):
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        code = compile(ast.Module(body=[main], type_ignores=[]), str(SOURCE), "exec")
        for os_name, calls in (("posix", 2), ("nt", 0)):
            scope = {"os": SimpleNamespace(name=os_name), "signal": SCOPE["signal"], "sys": SimpleNamespace(argv=["asb"]),
                     "GLib": Mock(), "unix_signal_add": Mock(), "local_base_url": lambda value: "http://127.0.0.1:1",
                     "SwitchboardApplication": Mock(), "LAUNCHER_START": None}
            exec(code, scope)
            with self.subTest(os_name=os_name):
                scope["main"]()
                self.assertEqual(scope["unix_signal_add"].call_count, calls)
                scope["SwitchboardApplication"].return_value.run.assert_called_once_with(["asb"])

    def test_board_launcher_picks_the_cache_folder_for_the_system(self):
        launcher = ast.parse((SOURCE.parent / "asb-board.py").read_text())
        choice = next(node for node in launcher.body if isinstance(node, ast.If))
        code = compile(ast.Module(body=[choice], type_ignores=[]), "asb-board.py", "exec")
        local = "C:\\Users\\me\\AppData\\Local"
        with TemporaryDirectory() as directory, patch.dict(SCOPE["os"].environ, {"HOME": str(Path(directory) / "synthetic-home")}):
            home = Path.home()
            for os_name, environment, expected in (
                    ("nt", {"LOCALAPPDATA": local}, PureWindowsPath(local, "asb", "cache", "pycache")),
                    ("nt", {"LOCALAPPDATA": "Local"}, PureWindowsPath(home, "AppData", "Local", "asb", "cache", "pycache")),
                    ("nt", {}, PureWindowsPath(home, "AppData", "Local", "asb", "cache", "pycache")),
                    ("posix", {"XDG_CACHE_HOME": "/xdg", "LOCALAPPDATA": local}, PureWindowsPath("/xdg", "asb", "pycache")),
                    ("posix", {"XDG_CACHE_HOME": "relative"}, PureWindowsPath(home, ".cache", "asb", "pycache")),
                    ("posix", {}, PureWindowsPath(home, ".cache", "asb", "pycache"))):
                with self.subTest(os_name=os_name, environment=environment):
                    path_rules = SCOPE["ntpath"] if os_name == "nt" else SCOPE["os"].path
                    scope = {"Path": Path, "os": SimpleNamespace(name=os_name, environ=environment, path=path_rules)}
                    exec(code, scope)
                    self.assertEqual(str(PureWindowsPath(scope["cache"])), str(expected))

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


class BoardStartChecks(unittest.TestCase):
    """The board starts before the engine is ready (the address argument "-"): the address comes on stdin, the first dashboard loads at
    once in a thread, and the Preferences window is made on its first use."""
    TOKEN = "ab" * 32
    BASE = "http://127.0.0.1:4629"

    def line(self, **values):
        return json.dumps({"url": self.BASE, "token": self.TOKEN, **values}).encode() + b"\n"

    def start(self, data, fetch=None):
        """A LauncherStart that reads data from a real pipe; the end of the data is the end of the input."""
        read, write = os.pipe()
        os.write(write, data)
        os.close(write)
        start = SCOPE["LauncherStart"](read, fetch or Mock(return_value={"threads": []}))
        def close_reader():
            start.worker.join(5)
            os.close(read)
        self.addCleanup(close_reader)
        return start

    def outcome(self, start):
        done, got = threading.Event(), []
        start.deliver(lambda *args: (got.append(args), done.set()), lambda callback, *args: callback(*args))
        self.assertTrue(done.wait(5))
        return got

    def test_reconnect_lines_are_delivered_in_order_and_eof_ends_the_reader(self):
        read, write = os.pipe()
        self.addCleanup(os.close, read)
        got, queued = [], []
        start = SCOPE["LauncherStart"](read, Mock(return_value={"threads": []}))
        start.reconnect(lambda *args: got.append(args), lambda callback, *args: queued.append((callback, args)))
        os.write(write, self.line() + b"invalid\n" + b"x" * 5000 + b"\n\xff\n"
                 + self.line(url="http://127.0.0.1:4631", token="new")
                 + self.line(url="http://127.0.0.1:4632", token="incomplete").rstrip(b"\n"))
        os.close(write)
        start.worker.join(5)
        self.assertFalse(start.worker.is_alive())
        self.assertEqual(start.address(), self.BASE)
        self.assertEqual(got, [])
        self.assertEqual(len(queued), 1)
        queued[0][0](*queued[0][1])
        self.assertEqual(got, [("http://127.0.0.1:4631", "new")])

    def test_reconnect_before_application_creation_waits_for_main_loop_delivery(self):
        start = self.start(self.line() + self.line(url="http://127.0.0.1:4631", token="new"))
        start.worker.join(5)
        self.assertFalse(start.worker.is_alive())
        callback, dispatch = Mock(), Mock()
        start.reconnect(callback, dispatch)
        dispatch.assert_called_once_with(callback, "http://127.0.0.1:4631", "new")
        callback.assert_not_called()

    def test_a_late_dashboard_from_the_previous_engine_cannot_set_the_new_etag(self):
        window = object.__new__(Window)
        window.base, window.engine_generation = self.BASE, 0
        window.closed = window.loading = False
        window.dashboard_etag = '"old"'
        window.apply_dashboard = Mock()
        window.refresh_button = Mock()
        # A forced refresh asks the new engine with force too, so that its answer enables the refresh button again.
        for force in (False, True):
            window.loading, window.engine_generation, window.dashboard_etag = False, 0, '"old"'
            refresh = Window.refresh.__get__(window)
            with patch.dict(SCOPE, {"request_async": Mock(), "GLib": Mock()}):
                refresh(force)
                callback = SCOPE["request_async"].call_args.args[2]
            # A replacement engine can use the same port and URL.
            window.engine_generation += 1
            window.dashboard_etag = None
            window.refresh = Mock()
            callback({"threads": []}, None)
            window.apply_dashboard.assert_not_called()
            self.assertIsNone(window.dashboard_etag)
            self.assertFalse(window.loading)
            window.refresh.assert_called_once_with(force, queue=True)

    def test_the_address_line_gives_the_local_url_and_the_token_and_starts_the_first_request(self):
        def fetch(base, route, etag):
            etag[0] = '"tag"'
            return {"threads": [{"id": "a"}]}
        with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
            start = self.start(self.line(), Mock(side_effect=fetch))
            self.assertEqual(start.address(), self.BASE)
            self.assertEqual(SCOPE["SOURCE_TOKEN"], self.TOKEN)
            self.assertEqual(self.outcome(start), [({"threads": [{"id": "a"}]}, None, ['"tag"'])])
            start.fetch.assert_called_once_with(self.BASE, "/api/dashboard", etag=['"tag"'])
            # The result is for one window and is not kept: a later delivery gets nothing, so that its window asks for itself.
            self.assertIsNone(start.outcome)
            self.assertFalse(start.deliver(Mock(), Mock()))

    def test_a_result_that_came_before_the_window_is_delivered_at_once_and_only_once(self):
        with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
            start = self.start(self.line())
            self.assertEqual(start.address(), self.BASE)
            for _attempt in range(200):
                if start.outcome is not None:
                    break
                threading.Event().wait(.01)
            self.assertIsNotNone(start.outcome)
            dispatch = Mock()
            self.assertTrue(start.deliver("callback", dispatch))
            dispatch.assert_called_once_with("callback", {"threads": []}, None, [None])
            self.assertIsNone(start.outcome)
            self.assertFalse(start.deliver("callback", dispatch))
            dispatch.assert_called_once()

    def test_the_address_is_known_while_the_first_request_runs_and_a_waiting_delivery_follows_the_end(self):
        running, release = threading.Event(), threading.Event()
        def fetch(base, route, etag):
            running.set()
            self.assertTrue(release.wait(5))
            return {"threads": []}
        with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
            start = self.start(self.line(), fetch)
            # The window build can start now: the request is still open.
            self.assertEqual(start.address(), self.BASE)
            self.assertTrue(running.wait(5))
            done, got = threading.Event(), []
            start.deliver(lambda *args: (got.append(args), done.set()), lambda callback, *args: callback(*args))
            self.assertFalse(done.wait(.05))
            release.set()
            self.assertTrue(done.wait(5))
            self.assertEqual(got, [({"threads": []}, None, [None])])

    def test_a_failed_first_request_is_delivered_as_an_error_for_the_normal_first_refresh(self):
        with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
            start = self.start(self.line(), Mock(side_effect=RuntimeError("Cannot load sessions. Check that ASB is running, then refresh.")))
            self.assertEqual(self.outcome(start), [(None, "Cannot load sessions. Check that ASB is running, then refresh.", [None])])
            # Any other failure of the thread is still delivered, so that the window never waits for ever.
            with patch.object(threading, "excepthook", Mock()):
                start = self.start(self.line(), Mock(side_effect=KeyError("synthetic")))
                self.assertEqual(self.outcome(start), [(None, "Cannot load sessions.", [None])])

    def test_a_line_that_is_not_an_address_stops_the_start_and_sends_no_request(self):
        for data in (b"", b"\n", b"not json\n", b"[]\n", b'{"url": 4, "token": "t"}\n', b'{"url": "%s"}\n' % self.BASE.encode(),
                     b'{"token": "t"}\n', b'{"url": "%s", "token": 5}\n' % self.BASE.encode(), b"x" * 5000,
                     self.line(url="http://example.com:4629"), self.line(url="http://127.0.0.1:4629/path"), self.line(url="")):
            with self.subTest(data=data[:40]), patch.dict(SCOPE, {"SOURCE_TOKEN": "kept"}):
                start = self.start(data)
                with self.assertRaises(ValueError) as caught:
                    start.address()
                self.assertTrue(str(caught.exception))
                self.assertEqual(SCOPE["SOURCE_TOKEN"], "kept")
                self.assertNotIn(self.TOKEN, str(caught.exception))
                start.fetch.assert_not_called()

    def test_only_the_first_line_counts_and_a_line_without_a_newline_at_the_end_of_the_input_is_read(self):
        with patch.dict(SCOPE, {"SOURCE_TOKEN": ""}):
            self.assertEqual(self.start(self.line() + b"more\n").address(), self.BASE)
            self.assertEqual(self.start(self.line().rstrip(b"\n")).address(), self.BASE)

    def test_the_read_does_not_use_the_text_stdin_stream(self):
        # A thread that waits in sys.stdin at the exit of the interpreter can stop Python with a fatal error.
        read = next(node for node in ast.walk(ast.parse(SOURCE.read_text())) if isinstance(node, ast.FunctionDef) and node.name == "read_line")
        self.assertNotIn("stdin", ast.unparse(read))
        self.assertIn("os.read", ast.unparse(read))

    def test_the_address_reading_starts_before_the_gtk_import_and_only_for_the_dash_argument(self):
        # NODES holds the code before the GTK import, and the check runs in it with the argv of this test run.
        self.assertIn("LAUNCHER_START", SCOPE)
        self.assertIsNone(SCOPE["LAUNCHER_START"])
        statement = next(node for node in TREE.body if isinstance(node, ast.Assign) and node.targets[0].id == "LAUNCHER_START")
        self.assertEqual(ast.unparse(statement.value), "LauncherStart() if sys.argv[1:] == ['-'] else None")
        self.assertLess(TREE.body.index(statement), next(index for index, node in enumerate(TREE.body) if isinstance(node, ast.Try)))

    def test_the_early_result_is_the_first_dashboard_with_its_tag(self):
        window = object.__new__(Window)
        window.apply_dashboard, window.refresh = Mock(return_value=False), Mock()
        dashboard, etag = {"threads": []}, ['"tag"']
        self.assertFalse(window.first_dashboard(dashboard, None, etag))
        window.apply_dashboard.assert_called_once_with(dashboard, None, etag)
        window.refresh.assert_not_called()

    def test_a_failed_early_request_shows_no_notice_and_runs_the_normal_first_refresh(self):
        for dashboard, error in ((None, "Cannot load sessions. Check that ASB is running, then refresh."), (None, None)):
            with self.subTest(error=error):
                window = object.__new__(Window)
                window.loading = True
                window.apply_dashboard, window.refresh, window.set_notice = Mock(), Mock(), Mock()
                self.assertFalse(window.first_dashboard(dashboard, error, [None]))
                self.assertFalse(window.loading)
                window.refresh.assert_called_once_with()
                window.apply_dashboard.assert_not_called()
                window.set_notice.assert_not_called()

    def test_the_window_waits_for_the_early_request_and_does_not_make_a_second_one(self):
        init = next(node for node in WINDOW.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        end = ast.unparse(next(node for node in reversed(init.body) if isinstance(node, ast.If)))
        # The window is loading before the request can end, and it asks for itself only when an earlier window took the result.
        self.assertLess(end.index("self.loading = True"), end.index("first_load.deliver(self.first_dashboard, GLib.idle_add)"))
        self.assertLess(end.index("first_load.deliver"), end.index("self.loading = False"))
        self.assertLess(end.index("self.loading = False"), end.index("self.refresh()"))

    def test_the_preferences_window_is_not_made_by_the_window_start(self):
        init = next(node for node in WINDOW.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        calls = {node.func.id for node in ast.walk(init) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertNotIn("PreferencesWindow", calls)
        owners = [function.name for function in ast.walk(WINDOW) if isinstance(function, ast.FunctionDef)
                  and any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "PreferencesWindow"
                          for node in ast.walk(function))]
        self.assertEqual(owners, ["make_preferences"])

    def test_the_preferences_window_is_made_once_on_first_use_and_a_closed_window_makes_none(self):
        window = object.__new__(Window)
        window.closed, window.preferences_window, window.hover_colors = False, None, None
        window.preference_pages = ("sessions page", "appearance page")
        with patch.dict(SCOPE, {"PreferencesWindow": Mock()}):
            made = SCOPE["PreferencesWindow"]
            window.open_preferences()
            window.open_preferences()
            made.assert_called_once_with(window, "sessions page", "appearance page")
            self.assertIs(window.preferences_window, made.return_value)
            self.assertEqual(made.return_value.present.call_count, 2)
            made.return_value.add_css_class.assert_not_called()
            window.preferences_window, window.closed = None, True
            window.open_preferences()
            made.assert_called_once()
            self.assertIsNone(window.preferences_window)

    def test_a_custom_theme_set_before_the_first_use_reaches_the_new_preferences_window(self):
        window = object.__new__(Window)
        window.closed, window.preferences_window, window.hover_colors = False, None, {"accent": "#f3c66b"}
        window.preference_pages = ("sessions page", "appearance page")
        with patch.dict(SCOPE, {"PreferencesWindow": Mock()}):
            window.open_preferences()
            SCOPE["PreferencesWindow"].return_value.add_css_class.assert_called_once_with("asb-custom")

    def test_the_ui_report_needs_no_preferences_window(self):
        window = object.__new__(Window)
        window.closed, window.preferences_window, window.ui_client_id = False, None, "client"
        window.sources_revision, window.ui_report_last, window.ui_report_at, window.ui_report_sending = 3, None, 0, False
        window.base = self.BASE
        with patch.dict(SCOPE, {"SOURCE_TOKEN": self.TOKEN, "request_async": Mock(), "GLib": Mock()}):
            window.report_ui()
            arguments = SCOPE["request_async"].call_args.args
        self.assertEqual(arguments[:2], (self.BASE, "/api/agent/ui"))
        self.assertEqual(arguments[-1], {"clientId": "client", "sourcesRevision": 3, "profilesRevision": None,
                                        "profilesVisible": False, "dirty": False})

    def main_scope(self, launch):
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        errors = io.StringIO()
        scope = {"os": SimpleNamespace(name="posix"), "signal": SCOPE["signal"], "sys": SimpleNamespace(argv=["asb", "-"], stderr=errors),
                 "GLib": Mock(), "unix_signal_add": Mock(), "local_base_url": Mock(side_effect=AssertionError("The address comes from stdin.")),
                 "SwitchboardApplication": Mock(), "LAUNCHER_START": launch}
        exec(compile(ast.Module(body=[main], type_ignores=[]), str(SOURCE), "exec"), scope)
        return scope, errors

    def test_main_waits_for_the_address_of_the_launcher_and_gives_the_application_the_early_load(self):
        launch = Mock()
        launch.address.return_value = self.BASE
        scope, _errors = self.main_scope(launch)
        scope["main"]()
        scope["SwitchboardApplication"].assert_called_once_with(self.BASE, launch)
        scope["SwitchboardApplication"].return_value.run.assert_called_once_with(["asb"])

    def test_main_prints_the_problem_and_exits_1_when_the_launcher_sends_no_address(self):
        launch = Mock()
        launch.address.side_effect = ValueError("ASB did not get the engine address from its launcher.")
        scope, errors = self.main_scope(launch)
        self.assertEqual(scope["main"](), 1)
        self.assertEqual(errors.getvalue(), "ASB did not get the engine address from its launcher.\n")
        scope["SwitchboardApplication"].assert_not_called()


class BoardLauncherChecks(unittest.TestCase):
    """The renderer rule of scripts/asb-board.py. The script runs the board at import, so the checks read its code."""
    SOURCE = Path(__file__).parents[1] / "scripts" / "asb-board.py"

    def rule(self, system):
        function = next(node for node in ast.parse(self.SOURCE.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == "prefer_cairo")
        scope = {"os": SimpleNamespace(name=system)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(self.SOURCE), "exec"), scope)
        return scope["prefer_cairo"]

    def test_windows_uses_cairo_unless_the_user_chose_a_renderer_or_dcomp(self):
        for environ, expected in (
            ({}, "cairo"),
            ({"GSK_RENDERER": ""}, "cairo"),
            ({"GDK_DEBUG": "events"}, "cairo"),
            ({"GDK_DEBUG": ""}, "cairo"),
            ({"GSK_RENDERER": "gl"}, "gl"),
            ({"GSK_RENDERER": "ngl"}, "ngl"),
            ({"GSK_RENDERER": "vulkan", "GDK_DEBUG": "events"}, "vulkan"),
            ({"GSK_RENDERER": "cairo"}, "cairo"),
            ({"GDK_DEBUG": "dcomp"}, None),
            ({"GDK_DEBUG": "events,dcomp"}, None),
            ({"GDK_DEBUG": "DComp"}, None),
        ):
            with self.subTest(environ=environ):
                # The system comes from os.name by default.
                changed = dict(environ)
                self.rule("nt")(changed)
                self.assertEqual(changed.get("GSK_RENDERER"), expected)
                # No other variable changes.
                self.assertEqual({key: value for key, value in changed.items() if key != "GSK_RENDERER"},
                                 {key: value for key, value in environ.items() if key != "GSK_RENDERER"})

    def test_other_systems_keep_their_environment(self):
        for environ in ({}, {"GSK_RENDERER": ""}, {"GDK_DEBUG": "events"}, {"GSK_RENDERER": "gl"}):
            with self.subTest(environ=environ):
                changed = dict(environ)
                self.rule("posix")(changed)
                self.assertEqual(changed, environ)
                self.rule("nt")(changed, "posix")
                self.assertEqual(changed, environ)

    def test_the_rule_runs_before_the_board_code(self):
        calls = [node for node in ast.parse(self.SOURCE.read_text()).body
                 if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)]
        names = [getattr(node.value.func, "id", None) for node in calls]
        self.assertEqual(names.count("prefer_cairo"), 1)
        self.assertLess(names.index("prefer_cairo"), names.index("exec"))
        self.assertEqual(ast.unparse(calls[names.index("prefer_cairo")].value), "prefer_cairo(os.environ)")

    def test_app_id_is_set_only_on_windows(self):
        function = next(node for node in ast.parse(self.SOURCE.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == "use_app_id")
        scope = {"os": SimpleNamespace(name="posix")}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(self.SOURCE), "exec"), scope)
        for system in ("nt", "posix"):
            ctypes = SimpleNamespace(windll=Mock())
            with self.subTest(system=system), patch.dict(sys.modules, {"ctypes": ctypes}):
                scope["use_app_id"](system)
                self.assertEqual(ctypes.windll.mock_calls,
                                 [call.shell32.SetCurrentProcessExplicitAppUserModelID("local.asb.AgentSwitchBoard")]
                                 if system == "nt" else [])

    def test_app_id_is_set_before_the_board_code(self):
        calls = [node.value for node in ast.parse(self.SOURCE.read_text()).body
                 if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)]
        names = [getattr(node.func, "id", None) for node in calls]
        self.assertEqual(names.count("use_app_id"), 1)
        self.assertEqual(ast.unparse(calls[names.index("use_app_id")]), "use_app_id()")
        self.assertEqual(names.index("use_app_id"), names.index("prefer_cairo") + 1)
        self.assertLess(names.index("use_app_id"), names.index("exec"))


class WindowsIconChecks(unittest.TestCase):
    """The real icon helper runs with fake Windows and GI modules, without GTK or Windows."""

    def setUp(self):
        function = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "set_windows_icon")
        self.gi = SimpleNamespace(require_version=Mock())
        self.gdk = SimpleNamespace(Win32Surface=SimpleNamespace(get_handle=Mock(return_value=4321)))
        self.user32 = Mock()
        self.user32.GetSystemMetrics.side_effect = {11: 40, 49: 20}.__getitem__
        self.user32.LoadImageW.side_effect = [111, 222]
        self.wintypes = SimpleNamespace(**{name: object() for name in
                                          ("HINSTANCE", "LPCWSTR", "UINT", "HANDLE", "HWND", "WPARAM", "LPARAM")})
        self.ctypes = SimpleNamespace(WinDLL=Mock(return_value=self.user32), wintypes=self.wintypes, c_int=object())
        self.modules = {"ctypes": self.ctypes, "gi": self.gi,
                        "gi.repository": SimpleNamespace(GdkWin32=self.gdk)}
        self.scope = {"gi": self.gi, "Path": Path, "__file__": str(SOURCE)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(SOURCE), "exec"), self.scope)
        self.window = Mock()

    def run_icon(self):
        with patch.dict(sys.modules, self.modules):
            self.scope["set_windows_icon"](self.window)

    def test_big_and_small_icons_use_system_sizes_and_pointer_safe_types(self):
        self.run_icon()
        self.gi.require_version.assert_called_once_with("GdkWin32", "4.0")
        self.gdk.Win32Surface.get_handle.assert_called_once_with(self.window.get_surface.return_value)
        self.ctypes.WinDLL.assert_called_once_with("user32")
        self.assertEqual(self.user32.GetSystemMetrics.call_args_list, [call(11), call(49)])
        icon_file = str(SOURCE.parents[1] / "assets" / "icons" / "asb.ico")
        self.assertEqual(self.user32.LoadImageW.call_args_list,
                         [call(None, icon_file, 1, 40, 40, 0x10), call(None, icon_file, 1, 20, 20, 0x10)])
        self.assertEqual(self.user32.SendMessageW.call_args_list,
                         [call(4321, 0x80, 1, 111), call(4321, 0x80, 0, 222)])
        types = self.wintypes
        self.assertEqual(self.user32.LoadImageW.argtypes,
                         [types.HINSTANCE, types.LPCWSTR, types.UINT, self.ctypes.c_int, self.ctypes.c_int, types.UINT])
        self.assertIs(self.user32.LoadImageW.restype, types.HANDLE)
        self.assertEqual(self.user32.SendMessageW.argtypes, [types.HWND, types.UINT, types.WPARAM, types.LPARAM])
        self.assertIs(self.user32.SendMessageW.restype, types.LPARAM)

    def test_failed_small_icon_load_sends_only_the_big_icon(self):
        self.user32.LoadImageW.side_effect = [111, 0]
        self.run_icon()
        self.assertEqual(self.user32.LoadImageW.call_count, 2)
        self.user32.SendMessageW.assert_called_once_with(4321, 0x80, 1, 111)

    def test_missing_gdk_win32_returns_before_ctypes_calls(self):
        self.gi.require_version.side_effect = ValueError("Synthetic missing GdkWin32")
        self.run_icon()
        self.gi.require_version.assert_called_once_with("GdkWin32", "4.0")
        self.gdk.Win32Surface.get_handle.assert_not_called()
        self.ctypes.WinDLL.assert_not_called()
        self.assertEqual(self.user32.mock_calls, [])

    def test_realize_handler_is_connected_only_on_windows(self):
        init = next(node for node in WINDOW.body if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        icon_index = next(index for index, node in enumerate(init.body)
                          if isinstance(node, ast.Expr) and ast.unparse(node) == "self.set_icon_name(APP_ID)")
        choice = init.body[icon_index + 1]
        self.assertIsInstance(choice, ast.If)
        self.assertEqual(ast.unparse(choice.test), "os.name == 'nt'")
        code = compile(ast.Module(body=[choice], type_ignores=[]), str(SOURCE), "exec")
        for system in ("nt", "posix"):
            window, handler = Mock(), Mock()
            with self.subTest(system=system):
                exec(code, {"os": SimpleNamespace(name=system), "self": window, "set_windows_icon": handler})
                self.assertEqual(window.mock_calls, [call.connect("realize", handler)] if system == "nt" else [])


MESSAGE_SAMPLE = Path(__file__).with_name("fixtures") / "activity" / "messages-sample.json"


def sample_messages(sample, period, extra=()):
    """The contract 2.1 reply of the preview's sample data for a period (buckets in UTC)."""
    now = sample["nowMs"]
    count, size = {"24h": (24, 3_600_000), "7d": (7, 86_400_000), "30d": (30, 86_400_000)}[period]
    starts = [now // size * size - (count - 1 - index) * size for index in range(count)]
    records = [record for record in sample["messages"] + list(extra) if record[3] >= starts[0]]
    machine = {seat["id"]: seat["machineId"] for seat in sample["seats"]}
    ends = {record[1] for record in records} | {record[2] for record in records}
    return {"period": period, "nowMs": now, "buckets": {"unit": "hour" if period == "24h" else "day", "startsMs": starts},
            "machines": sample["machines"], "seats": [dict(seat, order=index) for index, seat in enumerate(sample["seats"]) if seat["id"] in ends],
            "messages": [{"id": record[0], "from": record[1], "to": record[2], "atMs": record[3], "status": record[4], "reason": record[5],
                          "local": "desk" in (machine[record[1]], machine[record[2]])} for record in records], "truncated": False}


class MessagesLogicChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sample = json.loads(MESSAGE_SAMPLE.read_text())

    def reply(self, period="7d", extra=()):
        return sample_messages(self.sample, period, extra)

    def test_the_ledger_follows_the_consistency_rules(self):
        for period in ("24h", "7d", "30d"):
            with self.subTest(period=period):
                reply = self.reply(period)
                view = asb.messages_view(reply)
                records = reply["messages"]
                self.assertGreater(len(records), 0)
                self.assertEqual(view["total"], len(records))
                self.assertEqual(sum(view["by_status"].values()), len(records))
                self.assertEqual(sum(sum(row) for row in view["matrix"]), len(records))
                self.assertEqual(sum(row["count"] for row in view["machine_rows"]), len(records))
                for seat in reply["seats"]:
                    self.assertEqual(view["counts"][seat["id"]], {"sent": sum(record["from"] == seat["id"] for record in records),
                                                                 "received": sum(record["to"] == seat["id"] for record in records)})
                self.assertEqual(view["recent"], sorted(records, key=lambda record: record["atMs"])[-6:][::-1])

    def test_messages_ignore_time_buckets(self):
        reply = self.reply()
        view = asb.messages_view(reply)
        self.assertNotIn("bars", view)
        del reply["buckets"]
        self.assertEqual(asb.messages_view(reply), view)

    def test_usage_only_apps_still_count_as_other_in_messages(self):
        self.assertEqual(asb.ACTIVITY_APPS, ("codex", "claude", "opencode"))
        self.assertEqual(asb.message_app({"app": "pi"}), "")
        reply = self.reply()
        self.assertEqual(asb.messages_view(reply)["apps"], ["codex", "claude", "opencode"])
        reply["seats"][0]["app"] = "pi"
        self.assertEqual(asb.messages_view(reply)["apps"], ["codex", "claude", "opencode", ""])

    def test_the_sample_numbers_match_the_preview(self):
        view = asb.messages_view(self.reply())
        self.assertEqual(view["total"], 479)
        self.assertEqual(view["by_status"], {"accepted": 434, "written": 22, "held": 10, "not-sent": 5, "unknown": 8})
        self.assertEqual(view["apps"], ["codex", "claude", "opencode"])
        self.assertEqual(view["matrix"], [[19, 203, 0], [194, 12, 0], [15, 4, 32]])
        self.assertEqual(view["app_pairs"], 7)
        self.assertEqual([(row["label"], row["count"]) for row in view["machine_rows"]],
                         [("Desk ⇄ Laptop", 248), ("Desk ⇄ Studio", 31), ("Laptop ⇄ Studio", 18), ("Desk", 149), ("Laptop", 29), ("Studio", 4)])
        self.assertEqual((len(view["seated"]), view["active"]), (12, 18))

    def test_seats_go_to_the_most_recent_sessions(self):
        reply = self.reply()
        view = asb.messages_view(reply)
        newest = {}
        for record in reply["messages"]:
            for seat_id in (record["from"], record["to"]):
                newest[seat_id] = max(newest.get(seat_id, 0), record["atMs"])
        circle = [seat["id"] for seat in sorted(reply["seats"], key=lambda seat: (["desk", "laptop", "studio"].index(seat["machineId"]), seat["order"]))]
        self.assertEqual(view["circle"], circle)
        recent = sorted(newest, key=lambda seat_id: (-newest[seat_id], circle.index(seat_id)))[:12]
        self.assertEqual(view["seated"], [seat_id for seat_id in circle if seat_id in recent])
        # A selected seat outside the 12 gets a seat, and the seat count stays 12.
        outside = next(seat_id for seat_id in circle if seat_id not in view["seated"])
        chosen = asb.messages_view(reply, (outside,))
        self.assertIn(outside, chosen["seated"])
        self.assertEqual(len(chosen["seated"]), 12)
        self.assertEqual(set(view["seated"]) - set(chosen["seated"]), {recent[-1]})
        # A seat with no message in the period never sits, also when it is selected.
        quiet = dict(reply, seats=reply["seats"] + [{"id": "quiet", "title": "quiet", "app": "codex", "machineId": "desk", "order": 99}])
        self.assertNotIn("quiet", asb.messages_view(quiet, ("quiet",))["seated"])
        self.assertEqual(asb.messages_view(quiet)["active"], 18)
        self.assertEqual(len(asb.messages_view(reply, limit=8)["seated"]), 8)

    def test_equal_times_take_the_circle_order(self):
        seats = [{"id": f"s{index}", "title": f"s{index}", "app": "codex", "machineId": "m", "order": index} for index in range(4)]
        reply = {"nowMs": 10_000, "buckets": {"unit": "day", "startsMs": [0]}, "machines": [{"machineId": "m", "name": "M", "state": "local"}],
                 "seats": list(reversed(seats)),
                 "messages": [{"id": "x", "from": "s3", "to": "s2", "atMs": 5000, "status": "accepted"},
                              {"id": "y", "from": "s1", "to": "s0", "atMs": 5000, "status": "accepted"}]}
        self.assertEqual(asb.messages_view(reply, limit=2)["seated"], ["s0", "s1"])
        self.assertEqual(asb.messages_view(reply, ("s3",), limit=2)["seated"], ["s0", "s3"])

    def test_chords_join_seated_pairs(self):
        for period in ("24h", "7d", "30d"):
            with self.subTest(period=period):
                reply = self.reply(period)
                view = asb.messages_view(reply)
                seated = set(view["seated"])
                expected = {frozenset((record["from"], record["to"])) for record in reply["messages"] if record["from"] in seated and record["to"] in seated}
                chords = {frozenset(key) for key, pair in view["pairs"].items() if pair["a"] in seated and pair["b"] in seated}
                self.assertEqual(chords, expected)
                for key, pair in view["pairs"].items():
                    mine = [record for record in reply["messages"] if {record["from"], record["to"]} == set(key)]
                    self.assertEqual((pair["n"], pair["ab"], pair["ba"]), (len(mine), sum(record["from"] == pair["a"] for record in mine),
                                                                           sum(record["from"] == pair["b"] for record in mine)))
                    self.assertLess(view["circle"].index(pair["a"]), view["circle"].index(pair["b"]))

    def test_the_all_not_sent_pair(self):
        view = asb.messages_view(self.reply("24h"))
        pair = view["pairs"][("release-plan", "sync-check")]
        self.assertGreater(pair["n"], 0)
        self.assertEqual((pair["bad"], pair["badAB"], pair["badBA"]), (pair["n"], pair["n"], 0))
        for key, item in view["pairs"].items():
            mine = [record for record in self.reply("24h")["messages"] if {record["from"], record["to"]} == set(key)]
            self.assertEqual(item["bad"] == item["n"], all(record["status"] == "not-sent" for record in mine))
        mixed = asb.messages_view(self.reply("7d"))["pairs"][("release-plan", "sync-check")]
        self.assertTrue(0 < mixed["bad"] < mixed["n"])

    def test_the_other_row_and_column_only_when_needed(self):
        reply = self.reply()
        self.assertNotIn("", asb.messages_view(reply)["apps"])
        other = dict(reply, seats=reply["seats"] + [{"id": "unknown:laptop", "title": "Other sessions", "app": "", "machineId": "laptop", "order": 0}],
                     messages=reply["messages"] + [{"id": "z", "from": "unknown:laptop", "to": "docs", "atMs": reply["nowMs"] - 5000, "status": "accepted"}])
        view = asb.messages_view(other)
        self.assertEqual(view["apps"], ["codex", "claude", "opencode", ""])
        self.assertEqual(view["matrix"][3], [0, 1, 0, 0])
        self.assertEqual(sum(sum(row) for row in view["matrix"]), view["total"])
        self.assertEqual(view["app_pairs"], 8)

    def test_chord_curves_follow_the_preview_formula(self):
        def geometry(size, center, pin, angles):
            return {"S": size, "cx": center, "cy": center, "Rp": pin, "Rc": 100, "seat": angles}
        cases = (
            # Opposite seats: the midpoint is the center, so the curve bends to the side of the first seat, 124px out.
            (geometry(600, 300, 200, {"a": -90, "b": 90}), False, ((300, 100), (548, 300), (300, 500))),
            # One machine: the midpoint W is at least Rc + 24 = 124 from the center.
            (geometry(600, 300, 200, {"a": -90, "b": 0}), True, ((300, 100), (2 * (300 + 124 / 2 ** .5) - 400, 2 * (300 - 124 / 2 ** .5) - 200), (500, 300))),
            # Below 480px the disc does not count: W = C + 0.625 * |M - C|.
            (geometry(400, 200, 100, {"a": -90, "b": 0}), False, ((200, 100), (212.5, 187.5), (300, 200))),
        )
        for index, (shape, same, (p1, control, p2)) in enumerate(cases):
            with self.subTest(case=index):
                got = asb.chord_curve(shape, "a", "b", same)
                for found, wanted in zip(got, (p1, control, p2)):
                    self.assertAlmostEqual(found[0], wanted[0], places=6)
                    self.assertAlmostEqual(found[1], wanted[1], places=6)

    def test_table_geometry_and_labels(self):
        reply = self.reply()
        view = asb.messages_view(reply)
        shape = asb.table_geometry(628, 583, view["seated"], view["seats"], view["machines"])
        self.assertEqual((shape["S"], shape["Ro"], shape["Ri"], shape["Rp"], shape["Rc"]), (567, 227.5, 217.5, 181.5, 87.0))
        self.assertEqual(shape["slot"], (360 - 18) / 12)
        desk = [seat_id for seat_id in view["seated"] if view["seats"][seat_id]["machineId"] == "desk"]
        self.assertAlmostEqual(shape["mach"]["desk"]["mid"], -90)
        self.assertAlmostEqual(shape["seat"][desk[0]], -90 - len(desk) * shape["slot"] / 2 + shape["slot"] / 2)
        self.assertAlmostEqual(shape["mach"]["laptop"]["start"], shape["mach"]["desk"]["end"] + 6)
        self.assertEqual(asb.seat_label_offset(-90, 40), 30)
        self.assertAlmostEqual(asb.seat_label_offset(0, 40), 60)
        self.assertEqual(asb.seat_label_text("x" * 24), "x" * 24)
        self.assertEqual(asb.seat_label_text("x" * 25), "x" * 24 + "…")

    def test_thread_headers_count_the_records(self):
        reply = self.reply()
        seats = {seat["id"]: seat for seat in reply["seats"]}
        records = reply["messages"]
        pair = [record for record in records if {record["from"], record["to"]} == {"release-plan", "parser-review"}]
        forward = sum(record["from"] == "release-plan" for record in pair)
        header = asb.message_thread(records, seats, "pair", ("release-plan", "parser-review"))
        self.assertEqual((header["route"], header["counts"], header["total"]),
                         ("release-plan ⇄ parser-review", f"→ {forward}  ← {len(pair) - forward}", len(pair)))
        self.assertEqual(header["counts"], "→ 75  ← 64")
        mine = [record for record in records if "parser-review" in (record["from"], record["to"])]
        sent = sum(record["from"] == "parser-review" for record in mine)
        header = asb.message_thread(records, seats, "session", "parser-review")
        self.assertEqual((header["route"], header["counts"]), ("parser-review", f"Sent {sent}  Received {len(mine) - sent}"))
        self.assertEqual(header["counts"], "Sent 81  Received 109")
        self.assertEqual(asb.message_thread(records, {}, "session", "gone")["counts"], "Sent 0  Received 0")
        self.assertEqual(asb.message_thread(records, {}, "session", "gone")["route"], "This session")
        out, back = next(record for record in mine if record["from"] == "parser-review"), next(record for record in mine if record["to"] == "parser-review")
        self.assertEqual(asb.message_block(header, out, seats), (False, "→ " + out["to"]))
        self.assertEqual(asb.message_block(header, back, seats), (True, "← " + back["from"]))
        pair_header = asb.message_thread(records, seats, "pair", ("release-plan", "parser-review"))
        self.assertEqual(asb.message_block(pair_header, pair[0], seats), (pair[0]["from"] == "release-plan", pair[0]["from"]))

    def test_arrivals_are_new_and_recent(self):
        reply = self.reply()
        now = reply["nowMs"]
        fresh = ["m-new", "release-plan", "parser-review", now - 1000, "accepted", "", None]
        stale = ["m-old", "docs", "release-plan", now - 121_000, "accepted", "", None]
        later = self.reply(extra=[fresh, stale])
        self.assertEqual([record["id"] for record in asb.message_arrivals(reply, later)], ["m-new"])
        self.assertEqual(asb.message_arrivals(later, later), [])
        self.assertEqual(asb.message_arrivals(None, later), [])
        edge = self.reply(extra=[["m-edge", "docs", "release-plan", now - 120_000, "accepted", "", None]])
        self.assertEqual([record["id"] for record in asb.message_arrivals(reply, edge)], ["m-edge"])

    def test_curve_positions_use_the_arc_length(self):
        table = asb.curve_table((0, 0), (50, 0), (100, 0))
        self.assertAlmostEqual(table[1][-1], 100)
        self.assertEqual(asb.curve_point(table, .85), (85.0, 0.0))
        self.assertAlmostEqual(asb.curve_distance(table, 30, 6), 6)
        self.assertEqual((asb.ease_flight(0), asb.ease_flight(1)), (0, 1))
        self.assertGreater(asb.ease_bars(.5), .85)
        self.assertLess(asb.ease_flight(.25), .25)


class BoardWindowsLogicChecks(unittest.TestCase):
    """The Board side of the Messages and Usage windows: the saved sizes, the tray event, and the start variable."""

    def test_window_sizes_read_and_write_next_to_the_layout(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "activity-windows.json"
            self.assertEqual(asb.read_window_sizes(path), {})
            asb.write_window_size(path, "messages", 1000, 700, False)
            self.assertEqual(json.loads(path.read_text()), {"version": 1, "messages": {"width": 1000, "height": 700, "maximized": False}})
            asb.write_window_size(path, "usage", 360, 16384, True)
            self.assertEqual(asb.read_window_sizes(path), {"messages": (1000, 700, False), "usage": (360, 16384, True)})
            # Values out of range, of the wrong type, or of an unknown kind change nothing.
            for args in (("messages", 359, 700, False), ("messages", 1000, 16385, False), ("messages", 1000.0, 700, False),
                         ("messages", True, 700, False), ("messages", 1000, 700, 0), ("board", 1000, 700, False)):
                with self.subTest(args=args):
                    asb.write_window_size(path, *args)
                    self.assertEqual(asb.read_window_sizes(path), {"messages": (1000, 700, False), "usage": (360, 16384, True)})
            # A broken or invalid file gives no sizes and raises nothing; the next write makes a valid file.
            for text in ("{", "[]", '{"version": 2, "messages": {"width": 1000, "height": 700, "maximized": false}}',
                         '{"version": 1, "messages": {"width": "1000", "height": 700, "maximized": false}}',
                         '{"version": 1, "messages": {"width": 1000, "height": 700}}'):
                with self.subTest(text=text):
                    path.write_text(text)
                    self.assertEqual(asb.read_window_sizes(path), {})
            path.write_text('{"version": 1, "messages": [], "usage": {"width": 948, "height": 760, "maximized": false}}')
            self.assertEqual(asb.read_window_sizes(path), {"usage": (948, 760, False)})
            path.write_text("{")
            asb.write_window_size(path, "messages", 968, 760, True)
            self.assertEqual(json.loads(path.read_text()), {"version": 1, "messages": {"width": 968, "height": 760, "maximized": True}})
            self.assertEqual(asb.read_window_sizes(Path(directory) / "missing" / "activity-windows.json"), {})

    def test_event_stream_passes_only_valid_show_window_events(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        events = (b'event: show-window\ndata: {"window":"usage","clientId":"board-b"}\n\n'
                  b'event: show-window\ndata: {"window":"preferences","clientId":"board-a"}\n\n'
                  b'event: show-window\ndata: ["usage", "board-a"]\n\n'
                  b'event: show-window\ndata: {"window":"usage"}\n\n'
                  b'event: show-window\ndata: {"window":"usage","clientId":7}\n\n'
                  b'event: show-window\ndata: not json\n\n'
                  b'event: show-window\ndata: {"window":"messages","clientId":"board-a"}\n\n'
                  b'event: dashboard\ndata: {"reason":"source-dirty"}\n\n')
        requests, done = [], threading.Event()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.end_headers()
                self.wfile.write(events)
                self.wfile.flush()
                done.wait(2)

            def log_message(self, *_args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            server_thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
            server_thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            board_calls, board_dashboards, activity_dashboards = [], threading.Event(), threading.Event()
            board = SCOPE["EventStream"](base, board_dashboards.set, lambda callback, *args: callback(*args),
                                         lambda window, client: board_calls.append((window, client)))
            # An activity window passes no on_show_window: its stream ignores the event.
            activity = SCOPE["EventStream"](base, activity_dashboards.set, lambda callback, *args: callback(*args))
            try:
                self.assertTrue(board_dashboards.wait(2))
                self.assertTrue(activity_dashboards.wait(2))
                # The bad data did not drop the connection: one request each, and the dashboard after it still came.
                self.assertEqual(requests, ["/api/events", "/api/events"])
                self.assertEqual(board_calls, [("usage", "board-b"), ("messages", "board-a")])
            finally:
                done.set()
                for stream in (board, activity):
                    stream.close()
                    stream.worker.join(1)
                server.shutdown()
                server_thread.join(1)

    def test_board_opens_a_tray_window_only_for_its_own_client_id(self):
        window = object.__new__(Window)
        window.ui_client_id, window.closed = "board-a", False
        application = Mock()
        window.get_application = lambda: application
        for client in ("board-b", "", "BOARD-A"):
            self.assertFalse(window.show_window_event("usage", client))
        application.show_activity.assert_not_called()
        self.assertFalse(window.show_window_event("usage", "board-a"))
        application.show_activity.assert_called_once_with("usage")
        window.closed = True
        window.show_window_event("messages", "board-a")
        application.show_activity.assert_called_once_with("usage")

    def test_open_window_variable_opens_the_window_after_the_board(self):
        application = object.__new__(SCOPE["SwitchboardApplication"])
        order = []
        board = Mock()
        board.present.side_effect = lambda: order.append("board")
        application.get_active_window = lambda: board
        application.show_activity = Mock(side_effect=lambda kind: order.append(kind))
        with patch.dict(SCOPE, {"GLib": SimpleNamespace(idle_add=lambda callback: order.append("idle") or callback())}):
            for value, expected in (("usage", ["board", "idle", "usage"]), ("messages", ["board", "idle", "messages"]),
                                    ("x", ["board"]), ("", ["board"])):
                with self.subTest(value=value), patch.dict(os.environ, {"ASB_OPEN_WINDOW": value}):
                    order.clear()
                    application.on_activate()
                    self.assertEqual(order, expected)
                    self.assertNotIn("ASB_OPEN_WINDOW", os.environ)


if __name__ == "__main__":
    unittest.main()
