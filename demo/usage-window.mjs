import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const scene = JSON.parse(await readFile(new URL('usage-window.json', import.meta.url), 'utf8'));
const { cost, tokens } = scene.states;
const loop = 12000;
const round = n => String(Math.round(n * 10) / 10);
const number = n => String(Number(n.toFixed(7)));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inOut = p => p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function animation(attribute, times, values, mode = 'linear', transform = '', splines = null) {
  const keyTimes = times.map(t => number(t / loop));
  assert.equal(keyTimes.length, values.length);
  assert.equal(keyTimes[0], '0');
  assert.equal(keyTimes.at(-1), '1');
  assert.ok(keyTimes.every((t, i) => !i || +t > +keyTimes[i - 1]), 'keyTimes must rise strictly');
  const element = transform ? `animateTransform type="${transform}"` : 'animate';
  const spline = splines ? ` keySplines="${splines.join(';')}"` : '';
  return `<${element} attributeName="${attribute}" dur="12s" repeatCount="indefinite" calcMode="${mode}" keyTimes="${keyTimes.join(';')}"${spline} values="${values.join(';')}"/>`;
}
// 60 fps samples plus the exact end; the tolerance keeps float noise from making a duplicate key time.
function sampled(start, duration) {
  const times = [];
  for (let i = 0; i * 1000 / 60 < duration - .5; i++) times.push(start + i * 1000 / 60);
  times.push(start + duration);
  return times;
}
const held = (attribute, times, values, transform = '') =>
  animation(attribute, [0, ...times, loop], [values[0], ...values, values.at(-1)], 'linear', transform);
// Visible in each [start, end) interval of the loop, else hidden; the attribute is the state at t = 0.
function shown(intervals) {
  const times = [0], values = [intervals[0]?.[0] === 0 ? 'visible' : 'hidden'];
  for (const [start, end] of intervals) {
    if (start > 0) { times.push(start); values.push('visible'); }
    if (end < loop) { times.push(end); values.push('hidden'); }
  }
  times.push(loop); values.push(values.at(-1));
  return { attribute: ` visibility="${values[0]}"`, animation: animation('visibility', times, values, 'discrete') };
}
const group = (intervals, inner, extra = '') => {
  const v = shown(intervals);
  return `<g${extra}${v.attribute}>${v.animation}${inner}</g>`;
};

// Scene items.
const paint = c => Array.isArray(c) ? `fill="${c[0]}" fill-opacity="${c[1]}"` : `fill="${c}"`;
const text = item => `<text x="${round(item.x)}" y="${round(item.y)}" font-size="${item.s}" font-weight="${item.w}"${item.a === 'start' ? '' : ` text-anchor="${item.a}"`} ${paint(item.c)}>${escape(item.t)}</text>`;
const dot = d => d.stroke
  ? `<circle cx="${round(d.cx)}" cy="${round(d.cy)}" r="${round(d.r)}" fill="none" stroke="${d.stroke}" stroke-width="${d.sw}"/>`
  : `<circle cx="${round(d.cx)}" cy="${round(d.cy)}" r="${round(d.r)}" fill="${d.fill}"/>`;
const rect = (r, extra = '') => `<rect x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}"${r.r ? ` rx="${r.r}"` : ''} fill="${r.fill}"${extra}/>`;
const line = l => `<path d="M${round(l.x1)} ${round(l.y1)}H${round(l.x2)}" stroke="${l.c}"/>`;
assert.ok([cost, tokens].every(s => s.frame.lines.every(l => l.y1 === l.y2)), 'the frame lines are horizontal');

