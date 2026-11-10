// Logic thuần (không đụng DOM) dùng chung cho trình duyệt và test: đọc dữ liệu dán từ Google Sheet,
// ghép tên sản phẩm gần giống, tính CIR / giá vốn quà.

export const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "2,075,000" | "2.075.000" | "2075000" | 2075000 -> số; "4.1%" / chữ lạ -> null
export function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/[₫đ\s]/gi, '');
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  if (/^-?\d+[.,]\d{1,2}$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

// "4.0%" | "4%" | 0.04 -> 0.04
export function parsePercent(v) {
  if (typeof v === 'number') return v > 1 ? v / 100 : v;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return s.includes('%') || n > 1 ? n / 100 : n;
}

// Max CIR theo Campaign Type: BAU 4%, MINI SPIKE 5% — đọc từ cột "Max CIR" trong ảnh Sheet bạn gửi.
// Campaign khác (vd MINPRICE) chưa có dữ liệu nên để trống; có thể nhập tay từng dòng.
export const DEFAULT_MAX_CIR = { BAU: 0.04, 'MINI SPIKE': 0.05 };
export const defaultMaxCir = (campaign) => DEFAULT_MAX_CIR[String(campaign ?? '').trim().toUpperCase()] ?? null;

function cell(v) {
  const s = String(v ?? '').trim();
  return s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"').trim() : s;
}

// Dữ liệu copy từ Google Sheet là TSV. Cột như trong sheet: Campaign Type | Loại (Main/Gift) | Tên sản phẩm |
// Số lượng | RSP (Main) / COGS (Gift) | CIR | Max CIR | Status. Có hay không dòng tiêu đề đều được; copy bắt đầu từ
// cột nào cũng được (tìm cột "Main/Gift" để định vị). Mỗi dòng Main mở một line mới, các dòng Gift bên dưới thuộc về nó.
export function parsePaste(raw) {
  const warnings = [];
  const rows = String(raw ?? '').split(/\r?\n/).map((r) => r.split('\t').map(cell)).filter((r) => r.some((c) => c !== ''));
  const isType = (c) => ['main', 'gift'].includes(norm(c));

  let col = null;
  for (const r of rows.slice(0, 6)) {
    const h = r.map(norm);
    const t = h.indexOf('loai'), n = h.indexOf('ten san pham');
    if (t >= 0 && n >= 0) {
      col = {
        type: t, name: n,
        campaign: h.findIndex((x) => x.startsWith('campaign')),
        qty: h.findIndex((x) => x === 'so luong'),
        price: h.findIndex((x) => x.startsWith('rsp') || x.includes('gia ban')),
        maxCir: h.findIndex((x) => x === 'max cir'),
      };
      break;
    }
  }
  if (!col) {
    const t = Math.max(0, ...rows.slice(0, 20).map((r) => r.findIndex(isType)).filter((i) => i >= 0).slice(0, 1));
    col = { type: t, campaign: t - 1, name: t + 1, qty: t + 2, price: t + 3, maxCir: t + 5 };
  }

  const lines = [];
  let cur = null, section = '', orphan = 0, other = 0;
  for (const r of rows) {
    const kind = norm(r[col.type]);
    if (kind !== 'main' && kind !== 'gift') {
      // dòng tiêu đề / dòng tên campaign (vd "BAU", "MINI SPIKE") / dòng tiêu đề bảng
      const label = col.campaign >= 0 ? r[col.campaign] : r[0];
      const looksHeader = r.some((c) => ['loai', 'ten san pham'].includes(norm(c)));
      if (!looksHeader && label && r.filter((c) => c !== '').length === 1) section = label.toUpperCase();
      else if (!looksHeader) other++;
      continue;
    }
    const name = r[col.name] ?? '';
    const num = col.price >= 0 ? parseNumber(r[col.price]) : null;
    const qty = col.qty >= 0 ? parseNumber(r[col.qty]) : null;
    if (kind === 'main') {
      const campaign = ((col.campaign >= 0 ? r[col.campaign] : '') || section).toUpperCase();
      cur = { campaign, mainName: name, price: num, maxCir: col.maxCir >= 0 ? parsePercent(r[col.maxCir]) : null, gifts: [] };
      lines.push(cur);
    } else if (!cur) {
      orphan++;
    } else {
      cur.gifts.push({ name, qty: qty && qty >= 1 ? Math.round(qty) : 1, cost: num });
    }
  }
  if (orphan) warnings.push(`Bỏ qua ${orphan} dòng Gift nằm trước dòng Main đầu tiên.`);
  if (other) warnings.push(`Bỏ qua ${other} dòng không phải Main/Gift.`);
  for (const l of lines) {
    if (!l.mainName) warnings.push('Có dòng Main không có tên sản phẩm.');
    if (l.price === null) warnings.push(`"${l.mainName}": không đọc được giá bán (RSP).`);
  }
  if (!lines.length) warnings.push('Không thấy dòng Main nào. Hãy copy cả cột "Loại" (Main/Gift) và "Tên sản phẩm" từ Google Sheet.');
  return { lines, warnings };
}

// ---------- ghép tên gần giống ----------
const tok = (s) => norm(s).split(' ').filter(Boolean);
// token có chữ số (mã model, dung tích: 4l, 500ml, 2752) quan trọng hơn; từ rất ngắn và tên thương hiệu thì nhẹ hơn
const weight = (t) => (/\d/.test(t) ? 2 : t === 'inochi' ? 0.2 : t.length <= 2 ? 0.3 : 1);
const sum = (set) => [...set].reduce((s, t) => s + weight(t), 0);

export function similarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = new Set(tok(a)), B = new Set(tok(b));
  const common = [...A].filter((t) => B.has(t));
  const wc = sum(common), wa = sum(A), wb = sum(B);
  const dice = (2 * wc) / (wa + wb);
  // tên bị cắt ngắn ("…"): chuỗi ngắn nằm trọn trong chuỗi dài
  const contain = Math.min(wa, wb) >= 2 ? (wc / Math.min(wa, wb)) * 0.92 : 0;
  return Math.max(dice, contain);
}

