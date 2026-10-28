const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itp-'));
process.env.DATA_DIR = dir;
const server = require('../server.js');

let base;
test.before(() => new Promise(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`; r();
})));
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const put = (body) => fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('starts empty, saves, and enforces revisions', async () => {
  let res = await fetch(base + '/api/data');
  assert.deepStrictEqual((await res.json()).revision, 0);

  res = await put({ baseRevision: 0, data: { areas: [{ title: 'A' }] } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).revision, 1);

  res = await put({ baseRevision: 0, data: { areas: [] } });
  assert.strictEqual(res.status, 409, 'stale write is rejected');

  res = await fetch(base + '/api/data');
  const store = await res.json();
  assert.strictEqual(store.data.areas[0].title, 'A');
});

test('replace writes take a backup snapshot', async () => {
  const res = await put({ baseRevision: 1, replace: true, data: { areas: [] } });
  assert.strictEqual(res.status, 200);
  const list = await (await fetch(base + '/api/backups')).json();
  assert.ok(list.length >= 1);
  const snap = await (await fetch(base + '/api/backups/' + list[0].name)).json();
  assert.strictEqual(snap.data.areas[0].title, 'A');
});

test('rejects malformed payloads and path traversal', async () => {
  assert.strictEqual((await put({ baseRevision: 2, data: {} })).status, 400);
  assert.strictEqual((await fetch(base + '/..%2fserver.js')).status, 403);
  assert.strictEqual((await fetch(base + '/index.html')).status, 200);
});
