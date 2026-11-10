// Tab Plan: dán dữ liệu từ Google Sheet -> tự ghép tên sản phẩm -> chọn lại nếu sai -> Confirm = lưu vào Forecast.
import { state, items, itemBySku, alertMonth, forecastLines, hooks } from './state.js';
import { $, el, toast } from './ui.js';
import { parsePaste, autoMatch } from './logic.js';
import { lineCard, lineIssues, clean } from './linecard.js';
import { postForecast } from './api.js';

const blank = (month) => ({ month, campaign: '', price: 0, units: null, maxCir: null, main: { sku: '', srcName: '', conf: 'none' }, gifts: [] });

function toDrafts(parsed, month) {
  return parsed.lines.map((l) => {
    const m = autoMatch(l.mainName, items());
    return {
      month, campaign: l.campaign, price: l.price ?? 0, units: null, maxCir: l.maxCir,
      main: { sku: m.sku, srcName: l.mainName, conf: m.conf },
      gifts: l.gifts.map((g) => {
        const gm = autoMatch(g.name, items());
        return { sku: gm.sku, srcName: g.name, conf: gm.conf, qty: g.qty, cost: g.cost ?? itemBySku(gm.sku)?.cogs ?? 0 };
      }),
    };
  });
}

const isDuplicate = (l) => forecastLines().some((f) => f.month === l.month && f.campaign === String(l.campaign).trim().toUpperCase() && f.main.sku === l.main.sku && l.main.sku);

export function renderPlan() {
  const month = $('pasteMonth');
  if (!month.value) month.value = alertMonth();
  const list = state.staged;
  $('pasteWarn').replaceChildren(...state.pasteWarnings.map((w) => el('div', { text: w })));
  $('pasteWarn').hidden = state.pasteWarnings.length === 0;

  const bar = $('reviewBar'), review = $('review');
  if (!list.length) {
    bar.replaceChildren(); review.replaceChildren(el('div', { class: 'empty-state' },
      el('div', { class: 'big', text: 'Chưa có line nào chờ xác nhận' }),
      el('p', { class: 'muted', text: 'Dán dữ liệu ở trên rồi bấm "Phân tích", hoặc thêm một line thủ công.' })));
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
      state.tab = 'forecast'; state.fcMonth = payload[0].month; state.fcCampaign = ''; state.fcOnlyAlert = false; state.fcQ = '';
      toast(`Đã thêm ${payload.length} line vào Forecast`, 'ok');
      await hooks.reload({ force: true });
    } catch (e) {
      toast('Không lưu được: ' + e.message, 'error'); updateBar();
    }
  });
  bar.replaceChildren(el('div', { class: 'reviewbar' }, el('div', { class: 'rb-txt' }, count, issueTxt), el('div', { class: 'rb-act' }, clear, confirm)));
  updateBar();

  review.replaceChildren(...list.map((line) => {
    const dup = isDuplicate(line);
    return lineCard(line, {
      staged: true, note: dup ? 'Đã có line cùng tháng + campaign + sản phẩm trong Forecast' : '',
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
    const drafts = toDrafts(parsed, $('pasteMonth').value || alertMonth());
    if (drafts.length) { state.staged = [...state.staged, ...drafts]; $('paste').value = ''; }
    renderPlan();
    const bad = drafts.filter((l) => lineIssues(l).length).length;
    if (drafts.length) toast(`Đã đọc ${drafts.length} line${bad ? `, ${bad} line cần chọn lại sản phẩm` : ''}`, bad ? 'info' : 'ok');
  });
  $('manualAdd').addEventListener('click', () => { state.staged = [...state.staged, blank($('pasteMonth').value || alertMonth())]; renderPlan(); });
}
