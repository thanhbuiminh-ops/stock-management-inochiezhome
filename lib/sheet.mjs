// Chuyển dữ liệu thô của tab Google Sheet thành snapshot. Đọc cột theo TÊN tiêu đề (không theo vị trí),
// nên chèn/đổi thứ tự cột không làm hỏng. Đổi tên tiêu đề thì sẽ báo lỗi rõ ràng.
export class SheetFormatError extends Error {}

export const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// khoá -> các tên tiêu đề chấp nhận (đã chuẩn hoá: không dấu, chữ thường, "_" thành khoảng trắng)
const ALIASES = {
  image: ['link anh'],
  sku: ['master sku'],
  name: ['product name'],
  shortName: ['short name'],
  type: ['type'],
  category: ['category'],
  cogs: ['cogs'],
  north: ['boxme bac'],
  south: ['boxme nam'],
  total: ['total stock bm'],
};
const LABEL = {
  image: 'Link Ảnh', sku: 'Master SKU', name: 'Product Name', shortName: 'Short Name', type: 'TYPE', category: 'Category',
  cogs: 'COGS', north: 'Boxme Bắc', south: 'Boxme Nam', total: 'Total Stock_BM',
};
const REQUIRED = ['sku', 'type', 'north', 'south'];
const MAX_ITEMS = 5000;
const SHEET_ERROR = /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)/i;

function text(v, max = 300) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return SHEET_ERROR.test(s) ? '' : s.slice(0, max);
}

// null = ô trống / lỗi công thức; 0 là số 0 thật
export function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || SHEET_ERROR.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  return null;
}

const httpsUrl = (v) => {
  const s = text(v, 600);
  return /^https:\/\//i.test(s) ? s : null;
};

export function parseSheet(values, { includeCost = false } = {}) {
  const rows = Array.isArray(values) ? values : [];
  const headerIdx = rows.slice(0, 10).findIndex((r) => Array.isArray(r) && r.some((c) => norm(c) === 'master sku'));
  if (headerIdx < 0) throw new SheetFormatError('Không tìm thấy dòng tiêu đề có cột "Master SKU" trong 10 dòng đầu của tab.');

  const headerRaw = rows[headerIdx];
  const header = headerRaw.map(norm);
  const col = {};
  for (const [key, aliases] of Object.entries(ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[key] = i;
  }
  const missing = REQUIRED.filter((k) => col[k] === undefined);
  if (missing.length) {
    throw new SheetFormatError(`Thiếu cột bắt buộc: ${missing.map((k) => LABEL[k]).join(', ')}. Các cột đang có: ${headerRaw.map((c) => text(c, 40)).filter(Boolean).join(' | ').slice(0, 300)}`);
  }
  const warnings = Object.keys(ALIASES)
    .filter((k) => !REQUIRED.includes(k) && col[k] === undefined && (k !== 'cogs' || includeCost))
    .map((k) => `Không thấy cột "${LABEL[k]}" — dữ liệu phần này sẽ để trống.`);

  const cell = (r, k) => (col[k] === undefined ? undefined : r[col[k]]);
  const items = [];
  for (const r of rows.slice(headerIdx + 1)) {
    if (!Array.isArray(r)) continue;
    const sku = text(cell(r, 'sku'), 100);
    if (!sku) continue; // dòng trống / dòng ghi chú
    const north = parseNumber(cell(r, 'north'));
    const south = parseNumber(cell(r, 'south'));
    const total = parseNumber(cell(r, 'total')) ?? (north === null && south === null ? null : (north ?? 0) + (south ?? 0));
    const item = {
      sku,
      name: text(cell(r, 'name')),
      shortName: text(cell(r, 'shortName')),
      type: text(cell(r, 'type'), 60),
      category: text(cell(r, 'category'), 100),
      image: httpsUrl(cell(r, 'image')),
      north, south, total,
    };
    if (includeCost) item.cogs = parseNumber(cell(r, 'cogs'));
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  if (items.length === 0) throw new SheetFormatError('Không có dòng sản phẩm nào (cột Master SKU trống hết).');
  return { items, warnings, hasCost: includeCost && col.cogs !== undefined };
}
