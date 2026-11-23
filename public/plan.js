// Tab Plan: dán dữ liệu từ Google Sheet -> tự ghép tên sản phẩm -> chọn lại nếu sai -> Confirm = lưu vào Forecast.
import { state, items, itemBySku, alertMonth, forecastLines, hooks } from './state.js';
import { $, el, toast, channelSegButtons, thumb, fmtNum } from './ui.js';
import { parsePaste, autoMatch, channelOf, DEFAULT_CHANNEL, dealLabel, norm } from './logic.js';
import { lineCard, lineIssues, clean } from './linecard.js';
import { postForecast } from './api.js';

const blank = (month, channel) => ({ month, channel, campaign: '', price: 0, units: null, maxCir: null, main: { sku: '', srcName: '', conf: 'none', qty: 1 }, combo: [], gifts: [] });

function toDrafts(parsed, month, channel) {
  return parsed.lines.map((l) => {
    const m = autoMatch(l.mainName, items());
    return {
      month, channel, campaign: l.campaign, price: l.price ?? 0, units: null, maxCir: l.maxCir,
      main: { sku: m.sku, srcName: l.mainName, conf: m.conf, qty: 1 }, combo: [],
      gifts: l.gifts.map((g) => {
        const gm = autoMatch(g.name, items());
        return { sku: gm.sku, srcName: g.name, conf: gm.conf, qty: g.qty, cost: g.cost ?? itemBySku(gm.sku)?.cogs ?? 0 };
      }),
    };
  });
}

const isDuplicate = (l) => l.main.sku && forecastLines().some((f) => f.month === l.month && channelOf(f) === channelOf(l) && f.campaign === String(l.campaign).trim().toUpperCase() && dealLabel(f) === dealLabel(l));

export function renderPlan() {
  const month = $('pasteMonth');
  if (!month.value) month.value = alertMonth();
  const list = state.staged;
  $('pasteWarn').replaceChildren(...state.pasteWarnings.map((w) => el('div', { text: w })));
  $('pasteWarn').hidden = state.pasteWarnings.length === 0;

  const bar = $('reviewBar'), review = $('review');
  const chCounts = {};
  for (const l of list) chCounts[channelOf(l)] = (chCounts[channelOf(l)] ?? 0) + 1;
  if (state.stagedChannel && !chCounts[state.stagedChannel]) state.stagedChannel = '';
  $('planFilter').hidden = list.length === 0;
  $('planChannel').replaceChildren(...channelSegButtons({
    value: state.stagedChannel, counts: chCounts, total: list.length,
    onPick: (k) => { state.stagedChannel = k; renderPlan(); },
  }));
  if (!list.length) {
    bar.replaceChildren(); review.replaceChildren(el('div', { class: 'empty-state' },
      el('div', { class: 'big', text: 'Chưa có line nào chờ xác nhận' }),
      el('p', { class: 'muted', text: 'Dán dữ liệu ở trên rồi bấm "Phân tích", hoặc bấm "Nhập thủ công" để chọn mã Main.' })));
    return;
  }
  const count = el('b'), issueTxt = el('span', { class: 'issue' });
  const confirm = el('button', { type: 'button', class: 'btn primary', id: 'confirmAdd' });
  const clear = el('button', { type: 'button', class: 'btn ghost', text: 'Huỷ tất cả' });
  const updateBar = () => {
    const bad = list.filter((l) => lineIssues(l).length).length;
    count.textContent = `${list.length} line chờ xác nhận`;
    issueTxt.textContent = bad ? `${bad} line cần chọn lại sản phẩm / bổ sung thông tin` : '';
    confirm.textContent = `Confirm — thêm ${list.length} line vào Forecast`;
    confirm.disabled = bad > 0;
    confirm.title = bad ? 'Hoàn tất các line đang viền đỏ trước khi thêm' : 'Lưu và chuyển sang tab Forecast';
  };
  clear.addEventListener('click', () => { state.staged = []; state.pasteWarnings = []; renderPlan(); });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true; confirm.textContent = 'Đang lưu…';
    try {
      const payload = list.map(clean);
      await postForecast({ op: 'add', lines: payload });
      state.staged = []; state.pasteWarnings = []; $('paste').value = '';
      state.tab = 'forecast'; state.fcMonth = payload[0].month; state.fcCampaign = ''; state.fcChannel = ''; state.fcOnlyAlert = false; state.fcQ = ''; state.stagedChannel = '';
      toast(`Đã thêm ${payload.length} line vào Forecast`, 'ok');
      await hooks.reload({ force: true });
    } catch (e) {
      toast('Không lưu được: ' + e.message, 'error'); updateBar();
    }
  });
  bar.replaceChildren(el('div', { class: 'reviewbar' }, el('div', { class: 'rb-txt' }, count, issueTxt), el('div', { class: 'rb-act' }, clear, confirm)));
  updateBar();

  const shown = state.stagedChannel ? list.filter((l) => channelOf(l) === state.stagedChannel) : list;
  review.replaceChildren(...shown.map((line) => {
    const dup = isDuplicate(line);
    return lineCard(line, {
      staged: true, note: dup ? 'Đã có line cùng tháng + channel + campaign + deal trong Forecast' : '',
      onChange: updateBar,
      onRemove: (l) => { state.staged = state.staged.filter((x) => x !== l); renderPlan(); },
    });
  }));
}

