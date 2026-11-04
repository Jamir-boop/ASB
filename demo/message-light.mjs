import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const symbols = `<symbol id="p-codex" viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></symbol><symbol id="p-claude" viewBox="0 0 24 24"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></symbol>`;
const samples = [
  ['tools-api', 'Plan the release of the import job', 'codex', 'idle', 1, 0, '4m ago'],
  ['field-notes', 'Summarize the open issues into one short note', 'claude', 'idle', 1, 0, '12m ago'],
  ['docs-site', 'Write the release notes for 2.4', 'codex', 'idle', 1, 0, '31m ago'],
  ['importer', 'Compare two parsers for the import step', 'claude', 'working', 0, 0, '6m02s'],
  ['billing', 'Coordinate the retry work across the services', 'codex', 'working', 0, 0, '2m14s'],
  ['infra', 'Draft the migration plan for the queue', 'claude', 'working', 0, 1, '48s'],
  ['web-app', 'Review the flaky test in CI', 'codex', 'idle', 0, 0, '1h ago'],
  ['tools-api', 'Rename the config keys', 'claude', 'idle', 0, 0, '2h ago'],
  ['docs-site', 'Explain the cache warmup', 'codex', 'idle', 0, 0, '3h ago'],
  ['billing', 'Check the retry limits in the billing worker', 'claude', 'working', 0, 0, '1m30s'],
  ['importer', 'Sketch the CSV error report', 'codex', 'idle', 0, 0, '5h ago'],
  ['field-notes', 'List the unused feature flags', 'claude', 'idle', 0, 0, '6h ago'],
];
const loop = 14000;
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
  return `<${element} attributeName="${attribute}" dur="${loop / 1000}s" repeatCount="indefinite" calcMode="${discrete ? 'discrete' : 'linear'}" keyTimes="${keyTimes.join(';')}" values="${values.join(';')}"/>`;
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
// Discrete 60 fps samples, held before and after; a sample equal to the one before adds no key.
function stepped(attribute, times, values, transform = false) {
  const keep = values.map((value, i) => !i || value !== values[i - 1]);
  const kept = values.filter((_, i) => keep[i]);
  return animation(attribute, [0, ...times.filter((_, i) => keep[i]), loop], [kept[0], ...kept, kept.at(-1)], true, transform);
}
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
  const muted = quiet ? '#8f8f8f' : '#bcbcbc';
  cards += icon(i, '#a5a5a5', .9) + `<g transform="translate(${x} ${y})">`;
  cards += text(29, 9, folder, 11, muted);
  titleLines(title).forEach((line, row) => { cards += text(29, 24.5 + 15 * row, line, 13, quiet ? '#ababab' : '#fff'); });
  cards += text(29, 56, state === 'working' ? 'Working' : 'Idle', 11, unread ? '#fff' : state === 'working' ? accent : muted);
  cards += text(221, 56, age, 11, muted, ' text-anchor="end"');
  // A question is an accent disc with no plate at rest; the dot rests on its 8% plate.
  if (question) cards += `<circle cx="191" cy="14" r="8" fill="${accent}"/>` + text(191, 14, '?', 11, '#000000', ' text-anchor="middle" font-weight="800"');
  else if (unread) cards += `<circle cx="191" cy="14" r="12" fill="rgb(255 255 255 / .08)"/><circle cx="191" cy="14" r="3.5" fill="${accent}"/>`;
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

// Pet round: a port of the pet code of scripts/asb-native.py (parse_pets, pet_plan, pet_pose, pet_box, pet_envelope,
// pet_particles, pet_tints) at the Comfortable scale 2.
const PET_FRAMES = ['stand', 'walk1', 'walk2', 'walk3', 'walk4', 'crouch', 'air', 'air2', 'toss', 'release'];
const scale = 2;
const petData = JSON.parse(await readFile(new URL('../assets/pets/pets.json', import.meta.url), 'utf8'));

