import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, verify } from 'node:crypto';

import { signSession, verifySession, readCookie, COOKIE_NAME } from '../lib/session.mjs';
import authStart from '../netlify/functions/auth-start.mjs';
import authCallback from '../netlify/functions/auth-callback.mjs';
import { allowedEmails } from '../lib/env.mjs';
import { safeNext, STATE_COOKIE } from '../lib/oauth.mjs';
import { verifyData } from '../lib/session.mjs';
import stock from '../netlify/functions/stock.mjs';
import refresh from '../netlify/functions/refresh.mjs';
import { parseSheet, parseNumber, SheetFormatError } from '../lib/sheet.mjs';
import { nextMonthKey, currentMonthKey, evaluate, planRules, withPlanView } from '../lib/plan.mjs';
import { applyOp, getForecast, sanitizeLine, demandByMonth, ForecastError } from '../lib/forecast.mjs';
import forecastFn from '../netlify/functions/forecast.mjs';
import * as L from '../public/logic.js';
import * as X from '../public/xlsx.js';
import * as E from '../public/export.js';
import { sheetConfig, fetchSheetValues, ConfigError, GoogleError } from '../lib/google.mjs';
import { getData } from '../lib/refresh.mjs';
import gate, { config as gateConfig } from '../netlify/edge-functions/gate.mjs';

const SECRET = 'x'.repeat(48);
const BASE = 'https://stock.example.netlify.app';

class MemoryStore {
  constructor() { this.m = new Map(); this.n = 0; }
  async get(k) { const e = this.m.get(k); return e ? structuredClone(e.v) : null; }
  async getWithMetadata(k) { const e = this.m.get(k); return e ? { data: structuredClone(e.v), etag: e.etag, metadata: {} } : null; }
  async setJSON(k, v, o = {}) {
    const e = this.m.get(k);
    if (o.onlyIfNew && e) return { modified: false };
    if (o.onlyIfMatch !== undefined && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = 'e' + ++this.n;
    this.m.set(k, { v: structuredClone(v), etag });
    return { modified: true, etag };
  }
  async delete(k) { this.m.delete(k); }
}

beforeEach(() => {
  globalThis.__TEST_STORE__ = new MemoryStore();
  process.env.SESSION_SECRET = SECRET;
  process.env.ALLOWED_EMAILS = 'A@Example.com';
});


// ---------- session ----------
test('session: ký/kiểm tra, chống sửa, hết hạn, sai secret', async () => {
  const t = await signSession('a@example.com', SECRET, 60, 1_000_000);
  assert.deepEqual(await verifySession(t, SECRET, 1_000_000 + 30_000), { email: 'a@example.com', exp: 1060 });
  assert.equal(await verifySession(t, SECRET, 1_000_000 + 61_000), null, 'hết hạn');
  assert.equal(await verifySession(t, 'z'.repeat(48), 1_000_000), null, 'sai secret');
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'evil@x.com', exp: 9999999999 })).toString('base64url');
  assert.equal(await verifySession(`${forged}.${s}`, SECRET, 1_000_000), null, 'payload bị sửa');
  assert.equal(await verifySession(`${p}.`, SECRET), null);
  assert.equal(await verifySession('rác', SECRET), null);
  assert.equal(readCookie('a=1; bm_session=abc; b=2', 'bm_session'), 'abc');
});

// ---------- gate (edge) ----------
const ctx = { next: async () => new Response('PAGE') };
const gReq = (path, cookie) => new Request(BASE + path, { headers: cookie ? { cookie } : {} });

test('gate: chưa đăng nhập -> trang chuyển về login, API trả 401', async () => {
  const page = await gate(gReq('/'), ctx);
  assert.equal(page.status, 302); assert.match(page.headers.get('location'), /^\/login\.html\?next=%2F$/);
  const api = await gate(gReq('/api/stock'), ctx);
  assert.equal(api.status, 401);
});

test('gate: cookie hợp lệ qua cổng; cookie của người đã bị xoá khỏi ALLOWED_EMAILS thì không', async () => {
  const token = await signSession('a@example.com', SECRET);
  const ok = await gate(gReq('/', `${COOKIE_NAME}=${token}`), ctx);
  assert.equal(await ok.text(), 'PAGE');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  process.env.ALLOWED_EMAILS = '';
  assert.equal((await gate(gReq('/', `${COOKIE_NAME}=${token}`), ctx)).status, 302);
});

test('gate: cookie ký bằng secret khác / thiếu secret (fail closed)', async () => {
  const forged = await signSession('a@example.com', 'q'.repeat(48));
  assert.equal((await gate(gReq('/', `${COOKIE_NAME}=${forged}`), ctx)).status, 302);
  delete process.env.SESSION_SECRET;
  assert.equal((await gate(gReq('/'), ctx)).status, 500);
});

test('gate: danh sách path được miễn đúng như thiết kế', () => {
  assert.equal(gateConfig.path, '/*');
  assert.deepEqual(gateConfig.excludedPath.sort(), ['/api/auth/callback', '/api/auth/start', '/favicon.svg', '/fonts/*', '/login.html', '/login.js', '/style.css']);
});


// ================= Google Sheet: parser =================
const HEADER = ['Link Ảnh', 'Master SKU', 'Product Name', 'Short Name', 'TYPE', 'Category', 'COGS', 'Boxme Bắc', 'Boxme Nam', 'Total Stock_BM', 'Status Boxme_Bắc', 'Status Boxme_Nam'];
const FIXTURE = () => [
  ['Inochi BMT - Pricing Frame'],
  HEADER,
  ['https://img.example/a.jpg', 'SKU-A', 'Sản phẩm A đầy đủ', 'SP A', 'Main', 'Khăn', 55000, 120, 0, 120, 'On', 'Hết hàng'],
  ['http://img.example/b.jpg', 'SKU-B', 'Sản phẩm B', '', 'Other', 'Phụ kiện', '1,500,000', '#N/A', '', '', '', ''],
  ['', '', 'dòng ghi chú không có SKU'],
  ['https://img.example/c.jpg', '=SKU-C', 'Sản phẩm C', 'SP C', 'Combo', 'Khăn', 9000, '15', 4, '', 'Cần nhập', 'Cần nhập'],
];

test('sheet: nhận dòng tiêu đề không ở dòng 1, đọc cột theo tên, bỏ dòng không có SKU', () => {
  const r = parseSheet(FIXTURE());
  assert.deepEqual(r.items.map((i) => i.sku), ['SKU-A', 'SKU-B', '=SKU-C']);
  assert.equal(r.hasCost, false);
});

test('sheet: 0 khác trống/#N/A; tổng tự cộng khi ô Total trống; chuỗi số được parse', () => {
  const [a, b, c] = parseSheet(FIXTURE()).items;
  assert.equal(a.south, 0);
  assert.equal(b.north, null);
  assert.equal(b.south, null);
  assert.equal(b.total, null);
  assert.equal(c.north, 15);
  assert.equal(c.total, 19);
  assert.equal(parseNumber('1,500,000'), 1500000);
  assert.equal(parseNumber('abc'), null);
});

test('sheet: ảnh http bị loại, ảnh https giữ; COGS chỉ có khi includeCost', () => {
  const off = parseSheet(FIXTURE()).items;
  assert.equal(off[0].image, 'https://img.example/a.jpg');
  assert.equal(off[1].image, null);
  assert.equal('cogs' in off[0], false);
  const on = parseSheet(FIXTURE(), { includeCost: true });
  assert.equal(on.hasCost, true);
  assert.equal(on.items[0].cogs, 55000);
});

test('sheet: bỏ qua cột Status (không còn dùng), vẫn đọc đúng các cột còn lại', () => {
  const [a] = parseSheet(FIXTURE()).items;
  assert.equal('northStatus' in a, false);
  assert.equal(a.north, 120);
});

test('sheet: thiếu cột bắt buộc / không có tiêu đề / không có dòng nào -> lỗi rõ ràng', () => {
  assert.throws(() => parseSheet([['x'], ['y']]), SheetFormatError);
  assert.throws(() => parseSheet([['Master SKU', 'TYPE', 'Boxme Bắc']]), /Boxme Nam/);
  assert.throws(() => parseSheet([HEADER]), /Không có dòng sản phẩm/);
});

test('sheet: đổi thứ tự cột vẫn đọc đúng; thiếu cột tuỳ chọn -> cảnh báo', () => {
  const r = parseSheet([['Boxme Nam', 'TYPE', 'Master SKU', 'Boxme Bắc'], [7, 'Main', 'Z', 3]]);
  assert.equal(r.items[0].south, 7);
  assert.equal(r.items[0].north, 3);
  assert.ok(r.warnings.length > 0);
});

// ================= Google client + refresh với Google giả =================
function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = 'reader@proj.iam.gserviceaccount.com';