const candidates = (it) => [it.name, it.shortName, it.sku].filter(Boolean);

export function rank(query, items, limit = 6) {
  const q = norm(query);
  if (!q) return [];
  return items
    .map((item) => {
      let score = Math.max(...candidates(item).map((c) => similarity(query, c)));
      if (item.sku && q.includes(norm(item.sku))) score = Math.max(score, 0.99); // tên có kèm mã SKU
      return { item, score };
    })
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit);
}

// exact = trùng tên · good = rất giống · weak = gần giống, nên kiểm tra · none = không tìm thấy
export const confidence = (score) => (score >= 0.999 ? 'exact' : score >= 0.8 ? 'good' : score >= 0.5 ? 'weak' : 'none');

// Ô tìm trong bộ chọn sản phẩm: gõ tới đâu lọc tới đó (mỗi từ gõ vào phải khớp đầu một từ của tên/SKU)
export function search(query, items, limit = 8) {
  const qt = tok(query);
  if (!qt.length) return [];
  const out = [];
  for (const item of items) {
    const ct = tok(`${item.name} ${item.shortName} ${item.sku}`);
    if (qt.every((q) => ct.some((c) => c.startsWith(q)))) out.push({ item, score: similarity(query, item.name) });
  }
  return out.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, limit);
}

// Chọn sẵn kết quả tốt nhất nếu đủ giống; nếu không để trống cho người dùng chọn
export function autoMatch(name, items) {
  const [best] = rank(name, items, 1);
  if (best && best.score >= 0.5) return { sku: best.item.sku, score: best.score, conf: confidence(best.score) };
  return { sku: '', score: best?.score ?? 0, conf: 'none' };
}

// ---------- tính toán một line ----------
// line = { price, maxCir, campaign, main:{sku}, gifts:[{qty,cost}] }
export function calcLine(line, getItem) {
  const giftCost = line.gifts.reduce((s, g) => s + (Number(g.qty) || 0) * (Number(g.cost) || 0), 0);
  const price = Number(line.price) || 0;
  const cir = price > 0 ? giftCost / price : null;
  const maxCir = line.maxCir ?? defaultMaxCir(line.campaign);
  const over = cir !== null && maxCir !== null && cir > maxCir;
  const cogs = getItem(line.main?.sku)?.cogs ?? null;
  return {
    giftCost, cir, maxCir, over,
    overAmount: over ? Math.round(giftCost - maxCir * price) : 0,
    status: cir === null || maxCir === null ? 'na' : over ? 'over' : 'pass',
    mainCogs: cogs,
    gmPct: cogs !== null && price > 0 ? (price - cogs) / price : null,        // biên gộp trước quà
    afterGifts: cogs !== null ? price - cogs - giftCost : null,                // lãi gộp sau quà (chưa trừ phí sàn/ads/voucher)
    afterGiftsPct: cogs !== null && price > 0 ? (price - cogs - giftCost) / price : null,
  };
}
