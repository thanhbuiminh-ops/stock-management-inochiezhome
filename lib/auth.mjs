import { getEnv, allowedEmails } from './env.mjs';
import { verifySession, readCookie, COOKIE_NAME } from './session.mjs';

// Dùng trong Function (lớp bảo vệ thứ hai, sau Edge gate). Trả { email } hoặc null.
export async function requireUser(req) {
  const sess = await verifySession(readCookie(req.headers.get('cookie'), COOKIE_NAME), getEnv('SESSION_SECRET'));
  if (!sess || !allowedEmails(getEnv('ALLOWED_EMAILS')).has(sess.email)) return null;
  return { email: sess.email };
}
