// A cold-start probe for the engine on made-up data only. It makes a private temp HOME with Codex rollouts and Claude
// transcripts, starts a silent service-mode engine from this checkout on a free loopback port, reads /api/dashboard once,
// stops it, starts a second engine on the same folders, and prints one JSON line per start.
// It never reads the real HOME (~/.codex, ~/.claude, ~/.config/asb).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENGINE = path.join(ROOT, 'scripts', 'asb-engine.mjs');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} takes a whole number.`);
  return value;
}

const jsonl = (lines) => `${lines.join('\n')}\n`;
const nowMs = Date.now();
const at = (minutes) => nowMs - minutes * 60_000;
const uuid = () => randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
  '$1-$2-$3-$4-$5');

// Codex rollouts: the made-up event shapes of test/reader-positions.test.mjs and test/codex-data.test.mjs.
function codexRollout(index) {
  const start = at(60 + index);
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: new Date(start).toISOString(), payload: { type: 'user_message', message: 'Synthetic prompt' } }),
    JSON.stringify({ type: 'event_msg', timestamp: new Date(start + 1000).toISOString(), payload: { type: 'task_started' } }),
    ...Array.from({ length: 6 }, (_, line) => JSON.stringify({ type: 'event_msg',
      timestamp: new Date(start + 2000 + line * 1000).toISOString(),
      payload: { type: 'tool_output', text: `Synthetic output ${'x'.repeat(256)}` } })),
    JSON.stringify({ type: 'event_msg', timestamp: new Date(start + 10_000).toISOString(), payload: { type: 'task_complete' } }),
  ];
  return lines;
}

function codexTree(home, count, big) {
  const codexDir = path.join(home, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions', '2026', '11', '26');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(codexDir, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`pragma journal_mode = delete;
    create table threads (
    id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null,
    source text not null, model_provider text not null, cwd text not null, title text not null,
    tokens_used integer not null default 0, archived integer not null default 0,
    created_at_ms integer, updated_at_ms integer, model text, reasoning_effort text);`);
  const insert = database.prepare('insert into threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, tokens_used, archived, created_at_ms, updated_at_ms, model, reasoning_effort) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const titles = [];
  let compressed = 0;
  for (let index = 0; index < count; index += 1) {
    const id = uuid();
    const updateAtMs = at(60 + index);
    const rolloutPath = path.join(sessionsDir, `rollout-2026-11-26T12-00-00-${id}.jsonl`);
    const lines = codexRollout(index);
    // The first `big` rollouts are large; a large one holds many small lines, so the tail read stays cheap.
    if (index < big) for (let line = 0; line < 7000; line += 1) lines.push(JSON.stringify({ type: 'event_msg',
      timestamp: new Date(updateAtMs + 20_000 + line * 1000).toISOString(), payload: { type: 'tool_output', text: `Synthetic output ${'x'.repeat(1024)}` } }));
    if (typeof zstdCompressSync === 'function' && index % 4 === 3) {
      writeFileSync(`${rolloutPath}.zst`, zstdCompressSync(jsonl(lines)), { mode: 0o600 });
      compressed += 1;
    } else {
      writeFileSync(rolloutPath, jsonl(lines), { mode: 0o600 });
    }
    insert.run(id, rolloutPath, Math.floor(updateAtMs / 1000), Math.floor(updateAtMs / 1000), 'vscode', 'openai',
      path.join(home, 'work', 'project'), `Synthetic Codex thread ${index}`, 100, 0, updateAtMs, updateAtMs, 'gpt-5.5', 'medium');
    titles.push({ id, thread_name: `Synthetic Codex thread ${index}` });
  }
  insert.finalize?.();
  database.close();
  writeFileSync(path.join(codexDir, 'session_index.jsonl'), jsonl(titles.map((title) => JSON.stringify(title))), { mode: 0o600 });
  return { compressed };
}

// Claude Desktop Code: one metadata record and one transcript per session, as in test/claude-data.test.mjs.
function claudeTree(home, configHome, count, big) {
  const appDir = path.join(configHome, 'Claude');
  const claudeHome = path.join(home, '.claude');
  const projectsDir = path.join(claudeHome, 'projects');
  const sessionsDir = path.join(appDir, 'claude-code-sessions', 'account', 'workspace');
  const projectDir = path.join(projectsDir, 'synthetic-project');
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    const cliSessionId = uuid();
    const start = at(30 + index);
    const lines = [
      JSON.stringify({ type: 'user', timestamp: new Date(start).toISOString(), sessionId: cliSessionId, gitBranch: 'main',
        message: { role: 'user', content: 'Synthetic prompt' } }),
      // The first `big` transcripts are above 8 MiB; the rest are small.
      ...(index < big ? Array.from({ length: 9000 }, (_, line) => JSON.stringify({ type: 'progress',
        timestamp: new Date(start + line).toISOString(), data: `Synthetic progress ${'x'.repeat(1024)}` })) : []),
      JSON.stringify({ type: 'assistant', timestamp: new Date(start + 5000).toISOString(), sessionId: cliSessionId, gitBranch: 'main',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic reply' }] } }),
    ];
    writeFileSync(path.join(projectDir, `${cliSessionId}.jsonl`), jsonl(lines), { mode: 0o600 });
    const metadata = path.join(sessionsDir, `local_${cliSessionId}.json`);
    writeFileSync(metadata, JSON.stringify({ sessionId: `local_${cliSessionId}`, cliSessionId, cwd: path.join(home, 'work', 'project'),
      createdAt: at(600), lastActivityAt: start, title: `Synthetic Claude session ${index}` }), { mode: 0o600 });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function readJson(port, route, token) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, headers: { 'x-asb-source-token': token } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`${route} answered HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
  });
}

