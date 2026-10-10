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
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

LOCAL_HTTP = build_opener(ProxyHandler({}))
ROW_HEIGHT = 22
COMFORTABLE_ROW_HEIGHT = 68
DEFAULT_COLUMN_WIDTH = 240
APP_ID = "local.asb.AgentSwitchBoard"
STATES = ("working", "waiting", "idle", "unknown")
SOURCE_PROVIDERS = ("codex", "claude-desktop-code")
SOURCE_COLOR_PRESETS = (("Slate blue", "#8296b4"), ("Clay", "#b28f80"), ("Plum", "#a28caa"), ("Sage", "#899e91"))


def source_marker_color(row):
    count = row.get("sourceCount")
    if type(count) is not int or count <= 1 or row.get("sourceShowMarker", True) is not True:
        return ""
    try:
        return validate_source_color(row.get("sourceColor"))
    except ValueError:
        return ""


def source_form_body(provider, name, data_dir, launcher, enabled, identity="", projects_dir="", color=None, show_marker=None):
    if provider not in SOURCE_PROVIDERS or type(enabled) is not bool:
        raise ValueError("Choose an app and its Enabled setting.")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or re.search(r"[\x00-\x1f\x7f]", name):
        raise ValueError("Name must have 1–80 characters with no control characters.")
    if identity and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", identity):
        raise ValueError("The app source ID is not valid. Refresh the source list.")
    source = {"provider": provider, "label": name.strip(), "enabled": enabled}
    for key, title, value, optional in (("dataDir", "Session folder", data_dir, False),
                                       ("launcher", "Open with", launcher, True),
                                       ("projectsDir", "Transcript folder", projects_dir, True)):
        if key == "projectsDir" and provider != "claude-desktop-code":
            continue
        if not isinstance(value, str) or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError(f"{title} must have no control characters.")
        value = os.path.expanduser(value.strip())
        if not value and optional:
            if key == "launcher":
                source[key] = ""
            continue
        if not Path(value).is_absolute():
            raise ValueError(f"{title} must be an absolute local path. You can use ~/.")
        source[key] = value
    if identity:
        source["id"] = identity
    if color is not None:
        source["color"] = validate_source_color(color)
    if show_marker is not None:
        if type(show_marker) is not bool:
            raise ValueError("Choose the Show profile dot setting.")
        source["showMarker"] = show_marker
    return {"source": source}


def refresh_interval(dashboard):
    value = dashboard.get("refreshIntervalMs")
    return value if type(value) is int and value in (2000, 5000) else 5000


def row_menu_actions(row):
    actions = [] if row.get("actionRequired") else [("Read", "mark-read")
               if row.get("drawer") or attention_indicator(row) in ("question", "dot") else ("Unread", "mark-unread")]
    if row.get("drawer"):
        actions.append(("Take out of drawer", "drawer-out"))
    elif attention_indicator(row) == "dot":
        actions.append(("Put in drawer", "drawer-in"))
    actions.append(("Unpin", "unpin") if row.get("pinned") else ("Pin", "pin"))
    if row.get("pinned"):
        actions.extend((("Move pin earlier", "pin-up"), ("Move pin later", "pin-down")))
    if row.get("state") == "working":
        actions.append(("Keep result", "keep-result") if row.get("discardResult") else ("Discard result", "discard-result"))
    return actions


def pin_move_body(rows, identity, direction):
    """Return the move-pin body for the visible pinned neighbor, or None at the end of the visible pins."""
    pins = [row["id"] for row in rows if row.get("pinned")]
    target = pins.index(identity) + (-1 if direction == "up" else 1) if identity in pins else -1
    return {"targetId": pins[target], "placement": "before" if direction == "up" else "after"} if 0 <= target < len(pins) else None


def attention_signature(row):
    return tuple(row.get(key) for key in ("unread", "questionAttention", "nativeUnread", "manualUnread",
                 "nativeAttention", "completionAttention", "failedAttention", "retainedUnread", "retainedUnreadSource",
                 "completionAtMs", "failedAtMs", "lastOutcome", "actionRequired", "discardResult", "updatedAtMs", "state", "workingSinceMs", "questionPending", "drawer"))


def attention_indicator(row, drawer=False):
    """Return the row mark in question, unread, discard, then stopped order. With drawer, a drawer row shows its stored unread mark."""
    return "question" if row.get("actionRequired") or row.get("questionAttention") else "dot" \
        if row.get("unread") or (drawer and row.get("drawer") and row.get("state") != "working") \
        else "discard" if row.get("state") == "working" and row.get("discardResult") \
        else "stop" if row.get("state") == "idle" and row.get("lastOutcome") == "stopped" else ""


def ignore_discard_after_read(action, last_read_at, now=None):
    now = time.monotonic() if now is None else now
    return action in ("discard-result", "keep-result") and last_read_at is not None and now - last_read_at < .5


def provider_query(query, app="all"):
    match = re.match(r"^\s*(cl|claude|cx|codex)\s*:\s*(.*)$", query, re.IGNORECASE | re.DOTALL)
    if match:
        app = "claude-desktop-code" if match[1].lower() in ("cl", "claude") else "codex"
        query = match[2]
    return query.strip().casefold(), app


def filtered_rows(dashboard, query="", app="all", state="all", archived=False, pending_only=False, drawer_only=False):
    query, app = provider_query(query, app)
    states = set(STATES) if state == "all" else {state} if isinstance(state, str) else set(state)
    working_or_unread = pending_only and states == {"working"}
    rows = [row for row in dashboard.get("threads", [])
            if (archived or not row.get("archived"))
            and (not drawer_only or row.get("drawer"))
            and (app == "all" or row.get("provider") == app)
            and ((row.get("state") == "working" or row.get("pending") or row.get("unread") or row.get("questionAttention"))
                 if working_or_unread else row.get("state") in states and (not pending_only or row.get("pending")))
            and (not query or query in "\n".join(str(row.get(key, "")) for key in
                 ("title", "projectName", "cwd", "providerLabel", "sourceLabel")).casefold())]
    def bucket(row):
        if row.get("pending") or row.get("state") == "waiting":
            return 0
        return {"working": 1, "idle": 2, "unknown": 3}.get(row.get("state"), 3)
    def moment(row):
        # Output changes updatedAtMs at each scan; the task start keeps a Working row in its place.
        if row.get("state") != "working":
            return row.get("updatedAtMs", 0)
        start = row.get("workingSinceMs")
        return start if type(start) in (int, float) and start > 0 else 0
    rows.sort(key=lambda row: (0, row.get("pinIndex", 0), row["id"]) if row.get("pinned") else
              (1, bucket(row), row.get("state") != "working", -moment(row), row["id"]))
    return rows


