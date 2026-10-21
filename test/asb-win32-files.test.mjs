import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPhoneGateway } from '../src/phone-gateway.mjs';
import { prepareInstanceRuntime, publishInstanceRuntime } from '../scripts/asb-instance.mjs';

// The win32 file branches run here with a Linux folder in place of %LOCALAPPDATA%\asb\run. Linux only: it uses links and modes.

const token = 'd'.repeat(64);

async function runtimeFolder(t, mode = 0o755) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asb-win32-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'asb', 'run');
  await mkdir(directory, { recursive: true });
  await chmod(directory, mode);
  return { root, directory, file: path.join(directory, 'service.json') };
}

test('on Windows the runtime file skips the mode checks but still refuses a link', async (t) => {
  const { root, directory, file } = await runtimeFolder(t);
  // Linux refuses this folder and file mode; Windows has no POSIX modes, so the same files are accepted there.
  await writeFile(file, JSON.stringify({ schema: 1, pid: 2147483646, port: 4629, sourceToken: token }), { mode: 0o644 });
  await assert.rejects(prepareInstanceRuntime({ XDG_RUNTIME_DIR: root }, { platform: 'linux', file }), /invalid service.json/);
  const prepared = await prepareInstanceRuntime({}, { platform: 'win32', file, answers: async () => assert.fail('a dead PID needs no check') });
  assert.equal(prepared.platform, 'win32');
  const runtime = { schema: 1, pid: process.pid, port: 4630, sourceToken: token };
  await publishInstanceRuntime(prepared, runtime);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), runtime);
  await rm(file);
  await writeFile(path.join(directory, 'other.json'), JSON.stringify({ schema: 1, pid: 2147483646, port: 4629, sourceToken: token }));
  await symlink(path.join(directory, 'other.json'), file);
  await assert.rejects(prepareInstanceRuntime({}, { platform: 'win32', file }), /invalid service.json/);
});

test('on Windows a live PID in service.json counts only when that engine answers', async (t) => {
  const { root, file } = await runtimeFolder(t, 0o700);
  const saved = { schema: 1, pid: process.pid, port: 4629, sourceToken: token };
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const asked = [];
  const answers = (value) => async (runtime) => { asked.push(runtime); return value; };
  await assert.rejects(prepareInstanceRuntime({}, { platform: 'win32', file, answers: answers(true) }), /belongs to a running process/);
  const prepared = await prepareInstanceRuntime({}, { platform: 'win32', file, answers: answers(false) });
  assert.deepEqual(asked, [saved, saved]);
  await publishInstanceRuntime(prepared, { ...saved, port: 4631 });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).port, 4631);
  // Linux keeps its PID check: a live PID refuses with no request.
  await assert.rejects(prepareInstanceRuntime({ XDG_RUNTIME_DIR: root }, { platform: 'linux', file, answers: answers(false) }),
    /belongs to a running process/);
  assert.equal(asked.length, 2);
});

test('credentials are key and cert on Linux', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asb-linux-cert-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = createPhoneGateway({ localPort: 4629, platform: 'linux', tlsDir: path.join(directory, 'tls'), settingsPath: path.join(directory, 'phone.json') });
  const credentials = await gateway.credentials();
  assert.deepEqual(Object.keys(credentials).sort(), ['cert', 'fingerprint', 'key']);
  assert.match(credentials.fingerprint, /^[a-f0-9]{64}$/);
});

test('the Windows tray icon is a 32 x 32 RGBA PNG', async () => {
  const bytes = await readFile(new URL('../assets/icons/asb-tray-32.png', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[24], bytes[25]], [32, 32, 8, 6]);
});

test('the Start menu link icon is one ICO file with PNG images at 16, 32, 48, and 256 px', async () => {
  const bytes = await readFile(new URL('../assets/icons/asb.ico', import.meta.url));
  // The header: reserved 0, type 1 (icon), and four images.
  assert.deepEqual([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)], [0, 1, 4]);
  const sizes = [];
  for (let index = 0; index < 4; index += 1) {
    const entry = 6 + 16 * index;
    const [width, height, planes, bits, length, offset] = [bytes[entry], bytes[entry + 1], bytes.readUInt16LE(entry + 4), bytes.readUInt16LE(entry + 6),
      bytes.readUInt32LE(entry + 8), bytes.readUInt32LE(entry + 12)];
    const png = bytes.subarray(offset, offset + length);
    assert.equal(png.length, length);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    // The directory writes 256 as 0, and the PNG header has the real size.
    const size = png.readUInt32BE(16);
    assert.deepEqual([png.readUInt32BE(20), png[24], png[25]], [size, 8, 6]);
    assert.deepEqual([width, height, planes, bits], [size % 256, size % 256, 1, 32]);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 32, 48, 256]);
});
