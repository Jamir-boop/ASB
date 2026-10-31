import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timeline, css, escape, number, checkSvg } from './hero-smil.mjs';

// Made-up sessions. Thread order is the order of this table; 9 more Idle sessions count only in the total.
const SESSIONS = {
  U: ['uploader', 'Fix the flaky upload test', 'openai', 'Codex'],
  D: ['docs-site', 'Write the release notes for 2.4', 'claude', 'Claude Desktop Code'],
  I: ['infra', 'Rotate the staging certificates', 'openai', 'Codex'],
  A: ['atlas', 'Map the old config keys', 'claude', 'Claude Desktop Code'],
  P: ['parsers', 'Compare two parsers', 'opencode', 'OpenCode'],
};
const HIDDEN_IDLE = 9;

// The story (ms). P = the top bar changes; R = a read of the phone's live service.
const LOOP = 14000, P1 = 1200, R1 = 2500, P2 = 6000, R2 = 7500, TAP = 9700, P3 = 10900, R3 = 12500;
const FLASH_END = R1 + 8000, RESET = 13400, DIP_OUT = RESET + 250, DIP_JUMP = DIP_OUT + 50, DIP_IN = DIP_OUT + 100;
const HEADS_UP = [[R1, 2200, 'done', 'Done', 'D'], [R2, 2000, 'input', 'Needs your answer', 'U']];
const STILL_AT = 8000;
// The top bar: [time, needs you, working]; the total stays.
const BAR = [[0, 0, 3], [P1, 1, 2], [P2, 2, 1], [P3, 1, 1]];
// What each read sees: id -> [state, pending, seconds since the start (working) or the update, mark].
const IDLE = { A: ['idle', false, 3600, ''], P: ['idle', false, 7200, ''] };
const READS = [
  [0, { U: ['working', false, 125, ''], D: ['working', false, 250, ''], I: ['working', false, 460, ''], ...IDLE }],
  [R1, { U: ['working', false, 127, ''], D: ['idle', true, 0, 'dot'], I: ['working', false, 462, ''], ...IDLE }],
  [R2, { U: ['waiting', true, 0, '?'], D: ['idle', true, 5, 'dot'], I: ['working', false, 467, ''], ...IDLE }],
  [R3, { U: ['waiting', true, 0, '?'], D: ['idle', false, 10, ''], I: ['working', false, 472, ''], ...IDLE }],
];

const C = {
  ground: '#111113', window: '#242424', control: '#343434', text: '#f6f3ed', muted: '#b3b0aa', hairline: '#4a4844',
  amber: '#ffb900', green: '#8fce8a', flash: '#ffce4d', openai: '#c9ccd1', claude: '#d97757', opencode: '#7d848c',
};
const S = .82; // dp to px for every phone part
const SLIDE = 12 / S;

// Ports of the Android rules (ui/Format.kt, ui/Rules.kt, notify/LiveService.kt).
const durationText = s => s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
const idleAge = s => s < 60 ? 'Just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
const stateLabel = state => ({ working: 'Working', waiting: 'Waiting', idle: 'Idle' })[state];
const rows = read => Object.entries(read).map(([id, [state, pending, age, mark]]) => ({ id, state, pending, age, mark }));
function order(read) {
  const bucket = r => r.pending ? 0 : r.state === 'working' ? 1 : 2;
  // Newest start or update first: the smaller age is the newer moment.
  return rows(read).sort((a, b) => bucket(a) - bucket(b) || (a.state !== 'working') - (b.state !== 'working') || a.age - b.age).map(r => r.id);
}
const counts = read => [rows(read).filter(r => r.pending).length, rows(read).filter(r => r.state === 'working').length];
const liveTitle = read => `${counts(read)[0]} pending · ${counts(read)[1]} working · ${rows(read).length + HIDDEN_IDLE} sessions`;
const liveLines = read => rows(read).filter(r => r.state === 'working').map(r => SESSIONS[r.id][1]);
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
assert.deepEqual(READS.map(([, read]) => order(read).slice(0, 3).join('')), ['UDI', 'DUI', 'UDI', 'UID']);
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
// dip 'fade': the reset dip; 'cut': a parent group fades, so the place changes while hidden.
function track(changes, draw, { kind = 'swap', roll = 0, dip = 'fade', arrive = 'slide' } = {}) {
  const list = changes.filter(([, v], i) => !i || v !== changes[i - 1][1]);
  const segs = list.map(([a, v], i) => ({ v, a, b: list[i + 1]?.[0] ?? RESET }));
  const first = segs[0].v, last = segs.at(-1);
  if (last.v === first) last.b = LOOP;
  else { last.dip = true; segs.push({ v: first, a: DIP_IN, b: LOOP, back: true }); }
  const cut = dip === 'cut';
  return [...new Set(segs.map(s => s.v))].filter(v => v !== '').map(v => {
    const spans = segs.map((s, i) => ({ ...s, prev: segs[i - 1]?.v })).filter(s => s.v === v).map(s => {
      let enter = null, exit = null;
      if (s.back) enter = cut ? { t0: DIP_JUMP, t1: DIP_JUMP } : { t0: DIP_IN, t1: LOOP, ease: 'out' };
      else if (s.a > 0) enter = kind === 'roll' ? { t0: s.a, t1: s.a + 220, dy: roll, ease: 'outExpo' }
        : s.prev ? { t0: s.a + 150, t1: s.a + 300, ease: 'out' }
        : { t0: s.a, t1: s.a + 300, dy: arrive === 'slide' ? -SLIDE : 0, ease: 'outExpo' };
      if (s.dip) exit = cut ? { t0: DIP_JUMP, t1: DIP_JUMP } : { t0: RESET, t1: DIP_OUT, ease: 'out' };
      else if (s.b < LOOP) exit = kind === 'roll' ? { t0: s.b, t1: s.b + 220, dy: -roll, ease: 'outExpo' } : { t0: s.b, t1: s.b + 150, ease: 'out' };
      return { in: enter, out: exit };
    });
    if (spans.length === 1 && !spans[0].in && !spans[0].out) return draw(v);
    return g({}, draw(v), life(spans));
  }).join('');
}

