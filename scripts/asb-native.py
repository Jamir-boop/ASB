#!/usr/bin/env python3
"""Native GNOME view for the local ASB session API."""
import json
import math
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
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

LOCAL_HTTP = build_opener(ProxyHandler({}))
ROW_HEIGHT = 22
COMFORTABLE_ROW_HEIGHT = 68
DEFAULT_COLUMN_WIDTH = 240
NUMBER_HOLD_MS = 400
APP_ID = "local.asb.AgentSwitchBoard"
STATES = ("working", "waiting", "idle", "unknown")
SOURCE_PROVIDERS = ("codex", "claude-desktop-code")
APP_PILLS = (("codex", "Codex"), ("claude-desktop-code", "Claude"), ("opencode", "OpenCode"))
APP_NAMES = {"codex": "Codex", "claude-desktop-code": "Claude Desktop Code", "opencode": "OpenCode"}
# The Preferences app list; every app selected is "All apps".
APP_CHOICES = (("All apps", frozenset()), ("Codex", frozenset({"codex"})), ("Claude", frozenset({"claude-desktop-code"})),
               ("OpenCode", frozenset({"opencode"})), ("Codex and Claude", frozenset({"codex", "claude-desktop-code"})),
               ("Codex and OpenCode", frozenset({"codex", "opencode"})),
               ("Claude and OpenCode", frozenset({"claude-desktop-code", "opencode"})))
# How Claude in a profile reaches Claude sessions on other machines (`remoteClaude`, plan 9.6).
REMOTE_CLAUDE = (("auto", "Automatic", "Claude in this profile reaches Claude sessions on other machines through ASB, unless both machines use Claude Remote Control."),
                 ("bridge", "Through ASB", "Claude in this profile always reaches Claude sessions on other machines through ASB."),
                 ("native", "Claude Remote Control only", "ASB does not add Claude sessions of other machines to this profile. Codex tasks of other machines stay."))
SOURCE_COLOR_PRESETS = (("Slate blue", "#8296b4"), ("Clay", "#b28f80"), ("Plum", "#a28caa"), ("Sage", "#899e91"))


def source_marker_color(row):
    count = row.get("sourceCount")
    if type(count) is not int or count <= 1 or row.get("sourceShowMarker", True) is not True:
        return ""
    try:
        return validate_source_color(row.get("sourceColor"))
    except ValueError:
        return ""


def provider_icon(provider):
    return {"codex": "asb-openai-symbolic", "opencode": "asb-opencode-symbolic"}.get(provider, "asb-claude-symbolic")


def app_filter(apps):
    """The provider filter of a selected-app set: no app or every app shows all."""
    return "all" if not apps or set(apps) >= {provider for provider, _title in APP_PILLS} else set(apps)


def app_choice(apps):
    return next((index for index, (_title, choice) in enumerate(APP_CHOICES) if choice == app_filter(apps)), 0)


def source_form_body(provider, name, data_dir, launcher, enabled, identity="", projects_dir="", color=None, show_marker=None,
                     remote_claude=None):
    # Only the default OpenCode source exists; new sources stay Codex or Claude.
    if provider not in SOURCE_PROVIDERS and not (provider == "opencode" and identity == "opencode") or type(enabled) is not bool:
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
    # Only Claude sources have this setting; the server refuses it for the others.
    if provider == "claude-desktop-code" and remote_claude is not None:
        if not isinstance(remote_claude, str) or remote_claude not in {value for value, _title, _note in REMOTE_CLAUDE}:
            raise ValueError("Remote Claude sessions must be Automatic, Through ASB, or Claude Remote Control only.")
        source["remoteClaude"] = remote_claude
    return {"source": source}


def source_revision(value):
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) else None


def source_edit_values(source):
    if source is None:
        return None
    return tuple(source.get(key, default) for key, default in (
        ("id", ""), ("provider", "codex"), ("label", ""), ("dataDir", ""), ("launcher", ""),
        ("projectsDir", ""), ("enabled", True), ("color", SOURCE_COLOR_PRESETS[0][1]),
        ("showMarker", True), ("builtin", False), ("remoteClaude", "auto")))


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
    actions.append(("Unmute", "unmute") if row.get("muted") else ("Mute", "mute"))
    actions.append(("Unpin", "unpin") if row.get("pinned") else ("Pin", "pin"))
    if row.get("pinned"):
        actions.extend((("Move pin earlier", "pin-up"), ("Move pin later", "pin-down")))
    if row.get("state") == "working" and not row.get("muted") and not row.get("remote"):
        actions.append(("Keep result", "keep-result") if row.get("discardResult") else ("Discard result", "discard-result"))
    return actions


def row_panel_controls(row):
    """The row panel switches from row_menu_actions: key -> (on, the action a toggle runs, or None when it is not offered)."""
    offered = {action for _title, action in row_menu_actions(row)}
    pick = lambda *names: next((name for name in names if name in offered), None)
    controls = {"unread": ("mark-unread" not in offered, pick("mark-read", "mark-unread")),
                "drawer": ("drawer-out" in offered, pick("drawer-out", "drawer-in")),
                "muted": ("unmute" in offered, pick("unmute", "mute")),
                "pinned": ("unpin" in offered, pick("unpin", "pin"))}
    if "pin-up" in offered:
        controls["order"] = (True, "pin-up")
    if offered & {"discard-result", "keep-result"}:
        controls["discard"] = ("keep-result" in offered, pick("keep-result", "discard-result"))
    return controls


def session_reference(row):
    """The app host and the app's own session ID, for example claude-proxy/local_<uuid>; never the ASB row ID."""
    host = row.get("sourceName") or (row["provider"] if row.get("provider") in ("codex", "opencode") else "claude-desktop-code")
    return host + "/" + str(row.get("externalId", ""))


def row_panel_note(row):
    """The subtitle of the panel Unread switch."""
    if row.get("actionRequired"):
        return "Waits for your permission."
    if row.get("questionAttention"):
        return "Asks a question."
    if (row.get("unread") or row.get("drawer")) and row.get("state") != "working":
        return "Marked unread." if row.get("manualUnread") else "Finished. Not read yet."
    return ""


def panel_place(x, y, width, height, window_width, window_height, margin=6):
    """Where a panel of this size, centered on x, points and opens ("bottom" or "top") to stay inside the window."""
    half = width / 2
    x = min(max(x, margin + half), window_width - margin - half) if window_width >= width + 2 * margin else window_width / 2
    if window_height - margin - y >= height or window_height - y >= y:
        return round(x), round(max(margin, min(y, window_height - margin - height))), "bottom"
    return round(x), round(min(window_height - margin, max(y, margin + height))), "top"


def edge_color(base, color, fraction, surfaces):
    """The weakest mix of color into base, from fraction up, with 3:1 contrast on each surface."""
    for percent in range(round(fraction * 100), 101):
        value = mix_color(base, color, percent / 100)
        if all(contrast(value, surface) >= 3 for surface in surfaces):
            return value
    return color


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
        if row.get("unread") or (drawer and row.get("drawer") and row.get("state") != "working" and not limit_left(row)) \
        else "discard" if row.get("state") == "working" and row.get("discardResult") \
        else "stop" if row.get("state") == "idle" and row.get("lastOutcome") == "stopped" else ""


def ignore_discard_after_read(action, last_read_at, now=None):
    now = time.monotonic() if now is None else now
    return action in ("discard-result", "keep-result") and last_read_at is not None and now - last_read_at < .5


def provider_query(query, app="all"):
    match = re.match(r"^\s*(cl|claude|cx|codex|oc|opencode)\s*:\s*(.*)$", query, re.IGNORECASE | re.DOTALL)
    if match:
        app = {"cl": "claude-desktop-code", "claude": "claude-desktop-code", "cx": "codex",
               "codex": "codex", "oc": "opencode", "opencode": "opencode"}[match[1].lower()]
        query = match[2]
    return query.strip().casefold(), app


def filtered_rows(dashboard, query="", app="all", state="all", archived=False, pending_only=False, drawer_only=False):
    query, app = provider_query(query, app)
    states = set(STATES) if state == "all" else {state} if isinstance(state, str) else set(state)
    working_or_unread = pending_only and states == {"working"}
    rows = [row for row in dashboard.get("threads", [])
            if (archived or not row.get("archived"))
            and (not drawer_only or row.get("drawer"))
            and (app == "all" or row.get("provider") in ({app} if isinstance(app, str) else app))
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


def column_moves(current, target):
    """The cards to take out of a column and the (index, card) inserts, in index order, that turn current into target.
    The longest run of cards that already has the target order stays in place."""
    place = {card: index for index, card in enumerate(target)}
    kept = [place[card] for card in current if card in place]
    tails, previous = [], [None] * len(kept)
    for position, index in enumerate(kept):
        low, high = 0, len(tails)
        while low < high:
            middle = (low + high) // 2
            if kept[tails[middle]] < index:
                low = middle + 1
            else:
                high = middle
        previous[position] = tails[low - 1] if low else None
        tails[low:low + 1] = [position]
    stay, position = set(), tails[-1] if tails else None
    while position is not None:
        stay.add(target[kept[position]])
        position = previous[position]
    return [card for card in current if card not in stay], [(index, card) for index, card in enumerate(target) if card not in stay]


THEME_KEYS = ("background", "text", "accent", "muted", "divider")
THEME_PATH = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "asb" / "theme.json"
LAYOUT_PATH = THEME_PATH.with_name("layout.json")


def number_key_rows(rows, bounds, viewport):
    """The IDs that Ctrl+1 to Ctrl+9 open: openable rows fully in the viewport, in board order."""
    width, height = viewport
    keys = []
    for row in rows:
        box = bounds.get(row["id"])
        if row.get("canOpen") and box and box[2] > 0 and box[3] > 0 and width > 0 and height > 0 \
                and box[0] >= -.5 and box[1] >= -.5 and box[0] + box[2] <= width + .5 and box[1] + box[3] <= height + .5:
            keys.append(row["id"])
            if len(keys) == 9:
                break
    return keys


def number_key(keyval):
    """1 to 9 for the digit and keypad digit keys (X keysyms), else 0."""
    return keyval - 0x30 if 0x31 <= keyval <= 0x39 else keyval - 0xffb0 if 0xffb1 <= keyval <= 0xffb9 else 0


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


MESSAGE_MAX_AGE_MS = 30_000
MESSAGE_FLIGHT_LIMIT = 6
MESSAGE_LIGHT_MS = 2000


def new_messages(messages, seen, visible, now_ms, room):
    """Message keys to play now and the keys to keep as seen; the first dashboard (seen None) plays nothing."""
    keys, play, pairs = set(), [], set()
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        source, target, at = message.get("from"), message.get("to"), message.get("atMs")
        if not isinstance(source, str) or not isinstance(target, str) or type(at) not in (int, float):
            continue
        key = (source, target, at)
        keys.add(key)
        if seen is None or key in seen or now_ms - at > MESSAGE_MAX_AGE_MS or source == target \
                or source not in visible or target not in visible or (source, target) in pairs or len(play) >= room:
            continue
        pairs.add((source, target))
        play.append(key)
    return play, keys


def message_duration(distance):
    return min(900, max(480, distance / 1.5))


def message_control(start, end):
    """Quadratic Bezier control point: bow to the upper side for mostly horizontal travel, else to the left."""
    dx, dy = end[0] - start[0], end[1] - start[1]
    distance = math.hypot(dx, dy)
    x, y = (start[0] + end[0]) / 2, (start[1] + end[1]) / 2
    if distance:
        bow = min(60, .22 * distance)
        nx, ny = -dy / distance, dx / distance
        sign = -1 if (ny > 0 if abs(dx) >= abs(dy) else nx > 0) else 1
        x, y = x + sign * nx * bow, y + sign * ny * bow
    return max(2, x), y


def bezier_point(start, control, end, t):
    u = 1 - t
    return tuple(u * u * a + 2 * u * t * b + t * t * c for a, b, c in zip(start, control, end))


def ease_in_out_cubic(t):
    return 4 * t ** 3 if t < .5 else 1 - (-2 * t + 2) ** 3 / 2


def message_tail(t):
    """Tail segments (from, to, width, alpha) behind the head at linear time t, in eased path progress.
    The steps are in time, so the tail stretches with the speed of the light; it stops at 0."""
    segments = []
    for k in range(1, 9):
        first = t - (k - 1) * .025
        if first <= 0:
            break
        segments.append((ease_in_out_cubic(first), ease_in_out_cubic(max(0, t - k * .025)),
                         3.2 * (1 - k / 9), .7 * (1 - k / 9)))
    return segments


def message_edge(x, left, right):
    """An x outside the viewport moves to the edge on that side, 2 px inside."""
    return left + 2 if x < left else right - 2 if x > right else x


def edge_alpha(ms):
    """Edge mark: 0 to 1 in 120 ms, hold 300 ms, to 0 in 300 ms."""
    return max(0, min(1, ms / 120, 1 - (ms - 420) / 300))


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


def limited_color(colors):
    """The text color of a limited row: the dimmest mix of text into the background with 4.5:1 on the background."""
    return quiet_color(colors, "text", 0, colors["background"])


def number_badge_colors(colors):
    """Custom Ctrl-number badge: 17% text into the background, less only as far as the text needs for 4.5:1."""
    for percent in range(17, -1, -1):
        fill = mix_color(colors["background"], colors["text"], percent / 100)
        if contrast(colors["text"], fill) >= 4.5:
            break
    pressed = max(("#000000", "#ffffff"), key=lambda ink: contrast(colors["accent"], ink))
    return fill, mix_color(colors["background"], colors["text"], .36), pressed


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


def palette_payload(custom, native=None, success=None, warning=None):
    """The palette for POST /api/palette: custom colors, or the GNOME colors with the GNOME success and warning colors."""
    if custom:
        return {"mode": "custom", "colors": {**{key: custom[key] for key in THEME_KEYS},
                                             "success": custom["accent"], "warning": custom["accent"]}}
    return {"mode": "gnome", "colors": {**{key: native[key] for key in THEME_KEYS},
                                        "success": success or native["accent"], "warning": warning or native["accent"]}}


def validate_column_width(width):
    if type(width) is not int or not 160 <= width <= 600:
        raise ValueError("Column width must be a whole number from 160 to 600 pixels.")
    return width


def read_layout(path):
    if not path or not Path(path).exists():
        return {"columnWidth": DEFAULT_COLUMN_WIDTH, "view": "compact", "showAppPills": False}
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict) or not {"version", "columnWidth"}.issubset(value) \
            or set(value) - {"version", "columnWidth", "view", "showAppPills"} or value["version"] != 1:
        raise ValueError("The saved layout is not valid. Reset the width.")
    view = value.get("view", "compact")
    if view not in ("compact", "comfortable"):
        raise ValueError("Choose Compact or Comfortable view.")
    show_apps = value.get("showAppPills", False)
    if type(show_apps) is not bool:
        raise ValueError("Show app pills must be on or off.")
    return {"columnWidth": validate_column_width(value["columnWidth"]), "view": view, "showAppPills": show_apps}


def write_layout(path, width=None, view=None, show_app_pills=None):
    explicit_apps = show_app_pills is not None
    if view is None or show_app_pills is None:
        saved = read_layout(path)
        view = saved["view"] if view is None else view
        show_app_pills = saved["showAppPills"] if show_app_pills is None else show_app_pills
    if view not in ("compact", "comfortable"):
        raise ValueError("Choose Compact or Comfortable view.")
    if type(show_app_pills) is not bool:
        raise ValueError("Show app pills must be on or off.")
    if width is None and view == "compact" and not show_app_pills and not explicit_apps:
        write_config(path, None)
        return
    value = {"version": 1, "columnWidth": validate_column_width(DEFAULT_COLUMN_WIDTH if width is None else width)}
    if view == "comfortable":
        value["view"] = view
    if show_app_pills or explicit_apps:
        value["showAppPills"] = show_app_pills
    write_config(path, value)


def filter_chips(apps, states, archived, show_app_pills=False):
    chips = []
    if app_filter(apps) != "all" and not show_app_pills:
        title = ", ".join(name for provider, name in APP_PILLS if provider in apps)
        chips.append(("app", title, f"Clear app filter: {title}"))
    if set(states) not in (set(STATES), {"working"}):
        names = ", ".join(state.capitalize() for state in STATES if state in states)
        title = names or "No states"
        chips.append(("states", title, "Clear state filter: " + (names or "No states")))
    if archived:
        chips.append(("archive", "Include archived", "Hide archived sessions"))
    return tuple(chips)


def working_duration(row, now_ms=None):
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    start = row.get("workingSinceMs", 0)
    if row.get("state") != "working" or isinstance(start, bool) or not isinstance(start, (int, float)) or not 0 < start <= now_ms:
        return ""
    return duration_text(int((now_ms - start) / 1000))


def duration_text(seconds):
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}h{minutes}m" if hours else f"{minutes}m{seconds}s" if minutes else f"{seconds}s"


def spoken_duration(seconds):
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    unit = lambda count, word: f"{count} {word}" + ("" if count == 1 else "s")
    if hours:
        return unit(hours, "hour") + (" " + unit(minutes, "minute") if minutes else "")
    return unit(minutes, "minute") + (" " + unit(seconds, "second") if seconds else "") if minutes else unit(seconds, "second")


def limit_text(seconds):
    """The reset countdown: days and hours from 24 hours on (weekly limits), else the Working time format."""
    days, remainder = divmod(seconds, 86400)
    return f"{days}d{remainder // 3600}h" if days else duration_text(seconds)


def spoken_limit(seconds):
    days, remainder = divmod(seconds, 86400)
    if not days:
        return spoken_duration(seconds)
    hours = remainder // 3600
    unit = lambda count, word: f"{count} {word}" + ("" if count == 1 else "s")
    return unit(days, "day") + (" " + unit(hours, "hour") if hours else "")


def limit_left(row, now_ms=None):
    """Whole seconds, rounded up, until the usage limit that stopped the row resets; 0 when no limit holds the row."""
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    reset = row.get("limitResetsAtMs", 0)
    if isinstance(reset, bool) or not isinstance(reset, (int, float)) or not math.isfinite(reset) or reset <= now_ms:
        return 0
    return math.ceil((reset - now_ms) / 1000)


def clock_interval(threads, now_ms=None):
    """Seconds between local clock ticks: 2 for a Working timer or a reset countdown under one hour, else 60."""
    return 2 if any(row.get("state") == "working" and not row.get("archived") or 0 < limit_left(row, now_ms) <= 3600
                    for row in threads) else 60


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


def is_view_only(row):
    """A CLI session or a session on another machine shows as a card but does not open from ASB."""
    return bool(row.get("remote")) or row.get("surface") == "cli"


def row_where(row):
    """The (icon, text) that says where a view-only session runs; (None, "") for other rows."""
    if row.get("remote"):
        return "asb-machine-symbolic", row.get("machineName") or "another machine"
    if row.get("surface") == "cli":
        return "asb-terminal-symbolic", "CLI"
    return None, ""


def view_only_tone(row):
    """The Grey tone of a view-only row with no attention: "quiet" keeps the state color, "rest" also dims the state."""
    if (not is_view_only(row) or row.get("unread") or row.get("questionAttention") or row.get("pending")
            or (row.get("limitResetsAtMs") or 0) > 0):
        return ""
    return "quiet" if row.get("state") in ("working", "waiting") else "rest"


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
    provider = row.get("providerLabel") or APP_NAMES.get(row.get("provider"), "Unknown app")
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
    flags = " · ".join(text for key, text in (("pinned", "Pinned"), ("archived", "Archived"), ("drawer", "In the drawer"), ("muted", "Muted")) if row.get(key))
    if is_view_only(row):
        machine = row.get("machineName") or "another machine"
        where = " · ".join(([f"On {machine}"] if row.get("remote") else []) + (["CLI session"] if row.get("surface") == "cli" else []))
        flags += (" · " if flags else "") + where
        flags += f". Open it on {machine}." if row.get("remote") else ". Runs in a terminal. ASB does not open CLI sessions."
    elif not row.get("canOpen"):
        flags += (" · " if flags else "") + "No direct link"
        if row.get("provider") == "opencode":
            flags += ". OpenCode cannot open one session from a link."
    source = "App source: " + (source_label or source_id) if source_label or source_id else ""
    if source_label and source_id:
        source += " (" + source_id + ")"
    app_color = source_marker_color(row)
    if app_color:
        source += (". " if source else "") + "Profile color marker: " + app_color
    limit = ""
    if limit_left(row, now_ms):
        # A locale with no AM/PM marker needs the 24-hour form, or 20:28 reads as 8:28.
        reset_at = time.localtime(row["limitResetsAtMs"] / 1000)
        reset = time.strftime("%I:%M %p", reset_at).lstrip("0") if time.strftime("%p") else time.strftime("%H:%M", reset_at)
        now_at = time.localtime((time.time() * 1000 if now_ms is None else now_ms) / 1000)
        day = "" if reset_at[:3] == now_at[:3] else " " + time.strftime("%A", reset_at)
        # A reset 6 to 7 days away has the weekday of today, so it also needs the date.
        if day and reset_at.tm_wday == now_at.tm_wday:
            day += f" {reset_at.tm_mday} " + time.strftime("%B", reset_at)
        limit = f"{source_label or provider} is out of usage. It resets{day} at {reset}."
    return {"path": path, "full_path": full_path, "title": row.get("title") or "Untitled session",
            "state": state, "state_text": state_text, "app": app, "app_color": app_color,
            "indicator": shape, "note": note, "flags": flags, "error": error,
            "reason": row.get("reason", ""), "source": source, "limit": limit}


