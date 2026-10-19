#!/usr/bin/env python3
"""ASB tray icon: a StatusNotifierItem with a dbusmenu, for the ASB engine."""
import json
import os
import re
import signal
import sys
import threading
from urllib.request import ProxyHandler, Request, build_opener

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib

LOCAL_HTTP = build_opener(ProxyHandler({}))
WATCHER = "org.kde.StatusNotifierWatcher"
ENGINE_KEYS = ("ASB_SOURCE_TOKEN", "ASB_ENGINE_PID", "ASB_ENGINE_URL", "ASB_LAUNCHER")
ICON_THEME_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icons")
ITEM_XML = """<node>
 <interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconThemePath" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
  <signal name="NewIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg name="status" type="s"/></signal>
 </interface>
</node>"""
MENU_XML = """<node>
 <interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/>
  <property name="TextDirection" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout">
   <arg type="i" name="parentId" direction="in"/><arg type="i" name="recursionDepth" direction="in"/>
   <arg type="as" name="propertyNames" direction="in"/>
   <arg type="u" name="revision" direction="out"/><arg type="(ia{sv}av)" name="layout" direction="out"/>
  </method>
  <method name="GetGroupProperties">
   <arg type="ai" name="ids" direction="in"/><arg type="as" name="propertyNames" direction="in"/>
   <arg type="a(ia{sv})" name="properties" direction="out"/>
  </method>
  <method name="GetProperty">
   <arg type="i" name="id" direction="in"/><arg type="s" name="name" direction="in"/><arg type="v" name="value" direction="out"/>
  </method>
  <method name="Event">
   <arg type="i" name="id" direction="in"/><arg type="s" name="eventId" direction="in"/>
   <arg type="v" name="data" direction="in"/><arg type="u" name="timestamp" direction="in"/>
  </method>
  <method name="EventGroup">
   <arg type="a(isvu)" name="events" direction="in"/><arg type="ai" name="idErrors" direction="out"/>
  </method>
  <method name="AboutToShow"><arg type="i" name="id" direction="in"/><arg type="b" name="needUpdate" direction="out"/></method>
  <method name="AboutToShowGroup">
   <arg type="ai" name="ids" direction="in"/><arg type="ai" name="updatesNeeded" direction="out"/><arg type="ai" name="idErrors" direction="out"/>
  </method>
  <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})" name="updatedProps"/><arg type="a(ias)" name="removedProps"/></signal>
  <signal name="LayoutUpdated"><arg type="u" name="revision"/><arg type="i" name="parent"/></signal>
 </interface>
</node>"""


def tooltip_text(phone):
    return "Running. Phone access on." if isinstance(phone, dict) and phone.get("running") is True else "Running."


def menu_layout():
    return (0, {"children-display": "submenu"}, [(1, {"label": "Open ASB"}, []), (2, {"type": "separator"}, []), (3, {"label": "Quit ASB"}, [])])


def layout_value(layout):
    item_id, properties, children = layout
    return (item_id, {key: GLib.Variant("s", value) for key, value in properties.items()},
            [GLib.Variant("(ia{sv}av)", layout_value(child)) for child in children])


def menu_items(layout):
    item_id, properties, children = layout
    items = {item_id: properties}
    for child in children:
        items.update(menu_items(child))
    return items


def launch_argv(launcher, env):
    # Under systemd, the window gets its own scope, so it does not live in asb.service.
    return ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--", launcher] if env.get("INVOCATION_ID") else [launcher]


def launch_env(env):
    return {key: value for key, value in env.items() if key not in ENGINE_KEYS}


def menu_action(item_id, event_id):
    return {(1, "clicked"): "open", (3, "clicked"): "quit"}.get((item_id, event_id))


def engine_settings(env):
    pid, url = env.get("ASB_ENGINE_PID", ""), env.get("ASB_ENGINE_URL", "")
    token, launcher = env.get("ASB_SOURCE_TOKEN", ""), env.get("ASB_LAUNCHER", "")
    if not re.fullmatch(r"[1-9][0-9]{0,9}", pid) or not re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", url) \
            or not re.fullmatch(r"[a-f0-9]{64}", token) or not os.path.isabs(launcher):
        return None
    return int(pid), url, token, launcher


