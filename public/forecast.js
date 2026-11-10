// Tab Forecast: các line đã lưu. Sửa trực tiếp (đổi quà, giá, SL, campaign…), tự lưu sau khi ngừng gõ ~0,7 giây.
import { state, items, itemBySku, alertMonth, forecastLines, evalFor, hooks } from './state.js';
import { $, el, thumb, toast, fmtNum, fmtMoney, fmtPct, monthLabel, LEVEL, ALERT_LEVELS, alertText, stockChips, skuButton } from './ui.js';
import { calcLine, DEFAULT_MAX_CIR } from './logic.js';
import { lineCard, lineIssues, clean, setLineStatus } from './linecard.js';
import { postForecast } from './api.js';

// ---------- tự lưu ----------
const timers = new Map();
const chains = new Map();
let inflight = 0;
let dirty = false;   // đã lưu thay đổi mà chưa tải lại cảnh báo tồn

export function isEditingForecast() {
  const a = document.activeElement;
  return state.tab === 'forecast' && !!a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName) && !!a.closest('#fcBody');
}
// Đang gõ / còn thay đổi chưa lưu: không được thay dữ liệu dưới chân người dùng
export const forecastBusy = () => timers.size > 0 || inflight > 0 || isEditingForecast();

function queueSave(line) {
  clearTimeout(timers.get(line.id));
  const issues = lineIssues(line);
  if (issues.length) { timers.delete(line.id); setLineStatus(line.id, 'Chưa lưu — ' + issues[0], 'warn'); return; }
  setLineStatus(line.id, 'Chờ lưu…', 'pending');
  timers.set(line.id, setTimeout(() => {
    timers.delete(line.id);
    chains.set(line.id, (chains.get(line.id) ?? Promise.resolve()).then(() => persist(line)));
  }, 700));
}

async function reloadIfDirty() {
  if (dirty && !forecastBusy() && await hooks.reload()) dirty = false;
}

async function persist(line) {
  inflight++;
  setLineStatus(line.id, 'Đang lưu…', 'pending');
  try {
    const res = await postForecast({ op: 'update', id: line.id, rev: line.rev, line: clean(line) });
    line.rev = res.lineRev;
    dirty = true;
    setLineStatus(line.id, 'Đã lưu ✓', 'ok');
  } catch (e) {
    setLineStatus(line.id, (e.status === 409 ? 'Xung đột: ' : 'Lỗi lưu: ') + e.message, 'bad');
    toast(e.message, 'error');
  } finally {
    inflight--;
    reloadIfDirty();   // cập nhật cảnh báo tồn theo số mới
  }
}

async function removeLine(line) {
  clearTimeout(timers.get(line.id)); timers.delete(line.id);
  try {
    await postForecast({ op: 'delete', id: line.id });
    toast('Đã xoá line khỏi Forecast', 'ok');
    await hooks.reload({ force: true });
  } catch (e) { toast('Không xoá được: ' + e.message, 'error'); }
}

// ---------- dữ liệu hiển thị ----------
const months = () => [...new Set(forecastLines().map((l) => l.month))].sort();

function ensureMonth() {
  const ms = months();
  if (!ms.length) { state.fcMonth = ''; return; }
  if (ms.includes(state.fcMonth)) return;
  state.fcMonth = ms.includes(alertMonth()) ? alertMonth() : (ms.find((m) => m > alertMonth()) ?? ms[ms.length - 1]);
}

const lineSkus = (l) => [l.main.sku, ...l.gifts.map((g) => g.sku)];
const lineLevels = (l) => lineSkus(l).map((s) => evalFor(s, l.month)?.level).filter(Boolean);
const lineHasAlert = (l) => lineLevels(l).some((lv) => ALERT_LEVELS.has(lv)) || calcLine(l, itemBySku).status === 'over';

function matchesQuery(l) {
  const q = state.fcQ.trim().toLowerCase();
  if (!q) return true;
  return lineSkus(l).some((s) => {
    const it = itemBySku(s);
    return s.toLowerCase().includes(q) || it?.name.toLowerCase().includes(q) || it?.shortName.toLowerCase().includes(q);
  });
}

function visibleLines() {
  return forecastLines().filter((l) => l.month === state.fcMonth && (!state.fcCampaign || l.campaign === state.fcCampaign) && matchesQuery(l) && (!state.fcOnlyAlert || lineHasAlert(l)))
    .sort((a, b) => a.campaign.localeCompare(b.campaign) || (itemBySku(a.main.sku)?.name ?? a.main.sku).localeCompare(itemBySku(b.main.sku)?.name ?? b.main.sku, 'vi'));
}

const kpi = (cls, k, v, title) => el('div', { class: 'kpi ' + cls, title: title || '' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));