// A linked toggle: only its outer side has rounded corners.
function toggle(b) {
  const { x, y, w, h } = b, r = 6, left = x === 118 || x === 771;
  const d = left
    ? `M${x + r} ${y}H${x + w}V${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
    : `M${x} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x}Z`;
  return `<path d="${d}" fill="${b.fill}"/>`;
}
const linked = buttons => [...buttons].sort((a, b) => !!a.active - !!b.active).map(toggle).join('');

const bar = state => (b, i) => `<rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="2" fill="${b.track}"/><g clip-path="url(#bar-${state}-${i})">${b.segments.map(s => `<rect x="${round(s.x)}" y="${round(b.y)}" width="${round(s.w)}" height="${round(b.h)}" fill="${s.fill}"/>`).join('')}</g>`;
const barClips = ['cost', 'tokens'].map(state => scene.states[state].bars.map((b, i) => `<clipPath id="bar-${state}-${i}"><rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="2"/></clipPath>`).join('')).join('');

function sector(arc) {
  assert.ok(arc.a1 - arc.a0 < 359.99, 'an arc is less than a full ring');
  const point = (r, a) => `${round(arc.cx + r * Math.cos(a * Math.PI / 180))} ${round(arc.cy + r * Math.sin(a * Math.PI / 180))}`;
  const large = arc.a1 - arc.a0 > 180 ? 1 : 0;
  return `M${point(arc.r1, arc.a0)}A${arc.r1} ${arc.r1} 0 ${large} 1 ${point(arc.r1, arc.a1)}L${point(arc.r0, arc.a1)}A${arc.r0} ${arc.r0} 0 ${large} 0 ${point(arc.r0, arc.a0)}Z`;
}

// Ports of monotone_tangents and smooth_curve in scripts/asb-native.py.
function monotoneTangents(points) {
  const count = points.length;
  const slopes = [];
  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1][0] - points[i][0], dy = points[i + 1][1] - points[i][1];
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = new Array(count).fill(0);
  tangents[0] = slopes[0]; tangents[count - 1] = slopes.at(-1);
  for (let i = 1; i < count - 1; i++) {
    const previous = slopes[i - 1], following = slopes[i];
    tangents[i] = previous * following <= 0 ? 0 : (previous + following) / 2;
  }
  for (let i = 0; i < count - 1; i++) {
    const slope = slopes[i];
    if (slope === 0) { tangents[i] = tangents[i + 1] = 0; continue; }
    const a = tangents[i] / slope, b = tangents[i + 1] / slope, magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope; tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
}
function seriesPaths(chart, points) {
  const tangents = monotoneTangents(points), xy = (x, y) => `${round(x)} ${round(y)}`;
  let d = `M${xy(...points[0])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [fx, fy] = points[i], [tx, ty] = points[i + 1], dx = tx - fx;
    d += `C${xy(fx + dx / 3, fy + tangents[i] * dx / 3)} ${xy(tx - dx / 3, ty - tangents[i + 1] * dx / 3)} ${xy(tx, ty)}`;
  }
  return { line: d, area: `${d}L${round(points.at(-1)[0])} ${chart.bottom}L${round(points[0][0])} ${chart.bottom}Z` };
}
const curves = state => Object.fromEntries(state.chart.series.map(s => [s.key, { color: s.color, ...seriesPaths(state.chart, s.points) }]));
const costCurves = curves(cost), tokenCurves = curves(tokens);
const letters = d => d.replace(/[^A-Za-z]/g, '');
for (const key of Object.keys(costCurves)) {
  for (const kind of ['line', 'area']) assert.equal(letters(costCurves[key][kind]), letters(tokenCurves[key][kind]), 'a morph has two paths with the same commands');
}
const areaAttrs = color => `fill="${color}" fill-opacity=".12"`;
const lineAttrs = color => `fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
const staticSeries = (state, set) => ['area', 'line'].map(kind => state.chart.series.map(s => `<path d="${set[s.key][kind]}" ${kind === 'area' ? areaAttrs(s.color) : lineAttrs(s.color)}/>`).join('')).join('');
const morph = [.16, 1, .3, 1].join(' '), flat = '0 0 1 1';
function morphingSeries(state, times, shapes, splines) {
  return ['area', 'line'].map(kind => state.chart.series.map(s => {
    const values = shapes.map(set => set[s.key][kind]);
    return `<path d="${values[0]}" ${kind === 'area' ? areaAttrs(s.color) : lineAttrs(s.color)}>${animation('d', times, values, 'spline', '', splines)}</path>`;
  }).join('')).join('');
}

// Items equal in both states draw once; the others get a cost copy and a tokens copy.
function split(costItems, tokenItems, render) {
  const inCost = new Set(costItems.map(i => JSON.stringify(i))), inTokens = new Set(tokenItems.map(i => JSON.stringify(i)));
  const shared = costItems.filter(i => inTokens.has(JSON.stringify(i)));
  return {
    shared,
    sharedMarkup: shared.map(render.cost ?? render).join(''),
    cost: costItems.filter(i => !inTokens.has(JSON.stringify(i))).map(render.cost ?? render).join(''),
    tokens: tokenItems.filter(i => !inCost.has(JSON.stringify(i))).map(render.tokens ?? render).join(''),
  };
}
const tokenTime = [1700, 9500];
const costIntervals = [[0, tokenTime[0]], [tokenTime[1], loop]], tokenIntervals = [tokenTime];
const stills = [];
function layer(costMarkup, tokenMarkup) {
  stills.push(costMarkup);
  return `<g class="motion">${group(costIntervals, costMarkup)}${group(tokenIntervals, tokenMarkup)}</g><g class="still">${costMarkup}</g>`;
}

// Pointer moves: [start, end, A, C (null for mid), B, eased].
const moves = [
  [600, 1500, [470, 360], [430, 30], [191.5, 16], true],
  [2100, 3000, [191.5, 16], [560, 200], [540.6, 560], true],
  [3000, 5000, [540.6, 560], null, [739.4, 560], false],
  [5300, 6200, [739.4, 560], [780, 120], [259.5, 320.3], true],
  [7100, 7500, [259.5, 320.3], null, [242.9, 296.5], true],
  [8400, 9300, [242.9, 296.5], [560, 160], [140.5, 16], true],
  [10000, 11000, [140.5, 16], [430, 30], [470, 360], true],
];
function pointerAt(t) {
  let at = moves[0][2];
  for (const [start, end, A, C, B, eased] of moves) {
    if (t >= end) { at = B; continue; }
    if (t <= start) break;
    const p = (t - start) / (end - start), e = eased ? inOut(p) : p, u = 1 - e;
    const c = C ?? [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    return [0, 1].map(k => u * u * A[k] + 2 * u * e * c[k] + e * e * B[k]);
  }
  return at;
}
const pointerTimes = [];
for (const [start, end] of moves) for (const t of sampled(start, end - start)) if (!(t <= pointerTimes.at(-1))) pointerTimes.push(t);
const clicks = [1700, 9500];
const pointer = `<g class="motion"><g transform="translate(470 360)">${held('transform', pointerTimes, pointerTimes.map(t => pointerAt(t).map(round).join(' ')), 'translate')}<g>${animation('transform', [0, ...clicks.flatMap(c => [c - 60, c, c + 60]), loop], ['1', ...clicks.flatMap(() => ['1', '.85', '1']), '1'], 'linear', 'scale')}<path d="M0 0V16.5L4.3 12.4 6.9 18.3 9.6 17.1 7 11.3H12.5Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/></g></g></g>`;