function petRuns(grid, palette, accentKey = false) {
  const runs = [];
  grid.forEach((row, y) => {
    for (let x = 0, end; x < row.length; x = end) {
      for (end = x; end < row.length && row[end] === row[x]; end++);
      if (row[x] !== '.') runs.push([accentKey && row[x] === 'A' ? null : palette[row[x]], x, y, end - x]);
    }
  });
  return runs;
}
// Like parse_pets, but each frame keeps its paint layers, so a symbol can have one path per color and layer.
const letter = petData.envelope;
const envelopeRuns = petRuns(letter.grid, letter.palette, true);
const pets = {};
for (const name of ['crab', 'pigeon', 'cat']) {
  const item = petData.pets[name], { width, height, palette, mirror, envelopeFront: front } = item;
  const frames = {};
  for (const frame of PET_FRAMES) {
    const value = item.frames[frame], grid = value.grid;
    assert.equal(grid.length, height, `the ${name} ${frame} has ${height} rows`);
    const right = petRuns(grid, palette), left = right.map(([color, x, y, length]) => [color, width - x - length, y, length]);
    let layers = [[right], [left]], hold = null;
    if (value.envelope !== null) {
      const [ex, ey] = value.envelope;
      hold = [[ex, ey], mirror ? [width - 8 - ex, ey] : [ex, ey]];
      const letters = [0, 1].map(side => envelopeRuns.map(([color, x, y, length]) => [color, hold[side][0] + x, ey + y, length]));
      layers = front
        ? [[right, letters[0], value.over.map(([x, y]) => [palette[grid[y][x]], x, y, 1])],
          [left, letters[1], value.over.map(([x, y]) => [palette[grid[y][x]], width - 1 - x, y, 1])]]
        : [[letters[0], right], [letters[1], left]];
    }
    frames[frame] = { runs: [layers[0], mirror ? layers[1] : layers[0]], envelope: hold };
  }
  pets[name] = { width, height, anchor: item.anchor, mirror, walkFps: item.walkFps, reach: width - item.anchor[0], frames };
}