def pack_columns(rows, width, height, column_width=DEFAULT_COLUMN_WIDTH, row_height=ROW_HEIGHT):
    columns = max(1, (width + 12) // (column_width + 12))
    capacity = max(1, (height - 4) // row_height)
    parts = [rows[start:start + capacity] for start in range(0, len(rows), capacity)]
    return columns, capacity, parts


THEME_KEYS = ("background", "text", "accent", "muted", "divider")
THEME_PATH = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "asb" / "theme.json"
LAYOUT_PATH = THEME_PATH.with_name("layout.json")


def motion_allowed(previous, current, animations, mapped):
    # The first render and a change of columns, capacity, column width, or view show the result at once.
    return bool(animations and mapped and previous is not None and previous[1:5] == current[1:5])


def motion_offsets(old, new):
    """Paint offsets (x, y, missing opacity) from the old painted places; a card with no old place fades in."""
    offsets = {}
    for identity, place in new.items():
        before = old.get(identity)
        offset = (before[0] - place[0], before[1] - place[1], before[2]) if before else (0, 0, 1)
        if any(offset):
            offsets[identity] = offset
    return offsets


def luminance(color):
    channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return sum((value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4) * weight
               for value, weight in zip(channels, (.2126, .7152, .0722)))


def contrast(first, second):
    light, dark = sorted((luminance(first), luminance(second)), reverse=True)
    return (light + .05) / (dark + .05)


def mix_color(background, foreground, fraction):
    return "#" + "".join(f"{round(int(background[start:start + 2], 16) * (1 - fraction) + int(foreground[start:start + 2], 16) * fraction):02x}"
                         for start in (1, 3, 5))


def validate_source_color(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("Profile color must use a #RRGGBB value.")
    return value.lower()


def display_source_color(color, surfaces):
    for percent in range(101):
        displayed = mix_color(color, "#ffffff", percent / 100)
        if all(contrast(displayed, surface) >= 3 for surface in surfaces):
            return displayed
    return ""


def highlight_color(colors):
    return mix_color(colors["background"], colors["accent"], .15)


def quiet_color(colors, key, fraction, highlight):
    surfaces = (colors["background"], highlight)
    for percent in range(round(fraction * 100), 101):
        color = mix_color(colors["background"], colors[key], percent / 100)
        if all(contrast(color, surface) >= 4.5 for surface in surfaces):
            return color, percent / 100
    return colors[key], 1


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


def row_meta(row, now_ms=None):
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
    else:
        date = f"{int(age / 86_400_000)}d ago"
    parts = [str(row.get("state", "unknown")).capitalize(), date]
    if row.get("pinned"):
        parts.append("Pinned")
    if row.get("archived"):
        parts.append("Archived")
    return " · ".join(parts)


def tooltip_model(row, now_ms, home_dir, error="", drawer_view=False):
    full_path = row.get("cwd") or row.get("projectName") or "No project folder"
    path = full_path
    home = str(Path(home_dir))
    if path == home:
        path = "~"
    elif path.startswith(home.rstrip("/") + "/"):
        path = "~" + path[len(home.rstrip("/")):]
    state = row.get("state", "unknown")
    state = state if state in STATES else "unknown"
    state_text = state.capitalize() + " · " + (working_duration(row, now_ms) or row_meta(row, now_ms).split(" · ")[1])
    provider = row.get("providerLabel") or {"codex": "Codex", "claude-desktop-code": "Claude Desktop Code"}.get(row.get("provider"), "Unknown app")
    source_label, source_id = row.get("sourceLabel", ""), row.get("sourceId", "")
    app = provider + (" · " + source_label if source_label and source_label != provider else "")
    indicator = attention_indicator(row, True)
    # A drawer row has its unread note in each view, and its dot only where the row shows it.
    shape = "" if indicator == "dot" and not row.get("unread") and not drawer_view else indicator
    note = ""
    if indicator == "question":
        note = "Waits for your permission." if row.get("actionRequired") else "Asks a question. Open the chat to answer."
    elif indicator == "dot":
        source = row.get("pendingSource", "")
        dot_notes = {"manual-unread": "Marked unread in ASB.", "native-unread": "Unread in the original app.",
                     "observed-completion": "Finished. Not read yet.", "observed-failure": "Failed. Not read yet."}
        if source in dot_notes:
            note = dot_notes[source]
            if row.get("retainedUnread") and ((source == "native-unread" and not row.get("nativeAttention"))
                                             or (source == "observed-completion" and not row.get("completionAttention"))):
                note = "Unread kept in ASB. Use Read to clear it."
        elif row.get("retainedUnread") and source:
            note = "Unread kept in ASB. Use Read to clear it."
        elif row.get("manualUnread"):
            note = "Marked unread in ASB."
        elif row.get("failedAttention"):
            note = "Failed. Not read yet."
        elif row.get("nativeAttention"):
            note = "Unread in the original app."
        elif row.get("completionAttention"):
            note = "Finished. Not read yet."
        else:
            note = "Unread kept in ASB. Use Read to clear it."
    elif indicator == "stop":
        note = "You stopped this task."
    elif indicator == "discard":
        note = "Discard is on for this task."
    elif row.get("questionPending"):
        note = "A question is still open in the chat."
    flags = " · ".join(text for key, text in (("pinned", "Pinned"), ("archived", "Archived"), ("drawer", "In the drawer")) if row.get(key))
    if not row.get("canOpen"):
        flags += (" · " if flags else "") + "No direct link"
    source = "App source: " + (source_label or source_id) if source_label or source_id else ""
    if source_label and source_id:
        source += " (" + source_id + ")"
    app_color = source_marker_color(row)
    if app_color:
        source += (". " if source else "") + "Profile color marker: " + app_color
    return {"path": path, "full_path": full_path, "title": row.get("title") or "Untitled session",
            "state": state, "state_text": state_text, "app": app, "app_color": app_color,
            "indicator": shape, "note": note, "flags": flags, "error": error,
            "reason": row.get("reason", ""), "source": source}


def tooltip_description(model):
    return "\n".join(filter(None, (model["title"], model["full_path"], model["state_text"], model["app"],
                                  model["reason"], model["source"], model["note"], model["flags"], model["error"])))


def local_base_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port \
            or parsed.username or parsed.password or parsed.path not in ("", "/") \
            or parsed.query or parsed.fragment:
        raise ValueError("Use the local ASB address: http://127.0.0.1:<port>.")
    return value.rstrip("/")


SOURCE_TOKEN = os.environ.get("ASB_SOURCE_TOKEN", "")


def request_json(base, route, method="GET", body=None, etag=None):
    headers = {"Accept": "application/json"}
    data = None
    if etag and etag[0] and method == "GET" and route.split("?")[0] == "/api/dashboard":
        headers["If-None-Match"] = etag[0]
    if method == "POST":
        headers.update({"Origin": base, "Content-Type": "application/json"})
        if SOURCE_TOKEN and (route == "/api/sources" or route.startswith("/api/sources/")):
            headers["X-ASB-Source-Token"] = SOURCE_TOKEN
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
        if etag is not None:
            etag[0] = response.headers.get("ETag")
        return result
    except (HTTPError, URLError, HTTPException, OSError, ValueError) as error:
        if isinstance(error, HTTPError) and error.code == 304 and "If-None-Match" in headers:
            error.close()
            return None
        if route == "/api/sources" or route.startswith("/api/sources/"):
            detail = ""
            if isinstance(error, HTTPError):
                try:
                    payload = json.loads(error.read(8192))
                    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                        detail = payload["error"]
                except (HTTPException, OSError, ValueError):
                    pass
            raise RuntimeError(detail or "Cannot load or change app sources. Check that ASB is running, then try again.") from error
        action = "open this session" if route.endswith("/open") else "change the unread setting" if route == "/api/settings/unread" \
            else "change this session" if method == "POST" else "load sessions"
        recovery = "Check the app link handler, then try again." if route.endswith("/open") \
            else "Check that ASB is running, then try again." if route == "/api/settings/unread" \
            else "Refresh the session list, then try again." if method == "POST" else "Check that ASB is running, then refresh."
        raise RuntimeError(f"Cannot {action}. {recovery}") from error


def request_async(base, route, callback, dispatch, method="GET", body=None, etag=None):
    def work():
        try:
            result, error = request_json(base, route, method, body, etag), None
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
                    with self.lock:
                        if self.stopped.is_set():
                            break
                        self.socket.settimeout(None)
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
    gi.require_version("Gsk", "4.0")
    gi.require_version("Graphene", "1.0")
    from gi.repository import Adw, Gdk, Gio, GLib, GObject, Graphene, Gsk, Gtk, Pango
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


class ShrinkLabel(Gtk.Label):
    def do_measure(self, orientation, for_size):
        minimum, natural, *baselines = Gtk.Label.do_measure(self, orientation, for_size)
        # The five pills fit a 320 px window only when this text can go to no width.
        return (0, natural, -1, -1) if orientation == Gtk.Orientation.HORIZONTAL else (minimum, natural, *baselines)


class SessionStrip(Gtk.Box):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.hover_rect = self.hover_target = self.hover_from = self.hover_to = None
        self.hover_alpha = 0
        self.motion, self.motion_progress = {}, 0
        target = Adw.CallbackAnimationTarget.new(self.advance_hover)
        self.hover_animation = Adw.TimedAnimation.new(self, 0, 1, 200, target)
        self.hover_animation.set_easing(Adw.Easing.EASE_OUT_EXPO)
        self.connect("unmap", self.clear_hover)

    def show_hover(self, rectangle):
        if rectangle == self.hover_target:
            return
        self.hover_animation.pause()
        self.hover_target = rectangle
        start = self.hover_rect if self.hover_alpha > 0 else rectangle
        end = rectangle or start
        if end is None:
            self.clear_hover()
            return
        self.hover_from = (*start, self.hover_alpha)
        self.hover_to = (*end, 1 if rectangle else 0)
        self.add_css_class("asb-hover-paint")
        self.hover_animation.set_duration(200 if start != end else 100)
        self.hover_animation.reset()
        if self.get_settings().get_property("gtk-enable-animations"):
            self.hover_animation.play()
        else:
            self.advance_hover(1)

    def advance_hover(self, value):
        if self.hover_from is None:
            return
        frame = tuple(start + (end - start) * value for start, end in zip(self.hover_from, self.hover_to))
        self.hover_alpha = frame[4]
        self.hover_rect = frame[:4] if self.hover_alpha > 0 else None
        if self.hover_target is None and self.hover_alpha <= 0:
            self.hover_from = self.hover_to = None
            self.remove_css_class("asb-hover-paint")
        self.queue_draw()

    def clear_hover(self, *_args):
        if self.hover_rect is None and self.hover_target is None and self.hover_from is None:
            return
        self.hover_rect = self.hover_target = self.hover_from = self.hover_to = None
        self.hover_alpha = 0
        self.hover_animation.reset()
        self.remove_css_class("asb-hover-paint")
        self.queue_draw()

    def do_snapshot(self, snapshot):
        if self.hover_rect and self.hover_alpha > 0:
            colors = self.get_root().hover_colors
            if colors:
                color = Gdk.RGBA()
                color.parse(highlight_color(colors))
            else:
                found, color = self.get_style_context().lookup_color("window_fg_color")
                color = (color if found else self.get_color()).copy()
                color.alpha *= .07
            color.alpha *= self.hover_alpha
            bounds = Graphene.Rect()
            bounds.init(*self.hover_rect)
            rounded = Gsk.RoundedRect()
            rounded.init_from_rect(bounds, 3)
            snapshot.push_rounded_clip(rounded)
            snapshot.append_color(color, bounds)
            snapshot.pop()
        Gtk.Box.do_snapshot(self, snapshot)


class SessionColumn(Gtk.ListBox):
    def do_measure(self, orientation, for_size):
        minimum, natural, *baselines = Gtk.ListBox.do_measure(self, orientation, for_size)
        # Long titles must not let spare strip width make a column wider than the shared width.
        return (minimum, minimum, -1, -1) if orientation == Gtk.Orientation.HORIZONTAL else (minimum, natural, *baselines)

    def in_viewport(self):
        window = self.get_root()
        viewport = window.scroll.get_child()
        found, bounds = self.compute_bounds(viewport)
        if not found:
            return True
        left, right = bounds.origin.x, bounds.origin.x + bounds.size.width
        if self.get_parent().motion_progress:
            motion = getattr(window, "motion_bounds", {}).get(self)
            if motion:
                position = window.scroll.get_hadjustment().get_value()
                left, right = min(left, motion[0] - position), max(right, motion[1] - position)
        return right > 0 and left < viewport.get_width()

    def do_snapshot(self, snapshot):
        # Card motion is paint only: the column moves the whole row box, so allocation, input, and focus keep the final layout.
        strip = self.get_parent()
        self.asb_snapshot_skipped = not self.in_viewport()
        if self.asb_snapshot_skipped:
            return
        motion, progress = strip.motion, strip.motion_progress
        child = self.get_first_child()
        while child:
            offset = motion.get(child.asb_focus_key) if progress else None
            if offset:
                snapshot.save()
                snapshot.translate(Graphene.Point().init(offset[0] * progress, offset[1] * progress))
                if offset[2]:
                    snapshot.push_opacity(1 - offset[2] * progress)
                self.snapshot_child(child, snapshot)
                if offset[2]:
                    snapshot.pop()
                snapshot.restore()
            else:
                self.snapshot_child(child, snapshot)
            child = child.get_next_sibling()


class ColumnScroll(Gtk.ScrolledWindow):
    after_layout = None

    def do_measure(self, orientation, for_size):
        # Row count follows viewport height; it must not set the window's minimum height.
        if orientation == Gtk.Orientation.VERTICAL:
            return 0, 0, -1, -1
        minimum, natural, *_ = Gtk.ScrolledWindow.do_measure(self, orientation, for_size)
        return minimum, natural, -1, -1

    def do_size_allocate(self, width, height, baseline):
        Gtk.ScrolledWindow.do_size_allocate(self, width, height, baseline)
        # New row places are known here, after allocation and before the paint of the same frame.
        if self.after_layout:
            self.after_layout()


class SourceMarker(Gtk.Box):
    def __init__(self, owner, color=""):
        super().__init__(halign=Gtk.Align.START, valign=Gtk.Align.END, can_target=False)
        self.owner = owner
        self.add_css_class("asb-source-badge")
        self.style_provider = Gtk.CssProvider()
        self.get_style_context().add_provider(self.style_provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
        self.set_color(color)

    def set_color(self, color):
        try:
            self.configured_color = validate_source_color(color)
        except ValueError:
            self.configured_color = ""
        displayed = display_source_color(self.configured_color, self.owner.profile_surfaces) if self.configured_color else ""
        self.set_visible(bool(displayed))
        css = ""
        if displayed:
            background, highlight = self.owner.profile_surfaces
            css = f""".asb-source-badge {{ background: {displayed}; border-color: {background}; }}
.asb-session:hover .asb-source-badge, .asb-session:focus-within .asb-source-badge {{ border-color: {highlight}; }}"""
        if css != getattr(self, "rendered_css", None):
            self.style_provider.load_from_string(css)
            self.rendered_css = css


class AppSourcesWindow(Adw.Window):
    def __init__(self, owner):
        super().__init__(application=owner.get_application(), transient_for=owner, destroy_with_parent=True,
                         title="App sources", default_width=890, default_height=700)
        self.owner, self.base = owner, owner.base
        self.closed = self.loading = self.choosing = self.loaded = self.editing = False
        self.sources, self.max_sources, self.editing_id = [], 8, ""
        self.preset_markers, self.table_markers = [], []
        self.cancellable = Gio.Cancellable()
        self.add_css_class("asb-column-flow")
        if owner.hover_colors:
            self.add_css_class("asb-custom")
        self.connect("close-request", self.on_close)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        body.append(Adw.HeaderBar())
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, vexpand=True,
                          margin_start=16, margin_end=16, margin_bottom=16)
        body.append(content)
        self.message = label("Loading app sources…", "caption")
        self.message.set_wrap(True)
        self.message.set_selectable(True)
        content.append(self.message)
        self.table = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE)
        self.table.connect("row-selected", self.selected_source)
        table_body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        table_body.append(self.table_line(["Enabled", "Name / App", "Session folder", "Open with", "Chats / Status"]))
        table_body.append(self.table)
        content.append(Gtk.ScrolledWindow(child=table_body, vexpand=True, min_content_height=180,
                                         hscrollbar_policy=Gtk.PolicyType.AUTOMATIC,
                                         vscrollbar_policy=Gtk.PolicyType.AUTOMATIC))
        self.form = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        content.append(self.form)
        self.form_title = label("Select an app source", "heading")
        self.form.append(self.form_title)
        self.source_id = label("", "caption")
        self.source_id.set_selectable(True)
        self.form.append(self.source_id)
        grid = Gtk.Grid(column_spacing=12, row_spacing=8)
        self.form.append(grid)
        self.provider = Gtk.DropDown.new_from_strings(["Codex", "Claude Desktop Code"])
        self.provider.connect("notify::selected", self.provider_changed)
        self.name, self.data_dir, self.launcher, self.projects_dir = (Gtk.Entry(hexpand=True) for _ in range(4))
        self.name.set_max_length(80)
        self.projects_dir.set_placeholder_text("Default: ~/.claude/projects")
        self.launcher.set_placeholder_text("Installed app launcher required")
        self.transcript_widgets = []
        for index, (title, widget, folder) in enumerate((("App", self.provider, None), ("Name", self.name, None),
                ("Session folder", self.data_dir, True), ("Open with", self.launcher, False),
                ("Transcript folder", self.projects_dir, True))):
            caption = label(title)
            caption.set_mnemonic_widget(widget)
            widget.update_property([Gtk.AccessibleProperty.LABEL], [title])
            grid.attach(caption, 0, index, 1, 1)
            grid.attach(widget, 1, index, 1, 1)
            widgets = [caption, widget]
            if folder is not None:
                choose = Gtk.Button(label="Choose…", tooltip_text="Choose " + title.lower())
                choose.update_property([Gtk.AccessibleProperty.LABEL], ["Choose " + title.lower()])
                choose.connect("clicked", lambda _button, entry=widget, directory=folder: self.choose_path(entry, directory))
                grid.attach(choose, 2, index, 1, 1)
                widgets.append(choose)
            if widget is self.projects_dir:
                self.transcript_widgets = widgets
        self.source_color = Gtk.ColorDialogButton.new(Gtk.ColorDialog(title="Profile color", with_alpha=False))
        for accessible in (self.source_color, self.source_color.get_first_child()):
            accessible.update_property([Gtk.AccessibleProperty.LABEL], ["Profile color"])
        self.source_color.connect("notify::rgba", self.color_changed)
        color_row = Gtk.Box(spacing=8)
        color_row.append(self.source_color)
        self.source_color_hex = label("", "caption")
        self.source_color_hex.set_selectable(True)
        color_row.append(self.source_color_hex)
        color_name = label("Profile color")
        color_name.set_mnemonic_widget(self.source_color)
        grid.attach(color_name, 0, 5, 1, 1)
        grid.attach(color_row, 1, 5, 2, 1)
        presets = Gtk.Box(spacing=6)
        for name, color in SOURCE_COLOR_PRESETS:
            marker = SourceMarker(owner, color)
            marker.set_valign(Gtk.Align.CENTER)
            self.preset_markers.append(marker)
            preset = Gtk.Box(spacing=6)
            preset.append(marker)
            preset.append(label(name, "caption"))
            button = Gtk.Button(child=preset, tooltip_text=f"{name}: {color}")
            button.update_property([Gtk.AccessibleProperty.LABEL], [f"Use {name} profile color"])
            button.connect("clicked", lambda _button, value=color: self.source_color.set_rgba(owner.rgba(value)))
            presets.append(button)
        grid.attach(presets, 1, 6, 2, 1)
        self.show_marker = Gtk.CheckButton(label="Show profile dot", active=True)
        self.form.append(self.show_marker)
        self.enabled = Gtk.CheckButton(label="Enabled", active=True)
        self.form.append(self.enabled)
        help_text = label("Codex: choose CODEX_HOME, such as ~/.codex-personal. Claude: choose the app profile folder with "
                          "claude-code-sessions or Cache. Added sources need an installed app launcher. "
                          "Only default sources can leave Open with empty to use the default app.", "caption")
        help_text.set_wrap(True)
        content.append(help_text)
        self.source_status = label("", "caption")
        self.source_status.set_wrap(True)
        self.source_status.set_selectable(True)
        content.append(self.source_status)
        actions = Gtk.Box(spacing=8)
        content.append(actions)
        self.add_button, self.save_button, self.remove_button, self.cancel_button, self.reload_button = (
            Gtk.Button(label=title) for title in ("Add", "Save", "Remove", "Cancel", "Refresh"))
        for button, callback in ((self.add_button, self.add_source), (self.save_button, self.save_source),
                                 (self.remove_button, self.remove_source), (self.cancel_button, self.cancel_form),
                                 (self.reload_button, self.reload_sources)):
            button.connect("clicked", callback)
            actions.append(button)
        self.save_button.add_css_class("suggested-action")
        self.set_content(body)
        self.update_controls()
        self.reload_sources()

    def color_changed(self, *_args):
        self.source_color_hex.set_label(self.owner.hex_color(self.source_color.get_rgba()))

    def update_marker_colors(self):
        for marker in self.preset_markers + self.table_markers:
            marker.set_color(marker.configured_color)

    @staticmethod
    def table_line(values):
        line = Gtk.Box(spacing=8, margin_start=8, margin_end=8, margin_top=6, margin_bottom=6)
        for value, width in zip(values, (64, 150, 210, 180, 180)):
            cell = label(value, "caption") if isinstance(value, str) else value
            cell.set_size_request(width, -1)
            if isinstance(value, str):
                cell.set_max_width_chars(1)
                cell.set_ellipsize(Pango.EllipsizeMode.END)
                cell.set_tooltip_text(value)
            line.append(cell)
        return line

    def update_controls(self):
        busy = self.loading or self.choosing
        current = next((source for source in self.sources if source["id"] == self.editing_id), {})
        self.table.set_sensitive(self.loaded and not busy)
        self.form.set_sensitive(self.editing and not busy)
        self.provider.set_sensitive(not current.get("builtin"))
        self.add_button.set_sensitive(self.loaded and not busy and len(self.sources) < self.max_sources)
        self.save_button.set_sensitive(self.loaded and not busy and self.editing)
        self.remove_button.set_sensitive(self.loaded and not busy and bool(current) and not current.get("builtin"))
        self.cancel_button.set_sensitive(self.loaded and not busy and self.editing)
        self.reload_button.set_sensitive(not busy)
        self.table.update_state([Gtk.AccessibleState.BUSY], [busy])

    def provider_changed(self, *_args):
        for widget in self.transcript_widgets:
            widget.set_visible(self.provider.get_selected() == 1)

    def set_form(self, source=None):
        source = source or {}
        self.editing, self.editing_id = True, source.get("id", "")
        self.form_title.set_label("Edit app source" if self.editing_id else "Add app source")
        self.source_id.set_label("ID: " + (self.editing_id or "Assigned when saved"))
        self.provider.set_selected(SOURCE_PROVIDERS.index(source.get("provider", "codex")))
        for entry, key in ((self.name, "label"), (self.data_dir, "dataDir"),
                           (self.launcher, "launcher"), (self.projects_dir, "projectsDir")):
            entry.set_text(source.get(key, ""))
        self.enabled.set_active(source.get("enabled", True))
        self.show_marker.set_active(source.get("showMarker", True))
        try:
            color = validate_source_color(source.get("color", SOURCE_COLOR_PRESETS[0][1]))
        except ValueError:
            color = SOURCE_COLOR_PRESETS[0][1]
        self.source_color.set_rgba(self.owner.rgba(color))
        for accessible in (self.source_color, self.source_color.get_first_child()):
            accessible.update_property([Gtk.AccessibleProperty.LABEL], ["Profile color for " + source.get("label", "new app source")])
        self.color_changed()
        self.launcher.set_placeholder_text("Default app link handler" if source.get("builtin") else "Installed app launcher required")
        status = source.get("status", "").capitalize()
        if source.get("message"):
            status += ": " + source["message"]
        if source.get("builtin"):
            status += ". Default source: you can edit or disable it. You cannot remove it."
        self.source_status.set_label(status.strip(". "))
        self.provider_changed()
        self.update_controls()

    def selected_source(self, _table, row):
        if row and not (self.loading or self.choosing or self.closed):
            self.set_form(row.asb_source)

    def render_sources(self, preferred=""):
        self.table_markers = []
        child = self.table.get_first_child()
        while child:
            following = child.get_next_sibling()
            self.table.remove(child)
            child = following
        selected = None
        for source in self.sources:
            provider = "Codex" if source["provider"] == "codex" else "Claude Desktop Code"
            marker = SourceMarker(self.owner, source.get("color", ""))
            marker.set_valign(Gtk.Align.CENTER)
            self.table_markers.append(marker)
            name_cell = Gtk.Box(spacing=6)
            name_cell.append(marker)
            name = label(source["label"] + "\n" + provider, "caption")
            name.set_ellipsize(Pango.EllipsizeMode.END)
            name.set_max_width_chars(1)
            name.set_hexpand(True)
            name_cell.append(name)
            name_cell.set_tooltip_text(source["label"] + "\n" + provider + "\nProfile color: " + marker.configured_color)
            status = f"{source.get('sessionCount', 0)} chats · {source.get('status', 'unknown').capitalize()}"
            if source.get("message"):
                status += "\n" + source["message"]
            row = Gtk.ListBoxRow()
            row.asb_source = source
            row.set_child(self.table_line(["Yes" if source["enabled"] else "No", name_cell,
                                           source["dataDir"], source["launcher"] or "Default app", status]))
            row.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                [f"{source['label']}, {provider}, {status}", "Profile color: " + marker.configured_color])
            self.table.append(row)
            if selected is None or source["id"] == preferred:
                selected = row
        if selected:
            self.table.select_row(selected)
            self.set_form(selected.asb_source)
        else:
            self.editing, self.editing_id = False, ""
            self.form_title.set_label("Add an app source to show its chats")
            self.source_id.set_label("")
            self.source_status.set_label("")

    def request_sources(self, route="/api/sources", method="GET", body=None):
        if self.closed or self.owner.closed or self.loading or self.choosing:
            return
        preferred = self.editing_id
        self.loading = True
        self.message.set_label("Loading app sources…" if method == "GET" else "Saving app sources…")
        self.update_controls()
        def finished(result, error):
            if self.closed or self.owner.closed:
                return False
            self.loading = False
            if not error and (not isinstance(result, dict) or not isinstance(result.get("sources"), list)):
                error = "The app source list is not valid. Refresh the list, then try again."
            if error:
                self.message.set_label(error)
            else:
                self.sources, self.loaded = result["sources"], True
                self.max_sources = result.get("maxSources", self.max_sources)
                identity = preferred
                if method == "POST" and body and not body["source"].get("id"):
                    identity = next((source["id"] for source in self.sources
                                     if source["provider"] == body["source"]["provider"]
                                     and source["dataDir"] == os.path.normpath(body["source"]["dataDir"])), "")
                self.render_sources(identity)
                feedback = "Saved. " if method == "POST" and body else "Removed. " if method == "POST" else ""
                self.message.set_label(f"{feedback}{len(self.sources)} of {self.max_sources} app sources")
                if method == "POST":
                    self.owner.refresh(True)
            self.update_controls()
            return False
        request_async(self.base, route, finished, GLib.idle_add, method, body)

    def reload_sources(self, *_args):
        self.request_sources()

    def add_source(self, *_args):
        if self.loading or self.choosing or not self.loaded or len(self.sources) >= self.max_sources:
            return
        self.table.unselect_all()
        self.set_form()
        self.name.grab_focus()

    def cancel_form(self, *_args):
        row = self.table.get_selected_row() or self.table.get_row_at_index(0)
        if row:
            self.table.select_row(row)
            self.set_form(row.asb_source)
        else:
            self.editing = False
            self.update_controls()

    def save_source(self, *_args):
        if self.closed or self.loading or self.choosing or not self.loaded or not self.editing:
            return
        try:
            body = source_form_body(SOURCE_PROVIDERS[self.provider.get_selected()], self.name.get_text(),
                                    self.data_dir.get_text(), self.launcher.get_text(), self.enabled.get_active(),
                                    self.editing_id, self.projects_dir.get_text(),
                                    self.owner.hex_color(self.source_color.get_rgba()), self.show_marker.get_active())
        except ValueError as error:
            self.message.set_label(str(error))
            return
        self.request_sources("/api/sources", "POST", body)

    def remove_source(self, *_args):
        current = next((source for source in self.sources if source["id"] == self.editing_id), {})
        if current and not current.get("builtin"):
            self.request_sources("/api/sources/" + quote(self.editing_id, safe="") + "/remove", "POST", {})

    def choose_path(self, entry, folder):
        if self.closed or self.loading or self.choosing:
            return
        self.choosing = True
        self.update_controls()
        dialog = Gtk.FileDialog(title="Choose session folder" if folder else "Choose app launcher")
        value = Path(os.path.expanduser(entry.get_text().strip())) if entry.get_text().strip() else Path.home()
        initial = value if folder else value.parent
        if initial.is_dir():
            dialog.set_initial_folder(Gio.File.new_for_path(str(initial)))
        def finished(chooser, result):
            if self.closed or self.owner.closed:
                return
            self.choosing = False
            try:
                chosen = chooser.select_folder_finish(result) if folder else chooser.open_finish(result)
                path = chosen.get_path()
                if not path:
                    raise ValueError("Choose a local file or folder.")
                entry.set_text(path)
            except GLib.Error as error:
                if not error.matches(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED) \
                        and not error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
                    self.message.set_label("Cannot select this path. Enter its local path, then try again.")
            except ValueError as error:
                self.message.set_label(str(error))
            self.update_controls()
        if folder:
            dialog.select_folder(self, self.cancellable, finished)
        else:
            dialog.open(self, self.cancellable, finished)

    def on_close(self, *_args):
        self.closed = True
        self.cancellable.cancel()
        if self.owner.sources_window is self:
            self.owner.sources_window = None
        return False


class SwitchboardWindow(Adw.ApplicationWindow):
    drawer_view, drawer_peek, drawer_count, column_pixel_width = False, False, 0, DEFAULT_COLUMN_WIDTH

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
        self.dashboard_etag = None
        self.refresh_interval_ms = 5000
        self.clock_interval = self.clock_timer = None
        self.notice_timer, self.notice_generation, self.provider_notice = None, 0, ""
        self.opening, self.focus_widgets, self.row_cache = set(), {}, {}
        self.list_columns = []
        self.focus_generation = 0
        self.connect("notify::focus-widget", self.focus_changed)
        self.key_focus_row = None
        for name in ("focus-widget", "focus-visible"):
            self.connect("notify::" + name, self.key_focus_changed)
        self.session_actions = set()
        self.open_errors = {}
        self.context_menu = None
        self.sources_window = None
        self.drag_identity = None
        for name in ("mark-unread", "mark-read", "pin", "unpin", "pin-up", "pin-down", "discard-result", "keep-result",
                     "drawer-in", "drawer-out"):
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
        self.search.set_search_delay(0)
        self.search.set_size_request(0, -1)
        self.search.set_tooltip_text("Search title or folder. cl: or claude: selects Claude; cx: or codex: selects Codex.")
        self.search.connect("search-changed", self.filter_changed)
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
        self.archive.connect("toggled", self.filter_changed)
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
        app_sources = Gtk.Button(label="App sources…")
        app_sources.connect("clicked", self.open_sources)
        settings.append(app_sources)
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
        self.syncing_theme = False
        colors = self.native_colors()
        for key in THEME_KEYS:
            row = Gtk.Box(spacing=12)
            name = label(key.capitalize())
            name.set_hexpand(True)
            picker = Gtk.ColorDialogButton.new(Gtk.ColorDialog(title=f"ASB {key} color", with_alpha=False))
            for accessible in (picker, picker.get_first_child()):
                accessible.update_property([Gtk.AccessibleProperty.LABEL], [f"{key.capitalize()} color"])
            picker.set_rgba(self.rgba(colors[key]))
            picker.connect("notify::rgba", self.theme_color_changed)
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
        self.pending_group.append(self.pending_only)
        self.working_only = Gtk.ToggleButton(label="Working", tooltip_text="Show Working sessions. With Pending, include unread chats. Turn off to show all states.")
        self.working_only.add_css_class("asb-filter-pill")
        self.working_only.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                         ["Working filter", "Select Working only. With Pending, include unread chats."])
        self.working_only.connect("toggled", self.working_from_pill)
        self.pending_group.append(self.working_only)
        self.drawer_only = Gtk.ToggleButton(tooltip_text="Show only the sessions in the drawer, as unread. Point here to see them in the list.")
        self.drawer_only.add_css_class("asb-filter-pill")
        self.drawer_only.update_property([Gtk.AccessibleProperty.LABEL], ["Drawer only. Sessions in the drawer: 0"])
        drawer = Gtk.Box(spacing=3)
        drawer.append(self.drawer_glyph())
        drawer.append(ShrinkLabel(label="Drawer", ellipsize=Pango.EllipsizeMode.END))
        self.drawer_bubble = Gtk.Label(valign=Gtk.Align.CENTER, visible=False)
        self.drawer_bubble.add_css_class("asb-drawer-count")
        drawer.append(self.drawer_bubble)
        self.drawer_only.set_child(drawer)
        self.pending_only.connect("notify::active", self.exclusive_pill, self.drawer_only)
        self.drawer_only.connect("notify::active", self.exclusive_pill, self.pending_only)
        peek = Gtk.EventControllerMotion()
        peek.connect("enter", lambda *_args: self.set_drawer_peek(True))
        peek.connect("leave", lambda *_args: self.set_drawer_peek(False))
        self.drawer_only.add_controller(peek)
        self.pending_group.append(self.drawer_only)
        feedback.append(self.pending_group)
        self.count = ShrinkLabel(label="Loading sessions…", xalign=0)
        self.count.add_css_class("caption")
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
        self.list_body = SessionStrip(orientation=Gtk.Orientation.HORIZONTAL, spacing=12,
                                      margin_start=4, margin_end=4, margin_bottom=4)
        self.scroll = ColumnScroll(vexpand=True, hscrollbar_policy=Gtk.PolicyType.AUTOMATIC,
                                        vscrollbar_policy=Gtk.PolicyType.NEVER,
                                        child=self.list_body)
        self.scroll_target = None
        self.scroll_direction, self.scroll_updating = 0, False
        target = Adw.CallbackAnimationTarget.new(self.advance_scroll)
        self.scroll_animation = Adw.SpringAnimation.new(self.scroll, 0, 0, Adw.SpringParams.new(1, 1, 400), target)
        self.motion_from, self.motion_columns = None, []
        target = Adw.CallbackAnimationTarget.new(self.advance_motion)
        self.motion_animation = Adw.SpringAnimation.new(self.scroll, 1, 0, Adw.SpringParams.new(1, 1, 400), target)
        self.motion_animation.set_epsilon(.0001)
        self.scroll.after_layout = self.start_motion
        self.scroll.connect("unmap", self.cancel_motion)
        self.scroll.get_hadjustment().connect("value-changed", self.scroll_position_changed)
        self.scroll.get_hadjustment().connect("changed", self.cancel_scroll)
        self.scroll.connect("unmap", self.cancel_scroll)
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
        motion.connect("motion", self.hover_motion)
        motion.connect("leave", lambda *_args: self.list_body.set_cursor_from_name(None))
        motion.connect("leave", lambda *_args: self.list_body.show_hover(None))
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
                self.set_theme_pickers(saved)
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
{base}.asb-comfortable .asb-hover-paint .asb-session:hover:not(:focus-within) {{ background: transparent; }}
{base} .asb-filter-pill {{ min-height: 24px; border-radius: 99px; padding: 2px 8px; font-size: 11px; }}
{base} .asb-filter-pill:checked {{ background: @accent_bg_color; color: @accent_fg_color; }}
{base} .asb-toolbar > button, {base} .asb-toolbar > menubutton > button,
{base} .asb-toolbar windowcontrols button {{ min-height: 24px; min-width: 22px; padding: 2px; }}
{base} .asb-toolbar searchentry {{ min-height: 26px; padding-top: 0; padding-bottom: 0; }}
{base} .asb-state {{ font-size: 11px; }}
{base} .asb-provider {{ opacity: .65; }}
{base} .asb-source-badge {{ min-width: 6px; min-height: 6px; padding: 0; border: 1px solid @window_bg_color;
    border-radius: 50%; box-shadow: none; opacity: 1; }}
{base} .asb-column {{ background: transparent; }}
{base} .asb-column + .asb-column {{ border-left: 1px solid @borders; }}
{base} .asb-dot, .asb-tooltip .asb-dot {{ min-width: 7px; min-height: 7px; border-radius: 50%; background: @accent_color; }}
{base} .asb-dot.asb-question, .asb-tooltip .asb-dot.asb-question {{ min-width: 0; min-height: 0; border-radius: 0; background: none; color: @accent_color;
    font-size: 11px; font-weight: 800; }}
{base} .asb-dot.asb-stop, .asb-tooltip .asb-dot.asb-stop {{ border-radius: 1px; background: alpha(@window_fg_color, .55); }}
{base} .asb-dot.asb-discard, .asb-tooltip .asb-dot.asb-discard {{ min-width: 6px; min-height: 6px; border: 1.5px solid @window_fg_color;
    border-radius: 50%; background: none; }}
{base} .asb-discard-offer .asb-discard {{ border-style: dashed; border-color: alpha(@window_fg_color, .55); }}
{base} .asb-card-action {{ min-width: 24px; min-height: 24px; padding: 0; border: 0; border-radius: 50%; box-shadow: none; }}
{base} .asb-card-action.asb-action-pending > * {{ opacity: .5; }}
{base} .asb-pin-button {{ opacity: 0; }}
{base} .asb-session:hover .asb-pin-button, {base} .asb-session:focus-within .asb-pin-button,
{base} .asb-pin-button.asb-pinned {{ opacity: 1; }}
{base} .asb-pin-button.asb-pinned {{ background: alpha(@window_fg_color, .12); }}
{base} .asb-read-button {{ color: @accent_color; background: alpha(@window_fg_color, .08); }}
{base} .asb-read-button:hover, {base} .asb-read-button:focus-visible {{ background: alpha(@accent_color, .15); }}
{base} .asb-read-cue {{ opacity: 0; }}
{base} .asb-read-button:hover:not(.asb-passive-indicator):not(.asb-discard-button) .asb-dot,
{base} .asb-read-button:focus-visible:not(.asb-passive-indicator):not(.asb-discard-button) .asb-dot,
{base} .asb-read-confirmed .asb-dot {{ opacity: 0; }}
{base} .asb-read-button:hover:not(.asb-passive-indicator):not(.asb-discard-button) .asb-read-cue,
{base} .asb-read-button:focus-visible:not(.asb-passive-indicator):not(.asb-discard-button) .asb-read-cue,
{base} .asb-read-confirmed .asb-read-cue {{ opacity: 1; }}
{base} .asb-read-button.asb-read-confirmed {{ color: @success_color; background: alpha(@success_color, .12); }}
{base} .asb-read-button.asb-passive-indicator {{ background: transparent; }}
{base} .asb-read-button.asb-discard-button {{ background: transparent; }}
{base} .asb-discard-button.asb-discard-offer {{ opacity: 0; }}
{base} .asb-session:hover .asb-discard-offer, {base} .asb-session:focus-within .asb-discard-offer {{ opacity: 1; }}
{base} .asb-drawer-glyph {{ min-width: 9px; min-height: 5px; border: 1px solid; border-radius: 2px; }}
{base} .asb-drawer-handle {{ min-width: 3px; min-height: 1px; background: currentColor; }}
{base} .asb-drawer-filled .asb-drawer-glyph {{ background: currentColor; }}
{base} .asb-drawer-filled .asb-drawer-handle {{ background: @window_bg_color; }}
{base} .asb-drawer-filled:checked .asb-drawer-handle {{ background: @accent_bg_color; }}
{base} .asb-drawer-count {{ min-width: 8px; min-height: 16px; padding: 0 4px; border-radius: 99px; background: @accent_color; color: @window_bg_color; }}
{base} .asb-filter-pill:checked .asb-drawer-count {{ background: @accent_fg_color; color: @accent_bg_color; }}
{base} .asb-drawer-button {{ opacity: 0; background: alpha(@window_fg_color, .08); }}
{base} .asb-session:hover .asb-drawer-button, {base} .asb-key-focus .asb-drawer-button {{ opacity: 1; }}
{base} .asb-drawer-button.asb-drawer-filled {{ color: @accent_color; }}
{base} .asb-drawer-button:hover, {base} .asb-drawer-button:focus-visible {{ background: alpha(@accent_color, .15); }}
{base} .asb-corner-drawer {{ padding: 0 0 2px 16px; border-radius: 0 0 0 12px; }}
{base} .asb-session:hover .asb-corner-drawer, {base} .asb-key-focus .asb-corner-drawer {{
    background: linear-gradient(to right, alpha(@window_bg_color, 0), @window_bg_color 16px); }}
{base} .asb-unread:hover .asb-dot, {base} .asb-unread.asb-key-focus .asb-read-button .asb-dot,
{base} .asb-drawer:not(.asb-drawer-lit) .asb-dot {{ opacity: 0; }}
{base} .asb-unread:hover .asb-read-cue, {base} .asb-unread.asb-key-focus .asb-read-cue {{ opacity: 1; }}
{base} .asb-drawer:not(.asb-drawer-lit):not(:hover):not(.asb-key-focus) .asb-read-button {{ opacity: 0; }}
{base}:not(.asb-custom) .asb-unread:hover .asb-state:not(.success):not(.warning) {{ opacity: .55; }}
{base} .asb-drawer.asb-drawer-lit:not(:hover) .asb-state {{ opacity: 1; }}
.asb-tooltip {{ font-size: 12px; }}
.asb-tooltip .asb-tooltip-title {{ font-size: 13px; }}
.asb-tooltip .asb-tooltip-path, .asb-tooltip .asb-tooltip-footer, .asb-tooltip .asb-tooltip-flags {{ font-size: 11px; }}
.asb-tooltip .asb-tooltip-muted {{ color: alpha(@window_fg_color, .72); opacity: 1; }}
.asb-tooltip .asb-working {{ color: @success_color; }}
.asb-tooltip .asb-waiting {{ color: @warning_color; }}
.asb-tooltip .asb-provider {{ opacity: .65; }}
.asb-tooltip .asb-source-badge {{ min-width: 6px; min-height: 6px; padding: 0; border: 1px solid @window_bg_color; border-radius: 50%; }}
"""
        if colors:
            colors = validate_theme(colors)
            self.add_css_class("asb-custom")
            scope = base + ".asb-custom"
            css += f"""
{scope}, {scope} headerbar, {scope} popover contents {{ background: {colors['background']}; color: {colors['text']}; }}
{scope} .asb-state, {scope} .dim-label {{ color: {colors['muted']}; opacity: 1; }}
{scope} .asb-working, {scope} .asb-waiting {{ color: {colors['accent']}; }}
{scope} .asb-dot, .asb-tooltip.asb-custom .asb-dot {{ background: {colors['accent']}; }}
{scope} .asb-dot.asb-question, .asb-tooltip.asb-custom .asb-dot.asb-question {{ background: none; color: {colors['accent']}; }}
{scope} .asb-dot.asb-stop, .asb-tooltip.asb-custom .asb-dot.asb-stop {{ background: {colors['muted']}; }}
{scope} .asb-dot.asb-discard, .asb-tooltip.asb-custom .asb-dot.asb-discard {{ background: none; border-color: {colors['text']}; }}
{scope} .asb-discard-offer .asb-discard {{ border-color: {colors['muted']}; }}
{scope} .asb-column + .asb-column {{ border-color: {colors['divider']}; }}
{scope} .asb-session:hover, {scope} .asb-session:focus-within {{ background: {highlight_color(colors)}; }}
{scope} entry, {scope} button, {scope} dropdown {{ color: {colors['text']}; }}
{scope} .asb-read-button {{ color: {colors['accent']}; background: alpha({colors['text']}, .08); }}
{scope} .asb-pin-button.asb-pinned {{ background: alpha({colors['text']}, .12); }}
{scope} .asb-read-button:hover, {scope} .asb-read-button:focus-visible,
{scope} .asb-read-button.asb-read-confirmed {{ color: {colors['accent']}; background: alpha({colors['accent']}, .15); }}
{scope} .asb-read-button.asb-passive-indicator {{ background: transparent; }}
{scope} .asb-read-button.asb-discard-button {{ background: transparent; }}
{scope} :focus-visible {{ outline-color: {colors['accent']}; }}
{scope} entry:focus-within {{ box-shadow: inset 0 0 0 1px {colors['accent']}; }}
{scope} entry selection {{ background: {colors['accent']}; color: {colors['background']}; }}
{scope} switch:checked, {scope} checkbutton check:checked {{ background: {colors['accent']}; border-color: {colors['accent']}; }}
{scope} .asb-filter-pill:checked {{ background: {colors['accent']}; color: {colors['background']}; }}
{scope} .asb-drawer-filled .asb-drawer-handle {{ background: {colors['background']}; }}
{scope} .asb-drawer-filled:checked .asb-drawer-handle {{ background: {colors['accent']}; }}
{scope} .asb-drawer-count {{ background: {colors['accent']}; color: {colors['background']}; }}
{scope} .asb-filter-pill:checked .asb-drawer-count {{ background: {colors['background']}; color: {colors['accent']}; }}
{scope} .asb-drawer-button {{ background: alpha({colors['text']}, .08); }}
{scope} .asb-drawer-button.asb-drawer-filled {{ color: {colors['accent']}; }}
{scope} .asb-drawer-button:hover, {scope} .asb-drawer-button:focus-visible {{ background: alpha({colors['accent']}, .15); }}
{scope} .asb-session:hover .asb-corner-drawer, {scope} .asb-key-focus .asb-corner-drawer {{
    background: linear-gradient(to right, alpha({colors['background']}, 0), {colors['background']} 16px); }}
