export const FPS = 30;
export const FRAMES = 660;
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

export const switches = [
  {id: 'atlas', start: 0, click: 60, opened: 78},
  {id: 'relay', start: 156, click: 216, opened: 234},
  {id: 'orchid', start: 312, click: 372, opened: 390},
  {id: 'harbor', start: 468, click: 528, opened: 546},
];

// All messages below are existing, synthetic conversation history. The composer stays empty.
export const conversations = {
  atlas: {
    request: 'Update the install guide to match the current CLI flags.',
    response: 'I checked the CLI help and updated the install guide. The examples now use the same flag names as the command.',
    tool: 'Read docs/install.md and src/cli.mjs',
    detail: 'The guide includes the config path, an export example, and the command to check the installed version.',
    files: ['docs/install.md', 'docs/cli.md'],
    result: 'Documentation checks passed. The examples use only sample paths.',
  },
  relay: {
    request: 'Fix the cache key for queries with repeated parameters.',
    response: 'The key builder now keeps repeated values in order. I added a check for repeated parameters and an empty query.',
    tool: 'Ran commands · npm test',
    detail: 'The fix is in the shared key builder, so both request paths use the same result.',
    files: ['src/cache-key.mjs', 'test/cache-key.test.mjs'],
    result: '42 tests passed. The repeated-parameter check passed.',
  },
  orchid: {
    request: 'Check whether the search index handles an empty document.',
    response: 'An empty document is now skipped before indexing. Search still returns the other documents in the expected order.',
    tool: 'Read src/indexer.mjs · Ran the index checks',
    detail: 'The change uses the existing document check. No new package is needed.',
    files: ['src/indexer.mjs', 'test/indexer.test.mjs'],
    result: 'The empty-document and search-order checks passed.',
  },
  harbor: {
    request: 'Check the pagination response for the Harbor API.',
    response: 'The response includes the next cursor only when another page exists. The final page has no next cursor.',
    tool: 'Ran commands · node --test test/paging.test.mjs',
    detail: 'The first page, an empty result, and the final page all use the same response shape.',
    files: ['src/routes/items.mjs', 'test/paging.test.mjs'],
    result: 'The pagination checks passed. I am checking the route fixtures.',
  },
};

export function rowsAt(frame) {
  const acknowledged = new Set(switches.filter(action => frame >= action.opened).map(action => action.id));
  const rows = samples.map(row => ({...row, unread: row.unread && !acknowledged.has(row.id),
    pending: row.pending && !acknowledged.has(row.id)}));
  const bucket = row => row.pending || row.state === 'Waiting' ? 0 : ({Working: 1, Idle: 2, Unknown: 3}[row.state]);
  return rows.sort((a, b) => a.pinned !== b.pinned ? Number(b.pinned) - Number(a.pinned)
    : a.pinned ? a.index - b.index : bucket(a) - bucket(b) || a.index - b.index);
}

export function storyAt(frame) {
  const action = switches.findLast(action => frame >= action.start);
  const row = samples.find(row => row.id === action.id);
  const apps = {codex: samples.find(row => row.id === 'harbor'), claude: samples.find(row => row.id === 'orchid')};
  let focusedProvider = 'codex';
  let selected = 'harbor';
  for (const action of switches) {
    const row = samples.find(row => row.id === action.id);
    if (frame >= action.click) selected = row.id;
    if (frame >= action.opened) {apps[row.provider] = row; focusedProvider = row.provider;}
  }
  const opening = frame >= action.click && frame < action.opened;
  return {phase: 'desktop', rows: rowsAt(frame), apps, focusedProvider, selected, opening,
    activeApp: opening ? 'ASB' : focusedProvider === 'codex' ? 'Codex' : 'Claude',
    handoff: {...action, row, frame: frame - action.start}};
}
