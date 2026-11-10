// Trạng thái dùng chung của các màn hình + các hàm đọc dữ liệu (selector).
export const state = {
  data: null, error: null, tab: 'stock',
  // Tồn kho
  q: '', category: '', status: 'all', sort: 'attention', view: 'cards', showCharts: true, hiddenTypes: new Set(['other']),
  // Plan (dữ liệu dán, chưa lưu)
  staged: [], pasteWarnings: [],
  // Forecast
  fcQ: '', fcMonth: '', fcCampaign: '', fcOnlyAlert: false, fcView: 'lines', fcCollapsed: new Set(),
};

// Các hàm do app.js gắn vào để module con gọi ngược lại mà không import vòng.
export const hooks = { render() {}, reload: async () => {} };

export const items = () => state.data?.snapshot?.items ?? [];
export const alertMonth = () => state.data?.alertMonth ?? '';
export const forecastLines = () => state.data?.forecast?.lines ?? [];
export const rules = () => state.data?.rules ?? { bufferPct: 20, southSharePct: 70 };

let cache = { snap: null, map: new Map() };
export function itemBySku(sku) {
  const snap = state.data?.snapshot;
  if (cache.snap !== snap) cache = { snap, map: new Map((snap?.items ?? []).map((it) => [it.sku, it])) };
  return cache.map.get(sku);
}

export const evalFor = (sku, month) => state.data?.plan?.evaluations?.[month]?.[sku] ?? null;
