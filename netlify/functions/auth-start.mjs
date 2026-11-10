import { getEnv } from '../../lib/env.mjs';
import { signData } from '../../lib/session.mjs';
import { oauthConfig, OAuthError, authorizeUrl, randomToken, safeNext, STATE_COOKIE } from '../../lib/oauth.mjs';
import { isSecureRequest } from '../../lib/http.mjs';

// Bước 1: chuyển người dùng sang Google. state ngẫu nhiên được ghi vào cookie ký (10 phút) để callback đối chiếu.
export default async (req) => {
  const url = new URL(req.url);
  const secret = getEnv('SESSION_SECRET');
  if (!secret || secret.length < 32) return Response.redirect(url.origin + '/login.html?error=server_misconfigured', 302);
  let cfg;
  try { cfg = oauthConfig(req); } catch (e) {
    if (e instanceof OAuthError) return Response.redirect(url.origin + '/login.html?error=' + e.code, 302);
    throw e;
  }
  const state = randomToken();
  const next = safeNext(url.searchParams.get('next'));
  const cookie = await signData({ s: state, n: next }, secret, 600);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl(cfg, state),
      'Cache-Control': 'no-store',
      // Lax: trình duyệt vẫn gửi cookie khi Google chuyển hướng (điều hướng cấp cao) quay lại
      'Set-Cookie': `${STATE_COOKIE}=${cookie}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${isSecureRequest(req) ? '; Secure' : ''}`,
    },
  });
};

export const config = { path: '/api/auth/start' };
