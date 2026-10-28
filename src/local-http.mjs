import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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

// A missing header means identity; gzip (or *) with q=0 refuses gzip.
export function acceptsGzip(header) {
  if (typeof header !== 'string') return false;
  const weights = new Map();
  for (const part of header.split(',')) {
    const [coding, ...params] = part.split(';').map((item) => item.trim().toLowerCase());
    const q = params.find((item) => item.startsWith('q='));
    weights.set(coding, q === undefined ? 1 : Number(q.slice(2)));
  }
  return (weights.get('gzip') ?? weights.get('*') ?? 0) > 0;
}

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});
export const jsCrc32 = (data, value = 0) => {
  let crc = ~value;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
};
// zlib.crc32 came in Node.js 20.15 and 22.2.
const crc32 = zlib.crc32 || jsCrc32;
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);

// One gzip member of a long head that compresses once and a short tail for each reply. Browsers read only the first member of a
// gzip body, so the head is a raw deflate stream that ends on a byte boundary with no final block, and the tail ends the stream.
export function gzipHead(text) {
  const head = Buffer.from(text);
  return { deflated: zlib.deflateRawSync(head, { level: 1, finishFlush: zlib.constants.Z_SYNC_FLUSH }), crc: crc32(head), length: head.length };
}

export function gzipWithTail({ deflated, crc, length }, text) {
  const tail = Buffer.from(text);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tail, crc), 0);
  trailer.writeUInt32LE((length + tail.length) % 2 ** 32, 4);
  return Buffer.concat([GZIP_HEADER, deflated, zlib.deflateRawSync(tail, { level: 1 }), trailer]);
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

export async function readJsonBody(request, limit = 64 * 1024) {
  let raw = '';
  // Decodes a character that two chunks split.
  request.setEncoding('utf8');
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > limit) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
  }

  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// Exactly the required keys, and only these optional ones.
export function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
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
    // A read error ends the response; it must not throw in the engine.
    pipeline(createReadStream(filePath), response, () => {});
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