export function initPlan() {
  $('analyze').addEventListener('click', () => {
    if (!items().length) return toast('Chưa có dữ liệu sản phẩm từ Sheet để ghép tên. Hãy bấm "Làm mới".', 'error');
    const parsed = parsePaste($('paste').value);
    state.pasteWarnings = parsed.warnings;
    const drafts = toDrafts(parsed, $('pasteMonth').value || alertMonth(), $('pasteChannel').value || DEFAULT_CHANNEL);
    if (drafts.length) { state.staged = [...state.staged, ...drafts]; $('paste').value = ''; }
    renderPlan();
    const bad = drafts.filter((l) => lineIssues(l).length).length;
    if (drafts.length) toast(`Đã đọc ${drafts.length} line${bad ? `, ${bad} line cần chọn lại sản phẩm` : ''}`, bad ? 'info' : 'ok');
  });
  initManual();
}

// ---------- nhập thủ công: xổ toàn bộ mã Main để tick chọn ----------
const mainItems = () => items().filter((it) => state.manual.includeOther || String(it.type).toLowerCase() === 'main')
  .sort((a, b) => (a.category || '').localeCompare(b.category || '', 'vi') || (a.shortName || a.name).localeCompare(b.shortName || b.name, 'vi', { numeric: true }));

function updateManualCount() {
  const n = state.manual.sel.size;
  $('mpCount').textContent = n ? `Đã chọn ${n} SKU` : 'Chưa chọn SKU nào';
  $('mpAddEach').disabled = n === 0;
  $('mpAddEach').textContent = n > 1 ? `Thêm ${n} line riêng` : 'Thêm 1 line';
  $('mpAddCombo').disabled = n < 2;
  $('mpAddCombo').title = n < 2 ? 'Chọn từ 2 SKU trở lên để gộp thành một deal combo' : `Gộp ${n} SKU thành MỘT deal (mỗi SKU theo SL/deal đã nhập)`;
}

function renderManualList() {
  const q = norm(state.manual.q);
  const rows = mainItems().filter((it) => !q || norm([it.sku, it.name, it.shortName, it.category].join(' ')).includes(q));
  const nodes = [];
  let lastCat = null;
  for (const it of rows) {
    const cat = it.category || 'Chưa phân loại';
    if (cat !== lastCat) { nodes.push(el('div', { class: 'mp-cat', text: cat })); lastCat = cat; }
    const checked = state.manual.sel.has(it.sku);
    const cb = el('input', { type: 'checkbox', checked, 'aria-label': 'Chọn ' + it.sku });
    const qty = el('input', { type: 'text', inputmode: 'numeric', class: 'num-in mp-qty', value: String(state.manual.sel.get(it.sku) ?? 1), title: 'SL / deal: số cái SKU này trong 1 deal', 'aria-label': 'SL trong deal ' + it.sku });
    const row = el('label', { class: 'mp-row' + (checked ? ' on' : ''), role: 'listitem' },
      cb, thumb(it, 'timg'),
      el('span', { class: 'mp-txt' }, el('span', { class: 'mp-sku', text: it.sku }), el('span', { class: 'mp-name', text: it.shortName || it.name, title: it.name })),
      el('span', { class: 'mp-stock', title: 'Tồn Bắc / Nam / Tổng' }, `MB ${fmtNum(it.north)} · MN ${fmtNum(it.south)} · ${fmtNum(it.total)}`),
      el('span', { class: 'mp-qwrap' }, el('span', { class: 'lc-lbl', text: '× SL/deal' }), qty));
    cb.addEventListener('change', () => {
      row.classList.toggle('on', cb.checked);
      if (cb.checked) state.manual.sel.set(it.sku, Math.max(1, parseInt(qty.value, 10) || 1)); else state.manual.sel.delete(it.sku);
      updateManualCount();
    });
    qty.addEventListener('input', () => {
      const v = Math.max(1, Math.min(1000, parseInt(qty.value.replace(/\D/g, ''), 10) || 1));
      if (state.manual.sel.has(it.sku)) state.manual.sel.set(it.sku, v);
    });
    qty.addEventListener('focus', () => { if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); } qty.select(); });
    nodes.push(row);
  }
  $('mpList').replaceChildren(...(nodes.length ? nodes : [el('p', { class: 'muted center', text: items().length ? 'Không có mã Main nào khớp.' : 'Chưa có dữ liệu sản phẩm từ Sheet. Hãy bấm "Làm mới".' })]));
  updateManualCount();
}

