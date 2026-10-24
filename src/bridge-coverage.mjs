// ASB Bridge coverage of this machine: the state of each enabled app profile from `asb bridge status --json`, and its install.
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CLAUDE_PROJECTS_DIR } from './claude-data.mjs';

export const BRIDGE_STATES = ['ready', 'update', 'hooks', 'off', 'nobun', 'missing', 'conflict', 'old-app', 'unknown'];
const PROVIDERS = ['codex', 'claude-desktop-code', 'opencode'];
const CHECK_ERROR = 'ASB cannot check ASB Bridge. Run asb bridge status in a terminal.';
const conflict = (state) => state === 'foreign' || state === 'modified';
const pathsFor = (platform) => platform === 'win32' ? path.win32 : path;
const claudeHome = (source, platform) => pathsFor(platform).dirname(source.projectsDir || DEFAULT_CLAUDE_PROJECTS_DIR);

function samePath(a, b, platform) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return platform === 'win32' ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

function codexApp(status, source, threads, platform) {
  const home = source.dataDir;
  const item = status.codex.find((entry) => samePath(entry.home, home, platform));
  const state = !item ? 'missing' : item.oldPlugin || conflict(item.skill) ? 'conflict' : !item.plugin.installed ? 'missing'
    : !item.plugin.enabled ? 'off' : item.bunOnAppServerPath === false ? 'nobun'
      : !item.plugin.versionMatches || item.skillCurrent !== true ? 'update'
        : !(item.hooks.session_start && item.hooks.session_end) ? 'hooks' : 'ready';
  const live = (status.liveReceiverSessions || []).filter((id) => threads.some((thread) => thread.provider === 'codex'
    && (thread.externalId || thread.id) === id && (thread.sourceId || thread.provider) === source.id)).length;
  return { state, version: item?.plugin.version ?? null, live, install: { args: ['--codex-home', pathsFor(platform).resolve(home)], env: {} } };
}

function claudeApp(status, source, platform) {
  const home = claudeHome(source, platform);
  const item = (status.claudeHomes || []).find((entry) => samePath(entry.home, home, platform));
  const state = !item ? 'unknown' : conflict(item.skill) ? 'conflict' : item.skill === 'missing' ? 'missing'
    : item.skillCurrent !== true ? 'update' : 'ready';
  return { state, version: state === 'ready' ? status.opencode.expectedVersion : null, live: null,
    install: samePath(home, status.claude.home, platform) ? { args: ['--claude'], env: {} }
      : { args: ['--claude'], env: { CLAUDE_CONFIG_DIR: pathsFor(platform).resolve(home) } } };
}

function opencodeApp(status) {
  const o = status.opencode;
  const state = conflict(o.plugin) ? 'conflict' : o.plugin === 'missing' ? 'missing' : o.warning ? 'old-app'
    : !o.versionMatches || o.skillCurrent !== true ? 'update' : 'ready';
  return { state, version: o.version ?? null, live: (o.liveReceiverSessions || []).length, install: { args: ['--opencode'], env: {} } };
}

export function coverageApps(status, sources, threads, { platform = process.platform, homeDir = os.homedir() } = {}) {
  return sources.filter((source) => source.enabled === true && PROVIDERS.includes(source.provider)).map((source) => {
    const app = source.provider === 'codex' ? codexApp(status, source, threads, platform)
      : source.provider === 'opencode' ? opencodeApp(status) : claudeApp(status, source, platform);
    const result = { sourceId: source.id, label: source.label || source.name || source.id, provider: source.provider,
      state: app.state, version: app.version, live: app.live, install: app.install, command: null, canInstall: ['missing', 'update'].includes(app.state) };
    result.command = installCommand(result, { platform, homeDir });
    return result;
  });
}

// A command line for a terminal of that machine; null when a path is outside homeDir or needs quotes.
export function installCommand(app, { platform = process.platform, homeDir = os.homedir() } = {}) {
  const windows = platform === 'win32';
  const place = (target) => {
    const rel = (windows ? path.win32 : path.posix).relative(homeDir, target);
    if (rel === '') return windows ? '"$env:USERPROFILE"' : '~';
    if (rel.startsWith('..') || (windows ? path.win32 : path.posix).isAbsolute(rel)) return null;
    if (windows) return /^[A-Za-z0-9._\\ -]+$/.test(rel) ? `"$env:USERPROFILE\\${rel}"` : null;
    return /^[A-Za-z0-9._/-]+$/.test(rel) ? `~/${rel}` : null;
  };
  if (app.provider === 'codex') {
    const home = place(app.install.args[1]);
    return home === null ? null : `asb bridge install --codex-home ${home}`;
  }
  if (app.provider === 'opencode') return 'asb bridge install --opencode';
  const dir = app.install.env.CLAUDE_CONFIG_DIR;
  if (!dir) return 'asb bridge install --claude';
  const value = place(dir);
  if (value === null) return null;
  return windows ? `$env:CLAUDE_CONFIG_DIR = ${value}; asb bridge install --claude` : `CLAUDE_CONFIG_DIR=${value} asb bridge install --claude`;
}

