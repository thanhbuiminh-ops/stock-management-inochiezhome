// Dựng nội dung file Excel xuất ra từ từng tab (hàm thuần, không đụng DOM nên test được bằng node).
import { CHANNELS, channelOf, componentsOf, dealLabel, calcLine } from './logic.js';
import { buildXlsx } from './xlsx.js';

const HEAD = { bold: true, color: 'FFFFFF', fill: '1F4E5F', align: 'center', valign: 'center', wrap: true, border: true };
const BORDER = { border: true };
const STATUS = { over: { v: 'Over', fill: 'F8CBAD' }, pass: { v: 'Pass', fill: 'C6E0B4' } };

const nameOf = (c, getItem) => getItem(c.sku)?.name || c.srcName || c.sku || '';

// Bảng phẳng: dòng đầu là tiêu đề, số giữ dạng SỐ (sort/sum được trong Excel), có lọc + cố định dòng tiêu đề.
// fmt: { [chỉ số cột]: 'int' | 'pct1' | 'text' } — mặc định số nguyên có dấu phân cách nghìn.
export function tableSheet(name, head, rows, { widths, fmt = {} } = {}) {
  return {
    name, filter: true, freeze: { rows: 1 }, heights: { 1: 30 },
    cols: widths ?? head.map((h, i) => Math.max(10, Math.min(48, String(h).length + 4, ...rows.slice(0, 60).map((r) => String(r[i] ?? '').length + 2)))),
    rows: [head.map((h) => ({ v: h, ...HEAD })),
      ...rows.map((r) => r.map((v, i) => (typeof v === 'number' ? { v, ...BORDER, fmt: fmt[i] ?? (Number.isInteger(v) || Math.abs(v) >= 100 ? 'int' : undefined) } : { v: v ?? '', ...BORDER })))],
  };
}

// Bố cục đúng mẫu Sheet "Pricing Frame": mỗi channel 1 sheet; mỗi Campaign 1 dải màu; mỗi deal gồm dòng Main rồi các dòng Gift.
//   Campaign Type | Loại | Tên sản phẩm | Số lượng | RSP (Main) / COGS (Gift) | CIR | Max CIR | Status
// Combo: dòng Main đầu có RSP/CIR/Status của cả deal, các SKU gộp thêm là dòng Main tiếp theo (chỉ tên + số lượng).
export function forecastLayoutSheets(lines, getItem) {
  const sheets = [];
  const campaigns = (ls) => [...new Set(ls.map((l) => l.campaign))].sort((a, b) => (b === 'BAU') - (a === 'BAU') || a.localeCompare(b)); // BAU lên đầu
  for (const ch of CHANNELS) {
    const ls = lines.filter((l) => channelOf(l) === ch.key);
    if (!ls.length) continue;
    const rows = [['Campaign Type', 'Loại', 'Tên sản phẩm', 'Số lượng', 'RSP (Main)\nCOGS (Gift)', 'CIR', 'Max CIR', 'Status'].map((v) => ({ v, ...HEAD }))];
    for (const camp of campaigns(ls)) {
      rows.push([{ v: camp, bold: true, fill: 'FFD966', align: 'center', border: true }, ...Array.from({ length: 7 }, () => ({ v: '', fill: 'EFEFEF', border: true }))]);
      for (const l of ls.filter((x) => x.campaign === camp)) {
        const c = calcLine(l, getItem);
        const mainCell = (comp, first) => [
          { v: camp, ...BORDER }, { v: 'Main', align: 'center', ...BORDER },
          { v: nameOf(comp, getItem), color: 'C00000', fill: 'FFF2CC', ...BORDER },
          { v: comp.qty ?? 1, align: 'center', ...BORDER },
          first ? { v: Number(l.price) || null, fmt: 'int', ...BORDER } : { v: '', ...BORDER },
          first ? { v: c.cir, fmt: 'pct1', align: 'center', ...BORDER } : { v: '', ...BORDER },
          first ? { v: c.maxCir, fmt: 'pct1', align: 'center', ...BORDER } : { v: '', ...BORDER },
          first && STATUS[c.status] ? { ...STATUS[c.status], align: 'center', ...BORDER } : { v: '', ...BORDER },
        ];
        componentsOf(l).forEach((comp, i) => rows.push(mainCell(comp, i === 0)));
        for (const g of l.gifts) {
          rows.push([{ v: camp, ...BORDER }, { v: 'Gift', align: 'center', ...BORDER }, { v: nameOf(g, getItem), ...BORDER },
            { v: g.qty ?? 1, align: 'center', ...BORDER }, { v: Number(g.cost) || 0, fmt: 'int', ...BORDER }, { v: '', ...BORDER }, { v: '', ...BORDER }, { v: '', ...BORDER }]);
        }
      }
    }
    sheets.push({ name: ch.label, cols: [18, 9, 108, 10, 15, 9, 9, 10], freeze: { rows: 1 }, heights: { 1: 32 }, rows });
  }
  return sheets;
}

// Số liệu chi tiết mỗi line (kế hoạch + thực tế) — để lọc/pivot.
export function forecastFlatSheet(lines, getItem) {
  const head = ['Tháng', 'Channel', 'Campaign', 'Deal (SKU×SL)', 'Sản phẩm trong deal', 'Giá bán', 'SL dự kiến', 'GMV dự kiến', 'Số quà', 'Vốn quà / deal', 'CIR', 'Max CIR', 'Trạng thái CIR',
    'Chi tiết quà (SKU×SL@vốn)', 'SL thực tế', '% đạt KH', 'GMV thực tế (giá KH × SL TT)'];
  const lab = Object.fromEntries(CHANNELS.map((c) => [c.key, c.label]));
  const rows = lines.map((l) => {
    const c = calcLine(l, getItem), price = Number(l.price) || 0, done = Number.isInteger(l.actualUnits);
    return [l.month, lab[channelOf(l)], l.campaign, dealLabel(l), componentsOf(l).map((x) => nameOf(x, getItem)).join(' + '), price, l.units ?? '', l.units > 0 ? price * l.units : '', l.gifts.length, c.giftCost,
      c.cir ?? '', c.maxCir ?? '', c.status === 'over' ? 'Over' : c.status === 'pass' ? 'Pass' : '', l.gifts.map((g) => `${g.sku}×${g.qty}@${g.cost}`).join('; '),
      done ? l.actualUnits : '', done && l.units > 0 ? l.actualUnits / l.units : '', done ? price * l.actualUnits : ''];
  });
  return tableSheet('Số liệu chi tiết', head, rows, { fmt: { 10: 'pct1', 11: 'pct1', 15: 'pct1' }, widths: [10, 11, 20, 26, 48, 13, 11, 15, 8, 13, 8, 9, 11, 40, 11, 10, 20] });
}

export const forecastWorkbook = (lines, getItem) => buildXlsx([...forecastLayoutSheets(lines, getItem), forecastFlatSheet(lines, getItem)]);