def tooltip_description(model):
    return "\n".join(filter(None, (model["title"], model["full_path"], model["state_text"], model["app"],
                                  model["reason"], model["source"], model["limit"], model["note"], model["flags"], model["error"])))


def local_base_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port \
            or parsed.username or parsed.password or parsed.path not in ("", "/") \
            or parsed.query or parsed.fragment:
        raise ValueError("Use the local ASB address: http://127.0.0.1:<port>.")
    return value.rstrip("/")


SOURCE_TOKEN = os.environ.get("ASB_SOURCE_TOKEN", "")


def group_fingerprint(value):
    return " ".join(value[index:index + 4] for index in range(0, len(value), 4))


PHONE_KINDS = {"lan": "Home network", "zerotier": "ZeroTier", "tailscale": "Tailscale"}
PHONE_OVERLAY_NOTE = "Install and join ZeroTier or Tailscale on this PC and the phone to use ASB away from home."


def phone_status_text(status):
    if status.get("running"):
        port = status.get("port", 4630)
        running = "Running at " + ", ".join(f"https://{item['address']}:{port} ({PHONE_KINDS.get(item['kind'], item['kind'])})"
                                            for item in status.get("listening", []))
        return "\n".join(filter(None, (running, status.get("error", ""))))
    if status.get("error"):
        return status["error"]
    if not status.get("enabled"):
        return "Phone access is off."
    return "Phone access is not running. Apply the settings to try again."


def phone_address_rows(addresses, selected=()):
    rows = [{"address": item["address"], "title": PHONE_KINDS[item["kind"]],
             "subtitle": item["address"] + ("" if item["kind"] == "lan" else " · Works away from home")}
            for item in addresses if item.get("kind") in PHONE_KINDS]
    # A saved address that is absent now (ZeroTier is off) stays, so Apply does not drop it.
    shown = {row["address"] for row in rows}
    return rows + [{"address": address, "title": "Not on this PC now",
                    "subtitle": address + " · ASB listens on it when it appears"}
                   for address in selected if address not in shown]


def phone_form_values(loaded, form, status):
    """The (enabled, port, checked addresses) to show after a status read. A form that differs from the last
    loaded values has unsaved edits, so it stays; otherwise the form follows the server."""
    server = (status.get("enabled", False), status.get("port", 4630), list(status.get("bindAddresses", [])))
    if loaded is None or form is None or (form[0], form[1], set(form[2])) == (loaded[0], loaded[1], set(loaded[2])):
        return server
    return form


def phone_address_note(addresses):
    kinds = {item.get("kind") for item in addresses}
    return " ".join(filter(None, ("" if addresses else "No private network address on this PC.",
                                  "" if kinds & {"zerotier", "tailscale"} else PHONE_OVERLAY_NOTE)))


def qr_matrix(uri):
    try:
        import qrcode
    except ImportError:
        return None
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
    code.add_data(uri)
    code.make(fit=True)
    return code.get_matrix()


MACHINE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}")
MACHINE_INTRO = ("Machines in a group show each other's sessions as view-only cards. "
                 "They connect over the addresses that you select in Phone.")
MACHINE_ALONE = "This machine is not in a group. Add a machine to make a group, or join the group of another machine."
MACHINE_OFF = "Network access is off. Machines connect over the same private addresses as phones."


def machine_status_text(member, now_ms=None):
    if member.get("isSelf"):
        return "This machine"
    if member.get("online"):
        return "Online"
    if not member.get("lastOkAtMs"):
        return "Offline"
    return "Offline · last seen " + row_meta({"updatedAtMs": member["lastOkAtMs"]}, now_ms).split(" · ", 1)[1]


def machine_addresses_text(member):
    return " · ".join(f"{item['address']} ({PHONE_KINDS.get(item['kind'], item['kind'])})" for item in member.get("addresses", []))


def machine_member_subtitle(member, now_ms=None):
    return "\n".join(filter(None, (f"{machine_status_text(member, now_ms)} · ID {member['machineId'][:8]}",
                                    machine_addresses_text(member))))


def machine_phones_text(phones):
    if not phones:
        return ""
    return ("Phones in the group: " + ", ".join(phone["name"] for phone in phones)
            + ". A phone paired on one machine works with all of them.")


def machines_view(group):
    on, grouped = bool(group.get("networkEnabled")), bool(group.get("groupId"))
    return {"off": not on, "grouped": grouped, "others": [member for member in group.get("members", []) if not member.get("isSelf")],
            "add": on, "join": on, "join_visible": not grouped, "leave_visible": grouped}


def machine_names_text(names):
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def machine_confirm_body(others, removed=""):
    """The alert body for Remove (removed is the machine name) or Leave; others are the other active machine names."""
    if removed:
        stop = f"This PC and {machine_names_text(others)} stop" if others else "This PC stops"
        return (f"{removed} leaves the group. {stop} showing its sessions, and it stops showing theirs. "
                f"To join again, {removed} must reset its identity first.")
    return " ".join(filter(None, (f"This PC stops showing the sessions of {machine_names_text(others)}, and they stop showing its sessions."
                                  if others else "", "Phones that were paired on another machine stop working with this PC.")))


def join_link_summary(text):
    """The inviter name and fingerprint to compare, or None. The engine checks the rest of the link."""
    text = text.strip()
    if not text.startswith("asb://join?"):
        return None
    values = {}
    for part in text[len("asb://join?"):].split("&"):
        pieces = part.split("=")
        if len(pieces) != 2 or pieces[0] in values:
            return None
        values[pieces[0]] = unquote(pieces[1])
    if set(values) != set("vgapfcn") or values["v"] != "1" or not re.fullmatch(r"[a-f0-9]{64}", values["f"]) \
            or not MACHINE_NAME.fullmatch(values["n"]):
        return None
    return {"name": values["n"], "fingerprint": values["f"]}


def machine_invite_text(expires_at_ms):
    ends = time.strftime("%H:%M", time.localtime(expires_at_ms / 1000))
    return ("On the other machine, open Preferences > Machines, select Join a group, and paste this link. "
            f"The link works once and ends at {ends}.")


def request_json(base, route, method="GET", body=None, etag=None, headers=None):
    headers = {"Accept": "application/json", **(headers or {})}
    path = route.split("?", 1)[0]
    source_route = path == "/api/sources" or path.startswith("/api/sources/")
    phone_route = path == "/api/phone" or path.startswith("/api/phone/")
    group_route = path == "/api/group" or path.startswith("/api/group/")
    service_route = path == "/api/service"
    palette_route = path == "/api/palette"
    agent_route = path.startswith("/api/agent/")
    engine_route = path.startswith("/api/engine/")
    data = None
    if etag and etag[0] and method == "GET" and route.split("?")[0] == "/api/dashboard":
        headers["If-None-Match"] = etag[0]
    if SOURCE_TOKEN and ((source_route and method == "POST") or phone_route or group_route or service_route or palette_route or agent_route or engine_route):
        headers["X-ASB-Source-Token"] = SOURCE_TOKEN
    if method == "POST":
        headers.update({"Origin": base, "Content-Type": "application/json"})
        data = json.dumps(body or {}).encode()
    request = Request(base + route, data=data, headers=headers, method=method)
    try:
        # Join and leave wait for the other machines.
        timeout = 30 if method == "POST" and path in ("/api/group/join", "/api/group/leave") else 15
        with LOCAL_HTTP.open(request, timeout=timeout) as response:
            result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("The ASB response is not an object.")
        success = "opened" if route.endswith("/open") else "marked" if route.endswith("/mark-unread") else "changed"
        if method == "POST" and not (phone_route or group_route or service_route or palette_route or agent_route or engine_route) and not result.get(success):
            raise ValueError("The session action did not succeed.")
        if etag is not None:
            etag[0] = response.headers.get("ETag")
        return result
    except (HTTPError, URLError, HTTPException, OSError, ValueError) as error:
        if isinstance(error, HTTPError) and error.code == 304 and "If-None-Match" in headers:
            error.close()
            return None
        if source_route or phone_route or group_route or service_route or palette_route or agent_route or engine_route:
            detail = ""
            if isinstance(error, HTTPError):
                try:
                    payload = json.loads(error.read(8192))
                    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                        detail = payload["error"]
                        suggestion = payload.get("suggestion")
                        if group_route and isinstance(suggestion, str) and MACHINE_NAME.fullmatch(suggestion):
                            detail += f" Try the name {suggestion}."
                except (HTTPException, OSError, ValueError):
                    pass
            subject = "phone access" if phone_route else "the machine group" if group_route else "the ASB service" if service_route \
                else "the phone palette" if palette_route else "the native UI status" if agent_route else "ASB" if engine_route else "app sources"
            raise RuntimeError(detail or f"Cannot load or change {subject}. Check that ASB is running, then try again.") from error
        action = "open this session" if route.endswith("/open") else "change the unread setting" if route == "/api/settings/unread" \
            else "change this session" if method == "POST" else "load sessions"
        recovery = "Check the app link handler, then try again." if route.endswith("/open") \
            else "Check that ASB is running, then try again." if route == "/api/settings/unread" \
            else "Refresh the session list, then try again." if method == "POST" else "Check that ASB is running, then refresh."
        raise RuntimeError(f"Cannot {action}. {recovery}") from error


def request_async(base, route, callback, dispatch, method="GET", body=None, etag=None, headers=None):
    def work():
        try:
            result, error = request_json(base, route, method, body, etag, headers), None
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
        self.flights = []
        self.connect("unmap", self.clear_flights)

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
        if self.flights:
            self.snapshot_flights(snapshot)

    def message_view(self):
        # The strip starts after its 4 px margin inside the scrolled viewport.
        adjustment = self.get_root().scroll.get_hadjustment()
        left = adjustment.get_value() - self.get_margin_start()
        return left, left + adjustment.get_page_size()

    def message_point(self, row):
        """The painted center of a row's provider icon in strip coordinates, during a card glide too."""
        found, bounds = row.asb_mark.compute_bounds(self)
        if not found:
            return None
        x, y, _fade = self.motion.get(row.asb_focus_key, (0, 0, 0))
        return (bounds.origin.x + bounds.size.width / 2 + x * self.motion_progress,
                bounds.origin.y + bounds.size.height / 2 + y * self.motion_progress)

    def message_ends(self, flight):
        points = [self.message_point(row) for row in flight["rows"]]
        if None in points:
            return None
        left, right = self.message_view()
        return [(message_edge(x, left, right), y, message_edge(x, left, right) != x) for x, y in points]

    def start_flight(self, source, target, color, ends):
        flight = {"rows": (source, target), "color": color, "flight": 0, "ring": None, "edge": None, "edge_end": 0,
                  "animations": []}
        def animation(key, duration, easing, value_to=1):
            callback = Adw.CallbackAnimationTarget.new(lambda value: self.advance_flight(flight, key, value))
            item = Adw.TimedAnimation.new(self, 0, value_to, duration, callback)
            item.set_easing(easing)
            item.connect("done", self.flight_done, flight, key)
            flight["animations"].append(item)
            return item
        flight["ring_animation"] = animation("ring", 420, Adw.Easing.EASE_OUT_EXPO)
        flight["edge_animation"] = animation("edge", 720, Adw.Easing.LINEAR, 720)
        self.flights.append(flight)
        # Linear time: the paint eases the path position, so the tail stretches with speed.
        animation("flight", round(message_duration(math.dist(ends[0][:2], ends[1][:2]))), Adw.Easing.LINEAR).play()
        if ends[0][2]:
            flight["edge_animation"].play()

    def advance_flight(self, flight, key, value):
        if flight in self.flights:
            flight[key] = value
            self.queue_draw()

    def flight_done(self, _animation, flight, key):
        if flight not in self.flights:
            return
        flight[key] = None
        if key == "flight":
            ends = self.message_ends(flight)
            if ends and ends[1][2]:
                # The light reaches the viewport edge: the edge mark flashes there, and no ring shows.
                flight["edge_end"] = 1
                flight["edge_animation"].reset()
                flight["edge_animation"].play()
            else:
                flight["ring_animation"].play()
        elif flight["flight"] is None and flight["ring"] is None and flight["edge"] is None:
            self.flights.remove(flight)
            self.queue_draw()

    def drop_flights(self, flights):
        for flight in flights:
            if flight in self.flights:
                self.flights.remove(flight)
            for item in flight["animations"]:
                item.pause()

    def clear_flights(self, *_args):
        if self.flights:
            self.drop_flights(list(self.flights))
            self.queue_draw()

    def snapshot_flights(self, snapshot):
        current = self.get_root().focus_widgets
        gone = [flight for flight in self.flights
                if any(current.get(row.asb_focus_key) is not row for row in flight["rows"])]
        # The callbacks of dropped flights do nothing, so no draw is queued during this paint.
        self.drop_flights(gone)
        for flight in self.flights:
            ends = self.message_ends(flight)
            if ends is None:
                continue
            start, end = ends[0][:2], ends[1][:2]
            def color(alpha):
                value = flight["color"].copy()
                value.alpha *= alpha
                return value
            def fill(x, y, radius, alpha):
                builder = Gsk.PathBuilder.new()
                builder.add_circle(Graphene.Point().init(x, y), radius)
                snapshot.append_fill(builder.to_path(), Gsk.FillRule.WINDING, color(alpha))
            def stroke(path, width, alpha):
                line = Gsk.Stroke.new(width)
                line.set_line_cap(Gsk.LineCap.ROUND)
                snapshot.append_stroke(path, line, color(alpha))
            if flight["edge"] is not None and edge_alpha(flight["edge"]) > 0:
                x, y, outside = ends[flight["edge_end"]]
                if outside:
                    bounds = Graphene.Rect()
                    bounds.init(x - 1.5, y - 9, 3, 18)
                    rounded = Gsk.RoundedRect()
                    rounded.init_from_rect(bounds, 1.5)
                    snapshot.push_rounded_clip(rounded)
                    snapshot.append_color(color(edge_alpha(flight["edge"])), bounds)
                    snapshot.pop()
            if flight["flight"] is not None:
                control = message_control(start, end)
                for first, last, width, alpha in message_tail(flight["flight"]):
                    builder = Gsk.PathBuilder.new()
                    builder.move_to(*bezier_point(start, control, end, first))
                    builder.line_to(*bezier_point(start, control, end, last))
                    stroke(builder.to_path(), width, alpha)
                head = bezier_point(start, control, end, ease_in_out_cubic(flight["flight"]))
                fill(*head, 6, .25)
                fill(*head, 3, 1)
            elif flight["ring"] is not None:
                builder = Gsk.PathBuilder.new()
                builder.add_circle(Graphene.Point().init(*end), 5 + 8 * flight["ring"])
                stroke(builder.to_path(), 1.5, .85 * (1 - flight["ring"]))


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
        self.color_class = ""
        self.set_color(color)

    def set_color(self, color):
        try:
            self.configured_color = validate_source_color(color)
        except ValueError:
            self.configured_color = ""
        displayed = display_source_color(self.configured_color, self.owner.profile_surfaces) if self.configured_color else ""
        self.set_visible(bool(displayed))
        name = self.owner.badge_class(displayed) if displayed else ""
        if name != self.color_class:
            if self.color_class:
                self.remove_css_class(self.color_class)
            if name:
                self.add_css_class(name)
            self.color_class = name


