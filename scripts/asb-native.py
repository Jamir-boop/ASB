#!/usr/bin/env python3
"""Native GNOME view for the local ASB session API."""
from datetime import datetime, timedelta
import json
import math
import ntpath
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
# Cards on the board (Preferences > Sessions); 0 shows all cards.
CARD_LIMITS = ((50, "50"), (100, "100"), (200, "200"), (500, "500"), (0, "All"))
DEFAULT_CARD_LIMIT = 100
# shortcut: a row ID "asb:more" (a source ID "asb" that a person typed into the source settings, with a thread "more") would show as the More card; app-made source IDs are "codex-<uuid>" or "claude-<uuid>", so change this ID only if a source can make it.
MORE_ID = "asb:more"
NUMBER_HOLD_MS = 400
APP_ID = "local.asb.AgentSwitchBoard"
STATES = ("working", "waiting", "idle", "unknown")
SOURCE_PROVIDERS = ("codex", "claude-desktop-code")
APP_NAMES = {"codex": "Codex", "claude-desktop-code": "Claude Desktop Code", "opencode": "OpenCode"}
# How Claude in a profile reaches Claude sessions on other machines (`remoteClaude`, plan 9.6).
REMOTE_CLAUDE = (("auto", "Automatic", "Claude in this profile reaches Claude sessions on other machines through ASB, unless both machines use Claude Remote Control."),
                 ("bridge", "Through ASB", "Claude in this profile always reaches Claude sessions on other machines through ASB."),
                 ("native", "Claude Remote Control only", "ASB does not add Claude sessions of other machines to this profile. Codex tasks of other machines stay."))
SOURCE_COLOR_PRESETS = (("Slate blue", "#8296b4"), ("Clay", "#b28f80"), ("Plum", "#a28caa"), ("Sage", "#899e91"))


BRIDGE_STATES = {
    "ready": ("Ready", "object-select-symbolic", "success"),
    "update": ("Old version", "software-update-available-symbolic", "warning"),
    "hooks": ("Hooks not trusted", "dialog-warning-symbolic", "warning"),
    "off": ("Turned off in Codex", "dialog-warning-symbolic", "warning"),
    "nobun": ("Codex cannot find Bun", "dialog-error-symbolic", "error"),
    "missing": ("Not installed", "action-unavailable-symbolic", "dim-label"),
    "conflict": ("Needs a manual fix", "dialog-error-symbolic", "error"),
    "old-app": ("OpenCode is too old", "dialog-warning-symbolic", "warning"),
    "unknown": ("Unknown", "dialog-question-symbolic", "dim-label"),
}
BRIDGE_NONE_BODY = "Install it to let your agents send messages to each other. The board works without it."
BRIDGE_INSTALL_FAILED = "The install did not work. Output:"
MACHINE_BRIDGE_PHRASES = {"ready": "ready", "update": "old version", "hooks": "hooks not trusted", "off": "turned off",
    "nobun": "cannot find Bun", "missing": "not installed", "conflict": "needs a manual fix", "old-app": "app too old",
    "unknown": "unknown"}
PROFILE_CONFLICT = "This profile changed outside this dialog. Your edits are kept. Select Cancel, open the profile again, then edit and save."


def bridge_state_line(app):
    state = app.get("state")
    text = BRIDGE_STATES.get(state, BRIDGE_STATES["unknown"])[0]
    version, live = app.get("version"), app.get("live")
    if state in ("ready", "update") and isinstance(version, str) and version:
        text += " · " + version
    if type(live) is int and live > 0:
        text += f" · {live} live"
    return text


def bridge_detail(app):
    update = {"codex": "Update, then restart Codex.", "opencode": "Update, then restart OpenCode.",
              "claude-desktop-code": "Update. New Claude sessions use it."}
    return {"ready": None, "update": update.get(app.get("provider")),
        "hooks": "In Codex, open Plugins > ASB Bridge, trust both hooks, and restart Codex.",
        "off": "In Codex, open Plugins > ASB Bridge and turn it on.",
        "nobun": "Codex cannot start or resume tasks. Make Bun visible to desktop apps, then restart Codex.",
        "missing": BRIDGE_NONE_BODY, "conflict": "Run asb bridge status in a terminal to see what is in the way.",
        "old-app": "ASB Bridge needs OpenCode 2.1.2 or later. Update OpenCode."}.get(
            app.get("state"), "ASB cannot find the Claude folder of this profile.")


def bridge_action(app):
    return {"missing": "Install", "update": "Update"}.get(app.get("state")) if app.get("canInstall") is True else None


def bridge_valid(data):
    return (isinstance(data, dict) and type(data.get("api")) is int and data["api"] == 1
        and isinstance(data.get("machines"), list) and all(isinstance(machine, dict)
            and isinstance(machine.get("name"), str) and type(machine.get("isSelf")) is bool
            and isinstance(machine.get("state"), str) and isinstance(machine.get("apps"), list)
            and all(isinstance(app, dict) and all(isinstance(app.get(key), str) for key in ("sourceId", "label", "state"))
                    for app in machine["apps"]) for machine in data["machines"]))


def bridge_self_apps(data):
    return next(({app["sourceId"]: app for app in machine["apps"]}
                 for machine in data["machines"] if machine["isSelf"]), {})


def machine_bridge_line(machine):
    state, apps, live = machine.get("state"), machine.get("apps", []), machine.get("live")
    if state == "offline":
        return "Bridge: not checked while offline"
    if state == "old":
        return "Bridge: unknown, needs ASB 1.12+" + (f" · {live} live" if type(live) is int and live > 0 else "")
    if state == "error":
        error = machine.get("error")
        return "Bridge: " + (error if isinstance(error, str) and error else "ASB cannot check it.")
    if not apps:
        return "Bridge: checking…" if state == "checking" or machine.get("checking") is True else "Bridge: no app profiles"
    if all(app["state"] == "missing" for app in apps):
        return "Bridge: not installed"
    return "Bridge: " + " · ".join(f"{app['label']} {MACHINE_BRIDGE_PHRASES.get(app['state'], 'unknown')}" for app in apps)


def profile_subtitle(source):
    app = APP_NAMES.get(source["provider"], source["provider"])
    count = source.get("sessionCount", 0)
    status = "Off" if not source["enabled"] else (f"{count} chat" + ("" if count == 1 else "s")) \
        if source.get("status") in ("ready", "ok") else source.get("status", "unknown").capitalize()
    return f"{app} · {status}"


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


def source_form_body(provider, name, data_dir, launcher, enabled, identity="", projects_dir="", color=None, show_marker=None,
                     remote_claude=None):
    # Only the default OpenCode source exists; new sources stay Codex or Claude.
    if provider not in SOURCE_PROVIDERS and not (provider == "opencode" and identity == "opencode") or type(enabled) is not bool:
        raise ValueError("Choose an app and its Enabled setting.")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or re.search(r"[\x00-\x1f\x7f]", name):
        raise ValueError("Name must have 1–80 characters with no control characters.")
    if identity and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", identity):
        raise ValueError("The profile ID is not valid. Refresh the list.")
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
    # A required action keeps its "?" mark after Read, so its own attention decides between Read and Unread.
    unread = row.get("actionAttention") or row.get("unread") if row.get("actionRequired") \
        else attention_indicator(row) in ("question", "alert", "dot")
    actions = [("Read", "mark-read") if row.get("drawer") or unread else ("Unread", "mark-unread")]
    if row.get("drawer"):
        actions.append(("Take out of drawer", "drawer-out"))
    elif attention_indicator(row) in ("dot", "alert"):
        actions.append(("Put in drawer", "drawer-in"))
    actions.append(("Unmute", "unmute") if row.get("muted") else ("Mute", "mute"))
    actions.append(("Unpin", "unpin") if row.get("pinned") else ("Pin", "pin"))
    if row.get("pinned"):
        actions.extend((("Move pin earlier", "pin-up"), ("Move pin later", "pin-down")))
    if not row.get("muted") and not row.get("remote"):
        if row.get("state") == "working":
            actions.append(("Keep result", "keep-result") if row.get("discardResult") else ("Discard result", "discard-result"))
        # An Idle row arms its next task: when it has no mark, or when the arm is on (Keep clears it).
        elif row.get("state") == "idle" and (row.get("discardResult") or not attention_indicator(row, True)):
            actions.append(("Keep next result", "keep-result") if row.get("discardResult") else ("Discard next result", "discard-result"))
    return actions


# The row panel slot and icon of each row_menu_actions action; the slots are in the menu order.
ROW_PANEL_SLOTS = {"mark-read": ("read", "object-select-symbolic"), "mark-unread": ("read", "mail-unread-symbolic"),
                   "drawer-out": ("drawer", "asb-drawer-symbolic"), "drawer-in": ("drawer", "asb-drawer-symbolic"),
                   "unmute": ("mute", "preferences-system-notifications-symbolic"), "mute": ("mute", "asb-muted-symbolic"),
                   "unpin": ("pin", "view-pin-symbolic"), "pin": ("pin", "view-pin-symbolic"),
                   "pin-up": ("pin-up", "go-up-symbolic"), "pin-down": ("pin-down", "go-down-symbolic"),
                   "keep-result": ("discard", "edit-undo-symbolic"), "discard-result": ("discard", "edit-delete-symbolic")}


def row_panel_controls(row):
    """The row panel action rows from row_menu_actions, in its order: slot -> (action, label, icon)."""
    return {ROW_PANEL_SLOTS[action][0]: (action, {"mark-read": "Mark read", "mark-unread": "Mark unread"}.get(action, title),
                                         ROW_PANEL_SLOTS[action][1]) for title, action in row_menu_actions(row)}


def session_reference(row):
    """The app host and the app's own session ID, for example claude-proxy/local_<uuid>; never the ASB row ID."""
    host = row.get("sourceName") or (row["provider"] if row.get("provider") in ("codex", "opencode") else "claude-desktop-code")
    return host + "/" + str(row.get("externalId", ""))


# The board text of each dashboard referenceUnavailable code; <machine> is the row's machineName.
REFERENCE_REASONS = {"no-machine-identity": "This computer has no ASB machine ID. Run asb doctor.",
                     "unknown-source": "ASB does not know the profile of this session.",
                     "invalid-app-id": "This session has an ID in a form that ASB does not know.",
                     "unsupported-type": "This version of ASB does not know this app. Update ASB on this machine.",
                     "old-peer": "{machine} has an older ASB. Update ASB on that machine.",
                     "ambiguous-source": "More than one profile reads this session. ASB cannot pick one."}


def copy_values(row):
    """(relative, its reason, absolute, its reason): a value is None, with the reason text, when it is not one safe line."""
    def safe(text):
        # Printable ASCII with no space or line break; the engine checks the grammar.
        return isinstance(text, str) and 1 <= len(text) <= 384 and all("\x21" <= char <= "\x7e" for char in text)
    new_engine = "reference" in row or "referenceUnavailable" in row
    code, machine = row.get("referenceUnavailable"), str(row.get("machineName") or "")
    short = row.get("sessionReference") if new_engine else session_reference(row)
    short_reason = None if safe(short) else REFERENCE_REASONS["unsupported-type" if code == "unsupported-type" else "invalid-app-id"]
    full = row.get("reference")
    if safe(full):
        full_reason = None
    elif not new_engine:
        full_reason = "The ASB engine is older. Quit ASB and start it again."
    elif code == "unknown-source" and row.get("remote") is True:
        full_reason = f"{machine} did not send the profile of this session."
    elif isinstance(code, str) and code in REFERENCE_REASONS:
        full_reason = REFERENCE_REASONS[code].format(machine=machine)
    else:
        full_reason = "ASB cannot make a full reference for this session."
    return (None if short_reason else short), short_reason, (None if full_reason else full), full_reason


COPY_KINDS = ("relative", "absolute")
COPY_KIND_WORDS = {"relative": "Relative", "absolute": "Absolute"}
COPY_DONE_TEXT = {"relative": "Relative session copied", "absolute": "Absolute session copied"}
COPY_KIND_ICONS = {"relative": "asb-link-symbolic", "absolute": "asb-globe-symbolic"}
COPY_REST_S = .25
# Each window copies this as its own wheel accumulator.
COPY_WHEEL_STATE = {"ts": 0.0, "acc": 0.0, "armed": True}


def validate_copy_kind(value):
    if value not in COPY_KINDS:
        raise ValueError("Copy kind must be Relative or Absolute.")
    return value


def card_copy(row, kind="relative"):
    """(value, its reason, "relative" or "absolute") for the chosen kind: a remote row copies the absolute reference."""
    short, short_reason, full, full_reason = copy_values(row)
    if row.get("remote") is True or kind == "absolute":
        return (full, full_reason, "absolute")
    return (short, short_reason, "relative")


def copy_relative_reason(row):
    """Why a remote row cannot copy a relative reference; same phrasing as the referenceUnavailable reasons."""
    return f"Relative works only on this machine. This session runs on {row.get('machineName') or 'another machine'}."


def copy_rest_ready(rested_at, now):
    """True after the pointer has rested on the copy button for 250 ms."""
    return rested_at is not None and now - rested_at >= COPY_REST_S


def copy_wheel_captured(rested_at, now, tag_shown=False, keyboard_focus=False):
    """The kind switch takes the wheel only after that rest, or while the tag shows."""
    return bool(keyboard_focus or tag_shown or copy_rest_ready(rested_at, now))


def copy_wheel_step(state, delta, now, surface=False):
    """(step, state): +1/-1 for one kind step. A wheel notch steps once; smooth deltas accumulate to one step."""
    if not delta:
        return 0, state
    state = dict(state)
    if not surface:
        # One wheel notch is 1.0. Hi-res wheels send fractions that add up to one notch; a large event is still one step.
        if now - state["ts"] > .2:
            state["acc"] = 0.0
        state["ts"] = now
        if state["acc"] and (state["acc"] > 0) != (delta > 0):
            state["acc"] = 0.0
        state["acc"] += delta
        if abs(state["acc"]) < 1.0:
            return 0, state
        step = 1 if state["acc"] > 0 else -1
        state["acc"] -= step
        if abs(delta) >= 1.0 or abs(state["acc"]) >= 1.0:
            state["acc"] = 0.0
        return step, state
    # A trackpad: one step per burst of smooth deltas.
    if now - state["ts"] > .12:
        state["acc"] = 0.0
        state["armed"] = True
    state["ts"] = now
    if not state["armed"]:
        return 0, state
    state["acc"] += delta
    if abs(state["acc"]) < 30:
        return 0, state
    state["armed"] = False
    return (1 if state["acc"] > 0 else -1), {**state, "acc": 0.0}


def popover_shift(anchor_x, anchor_width, popover_width, window_width, margin=8):
    left = anchor_x + (anchor_width - popover_width) / 2
    if popover_width > window_width - 2 * margin:
        return round(margin - left)
    return round(min(max(left, margin), window_width - margin - popover_width) - left)


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
    return tuple(row.get(key) for key in ("unread", "alert", "questionAttention", "nativeUnread", "manualUnread",
                 "nativeAttention", "completionAttention", "failedAttention", "retainedUnread", "retainedUnreadSource",
                 "completionAtMs", "failedAtMs", "lastOutcome", "actionRequired", "actionAttention", "discardResult", "updatedAtMs", "state", "workingSinceMs", "questionPending", "drawer"))


def attention_indicator(row, drawer=False):
    """Return the row mark in question, alert, unread, discard, then stopped order. With drawer, a drawer row shows its stored unread mark."""
    return "question" if row.get("actionRequired") or row.get("questionAttention") else "alert" if row.get("alert") else "dot" \
        if row.get("unread") or (drawer and row.get("drawer") and row.get("state") != "working" and not limit_left(row)) \
        else "discard" if row.get("state") in ("working", "idle") and row.get("discardResult") \
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


# App order in the Filters popover and in profile chips: Codex, Claude, OpenCode.
APP_ORDER = ("codex", "claude-desktop-code", "opencode")


def order_of(provider):
    return APP_ORDER.index(provider) if provider in APP_ORDER else len(APP_ORDER)


def profile_key(machine, source_id):
    return f"{machine}|{source_id}"


def row_profile_key(row):
    """A row is in the profile (machine, sourceId): remote rows use their machineId, local rows are this machine."""
    machine = str(row.get("machineId") or "") if row.get("remote") is True else ""
    return profile_key(machine, row.get("sourceId") or row.get("provider") or "")


def filter_profiles(dashboard):
    """The popover profile model: this machine first, then other machines by name.
    Each machine is {"machine", "machineName", "apps"} and each app is {"provider", "profiles"};
    each profile is {"key", "label", "color"}. Apps follow APP_ORDER; profiles keep source order."""
    local_name = ""
    for row in dashboard.get("threads", []):
        if row.get("remote") is not True and row.get("machineName"):
            local_name = str(row["machineName"])
            break
    local = []
    seen = set()
    for entry in dashboard.get("providers", []):
        provider = entry.get("provider")
        if not provider or entry.get("id") in seen:
            continue
        seen.add(entry.get("id"))
        local.append({"key": profile_key("", entry.get("id") or ""), "label": str(entry.get("label") or ""),
                      "color": str(entry.get("color") or ""), "provider": provider, "source": ""})
    remote = {}
    for row in dashboard.get("threads", []):
        if row.get("remote") is not True:
            continue
        machine = str(row.get("machineId") or "")
        source_id = row.get("sourceId") or row.get("provider") or ""
        key = profile_key(machine, source_id)
        if key in seen:
            continue
        seen.add(key)
        provider = row.get("provider") or ""
        label = row.get("sourceLabel") or (APP_NAMES.get(provider, provider) if source_id == provider else source_id)
        entry = {"key": key, "label": str(label), "color": str(row.get("sourceColor") or ""),
                 "provider": provider, "source": machine, "machineName": str(row.get("machineName") or machine)}
        remote.setdefault(machine, []).append(entry)

    def by_app(entries):
        groups = {}
        for entry in entries:
            groups.setdefault(entry["provider"], []).append(entry)
        apps = []
        for provider in sorted(groups, key=order_of):
            apps.append({"provider": provider,
                         "profiles": tuple({"key": item["key"], "label": item["label"], "color": item["color"]}
                                           for item in groups[provider])})
        return tuple(apps)

    machines = [{"machine": "", "machineName": local_name or "This machine", "apps": by_app(local)}]
    for machine in sorted(remote, key=lambda name: (remote[name][0].get("machineName", name), name)):
        entries = sorted(remote[machine], key=lambda item: (order_of(item["provider"]), item["label"]))
        machines.append({"machine": machine, "machineName": remote[machine][0].get("machineName") or machine,
                         "apps": by_app(entries)})
    return tuple(machines)


def filtered_rows(dashboard, query="", app="all", state="all", archived=False, pending_only=False, drawer_only=False, profiles=None):
    query, app = provider_query(query, app)
    # An empty state set means every state; a missing profile set means every profile.
    states = set(STATES) if state == "all" or not state else {state} if isinstance(state, str) else set(state)
    wanted = frozenset(profiles or ())
    working_or_unread = pending_only and states == {"working"}
    rows = [row for row in dashboard.get("threads", [])
            if (archived or not row.get("archived"))
            and (not drawer_only or row.get("drawer"))
            and (app == "all" or row.get("provider") in ({app} if isinstance(app, str) else app))
            and (not wanted or row_profile_key(row) in wanted)
            and ((row.get("state") == "working" or row.get("pending") or row.get("unread") or row.get("questionAttention"))
                 if working_or_unread else row.get("state") in states and (not pending_only or row.get("pending")))
            and (not query or query in "\n".join(str(row.get(key, "")) for key in
                 ("title", "projectName", "cwd", "providerLabel", "sourceLabel")).casefold())]
    # One card for each ID: the first row wins. A card in a column twice makes GTK list it twice, with no warning.
    rows = list({row["id"]: row for row in reversed(rows)}.values())
    def bucket(row):
        if row.get("pending"):
            return 0
        return {"working": 1, "idle": 2, "waiting": 2, "unknown": 3}.get(row.get("state"), 3)
    def moment(row):
        # Output changes updatedAtMs at each scan; the task start keeps a Working row in its place.
        if row.get("state") != "working":
            return row.get("updatedAtMs", 0)
        start = row.get("workingSinceMs")
        return start if type(start) in (int, float) and start > 0 else 0
    rows.sort(key=lambda row: (0, row.get("pinIndex", 0), row["id"]) if row.get("pinned") else
              (1, bucket(row), row.get("state") != "working", -moment(row), row["id"]))
    return rows


def limit_rows(rows, limit, show_all=False):
    """The first `limit` rows and one More row for the rest. A limit of 0 or show_all keeps every row."""
    if not limit or show_all or len(rows) <= limit:
        return rows
    rest = rows[limit:]
    return rows[:limit] + [{"id": MORE_ID, "provider": "", "providerLabel": "", "title": "More sessions", "state": "idle",
                            "canOpen": False, "updatedAtMs": max(row.get("updatedAtMs", 0) for row in rest),
                            "asbMore": len(rest), "asbLimit": limit, "asbFirst": rest[0]["id"]}]


def pack_columns(rows, width, height, column_width=DEFAULT_COLUMN_WIDTH, row_height=ROW_HEIGHT):
    columns = max(1, (width + 12) // (column_width + 12))
    capacity = max(1, (height - 4) // row_height)
    parts = [rows[start:start + capacity] for start in range(0, len(rows), capacity)]
    return columns, capacity, parts


def column_cards(listing):
    """The cards of a column that are widget children, in the order GTK draws them."""
    cards, card = [], listing.get_first_child()
    while card:
        cards.append(card)
        card = card.get_next_sibling()
    return cards


def listed_cards(listing):
    """The cards in the internal list of a column. GTK lays out this list: an entry that is no widget child leaves an empty slot."""
    cards, card = [], listing.get_row_at_index(0)
    while card is not None:
        cards.append(card)
        card = listing.get_row_at_index(len(cards))
    return cards


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


# MSYS2 has no Python qrcode package, so the board on Windows shows no QR code.
QR_HELP = ("Windows shows no QR code. Use Copy link." if os.name == "nt"
           else "Install the Python qrcode module and PyGObject cairo support. Run asb doctor for the command.")
THEME_KEYS = ("background", "text", "accent", "muted", "divider")


def config_dir(env=os.environ, os_name=os.name):
    """The ASB config folder (configDir in src/platform-paths.mjs); on Linux a relative XDG_CONFIG_HOME stays as it is."""
    if os_name == "nt":
        appdata = env.get("APPDATA", "")
        return (Path(appdata) if ntpath.isabs(appdata) else Path.home() / "AppData" / "Roaming") / "asb"
    return Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "asb"


THEME_PATH = config_dir() / "theme.json"
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


def validate_card_limit(value):
    if type(value) is not int or value not in {limit for limit, _title in CARD_LIMITS}:
        raise ValueError("Cards on the board must be 50, 100, 200, 500, or All.")
    return value


def read_layout(path):
    if not path or not Path(path).exists():
        return {"columnWidth": DEFAULT_COLUMN_WIDTH, "view": "compact", "cardLimit": DEFAULT_CARD_LIMIT, "copyKind": "relative"}
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict) or not {"version", "columnWidth"}.issubset(value) \
            or set(value) - {"version", "columnWidth", "view", "showAppPills", "cardLimit", "copyKind"} or value["version"] != 1:
        raise ValueError("The saved layout is not valid. Reset the width.")
    view = value.get("view", "compact")
    if view not in ("compact", "comfortable"):
        raise ValueError("Choose Compact or Comfortable view.")
    return {"columnWidth": validate_column_width(value["columnWidth"]), "view": view,
            "cardLimit": validate_card_limit(value.get("cardLimit", DEFAULT_CARD_LIMIT)),
            "copyKind": validate_copy_kind(value.get("copyKind", "relative"))}


def write_layout(path, width=None, view=None, card_limit=None, copy_kind=None):
    if view is None or card_limit is None or copy_kind is None:
        saved = read_layout(path)
        view = saved["view"] if view is None else view
        card_limit = saved["cardLimit"] if card_limit is None else card_limit
        copy_kind = saved["copyKind"] if copy_kind is None else copy_kind
    if view not in ("compact", "comfortable"):
        raise ValueError("Choose Compact or Comfortable view.")
    validate_card_limit(card_limit)
    validate_copy_kind(copy_kind)
    if width is None and view == "compact" and card_limit == DEFAULT_CARD_LIMIT and copy_kind == "relative":
        write_config(path, None)
        return
    value = {"version": 1, "columnWidth": validate_column_width(DEFAULT_COLUMN_WIDTH if width is None else width)}
    if view == "comfortable":
        value["view"] = view
    if card_limit != DEFAULT_CARD_LIMIT:
        value["cardLimit"] = card_limit
    if copy_kind != "relative":
        value["copyKind"] = copy_kind
    write_config(path, value)


ACTIVITY_SIZE_KINDS = ("messages", "usage")


def valid_window_size(width, height, maximized):
    return all(type(value) is int and 360 <= value <= 16384 for value in (width, height)) and type(maximized) is bool


def read_window_sizes(path):
    """The saved Messages and Usage window sizes, {kind: (width, height, maximized)}; a missing, broken, or invalid file or kind gives none."""
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict) or value.get("version") != 1:
        return {}
    sizes = {}
    for kind in ACTIVITY_SIZE_KINDS:
        entry = value.get(kind)
        if isinstance(entry, dict) and valid_window_size(entry.get("width"), entry.get("height"), entry.get("maximized")):
            sizes[kind] = (entry["width"], entry["height"], entry["maximized"])
    return sizes


def write_window_size(path, kind, width, height, maximized):
    """Save one window size next to layout.json; layout.json keeps its keys, because older ASB versions reject unknown keys there."""
    if kind not in ACTIVITY_SIZE_KINDS or not valid_window_size(width, height, maximized):
        return
    sizes = read_window_sizes(path)
    sizes[kind] = (width, height, maximized)
    write_config(path, {"version": 1, **{name: {"width": w, "height": h, "maximized": m} for name, (w, h, m) in sizes.items()}})


def filter_chips(pending, states, profiles, profile_model, archived, show_all=False, limit=DEFAULT_CARD_LIMIT):
    """One chip per active filter value, in toolbar order. Each chip is (key, label, detail, color)."""
    chips = []
    if pending:
        chips.append(("pending", "Pending", "Remove filter: Pending", ""))
    chosen = set(states or ())
    for state in STATES:
        if state in chosen:
            chips.append((f"state:{state}", state.capitalize(), "Remove filter: " + state.capitalize(), ""))
    lookup = {profile["key"]: (profile, machine) for machine in profile_model for app in machine["apps"] for profile in app["profiles"]}
    order = [profile["key"] for machine in profile_model for app in machine["apps"] for profile in app["profiles"]]
    for key in order:
        if key not in set(profiles or ()):
            continue
        profile, machine = lookup[key]
        name = profile["label"]
        if machine["machine"]:
            name = f"{name} · {machine['machineName']}"
        chips.append((f"profile:{key}", name, "Remove filter: " + name, profile["color"]))
    if archived:
        chips.append(("archive", "Include archived", "Remove filter: Include archived", ""))
    if show_all and limit:
        chips.append(("all", "All cards", f"Show only the first {limit} cards", ""))
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
    if isinstance(reset, bool) or not isinstance(reset, (int, float)) or not math.isfinite(reset) or reset <= now_ms or reset > 8.64e15:
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
    """The Grey tone of a view-only row with no attention: "quiet" keeps the Working color, "rest" also dims the state."""
    if (not is_view_only(row) or row.get("unread") or row.get("questionAttention") or row.get("pending")
            or (row.get("limitResetsAtMs") or 0) > 0):
        return ""
    return "quiet" if row.get("state") == "working" else "rest"


# shortcut: a Comfortable column wider than about 370 px shows the … before its two lines are full; raise the limit if wide columns are common.
CARD_TITLE_CHARS = 85


def card_title(title):
    # Pango lays out the whole label text, also when the card shows only two lines; some titles are long prompts.
    text = " ".join(title.split()) or "Untitled session"
    return text if len(text) <= CARD_TITLE_CHARS else text[:CARD_TITLE_CHARS - 1].rstrip() + "…"


def short_home_path(path, home_dir):
    home = str(Path(home_dir))
    # A Windows home (a drive or UNC root) uses a backslash; in a Linux path a backslash is part of a file name.
    separator = "\\" if ntpath.splitdrive(home)[0] else "/"
    if path == home:
        return "~"
    if path.startswith(home.rstrip(separator) + separator):
        return "~" + path[len(home.rstrip(separator)):]
    return path


def tooltip_model(row, now_ms, home_dir, error="", drawer_view=False):
    full_path = row.get("cwd") or row.get("projectName") or "No project folder"
    path = short_home_path(full_path, home_dir)
    state = row.get("state", "unknown")
    state = state if state in STATES else "unknown"
    state_word = "Stopped" if state == "idle" and row.get("lastOutcome") in ("failed", "limit") else state.capitalize()
    state_text = state_word + " · " + (working_duration(row, now_ms) or row_meta(row, now_ms).split(" · ")[1])
    provider = row.get("providerLabel") or APP_NAMES.get(row.get("provider"), "Unknown app")
    source_label, source_id = row.get("sourceLabel", ""), row.get("sourceId", "")
    app = provider + (" · " + source_label if source_label and source_label != provider else "")
    indicator = attention_indicator(row, True)
    # A drawer row has its unread note in each view, and its dot only where the row shows it.
    shape = "" if indicator == "dot" and not row.get("unread") and not drawer_view else indicator
    note = ""
    if indicator == "question":
        note = "Waits for your permission." if row.get("actionRequired") else "Asks a question. Open the chat to answer."
    elif indicator == "alert":
        note = "Usage limit stopped the task. Not read yet." if row.get("lastOutcome") == "limit" else "Failed. Not read yet."
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
        note = "Discard is on for the next task." if row.get("state") == "idle" else "Discard is on for this task."
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
    source = "Profile: " + (source_label or source_id) if source_label or source_id else ""
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
        import gi
        # The draw callback of the QR code needs PyGObject cairo support.
        gi.require_foreign("cairo")
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


# Messages and Usage windows: names, colors, and formats that both windows share.
ACTIVITY_APPS = ("codex", "claude", "opencode")
USAGE_APPS = ACTIVITY_APPS + ("antigravity", "grok", "pi")
USAGE_MAKER_COLOR = "#8c929a"
USAGE_OTHER_MAKER = "Other"
ACTIVITY_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
ACTIVITY_APP_LABELS = {"codex": "Codex", "claude": "Claude Code", "opencode": "OpenCode", "": "Other", "antigravity": "Antigravity", "grok": "Grok", "pi": "Pi"}
ACTIVITY_APP_ICONS = {"codex": "asb-openai-symbolic", "claude": "asb-claude-symbolic", "opencode": "asb-opencode-symbolic", "": "asb-machine-symbolic", "antigravity": "asb-terminal-symbolic", "grok": "asb-terminal-symbolic", "pi": "asb-terminal-symbolic"}
ACTIVITY_APP_COLORS = {"codex": "#c9ccd1", "claude": "#d97757", "opencode": "#7d848c", "": "#5d6268", "antigravity": "#4f8fe0", "grok": "#e8e46a", "pi": "#c678dd"}
ACTIVITY_TOKEN_COLORS = {"cacheRead": "#4b5058", "cacheWrite": "#6b7179", "uncached": "#959ba3", "output": "#e4e6e8"}
MACHINE_HUES = ("#a28caa", "#7cc48a", "#5fb3b3", "#d6a15e", "#e38fb0", "#b4b86c")
MESSAGE_PERIODS = (("24h", "24 hours"), ("7d", "7 days"), ("30d", "30 days"))
USAGE_PERIODS = (("24h", "24 hours"), ("7d", "7 days"), ("30d", "30 days"), ("90d", "90 days"), ("all", "All time"))


def format_count(n):
    return f"{n:,}"


def format_cost(usd):
    return "Unpriced" if usd is None else f"${usd:,.2f}"


def format_tokens(n):
    if n < 1000:
        return str(round(n))
    for size, suffix, digits in ((1e3, "K", 1), (1e6, "M", 1), (1e9, "B", 2)):
        # Round half up on the shown digit; a value that rounds to 1000 of a unit shows in the next unit.
        shown = math.floor(n / size * 10 ** digits + .5) / 10 ** digits
        if shown < 1000 or suffix == "B":
            return f"{shown:.{digits}f}{suffix}"


def format_share(fraction):
    return f"{fraction * 100:.1f}%"