// Icons: the Android vector path data (res/drawable), and the chat mark of the extension.
const SYMBOLS = `<symbol id="i-done" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"><path stroke-width="2" d="M12,2.5A9.5,9.5 0,1 1,12,21.5A9.5,9.5 0,1 1,12,2.5Z"/><path stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M7.6,12.4L10.6,15.4L16.4,9.2"/></g></symbol>`
  + `<symbol id="i-input" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"><path stroke-width="2" d="M12,2.5A9.5,9.5 0,1 1,12,21.5A9.5,9.5 0,1 1,12,2.5Z"/><path stroke-width="2.2" stroke-linecap="round" d="M9.2,9.3A2.9,2.9 0,1 1,13.8,11.6C12.7,12.4 12,12.9 12,14.5"/></g><path fill="currentColor" d="M12,16.6A1.25,1.25 0,1 1,12,19.1A1.25,1.25 0,1 1,12,16.6Z"/></symbol>`
  + `<symbol id="i-working" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M12,3.5A8.5,8.5 0,1 1,3.5,12"/></symbol>`
  + `<symbol id="i-asb" viewBox="0 0 64 64"><path fill="currentColor" fill-rule="evenodd" d="M32,2A30,30 0,1 1,32,62A30,30 0,1 1,32,2ZM32,23.5A8.5,8.5 0,1 1,32,40.5A8.5,8.5 0,1 1,32,23.5Z"/></symbol>`
  + `<symbol id="i-openai" viewBox="0 0 24 24"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></symbol>`
  + `<symbol id="i-claude" viewBox="0 0 24 24"><path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></symbol>`
  + `<symbol id="i-opencode" viewBox="0 0 256 320"><path fill="currentColor" fill-rule="evenodd" d="M256 320H0V0H256V320ZM192 64H64V256H192V64Z"/><path fill="currentColor" fill-opacity=".5" d="M192 128V256H64V128H192Z"/></symbol>`;
const icon = (name, x, y, size, color, width = size) => `<use href="#i-${name}" x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${size}" color="${color}"/>`;
const CHAT = 'M3.5 2.4h9a2.1 2.1 0 0 1 2.1 2.1V10a2.1 2.1 0 0 1-2.1 2.1H7.41l-2.54 1.97A.6.6 0 0 1 3.9 13.6v-1.5h-.4A2.1 2.1 0 0 1 1.4 10V4.5a2.1 2.1 0 0 1 2.1-2.1zm0 1.2a.9.9 0 0 0-.9.9V10a.9.9 0 0 0 .9.9h1.6v1.47l1.89-1.47h5.51a.9.9 0 0 0 .9-.9V4.5a.9.9 0 0 0-.9-.9z';