class AppSourcesEditor(Gtk.Box):
    def __init__(self, owner, preferences):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.preferences = preferences
        self.owner, self.base = owner, owner.base
        self.closed = self.loading = self.choosing = self.loaded = self.editing = False
        self.active = self.refresh_queued = self.rendering = self.setting_form = self.conflict = False
        self.revision = self.edit_revision = self.observed_revision = self.form_baseline = self.baseline_source = None
        self.sources, self.max_sources, self.editing_id = [], 8, ""
        self.preset_markers, self.table_markers = [], []
        self.cancellable = Gio.Cancellable()
        content = self
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
        self.provider = Gtk.DropDown.new_from_strings(["Codex", "Claude Desktop Code"])
        self.provider.connect("notify::selected", self.provider_changed)
        self.name, self.data_dir, self.launcher, self.projects_dir = (Gtk.Entry(hexpand=True) for _ in range(4))
        self.name.set_max_length(80)
        self.projects_dir.set_placeholder_text("Default: ~/.claude/projects")
        self.launcher.set_placeholder_text("Installed app launcher required")
        self.transcript_widgets, self.choose_buttons, self.fixed_provider = [], [], ""
        for title, widget, folder in (("Name", self.name, None), ("App", self.provider, None),
                ("Session folder", self.data_dir, True), ("Open with", self.launcher, False),
                ("Transcript folder", self.projects_dir, True)):
            caption = label(title)
            caption.set_mnemonic_widget(widget)
            widget.update_property([Gtk.AccessibleProperty.LABEL], [title])
            field = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            field.append(caption)
            line = Gtk.Box(spacing=8)
            widget.set_hexpand(True)
            line.append(widget)
            field.append(line)
            self.form.append(field)
            if folder is not None:
                choose = Gtk.Button(label="Choose…", tooltip_text="Choose " + title.lower())
                choose.update_property([Gtk.AccessibleProperty.LABEL], ["Choose " + title.lower()])
                choose.connect("clicked", lambda _button, entry=widget, directory=folder: self.choose_path(entry, directory))
                line.append(choose)
                if widget is not self.projects_dir:
                    self.choose_buttons.append(choose)
            if widget is self.provider:
                self.provider_text = label("")
                self.provider_text.set_xalign(0)
                self.provider_text.set_visible(False)
                line.append(self.provider_text)
            if widget is self.projects_dir:
                self.transcript_widgets = [field]
        # Claude only, like Transcript folder: the note under the choice says what it does.
        self.remote_claude = Gtk.DropDown.new_from_strings([title for _value, title, _note in REMOTE_CLAUDE])
        self.remote_claude.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                           ["Remote Claude sessions", REMOTE_CLAUDE[0][2]])
        caption = label("Remote Claude sessions")
        caption.set_mnemonic_widget(self.remote_claude)
        field = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        field.append(caption)
        line = Gtk.Box(spacing=8)
        self.remote_claude.set_hexpand(True)
        line.append(self.remote_claude)
        field.append(line)
        self.remote_claude_note = label(REMOTE_CLAUDE[0][2], "caption")
        self.remote_claude_note.set_wrap(True)
        self.remote_claude_note.set_xalign(0)
        field.append(self.remote_claude_note)
        self.form.append(field)
        self.transcript_widgets.append(field)
        self.remote_claude.connect("notify::selected", self.remote_claude_changed)
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
        self.form.append(color_name)
        self.form.append(color_row)
        presets = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, column_spacing=6, row_spacing=6,
                              min_children_per_line=2, max_children_per_line=4, homogeneous=True)
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
            presets.insert(button, -1)
        self.form.append(presets)
        self.show_marker = Gtk.CheckButton(label="Show profile dot", active=True)
        self.form.append(self.show_marker)
        self.enabled = Gtk.CheckButton(label="Enabled", active=True)
        self.form.append(self.enabled)
        for entry in (self.name, self.data_dir, self.launcher, self.projects_dir):
            entry.connect("changed", self.form_changed)
        for check in (self.enabled, self.show_marker):
            check.connect("toggled", self.form_changed)
        help_text = label("Codex: choose CODEX_HOME, such as ~/.codex-personal. Claude: choose the app profile folder with "
                          "claude-code-sessions or Cache. Added sources need an installed app launcher. "
                          "Only default sources can leave Open with empty to use the default app.", "caption")
        help_text.set_wrap(True)
        content.append(help_text)
        self.source_status = label("", "caption")
        self.source_status.set_wrap(True)
        self.source_status.set_selectable(True)
        content.append(self.source_status)
        actions = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, column_spacing=8, row_spacing=8,
                              min_children_per_line=3, max_children_per_line=5, homogeneous=True)
        content.append(actions)
        self.add_button, self.save_button, self.remove_button, self.cancel_button, self.reload_button = (
            Gtk.Button(label=title) for title in ("Add", "Save", "Remove", "Cancel", "Refresh"))
        for button, callback in ((self.add_button, self.add_source), (self.save_button, self.save_source),
                                 (self.remove_button, self.remove_source), (self.cancel_button, self.cancel_form),
                                 (self.reload_button, self.reload_sources)):
            button.connect("clicked", callback)
            actions.insert(button, -1)
        self.save_button.add_css_class("suggested-action")
        self.update_controls()

    def color_changed(self, *_args):
        self.source_color_hex.set_label(self.owner.hex_color(self.source_color.get_rgba()))
        self.form_changed()

    def remote_claude_changed(self, *_args):
        note = REMOTE_CLAUDE[self.remote_claude.get_selected()][2]
        self.remote_claude_note.set_label(note)
        self.remote_claude.update_property([Gtk.AccessibleProperty.DESCRIPTION], [note])
        self.form_changed()

    def form_values(self):
        return (self.provider.get_selected(), self.name.get_text(), self.data_dir.get_text(),
                self.launcher.get_text(), self.projects_dir.get_text(), self.enabled.get_active(),
                self.owner.hex_color(self.source_color.get_rgba()), self.show_marker.get_active(),
                self.remote_claude.get_selected())

    def is_dirty(self):
        baseline = getattr(self, "form_baseline", None)
        return bool(self.editing and baseline is not None and self.form_values() != baseline)

    def form_changed(self, *_args):
        if not getattr(self, "setting_form", False):
            getattr(self.owner, "report_ui", lambda: None)()

    def set_active(self, active):
        active = bool(active and not self.closed and not self.owner.closed)
        previous, self.active = getattr(self, "active", False), active
        if active and not previous:
            self.reload_sources()

    def observe_revision(self, revision):
        if revision and revision != getattr(self, "observed_revision", None):
            self.observed_revision = revision
            self.refresh_queued = True
            self.flush_refresh()

    def flush_refresh(self):
        if getattr(self, "refresh_queued", False) and getattr(self, "active", False) and not (self.loading or self.choosing):
            self.refresh_queued = False
            self.reload_sources()

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
        form_busy = self.choosing or self.loading and (not self.loaded or getattr(self, "saving", False))
        current = next((source for source in self.sources if source["id"] == self.editing_id), {})
        self.table.set_sensitive(self.loaded and not form_busy)
        self.form.set_sensitive(self.editing and not form_busy)
        self.provider.set_sensitive(not current.get("builtin"))
        for button in self.choose_buttons:
            button.set_sensitive(not self.fixed_provider)
        self.add_button.set_sensitive(self.loaded and not busy and len(self.sources) < self.max_sources)
        self.save_button.set_sensitive(self.loaded and not busy and self.editing)
        self.remove_button.set_sensitive(self.loaded and not busy and bool(current) and not current.get("builtin"))
        self.cancel_button.set_sensitive(self.loaded and not busy and self.editing)
        self.reload_button.set_sensitive(not busy)
        self.table.update_state([Gtk.AccessibleState.BUSY], [busy])

    def provider_changed(self, *_args):
        for widget in self.transcript_widgets:
            widget.set_visible(self.provider.get_selected() == 1 and not self.fixed_provider)
        self.form_changed()

    def set_source_status(self, source):
        status = source.get("status", "").capitalize()
        if source.get("message"):
            status += ": " + source["message"]
        if source.get("builtin"):
            status += ". Default source: you can edit or disable it. You cannot remove it."
        self.source_status.set_label(status.strip(". "))

    def set_form(self, source=None):
        source = source or {}
        self.setting_form = True
        self.editing, self.editing_id = True, source.get("id", "")
        self.form_title.set_label("Edit app source" if self.editing_id else "Add app source")
        self.source_id.set_label("ID: " + (self.editing_id or "Assigned when saved"))
        provider = source.get("provider", "codex")
        # The default OpenCode source keeps its app, folder, and empty launcher.
        self.fixed_provider = provider if provider not in SOURCE_PROVIDERS else ""
        self.provider.set_visible(not self.fixed_provider)
        self.provider_text.set_label(APP_NAMES.get(provider, provider))
        self.provider_text.set_visible(bool(self.fixed_provider))
        self.provider.set_selected(0 if self.fixed_provider else SOURCE_PROVIDERS.index(provider))
        for entry in (self.data_dir, self.launcher):
            entry.set_editable(not self.fixed_provider)
        for entry, key in ((self.name, "label"), (self.data_dir, "dataDir"),
                           (self.launcher, "launcher"), (self.projects_dir, "projectsDir")):
            entry.set_text(source.get(key, ""))
        self.enabled.set_active(source.get("enabled", True))
        self.show_marker.set_active(source.get("showMarker", True))
        self.remote_claude.set_selected(next((index for index, (value, _title, _note) in enumerate(REMOTE_CLAUDE)
                                              if value == source.get("remoteClaude", "auto")), 0))
        try:
            color = validate_source_color(source.get("color", SOURCE_COLOR_PRESETS[0][1]))
        except ValueError:
            color = SOURCE_COLOR_PRESETS[0][1]
        self.source_color.set_rgba(self.owner.rgba(color))
        for accessible in (self.source_color, self.source_color.get_first_child()):
            accessible.update_property([Gtk.AccessibleProperty.LABEL], ["Profile color for " + source.get("label", "new app source")])
        self.color_changed()
        self.launcher.set_placeholder_text("Not used: OpenCode cannot open one session from a link." if self.fixed_provider
                                           else "Default app link handler" if source.get("builtin") else "Installed app launcher required")
        self.set_source_status(source)
        self.provider_changed()
        self.form_baseline = self.form_values()
        self.baseline_source = dict(source) if self.editing_id else None
        self.edit_revision = getattr(self, "revision", None)
        self.conflict = self.setting_form = False
        self.update_controls()
        self.form_changed()

    def selected_source(self, _table, row):
        if row and not (self.choosing or self.closed or getattr(self, "saving", False) or getattr(self, "rendering", False)):
            self.set_form(row.asb_source)

    def render_sources(self, preferred="", preserve_form=False):
        focus = self.preferences.get_focus()
        current = next((source for source in self.sources if source["id"] == preferred), None)
        keep_form = False
        if preserve_form and self.editing:
            unchanged = source_edit_values(current) == source_edit_values(getattr(self, "baseline_source", None))
            keep_form = not self.editing_id or unchanged or self.is_dirty() or self.choosing
            if not self.editing_id or unchanged:
                self.edit_revision, self.conflict = self.revision, False
            elif keep_form:
                self.conflict = True
        self.rendering = True
        existing = {}
        child = self.table.get_first_child()
        while child:
            following = child.get_next_sibling()
            if any(source["id"] == child.asb_source["id"] for source in self.sources):
                existing[child.asb_source["id"]] = child
            else:
                self.table.remove(child)
            child = following
        self.table_markers = []
        selected = None
        for index, source in enumerate(self.sources):
            row = existing.get(source["id"])
            if row is None or row.asb_source != source:
                provider = APP_NAMES.get(source["provider"], source["provider"])
                marker = SourceMarker(self.owner, source.get("color", ""))
                marker.set_valign(Gtk.Align.CENTER)
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
                row = row or Gtk.ListBoxRow()
                row.asb_source, row.asb_marker = source, marker
                row.set_child(self.table_line(["Yes" if source["enabled"] else "No", name_cell,
                                               source["dataDir"], source["launcher"] or "Default app", status]))
                row.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                    [f"{source['label']}, {provider}, {status}", "Profile color: " + marker.configured_color])
            self.table_markers.append(row.asb_marker)
            if self.table.get_row_at_index(index) is not row:
                if row.get_parent() is self.table:
                    self.table.remove(row)
                self.table.insert(row, index)
            if source["id"] == preferred or selected is None and not keep_form:
                selected = row
        self.table.select_row(selected)
        self.rendering = False
        if focus is not None and focus in existing.values() and focus.get_parent() is self.table \
                and self.preferences.get_focus() is not focus:
            focus.grab_focus()
        if keep_form and current:
            self.set_source_status(current)
        elif not keep_form:
            if selected:
                self.set_form(selected.asb_source)
            else:
                self.editing, self.editing_id = False, ""
                self.form_baseline = self.baseline_source = self.edit_revision = None
                self.conflict = False
                self.form_title.set_label("Add an app source to show its chats")
                self.source_id.set_label("")
                self.source_status.set_label("")

    def request_sources(self, route="/api/sources", method="GET", body=None):
        if self.closed or self.owner.closed:
            return
        if self.loading or self.choosing:
            if method == "GET":
                self.refresh_queued = True
            return
        self.refresh_queued = False
        preferred = self.editing_id
        self.loading = True
        self.saving = method == "POST"
        self.message.set_label("Loading app sources…" if method == "GET" else "Saving app sources…")
        self.update_controls()
        def finished(result, error):
            if self.closed or self.owner.closed:
                return False
            self.loading = False
            self.saving = False
            if not error and (not isinstance(result, dict) or not isinstance(result.get("sources"), list)):
                error = "The app source list is not valid. Refresh the list, then try again."
            if error:
                if method == "GET":
                    self.observed_revision = None
                    self.refresh_queued = False
                self.message.set_label(error)
            else:
                self.sources, self.loaded = result["sources"], True
                self.revision = source_revision(result.get("revision"))
                self.max_sources = result.get("maxSources", self.max_sources)
                identity = preferred
                if method == "POST" and body and not body["source"].get("id"):
                    identity = next((source["id"] for source in self.sources
                                     if source["provider"] == body["source"]["provider"]
                                     and source["dataDir"] == os.path.normpath(body["source"]["dataDir"])), "")
                if method == "GET":
                    self.render_sources(self.editing_id, preserve_form=True)
                else:
                    self.render_sources(identity)
                feedback = "Saved. " if method == "POST" and body else "Removed. " if method == "POST" else ""
                self.message.set_label("This app source changed outside this form. Your edits are kept. Select Cancel to load the saved source, then edit and save again."
                                       if getattr(self, "conflict", False) else f"{feedback}{len(self.sources)} of {self.max_sources} app sources")
                if method == "POST":
                    self.owner.refresh(True)
            self.update_controls()
            self.form_changed()
            self.flush_refresh()
            return False
        revision = getattr(self, "edit_revision", None) or getattr(self, "revision", None)
        if method == "POST" and revision:
            request_async(self.base, route, finished, GLib.idle_add, method, body, headers={"If-Match": '"' + revision + '"'})
        else:
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
            self.form_changed()

    def save_source(self, *_args):
        if self.closed or self.loading or self.choosing or not self.loaded or not self.editing:
            return
        if getattr(self, "conflict", False):
            self.message.set_label("This app source changed outside this form. Your edits are kept. Select Cancel to load the saved source, then edit and save again.")
            return
        try:
            body = source_form_body(self.fixed_provider or SOURCE_PROVIDERS[self.provider.get_selected()], self.name.get_text(),
                                    self.data_dir.get_text(), self.launcher.get_text(), self.enabled.get_active(),
                                    self.editing_id, self.projects_dir.get_text(),
                                    self.owner.hex_color(self.source_color.get_rgba()), self.show_marker.get_active(),
                                    remote_claude=REMOTE_CLAUDE[self.remote_claude.get_selected()][0])
        except ValueError as error:
            self.message.set_label(str(error))
            return
        self.request_sources("/api/sources", "POST", body)

    def remove_source(self, *_args):
        if getattr(self, "conflict", False):
            self.message.set_label("This app source changed outside this form. Select Cancel to load the saved source before removal.")
            return
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
        if self.cancellable.is_cancelled():
            self.cancellable = Gio.Cancellable()
        cancellable = self.cancellable
        def finished(chooser, result):
            if self.closed or self.owner.closed or cancellable.is_cancelled():
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
            self.form_changed()
            self.flush_refresh()
        if folder:
            dialog.select_folder(self.preferences, cancellable, finished)
        else:
            dialog.open(self.preferences, cancellable, finished)

    def cancel_dialogs(self):
        self.cancellable.cancel()
        self.choosing = False
        self.update_controls()
        self.flush_refresh()

    def close(self):
        self.closed = True
        self.cancel_dialogs()