async function startEngine(env) {
  const child = spawn(process.execPath, [ENGINE, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const runtime = path.join(env.XDG_RUNTIME_DIR, 'asb', 'service.json');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The engine ended at start (exit ${child.exitCode}): ${output}`);
    try {
      const record = JSON.parse(readFileSync(runtime, 'utf8'));
      if (record?.port) return { child, record, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  child.kill('SIGKILL');
  throw new Error(`The engine did not answer in 60 s: ${output}`);
}

async function stopEngine(child) {
  child.kill('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  const codexCount = option('codex', 50);
  const claudeCount = option('claude', 50);
  const big = option('big', 2);
  const root = mkdtempSync(path.join(os.tmpdir(), 'asb-cold-start-'));
  chmodSync(root, 0o700);
  try {
    const home = path.join(root, 'home');
    const configHome = path.join(root, 'config');
    const dirs = {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_RUNTIME_DIR: path.join(root, 'runtime'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data'),
    };
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(dirs.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
    mkdirSync(dirs.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    codexTree(home, codexCount, big);
    claudeTree(home, configHome, claudeCount, big);
    const env = { ...dirs, PATH: process.env.PATH, ASB_TRAY: '0', PORT: String(await freePort()) };
    for (const name of Object.keys(process.env)) {
      if (/^(DBUS_|DISPLAY|WAYLAND_)/.test(name)) delete env[name];
    }
    for (const start of [1, 2]) {
      const { child, record } = await startEngine(env);
      try {
        const dashboard = await readJson(record.port, '/api/dashboard', record.sourceToken);
        const performance = dashboard.performance?.dashboard || {};
        const bytes = performance.firstLoadBytes || {};
        console.log(JSON.stringify({
          start,
          firstLoadMs: performance.firstLoadMs ?? null,
          firstLoadDoneMs: performance.firstLoadDoneMs ?? null,
          codexBytes: bytes.codex ?? null,
          claudeBytes: bytes.claude ?? null,
          decompressions: performance.firstLoadDecompressions ?? null,
          rows: Array.isArray(dashboard.threads) ? dashboard.threads.length : null,
        }));
      } finally {
        await stopEngine(child);
      }
    }
  } finally {
    // Delete only the folder that mkdtemp made, and only under the system temp folder.
    if (path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`Cold-start probe failed: ${error.message}`); process.exitCode = 1; });