// The capsule of gnome-shell/stylesheet.css, 127 x 22 px: Needs you 0-35, line, Working 36-76, line, Total 77-127.
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
  return box('n', 18) + box('w', 59) + `<clipPath id="${id}-c"><rect width="127" height="22" rx="11"/></clipPath>`
    + `<rect width="127" height="22" rx="11" fill="${W(.01)}"/><rect x=".5" y=".5" width="126" height="21" rx="10.5" fill="none" stroke="${W(.16)}"/>`
    + `<g clip-path="url(#${id}-c)">${background}<rect x="36" width="40" height="22" fill="${W(.06)}"/><rect x="35" width="1" height="22" fill="${W(.16)}"/><rect x="76" width="1" height="22" fill="${W(.16)}"/></g>`
    + ring + needs
    + `<path d="M53.625 11A4.125 4.125 0 1 1 49.5 6.875" fill="none" stroke="${W(.7)}" stroke-width="1.833" stroke-linecap="round"/>`
    + `<g clip-path="url(#${id}-w)">${track(at(1), num(60, W(.7)), { kind: 'roll', roll: ROLL })}</g>`
    + `<path transform="translate(85 4.5) scale(.8125)" fill-rule="evenodd" fill="${W(.55)}" d="${CHAT}"/>`
    + text(103, 16, 14, W(.55), String(rows(READS[0][1]).length + HIDDEN_IDLE), BOLD);
}

// Phone parts, in dp.
const statusIcons = x => `<g fill="${C.text}"><path d="M${x} 27.5l-6.5-6.5a9.2 9.2 0 0 1 13 0z"/><path d="M${x + 14} 28h9v-11z"/><rect x="${x + 28}" y="19" width="16" height="9" rx="2.2" fill="none" stroke="${C.text}" stroke-width="1.3"/><rect x="${x + 30}" y="21" width="10" height="5" rx="1"/><rect x="${x + 44.6}" y="21.8" width="1.6" height="3.4" rx=".8"/></g>`;
const badgeTrack = (index, draw) => track(BADGE_TIMES.map(t => [t, badge(t)[index]]), draw);
const NOTE_Y = [142, 262]; // the two notification places under the island fragment

function notification(title, id) {
  const [, session, , source] = SESSIONS[id];
  return `<rect width="360" height="112" rx="20" fill="${C.control}"/>` + icon('asb', 18, 14, 12, C.muted)
    + text(38, 24, 12, C.muted, `ASB · ${source} · now`) + text(18, 50, 14, C.text, title, BOLD) + text(18, 70, 14, C.text, session)
    + text(18, 98, 14, C.text, 'Open on PC', SEMI) + text(122, 98, 14, C.text, 'Read', SEMI);
}

