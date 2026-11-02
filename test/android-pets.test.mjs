import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Android ships the board pets byte for byte', async () => {
  const root = new URL('../', import.meta.url);
  assert.deepEqual(
    await readFile(new URL('android/app/src/main/assets/pets/pets.json', root)),
    await readFile(new URL('assets/pets/pets.json', root)),
  );
});
