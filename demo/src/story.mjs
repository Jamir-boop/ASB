export const FPS = 30;
export const FRAMES = 720;
export const samples = [
  ['harbor', 'Harbor API', 'harbor', 'codex', 'Working', false, true],
  ['orchid', 'Orchid index', 'orchid', 'claude', 'Idle', false, true],
  ['relay', 'Relay cache', 'relay', 'codex', 'Working', true],
  ['atlas', 'Atlas docs', 'atlas', 'claude', 'Idle', true],
  ['schema', 'Review schema', 'harbor', 'codex', 'Waiting', true],
  ['export', 'Approve export', 'mariner', 'claude', 'Waiting', true],
  ['route', 'Route tests', 'nimbus', 'codex', 'Working'],
  ['menu', 'Menu focus', 'orchid', 'claude', 'Working'],
  ['search', 'Search parser', 'relay', 'codex', 'Working'],
  ['docs', 'CLI docs', 'atlas', 'claude', 'Working'],
  ['theme', 'Theme contrast', 'orchid', 'codex', 'Idle'],
  ['paging', 'Cursor paging', 'harbor', 'claude', 'Idle'],
  ['fixtures', 'Test fixtures', 'nimbus', 'codex', 'Idle'],
  ['links', 'Session links', 'relay', 'claude', 'Idle'],
  ['license', 'License notes', 'atlas', 'codex', 'Idle'],
  ['icons', 'Icon export', 'orchid', 'claude', 'Idle'],
  ['render', 'Render queue', 'mariner', 'codex', 'Idle'],
  ['locale', 'Locale labels', 'atlas', 'claude', 'Idle'],
  ['clock', 'Clock labels', 'relay', 'codex', 'Idle'],
  ['layout', 'Column layout', 'orchid', 'claude', 'Idle'],
  ['notes', 'Release notes', 'nimbus', 'codex', 'Idle'],
  ['archive', 'Archive lookup', 'harbor', 'claude', 'Unknown'],
  ['legacy', 'Legacy adapter', 'mariner', 'codex', 'Unknown'],
  ['import', 'Import map', 'relay', 'claude', 'Unknown'],
].map(([id, title, folder, provider, state, unread = false, pinned = false], index) => ({
  id, title, folder, provider, state, unread, pinned, index,
  pending: unread && state !== 'Working',
}));

export function rowsAt(frame, {query = '', provider = '', pending = false} = {}) {
  let rows = samples.map(row => ({...row}));
  if (frame >= 516) rows.find(row => row.id === 'relay').pinned = true;
  if (frame >= 602) Object.assign(rows.find(row => row.id === 'atlas'), {unread: false, pending: false});
  const pinOrder = frame >= 537 ? ['relay', 'harbor', 'orchid'] : ['harbor', 'orchid', 'relay'];
  const match = query.match(/^(cl|cx):\s*(.*)$/i);
  if (match) {
    provider = match[1].toLowerCase() === 'cl' ? 'claude' : 'codex';
    query = match[2];
  }
  rows = rows.filter(row => (!provider || row.provider === provider)
    && (!pending || row.pending)
    && `${row.title}\n${row.folder}`.toLowerCase().includes(query.toLowerCase()));
  const bucket = row => row.pending || row.state === 'Waiting' ? 0 : ({Working: 1, Idle: 2, Unknown: 3}[row.state]);
  return rows.sort((a, b) => a.pinned !== b.pinned ? Number(b.pinned) - Number(a.pinned)
    : a.pinned ? pinOrder.indexOf(a.id) - pinOrder.indexOf(b.id)
    : bucket(a) - bucket(b) || a.index - b.index);
}

export const menuActions = row => [row.unread ? 'Read' : 'Unread', row.pinned ? 'Unpin' : 'Pin'];

export function storyAt(frame) {
  let query = '', provider = '', pending = false;
  if (frame >= 326 && frame < 378) query = 'cl: docs'.slice(0, Math.min(8, Math.floor((frame - 326) / 3) + 1));
  if (frame >= 378 && frame < 420) query = 'cx: relay'.slice(0, Math.min(9, Math.floor((frame - 378) / 3) + 1));
  if (frame >= 435 && frame < 480) provider = 'claude';
  if (frame >= 457 && frame < 480) pending = true;
  const phase = frame < 60 ? 'intro' : frame < 150 ? 'unify' : frame < 210 ? 'states'
    : frame < 315 ? 'views' : frame < 420 ? 'search' : frame < 480 ? 'filters'
    : frame < 585 ? 'pins' : frame < 630 ? 'read' : frame < 675 ? 'open' : 'close';
  return {phase, query, provider, pending, rows: rowsAt(frame, {query, provider, pending})};
}
