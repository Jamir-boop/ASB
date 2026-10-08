import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Img, continueRender, delayRender, staticFile, useCurrentFrame} from 'remotion';
import {conversations, rowsAt, samples, storyAt} from './story.mjs';

const C = {ground: '#111113', panel: '#242424', control: '#343434', text: '#f6f3ed',
  muted: '#b3b0aa', line: '#4a4844', amber: '#ffb900', working: '#8fce8a'};
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => 1 - Math.pow(1 - clamp(value), 4);
const ramp = (frame, start, end) => ease((frame - start) / (end - start));
const mix = (a, b, value) => a + (b - a) * value;
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
    back: <path d="M14 8H2m4-4-4 4 4 4"/>,
    plus: <path d="M8 2v12M2 8h12"/>,
    folder: <path d="M2 4h5l2 2h5v7H2V4Zm0 3h12"/>,
    home: <path d="m2 7 6-5 6 5v7h-4v-4H6v4H2V7Z"/>,
    panel: <path d="M2 2h12v12H2V2Zm4 0v12"/>,
    clock: <><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></>,
    chat: <path d="M2 2h12v9H7l-4 3v-3H2V2Z"/>,
    terminal: <><rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="m4 5 3 3-3 3m5 0h3"/></>,
    check: <path d="m3 8 3 3 7-7"/>,
    compose: <path d="m9 3 4-1 1 1-1 4-7 7H2v-4l7-7Zm-7 0v11h11"/>,
    artifacts: <><path d="M3 6h10v8H3V6Zm2 0V3h6v3M1 9h14"/></>,
    sliders: <><path d="M2 4h12M2 12h12"/><circle cx="6" cy="4" r="2" fill={C.ground}/><circle cx="10" cy="12" r="2" fill={C.ground}/></>,
    branch: <><circle cx="4" cy="3" r="2"/><circle cx="4" cy="13" r="2"/><circle cx="12" cy="3" r="2"/><path d="M4 5v6m0-3h4c3 0 4-1 4-3"/></>,
    bell: <path d="M3 11h10l-1-3V6a4 4 0 0 0-8 0v2l-1 3Zm3 2h4"/>,
    dots: <><circle cx="3" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="13" cy="8" r=".6"/></>,
    up: <path d="M8 14V2m-4 4 4-4 4 4"/>,
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

