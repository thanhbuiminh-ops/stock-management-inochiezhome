import { createHash } from 'node:crypto';
import { getEnv, parseUsers } from '../../lib/env.mjs';
import { verifyPassword, dummyVerify } from '../../lib/password.mjs';
import { signSession, sessionCookie } from '../../lib/session.mjs';
import { stockStore } from '../../lib/store.mjs';
import { json, isSecureRequest } from '../../lib/http.mjs';

const MAX_FAILS = 5;
const LOCK_SEC = 15 * 60;
const failKey = (email) => 'fail/' + createHash('sha256').update(email).digest('hex').slice(0, 32);

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const secret = getEnv('SESSION_SECRET');
  if (!secret || secret.length < 32) return json(500, { error: 'server_misconfigured' });

  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) return json(403, { error: 'bad_origin' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
  const email = String(body?.email ?? '').trim().toLowerCase().slice(0, 200);
  const password = String(body?.password ?? '').slice(0, 200);
  if (!email || !password) return json(400, { error: 'bad_request' });

  const users = parseUsers(getEnv('USERS_JSON'));
  const stored = users.get(email);
  const store = stockStore();
  const now = Math.floor(Date.now() / 1000);

  // Chỉ lưu bộ đếm cho email có trong danh sách -> không phình storage khi bị dò email
  let rec = null;
  if (stored) {
    rec = await store.get(failKey(email), { type: 'json' });
    if (rec?.until > now) return json(429, { error: 'locked', retryAfterSec: rec.until - now });
  }

  const ok = stored ? await verifyPassword(password, stored) : (await dummyVerify(password), false);
  if (!ok) {
    if (stored) {
      const count = (rec?.count ?? 0) + 1;
      await store.setJSON(failKey(email), count >= MAX_FAILS ? { count: 0, until: now + LOCK_SEC } : { count, until: 0 });
    }
    return json(401, { error: 'invalid_credentials' });
  }

  if (rec) await store.delete(failKey(email));
  const token = await signSession(email, secret);
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure: isSecureRequest(req) }) });
};

export const config = { path: '/api/login' };
