// Đọc biến môi trường ở cả Edge Function (Deno: Netlify.env) lẫn Function (Node: process.env).
export function getEnv(name) {
  try {
    const v = globalThis.Netlify?.env?.get?.(name);
    if (v !== undefined && v !== null && v !== '') return v;
  } catch { /* ignore */ }
  return globalThis.process?.env?.[name] || undefined;
}

// ALLOWED_EMAILS: "a@gmail.com, b@congty.vn" (ngăn cách bằng dấu phẩy / chấm phẩy / khoảng trắng / xuống dòng) -> Set chữ thường
export function allowedEmails(raw) {
  return new Set(String(raw ?? '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')));
}