const validInstall = (body) => body !== null && typeof body === 'object' && !Array.isArray(body) && (
  (Object.keys(body).join(',') === 'sourceId' && typeof body.sourceId === 'string' && body.sourceId.length > 0 && body.sourceId.length <= 80)
  || (Object.keys(body).join(',') === 'all' && body.all === true));
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortString = (value, max) => typeof value === 'string' && value.length <= max;
const REPORT_KEYS = ['sourceId', 'label', 'provider', 'state', 'version', 'live', 'command'];
const reportApp = (app) => Object.fromEntries(REPORT_KEYS.map((key) => [key, app[key]]));
// The body of GET /peer/v1/bridge from a member.
export function validReport(body) {
  return plain(body) && body.api === 1 && shortString(body.asbVersion, 40) && shortString(body.expectedVersion, 40) && Number.isFinite(body.checkedAtMs)
    && (!Object.hasOwn(body, 'error') || body.error === 'check') && Array.isArray(body.apps) && body.apps.length <= 32
    && body.apps.every((app) => plain(app) && Object.keys(app).sort().join(',') === [...REPORT_KEYS].sort().join(',')
      && typeof app.sourceId === 'string' && app.sourceId.length >= 1 && app.sourceId.length <= 80 && shortString(app.label, 80)
      && PROVIDERS.includes(app.provider) && BRIDGE_STATES.includes(app.state) && (app.version === null || shortString(app.version, 40))
      && (app.live === null || (Number.isInteger(app.live) && app.live >= 0 && app.live <= 10_000))
      && (app.command === null || (shortString(app.command, 300) && !/\p{Cc}/u.test(app.command))));
}
const wellFormed = (app) => ({ ...Object.fromEntries(Object.entries(app).map(([key, value]) => [key, typeof value === 'string' ? value.toWellFormed() : value])), canInstall: false });
const unique = (values) => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];

