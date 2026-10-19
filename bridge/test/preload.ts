import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';

// Each test run gets an empty runtime folder, so the bridge finds no ASB engine unless a test writes one.
const runtime = mkdtempSync('/tmp/asb-bridge-test-run-');
process.env.XDG_RUNTIME_DIR = runtime;
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