function renderKpis(lines) {
  const evs = Object.values(state.data?.plan?.evaluations?.[state.fcMonth] ?? {});
  const units = lines.reduce((s, l) => s + (l.units ?? 0), 0);
  const giftTotal = lines.reduce((s, l) => s + (l.units ?? 0) * calcLine(l, itemBySku).giftCost, 0);
  const over = lines.filter((l) => calcLine(l, itemBySku).status === 'over').length;
  $('fcKpis').replaceChildren(
    kpi('', 'Line', fmtNum(lines.length)),
    kpi('', 'SL Main dự kiến', fmtNum(units)),
    kpi('', 'Tổng vốn quà dự kiến', fmtMoney(giftTotal), 'Σ SL dự kiến × vốn quà của từng line'),
    kpi(over ? 'bad' : '', 'Line CIR Over', fmtNum(over)),
    kpi('bad', 'SKU thiếu / hết', fmtNum(evs.filter((e) => e.level === 'short' || e.level === 'out').length), 'SKU (Main + quà) có tồn thấp hơn nhu cầu tổng hợp của tháng'),
    kpi('warn', 'SKU Nam thiếu', fmtNum(evs.filter((e) => (e.gapSouth ?? 0) > 0).length)));
}

function renderLines(lines) {
  const body = $('fcBody');
  const groups = new Map();
  for (const l of lines) (groups.get(l.campaign) ?? groups.set(l.campaign, []).get(l.campaign)).push(l);
  const nodes = [];
  for (const [campaign, ls] of groups) {
    const allCollapsed = ls.every((l) => state.fcCollapsed.has(l.id));
    nodes.push(el('h3', { class: 'group' }, el('span', { text: campaign }), el('span', { class: 'count', text: `${ls.length} line` }),
      campaign in DEFAULT_MAX_CIR ? el('span', { class: 'muted', text: ` · Max CIR ${fmtPct(DEFAULT_MAX_CIR[campaign])}` }) : null));
    for (const l of ls) {
      nodes.push(lineCard(l, {
        collapsed: state.fcCollapsed.has(l.id) || (allCollapsed && false),
        onChange: queueSave, onRemove: removeLine,
        onToggle: (line, c) => { if (c) state.fcCollapsed.add(line.id); else state.fcCollapsed.delete(line.id); },
      }));
    }
  }
  body.replaceChildren(...nodes);
}

function skuRows() {
  const evs = state.data?.plan?.evaluations?.[state.fcMonth] ?? {};
  const q = state.fcQ.trim().toLowerCase();
  return Object.entries(evs).map(([sku, ev]) => ({ it: itemBySku(sku), ev })).filter((r) => r.it)
    .filter((r) => (!q || r.it.sku.toLowerCase().includes(q) || r.it.name.toLowerCase().includes(q)) && (!state.fcOnlyAlert || ALERT_LEVELS.has(r.ev.level)))
    .sort((a, b) => LEVEL[a.ev.level].rank - LEVEL[b.ev.level].rank || (b.ev.gapTotal ?? 0) - (a.ev.gapTotal ?? 0) || a.it.name.localeCompare(b.it.name, 'vi'));
}

function renderSkuTable(rows) {
  const heads = [['', 'img'], ['SKU / Sản phẩm', ''], ['Vai trò', ''], ['Nhu cầu', 'num'], ['Tồn tổng', 'num'], ['MB', 'num'], ['MN', 'num'], ['MN cần', 'num'], ['Độ phủ', ''], ['Cảnh báo', '']];
  const tbody = el('tbody');
  for (const { it, ev } of rows) {
    const cls = LEVEL[ev.level].cls;
    const fill = el('i', { class: cls });
    fill.style.width = Math.min(100, (ev.coverage ?? 0) * 100) + '%';
    const role = ev.main > 0 && ev.gift > 0 ? 'Main + Quà' : ev.gift > 0 ? 'Quà tặng' : 'Main';
    const tdImg = el('td', { class: 'img' }); tdImg.append(thumb(it, 'timg'));
    tbody.append(el('tr', {},
      tdImg,
      el('td', { class: 'name' }, skuButton(it.sku), el('div', { class: 'pname2', text: it.name })),
      el('td', { text: role, title: `Main ${fmtNum(ev.main)} + quà ${fmtNum(ev.gift)}` }),
      el('td', { class: 'num', text: fmtNum(ev.qty) }), el('td', { class: 'num', text: fmtNum(it.total) }),
      el('td', { class: 'num', text: fmtNum(it.north) }), el('td', { class: 'num', text: fmtNum(it.south) }), el('td', { class: 'num', text: fmtNum(ev.needSouth) }),
      el('td', {}, el('span', { class: 'cover' }, fill), ev.coverage != null ? Math.round(ev.coverage * 100) + '%' : '–'),
      el('td', { class: 'msgcell' }, el('span', { class: 'badge ' + cls, text: LEVEL[ev.level].label }), ' ' + alertText(it, ev))));
  }
  $('fcBody').replaceChildren(el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...heads.map(([h, c]) => el('th', { class: c, text: h })))), tbody)));
}

