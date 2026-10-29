import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timeline, css, EASE, escape, number, checkSvg } from './hero-smil.mjs';
import { renderBoard, boardDefs, boardStill, scene } from './hero-board.mjs';
import { appWindow, appDefs, cursor } from './hero-apps.mjs';

const tl = timeline(30000);
const origin = [150, 60];
const events = [
  { t: 900, active: false }, { t: 2600, active: true }, { t: 2600, state: 'S1' },
  { t: 3100, active: false }, { t: 4800, active: true }, { t: 4800, state: 'S2' },
  { t: 5300, active: false }, { t: 7000, active: true }, { t: 7000, state: 'S3' },
  { t: 8600, state: 'S4a' }, { t: 9400, state: 'S4' },
  { t: 11400, hover: 'opencode-parsers' }, { t: 12050, copyTag: 'relative' },
  { t: 12300, copied: true }, { t: 14000, copyTag: 'absolute' }, { t: 14500, copied: true },
  { t: 16000, copyTag: null }, { t: 16100, hover: null },
  { t: 16300, active: false }, { t: 17950, active: true },
  { t: 18400, light: ['claude-plan', 'opencode-parsers'] },
  { t: 19600, light: ['laptop-flaky', 'codex-retry'] },
  { t: 20800, light: ['opencode-parsers', 'claude-plan'] },
  { t: 21800, state: 'S5' }, { t: 23200, hover: 'chatgpt-release' },
  { t: 23800, opening: 'chatgpt-release' }, { t: 24400, opening: null, active: false },
  { t: 24500, hover: null }, { t: 28400, active: true }, { t: 28600, reset: 'S0', ms: 400 },
];
const board = renderBoard({ tl, events });
const box = (id, t) => { const b = board.boxAt(id, t); assert.ok(b); return { ...b, x: b.x + origin[0], y: b.y + origin[1] }; };
const copyBox = box('opencode-parsers', 11000);
const close = [copyBox.x + copyBox.w / 2, copyBox.y + copyBox.h / 2];
const view = tl.camera(960, 540, [
  [0, 480, 270, 1], [800, 480, 270, 1], [7600, 480, 270, 1.06, 'linear'],
  [8000, 480, 270, 1, 'inOut'], [10300, 480, 270, 1],
  [11000, ...close, 1.6, EASE.inOut], [16100, ...close, 1.6],
  [16700, 480, 270, 1, 'inOut'], [30000, 480, 270, 1],
]);
const text = (x, y, value, size = 11, fill = '#f6f3ed', extra = '') =>
  `<text class="mono" x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape(value)}</text>`;
const visible = (start, end, svg) => `<g visibility="hidden">${tl.visibility([[start, end]])}${svg}</g>`;
const title = {
  claude: 'Draft the migration plan for the queue',
  chatgpt: 'Write the release notes for 2.4', opencode: 'Compare two parsers',
};
const prompt = {
  claude: 'Add a rollback step to each stage.',
  chatgpt: 'Write the release notes for 2.4.', opencode: 'Time both parsers on the large file.',
};
const reference = 'asb:1/3c9e0f5a7b21d846/opencode/5d0a9e7c3b18f4a62e9c0d7b1f3a8e46/opencode:ses_4c8e1a07d3f2b6k9m5p0r2t7';
const paste = `Ask ${reference} which parser keeps the line numbers.`;
const question = 'Do the notes need the API changes too, or only the user changes?';
const appY = 90;
const apps = [
  ['claude', 900, 1300, 2100, 2200, 2600, 'infra'],
  ['chatgpt', 3100, 3500, 4300, 4400, 4800, 'docs-site'],
  ['opencode', 5300, 5700, 6500, 6600, 7000, 'importer'],
].map(([kind, start, t0, t1, send, end, folder]) => ({
  kind, start, t0, send, end,
  window: appWindow(tl, kind, {
    w: 560, h: 360, title: title[kind], folder,
    sidebar: kind === 'opencode' ? [] : [title[kind]],
    focus: [[start, end]], caret: [[start + 350, send]],
    typing: [{ t0, t1, text: prompt[kind] }], send: [send], working: [[send + 100, end]],
  }),
}));
function slide(window, start, end) {
  return visible(start, end, `<g>${tl.transform('translate', [
    [0, `-580 ${appY}`], [start, `-580 ${appY}`], [start + 450, `30 ${appY}`, 'out'],
    [end - 350, `30 ${appY}`], [end, `-580 ${appY}`, 'in'],
  ])}${window.svg}</g>`);
}
const pasteApp = appWindow(tl, 'claude', {
  w: 560, h: 360, title: title.claude, folder: 'infra', sidebar: [title.claude],
  history: [{ role: 'user', text: prompt.claude }],
  focus: [[16300, 17950]], caret: [[16750, 16900]], paste: [{ t: 16900, text: paste }],
  send: [17400], working: [[17500, 17950]],
});
const opened = appWindow(tl, 'chatgpt', {
  w: 760, h: 480, title: title.chatgpt, folder: 'docs-site', sidebar: [title.chatgpt],
  history: [{ role: 'user', text: prompt.chatgpt }, { role: 'agent', text: question }],
  focus: [[24400, 28400]], caret: [[24800, 28000]],
});
const openBox = box('chatgpt-release', 24400);
const opening = visible(24400, 28400, `<g>${tl.transform('translate', [
  [0, `${openBox.x} ${openBox.y}`], [24400, `${openBox.x} ${openBox.y}`],
  [24800, '100 30', 'out'], [28000, '100 30'], [28400, `${openBox.x} ${openBox.y}`, 'in'],
])}<g>${tl.transform('scale', [
  [0, `${number(openBox.w / 760)} ${number(openBox.h / 480)}`],
  [24400, `${number(openBox.w / 760)} ${number(openBox.h / 480)}`],
  [24800, '1 1', 'out'], [28000, '1 1'],
  [28400, `${number(openBox.w / 760)} ${number(openBox.h / 480)}`, 'in'],
])}${opened.svg}</g></g>`);