async function startGoogle() {
  const m = { tokenCalls: 0, sheetCalls: 0, jwt: null, lastUrl: '', sheetStatus: 200, values: FIXTURE() };
  const t = await listen(async (req, res) => {
    m.tokenCalls++;
    const p = new URLSearchParams(await readBody(req));
    m.grant = p.get('grant_type');
    const [h, c, s] = (p.get('assertion') ?? '').split('.');
    m.jwt = { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) };
    m.sigOk = verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: 'tok-' + m.tokenCalls, expires_in: 3600 }));
  });
  const s = await listen((req, res) => {
    m.sheetCalls++;
    m.lastUrl = req.url;
    m.auth = req.headers.authorization;
    res.statusCode = m.sheetStatus;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(m.sheetStatus === 200 ? { values: m.values } : { error: { message: 'The caller does not have permission' } }));
  });
  m.token = t; m.sheets = s;
  m.close = () => { t.srv.close(); s.srv.close(); };
  return m;
}

function useGoogle(m, extra = {}) {
  Object.assign(process.env, {
    SHEET_ID: 'SHEET123', SHEET_TAB: 'COGS', GOOGLE_CLIENT_EMAIL: SA,
    GOOGLE_PRIVATE_KEY: PRIV_PEM.replace(/\n/g, '\\n'), // dạng dán 1 dòng trên Netlify
    GOOGLE_TOKEN_URL: m.token.url, GOOGLE_SHEETS_BASE: m.sheets.url,
    ...extra,
  });
}
afterEach(() => {
  for (const k of ['PLAN_TAB', 'PLAN_BUFFER_PCT', 'PLAN_SOUTH_SHARE_PCT', 'SHEET_ID', 'SHEET_TAB', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_TOKEN_URL', 'GOOGLE_SHEETS_BASE', 'INCLUDE_COST', 'REFRESH_AFTER_SEC', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) delete process.env[k];
});

test('google: JWT RS256 ký đúng, đúng scope readonly; request values đúng path/tham số', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    const rows = await fetchSheetValues(sheetConfig());
    assert.equal(rows.length, FIXTURE().length);
    assert.equal(m.sigOk, true);
    assert.equal(m.grant, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(m.jwt.header.alg, 'RS256');
    assert.equal(m.jwt.claims.iss, SA);
    assert.equal(m.jwt.claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
    assert.match(m.lastUrl, /^\/v4\/spreadsheets\/SHEET123\/values\/'COGS'!A%3AZ\?|^\/v4\/spreadsheets\/SHEET123\/values\/%27COGS%27!A%3AZ\?/);
    assert.match(m.lastUrl, /valueRenderOption=UNFORMATTED_VALUE/);
    assert.match(m.auth, /^Bearer tok-/);
  } finally { m.close(); }
});

test('google: 403 -> thông báo gợi ý share Sheet cho service account', async () => {
  const m = await startGoogle(); useGoogle(m); m.sheetStatus = 403;
  try {
    await assert.rejects(fetchSheetValues(sheetConfig()), (e) => e instanceof GoogleError && e.message.includes(SA));
  } finally { m.close(); }
});

test('google: thiếu biến môi trường -> ConfigError nêu tên biến', () => {
  assert.throws(() => sheetConfig(), (e) => e instanceof ConfigError && /SHEET_ID/.test(e.message));
});

test('refresh: lần đầu đọc Sheet; trong TTL không đọc lại; hết TTL đọc lại', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    const t0 = 1_800_000_000_000;
    const a = await getData({ nowMs: t0 });
    assert.equal(a.refreshed, true);
    assert.equal(a.snapshot.items.length, 3);
    assert.equal(a.snapshot.source, 'google-sheet');
    const calls = m.sheetCalls;
    const b = await getData({ nowMs: t0 + 120_000 });
    assert.equal(b.refreshed, false);
    assert.equal(m.sheetCalls, calls);
    const c = await getData({ nowMs: t0 + 301_000 });
    assert.equal(c.refreshed, true);
    assert.equal(m.sheetCalls, calls + 1);
  } finally { m.close(); }
});

test('refresh: force bị cooldown 15 giây; sau 15 giây thì được', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    const t0 = 1_800_000_000_000;
    await getData({ nowMs: t0 });
    const n = m.sheetCalls;
    assert.equal((await getData({ force: true, nowMs: t0 + 5_000 })).refreshed, false);
    assert.equal(m.sheetCalls, n);
    assert.equal((await getData({ force: true, nowMs: t0 + 16_000 })).refreshed, true);
  } finally { m.close(); }
});

test('refresh: Google lỗi -> giữ snapshot cũ, ghi lastError; có lại thì xoá lỗi', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    const t0 = 1_800_000_000_000;
    await getData({ nowMs: t0 });
    m.sheetStatus = 403;
    const bad = await getData({ nowMs: t0 + 400_000 });
    assert.equal(bad.refreshed, false);
    assert.equal(bad.snapshot.items.length, 3);
    assert.equal(bad.snapshot.generatedAt, Math.floor(t0 / 1000));
    assert.match(bad.status.lastError.message, /403/);
    m.sheetStatus = 200;
    const ok = await getData({ nowMs: t0 + 500_000 });
    assert.equal(ok.refreshed, true);
    assert.equal(ok.status.lastError, null);
  } finally { m.close(); }
});

test('refresh: Sheet đổi cấu trúc (mất cột bắt buộc) -> không ghi đè snapshot tốt', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    const t0 = 1_800_000_000_000;
    await getData({ nowMs: t0 });
    m.values = [['Master SKU', 'TYPE'], ['X', 'Main']];
    const r = await getData({ nowMs: t0 + 400_000 });
    assert.equal(r.snapshot.items.length, 3);
    assert.match(r.status.lastError.message, /Thiếu cột/);
  } finally { m.close(); }
});

test('refresh: chưa cấu hình -> không có snapshot, lastError nói rõ thiếu biến', async () => {
  const r = await getData({ nowMs: 1_800_000_000_000 });
  assert.equal(r.snapshot, null);
  assert.match(r.status.lastError.message, /SHEET_ID/);
});

// ================= API end-to-end =================
const authed = async (path, init = {}) => {
  const token = await signSession('a@example.com', SECRET);
  return new Request(BASE + path, { ...init, headers: { cookie: `${COOKIE_NAME}=${token}`, ...(init.headers ?? {}) } });
};

test('stock API: cần cookie; lần đầu tự đọc Sheet; INCLUDE_COST=false thì không lộ COGS', async () => {
  const m = await startGoogle(); useGoogle(m, { INCLUDE_COST: 'false' });
  try {
    assert.equal((await stock(new Request(BASE + '/api/stock'))).status, 401);
    assert.equal(m.sheetCalls, 0, 'không đăng nhập thì không được kích hoạt đọc Sheet');
    const res = await stock(await authed('/api/stock'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = await res.json();
    assert.equal(body.user, 'a@example.com');
    assert.equal(body.snapshot.items[0].sku, 'SKU-A');
    assert.equal(JSON.stringify(body).includes('55000'), false);
    assert.equal(body.snapshot.hasCost, false);
  } finally { m.close(); }
});

test('stock API: mặc định HIỆN cogs (không cần đặt INCLUDE_COST)', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    const body = await (await stock(await authed('/api/stock'))).json();
    assert.equal(body.snapshot.hasCost, true);
    assert.equal(body.snapshot.items[0].cogs, 55000);
  } finally { m.close(); }
});

test('refresh API: chỉ POST, cần cookie, chặn Origin lạ, bị cooldown ngay sau lần đọc đầu', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    assert.equal((await refresh(new Request(BASE + '/api/refresh'))).status, 405);
    assert.equal((await refresh(new Request(BASE + '/api/refresh', { method: 'POST' }))).status, 401);
    assert.equal((await refresh(await authed('/api/refresh', { method: 'POST', headers: { origin: 'https://evil.example' } }))).status, 403);
    assert.equal(m.sheetCalls, 0);
    await stock(await authed('/api/stock'));
    const n = m.sheetCalls;
    const res = await refresh(await authed('/api/refresh', { method: 'POST', headers: { origin: BASE } }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).refreshed, false);
    assert.equal(m.sheetCalls, n);
  } finally { m.close(); }
});

test('stock API: người đã bị xoá khỏi ALLOWED_EMAILS bị từ chối dù cookie còn hạn', async () => {
  const req = await authed('/api/stock');
  process.env.ALLOWED_EMAILS = 'other@example.com';
  assert.equal((await stock(req)).status, 401);
});


// ================= Forecast (nhập trên web, lưu Netlify Blobs) =================
const ITEMS = [
  { sku: 'SKU-A', name: 'Sản phẩm A đầy đủ', shortName: 'SP A', north: 120, south: 0, total: 120, cogs: 55000 },
  { sku: 'GIFT-1', name: 'Khăn tặng nhỏ', shortName: '', north: 10, south: 90, total: 100, cogs: 5000 },
];
const seedSnapshot = async (items = ITEMS) => globalThis.__TEST_STORE__.setJSON('snapshot', { generatedAt: 1, tab: 'COGS', items });
const line = (o = {}) => ({
  month: '2026-12', campaign: 'bau', main: { sku: 'SKU-A', srcName: 'Sản phẩm A' }, price: 1000000, units: 100, maxCir: 0.04,
  gifts: [{ sku: 'GIFT-1', srcName: 'Khăn', qty: 2, cost: 5000 }], ...o,
});
const rejects = (p, status) => assert.rejects(p, (e) => e instanceof ForecastError && (status === undefined || e.status === status));

