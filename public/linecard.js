// Thẻ một line Forecast: sản phẩm Main + Campaign + giá bán + SL dự kiến + cơ cấu quà tặng + CIR.
// Dùng chung cho Plan (nháp, chưa lưu) và Forecast (đã lưu, sửa trực tiếp, tự lưu).
import { el, thumb, picker, numberInput, stockChips, fmtMoney, fmtPct, fmtNum, monthLabel } from './ui.js';
import { itemBySku, evalFor } from './state.js';
import { calcLine, defaultMaxCir } from './logic.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function lineIssues(line) {
  const out = [];
  if (!line.main.sku) out.push('Chưa chọn sản phẩm Main');
  if (!String(line.campaign ?? '').trim()) out.push('Thiếu Campaign Type');
  if (!MONTH.test(line.month ?? '')) out.push('Thiếu tháng');
  if (!Number.isFinite(line.price) || line.price < 0) out.push('Giá bán không hợp lệ');
  if (line.gifts.some((g) => !g.sku)) out.push('Có quà chưa chọn sản phẩm');
  return out;
}

// Chỉ gửi đúng các trường server nhận (bỏ trường tạm như conf, score)
export const clean = (l) => ({
  month: l.month, campaign: String(l.campaign).trim().toUpperCase(), price: l.price, units: l.units, maxCir: l.maxCir ?? null,
  main: { sku: l.main.sku, srcName: l.main.srcName ?? '' },
  gifts: l.gifts.map((g) => ({ sku: g.sku, srcName: g.srcName ?? '', qty: g.qty, cost: g.cost })),
});

export function setLineStatus(id, text, kind = '') {
  const s = document.querySelector(`[data-id="${CSS.escape(id)}"] .lc-status`);
  if (s) { s.textContent = text; s.className = 'lc-status ' + kind; }
}

const field = (label, ...kids) => el('label', { class: 'lc-field' }, el('span', { class: 'lc-lbl', text: label }), ...kids);

/**
 * opts: { staged, collapsed, onChange(line), onRemove(line), onToggle(line, collapsed), note }
 */
