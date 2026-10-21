import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// POSIX only on Windows CI, like the other tests that start the MCP server.
const posix = test.skipIf(process.platform === 'win32');

type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

// What Codex reads: the real tools/list and the server instructions, over stdio.
async function advertised() {
  const root = mkdtempSync(join(tmpdir(), 'asb-tools-'));
  const client = new Client({ name: 'tools-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { CODEX_HOME: root, CLAUDE_CONFIG_DIR: root } }));
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? '' };
  } finally { await client.close(); rmSync(root, { recursive: true }); }
}
// A tool with an empty UI visibility list is not shown to the model.
const hidden = (tool: Tool) => (tool._meta?.ui as { visibility?: unknown[] } | undefined)?.visibility?.length === 0;
const visible = (tools: Tool[]) => tools.filter(tool => !hidden(tool));
const size = (tool: Tool) => Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

// The budgets below count only these four. The hidden session_start tool is not shown to the model, so it is not counted.
posix('the model sees the four bridge tools, and session_start is hidden', async () => {
  const { tools } = await advertised();
  expect(visible(tools).map(tool => tool.name)).toEqual(['list_sessions', 'send_message', 'status', 'inbox']);
  expect(tools.filter(hidden).map(tool => tool.name)).toEqual(['session_start']);
});

posix('the advertised schemas have no pattern for sessionId and reference, and nameContains has its length limits', async () => {
  const { tools } = await advertised();
  const properties = (name: string) => (tools.find(tool => tool.name === name)?.inputSchema.properties ?? {}) as Record<string, unknown>;
  expect(properties('send_message').sessionId).toEqual({ type: 'string' });
  expect(properties('send_message').reference).toEqual({ type: 'string' });
  expect(properties('send_message').text).toEqual({ type: 'string', minLength: 1, maxLength: 1048576 });
  expect(properties('send_message').notify_when_idle).toEqual({ type: 'boolean', default: false });
  expect(properties('list_sessions').nameContains).toEqual({ type: 'string', minLength: 1, maxLength: 128 });
  expect(JSON.stringify(visible(tools).map(tool => tool.inputSchema))).not.toMatch(/pattern|format/);
});

// No tokenizer package is a dependency, so a byte budget (the size on 2026-10-20 plus 10%) stands in for the token budget (o200k_base): 480 tokens for the four tools.
posix('each visible tool, the four together, and the server instructions stay under their byte budgets', async () => {
  const { tools, instructions } = await advertised();
  const shown = visible(tools);
  const limits: Record<string, number> = { list_sessions: 544, send_message: 791, status: 409, inbox: 462 };
  for (const tool of shown) expect(size(tool)).toBeLessThanOrEqual(limits[tool.name]!);
  expect(shown.reduce((sum, tool) => sum + size(tool), 0)).toBeLessThanOrEqual(2205);
  expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(24);
});
