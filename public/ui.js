// Thành phần giao diện dùng chung: tạo phần tử DOM, định dạng số, toast, bộ chọn sản phẩm.
// Không dùng innerHTML (CSP + chống XSS): luôn dựng bằng createElement/textContent.
import { state, items, itemBySku, rules } from './state.js';
import { rank, search, confidence } from './logic.js';

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  return n;
}

const nf = new Intl.NumberFormat('vi-VN');
const tf = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' });
const pf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
export const fmtTime = (sec) => tf.format(new Date(sec * 1000));
export const fmtNum = (v) => (v === null || v === undefined ? '–' : nf.format(v));
export const fmtMoney = (v) => (v === null || v === undefined ? '–' : nf.format(Math.round(v)) + ' ₫');
export const fmtPct = (v) => (v === null || v === undefined ? '–' : pf.format(v * 100) + '%');
export const monthLabel = (m) => (m ? 'T' + m.slice(5) + '/' + m.slice(0, 4) : '');
export function fmtCompactMoney(v) {
  const a = Math.abs(v);
  const f = (x, d) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: d }).format(x);
  if (a >= 1e9) return f(v / 1e9, 2) + ' tỷ ₫';
  if (a >= 1e6) return f(v / 1e6, 1) + ' triệu ₫';
  return fmtMoney(v);
}

// Mức cảnh báo: khớp thứ tự ưu tiên của server (lib/plan.mjs). cls = màu.
export const LEVEL = {
  out: { label: 'Hết hàng', rank: 0, cls: 'bad' },
  short: { label: 'Thiếu so plan', rank: 1, cls: 'bad' },
  south: { label: 'Kho Nam thiếu', rank: 2, cls: 'warn' },
  tight: { label: 'Sát plan', rank: 3, cls: 'warn' },
  ok: { label: 'Đủ plan', rank: 4, cls: 'good' },
  nodata: { label: 'Chưa có tồn', rank: 5, cls: 'mute' },
  none: { label: 'Không có trong plan', rank: 6, cls: 'mute' },
};
export const ALERT_LEVELS = new Set(['out', 'short', 'south', 'tight']);

export function alertText(it, ev) {
  if (!ev) return '';
  const n = (v) => nf.format(v);
  const need = 'Nhu cầu ' + n(ev.qty) + (ev.gift > 0 && ev.main > 0 ? ` (Main ${n(ev.main)} + quà ${n(ev.gift)})` : ev.gift > 0 ? ' (quà tặng)' : '');
  const south = ev.gapSouth > 0
    ? 'Nam thiếu ' + n(ev.gapSouth) + ' (cần ≥ ' + n(ev.needSouth) + ')' + (ev.transferable > 0 ? ', Bắc có thể chuyển ~' + n(ev.transferable) : ', Bắc không đủ dư để chuyển')
    : '';
  switch (ev.level) {
    case 'out': return need + ' — đang hết hàng';
    case 'short': return need + ', tồn ' + n(it.total ?? 0) + ' → thiếu ' + n(ev.gapTotal) + (south ? '; ' + south : '');
    case 'south': return need + '; ' + south;
    case 'tight': return need + ', tồn chỉ ' + Math.round(ev.coverage * 100) + '% (ngưỡng sát: +' + rules().bufferPct + '%)';
    case 'nodata': return 'Chưa có số tồn';
    default: return need + ', tồn ' + Math.round(ev.coverage * 100) + '%';
  }
}

