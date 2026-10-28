export const MACHINE_HUES = ['#a28caa', '#7cc48a', '#5fb3b3', '#d6a15e', '#e38fb0', '#b4b86c'];

export const ST_ACCENTS = ['#3584e4', '#2190a4', '#3a944a', '#c88800', '#ed5b00', '#e62d42', '#d56199', '#9141ac', '#6f8396'];

function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255);
    const linear = channels.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrastInk(hex) {
    const value = luminance(hex);
    return (value + 0.05) / 0.05 >= 1.05 / (value + 0.05) ? '#000000' : '#ffffff';
}

export function colorHex({red, green, blue}) {
    return `#${[red, green, blue].map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

export function contrastRatio(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
}

// The color mixed with black in 5% steps until it has the contrast on the surface.
export function inkOn(hex, surface, ratio) {
    for (let step = 0; step <= 20; step++) {
        const ink = `#${hex.slice(1).match(/../g).map(c => Math.round(parseInt(c, 16) * (1 - step / 20)).toString(16).padStart(2, '0')).join('')}`;
        if (contrastRatio(ink, surface) >= ratio)
            return ink;
    }
    return '#000000';
}

export function mixWhite(hex, t) {
    return `#${hex.slice(1).match(/../g).map(c => {
        const channel = parseInt(c, 16);
        return Math.round(channel + (255 - channel) * t).toString(16).padStart(2, '0');
    }).join('')}`;
}

export function machineHue(index) {
    return Number.isInteger(index) && index >= 0 ? MACHINE_HUES[index % 6] : null;
}

export function providerIcon(provider) {
    return provider === 'codex' ? 'asb-openai-symbolic.svg'
        : provider === 'opencode' ? 'asb-opencode-symbolic.svg' : 'asb-claude-symbolic.svg';
}

export function runtimePath(env, home) {
    const absolute = value => typeof value === 'string' && value.startsWith('/');
    const base = absolute(env.XDG_RUNTIME_DIR) ? `${env.XDG_RUNTIME_DIR}/asb`
        : `${absolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : `${home}/.local/state`}/asb/run`;
    const parts = [];
    for (const part of `${base}/service.json`.split('/')) {
        if (part === '..')
            parts.pop();
        else if (part && part !== '.')
            parts.push(part);
    }
    return `/${parts.join('/')}`;
}

export function parseRuntime(text) {
    try {
        const value = JSON.parse(text);
        if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'pid,port,schema,sourceToken' ||
            value.schema !== 1 || !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2147483647 ||
            !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
            typeof value.sourceToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceToken))
            return null;
        return {pid: value.pid, port: value.port, token: value.sourceToken};
    } catch {
        return null;
    }
}

export function runtimeTrusted({dir, file}, uid) {
    return Boolean(dir && file && Number.isInteger(uid) && uid >= 0 &&
        dir.type === 'directory' && dir.uid === uid && Number.isInteger(dir.mode) && (dir.mode & 0o7777) === 0o700 &&
        file.type === 'regular' && file.uid === uid && Number.isInteger(file.mode) && (file.mode & 0o7777) === 0o600 &&
        Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 4096);
}

export function panelState(value) {
    const count = n => Number.isSafeInteger(n) && n >= 0;
    if (!value || !['needs', 'working', 'total'].every(key => count(value[key])) ||
        !Array.isArray(value.needsRows) || !Array.isArray(value.workingRows) ||
        !Array.isArray(value.machines) || value.machines.length < 1 || value.machines.length > 64)
        return null;
    const machines = [];
    for (const m of value.machines) {
        if (!m || typeof m.name !== 'string' || typeof m.self !== 'boolean' || typeof m.online !== 'boolean' ||
            !['total', 'needs', 'working'].every(key => count(m[key])))
            return null;
        machines.push({name: m.name, self: m.self, online: m.online, total: m.total, needs: m.needs, working: m.working});
    }
    const rows = (items, needs) => items.filter(r => r && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 512 &&
        ['title', 'app', 'provider'].every(key => typeof r[key] === 'string') &&
        Number.isInteger(r.machine) && r.machine >= -1 && count(r.atMs) && typeof r.canOpen === 'boolean' &&
        (!needs || ['approval', 'question', 'failed', 'done'].includes(r.kind))).slice(0, 6).map(r => ({
        id: r.id, title: r.title, app: r.app, provider: r.provider, ...(needs ? {kind: r.kind} : {}),
        machine: r.machine < machines.length ? r.machine : -1, atMs: r.atMs, canOpen: r.canOpen,
    }));
    return {needs: value.needs, working: value.working, total: value.total,
        needsRows: rows(value.needsRows, true), workingRows: rows(value.workingRows, false), machines,
        accent: typeof value.accent === 'string' && /^#[0-9a-f]{6}$/.test(value.accent) ? value.accent : ''};
}

export function timeText(atMs, nowMs) {
    const m = Math.max(0, Math.floor((nowMs - atMs) / 60000));
    return m === 0 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export function accessibleName(state) {
    return state === null ? 'ASB is not running'
        : `ASB: ${state.needs} ${state.needs === 1 ? 'needs' : 'need'} you, ${state.working} working, ${state.total} ${state.total === 1 ? 'session' : 'sessions'}`;
}

export function kindMark(kind) {
    return kind === 'failed' ? '!' : kind === 'approval' || kind === 'question' ? '?' : 'dot';
}

export function rowAccessibleName(row, machines, nowMs, kindWord) {
    return [row.title, row.app, machines.length > 1 && row.machine >= 0 ? machines[row.machine]?.name : '',
        kindWord, timeText(row.atMs, nowMs)].filter(Boolean).join(', ');
}

export function moreText(count, shown) {
    return count > shown ? `${count - shown} more` : null;
}

export function createEventParser() {
    let event = '';
    let data = [];
    return {push(line) {
        if (line.length > 4096)
            throw new Error('The ASB event is too large.');
        if (line === '') {
            const result = data.length ? {event, data: data.join('\n')} : null;
            event = '';
            data = [];
            return result;
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' '))
            value = value.slice(1);
        if (field === 'event')
            event = value;
        else if (field === 'data')
            data.push(value);
        return null;
    }};
}

// The /api/panel read after a stream event: `connected` always reads; a `dashboard` event reads only when its `panel` tag differs
// from the tag of the last read, or when it has none (an older engine). `tag` is the one to keep for the next event.
export function panelRead(event, lastTag) {
    if (event?.event === 'connected')
        return {read: true, tag: null};
    if (event?.event !== 'dashboard')
        return {read: false, tag: lastTag};
    let tag = null;
    try {
        const value = JSON.parse(event.data);
        if (typeof value?.panel === 'string' && value.panel)
            tag = value.panel;
    } catch {
        // No tag: read.
    }
    return {read: tag === null || tag !== lastTag, tag};
}

export function nextFetchDelay(lastStartMs, nowMs, gapMs = 1000) {
    return Math.max(0, lastStartMs + gapMs - nowMs);
}
