// Tab Forecast: các line đã lưu. Sửa trực tiếp (đổi quà, giá, SL, campaign…), tự lưu sau khi ngừng gõ ~0,7 giây.
import { state, items, itemBySku, alertMonth, currentMonth, forecastLines, evalFor, hooks } from './state.js';
import { $, el, thumb, toast, fmtNum, fmtMoney, fmtCompactMoney, fmtPct, monthLabel, LEVEL, ALERT_LEVELS, alertText, stockChips, skuButton, channelSegButtons, channelPill } from './ui.js';
import { buildXlsx } from './xlsx.js';
import { tableSheet, forecastWorkbook } from './export.js';
import { calcLine, DEFAULT_MAX_CIR, CHANNELS, channelOf, channelLabel, componentsOf, dealLabel, prevMonth, overallModel } from './logic.js';
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
// Nhãn tháng kèm trạng thái: đã chạy xong / đang chạy / tháng tới (theo giờ VN, do server tính)
const monthState = (m) => { const c = currentMonth(); return !c ? '' : m < c ? ' (đã chạy)' : m === c ? ' (đang chạy)' : m === alertMonth() ? ' (tháng tới)' : ''; };

const months = () => [...new Set(forecastLines().map((l) => l.month))].sort();

function ensureMonth() {
  const ms = months();
  if (!ms.length) { state.fcMonth = ''; return; }
  if (ms.includes(state.fcMonth)) return;
  state.fcMonth = ms.includes(alertMonth()) ? alertMonth() : (ms.find((m) => m > alertMonth()) ?? ms[ms.length - 1]);
}

const lineSkus = (l) => [...componentsOf(l).map((c) => c.sku), ...l.gifts.map((g) => g.sku)];
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

const chRank = (l) => CHANNELS.findIndex((c) => c.key === channelOf(l));

function visibleLines() {
  return forecastLines().filter((l) => l.month === state.fcMonth && (!state.fcChannel || channelOf(l) === state.fcChannel) && (!state.fcCampaign || l.campaign === state.fcCampaign) && matchesQuery(l) && (!state.fcOnlyAlert || lineHasAlert(l)))
    .sort((a, b) => chRank(a) - chRank(b) || a.campaign.localeCompare(b.campaign) || (itemBySku(a.main.sku)?.name ?? a.main.sku).localeCompare(itemBySku(b.main.sku)?.name ?? b.main.sku, 'vi'));
}

// title luôn có giá trị đầy đủ: ô KPI hiển thị rút gọn (tỷ/triệu) để không bị tràn, rê chuột để xem số chính xác
const kpi = (cls, k, v, title) => el('div', { class: 'kpi ' + cls, title: title ? `${k}: ${v}\n${title}` : `${k}: ${v}` }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));

