import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Img, continueRender, delayRender, staticFile, useCurrentFrame} from 'remotion';
import {menuActions, rowsAt, storyAt} from './story.mjs';

const C = {ground: '#111113', panel: '#242424', control: '#343434', text: '#f6f3ed',
  muted: '#b3b0aa', line: '#4a4844', amber: '#ffb900', working: '#8fce8a'};
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => 1 - Math.pow(1 - clamp(value), 4);
const ramp = (frame, start, end) => ease((frame - start) / (end - start));
const mix = (a, b, value) => a + (b - a) * value;
const px = value => `${value}px`;
const font = 'Cantarell, sans-serif';
const display = 'Syne, sans-serif';

function Fonts() {
  const [handle] = useState(() => delayRender('Load the bundled demo fonts'));
  useEffect(() => {document.fonts.ready.then(() => continueRender(handle));}, [handle]);
  return <style>{`
    @font-face {font-family: Cantarell; src: url('${staticFile('fonts/Cantarell-VF.otf')}'); font-weight: 100 900;}
    @font-face {font-family: Syne; src: url('${staticFile('fonts/Syne.ttf')}'); font-weight: 400 800;}
    * {box-sizing: border-box;} body {margin: 0;}
  `}</style>;
}

function Mark({provider, size = 14}) {
  return <Img src={staticFile(`${provider === 'codex' ? 'openai' : 'claude'}.svg`)}
    style={{width: size, height: size, flexShrink: 0}} />;
}

function Icon({kind, size = 16, color = C.muted}) {
  const paths = {
    search: <><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 4 4"/></>,
    menu: <><path d="M3 4h10M3 8h10M3 12h10"/></>,
    refresh: <><path d="M13 6a5.2 5.2 0 1 0 .1 4M13 2v4H9"/></>,
    close: <path d="m4 4 8 8m0-8-8 8"/>,
    pin: <><path d="m6 2 5 5-2 1-1 3-3-3-3 1 1-3 3-1ZM6 10l-4 4"/></>,
    down: <path d="m4 6 4 4 4-4"/>,
    arrow: <path d="M2 8h12m-4-4 4 4-4 4"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
    stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

function Dot({size = 7}) {
  return <span style={{width: size, height: size, borderRadius: '50%', flexShrink: 0, background: C.amber}} />;
}

function Pill({label, active}) {
  return <div style={{padding: '5px 10px', borderRadius: 99, fontSize: 11, lineHeight: '16px',
    background: active ? C.amber : C.control, color: active ? C.ground : C.text}}>{label}</div>;
}

function Session({row, width, mode, selected, opening = false}) {
  const stateColor = row.state === 'Working' ? C.working : row.state === 'Waiting' || row.pending ? C.amber : C.muted;
  const title = opening ? 'Opening…' : row.title;
  const duration = row.state === 'Working' ? (row.id === 'relay' ? '2m 14s' : '1m 08s') : '4m ago';
  const text = {overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'};
  return <div style={{width, height: mode === 'comfortable' ? 68 : 22, borderRadius: 3,
    background: selected ? '#454035' : 'transparent', fontFamily: font, fontSize: 13, color: C.text}}>
    {mode === 'comfortable' ? <div style={{padding: '2px 8px', display: 'flex', flexDirection: 'column', gap: 2}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 7, height: 15, fontSize: 11, color: C.muted}}>
        <Mark provider={row.provider}/><span style={{...text, flex: 1}}>{row.folder}</span>
        {row.pinned && <Icon kind="pin" size={11}/>}
      </div>
      <div style={{height: 32, lineHeight: '16px', marginLeft: 21, overflow: 'hidden'}}>{title}</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 6, marginLeft: 21, fontSize: 11, lineHeight: '13px'}}>
        {row.unread && <Dot/>}<span style={{color: stateColor}}>{row.state}</span>
        <span style={{marginLeft: 'auto', color: C.muted}}>{duration}</span>
      </div>
    </div> : <div style={{height: 22, padding: '0 5px', display: 'flex', alignItems: 'center', gap: 6}}>
      <Mark provider={row.provider}/><span style={{...text, flex: 1}}>{title}</span>
      {row.unread && <Dot/>}<span style={{fontSize: 11, color: stateColor, whiteSpace: 'nowrap'}}>
        {row.state}{row.state === 'Working' ? ` ·${duration}` : ''}
      </span>
    </div>}
  </div>;
}