// Hover, decided at each 60 fps sample from the pointer position.
const isTokens = t => t >= tokenTime[0] && t < tokenTime[1];
function arcAt(state, [x, y]) {
  const radius = Math.hypot(x - 184, y - 212);
  let angle = Math.atan2(y - 212, x - 184) * 180 / Math.PI;
  if (angle < -90) angle += 360;
  const index = state.round.arcs.findIndex(a => a.r0 <= radius && radius <= a.r1 && a.a0 <= angle && angle <= a.a1);
  return index < 0 ? null : index;
}
function bucketAt(state, [x, y]) {
  const { chart } = state;
  if (!(chart.top <= y && y <= chart.bottom && chart.left <= x && x <= 924)) return null;
  let best = 0;
  chart.centers.forEach((c, i) => { if (Math.abs(c - x) < Math.abs(chart.centers[best] - x)) best = i; });
  return best;
}
// [index, t_in, t_out] runs of one hover target.
function runs(pick) {
  const out = [];
  for (let i = 0; i <= 720; i++) {
    const t = i * 1000 / 60, value = i < 720 ? pick(t) : null;
    const last = out.at(-1);
    if (last && last[2] === undefined && last[0] !== value) last[2] = t;
    if (value !== null && (!last || last[2] !== undefined)) out.push([value, t]);
  }
  return out;
}
const arcRuns = runs(t => arcAt(isTokens(t) ? tokens : cost, pointerAt(t)));
const bucketRuns = runs(t => bucketAt(isTokens(t) ? tokens : cost, pointerAt(t)));
for (const [, start, end] of [...arcRuns, ...bucketRuns]) assert.ok(isTokens(start) && isTokens(end - 1), 'no hover in the cost state');
assert.deepEqual(arcRuns.map(r => r[0]), [2, 0, 2]);
assert.deepEqual(bucketRuns.map(r => r[0]), [16, 17, 18, 19, 20, 21, 22, 23]);
const minus = (outer, cuts) => {
  const out = [];
  for (const [a, b] of outer) {
    let from = a;
    for (const [c, d] of cuts.filter(([c, d]) => d > a && c < b).sort((p, q) => p[0] - q[0])) { if (c > from) out.push([from, c]); from = Math.max(from, d); }
    if (from < b) out.push([from, b]);
  }
  return out;
};

