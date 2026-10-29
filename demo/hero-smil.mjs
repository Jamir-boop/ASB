// SMIL helpers for the README hero animation (demo/hero-*.mjs). No packages; every animation repeats each loop.
import assert from 'node:assert/strict';

export const FONT_MONO = "'Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace";
export const FONT_SANS = "system-ui,-apple-system,'Segoe UI',Cantarell,'Noto Sans',Ubuntu,Roboto,sans-serif";

// keySplines control points (x1 y1 x2 y2) of the easings that the hero uses.
export const EASE = {
  linear: '0 0 1 1',
  inOut: '.65 0 .35 1', // ease-in-out cubic: camera, pointer, and window moves
  out: '.33 1 .68 1', // ease-out cubic: entrances
  in: '.32 0 .67 0', // ease-in cubic: exits
  outExpo: '.16 1 .3 1', // libadwaita EASE_OUT_EXPO: the hover paint and the arrival ring
};

export const number = n => String(Number(n.toFixed(4)));
export const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// The style of a hero SVG: the two font classes, and the still copy in place of the motion for reduced motion.
export const css = (extra = '') => `<style>.mono{font-family:${FONT_MONO}}.sans{font-family:${FONT_SANS}}`
  + `.still{display:none}@media (prefers-reduced-motion:reduce){.motion{display:none}.still{display:inline}}${extra}</style>`;

export function timeline(loop) {
  assert.ok(Number.isInteger(loop) && loop > 0, 'the loop is a whole number of milliseconds');
  const dur = `${number(loop / 1000)}s`;
  // 1e-6 of the loop is the smallest key time step; a second key at the same time becomes a jump one step later.
  const STEP = 1e-6;

  // keys: [[ms, value, ease]] in time order; ease (an EASE name or four numbers) shapes the segment that ends at the key.
  // The first value holds before the first key, and the last value holds after the last key.
  function frames(keys, discrete) {
    assert.ok(keys.length > 0, 'an animation needs keys');
    let list = keys.map(([t, value, ease = 'linear']) => {
      assert.ok(t >= 0 && t <= loop, `key time ${t} is inside the loop`);
      return { t, value: String(value), ease: EASE[ease] ?? ease };
    });
    assert.ok(list.every((key, i) => !i || key.t >= list[i - 1].t), 'keys are in time order');
    // In discrete mode a later key at the same time replaces the earlier one.
    if (discrete) list = list.filter((key, i) => i === list.length - 1 || list[i + 1].t !== key.t);
    if (list[0].t > 0) list.unshift({ t: 0, value: list[0].value, ease: EASE.linear });
    if (list.at(-1).t < loop) list.push({ t: loop, value: list.at(-1).value, ease: EASE.linear });
    const times = [];
    for (const key of list) {
      let time = Number((key.t / loop).toFixed(6));
      if (times.length && time <= times.at(-1)) time = Number((times.at(-1) + STEP).toFixed(6));
      times.push(time);
    }
    assert.equal(times[0], 0);
    assert.ok(times.at(-1) <= 1 && times.every((time, i) => !i || time > times[i - 1]), 'key times rise strictly to 1');
    times[times.length - 1] = 1;
    return { times, values: list.map(key => key.value), splines: list.slice(1).map(key => key.ease) };
  }

  function element(name, attributes, keys, discrete) {
    const { times, values, splines } = frames(keys, discrete);
    const spline = !discrete && splines.some(s => s !== EASE.linear);
    const mode = discrete ? 'discrete' : spline ? 'spline' : 'linear';
    return `<${name} ${attributes} dur="${dur}" repeatCount="indefinite" calcMode="${mode}" keyTimes="${times.join(';')}" `
      + `values="${values.join(';')}"${spline ? ` keySplines="${splines.join(';')}"` : ''}/>`;
  }

  const animate = (attribute, keys, { discrete = false } = {}) =>
    element('animate', `attributeName="${attribute}"`, keys, discrete);
  // Values are "x y" for translate and "s" or "sx sy" for scale.
  const transform = (type, keys, { additive = false } = {}) =>
    element('animateTransform', `attributeName="transform" type="${type}"${additive ? ' additive="sum"' : ''}`, keys, false);
  // Visible inside each [start, end) interval, hidden outside.
  function visibility(intervals) {
    const keys = [[0, 'hidden']];
    for (const [start, end] of intervals) {
      assert.ok(start < end && start >= keys.at(-1)[0], 'intervals rise and do not overlap');
      keys.push([start, 'visible'], [end, 'hidden']);
    }
    return animate('visibility', keys, { discrete: true });
  }
  // [[ms, value]] at 60 fps from start to start + duration, with the exact end; fn takes the progress from 0 to 1.
  function sampled(start, duration, fn) {
    const keys = [];
    for (let i = 0; i * 1000 / 60 < duration - .5; i++) keys.push([start + i * 1000 / 60, fn(i * 1000 / 60 / duration)]);
    keys.push([start + duration, fn(1)]);
    return keys;
  }
  // A camera for a world group on a canvas: [[ms, x, y, scale, ease]] puts world point (x, y) at the canvas center.
  function camera(width, height, keys) {
    const scale = transform('scale', keys.map(([t, , , s, ease]) => [t, number(s), ease]));
    const move = transform('translate', keys.map(([t, x, y, , ease]) => [t, `${number(-x)} ${number(-y)}`, ease]));
    return { open: `<g transform="translate(${number(width / 2)} ${number(height / 2)})"><g>${scale}<g>${move}`, close: '</g></g></g>' };
  }
  return { loop, dur, animate, transform, visibility, sampled, camera };
}

// The safety and size checks of a finished hero SVG.
export function checkSvg(svg, maxBytes) {
  assert.ok(!/<script|foreignObject|<image|<set\b|animateMotion|\sbegin=|\son[a-z]+=/i.test(svg),
    'no script, foreign object, image, set, animateMotion, begin, or event attribute');
  assert.ok(!svg.replace('http://www.w3.org/2000/svg', '').includes('http'), 'no URL other than the SVG namespace');
  assert.ok(Buffer.byteLength(svg) <= maxBytes, `the SVG fits in ${maxBytes} bytes`);
}
