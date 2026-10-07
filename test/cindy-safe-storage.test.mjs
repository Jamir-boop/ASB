import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCindyProviderSecret } from '../src/cindy-safe-storage.mjs';

test('decrypts an owner-scoped Cindy provider secret without exposing it to command arguments', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-safe-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ownerId = 'local-data-owner-for-test';
  const ownerKey = createHash('sha256').update(ownerId).digest('hex').slice(0, 20);
  const password = 'test-safe-storage-password';
  const secret = 'local-deepseek-test-secret';
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(secret), cipher.final()]);
  const safeStorageDirectory = path.join(directory, 'safe-storage');
  await fs.mkdir(safeStorageDirectory, { recursive: true });
  await fs.writeFile(path.join(directory, 'native-provider-auth.json'), JSON.stringify({
    legacyClaimOwner: ownerId,
  }));
  await fs.writeFile(
    path.join(safeStorageDirectory, `owner_${ownerKey}_provider_key_deepseek_codex.enc`),
    encrypted.toString('base64'),
  );

  let commandArgs = [];
  const value = await readCindyProviderSecret({
    cindyDataDir: directory,
    providerId: 'deepseek',
    storageKeys: ['provider_key_deepseek_codex'],
    platform: 'darwin',
    runCommand: async (command, args) => {
      commandArgs = [command, ...args];
      return { stdout: password };
    },
  });

  assert.equal(value, secret);
  assert.equal(commandArgs.includes(secret), false);
  assert.equal(commandArgs.includes(ownerId), false);
  assert.deepEqual(commandArgs, [
    '/usr/bin/security',
    'find-generic-password',
    '-w',
    '-s',
    'Cindy Safe Storage',
  ]);
});