function renderKpis(lines) {
  const evs = Object.values(state.data?.plan?.evaluations?.[state.fcMonth] ?? {});
  const units = lines.reduce((s, l) => s + (l.units ?? 0), 0);
  const giftTotal = lines.reduce((s, l) => s + (l.units ?? 0) * calcLine(l, itemBySku).giftCost, 0);
  const over = lines.filter((l) => calcLine(l, itemBySku).status === 'over').length;
  const gmv = lines.reduce((s, l) => s + (l.units ?? 0) * (Number(l.price) || 0), 0);
  const cur = currentMonth();
  const om = overallModel(lines, itemBySku).totals;
  // Hàng KPI thực tế tách riêng (chỉ tháng đang/đã chạy). Chưa có line nào nhập thực tế -> chỉ hiện tiến độ nhập, không hiện 3 ô gạch ngang.
  const actualKpis = cur && state.fcMonth <= cur ? [
    kpi(om.actualLines ? 'good' : 'warn', 'Đã nhập thực tế', `${fmtNum(om.actualLines)}/${fmtNum(lines.length)} line`, 'Số line đã có SL bán thực tế'),
    ...(om.actualLines ? [
      kpi('', 'SL thực tế', fmtNum(om.actualUnits), 'Σ SL Main thực tế đã nhập'),
      kpi('', 'GMV thực tế', fmtCompactMoney(om.actualGmv), `${fmtMoney(om.actualGmv)}\nƯớc tính: giá bán kế hoạch × SL thực tế (chưa có giá bán thực tế)`),
      kpi('', '% đạt KH', om.planGmvOfActual > 0 ? fmtPct(om.actualGmv / om.planGmvOfActual) : '–', 'Chỉ tính các line có đủ cả SL dự kiến và SL thực tế: GMV thực tế ÷ GMV dự kiến'),
    ] : []),
  ] : [];
  $('fcKpisActual').replaceChildren(...actualKpis);
  $('fcKpisActual').hidden = !actualKpis.length;
  $('fcKpis').replaceChildren(
    kpi('', 'Line', fmtNum(lines.length)),
    kpi('', 'SL Main dự kiến', fmtNum(units)),
    kpi('', 'GMV dự kiến', fmtCompactMoney(gmv), `${fmtMoney(gmv)}\nΣ Giá bán × SL dự kiến (chỉ line đã nhập SL)`),
    kpi('', 'Vốn quà dự kiến', fmtCompactMoney(giftTotal), `${fmtMoney(giftTotal)}\nΣ SL dự kiến × vốn quà của từng line`),
    kpi(over ? 'bad' : '', 'Line CIR Over', fmtNum(over)),
    kpi('bad', 'SKU thiếu / hết', fmtNum(evs.filter((e) => e.level === 'short' || e.level === 'out').length), 'SKU (Main + quà) có tồn thấp hơn nhu cầu tổng hợp của tháng'),
    kpi('warn', 'SKU Nam thiếu', fmtNum(evs.filter((e) => (e.gapSouth ?? 0) > 0).length)));
}

// Nhắc nhập thực tế của tháng liền trước (để benchmark đầy đủ)
function renderNotice() {
  const box = $('fcNotice');
  const prev = prevMonth(state.fcMonth), cur = currentMonth();
  const pl = forecastLines().filter((l) => l.month === prev && l.units > 0);
  const miss = pl.filter((l) => !Number.isInteger(l.actualUnits)).length;
  if (!prev || !cur || prev > cur || !miss) { box.replaceChildren(); return; }
  const go = el('button', { type: 'button', class: 'btn sm', text: 'Mở ' + monthLabel(prev) + ' để nhập' });
  go.addEventListener('click', () => { state.fcMonth = prev; hooks.render({ body: true, force: true }); });
  box.replaceChildren(el('div', { class: 'note-warn fc-note' },
    el('span', { text: `${monthLabel(prev)}${prev === cur ? ' đang chạy' : ' đã chạy xong'} nhưng còn ${miss}/${pl.length} line chưa nhập SL thực tế — benchmark cho ${monthLabel(state.fcMonth)} chưa đầy đủ. ` }), go));
}

// Cập nhật dải KPI ngay khi đang gõ (không dựng lại thẻ để không mất con trỏ)
const refreshKpis = () => renderKpis(forecastLines().filter((l) => l.month === state.fcMonth));

