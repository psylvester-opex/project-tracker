// Minimal dependency-free .xlsx reader and writer — enough for a single
// sheet of text, numbers and dates. Reading uses the platform's
// DecompressionStream (all current browsers, Node 18+).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiniXlsx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------- Zip ----------
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory.');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      files[name] = { method, data: u8.subarray(start, start + csize) };
    }
    return {
      has: (name) => Boolean(files[name]),
      async text(name) {
        const f = files[name];
        if (!f) return null;
        if (f.method === 0) return dec.decode(f.data);
        if (f.method === 8) return dec.decode(await inflateRaw(f.data));
        throw new Error('Unsupported zip compression in ' + name);
      },
    };
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Stored (uncompressed) zip — tiny files, so compression isn't worth the code.
  function zip(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const nameBytes = enc.encode(name);
      const data = enc.encode(content);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
    let o = 0;
    for (const b of all) { out.set(b, o); o += b.length; }
    return out;
  }

  // ---------- XML helpers ----------
  const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  const escapeXml = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
    // Strip characters that are illegal in XML 1.0.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? unescapeXml(m[1]) : null; };
  // Concatenate all <t> runs (handles rich text) and ignore phonetic <rPh> blocks.
  const textOf = (xml) => unescapeXml((xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').match(/<t\b[^>]*>[\s\S]*?<\/t>|<t\b[^>]*\/>/g) || [])
    .map(t => t.replace(/^<t\b[^>]*>|<\/t>$|^<t\b[^>]*\/>$/g, '')).join(''));

  function colIndex(ref) {
    let n = 0;
    for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // ---------- Read ----------
  // Returns { sheetNames: [...], sheets: { name: rows[][] } }.
  async function read(buf) {
    const z = await unzip(buf);
    const wb = await z.text('xl/workbook.xml');
    if (!wb) throw new Error('Not an Excel workbook (xl/workbook.xml missing).');
    const rels = (await z.text('xl/_rels/workbook.xml.rels')) || '';
    const relMap = {};
    for (const tag of rels.match(/<Relationship\b[^>]*>/g) || []) relMap[attr(tag, 'Id')] = attr(tag, 'Target');

    const shared = [];
    const sst = await z.text('xl/sharedStrings.xml');
    if (sst) for (const si of sst.match(/<si\b[\s\S]*?<\/si>/g) || []) shared.push(textOf(si));

    const out = { sheetNames: [], sheets: {} };
    for (const tag of wb.match(/<sheet\b[^>]*>/g) || []) {
      const name = attr(tag, 'name');
      let target = relMap[attr(tag, 'r:id')] || '';
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const xml = await z.text(target);
      if (xml === null) continue;
      out.sheetNames.push(name);
      out.sheets[name] = parseSheet(xml, shared);
    }
    return out;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    const data = (xml.match(/<sheetData\b[\s\S]*?<\/sheetData>/) || [''])[0];
    for (const rowXml of data.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []) {
      const r = Number(attr(rowXml.match(/<row\b[^>]*>/)[0], 'r')) - 1;
      const row = [];
      for (const c of rowXml.match(/<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g) || []) {
        const open = c.match(/<c\b[^>]*>/)[0];
        const ref = attr(open, 'r');
        const t = attr(open, 't');
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (t === 's') val = v !== undefined ? (shared[Number(v)] || '') : '';
        else if (t === 'inlineStr') val = textOf((c.match(/<is>[\s\S]*?<\/is>/) || [''])[0]);
        else if (t === 'str' || t === 'e') val = v !== undefined ? unescapeXml(v) : '';
        else if (t === 'b') val = v === '1';
        else if (v !== undefined) val = Number(v);
        const idx = ref ? colIndex(ref) : row.length;
        while (row.length < idx) row.push('');
        row[idx] = val;
      }
      while (rows.length < r) rows.push([]);
      rows[r >= 0 ? r : rows.length] = row;
    }
    return rows;
  }

  // ---------- Write ----------
  // rows: array of arrays of string | number | Date. Row 0 is a bold header.
  function write(rows, opts) {
    const o = opts || {};
    const sheetName = escapeXml((o.sheetName || 'Sheet1').slice(0, 31));
    const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const toSerial = (d) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 25569;
    const body = rows.map((row, ri) => {
      const cells = row.map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        const header = ri === 0 && o.header !== false;
        if (v instanceof Date) return `<c r="${ref}" s="1"><v>${toSerial(v)}</v></c>`;
        if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${header ? ' s="2"' : ''}><v>${v}</v></c>`;
        if (v === '' || v === null || v === undefined) return '';
        const s = escapeXml(v);
        return `<c r="${ref}" t="inlineStr"${header ? ' s="2"' : ' s="3"'}><is><t xml:space="preserve">${s}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const cols = (o.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${body}</sheetData></worksheet>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    return zip([
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/worksheets/sheet1.xml', sheet],
      ['xl/styles.xml', styles],
    ]);
  }

  return { read, write, unzip, zip };
});
