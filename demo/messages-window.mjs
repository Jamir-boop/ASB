import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const scene = JSON.parse(await readFile(new URL('messages-window.json', import.meta.url), 'utf8'));
const { table, states, messages } = scene;
const icons = {};
for (const name of ['asb-openai-symbolic', 'asb-claude-symbolic', 'asb-opencode-symbolic']) {
  const file = await readFile(new URL(`../assets/icons/${name}.svg`, import.meta.url), 'utf8');
  const viewBox = file.match(/viewBox="([^"]+)"/)[1], paths = file.match(/<path[^>]*\/>/g).join('');
  icons[name] = `<symbol id="${name}" viewBox="${viewBox}">${paths}</symbol>`;
}
const apps = { codex: 'asb-openai-symbolic', claude: 'asb-claude-symbolic', opencode: 'asb-opencode-symbolic' };

const loop = 8400;
const T = [600, 2800, 5000];
const reset = 7500;
const light = '#ffd259', accent = '#ffb900';
const round = n => String(Math.round(n * 10) / 10);
const number = n => String(Number(n.toFixed(7)));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fill = (c, attribute = 'fill') => Array.isArray(c) ? `${attribute}="${c[0]}" ${attribute}-opacity="${number(c[1])}"` : `${attribute}="${c}"`;

function animation(attribute, times, values, discrete = false, transform = false) {
  const keyTimes = times.map(t => number(t / loop));
  assert.equal(keyTimes.length, values.length);
  assert.equal(keyTimes[0], '0');
  assert.equal(keyTimes.at(-1), '1');
  assert.ok(keyTimes.every((t, i) => !i || +t > +keyTimes[i - 1]), 'keyTimes must rise strictly');
  const element = transform ? 'animateTransform type="translate"' : 'animate';
  return `<${element} attributeName="${attribute}" dur="8.4s" repeatCount="indefinite" calcMode="${discrete ? 'discrete' : 'linear'}" keyTimes="${keyTimes.join(';')}" values="${values.join(';')}"/>`;
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
const motion = content => `<g class="motion">${content}</g>`;
const still = content => {
  assert.ok(!content.includes('<animate'), 'a still group has no animation');
  return `<g class="still">${content}</g>`;
};

// The app's curve and easing math (scripts/asb-native.py: bezier_point, curve_table, curve_point, cubic_bezier).
const bezierPoint = (p0, c, p1, t) => { const u = 1 - t; return p0.map((a, i) => u * u * a + 2 * u * t * c[i] + t * t * p1[i]); };
function curveTable(p0, c, p1, steps = 64) {
  const points = Array.from({ length: steps + 1 }, (_, i) => bezierPoint(p0, c, p1, i / steps)), lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return [points, lengths];
}
function curvePoint([points, lengths], fraction) {
  const goal = Math.max(0, Math.min(1, fraction)) * lengths.at(-1);
  for (let i = 1; i < points.length; i++) {
    if (lengths[i] >= goal) {
      const part = lengths[i] - lengths[i - 1], k = part > 0 ? (goal - lengths[i - 1]) / part : 0;
      return points[i - 1].map((a, axis) => a + (points[i][axis] - a) * k);
    }
  }
  return points.at(-1);
}
function cubicBezier(x1, y1, x2, y2) {
  const axis = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let low = 0, high = 1;
    for (let step = 0; step < 30; step++) {
      const middle = (low + high) / 2;
      if (axis(x1, x2, middle) < x) low = middle; else high = middle;
    }
    return axis(y1, y2, (low + high) / 2);
  };
}
const easeFlight = cubicBezier(.45, 0, .2, 1), easeBars = cubicBezier(.16, 1, .3, 1);

