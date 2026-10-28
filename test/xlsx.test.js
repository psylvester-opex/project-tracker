const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('../public/xlsx.js');
const M = require('../public/model.js');

// Fixture written by openpyxl (shared strings, deflate, real date cells),
// in the same layout as the IT Priorities workbook. Fictional content.
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-priorities.xlsx'));

test('reads an Excel-produced workbook into the tracker model', async () => {
  const wb = await X.read(fixture);
  assert.deepStrictEqual(wb.sheetNames, ['Priorities', 'Accountability']);
  const doc = M.importRows(wb.sheets.Priorities);
  assert.deepStrictEqual(doc.areas.map(a => a.title), ['Strategy & Operating Model', 'Data & Analytics']);
  const [first, second] = doc.areas[0].projects[0].actions;
  assert.strictEqual(first.title, 'Finalize JDs & salaries <with HR>');
  assert.strictEqual(first.nextDate, '2026-10-27');
  assert.strictEqual(second.nextDate, '');
  assert.strictEqual(doc.areas[1].projects[0].actions[0].title, 'Provision “workspace” — ünïcode');
});

test('written workbooks read back identically', async () => {
  const doc = M.importRows((await X.read(fixture)).sheets.Priorities);
  doc.areas[0].projects[0].owner = 'A & B';
  doc.areas[0].projects[0].notes = 'line 1\nline 2';
  const rows = M.exportRows(doc).map((r, i) => i ? r.map((v, c) => (c === 2 && v) ? new Date(v + 'T00:00') : v) : r);
  const back = M.importRows((await X.read(X.write(rows, { sheetName: 'Priorities' }))).sheets.Priorities);
  const strip = d => JSON.stringify(d, (k, v) => k === 'id' ? undefined : v);
  assert.strictEqual(strip(back), strip(doc));
});

test('rejects files that are not workbooks', async () => {
  await assert.rejects(X.read(Buffer.from('not a zip')), /valid \.xlsx/);
});