export function toast(msg, kind = 'info') {
  const t = el('div', { class: 'toast ' + kind, role: 'status', text: msg });
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

export function thumb(it, cls) {
  const box = el('div', { class: cls });
  if (!it?.image) { box.classList.add('noimg'); return box; }
  const img = el('img', { src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => { img.remove(); box.classList.add('noimg'); });
  box.append(img);
  return box;
}

// MB/MN = tồn Bắc/Nam. Chip MN đổi màu khi kho Nam thiếu so với nhu cầu; badge hiện mức cảnh báo tổng.
export function stockChips(it, ev) {
  if (!it) return el('span', { class: 'chips-inline' });
  const mn = ev && ev.gapSouth > 0 ? 'warn' : '';
  return el('span', { class: 'chips-inline' },
    el('span', { class: 'sc', title: 'Tồn kho Bắc' }, 'MB ', el('b', { text: fmtNum(it.north) })),
    el('span', { class: 'sc ' + mn, title: 'Tồn kho Nam' }, 'MN ', el('b', { text: fmtNum(it.south) })),
    ev ? el('span', { class: 'badge ' + LEVEL[ev.level].cls, title: alertText(it, ev), text: LEVEL[ev.level].label }) : null);
}

// ---------- bộ chọn sản phẩm (combobox) ----------
let openPop = null;
document.addEventListener('mousedown', (e) => { if (openPop && !openPop.root.contains(e.target)) openPop.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) openPop.close(); });

const CONF = {
  exact: ['good', 'Trùng tên'], good: ['good', 'Rất giống'], weak: ['warn', 'Gần giống — hãy kiểm tra'], none: ['bad', 'Chưa khớp — hãy chọn'],
};

// value = SKU đang chọn · srcName = tên gốc dán từ Sheet (dùng để gợi ý) · onPick(item)
export function picker({ value, srcName = '', conf = '', onPick, placeholder = 'Chọn sản phẩm…', showSrc = true }) {
  const it = value ? itemBySku(value) : null;
  const root = el('div', { class: 'pick' });
  const btnLabel = it ? [el('span', { class: 'pick-name', text: it.shortName || it.name }), el('span', { class: 'pick-sku', text: it.sku + (it.type ? ' · ' + it.type : '') })]
    : [el('span', { class: 'pick-name placeholder', text: value ? 'SKU ' + value + ' (không còn trong Sheet)' : placeholder })];
  const btn = el('button', { type: 'button', class: 'pick-btn' + (value ? '' : ' unset'), title: it?.name ?? '' }, thumb(it, 'pick-thumb'), el('span', { class: 'pick-txt' }, ...btnLabel), el('span', { class: 'caret', text: '▾' }));
  const pop = el('div', { class: 'pick-pop', hidden: true });
  const q = el('input', { type: 'search', class: 'pick-q', placeholder: 'Gõ tên hoặc SKU để tìm…', autocomplete: 'off' });
  const list = el('ul', { class: 'pick-list', role: 'listbox' });
  pop.append(q, list);
  root.append(btn, pop);
  if (srcName && showSrc) root.append(el('div', { class: 'src', title: srcName }, 'Sheet: ', el('i', { text: srcName }), conf ? el('span', { class: 'badge ' + CONF[conf][0], text: CONF[conf][1] }) : null));

  let hits = [], active = 0;
  const paint = () => {
    list.replaceChildren(...(hits.length ? hits.map(({ item, score }, i) => {
      const li = el('li', { class: 'pick-item' + (i === active ? ' on' : ''), role: 'option', 'aria-selected': String(i === active) },
        thumb(item, 'pick-thumb'),
        el('span', { class: 'pick-txt' },
          el('span', { class: 'pick-name', text: item.name }),
          el('span', { class: 'pick-sku', text: `${item.sku} · ${item.type || '—'} · MB ${item.north ?? '–'} · MN ${item.south ?? '–'}` })),
        score != null && q.value === '' ? el('span', { class: 'badge ' + CONF[confidence(score)][0], text: Math.round(score * 100) + '%' }) : null);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(item); });
      return li;
    }) : [el('li', { class: 'pick-empty', text: q.value ? 'Không tìm thấy sản phẩm khớp.' : 'Gõ để tìm sản phẩm.' })]));
  };
  const refresh = () => {
    hits = q.value.trim() ? search(q.value, items(), 8) : rank(srcName, items(), 6);
    active = 0; paint();
  };
  const choose = (item) => { close(); onPick(item); };
  const close = () => { pop.hidden = true; if (openPop?.root === root) openPop = null; };
  const open = () => {
    if (openPop && openPop.root !== root) openPop.close();
    pop.hidden = false; openPop = { root, close }; q.value = ''; refresh(); q.focus();
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  q.addEventListener('input', refresh);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(hits.length - 1, active + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[active]) { choose(hits[active].item); e.preventDefault(); }
  });
  return root;
}

