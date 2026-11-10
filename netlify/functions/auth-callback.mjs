import { getEnv, allowedEmails } from '../../lib/env.mjs';
import { signSession, sessionCookie, verifyData, readCookie } from '../../lib/session.mjs';
import { oauthConfig, OAuthError, emailFromCode, safeNext, STATE_COOKIE } from '../../lib/oauth.mjs';
import { isSecureRequest } from '../../lib/http.mjs';

// Bước 2: Google chuyển về đây kèm ?code&state. Kiểm state -> đổi code lấy email đã xác minh -> so với ALLOWED_EMAILS -> cấp cookie phiên.
export default async (req, deps = {}) => {
  const url = new URL(req.url);
  const secure = isSecureRequest(req);
  const clearState = `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  const fail = (code) => {
    const h = new Headers({ Location: `${url.origin}/login.html?error=${code}`, 'Cache-Control': 'no-store' });
    h.append('Set-Cookie', clearState);
    return new Response(null, { status: 302, headers: h });
  };

  const secret = getEnv('SESSION_SECRET');
  if (!secret || secret.length < 32) return fail('server_misconfigured');
  if (url.searchParams.get('error')) return fail('cancelled'); // người dùng bấm Huỷ ở Google

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = await verifyData(readCookie(req.headers.get('cookie'), STATE_COOKIE), secret);
  if (!code || !state || !saved || saved.s !== state) return fail('bad_state');

  let email;
  try {
    email = await emailFromCode(oauthConfig(req), code, deps.fetch ?? fetch);
  } catch (e) {
    if (e instanceof OAuthError) return fail(e.code);
    throw e;
  }
  if (!allowedEmails(getEnv('ALLOWED_EMAILS')).has(email)) return fail('not_allowed');

  const h = new Headers({ Location: url.origin + safeNext(saved.n), 'Cache-Control': 'no-store' });
  h.append('Set-Cookie', sessionCookie(await signSession(email, secret), { secure }));
  h.append('Set-Cookie', clearState);
  return new Response(null, { status: 302, headers: h });
};

export const config = { path: '/api/auth/callback' };
