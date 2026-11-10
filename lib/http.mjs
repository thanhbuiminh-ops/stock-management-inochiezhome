export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...extraHeaders },
  });
}

export function isSecureRequest(req) {
  const host = new URL(req.url).hostname;
  return !(host === 'localhost' || host === '127.0.0.1');
}
