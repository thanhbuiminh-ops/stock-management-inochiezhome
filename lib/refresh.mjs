// Đọc snapshot đã lưu; nếu cũ hơn REFRESH_AFTER_SEC (hoặc bị ép làm mới) thì đọc lại Google Sheet.
// Không cần cron: dữ liệu chỉ được kéo khi có người đang xem, và có "cooldown" để không dồn dập gọi Google.
import { getEnv } from './env.mjs';
import { sheetConfig, fetchSheetValues } from './google.mjs';
import { parseSheet } from './sheet.mjs';
import { stockStore } from './store.mjs';

const COOLDOWN_AUTO_SEC = 30;
const COOLDOWN_FORCE_SEC = 15;

export async function getData({ force = false, nowMs = Date.now() } = {}) {
  const store = stockStore();
  let [snapshot, status] = await Promise.all([store.get('snapshot', { type: 'json' }), store.get('status', { type: 'json' })]);
  status ??= {};

  const nowSec = Math.floor(nowMs / 1000);
  const ttl = Math.max(60, Number(getEnv('REFRESH_AFTER_SEC')) || 300);
  const due = force || !snapshot || nowSec - snapshot.generatedAt >= ttl;
  const cooldown = force ? COOLDOWN_FORCE_SEC : COOLDOWN_AUTO_SEC;
  let refreshed = false;

  if (due && nowSec - (status.lastAttemptAt ?? 0) >= cooldown) {
    try {
      const cfg = sheetConfig();
      const parsed = parseSheet(await fetchSheetValues(cfg), { includeCost: cfg.includeCost });
      snapshot = { generatedAt: nowSec, source: 'google-sheet', tab: cfg.tab, hasCost: parsed.hasCost, warnings: parsed.warnings, items: parsed.items };
      status = { lastOkAt: nowSec, lastAttemptAt: nowSec, lastError: null };
      await store.setJSON('snapshot', snapshot);
      refreshed = true;
    } catch (e) {
      status = { ...status, lastAttemptAt: nowSec, lastError: { at: nowSec, message: String(e.message ?? e).slice(0, 300) } };
    }
    await store.setJSON('status', status);
  }
  return { snapshot: snapshot ?? null, status, serverTime: nowSec, refreshed };
}
