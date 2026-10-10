const controls = Object.fromEntries(['search', 'app', 'status', 'archive', 'refresh', 'count', 'updated', 'notice', 'sessions'].map((id) => [id, document.getElementById(id)]));
let dashboard = null;
let dashboardSignature = '';
let dashboardEtag = '';
let clockMinute = -1;
let loading = false;
let refreshTimer;
let refreshQueued = false;
let refreshQueuedForce = false;
let eventStream;
const collapsedProjects = new Set();
const rowCache = new Map();
const providerGroups = new Map();
const projectGroups = new Map();
let visibleRows = [];
let emptyState;
const labels = { working: 'Working', waiting: 'Waiting', idle: 'Idle', unknown: 'Unknown' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('open-icon');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M14 5h5v5M19 5l-9 9M19 14v5H5V5h5');
  svg.append(path);
  return svg;
}

function relativeTime(value) {
  if (!value) return 'No date';
  const age = Math.max(0, Date.now() - value);
  if (age < 60_000) return 'Just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', ...(age > 31_536_000_000 ? { year: 'numeric' } : {}) });
}

async function openSession(entry) {
  const { thread, row: button } = entry;
  entry.opening = true;
  button.disabled = true;
  button.classList.add('opening');
  controls.notice.textContent = `Opening ${thread.providerLabel}…`;
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(thread.id)}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const result = await response.json();
    if (!response.ok || !result.opened) throw new Error('The app did not open. Check its desktop link handler, then try again.');
    controls.notice.textContent = `Opened ${thread.providerLabel}.`;
    refresh();
  } catch (error) {
    controls.notice.textContent = error.message;
  } finally {
    entry.opening = false;
    button.disabled = !entry.thread.canOpen;
    button.classList.remove('opening');
  }
}