// Header and side column.
const costButtons = cost.frame.buttons, tokenButtons = tokens.frame.buttons;
const buttonsAt = (list, xs) => list.filter(b => xs.includes(b.x));
const header = split(buttonsAt(costButtons, [118, 162]), buttonsAt(tokenButtons, [118, 162]), b => b);
assert.equal(header.shared.length, 0);
const pairs = split(buttonsAt(costButtons, [771, 833, 28, 868, 911]), buttonsAt(tokenButtons, [771, 833, 28, 868, 911]), b => b);
assert.equal(pairs.shared.length, 5, 'the buttons other than Cost and Tokens are shared');
assert.equal(costButtons.length, 7);
const texts = split(cost.frame.texts, tokens.frame.texts, text);
assert.deepEqual(texts.shared.map(t => t.t).sort(), ['30 days', 'By app', 'By machine']);
const lines = split(cost.frame.lines, tokens.frame.lines, line);
const dots = split(cost.frame.dots, tokens.frame.dots, dot);
const bars = split(cost.bars, tokens.bars, { cost: bar('cost'), tokens: bar('tokens') });
assert.deepEqual([lines, dots, bars].map(s => s.shared.length), [0, 0, 0]);
assert.ok(cost.frame.rects.length === 0 && tokens.frame.rects.length === 0);
// The expander chevrons of Machines, Apps, and Providers; the tokens state draws them 12 px lower.
const chevron = dy => [[[404.5, 115.5], [408.5, 119.5], [412.5, 115.5]], [[407.5, 251.5], [411.5, 255.5], [407.5, 259.5]], [[407.5, 277.5], [411.5, 281.5], [407.5, 285.5]]]
  .map(points => `<path d="M${points.map(([x, y]) => `${x} ${round(y + dy)}`).join(' ')}" fill="none" stroke="#b3b3b3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('');

let body = '<circle cx="14" cy="16" r="7.5" fill="url(#disc)"/>';
body += '<rect x="28" y="4" width="86" height="24" rx="6" fill="#0c0c0c"/><path d="M94 14.7 98 18.7 102 14.7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
body += layer(linked(buttonsAt(costButtons, [118, 162])), linked(buttonsAt(tokenButtons, [118, 162])));
body += '<path d="M2 2h8L7 6.2V10L5 9.2V6.2z" transform="translate(876 8) scale(1.3333)" fill="#fff" fill-opacity=".75"/>';
body += '<circle cx="924" cy="16" r="8" fill="#131313"/><path d="M920 12 928 20M928 12 920 20" stroke="#fff" stroke-opacity=".75" stroke-width="2" stroke-linecap="round"/>';
body += linked(buttonsAt(costButtons, [771, 833]));
body += texts.sharedMarkup;
body += layer(lines.cost + dots.cost + bars.cost + texts.cost + chevron(0), lines.tokens + dots.tokens + bars.tokens + texts.tokens + chevron(12));

// Round chart: in the tokens state, a hovered arc rises and the center shows its value.
const arcPath = a => `<path d="${sector(a)}" fill="${a.fill}"/>`;
const center = c => c.map(text).join('');
let tokenRound = '';
tokens.round.arcs.forEach((arc, i) => {
  const hovers = arcRuns.filter(r => r[0] === i).map(r => [r[1], r[2]]);
  if (!hovers.length) { tokenRound += arcPath(arc); return; }
  tokenRound += `<path d="${sector(arc)}" fill="${arc.fill}"${(v => v.attribute + '>' + v.animation)(shown(minus(tokenIntervals, hovers)))}</path>`;
  const middle = (arc.a0 + arc.a1) / 2 * Math.PI / 180;
  for (const [start, end] of hovers) {
    const times = sampled(start, Math.min(150, end - start));
    const offsets = times.map(t => { const e = 1 - (1 - Math.min(1, (t - start) / 150)) ** 3; return `${round(4 * e * Math.cos(middle))} ${round(4 * e * Math.sin(middle))}`; });
    tokenRound += group([[start, end]], `<g>${held('transform', times, offsets, 'translate')}${arcPath(arc)}</g>`);
  }
});
tokenRound += group(minus(tokenIntervals, arcRuns.map(r => [r[1], r[2]])), center(tokens.round.center));
for (const [i, start, end] of arcRuns) tokenRound += group([[start, end]], center(tokens.roundHover[i]));
body += layer(cost.round.arcs.map(arcPath).join('') + center(cost.round.center), tokenRound);

// Daily chart.
const grid = split(cost.chart.grid, tokens.chart.grid, r => rect(r));
const xLabels = split(cost.chart.xLabels, tokens.chart.xLabels, text);
const yLabels = split(cost.chart.yLabels, tokens.chart.yLabels, text);
assert.ok(grid.shared.length === cost.chart.grid.length && xLabels.shared.length === cost.chart.xLabels.length && !yLabels.shared.length);
assert.ok(same(cost.chart.centers, tokens.chart.centers) && cost.chart.bottom === tokens.chart.bottom);
body += grid.sharedMarkup + layer(yLabels.cost, yLabels.tokens) + xLabels.sharedMarkup;
const costOrder = morphingSeries(cost, [0, 1700, 9500, 9720, loop], [costCurves, costCurves, tokenCurves, costCurves, costCurves], [flat, flat, morph, flat]);
const tokenOrder = morphingSeries(tokens, [0, 1700, 1920, loop], [costCurves, costCurves, tokenCurves, tokenCurves], [flat, morph, flat]);
const stillSeries = staticSeries(cost, costCurves);
stills.push(stillSeries);
body += `<g class="motion">${group(costIntervals, costOrder)}${group(tokenIntervals, tokenOrder)}</g><g class="still">${stillSeries}</g>`;

// Tooltips over the chart, under the pointer.
let tips = '';
for (const [i, start, end] of bucketRuns) {
  const tip = tokens.tips[i], b = tip.box;
  assert.equal(tip.index, i);
  tips += group([[start, end]], rect(tip.line)
    + `<rect x="${round(b.x)}" y="${round(b.y)}" width="${b.w}" height="${b.h}" rx="4" fill="#000" filter="url(#tip-shadow)"/>`
    + `<rect x="${round(b.x + .5)}" y="${round(b.y + .5)}" width="${b.w - 1}" height="${b.h - 1}" rx="3.5" fill="${b.fill}" stroke="${b.stroke}" stroke-width="1"/>`
    + tip.rects.map(r => rect(r)).join('') + tip.texts.map(text).join(''));
}
body += `<g class="motion">${tips}</g>${pointer}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="948" height="700" viewBox="0 0 948 700" role="img" aria-labelledby="usage-title">
<title id="usage-title">ASB Usage window: the view switches from cost to tokens, a pointer reads the daily chart and the round chart, and the view switches back.</title>
<style>text{font-family:'Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace}.still{display:none}@media (prefers-reduced-motion:reduce){.motion{display:none}.still{display:inline}}</style>
<defs><radialGradient id="disc" cx="35%" cy="30%" r="95.5%"><stop offset="0" stop-color="#f3e6c4"/><stop offset=".6" stop-color="#a8905a"/><stop offset="1" stop-color="#5c4b28"/></radialGradient><clipPath id="window"><rect x="1" y="1" width="946" height="698" rx="8"/></clipPath>${barClips}<filter id="tip-shadow" x="-30%" y="-40%" width="160%" height="190%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity=".45"/></filter></defs>
<rect x=".5" y=".5" width="947" height="699" rx="8.5" fill="#000" stroke="#2c2c2c"/>
<g clip-path="url(#window)">${body}</g>
</svg>
`;

for (const element of svg.match(/<animate[^>]*>/g)) {
  assert.ok(element.includes('dur="12s" repeatCount="indefinite"'), 'each animation loops in 12 s');
  const keyTimes = element.match(/keyTimes="([^"]*)"/)[1].split(';').map(Number), values = element.match(/values="([^"]*)"/)[1].split(';');
  assert.ok(keyTimes[0] === 0 && keyTimes.at(-1) === 1 && keyTimes.every((t, i) => !i || t > keyTimes[i - 1]) && keyTimes.length === values.length);
}
assert.ok(stills.every(markup => !markup.includes('<animate') && !markup.includes('<use')), 'the still copies have no animation');
assert.equal(svg.split('class="still"').length - 1, stills.length);
assert.ok(!/<script|foreignObject|<image|<set|<animateMotion|\son[a-z]+=/i.test(svg), 'no script, foreign object, image, or event attribute');
assert.ok(!svg.replace('http://www.w3.org/2000/svg', '').includes('http'), 'no URL other than the SVG namespace');
assert.ok(Buffer.byteLength(svg) <= 150000, 'the SVG fits in 150 KB');
const output = new URL('../docs/media/usage-window.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`Wrote ${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
