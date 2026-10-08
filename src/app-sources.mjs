import path from 'node:path';
import os from 'node:os';
import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { defaultClaudeAppDir } from './claude-data.mjs';
import { discoverCodexStateDatabase } from './codex-data.mjs';

export const MAX_APP_SOURCES = 8;
const PROVIDERS = ['codex', 'claude-desktop-code'];
const SOURCE_FIELDS = ['id', 'provider', 'label', 'dataDir', 'launcher', 'enabled', 'projectsDir', 'color', 'showMarker'];
const SOURCE_COLORS = ['#8296b4', '#b28f80', '#a28caa', '#899e91'];
const APP_LAUNCHER = /^(?:chatgpt|codex|claude)(?:[-_.][a-z0-9][a-z0-9._-]*)?(?:\.exe)?$/i;
const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

function defaultSourceColor(id) {
  if (id === 'codex') return SOURCE_COLORS[0];
  if (id === 'codex-personal') return SOURCE_COLORS[1];
  if (id === 'claude-desktop-code') return SOURCE_COLORS[2];
  return SOURCE_COLORS[createHash('sha256').update(id).digest()[0] % SOURCE_COLORS.length];
}

function validateSourceColor(color) {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw invalid('Color must use six hex digits, for example #8296b4.');
  return color.toLowerCase();
}

function absolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 4096) {
    throw invalid(`${field} must be an absolute local path with no control characters and at most 4096 bytes.`);
  }
  return path.resolve(value);
}

export async function validateSourceLauncher(launcher) {
  if (launcher === '') return '';
  const value = absolute(launcher, 'Launcher');
  if (!APP_LAUNCHER.test(path.basename(value))) throw invalid('Select an installed ChatGPT, Codex, or Claude launcher.');
  try {
    const target = await fs.realpath(value);
    if (!APP_LAUNCHER.test(path.basename(target)) || !(await fs.stat(target)).isFile()) throw invalid('Invalid app launcher.');
    await fs.access(target, constants.X_OK);
  } catch { throw invalid('The app launcher must be an existing executable app file.'); }
  return value;
}