function machine(name, start, y) {
  return visible(start, 11000, `<g>${tl.transform('translate', [
    [0, `980 ${y}`], [start, `980 ${y}`], [start + 400, `825 ${y}`, 'out'],
  ])}${tl.animate('opacity', [[0, 1], [10800, 1], [11000, 0, 'in']])}
    <rect width="111" height="36" rx="18" fill="#242424"/>
    <use href="#board-asb-machine-symbolic" x="12" y="10" width="16" height="16" fill="#b3b0aa"/>
    ${text(37, 22, name, 12)}</g>`);
}
const chipText = 'asb:1/3c9e…/opencode/…/opencode:ses_4c8e…';
const chipX = 480 - 326 / 2, chipY = 344;
const landing = [30 + pasteApp.composer.x + 14, appY + pasteApp.composer.y + 12];
const chip = visible(14600, 16900, `<g>${tl.transform('translate', [
  [0, `${chipX} ${chipY + 12}`], [14600, `${chipX} ${chipY + 12}`],
  [15000, `${chipX} ${chipY}`, 'out'], [16000, `${chipX} ${chipY}`], [16900, `${landing[0]} ${landing[1]}`, 'inOut'],
])}${tl.animate('opacity', [[0, 0], [14600, 0], [15000, 1, 'out'], [16800, 1], [16900, 0, 'in']])}
  <rect width="326" height="34" rx="8" fill="#242424" stroke="#55534d"/>
  <path d="M12 12h10v13H12ZM16 12V9h10v12" fill="none" stroke="#ffb900" stroke-width="1.3"/>
  ${text(34, 22, chipText, 11, '#f6f3ed', 'textLength="280" lengthAdjust="spacingAndGlyphs"')}</g>`);

