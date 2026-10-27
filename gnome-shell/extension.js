import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {contrastInk, mixWhite, machineHue, providerIcon, runtimePath, parseRuntime, runtimeTrusted, panelState,
    timeText, accessibleName, kindMark, rowAccessibleName, moreText, createEventParser, nextFetchDelay} from './model.js';

const AsbMark = GObject.registerClass(
class AsbMark extends St.DrawingArea {
    _init(kind, size, style = '') {
        super._init({style: `width: ${size}px; height: ${size}px; ${style}`, y_align: Clutter.ActorAlign.CENTER});
        this._size = size;
        this.kind = kind;
        this.connect('style-changed', () => this.queue_repaint());
        this.connect('repaint', () => {
            const cr = this.get_context();
            const [w, h] = this.get_surface_size();
            const s = Math.min(w, h);
            const color = this.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
            cr.setLineWidth(this.kind === 'ring' ? 1.5 * s / this._size : 2 * s / 12);
            cr.setLineCap(1);
            const radius = this.kind === 'dot' ? s / 2 : this.kind === 'ring' ? s / 2 - 0.75 * s / this._size : 4.5 * s / 12;
            cr.arc(w / 2, h / 2, radius, 0, this.kind === 'arc' ? 1.5 * Math.PI : 2 * Math.PI);
            if (this.kind === 'dot')
                cr.fill();
            else
                cr.stroke();
            cr.$dispose();
        });
    }

    setKind(kind) {
        this.kind = kind;
        this.queue_repaint();
    }
});

