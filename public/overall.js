// Tab Overall: tổng hợp Forecast của một tháng theo channel / campaign / category / SKU, đặt cạnh tồn kho.
// GMV dự kiến = Giá bán × SL dự kiến (chỉ line đã nhập SL). Dữ liệu tồn lấy từ Sheet (cập nhật hàng tuần).
import { buildXlsx } from './xlsx.js';
import { tableSheet } from './export.js';
import { state, itemBySku, alertMonth, currentMonth, forecastLines, evalFor, hooks } from './state.js';
import { $, el, thumb, fmtNum, fmtMoney, fmtCompactMoney, fmtPct, monthLabel, LEVEL, ALERT_LEVELS, skuButton, channelPill } from './ui.js';
import { CHANNELS, channelOf, overallModel, norm, componentsOf } from './logic.js';

const ov = () => state.ov;
const chColor = (k) => `ch-${k}`;
const months = () => [...new Set(forecastLines().map((l) => l.month))].sort();

function ensureMonth() {
  const ms = months();
  if (!ms.length) { ov().month = ''; return; }
  if (ms.includes(ov().month)) return;
  ov().month = ms.includes(alertMonth()) ? alertMonth() : ms[ms.length - 1];
}

// Deal combo có thể gồm nhiều SKU thuộc nhiều category -> một line khớp category nếu BẤT KỲ SKU nào thuộc category đó
const catsOfLine = (l) => componentsOf(l).map((c) => itemBySku(c.sku)?.category || 'Chưa phân loại');

// Các line thuộc tháng đang chọn (chưa áp bộ lọc khác) — dùng để đếm trong các ô lọc.
const monthLines = () => forecastLines().filter((l) => l.month === ov().month);

function matches(l, skip = '') {
  const f = ov();
  if (skip !== 'channel' && f.channels.size && !f.channels.has(channelOf(l))) return false;
  if (skip !== 'campaign' && f.campaign && l.campaign !== f.campaign) return false;
  if (skip !== 'category' && f.category && !catsOfLine(l).includes(f.category)) return false;
  if (f.q.trim()) {
    const q = norm(f.q);
    const hay = componentsOf(l).map((c) => { const it = itemBySku(c.sku); return [c.sku, it?.name, it?.shortName].join(' '); }).join(' ');
    if (!norm(hay).includes(q)) return false;
  }
  return true;
}

// ---------- thành phần vẽ ----------
const kpi = (cls, k, v, title, sub) => el('div', { class: 'kpi ' + cls, title: title || '' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), sub ? el('div', { class: 'sub', text: sub }) : null);

// Thanh xếp chồng theo channel (rộng = gmv / max)
function stackBar(by, max, total) {
  const bar = el('div', { class: 'stk', role: 'img', 'aria-label': 'GMV theo channel' });
  for (const c of CHANNELS) {
    const v = by[c.key] ?? 0;
    if (!v) continue;
    const seg = el('i', { class: chColor(c.key), title: `${c.label}: ${fmtMoney(v)} (${total ? fmtPct(v / total) : '–'})` });
    seg.style.width = max ? (v / max * 100) + '%' : '0';
    bar.append(seg);
  }
  return bar;
}

function legend() {
  return el('span', { class: 'legend' }, ...CHANNELS.map((c) => el('span', { class: 'lg' }, el('i', { class: 'dot ' + chColor(c.key) }), c.label)));
}

function panel(title, ...kids) {
  return el('section', { class: 'panel ov-panel' }, el('h2', {}, el('span', { text: title }), legend()), ...kids);
}

