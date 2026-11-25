// Thẻ một line Forecast: sản phẩm Main + Channel + Campaign + giá bán + SL dự kiến + cơ cấu quà tặng + CIR.
// Dùng chung cho Plan (nháp, chưa lưu) và Forecast (đã lưu, sửa trực tiếp, tự lưu).
// Bố cục: [thẻ màu theo trạng thái] → hàng nhãn (channel · campaign · tháng) → sản phẩm + ô NHẬP → ô KẾT QUẢ (tính tự động) → quà tặng.
import { el, thumb, picker, numberInput, stockChips, fmtMoney, fmtPct, fmtNum, monthLabel } from './ui.js';
import { itemBySku, evalFor, forecastLines, currentMonth } from './state.js';
import { calcLine, defaultMaxCir, CHANNELS, channelOf, isCombo, benchmarkFor, channelLabel } from './logic.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function lineIssues(line) {
  const out = [];
  if (!line.main.sku) out.push('Chưa chọn sản phẩm Main');
  if (!String(line.campaign ?? '').trim()) out.push('Thiếu Campaign Type');
  if (!MONTH.test(line.month ?? '')) out.push('Thiếu tháng');
  if (!Number.isFinite(line.price) || line.price < 0) out.push('Giá bán không hợp lệ');
  if ((line.combo ?? []).some((c) => !c.sku)) out.push('Có SKU trong combo chưa chọn');
  if (line.gifts.some((g) => !g.sku)) out.push('Có quà chưa chọn sản phẩm');
  return out;
}

// Chỉ gửi đúng các trường server nhận (bỏ trường tạm như conf, score)
export const clean = (l) => ({
  month: l.month, channel: channelOf(l), campaign: String(l.campaign).trim().toUpperCase(), price: l.price, units: l.units, actualUnits: l.actualUnits ?? null, maxCir: l.maxCir ?? null,
  main: { sku: l.main.sku, srcName: l.main.srcName ?? '', qty: Math.max(1, l.main.qty ?? 1) },
  combo: (l.combo ?? []).map((c) => ({ sku: c.sku, srcName: c.srcName ?? '', qty: Math.max(1, c.qty ?? 1) })),
  gifts: l.gifts.map((g) => ({ sku: g.sku, srcName: g.srcName ?? '', qty: g.qty, cost: g.cost })),
});

export function setLineStatus(id, text, kind = '') {
  const s = document.querySelector(`[data-id="${CSS.escape(id)}"] .lc-status`);
  if (s) { s.textContent = text; s.className = 'lc-status ' + kind; }
}

const field = (label, ...kids) => el('label', { class: 'lc-field' }, el('span', { class: 'lc-lbl', text: label }), ...kids);
// Số tiền gọn cho dải benchmark/thực tế (chi tiết đầy đủ nằm trong tooltip)
const mny = (v) => { const a = Math.abs(v), f = (x, d) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: d }).format(x);
  return a >= 1e9 ? f(v / 1e9, 2) + ' tỷ' : a >= 1e6 ? f(v / 1e6, 1) + ' tr' : fmtNum(Math.round(v)); };
const stat = (label, value, cls = '', title = '') => el('span', { class: 'st ' + cls, title }, el('i', { text: label }), value ? el('b', { text: value }) : null);
const metric = (cls, label, value, sub, title) => el('div', { class: 'mt ' + cls, title: title || '' },
  el('span', { class: 'mt-l', text: label }), el('span', { class: 'mt-v', text: value }), sub ? el('span', { class: 'mt-s', text: sub }) : null);

/**
 * opts: { staged, collapsed, onChange(line), onRemove(line), onToggle(line, collapsed), note }
 */
