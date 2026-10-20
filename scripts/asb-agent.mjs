import { constants } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { storeIdentity } from '../src/app-sources.mjs';
import { processStart, readLiveClaudeRegistry } from '../src/claude-registry.mjs';
import { readServiceRuntime, requestInstance } from './asb-instance.mjs';

const editable = ['provider', 'label', 'dataDir', 'launcher', 'enabled', 'projectsDir', 'remoteClaude', 'color', 'showMarker'];
const revision = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const usage = 'Usage: asb agent status [--json] | peers [--json] | sources list [--json] | sources get <id|name> [--json] | sources add --file <json-file|-> [--json] | sources update <id|name> --file <json-file|-> [--json] | sources remove <id|name> [--json] | resolve-session <reference> [--source <source-id>] [--json]';
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function parseArgs(args) {
  const json = args.includes('--json');
  if (args.filter((arg) => arg === '--json').length > 1) throw failure('usage', usage);
  args = args.filter((arg) => arg !== '--json');
  if (args.length === 1 && ['status', 'peers'].includes(args[0])) return { command: args[0], json };
  if (args[0] === 'resolve-session') {
    const [, reference, flag, sourceId] = args;
    if (!reference || reference.startsWith('--') || !(args.length === 2 || (args.length === 4 && flag === '--source' && SOURCE_ID.test(sourceId)))) {
      throw failure('usage', usage);
    }
    return { command: args[0], reference, ...(sourceId === undefined ? {} : { sourceId }), json };
  }
  if (args[0] !== 'sources') throw failure('usage', usage);
  const command = `sources.${args[1]}`;
  if (args[1] === 'list' && args.length === 2) return { command, json };
  if (['get', 'remove', 'update'].includes(args[1]) && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(args[2] || '')) throw failure('usage', usage);
  if (['get', 'remove'].includes(args[1]) && args.length === 3) return { command, id: args[2], json };
  const offset = args[1] === 'add' ? 2 : args[1] === 'update' ? 3 : -1;
  if (offset < 0 || args.length !== offset + 2 || args[offset] !== '--file' || !args[offset + 1] || args[offset + 1].startsWith('--')) throw failure('usage', usage);
  return { command, id: offset === 3 ? args[2] : undefined, file: args[offset + 1], json };
}

function checkedStatus(value, runtime) {
  if (!object(value) || value.apiVersion !== 1 || value.pid !== runtime.pid || !['service', 'desktop'].includes(value.mode)
    || typeof value.appVersion !== 'string' || typeof value.rootDir !== 'string' || !path.isAbsolute(value.rootDir)
    || typeof value.sourcesPath !== 'string' || !path.isAbsolute(value.sourcesPath)
    || !revision(value.sourcesRevision) || !(value.backendRevision === null || revision(value.backendRevision))
    || !Array.isArray(value.ui?.clients)) throw failure('unsupported_instance', 'ASB could not verify the running instance. Start the current ASB desktop or service.');
  const clients = value.ui.clients.filter((client) => object(client) && typeof client.clientId === 'string'
    && (client.sourcesRevision === null || revision(client.sourcesRevision)) && (client.profilesRevision === null || revision(client.profilesRevision))
    && typeof client.profilesVisible === 'boolean' && typeof client.dirty === 'boolean'
    && Number.isFinite(client.reportedAtMs) && Date.now() - client.reportedAtMs < 45_000 && client.reportedAtMs <= Date.now() + 1000)
    .map(({ clientId, sourcesRevision, profilesRevision, profilesVisible, dirty, reportedAtMs }) =>
      ({ clientId, sourcesRevision, profilesRevision, profilesVisible, dirty, reportedAtMs }));
  return { apiVersion: 1, pid: value.pid, mode: value.mode, appVersion: value.appVersion, rootDir: value.rootDir,
    sourcesPath: value.sourcesPath, sourcesRevision: value.sourcesRevision, backendRevision: value.backendRevision, ui: { clients } };
}

async function api(runtime, route, options) {
  let reply;
  try { reply = await requestInstance(runtime, route, options); }
  catch (error) { throw failure('connection_failed', error.message); }
  if (reply.statusCode !== 200) {
    const code = reply.statusCode === 409 ? 'revision_conflict' : reply.statusCode === 403 ? 'access_denied' : reply.statusCode === 400 ? 'invalid_source' : 'api_error';
    const message = reply.statusCode === 409 ? 'App sources changed. Read the current sources and repeat the command.'
      : typeof reply.body?.error === 'string' ? reply.body.error : `ASB returned HTTP ${reply.statusCode}.`;
    throw failure(code, message);
  }
  return reply.body;
}

async function status(runtime, timeoutMs = 2000) {
  return checkedStatus(await api(runtime, '/api/agent/status', { timeoutMs, maxBytes: 16 * 1024 }), runtime);
}

