// Đăng nhập bằng Google (OAuth 2.0 authorization-code). Chỉ dùng để biết "email nào đã được Google xác minh";
// quyền vào web do danh sách ALLOWED_EMAILS quyết định, rồi cấp cookie phiên như cũ.
import { getEnv } from './env.mjs';

export const STATE_COOKIE = 'bm_oauth';
const STATE_TTL_SEC = 600;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class OAuthError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

export function oauthConfig(req, env = getEnv) {
  const clientId = env('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new OAuthError('server_misconfigured', 'Thiếu GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET');
  return {
    clientId, clientSecret,
    redirectUri: new URL(req.url).origin + '/api/auth/callback',
    authUrl: env('GOOGLE_OAUTH_AUTH_URL') || AUTH_URL,       // chỉ để test
    tokenUrl: env('GOOGLE_OAUTH_TOKEN_URL') || TOKEN_URL,    // chỉ để test
  };
}

// Chỉ cho quay về đường dẫn nội bộ (chống open redirect)
export function safeNext(next) {
  const n = String(next ?? '');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') && !n.startsWith('/login') && !n.startsWith('/api/auth') ? n.slice(0, 500) : '/';
}

export const randomToken = (bytes = 24) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function authorizeUrl(cfg, state) {
  const u = new URL(cfg.authUrl);
  u.search = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
    scope: 'openid email', state, prompt: 'select_account', access_type: 'online',
  }).toString();
  return u.toString();
}

const b64uJson = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))));

// Đổi code lấy id_token trực tiếp từ Google qua HTTPS (server-to-server) nên có thể tin nội dung; vẫn kiểm aud/iss/exp/email_verified.
export async function emailFromCode(cfg, code, fetchFn = fetch, nowMs = Date.now()) {
  let res;
  try {
    res = await fetchFn(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
      }).toString(),
    });
  } catch { throw new OAuthError('google_unreachable'); }
  if (!res.ok) throw new OAuthError('google_rejected', `Google trả ${res.status}`);
  const body = await res.json().catch(() => ({}));
  let claims;
  try { claims = b64uJson(String(body.id_token).split('.')[1]); } catch { throw new OAuthError('google_bad_token'); }
  if (claims.aud !== cfg.clientId) throw new OAuthError('google_bad_token', 'aud không khớp');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw new OAuthError('google_bad_token', 'iss không hợp lệ');
  if (!(claims.exp * 1000 > nowMs)) throw new OAuthError('google_bad_token', 'token hết hạn');
  if (claims.email_verified !== true || typeof claims.email !== 'string') throw new OAuthError('email_unverified');
  return claims.email.trim().toLowerCase();
}