function manualContext() {
  return { month: $('pasteMonth').value || alertMonth(), channel: $('pasteChannel').value || DEFAULT_CHANNEL, campaign: ($('mpCampaign').value || '').trim().toUpperCase() };
}

function stageManual(lines) {
  state.staged = [...state.staged, ...lines];
  state.manual.sel.clear();
  setManualOpen(false);
  renderPlan();
  toast(`Đã thêm ${lines.length} line vào danh sách chờ — kiểm tra rồi bấm Confirm`, 'ok');
  $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setManualOpen(open) {
  state.manual.open = open;
  $('manualPanel').hidden = !open;
  $('manualAdd').setAttribute('aria-expanded', String(open));
  $('manualAdd').textContent = open ? 'Đóng nhập thủ công ▴' : 'Nhập thủ công ▾';
  if (open) { renderManualList(); $('mpQ').focus(); }
}

function initManual() {
  $('manualAdd').addEventListener('click', () => {
    if (!items().length) return toast('Chưa có dữ liệu sản phẩm từ Sheet. Hãy bấm "Làm mới".', 'error');
    setManualOpen(!state.manual.open);
  });
  let t;
  $('mpQ').addEventListener('input', (e) => { state.manual.q = e.target.value; clearTimeout(t); t = setTimeout(renderManualList, 120); });
  $('mpOther').addEventListener('change', (e) => { state.manual.includeOther = e.target.checked; renderManualList(); });
  $('mpSelectAll').addEventListener('click', () => {
    const q = norm(state.manual.q);
    for (const it of mainItems()) if (!q || norm([it.sku, it.name, it.shortName, it.category].join(' ')).includes(q)) state.manual.sel.set(it.sku, state.manual.sel.get(it.sku) ?? 1);
    renderManualList();
  });
  $('mpClear').addEventListener('click', () => { state.manual.sel.clear(); renderManualList(); });
  $('mpAddBlank').addEventListener('click', () => { const c = manualContext(); const l = blank(c.month, c.channel); l.campaign = c.campaign; stageManual([l]); });
  // mỗi SKU 1 line (SL/deal > 1 = cùng 1 SKU nhiều cái trong 1 deal)
  $('mpAddEach').addEventListener('click', () => {
    const c = manualContext();
    stageManual([...state.manual.sel].map(([sku, qty]) => ({ ...blank(c.month, c.channel), campaign: c.campaign, main: { sku, srcName: '', conf: 'exact', qty } })));
  });
  // gộp tất cả SKU đã chọn thành MỘT deal combo: SKU đầu là Main, các SKU còn lại gộp thêm
  $('mpAddCombo').addEventListener('click', () => {
    const c = manualContext();
    const [[sku, qty], ...rest] = [...state.manual.sel];
    stageManual([{ ...blank(c.month, c.channel), campaign: c.campaign, main: { sku, srcName: '', conf: 'exact', qty }, combo: rest.map(([s, q]) => ({ sku: s, srcName: '', conf: 'exact', qty: q })) }]);
  });
}
