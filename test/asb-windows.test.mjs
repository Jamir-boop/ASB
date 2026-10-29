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
import { engineFolders, main as engineMain, readerPositionsPath, RUN_KEY, START_MENU_LINK_SCRIPT, trayCommand, trayStartArguments, writesEngineLog } from '../scripts/asb-engine.mjs';
import { protectWindowsFolder } from '../scripts/asb-instance.mjs';
import { LINUX_USAGE, main as dispatch, NODE_HINT, WINDOWS_USAGE } from '../scripts/asb.mjs';
import { boardCheck, MSYS2_PYTHON, pythonCandidates } from '../src/linux-system.mjs';
import { ENGINE_NODE_FLAGS } from '../src/memory-trim.mjs';

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

function engineFakes({ running = [null, { pid: 41, port: 4629 }], queryFails = false, trayExit = 0, linkStdout = '', linkError = null } = {}) {
  const calls = { exec: [], spawn: [], logs: [] };
  const lookups = [...running];
  return {
    calls,
    context: {
      platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, root: 'C:\\asb', node: 'C:\\node\\node.exe', timeoutMs: 2000,
      execFile: async (command, args, options) => {
        calls.exec.push([command, args, options]);
        if (queryFails && args[0] === 'query') throw Object.assign(new Error('missing'), { code: 1 });
        if (command === 'powershell.exe') {
          if (linkError) throw linkError;
          return { stdout: linkStdout };
        }
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

test('asb engine install on Windows writes the Run value from Node, then the Start menu link, then starts the tray and waits for the engine', async () => {
  const { calls, context } = engineFakes();
  assert.equal(await engineMain(['install'], context), 0);
  const tray = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\asb\\scripts\\asb-tray.ps1" "C:\\node\\node.exe"';
  assert.deepEqual(calls.exec.map(([command]) => command), ['reg', 'powershell.exe']);
  assert.deepEqual(calls.exec[0], ['reg', ['add', RUN_KEY, '/v', 'ASB', '/t', 'REG_SZ', '/d', trayCommand('C:\\asb', 'C:\\node\\node.exe'), '/f'],
    { windowsHide: true }]);
  // The link script gets the arguments (the tray text and -Open), the folder, the icon, and the app ID only in the environment, never in its text.
  assert.deepEqual(calls.exec[1], ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', START_MENU_LINK_SCRIPT], { windowsHide: true, timeout: 30_000,
    env: { ...context.env, ASB_LINK_MODE: 'write', ASB_LINK_ARGS: `${tray} -Open`, ASB_LINK_ROOT: 'C:\\asb', ASB_LINK_ICON: 'C:\\asb\\assets\\icons\\asb.ico',
      ASB_LINK_APP_ID: 'local.asb.AgentSwitchBoard' } }]);
  assert.doesNotMatch(START_MENU_LINK_SCRIPT, /[A-Za-z]:\\|asb-tray|node\.exe|-Open/);
  assert.doesNotMatch(START_MENU_LINK_SCRIPT, /local\.asb\.AgentSwitchBoard/);
  for (const part of ["$mark = 'Agent Switch Board (generated by ASB)'", "[Environment]::GetFolderPath('Programs')", 'WindowStyle = 7', '$link.Description = $mark',
    '$env:ASB_LINK_ARGS', '$env:ASB_LINK_ROOT', '$env:ASB_LINK_ICON', '[AsbLinkId]::Set($file, $env:ASB_LINK_APP_ID)',
    'SHGetPropertyStoreFromParsingName', '9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3', 'pid = 5', 'vt = 31', 'store.Commit()']) assert.ok(START_MENU_LINK_SCRIPT.includes(part), part);
  assert.ok(START_MENU_LINK_SCRIPT.indexOf('Add-Type') > START_MENU_LINK_SCRIPT.indexOf('$link.Save()'));
  assert.ok(START_MENU_LINK_SCRIPT.indexOf("if ($env:ASB_LINK_MODE -eq 'remove')") < START_MENU_LINK_SCRIPT.indexOf('Add-Type'));
  // A short PowerShell starts the tray with Start-Process; the tray text is the Run value without powershell.exe.
  assert.deepEqual(trayStartArguments, ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath powershell.exe -ArgumentList $env:ASB_TRAY_ARGS -WindowStyle Hidden']);
  assert.deepEqual(calls.spawn, [['powershell.exe', trayStartArguments, { windowsHide: true, stdio: 'ignore',
    env: { ...context.env, ASB_TRAY_ARGS: '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\asb\\scripts\\asb-tray.ps1" "C:\\node\\node.exe"' } }]]);
  assert.equal(`powershell.exe ${calls.spawn[0][2].env.ASB_TRAY_ARGS}`, trayCommand('C:\\asb', 'C:\\node\\node.exe'));
  assert.deepEqual(calls.logs, ['ASB starts when you sign in to Windows.', 'ASB is in the Start menu.', 'ASB engine: running. PID 41, port 4629.']);
  const failed = engineFakes({ trayExit: 1 });
  await assert.rejects(engineMain(['start'], failed.context), /^Error: ASB cannot start its tray\. Windows PowerShell failed\.$/);
  assert.equal(failed.calls.logs.length, 0);
});

test('a failed Start menu link script logs its reason, and install still returns 0 and starts the engine', async () => {
  const failed = engineFakes({ linkError: Object.assign(new Error('Command failed: powershell.exe -NoProfile ...'), { stderr: 'Access is denied.\r\nAt line:9 char:1\r\n' }) });
  assert.equal(await engineMain(['install'], failed.context), 0);
  assert.deepEqual(failed.calls.logs, ['ASB starts when you sign in to Windows.', 'ASB cannot write its Start menu link: Access is denied.',
    'ASB engine: running. PID 41, port 4629.']);
  assert.equal(failed.calls.spawn.length, 1);
  // Without a PowerShell message (for example, no powershell.exe), the error message is the reason.
  const missing = engineFakes({ linkError: new Error('spawn powershell.exe ENOENT') });
  assert.equal(await engineMain(['install'], missing.context), 0);
  assert.equal(missing.calls.logs[1], 'ASB cannot write its Start menu link: spawn powershell.exe ENOENT');
});

test('an ASB.lnk that ASB did not make stays, and the script prints its path for the message', async () => {
  const lnk = 'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\ASB.lnk';
  const kept = engineFakes({ linkStdout: `${lnk}\r\n` });
  assert.equal(await engineMain(['install'], kept.context), 0);
  assert.deepEqual(kept.calls.logs, ['ASB starts when you sign in to Windows.', `ASB kept ${lnk}: it was not made by ASB.`, 'ASB engine: running. PID 41, port 4629.']);
  const uninstall = engineFakes({ running: [null], linkStdout: `${lnk}\r\n` });
  assert.equal(await engineMain(['uninstall'], uninstall.context), 0);
  assert.deepEqual(uninstall.calls.logs, [`ASB kept ${lnk}: it was not made by ASB.`, 'ASB no longer starts when you sign in to Windows.', 'ASB engine is not running.']);
});

test('the Windows engine writes its log with no console, or when the tray sets ASB_ENGINE_LOG', () => {
  assert.equal(writesEngineLog({}, false), true);
  assert.equal(writesEngineLog({}, undefined), true);
  assert.equal(writesEngineLog({}, true), false);
  assert.equal(writesEngineLog({ ASB_ENGINE_LOG: '1' }, true), true);
  assert.equal(writesEngineLog({ ASB_ENGINE_LOG: '0' }, true), false);
});

// PowerShell names ignore case, and a parameter keeps its type: `$open = <menu item>` wrote to [switch]$Open, so the tray stopped before it started the engine.
test('the tray script assigns no value to its switch parameter', async () => {
  const script = await readFile(new URL('../scripts/asb-tray.ps1', import.meta.url), 'utf8');
  const switches = [...script.match(/^param\((.*)\)$/m)[1].matchAll(/\[switch\]\$(\w+)/gi)].map(([, name]) => name);
  assert.deepEqual(switches, ['Open']);
  for (const name of switches) assert.doesNotMatch(script, new RegExp(`\\$${name}\\s*=`, 'i'), name);
});

// The tray loads Windows Forms and Drawing slowly, and Start-Engine needs only System.Diagnostics, so the engine starts first.
test('the tray script starts the engine once after the mutex and before Windows Forms, and the timer starts it again after a crash', async () => {
  const script = await readFile(new URL('../scripts/asb-tray.ps1', import.meta.url), 'utf8');
  const calls = [...script.matchAll(/^( *)Start-Engine *$/gm)];
  assert.deepEqual(calls.map(([, indent]) => indent), ['', '  ']);
  const [first, restart] = calls.map((call) => call.index);
  const definition = script.indexOf('function Start-Engine');
  assert.doesNotMatch(script.slice(definition, script.indexOf('\n}', definition)), /Forms|Drawing/);
  // The -Open branch exits before the tray starts, so its message box is the only other Add-Type.
  const open = script.indexOf('if ($Open) {');
  const addTypes = [...script.matchAll(/Add-Type/g)].map((match) => match.index);
  assert.deepEqual(addTypes.map((index) => open < index && index < script.indexOf('\n}', open)), [true, false]);
  assert.ok(script.indexOf('.WaitOne(0)') < definition && definition < first && first < addTypes[1]);
  assert.ok(restart > script.indexOf('.add_Tick('));
});

// With no board packages the launcher exits with code 3, and a Start menu open without the tray showed nothing.
test('the -Open branch waits 30 s for the launcher and shows the text of the tray balloon in a message box on exit code 3', async () => {
  const script = await readFile(new URL('../scripts/asb-tray.ps1', import.meta.url), 'utf8');
  const start = script.indexOf('if ($Open) {');
  const branch = script.slice(start, script.indexOf('\n}', start));
  assert.match(branch, /^  if \(\$launcher\.WaitForExit\(30000\) -and \$launcher\.ExitCode -eq 3\) \{$/m);
  const shown = branch.match(/\[System\.Windows\.Forms\.MessageBox\]::Show\('([^']*)', 'ASB', 'OK', 'Warning'\)/)?.[1];
  const balloon = script.match(/if \(\$code -eq 3\) \{ \$icon\.ShowBalloonTip\(10000, 'ASB', '([^']*)'/)?.[1];
  assert.deepEqual([shown, balloon], ['ASB has no window on this PC. Run asb doctor.', 'ASB has no window on this PC. Run asb doctor.']);
  assert.ok(branch.trimEnd().endsWith('exit 0'));
});

// Messages and Usage ask an open board to show the window; without one, a new board opens it from ASB_OPEN_WINDOW.
test('the tray menu has Messages and Usage, and Show-Window asks the engine before it starts a launcher with the window', async () => {
  // A Windows checkout has CRLF line ends; the launcher pattern below matches whole lines.
  const script = (await readFile(new URL('../scripts/asb-tray.ps1', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const added = [...script.matchAll(/^\$\w+ = \$menu\.Items\.Add\('([^']*)'\)$|^\[void\]\$menu\.Items\.Add\(\(New-Object System\.Windows\.Forms\.(ToolStripSeparator)\)\)$/gm)]
    .map(([, label, separator]) => label ?? separator);
  assert.deepEqual(added, ['Open ASB', 'Messages', 'Usage', 'ToolStripSeparator', 'Copy phone pairing link', 'Quit ASB']);
  assert.match(script, /^\$messagesItem\.add_Click\(\{ Show-Window 'messages' \}\)$/m);
  assert.match(script, /^\$usageItem\.add_Click\(\{ Show-Window 'usage' \}\)$/m);
  const body = (name) => {
    const start = script.indexOf(`function ${name}`);
    return script.slice(start, script.indexOf('\n}', start));
  };
  const show = body('Show-Window([string]$kind)');
  assert.match(show, /Invoke-Engine '\/api\/engine\/show-window' \(@\{ window = \$kind \} \| ConvertTo-Json -Compress\)/);
  assert.match(show, /if \(\$reply -and \$reply\.shown -eq \$true\) \{ return \}/);
  assert.ok(show.indexOf('.shown') < show.indexOf('$script:board.HasExited') && show.indexOf('.HasExited') < show.indexOf('Start-Launcher $window'));
  assert.match(show, /^  \$window = if \(\$kind -eq 'board'\) \{ '' \} else \{ \$kind \}$/m);
  // Open ASB and a left click ask the engine for the board first, so an open board comes to the front instead of a second one.
  assert.match(script, /^function Open-Board \{ Show-Window 'board' \}$/m);
  assert.match(script, /^\$openItem\.add_Click\(\{ Open-Board \}\)$/m);
  assert.match(script, /\[System\.Windows\.Forms\.MouseButtons\]::Left\) \{ Open-Board \}/);
  const invoke = body('Invoke-Engine([string]$route, [string]$body = \'{}\')');
  assert.match(invoke, /-Body \$body /);
  const launcher = body("Start-Launcher([string]$Window = '')");
  assert.match(launcher, /\n  if \(\$Window\) \{\n    \$info\.EnvironmentVariables\['ASB_OPEN_WINDOW'\] = \$Window\n  \}\n/);
  assert.equal(script.split('ASB_OPEN_WINDOW').length, 2);
  const start = script.indexOf('if ($Open) {');
  assert.match(script.slice(start, script.indexOf('\n}', start)), /^  \$launcher = Start-Launcher$/m);
});

// The V8 flag makes the young generation of the engine smaller (src/memory-trim.mjs). Windows has no glibc, so it gets no MALLOC setting.
// The launcher start is short, so it gets no flag. This test reads the script text: the real tray runs only on Windows.
test('the tray script starts the engine with the V8 flag, keeps its other arguments, and gives the launcher no flag', async () => {
  const script = await readFile(new URL('../scripts/asb-tray.ps1', import.meta.url), 'utf8');
  const argumentsOf = (name) => {
    const start = script.indexOf(`function ${name}`);
    return script.slice(start, script.indexOf('\n}', start)).match(/^ *\$info\.Arguments = (.*)$/m)[1];
  };
  assert.equal(argumentsOf('Start-Engine'),
    `'${ENGINE_NODE_FLAGS.join(' ')} --disable-warning=ExperimentalWarning "' + (Join-Path $root 'scripts\\asb.mjs') + '" engine run'`);
  assert.equal(argumentsOf('Start-Launcher'), `'--disable-warning=ExperimentalWarning "' + (Join-Path $root 'scripts\\asb.mjs') + '"'`);
  assert.doesNotMatch(script, /MALLOC_/);
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

test('asb engine uninstall on Windows removes the Start menu link and the Run value only when they exist, then stops the engine', async () => {
  const present = engineFakes({ running: [null] });
  assert.equal(await engineMain(['uninstall'], present.context), 0);
  // The link script decides by the marker; it runs first, in remove mode, with the same script text.
  const [link, ...reg] = present.calls.exec;
  assert.deepEqual([link[0], link[1], link[2].windowsHide, link[2].env.ASB_LINK_MODE], ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', START_MENU_LINK_SCRIPT],
    true, 'remove']);
  assert.deepEqual(reg.map(([command, args]) => [command, ...args]), [['reg', 'query', RUN_KEY, '/v', 'ASB'], ['reg', 'delete', RUN_KEY, '/v', 'ASB', '/f']]);
  assert.deepEqual(present.calls.logs, ['ASB no longer starts when you sign in to Windows.', 'ASB engine is not running.']);
  const missing = engineFakes({ running: [null], queryFails: true });
  assert.equal(await engineMain(['uninstall'], missing.context), 0);
  assert.deepEqual(missing.calls.exec.slice(1).map(([, args]) => args[0]), ['query']);
  // A failed link removal logs its reason and does not stop the rest of the uninstall.
  const failed = engineFakes({ running: [null], linkError: Object.assign(new Error('Command failed'), { stderr: 'Access is denied.\r\n' }) });
  assert.equal(await engineMain(['uninstall'], failed.context), 0);
  assert.deepEqual(failed.calls.exec.slice(1).map(([, args]) => args[0]), ['query', 'delete']);
  assert.deepEqual(failed.calls.logs, ['ASB cannot remove its Start menu link: Access is denied.', 'ASB no longer starts when you sign in to Windows.',
    'ASB engine is not running.']);
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
    [['--package', 'check'], 'asb-package.mjs', ['check']], [['doctor', '--json'], 'asb-doctor.mjs', ['--json']],
    [['usage', 'export', 'usage.json'], 'asb-usage.mjs', ['export', 'usage.json']]]) {
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
  // service and --package are Linux only: Windows keeps its usage error, which names doctor because doctor runs on both systems.
  for (const command of ['service', '--package']) {
    assert.equal(await run([command], 'win32', '24.0.0'), 2);
    assert.equal(logs.at(-1), `error: ${WINDOWS_USAGE}`);
  }
  // npm skips scripts/asb, so the dispatcher refuses Node.js older than 20 on Linux with the launcher message.
  assert.equal(await run(['doctor'], 'linux', '18.19.0'), 1);
  assert.equal(logs.at(-1), `error: ${NODE_HINT}`);
  assert.equal(await run(['service', 'status'], 'linux', '20.0.0'), 0);
  assert.equal(calls.length, 3);
  // doctor reaches the same script on Windows, after the Node.js check.
  calls.length = 0;
  assert.equal(await run(['doctor', '--json'], 'win32', '22.13.0'), 0);
  assert.deepEqual(calls.map(([file, values]) => [file, values]), [['asb-doctor.mjs', ['--json']]]);
  assert.equal(await run(['doctor'], 'win32', '22.12.0'), 1);
  assert.equal(calls.length, 1);
  assert.match(WINDOWS_USAGE, /\|setup\|doctor\]/);
  // usage runs on both systems too, and both usage lines name it after phone.
  calls.length = 0;
  assert.equal(await run(['usage', 'import', 'usage.json'], 'win32', '22.13.0'), 0);
  assert.deepEqual(calls.map(([file, values]) => [file, values]), [['asb-usage.mjs', ['import', 'usage.json']]]);
  for (const text of [WINDOWS_USAGE, LINUX_USAGE]) assert.match(text, /\|phone\|usage\|/);
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

test('on Linux only no command opens the board; an unknown command prints the usage and starts nothing', async () => {
  const loaded = [];
  const load = async (href) => {
    loaded.push(path.basename(fileURLToPath(href)));
    return { main: async () => 0 };
  };
  const logs = [];
  const run = (argv) => dispatch(argv, { platform: 'linux', version: '22.13.0', load, log: (line) => logs.push(`log: ${line}`),
    error: (line) => logs.push(`error: ${line}`) });
  assert.equal(await run([]), undefined);
  assert.deepEqual(loaded, ['asb-desktop.mjs']);
  // The usage names only commands that the dispatcher handles.
  for (const command of LINUX_USAGE.match(/\[([^\]]+)\]/)[1].split('|')) {
    loaded.length = 0;
    assert.equal(await run([command]), 0, command);
    assert.equal(loaded.length, 1, command);
    assert.notEqual(loaded[0], 'asb-desktop.mjs', command);
  }
  for (const argv of [['--help'], ['-h'], ['help'], ['servce', 'install']]) {
    loaded.length = 0;
    logs.length = 0;
    assert.equal(await run(argv), 2, argv.join(' '));
    assert.deepEqual(loaded, [], argv.join(' '));
    assert.deepEqual(logs, [`error: ${LINUX_USAGE}`], argv.join(' '));
  }
});

test('the POSIX launcher prints the same Node.js message as the dispatcher', async () => {
  const launcher = await readFile(new URL('../scripts/asb', import.meta.url), 'utf8');
  assert.ok(NODE_HINT.endsWith(' Install help: https://github.com/Jamir-boop/ASB/blob/main/docs/INSTALL.md#nodejs'));
  assert.ok(launcher.includes(`printf '%s\\n' '${NODE_HINT}' >&2`));
  // The link target: the anchor #nodejs comes from this heading.
  assert.match(await readFile(new URL('../docs/INSTALL.md', import.meta.url), 'utf8'), /^## Node\.js$/m);
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