async function sources(runtime) {
  const value = await api(runtime, '/api/sources', { timeoutMs: 15_000 });
  if (!revision(value?.revision) || !Array.isArray(value.sources) || !value.sources.every((source) => object(source)
    && typeof source.id === 'string' && typeof source.provider === 'string' && typeof source.dataDir === 'string')) {
    throw failure('invalid_response', 'ASB sent an invalid source list.');
  }
  return value;
}

async function readHandle(handle, limit) {
  const buffer = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  return buffer.subarray(0, size);
}

async function readInput(file) {
  let bytes;
  try {
    if (file === '-') {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 64 * 1024) throw failure('invalid_input', 'The source JSON must be at most 64 KiB.');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } else {
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw failure('invalid_input', 'The source JSON path must be a regular file.');
        bytes = await readHandle(handle, 64 * 1024);
      } finally { await handle.close(); }
    }
  } catch (error) {
    if (error.code === 'invalid_input') throw error;
    throw failure('invalid_input', 'Cannot read the source JSON file.');
  }
  if (bytes.length > 64 * 1024) throw failure('invalid_input', 'The source JSON must be at most 64 KiB.');
  let value;
  try { value = JSON.parse(bytes); } catch { throw failure('invalid_input', 'The source file must contain one JSON object.'); }
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some((key) => !editable.includes(key))) {
    throw failure('invalid_input', `Use only these editable source fields: ${editable.join(', ')}.`);
  }
  return value;
}

const fields = (source) => Object.fromEntries(['id', ...editable].filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
const equalField = (key, left, right) => key === 'color' && typeof left === 'string' && typeof right === 'string'
  ? left.toLowerCase() === right.toLowerCase() : key === 'label' && typeof left === 'string' && typeof right === 'string'
    ? left.trim() === right.trim() : ['dataDir', 'projectsDir', 'launcher'].includes(key) && typeof left === 'string' && typeof right === 'string' && left && right
      ? path.isAbsolute(left) && path.isAbsolute(right) && path.resolve(left) === path.resolve(right) : left === right;
const suppliedEqual = (source, input, sameStore = false) => Object.keys(input).every((key) => sameStore && key === 'dataDir' || equalField(key, source[key], input[key]));

function uiEvidence(instance, target, acknowledgedAfter = 0) {
  const clients = instance.ui.clients.map((client) => ({ ...client,
    status: client.reportedAtMs >= acknowledgedAfter && client.sourcesRevision === target && (!client.profilesVisible || client.profilesRevision === target)
      ? client.dirty ? 'dirty' : 'verified' : 'pending' }));
  return { status: !clients.length ? 'not-open' : clients.some((client) => client.status === 'pending') ? 'pending'
    : clients.some((client) => client.status === 'dirty') ? 'dirty' : 'verified', clients };
}

async function verify(runtime, target, acknowledgedAfter) {
  const result = { saved: { status: 'unverified', revision: target }, backend: { status: 'unverified' }, ui: { status: 'unverified', clients: [] } };
  try {
    const report = await sources(runtime);
    result.saved = { status: report.revision === target ? 'verified' : 'changed-after-write', revision: report.revision };
    const deadline = Date.now() + 2500;
    do {
      const instance = await status(runtime, Math.max(1, Math.min(2000, deadline - Date.now())));
      result.backend = { status: instance.backendRevision === target ? 'verified' : 'pending', sourcesRevision: instance.backendRevision };
      result.ui = uiEvidence(instance, target, acknowledgedAfter);
      if (result.ui.status !== 'pending' || Date.now() >= deadline) break;
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
  } catch (error) { result.error = { code: error.code || 'verification_failed', message: error.message }; }
  return result;
}

const canonical = (value) => realpath(value).catch(() => path.resolve(value));

function findSource(list, selector) {
  const exact = list.find((source) => source.id === selector);
  if (exact || selector === undefined) return exact;
  const named = list.filter((source) => source.name === selector);
  if (named.length > 1) throw failure('source_ambiguous', `More than one app source uses the name ${selector}. Use its id.`);
  return named[0];
}

// Keep only the two home variables; the rest of the peer's environment is never decoded.
async function processHomes(pid) {
  let buffer;
  try { buffer = await readFile(`/proc/${pid}/environ`); } catch { return null; }
  const homes = {};
  for (let start = 0; start < buffer.length;) {
    let end = buffer.indexOf(0, start);
    if (end < 0) end = buffer.length;
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
      const prefix = Buffer.from(`${key}=`);
      if (end - start >= prefix.length && buffer.subarray(start, start + prefix.length).equals(prefix)) homes[key] = buffer.toString('utf8', start + prefix.length, end);
    }
    start = end + 1;
  }
  buffer.fill(0);
  return homes;
}

async function listPeers(list) {
  const codexStores = await Promise.all(list.filter((source) => source.provider === 'codex').map(async (source) => ({ name: source.name, home: await canonical(source.dataDir) })));
  const claudeStores = await Promise.all(list.filter((source) => source.provider === 'claude-desktop-code' && source.projectsDir)
    .map(async (source) => ({ name: source.name, home: await canonical(path.dirname(source.projectsDir)) })));
  const records = await readLiveClaudeRegistry([...list.filter((source) => source.provider === 'claude-desktop-code' && source.projectsDir)
    .map((source) => path.join(path.dirname(source.projectsDir), 'sessions')), path.join(os.homedir(), '.claude', 'sessions')]);
  const peers = [];
  const unregistered = new Map();
  for (const record of records) {
    const homes = await processHomes(record.pid);
    if (await processStart(record.pid) !== record.procStart) continue;
    const codex = record.entrypoint === 'codex-asb-bridge';
    let instance = 'unknown';
    const value = homes?.[codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
    // The CLI cannot resolve a relative path against another process's working directory.
    const home = homes && (value === undefined || path.isAbsolute(value))
      && await canonical(value ?? path.join(os.homedir(), codex ? '.codex' : '.claude'));
    if (home) {
      const matches = (codex ? codexStores : claudeStores).filter((store) => store.home === home);
      if (matches.length === 1) instance = matches[0].name;
      if (!codex && !matches.length) unregistered.set(`claude-desktop-code\0${home}`, { provider: 'claude-desktop-code', home });
    }
    peers.push({ instance, name: record.name, address: `${instance}/${record.name}`, sessionId: record.sessionId,
      pid: record.pid, status: record.status, cwd: record.cwd, kind: record.kind, entrypoint: record.entrypoint });
  }
  for (const peer of peers) peer.duplicate = peers.filter((other) => other.name === peer.name).length > 1;
  peers.sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : left.pid - right.pid);
  for (const entry of await readdir(os.homedir()).catch(() => [])) {
    if (!entry.startsWith('.codex')) continue;
    const home = path.join(os.homedir(), entry);
    if (!(await stat(path.join(home, 'config.toml')).catch(() => null))?.isFile()) continue;
    const real = await canonical(home);
    if (!codexStores.some((store) => store.home === real)) unregistered.set(`codex\0${real}`, { provider: 'codex', home: real });
  }
  const notInAsb = [...unregistered.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, entry]) => entry);
  return { ok: true, command: 'peers', peers, notInAsb };
}