function renderKpis(m) {
  const t = m.totals;
  const cir = t.gmv > 0 ? t.giftCost / t.gmv : null;
  const gm = t.gmvCogs > 0 ? t.gross / t.gmvCogs : null;
  const out = [
    kpi('big', 'GMV dự kiến', fmtCompactMoney(t.gmv), fmtMoney(t.gmv), `${fmtNum(t.lines - t.missing)}/${fmtNum(t.lines)} line có SL`),
    kpi('', 'SL Main dự kiến', fmtNum(t.units)),
    kpi('', 'Số SKU Main', fmtNum(m.bySku.length)),
    kpi('', 'Vốn quà', fmtCompactMoney(t.giftCost), fmtMoney(t.giftCost)),
    kpi(cir !== null && cir > 0.05 ? 'warn' : '', 'CIR bình quân', fmtPct(cir), 'Σ vốn quà ÷ GMV (gộp mọi line)'),
    kpi('', '%GM sau quà', fmtPct(gm), 'Σ (Giá bán − COGS − vốn quà) × SL ÷ GMV, chỉ line có COGS Main. Chưa trừ phí sàn, ads, voucher.',
      t.linesCogs < t.lines - t.missing ? `chỉ ${fmtNum(t.linesCogs)} line có COGS` : null),
  ];
  // Thực tế: chỉ khi tháng đang xem đã/đang chạy và có line đã nhập SL thực tế
  const cur = currentMonth();
  if (cur && ov().month && ov().month <= cur) {
    const ach = t.planGmvOfActual > 0 ? t.actualGmv / t.planGmvOfActual : null;
    out.push(
      kpi(t.actualLines ? 'big good' : 'warn', 'GMV thực tế', t.actualLines ? fmtCompactMoney(t.actualGmv) : '–', 'Ước tính = giá bán kế hoạch × SL thực tế (web chưa có giá bán thực tế)', `${fmtNum(t.actualLines)}/${fmtNum(t.lines)} line đã nhập thực tế`),
      kpi('', 'SL thực tế', t.actualLines ? fmtNum(t.actualUnits) : '–', 'Σ SL Main thực tế đã nhập'),
      kpi(ach !== null && ach >= 1 ? 'good' : '', '% đạt KH', fmtPct(ach), 'GMV thực tế ÷ GMV dự kiến, chỉ tính line có đủ cả hai số', ach === null ? null : `trên ${fmtNum(t.planUnitsOfActual)} deal có KH`));
  }
  $('ovKpis').replaceChildren(...out);
}

function channelPanel(m) {
  const max = Math.max(1, ...m.byChannel.map((c) => c.gmv));
  const total = m.totals.gmv;
  const rows = CHANNELS.map((c) => {
    const r = m.byChannel.find((x) => x.key === c.key) ?? { gmv: 0, units: 0, lines: 0, giftCost: 0 };
    const fill = el('i', { class: chColor(c.key) });
    fill.style.width = (r.gmv / max * 100) + '%';
    return el('div', { class: 'brow' },
      el('span', { class: 'bl' }, channelPill(c.key, c.label)),
      el('div', { class: 'bar' }, fill),
      el('span', { class: 'bv', text: fmtCompactMoney(r.gmv), title: fmtMoney(r.gmv) }),
      el('span', { class: 'bs', text: total ? fmtPct(r.gmv / total) : '–' }),
      el('span', { class: 'bm', text: `${fmtNum(r.units)} sp · ${fmtNum(r.lines)} line · CIR ${r.gmv ? fmtPct(r.giftCost / r.gmv) : '–'}` }));
  });
  const share = el('div', { class: 'stk full', role: 'img', 'aria-label': 'Tỉ trọng GMV theo channel' });
  for (const c of CHANNELS) {
    const r = m.byChannel.find((x) => x.key === c.key);
    if (!r || !total) continue;
    const seg = el('i', { class: chColor(c.key), title: `${c.label}: ${fmtPct(r.gmv / total)}` });
    seg.style.width = (r.gmv / total * 100) + '%';
    share.append(seg);
  }
  return panel('GMV theo channel', total ? share : el('p', { class: 'muted', text: 'Chưa có GMV.' }), ...rows);
}

