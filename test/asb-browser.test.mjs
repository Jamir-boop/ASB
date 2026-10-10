import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/switchboard.js', import.meta.url), 'utf8');
const epoch = Date.parse('2026-10-09T12:00:00Z');
const settle = () => new Promise(setImmediate);
const providers = [{ id: 'codex', label: 'Codex' }, { id: 'claude-desktop-code', label: 'Claude Desktop Code' }];
function board(size = 3) {
  return { generatedAtMs: epoch, refreshIntervalMs: 5_000, providers,
    threads: Array.from({ length: size }, (_, index) => ({
      id: `synthetic-${index}`, title: `Synthetic session ${index}`, provider: 'codex', providerLabel: 'Codex',
      projectName: 'Synthetic project', cwd: '/synthetic/project', state: 'idle', reason: 'Synthetic fixture',
      updatedAtMs: epoch - index * 1_000, canOpen: true, archived: false, pinned: false,
    })) };
}
function response(data, etag = '"synthetic-1"', status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => etag },
    async json() { assert.notEqual(status, 304, 'A 304 has no JSON body'); return structuredClone(data); } };
}

function harness(initial = board(), script = source) {
  let now = epoch;
  const counts = { rows: 0, elements: 0, listeners: 0, insertions: 0, removals: 0, replacements: 0, textChanges: 0 };
  class Events {
    events = new Map();
    addEventListener(type, callback) {
      if (!this.events.has(type)) this.events.set(type, []);
      this.events.get(type).push(callback);
    }
    async emit(type) { await Promise.all((this.events.get(type) || []).map((callback) => callback())); }
  }
  class Node extends Events {
    constructor(tag) {
      super();
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.parentNode = null;
      this._text = '';
      this.className = '';
      this.value = '';
      this.checked = false;
      this.open = false;
      this.scrollTop = 0;
      this.classList = {
        add: (value) => { if (!this.classList.contains(value)) this.className = `${this.className} ${value}`.trim(); },
        remove: (value) => { this.className = this.className.split(' ').filter((item) => item !== value).join(' '); },
        contains: (value) => this.className.split(' ').includes(value),
      };
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get isConnected() { return this === root || Boolean(this.parentNode?.isConnected); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) {
      counts.textChanges += 1;
      for (const child of [...this.children]) child.remove();
      this._text = String(value);
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.fragment) { for (const node of [...child.children]) this.insertBefore(node, before); return; }
      if (before !== null) assert.equal(before.parentNode, this);
      if (child.isConnected && window.shiftScrollOnMove) window.scrollY = 0;
      child.remove();
      this.children.splice(before === null ? this.children.length : this.children.indexOf(before), 0, child);
      child.parentNode = this;
      counts.insertions += 1;
    }
    remove() {
      if (!this.parentNode) return;
      if (this.contains(document.activeElement)) document.activeElement = null;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
      counts.removals += 1;
    }
    replaceChildren(...children) {
      counts.replacements += 1;
      for (const child of [...this.children]) child.remove();
      this._text = '';
      this.append(...children);
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (selector === '[data-focus-key]' && child.dataset.focusKey) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
    addEventListener(type, callback) { super.addEventListener(type, callback); counts.listeners += 1; }
    focus() { if (!this.disabled) document.activeElement = this; }
  }
  const root = new Node('body');
  const document = Object.assign(new Events(), { hidden: false, activeElement: null });
  const controls = Object.fromEntries(['search', 'app', 'status', 'archive', 'refresh', 'count', 'updated', 'notice', 'sessions']
    .map((id) => [id, new Node(id)]));
  root.append(...Object.values(controls));
  controls.app.value = controls.status.value = 'all';
  const create = (tag) => { counts.elements += 1; if (tag === 'button') counts.rows += 1; return new Node(tag); };
  Object.assign(document, { getElementById: (id) => controls[id], createElement: create,
    createElementNS: (namespace, tag) => Object.assign(create(tag), { namespaceURI: namespace }),
    createDocumentFragment: () => Object.assign(new Node('fragment'), { fragment: true }),
  });
  const window = Object.assign(new Events(), { scrollX: 0, scrollY: 280,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } });
  const streams = [];
  class EventSource extends Events {
    constructor(url) { super(); this.url = url; streams.push(this); }
    close() { this.closed = true; }
  }
  const timers = new Set();
  const requests = [];
  const replies = [initial?.then ? initial : response(initial)];
  const context = vm.createContext({ document, window, EventSource,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      assert.ok(replies.length, `Missing synthetic reply for ${url}`);
      return await replies.shift();
    },
  });
  vm.runInContext(script, context);
  return { controls, document, window, streams, counts, requests, timers,
    evaluate: (code) => vm.runInContext(code, context),
    resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; },
    rows: () => controls.sessions.querySelectorAll('[data-focus-key]').filter((node) => node.dataset.threadId),
    row(id = 'synthetic-0') { return this.rows().find((node) => node.dataset.threadId === id); },
    project: () => controls.sessions.children[0]?.children[1],
    setTime(value) { now = value; },
    queue(value) { replies.push(value); },
    async refresh(value, force = false) { replies.push(value); await vm.runInContext(`refresh(${force})`, context); },
    async runTimer() {
      const timer = [...timers][0];
      assert.ok(timer, 'Expected a refresh timer');
      timers.delete(timer);
      timer.callback();
      await settle();
    },
  };
}