function NativeBoard({frame, width = 355, height = 400, selected = '', opening = false}) {
  const rows = rowsAt(frame);
  const narrow = width < 680;
  const toolbarHeight = narrow ? 72 : 40;
  const rowHeight = 22;
  const columns = Math.max(1, Math.floor((width + 12) / 252));
  const columnWidth = Math.floor((width - 8 - 12 * (columns - 1)) / columns);
  const capacity = Math.max(1, Math.floor((height - toolbarHeight - 6) / rowHeight));
  const actualColumns = Math.ceil(rows.length / capacity);
  return <div style={{position: 'relative', width, height, overflow: 'hidden', borderRadius: 9,
    background: C.panel, color: C.text, fontFamily: font, boxShadow: '0 14px 32px #0009'}}>
    <div style={{height: 37, padding: '3px 4px', display: 'flex', alignItems: 'center', gap: 4}}>
      <Img src={staticFile('disc.svg')} style={{width: 16, height: 16, marginRight: 2}}/>
      <div style={{flex: 1, height: 29, minWidth: 140, background: '#383838', borderRadius: 7,
        display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px'}}>
        <Icon kind="search" size={14}/><span style={{fontSize: 13, color: C.muted, whiteSpace: 'nowrap'}}>Find a session or folder</span>
      </div>
      {!narrow && ['Codex', 'Claude', 'Pending'].map(label => <Pill key={label} label={label}/>)}
      {['menu', 'refresh', 'close'].map(kind => <div key={kind} style={{width: 24, height: 28,
        display: 'flex', justifyContent: 'center', alignItems: 'center'}}><Icon kind={kind} size={14}/></div>)}
    </div>
    {narrow && <div style={{position: 'absolute', top: 39, left: 4, right: 4, display: 'flex', alignItems: 'center', gap: 4}}>
      {['Codex', 'Claude', 'Pending'].map(label => <Pill key={label} label={label}/>)}
      <span style={{fontSize: 11, marginLeft: 4, color: C.muted, whiteSpace: 'nowrap'}}>{rows.length} sessions</span>
    </div>}
    <div style={{position: 'absolute', top: toolbarHeight, left: 0, width, height: height - toolbarHeight, overflow: 'hidden'}}>
      {Array.from({length: actualColumns - 1}, (_, i) => <div key={i} style={{position: 'absolute',
        left: (i + 1) * (columnWidth + 12) - 2, top: 0, width: 1, height: height - toolbarHeight, background: C.line}}/>)}
      {rows.map((row, index) => {
        const point = position(index, capacity, columnWidth, rowHeight);
        return <div key={row.id} style={{position: 'absolute', left: point.x, top: point.y}}>
          <Session row={row} width={columnWidth} mode="compact" selected={row.id === selected}
            opening={opening && row.id === selected}/></div>;
      })}
    </div>
  </div>;
}

function Cursor({x, y, pressed = false, opacity = 1}) {
  return <div style={{position: 'absolute', left: x, top: y, opacity, transform: `scale(${pressed ? .88 : 1})`,
    transformOrigin: '0 0', zIndex: 8}}><svg width="27" height="33" viewBox="0 0 27 33">
    <path d="M2 2v25l6-7 6 11 5-3-6-10h10L2 2Z" fill={C.text} stroke="#111" strokeWidth="1.5"/>
  </svg></div>;
}

function WindowControls() {
  return <div style={{display: 'flex', gap: 16, alignItems: 'center', color: C.muted}}>
    <svg width="10" height="12"><path d="M1 8h8" stroke="currentColor"/></svg>
    <svg width="10" height="12"><rect x="1" y="2" width="8" height="8" fill="none" stroke="currentColor"/></svg>
    <Icon kind="close" size={13}/>
  </div>;
}

function SidebarItem({title, icon, selected = false, dot = false, height = 30}) {
  return <div style={{display: 'flex', alignItems: 'center', gap: 9, height, padding: '0 9px',
    borderRadius: 6, background: selected ? '#30302e' : 'transparent', color: selected ? C.text : '#c7c6c1',
    fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden'}}>
    {icon && <Icon kind={icon} size={14}/>}
    {dot && <span style={{width: 5, height: 5, borderRadius: '50%', background: selected ? C.text : '#6d6d68', flexShrink: 0}}/>}
    <span style={{overflow: 'hidden', textOverflow: 'ellipsis', flex: 1}}>{title}</span>
    {selected && <Icon kind="dots" size={12}/>}
  </div>;
}

function CodexSidebar({row}) {
  return <>
    <div style={{width: 43, flexShrink: 0, background: '#090909', borderRight: '1px solid #191919',
      padding: '10px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22}}>
      {['home', 'artifacts', 'clock', 'chat', 'dots', 'branch'].map((kind, i) => <div key={kind}
        style={{height: 25, width: 27, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: i === 0 ? '#222' : 'transparent', borderRadius: 8}}><Icon kind={kind} size={17} color={i === 0 ? C.text : '#999993'}/></div>)}
      <div style={{marginTop: 'auto', width: 24, height: 24, borderRadius: '50%', background: '#35677f',
        display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: 10}}>S</div>
    </div>
    <div style={{width: 187, flexShrink: 0, padding: '9px 9px', background: '#0b0b0b', borderRight: '1px solid #1a1a1a'}}>
      <div style={{height: 33, display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 7, fontSize: 17, fontWeight: 600}}>
        Codex<Icon kind="down" size={12}/><span style={{marginLeft: 'auto'}}><Icon kind="bell" size={14}/></span><Icon kind="search" size={14}/>
      </div>
      <SidebarItem title="New chat" icon="compose"/>
      <SidebarItem title="Sample workspace" icon="folder"/>
      <div style={{margin: '18px 8px 11px', color: '#aaa9a3', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6}}>
        Projects<Icon kind="arrow" size={11}/></div>
      <div style={{margin: '19px 8px 8px', color: '#aaa9a3', fontSize: 12}}>Recents</div>
      {samples.filter(item => item.provider === 'codex').map(item => <SidebarItem key={item.id}
        title={item.title} selected={item.id === row.id}/>)}
    </div>
  </>;
}

function ClaudeSidebar({row}) {
  return <div style={{width: 214, flexShrink: 0, padding: '8px 10px', background: '#191a18',
    borderRight: '1px solid #30312d', display: 'flex', flexDirection: 'column'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 16, height: 27, marginBottom: 7}}>
      <Icon kind="menu" size={14}/><Icon kind="panel" size={14}/><Icon kind="back" size={14}/><Icon kind="arrow" size={14}/>
      <div style={{marginLeft: 'auto', background: '#343530', borderRadius: 5, padding: '3px 6px',
        fontFamily: 'monospace', fontSize: 12}}>&lt;/&gt;</div>
    </div>
    <div style={{height: 28, background: '#23241f', border: '1px solid #3a3b35', borderRadius: 5,
      display: 'flex', gap: 8, alignItems: 'center', padding: '0 9px', color: '#b4b4aa', fontSize: 13, marginBottom: 6}}>
      <Icon kind="search" size={13}/>Search</div>
    {['New', 'Projects', 'Artifacts', 'Routines', 'Customize'].map((title, i) => <SidebarItem key={title}
      title={title} height={26} icon={['plus', 'folder', 'artifacts', 'clock', 'sliders'][i]}/>)}
    <div style={{margin: '19px 9px 8px', fontSize: 11, color: '#adada3'}}>Routines</div>
    <SidebarItem title="Daily check" dot height={26}/>
    {['atlas', 'orchid', 'harbor', 'relay'].map(folder => <div key={folder}>
      <div style={{margin: '17px 8px 5px', color: '#adada3', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4}}>
        <span>{folder}</span><span style={{overflow: 'hidden', whiteSpace: 'nowrap', flex: 1}}> · ~/projects/{folder}</span><Icon kind="plus" size={12}/>
      </div>
      {samples.filter(item => item.provider === 'claude' && item.folder === folder).slice(0, 2).map(item => <SidebarItem key={item.id}
        title={item.title} selected={item.id === row.id} dot height={26}/>)}
    </div>)}
    <div style={{marginTop: 'auto', height: 30, paddingTop: 8, borderTop: '1px solid #383934',
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#c7c6bf'}}>
      <div style={{width: 19, height: 19, borderRadius: '50%', background: '#526175', display: 'flex',
        justifyContent: 'center', alignItems: 'center', color: C.text, fontSize: 10}}>S</div>Sample account<Icon kind="down" size={11}/>
    </div>
  </div>;
}

function Conversation({row}) {
  const claude = row.provider === 'claude';
  const chat = conversations[row.id] || conversations.atlas;
  const muted = claude ? '#b3b4aa' : '#aaa9a3';
  return <div style={{flex: 1, minWidth: 0, background: claude ? '#22231f' : '#0d0d0d',
    position: 'relative', display: 'flex', flexDirection: 'column'}}>
    <div style={{height: 47, padding: '0 19px', display: 'flex', alignItems: 'center', gap: 9,
      borderBottom: `1px solid ${claude ? '#36372f' : '#202020'}`}}>
      <Icon kind="folder" size={14}/><span style={{fontSize: 16, fontWeight: 600}}>{row.title}</span>
      <span style={{fontSize: 12, color: muted, marginLeft: 6}}>{row.folder}</span>
      <span style={{marginLeft: 'auto'}}><Icon kind="dots" size={16}/></span>
    </div>
    <div style={{padding: '20px 26px', flex: 1, overflow: 'hidden', fontSize: 14, lineHeight: '22px'}}>
      <div style={{marginLeft: 64, background: claude ? '#303129' : '#242424', padding: '12px 16px', borderRadius: 13,
        color: C.text, marginBottom: 20}}>{chat.request}</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, color: muted, fontSize: 12, marginBottom: 12}}>
        <Mark provider={row.provider} size={16}/>{claude ? 'Claude' : 'Worked for 1m 42s'}<Icon kind="down" size={11}/>
      </div>
      <p style={{margin: '0 0 14px'}}>{chat.response}</p>
      <div style={{display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: muted, margin: '10px 0 14px'}}>
        <Icon kind="terminal" size={14}/>{chat.tool}<Icon kind="down" size={11}/>
      </div>
      <p style={{margin: '0 0 15px'}}>{chat.detail}</p>
      <div style={{background: claude ? '#2b2c26' : '#191919', borderRadius: 6, padding: '9px 13px',
        fontSize: 12, lineHeight: '22px', marginBottom: 15}}>
        {chat.files.map(file => <div key={file} style={{display: 'flex', gap: 9, alignItems: 'center'}}>
          <Icon kind="check" size={12} color="#8fce8a"/><span style={{fontFamily: 'monospace'}}>{file}</span>
        </div>)}
      </div>
      <p style={{margin: 0}}>{chat.result}</p>
      <div style={{display: 'flex', alignItems: 'center', gap: 14, marginTop: 14, color: muted}}>
        <Icon kind="artifacts" size={13}/><Icon kind="check" size={13}/><Icon kind="dots" size={13}/>
      </div>
    </div>
    <div style={{margin: '0 20px 16px', border: `1px solid ${claude ? '#494b40' : '#303030'}`,
      borderRadius: 15, height: 94, padding: '11px 13px', background: claude ? '#2b2c25' : '#171717'}}>
      <div style={{fontSize: 13, color: muted}}>{claude ? 'Reply…' : 'Do anything'}</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 27}}>
        <Icon kind="plus" size={16}/>
        <div style={{fontSize: 11, color: muted}}>{claude ? 'Code' : 'Local'}</div>
        <span style={{marginLeft: 'auto', fontSize: 11, color: '#c5c4bd'}}>{claude ? 'Sonnet' : 'GPT-6.1 Sol'}</span>
        <Icon kind="down" size={11}/>
        <div style={{background: '#3c3d35', width: 23, height: 23, borderRadius: '50%', display: 'flex',
          justifyContent: 'center', alignItems: 'center'}}><Icon kind="up" size={12}/></div>
      </div>
    </div>
  </div>;
}

function AppWindow({provider, row, focused}) {
  const claude = provider === 'claude';
  return <div style={{position: 'absolute', left: claude ? 411 : 395, top: claude ? 55 : 43,
    width: 853, height: 634, borderRadius: 10, overflow: 'hidden', color: C.text,
    boxShadow: focused ? '0 15px 35px #000a' : '0 8px 20px #0007', zIndex: focused ? 4 : 2}}>
    <div style={{height: 27, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
      background: focused ? '#242424' : '#303030', color: focused ? C.text : C.muted}}>
      <Mark provider={provider} size={12}/><span style={{fontSize: 11}}>{claude ? 'Claude' : 'Codex'}</span>
      <span style={{marginLeft: 'auto'}}><WindowControls/></span>
    </div>
    <div style={{height: 607, display: 'flex'}}>
      {claude ? <ClaudeSidebar row={row}/> : <CodexSidebar row={row}/>}<Conversation row={row}/>
    </div>
  </div>;
}

export function Film() {
  const frame = useCurrentFrame();
  const story = storyAt(frame);
  const {handoff} = story;
  const boardX = 20, boardY = 176, boardWidth = 355, boardHeight = 400;
  const beforeRows = rowsAt(handoff.click - 1);
  const rowIndex = beforeRows.findIndex(row => row.id === handoff.row.id);
  const rowPoint = {x: boardX + 145, y: boardY + 72 + 2 + rowIndex * 22 + 11};
  const appPoint = {x: 1064, y: 522};
  const approach = ramp(frame, handoff.start + 28, handoff.click - 2);
  const depart = ramp(frame, handoff.opened + 10, handoff.opened + 32);
  const cursor = frame < handoff.opened ? {
    x: mix(appPoint.x, rowPoint.x, approach), y: mix(appPoint.y, rowPoint.y, approach),
  } : {x: mix(rowPoint.x, appPoint.x, depart), y: mix(rowPoint.y, appPoint.y, depart)};
  return <AbsoluteFill style={{background: '#16181c', color: C.text, fontFamily: font}}>
    <Fonts/>
    <div style={{height: 27, background: '#101010', padding: '0 20px', display: 'flex', alignItems: 'center',
      gap: 27, fontSize: 12, fontWeight: 600}}>
      <span>Activities</span><span>{story.activeApp}</span>
      <span style={{position: 'absolute', left: 594}}>Oct 7 · 14:32</span>
      <span style={{marginLeft: 'auto', display: 'flex', gap: 13}}><Icon kind="sliders" size={13}/><Icon kind="down" size={12}/></span>
    </div>
    <AppWindow provider="codex" row={story.apps.codex} focused={story.focusedProvider === 'codex'}/>
    <AppWindow provider="claude" row={story.apps.claude} focused={story.focusedProvider === 'claude'}/>
    <div style={{position: 'absolute', left: boardX, top: boardY, zIndex: 5}}>
      <NativeBoard frame={frame} width={boardWidth} height={boardHeight} selected={story.selected} opening={story.opening}/>
    </div>
    <div style={{position: 'absolute', left: 22, bottom: 21, fontSize: 12, color: '#b3b0aa'}}>sample sessions · illustrated desktop</div>
    <Cursor {...cursor} pressed={frame >= handoff.click && frame < handoff.click + 6}/>
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