test('forecast: thêm/sửa/xoá; campaign viết hoa; rev tăng; dữ liệu lưu bền', async () => {
  await seedSnapshot();
  const { created, rev } = await applyOp({ op: 'add', lines: [line()] }, 'a@example.com');
  assert.equal(created.length, 1); assert.equal(rev, 1);
  let f = await getForecast();
  assert.equal(f.lines[0].campaign, 'BAU');
  assert.equal(f.lines[0].rev, 1);
  assert.equal(f.lines[0].createdBy, 'a@example.com');

  const up = await applyOp({ op: 'update', id: created[0], rev: 1, line: line({ price: 1200000, gifts: [] }) }, 'b@example.com');
  assert.equal(up.lineRev, 2);
  f = await getForecast();
  assert.equal(f.lines[0].price, 1200000);
  assert.equal(f.lines[0].gifts.length, 0);
  assert.equal(f.lines[0].createdBy, 'a@example.com', 'giữ người tạo');
  assert.equal(f.lines[0].updatedBy, 'b@example.com');

  assert.deepEqual((await applyOp({ op: 'delete', id: created[0] }, 'a')).deleted, 1);
  assert.deepEqual((await applyOp({ op: 'delete', id: created[0] }, 'a')).deleted, 0, 'xoá lặp lại không lỗi');
  assert.equal((await getForecast()).lines.length, 0);
});

test('forecast: sửa dòng đã bị người khác sửa -> 409; dòng không tồn tại -> 404', async () => {
  await seedSnapshot();
  const { created } = await applyOp({ op: 'add', lines: [line()] }, 'a');
  await applyOp({ op: 'update', id: created[0], rev: 1, line: line({ units: 5 }) }, 'a');
  await rejects(applyOp({ op: 'update', id: created[0], rev: 1, line: line({ units: 9 }) }, 'b'), 409);
  assert.equal((await getForecast()).lines[0].units, 5, 'bản cũ không ghi đè');
  await rejects(applyOp({ op: 'update', id: 'khong-co', rev: 1, line: line() }, 'a'), 404);
});

test('forecast: kiểm tra dữ liệu đầu vào', async () => {
  await seedSnapshot();
  const bad = [
    line({ month: '2026-13' }), line({ month: '12/2026' }), line({ campaign: '  ' }), line({ main: { sku: '' } }),
    line({ price: -1 }), line({ price: 'abc' }), line({ units: 1.5 }), line({ units: -3 }), line({ maxCir: 1.5 }),
    line({ gifts: [{ sku: 'GIFT-1', qty: 0, cost: 1 }] }), line({ gifts: [{ sku: '', qty: 1, cost: 1 }] }),
    line({ gifts: Array.from({ length: 31 }, () => ({ sku: 'GIFT-1', qty: 1, cost: 1 })) }),
    line({ main: { sku: 'KHONG-CO' } }), line({ gifts: [{ sku: 'KHONG-CO', qty: 1, cost: 1 }] }),
  ];
  for (const b of bad) await rejects(applyOp({ op: 'add', lines: [b] }, 'a'), 400);
  await rejects(applyOp({ op: 'add', lines: [] }, 'a'), 400);
  await rejects(applyOp({ op: 'add', lines: Array.from({ length: 201 }, () => line()) }, 'a'), 400);
  await rejects(applyOp({ op: 'xoa' }, 'a'), 400);
  await rejects(applyOp(null, 'a'), 400);
  assert.equal((await getForecast()).lines.length, 0, 'một dòng sai thì không dòng nào được lưu');
  // units/maxCir có thể để trống
  await applyOp({ op: 'add', lines: [line({ units: null, maxCir: null })] }, 'a');
  const [l] = (await getForecast()).lines;
  assert.equal(l.units, null); assert.equal(l.maxCir, null);
});

test('forecast: chỉ giữ trường cho phép (không cho đẩy trường lạ vào kho)', async () => {
  await seedSnapshot();
  await applyOp({ op: 'add', lines: [{ ...line(), id: 'tu-dat', rev: 99, createdBy: 'hacker', __proto__x: 1, extra: '<script>' }] }, 'a');
  const [l] = (await getForecast()).lines;
  assert.notEqual(l.id, 'tu-dat'); assert.equal(l.rev, 1); assert.equal(l.createdBy, 'a'); assert.equal(l.extra, undefined);
});

test('forecast: SKU đã có sẵn trong dòng vẫn sửa được dù đã biến mất khỏi Sheet', async () => {
  await seedSnapshot();
  const { created } = await applyOp({ op: 'add', lines: [line()] }, 'a');
  await seedSnapshot([ITEMS[0]]); // GIFT-1 không còn trong Sheet
  await applyOp({ op: 'update', id: created[0], rev: 1, line: line({ price: 1 }) }, 'a');
  await rejects(applyOp({ op: 'update', id: created[0], rev: 2, line: line({ gifts: [{ sku: 'GIFT-2', qty: 1, cost: 1 }] }) }, 'a'), 400);
});

test('forecast: nhiều người thêm cùng lúc không mất dòng nào (compare-and-set + retry)', async () => {
  await seedSnapshot();
  await Promise.all(Array.from({ length: 12 }, (_, i) => applyOp({ op: 'add', lines: [line({ units: i + 1 })] }, `u${i}@x.com`)));
  const f = await getForecast();
  assert.equal(f.lines.length, 12);
  assert.equal(new Set(f.lines.map((l) => l.id)).size, 12);
  assert.equal(f.rev, 12);
});

test('forecast: demandByMonth cộng Main + quà (units × qty); bỏ dòng chưa có SL', () => {
  const d = demandByMonth([
    line(), line({ units: 50, gifts: [{ sku: 'GIFT-1', qty: 3, cost: 1 }] }), line({ units: null }), line({ units: 0 }),
    line({ month: '2027-01', units: 10, main: { sku: 'GIFT-1' }, gifts: [] }),
  ].map((l) => ({ ...l, campaign: 'BAU' })));
  assert.deepEqual(d['2026-12']['SKU-A'], { main: 150, gift: 0 });
  assert.deepEqual(d['2026-12']['GIFT-1'], { main: 0, gift: 100 * 2 + 50 * 3 });
  assert.deepEqual(d['2027-01']['GIFT-1'], { main: 10, gift: 0 });
});

test('plan: nextMonthKey theo giờ VN (UTC+7), qua năm', () => {
  assert.equal(nextMonthKey(Date.UTC(2026, 10, 10)), '2026-12');
  assert.equal(nextMonthKey(Date.UTC(2026, 11, 15)), '2027-01');
  assert.equal(nextMonthKey(Date.UTC(2026, 10, 30, 17, 30)), '2027-01', '00:30 ngày 1/12 giờ VN đã là tháng 12');
});

test('plan: evaluate — out / short / south / tight / ok / nodata / none', () => {
  const rules = { bufferPct: 20, southSharePct: 70 };
  const ev = (n, s, q) => evaluate({ north: n, south: s, total: n + s }, q, rules);
  assert.equal(ev(0, 0, 100).level, 'out');
  assert.equal(ev(30, 40, 100).level, 'short');
  assert.equal(ev(100, 0, 100).level, 'south');          // đủ tổng nhưng Nam < 70
  assert.equal(ev(100, 0, 100).gapSouth, 70);
  assert.equal(ev(100, 0, 100).transferable, 70);        // Bắc dư 100-30=70
  assert.equal(ev(20, 90, 100).level, 'tight');          // 110 < 120
  assert.equal(ev(50, 90, 100).level, 'ok');
  assert.equal(evaluate({ north: null, south: null, total: null }, 10, rules).level, 'nodata');
  assert.equal(ev(5, 5, 0).level, 'none');
  assert.equal(evaluate({ north: 0, south: 0, total: 0 }, 101, { bufferPct: 0, southSharePct: 70 }).needSouth, 71, 'làm tròn lên');
});

test('plan: planRules đọc env, kẹp giá trị, giá trị rác -> mặc định', () => {
  assert.deepEqual(planRules(() => undefined), { bufferPct: 20, southSharePct: 70 });
  assert.deepEqual(planRules((k) => ({ PLAN_BUFFER_PCT: '10', PLAN_SOUTH_SHARE_PCT: '55' })[k]), { bufferPct: 10, southSharePct: 55 });
  assert.equal(planRules((k) => (k === 'PLAN_SOUTH_SHARE_PCT' ? '999' : undefined)).southSharePct, 100);
  assert.equal(planRules((k) => (k === 'PLAN_SOUTH_SHARE_PCT' ? 'abc' : undefined)).southSharePct, 70);
});

test('plan: withPlanView gắn đánh giá theo tháng/SKU, quà tặng tính vào nhu cầu', () => {
  const data = { snapshot: { items: ITEMS } };
  const forecast = { rev: 1, lines: [{ ...line(), campaign: 'BAU', id: 'x', rev: 1 }] };
  const v = withPlanView(data, forecast, Date.UTC(2026, 10, 10), () => undefined);
  assert.equal(v.alertMonth, '2026-12');
  assert.deepEqual(v.plan.months, ['2026-12']);
  const a = v.plan.evaluations['2026-12']['SKU-A'];
  assert.equal(a.main, 100); assert.equal(a.level, 'south'); // Nam = 0
  const g = v.plan.evaluations['2026-12']['GIFT-1'];
  assert.equal(g.gift, 200); assert.equal(g.level, 'short'); // tồn 100 < nhu cầu quà 200
});

