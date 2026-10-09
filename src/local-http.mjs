import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

export function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

export function durationSince(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}

export function hitRatePercent(hits, misses) {
  const total = Number(hits || 0) + Number(misses || 0);
  if (!total) return null;
  return Math.round((Number(hits || 0) / total) * 100);
}

export async function readJsonBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
  }

  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function safeStaticPath(publicDir, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  const resolved = path.resolve(publicDir, `.${decodedPath}`);
  if (!resolved.startsWith(publicDir)) return null;
  return resolved;
}

export async function serveStatic(request, response, publicDir) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const filePath = safeStaticPath(publicDir, url.pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'content-type': MIME_TYPES.get(path.extname(filePath)) || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

export function parseBooleanSearchParam(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

export function threadNotFound(response) {
  sendJson(response, 404, { error: 'Thread not found' });
}
