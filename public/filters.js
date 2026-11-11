// Bộ lọc tab Tồn kho: bảng lọc dính bên trái (ngăn kéo trên điện thoại), khoảng giá/tồn, nhiều Category, chip bộ lọc đang bật.
import { state, items, alertMonth, evalFor } from './state.js';
import { $, el, fmtNum, monthLabel, LEVEL, ALERT_LEVELS } from './ui.js';
import { norm, parseMoney, rangeOk } from './logic.js';

export const typeKey = (it) => (it.type || '').trim().toLowerCase() || '(trống)';
export const categoryOf = (it) => it.category || '(chưa phân loại)';
export const levelOf = (it) => evalFor(it.sku, alertMonth())?.level ?? 'none';
export const stockValue = (it) => (it.cogs != null && it.total != null ? it.cogs * it.total : null);
const hasCost = () => !!state.data?.snapshot?.hasCost;

export const RANGES = [
  { key: 'cogs', label: 'Giá COGS', unit: '₫', get: (it) => it.cogs, needsCost: true, hint: 'vd 50k, 200.000, 1tr',
    presets: [['≤ 100k', null, 1e5], ['100k – 500k', 1e5, 5e5], ['500k – 1tr', 5e5, 1e6], ['1tr – 3tr', 1e6, 3e6], ['≥ 3tr', 3e6, null]] },
  { key: 'value', label: 'Giá trị tồn (COGS × tồn)', unit: '₫', get: stockValue, needsCost: true, hint: 'vd 10tr, 1,5 tỷ' },
  { key: 'total', label: 'Tổng tồn', unit: 'cái', get: (it) => it.total, hint: 'vd 0, 50' },
  { key: 'north', label: 'Tồn kho Bắc', unit: 'cái', get: (it) => it.north, hint: '' },
  { key: 'south', label: 'Tồn kho Nam', unit: 'cái', get: (it) => it.south, hint: '' },
];
const activeRanges = () => RANGES.filter((r) => (!r.needsCost || hasCost()) && (state.ranges[r.key].min !== null || state.ranges[r.key].max !== null));

const hay = new WeakMap();
const haystack = (it) => { let h = hay.get(it); if (h === undefined) { h = norm([it.sku, it.name, it.shortName, it.category].join(' ')); hay.set(it, h); } return h; };

// skip: bỏ qua một nhóm bộ lọc khi đếm số lượng cho nhóm đó (vd đếm Category thì bỏ lọc Category)
export function matchItem(it, skip = '') {
  if (state.hiddenTypes.has(typeKey(it))) return false;
  if (skip !== 'category' && state.categories.size && !state.categories.has(categoryOf(it))) return false;
  if (skip !== 'status') {
    const lv = levelOf(it);
    if (state.status === 'alert' ? !ALERT_LEVELS.has(lv) : state.status !== 'all' && lv !== state.status) return false;
  }
  for (const t of norm(state.q).split(/\s+/).filter(Boolean)) if (!haystack(it).includes(t)) return false; // gõ không dấu cũng tìm được
  for (const r of RANGES) { if (r.needsCost && !hasCost()) continue; if (!rangeOk(r.get(it), state.ranges[r.key])) return false; }
  if (state.dataFlag === 'noimg' && it.image) return false;
  if (state.dataFlag === 'img' && !it.image) return false;
  if (state.dataFlag === 'nocogs' && it.cogs != null) return false;
  return true;
}

const fmtRange = ({ min, max }) => (min !== null && max !== null ? `${fmtNum(min)} – ${fmtNum(max)}` : min !== null ? `≥ ${fmtNum(min)}` : `≤ ${fmtNum(max)}`);
const STATUS_LABEL = { alert: 'Cần chú ý', out: 'Hết hàng', short: 'Thiếu so plan', south: 'Kho Nam thiếu', tight: 'Sát plan', ok: 'Đủ plan', none: 'Không có trong Forecast' };
const FLAG_LABEL = { noimg: 'Thiếu ảnh', img: 'Có ảnh', nocogs: 'Thiếu COGS' };

function activeChips() {
  const out = [];
  for (const c of state.categories) out.push({ text: 'Category: ' + c, clear: () => state.categories.delete(c) });
  if (state.status !== 'all') out.push({ text: 'Forecast: ' + (STATUS_LABEL[state.status] ?? state.status), clear: () => { state.status = 'all'; } });
  for (const r of activeRanges()) out.push({ text: r.label.split(' (')[0] + ': ' + fmtRange(state.ranges[r.key]), clear: () => { state.ranges[r.key] = { min: null, max: null }; } });
  if (state.dataFlag) out.push({ text: FLAG_LABEL[state.dataFlag], clear: () => { state.dataFlag = ''; } });
  return out;
}
export const activeCount = () => activeChips().length;

