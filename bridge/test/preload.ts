import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test run gets an empty runtime folder, so the bridge finds no ASB engine unless a test writes one.
// XDG_STATE_HOME keeps the bridge out of the state fallback folder of the user's engine.
// LOCALAPPDATA is where the bridge finds the engine on Windows.
const runtime = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'asb-bridge-test-run-'));
process.env.XDG_RUNTIME_DIR = runtime;
process.env.XDG_STATE_HOME = runtime;
process.env.LOCALAPPDATA = runtime;
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