def format_clock(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%H:%M")


def format_day(ms):
    day = datetime.fromtimestamp(ms / 1000)
    # English month names do not follow the locale.
    return f"{ACTIVITY_MONTHS[day.month - 1][:3]} {day.day}"


def day_line(ms, now_ms):
    days = (datetime.fromtimestamp(now_ms / 1000).date() - datetime.fromtimestamp(ms / 1000).date()).days
    return "Today" if days == 0 else "Yesterday" if days == 1 else format_day(ms)


def machine_hue(index):
    return MACHINE_HUES[index % len(MACHINE_HUES)]


def machine_state_text(machine):
    return {"local": "Local", "online": "Connected", "offline": "Offline"}.get(machine.get("state"), "")


def machine_last_report(machine):
    at = machine.get("lastReportAtMs") or 0
    return f"Last report {format_day(at)}, {format_clock(at)}" if machine.get("state") == "offline" and at > 0 else ""


def bucket_label(buckets, index):
    starts, hourly = buckets["startsMs"], buckets["unit"] == "hour"
    if buckets["unit"] == "month":
        if index == len(starts) - 1:
            return "This month"
        month = datetime.fromtimestamp(starts[index] / 1000)
        label = ACTIVITY_MONTHS[month.month - 1][:3]
        return f"{label} {month.year}" if index == 0 or month.month == 1 else label
    if index == len(starts) - 1:
        return "Now" if hourly else "Today"
    return format_clock(starts[index]) if hourly else format_day(starts[index])


def usage_axis_labels(buckets, centers, chart_width, step, measure):
    """The x labels of the chart as (index, text, left x): every step-th bar from the last, centered and kept inside the chart,
    skipped when it would end less than 4 px before the label to its right. Month labels name the year where it changes."""
    starts, last, month = buckets["startsMs"], len(centers) - 1, buckets["unit"] == "month"

    def text(index, year):
        if not month or index == last:
            return bucket_label(buckets, index)
        at = datetime.fromtimestamp(starts[index] / 1000)
        return f"{ACTIVITY_MONTHS[at.month - 1][:3]} {at.year}" if year else ACTIVITY_MONTHS[at.month - 1][:3]

    def place(index, width):
        return min(max(centers[index], width / 2), chart_width - width / 2) - width / 2

    shown, limit = [], None
    for index in range(last, -1, -step):
        # A month label is measured with its year, so the year rule below never makes it wider than measured.
        width = measure(text(index, True))
        left = place(index, width)
        if limit is None or left + width <= limit - 4:
            shown.insert(0, index)
            limit = left
    labels, year = [], None
    for index in shown:
        at = datetime.fromtimestamp(starts[index] / 1000).year
        label = text(index, at != year)
        year = at
        labels.append((index, label, place(index, measure(label))))
    return labels


def activity_palette(colors):
    background, text, accent = colors["background"], colors["text"], colors["accent"]
    return {"win": background, "rule": mix_color(background, text, .13), "track": mix_color(background, text, .17),
            "divider": colors["divider"], "popup": edge_color(background, text, .36, (background,)),
            "text": text, "dim": colors["muted"], "accent": accent, "light": mix_color(accent, "#ffffff", .35), "warn": "#e0b45a", "bad": "#f5a090"}


def request_json(base, route, method="GET", body=None, etag=None, headers=None):
    headers = {"Accept": "application/json", **(headers or {})}
    path = route.split("?", 1)[0]
    source_route = path == "/api/sources" or path.startswith("/api/sources/")
    bridge_route = path == "/api/bridge" or path.startswith("/api/bridge/")
    phone_route = path == "/api/phone" or path.startswith("/api/phone/")
    group_route = path == "/api/group" or path.startswith("/api/group/")
    service_route = path == "/api/service"
    palette_route = path == "/api/palette"
    agent_route = path.startswith("/api/agent/")
    engine_route = path.startswith("/api/engine/")
    activity_route = path.startswith("/api/activity/")
    usage_route = path.startswith("/api/usage/")
    data = None
    if etag and etag[0] and method == "GET" and route.split("?")[0] == "/api/dashboard":
        headers["If-None-Match"] = etag[0]
    if SOURCE_TOKEN and (((source_route or bridge_route) and method == "POST") or phone_route or group_route or service_route or palette_route or agent_route or engine_route
                         or usage_route):
        headers["X-ASB-Source-Token"] = SOURCE_TOKEN
    if method == "POST":
        headers.update({"Origin": base, "Content-Type": "application/json"})
        data = json.dumps(body or {}).encode()
    request = Request(base + route, data=data, headers=headers, method=method)
    try:
        # Join and leave wait for the other machines.
        # Usage exports, imports, and backups read or write all the usage records.
        timeout = 420 if method == "POST" and path == "/api/bridge/install" else 30 if method == "POST" and path in ("/api/group/join", "/api/group/leave") \
            else 120 if (method, path) in (("GET", "/api/usage/export"), ("POST", "/api/usage/backup/now"), ("POST", "/api/usage/import")) else 15
        with LOCAL_HTTP.open(request, timeout=timeout) as response:
            result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("The ASB response is not an object.")
        success = "opened" if route.endswith("/open") else "marked" if route.endswith("/mark-unread") else "changed"
        if method == "POST" and not (bridge_route or phone_route or group_route or service_route or palette_route or agent_route or engine_route
                                     or usage_route) and not result.get(success):
            raise ValueError("The session action did not succeed.")
        if etag is not None:
            etag[0] = response.headers.get("ETag")
        return result
    except (HTTPError, URLError, HTTPException, OSError, ValueError) as error:
        if isinstance(error, HTTPError) and error.code == 304 and "If-None-Match" in headers:
            error.close()
            return None
        if bridge_route or source_route or phone_route or group_route or service_route or palette_route or agent_route or engine_route \
                or activity_route or usage_route:
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
            if activity_route:
                # An engine from before the activity routes answers 404.
                if isinstance(error, HTTPError) and error.code == 404:
                    detail = "This ASB engine has no activity data. Update ASB, then try again."
                raise RuntimeError(detail or "Cannot load the activity. Check that ASB is running, then try again.") from error
            if usage_route and isinstance(error, HTTPError) and error.code == 404:
                # An engine from before the usage backups answers 404.
                detail = "This ASB engine has no usage backups. Update ASB, then try again."
            subject = "ASB Bridge" if bridge_route else "phone access" if phone_route else "the machine group" if group_route else "the ASB service" if service_route \
                else "the phone palette" if palette_route else "the native UI status" if agent_route else "ASB" if engine_route \
                else "usage backups" if usage_route else "profiles"
            raise RuntimeError(detail or f"Cannot load or change {subject}. Check that ASB is running, then try again.") from error
        if isinstance(error, HTTPError) and method == "POST" and path.startswith("/api/threads/"):
            # The engine tells why a session does not open or change; the fixed texts below can point to the wrong cause.
            try:
                payload = json.loads(error.read(8192))
            except (HTTPException, OSError, ValueError):
                payload = None
            payload = payload if isinstance(payload, dict) else {}
            if path.endswith("/open"):
                if error.code == 500 and isinstance(payload.get("detail"), str) and payload["detail"]:
                    raise RuntimeError(f"Cannot open this session: {payload['detail']}") from error
                if error.code == 404:
                    raise RuntimeError("Cannot open this session. Refresh the session list, then try again.") from error
            elif error.code == 400 and isinstance(payload.get("error"), str) and payload["error"]:
                raise RuntimeError(payload["error"]) from error
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


def launcher_address(line):
    """The local engine URL and the token from a JSON line of the launcher. ValueError when the line is not an address."""
    try:
        value = json.loads(line)
    except ValueError:
        value = None
    if not isinstance(value, dict) or not isinstance(value.get("url"), str) or not isinstance(value.get("token"), str):
        raise ValueError("ASB did not get the engine address from its launcher.")
    return local_base_url(value["url"]), value["token"]


# Messages window: pure logic.
def message_feed(reply, now_ms, session=None, limit=200):
    """The newest messages and local day headings, plus whether some messages were left out."""
    seats = {seat["id"]: seat for seat in reply.get("seats") or []}
    machines = {machine["machineId"]: machine for machine in reply.get("machines") or []}
    records = [record for record in reply.get("messages") or []
               if session is None or session in (record["from"], record["to"])]
    newest = records[::-1][:limit]
    rows, last_day = [], None
    for record in newest:
        day = datetime.fromtimestamp(record["atMs"] / 1000).date()
        if day != last_day:
            rows.append(("day", day_line(record["atMs"], now_ms)))
            last_day = day
        status = record.get("status")
        item = {"id": record["id"], "time": format_clock(record["atMs"]),
                "status": {"accepted": "", "written": "Socket written", "held": "Held",
                           "not-sent": record.get("reason") or "Not sent"}.get(status, "Unknown"),
                "text": record.get("text") if isinstance(record.get("text"), str) else None}
        for end, name in (("from", "sender"), ("to", "receiver")):
            seat_id = record[end]
            seat = seats.get(seat_id) or {}
            item[name] = (record.get(end + "Label") or "Other session") if seat_id.startswith("unknown:") else seat.get("title") or "Other session"
            machine = machines.get(seat.get("machineId")) or {}
            item[name + "_machine"] = "" if machine.get("self") else machine.get("name", "")
        rows.append(("message", item))
    return rows, len(records) > limit or bool(reply.get("truncated"))


def cubic_bezier(x1, y1, x2, y2):
    """A CSS cubic-bezier timing function, solved by bisection as the preview does."""
    def axis(a, b, t):
        return 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3

    def ease(x):
        if x <= 0:
            return 0
        if x >= 1:
            return 1
        low, high = 0, 1
        for _step in range(30):
            middle = (low + high) / 2
            low, high = (middle, high) if axis(x1, x2, middle) < x else (low, middle)
        return axis(y1, y2, (low + high) / 2)
    return ease


ease_bars = cubic_bezier(.16, 1, .3, 1)


class LauncherStart:
    """The engine address when the launcher starts the board before the engine is ready (the address argument is "-").
    The launcher writes JSON address lines to stdin when the engine is ready or restarts. A thread reads it and then loads the first
    dashboard, so that the wait for the engine and the request overlap the slow GTK import and the window build."""

    def __init__(self, descriptor=0, fetch=None):
        self.descriptor, self.fetch = descriptor, fetch or request_json
        self.known = threading.Event()
        self.base = self.problem = self.outcome = self.waiting = None
        self.used = False
        self.lock = threading.Lock()
        self.buffer = b""
        self.reconnect_target, self.reconnect_pending = None, []
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def read_line(self, initial=False):
        # os.read and not sys.stdin: a thread that waits in a text stream can stop Python at exit.
        oversized = False
        while True:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                return b"" if oversized or len(line) > 4096 else line
            if len(self.buffer) > 4096:
                oversized, self.buffer = True, b""
            try:
                chunk = os.read(self.descriptor, 4096)
            except OSError:
                return None
            if not chunk:
                line, self.buffer = self.buffer, b""
                return line if initial and not oversized and 0 < len(line) <= 4096 else None
            self.buffer += chunk

    def reconnect(self, callback, dispatch):
        with self.lock:
            self.reconnect_target = (callback, dispatch)
            for base, token in self.reconnect_pending:
                dispatch(callback, base, token)
            self.reconnect_pending.clear()

    def run(self):
        global SOURCE_TOKEN
        try:
            self.base, SOURCE_TOKEN = launcher_address(self.read_line(initial=True) or b"")
        except ValueError as error:
            self.problem = str(error)
        finally:
            self.known.set()
        if not self.base:
            return
        etag = [None]
        # The placeholder is delivered when the request raises more than RuntimeError: the window then tries again by itself.
        outcome = (None, "Cannot load sessions.", etag)
        try:
            outcome = (self.fetch(self.base, "/api/dashboard", etag=etag), None, etag)
        except RuntimeError as error:
            outcome = (None, str(error), etag)
        except Exception:
            pass
        finally:
            with self.lock:
                waiting, self.waiting = self.waiting, None
                self.outcome = None if waiting else outcome
            if waiting:
                waiting[1](waiting[0], *outcome)

        while True:
            line = self.read_line()
            if line is None:
                return
            try:
                base, token = launcher_address(line)
            except ValueError:
                continue
            with self.lock:
                if self.reconnect_target:
                    callback, dispatch = self.reconnect_target
                    dispatch(callback, base, token)
                else:
                    self.reconnect_pending.append((base, token))

    def address(self):
        """The engine URL, as soon as the launcher has written it. ValueError when it never does."""
        self.known.wait()
        if not self.base:
            raise ValueError(self.problem or "ASB did not get the engine address from its launcher.")
        return self.base

    def deliver(self, callback, dispatch):
        """Calls dispatch(callback, dashboard, error, etag) once, when the early request ends (at once when it has ended), and keeps
        nothing after that. False when an earlier call took the result: the caller then asks for the first dashboard itself."""
        with self.lock:
            if self.used:
                return False
            self.used = True
            if self.outcome is None:
                self.waiting = (callback, dispatch)
                return True
            outcome, self.outcome = self.outcome, None
        dispatch(callback, *outcome)
        return True


# Usage window: pure logic. It ports utotals, the round chart, and the axis of the approved preview (boards.html, window mode).
USAGE_PARTS = ("cacheRead", "cacheWrite", "uncached", "output")
USAGE_PART_LABELS = {"cacheRead": "Cache read", "cacheWrite": "Cache write", "uncached": "Uncached input", "output": "Output"}


def usage_view(reply, machines_on, metric):
    """Every number of the Usage window for the machines that are on. value is cost (priced only) for the Cost metric, else processed tokens."""
    pick = (lambda item: item["cost"]) if metric == "cost" else (lambda item: item["tokens"])
    starts = reply["buckets"]["startsMs"]
    zero = lambda: {"cost": 0, "tokens": 0}
    machines = {}
    for index, machine in enumerate(reply["machines"]):
        if machine["machineId"] in machines_on:
            at, offline = machine.get("lastReportAtMs") or 0, machine.get("state") == "offline"
            machines[machine["machineId"]] = {
                "id": machine["machineId"], "name": machine["name"], "hue": machine_hue(index), "offline": offline,
                "state": f"Offline · last report {format_day(at)}, {format_clock(at)}" if offline and at > 0 else machine_state_text(machine),
                "apps": {app: zero() for app in USAGE_APPS + ("",)}, **zero()}
    total, apps, models, makers = zero(), {app: zero() for app in USAGE_APPS + ("",)}, {}, {}
    parts, cost_parts = dict.fromkeys(USAGE_PARTS, 0), dict.fromkeys(USAGE_PARTS, 0.0)
    bars = [{"app": {}, "machine": {}} for _start in starts]
    savings = unpriced_tokens = 0
    unpriced_models = []
    for record in reply["records"]:
        machine, bucket = machines.get(record["machineId"]), record["bucket"]
        if machine is None or not 0 <= bucket < len(starts):
            continue
        app = record["app"] if record["app"] in USAGE_APPS else ""
        tokens, cost = record["tokens"], record["cost"]
        processed, spent = sum(tokens[part] for part in USAGE_PARTS), cost["total"] if cost else 0
        for item in (total, machine, machine["apps"][app], apps[app], bars[bucket]["app"].setdefault(app, zero()),
                     bars[bucket]["machine"].setdefault(machine["id"], zero())):
            item["cost"] += spent
            item["tokens"] += processed
        maker = record.get("maker")
        if not isinstance(maker, str) or not maker:
            maker = USAGE_OTHER_MAKER
        maker = makers.setdefault(maker, {"id": maker, "label": maker, **zero(), "priced": False})
        maker["cost"] += spent
        maker["tokens"] += processed
        maker["priced"] = maker["priced"] or cost is not None
        model = models.setdefault((record["model"], app), {"model": record["model"], "app": app, "machines": set(), "cost": None, "tokens": 0})
        model["machines"].add(machine["id"])
        model["tokens"] += processed
        for part in USAGE_PARTS:
            parts[part] += tokens[part]
        if cost:
            model["cost"] = (model["cost"] or 0) + spent
            savings += cost["savings"]
            for part in USAGE_PARTS:
                cost_parts[part] += cost[part]
        else:
            unpriced_tokens += processed
            if record["model"] not in unpriced_models:
                unpriced_models.append(record["model"])
    value = pick(total)
    share = lambda item: item / value if value else 0
    rows = list(machines.values())
    for machine in rows:
        machine["value"], machine["share"] = pick(machine), share(pick(machine))
        for item in machine["apps"].values():
            item["value"] = pick(item)
    app_rows = [{"id": app, "label": ACTIVITY_APP_LABELS[app], **apps[app], "value": pick(apps[app]), "share": share(pick(apps[app]))}
                for app in USAGE_APPS + ("",) if apps[app]["tokens"] > 0]
    maker_rows = []
    for maker in makers.values():
        if maker["tokens"] > 0:
            maker_value = None if metric == "cost" and not maker["priced"] else pick(maker)
            maker_rows.append({**maker, "value": maker_value, "share": None if maker_value is None else share(maker_value)})
    maker_rows.sort(key=lambda row: (row["id"] == USAGE_OTHER_MAKER, row["value"] is None,
                                     -(row["tokens"] if row["value"] is None else row["value"]), row["label"]))
    order = list(machines)
    model_rows = []
    for model in models.values():
        model_value = None if metric == "cost" and model["cost"] is None else pick(model)
        model_rows.append({**model, "machines": sorted(model["machines"], key=order.index), "value": model_value,
                           "share": None if model_value is None else share(model_value)})
    model_rows.sort(key=lambda row: (row["value"] is None, -(row["value"] or 0)))
    for bar in bars:
        for kind in ("app", "machine"):
            bar[kind] = {key: pick(item) for key, item in bar[kind].items()}
    return {"metric": metric, "cost": total["cost"], "tokens": total["tokens"], "total": value, "machines": rows, "apps": app_rows,
            "makers": maker_rows, "models": model_rows, "parts": parts, "cost_parts": cost_parts, "savings": savings, "unpriced_tokens": unpriced_tokens,
            "unpriced_models": unpriced_models, "buckets": reply["buckets"], "bars": bars}


def usage_toggle(machines_on, machine_id):
    """The machines that are on after a chip click. The last machine that is on stays on."""
    changed = set(machines_on) ^ {machine_id}
    return changed if changed else set(machines_on)


def usage_round_arcs(view, machines, metric):
    """The arcs of the round chart: machines on the inner ring, their apps on the outer ring, from -90 degrees, clockwise."""
    pick = (lambda item: item["cost"]) if metric == "cost" else (lambda item: item["tokens"])
    rows = {machine["id"]: machine for machine in view["machines"]}
    shown = [rows[machine["machineId"]] for machine in machines if machine["machineId"] in rows and pick(rows[machine["machineId"]]) > 0]
    total = sum(pick(machine) for machine in shown)
    gap = 1.5 if len(shown) > 1 else 0
    available = 360 - gap * len(shown)
    arcs, start = [], -90
    for machine in shown:
        span = available * pick(machine) / total if total else 0
        if span >= .5:
            arcs.append({"kind": "machine", "id": machine["id"], "label": machine["name"], "value": pick(machine), "r0": 92, "r1": 114,
                         "a0": start, "a1": start + span, "color": machine["hue"]})
        apps = [app for app in USAGE_APPS + ("",) if pick(machine["apps"][app]) > 0]
        app_span = span - .6 * max(0, len(apps) - 1)
        app_start = start
        for app in apps:
            part = app_span * pick(machine["apps"][app]) / pick(machine)
            if part >= .5:
                arcs.append({"kind": "app", "id": f"{machine['id']}/{app}", "label": f"{ACTIVITY_APP_LABELS[app]} on {machine['name']}",
                             "value": pick(machine["apps"][app]), "r0": 118, "r1": 146, "a0": app_start, "a1": app_start + part,
                             "color": ACTIVITY_APP_COLORS[app]})
            app_start += part + .6
        start += span + gap
    return arcs


def usage_axis(max_value, metric):
    """The chart axis: three gridlines at multiples of a round step (1, 2, 2.5, or 5 times a power of 10), with their labels."""
    step = 1
    if max_value > 0:
        power = 10 ** math.floor(math.log10(max_value / 3))
        step = next((size * power for size in (1, 2, 2.5, 5, 10) if size * power >= max_value / 3 - 1e-12), 10 * power)

    def number(value, size=1, unit=""):
        shown = f"{float(f'{value / size:.6g}'):,.2f}"
        return shown.rstrip("0").rstrip(".") + unit

    def text(value):
        if metric == "cost":
            return "$" + number(value)
        return number(value, 1e9, "B") if value >= 1e9 else number(value, 1e6, "M") if value >= 1e6 else number(value, 1e3, "K") if value >= 1e3 \
            else number(value)
    return step, [text(step * line) for line in (1, 2, 3)]


def usage_unpriced_note(view):
    models = view["unpriced_models"]
    if view["metric"] != "cost" or not view["unpriced_tokens"] > 0:
        return ""
    if len(models) == 1:
        return f"1 unpriced model: {format_tokens(view['unpriced_tokens'])} tokens not in the cost."
    return f"{len(models)} unpriced models: {format_tokens(view['unpriced_tokens'])} tokens not in the cost."


def usage_prices_text(prices):
    prices = prices or {}
    if prices.get("status") in ("fresh", "cached") and prices.get("fetchedAtMs"):
        return f"Prices: {prices.get('source') or 'LiteLLM'}, {format_day(prices['fetchedAtMs'])}"
    return "Prices: loading" if prices.get("status") == "loading" else "Prices: not available"


def usage_scan_text(scan):
    scan = scan or {}
    if scan.get("complete", True):
        return ""
    files = scan.get("files") or 0
    return f"Reading usage: {format_count(scan.get('scannedFiles') or 0)} of {format_count(files)} files" if files else "Reading usage"


BACKUP_STATUS_KEYS = {"enabled", "time", "keep", "folder", "path", "defaultPath", "nextAtMs", "running", "files", "lastError"}
USAGE_IMPORT_LIMIT = 64 * 1024 * 1024


def backup_status_valid(value):
    """True only for the status of GET /api/usage/backup, also with the "made" of a backup."""
    def typed(item, kinds):
        return isinstance(item, dict) and set(item) == set(kinds) and all(type(item[key]) is kind for key, kind in kinds.items())
    if not isinstance(value, dict) or set(value) - {"made"} != BACKUP_STATUS_KEYS:
        return False
    error = value["lastError"]
    return (type(value["enabled"]) is bool and type(value["running"]) is bool
            and isinstance(value["time"], str) and re.fullmatch(r"([01][0-9]|2[0-3]):[0-5][0-9]", value["time"]) is not None
            and type(value["keep"]) is int and 1 <= value["keep"] <= 30
            and all(isinstance(value[key], str) for key in ("folder", "path", "defaultPath"))
            and (value["nextAtMs"] is None or type(value["nextAtMs"]) is int)
            and isinstance(value["files"], list)
            and all(typed(item, {"name": str, "date": str, "bytes": int, "modifiedAtMs": int}) for item in value["files"])
            and (error is None or typed(error, {"atMs": int, "message": str}))
            and ("made" not in value or typed(value["made"], {"name": str, "path": str, "machines": int, "hours": int})))


def backup_when(ms, now_ms):
    at, now = datetime.fromtimestamp(ms / 1000), datetime.fromtimestamp(now_ms / 1000)
    days = (now.date() - at.date()).days
    return f"Today at {at:%H:%M}" if days == 0 else f"Yesterday at {at:%H:%M}" if days == 1 else f"{at:%Y-%m-%d %H:%M}"


def backup_size(n):
    return f"{n} bytes" if n < 1024 else f"{round(n / 1024)} KB" if n < 1024 * 1024 else f"{n / (1024 * 1024):.1f} MB"


def backup_next_text(status, now_ms):
    if not status["enabled"]:
        return "Daily backup is off."
    if status["running"]:
        return "A backup is running…"
    if status["nextAtMs"] is None or status["nextAtMs"] <= now_ms:
        return "Next backup: in a few minutes."
    at, now = datetime.fromtimestamp(status["nextAtMs"] / 1000), datetime.fromtimestamp(now_ms / 1000)
    days = (at.date() - now.date()).days
    return f"Next backup: {'today at ' if days == 0 else 'tomorrow at ' if days == 1 else f'{at:%Y-%m-%d} '}{at:%H:%M}."


def backup_refresh_delay(next_at_ms, now_ms):
    """Milliseconds until the Usage page reads the backup status again: 5 s after the next backup, or 1 s after local midnight.
    A late backup (the engine was off, or the backup failed) is read again every 60 s, not every second."""
    today = datetime.fromtimestamp(now_ms / 1000).date()
    midnight_ms = datetime.combine(today + timedelta(days=1), datetime.min.time()).timestamp() * 1000
    after = next_at_ms + 5000 if next_at_ms + 5000 > now_ms else now_ms + 60_000
    return max(1000, int(min(midnight_ms + 1000, after) - now_ms))


def backup_error_text(status):
    return f"Last backup failed: {status['lastError']['message']}" if status.get("lastError") else ""


def count_text(n, word):
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def backup_made_text(made, file_name):
    return f"Saved the usage of {count_text(made['machines'], 'machine')} ({count_text(made['hours'], 'hour')}) to {file_name}."


def usage_import_text(result):
    machines = result["machines"]
    if not machines:
        return "Imported the usage of 0 machines."
    names = ", ".join(f"{machine['name']} ({count_text(machine['hours'], 'hour')})" for machine in machines)
    return f"Imported the usage of {count_text(len(machines), 'machine')}: {names}."


def backup_settings_body(enabled, hour, minute, keep, folder):
    return {"enabled": bool(enabled), "time": f"{int(hour):02d}:{int(minute):02d}", "keep": int(keep), "folder": folder}


def usage_export_name(now_ms):
    return time.strftime("asb-usage-%Y-%m-%d.json", time.localtime(now_ms / 1000))


def export_usage_file(base, path):
    """Save the usage export of the engine to path. Runs in a background thread; RuntimeError has the text for the user."""
    document = request_json(base, "/api/usage/export")
    machines = document.get("machines") if isinstance(document, dict) else None
    if not isinstance(document, dict) or document.get("format") != "asb-usage-export" or not isinstance(machines, list) \
            or not all(isinstance(machine, dict) and isinstance(machine.get("records"), list) for machine in machines):
        raise RuntimeError("This ASB engine gave an invalid usage export.")
    name = os.path.basename(path)
    temporary = f"{path}.{uuid.uuid4().hex[:12]}.tmp"
    created, descriptor = False, None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            descriptor = None  # The file object now owns it.
            file.write(json.dumps(document, separators=(",", ":")))
        os.replace(temporary, path)
    except OSError as error:
        raise RuntimeError(f"Cannot save {name}: {error.strerror or 'an error'}.") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if created:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass
    return backup_made_text({"machines": len(machines), "hours": sum(len(machine["records"]) for machine in machines)}, name)


def import_usage_file(base, path):
    """Send the usage export at path to the engine. Runs in a background thread; RuntimeError has the text for the user."""
    name = os.path.basename(path)
    try:
        if os.stat(path).st_size > USAGE_IMPORT_LIMIT:
            raise RuntimeError("The file is too large for an ASB usage export.")
        with open(path, "rb") as file:
            data = file.read(USAGE_IMPORT_LIMIT + 1)
    except OSError as error:
        raise RuntimeError(f"Cannot read {name}.") from error
    if len(data) > USAGE_IMPORT_LIMIT:
        raise RuntimeError("The file is too large for an ASB usage export.")
    try:
        document = json.loads(data)
    except (ValueError, RecursionError):
        document = None
    if not isinstance(document, dict):
        raise RuntimeError("This file is not an ASB usage export.")
    result = request_json(base, "/api/usage/import", "POST", document)
    machines = result.get("machines") if isinstance(result, dict) else None
    if not isinstance(machines, list) or not all(isinstance(machine, dict) and isinstance(machine.get("machineId"), str)
                                                 and isinstance(machine.get("name"), str) and type(machine.get("hours")) is int
                                                 for machine in machines):
        raise RuntimeError("The usage import response is not valid.")
    return usage_import_text(result)


class EventStream:
    def __init__(self, base, callback, dispatch, on_show_window=None):
        self.address = urlsplit(base)
        self.callback, self.dispatch, self.on_show_window = callback, dispatch, on_show_window
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
                            elif event == "show-window" and data and self.on_show_window:
                                # The tray asks the Board that reported last to open a window; other data is ignored.
                                try:
                                    value = json.loads("\n".join(data))
                                except ValueError:
                                    value = None
                                if isinstance(value, dict) and value.get("window") in ("board", "messages", "usage") and isinstance(value.get("clientId"), str):
                                    self.dispatch(self.on_show_window, value["window"], value["clientId"])
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


# The launcher starts the board before the engine is ready and writes the engine address to stdin later. The read and the first
# dashboard request start here, before the GTK import below, which takes most of the start time on Windows.
LAUNCHER_START = LauncherStart() if sys.argv[1:] == ["-"] else None

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


def unix_signal_add(priority, signum, callback):
    """GLib 2.88 has no GLib.unix_signal_add: it has GLibUnix.signal_add. GLib 2.84 has GLibUnix with only signal_add_full."""
    try:
        gi.require_version("GLibUnix", "2.0")
        from gi.repository import GLibUnix
        add = GLibUnix.signal_add
    except (ImportError, ValueError, AttributeError):
        add = GLib.unix_signal_add
    return add(priority, signum, callback)


SHORTCUT_MASK = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.META_MASK


def set_panel_label(button, text):
    """Set the label of a row panel action row; the label is its accessible name."""
    button.asb_label.set_label(text)
    button.update_property([Gtk.AccessibleProperty.LABEL], [text])


def set_icon(image, name):
    """Show a symbolic icon. GTK 4.18 does not recolor symbolic icons from the icon search path, so ASB glyphs load as files."""
    if name and name.startswith("asb-"):
        image.set_from_gicon(Gio.FileIcon.new(Gio.File.new_for_path(str(Path(__file__).parents[1] / "assets" / "icons" / f"{name}.svg"))))
    else:
        image.set_from_icon_name(name)


def set_windows_icon(window):
    """GTK makes a window icon only from an icon theme folder, and the ASB icon is a single file, so on Windows the board window had no icon.
    The board loads asb.ico (16, 32, 48, and 256 px) at the sizes of the Windows big and small icons."""
    try:
        gi.require_version("GdkWin32", "4.0")
        from gi.repository import GdkWin32
        hwnd = GdkWin32.Win32Surface.get_handle(window.get_surface())
    except (ImportError, ValueError, TypeError):
        return
    import ctypes
    from ctypes import wintypes
    # An own library object: the argument types do not change ctypes.windll.user32 for other code.
    user32 = ctypes.WinDLL("user32")
    user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.LoadImageW.restype = wintypes.HANDLE
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.SendMessageW.restype = wintypes.LPARAM
    icon_file = str(Path(__file__).parents[1] / "assets" / "icons" / "asb.ico")
    # WM_SETICON (0x80) with ICON_BIG (1) at SM_CXICON (11) and ICON_SMALL (0) at SM_CXSMICON (49); IMAGE_ICON 1, LR_LOADFROMFILE 0x10.
    for kind, metric in ((1, 11), (0, 49)):
        size = user32.GetSystemMetrics(metric)
        icon = user32.LoadImageW(None, icon_file, 1, size, size, 0x10)
        if icon:
            user32.SendMessageW(hwnd, 0x80, kind, icon)


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


class SnapshotWatch:
    """Development check (ASB_SNAPSHOT): save the window image once, after GTK has drawn the first dashboard. Use tick as a tick callback.
    A tick starts a frame, so the first tick is the first frame with the dashboard. The save comes one settle time later, because the
    first layout renders the board again. A save that finds no content (the window is not mapped or has no size) runs again on the next frame."""
    SETTLE_US, LIMIT_US = 250_000, 10_000_000

    def __init__(self, output):
        self.output, self.first = output, None

    def tick(self, window, clock):
        now = clock.get_frame_time()
        if self.first is None:
            self.first = now
        if now - self.first < self.SETTLE_US:
            return True
        try:
            save_snapshot(window, self.output)
            print("Saved the native ASB window image.")
        except (TypeError, RuntimeError, OSError) as error:
            if isinstance(error, RuntimeError) and now - self.first < self.LIMIT_US:
                return True
            print(f"Cannot save the native GTK image: {error}", file=sys.stderr)
        return False


class SessionStrip(Gtk.Box):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.hover_rect = self.hover_target = self.hover_from = self.hover_to = self.hover_card = None
        self.hover_alpha = 0
        self.motion, self.motion_progress = {}, 0
        target = Adw.CallbackAnimationTarget.new(self.advance_hover)
        self.hover_animation = Adw.TimedAnimation.new(self, 0, 1, 200, target)
        self.hover_animation.set_easing(Adw.Easing.EASE_OUT_EXPO)
        self.connect("unmap", self.clear_hover)
        self.flights = []
        self.connect("unmap", self.clear_flights)

    def show_hover(self, rectangle, card=None):
        if rectangle == self.hover_target and card is self.hover_card:
            return
        if card is not self.hover_card:
            # Only the card under the glide gets the class, so a class change restyles one card, not all cards.
            if self.hover_card:
                self.hover_card.remove_css_class("asb-hover-paint")
            if card:
                card.add_css_class("asb-hover-paint")
            self.hover_card = card
        self.hover_animation.pause()
        self.hover_target = rectangle
        start = self.hover_rect if self.hover_alpha > 0 else rectangle
        end = rectangle or start
        if end is None:
            self.clear_hover()
            return
        self.hover_from = (*start, self.hover_alpha)
        self.hover_to = (*end, 1 if rectangle else 0)
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
        self.queue_draw()

    def clear_hover(self, *_args, copy_tag=True):
        if self.hover_card:
            self.hover_card.remove_css_class("asb-hover-paint")
            card, self.hover_card = self.hover_card, None
            get_root = getattr(self, "get_root", None)
            root = get_root() if get_root else None
            if copy_tag and root is not None and hasattr(root, "hide_copy_tag"):
                root.hide_copy_tag(getattr(card, "asb_copy_button", None), keep_focused=True)
        if self.hover_rect is None and self.hover_target is None and self.hover_from is None:
            return
        self.hover_rect = self.hover_target = self.hover_from = self.hover_to = None
        self.hover_alpha = 0
        self.hover_animation.reset()
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
        self.active = self.refresh_queued = self.setting_form = self.conflict = False
        self.revision = self.edit_revision = self.observed_revision = self.form_baseline = self.baseline_source = None
        self.sources, self.max_sources, self.editing_id = [], 8, ""
        self.preset_markers, self.table_markers = [], []
        self.saving = self.bridge_loading = False
        self.bridge_apps, self.installing, self.dialog = None, "", None
        self.bridge_generation, self.bridge_refresh = 0, False
        # A bridge call while one runs waits here (True when one of them asked for a refresh).
        self.bridge_queued, self.feedback = None, False
        self.header_tick = self.focus_after_close = None
        self.cancellable = Gio.Cancellable()
        self.message = self.text("Loading profiles…")
        self.append(self.message)
        self.bridge_header = label("ASB Bridge", "caption")
        self.bridge_header.add_css_class("dim-label")
        self.bridge_header.set_halign(Gtk.Align.END)
        self.bridge_header.set_margin_end(36)
        self.bridge_header.set_visible(False)
        self.bridge_header.connect("map", self.queue_align)
        self.append(self.bridge_header)
        self.table = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.table.add_css_class("boxed-list")
        self.table.connect("row-activated", lambda _table, row: self.open_source(row.asb_source))
        self.append(self.table)
        footer = Gtk.Box(spacing=8)
        self.add_button = Gtk.Button(child=Adw.ButtonContent(icon_name="list-add-symbolic", label="Add a profile"))
        self.add_button.connect("clicked", self.add_source)
        footer.append(self.add_button)
        self.reload_button = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh")
        self.reload_button.add_css_class("flat")
        self.reload_button.update_property([Gtk.AccessibleProperty.LABEL], ["Refresh"])
        self.reload_button.connect("clicked", self.refresh_sources)
        footer.append(self.reload_button)
        self.count = label("", "caption")
        self.count.add_css_class("dim-label")
        self.count.set_hexpand(True)
        self.count.set_xalign(1)
        footer.append(self.count)
        self.append(footer)
        self.update_controls()

    @staticmethod
    def text(value, css="caption"):
        widget = label(value, css)
        widget.set_wrap(True)
        widget.set_selectable(True)
        widget.set_visible(bool(value))
        return widget

    def show_message(self, text, dialog=False):
        widget = self.dialog_message if dialog else self.message
        widget.set_label(text)
        widget.set_visible(bool(text))
        if not dialog:
            self.feedback = False

    def show_feedback(self, text):
        # Saved., Removed., and install results stay after later sources GETs.
        self.show_message(text)
        self.feedback = bool(text)

    def ensure_dialog(self):
        if self.dialog is not None:
            return
        modern = hasattr(Adw, "Dialog")
        if modern:
            self.dialog = Adw.Dialog(content_width=560)
            self.dialog.connect("closed", self.dialog_closed)
        else:
            self.dialog = Adw.Window(transient_for=self.preferences, modal=True, default_width=560,
                                     default_height=640, hide_on_close=True)
            self.dialog.add_css_class("asb-column-flow")
            self.dialog.add_css_class("asb-preferences")
            if self.preferences.has_css_class("asb-custom"):
                self.dialog.add_css_class("asb-custom")
            self.dialog.connect("close-request", self.dialog_closed)
        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        header.set_show_start_title_buttons(False)
        header.set_show_end_title_buttons(False)
        self.cancel_button, self.save_button = Gtk.Button(label="Cancel"), Gtk.Button(label="Save")
        self.cancel_button.connect("clicked", self.cancel_form)
        self.save_button.connect("clicked", self.save_source)
        self.save_button.add_css_class("suggested-action")
        header.pack_start(self.cancel_button)
        header.pack_end(self.save_button)
        self.dialog_title = Adw.WindowTitle()
        header.set_title_widget(self.dialog_title)
        toolbar.add_top_bar(header)
        self.form = Adw.PreferencesPage()
        def group(title=""):
            widget = Adw.PreferencesGroup(title=title)
            self.form.add(widget)
            return widget
        self.dialog_message = self.text("", "caption")
        self.dialog_message.add_css_class("warning")
        group().add(self.dialog_message)
        fields = group()
        self.name = Adw.EntryRow(title="Name")
        self.name.get_delegate().set_max_length(80)
        self.provider = Adw.ComboRow(title="App", model=Gtk.StringList.new(["Codex", "Claude Desktop Code"]))
        self.provider.connect("notify::selected", self.provider_changed)
        self.provider_fixed = Adw.ActionRow(title="App")
        self.provider_fixed.add_suffix(label("OpenCode"))
        self.enabled = Adw.SwitchRow(title="Enabled", subtitle="Show the chats of this profile on the board.")
        for row in (self.name, self.provider, self.provider_fixed, self.enabled):
            fields.add(row)
        self.bridge_group = group("ASB Bridge")
        self.bridge_row = Adw.ActionRow(use_markup=False)
        self.bridge_row.set_subtitle_lines(0)
        self.bridge_icon = Gtk.Image()
        self.bridge_row.add_prefix(self.bridge_icon)
        self.install_button = Gtk.Button(valign=Gtk.Align.CENTER)
        self.install_button.connect("clicked", self.install_bridge)
        self.bridge_row.add_suffix(self.install_button)
        self.bridge_group.add(self.bridge_row)
        self.remote_claude = Adw.ComboRow(title="Remote Claude sessions", use_subtitle=True)
        self.remote_claude.set_model(Gtk.StringList.new([title for _value, title, _note in REMOTE_CLAUDE]))
        self.remote_claude.set_title_lines(0)
        self.remote_claude.set_subtitle_lines(0)
        self.remote_claude.update_property([Gtk.AccessibleProperty.LABEL], ["Remote Claude sessions"])
        self.bridge_group.add(self.remote_claude)
        self.remote_claude_note = self.text(REMOTE_CLAUDE[0][2])
        self.remote_claude_note.add_css_class("dim-label")
        self.remote_claude_note.set_wrap_mode(Pango.WrapMode.WORD)
        self.remote_claude_note.set_natural_wrap_mode(Gtk.NaturalWrapMode.NONE)
        self.remote_claude_note.set_xalign(0)
        self.bridge_group.add(self.remote_claude_note)
        # The install result is the last item, so the note stays right under its row.
        self.install_result = self.text("")
        self.bridge_group.add(self.install_result)
        self.remote_claude.connect("notify::selected", self.remote_claude_changed)
        self.files_group = group("Files")
        self.data_dir, self.launcher, self.projects_dir = (Adw.EntryRow(title=title)
            for title in ("Session folder", "Open with", "Transcript folder"))
        self.choose_buttons, self.fixed_provider = [], ""
        for entry, icon, title, folder in ((self.data_dir, "folder-open-symbolic", "Choose session folder", True),
                (self.launcher, "document-open-symbolic", "Choose app launcher", False),
                (self.projects_dir, "folder-open-symbolic", "Choose transcript folder", True)):
            choose = Gtk.Button(icon_name=icon, tooltip_text=title, valign=Gtk.Align.CENTER)
            choose.add_css_class("flat")
            choose.update_property([Gtk.AccessibleProperty.LABEL], [title])
            choose.connect("clicked", lambda _button, entry=entry, folder=folder, title=title: self.choose_path(entry, folder, title))
            entry.add_suffix(choose)
            if entry is not self.projects_dir:
                self.choose_buttons.append(choose)
        self.launcher_fixed = Adw.ActionRow(title="Open with", subtitle="Not used: OpenCode cannot open one session from a link.")
        self.launcher_fixed.set_subtitle_lines(0)
        for row in (self.data_dir, self.launcher, self.launcher_fixed, self.projects_dir):
            self.files_group.add(row)
        self.transcript_widgets = [self.projects_dir, self.remote_claude, self.remote_claude_note]
        colors = group("Color and dot")
        self.color_row = Adw.ActionRow(title="Profile color")
        presets = Gtk.Box(spacing=4, valign=Gtk.Align.CENTER)
        for name, color in SOURCE_COLOR_PRESETS:
            marker = SourceMarker(self.owner, color)
            marker.set_valign(Gtk.Align.CENTER)
            marker.add_css_class("asb-preset-swatch")
            self.preset_markers.append(marker)
            button = Gtk.Button(child=marker, valign=Gtk.Align.CENTER, tooltip_text=f"{name}: {color}")
            button.add_css_class("flat")
            button.add_css_class("circular")
            button.update_property([Gtk.AccessibleProperty.LABEL], [f"Use {name} profile color"])
            button.connect("clicked", lambda _button, value=color: self.source_color.set_rgba(self.owner.rgba(value)))
            presets.append(button)
        self.source_color = Gtk.ColorDialogButton.new(Gtk.ColorDialog(title="Profile color", with_alpha=False))
        self.source_color.set_valign(Gtk.Align.CENTER)
        self.source_color.connect("notify::rgba", self.color_changed)
        presets.append(self.source_color)
        self.color_row.add_suffix(presets)
        colors.add(self.color_row)
        self.show_marker = Adw.SwitchRow(title="Show profile dot")
        colors.add(self.show_marker)
        identity = group()
        self.source_id = self.text("")
        self.source_id.add_css_class("dim-label")
        self.source_status = self.text("")
        self.remove_button = Gtk.Button(label="Remove profile", halign=Gtk.Align.START)
        self.remove_button.add_css_class("destructive-action")
        self.remove_button.connect("clicked", self.remove_source)
        for widget in (self.source_id, self.source_status, self.remove_button):
            identity.add(widget)
        for entry in (self.name, self.data_dir, self.launcher, self.projects_dir):
            entry.connect("changed", self.form_changed)
        for check in (self.enabled, self.show_marker):
            check.connect("notify::active", self.form_changed)
        toolbar.set_content(self.form)
        if modern:
            self.dialog.set_child(toolbar)
            self.form.get_first_child().set_propagate_natural_height(True)
        else:
            self.dialog.set_content(toolbar)
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.dialog_key)
        self.dialog.add_controller(keys)

    def present_dialog(self):
        if hasattr(Adw, "Dialog"):
            # A narrow Preferences gets a full-height dialog, so the dialog top is the same for each profile.
            narrow = self.preferences.get_current_breakpoint() is self.preferences.breakpoint
            self.dialog.set_content_height(self.preferences.get_height() if narrow else -1)
            self.dialog.present(self.preferences)
        else:
            self.dialog.present()

    def dialog_key(self, _controller, key, _code, modifiers):
        if key == Gdk.KEY_Escape and not modifiers & SHORTCUT_MASK:
            # A running save or remove keeps the dialog open for its reply.
            if not self.saving:
                self.cancel_form()
            return True
        return False

    def end_edit(self, *_args):
        if self.editing:
            self.editing, self.editing_id = False, ""
            self.form_baseline = self.baseline_source = self.edit_revision = None
            self.conflict = False
            self.cancel_dialogs()
            self.update_controls()
            self.form_changed()
        return False

    def color_changed(self, *_args):
        self.color_row.set_subtitle(self.owner.hex_color(self.source_color.get_rgba()))
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
        if not active and previous:
            self.bridge_generation += 1
            self.bridge_loading, self.bridge_queued = False, None
        if active and not previous:
            # Libadwaita 1.4: Preferences hid the dialog window with the draft; show it again.
            if self.editing and self.dialog is not None and not hasattr(Adw, "Dialog"):
                self.dialog.present()
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

    def update_controls(self):
        busy = self.loading or self.choosing or self.saving
        form_busy = self.choosing or self.saving or self.loading and not self.loaded
        self.table.set_sensitive(self.loaded and not form_busy)
        self.add_button.set_sensitive(self.loaded and not busy and len(self.sources) < self.max_sources)
        self.reload_button.set_sensitive(not busy)
        self.table.update_state([Gtk.AccessibleState.BUSY], [busy])
        if self.dialog is None:
            return
        current = next((source for source in self.sources if source["id"] == self.editing_id), {})
        self.form.set_sensitive(self.editing and not form_busy)
        self.provider.set_sensitive(not current.get("builtin"))
        for button in self.choose_buttons:
            button.set_sensitive(not self.fixed_provider)
        self.save_button.set_sensitive(self.loaded and self.editing and not busy)
        self.cancel_button.set_sensitive(self.loaded and self.editing and not busy)
        self.remove_button.set_sensitive(self.loaded and not busy and bool(current) and not current.get("builtin"))
        self.install_button.set_sensitive(not self.installing)
        if hasattr(Adw, "Dialog"):
            self.dialog.set_can_close(not self.saving)

    def provider_changed(self, *_args):
        claude = self.provider.get_selected() == 1 and not self.fixed_provider
        for widget in self.transcript_widgets:
            widget.set_visible(claude)
        if self.fixed_provider:
            description = None
        else:
            builtin = bool(next((source for source in self.sources if source["id"] == self.editing_id), {}).get("builtin"))
            description = ("Choose the app profile folder with claude-code-sessions or Cache." if claude
                           else "Choose CODEX_HOME, such as ~/.codex-personal.")
            description += (" Leave Open with empty to use the default app." if builtin
                            else " Added profiles need an installed app launcher.")
            if claude:
                description += " An empty Transcript folder uses ~/.claude/projects."
        self.files_group.set_description(description)
        self.update_bridge_row()
        self.form_changed()

    def set_source_status(self, source):
        status = source.get("status", "").capitalize()
        if source.get("message"):
            status += ": " + source["message"]
        parts = [status, "Default profile: you can edit or turn it off. You cannot remove it." if source.get("builtin") else ""]
        status = " ".join(part.rstrip(". ") + "." for part in parts if part.rstrip(". "))
        self.source_status.set_label(status)
        self.source_status.set_visible(bool(status))

    def set_form(self, source=None):
        self.ensure_dialog()
        source = source or {}
        self.setting_form = True
        self.editing, self.editing_id = True, source.get("id", "")
        self.dialog_title.set_title(source.get("label") or "New profile")
        self.dialog_title.set_subtitle(profile_subtitle(source) if self.editing_id else "")
        self.save_button.set_label("Save" if self.editing_id else "Add")
        self.remove_button.set_visible(bool(self.editing_id) and not source.get("builtin"))
        self.show_message("", dialog=True)
        self.install_result.set_label("")
        self.install_result.set_visible(False)
        self.install_result.remove_css_class("monospace")
        self.source_id.set_label("ID: " + (self.editing_id or "Assigned when saved"))
        self.source_id.set_visible(True)
        provider = source.get("provider", "codex")
        # The default OpenCode source keeps its app, folder, and empty launcher.
        self.fixed_provider = provider if provider not in SOURCE_PROVIDERS else ""
        self.provider.set_visible(not self.fixed_provider)
        self.provider_fixed.set_visible(bool(self.fixed_provider))
        self.launcher_fixed.set_visible(bool(self.fixed_provider))
        self.launcher.set_visible(not self.fixed_provider)
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
            accessible.update_property([Gtk.AccessibleProperty.LABEL], ["Profile color for " + source.get("label", "new profile")])
        self.color_changed()
        self.set_source_status(source)
        self.provider_changed()
        self.form_baseline = self.form_values()
        self.baseline_source = dict(source) if self.editing_id else None
        self.edit_revision = getattr(self, "revision", None)
        self.conflict = self.setting_form = False
        self.update_controls()
        self.form_changed()

    def open_source(self, source):
        if self.closed or self.saving or self.choosing or self.loading and not self.loaded:
            return
        self.show_feedback("")
        self.set_form(source)
        self.present_dialog()

    def render_sources(self, preferred="", preserve_form=False):
        focus = self.preferences.get_focus()
        current = next((source for source in self.sources if source["id"] == preferred), None)
        keep_form = False
        if preserve_form and self.editing:
            unchanged = source_edit_values(current) == source_edit_values(self.baseline_source)
            keep_form = not self.editing_id or unchanged or self.is_dirty() or self.choosing
            if not self.editing_id or unchanged:
                self.edit_revision, self.conflict = self.revision, False
            elif keep_form:
                self.conflict = True
                self.show_message(PROFILE_CONFLICT, dialog=True)
        existing = {}
        child = self.table.get_first_child()
        while child:
            following = child.get_next_sibling()
            existing[child.asb_source["id"]] = child
            child = following
        self.table_markers = []
        for index, source in enumerate(self.sources):
            row = existing.pop(source["id"], None)
            app = self.bridge_apps.get(source["id"]) if self.bridge_apps is not None else None
            if row is None:
                row = self.make_row()
            # One row object per source ID keeps the keyboard focus and the focus that a closed dialog gives back.
            if row.asb_source != source or row.asb_bridge != app or row.asb_bridge_known != (self.bridge_apps is not None):
                self.update_row(row, source, app)
            self.table_markers.append(row.asb_marker)
            if self.table.get_row_at_index(index) is not row:
                if row.get_parent() is self.table:
                    self.table.remove(row)
                self.table.insert(row, index)
        for row in existing.values():
            self.table.remove(row)
        if focus is not None and focus.get_parent() is self.table and self.preferences.get_focus() is not focus:
            focus.grab_focus()
        self.bridge_header.set_visible(self.bridge_apps is not None)
        self.queue_align()
        self.count.set_label(f"{len(self.sources)} of {self.max_sources} profiles" if self.loaded else "")
        if preserve_form and self.editing:
            if keep_form:
                if current:
                    self.dialog_title.set_subtitle(profile_subtitle(current))
                    self.set_source_status(current)
                self.update_bridge_row()
            elif current:
                self.set_form(current)
            else:
                self.cancel_form()

    def make_row(self):
        row = Adw.ActionRow(activatable=True, use_markup=False)
        row.set_title_lines(0)
        row.set_subtitle_lines(0)
        row.asb_marker = SourceMarker(self.owner, "")
        row.asb_marker.set_valign(Gtk.Align.CENTER)
        row.add_prefix(row.asb_marker)
        # The row keeps this box; an update changes only its children.
        row.asb_state = Gtk.Box(spacing=6, valign=Gtk.Align.CENTER)
        row.add_suffix(row.asb_state)
        row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
        row.asb_source = row.asb_bridge = row.asb_state_label = row.asb_state_icon = None
        row.asb_bridge_known = None
        return row

    def update_row(self, row, source, app):
        row.set_title(source["label"])
        row.set_subtitle(profile_subtitle(source))
        row.asb_marker.set_color(source.get("color", ""))
        for widget in (row.asb_state_icon, row.asb_state_label):
            if widget is not None:
                row.asb_state.remove(widget)
        row.asb_state_icon = row.asb_state_label = None
        state_text = ""
        if self.bridge_apps is not None:
            if not source["enabled"]:
                state_text = "Off"
            elif app is not None:
                state_text, icon, css = BRIDGE_STATES.get(app["state"], BRIDGE_STATES["unknown"])
                row.asb_state_icon = Gtk.Image(icon_name=icon)
                row.asb_state_icon.add_css_class(css)
                row.asb_state.append(row.asb_state_icon)
            if state_text:
                state_label = label(state_text, "dim-label")
                state_label.set_wrap(True)
                state_label.set_wrap_mode(Pango.WrapMode.WORD)
                state_label.set_natural_wrap_mode(Gtk.NaturalWrapMode.NONE)
                state_label.set_xalign(1)
                state_label.set_justify(Gtk.Justification.RIGHT)
                row.asb_state_label = state_label
                row.asb_state.append(state_label)
        row.asb_state.set_visible(bool(state_text))
        (row.remove_css_class if source["enabled"] else row.add_css_class)("dim-label")
        row.update_property([Gtk.AccessibleProperty.DESCRIPTION],
            [(f"ASB Bridge: {state_text}. " if state_text else "") + "Profile color: " + row.asb_marker.configured_color])
        row.asb_source, row.asb_bridge = source, app
        row.asb_bridge_known = self.bridge_apps is not None

    def queue_align(self, *_args):
        # Only a shown header measures; its map signal starts the measure again after a hidden render.
        if self.bridge_apps is not None and self.header_tick is None and self.bridge_header.get_mapped():
            self.header_tick = self.bridge_header.add_tick_callback(self.align_header)

    def align_header(self, *_args):
        # Theme fonts change the row padding; the header ends where the first state text ends.
        state = next((row.asb_state_label for row in self.rows() if row.asb_state_label is not None
                      and row.asb_state_label.get_mapped() and row.asb_state_label.get_width() > 0), None)
        if state is None:
            if self.bridge_header.get_mapped() and any(row.asb_state_label is not None for row in self.rows()):
                return True
            self.header_tick = None
            return False
        found, bounds = state.compute_bounds(self)
        if found:
            self.bridge_header.set_margin_end(max(0, round(self.get_width() - bounds.get_x() - bounds.get_width())))
        self.header_tick = None
        return False

    def rows(self):
        row = self.table.get_first_child()
        while row:
            yield row
            row = row.get_next_sibling()

    def dialog_closed(self, *_args):
        if self.saving:
            return True
        self.end_edit()
        index, self.focus_after_close = self.focus_after_close, None
        if index is not None:
            count = len(self.sources)
            row = self.table.get_row_at_index(min(index, count - 1)) if count else None
            (row or self.add_button).grab_focus()
        return False

    def update_bridge_row(self):
        if self.dialog is None:
            return
        source = next((source for source in self.sources if source["id"] == self.editing_id), None)
        app = self.bridge_apps.get(self.editing_id) if self.bridge_apps is not None else None
        disabled = source is not None and not source["enabled"] and self.bridge_apps is not None
        visible = bool(self.editing_id and (disabled or app is not None))
        self.bridge_row.set_visible(visible)
        self.bridge_icon.set_visible(visible and not disabled)
        action = None
        if disabled:
            self.bridge_row.set_title("Not checked")
            self.bridge_row.set_subtitle("ASB checks ASB Bridge only for enabled profiles.")
        elif app is not None:
            self.bridge_row.set_title(bridge_state_line(app))
            self.bridge_row.set_subtitle(bridge_detail(app) or "")
            _text, icon, css = BRIDGE_STATES.get(app["state"], BRIDGE_STATES["unknown"])
            self.bridge_icon.set_from_icon_name(icon)
            for name in ("success", "warning", "error", "dim-label"):
                self.bridge_icon.remove_css_class(name)
            self.bridge_icon.add_css_class(css)
            action = bridge_action(app)
        self.install_button.set_visible(bool(action) and visible)
        self.install_button.set_label("Installing…" if self.installing == self.editing_id else action or "Install")
        self.install_button.set_sensitive(not self.installing)
        self.bridge_group.set_visible(visible or self.remote_claude.get_visible() or self.install_result.get_visible())

    def request_bridge(self, refresh=False):
        if not self.active or self.closed or self.owner.closed:
            return
        if self.bridge_loading:
            self.bridge_queued = bool(self.bridge_queued) or refresh
            return
        self.bridge_loading = True
        generation = self.bridge_generation
        def finished(result, error):
            if self.closed or self.owner.closed or not self.active or generation != self.bridge_generation:
                return False
            self.bridge_loading = False
            if not error and not bridge_valid(result):
                error = "The ASB Bridge response is not valid. Try again."
            if error:
                if refresh:
                    self.show_message(error)
            else:
                self.bridge_apps = bridge_self_apps(result)
                self.render_sources(self.editing_id, preserve_form=True)
            queued, self.bridge_queued = self.bridge_queued, None
            if queued is not None:
                self.request_bridge(queued)
            return False
        request_async(self.base, "/api/bridge" + ("?refresh=1" if refresh else ""), finished, GLib.idle_add)

    def install_bridge(self, *_args):
        app = self.bridge_apps.get(self.editing_id) if self.bridge_apps is not None else None
        action = bridge_action(app) if app is not None else None
        if self.closed or self.installing or not self.editing or not action:
            return
        identity = self.installing = self.editing_id
        self.install_result.set_visible(False)
        self.install_result.remove_css_class("monospace")
        self.update_bridge_row()
        def finished(result, error):
            if self.closed or self.owner.closed:
                return False
            self.installing = ""
            failed = not error and isinstance(result, dict) and result.get("ok") is False
            if error:
                text = error
            elif failed:
                text = BRIDGE_INSTALL_FAILED + "\n" + "\n".join(str(result.get("output", "")).splitlines()[-12:])
            elif isinstance(result, dict) and result.get("ok") is True:
                text = "Installed." if action == "Install" else "Updated."
            else:
                text = "The ASB Bridge response is not valid. Try again."
            if self.editing and self.editing_id == identity:
                self.install_result.set_label(text)
                self.install_result.set_visible(True)
                (self.install_result.add_css_class if failed else self.install_result.remove_css_class)("monospace")
                self.update_bridge_row()
            else:
                self.show_feedback(text)
            self.request_bridge()
            return False
        request_async(self.base, "/api/bridge/install", finished, GLib.idle_add, "POST", {"sourceId": identity})

    def request_sources(self, route="/api/sources", method="GET", body=None):
        if self.closed or self.owner.closed:
            return
        if self.loading or self.choosing:
            if method == "GET":
                self.refresh_queued = True
            return
        self.refresh_queued = False
        self.loading = True
        self.saving = method == "POST"
        refresh_bridge, self.bridge_refresh = self.bridge_refresh, False
        if method == "POST":
            self.show_message("Saving…" if body else "Removing…", dialog=True)
        elif not self.loaded:
            self.show_message("Loading profiles…")
        self.update_controls()
        def finished(result, error):
            if self.closed or self.owner.closed:
                return False
            self.loading = False
            self.saving = False
            # The dialog may close again (Adw.Dialog can-close) before the render below.
            self.update_controls()
            if not error and (not isinstance(result, dict) or not isinstance(result.get("sources"), list)):
                error = "The profile list is not valid. Refresh the list, then try again."
            if error:
                if method == "GET":
                    self.observed_revision = None
                    self.refresh_queued = False
                self.show_message(error, dialog=method == "POST")
            else:
                if method == "POST" and not body:
                    self.focus_after_close = next((index for index, source in enumerate(self.sources)
                                                   if source["id"] == self.editing_id), None)
                self.sources, self.loaded = result["sources"], True
                self.revision = source_revision(result.get("revision"))
                self.max_sources = result.get("maxSources", self.max_sources)
                if method == "GET":
                    self.render_sources(self.editing_id, preserve_form=True)
                    if not self.feedback:
                        self.show_message("")
                    self.request_bridge(refresh_bridge)
                else:
                    # The same row object gets the focus back when the dialog closes.
                    self.render_sources()
                    self.cancel_form()
                    self.show_feedback("Saved." if body else "Removed.")
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

    def refresh_sources(self, *_args):
        self.show_feedback("")
        self.bridge_refresh = True
        self.reload_sources()

    def add_source(self, *_args):
        if self.loading or self.choosing or not self.loaded or len(self.sources) >= self.max_sources:
            return
        self.show_feedback("")
        self.set_form()
        self.present_dialog()
        self.name.grab_focus()

    def cancel_form(self, *_args):
        if self.saving:
            return
        self.end_edit()
        if self.dialog is not None:
            self.dialog.close()

    def save_source(self, *_args):
        if self.closed or self.loading or self.choosing or not self.loaded or not self.editing:
            return
        if getattr(self, "conflict", False):
            self.show_message(PROFILE_CONFLICT, dialog=True)
            return
        try:
            body = source_form_body(self.fixed_provider or SOURCE_PROVIDERS[self.provider.get_selected()], self.name.get_text(),
                                    self.data_dir.get_text(), self.launcher.get_text(), self.enabled.get_active(),
                                    self.editing_id, self.projects_dir.get_text(),
                                    self.owner.hex_color(self.source_color.get_rgba()), self.show_marker.get_active(),
                                    remote_claude=REMOTE_CLAUDE[self.remote_claude.get_selected()][0])
        except ValueError as error:
            self.show_message(str(error), dialog=True)
            return
        self.request_sources("/api/sources", "POST", body)

    def remove_source(self, *_args):
        if getattr(self, "conflict", False):
            self.show_message("This profile changed outside this dialog. Select Cancel and open the profile again before you remove it.", dialog=True)
            return
        current = next((source for source in self.sources if source["id"] == self.editing_id), {})
        if current and not current.get("builtin"):
            self.request_sources("/api/sources/" + quote(self.editing_id, safe="") + "/remove", "POST", {})

    def choose_path(self, entry, folder, title):
        if self.closed or self.loading or self.choosing:
            return
        self.choosing = True
        self.update_controls()
        dialog = Gtk.FileDialog(title=title)
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
                    self.show_message("Cannot select this path. Enter its local path, then try again.", dialog=True)
            except ValueError as error:
                self.show_message(str(error), dialog=True)
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
        if self.dialog is not None:
            if hasattr(Adw, "Dialog"):
                self.dialog.force_close()
            else:
                self.dialog.destroy()


