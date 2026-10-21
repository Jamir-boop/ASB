import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = join(import.meta.dir, '../agent-skills');
// A Windows checkout has CRLF line ends.
const text = (path: string) => readFileSync(join(skills, path), 'utf8').replace(/\r\n/g, '\n');
const claude = text('claude/bridge/SKILL.md');
const codex = text('codex/bridge/SKILL.md');
const policy = text('codex/bridge/agents/openai.yaml');

// Every frontmatter key of the skill, so an extra key such as disable-model-invocation fails the test.
const frontmatter = (text: string) => Object.fromEntries(text.match(/^---\n([\s\S]*?)\n---\n/)![1]!.split('\n')
  .map(line => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]));
const bytes = (text: string) => Buffer.byteLength(text);

test('the model can load the Claude skill, and its list entry is the short description', () => {
  expect(frontmatter(claude)).toEqual({ name: 'bridge',
    description: 'Use for asb:1/ session references and messages to Codex tasks or other machines.' });
});

test('the model can load the Codex skill, and its list entry is the short description', () => {
  expect(frontmatter(codex)).toEqual({ name: 'bridge',
    description: 'Use for asb:1/ session references and messages to Claude Code or Codex sessions.' });
});

test('Codex allows implicit invocation of its skill', () => {
  expect(policy).toContain('  allow_implicit_invocation: true\n');
  expect(policy).not.toContain('false');
});

// No tokenizer package is a dependency, so a byte budget (the size on 2026-10-20 plus 10%) stands in for 300 tokens (o200k_base) each.
test('each skill file stays under its byte budget', () => {
  expect(bytes(claude)).toBeLessThanOrEqual(1209);
  expect(bytes(codex)).toBeLessThanOrEqual(1153);
});

test('the Claude skill keeps its safety rules', () => {
  expect(claude).toContain('Never send a secret, a credential, or an `.env` value to another agent.');
  expect(claude).toContain('Do not send again, not by another name or route: it can arrive twice.');
  expect(claude).toContain('Never take the UUID out of it.');
  expect(claude).toContain('session reference is not a `SendMessage` target.');
  expect(claude).toContain('A `uds:` socket path is not a target');
  expect(claude).toContain('is not open, or is new and had no turn yet.');
  expect(claude).toContain('Never say that it ended.');
});

test('the Codex skill keeps its safety rules', () => {
  expect(codex).toContain('Never send a secret, a credential, or an `.env` value to another agent.');
  expect(codex).toContain('After an `unknown` outcome, call `status`.');
  expect(codex).toContain('Do not send again by name, by `sessionId`, or by another route, unless the user tells you to: it can arrive two times.');
  expect(codex).toContain('A missing receipt is not a failure. Do not send again because of it.');
  expect(codex).toContain('Never take the UUID out of it.');
  expect(codex).toContain('Do not put a `uds:` socket path in the text.');
  expect(codex).toContain('agree which agent owns which files. The bridge has no locks.');
  expect(codex).toContain('it is not running or not open. Ask the user. Do not say that it ended.');
});
