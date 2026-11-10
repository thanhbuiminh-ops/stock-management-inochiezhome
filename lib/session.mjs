// Cookie phiên ký HMAC-SHA256 bằng Web Crypto -> dùng được cả Node 20+ và Netlify Edge (Deno).
const enc = new TextEncoder();
const dec = new TextDecoder();

export const COOKIE_NAME = 'bm_session';
export const SESSION_TTL_SEC = 12 * 60 * 60;

function b64uEncode(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signSession(email, secret, ttlSec = SESSION_TTL_SEC, nowMs = Date.now()) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET phải dài >= 32 ký tự');
  const payload = b64uEncode(enc.encode(JSON.stringify({ e: email, exp: Math.floor(nowMs / 1000) + ttlSec })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64uEncode(sig)}`;
}

export async function verifySession(token, secret, nowMs = Date.now()) {
  if (!token || !secret || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uDecode(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(b64uDecode(parts[0])));
    if (typeof p.e !== 'string' || typeof p.exp !== 'number' || p.exp * 1000 <= nowMs) return null;
    return { email: p.e.toLowerCase(), exp: p.exp };
  } catch {
    return null;
  }
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token, { secure = true, maxAge = SESSION_TTL_SEC } = {}) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function clearCookie({ secure = true } = {}) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// Dữ liệu tuỳ ý (không phải email) có ký + hạn dùng: dùng cho cookie "state" của đăng nhập Google.
export async function signData(obj, secret, ttlSec, nowMs = Date.now()) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET phải dài >= 32 ký tự');
  const payload = b64uEncode(enc.encode(JSON.stringify({ d: obj, exp: Math.floor(nowMs / 1000) + ttlSec })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode('data.' + payload));
  return `${payload}.${b64uEncode(sig)}`;
}
export async function verifyData(token, secret, nowMs = Date.now()) {
  if (!token || !secret || secret.length < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uDecode(parts[1]), enc.encode('data.' + parts[0]));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(b64uDecode(parts[0])));
    return typeof p.exp === 'number' && p.exp * 1000 > nowMs ? p.d : null;
  } catch { return null; }
}
