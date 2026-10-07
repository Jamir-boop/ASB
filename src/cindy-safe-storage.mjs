import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SAFE_STORAGE_SERVICE = 'Cindy Safe Storage';
const SAFE_STORAGE_PREFIX = 'v10';
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const secretCache = new Map();

function ownerStorageKey(ownerId) {
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 20);
}

function decryptSafeStorage(encoded, password) {
  const envelope = Buffer.from(String(encoded || '').trim(), 'base64');
  if (envelope.length <= SAFE_STORAGE_PREFIX.length
    || envelope.subarray(0, SAFE_STORAGE_PREFIX.length).toString() !== SAFE_STORAGE_PREFIX) {
    throw new Error('unsupported Cindy credential envelope');
  }
  const key = pbkdf2Sync(String(password), 'saltysalt', 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    decipher.update(envelope.subarray(SAFE_STORAGE_PREFIX.length)),
    decipher.final(),
  ]).toString('utf8');
}

async function readBindings(cindyDataDir) {
  try {
    const value = JSON.parse(await fs.readFile(
      path.join(cindyDataDir, 'native-provider-auth.json'),
      'utf8',
    ));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function activeOwner(bindings, providerId) {
  const values = providerId === 'xai'
    ? [bindings?.selfAuthorized?.xai, bindings?.xai, bindings?.legacyClaimOwner]
    : [bindings?.legacyClaimOwner, bindings?.[providerId]];
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

async function regularSecretFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return !stat.isSymbolicLink()
      && stat.isFile()
      && stat.size > 0
      && stat.size <= MAX_SECRET_FILE_BYTES
      ? stat
      : null;
  } catch {
    return null;
  }
}

export async function readCindyProviderSecret({
  cindyDataDir,
  providerId,
  storageKeys,
  runCommand,
  platform = process.platform,
}) {
  if (platform !== 'darwin' || !cindyDataDir || typeof runCommand !== 'function') return null;
  const safeProviderId = String(providerId || '').trim();
  const candidates = [...new Set((Array.isArray(storageKeys) ? storageKeys : [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^[a-z0-9_-]{1,128}$/.test(value)))];
  if (!safeProviderId || !candidates.length) return null;

  const bindings = await readBindings(cindyDataDir);
  const ownerId = activeOwner(bindings, safeProviderId);
  if (!ownerId) return null;
  const ownerKey = ownerStorageKey(ownerId);

  let secretPath = '';
  let stat = null;
  for (const storageKey of candidates) {
    const candidatePath = path.join(
      cindyDataDir,
      'safe-storage',
      `owner_${ownerKey}_${storageKey}.enc`,
    );
    const candidateStat = await regularSecretFile(candidatePath);
    if (!candidateStat) continue;
    secretPath = candidatePath;
    stat = candidateStat;
    break;
  }
  if (!secretPath || !stat) return null;

  const cached = secretCache.get(secretPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) return cached.secret;

  const [{ stdout }, encoded] = await Promise.all([
    runCommand('/usr/bin/security', [
      'find-generic-password',
      '-w',
      '-s',
      SAFE_STORAGE_SERVICE,
    ], {
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      encoding: 'utf8',
    }),
    fs.readFile(secretPath, 'utf8'),
  ]);
  const secret = decryptSafeStorage(encoded, String(stdout || '').trim()).trim();
  if (!secret || secret.length > 64 * 1024) return null;
  secretCache.set(secretPath, { mtimeMs: stat.mtimeMs, size: stat.size, secret });
  return secret;
}