// Ô nhập số có định dạng nghìn khi rời ô. onValue(number|null) gọi mỗi lần gõ. decimal=true cho phép số lẻ (vd 4,5).
export function numberInput({ value, onValue, allowNull = false, decimal = false, cls = '', title = '', suffix = '', max = 1e9 }) {
  const nfd = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: decimal ? 2 : 0 });
  const fmt = (v) => (v === null || v === undefined || v === '' ? '' : nfd.format(v));
  const input = el('input', { type: 'text', inputmode: decimal ? 'decimal' : 'numeric', class: 'num-in ' + cls, value: fmt(value), title, autocomplete: 'off' });
  const read = () => {
    const raw = decimal ? input.value.replace(',', '.').replace(/[^\d.]/g, '') : input.value.replace(/[^\d]/g, '');
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return allowNull ? null : 0;
    return Math.min(max, n);
  };
  input.addEventListener('input', () => onValue(read()));
  input.addEventListener('focus', () => { if (!decimal) input.value = input.value.replace(/\./g, ''); input.select(); });
  input.addEventListener('blur', () => { const v = read(); input.value = allowNull && v === null && !input.value.trim() ? '' : fmt(v); });
  return suffix ? el('span', { class: 'with-suffix' }, input, el('span', { class: 'suffix', text: suffix })) : input;
}


// ---------- copy SKU ----------
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* trình duyệt chặn -> thử cách cũ */ }
  try {
    const ta = el('textarea', { readonly: '', 'aria-hidden': 'true' });
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// Nút hiện mã SKU; bấm vào là copy vào clipboard.
export function skuButton(sku) {
  const ic = el('span', { class: 'ic', 'aria-hidden': 'true', text: '⧉' });
  const b = el('button', { type: 'button', class: 'psku', title: 'Bấm để copy SKU' }, el('span', { text: sku }), ic);
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await copyText(sku)) {
      b.classList.add('copied'); ic.textContent = '✓';
      toast('Đã copy SKU: ' + sku, 'ok');
      setTimeout(() => { b.classList.remove('copied'); ic.textContent = '⧉'; }, 1500);
    } else toast('Không copy được. Hãy bôi đen và copy thủ công: ' + sku, 'error');
  });
  return b;
}

// ---------- xem ảnh lớn ----------
// entries: [{ src, title, sku, meta }]; index: ảnh mở đầu. Esc / bấm nền / ✕ để đóng, ← → để chuyển ảnh.
let lightbox = null;
export function closeLightbox() { if (lightbox) lightbox.close(); }
export function openLightbox(entries, index = 0) {
  if (!entries.length) return;
  closeLightbox();
  const opener = document.activeElement;
  let i = Math.min(Math.max(0, index), entries.length - 1);
  const img = el('img', { class: 'lb-img', alt: '', referrerpolicy: 'no-referrer' });
  const title = el('div', { class: 't' });
  const skuBox = el('div');
  const sub = el('div', { class: 'n' });
  const x = el('button', { type: 'button', class: 'lb-x', 'aria-label': 'Đóng', text: '✕' });
  const prev = el('button', { type: 'button', class: 'lb-nav lb-prev', 'aria-label': 'Ảnh trước', text: '‹' });
  const next = el('button', { type: 'button', class: 'lb-nav lb-next', 'aria-label': 'Ảnh sau', text: '›' });
  const root = el('div', { class: 'lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Xem ảnh sản phẩm' }, img, el('div', { class: 'lb-cap' }, title, skuBox, sub), x, prev, next);
  const show = () => {
    const e = entries[i];
    img.src = e.src; img.alt = e.title;
    title.textContent = e.title;
    skuBox.replaceChildren(skuButton(e.sku));
    sub.textContent = `${i + 1} / ${entries.length}` + (e.meta ? ' · ' + e.meta : '');
    prev.hidden = next.hidden = entries.length < 2;
  };
  const go = (d) => { i = (i + d + entries.length) % entries.length; show(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && entries.length > 1) go(-1);
    else if (e.key === 'ArrowRight' && entries.length > 1) go(1);
  };
  function close() {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('noscroll');
    root.remove(); lightbox = null;
    if (opener && opener.isConnected) opener.focus();
  }
  img.addEventListener('error', () => { title.textContent = 'Không tải được ảnh này'; });
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  x.addEventListener('click', close);
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  document.addEventListener('keydown', onKey);
  document.body.classList.add('noscroll');
  document.body.append(root);
  show(); x.focus();
  lightbox = { close };
}
