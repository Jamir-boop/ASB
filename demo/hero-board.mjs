// Measured GTK board for the README hero. No output or animation is made at import.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escape, number as n } from './hero-smil.mjs';

export const scene = JSON.parse(readFileSync(new URL('hero-board.json', import.meta.url), 'utf8'));
const icons = new Map();
for (const name of ['claude', 'openai', 'opencode', 'machine', 'terminal', 'link', 'globe', 'drawer', 'filter']) {
  const key = `asb-${name}-symbolic`;
  const raw = readFileSync(new URL(`../assets/icons/${key}.svg`, import.meta.url), 'utf8');
  icons.set(key, `<symbol id="board-${key}" viewBox="${raw.match(/viewBox="([^"]+)"/)[1]}">${raw.match(/<path\b[^>]*\/>/g).join('')}</symbol>`);
}
const accent = '#ffb900';
const ownIcons = {
  'system-search-symbolic': '<circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/>',
  'edit-copy-symbolic': '<rect x="5" y="2" width="8" height="9" rx="1"/><path d="M10 13H3V5"/>',
  'object-select-symbolic': '<path d="m3 8 3 3 7-7"/>',
  'view-pin-symbolic': '<path d="M5 1h6v2h-1v3l2 3H9v6H7V9H4l2-3V3H5Z" fill="#ffffff" stroke="none"/>',
  'view-refresh-symbolic': '<path d="M12 5A5 5 0 1 0 13 10M13 2v4H9"/>',
  'view-more-symbolic': '<path d="M8 3h.01M8 8h.01M8 13h.01" stroke-width="3"/>',
  'window-close-symbolic': '<circle cx="8" cy="8" r="7" fill="#252525" stroke="none"/><path d="m5.5 5.5 5 5m0-5-5 5"/>',
};
const fill = (c, attr = 'fill') => Array.isArray(c) ? `${attr}="${c[0]}" ${attr}-opacity="${n(c[1])}"` : `${attr}="${c}"`;
const attrs = item => `${fill(item.c)}${item.o === undefined ? '' : ` opacity="${n(item.o)}"`}`;
function draw(item) {
  if (item.k === 'text') return `<text class="mono" x="${n(item.x)}" y="${n(item.y)}" text-anchor="${item.a}" font-size="${n(item.s)}" font-weight="${item.w}" textLength="${n(item.L)}" lengthAdjust="spacingAndGlyphs" ${attrs(item)}>${escape(item.t)}</text>`;
  if (item.k === 'icon') {
    if (item.n === 'local.asb.AgentSwitchBoard') return `<circle cx="${n(item.x + item.size / 2)}" cy="${n(item.y + item.size / 2)}" r="${n(item.size / 2)}" fill="url(#board-disc)"/>`;
    if (icons.has(item.n)) return `<use href="#board-${item.n}" x="${n(item.x)}" y="${n(item.y)}" width="${item.size}" height="${item.size}" ${attrs(item)}/>`;
    assert.ok(ownIcons[item.n], `known board icon ${item.n}`);
    return `<g transform="translate(${n(item.x)} ${n(item.y)}) scale(${n(item.size / 16)})" fill="none" ${fill(item.c, 'stroke')} stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"${item.o === undefined ? '' : ` opacity="${n(item.o)}"`}>${ownIcons[item.n]}</g>`;
  }
  const stroke = item.stroke ? ` ${fill(item.stroke, 'stroke')} stroke-width="${n(item.sw)}"${item.dash ? ` stroke-dasharray="${item.dash}"` : ''}` : '';
  if (item.k === 'circle') return `<circle cx="${n(item.cx)}" cy="${n(item.cy)}" r="${n(item.r)}" ${attrs(item)}${stroke}/>`;
  assert.equal(item.k, 'rect');
  return `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(item.w)}" height="${n(item.h)}" rx="${n(item.rx)}" ${attrs(item)}${stroke}/>`;
}
const drawItems = items => items.map(draw).join('');
const stateOf = name => { assert.ok(scene.states[name], `known board state ${name}`); return scene.states[name]; };
const frame = () => {
  const { c, border, width, radius } = scene.frame, [w, h] = scene.size;
  return `<rect x="${width / 2}" y="${width / 2}" width="${w - width}" height="${h - width}" rx="${radius}" fill="${c}" stroke="${border}" stroke-width="${width}"/>`;
};
export function boardDefs() {
  return [...icons.values()].join('')
    + '<radialGradient id="board-disc" cx="35%" cy="30%" r="95.5%"><stop offset="0" stop-color="#f3e6c4"/><stop offset=".6" stop-color="#a8905a"/><stop offset="1" stop-color="#5c4b28"/></radialGradient>'
    + '<linearGradient id="board-corner" gradientUnits="userSpaceOnUse" x1="0" x2="16"><stop stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000"/></linearGradient>'
    + '<clipPath id="board-viewport"><rect y="33" width="660" height="387"/></clipPath>';
}
function itemSvg(item) {
  if (item.c !== 'url(#board-corner)') return draw(item);
  // The fade starts at the corner's left edge, not at the card origin.
  return `<g transform="translate(${n(item.x)} ${n(item.y)})">${draw({ ...item, x: 0, y: 0 })}</g>`;
}
const cardItems = items => items.map(itemSvg).join('');
function stillCards(state) {
  const hover = state.hover && state.cards[state.hover];
  return drawItems(state.decorations) + (hover ? draw({ k: 'rect', x: hover.x, y: hover.y, w: hover.w, h: hover.h, rx: scene.hover.radius, c: scene.hover.c }) : '')
    + state.order.map(id => { const c = state.cards[id]; return `<g transform="translate(${c.x} ${c.y})">${cardItems(c.items)}</g>`; }).join('');
}
export function boardStill(name) {
  return `<g>${frame()}${drawItems(scene.toolbar)}<g clip-path="url(#board-viewport)">${stillCards(stateOf(name))}</g></g>`;
}
const spring = seconds => (1 + 20 * seconds) * Math.exp(-20 * seconds);
const outExpo = p => p >= 1 ? 1 : 1 - 2 ** (-10 * p);
function springMs(distance) {
  const jump = e => distance * e * (1 - Math.log(e));
  let lo = .0001, hi = .001;
  if (jump(hi) <= .5) return -Math.log(hi) * 50;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (jump(mid) <= .5) lo = mid; else hi = mid; }
  return -Math.log(lo) * 50;
}
const durationText = (seconds, whole) => {
  seconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return hours ? `${hours}h${minutes}m` : minutes ? `${minutes}m${whole ? '' : `${rest}s`}` : `${rest}s`;
};
const footerRoles = new Set(['state', 'age', 'where', 'feedback']);
const tagRoles = new Set(['tag', 'tag-word', 'tag-dot']);
const clone = value => structuredClone(value);
const lastAt = (list, t) => list.findLast(x => x.t <= t);