const sign = v => (v > 0) - (v < 0);
const petRound = v => Math.floor(v + .5);
const petStop = (pet, receiverX, direction) => receiverX - direction * (scale > 1 ? 12 : 12 + pet.reach);
const petWalkMs = distance => distance ? distance / Math.max(Math.min(300, Math.max(120, distance / 1.1)), distance / 2) * 1000 : 0;
function petJumpY(y0, y1, height, u) {
  const top = Math.min(y0, y1) - height, a = y0 - top;
  const k = (y1 - y0) + 2 * a + 2 * Math.sqrt(a * (y1 - top));
  return y0 + (y1 - y0) * u - k * u * (1 - u);
}
function petPlan(pet, [sx, , fs], [rx, , fr]) {
  const direction = sign(rx - sx) || -1, stop = petStop(pet, rx, direction), sameRow = Math.abs(fr - fs) < 1;
  const steps = [['rise', 380]];
  if (sameRow) steps.push(['walk', petWalkMs(Math.abs(stop - sx))]);
  else {
    if (Math.abs(stop - sx) > 14 * scale) steps.push(['walk', petWalkMs(Math.abs(stop - sign(stop - sx) * 14 * scale - sx))]);
    steps.push(['crouch', 80], ['jump', Math.min(620, Math.max(300, 260 + .5 * Math.abs(fr - fs)))], ['land', 80]);
  }
  steps.push(['windup', 120], ['toss', 240], ['hop', 160], ['dive', 320]);
  const phases = [];
  let t = 0;
  for (const [name, duration] of steps) if (duration > 0) { phases.push([name, t, t + duration]); t += duration; }
  return { direction, sameRow, phases, ta: phases.find(([name]) => name === 'toss')[2], end: t + 200 };
}
function petPose(pet, plan, t, [sx, , fs], [rx, , fr]) {
  const phase = plan.phases.find(([, start, end]) => start <= t && t < end);
  if (!phase) return null;
  const [name, start, end] = phase, lt = t - start, u = lt / (end - start), d = plan.direction;
  const stop = petStop(pet, rx, d);
  const jx = Math.abs(stop - sx) > 14 * scale ? stop - sign(stop - sx) * 14 * scale : sx;
  const first = sign(stop - sx) || d, jumpFace = sign(stop - jx) || d, h = pet.height;
  if (name === 'rise') {
    const back = 1 + 2.4 * (u - 1) ** 3 + 1.4 * (u - 1) ** 2;
    return { frame: u < .7 ? 'air' : 'stand', x: sx, y: fs + h * scale * (1 - back), face: first, clip: fs };
  }
  if (name === 'walk') {
    const x1 = plan.sameRow ? stop : jx;
    return { frame: ['walk1', 'walk2', 'walk3', 'walk4'][Math.floor(lt * pet.walkFps / 1000) % 4], x: sx + (x1 - sx) * u, y: fs, face: first, clip: null };
  }
  if (name === 'crouch') return { frame: 'crouch', x: jx, y: fs, face: jumpFace, clip: null };
  if (name === 'jump') {
    const height = Math.max(0, Math.min(9 * scale, Math.min(fs, fr) - h * scale - 2));
    return { frame: Math.floor(lt / 90) % 2 ? 'air2' : 'air', x: jx + (stop - jx) * u, y: petJumpY(fs, fr, height, u), face: jumpFace, clip: null };
  }
  const [frame, y, clip] = {
    land: ['crouch', fr, null], windup: ['toss', fr, null], toss: ['release', fr, null],
    hop: ['release', fr - 4 * scale * Math.sin(Math.PI * u), null], dive: ['release', fr + h * scale * u ** 3, fr],
  }[name];
  return { frame, x: stop, y, face: d, clip };
}
function petBox(pet, frame, x, y, face) {
  const flip = pet.mirror && face < 0, ax = flip ? pet.width - pet.anchor[0] : pet.anchor[0];
  return [pet.frames[frame].runs[flip ? 1 : 0], petRound(x - ax * scale), petRound(y - pet.height * scale), flip];
}
function petEnvelope(pet, plan, t, [rx, ry, fr]) {
  const [, start, end] = plan.phases.find(([name]) => name === 'toss');
  if (!(start <= t && t < end)) return null;
  const d = plan.direction;
  const [, left, top, flip] = petBox(pet, 'toss', petStop(pet, rx, d), fr, d);
  const [ex, ey] = pet.frames.toss.envelope[flip ? 1 : 0];
  const x0 = left + ex * scale, y0 = top + ey * scale, x1 = rx - 4 * scale, y1 = ry - 3 * scale;
  const cx = (x0 + x1) / 2, cy = Math.min(y0, y1) - 9 * scale;
  const p = 1 - (1 - (t - start) / (end - start)) ** 2, q = 1 - p;
  return [petRound(q * q * x0 + 2 * q * p * cx + p * p * x1), petRound(q * q * y0 + 2 * q * p * cy + p * p * y1)];
}
const petBursts = (pet, plan, [sx, , fs], [rx, ry, fr]) => {
  const ground = [200, 250, 290, 340], dive = plan.phases.find(([name]) => name === 'dive')[1];
  return [[sx, fs - 1, 0, ground], [rx, ry, plan.ta, [0, 45, 90, 135, 180, 225, 270, 315]], [petStop(pet, rx, plan.direction), fr - 1, dive, ground]];
};
// One burst of pet_particles: the (x, y, alpha) of its 2 × 2 px particles at t, or none.
function petBurst([cx, cy, start, angles], t) {
  const v = (t - start) / 360;
  if (!(0 <= v && v < 1)) return [];
  const radius = (5 + 11 * (1 - (1 - v) ** 3)) * scale / 2, alpha = v < .5 ? 1 : 1 - (v - .5) / .5;
  return angles.map(angle => [petRound(cx + radius * Math.cos(angle * Math.PI / 180) - 1), petRound(cy + radius * Math.sin(angle * Math.PI / 180) - 1), alpha]);
}
const petParticles = (pet, plan, t, sender, receiver) => petBursts(pet, plan, sender, receiver).flatMap(burst => petBurst(burst, t));
function petTints(plan, t) {
  const tints = {};
  for (const [index, start, end] of [[0, 0, 520], [1, plan.ta - 120, plan.end]]) {
    if (start <= t && t < end) {
      const alpha = Math.max(0, Math.min(1, (t - start) / 120, (end - t) / 240));
      if (alpha > 0) tints[index] = alpha;
    }
  }
  return tints;
}