export function lineCard(line, opts = {}) {
  const { staged = false, collapsed = false, onChange = () => {}, onRemove = () => {}, onToggle = () => {}, note = '' } = opts;
  line.combo ??= []; line.main.qty ??= 1;
  const card = el('article', { class: 'lc' + (staged ? ' staged' : '') + (collapsed ? ' collapsed' : ''), 'data-id': line.id ?? '' });
  const rebuild = () => { const n = lineCard(line, { ...opts, collapsed: card.classList.contains('collapsed') }); card.replaceWith(n); onChange(line); };
  const changed = () => { paint(); onChange(line); };

  // --- hàng nhãn: channel · campaign · tháng ---
  const channel = el('select', { class: 'ch-sel', title: 'Channel bán hàng', 'aria-label': 'Channel' },
    ...CHANNELS.map((c) => el('option', { value: c.key, text: c.label })));
  channel.value = channelOf(line);
  const paintChannel = () => { channel.className = 'ch-sel ch-' + channel.value; };
  paintChannel();
  channel.addEventListener('change', () => { line.channel = channel.value; paintChannel(); changed(); });

  const campaign = el('input', { class: 'txt-in camp-in', list: 'campaignList', value: line.campaign ?? '', placeholder: 'Campaign (BAU…)', title: 'Campaign Type', autocomplete: 'off', 'aria-label': 'Campaign' });
  campaign.addEventListener('input', () => { line.campaign = campaign.value.toUpperCase(); changed(); });
  const month = el('input', { type: 'month', class: 'txt-in month-in', value: line.month ?? '', 'aria-label': 'Tháng áp dụng', title: 'Tháng áp dụng' });
  month.addEventListener('change', () => { if (MONTH.test(month.value)) { line.month = month.value; rebuild(); } });

  const remove = el('button', { type: 'button', class: 'btn ghost sm', text: staged ? '✕ Bỏ' : 'Xoá', title: staged ? 'Bỏ line này khỏi danh sách chờ' : 'Xoá line khỏi Forecast' });
  let armed = 0;
  remove.addEventListener('click', () => {
    if (staged || armed) return onRemove(line);
    armed = setTimeout(() => { armed = 0; remove.textContent = 'Xoá'; remove.classList.remove('danger'); }, 3000);
    remove.textContent = 'Bấm lần nữa để xoá'; remove.classList.add('danger');
  });
  const toggle = el('button', { type: 'button', class: 'btn ghost sm icon', title: 'Thu gọn / mở quà tặng', text: '▾' });
  toggle.addEventListener('click', () => { const c = card.classList.toggle('collapsed'); onToggle(line, c); });

  const comboTag = el('span', { class: 'combo-tag' });
  const top = el('div', { class: 'lc-top' },
    el('div', { class: 'lc-tags' }, channel, campaign, month, comboTag),
    el('div', { class: 'lc-actions' }, toggle, remove));

  // --- ô NHẬP ---
  const maxCir = numberInput({
    value: line.maxCir === null || line.maxCir === undefined ? null : +(line.maxCir * 100).toFixed(2), allowNull: true, decimal: true, cls: 'small', max: 100,
    title: 'Trần CIR (%): CIR = tổng giá vốn quà ÷ giá bán. Để trống = dùng mặc định theo Campaign',
    onValue: (v) => { line.maxCir = v === null ? null : v / 100; changed(); }, suffix: '%',
  });
  const dflt = defaultMaxCir(line.campaign);
  if (dflt !== null && maxCir.querySelector) maxCir.querySelector('input').placeholder = String(dflt * 100);

  const unitsIn = numberInput({ value: line.units, allowNull: true, onValue: (v) => { line.units = v; unitsIn.classList?.toggle('need', v === null); changed(); }, title: 'Số lượng Main dự kiến bán trong tháng (quà tặng tự nhân theo)', max: 1e7 });
  unitsIn.classList?.toggle('need', line.units === null);
  unitsIn.placeholder = 'Nhập SL';

  const inputs = el('div', { class: 'lc-inputs' },
    field('Giá bán (₫)', numberInput({ value: line.price, onValue: (v) => { line.price = v; changed(); } })),
    field('SL dự kiến', unitsIn),
    field('Max CIR', maxCir));

  const metrics = el('div', { class: 'lc-metrics' });

  // --- thành phần của deal: Main (× số lượng) + các SKU gộp thêm (combo) ---
  const compRow = (comp, extraIdx) => {
    const isMain = extraIdx < 0;
    const it = itemBySku(comp.sku);
    const ev = evalFor(comp.sku, line.month);
    const qty = el('div', { class: 'cq' }, field('SL / deal', numberInput({ value: comp.qty ?? 1, cls: 'small', max: 1000, title: 'Số cái SKU này trong 1 deal. Cùng 1 SKU mua nhiều: tăng số này (vd mua 2 = 2).', onValue: (v) => { comp.qty = Math.max(1, v); changed(); } })));
    const del = isMain ? el('span') : el('button', { type: 'button', class: 'btn ghost sm icon cdel', text: '✕', title: 'Bỏ SKU này khỏi combo' });
    if (!isMain) del.addEventListener('click', () => { line.combo.splice(extraIdx, 1); rebuild(); });
    return el('div', { class: 'lc-comp' + (isMain ? ' is-main' : '') },
      el('div', { class: 'lc-prod' },
        picker({
          value: comp.sku, srcName: comp.srcName, conf: comp.conf, showSrc: staged,
          placeholder: isMain ? 'Chọn sản phẩm Main…' : 'Chọn SKU thêm vào combo…',
          onPick: (p) => { comp.sku = p.sku; comp.conf = 'exact'; rebuild(); },
        }),
        el('div', { class: 'lc-chips' }, it ? stockChips(it, ev) : null)),
      qty, del);
  };
  const addComp = el('button', { type: 'button', class: 'btn sm', text: '+ Gộp thêm SKU (combo)', title: 'Gộp SKU khác vào deal, vd Nồi + Chảo. Muốn cùng 1 SKU nhiều cái thì tăng "SL / deal".' });
  addComp.addEventListener('click', () => { line.combo.push({ sku: '', srcName: '', qty: 1, conf: 'none' }); rebuild(); });
  const comps = el('div', { class: 'lc-comps' },
    el('div', { class: 'lc-lbl', text: line.combo.length || (line.main.qty ?? 1) > 1 ? 'Deal combo gồm' : 'Sản phẩm bán' }),
    compRow(line.main, -1), ...line.combo.map((c, i) => compRow(c, i)), addComp);

  const body = el('div', { class: 'lc-main' }, comps, inputs, metrics);

  // --- THỰC TẾ (chỉ line đã lưu, tháng đang chạy hoặc đã qua) ---
  const cur = currentMonth();
  const canActual = !staged && !!cur && !!line.month && line.month <= cur;
  const actualIn = numberInput({
    value: line.actualUnits ?? null, allowNull: true, max: 1e7, cls: 'small',
    title: 'Số lượng Main (số deal) thực tế đã bán trong tháng. Để trống = chưa nhập; nhập 0 = đã chạy nhưng không bán được.',
    onValue: (v) => { line.actualUnits = v; changed(); },
  });
  actualIn.placeholder = 'nhập SL';
  const actualRes = el('div', { class: 'st-row' });
  const actual = canActual ? el('div', { class: 'lc-strip lc-actual' },
    el('span', { class: 'st-lbl', title: 'Số deal Main thực tế đã bán trong tháng. Để trống = chưa nhập; nhập 0 = đã chạy nhưng không bán được.' },
      'Thực tế', el('small', { text: line.month === cur ? ' (đang chạy)' : '' })),
    actualIn, actualRes) : null;

  // --- BENCHMARK: số bán thực tế của tháng trước (staged luôn có; line đã lưu từ tháng hiện tại trở đi) ---
  const bench = staged || (!!cur && line.month >= cur) ? el('div', { class: 'lc-strip lc-bench' }) : null;

  // --- quà tặng ---
  const gifts = el('div', { class: 'lc-gifts' });
  if (line.gifts.length) {
    gifts.append(el('div', { class: 'lc-gift-head' }, el('span', { text: 'Quà tặng kèm' }), el('span', { class: 'gh-stock', text: 'Tồn' }), el('span', { class: 'gh-qty', text: 'Số lượng' }), el('span', { class: 'gh-cost', text: 'Giá vốn (₫)' }), el('span')));
  }
  line.gifts.forEach((g, i) => {
    const it = itemBySku(g.sku);
    const ev = evalFor(g.sku, line.month);
    const useCogs = it && it.cogs != null && it.cogs !== g.cost
      ? el('button', { type: 'button', class: 'link', text: `Dùng COGS Sheet (${fmtNum(it.cogs)})`, title: 'Giá vốn trong tab COGS khác giá vốn đang nhập' }) : null;
    useCogs?.addEventListener('click', () => { g.cost = it.cogs; rebuild(); });
    const del = el('button', { type: 'button', class: 'btn ghost sm icon', text: '✕', title: 'Bỏ quà này' });
    del.addEventListener('click', () => { line.gifts.splice(i, 1); rebuild(); });
    gifts.append(el('div', { class: 'lc-gift' },
      el('div', { class: 'lc-prod' },
        picker({
          value: g.sku, srcName: g.srcName, conf: g.conf, placeholder: 'Chọn sản phẩm quà…', showSrc: staged,
          onPick: (p) => { g.sku = p.sku; g.conf = 'exact'; if (p.cogs != null) g.cost = p.cogs; rebuild(); },
        })),
      el('div', { class: 'lc-chips gift-chips' }, it ? stockChips(it, ev) : null),
      el('div', { class: 'gq' }, numberInput({ value: g.qty, cls: 'small', max: 1000, onValue: (v) => { g.qty = Math.max(1, v); changed(); } })),
      el('div', { class: 'gc' }, numberInput({ value: g.cost, onValue: (v) => { g.cost = v; changed(); } }), useCogs),
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
    card.classList.remove('st-bad', 'st-good', 'st-mute');
    card.classList.add('st-' + cls);

    // CIR: thanh so với trần (vạch cuối = Max CIR)
    const bar = el('span', { class: 'cirbar ' + cls }, el('i'));
    if (c.cir !== null && c.maxCir) bar.firstChild.style.width = Math.min(100, (c.cir / c.maxCir) * 100) + '%';
    const cirSub = c.status === 'over' ? `Over +${fmtMoney(c.overAmount)}` : c.status === 'pass' ? `Pass · trần ${fmtPct(c.maxCir)}` : 'Chưa có trần';

    metrics.replaceChildren(
      metric('', 'Vốn quà', fmtMoney(c.giftCost), `${line.gifts.length} quà`, 'Σ số lượng × giá vốn của các quà trong 1 đơn Main'),
      el('div', { class: 'mt cir ' + cls, title: c.maxCir === null ? 'Chưa có Max CIR cho campaign này — nhập ở ô Max CIR' : 'CIR so với trần Max CIR ' + fmtPct(c.maxCir) },
        el('span', { class: 'mt-l', text: 'CIR' }), el('span', { class: 'mt-v', text: fmtPct(c.cir) }), bar, el('span', { class: 'mt-s', text: cirSub })),
      c.mainCogs !== null && line.price > 0
        ? metric('', '%GM', fmtPct(c.gmPct), 'trước quà', '%GM = (Giá bán − COGS cả deal) ÷ Giá bán')
        : metric('mute', '%GM', '–', line.price > 0 ? 'chưa có COGS' : 'nhập giá bán'),
      c.mainCogs !== null && line.price > 0
        ? metric(c.afterGifts < 0 ? 'bad' : '', 'Sau quà', fmtMoney(c.afterGifts), fmtPct(c.afterGiftsPct), 'Giá bán − COGS Main − vốn quà. Chưa trừ phí sàn, ads, voucher.')
        : metric('mute', 'Sau quà', '–', line.price > 0 ? '' : 'nhập giá bán'));

    paintActual(c);
    paintBench();
    comboTag.hidden = !isCombo(line);
    comboTag.textContent = line.combo.length ? `COMBO ${1 + line.combo.length} SKU` : `COMBO ×${line.main.qty}`;
    const issues = lineIssues(line);
    const notes = foot.querySelector('.lc-notes');
    const bits = [];
    if (issues.length) bits.push(el('span', { class: 'issue', text: issues.join(' · ') }));
    if (line.units === null) bits.push(el('span', { class: 'hint-inline', text: 'Chưa nhập SL dự kiến → chưa tính cảnh báo tồn và GMV' }));
    if (note) bits.push(el('span', { class: 'hint-inline warn', text: note }));
    notes.replaceChildren(...bits);
    card.classList.toggle('invalid', staged && issues.length > 0);
  }

  function paintActual(c) {
    if (!actual) return;
    const a = line.actualUnits;
    if (!Number.isInteger(a)) { actualRes.replaceChildren(el('span', { class: 'st-hint', text: 'chưa nhập — để so với KH và làm benchmark tháng sau' })); return; }
    const price = Number(line.price) || 0;
    const pct = line.units > 0 ? a / line.units : null;
    actualRes.replaceChildren(...[
      stat(pct === null ? 'chưa có KH' : '% đạt KH', pct === null ? '' : fmtPct(pct), pct !== null && pct >= 1 ? 'good' : '', pct === null ? '' : `Thực tế ${fmtNum(a)} ÷ KH ${fmtNum(line.units)} (${a - line.units >= 0 ? '+' : '−'}${fmtNum(Math.abs(a - line.units))} deal)`),
      price > 0 ? stat('GMV', mny(price * a), '', 'Ước tính: giá bán kế hoạch × SL thực tế (web chưa có giá bán thực tế)') : null,
      stat('Vốn quà', mny(c.giftCost * a), '', `${fmtNum(a)} deal × ${fmtMoney(c.giftCost)} (giả định quà phát đúng cơ cấu kế hoạch)`),
    ].filter(Boolean));
  }

  function paintBench() {
    if (!bench) return;
    const b = benchmarkFor({ ...line, channel: channelOf(line) }, forecastLines());
    const ch = channelLabel(channelOf(line));
    const head = (scope, tip) => el('span', { class: 'st-lbl', title: tip || '' }, 'Benchmark ' + (b.prev ? monthLabel(b.prev) : ''), el('small', { text: scope ? ' · ' + scope : '' }));
    bench.classList.toggle('empty', b.kind === 'none');
    if (b.kind === 'none') {
      bench.replaceChildren(head(ch), el('span', { class: 'st-hint', text: b.pending
        ? `${b.pending} line tháng trước chưa nhập SL thực tế`
        : 'chưa có dữ liệu thực tế (deal mới hoặc chưa chạy)' }));
      return;
    }
    const unit = b.kind === 'sku' ? 'cái' : 'deal';
    const scope = b.kind === 'deal' ? `cùng deal · ${b.campaigns.join(', ')}${b.sameCampaign ? '' : ' (khác campaign)'}` : 'cùng SKU, deal khác';
    const tip = b.kind === 'deal'
      ? `Số thực tế của deal giống hệt trên ${ch}${b.lines > 1 ? ` (gộp ${b.lines} line)` : ''}`
      : `Không có deal giống hệt. Tổng số cái SKU Main đã bán qua: ${b.deals.join(' · ')} (${ch})`;
    const d = line.units > 0 && b.actual > 0 ? line.units / b.actual - 1 : null;
    const use = b.kind === 'deal' && line.units !== b.actual
      ? el('button', { type: 'button', class: 'btn sm', text: `Dùng ${fmtNum(b.actual)}`, title: `Lấy ${fmtNum(b.actual)} (số bán thực tế tháng trước) làm SL dự kiến — vẫn sửa được` }) : null;
    use?.addEventListener('click', () => { line.units = b.actual; rebuild(); });
    bench.replaceChildren(...[
      head(scope, tip),
      el('span', { class: 'st-row' }, ...[
        stat('Bán', `${fmtNum(b.actual)} ${unit}`, '', tip),
        b.kind === 'deal' && b.avgPrice != null ? stat('GMV', mny(b.gmv), '', 'Ước tính: giá bán kế hoạch × SL thực tế') : null,
        b.kind === 'deal' && b.avgPrice != null ? stat('Giá TB', mny(b.avgPrice), '', 'Giá bán bình quân gia quyền theo SL thực tế') : null,
        b.pct !== null ? stat('% đạt KH', fmtPct(b.pct), b.pct >= 1 ? 'good' : '', `Tháng đó kế hoạch ${fmtNum(b.planned)} ${unit}, bán ${fmtNum(b.actual)}`) : null,
        d !== null ? stat('KH này', (d >= 0 ? '+' : '−') + fmtPct(Math.abs(d)), '', `SL dự kiến hiện tại ${fmtNum(line.units)} deal so với thực tế ${fmtNum(b.actual)} ${unit} tháng trước`) : null,
        b.pending ? el('span', { class: 'st-warn', text: `⚠ ${b.pending} chưa nhập`, title: `Còn ${b.pending} line liên quan tháng trước chưa nhập thực tế nên số này có thể thấp hơn thật` }) : null,
      ].filter(Boolean)),
      use,
    ].filter(Boolean));
  }

  card.append(top, body, ...(actual ? [actual] : []), ...(bench ? [bench] : []), gifts, foot);
  paint();
  if (!staged && line.updatedBy) status.textContent = `Cập nhật bởi ${line.updatedBy}`;
  return card;
}

export { monthLabel };