// Drawing helpers for scene items.
const text = (item, extra = '') => `<text x="${round(item.x)}" y="${round(item.y)}" font-size="${number(item.s)}" font-weight="${item.w}" text-anchor="${item.a}" ${fill(item.c)}${extra}>${escape(item.t)}</text>`;
function icon(item) {
  if (item.i === 'object-select-symbolic') {
    const d = [[2.6, 7.4], [6.1, 10.6], [12, 3.4]].map(([x, y]) => `${round(item.x + x)} ${round(item.y + y)}`).join(' ');
    return `<path d="M${d}" fill="none" ${fill(item.c, 'stroke')} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  assert.ok(icons[item.i], `known icon ${item.i}`);
  return `<use href="#${item.i}" x="${round(item.x)}" y="${round(item.y)}" width="${item.s}" height="${item.s}" ${fill(item.c)}/>`;
}
const dot = d => d.stroke ? `<circle cx="${round(d.cx)}" cy="${round(d.cy)}" r="${round(d.r)}" fill="none" stroke="${d.stroke}" stroke-width="${number(d.sw)}"/>`
  : `<circle cx="${round(d.cx)}" cy="${round(d.cy)}" r="${round(d.r)}" fill="${d.fill}"/>`;
const rect = r => `<rect x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}" rx="${round(r.r ?? 0)}" fill="${r.fill}"/>`;
const line = l => `<path d="M${round(l.x1)} ${round(l.y1)} ${round(l.x2)} ${round(l.y2)}" stroke="${l.c}"/>`;
const draw = { lines: line, rects: rect, dots: dot, icons: icon, texts: item => text(item) };
function sectorPath({ cx, cy, r0, r1, a0, a1 }) {
  assert.ok(a1 - a0 < 359.99, 'a sector is not a full ring');
  const point = (r, a) => `${round(cx + r * Math.cos(a * Math.PI / 180))} ${round(cy + r * Math.sin(a * Math.PI / 180))}`;
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${point(r1, a0)}A${round(r1)} ${round(r1)} 0 ${large} 1 ${point(r1, a1)}L${point(r0, a1)}A${round(r0)} ${round(r0)} 0 ${large} 0 ${point(r0, a0)}Z`;
}

// Ledger items: Recent (y 626 and below) per state, static when equal in all states, else per state.
const kinds = ['lines', 'rects', 'dots', 'icons', 'texts'];
const top = (kind, item) => kind === 'texts' ? item.y - 16 : item.y;
const recentRow = (kind, item) => (kind === 'texts' || kind === 'icons') && item.y >= 626 ? Math.floor((top(kind, item) - 626) / 26 + 1e-9) : -1;
let staticLedger = '';
const perState = states.map(() => ''), totals = states.map(() => ''), rows = states.map(() => Array.from({ length: 6 }, () => ''));
for (const kind of kinds) {
  const count = states[0].ledger[kind].length;
  assert.ok(states.every(state => state.ledger[kind].length === count), `the same number of ${kind} in each state`);
  for (let i = 0; i < count; i++) {
    const items = states.map(state => state.ledger[kind][i]);
    const row = recentRow(kind, items[0]);
    if (row >= 0) {
      items.forEach((item, k) => {
        assert.equal(recentRow(kind, item), row);
        rows[k][row] += draw[kind](item);
      });
    } else if (kind === 'texts' && items[0].s === 30) items.forEach((item, k) => { totals[k] += draw[kind](item); });
    else if (items.every(item => JSON.stringify(item) === JSON.stringify(items[0]))) staticLedger += draw[kind](items[0]);
    else items.forEach((item, k) => { perState[k] += draw[kind](item); });
  }
}
assert.ok(totals.every(total => total), 'each state has its total');
assert.ok(rows.every(stateRows => stateRows.every(row => row)), 'each state has six Recent rows');
const centers = states.map(state => state.center.map(item => text(item)).join(''));

// Per-state groups: instant switches at the message times; at 7.5 s state 3 fades out in 150 ms, then state 0 fades in.
const back = reset + 150;
const shown = [[0, T[0], back], [T[0], T[1]], [T[1], T[2]], [T[2], back]];
function stateGroup(k, content) {
  let anims;
  if (k === 0) anims = animation('visibility', [0, T[0], back, loop], ['visible', 'hidden', 'visible', 'visible'], true) + animation('opacity', [0, T[0], back, back + 150, loop], [1, 1, 0, 1, 1]);
  else {
    const [start, end] = shown[k];
    anims = animation('visibility', [0, start, end, loop], ['hidden', 'visible', 'hidden', 'hidden'], true);
    if (k === 3) anims += animation('opacity', [0, reset, back, loop], [1, 1, 0, 0]);
  }
  return `<g visibility="${k ? 'hidden' : 'visible'}">${anims}${content}</g>`;
}
function totalGroup(k) {
  const values = k === 0 ? [[0, 1], [T[0], 1], [T[0] + 300, 0], [back, 0], [back + 150, 1], [loop, 1]]
    : k === 3 ? [[0, 0], [T[2], 0], [T[2] + 300, 1], [reset, 1], [back, 0], [loop, 0]]
      : [[0, 0], [T[k - 1], 0], [T[k - 1] + 300, 1], [T[k], 1], [T[k] + 300, 0], [loop, 0]];
  return `<g opacity="${k ? 0 : 1}">${animation('opacity', values.map(v => v[0]), values.map(v => v[1]))}${totals[k]}</g>`;
}
function recent(k) {
  if (k === 0) return rows[0].join('');
  const times = sampled(T[k - 1], 200), eased = times.map(t => 1 - (1 - Math.min(1, (t - T[k - 1]) / 200)) ** 3);
  const slide = held('transform', times, eased.map(e => `0 ${round(-24 * (1 - e))}`), true);
  return `<clipPath id="new-row-${k}"><rect x="647" y="626" width="303" height="0">${held('height', times, eased.map(e => round(24 * e)))}</rect></clipPath>`
    + `<g>${slide}${rows[k].slice(1).join('')}</g><g clip-path="url(#new-row-${k})"><g>${slide}${rows[k][0]}</g></g>`;
}

// Chords, the gradients they use, and their opacity while a light flies.
let defs = '';
const chordFails = chord => chord.fails.map(points => `<polyline points="${points.map(p => p.map(round).join(',')).join(' ')}" fill="none" stroke="#f5a090" stroke-width="2" stroke-dasharray="5 5"/>`).join('');
const chordPaths = table.chords.map((chord, i) => {
  assert.ok(!chord.bad, 'no chord is bad');
  let stroke = chord.colors[0];
  if (!chord.same) {
    defs += `<linearGradient id="chord-${i}" gradientUnits="userSpaceOnUse" x1="${round(chord.from[0])}" y1="${round(chord.from[1])}" x2="${round(chord.to[0])}" y2="${round(chord.to[1])}"><stop offset="0" stop-color="${chord.colors[0]}"/><stop offset="1" stop-color="${chord.colors[1]}"/></linearGradient>`;
    stroke = `url(#chord-${i})`;
  }
  return `d="M${chord.p0.map(round).join(' ')}Q${chord.c.map(round).join(' ')} ${chord.p1.map(round).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${number(chord.width)}" stroke-linecap="round" opacity="${number(chord.alpha)}"`;
});
const chordTimes = [0, ...T.flatMap(t => [t, t + 900]), loop];
const motionChords = table.chords.map((chord, i) => {
  const values = [chord.alpha, ...messages.flatMap(m => [m.chord === i ? 1 : .25, chord.alpha]), chord.alpha].map(number);
  return `<path ${chordPaths[i]}>${animation('opacity', chordTimes, values, true)}</path>${chordFails(chord)}`;
}).join('');
const stillChords = table.chords.map((chord, i) => `<path ${chordPaths[i]}/>${chordFails(chord)}`).join('');