function stackedList(title, rows, { topN = 8, label = (r) => r.key } = {}) {
  const list = rows.slice(0, topN);
  const rest = rows.slice(topN);
  if (rest.length) {
    const by = {};
    let gmv = 0;
    for (const r of rest) { gmv += r.gmv; for (const [k, v] of Object.entries(r.by)) by[k] = (by[k] ?? 0) + v; }
    list.push({ key: `Khác (${rest.length})`, gmv, by });
  }
  const max = Math.max(1, ...list.map((r) => r.gmv));
  const total = rows.reduce((s, r) => s + r.gmv, 0);
  const body = list.length ? list.map((r) => el('div', { class: 'brow compact' },
    el('span', { class: 'bl text', text: label(r), title: label(r) }),
    stackBar(r.by, max, r.gmv),
    el('span', { class: 'bv', text: fmtCompactMoney(r.gmv), title: fmtMoney(r.gmv) }),
    el('span', { class: 'bs', text: total ? fmtPct(r.gmv / total) : '–' }))) : [el('p', { class: 'muted', text: 'Chưa có dữ liệu.' })];
  return panel(title, ...body);
}

// ---------- bảng SKU ----------
function skuRows(m) {
  const month = ov().month;
  const f = ov();
  let rows = m.bySku.map((s) => ({ s, it: itemBySku(s.sku), ev: evalFor(s.sku, month) }));
  if (f.onlyAlert) rows = rows.filter((r) => r.ev && ALERT_LEVELS.has(r.ev.level));
  const gap = (r) => r.ev?.gapTotal ?? 0;
  const cov = (r) => (r.ev?.coverage ?? Infinity);
  const sorters = {
    gmv: (a, b) => b.s.gmv - a.s.gmv,
    units: (a, b) => b.s.units - a.s.units,
    gap: (a, b) => gap(b) - gap(a) || b.s.gmv - a.s.gmv,
    cover: (a, b) => cov(a) - cov(b) || b.s.gmv - a.s.gmv,
  };
  return rows.sort(sorters[f.sort] ?? sorters.gmv);
}

function renderSkuTable(m) {
  const rows = skuRows(m);
  const f = ov();
  const shown = f.top > 0 ? rows.slice(0, f.top) : rows;
  const totalGmv = m.totals.gmv;
  const maxGmv = Math.max(1, ...shown.map((r) => r.s.gmv));
  const heads = [
    ['#', 'rk'], ['SKU / Sản phẩm', ''], ['GMV theo channel', 'gm'], ['GMV', 'num'], ['% GMV', 'num'], ['SL bán', 'num'],
    ['Nhu cầu kho', 'num'], ['Tồn MB', 'num'], ['Tồn MN', 'num'], ['Tồn tổng', 'num'], ['Độ phủ tồn', 'cv'],
  ];
  const tbody = el('tbody');
  shown.forEach(({ s, it, ev }, i) => {
    const cls = ev ? LEVEL[ev.level].cls : 'mute';
    const fill = el('i', { class: cls });
    fill.style.width = Math.min(100, (ev?.coverage ?? 0) * 100) + '%';
    const tdImg = el('div', { class: 'ov-prod' }, thumb(it, 'timg'),
      el('div', { class: 'pn' }, skuButton(s.sku), el('div', { class: 'pname2', text: it?.name ?? '(SKU không còn trong Sheet)', title: it?.name ?? '' })));
    tbody.append(el('tr', {},
      el('td', { class: 'rk', text: String(i + 1) }),
      el('td', { class: 'name' }, tdImg),
      el('td', { class: 'gm' }, stackBar(s.by, maxGmv, s.gmv)),
      el('td', { class: 'num strong', text: fmtCompactMoney(s.gmv), title: fmtMoney(s.gmv) }),
      el('td', { class: 'num', text: totalGmv ? fmtPct(s.gmv / totalGmv) : '–' }),
      el('td', { class: 'num', text: fmtNum(s.units), title: 'Số cái SKU này cần bán (SL deal × số lượng trong deal)' }),
      el('td', { class: 'num', text: ev ? fmtNum(ev.qty) : '–', title: ev ? `Main ${fmtNum(ev.main)} + quà ${fmtNum(ev.gift)} (mọi channel, cả tháng)` : '' }),
      el('td', { class: 'num', text: fmtNum(it?.north) }),
      el('td', { class: 'num' + (ev && ev.gapSouth > 0 ? ' low' : ''), text: fmtNum(it?.south) }),
      el('td', { class: 'num', text: fmtNum(it?.total) }),
      el('td', { class: 'cv' }, el('span', { class: 'cover' }, fill),
        el('span', { class: 'badge ' + cls, text: ev ? LEVEL[ev.level].label : '–', title: ev ? `Độ phủ ${ev.coverage != null ? Math.round(ev.coverage * 100) + '%' : '–'}` : '' }))));
  });
  const table = el('table', { class: 'ov-table' }, el('thead', {}, el('tr', {}, ...heads.map(([h, c]) => el('th', { class: c, text: h })))), tbody);
  const comboNote = m.totals.combos ? ` Có ${fmtNum(m.totals.combos)} line combo/nhiều số lượng: GMV của deal được chia cho từng SKU theo tỉ lệ (số lượng × COGS) để xem theo SKU và category; tổng GMV, channel và campaign không đổi.` : '';
  const note = el('p', { class: 'hint', text: 'Nhu cầu kho = tổng SL Main + quà tặng của MỌI channel trong tháng (các channel dùng chung kho), nên không đổi khi lọc channel. Tồn lấy từ Sheet (cập nhật hàng tuần); chưa tính hàng đang về.' + comboNote });
  $('ovSku').replaceChildren(
    el('section', { class: 'panel ov-panel' },
      el('h2', {}, el('span', { text: `Top SKU theo ${({ gmv: 'GMV', units: 'số lượng', gap: 'thiếu hụt tồn', cover: 'độ phủ tồn thấp' })[f.sort] ?? 'GMV'}` }),
        el('span', { class: 'muted small', text: `Hiển thị ${fmtNum(shown.length)} / ${fmtNum(rows.length)} SKU` }), legend()),
      rows.length ? el('div', { class: 'tablewrap' }, table) : el('p', { class: 'muted center', text: 'Không có SKU nào khớp bộ lọc (cần line đã nhập SL dự kiến).' }),
      note));
}

