const controls = Object.fromEntries(['search', 'app', 'status', 'archive', 'refresh', 'count', 'updated', 'notice', 'sessions'].map((id) => [id, document.getElementById(id)]));
let dashboard = null;
let dashboardSignature = '';
let loading = false;
let refreshTimer;
let refreshQueued = false;
let eventStream;
const collapsedProjects = new Set();
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

async function openSession(thread, button) {
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
  } catch (error) {
    controls.notice.textContent = error.message;
  } finally {
    button.disabled = !thread.canOpen;
    button.classList.remove('opening');
  }
}

function sessionRow(thread) {
  const indicator = thread.actionRequired || thread.questionAttention ? 'question' : thread.unread ? 'dot'
    : thread.state === 'idle' && thread.lastOutcome === 'stopped' ? 'stop' : '';
  const attention = thread.actionRequired ? 'A user action is required in the original app.'
    : indicator === 'question' ? 'A question needs your answer.' : indicator === 'dot' ? 'Unread in ASB.' : '';
  const outcome = thread.lastOutcome === 'stopped' ? 'Task stopped.' : thread.lastOutcome === 'failed' || thread.failedAttention
    ? 'Task failed.' : thread.completionAttention ? 'Task completed.' : '';
  const row = element('button', 'session');
  row.type = 'button';
  row.disabled = !thread.canOpen;
  row.setAttribute('aria-label', `Open ${thread.title} in ${thread.providerLabel}. ${labels[thread.state]}. ${attention} ${outcome}`.trim());
  row.title = thread.canOpen ? `Open in ${thread.providerLabel}` : 'This session has no direct desktop link.';
  if (attention) row.title += ` ${attention}`;
  if (outcome) row.title += ` ${outcome}`;
  row.dataset.threadId = thread.id;
  row.dataset.focusKey = `session:${thread.id}`;
  const body = element('span', 'session-body');
  const meta = element('span', 'session-meta');
  const state = element('span', `state ${thread.state}`, labels[thread.state] || 'Unknown');
  state.title = thread.reason;
  meta.append(state, element('span', '', '·'), element('span', '', relativeTime(thread.updatedAtMs)));
  if (thread.pinned) meta.append(element('span', '', '· Pinned'));
  if (thread.archived) meta.append(element('span', '', '· Archived'));
  body.append(element('span', 'session-title', thread.title), meta);
  row.append(body);
  if (indicator) {
    const mark = element('span', `attention ${indicator}`, indicator === 'question' ? '?' : '');
    mark.setAttribute('aria-hidden', 'true');
    row.append(mark);
  }
  if (thread.canOpen) row.append(icon());
  row.addEventListener('click', () => openSession(thread, row));
  return row;
}

function render() {
  if (!dashboard) return;
  const focusedKey = document.activeElement?.dataset.focusKey;
  const query = controls.search.value.trim().toLocaleLowerCase();
  const threads = dashboard.threads.filter((thread) => (controls.archive.checked || !thread.archived)
    && (controls.app.value === 'all' || thread.provider === controls.app.value)
    && (controls.status.value === 'all' || thread.state === controls.status.value)
    && (!query || [thread.title, thread.projectName, thread.cwd, thread.providerLabel].join('\n').toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAtMs - a.updatedAtMs);
  const fragment = document.createDocumentFragment();
  for (const provider of dashboard.providers) {
    const appThreads = threads.filter((thread) => thread.provider === provider.id);
    if (!appThreads.length) continue;
    const section = element('section', 'app-group');
    const heading = element('h2', 'app-title', provider.label);
    heading.append(element('span', '', String(appThreads.length)));
    section.append(heading);
    const projects = new Map();
    for (const thread of appThreads) {
      const key = thread.cwd || '';
      if (!projects.has(key)) projects.set(key, []);
      projects.get(key).push(thread);
    }
    for (const [cwd, items] of projects) {
      const key = `${provider.id}:${cwd}`;
      const project = element('details', 'project');
      project.open = Boolean(query) || !collapsedProjects.has(key);
      const summary = element('summary');
      summary.dataset.focusKey = `project:${key}`;
      summary.title = cwd || 'No project path';
      summary.append(element('span', 'project-name', items[0].projectName), element('span', 'project-count', String(items.length)));
      project.append(summary, ...items.map(sessionRow));
      project.addEventListener('toggle', () => {
        if (project.open) collapsedProjects.delete(key); else collapsedProjects.add(key);
      });
      section.append(project);
    }
    fragment.append(section);
  }
  if (!threads.length) {
    const empty = element('div', 'empty');
    const noSessions = !dashboard.threads.length;
    empty.append(element('strong', '', noSessions ? 'No desktop sessions found' : 'No matching sessions'),
      element('p', '', noSessions ? 'Create a session in Codex or Claude Desktop Code, then refresh.' : 'Change the search or filters to see more sessions.'));
    fragment.append(empty);
  }
  controls.sessions.replaceChildren(fragment);
  controls.count.textContent = `${threads.length} ${threads.length === 1 ? 'session' : 'sessions'}`;
  if (focusedKey) [...controls.sessions.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focusedKey)?.focus({ preventScroll: true });
}

async function refresh(force = false) {
  if (loading) { refreshQueued = true; return; }
  clearTimeout(refreshTimer);
  loading = true;
  controls.refresh.disabled = true;
  controls.sessions.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/dashboard${force ? '?force=1' : ''}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Cannot load sessions. Check that ASB is running, then refresh.');
    dashboard = await response.json();
    controls.notice.textContent = dashboard.providers.filter((provider) => provider.message).map((provider) => provider.message).join(' ');
    controls.updated.textContent = `Updated ${new Date(dashboard.generatedAtMs).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`;
    controls.updated.dateTime = new Date(dashboard.generatedAtMs).toISOString();
    const signature = JSON.stringify([dashboard.threads, dashboard.providers, dashboard.pinnedOrder, Math.floor(Date.now() / 60_000)]);
    if (force || signature !== dashboardSignature) {
      render();
      dashboardSignature = signature;
    }
  } catch (error) {
    controls.notice.textContent = error.message;
    if (!dashboard) controls.count.textContent = 'Sessions are not available';
  } finally {
    loading = false;
    controls.refresh.disabled = false;
    controls.sessions.setAttribute('aria-busy', 'false');
    const queued = refreshQueued;
    refreshQueued = false;
    refreshTimer = setTimeout(() => { if (!document.hidden) refresh(); }, queued ? 250
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
