#!/usr/bin/env python3
"""Native GNOME view for the local ASB session API."""
import json
from http.client import HTTPConnection, HTTPException
import os
import re
from pathlib import Path
import signal
import socket
import sys
import threading
import tempfile
import time
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

LOCAL_HTTP = build_opener(ProxyHandler({}))
ROW_HEIGHT = 22
COMFORTABLE_ROW_HEIGHT = 68
DEFAULT_COLUMN_WIDTH = 240
APP_ID = "local.asb.AgentSwitchBoard"
STATES = ("working", "waiting", "idle", "unknown")


def refresh_interval(dashboard):
    value = dashboard.get("refreshIntervalMs")
    return value if type(value) is int and value in (2000, 5000) else 5000


def row_menu_actions(row):
    actions = [("Read", "mark-read") if row.get("unread") or row.get("questionAttention")
               else ("Unread", "mark-unread"),
               ("Unpin", "unpin") if row.get("pinned") else ("Pin", "pin")]
    if row.get("pinned"):
        actions.extend((("Move pin earlier", "pin-up"), ("Move pin later", "pin-down")))
    return actions


def provider_query(query, app="all"):
    match = re.match(r"^\s*(cl|claude|cx|codex)\s*:\s*(.*)$", query, re.IGNORECASE | re.DOTALL)
    if match:
        app = "claude-desktop-code" if match[1].lower() in ("cl", "claude") else "codex"
        query = match[2]
    return query.strip().casefold(), app


def filtered_rows(dashboard, query="", app="all", state="all", archived=False, pending_only=False):
    query, app = provider_query(query, app)
    states = set(STATES) if state == "all" else {state} if isinstance(state, str) else set(state)
    rows = [row for row in dashboard.get("threads", [])
            if (archived or not row.get("archived"))
            and (app == "all" or row.get("provider") == app)
            and row.get("state") in states
            and (not pending_only or row.get("pending"))
            and (not query or query in "\n".join(str(row.get(key, "")) for key in
                 ("title", "projectName", "cwd", "providerLabel")).casefold())]
    def bucket(row):
        if row.get("pending") or row.get("state") == "waiting":
            return 0
        return {"working": 1, "idle": 2, "unknown": 3}.get(row.get("state"), 3)
    rows.sort(key=lambda row: (0, row.get("pinIndex", 0), row["id"]) if row.get("pinned") else
              (1, bucket(row), -row.get("updatedAtMs", 0), row["id"]))
    return rows


def pack_columns(rows, width, height, column_width=DEFAULT_COLUMN_WIDTH, row_height=ROW_HEIGHT):
    columns = max(1, (width + 12) // (column_width + 12))
    capacity = max(1, (height - 4) // row_height)
    parts = [rows[start:start + capacity] for start in range(0, len(rows), capacity)]
    return columns, capacity, parts


THEME_KEYS = ("background", "text", "accent", "muted", "divider")
THEME_PATH = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "asb" / "theme.json"
LAYOUT_PATH = THEME_PATH.with_name("layout.json")


def luminance(color):
    channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return sum((value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4) * weight
               for value, weight in zip(channels, (.2126, .7152, .0722)))


def contrast(first, second):
    light, dark = sorted((luminance(first), luminance(second)), reverse=True)
    return (light + .05) / (dark + .05)


def highlight_color(colors):
    return "#" + "".join(f"{round(int(colors['background'][start:start + 2], 16) * .85 + int(colors['accent'][start:start + 2], 16) * .15):02x}"
                         for start in (1, 3, 5))


def validate_theme(value):
    if not isinstance(value, dict) or set(value) != set(THEME_KEYS):
        raise ValueError("Choose a color for each theme field.")
    if any(not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in value.values()):
        raise ValueError("Colors must use #RRGGBB values.")
    if luminance(value["background"]) > .12:
        raise ValueError("Choose a dark background.")
    for key in ("text", "muted", "accent"):
        for surface, color in (("background", value["background"]), ("highlight", highlight_color(value))):
            if contrast(value[key], color) < 4.5:
                raise ValueError(f"{key.capitalize()} needs at least 4.5:1 contrast with the {surface}.")
    if contrast(value["divider"], value["background"]) < 1.5:
        raise ValueError("Divider needs at least 1.5:1 contrast with the background.")
    return {key: value[key].lower() for key in THEME_KEYS}


def read_theme(path):
    if not path or not Path(path).exists():
        return None
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict) or value.get("mode") != "custom":
        raise ValueError("The saved ASB theme is not valid. Reset it to GNOME.")
    return validate_theme(value.get("colors"))


def write_config(path, value):
    if not path:
        return
    path = Path(path)
    if value is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".asb-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream)
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def write_theme(path, colors=None):
    write_config(path, None if colors is None else {"mode": "custom", "colors": validate_theme(colors)})


def validate_column_width(width):
    if type(width) is not int or not 160 <= width <= 600:
        raise ValueError("Column width must be a whole number from 160 to 600 pixels.")
    return width


def read_layout(path):
    if not path or not Path(path).exists():
        return {"columnWidth": DEFAULT_COLUMN_WIDTH, "view": "compact"}
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict) or not {"version", "columnWidth"}.issubset(value) \
            or set(value) - {"version", "columnWidth", "view"} or value["version"] != 1:
        raise ValueError("The saved layout is not valid. Reset the width.")
    view = value.get("view", "compact")
    if view not in ("compact", "comfortable"):
        raise ValueError("Choose Compact or Comfortable view.")
    return {"columnWidth": validate_column_width(value["columnWidth"]), "view": view}


def write_layout(path, width=None, view=None):
    if view is None:
        view = read_layout(path)["view"]
    if view not in ("compact", "comfortable"):
        raise ValueError("Choose Compact or Comfortable view.")
    if width is None and view == "compact":
        write_config(path, None)
        return
    value = {"version": 1, "columnWidth": validate_column_width(DEFAULT_COLUMN_WIDTH if width is None else width)}
    if view == "comfortable":
        value["view"] = view
    write_config(path, value)


def working_duration(row, now_ms=None):
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    start = row.get("workingSinceMs", 0)
    if row.get("state") != "working" or isinstance(start, bool) or not isinstance(start, (int, float)) or not 0 < start <= now_ms:
        return ""
    hours, remainder = divmod(int((now_ms - start) / 1000), 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}h{minutes}m" if hours else f"{minutes}m{seconds}s" if minutes else f"{seconds}s"


def row_meta(row, now_ms=None, relative=False):
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    updated = row.get("updatedAtMs", 0)
    age = max(0, now_ms - updated)
    if not updated:
        date = "No date"
    elif age < 60_000:
        date = "Just now"
    elif age < 3_600_000:
        date = f"{int(age / 60_000)}m ago"
    elif age < 86_400_000:
        date = f"{int(age / 3_600_000)}h ago"
    elif relative:
        date = f"{int(age / 86_400_000)}d ago"
    else:
        date = datetime.fromtimestamp(updated / 1000).strftime("%b %d")
    parts = [str(row.get("state", "unknown")).capitalize(), date]
    if row.get("pinned"):
        parts.append("Pinned")
    if row.get("archived"):
        parts.append("Archived")
    return " · ".join(parts)


def local_base_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port \
            or parsed.username or parsed.password or parsed.path not in ("", "/") \
            or parsed.query or parsed.fragment:
        raise ValueError("Use the local ASB address: http://127.0.0.1:<port>.")
    return value.rstrip("/")