// ---------- bộ lọc ----------
function renderFilters() {
  const f = ov();
  const ml = monthLines();
  $('ovMonth').replaceChildren(...months().map((m) => el('option', { value: m, text: monthLabel(m) + (currentMonth() ? (m < currentMonth() ? ' (đã chạy)' : m === currentMonth() ? ' (đang chạy)' : m === alertMonth() ? ' (tháng tới)' : '') : '') })));
  $('ovMonth').value = f.month;

  // channel: nhiều lựa chọn (bấm để bật/tắt); đếm theo các bộ lọc khác
  const counts = {};
  for (const l of ml.filter((x) => matches(x, 'channel'))) counts[channelOf(l)] = (counts[channelOf(l)] ?? 0) + 1;
  $('ovChannelFilter').replaceChildren(...CHANNELS.map((c) => {
    const on = f.channels.has(c.key);
    const b = el('button', { type: 'button', class: 'ch-' + c.key + (on ? ' on' : ''), 'aria-pressed': String(on) }, c.label, el('span', { class: 'n', text: String(counts[c.key] ?? 0) }));
    b.addEventListener('click', () => { if (on) f.channels.delete(c.key); else f.channels.add(c.key); hooks.render({ body: true, force: true }); });
    return b;
  }));

  const campaigns = [...new Set(ml.map((l) => l.campaign))].sort();
  if (f.campaign && !campaigns.includes(f.campaign)) f.campaign = '';
  $('ovCampaign').replaceChildren(el('option', { value: '', text: 'Mọi campaign' }), ...campaigns.map((c) => el('option', { value: c, text: c })));
  $('ovCampaign').value = f.campaign;

  const cats = [...new Set(ml.flatMap(catsOfLine))].sort((a, b) => a.localeCompare(b, 'vi'));
  if (f.category && !cats.includes(f.category)) f.category = '';
  $('ovCategory').replaceChildren(el('option', { value: '', text: 'Mọi category' }), ...cats.map((c) => el('option', { value: c, text: c })));
  $('ovCategory').value = f.category;

  $('ovSort').value = f.sort;
  $('ovTop').value = String(f.top);
  $('ovOnlyAlert').checked = f.onlyAlert;
  if ($('ovQ').value !== f.q) $('ovQ').value = f.q;
  const active = (f.channels.size ? 1 : 0) + (f.campaign ? 1 : 0) + (f.category ? 1 : 0) + (f.q.trim() ? 1 : 0) + (f.onlyAlert ? 1 : 0);
  $('ovReset').hidden = active === 0;
}

