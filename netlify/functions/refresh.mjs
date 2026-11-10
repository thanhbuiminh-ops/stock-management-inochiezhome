import { requireUser } from '../../lib/auth.mjs';
import { getData } from '../../lib/refresh.mjs';
import { json } from '../../lib/http.mjs';
import { withPlanView } from '../../lib/plan.mjs';
import { getForecast } from '../../lib/forecast.mjs';

// Nút "Làm mới" trên dashboard: ép đọc lại Sheet (có cooldown 15 giây để không bị bấm dồn).
export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) return json(403, { error: 'bad_origin' });
  const user = await requireUser(req);
  if (!user) return json(401, { error: 'unauthorized' });
  return json(200, { ...withPlanView(await getData({ force: true }), await getForecast()), user: user.email });
};

export const config = { path: '/api/refresh' };