export function renderForecast() {
  ensureMonth();
  const all = forecastLines();
  const sel = $('fcMonth');
  sel.replaceChildren(...months().map((m) => el('option', { value: m, text: monthLabel(m) + (m === alertMonth() ? ' (tháng tới)' : '') })));
  sel.value = state.fcMonth;
  const campaigns = [...new Set(all.filter((l) => l.month === state.fcMonth).map((l) => l.campaign))].sort();
  if (state.fcCampaign && !campaigns.includes(state.fcCampaign)) state.fcCampaign = '';
  $('fcCampaign').replaceChildren(el('option', { value: '', text: 'Mọi campaign' }), ...campaigns.map((c) => el('option', { value: c, text: c })));
  $('fcCampaign').value = state.fcCampaign;
  $('fcOnlyAlert').checked = state.fcOnlyAlert;
  document.querySelectorAll('[data-fcview]').forEach((b) => b.classList.toggle('on', b.dataset.fcview === state.fcView));
  $('fcLineTools').hidden = state.fcView !== 'lines';

  if (!all.length) {
    $('fcKpis').replaceChildren();
    const go = el('button', { type: 'button', class: 'btn primary', text: 'Đi tới tab Plan' });
    go.addEventListener('click', () => { state.tab = 'plan'; hooks.render({ body: true }); });
    $('fcBody').replaceChildren(el('div', { class: 'empty-state' }, el('div', { class: 'big', text: 'Chưa có Forecast' }),
      el('p', { class: 'muted', text: 'Dán dữ liệu từ Google Sheet ở tab Plan, kiểm tra tên sản phẩm rồi bấm Confirm. Các line sẽ xuất hiện ở đây để bạn chỉnh sửa.' }), go));
    return;
  }
  const lines = visibleLines();
  renderKpis(forecastLines().filter((l) => l.month === state.fcMonth));
  if (state.fcView === 'sku') {
    const rows = skuRows();
    if (!rows.length) $('fcBody').replaceChildren(el('p', { class: 'muted center', text: 'Chưa có SKU nào có nhu cầu (cần nhập SL dự kiến cho các line).' }));
    else renderSkuTable(rows);
    return;
  }
  if (!lines.length) { $('fcBody').replaceChildren(el('p', { class: 'muted center', text: 'Không có line nào khớp bộ lọc.' })); return; }
  renderLines(lines);
}

// ---------- xuất CSV ----------
export function forecastCsv() {
  if (state.fcView === 'sku') {
    return [['Tháng', 'SKU', 'Tên', 'Vai trò', 'Nhu cầu', 'Main', 'Quà', 'Tồn tổng', 'MB', 'MN', 'MN cần', 'Cảnh báo'],
      ...skuRows().map(({ it, ev }) => [state.fcMonth, it.sku, it.name, ev.gift > 0 ? (ev.main > 0 ? 'Main + Quà' : 'Quà') : 'Main', ev.qty, ev.main, ev.gift, it.total, it.north, it.south, ev.needSouth, LEVEL[ev.level].label + ': ' + alertText(it, ev)])];
  }
  return [['Tháng', 'Campaign', 'SKU Main', 'Sản phẩm Main', 'Giá bán', 'SL dự kiến', 'Số quà', 'Vốn quà', 'CIR', 'Max CIR', 'Trạng thái CIR', 'Chi tiết quà (SKU×SL@vốn)'],
    ...visibleLines().map((l) => {
      const c = calcLine(l, itemBySku);
      return [l.month, l.campaign, l.main.sku, itemBySku(l.main.sku)?.name ?? l.main.srcName, l.price, l.units ?? '', l.gifts.length, c.giftCost,
        c.cir === null ? '' : (c.cir * 100).toFixed(2) + '%', c.maxCir === null ? '' : (c.maxCir * 100).toFixed(2) + '%', c.status,
        l.gifts.map((g) => `${g.sku}×${g.qty}@${g.cost}`).join('; ')];
    })];
}

export function initForecast() {
  const rerender = () => hooks.render({ body: true, force: true });
  $('fcQ').addEventListener('input', (e) => { state.fcQ = e.target.value; rerender(); });
  $('fcMonth').addEventListener('change', (e) => { state.fcMonth = e.target.value; rerender(); });
  $('fcCampaign').addEventListener('change', (e) => { state.fcCampaign = e.target.value; rerender(); });
  $('fcOnlyAlert').addEventListener('change', (e) => { state.fcOnlyAlert = e.target.checked; rerender(); });
  document.querySelectorAll('[data-fcview]').forEach((b) => b.addEventListener('click', () => { state.fcView = b.dataset.fcview; rerender(); }));
  $('fcExpand').addEventListener('click', () => { state.fcCollapsed.clear(); rerender(); });
  $('fcCollapse').addEventListener('click', () => { forecastLines().forEach((l) => state.fcCollapsed.add(l.id)); rerender(); });
  // rời khỏi ô đang sửa mà không còn gì chờ lưu -> tải lại để cảnh báo tồn khớp số mới
  $('tab-forecast').addEventListener('focusout', () => setTimeout(reloadIfDirty, 200));
}
