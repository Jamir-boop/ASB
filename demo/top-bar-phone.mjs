import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timeline, css, escape, number, checkSvg } from './hero-smil.mjs';

// Made-up sessions: id -> [title, source].
const SESSIONS = {
  U: ['Fix the flaky upload test', 'Codex'],
  D: ['Write the release notes for 2.4', 'Claude Desktop Code'],
  I: ['Rotate the staging certificates', 'Codex'],
};

// The story (ms). P = the top bar changes; R = a read of the phone's live service.
const LOOP = 14000, P1 = 1200, R1 = 2500, P2 = 6000, R2 = 7500, TAP = 9700, P3 = 10900, R3 = 12500;
const FLASH_END = R1 + 8000, RESET = 13400, DIP_OUT = RESET + 250, DIP_JUMP = DIP_OUT + 50, DIP_IN = DIP_OUT + 100;
const HEADS_UP = [[R1, 2200, 'done', 'Done', 'D'], [R2, 2000, 'input', 'Needs your answer', 'U']];
const STILL_AT = 8000;
// The top bar: [time, needs you, working].
const BAR = [[0, 0, 3], [P1, 1, 2], [P2, 2, 1], [P3, 1, 1]];
// What each read sees: id -> [state, pending, mark]; the mark is '?' for a question and '' otherwise.
const READS = [
  [0, { U: ['working', false, ''], D: ['working', false, ''], I: ['working', false, ''] }],
  [R1, { U: ['working', false, ''], D: ['idle', true, ''], I: ['working', false, ''] }],
  [R2, { U: ['waiting', true, '?'], D: ['idle', true, ''], I: ['working', false, ''] }],
  [R3, { U: ['waiting', true, '?'], D: ['idle', false, ''], I: ['working', false, ''] }],
];

const C = {
  ground: '#111113', window: '#242424', control: '#343434', text: '#f6f3ed', muted: '#b3b0aa', hairline: '#4a4844',
  amber: '#ffb900', flash: '#ffce4d',
};
const S = .9; // dp to px for every phone part
const SLIDE = 12 / S;

// Ports of the Android rules (notify/LiveService.kt).
const rows = read => Object.entries(read).map(([id, [state, pending, mark]]) => ({ id, state, pending, mark }));
const counts = read => [rows(read).filter(r => r.pending).length, rows(read).filter(r => r.state === 'working').length];
const liveTitle = read => `${counts(read)[0]} pending · ${counts(read)[1]} working`;
const liveLines = read => rows(read).filter(r => r.state === 'working').map(r => SESSIONS[r.id][0]);
const readAt = t => READS.findLast(([at]) => at <= t)[1];
function badge(t) {
  if (t >= R1 && t < FLASH_END) return ['done', 'Done'];
  const [pending, working] = counts(readAt(t));
  if (pending) return [rows(readAt(t)).some(r => r.mark === '?') ? 'input' : 'pending', String(pending)];
  return ['working', String(working)];
}
const BADGE_TIMES = [0, R1, FLASH_END, R3];

// Self-checks of the story.
for (const [p, r] of [[P1, R1], [P2, R2], [P3, R3]]) assert.ok(r - p >= 1000 && r - p <= 3000, 'each read is 1 to 3 s after its PC event');
assert.ok(R2 - R1 === 5000 && R3 - R2 === 5000, 'the live service reads every 5 s');
assert.ok(P3 - TAP >= 1000 && P3 - TAP <= 2000, 'the top bar follows the Read tap after 1 to 2 s');
assert.ok(TAP > R2 + HEADS_UP[1][1], 'the tap comes after the second heads-up');
assert.ok(R3 + 800 < RESET && DIP_IN + 250 === LOOP, 'the dip ends the loop');
READS.forEach(([t, read], i) => assert.deepEqual(counts(read), BAR[i].slice(1), `the phone at ${t} shows the counts of the top bar`));
assert.deepEqual(BADGE_TIMES.map(t => badge(t).join(' ')), ['working 3', 'done Done', 'input 2', 'input 1']);

