import { clearCookie } from '../../lib/session.mjs';
import { json, isSecureRequest } from '../../lib/http.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  return json(200, { ok: true }, { 'Set-Cookie': clearCookie({ secure: isSecureRequest(req) }) });
};

export const config = { path: '/api/logout' };
