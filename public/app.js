// Điều phối chung: tải dữ liệu, tab, banner, và tab "Tồn kho". Plan / Forecast nằm ở plan.js / forecast.js.
import { state, hooks, items, itemBySku, alertMonth, forecastLines, evalFor } from './state.js';
import { $, el, thumb, fmtTime, fmtNum, fmtMoney, fmtCompactMoney, monthLabel, LEVEL, ALERT_LEVELS, alertText, toast, skuButton, openLightbox } from './ui.js';
import { DEFAULT_MAX_CIR } from './logic.js';
import { initPlan, renderPlan } from './plan.js';
import { initFilters, renderFilters, matchItem, typeKey, categoryOf, levelOf, stockValue } from './filters.js';
import { initForecast, renderForecast, forecastBusy, forecastCsv } from './forecast.js';

const STALE_SEC = 15 * 60;   // website không đọc lại được Sheet quá ngưỡng này -> cảnh báo
const POLL_MS = 30 * 1000;   // hỏi server mỗi 30s khi tab đang mở (server tự đọc lại Sheet khi đến hạn)

try {
  const v = localStorage.getItem('sb_view'); if (v === 'cards' || v === 'table') state.view = v;
  const s = localStorage.getItem('sb_sort'); if (['attention', 'total-asc', 'total-desc', 'name'].includes(s)) state.sort = s;
  const c = localStorage.getItem('sb_charts'); state.showCharts = c === null ? window.innerWidth >= 900 : c === '1';
  const t = localStorage.getItem('sb_tab'); if (['stock', 'plan', 'forecast'].includes(t)) state.tab = t;
} catch { state.showCharts = window.innerWidth >= 900; }
$('sort').value = state.sort;

// ---------- dữ liệu dẫn xuất (tab Tồn kho) ----------
const plan = () => state.data?.plan ?? null;
const hasAlertPlan = () => !!plan()?.evaluations?.[alertMonth()];
const titleOf = (it) => it.shortName || it.name || it.sku;
const total = (it) => it.total ?? 0;
const cmpName = (a, b) => titleOf(a).localeCompare(titleOf(b), 'vi', { numeric: true });

const SORTERS = {
  attention: (a, b) => LEVEL[levelOf(a)].rank - LEVEL[levelOf(b)].rank
    || (evalFor(b.sku, alertMonth())?.gapTotal ?? 0) - (evalFor(a.sku, alertMonth())?.gapTotal ?? 0) || total(a) - total(b) || cmpName(a, b),
  'total-asc': (a, b) => total(a) - total(b) || cmpName(a, b),
  'total-desc': (a, b) => total(b) - total(a) || cmpName(a, b),
  name: cmpName,
};

function visibleItems() {
  return items().filter((it) => matchItem(it)).sort(SORTERS[state.sort]);
}

// ---------- banner + độ mới ----------
function renderBanner() {
  const { snapshot, status, serverTime } = state.data || {};
  const msgs = [];
  if (state.error) msgs.push('Không tải được dữ liệu mới: ' + state.error);
  if (state.data && !snapshot) msgs.push('Chưa đọc được dữ liệu từ Google Sheet.');
  if (status?.lastError && status.lastError.at > (status.lastOkAt || 0)) {
    msgs.push('Lần đọc Google Sheet gần nhất bị lỗi lúc ' + fmtTime(status.lastError.at) + ': ' + status.lastError.message + (snapshot ? ' — đang hiển thị dữ liệu cũ.' : ''));
  } else if (snapshot && serverTime - snapshot.generatedAt > STALE_SEC) {
    msgs.push('Website chưa đọc lại được Sheet từ ' + fmtTime(snapshot.generatedAt) + '.');
  }
  if (snapshot) {
    const missing = forecastLines().filter((l) => [l.main.sku, ...l.gifts.map((g) => g.sku)].some((s) => !itemBySku(s))).length;
    if (missing) msgs.push(`${missing} line Forecast có SKU không còn trong tab ${snapshot.tab} của Sheet — hãy vào tab Forecast chọn lại sản phẩm.`);
  }
  for (const w of snapshot?.warnings ?? []) msgs.push(w);
  const b = $('banner');
  b.hidden = msgs.length === 0;
  b.replaceChildren(...msgs.map((m) => el('div', { text: m })));
}