const AsbNumber = GObject.registerClass(
class AsbNumber extends St.Widget {
    _init() {
        super._init({layout_manager: new Clutter.BinLayout(), clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._label = null;
    }

    setText(text, animate) {
        if (this._label?.text === text)
            return;
        for (const child of this.get_children()) {
            child.remove_all_transitions();
            if (child !== this._label)
                child.destroy();
        }
        const old = this._label;
        const label = new St.Label({text, style_class: 'asb-num', y_align: Clutter.ActorAlign.CENTER});
        this._label = label;
        this.add_child(label);
        if (!old || !animate || !St.Settings.get().enable_animations) {
            old?.destroy();
            return;
        }
        const h = old.height || old.get_preferred_height(-1)[1];
        label.translation_y = 0.6 * h;
        label.opacity = 0;
        old.ease({translation_y: -0.6 * h, opacity: 0, duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO, onComplete: () => old.destroy()});
        label.ease({translation_y: 0, opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
    }
});

class EngineClient {
    constructor(onState) {
        this._onState = onState;
        this._cancel = new Gio.Cancellable();
        this._events = new Soup.Session({timeout: 0, proxy_resolver: Gio.SimpleProxyResolver.new(null, null)});
        this._requests = new Soup.Session({timeout: 5, proxy_resolver: Gio.SimpleProxyResolver.new(null, null)});
        this._sources = new Set();
        this._runtime = null;
        this._generation = 0;
        this._lastStart = -1000;
        this._fetching = false;
        this._dirty = false;
        this._fetchTimer = 0;
    }

    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _info(file) {
        return new Promise((resolve, reject) => file.query_info_async(
            'standard::type,standard::size,unix::uid,unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, this._cancel, (source, result) => {
                try {
                    const info = source.query_info_finish(result);
                    resolve({type: info.get_file_type() === Gio.FileType.DIRECTORY ? 'directory'
                        : info.get_file_type() === Gio.FileType.REGULAR ? 'regular' : 'other',
                    uid: info.get_attribute_uint32('unix::uid'), mode: info.get_attribute_uint32('unix::mode'),
                    size: info.get_size()});
                } catch (error) {
                    reject(error);
                }
            }));
    }

    async _readRuntime() {
        const file = Gio.File.new_for_path(runtimePath({XDG_RUNTIME_DIR: GLib.getenv('XDG_RUNTIME_DIR'),
            XDG_STATE_HOME: GLib.getenv('XDG_STATE_HOME')}, GLib.get_home_dir()));
        const dir = await this._info(file.get_parent());
        const info = await this._info(file);
        if (!runtimeTrusted({dir, file: info}, new Gio.Credentials().get_unix_user()))
            throw new Error('Untrusted runtime.');
        const contents = await new Promise((resolve, reject) => file.load_contents_async(this._cancel, (source, result) => {
            try {
                const [, bytes] = source.load_contents_finish(result);
                resolve(bytes);
            } catch (error) {
                reject(error);
            }
        }));
        if (contents.length > 4096)
            throw new Error('Invalid runtime.');
        const runtime = parseRuntime(new TextDecoder().decode(contents));
        if (!runtime || !GLib.file_test(`/proc/${runtime.pid}`, GLib.FileTest.EXISTS))
            throw new Error('Missing engine.');
        return runtime;
    }

    _message(method, path, runtime, body = null, token = false) {
        const origin = `http://127.0.0.1:${runtime.port}`;
        const message = Soup.Message.new(method, `${origin}${path}`);
        // A redirect must not send the source token to another endpoint.
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        if (body !== null) {
            message.request_headers.replace('Origin', origin);
            if (token)
                message.request_headers.replace('X-ASB-Source-Token', runtime.token);
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        }
        return message;
    }

    _send(session, message, stream = false) {
        return new Promise((resolve, reject) => {
            const callback = (source, result) => {
                try {
                    resolve(stream ? source.send_finish(result) : source.send_and_read_finish(result));
                } catch (error) {
                    reject(error);
                }
            };
            if (stream)
                session.send_async(message, GLib.PRIORITY_DEFAULT, this._cancel, callback);
            else
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancel, callback);
        });
    }

    async post(path, body, token = false) {
        if (!this._runtime)
            throw new Error('Engine is off.');
        const message = this._message('POST', path, this._runtime, body, token);
        const bytes = await this._send(this._requests, message);
        if (message.status_code !== 200)
            throw new Error('Request failed.');
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    _line(stream) {
        return new Promise((resolve, reject) => stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancel, (source, result) => {
            try {
                const [bytes] = source.read_line_finish(result);
                resolve(bytes === null ? null : new TextDecoder().decode(bytes).replace(/\r$/, ''));
            } catch (error) {
                reject(error);
            }
        }));
    }

    async start() {
        const cancel = this._cancel;
        let retry = 3000;
        let stream = null;
        try {
            const runtime = await this._readRuntime();
            if (cancel.is_cancelled())
                return;
            this._runtime = runtime;
            const message = this._message('GET', '/api/events', runtime);
            message.request_headers.replace('Accept', 'text/event-stream');
            const input = await this._send(this._events, message, true);
            stream = new Gio.DataInputStream({base_stream: input});
            if (message.status_code !== 200 || message.response_headers.get_content_type()[0] !== 'text/event-stream')
                throw new Error('Invalid event stream.');
            retry = 1000;
            const parser = createEventParser();
            while (!cancel.is_cancelled()) {
                const line = await this._line(stream);
                if (line === null)
                    break;
                const event = parser.push(line);
                if (event && (event.event === 'connected' || event.event === 'dashboard'))
                    this._queueFetch();
            }
        } catch {
            // A missing or restarted engine is a normal Off state.
        } finally {
            if (stream)
                stream.close_async(GLib.PRIORITY_DEFAULT, cancel, null);
            if (!cancel.is_cancelled()) {
                this._runtime = null;
                this._generation++;
                this._dirty = false;
                if (this._fetchTimer) {
                    GLib.source_remove(this._fetchTimer);
                    this._sources.delete(this._fetchTimer);
                    this._fetchTimer = 0;
                }
                this._onState(null);
                this._later(retry, () => this.start());
            }
        }
    }

    _queueFetch(minDelay = 0) {
        this._dirty = true;
        if (this._fetching || this._fetchTimer || !this._runtime)
            return;
        const delay = Math.max(minDelay, nextFetchDelay(this._lastStart, GLib.get_monotonic_time() / 1000));
        this._fetchTimer = this._later(Math.ceil(delay), () => {
            this._fetchTimer = 0;
            this._fetchPanel();
        });
    }

    async _fetchPanel() {
        this._dirty = false;
        this._fetching = true;
        this._lastStart = GLib.get_monotonic_time() / 1000;
        const generation = this._generation;
        let applied = false;
        try {
            const message = this._message('GET', '/api/panel', this._runtime);
            const bytes = await this._send(this._requests, message);
            if (message.status_code !== 200)
                return;
            const state = panelState(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            if (state && this._onState && generation === this._generation) {
                this._onState(state);
                applied = true;
            }
        } catch {
            // Keep the last valid snapshot; the finally block schedules a retry.
        } finally {
            this._fetching = false;
            // A reply from an older connection is not a failure of the current one.
            const failed = !applied && generation === this._generation;
            if (this._runtime && (this._dirty || failed))
                this._queueFetch(failed ? 3000 : 0);
        }
    }

    stop() {
        this._cancel.cancel();
        this._generation++;
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._events.abort();
        this._requests.abort();
        this._runtime = null;
        this._onState = null;
        this._events = null;
        this._requests = null;
        this._cancel = null;
        this._fetchTimer = 0;
        this._dirty = false;
    }
}

const AsbButton = GObject.registerClass(
class AsbButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'ASB', false);
        this.add_style_class_name('asb-panel');
        this.visible = false;
        this._path = extension.path;
        this._state = null;
        this._first = true;
        this._pulse = 0;
        this.client = null;
        this._capsule = new St.BoxLayout({style_class: 'asb-capsule', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._capsule);
        this._needs = this._segment('asb-seg-needs asb-seg-first', new AsbMark('ring', 6));
        this._sep1 = new St.Widget({style_class: 'asb-sep', y_expand: true});
        this._capsule.add_child(this._sep1);
        this._working = this._segment('asb-seg-working', new AsbMark('circle', 11));
        this._sep2 = new St.Widget({style_class: 'asb-sep', y_expand: true});
        this._capsule.add_child(this._sep2);
        this._total = this._segment('asb-seg-total asb-seg-last', this._icon('asb-chat-symbolic.svg', 13));
        this.menu.actor.add_style_class_name('asb-menu');
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._buildMenu();
        });
        this.connect('destroy', () => {
            if (this._pulse)
                GLib.source_remove(this._pulse);
            this._pulse = 0;
            this.client = null;
            this._state = null;
        });
    }

    _icon(name, size) {
        return new St.Icon({gicon: Gio.icon_new_for_string(`${this._path}/icons/${name}`),
            icon_size: size, y_align: Clutter.ActorAlign.CENTER});
    }

    _segment(classes, mark) {
        const box = new St.BoxLayout({style_class: `asb-seg ${classes}`, y_align: Clutter.ActorAlign.CENTER});
        const number = new AsbNumber();
        box.add_child(mark);
        box.add_child(number);
        this._capsule.add_child(box);
        return {box, mark, number};
    }

    setState(state) {
        if (!this._first && JSON.stringify(state) === JSON.stringify(this._state))
            return;
        const previous = this._state;
        const animate = !this._first && previous !== null && state !== null;
        this._state = state;
        this.accessible_name = accessibleName(state);
        this._needs.box.visible = this._working.box.visible = this._sep1.visible = this._sep2.visible = state !== null;
        this._total.box.set_style_class_name(`asb-seg asb-seg-total asb-seg-last${state ? '' : ' asb-seg-first asb-off'}`);
        this._total.number.setText(state ? String(state.total) : 'Off', animate);
        if (state) {
            for (const [segment, count, on, off] of [[this._needs, state.needs, 'dot', 'ring'],
                [this._working, state.working, 'arc', 'circle']]) {
                if (count > 0)
                    segment.box.add_style_class_name('asb-on');
                else
                    segment.box.remove_style_class_name('asb-on');
                segment.mark.setKind(count > 0 ? on : off);
                segment.number.setText(String(count), animate);
            }
        }
        if (this._pulse) {
            GLib.source_remove(this._pulse);
            this._pulse = 0;
        }
        this._needs.box.remove_style_class_name('asb-flash');
        this._needsStyle();
        if (animate && state.needs > previous.needs && St.Settings.get().enable_animations) {
            this._needs.box.add_style_class_name('asb-flash');
            this._needsStyle(true);
            this._pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._needs.box.remove_style_class_name('asb-flash');
                this._needsStyle();
                this._pulse = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
        this._first = false;
        this.visible = true;
        if (this.menu.isOpen || this.menu.isEmpty())
            this._buildMenu();
    }

    _item(text, action = null, secondary = false) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: Boolean(action), can_focus: Boolean(action)});
        if (secondary)
            item.add_style_class_name('asb-secondary');
        if (action)
            item.connect('activate', () => this._action(action));
        this.menu.addMenuItem(item);
        return item;
    }

    _action(callback) {
        this.menu.close();
        Promise.resolve().then(callback).catch(() => console.warn('ASB: action failed.'));
    }

    _accent() {
        return this._state?.accent || ('accent_color' in St.Settings.get() ? '' : '#3584e4');
    }

    _accentText(actor) {
        const accent = this._accent();
        actor.add_style_class_name('asb-accent');
        // Append, so the CSS size of a mark stays.
        if (accent)
            actor.set_style(`${actor.style ?? ''} color: ${accent};`);
    }

    _needsStyle(flash = false) {
        const accent = this._accent();
        this._needs.box.set_style(this._state?.needs > 0 && accent
            ? `background-color: ${flash ? mixWhite(accent, 0.3) : accent}; color: ${contrastInk(accent)};` : null);
    }

    _heading(name, count, attention = false) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'asb-heading'});
        item.add_child(new St.Label({text: name, style_class: 'asb-heading-name', y_align: Clutter.ActorAlign.CENTER}));
        item.add_child(new St.Widget({x_expand: true}));
        const countLabel = new St.Label({text: String(count), style_class: `asb-heading-count${attention && !count ? ' asb-quiet' : ''}`,
            y_align: Clutter.ActorAlign.CENTER});
        if (attention && count > 0)
            this._accentText(countLabel);
        item.add_child(countLabel);
        this.menu.addMenuItem(item);
    }

    _session(row, needs, app) {
        const action = row.canOpen ? async () => {
            const result = await this.client.post(`/api/threads/${encodeURIComponent(row.id)}/open`, {});
            if (result.opened !== true)
                throw new Error('Open failed.');
        } : app ? () => app.activate() : null;
        const item = new PopupMenu.PopupBaseMenuItem({reactive: Boolean(action), can_focus: Boolean(action)});
        const kind = needs ? kindMark(row.kind) : 'arc';
        const mark = kind === '?' || kind === '!' ? new St.Label({text: kind, style_class: 'asb-kind',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})
            : new AsbMark(kind, needs ? 7 : 12);
        if (needs)
            this._accentText(mark);
        item.add_child(new St.Bin({style_class: 'asb-kind-box', child: mark, y_align: Clutter.ActorAlign.CENTER}));
        const icon = this._icon(providerIcon(row.provider), 14);
        icon.opacity = 140;
        item.add_child(icon);
        const title = new St.Label({text: row.title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.add_child(title);
        if (this._state.machines.length > 1 && row.machine >= 0)
            item.add_child(new AsbMark('dot', 7, `color: ${machineHue(row.machine)};`));
        // The bin keeps the minimum width, so the time inside it can align right.
        item.add_child(new St.Bin({style_class: 'asb-time', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Label({text: timeText(row.atMs, Date.now()), style_class: 'asb-secondary',
                x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER})}));
        item.accessible_name = rowAccessibleName(row, this._state.machines, Date.now(), needs ? row.kind : 'working');
        if (action)
            item.connect('activate', () => this._action(action));
        this.menu.addMenuItem(item);
    }

    async _showWindow(app, kind) {
        try {
            const result = await this.client.post('/api/engine/show-window', {window: kind}, true);
            if (result.shown === true)
                return;
        } catch {
            console.warn('ASB: window request failed.');
        }
        // The extension may have been disabled while the request was pending.
        if (!this.client)
            return;
        const context = global.create_app_launch_context(0, -1);
        context.setenv('ASB_OPEN_WINDOW', kind);
        app.get_app_info().launch([], context);
    }

    _buildMenu() {
        const oldItems = this.menu._getMenuItems();
        const focus = global.stage.get_key_focus();
        const restoreFocus = focus && this.menu.actor.contains(focus);
        const focused = focus ? oldItems.findIndex(item => item === focus || item.contains(focus)) : -1;
        this.menu.removeAll();
        const app = Shell.AppSystem.get_default().lookup_app('local.asb.AgentSwitchBoard.desktop');
        const state = this._state;
        if (!state) {
            this._item('ASB is not running.', null, true);
            const program = app ? null : GLib.find_program_in_path('asb');
            if (app || program)
                this._item('Start ASB', app ? () => app.activate() : () => Gio.Subprocess.new([program], Gio.SubprocessFlags.NONE));
        } else {
            for (const [name, count, rows, needs] of [['Needs you', state.needs, state.needsRows, true],
                ['Working', state.working, state.workingRows, false]]) {
                if (!needs)
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._heading(name, count, needs);
                for (const row of rows)
                    this._session(row, needs, app);
                const more = moreText(count, 6);
                if (more)
                    this._item(more, app ? () => app.activate() : null, true);
            }
            if (state.machines.length > 1) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._heading('Machines', state.total);
                state.machines.forEach((machine, index) => {
                    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
                    item.add_child(new AsbMark(machine.online ? 'dot' : 'ring', 7, `color: ${machineHue(index)};`));
                    item.add_child(new St.Label({text: machine.name, y_align: Clutter.ActorAlign.CENTER}));
                    if (!machine.online)
                        item.add_child(new St.Label({text: 'Offline', style_class: 'asb-secondary', y_align: Clutter.ActorAlign.CENTER}));
                    item.add_child(new St.Widget({x_expand: true}));
                    item.add_child(new St.Label({text: String(machine.total), y_align: Clutter.ActorAlign.CENTER}));
                    this.menu.addMenuItem(item);
                });
            }
            if (app) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._item('Open ASB', () => app.activate());
                this._item('Messages', () => this._showWindow(app, 'messages'));
                this._item('Usage', () => this._showWindow(app, 'usage'));
            }
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._item('Quit ASB', () => this.client.post('/api/engine/stop', {}, true));
        }
        if (restoreFocus) {
            const items = this.menu._getMenuItems();
            const target = items[focused]?.can_focus ? items[focused] : items.find(item => item.can_focus);
            target?.grab_key_focus();
        }
    }
});

export default class AsbExtension extends Extension {
    enable() {
        this._button = new AsbButton(this);
        const siblings = Main.panel._rightBox.get_children();
        const index = siblings.indexOf(Main.panel.statusArea.quickSettings?.container);
        // Panels such as dash-to-panel move the system menu out of the right box; its end is then next to that menu.
        Main.panel.addToStatusArea(this.uuid, this._button, index < 0 ? siblings.length : index, 'right');
        this._bus = Gio.bus_own_name(Gio.BusType.SESSION, 'local.asb.AgentSwitchBoard.Panel',
            Gio.BusNameOwnerFlags.NONE, null, null, null);
        this._client = new EngineClient(state => this._button.setState(state));
        this._button.client = this._client;
        this._client.start();
    }

    disable() {
        this._client?.stop();
        if (this._bus)
            Gio.bus_unown_name(this._bus);
        this._button?.destroy();
        this._client = null;
        this._bus = null;
        this._button = null;
    }
}