// The row box of a card: the provider icon is 8 px into it (content margin 8) and its center 9 px below its top,
// as in the GTK geometry of demo/hero-board.json, so the box starts at origin(i). The age ends 12 px before its right edge.
const rowBox = i => [...origin(i), 233, 68];
const ends = i => [...endpoint(i), rowBox(i)[1] + rowBox(i)[3]];
const runPath = runs => runs.map(([, x, y, w]) => `M${x * scale} ${y * scale}h${w * scale}v${scale}h-${w * scale}z`).join('');
function paint(layers) {
  let out = '';
  for (const runs of layers) {
    const colors = [...new Set(runs.map(([color]) => color))];
    for (const color of colors) out += `<path fill="${color ?? accent}" d="${runPath(runs.filter(run => run[0] === color))}"/>`;
  }
  return out;
}
const pets3 = [['crab', 6200, 5, 2], ['pigeon', 7700, 7, 3], ['cat', 9300, 10, 11]];
let petDefs = `<symbol id="pet-envelope" overflow="visible">${paint([envelopeRuns])}</symbol>`, tints = '';
const plans = [];
for (const [name, start, from, to] of pets3) {
  const pet = pets[name], sender = ends(from), receiver = ends(to), plan = petPlan(pet, sender, receiver);
  plans.push([name, start, plan]);
  assert.ok(start + plan.end <= loop - 600, `the ${name} ends 600 ms before the loop ends`);
  const last = plan.phases.at(-1)[2];
  // Tints under the cards, and the lit icons, as snapshot_tints and light_row paint them.
  for (const [index, a, b] of [[0, 0, 520], [1, plan.ta - 120, plan.end]]) {
    const [x, y, w, h] = rowBox([from, to][index]);
    assert.equal(petTints(plan, a + 120)[index], 1);
    tints += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${accent}" opacity="0">${animation('opacity', [0, start + a, start + a + 120, start + b - 240, start + b, loop], [0, 0, .15, .15, 0, 0])}</rect>`;
  }
  motion += `<g visibility="hidden">${visible(start, start + 400)}${icon(from, accent)}</g>`;
  motion += `<g visibility="hidden">${visible(start + plan.ta, start + plan.ta + 360)}${icon(to, accent)}</g>`;
  // The pet: one symbol per used frame, a discrete position at 60 fps, and the floor clip of rise and dive.
  const times = sampled(0, last), poses = times.map(t => petPose(pet, plan, t, sender, receiver));
  assert.equal(poses.at(-1), null);
  const first = poses[0], final = poses.at(-2);
  assert.ok(first.clip === sender[2] && first.x === sender[0], `the ${name} starts on its sender floor`);
  assert.ok(final.clip === receiver[2] && final.x === petStop(pet, receiver[0], plan.direction), `the ${name} ends on its receiver floor`);
  const boxes = poses.slice(0, -1).map(pose => petBox(pet, pose.frame, pose.x, pose.y, pose.face));
  assert.ok(boxes.every(([, left, top]) => Number.isInteger(left) && Number.isInteger(top)), 'every pet position is an integer');
  assert.ok(poses.slice(0, -1).every(pose => PET_FRAMES.includes(pose.frame)), 'every pet frame is in PET_FRAMES');
  const keys = poses.slice(0, -1).map((pose, k) => `${name}-${pose.frame}${boxes[k][3] ? '-l' : ''}`);
  const at = times.map(t => start + t);
  let uses = '';
  for (const key of new Set(keys)) {
    const k = keys.indexOf(key), [runs] = boxes[k];
    petDefs += `<symbol id="${key}" overflow="visible">${paint(runs)}</symbol>`;
    const changes = [], shown = [];
    keys.forEach((value, j) => { if (!j || value !== keys[j - 1]) { changes.push(at[j]); shown.push(value === key ? 'visible' : 'hidden'); } });
    uses += `<use href="#${key}" visibility="hidden">${animation('visibility', [0, ...changes, at.at(-1), loop], ['hidden', ...shown, 'hidden', 'hidden'], true)}</use>`;
  }
  const places = boxes.map(([, left, top]) => `${left} ${top}`);
  const clips = [...poses.slice(0, -1).map(pose => pose.clip ?? 212), 212];
  motion += `<clipPath id="floor-${name}"><rect width="960" height="212">${stepped('height', at, clips)}</rect></clipPath>`;
  motion += `<g clip-path="url(#floor-${name})"><g>${stepped('transform', at.slice(0, -1), places, true)}${uses}</g></g>`;
  // The envelope in the toss.
  const [, tossStart, tossEnd] = plan.phases.find(([phase]) => phase === 'toss');
  const tossTimes = sampled(tossStart, tossEnd - tossStart), letters = tossTimes.slice(0, -1).map(t => petEnvelope(pet, plan, t, receiver));
  assert.equal(petEnvelope(pet, plan, tossEnd, receiver), null);
  assert.ok(letters.every(place => place.every(Number.isInteger)), 'every envelope position is an integer');
  const letterPlaces = letters.map(place => place.join(' '));
  motion += `<use href="#pet-envelope" visibility="hidden">${visible(start + tossStart, start + tossEnd)}${stepped('transform', tossTimes.slice(0, -1).map(t => start + t), letterPlaces, true)}</use>`;
  // The particles: one group for each 360 ms burst.
  for (const burst of petBursts(pet, plan, sender, receiver)) {
    const [, , burstStart, angles] = burst, burstTimes = sampled(burstStart, 360).slice(0, -1), frames = burstTimes.map(t => petBurst(burst, t));
    assert.ok(frames.every(list => list.length === angles.length), 'a burst shows all its particles for 360 ms');
    assert.ok(frames.every(list => list.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y))), 'every particle position is an integer');
    const burstAt = burstTimes.map(t => start + t);
    motion += `<g visibility="hidden">${visible(start + burstStart, start + burstStart + 360)}${stepped('opacity', burstAt, frames.map(list => number(list[0][2])))}`;
    angles.forEach((angle, p) => {
      const places = frames.map(list => `${list[p][0]} ${list[p][1]}`);
      motion += `<rect width="2" height="2" fill="${accent}">${stepped('transform', burstAt, places, true)}</rect>`;
    });
    motion += '</g>';
  }
}
console.log(plans.map(([name, start, plan]) => `${name} ${start}: ${plan.phases.map(([phase, a, b]) => `${phase} ${number(a)}-${number(b)}`).join(', ')}; ta ${number(plan.ta)}, end ${number(plan.end)} (at ${number(start + plan.end)})`).join('\n'));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="962" height="252" viewBox="0 0 962 252" role="img" aria-labelledby="board-title">
<title id="board-title">ASB board: one session sends a message to three sessions, and each one answers. Then a crab, a pigeon, and a cat each carry a message.</title>
<style>text{font-family:'Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace}@media (prefers-reduced-motion:reduce){#motion,#tints{display:none}}</style>
<defs>${symbols}${petDefs}<radialGradient id="disc" cx="35%" cy="30%" r="95.5%"><stop offset="0" stop-color="#f3e6c4"/><stop offset=".6" stop-color="#a8905a"/><stop offset="1" stop-color="#5c4b28"/></radialGradient><clipPath id="strip"><rect width="960" height="212"/></clipPath></defs>
<rect x=".5" y=".5" width="961" height="251" rx="8.5" fill="#000" stroke="#2c2c2c"/>
${toolbar}
<g transform="translate(1 39)" clip-path="url(#strip)"><g id="tints">${tints}</g>${cards}<g id="motion">${motion}</g></g>
</svg>
`;
assert.ok(!/<script|foreignObject|<image|\son[a-z]+=/i.test(svg), 'no script, foreign object, image, or event attribute');
assert.ok(!svg.replace('http://www.w3.org/2000/svg', '').includes('http'), 'no URL other than the SVG namespace');
assert.ok(Buffer.byteLength(svg) <= 200000, 'the SVG fits in 200 KB');
const output = new URL('../docs/media/board-message-light.svg', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, svg);
console.log(`Wrote ${fileURLToPath(output)} (${Buffer.byteLength(svg)} bytes)`);
