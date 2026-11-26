// src/auth.js
//
// Lightweight PIN-based auth for Cloudflare Workers + D1.
//
// Flow:
//  - First login: staff picks themselves from a list, sets a 4-6 digit PIN
//    (pin_set goes 0 -> 1, pin_hash stored as SHA-256 hex).
//  - Subsequent logins: staff picks themselves, enters PIN, server checks
//    hash match.
//  - On success, a session token (random UUID) is created in `sessions`
//    with a 30-day expiry and returned to the client as an HttpOnly cookie.
//  - Every API request (except /api/auth/*) requires a valid session
//    cookie; the resolved staff record (id, name, department_id, role)
//    is attached to the request context.

const SESSION_DAYS = 7;
const SESSION_COOKIE = 'roc_session';
const PBKDF2_ITERATIONS = 310000;

export async function sha256Hex(input) {
  const enc = new TextEncoder().encode(String(input));
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin, saltHex = null) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { salt: hex(salt), hash: hex(bits) };
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isValidPin(pin) {
  return typeof pin === 'string' && /^\\d{6}$/.test(pin);
}
\nexport function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export function setSessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function createSession(db, staffId) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.prepare(
    'INSERT INTO sessions (token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, staffId, now.toISOString(), expires.toISOString()).run();
  return token;
}

export async function destroySession(db, token) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256Hex(token)).run();
}

/**
 * Resolves the current session to a staff record, or null if no/invalid
 * session. Also opportunistically prunes expired sessions on a hit.
 */
export async function getCurrentStaff(request, db) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare(
    `SELECT s.id, s.name, s.department_id, s.role, sess.expires_at
     FROM sessions sess
     JOIN staff s ON s.id = sess.staff_id
     WHERE sess.token = ? AND s.active = 1`
  ).bind(await sha256Hex(token)).first();

  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await destroySession(db, token);
    return null;
  }

  return { id: row.id, name: row.name, department_id: row.department_id, role: row.role };
}

export { SESSION_COOKIE };