test('keyed browser rows keep nodes, listeners, focus, collapse, and scroll after one title change', async () => {
  for (const size of [120, 5_000]) {
    const initial = board(size);
    const h = harness(initial);
    await settle();
    const rows = h.rows();
    const project = h.project();
    if (size === 120) { project.open = false; await project.emit('toggle'); }
    const focused = size === 120 ? project.children[0] : rows[1];
    focused.focus();
    h.controls.sessions.scrollTop = 160;
    const title = rows[0].children[0].children[0];
    initial.threads[0].title = 'Changed synthetic title';
    h.resetCounts();
    await h.refresh(response(initial, '"synthetic-2"'));
    assert.equal(h.counts.rows, 0);
    assert.equal(h.counts.elements, 0);
    assert.equal(h.counts.listeners, 0);
    assert.equal(h.counts.insertions, 0);
    assert.equal(h.counts.removals, 0);
    assert.equal(h.counts.replacements, 0);
    assert.deepEqual(h.rows(), rows);
    assert.equal(h.row().children[0].children[0], title);
    assert.equal(title.textContent, 'Changed synthetic title');
    assert.equal(h.document.activeElement, focused);
    assert.equal(h.project(), project);
    assert.equal(project.open, size !== 120);
    assert.equal(h.controls.sessions.scrollTop, 160);
    assert.equal(h.window.scrollY, 280);
  }
});

test('browser filters reuse rows, preserve labels and sort, move groups, and release removed IDs', async () => {
  const initial = board(4);
  Object.assign(initial.threads[1], { pinned: true, state: 'working' });
  Object.assign(initial.threads[2], { archived: true });
  Object.assign(initial.threads[3], { provider: providers[1].id, providerLabel: providers[1].label, cwd: '', projectName: 'No project' });
  const h = harness(initial);
  await settle();
  const row = h.row();
  assert.deepEqual(h.rows().map((node) => node.dataset.threadId), ['synthetic-1', 'synthetic-0', 'synthetic-3']);
  assert.equal(h.controls.count.textContent, '3 sessions');
  const project = h.project();
  project.open = false;
  await project.emit('toggle');
  h.controls.search.value = 'synthetic session 0';
  await h.controls.search.emit('input');
  assert.equal(h.row(), row);
  assert.equal(h.project().open, true);
  h.controls.search.value = '';
  await h.controls.search.emit('input');
  assert.equal(h.project().open, false);
  h.project().open = false;
  await h.project().emit('toggle');
  h.controls.app.value = providers[1].id;
  await h.controls.app.emit('change');
  assert.deepEqual(h.rows().map((node) => node.dataset.threadId), ['synthetic-3']);
  h.controls.app.value = 'all';
  await h.controls.app.emit('change');
  assert.equal(h.row(), row);
  assert.equal(h.project().open, false);
  h.controls.status.value = 'working';
  await h.controls.status.emit('change');
  assert.deepEqual(h.rows().map((node) => node.dataset.threadId), ['synthetic-1']);
  h.controls.status.value = 'all';
  h.controls.archive.checked = true;
  await h.controls.archive.emit('change');
  assert.equal(h.rows().length, 4);
  const archived = h.row('synthetic-2');
  assert.equal(archived.children[0].children[1].children.at(-1).textContent, '· Archived');
  Object.assign(initial.threads[2], { pinned: true });
  await h.refresh(response(initial));
  assert.deepEqual(archived.children[0].children[1].children.slice(-2).map((node) => node.textContent), ['· Pinned', '· Archived']);
  row.focus();
  h.window.shiftScrollOnMove = true;
  Object.assign(initial.threads[0], { provider: providers[1].id, providerLabel: providers[1].label, cwd: '/synthetic/moved', projectName: 'Moved project' });
  await h.refresh(response(initial));
  assert.equal(h.row(), row);
  assert.equal(row.parentNode.children[0].children[0].textContent, 'Moved project');
  assert.ok(row.attributes['aria-label'].includes(providers[1].label));
  assert.equal(h.document.activeElement, row);
  assert.equal(h.window.scrollY, 280);
  initial.threads = initial.threads.filter((thread) => thread.id !== 'synthetic-0');
  await h.refresh(response(initial));
  assert.equal(h.row(), undefined);
  assert.equal(h.evaluate('rowCache.has("synthetic-0")'), false);
  assert.equal(h.evaluate('rowCache.size'), 3);
  assert.equal(row.isConnected, false);
  h.controls.search.value = 'missing';
  await h.controls.search.emit('input');
  assert.ok(h.controls.sessions.textContent.includes('No matching sessions'));
  initial.threads = [];
  await h.refresh(response(initial));
  assert.ok(h.controls.sessions.textContent.includes('No desktop sessions found'));
  assert.equal(h.evaluate('rowCache.size'), 0);
});

