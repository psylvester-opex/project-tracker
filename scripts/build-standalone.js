// Builds a single self-contained HTML file (CSS and JS inlined) that works when
// opened directly from a phone or file manager, where sibling files can't load.
// Usage: node scripts/build-standalone.js [data.json] [output.html]
// The optional data file seeds the tracker on first open. Output goes to dist/,
// which is git-ignored — never commit a build that embeds real data.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const [dataFile, outFile] = process.argv.slice(2);
const out = outFile || path.join(root, 'dist', 'it-priorities.html');

// Keep inlined scripts from closing the <script> element early.
const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
const inline = (f) => `<script>\n${safe(pub(f))}\n</script>`;

let html = pub('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${pub('styles.css')}\n</style>`)
  .replace('<script src="model.js"></script>', () => inline('model.js'))
  .replace('<script src="xlsx.js"></script>', () => inline('xlsx.js'))
  .replace('<script src="app.js"></script>', () => {
    let seed = '';
    if (dataFile) {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      seed = `<script>window.EMBEDDED_DATA = ${safe(JSON.stringify(parsed.data || parsed))};</script>\n`;
    }
    return seed + inline('app.js');
  });

if (/<script src=|<link rel="stylesheet"/.test(html)) throw new Error('An asset was not inlined');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${Math.round(html.length / 1024)} KB)${dataFile ? ' with embedded data' : ''}`);
