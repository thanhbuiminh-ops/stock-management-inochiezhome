// Forecast (kế hoạch bán hàng) do người dùng nhập trên web. Lưu thành MỘT tài liệu trong Netlify Blobs
// và ghi bằng "compare-and-set" (etag) + thử lại, nên hai người sửa cùng lúc không ghi đè mất dữ liệu của nhau.
import { randomUUID } from 'node:crypto';
import { stockStore } from './store.mjs';

export class ForecastError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const KEY = 'forecast';
const MAX_LINES = 3000;
const MAX_ADD = 200;
const MAX_GIFTS = 30;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function getForecast() {
  const cur = await stockStore().getWithMetadata(KEY, { type: 'json' });
  return cur?.data ?? { rev: 0, lines: [] };
}

const text = (v, max) => String(v ?? '').trim().slice(0, max);

function number(v, label, { min = 0, max, integer = false, nullable = false } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new ForecastError(400, `${label} không hợp lệ`);
  }
  return n;
}

// Chỉ giữ đúng các trường cho phép, ép kiểu và kiểm tra giới hạn (không tin dữ liệu từ trình duyệt).
export function sanitizeLine(raw) {
  if (!raw || typeof raw !== 'object') throw new ForecastError(400, 'Dòng không hợp lệ');
  const month = text(raw.month, 7);
  if (!MONTH.test(month)) throw new ForecastError(400, 'Tháng không hợp lệ (cần dạng YYYY-MM)');
  const campaign = text(raw.campaign, 40).toUpperCase();
  if (!campaign) throw new ForecastError(400, 'Thiếu Campaign Type');
  const mainSku = text(raw.main?.sku, 100);
  if (!mainSku) throw new ForecastError(400, 'Chưa chọn sản phẩm Main');
  if (!Array.isArray(raw.gifts ?? [])) throw new ForecastError(400, 'Danh sách quà không hợp lệ');
  const gifts = (raw.gifts ?? []).map((g) => {
    const sku = text(g?.sku, 100);
    if (!sku) throw new ForecastError(400, 'Có quà tặng chưa chọn sản phẩm');
    return {
      sku,
      srcName: text(g?.srcName, 300),
      qty: number(g?.qty, 'Số lượng quà', { min: 1, max: 1000, integer: true }),
      cost: number(g?.cost, 'Giá vốn quà', { min: 0, max: 1e9 }),
    };
  });
  if (gifts.length > MAX_GIFTS) throw new ForecastError(400, `Tối đa ${MAX_GIFTS} quà mỗi dòng`);
  return {
    month,
    campaign,
    main: { sku: mainSku, srcName: text(raw.main?.srcName, 300) },
    price: number(raw.price, 'Giá bán', { min: 0, max: 1e9 }),
    units: number(raw.units, 'SL dự kiến', { min: 0, max: 1e7, integer: true, nullable: true }),
    maxCir: number(raw.maxCir, 'Max CIR', { min: 0, max: 1, nullable: true }),
    gifts,
  };
}

const skusOf = (l) => [l.main.sku, ...l.gifts.map((g) => g.sku)];

// Mỗi (tháng, SKU) -> { main, gift }: số lượng cần xuất theo Forecast.
// Quà tặng cũng trừ tồn: mỗi Main bán ra kéo theo `qty` quà. Dòng chưa nhập SL dự kiến thì chưa tính nhu cầu.
export function demandByMonth(lines) {
  const out = {};
  for (const l of lines) {
    if (!(l.units > 0)) continue;
    const m = (out[l.month] ??= {});
    (m[l.main.sku] ??= { main: 0, gift: 0 }).main += l.units;
    for (const g of l.gifts) (m[g.sku] ??= { main: 0, gift: 0 }).gift += l.units * g.qty;
  }
  return out;
}

// body: { op:'add', lines:[…] } | { op:'update', id, rev, line } | { op:'delete', id }
export async function applyOp(body, user, { nowMs = Date.now() } = {}) {
  if (!body || typeof body !== 'object') throw new ForecastError(400, 'Yêu cầu không hợp lệ');
  const store = stockStore();
  const snap = await store.get('snapshot', { type: 'json' });
  const known = snap ? new Set(snap.items.map((i) => i.sku)) : null; // chưa có dữ liệu Sheet thì chưa kiểm tra được
  const checkSkus = (line, skip = new Set()) => {
    if (!known) return;
    const bad = skusOf(line).find((s) => !known.has(s) && !skip.has(s));
    if (bad) throw new ForecastError(400, `SKU "${bad}" không có trong tab ${snap.tab ?? 'COGS'} của Sheet`);
  };
  const now = new Date(nowMs).toISOString();

  const mutate = (doc) => {
    if (body.op === 'add') {
      if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > MAX_ADD) {
        throw new ForecastError(400, `Mỗi lần thêm 1–${MAX_ADD} dòng`);
      }
      if (doc.lines.length + body.lines.length > MAX_LINES) throw new ForecastError(400, `Tối đa ${MAX_LINES} dòng Forecast`);
      const created = body.lines.map((raw) => {
        const line = sanitizeLine(raw);
        checkSkus(line);
        return { ...line, id: randomUUID(), rev: 1, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
      });
      doc.lines.push(...created);
      return { created: created.map((l) => l.id) };
    }
    if (body.op === 'update') {
      const i = doc.lines.findIndex((l) => l.id === body.id);
      if (i < 0) throw new ForecastError(404, 'Không tìm thấy dòng (có thể đã bị xoá)');
      const cur = doc.lines[i];
      if (body.rev !== cur.rev) throw new ForecastError(409, 'Dòng này vừa được người khác sửa. Hãy tải lại.');
      const line = sanitizeLine(body.line);
      checkSkus(line, new Set(skusOf(cur))); // SKU đã có sẵn trong dòng thì không bắt buộc còn trong Sheet
      doc.lines[i] = { ...cur, ...line, rev: cur.rev + 1, updatedAt: now, updatedBy: user };
      return { id: cur.id, lineRev: cur.rev + 1 };
    }
    if (body.op === 'delete') {
      const n = doc.lines.length;
      doc.lines = doc.lines.filter((l) => l.id !== body.id); // idempotent
      return { deleted: n - doc.lines.length };
    }
    throw new ForecastError(400, 'Thao tác không hợp lệ');
  };

  for (let attempt = 0; attempt < 16; attempt++) {
    const cur = await store.getWithMetadata(KEY, { type: 'json' });
    const doc = structuredClone(cur?.data ?? { rev: 0, lines: [] });
    const result = mutate(doc);
    doc.rev += 1;
    const cond = !cur ? { onlyIfNew: true } : cur.etag ? { onlyIfMatch: cur.etag } : undefined;
    const res = await store.setJSON(KEY, doc, cond);
    if (res?.modified !== false) return { ...result, rev: doc.rev };
    // có người ghi xen vào giữa -> chờ ngẫu nhiên một chút (tránh đụng nhau lặp lại) rồi đọc lại và áp dụng lại thao tác
    await new Promise((r) => setTimeout(r, Math.random() * 15 * (attempt + 1)));
  }
  throw new ForecastError(409, 'Nhiều người đang sửa cùng lúc, hãy thử lại.');
}