// ---------- /api/forecast ----------
test('forecast API: cần đăng nhập, chỉ POST, chặn Origin lạ, JSON hỏng, body quá lớn, lỗi nghiệp vụ trả đúng mã', async () => {
  await seedSnapshot();
  const call = async (body, init = {}) => forecastFn(await authed('/api/forecast', { method: 'POST', headers: { origin: BASE }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init }));
  assert.equal((await forecastFn(new Request(BASE + '/api/forecast', { method: 'POST', body: '{}' }))).status, 401);
  assert.equal((await forecastFn(await authed('/api/forecast'))).status, 405);
  assert.equal((await call({ op: 'add', lines: [line()] }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('{hỏng')).status, 400);
  assert.equal((await call('x'.repeat(1_000_001))).status, 413);
  const bad = await call({ op: 'add', lines: [line({ price: -5 })] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /Giá bán/);
  const ok = await call({ op: 'add', lines: [line()] });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true); assert.equal(body.created.length, 1);
  assert.equal((await getForecast()).lines[0].createdBy, 'a@example.com', 'người ghi lấy từ cookie, không từ body');
});

test('stock API trả kèm forecast + đánh giá', async () => {
  const m = await startGoogle(); useGoogle(m);
  try {
    await stock(await authed('/api/stock')); // nạp snapshot
    const snap = (await globalThis.__TEST_STORE__.get('snapshot')).items;
    const sku = snap[0].sku;
    await applyOp({ op: 'add', lines: [line({ month: nextMonthKey(), main: { sku }, gifts: [], units: 1000 })] }, 'a');
    const body = await (await stock(await authed('/api/stock'))).json();
    assert.equal(body.forecast.lines.length, 1);
    assert.equal(body.alertMonth, nextMonthKey());
    assert.ok(body.plan.evaluations[nextMonthKey()][sku].level);
    assert.equal(body.rules.southSharePct, 70);
  } finally { m.close(); }
});

// ================= logic.js (chạy trên trình duyệt, test bằng Node) =================
const PASTE = [
  'Campaign Type\tLoại\tTên sản phẩm\tSố lượng\tRSP (Main) / COGS (Gift)\tCIR\tMax CIR\tStatus',
  'BAU\tMain\tSản phẩm A đầy đủ\t1\t2,075,000\t3.9%\t4.0%\tPass',
  '\tGift\tKhăn tặng nhỏ\t2\t5,000\t\t\t',
  '\tGift\tMóc khoá lạ hoắc\t1\t30,000\t\t\t',
  'MINI SPIKE\tMain\tSản phẩm B\t1\t1.500.000\t\t5%\t',
].join('\n');

test('logic.parsePaste: đọc cấu trúc cột như Sheet (Main + Gift lồng), số kiểu VN, Max CIR %', () => {
  const { lines, warnings } = L.parsePaste(PASTE);
  assert.equal(lines.length, 2);
  assert.deepEqual(warnings, []);
  assert.equal(lines[0].campaign, 'BAU'); assert.equal(lines[0].price, 2075000); assert.equal(lines[0].maxCir, 0.04);
  assert.deepEqual(lines[0].gifts, [{ name: 'Khăn tặng nhỏ', qty: 2, cost: 5000 }, { name: 'Móc khoá lạ hoắc', qty: 1, cost: 30000 }]);
  assert.equal(lines[1].campaign, 'MINI SPIKE'); assert.equal(lines[1].price, 1500000); assert.equal(lines[1].maxCir, 0.05);
  assert.equal(lines[1].gifts.length, 0);
});

test('logic.parsePaste: không có dòng tiêu đề, dòng tên campaign riêng, cột campaign trống, copy lệch cột', () => {
  const r = L.parsePaste('BAU\nMain\tSP A\t1\t1000000\nGift\tQuà\t3\t1000\nMINPRICE\nMain\tSP B\t1\t500000');
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].campaign, 'BAU'); assert.equal(r.lines[1].campaign, 'MINPRICE');
  assert.equal(r.lines[0].gifts[0].qty, 3);
  assert.equal(r.lines[1].maxCir, null, 'campaign chưa biết Max CIR thì để trống');
});

test('logic.parsePaste: cảnh báo — Gift mồ côi, thiếu giá, không có Main, rỗng', () => {
  assert.match(L.parsePaste('Gift\tQuà\t1\t1000\nMain\tSP\t1\t').warnings.join('|'), /Gift nằm trước/);
  assert.match(L.parsePaste('Main\tSP\t1\t').warnings.join('|'), /giá bán/);
  assert.match(L.parsePaste('abc\tdef').warnings.join('|'), /Không thấy dòng Main/);
  assert.deepEqual(L.parsePaste('').lines, []);
});

test('logic.parseNumber / parsePercent', () => {
  assert.equal(L.parseNumber('2,075,000'), 2075000); assert.equal(L.parseNumber('2.075.000 ₫'), 2075000);
  assert.equal(L.parseNumber('12,5'), 12.5); assert.equal(L.parseNumber('abc'), null); assert.equal(L.parseNumber(''), null);
  assert.equal(L.parsePercent('4.0%'), 0.04); assert.equal(L.parsePercent('4%'), 0.04); assert.equal(L.parsePercent(0.05), 0.05);
  assert.equal(L.parsePercent(''), null);
});

test('logic: ghép tên — trùng hẳn, bỏ dấu/viết hoa, tên bị cắt, gần giống; khác hẳn thì để trống', () => {
  const items = [
    { sku: 'N1', name: 'Nồi chiên không dầu Inochi 4L Tomoko', shortName: 'Nồi 4L' },
    { sku: 'N2', name: 'Nồi chiên không dầu Inochi 6L Tomoko', shortName: 'Nồi 6L' },
    { sku: 'K1', name: 'Khăn lau đa năng', shortName: '' },
  ];
  assert.equal(L.autoMatch('Khăn lau đa năng', items).conf, 'exact');
  assert.equal(L.autoMatch('KHAN LAU DA NANG', items).sku, 'K1');
  const m4 = L.autoMatch('Nồi chiên không dầu 4L', items);
  assert.equal(m4.sku, 'N1', 'số 4L phân biệt với 6L');
  assert.equal(L.autoMatch('Nồi chiên không dầu Inochi 6L To…', items).sku, 'N2');
  assert.equal(L.autoMatch('Máy xay sinh tố', items).sku, '');
  assert.equal(L.autoMatch('SKU-lạ', items).conf, 'none');
  assert.equal(L.autoMatch('Gift N2 tặng kèm', items).sku, 'N2', 'tên có chứa SKU');
  assert.ok(L.search('noi 4', items).every((x) => x.item.sku === 'N1'));
  assert.deepEqual(L.search('', items), []);
});

test('logic.calcLine: CIR = Σ(qty×vốn quà) / giá bán; Over khi CIR chưa làm tròn > Max CIR', () => {
  const get = (sku) => ({ A: { cogs: 1_000_000 } })[sku];
  const mk = (o) => L.calcLine({ campaign: 'BAU', price: 2_075_000, maxCir: undefined, main: { sku: 'A' }, gifts: [{ qty: 2, cost: 5000 }, { qty: 1, cost: 70_000 }], ...o }, get);
  const r = mk({});
  assert.equal(r.giftCost, 80_000);
  assert.ok(Math.abs(r.cir - 80_000 / 2_075_000) < 1e-12);
  assert.equal(r.maxCir, 0.04); assert.equal(r.status, 'pass'); assert.equal(r.over, false);
  assert.equal(r.afterGifts, 2_075_000 - 1_000_000 - 80_000);
  assert.ok(Math.abs(r.gmPct - 1_075_000 / 2_075_000) < 1e-12);
  const over = mk({ gifts: [{ qty: 1, cost: 90_000 }] }); // 4.337% > 4%
  assert.equal(over.status, 'over'); assert.equal(over.overAmount, Math.round(90_000 - 0.04 * 2_075_000));
  assert.equal(mk({ gifts: [{ qty: 1, cost: 83_000 }] }).status, 'pass', '83.000/2.075.000 = đúng 4% -> không vượt');
  assert.equal(mk({ campaign: 'MINI SPIKE', gifts: [{ qty: 1, cost: 100_000 }] }).status, 'pass', 'MINI SPIKE max 5%');
  assert.equal(mk({ campaign: 'MINPRICE' }).status, 'na', 'campaign chưa có Max CIR');
  assert.equal(mk({ campaign: 'MINPRICE', maxCir: 0.02 }).status, 'over', 'Max CIR nhập tay');
  assert.equal(mk({ price: 0 }).status, 'na');
  assert.equal(L.calcLine({ campaign: 'BAU', price: 1000, main: { sku: 'Z' }, gifts: [] }, get).afterGifts, null, 'không có COGS thì không tính lãi');
});