function position(index, capacity, width, rowHeight) {
  return {x: Math.floor(index / capacity) * (width + 12) + 4, y: (index % capacity) * rowHeight + 2};
}

function NativeBoard({frame, width = 900, height = 268, mode = 'compact', morph = 0,
  query = '', provider = '', pending = false, selected = '', menu = '', opening = false}) {
  const rows = rowsAt(frame, {query, provider, pending});
  const rowHeight = mode === 'comfortable' ? 68 : 22;
  const narrow = width < 680;
  const toolbarHeight = narrow ? 72 : 40;
  const contentHeight = height - toolbarHeight - 2;
  const columns = Math.max(1, Math.floor((width + 12) / 252));
  const columnWidth = Math.floor((width - 8 - 12 * (columns - 1)) / columns);
  const capacity = Math.max(1, Math.floor((contentHeight - 4) / rowHeight));
  const actualColumns = Math.ceil(rows.length / capacity);
  const compactCapacity = Math.max(1, Math.floor((contentHeight - 4) / 22));
  const morphing = morph > 0 && morph < 1;
  const beforePin = frame >= 516 && frame < 554 ? rowsAt(frame < 537 ? 515 : 536) : null;
  const pinProgress = frame < 537 ? ramp(frame, 516, 532) : ramp(frame, 537, 554);
  const reading = frame >= 602 && frame < 630;
  const readProgress = reading ? ramp(frame, 602, 618) : 0;
  const beforeRead = reading && frame < 618 ? rowsAt(601) : null;
  // Follow the focused sample after ASB's true sort moves it to a later column.
  const scroll = reading ? 2 * (columnWidth + 12) * readProgress
    : frame >= 290 && frame < 315 ? ramp(frame, 290, 306) * (columnWidth + 12) : 0;
  const rowPositions = rows.map((row, index) => {
    const target = position(index, capacity, columnWidth, rowHeight);
    if (morphing) {
      const start = position(index, compactCapacity, columnWidth, 22);
      return {x: mix(start.x, target.x, morph), y: mix(start.y, target.y, morph)};
    }
    if (beforePin) {
      const previous = position(beforePin.findIndex(old => old.id === row.id), capacity, columnWidth, rowHeight);
      return {x: mix(previous.x, target.x, pinProgress), y: mix(previous.y, target.y, pinProgress)};
    }
    if (beforeRead) {
      const previous = position(beforeRead.findIndex(old => old.id === row.id), capacity, columnWidth, rowHeight);
      return {x: mix(previous.x, target.x, readProgress), y: mix(previous.y, target.y, readProgress)};
    }
    return target;
  });
  const menuIndex = rows.findIndex(row => row.id === selected);
  const menuPosition = rowPositions[menuIndex] || {x: 4, y: 4};
  return <div style={{position: 'relative', width, height, overflow: 'hidden', borderRadius: 9,
    background: C.panel, color: C.text, fontFamily: font, boxShadow: '0 18px 40px #0008'}}>
    <div style={{height: 37, padding: '3px 4px', display: 'flex', alignItems: 'center', gap: 4}}>
      <Img src={staticFile('disc.svg')} style={{width: 16, height: 16, marginRight: 2}}/>
      <div style={{flex: 1, height: 29, minWidth: 140, background: '#383838', borderRadius: 7,
        display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px',
        boxShadow: query ? `inset 0 0 0 1px ${C.amber}` : 'none'}}>
        <Icon kind="search" size={14}/><span style={{fontSize: 13, color: query ? C.text : C.muted}}>
          {query || 'Find a session or folder'}</span>
        {query && <span style={{width: 1, height: 16, background: C.amber}}/>}
      </div>
      {!narrow && ['Codex', 'Claude', 'Pending'].map(label => <Pill key={label} label={label}
        active={label === 'Pending' ? pending : provider === label.toLowerCase()}/>)}
      {!narrow && <span style={{fontSize: 11, margin: '0 5px', color: C.muted, whiteSpace: 'nowrap'}}>
        {rows.length} sessions · {rows.filter(row => row.pending).length} Pending</span>
      }
      {['menu', 'refresh', 'close'].map(kind => <div key={kind} style={{width: 24, height: 28,
        background: kind === 'menu' && menu === 'view' ? C.control : 'transparent', borderRadius: 5,
        display: 'flex', justifyContent: 'center', alignItems: 'center'}}><Icon kind={kind} size={14}/></div>)}
    </div>
    {narrow && <div style={{position: 'absolute', top: 39, left: 4, right: 4, display: 'flex', alignItems: 'center', gap: 4}}>
      {['Codex', 'Claude', 'Pending'].map(label => <Pill key={label} label={label}
        active={label === 'Pending' ? pending : provider === label.toLowerCase()}/>)}
      <span style={{fontSize: 11, marginLeft: 7, color: C.muted}}>{rows.length} sessions · {rows.filter(row => row.pending).length} Pending</span>
    </div>}
    <div style={{position: 'absolute', top: toolbarHeight, left: 0, width, height: contentHeight, overflow: 'hidden'}}>
      <div style={{position: 'relative', transform: `translateX(${-scroll}px)`}}>
        {Array.from({length: actualColumns - 1}, (_, i) => <div key={i} style={{position: 'absolute',
          left: (i + 1) * (columnWidth + 12) - 2, top: 0, width: 1, height: contentHeight - 5, background: C.line}}/>)}
        {rows.map((row, index) => <div key={row.id} style={{position: 'absolute',
          transform: `translate(${rowPositions[index].x}px, ${rowPositions[index].y}px)`}}>
          <Session row={row} width={columnWidth} mode={mode} selected={selected === row.id} opening={opening && selected === row.id}/>
        </div>)}
      </div>
    </div>
    {actualColumns > columns && <div style={{position: 'absolute', bottom: 2, left: 5 + scroll / 4,
      height: 3, width: Math.max(40, width * columns / actualColumns), borderRadius: 4, background: '#77736b'}}/>}
    {menu === 'view' && <div style={{position: 'absolute', top: 34, right: 40, width: 250,
      background: '#333333', borderRadius: 10, padding: 14, boxShadow: '0 8px 20px #0009', fontSize: 13}}>
      <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 12}}>View
        <span style={{color: C.amber}}>{mode === 'comfortable' ? 'Comfortable' : 'Compact'}</span></div>
      <div style={{padding: '7px 8px', borderRadius: 5, background: mode === 'compact' ? '#484238' : 'transparent'}}>Compact</div>
      <div style={{padding: '7px 8px', borderRadius: 5, background: mode === 'comfortable' ? '#484238' : 'transparent'}}>Comfortable</div>
      <div style={{height: 1, background: C.line, margin: '10px 0'}}/>
      <div style={{display: 'flex', justifyContent: 'space-between', color: C.muted}}>Column width <span>240 px</span></div>
    </div>}
    {menu && menu !== 'view' && <div style={{position: 'absolute', left: menuPosition.x + 90,
      top: Math.min(height - 116, menuPosition.y + 65), width: 178,
      background: '#363636', borderRadius: 9, padding: 6, boxShadow: '0 8px 20px #000a', fontSize: 13}}>
      {menuActions(rows[menuIndex]).map(label => <div key={label}
        style={{padding: '8px 9px', background: label.toLowerCase() === menu ? '#57482b' : 'transparent', borderRadius: 5}}>{label}</div>)}
    </div>}
  </div>;
}