class PhoneEditor(Gtk.Box):
    def __init__(self, owner, preferences):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.owner, self.preferences, self.base = owner, preferences, owner.base
        self.closed = self.active = self.loaded = self.loading = self.poll_loading = False
        self.generation, self.poll_timer, self.form_loaded = 0, None, None
        self.status, self.address_checks, self.remove_buttons, self.devices_shown = {}, {}, [], None
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
        self.qr_help = label(QR_HELP, "caption")
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
        # The pairing poll every 3 s must not make the same rows again: that drops the keyboard focus of a Remove button.
        shown = tuple((device["id"], device["name"], device.get("createdAtMs"), device.get("lastSeenAtMs")) for device in status["devices"])
        if shown != self.devices_shown:
            self.devices_shown = shown
            self.render_devices(status["devices"])
        self.empty.set_visible(not status["devices"])
        self.devices.set_visible(bool(status["devices"]))

    def render_devices(self, devices):
        child = self.devices.get_first_child()
        while child:
            self.devices.remove(child)
            child = self.devices.get_first_child()
        self.remove_buttons = []
        for device in devices:
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
        self.bridge, self.bridge_loading = None, False
        self.group, self.view, self.summary = {}, machines_view({}), None
        self.invite_link, self.invite_expires, self.invite_ids, self.matrix = "", 0, set(), None
        self.remove_buttons, self.rows_shown = [], None
        self.body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, visible=False)
        self.off = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        self.off.append(self.text(MACHINE_OFF, "warning"))
        phone = Gtk.Button(label="Open Phone settings", halign=Gtk.Align.START, valign=Gtk.Align.CENTER)
        phone.connect("clicked", lambda *_args: self.preferences.show_section("phone"))
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
        self.qr_help = self.text(QR_HELP)
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
                if hasattr(Adw, "AlertDialog"):
                    self.dialog.force_close()
                else:
                    # An Adw.MessageDialog is a window: destroy() closes it with no response.
                    self.dialog.destroy()
                    self.dialog = None
            self.generation += 1
            self.loading = self.poll_loading = self.bridge_loading = False
            if self.poll_timer:
                GLib.source_remove(self.poll_timer)
            self.poll_timer = None
            self.close_invite()
        else:
            # Members change while the page is hidden, so each open reads the group again; a poll keeps the panels.
            self.request_group()
            self.request_bridge()
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
        self.self_row.set_subtitle("ID " + own["machineId"][:8] + self.bridge_suffix(is_self=True))
        self.off.set_visible(self.view["off"])
        grouped, others = self.view["grouped"], self.view["others"]
        now_ms = time.time() * 1000
        rows = [(member["machineId"], member["name"], machine_member_subtitle(member, now_ms) + self.bridge_suffix(member["machineId"]), bool(member.get("online")))
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

    def bridge_suffix(self, identity="", is_self=False):
        machines = self.bridge["machines"] if self.bridge is not None else []
        machine = next((machine for machine in machines
                        if (machine["isSelf"] if is_self else machine.get("machineId") == identity)), None)
        return "\n" + machine_bridge_line(machine) if machine is not None else ""

    def request_bridge(self):
        if not self.active or self.closed or self.owner.closed or self.bridge_loading:
            return
        self.bridge_loading = True
        generation = self.generation
        def finished(result, error):
            if self.closed or self.owner.closed or not self.active or generation != self.generation:
                return False
            self.bridge_loading = False
            if not error and bridge_valid(result):
                self.bridge = result
                if self.loaded:
                    self.render(self.group)
            return False
        request_async(self.base, "/api/bridge", finished, GLib.idle_add)

    def request_group(self, route="/api/group", method="GET", body=None, poll=False, feedback="", done=None):
        """A GET renders the group and shows feedback; a POST calls done with the reply."""
        if self.closed or self.owner.closed or not self.active or self.loading or (poll and self.poll_loading):
            return
        if poll:
            self.poll_loading = True
        else:
            self.generation += 1
            self.bridge_loading = False
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
        self.request_bridge()
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
        # Libadwaita 1.4 has no Adw.AlertDialog: Adw.MessageDialog has the same responses.
        modern = hasattr(Adw, "AlertDialog")
        dialog = (Adw.AlertDialog(heading=heading, body=body) if modern
                  else Adw.MessageDialog(transient_for=self.preferences, modal=True, heading=heading, body=body))
        dialog.add_response("cancel", "Cancel")
        dialog.add_response(response, response.capitalize())
        dialog.set_response_appearance(response, Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        def chosen(_dialog, choice):
            if choice == response and self.active and self.loaded and not self.loading:
                clicked()
        dialog.connect("response", chosen)
        # An Adw.MessageDialog closes itself after a response and has no closed signal.
        dialog.connect("closed" if modern else "response",
                       lambda closed, *_args: setattr(self, "dialog", None) if self.dialog is closed else None)
        self.dialog = dialog
        if modern:
            dialog.present(self.preferences)
        else:
            dialog.present()

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


class UsageBackupEditor(Gtk.Box):
    def __init__(self, owner, preferences):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.owner, self.preferences, self.base = owner, preferences, owner.base
        self.closed = self.active = self.loaded = self.loading = False
        self.generation, self.status, self.folder, self.refresh_timer = 0, {}, "", None
        self.cancellable = Gio.Cancellable()
        self.settings = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.settings.add_css_class("boxed-list")
        self.enabled = Adw.SwitchRow(title="Daily backup", subtitle="Saves the usage of every machine in the group to one file a day.")
        self.enabled.set_subtitle_lines(0)
        self.time_row = Adw.ActionRow(title="Time")
        clock = Gtk.Box(spacing=4, valign=Gtk.Align.CENTER)
        self.hour = Gtk.SpinButton.new_with_range(0, 23, 1)
        self.minute = Gtk.SpinButton.new_with_range(0, 59, 1)
        for spin, name in ((self.hour, "Backup hour"), (self.minute, "Backup minute")):
            spin.set_numeric(True)
            spin.set_wrap(True)
            spin.set_width_chars(2)
            spin.set_valign(Gtk.Align.CENTER)
            spin.connect("output", self.two_digits)
            spin.update_property([Gtk.AccessibleProperty.LABEL], [name])
        clock.append(self.hour)
        clock.append(Gtk.Label(label=":"))
        clock.append(self.minute)
        self.time_row.add_suffix(clock)
        self.time_row.set_activatable_widget(self.hour)
        self.keep = Adw.SpinRow.new_with_range(1, 30, 1)
        self.keep.set_title("Files to keep")
        self.keep.set_subtitle("Older backup files of this machine are deleted.")
        self.keep.set_subtitle_lines(0)
        self.folder_row = Adw.ActionRow(title="Folder", use_markup=False)
        self.open_folder = Gtk.Button(icon_name="folder-open-symbolic", valign=Gtk.Align.CENTER, tooltip_text="Open the folder")
        self.open_folder.add_css_class("flat")
        self.open_folder.update_property([Gtk.AccessibleProperty.LABEL], ["Open the backup folder"])
        self.open_folder.connect("clicked", self.open_backup_folder)
        self.change_folder = Gtk.Button(label="Change…", valign=Gtk.Align.CENTER)
        self.change_folder.connect("clicked", self.choose_folder)
        self.folder_row.add_suffix(self.open_folder)
        self.folder_row.add_suffix(self.change_folder)
        self.default_row = Adw.ActionRow(title="Default folder", use_markup=False, visible=False)
        self.use_default = Gtk.Button(label="Use", valign=Gtk.Align.CENTER)
        self.use_default.update_property([Gtk.AccessibleProperty.LABEL], ["Use the default folder"])
        self.use_default.connect("clicked", lambda *_args: self.set_folder(""))
        self.default_row.add_suffix(self.use_default)
        for row in (self.enabled, self.time_row, self.keep, self.folder_row, self.default_row):
            self.settings.append(row)
        self.append(self.settings)
        actions = Gtk.Box(spacing=8)
        self.apply = Gtk.Button(label="Apply")
        self.apply.connect("clicked", self.apply_settings)
        actions.append(self.apply)
        self.retry = Gtk.Button(label="Retry", visible=False)
        self.retry.connect("clicked", lambda *_args: self.request_backup())
        actions.append(self.retry)
        self.append(actions)
        self.message = label("Loading usage backups…", "warning")
        self.message.set_wrap(True)
        self.message.set_selectable(True)
        self.message.set_max_width_chars(64)
        self.append(self.message)
        self.append(label("Backups", "heading"))
        self.next_label = label("", "caption")
        self.next_label.set_wrap(True)
        self.append(self.next_label)
        self.error_label = label("", "warning")
        self.error_label.set_wrap(True)
        self.error_label.set_selectable(True)
        self.error_label.set_visible(False)
        self.append(self.error_label)
        self.files = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE, visible=False)
        self.files.add_css_class("boxed-list")
        self.append(self.files)
        self.files_empty = label("No backups yet.", "caption")
        self.append(self.files_empty)
        buttons = Gtk.Box(spacing=8)
        self.backup_now = Gtk.Button(label="Back up now")
        self.backup_now.connect("clicked", lambda *_args: self.request_backup("/api/usage/backup/now", "POST", {}))
        self.export_button = Gtk.Button(label="Export…")
        self.export_button.connect("clicked", self.export_usage)
        self.import_button = Gtk.Button(label="Import…")
        self.import_button.connect("clicked", self.import_usage)
        for button in (self.backup_now, self.export_button, self.import_button):
            buttons.append(button)
        self.append(buttons)
        note = label("Each file holds the usage of every machine in the group. Import it on any PC with ASB to see that usage there.", "caption")
        note.set_wrap(True)
        note.set_max_width_chars(64)
        self.append(note)
        self.update_controls()

    @staticmethod
    def two_digits(spin):
        spin.set_text(f"{spin.get_value_as_int():02d}")
        return True

    def set_active(self, active):
        active = bool(active and not self.closed and not self.owner.closed and not self.preferences.closed)
        if self.active == active:
            return
        self.active = active
        if not active:
            # Late replies, file jobs, and open dialogs of the hidden page do nothing.
            self.generation += 1
            self.loading = False
            self.cancellable.cancel()
            self.stop_refresh()
            self.update_controls()
        else:
            self.loaded = False
            self.request_backup()

    def update_controls(self):
        ready = self.loaded and not self.loading and not self.closed
        idle = not self.loading and not self.closed
        for widget in (self.settings, self.apply, self.backup_now):
            widget.set_sensitive(ready)
        for widget in (self.retry, self.export_button, self.import_button):
            widget.set_sensitive(idle)

    def form_path(self):
        return self.folder or self.status.get("defaultPath", "")

    def set_folder(self, folder):
        self.folder = folder
        path, default = self.form_path(), self.status.get("defaultPath", "")
        self.folder_row.set_subtitle(short_home_path(path, Path.home()))
        self.folder_row.set_tooltip_text(path or None)
        self.default_row.set_subtitle(short_home_path(default, Path.home()))
        self.default_row.set_tooltip_text(default or None)
        self.default_row.set_visible(folder != "")

    def render_status(self, status, sync_form):
        self.status, self.loaded = status, True
        if sync_form:
            self.enabled.set_active(status["enabled"])
            hour, minute = status["time"].split(":")
            self.hour.set_value(int(hour))
            self.minute.set_value(int(minute))
            self.keep.set_value(status["keep"])
            self.folder = status["folder"]
        self.set_folder(self.folder)
        now = time.time() * 1000
        self.next_label.set_label(backup_next_text(status, now))
        error = backup_error_text(status)
        self.error_label.set_label(error)
        self.error_label.set_visible(bool(error))
        child = self.files.get_first_child()
        while child:
            self.files.remove(child)
            child = self.files.get_first_child()
        for item in status["files"]:
            row = Adw.ActionRow(title=item["name"], subtitle=f"{backup_when(item['modifiedAtMs'], now)} · {backup_size(item['bytes'])}",
                                use_markup=False)
            row.set_title_lines(0)
            self.files.append(row)
        self.files.set_visible(bool(status["files"]))
        self.files_empty.set_visible(not status["files"])
        # The next backup text says today or tomorrow, and a new backup adds a file: read the status again at midnight and after the backup.
        self.stop_refresh()
        if self.active and not self.closed and status["enabled"] and status["nextAtMs"] is not None:
            self.refresh_timer = GLib.timeout_add(backup_refresh_delay(status["nextAtMs"], now), self.refresh_due)

    def stop_refresh(self):
        if self.refresh_timer is not None:
            GLib.source_remove(self.refresh_timer)
            self.refresh_timer = None

    def refresh_due(self):
        self.refresh_timer = None
        self.request_backup()
        return False

    def request_backup(self, route="/api/usage/backup", method="GET", body=None):
        if self.closed or self.owner.closed or not self.active or self.loading or (method == "POST" and not self.loaded):
            return
        self.generation += 1
        self.loading = True
        self.message.set_label({"/api/usage/backup/settings": "Saving…", "/api/usage/backup/now": "Backing up…"}.get(route, "Loading usage backups…"))
        self.retry.set_visible(False)
        self.update_controls()
        generation = self.generation
        def finished(result, error):
            if self.closed or self.owner.closed or not self.active or generation != self.generation:
                return False
            self.loading = False
            made = route == "/api/usage/backup/now"
            if not error and (not backup_status_valid(result) or made and "made" not in result):
                error = "The usage backup response is not valid. Try again."
            if error:
                self.message.set_label(error)
                self.retry.set_visible(not self.loaded)
            else:
                saved = route == "/api/usage/backup/settings"
                # Back up now keeps the form edits; a load or a save shows the saved settings.
                self.render_status(result, not self.loaded or saved)
                self.message.set_label("Saved." if saved else backup_made_text(result["made"], result["made"]["name"]) if made else "")
            self.update_controls()
            return False
        request_async(self.base, route, finished, GLib.idle_add, method, body)

    def apply_settings(self, *_args):
        self.hour.update()
        self.minute.update()
        self.keep.update()
        self.request_backup("/api/usage/backup/settings", "POST", backup_settings_body(
            self.enabled.get_active(), self.hour.get_value_as_int(), self.minute.get_value_as_int(), int(self.keep.get_value()), self.folder))

    def new_cancellable(self):
        if self.cancellable.is_cancelled():
            self.cancellable = Gio.Cancellable()
        return self.cancellable

    @staticmethod
    def dismissed(error):
        return error.matches(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED) or error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED)

    def choose(self, start, finish, local_text, chosen):
        """Run a file dialog as the job of the page: the controls stay off until it closes."""
        if self.closed or not self.active or self.loading:
            return
        self.loading = True
        self.update_controls()
        cancellable = self.new_cancellable()
        def finished(chooser, result):
            if self.closed or not self.active or cancellable.is_cancelled():
                return
            self.loading = False
            try:
                path = getattr(chooser, finish)(result).get_path()
                if not path:
                    self.message.set_label(local_text)
            except GLib.Error as error:
                path = None
                if not self.dismissed(error):
                    self.message.set_label("Cannot use this choice. Try again.")
            self.update_controls()
            if path:
                chosen(path)
        start(self.preferences, cancellable, finished)

    def choose_folder(self, *_args):
        if not self.loaded:
            return
        dialog = Gtk.FileDialog(title="Choose the backup folder")
        initial = self.form_path()
        if initial and os.path.isdir(initial):
            dialog.set_initial_folder(Gio.File.new_for_path(initial))
        self.choose(dialog.select_folder, "select_folder_finish", "Choose a local folder.", self.set_folder)

    def open_backup_folder(self, *_args):
        if self.closed or not self.active or not self.loaded or self.loading:
            return
        self.loading = True
        self.update_controls()
        path = self.status["path"] if self.folder == self.status["folder"] else self.form_path()
        cancellable = self.new_cancellable()
        def finished(launcher, result):
            if self.closed or cancellable.is_cancelled():
                return
            self.loading = False
            try:
                launcher.launch_finish(result)
            except GLib.Error as error:
                if not self.dismissed(error):
                    self.message.set_label("Cannot open the folder.")
            self.update_controls()
        Gtk.FileLauncher.new(Gio.File.new_for_path(path)).launch(self.preferences, cancellable, finished)

    def run_file_job(self, job, path, text):
        if self.closed or not self.active or self.loading:
            return
        self.generation += 1
        self.loading = True
        self.message.set_label(text)
        self.update_controls()
        generation, base = self.generation, self.base
        def finished(message, error):
            if self.closed or self.owner.closed or not self.active or generation != self.generation:
                return False
            self.loading = False
            self.message.set_label(error or message)
            self.update_controls()
            return False
        def work():
            try:
                message, error = job(base, path), None
            except RuntimeError as failure:
                message, error = None, str(failure)
            GLib.idle_add(finished, message, error)
        threading.Thread(target=work, daemon=True).start()

    def export_usage(self, *_args):
        dialog = Gtk.FileDialog(title="Export usage", initial_name=usage_export_name(time.time() * 1000))
        self.choose(dialog.save, "save_finish", "Choose a local file.",
                    lambda path: self.run_file_job(export_usage_file, path, "Exporting…"))

    def import_usage(self, *_args):
        dialog = Gtk.FileDialog(title="Import usage")
        usage_files = Gtk.FileFilter(name="ASB usage files")
        usage_files.add_pattern("*.json")
        all_files = Gtk.FileFilter(name="All files")
        all_files.add_pattern("*")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        filters.append(usage_files)
        filters.append(all_files)
        dialog.set_filters(filters)
        dialog.set_default_filter(usage_files)
        self.choose(dialog.open, "open_finish", "Choose a local file.",
                    lambda path: self.run_file_job(import_usage_file, path, "Importing…"))

    def close(self):
        self.set_active(False)
        self.stop_refresh()
        self.closed = True


