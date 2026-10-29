// Vector app windows for hero storyboards. Add appDefs() and hero-smil.css() once to the final SVG.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { escape, number } from './hero-smil.mjs';

const C = { text: '#f6f3ed', muted: '#b3b0aa', amber: '#ffb900' };
const glyphs = { claude: 'asb-claude-symbolic', chatgpt: 'asb-openai-symbolic', opencode: 'asb-opencode-symbolic' };
const symbols = Object.entries(glyphs).map(([kind, name]) => {
  const svg = readFileSync(new URL(`../assets/icons/${name}.svg`, import.meta.url), 'utf8');
  return `<symbol id="hero-app-${kind}" viewBox="${svg.match(/viewBox="([^"]+)"/)[1]}">${svg.match(/<path[^>]*\/>/g).join('')}</symbol>`;
}).join('');
const rect = (x, y, w, h, fill, r = 0, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
const text = (x, y, value, size = 13, fill = C.text, mono = false, extra = '') =>
  `<text class="${mono ? 'mono' : 'sans'}" x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${value ? `textLength="${advance(value, size, mono)}" lengthAdjust="spacingAndGlyphs"` : ''} ${extra}>${escape(value)}</text>`;
const mark = (kind, x, y, size = 14, fill = C.muted) => `<use href="#hero-app-${kind}" x="${x}" y="${y}" width="${size}" height="${size}" fill="${fill}"/>`;
const paths = {
  plus: 'M8 2v12M2 8h12', search: 'M10.5 10.5 15 15M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  folder: 'M1 4h5l2 2h7v8H1Z', menu: 'M2 4h12M2 8h12M2 12h12',
  panel: 'M2 3h12v10H2ZM6 3v10', back: 'M10 3 5 8l5 5', arrow: 'M6 3 5 3 10 8 5 13',
  home: 'm1 7 7-6 7 6M3 6v8h10V6M6 14V9h4v5', chat: 'M2 2h12v9H7l-5 4Z',
  clock: 'M8 4v4l3 2M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0',
  artifacts: 'M3 3h10v10H3ZM6 1v4M10 1v4M6 11v4M10 11v4',
  branch: 'M4 2v9a3 3 0 0 0 6 0V5M8 5h4', down: 'm4 6 4 4 4-4', up: 'm4 9 4-4 4 4M8 5v8',
  close: 'm4 4 8 8M12 4l-8 8', dots: 'M3 8h.1M8 8h.1M13 8h.1',
};
const icon = (kind, x, y, size = 14, color = C.muted) => `<g transform="translate(${x} ${y}) scale(${number(size / 16)})"><path d="${paths[kind]}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g>`;

// Conservative advances also fix textLength, so each line stays within its allotted width in both browsers.
function wrap(value, width, size = 13, mono = false) {
  const capacity = Math.max(1, Math.floor(width / (size * (mono ? .6 : .56))));
  return value.split('\n').flatMap(paragraph => {
    const lines = [];
    let rest = paragraph;
    while (rest.length > capacity) {
      const head = rest.slice(0, capacity + 1);
      let split = Math.max(head.lastIndexOf(' '), head.lastIndexOf('/', capacity - 1) + 1);
      if (split < 1) split = capacity;
      lines.push(rest.slice(0, split).trimEnd());
      rest = rest.slice(split).trimStart();
    }
    return [...lines, rest];
  });
}
const advance = (value, size, mono) => number(value.length * size * (mono ? .6 : .56));
function linesSvg(lines, x, y, size, color, mono, lineHeight = 19) {
  return lines.map((line, i) => text(x, y + i * lineHeight, line, size, color, mono, 'xml:space="preserve"')).join('');
}
const elide = (value, width, size = 13, mono = false) => {
  const n = Math.max(1, Math.floor(width / (size * (mono ? .6 : .56))));
  return value.length <= n ? value : value.slice(0, n - 1) + '…';
};
function times(tl, values, label) {
  assert.ok(Array.isArray(values), `${label} is an array`);
  assert.ok(values.every((t, i) => Number.isFinite(t) && t >= 0 && t <= tl.loop && (!i || t >= values[i - 1])), `${label} times rise inside the loop`);
}
function intervals(tl, values, label) {
  assert.ok(Array.isArray(values), `${label} is an array`);
  values.forEach((pair, i) => {
    assert.ok(Array.isArray(pair) && pair.length === 2, `${label} has time pairs`);
    times(tl, pair, label);
    assert.ok(pair[0] < pair[1] && (!i || pair[0] >= values[i - 1][1]), `${label} intervals do not overlap`);
  });
}
const visible = (tl, start, end, svg) => start < end ? `<g visibility="hidden">${tl.visibility([[start, end]])}${svg}</g>` : '';

/** Static defs, once per final SVG. All three provider glyphs are read locally at import. */
export function appDefs() {
  return symbols + `<filter id="hero-app-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity=".47"/></filter>`
    + `<filter id="hero-app-focus-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="15" stdDeviation="17.5" flood-color="#000" flood-opacity=".67"/></filter>`
    + `<linearGradient id="hero-app-desktop" x2="1" y2="1"><stop stop-color="#16181c"/><stop offset="1" stop-color="#111113"/></linearGradient>`
    + `<symbol id="hero-app-pointer" viewBox="0 0 27 33"><path d="M2 2v25l6-7 6 11 5-3-6-10h10L2 2Z" fill="${C.text}" stroke="#111" stroke-width="1.5"/></symbol>`;
}

/**
 * appWindow(tl, kind, opts) -> { svg, size:[w,h], composer:{x,y,w,h}, send:{x,y}, sidebarItem(title):{x,y,w,h} }
 * Coordinates are local. Defaults: 760×480, no timed actions, empty history/sidebar.
 * A paste replaces input; send clears it. Long composers scroll to their last visible lines.
 * opts: w/h; title/folder strings; sidebar title strings; history:[{role:'user'|'agent',text}].
 * Times are milliseconds, ordered within each array, inside tl.loop:
 * focus/working/caret:[[t0,t1]]; typing:[{t0,t1,text}]; paste/agent:[{t,text}]; send:[t].
 * Empty caret blinks 500 ms on/off. Typing and paste show a steady insertion caret.
 * sidebarItem throws for an absent title (OpenCode has no sidebar). Clip IDs are deterministic; no mutable counters.
 * Put svg inside the final document's .motion group; css() and the reduced-motion still are the caller's job.
 */
export function appWindow(tl, kind, opts = {}) {
  assert.ok(tl && Number.isInteger(tl.loop) && tl.loop > 0 && typeof tl.animate === 'function', 'a hero timeline is required');
  assert.ok(Object.hasOwn(glyphs, kind), 'known app kind');
  const { w = 760, h = 480, focus = [], title = '', folder = '', sidebar = [], history = [], typing = [], paste = [], send = [], working = [], agent = [], caret = [] } = opts;
  assert.ok(Number.isFinite(w) && Number.isFinite(h) && w >= 560 && w <= 900 && h >= 360 && h <= 640, 'window is 560×360 to 900×640');
  assert.ok(typeof title === 'string' && typeof folder === 'string' && Array.isArray(sidebar) && sidebar.every(s => typeof s === 'string'), 'titles and folders are strings');
  assert.ok(new Set(sidebar).size === sidebar.length, 'sidebar titles are unique');
  assert.ok(Array.isArray(history) && history.every(b => ['user', 'agent'].includes(b.role) && typeof b.text === 'string'), 'history has user/agent text');
  for (const [label, value] of [['focus', focus], ['working', working], ['caret', caret]]) intervals(tl, value, label);
  for (const [label, value] of [['typing', typing], ['paste', paste], ['agent', agent]]) {
    assert.ok(Array.isArray(value) && value.every(v => typeof v.text === 'string'), `${label} has text`);
    times(tl, value.map(v => label === 'typing' ? v.t0 : v.t), label);
  }
  intervals(tl, typing.map(v => [v.t0, v.t1]), 'typing');
  times(tl, send, 'send');
  assert.ok(send.every((t, i) => (!i || t > send[i - 1]) && t + 200 <= tl.loop) && agent.every(v => v.t + 200 <= tl.loop), 'entrances fit inside the loop');

  const terminal = kind === 'opencode', claude = kind === 'claude';
  const mono = terminal, size = terminal ? 13 : 14, lineHeight = terminal ? 20 : 21;
  const sx = terminal ? 0 : claude ? 214 : 230, paneW = w - sx;
  const muted = claude ? '#b3b4aa' : '#aaa9a3', bg = terminal ? '#0a0a0a' : claude ? '#22231f' : '#0d0d0d';
  const edits = typing.flatMap(({ t0, t1, text: value }) => Array.from({ length: value.length + 1 }, (_, i) => ({ t: t0 + (t1 - t0) * i / Math.max(1, value.length), text: value.slice(0, i) })))
    .concat(paste, send.map(t => ({ t, text: '', sent: true })))
    .sort((a, b) => a.t - b.t || Number(a.sent ?? false) - Number(b.sent ?? false));
  const states = [{ t: 0, text: '' }], sent = [];
  for (const edit of edits) {
    if (edit.sent) sent.push({ t: edit.t, role: 'user', text: states.at(-1).text });
    if (states.at(-1).t === edit.t) states[states.length - 1] = edit;
    else states.push(edit);
  }
  const inputWidth = paneW - (terminal ? 64 : 66);
  const maxLines = Math.max(1, ...states.map(s => wrap(s.text, inputWidth - 3, 13, mono).length));
  const composerH = terminal ? Math.max(54, Math.min(Math.floor(h * .42), maxLines * 18 + 24)) : Math.max(94, Math.min(Math.floor(h * .42), maxLines * 18 + 48));
  const composer = { x: sx + 20, y: h - (terminal ? 40 : 16) - composerH, w: paneW - 40, h: composerH };
  const sendPoint = { x: composer.x + composer.w - 24, y: composer.y + composer.h - 23 };
  const headerY = 27 + (kind === 'chatgpt' ? 32 : 0), contentY = headerY + 47 + 14;
  const contentH = composer.y - contentY - 14, contentW = paneW - 40;
  assert.ok(contentH >= 30, 'conversation has room');

  const activeSpans = [];
  for (const [start, end] of focus) {
    if (activeSpans.at(-1)?.[1] === start) activeSpans.at(-1)[1] = end;
    else activeSpans.push([start, end]);
  }
  const focusKeys = (inactive, active) => {
    const keys = [[0, activeSpans[0]?.[0] === 0 ? active : inactive]];
    activeSpans.forEach(([start, end], i) => {
      if (start > 0) keys.push([start, inactive], [Math.min(start + 120, end), active, 'out']);
      if (end < tl.loop) keys.push([end, active], [Math.min(end + 120, activeSpans[i + 1]?.[0] ?? tl.loop), inactive, 'out']);
    });
    return keys;
  };
  let svg = rect(0, 0, w, h, bg, 10, 'filter="url(#hero-app-shadow)"');
  svg += `<g opacity="0">${tl.animate('opacity', focusKeys(0, 1))}${rect(0, 0, w, h, bg, 10, 'filter="url(#hero-app-focus-shadow)"')}</g>`;
  // Nested SVGs have independent SMIL clocks in Chromium; clip groups keep one root clock.
  const id = `hero-app-${createHash('sha256').update(JSON.stringify([kind, opts])).digest('hex').slice(0, 16)}`;
  svg += `<defs><clipPath id="${id}-window">${rect(0, 0, w, h, '#fff', 10)}</clipPath>`
    + `<clipPath id="${id}-conversation">${rect(0, 0, contentW, contentH, '#fff')}</clipPath>`
    + `<clipPath id="${id}-input">${rect(0, 0, inputWidth, composer.h - (terminal ? 16 : 44), '#fff')}</clipPath></defs>`;
  svg += `<g clip-path="url(#${id}-window)">${rect(0, 0, w, h, bg, 10)}`;
  svg += `<rect width="${w}" height="27" fill="#303030">${tl.animate('fill', focusKeys('#303030', '#242424'))}</rect>`;
  svg += `<g color="${C.muted}">${tl.animate('color', focusKeys(C.muted, C.text))}${mark(kind, 12, 7, 12, 'currentColor')}${text(32, 18, terminal ? 'OpenCode' : claude ? 'Claude' : 'ChatGPT', 11, 'currentColor', mono)}`;
  svg += `<path d="M${w - 76} 15h8M${w - 49} 9h8v8h-8Z" fill="none" stroke="currentColor"/>${icon('close', w - 25, 7, 13, 'currentColor')}</g>`;

  const sidebarBoxes = new Map();
  function sidebarItem(value, x, y, width, height = 26) {
    sidebarBoxes.set(value, { x, y, w: width, h: height });
    return (value === title ? rect(x, y, width, height, '#30302e', 6) : '')
      + (claude ? `<circle cx="${x + 12}" cy="${y + height / 2}" r="2.5" fill="${value === title ? C.text : '#6d6d68'}"/>` : '')
      + text(x + (claude ? 24 : 9), y + height / 2 + 4, elide(value, width - (claude ? 44 : 28)), 13, value === title ? C.text : '#c7c6c1')
      + (value === title ? icon('dots', x + width - 20, y + (height - 12) / 2, 12) : '');
  }
  if (claude) {
    svg += rect(0, 27, 214, h - 27, '#191a18');
    ['menu', 'panel', 'back', 'arrow'].forEach((name, i) => { svg += icon(name, 12 + i * 30, 41); });
    svg += rect(170, 36, 34, 25, '#343530', 5) + text(176, 53, '</>', 12, C.text, true);
    svg += rect(10, 69, 194, 28, '#23241f', 5, 'stroke="#3a3b35"') + icon('search', 19, 76, 13) + text(40, 88, 'Search', 13, '#b4b4aa');
    ['New', 'Projects'].forEach((value, i) => { svg += icon(i ? 'folder' : 'plus', 19, 109 + i * 26) + text(42, 120 + i * 26, value, 13, '#c7c6c1'); });
    const groups = new Map();
    for (const value of sidebar) {
      const group = value === 'Summarize the open issues' ? 'field-notes' : value === 'Check the queue metrics' || value === 'Draft the migration plan for the queue' ? 'infra' : folder;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(value);
    }
    let y = 168;
    for (const [group, items] of groups) {
      svg += text(18, y + 12, elide(group, 165, 11), 11, '#adada3') + icon('plus', 186, y + 2, 12);
      y += 20;
      for (const value of items) {
        assert.ok(y + 26 <= h - 45, 'Claude sidebar items fit above the account');
        svg += sidebarItem(value, 10, y, 194); y += 26;
      }
      y += 9;
    }
    svg += rect(10, h - 39, 194, 1, '#383934') + `<circle cx="21" cy="${h - 20}" r="9.5" fill="#526175"/>`
      + text(18, h - 16, 'S', 10) + text(37, h - 16, 'Sample account', 12, '#c7c6bf') + icon('down', 188, h - 26, 11);
  } else if (!terminal) {
    svg += rect(0, 27, 43, h - 27, '#090909') + rect(43, 27, 187, h - 27, '#0b0b0b');
    ['home', 'artifacts', 'clock', 'chat', 'dots', 'branch'].forEach((name, i) => {
      if (!i) svg += rect(8, 37, 27, 25, '#222', 8);
      svg += icon(name, 13, 41 + i * 43, 17, i ? '#999993' : C.text);
    });
    svg += `<circle cx="21.5" cy="${h - 21}" r="12" fill="#35677f"/>` + text(18, h - 17, 'S', 10);
    svg += text(59, 57, 'Codex', 17, C.text, false, 'font-weight="600"') + icon('down', 112, 44, 12) + icon('search', 203, 44);
    svg += icon('plus', 60, 74) + text(83, 86, 'New chat') + icon('folder', 60, 104) + text(83, 116, 'Sample workspace');
    svg += text(60, 155, 'Projects', 13, muted) + icon('arrow', 124, 144, 11) + text(60, 184, 'Recents', 12, muted);
    sidebar.forEach((value, i) => {
      assert.ok(196 + i * 30 + 30 <= h - 10, 'Codex sidebar items fit');
      svg += sidebarItem(value, 52, 196 + i * 30, 169, 30);
    });
    svg += rect(sx, 27, paneW, 32, '#101010') + text(sx + 20, 48, 'Chat', 12, muted)
      + rect(sx + 70, 31, 69, 25, '#242424', 6) + text(sx + 84, 48, 'Codex', 12);
  }
  if (terminal) {
    svg += text(20, 55, 'opencode', 13, C.text, true, 'font-weight="700"')
      + text(98, 55, elide(`${title} · ${folder}`, w - 120, 13, true), 13, muted, true);
  } else {
    svg += icon('folder', sx + 18, headerY + 16) + text(sx + 42, headerY + 22, elide(title, paneW - 64, 14), 14, C.text, false, 'font-weight="600"')
      + text(sx + 42, headerY + 39, elide(folder, paneW - 64, 11), 11, muted) + rect(sx, headerY + 46, paneW, 1, claude ? '#36372f' : '#202020');
  }

  // One scroll track moves all old blocks together. Transient working lines occupy the next reply slot.
  const blocks = history.map(b => ({ ...b, t: 0, initial: true })).concat(sent, agent.map(v => ({ ...v, role: 'agent' }))).sort((a, b) => a.t - b.t);
  let bottom = 0;
  for (const block of blocks) {
    const user = block.role === 'user';
    const inset = terminal ? 0 : user ? Math.min(64, contentW * .16) : 0;
    const width = contentW - inset;
    block.lines = terminal ? wrap(block.text, width - 2 * size * .6, size, true).map(line => (user ? '> ' : '  ') + line)
      : wrap(block.text, width - (user ? 28 : 4), size, false);
    block.y = bottom;
    block.height = block.lines.length * lineHeight + (terminal ? 14 : user ? 24 : 19);
    block.inset = inset; block.width = width;
    bottom += block.height;
  }
  const scrollEvents = blocks.map(b => ({ t: b.t, bottom: b.y + b.height, initial: b.initial }));
  for (const [start] of working) {
    const previous = blocks.filter(b => b.t <= start).at(-1);
    scrollEvents.push({ t: start, bottom: (previous ? previous.y + previous.height : 0) + 30 });
  }
  scrollEvents.sort((a, b) => a.t - b.t);
  const scroll = [[0, 0]];
  let offset = 0;
  for (const event of scrollEvents) {
    const next = Math.max(offset, event.bottom - contentH);
    if (event.initial || event.t === 0) { offset = next; scroll[0][1] = -offset; }
    else if (next > offset) {
      const t = Math.max(event.t, scroll.at(-1)[0]);
      scroll.push([t, -offset], [Math.min(t + 200, tl.loop), -next, 'out']); offset = next;
    }
  }
  svg += `<g transform="translate(${sx + 20} ${contentY})"><g clip-path="url(#${id}-conversation)"><g>${tl.transform('translate', scroll.map(([t, y, ease]) => [t, `0 ${y}`, ease]))}`;
  for (const block of blocks) {
    const user = block.role === 'user';
    let body = !terminal && user ? rect(block.inset, 0, block.width, block.height - 12, claude ? '#303129' : '#242424', 13) : '';
    body += linesSvg(block.lines, block.inset + (terminal ? 0 : user ? 14 : 0), terminal ? 14 : user ? 24 : 17, size, C.text, mono, lineHeight);
    if (!block.initial) body = `<g opacity="0">${tl.animate('opacity', [[0, 0], [block.t, 0], [block.t + 200, 1, 'out']])}<g>${user ? tl.transform('translate', [[0, '0 8'], [block.t, '0 8'], [block.t + 200, '0 0', 'out']]) : ''}${body}</g></g>`;
    svg += `<g transform="translate(0 ${block.y})">${body}</g>`;
  }
  for (const [start, end] of working) {
    const previous = blocks.filter(b => b.t <= start).at(-1), y = previous ? previous.y + previous.height : 0;
    let indicator;
    if (claude) {
      const rotation = [[0, '0']];
      for (let t = start; t < end; t += 1200) rotation.push([t, String((t - start) / 1200 * 360)]);
      rotation.push([end, String((end - start) / 1200 * 360)]);
      indicator = `<g transform="translate(8 9)"><g>${tl.transform('rotate', rotation)}${mark(kind, -8, -8, 16, C.amber)}</g></g>` + text(24, 14, 'Working…', 12, muted);
    } else if (terminal) {
      const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
      indicator = [...frames].map((frame, i) => {
        const spans = [];
        for (let t = start + i * 80; t < end; t += 800) spans.push([t, Math.min(t + 80, end)]);
        return spans.length ? `<g visibility="hidden">${tl.visibility(spans)}${text(0, 14, frame, 13, C.amber, true)}</g>` : '';
      }).join('') + text(20, 14, 'Working', 13, muted, true);
    } else {
      indicator = text(0, 14, 'Working', 12, muted);
      for (let t = start; t < end; t += 1000) indicator += visible(tl, t, Math.min(t + 1000, end), text(63, 14, `${Math.floor((t - start) / 1000)}s`, 12, muted));
    }
    svg += visible(tl, start, end, `<g transform="translate(0 ${y})">${indicator}</g>`);
  }
  svg += '</g></g></g>';

  svg += rect(composer.x, composer.y, composer.w, composer.h, terminal ? '#0a0a0a' : claude ? '#2b2c25' : '#171717', terminal ? 0 : 15, `stroke="${terminal ? '#4a4844' : claude ? '#494b40' : '#303030'}"`);
  const inputX = composer.x + (terminal ? 28 : 13), inputY = composer.y + (terminal ? 21 : 24), inputH = composer.h - (terminal ? 16 : 44);
  if (terminal) svg += text(composer.x + 10, inputY, '>', 13, C.text, true);
  svg += `<g transform="translate(${inputX} ${composer.y + 7})"><g clip-path="url(#${id}-input)">`;
  for (let i = 0; i < states.length; i++) {
    const state = states[i], end = states[i + 1]?.t ?? tl.loop;
    const lines = wrap(state.text, inputWidth - 3, 13, mono), limit = Math.max(1, Math.floor((inputH - 4) / 18)), shown = lines.slice(-limit);
    let value = state.text ? linesSvg(shown, 0, 17, 13, C.text, mono, 18) : terminal ? '' : text(0, 17, claude ? 'Reply…' : 'Do anything', 13, muted);
    if (state.text) value += `<path d="M${advance(shown.at(-1), 13, mono)} ${4 + (shown.length - 1) * 18}v15" stroke="${C.text}"/>`;
    svg += visible(tl, state.t, end, value);
  }
  svg += '</g></g>';
  // Gate the empty caret so a requested interval cannot paint over entered text.
  const empty = states.flatMap((state, i) => !state.text && state.t < (states[i + 1]?.t ?? tl.loop) ? [[state.t, states[i + 1]?.t ?? tl.loop]] : []);
  const emptyBlink = [];
  for (const [start, end] of caret) for (let t = start; t < end; t += 1000) for (const [a, b] of empty) if (Math.max(t, a) < Math.min(t + 500, end, b)) emptyBlink.push([Math.max(t, a), Math.min(t + 500, end, b)]);
  svg += `<path d="M${inputX} ${composer.y + 11}v15" stroke="${C.text}" visibility="hidden">${tl.visibility(emptyBlink)}</path>`;
  if (terminal) svg += text(20, h - 13, 'build · Sonnet', 13, muted, true) + text(w - 20 - 8 * 7.8, h - 13, 'importer', 13, muted, true);
  else svg += icon('plus', composer.x + 13, composer.y + composer.h - 30, 16) + text(composer.x + 41, composer.y + composer.h - 18, claude ? 'Code' : 'Local', 11, muted)
    + text(sendPoint.x - (claude ? 63 : 105), composer.y + composer.h - 18, claude ? 'Sonnet' : 'GPT-6.1 Sol', 11, '#c5c4bd')
    + icon('down', sendPoint.x - 23, composer.y + composer.h - 27, 11) + `<circle cx="${sendPoint.x}" cy="${sendPoint.y}" r="11.5" fill="#3c3d35"/>` + icon('up', sendPoint.x - 6, sendPoint.y - 7, 12, C.text);
  svg += '</g>';
  return { svg, size: [w, h], composer, send: sendPoint, sidebarItem(value) { assert.ok(sidebarBoxes.has(value), `sidebar contains ${value}`); return { ...sidebarBoxes.get(value) }; } };
}

/** Pointer coordinates are in the caller's world. Ease belongs to the move ending at each key. */
export function cursor(tl, { keys, presses = [], wheels = [] }) {
  assert.ok(Array.isArray(keys) && keys.length > 0 && keys.every(k => Array.isArray(k) && Number.isFinite(k[1]) && Number.isFinite(k[2])), 'cursor has finite positions');
  times(tl, keys.map(k => k[0]), 'cursor'); times(tl, presses, 'press');
  assert.ok(wheels.every(v => ['up', 'down'].includes(v[1])), 'wheel direction is up or down');
  times(tl, wheels.map(v => v[0]), 'wheel');
  assert.ok(presses.every((t, i) => t + 160 <= tl.loop && (!i || t >= presses[i - 1] + 160)), 'presses fit and do not overlap');
  assert.ok(wheels.every(([t]) => t + 600 <= tl.loop), 'wheel hints fit');
  const scale = [[0, 1]];
  presses.forEach(t => scale.push([t, 1], [t + 60, .88, 'out'], [t + 160, 1, 'out']));
  let svg = `<g>${tl.transform('translate', keys.map(([t, x, y, ease = 'inOut']) => [t, `${x} ${y}`, ease]))}<g>${tl.transform('scale', scale)}<use href="#hero-app-pointer" width="27" height="33"/></g>`;
  for (const [t, direction] of wheels) svg += visible(tl, t, t + 600, `<g transform="translate(32 0)">${rect(0, 0, 19, 30, '#242424', 9, 'stroke="#b3b0aa"')}<g>${tl.transform('translate', [[0, '0 0'], [t, direction === 'down' ? '0 -3' : '0 3'], [t + 500, direction === 'down' ? '0 5' : '0 -5', 'out']])}<path d="M9.5 9v8m-3 ${direction === 'down' ? '-3 3 3 3-3' : '-1 3-3 3 3'}" fill="none" stroke="${C.text}" stroke-width="1.5"/></g></g>`);
  return svg + '</g>';
}

/** Quiet Film desktop, without app data or a taskbar. */
export function desktop(tl, w, h) {
  assert.ok(tl?.loop > 0 && Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0, 'desktop has a timeline and positive dimensions');
  return rect(0, 0, w, h, 'url(#hero-app-desktop)');
}
