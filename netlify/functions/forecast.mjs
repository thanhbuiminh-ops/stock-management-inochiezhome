import { requireUser } from '../../lib/auth.mjs';
import { applyOp, ForecastError } from '../../lib/forecast.mjs';
import { json } from '../../lib/http.mjs';

const MAX_BODY = 1_000_000;

// Ghi Forecast: thêm / sửa / xoá dòng. Đọc Forecast đi kèm /api/stock nên không có GET riêng.
export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) return json(403, { error: 'bad_origin' });
  const user = await requireUser(req);
  if (!user) return json(401, { error: 'unauthorized' });

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'too_large', message: 'Dữ liệu quá lớn' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'bad_json', message: 'Dữ liệu không đọc được' }); }

  try {
    return json(200, { ok: true, ...(await applyOp(body, user.email)) });
  } catch (e) {
    if (e instanceof ForecastError) return json(e.status, { error: 'forecast_error', message: e.message });
    throw e;
  }
};

export const config = { path: '/api/forecast' };
