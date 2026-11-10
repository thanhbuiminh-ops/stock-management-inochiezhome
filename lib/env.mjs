// Đọc biến môi trường ở cả Edge Function (Deno: Netlify.env) lẫn Function (Node: process.env).
export function getEnv(name) {
  try {
    const v = globalThis.Netlify?.env?.get?.(name);
    if (v !== undefined && v !== null && v !== '') return v;
  } catch { /* ignore */ }
  return globalThis.process?.env?.[name] || undefined;
}

// USERS_JSON: {"email": "scrypt$..."} -> Map(email_lowercase -> hash)
export function parseUsers(raw) {
  const map = new Map();
  try {
    const obj = JSON.parse(raw || '{}');
    for (const [email, hash] of Object.entries(obj)) {
      if (typeof hash === 'string') map.set(email.trim().toLowerCase(), hash);
    }
  } catch { /* JSON hỏng -> không ai được vào (fail closed) */ }
  return map;
}

export function allowedEmails(raw) {
  return new Set(parseUsers(raw).keys());
}
