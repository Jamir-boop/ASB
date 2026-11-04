// The Comfortable card geometry of message-light.mjs, with two rows instead of three.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timeline, css, checkSvg, FONT_MONO, escape, number } from './hero-smil.mjs';
import { appDefs, cursor } from './hero-apps.mjs';

const tl = timeline(9000);
const C = { bg: '#000000', text: '#ffffff', accent: '#ffb900', muted: '#bcbcbc', title: '#ababab', caption: '#8f8f8f', hover: '#261c00' };
const origin = i => [4 + 241 * Math.floor(i / 2), 3 + 68 * (i % 2)];
const samples = [
  ['billing', ['Check the retry', 'limits'], 'claude', '4m ago'],
  ['docs-site', ['Write the release', 'notes for 2.4'], 'chatgpt', '12m ago'],
  ['field-notes', ['Summarize the open', 'issues'], 'chatgpt', '40m ago'],
  ['api-gateway', ['Add rate limit', 'headers'], 'claude', '1h ago'],
  ['design-kit', ['Tidy the icon set'], 'chatgpt', '3h ago'],
  ['release-kit', ['Draft the upgrade', 'guide'], 'claude', '5h ago'],
  ['web-app', ['Fix the login', 'screen test'], 'chatgpt', '6h ago'],
  ['infra', ['Rotate the staging', 'certificates'], 'claude', '8h ago', true],
];
const text = (x, y, label, size, color, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" dominant-baseline="central"${extra}>${escape(label)}</text>`;
const use = (name, x, y, size = 12, color = C.muted) => `<use href="#${name}" x="${x}" y="${y}" width="${size}" height="${size}" fill="${color}"/>`;
const shown = (start, end, svg) => `<g visibility="hidden">${tl.visibility([[start, end]])}${svg}</g>`;
const hover = svg => shown(1100, 5400, svg);
const feedback = [[0, 0], [3600, 0], [3700, 1], [5200, 1], [5300, 0]];
const muteAlpha = [[0, 0], [3600, 0], [3600, 1], [8600, 1], [9000, 0]];
const footer = color => text(29, 56, 'Idle', 11, color) + text(221, 56, '4m ago', 11, color, ' text-anchor="end"');
const caption = footer(C.caption) + hover(footer(C.muted));
const mutedMark = use('mute', 82.2, 3, 12, C.caption) + text(98.2, 9, '1h', 11, C.caption);

const rawMute = await readFile(new URL('../assets/icons/asb-muted-symbolic.svg', import.meta.url), 'utf8');
const icons = `<symbol id="mute" viewBox="0 0 16 16">${rawMute.match(/<path\b[^>]*\/>/g).join('')}</symbol>`
  + '<symbol id="bell" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M3 5a5 5 0 0 1 10 0c0 1.7.4 3.3 1 4.7a1 1 0 0 1-1 1.3H3a1 1 0 0 1-1-1.3C2.6 8.3 3 6.7 3 5zm2 0c0 1.4-.2 2.7-.6 4h7.2c-.4-1.3-.6-2.6-.6-4a3 3 0 0 0-6 0z"/><path d="M5.2 13a1 1 0 0 1 1.6-1.2 1.5 1.5 0 0 0 2.4 0 1 1 0 0 1 1.6 1.2 3.5 3.5 0 0 1-5.6 0z"/></symbol>'
  + '<symbol id="copy" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M3 0h5a3 3 0 0 1 3 3 1 1 0 0 1-2 0 1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1 1 1 0 0 1 0 2 3 3 0 0 1-3-3V3a3 3 0 0 1 3-3zm5 5h5a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/></symbol>'
  + '<symbol id="pin" viewBox="0 0 16 16"><path d="M5 0a1 1 0 0 0 0 2h.14l.52 3.59A5 5 0 0 0 3 10h10a5 5 0 0 0-2.66-4.41L10.85 2H11a1 1 0 0 0 0-2zM7 11v4l1 1 1-1v-4z"/></symbol>'
  + '<symbol id="check" viewBox="0 0 16 16"><path d="m3 9 3 3 7-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>';

// Pocket: the hovered card surface from the card top to y 34, square, with a 16 px fade on the left side only.
function pocket(left) {
  return `<rect x="${left}" y="0" width="${229 - left}" height="34" fill="url(#pocket-${left})"/>`;
}
const pocketLefts = [111, 14, 48];
let defs = appDefs() + icons + '<clipPath id="tag-word"><rect x="0" y="0" width="46" height="18"/></clipPath>';
for (const left of pocketLefts) defs += `<linearGradient id="pocket-${left}" gradientUnits="userSpaceOnUse" x1="${left}" x2="${left + 16}"><stop stop-color="${C.hover}" stop-opacity="0"/><stop offset="1" stop-color="${C.hover}"/></linearGradient>`;

// The widest duration has a 46 px word slot; the five dots use 28 px.
const tagWidth = 8 + 46 + 6 + 28 + 7;
assert.equal(tagWidth, 95);
const expo = p => p === 1 ? 1 : 1 - 2 ** (-10 * p);
const tagSlide = tl.sampled(1850, 200, p => `${number((1 - expo(p)) * 12)} 0`);
const tagFade = tl.sampled(1850, 200, p => number(expo(p)));
const wordRoll = tl.sampled(2600, 200, p => `0 ${number((1 - expo(p)) * 12)}`);
const wordFade = tl.sampled(2600, 200, p => number(expo(p)));
let dots = '';
for (let i = 0; i < 5; i++) {
  const first = i === 0 ? C.accent : 'none', next = i === 1 ? C.accent : 'none';
  dots += `<circle cx="${8 + 46 + 6 + 2 + i * 6}" cy="9" r="1.5" fill="${first}" stroke="${i === 0 ? C.accent : '#4d4d4d'}" stroke-width="1">`
    + tl.animate('fill', [[0, first], [2600, next]], { discrete: true })
    + tl.animate('stroke', [[0, i === 0 ? C.accent : '#4d4d4d'], [2600, i === 1 ? C.accent : '#4d4d4d']], { discrete: true }) + '</circle>';
}
const tagWord = label => text(0, 9, label, 10, C.text, ' font-weight="700" letter-spacing=".04em"');
const durationTag = `<g transform="translate(30 5)"><g>${tl.transform('translate', tagSlide)}${tl.animate('opacity', tagFade)}`
  + `<rect width="${tagWidth}" height="18" rx="9" fill="#1f1f1f"/>${dots}<g transform="translate(8 0)" clip-path="url(#tag-word)">`
  + shown(1850, 2600, tagWord('30 min'))
  + shown(2600, 3600, `<g>${tl.transform('translate', wordRoll)}${tl.animate('opacity', wordFade)}${tagWord('1 hour')}</g>`)
  + '</g></g></g>';
const unmuteTag = `<g transform="translate(64 5)"><rect width="61" height="18" rx="9" fill="#1f1f1f"/>${text(8, 9, 'Unmute', 10, C.text, ' font-weight="700" letter-spacing=".04em"')}</g>`;
let corner = shown(1100, 1850, pocket(111)) + shown(1850, 3600, pocket(14)) + shown(3600, 5400, pocket(48));
// The board: mute and copy rest on 8% of the text color; the button under the pointer gets 15% of the accent.
corner += shown(1100, 1600, '<circle cx="139" cy="14" r="12" fill="#141414"/>') + shown(1600, 5400, `<circle cx="139" cy="14" r="12" fill="${C.hover}"/>`);
corner += '<circle cx="165" cy="14" r="12" fill="#141414"/>';
corner += shown(1100, 3600, use('mute', 133, 8)) + shown(3600, 5400, use('bell', 133, 8, 12, C.accent));
corner += use('copy', 159, 8) + use('pin', 211, 8);
corner += shown(1100, 3600, `<circle cx="191" cy="14" r="3.25" fill="none" stroke="${C.muted}" stroke-width="1.5" stroke-dasharray="2 2"/>`);
corner += shown(1850, 3600, durationTag) + shown(3600, 5400, unmuteTag);

function board(still = false) {
  let svg = [239, 480, 721].map(x => `<path d="M${x + .5} 0V142" stroke="#2b2b2b"/>`).join('');
  samples.forEach(([folder, lines, app, age, unread], i) => {
    const [x, y] = origin(i);
    svg += `<g transform="translate(${x} ${y})">`;
    if (i === 0 && !still) svg += hover(`<rect width="233" height="68" rx="4" fill="${C.hover}"/>`);
    svg += use(`hero-app-${app}`, 8, 2, 14, '#a5a5a5') + text(29, 9, folder, 11, C.caption);
    if (i === 0 && !still) svg += hover(text(29, 9, folder, 11, C.muted));
    if (i === 0) svg += still ? mutedMark : `<g opacity="0">${tl.animate('opacity', muteAlpha)}${mutedMark}</g>`;
    lines.forEach((line, row) => {
      svg += text(29, 25 + 16 * row, line, 13, unread ? C.text : C.title);
      if (i === 0 && !still) svg += hover(text(29, 25 + 16 * row, line, 13, C.text));
    });
    if (i === 0 && !still) {
      svg += `<g>${tl.animate('opacity', feedback.map(([t, a]) => [t, 1 - a]))}${caption}</g>`;
      svg += `<g opacity="0" color="${C.accent}">${tl.animate('opacity', feedback)}${use('check', 29, 50, 12, C.accent)}${text(46, 56, 'Muted for 1 hour', 11, C.accent)}</g>`;
      svg += hover(corner);
    } else svg += text(29, 56, 'Idle', 11, C.caption) + text(221, 56, age, 11, C.caption, ' text-anchor="end"');
    if (unread) svg += `<circle cx="191" cy="14" r="12" fill="#141414"/><circle cx="191" cy="14" r="3.5" fill="${C.accent}"/>`;
    svg += '</g>';
  });
  return svg;
}
const pointer = shown(700, 5800, cursor(tl, {
  keys: [[0, 970, 150], [700, 970, 150], [1100, 153, 45, 'out'], [1300, 153, 45], [1600, 142, 15], [5400, 142, 15], [5800, 970, 150]],
  presses: [3600], wheels: [[2600, 'down']],
}));

// Text is legible on the board, the hover fill, and the tag/button fill.
const luminance = hex => {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb.reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
};
for (const fg of [C.text, C.accent, C.muted, C.title, C.caption]) for (const bg of [C.bg, C.hover, '#1f1f1f']) {
  assert.ok((luminance(fg) + .05) / (luminance(bg) + .05) >= 4.5, `${fg} has 4.5:1 text contrast on ${bg}`);
}
assert.equal(samples.length, 8);
assert.deepEqual(origin(7), [727, 71]);
assert.ok(samples.every(([, lines]) => lines.length <= 2 && lines.every(line => line.length <= 18)));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="962" height="142" viewBox="0 0 962 142" role="img" aria-labelledby="mute-title">
<title id="mute-title">ASB board: rest on the bell, turn the wheel from 30 min to 1 hour, and click. The card shows a muted bell and 1h.</title>
${css(`text{font-family:${FONT_MONO}}`)}
<defs>${defs}</defs>
<rect x=".5" y=".5" width="961" height="141" rx="8.5" fill="${C.bg}" stroke="#2c2c2c"/>
<g class="motion"><g transform="translate(1 0)">${board()}</g>${pointer}</g>
<g class="still" transform="translate(1 0)">${board(true)}</g>
</svg>
`;
const output = new URL('../docs/media/board-mute-wheel.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`Wrote ${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
checkSvg(svg, 100_000);