function Cursor({x, y, pressed = false, opacity = 1}) {
  return <div style={{position: 'absolute', left: x, top: y, opacity, transform: `scale(${pressed ? .88 : 1})`,
    transformOrigin: '0 0', zIndex: 8}}><svg width="27" height="33" viewBox="0 0 27 33">
    <path d="M2 2v25l6-7 6 11 5-3-6-10h10L2 2Z" fill={C.text} stroke="#111" strokeWidth="1.5"/>
  </svg></div>;
}

const captions = {
  unify: ['Your sessions.\nOne board.', 'Codex and Claude Desktop Code, together.'],
  states: ['State stays clear.', 'Working. Idle. Waiting. Dots stay independent.'],
  views: ['Make room.', 'Compact or Comfortable. Columns follow the window.'],
  search: ['Find the right session.', 'Use cl: for Claude. Use cx: for Codex.'],
  filters: ['Keep attention in view.', 'Choose an app. Add the Pending filter.'],
  pins: ['Keep your work close.', 'Pin in ASB. Drag to set the order.'],
  read: ['Read the dot. Keep the state.', 'Read clears ASB attention. The session stays Idle.'],
  open: ['Open it where it belongs.', 'Return to the existing session in its original app.'],
};
const starts = {unify: 60, states: 150, views: 210, search: 315, filters: 420, pins: 480, read: 585, open: 630};