// Rendering: one function draws a part for the motion copy or for the still copy at STILL_AT.
const tl = timeline(LOOP);
let still = false;
function valueAt(keys, t) {
  const i = keys.findLastIndex(([at]) => at <= t);
  if (i < 0) return String(keys[0][1]);
  if (i === keys.length - 1) return String(keys[i][1]);
  const [t0, a] = keys[i], [t1, b] = keys[i + 1];
  const A = String(a).split(' ').map(Number), B = String(b).split(' ').map(Number);
  if (t1 === t0 || A.some(Number.isNaN) || B.some(Number.isNaN)) return String(a);
  return A.map((v, j) => number(v + (B[j] - v) * (t - t0) / (t1 - t0))).join(' ');
}
// anims: [[attribute or 'translate' or 'scale', keys]]. Every animation must end the loop at its value at 0.
function el(tag, attrs, anims = [], inner = '') {
  attrs = { ...attrs };
  let kids = '';
  for (const [name, keys] of anims) {
    assert.equal(valueAt(keys, LOOP), valueAt(keys, 0), `the ${name} of a ${tag} closes the loop`);
    const transform = name === 'translate' || name === 'scale';
    if (still) {
      const v = valueAt(keys, STILL_AT);
      if (name === 'opacity' && +v === 0) return '';
      if (transform) attrs.transform = `${name}(${v})`; else attrs[name] = v;
    } else if (transform) {
      attrs.transform = `${name}(${valueAt(keys, 0)})`;
      kids += tl.transform(name, keys);
    } else {
      attrs[name] = valueAt(keys, 0);
      kids += tl.animate(name, keys);
    }
  }
  return `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${kids}${inner}</${tag}>`;
}
const g = (attrs, inner, anims) => el('g', attrs, anims, inner);
const text = (x, y, size, fill, value, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${escape(value)}</text>`;
const BOLD = ' font-weight="700"', SEMI = ' font-weight="600"', END = ' text-anchor="end"', MID = ' text-anchor="middle"';

// Opacity (and translate) keys of one element from its spans: { in, out } with { t0, t1, dy, ease }; no in = shown at 0.
function life(spans) {
  const op = [], tr = [];
  for (const s of spans) {
    if (s.in) op.push([s.in.t0, 0], [s.in.t1, 1, s.in.ease]), tr.push([s.in.t0, `0 ${number(s.in.dy ?? 0)}`], [s.in.t1, '0 0', s.in.ease]);
    else op.push([0, 1]), tr.push([0, '0 0']);
    if (s.out) op.push([s.out.t0, 1], [s.out.t1, 0, s.out.ease]), tr.push([s.out.t0, '0 0'], [s.out.t1, `0 ${number(s.out.dy ?? 0)}`, s.out.ease]);
  }
  if (tr.every(([, v]) => v === '0 0')) return [['opacity', op]];
  // Hidden at the end: go back to the first offset.
  if (tr.at(-1)[1] !== tr[0][1]) tr.push([LOOP, tr[0][1]]);
  return [['opacity', op], ['translate', tr]];
}
// A place that shows one value at a time. changes: [[ms, value]] from 0; '' shows nothing.
// kind 'swap': 150 ms out, then 150 ms in (a value in an empty place arrives in 300 ms); 'roll': the capsule number roll.
function track(changes, draw, { kind = 'swap', roll = 0 } = {}) {
  const list = changes.filter(([, v], i) => !i || v !== changes[i - 1][1]);
  const segs = list.map(([a, v], i) => ({ v, a, b: list[i + 1]?.[0] ?? RESET }));
  const first = segs[0].v, last = segs.at(-1);
  if (last.v === first) last.b = LOOP;
  else { last.dip = true; segs.push({ v: first, a: DIP_IN, b: LOOP, back: true }); }
  return [...new Set(segs.map(s => s.v))].filter(v => v !== '').map(v => {
    const spans = segs.map((s, i) => ({ ...s, prev: segs[i - 1]?.v })).filter(s => s.v === v).map(s => {
      let enter = null, exit = null;
      if (s.back) enter = { t0: DIP_IN, t1: LOOP, ease: 'out' };
      else if (s.a > 0) enter = kind === 'roll' ? { t0: s.a, t1: s.a + 220, dy: roll, ease: 'outExpo' }
        : s.prev ? { t0: s.a + 150, t1: s.a + 300, ease: 'out' }
        : { t0: s.a, t1: s.a + 300, dy: -SLIDE, ease: 'outExpo' };
      if (s.dip) exit = { t0: RESET, t1: DIP_OUT, ease: 'out' };
      else if (s.b < LOOP) exit = kind === 'roll' ? { t0: s.b, t1: s.b + 220, dy: -roll, ease: 'outExpo' } : { t0: s.b, t1: s.b + 150, ease: 'out' };
      return { in: enter, out: exit };
    });
    if (spans.length === 1 && !spans[0].in && !spans[0].out) return draw(v);
    return g({}, draw(v), life(spans));
  }).join('');
}

// Icons: the Android vector path data (res/drawable).
const SYMBOLS = `<symbol id="i-done" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"><path stroke-width="2" d="M12,2.5A9.5,9.5 0,1 1,12,21.5A9.5,9.5 0,1 1,12,2.5Z"/><path stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M7.6,12.4L10.6,15.4L16.4,9.2"/></g></symbol>`
  + `<symbol id="i-input" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"><path stroke-width="2" d="M12,2.5A9.5,9.5 0,1 1,12,21.5A9.5,9.5 0,1 1,12,2.5Z"/><path stroke-width="2.2" stroke-linecap="round" d="M9.2,9.3A2.9,2.9 0,1 1,13.8,11.6C12.7,12.4 12,12.9 12,14.5"/></g><path fill="currentColor" d="M12,16.6A1.25,1.25 0,1 1,12,19.1A1.25,1.25 0,1 1,12,16.6Z"/></symbol>`
  + `<symbol id="i-working" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M12,3.5A8.5,8.5 0,1 1,3.5,12"/></symbol>`
  + `<symbol id="i-asb" viewBox="0 0 64 64"><path fill="currentColor" fill-rule="evenodd" d="M32,2A30,30 0,1 1,32,62A30,30 0,1 1,32,2ZM32,23.5A8.5,8.5 0,1 1,32,40.5A8.5,8.5 0,1 1,32,23.5Z"/></symbol>`;
const icon = (name, x, y, size, color) => `<use href="#i-${name}" x="${number(x)}" y="${number(y)}" width="${size}" height="${size}" color="${color}"/>`;

// The capsule of gnome-shell/stylesheet.css, 76 x 22 px: Needs you 0-35, line, Working 36-76.
// The segment backgrounds paint over the capsule ring, as the St children do.
function capsule(id) {
  const W = a => `rgba(255,255,255,${a})`;
  const NUM_H = 17, ROLL = .6 * NUM_H;
  const num = (x, fill) => v => text(x, 16, 14, fill, v, BOLD);
  const box = (name, x) => `<clipPath id="${id}-${name}"><rect x="${x}" y="${11 - NUM_H / 2}" width="11" height="${NUM_H}"/></clipPath>`;
  const at = key => BAR.map(([t, ...v]) => [t, String(v[key])]);
  const background = el('rect', { width: 35, height: 22, fill: C.amber }, [
    ['opacity', [[P1, 0], [P1 + 200, 1, 'out'], [RESET, 1], [DIP_OUT, 0, 'out']]],
    ['fill', [[0, C.amber], [P1, C.amber], [P1, C.flash], [P1 + 200, C.flash], [P1 + 400, C.amber, 'out'],
      [P2, C.amber], [P2 + 200, C.flash, 'out'], [P2 + 400, C.amber, 'out']]],
  ]);
  const ring = el('circle', { cx: 11, cy: 11, r: 2.25, fill: 'none', stroke: W(.46), 'stroke-width': 1.5 },
    [['opacity', [[P1, 1], [P1, 0], [DIP_IN, 0], [LOOP, 1, 'out']]]]);
  const dot = el('circle', { cx: 11, cy: 11, r: 3 }, [['opacity', [[P1, 0], [P1, 1], [RESET, 1], [DIP_OUT, 0, 'out']]]]);
  // The Needs you ink: 46% white at 0, black on the accent.
  const needs = g({}, dot + `<g clip-path="url(#${id}-n)">${track(at(0), num(19, 'inherit'), { kind: 'roll', roll: ROLL })}</g>`, [
    ['fill', [[P1, '#ffffff'], [P1 + 200, '#000000', 'out'], [DIP_JUMP, '#000000'], [DIP_JUMP, '#ffffff']]],
    ['fill-opacity', [[P1, .46], [P1 + 200, 1, 'out'], [DIP_JUMP, 1], [DIP_JUMP, .46]]],
  ]);
  return box('n', 18) + box('w', 59) + `<clipPath id="${id}-c"><rect width="76" height="22" rx="11"/></clipPath>`
    + `<rect width="76" height="22" rx="11" fill="${W(.01)}"/><rect x=".5" y=".5" width="75" height="21" rx="10.5" fill="none" stroke="${W(.16)}"/>`
    + `<g clip-path="url(#${id}-c)">${background}<rect x="36" width="40" height="22" fill="${W(.06)}"/><rect x="35" width="1" height="22" fill="${W(.16)}"/></g>`
    + ring + needs
    + `<path d="M53.625 11A4.125 4.125 0 1 1 49.5 6.875" fill="none" stroke="${W(.7)}" stroke-width="1.833" stroke-linecap="round"/>`
    + `<g clip-path="url(#${id}-w)">${track(at(1), num(60, W(.7)), { kind: 'roll', roll: ROLL })}</g>`;
}

// Phone parts, in dp.
const statusIcons = x => `<g fill="${C.text}"><path d="M${x} 27.5l-6.5-6.5a9.2 9.2 0 0 1 13 0z"/><path d="M${x + 14} 28h9v-11z"/><rect x="${x + 28}" y="19" width="16" height="9" rx="2.2" fill="none" stroke="${C.text}" stroke-width="1.3"/><rect x="${x + 30}" y="21" width="10" height="5" rx="1"/><rect x="${x + 44.6}" y="21.8" width="1.6" height="3.4" rx=".8"/></g>`;
const badgeTrack = (index, draw) => track(BADGE_TIMES.map(t => [t, badge(t)[index]]), draw);
const NOTE_Y = [142, 262]; // the two notification places under the island fragment

function notification(title, id) {
  const [session, source] = SESSIONS[id];
  return `<rect width="360" height="112" rx="20" fill="${C.control}"/>` + icon('asb', 18, 14, 12, C.muted)
    + text(38, 24, 12, C.muted, `ASB · ${source} · now`) + text(18, 50, 14, C.text, title, BOLD) + text(18, 70, 14, C.text, session)
    + text(18, 98, 14, C.text, 'Open on PC', SEMI) + text(122, 98, 14, C.text, 'Read', SEMI);
}

function needsColumn() {
  const rest = { x: 128, width: 104, height: 26, rx: 13 }, big = { x: 8, width: 344, height: 112, rx: 28 };
  const isleKeys = name => HEADS_UP.flatMap(([r, d]) => [[r, rest[name]], [r + 300, big[name], 'outExpo'], [r + d - 250, big[name]], [r + d, rest[name], 'inOut']]);
  const isle = el('rect', { y: 9, fill: '#000' }, ['x', 'width', 'height', 'rx'].map(n => [n, isleKeys(n)]));
  const heads = HEADS_UP.map(([r, d, kind, title, id]) => g({}, icon(kind, 24, 34, 18, C.text) + text(50, 48, 15, C.text, title, BOLD)
    + text(334, 48, 12, C.muted, SESSIONS[id][1], END) + text(24, 73, 14, C.text, SESSIONS[id][0])
    + `<rect x="22" y="84" width="152" height="28" rx="14" fill="${C.control}"/><rect x="186" y="84" width="152" height="28" rx="14" fill="${C.control}"/>`
    + text(98, 103, 13, C.text, 'Open on PC', MID + SEMI) + text(262, 103, 13, C.text, 'Read', MID + SEMI),
  [['opacity', [[r + 150, 0], [r + 300, 1, 'out'], [r + d - 400, 1], [r + d - 250, 0, 'out']]]])).join('');
  const camera = `<circle cx="180" cy="22" r="5.5" fill="${C.ground}" stroke="${C.hairline}" stroke-width="1.2"/>`;
  const top = `0 ${number(NOTE_Y[0] - SLIDE)}`;
  // The Done card comes at R1, moves down at R2, and collapses at the tap; the question card comes once the Done card has made room.
  const done = g({}, g({}, g({}, notification('Done', 'D'), [['scale', [[TAP, '1 1'], [TAP + 250, '1 .6', 'inOut'], [DIP_JUMP, '1 .6'], [DIP_JUMP, '1 1']]]]),
    [['opacity', [[R1, 0], [R1 + 300, 1, 'outExpo'], [TAP, 1], [TAP + 250, 0, 'inOut']]]]),
  [['translate', [[R1, top], [R1 + 300, `0 ${NOTE_Y[0]}`, 'outExpo'], [R2, `0 ${NOTE_Y[0]}`], [R2 + 300, `0 ${NOTE_Y[1]}`, 'outExpo'],
    [DIP_JUMP, `0 ${NOTE_Y[1]}`], [DIP_JUMP, top]]]]);
  const input = g({}, notification('Needs your answer', 'U'), [
    ['opacity', [[R2 + 100, 0], [R2 + 400, 1, 'outExpo'], [RESET, 1], [DIP_OUT, 0, 'out']]],
    ['translate', [[R2 + 100, top], [R2 + 400, `0 ${NOTE_Y[0]}`, 'outExpo'], [DIP_JUMP, `0 ${NOTE_Y[0]}`], [DIP_JUMP, top]]],
  ]);
  return isle + heads + camera + done + input;
}
const needsSurface = () => `<path d="M0 132V38A38 38 0 0 1 38 0H322A38 38 0 0 1 360 38V132z" fill="#000" stroke="${C.hairline}"/><path d="M5 128V40A34 34 0 0 1 39 5H321A34 34 0 0 1 355 40V128z" fill="${C.window}"/>`
  + text(30, 27, 14, C.text, '10:02', SEMI) + statusIcons(282);

// The working column's status bar is the one place of the chip (Android 16, after the clock). Its crop ends at 127 dp,
// before the island of the needs column (x 128 dp), so the two crops never show the same place.
const LIVE_Y = 58, CHIP_X = 70, CROP_END = 127;
function workingColumn() {
  const chipWidth = t => badge(t)[1] === 'Done' ? 56 : 36;
  assert.ok(CHIP_X + 56 <= CROP_END, 'the whole chip fits in the crop');
  const pill = el('rect', { x: CHIP_X, y: 13, height: 24, rx: 12, fill: C.control },
    [['width', BADGE_TIMES.slice(1).flatMap(t => [[t, chipWidth(t - 1)], [t + 300, chipWidth(t), 'inOut']])]]);
  const chip = pill + badgeTrack(0, k => icon(k, CHIP_X + 4, 18, 14, C.text)) + badgeTrack(1, s => text(CHIP_X + 20, 29.5, 12, C.text, s, SEMI));
  // BigTextStyle: the card takes the height of its lines.
  const shrink = READS.map(([t, read]) => [t, 20 * (3 - liveLines(read).length)]);
  const keys = f => [...shrink.flatMap(([t, d], i) => i ? [[t, f(shrink[i - 1][1])], [t + 300, f(d), 'out']] : []),
    [DIP_IN, f(shrink.at(-1)[1])], [LOOP, f(0), 'out']];
  const card = el('rect', { y: LIVE_Y, width: 360, rx: 20, fill: C.control, stroke: C.hairline }, [['height', keys(d => 164 - d)]]);
  const stop = g({}, text(18, LIVE_Y + 146, 14, C.text, 'Stop', SEMI), [['translate', keys(d => `0 ${-d}`)]]);
  const head = badgeTrack(0, k => icon(k, 18, LIVE_Y + 14, 12, C.muted)) + text(36, LIVE_Y + 24, 12, C.muted, 'ASB');
  const title = track(READS.map(([t, read]) => [t, liveTitle(read)]), s => text(18, LIVE_Y + 50, 14, C.text, s, BOLD));
  const lines = [0, 1, 2].map(i => track(READS.map(([t, read]) => [t, liveLines(read)[i] ?? '']), s => text(18, LIVE_Y + 74 + i * 20, 13, C.text, s))).join('');
  return chip + card + head + title + lines + stop;
}
const workingSurface = () => `<path d="M0 46V38A38 38 0 0 1 38 0H${CROP_END}V46z" fill="#000" stroke="${C.hairline}"/><path d="M5 46V40A34 34 0 0 1 39 5H${CROP_END}V46z" fill="${C.window}"/>`
  + text(30, 30, 14, C.text, '10:02', SEMI);

// The diagram: the hub is the capsule at 3x; each column hangs under its segment.
const HUB = [366, 46], COL_X = [96, 540], COL_Y = 172;
const LEADERS = [
  { d: 'M418.5 112V136H258V172', up: 'M258 172V136H418.5V112', label: ['needs you = pending', 338.25, 131, MID] },
  { d: 'M534 112V136H702V172', label: ['working = working', 618, 131, MID] },
];
function pathLength(d) {
  let length = 0, x = 0, y = 0;
  for (const [, c, v] of d.matchAll(/([MVH])([\d.]+(?: [\d.]+)?)/g)) {
    const p = v.split(' ').map(Number);
    if (c === 'M') [x, y] = p; else if (c === 'V') length += Math.abs(p[0] - y), y = p[0]; else length += Math.abs(p[0] - x), x = p[0];
  }
  return length;
}
// One 2 px amber run per [start, fade]: a 400 ms draw from the path start, a hold, and a 300 ms fade.
function lit(d, runs) {
  const L = number(pathLength(d)), dash = [[0, L]], op = [[0, 0]];
  for (const [a, f] of runs) {
    dash.push([a, L], [a + 400, 0, 'outExpo'], [f + 300, 0], [f + 300, L]);
    op.push([a, 0], [a, 1], [f, 1], [f + 300, 0, 'inOut']);
  }
  return el('path', { d, fill: 'none', stroke: C.amber, 'stroke-width': 2, 'stroke-dasharray': `${L} ${L}` }, [['stroke-dashoffset', dash], ['opacity', op]]);
}
const column = (i, draw) => `<g transform="translate(${COL_X[i]} ${COL_Y}) scale(${S})">${draw()}</g>`;
const FINGER = [COL_X[0] + 140 * S, COL_Y + (NOTE_Y[1] + 93) * S].map(number);

function frame() {
  const bar = `<rect width="960" height="30" fill="#000"/><rect x="14" y="11" width="30" height="8" rx="4" fill="#fff"/><circle cx="54" cy="15" r="3.5" fill="rgba(255,255,255,.55)"/><circle cx="66" cy="15" r="3.5" fill="rgba(255,255,255,.55)"/>`
    + text(480, 20, 14, '#fff', 'Fri 10:02', MID + BOLD)
    + `<g fill="#fff"><path d="M896 21l-7-7a10 10 0 0 1 14 0z"/><path d="M911 11.5l3.5-3v13l-3.5-3h-2v-7z"/><rect x="925" y="10" width="17" height="10" rx="2.5" fill="none" stroke="#fff" stroke-width="1.4"/><rect x="927" y="12" width="11" height="6" rx="1"/></g>`;
  return `<rect width="960" height="540" fill="${C.ground}"/>${bar}`
    + `<path d="M796 26L${HUB[0]} ${HUB[1]}M872 26L${HUB[0] + 228} ${HUB[1]}" stroke="${C.hairline}" stroke-dasharray="3 3"/>`
    + LEADERS.map(({ d, label: [s, x, y, anchor] }) => `<path d="${d}" fill="none" stroke="${C.hairline}"/>` + text(x, y, 11, C.muted, s, `${anchor} class="mono"`)).join('')
    + column(0, needsSurface) + column(1, workingSurface)
    + text(16, 530, 11, C.muted, 'made-up sessions · illustrated');
}
function moving(mode) {
  still = mode === 'still';
  const id = still ? 'cap-s' : 'cap';
  let out = `<defs><g id="${id}">${capsule(id)}</g></defs><use href="#${id}" transform="translate(796 4)"/><use href="#${id}" transform="translate(${HUB[0]} ${HUB[1]}) scale(3)"/>`;
  if (!still) out += lit(LEADERS[0].d, [[P1, R1], [P2, R2], [P3, R3]]) + lit(LEADERS[0].up, [[TAP, P3]]) + lit(LEADERS[1].d, [[P1, R1], [P2, R2]]);
  out += column(0, needsColumn) + column(1, workingColumn);
  if (!still) {
    const [cx, cy] = FINGER;
    out += el('circle', { cx, cy, r: 14, fill: '#fff' }, [['opacity', [[TAP - 250, 0], [TAP, .22, 'out'], [TAP + 100, .22], [TAP + 350, 0, 'inOut']]]])
      + el('circle', { cx, cy, r: 14, fill: 'none', stroke: '#fff', 'stroke-width': 1.5 },
        [['r', [[TAP, 14], [TAP + 300, 22, 'outExpo'], [TAP + 301, 14]]], ['opacity', [[TAP, 0], [TAP, 1], [TAP + 300, 0, 'out']]]]);
  }
  return out;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="top-bar-phone-title" class="sans">
<title id="top-bar-phone-title">ASB: the GNOME top bar and the Android app show the same counts; the phone follows the PC, and Read on the phone clears the mark on the PC</title>
${css('text{font-variant-numeric:tabular-nums}')}
<defs>${SYMBOLS}</defs>
${frame()}
<g class="motion">${moving('motion')}</g>
<g class="still">${moving('still')}</g>
</svg>
`;
checkSvg(svg, 200000);
assert.ok(!svg.includes('undefined') && !svg.includes('NaN'));
const output = new URL('../docs/media/top-bar-phone.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`Wrote ${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
