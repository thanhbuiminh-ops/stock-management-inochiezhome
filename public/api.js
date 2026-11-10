export async function postForecast(body) {
  const res = await fetch('/api/forecast', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body),
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Phiên đăng nhập đã hết hạn'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.message || 'HTTP ' + res.status); e.status = res.status; throw e; }
  return j;
}