// Lights, sender strokes, and rings, one set per message.
let lights = '', strokes = '';
messages.forEach((message, j) => {
  const chord = table.chords[message.chord], curve = curveTable(chord.p0, chord.c, chord.p1), start = T[j];
  const place = ms => { const d = easeFlight(Math.min(900, ms) / 900) * message.end; return curvePoint(curve, message.forward ? d : 1 - d); };
  const times = sampled(start, 900), elapsed = times.map(t => t - start);
  const heads = elapsed.map(place);
  for (const [sample, pin] of [[heads[0], message.fromPin], [heads.at(-1), message.toPin]]) {
    assert.ok(sample.every((v, axis) => Math.abs(v - pin[axis]) <= .05), 'a light starts and ends at its pins');
  }
  const move = points => held('transform', times, points.map(p => p.map(round).join(' ')), true);
  lights += `<g visibility="hidden">${visible(start, start + 900)}<circle r="6" fill="${accent}" opacity=".25">${move(heads)}</circle>`;
  for (let i = 7; i >= 0; i--) {
    const trail = elapsed.map(e => place(Math.max(0, e - (i + 1) / 8 * .2 * e)));
    lights += `<circle r="${number(2.6 - 2 * i / 7)}" fill="${light}" opacity="${number(.5 - .45 * i / 7)}">${move(trail)}</circle>`;
  }
  lights += `<circle r="3" fill="${light}">${move(heads)}</circle></g>`;
  strokes += `<circle cx="${round(message.fromPin[0])}" cy="${round(message.fromPin[1])}" r="16" fill="none" stroke="${light}" stroke-width="1.5" visibility="hidden">${visible(start, start + 160)}</circle>`;
  const arrival = start + 900, ringTimes = sampled(arrival, 420), ease = ringTimes.map(t => easeBars((t - arrival) / 420));
  strokes += `<circle cx="${round(message.toPin[0])}" cy="${round(message.toPin[1])}" r="16" fill="none" stroke="${light}" stroke-width="1.5" visibility="hidden">${visible(arrival, arrival + 420)}${held('r', ringTimes, ease.map(e => round(16 + 10 * e)))}${held('stroke-opacity', ringTimes, ease.map(e => number(1 - e)))}</circle>`;
});