export function defaultAppSources({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  return [
    { id: 'codex', provider: 'codex', label: 'Codex', dataDir: path.join(homeDir, '.codex'), launcher: '', enabled: true, builtin: true },
    { id: 'claude-desktop-code', provider: 'claude-desktop-code', label: 'Claude Desktop Code',
      dataDir: defaultClaudeAppDir(platform, homeDir, env), projectsDir: path.join(homeDir, '.claude', 'projects'),
      launcher: '', enabled: true, builtin: true },
  ].map((source) => ({ ...source, color: defaultSourceColor(source.id), showMarker: true }));
}

export function numberAppSources(sources) {
  return sources.map((source, index) => ({ ...source,
    color: source.color === undefined ? defaultSourceColor(source.id) : validateSourceColor(source.color),
    showMarker: source.showMarker === undefined ? true : source.showMarker,
    sourceNumber: sources.slice(0, index + 1).filter((item) => item.provider === source.provider).length,
    sourceCount: sources.filter((item) => item.provider === source.provider).length,
  }));
}

async function storeIdentity(source) {
  let root = source.dataDir;
  try { root = await fs.realpath(root); } catch {}
  // Resolve the actual database too, so linked copies of one Codex store cannot be added twice.
  if (source.provider === 'codex') {
    const info = await fs.stat(await discoverCodexStateDatabase(root)).catch(() => null);
    if (info?.isFile()) return `codex:${info.dev}:${info.ino}`;
  }
  return `${source.provider}:${root}`;
}

export class AppSourceRegistry {
  constructor({ homeDir = os.homedir(), env = process.env, platform = process.platform,
    configPath = path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'asb', 'sources.json'),
    discoverPersonal = true } = {}) {
    this.homeDir = homeDir;
    this.configPath = configPath;
    this.sources = defaultAppSources({ homeDir, env, platform });
    this.discoverPersonal = discoverPersonal;
    this.signature = null;
    this.initialized = false;
    this.readPromise = null;
    this.write = Promise.resolve();
  }

  async validate(source, { stored = false, checkLauncher = true } = {}) {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some((key) => ![...SOURCE_FIELDS, ...(stored ? ['builtin'] : [])].includes(key))
      || !PROVIDERS.includes(source.provider) || typeof source.label !== 'string'
      || !source.label.trim() || source.label.length > 80 || /[\x00-\x1f\x7f]/.test(source.label)
      || typeof source.enabled !== 'boolean' || typeof source.launcher !== 'string'
      || (source.showMarker !== undefined && typeof source.showMarker !== 'boolean')
      || (stored && typeof source.id !== 'string')
      || (source.id !== undefined && (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(source.id)))) {
      throw invalid('Invalid app source fields.');
    }
    const dataDir = absolute(source.dataDir, 'Data folder');
    const launcher = stored || !checkLauncher ? source.launcher === '' ? '' : absolute(source.launcher, 'Launcher')
      : await validateSourceLauncher(source.launcher);
    if (launcher && !APP_LAUNCHER.test(path.basename(launcher))) {
      throw invalid('Invalid app launcher.');
    }
    if (source.projectsDir !== undefined && source.provider !== 'claude-desktop-code') throw invalid('Only Claude sources have a transcript folder.');
    const color = source.color === undefined ? stored ? defaultSourceColor(source.id) : undefined : validateSourceColor(source.color);
    return { ...source, label: source.label.trim(), dataDir, launcher,
      ...(color === undefined ? {} : { color }),
      ...(stored && source.showMarker === undefined ? { showMarker: true } : {}),
      ...(source.projectsDir !== undefined ? { projectsDir: absolute(source.projectsDir, 'Transcript folder') } : {}) };
  }

  async validateStores(sources) {
    if (sources.length > MAX_APP_SOURCES) throw invalid(`ASB supports up to ${MAX_APP_SOURCES} app sources.`);
    const identities = await Promise.all(sources.map(storeIdentity));
    if (new Set(identities).size !== identities.length) throw invalid('This session store is already registered.');
    if (new Set(sources.map((source) => source.id)).size !== sources.length) throw invalid('Duplicate app source ID.');
  }

  async read() {
    if (this.readPromise) { await this.readPromise; return this.sources.map((source) => ({ ...source })); }
    this.readPromise = (async () => {
      const info = this.configPath ? await fs.stat(this.configPath).catch(() => null) : null;
      const signature = info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : '';
      if (this.initialized && signature === this.signature) return;
      const first = !this.initialized;
      this.initialized = true;
      this.signature = signature;
      if (info) {
        try {
          if (info.size > 256 * 1024) throw invalid('App source settings are too large.');
          const value = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
          if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'sources,version'
            || !Array.isArray(value.sources) || value.sources.length > MAX_APP_SOURCES) throw invalid('Invalid app source settings.');
          const sources = await Promise.all(value.sources.map((source) => this.validate(source, { stored: true })));
          for (const builtin of ['codex', 'claude-desktop-code']) {
            const source = sources.find((item) => item.id === builtin);
            if (!source || source.provider !== builtin) throw invalid('Default app sources must stay registered.');
          }
          for (const source of sources) source.builtin = ['codex', 'claude-desktop-code'].includes(source.id);
          await this.validateStores(sources);
          this.sources = sources;
          this.warning = '';
        } catch { this.warning = 'ASB cannot read its app source settings. The last valid sources are still in use.'; }
      } else if (first && this.discoverPersonal) {
        const dataDir = path.join(this.homeDir, '.codex-personal');
        const launcher = path.join(this.homeDir, '.local', 'bin', 'chatgpt-personal');
        const database = await fs.stat(await discoverCodexStateDatabase(dataDir)).catch(() => null);
        if (database?.isFile()) {
          try {
            await validateSourceLauncher(launcher);
            const sources = [...this.sources, { id: 'codex-personal', provider: 'codex', label: 'ChatGPT Personal',
              dataDir, launcher, enabled: true, builtin: false, color: defaultSourceColor('codex-personal'), showMarker: true }];
            await this.validateStores(sources);
            await this.save(sources);
          } catch { this.warning = 'ASB could not register ChatGPT Personal. Check its local launcher and ASB settings folder.'; }
        }
      }
    })().finally(() => { this.readPromise = null; });
    await this.readPromise;
    return this.sources.map((source) => ({ ...source }));
  }

  async save(sources) {
    if (this.configPath) {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.configPath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, sources }, null, 2), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.configPath);
      } finally { await fs.rm(temporary, { force: true }); }
      const info = await fs.stat(this.configPath);
      this.signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    }
    this.sources = sources;
    this.initialized = true;
    this.warning = '';
  }

  async update(source) {
    const action = this.write.catch(() => {}).then(async () => {
      await this.read();
      const existing = typeof source?.id === 'string' ? this.sources.find((item) => item.id === source.id) : null;
      const next = await this.validate(source, { checkLauncher: source?.enabled !== false || !existing });
      if (next.id && !existing) throw invalid('This app source is not registered.');
      if (existing?.builtin && next.provider !== existing.provider) throw invalid('The default source provider cannot change.');
      next.id = existing?.id || `${next.provider === 'codex' ? 'codex' : 'claude'}-${randomUUID()}`;
      next.builtin = Boolean(existing?.builtin);
      next.color ??= existing?.color || defaultSourceColor(next.id);
      next.showMarker ??= existing?.showMarker ?? true;
      if (!next.builtin && !next.launcher && (!existing || next.enabled)) throw invalid('Additional app profiles need their own installed app launcher.');
      if (next.provider === 'claude-desktop-code' && next.projectsDir === undefined) {
        next.projectsDir = existing?.projectsDir || path.join(this.homeDir, '.claude', 'projects');
      }
      const sources = existing ? this.sources.map((item) => item.id === next.id ? next : item) : [...this.sources, next];
      await this.validateStores(sources);
      await this.save(sources);
    });
    this.write = action;
    await action;
  }

  async remove(id) {
    const action = this.write.catch(() => {}).then(async () => {
      await this.read();
      const source = this.sources.find((item) => item.id === id);
      if (!source) throw invalid('This app source is not registered.');
      if (source.builtin) throw invalid('Default app sources cannot be removed.');
      await this.save(this.sources.filter((item) => item.id !== id));
    });
    this.write = action;
    await action;
  }

  async report(dashboard) {
    const sources = numberAppSources(await this.read());
    return { sources: sources.map((source) => {
      const provider = dashboard.providers?.find((item) => item.id === source.id);
      return { ...source, sessionCount: dashboard.threads?.filter((row) => (row.sourceId || row.provider) === source.id).length || 0,
        status: !source.enabled ? 'disabled' : provider?.status || 'missing',
        message: provider?.message || this.warning || '' };
    }), maxSources: MAX_APP_SOURCES };
  }
}
