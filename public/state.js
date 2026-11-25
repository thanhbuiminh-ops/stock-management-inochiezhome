// Trạng thái dùng chung của các màn hình + các hàm đọc dữ liệu (selector).
export const state = {
  data: null, error: null, tab: 'stock',
  // Tồn kho
  q: '', categories: new Set(), status: 'all', dataFlag: '',
  ranges: { cogs: { min: null, max: null }, value: { min: null, max: null }, total: { min: null, max: null }, north: { min: null, max: null }, south: { min: null, max: null } }, sort: 'attention', view: 'cards', showCharts: true, hiddenTypes: new Set(),
  // Plan (dữ liệu dán, chưa lưu)
  staged: [], pasteWarnings: [], stagedChannel: '',
  manual: { open: false, q: '', sel: new Map(), includeOther: false, campaign: '' },
  // Forecast
  fcQ: '', fcMonth: '', fcCampaign: '', fcChannel: '', fcOnlyAlert: false, fcView: 'lines', fcCollapsed: new Set(),
  // Overall (tổng hợp theo channel / SKU)
  ov: { month: '', channels: new Set(), campaign: '', category: '', q: '', sort: 'gmv', top: 20, onlyAlert: false },
};

// Các hàm do app.js gắn vào để module con gọi ngược lại mà không import vòng.
export const hooks = { render() {}, reload: async () => {} };

export const items = () => state.data?.snapshot?.items ?? [];
export const alertMonth = () => state.data?.alertMonth ?? '';
export const currentMonth = () => state.data?.currentMonth ?? '';
export const forecastLines = () => state.data?.forecast?.lines ?? [];
export const rules = () => state.data?.rules ?? { bufferPct: 20, southSharePct: 70 };

let cache = { snap: null, map: new Map() };
export function itemBySku(sku) {
  const snap = state.data?.snapshot;
  if (cache.snap !== snap) cache = { snap, map: new Map((snap?.items ?? []).map((it) => [it.sku, it])) };
  return cache.map.get(sku);
}

export const evalFor = (sku, month) => state.data?.plan?.evaluations?.[month]?.[sku] ?? null;