let tableLayer = '';
for (const sector of table.sectors) {
  tableLayer += `<path d="${sectorPath(sector)}" fill="${sector.fill}" fill-opacity="${number(sector.alpha)}"/>`;
  for (const [[x1, y1], [x2, y2]] of sector.spokes) tableLayer += `<path d="M${round(x1)} ${round(y1)} ${round(x2)} ${round(y2)}" stroke="${sector.fill}" stroke-dasharray="4 3"/>`;
}
for (const band of table.bands) {
  const d = sectorPath(band);
  tableLayer += `<path d="${d}" fill="${band.fill}" fill-opacity="${number(band.alpha)}"/>`;
  if (band.dashed) tableLayer += `<path d="${d}" fill="none" stroke="${band.fill}" stroke-dasharray="4 3"/>`;
}
tableLayer += motion(motionChords) + still(stillChords);
tableLayer += `<circle cx="${round(table.disc.cx)}" cy="${round(table.disc.cy)}" r="${round(table.disc.r)}" fill="#000" stroke="#212121"/>`;
tableLayer += motion(lights);
tableLayer += table.labels.map(item => text(item, ' stroke="#000" stroke-width="4" stroke-linejoin="round" paint-order="stroke"')).join('');
tableLayer += table.pins.map(pin => `<g opacity="${number(pin.alpha)}"><circle cx="${round(pin.x)}" cy="${round(pin.y)}" r="16" fill="#000"/><circle cx="${round(pin.x)}" cy="${round(pin.y)}" r="16" fill="none" stroke="${pin.hue}" stroke-width="1.5"${pin.offline ? ' stroke-dasharray="4 3"' : ''}/><use href="#${apps[pin.app]}" x="${round(pin.x - 7)}" y="${round(pin.y - 7)}" width="14" height="14" fill="#fff" fill-opacity=".85"/></g>`).join('');
tableLayer += motion(strokes);
tableLayer += table.machineLabels.map(item => text(item)).join('');
tableLayer += motion(centers.map((center, k) => stateGroup(k, center)).join('')) + still(centers[0]);

const ledger = staticLedger
  + motion(states.map((_, k) => stateGroup(k, perState[k] + recent(k)) + totalGroup(k)).join(''))
  + still(perState[0] + rows[0].join('') + totals[0]);

const [clipX, clipY, clipW, clipH] = table.clip;
const header = '<circle cx="14" cy="16" r="7.5" fill="url(#disc)"/>'
  + `<rect x="${round(scene.frame.buttons[0].x)}" y="${round(scene.frame.buttons[0].y)}" width="${round(scene.frame.buttons[0].w)}" height="${round(scene.frame.buttons[0].h)}" rx="6" fill="#0c0c0c"/>`
  + scene.frame.texts.map(item => text(item)).join('')
  + '<path d="M87 14.7 91 18.7 95 14.7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<circle cx="944" cy="16" r="8" fill="#131313"/><path d="M940 12 948 20M948 12 940 20" stroke="#fff" stroke-opacity=".75" stroke-width="2" stroke-linecap="round"/>';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="968" height="760" viewBox="0 0 968 760" role="img" aria-labelledby="messages-title">
<title id="messages-title">ASB Messages window: three messages arrive between sessions, a light flies along each chord, and the counts update.</title>
<style>text{font-family:'Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace}.still{display:none}@media (prefers-reduced-motion:reduce){.motion{display:none}.still{display:inline}}</style>
<defs>${Object.values(icons).join('')}<radialGradient id="disc" cx="35%" cy="30%" r="95.5%"><stop offset="0" stop-color="#f3e6c4"/><stop offset=".6" stop-color="#a8905a"/><stop offset="1" stop-color="#5c4b28"/></radialGradient>${defs}<clipPath id="window"><rect x="1" y="1" width="966" height="758" rx="8"/></clipPath><clipPath id="table"><rect x="${round(clipX)}" y="${round(clipY)}" width="${round(clipW)}" height="${round(clipH)}"/></clipPath></defs>
<rect x=".5" y=".5" width="967" height="759" rx="8.5" fill="#000" stroke="#2c2c2c"/>
<g clip-path="url(#window)">
${header}
<g clip-path="url(#table)">${tableLayer}</g>
${ledger}
</g>
</svg>
`;
for (const match of svg.matchAll(/<animate(?:Transform)?\b[^>]*>/g)) {
  assert.ok(match[0].includes('dur="8.4s"') && match[0].includes('repeatCount="indefinite"'), 'each animation loops in 8.4 s');
}
assert.ok(!/<script|foreignObject|<image|\son[a-z]+=|<set\b|<animateMotion/i.test(svg), 'no script, foreign object, image, event attribute, set, or animateMotion');
assert.ok(!svg.replace('http://www.w3.org/2000/svg', '').includes('http'), 'no URL other than the SVG namespace');
assert.ok(Buffer.byteLength(svg) <= 150000, 'the SVG fits in 150 KB');
const output = new URL('../docs/media/messages-window.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`Wrote ${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