function needsColumn() {
  const rest = { x: 128, width: 104, height: 26, rx: 13 }, big = { x: 8, width: 344, height: 112, rx: 28 };
  const isleKeys = name => HEADS_UP.flatMap(([r, d]) => [[r, rest[name]], [r + 300, big[name], 'outExpo'], [r + d - 250, big[name]], [r + d, rest[name], 'inOut']]);
  const isle = el('rect', { y: 9, fill: '#000' }, ['x', 'width', 'height', 'rx'].map(n => [n, isleKeys(n)]));
  const heads = HEADS_UP.map(([r, d, kind, title, id]) => g({}, icon(kind, 24, 34, 18, C.text) + text(50, 48, 15, C.text, title, BOLD)
    + text(334, 48, 12, C.muted, SESSIONS[id][3], END) + text(24, 73, 14, C.text, SESSIONS[id][1])
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

// The Comfortable list: 68 dp cards (SessionCard), 8 dp apart, under the portrait top bar.
const LIST_Y = 60, PITCH = 76, CARD = 68;
const slotY = i => LIST_Y + i * PITCH;
const W_SPRING = Math.sqrt(360);
const spring = p => p >= 1 ? 1 : 1 - (1 + W_SPRING * p * .5) * Math.exp(-W_SPRING * p * .5);
function sessionRow(id) {
  const [folder, title, provider] = SESSIONS[id];
  const slots = READS.map(([t, read]) => [t, order(read).indexOf(id)]);
  const back = slots.at(-1)[1] !== slots[0][1];
  const footer = (index, draw) => track(READS.map(([t, read]) => {
    const [state, pending, age, mark] = read[id];
    const color = state === 'working' ? C.green : pending ? C.text : C.muted;
    return [t, [`${stateLabel(state)}|${color}`, state === 'working' ? durationText(age) : idleAge(age), mark][index]];
  }), draw, { dip: back ? 'cut' : 'fade', arrive: 'fade' });
  const inner = icon(provider, 8, 2, 14, C[provider], provider === 'opencode' ? 11.2 : 14) + text(29, 13, 11, C.muted, folder) + text(29, 30, 13, C.text, title)
    + footer(0, v => text(29, 63, 11, v.split('|')[1], v.split('|')[0])) + footer(1, v => text(352, 63, 11, C.muted, v, END))
    + footer(2, v => v === 'dot' ? `<circle cx="317" cy="14" r="3.5" fill="${C.amber}"/>` : text(317, 18, 11, C.amber, '?', MID + ' font-weight="800"'));
  const keys = [[0, `0 ${slotY(slots[0][1])}`]];
  slots.forEach(([t, s], i) => {
    if (!i || s === slots[i - 1][1]) return;
    const from = slotY(slots[i - 1][1]), to = slotY(s);
    keys.push(...tl.sampled(t, 500, p => `0 ${number(from + (to - from) * spring(p))}`));
  });
  if (keys.length === 1) return `<g transform="translate(${keys[0][1]})">${inner}</g>`;
  // A moving row is an opaque card over its gap, so two rows that cross never show text over text.
  const card = `<rect x="1" width="358" height="${PITCH}" fill="${C.window}"/>` + inner;
  if (back) keys.push([DIP_JUMP, keys.at(-1)[1]], [DIP_JUMP, keys[0][1]]);
  const fade = back ? [['opacity', [[RESET, 1], [DIP_OUT, 0, 'out'], [DIP_IN, 0], [LOOP, 1, 'out']]]] : [];
  return g({}, g({}, card, fade), [['translate', keys]]);
}
// The row that moves up paints over the row that moves down: docs-site goes on top only for its move at R1.
const totalColumn = () => g({}, sessionRow('D'), [['opacity', [[R1, 1], [R1, 0], [R1 + 500, 0], [R1 + 500, 1]]]])
  + ['U', 'I', 'A', 'P'].map(sessionRow).join('') + g({}, sessionRow('D'), [['opacity', [[R1, 0], [R1, 1], [R1 + 500, 1], [R1 + 500, 0]]]]);
function totalSurface() {
  const pill = (x, w, s) => `<rect x="${x}" y="14" width="${w}" height="28" rx="14" fill="none" stroke="${C.hairline}"/>` + text(x + w / 2, 32, 12, C.muted, s, MID);
  return `<rect width="360" height="${LIST_Y + 4 * PITCH + CARD + 4}" rx="16" fill="${C.window}" stroke="${C.hairline}"/>`
    + icon('asb', 12, 16, 24, C.amber) + `<circle cx="32.5" cy="36.5" r="6.5" fill="${C.window}"/><circle cx="32.5" cy="36.5" r="4.5" fill="${C.green}"/>`
    + pill(48, 64, 'Pending') + pill(118, 66, 'Working') + pill(190, 60, 'Drawer')
    + `<circle cx="283" cy="27" r="6" fill="none" stroke="${C.text}" stroke-width="2"/><path d="M287.5 31.5l5 5" stroke="${C.text}" stroke-width="2" stroke-linecap="round"/>`
    + `<g fill="${C.text}"><circle cx="334" cy="21" r="2"/><circle cx="334" cy="28" r="2"/><circle cx="334" cy="35" r="2"/></g><rect x="1" y="54" width="358" height="1" fill="${C.hairline}"/>`;
}

// The diagram: the hub is the capsule at 3x; each column hangs under its segment.
const HUB = [312, 46], COL_X = [16, 332.4, 648.8], COL_Y = 172;
const LEADERS = [
  { d: 'M364.5 112V136H163.6V172', up: 'M163.6 172V136H364.5V112', label: ['needs you = pending', 264, 131, MID] },
  { d: 'M480 112V172', label: ['working = working', 487, 147, ''] },
  { d: 'M618 112V136H796.4V172', label: ['total = sessions', 707, 131, MID] },
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
    + `<path d="M745 26L${HUB[0]} ${HUB[1]}M872 26L${HUB[0] + 381} ${HUB[1]}" stroke="${C.hairline}" stroke-dasharray="3 3"/>`
    + LEADERS.map(({ d, label: [s, x, y, anchor] }) => `<path d="${d}" fill="none" stroke="${C.hairline}"/>` + text(x, y, 11, C.muted, s, `${anchor} class="mono"`)).join('')
    + column(0, needsSurface) + column(1, workingSurface) + column(2, totalSurface)
    + text(16, 530, 11, C.muted, 'made-up sessions · illustrated');
}
function moving(mode) {
  still = mode === 'still';
  const id = still ? 'cap-s' : 'cap';
  let out = `<defs><g id="${id}">${capsule(id)}</g></defs><use href="#${id}" transform="translate(745 4)"/><use href="#${id}" transform="translate(${HUB[0]} ${HUB[1]}) scale(3)"/>`;
  if (!still) out += lit(LEADERS[0].d, [[P1, R1], [P2, R2], [P3, R3]]) + lit(LEADERS[0].up, [[TAP, P3]]) + lit(LEADERS[1].d, [[P1, R1], [P2, R2]]);
  out += column(0, needsColumn) + column(1, workingColumn) + column(2, totalColumn);
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
