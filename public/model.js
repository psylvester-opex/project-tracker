// Data model helpers shared by the browser app and the Node tests.
// Exposed as window.TrackerModel in the browser and module.exports in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrackerModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SCHEMA_VERSION = 1;
  const PROJECT_STATUSES = ['active', 'planned', 'on-hold', 'done'];
  const ACTION_STATUSES = ['open', 'waiting', 'done'];
  const PRIORITIES = ['', 'high', 'medium', 'low'];

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function emptyDoc() {
    return { schemaVersion: SCHEMA_VERSION, areas: [] };
  }

  function newArea(title) {
    return { id: uid('a'), title: title || 'New strategic area', projects: [] };
  }

  function newProject(title) {
    return {
      id: uid('p'), title: title || 'New project', status: 'planned', priority: '',
      owner: '', targetDate: '', notes: '', actions: [],
    };
  }

  function newAction(title) {
    return {
      id: uid('t'), title: title || '', owner: '', nextDate: '', status: 'open',
      notes: '', doneAt: '',
    };
  }

  // Fill in any missing fields so older or hand-edited files load cleanly.
  function normalize(doc) {
    const out = emptyDoc();
    const areas = (doc && Array.isArray(doc.areas)) ? doc.areas : [];
    for (const a of areas) {
      const area = Object.assign(newArea(), a, { projects: [] });
      for (const p of (a.projects || [])) {
        const project = Object.assign(newProject(), p, { actions: [] });
        if (!PROJECT_STATUSES.includes(project.status)) project.status = 'planned';
        if (!PRIORITIES.includes(project.priority)) project.priority = '';
        for (const t of (p.actions || [])) {
          const action = Object.assign(newAction(), t);
          if (!ACTION_STATUSES.includes(action.status)) action.status = 'open';
          project.actions.push(action);
        }
        area.projects.push(project);
      }
      out.areas.push(area);
    }
    return out;
  }

  // ---- Dates (ISO yyyy-mm-dd strings, local time) ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayISO() { return toISO(new Date()); }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return toISO(new Date(y, m - 1, d + n));
  }

  // Accepts Date objects, Excel serial numbers, ISO strings and m/d/yyyy strings.
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return toISO(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      // Excel serial date (1900 system): day 25569 is 1970-01-01.
      const ms = Math.round((v - 25569) * 86400000);
      const d = new Date(ms);
      return toISO(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return toISO(new Date(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return toISO(new Date(y, +m[1] - 1, +m[2]));
    }
    return '';
  }

  // ---- Import from the spreadsheet layout ----
  // Column A: strategic area, or a project when it starts with "P:".
  // Column B: action under the current project. Column C: next action date.
  // Optional columns written by our own export: D owner, E status, F priority, G notes.
  function importRows(rows) {
    const doc = emptyDoc();
    let area = null;
    let project = null;
    const cell = (r, i) => (r && r[i] !== undefined && r[i] !== null) ? r[i] : '';
    const text = (v) => String(v).replace(/\s+/g, ' ').trim();

    for (const r of rows) {
      const a = text(cell(r, 0));
      const b = text(cell(r, 1));
      const date = parseDate(cell(r, 2));
      const owner = text(cell(r, 3));
      const status = text(cell(r, 4)).toLowerCase().replace(/\s+/g, '-');
      const priority = text(cell(r, 5)).toLowerCase();
      const notes = String(cell(r, 6) || '').trim();

      if (a) {
        if (/^p\s*:/i.test(a)) {
          if (!area) { area = newArea('Uncategorized'); doc.areas.push(area); }
          project = newProject(a.replace(/^p\s*:\s*/i, ''));
          project.owner = owner;
          project.targetDate = date;
          project.notes = notes;
          project._explicitStatus = PROJECT_STATUSES.includes(status) ? status : '';
          if (PRIORITIES.includes(priority)) project.priority = priority;
          area.projects.push(project);
        } else {
          if (/^strategic area( \/ project)?$/i.test(a) && /^action$/i.test(b)) continue; // header row of our own export
          area = newArea(a);
          project = null;
          doc.areas.push(area);
        }
      } else if (b) {
        if (!project) {
          if (!area) { area = newArea('Uncategorized'); doc.areas.push(area); }
          project = newProject('Unassigned actions');
          area.projects.push(project);
        }
        const action = newAction(b);
        action.nextDate = date;
        action.owner = owner;
        if (ACTION_STATUSES.includes(status)) action.status = status;
        action.notes = notes;
        project.actions.push(action);
      }
    }

    // Spreadsheet has no status column: treat projects with a dated action as
    // active and the rest as planned, so there is a sensible starting point.
    let inferred = 0;
    for (const ar of doc.areas) {
      for (const p of ar.projects) {
        if (!p._explicitStatus) inferred++;
        p.status = p._explicitStatus || (p.actions.some(t => t.nextDate) ? 'active' : 'planned');
        delete p._explicitStatus;
      }
    }
    // Non-enumerable so it never ends up in saved data.
    Object.defineProperty(doc, 'inferredStatuses', { value: inferred, enumerable: false });
    return doc;
  }

  // Inverse of importRows, so an export can be re-imported losslessly.
  function exportRows(doc) {
    const rows = [['Strategic Area / Project', 'Action', 'Next Action', 'Owner', 'Status', 'Priority', 'Notes']];
    for (const a of doc.areas) {
      rows.push([a.title, '', '', '', '', '', '']);
      for (const p of a.projects) {
        rows.push(['P: ' + p.title, '', p.targetDate, p.owner, p.status, p.priority, p.notes]);
        for (const t of p.actions) {
          rows.push(['', t.title, t.nextDate, t.owner, t.status, '', t.notes]);
        }
      }
      rows.push(['', '', '', '', '', '', '']);
    }
    return rows;
  }

  function parseCSV(textIn) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < textIn.length; i++) {
      const c = textIn[i];
      if (q) {
        if (c === '"' && textIn[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && textIn[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Earliest open action date for a project ('' when nothing is scheduled).
  function projectNextDate(p) {
    let best = '';
    for (const t of p.actions) {
      if (t.status !== 'done' && t.nextDate && (!best || t.nextDate < best)) best = t.nextDate;
    }
    return best;
  }

  function dueBucket(iso, today) {
    if (!iso) return 'none';
    if (iso < today) return 'overdue';
    if (iso <= addDays(today, 7)) return 'week';
    if (iso <= addDays(today, 14)) return 'next';
    return 'later';
  }

  return {
    SCHEMA_VERSION, PROJECT_STATUSES, ACTION_STATUSES, PRIORITIES,
    uid, emptyDoc, newArea, newProject, newAction, normalize,
    toISO, todayISO, addDays, parseDate,
    importRows, exportRows, parseCSV, projectNextDate, dueBucket,
  };
});