/**
 * Render one board per SVG; call boardDefs once and use hero-smil.css for reduced motion.
 * boxAt(id, ms) returns {x,y,w,h}, markAt/controlAt return [x,y]. Absent cards or controls return null.
 * Hover/copy events require a measured variant of that card's current state; unknown variants fail at build time.
 * Gliding cards are opaque, and the card that jumps forward in the order paints on top of the others.
 * Reset fades the current cards out, then the reset cards in, in equal halves; frame and toolbar stay fixed.
 * The returned svg is .motion. Put boardStill('S4') in a sibling .still group for reduced motion.
 */
export function renderBoard({ tl, events, start = 'S0' }) {
  const initial = stateOf(start), known = new Set(Object.values(scene.states).flatMap(s => s.order));
  assert.ok(events.every((e, i) => Number.isFinite(e.t) && e.t >= 0 && e.t < tl.loop && (!i || e.t >= events[i - 1].t)), 'board events are in time order inside the loop');
  let model = { state: start, active: true, hover: initial.hover ?? null, kind: initial.copyKind, tag: initial.copyTag, copied: initial.copied ? { [initial.hover]: 1600 } : {}, opening: initial.opening, starts: {} };
  for (const [id, timer] of Object.entries(scene.timers[start])) model.starts[id] = (timer.start - initial.at) * 1000;
  const models = [{ t: 0, ...clone(model) }], moves = new Map(), resets = [];
  for (const id of initial.order) moves.set(id, [{ t: 0, card: initial.cards[id], dx: 0, dy: 0, fade: 0, ms: 0 }]);
  const placeAt = (id, t) => {
    const move = lastAt(moves.get(id) ?? [], t);
    if (!move?.card) return null;
    const p = move.ms && t - move.t < move.ms ? spring((t - move.t) / 1000) : 0;
    return { x: move.card.x + move.dx * p, y: move.card.y + move.dy * p, w: move.card.w, h: move.card.h, alpha: 1 - move.fade * p };
  };
  function measured(m, id) {
    const base = stateOf(m.state).cards[id];
    if (m.hover !== id) return base;
    const copied = m.copied[id] > m.t;
    const candidates = Object.values(scene.states).filter(s => s.hover === id && s.cards[id].state === base.state);
    const variant = candidates.find(s => (!m.tag && !copied || s.copyKind === m.kind) && s.copyTag === m.tag && s.copied === copied && s.opening === (m.opening === id ? id : null));
    if (variant) return variant.cards[id];
    if (copied && !m.tag) {
      const plain = candidates.find(s => !s.copyTag && !s.copied && s.opening === (m.opening === id ? id : null))?.cards[id];
      const confirmed = candidates.find(s => s.copied && s.copyKind === m.kind)?.cards[id];
      assert.ok(plain && confirmed, `measured copy controls and feedback for ${id}`);
      const box = plain.controls.copy;
      const copyItem = it => it.role === 'control' && (it.k === 'icon' ? it.x >= box.x && it.x + it.size <= box.x + box.w : it.k === 'rect' && it.x === box.x && it.y === box.y);
      return { ...plain, items: [...plain.items.filter(it => !footerRoles.has(it.role) && !copyItem(it)), ...confirmed.items.filter(it => it.role === 'feedback' || copyItem(it))] };
    }
    assert.fail(`measured hover/copy/open state for ${id}, ${base.state}, ${m.kind}, tag=${m.tag}, copied=${copied}`);
  }
  for (const event of events) {
    const t = event.t;
    model.t = t;
    if (event.state !== undefined) {
      const before = stateOf(model.state), after = stateOf(event.state), offsets = [];
      for (const id of new Set([...before.order, ...after.order])) {
        const old = placeAt(id, t), card = after.cards[id];
        const move = { t, card, dx: old && card ? old.x - card.x : 0, dy: old && card ? old.y - card.y : 0, fade: card ? old ? 1 - old.alpha : 1 : 0, ms: 0 };
        offsets.push([id, move]);
        if (card?.state === 'working' && before.cards[id]?.state !== 'working') {
          const timer = scene.timers[event.state][id];
          model.starts[id] = t + (timer.start < 0 ? (timer.start - after.at) * 1000 : 0);
        }
      }
      const ms = springMs(Math.max(...offsets.map(([, m]) => Math.max(Math.abs(m.dx), Math.abs(m.dy)))));
      for (const [id, move] of offsets) {
        if (model.active && (move.dx || move.dy || move.fade)) move.ms = ms;
        if (!moves.has(id)) moves.set(id, []);
        moves.get(id).push(move);
      }
      // The lead: the card present in both states whose order index drops most; ties go to the earlier new index.
      let lead = null, drop = 0;
      if (model.active) for (const [index, id] of after.order.entries()) {
        const old = before.order.indexOf(id);
        if (old >= 0 && old - index > drop) { drop = old - index; lead = id; }
      }
      if (lead) offsets.find(([id]) => id === lead)[1].lead = true;
      model.state = event.state;
    }
    if (event.active !== undefined) { assert.equal(typeof event.active, 'boolean'); model.active = event.active; }
    if (event.hover !== undefined) {
      assert.ok(event.hover === null || known.has(event.hover), 'known hover id');
      assert.ok(event.hover === null || stateOf(model.state).cards[event.hover], 'hovered card is present');
      if (event.hover !== model.hover) model.tag = false;
      model.hover = event.hover;
    }
    if (event.copyTag !== undefined) {
      assert.ok(model.hover, 'copy tag needs a hovered card');
      assert.ok([null, 'relative', 'absolute'].includes(event.copyTag), 'known copy kind');
      model.tag = event.copyTag !== null;
      if (model.tag) model.kind = event.copyTag;
    }
    if (event.copied !== undefined) {
      assert.equal(event.copied, true);
      assert.ok(model.hover, 'copy needs a hovered card');
      model.copied[model.hover] = t + 1600;
    }
    if (event.opening !== undefined) {
      assert.ok(event.opening === null || known.has(event.opening), 'known opening id');
      assert.ok(event.opening === null || stateOf(model.state).cards[event.opening], 'opening card is present');
      model.opening = event.opening;
    }
    if (model.hover) measured(model, model.hover);
    if (event.light) {
      assert.ok(model.active, 'message lights need an active board');
      assert.equal(event.light.length, 2);
      assert.ok(event.light.every(id => known.has(id) && placeAt(id, t)), 'known and present message endpoints');
      assert.notEqual(...event.light);
    }
    if (event.reset !== undefined) {
      stateOf(event.reset);
      assert.ok(Number.isFinite(event.ms) && event.ms > 0 && t + event.ms <= tl.loop, 'reset fits in loop');
      resets.push(event);
    }
    models.push({ t, ...clone(model) });
  }
  const modelAt = t => ({ ...lastAt(models, t), t });
  const position = (id, t) => {
    const reset = lastAt(resets, t);
    if (reset && t >= reset.t + reset.ms) { const c = stateOf(reset.reset).cards[id]; return c ? { x: c.x, y: c.y, w: c.w, h: c.h, alpha: 1 } : null; }
    return placeAt(id, t);
  };
  const boxAt = (id, t) => { assert.ok(known.has(id), `known card ${id}`); const p = position(id, t); return p && { x: p.x, y: p.y, w: p.w, h: p.h }; };
  const markAt = (id, t) => {
    const p = position(id, t); if (!p) return null;
    const reset = lastAt(resets, t), state = reset && t >= reset.t + reset.ms ? stateOf(reset.reset) : stateOf(modelAt(t).state);
    const c = state.cards[id]; return [p.x + c.mark[0] - c.x, p.y + c.mark[1] - c.y];
  };
  const controlAt = (id, name, t) => {
    assert.ok(['copy', 'drawer'].includes(name), 'known hover control');
    const m = modelAt(t), p = position(id, t);
    if (!p || m.hover !== id) return null;
    const control = measured(m, id).controls[name];
    return control ? [p.x + control.x + control.w / 2, p.y + control.y + control.h / 2] : null;
  };

  // Only event edges and timer ticks change card content; the spring has a separate 60 Hz transform track.
  const boundaries = new Set([0, tl.loop, ...events.map(e => e.t)]);
  for (let i = 0; i < models.length; i++) {
    const m = models[i], end = models[i + 1]?.t ?? tl.loop;
    for (const until of Object.values(m.copied)) if (until > m.t && until < end) boundaries.add(until);
    for (const [id, since] of Object.entries(m.starts)) {
      if (stateOf(m.state).cards[id]?.state !== 'working') continue;
      for (let t = since + Math.ceil((m.t - since) / 1000) * 1000; t < end; t += 1000) if (t >= 0) boundaries.add(t);
    }
  }
  const times = [...boundaries].sort((a, b) => a - b);
  const layers = new Map();
  function segment(key, start, end, svg, feedback = false) {
    if (!layers.has(key)) layers.set(key, []);
    const list = layers.get(key), previous = list.at(-1);
    if (previous?.svg === svg && previous.end === start && previous.feedback === feedback) previous.end = end;
    else list.push({ start, end, svg, feedback });
  }
  for (let i = 0; i < times.length - 1; i++) {
    const t = times[i], end = times[i + 1], m = modelAt(t), state = stateOf(m.state);
    segment('decorations', t, end, drawItems(state.decorations));
    for (const id of state.order) {
      const card = measured(m, id), items = clone(card.items);
      if (m.copied[id] > t && m.hover !== id) {
        const copied = Object.values(scene.states).find(s => s.hover === id && s.copyKind === m.kind && s.copied)?.cards[id];
        assert.ok(copied, `measured copied feedback for ${id}`);
        items.splice(0, items.length, ...items.filter(it => !footerRoles.has(it.role)), ...copied.items.filter(it => it.role === 'feedback'));
      }
      const age = items.find(it => it.role === 'age');
      if (age && card.state === 'working') {
        const text = durationText((t - m.starts[id]) / 1000, !m.active);
        const right = age.x + age.L;
        // Pango's measured monospace advance, not a browser font's nominal glyph width.
        age.t = text; age.L = text.length * scene.font.advance[age.s.toFixed(1)]; age.x = right - age.L;
      }
      if (m.opening === id && !items.some(it => it.role === 'opening')) {
        const opening = Object.values(scene.states).find(s => s.opening === id)?.cards[id].items.filter(it => it.role === 'opening');
        assert.ok(opening, `measured Opening title for ${id}`);
        items.splice(0, items.length, ...items.filter(it => it.role !== 'title'), ...opening);
      }
      segment(`${id}:body`, t, end, cardItems(items.filter(it => !footerRoles.has(it.role) && !tagRoles.has(it.role))));
      segment(`${id}:footer`, t, end, cardItems(items.filter(it => footerRoles.has(it.role))), m.copied[id] > t);
    }
  }
  // within: [start, end] keeps only segments that overlap it; fades still read the full list.
  function drawSegments(list, footer = false, within = null) {
    return list.map((s, i) => {
      if (!s.svg || within && !(s.start < within[1] && s.end > within[0])) return '';
      const fadeIn = footer && i > 0 && list[i - 1].end === s.start && list[i - 1].feedback !== s.feedback;
      const fadeOut = footer && i + 1 < list.length && list[i + 1].start === s.end && list[i + 1].feedback !== s.feedback;
      const end = Math.min(tl.loop, s.end + (fadeOut ? 100 : 0));
      return `<g visibility="hidden">${tl.visibility([[s.start, end]])}${fadeIn || fadeOut ? tl.animate('opacity', [[0, fadeIn ? 0 : 1], ...(fadeIn ? [[s.start, 0], [Math.min(s.start + 100, s.end), 1]] : []), ...(fadeOut ? [[s.end, 1], [end, 0]] : [])]) : ''}${s.svg}</g>`;
    }).join('');
  }
  let cards = '', leads = '', entering = '';
  const glideWindow = (list, i) => [list[i].t, Math.min(list[i].t + list[i].ms, list[i + 1]?.t ?? tl.loop, tl.loop)];
  const opaque = (card, window) => `<rect width="${n(card.w)}" height="${n(card.h)}" rx="${n(scene.hover.radius)}" fill="${scene.frame.c}" visibility="hidden">${tl.visibility([window])}</rect>`;
  // Opacity, not visibility: the segments set their own visibility, which would override a hidden parent.
  const shownIn = windows => tl.animate('opacity', [[0, 0], ...windows.flatMap(([a, b]) => [[a, 1], [b, 0]])], { discrete: true });
  for (const [id, list] of moves) {
    const keys = [], alpha = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i], end = list[i + 1]?.t ?? tl.loop;
      if (!m.card) { alpha.push([m.t, 0]); continue; }
      const sample = m.ms ? tl.sampled(m.t, Math.min(m.ms, end - m.t), p => {
        const dt = p * Math.min(m.ms, end - m.t), factor = dt >= m.ms ? 0 : spring(dt / 1000);
        return { xy: `${n(m.card.x + m.dx * factor)} ${n(m.card.y + m.dy * factor)}`, a: n(1 - m.fade * factor) };
      }) : [[m.t, { xy: `${m.card.x} ${m.card.y}`, a: 1 }]];
      if (keys.length) { keys.push([m.t, keys.at(-1)[1]]); alpha.push([m.t, alpha.at(-1)[1]]); }
      keys.push(...sample.map(([t, p]) => [t, p.xy])); alpha.push(...sample.map(([t, p]) => [t, p.a]));
    }
    const motion = `${tl.transform('translate', keys)}${tl.animate('opacity', alpha)}`;
    const copy = (m, window) => `<g opacity="0">${shownIn([window])}<g>${motion}${opaque(m.card, window)}${drawSegments(layers.get(`${id}:body`) ?? [], false, window)}${drawSegments(layers.get(`${id}:footer`) ?? [], true, window)}</g></g>`;
    const glides = list.map((m, i) => m.ms > 0 ? opaque(m.card, glideWindow(list, i)) : '').join('');
    // A card that fades in paints under all cards while it fades: on top, its half-transparent rect would show a gliding card's text.
    const fading = list.flatMap((m, i) => m.ms > 0 && m.fade > 0 ? [[m, glideWindow(list, i)]] : []);
    for (const [m, window] of fading) entering += copy(m, window);
    for (const [i, m] of list.entries()) if (m.lead) leads += copy(m, glideWindow(list, i));
    let base = `<g>${motion}${glides}${drawSegments(layers.get(`${id}:body`) ?? [])}${drawSegments(layers.get(`${id}:footer`) ?? [], true)}${tagAnimation(id)}${providerLights(id)}</g>`;
    if (fading.length) {
      const hidden = fading.map(([, w]) => w), shown = [];
      let from = 0;
      for (const [a, b] of hidden) { if (a > from) shown.push([from, a]); from = b; }
      if (from < tl.loop) shown.push([from, tl.loop]);
      base = `<g>${tl.animate('opacity', [[0, shown[0]?.[0] === 0 ? 1 : 0], ...shown.flatMap(([a, b]) => [[a, 1], [b, 0]])], { discrete: true })}${base}</g>`;
    }
    cards += base;
  }

  function tagAnimation(id) {
    let svg = '';
    const runs = [];
    for (let i = 0; i < models.length; i++) {
      const m = { ...models[i], t: models[i].t }, end = models[i + 1]?.t ?? tl.loop;
      if (m.hover !== id || !m.tag || end <= m.t) continue;
      const card = measured(m, id), items = card.items.filter(it => tagRoles.has(it.role));
      assert.ok(items.some(it => it.role === 'tag-word'), 'measured copy tag');
      const previous = runs.at(-1);
      if (previous?.end === m.t && previous.kind === m.kind) previous.end = end;
      else runs.push({ start: m.t, end, kind: m.kind, items });
    }
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i], before = runs[i - 1], after = runs[i + 1];
      const joinsBefore = before?.end === run.start, joinsAfter = after?.start === run.end;
      const pill = run.items.find(it => it.role === 'tag'), right = pill.x + pill.w;
      const leave = Math.min(tl.loop, run.end + 200);
      const hoverEnd = models.find(m => m.t >= run.end && m.hover !== id)?.t ?? tl.loop;
      const visibleEnd = Math.min(leave, hoverEnd);
      const key = `board-tag-${id}-${i}`, wordKey = `${key}-word`;
      const widthKeys = [[0, joinsBefore ? pill.w : 0], ...(joinsBefore ? [] : [[run.start, 0], [Math.min(run.start + 200, run.end), pill.w, 'out']]), ...(joinsAfter ? [] : [[run.end, pill.w], [leave, 0, 'out']])];
      const xKeys = widthKeys.map(([t, w, ease]) => [t, n(right - w), ease]);
      svg += `<g visibility="hidden">${tl.visibility([[run.start, visibleEnd]])}<clipPath id="${key}"><rect y="${pill.y}" height="${pill.h}" x="${right}" width="0">${tl.animate('x', xKeys)}${tl.animate('width', widthKeys)}</rect></clipPath><clipPath id="${wordKey}"><rect x="${pill.x}" y="${pill.y}" width="${pill.w - 12}" height="${pill.h}"/></clipPath><g clip-path="url(#${key})">`;
      const paintEnd = joinsAfter ? run.end : visibleEnd;
      svg += `<g visibility="hidden">${tl.visibility([[run.start, paintEnd]])}${cardItems(run.items.filter(it => it.role !== 'tag-word'))}</g>`;
      const direction = run.kind === 'absolute' ? 1 : -1;
      const wordKeys = [[0, `0 ${joinsBefore ? direction * pill.h : 0}`], ...(joinsBefore ? [[run.start, `0 ${direction * pill.h}`], [Math.min(run.start + 200, run.end), '0 0', 'inOut']] : []), ...(joinsAfter ? [[run.end, '0 0'], [Math.min(run.end + 200, tl.loop), `0 ${after.kind === 'absolute' ? -pill.h : pill.h}`, 'inOut']] : [])];
      svg += `<g clip-path="url(#${wordKey})"><g>${tl.transform('translate', wordKeys)}${cardItems(run.items.filter(it => it.role === 'tag-word'))}</g></g></g></g>`;
    }
    return svg;
  }
  function providerLights(id) {
    let svg = '';
    for (const e of events.filter(e => e.light?.[0] === id)) {
      const card = stateOf(modelAt(e.t).state).cards[id], icon = card.items.find(it => it.role === 'provider');
      assert.ok(icon, 'measured provider mark');
      // GTK lights the sender for 160 ms. The receiver has the arrival ring, not a lit provider class.
      svg += `<g visibility="hidden">${tl.visibility([[e.t, Math.min(e.t + 160, tl.loop)]])}${draw({ ...icon, c: accent, o: 1 })}</g>`;
    }
    return svg;
  }
  const hoverKeys = [], hoverAlpha = [];
  let hoverBox = null, hoverValue = 0;
  for (let i = 0; i < models.length; i++) {
    const m = models[i], previous = models[i - 1];
    if (previous && m.hover === previous.hover && m.state === previous.state) continue;
    const target = m.hover ? placeAt(m.hover, m.t) : null;
    if (!target && !hoverBox) continue;
    const from = hoverBox ?? target, to = target ?? from;
    const different = ['x', 'y', 'w', 'h'].some(k => from[k] !== to[k]);
    const ms = different ? 200 : 100, end = Math.min(m.t + ms, models[i + 1]?.t ?? tl.loop);
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!hoverKeys.some(x => x.key === key)) hoverKeys.push({ key, values: [[0, from[key]]] });
      hoverKeys.find(x => x.key === key).values.push(...tl.sampled(m.t, end - m.t, p => n(from[key] + (to[key] - from[key]) * outExpo(p))));
    }
    if (!hoverAlpha.length) hoverAlpha.push([0, 0]);
    hoverAlpha.push(...tl.sampled(m.t, end - m.t, p => n(hoverValue + ((target ? 1 : 0) - hoverValue) * outExpo(p))));
    hoverBox = to; hoverValue = target ? 1 : 0;
  }
  const hoverSvg = hoverAlpha.length ? `<rect rx="${scene.hover.radius}" fill="${scene.hover.c}" opacity="0">${hoverKeys.map(({ key, values }) => tl.animate({ w: 'width', h: 'height' }[key] ?? key, values)).join('')}${tl.animate('opacity', hoverAlpha)}</rect>` : '';
  let content = `${drawSegments(layers.get('decorations'))}${hoverSvg}${entering}${cards}${leads}${flights()}`;
  for (const reset of resets) {
    const middle = reset.t + reset.ms / 2;
    content = `<g class="board-reset-out">${tl.animate('opacity', [[0, 1], [reset.t, 1], [middle, 0, 'in']])}${content}</g><g class="board-reset-in" opacity="0">${tl.animate('opacity', [[0, 0], [middle, 0], [reset.t + reset.ms, 1, 'out']])}${stillCards(stateOf(reset.reset))}</g>`;
  }
  return { svg: `<g class="motion">${frame()}${drawItems(scene.toolbar)}<g clip-path="url(#board-viewport)">${content}</g></g>`, boxAt, markAt, controlAt };

  function flights() {
    let svg = '';
    for (const event of events.filter(e => e.light)) {
      const [from, to] = event.light, S = markAt(from, event.t), R = markAt(to, event.t);
      const distance = Math.hypot(R[0] - S[0], R[1] - S[1]);
      const duration = Math.round(Math.min(900, Math.max(480, distance / 1.5))), arrival = event.t + duration;
      assert.ok(arrival + 420 <= tl.loop, 'message flight and ring fit in loop');
      const ease = p => p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
      const point = (p, at) => {
        const A = markAt(from, at), B = markAt(to, at);
        assert.ok(A && B, 'message endpoints remain present during the flight');
        const dx = B[0] - A[0], dy = B[1] - A[1], d = Math.hypot(dx, dy), bow = Math.min(60, .22 * d);
        const nx = d ? -dy / d : 0, ny = d ? dx / d : 0;
        const sign = (Math.abs(dx) >= Math.abs(dy) ? ny > 0 : nx > 0) ? -1 : 1;
        const C = [Math.max(2, (A[0] + B[0]) / 2 + sign * nx * bow), (A[1] + B[1]) / 2 + sign * ny * bow];
        const t = ease(Math.max(0, p)), u = 1 - t;
        return A.map((a, axis) => n(u * u * a + 2 * u * t * C[axis] + t * t * B[axis]));
      };
      const samples = tl.sampled(event.t, duration, p => p);
      svg += `<g visibility="hidden">${tl.visibility([[event.t, arrival]])}`;
      for (let k = 1; k <= 8; k++) {
        const path = samples.map(([t, p]) => [t, `M${point(Math.max(0, p - (k - 1) * .025), t).join(' ')} ${point(Math.max(0, p - k * .025), t).join(' ')}`]);
        svg += `<path fill="none" stroke="${accent}" stroke-width="${n(3.2 * (1 - k / 9))}" stroke-opacity="${n(.7 * (1 - k / 9))}" stroke-linecap="round">${tl.animate('d', path)}</path>`;
      }
      svg += `<g>${tl.transform('translate', samples.map(([t, p]) => [t, point(p, t).join(' ')]))}<circle r="6" fill="${accent}" opacity=".25"/><circle r="3" fill="${accent}"/></g></g>`;
      const ring = tl.sampled(arrival, 420, p => markAt(to, arrival + 420 * p));
      assert.ok(ring.every(([, point]) => point), 'message receiver remains present during the ring');
      const center = ['cx', 'cy'].map((attr, axis) => tl.animate(attr, ring.map(([t, point]) => [t, n(point[axis])]))).join('');
      svg += `<circle cx="${R[0]}" cy="${R[1]}" r="5" fill="none" stroke="${accent}" stroke-width="1.5" visibility="hidden">${center}${tl.visibility([[arrival, arrival + 420]])}${tl.animate('r', tl.sampled(arrival, 420, p => n(5 + 8 * outExpo(p))))}${tl.animate('stroke-opacity', tl.sampled(arrival, 420, p => n(.85 * (1 - outExpo(p)))))}</circle>`;
    }
    return svg;
  }
}