function renderFreshness() {
  const snap = state.data?.snapshot;
  const f = $('freshness');
  if (!snap) { f.textContent = state.data ? 'Chưa có dữ liệu' : 'Đang tải…'; return; }
  const ageMin = Math.max(0, Math.round((Date.now() / 1000 - snap.generatedAt) / 60));
  f.textContent = 'Sheet đọc ' + fmtTime(snap.generatedAt).split(', ').pop().slice(0, 5) + ' · ' + (ageMin < 1 ? 'vừa xong' : ageMin + ' phút trước');
  f.title = 'Website đọc Google Sheet lúc ' + fmtTime(snap.generatedAt) + '. Số tồn chỉ mới bằng lần Sheet được cập nhật gần nhất (Sheet cập nhật hàng tuần). Forecast thì cập nhật ngay khi lưu.';
}

function renderChrome() {
  try { localStorage.setItem('sb_tab', state.tab); } catch { /* bỏ qua */ }
  $('user').textContent = state.data?.user || '';
  $('logout').title = state.data?.user ? 'Đăng xuất ' + state.data.user : 'Đăng xuất';
  const n = forecastLines().length;
  $('fcCount').textContent = n ? String(n) : '';
  $('fcCount').hidden = !n;
  renderBanner(); renderFreshness();
  document.querySelectorAll('.tabs button').forEach((b) => { const on = b.dataset.tab === state.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  for (const t of ['stock', 'plan', 'forecast']) $('tab-' + t).hidden = state.tab !== t;
  $('csv').hidden = state.tab === 'plan';
  const camps = new Set([...Object.keys(DEFAULT_MAX_CIR), 'MINPRICE', ...forecastLines().map((l) => l.campaign)]);
  $('campaignList').replaceChildren(...[...camps].sort().map((c) => el('option', { value: c })));
}

// ---------- tab Tồn kho ----------
const mkKpi = (cls, k, v, title) => el('div', { class: 'kpi ' + cls, title: title || '' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));

function renderKpis(list) {
  const sum = (f) => list.reduce((s, it) => s + (f(it) ?? 0), 0);
  const out = [
    mkKpi('', 'SKU đang xem', nf(list.length)),
    mkKpi('', 'Tồn kho Bắc', nf(sum((i) => i.north))),
    mkKpi('', 'Tồn kho Nam', nf(sum((i) => i.south))),
    mkKpi('', 'Tổng tồn', nf(sum((i) => i.total))),
  ];
  if (state.data?.snapshot?.hasCost) { const v = sum(stockValue); out.push(mkKpi('', 'Giá trị tồn (COGS)', fmtCompactMoney(v), fmtMoney(v))); }
  if (hasAlertPlan()) {
    const n = (f) => list.filter(f).length;
    out.push(mkKpi('bad', 'Cần chú ý ' + monthLabel(alertMonth()), nf(n((i) => ALERT_LEVELS.has(levelOf(i)))), 'SKU có nhu cầu theo Forecast tháng tới mà tồn thấp'));
    out.push(mkKpi('warn', 'Kho Nam thiếu', nf(n((i) => (evalFor(i.sku, alertMonth())?.gapSouth ?? 0) > 0))));
  }
  out.push(mkKpi('', 'SKU tồn = 0', nf(list.filter((i) => i.total === 0).length)));
  $('kpis').replaceChildren(...out);
}
const nf = (v) => fmtNum(v);

function renderCategoryChart(list) {
  const groups = new Map();
  for (const it of list) {
    const k = categoryOf(it);
    const g = groups.get(k) ?? { name: k, n: 0, s: 0 };
    g.n += it.north ?? 0; g.s += it.south ?? 0;
    groups.set(k, g);
  }
  let rows = [...groups.values()].sort((a, b) => b.n + b.s - (a.n + a.s));
  if (rows.length > 10) {
    const rest = rows.slice(9);
    rows = rows.slice(0, 9);
    rows.push({ name: 'Khác (' + rest.length + ' category)', n: rest.reduce((s, r) => s + r.n, 0), s: rest.reduce((s, r) => s + r.s, 0) });
  }
  const max = Math.max(1, ...rows.map((r) => r.n + r.s));
  const nodes = rows.map((r) => {
    const a = el('div', { class: 'seg-n', title: 'Kho Bắc: ' + fmtNum(r.n) });
    const b = el('div', { class: 'seg-s', title: 'Kho Nam: ' + fmtNum(r.s) });
    a.style.width = (r.n / max * 100) + '%';
    b.style.width = (r.s / max * 100) + '%';
    return el('div', { class: 'crow' }, el('span', { class: 'lbl', text: r.name, title: r.name }), el('div', { class: 'stack' }, a, b), el('span', { class: 'tot', text: fmtNum(r.n + r.s) }));
  });
  $('catChart').replaceChildren(...(nodes.length ? nodes : [el('p', { class: 'muted', text: 'Không có dữ liệu.' })]));
}

function renderAlertChart(list) {
  $('alertTitle').textContent = 'Cảnh báo theo Forecast ' + (alertMonth() ? monthLabel(alertMonth()) : '');
  if (!hasAlertPlan()) {
    $('statusChart').replaceChildren(el('p', { class: 'muted', text: 'Chưa có Forecast (có SL dự kiến) cho tháng tới.' }),
      el('p', { class: 'hint', text: 'Thêm ở tab Plan → Confirm. SKU Main và quà tặng có nhu cầu mà tồn thấp sẽ được cảnh báo tại đây.' }));
    return;
  }
  const order = Object.keys(LEVEL);
  const counts = Object.fromEntries(order.map((l) => [l, 0]));
  for (const it of list) counts[levelOf(it)]++;
  const bar = el('div', { class: 'seg-bar' });
  for (const l of order) {
    if (!counts[l]) continue;
    const seg = el('div', { class: LEVEL[l].cls, title: LEVEL[l].label + ': ' + counts[l] });
    seg.style.flexGrow = String(counts[l]);
    bar.append(seg);
  }
  const rows = order.filter((l) => counts[l]).map((l) => el('div', { class: 'txt' }, el('span', { class: 'badge ' + LEVEL[l].cls, text: LEVEL[l].label }), ' ' + counts[l] + ' SKU'));
  $('statusChart').replaceChildren(el('div', { class: 'whstat' }, bar), ...rows);
}

// Danh sách ảnh cho khung xem lớn (chỉ các sản phẩm đang hiển thị và có ảnh)
const galleryOf = (list) => list.filter((it) => it.image).map((it) => ({
  src: it.image, title: it.name || titleOf(it), sku: it.sku, meta: `Bắc ${fmtNum(it.north)} · Nam ${fmtNum(it.south)} · Tổng ${fmtNum(it.total)}`,
}));

function stockCell(label, value, extra = '', cls = '') {
  return el('div', { class: cls }, el('span', { class: 'l', text: label }), el('span', { class: 'n ' + (value === 0 ? 'zero' : extra), text: fmtNum(value) }));
}

function renderCards(list) {
  const hasCost = !!state.data?.snapshot?.hasCost;
  const showPlan = hasAlertPlan();
  const gallery = galleryOf(list);
  const grid = el('div', { class: 'grid' });
  for (const it of list) {
    const ev = evalFor(it.sku, alertMonth());
    const cls = LEVEL[levelOf(it)].cls;

    let media;
    if (it.image) {
      const img = el('img', { src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      media = el('button', { type: 'button', class: 'pimg', 'aria-label': 'Xem ảnh lớn: ' + titleOf(it) }, img, el('span', { class: 'zoom', 'aria-hidden': 'true', text: '⤢' }));
      media.addEventListener('click', () => openLightbox(gallery, gallery.findIndex((g) => g.sku === it.sku)));
      img.addEventListener('error', () => { media.replaceChildren(); media.classList.add('noimg'); media.disabled = true; if (ev) media.append(el('span', { class: 'tag ' + cls, text: LEVEL[ev.level].label })); });
    } else media = el('div', { class: 'pimg noimg' });
    if (ev) media.append(el('span', { class: 'tag ' + cls, text: LEVEL[ev.level].label }));

    const body = el('div', { class: 'pbody' },
      el('div', { class: 'pcat', text: categoryOf(it), title: categoryOf(it) }),
      el('div', { class: 'pname', text: it.name || titleOf(it), title: it.name || titleOf(it) }),
      skuButton(it.sku),
      el('div', { class: 'pstock' },
        stockCell('Bắc', it.north),
        stockCell('Nam', it.south, ev && ev.gapSouth > 0 ? 'low' : ''),
        stockCell('Tổng', it.total, '', 't')));
    if (showPlan) {
      const msg = ev ? alertText(it, ev) : 'Không có trong Forecast ' + monthLabel(alertMonth());
      body.append(el('div', { class: 'pplan ' + (ev ? cls : 'mute'), text: msg, title: msg }));
    }
    if (hasCost) body.append(el('div', { class: 'pcost' },
      el('div', {}, el('span', { class: 'l', text: 'COGS (₫)' }), el('span', { class: 'v', text: it.cogs != null ? fmtNum(Math.round(it.cogs)) : '–' })),
      el('div', {}, el('span', { class: 'l', text: 'Giá trị tồn (₫)' }), el('span', { class: 'v', text: stockValue(it) != null ? fmtNum(Math.round(stockValue(it))) : '–', title: stockValue(it) != null ? fmtMoney(stockValue(it)) : '' }))));
    grid.append(el('article', { class: 'pcard' }, media, body));
  }
  $('board').replaceChildren(grid);
}

function renderTable(list) {
  const gallery = galleryOf(list);
  const hasCost = !!state.data?.snapshot?.hasCost;
  const showPlan = hasAlertPlan();
  const heads = [['', 'img'], ['SKU / Sản phẩm', ''], ['TYPE', ''], ['Category', ''], ['Bắc', 'num'], ['Nam', 'num'], ['Tổng', 'num']];
  if (showPlan) heads.push(['Nhu cầu ' + monthLabel(alertMonth()), 'num'], ['Cảnh báo', '']);
  if (hasCost) heads.push(['COGS', 'num'], ['Giá trị tồn', 'num']);
  const thead = el('thead', {}, el('tr', {}, ...heads.map(([h, c]) => el('th', { class: c, text: h }))));
  const tbody = el('tbody');
  for (const it of list) {
    const ev = evalFor(it.sku, alertMonth());
    const tdImg = el('td', { class: 'img' });
    const th = thumb(it, 'timg');
    if (it.image) {
      th.setAttribute('role', 'button'); th.setAttribute('tabindex', '0'); th.setAttribute('aria-label', 'Xem ảnh lớn: ' + titleOf(it));
      const open = () => openLightbox(gallery, gallery.findIndex((g) => g.sku === it.sku));
      th.addEventListener('click', open);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    }
    tdImg.append(th);
    const cells = [
      tdImg,
      el('td', { class: 'name' }, skuButton(it.sku), el('div', { class: 'pname2', text: it.name || titleOf(it) })),
      el('td', { text: it.type }), el('td', { text: categoryOf(it) }),
      el('td', { class: 'num', text: fmtNum(it.north) }), el('td', { class: 'num', text: fmtNum(it.south) }), el('td', { class: 'num', text: fmtNum(it.total) }),
    ];
    if (showPlan) cells.push(el('td', { class: 'num', text: ev ? fmtNum(ev.qty) : '–' }), el('td', { class: 'msgcell' }, ev ? el('span', { class: 'badge ' + LEVEL[ev.level].cls, text: LEVEL[ev.level].label }) : null, ev ? ' ' + alertText(it, ev) : ''));
    if (hasCost) cells.push(el('td', { class: 'num', text: fmtMoney(it.cogs) }), el('td', { class: 'num', text: fmtMoney(stockValue(it)) }));
    tbody.append(el('tr', {}, ...cells));
  }
  $('board').replaceChildren(el('div', { class: 'tablewrap' }, el('table', {}, thead, tbody)));
}

function renderStock() {
  const list = visibleItems();
  renderFilters(list.length, items().filter((it) => !state.hiddenTypes.has(typeKey(it))).length);
  renderKpis(list); renderCategoryChart(list); renderAlertChart(list);
  $('charts').hidden = !state.showCharts;
  $('toggleCharts').classList.toggle('on', state.showCharts);
  if (state.view === 'table') renderTable(list); else renderCards(list);
  $('empty').hidden = list.length !== 0 || !state.data?.snapshot;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
}

// ---------- vẽ lại ----------
let planShown = false;
let pendingRender = false;

function render(opts = {}) {
  renderChrome();
  if (state.tab === 'stock') renderStock();
  else if (state.tab === 'plan') {
    // Plan có ô nhập liệu: chỉ vẽ lại khi người dùng thao tác, không vẽ lại mỗi lần thăm dò dữ liệu
    if (opts.body || !planShown) { renderPlan(); planShown = true; }
  } else if (opts.force || !forecastBusy()) { renderForecast(); pendingRender = false; }
  else pendingRender = true;
}
hooks.render = render;

// ---------- gọi server ----------
// Trả về true nếu dữ liệu mới đã được áp dụng. Khi người dùng đang gõ/chờ lưu ở Forecast thì bỏ qua lượt này.
async function call(path, method, { force = false } = {}) {
  $('refresh').disabled = true;
  let applied = false;
  try {
    const res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return false; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (force || !forecastBusy()) { state.data = data; applied = true; }
    state.error = null;
  } catch (e) {
    state.error = String(e.message || e);
  } finally {
    $('refresh').disabled = false;
  }
  render({ body: force });
  return applied;
}
const load = (opts) => call('/api/stock', 'GET', opts);
hooks.reload = (opts) => load(opts);

// ---------- CSV (chặn CSV injection: ô bắt đầu bằng = + - @ bị thêm dấu ') ----------
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
function download(name, rows) {
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportCsv() {
  const day = new Date().toISOString().slice(0, 10);
  if (state.tab === 'forecast') return download('forecast-' + state.fcMonth + '-' + day + '.csv', forecastCsv());
  const hasCost = !!state.data?.snapshot?.hasCost;
  const head = ['SKU', 'Tên', 'Short Name', 'TYPE', 'Category', 'Kho Bắc', 'Kho Nam', 'Tổng', 'Nhu cầu ' + alertMonth(), 'Cảnh báo'];
  if (hasCost) head.push('COGS', 'Giá trị tồn');
  const rows = [head];
  for (const it of visibleItems()) {
    const ev = evalFor(it.sku, alertMonth());
    const row = [it.sku, it.name, it.shortName, it.type, it.category, it.north, it.south, it.total, ev?.qty ?? '', ev ? LEVEL[ev.level].label + ': ' + alertText(it, ev) : ''];
    if (hasCost) row.push(it.cogs, stockValue(it));
    rows.push(row);
  }
  download('visual-stock-' + day + '.csv', rows);
}

// Chiều cao thanh trên cùng (để các thanh dính bên dưới bám đúng vị trí; trên điện thoại thanh trên cùng không dính)
const appbar = document.querySelector('.appbar');
const syncBarHeight = () => document.documentElement.style.setProperty('--appbar-h', (getComputedStyle(appbar).position === 'sticky' ? appbar.offsetHeight : 0) + 'px');
syncBarHeight();
new ResizeObserver(syncBarHeight).observe(appbar);

// ---------- sự kiện ----------
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
let qTimer;
on('q', 'input', (e) => { state.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(render, 150); });
on('sort', 'change', (e) => {
  state.sort = e.target.value;
  try { localStorage.setItem('sb_sort', state.sort); } catch { /* bỏ qua */ }
  render();
});
on('toggleCharts', 'click', () => {
  state.showCharts = !state.showCharts;
  try { localStorage.setItem('sb_charts', state.showCharts ? '1' : '0'); } catch { /* bỏ qua */ }
  render();
});
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  render({ body: true, force: true });
});
document.querySelector('#tab-stock .seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  state.view = b.dataset.view;
  try { localStorage.setItem('sb_view', state.view); } catch { /* bỏ qua */ }
  render();
});
on('refresh', 'click', async () => {
  const ok = await call('/api/refresh', 'POST');
  if (!ok && forecastBusy()) toast('Đang có thay đổi chưa lưu ở Forecast — sẽ làm mới sau khi lưu xong.', 'info');
});
on('csv', 'click', exportCsv);
on('logout', 'click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* vẫn chuyển trang */ }
  location.href = '/login.html';
});

initFilters(() => render());
initPlan();
initForecast();
await load();
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
setInterval(renderFreshness, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