function renderLines(lines) {
  const body = $('fcBody');
  const groups = new Map();
  for (const l of lines) {
    const k = channelOf(l) + '|' + l.campaign;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(l);
  }
  const nodes = [];
  for (const [k, ls] of groups) {
    const ch = channelOf(ls[0]);
    const campaign = ls[0].campaign;
    const units = ls.reduce((s, l) => s + (l.units ?? 0), 0);
    const gmv = ls.reduce((s, l) => s + (l.units ?? 0) * (Number(l.price) || 0), 0);
    const done = ls.filter((l) => Number.isInteger(l.actualUnits));
    const actUnits = done.length ? done.reduce((s, l) => s + l.actualUnits, 0) : null;
    const planOfDone = done.reduce((s, l) => s + (l.units ?? 0), 0);   // % đạt KH chỉ so các line đã có thực tế
    nodes.push(el('h3', { class: 'group ch-' + ch },
      channelPill(ch, channelLabel(ch)),
      el('span', { class: 'gname', text: campaign }),
      el('span', { class: 'count', text: `${ls.length} line` }),
      campaign in DEFAULT_MAX_CIR ? el('span', { class: 'muted', text: `Max CIR ${fmtPct(DEFAULT_MAX_CIR[campaign])}` }) : null,
      units > 0 ? el('span', { class: 'muted', text: `· SL ${fmtNum(units)} · GMV ${fmtCompactMoney(gmv)}`, title: `GMV ${fmtMoney(gmv)}` }) : null,
      actUnits !== null ? el('span', { class: 'muted', text: `· Thực tế ${fmtNum(actUnits)}${planOfDone > 0 ? ` (${fmtPct(actUnits / planOfDone)} KH)` : ''}` }) : null));
    for (const l of ls) {
      nodes.push(lineCard(l, {
        collapsed: state.fcCollapsed.has(l.id),
        onChange: (line) => { queueSave(line); refreshKpis(); }, onRemove: removeLine,
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
  sel.replaceChildren(...months().map((m) => el('option', { value: m, text: monthLabel(m) + monthState(m) })));
  sel.value = state.fcMonth;
  const campaigns = [...new Set(all.filter((l) => l.month === state.fcMonth).map((l) => l.campaign))].sort();
  if (state.fcCampaign && !campaigns.includes(state.fcCampaign)) state.fcCampaign = '';
  $('fcCampaign').replaceChildren(el('option', { value: '', text: 'Mọi campaign' }), ...campaigns.map((c) => el('option', { value: c, text: c })));
  $('fcCampaign').value = state.fcCampaign;
  $('fcOnlyAlert').checked = state.fcOnlyAlert;
  const inMonth = all.filter((l) => l.month === state.fcMonth);
  const chCounts = {};
  for (const l of inMonth) chCounts[channelOf(l)] = (chCounts[channelOf(l)] ?? 0) + 1;
  $('fcChannel').replaceChildren(...channelSegButtons({
    value: state.fcChannel, counts: chCounts, total: inMonth.length,
    onPick: (k) => { state.fcChannel = k; hooks.render({ body: true, force: true }); },
  }));
  $('fcChannel').hidden = state.fcView === 'sku';
  renderNotice();
  document.querySelectorAll('[data-fcview]').forEach((b) => b.classList.toggle('on', b.dataset.fcview === state.fcView));
  $('fcLineTools').hidden = state.fcView !== 'lines';

  if (!all.length) {
    $('fcKpis').replaceChildren(); $('fcKpisActual').replaceChildren(); $('fcKpisActual').hidden = true; $('fcNotice').replaceChildren();
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
    if (!rows.length) $('fcBody').replaceChildren(el('p', { class: 'muted center', text: currentMonth() && state.fcMonth < currentMonth() ? 'Tháng đã chạy xong: web không đánh giá tồn cho tháng đã qua (tồn hiện tại không còn liên quan). Xem số thực tế ở dạng Line.' : 'Chưa có SKU nào có nhu cầu (cần nhập SL dự kiến cho các line).' }));
    else renderSkuTable(rows);
    return;
  }
  if (!lines.length) { $('fcBody').replaceChildren(el('p', { class: 'muted center', text: 'Không có line nào khớp bộ lọc.' })); return; }
  renderLines(lines);
}

// ---------- xuất Excel ----------
// Dạng Line: bố cục như Sheet Pricing Frame (mỗi channel 1 sheet) + sheet số liệu chi tiết. Dạng SKU: 1 bảng phẳng.
export function forecastXlsx() {
  if (state.fcView === 'sku') {
    return buildXlsx([tableSheet('Theo SKU', ['Tháng', 'SKU', 'Tên', 'Vai trò', 'Nhu cầu', 'Main', 'Quà', 'Tồn tổng', 'MB', 'MN', 'MN cần', 'Cảnh báo'],
      skuRows().map(({ it, ev }) => [state.fcMonth, it.sku, it.name, ev.gift > 0 ? (ev.main > 0 ? 'Main + Quà' : 'Quà') : 'Main', ev.qty, ev.main, ev.gift, it.total, it.north, it.south, ev.needSouth, LEVEL[ev.level].label + ': ' + alertText(it, ev)]),
      { widths: [10, 22, 44, 12, 9, 9, 9, 10, 9, 9, 9, 40] })]);
  }
  return forecastWorkbook(visibleLines(), itemBySku);
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
