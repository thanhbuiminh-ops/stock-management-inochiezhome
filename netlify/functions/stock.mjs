import { requireUser } from '../../lib/auth.mjs';
import { getData } from '../../lib/refresh.mjs';
import { json } from '../../lib/http.mjs';
import { withPlanView } from '../../lib/plan.mjs';
import { getForecast } from '../../lib/forecast.mjs';

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const user = await requireUser(req);
  if (!user) return json(401, { error: 'unauthorized' });
  return json(200, { ...withPlanView(await getData({ force: false }), await getForecast()), user: user.email });
};

export const config = { path: '/api/stock' };