export function lineCard(line, opts = {}) {
  const { staged = false, collapsed = false, onChange = () => {}, onRemove = () => {}, onToggle = () => {}, note = '' } = opts;
  const card = el('article', { class: 'lc' + (staged ? ' staged' : '') + (collapsed ? ' collapsed' : ''), 'data-id': line.id ?? '' });
  const rebuild = () => { const n = lineCard(line, { ...opts, collapsed: card.classList.contains('collapsed') }); card.replaceWith(n); onChange(line); };
  const changed = () => { paint(); onChange(line); };

  const mainItem = itemBySku(line.main.sku);
  const mainEv = evalFor(line.main.sku, line.month);

  // --- tiêu đề ---
  const campaign = el('input', { class: 'txt-in', list: 'campaignList', value: line.campaign ?? '', placeholder: 'BAU…', title: 'Campaign Type', autocomplete: 'off' });
  campaign.addEventListener('input', () => { line.campaign = campaign.value.toUpperCase(); changed(); });
  const month = el('input', { type: 'month', class: 'txt-in', value: line.month ?? '' });
  month.addEventListener('change', () => { if (MONTH.test(month.value)) { line.month = month.value; rebuild(); } });
  const maxCir = numberInput({
    value: line.maxCir === null || line.maxCir === undefined ? null : +(line.maxCir * 100).toFixed(2), allowNull: true, decimal: true, cls: 'small', max: 100,
    title: 'Trần CIR (%): CIR = tổng giá vốn quà ÷ giá bán. Để trống = dùng mặc định theo Campaign',
    onValue: (v) => { line.maxCir = v === null ? null : v / 100; changed(); }, suffix: '%',
  });
  const dflt = defaultMaxCir(line.campaign);
  if (dflt !== null && maxCir.querySelector) maxCir.querySelector('input').placeholder = String(dflt * 100);

  const unitsIn = numberInput({ value: line.units, allowNull: true, onValue: (v) => { line.units = v; changed(); }, title: 'Số lượng Main dự kiến bán trong tháng (quà tặng tự nhân theo)', max: 1e7 });
  unitsIn.classList?.toggle('need', line.units === null);

  const sum = el('div', { class: 'lc-sum' });
  const remove = el('button', { type: 'button', class: 'btn ghost sm', text: staged ? '✕ Bỏ' : 'Xoá', title: staged ? 'Bỏ line này khỏi danh sách chờ' : 'Xoá line khỏi Forecast' });
  let armed = 0;
  remove.addEventListener('click', () => {
    if (staged || armed) return onRemove(line);
    armed = setTimeout(() => { armed = 0; remove.textContent = 'Xoá'; remove.classList.remove('danger'); }, 3000);
    remove.textContent = 'Bấm lần nữa để xoá'; remove.classList.add('danger');
  });
  const toggle = el('button', { type: 'button', class: 'btn ghost sm icon', title: 'Thu gọn / mở quà tặng', text: '▾' });
  toggle.addEventListener('click', () => { const c = card.classList.toggle('collapsed'); onToggle(line, c); });

  const head = el('div', { class: 'lc-head' },
    el('div', { class: 'lc-prod' },
      picker({
        value: line.main.sku, srcName: line.main.srcName, conf: line.main.conf,
        onPick: (it) => { line.main.sku = it.sku; line.main.conf = 'exact'; rebuild(); }, placeholder: 'Chọn sản phẩm Main…', showSrc: staged,
      }),
      el('div', { class: 'lc-chips' }, mainItem ? stockChips(mainItem, mainEv) : null)),
    field('Campaign', campaign),
    field('Giá bán (₫)', numberInput({ value: line.price, onValue: (v) => { line.price = v; changed(); } })),
    field('SL dự kiến', unitsIn),
    field('Tháng', month),
    field('Max CIR', maxCir),
    el('div', { class: 'lc-actions' }, toggle, remove),
    sum);

  // --- quà tặng ---
  const gifts = el('div', { class: 'lc-gifts' });
  line.gifts.forEach((g, i) => {
    const it = itemBySku(g.sku);
    const ev = evalFor(g.sku, line.month);
    const useCogs = it && it.cogs != null && it.cogs !== g.cost
      ? el('button', { type: 'button', class: 'link', text: `Dùng COGS Sheet (${fmtNum(it.cogs)})`, title: 'Giá vốn trong tab COGS khác giá vốn đang nhập' }) : null;
    useCogs?.addEventListener('click', () => { g.cost = it.cogs; rebuild(); });
    const del = el('button', { type: 'button', class: 'btn ghost sm icon', text: '✕', title: 'Bỏ quà này' });
    del.addEventListener('click', () => { line.gifts.splice(i, 1); rebuild(); });
    gifts.append(el('div', { class: 'lc-gift' },
      el('span', { class: 'arrow', text: '↳' }),
      el('div', { class: 'lc-prod' },
        picker({
          value: g.sku, srcName: g.srcName, conf: g.conf, placeholder: 'Chọn sản phẩm quà…', showSrc: staged,
          onPick: (p) => { g.sku = p.sku; g.conf = 'exact'; if (p.cogs != null) g.cost = p.cogs; rebuild(); },
        })),
      el('div', { class: 'lc-chips gift-chips' }, it ? stockChips(it, ev) : null),
      field('Số lượng', numberInput({ value: g.qty, cls: 'small', max: 1000, onValue: (v) => { g.qty = Math.max(1, v); changed(); } })),
      field('Giá vốn (₫)', numberInput({ value: g.cost, onValue: (v) => { g.cost = v; changed(); } }), useCogs),
      del));
  });
  const add = el('button', { type: 'button', class: 'btn sm', text: '+ Thêm quà' });
  add.addEventListener('click', () => { line.gifts.push({ sku: '', srcName: '', qty: 1, cost: 0, conf: 'none' }); rebuild(); });
  gifts.append(el('div', { class: 'lc-gift-add' }, add));

  // --- chân thẻ ---
  const status = el('span', { class: 'lc-status' });
  const foot = el('div', { class: 'lc-foot' }, status, el('span', { class: 'lc-notes' }));

  function paint() {
    const c = calcLine(line, itemBySku);
    const cls = c.status === 'over' ? 'bad' : c.status === 'pass' ? 'good' : 'mute';
    sum.replaceChildren(
      el('div', { class: 'sum-row' }, el('b', { text: `${line.gifts.length} quà` }), ' | Vốn quà ', el('b', { text: fmtMoney(c.giftCost) })),
      el('div', { class: 'sum-row' }, 'CIR ', el('b', { text: fmtPct(c.cir) }),
        el('span', { class: 'badge ' + cls, title: c.maxCir === null ? 'Chưa có Max CIR cho campaign này — nhập ở ô Max CIR' : 'CIR so với trần Max CIR ' + fmtPct(c.maxCir) },
          c.status === 'over' ? `Over +${fmtMoney(c.overAmount)}` : c.status === 'pass' ? `Pass (≤ ${fmtPct(c.maxCir)})` : 'Chưa có Max CIR')),
      c.mainCogs !== null
        ? el('div', { class: 'sum-row mute', title: 'Biên gộp = (Giá bán − COGS Main) ÷ Giá bán. Lãi sau quà chưa trừ phí sàn, ads, voucher.' },
          'Biên gộp ', el('b', { text: fmtPct(c.gmPct) }), ' · Sau quà ', el('b', { class: c.afterGifts < 0 ? 'neg' : '', text: fmtMoney(c.afterGifts) }), ` (${fmtPct(c.afterGiftsPct)})`)
        : el('div', { class: 'sum-row mute', text: 'Chưa có COGS Main để tính biên gộp' }));
    const issues = lineIssues(line);
    const notes = foot.querySelector('.lc-notes');
    const bits = [];
    if (issues.length) bits.push(el('span', { class: 'issue', text: issues.join(' · ') }));
    if (line.units === null) bits.push(el('span', { class: 'hint-inline', text: 'Chưa nhập SL dự kiến → chưa tính cảnh báo tồn' }));
    if (note) bits.push(el('span', { class: 'hint-inline warn', text: note }));
    notes.replaceChildren(...bits);
    card.classList.toggle('invalid', staged && issues.length > 0);
  }

  card.append(head, gifts, foot);
  paint();
  if (!staged && line.updatedBy) status.textContent = `Cập nhật bởi ${line.updatedBy}`;
  return card;
}

export { monthLabel };