def request_json(base, route, method="GET", body=None):
    headers = {"Accept": "application/json"}
    data = None
    if method == "POST":
        headers.update({"Origin": base, "Content-Type": "application/json"})
        data = json.dumps(body or {}).encode()
    request = Request(base + route, data=data, headers=headers, method=method)
    try:
        with LOCAL_HTTP.open(request, timeout=15) as response:
            result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("The ASB response is not an object.")
        success = "opened" if route.endswith("/open") else "marked" if route.endswith("/mark-unread") else "changed"
        if method == "POST" and not result.get(success):
            raise ValueError("The session action did not succeed.")
        return result
    except (HTTPError, URLError, OSError, ValueError) as error:
        action = "open this session" if route.endswith("/open") else "change the unread setting" if route == "/api/settings/unread" \
            else "change this session" if method == "POST" else "load sessions"
        recovery = "Check the app link handler, then try again." if route.endswith("/open") \
            else "Check that ASB is running, then try again." if route == "/api/settings/unread" \
            else "Refresh the session list, then try again." if method == "POST" else "Check that ASB is running, then refresh."
        raise RuntimeError(f"Cannot {action}. {recovery}") from error


def request_async(base, route, callback, dispatch, method="GET", body=None):
    def work():
        try:
            result, error = request_json(base, route, method, body), None
        except RuntimeError as failure:
            result, error = None, str(failure)
        dispatch(callback, result, error)
    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    return worker


class EventStream:
    def __init__(self, base, callback, dispatch):
        self.address = urlsplit(base)
        self.callback, self.dispatch = callback, dispatch
        self.stopped = threading.Event()
        self.lock, self.socket = threading.Lock(), None
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def run(self):
        while not self.stopped.is_set():
            connection = HTTPConnection(self.address.hostname, self.address.port, timeout=30)
            try:
                connection.request("GET", "/api/events", headers={"Accept": "text/event-stream"})
                with self.lock:
                    if self.stopped.is_set():
                        break
                    self.socket = connection.sock
                with connection.getresponse() as response:
                    if response.status != 200 or response.getheader("Content-Type", "").split(";")[0] != "text/event-stream":
                        raise ValueError("The ASB event stream is not available.")
                    event, data = "", []
                    while not self.stopped.is_set():
                        line = response.readline(4097)
                        if not line:
                            break
                        if len(line) > 4096:
                            raise ValueError("The ASB event is too large.")
                        line = line.decode("utf-8").rstrip("\r\n")
                        if not line:
                            if event == "dashboard" and data:
                                value = json.loads("\n".join(data))
                                if isinstance(value, dict) and value.get("reason") != "connected":
                                    self.dispatch(self.callback)
                            event, data = "", []
                        elif line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            data.append(line[5:].lstrip())
                            if sum(map(len, data)) > 4096:
                                raise ValueError("The ASB event is too large.")
            except (HTTPException, OSError, ValueError):
                pass
            finally:
                with self.lock:
                    self.socket = None
                connection.close()
            self.stopped.wait(5)

    def close(self):
        self.stopped.set()
        with self.lock:
            if self.socket:
                try:
                    self.socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


try:
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Adw, Gdk, Gio, GLib, GObject, Gtk, Pango
except (ImportError, ValueError):
    print("ASB needs system Python 3 with PyGObject, GTK4, and Libadwaita. Use npm start for the web view.", file=sys.stderr)
    raise SystemExit(1)

SHORTCUT_MASK = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.META_MASK


def label(text, css=None):
    widget = Gtk.Label(label=text, xalign=0)
    if css:
        widget.add_css_class(css)
    return widget


def save_snapshot(window, output):
    """Development check: render only this GTK window."""
    paintable = Gtk.WidgetPaintable.new(window)
    snapshot = Gtk.Snapshot()
    paintable.snapshot(snapshot, window.get_width(), window.get_height())
    node = snapshot.to_node()
    if node is None:
        raise RuntimeError("The native window has no rendered content.")
    texture = window.get_renderer().render_texture(node, None)
    if not texture.save_to_png(output):
        raise RuntimeError("Cannot save the native window image.")


class ColumnScroll(Gtk.ScrolledWindow):
    def do_measure(self, orientation, for_size):
        # Row count follows viewport height; it must not set the window's minimum height.
        if orientation == Gtk.Orientation.VERTICAL:
            return 0, 0, -1, -1
        minimum, natural, *_ = Gtk.ScrolledWindow.do_measure(self, orientation, for_size)
        return minimum, natural, -1, -1