function Poster({frame, closing = false}) {
  const progress = ramp(frame, closing ? 675 : 0, closing ? 691 : 23);
  return <AbsoluteFill style={{background: C.ground, color: C.text, padding: '52px 64px'}}>
    <div style={{position: 'absolute', top: 74, left: 65, overflow: 'hidden', width: 795, height: 225}}>
      <div style={{fontFamily: display, fontWeight: 800, fontSize: 210, lineHeight: 1, letterSpacing: '-.04em',
        transform: `translateY(${mix(12, 0, progress)}px)`}}>ASB<span style={{color: C.amber}}>.</span></div>
    </div>
    <Img src={staticFile('disc.svg')} style={{position: 'absolute', width: 284, height: 284, right: 64, top: 67,
      transform: `rotate(${mix(-12, 0, progress)}deg) scale(${mix(.96, 1, progress)})`}}/>
    <div style={{position: 'absolute', top: 328, left: 72, fontFamily: display, fontSize: 49,
      fontWeight: 600, letterSpacing: '-.025em', color: C.amber}}>Agent Switch Board</div>
    <div style={{position: 'absolute', top: 408, left: 75, fontFamily: font, fontSize: 32}}>
      {closing ? 'Your local sessions. Within reach.' : 'Codex + Claude. Within reach.'}</div>
    <div style={{position: 'absolute', left: 76, right: 76, top: 536, height: 1, background: C.line}}/>
    <div style={{position: 'absolute', top: 570, left: 76, right: 76, display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', fontFamily: font, fontSize: 20, color: C.muted}}>
      <span>Local session switcher for Linux GNOME</span><span style={{color: C.amber}}>v1.0.0</span>
    </div>
    {closing && <div style={{position: 'absolute', left: 76, bottom: 49, fontFamily: font, fontSize: 16, color: C.muted}}>
      github.com/Jamir-boop/ASB</div>}
  </AbsoluteFill>;
}

export function Film() {
  const frame = useCurrentFrame();
  const story = storyAt(frame);
  const {phase, query, provider, pending} = story;
  const comfortable = frame >= 247 && frame < 315 || frame >= 480 && frame < 630;
  const mode = comfortable ? 'comfortable' : 'compact';
  const morph = frame >= 247 && frame < 264 ? ramp(frame, 247, 264) : 1;
  const shrink = frame >= 270 && frame < 315 ? ramp(frame, 270, 288) : 0;
  const logicalWidth = mix(900, 630, shrink);
  const scale = 1.29;
  const boardX = 59;
  const boardY = phase === 'unify' ? 278 : 245;
  const boardHeight = 268;
  let selected = '', menu = '', cursor = null;
  if (frame >= 225 && frame < 268) menu = 'view';
  if (frame >= 488 && frame < 585) selected = 'relay';
  if (frame >= 493 && frame < 516) menu = 'pin';
  if (frame >= 585 && frame < 630) selected = 'atlas';
  if (frame >= 589 && frame < 602) menu = 'read';
  if (frame >= 630 && frame < 675) selected = 'relay';
  const toolbarHeight = logicalWidth < 680 ? 72 : 40;
  const contentHeight = boardHeight - toolbarHeight - 2;
  const columns = Math.max(1, Math.floor((logicalWidth + 12) / 252));
  const colWidth = Math.floor((logicalWidth - 8 - 12 * (columns - 1)) / columns);
  const capacity = Math.floor((contentHeight - 4) / (comfortable ? 68 : 22));
  const relayIndex = story.rows.findIndex(row => row.id === 'relay');
  const atlasIndex = story.rows.findIndex(row => row.id === 'atlas');
  const rowPoint = (index, fraction = .48) => {
    const point = position(index, capacity, colWidth, comfortable ? 68 : 22);
    return {x: boardX + (point.x + colWidth * fraction) * scale, y: boardY + (toolbarHeight + point.y + (comfortable ? 27 : 11)) * scale};
  };
  const menuPoint = (index, entry) => {
    const point = position(index, capacity, colWidth, comfortable ? 68 : 22);
    return {x: boardX + (point.x + 150) * scale,
      y: boardY + (Math.min(boardHeight - 116, point.y + 65) + 23 + entry * 33) * scale};
  };
  if (frame >= 225 && frame < 268) cursor = {x: boardX + (logicalWidth - 66) * scale, y: boardY + 22};
  if (frame >= 243 && frame < 268) cursor = {x: boardX + (logicalWidth - 180) * scale, y: boardY + 171};
  if (frame >= 426 && frame < 449) cursor = {x: boardX + 634 * scale, y: boardY + 20, pressed: frame >= 434 && frame < 439};
  if (frame >= 450 && frame < 476) cursor = {x: boardX + 697 * scale, y: boardY + 20, pressed: frame >= 456 && frame < 461};
  if (frame >= 488 && frame < 530) cursor = {...rowPoint(relayIndex), pressed: frame >= 516 && frame < 521};
  if (frame >= 493 && frame < 516) cursor = menuPoint(relayIndex, 1);
  if (frame >= 530 && frame < 565) {
    const move = ramp(frame, 533, 551);
    const from = rowPoint(2), to = rowPoint(0);
    cursor = {x: mix(from.x, to.x, move), y: mix(from.y, to.y, move), pressed: frame < 552};
  }
  if (frame >= 585 && frame < 620) cursor = rowPoint(frame >= 602 ? 3 : atlasIndex);
  if (frame >= 589 && frame < 602) cursor = menuPoint(atlasIndex, 0);
  if (frame >= 630 && frame < 650) cursor = {...rowPoint(relayIndex), pressed: frame >= 639};
  const handoff = ramp(frame, 646, 662);
  const fade = phase === 'intro' ? ramp(frame, 43, 60) : phase === 'close' ? 1 - ramp(frame, 675, 689) : 1;
  const captionProgress = ramp(frame, starts[phase] ?? 60, (starts[phase] ?? 60) + 13);
  return <AbsoluteFill style={{background: C.ground, color: C.text, fontFamily: font}}>
    <Fonts/>
    {(phase === 'intro' || phase === 'close') && <AbsoluteFill style={{opacity: phase === 'intro'
      ? 1 - ramp(frame, 43, 60) : ramp(frame, 675, 689)}}><Poster frame={frame} closing={phase === 'close'}/></AbsoluteFill>}
    <AbsoluteFill style={{opacity: fade}}>
      {captions[phase] && <div style={{position: 'absolute', top: 62, left: 62, right: 54}}>
        <div style={{overflow: 'hidden'}}><div style={{fontFamily: display, fontWeight: 600,
          fontSize: phase === 'read' ? 54 : 65, lineHeight: 1.08, letterSpacing: '-.025em', whiteSpace: 'pre-line',
          transform: `translateX(${mix(14, 0, captionProgress)}px)`,
          clipPath: `inset(0 ${mix(5, 0, captionProgress)}% 0 0)`}}>{captions[phase][0]}</div></div>
        <div style={{fontSize: 23, lineHeight: 1.3, marginTop: 18, color: C.muted}}>{captions[phase][1]}</div>
      </div>}
      <div style={{position: 'absolute', left: boardX, top: boardY, transformOrigin: '0 0',
        transform: `translateX(${mix(160, 0, ramp(frame, 47, 72))}px) scale(${scale})`,
        opacity: frame < 60 ? ramp(frame, 47, 60) : phase === 'open' ? mix(1, .32, handoff) : 1}}>
        <NativeBoard frame={frame} width={logicalWidth} height={boardHeight} mode={mode} morph={morph}
          query={query} provider={provider} pending={pending} selected={selected} menu={menu}
          opening={frame >= 640 && frame < 660}/>
      </div>
      {phase === 'views' && frame >= 274 && <div style={{position: 'absolute', right: 59, top: 277, width: 260,
        fontSize: 28, color: C.amber, lineHeight: 1.2, opacity: shrink}}>
        Same sessions.<br/>More columns.<br/><span style={{display: 'inline-block', marginTop: 22, color: C.muted, fontSize: 19}}>Scroll left to right.</span>
      </div>}
      {phase === 'states' && <div style={{position: 'absolute', left: 66, top: 625, display: 'flex', alignItems: 'center', gap: 11,
        fontSize: 20, color: C.amber}}><Dot size={9}/><span>Unread attention</span>
        <span style={{color: C.muted, marginLeft: 22}}>A dot does not change Working, Idle, or Waiting.</span></div>}
      {phase === 'pins' && <div style={{position: 'absolute', left: 65, top: 625, color: C.muted, fontSize: 20}}>
        Your ASB pin order. Original app data stays unchanged.</div>}
      {phase === 'read' && <div style={{position: 'absolute', left: 65, top: 625, color: C.muted, fontSize: 20}}>
        Manual Read and Unread belong to ASB.</div>}
      {phase === 'open' && <div style={{position: 'absolute', left: mix(760, 658, handoff), top: 281,
        width: 531, height: 280, opacity: handoff, background: '#292929', borderRadius: 10,
        boxShadow: '0 18px 40px #000b', overflow: 'hidden'}}>
        <div style={{height: 48, background: '#333', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12}}>
          <Mark provider="codex" size={22}/><span style={{fontSize: 22}}>Codex</span>
          <span style={{marginLeft: 'auto', color: C.muted, fontSize: 13}}>Original app · illustrated</span></div>
        <div style={{padding: '32px 28px'}}><span style={{fontSize: 16, color: C.muted}}>relay</span>
          <div style={{fontSize: 35, marginTop: 12}}>Relay cache</div>
          <div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 28, fontSize: 18, color: C.working}}>
            <Icon kind="arrow" color={C.working}/><span>Existing session</span></div></div>
      </div>}
      {cursor && <Cursor {...cursor}/>}
    </AbsoluteFill>
    <div style={{position: 'absolute', bottom: 20, left: 62, right: 62, display: 'flex', justifyContent: 'space-between',
      fontSize: 13, color: C.muted, letterSpacing: '.01em'}}>
      <span>Illustrative demo · Synthetic sessions · No screen recording</span><span>ASB v1.0.0</span>
    </div>
    <div style={{position: 'absolute', bottom: 0, left: 0, width: px(1280 * frame / 719), height: 2, background: C.amber}}/>
  </AbsoluteFill>;
}

