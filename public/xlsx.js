// Bộ ghi .xlsx tối giản, thuần JS, không phụ thuộc thư viện (tương thích CSP: không eval, không tải script ngoài).
// File = ZIP không nén (method 0) chứa các part OOXML. Chuỗi ghi dạng inlineStr nên ô bắt đầu bằng = + - @ luôn là TEXT,
// không bao giờ bị Excel hiểu thành công thức (không cần thủ thuật dấu ' như CSV).
//
// buildXlsx([{ name, cols:[độ rộng], rows:[[cell,…]], freeze:{rows:1}, filter:true, merges:['A1:B1'], heights:{1:30} }]) -> Uint8Array
// cell = null | string | number | { v, bold, italic, color:'RRGGBB', fill:'RRGGBB', align:'left|center|right', valign:'top|center',
//                                    wrap:true, fmt:'int|pct1|pct2|text', border:true, size:11 }

const enc = new TextEncoder();

// ---------- CRC32 + ZIP (store) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStore(files, now = new Date()) {
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function colName(i) { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
const ref = (r, c) => colName(c) + (r + 1);
const hex = (v) => 'FF' + String(v).replace('#', '').toUpperCase();

export function safeSheetName(name, used) {
  let n = String(name ?? 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let k = 2, base = n;
  while (used.has(n.toLowerCase())) n = base.slice(0, 31 - String(k).length - 1) + ' ' + k++;
  used.add(n.toLowerCase());
  return n;
}

// ---------- styles ----------
const FMT_ID = { int: 3, pct1: 164, pct2: 10, text: 49 };   // 3 = #,##0 · 10 = 0.00% · 49 = @ · 164 = 0.0% (custom)
function styleRegistry() {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border>' + ['left', 'right', 'top', 'bottom'].map((s) => `<${s} style="thin"><color rgb="FFBFBFBF"/></${s}>`).join('') + '<diagonal/></border>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const idx = (arr, x) => { let i = arr.indexOf(x); if (i < 0) { arr.push(x); i = arr.length - 1; } return i; };
  const cache = new Map();
  const get = (st) => {
    if (!st || !Object.keys(st).some((k) => k !== 'v' && st[k] !== undefined)) return 0;
    const key = JSON.stringify([st.bold, st.italic, st.color, st.fill, st.align, st.valign, st.wrap, st.fmt, st.border, st.size]);
    if (cache.has(key)) return cache.get(key);
    const font = idx(fonts, `<font>${st.bold ? '<b/>' : ''}${st.italic ? '<i/>' : ''}<sz val="${st.size ?? 11}"/>${st.color ? `<color rgb="${hex(st.color)}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`);
    const fill = st.fill ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${hex(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = st.border ? 1 : 0;
    const numFmt = FMT_ID[st.fmt] ?? 0;
    const align = st.align || st.valign || st.wrap ? `<alignment${st.align ? ` horizontal="${st.align}"` : ''} vertical="${st.valign || 'center'}"${st.wrap ? ' wrapText="1"' : ''}/>` : '';
    const xf = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ''} applyFont="1"${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
    xfs.push(xf);
    cache.set(key, xfs.length - 1);
    return xfs.length - 1;
  };
  const xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>'
    + `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return { get, xml };
}

// ---------- worksheet ----------
function sheetXml(sh, styles) {
  const rows = sh.rows ?? [];
  let maxC = 0;
  const rowXml = rows.map((row, r) => {
    maxC = Math.max(maxC, row.length);
    const cells = row.map((cell, c) => {
      if (cell === null || cell === undefined) return '';
      const o = typeof cell === 'object' ? cell : { v: cell };
      const s = styles.get(o);
      const v = o.v;
      const sa = s ? ` s="${s}"` : '';
      if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return s ? `<c r="${ref(r, c)}"${sa}/>` : '';
      if (typeof v === 'number') return `<c r="${ref(r, c)}"${sa}><v>${v}</v></c>`;
      return `<c r="${ref(r, c)}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    const h = sh.heights?.[r + 1];
    return `<row r="${r + 1}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cells}</row>`;
  }).join('');
  const fz = sh.freeze;
  const pane = fz && (fz.rows || fz.cols)
    ? `<pane${fz.cols ? ` xSplit="${fz.cols}"` : ''}${fz.rows ? ` ySplit="${fz.rows}"` : ''} topLeftCell="${ref(fz.rows || 0, fz.cols || 0)}" activePane="${fz.rows && fz.cols ? 'bottomRight' : fz.rows ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
  const cols = sh.cols?.length ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const lastCol = Math.max(maxC, sh.cols?.length ?? 0, 1);
  const filter = sh.filter && rows.length ? `<autoFilter ref="A1:${ref(rows.length - 1, lastCol - 1)}"/>` : '';
  const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'   // in ra: vừa khổ ngang 1 trang rộng
    + `<dimension ref="A1:${ref(Math.max(rows.length - 1, 0), lastCol - 1)}"/>`
    + `<sheetViews><sheetView workbookViewId="0"${sh.first ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>`
    + cols + `<sheetData>${rowXml}</sheetData>` + filter + merges + '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
}

export function buildXlsx(sheets, now = new Date()) {
  if (!sheets.length) throw new Error('Cần ít nhất 1 sheet');
  const styles = styleRegistry(), used = new Set();
  const named = sheets.map((s, i) => ({ ...s, name: safeSheetName(s.name, used), first: i === 0 }));
  const bodies = named.map((s) => sheetXml(s, styles));   // phải chạy trước styles.xml để registry đã đủ
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>'
      + named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles.xml() },
    ...bodies.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: b })),
  ];
  return zipStore(files, now);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