class PreferencesWindow(Adw.Window):
    def __init__(self, owner, sessions, appearance):
        super().__init__(application=owner.get_application(), transient_for=owner, destroy_with_parent=True,
                         title="Preferences", default_width=780, default_height=560)
        self.owner, self.closed, self.profiles_editor, self.phone_editor, self.machines_editor = owner, False, None, None, None
        self.usage_editor = None
        self.set_size_request(420, 360)
        self.add_css_class("asb-column-flow")
        self.add_css_class("asb-preferences")
        self.connect("close-request", self.on_close)
        self.connect("notify::visible", self.section_changed)
        self.connect("map", self.section_changed)
        self.connect("unmap", self.section_changed)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        header = Adw.HeaderBar()
        self.title = Adw.WindowTitle(title="Preferences")
        header.set_title_widget(self.title)
        self.back = Gtk.Button(icon_name="go-previous-symbolic", tooltip_text="Back", visible=False)
        self.back.add_css_class("flat")
        self.back.update_property([Gtk.AccessibleProperty.LABEL], ["Back"])
        self.back.connect("clicked", self.go_back)
        header.pack_start(self.back)
        body.append(header)
        self.stack = Gtk.Stack(vexpand=True, hexpand=True, hhomogeneous=False, vhomogeneous=False)
        self.sidebar = Gtk.StackSidebar(stack=self.stack)
        self.sidebar.set_size_request(150, -1)
        self.sidebar.add_css_class("asb-preferences-nav")
        layout = Gtk.Box()
        layout.append(self.sidebar)
        layout.append(self.stack)
        # Six tabs do not fit in 420 px, so the narrow layout shows a section list first.
        self.section_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE, valign=Gtk.Align.START,
                                        margin_start=20, margin_end=20, margin_top=20, margin_bottom=20)
        self.section_list.add_css_class("boxed-list")
        self.section_list.update_property([Gtk.AccessibleProperty.LABEL], ["Preferences sections"])
        self.section_list.connect("row-activated", lambda _list, row: self.show_section(row.get_title().lower()))
        self.pages = Gtk.Stack(vexpand=True)
        self.pages.add_named(Gtk.ScrolledWindow(child=self.section_list, hscrollbar_policy=Gtk.PolicyType.NEVER), "list")
        self.pages.add_named(layout, "section")
        self.pages.set_visible_child_name("section")
        self.pages.connect("notify::visible-child-name", self.section_changed)
        body.append(self.pages)
        self.profiles = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.phone = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.machines = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.usage = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        for title, content in (("Sessions", sessions), ("Appearance", appearance), ("Profiles", self.profiles), ("Phone", self.phone),
                               ("Machines", self.machines), ("Usage", self.usage)):
            page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16,
                           margin_top=20, margin_bottom=20, margin_start=20, margin_end=20)
            page.append(label(title, "title-2"))
            page.append(content)
            scroll = Gtk.ScrolledWindow(child=page, hscrollbar_policy=Gtk.PolicyType.NEVER,
                                       vscrollbar_policy=Gtk.PolicyType.AUTOMATIC)
            self.stack.add_titled(scroll, title.lower(), title)
            row = Adw.ActionRow(title=title, activatable=True)
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            self.section_list.append(row)
        self.stack.connect("notify::visible-child-name", self.section_changed)
        self.set_content(body)
        self.breakpoint = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 600px"))
        self.breakpoint.add_setter(self.sidebar, "visible", False)
        self.add_breakpoint(self.breakpoint)
        self.connect("notify::current-breakpoint", self.navigation_changed)
        self.stack.update_property([Gtk.AccessibleProperty.LABEL], ["Preferences sections"])
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.window_key)
        self.add_controller(keys)

    def section_changed(self, *_args):
        if not self.closed and self.stack.get_visible_child_name() == "profiles" and self.profiles_editor is None:
            self.profiles_editor = AppSourcesEditor(self.owner, self)
            self.profiles.append(self.profiles_editor)
        # The narrow section list covers the section page.
        shown = not self.closed and self.get_visible() and self.get_mapped() and self.pages.get_visible_child_name() == "section"
        section = self.stack.get_visible_child_name()
        if self.profiles_editor:
            self.profiles_editor.set_active(shown and section == "profiles")
        phone_visible = shown and section == "phone"
        if phone_visible and self.phone_editor is None:
            self.phone_editor = PhoneEditor(self.owner, self)
            self.phone.append(self.phone_editor)
        if self.phone_editor:
            self.phone_editor.set_active(phone_visible)
        machines_visible = shown and section == "machines"
        if machines_visible and self.machines_editor is None:
            self.machines_editor = MachinesEditor(self.owner, self)
            self.machines.append(self.machines_editor)
        if self.machines_editor:
            self.machines_editor.set_active(machines_visible)
        usage_visible = shown and section == "usage"
        if usage_visible and self.usage_editor is None:
            self.usage_editor = UsageBackupEditor(self.owner, self)
            self.usage.append(self.usage_editor)
        if self.usage_editor:
            self.usage_editor.set_active(usage_visible)
        self.owner.report_ui()

    def narrow(self):
        return self.get_current_breakpoint() is self.breakpoint

    def show_section(self, name):
        self.stack.set_visible_child_name(name)
        if self.narrow():
            self.title.set_title(self.stack.get_page(self.stack.get_visible_child()).get_title())
            self.back.set_visible(True)
            self.pages.set_visible_child_name("section")
            self.back.grab_focus()

    def show_list(self):
        self.title.set_title("Preferences")
        self.back.set_visible(False)
        self.pages.set_visible_child_name("list")

    def go_back(self, *_args):
        self.show_list()
        self.section_row().grab_focus()

    def section_row(self):
        row = self.section_list.get_first_child()
        while row and row.get_title().lower() != self.stack.get_visible_child_name():
            row = row.get_next_sibling()
        return row

    def navigation_changed(self, *_args):
        # The focused navigation hides, so the focus goes to the item of the shown section.
        focus = self.get_focus()
        if self.narrow():
            moved = focus and (focus is self.sidebar or focus.is_ancestor(self.sidebar))
            self.show_list()
            if moved:
                self.section_row().grab_focus()
            return
        moved = focus and (focus is self.back or focus.is_ancestor(self.section_list))
        self.title.set_title("Preferences")
        self.back.set_visible(False)
        self.pages.set_visible_child_name("section")
        if moved:
            rows = self.sidebar.get_first_child()
            while rows and not isinstance(rows, Gtk.ListBox):
                rows = rows.get_first_child()
            row = rows.get_selected_row() if rows else None
            if row:
                row.grab_focus()

    def window_key(self, _controller, key, _code, modifiers):
        if key == Gdk.KEY_Escape and not modifiers & SHORTCUT_MASK:
            editor = self.profiles_editor
            # Only a shown profile dialog takes Escape; a hidden 1.4 draft does not keep Preferences open.
            if editor and editor.editing and editor.dialog is not None and editor.dialog.get_mapped():
                return False
            if self.narrow() and self.pages.get_visible_child_name() == "section":
                self.go_back()
            else:
                self.close()
            return True
        return False

    def cancel_dialogs(self):
        if self.profiles_editor:
            self.profiles_editor.cancel_dialogs()
        for window in Gtk.Window.list_toplevels():
            if window.get_transient_for() is self:
                # The profile dialog keeps its draft while Preferences is hidden.
                if self.profiles_editor and window is self.profiles_editor.dialog:
                    window.set_visible(False)
                else:
                    window.close()

    def close(self):
        # Gtk.Window.close() closes an embedded Adw.Dialog first instead of hiding Preferences.
        self.on_close()

    def on_close(self, *_args):
        if self.profiles_editor:
            self.profiles_editor.set_active(False)
        if self.usage_editor:
            self.usage_editor.set_active(False)
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
        if self.usage_editor:
            self.usage_editor.close()
        self.cancel_dialogs()
        self.destroy()


class SwitchboardWindow(Adw.ApplicationWindow):
    drawer_view, drawer_peek, drawer_count, column_pixel_width = False, False, 0, DEFAULT_COLUMN_WIDTH
    wide_controls, tiny_controls, search_expanded = False, False, False
    card_limit, show_all_cards = DEFAULT_CARD_LIMIT, False
    copy_kind = "relative"
    pending, archived = False, False
    states, profiles = set(), set()
    filter_model = ()
    filter_popover_signature = None
    message_seen = None
    pending_messages = ()
    engine_generation = 0
    number_hold = number_idle = number_scroll = number_pressed = None
    row_cache_trim = None
    numbers_shown = False
    number_keys = open_popovers = ()

    def __init__(self, application, base, initial_dashboard=None, theme_path=THEME_PATH, layout_path=LAYOUT_PATH, first_load=None):
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
            self.card_limit = layout["cardLimit"]
            self.copy_kind = layout["copyKind"]
        except (OSError, ValueError) as error:
            self.column_width, self.view, self.copy_kind, layout_error = DEFAULT_COLUMN_WIDTH, "compact", "relative", str(error)
        self.pending, self.archived = False, False
        self.states, self.profiles = set(), set()
        self.filter_model = ()
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
        self.copy_wheel_state = dict(COPY_WHEEL_STATE)
        self.copy_hover = self.copy_rest_timer = self.copy_focus_button = None
        self.palette_sent = self.palette_wanted = None
        self.palette_sending = False
        # A replaced column stays alive: a card can keep a pointer into its internal list until the card is inserted again.
        self.list_columns, self.retired_columns = [], []
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
        if os.name == "nt":
            self.connect("realize", set_windows_icon)
        self.set_palette(None)
        self.refresh_button = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh sessions")
        self.refresh_button.connect("clicked", lambda *_: self.refresh(True))
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
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
        self.search.set_margin_start(4)
        self.search.set_margin_end(4)
        self.search.set_margin_bottom(4)
        self.search.set_tooltip_text("Search title or folder. cl: or claude: selects Claude; cx: or codex: selects Codex; "
                                     "oc: or opencode: selects OpenCode.")
        self.search.connect("search-changed", self.filter_changed)
        self.search.connect("stop-search", self.clear_search)
        self.search_row = Gtk.Revealer(child=self.search, transition_duration=150,
                                      transition_type=Gtk.RevealerTransitionType.SLIDE_DOWN
                                      if self.get_settings().get_property("gtk-enable-animations") else Gtk.RevealerTransitionType.NONE)
        self.search_row.connect("notify::reveal-child", lambda row, _param: setattr(self, "search_expanded", row.get_reveal_child()))
        self.search_focus = Gtk.EventControllerFocus()
        self.search_focus.connect("notify::contains-focus", self.sync_search_visibility)
        self.search.add_controller(self.search_focus)
        child = self.search.get_first_child()
        while child:
            if isinstance(child, Gtk.Image) and child.get_icon_name() == "edit-clear-symbolic":
                clear = Gtk.GestureClick(propagation_phase=Gtk.PropagationPhase.CAPTURE)
                clear.connect("released", self.reset_view)
                child.add_controller(clear)
                # Share GTK's gesture claim so both release handlers run.
                for controller in child.observe_controllers():
                    if isinstance(controller, Gtk.GestureClick) and controller is not clear:
                        clear.group(controller)
                break
            child = child.get_next_sibling()
        # Any popover blocks the number keys, also one that does not take the focus.
        self.open_popovers = set()
        self.popover_hooks = [(name, GObject.add_emission_hook(Gtk.Popover, name, self.popover_visibility, name))
                              for name in ("map", "unmap")]
        self.search_button = Gtk.Button(icon_name="system-search-symbolic", tooltip_text="Find a session or folder", valign=Gtk.Align.START)
        self.search_button.add_css_class("asb-toolbar-button")
        self.search_button.update_property([Gtk.AccessibleProperty.LABEL], ["Search sessions"])
        self.search_button.connect("clicked", self.open_search)
        self.toolbar_center.append(self.search_button)
        preferences = Gio.SimpleAction.new("preferences", None)
        preferences.connect("activate", self.open_preferences)
        self.add_action(preferences)
        model, windows, settings = Gio.Menu(), Gio.Menu(), Gio.Menu()
        windows.append("Messages", "app.messages")
        windows.append("Usage", "app.usage")
        settings.append("Preferences", "win.preferences")
        model.append_section(None, windows)
        model.append_section(None, settings)
        menu = Gtk.MenuButton(icon_name="view-more-symbolic", tooltip_text="Main menu", menu_model=model)
        menu.update_property([Gtk.AccessibleProperty.LABEL], ["Main menu"])
        menu.add_css_class("asb-toolbar-button")
        menu.get_popover().add_css_class("asb-main-menu")
        self.menu_button = menu
        sessions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        appearance = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        sessions.append(label("Show sessions", "heading"))
        row = Gtk.Box(spacing=12)
        name = label("Cards on the board")
        name.set_hexpand(True)
        row.append(name)
        self.card_limit_setting = Gtk.DropDown.new_from_strings([title for _value, title in CARD_LIMITS])
        self.card_limit_setting.update_property([Gtk.AccessibleProperty.LABEL], ["Cards on the board"])
        self.card_limit_setting.set_selected([value for value, _title in CARD_LIMITS].index(self.card_limit))
        self.card_limit_setting.connect("notify::selected", self.change_card_limit)
        row.append(self.card_limit_setting)
        sessions.append(row)
        help_text = label("The board shows the first cards in its order. A More card at the end shows the rest. "
                          "Search and filters look at all sessions.", "caption")
        help_text.set_wrap(True)
        help_text.set_xalign(0)
        sessions.append(help_text)
        self.card_limit_error = label("", "warning")
        self.card_limit_error.set_wrap(True)
        sessions.append(self.card_limit_error)
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
        unread_help = label("Use Mark read in the row panel to clear dots.", "caption")
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
        self.window_handle = Gtk.WindowHandle(child=tools, margin_bottom=3)
        body.append(self.window_handle)
        body.append(self.search_row)
        self.toolbar_strip = Gtk.Box(spacing=4)
        self.toolbar_center.append(self.toolbar_strip)
        self.chip_box = Gtk.Box(spacing=4)
        self.toolbar_scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.EXTERNAL,
                                                vscrollbar_policy=Gtk.PolicyType.NEVER, child=self.chip_box)
        self.toolbar_scroll.set_propagate_natural_width(True)
        self.toolbar_scroll.set_size_request(0, -1)
        self.toolbar_scroll.add_css_class("asb-chip-scroll")
        self.toolbar_center.append(self.toolbar_scroll)
        toolbar_wheel = Gtk.EventControllerScroll(flags=Gtk.EventControllerScrollFlags.BOTH_AXES)
        toolbar_wheel.connect("scroll", self.scroll_toolbar)
        self.toolbar_scroll.add_controller(toolbar_wheel)
        self.drawer_only = Gtk.ToggleButton(tooltip_text="Show only the sessions in the drawer, as unread. Point here to see them in the list.")
        self.drawer_only.add_css_class("asb-filter-pill")
        self.drawer_only.update_property([Gtk.AccessibleProperty.LABEL], ["Drawer only. The drawer is empty."])
        drawer = Gtk.Box(spacing=3)
        drawer.append(self.drawer_glyph())
        self.drawer_dot = Gtk.Box(valign=Gtk.Align.CENTER, visible=False)
        self.drawer_dot.add_css_class("asb-drawer-dot")
        drawer.append(self.drawer_dot)
        self.drawer_only.set_child(drawer)
        self.drawer_only.connect("notify::active", self.drawer_toggled)
        peek = Gtk.EventControllerMotion()
        peek.connect("enter", lambda *_args: self.set_drawer_peek(True))
        peek.connect("leave", lambda *_args: self.set_drawer_peek(False))
        self.drawer_only.add_controller(peek)
        self.toolbar_strip.append(self.drawer_only)
        self.filters_pill = Gtk.Button(tooltip_text="Show the filter checklist.")
        self.filters_pill.add_css_class("asb-filter-pill")
        self.filters_pill.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                          ["Filters", "No filters"])
        filters_box = Gtk.Box(spacing=3)
        funnel = Gtk.Image(pixel_size=14)
        set_icon(funnel, "asb-filter-symbolic")
        filters_box.append(funnel)
        self.filters_pill.set_child(filters_box)
        self.filters_pill.connect("clicked", self.open_filters_popover)
        self.toolbar_strip.append(self.filters_pill)
        self.filter_chip_signature = None
        self.filter_chip_widgets = {}
        self.filter_popover = None
        self.filter_popover_rows = {}
        self.filter_popover_signature = None
        self.notice = label("", "caption")
        self.notice.set_wrap(True)
        self.notice.set_margin_start(10)
        self.notice.set_margin_end(10)
        self.notice.set_margin_bottom(3)
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
        # The Preferences window is made on its first use (make_preferences), so that the first rows do not wait for it.
        self.preference_pages = (sessions, appearance)
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
                style.connect("notify::" + name, lambda *_args: GLib.idle_add(self.follow_system_style))
        self.connect("realize", self.watch_layout)
        self.timer = GLib.timeout_add(self.refresh_interval_ms, self.tick)
        self.events = EventStream(self.base, self.source_changed, GLib.idle_add, self.show_window_event)
        if initial_dashboard is not None:
            self.apply_dashboard(initial_dashboard, None)
        elif first_load:
            # The launcher start already asked for the first dashboard. Until it ends, a refresh waits in the queue.
            self.loading = True
            if not first_load.deliver(self.first_dashboard, GLib.idle_add):
                self.loading = False
                self.refresh()
        else:
            self.refresh()

    def reconnect(self, base):
        if self.closed:
            return
        self.base = base
        self.engine_generation += 1
        if self.preferences_window:
            for name in ("profiles_editor", "phone_editor", "machines_editor", "usage_editor"):
                editor = getattr(self.preferences_window, name)
                if editor:
                    editor.base = base
        self.events.close()
        self.events = EventStream(base, self.source_changed, GLib.idle_add, self.show_window_event)
        self.dashboard_etag = None
        self.ui_report_last = None
        self.ui_report_sending = False
        self.report_ui()
        self.refresh(queue=True)

    def show_window_event(self, window, client_id):
        # Only the Board that reported last opens the window, so two Boards do not both open it.
        if client_id == self.ui_client_id and not self.closed:
            if window == "board":
                self.present()
            else:
                self.get_application().show_activity(window)
        return False

    def first_dashboard(self, dashboard, error, etag):
        """The result of the early request of the launcher start. A failed request shows no notice: the normal first refresh runs."""
        if error or dashboard is None:
            self.loading = False
            self.refresh()
            return False
        return self.apply_dashboard(dashboard, None, etag)

    @staticmethod
    def rgba(value):
        return rgba(value)

    @staticmethod
    def hex_color(color):
        return hex_color(color)

    def native_colors(self):
        return native_colors(self)

    def set_palette(self, colors):
        base = ".asb-column-flow"
        css = f"""
{base} .asb-session {{ min-height: {ROW_HEIGHT}px; transition-property: background-color, color; padding: 0; border-radius: 3px; font-size: 13px; }}
{base}.asb-comfortable .asb-session {{ min-height: {COMFORTABLE_ROW_HEIGHT}px; }}
{base}.asb-comfortable .asb-session.asb-hover-paint:not(:focus-within) {{ background: transparent; }}
{base} .asb-filter-pill {{ min-height: 24px; border-radius: 99px; padding: 2px 8px; font-size: 11px; }}
{base} .asb-filter-pill:checked {{ background: @accent_bg_color; color: @accent_fg_color; }}
{base} .asb-chip-dot {{ min-width: 8px; min-height: 8px; border-radius: 99px; }}
{base} .asb-chip-scroll {{ background: transparent; }}
{base} .asb-chip-scroll undershoot.left {{ background: linear-gradient(to right, @window_bg_color, alpha(@window_bg_color, 0)); min-width: 16px; }}
{base} .asb-chip-scroll undershoot.right {{ background: linear-gradient(to left, @window_bg_color, alpha(@window_bg_color, 0)); min-width: 16px; }}
{base} .asb-filter-row {{ min-height: 30px; padding: 0; border-radius: 5px; font-size: 13px; font-weight: normal; }}
{base} .asb-filter-indent {{ margin-left: 16px; }}
{base} .asb-filter-head {{ font-size: 11px; color: alpha(@window_fg_color, .72); }}
{base} .asb-filter-head-top {{ margin-top: 8px; }}
{base} .asb-filter-footer {{ min-height: 30px; border-radius: 0 0 5px 5px; font-size: 13px; }}
{base} .asb-toolbar-button,
{base} menubutton.asb-toolbar-button > button,
{base} .asb-toolbar windowcontrols button {{ min-height: 24px; min-width: 22px; padding: 2px; }}
{base} menubutton.asb-toolbar-button {{ min-height: 0; min-width: 0; padding: 0; }}
{base} .asb-toolbar searchentry {{ min-height: 26px; padding-top: 0; padding-bottom: 0; }}
{base} .asb-state {{ font-size: 11px; }}
{base} .asb-provider {{ opacity: .65; }}
{base} .asb-message-lit .asb-provider {{ color: @accent_color; opacity: 1; }}
{base} .asb-source-badge {{ min-width: 6px; min-height: 6px; padding: 0; border: 1px solid @window_bg_color;
    border-radius: 50%; box-shadow: none; opacity: 1; }}
{base} .asb-source-badge.asb-preset-swatch {{ min-width: 14px; min-height: 14px; }}
{base} .asb-column {{ background: transparent; }}
{base} .asb-number {{ min-width: 16px; min-height: 15px; padding: 0; border: 1px solid alpha(@window_fg_color, .36);
    border-bottom-width: 2px; border-radius: 3px; background: mix(@window_bg_color, @window_fg_color, .17);
    color: @window_fg_color; font-size: 11px; font-weight: bold; line-height: 15px; opacity: 0;
    transition: opacity 100ms ease-out; }}
{base}:not(.asb-comfortable) .asb-number {{ min-width: 14px; min-height: 13px; line-height: 13px; }}
{base} .asb-number.asb-number-shown {{ opacity: 1; transition: opacity 140ms ease-out; }}
{base} .asb-number.asb-number-pressed {{ background: @accent_bg_color; color: @accent_fg_color; }}
{base} .asb-column + .asb-column {{ border-left: 1px solid @borders; }}
{base} .asb-dot, .asb-tooltip .asb-dot {{ min-width: 7px; min-height: 7px; border-radius: 50%; background: @accent_color; }}
{base} .asb-dot.asb-question, {base} .asb-dot.asb-alert, .asb-tooltip .asb-dot.asb-question, .asb-tooltip .asb-dot.asb-alert {{ min-width: 0; min-height: 0; border-radius: 0; background: none; color: @accent_color;
    font-size: 11px; font-weight: 800; }}
{base} .asb-dot.asb-stop, .asb-tooltip .asb-dot.asb-stop {{ border-radius: 1px; background: alpha(@window_fg_color, .55); }}
{base} .asb-dot.asb-discard, .asb-tooltip .asb-dot.asb-discard {{ min-width: 6px; min-height: 6px; border: 1.5px solid @window_fg_color;
    border-radius: 50%; background: none; }}
{base} .asb-discard-offer .asb-discard {{ border-style: dashed; border-color: alpha(@window_fg_color, .55); }}
{base} .asb-card-action {{ min-width: 24px; min-height: 24px; padding: 0; border: 0; border-radius: 50%; box-shadow: none; }}
{base} .asb-card-action.asb-action-pending > * {{ opacity: .5; }}
{base} .asb-pin-button {{ opacity: 0; }}
{base} .asb-session.asb-hovered .asb-pin-button, {base} .asb-session:focus-within .asb-pin-button,
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
{base} .asb-session.asb-hovered .asb-discard-offer, {base} .asb-session:focus-within .asb-discard-offer {{ opacity: 1; }}
{base} .asb-drawer-glyph {{ min-width: 9px; min-height: 5px; border: 1px solid; border-radius: 2px; }}
{base} .asb-drawer-handle {{ min-width: 3px; min-height: 1px; background: currentColor; }}
{base} .asb-drawer-filled .asb-drawer-glyph {{ background: currentColor; }}
{base} .asb-drawer-filled .asb-drawer-handle {{ background: @window_bg_color; }}
{base} .asb-drawer-filled:checked .asb-drawer-handle {{ background: @accent_bg_color; }}
{base} .asb-drawer-dot {{ min-width: 5px; min-height: 5px; border-radius: 50%; background: @accent_color; }}
{base} .asb-filter-pill:checked .asb-drawer-dot {{ background: @accent_fg_color; }}
{base} .asb-drawer-button {{ opacity: 0; background: alpha(@window_fg_color, .08); }}
{base} .asb-session.asb-hovered .asb-drawer-button, {base} .asb-key-focus .asb-drawer-button {{ opacity: 1; }}
{base} .asb-drawer-button.asb-drawer-filled {{ color: @accent_color; }}
{base} .asb-drawer-button:hover, {base} .asb-drawer-button:focus-visible {{ background: alpha(@accent_color, .15); }}
{base} .asb-copy-button {{ opacity: 0; background: alpha(@window_fg_color, .08); }}
{base} .asb-session.asb-hovered .asb-copy-button, {base} .asb-key-focus .asb-copy-button {{ opacity: 1; }}
{base} .asb-copy-button:hover, {base} .asb-copy-button:focus-visible {{ background: alpha(@accent_color, .15); }}
{base} .asb-copy-button.asb-copy-confirmed {{ color: @success_color; background: alpha(@success_color, .12); }}
{base} .asb-session.asb-hovered .asb-copy-button.asb-copy-off, {base} .asb-key-focus .asb-copy-button.asb-copy-off {{ opacity: .45; }}
{base} .asb-copy-button.asb-copy-off, {base} .asb-copy-button.asb-copy-off:hover, {base} .asb-copy-button.asb-copy-off:focus-visible {{ background: none; }}
{base} .asb-copy-tag {{ min-height: 18px; padding: 2px 7px 2px 8px; border-radius: 9px; background: alpha(@window_fg_color, .12); }}
{base} .asb-copy-tag-word {{ font-size: 10px; font-weight: bold; letter-spacing: .04em; }}
{base} .asb-copy-tag-dot {{ min-width: 4px; min-height: 4px; border-radius: 50%; background: alpha(@window_fg_color, .3); }}
{base} .asb-copy-tag-dot.asb-copy-tag-on {{ background: @accent_color; }}
{base} .asb-copy-tag-dot.asb-copy-tag-off {{ background: none; border: 1px solid alpha(@window_fg_color, .3); }}
{base} .asb-copy-feedback {{ color: @success_color; }}
{base} .asb-corner-wide {{ padding: 0 0 2px 16px; border-radius: 0 0 0 12px; }}
{base} .asb-session.asb-hovered .asb-corner-wide, {base} .asb-key-focus .asb-corner-wide {{
    background: linear-gradient(to right, alpha(@window_bg_color, 0), @window_bg_color 16px); }}
{base} .asb-unread.asb-hovered .asb-dot, {base} .asb-unread.asb-key-focus .asb-read-button .asb-dot,
{base} .asb-drawer:not(.asb-drawer-lit) .asb-dot {{ opacity: 0; }}
{base} .asb-unread.asb-hovered .asb-read-cue, {base} .asb-unread.asb-key-focus .asb-read-cue {{ opacity: 1; }}
{base} .asb-drawer.asb-unhovered:not(.asb-drawer-lit):not(.asb-key-focus) .asb-read-button {{ opacity: 0; }}
{base}:not(.asb-custom) .asb-unread.asb-hovered .asb-state:not(.success) {{ opacity: .55; }}
{base} .asb-drawer.asb-drawer-lit.asb-unhovered .asb-state {{ opacity: 1; }}
.asb-tooltip {{ font-size: 12px; }}
.asb-tooltip .asb-tooltip-title {{ font-size: 13px; }}
.asb-tooltip .asb-tooltip-path, .asb-tooltip .asb-tooltip-footer, .asb-tooltip .asb-tooltip-flags {{ font-size: 11px; }}
.asb-tooltip .asb-tooltip-muted {{ color: alpha(@window_fg_color, .72); opacity: 1; }}
.asb-tooltip .asb-working {{ color: @success_color; }}
.asb-tooltip .asb-provider {{ opacity: .65; }}
.asb-tooltip .asb-source-badge {{ min-width: 6px; min-height: 6px; padding: 0; border: 1px solid @window_bg_color; border-radius: 50%; }}
{base} popover.asb-row-panel > contents {{ padding: 8px; border: 1px solid alpha(@accent_color, .7); border-radius: 12px; background: @window_bg_color;
    box-shadow: 0 2px 8px alpha(black, .35), 0 8px 24px alpha(black, .3); }}
{base} .asb-row-panel .asb-panel-title {{ font-size: 12px; font-weight: bold; margin: 4px 8px 8px; }}
{base} .asb-row-panel .asb-panel-action {{ min-height: 30px; padding: 0 8px; border-radius: 5px; font-size: 13px; font-weight: normal; }}
{base} .asb-row-panel separator {{ margin: 4px 0; }}
{base} .asb-row-panel .asb-panel-note {{ margin: 5px 8px; color: alpha(@window_fg_color, .72); }}
{base} .asb-row-panel .asb-panel-error {{ margin: 8px 8px 0; font-size: 11px; }}
{base} .asb-row-panel .asb-panel-caption {{ font-size: 11px; color: alpha(@window_fg_color, .72); opacity: 1; }}
{base} .asb-row-panel button.asb-panel-captioned {{ padding-top: 5px; padding-bottom: 5px; }}
{base} .asb-row-panel button.asb-copy-off .asb-panel-label, {base} .asb-row-panel button.asb-copy-off image {{ opacity: .5; }}
{base} .asb-row-panel button.asb-copy-off:hover, {base} .asb-row-panel button.asb-copy-off:active {{ background: none; }}
{base} .asb-row-panel button.asb-action-pending > * {{ opacity: .5; }}
{base} .asb-row-panel button.asb-action-pending:hover, {base} .asb-row-panel button.asb-action-pending:active {{ background: none; }}
{base} .asb-row-panel button.asb-copy-done image {{ color: @accent_color; }}
"""
        if colors:
            colors = validate_theme(colors)
            self.add_css_class("asb-custom")
            scope = base + ".asb-custom"
            number_fill, number_edge, number_pressed = number_badge_colors(colors)
            css += f"""
{scope}, {scope} headerbar, {scope} popover contents {{ background: {colors['background']}; color: {colors['text']}; }}
{scope} popover > contents {{ border: 1px solid {edge_color(colors['background'], colors['text'], .36, (colors['background'],))}; }}
{scope} popover.asb-row-panel > contents {{ background: {colors['background']}; border-color: {edge_color(colors['background'], colors['accent'], .7, (colors['background'],))}; }}
{scope} .asb-row-panel .asb-panel-note, {scope} .asb-row-panel .asb-panel-caption {{ color: {colors['muted']}; }}
{scope} .asb-row-panel button.asb-copy-done image {{ color: {colors['accent']}; }}
{scope} .asb-state, {scope} .dim-label {{ color: {colors['muted']}; opacity: 1; }}
{scope} .asb-working {{ color: {colors['accent']}; }}
{scope} .asb-message-lit .asb-provider {{ color: {colors['accent']}; }}
{scope} .asb-dot, .asb-tooltip.asb-custom .asb-dot {{ background: {colors['accent']}; }}
{scope} .asb-dot.asb-question, {scope} .asb-dot.asb-alert, .asb-tooltip.asb-custom .asb-dot.asb-question,
    .asb-tooltip.asb-custom .asb-dot.asb-alert {{ background: none; color: {colors['accent']}; }}
{scope} .asb-dot.asb-stop, .asb-tooltip.asb-custom .asb-dot.asb-stop {{ background: {colors['muted']}; }}
{scope} .asb-dot.asb-discard, .asb-tooltip.asb-custom .asb-dot.asb-discard {{ background: none; border-color: {colors['text']}; }}
{scope} .asb-discard-offer .asb-discard {{ border-color: {colors['muted']}; }}
{scope} .asb-column + .asb-column {{ border-color: {colors['divider']}; }}
{scope} .asb-number {{ background: {number_fill}; border-color: {number_edge}; color: {colors['text']}; }}
{scope} .asb-number.asb-number-pressed {{ background: {colors['accent']}; color: {number_pressed}; }}
{scope} .asb-session.asb-hovered, {scope} .asb-session:focus-within {{ background: {highlight_color(colors)}; }}
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
{scope} .asb-filter-head {{ color: {colors['muted']}; }}
{scope} .asb-chip-scroll undershoot.left {{ background: linear-gradient(to right, {colors['background']}, alpha({colors['background']}, 0)); }}
{scope} .asb-chip-scroll undershoot.right {{ background: linear-gradient(to left, {colors['background']}, alpha({colors['background']}, 0)); }}
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
{scope} .asb-copy-button.asb-copy-off, {scope} .asb-copy-button.asb-copy-off:hover, {scope} .asb-copy-button.asb-copy-off:focus-visible {{ background: none; }}
{scope} .asb-copy-feedback {{ color: {colors['accent']}; }}
{scope} .asb-copy-tag-dot.asb-copy-tag-on {{ background: {colors['accent']}; }}
{scope} .asb-session.asb-hovered .asb-corner-wide, {scope} .asb-key-focus .asb-corner-wide {{
    background: linear-gradient(to right, alpha({colors['background']}, 0), {colors['background']} 16px); }}
.asb-tooltip.asb-custom {{ color: {colors['text']}; }}
.asb-tooltip.asb-custom .asb-tooltip-muted, .asb-tooltip.asb-custom .asb-state {{ color: {colors['muted']}; }}
.asb-tooltip.asb-custom .dim-label {{ opacity: 1; }}
.asb-tooltip.asb-custom .asb-working {{ color: {colors['accent']}; }}
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
        quiet = [base + ".asb-comfortable .asb-idle-read.asb-unhovered:not(.asb-limited):not(.asb-drawer-lit):not(:focus-within)"]
        parts = (" .asb-title", " .asb-folder", " .asb-state", " .asb-age", " .asb-limit-clock", " .asb-mute-glyph", " .asb-where",
                 " .asb-where-icon")
        # The Grey tone of a view-only row with no attention, in both views; hover and focus bring the normal colors back.
        calm = ".asb-unhovered:not(.asb-limited):not(.asb-drawer-lit):not(:focus-within)"
        view_only, view_only_rest = f"{base} .asb-view-only-quiet{calm}", f"{base} .asb-view-only-rest{calm}"
        css += f"""
{", ".join(row + " .asb-title" for row in quiet)} {{ color: {quiet_title}; opacity: 1; }}
{", ".join(row + part for row in quiet for part in (" .asb-folder", " .asb-state", " .asb-age", " .asb-mute-glyph"))} {{ color: {quiet_caption}; opacity: 1; }}
{", ".join(base + " .asb-limited" + part for part in parts)} {{ color: {limited}; opacity: 1; }}
{", ".join(base + " .asb-limited" + state + part for state in (".asb-hovered", ":focus-within") for part in parts)} {{ color: {limited_hover}; }}
{base} .asb-limited:not(.asb-message-lit) .asb-provider {{ opacity: .4; }}
{view_only} .asb-title {{ color: {quiet_title}; opacity: 1; }}
{", ".join(view_only + part for part in (" .asb-folder", " .asb-age", " .asb-where", " .asb-where-icon", " .asb-mute-glyph"))} {{ color: {quiet_caption}; opacity: 1; }}
{view_only_rest} .asb-state {{ color: {quiet_caption}; opacity: 1; }}
"""
        self.css.load_from_string(css)
        self.hover_colors = colors
        for widget in self.row_cache.values():
            widget.asb_tooltip_content = widget.asb_tooltip_key = None
            widget.asb_source_badge.set_color(source_marker_color(widget.asb_thread))
        # badge_css was rebuilt empty: repaint the chip dots so their color rules return.
        for key, _title, _detail, color in self.active_filter_chips():
            chip = self.filter_chip_widgets.get(key, (None, None))[0]
            if chip is not None:
                self.apply_chip_dot(chip, color)
        # The Filters popover makes its rows again at the next open, so their dots get rules.
        self.filter_popover_signature = None
        if getattr(self, "preferences_window", None):
            preferences = self.preferences_window
            (preferences.add_css_class if colors else preferences.remove_css_class)("asb-custom")
            if preferences.profiles_editor:
                editor = preferences.profiles_editor
                if editor.dialog is not None and not hasattr(Adw, "Dialog"):
                    (editor.dialog.add_css_class if colors else editor.dialog.remove_css_class)("asb-custom")
                editor.update_marker_colors()
        # The theme reaches the Messages and Usage windows too. The logic checks make this window without GTK.
        application = self.get_application() if hasattr(self, "get_application") else None
        for window in list(getattr(application, "activity_windows", {}).values()):
            window.set_palette(colors)

    def badge_class(self, displayed):
        """The style class of a profile badge color; the rules of all badge colors are in self.badge_css."""
        name = "asb-badge-" + displayed[1:].lower()
        if name not in self.badge_colors:
            self.badge_colors[name] = displayed
            background, highlight = self.profile_surfaces
            self.badge_css.load_from_string("".join(
                f""".asb-source-badge.{key} {{ background: {color}; border-color: {background}; }}
