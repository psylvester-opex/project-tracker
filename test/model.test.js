const test = require('node:test');
const assert = require('node:assert');
const M = require('../public/model.js');

// Same shape as the IT Priorities sheet: area rows, "P:" project rows,
// actions indented into column B, next action date in column C.
const sheet = [
  ['Strategy & Operating Model', '', 'Next Action'],
  ['P: Implement the target org', '', ''],
  ['', 'Finalize job descriptions', 46322],          // Excel serial for 2026-10-27
  ['', 'Communicate changes', ''],
  ['P: Reduce key-person risk', '', ''],
  ['', 'Cross-train backup', ''],
  ['', '', ''],
  ['Data & Analytics', '', ''],
  ['P: Build data platform', '', ''],
  ['', 'Provision workspace', new Date(2026, 10, 2)],
  ['', 'Agree ownership', '11/13/2026'],
];

test('importRows builds areas, projects and actions from the sheet layout', () => {
  const doc = M.importRows(sheet);
  assert.deepStrictEqual(doc.areas.map(a => a.title), ['Strategy & Operating Model', 'Data & Analytics']);
  const [org, risk] = doc.areas[0].projects;
  assert.strictEqual(org.title, 'Implement the target org');
  assert.strictEqual(org.actions.length, 2);
  assert.strictEqual(org.actions[0].nextDate, '2026-10-27');
  assert.strictEqual(risk.actions[0].title, 'Cross-train backup');
  const data = doc.areas[1].projects[0];
  assert.deepStrictEqual(data.actions.map(t => t.nextDate), ['2026-11-02', '2026-11-13']);
});

test('importRows infers Active for projects with dated actions, Planned otherwise', () => {
  const doc = M.importRows(sheet);
  const statuses = doc.areas.flatMap(a => a.projects.map(p => p.status));
  assert.deepStrictEqual(statuses, ['active', 'planned', 'active']);
  assert.strictEqual(doc.inferredStatuses, 3);
  assert.strictEqual(M.importRows(M.exportRows(doc)).inferredStatuses, 0, 'exported statuses are kept, not inferred');
  assert.ok(!('inferredStatuses' in JSON.parse(JSON.stringify(doc))));
});

test('exportRows round-trips through importRows', () => {
  const doc = M.importRows(sheet);
  const p = doc.areas[0].projects[1];
  Object.assign(p, { status: 'on-hold', owner: 'Pat', priority: 'high', notes: 'Waiting on budget' });
  Object.assign(p.actions[0], { owner: 'Sam', status: 'done' });
  const again = M.importRows(M.exportRows(doc));
  const strip = d => JSON.parse(JSON.stringify(d, (k, v) => (k === 'id' || k === 'doneAt') ? undefined : v));
  assert.deepStrictEqual(strip(again), strip(doc));
});

test('parseCSV handles quotes, embedded commas and newlines', () => {
  const rows = M.parseCSV('A,B,C\n"P: x, y","",\n,"say ""hi""\nthere",10/30/2026\n');
  assert.deepStrictEqual(rows[1], ['P: x, y', '', '']);
  assert.deepStrictEqual(rows[2], ['', 'say "hi"\nthere', '10/30/2026']);
});

test('projectNextDate ignores completed actions', () => {
  const p = M.newProject('x');
  p.actions = [
    Object.assign(M.newAction('a'), { nextDate: '2026-10-01', status: 'done' }),
    Object.assign(M.newAction('b'), { nextDate: '2026-11-05' }),
    Object.assign(M.newAction('c'), { nextDate: '' }),
  ];
  assert.strictEqual(M.projectNextDate(p), '2026-11-05');
});

test('dueBucket classifies relative to today', () => {
  const today = '2026-10-28';
  assert.strictEqual(M.dueBucket('2026-10-27', today), 'overdue');
  assert.strictEqual(M.dueBucket('2026-11-04', today), 'week');
  assert.strictEqual(M.dueBucket('2026-11-10', today), 'next');
  assert.strictEqual(M.dueBucket('2026-12-01', today), 'later');
  assert.strictEqual(M.dueBucket('', today), 'none');
});

test('normalize repairs missing and invalid fields', () => {
  const doc = M.normalize({ areas: [{ title: 'A', projects: [{ title: 'P', status: 'bogus', actions: [{ title: 'T' }] }] }] });
  const p = doc.areas[0].projects[0];
  assert.strictEqual(p.status, 'planned');
  assert.strictEqual(p.actions[0].status, 'open');
  assert.ok(doc.areas[0].id && p.id && p.actions[0].id);
});