test('browser cache pruning detaches deleted rows from a hidden group', async () => {
  const initial = board(120);
  const h = harness(initial);
  await settle();
  const rows = h.rows();
  const project = h.project();
  h.controls.app.value = providers[1].id;
  await h.controls.app.emit('change');
  assert.equal(h.rows().length, 0);
  assert.equal(project.isConnected, false);
  assert.ok(rows.every((row) => row.parentNode === project));
  initial.threads = initial.threads.slice(0, 1);
  await h.refresh(response(initial));
  assert.ok(rows.slice(1).every((row) => row.parentNode === null));
  assert.equal(rows[0].parentNode, project);
  assert.equal(project.children.length, 2);
  assert.equal(h.evaluate('rowCache.size'), 1);
  assert.equal(h.evaluate('rowCache.has("synthetic-0")'), true);
  h.controls.app.value = 'all';
  await h.controls.app.emit('change');
  assert.equal(h.row(), rows[0]);
});

test('browser opens use current row data, remain busy during refresh, and queue a normal read', async () => {
  const initial = board();
  const h = harness(initial);
  await settle();
  Object.assign(initial.threads[0], { providerLabel: 'Current app', title: 'Current title' });
  await h.refresh(response(initial));
  const row = h.row();
  const open = Promise.withResolvers();
  h.queue(open.promise);
  const action = row.emit('click');
  assert.equal(h.controls.notice.textContent, 'Opening Current app…');
  assert.equal(h.requests.at(-1).url, '/api/threads/synthetic-0/open');
  assert.equal(h.requests.at(-1).method, 'POST');
  assert.equal(row.disabled, true);
  assert.equal(row.classList.contains('opening'), true);
  Object.assign(initial.threads[0], { title: 'Refreshed title', canOpen: false });
  await h.refresh(response(initial));
  assert.equal(h.row(), row);
  assert.equal(row.disabled, true);
  assert.equal(row.classList.contains('opening'), true);
  const load = Promise.withResolvers();
  h.queue(load.promise);
  const refresh = h.evaluate('refresh()');
  open.resolve(response({ opened: true }));
  await action;
  assert.equal(row.disabled, true);
  assert.equal(row.classList.contains('opening'), false);
  assert.equal(h.evaluate('refreshQueued'), true);
  assert.equal(h.evaluate('refreshQueuedForce'), false);
  load.resolve(response(initial));
  await refresh;
  assert.equal([...h.timers][0].delay, 250);
  h.queue(response(null, '', 304));
  await h.runTimer();
  assert.equal(h.requests.at(-1).url, '/api/dashboard');
  Object.assign(initial.threads[0], { canOpen: true });
  await h.refresh(response(initial));
  h.queue(response({ opened: false }));
  await row.emit('click');
  assert.equal(row.disabled, false);
  assert.ok(h.controls.notice.textContent.includes('The app did not open.'));
});