.asb-tooltip.asb-custom {{ color: {colors['text']}; }}
.asb-tooltip.asb-custom .asb-tooltip-muted, .asb-tooltip.asb-custom .asb-state {{ color: {colors['muted']}; }}
.asb-tooltip.asb-custom .dim-label {{ opacity: 1; }}
.asb-tooltip.asb-custom .asb-working, .asb-tooltip.asb-custom .asb-waiting {{ color: {colors['accent']}; }}
"""
        else:
            self.remove_css_class("asb-custom")
        palette = colors or self.native_colors()
        highlight = highlight_color(palette) if colors else mix_color(palette["background"], palette["text"], .07)
        self.profile_surfaces = (palette["background"], highlight)
        quiet_title, title_fraction = quiet_color(palette, "text", .67, highlight)
        quiet_caption, caption_fraction = quiet_color(palette, "muted" if colors else "text", .85 if colors else .5, highlight)
        if not colors:
            quiet_title = f"mix(@window_bg_color, @window_fg_color, {title_fraction})"
            quiet_caption = f"mix(@window_bg_color, @window_fg_color, {caption_fraction})"
        # A drawer row is quiet as a read row, but not while the Drawer pill shows it as unread.
        quiet = [base + ".asb-comfortable .asb-idle-read:not(.asb-drawer-lit):not(:hover):not(:focus-within)"]
        css += f"""
{", ".join(row + " .asb-title" for row in quiet)} {{ color: {quiet_title}; opacity: 1; }}
{", ".join(row + part for row in quiet for part in (" .asb-folder", " .asb-state", " .asb-age"))} {{ color: {quiet_caption}; opacity: 1; }}
"""
        self.css.load_from_string(css)
        self.hover_colors = colors
        for widget in self.row_cache.values():
            widget.asb_tooltip_content = widget.asb_tooltip_key = None
            widget.asb_source_badge.set_color(source_marker_color(widget.asb_thread))
        if getattr(self, "sources_window", None):
            (self.sources_window.add_css_class if colors else self.sources_window.remove_css_class)("asb-custom")
            self.sources_window.update_marker_colors()

    def open_sources(self, *_args):
        if self.closed:
            return
        self.menu_button.get_popover().popdown()
        if self.sources_window is None:
            self.sources_window = AppSourcesWindow(self)
        self.sources_window.present()

    def set_theme_pickers(self, colors):
        self.syncing_theme = True
        try:
            for key, picker in self.color_buttons.items():
                picker.set_rgba(self.rgba(colors[key]))
        finally:
            self.syncing_theme = False

    def theme_color_changed(self, *_args):
        if not self.syncing_theme:
            self.theme_mode.set_selected(1)
            self.theme_error.remove_css_class("warning")
            self.theme_error.set_label("Colors changed. Select Apply theme to save.")

    def apply_theme(self, *_args):
        try:
            colors = None if self.theme_mode.get_selected() == 0 else validate_theme(
                {key: self.hex_color(picker.get_rgba()) for key, picker in self.color_buttons.items()})
            write_theme(self.theme_path, colors)
            self.set_palette(colors)
            self.theme_error.remove_css_class("warning")
            self.theme_error.set_label("Custom theme saved." if colors else "GNOME colors applied.")
        except (ValueError, OSError) as error:
            self.theme_error.add_css_class("warning")
            self.theme_error.set_label(str(error))

    def reset_theme(self, *_args):
        try:
            write_theme(self.theme_path)
            self.set_palette(None)
            self.theme_mode.set_selected(0)
            self.set_theme_pickers(self.native_colors())
            self.theme_error.remove_css_class("warning")
            self.theme_error.set_label("Reset to GNOME colors.")
        except OSError:
            self.theme_error.add_css_class("warning")
            self.theme_error.set_label("Cannot reset the ASB theme. Check its config folder.")

    def set_notice(self, text, temporary=False):
        if temporary:
            previous, self.provider_notice = self.provider_notice, text
            if text == previous:
                if self.notice_timer:
                    return
                text = ""
        if self.notice_timer:
            GLib.source_remove(self.notice_timer)
            self.notice_timer = None
        self.notice_generation += 1
        self.notice.set_label(text)
        self.notice.set_visible(bool(text))
        if text and temporary:
            generation = self.notice_generation
            def hide():
                if not self.closed and generation == self.notice_generation:
                    self.notice_timer = None
                    self.notice.set_visible(False)
                return False
            self.notice_timer = GLib.timeout_add(5000, hide)

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
        if force:
            self.refresh_button.set_sensitive(False)
        if self.loading:
            self.refresh_queued = self.refresh_queued or force or queue
            self.refresh_force_queued = self.refresh_force_queued or force
            return
        self.loading = True
        etag = [self.dashboard_etag]
        request_async(self.base, "/api/dashboard?force=1" if force else "/api/dashboard",
                      lambda dashboard, error: self.apply_dashboard(dashboard, error, etag, force), GLib.idle_add, "GET", None, etag)

    def apply_dashboard(self, dashboard, error, etag=None, forced=False):
        if self.closed:
            return False
        self.loading = False
        if forced and not self.refresh_force_queued:
            self.refresh_button.set_sensitive(True)
        if self.refresh_queued:
            self.refresh_queued = False
            force, self.refresh_force_queued = self.refresh_force_queued, False
            GLib.idle_add(self.refresh, force)
        if error:
            # A later 304 changes no widget, so it must not keep this notice.
            self.dashboard_etag = None
            self.set_notice(error)
            if self.dashboard is None:
                self.count.set_label("Sessions are not available")
            return False
        if dashboard is None:
            return False
        self.dashboard, self.dashboard_etag = dashboard, etag and etag[0]
        interval = refresh_interval(dashboard)
        if interval != self.refresh_interval_ms:
            self.refresh_interval_ms = interval
            GLib.source_remove(self.timer)
            self.timer = GLib.timeout_add(interval, self.tick)
        self.sync_unread_setting(dashboard.get("persistentUnread", False))
        self.set_notice(" ".join(provider.get("message", "") for provider in dashboard.get("providers", []) if provider.get("message")), temporary=True)
        signature = dashboard.get("threads", [])
        if signature != self.signature or any(type(row.get("sourceCount")) is not type(previous.get("sourceCount"))
                                               for row, previous in zip(signature, self.signature or [])):
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
        frame_sync = getattr(self.layout_surface, "set_frame_sync_enabled", None)
        if frame_sync and self.get_display().is_composited():
            # GTK4 X11 feedback can halve cadence; its deprecated API has no replacement.
            # shortcut: X11 fallback can cap at 60 Hz; revisit when compositor feedback is reliable.
            frame_sync(False)
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
        # A scrollbar that is not an overlay takes height from the viewport, and the font sets the real row height.
        viewport = self.scroll.get_child()
        geometry = (viewport.get_width(), viewport.get_height())
        row_height = max((widget.get_height() for widget in self.focus_widgets.values()), default=0) or self.row_height
        if geometry[0] > 0 and geometry[1] > 0 and (geometry, row_height) != (self.geometry, self.row_height):
            self.cancel_scroll()
            self.list_body.clear_hover()
            self.geometry, self.row_height = geometry, row_height
            self.render(reveal_focus=True)
        return False

    def set_column_width(self, *_args):
        width = validate_column_width(self.width_control.get_value_as_int())
        if width != self.column_width:
            self.cancel_scroll()
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
            self.cancel_scroll()
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
        delta = dx if dx else dy
        if self.closed or not delta:
            return True
        adjustment = self.scroll.get_hadjustment()
        unit = controller.get_unit() if controller else Gdk.ScrollUnit.WHEEL
        distance = max(32, adjustment.get_step_increment()) if unit == Gdk.ScrollUnit.WHEEL else 1
        lower = adjustment.get_lower()
        upper = max(lower, adjustment.get_upper() - adjustment.get_page_size())
        current = adjustment.get_value()
        if upper == lower:
            self.cancel_scroll()
            return True
        if unit != Gdk.ScrollUnit.WHEEL or not self.get_settings().get_property("gtk-enable-animations"):
            self.cancel_scroll()
            adjustment.set_value(max(lower, min(upper, current + delta * distance)))
            return True
        start = self.scroll_target if self.scroll_target is not None and delta * self.scroll_direction > 0 else current
        target = max(lower, min(upper, start + delta * distance))
        if abs(target - current) < .5:
            # Less than half a pixel needs no spring; its stop fraction below must stay under 1, or it never ends.
            self.cancel_scroll()
            adjustment.set_value(target)
        elif target != self.scroll_target:
            velocity = self.scroll_animation.get_velocity() if self.scroll_target is not None else 0
            # This spring passes its target only when it starts faster than 20/s times the distance.
            limit = 20 * (target - current)
            self.scroll_animation.pause()
            self.scroll_target, self.scroll_direction = target, delta
            self.scroll_animation.set_value_from(current)
            self.scroll_animation.set_value_to(target)
            self.scroll_animation.set_initial_velocity(min(velocity, limit) if limit > 0 else max(velocity, limit))
            # The spring stops at this fraction of the distance; keep the last step below half a pixel.
            self.scroll_animation.set_epsilon(.05 / abs(target - current))
            self.scroll_animation.reset()
            self.scroll_animation.play()
        return True

    def advance_scroll(self, value):
        if self.scroll_target is None or self.closed:
            return
        self.scroll_updating = True
        try:
            self.scroll.get_hadjustment().set_value(value)
        finally:
            self.scroll_updating = False
        if value == self.scroll_target:
            self.scroll_target, self.scroll_direction = None, 0

    def cancel_scroll(self, *_args):
        self.scroll_target, self.scroll_direction = None, 0
        animation = getattr(self, "scroll_animation", None)
        if animation:
            animation.reset()

    def scroll_position_changed(self, *_args):
        self.scroll_hover_blocked = True
        self.list_body.clear_hover()
        self.redraw_visible_columns()
        if not self.scroll_updating:
            self.cancel_scroll()

    def redraw_visible_columns(self):
        listings = getattr(self, "list_columns", [])
        if not listings or self.closed:
            return
        adjustment = self.scroll.get_hadjustment()
        step = self.column_pixel_width + 12
        first = max(0, int(adjustment.get_value() // step) - 1)
        last = int((adjustment.get_value() + adjustment.get_page_size()) // step) + 2
        # Scroll signals precede viewport allocation, so bounds still describe the previous position.
        for listing in listings[first:last]:
            if getattr(listing, "asb_snapshot_skipped", False) and listing.get_parent():
                listing.asb_snapshot_skipped = False
                listing.queue_draw()

    def painted_places(self):
        strip, places = self.list_body, {}
        for identity, widget in self.focus_widgets.items():
            found, bounds = widget.compute_bounds(self.scroll)
            if found:
                x, y, fade = strip.motion.get(identity, (0, 0, 0))
                places[identity] = (bounds.origin.x + x * strip.motion_progress, bounds.origin.y + y * strip.motion_progress,
                                    fade * strip.motion_progress)
        return places

    def start_motion(self):
        self.redraw_visible_columns()
        old, self.motion_from = self.motion_from, None
        if old in (None, False) or self.closed:
            return
        strip = self.list_body
        self.motion_animation.reset()
        self.advance_motion(0)
        places = self.painted_places()
        strip.motion = motion_offsets(old, places)
        if strip.motion:
            strip.clear_hover()
            self.motion_columns = list({self.focus_widgets[identity].get_parent() for identity in strip.motion})
            position = self.scroll.get_hadjustment().get_value()
            self.motion_bounds = {}
            for identity in strip.motion:
                widget = self.focus_widgets[identity]
                before, after = old.get(identity, places[identity]), places[identity]
                bounds = (min(before[0], after[0]) + position, max(before[0], after[0]) + position + widget.get_width(),
                          min(before[1], after[1]), max(before[1], after[1]) + widget.get_height())
                column = widget.get_parent()
                previous = self.motion_bounds.get(column, bounds)
                self.motion_bounds[column] = (min(previous[0], bounds[0]), max(previous[1], bounds[1]),
                                              min(previous[2], bounds[2]), max(previous[3], bounds[3]))
            self.advance_motion(1)
            self.motion_animation.play()

    def advance_motion(self, value):
        strip = self.list_body
        strip.motion_progress = value
        bounds_by_column = getattr(self, "motion_bounds", {})
        if bounds_by_column:
            position = self.scroll.get_hadjustment().get_value()
            right, bottom = position + self.scroll.get_width(), self.scroll.get_height()
        for column in self.motion_columns:
            bounds = bounds_by_column.get(column)
            # The last draw also clears translated snapshots in columns that left the viewport.
            if value <= 0 or bounds is None or (bounds[0] < right and bounds[1] > position and bounds[2] < bottom and bounds[3] > 0):
                column.queue_draw()
        if value <= 0:
            strip.motion, self.motion_columns = {}, []
            self.motion_bounds = {}

    def cancel_motion(self, *_args):
        self.motion_from = None
        animation = getattr(self, "motion_animation", None)
        if animation:
            animation.skip()

    def hover_motion(self, _controller, x, y):
        event = _controller.get_current_event() if _controller else None
        found, px, py = event.get_position() if event else (False, 0, 0)
        pointer = (px, py) if found else None
        if self.scroll_target is not None or self.scroll_updating:
            self.list_body.clear_hover()
            self.scroll_hover_blocked = True
            return
        # GTK also emits motion when scrolling changes the row under a stationary pointer.
        if getattr(self, "scroll_hover_blocked", False):
            if pointer is None or pointer == getattr(self, "hover_pointer", None):
                return
            self.scroll_hover_blocked = False
        self.hover_pointer = pointer
        rectangle = None
        if self.view == "comfortable" and not self.closed and not self.dragging:
            widget = self.list_body.pick(x, y, Gtk.PickFlags.DEFAULT)
            row = widget.get_ancestor(Gtk.ListBoxRow) if widget else None
            if row and row.get_ancestor(SessionStrip) is self.list_body:
                found, bounds = row.compute_bounds(self.list_body)
                if found:
                    rectangle = (bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)
        self.list_body.show_hover(rectangle)

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

    def focus_changed(self, *_args):
        # A repack makes GTK move focus to a column or to nothing; only a user focus change cancels a queued restore.
        focus = self.get_focus()
        if focus is not None and type(focus).__name__ not in ("ListBox", "SessionColumn"):
            self.focus_generation += 1

    def key_focus_changed(self, *_args):
        # Focus from a mouse click must not change the row, so the row has a class only while the focus in it is visible.
        focus = self.get_focus() if self.get_focus_visible() else None
        row = focus.get_ancestor(Gtk.ListBoxRow) if focus else None
        if row is not self.key_focus_row:
            if self.key_focus_row:
                self.key_focus_row.remove_css_class("asb-key-focus")
            if row:
                row.add_css_class("asb-key-focus")
            self.key_focus_row = row

    def clear_search(self, *_args):
        self.cancel_scroll()
        self.search.set_text("")

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
        return filtered_rows(self.dashboard, self.search.get_text(), app, self.states, self.archive.get_active(),
                             self.pending_only.get_active(), self.drawer_view)

    def filter_changed(self, *_args):
        self.cancel_scroll()
        self.list_body.clear_hover()
        self.render()

    def exclusive_pill(self, pill, _property, other):
        self.drawer_view = self.drawer_only.get_active()
        if pill.get_active() and other.get_active():
            other.set_active(False)  # Its handler shows the new list.
        else:
            self.filter_changed()

    def set_drawer_peek(self, active):
        self.drawer_peek = active
        for widget in self.focus_widgets.values():
            if widget.asb_thread.get("drawer"):
                self.update_drawer_style(widget)

    def update_drawer_style(self, widget):
        row = widget.asb_thread
        lit = bool(row.get("drawer") and (self.drawer_view or self.drawer_peek))
        if lit != getattr(widget, "asb_drawer_lit", False):
            (widget.add_css_class if lit else widget.remove_css_class)("asb-drawer-lit")
            widget.asb_drawer_lit = lit

    @staticmethod
    def drawer_glyph():
        # hexpand=False stops the expand of the handle here: without it the Drawer pill takes all free width.
        glyph = Gtk.Box(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER, hexpand=False)
        glyph.add_css_class("asb-drawer-glyph")
        handle = Gtk.Box(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER, hexpand=True)
        handle.add_css_class("asb-drawer-handle")
        glyph.append(handle)
        return glyph

    def select_apps(self, apps):
        self.syncing_apps = True
        self.apps = set(apps)
        for provider, pill in self.app_pills.items():
            pill.set_active(provider in self.apps)
        self.app_filter.set_selected(3 if len(self.apps) == 2 else 1 if self.apps == {"codex"}
                                     else 2 if self.apps == {"claude-desktop-code"} else 0)
        self.syncing_apps = False
        self.filter_changed()

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
        self.updating_states = True
        self.working_only.set_active(self.states == {"working"})
        self.updating_states = False
        self.filter_changed()

    def select_states(self, states):
        self.updating_states = True
        for state, check in self.state_checks.items():
            check.set_active(state in states)
        self.updating_states = False
        self.states_changed()

    def working_from_pill(self, *_args):
        if not self.updating_states:
            self.select_states({"working"} if self.working_only.get_active() else set(STATES))

    def render(self, preserve_focus=None, reveal_focus=False, preserve_action=None):
        if self.dashboard is None or self.closed:
            return
        focused = preserve_focus or self.focus_key()
        focus_widget = self.get_focus()
        focused_action = preserve_action or getattr(focus_widget, "asb_card_action", None)
        if reveal_focus and not focused and self.get_focus() is None:
            focused = self.focused_id
        position = self.scroll.get_hadjustment().get_value()
        rows = self.visible_rows()
        width, height = self.geometry or (self.get_default_size().width, 600)
        self.columns, self.capacity, parts = pack_columns(rows, width, height, self.column_width, self.row_height)
        narrow = self.column_pixel_width < 190
        self.column_pixel_width = max(1, (width - 8 - 12 * (self.columns - 1)) // self.columns)
        self.actual_columns = len(parts)
        self.row_order = [row["id"] for row in rows]
        drawer = sum(bool(row.get("drawer")) and (not row.get("archived") or self.archive.get_active())
                     for row in self.dashboard.get("threads", []))
        empty_text = "The drawer is empty. Put an unread session in it to get it out of the way." if self.drawer_view and not drawer \
            else "No matching sessions. Change the search or filters." if self.dashboard.get("threads") \
            else "No desktop sessions found. Create a session, then refresh."
        layout_signature = (tuple(self.row_order), self.columns, self.capacity, self.column_pixel_width, self.view, empty_text)
        repack = layout_signature != self.layout_signature
        reorder = repack and self.layout_signature is not None and layout_signature[1:] == self.layout_signature[1:] \
            and set(layout_signature[0]) == set(self.layout_signature[0])
        old_positions = {identity: (index // self.layout_signature[2], index % self.layout_signature[2])
                         for index, identity in enumerate(self.layout_signature[0])} if self.layout_signature else {}
        repack = repack and not reorder
        if repack or reorder:
            if getattr(self, "motion_animation", None) and motion_allowed(
                    self.layout_signature, layout_signature, self.get_settings().get_property("gtk-enable-animations"), self.get_mapped()):
                # A second change before the next layout keeps the places that are on the screen.
                if self.motion_from is None:
                    self.motion_from = self.painted_places()
            else:
                self.cancel_motion()
                # Until the next layout the row places are not valid as a start for motion.
                self.motion_from = False
        if repack:
            self.cancel_scroll()
            self.list_body.clear_hover()
        if repack and self.context_menu:
            self.context_menu.popdown()
        dashboard_ids = {row["id"] for row in self.dashboard.get("threads", [])}
        for identity in self.row_cache.keys() - dashboard_ids:
            self.release_row(self.row_cache.pop(identity))
            self.focus_widgets.pop(identity, None)
            self.open_errors.pop(identity, None)
        for row in rows:
            widget = self.row_cache.get(row["id"])
            if widget is None:
                self.row_cache[row["id"]] = self.session_row(row)
            else:
                self.update_session_row(widget, row)
                if row["id"] not in self.focus_widgets:
                    if getattr(widget, "asb_open_signature", None) != (
                            row["id"] in getattr(self, "opening", ()), self.open_errors.get(row["id"], "")):
                        widget.asb_time_signature = None
                    self.update_row_text(widget)
                    self.update_card_actions(widget)
                elif narrow != (self.column_pixel_width < 190):
                    self.update_card_actions(widget)
        visible_widgets = {row["id"]: self.row_cache[row["id"]] for row in rows}
        if repack or reorder:
            self.layout_signature = layout_signature
        if repack:
            for identity, widget in self.focus_widgets.items():
                if identity not in visible_widgets:
                    self.clear_read_feedback(widget)
                    if widget.get_parent():
                        widget.get_parent().remove(widget)
        self.focus_widgets = visible_widgets
        if repack or reorder:
            listings = self.list_columns = getattr(self, "list_columns", [])
            while len(listings) < len(parts):
                listing = SessionColumn(selection_mode=Gtk.SelectionMode.NONE, activate_on_single_click=True,
                                        valign=Gtk.Align.START, hexpand=False, width_request=self.column_pixel_width)
                listing.add_css_class("asb-column")
                listing.asb_activation = listing.connect("row-activated", self.open_row)
                listing.asb_width = self.column_pixel_width
                listings.append(listing)
            for index, listing in enumerate(listings):
                if index < len(parts):
                    if listing.asb_width != self.column_pixel_width:
                        listing.set_size_request(self.column_pixel_width, -1)
                        listing.asb_width = self.column_pixel_width
                    if listing.get_parent() is None:
                        self.list_body.append(listing)
                elif listing.get_parent():
                    self.list_body.remove(listing)
            child = self.list_body.get_first_child()
            while child:
                following = child.get_next_sibling()
                if not isinstance(child, Gtk.ListBox):
                    self.list_body.remove(child)
                child = following
            moved = [(index, self.focus_widgets[row["id"]]) for index, row in enumerate(rows)
                     if old_positions.get(row["id"]) != (index // self.capacity, index % self.capacity)
                     or self.focus_widgets[row["id"]].get_parent() is not listings[index // self.capacity]]
            focus_row = self.focus_widgets.get(self.focus_key())
            refocus = focus_widget is not None and any(widget is focus_row for _index, widget in moved)
            for _index, widget in moved:
                if widget.get_parent():
                    widget.get_parent().remove(widget)
            for index, widget in moved:
                listings[index // self.capacity].insert(widget, index % self.capacity)
            # GTK 4 keeps the window focus on a removed row until the next frame, then moves it to the column.
            if reorder and refocus and focus_widget.get_visible() and focus_widget.get_sensitive():
                self.set_focus(focus_widget)
            if not rows:
                empty = label(empty_text, "dim-label")
                empty.set_wrap(True)
                empty.set_hexpand(True)
                empty.set_margin_top(24)
                self.list_body.append(empty)
        cache_limit = (len(dashboard_ids) + self.capacity - 1) // self.capacity
        listings = getattr(self, "list_columns", [])
        retained = listings[:cache_limit]
        for listing in listings[cache_limit:]:
            if listing.get_parent() or listing.get_first_child():
                retained.append(listing)
            else:
                listing.disconnect(listing.asb_activation)
        self.list_columns = retained
        pending = sum(bool(row.get("pending")) for row in rows)
        # The Pending number comes first: a narrow window cuts the end of this text.
        self.count.set_label(f"{pending} Pending · {len(rows)} sessions")
        if drawer != self.drawer_count:
            self.drawer_count = drawer
            self.drawer_bubble.set_label(str(drawer) if drawer < 100 else "99+")
            self.drawer_bubble.set_visible(bool(drawer))
            (self.drawer_only.add_css_class if drawer else self.drawer_only.remove_css_class)("asb-drawer-filled")
            self.drawer_only.update_property([Gtk.AccessibleProperty.LABEL], [f"Drawer only. Sessions in the drawer: {drawer}"])
        if repack or reveal_focus or preserve_action:
            GLib.idle_add(self.restore_position, focused, position, reveal_focus, focused_action, self.focus_generation)

    def restore_position(self, focused, position, reveal_focus=False, focused_action=None, focus_generation=None):
        if not self.closed and (focus_generation is None or focus_generation == self.focus_generation):
            self.cancel_scroll()
            if focused in self.focus_widgets:
                if self.menu_button.get_active():
                    self.deferred_row_focus = focused
                else:
                    row = self.focus_widgets[focused]
                    control = getattr(row, "asb_" + str(focused_action) + "_button", None)
                    self.set_focus(control if control and control.get_visible() and control.get_sensitive() else row)
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
                self.cancel_scroll()
                adjustment.set_value(left)
            elif right > adjustment.get_value() + adjustment.get_page_size():
                self.cancel_scroll()
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
                    self.dashboard, self.dashboard_etag = result["dashboard"], None
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
        widget.asb_read_timer, widget.asb_read_generation = None, 0
        widget.asb_last_read_at = None
        widget.asb_tooltip_content = widget.asb_tooltip_key = None
        widget.set_has_tooltip(True)
        widget.asb_tooltip_handler = widget.connect("query-tooltip", self.query_row_tooltip)
        for controller, signals in (
                (Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE), (("key-pressed", self.row_key),)),
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
        self.clear_read_feedback(widget)
        widget.asb_last_read_at = None
        widget.asb_tooltip_content = widget.asb_tooltip_key = None
        if getattr(widget, "asb_tooltip_handler", None):
            widget.disconnect(widget.asb_tooltip_handler)
            widget.asb_tooltip_handler = None
        for controller, handlers in widget.asb_handlers:
            for handler in handlers:
                controller.disconnect(handler)
            widget.remove_controller(controller)
        widget.asb_handlers.clear()
        if widget.get_parent():
            widget.get_parent().remove(widget)

    def query_row_tooltip(self, widget, _x, _y, _keyboard, tooltip):
        if self.closed:
            return False
        model = tooltip_model(widget.asb_thread, time.time() * 1000, Path.home(), self.open_errors.get(widget.asb_thread["id"], ""),
                              self.drawer_view)
        key = (model, bool(self.hover_colors), widget.asb_thread.get("provider"), bool(widget.asb_thread.get("pending")))
        if key != widget.asb_tooltip_key:
            widget.asb_tooltip_content = self.tooltip_content(widget.asb_thread, model)
            widget.asb_tooltip_key = key
        tooltip.set_custom(widget.asb_tooltip_content)
        return True

    def tooltip_content(self, row, model):
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        root.add_css_class("asb-tooltip")
        if self.hover_colors:
            root.add_css_class("asb-custom")
        def text(value, css, indent=0):
            widget = label(value, css)
            widget.set_wrap(True)
            widget.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
            widget.set_max_width_chars(36)
            widget.set_margin_start(indent)
            return widget
        path = Gtk.Box(spacing=7)
        mark = Gtk.Image(icon_name="asb-openai-symbolic" if row.get("provider") == "codex" else "asb-claude-symbolic",
                         pixel_size=14, valign=Gtk.Align.START)
        mark.add_css_class("asb-provider")
        path.append(mark)
        path_label = text(model["path"], "asb-tooltip-path")
        path_label.add_css_class("asb-tooltip-muted")
        path.append(path_label)
        root.append(path)
        root.append(text(model["title"], "asb-tooltip-title", 21))
        footer = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=False, min_children_per_line=1,
                             max_children_per_line=2, column_spacing=10, row_spacing=2, margin_start=21)
        footer.add_css_class("asb-tooltip-footer")
        state = text(model["state_text"], "asb-state")
        state.add_css_class("asb-" + model["state"])
        if model["state"] not in ("working", "waiting") and not row.get("pending"):
            state.add_css_class("dim-label")
        footer.append(state)
        app = Gtk.Box(spacing=5, halign=Gtk.Align.END)
        if model["app_color"]:
            app.append(SourceMarker(self, model["app_color"]))
        app_label = text(model["app"], "asb-tooltip-muted")
        app_label.set_xalign(1)
        app.append(app_label)
        footer.append(app)
        root.append(footer)
        if model["note"] or model["flags"] or model["error"]:
            notes = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, margin_start=21)
            notes.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL, margin_top=4, margin_bottom=4))
            if model["note"]:
                line = Gtk.Box(spacing=7)
                if model["indicator"]:
                    mark = Gtk.Box(valign=Gtk.Align.CENTER)
                    mark.add_css_class("asb-dot")
                    if model["indicator"] == "question":
                        mark.add_css_class("asb-question")
                        mark.append(label("?"))
                    elif model["indicator"] in ("stop", "discard"):
                        mark.add_css_class("asb-" + model["indicator"])
                    line.append(mark)
                note = text(model["note"], "asb-tooltip-note")
                if not model["indicator"]:
                    note.add_css_class("asb-tooltip-muted")
                line.append(note)
                notes.append(line)
            if model["flags"]:
                flags = text(model["flags"], "asb-tooltip-flags")
                flags.add_css_class("asb-tooltip-muted")
                notes.append(flags)
            if model["error"]:
                notes.append(text(model["error"], "asb-tooltip-note"))
            root.append(notes)
        return root

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
        if not layout_changed and widget.asb_thread == row \
                and source_marker_color(widget.asb_thread) == source_marker_color(row):
            self.update_drawer_style(widget)
            return
        if layout_changed or ((attention_indicator(row) in ("question", "dot", "stop")
                               or row.get("discardResult") != widget.asb_thread.get("discardResult"))
                              and attention_signature(widget.asb_thread) != attention_signature(row)):
            self.clear_read_feedback(widget)
        if getattr(widget, "asb_thread", row).get("state") != row.get("state"):
            self.open_errors.pop(row["id"], None)
        widget.asb_thread = dict(row)
        self.update_drawer_style(widget)
        quiet = self.view == "comfortable" and row.get("state") == "idle" \
            and not (row.get("unread") or row.get("questionAttention") or row.get("pending"))
        (widget.add_css_class if quiet else widget.remove_css_class)("asb-idle-read")
        widget.set_activatable(bool(row.get("canOpen")))
        if layout_changed:
            widget.asb_view = self.view
            widget.asb_action_signature = None
            for name in ("asb_folder", "asb_pin_button", "asb_read_button", "asb_drawer_button", "asb_age_label"):
                if hasattr(widget, name):
                    delattr(widget, name)
            content = Gtk.Box(spacing=6, margin_start=5, margin_end=5, valign=Gtk.Align.CENTER)
            mark = Gtk.Image(pixel_size=14)
            mark.add_css_class("asb-provider")
            widget.asb_mark = mark
            mark_overlay = Gtk.Overlay(child=mark)
            badge = SourceMarker(self)
            mark_overlay.add_overlay(badge)
            mark_overlay.set_measure_overlay(badge, False)
            widget.asb_source_badge = badge
            title = label("")
            title.add_css_class("asb-title")
            title.set_single_line_mode(True)
            title.set_ellipsize(Pango.EllipsizeMode.END)
            title.set_hexpand(True)
            widget.asb_title_label = title
            dot = Gtk.Box(valign=Gtk.Align.CENTER)
            dot.add_css_class("asb-dot")
            dot.append(label("?"))
            widget.asb_dot = dot
            state = label("", "asb-state")
            widget.asb_state_label = state
            if self.view == "comfortable":
                content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin_start=8,
                                  margin_end=8, margin_top=2, margin_bottom=2, valign=Gtk.Align.CENTER)
                workspace = Gtk.Box(spacing=7)
                workspace.set_margin_end(54)
                workspace.append(mark_overlay)
                folder = label("", "caption")
                folder.add_css_class("asb-folder")
                folder.add_css_class("dim-label")
                folder.set_ellipsize(Pango.EllipsizeMode.END)
                folder.set_hexpand(True)
                widget.asb_folder = folder
                workspace.append(folder)
                content.append(workspace)
                title.set_single_line_mode(False)
                title.set_wrap(True)
                title.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
                title.set_lines(2)
                title.set_size_request(-1, 32)
                title.set_margin_start(21)
                title.set_margin_end(54)
                content.append(title)
                metadata = Gtk.Box(spacing=6, margin_start=21)
                metadata.append(state)
                age = label("", "caption")
                age.add_css_class("asb-age")
                age.add_css_class("dim-label")
                age.set_ellipsize(Pango.EllipsizeMode.END)
                age.set_hexpand(True)
                age.set_halign(Gtk.Align.END)
                widget.asb_age_label = age
                metadata.append(age)
                content.append(metadata)
                overlay = Gtk.Overlay(child=content)
                actions = Gtk.Box(spacing=2, halign=Gtk.Align.END, valign=Gtk.Align.START,
                                  margin_end=5, margin_top=2)
                read_slot = Gtk.Box(width_request=24, height_request=24)
                read_icon = Gtk.Overlay(child=dot)
                dot.set_halign(Gtk.Align.CENTER)
                check = Gtk.Image(icon_name="object-select-symbolic", pixel_size=12,
                                  halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
                check.add_css_class("asb-read-cue")
                read_icon.add_overlay(check)
                read = Gtk.Button(child=read_icon)
                pin = Gtk.Button(child=Gtk.Image(icon_name="view-pin-symbolic", pixel_size=12))
                drawer = Gtk.Button(child=self.drawer_glyph())
                for button, name in ((drawer, "drawer"), (read, "read"), (pin, "pin")):
                    button.add_css_class("flat")
                    button.add_css_class("asb-card-action")
                    button.add_css_class("asb-" + name + "-button")
                    button.asb_card_action = name
                    button.set_action_target_value(GLib.Variant("s", row["id"]))
                widget.asb_drawer_button, widget.asb_read_button, widget.asb_pin_button = drawer, read, pin
                actions.append(drawer)
                read_slot.append(read)
                actions.append(read_slot)
                actions.append(pin)
                overlay.add_overlay(actions)
                overlay.set_measure_overlay(actions, False)
                content = overlay
            else:
                for child in (mark_overlay, title, dot, state):
                    content.append(child)
            widget.set_child(content)
        widget.asb_mark.set_from_icon_name("asb-openai-symbolic" if row["provider"] == "codex" else "asb-claude-symbolic")
        widget.asb_source_badge.set_color(source_marker_color(row))
        indicator = attention_indicator(row, True)
        (widget.add_css_class if indicator == "dot" else widget.remove_css_class)("asb-unread")
        (widget.add_css_class if indicator == "dot" and not row.get("unread") else widget.remove_css_class)("asb-drawer")
        discard_offer = self.view == "comfortable" and row.get("state") == "working" and not indicator
        widget.asb_dot.set_visible(bool(indicator) or discard_offer)
        widget.asb_dot.get_first_child().set_visible(indicator == "question")
        (widget.asb_dot.add_css_class if indicator == "question" else widget.asb_dot.remove_css_class)("asb-question")
        (widget.asb_dot.add_css_class if indicator == "stop" else widget.asb_dot.remove_css_class)("asb-stop")
        (widget.asb_dot.add_css_class if indicator == "discard" or discard_offer else widget.asb_dot.remove_css_class)("asb-discard")
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
            self.update_card_actions(widget)
        widget.asb_time_signature = None
        self.update_row_text(widget)

    def clear_read_feedback(self, widget):
        if getattr(widget, "asb_read_timer", None):
            GLib.source_remove(widget.asb_read_timer)
        widget.asb_read_timer = None
        widget.asb_read_generation = getattr(widget, "asb_read_generation", 0) + 1

    def update_card_actions(self, widget):
        if widget.asb_view != "comfortable":
            return
        row, read, pin = widget.asb_thread, widget.asb_read_button, widget.asb_pin_button
        drawer = getattr(widget, "asb_drawer_button", None)
        pending = row["id"] in self.session_actions
        indicator = attention_indicator(row, True)
        signature = (indicator, row.get("state"), row.get("actionRequired"), row.get("discardResult"),
                     row.get("pinned"), row.get("drawer"), row.get("title"), pending, bool(widget.asb_read_timer),
                     self.column_pixel_width >= 190)
        if signature == getattr(widget, "asb_action_signature", None):
            return
        widget.asb_action_signature = signature
        unread = indicator in ("question", "dot") and not row.get("actionRequired")
        discard = row.get("state") == "working" and indicator not in ("question", "dot")
        if discard and widget.asb_read_timer:
            self.clear_read_feedback(widget)
        confirmed = bool(widget.asb_read_timer)
        passive = bool(indicator) and not unread and not discard and not confirmed
        read.set_visible(bool(indicator) or discard or confirmed)
        read.set_focusable(not passive)
        (read.add_css_class if passive else read.remove_css_class)("asb-passive-indicator")
        (read.add_css_class if discard else read.remove_css_class)("asb-discard-button")
        (read.add_css_class if discard and not row.get("discardResult") else read.remove_css_class)("asb-discard-offer")
        action = "win.keep-result" if row.get("discardResult") else "win.discard-result"
        read.set_action_name((action if discard else "win.mark-read") if (unread or discard) and not pending else None)
        if confirmed:
            read.add_css_class("asb-read-confirmed")
        else:
            read.remove_css_class("asb-read-confirmed")
        pinned = bool(row.get("pinned"))
        pin.set_action_name(("win.unpin" if pinned else "win.pin") if not pending else None)
        (pin.add_css_class if pinned else pin.remove_css_class)("asb-pinned")
        # Keep native gestures active so busy controls and the Read cue cannot open the row.
        read_text = "A user action is required in the original app" if row.get("actionRequired") else "Task stopped" \
            if indicator == "stop" else "Read in ASB" if confirmed else "Mark read in ASB"
        if discard:
            read_text = "Keep result: show the dot when this task ends" if row.get("discardResult") \
                else "Discard result: go to read Idle when this task ends"
        controls = [(read, read_text, (unread or discard) and not pending), (pin, "Unpin in ASB" if pinned else "Pin in ASB", not pending)]
        if drawer:
            tucked = bool(row.get("drawer"))
            shown = self.column_pixel_width >= 190 and (tucked or indicator == "dot")
            drawer.set_visible(shown)
            (drawer.add_css_class if tucked else drawer.remove_css_class)("asb-drawer-filled")
            (drawer.get_parent().add_css_class if shown else drawer.get_parent().remove_css_class)("asb-corner-drawer")
            drawer.set_action_name(("win.drawer-out" if tucked else "win.drawer-in") if not pending else None)
            controls.append((drawer, "Take out of drawer: show as unread again" if tucked
                             else "Put in drawer: look read here, keep it under Drawer", not pending))
        for button, text, enabled in controls:
            button.set_sensitive(True)
            (button.add_css_class if pending else button.remove_css_class)("asb-action-pending")
            button.set_tooltip_text(text)
            button.update_property([Gtk.AccessibleProperty.LABEL], [text + ": " + row.get("title", "Untitled session")])
            button.update_state([Gtk.AccessibleState.BUSY, Gtk.AccessibleState.DISABLED], [pending, not enabled])

    def confirm_read(self, widget):
        self.clear_read_feedback(widget)
        generation = widget.asb_read_generation
        def clear():
            if not self.closed and self.focus_widgets.get(widget.asb_focus_key) is widget \
                    and widget.asb_view == "comfortable" and widget.asb_read_generation == generation:
                widget.asb_read_timer = None
                self.update_card_actions(widget)
            return False
        widget.asb_read_timer = GLib.timeout_add(1600, clear)
        self.update_card_actions(widget)

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
            widget.asb_age_label.set_label(duration or row_meta(row, now_ms).split(" · ")[1])
        shown = row.get("unread")
        action = "Open" if row.get("canOpen") else "Session"
        manual = " Marked as unread in ASB." if shown and row.get("manualUnread") else ""
        native_unread = " Unread in the original app." if shown and row.get("nativeAttention") else ""
        pinned = " Pinned in ASB." if row.get("pinned") else ""
        question = " A user action is required in the original app." if row.get("actionRequired") \
            else " Question needs your answer." if row.get("questionAttention") else ""
        retained = " Unread retained in ASB. Use Read to clear it." if shown and row.get("retainedUnread") else ""
        outcome = " Task stopped." if row.get("lastOutcome") == "stopped" else " Task failed." \
            if row.get("lastOutcome") == "failed" or row.get("failedAttention") else " Task completed." if row.get("completionAttention") else ""
        discard = " Discard is on." if row.get("discardResult") else ""
        drawer = " In the drawer. Still unread." if row.get("drawer") else ""
        widget.asb_accessible_label = f"{action} {row.get('title', 'Untitled session')} in {row.get('providerLabel', '')}. {state_text}.{manual}{native_unread}{pinned}{question}{retained}{outcome}{discard}{drawer}"
        self.update_open_state(widget, now_ms)

    def row_key(self, _controller, key, _code, _state, identity):
        if _state & SHORTCUT_MASK or (self.context_menu and self.context_menu.get_visible()):
            return False
        focus = self.get_focus()
        if key in (Gdk.KEY_space, Gdk.KEY_Return, Gdk.KEY_KP_Enter) and getattr(focus, "asb_card_action", None):
            if focus.get_sensitive() and focus.get_action_name():
                focus.activate()
            return True
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

    def row_action(self, _action, target, name):
        identity = target.get_string()
        if name in ("pin-up", "pin-down"):
            body = pin_move_body(self.visible_rows(), identity, "up" if name == "pin-up" else "down")
            if body:
                self.session_action(identity, "move-pin", body)
        else:
            self.session_action(identity, name)

    def session_action(self, identity, action, body=None):
        if identity in self.session_actions or self.closed:
            return
        guard_row = getattr(self, "row_cache", self.focus_widgets).get(identity)
        if ignore_discard_after_read(action, getattr(guard_row, "asb_last_read_at", None)):
            return
        self.session_actions.add(identity)
        origin = self.focus_widgets.get(identity)
        generation = getattr(origin, "asb_read_generation", None)
        attention = attention_signature(origin.asb_thread) if origin else None
        action_focus = getattr(self.get_focus(), "asb_card_action", None) if self.focus_key() == identity else None
        if origin:
            self.update_card_actions(origin)
        def finished(result, error):
            self.session_actions.discard(identity)
            if not self.closed:
                current = self.focus_widgets.get(identity)
                same_attention = current is origin and current is not None \
                    and current.asb_read_generation == generation and attention_signature(current.asb_thread) == attention
                confirm = action == "mark-read" and same_attention and current.asb_view == "comfortable"
                if error:
                    self.open_errors[identity] = error
                    if current:
                        self.update_card_actions(current)
                        self.update_open_state(current)
                        if action_focus and self.get_focus() is None:
                            self.set_focus(getattr(current, "asb_" + action_focus + "_button", current))
                if not error:
                    self.open_errors.pop(identity, None)
                    self.dashboard_etag = None
                    if action == "mark-read" and guard_row is not None and getattr(self, "row_cache", self.focus_widgets).get(identity) is guard_row:
                        guard_row.asb_last_read_at = time.monotonic()
                    if result.get("thread") and (action != "mark-read" or origin is None or same_attention):
                        self.dashboard["threads"] = [result["thread"] if row["id"] == identity else row for row in self.dashboard["threads"]]
                    if "pinnedOrder" in result:
                        order = result["pinnedOrder"]
                        for row in self.dashboard["threads"]:
                            row["pinned"] = row["id"] in order
                            row["pinIndex"] = order.index(row["id"]) if row["id"] in order else -1
                    restore_action = action_focus if self.get_focus() is None or self.focus_key() == identity else None
                    self.render(preserve_focus=identity if restore_action else None, preserve_action=restore_action)
                    current = self.focus_widgets.get(identity)
                    if current:
                        self.update_card_actions(current)
                        self.update_open_state(current)
                        if confirm and current is origin and current.asb_view == "comfortable" \
                                and current.asb_thread.get("state") != "working" and not attention_indicator(current.asb_thread):
                            self.confirm_read(current)
                    self.refresh(queue=True)
            return False
        request_async(self.base, "/api/threads/" + quote(identity, safe="") + "/" + action, finished, GLib.idle_add, "POST", body)

    def pin_drag_prepare(self, _source, _x, _y, identity):
        row = self.focus_widgets.get(identity)
        if not row or not row.asb_thread.get("pinned") or identity in self.opening:
            return None
        picked = row.pick(_x, _y, Gtk.PickFlags.DEFAULT)
        button = picked if getattr(picked, "asb_card_action", None) else picked.get_ancestor(Gtk.Button) if picked else None
        if getattr(button, "asb_card_action", None):
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

    def update_open_state(self, widget, now_ms=None):
        row = widget.asb_thread
        opening = row["id"] in self.opening
        error = self.open_errors.get(row["id"], "")
        widget.asb_open_signature = (opening, error)
        # One paragraph: the line limit of the label is for each paragraph, so a title with line breaks made a card many lines high.
        widget.asb_title_label.set_label("Opening…" if opening else " ".join(row.get("title", "").split()) or "Untitled session")
        widget.set_sensitive(not opening)
        duration = widget.asb_duration
        name = "Opening " + widget.asb_accessible_label.removeprefix("Open ") if opening else widget.asb_accessible_label
        if duration:
            name += " Working time " + duration + "."
        model = tooltip_model(row, time.time() * 1000 if now_ms is None else now_ms, Path.home(), error)
        widget.asb_tooltip = tooltip_description(model)
        description = widget.asb_tooltip
        widget.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION], [name, description])
        widget.update_state([Gtk.AccessibleState.BUSY], [opening])

    def open_row(self, _listing, widget):
        row = widget.asb_thread
        # A click on a card action reaches the row too: the busy state takes the action from the button, and GTK drops its claim.
        if not row.get("canOpen") or row["id"] in self.opening or row["id"] in self.session_actions:
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
                    self.refresh(queue=True)
            return False
        request_async(self.base, "/api/threads/" + quote(row["id"], safe="") + "/open", finished, GLib.idle_add, "POST")

    def on_close(self, *_args):
        self.closed = True
        if getattr(self, "sources_window", None):
            self.sources_window.close()
        self.cancel_scroll()
        self.cancel_motion()
        self.list_body.clear_hover()
        self.events.close()
        for name in ("timer", "clock_timer", "geometry_idle", "notice_timer"):
            source = getattr(self, name)
            if source:
                GLib.source_remove(source)
                setattr(self, name, None)
        if self.surface_signal:
            self.layout_surface.disconnect(self.surface_signal)
            self.surface_signal = self.layout_surface = None
        if self.context_menu:
            self.context_menu.popdown()
        for widget in self.row_cache.values():
            self.release_row(widget)
        self.row_cache.clear()
        self.focus_widgets.clear()
        for listing in getattr(self, "list_columns", []):
            listing.disconnect(listing.asb_activation)
            if listing.get_parent():
                self.list_body.remove(listing)
        self.list_columns = []
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
            # GTK focuses the search field on show; its cursor blink repaints the window.
            window.set_focus(None)
            return
        window.present()

    def close_windows(self):
        for window in self.get_windows():
            window.close()
        self.quit()
        return False


def main():
    try:
        base = local_base_url(sys.argv[1] if len(sys.argv) == 2 else "")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    GLib.set_application_name("ASB · Agent Switch Board")
    application = SwitchboardApplication(base)
    for sig in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, application.close_windows)
    return application.run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())