class Tray:
    def __init__(self, connection, settings, env):
        self.connection = connection
        self.engine_pid, self.url, self.token, self.launcher = settings
        self.env = env
        self.loop = GLib.MainLoop()
        self.bus_name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self.tooltip = "Running."
        self.registered = False
        self.items = menu_items(menu_layout())

    def request(self, method, route, timeout):
        headers = {"X-ASB-Source-Token": self.token, "Accept": "application/json"}
        data = None
        if method == "POST":
            headers.update({"Origin": self.url, "Content-Type": "application/json"})
            data = b"{}"
        with LOCAL_HTTP.open(Request(self.url + route, data=data, headers=headers, method=method), timeout=timeout) as response:
            return json.load(response)

    def in_background(self, work):
        threading.Thread(target=work, daemon=True).start()

    def open_asb(self):
        try:
            GLib.spawn_async(launch_argv(self.launcher, self.env), envp=[f"{k}={v}" for k, v in launch_env(self.env).items()],
                             flags=GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.STDOUT_TO_DEV_NULL | GLib.SpawnFlags.STDERR_TO_DEV_NULL)
        except GLib.Error as error:
            print(f"ASB tray cannot open ASB: {error.message}", file=sys.stderr)

    def quit_engine(self):
        def work():
            try:
                self.request("POST", "/api/engine/stop", 5)
            except Exception as error:
                print(f"ASB tray cannot stop ASB: {error}", file=sys.stderr)
                return
            GLib.idle_add(self.stop)
        self.in_background(work)

    def run_action(self, action):
        if action == "open":
            self.open_asb()
        elif action == "quit":
            self.quit_engine()

    def refresh_tooltip(self):
        def work():
            try:
                text = tooltip_text(self.request("GET", "/api/phone", 2))
            except Exception:
                text = "Running."
            GLib.idle_add(self.show_tooltip, text)
        self.in_background(work)
        return True

    def show_tooltip(self, text):
        if text != self.tooltip:
            self.tooltip = text
            self.connection.emit_signal(None, "/StatusNotifierItem", "org.kde.StatusNotifierItem", "NewToolTip", None)
        return False

    def check_engine(self):
        try:
            os.kill(self.engine_pid, 0)
        except ProcessLookupError:
            self.stop()
        except PermissionError:
            pass
        return True

    def stop(self, *_args):
        self.loop.quit()
        return False

    def item_property(self, name):
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"), "Id": GLib.Variant("s", "asb"), "Title": GLib.Variant("s", "ASB"),
            "Status": GLib.Variant("s", "Active"), "IconName": GLib.Variant("s", "local.asb.AgentSwitchBoard"),
            "IconThemePath": GLib.Variant("s", ICON_THEME_PATH), "ToolTip": GLib.Variant("(sa(iiay)ss)", ("", [], "ASB", self.tooltip)),
            "ItemIsMenu": GLib.Variant("b", False), "Menu": GLib.Variant("o", "/MenuBar"),
        }.get(name)

    def get_property(self, _connection, _sender, path, _interface, name):
        if path == "/MenuBar":
            return {"Version": GLib.Variant("u", 3), "TextDirection": GLib.Variant("s", "ltr"), "Status": GLib.Variant("s", "normal"),
                    "IconThemePath": GLib.Variant("as", [])}.get(name)
        return self.item_property(name)

    def method_call(self, _connection, _sender, _path, _interface, method, parameters, invocation):
        args = parameters.unpack()
        if method == "Activate":
            self.open_asb()
        elif method == "GetLayout":
            invocation.return_value(GLib.Variant("(u(ia{sv}av))", (1, layout_value(menu_layout()))))
            return
        elif method == "GetGroupProperties":
            ids = args[0] or list(self.items)
            properties = [(item_id, {key: GLib.Variant("s", value) for key, value in self.items[item_id].items()})
                          for item_id in ids if item_id in self.items]
            invocation.return_value(GLib.Variant("(a(ia{sv}))", (properties,)))
            return
        elif method == "GetProperty":
            value = self.items.get(args[0], {}).get(args[1])
            if value is None:
                invocation.return_dbus_error("com.canonical.dbusmenu.Error", "Unknown menu property.")
            else:
                invocation.return_value(GLib.Variant("(v)", (GLib.Variant("s", value),)))
            return
        elif method == "Event":
            self.run_action(menu_action(args[0], args[1]))
        elif method == "EventGroup":
            for item_id, event_id, _data, _timestamp in args[0]:
                self.run_action(menu_action(item_id, event_id))
            invocation.return_value(GLib.Variant("(ai)", ([],)))
            return
        elif method == "AboutToShow":
            invocation.return_value(GLib.Variant("(b)", (False,)))
            return
        elif method == "AboutToShowGroup":
            invocation.return_value(GLib.Variant("(aiai)", ([], [])))
            return
        invocation.return_value(None)

    def register_item(self, connection, _name, _owner):
        def finished(source, result):
            try:
                source.call_finish(result)
                self.registered = True
            except GLib.Error as error:
                print(f"ASB tray cannot register its icon: {error.message}", file=sys.stderr)
        connection.call(WATCHER, "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem", GLib.Variant("(s)", (self.bus_name,)),
                        None, Gio.DBusCallFlags.NONE, -1, None, finished)

    def give_up(self):
        # Without a tray host after 60 s (for example stock GNOME), the engine runs without an icon.
        if not self.registered:
            self.loop.quit()
        return False

    def run(self):
        reply = self.connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                                          GLib.Variant("(su)", (self.bus_name, 4)), GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None)
        if reply.unpack()[0] != 1:
            print(f"ASB tray cannot own {self.bus_name}.", file=sys.stderr)
            return 1
        for path, xml in (("/StatusNotifierItem", ITEM_XML), ("/MenuBar", MENU_XML)):
            interface = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
            self.connection.register_object(path, interface, self.method_call, self.get_property, None)
        Gio.bus_watch_name_on_connection(self.connection, WATCHER, Gio.BusNameWatcherFlags.NONE, self.register_item, None)
        GLib.timeout_add_seconds(60, self.give_up)
        GLib.timeout_add_seconds(30, self.refresh_tooltip)
        GLib.timeout_add_seconds(5, self.check_engine)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, self.stop)
        self.refresh_tooltip()
        self.loop.run()
        return 0


def main():
    env = dict(os.environ)
    settings = engine_settings(env)
    if not settings:
        print("ASB tray needs valid ASB_ENGINE_PID, ASB_ENGINE_URL, ASB_SOURCE_TOKEN, and ASB_LAUNCHER values.", file=sys.stderr)
        return 2
    try:
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as error:
        print(f"ASB tray cannot connect to the session bus: {error.message}", file=sys.stderr)
        return 1
    return Tray(connection, settings, env).run()


if __name__ == "__main__":
    sys.exit(main())