function sessionRow(thread) {
  let entry = rowCache.get(thread.id);
  if (!entry) {
    const row = element('button', 'session');
    row.type = 'button';
    row.dataset.threadId = thread.id;
    row.dataset.focusKey = `session:${thread.id}`;
    const body = element('span', 'session-body');
    const title = element('span', 'session-title');
    const meta = element('span', 'session-meta');
    const state = element('span');
    const age = element('span');
    meta.append(state, element('span', '', '·'), age);
    body.append(title, meta);
    row.append(body);
    entry = { row, title, meta, state, age, opening: false };
    row.addEventListener('click', () => openSession(entry));
    rowCache.set(thread.id, entry);
  }
  entry.thread = thread;
  const signature = JSON.stringify([thread.title, thread.providerLabel, thread.state, thread.reason, thread.canOpen,
    thread.pinned, thread.archived, thread.actionRequired, thread.questionAttention, thread.unread,
    thread.lastOutcome, thread.failedAttention, thread.completionAttention]);
  setText(entry.age, relativeTime(thread.updatedAtMs));
  if (entry.signature === signature) return entry.row;
  entry.signature = signature;
  const indicator = thread.actionRequired || thread.questionAttention ? 'question' : thread.unread ? 'dot'
    : thread.state === 'idle' && thread.lastOutcome === 'stopped' ? 'stop' : '';
  const attention = thread.actionRequired ? 'A user action is required in the original app.'
    : indicator === 'question' ? 'A question needs your answer.' : indicator === 'dot' ? 'Unread in ASB.' : '';
  const outcome = thread.lastOutcome === 'stopped' ? 'Task stopped.' : thread.lastOutcome === 'failed' || thread.failedAttention
    ? 'Task failed.' : thread.completionAttention ? 'Task completed.' : '';
  const { row, title, meta, state } = entry;
  row.disabled = entry.opening || !thread.canOpen;
  row.setAttribute('aria-label', `Open ${thread.title} in ${thread.providerLabel}. ${labels[thread.state]}. ${attention} ${outcome}`.trim());
  row.title = thread.canOpen ? `Open in ${thread.providerLabel}` : 'This session has no direct desktop link.';
  if (attention) row.title += ` ${attention}`;
  if (outcome) row.title += ` ${outcome}`;
  setText(title, thread.title);
  state.className = `state ${thread.state}`;
  setText(state, labels[thread.state] || 'Unknown');
  state.title = thread.reason;
  for (const [key, text] of [['pinned', '· Pinned'], ['archived', '· Archived']]) {
    if (thread[key] && !entry[key]) {
      entry[key] = element('span', '', text);
      meta.insertBefore(entry[key], key === 'pinned' ? entry.archived || null : null);
    }
    else if (!thread[key] && entry[key]) { entry[key].remove(); entry[key] = null; }
  }
  if (indicator) {
    const mark = entry.mark ||= element('span');
    mark.className = `attention ${indicator}`;
    setText(mark, indicator === 'question' ? '?' : '');
    mark.setAttribute('aria-hidden', 'true');
    if (mark.parentNode !== row) row.insertBefore(mark, entry.icon || null);
  } else if (entry.mark) { entry.mark.remove(); entry.mark = null; }
  if (thread.canOpen && !entry.icon) { entry.icon = icon(); row.append(entry.icon); }
  else if (!thread.canOpen && entry.icon) { entry.icon.remove(); entry.icon = null; }
  return row;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function syncChildren(parent, children) {
  let next = parent.firstChild;
  for (const child of children) {
    if (child === next) next = next.nextSibling;
    else parent.insertBefore(child, next);
  }
  while (next) { const sibling = next.nextSibling; next.remove(); next = sibling; }
}

function updateRelativeTimes() {
  const minute = Math.floor(Date.now() / 60_000);
  if (clockMinute === minute) return;
  clockMinute = minute;
  for (const entry of visibleRows) setText(entry.age, relativeTime(entry.thread.updatedAtMs));
}

function render() {
  if (!dashboard) return;
  const focused = document.activeElement;
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const currentThreads = new Map(dashboard.threads.map((thread) => [thread.id, thread]));
  for (const [id, entry] of rowCache) {
    if (currentThreads.has(id)) entry.thread = currentThreads.get(id);
    else { entry.row.remove(); rowCache.delete(id); }
  }
  const query = controls.search.value.trim().toLocaleLowerCase();
  const threads = dashboard.threads.filter((thread) => (controls.archive.checked || !thread.archived)
    && (controls.app.value === 'all' || thread.provider === controls.app.value)
    && (controls.status.value === 'all' || thread.state === controls.status.value)
    && (!query || [thread.title, thread.projectName, thread.cwd, thread.providerLabel].join('\n').toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAtMs - a.updatedAtMs);
  const sections = [];
  const projectKeys = new Set();
  visibleRows = [];
  for (const provider of dashboard.providers) {
    const appThreads = threads.filter((thread) => thread.provider === provider.id);
    if (!appThreads.length) continue;
    let group = providerGroups.get(provider.id);
    if (!group) {
      const section = element('section', 'app-group');
      const heading = element('h2', 'app-title', provider.label);
      const count = element('span');
      heading.append(count);
      group = { section, heading, count, label: provider.label };
      providerGroups.set(provider.id, group);
    }
    const { section, heading, count } = group;
    if (group.label !== provider.label) { heading.textContent = provider.label; heading.append(count); group.label = provider.label; }
    setText(count, String(appThreads.length));
    const children = [heading];
    const projects = new Map();
    for (const thread of appThreads) {
      const key = thread.cwd || '';
      if (!projects.has(key)) projects.set(key, []);
      projects.get(key).push(thread);
    }
    for (const [cwd, items] of projects) {
      const key = `${provider.id}:${cwd}`;
      projectKeys.add(key);
      let group = projectGroups.get(key);
      if (!group) {
        const project = element('details', 'project');
        const summary = element('summary');
        summary.dataset.focusKey = `project:${key}`;
        summary.title = cwd || 'No project path';
        const name = element('span', 'project-name');
        const count = element('span', 'project-count');
        summary.append(name, count);
        group = { project, summary, name, count };
        projectGroups.set(key, group);
        project.addEventListener('toggle', () => {
          if (project.open === group.open) return;
          group.open = project.open;
          if (project.open) collapsedProjects.delete(key); else collapsedProjects.add(key);
        });
      }
      const { project, summary, name, count } = group;
      const open = Boolean(query) || !collapsedProjects.has(key);
      group.open = open;
      if (project.open !== open) project.open = open;
      setText(name, items[0].projectName);
      setText(count, String(items.length));
      const rows = items.map(sessionRow);
      visibleRows.push(...items.map((thread) => rowCache.get(thread.id)));
      syncChildren(project, [summary, ...rows]);
      children.push(project);
    }
    syncChildren(section, children);
    sections.push(section);
  }
  if (!threads.length) {
    if (!emptyState) {
      const empty = element('div', 'empty');
      const title = element('strong'), detail = element('p');
      empty.append(title, detail);
      emptyState = { empty, title, detail };
    }
    const noSessions = !dashboard.threads.length;
    setText(emptyState.title, noSessions ? 'No desktop sessions found' : 'No matching sessions');
    setText(emptyState.detail, noSessions ? 'Create a session in Codex or Claude Desktop Code, then refresh.' : 'Change the search or filters to see more sessions.');
    sections.push(emptyState.empty);
  }
  syncChildren(controls.sessions, sections);
  for (const [id, group] of providerGroups) if (!sections.includes(group.section)) providerGroups.delete(id);
  for (const key of projectGroups.keys()) if (!projectKeys.has(key)) projectGroups.delete(key);
  setText(controls.count, `${threads.length} ${threads.length === 1 ? 'session' : 'sessions'}`);
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
}

async function refresh(force = false) {
  if (loading) { refreshQueued = true; refreshQueuedForce ||= force; return; }
  force ||= refreshQueuedForce;
  refreshQueued = false;
  refreshQueuedForce = false;
  clearTimeout(refreshTimer);
  loading = true;
  controls.refresh.disabled = true;
  controls.sessions.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/dashboard${force ? '?force=1' : ''}`, {
      cache: 'no-store', headers: dashboardEtag ? { 'If-None-Match': dashboardEtag } : {},
    });
    if (response.status === 304) {
      if (!dashboard) throw new Error('Cannot load sessions. Check that ASB is running, then refresh.');
    } else {
      if (!response.ok) throw new Error('Cannot load sessions. Check that ASB is running, then refresh.');
      dashboard = await response.json();
      dashboardEtag = response.headers?.get('ETag') || '';
      setText(controls.updated, `Updated ${new Date(dashboard.generatedAtMs).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`);
      controls.updated.dateTime = new Date(dashboard.generatedAtMs).toISOString();
      const signature = JSON.stringify([dashboard.threads, dashboard.providers, dashboard.pinnedOrder]);
      if (signature !== dashboardSignature) {
        render();
        dashboardSignature = signature;
      }
    }
    setText(controls.notice, dashboard.providers.filter((provider) => provider.message).map((provider) => provider.message).join(' '));
    updateRelativeTimes();
  } catch (error) {
    dashboardEtag = '';
    controls.notice.textContent = error.message;
    if (!dashboard) controls.count.textContent = 'Sessions are not available';
  } finally {
    loading = false;
    controls.refresh.disabled = false;
    controls.sessions.setAttribute('aria-busy', 'false');
    refreshTimer = setTimeout(() => { if (!document.hidden) refresh(); }, refreshQueued ? 250
      : dashboard?.refreshIntervalMs === 2_000 ? 2_000 : 5_000);
  }
}
function listenForChanges() {
  eventStream?.close();
  eventStream = null;
  if (document.hidden || typeof EventSource !== 'function') return;
  eventStream = new EventSource('/api/events');
  eventStream.addEventListener('dashboard', () => { if (!document.hidden) refresh(); });
}
controls.search.addEventListener('input', render);
for (const id of ['app', 'status', 'archive']) controls[id].addEventListener('change', render);
controls.refresh.addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => {
  listenForChanges();
  if (!document.hidden) refresh(); else clearTimeout(refreshTimer);
});
window.addEventListener('pagehide', () => { eventStream?.close(); clearTimeout(refreshTimer); });
listenForChanges();
refresh();
