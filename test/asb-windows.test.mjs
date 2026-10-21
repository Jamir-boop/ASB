import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPhoneGateway, readerPositionsKeyFrom, referenceScopeTagger, WINDOWS_CERTIFICATE_SCRIPT } from '../src/phone-gateway.mjs';
import { loadClaudeRemoteThreads } from '../src/claude-remote-data.mjs';
import { engineFolders, main as engineMain, readerPositionsPath, RUN_KEY, trayCommand, trayStartArguments, writesEngineLog } from '../scripts/asb-engine.mjs';
import { protectWindowsFolder } from '../scripts/asb-instance.mjs';
import { main as dispatch, NODE_HINT, WINDOWS_USAGE } from '../scripts/asb.mjs';
import { boardCheck, MSYS2_PYTHON, pythonCandidates } from '../src/linux-system.mjs';

// Windows branches with injected platform, execFile, spawn, and engine lookups. Platform-neutral (test/windows-tests.json).

// A public test certificate (ECDSA P-256, CN=ASB); its key was never kept.
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBcDCCARegAwIBAgIUa75tBDagtiNnzswuvkNenDyZam8wCgYIKoZIzj0EAwIw
DjEMMAoGA1UEAwwDQVNCMB4XDTI2MTAxOTIyMDk0MloXDTM2MTAxNjIyMDk0Mlow
DjEMMAoGA1UEAwwDQVNCMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBnv2adjy
E5xiemjlkkHBWDc1rb4tEp6WSiZIz33o4T1x/oM8691hTH2cdSgSbUCNfq5OGkuq
vPZhSyHx/MRZYaNTMFEwHQYDVR0OBBYEFJ6G+IaJLC16DI4dNAYZe8kPBn9xMB8G
A1UdIwQYMBaAFJ6G+IaJLC16DI4dNAYZe8kPBn9xMA8GA1UdEwEB/wQFMAMBAf8w
CgYIKoZIzj0EAwIDRwAwRAIgLJWkR3KJN4g9UaVPW/DfqdUJ4TyJRzElxFETUQs+
7AgCIE5wuN7QJUCEfR0+85UWBxtlxYomM4DMylMm8YLcwfbM
-----END CERTIFICATE-----
`;
const DER = new X509Certificate(CERTIFICATE).raw;

async function folder(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('on Windows the certificate comes from PowerShell with the folder and passphrase in the environment only', async (t) => {
  const directory = await folder(t, 'asb-win-cert-');
  const tlsDir = path.join(directory, 'phone-tls');
  const calls = [];
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    await writeFile(path.join(options.env.ASB_TLS_DIR, 'cert.pfx'), 'synthetic pfx');
    await writeFile(path.join(options.env.ASB_TLS_DIR, 'cert.cer'), DER);
    return { stdout: '', stderr: '' };
  };
  const gateway = createPhoneGateway({ localPort: 4629, platform: 'win32', env: { SYNTHETIC: '1' }, execFile, tlsDir,
    settingsPath: path.join(directory, 'phone.json') });
  const credentials = await gateway.credentials();
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CERTIFICATE_SCRIPT]);
  assert.deepEqual(Object.keys(options).sort(), ['env', 'timeout', 'windowsHide']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 30_000);
  assert.equal(options.env.SYNTHETIC, '1');
  assert.equal(options.env.ASB_TLS_DIR, tlsDir);
  assert.match(options.env.ASB_PFX_PASS, /^[a-f0-9]{64}$/);
  assert.ok(!args.join(' ').includes(options.env.ASB_PFX_PASS));
  assert.equal(await readFile(path.join(tlsDir, 'pfx-pass'), 'utf8'), options.env.ASB_PFX_PASS);
  assert.deepEqual(Object.keys(credentials).sort(), ['fingerprint', 'passphrase', 'pfx']);
  assert.equal(credentials.passphrase, options.env.ASB_PFX_PASS);
  assert.equal(credentials.pfx.toString(), 'synthetic pfx');
  assert.equal(credentials.fingerprint, createHash('sha256').update(DER).digest('hex'));
  assert.equal(await gateway.identity(), credentials.fingerprint.slice(0, 16));
  assert.equal(calls.length, 1, 'the saved files are used again');
});

test('a failed Windows certificate leaves no partial files and no identity', async (t) => {
  const directory = await folder(t, 'asb-win-cert-');
  const tlsDir = path.join(directory, 'phone-tls');
  await mkdir(tlsDir);
  await writeFile(path.join(tlsDir, 'cert.cer'), 'old partial file');
  const gateway = createPhoneGateway({ localPort: 4629, platform: 'win32', tlsDir, settingsPath: path.join(directory, 'phone.json'),
    execFile: async (_command, _args, options) => {
      await writeFile(path.join(options.env.ASB_TLS_DIR, 'cert.pfx'), 'partial');
      throw new Error('PowerShell failed');
    } });
  await assert.rejects(gateway.credentials(), /PowerShell failed/);
  assert.deepEqual(await readdir(tlsDir), []);
  assert.equal(await gateway.identity(), '');
});

test('the Windows engine limits its cache folder too, which holds the reader positions', () => {
  const env = { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' };
  assert.deepEqual(engineFolders(env, 'win32'), ['D:\\Roaming\\asb', 'D:\\Local\\asb\\state', 'D:\\Local\\asb\\run', 'D:\\Local\\asb\\cache']);
  assert.equal(readerPositionsPath(env, 'win32'), 'D:\\Local\\asb\\cache\\readers\\positions.json');
  assert.equal(readerPositionsPath({ XDG_CACHE_HOME: '/cache' }, 'linux'), '/cache/asb/readers/positions.json');
  // The positions key comes from the identity secret (the PFX passphrase on Windows), with its own label.
  const key = readerPositionsKeyFrom('passphrase');
  assert.equal(key.length, 32);
  assert.deepEqual(readerPositionsKeyFrom('passphrase'), key);
  assert.notDeepEqual(readerPositionsKeyFrom('other'), key);
  assert.notEqual(key.toString('hex').slice(0, 32), referenceScopeTagger('passphrase')({ provider: 'codex', dataDir: 'D:\\x' }));
  assert.throws(() => readerPositionsKeyFrom(''), /No machine identity secret/);
});

test('the Windows folder limit uses icacls with the user, and warns with no user name', async () => {
  const calls = [];
  const execFile = async (...args) => { calls.push(args); return { stdout: '' }; };
  const logs = [];
  const log = (line) => logs.push(line);
  assert.equal(await protectWindowsFolder('C:\\Users\\a\\AppData\\Roaming\\asb', { env: { USERDOMAIN: 'HOMELP', USERNAME: 'a' }, execFile, log }), true);
  assert.deepEqual(calls[0], ['icacls', ['C:\\Users\\a\\AppData\\Roaming\\asb', '/inheritance:r', '/grant:r', 'HOMELP\\a:(OI)(CI)F'], { windowsHide: true }]);
  await protectWindowsFolder('D:\\asb', { env: { USERNAME: 'a' }, execFile, log });
  assert.equal(calls[1][1][3], 'a:(OI)(CI)F');
  assert.equal(await protectWindowsFolder('D:\\asb', { env: { USERDOMAIN: 'HOMELP' }, execFile, log }), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(logs, ['ASB cannot limit D:\\asb to this user: USERNAME is not set.']);
  assert.equal(await protectWindowsFolder('D:\\asb', { env: { USERNAME: 'a' }, execFile: async () => { throw new Error('denied'); }, log }), false);
  assert.equal(logs.at(-1), 'ASB cannot limit D:\\asb to this user: denied');
});

test('Claude web sessions are not read on Windows; the source warns only when the cache folder exists', async (t) => {
  const appDir = await folder(t, 'asb-win-claude-');
  assert.deepEqual(await loadClaudeRemoteThreads({ appDir, platform: 'win32' }),
    { threads: [], partial: false, unread: false, provider: { installed: false, status: 'desktop' } });
  await mkdir(path.join(appDir, 'Cache', 'Cache_Data'), { recursive: true });
  await writeFile(path.join(appDir, 'Cache', 'Cache_Data', 'index'), 'blockfile index');
  assert.deepEqual(await loadClaudeRemoteThreads({ appDir, platform: 'win32' }),
    { threads: [], partial: false, unread: true, provider: { installed: false, status: 'warning' } });
});

function engineFakes({ running = [null, { pid: 41, port: 4629 }], queryFails = false, trayExit = 0 } = {}) {
  const calls = { exec: [], spawn: [], logs: [] };
  const lookups = [...running];
  return {
    calls,
    context: {
      platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, root: 'C:\\asb', node: 'C:\\node\\node.exe', timeoutMs: 2000,
      execFile: async (command, args, options) => {
        calls.exec.push([command, args, options]);
        if (queryFails && args[0] === 'query') throw Object.assign(new Error('missing'), { code: 1 });
        return { stdout: '' };
      },
      spawn: (command, args, options) => {
        calls.spawn.push([command, args, options]);
        const child = new EventEmitter();
        setImmediate(() => child.emit('exit', trayExit));
        return child;
      },
      find: async (_env, platform) => { assert.equal(platform, 'win32'); return lookups.length > 1 ? lookups.shift() : lookups[0]; },
      log: (line) => calls.logs.push(line), error: (line) => calls.logs.push(`error: ${line}`),
    },
  };
}

test('asb engine install on Windows writes the Run value from Node, then starts the tray and waits for the engine', async () => {
  const { calls, context } = engineFakes();
  assert.equal(await engineMain(['install'], context), 0);
  assert.deepEqual(calls.exec, [['reg', ['add', RUN_KEY, '/v', 'ASB', '/t', 'REG_SZ', '/d', trayCommand('C:\\asb', 'C:\\node\\node.exe'), '/f'],
    { windowsHide: true }]]);
  // A short PowerShell starts the tray with Start-Process; the tray text is the Run value without powershell.exe.
  assert.deepEqual(trayStartArguments, ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath powershell.exe -ArgumentList $env:ASB_TRAY_ARGS -WindowStyle Hidden']);
  assert.deepEqual(calls.spawn, [['powershell.exe', trayStartArguments, { windowsHide: true, stdio: 'ignore',
    env: { ...context.env, ASB_TRAY_ARGS: '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\asb\\scripts\\asb-tray.ps1" "C:\\node\\node.exe"' } }]]);
  assert.equal(`powershell.exe ${calls.spawn[0][2].env.ASB_TRAY_ARGS}`, trayCommand('C:\\asb', 'C:\\node\\node.exe'));
  assert.deepEqual(calls.logs, ['ASB starts when you sign in to Windows.', 'ASB engine: running. PID 41, port 4629.']);
  const failed = engineFakes({ trayExit: 1 });
  await assert.rejects(engineMain(['start'], failed.context), /^Error: ASB cannot start its tray\. Windows PowerShell failed\.$/);
  assert.equal(failed.calls.logs.length, 0);
});

test('the Windows engine writes its log with no console, or when the tray sets ASB_ENGINE_LOG', () => {
  assert.equal(writesEngineLog({}, false), true);
  assert.equal(writesEngineLog({}, undefined), true);
  assert.equal(writesEngineLog({}, true), false);
  assert.equal(writesEngineLog({ ASB_ENGINE_LOG: '1' }, true), true);
  assert.equal(writesEngineLog({ ASB_ENGINE_LOG: '0' }, true), false);
});

test('asb engine start on Windows starts no second tray when an engine answers, and status names the tray mode', async () => {
  const running = engineFakes({ running: [{ pid: 7, port: 4629 }] });
  assert.equal(await engineMain(['start'], running.context), 0);
  assert.deepEqual([running.calls.exec, running.calls.spawn], [[], []]);
  assert.equal(await engineMain(['status'], running.context), 0);
  assert.deepEqual(running.calls.logs, ['ASB engine: running. PID 7, port 4629.', 'ASB engine: running. PID 7, port 4629, tray.']);
  const stopped = engineFakes({ running: [null] });
  assert.equal(await engineMain(['status'], stopped.context), 1);
  assert.equal(await engineMain(['stop'], stopped.context), 0);
  assert.deepEqual(stopped.calls.logs, ['ASB engine: not running.', 'ASB engine is not running.']);
  await assert.rejects(engineMain(['start'], { ...stopped.context, timeoutMs: 300 }), /ASB cannot start its engine/);
  assert.equal(stopped.calls.spawn.length, 1);
  assert.equal(await engineMain(['enable'], stopped.context), 2);
  assert.equal(stopped.calls.logs.at(-1), 'error: Usage: asb engine run|start|stop|status|install|uninstall');
});

test('asb engine uninstall on Windows removes the Run value only when it exists, then stops the engine', async () => {
  const present = engineFakes({ running: [null] });
  assert.equal(await engineMain(['uninstall'], present.context), 0);
  assert.deepEqual(present.calls.exec.map(([command, args]) => [command, ...args]), [['reg', 'query', RUN_KEY, '/v', 'ASB'],
    ['reg', 'delete', RUN_KEY, '/v', 'ASB', '/f']]);
  assert.deepEqual(present.calls.logs, ['ASB no longer starts when you sign in to Windows.', 'ASB engine is not running.']);
  const missing = engineFakes({ running: [null], queryFails: true });
  assert.equal(await engineMain(['uninstall'], missing.context), 0);
  assert.deepEqual(missing.calls.exec.map(([, args]) => args[0]), ['query']);
});

test('the asb dispatcher reaches each command main, opens the board with no command, and shows the Windows usage and Node refusal', async () => {
  const calls = [];
  const load = async (href) => {
    const name = path.basename(fileURLToPath(href));
    return { main: async (args, options) => { calls.push([name, args, options]); return name === 'asb-engine.mjs' && args[0] === 'status' ? 1 : 0; } };
  };
  const logs = [];
  const run = (argv, platform = 'linux', version = '22.13.0') => dispatch(argv, { platform, version, load, error: (line) => logs.push(`error: ${line}`) });
  for (const [argv, name, args] of [[['engine', 'run'], 'asb-engine.mjs', ['run']], [['service', 'install'], 'asb-service.mjs', ['install']],
    [['agent', 'status', '--json'], 'asb-agent.mjs', ['status', '--json']], [['bridge', 'status'], 'asb-bridge.mjs', ['status']],
    [['group', 'status'], 'asb-group.mjs', ['group', 'status']], [['network', 'status'], 'asb-group.mjs', ['network', 'status']],
    [['phone', 'pair'], 'asb-group.mjs', ['phone', 'pair']], [['setup', '--yes'], 'asb-setup.mjs', ['--yes']],
    [['--package', 'check'], 'asb-package.mjs', ['check']], [['doctor', '--json'], 'asb-doctor.mjs', ['--json']]]) {
    calls.length = 0;
    assert.equal(await run(argv), 0, argv.join(' '));
    assert.deepEqual(calls.map(([file, values]) => [file, values]), [[name, args]]);
  }
  // No command opens the board through scripts/asb-desktop.mjs, on both systems.
  calls.length = 0;
  for (const platform of ['linux', 'win32']) assert.equal(await run([], platform, '24.0.0'), undefined);
  assert.deepEqual(calls.map(([file, values]) => [file, values]), [['asb-desktop.mjs', undefined], ['asb-desktop.mjs', undefined]]);
  assert.equal(await run(['service', 'install'], 'win32', '24.0.0'), 2);
  assert.equal(await run(['engine', 'status'], 'win32', '22.12.0'), 1);
  assert.equal(logs.at(-1), 'error: ASB needs Node.js 22.13 or later on Windows.');
  assert.equal(await run([], 'win32', '22.12.0'), 1);
  assert.equal(calls.length, 2);
  // service, doctor, and --package are Linux only: Windows keeps its usage error.
  for (const command of ['service', 'doctor', '--package']) {
    assert.equal(await run([command], 'win32', '24.0.0'), 2);
    assert.equal(logs.at(-1), `error: ${WINDOWS_USAGE}`);
  }
  // npm skips scripts/asb, so the dispatcher refuses Node.js older than 20 on Linux with the launcher message.
  assert.equal(await run(['doctor'], 'linux', '18.19.0'), 1);
  assert.equal(logs.at(-1), `error: ${NODE_HINT}`);
  assert.equal(await run(['service', 'status'], 'linux', '20.0.0'), 0);
  assert.equal(calls.length, 3);
});

test('Python candidates on Windows: an absolute ASB_PYTHON alone, else MSYS2 Python, then python on PATH, without duplicates', async (t) => {
  const directory = await folder(t, 'asb-win-python-');
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  for (const name of ['python.exe', 'python3.exe']) await writeFile(path.join(bin, name), 'synthetic');
  const msys2 = path.join(directory, 'msys2-python.exe');
  await writeFile(msys2, 'synthetic', { mode: 0o755 });
  const found = path.join(bin, 'python.exe');
  const env = { PATH: bin, PATHEXT: '.COM;.EXE' };
  const candidates = (values, system) => pythonCandidates({ ...env, ...values }, { platform: 'win32', system });
  assert.equal(MSYS2_PYTHON, 'C:\\msys64\\ucrt64\\bin\\python.exe');
  assert.deepEqual(await candidates({ ASB_PYTHON: 'D:\\Python\\python.exe' }, msys2), ['D:\\Python\\python.exe']);
  // python3.exe is not searched, and a relative ASB_PYTHON is ignored.
  assert.deepEqual(await candidates({}, msys2), [msys2, found]);
  assert.deepEqual(await candidates({ ASB_PYTHON: 'python.exe' }, msys2), [msys2, found]);
  assert.deepEqual(await candidates({}, found), [found]);
  assert.deepEqual(await candidates({}, path.join(directory, 'missing.exe')), [found]);
  assert.deepEqual(await candidates({ PATH: '' }, path.join(directory, 'missing.exe')), []);
});

test('boardCheck passes its platform to the Python search', async (t) => {
  const directory = await folder(t, 'asb-win-python-');
  await writeFile(path.join(directory, 'python.exe'), 'synthetic');
  const found = path.join(directory, 'python.exe');
  const probed = [];
  const execFile = async (file) => {
    probed.push(file);
    if (file !== found) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: JSON.stringify({ python: '3.14.8', gi: '3.58.1', gtk: [4, 24, 1], adw: [1, 10, 0] }) };
  };
  const env = { PATH: directory, PATHEXT: '.EXE' };
  const board = await boardCheck({ env, execFile, platform: 'win32' });
  assert.deepEqual([board.ok, board.python], [true, found]);
  assert.ok(probed.includes(found));
  // Linux looks for python3 only, so it never probes python.exe.
  probed.length = 0;
  await boardCheck({ env, execFile, platform: 'linux' });
  assert.ok(!probed.includes(found));
});

test('the POSIX launcher prints the same Node.js message as the dispatcher', async () => {
  const launcher = await readFile(new URL('../scripts/asb', import.meta.url), 'utf8');
  assert.ok(NODE_HINT.endsWith(' Install help: https://github.com/Jamir-boop/ASB#nodejs'));
  assert.ok(launcher.includes(`printf '%s\\n' '${NODE_HINT}' >&2`));
});

test('the asb entry hides only the SQLite ExperimentalWarning and prints other warnings', async () => {
  const file = fileURLToPath(new URL('../scripts/asb.mjs', import.meta.url));
  // The entry block runs as for `asb engine bogus` (usage, exit 2); then the child emits the warnings itself.
  const code = `process.argv = [process.argv[0], ${JSON.stringify(file)}, 'engine', 'bogus'];
await import(${JSON.stringify(new URL('../scripts/asb.mjs', import.meta.url).href)});
process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
process.emitWarning('Other thing is experimental', 'ExperimentalWarning');
process.emitWarning('A plain warning');`;
  const failed = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]).then(() => null, (error) => error);
  assert.equal(failed?.code, 2);
  assert.deepEqual(failed.stderr.trim().split(/\r?\n/).slice(1), ['ExperimentalWarning: Other thing is experimental', 'Warning: A plain warning']);
  assert.match(failed.stderr, /^Usage: asb engine run\|start\|stop\|status/);
});