.asb-session.asb-hovered .asb-source-badge.{key}, .asb-session:focus-within .asb-source-badge.{key} {{ border-color: {highlight}; }}
.asb-chip-dot.{key} {{ background: {color}; }}
""" for key, color in self.badge_colors.items()))
        return name

    def follow_system_style(self):
        # With GNOME colors, the Messages and Usage windows wrote the old accent into their CSS: give them the new one.
        if not self.closed and not self.hover_colors:
            self.set_palette(None)
        return self.publish_palette()

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

    def make_preferences(self):
        if self.preferences_window is None:
            self.preferences_window = PreferencesWindow(self, *self.preference_pages)
            if self.hover_colors:
                self.preferences_window.add_css_class("asb-custom")
        return self.preferences_window

    def open_preferences(self, *_args):
        if not self.closed:
            self.make_preferences().present()

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
                       and preferences.stack.get_visible_child_name() == "profiles"
                       and preferences.pages.get_visible_child_name() == "section")
        payload = {"clientId": self.ui_client_id, "sourcesRevision": self.sources_revision,
                   "profilesRevision": editor.revision if editor and editor.loaded else None,
                   "profilesVisible": visible, "dirty": editor.is_dirty() if editor else False}
        if self.ui_report_sending or payload == self.ui_report_last and time.monotonic() - self.ui_report_at < 25:
            return
        self.ui_report_last, self.ui_report_at, self.ui_report_sending = payload, time.monotonic(), True
        base, generation = self.base, self.engine_generation
        def finished(_result, _error):
            if generation != self.engine_generation:
                return False
            self.ui_report_sending = False
            if not self.closed:
                self.report_ui()
            return False
        request_async(base, "/api/agent/ui", finished, GLib.idle_add, "POST", payload)

    def report_ui_closed(self):
        if SOURCE_TOKEN and getattr(self, "ui_client_id", None):
            # A slow engine must not keep the window process alive.
            request_async(self.base, "/api/agent/ui", lambda *_args: None, lambda *_args: None, "POST",
                          {"clientId": self.ui_client_id, "closed": True}).join(.75)

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
        base, generation = self.base, self.engine_generation
        def finished(dashboard, error):
            if generation != self.engine_generation:
                self.loading = False
                self.refresh(force, queue=True)
                return False
            return self.apply_dashboard(dashboard, error, etag, force)
        request_async(base, "/api/dashboard?force=1" if force else "/api/dashboard",
                      finished, GLib.idle_add, "GET", None, etag)

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
            model = filter_profiles(dashboard)
            if model != self.filter_model:
                self.filter_model = model
                known = {profile["key"] for machine in model for app in machine["apps"] for profile in app["profiles"]}
                if self.profiles - known:
                    self.profiles.intersection_update(known)
                    self.sync_filter_chips()
                    # The rows render again also when the thread list did not change.
                    self.signature = None
                self.filter_popover_signature = None
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
            self.add_tick_callback(SnapshotWatch(os.environ["ASB_SNAPSHOT"]).tick)
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
            self.pending_messages = []
            return False
        if getattr(self.list_body, "motion", None):
            self.pending_messages = list(dict.fromkeys([*self.pending_messages, *play]))[-MESSAGE_FLIGHT_LIMIT:]
            return False
        # A flight draws with Gsk.PathBuilder (GTK 4.14). GTK 4.12 lights the rows, as with animations off.
        animations = self.get_settings().get_property("gtk-enable-animations") and hasattr(Gsk, "PathBuilder")
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
        self.app_mark.set_visible(not self.tiny_controls)
        self.search_button.set_visible(not self.tiny_controls)
        if wide != (self.refresh_button.get_parent() is self.toolbar_end):
            self.refresh_button.get_parent().remove(self.refresh_button)
            if wide:
                self.refresh_button.set_icon_name("view-refresh-symbolic")
                self.toolbar_end.prepend(self.refresh_button)
            else:
                self.refresh_button.set_label("Refresh sessions")
                self.preferences_refresh_row.append(self.refresh_button)
        self.preferences_refresh_row.set_visible(not wide)

    def scroll_toolbar(self, _controller, dx, dy):
        adjustment = self.toolbar_scroll.get_hadjustment()
        distance = dx or dy
        before = adjustment.get_value()
        adjustment.set_value(max(0, min(before + distance * 40, adjustment.get_upper() - adjustment.get_page_size())))
        return adjustment.get_value() != before

    def change_card_limit(self, *_args):
        limits = [value for value, _title in CARD_LIMITS]
        selected = limits[self.card_limit_setting.get_selected()]
        if selected == self.card_limit:
            return
        try:
            write_layout(self.layout_path, self.column_width, self.view, card_limit=selected, copy_kind=self.copy_kind)
        except (OSError, ValueError) as error:
            self.card_limit_setting.set_selected(limits.index(self.card_limit))
            self.card_limit_error.set_label(str(error))
            return
        self.card_limit = selected
        self.card_limit_error.set_label("")
        self.show_all_cards = False
        self.filter_changed()

    def change_copy_kind(self, kind):
        """Save the board copy kind. A failed save keeps the old kind and shows the error."""
        if kind == self.copy_kind:
            return
        try:
            write_layout(self.layout_path, self.column_width, self.view,
                         self.card_limit, copy_kind=kind)
        except (OSError, ValueError) as error:
            self.layout_error.set_label(str(error))
            self.set_notice(str(error), temporary=True)
            return
        self.copy_kind = kind
        self.layout_error.set_label("")
        for widget in list(getattr(self, "focus_widgets", {}).values()):
            if getattr(widget, "asb_view", None) == "comfortable":
                widget.asb_action_signature = None
                self.update_card_actions(widget)

    def step_copy_kind(self, widget=None):
        """Toggle the board copy kind. A remote card never moves it."""
        row = getattr(widget, "asb_thread", None) or {}
        if row.get("remote") is True:
            return
        self.change_copy_kind("absolute" if self.copy_kind == "relative" else "relative")

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
            write_layout(self.layout_path, self.column_width, self.view, card_limit=self.card_limit, copy_kind=self.copy_kind)
            self.layout_error.set_label("")
        except (OSError, ValueError) as error:
            self.layout_error.set_label(str(error))

    def reset_width(self, *_args):
        self.dragging = True
        self.width_control.set_value(DEFAULT_COLUMN_WIDTH)
        self.dragging = False
        try:
            write_layout(self.layout_path, view=self.view, card_limit=self.card_limit, copy_kind=self.copy_kind)
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
        # The kind switch takes the wheel only after the pointer rests on the copy button, or while the tag shows.
        copy = getattr(self, "copy_hover", None)
        if copy is not None:
            unit = controller.get_unit() if controller else Gdk.ScrollUnit.WHEEL
            now = time.monotonic()
            if copy_wheel_captured(getattr(copy, "asb_rest_at", None), now, bool(getattr(copy, "asb_tag_shown", False)),
                                   self.copy_has_keyboard_focus(copy)):
                step, self.copy_wheel_state = copy_wheel_step(self.copy_wheel_state, delta, now,
                                                              surface=unit != Gdk.ScrollUnit.WHEEL)
                if step:
                    self.step_copy_kind(getattr(copy, "asb_card", None))
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
        if getattr(self, "hover_after_layout", False):
            self.hover_after_layout = False
            self.sync_row_hover()
        self.start_motion()
        self.queue_number_keys()

    def start_motion(self):
        self.redraw_visible_columns()
        old, self.motion_from = self.motion_from, None
        # GTK sends no enter or leave when a card moves under a still pointer, so check the copy button after the layout.
        copy = getattr(self, "copy_hover", None)
        if old is not None and copy is not None and not self.pointer_on(copy):
            self.hide_copy_tag(copy, keep_focused=True)
        if old in (None, False) or self.closed:
            return
        strip = self.list_body
        self.motion_animation.reset()
        self.advance_motion(0)
        places = self.painted_places()
        strip.motion = motion_offsets(old, places)
        if strip.motion:
            strip.clear_hover(copy_tag=False)
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
            pending, self.pending_messages = self.pending_messages, []
            if pending and not self.closed:
                GLib.idle_add(self.start_messages, pending)

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
        self.list_body.show_hover(rectangle, row if rectangle else None)

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
        # The tag of the copy button under the pointer stays until the pointer leaves.
        old = getattr(self, "copy_focus_button", None)
        if self.get_focus_visible() and focus is not None and getattr(focus, "asb_card_action", None) == "copy":
            if old is not None and old is not focus and old is not self.copy_hover:
                self.show_copy_tag(old, False)
            self.copy_focus_button = focus
            self.show_copy_tag(focus, True)
        elif old is not None:
            if old is not self.copy_hover:
                self.show_copy_tag(old, False)
            self.copy_focus_button = None

    def reset_view(self, *_args):
        self.resetting_view = True
        try:
            self.pending, self.archived, self.show_all_cards = False, False, False
            self.states, self.profiles = set(), set()
            self.drawer_only.set_active(False)
            self.drawer_view = False
            self.search.set_text("")
            self.search_row.set_reveal_child(False)
            (self.menu_button if self.tiny_controls else self.search_button).grab_focus()
        finally:
            self.resetting_view = False
        self.filter_changed()

    def clear_search(self, *_args):
        if self.search.get_text() or self.search_expanded or self.filters_active() or self.show_all_cards or self.drawer_view:
            self.reset_view()
            return True
        return False

    def sync_search_visibility(self, *_args):
        self.search_row.set_reveal_child(bool(self.search.get_text()) or self.search_focus.contains_focus())

    def open_search(self, *_args):
        self.search_row.set_reveal_child(True)
        self.search.grab_focus()

    def open_search_from_preferences(self, *_args):
        self.preferences_window.set_visible(False)
        self.present()
        self.open_search()

    def popover_visibility(self, widget, name):
        # The hook runs for every widget that maps; only the popovers of this window count.
        if isinstance(widget, Gtk.Popover) and widget.get_root() is self:
            if name == "map":
                self.open_popovers.add(widget)
                self.hide_numbers()
            else:
                self.open_popovers.discard(widget)
        return True

    def numbers_blocked(self):
        # The row panel and every other popup block the numbers.
        if not self.is_active() or (self.context_menu and self.context_menu.get_visible()) \
                or any(popover.get_mapped() for popover in self.open_popovers):
            return True
        focus = self.get_focus()
        popover = focus.get_ancestor(Gtk.Popover) if focus else None
        return popover is not None

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
            # The class goes on the numbered keycaps only, so showing them restyles nine labels, not all cards.
            for identity in self.number_keys:
                self.focus_widgets[identity].asb_number_label.add_css_class("asb-number-shown")
        return False

    def hide_numbers(self, *_args):
        if self.number_hold:
            GLib.source_remove(self.number_hold)
            self.number_hold = None
        if self.numbers_shown:
            self.numbers_shown = False
            for identity in self.number_keys:
                widget = self.row_cache.get(identity)
                if widget:
                    widget.asb_number_label.remove_css_class("asb-number-shown")
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
        if number and self.numbers_shown:
            widget.asb_number_label.add_css_class("asb-number-shown")
        else:
            widget.asb_number_label.remove_css_class("asb-number-shown")
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
            if any(popover.get_mapped() for popover in self.open_popovers):
                return False
            return self.clear_search()
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
        return limit_rows(filtered_rows(self.dashboard, self.search.get_text(), "all", self.states,
                                        self.archived, self.pending, self.drawer_view, self.profiles),
                          self.card_limit, self.show_all_cards)

    def filter_changed(self, *_args):
        if getattr(self, "resetting_view", False):
            return
        if _args and _args[0] is self.search:
            self.sync_search_visibility()
        self.sync_filter_chips()
        self.cancel_scroll()
        self.list_body.clear_hover()
        self.render()

    def filters_active(self):
        return bool(self.pending or self.states or self.profiles or self.archived)

    def filter_description(self):
        names = [title for _key, title, _detail, _color in self.active_filter_chips()
                 if _key != "all"]
        return ", ".join(names) if names else "No filters"

    def active_filter_chips(self):
        return filter_chips(self.pending, self.states, self.profiles, self.filter_model,
                            self.archived, show_all=self.show_all_cards, limit=self.card_limit)

    def set_pending(self, on):
        on = bool(on)
        if on and self.drawer_only.get_active():
            self.drawer_only.set_active(False)
        if on == self.pending:
            return
        self.pending = on
        self.filter_changed()

    def set_archived(self, on):
        on = bool(on)
        if on == self.archived:
            return
        self.archived = on
        self.filter_changed()

    def clear_filters(self):
        self.pending, self.archived = False, False
        self.states, self.profiles = set(), set()
        self.filter_changed()

    def drawer_toggled(self, *_args):
        if getattr(self, "resetting_view", False):
            return
        self.drawer_view = self.drawer_only.get_active()
        if self.drawer_view and self.pending:
            self.pending = False
        self.filter_changed()

    def sync_filter_chips(self):
        if not getattr(self, "chip_box", None):
            return
        if self.filter_popover is not None and self.filter_popover.get_visible():
            # The chips wait for the Filters popover to close, so the pill and the popover do not move under the pointer.
            self.update_filters_pill()
            return
        chips = self.active_filter_chips()
        if chips == self.filter_chip_signature:
            self.update_filters_pill()
            return
        self.filter_chip_signature = chips
        wanted = {key: (title, detail, color) for key, title, detail, color in chips}
        for key, (chip, _name) in list(self.filter_chip_widgets.items()):
            if key not in wanted:
                self.remove_filter_chip_widget(key, chip)
        animations = self.get_settings().get_property("gtk-enable-animations") and self.get_mapped()
        prev_wrapper = None
        for key, title, detail, color in chips:
            if key not in self.filter_chip_widgets:
                chip, name = self.make_filter_chip(key, title, detail, color, animations, after=prev_wrapper)
                self.filter_chip_widgets[key] = (chip, name)
            else:
                chip, name = self.filter_chip_widgets[key]
                name.set_label(self.ellipsize_chip(title))
                chip.set_tooltip_text(detail)
                chip.update_property([Gtk.AccessibleProperty.LABEL], [detail])
                self.apply_chip_dot(chip, color)
            prev_wrapper = getattr(self.filter_chip_widgets[key][0], "asb_chip_wrapper", self.filter_chip_widgets[key][0])
        self.update_filters_pill()
        if chips:
            GLib.idle_add(self.scroll_chip_into_view)

    def make_filter_chip(self, key, title, detail, color, animations, after=None):
        chip = Gtk.Button(tooltip_text=detail)
        chip.add_css_class("asb-filter-pill")
        chip.update_property([Gtk.AccessibleProperty.LABEL], [detail])
        content = Gtk.Box(spacing=6)
        dot = self.chip_dot()
        dot.set_visible(False)
        content.append(dot)
        name = label(self.ellipsize_chip(title))
        content.append(name)
        content.append(Gtk.Image(icon_name="window-close-symbolic", pixel_size=12))
        chip.asb_chip_dot = dot
        chip.set_child(content)
        chip.connect("clicked", self.clear_filter_chip, key)
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.chip_key, key)
        chip.add_controller(keys)
        self.apply_chip_dot(chip, color)
        if not animations:
            chip.asb_chip_wrapper = chip
            if after is not None and after.get_parent() is self.chip_box:
                self.chip_box.insert_child_after(chip, after)
            else:
                self.chip_box.prepend(chip)
            return chip, name
        revealer = Gtk.Revealer(transition_type=Gtk.RevealerTransitionType.SLIDE_RIGHT, transition_duration=200)
        revealer.set_child(chip)
        chip.asb_chip_wrapper = revealer
        if after is not None and after.get_parent() is self.chip_box:
            self.chip_box.insert_child_after(revealer, after)
        else:
            self.chip_box.prepend(revealer)
        revealer.set_reveal_child(True)
        return chip, name

    def remove_filter_chip_widget(self, key, chip):
        wrapper = getattr(chip, "asb_chip_wrapper", chip)
        self.filter_chip_widgets.pop(key, None)
        if not self.get_settings().get_property("gtk-enable-animations") or not isinstance(wrapper, Gtk.Revealer):
            if wrapper.get_parent():
                wrapper.get_parent().remove(wrapper)
            return
        def finished(revealer, *_args):
            if not revealer.get_reveal_child() and revealer.get_parent():
                revealer.get_parent().remove(revealer)
        wrapper.connect("notify::child-revealed", finished)
        wrapper.set_reveal_child(False)

    @staticmethod
    def chip_dot():
        """The 8 px profile color dot of a filter chip and of a Filters popover row."""
        dot = Gtk.Box()
        dot.set_size_request(8, 8)
        dot.set_valign(Gtk.Align.CENTER)
        dot.set_halign(Gtk.Align.CENTER)
        dot.add_css_class("asb-chip-dot")
        return dot

    def apply_chip_dot(self, chip, color):
        dot = getattr(chip, "asb_chip_dot", None)
        if dot is not None:
            self.paint_dot(dot, color)

    def paint_dot(self, dot, color):
        try:
            color = validate_source_color(color)
        except ValueError:
            color = ""
        displayed = display_source_color(color, self.profile_surfaces) if color else ""
        dot.set_visible(bool(displayed))
        name = self.badge_class(displayed) if displayed else ""
        old = getattr(dot, "asb_color_class", "")
        if name != old:
            if old:
                dot.remove_css_class(old)
            if name:
                dot.add_css_class(name)
            dot.asb_color_class = name

    @staticmethod
    def ellipsize_chip(title):
        return title if len(title) <= 18 else title[:17] + "…"

    def scroll_chip_into_view(self):
        wrappers = [getattr(chip, "asb_chip_wrapper", chip) for chip, _name in self.filter_chip_widgets.values()]
        wrapper = wrappers[-1] if wrappers else None
        if wrapper is None:
            return False
        x = 0
        child = self.chip_box.get_first_child()
        while child and child is not wrapper:
            x += child.get_allocated_width()
            child = child.get_next_sibling()
        width = wrapper.get_allocated_width()
        adjustment = self.toolbar_scroll.get_hadjustment()
        page, value = adjustment.get_page_size(), adjustment.get_value()
        if x < value:
            adjustment.set_value(max(0, x))
        elif width and x + width > value + page:
            adjustment.set_value(min(adjustment.get_upper() - page, x + width - page))
        return False

    def update_filters_pill(self):
        if not getattr(self, "filters_pill", None):
            return
        self.filters_pill.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                                          ["Filters", self.filter_description()])

    def clear_filter_chip(self, _button, key):
        focus = self.get_focus()
        chip = self.filter_chip_widgets.get(key, (None, None))[0]
        restore_focus = bool(focus and chip and (focus is chip or focus.is_ancestor(chip)))
        if key == "pending":
            self.set_pending(False)
        elif key.startswith("state:"):
            self.states.discard(key.split(":", 1)[1])
            self.filter_changed()
        elif key.startswith("profile:"):
            self.profiles.discard(key.split(":", 1)[1])
            self.filter_changed()
        elif key == "archive":
            self.set_archived(False)
        elif key == "all":
            self.show_all_cards = False
            self.filter_changed()
        if restore_focus:
            after = [other for other, _name in self.filter_chip_widgets.values()]
            next_chip = next((widget for widget in after if widget is not chip), None)
            if next_chip is None:
                next_chip = self.filters_pill
            next_chip.grab_focus()

    def chip_key(self, _controller, key, _code, _modifiers, chip_key_name):
        if key in (Gdk.KEY_Delete, Gdk.KEY_BackSpace):
            self.clear_filter_chip(None, chip_key_name)
            return True
        return False

    def open_filters_popover(self, *_args):
        if self.filter_popover is not None and self.filter_popover.get_visible():
            self.filter_popover.popdown()
            self.filters_pill.grab_focus()
            return
        if self.filter_popover is None:
            self.filter_popover = Gtk.Popover(position=Gtk.PositionType.BOTTOM, has_arrow=True, autohide=False)
            self.filter_popover.set_parent(self.filters_pill)
            self.filter_popover.set_size_request(280, -1)
            self.filter_popover.connect("closed", self.filters_popover_closed)
            keys = Gtk.EventControllerKey()
            keys.connect("key-pressed", self.filter_popover_key)
            self.filter_popover.add_controller(keys)
            focus = Gtk.EventControllerFocus()
            focus.connect("leave", self.close_filters_popover)
            self.filter_popover.add_controller(focus)
            # Keep focus inside until the pill toggles the popover.
            self.filters_pill.set_focus_on_click(False)
            press = Gtk.GestureClick(button=0, propagation_phase=Gtk.PropagationPhase.CAPTURE)
            press.connect("pressed", self.filters_outside_press)
            self.add_controller(press)
            self.connect("notify::is-active", self.filters_active_changed)
            self.connect("unmap", self.close_filters_popover)
            self.connect("close-request", self.close_filters_popover)
        self.rebuild_filters_popover()
        self.filters_pill.set_has_tooltip(False)
        # GTK measures a hidden popover as zero; show it before measuring and opening it.
        self.filter_popover.set_visible(True)
        found, bounds = self.filters_pill.compute_bounds(self)
        width = self.filter_popover.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
        shift = popover_shift(bounds.origin.x, bounds.size.width, width, self.get_width()) if found else 0
        self.filter_popover.set_offset(shift, 0)
        self.filter_popover.popup()
        self.filter_popover.child_focus(Gtk.DirectionType.TAB_FORWARD)

    def close_filters_popover(self, *_args):
        if self.filter_popover is not None:
            self.filter_popover.popdown()
        return False

    def filters_active_changed(self, *_args):
        if not self.is_active():
            self.close_filters_popover()

    def filters_outside_press(self, _gesture, _count, x, y):
        if not self.filter_popover.get_visible():
            return
        point = Graphene.Point().init(x, y)
        for widget in (self.filter_popover, self.filters_pill):
            found, bounds = widget.compute_bounds(self)
            if found and bounds.contains_point(point):
                return
        self.close_filters_popover()

    def filters_popover_closed(self, *_args):
        self.filters_pill.set_has_tooltip(True)
        self.sync_filter_chips()

    def rebuild_filters_popover(self):
        model = self.filter_model
        if model == self.filter_popover_signature and self.filter_popover.get_child() is not None:
            self.sync_filters_popover_checks()
            return
        self.filter_popover_signature = model
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        scroller = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER,
                                      vscrollbar_policy=Gtk.PolicyType.AUTOMATIC)
        scroller.set_max_content_height(440)
        scroller.set_propagate_natural_height(True)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0, margin_end=10)
        scroller.set_child(body)
        root.append(scroller)
        self.filter_popover_rows = {}

        def add_check(action, name, checked=False, mixed=False, indent=False, glyph=None, color="", switch=False):
            if switch:
                row = Gtk.Box(spacing=10, margin_top=3, margin_bottom=3, margin_start=8, margin_end=8)
                row.add_css_class("asb-filter-row")
                name_label = label(name, "body")
                name_label.set_hexpand(True)
                row.append(name_label)
                control = Gtk.Switch(active=checked, valign=Gtk.Align.CENTER)
                control.set_can_target(True)
                control.set_focusable(True)
                control.update_property([Gtk.AccessibleProperty.LABEL], [name])
                control.connect("notify::active", self.filter_switch_toggled, action)
                switch_keys = Gtk.EventControllerKey()
                switch_keys.connect("key-pressed", self.filter_switch_key, control)
                control.add_controller(switch_keys)
                row.append(control)
                row.asb_filter_switch = control
                gesture = Gtk.GestureClick()
                gesture.connect("pressed", lambda _g, _n, _x, _y, s=control: s.set_active(not s.get_active()))
                name_label.add_controller(gesture)
            else:
                row = Gtk.CheckButton()
                row.add_css_class("asb-filter-row")
                if indent:
                    row.add_css_class("asb-filter-indent")
                content = Gtk.Box(spacing=10, margin_top=3, margin_bottom=3, margin_start=10, margin_end=8)
                if glyph is not None:
                    icon = Gtk.Image(pixel_size=14)
                    set_icon(icon, glyph)
                    content.append(icon)
                if color:
                    dot = self.chip_dot()
                    dot.set_visible(True)
                    content.append(dot)
                    self.paint_dot(dot, color)
                label_widget = label(name, "body")
                label_widget.set_hexpand(True)
                content.append(label_widget)
                row.set_child(content)
                row.set_active(checked)
                row.set_inconsistent(mixed)
                row.connect("toggled", self.filter_row_toggled, action)
            row.update_property([Gtk.AccessibleProperty.LABEL], [name])
            self.filter_popover_rows[action] = row
            return row

        def add_header(text, top=False):
            head = label(text, "caption")
            head.add_css_class("asb-filter-head")
            if top:
                head.add_css_class("asb-filter-head-top")
            head.set_halign(Gtk.Align.START)
            head.set_margin_start(8)
            head.set_margin_end(8)
            return head

        body.append(add_check("pending", "Pending", self.pending))
        body.append(Gtk.Separator(margin_top=4, margin_bottom=4))
        body.append(add_header("State", top=True))
        for state in STATES:
            body.append(add_check(f"state:{state}", state.capitalize(), state in self.states))
        body.append(Gtk.Separator(margin_top=4, margin_bottom=4))
        body.append(add_header("Profiles", top=True))
        machine_count = len(model)
        for machine in model:
            if machine_count > 1:
                body.append(add_header(machine["machineName"] or "This machine"))
            for app in machine["apps"]:
                profiles = app["profiles"]
                if not profiles:
                    continue
                glyph = provider_icon(app["provider"])
                if len(profiles) == 1:
                    profile = profiles[0]
                    body.append(add_check(f"profile:{profile['key']}", profile["label"],
                                          profile["key"] in self.profiles, glyph=glyph, color=profile["color"]))
                    continue
                keys = [profile["key"] for profile in profiles]
                on = sum(key in self.profiles for key in keys)
                body.append(add_check(f"app:{machine['machine']}:{app['provider']}",
                                      APP_NAMES.get(app["provider"], app["provider"]),
                                      checked=on == len(keys), mixed=0 < on < len(keys), glyph=glyph))
                for profile in profiles:
                    body.append(add_check(f"profile:{profile['key']}", profile["label"],
                                          profile["key"] in self.profiles, indent=True, color=profile["color"]))
        body.append(Gtk.Separator(margin_top=4, margin_bottom=4))
        body.append(add_check("archive", "Include archived", self.archived, switch=True))
        footer = Gtk.Button(label="Clear filters", hexpand=True)
        footer.add_css_class("asb-filter-footer")
        footer.set_sensitive(self.filters_active())
        footer.connect("clicked", self.filter_row_clicked, "clear")
        self.filter_popover_rows["clear"] = footer
        root.append(footer)
        self.filter_popover.set_child(root)

    def filter_row_clicked(self, _button, action):
        if action == "clear":
            self.clear_filters()
            self.filter_popover.popdown()
            self.filters_pill.grab_focus()

    def app_profile_keys(self, action):
        """The profile keys of an app:<machine>:<provider> row of the Filters popover."""
        _kind, machine, provider = action.split(":", 2)
        keys = []
        for entry in self.filter_model:
            if entry["machine"] != machine:
                continue
            for app in entry["apps"]:
                if app["provider"] == provider:
                    keys = [profile["key"] for profile in app["profiles"]]
        return keys

    def filter_row_toggled(self, button, action):
        if getattr(button, "asb_syncing", False):
            return
        on = button.get_active()
        if action == "pending":
            self.set_pending(on)
        elif action.startswith("state:"):
            state = action.split(":", 1)[1]
            if on:
                self.states.add(state)
            else:
                self.states.discard(state)
            self.filter_changed()
        elif action.startswith("profile:"):
            key = action.split(":", 1)[1]
            if not on:
                self.profiles.discard(key)
            elif key in {profile["key"] for machine in self.filter_model for app in machine["apps"] for profile in app["profiles"]}:
                # A popover row can be older than the model; a profile that left the model is not added.
                self.profiles.add(key)
            self.filter_changed()
        elif action.startswith("app:"):
            keys = self.app_profile_keys(action)
            if keys:
                if on:
                    self.profiles.update(keys)
                else:
                    self.profiles.difference_update(keys)
                self.filter_changed()
        self.sync_filters_popover_checks()

    def filter_switch_key(self, _controller, key, _code, modifiers, switch):
        if key in (Gdk.KEY_space, Gdk.KEY_KP_Space) and not modifiers & SHORTCUT_MASK:
            switch.set_active(not switch.get_active())
            return True
        return False

    def filter_switch_toggled(self, switch, _param, _action):
        if getattr(switch, "asb_syncing", False):
            return
        self.set_archived(switch.get_active())
        self.sync_filters_popover_checks()

    def sync_filters_popover_checks(self):
        for action, row in self.filter_popover_rows.items():
            if action == "clear":
                row.set_sensitive(self.filters_active())
                continue
            if action == "pending":
                self.set_row_check(row, self.pending)
            elif action == "archive":
                if getattr(row, "asb_filter_switch", None):
                    row.asb_filter_switch.asb_syncing = True
                    row.asb_filter_switch.set_active(self.archived)
                    row.asb_filter_switch.asb_syncing = False
            elif action.startswith("state:"):
                self.set_row_check(row, action.split(":", 1)[1] in self.states)
            elif action.startswith("profile:"):
                self.set_row_check(row, action.split(":", 1)[1] in self.profiles)
            elif action.startswith("app:"):
                keys = self.app_profile_keys(action)
                on = sum(key in self.profiles for key in keys)
                self.set_row_check(row, on == len(keys), mixed=0 < on < len(keys))
        self.update_filters_pill()

    @staticmethod
    def set_row_check(row, checked, mixed=False):
        row.asb_syncing = True
        row.set_active(checked)
        row.set_inconsistent(mixed)
        row.asb_syncing = False

    def filter_popover_key(self, _controller, key, _code, state):
        if key == Gdk.KEY_Escape:
            self.filter_popover.popdown()
            self.filters_pill.grab_focus()
            return True
        if key in (Gdk.KEY_Up, Gdk.KEY_Down) and not state & SHORTCUT_MASK:
            direction = Gtk.DirectionType.TAB_FORWARD if key == Gdk.KEY_Down else Gtk.DirectionType.TAB_BACKWARD
            focus = self.get_focus()
            if focus is None or focus.get_ancestor(Gtk.Popover) is not self.filter_popover:
                self.filters_pill.grab_focus()
                return True
            if not self.filter_popover.child_focus(direction):
                self.filter_popover.get_child().set_focus_child(None)
                self.filter_popover.child_focus(direction)
            return True
        return False

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

    def new_column(self):
        listing = SessionColumn(selection_mode=Gtk.SelectionMode.NONE, activate_on_single_click=True,
                                valign=Gtk.Align.START, hexpand=False, width_request=self.column_pixel_width)
        listing.add_css_class("asb-column")
        listing.asb_activation = listing.connect("row-activated", self.open_row)
        listing.asb_width = self.column_pixel_width
        return listing

    def mend_columns(self, listings, targets, exact=False):
        """Replace all columns when one of them lists a card that is no child, a card twice, or (with exact) not its target.
        Returns the cards that it took out of their columns. GTK has no call that removes a stale entry from the internal list."""
        if all((cards := column_cards(listing)) == listed_cards(listing) and (not exact or cards == target)
               for listing, target in zip(listings, targets)):
            return []
        detached = [card for listing in listings for card in column_cards(listing)]
        for card in detached:
            card.unparent()
        for number, old in enumerate(listings):
            listings[number] = self.new_column()
            if old.get_parent():
                self.list_body.insert_child_after(listings[number], old)
                self.list_body.remove(old)
            old.disconnect(old.asb_activation)
            self.retired_columns.append(old)
            for card in targets[number]:
                if card.get_parent() is None:
                    listings[number].append(card)
        return detached

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
        drawer = sum(bool(row.get("drawer")) and (not row.get("archived") or self.archived)
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
            self.hover_after_layout = True
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
            self.list_body.clear_hover(copy_tag=False)
        dashboard_ids = {row["id"] for row in self.dashboard.get("threads", [])}
        # The More card stays in the cache when it is not on the board.
        for identity in self.row_cache.keys() - dashboard_ids - {MORE_ID}:
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
                listings.append(self.new_column())
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
            # The cards of a column come from the widget tree, which is what GTK draws.
            targets = [[self.focus_widgets[row["id"]] for row in parts[number]] if number < len(parts) else [] for number in range(len(listings))]
            focus_row = self.focus_widgets.get(self.focus_key())
            detached = self.mend_columns(listings, targets)
            moves = [(listing, *column_moves(column_cards(listing), target)) for listing, target in zip(listings, targets)]
            refocus = focus_widget is not None and (focus_row in detached or any(focus_row in removals for _listing, removals, _inserts in moves))
            for listing, removals, _inserts in moves:
                for widget in removals:
                    listing.remove(widget)
            for listing, _removals, inserts in moves:
                for index, widget in inserts:
                    # A card that still has a parent (the same card twice in a column target) leaves it first, or GTK lists it twice.
                    if widget.get_parent():
                        widget.get_parent().remove(widget)
                        if widget.get_parent():
                            widget.unparent()
                    listing.insert(widget, index)
            # GTK lays out the internal list of a column, so a column that differs from its cards or its target shows a gap.
            detached = self.mend_columns(listings, targets, exact=True)
            refocus = refocus or focus_widget is not None and focus_row in detached
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
        # Hidden cards stay cached for a quick return, up to twice the card limit (+1 is the More card); an idle step releases the rest after the frame.
        if self.card_limit and not self.show_all_cards and len(self.row_cache) > 2 * self.card_limit + 1 and self.row_cache_trim is None:
            self.row_cache_trim = GLib.idle_add(self.trim_row_cache)

    def trim_row_cache(self):
        self.row_cache_trim = None
        if self.closed or not self.card_limit or self.show_all_cards or len(self.row_cache) <= 2 * self.card_limit + 1:
            return False
        # The row keeps its other state (open errors): a new card for it shows that state.
        for identity in self.row_cache.keys() - self.focus_widgets.keys() - {MORE_ID}:
            self.release_row(self.row_cache.pop(identity))
        return False

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
        widget.add_css_class("asb-unhovered")
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
        # The row panel opens on the right-button release. A panel that maps while the button is down gets the
        # pointer grab with no pointer enter, and GDK then takes the next click on the panel for a click outside it.
        for controller, signals in (
                (Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE), (("key-pressed", self.row_key),)),
                (Gtk.EventControllerFocus(), (("enter", self.row_focus),)),
                (Gtk.EventControllerMotion(), (("notify::contains-pointer", self.row_hover),)),
                (Gtk.GestureClick(button=3), (("released", self.row_context),)),
                (Gtk.DragSource(actions=Gdk.DragAction.MOVE), (("prepare", self.pin_drag_prepare),
                                                          ("drag-end", self.pin_drag_end))),
                (Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE), (("drop", self.pin_drop),))):
            handlers = [controller.connect(name, callback, row["id"]) for name, callback in signals]
            widget.asb_handlers.append((controller, handlers))
            widget.add_controller(controller)
        self.update_session_row(widget, row)
        return widget

    def row_hover(self, controller, *_args):
        # A class on the card in place of the hover pseudo-class, so a hover change on the strip or a column does not restyle every card.
        self.set_row_hover(controller.get_widget(), controller.contains_pointer())

    def set_row_hover(self, widget, hovered):
        previous = getattr(self, "hovered_card", None)
        if hovered:
            if previous is not None and previous is not widget:
                self.set_row_hover(previous, False)
            self.hovered_card = widget
        elif previous is widget:
            self.hovered_card = None
        widget.add_css_class("asb-hovered" if hovered else "asb-unhovered")
        widget.remove_css_class("asb-unhovered" if hovered else "asb-hovered")
        if not hovered:
            self.hide_copy_tag(getattr(widget, "asb_copy_button", None), keep_focused=True)

    def sync_row_hover(self):
        surface = self.get_surface()
        picked = None
        if surface is not None:
            found, x, y, _mask = surface.get_device_position(self.get_display().get_default_seat().get_pointer())
            left, top = self.get_surface_transform()
            picked = self.pick(x - left, y - top, Gtk.PickFlags.DEFAULT) if found else None
        row = picked.get_ancestor(Gtk.ListBoxRow) if picked else None
        if row is not None and row.is_ancestor(self.list_body) and row in self.focus_widgets.values():
            self.set_row_hover(row, True)
        elif getattr(self, "hovered_card", None) is not None:
            self.set_row_hover(self.hovered_card, False)

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
        # Free the panel first, or GTK frees its card and leaves the panel pointing to freed memory.
        child = widget.get_first_child()
        while child:
            next_child = child.get_next_sibling()
            if isinstance(child, Gtk.Popover):
                child.popdown()
                child.unparent()
            child = next_child
        if widget.get_parent():
            widget.get_parent().remove(widget)

    def query_row_tooltip(self, widget, _x, _y, _keyboard, tooltip):
        if self.closed:
            return False
        row = widget.asb_thread
        if row.get("id") == MORE_ID:
            tooltip.set_text(f"{row['asbMore']} more sessions after the first {row['asbLimit']}. Click to show all cards.")
            return True
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
        def text(value, css=None, indent=0):
            widget = label(value, css)
            widget.set_wrap(True)
            widget.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
            widget.set_max_width_chars(36)
            widget.set_margin_start(indent)
            return widget
        path = Gtk.Box(spacing=7)
        mark = Gtk.Image(pixel_size=14, valign=Gtk.Align.START)
        set_icon(mark, provider_icon(row.get("provider")))
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
        if model["state"] != "working" and not row.get("pending"):
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
                notes.append(text(model["limit"]))
            if model["note"]:
                line = Gtk.Box(spacing=7)
                if model["indicator"]:
                    mark = Gtk.Box(valign=Gtk.Align.CENTER)
                    mark.add_css_class("asb-dot")
                    if model["indicator"] in ("question", "alert"):
                        mark.add_css_class("asb-" + model["indicator"])
                        mark.append(label("?" if model["indicator"] == "question" else "!"))
                    elif model["indicator"] in ("stop", "discard"):
                        mark.add_css_class("asb-" + model["indicator"])
                    line.append(mark)
                note = text(model["note"])
                if not model["indicator"]:
                    note.add_css_class("asb-tooltip-muted")
                line.append(note)
                notes.append(line)
            if model["flags"]:
                flags = text(model["flags"], "asb-tooltip-flags")
                flags.add_css_class("asb-tooltip-muted")
                notes.append(flags)
            if model["error"]:
                notes.append(text(model["error"]))
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
        if layout_changed or ((attention_indicator(row) in ("question", "alert", "dot", "stop")
                               or row.get("discardResult") != widget.asb_thread.get("discardResult"))
                              and attention_signature(widget.asb_thread) != attention_signature(row)):
            self.clear_read_feedback(widget)
        if getattr(widget, "asb_thread", row).get("state") != row.get("state"):
            self.open_errors.pop(row["id"], None)
        widget.asb_thread = dict(row)
        self.update_drawer_style(widget)
        quiet = self.view == "comfortable" and row.get("state") in ("idle", "waiting") \
            and not (row.get("unread") or row.get("questionAttention") or row.get("pending"))
        (widget.add_css_class if quiet else widget.remove_css_class)("asb-idle-read")
        widget.set_activatable(bool(row.get("canOpen")))
        if layout_changed:
            widget.asb_view = self.view
            widget.asb_action_signature = None
            self.cancel_card_copy(widget)
            for name in ("asb_folder", "asb_pin_button", "asb_read_button", "asb_drawer_button", "asb_copy_button", "asb_age_label", "asb_limited",
                         "asb_mute_glyph", "asb_where_icon", "asb_where_label", "asb_more_glyph", "asb_copy_tag", "asb_copy_words",
                         "asb_copy_dot_relative", "asb_copy_dot_absolute", "asb_feedback", "asb_feedback_label", "asb_footer_stack"):
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
            if number and self.numbers_shown:
                number_label.add_css_class("asb-number-shown")
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
            mute = Gtk.Image(pixel_size=12, visible=False, valign=Gtk.Align.CENTER)
            set_icon(mute, "asb-muted-symbolic")
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
                line = Gtk.Box(spacing=6)
                line.append(clock)
                line.append(state)
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
                line.append(right)
                feedback = Gtk.Box(spacing=6)
                feedback.add_css_class("asb-copy-feedback")
                feedback_icon = Gtk.Image(icon_name="object-select-symbolic", pixel_size=12)
                feedback_label = label("", "caption")
                feedback_label.add_css_class("asb-copy-feedback")
                feedback.append(feedback_icon)
                feedback.append(feedback_label)
                # The done text replaces the footer line for 1.6 s; the limit clock keeps its own rule on the line.
                footer = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE, transition_duration=100,
                                   hhomogeneous=True, vhomogeneous=True, margin_start=21)
                footer.add_named(line, "line")
                footer.add_named(feedback, "copied")
                widget.asb_feedback, widget.asb_feedback_label = feedback, feedback_label
                widget.asb_footer_stack = footer
                content.append(footer)
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
                # The kind tag slides out to the left of the copy button, over the folder line.
                tag_words = Gtk.Stack(transition_type=Gtk.StackTransitionType.SLIDE_UP, transition_duration=200)
                for name in COPY_KINDS:
                    word = label(COPY_KIND_WORDS[name], "asb-copy-tag-word")
                    tag_words.add_named(word, name)
                tag_dots = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3, valign=Gtk.Align.CENTER)
                tag_dot_relative = Gtk.Box()
                tag_dot_relative.add_css_class("asb-copy-tag-dot")
                tag_dot_absolute = Gtk.Box()
                tag_dot_absolute.add_css_class("asb-copy-tag-dot")
                tag_dots.append(tag_dot_relative)
                tag_dots.append(tag_dot_absolute)
                tag_box = Gtk.Box(spacing=6, valign=Gtk.Align.CENTER)
                tag_box.add_css_class("asb-copy-tag")
                tag_box.append(tag_words)
                tag_box.append(tag_dots)
                tag = Gtk.Revealer(transition_type=Gtk.RevealerTransitionType.SLIDE_RIGHT, transition_duration=200,
                                   reveal_child=False, child=tag_box)
                actions.append(tag)
                for button, name in ((copy, "copy"), (drawer, "drawer"), (read, "read"), (pin, "pin")):
                    button.add_css_class("flat")
                    button.add_css_class("asb-card-action")
                    button.add_css_class("asb-" + name + "-button")
                    button.asb_card_action = name
                    button.asb_identity, button.asb_action = row["id"], None
                    button.connect("clicked", self.card_action_clicked)
                copy.asb_card, copy.asb_tag, copy.asb_tag_shown, copy.asb_rest_at = widget, tag, False, None
                copy_motion = Gtk.EventControllerMotion()
                copy_motion.connect("enter", self.copy_button_enter)
                copy_motion.connect("leave", self.copy_button_leave)
                copy.add_controller(copy_motion)
                copy.connect("unmap", self.copy_button_unmap)
                widget.asb_drawer_button, widget.asb_read_button, widget.asb_pin_button = drawer, read, pin
                widget.asb_copy_button = copy
                widget.asb_copy_tag, widget.asb_copy_words = tag, tag_words
                widget.asb_copy_dot_relative, widget.asb_copy_dot_absolute = tag_dot_relative, tag_dot_absolute
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
        set_icon(widget.asb_mark, provider_icon(row.get("provider")))
        widget.asb_source_badge.set_color(source_marker_color(row))
        where_icon, where = row_where(row)
        if widget.asb_where_icon:
            if where_icon:
                set_icon(widget.asb_where_icon, where_icon)
            widget.asb_where_icon.set_visible(bool(where))
        widget.asb_where_label.set_label((where + " ·" if widget.asb_where_icon else "· " + where) if where else "")
        widget.asb_where_label.set_visible(bool(where))
        tone = view_only_tone(row)
        (widget.add_css_class if tone else widget.remove_css_class)("asb-view-only-quiet")
        (widget.add_css_class if tone == "rest" else widget.remove_css_class)("asb-view-only-rest")
        indicator = attention_indicator(row, True)
        (widget.add_css_class if indicator in ("dot", "alert") else widget.remove_css_class)("asb-unread")
        (widget.add_css_class if indicator == "dot" and not row.get("unread") else widget.remove_css_class)("asb-drawer")
        discard_offer = self.view == "comfortable" and row.get("state") in ("working", "idle") and not indicator and not row.get("muted") \
            and not row.get("remote")
        if getattr(widget, "asb_mute_glyph", None):
            widget.asb_mute_glyph.set_visible(bool(row.get("muted")))
        widget.asb_dot.set_visible(bool(indicator) or discard_offer)
        widget.asb_dot.get_first_child().set_visible(indicator in ("question", "alert"))
        widget.asb_dot.get_first_child().set_label("!" if indicator == "alert" else "?")
        (widget.asb_dot.add_css_class if indicator == "alert" else widget.asb_dot.remove_css_class)("asb-alert")
        (widget.asb_dot.add_css_class if indicator == "question" else widget.asb_dot.remove_css_class)("asb-question")
        (widget.asb_dot.add_css_class if indicator == "stop" else widget.asb_dot.remove_css_class)("asb-stop")
        (widget.asb_dot.add_css_class if indicator == "discard" or discard_offer else widget.asb_dot.remove_css_class)("asb-discard")
        state = widget.asb_state_label
        for css in (*("asb-" + value for value in STATES), "success", "dim-label"):
            state.remove_css_class(css)
        state.add_css_class("asb-" + row.get("state", "unknown"))
        if row.get("state") == "working":
            state.add_css_class("success")
        elif not row.get("pending"):
            state.add_css_class("dim-label")
        if self.view == "comfortable":
            widget.asb_folder.set_label(row.get("projectName") or "No project")
            self.update_card_actions(widget)
        if row.get("id") == MORE_ID:
            widget.asb_mark.set_from_icon_name("view-more-horizontal-symbolic")
            widget.set_activatable(True)
            if self.view == "comfortable":
                widget.asb_folder.set_label(f"After the first {row['asbLimit']}")
                if not getattr(widget, "asb_more_glyph", None):
                    glyph = Gtk.Image(icon_name="go-next-symbolic", pixel_size=11, valign=Gtk.Align.CENTER)
                    glyph.add_css_class("dim-label")
                    widget.asb_state_label.get_parent().insert_child_after(glyph, widget.asb_state_label)
                    widget.asb_more_glyph = glyph
        widget.asb_time_signature = None
        self.update_row_text(widget)

    def clear_read_feedback(self, widget):
        if getattr(widget, "asb_read_timer", None):
            GLib.source_remove(widget.asb_read_timer)
        widget.asb_read_timer = None
        widget.asb_read_generation = getattr(widget, "asb_read_generation", 0) + 1

    def card_action_clicked(self, button):
        # A clicked handler, not an action name: GTK made each card move slower over time with action names on card buttons.
        if button.asb_action:
            self.activate_action(button.asb_action, GLib.Variant("s", button.asb_identity))

    def copy_has_keyboard_focus(self, button):
        return self.get_focus() is button and self.get_focus_visible()

    def pointer_on(self, widget):
        """True when the pointer is over the widget or over a widget inside it."""
        surface = self.get_surface()
        if surface is None:
            return False
        found, x, y, _mask = surface.get_device_position(self.get_display().get_default_seat().get_pointer())
        left, top = self.get_surface_transform()
        picked = self.pick(x - left, y - top, Gtk.PickFlags.DEFAULT) if found else None
        return picked is not None and (picked is widget or picked.is_ancestor(widget))

    def show_copy_tag(self, button, shown):
        tag = getattr(button, "asb_tag", None)
        if tag is None:
            return
        button.asb_tag_shown = bool(shown)
        tag.set_reveal_child(bool(shown))
        if getattr(button, "asb_card", None) is not None and button.asb_card.asb_view == "comfortable":
            button.asb_card.asb_action_signature = None
            self.update_card_actions(button.asb_card)

    def hide_copy_tag(self, button, keep_focused=False):
        # Safety net when leave does not fire: card hover ends, the button unmaps, or the card is released.
        if button is None:
            return
        if getattr(self, "copy_hover", None) is button:
            self.copy_hover = None
            button.asb_rest_at = None
            if getattr(self, "copy_rest_timer", None):
                GLib.source_remove(self.copy_rest_timer)
                self.copy_rest_timer = None
        if keep_focused and self.copy_has_keyboard_focus(button):
            return
        if getattr(button, "asb_tag_shown", False):
            self.show_copy_tag(button, False)

    def copy_button_enter(self, controller, _x, _y):
        button = controller.get_widget()
        # The rest counts from the enter into the button. Motion inside it does not restart the timer.
        if self.copy_hover is button:
            return
        self.copy_hover = button
        button.asb_rest_at = time.monotonic()
        if self.copy_rest_timer:
            GLib.source_remove(self.copy_rest_timer)
        self.copy_rest_timer = GLib.timeout_add(int(COPY_REST_S * 1000), self.copy_tag_due, button)

    def copy_button_unmap(self, button, *_args):
        self.hide_copy_tag(button, keep_focused=False)

    def copy_button_leave(self, controller):
        # Leave runs before contains-pointer turns false, so this handler must not read it.
        button = controller.get_widget()
        if self.copy_hover is button:
            self.copy_hover = None
            button.asb_rest_at = None
            if self.copy_rest_timer:
                GLib.source_remove(self.copy_rest_timer)
                self.copy_rest_timer = None
        if not self.copy_has_keyboard_focus(button):
            self.show_copy_tag(button, False)

    def copy_tag_due(self, button):
        self.copy_rest_timer = None
        if self.copy_hover is button:
            self.show_copy_tag(button, True)
        return False

    def update_card_actions(self, widget):
        if widget.asb_view != "comfortable":
            return
        if widget.asb_thread.get("id") == MORE_ID:
            # No card actions: the whole corner goes, so its title fade does not paint on hover.
            widget.asb_copy_button.get_parent().set_visible(False)
            return
        row, read, pin = widget.asb_thread, widget.asb_read_button, widget.asb_pin_button
        drawer = getattr(widget, "asb_drawer_button", None)
        pending = row["id"] in self.session_actions
        indicator = attention_indicator(row, True)
        copy_choice = card_copy(row, self.copy_kind)
        signature = (indicator, row.get("state"), row.get("actionRequired"), row.get("actionAttention"), row.get("unread"), row.get("discardResult"),
                     row.get("pinned"), row.get("drawer"), row.get("muted"), row.get("title"), pending, bool(widget.asb_read_timer),
                     self.column_pixel_width >= 190, bool(getattr(widget, "asb_copy_timer", None)), copy_choice,
                     getattr(getattr(widget, "asb_copy_button", None), "asb_tag_shown", False) is True)
        if signature == getattr(widget, "asb_action_signature", None):
            return
        widget.asb_action_signature = signature
        unread = bool(row.get("actionAttention") or row.get("unread")) if row.get("actionRequired") \
            else indicator in ("question", "alert", "dot")
        idle = row.get("state") == "idle"
        # An Idle row offers Discard for its next task when it has no mark. The check after a Read keeps the slot until it ends.
        discard = not row.get("muted") and not row.get("remote") and (
            row.get("state") == "working" and indicator not in ("question", "alert", "dot")
            or idle and (indicator == "discard" or not indicator and not widget.asb_read_timer))
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
        read.asb_action = (action if discard else "win.mark-read") if (unread or discard) and not pending else None
        if confirmed:
            read.add_css_class("asb-read-confirmed")
        else:
            read.remove_css_class("asb-read-confirmed")
        pinned = bool(row.get("pinned"))
        pin.asb_action = ("win.unpin" if pinned else "win.pin") if not pending else None
        (pin.add_css_class if pinned else pin.remove_css_class)("asb-pinned")
        # Keep native gestures active so busy controls and the Read cue cannot open the row.
        read_text = ("A user action is required in the original app. Mark read in ASB" if unread
                     else "A user action is required in the original app") if row.get("actionRequired") else "Task stopped" \
            if indicator == "stop" else "Read in ASB" if confirmed else "Mark read in ASB"
        if discard:
            read_text = ("Keep result: show the dot when the next task ends" if idle else "Keep result: show the dot when this task ends") \
                if row.get("discardResult") else ("Discard next result: go to read Idle when the next task ends" if idle
                                                  else "Discard result: go to read Idle when this task ends")
        controls = [(read, read_text, (unread or discard) and not pending), (pin, "Unpin in ASB" if pinned else "Pin in ASB", not pending)]
        if drawer:
            tucked = bool(row.get("drawer"))
            shown = self.column_pixel_width >= 190 and (tucked or indicator in ("dot", "alert"))
            drawer.set_visible(shown)
            (drawer.add_css_class if tucked else drawer.remove_css_class)("asb-drawer-filled")
            drawer.asb_action = ("win.drawer-out" if tucked else "win.drawer-in") if not pending else None
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
            value, reason, kind = copy_choice
            wide, copied = self.column_pixel_width >= 190, bool(widget.asb_copy_timer and value)
            tag_shown = getattr(copy, "asb_tag_shown", False) is True
            copy.set_visible(wide)
            (copy.get_parent().add_css_class if wide else copy.get_parent().remove_css_class)("asb-corner-wide")
            # With no reference to copy the button keeps its place, but has no action and says why.
            copy.asb_action = "win.copy-reference" if value else None
            (copy.add_css_class if not value else copy.remove_css_class)("asb-copy-off")
            copy.update_state([Gtk.AccessibleState.DISABLED], [not value])
            glyph = "object-select-symbolic" if copied else COPY_KIND_ICONS[kind] if tag_shown else "edit-copy-symbolic"
            set_icon(copy.get_child(), glyph)
            (copy.add_css_class if copied else copy.remove_css_class)("asb-copy-confirmed")
            done = COPY_DONE_TEXT[kind] if copied else None
            # The footer shows the copied text, so a copy keeps the tooltip as it is.
            if row.get("remote") is True:
                tip = reason or f"Copy absolute reference. {copy_relative_reason(row)}"
            else:
                tip = reason or f"Copy {kind} reference"
            if copy.get_tooltip_text() != tip:
                copy.set_tooltip_text(tip)
            copy.update_property([Gtk.AccessibleProperty.LABEL], [f"Copy {kind} reference: " + row.get("title", "Untitled session")])
            if done:
                copy.update_property([Gtk.AccessibleProperty.DESCRIPTION], [done])
            else:
                copy.reset_property(Gtk.AccessibleProperty.DESCRIPTION)
            self.update_copy_tag(widget, kind, row.get("remote") is True)
            self.update_copy_feedback(widget, done)

    def update_copy_tag(self, widget, kind, remote):
        tag, copy = getattr(widget, "asb_copy_tag", None), getattr(widget, "asb_copy_button", None)
        if tag is None or copy is None:
            return
        words = getattr(widget, "asb_copy_words", None)
        if words and words.get_visible_child_name() != kind:
            words.set_transition_type(Gtk.StackTransitionType.SLIDE_UP if kind == "absolute" else Gtk.StackTransitionType.SLIDE_DOWN)
            words.set_visible_child_name(kind)
        for name, dot in (("relative", getattr(widget, "asb_copy_dot_relative", None)),
                          ("absolute", getattr(widget, "asb_copy_dot_absolute", None))):
            if dot is None:
                continue
            (dot.add_css_class if name == kind else dot.remove_css_class)("asb-copy-tag-on")
            (dot.add_css_class if remote and name == "relative" else dot.remove_css_class)("asb-copy-tag-off")

    def update_copy_feedback(self, widget, done):
        footer, label = getattr(widget, "asb_footer_stack", None), getattr(widget, "asb_feedback_label", None)
        if footer is None or label is None:
            return
        if done:
            label.set_label(done)
        footer.set_visible_child_name("copied" if done else "line")

    def copy_reference(self, _action, target):
        identity = target.get_string()
        widget = self.focus_widgets.get(identity)
        value, _reason, kind = card_copy(widget.asb_thread, self.copy_kind) if widget else (None, None, "")
        if not value or self.closed:
            return
        # The check of an earlier copy must not stay on after this one fails.
        self.cancel_card_copy(widget)
        try:
            self.get_clipboard().set(value)
        except (GLib.Error, TypeError) as error:
            self.open_errors[identity] = f"Cannot copy the {kind} reference: {error}"
            self.update_card_actions(widget)
            self.update_open_state(widget)
            return
        if self.open_errors.get(identity, "").startswith(("Cannot copy the relative reference: ", "Cannot copy the absolute reference: ")):
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
        if row.get("id") == MORE_ID:
            age = meta.split(" · ")[1]
            widget.asb_state_label.set_label("Show all")
            widget.asb_state_label.add_css_class("dim-label")
            if self.view == "comfortable":
                widget.asb_age_label.set_label("from " + age)
            else:
                widget.asb_where_label.set_label("· " + age)
                widget.asb_where_label.set_visible(True)
            widget.asb_title_label.set_label("More sessions")
            widget.asb_open_signature = (False, "")
            widget.update_property([Gtk.AccessibleProperty.LABEL], [
                f"More sessions. {row['asbMore']} sessions after the first {row['asbLimit']}. Activate to show all cards."])
            return
        state_text = "Stopped" if row.get("state") == "idle" and row.get("lastOutcome") in ("failed", "limit") \
            else row.get("state", "unknown").capitalize()
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
        outcome = " Task stopped." if row.get("lastOutcome") == "stopped" \
            else " Usage limit stopped the task." if row.get("lastOutcome") == "limit" \
            else " Task failed." if row.get("lastOutcome") == "failed" or row.get("failedAttention") \
            else " Task completed." if row.get("completionAttention") else ""
        discard = (" Discard is on for the next task." if row.get("state") == "idle" else " Discard is on.") if row.get("discardResult") else ""
        drawer = " In the drawer. Still unread." if row.get("drawer") else ""
        muted = " Muted." if row.get("muted") else ""
        limit = f" Usage limit. Resets in {spoken_limit(left)}." if left else ""
        where = (f" On {row.get('machineName') or 'another machine'}." if row.get("remote") else "") \
            + (" CLI session." if row.get("surface") == "cli" else "") + (" View only." if is_view_only(row) else "")
        widget.asb_accessible_label = f"{action} {row.get('title', 'Untitled session')} in {row.get('providerLabel', '')}. {state_text}.{limit}{manual}{native_unread}{pinned}{question}{retained}{outcome}{discard}{drawer}{muted}{where}"
        self.update_open_state(widget, now_ms)

    def row_key(self, _controller, key, _code, _state, identity):
        # Alt+Up and Alt+Down switch the copy kind on a focused copy button. Ctrl shows the number keycaps.
        if key in (Gdk.KEY_Up, Gdk.KEY_Down) and _state & Gdk.ModifierType.ALT_MASK \
                and not _state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.META_MASK):
            focus = self.get_focus()
            if getattr(focus, "asb_card_action", None) == "copy":
                self.step_copy_kind(getattr(focus, "asb_card", None))
                return True
        if _state & SHORTCUT_MASK or (self.context_menu and self.context_menu.get_visible()):
            return False
        if key in (Gdk.KEY_space, Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            focus = self.get_focus()
            if getattr(focus, "asb_card_action", None):
                if focus.get_sensitive() and getattr(focus, "asb_action", None):
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
        if widget.asb_thread.get("id") == MORE_ID:
            return
        self.hide_numbers()
        if self.context_menu:
            self.context_menu.popdown()
        widget.grab_focus()
        row = widget.asb_thread
        panel = Gtk.Popover(has_arrow=False)
        panel.add_css_class("asb-row-panel")
        panel.asb_identity, panel.asb_signature = row["id"], None
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, width_request=260)
        panel.asb_title = label("", "asb-panel-title")
        panel.asb_title.set_ellipsize(Pango.EllipsizeMode.END)
        # A small natural width keeps a long title from widening the panel; the label fills the panel width.
        panel.asb_title.set_max_width_chars(1)
        panel.asb_title.set_hexpand(True)
        root.append(panel.asb_title)
        def action_row(icon, handler, *data):
            # One flat button per slot: an update changes its icon and label, so the focus stays on the slot.
            content = Gtk.Box(spacing=10)
            button = Gtk.Button(child=content)
            button.asb_icon, button.asb_label = Gtk.Image(pixel_size=14), Gtk.Label(xalign=0, hexpand=True)
            set_icon(button.asb_icon, icon)
            button.asb_label.set_ellipsize(Pango.EllipsizeMode.END)
            content.append(button.asb_icon)
            content.append(button.asb_label)
            button.add_css_class("flat")
            button.add_css_class("asb-panel-action")
            button.connect("clicked", handler, *data)
            root.append(button)
            return button
        panel.asb_open = action_row("go-next-symbolic", self.panel_open)
        # Every row has messages to show: local, remote, and view-only, so the row is always sensitive.
        panel.asb_messages = action_row("asb-chat-symbolic", self.panel_show_messages)
        set_panel_label(panel.asb_messages, "Show messages")
        root.append(Gtk.Separator())
        panel.asb_note = label("Waits for your permission.", "asb-panel-note")
        root.append(panel.asb_note)
        panel.asb_actions = {}
        for slot in dict.fromkeys(slot for slot, _icon in ROW_PANEL_SLOTS.values()):
            panel.asb_actions[slot] = action_row(None, *((self.panel_move_pin, slot[4:]) if slot.startswith("pin-") else (self.panel_action, slot)))
        root.append(Gtk.Separator())
        panel.asb_copy = action_row("edit-copy-symbolic", self.panel_copy, "short")
        panel.asb_copy_full = action_row("edit-copy-symbolic", self.panel_copy, "full")
        for button, text in ((panel.asb_copy, "Copy relative reference"), (panel.asb_copy_full, "Copy absolute reference")):
            set_panel_label(button, text)
            button.asb_label.add_css_class("asb-panel-label")
            # The caption or the reason goes under the label.
            words = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1, hexpand=True)
            button.get_child().remove(button.asb_label)
            words.append(button.asb_label)
            button.asb_caption = label("", "asb-panel-caption")
            button.asb_caption.set_wrap(True)
            button.asb_caption.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
            button.asb_caption.set_ellipsize(Pango.EllipsizeMode.END)
            button.asb_caption.set_max_width_chars(1)
            words.append(button.asb_caption)
            button.get_child().append(words)
        # The absolute reference has no spaces: a plain tooltip would be one very wide line.
        panel.asb_copy_full.set_has_tooltip(True)
        panel.asb_copy_full.connect("query-tooltip", self.query_copy_tooltip)
        panel.asb_copy_timer, panel.asb_copy_error, panel.asb_copy_values, panel.asb_copied, panel.asb_controls = None, "", None, None, None
        # The card tooltip shows a failed action, but the panel covers the card.
        panel.asb_error = label("", "asb-panel-error")
        panel.asb_error.add_css_class("error")
        panel.asb_error.set_wrap(True)
        panel.asb_error.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
        panel.asb_error.set_max_width_chars(1)
        root.append(panel.asb_error)
        # The clamp keeps a long label from widening the panel past about 280px.
        panel.set_child(Adw.Clamp(maximum_size=260, tightening_threshold=260, child=root))
        keys = Gtk.EventControllerKey(propagation_phase=Gtk.PropagationPhase.CAPTURE)
        keys.connect("key-pressed", self.panel_key)
        panel.add_controller(keys)
        motion = Gtk.EventControllerMotion()
        motion.connect("leave", lambda controller: controller.get_widget().get_ancestor(Gtk.Popover).popdown())
        # The popup surface also gets grab crossings outside the visible panel.
        panel.get_child().get_parent().add_controller(motion)
        if gesture:
            motion = Gtk.EventControllerMotion()
            motion.connect("motion", self.panel_pointer_motion)
            panel.add_controller(motion)
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

    def panel_pointer_motion(self, controller, x, y):
        panel = controller.get_widget()
        found, bounds = panel.get_child().get_parent().compute_bounds(panel)
        if found and (x < bounds.origin.x - 24 or x > bounds.origin.x + bounds.size.width + 24
                      or y < bounds.origin.y - 24 or y > bounds.origin.y + bounds.size.height + 24):
            panel.popdown()

    def place_row_panel(self, panel, widget, x, y):
        """GTK keeps a popover inside the monitor only; this keeps the centered panel inside the window."""
        if x is None:
            x, y = widget.get_width() / 2, widget.get_height() / 2
        ok, point = widget.compute_point(self, Graphene.Point().init(x, y))
        if not ok:
            return
        # A popover measures 0 before it maps; its child plus the 8px padding and the 1px ring on each side is the size.
        child = panel.get_child()
        width = child.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
        height = child.measure(Gtk.Orientation.VERTICAL, width)[1] + 18
        width += 18
        px, py, side = panel_place(point.x, point.y, width, height, self.get_width(), self.get_height())
        ok, local = self.compute_point(widget, Graphene.Point().init(px, py))
        rectangle = Gdk.Rectangle()
        rectangle.x, rectangle.y, rectangle.width, rectangle.height = round(local.x), round(local.y), 1, 1
        panel.set_pointing_to(rectangle)
        panel.set_position(Gtk.PositionType.TOP if side == "top" else Gtk.PositionType.BOTTOM)

    def update_row_panel(self, panel, row):
        """Show the row data in the open panel; an unchanged row keeps every widget as it is."""
        pending = row["id"] in self.session_actions
        # While an action for the row runs, the action rows keep their labels.
        controls = panel.asb_controls if pending and panel.asb_controls is not None else row_panel_controls(row)
        model = tooltip_model(row, time.time() * 1000, Path.home(), "", self.drawer_view)
        values = copy_values(row)
        signature = (model["title"], model["path"], model["app"], bool(row.get("canOpen")), tuple(controls.items()),
                     bool(row.get("actionRequired")), pending, row["id"] in self.opening, self.open_errors.get(row["id"], ""), values,
                     panel.asb_copied, panel.asb_copy_error, row_where(row))
        if signature == panel.asb_signature:
            return
        panel.asb_signature, panel.asb_controls = signature, controls
        if values != panel.asb_copy_values:
            # A new value or an availability change ends the feedback of a copy of the old one.
            panel.asb_copy_values = values
            self.clear_copy_feedback(panel)
        panel.update_property([Gtk.AccessibleProperty.LABEL], [model["title"]])
        panel.asb_title.set_label(" ".join(model["title"].split()))
        panel.asb_title.set_tooltip_text(model["path"] + ("\n" + values[0] if values[0] else ""))
        panel.asb_note.set_visible(bool(row.get("actionRequired")))
        error = self.open_errors.get(row["id"], "") or panel.asb_copy_error
        panel.asb_error.set_label(error)
        panel.asb_error.set_visible(bool(error))
        if is_view_only(row):
            set_panel_label(panel.asb_open, f"On {row_where(row)[1]}" if row.get("remote") else "Runs in a terminal")
            panel.asb_open.set_sensitive(False)
        else:
            set_panel_label(panel.asb_open, "Open in " + model["app"])
            panel.asb_open.set_sensitive(bool(row.get("canOpen")) and row["id"] not in self.opening)
        for slot, button in panel.asb_actions.items():
            button.set_visible(slot in controls)
            if slot in controls:
                _action, text, icon = controls[slot]
                set_panel_label(button, text)
                set_icon(button.asb_icon, icon)
        # A control that turned insensitive under the pointer made GTK pick a new pointer target in the board: the panel got a leave and closed.
        for button in (panel.asb_open, *panel.asb_actions.values()):
            (button.add_css_class if pending else button.remove_css_class)("asb-action-pending")
            button.update_state([Gtk.AccessibleState.BUSY, Gtk.AccessibleState.DISABLED], [pending, pending or not button.get_sensitive()])
        self.show_copy_rows(panel)

    def sync_row_panel(self):
        panel = getattr(self, "context_menu", None)
        if not panel or self.closed:
            return
        widget = self.focus_widgets.get(panel.asb_identity)
        if widget is None or widget is not panel.get_parent():
            panel.popdown()
        else:
            self.update_row_panel(panel, widget.asb_thread)

    def panel_action(self, button, slot):
        # The panel comes from the widget: a panel in the handler data makes a cycle that Python cannot free.
        panel = button.get_ancestor(Gtk.Popover)
        if panel.asb_identity in self.session_actions:
            return
        widget = self.focus_widgets.get(panel.asb_identity)
        action = row_panel_controls(widget.asb_thread).get(slot, (None,))[0] if widget else None
        if action:
            if slot == "mute":
                # The panel covers the card, so Mute and Unmute close it: the card shows its mute icon at once.
                panel.popdown()
            self.activate_action("win." + action, GLib.Variant("s", panel.asb_identity))

    def panel_copy(self, button, slot):
        panel = button.get_ancestor(Gtk.Popover)
        widget = self.focus_widgets.get(panel.asb_identity)
        value = panel.asb_copy_values[0 if slot == "short" else 2] if panel.asb_copy_values else None
        # An unavailable row is focusable but has no action.
        if not widget or self.closed or not value or panel.asb_identity in self.session_actions:
            return
        # A copy ends the check on both rows first.
        self.clear_copy_feedback(panel)
        try:
            self.get_clipboard().set(value)
        except (GLib.Error, TypeError) as error:
            panel.asb_copy_error = f"Cannot copy the {'relative' if slot == 'short' else 'absolute'} reference: {error}"
        else:
            panel.asb_copy_error, panel.asb_copied = "", slot
            self.show_copy_rows(panel)
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
        panel.asb_copied = None
        self.show_copy_rows(panel)

    def show_copy_rows(self, panel):
        """Show the two copy rows from the checked values: caption or reason, tooltip, description, and the copied check."""
        if not panel.asb_copy_values:
            return
        short, short_reason, full, full_reason = panel.asb_copy_values
        pending = panel.asb_identity in self.session_actions
        for slot, button, value, reason, caption, done in (
                ("short", panel.asb_copy, short, short_reason, "Relative: in the same app", COPY_DONE_TEXT["relative"]),
                ("full", panel.asb_copy_full, full, full_reason, "Absolute: with ASB, any machine", COPY_DONE_TEXT["absolute"])):
            copied = panel.asb_copied == slot
            # One reason for both rows shows once, under row 2.
            note = done if copied else caption if value else "" if slot == "short" and reason == full_reason else reason
            button.asb_caption.set_label(note)
            button.asb_caption.set_lines(1 if value else 2)
            button.asb_caption.set_visible(bool(note))
            (button.remove_css_class if value else button.add_css_class)("asb-copy-off")
            (button.add_css_class if note or not value else button.remove_css_class)("asb-panel-captioned")
            (button.add_css_class if copied else button.remove_css_class)("asb-copy-done")
            (button.add_css_class if pending else button.remove_css_class)("asb-action-pending")
            button.update_state([Gtk.AccessibleState.BUSY, Gtk.AccessibleState.DISABLED], [pending, not value or pending])
            set_icon(button.asb_icon, "object-select-symbolic" if copied else "edit-copy-symbolic")
            # The caption shows the copied text, so the tooltip keeps the reference.
            button.asb_tip = value or reason
            if slot == "short":
                button.set_tooltip_text(button.asb_tip)
            button.update_property([Gtk.AccessibleProperty.DESCRIPTION], [done if copied else button.asb_tip])

    def query_copy_tooltip(self, button, _x, _y, _keyboard, tooltip):
        text = Gtk.Label(label=button.asb_tip, xalign=0, wrap=True, max_width_chars=36)
        text.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
        tooltip.set_custom(text)
        return True

    def panel_move_pin(self, button, direction):
        panel = button.get_ancestor(Gtk.Popover)
        if panel.asb_identity in self.session_actions:
            return
        self.activate_action("win.pin-" + direction, GLib.Variant("s", panel.asb_identity))

    def panel_open(self, button):
        panel = button.get_ancestor(Gtk.Popover)
        if panel.asb_identity in self.session_actions:
            return
        widget = self.focus_widgets.get(panel.asb_identity)
        panel.popdown()
        if widget:
            self.open_row(None, widget)

    def panel_show_messages(self, button):
        panel = button.get_ancestor(Gtk.Popover)
        identity, title = panel.asb_identity, panel.asb_title.get_label()
        panel.popdown()
        self.get_application().show_activity("messages", seat=identity, title=title)

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
        elif name == "discard-result":
            # An Idle card arms the next task. A Working card sends no body, so a late click on it still fails when its task is over.
            card = self.focus_widgets.get(identity)
            self.session_action(identity, name, {"next": True} if card and card.asb_thread.get("state") == "idle" else None)
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
        widget.asb_title_label.set_label("Opening…" if opening else card_title(row.get("title", "")))
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
        if row.get("id") == MORE_ID:
            # The focus goes to the first card that the More card stood for; a pointer click keeps the scroll position.
            first = row["asbFirst"] if self.get_focus() is widget else None
            self.show_all_cards = True
            self.sync_filter_chips()
            self.render(preserve_focus=first, reveal_focus=bool(first) and self.get_focus_visible())
            return
        # A real click on a card button does not reach the row (the button has no action name to lose, so GTK keeps its claim).
        # A click on the card body while a card action is in flight does, so the busy guard stays.
        if not row.get("canOpen") or row["id"] in self.opening or row["id"] in self.session_actions:
            return
        self.opening.add(row["id"])
        self.open_errors.pop(row["id"], None)
        self.update_open_state(widget)
        self.sync_row_panel()
        def finished(_result, error):
            if not self.closed:
                self.opening.discard(row["id"])
                if error:
                    self.open_errors[row["id"]] = error
                current = self.focus_widgets.get(row["id"])
                if current:
                    self.update_open_state(current)
                self.sync_row_panel()
                if not error:
                    self.refresh(queue=True)
            return False
        request_async(self.base, "/api/threads/" + quote(row["id"], safe="") + "/open", finished, GLib.idle_add, "POST")

    def on_close(self, *_args):
        if self.closed:
            return False
        self.closed = True
        self.report_ui_closed()
        self.pending_messages = []
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
        for name in ("timer", "clock_timer", "geometry_idle", "notice_timer", "row_cache_trim"):
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


def rgba(value):
    color = Gdk.RGBA()
    color.parse(value)
    return color


def hex_color(color):
    return "#" + "".join(f"{max(0, min(255, round(channel * 255))):02x}" for channel in (color.red, color.green, color.blue))


def native_colors(widget):
    context = widget.get_style_context()
    colors = {}
    for key, name in (("background", "window_bg_color"), ("text", "window_fg_color"),
                      ("accent", "accent_color"), ("muted", "window_fg_color"), ("divider", "window_fg_color")):
        found, value = context.lookup_color(name)
        if not found:
            value = widget.get_color()
        colors[key] = hex_color(value)
    # GNOME colors seed the editor. Custom text must pass the same contrast check.
    if contrast(colors["accent"], colors["background"]) < 4.5:
        colors["accent"] = colors["text"]
    foreground, background = rgba(colors["text"]), rgba(colors["background"])
    for key, fraction in (("muted", .72), ("divider", .3)):
        value = Gdk.RGBA()
        value.red = foreground.red * fraction + background.red * (1 - fraction)
        value.green = foreground.green * fraction + background.green * (1 - fraction)
        value.blue = foreground.blue * fraction + background.blue * (1 - fraction)
        value.alpha = 1
        colors[key] = hex_color(value)
    return colors


# The Messages and Usage charts draw curves with Gsk.PathBuilder (GTK 4.14).
ACTIVITY_PATHS = hasattr(Gsk, "PathBuilder")
ACTIVITY_WINDOW_CLASSES = {}   # "messages" / "usage" -> the window class; G1 and G2 register their classes here.


class ActivityWindow(Adw.Window):
    """The shared base of the Messages and Usage windows: the period menu, the loading and error pages, and the live refresh."""
    KIND = ""              # "messages" or "usage"
    TITLE = ""             # "Messages" or "Usage"
    ROUTE = ""             # "/api/activity/messages" or "/api/activity/usage"
    PERIODS = ()           # MESSAGE_PERIODS or USAGE_PERIODS
    DEFAULT_PERIOD = ""    # "7d" or "30d"
    DEFAULT_SIZE = (0, 0)  # (968, 760) or (948, 760)
    POLL_SECONDS = 15
    serial = 0

    def __init__(self, application, base, fetch=None, clock=None):
        super().__init__()
        self.set_title(self.TITLE)
        self.set_default_size(*self.DEFAULT_SIZE)
        # GTK 4 has no window position API, so only the size is kept.
        saved = read_window_sizes(THEME_PATH.with_name("activity-windows.json")).get(self.KIND)
        if saved:
            self.set_default_size(*saved[:2])
            if saved[2]:
                self.maximize()
        self.set_application(application)
        self.application = application
        self.base, self.fetch = base, fetch
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.period, self.data = self.DEFAULT_PERIOD, None
        self.closed = self.loading = self.refresh_queued = False
        self.events = self.poll_timer = self.event_timer = None
        self.set_icon_name(APP_ID)
        if os.name == "nt":
            self.connect("realize", set_windows_icon)
        # A class of its own: each window has its own palette provider, and two windows never match each other's rules.
        ActivityWindow.serial += 1
        self.scope_class = f"asb-activity-{ActivityWindow.serial}"
        self.css_scope = "." + self.scope_class
        self.add_css_class("asb-activity")
        self.add_css_class(self.scope_class)
        self.css = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(self.get_display(), self.css, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)

        self.toolbar_view = view = Adw.ToolbarView()
        self.toolbar = Gtk.Box(spacing=4, margin_start=4, margin_end=4, margin_top=2, margin_bottom=2)
        self.toolbar.add_css_class("asb-activity-toolbar")
        self.app_mark = Gtk.Image(icon_name=APP_ID, pixel_size=16, valign=Gtk.Align.CENTER, tooltip_text="ASB")
        self.app_mark.set_size_request(20, -1)
        self.app_mark.update_property([Gtk.AccessibleProperty.LABEL], ["ASB app icon"])
        self.toolbar.append(self.app_mark)
        self.period_menu = Gtk.DropDown.new_from_strings([text for _key, text in self.PERIODS])
        self.period_menu.set_selected([key for key, _text in self.PERIODS].index(self.DEFAULT_PERIOD))
        self.period_menu.set_valign(Gtk.Align.CENTER)
        self.period_menu.add_css_class("flat")
        self.period_menu.add_css_class("asb-period-menu")
        self.period_menu.set_tooltip_text("Period")
        self.period_menu.update_property([Gtk.AccessibleProperty.LABEL], ["Period"])
        self.period_menu.connect("notify::selected", self.period_selected)
        self.toolbar.append(self.period_menu)
        self.toolbar_start = Gtk.Box(spacing=4, valign=Gtk.Align.CENTER)
        self.toolbar.append(self.toolbar_start)
        self.toolbar.append(Gtk.Box(hexpand=True))
        self.toolbar_end = Gtk.Box(spacing=4, valign=Gtk.Align.CENTER)
        self.toolbar.append(self.toolbar_end)
        self.window_controls = Gtk.WindowControls(side=Gtk.PackType.END, decoration_layout=":close")
        self.toolbar.append(self.window_controls)
        self.window_handle = Gtk.WindowHandle(child=self.toolbar)
        view.add_top_bar(self.window_handle)
        self.paths_note = Gtk.Label(label="Charts need GTK 4.14 or later.", xalign=0, visible=not ACTIVITY_PATHS,
                                    margin_top=4, margin_bottom=4, margin_start=10, margin_end=10)
        self.paths_note.add_css_class("asb-dim")
        self.paths_note.add_css_class("asb-paths-note")
        view.add_top_bar(self.paths_note)

        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.NONE, hexpand=True, vexpand=True)
        self.stack.add_named(Gtk.Spinner(spinning=True, halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER), "loading")
        error = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        self.error_label = Gtk.Label(wrap=True, justify=Gtk.Justification.CENTER)
        error.append(Adw.Clamp(maximum_size=360, child=self.error_label))
        self.retry_button = Gtk.Button(label="Try again", halign=Gtk.Align.CENTER)
        self.retry_button.connect("clicked", lambda *_: self.refresh())
        error.append(self.retry_button)
        self.stack.add_named(error, "error")
        self.data_page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.stack.add_named(self.data_page, "data")
        self.stack.set_visible_child_name("loading")
        view.set_content(self.stack)
        self.set_content(view)

        shortcuts = Gtk.ShortcutController()
        shortcuts.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string("<Control>w"),
                                                Gtk.CallbackAction.new(lambda *_: self.close() or True)))
        self.add_controller(shortcuts)
        # Tests give fetch and start the live refresh themselves.
        if fetch is None:
            self.connect("map", self.on_map)
        self.connect("unmap", lambda *_: self.stop_live())
        self.connect("close-request", self.on_close)
        try:
            saved = read_theme(THEME_PATH)
        except (OSError, ValueError):
            # The Board shows the theme error; this window keeps the GNOME colors.
            saved = None
        self.set_palette(saved)

    def period_selected(self, menu, _param):
        key = self.PERIODS[menu.get_selected()][0]
        if key != self.period:
            self.set_period(key)

    def set_period(self, key):
        keys = [key for key, _text in self.PERIODS]
        if key not in keys:
            raise ValueError(f"Unknown period: {key}")
        self.period = key
        self.period_menu.set_selected(keys.index(key))
        self.data = None
        self.stack.set_visible_child_name("loading")
        self.refresh()

    def refresh(self):
        if self.closed:
            return
        if self.loading:
            self.refresh_queued = True
            return
        self.loading = True
        period, base = self.period, self.base
        route = f"{self.ROUTE}?period={period}"

        def finished(data, error):
            self.loading = False
            if self.closed:
                return False
            if (period, base) != (self.period, self.base):
                # The period or the engine changed while the read ran: read again.
                self.refresh_queued = False
                self.refresh()
                return False
            if error:
                if self.data is None:
                    self.error_label.set_label(error)
                    self.stack.set_visible_child_name("error")
            else:
                previous, self.data = self.data, data
                self.stack.set_visible_child_name("data")
                self.render(data, previous)
            if self.refresh_queued:
                self.refresh_queued = False
                self.refresh()
            return False

        if self.fetch is None:
            request_async(self.base, route, finished, GLib.idle_add)
            return
        try:
            data, error = self.fetch(route), None
        except RuntimeError as failure:
            data, error = None, str(failure)
        finished(data, error)

    def render(self, data, previous):
        pass

    def on_map(self, *_args):
        self.start_live()
        self.refresh()

    def start_live(self):
        if self.closed:
            return
        if self.events is None:
            self.events = EventStream(self.base, self.on_dashboard_event, GLib.idle_add)
        if self.poll_timer is None:
            self.poll_timer = GLib.timeout_add_seconds(self.POLL_SECONDS, self.poll_tick)

    def stop_live(self):
        if self.events:
            self.events.close()
        self.events = None
        for name in ("poll_timer", "event_timer"):
            if getattr(self, name):
                GLib.source_remove(getattr(self, name))
            setattr(self, name, None)

    def poll_tick(self):
        self.refresh()
        return True

    def on_dashboard_event(self):
        # Several events in one second make one refresh.
        if self.event_timer is None and not self.closed:
            self.event_timer = GLib.timeout_add(1000, self.event_refresh)
        return False

    def event_refresh(self):
        self.event_timer = None
        self.refresh()
        return False

    def reconnect(self, base):
        if self.closed:
            return
        streaming = self.events is not None
        if streaming:
            self.events.close()
            self.events = None
        self.base = base
        if streaming and self.get_mapped():
            self.events = EventStream(base, self.on_dashboard_event, GLib.idle_add)
        self.refresh()

    def set_palette(self, colors):
        self.palette = palette = activity_palette(colors or native_colors(self))
        (self.add_css_class if colors else self.remove_css_class)("asb-custom")
        if not colors:
            # GNOME draws its dividers with the borders role, about 15 % text; the divider of native_colors is 30 %.
            palette["divider"] = palette["rule"]
        scope = ".asb-activity" + self.css_scope
        hues = "".join(f"{scope} .asb-activity-hue-{index} {{ background: {hue}; }}\n"
                       f"{scope} .asb-activity-hue-{index}.asb-activity-hollow {{ background: none; border: 1.5px solid {hue}; min-width: 4px; min-height: 4px; }}\n"
                       for index, hue in enumerate(MACHINE_HUES))
        self.css.load_from_string(hues + f"""
{scope} {{ background: {palette['win']}; color: {palette['text']}; }}
{scope}.asb-custom .top-bar {{ background: {palette['win']}; color: {palette['text']}; box-shadow: none; }}
{scope}.asb-custom .linked > button {{ background: alpha({palette['text']}, .08); color: {palette['text']}; }}
{scope}.asb-custom .linked > button:hover {{ background: alpha({palette['text']}, .14); }}
{scope}.asb-custom .linked > button:checked {{ background: {palette['accent']}; color: {palette['win']}; }}
{scope}.asb-custom :focus-visible {{ outline-color: {palette['accent']}; }}
{scope} .asb-activity-toolbar {{ background: {palette['win']}; }}
{scope} .asb-activity-toolbar windowcontrols button {{ min-height: 24px; min-width: 22px; padding: 2px; }}
{scope} .asb-activity-toolbar .asb-period-menu > button, {scope} .asb-activity-toolbar .linked > button,
{scope} .asb-activity-toolbar menubutton > button {{ min-height: 24px; padding: 0 8px; font-size: 12px; }}
{scope} .asb-dim {{ color: {palette['dim']}; }}
{scope} .asb-mono {{ font-family: monospace; font-feature-settings: "tnum"; }}
{scope} .asb-paths-note {{ font-size: 12px; }}
{scope} .asb-activity-dot {{ min-width: 7px; min-height: 7px; border-radius: 50%; }}
""" + self.palette_css(palette))
        self.queue_draw()

    @staticmethod
    def hue_dot(index, offline):
        """The 7px machine dot: filled in the machine hue, a 1.5px ring when the machine is offline."""
        # The size request keeps the ring at 7px: GTK draws the 1.5px border as 1px, and min-width alone gives a 6px ring.
        dot = Gtk.Box(width_request=7, height_request=7, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        dot.add_css_class("asb-activity-dot")
        dot.add_css_class(f"asb-activity-hue-{index % len(MACHINE_HUES)}")
        if offline:
            dot.add_css_class("asb-activity-hollow")
        return dot

    def palette_css(self, palette):
        """Extra rules of a subclass, scoped with self.css_scope; they load with the rules above."""
        return ""

    def on_close(self, *_args):
        if self.closed:
            return False
        self.closed = True
        self.stop_live()
        try:
            write_window_size(THEME_PATH.with_name("activity-windows.json"), self.KIND, *self.get_default_size(), self.is_maximized())
        except OSError:
            # The size is a comfort; a read-only configuration folder does not stop the close.
            pass
        windows = getattr(self.application, "activity_windows", {})
        if windows.get(self.KIND) is self:
            del windows[self.KIND]
        Gtk.StyleContext.remove_provider_for_display(self.get_display(), self.css)
        return False


def remove_children(widget):
    child = widget.get_first_child()
    while child is not None:
        widget.remove(child)
        child = widget.get_first_child()


def sector_path(cx, cy, inner, outer, start, end):
    def point(radius, degrees):
        angle = math.radians(degrees)
        return cx + radius * math.cos(angle), cy + radius * math.sin(angle)
    builder = Gsk.PathBuilder.new()
    # A full ring is two halves in one path: one arc cannot end where it starts, and two fills would show a seam.
    for first, last in ((start, start + 180), (start + 180, start + 360)) if end - start >= 359.99 else ((start, end),):
        large = last - first > 180
        builder.move_to(*point(outer, first))
        builder.svg_arc_to(outer, outer, 0, large, True, *point(outer, last))
        builder.line_to(*point(inner, last))
        if inner > 0:
            builder.svg_arc_to(inner, inner, 0, large, False, *point(inner, first))
        builder.close()
    return builder.to_path()


def alpha_color(value, alpha=1):
    color = rgba(value)
    color.alpha *= alpha
    return color


def activity_layout(widget, text, size, weight=Pango.Weight.NORMAL, mono=False):
    layout = widget.create_pango_layout(text)
    font = widget.get_pango_context().get_font_description().copy()
    if mono:
        font.set_family("monospace")
    font.set_absolute_size(size * Pango.SCALE)
    font.set_weight(weight)
    layout.set_font_description(font)
    return layout


def snapshot_layout(snapshot, layout, x, y, color):
    snapshot.save()
    snapshot.translate(Graphene.Point().init(x, y))
    snapshot.append_layout(layout, color)
    snapshot.restore()


class MessagesWindow(ActivityWindow):
    """The latest messages, with their full text and an optional session filter."""
    KIND = "messages"
    TITLE = "Messages"
    ROUTE = "/api/activity/messages"
    PERIODS = MESSAGE_PERIODS
    DEFAULT_PERIOD = "7d"
    DEFAULT_SIZE = (968, 760)

    def __init__(self, application, base, fetch=None, clock=None):
        super().__init__(application, base, fetch=fetch, clock=clock)
        self.session = self.pending_session = self.feed_key = self.scroll_tick = None
        self.set_size_request(480, 420)
        self.paths_note.set_visible(False)
        self.feed = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.feed.add_css_class("asb-msg-feed")
        self.clamp = Adw.Clamp(maximum_size=760, tightening_threshold=600, child=self.feed)
        self.feed_scroll = Gtk.ScrolledWindow(child=self.clamp, hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True)
        self.data_page.append(self.feed_scroll)
        self.session_chip = Gtk.Button(tooltip_text="Show all sessions", visible=False)
        self.session_chip.add_css_class("asb-filter-pill")
        self.session_chip.update_property([Gtk.AccessibleProperty.LABEL], ["Show all sessions"])
        content = Gtk.Box(spacing=6)
        self.session_title = Gtk.Label(ellipsize=Pango.EllipsizeMode.END, max_width_chars=18)
        content.append(self.session_title)
        content.append(Gtk.Image(icon_name="window-close-symbolic", pixel_size=12))
        self.session_chip.set_child(content)
        self.session_chip.connect("clicked", lambda *_: self.clear_session())
        self.toolbar_start.append(self.session_chip)
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self.window_key)
        self.add_controller(keys)

    def palette_css(self, palette):
        scope = self.css_scope
        return f"""
{scope} .asb-msg-feed, {scope} .asb-msg-feed > row {{ background: {palette['win']}; padding: 0; }}
{scope} .asb-msg-small {{ font-size: 12px; }}
{scope} .asb-msg-title, {scope} .asb-msg-body {{ font-size: 13px; }}
{scope} .asb-msg-sender {{ font-weight: 600; }}
{scope} .asb-msg-message {{ border-bottom: 1px solid {palette['rule']}; padding-bottom: 8px; }}
{scope} .asb-msg-held {{ color: {palette['warn']}; }}
{scope} .asb-msg-failed {{ color: {palette['bad']}; }}
{scope} .asb-filter-pill {{ min-height: 24px; border-radius: 99px; padding: 2px 8px; font-size: 11px; }}
"""

    def show_session(self, seat_id, title):
        self.session = seat_id
        self.pending_session = (seat_id, title) if self.data is None else None
        self.session_title.set_label(title)
        self.session_chip.set_visible(True)
        if self.data is not None:
            self.render(self.data, self.data)

    def clear_session(self):
        self.session = self.pending_session = None
        self.session_chip.set_visible(False)
        if self.data is not None:
            self.render(self.data, self.data)
        self.period_menu.grab_focus()

    def window_key(self, _controller, keyval, _code, _state):
        if keyval == Gdk.KEY_Escape and self.session is not None:
            self.clear_session()
            return True
        return False

    def render(self, data, previous):
        self.pending_session = None
        rows, more = message_feed(data, self.clock(), self.session)
        statuses = {record["id"]: {"held": "asb-msg-held", "not-sent": "asb-msg-failed"}.get(record.get("status"), "asb-dim")
                    for record in data.get("messages") or []}
        key = (rows, more, [statuses[item["id"]] for kind, item in rows if kind == "message"])
        if key == self.feed_key:
            return
        self.feed_key = key
        if self.scroll_tick is not None:
            self.feed_scroll.remove_tick_callback(self.scroll_tick)
            self.scroll_tick = None
        adjustment = self.feed_scroll.get_vadjustment()
        upper, value = adjustment.get_upper(), adjustment.get_value()
        remove_children(self.feed)

        def append(child):
            self.feed.append(Gtk.ListBoxRow(child=child, activatable=False, selectable=False))

        def caption(text, centered=False):
            widget = Gtk.Label(label=text, xalign=.5 if centered else 0, margin_top=14, margin_bottom=4, margin_start=16)
            widget.add_css_class("asb-dim")
            widget.add_css_class("asb-msg-small")
            return widget

        if not rows:
            append(caption("No messages in this period.", centered=True))
        for kind, item in rows:
            if kind == "day":
                append(caption(item))
                continue
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, margin_top=8, margin_bottom=8, margin_start=16, margin_end=16)
            box.add_css_class("asb-msg-message")
            route = Gtk.Box(spacing=6)
            route.add_css_class("asb-msg-title")
            when = label(item["time"], "asb-msg-small")
            when.add_css_class("asb-mono")
            when.add_css_class("asb-dim")
            route.append(when)
            for end in ("sender", "receiver"):
                if end == "receiver":
                    route.append(label("→", "asb-dim"))
                name = Gtk.Label(label=item[end], ellipsize=Pango.EllipsizeMode.END, xalign=0)
                name.add_css_class("asb-msg-title")
                if end == "sender":
                    name.add_css_class("asb-msg-sender")
                route.append(name)
                if item[end + "_machine"]:
                    machine = Gtk.Label(label=" · " + item[end + "_machine"], ellipsize=Pango.EllipsizeMode.END, xalign=0)
                    machine.add_css_class("asb-dim")
                    route.append(machine)
            if item["status"]:
                route.append(Gtk.Box(hexpand=True))
                status = label(item["status"], "asb-msg-small")
                status.add_css_class(statuses[item["id"]])
                route.append(status)
            box.append(route)
            text = Gtk.Label(label=item["text"] if item["text"] is not None else "No text", wrap=True,
                             wrap_mode=Pango.WrapMode.WORD_CHAR, xalign=0, selectable=True, margin_top=2)
            text.add_css_class("asb-msg-body")
            if item["text"] is None:
                text.add_css_class("asb-dim")
            box.append(text)
            append(box)
        if more:
            append(caption("Showing the newest 200 messages.", centered=True))

        if self.feed_scroll.get_mapped():
            def keep_position(_widget, _clock):
                if self.feed.get_last_child().get_height() == 0:
                    return True
                adjustment.set_value(value + adjustment.get_upper() - upper if value > 0 else 0)
                self.scroll_tick = None
                return False
            self.scroll_tick = self.feed_scroll.add_tick_callback(keep_position)

    def on_close(self, *_args):
        if self.scroll_tick is not None:
            self.feed_scroll.remove_tick_callback(self.scroll_tick)
            self.scroll_tick = None
        return super().on_close(*_args)


ACTIVITY_WINDOW_CLASSES["messages"] = MessagesWindow


class SwitchboardApplication(Adw.Application):
    def __init__(self, base, first_load=None):
        GLib.set_prgname(APP_ID)
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.get_style_manager().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        self.base, self.first_load = base, first_load
        self.activity_windows = {}
        # A window destroyed without a close request (no "destroy" signal reaches Python) still stops its stream and is forgotten.
        self.connect("window-removed", lambda _application, window: isinstance(window, ActivityWindow) and window.on_close())
        self.connect("activate", self.on_activate)
        for kind in ("messages", "usage"):
            action = Gio.SimpleAction.new(kind, None)
            action.connect("activate", lambda _action, _value, kind: self.show_activity(kind), kind)
            self.add_action(action)
        # Application accelerators work in every ASB window, also in a focused text field. Ctrl+Shift+U stays the GTK Unicode input.
        for action, key in (("app.messages", "<Control>m"), ("app.usage", "<Control>u"), ("win.preferences", "<Control>comma")):
            self.set_accels_for_action(action, [key])
        if first_load:
            first_load.reconnect(self.reconnect, GLib.idle_add)

    def reconnect(self, base, token):
        global SOURCE_TOKEN
        SOURCE_TOKEN, self.base = token, base
        self.first_load = None
        for window in self.get_windows():
            if isinstance(window, SwitchboardWindow):
                window.reconnect(base)
        for window in list(self.activity_windows.values()):
            window.reconnect(base)
        return False

    def show_activity(self, kind, seat=None, title=""):
        if kind not in ACTIVITY_WINDOW_CLASSES:
            raise ValueError(f"Unknown activity window: {kind}")
        window = self.activity_windows.get(kind)
        if window is None:
            window = self.activity_windows[kind] = ACTIVITY_WINDOW_CLASSES[kind](self, self.base)
        window.present()
        if seat is not None and hasattr(window, "show_session"):
            window.show_session(seat, title)
        return window

    def on_activate(self, *_args):
        # The tray starts the launcher with ASB_OPEN_WINDOW when no Board is open; a later child process must not open it again.
        opened = os.environ.pop("ASB_OPEN_WINDOW", "")
        window = self.get_active_window()
        if window is None:
            window = SwitchboardWindow(self, self.base, first_load=self.first_load)
            window.present()
            # GTK focuses the search field on show; its cursor blink repaints the window.
            window.set_focus(None)
        else:
            window.present()
        if opened in ("messages", "usage"):
            GLib.idle_add(lambda: self.show_activity(opened) and False)

    def close_windows(self):
        for window in self.get_windows():
            window.close()
        self.quit()
        return False


def usage_rect(snapshot, x, y, width, height, color, radius=0, top_only=False):
    bounds = Graphene.Rect().init(x, y, width, height)
    if radius:
        corner, flat = Graphene.Size().init(radius, radius), Graphene.Size().init(0, 0)
        rounded = Gsk.RoundedRect()
        rounded.init(bounds, corner, corner, flat if top_only else corner, flat if top_only else corner)
        snapshot.push_rounded_clip(rounded)
        snapshot.append_color(color, bounds)
        snapshot.pop()
    else:
        snapshot.append_color(color, bounds)


class UsageBar(Gtk.Widget):
    """A share bar: an optional track, and stacked segments (radius 2, 1 px gaps) over a fraction of the width."""
    def __init__(self, height, track=None, width=-1):
        super().__init__(height_request=height, width_request=width, valign=Gtk.Align.CENTER, hexpand=width < 0)
        self.track, self.segments, self.fraction = track, [], 1

    def set_segments(self, segments, fraction=1):
        self.segments, self.fraction = [(value, color) for value, color in segments if value > 0], max(0, min(1, fraction))
        self.queue_draw()

    def do_snapshot(self, snapshot):
        width, height = self.get_width(), self.get_height()
        if self.track:
            usage_rect(snapshot, 0, 0, width, height, alpha_color(self.track), 2)
        total = sum(value for value, _color in self.segments)
        room = width * self.fraction - (len(self.segments) - 1)
        if not total or room <= 0:
            return
        if self.track:
            # The fill keeps the rounded end of the track.
            rounded = Gsk.RoundedRect()
            rounded.init_from_rect(Graphene.Rect().init(0, 0, width, height), 2)
            snapshot.push_rounded_clip(rounded)
        x = 0
        for value, color in self.segments:
            size = room * value / total
            usage_rect(snapshot, x, 0, size, height, color if isinstance(color, Gdk.RGBA) else alpha_color(color), 2)
            x += size + 1
        if self.track:
            snapshot.pop()


class UsageRound(Gtk.Widget):
    """The round chart: machines on the inner ring, their apps on the outer ring, and the total or the hovered arc in the center."""
    SIZE = 320  # The frame of usage_round_arcs.
    HOLE = 92  # The inner radius of the rings in usage_round_arcs.

    def __init__(self):
        super().__init__(accessible_role=Gtk.AccessibleRole.IMG, halign=Gtk.Align.START, valign=Gtk.Align.CENTER)
        self.size = self.SIZE
        self.set_size_request(self.size, self.size)
        self.update_property([Gtk.AccessibleProperty.LABEL], ["Usage by machine and app"])
        self.arcs, self.total_text, self.sub_text, self.format = [], "", "", str
        self.hover, self.raised = None, 0
        motion = Gtk.EventControllerMotion()
        motion.connect("motion", lambda _controller, x, y: self.set_hover(self.arc_at(x, y)))
        motion.connect("leave", lambda *_: self.set_hover(None))
        self.add_controller(motion)
        self.animation = Adw.TimedAnimation.new(self, 0, 1, 150, Adw.CallbackAnimationTarget.new(self.advance))
        self.animation.set_easing(Adw.Easing.EASE_OUT_CUBIC)

    def set_arcs(self, arcs, total_text, sub_text, format_value):
        self.arcs, self.total_text, self.sub_text, self.format = arcs, total_text, sub_text, format_value
        self.hover = None
        self.queue_draw()

    def set_size(self, size):
        if size != self.size:
            self.size = size
            self.set_size_request(size, size)
            self.queue_draw()

    def center(self):
        """The center lines: the hovered arc, else the total."""
        if self.hover:
            return self.format(self.hover["value"]), self.hover["label"]
        return self.total_text, self.sub_text

    def arc_at(self, x, y):
        scale = self.SIZE / self.size
        x, y = x * scale, y * scale
        half = self.SIZE / 2
        radius = math.hypot(x - half, y - half)
        angle = math.degrees(math.atan2(y - half, x - half))
        angle = angle + 360 if angle < -90 else angle
        return next((arc for arc in self.arcs if arc["r0"] <= radius <= arc["r1"] and arc["a0"] <= angle <= arc["a1"]), None)

    def set_hover(self, arc):
        if arc is self.hover:
            return
        # shortcut: the arc that the pointer leaves drops back at once; the preview eases it back over 150 ms too.
        self.hover, self.raised = arc, 0
        self.animation.reset()
        if arc:
            self.animation.play()
        self.queue_draw()

    def advance(self, value):
        self.raised = value
        self.queue_draw()

    def center_layouts(self):
        """The center lines as (layout, x, y, color). The value fits the hole by its font size; a long label ends with …."""
        palette, half, scale = self.get_root().palette, self.size / 2, self.size / self.SIZE
        room = 2 * self.HOLE * scale - 16
        value, sub = self.center()
        lines = []
        # The preview places the text baselines 6 px above and 18 px below the center.
        for text, size, weight, mono, color, baseline in ((value, round(26 * scale), Pango.Weight.SEMIBOLD, True, palette["text"], half - 6),
                                                          (sub, 12, Pango.Weight.NORMAL, False, palette["dim"], half + 18)):
            layout = activity_layout(self, text, size, weight, mono)
            if mono:
                width = layout.get_pixel_extents()[1].width
                if width > room:
                    layout = activity_layout(self, text, max(12, int(size * room / width)), weight, mono)
            else:
                layout.set_width(int(room * Pango.SCALE))
                layout.set_ellipsize(Pango.EllipsizeMode.END)
            width = layout.get_pixel_extents()[1].width
            lines.append((layout, half - width / 2, baseline - layout.get_baseline() / Pango.SCALE, alpha_color(color)))
        return lines

    def do_snapshot(self, snapshot):
        if not ACTIVITY_PATHS:
            return
        half = self.SIZE / 2
        snapshot.save()
        snapshot.scale(self.size / self.SIZE, self.size / self.SIZE)
        for arc in self.arcs:
            raised = arc is self.hover and self.raised
            if raised:
                middle = math.radians((arc["a0"] + arc["a1"]) / 2)
                snapshot.save()
                snapshot.translate(Graphene.Point().init(4 * raised * math.cos(middle), 4 * raised * math.sin(middle)))
            snapshot.append_fill(sector_path(half, half, arc["r0"], arc["r1"], arc["a0"], arc["a1"]), Gsk.FillRule.WINDING,
                                 alpha_color(arc["color"]))
            if raised:
                snapshot.restore()
        snapshot.restore()
        for layout, x, y, color in self.center_layouts():
            snapshot_layout(snapshot, layout, x, y, color)


class UsageChart(Gtk.Widget):
    """The chart: stacked bars per bucket over three dashed gridlines, with a tooltip box for the hovered bar."""
    TOP, BOTTOM, LEFT, HEIGHT = 8, 220, 48, 242

    def __init__(self):
        super().__init__(accessible_role=Gtk.AccessibleRole.IMG, height_request=self.HEIGHT, hexpand=True)
        self.update_property([Gtk.AccessibleProperty.LABEL], ["Usage over time"])
        self.series, self.bars, self.buckets, self.sums = [], [], {"unit": "day", "startsMs": []}, []
        self.step, self.axis, self.format = 1, [], str
        self.targets, self.starts, self.progress = {}, {}, 1
        self.hover = self.tip = None
        motion = Gtk.EventControllerMotion()
        motion.connect("motion", lambda _controller, x, y: self.set_hover(self.bar_at(x, y)))
        motion.connect("leave", lambda *_: self.set_hover(None))
        self.add_controller(motion)
        self.animation = Adw.TimedAnimation.new(self, 0, 1, 220, Adw.CallbackAnimationTarget.new(self.advance))
        self.animation.set_easing(Adw.Easing.LINEAR)

    def y(self, value):
        return self.BOTTOM - (self.BOTTOM - self.TOP) * value / (self.step * 3)

    def set_data(self, series, bars, buckets, format_value, metric, animate):
        """series: (id, label, color) in stack order; bars: per bucket, the value of each series id."""
        self.series, self.bars, self.buckets, self.format = series, bars, buckets, format_value
        self.sums = [sum(bar.get(key, 0) for key, _label, _color in series) for bar in bars]
        self.step, self.axis = usage_axis(max(self.sums, default=0), metric)
        targets = {}
        for index, bar in enumerate(bars):
            stacked = 0
            for key, _label, _color in series:
                if bar.get(key, 0) > 0:
                    targets[(index, key)] = (self.y(stacked), self.y(stacked + bar[key]))
                    stacked += bar[key]
        self.starts = {key: self.targets.get(key, (self.BOTTOM, self.BOTTOM)) for key in targets}
        self.targets, self.hover, self.tip = targets, None, None
        self.animation.reset()
        self.progress = 0 if animate else 1
        if animate:
            self.animation.play()
        self.queue_draw()

    def advance(self, value):
        self.progress = ease_bars(value)
        self.queue_draw()

    def geometry(self):
        count = len(self.bars)
        gap = 1 if count >= 90 else 2
        return gap, (self.get_width() - self.LEFT - gap * (count - 1)) / count if count else 0

    def bar_at(self, x, y):
        gap, width = self.geometry()
        if not self.bars or not self.TOP <= y <= self.BOTTOM or x < self.LEFT:
            return None
        index = int((x - self.LEFT) // (width + gap))
        return index if index < len(self.bars) and x - self.LEFT - index * (width + gap) <= max(width, 1) else None

    def set_hover(self, index):
        if index == self.hover:
            return
        self.hover = index
        self.tip = None if index is None else self.tip_box(index)
        self.queue_draw()

    def tip_box(self, index):
        """The tooltip lines and its box inside the chart: right of the bar, or left when it would leave the chart."""
        gap, width = self.geometry()
        bar = self.bars[index]
        rows = [(label, self.format(bar.get(key, 0)), color) for key, label, color in self.series]
        title = activity_layout(self, self.full_label(index), 12, Pango.Weight.SEMIBOLD)
        names = [activity_layout(self, label, 12) for label, _text, _color in rows] + [activity_layout(self, "Total", 12)]
        values = [activity_layout(self, text, 12, mono=True) for _label, text, _color in rows] + [activity_layout(self, self.format(self.sums[index]), 12, mono=True)]
        size = lambda layout: layout.get_pixel_extents()[1]
        line = max(size(name).width + 8 + 12 + size(value).width + (16 if position < len(rows) else 0)
                   for position, (name, value) in enumerate(zip(names, values)))
        box_width = max(150, 22 + max(line, size(title).width))
        box_height = 2 + 16 + size(title).height + 4 + 18 * len(rows) + 9 + 18
        x = self.LEFT + index * (width + gap)
        top_y = self.y(self.sums[index])
        left = x + width + 8
        if left + box_width > self.get_width():
            left = x - box_width - 8
        left = max(0, min(left, self.get_width() - box_width))
        top = max(0, min(top_y - box_height / 2, self.HEIGHT - box_height))
        return {"index": index, "title": self.full_label(index), "rows": [(label, text) for label, text, _color in rows], "total": self.sums[index],
                "total_text": self.format(self.sums[index]), "bounds": (left, top, box_width, box_height), "layouts": (title, names, values),
                "colors": [color for _label, _text, color in rows]}

    def label_step(self):
        count = len(self.bars)
        if self.buckets["unit"] == "month":
            return 1 if count <= 12 else 3 if count <= 36 else 12
        return 3 if self.buckets["unit"] == "hour" else {7: 1, 30: 5}.get(count, 15)

    def full_label(self, index):
        starts = self.buckets["startsMs"]
        if self.buckets["unit"] == "month":
            month = datetime.fromtimestamp(starts[index] / 1000)
            return f"{ACTIVITY_MONTHS[month.month - 1]} {month.year}"
        return format_clock(starts[index]) if self.buckets["unit"] == "hour" else format_day(starts[index])

    def do_snapshot(self, snapshot):
        if not ACTIVITY_PATHS or not self.bars:
            return
        palette, chart_width = self.get_root().palette, self.get_width()
        dim, rule, text = alpha_color(palette["dim"]), alpha_color(palette["rule"]), alpha_color(palette["text"])
        dash = Gsk.Stroke.new(1)
        dash.set_dash([3, 3])
        for line, label in enumerate(self.axis, 1):
            y = self.y(self.step * line)
            builder = Gsk.PathBuilder.new()
            builder.move_to(self.LEFT, y)
            builder.line_to(chart_width, y)
            snapshot.append_stroke(builder.to_path(), dash, rule)
            layout = activity_layout(self, label, 11)
            extents = layout.get_pixel_extents()[1]
            snapshot_layout(snapshot, layout, self.LEFT - 8 - extents.width, y - extents.height / 2, dim)
        gap, width = self.geometry()
        colors = {key: alpha_color(color) for key, _label, color in self.series}
        for index, bar in enumerate(self.bars):
            x = self.LEFT + index * (width + gap)
            shown = [key for key, _label, _color in self.series if (index, key) in self.targets]
            for key in shown:
                (from_low, from_high), (to_low, to_high) = self.starts[(index, key)], self.targets[(index, key)]
                low = from_low + (to_low - from_low) * self.progress
                high = from_high + (to_high - from_high) * self.progress
                if low - high > 0:
                    top = key == shown[-1]
                    usage_rect(snapshot, x, high, width, low - high, colors[key], min(2, width / 2, low - high) if top else 0, True)
        layouts = {}

        def measure(label):
            layouts.setdefault(label, activity_layout(self, label, 11))
            return layouts[label].get_pixel_extents()[1].width
        centers = [self.LEFT + index * (width + gap) + width / 2 for index in range(len(self.bars))]
        for _index, label, left in usage_axis_labels(self.buckets, centers, chart_width, self.label_step(), measure):
            layout = layouts[label]
            snapshot_layout(snapshot, layout, left, self.BOTTOM + 15 - layout.get_baseline() / Pango.SCALE, dim)
        if self.tip:
            self.snapshot_tip(snapshot, palette, width, gap, text, rule)

    def snapshot_tip(self, snapshot, palette, width, gap, text, rule):
        index, tip = self.tip["index"], self.tip
        x, top_y = self.LEFT + index * (width + gap), self.y(self.sums[index])
        if self.sums[index] > 0:
            outline = Gsk.RoundedRect()
            outline.init_from_rect(Graphene.Rect().init(x - 1, top_y - 1, width + 2, self.BOTTOM - top_y + 2), 0)
            snapshot.append_border(outline, [1] * 4, [text] * 4)
        left, top, box_width, box_height = tip["bounds"]
        box = Gsk.RoundedRect()
        box.init_from_rect(Graphene.Rect().init(left, top, box_width, box_height), 4)
        snapshot.append_outset_shadow(box, alpha_color("#000000", .45), 0, 6, 0, 16)
        snapshot.push_rounded_clip(box)
        snapshot.append_color(alpha_color(palette["win"]), box.bounds)
        snapshot.pop()
        snapshot.append_border(box, [1] * 4, [alpha_color(palette["popup"])] * 4)
        title, names, values = tip["layouts"]
        snapshot_layout(snapshot, title, left + 11, top + 9, text)
        y = top + 9 + title.get_pixel_extents()[1].height + 4
        right = left + box_width - 11
        for position, (name, value) in enumerate(zip(names, values)):
            if position == len(names) - 1:
                usage_rect(snapshot, left + 11, y + 4, box_width - 22, 1, rule)
                y += 9
                start = left + 11
            else:
                usage_rect(snapshot, left + 11, y + 5, 8, 8, alpha_color(tip["colors"][position]), 2)
                start = left + 11 + 16
            for layout, at in ((name, start), (value, right - value.get_pixel_extents()[1].width)):
                snapshot_layout(snapshot, layout, at, y + (18 - layout.get_pixel_extents()[1].height) / 2, text)
            y += 18


class UsageWindow(ActivityWindow):
    """The Usage window: cost and tokens by machine, app, model, and time, as the approved preview's window mode."""
    KIND = "usage"
    TITLE = "Usage"
    ROUTE = "/api/activity/usage"
    PERIODS = USAGE_PERIODS
    DEFAULT_PERIOD = "30d"
    DEFAULT_SIZE = (948, 760)
    FAST_POLL_SECONDS = 2

    def __init__(self, application, base, fetch=None, clock=None):
        self.metric, self.split, self.machines_off, self.chip_key, self.chart_key, self.view = "cost", "app", set(), None, None, None
        self.narrow = self.small = False
        super().__init__(application, base, fetch, clock)
        theme = Gtk.IconTheme.get_for_display(self.get_display())
        icons = str(Path(__file__).parents[1] / "assets" / "icons")
        if icons not in theme.get_search_path():
            theme.add_search_path(icons)
        metrics = Gtk.Box(valign=Gtk.Align.CENTER)
        metrics.add_css_class("linked")
        self.metric_buttons = self.linked_toggles(metrics, (("cost", "Cost"), ("tokens", "Tokens")), self.metric, self.set_metric)
        self.toolbar_start.append(metrics)
        self.machine_filter = Gtk.MenuButton(valign=Gtk.Align.CENTER, visible=False, tooltip_text="Machines")
        image = Gtk.Image()
        set_icon(image, "asb-filter-symbolic")
        self.machine_filter.set_child(image)
        self.machine_filter.add_css_class("flat")
        self.machine_filter.add_css_class("asb-usage-filter")
        self.machine_filter.update_property([Gtk.AccessibleProperty.LABEL], ["Machine filter"])
        filters = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, margin_start=8, margin_end=8, margin_top=8, margin_bottom=8)
        filters.append(self.text("Machines", ("asb-usage-small", "asb-dim")))
        self.chips = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.chip_buttons = {}
        filters.append(self.chips)
        self.machine_filter.set_popover(Gtk.Popover(child=filters))
        self.toolbar_end.append(self.machine_filter)
        self.scan_label = Gtk.Label(xalign=0, visible=False, margin_start=10, margin_end=10, margin_bottom=4)
        self.scan_label.add_css_class("asb-usage-small")
        self.scan_label.add_css_class("asb-dim")
        self.toolbar_view.add_top_bar(self.scan_label)

        self.scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True)
        self.content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=28)
        self.scroll.set_child(Adw.Clamp(maximum_size=1240, tightening_threshold=1240, child=self.content))
        self.empty_label = Gtk.Label(vexpand=True, visible=False)
        self.empty_label.add_css_class("asb-dim")
        self.data_page.append(self.scroll)
        self.data_page.append(self.empty_label)

        self.overview = Gtk.Box(spacing=36)
        self.round = UsageRound()
        self.round_cell = Gtk.Box(width_request=340)
        self.round_cell.append(self.round)
        self.overview.append(self.round_cell)
        side = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, hexpand=True, valign=Gtk.Align.CENTER)
        for name, text in (("machine", "Machines"), ("app", "Apps"), ("maker", "Providers")):
            heading = self.heading(text)
            heading.set_margin_bottom(0)
            rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, margin_top=8)
            fold = Gtk.Expander(label_widget=heading, child=rows, expanded=name == "machine", margin_top=0 if name == "machine" else 10)
            fold.add_css_class("asb-usage-fold")
            setattr(self, f"{name}_fold", fold)
            setattr(self, f"{name}_rows", rows)
            side.append(fold)
        self.note = Gtk.Label(xalign=0, wrap=True, margin_top=10, visible=False)
        self.note.add_css_class("asb-usage-small")
        self.note.add_css_class("asb-dim")
        side.append(self.note)
        self.overview.append(side)
        self.content.append(self.overview)

        chart_section = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        header = Gtk.Box(spacing=12, margin_bottom=12)
        self.chart_title = self.heading("Daily cost")
        self.chart_title.set_margin_bottom(0)
        self.chart_title.set_hexpand(True)
        header.append(self.chart_title)
        splits = Gtk.Box(valign=Gtk.Align.CENTER)
        splits.add_css_class("linked")
        splits.add_css_class("asb-usage-split")
        self.split_buttons = self.linked_toggles(splits, (("app", "By app"), ("machine", "By machine")), self.split, self.set_split)
        header.append(splits)
        chart_section.append(header)
        self.chart = UsageChart()
        chart_section.append(self.chart)
        self.content.append(chart_section)

        totals = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        totals.append(self.heading("Totals"))
        self.figures = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=True, min_children_per_line=2, max_children_per_line=5,
                                   column_spacing=16, row_spacing=16)
        self.figures.add_css_class("asb-usage-figures")
        totals.append(self.figures)
        self.blocks = Gtk.Box(homogeneous=True, spacing=36, margin_top=20)
        totals.append(self.blocks)
        self.content.append(totals)

        models = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        models.append(self.heading("Models"))
        self.models = Gtk.Grid()
        models.append(self.models)
        self.content.append(models)
        self.layout_content()

        for name, condition in (("narrow", "max-width: 899px"), ("small", "max-width: 639px")):
            breakpoint = Adw.Breakpoint.new(Adw.BreakpointCondition.parse(condition))
            breakpoint.asb_name = name
            self.add_breakpoint(breakpoint)
        # Libadwaita applies only the last breakpoint that matches, so "small" means narrow too.
        self.connect("notify::current-breakpoint", self.breakpoint_changed)

    def palette_css(self, palette):
        scope, rule = self.css_scope, palette["rule"]
        swatches = "".join(f"{scope} .asb-usage-type-{part} {{ background: {color}; }}\n" for part, color in ACTIVITY_TOKEN_COLORS.items())
        return f"""
{scope} .asb-usage-filtered image {{ color: {palette['accent']}; }}
{scope} .asb-usage-heading {{ font-size: 13px; font-weight: 600; }}
{scope} .asb-usage-small {{ font-size: 12px; }}
{scope} .asb-usage-row {{ min-height: 34px; border-bottom: 1px solid {rule}; }}
{scope} .asb-usage-name {{ font-size: 13px; font-weight: 600; }}
{scope} .asb-usage-sub {{ font-size: 11px; color: {palette['dim']}; }}
{scope} .asb-usage-value {{ font-size: 13px; }}
{scope} .asb-usage-figure {{ font-size: 20px; }}
{scope} .asb-usage-legend {{ min-height: 22px; font-size: 12px; }}
{scope} .asb-usage-cell {{ min-height: 34px; padding-right: 10px; border-bottom: 1px solid {rule}; font-size: 12px; }}
{scope} .asb-usage-head {{ min-height: 30px; padding-right: 10px; border-bottom: 1px solid {rule}; font-size: 11px; color: {palette['dim']}; }}
{scope} .asb-usage-swatch {{ min-width: 8px; min-height: 8px; border-radius: 2px; }}
{scope} .asb-usage-chip {{ min-height: 22px; padding: 0 8px; border: 1px solid {rule}; border-radius: 4px; font-size: 12px; font-weight: normal;
  background: none; box-shadow: none; color: {palette['text']}; }}
{scope} .asb-usage-chip:hover {{ background: alpha(currentColor, .08); }}
{scope} .asb-usage-chip:disabled {{ filter: none; opacity: 1; }}
{scope} .asb-usage-chip:disabled label {{ color: {palette['text']}; }}
{scope} .asb-usage-chip:disabled label.asb-dim {{ color: {palette['dim']}; }}
{scope} .asb-usage-chip.asb-usage-off {{ opacity: .5; }}
{scope} .asb-usage-chip.asb-usage-off .asb-usage-chip-name {{ text-decoration-line: line-through; }}
{scope} .asb-usage-split button {{ min-height: 24px; padding: 0 10px; font-size: 12px; }}
{scope} .asb-usage-figures, {scope} .asb-usage-figures > flowboxchild {{ padding: 0; background: none; }}
""" + swatches

    def set_palette(self, colors):
        super().set_palette(colors)
        # Drawn widgets keep their render nodes until they draw again.
        for name in ("round", "chart"):
            if hasattr(self, name):
                getattr(self, name).queue_draw()
        # The kept Models rows take their share bar color only when they render.
        if self.data is not None:
            self.render_view()

    def linked_toggles(self, box, items, active, callback):
        buttons = {}
        for key, text in items:
            button = Gtk.ToggleButton(label=text, active=key == active)
            if buttons:
                button.set_group(next(iter(buttons.values())))
            button.connect("toggled", lambda button, key: button.get_active() and callback(key), key)
            box.append(button)
            buttons[key] = button
        return buttons

    @staticmethod
    def heading(text):
        widget = Gtk.Label(label=text, xalign=0, margin_bottom=12)
        widget.add_css_class("asb-usage-heading")
        return widget

    @staticmethod
    def text(value="", css=(), xalign=0, **kwargs):
        widget = Gtk.Label(label=value, xalign=xalign, **kwargs)
        for name in css:
            widget.add_css_class(name)
        return widget

    def dot(self, machine):
        return self.hue_dot(MACHINE_HUES.index(machine["hue"]), machine["offline"])

    @staticmethod
    def mark(app):
        image = Gtk.Image(pixel_size=14, valign=Gtk.Align.CENTER)
        set_icon(image, ACTIVITY_APP_ICONS[app])
        return image

    def set_metric(self, metric):
        if metric != self.metric:
            self.metric = metric
            self.metric_buttons[metric].set_active(True)
            self.render_view()

    def set_split(self, split):
        if split != self.split:
            self.split = split
            self.split_buttons[split].set_active(True)
            # Only the chart series change.
            if self.data is not None:
                self.render_chart(self.view, format_cost if self.metric == "cost" else format_tokens)

    def machines_on(self):
        ids = {machine["machineId"] for machine in self.data["machines"]}
        return (ids - self.machines_off) or ids

    def toggle_machine(self, machine_id):
        ids = {machine["machineId"] for machine in self.data["machines"]}
        self.machines_off = ids - usage_toggle(self.machines_on(), machine_id)
        self.render_view()

    def set_poll_seconds(self, seconds):
        if seconds == self.POLL_SECONDS:
            return
        self.POLL_SECONDS = seconds
        if self.poll_timer is not None:
            if self.poll_timer:
                GLib.source_remove(self.poll_timer)
            self.poll_timer = GLib.timeout_add_seconds(seconds, self.poll_tick)

    def breakpoint_changed(self, *_args):
        name = getattr(self.get_current_breakpoint(), "asb_name", None)
        self.narrow, self.small = name in ("narrow", "small"), name == "small"
        self.layout_content()
        if self.data is not None:
            self.render_view()

    def layout_content(self):
        self.content.set_margin_top(16 if self.small else 20)
        self.content.set_margin_bottom(32 if self.small else 40)
        for side in ("start", "end"):
            getattr(self.content, f"set_margin_{side}")(14 if self.small else 24)
        self.overview.set_orientation(Gtk.Orientation.VERTICAL if self.narrow else Gtk.Orientation.HORIZONTAL)
        self.round_cell.set_size_request(-1 if self.narrow else 340, -1)
        self.round_cell.set_valign(Gtk.Align.CENTER if self.narrow else Gtk.Align.START)
        self.round.set_halign(Gtk.Align.CENTER if self.narrow else Gtk.Align.START)
        self.round.set_hexpand(self.narrow)
        self.round.set_size(240 if self.narrow else UsageRound.SIZE)
        self.blocks.set_orientation(Gtk.Orientation.VERTICAL if self.small else Gtk.Orientation.HORIZONTAL)
        self.blocks.set_spacing(20 if self.small else 36)

    def render(self, data, previous):
        # A refresh comes after each dashboard event: the same numbers with a new reply time keep the shown view.
        if previous is not None and {**previous, "nowMs": None} == {**data, "nowMs": None}:
            return
        self.round.set_tooltip_text(usage_prices_text(data.get("prices")))
        scan = usage_scan_text(data.get("scan"))
        self.scan_label.set_label(scan)
        self.scan_label.set_visible(bool(scan))
        busy = bool(scan) or (data.get("prices") or {}).get("status") == "loading"
        self.set_poll_seconds(self.FAST_POLL_SECONDS if busy else ActivityWindow.POLL_SECONDS)
        self.render_view()

    def render_chips(self, on):
        total = len(self.data["machines"])
        filtered = len(on) < total
        self.machine_filter.set_visible(total >= 2)
        (self.machine_filter.add_css_class if filtered else self.machine_filter.remove_css_class)("asb-usage-filtered")
        self.machine_filter.set_tooltip_text(f"Machines: {len(on)} of {total} shown" if filtered else "Machines")
        key = [(machine["machineId"], machine["name"], machine.get("state"), machine.get("lastReportAtMs")) for machine in self.data["machines"]]
        if key != self.chip_key:
            self.chip_key = key
            remove_children(self.chips)
            self.chip_buttons = {}
            for index, machine in enumerate(self.data["machines"]):
                button = Gtk.ToggleButton(valign=Gtk.Align.CENTER, halign=Gtk.Align.FILL)
                button.add_css_class("asb-usage-chip")
                inner = Gtk.Box(spacing=6)
                inner.append(self.dot({"hue": machine_hue(index), "offline": machine.get("state") == "offline"}))
                inner.append(self.text(machine["name"], ("asb-usage-chip-name",)))
                if machine.get("state") == "offline":
                    inner.append(self.text(machine_state_text(machine), ("asb-dim",)))
                button.set_child(inner)
                button.update_property([Gtk.AccessibleProperty.LABEL], [f"{machine['name']}, {machine_state_text(machine)}"])
                button.connect("toggled", lambda button, machine_id: button.asb_ready and self.toggle_machine(machine_id), machine["machineId"])
                button.asb_report, button.asb_ready = machine_last_report(machine) or machine_state_text(machine), False
                self.chips.append(button)
                self.chip_buttons[machine["machineId"]] = button
        for machine_id, button in self.chip_buttons.items():
            button.asb_ready = False
            button.set_active(machine_id in on)
            button.asb_ready = True
            last = machine_id in on and len(on) == 1
            button.set_sensitive(not last)
            button.set_tooltip_text("Keep one machine" if last else button.asb_report or None)
            if machine_id in on:
                button.remove_css_class("asb-usage-off")
            else:
                button.add_css_class("asb-usage-off")

    def render_view(self):
        data = self.data
        if data is None:
            return
        on = self.machines_on()
        self.render_chips(on)
        empty = not data["records"]
        self.scroll.set_visible(not empty)
        self.empty_label.set_visible(empty)
        self.empty_label.set_label("No usage yet." if self.period == "all" else f"No usage in {dict(self.PERIODS)[self.period]}.")
        view = usage_view(data, on, self.metric)
        cost = self.metric == "cost"
        show = format_cost if cost else format_tokens
        self.round.set_arcs(usage_round_arcs(view, data["machines"], self.metric), show(view["total"]),
                            "at API prices" if cost else "processed tokens", show)
        self.render_rows(view, show)
        note = usage_unpriced_note(view)
        self.note.set_label(note)
        self.note.set_tooltip_text(", ".join(view["unpriced_models"]) if note else None)
        self.note.set_visible(bool(note))
        interval = {"hour": "Hourly", "day": "Daily", "month": "Monthly"}[data["buckets"]["unit"]]
        self.chart_title.set_label(f"{interval} {'cost' if cost else 'tokens'}")
        self.view = view
        self.render_chart(view, show)
        self.render_totals(view)
        self.render_models(view, show)

    def render_chart(self, view, show):
        if self.split == "app":
            shown = {row["id"] for row in view["apps"]}
            series = [(app, ACTIVITY_APP_LABELS[app], ACTIVITY_APP_COLORS[app]) for app in USAGE_APPS + ("",) if app in ACTIVITY_APPS or app in shown]
        else:
            series = [(machine["id"], machine["name"], machine["hue"]) for machine in view["machines"]]
        key = (self.period, self.metric, self.split, frozenset(self.machines_on()))
        self.chart.set_data(series, [bar[self.split] for bar in view["bars"]], view["buckets"], show, self.metric,
                            self.chart_key is not None and key != self.chart_key)
        self.chart_key = key

    def row_box(self):
        row = Gtk.Box(spacing=8 if self.small else 14)
        row.add_css_class("asb-usage-row")
        return row

    def row_cells(self, row, who, bar, value, share, show):
        widths = (112, 84, 44) if self.small else (150, 110, 56) if self.narrow else (210, 110, 56)
        who.set_size_request(widths[0], -1)
        # The clamp keeps the cell at its column width.
        row.append(Adw.Clamp(maximum_size=widths[0], tightening_threshold=widths[0], child=who, hexpand=False))
        row.append(bar)
        row.append(self.text(format_cost(None) if value is None else show(value),
                             ("asb-dim" if value is None else "asb-mono", "asb-usage-value"), 1, width_request=widths[1]))
        row.append(self.text("" if value is None else format_share(share), ("asb-usage-small", "asb-dim"), 1, width_request=widths[2]))

    def render_rows(self, view, show):
        for box in (self.machine_rows, self.app_rows, self.maker_rows):
            remove_children(box)
        for machine in view["machines"]:
            row = self.row_box()
            row.asb_machine = machine["id"]
            who = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, valign=Gtk.Align.CENTER)
            name = Gtk.Box(spacing=7)
            name.append(self.dot(machine))
            name.append(self.text(machine["name"], ("asb-usage-name",), ellipsize=Pango.EllipsizeMode.END, max_width_chars=1, hexpand=True))
            who.append(name)
            sub = self.text(machine["state"], ("asb-usage-sub",), max_width_chars=1, hexpand=True)
            sub.set_ellipsize(Pango.EllipsizeMode.END)
            sub.set_tooltip_text(machine["state"])
            who.append(sub)
            bar = UsageBar(10, self.palette["track"])
            bar.set_segments([(machine["apps"][app]["value"], ACTIVITY_APP_COLORS[app]) for app in USAGE_APPS + ("",)], machine["share"])
            self.row_cells(row, who, bar, machine["value"], machine["share"], show)
            self.machine_rows.append(row)
        for app in view["apps"]:
            row = self.row_box()
            row.asb_app = app["id"]
            who = Gtk.Box(spacing=7, valign=Gtk.Align.CENTER)
            who.append(self.mark(app["id"]))
            who.append(self.text(app["label"], ("asb-usage-name",), ellipsize=Pango.EllipsizeMode.END, max_width_chars=1, hexpand=True))
            bar = UsageBar(10, self.palette["track"])
            bar.set_segments([(app["value"], ACTIVITY_APP_COLORS[app["id"]])], app["share"])
            self.row_cells(row, who, bar, app["value"], app["share"], show)
            self.app_rows.append(row)
        for maker in view["makers"]:
            row = self.row_box()
            row.asb_maker = maker["id"]
            who = Gtk.Box(spacing=7, valign=Gtk.Align.CENTER)
            who.append(self.text(maker["label"], ("asb-usage-name",), ellipsize=Pango.EllipsizeMode.END, max_width_chars=1, hexpand=True))
            bar = UsageBar(10, self.palette["track"])
            bar.set_segments([(maker["value"] or 0, USAGE_MAKER_COLOR)], maker["share"] or 0)
            self.row_cells(row, who, bar, maker["value"], maker["share"], show)
            self.maker_rows.append(row)

    def render_totals(self, view):
        remove_children(self.figures)
        parts = view["parts"]
        figures = (("Processed tokens", format_tokens(view["tokens"])), ("Cached input", format_tokens(parts["cacheRead"] + parts["cacheWrite"])),
                   ("Uncached input", format_tokens(parts["uncached"])), ("Output", format_tokens(parts["output"])),
                   ("Cache savings", format_cost(view["savings"])))
        for title, value in figures:
            figure = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            figure.append(self.text(title, ("asb-usage-small", "asb-dim")))
            figure.append(self.text(value, ("asb-mono", "asb-usage-figure")))
            self.figures.append(figure)
            figure.get_parent().set_focusable(False)
        remove_children(self.blocks)
        for title, values, show in (("Tokens by type", parts, format_tokens), ("Cost by type", view["cost_parts"], format_cost)):
            block = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            block.append(self.text(title, ("asb-usage-small", "asb-dim"), margin_bottom=8))
            bar = UsageBar(10)
            bar.set_margin_bottom(10)
            bar.set_segments([(values[part], ACTIVITY_TOKEN_COLORS[part]) for part in USAGE_PARTS])
            block.append(bar)
            total = sum(values.values())
            for part in USAGE_PARTS:
                line = Gtk.Box(spacing=8)
                line.add_css_class("asb-usage-legend")
                line.asb_part = part
                swatch = Gtk.Box(valign=Gtk.Align.CENTER)
                swatch.add_css_class("asb-usage-swatch")
                swatch.add_css_class(f"asb-usage-type-{part}")
                line.append(swatch)
                line.append(self.text(USAGE_PART_LABELS[part], (), ellipsize=Pango.EllipsizeMode.END, hexpand=True))
                line.append(self.text(show(values[part]), ("asb-mono",), 1))
                line.append(self.text(format_share(values[part] / total if total else 0), ("asb-mono", "asb-dim"), 1, width_request=52))
                block.append(line)
            self.blocks.append(block)

    def render_models(self, view, show):
        """The Models table. Each (model, app) row keeps its widgets: a refresh changes their texts and order in place."""
        grid = self.models
        names = {machine["machineId"]: machine["name"] for machine in self.data["machines"]}
        rows = {machine["id"]: machine for machine in view["machines"]}
        columns = [("Model", 0), ("App", 0), ("Cost", 1), ("Tokens", 1)] if self.small else \
            [("Model", 0), ("App", 0), ("Machines", 0), ("Cost", 1), ("Share", 0), ("Tokens", 1)]
        if columns != getattr(self, "model_columns", None):
            remove_children(grid)
            self.model_columns, self.model_cells = columns, {}
            for column, (title, xalign) in enumerate(columns):
                self.model_head = self.text(title, ("asb-usage-head",), xalign, hexpand=title in ("Model", "App", "Machines", "Tokens"))
                grid.attach(self.model_head, column, 0, 1, 1)
        keys = {(model["model"], model["app"]) for model in view["models"]}
        for key in [key for key in self.model_cells if key not in keys]:
            for cell in self.model_cells.pop(key).values():
                grid.remove(cell)
        layout, previous = grid.get_layout_manager(), self.model_head
        for line, model in enumerate(view["models"], 1):
            key = (model["model"], model["app"])
            cells = self.model_cells.get(key)
            if cells is None:
                cells = self.model_cells[key] = self.model_row(model)
                for column, (title, _xalign) in enumerate(columns):
                    grid.attach(cells[title], column, line, 1, 1)
            cost = cells["Cost"]
            cost.set_label(format_cost(model["cost"]))
            cost.remove_css_class("asb-mono" if model["cost"] is None else "asb-dim")
            cost.add_css_class("asb-dim" if model["cost"] is None else "asb-mono")
            cells["Tokens"].set_label(format_tokens(model["tokens"]))
            dots, machines = cells["Machines"], [(machine, names[machine], rows[machine]["hue"], rows[machine]["offline"]) for machine in model["machines"]]
            if machines != getattr(dots, "asb_machines", None):
                dots.asb_machines = machines
                remove_children(dots)
                dots.update_property([Gtk.AccessibleProperty.LABEL], [", ".join(names[machine] for machine in model["machines"])])
                for machine in model["machines"]:
                    dot = self.dot(rows[machine])
                    dot.set_tooltip_text(names[machine])
                    dots.append(dot)
            share = cells["Share"]
            if model["share"] is None:
                remove_children(share)
            else:
                if share.get_first_child() is None:
                    share.append(UsageBar(6, self.palette["track"], 60))
                    share.append(self.text("", ("asb-mono",)))
                share.get_first_child().track = self.palette["track"]
                share.get_first_child().set_segments([(1, alpha_color(self.palette["light"], .75))], model["share"])
                share.get_last_child().set_label(format_share(model["share"]))
            # Keep the child order in the row order too: the screen reader reads the children in that order.
            for title, _xalign in columns:
                cell = cells[title]
                if cell.get_prev_sibling() is not previous:
                    cell.insert_after(grid, previous)
                if layout.get_layout_child(cell).get_row() != line:
                    layout.get_layout_child(cell).set_row(line)
                previous = cell

    def model_row(self, model):
        """The cells of one Models row by column title. render_models fills the texts that change."""
        cells = {"Model": self.text(model["model"], ("asb-mono",)), "Cost": self.text("", (), 1), "Tokens": self.text("", ("asb-mono",), 1)}
        app = Gtk.Box(spacing=6, tooltip_text=ACTIVITY_APP_LABELS[model["app"]])
        app.append(self.mark(model["app"]))
        if not self.small:
            app.append(self.text(ACTIVITY_APP_LABELS[model["app"]]))
        cells["App"] = app
        cells["Machines"] = Gtk.Box(spacing=4, accessible_role=Gtk.AccessibleRole.IMG)
        cells["Share"] = Gtk.Box(spacing=8)
        for cell in cells.values():
            cell.add_css_class("asb-usage-cell")
            cell.asb_model = (model["model"], model["app"])
        return cells


ACTIVITY_WINDOW_CLASSES["usage"] = UsageWindow


def main():
    try:
        base = LAUNCHER_START.address() if LAUNCHER_START else local_base_url(sys.argv[1] if len(sys.argv) == 2 else "")
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    GLib.set_application_name("ASB · Agent Switch Board")
    application = SwitchboardApplication(base, LAUNCHER_START)
    # On Windows the launcher ends the window process, and GLib has no unix_signal_add.
    if os.name != "nt":
        for sig in (signal.SIGTERM, signal.SIGINT):
            unix_signal_add(GLib.PRIORITY_DEFAULT, sig, application.close_windows)
    return application.run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())
