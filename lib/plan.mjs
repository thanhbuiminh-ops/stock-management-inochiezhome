// Đánh giá tồn kho so với nhu cầu từ Forecast. Toàn bộ logic cảnh báo nằm ở đây (thuần hàm, có test);
// frontend chỉ hiển thị kết quả.
import { getEnv } from './env.mjs';
import { demandByMonth } from './forecast.mjs';

const UTC7_MS = 7 * 3600 * 1000;
const monthKey = (y, m) => (y >= 2000 && y <= 2100 && m >= 1 && m <= 12 ? `${y}-${String(m).padStart(2, '0')}` : null);

// Tháng kế tiếp theo giờ Việt Nam (UTC+7).
export function nextMonthKey(nowMs = Date.now()) {
  const d = new Date(nowMs + UTC7_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
}

export function planRules(env = getEnv) {
  const pct = (name, def) => {
    const raw = env(name);
    const n = raw === undefined || raw === '' ? def : Number(raw);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : def;
  };
  return {
    bufferPct: Math.min(500, Math.max(0, Number(env('PLAN_BUFFER_PCT') ?? 20) || 0)),
    southSharePct: pct('PLAN_SOUTH_SHARE_PCT', 70),
  };
}

export const LEVEL_RANK = { out: 0, short: 1, south: 2, tight: 3, ok: 4, nodata: 5, none: 6 };

// qty = số lượng kế hoạch bán của tháng. Chỉ so tồn hiện có với plan; KHÔNG tính hàng đang về (Sheet không có dữ liệu đó).
export function evaluate({ north, south, total }, qty, rules) {
  if (!(qty > 0)) return { qty: 0, level: 'none' };
  const needSouth = Math.ceil((qty * rules.southSharePct) / 100);
  const base = { qty, needSouth, tightBelow: Math.ceil(qty * (1 + rules.bufferPct / 100)) };
  if (total === null || total === undefined) return { ...base, level: 'nodata' };
  const n = north ?? 0;
  const s = south ?? 0;
  const gapTotal = Math.max(0, qty - total);
  const gapSouth = Math.max(0, needSouth - s);
  const northSpare = Math.max(0, n - (qty - needSouth)); // tồn Bắc vượt phần Bắc cần cho plan
  let level = 'ok';
  if (total === 0) level = 'out';
  else if (total < qty) level = 'short';
  else if (gapSouth > 0) level = 'south';
  else if (total < base.tightBelow) level = 'tight';
  return { ...base, level, gapTotal, gapSouth, transferable: Math.min(gapSouth, northSpare), coverage: total / qty };
}

// Gắn Forecast + kết quả đánh giá vào response của API. Tháng "cảnh báo" = tháng kế tiếp theo giờ VN.
// Nhu cầu mỗi SKU = tổng SL Main dự kiến + quà tặng kèm (xem demandByMonth).
export function withPlanView(data, forecast = { rev: 0, lines: [] }, nowMs = Date.now(), env = getEnv) {
  const rules = planRules(env);
  const alertMonth = nextMonthKey(nowMs);
  const snap = data?.snapshot;
  if (!snap) return { ...data, forecast, plan: null, rules, alertMonth };
  const bySku = new Map(snap.items.map((it) => [it.sku, it]));
  const demand = demandByMonth(forecast.lines);
  const evaluations = {};
  for (const m of Object.keys(demand).sort()) {
    evaluations[m] = {};
    for (const [sku, d] of Object.entries(demand[m])) {
      const it = bySku.get(sku);
      if (it) evaluations[m][sku] = { ...evaluate(it, d.main + d.gift, rules), main: d.main, gift: d.gift };
    }
  }
  return { ...data, forecast, rules, alertMonth, plan: { months: Object.keys(evaluations), evaluations } };
}