class PhoneEditor(Gtk.Box):
    def __init__(self, owner, preferences):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.owner, self.preferences, self.base = owner, preferences, owner.base
        self.closed = self.active = self.loaded = self.loading = self.poll_loading = False
        self.generation, self.poll_timer, self.form_loaded = 0, None, None
        self.status, self.address_checks, self.remove_buttons = {}, {}, []
        self.pairing_uri, self.expires_at, self.pair_device_ids, self.matrix = "", 0, set(), None
        self.settings = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.settings.add_css_class("boxed-list")
        self.enabled = Adw.SwitchRow(title="Allow phone access", subtitle=
            "Phones on your network can see your sessions and use ASB actions after pairing.")
        self.enabled.set_subtitle_lines(0)
        self.port = Adw.SpinRow.new_with_range(1024, 65535, 1)
        self.port.set_title("Port")
        self.port.set_value(4630)
        for row in (self.enabled, self.port):
            self.settings.append(row)
        self.append(self.settings)
        self.append(label("Addresses", "heading"))
        self.address_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.address_list.add_css_class("boxed-list")
        self.append(self.address_list)
        self.address_note = label("", "caption")
        self.address_note.set_wrap(True)
        self.address_note.set_max_width_chars(64)
        self.append(self.address_note)
        actions = Gtk.Box(spacing=8)
        self.apply = Gtk.Button(label="Apply")
        self.apply.connect("clicked", self.apply_settings)
        actions.append(self.apply)
        self.retry = Gtk.Button(label="Retry", visible=False)
        self.retry.connect("clicked", lambda *_args: self.request_phone())
        actions.append(self.retry)
        self.append(actions)
        self.message = label("Loading phone access…", "warning")
        self.status_label = label("", "caption")
        self.fingerprint = label("", "monospace")
        self.fingerprint.set_tooltip_text("Compare this certificate fingerprint with the ASB app.")
        self.fingerprint.update_property([Gtk.AccessibleProperty.LABEL], ["Certificate fingerprint"])
        for widget in (self.message, self.status_label, self.fingerprint):
            widget.set_wrap(True)
            widget.set_selectable(True)
            widget.set_max_width_chars(64)
            self.append(widget)
        self.pair = Gtk.Button(label="Pair a phone", halign=Gtk.Align.START)
        self.pair.connect("clicked", self.pair_phone)
        self.append(self.pair)
        self.pairing = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, visible=False)
        self.qr = Gtk.DrawingArea(content_width=240, content_height=240, halign=Gtk.Align.CENTER)
        self.qr.set_draw_func(self.draw_qr)
        self.qr.update_property([Gtk.AccessibleProperty.LABEL], ["Phone pairing QR code"])
        self.pairing.append(self.qr)
        instruction = label("Scan the code with ASB on the phone or with the phone camera. Or copy the link and paste it in ASB. The code works once and ends in 10 minutes.", "caption")
        instruction.set_wrap(True)
        self.pairing.append(instruction)
        self.link = label("", "monospace")
        self.link.set_wrap(True)
        self.link.set_wrap_mode(Pango.WrapMode.CHAR)
        self.link.set_max_width_chars(48)
        self.link.set_selectable(True)
        self.pairing.append(self.link)
        self.copy = Gtk.Button(label="Copy link", halign=Gtk.Align.START)
        self.copy.connect("clicked", self.copy_pairing)
        self.pairing.append(self.copy)
        self.qr_help = label("Install python3-qrcode to show a QR code.", "caption")
        self.qr_help.set_wrap(True)
        self.pairing.append(self.qr_help)
        self.append(self.pairing)
        self.append(label("Paired phones", "heading"))
        self.devices = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.devices.add_css_class("boxed-list")
        self.append(self.devices)
        self.empty = label("No paired phones.", "caption")
        self.append(self.empty)
        self.update_controls()

    def set_active(self, active):
        active = bool(active and not self.closed and not self.owner.closed and not self.preferences.closed)
        if self.active == active:
            return
        self.active = active
        if not active:
            self.loading = self.poll_loading = False
            self.stop_pairing()
        else:
            # The addresses can change while the pane is hidden, so each open reads them again; render_status keeps form edits.
            self.loaded = False
            self.request_phone()

    def update_controls(self):
        ready = self.loaded and not self.loading and not self.closed
        self.settings.set_sensitive(ready)
        self.address_list.set_sensitive(ready)
        self.apply.set_sensitive(ready)
        self.pair.set_sensitive(ready and bool(self.status.get("running")))
        self.retry.set_sensitive(not self.loading and not self.closed)
        for button in self.remove_buttons:
            button.set_sensitive(ready)

    def render_status(self, status, sync_form=False):
        self.status, self.loaded = status, True
        self.status_label.set_label(phone_status_text(status))
        self.fingerprint.set_label(group_fingerprint(status.get("fingerprint", "")))
        if sync_form:
            form = None if self.form_loaded is None else (self.enabled.get_active(), int(self.port.get_value()),
                    [address for address, check in self.address_checks.items() if check.get_active()])
            enabled, port, selected = phone_form_values(self.form_loaded, form, status)
            self.form_loaded = (status.get("enabled", False), status.get("port", 4630), list(status.get("bindAddresses", [])))
            self.enabled.set_active(enabled)
            child = self.address_list.get_first_child()
            while child:
                self.address_list.remove(child)
                child = self.address_list.get_first_child()
            self.address_checks = {}
            # A checked address that is absent now stays as "Not on this PC now"; a new address is unchecked.
            rows = phone_address_rows(status["addresses"], selected)
            for item in rows:
                check = Gtk.CheckButton(active=item["address"] in selected, valign=Gtk.Align.CENTER)
                row = Adw.ActionRow(title=item["title"], subtitle=item["subtitle"], use_markup=False, activatable_widget=check)
                row.add_prefix(check)
                self.address_list.append(row)
                self.address_checks[item["address"]] = check
            self.address_list.set_visible(bool(rows))
            note = phone_address_note(status["addresses"])
            self.address_note.set_label(note)
            self.address_note.set_visible(bool(note))
            self.port.set_value(port)
        child = self.devices.get_first_child()
        while child:
            self.devices.remove(child)
            child = self.devices.get_first_child()
        self.remove_buttons = []
        for device in status["devices"]:
            created = device.get("createdAtMs", 0)
            date = time.strftime("%Y-%m-%d", time.localtime(created / 1000)) if created else "Unknown"
            last_seen = row_meta({"updatedAtMs": device.get("lastSeenAtMs", 0)}).split(" · ", 1)[1]
            row = Adw.ActionRow(title=device["name"], subtitle=f"Paired {date}\nLast seen {last_seen}", use_markup=False)
            row.set_title_lines(0)
            remove = Gtk.Button(label="Remove", valign=Gtk.Align.CENTER)
            remove.update_property([Gtk.AccessibleProperty.LABEL], ["Remove " + device["name"]])
            remove.connect("clicked", lambda _button, identity=device["id"]: self.revoke_device(identity))
            row.add_suffix(remove)
            self.remove_buttons.append(remove)
            self.devices.append(row)
        self.empty.set_visible(not status["devices"])
        self.devices.set_visible(bool(status["devices"]))

    def request_phone(self, route="/api/phone", method="GET", body=None, poll=False):
        if self.closed or self.owner.closed or not self.active or self.loading or (poll and self.poll_loading):
            return
        if poll:
            self.poll_loading = True
        else:
            self.generation += 1
            self.poll_loading = False
            self.loading = True
            self.message.set_label("Loading phone access…" if method == "GET" else "Saving phone access…")
            self.retry.set_visible(False)
            self.update_controls()
        generation = self.generation
        sync_form = not self.loaded or route == "/api/phone/settings"
        def finished(result, error):
            if self.closed or self.owner.closed or not self.active or generation != self.generation:
                return False
            if poll:
                self.poll_loading = False
                if self.expire_pairing():
                    return False
            else:
                self.loading = False
            pairing = route == "/api/phone/pairing"
            if not error and (not isinstance(result, dict) or (pairing and
                    (not isinstance(result.get("uri"), str) or not result["uri"].startswith("asb://pair?")
                     or type(result.get("expiresAtMs")) is not int or result["expiresAtMs"] <= time.time() * 1000))
                    or (not pairing and (not isinstance(result.get("devices"), list)
                                          or not isinstance(result.get("addresses"), list)))):
                error = "The phone access response is not valid. Try again."
            if error:
                self.message.set_label(error)
                self.retry.set_visible(not self.loaded)
            elif pairing:
                self.show_pairing(result)
                self.message.set_label("")
            else:
                if route == "/api/phone/settings":
                    self.form_loaded = None  # The saved values replace the edits.
                self.render_status(result, sync_form and not poll)
                if not poll:
                    feedback = "Saved." if route == "/api/phone/settings" else "Phone removed." if method == "POST" else ""
                    self.message.set_label(" ".join(filter(None, (feedback, result.get("warning", "")))))
                if poll:
                    self.message.set_label(result.get("warning", ""))
                    new = [device for device in result["devices"] if device["id"] not in self.pair_device_ids]
                    if new and len(result["devices"]) > len(self.pair_device_ids):
                        self.stop_pairing()
                        newest = max(new, key=lambda device: device.get("createdAtMs", 0))
                        self.message.set_label("Paired: " + newest["name"])
                    elif not result.get("running") or (result.get("pairing") or {}).get("expiresAtMs") != self.expires_at:
                        self.stop_pairing()
                        self.message.set_label("This pairing code is no longer valid. Pair a phone to make a new one.")
            self.update_controls()
            return False
        request_async(self.base, route, finished, GLib.idle_add, method, body)

    def apply_settings(self, *_args):
        if not self.loaded or self.loading or not self.active:
            return
        body = {"enabled": self.enabled.get_active(),
                "bindAddresses": [address for address, check in self.address_checks.items() if check.get_active()],
                "port": int(self.port.get_value())}
        self.stop_pairing()
        self.request_phone("/api/phone/settings", "POST", body)

    def pair_phone(self, *_args):
        if not self.loaded or self.loading or not self.active or not self.status.get("running"):
            return
        self.stop_pairing()
        self.request_phone("/api/phone/pairing", "POST", {})

    def revoke_device(self, identity):
        if not self.loaded or self.loading or not self.active:
            return
        self.stop_pairing()
        self.request_phone("/api/phone/devices/" + quote(identity, safe="") + "/revoke", "POST", {})

    def show_pairing(self, result):
        self.pairing_uri, self.expires_at = result["uri"], result["expiresAtMs"]
        self.pair_device_ids = {device["id"] for device in self.status.get("devices", [])}
        self.matrix = qr_matrix(self.pairing_uri)
        self.qr.set_visible(self.matrix is not None)
        self.qr.queue_draw()
        self.link.set_label(self.pairing_uri if self.matrix is None else "")
        for widget in (self.link, self.qr_help):
            widget.set_visible(self.matrix is None)
        self.copy.set_visible(True)
        self.pairing.set_visible(True)
        self.poll_timer = GLib.timeout_add_seconds(3, self.poll_pairing)

    def draw_qr(self, _area, context, width, height):
        context.set_source_rgb(1, 1, 1)
        context.paint()
        if not self.matrix:
            return
        size = len(self.matrix)
        module = max(1, min(width, height) // size)
        left, top = (width - module * size) // 2, (height - module * size) // 2
        context.set_source_rgb(0, 0, 0)
        for y, row in enumerate(self.matrix):
            for x, dark in enumerate(row):
                if dark:
                    context.rectangle(left + x * module, top + y * module, module, module)
        context.fill()

    def copy_pairing(self, *_args):
        if self.active and self.pairing_uri and not self.expire_pairing():
            self.get_clipboard().set(self.pairing_uri)

    def expire_pairing(self):
        if self.expires_at and time.time() * 1000 >= self.expires_at:
            self.stop_pairing()
            self.message.set_label("This pairing code has expired. Pair a phone to make a new one.")
            return True
        return False

    def poll_pairing(self):
        if not self.active or self.closed or self.owner.closed or not self.pairing_uri:
            self.stop_pairing()
            return False
        if self.expire_pairing():
            return False
        self.request_phone(poll=True)
        return True

    def stop_pairing(self):
        self.generation += 1
        self.poll_loading = False
        if self.poll_timer is not None:
            GLib.source_remove(self.poll_timer)
            self.poll_timer = None
        self.pairing_uri, self.expires_at, self.matrix = "", 0, None
        self.pairing.set_visible(False)
        self.link.set_label("")

    def close(self):
        self.set_active(False)
        self.closed = True


class MachinesEditor(Gtk.Box):
    def __init__(self, owner, preferences):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.owner, self.preferences, self.base = owner, preferences, owner.base
        self.closed = self.active = self.loaded = self.loading = self.poll_loading = False
        self.generation, self.poll_timer, self.dialog = 0, None, None
        self.group, self.view, self.summary = {}, machines_view({}), None
        self.invite_link, self.invite_expires, self.invite_ids, self.matrix = "", 0, set(), None
        self.remove_buttons, self.rows_shown = [], None
        self.body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, visible=False)
        self.off = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.off.append(self.text(MACHINE_OFF, "warning"))
        phone = Gtk.Button(label="Open Phone settings", halign=Gtk.Align.START, valign=Gtk.Align.CENTER)
        phone.connect("clicked", lambda *_args: self.preferences.stack.set_visible_child_name("phone"))
        self.off.append(phone)
        self.body.append(self.off)
        self.body.append(self.text(MACHINE_INTRO))
        self.body.append(label("This machine", "heading"))
        self.self_row = Adw.ActionRow(use_markup=False)
        self.self_row.set_subtitle_lines(0)
        self.body.append(self.boxed(self.self_row))
        self.others_heading = label("Other machines", "heading")
        self.others = self.boxed()
        self.empty = self.text("No other machine is in the group.")
        self.phones = self.text("")
        self.alone = self.text(MACHINE_ALONE)
        for widget in (self.others_heading, self.others, self.empty, self.phones, self.alone):
            self.body.append(widget)
        self.actions = Gtk.Box(spacing=8)
        self.add_button = self.button("Add a machine", self.invite)
        self.leave_button = self.button("Leave the group", self.confirm_leave, "destructive-action")
        self.join_open = self.button("Join a group", self.open_join)
        for widget in (self.add_button, self.leave_button, self.join_open):
            self.actions.append(widget)
        self.body.append(self.actions)
        self.body.append(self.invite_panel())
        self.body.append(self.join_panel())
        self.append(self.body)
        self.message = self.text("Loading the machine group…", "warning", selectable=True)
        self.append(self.message)
        self.retry = self.button("Retry", lambda *_args: self.request_group())
        self.retry.set_visible(False)
        self.append(self.retry)
        self.update_controls()

    @staticmethod
    def text(value, css="caption", width=64, selectable=False):
        widget = label(value, css)
        widget.set_wrap(True)
        widget.set_max_width_chars(width)
        widget.set_selectable(selectable)
        return widget

    @staticmethod
    def boxed(*rows):
        box = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        box.add_css_class("boxed-list")
        for row in rows:
            box.append(row)
        return box

    @staticmethod
    def button(value, clicked, css=None):
        widget = Gtk.Button(label=value, halign=Gtk.Align.START, valign=Gtk.Align.CENTER)
        if css:
            widget.add_css_class(css)
        widget.connect("clicked", clicked)
        return widget

    @staticmethod
    def show_fingerprint(widget, value):
        widget.set_label(group_fingerprint(value))
        # A new text replaces the accessible label of a Gtk.Label.
        widget.update_property([Gtk.AccessibleProperty.LABEL], ["Certificate fingerprint"])

    def invite_panel(self):
        self.invite_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, visible=False)
        self.invite_box.append(label("Add a machine", "heading"))
        self.invite_help = self.text("")
        self.invite_box.append(self.invite_help)
        share = Gtk.Box(spacing=16)
        self.qr = Gtk.DrawingArea(content_width=156, content_height=156, halign=Gtk.Align.START, valign=Gtk.Align.START)
        self.qr.set_draw_func(lambda area, context, width, height: PhoneEditor.draw_qr(self, area, context, width, height))
        self.qr.update_property([Gtk.AccessibleProperty.LABEL], ["Machine join QR code"])
        share.append(self.qr)
        side = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.link = self.text("", "monospace", 44, selectable=True)
        self.link.set_wrap_mode(Pango.WrapMode.CHAR)
        side.append(self.link)
        side.append(self.button("Copy link", self.copy_link))
        self.qr_help = self.text("Install python3-qrcode to show a QR code.")
        side.append(self.qr_help)
        share.append(side)
        self.invite_box.append(share)
        self.invite_box.append(label("Fingerprint of this machine", "heading"))
        self.own_fingerprint = self.text("", "monospace", 40, selectable=True)
        self.invite_box.append(self.own_fingerprint)
        self.invite_box.append(self.text("The other machine shows this fingerprint before it joins. Check that both are the same."))
        waiting = Gtk.Box(spacing=8)
        self.spinner = Gtk.Spinner(spinning=True)
        waiting.append(self.spinner)
        waiting.append(self.text("Waiting for the other machine…", None))
        row = Gtk.Box(spacing=8)
        row.append(waiting)
        self.invite_cancel = self.button("Cancel", lambda *_args: self.close_invite())
        row.append(self.invite_cancel)
        self.invite_box.append(row)
        return self.invite_box

    def join_panel(self):
        self.join_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, visible=False)
        self.join_box.append(label("Join a group", "heading"))
        self.join_link = Adw.EntryRow(title="Join link")
        self.join_link.connect("changed", self.join_link_changed)
        self.join_box.append(self.boxed(self.join_link))
        self.compare = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, visible=False)
        self.compare_heading = label("", "heading")
        self.compare_heading.set_wrap(True)
        self.inviter_fingerprint = self.text("", "monospace", 40, selectable=True)
        self.compare_help = self.text("")
        self.same = Gtk.CheckButton(label="It is the same")
        self.same.connect("toggled", lambda *_args: self.update_controls())
        for widget in (self.compare_heading, self.inviter_fingerprint, self.compare_help, self.same):
            self.compare.append(widget)
        self.join_box.append(self.compare)
        self.not_link = self.text("This is not an ASB join link.")
        self.not_link.set_visible(False)
        self.join_box.append(self.not_link)
        self.join_name = Adw.EntryRow(title="Name for this machine")
        self.join_name.connect("changed", lambda *_args: self.update_controls())
        self.join_box.append(self.boxed(self.join_name))
        row = Gtk.Box(spacing=8)
        self.join_button = self.button("Join", self.join_group, "suggested-action")
        row.append(self.join_button)
        self.join_cancel = self.button("Cancel", lambda *_args: self.close_join())
        row.append(self.join_cancel)
        self.join_box.append(row)
        return self.join_box

    def set_active(self, active):
        active = bool(active and not self.closed and not self.owner.closed and not self.preferences.closed)
        if self.active == active:
            return
        self.active = active
        if not active:
            if self.dialog:
                self.dialog.force_close()
            self.generation += 1
            self.loading = self.poll_loading = False
            if self.poll_timer:
                GLib.source_remove(self.poll_timer)
            self.poll_timer = None
            self.close_invite()
        else:
            # Members change while the page is hidden, so each open reads the group again; a poll keeps the panels.
            self.request_group()
            self.poll_timer = GLib.timeout_add_seconds(5, self.poll)

    def show_message(self, text):
        self.message.set_label(text)
        self.message.set_visible(bool(text))

    def update_controls(self):
        busy = self.loading or self.closed
        ready = self.loaded and not busy
        self.add_button.set_sensitive(ready and self.view["add"])
        self.join_open.set_sensitive(ready and self.view["join"])
        self.leave_button.set_sensitive(ready)
        for widget in self.remove_buttons + [self.invite_cancel, self.join_cancel]:
            widget.set_sensitive(ready)
        name = self.join_name.get_text().strip()
        self.join_button.set_sensitive(ready and self.summary is not None and self.same.get_active()
                                       and bool(MACHINE_NAME.fullmatch(name)))
        self.retry.set_sensitive(not busy)

    def render_others(self, others, rows):
        self.rows_shown = rows
        child = self.others.get_first_child()
        while child:
            self.others.remove(child)
            child = self.others.get_first_child()
        self.remove_buttons = []
        for member, (_identity, name, subtitle, _online) in zip(others, rows):
            row = Adw.ActionRow(title=name, subtitle=subtitle, use_markup=False)
            row.set_subtitle_lines(0)
            if not member.get("online"):
                row.add_css_class("dim-label")
            remove = Gtk.Button(label="Remove", halign=Gtk.Align.START, valign=Gtk.Align.CENTER)
            remove.update_property([Gtk.AccessibleProperty.LABEL], ["Remove " + member["name"]])
            remove.connect("clicked", lambda _button, item=member: self.confirm_remove(item))
            row.add_suffix(remove)
            self.remove_buttons.append(remove)
            self.others.append(row)

    def render(self, group):
        self.group, self.view, self.loaded = group, machines_view(group), True
        own = group["self"]
        self.self_row.set_title(own["name"])
        self.self_row.set_subtitle("ID " + own["machineId"][:8])
        self.off.set_visible(self.view["off"])
        grouped, others = self.view["grouped"], self.view["others"]
        now_ms = time.time() * 1000
        rows = [(member["machineId"], member["name"], machine_member_subtitle(member, now_ms), bool(member.get("online")))
                for member in others]
        # A poll every 5 s must not make the same rows again: that drops the keyboard focus of a Remove button.
        if rows != self.rows_shown:
            self.render_others(others, rows)
        phones = machine_phones_text(group.get("phones", []))
        self.phones.set_label(phones)
        for widget, visible in ((self.others_heading, grouped), (self.others, grouped and bool(others)),
                                (self.empty, grouped and not others), (self.phones, grouped and bool(phones)),
                                (self.alone, not grouped), (self.leave_button, self.view["leave_visible"]),
                                (self.join_open, self.view["join_visible"])):
            widget.set_visible(visible)
        if self.join_box.get_visible() and grouped:
            self.close_join()
        self.body.set_visible(True)

    def request_group(self, route="/api/group", method="GET", body=None, poll=False, feedback="", done=None):
        """A GET renders the group and shows feedback; a POST calls done with the reply."""
        if self.closed or self.owner.closed or not self.active or self.loading or (poll and self.poll_loading):
            return
        if poll:
            self.poll_loading = True
        else:
            self.generation += 1
            self.poll_loading = False
            self.loading = True
            if not self.loaded:
                self.show_message("Loading the machine group…")
            self.retry.set_visible(False)
            self.update_controls()
        generation = self.generation
        def finished(result, error):
            if self.closed or self.owner.closed or not self.active or generation != self.generation:
                return False
            if poll:
                self.poll_loading = False
            else:
                self.loading = False
            if not error and (not isinstance(result, dict) or (route == "/api/group/invite"
                    and (not isinstance(result.get("link"), str) or not result["link"].startswith("asb://join?")
                         or not isinstance(result.get("fingerprint"), str) or type(result.get("expiresAtMs")) is not int))
                    or (method == "GET" and (not isinstance(result.get("self"), dict) or not isinstance(result.get("members"), list)))):
                error = "The machine group response is not valid. Try again."
            if error:
                self.show_message(error)
                self.retry.set_visible(not self.loaded)
            elif method == "GET":
                first = not self.loaded
                self.render(result)
                new = [member for member in self.view["others"] if member["machineId"] not in self.invite_ids]
                if self.invite_link and new:
                    self.close_invite()
                    self.show_message("Joined: " + new[-1]["name"])
                elif not poll or first:
                    self.show_message(feedback)
            else:
                done(result)
            self.update_controls()
            return False
        request_async(self.base, route, finished, GLib.idle_add, method, body)

    def poll(self):
        if not self.active or self.closed or self.owner.closed:
            self.poll_timer = None
            return False
        if not self.expire_invite():
            self.request_group(poll=True)
        return True

    def invite(self, *_args):
        if not self.loaded or self.loading or not self.active or not self.view["add"]:
            return
        self.close_join()
        def opened(result):
            self.invite_link, self.invite_expires = result["link"], result["expiresAtMs"]
            self.invite_ids = {member["machineId"] for member in self.view["others"]}
            self.matrix = qr_matrix(self.invite_link)
            self.qr.set_visible(self.matrix is not None)
            self.qr_help.set_visible(self.matrix is None)
            self.qr.queue_draw()
            self.link.set_label(self.invite_link)
            self.invite_help.set_label(machine_invite_text(self.invite_expires))
            self.show_fingerprint(self.own_fingerprint, result["fingerprint"])
            self.actions.set_visible(False)
            self.invite_box.set_visible(True)
            self.show_message("")
        self.request_group("/api/group/invite", "POST", {}, done=opened)

    def copy_link(self, *_args):
        if self.active and self.invite_link and not self.expire_invite():
            self.get_clipboard().set(self.invite_link)

    def expire_invite(self):
        if self.invite_expires and time.time() * 1000 >= self.invite_expires:
            self.close_invite()
            self.show_message("This join link has expired. Select Add a machine to make a new one.")
            return True
        return False

    def close_invite(self):
        self.invite_link, self.invite_expires, self.invite_ids, self.matrix = "", 0, set(), None
        self.invite_box.set_visible(False)
        self.link.set_label("")
        self.actions.set_visible(not self.join_box.get_visible())

    def open_join(self, *_args):
        if not self.loaded or self.loading or not self.active or not self.view["join"] or self.view["grouped"]:
            return
        self.close_invite()
        self.join_link.set_text("")
        self.join_name.set_text(self.group["self"]["name"])
        self.show_message("")
        self.actions.set_visible(False)
        self.join_box.set_visible(True)
        self.join_link.grab_focus()

    def close_join(self):
        self.join_box.set_visible(False)
        self.actions.set_visible(not self.invite_link)

    def join_link_changed(self, *_args):
        text = self.join_link.get_text()
        self.summary = join_link_summary(text)
        self.same.set_active(False)  # Each new link needs a new check.
        if self.summary:
            name = self.summary["name"]
            self.compare_heading.set_label(f"Does {name} show this fingerprint?")
            self.show_fingerprint(self.inviter_fingerprint, self.summary["fingerprint"])
            self.compare_help.set_label(f"On {name}, open Preferences > Machines. The fingerprint is under Add a machine.")
        self.compare.set_visible(self.summary is not None)
        self.not_link.set_visible(self.summary is None and bool(text.strip()))
        self.update_controls()

    def join_group(self, *_args):
        if not self.join_button.get_sensitive() or not self.active:
            return
        inviter = self.summary["name"]
        def joined(_result):
            self.close_join()
            self.request_group(feedback=f"Joined the group of {inviter}.")
        # A pasted link often ends with a line break; the engine does not strip it.
        self.request_group("/api/group/join", "POST", {"link": self.join_link.get_text().strip(),
                                                       "name": self.join_name.get_text().strip()}, done=joined)

    def alert(self, heading, body, response, clicked):
        dialog = Adw.AlertDialog(heading=heading, body=body)
        dialog.add_response("cancel", "Cancel")
        dialog.add_response(response, response.capitalize())
        dialog.set_response_appearance(response, Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        def chosen(_dialog, choice):
            if choice == response and self.active and self.loaded and not self.loading:
                clicked()
        dialog.connect("response", chosen)
        dialog.connect("closed", lambda closed: setattr(self, "dialog", None) if self.dialog is closed else None)
        self.dialog = dialog
        dialog.present(self.preferences)

    def confirm_remove(self, member):
        if not self.loaded or self.loading or not self.active:
            return
        name = member["name"]
        others = [item["name"] for item in self.view["others"] if item["machineId"] != member["machineId"]]
        self.alert(f"Remove {name}?", machine_confirm_body(others, name), "remove", lambda: self.request_group(
            "/api/group/remove", "POST", {"machineId": member["machineId"]},
            done=lambda _result: self.request_group(feedback=f"{name} was removed from the group.")))

    def confirm_leave(self, *_args):
        if not self.loaded or self.loading or not self.active or not self.view["grouped"]:
            return
        others = [item["name"] for item in self.view["others"]]
        self.alert("Leave the group?", machine_confirm_body(others), "leave", lambda: self.request_group(
            "/api/group/leave", "POST", {}, done=lambda _result: self.request_group(feedback="This machine left the group.")))

    def close(self):
        self.set_active(False)
        self.closed = True


class PreferencesWindow(Adw.Window):
    def __init__(self, owner, sessions, appearance):
        super().__init__(application=owner.get_application(), transient_for=owner, destroy_with_parent=True,
                         title="Preferences", default_width=780, default_height=560)
        self.owner, self.closed, self.profiles_editor, self.phone_editor, self.machines_editor = owner, False, None, None, None
        self.set_size_request(420, 360)
        self.add_css_class("asb-column-flow")
        self.add_css_class("asb-preferences")
        self.connect("close-request", self.on_close)
        self.connect("notify::visible", self.section_changed)
        self.connect("map", self.section_changed)
        self.connect("unmap", self.section_changed)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        body.append(Adw.HeaderBar())
        self.stack = Gtk.Stack(vexpand=True, hexpand=True, hhomogeneous=False, vhomogeneous=False)
        self.sidebar = Gtk.StackSidebar(stack=self.stack)
        self.sidebar.set_size_request(150, -1)
        self.sidebar.add_css_class("asb-preferences-nav")
        self.tabs = Gtk.StackSwitcher(stack=self.stack, halign=Gtk.Align.FILL,
                                      margin_start=6, margin_end=6, margin_top=6, margin_bottom=6)
        self.tabs.get_layout_manager().set_homogeneous(False)
        # Five tabs do not fit in 420 px; the row scrolls instead of making the window wider.
        self.tabs_scroll = Gtk.ScrolledWindow(child=self.tabs, visible=False, hscrollbar_policy=Gtk.PolicyType.AUTOMATIC,
                                              vscrollbar_policy=Gtk.PolicyType.NEVER, propagate_natural_height=True)
        self.tabs_scroll.get_hadjustment().connect("changed", self.scroll_tabs)
        self.tabs_reveal = None
        body.append(self.tabs_scroll)
        layout = Gtk.Box()
        layout.append(self.sidebar)
        layout.append(self.stack)
        body.append(layout)
        self.profiles = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.phone = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.machines = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        for title, content in (("Sessions", sessions), ("Appearance", appearance), ("Profiles", self.profiles), ("Phone", self.phone),
                               ("Machines", self.machines)):
            page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16,
                           margin_top=20, margin_bottom=20, margin_start=20, margin_end=20)
            page.append(label(title, "title-2"))
            page.append(content)
            scroll = Gtk.ScrolledWindow(child=page, hscrollbar_policy=Gtk.PolicyType.NEVER,
                                       vscrollbar_policy=Gtk.PolicyType.AUTOMATIC)
            self.stack.add_titled(scroll, title.lower(), title)
        self.stack.connect("notify::visible-child-name", self.section_changed)
        self.set_content(body)
        breakpoint = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 600px"))
        breakpoint.add_setter(self.sidebar, "visible", False)
        breakpoint.add_setter(self.tabs_scroll, "visible", True)
        self.add_breakpoint(breakpoint)
        self.stack.update_property([Gtk.AccessibleProperty.LABEL], ["Preferences sections"])
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.window_key)
        self.add_controller(keys)

    def section_changed(self, *_args):
        if not self.closed and self.stack.get_visible_child_name() == "profiles" and self.profiles_editor is None:
            self.profiles_editor = AppSourcesEditor(self.owner, self)
            self.profiles.append(self.profiles_editor)
        profiles_visible = not self.closed and self.get_visible() and self.get_mapped() and self.stack.get_visible_child_name() == "profiles"
        if self.profiles_editor:
            self.profiles_editor.set_active(profiles_visible)
        phone_visible = not self.closed and self.get_visible() and self.get_mapped() and self.stack.get_visible_child_name() == "phone"
        if phone_visible and self.phone_editor is None:
            self.phone_editor = PhoneEditor(self.owner, self)
            self.phone.append(self.phone_editor)
        if self.phone_editor:
            self.phone_editor.set_active(phone_visible)
        machines_visible = not self.closed and self.get_visible() and self.get_mapped() and self.stack.get_visible_child_name() == "machines"
        if machines_visible and self.machines_editor is None:
            self.machines_editor = MachinesEditor(self.owner, self)
            self.machines.append(self.machines_editor)
        if self.machines_editor:
            self.machines_editor.set_active(machines_visible)
        self.scroll_tabs()
        self.owner.report_ui()

    def scroll_tabs(self, *_args):
        # The switcher updates its buttons and the tab row gets its size after this signal, so the scroll waits.
        if self.tabs_reveal is None and self.tabs_scroll.get_visible() and not self.closed:
            self.tabs_reveal = GLib.idle_add(self.reveal_tab)

    def reveal_tab(self):
        self.tabs_reveal = None
        button = self.tabs.get_first_child()
        while button and not button.get_active():
            button = button.get_next_sibling()
        found, bounds = button.compute_bounds(self.tabs_scroll) if button and not self.closed else (False, None)
        if found:
            adjustment = self.tabs_scroll.get_hadjustment()
            value = adjustment.get_value()
            left, right = value + bounds.get_x() - 6, value + bounds.get_x() + bounds.get_width() + 6
            adjustment.set_value(min(max(value, right - adjustment.get_page_size()), left))
        return False

    def window_key(self, _controller, key, _code, modifiers):
        if key == Gdk.KEY_Escape and not modifiers & SHORTCUT_MASK:
            self.close()
            return True
        return False

    def cancel_dialogs(self):
        if self.profiles_editor:
            self.profiles_editor.cancel_dialogs()
        for window in Gtk.Window.list_toplevels():
            if window.get_transient_for() is self:
                window.close()

    def on_close(self, *_args):
        if self.profiles_editor:
            self.profiles_editor.set_active(False)
        self.cancel_dialogs()
        self.set_visible(False)
        return True

    def dispose(self):
        self.closed = True
        if self.profiles_editor:
            self.profiles_editor.close()
        if self.phone_editor:
            self.phone_editor.close()
        if self.machines_editor:
            self.machines_editor.close()
        self.cancel_dialogs()
        self.destroy()