export function createBridgeCoverage({ runCli, readSources, readThreads, machine, now = Date.now, ttlMs = 60_000,
  waitMs = 10_000, platform = process.platform, homeDir = os.homedir(), group = null, relay = null, memberTtlMs = 60_000, reportWaitMs = 2_500 }) {
  let result = null, running = null, installing = false;
  // Per member: the last finished value { value, atMs } and the request in flight.
  const cache = new Map(), inflight = new Map();
  const check = async () => {
    try {
      const sources = await readSources();
      const homes = [...new Set(sources.filter((source) => source.enabled === true && source.provider === 'claude-desktop-code').map((source) => claudeHome(source, platform)))];
      const run = await runCli(['status', '--json', ...homes.flatMap((home) => ['--claude-home', home])], { timeoutMs: 30_000, env: {} });
      if (run.code === 0) {
        const status = JSON.parse(run.stdout);
        return { checkedAtMs: now(), expectedVersion: status.opencode.expectedVersion, bun: Boolean(status.versions?.bun),
          apps: coverageApps(status, sources, await readThreads(), { platform, homeDir }) };
      }
    } catch { /* The reply has the fixed error text only. */ }
    return { checkedAtMs: now(), error: CHECK_ERROR };
  };
  // Only a call starts a check: no timer and no background work.
  const local = ({ force = false } = {}) => {
    if (running) return running;
    if (!force && result && now() - result.checkedAtMs < ttlMs) return Promise.resolve(result);
    running = check().then((value) => { result = value; return value; }).finally(() => { running = null; });
    return running;
  };
  // One deadline for all the work of one call.
  const within = async (promises, limitMs) => {
    let timer;
    await Promise.race([Promise.all(promises), new Promise((resolve) => { timer = setTimeout(resolve, limitMs); })]);
    clearTimeout(timer);
  };
  const memberValue = (reply, member) => {
    const empty = { checkedAtMs: null, apps: [], live: null };
    if (reply?.status === 200) {
      if (!validReport(reply.body)) return { ...empty, state: 'error', error: `${member.name} sent a bridge state that ASB cannot read.` };
      if (reply.body.error) return { ...empty, state: 'error', checkedAtMs: reply.body.checkedAtMs, error: `ASB on ${member.name} cannot check ASB Bridge.` };
      return { ...empty, state: 'ok', checkedAtMs: reply.body.checkedAtMs, apps: reply.body.apps.map(wellFormed) };
    }
    if (reply?.status === 404) {
      let live = null;
      try { live = relay ? relay.remotePeers().peers.filter((peer) => peer.machineId === member.machineId).length : null; } catch { /* No relay list: no count. */ }
      return { ...empty, state: 'old', live };
    }
    if (reply?.status === 503) return { ...empty, state: 'checking' };
    return { ...empty, state: 'error', error: `ASB cannot get the bridge state of ${member.name}.` };
  };
  const fetchMember = (member) => {
    if (!inflight.has(member.machineId)) {
      inflight.set(member.machineId, group.fetchMember(member.machineId, '/peer/v1/bridge', { timeoutMs: 4000 }).catch(() => null).then((reply) => {
        const value = memberValue(reply, member);
        // A member that checks now is asked again at the next call.
        if (value.state === 'checking') cache.delete(member.machineId); else cache.set(member.machineId, { value, atMs: now() });
        return value;
      }).finally(() => inflight.delete(member.machineId)));
    }
    return inflight.get(member.machineId);
  };
  const machineObject = (member, value, checking) => ({ machineId: member.machineId, name: member.name, isSelf: false, online: member.online,
    lastOkAtMs: member.lastOkAtMs, asbVersion: member.asbVersion, state: value.state, checking, checkedAtMs: value.checkedAtMs, apps: value.apps,
    live: value.live, ...(value.error ? { error: value.error } : {}) });
  return {
    local,
    async status({ force = false } = {}) {
      let members = [];
      try { members = group ? (await group.status()).members.filter((member) => !member.isSelf) : []; } catch { /* No member list: this machine only. */ }
      for (const machineId of cache.keys()) if (!members.some((member) => member.machineId === machineId)) cache.delete(machineId);
      const finished = new Map();
      const requests = members.filter((member) => member.online !== false).flatMap((member) => {
        const cached = cache.get(member.machineId);
        if (!force && !inflight.has(member.machineId) && cached && now() - cached.atMs < memberTtlMs) return [];
        return [fetchMember(member).then((value) => { finished.set(member.machineId, value); })];
      });
      await within([local({ force }), ...requests], waitMs);
      const { machineId, name, asbVersion } = machine();
      const state = !result ? 'checking' : result.error ? 'error' : 'ok';
      const self = { machineId, name, isSelf: true, online: true, lastOkAtMs: now(), asbVersion, state, checking: Boolean(running),
        checkedAtMs: result?.checkedAtMs ?? null, apps: result?.apps || [], live: null, ...(state === 'error' ? { error: result.error } : {}) };
      const others = members.map((member) => {
        if (member.online === false) return machineObject(member, { state: 'offline', checkedAtMs: null, apps: [], live: null }, false);
        if (finished.has(member.machineId)) return machineObject(member, finished.get(member.machineId), finished.get(member.machineId).state === 'checking');
        // A request in flight shows the last value; with no value yet, the member is checking.
        const cached = cache.get(member.machineId)?.value;
        return machineObject(member, cached || { state: 'checking', checkedAtMs: null, apps: [], live: null }, inflight.has(member.machineId) || !cached);
      });
      return { api: 1, expectedVersion: result?.expectedVersion || '', machines: [self, ...others] };
    },
    // The body of the member route GET /peer/v1/bridge: no install data and no path.
    async report() {
      // Shorter than the 4 s timeout of the asking machine: it shows checking and asks again.
      await within([local()], reportWaitMs);
      if (!result) return { status: 503, body: { error: 'ASB is checking ASB Bridge.' } };
      const { asbVersion } = machine();
      if (result.error) return { status: 200, body: { api: 1, asbVersion, checkedAtMs: result.checkedAtMs, expectedVersion: '', apps: [], error: 'check' } };
      return { status: 200, body: { api: 1, asbVersion, checkedAtMs: result.checkedAtMs, expectedVersion: result.expectedVersion, apps: result.apps.map(reportApp) } };
    },
    async install(body) {
      if (!validInstall(body)) return { status: 400, body: { error: 'Invalid install request.' } };
      if (installing) return { status: 409, body: { error: 'An install is running. Wait for it to end.' } };
      installing = true;
      try {
        const apps = (await local()).apps || [];
        const chosen = apps.filter((app) => app.canInstall && (body.all === true || app.sourceId === body.sourceId));
        if (!chosen.length) return { status: 404, body: { error: 'This profile has nothing to install.' } };
        const runs = [];
        const args = unique(chosen.filter((app) => !Object.keys(app.install.env).length).map((app) => app.install.args)).flat();
        if (args.length) runs.push(await runCli(['install', ...args], { timeoutMs: 180_000, env: {} }));
        for (const env of unique(chosen.filter((app) => app.install.env.CLAUDE_CONFIG_DIR).map((app) => app.install.env))) {
          runs.push(await runCli(['install', '--claude'], { timeoutMs: 180_000, env }));
        }
        // A check that started during the runs can hold the old state, so the last check starts after them.
        if (running) await running;
        await local({ force: true });
        const output = runs.flatMap((run) => [run.stdout, run.stderr]).filter(Boolean).join('\n').trim().slice(-4000);
        return { status: 200, body: { ok: runs.every((run) => run.code === 0), output } };
      } finally { installing = false; }
    },
  };
}