// ================= frontend: cú pháp + quy tắc CSP =================
test('channel: line cũ không có channel -> Shopee; channel lạ bị từ chối; lưu và đọc lại đúng', async () => {
  const base = { month: '2026-12', campaign: 'bau', price: 100000, units: 10, main: { sku: 'A' }, gifts: [] };
  assert.equal(sanitizeLine(base).channel, 'shopee');
  assert.equal(sanitizeLine({ ...base, channel: 'TikTok' }).channel, 'tiktok');
  assert.equal(sanitizeLine({ ...base, channel: 'website' }).channel, 'website');
  assert.throws(() => sanitizeLine({ ...base, channel: 'lazada' }), ForecastError);
  assert.equal(L.channelOf({}), 'shopee');
  assert.equal(L.channelOf({ channel: 'tiktok' }), 'tiktok');
  assert.equal(L.channelOf({ channel: 'zzz' }), 'shopee');
  assert.equal(L.channelLabel('tiktok'), 'TikTok');
});

test('logic.overallModel: GMV = giá × SL theo channel/campaign/SKU/category; line chưa có SL chỉ được đếm riêng', () => {
  const items = { A: { sku: 'A', cogs: 40000, category: 'Bình' }, B: { sku: 'B', cogs: null, category: 'Cốc' }, G: { sku: 'G', cogs: 5000, category: 'Quà' } };
  const get = (s) => items[s];
  const mk = (o) => ({ campaign: 'BAU', channel: 'shopee', price: 100000, units: 10, main: { sku: 'A' }, gifts: [], ...o });
  const lines = [
    mk({ gifts: [{ sku: 'G', qty: 2, cost: 5000 }] }),                       // Shopee A: GMV 1.000.000, quà 100.000
    mk({ channel: 'tiktok', price: 90000, units: 20 }),                      // TikTok A: 1.800.000
    mk({ channel: 'website', campaign: 'MINI SPIKE', main: { sku: 'B' }, price: 50000, units: 4 }), // Website B: 200.000, không COGS
    mk({ units: null }),                                                     // chưa nhập SL
    mk({ units: 0, channel: 'tiktok' }),                                     // SL = 0 cũng chưa tính
  ];
  const m = L.overallModel(lines, get);
  assert.equal(m.totals.lines, 5);
  assert.equal(m.totals.missing, 2);
  assert.equal(m.totals.gmv, 1_000_000 + 1_800_000 + 200_000);
  assert.equal(m.totals.units, 34);
  assert.equal(m.totals.giftCost, 10 * 2 * 5000);
  assert.deepEqual(m.byChannel.map((c) => [c.key, c.gmv]), [['tiktok', 1_800_000], ['shopee', 1_000_000], ['website', 200_000]]);
  assert.deepEqual(m.bySku.map((s) => [s.sku, s.gmv]), [['A', 2_800_000], ['B', 200_000]]);
  assert.deepEqual(m.bySku[0].by, { shopee: 1_000_000, tiktok: 1_800_000 });
  assert.deepEqual(m.byCampaign.map((c) => [c.key, c.gmv]), [['BAU', 2_800_000], ['MINI SPIKE', 200_000]]);
  assert.deepEqual(m.byCategory.map((c) => [c.key, c.gmv]), [['Bình', 2_800_000], ['Cốc', 200_000]]);
  // lãi gộp sau quà: chỉ line có COGS Main (A). (100.000−40.000−10.000)×10 + (90.000−40.000)×20 = 500.000 + 1.000.000
  assert.equal(m.totals.gross, 1_500_000);
  assert.equal(m.totals.gmvCogs, 2_800_000);
  assert.equal(m.totals.linesCogs, 2);
  // không có dữ liệu -> không NaN
  const e = L.overallModel([], get);
  assert.equal(e.totals.gmv, 0); assert.deepEqual(e.bySku, []);
});

test('combo: qty + SKU gộp thêm được lưu; line cũ vẫn đọc được; nhu cầu kho nhân theo số lượng từng SKU', async () => {
  const base = { month: '2026-12', campaign: 'bau', price: 100000, units: 10, main: { sku: 'A' }, gifts: [{ sku: 'G', qty: 2, cost: 1000 }] };
  // line cũ: không qty, không combo
  const old = sanitizeLine(base);
  assert.equal(old.main.qty, 1); assert.deepEqual(old.combo, []);
  // cùng 1 SKU nhiều cái (mua 3) + combo 2 SKU khác nhau
  const triple = sanitizeLine({ ...base, main: { sku: 'A', qty: 3 } });
  assert.equal(triple.main.qty, 3);
  const combo = sanitizeLine({ ...base, main: { sku: 'A', qty: 2 }, combo: [{ sku: 'B', qty: 1 }, { sku: 'A', qty: 1 }] });
  assert.deepEqual(combo.combo.map((c) => [c.sku, c.qty]), [['B', 1], ['A', 1]]);
  assert.throws(() => sanitizeLine({ ...base, main: { sku: 'A', qty: 0 } }), ForecastError);
  assert.throws(() => sanitizeLine({ ...base, main: { sku: 'A', qty: 1.5 } }), ForecastError);
  assert.throws(() => sanitizeLine({ ...base, combo: [{ sku: '', qty: 1 }] }), ForecastError);
  assert.throws(() => sanitizeLine({ ...base, combo: Array.from({ length: 11 }, () => ({ sku: 'B', qty: 1 })) }), ForecastError);
  assert.throws(() => sanitizeLine({ ...base, combo: 'x' }), ForecastError);
  // nhu cầu: 10 deal × (A×2 + B×1 + A×1) = A 30, B 10; quà G 10×2 = 20
  const d = demandByMonth([{ ...combo, id: 'x' }, { ...old, id: 'y', units: null }])['2026-12'];
  assert.deepEqual(d, { A: { main: 30, gift: 0 }, B: { main: 10, gift: 0 }, G: { main: 0, gift: 20 } });
  // line cũ lưu trong Blobs (không qty/combo) vẫn tính nhu cầu như cũ
  const legacy = { month: '2026-12', units: 5, main: { sku: 'A' }, gifts: [] };
  assert.deepEqual(demandByMonth([legacy])['2026-12'], { A: { main: 5, gift: 0 } });
  // lưu qua API rồi đọc lại
  const { created } = await applyOp({ op: 'add', lines: [{ ...base, main: { sku: 'A', qty: 2 }, combo: [{ sku: 'B', qty: 3 }] }] }, 'a@example.com');
  const saved = (await getForecast()).lines.find((l) => l.id === created[0]);
  assert.equal(saved.main.qty, 2); assert.deepEqual(saved.combo.map((c) => [c.sku, c.qty]), [['B', 3]]);
});

test('logic: calcLine tính COGS cả deal combo; thiếu COGS một SKU thì không tính %GM; isCombo/dealLabel', () => {
  const items = { A: { cogs: 100000 }, B: { cogs: 50000 }, C: {} };
  const get = (s) => items[s];
  const line = (o) => ({ campaign: 'BAU', price: 400000, main: { sku: 'A', qty: 2 }, combo: [{ sku: 'B', qty: 1 }], gifts: [], ...o });
  const c = L.calcLine(line(), get);
  assert.equal(c.mainCogs, 250000);                 // 2×100.000 + 1×50.000
  assert.equal(c.afterGifts, 150000);
  assert.ok(Math.abs(c.gmPct - 0.375) < 1e-9);
  assert.equal(L.calcLine(line({ combo: [{ sku: 'C', qty: 1 }] }), get).mainCogs, null);
  assert.equal(L.calcLine({ campaign: 'BAU', price: 1000, main: { sku: 'A' }, gifts: [] }, get).mainCogs, 100000, 'line cũ: 1 SKU × 1');
  assert.equal(L.isCombo(line()), true);
  assert.equal(L.isCombo({ main: { sku: 'A', qty: 1 }, combo: [] }), false);
  assert.equal(L.isCombo({ main: { sku: 'A', qty: 3 } }), true);
  assert.equal(L.dealLabel(line()), 'A×2 + B');
  assert.equal(L.dealLabel({ main: { sku: 'A' } }), 'A');
});

test('logic.overallModel: GMV deal combo chia cho từng SKU theo (SL × COGS); tổng/channel không đổi', () => {
  const items = { A: { sku: 'A', cogs: 100000, category: 'Nồi' }, B: { sku: 'B', cogs: 50000, category: 'Chảo' }, C: { sku: 'C', cogs: null, category: 'Cốc' } };
  const get = (s) => items[s];
  const l = (o) => ({ campaign: 'BAU', channel: 'shopee', price: 400000, units: 10, main: { sku: 'A', qty: 2 }, combo: [{ sku: 'B', qty: 1 }], gifts: [], ...o });
  const m = L.overallModel([l()], get);
  assert.equal(m.totals.gmv, 4_000_000);
  assert.equal(m.totals.combos, 1);
  // trọng số A = 2×100.000 = 200.000, B = 50.000 → A 80% = 3.200.000, B 20% = 800.000
  assert.deepEqual(m.bySku.map((s) => [s.sku, Math.round(s.gmv), s.units]), [['A', 3_200_000, 20], ['B', 800_000, 10]]);
  assert.deepEqual(m.byCategory.map((c) => [c.key, Math.round(c.gmv)]), [['Nồi', 3_200_000], ['Chảo', 800_000]]);
  assert.equal(m.byChannel[0].gmv, 4_000_000);
  assert.equal(m.totals.gross, (400000 - 250000) * 10);
  // thiếu COGS ở một SKU -> chia theo số lượng (A×2 : C×1 = 2/3 : 1/3), không tính lãi gộp
  const m2 = L.overallModel([l({ combo: [{ sku: 'C', qty: 1 }] })], get);
  assert.deepEqual(m2.bySku.map((s) => [s.sku, Math.round(s.gmv)]), [['A', 2_666_667], ['C', 1_333_333]]);
  assert.equal(m2.totals.linesCogs, 0);
  // tổng phân bổ theo SKU luôn bằng GMV
  assert.equal(Math.round(m2.bySku.reduce((s, x) => s + x.gmv, 0)), 4_000_000);
});