export function resetFilters() {
  state.categories = new Set(); state.status = 'all'; state.dataFlag = ''; state.q = '';
  for (const r of RANGES) state.ranges[r.key] = { min: null, max: null };
  $('q').value = '';
}

// ---------- vẽ ----------
let onChange = () => {};
const rangeEls = {};

function buildRanges() {
  const blocks = RANGES.map((r) => {
    const mk = (ph, which) => el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: ph, 'aria-label': r.label + ' ' + ph.toLowerCase(), class: 'range-in' });
    const minIn = mk('Từ'), maxIn = mk('Đến');
    const warn = el('div', { class: 'range-warn', hidden: true, text: '"Từ" đang lớn hơn "Đến"' });
    const presets = el('div', { class: 'presets' });
    const box = el('section', { class: 'f-block', 'data-range': r.key },
      el('h3', {}, r.label),
      ...(r.presets ? [presets] : []),
      el('div', { class: 'range-row' }, minIn, el('span', { class: 'dash', text: '–' }), maxIn, el('span', { class: 'unit', text: r.unit })),
      ...(r.hint ? [el('div', { class: 'f-hint', text: r.hint })] : []), warn);
    let timer;
    const apply = () => {
      const mn = parseMoney(minIn.value), mx = parseMoney(maxIn.value);
      minIn.classList.toggle('bad', minIn.value.trim() !== '' && mn === null);
      maxIn.classList.toggle('bad', maxIn.value.trim() !== '' && mx === null);
      warn.hidden = !(mn !== null && mx !== null && mn > mx);
      state.ranges[r.key] = { min: mn, max: mx };
      onChange();
    };
    for (const inp of [minIn, maxIn]) {
      inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 250); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); apply(); } });
      inp.addEventListener('blur', () => { clearTimeout(timer); apply(); const n = parseMoney(inp.value); if (n !== null) inp.value = fmtNum(n); });
    }
    rangeEls[r.key] = { box, minIn, maxIn, presets, warn };
    return box;
  });
  $('ranges').replaceChildren(blocks[0]);          // COGS luôn hiện ở trên
  $('rangesMore').replaceChildren(...blocks.slice(1)); // các khoảng còn lại nằm trong mục thu gọn
}

function syncRanges() {
  const moreActive = RANGES.slice(1).some((r) => (!r.needsCost || hasCost()) && (state.ranges[r.key].min !== null || state.ranges[r.key].max !== null));
  if (moreActive) $('moreFilters').open = true; // có bộ lọc đang bật thì không giấu đi
  for (const r of RANGES) {
    const e = rangeEls[r.key];
    e.box.hidden = !!r.needsCost && !hasCost();
    const cur = state.ranges[r.key];
    if (document.activeElement !== e.minIn) e.minIn.value = cur.min === null ? '' : fmtNum(cur.min);
    if (document.activeElement !== e.maxIn) e.maxIn.value = cur.max === null ? '' : fmtNum(cur.max);
    e.warn.hidden = !(cur.min !== null && cur.max !== null && cur.min > cur.max);
    if (r.presets) {
      e.presets.replaceChildren(...r.presets.map(([label, mn, mx]) => {
        const on = cur.min === mn && cur.max === mx;
        const b = el('button', { type: 'button', class: 'chip sm ' + (on ? 'on' : ''), 'aria-pressed': String(on), text: label });
        b.addEventListener('click', () => { state.ranges[r.key] = on ? { min: null, max: null } : { min: mn, max: mx }; onChange(); });
        return b;
      }));
    }
  }
}

function renderTypes() {
  const counts = new Map();
  for (const it of items()) {
    const k = typeKey(it);
    const c = counts.get(k) ?? { label: it.type.trim() || '(trống)', n: 0 };
    c.n++; counts.set(k, c);
  }
  const chips = [...counts.entries()].sort((a, b) => (a[0] === 'other') - (b[0] === 'other') || b[1].n - a[1].n).map(([k, c]) => {
    const on = !state.hiddenTypes.has(k);
    const btn = el('button', { type: 'button', class: 'chip ' + (on ? 'on' : 'off'), 'aria-pressed': String(on), text: c.label + ' (' + c.n + ')', title: on ? 'Bấm để ẩn TYPE này' : 'Bấm để hiện TYPE này' });
    btn.addEventListener('click', () => { if (on) state.hiddenTypes.add(k); else state.hiddenTypes.delete(k); onChange(); });
    return btn;
  });
  $('typeChips').replaceChildren(...chips);
}

