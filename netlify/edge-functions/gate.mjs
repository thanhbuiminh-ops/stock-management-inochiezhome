import { verifySession, readCookie, COOKIE_NAME } from '../../lib/session.mjs';
import { getEnv, allowedEmails } from '../../lib/env.mjs';

// Cổng chặn toàn site: chỉ cho qua khi cookie phiên hợp lệ VÀ email còn nằm trong ALLOWED_EMAILS.
// Xoá email khỏi ALLOWED_EMAILS (rồi deploy lại) là thu hồi quyền ngay, không cần đợi cookie hết hạn.
export default async (request, context) => {
  const url = new URL(request.url);
  const secret = getEnv('SESSION_SECRET');
  if (!secret) return new Response('Server chưa cấu hình SESSION_SECRET', { status: 500 }); // fail closed

  const sess = await verifySession(readCookie(request.headers.get('cookie'), COOKIE_NAME), secret);
  if (sess && allowedEmails(getEnv('ALLOWED_EMAILS')).has(sess.email)) {
    const res = await context.next();
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }
  const next = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { Location: `/login.html?next=${next}`, 'Cache-Control': 'no-store' } });
};

// Các file của trang đăng nhập phải mở được khi chưa login.
export const config = {
  path: '/*',
  excludedPath: ['/api/auth/start', '/api/auth/callback', '/login.html', '/login.js', '/style.css', '/favicon.svg', '/fonts/*'],
};