export function Banner() {
  return <AbsoluteFill style={{background: C.ground, color: C.text, fontFamily: font}}>
    <Fonts/>
    <div style={{position: 'absolute', left: 62, top: 78, fontFamily: display, fontWeight: 800,
      fontSize: 184, lineHeight: 1, letterSpacing: '-.04em'}}>ASB<span style={{color: C.amber}}>.</span></div>
    <div style={{position: 'absolute', left: 72, top: 301, fontFamily: display, fontSize: 47,
      fontWeight: 600, letterSpacing: '-.025em', color: C.amber}}>Agent Switch Board</div>
    <div style={{position: 'absolute', left: 76, top: 392, width: 580, fontSize: 30, lineHeight: 1.4}}>
      Your local sessions.<br/>Within reach.</div>
    <div style={{position: 'absolute', left: 76, bottom: 105, display: 'flex', alignItems: 'center', gap: 17, fontSize: 23, color: C.muted}}>
      <Mark provider="codex" size={25}/><span>Codex</span><span style={{color: C.line}}>+</span>
      <Mark provider="claude" size={25}/><span>Claude Desktop Code</span>
    </div>
    <Img src={staticFile('disc.svg')} style={{position: 'absolute', right: 60, top: 33, width: 200, height: 200}}/>
    <div style={{position: 'absolute', left: 767, top: 119, fontFamily: display, fontWeight: 600, fontSize: 35,
      letterSpacing: '-.02em', lineHeight: 1.18}}>See the state.<br/>Open the session.</div>
    <div style={{position: 'absolute', left: 766, top: 282}}>
      <NativeBoard frame={180} width={770} height={250} selected="relay"/>
    </div>
    <div style={{position: 'absolute', left: 775, top: 547, color: C.muted, fontSize: 14}}>
      Illustrative interface · Synthetic sessions</div>
    <div style={{position: 'absolute', left: 76, right: 66, bottom: 69, height: 1, background: C.line}}/>
    <div style={{position: 'absolute', left: 76, right: 66, bottom: 27, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontSize: 18, color: C.muted}}><span>Local session switcher for Linux GNOME</span>
      <span style={{color: C.amber}}>v1.0.0</span></div>
  </AbsoluteFill>;
}