function renderCategories() {
  const q = norm($('catQ').value.trim());
  const counts = new Map();
  for (const it of items()) if (matchItem(it, 'category')) counts.set(categoryOf(it), (counts.get(categoryOf(it)) ?? 0) + 1);
  for (const c of state.categories) if (!counts.has(c)) counts.set(c, 0); // category đang chọn luôn hiện để bỏ chọn được
  const rows = [...counts.entries()].filter(([c]) => !q || norm(c).includes(q) || state.categories.has(c))
    .sort((a, b) => (state.categories.has(b[0]) - state.categories.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
  const list = $('catList');
  const keepScroll = list.scrollTop;
  const focused = document.activeElement?.dataset?.cat;
  list.replaceChildren(...(rows.length ? rows.map(([c, n]) => {
    const cb = el('input', { type: 'checkbox', 'data-cat': c });
    cb.checked = state.categories.has(c);
    cb.addEventListener('change', () => { if (cb.checked) state.categories.add(c); else state.categories.delete(c); onChange(); });
    return el('label', { class: 'ck' + (n === 0 ? ' zero' : '') }, cb, el('span', { class: 't', text: c, title: c }), el('span', { class: 'n', text: String(n) }));
  }) : [el('div', { class: 'f-hint', text: 'Không có category phù hợp.' })]));
  list.scrollTop = keepScroll;
  if (focused !== undefined) [...list.querySelectorAll('input')].find((i) => i.dataset.cat === focused)?.focus();
  $('catClear').hidden = state.categories.size === 0;
}

function renderActive() {
  const chips = activeChips();
  const box = $('activeFilters');
  box.hidden = chips.length === 0;
  box.replaceChildren(...chips.map((c) => {
    const b = el('button', { type: 'button', class: 'chip on x', title: 'Bấm để bỏ bộ lọc này' }, c.text + ' ', el('span', { 'aria-hidden': 'true', text: '✕' }));
    b.addEventListener('click', () => { c.clear(); onChange(); });
    return b;
  }), el('button', { type: 'button', class: 'link', text: 'Xoá tất cả bộ lọc' }));
  box.lastChild.addEventListener('click', () => { resetFilters(); onChange(); });
}

// total: số SP sau mọi bộ lọc; base: số SP đang hiện theo TYPE
export function renderFilters(total, base) {
  renderTypes(); renderCategories(); syncRanges(); renderActive();
  if (document.activeElement !== $('status')) $('status').value = state.status;
  $('dataFlag').value = state.dataFlag;
  $('resultCount').replaceChildren(el('b', { text: fmtNum(total) }), ' / ' + fmtNum(base) + ' sản phẩm');
  const n = activeCount();
  $('fBadge').textContent = n ? String(n) : '';
  $('fBadge').hidden = !n;
  $('fApply').textContent = 'Xem ' + fmtNum(total) + ' sản phẩm';
  $('fReset').hidden = n === 0 && !state.q;
}

// ---------- khởi tạo + ngăn kéo trên điện thoại ----------
export function initFilters(change) {
  onChange = change;
  buildRanges();
  $('status').addEventListener('change', (e) => { state.status = e.target.value; onChange(); });
  $('dataFlag').addEventListener('change', (e) => { state.dataFlag = e.target.value; onChange(); });
  $('catQ').addEventListener('input', renderCategories);
  $('catClear').addEventListener('click', () => { state.categories = new Set(); onChange(); });
  $('fReset').addEventListener('click', () => { resetFilters(); onChange(); });

  const mq = window.matchMedia('(max-width: 900px)');
  const drawer = $('filters');
  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    $('fBackdrop').hidden = !open;
    document.body.classList.toggle('noscroll', open && mq.matches);
    $('fOpen').setAttribute('aria-expanded', String(open));
    syncInert();
  };
  const syncInert = () => { drawer.inert = mq.matches && !drawer.classList.contains('open'); };
  $('fOpen').addEventListener('click', () => { setOpen(true); $('fClose').focus(); });
  for (const id of ['fClose', 'fApply', 'fBackdrop']) $(id).addEventListener('click', () => { setOpen(false); $('fOpen').focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open') && mq.matches) { setOpen(false); $('fOpen').focus(); } });
  mq.addEventListener('change', () => setOpen(false));
  syncInert();
}
