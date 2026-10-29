import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const symbols = `<symbol id="p-codex" viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></symbol><symbol id="p-claude" viewBox="0 0 24 24"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></symbol>`;
const samples = [
  ['tools-api', 'Plan the release of the import job', 'codex', 'idle', 1, 0, '4m ago'],
  ['field-notes', 'Summarize the open issues into one short note', 'claude', 'idle', 1, 0, '12m ago'],
  ['docs-site', 'Write the release notes for 2.4', 'codex', 'idle', 1, 0, '31m ago'],
  ['importer', 'Compare two parsers for the import step', 'claude', 'working', 0, 0, '6m 02s'],
  ['billing', 'Coordinate the retry work across the services', 'codex', 'working', 0, 0, '2m 14s'],
  ['infra', 'Draft the migration plan for the queue', 'claude', 'working', 0, 1, '48s'],
  ['web-app', 'Review the flaky test in CI', 'codex', 'idle', 0, 0, '1h ago'],
  ['tools-api', 'Rename the config keys', 'claude', 'idle', 0, 0, '2h ago'],
  ['docs-site', 'Explain the cache warmup', 'codex', 'idle', 0, 0, '3h ago'],
  ['billing', 'Check the retry limits in the billing worker', 'claude', 'working', 0, 0, '1m 30s'],
  ['importer', 'Sketch the CSV error report', 'codex', 'idle', 0, 0, '5h ago'],
  ['field-notes', 'List the unused feature flags', 'claude', 'idle', 0, 0, '6h ago'],
];
const loop = 11500;
const steps = [[400, 4, 1], [650, 4, 5], [900, 4, 9], [2500, 9, 4], [3200, 1, 4], [4300, 5, 4]];
const accent = '#ffb900';
const round = n => String(Math.round(n * 10) / 10);
const number = n => String(Number(n.toFixed(7)));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const inOut = p => p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
const origin = i => [4 + 241 * Math.floor(i / 3), 3 + 68 * (i % 3)];
const endpoint = i => origin(i).map((v, axis) => v + [15, 9][axis]);
const text = (x, y, label, size, color, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" dominant-baseline="central"${extra}>${escape(label)}</text>`;
const icon = (i, color, opacity = 1) => {
  const [x, y] = origin(i);
  return `<use href="#p-${samples[i][2]}" x="${x + 8}" y="${y + 2}" width="14" height="14" fill="${color}" opacity="${opacity}"/>`;
};

function animation(attribute, times, values, discrete = false, transform = false) {
  const keyTimes = times.map(t => number(t / loop));
  assert.equal(keyTimes.length, values.length);
  assert.equal(keyTimes[0], '0');
  assert.equal(keyTimes.at(-1), '1');
  assert.ok(keyTimes.every((t, i) => !i || +t > +keyTimes[i - 1]), 'keyTimes must rise strictly');
  const element = transform ? 'animateTransform type="translate"' : 'animate';
  return `<${element} attributeName="${attribute}" dur="11.5s" repeatCount="indefinite" calcMode="${discrete ? 'discrete' : 'linear'}" keyTimes="${keyTimes.join(';')}" values="${values.join(';')}"/>`;
}
// 60 fps samples plus the exact end; the tolerance keeps float noise from making a duplicate key time.
function sampled(start, duration) {
  const times = [];
  for (let i = 0; i * 1000 / 60 < duration - .5; i++) times.push(start + i * 1000 / 60);
  times.push(start + duration);
  return times;
}
const held = (attribute, times, values, transform = false) =>
  animation(attribute, [0, ...times, loop], [values[0], ...values, values.at(-1)], false, transform);
const visible = (start, end) => animation('visibility', [0, start, end, loop], ['hidden', 'visible', 'hidden', 'hidden'], true);

function titleLines(title) {
  const words = title.split(' '), lines = [];
  while (words.length && lines.length < 2) {
    let line = words.shift();
    while (words.length && line.length + 1 + words[0].length <= 17) line += ' ' + words.shift();
    lines.push(line);
  }
  if (words.length) lines[1] = lines[1].slice(0, 16).trimEnd() + '…';
  return lines;
}

// Toolbar: content x 7 to 957, items 4 px apart, text sized at 0.6 em for each character.
let toolbar = '<circle cx="15" cy="21" r="8" fill="url(#disc)"/>';
const labels = ['Codex', 'Claude', 'Pending', 'Working', 'Drawer'];
const widths = labels.map(label => label.length * 12 * .6 + 20 + (label === 'Drawer' ? 11 : 0));
const count = '4 Pending · 40 sessions', countWidth = count.length * 11 * .6;
const searchWidth = 950 - 16 - widths.reduce((a, b) => a + b, 0) - countWidth - 12 - 90 - 10 * 4;
let x = 27;
toolbar += `<rect x="${x}" y="5" width="${round(searchWidth)}" height="32" rx="7" fill="#1d1d1d"/><g transform="translate(${x + 10} 14) scale(.875)" fill="none" stroke="#9d9d9d" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/></g>`;
toolbar += text(x + 31, 21, 'Find a session or folder', 13, '#9d9d9d');
x += searchWidth + 4;
labels.forEach((label, i) => {
  const drawer = label === 'Drawer';
  toolbar += `<rect x="${round(x)}" y="9" width="${round(widths[i])}" height="24" rx="12" fill="rgb(255 255 255 / .11)"/>`;
  if (drawer) toolbar += `<circle cx="${round(x + 12.5)}" cy="21" r="2.5" fill="${accent}"/>`;
  toolbar += text(round(x + widths[i] / 2 + (drawer ? 5.5 : 0)), 21, label, 12, '#fff', ' text-anchor="middle" font-weight="700"');
  x += widths[i] + 4;
});
toolbar += text(round(x + 6), 21, count, 11, '#bcbcbc');
x += countWidth + 12 + 4;
for (const [d, width] of [['M3.5 8h.01M8 8h.01M12.5 8h.01', 2.2], ['M12.6 6.2A5 5 0 1 0 13 9.6M12.9 2.8v3.5H9.4', 1.4], ['m4 4 8 8M12 4l-8 8', 1.4]]) {
  toolbar += `<rect x="${round(x)}" y="6" width="30" height="30" rx="7" fill="#1d1d1d"/><path d="${d}" transform="translate(${round(x + 8)} 14) scale(.875)" fill="none" stroke="#d6d6d6" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  x += 34;
}
assert.ok(Math.abs(x - 4 - 957) < .001, 'the toolbar fills its content width');

// Cards, in strip coordinates; a divider fills the pixel column that starts at strip x 239, 480, or 721.
let cards = [239, 480, 721].map(x => `<path d="M${x + .5} 0V212" stroke="#2b2b2b"/>`).join('');
samples.forEach(([folder, title, , state, unread, question, age], i) => {
  const [x, y] = origin(i), quiet = state === 'idle' && !unread;
  const muted = quiet ? '#a0a0a0' : '#bcbcbc';
  cards += icon(i, '#a5a5a5', .9) + `<g transform="translate(${x} ${y})">`;
  cards += text(29, 9, folder, 11, muted);
  titleLines(title).forEach((line, row) => { cards += text(29, 24.5 + 15 * row, line, 13, quiet ? '#ababab' : '#fff'); });
  cards += text(29, 56, state === 'working' ? 'Working' : 'Idle', 11, unread ? '#fff' : state === 'working' ? accent : muted);
  cards += text(221, 56, age, 11, muted, ' text-anchor="end"');
  if (unread || question) {
    cards += '<circle cx="212" cy="14" r="12" fill="rgb(255 255 255 / .08)"/>';
    cards += question ? text(212, 14, '?', 11, accent, ' text-anchor="middle" font-weight="800"') : `<circle cx="212" cy="14" r="3.5" fill="${accent}"/>`;
  }
  cards += '</g>';
});

let motion = '';
for (const [start, from, to] of steps) {
  const S = endpoint(from), R = endpoint(to);
  const dx = R[0] - S[0], dy = R[1] - S[1], dist = Math.hypot(dx, dy);
  let nx = -dy / dist, ny = dx / dist;
  if (Math.abs(dx) >= Math.abs(dy) ? ny > 0 : nx > 0) { nx = -nx; ny = -ny; }
  const off = Math.min(60, .22 * dist);
  const cx = Math.max(2, (S[0] + R[0]) / 2 + nx * off), cy = (S[1] + R[1]) / 2 + ny * off;
  const at = p => {
    const e = inOut(p), u = 1 - e;
    return [u * u * S[0] + 2 * u * e * cx + e * e * R[0], u * u * S[1] + 2 * u * e * cy + e * e * R[1]];
  };
  const duration = Math.min(900, Math.max(480, dist / 1.5));
  const times = sampled(start, duration), progress = times.map(t => (t - start) / duration);
  const heads = progress.map(p => at(p).map(round).join(' '));
  for (const [sample, point] of [[heads[0], S], [heads.at(-1), R]]) {
    assert.ok(sample.split(' ').every((v, axis) => Math.abs(+v - point[axis]) <= .05), 'a flight starts and ends at the provider icons');
  }
  motion += `<g visibility="hidden">${visible(start, start + 160)}${icon(from, accent)}</g>`;
  motion += `<g visibility="hidden">${visible(start, start + duration)}`;
  for (let k = 1; k <= 8; k++) {
    const paths = progress.map(p => `M${at(Math.max(0, p - (k - 1) * .025)).map(round).join(' ')} ${at(Math.max(0, p - k * .025)).map(round).join(' ')}`);
    const shown = progress.map(p => p - (k - 1) * .025 > 0 ? 'visible' : 'hidden');
    motion += `<path fill="none" stroke="${accent}" stroke-width="${number(3.2 * (1 - k / 9))}" stroke-opacity="${number(.7 * (1 - k / 9))}" stroke-linecap="round">${held('d', times, paths)}${animation('visibility', [0, ...times, loop], ['hidden', ...shown.slice(0, -1), 'hidden', 'hidden'], true)}</path>`;
  }
  motion += `<g>${held('transform', times, heads, true)}<circle r="6" fill="${accent}" opacity=".25"/><circle r="3" fill="${accent}"/></g></g>`;
  const arrival = start + duration, ringTimes = sampled(arrival, 420);
  const ease = ringTimes.map(t => { const q = (t - arrival) / 420; return q >= 1 ? 1 : 1 - 2 ** (-10 * q); });
  motion += `<circle cx="${R[0]}" cy="${R[1]}" r="5" fill="none" stroke="${accent}" stroke-width="1.5" visibility="hidden">${visible(arrival, arrival + 420)}${held('r', ringTimes, ease.map(e => round(5 + 8 * e)))}${held('stroke-opacity', ringTimes, ease.map(e => number(.85 * (1 - e))))}</circle>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="962" height="252" viewBox="0 0 962 252" role="img" aria-labelledby="board-title">
<title id="board-title">ASB board: one session sends a message to three sessions, and each one answers.</title>
<style>text{font-family:'Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace}@media (prefers-reduced-motion:reduce){#motion{display:none}}</style>
<defs>${symbols}<radialGradient id="disc" cx="35%" cy="30%" r="95.5%"><stop offset="0" stop-color="#f3e6c4"/><stop offset=".6" stop-color="#a8905a"/><stop offset="1" stop-color="#5c4b28"/></radialGradient><clipPath id="strip"><rect width="960" height="212"/></clipPath></defs>
<rect x=".5" y=".5" width="961" height="251" rx="8.5" fill="#000" stroke="#2c2c2c"/>
${toolbar}
<g transform="translate(1 39)" clip-path="url(#strip)">${cards}<g id="motion">${motion}</g></g>
</svg>
`;
assert.ok(!/<script|foreignObject|<image|\son[a-z]+=/i.test(svg), 'no script, foreign object, image, or event attribute');
assert.ok(!svg.replace('http://www.w3.org/2000/svg', '').includes('http'), 'no URL other than the SVG namespace');
assert.ok(Buffer.byteLength(svg) <= 150000, 'the SVG fits in 150 KB');
const output = new URL('../docs/media/board-message-light.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`Wrote ${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