async function run(args, rememberRuntime) {
  const parsed = parseArgs(args);
  const input = parsed.file ? await readInput(parsed.file) : null;
  const runtime = await readServiceRuntime();
  if (!runtime) throw failure('instance_unavailable', 'No safe ASB runtime file is available. Start the current ASB desktop or service with XDG_RUNTIME_DIR set.');
  rememberRuntime(runtime);
  const instance = await status(runtime);
  if (parsed.command === 'status') return { ok: true, command: parsed.command, instance };
  if (parsed.command === 'resolve-session') {
    const body = { reference: parsed.reference, ...(parsed.sourceId === undefined ? {} : { sourceId: parsed.sourceId }) };
    const value = await api(runtime, '/api/agent/resolve-session', { method: 'POST', body, timeoutMs: 15_000, maxBytes: 16 * 1024 });
    if (!object(value) || value.apiVersion !== 1 || typeof value.ok !== 'boolean') throw failure('invalid_response', 'ASB sent an invalid resolve result.');
    if (!value.ok) throw failure(typeof value.code === 'string' ? value.code : 'invalid_response', typeof value.message === 'string' ? value.message : 'ASB could not resolve the reference.');
    return { ...value, ok: true, command: parsed.command };
  }
  const report = await sources(runtime);
  if (parsed.command === 'peers') return listPeers(report.sources);
  if (parsed.command === 'sources.list') return { ok: true, command: parsed.command, ...report };
  const current = findSource(report.sources, parsed.id);
  if (parsed.command === 'sources.get') {
    if (!current) throw failure('source_not_found', 'This app source is not registered.');
    return { ok: true, command: parsed.command, revision: report.revision, source: current };
  }
  let next;
  let unchanged = false;
  let source = current;
  if (parsed.command === 'sources.add') {
    if (typeof input.provider !== 'string' || typeof input.dataDir !== 'string' || !path.isAbsolute(input.dataDir)) throw failure('invalid_input', 'A new source needs a provider and an absolute dataDir.');
    const identity = await storeIdentity(input);
    for (const item of report.sources) {
      if (await storeIdentity(item) === identity) { source = item; break; }
    }
    if (source) {
      if (!suppliedEqual(source, input, true)) throw failure('source_exists', `This session store is registered as ${source.id}. Use sources update ${source.id} --file <json-file>.`);
      unchanged = true;
    } else next = { enabled: true, ...input };
  } else if (parsed.command === 'sources.update') {
    if (!current) throw failure('source_not_found', 'This app source is not registered.');
    next = { ...fields(current), ...input };
    if (next.provider !== 'claude-desktop-code' && !Object.hasOwn(input, 'projectsDir')) delete next.projectsDir;
    if (next.provider !== 'claude-desktop-code' && !Object.hasOwn(input, 'remoteClaude')) delete next.remoteClaude;
    unchanged = suppliedEqual(current, input);
  } else unchanged = !current;
  let savedReport = report;
  const acknowledgedAfter = unchanged ? 0 : Date.now();
  if (!unchanged) savedReport = await api(runtime, parsed.command === 'sources.remove' ? `/api/sources/${current.id}/remove` : '/api/sources',
    { method: 'POST', body: parsed.command === 'sources.remove' ? {} : { source: next }, headers: { 'If-Match': `"${report.revision}"` }, timeoutMs: 15_000 });
  if (!revision(savedReport?.revision)) throw failure('invalid_response', 'ASB saved the request but did not return a source revision.');
  if (!unchanged && !revision(savedReport.savedRevision)) throw failure('invalid_response', 'ASB saved the request but did not return its write revision.');
  const target = unchanged ? savedReport.revision : savedReport.savedRevision;
  if (!unchanged && Array.isArray(savedReport.sources) && next) source = savedReport.sources.find((item) => next.id ? item.id === next.id : !report.sources.some((old) => old.id === item.id));
  const verification = await verify(runtime, target, acknowledgedAfter);
  return { ok: verification.saved.status === 'verified' && verification.backend.status === 'verified', command: parsed.command,
    changed: !unchanged, revision: target, ...(source ? { source } : {}), verification };
}