// App overlays stay in canvas space; the pointer uses the same camera as the board.
const worldPoint = (x, y, t) => {
  const scale = t >= 800 && t <= 7600 ? 1 + .06 * (t - 800) / 6800 : 1;
  return [number(480 + (x - 480) / scale), number(270 + (y - 270) / scale)].map(Number);
};
const keys = [[0, 730, 77], [900, 730, 77]];
for (const app of apps) {
  const { composer, send } = app.window;
  keys.push([app.start + 350, ...worldPoint(30 + composer.x + 34, appY + composer.y + 24, app.start + 350), 'inOut'],
    [app.t0 + 150, ...worldPoint(30 + composer.x + 34, appY + composer.y + 24, app.t0 + 150)],
    [app.send - 100, ...worldPoint(30 + send.x, appY + send.y, app.send - 100), 'inOut'],
    [app.send, ...worldPoint(30 + send.x, appY + send.y, app.send)],
    [app.end, 730, 77, 'inOut']);
}
const copyControl = board.controlAt('opencode-parsers', 'copy', 11800).map((v, i) => v + origin[i]);
keys.push([10300, 730, 77], [11150, copyBox.x + copyBox.w + 6, 80],
  [11300, copyBox.x + copyBox.w + 6, copyBox.y + 7], [11400, copyBox.x + copyBox.w - 5, copyBox.y + 7],
  [11800, ...copyControl], [16000, ...copyControl],
  [16100, copyBox.x + copyBox.w + 6, copyBox.y + 7], [16300, copyBox.x + copyBox.w + 6, copyBox.y + 7],
  [16750, 30 + pasteApp.composer.x + 40, appY + pasteApp.composer.y + 25],
  [17300, 30 + pasteApp.send.x, appY + pasteApp.send.y], [17400, 30 + pasteApp.send.x, appY + pasteApp.send.y],
  [17950, 730, 77], [22800, 730, 77], [23000, 480, 80],
  [23200, openBox.x + openBox.w - 10, openBox.y + 25], [23800, openBox.x + openBox.w - 10, openBox.y + 25],
  [24800, 100 + opened.composer.x + 35, 30 + opened.composer.y + 24],
  [28000, 100 + opened.composer.x + 35, 30 + opened.composer.y + 24], [28400, 730, 77], [30000, 730, 77]);
const pointer = cursor(tl, { keys, presses: [1250, 2200, 3450, 4400, 5650, 6600, 12300, 14500, 16750, 17400, 23800], wheels: [[14000, 'down']] });

const captions = [
  [900, 8000, 'Sessions from Claude Code, Codex, ChatGPT, and OpenCode'],
  [8300, 11000, 'Sessions from your other machines'],
  [11300, 16000, 'Copy a session reference: relative or absolute'],
  [16300, 21500, 'Sessions send messages to each other'],
  [21800, 28300, 'Click a card to open its chat in its app'],
].map(([start, end, value]) => {
  const width = 40 + value.length * 9;
  // The expanded chat ends at y=510, so its caption uses the quiet top margin; that plate stops at the chat top (y=30).
  const top = start === 21800 ? 0 : 492;
  return visible(start, end, `<g opacity="0">${tl.animate('opacity', [
    [0, 0], [start, 0], [start + 250, 1, 'out'], [end - 250, 1], [end, 0, 'in'],
  ])}<rect x="24" y="${top}" width="${width}" height="${top ? 32 : 30}" rx="8" fill="#111113" fill-opacity=".86"/>
    <rect x="34" y="${top + 13}" width="6" height="6" fill="#ffb900"/>
    ${text(48, top + 22, value, 15)}</g>`);
}).join('');

assert.equal(scene.size.join('x'), '660x420');
assert.equal(scene.states.S4.order.length, 10);
assert.equal(scene.states.S0.order.length, 6);
assert.equal(events.filter(e => e.light).length, 3);
assert.ok(events.filter(e => e.light).every(e => !events.some(p => p.t < e.t && p.t > e.t - 500 && p.state)));
assert.ok(reference.startsWith('asb:1/') && reference.endsWith('opencode:ses_4c8e1a07d3f2b6k9m5p0r2t7'));
assert.ok(copyControl.every(Number.isFinite));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="hero-title">
<title id="hero-title">ASB: sessions from Claude Code, Codex, ChatGPT, OpenCode, and other machines on one board; copy a session reference, send messages, and open a chat</title>
${css()}
<defs>${boardDefs()}${appDefs()}<filter id="hero-board-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-opacity=".6"/></filter></defs>
<rect width="960" height="540" fill="#111113"/>
<g class="motion">${view.open}<g transform="translate(150 60)"><rect width="660" height="420" rx="12" fill="#000" filter="url(#hero-board-shadow)"/>${board.svg}</g>${view.close}
${apps.map(a => slide(a.window, a.start, a.end)).join('')}
${machine('Laptop', 8400, 130)}${machine('Studio', 9200, 178)}
${slide(pasteApp, 16300, 17950)}${chip}${opening}
${view.open}${pointer}${view.close}${captions}</g>
<g class="still"><g transform="translate(150 60)"><rect width="660" height="420" rx="12" fill="#000" filter="url(#hero-board-shadow)"/>${boardStill('S4')}</g></g>
${text(936, 520, 'made-up sessions', 11, '#8a877f', 'text-anchor="end"')}
</svg>\n`;
checkSvg(svg, 450000);
assert.ok(!svg.includes('/home/') && !svg.includes('undefined'));
const output = new URL('../docs/media/asb-hero.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