class SwitchboardWindow(Adw.ApplicationWindow):
    def __init__(self, application, base, initial_dashboard=None, theme_path=THEME_PATH, layout_path=LAYOUT_PATH):
        super().__init__(application=application, title="ASB · Agent Switch Board",
                         default_width=420, default_height=900)
        self.set_size_request(0, self.get_size_request().height)
        self.add_css_class("asb-column-flow")
        self.base, self.theme_path = base, theme_path
        self.layout_path = layout_path
        self.dragging = False
        layout_error = ""
        try:
            layout = read_layout(layout_path)
            self.column_width, self.view = layout["columnWidth"], layout["view"]
        except (OSError, ValueError) as error:
            self.column_width, self.view, layout_error = DEFAULT_COLUMN_WIDTH, "compact", str(error)
        self.row_height = COMFORTABLE_ROW_HEIGHT if self.view == "comfortable" else ROW_HEIGHT
        self.focused_id = None
        if self.view == "comfortable":
            self.add_css_class("asb-comfortable")
        self.dashboard = self.signature = None
        self.closed = self.loading = self.refresh_queued = False
        self.refresh_force_queued = False
        self.refresh_interval_ms = 5000
        self.clock_interval = self.clock_timer = None
        self.opening, self.focus_widgets = set(), {}
        self.open_errors = {}
        self.context_menu = None
        self.drag_identity = None
        for name in ("mark-unread", "mark-read", "pin", "unpin", "pin-up", "pin-down"):
            action = Gio.SimpleAction.new(name, GLib.VariantType.new("s"))
            action.connect("activate", self.row_action, name)
            self.add_action(action)
        self.geometry = None
        self.layout_signature = None
        self.geometry_idle = self.surface_signal = None
        self.layout_surface = None
        self.snapshot_pending = bool(os.environ.get("ASB_SNAPSHOT"))
        self.connect("close-request", self.on_close)
        self.css = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(self.get_display(), self.css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        Gtk.IconTheme.get_for_display(self.get_display()).add_search_path(str(Path(__file__).parents[1] / "assets" / "icons"))
        self.set_icon_name(APP_ID)
        self.set_palette(None)
        self.refresh_button = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh sessions")
        self.refresh_button.connect("clicked", lambda *_: self.refresh(True))
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        self.tools = tools = Gtk.Box(spacing=4, margin_start=4, margin_end=4, margin_top=2)
        tools.add_css_class("asb-toolbar")
        self.app_mark = Gtk.Image(icon_name=APP_ID, pixel_size=16, tooltip_text="ASB")
        self.app_mark.update_property([Gtk.AccessibleProperty.LABEL], ["ASB app icon"])
        tools.append(self.app_mark)
        self.search = Gtk.SearchEntry(placeholder_text="Find a session or folder", hexpand=True)
        self.search.set_size_request(0, -1)
        self.search.set_tooltip_text("Search title or folder. cl: or claude: selects Claude; cx: or codex: selects Codex.")
        self.search.connect("search-changed", lambda *_: self.render())
        self.search.connect("stop-search", self.clear_search)
        tools.append(self.search)
        menu = Gtk.MenuButton(icon_name="view-more-symbolic", tooltip_text="Filters and theme")
        self.menu_button = menu
        popover = Gtk.Popover()
        popover.set_autohide(True)
        popover.connect("closed", self.settings_closed)
        settings = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10,
                           margin_top=12, margin_bottom=12, margin_start=12, margin_end=12)
        self.apps, self.syncing_apps = set(), False
        self.app_filter = Gtk.DropDown.new_from_strings(["All apps", "Codex", "Claude", "Both apps"])
        self.states, self.updating_states = set(STATES), False
        self.state_filter = Gtk.MenuButton(label="All states")
        self.state_filter.update_property([Gtk.AccessibleProperty.LABEL], ["Status: All states"])
        state_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin_top=12,
                            margin_bottom=12, margin_start=12, margin_end=12)
        self.state_checks = {}
        for state in STATES:
            check = Gtk.CheckButton(label=state.capitalize(), active=True)
            check.connect("toggled", self.states_changed)
            self.state_checks[state] = check
            state_box.append(check)
        choices = Gtk.Box(spacing=6)
        for title, values in (("All states", set(STATES)), ("Clear states", set())):
            button = Gtk.Button(label=title)
            button.connect("clicked", lambda _button, selected=values: self.select_states(selected))
            choices.append(button)
        state_box.append(choices)
        help_text = label("No selected states hides all sessions.", "caption")
        help_text.set_wrap(True)
        state_box.append(help_text)
        self.state_filter.set_popover(Gtk.Popover(child=state_box))
        self.archive = Gtk.CheckButton(label="Show archived sessions")
        for title, dropdown in (("App", self.app_filter), ("Status", self.state_filter)):
            dropdown.update_property([Gtk.AccessibleProperty.LABEL], [title])
            if dropdown is self.app_filter:
                dropdown.connect("notify::selected", self.apps_from_menu)
            row = Gtk.Box(spacing=12)
            name = label(title)
            name.set_hexpand(True)
            row.append(name)
            row.append(dropdown)
            settings.append(row)
        self.archive.connect("toggled", lambda *_: self.render())
        settings.append(self.archive)
        self.syncing_unread_setting = self.unread_setting_loading = False
        self.persistent_unread = Gtk.CheckButton(label="Persistent unread")
        self.persistent_unread.connect("toggled", self.change_unread_setting)
        settings.append(self.persistent_unread)
        unread_help = label("Use Read in the row menu to clear dots.", "caption")
        unread_help.set_wrap(True)
        settings.append(unread_help)
        self.unread_setting_error = label("", "warning")
        self.unread_setting_error.set_wrap(True)
        self.unread_setting_error.set_max_width_chars(32)
        settings.append(self.unread_setting_error)
        view_row = Gtk.Box(spacing=12)
        view_name = label("View")
        view_name.set_hexpand(True)
        self.view_filter = Gtk.DropDown.new_from_strings(["Compact", "Comfortable"])
        self.view_filter.set_selected(1 if self.view == "comfortable" else 0)
        self.view_filter.update_property([Gtk.AccessibleProperty.LABEL], ["View"])
        self.view_filter.connect("notify::selected", self.change_view)
        view_row.append(view_name)
        view_row.append(self.view_filter)
        settings.append(view_row)
        width_row = Gtk.Box(spacing=8)
        width_name = label("Column width")
        width_name.set_hexpand(True)
        self.width_control = Gtk.SpinButton.new_with_range(160, 600, 10)
        self.width_control.set_numeric(True)
        self.width_control.set_width_chars(4)
        self.width_control.set_value(self.column_width)
        self.width_control.update_property([Gtk.AccessibleProperty.LABEL], ["Column width in pixels"])
        self.width_control.set_tooltip_text("Drag any column divider to change all columns. 160–600 px.")
        self.width_control.connect("value-changed", self.set_column_width)
        width_row.append(width_name)
        width_row.append(self.width_control)
        settings.append(width_row)
        reset_width = Gtk.Button(label="Reset width")
        reset_width.connect("clicked", self.reset_width)
        settings.append(reset_width)
        self.layout_error = label(layout_error, "warning")
        self.layout_error.set_wrap(True)
        self.layout_error.set_max_width_chars(32)
        settings.append(self.layout_error)
        settings.append(Gtk.Separator())
        self.theme_mode = Gtk.DropDown.new_from_strings(["GNOME colors", "Custom colors"])
        settings.append(self.theme_mode)
        self.color_buttons = {}
        colors = self.native_colors()
        for key in THEME_KEYS:
            row = Gtk.Box(spacing=12)
            name = label(key.capitalize())
            name.set_hexpand(True)
            picker = Gtk.ColorDialogButton.new(Gtk.ColorDialog(title=f"ASB {key} color", with_alpha=False))
            for accessible in (picker, picker.get_first_child()):
                accessible.update_property([Gtk.AccessibleProperty.LABEL], [f"{key.capitalize()} color"])
            picker.set_rgba(self.rgba(colors[key]))
            self.color_buttons[key] = picker
            row.append(name)
            row.append(picker)
            settings.append(row)
        self.theme_error = label("", "warning")
        self.theme_error.set_wrap(True)
        self.theme_error.set_max_width_chars(32)
        settings.append(self.theme_error)
        actions = Gtk.Box(spacing=8)
        apply = Gtk.Button(label="Apply theme")
        apply.connect("clicked", self.apply_theme)
        reset = Gtk.Button(label="Reset to GNOME")
        reset.connect("clicked", self.reset_theme)
        actions.append(apply)
        actions.append(reset)
        settings.append(actions)
        settings.append(label("Colors apply only to ASB.", "caption"))
        popover.set_child(settings)
        menu.set_popover(popover)
        tools.append(menu)
        tools.append(self.refresh_button)
        self.window_controls = Gtk.WindowControls(side=Gtk.PackType.END, decoration_layout=":close")
        tools.append(self.window_controls)
        self.window_handle = Gtk.WindowHandle(child=tools)
        body.append(self.window_handle)
        self.feedback = feedback = Gtk.Box(spacing=6, margin_start=6, margin_end=6)
        self.pending_group = Gtk.Box(spacing=4, valign=Gtk.Align.CENTER)
        self.app_pills = {}
        for provider, title in (("codex", "Codex"), ("claude-desktop-code", "Claude")):
            pill = Gtk.ToggleButton(label=title, tooltip_text="Select apps. No selected apps shows all sessions.")
            pill.add_css_class("asb-filter-pill")
            pill.connect("toggled", self.apps_from_pills)
            self.app_pills[provider] = pill
            self.pending_group.append(pill)
        self.pending_only = Gtk.ToggleButton(label="Pending", tooltip_text="Show sessions that need attention.")
        self.pending_only.add_css_class("asb-filter-pill")
        self.pending_only.update_property([Gtk.AccessibleProperty.LABEL], ["Pending only"])
        self.pending_only.connect("notify::active", lambda *_: self.render())
        self.pending_group.append(self.pending_only)
        feedback.append(self.pending_group)
        self.count = label("Loading sessions…", "caption")
        self.count.set_ellipsize(Pango.EllipsizeMode.END)
        self.count.add_css_class("dim-label")
        self.count.set_hexpand(True)
        self.count.set_halign(Gtk.Align.END)
        feedback.append(self.count)
        body.append(feedback)
        self.wide_controls = False
        self.notice = label("", "caption")
        self.notice.set_wrap(True)
        self.notice.set_margin_start(10)
        self.notice.set_margin_end(10)
        self.notice.add_css_class("warning")
        self.notice.set_visible(False)
        body.append(self.notice)
        self.list_body = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12,
                                margin_start=4, margin_end=4, margin_bottom=4)
        self.scroll = ColumnScroll(vexpand=True, hscrollbar_policy=Gtk.PolicyType.AUTOMATIC,
                                        vscrollbar_policy=Gtk.PolicyType.NEVER,
                                        child=self.list_body)
        body.append(self.scroll)
        wheel = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.BOTH_AXES,
                                          propagation_phase=Gtk.PropagationPhase.CAPTURE)
        wheel.connect("scroll", self.scroll_horizontal)
        self.scroll.add_controller(wheel)
        drag = Gtk.GestureDrag(button=1, propagation_phase=Gtk.PropagationPhase.CAPTURE)
        drag.connect("drag-begin", self.column_drag_begin)
        drag.connect("drag-update", self.column_drag_update)
        drag.connect("drag-end", self.column_drag_end)
        self.list_body.add_controller(drag)
        motion = Gtk.EventControllerMotion(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        motion.connect("motion", lambda _event, x, _y: self.list_body.set_cursor_from_name("col-resize" if self.dragging or self.divider_at(x) else None))
        motion.connect("leave", lambda *_args: self.list_body.set_cursor_from_name(None))
        self.list_body.add_controller(motion)
        self.set_content(body)
        keys = Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        keys.connect("key-pressed", self.window_key)
        self.add_controller(keys)
        self.settings_click = Gtk.GestureClick(button=0, propagation_phase=Gtk.PropagationPhase.CAPTURE)
        self.settings_click.connect("pressed", self.outside_settings_pressed)
        self.add_controller(self.settings_click)
        self.deferred_row_focus = None
        try:
            saved = read_theme(theme_path)
            if saved:
                self.set_palette(saved)
                self.theme_mode.set_selected(1)
                for key, picker in self.color_buttons.items():
                    picker.set_rgba(self.rgba(saved[key]))
        except (OSError, ValueError) as error:
            self.theme_error.set_label(str(error))
        self.connect("realize", self.watch_layout)
        self.timer = GLib.timeout_add(self.refresh_interval_ms, self.tick)
        self.events = EventStream(self.base, self.source_changed, GLib.idle_add)
        if initial_dashboard is None:
            self.refresh()
        else:
            self.apply_dashboard(initial_dashboard, None)

    @staticmethod
    def rgba(value):
        color = Gdk.RGBA()
        color.parse(value)
        return color

    @staticmethod
    def hex_color(color):
        return "#" + "".join(f"{round(channel * 255):02x}" for channel in (color.red, color.green, color.blue))

    def native_colors(self):
        context = self.get_style_context()
        colors = {}
        for key, name in (("background", "window_bg_color"), ("text", "window_fg_color"),
                          ("accent", "accent_color"), ("muted", "window_fg_color"), ("divider", "window_fg_color")):
            found, value = context.lookup_color(name)
            if not found:
                value = self.get_color()
            colors[key] = self.hex_color(value)
        # GNOME colors seed the editor. Custom text must pass the same contrast check.
        if contrast(colors["accent"], colors["background"]) < 4.5:
            colors["accent"] = colors["text"]
        foreground, background = self.rgba(colors["text"]), self.rgba(colors["background"])
        for key, fraction in (("muted", .72), ("divider", .3)):
            value = Gdk.RGBA()
            value.red = foreground.red * fraction + background.red * (1 - fraction)
            value.green = foreground.green * fraction + background.green * (1 - fraction)
            value.blue = foreground.blue * fraction + background.blue * (1 - fraction)
            value.alpha = 1
            colors[key] = self.hex_color(value)
        return colors

    def set_palette(self, colors):
        base = ".asb-column-flow"
        css = f"""
{base} .asb-session {{ min-height: {ROW_HEIGHT}px; padding: 0; border-radius: 3px; font-size: 13px; }}
{base}.asb-comfortable .asb-session {{ min-height: {COMFORTABLE_ROW_HEIGHT}px; }}
{base} .asb-filter-pill {{ min-height: 24px; border-radius: 99px; padding: 2px 8px; font-size: 11px; }}
{base} .asb-filter-pill:checked {{ background: @accent_bg_color; color: @accent_fg_color; }}
{base} .asb-toolbar > button, {base} .asb-toolbar > menubutton > button,
{base} .asb-toolbar windowcontrols button {{ min-height: 24px; min-width: 22px; padding: 2px; }}
{base} .asb-toolbar searchentry {{ min-height: 26px; padding-top: 0; padding-bottom: 0; }}
{base} .asb-state {{ font-size: 11px; }}
{base} .asb-provider {{ opacity: .65; }}
{base} .asb-column {{ background: transparent; }}
{base} .asb-column + .asb-column {{ border-left: 1px solid @borders; }}
{base} .asb-dot {{ min-width: 7px; min-height: 7px; border-radius: 50%; background: @accent_color; }}
{base} .asb-pending {{ color: @accent_color; opacity: 1; }}
"""
        if colors:
            colors = validate_theme(colors)
            self.add_css_class("asb-custom")
            scope = base + ".asb-custom"
            css += f"""
{scope}, {scope} headerbar, {scope} popover contents {{ background: {colors['background']}; color: {colors['text']}; }}
{scope} .asb-state, {scope} .dim-label {{ color: {colors['muted']}; opacity: 1; }}
{scope} .asb-pending, {scope} .asb-working, {scope} .asb-waiting {{ color: {colors['accent']}; }}
{scope} .asb-dot {{ background: {colors['accent']}; }}
{scope} .asb-column + .asb-column {{ border-color: {colors['divider']}; }}
{scope} .asb-session:hover, {scope} .asb-session:focus {{ background: {highlight_color(colors)}; }}
{scope} entry, {scope} button, {scope} dropdown {{ color: {colors['text']}; }}
{scope} :focus-visible {{ outline-color: {colors['accent']}; }}
{scope} entry:focus-within {{ box-shadow: inset 0 0 0 1px {colors['accent']}; }}
{scope} entry selection {{ background: {colors['accent']}; color: {colors['background']}; }}
{scope} switch:checked, {scope} checkbutton check:checked {{ background: {colors['accent']}; border-color: {colors['accent']}; }}
{scope} .asb-filter-pill:checked {{ background: {colors['accent']}; color: {colors['background']}; }}
"""
        else:
            self.remove_css_class("asb-custom")
        self.css.load_from_string(css)

    def apply_theme(self, *_args):
        try:
            colors = None if self.theme_mode.get_selected() == 0 else validate_theme(
                {key: self.hex_color(picker.get_rgba()) for key, picker in self.color_buttons.items()})
            write_theme(self.theme_path, colors)
            self.set_palette(colors)
            self.theme_error.set_label("")
        except (ValueError, OSError) as error:
            self.theme_error.set_label(str(error))

    def reset_theme(self, *_args):
        try:
            write_theme(self.theme_path)
            self.set_palette(None)
            self.theme_mode.set_selected(0)
            for key, picker in self.color_buttons.items():
                picker.set_rgba(self.rgba(self.native_colors()[key]))
            self.theme_error.set_label("")
        except OSError:
            self.theme_error.set_label("Cannot reset the ASB theme. Check its config folder.")

    def set_notice(self, text):
        self.notice.set_label(text)
        self.notice.set_visible(bool(text))

    def tick(self):
        if not self.closed:
            self.refresh()
        return not self.closed

    def source_changed(self):
        self.refresh(queue=True)
        return False

    def refresh(self, force=False, queue=False):
        if self.closed:
            return
        if self.loading:
            self.refresh_queued = self.refresh_queued or force or queue
            self.refresh_force_queued = self.refresh_force_queued or force
            return
        self.loading = True
        self.refresh_button.set_sensitive(False)
        request_async(self.base, "/api/dashboard?force=1" if force else "/api/dashboard",
                      self.apply_dashboard, GLib.idle_add)

    def apply_dashboard(self, dashboard, error):
        if self.closed:
            return False
        self.loading = False
        self.refresh_button.set_sensitive(True)
        if self.refresh_queued:
            self.refresh_queued = False
            force, self.refresh_force_queued = self.refresh_force_queued, False
            GLib.idle_add(self.refresh, force)
        if error:
            self.set_notice(error)
            if self.dashboard is None:
                self.count.set_label("Sessions are not available")
            return False
        self.dashboard = dashboard
        interval = refresh_interval(dashboard)
        if interval != self.refresh_interval_ms:
            self.refresh_interval_ms = interval
            GLib.source_remove(self.timer)
            self.timer = GLib.timeout_add(interval, self.tick)
        self.sync_unread_setting(dashboard.get("persistentUnread", False))
        self.set_notice(" ".join(provider.get("message", "") for provider in dashboard.get("providers", []) if provider.get("message")))
        signature = dashboard.get("threads", [])
        if signature != self.signature:
            self.signature = signature
            self.render()
        clock_interval = 2 if any(row.get("state") == "working" and not row.get("archived")
                                  for row in dashboard.get("threads", [])) else 60
        if clock_interval != self.clock_interval:
            if self.clock_timer:
                GLib.source_remove(self.clock_timer)
            self.clock_interval = clock_interval
            self.clock_timer = GLib.timeout_add_seconds(clock_interval, self.update_clock)
        self.update_clock()
        if self.snapshot_pending:
            self.snapshot_pending = False
            GLib.timeout_add(250, self.capture)
        return False

    def capture(self):
        try:
            save_snapshot(self, os.environ["ASB_SNAPSHOT"])
            print("Saved the native ASB window image.")
        except (TypeError, RuntimeError, OSError) as error:
            print(f"Cannot save the native GTK image: {error}", file=sys.stderr)
        return False

    def watch_layout(self, *_args):
        self.layout_surface = self.get_surface()
        self.surface_signal = self.layout_surface.connect("layout", self.queue_geometry)
        self.queue_geometry()

    def queue_geometry(self, *_args):
        if not self.closed and not self.geometry_idle:
            self.geometry_idle = GLib.idle_add(self.check_geometry)

    def check_geometry(self, *_args):
        self.geometry_idle = None
        if self.closed:
            return False
        wide = self.get_width() >= 680
        if wide != self.wide_controls:
            self.wide_controls = wide
            for widget in (self.pending_group, self.count):
                widget.get_parent().remove(widget)
            if wide:
                self.tools.insert_child_after(self.pending_group, self.search)
                self.tools.insert_child_after(self.count, self.pending_group)
            else:
                self.feedback.append(self.pending_group)
                self.feedback.append(self.count)
            self.count.set_hexpand(not wide)
            self.feedback.set_visible(not wide)
        geometry = (self.scroll.get_width(), self.scroll.get_height())
        if geometry[0] > 0 and geometry[1] > 0 and geometry != self.geometry:
            self.geometry = geometry
            self.render(reveal_focus=True)
        return False

    def set_column_width(self, *_args):
        width = validate_column_width(self.width_control.get_value_as_int())
        if width != self.column_width:
            self.column_width = width
            available_width, available_height = self.geometry or (self.get_default_size().width, 600)
            if pack_columns([], available_width, available_height, width)[0] != getattr(self, "columns", 0):
                self.render(reveal_focus=True)
        if not self.dragging:
            self.save_width()

    def save_width(self):
        try:
            write_layout(self.layout_path, self.column_width, self.view)
            self.layout_error.set_label("")
        except (OSError, ValueError) as error:
            self.layout_error.set_label(str(error))

    def reset_width(self, *_args):
        self.dragging = True
        self.width_control.set_value(DEFAULT_COLUMN_WIDTH)
        self.dragging = False
        try:
            write_layout(self.layout_path, view=self.view)
            self.layout_error.set_label("")
        except OSError:
            self.layout_error.set_label("Cannot reset the width. Check the ASB config folder.")

    def change_view(self, *_args):
        view = "comfortable" if self.view_filter.get_selected() == 1 else "compact"
        if view != self.view:
            focused = self.focus_key() or self.focused_id
            self.view = view
            self.row_height = COMFORTABLE_ROW_HEIGHT if view == "comfortable" else ROW_HEIGHT
            if view == "comfortable":
                self.add_css_class("asb-comfortable")
            else:
                self.remove_css_class("asb-comfortable")
            self.render(focused, reveal_focus=True)
            self.save_width()

    def divider_at(self, x):
        step = getattr(self, "column_pixel_width", 0) + 12
        return any(abs(x - (index * step - 6)) <= 6 for index in range(1, getattr(self, "actual_columns", 0)))

    def scroll_horizontal(self, controller, dx, dy):
        adjustment = self.scroll.get_hadjustment()
        unit = controller.get_unit() if controller else Gdk.ScrollUnit.WHEEL
        distance = max(32, adjustment.get_step_increment()) if unit == Gdk.ScrollUnit.WHEEL else 1
        adjustment.set_value(adjustment.get_value() + (dx if dx else dy) * distance)
        return True

    def column_drag_begin(self, gesture, x, _y):
        if not self.divider_at(x):
            if gesture:
                gesture.set_state(Gtk.EventSequenceState.DENIED)
            return
        self.dragging = True
        self.drag_start_width = self.column_width
        if gesture:
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def column_drag_update(self, _gesture, offset_x, _offset_y):
        if self.dragging:
            self.width_control.set_value(max(160, min(600, round(self.drag_start_width + offset_x))))

    def column_drag_end(self, *_args):
        if self.dragging:
            self.dragging = False
            self.save_width()
            self.list_body.set_cursor_from_name(None)

    def focus_key(self):
        widget = self.get_focus()
        while widget:
            key = getattr(widget, "asb_focus_key", None)
            if key:
                return key
            widget = widget.get_parent()
        return None

    def clear_search(self, *_args):
        self.search.set_text("")
        self.render()

    def window_key(self, _controller, key, _code, modifiers):
        if modifiers & SHORTCUT_MASK or self.menu_button.get_popover().get_visible() \
                or (self.context_menu and self.context_menu.get_visible()):
            return False
        focus = self.get_focus()
        if focus and focus.get_ancestor(Gtk.Popover):
            return False
        if key == Gdk.KEY_Escape:
            if self.search.get_text():
                self.clear_search()
                return True
            return False
        if isinstance(focus, (Gtk.Editable, Gtk.TextView)) \
                or key in (Gdk.KEY_space, Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            return False
        codepoint = Gdk.keyval_to_unicode(key)
        if codepoint and chr(codepoint).isprintable():
            self.search.grab_focus()
            self.search.set_text(self.search.get_text() + chr(codepoint))
            self.search.set_position(-1)
            return True
        return False

    def visible_rows(self):
        app = next(iter(self.apps)) if len(self.apps) == 1 else "all"
        return filtered_rows(self.dashboard, self.search.get_text(), app, self.states, self.archive.get_active(), self.pending_only.get_active())

    def select_apps(self, apps):
        self.syncing_apps = True
        self.apps = set(apps)
        for provider, pill in self.app_pills.items():
            pill.set_active(provider in self.apps)
        self.app_filter.set_selected(3 if len(self.apps) == 2 else 1 if self.apps == {"codex"}
                                     else 2 if self.apps == {"claude-desktop-code"} else 0)
        self.syncing_apps = False
        self.render()

    def apps_from_menu(self, *_args):
        if not self.syncing_apps:
            self.select_apps([set(), {"codex"}, {"claude-desktop-code"}, {"codex", "claude-desktop-code"}][self.app_filter.get_selected()])

    def apps_from_pills(self, *_args):
        if not self.syncing_apps:
            self.select_apps({provider for provider, pill in self.app_pills.items() if pill.get_active()})

    def states_changed(self, *_args):
        if self.updating_states:
            return
        self.states = {state for state, check in self.state_checks.items() if check.get_active()}
        title = "All states" if len(self.states) == len(STATES) else f"{len(self.states)} states"
        self.state_filter.set_label(title)
        self.state_filter.update_property([Gtk.AccessibleProperty.LABEL], ["Status: " + title])
        self.render()

    def select_states(self, states):
        self.updating_states = True
        for state, check in self.state_checks.items():
            check.set_active(state in states)
        self.updating_states = False
        self.states_changed()

    def render(self, preserve_focus=None, reveal_focus=False):
        if self.dashboard is None or self.closed:
            return
        focused = preserve_focus or self.focus_key()
        if reveal_focus and not focused and self.get_focus() is None:
            focused = self.focused_id
        position = self.scroll.get_hadjustment().get_value()
        rows = self.visible_rows()
        width, height = self.geometry or (self.get_default_size().width, 600)
        self.columns, self.capacity, parts = pack_columns(rows, width, height, self.column_width, self.row_height)
        self.column_pixel_width = max(1, (width - 8 - 12 * (self.columns - 1)) // self.columns)
        self.actual_columns = len(parts)
        self.row_order = [row["id"] for row in rows]
        layout_signature = (tuple(self.row_order), self.columns, self.capacity, self.column_pixel_width, self.view)
        repack = layout_signature != self.layout_signature
        if repack and self.context_menu:
            self.context_menu.popdown()
        for identity in set(self.focus_widgets) - set(self.row_order):
            self.release_row(self.focus_widgets.pop(identity))
        for row in rows:
            widget = self.focus_widgets.get(row["id"])
            if widget is None:
                self.focus_widgets[row["id"]] = self.session_row(row)
            else:
                self.update_session_row(widget, row)
        if repack:
            self.layout_signature = layout_signature
            for widget in self.focus_widgets.values():
                if widget.get_parent():
                    widget.get_parent().remove(widget)
            child = self.list_body.get_first_child()
            while child:
                following = child.get_next_sibling()
                if isinstance(child, Gtk.ListBox):
                    child.disconnect(child.asb_activation)
                self.list_body.remove(child)
                child = following
            for part in parts:
                listing = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE, activate_on_single_click=True,
                                      valign=Gtk.Align.START, hexpand=False, width_request=self.column_pixel_width)
                listing.add_css_class("asb-column")
                listing.asb_activation = listing.connect("row-activated", self.open_row)
                for row in part:
                    listing.append(self.focus_widgets[row["id"]])
                self.list_body.append(listing)
            if not rows:
                empty = label("No matching sessions. Change the search or filters." if self.dashboard.get("threads")
                              else "No desktop sessions found. Create a session, then refresh.", "dim-label")
                empty.set_wrap(True)
                empty.set_margin_top(24)
                self.list_body.append(empty)
        pending = sum(bool(row.get("pending")) for row in rows)
        self.count.set_label(f"{len(rows)} sessions · {pending} Pending")
        if repack or reveal_focus:
            GLib.idle_add(self.restore_position, focused, position, reveal_focus)

    def restore_position(self, focused, position, reveal_focus=False):
        if not self.closed:
            if focused in self.focus_widgets:
                if self.menu_button.get_active():
                    self.deferred_row_focus = focused
                else:
                    self.set_focus(self.focus_widgets[focused])
            adjustment = self.scroll.get_hadjustment()
            adjustment.set_value(min(position, max(0, adjustment.get_upper() - adjustment.get_page_size())))
            if reveal_focus and focused in self.focus_widgets and not self.menu_button.get_active():
                self.reveal_row(focused)
                self.list_body.add_tick_callback(self.reveal_after_layout, focused)
        return False

    def reveal_after_layout(self, _widget, _clock, identity):
        GLib.idle_add(self.reveal_row, identity)
        return False

    def reveal_row(self, identity):
        widget = self.focus_widgets.get(identity)
        if not widget or self.closed or not widget.get_width():
            return False
        found, bounds = widget.compute_bounds(self.list_body)
        if found:
            adjustment = self.scroll.get_hadjustment()
            left, right = bounds.origin.x, bounds.origin.x + bounds.size.width
            if left < adjustment.get_value():
                adjustment.set_value(left)
            elif right > adjustment.get_value() + adjustment.get_page_size():
                adjustment.set_value(right - adjustment.get_page_size())
        return False

    def settings_closed(self, *_args):
        identity, self.deferred_row_focus = self.deferred_row_focus, None
        if identity in self.focus_widgets:
            GLib.idle_add(self.restore_settings_focus, identity)

    def restore_settings_focus(self, identity):
        if not self.closed and not self.menu_button.get_popover().get_visible() and identity in self.focus_widgets:
            self.set_focus(self.focus_widgets[identity])
            self.reveal_row(identity)
        return False

    def outside_settings_pressed(self, gesture, _count, x, y):
        popover = self.menu_button.get_popover()
        if not popover.get_visible():
            return
        event = gesture.get_current_event()
        if event and event.get_surface() != self.get_surface():
            return
        for widget in (popover, self.menu_button):
            found, bounds = widget.compute_bounds(self)
            if found and bounds.origin.x <= x <= bounds.origin.x + bounds.size.width \
                    and bounds.origin.y <= y <= bounds.origin.y + bounds.size.height:
                return
        popover.popdown()
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def sync_unread_setting(self, value):
        if self.unread_setting_loading:
            return
        self.syncing_unread_setting = True
        self.persistent_unread.set_active(bool(value))
        self.syncing_unread_setting = False

    def change_unread_setting(self, *_args):
        if self.syncing_unread_setting or self.unread_setting_loading:
            return
        self.unread_setting_loading = True
        self.persistent_unread.set_sensitive(False)
        def finished(result, error):
            if not self.closed:
                self.unread_setting_loading = False
                self.persistent_unread.set_sensitive(True)
                self.unread_setting_error.set_label(error or "")
                if error:
                    self.sync_unread_setting((self.dashboard or {}).get("persistentUnread", False))
                else:
                    self.sync_unread_setting(result["persistentUnread"])
                    self.dashboard = result["dashboard"]
                    self.signature = self.dashboard.get("threads", [])
                    self.render()
                    self.refresh(True)
            return False
        request_async(self.base, "/api/settings/unread", finished, GLib.idle_add, "POST",
                      {"persistentUnread": self.persistent_unread.get_active()})

    def session_row(self, row):
        widget = Gtk.ListBoxRow(selectable=False)
        widget.add_css_class("asb-session")
        widget.asb_focus_key = row["id"]
        widget.asb_view = None
        widget.asb_handlers = []
        for controller, signals in (
                (Gtk.EventControllerKey(), (("key-pressed", self.row_key),)),
                (Gtk.EventControllerFocus(), (("enter", self.row_focus),)),
                (Gtk.GestureClick(button=3), (("pressed", self.row_context),)),
                (Gtk.DragSource(actions=Gdk.DragAction.MOVE), (("prepare", self.pin_drag_prepare),
                                                          ("drag-end", self.pin_drag_end))),
                (Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE), (("drop", self.pin_drop),))):
            handlers = [controller.connect(name, callback, row["id"]) for name, callback in signals]
            widget.asb_handlers.append((controller, handlers))
            widget.add_controller(controller)
        self.update_session_row(widget, row)
        return widget

    def release_row(self, widget):
        for controller, handlers in widget.asb_handlers:
            for handler in handlers:
                controller.disconnect(handler)
            widget.remove_controller(controller)
        widget.asb_handlers.clear()
        if widget.get_parent():
            widget.get_parent().remove(widget)

    def row_focus(self, _controller, identity):
        self.focused_id = identity

    def row_context(self, gesture, _count, x, y, identity):
        widget = self.focus_widgets.get(identity)
        if widget:
            self.show_context(widget, x, y, gesture)

    def pin_drag_end(self, *_args):
        self.drag_identity = None

    def update_session_row(self, widget, row):
        layout_changed = widget.asb_view != self.view
        if not layout_changed and widget.asb_thread == row:
            return
        widget.asb_thread = dict(row)
        widget.set_activatable(bool(row.get("canOpen")))
        if layout_changed:
            widget.asb_view = self.view
            for name in ("asb_folder", "asb_pin", "asb_age_label"):
                if hasattr(widget, name):
                    delattr(widget, name)
            content = Gtk.Box(spacing=6, margin_start=5, margin_end=5, valign=Gtk.Align.CENTER)
            mark = Gtk.Image(pixel_size=14)
            mark.add_css_class("asb-provider")
            widget.asb_mark = mark
            title = label("")
            title.set_single_line_mode(True)
            title.set_ellipsize(Pango.EllipsizeMode.END)
            title.set_hexpand(True)
            widget.asb_title_label = title
            dot = Gtk.Box(valign=Gtk.Align.CENTER)
            dot.add_css_class("asb-dot")
            widget.asb_dot = dot
            state = label("", "asb-state")
            widget.asb_state_label = state
            if self.view == "comfortable":
                content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin_start=8,
                                  margin_end=8, margin_top=2, margin_bottom=2, valign=Gtk.Align.CENTER)
                workspace = Gtk.Box(spacing=7)
                workspace.append(mark)
                folder = label("", "caption")
                folder.add_css_class("dim-label")
                folder.set_ellipsize(Pango.EllipsizeMode.END)
                folder.set_hexpand(True)
                widget.asb_folder = folder
                workspace.append(folder)
                pin = Gtk.Image(icon_name="view-pin-symbolic", pixel_size=11)
                pin.add_css_class("dim-label")
                widget.asb_pin = pin
                workspace.append(pin)
                content.append(workspace)
                title.set_single_line_mode(False)
                title.set_wrap(True)
                title.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
                title.set_lines(2)
                title.set_size_request(-1, 32)
                title.set_margin_start(21)
                content.append(title)
                metadata = Gtk.Box(spacing=6, margin_start=21)
                metadata.append(dot)
                metadata.append(state)
                age = label("", "caption")
                age.add_css_class("dim-label")
                age.set_ellipsize(Pango.EllipsizeMode.END)
                age.set_hexpand(True)
                age.set_halign(Gtk.Align.END)
                widget.asb_age_label = age
                metadata.append(age)
                content.append(metadata)
            else:
                for child in (mark, title, dot, state):
                    content.append(child)
            widget.set_child(content)
        widget.asb_mark.set_from_icon_name("asb-openai-symbolic" if row["provider"] == "codex" else "asb-claude-symbolic")
        widget.asb_dot.set_visible(bool(row.get("unread") or row.get("questionAttention")))
        state = widget.asb_state_label
        for css in (*("asb-" + value for value in STATES), "success", "warning", "dim-label"):
            state.remove_css_class(css)
        state.add_css_class("asb-" + row.get("state", "unknown"))
        if row.get("state") == "working":
            state.add_css_class("success")
        elif row.get("state") == "waiting":
            state.add_css_class("warning")
        elif not row.get("pending"):
            state.add_css_class("dim-label")
        if self.view == "comfortable":
            widget.asb_folder.set_label(row.get("projectName") or "No project")
            widget.asb_pin.set_visible(bool(row.get("pinned")))
        widget.asb_time_signature = None
        self.update_row_text(widget)

    def update_clock(self):
        if self.closed:
            return False
        now_ms = time.time() * 1000
        for widget in self.focus_widgets.values():
            self.update_row_text(widget, now_ms)
        return True

    def update_row_text(self, widget, now_ms=None):
        row = widget.asb_thread
        duration = working_duration(row, now_ms)
        meta = row_meta(row, now_ms)
        signature = (duration, meta)
        if signature == widget.asb_time_signature:
            return
        widget.asb_time_signature = signature
        widget.asb_duration = duration
        state_text = row.get("state", "unknown").capitalize()
        widget.asb_state_label.set_label(state_text + (" ·" + duration if self.view == "compact" and duration else ""))
        if self.view == "comfortable":
            widget.asb_age_label.set_label(duration or row_meta(row, now_ms, relative=True).split(" · ")[1])
        if row.get("retainedUnread"):
            read = "ASB retained this unread attention. Use Read in the row menu to clear it."
        elif row.get("manualUnread"):
            read = "Marked as unread in ASB. This mark does not change the original app read state."
        elif row.get("questionAttention"):
            read = "A question needs your answer. Its attention can be read in ASB."
        elif row.get("completionAttention"):
            read = "ASB observed a completed task. The original app read state is unknown."
        elif row.get("nativeAttention"):
            read = "Original app unread state."
        elif row.get("questionPending"):
            read = "Question attention read in ASB. The source question remains unresolved."
        elif row.get("nativeUnread") and not row.get("nativeAttention"):
            read = "Read in ASB. The original app unread state remains unchanged."
        elif row.get("readStatus") == "unread" or row.get("pendingSource") == "native-unread":
            read = "Original app unread state."
        elif row.get("pendingSource") == "observed-completion":
            read = "ASB observed a completed task. The original app read state is unknown."
        elif row.get("readStatus", "unknown") == "unknown":
            read = "Original app read state is unknown."
        else:
            read = "The original app marks this session as read."
        details = [row.get("title", ""), row.get("cwd") or "No project path", row.get("providerLabel", ""), row_meta(row, now_ms),
                   row.get("reason", ""), read]
        if row.get("pinned"):
            details.append("Pinned in ASB. Drag to reorder, or use the row menu.")
        if not row.get("canOpen"):
            details.append("This session has no direct desktop link.")
        widget.asb_tooltip = "\n".join(filter(None, details))
        action = "Open" if row.get("canOpen") else "Session"
        manual = " Marked as unread in ASB." if row.get("manualUnread") else ""
        native_unread = " Unread in the original app." if row.get("nativeAttention") else ""
        pinned = " Pinned in ASB." if row.get("pinned") else ""
        question = " Question needs your answer." if row.get("questionAttention") else ""
        retained = " Unread retained in ASB. Use Read to clear it." if row.get("retainedUnread") else ""
        widget.asb_accessible_label = f"{action} {row.get('title', 'Untitled session')} in {row.get('providerLabel', '')}. {state_text}.{manual}{native_unread}{pinned}{question}{retained}"
        self.update_open_state(widget)

    def row_key(self, _controller, key, _code, _state, identity):
        if _state & SHORTCUT_MASK:
            return False
        if key == Gdk.KEY_Menu or (key == Gdk.KEY_F10 and _state & Gdk.ModifierType.SHIFT_MASK):
            self.show_context(self.focus_widgets[identity])
            return True
        if key not in (Gdk.KEY_Up, Gdk.KEY_Down, Gdk.KEY_Left, Gdk.KEY_Right, Gdk.KEY_Home, Gdk.KEY_End):
            return False
        index = self.row_order.index(identity)
        delta = {Gdk.KEY_Up: -1, Gdk.KEY_Down: 1, Gdk.KEY_Left: -self.capacity, Gdk.KEY_Right: self.capacity}.get(key, 0)
        target = 0 if key == Gdk.KEY_Home else len(self.row_order) - 1 if key == Gdk.KEY_End else max(0, min(len(self.row_order) - 1, index + delta))
        self.focus_widgets[self.row_order[target]].grab_focus()
        self.reveal_row(self.row_order[target])
        return True

    def show_context(self, widget, x=None, y=None, gesture=None):
        if self.context_menu:
            self.context_menu.popdown()
        widget.grab_focus()
        model = Gio.Menu()
        actions = row_menu_actions(widget.asb_thread)
        for title, action in actions:
            item = Gio.MenuItem.new(title, None)
            item.set_action_and_target_value("win." + action, GLib.Variant("s", widget.asb_thread["id"]))
            model.append_item(item)
        menu = Gtk.PopoverMenu.new_from_model(model)
        menu.set_parent(widget)
        if x is not None:
            rectangle = Gdk.Rectangle()
            rectangle.x, rectangle.y, rectangle.width, rectangle.height = int(x), int(y), 1, 1
            menu.set_pointing_to(rectangle)
        def closed(popup):
            GLib.idle_add(popup.unparent)
            if self.context_menu is popup:
                self.context_menu = None
        menu.connect("closed", closed)
        self.context_menu = menu
        menu.popup()
        if gesture:
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def mark_unread(self, identity):
        self.session_action(identity, "mark-unread")

    def row_action(self, _action, target, name):
        identity = target.get_string()
        if name in ("pin-up", "pin-down"):
            self.session_action(identity, "move-pin", {"direction": "up" if name == "pin-up" else "down"})
        elif name == "mark-unread":
            self.mark_unread(identity)
        else:
            self.session_action(identity, name)

    def session_action(self, identity, action, body=None):
        def finished(result, error):
            if not self.closed:
                if error:
                    self.open_errors[identity] = error
                    current = self.focus_widgets.get(identity)
                    if current:
                        self.update_open_state(current)
                if not error:
                    if result.get("thread"):
                        self.dashboard["threads"] = [result["thread"] if row["id"] == identity else row for row in self.dashboard["threads"]]
                    if "pinnedOrder" in result:
                        order = result["pinnedOrder"]
                        self.dashboard["pinnedOrder"] = order
                        for row in self.dashboard["threads"]:
                            row["pinned"] = row["id"] in order
                            row["pinIndex"] = order.index(row["id"]) if row["id"] in order else -1
                    self.render()
                    self.refresh(True)
            return False
        request_async(self.base, "/api/threads/" + quote(identity, safe="") + "/" + action, finished, GLib.idle_add, "POST", body)

    def pin_drag_prepare(self, _source, _x, _y, identity):
        row = self.focus_widgets.get(identity)
        if not row or not row.asb_thread.get("pinned") or identity in self.opening:
            return None
        self.drag_identity = identity
        return Gdk.ContentProvider.new_for_value(GObject.Value(GObject.TYPE_STRING, "asb-pin:" + identity))

    def pin_drop(self, _target, value, _x, y, identity):
        source = value.removeprefix("asb-pin:") if isinstance(value, str) and value.startswith("asb-pin:") else None
        known = {row["id"] for row in self.dashboard["threads"] if row.get("pinned")}
        if not source or source != self.drag_identity or source == identity or source not in known or identity not in known:
            return False
        height = self.focus_widgets[identity].get_height()
        self.session_action(source, "move-pin", {"targetId": identity, "placement": "after" if y >= height / 2 else "before"})
        self.drag_identity = None
        return True

    def update_open_state(self, widget):
        row = widget.asb_thread
        opening = row["id"] in self.opening
        error = self.open_errors.get(row["id"], "")
        widget.asb_title_label.set_label("Opening…" if opening else row.get("title", "Untitled session"))
        widget.set_sensitive(not opening)
        duration = widget.asb_duration
        widget.set_tooltip_text(widget.asb_tooltip + ("\nWorking time: " + duration if duration else "") + ("\n" + error if error else ""))
        name = "Opening " + widget.asb_accessible_label.removeprefix("Open ") if opening else widget.asb_accessible_label
        if duration:
            name += " Working time " + duration + "."
        widget.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION], [name, error])
        widget.update_state([Gtk.AccessibleState.BUSY], [opening])

    def open_row(self, _listing, widget):
        row = widget.asb_thread
        if not row.get("canOpen") or row["id"] in self.opening:
            return
        self.opening.add(row["id"])
        self.open_errors.pop(row["id"], None)
        self.update_open_state(widget)
        def finished(_result, error):
            if not self.closed:
                self.opening.discard(row["id"])
                if error:
                    self.open_errors[row["id"]] = error
                current = self.focus_widgets.get(row["id"])
                if current:
                    self.update_open_state(current)
                if not error:
                    self.refresh(True)
            return False
        request_async(self.base, "/api/threads/" + quote(row["id"], safe="") + "/open", finished, GLib.idle_add, "POST")

    def on_close(self, *_args):
        self.closed = True
        self.events.close()
        for name in ("timer", "clock_timer", "geometry_idle"):
            source = getattr(self, name)
            if source:
                GLib.source_remove(source)
                setattr(self, name, None)
        if self.surface_signal:
            self.layout_surface.disconnect(self.surface_signal)
            self.surface_signal = self.layout_surface = None
        if self.context_menu:
            self.context_menu.popdown()
        for widget in self.focus_widgets.values():
            self.release_row(widget)
        self.focus_widgets.clear()
        Gtk.StyleContext.remove_provider_for_display(self.get_display(), self.css)
        return False


class SwitchboardApplication(Adw.Application):
    def __init__(self, base):
        GLib.set_prgname(APP_ID)
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.get_style_manager().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        self.base = base
        self.connect("activate", self.on_activate)

    def on_activate(self, *_args):
        window = self.get_active_window()
        if window is None:
            window = SwitchboardWindow(self, self.base)
        window.present()


def main():
    try:
        base = local_base_url(sys.argv[1] if len(sys.argv) == 2 else "")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    GLib.set_application_name("ASB · Agent Switch Board")
    application = SwitchboardApplication(base)
    for sig in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig,
                             lambda: (application.get_active_window().close() if application.get_active_window()
                                      else application.quit()) or False)
    return application.run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())
