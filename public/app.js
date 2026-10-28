/* IT Priorities tracker — browser app (no build step, no framework). */
(function () {
  'use strict';
  const M = window.TrackerModel;
  const LS_DOC = 'itp.doc';
  const LS_UI = 'itp.ui';
  const STATUS_LABEL = { active: 'Active', planned: 'Planned', 'on-hold': 'On hold', done: 'Done' };
  const PRIORITY_LABEL = { '': 'No priority', high: 'High', medium: 'Medium', low: 'Low' };
  const BUCKET_LABEL = { overdue: 'Overdue', week: 'Next 7 days', next: '8–14 days', later: 'Later', none: 'No date' };

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- State ----------
  let doc = M.emptyDoc();
  let mode = 'local';          // 'server' when the Node API is reachable
  let revision = 0;
  let loaded = false;
  const undoStack = [];
  const recentlyDone = new Set(); // completed this session; stay visible so a misclick is easy to reverse
  const ui = Object.assign({
    view: 'portfolio',
    collapsed: {},             // id -> true (areas and projects)
    statuses: ['active', 'planned', 'on-hold'],
    showDone: false,
  }, readJSON(LS_UI) || {});
  const filters = { q: '', owner: '', due: '' };

  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  function saveUI() { writeJSON(LS_UI, ui); }

  // ---------- Lookup ----------
  function findArea(id) { return doc.areas.find(a => a.id === id); }
  function findProject(id) {
    for (const a of doc.areas) { const p = a.projects.find(x => x.id === id); if (p) return { area: a, project: p }; }
    return null;
  }
  function findAction(id) {
    for (const a of doc.areas) for (const p of a.projects) {
      const t = p.actions.find(x => x.id === id); if (t) return { area: a, project: p, action: t };
    }
    return null;
  }
  function allOwners() {
    const set = new Set();
    for (const a of doc.areas) for (const p of a.projects) {
      if (p.owner) set.add(p.owner);
      for (const t of p.actions) if (t.owner) set.add(t.owner);
    }
    return Array.from(set).sort((x, y) => x.localeCompare(y));
  }

  // ---------- Mutations, undo, persistence ----------
  function mutate(fn, opts) {
    undoStack.push(JSON.stringify(doc));
    if (undoStack.length > 50) undoStack.shift();
    fn();
    scheduleSave(opts && opts.replace);
    if (!opts || opts.render !== false) render();
    else renderChrome();
  }

  function undo() {
    if (!undoStack.length) return;
    doc = JSON.parse(undoStack.pop());
    scheduleSave();
    render();
    toast('Undone');
  }

  let saveTimer = null, saving = false, pendingReplace = false, dirty = false;
  function scheduleSave(replace) {
    dirty = true;
    if (replace) pendingReplace = true;
    setSaveState('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }

  async function save() {
    if (saving) { saveTimer = setTimeout(save, 300); return; }
    if (!dirty) return;
    dirty = false;
    if (mode === 'local') {
      writeJSON(LS_DOC, doc);
      setSaveState('Saved in this browser');
      return;
    }
    saving = true;
    const replace = pendingReplace;
    pendingReplace = false;
    try {
      const res = await fetch('api/data', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision: revision, replace, data: doc }),
      });
      if (res.status === 409) { saving = false; return conflict(); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = await res.json();
      revision = out.revision;
      setSaveState('Saved ' + new Date(out.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (e) {
      dirty = true;
      pendingReplace = pendingReplace || replace;
      writeJSON(LS_DOC + '.unsaved', doc);
      setSaveState('Not saved — retrying', true);
      saveTimer = setTimeout(save, 5000);
    }
    saving = false;
  }

  async function conflict() {
    const choice = await ask({
      title: 'Changed somewhere else',
      body: 'The tracker was updated in another tab or by another person since you loaded it.',
      buttons: [['reload', 'Load latest (discard my last change)'], ['overwrite', 'Keep mine (overwrite)']],
    });
    if (choice === 'overwrite') {
      const res = await fetch('api/data');
      revision = (await res.json()).revision;
      dirty = true; save();
    } else {
      await load();
    }
  }

  function setSaveState(text, warn) {
    const el = $('#saveState');
    el.textContent = text;
    el.classList.toggle('warn', Boolean(warn));
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
  });

  async function load() {
    try {
      const res = await fetch('api/data', { cache: 'no-store' });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('json')) throw new Error('no api');
      const store = await res.json();
      mode = 'server';
      revision = store.revision;
      doc = store.data ? M.normalize(store.data) : null;
      if (store.updatedAt) setSaveState('Saved ' + new Date(store.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    } catch (e) {
      mode = 'local';
      const local = readJSON(LS_DOC);
      doc = local ? M.normalize(local) : null;
      setSaveState('Saved in this browser');
    }
    document.body.classList.toggle('server-mode', mode === 'server');
    loaded = Boolean(doc);
    if (!doc) doc = M.emptyDoc();
    undoStack.length = 0;
    render();
  }

  // ---------- Filtering ----------
  function filtersActive() { return Boolean(filters.q || filters.owner || filters.due); }

  function actionVisible(t, ctx) {
    if (t.status === 'done' && !ui.showDone && !recentlyDone.has(t.id)) return false;
    if (filters.owner && !ctx.projectOwnerMatch && t.owner !== filters.owner) return false;
    if (filters.due && filters.due !== 'stalled') {
      if (t.status === 'done') return false;
      const b = M.dueBucket(t.nextDate, ctx.today);
      if (filters.due === 'overdue' && b !== 'overdue') return false;
      if (filters.due === 'week' && !(b === 'overdue' || b === 'week')) return false;
      if (filters.due === 'next' && !(b === 'overdue' || b === 'week' || b === 'next')) return false;
      if (filters.due === 'none' && b !== 'none') return false;
    }
    if (ctx.q && !ctx.textMatch) {
      const hay = (t.title + ' ' + t.owner + ' ' + t.notes).toLowerCase();
      if (!hay.includes(ctx.q)) return false;
    }
    return true;
  }

  // Returns [{area, projects: [{project, actions}]}] honoring all filters.
  function visibleTree() {
    const today = M.todayISO();
    const q = filters.q.toLowerCase();
    const out = [];
    for (const area of doc.areas) {
      const areaMatch = q && area.title.toLowerCase().includes(q);
      const projects = [];
      for (const p of area.projects) {
        if (!ui.statuses.includes(p.status)) continue;
        if (filters.due === 'stalled' && !(p.status === 'active' && !M.projectNextDate(p))) continue;
        const projMatch = areaMatch || (q && (p.title + ' ' + p.owner + ' ' + p.notes).toLowerCase().includes(q));
        const ctx = { today, q, textMatch: !q || projMatch, projectOwnerMatch: filters.owner && p.owner === filters.owner };
        const actions = p.actions.filter(t => actionVisible(t, ctx));
        const keep = (!q || projMatch || actions.length) &&
          (!filters.owner || ctx.projectOwnerMatch || actions.length) &&
          (!filters.due || filters.due === 'stalled' || actions.length);
        if (keep) projects.push({ project: p, actions });
      }
      if (projects.length || !filtersActive()) out.push({ area, projects });
    }
    return out;
  }

  // ---------- Rendering ----------
  function render() {
    renderChrome();
    const main = $('#main');
    if (!loaded && !doc.areas.length) { main.innerHTML = emptyState(); return; }
    main.innerHTML = ui.view === 'agenda' ? renderAgenda() : renderPortfolio();
  }

  function renderChrome() {
    renderSummary();
    renderFilters();
    $('#undoBtn').disabled = !undoStack.length;
    document.body.dataset.view = ui.view;
    $$('.views button').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));
  }

  function emptyState() {
    return `<div class="empty">
      <h2>Set up your tracker</h2>
      <p>Import your existing <strong>IT Priorities</strong> spreadsheet. Rows starting with <code>P:</code> become projects,
      the indented rows under them become actions, and the date column becomes each action's next action date.</p>
      <div class="empty-actions">
        <button class="primary" data-cmd="import">Import spreadsheet…</button>
        <button data-cmd="load-demo">Explore with demo data</button>
        <button class="ghost" data-cmd="start-blank">Start blank</button>
      </div>
      <p class="muted">${mode === 'server' ? 'Data is saved on the server, with automatic backups.' : 'Running without the server: data is saved in this browser only. Run <code>npm start</code> for shared storage and backups.'}</p>
    </div>`;
  }

  function renderSummary() {
    const today = M.todayISO();
    let active = 0, planned = 0, open = 0, overdue = 0, week = 0, stalled = 0;
    for (const a of doc.areas) for (const p of a.projects) {
      if (p.status === 'active') { active++; if (!M.projectNextDate(p)) stalled++; }
      if (p.status === 'planned') planned++;
      if (p.status === 'done') continue;
      for (const t of p.actions) {
        if (t.status === 'done') continue;
        open++;
        const b = M.dueBucket(t.nextDate, today);
        if (b === 'overdue') overdue++;
        if (b === 'week') week++;
      }
    }
    const card = (key, label, n, cls) =>
      `<button class="stat ${cls || ''}" data-stat="${key}"><span class="n">${n}</span><span class="l">${label}</span></button>`;
    $('#summary').innerHTML =
      card('active', 'Active projects', active, 'active') +
      card('planned', 'Planned projects', planned, 'planned') +
      card('open', 'Open actions', open) +
      card('overdue', 'Overdue', overdue, overdue ? 'danger' : '') +
      card('week', 'Due in 7 days', week, week ? 'warn' : '') +
      card('stalled', 'Active, no next action', stalled, stalled ? 'warn' : '');
  }

  function renderFilters() {
    $('#statusChips').innerHTML = M.PROJECT_STATUSES.map(s =>
      `<button class="chip s-${s} ${ui.statuses.includes(s) ? 'on' : ''}" data-status="${s}" aria-pressed="${ui.statuses.includes(s)}">${STATUS_LABEL[s]}</button>`).join('');
    const owners = allOwners();
    const sel = $('#ownerFilter');
    if (filters.owner && !owners.includes(filters.owner)) owners.push(filters.owner);
    sel.innerHTML = '<option value="">All owners</option>' + owners.map(o => `<option ${o === filters.owner ? 'selected' : ''}>${esc(o)}</option>`).join('');
    $('#ownerList').innerHTML = owners.map(o => `<option value="${esc(o)}">`).join('');
    const due = $('#dueFilter');
    if (!due.querySelector('[value=stalled]')) due.insertAdjacentHTML('beforeend', '<option value="stalled">Active, no next action</option>');
    due.value = filters.due;
    $('#showDone').checked = ui.showDone;
  }

  function dateClass(iso, done) {
    if (!iso || done) return '';
    const b = M.dueBucket(iso, M.todayISO());
    return b === 'overdue' ? 'overdue' : b === 'week' ? 'soon' : '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const sameYear = y === new Date().getFullYear();
    return dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  }

  function isCollapsed(id) { return !filtersActive() && Boolean(ui.collapsed[id]); }

  function renderPortfolio() {
    const tree = visibleTree();
    if (!tree.length) return `<div class="empty small"><p>Nothing matches these filters.</p></div>`;
    return tree.map(({ area, projects }) => {
      const all = area.projects;
      const nActive = all.filter(p => p.status === 'active').length;
      const nPlanned = all.filter(p => p.status === 'planned').length;
      const nOpen = all.reduce((s, p) => s + (p.status === 'done' ? 0 : p.actions.filter(t => t.status !== 'done').length), 0);
      const collapsed = isCollapsed(area.id);
      return `<section class="area ${collapsed ? 'collapsed' : ''}" data-area="${area.id}">
        <div class="area-row drop" data-drop="area" data-id="${area.id}">
          <button class="chev" data-act="toggle" data-id="${area.id}" aria-expanded="${!collapsed}" aria-label="Expand or collapse area"></button>
          <span class="drag" draggable="true" data-drag="area" data-id="${area.id}" title="Drag to reorder">⋮⋮</span>
          <h2 class="title" contenteditable="plaintext-only" spellcheck="true" data-edit="area.title" data-id="${area.id}">${esc(area.title)}</h2>
          <span class="area-meta">
            <span class="dot s-active"></span>${nActive} active
            <span class="dot s-planned"></span>${nPlanned} planned
            <span class="sep">·</span>${nOpen} open actions
          </span>
          <button class="ghost sm" data-act="add-project" data-id="${area.id}">+ Project</button>
          <button class="ghost icon" data-act="details" data-kind="area" data-id="${area.id}" aria-label="Area details">⋯</button>
        </div>
        <div class="projects">
          ${projects.map(({ project, actions }) => renderProject(project, actions)).join('')}
          ${!projects.length ? `<div class="hint">No projects yet. <button class="link" data-act="add-project" data-id="${area.id}">Add one</button></div>` : ''}
        </div>
      </section>`;
    }).join('');
  }

  function renderProject(p, actions) {
    const collapsed = isCollapsed(p.id);
    const next = M.projectNextDate(p);
    const total = p.actions.length;
    const done = p.actions.filter(t => t.status === 'done').length;
    const stalled = p.status === 'active' && !next;
    const pct = total ? Math.round(done / total * 100) : 0;
    return `<div class="project ${collapsed ? 'collapsed' : ''} st-${p.status}" data-project="${p.id}">
      <div class="row project-row drop" data-drop="project" data-id="${p.id}">
        <button class="chev" data-act="toggle" data-id="${p.id}" aria-expanded="${!collapsed}" aria-label="Expand or collapse project"></button>
        <span class="drag" draggable="true" data-drag="project" data-id="${p.id}" title="Drag to reorder or move">⋮⋮</span>
        <select class="pill s-${p.status}" data-edit="project.status" data-id="${p.id}" aria-label="Project status">
          ${M.PROJECT_STATUSES.map(s => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
        </select>
        <button class="prio p-${p.priority || 'none'}" data-act="cycle-priority" data-id="${p.id}" title="Priority: ${PRIORITY_LABEL[p.priority]} (click to change)" aria-label="Priority ${PRIORITY_LABEL[p.priority]}"></button>
        <div class="title-cell">
          <span class="title" contenteditable="plaintext-only" spellcheck="true" data-edit="project.title" data-id="${p.id}">${esc(p.title)}</span>
          ${stalled ? '<span class="tag warn" title="Active project with no dated open action">No next action</span>' : ''}
          ${p.notes ? `<span class="tag note" title="${esc(p.notes)}">Notes</span>` : ''}
        </div>
        <input class="owner" list="ownerList" placeholder="Owner" value="${esc(p.owner)}" data-edit="project.owner" data-id="${p.id}" aria-label="Project owner">
        <span class="next ${dateClass(next)}" title="Earliest open action date">${next ? 'Next: ' + fmtDate(next) : ''}</span>
        <span class="progress" title="${done} of ${total} actions done"><span class="bar"><span style="width:${pct}%"></span></span>${done}/${total}</span>
        <button class="ghost icon" data-act="details" data-kind="project" data-id="${p.id}" aria-label="Project details">⋯</button>
      </div>
      <div class="actions">
        ${actions.map(t => renderAction(t)).join('')}
        <div class="row add-row">
          <span></span><span></span>
          <input class="add-action" placeholder="+ Add action and press Enter" data-project="${p.id}" aria-label="Add action">
        </div>
      </div>
    </div>`;
  }

  function renderAction(t, crumb) {
    const done = t.status === 'done';
    return `<div class="row action-row ${done ? 'done' : ''} ${t.status === 'waiting' ? 'waiting' : ''} drop" data-drop="action" data-id="${t.id}">
      <span class="drag" draggable="true" data-drag="action" data-id="${t.id}" title="Drag to reorder or move">⋮⋮</span>
      <input type="checkbox" ${done ? 'checked' : ''} data-edit="action.done" data-id="${t.id}" aria-label="Mark done">
      <div class="title-cell">
        <span class="title" contenteditable="plaintext-only" spellcheck="true" data-edit="action.title" data-id="${t.id}">${esc(t.title)}</span>
        ${t.status === 'waiting' ? '<span class="tag waiting">Waiting</span>' : ''}
        ${t.notes ? `<span class="tag note" title="${esc(t.notes)}">Notes</span>` : ''}
        ${crumb || ''}
      </div>
      <input class="owner" list="ownerList" placeholder="Owner" value="${esc(t.owner)}" data-edit="action.owner" data-id="${t.id}" aria-label="Action owner">
      <input class="date ${dateClass(t.nextDate, done)} ${t.nextDate ? '' : 'no-date'}" type="date" value="${esc(t.nextDate)}" data-edit="action.nextDate" data-id="${t.id}" aria-label="Next action date">
      <button class="ghost icon" data-act="details" data-kind="action" data-id="${t.id}" aria-label="Action details">⋯</button>
    </div>`;
  }

  function renderAgenda() {
    const today = M.todayISO();
    const groups = { overdue: [], week: [], next: [], later: [], none: [] };
    for (const { area, projects } of visibleTree()) for (const { project, actions } of projects) {
      if (project.status === 'done') continue;
      for (const t of actions) groups[M.dueBucket(t.nextDate, today)].push({ area, project, t });
    }
    const order = ['overdue', 'week', 'next', 'later', 'none'];
    const html = order.filter(k => groups[k].length).map(k => {
      const items = groups[k].sort((x, y) => (x.t.nextDate || '9').localeCompare(y.t.nextDate || '9'));
      return `<section class="agenda-group g-${k}">
        <h2>${BUCKET_LABEL[k]} <span class="count">${items.length}</span></h2>
        ${items.map(({ area, project, t }) => renderAction(t,
          `<button class="crumb" data-act="reveal" data-id="${project.id}" title="Show in portfolio">${esc(area.title)} › ${esc(project.title)}</button>`)).join('')}
      </section>`;
    }).join('');
    return `<div class="agenda">${html || '<div class="empty small"><p>No open actions match these filters.</p></div>'}</div>`;
  }

  // ---------- Drawer (details) ----------
  let drawerRef = null;
  function openDrawer(kind, id) {
    drawerRef = { kind, id };
    renderDrawer();
    $('#drawer').hidden = false;
    const first = $('#drawerBody [data-f]');
    if (first) first.focus();
  }
  function closeDrawer() { $('#drawer').hidden = true; drawerRef = null; }

  function renderDrawer() {
    if (!drawerRef) return;
    const { kind, id } = drawerRef;
    const body = $('#drawerBody');
    const field = (label, inner) => `<label class="field"><span>${label}</span>${inner}</label>`;
    if (kind === 'area') {
      const a = findArea(id); if (!a) return closeDrawer();
      $('#drawerTitle').textContent = 'Strategic area';
      body.innerHTML = field('Name', `<input data-f="title" value="${esc(a.title)}">`) +
        `<p class="muted">${a.projects.length} project(s)</p>` +
        `<div class="drawer-foot"><button class="danger" data-dcmd="delete">Delete area</button></div>`;
    } else if (kind === 'project') {
      const r = findProject(id); if (!r) return closeDrawer();
      const p = r.project;
      $('#drawerTitle').textContent = 'Project';
      body.innerHTML =
        field('Title', `<textarea data-f="title" rows="2">${esc(p.title)}</textarea>`) +
        `<div class="field-row">` +
        field('Status', `<select data-f="status">${M.PROJECT_STATUSES.map(s => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>`) +
        field('Priority', `<select data-f="priority">${M.PRIORITIES.map(s => `<option value="${s}" ${s === p.priority ? 'selected' : ''}>${PRIORITY_LABEL[s]}</option>`).join('')}</select>`) +
        `</div><div class="field-row">` +
        field('Owner', `<input data-f="owner" list="ownerList" value="${esc(p.owner)}">`) +
        field('Target date', `<input data-f="targetDate" type="date" value="${esc(p.targetDate)}">`) +
        `</div>` +
        field('Strategic area', `<select data-f="area">${doc.areas.map(a => `<option value="${a.id}" ${a.id === r.area.id ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select>`) +
        field('Notes', `<textarea data-f="notes" rows="8" placeholder="Context, decisions, links, risks…">${esc(p.notes)}</textarea>`) +
        `<div class="drawer-foot"><button class="danger" data-dcmd="delete">Delete project</button></div>`;
    } else {
      const r = findAction(id); if (!r) return closeDrawer();
      const t = r.action;
      $('#drawerTitle').textContent = 'Action';
      body.innerHTML =
        field('Action', `<textarea data-f="title" rows="3">${esc(t.title)}</textarea>`) +
        `<div class="field-row">` +
        field('Status', `<select data-f="status">${M.ACTION_STATUSES.map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s === 'waiting' ? 'Waiting on someone' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>`) +
        field('Next action date', `<input data-f="nextDate" type="date" value="${esc(t.nextDate)}">`) +
        `</div>` +
        field('Owner', `<input data-f="owner" list="ownerList" value="${esc(t.owner)}">`) +
        field('Project', `<select data-f="project">${doc.areas.map(a => `<optgroup label="${esc(a.title)}">${a.projects.map(p => `<option value="${p.id}" ${p.id === r.project.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</optgroup>`).join('')}</select>`) +
        field('Notes', `<textarea data-f="notes" rows="8">${esc(t.notes)}</textarea>`) +
        (t.doneAt ? `<p class="muted">Completed ${fmtDate(t.doneAt)}</p>` : '') +
        `<div class="drawer-foot"><button class="danger" data-dcmd="delete">Delete action</button></div>`;
    }
  }

  function applyDrawerField(f, value) {
    const { kind, id } = drawerRef;
    if (kind === 'area') {
      const a = findArea(id);
      if (f === 'title' && value.trim()) mutate(() => { a.title = value.trim(); });
    } else if (kind === 'project') {
      const r = findProject(id);
      if (f === 'area') {
        if (value === r.area.id) return;
        mutate(() => { r.area.projects.splice(r.area.projects.indexOf(r.project), 1); findArea(value).projects.push(r.project); });
      } else if (f === 'title') {
        if (value.trim()) mutate(() => { r.project.title = value.trim(); });
      } else mutate(() => { r.project[f] = value; });
    } else {
      const r = findAction(id);
      if (f === 'project') {
        if (value === r.project.id) return;
        mutate(() => { r.project.actions.splice(r.project.actions.indexOf(r.action), 1); findProject(value).project.actions.push(r.action); });
      } else if (f === 'status') {
        mutate(() => setActionStatus(r.action, value));
      } else if (f === 'title') {
        if (value.trim()) mutate(() => { r.action.title = value.trim(); });
      } else mutate(() => { r.action[f] = value; });
    }
    renderDrawer();
  }

  async function deleteFromDrawer() {
    const { kind, id } = drawerRef;
    if (kind === 'area') {
      const a = findArea(id);
      if (a.projects.length && await ask({ title: 'Delete area?', body: `“${a.title}” and its ${a.projects.length} project(s) will be deleted.`, buttons: [['ok', 'Delete']] }) !== 'ok') return;
      mutate(() => doc.areas.splice(doc.areas.indexOf(a), 1));
    } else if (kind === 'project') {
      const r = findProject(id);
      mutate(() => r.area.projects.splice(r.area.projects.indexOf(r.project), 1));
    } else {
      const r = findAction(id);
      mutate(() => r.project.actions.splice(r.project.actions.indexOf(r.action), 1));
    }
    closeDrawer();
    toast('Deleted', true);
  }

  function setActionStatus(t, status) {
    t.status = status;
    t.doneAt = status === 'done' ? (t.doneAt || M.todayISO()) : '';
  }

  // ---------- Inline editing ----------
  function commitInline(el) {
    const [kind, field] = el.dataset.edit.split('.');
    const id = el.dataset.id;
    const isText = el.isContentEditable;
    const value = isText ? el.textContent.replace(/\s+/g, ' ').trim() : (el.type === 'checkbox' ? el.checked : el.value.trim());
    if (kind === 'area') {
      const a = findArea(id);
      if (!value) { el.textContent = a.title; return; }
      if (a.title !== value) mutate(() => { a.title = value; }, { render: false });
    } else if (kind === 'project') {
      const p = findProject(id).project;
      if (field === 'title' && !value) { el.textContent = p.title; return; }
      if (p[field] === value) return;
      mutate(() => { p[field] = value; }, { render: field === 'status' });
    } else {
      const t = findAction(id).action;
      if (field === 'done') {
        if (value) recentlyDone.add(t.id);
        return mutate(() => setActionStatus(t, value ? 'done' : 'open'));
      }
      if (field === 'title' && !value) { el.textContent = t.title; return; }
      if (t[field] === value) return;
      // Date changes affect highlighting, sorting and project "next" dates.
      mutate(() => { t[field] = value; }, { render: field === 'nextDate' });
    }
  }

  function addAction(input) {
    const title = input.value.trim();
    if (!title) return;
    const pid = input.dataset.project;
    const p = findProject(pid).project;
    mutate(() => p.actions.push(M.newAction(title)));
    const again = $(`.add-action[data-project="${pid}"]`);
    if (again) again.focus();
  }

  function addProject(areaId) {
    const area = findArea(areaId);
    const p = M.newProject('');
    p.title = 'New project';
    mutate(() => { area.projects.push(p); delete ui.collapsed[areaId]; });
    saveUI();
    focusTitle(`[data-edit="project.title"][data-id="${p.id}"]`);
  }

  function addArea() {
    const a = M.newArea();
    mutate(() => doc.areas.push(a));
    loaded = true;
    focusTitle(`[data-edit="area.title"][data-id="${a.id}"]`);
  }

  function focusTitle(sel) {
    const el = $(sel);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  }

  // ---------- Drag and drop ----------
  let dragging = null;
  function onDragStart(e) {
    const h = e.target.closest('[data-drag]');
    if (!h) return;
    dragging = { kind: h.dataset.drag, id: h.dataset.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.id);
    const row = h.closest('.row, .area-row');
    if (row) e.dataTransfer.setDragImage(row, 20, 16);
    setTimeout(() => document.body.classList.add('dragging'), 0);
  }

  function dropTarget(e) {
    if (!dragging) return null;
    const el = e.target.closest('[data-drop]');
    if (!el) return null;
    const t = el.dataset.drop;
    const ok = (dragging.kind === 'action' && (t === 'action' || t === 'project')) ||
      (dragging.kind === 'project' && (t === 'project' || t === 'area')) ||
      (dragging.kind === 'area' && t === 'area');
    if (!ok || el.dataset.id === dragging.id) return null;
    const rect = el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    // Dropping a child on its parent's header appends into that parent.
    const into = (dragging.kind === 'action' && t === 'project') || (dragging.kind === 'project' && t === 'area');
    return { el, type: t, id: el.dataset.id, after, into };
  }

  function onDragOver(e) {
    const t = dropTarget(e);
    $$('.drop-before, .drop-after, .drop-into').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
    if (!t) return;
    e.preventDefault();
    t.el.classList.add(t.into ? 'drop-into' : t.after ? 'drop-after' : 'drop-before');
  }

  function onDrop(e) {
    const t = dropTarget(e);
    clearDrag();
    if (!t) return;
    e.preventDefault();
    const src = dragging; dragging = null;
    mutate(() => {
      if (src.kind === 'action') {
        const from = findAction(src.id);
        from.project.actions.splice(from.project.actions.indexOf(from.action), 1);
        if (t.into) findProject(t.id).project.actions.push(from.action);
        else {
          const to = findAction(t.id);
          const i = to.project.actions.indexOf(to.action) + (t.after ? 1 : 0);
          to.project.actions.splice(i, 0, from.action);
        }
      } else if (src.kind === 'project') {
        const from = findProject(src.id);
        from.area.projects.splice(from.area.projects.indexOf(from.project), 1);
        if (t.into) findArea(t.id).projects.push(from.project);
        else {
          const to = findProject(t.id);
          const i = to.area.projects.indexOf(to.project) + (t.after ? 1 : 0);
          to.area.projects.splice(i, 0, from.project);
        }
      } else {
        const a = findArea(src.id);
        doc.areas.splice(doc.areas.indexOf(a), 1);
        const i = doc.areas.indexOf(findArea(t.id)) + (t.after ? 1 : 0);
        doc.areas.splice(i, 0, a);
      }
    });
  }

  function clearDrag() {
    document.body.classList.remove('dragging');
    $$('.drop-before, .drop-after, .drop-into').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }

  // ---------- Import / export ----------
  async function importFile(file) {
    let imported;
    try {
      const name = file.name.toLowerCase();
      if (name.endsWith('.json')) {
        const parsed = JSON.parse(await file.text());
        imported = M.normalize(parsed.data || parsed);
      } else if (name.endsWith('.csv') || name.endsWith('.tsv')) {
        imported = M.importRows(M.parseCSV(await file.text()));
      } else {
        if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported. Save the workbook as .xlsx and import that.');
        const wb = await window.MiniXlsx.read(await file.arrayBuffer());
        const sheetName = wb.sheetNames.find(n => /priorit/i.test(n)) || wb.sheetNames[0];
        imported = M.importRows(wb.sheets[sheetName] || []);
      }
    } catch (e) {
      return ask({ title: 'Import failed', body: e.message, buttons: [['ok', 'OK']], noCancel: true });
    }
    const nP = imported.areas.reduce((s, a) => s + a.projects.length, 0);
    const nA = imported.areas.reduce((s, a) => s + a.projects.reduce((x, p) => x + p.actions.length, 0), 0);
    const nActive = imported.inferredStatuses ? imported.areas.reduce((s, a) => s + a.projects.filter(p => p.status === 'active').length, 0) : 0;
    if (!nP && !imported.areas.length) {
      return ask({ title: 'Nothing to import', body: 'No strategic areas or projects were found. Column A should hold areas and "P:" projects; column B the actions; column C the next action date.', buttons: [['ok', 'OK']], noCancel: true });
    }
    const hasData = doc.areas.length > 0;
    const choice = await ask({
      title: 'Import ' + file.name,
      body: `Found ${imported.areas.length} strategic areas, ${nP} projects and ${nA} actions.` +
        (nActive ? ` ${nActive} projects with dated actions were set to Active, the rest to Planned — review these after import.` : '') +
        (hasData ? ' This replaces the current tracker contents' + (mode === 'server' ? ' (the server keeps a backup).' : '.') : ''),
      buttons: [['ok', hasData ? 'Replace and import' : 'Import']],
    });
    if (choice !== 'ok') return;
    replaceDoc(imported);
    toast('Imported ' + nP + ' projects', true);
  }

  function replaceDoc(next) {
    mutate(() => { doc = next; }, { replace: true });
    loaded = true;
    ui.collapsed = {};
    saveUI();
    render();
  }

  function exportXlsx() {
    const rows = M.exportRows(doc).map((r, i) => i === 0 ? r : r.map((v, c) => (c === 2 && v) ? isoToDate(v) : v));
    const bytes = window.MiniXlsx.write(rows, { sheetName: 'Priorities', widths: [60, 80, 12, 18, 10, 9, 50] });
    download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `IT Priorities ${M.todayISO()}.xlsx`);
  }
  function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }

  function exportJson() {
    download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `it-priorities-${M.todayISO()}.json`);
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function restoreBackup() {
    const list = await (await fetch('api/backups')).json();
    if (!list.length) return ask({ title: 'No backups yet', body: 'The server snapshots your data at most every 10 minutes while you edit, and before every import.', buttons: [['ok', 'OK']], noCancel: true });
    const label = (n) => n.replace(/^tracker-|\.json$/g, '').replace(/T(\d\d)-(\d\d)-(\d\d)-\d+Z/, ' $1:$2:$3 UTC');
    const choice = await ask({
      title: 'Restore from backup',
      body: 'Choose a snapshot. The current version is backed up first, so this can be reversed.',
      select: list.slice(0, 50).map(b => [b.name, label(b.name)]),
      buttons: [['ok', 'Restore']],
    });
    if (!choice || choice === 'cancel') return;
    const store = await (await fetch('api/backups/' + encodeURIComponent(choice.select))).json();
    replaceDoc(M.normalize(store.data));
    toast('Restored backup', true);
  }

  async function loadDemo() {
    if (doc.areas.length && await ask({ title: 'Load demo data?', body: 'This replaces the current tracker contents. Use Undo to go back.', buttons: [['ok', 'Load demo']] }) !== 'ok') return;
    const res = await fetch('demo-data.json');
    replaceDoc(M.normalize(await res.json()));
  }

  // ---------- Dialog & toast ----------
  function ask({ title, body, buttons, select, noCancel }) {
    return new Promise(resolve => {
      const dlg = $('#dialog');
      $('#dialogForm').innerHTML = `<h2>${esc(title)}</h2><p>${esc(body)}</p>` +
        (select ? `<select id="dlgSelect" size="8">${select.map(([v, l], i) => `<option value="${esc(v)}" ${i === 0 ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : '') +
        `<div class="dlg-buttons">${noCancel ? '' : '<button value="cancel" class="ghost">Cancel</button>'}` +
        buttons.map(([v, l], i) => `<button value="${v}" class="${i === buttons.length - 1 ? 'primary' : ''}">${esc(l)}</button>`).join('') + `</div>`;
      dlg.onclose = () => {
        const v = dlg.returnValue || 'cancel';
        resolve(select && v !== 'cancel' ? { value: v, select: $('#dlgSelect').value } : v);
      };
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  let toastTimer;
  function toast(msg, withUndo) {
    const el = $('#toast');
    el.innerHTML = esc(msg) + (withUndo && undoStack.length ? ' <button class="link" data-cmd="undo">Undo</button>' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  // ---------- Commands ----------
  function runCmd(cmd) {
    $('#menu').hidden = true;
    $('#menuBtn').setAttribute('aria-expanded', 'false');
    if (cmd === 'import') $('#fileInput').click();
    else if (cmd === 'export-xlsx') exportXlsx();
    else if (cmd === 'export-json') exportJson();
    else if (cmd === 'backups') restoreBackup();
    else if (cmd === 'load-demo') loadDemo();
    else if (cmd === 'undo') { undo(); $('#toast').hidden = true; }
    else if (cmd === 'start-blank') addArea();
  }

  function setAllCollapsed(collapsed) {
    ui.collapsed = {};
    if (collapsed) for (const a of doc.areas) for (const p of a.projects) ui.collapsed[p.id] = true;
    saveUI();
    render();
  }

  function applyStat(key) {
    filters.q = ''; filters.owner = ''; filters.due = '';
    $('#search').value = '';
    if (key === 'active' || key === 'planned') ui.statuses = [key];
    else {
      ui.statuses = ['active', 'planned', 'on-hold'];
      if (key === 'overdue' || key === 'week' || key === 'stalled') filters.due = key;
      if (key === 'overdue' || key === 'week') ui.view = 'agenda';
      if (key === 'stalled') ui.view = 'portfolio';
    }
    saveUI();
    render();
  }

  // ---------- Events ----------
  function bind() {
    document.addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-cmd]');
      if (cmd) return runCmd(cmd.dataset.cmd);
      if (!e.target.closest('.menu-wrap')) $('#menu').hidden = true;

      const act = e.target.closest('[data-act]');
      if (act) {
        const id = act.dataset.id;
        if (act.dataset.act === 'toggle') {
          if (filtersActive()) return;
          ui.collapsed[id] = !ui.collapsed[id];
          if (!ui.collapsed[id]) delete ui.collapsed[id];
          saveUI(); render();
        } else if (act.dataset.act === 'add-project') addProject(id);
        else if (act.dataset.act === 'details') openDrawer(act.dataset.kind, id);
        else if (act.dataset.act === 'cycle-priority') {
          const p = findProject(id).project;
          const next = M.PRIORITIES[(M.PRIORITIES.indexOf(p.priority) + 1) % M.PRIORITIES.length];
          mutate(() => { p.priority = next; });
        } else if (act.dataset.act === 'reveal') {
          const r = findProject(id);
          ui.view = 'portfolio';
          delete ui.collapsed[r.area.id]; delete ui.collapsed[id];
          if (!ui.statuses.includes(r.project.status)) ui.statuses.push(r.project.status);
          filters.q = ''; filters.owner = ''; filters.due = ''; $('#search').value = '';
          saveUI(); render();
          const el = $(`[data-project="${id}"]`);
          if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
        }
        return;
      }

      const stat = e.target.closest('[data-stat]');
      if (stat) return applyStat(stat.dataset.stat);

      const chip = e.target.closest('[data-status]');
      if (chip) {
        const s = chip.dataset.status;
        ui.statuses = ui.statuses.includes(s) ? ui.statuses.filter(x => x !== s) : ui.statuses.concat(s);
        saveUI(); render();
      }
    });

    $('#menuBtn').addEventListener('click', () => {
      const m = $('#menu'); m.hidden = !m.hidden;
      $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden));
    });
    $$('.views button').forEach(b => b.addEventListener('click', () => { ui.view = b.dataset.view; saveUI(); render(); }));
    $('#undoBtn').addEventListener('click', undo);
    $('#expandAll').addEventListener('click', () => setAllCollapsed(false));
    $('#collapseAll').addEventListener('click', () => setAllCollapsed(true));
    $('#addArea').addEventListener('click', addArea);
    $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });

    let searchTimer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { filters.q = e.target.value.trim(); render(); }, 150);
    });
    $('#ownerFilter').addEventListener('change', (e) => { filters.owner = e.target.value; render(); });
    $('#dueFilter').addEventListener('change', (e) => { filters.due = e.target.value; render(); });
    $('#showDone').addEventListener('change', (e) => { ui.showDone = e.target.checked; saveUI(); render(); });

    const main = $('#main');
    // Contenteditable titles commit on blur; inputs/selects commit on change.
    main.addEventListener('focusout', (e) => {
      if (e.target.isContentEditable && e.target.dataset.edit) commitInline(e.target);
    });
    main.addEventListener('change', (e) => {
      if (e.target.dataset.edit) commitInline(e.target);
    });
    main.addEventListener('keydown', (e) => {
      const el = e.target;
      if (el.classList.contains('add-action') && e.key === 'Enter') { e.preventDefault(); addAction(el); return; }
      if (el.isContentEditable && el.dataset.edit) {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') {
          const [kind] = el.dataset.edit.split('.');
          const item = kind === 'area' ? findArea(el.dataset.id) : kind === 'project' ? findProject(el.dataset.id).project : findAction(el.dataset.id).action;
          el.textContent = item.title; el.blur();
        }
      }
      if (el.matches('input.owner') && e.key === 'Enter') el.blur();
    });
    // Paste as plain text into editable titles (for browsers without plaintext-only).
    main.addEventListener('paste', (e) => {
      if (!e.target.isContentEditable) return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' '));
    });

    main.addEventListener('dragstart', onDragStart);
    main.addEventListener('dragover', onDragOver);
    main.addEventListener('drop', onDrop);
    main.addEventListener('dragend', () => { clearDrag(); dragging = null; });

    const drawer = $('#drawer');
    $('#drawerClose').addEventListener('click', closeDrawer);
    drawer.addEventListener('change', (e) => { if (e.target.dataset.f) applyDrawerField(e.target.dataset.f, e.target.value); });
    drawer.addEventListener('click', (e) => { if (e.target.dataset.dcmd === 'delete') deleteFromDrawer(); });

    document.addEventListener('keydown', (e) => {
      const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
      else if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
      else if (e.key === 'Escape' && !drawer.hidden && !$('#dialog').open) closeDrawer();
    });

    // Fall back gracefully where contenteditable="plaintext-only" is unsupported.
    const probe = document.createElement('div');
    probe.setAttribute('contenteditable', 'plaintext-only');
    if (probe.contentEditable !== 'plaintext-only') {
      new MutationObserver(() => $$('[contenteditable="plaintext-only"]').forEach(el => el.setAttribute('contenteditable', 'true')))
        .observe(main, { childList: true, subtree: true });
    }
  }

  bind();
  load();
})();