const printable = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);

function human(result) {
  if (!result.ok && result.error) return `ASB agent: ${result.error.message}`;
  if (result.command === 'status') return `ASB ${result.instance.appVersion}: ${result.instance.mode}, PID ${result.instance.pid}.\nRoot: ${result.instance.rootDir}\nSources file: ${result.instance.sourcesPath}\nSources revision: ${result.instance.sourcesRevision}.\nBackend: ${result.instance.backendRevision === result.instance.sourcesRevision ? 'verified' : 'pending'}. UI: ${uiEvidence(result.instance, result.instance.sourcesRevision).status}.`;
  if (result.command === 'peers') {
    const lines = result.peers.map((peer) => [peer.address, peer.status, `pid ${peer.pid}`, peer.cwd, ...(peer.duplicate ? ['duplicate name'] : [])].map(printable).join('\t'));
    if (!lines.length) lines.push('No live agents.');
    if (result.notInAsb.length) lines.push('Not in ASB:', ...result.notInAsb.map((entry) => `  ${printable(entry.provider)}\t${printable(entry.home)}`));
    return lines.join('\n');
  }
  if (result.command === 'sources.list') return result.sources.map((source) => `${source.id}\t${source.name ?? ''}\t${source.provider}\t${source.enabled ? 'enabled' : 'disabled'}\t${source.label}\t${source.dataDir}`).join('\n') || 'No app sources.';
  if (result.command === 'sources.get') return JSON.stringify(result.source, null, 2);
  if (result.command === 'resolve-session') {
    const lines = [`Session reference (${result.form}): ${result.availability}.`];
    if (result.identity) lines.push(`Reference: ${printable(result.identity.reference)}`);
    if (result.referenceUnavailable) lines.push(`No full reference: ${printable(result.referenceUnavailable)}.`);
    if (result.display) lines.push(`Machine: ${printable(result.display.machineName ?? 'unknown')}. Source: ${printable(result.display.sourceName ?? 'unknown')}.${result.display.providerLabel ? ` App: ${printable(result.display.providerLabel)}.` : ''}`);
    if (result.location) lines.push(`Location: ${result.location}.`);
    return lines.join('\n');
  }
  return `App sources ${result.changed ? 'saved' : 'unchanged'}.\nSaved: ${result.verification.saved.status}. Backend: ${result.verification.backend.status}. UI: ${result.verification.ui.status}.${result.verification.error ? `\n${result.verification.error.message}` : ''}`;
}

export async function main(args = process.argv.slice(2)) {
  let runtime;
  let result;
  try { result = await run(args, (value) => { runtime = value; }); }
  catch (error) { result = { ok: false, command: args[0] === 'sources' ? `sources.${args[1] || ''}` : args[0] || '', error: { code: error.code || 'agent_error', message: error.message } }; }
  let output = args.includes('--json') ? JSON.stringify(result) : human(result);
  if (runtime) output = output.replaceAll(runtime.sourceToken, '[redacted]');
  (result.ok ? console.log : console.error)(output);
  return result.ok ? 0 : result.error?.code === 'usage' ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