test('conditional browser reads skip list work on 304 and refresh relative ages each minute', async () => {
  const initial = board();
  initial.threads[0].updatedAtMs = epoch - 59_000;
  initial.providers = [{ ...providers[0], message: 'Synthetic source warning' }];
  const h = harness(initial);
  await settle();
  const row = h.row();
  const age = row.children[0].children[1].children[2];
  assert.equal(age.textContent, 'Just now');
  h.resetCounts();
  await h.refresh(response(null, '"synthetic-1"', 304));
  assert.equal(h.requests.at(-1).headers['If-None-Match'], '"synthetic-1"');
  assert.equal(h.counts.textChanges, 0);
  h.setTime(epoch + 60_000);
  await h.refresh(response(null, '"synthetic-1"', 304));
  assert.equal(age.textContent, '1m ago');
  assert.equal(h.counts.rows, 0);
  assert.equal(h.counts.elements, 0);
  assert.equal(h.counts.insertions, 0);
  assert.equal(h.counts.removals, 0);
  assert.equal(h.counts.listeners, 0);
  assert.equal(h.row(), row);
  assert.equal(h.controls.notice.textContent, 'Synthetic source warning');
  h.resetCounts();
  await h.refresh(response({ ...initial, generatedAtMs: epoch + 60_000 }, '"synthetic-1"'), true);
  assert.equal(h.requests.at(-1).url, '/api/dashboard?force=1');
  assert.equal(h.counts.elements, 0);
  assert.equal(h.counts.insertions, 0);
  assert.equal(h.counts.removals, 0);
});

test('browser errors clear the tag and retain rows, while forced queued reads retain force', async () => {
  const initial = board();
  const h = harness(initial);
  await settle();
  const row = h.row();
  await h.refresh(response(null, '', 500));
  assert.equal(h.row(), row);
  assert.equal(h.evaluate('dashboardEtag'), '');
  assert.equal(h.controls.refresh.disabled, false);
  assert.equal(h.controls.sessions.attributes['aria-busy'], 'false');
  assert.ok(h.controls.notice.textContent.includes('Cannot load sessions.'));
  await h.refresh(response(initial, '"synthetic-2"'));
  assert.equal(h.requests.at(-1).headers['If-None-Match'], undefined);
  assert.equal(h.controls.notice.textContent, '');
  await h.refresh({ ok: true, status: 200, headers: { get: () => '"bad"' }, json: async () => { throw new Error('Synthetic bad JSON'); } });
  assert.equal(h.evaluate('dashboardEtag'), '');
  const load = Promise.withResolvers();
  h.queue(load.promise);
  const active = h.evaluate('refresh()');
  await h.evaluate('refresh(true)');
  await h.evaluate('refresh()');
  assert.equal(h.evaluate('refreshQueuedForce'), true);
  load.resolve(response(initial));
  await active;
  assert.equal([...h.timers][0].delay, 250);
  h.queue(response(null, '', 304));
  await h.runTimer();
  assert.equal(h.requests.at(-1).url, '/api/dashboard?force=1');
  assert.equal(h.evaluate('refreshQueued'), false);
  const failing = harness(Promise.resolve(response(null, '', 503)));
  await settle();
  assert.equal(failing.controls.count.textContent, 'Sessions are not available');
  await failing.refresh(response(board()));
  assert.equal(failing.rows().length, 3);
});

test('browser refresh keeps adaptive polling and the hidden, visible, and pagehide stream lifecycle', async () => {
  const initial = board();
  initial.refreshIntervalMs = 2_000;
  const h = harness(initial);
  await settle();
  assert.equal([...h.timers][0].delay, 2_000);
  assert.equal(h.streams[0].url, '/api/events');
  h.queue(response(null, '', 304));
  await h.streams[0].emit('dashboard');
  await settle();
  assert.equal(h.requests.length, 2);
  h.document.hidden = true;
  await h.document.emit('visibilitychange');
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.timers.size, 0);
  await h.streams[0].emit('dashboard');
  assert.equal(h.requests.length, 2);
  h.queue(response(null, '', 304));
  h.document.hidden = false;
  await h.document.emit('visibilitychange');
  await settle();
  assert.equal(h.streams.length, 2);
  assert.equal(h.requests.length, 3);
  assert.equal([...h.timers][0].delay, 2_000);
  await h.window.emit('pagehide');
  assert.equal(h.streams[1].closed, true);
  assert.equal(h.timers.size, 0);
});