// ---------- SL thực tế + benchmark tháng trước ----------
test('forecast: actualUnits — mặc định null, 0 hợp lệ, số âm/lẻ bị từ chối, lưu & sửa qua update', async () => {
  assert.equal(sanitizeLine(line()).actualUnits, null);
  assert.equal(sanitizeLine(line({ actualUnits: '' })).actualUnits, null);
  assert.equal(sanitizeLine(line({ actualUnits: 0 })).actualUnits, 0);
  assert.equal(sanitizeLine(line({ actualUnits: '37' })).actualUnits, 37);
  for (const bad of [-1, 1.5, 'abc', 1e8]) assert.throws(() => sanitizeLine(line({ actualUnits: bad })), (e) => e instanceof ForecastError && e.status === 400);
  await seedSnapshot();
  const { created } = await applyOp({ op: 'add', lines: [line({ month: '2026-10' })] }, 'a');
  assert.equal((await getForecast()).lines[0].actualUnits, null);
  await applyOp({ op: 'update', id: created[0], rev: 1, line: line({ month: '2026-10', actualUnits: 87 }) }, 'a');
  const l = (await getForecast()).lines[0];
  assert.equal(l.actualUnits, 87); assert.equal(l.units, 100); assert.equal(l.rev, 2);
});

test('plan: currentMonthKey theo giờ VN; withPlanView trả currentMonth và bỏ cảnh báo tháng đã qua', () => {
  assert.equal(currentMonthKey(Date.UTC(2026, 10, 23)), '2026-11');
  assert.equal(currentMonthKey(Date.UTC(2026, 10, 30, 17, 30)), '2026-12', '00:30 ngày 1/12 giờ VN');
  const data = { snapshot: { items: ITEMS } };
  const mk = (month, id) => ({ ...line({ month }), campaign: 'BAU', id, rev: 1 });
  const v = withPlanView(data, { rev: 1, lines: [mk('2026-10', 'a'), mk('2026-11', 'b'), mk('2026-12', 'c')] }, Date.UTC(2026, 10, 23), () => undefined);
  assert.equal(v.currentMonth, '2026-11');
  assert.deepEqual(v.plan.months, ['2026-11', '2026-12'], 'tháng 10 đã qua: không đánh giá tồn');
  assert.equal(withPlanView({}, undefined, Date.UTC(2026, 10, 23), () => undefined).currentMonth, '2026-11');
});

test('logic.prevMonth: lùi 1 tháng, qua năm, đầu vào rác -> rỗng', () => {
  assert.equal(L.prevMonth('2026-12'), '2026-11');
  assert.equal(L.prevMonth('2027-01'), '2026-12');
  assert.equal(L.prevMonth(''), ''); assert.equal(L.prevMonth('2026-13'), ''); assert.equal(L.prevMonth(undefined), '');
});

test('logic.benchmarkFor: cùng deal (ưu tiên cùng campaign) -> cùng SKU -> không có; tách theo channel; % đạt KH chỉ so line có đủ hai số', () => {
  const mk = (o) => ({ id: Math.random().toString(36), month: '2026-10', channel: 'shopee', campaign: 'BAU', price: 100000, units: 100, actualUnits: null, main: { sku: 'A', qty: 1 }, combo: [], gifts: [], ...o });
  const cur = mk({ id: 'cur', month: '2026-11', units: 150 });
  // cùng deal: 2 campaign khác nhau; BAU được ưu tiên
  const lines = [
    mk({ actualUnits: 80 }),                                                    // BAU: 80/100
    mk({ campaign: 'MINI SPIKE', price: 90000, actualUnits: 300, units: 200 }), // khác campaign -> bị bỏ khi đã có BAU
    mk({ channel: 'tiktok', actualUnits: 999 }),                                 // channel khác -> không tính
    mk({ month: '2026-09', actualUnits: 555 }),                                  // không phải tháng liền trước
  ];
  const b = L.benchmarkFor(cur, lines);
  assert.equal(b.kind, 'deal'); assert.equal(b.prev, '2026-10'); assert.equal(b.sameCampaign, true);
  assert.equal(b.actual, 80); assert.equal(b.gmv, 8_000_000); assert.equal(b.avgPrice, 100000);
  assert.equal(b.planned, 100); assert.equal(b.pct, 0.8); assert.deepEqual(b.campaigns, ['BAU']);
  // không có BAU -> gộp mọi campaign của deal, giá TB gia quyền
  const b2 = L.benchmarkFor({ ...cur, campaign: 'FLASH' }, lines);
  assert.equal(b2.sameCampaign, false); assert.equal(b2.actual, 380);
  assert.equal(b2.gmv, 80 * 100000 + 300 * 90000); assert.equal(Math.round(b2.avgPrice), Math.round((8_000_000 + 27_000_000) / 380));
  // line chưa nhập thực tế được đếm vào pending, không lẫn vào số liệu
  const b3 = L.benchmarkFor(cur, [...lines, mk({ actualUnits: null })]);
  assert.equal(b3.actual, 80); assert.equal(b3.pending, 1);
  // deal khác (combo) nhưng cùng SKU Main -> benchmark theo SKU, tính theo số CÁI (SL deal × qty)
  const comboPrev = mk({ main: { sku: 'A', qty: 2 }, actualUnits: 50, units: 40 });
  const b4 = L.benchmarkFor(cur, [comboPrev]);
  assert.equal(b4.kind, 'sku'); assert.equal(b4.actual, 100); assert.equal(b4.planned, 80); assert.equal(b4.pct, 1.25);
  assert.deepEqual(b4.deals, ['A×2']);
  // chưa có thực tế -> none + pending; không có gì -> none, pending 0
  const b5 = L.benchmarkFor(cur, [mk({ actualUnits: null })]);
  assert.equal(b5.kind, 'none'); assert.equal(b5.pending, 1);
  assert.deepEqual([L.benchmarkFor(cur, []).kind, L.benchmarkFor(cur, []).pending], ['none', 0]);
  // actual = 0 vẫn là dữ liệu thật ("đã chạy nhưng bán 0")
  const b6 = L.benchmarkFor(cur, [mk({ actualUnits: 0 })]);
  assert.equal(b6.kind, 'deal'); assert.equal(b6.actual, 0); assert.equal(b6.avgPrice, null);
});

test('logic.overallModel: GMV thực tế = giá KH × SL thực tế; % đạt KH chỉ so line có đủ KH + thực tế', () => {
  const get = () => undefined;
  const mk = (o) => ({ campaign: 'BAU', channel: 'shopee', price: 100000, units: 10, actualUnits: null, main: { sku: 'A' }, gifts: [{ sku: 'G', qty: 2, cost: 5000 }], ...o });
  const m = L.overallModel([
    mk({ actualUnits: 8 }),                    // KH 10 → TT 8
    mk({ actualUnits: 15, price: 200000 }),    // KH 10 → TT 15
    mk({ actualUnits: 5, units: null }),       // có thực tế nhưng chưa có KH: tính vào thực tế, không vào % đạt KH
    mk(),                                      // chưa nhập thực tế
  ], get).totals;
  assert.equal(m.actualLines, 3); assert.equal(m.actualUnits, 28);
  assert.equal(m.actualGmv, 8 * 100000 + 15 * 200000 + 5 * 100000);
  assert.equal(m.planGmvOfActual, 10 * 100000 + 10 * 200000); assert.equal(m.planUnitsOfActual, 20);
  assert.equal(m.actualGift, 28 * 2 * 5000);
  assert.equal(m.missing, 1, 'line không có KH vẫn nằm trong "chưa có SL dự kiến"');
});


// ---------- Xuất Excel ----------
// Đọc lại file .xlsx do writer tạo ra (ZIP store): kiểm tra CRC, tên part, rồi trả về nội dung từng part.
function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), td = new TextDecoder();
  let e = u8.length - 22; assert.equal(dv.getUint32(e, true), 0x06054b50, 'EOCD');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    assert.equal(dv.getUint32(off, true), 0x04034b50); const data = u8.subarray(off + 30 + dv.getUint16(off + 26, true), off + 30 + dv.getUint16(off + 26, true) + size);
    assert.equal(X.crc32(data), crc, 'CRC ' + name); out[name] = td.decode(data); p += 46 + nl;
  }
  return out;
}

