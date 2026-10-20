// The one grammar of ASB session references (SYSTEM_OVERVIEW.md, "Session references").
// Full form: asb:1/<machine-id>/<source-id>/<scope-tag>/<type>:<app-session-id>. Node standard library only.
import os from 'node:os';
import path from 'node:path';

export const MAX_REFERENCE_BYTES = 384;
const MACHINE = /^[0-9a-f]{16}$/;
const SOURCE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SCOPE = /^[0-9a-f]{32}$/;
const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
// The app session ID of each type; the app's own text is kept exactly, case included.
const APP_IDS = {
  codex: new RegExp(`^${UUID}$`),
  'claude-local': new RegExp(`^local_${UUID}$`),
  'claude-cli': new RegExp(`^${UUID}$`),
  // The bounded token of claudeRemoteDeepLink() in src/claude-remote-data.mjs.
  'claude-remote': /^(?:cse|session)_[A-Za-z0-9_-]{1,128}$/,
  opencode: /^[A-Za-z0-9_-]{1,128}$/,
};
const PROVIDERS = ['codex', 'claude-desktop-code', 'opencode'];
// Printable ASCII with no space: this also refuses whitespace and line breaks.
const PRINTABLE = /^[\x21-\x7e]+$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const failure = (code) => Object.assign(new Error(code === 'unsupported-reference-version'
  ? 'This session reference has an unsupported version.' : 'This is not a valid session reference.'), { code });

export function parseReference(text) {
  if (typeof text !== 'string' || text.length > MAX_REFERENCE_BYTES || !PRINTABLE.test(text) || !text.startsWith('asb:')) {
    throw failure('invalid-reference');
  }
  const parts = text.slice(4).split('/');
  if (parts[0] !== '1') throw failure(/^[0-9]{1,9}$/.test(parts[0]) ? 'unsupported-reference-version' : 'invalid-reference');
  if (parts.length !== 5) throw failure('invalid-reference');
  const [, machineId, sourceId, scopeTag, typed] = parts;
  const colon = typed.indexOf(':');
  const type = colon > 0 ? typed.slice(0, colon) : '';
  const appId = typed.slice(colon + 1);
  if (!matches(MACHINE, machineId) || !matches(SOURCE, sourceId) || !matches(SCOPE, scopeTag)
    || !Object.hasOwn(APP_IDS, type) || !APP_IDS[type].test(appId)) throw failure('invalid-reference');
  return { version: 1, machineId, sourceId, scopeTag, type, appId };
}

export function formatReference({ machineId, sourceId, scopeTag, type, appId } = {}) {
  const text = `asb:1/${machineId}/${sourceId}/${scopeTag}/${type}:${appId}`;
  // The parser checks every field, so a field cannot add a segment or hide another one.
  const parsed = parseReference(text);
  if (parsed.machineId !== machineId || parsed.sourceId !== sourceId || parsed.scopeTag !== scopeTag
    || parsed.type !== type || parsed.appId !== appId) throw failure('invalid-reference');
  return text;
}

// The type from the checked row fields, or null when the provider, surface, or app ID form does not give one.
export function referenceType(row) {
  const type = row?.provider === 'codex' ? 'codex' : row?.provider === 'opencode' ? 'opencode'
    : row?.provider !== 'claude-desktop-code' ? null : row.remoteCache === true ? 'claude-remote'
      : row.surface === 'cli' ? 'claude-cli' : row.surface === 'app' ? 'claude-local' : null;
  return type && matches(APP_IDS[type], row.externalId) ? type : null;
}

// The full reference of a row, or the reason that it has none. A full reference identifies the observation
// through this source; it does not say that this source owns or runs the session.
export function rowReference(row, { machineId, sourceId, scopeTag }, noScope = 'unknown-source') {
  if (!matches(MACHINE, machineId)) return { referenceUnavailable: 'no-machine-identity' };
  if (!matches(SCOPE, scopeTag)) return { referenceUnavailable: noScope };
  if (!matches(SOURCE, sourceId)) return { referenceUnavailable: 'unknown-source' };
  const type = referenceType(row);
  if (!type) return { referenceUnavailable: PROVIDERS.includes(row?.provider) ? 'invalid-app-id' : 'unsupported-type' };
  return { reference: formatReference({ machineId, sourceId, scopeTag, type, appId: row.externalId }) };
}

export const validScopeTag = (value) => matches(SCOPE, value);

// The keyed input of a source scope tag: the provider and its configured folders, as the registry stores them.
// A JSON array of strings is unambiguous, and the first item separates this use from all others.
export function scopeInput({ provider, dataDir, projectsDir } = {}) {
  const projects = provider !== 'claude-desktop-code' ? '' : projectsDir || path.join(os.homedir(), '.claude', 'projects');
  return JSON.stringify(['asb-session-reference-scope', 1, String(provider), String(dataDir), projects]);
}

// The short text that the board copies today (session_reference() in scripts/asb-native.py), when it is safe.
export function shortReference(row) {
  if (!referenceType(row)) return null;
  const host = row.sourceName || (['codex', 'opencode'].includes(row.provider) ? row.provider : 'claude-desktop-code');
  const text = `${host}/${row.externalId}`;
  return typeof host === 'string' && text.length <= MAX_REFERENCE_BYTES && PRINTABLE.test(text) ? text : null;
}