export function renderOverall() {
  ensureMonth();
  const all = forecastLines();
  if (!all.length) {
    $('ovFilters').hidden = true;
    for (const id of ['ovKpis', 'ovCharts', 'ovSku']) $(id).replaceChildren();
    const go = el('button', { type: 'button', class: 'btn primary', text: 'Đi tới tab Plan' });
    go.addEventListener('click', () => { state.tab = 'plan'; hooks.render({ body: true }); });
    $('ovNotice').replaceChildren(el('div', { class: 'empty-state' }, el('div', { class: 'big', text: 'Chưa có Forecast để tổng hợp' }),
      el('p', { class: 'muted', text: 'Nhập line ở tab Plan → Confirm (nhớ nhập SL dự kiến), Overall sẽ tự tổng hợp GMV theo channel và SKU.' }), go));
    return;
  }
  $('ovFilters').hidden = false;
  renderFilters();
  const lines = monthLines().filter((l) => matches(l));
  const m = overallModel(lines, itemBySku);
  const notes = [];
  if (m.totals.missing) notes.push(el('div', { class: 'note-warn', text: `${m.totals.missing}/${m.totals.lines} line chưa nhập SL dự kiến nên chưa tính vào GMV. Nhập SL ở tab Forecast để số liệu đầy đủ.` }));
  if (!lines.length) notes.push(el('p', { class: 'muted center', text: 'Không có line nào khớp bộ lọc.' }));
  $('ovNotice').replaceChildren(...notes);
  renderKpis(m);
  $('ovCharts').replaceChildren(channelPanel(m), stackedList('GMV theo campaign', m.byCampaign), stackedList('GMV theo category', m.byCategory));
  renderSkuTable(m);
}

export function overallXlsx() {
  const lines = monthLines().filter((l) => matches(l));
  const m = overallModel(lines, itemBySku);
  const head = ['Tháng', 'SKU', 'Tên', 'GMV', ...CHANNELS.map((c) => 'GMV ' + c.label), 'SL bán', 'Nhu cầu kho (mọi channel)', 'Tồn MB', 'Tồn MN', 'Tồn tổng', 'Cảnh báo'];
  const rows = skuRows(m).map(({ s, it, ev }) => [ov().month, s.sku, it?.name ?? '', s.gmv, ...CHANNELS.map((c) => s.by[c.key] ?? 0), s.units, ev?.qty ?? '', it?.north ?? '', it?.south ?? '', it?.total ?? '', ev ? LEVEL[ev.level].label : '']);
  return buildXlsx([tableSheet('Overall ' + ov().month, head, rows, { widths: [10, 22, 44, 15, ...CHANNELS.map(() => 15), 10, 14, 9, 9, 10, 18] })]);
}

export function initOverall() {
  const rerender = () => hooks.render({ body: true, force: true });
  let t;
  $('ovQ').addEventListener('input', (e) => { ov().q = e.target.value; clearTimeout(t); t = setTimeout(rerender, 150); });
  $('ovMonth').addEventListener('change', (e) => { ov().month = e.target.value; rerender(); });
  $('ovCampaign').addEventListener('change', (e) => { ov().campaign = e.target.value; rerender(); });
  $('ovCategory').addEventListener('change', (e) => { ov().category = e.target.value; rerender(); });
  $('ovSort').addEventListener('change', (e) => { ov().sort = e.target.value; rerender(); });
  $('ovTop').addEventListener('change', (e) => { ov().top = Number(e.target.value); rerender(); });
  $('ovOnlyAlert').addEventListener('change', (e) => { ov().onlyAlert = e.target.checked; rerender(); });
  $('ovReset').addEventListener('click', () => { Object.assign(ov(), { channels: new Set(), campaign: '', category: '', q: '', onlyAlert: false }); rerender(); });
}