test('xlsx: ZIP hợp lệ (CRC), đủ part, escape XML, chuỗi luôn là text, tên sheet an toàn/không trùng', () => {
  const u8 = X.buildXlsx([
    { name: 'A/B:C?*[x]', rows: [['=SUM(1,1)', '+cmd', { v: 'a & <b> "q"', bold: true, fill: 'FFD966' }, 12, 0.5, null, { v: 0.123, fmt: 'pct1' }]] },
    { name: 'A B C  x ', rows: [[1]] },
    { name: 'a b c  x ', rows: [[2]] },
  ]);
  const z = readZip(u8);
  for (const k of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']) assert.ok(k in z, k);
  const names = [...z['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names.map((s) => s.toLowerCase())).size, 3, 'tên sheet không trùng');
  assert.ok(names.every((s) => !/[\[\]:*?\/\\]/.test(s) && s.length <= 31));
  const s1 = z['xl/worksheets/sheet1.xml'];
  assert.match(s1, /t="inlineStr"><is><t xml:space="preserve">=SUM\(1,1\)<\/t>/, 'ô bắt đầu bằng = là text, không phải công thức');
  assert.equal(/<f>/.test(s1), false);
  assert.match(s1, /a &amp; &lt;b&gt; &quot;q&quot;/);
  assert.match(s1, /<c r="D1"><v>12<\/v><\/c>/); assert.match(s1, /<c r="E1"><v>0.5<\/v><\/c>/);
  assert.equal(/r="F1"/.test(s1), false, 'null = không có ô');
  assert.match(z['xl/styles.xml'], /FFFFD966/); assert.match(z['xl/styles.xml'], /formatCode="0\.0%"/);
  assert.equal(X.colName(0), 'A'); assert.equal(X.colName(25), 'Z'); assert.equal(X.colName(26), 'AA'); assert.equal(X.colName(701), 'ZZ'); assert.equal(X.colName(702), 'AAA');
});

test('xlsx: loại ký tự điều khiển không hợp lệ trong XML; NaN/Infinity thành ô trống', () => {
  const z = readZip(X.buildXlsx([{ name: 'S', rows: [['a\u0000b\u0007c', NaN, Infinity, 5]] }]));
  const s = z['xl/worksheets/sheet1.xml'];
  assert.match(s, />abc</); assert.equal(/NaN|Infinity/.test(s), false); assert.match(s, /<c r="D1"><v>5<\/v><\/c>/);
});

const mkLine = (o) => ({ id: 'x', month: '2026-12', channel: 'shopee', campaign: 'BAU', price: 2075000, units: 100, actualUnits: null, maxCir: 0.04, main: { sku: 'A', qty: 1 }, combo: [], gifts: [], ...o });
const ITEMS_X = { A: { sku: 'A', name: 'Nồi chiên 4L', cogs: 1_000_000 }, B: { sku: 'B', name: 'Chảo B', cogs: 200_000 }, G1: { sku: 'G1', name: 'Quà 1', cogs: 36166 }, G2: { sku: 'G2', name: 'Quà 2', cogs: 29000 } };

test('export: bố cục Forecast theo mẫu Sheet — header, dải Campaign (BAU đầu), Main trước Gift, combo, tách theo channel', () => {
  const lines = [
    mkLine({ campaign: 'ACTION', gifts: [{ sku: 'G2', qty: 1, cost: 29000 }] }),
    mkLine({ gifts: [{ sku: 'G1', qty: 2, cost: 36166 }, { sku: 'G2', qty: 1, cost: 29000 }] }),                       // CIR = 101.332 / 2.075.000 = 4,9% > 4% -> Over
    mkLine({ main: { sku: 'A', qty: 2 }, combo: [{ sku: 'B', qty: 1 }], price: 4000000, gifts: [] }),                    // combo (BAU)
    mkLine({ channel: 'tiktok', gifts: [] }),
  ];
  const sheets = E.forecastLayoutSheets(lines, (s) => ITEMS_X[s]);
  assert.deepEqual(sheets.map((s) => s.name), ['Shopee', 'TikTok'], 'chỉ channel có line; Website bị bỏ');
  const v = (c) => (c && typeof c === 'object' ? c.v : c);
  const grid = sheets[0].rows.map((r) => r.map(v));
  assert.deepEqual(grid[0], ['Campaign Type', 'Loại', 'Tên sản phẩm', 'Số lượng', 'RSP (Main)\nCOGS (Gift)', 'CIR', 'Max CIR', 'Status']);
  assert.deepEqual(grid[1], ['BAU', '', '', '', '', '', '', ''], 'BAU luôn là dải đầu tiên');
  assert.deepEqual(grid.slice(2, 5).map((r) => [r[1], r[2], r[3], r[4]]), [['Main', 'Nồi chiên 4L', 1, 2075000], ['Gift', 'Quà 1', 2, 36166], ['Gift', 'Quà 2', 1, 29000]]);
  assert.equal(grid[2][7], 'Over'); assert.ok(Math.abs(grid[2][5] - 101332 / 2075000) < 1e-9); assert.equal(grid[2][6], 0.04);
  // combo: Main đầu mang giá/CIR; SKU thêm là dòng Main chỉ có tên + SL
  assert.deepEqual(grid.slice(5, 7).map((r) => [r[1], r[2], r[3], r[4]]), [['Main', 'Nồi chiên 4L', 2, 4000000], ['Main', 'Chảo B', 1, '']]);
  assert.equal(grid[6][7], '');
  const ci = grid.findIndex((r) => r[0] === 'ACTION' && r[1] === ''); assert.ok(ci > 6, 'campaign khác đứng sau BAU');
  assert.equal(grid[ci + 1][7], 'Pass');
  assert.ok(grid.every((r) => r.length === 8));
  assert.equal(sheets[0].rows[2][7].fill, 'F8CBAD'); assert.equal(sheets[0].rows[ci + 1][7].fill, 'C6E0B4');
  assert.equal(sheets[0].rows[1][0].fill, 'FFD966');
  assert.deepEqual(sheets[1].rows.map((r) => r.map(v)).slice(1, 3).map((r) => r[0] + '/' + r[1]), ['BAU/', 'BAU/Main']);
});

test('export: sheet số liệu chi tiết giữ số thật + % đạt KH; workbook mở lại được', () => {
  const lines = [mkLine({ actualUnits: 87, gifts: [{ sku: 'G1', qty: 2, cost: 36166 }] }), mkLine({ campaign: 'X', units: null })];
  const sh = E.forecastFlatSheet(lines, (s) => ITEMS_X[s]);
  const row = sh.rows[1].map((c) => c.v);
  assert.equal(row[5], 2075000); assert.equal(row[6], 100); assert.equal(row[7], 207500000); assert.equal(row[14], 87); assert.equal(row[15], 0.87); assert.equal(row[16], 87 * 2075000);
  assert.equal(sh.rows[2].map((c) => c.v)[7], '', 'chưa có KH -> không GMV dự kiến');
  const z = readZip(E.forecastWorkbook(lines, (s) => ITEMS_X[s]));
  assert.ok('xl/worksheets/sheet2.xml' in z && /autoFilter/.test(z['xl/worksheets/sheet2.xml']));
  assert.match(z['xl/worksheets/sheet1.xml'], /state="frozen"/);
});

const PUBLIC_JS = ['api', 'app', 'export', 'filters', 'forecast', 'linecard', 'logic', 'overall', 'plan', 'state', 'ui', 'login', 'xlsx'].map((n) => `public/${n}.js`);
test('frontend: mọi file JS đúng cú pháp module', async () => {
  for (const f of PUBLIC_JS) {
    const src = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
  }
});

test('frontend: tuân thủ CSP — không innerHTML/eval/inline script/style, không tải tài nguyên ngoài', async () => {
  const forbidden = [/\.innerHTML\b/, /\binsertAdjacentHTML\b/, /\beval\s*\(/, /new Function\s*\(/, /document\.write/, /\.outerHTML\s*=/];
  for (const f of PUBLIC_JS) {
    const src = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${f} dùng ${re}`);
  }
  for (const f of ['public/index.html', 'public/login.html']) {
    const html = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, `${f} có script inline`);
    assert.equal(/\sstyle\s*=/i.test(html), false, `${f} có style inline`);
    assert.equal(/\son\w+\s*=/i.test(html), false, `${f} có onclick…`);
    assert.equal(/(src|href)\s*=\s*["']https?:\/\//i.test(html), false, `${f} tải tài nguyên ngoài`);
  }
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.equal(/@import|url\(\s*["']?https?:/i.test(css), false);
});

test('frontend: TYPE Other hiện mặc định (không ẩn); HTML có đủ phần tử mà JS cần', async () => {
  assert.match(await readFile(new URL('../public/state.js', import.meta.url), 'utf8'), /hiddenTypes:\s*new Set\(\)/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const f of PUBLIC_JS) {
    const src = await readFile(new URL('../' + f, import.meta.url), 'utf8');
    if (f.endsWith('login.js')) continue;
    const used = [...src.matchAll(/\$\('#?([A-Za-z][\w-]*)'\)/g), ...src.matchAll(/\bon\('([A-Za-z][\w-]*)',/g)].map((m) => m[1]);
    const dynamic = new Set(['ranges']); // vẫn phải có trong HTML; liệt kê để dễ đọc
    for (const id of used) assert.ok(ids.has(id), `${f} cần #${id} nhưng index.html không có`);
    void dynamic;
  }
});

// ================= Đăng nhập bằng Google =================
const OAUTH_ID = '1234-abc.apps.googleusercontent.com';
const setOauthEnv = () => { process.env.GOOGLE_OAUTH_CLIENT_ID = OAUTH_ID; process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'shh'; };
const idToken = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const goodClaims = (o = {}) => ({ aud: OAUTH_ID, iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'A@Example.com', email_verified: true, ...o });
const fakeGoogle = (claims, status = 200) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, body: new URLSearchParams(init.body) }); return new Response(JSON.stringify(claims ? { id_token: idToken(claims) } : {}), { status }); };
  fn.calls = calls;
  return fn;
};
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(name + '=')) ?? '').split(';')[0];
// chạy bước 1 rồi trả về { state, cookie }
async function startFlow(next = '/') {
  const res = await authStart(new Request(BASE + '/api/auth/start?next=' + encodeURIComponent(next)));
  const loc = new URL(res.headers.get('location'));
  return { res, loc, state: loc.searchParams.get('state'), cookie: cookieOf(res, STATE_COOKIE) };
}
const callback = (qs, cookie, deps) => authCallback(new Request(BASE + '/api/auth/callback?' + qs, { headers: cookie ? { cookie } : {} }), deps);

