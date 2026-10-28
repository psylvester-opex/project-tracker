// Minimal zero-dependency server: serves the app and persists tracker data
// to data/tracker.json, with rolling snapshots in data/backups/.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'tracker.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKUPS = 100;
const MAX_BODY = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

fs.mkdirSync(BACKUP_DIR, { recursive: true });

let lastBackupAt = 0;

function readStore() {
  if (!fs.existsSync(DATA_FILE)) return { revision: 0, updatedAt: null, data: null };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeStore(store) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Snapshot the previous version before overwriting it. `force` is used for
// imports and restores, which replace everything.
function snapshot(force) {
  if (!fs.existsSync(DATA_FILE)) return;
  const now = Date.now();
  if (!force && now - lastBackupAt < BACKUP_INTERVAL_MS) return;
  lastBackupAt = now;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `tracker-${stamp}.json`));
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/data' && req.method === 'GET') {
    return send(res, 200, readStore());
  }

  if (url.pathname === '/api/data' && req.method === 'PUT') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) {
      return send(res, 400, { error: 'Invalid JSON' });
    }
    if (!payload || typeof payload.data !== 'object' || !Array.isArray(payload.data.areas)) {
      return send(res, 400, { error: 'Expected { baseRevision, data: { areas: [] } }' });
    }
    const current = readStore();
    // Optimistic concurrency: reject writes based on a stale copy (e.g. a second tab).
    if (payload.baseRevision !== current.revision) {
      return send(res, 409, { error: 'Data changed elsewhere', revision: current.revision });
    }
    snapshot(Boolean(payload.replace));
    const next = { revision: current.revision + 1, updatedAt: new Date().toISOString(), data: payload.data };
    writeStore(next);
    return send(res, 200, { revision: next.revision, updatedAt: next.updatedAt });
  }

  if (url.pathname === '/api/backups' && req.method === 'GET') {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    return send(res, 200, files.map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size })));
  }

  const m = url.pathname.match(/^\/api\/backups\/(tracker-[\w-]+\.json)$/);
  if (m && req.method === 'GET') {
    const file = path.join(BACKUP_DIR, m[1]);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    return send(res, 200, fs.readFileSync(file));
  }

  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`IT Priorities tracker running at http://${HOST}:${PORT}`);
    console.log(`Data file: ${DATA_FILE}`);
  });
}

module.exports = server;
