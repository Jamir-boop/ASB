// The chat view of one Claude transcript (contract P1), read-only: the newest typed prompts, assistant text, and peer messages.
// Nothing is cached: the text exists only during the call.
import { promises as fs } from 'node:fs';
import { cutText } from './activity-messages.mjs';
import { currentClaudeRoot, DEFAULT_CLAUDE_PROJECTS_DIR, DEFAULT_MAX_JSONL_BYTES, indexClaudeProjectFiles, readTailText } from './claude-data.mjs';

const MAX_TURNS = 30;
const MAX_TEXT = 2_000;
const MAX_NAME = 128;
const MAX_REPLY_BYTES = 256 * 1024;
const PHONE_TARGET = /^Phone(-[0-9a-z]+)?( \[[0-9a-f]+\])?$/;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const LOCAL_COMMAND = /^\s*<(?:local-command-caveat|command-name|local-command-stdout)>/;

const recordAtMs = (record) => {
  const atMs = Date.parse(record?.timestamp);
  return Number.isFinite(atMs) ? atMs : 0;
};
const partsOf = (content) => typeof content === 'string' ? [content] : Array.isArray(content)
  ? content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text) : [];
const peerTurn = (origin, record) => {
  const name = [...String(origin?.name ?? '').trim()].slice(0, MAX_NAME).join('');
  return name ? { role: 'peer', name, text: String(origin?.body ?? ''), atMs: recordAtMs(record) } : null;
};

// The turns of one transcript text, oldest first, before the limit and the size cut. Pure: no I/O.
export function parseClaudeChat(text = '') {
  const turns = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    if (group.texts.length) turns.push({ role: 'assistant', text: group.texts.join('\n\n'), atMs: group.atMs });
    for (const message of group.sends) turns.push({ role: 'assistant', text: message, atMs: group.atMs });
    group = null;
  };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'assistant' && record.isSidechain !== true) {
      const content = record.message?.content;
      const sends = Array.isArray(content) ? content.filter((item) => item?.type === 'tool_use' && item.name === 'SendMessage'
        && typeof item.input?.to === 'string' && PHONE_TARGET.test(item.input.to) && typeof item.input.message === 'string')
        .map((item) => item.input.message) : [];
      const texts = partsOf(content);
      const id = typeof record.message?.id === 'string' ? record.message.id : '';
      // Consecutive assistant records of one reply (same message.id) are one turn.
      if (group && id && id === group.id) { group.texts.push(...texts); group.sends.push(...sends); }
      else { flush(); group = { id, texts, sends, atMs: recordAtMs(record) }; }
      continue;
    }
    flush();
    if (record.type === 'attachment' && record.attachment?.type === 'queued_command' && record.attachment.origin?.kind === 'peer') {
      const turn = peerTurn(record.attachment.origin, record);
      if (turn) turns.push(turn);
      continue;
    }
    if (record.type !== 'user') continue;
    if (record.origin?.kind === 'peer') {
      const turn = peerTurn(record.origin, record);
      if (turn) turns.push(turn);
      continue;
    }
    if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) continue;
    const content = record.message?.content;
    if (Array.isArray(content) && content.some((item) => item?.type === 'tool_result')) continue;
    const prompt = partsOf(content).join('\n').replace(SYSTEM_REMINDER, '').trim();
    if (!prompt || LOCAL_COMMAND.test(prompt)) continue;
    turns.push({ role: 'user', text: prompt, atMs: recordAtMs(record) });
  }
  flush();
  return turns.map((turn) => {
    const points = [...turn.text];
    return { ...turn, text: cutText(turn.text), cut: points.length > MAX_TEXT };
  });
}

// The reply turns that fit 256 KiB of JSON: the oldest turns go first and `more` stays true.
export function fitChatTurns(turns, more, measure) {
  let kept = turns, flag = more === true;
  while (kept.length && measure(kept, flag) > MAX_REPLY_BYTES) { kept = kept.slice(1); flag = true; }
  return { turns: kept, more: flag };
}
// The bytes of the route reply, `api` and a worst-case threadId included, so the whole reply stays under the cap.
const replyBytes = (turns, more) => Buffer.byteLength(JSON.stringify({ api: 1, threadId: 'x'.repeat(512), turns, more }));

// The reply body of the chat route: the newest `limit` turns of the transcript tail, and `more` when older turns exist in the read part.
export async function readClaudeChat(filePath, { limit = MAX_TURNS } = {}) {
  const count = Number.isInteger(limit) && limit >= 1 && limit <= MAX_TURNS ? limit : MAX_TURNS;
  const stat = await fs.stat(filePath);
  const { text } = await readTailText(filePath, DEFAULT_MAX_JSONL_BYTES, stat);
  const turns = parseClaudeChat(text);
  return fitChatTurns(turns.slice(-count), turns.length > count || stat.size > DEFAULT_MAX_JSONL_BYTES, replyBytes);
}

// The current transcript of the first session ID that has one, or ''.
export async function claudeChatFile(projectsDir = DEFAULT_CLAUDE_PROJECTS_DIR, sessionIds = []) {
  const index = await indexClaudeProjectFiles(projectsDir);
  for (const id of sessionIds) {
    const filePath = (await currentClaudeRoot(index, id))?.filePath;
    if (filePath) return filePath;
  }
  return '';
}