test('allowedEmails: tách theo dấu phẩy/chấm phẩy/xuống dòng/khoảng trắng, chữ thường, bỏ rác', () => {
  assert.deepEqual([...allowedEmails(' A@x.com, b@y.vn;c@z.com\n d@w.com  rác ')].sort(), ['a@x.com', 'b@y.vn', 'c@z.com', 'd@w.com']);
  assert.equal(allowedEmails(undefined).size, 0);
});

test('safeNext: chỉ nhận đường dẫn nội bộ', () => {
  assert.equal(safeNext('/forecast?x=1'), '/forecast?x=1');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/login.html', '/api/auth/start', '', null, 'javascript:alert(1)']) assert.equal(safeNext(bad), '/');
});

test('auth/start: chuyển sang Google đúng tham số, đặt cookie state HttpOnly ký sẵn', async () => {
  setOauthEnv();
  const { res, loc, state, cookie } = await startFlow('/forecast');
  assert.equal(res.status, 302);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), OAUTH_ID);
  assert.equal(loc.searchParams.get('redirect_uri'), BASE + '/api/auth/callback');
  assert.equal(loc.searchParams.get('scope'), 'openid email');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.ok(state.length >= 24);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Lax/);
  assert.deepEqual(await verifyData(cookie.split('=')[1], SECRET), { s: state, n: '/forecast' });
  assert.equal(await verifyData(cookie.split('=')[1], 'z'.repeat(48)), null);
});

test('auth/start: thiếu cấu hình -> về trang login kèm mã lỗi, không gọi Google', async () => {
  let res = await authStart(new Request(BASE + '/api/auth/start'));
  assert.match(res.headers.get('location'), /error=server_misconfigured/);
  setOauthEnv(); delete process.env.SESSION_SECRET;
  res = await authStart(new Request(BASE + '/api/auth/start'));
  assert.match(res.headers.get('location'), /error=server_misconfigured/);
});

test('auth/callback: email trong danh sách (không phân biệt hoa thường) -> cookie phiên + quay về trang cũ', async () => {
  setOauthEnv();
  const { state, cookie } = await startFlow('/forecast');
  const g = fakeGoogle(goodClaims());
  const res = await callback(`code=C1&state=${state}`, cookie, { fetch: g });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), BASE + '/forecast');
  const sess = cookieOf(res, COOKIE_NAME);
  assert.deepEqual((await verifySession(sess.split('=')[1], SECRET)).email, 'a@example.com');
  assert.match(res.headers.getSetCookie().find((c) => c.startsWith(COOKIE_NAME)), /HttpOnly.*Secure|Secure.*HttpOnly/);
  assert.match(res.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE)), /Max-Age=0/, 'xoá cookie state');
  assert.equal(g.calls[0].body.get('code'), 'C1');
  assert.equal(g.calls[0].body.get('client_secret'), 'shh');
  assert.equal(g.calls[0].body.get('redirect_uri'), BASE + '/api/auth/callback');
  // cookie vừa cấp qua được cổng
  assert.equal(await (await gate(gReq('/', sess), ctx)).text(), 'PAGE');
});

test('auth/callback: email Google hợp lệ nhưng không có trong ALLOWED_EMAILS -> từ chối, không cấp cookie', async () => {
  setOauthEnv();
  const { state, cookie } = await startFlow();
  const res = await callback(`code=C&state=${state}`, cookie, { fetch: fakeGoogle(goodClaims({ email: 'ghost@gmail.com' })) });
  assert.match(res.headers.get('location'), /error=not_allowed/);
  assert.equal(cookieOf(res, COOKIE_NAME), '');
});

test('auth/callback: chống CSRF — state sai / thiếu cookie / cookie ký sai / hết hạn', async () => {
  setOauthEnv();
  const { state, cookie } = await startFlow();
  const g = fakeGoogle(goodClaims());
  for (const [qs, ck] of [[`code=C&state=KHAC`, cookie], [`code=C&state=${state}`, ''], [`code=C`, cookie], [`state=${state}`, cookie], [`code=C&state=${state}`, STATE_COOKIE + '=rac.rac']]) {
    const res = await callback(qs, ck, { fetch: g });
    assert.match(res.headers.get('location'), /error=bad_state/, qs);
    assert.equal(cookieOf(res, COOKIE_NAME), '');
  }
  assert.equal(g.calls.length, 0, 'không đổi code nếu state sai');
  // cookie state bị dùng làm cookie phiên cũng vô hiệu
  assert.equal(await verifySession(cookie.split('=')[1], SECRET), null);
  const old = STATE_COOKIE + '=' + (await (await import('../lib/session.mjs')).signData({ s: state, n: '/' }, SECRET, 600, Date.now() - 3_600_000));
  assert.match((await callback(`code=C&state=${state}`, old, { fetch: g })).headers.get('location'), /error=bad_state/);
});

test('auth/callback: id_token sai aud/iss/hết hạn/email chưa xác minh/Google từ chối/người dùng huỷ', async () => {
  setOauthEnv();
  const cases = [
    [goodClaims({ aud: 'app-khac' }), 200, 'google_bad_token'],
    [goodClaims({ iss: 'https://evil.com' }), 200, 'google_bad_token'],
    [goodClaims({ exp: 1 }), 200, 'google_bad_token'],
    [goodClaims({ email_verified: false }), 200, 'email_unverified'],
    [goodClaims({ email_verified: 'true' }), 200, 'email_unverified'],
    [null, 200, 'google_bad_token'],
    [null, 400, 'google_rejected'],
  ];
  for (const [claims, status, code] of cases) {
    const { state, cookie } = await startFlow();
    const res = await callback(`code=C&state=${state}`, cookie, { fetch: fakeGoogle(claims, status) });
    assert.match(res.headers.get('location'), new RegExp('error=' + code), JSON.stringify(claims));
    assert.equal(cookieOf(res, COOKIE_NAME), '');
  }
  const { state, cookie } = await startFlow();
  assert.match((await callback(`error=access_denied&state=${state}`, cookie)).headers.get('location'), /error=cancelled/);
  const down = async () => { throw new Error('mạng'); };
  const f = await startFlow();
  assert.match((await callback(`code=C&state=${f.state}`, f.cookie, { fetch: down })).headers.get('location'), /error=google_unreachable/);
});

test('auth/callback: next độc hại bị thay bằng "/"', async () => {
  setOauthEnv();
  const { state, cookie } = await startFlow('//evil.com');
  const res = await callback(`code=C&state=${state}`, cookie, { fetch: fakeGoogle(goodClaims()) });
  assert.equal(res.headers.get('location'), BASE + '/');
});

// ================= Bộ lọc tồn kho =================
test('logic.parseMoney: nhập nhanh k / tr / tỷ, dấu chấm-phẩy kiểu VN', () => {
  const cases = { '50000': 50000, '50.000': 50000, '50k': 50000, '300K': 300000, '1,5tr': 1500000, '1.5tr': 1500000, '1,2tr': 1200000, '2 triệu': 2000000,
    '1.2 tỷ': 1200000000, '200000đ': 200000, '200.000 ₫': 200000, '2 nghìn': 2000, '1.234.567': 1234567, '0': 0, '12,5': 12.5 };
  for (const [input, want] of Object.entries(cases)) assert.equal(L.parseMoney(input), want, input);
  for (const bad of ['', 'abc', 'k', '-5', '1..2', null, undefined]) assert.equal(L.parseMoney(bad), null, String(bad));
  assert.equal(L.parseMoney(123), 123);
});

test('logic.rangeOk: đầu mút bao gồm, để trống = không giới hạn, thiếu giá trị thì bị loại khi đang lọc', () => {
  assert.equal(L.rangeOk(5, {}), true);
  assert.equal(L.rangeOk(null, {}), true, 'không lọc thì giữ cả SP thiếu giá trị');
  assert.equal(L.rangeOk(null, { min: 1, max: null }), false);
  assert.equal(L.rangeOk(100, { min: 100, max: 200 }), true);
  assert.equal(L.rangeOk(200, { min: 100, max: 200 }), true);
  assert.equal(L.rangeOk(201, { min: 100, max: 200 }), false);
  assert.equal(L.rangeOk(99, { min: 100, max: null }), false);
  assert.equal(L.rangeOk(0, { min: null, max: 0 }), true);
  assert.equal(L.rangeOk(500, { min: 200, max: 100 }), false, 'Từ > Đến thì không khớp gì');
});