class SwitchboardWindow(Adw.ApplicationWindow):
    drawer_view, drawer_peek, drawer_count, column_pixel_width = False, False, 0, DEFAULT_COLUMN_WIDTH
    wide_controls, tiny_controls, search_expanded, show_app_pills = False, False, False, False
    message_seen = None
    number_hold = number_idle = number_scroll = number_pressed = None
    numbers_shown = False
    number_keys = open_popovers = ()

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
            self.show_app_pills = layout["showAppPills"]
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
        self.sources_revision = None
        self.ui_client_id = str(uuid.uuid4())
        self.ui_report_last, self.ui_report_at, self.ui_report_sending = None, 0, False
        self.refresh_interval_ms = 5000
        self.clock_interval = self.clock_timer = None
        self.notice_timer, self.notice_generation, self.provider_notice = None, 0, ""
        self.opening, self.focus_widgets, self.row_cache = set(), {}, {}
        self.palette_sent = self.palette_wanted = None
        self.palette_sending = False
        self.list_columns = []
        self.focus_generation = 0
        self.connect("notify::focus-widget", self.focus_changed)
        self.key_focus_row = None
        for name in ("focus-widget", "focus-visible"):
            self.connect("notify::" + name, self.key_focus_changed)
        self.session_actions = set()
        self.open_errors = {}
        self.context_menu = None
        self.preferences_window = None
        self.drag_identity = None
        for name in ("mark-unread", "mark-read", "pin", "unpin", "pin-up", "pin-down", "discard-result", "keep-result",
                     "drawer-in", "drawer-out", "mute", "unmute"):
            action = Gio.SimpleAction.new(name, GLib.VariantType.new("s"))
            action.connect("activate", self.row_action, name)
            self.add_action(action)
        # Copy is local: it sends no request, so a pending server action does not block it.
        copy = Gio.SimpleAction.new("copy-reference", GLib.VariantType.new("s"))
        copy.connect("activate", self.copy_reference)
        self.add_action(copy)
        self.geometry = None
        self.layout_signature = None
        self.geometry_idle = self.surface_signal = None
        self.layout_surface = None
        self.snapshot_pending = bool(os.environ.get("ASB_SNAPSHOT"))
        self.connect("close-request", self.on_close)
        self.css = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(self.get_display(), self.css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        # One provider for all profile badges: a provider per badge made each new card slow.
        self.badge_css, self.badge_colors = Gtk.CssProvider(), {}
        Gtk.StyleContext.add_provider_for_display(self.get_display(), self.badge_css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
        Gtk.IconTheme.get_for_display(self.get_display()).add_search_path(str(Path(__file__).parents[1] / "assets" / "icons"))
        self.set_icon_name(APP_ID)
        self.set_palette(None)
        self.refresh_button = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh sessions")
        self.refresh_button.connect("clicked", lambda *_: self.refresh(True))
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        self.tools = tools = Gtk.Box(spacing=4, margin_start=4, margin_end=4, margin_top=2)
        tools.add_css_class("asb-toolbar")
        self.app_mark = Gtk.Image(icon_name=APP_ID, pixel_size=16, tooltip_text="ASB")
        self.app_mark.set_size_request(20, -1)
        self.app_mark.set_valign(Gtk.Align.START)
        self.app_mark.update_property([Gtk.AccessibleProperty.LABEL], ["ASB app icon"])
        tools.append(self.app_mark)
        self.toolbar_center = Gtk.Box(spacing=4, hexpand=True, valign=Gtk.Align.START)
        tools.append(self.toolbar_center)
        self.search = Gtk.SearchEntry(placeholder_text="Find a session or folder", hexpand=True)
        self.search.set_search_delay(0)
        self.search.set_size_request(0, -1)
        self.search.set_tooltip_text("Search title or folder. cl: or claude: selects Claude; cx: or codex: selects Codex; "
                                     "oc: or opencode: selects OpenCode.")
        self.search.connect("search-changed", self.filter_changed)
        self.search.connect("stop-search", self.clear_search)
        # No arrow: the custom 1px popover edge is on the contents node only.
        self.search_popover = Gtk.Popover(position=Gtk.PositionType.BOTTOM, has_arrow=False)
        self.search_popover.set_parent(self.toolbar_center)
        self.search_popover.set_child(self.search)
        self.search.set_size_request(240, -1)
        self.search_popover.connect("closed", lambda *_args: setattr(self, "search_expanded", False))
        # The narrow search popover gets its own key events; the number keys work there as on the board.
        popover_keys = Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        popover_keys.connect("key-pressed", lambda _controller, key, _code, modifiers: bool(self.number_key_pressed(key, modifiers)))
        popover_keys.connect("key-released", self.window_key_released)
        self.search_popover.add_controller(popover_keys)
        # Any other popover blocks the number keys, also one that does not take the focus.
        self.open_popovers = set()
        self.popover_hooks = [(name, GObject.add_emission_hook(Gtk.Popover, name, self.popover_visibility, name))
                              for name in ("map", "unmap")]
        self.search_button = Gtk.Button(icon_name="system-search-symbolic", tooltip_text="Find a session or folder", valign=Gtk.Align.START)
        self.search_button.add_css_class("asb-toolbar-button")
        self.search_button.update_property([Gtk.AccessibleProperty.LABEL], ["Search sessions"])
        self.search_button.connect("clicked", self.open_search)
        self.toolbar_center.append(self.search_button)
        menu = Gtk.Button(icon_name="view-more-symbolic", tooltip_text="Preferences")
        menu.update_property([Gtk.AccessibleProperty.LABEL], ["Open Preferences"])
        menu.connect("clicked", self.open_preferences)
        menu.add_css_class("asb-toolbar-button")
        self.menu_button = menu
        sessions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        appearance = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.apps, self.syncing_apps = set(), False
        self.app_filter = Gtk.DropDown.new_from_strings([title for title, _apps in APP_CHOICES])
        self.states, self.updating_states = set(STATES), False
        self.state_summary = label("All states", "caption")
        state_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        checks = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, column_spacing=12, row_spacing=8,
                             min_children_per_line=2, max_children_per_line=4, homogeneous=True)
        state_box.append(checks)
        self.state_checks = {}
        for state in STATES:
            check = Gtk.CheckButton(label=state.capitalize(), active=True)
            check.connect("toggled", self.states_changed)
            self.state_checks[state] = check
            checks.insert(check, -1)
        choices = Gtk.Box(spacing=6)
        self.state_summary.set_hexpand(True)
        choices.append(self.state_summary)
        for title, values in (("All", set(STATES)), ("Clear", set())):
            button = Gtk.Button(label=title)
            button.connect("clicked", lambda _button, selected=values: self.select_states(selected))
            choices.append(button)
        state_box.append(choices)
        help_text = label("No selected states hides all sessions.", "caption")
        help_text.set_wrap(True)
        state_box.append(help_text)
        self.archive = Gtk.CheckButton(label="Show archived sessions")
        self.app_filter.update_property([Gtk.AccessibleProperty.LABEL], ["App"])
        self.app_filter.connect("notify::selected", self.apps_from_preferences)
        row = Gtk.Box(spacing=12)
        name = label("App")
        name.set_hexpand(True)
        row.append(name)
        row.append(self.app_filter)
        sessions.append(label("Show sessions", "heading"))
        sessions.append(row)
        sessions.append(state_box)
        self.archive.connect("toggled", self.filter_changed)
        sessions.append(self.archive)
        self.app_pills_setting = Gtk.CheckButton(label="Show app pills", active=self.show_app_pills)
        self.app_pills_setting.connect("toggled", self.change_app_pills_setting)
        sessions.append(self.app_pills_setting)
        self.app_pills_error = label("", "warning")
        self.app_pills_error.set_wrap(True)
        sessions.append(self.app_pills_error)
        self.preferences_refresh_row = Gtk.Box(spacing=8)
        preferences_search = Gtk.Button(label="Find a session or folder")
        preferences_search.connect("clicked", self.open_search_from_preferences)
        sessions.append(preferences_search)
        sessions.append(self.preferences_refresh_row)
        self.syncing_unread_setting = self.unread_setting_loading = False
        sessions.append(Gtk.Separator())
        sessions.append(label("Unread", "heading"))
        self.persistent_unread = Gtk.CheckButton(label="Persistent unread", active=True)
        self.persistent_unread.connect("toggled", self.change_unread_setting)
        sessions.append(self.persistent_unread)
        unread_help = label("Turn off Unread in the row panel to clear dots.", "caption")
        unread_help.set_wrap(True)
        sessions.append(unread_help)
        self.unread_setting_error = label("", "warning")
        self.unread_setting_error.set_wrap(True)
        self.unread_setting_error.set_max_width_chars(32)
        sessions.append(self.unread_setting_error)
        sessions.append(Gtk.Separator())
        self.quit_engine_button = Gtk.Button(label="Quit ASB", halign=Gtk.Align.START)
        self.quit_engine_button.connect("clicked", self.quit_engine)
        sessions.append(self.quit_engine_button)
        quit_help = label("Stops ASB and phone access. Closing the window keeps them running.", "caption")
        quit_help.set_wrap(True)
        sessions.append(quit_help)
        self.quit_engine_error = label("", "warning")
        self.quit_engine_error.set_wrap(True)
        self.quit_engine_error.set_max_width_chars(32)
        sessions.append(self.quit_engine_error)
        view_row = Gtk.Box(spacing=12)
        view_name = label("View")
        view_name.set_hexpand(True)
        self.view_filter = Gtk.DropDown.new_from_strings(["Compact", "Comfortable"])
        self.view_filter.set_selected(1 if self.view == "comfortable" else 0)
        self.view_filter.update_property([Gtk.AccessibleProperty.LABEL], ["View"])
        self.view_filter.connect("notify::selected", self.change_view)
        view_row.append(view_name)
        view_row.append(self.view_filter)
        appearance.append(view_row)
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
        appearance.append(width_row)
        reset_width = Gtk.Button(label="Reset width")
        reset_width.connect("clicked", self.reset_width)
        appearance.append(reset_width)
        self.layout_error = label(layout_error, "warning")
        self.layout_error.set_wrap(True)
        self.layout_error.set_max_width_chars(32)
        appearance.append(self.layout_error)
        appearance.append(Gtk.Separator())
        self.theme_mode = Gtk.DropDown.new_from_strings(["GNOME colors", "Custom colors"])
        theme_row = Gtk.Box(spacing=12)
        theme_name = label("Colors")
        theme_name.set_hexpand(True)
        theme_row.append(theme_name)
        self.theme_mode.update_property([Gtk.AccessibleProperty.LABEL], ["Colors"])
        theme_row.append(self.theme_mode)
        appearance.append(theme_row)
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
            appearance.append(row)
        self.theme_error = label("", "warning")
        self.theme_error.set_wrap(True)
        self.theme_error.set_max_width_chars(32)
        appearance.append(self.theme_error)
        actions = Gtk.Box(spacing=8)
        apply = Gtk.Button(label="Apply theme")
        apply.connect("clicked", self.apply_theme)
        reset = Gtk.Button(label="Reset to GNOME")
        reset.connect("clicked", self.reset_theme)
        actions.append(apply)
        actions.append(reset)
        appearance.append(actions)
        appearance.append(label("Colors apply only to ASB.", "caption"))
        self.toolbar_end = Gtk.Box(spacing=4, valign=Gtk.Align.START)
        tools.append(self.toolbar_end)
        self.refresh_button.add_css_class("asb-toolbar-button")
        self.refresh_button.set_label("Refresh sessions")
        self.preferences_refresh_row.append(self.refresh_button)
        self.toolbar_end.append(menu)
        self.window_controls = Gtk.WindowControls(side=Gtk.PackType.END, decoration_layout=":close")
        self.toolbar_end.append(self.window_controls)
        self.window_handle = Gtk.WindowHandle(child=tools)
        body.append(self.window_handle)
        self.toolbar_strip = Gtk.Box(spacing=4)
        self.pending_group = Gtk.Box(spacing=4)
        self.toolbar_strip.append(self.pending_group)
        self.toolbar_scroll = Gtk.ScrolledWindow(hexpand=True, hscrollbar_policy=Gtk.PolicyType.EXTERNAL,
                                                vscrollbar_policy=Gtk.PolicyType.NEVER, child=self.toolbar_strip)
        self.toolbar_scroll.set_size_request(0, -1)
        self.toolbar_center.append(self.toolbar_scroll)
        toolbar_wheel = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.BOTH_AXES)
        toolbar_wheel.connect("scroll", self.scroll_toolbar)
        self.toolbar_scroll.add_controller(toolbar_wheel)
        self.app_pills = {}
        self.app_pill_labels = {}
        self.app_pill_icons = {}
        for provider, title in APP_PILLS:
            pill = Gtk.ToggleButton(tooltip_text=f"Select {title}. No selected apps or all apps shows all sessions.")
            pill.add_css_class("asb-filter-pill")
            pill.update_property([Gtk.AccessibleProperty.LABEL], [f"Select {title}"])
            content = Gtk.Box(spacing=3)
            icon = Gtk.Image(icon_name=provider_icon(provider), pixel_size=14)
            content.append(icon)
            name = label(title)
            content.append(name)
            pill.set_child(content)
            pill.connect("toggled", self.apps_from_pills)
            self.app_pills[provider] = pill
            self.app_pill_labels[provider], self.app_pill_icons[provider] = name, icon
            self.pending_group.append(pill)
            pill.set_visible(self.show_app_pills)
            name.set_visible(False)
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
        self.drawer_only.update_property([Gtk.AccessibleProperty.LABEL], ["Drawer only. The drawer is empty."])
        drawer = Gtk.Box(spacing=3)
        drawer.append(self.drawer_glyph())
        self.drawer_label = label("Drawer")
        self.drawer_label.set_visible(False)
        drawer.append(self.drawer_label)
        self.drawer_dot = Gtk.Box(valign=Gtk.Align.CENTER, visible=False)
        self.drawer_dot.add_css_class("asb-drawer-dot")
        drawer.append(self.drawer_dot)
        self.drawer_only.set_child(drawer)
        self.pending_only.connect("notify::active", self.exclusive_pill, self.drawer_only)
        self.drawer_only.connect("notify::active", self.exclusive_pill, self.pending_only)
        peek = Gtk.EventControllerMotion()
        peek.connect("enter", lambda *_args: self.set_drawer_peek(True))
        peek.connect("leave", lambda *_args: self.set_drawer_peek(False))
        self.drawer_only.add_controller(peek)
        self.pending_group.append(self.drawer_only)
        self.filter_chip_group = Gtk.Box(spacing=4, visible=False)
        self.filter_chip_signature = None
        self.filter_chip_widgets = {}
        for key in ("app", "states", "archive"):
            chip = Gtk.Button()
            chip.add_css_class("asb-filter-pill")
            content = Gtk.Box(spacing=6)
            name = label("")
            content.append(name)
            content.append(Gtk.Image(icon_name="window-close-symbolic", pixel_size=12))
            chip.set_child(content)
            chip.connect("clicked", self.clear_filter_chip, key)
            self.filter_chip_group.append(chip)
            chip.set_visible(False)
            self.filter_chip_widgets[key] = (chip, name)
        self.toolbar_strip.append(self.filter_chip_group)
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
        self.scroll.after_layout = self.after_layout
        self.scroll.connect("unmap", self.cancel_motion)
        self.scroll.get_hadjustment().connect("value-changed", self.scroll_position_changed)
        self.scroll.get_hadjustment().connect("changed", self.cancel_scroll)
        self.scroll.connect("unmap", self.cancel_scroll)
        # A press on the scrollbar is a board scroll, as the wheel is; programmatic scrolls keep the numbers.
        scrollbar_press = Gtk.GestureClick(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        scrollbar_press.connect("pressed", self.hide_numbers)
        self.scroll.get_hscrollbar().add_controller(scrollbar_press)
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
        keys.connect("key-released", self.window_key_released)
        self.add_controller(keys)
        self.connect("notify::is-active", self.active_changed)
        self.connect("unmap", self.hide_numbers)
        self.preferences_window = PreferencesWindow(self, sessions, appearance)
        try:
            saved = read_theme(theme_path)
            if saved:
                self.set_palette(saved)
                self.theme_mode.set_selected(1)
                self.set_theme_pickers(saved)
        except (OSError, ValueError) as error:
            self.theme_error.set_label(str(error))
        self.publish_palette()
        style = Adw.StyleManager.get_default()
        for name in ("dark", "accent-color"):
            if style.find_property(name):
                # GNOME colors follow the system style; the phone gets them after GTK loads the new style.
                style.connect("notify::" + name, lambda *_args: GLib.idle_add(self.publish_palette))
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
        return "#" + "".join(f"{max(0, min(255, round(channel * 255))):02x}" for channel in (color.red, color.green, color.blue))

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
{base}.asb-preferences stackswitcher > button.text-button {{ min-width: 0; }}
{base} .asb-toolbar-button,
{base} .asb-toolbar windowcontrols button {{ min-height: 24px; min-width: 22px; padding: 2px; }}
{base} .asb-toolbar searchentry {{ min-height: 26px; padding-top: 0; padding-bottom: 0; }}
{base} .asb-state {{ font-size: 11px; }}
{base} .asb-provider {{ opacity: .65; }}
{base} .asb-message-lit .asb-provider {{ color: @accent_color; opacity: 1; }}
{base} .asb-source-badge {{ min-width: 6px; min-height: 6px; padding: 0; border: 1px solid @window_bg_color;
    border-radius: 50%; box-shadow: none; opacity: 1; }}
{base} .asb-column {{ background: transparent; }}
{base} .asb-number {{ min-width: 16px; min-height: 15px; padding: 0; border: 1px solid alpha(@window_fg_color, .36);
    border-bottom-width: 2px; border-radius: 3px; background: mix(@window_bg_color, @window_fg_color, .17);
    color: @window_fg_color; font-size: 11px; font-weight: bold; line-height: 15px; opacity: 0;
    transition: opacity 100ms ease-out; }}
{base}:not(.asb-comfortable) .asb-number {{ min-width: 14px; min-height: 13px; line-height: 13px; }}
{base} .asb-numbers-shown .asb-number {{ opacity: 1; transition: opacity 140ms ease-out; }}
{base} .asb-number.asb-number-pressed {{ background: @accent_bg_color; color: @accent_fg_color; }}
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
{base} .asb-drawer-dot {{ min-width: 5px; min-height: 5px; border-radius: 50%; background: @accent_color; }}
{base} .asb-filter-pill:checked .asb-drawer-dot {{ background: @accent_fg_color; }}
{base} .asb-drawer-button {{ opacity: 0; background: alpha(@window_fg_color, .08); }}
{base} .asb-session:hover .asb-drawer-button, {base} .asb-key-focus .asb-drawer-button {{ opacity: 1; }}
{base} .asb-drawer-button.asb-drawer-filled {{ color: @accent_color; }}
{base} .asb-drawer-button:hover, {base} .asb-drawer-button:focus-visible {{ background: alpha(@accent_color, .15); }}
{base} .asb-copy-button {{ opacity: 0; background: alpha(@window_fg_color, .08); }}
{base} .asb-session:hover .asb-copy-button, {base} .asb-key-focus .asb-copy-button {{ opacity: 1; }}
{base} .asb-copy-button:hover, {base} .asb-copy-button:focus-visible {{ background: alpha(@accent_color, .15); }}
{base} .asb-copy-button.asb-copy-confirmed {{ color: @success_color; background: alpha(@success_color, .12); }}
{base} .asb-corner-wide {{ padding: 0 0 2px 16px; border-radius: 0 0 0 12px; }}
{base} .asb-session:hover .asb-corner-wide, {base} .asb-key-focus .asb-corner-wide {{
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
{base} popover.asb-row-panel > contents {{ padding: 12px; border: 1px solid alpha(@accent_color, .7); border-radius: 12px; background: @window_bg_color;
    box-shadow: 0 2px 8px alpha(black, .35), 0 8px 24px alpha(black, .3); }}
{base} .asb-row-panel .asb-panel-folder, {base} .asb-row-panel .asb-panel-state {{ font-size: 11px; }}
{base} .asb-row-panel .asb-panel-title {{ font-size: 13px; font-weight: bold; }}
{base} .asb-row-panel .asb-panel-open {{ min-height: 34px; border-radius: 8px; font-weight: bold; }}
{base} .asb-row-panel .asb-panel-move {{ min-height: 28px; padding: 0 10px; font-size: 12px; font-weight: normal; }}
{base} .asb-row-panel row .subtitle {{ color: alpha(@window_fg_color, .72); opacity: 1; }}
{base} .asb-row-panel .asb-panel-error {{ font-size: 11px; }}
{base} .asb-row-panel list.boxed-list {{ background-color: @window_bg_color; box-shadow: 0 0 0 1px @borders; }}
{base} .asb-row-panel list.boxed-list > row {{ border-bottom-color: @borders; }}
"""
        if colors:
            colors = validate_theme(colors)
            self.add_css_class("asb-custom")
            scope = base + ".asb-custom"
            number_fill, number_edge, number_pressed = number_badge_colors(colors)
            # The neutral popover edge, not the divider color, which can be near the background.
            panel_line = edge_color(colors['background'], colors['text'], .36, (colors['background'],))
            css += f"""
{scope}, {scope} headerbar, {scope} popover contents {{ background: {colors['background']}; color: {colors['text']}; }}
{scope} popover > contents {{ border: 1px solid {edge_color(colors['background'], colors['text'], .36, (colors['background'],))}; }}
{scope} popover.asb-row-panel > contents {{ background: {colors['background']}; border-color: {edge_color(colors['background'], colors['accent'], .7, (colors['background'],))}; }}
{scope} .asb-row-panel .asb-panel-unread {{ color: {colors['text']}; }}
{scope} .asb-row-panel list.boxed-list {{ background-color: {colors['background']}; box-shadow: 0 0 0 1px {panel_line}; }}
{scope} .asb-row-panel list.boxed-list > row {{ border-bottom-color: {panel_line}; }}
{scope} .asb-row-panel row .subtitle {{ color: {colors['muted']}; opacity: 1; }}
{scope} .asb-state, {scope} .dim-label {{ color: {colors['muted']}; opacity: 1; }}
{scope} .asb-working, {scope} .asb-waiting {{ color: {colors['accent']}; }}
{scope} .asb-message-lit .asb-provider {{ color: {colors['accent']}; }}
{scope} .asb-dot, .asb-tooltip.asb-custom .asb-dot {{ background: {colors['accent']}; }}
{scope} .asb-dot.asb-question, .asb-tooltip.asb-custom .asb-dot.asb-question {{ background: none; color: {colors['accent']}; }}
{scope} .asb-dot.asb-stop, .asb-tooltip.asb-custom .asb-dot.asb-stop {{ background: {colors['muted']}; }}
{scope} .asb-dot.asb-discard, .asb-tooltip.asb-custom .asb-dot.asb-discard {{ background: none; border-color: {colors['text']}; }}
{scope} .asb-discard-offer .asb-discard {{ border-color: {colors['muted']}; }}
{scope} .asb-column + .asb-column {{ border-color: {colors['divider']}; }}
{scope} .asb-number {{ background: {number_fill}; border-color: {number_edge}; color: {colors['text']}; }}
{scope} .asb-number.asb-number-pressed {{ background: {colors['accent']}; color: {number_pressed}; }}
{scope} .asb-session:hover, {scope} .asb-session:focus-within {{ background: {highlight_color(colors)}; }}
{scope} entry, {scope} button, {scope} dropdown {{ color: {colors['text']}; }}
{scope} button.destructive-action, {scope} button.destructive {{ color: @destructive_color; }}
{scope}.asb-preferences .asb-preferences-nav {{ background: alpha({colors['text']}, .04); }}
{scope}.asb-preferences entry, {scope}.asb-preferences button, {scope}.asb-preferences dropdown {{ background: alpha({colors['text']}, .08); }}
{scope}.asb-preferences row:selected, {scope}.asb-preferences button:checked {{ background: {colors['accent']}; color: {colors['background']}; }}
{scope}.asb-preferences separator {{ background: {colors['divider']}; }}
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
{scope} .asb-drawer-dot {{ background: {colors['accent']}; }}
{scope} .asb-filter-pill:checked .asb-drawer-dot {{ background: {colors['background']}; }}
{scope} .asb-drawer-button {{ background: alpha({colors['text']}, .08); }}
{scope} .asb-drawer-button.asb-drawer-filled {{ color: {colors['accent']}; }}
{scope} .asb-drawer-button:hover, {scope} .asb-drawer-button:focus-visible {{ background: alpha({colors['accent']}, .15); }}
{scope} .asb-copy-button {{ background: alpha({colors['text']}, .08); }}
{scope} .asb-copy-button:hover, {scope} .asb-copy-button:focus-visible {{ background: alpha({colors['accent']}, .15); }}
{scope} .asb-copy-button.asb-copy-confirmed {{ color: {colors['accent']}; background: alpha({colors['accent']}, .15); }}
{scope} .asb-session:hover .asb-corner-wide, {scope} .asb-key-focus .asb-corner-wide {{
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
        self.badge_colors.clear()
        self.badge_css.load_from_string("")
        quiet_title, title_fraction = quiet_color(palette, "text", .67, highlight)
        quiet_caption, caption_fraction = quiet_color(palette, "muted" if colors else "text", .85 if colors else .5, highlight)
        # A limited row is dimmer than a quiet row: 4.5:1 on the background, and on the highlight while it is shown.
        limited, limited_fraction = limited_color(palette)
        limited_hover, hover_fraction = quiet_color(palette, "text", 0, highlight)
        if not colors:
            quiet_title = f"mix(@window_bg_color, @window_fg_color, {title_fraction})"
            quiet_caption = f"mix(@window_bg_color, @window_fg_color, {caption_fraction})"
            limited = f"mix(@window_bg_color, @window_fg_color, {limited_fraction})"
            limited_hover = f"mix(@window_bg_color, @window_fg_color, {hover_fraction})"
        # A drawer row is quiet as a read row, but not while the Drawer pill shows it as unread.
        quiet = [base + ".asb-comfortable .asb-idle-read:not(.asb-limited):not(.asb-drawer-lit):not(:hover):not(:focus-within)"]
        parts = (" .asb-title", " .asb-folder", " .asb-state", " .asb-age", " .asb-limit-clock", " .asb-mute-glyph", " .asb-where",
                 " .asb-where-icon")
        # The Grey tone of a view-only row with no attention, in both views; hover and focus bring the normal colors back.
        calm = ":not(.asb-limited):not(.asb-drawer-lit):not(:hover):not(:focus-within)"
        view_only, view_only_rest = f"{base} .asb-view-only-quiet{calm}", f"{base} .asb-view-only-rest{calm}"
        css += f"""
{", ".join(row + " .asb-title" for row in quiet)} {{ color: {quiet_title}; opacity: 1; }}
{", ".join(row + part for row in quiet for part in (" .asb-folder", " .asb-state", " .asb-age"))} {{ color: {quiet_caption}; opacity: 1; }}
{", ".join(base + " .asb-limited" + part for part in parts)} {{ color: {limited}; opacity: 1; }}
{", ".join(base + " .asb-limited" + state + part for state in (":hover", ":focus-within") for part in parts)} {{ color: {limited_hover}; }}
{base} .asb-limited:not(.asb-message-lit) .asb-provider {{ opacity: .4; }}
{view_only} .asb-title {{ color: {quiet_title}; opacity: 1; }}
{", ".join(view_only + part for part in (" .asb-folder", " .asb-age", " .asb-where", " .asb-where-icon"))} {{ color: {quiet_caption}; opacity: 1; }}
{view_only_rest} .asb-state {{ color: {quiet_caption}; opacity: 1; }}
"""
        self.css.load_from_string(css)
        self.hover_colors = colors
        for widget in self.row_cache.values():
            widget.asb_tooltip_content = widget.asb_tooltip_key = None
            widget.asb_source_badge.set_color(source_marker_color(widget.asb_thread))
        if getattr(self, "preferences_window", None):
            preferences = self.preferences_window
            (preferences.add_css_class if colors else preferences.remove_css_class)("asb-custom")
            if preferences.profiles_editor:
                preferences.profiles_editor.update_marker_colors()

    def badge_class(self, displayed):
        """The style class of a profile badge color; the rules of all badge colors are in self.badge_css."""
        name = "asb-badge-" + displayed[1:].lower()
        if name not in self.badge_colors:
            self.badge_colors[name] = displayed
            background, highlight = self.profile_surfaces
            self.badge_css.load_from_string("".join(
                f""".asb-source-badge.{key} {{ background: {color}; border-color: {background}; }}
.asb-session:hover .asb-source-badge.{key}, .asb-session:focus-within .asb-source-badge.{key} {{ border-color: {highlight}; }}
""" for key, color in self.badge_colors.items()))
        return name

    def publish_palette(self):
        if self.closed:
            return False
        if self.hover_colors:
            self.palette_wanted = palette_payload(self.hover_colors)
        else:
            context = self.get_style_context()
            found = [context.lookup_color(name) for name in ("success_color", "warning_color")]
            self.palette_wanted = palette_payload(None, self.native_colors(),
                                                  *(self.hex_color(value) if ok else None for ok, value in found))
        if not self.palette_sending and self.palette_wanted != self.palette_sent:
            sent = self.palette_wanted
            self.palette_sending = True
            request_async(self.base, "/api/palette", lambda _result, error: self.palette_published(sent, error),
                          GLib.idle_add, "POST", sent)
        return False

    def palette_published(self, sent, error):
        self.palette_sending = False
        if error:
            # The next palette apply tries again.
            print(f"ASB cannot share its palette with the phone: {error}", file=sys.stderr)
        else:
            self.palette_sent = sent
            if self.palette_wanted != sent and not self.closed:
                self.publish_palette()
        return False

    def open_preferences(self, *_args):
        if not self.closed:
            self.preferences_window.present()

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
            self.publish_palette()
            self.theme_error.remove_css_class("warning")
            self.theme_error.set_label("Custom theme saved." if colors else "GNOME colors applied.")
        except (ValueError, OSError) as error:
            self.theme_error.add_css_class("warning")
            self.theme_error.set_label(str(error))

    def reset_theme(self, *_args):
        try:
            write_theme(self.theme_path)
            self.set_palette(None)
            self.publish_palette()
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
            self.report_ui()
            self.refresh()
        return not self.closed

    def report_ui(self):
        if self.closed or not SOURCE_TOKEN or not getattr(self, "ui_client_id", None):
            return
        preferences = self.preferences_window
        editor = preferences.profiles_editor if preferences else None
        visible = bool(preferences and not preferences.closed and preferences.get_visible() and preferences.get_mapped()
                       and preferences.stack.get_visible_child_name() == "profiles")
        payload = {"clientId": self.ui_client_id, "sourcesRevision": self.sources_revision,
                   "profilesRevision": editor.revision if editor and editor.loaded else None,
                   "profilesVisible": visible, "dirty": editor.is_dirty() if editor else False}
        if self.ui_report_sending or payload == self.ui_report_last and time.monotonic() - self.ui_report_at < 25:
            return
        self.ui_report_last, self.ui_report_at, self.ui_report_sending = payload, time.monotonic(), True
        def finished(_result, _error):
            self.ui_report_sending = False
            if not self.closed:
                self.report_ui()
            return False
        request_async(self.base, "/api/agent/ui", finished, GLib.idle_add, "POST", payload)

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
            return False
        if dashboard is not None:
            self.dashboard, self.dashboard_etag = dashboard, etag and etag[0]
            self.sources_revision = source_revision(dashboard.get("sourcesRevision"))
        preferences = self.preferences_window
        if preferences and preferences.profiles_editor:
            preferences.profiles_editor.observe_revision(self.sources_revision)
        self.report_ui()
        if dashboard is None:
            return False
        interval = refresh_interval(dashboard)
        if interval != self.refresh_interval_ms:
            self.refresh_interval_ms = interval
            GLib.source_remove(self.timer)
            self.timer = GLib.timeout_add(interval, self.tick)
        self.sync_unread_setting(dashboard.get("persistentUnread", True))
        self.set_notice(" ".join(provider.get("message", "") for provider in dashboard.get("providers", []) if provider.get("message")), temporary=True)
        signature = dashboard.get("threads", [])
        if signature != self.signature or any(type(row.get("sourceCount")) is not type(previous.get("sourceCount"))
                                               for row, previous in zip(signature, self.signature or [])):
            self.signature = signature
            self.render()
        self.play_messages(dashboard.get("messages"))
        self.update_clock()
        if self.snapshot_pending:
            self.snapshot_pending = False
            GLib.timeout_add(250, self.capture)
        return False

    def play_messages(self, messages):
        if self.message_seen is None or not messages:
            self.message_seen = new_messages(messages, None, {}, 0, 0)[1]
            return
        room = MESSAGE_FLIGHT_LIMIT - len(self.list_body.flights)
        play, self.message_seen = new_messages(messages, self.message_seen, self.focus_widgets, time.time() * 1000, room)
        if play:
            # New rows have their places only after the next layout.
            self.list_body.add_tick_callback(self.messages_after_layout, play)

    def messages_after_layout(self, _widget, _clock, play):
        GLib.idle_add(self.start_messages, play)
        return False

    def start_messages(self, play):
        if self.closed:
            return False
        animations = self.get_settings().get_property("gtk-enable-animations")
        for source, target, _at in play:
            rows = self.focus_widgets.get(source), self.focus_widgets.get(target)
            if None in rows:
                continue
            ends = self.list_body.message_ends({"rows": rows})
            # A message between two cards outside the viewport plays nothing.
            if ends is None or ends[0][2] and ends[1][2]:
                continue
            if not animations:
                for row in rows:
                    self.light_row(row, MESSAGE_LIGHT_MS)
            elif len(self.list_body.flights) < MESSAGE_FLIGHT_LIMIT:
                self.list_body.start_flight(*rows, self.message_color(), ends)
                self.light_row(rows[0], 160)
        return False

    def message_color(self):
        if self.hover_colors:
            return self.rgba(self.hover_colors["accent"])
        found, color = self.get_style_context().lookup_color("accent_color")
        return color if found else self.get_color()

    def light_row(self, widget, duration):
        self.clear_message_light(widget)
        generation = widget.asb_light_generation
        def clear():
            if widget.asb_light_generation == generation:
                widget.asb_light_timer = None
                widget.remove_css_class("asb-message-lit")
            return False
        widget.add_css_class("asb-message-lit")
        widget.asb_light_timer = GLib.timeout_add(duration, clear)

    def clear_message_light(self, widget):
        if getattr(widget, "asb_light_timer", None):
            GLib.source_remove(widget.asb_light_timer)
            widget.remove_css_class("asb-message-lit")
        widget.asb_light_timer = None
        widget.asb_light_generation = getattr(widget, "asb_light_generation", 0) + 1

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
        wide, tiny = self.get_width() >= 680, self.get_width() < 320
        if (wide, tiny) != (self.wide_controls, self.tiny_controls):
            self.wide_controls, self.tiny_controls = wide, tiny
            self.update_toolbar_presentation()
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

    def update_toolbar_presentation(self):
        wide = self.wide_controls
        focused = self.get_focus()
        search_focused = bool(focused and (focused is self.search or focused.is_ancestor(self.search)))
        if wide != (self.search.get_parent() is self.toolbar_center):
            if wide:
                self.search_popover.popdown()
                self.search_popover.set_child(None)
                self.search.set_size_request(0, -1)
                self.toolbar_center.prepend(self.search)
            else:
                self.toolbar_center.remove(self.search)
                self.search.set_size_request(240, -1)
                self.search_popover.set_child(self.search)
        self.app_mark.set_visible(not self.tiny_controls)
        self.search_button.set_visible(not wide and not self.tiny_controls)
        if wide != (self.refresh_button.get_parent() is self.toolbar_end):
            self.refresh_button.get_parent().remove(self.refresh_button)
            if wide:
                self.refresh_button.set_icon_name("view-refresh-symbolic")
                self.toolbar_end.prepend(self.refresh_button)
            else:
                self.refresh_button.set_label("Refresh sessions")
                self.preferences_refresh_row.append(self.refresh_button)
        self.preferences_refresh_row.set_visible(not wide)
        self.drawer_label.set_visible(wide)
        for provider, pill in self.app_pills.items():
            pill.set_visible(self.show_app_pills)
            self.app_pill_labels[provider].set_visible(wide)
            self.app_pill_icons[provider].set_visible(not wide)
        if search_focused:
            self.open_search()

    def scroll_toolbar(self, _controller, dx, dy):
        adjustment = self.toolbar_scroll.get_hadjustment()
        distance = dx or dy
        before = adjustment.get_value()
        adjustment.set_value(max(0, min(before + distance * 40, adjustment.get_upper() - adjustment.get_page_size())))
        return adjustment.get_value() != before

    def change_app_pills_setting(self, *_args):
        selected = self.app_pills_setting.get_active()
        if selected == self.show_app_pills:
            return
        try:
            write_layout(self.layout_path, self.column_width, self.view, selected)
        except (OSError, ValueError) as error:
            self.app_pills_setting.set_active(self.show_app_pills)
            self.app_pills_error.set_label(str(error))
            return
        self.show_app_pills = selected
        self.app_pills_error.set_label("")
        self.update_toolbar_presentation()
        self.sync_filter_chips()

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
            write_layout(self.layout_path, self.column_width, self.view, self.show_app_pills)
            self.layout_error.set_label("")
        except (OSError, ValueError) as error:
            self.layout_error.set_label(str(error))

    def reset_width(self, *_args):
        self.dragging = True
        self.width_control.set_value(DEFAULT_COLUMN_WIDTH)
        self.dragging = False
        try:
            write_layout(self.layout_path, view=self.view, show_app_pills=self.show_app_pills)
            self.layout_error.set_label("")
        except (OSError, ValueError):
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
        self.hide_numbers()
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
        self.queue_number_keys(scrolled=True)
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

    def after_layout(self):
        self.start_motion()
        self.queue_number_keys()

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
        if (self.numbers_shown or self.number_hold) and self.numbers_blocked():
            self.hide_numbers()

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
        if not self.wide_controls:
            self.search_popover.popdown()
            self.search_expanded = False
            (self.menu_button if self.tiny_controls else self.search_button).grab_focus()

    def open_search(self, *_args):
        self.search_expanded = True
        if not self.wide_controls:
            self.search_popover.popup()
        self.search.grab_focus()

    def open_search_from_preferences(self, *_args):
        self.preferences_window.set_visible(False)
        self.present()
        self.open_search()

    def popover_visibility(self, widget, name):
        # The hook runs for every widget that maps; only the popovers of this window count.
        if isinstance(widget, Gtk.Popover) and widget is not self.search_popover and widget.get_root() is self:
            if name == "map":
                self.open_popovers.add(widget)
                self.hide_numbers()
            else:
                self.open_popovers.discard(widget)
        return True

    def numbers_blocked(self):
        # The narrow search popover is part of the board; the row panel and every other popup block the numbers.
        if not self.is_active() or (self.context_menu and self.context_menu.get_visible()) \
                or any(popover.get_mapped() for popover in self.open_popovers):
            return True
        focus = self.get_focus()
        popover = focus.get_ancestor(Gtk.Popover) if focus else None
        return popover is not None and popover is not self.search_popover

    def number_key_pressed(self, key, modifiers):
        """Hold Ctrl alone to show the numbers; Ctrl+1 to Ctrl+9 open a card. None keeps the usual key handling."""
        held = modifiers & (SHORTCUT_MASK | Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.HYPER_MASK)
        if key in (Gdk.KEY_Control_L, Gdk.KEY_Control_R):
            # The state is from before the press: key repeat and a hold that a popup interrupted already have Control.
            if not held and not self.number_hold and not self.numbers_blocked():
                self.number_hold = GLib.timeout_add(NUMBER_HOLD_MS, self.show_numbers)
            return False
        number = number_key(key)
        if number and held == Gdk.ModifierType.CONTROL_MASK and not self.numbers_blocked():
            self.open_number(number)
            return True
        if held & Gdk.ModifierType.CONTROL_MASK:
            self.hide_numbers()
        return None

    def window_key_released(self, _controller, key, _code, _modifiers):
        if key in (Gdk.KEY_Control_L, Gdk.KEY_Control_R):
            self.hide_numbers()

    def active_changed(self, *_args):
        if not self.is_active():
            self.hide_numbers()

    def show_numbers(self):
        self.number_hold = None
        if not self.closed and not self.numbers_blocked():
            self.update_number_keys()
            self.numbers_shown = True
            self.list_body.add_css_class("asb-numbers-shown")
        return False

    def hide_numbers(self, *_args):
        if self.number_hold:
            GLib.source_remove(self.number_hold)
            self.number_hold = None
        if self.numbers_shown:
            self.numbers_shown = False
            self.list_body.remove_css_class("asb-numbers-shown")
        if self.number_pressed:
            self.number_pressed.remove_css_class("asb-number-pressed")
            self.number_pressed = None

    def open_number(self, number):
        # The current geometry decides, and the shown numbers follow it, so the key opens the card that shows its number.
        self.update_number_keys()
        if number <= len(self.number_keys):
            widget = self.focus_widgets[self.number_keys[number - 1]]
            if self.number_pressed:
                self.number_pressed.remove_css_class("asb-number-pressed")
            self.number_pressed = widget.asb_number_label
            self.number_pressed.add_css_class("asb-number-pressed")
            self.open_row(None, widget)

    def queue_number_keys(self, scrolled=False):
        if self.closed:
            return
        if scrolled:
            # A wheel spring changes the position on each frame; number the cards once it settles.
            if self.number_scroll:
                GLib.source_remove(self.number_scroll)
            self.number_scroll = GLib.timeout_add(100, self.number_keys_due, "number_scroll")
        elif not self.number_idle:
            self.number_idle = GLib.idle_add(self.number_keys_due, "number_idle")

    def number_keys_due(self, source):
        setattr(self, source, None)
        self.update_number_keys()
        return False

    def update_number_keys(self):
        if self.closed:
            return
        viewport = self.scroll.get_child()
        bounds = {}
        for identity, widget in self.focus_widgets.items():
            found, box = widget.compute_bounds(viewport)
            if found:
                bounds[identity] = (box.origin.x, box.origin.y, box.size.width, box.size.height)
        keys = number_key_rows([widget.asb_thread for widget in self.focus_widgets.values()], bounds,
                               (viewport.get_width(), viewport.get_height()))
        for identity in set(self.number_keys) - set(keys):
            widget = self.row_cache.get(identity)
            if widget:
                self.set_row_number(widget, 0)
        for index, identity in enumerate(keys):
            if getattr(self.focus_widgets[identity], "asb_number", 0) != index + 1:
                self.set_row_number(self.focus_widgets[identity], index + 1)
        self.number_keys = keys

    def set_row_number(self, widget, number):
        widget.asb_number = number
        widget.asb_number_label.set_label(str(number) if number else "")
        widget.asb_number_label.set_visible(bool(number))
        if number:
            widget.update_property([Gtk.AccessibleProperty.KEY_SHORTCUTS], [f"Control+{number}"])
        else:
            widget.reset_property(Gtk.AccessibleProperty.KEY_SHORTCUTS)

    def window_key(self, _controller, key, _code, modifiers):
        handled = self.number_key_pressed(key, modifiers)
        if handled is not None:
            return handled
        if modifiers & SHORTCUT_MASK or (self.context_menu and self.context_menu.get_visible()):
            return False
        focus = self.get_focus()
        if focus and focus.get_ancestor(Gtk.Popover):
            return False
        if key == Gdk.KEY_Escape:
            if self.search.get_text() or (not self.wide_controls and self.search_expanded):
                self.clear_search()
                return True
            return False
        if isinstance(focus, (Gtk.Editable, Gtk.TextView)) \
                or key in (Gdk.KEY_space, Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            return False
        codepoint = Gdk.keyval_to_unicode(key)
        if codepoint and chr(codepoint).isprintable():
            self.open_search()
            self.search.set_text(self.search.get_text() + chr(codepoint))
            self.search.set_position(-1)
            return True
        return False

    def visible_rows(self):
        return filtered_rows(self.dashboard, self.search.get_text(), app_filter(self.apps), self.states, self.archive.get_active(),
                             self.pending_only.get_active(), self.drawer_view)

    def filter_changed(self, *_args):
        self.sync_filter_chips()
        self.cancel_scroll()
        self.list_body.clear_hover()
        self.render()

    def sync_filter_chips(self):
        if not getattr(self, "filter_chip_group", None):
            return
        chips = filter_chips(self.apps, self.states, self.archive.get_active(), self.show_app_pills)
        if chips == self.filter_chip_signature:
            return
        self.filter_chip_signature = chips
        current = {key: (title, detail) for key, title, detail in chips}
        for key, (chip, name) in self.filter_chip_widgets.items():
            chip.set_visible(key in current)
            if key in current:
                title, detail = current[key]
                name.set_label(title)
                chip.set_tooltip_text(detail)
                chip.update_property([Gtk.AccessibleProperty.LABEL], [detail])
        self.filter_chip_group.set_visible(bool(chips))

    def clear_filter_chip(self, _button, key):
        focus = self.get_focus()
        chip = self.filter_chip_widgets[key][0]
        restore_focus = bool(focus and (focus is chip or focus.is_ancestor(chip)))
        if key == "app":
            self.select_apps(set())
        elif key == "states":
            self.select_states(set(STATES))
        elif key == "archive":
            self.archive.set_active(False)
        if restore_focus:
            next((button for button, _label in self.filter_chip_widgets.values() if button.get_visible()), self.menu_button).grab_focus()

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
        self.app_filter.set_selected(app_choice(self.apps))
        self.syncing_apps = False
        self.filter_changed()

    def apps_from_preferences(self, *_args):
        if not self.syncing_apps:
            self.select_apps(APP_CHOICES[self.app_filter.get_selected()][1])

    def apps_from_pills(self, *_args):
        if not self.syncing_apps:
            self.select_apps({provider for provider, pill in self.app_pills.items() if pill.get_active()})

    def states_changed(self, *_args):
        if self.updating_states:
            return
        self.states = {state for state, check in self.state_checks.items() if check.get_active()}
        title = "All states" if len(self.states) == len(STATES) else f"{len(self.states)} states"
        self.state_summary.set_label(title)
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

    def render(self, *args, **kwargs):
        # Card moves map and unmap thousands of widgets, and the popover hook runs in Python for each one.
        # No popover opens inside a render, and the row panel has its own check in numbers_blocked.
        hooks, self.popover_hooks = getattr(self, "popover_hooks", []), []
        for name, hook in hooks:
            GObject.remove_emission_hook(Gtk.Popover, name, hook)
        try:
            return self.render_board(*args, **kwargs)
        finally:
            if hooks and not self.closed:
                self.popover_hooks = [(name, GObject.add_emission_hook(Gtk.Popover, name, self.popover_visibility, name))
                                      for name in ("map", "unmap")]

    def render_board(self, preserve_focus=None, reveal_focus=False, preserve_action=None):
        if self.dashboard is None or self.closed:
            return
        focused = preserve_focus or self.focus_key()
        focus_widget = self.get_focus()
        focused_action = preserve_action or getattr(focus_widget, "asb_card_action", None)
        panel_focus = focus_widget if getattr(self, "context_menu", None) and focus_widget and focus_widget.is_ancestor(self.context_menu) else None
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
                    self.clear_message_light(widget)
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
            # Each column moves only the cards outside its longest run in target order; all removals come before the inserts.
            moves = []
            for number, listing in enumerate(listings):
                current, card = [], listing.get_row_at_index(0)
                while card is not None:
                    current.append(card)
                    card = listing.get_row_at_index(len(current))
                target = [self.focus_widgets[row["id"]] for row in parts[number]] if number < len(parts) else []
                moves.append((listing, *column_moves(current, target)))
            focus_row = self.focus_widgets.get(self.focus_key())
            refocus = focus_widget is not None and any(focus_row in removals for _listing, removals, _inserts in moves)
            for listing, removals, _inserts in moves:
                for widget in removals:
                    listing.remove(widget)
            for listing, _removals, inserts in moves:
                for index, widget in inserts:
                    listing.insert(widget, index)
            # GTK 4 keeps the window focus on a removed row until the next frame, then moves it to the first row of a column;
            # that frame can come before the queued restore, so a repack also sets the focus again now.
            if refocus and focus_widget.get_visible() and focus_widget.get_sensitive():
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
        if drawer != self.drawer_count:
            self.drawer_count = drawer
            self.drawer_dot.set_visible(bool(drawer))
            (self.drawer_only.add_css_class if drawer else self.drawer_only.remove_css_class)("asb-drawer-filled")
            description = "The drawer has sessions." if drawer else "The drawer is empty."
            self.drawer_only.update_property([Gtk.AccessibleProperty.LABEL], ["Drawer only. " + description])
        if repack or reveal_focus or preserve_action:
            GLib.idle_add(self.restore_position, focused, position, reveal_focus, focused_action, self.focus_generation, panel_focus)
        self.queue_number_keys()
        # After the queued restore, so that a panel control that gets its focus back does not cancel the scroll restore.
        self.sync_row_panel()

    def restore_position(self, focused, position, reveal_focus=False, focused_action=None, focus_generation=None, panel_focus=None):
        if not self.closed and (focus_generation is None or focus_generation == self.focus_generation):
            self.cancel_scroll()
            panel = self.context_menu
            if panel_focus and panel and panel.get_mapped() and panel_focus.is_ancestor(panel) \
                    and panel_focus.get_visible() and panel_focus.get_sensitive():
                # The repack moved the row with its open panel; the focus goes back to the panel control.
                self.set_focus(panel_focus)
            elif focused in self.focus_widgets:
                row = self.focus_widgets[focused]
                control = getattr(row, "asb_" + str(focused_action) + "_button", None)
                self.set_focus(control if control and control.get_visible() and control.get_sensitive() else row)
            adjustment = self.scroll.get_hadjustment()
            adjustment.set_value(min(position, max(0, adjustment.get_upper() - adjustment.get_page_size())))
            if reveal_focus and focused in self.focus_widgets:
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

    def sync_unread_setting(self, value):
        if self.unread_setting_loading:
            return
        self.syncing_unread_setting = True
        self.persistent_unread.set_active(value if type(value) is bool else True)
        self.syncing_unread_setting = False

    def quit_engine(self, *_args):
        self.quit_engine_button.set_sensitive(False)
        self.quit_engine_error.set_label("")
        def finished(_result, error):
            if self.closed:
                return False
            if error:
                self.quit_engine_button.set_sensitive(True)
                self.quit_engine_error.set_label(error)
            else:
                self.close()
            return False
        request_async(self.base, "/api/engine/stop", finished, GLib.idle_add, "POST", {})

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
                    self.sync_unread_setting((self.dashboard or {}).get("persistentUnread", True))
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
        widget.asb_copy_timer = None
        widget.asb_light_timer, widget.asb_light_generation = None, 0
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
        self.cancel_card_copy(widget)
        self.clear_message_light(widget)
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
        mark = Gtk.Image(icon_name=provider_icon(row.get("provider")), pixel_size=14, valign=Gtk.Align.START)
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
        if model["limit"] or model["note"] or model["flags"] or model["error"]:
            notes = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, margin_start=21)
            notes.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL, margin_top=4, margin_bottom=4))
            if model["limit"]:
                notes.append(text(model["limit"], "asb-tooltip-note"))
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
            self.cancel_card_copy(widget)
            for name in ("asb_folder", "asb_pin_button", "asb_read_button", "asb_drawer_button", "asb_copy_button", "asb_age_label", "asb_limited",
                         "asb_mute_glyph", "asb_where_icon", "asb_where_label"):
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
            # The Ctrl-number keycap covers the provider mark and its Soft dot, with no layout change.
            number = getattr(widget, "asb_number", 0)
            number_label = label(str(number) if number else "", "asb-number")
            number_label.set_xalign(.5)
            number_label.set_halign(Gtk.Align.CENTER)
            number_label.set_valign(Gtk.Align.CENTER)
            number_label.set_can_target(False)
            number_label.set_visible(bool(number))
            mark_overlay.add_overlay(number_label)
            mark_overlay.set_measure_overlay(number_label, False)
            widget.asb_number_label = number_label
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
            clock = Gtk.Image(icon_name="preferences-system-time-symbolic", pixel_size=12, visible=False)
            clock.add_css_class("asb-limit-clock")
            widget.asb_limit_clock = clock
            mute = Gtk.Image(icon_name="notifications-disabled-symbolic", pixel_size=12, visible=False, valign=Gtk.Align.CENTER)
            mute.add_css_class("asb-mute-glyph")
            mute.add_css_class("dim-label")
            widget.asb_mute_glyph = mute
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
                # The folder does not expand, so it ellipsizes before the mute icon, which stays right after the name.
                folder.set_hexpand(False)
                widget.asb_folder = folder
                workspace.append(folder)
                workspace.append(mute)
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
                metadata.append(clock)
                metadata.append(state)
                age = label("", "caption")
                age.add_css_class("asb-age")
                age.add_css_class("dim-label")
                age.set_ellipsize(Pango.EllipsizeMode.END)
                age.set_halign(Gtk.Align.END)
                widget.asb_age_label = age
                # Where a view-only session runs, before the age; the machine name ellipsizes first.
                right = Gtk.Box(spacing=4, hexpand=True, halign=Gtk.Align.END)
                where_icon = Gtk.Image(pixel_size=11, visible=False)
                where_icon.add_css_class("asb-where-icon")
                where_icon.add_css_class("dim-label")
                where = label("", "caption")
                where.add_css_class("asb-where")
                where.add_css_class("dim-label")
                where.set_ellipsize(Pango.EllipsizeMode.END)
                where.set_max_width_chars(12)
                where.set_visible(False)
                right.append(where_icon)
                right.append(where)
                right.append(age)
                widget.asb_where_icon, widget.asb_where_label = where_icon, where
                metadata.append(right)
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
                copy = Gtk.Button(child=Gtk.Image(icon_name="edit-copy-symbolic", pixel_size=12))
                for button, name in ((copy, "copy"), (drawer, "drawer"), (read, "read"), (pin, "pin")):
                    button.add_css_class("flat")
                    button.add_css_class("asb-card-action")
                    button.add_css_class("asb-" + name + "-button")
                    button.asb_card_action = name
                    button.set_action_target_value(GLib.Variant("s", row["id"]))
                widget.asb_drawer_button, widget.asb_read_button, widget.asb_pin_button = drawer, read, pin
                widget.asb_copy_button = copy
                actions.append(copy)
                actions.append(drawer)
                read_slot.append(read)
                actions.append(read_slot)
                actions.append(pin)
                overlay.add_overlay(actions)
                overlay.set_measure_overlay(actions, False)
                content = overlay
            else:
                where = label("", "caption")
                where.add_css_class("asb-where")
                where.add_css_class("dim-label")
                where.set_ellipsize(Pango.EllipsizeMode.END)
                where.set_max_width_chars(10)
                where.set_visible(False)
                widget.asb_where_icon, widget.asb_where_label = None, where
                for child in (mark_overlay, title, clock, dot, state, where, mute):
                    content.append(child)
            # Tooltips set before the card is rooted cause no tooltip query.
            self.update_card_actions(widget)
            widget.set_child(content)
        widget.asb_mark.set_from_icon_name(provider_icon(row["provider"]))
        widget.asb_source_badge.set_color(source_marker_color(row))
        where_icon, where = row_where(row)
        if widget.asb_where_icon:
            if where_icon:
                widget.asb_where_icon.set_from_icon_name(where_icon)
            widget.asb_where_icon.set_visible(bool(where))
        widget.asb_where_label.set_label((where + " ·" if widget.asb_where_icon else "· " + where) if where else "")
        widget.asb_where_label.set_visible(bool(where))
        tone = view_only_tone(row)
        (widget.add_css_class if tone else widget.remove_css_class)("asb-view-only-quiet")
        (widget.add_css_class if tone == "rest" else widget.remove_css_class)("asb-view-only-rest")
        indicator = attention_indicator(row, True)
        (widget.add_css_class if indicator == "dot" else widget.remove_css_class)("asb-unread")
        (widget.add_css_class if indicator == "dot" and not row.get("unread") else widget.remove_css_class)("asb-drawer")
        discard_offer = self.view == "comfortable" and row.get("state") == "working" and not indicator and not row.get("muted") \
            and not row.get("remote")
        if getattr(widget, "asb_mute_glyph", None):
            widget.asb_mute_glyph.set_visible(bool(row.get("muted")))
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
                     row.get("pinned"), row.get("drawer"), row.get("muted"), row.get("title"), pending, bool(widget.asb_read_timer),
                     self.column_pixel_width >= 190, bool(getattr(widget, "asb_copy_timer", None)))
        if signature == getattr(widget, "asb_action_signature", None):
            return
        widget.asb_action_signature = signature
        unread = indicator in ("question", "dot") and not row.get("actionRequired")
        discard = row.get("state") == "working" and indicator not in ("question", "dot") and not row.get("muted") and not row.get("remote")
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
            drawer.set_action_name(("win.drawer-out" if tucked else "win.drawer-in") if not pending else None)
            controls.append((drawer, "Take out of drawer: show as unread again" if tucked
                             else "Put in drawer: look read here, keep it under Drawer", not pending))
        for button, text, enabled in controls:
            button.set_sensitive(True)
            (button.add_css_class if pending else button.remove_css_class)("asb-action-pending")
            # GTK queries the tooltip again at each set, which is slow for a card under the pointer.
            if button.get_tooltip_text() != text:
                button.set_tooltip_text(text)
            button.update_property([Gtk.AccessibleProperty.LABEL], [text + ": " + row.get("title", "Untitled session")])
            button.update_state([Gtk.AccessibleState.BUSY, Gtk.AccessibleState.DISABLED], [pending, not enabled])
        copy = getattr(widget, "asb_copy_button", None)
        if copy:
            # Copy sends no request, so it has no pending state. The corner fades the title for it at every width that shows it.
            wide, copied = self.column_pixel_width >= 190, bool(widget.asb_copy_timer)
            copy.set_visible(wide)
            (copy.get_parent().add_css_class if wide else copy.get_parent().remove_css_class)("asb-corner-wide")
            copy.set_action_name("win.copy-reference")
            copy.get_child().set_from_icon_name("object-select-symbolic" if copied else "edit-copy-symbolic")
            (copy.add_css_class if copied else copy.remove_css_class)("asb-copy-confirmed")
            if copy.get_tooltip_text() != (tip := "Copied" if copied else "Copy app and session ID"):
                copy.set_tooltip_text(tip)
            copy.update_property([Gtk.AccessibleProperty.LABEL], ["Copy app and session ID: " + row.get("title", "Untitled session")])
            if copied:
                copy.update_property([Gtk.AccessibleProperty.DESCRIPTION], ["Copied"])
            else:
                copy.reset_property(Gtk.AccessibleProperty.DESCRIPTION)

    def copy_reference(self, _action, target):
        identity = target.get_string()
        widget = self.focus_widgets.get(identity)
        if not widget or self.closed:
            return
        # The check of an earlier copy must not stay on after this one fails.
        self.cancel_card_copy(widget)
        try:
            self.get_clipboard().set(session_reference(widget.asb_thread))
        except (GLib.Error, TypeError) as error:
            self.open_errors[identity] = f"Cannot copy the app and session ID: {error}"
            self.update_card_actions(widget)
            self.update_open_state(widget)
            return
        if self.open_errors.get(identity, "").startswith("Cannot copy the app and session ID: "):
            self.open_errors.pop(identity)
            self.update_open_state(widget)
        def clear():
            widget.asb_copy_timer = None
            if not self.closed and self.focus_widgets.get(identity) is widget and widget.asb_view == "comfortable":
                self.update_card_actions(widget)
            return False
        widget.asb_copy_timer = GLib.timeout_add(1600, clear)
        self.update_card_actions(widget)

    def cancel_card_copy(self, widget):
        if getattr(widget, "asb_copy_timer", None):
            GLib.source_remove(widget.asb_copy_timer)
        widget.asb_copy_timer = None

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
        self.sync_row_panel()
        # All rows, not only the shown ones: a filter change can show a countdown before the next tick.
        interval = clock_interval((self.dashboard or {}).get("threads", []), now_ms)
        if interval != self.clock_interval:
            if self.clock_timer:
                GLib.source_remove(self.clock_timer)
            self.clock_interval = interval
            self.clock_timer = GLib.timeout_add_seconds(interval, self.update_clock)
        return True

    def update_row_text(self, widget, now_ms=None):
        row = widget.asb_thread
        duration = working_duration(row, now_ms)
        meta = row_meta(row, now_ms)
        left = limit_left(row, now_ms)
        countdown = limit_text(left) if left else ""
        signature = (duration, meta, countdown)
        if signature == widget.asb_time_signature:
            return
        widget.asb_time_signature = signature
        widget.asb_duration = duration
        state_text = row.get("state", "unknown").capitalize()
        # The row class keeps the grey look across a view change; at the reset the next tick lifts it.
        if bool(countdown) != getattr(widget, "asb_limited", False):
            widget.asb_limited = bool(countdown)
            (widget.add_css_class if countdown else widget.remove_css_class)("asb-limited")
            widget.asb_limit_clock.set_visible(bool(countdown))
        if countdown:
            widget.asb_state_label.set_label("Resets in" if self.view == "comfortable" else "Resets " + countdown)
        else:
            widget.asb_state_label.set_label(state_text + (" ·" + duration if self.view == "compact" and duration else ""))
        if self.view == "comfortable":
            widget.asb_age_label.set_label(countdown or duration or row_meta(row, now_ms).split(" · ")[1])
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
        muted = " Muted." if row.get("muted") else ""
        limit = f" Usage limit. Resets in {spoken_limit(left)}." if left else ""
        where = (f" On {row.get('machineName') or 'another machine'}." if row.get("remote") else "") \
            + (" CLI session." if row.get("surface") == "cli" else "") + (" View only." if is_view_only(row) else "")
        widget.asb_accessible_label = f"{action} {row.get('title', 'Untitled session')} in {row.get('providerLabel', '')}. {state_text}.{limit}{manual}{native_unread}{pinned}{question}{retained}{outcome}{discard}{drawer}{muted}{where}"
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
        self.hide_numbers()
        if self.context_menu:
            self.context_menu.popdown()
        widget.grab_focus()
        row = widget.asb_thread
        panel = Gtk.Popover(has_arrow=False)
        panel.add_css_class("asb-row-panel")
        panel.asb_identity, panel.asb_signature = row["id"], None
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, width_request=276)
        header = Gtk.Grid(column_spacing=7, row_spacing=3, margin_start=2, margin_end=2, margin_bottom=12)
        panel.asb_icon = Gtk.Image(pixel_size=14)
        panel.asb_icon.add_css_class("asb-provider")
        header.attach(panel.asb_icon, 0, 0, 1, 1)
        panel.asb_folder = label("", "asb-panel-folder")
        panel.asb_folder.add_css_class("dim-label")
        panel.asb_folder.set_ellipsize(Pango.EllipsizeMode.START)
        # A small natural width keeps a long path or title from widening the panel; the labels fill the panel width.
        panel.asb_folder.set_max_width_chars(1)
        panel.asb_folder.set_hexpand(True)
        header.attach(panel.asb_folder, 1, 0, 1, 1)
        panel.asb_title = label("", "asb-panel-title")
        panel.asb_title.set_wrap(True)
        panel.asb_title.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
        panel.asb_title.set_lines(2)
        panel.asb_title.set_ellipsize(Pango.EllipsizeMode.END)
        panel.asb_title.set_max_width_chars(1)
        header.attach(panel.asb_title, 0, 1, 2, 1)
        panel.asb_state = label("", "asb-panel-state")
        header.attach(panel.asb_state, 0, 2, 2, 1)
        root.append(header)
        panel.asb_open = Gtk.Button(margin_bottom=12)
        panel.asb_open.add_css_class("asb-panel-open")
        panel.asb_open.connect("clicked", self.panel_open)
        root.append(panel.asb_open)
        controls = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        controls.add_css_class("boxed-list")
        panel.asb_switches = {}
        for key, title in (("unread", "Unread"), ("drawer", "In the drawer"), ("muted", "Muted"), ("pinned", "Pinned"), ("order", None),
                           ("discard", "Discard result")):
            if key == "order":
                control = Adw.ActionRow(title="Pin order", activatable=False, focusable=False)
                buttons = Gtk.Box(valign=Gtk.Align.CENTER)
                buttons.add_css_class("linked")
                for direction, text in (("up", "Earlier"), ("down", "Later")):
                    name = "Move pin " + text.lower()
                    button = Gtk.Button(label=text, tooltip_text=name)
                    button.add_css_class("asb-panel-move")
                    button.update_property([Gtk.AccessibleProperty.LABEL], [name])
                    button.connect("clicked", self.panel_move_pin, direction)
                    setattr(panel, "asb_" + direction, button)
                    buttons.append(button)
                control.add_suffix(buttons)
            else:
                control = Adw.SwitchRow(title=title)
                if key == "discard":
                    control.set_subtitle("Go to read Idle when this task ends")
                elif key == "muted":
                    control.set_subtitle("Finished tasks stay read. Questions still alert.")
                control.connect("notify::active", self.panel_toggle, key)
            panel.asb_switches[key] = control
            controls.append(control)
        panel.asb_copy_row = Adw.ActionRow(title="App and session ID", focusable=False)
        panel.asb_copy_row.set_subtitle_lines(1)
        def subtitle_label(widget):
            # Adw.ActionRow keeps its subtitle label inside; the ID keeps both ends visible.
            child = widget.get_first_child()
            while child:
                if isinstance(child, Gtk.Label) and child.has_css_class("subtitle"):
                    return child
                found = subtitle_label(child)
                if found:
                    return found
                child = child.get_next_sibling()
            return None
        subtitle = subtitle_label(panel.asb_copy_row)
        if subtitle:
            subtitle.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        panel.asb_copy = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Copy app and session ID", valign=Gtk.Align.CENTER)
        panel.asb_copy.add_css_class("flat")
        panel.asb_copy.add_css_class("circular")
        panel.asb_copy.update_property([Gtk.AccessibleProperty.LABEL], ["Copy app and session ID"])
        panel.asb_copy.connect("clicked", self.panel_copy)
        panel.asb_copy_row.add_suffix(panel.asb_copy)
        # The row and its button run one copy: a click on the row activates the button.
        panel.asb_copy_row.set_activatable_widget(panel.asb_copy)
        panel.asb_copy_timer, panel.asb_copy_error, panel.asb_reference = None, "", None
        controls.append(panel.asb_copy_row)
        root.append(controls)
        # The card tooltip shows a failed action, but the panel covers the card.
        panel.asb_error = label("", "asb-panel-error")
        panel.asb_error.add_css_class("error")
        panel.asb_error.set_wrap(True)
        panel.asb_error.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
        panel.asb_error.set_max_width_chars(1)
        panel.asb_error.set_margin_top(8)
        root.append(panel.asb_error)
        # The clamp keeps a long subtitle or label from widening the panel past about 300px.
        panel.set_child(Adw.Clamp(maximum_size=276, tightening_threshold=276, child=root))
        keys = Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        keys.connect("key-pressed", self.panel_key)
        panel.add_controller(keys)
        panel.set_parent(widget)
        def closed(popup):
            # A repack moves the row, which unmaps its panel; GTK maps the panel again with the row.
            if popup.get_visible() and not self.closed:
                return
            self.clear_copy_feedback(popup)
            GLib.idle_add(popup.unparent)
            if self.context_menu is popup:
                self.context_menu = None
                card = self.focus_widgets.get(popup.asb_identity)
                focus = self.get_focus()
                if card and not self.closed and card.get_mapped() and (focus is None or focus.is_ancestor(popup)):
                    card.grab_focus()
        panel.connect("closed", closed)
        self.context_menu = panel
        self.update_row_panel(panel, row)
        self.place_row_panel(panel, widget, x, y)
        panel.popup()
        if gesture:
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def place_row_panel(self, panel, widget, x, y):
        """GTK keeps a popover inside the monitor only; this keeps the centered panel inside the window."""
        if x is None:
            x, y = widget.get_width() / 2, widget.get_height() / 2
        ok, point = widget.compute_point(self, Graphene.Point().init(x, y))
        if not ok:
            return
        # A popover measures 0 before it maps; its child plus the 12px padding and the 1px ring on each side is the size.
        child = panel.get_child()
        width = child.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
        height = child.measure(Gtk.Orientation.VERTICAL, width)[1] + 26
        width += 26
        px, py, side = panel_place(point.x, point.y, width, height, self.get_width(), self.get_height())
        ok, local = self.compute_point(widget, Graphene.Point().init(px, py))
        rectangle = Gdk.Rectangle()
        rectangle.x, rectangle.y, rectangle.width, rectangle.height = round(local.x), round(local.y), 1, 1
        panel.set_pointing_to(rectangle)
        panel.set_position(Gtk.PositionType.TOP if side == "top" else Gtk.PositionType.BOTTOM)

    def update_row_panel(self, panel, row):
        """Show the row data in the open panel; an unchanged row keeps every widget as it is."""
        pending = row["id"] in self.session_actions
        controls = row_panel_controls(row)
        model = tooltip_model(row, time.time() * 1000, Path.home(), "", self.drawer_view)
        unread = controls["unread"][0] and model["state"] not in ("working", "waiting")
        reference = session_reference(row)
        signature = (model["title"], model["path"], model["state_text"], model["state"], unread, model["app"], row.get("provider"),
                     bool(row.get("canOpen")), tuple(controls.items()), row_panel_note(row), pending, self.open_errors.get(row["id"], ""),
                     reference, panel.asb_copy_error, row_where(row))
        if signature == panel.asb_signature:
            return
        panel.asb_signature = signature
        if reference != panel.asb_reference:
            # A new ID ends the feedback of a copy of the old one.
            self.clear_copy_feedback(panel)
            panel.asb_reference = reference
            panel.asb_copy_row.set_subtitle(reference)
            panel.asb_copy_row.set_tooltip_text(reference)
        focus = self.get_focus()
        if pending and focus and focus.is_ancestor(panel):
            # An insensitive control loses the focus; it gets it back when the action ends.
            panel.asb_return_focus = focus
        panel.update_property([Gtk.AccessibleProperty.LABEL], [model["title"]])
        panel.asb_icon.set_from_icon_name(provider_icon(row.get("provider")))
        panel.asb_folder.set_label(model["path"])
        panel.asb_title.set_label(" ".join(model["title"].split()))
        panel.asb_state.set_label(model["state_text"])
        for css in (*("asb-" + value for value in STATES), "success", "warning", "dim-label", "asb-panel-unread"):
            panel.asb_state.remove_css_class(css)
        panel.asb_state.add_css_class("asb-" + model["state"])
        panel.asb_state.add_css_class("success" if model["state"] == "working" else "warning" if model["state"] == "waiting"
                                      else "asb-panel-unread" if unread else "dim-label")
        error = self.open_errors.get(row["id"], "") or panel.asb_copy_error
        panel.asb_error.set_label(error)
        panel.asb_error.set_visible(bool(error))
        if is_view_only(row):
            panel.asb_open.set_label(f"On {row_where(row)[1]}" if row.get("remote") else "Runs in a terminal")
            panel.asb_open.set_sensitive(False)
        else:
            panel.asb_open.set_label("Open in " + model["app"])
            panel.asb_open.set_sensitive(bool(row.get("canOpen")) and not pending and row["id"] not in self.opening)
        panel.asb_updating = True
        for key, control in panel.asb_switches.items():
            control.set_visible(key in controls)
            on, action = controls.get(key, (False, None))
            if key == "order":
                panel.asb_up.set_sensitive(not pending)
                panel.asb_down.set_sensitive(not pending)
                continue
            # While an action runs, the switch keeps the state that the user chose.
            if not pending:
                control.set_active(on)
            control.set_sensitive(bool(action) and not pending)
        panel.asb_switches["unread"].set_subtitle(row_panel_note(row))
        panel.asb_updating = False
        if not pending and getattr(panel, "asb_return_focus", None):
            GLib.idle_add(self.restore_panel_focus, panel, panel.asb_return_focus)
            panel.asb_return_focus = None

    def restore_panel_focus(self, panel, control):
        focus = self.get_focus()
        if self.context_menu is panel and control.is_ancestor(panel) and control.get_mapped() and control.get_sensitive() \
                and (focus is None or not focus.is_ancestor(panel)):
            self.set_focus(control)
        return False

    def sync_row_panel(self):
        panel = getattr(self, "context_menu", None)
        if not panel or self.closed:
            return
        widget = self.focus_widgets.get(panel.asb_identity)
        if widget is None or widget is not panel.get_parent():
            panel.popdown()
        else:
            self.update_row_panel(panel, widget.asb_thread)

    def panel_toggle(self, control, _param, key):
        # The panel comes from the widget: a panel in the handler data makes a cycle that Python cannot free.
        panel = control.get_ancestor(Gtk.Popover)
        if getattr(panel, "asb_updating", False):
            return
        widget = self.focus_widgets.get(panel.asb_identity)
        on, action = row_panel_controls(widget.asb_thread).get(key, (False, None)) if widget else (False, None)
        if action and control.get_active() != on:
            self.activate_action("win." + action, GLib.Variant("s", panel.asb_identity))
        # An action that sent nothing puts the switch back.
        if self.context_menu is panel and panel.asb_identity not in self.session_actions:
            panel.asb_signature = None
            self.sync_row_panel()

    def panel_copy(self, button):
        panel = button.get_ancestor(Gtk.Popover)
        widget = self.focus_widgets.get(panel.asb_identity)
        if not widget or self.closed:
            return
        self.clear_copy_feedback(panel)
        try:
            self.get_clipboard().set(session_reference(widget.asb_thread))
        except (GLib.Error, TypeError) as error:
            panel.asb_copy_error = f"Cannot copy the app and session ID: {error}"
        else:
            panel.asb_copy_error = ""
            panel.asb_copy.set_icon_name("object-select-symbolic")
            panel.asb_copy.set_tooltip_text("Copied")
            panel.asb_copy_row.update_property([Gtk.AccessibleProperty.DESCRIPTION], ["Copied"])
            def clear():
                panel.asb_copy_timer = None
                self.clear_copy_feedback(panel)
                return False
            panel.asb_copy_timer = GLib.timeout_add(1600, clear)
        self.update_row_panel(panel, widget.asb_thread)

    def clear_copy_feedback(self, panel):
        if panel.asb_copy_timer:
            GLib.source_remove(panel.asb_copy_timer)
            panel.asb_copy_timer = None
        panel.asb_copy.set_icon_name("edit-copy-symbolic")
        panel.asb_copy.set_tooltip_text("Copy app and session ID")
        panel.asb_copy_row.reset_property(Gtk.AccessibleProperty.DESCRIPTION)

    def panel_move_pin(self, button, direction):
        panel = button.get_ancestor(Gtk.Popover)
        self.activate_action("win.pin-" + direction, GLib.Variant("s", panel.asb_identity))

    def panel_open(self, button):
        panel = button.get_ancestor(Gtk.Popover)
        widget = self.focus_widgets.get(panel.asb_identity)
        panel.popdown()
        if widget:
            self.open_row(None, widget)

    def panel_key(self, controller, key, _code, state):
        panel = controller.get_widget()
        if key in (Gdk.KEY_Up, Gdk.KEY_Down) and not state & SHORTCUT_MASK:
            direction = Gtk.DirectionType.TAB_FORWARD if key == Gdk.KEY_Down else Gtk.DirectionType.TAB_BACKWARD
            if not panel.child_focus(direction):
                # At the last control, start again at the first one.
                panel.get_child().set_focus_child(None)
                panel.child_focus(direction)
            return True
        return False

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
        self.sync_row_panel()
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
                self.sync_row_panel()
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
        if getattr(self, "search_popover", None):
            self.search_popover.unparent()
        if getattr(self, "preferences_window", None):
            self.preferences_window.dispose()
        self.cancel_scroll()
        self.cancel_motion()
        self.hide_numbers()
        if self.context_menu:
            self.clear_copy_feedback(self.context_menu)
        for source in (self.number_idle, self.number_scroll):
            if source:
                GLib.source_remove(source)
        self.number_idle = self.number_scroll = None
        for name, hook in getattr(self, "popover_hooks", ()):
            GObject.remove_emission_hook(Gtk.Popover, name, hook)
        self.popover_hooks, self.open_popovers = [], set()
        self.list_body.clear_hover()
        self.list_body.clear_flights()
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
        Gtk.StyleContext.remove_provider_for_display(self.get_display(), self.badge_css)
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
