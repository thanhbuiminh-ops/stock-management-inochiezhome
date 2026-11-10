// Đọc Google Sheet bằng service account (OAuth2 JWT bearer), chỉ quyền đọc. Không cần thư viện ngoài.
import { createSign } from 'node:crypto';
import { getEnv } from './env.mjs';

export class ConfigError extends Error {}
export class GoogleError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const b64u = (x) => Buffer.from(x).toString('base64url');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export function sheetConfig(env = getEnv) {
  const need = (k) => {
    const v = env(k);
    if (!v) throw new ConfigError(`Thiếu biến môi trường ${k}`);
    return v;
  };
  return {
    sheetId: need('SHEET_ID'),
    tab: env('SHEET_TAB') || 'COGS',
    clientEmail: need('GOOGLE_CLIENT_EMAIL'),
    privateKey: need('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'), // chấp nhận cả dạng dán 1 dòng có "\n"
    tokenUrl: env('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token',
    sheetsBase: env('GOOGLE_SHEETS_BASE') || 'https://sheets.googleapis.com',
    includeCost: !/^(0|false|no)$/i.test(env('INCLUDE_COST') || ''), // mặc định HIỆN COGS; INCLUDE_COST=false để ẩn
  };
}

let cached = { key: '', token: '', expMs: 0 };

export async function accessToken(cfg, nowMs = Date.now()) {
  const key = cfg.clientEmail + cfg.tokenUrl;
  if (cached.key === key && cached.expMs - 60_000 > nowMs) return cached.token;

  const iat = Math.floor(nowMs / 1000);
  const claims = { iss: cfg.clientEmail, scope: SCOPE, aud: cfg.tokenUrl, iat, exp: iat + 3600 };
  const unsigned = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(cfg.privateKey).toString('base64url');
  } catch {
    throw new ConfigError('GOOGLE_PRIVATE_KEY không hợp lệ (phải là private_key trong file JSON của service account).');
  }

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new GoogleError(`Google không cấp token (HTTP ${res.status}): ${body.error ?? ''} ${body.error_description ?? ''}`.trim().slice(0, 250));
  }
  cached = { key, token: body.access_token, expMs: nowMs + (Number(body.expires_in) || 3600) * 1000 };
  return cached.token;
}

export async function fetchSheetValues(cfg, tab = cfg.tab) {
  const token = await accessToken(cfg);
  const range = `'${tab.replace(/'/g, "''")}'!A:Z`;
  const url = `${cfg.sheetsBase}/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (res.ok) return (await res.json()).values ?? [];

  const err = (await res.json().catch(() => ({}))).error?.message ?? '';
  if (res.status === 401) cached = { key: '', token: '', expMs: 0 };
  const hint = {
    403: `Google từ chối (403). Kiểm tra: đã share Sheet cho ${cfg.clientEmail} (quyền Viewer) và đã bật Google Sheets API chưa.`,
    404: 'Không thấy Sheet (SHEET_ID sai?).',
    400: `Không đọc được tab "${tab}" (tên tab sai hoặc chưa tạo?).`,
    429: 'Vượt hạn mức đọc của Google Sheets API, sẽ tự thử lại.',
  }[res.status] ?? `Lỗi HTTP ${res.status} từ Google Sheets.`;
  throw new GoogleError(`${hint} ${err}`.trim().slice(0, 300), res.status);
}
